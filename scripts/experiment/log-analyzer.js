const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { logSection } = require('./utils')

const STREAMING_THRESHOLD = 100 * 1024 * 1024

function extractBefaasPayload (line) {
  if (line.length > 0 && line.charCodeAt(0) === 0x7b /* '{' */) {
    try {
      const env = JSON.parse(line)
      if (env && typeof env.message === 'string') {
        const m = env.message.match(/BEFAAS(\{[\s\S]*\})\s*$/)
        if (m) return m[1]
      }
    } catch (e) {
      // Not a valid envelope, fall through to raw match.
    }
  }
  const m = line.match(/BEFAAS(\{.*\})\s*$/)
  return m ? m[1] : null
}

async function parseArtilleryLogStreaming (logPath) {
  return new Promise((resolve, reject) => {
    const entries = []
    const readStream = fs.createReadStream(logPath, { encoding: 'utf8' })
    const rl = readline.createInterface({
      input: readStream,
      crlfDelay: Infinity
    })

    rl.on('line', (line) => {
      const payload = extractBefaasPayload(line)
      if (!payload) return
      try {
        entries.push(JSON.parse(payload))
      } catch (e) {
        // Skip malformed entries
      }
    })

    rl.on('close', () => resolve(entries))
    rl.on('error', reject)
    readStream.on('error', reject)
  })
}

function parseArtilleryLogInMemory (logPath) {
  const content = fs.readFileSync(logPath, 'utf8')
  const lines = content.split('\n')
  const entries = []

  for (const line of lines) {
    const payload = extractBefaasPayload(line)
    if (!payload) continue
    try {
      entries.push(JSON.parse(payload))
    } catch (e) {
      // Skip malformed entries
    }
  }

  return entries
}

async function parseArtilleryLog (logPath) {
  if (!fs.existsSync(logPath)) {
    console.log(`Artillery log not found: ${logPath}`)
    return []
  }

  const stat = fs.statSync(logPath)
  if (stat.size > STREAMING_THRESHOLD) {
    console.log(`  Using streaming parser for large file (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
    return parseArtilleryLogStreaming(logPath)
  }
  return parseArtilleryLogInMemory(logPath)
}

function analyzeAuthMetrics (entries) {
  const authRequests = {
    total: 0,
    success: 0,
    failure: 0,
    by_endpoint: {},
    by_status_code: {},
    by_phase: {},
    response_times: []
  }

  const anonymousRequests = {
    total: 0,
    success: 0,
    failure: 0,
    by_endpoint: {},
    by_status_code: {}
  }

  // Track timeout and error events
  const timeoutMetrics = {
    total: 0,
    by_endpoint: {},
    by_phase: {},
    by_auth_type: {},
    by_error_code: {},
    durations: []
  }

  // Track request pairs for response time calculation
  const requestPairs = new Map()

  for (const entry of entries) {
    if (!entry.event) continue

    const { url, type, authType, statusCode, xPair, errorCode, errorMessage, durationMs } = entry.event
    const phase = entry.phase?.name || 'unknown'

    // Extract endpoint from URL
    let endpoint = 'unknown'
    if (url) {
      try {
        endpoint = new URL(url).pathname
      } catch (e) {
        endpoint = url.startsWith('/') ? url.split('?')[0] : '/' + url.split('?')[0]
      }
    }

    if (type === 'before' && xPair) {
      // Store start time for response time calculation
      requestPairs.set(xPair, {
        timestamp: entry.timestamp,
        now: entry.now,
        authType,
        endpoint
      })
    }

    // Handle timeout and error events
    if (type === 'timeout' || type === 'connection_error' || type === 'error') {
      timeoutMetrics.total++

      // Track by endpoint
      if (!timeoutMetrics.by_endpoint[endpoint]) {
        timeoutMetrics.by_endpoint[endpoint] = { total: 0, timeout: 0, connection_error: 0, other: 0 }
      }
      timeoutMetrics.by_endpoint[endpoint].total++
      if (type === 'timeout') {
        timeoutMetrics.by_endpoint[endpoint].timeout++
      } else if (type === 'connection_error') {
        timeoutMetrics.by_endpoint[endpoint].connection_error++
      } else {
        timeoutMetrics.by_endpoint[endpoint].other++
      }

      // Track by phase
      if (!timeoutMetrics.by_phase[phase]) {
        timeoutMetrics.by_phase[phase] = { total: 0, timeout: 0, connection_error: 0, other: 0 }
      }
      timeoutMetrics.by_phase[phase].total++
      if (type === 'timeout') {
        timeoutMetrics.by_phase[phase].timeout++
      } else if (type === 'connection_error') {
        timeoutMetrics.by_phase[phase].connection_error++
      } else {
        timeoutMetrics.by_phase[phase].other++
      }

      // Track by auth type
      const authKey = authType || 'unknown'
      if (!timeoutMetrics.by_auth_type[authKey]) {
        timeoutMetrics.by_auth_type[authKey] = 0
      }
      timeoutMetrics.by_auth_type[authKey]++

      // Track by error code
      const errCode = errorCode || 'UNKNOWN'
      if (!timeoutMetrics.by_error_code[errCode]) {
        timeoutMetrics.by_error_code[errCode] = 0
      }
      timeoutMetrics.by_error_code[errCode]++

      // Track duration if available
      if (durationMs) {
        timeoutMetrics.durations.push({
          endpoint,
          phase,
          authType: authKey,
          errorType: type,
          errorCode: errCode,
          durationMs
        })
      }

      // Clean up pending request if exists
      if (xPair && requestPairs.has(xPair)) {
        requestPairs.delete(xPair)
      }

      continue // Don't process as regular after event
    }

    if (type === 'after') {
      const isAuth = authType === 'auth'
      const target = isAuth ? authRequests : anonymousRequests

      target.total++

      // Track by endpoint
      if (!target.by_endpoint[endpoint]) {
        target.by_endpoint[endpoint] = { total: 0, success: 0, failure: 0, status_codes: {} }
      }
      target.by_endpoint[endpoint].total++

      // Track by status code
      const statusKey = String(statusCode || 'unknown')
      target.by_status_code[statusKey] = (target.by_status_code[statusKey] || 0) + 1
      target.by_endpoint[endpoint].status_codes[statusKey] =
        (target.by_endpoint[endpoint].status_codes[statusKey] || 0) + 1

      // Determine success/failure
      const isSuccess = statusCode >= 200 && statusCode < 400
      if (isSuccess) {
        target.success++
        target.by_endpoint[endpoint].success++
      } else {
        target.failure++
        target.by_endpoint[endpoint].failure++
      }

      // Track by phase
      if (isAuth) {
        if (!authRequests.by_phase[phase]) {
          authRequests.by_phase[phase] = { total: 0, success: 0, failure: 0 }
        }
        authRequests.by_phase[phase].total++
        if (isSuccess) {
          authRequests.by_phase[phase].success++
        } else {
          authRequests.by_phase[phase].failure++
        }
      }

      // Calculate response time if we have the before entry
      if (xPair && requestPairs.has(xPair)) {
        const beforeEntry = requestPairs.get(xPair)
        const responseTime = entry.timestamp - beforeEntry.timestamp
        if (responseTime > 0 && responseTime < 60000) {
          if (isAuth) {
            authRequests.response_times.push({
              endpoint,
              responseTime,
              statusCode,
              phase
            })
          }
        }
        requestPairs.delete(xPair)
      }

      // Check for token capture
      if (isAuth && entry.event.tokenCaptured !== undefined) {
        if (!target.by_endpoint[endpoint].token_stats) {
          target.by_endpoint[endpoint].token_stats = { captured: 0, not_captured: 0 }
        }
        if (entry.event.tokenCaptured) {
          target.by_endpoint[endpoint].token_stats.captured++
        } else {
          target.by_endpoint[endpoint].token_stats.not_captured++
        }
      }
    }
  }

  // Calculate response time statistics for auth requests
  const authResponseTimeStats = calculateResponseTimeStats(authRequests.response_times)

  // Calculate timeout duration statistics
  const timeoutDurationStats = timeoutMetrics.durations.length > 0
    ? calculateTimeoutDurationStats(timeoutMetrics.durations)
    : null

  return {
    auth: {
      total_requests: authRequests.total,
      successful: authRequests.success,
      failed: authRequests.failure,
      success_rate_percent: authRequests.total > 0
        ? ((authRequests.success / authRequests.total) * 100).toFixed(2)
        : 0,
      by_endpoint: authRequests.by_endpoint,
      by_status_code: authRequests.by_status_code,
      by_phase: authRequests.by_phase,
      response_times: authResponseTimeStats
    },
    anonymous: {
      total_requests: anonymousRequests.total,
      successful: anonymousRequests.success,
      failed: anonymousRequests.failure,
      success_rate_percent: anonymousRequests.total > 0
        ? ((anonymousRequests.success / anonymousRequests.total) * 100).toFixed(2)
        : 0,
      by_endpoint: anonymousRequests.by_endpoint,
      by_status_code: anonymousRequests.by_status_code
    },
    timeouts: {
      total: timeoutMetrics.total,
      by_endpoint: timeoutMetrics.by_endpoint,
      by_phase: timeoutMetrics.by_phase,
      by_auth_type: timeoutMetrics.by_auth_type,
      by_error_code: timeoutMetrics.by_error_code,
      duration_stats: timeoutDurationStats
    }
  }
}

function calculateTimeoutDurationStats (durations) {
  if (durations.length === 0) {
    return null
  }

  const times = durations.map(d => d.durationMs).sort((a, b) => a - b)
  const sum = times.reduce((a, b) => a + b, 0)

  return {
    count: times.length,
    mean_ms: parseFloat((sum / times.length).toFixed(2)),
    min_ms: times[0],
    max_ms: times[times.length - 1],
    median_ms: times[Math.floor(times.length / 2)],
    p95_ms: times[Math.floor(times.length * 0.95)],
    p99_ms: times[Math.floor(times.length * 0.99)]
  }
}

function calculateResponseTimeStats (responseTimes) {
  if (responseTimes.length === 0) {
    return null
  }

  const times = responseTimes.map(r => r.responseTime).sort((a, b) => a - b)
  const sum = times.reduce((a, b) => a + b, 0)

  return {
    count: times.length,
    mean_ms: (sum / times.length).toFixed(2),
    min_ms: times[0],
    max_ms: times[times.length - 1],
    median_ms: times[Math.floor(times.length / 2)],
    p75_ms: times[Math.floor(times.length * 0.75)],
    p90_ms: times[Math.floor(times.length * 0.90)],
    p95_ms: times[Math.floor(times.length * 0.95)],
    p99_ms: times[Math.floor(times.length * 0.99)]
  }
}

function parseReportLine (line) {
  let message = line
  try {
    const jsonLine = JSON.parse(line)
    if (jsonLine.message) {
      message = jsonLine.message
    }
  } catch (e) {
    // Not JSON, use line as-is
  }

  const reportMatch = message.match(/REPORT RequestId: ([^\s]+)\s+Duration: ([\d.]+) ms\s+Billed Duration: (\d+) ms\s+Memory Size: (\d+) MB\s+Max Memory Used: (\d+) MB(?:\s+Init Duration: ([\d.]+) ms)?/)
  if (reportMatch) {
    return {
      requestId: reportMatch[1],
      duration: parseFloat(reportMatch[2]),
      billedDuration: parseInt(reportMatch[3]),
      memorySize: parseInt(reportMatch[4]),
      maxMemoryUsed: parseInt(reportMatch[5]),
      initDuration: reportMatch[6] ? parseFloat(reportMatch[6]) : null,
      isColdStart: !!reportMatch[6]
    }
  }
  return null
}

async function parseLambdaReportsStreaming (logPath) {
  return new Promise((resolve, reject) => {
    const reports = []
    const readStream = fs.createReadStream(logPath, { encoding: 'utf8' })
    const rl = readline.createInterface({
      input: readStream,
      crlfDelay: Infinity
    })

    rl.on('line', (line) => {
      const report = parseReportLine(line)
      if (report) {
        reports.push(report)
      }
    })

    rl.on('close', () => resolve(reports))
    rl.on('error', reject)
    readStream.on('error', reject)
  })
}

function parseLambdaReportsInMemory (logPath) {
  const content = fs.readFileSync(logPath, 'utf8')
  const lines = content.split('\n')
  const reports = []

  for (const line of lines) {
    const report = parseReportLine(line)
    if (report) {
      reports.push(report)
    }
  }

  return reports
}

async function parseLambdaReports (logPath) {
  if (!fs.existsSync(logPath)) {
    console.log(`Lambda log not found: ${logPath}`)
    return []
  }

  const stat = fs.statSync(logPath)
  if (stat.size > STREAMING_THRESHOLD) {
    console.log(`  Using streaming parser for large file (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
    return parseLambdaReportsStreaming(logPath)
  }
  return parseLambdaReportsInMemory(logPath)
}

function arrayMin (arr) {
  let min = Infinity
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i]
  }
  return min
}

function arrayMax (arr) {
  let max = -Infinity
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > max) max = arr[i]
  }
  return max
}

function analyzeLambdaMetrics (reports) {
  if (reports.length === 0) {
    return {
      cold_starts: { total: 0, percentage: 0 },
      memory: { configured_mb: 0, avg_used_mb: 0, max_used_mb: 0, efficiency_percent: 0 },
      invocations: { total: 0 }
    }
  }

  const coldStarts = reports.filter(r => r.isColdStart)
  const initDurations = coldStarts.map(r => r.initDuration).filter(d => d !== null)
  const memoryUsed = reports.map(r => r.maxMemoryUsed)
  const durations = reports.map(r => r.duration)
  const billedDurations = reports.map(r => r.billedDuration)
  const memorySize = reports[0]?.memorySize || 0

  // Calculate cold start statistics
  const coldStartStats = initDurations.length > 0
    ? {
        count: initDurations.length,
        percentage: ((initDurations.length / reports.length) * 100).toFixed(2),
        avg_ms: (initDurations.reduce((a, b) => a + b, 0) / initDurations.length).toFixed(2),
        min_ms: arrayMin(initDurations).toFixed(2),
        max_ms: arrayMax(initDurations).toFixed(2),
        total_init_time_ms: initDurations.reduce((a, b) => a + b, 0).toFixed(2)
      }
    : {
        count: 0,
        percentage: '0.00',
        avg_ms: '0.00',
        min_ms: '0.00',
        max_ms: '0.00',
        total_init_time_ms: '0.00'
      }

  // Calculate memory statistics
  const avgMemory = memoryUsed.reduce((a, b) => a + b, 0) / memoryUsed.length
  const maxMemory = arrayMax(memoryUsed)
  const memoryEfficiency = memorySize > 0 ? (avgMemory / memorySize) * 100 : 0

  // Calculate duration statistics
  const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length
  const sortedDurations = [...durations].sort((a, b) => a - b)

  // Calculate billed vs actual duration overhead
  const totalDuration = durations.reduce((a, b) => a + b, 0)
  const totalBilled = billedDurations.reduce((a, b) => a + b, 0)
  const billingOverhead = totalDuration > 0 ? ((totalBilled - totalDuration) / totalDuration) * 100 : 0

  return {
    cold_starts: {
      total: coldStartStats.count,
      percentage: parseFloat(coldStartStats.percentage),
      avg_duration_ms: parseFloat(coldStartStats.avg_ms),
      min_duration_ms: parseFloat(coldStartStats.min_ms),
      max_duration_ms: parseFloat(coldStartStats.max_ms),
      total_init_time_ms: parseFloat(coldStartStats.total_init_time_ms),
      impact_on_billed_duration_ms: parseFloat(coldStartStats.total_init_time_ms)
    },
    memory: {
      configured_mb: memorySize,
      avg_used_mb: parseFloat(avgMemory.toFixed(2)),
      max_used_mb: maxMemory,
      min_used_mb: arrayMin(memoryUsed),
      efficiency_percent: parseFloat(memoryEfficiency.toFixed(2)),
      headroom_mb: memorySize - maxMemory,
      recommendation: generateMemoryRecommendation(maxMemory, memorySize)
    },
    duration: {
      avg_ms: parseFloat(avgDuration.toFixed(2)),
      min_ms: parseFloat(arrayMin(durations).toFixed(2)),
      max_ms: parseFloat(arrayMax(durations).toFixed(2)),
      median_ms: parseFloat(sortedDurations[Math.floor(sortedDurations.length / 2)].toFixed(2)),
      p95_ms: parseFloat(sortedDurations[Math.floor(sortedDurations.length * 0.95)].toFixed(2)),
      p99_ms: parseFloat(sortedDurations[Math.floor(sortedDurations.length * 0.99)].toFixed(2))
    },
    billing: {
      total_invocations: reports.length,
      total_duration_ms: parseFloat(totalDuration.toFixed(2)),
      total_billed_duration_ms: totalBilled,
      billing_overhead_percent: parseFloat(billingOverhead.toFixed(2))
    }
  }
}

function generateMemoryRecommendation (maxUsed, configured) {
  const utilizationPercent = (maxUsed / configured) * 100

  if (utilizationPercent < 50) {
    const tiers = [128, 256, 512, 1024, 1536, 2048, 3008, 4096, 5120, 6144, 7168, 8192, 9216, 10240]
    const recommendedTier = tiers.find(t => t >= maxUsed * 1.3) || tiers[0]
    if (recommendedTier < configured) {
      return {
        action: 'reduce',
        current_mb: configured,
        recommended_mb: recommendedTier,
        potential_savings_percent: parseFloat((((configured - recommendedTier) / configured) * 100).toFixed(1))
      }
    }
  } else if (utilizationPercent > 85) {
    return {
      action: 'increase',
      current_mb: configured,
      reason: 'Memory utilization above 85% - risk of OOM errors'
    }
  }

  return {
    action: 'keep',
    current_mb: configured,
    reason: 'Memory allocation is appropriate'
  }
}

async function analyzeExperimentLogs (outputDir) {
  logSection('Analyzing Logs for Auth & Performance Metrics')

  const logsDir = path.join(outputDir, 'logs')
  const analysisDir = path.join(outputDir, 'analysis')

  if (!fs.existsSync(logsDir)) {
    console.log('No logs directory found, skipping log analysis')
    return null
  }

  if (!fs.existsSync(analysisDir)) {
    fs.mkdirSync(analysisDir, { recursive: true })
  }

  const results = {
    meta: {
      analyzed_at: new Date().toISOString(),
      logs_directory: logsDir
    },
    auth_metrics: null,
    lambda_metrics: null
  }

  // Analyze artillery logs for auth metrics
  const artilleryLogPath = path.join(logsDir, 'artillery.log')
  if (fs.existsSync(artilleryLogPath)) {
    console.log('Analyzing artillery logs for auth metrics...')
    const artilleryEntries = await parseArtilleryLog(artilleryLogPath)
    console.log(`  Parsed ${artilleryEntries.length} BEFAAS entries`)

    if (artilleryEntries.length > 0) {
      results.auth_metrics = analyzeAuthMetrics(artilleryEntries)
      console.log(`  Auth requests: ${results.auth_metrics.auth.total_requests} (${results.auth_metrics.auth.success_rate_percent}% success)`)
      console.log(`  Anonymous requests: ${results.auth_metrics.anonymous.total_requests} (${results.auth_metrics.anonymous.success_rate_percent}% success)`)
      if (results.auth_metrics.timeouts.total > 0) {
        console.log(`  Timeouts/Errors: ${results.auth_metrics.timeouts.total}`)
      }
    }
  }

  // Analyze Lambda logs for cold starts and memory
  const lambdaLogPath = path.join(logsDir, 'aws.log')
  if (fs.existsSync(lambdaLogPath)) {
    console.log('Analyzing Lambda logs for cold starts and memory...')
    const lambdaReports = await parseLambdaReports(lambdaLogPath)
    console.log(`  Parsed ${lambdaReports.length} REPORT entries`)

    if (lambdaReports.length > 0) {
      results.lambda_metrics = analyzeLambdaMetrics(lambdaReports)
      console.log(`  Cold starts: ${results.lambda_metrics.cold_starts.total} (${results.lambda_metrics.cold_starts.percentage}%)`)
      console.log(`  Memory efficiency: ${results.lambda_metrics.memory.efficiency_percent}%`)
      console.log(`  Memory recommendation: ${results.lambda_metrics.memory.recommendation.action}`)
    }
  }

  // Save results
  const outputPath = path.join(analysisDir, 'log-analysis.json')
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2))
  console.log(`\n[OK] Log analysis saved to: ${outputPath}`)

  return results
}

module.exports = {
  analyzeExperimentLogs,
  parseArtilleryLog,
  analyzeAuthMetrics,
  parseLambdaReports,
  analyzeLambdaMetrics
}
