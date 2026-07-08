const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
  DeleteLogGroupCommand,
  PutRetentionPolicyCommand
} = require('@aws-sdk/client-cloudwatch-logs')
const { logSection } = require('./utils')

const EDGE_LOG_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-north-1',
  'ca-central-1'
]

function getLambdaFunctionNames (projectRoot) {
  const infraDir = path.join(projectRoot, 'infrastructure', 'aws')

  if (!fs.existsSync(path.join(infraDir, 'terraform.tfstate'))) {
    console.log('No Terraform state found for FaaS infrastructure')
    return []
  }

  try {
    const output = execSync('terraform output -json', {
      cwd: infraDir,
      encoding: 'utf8'
    })
    const outputs = JSON.parse(output)

    if (outputs.lambda_function_names && outputs.lambda_function_names.value) {
      return Object.values(outputs.lambda_function_names.value)
    }
  } catch (error) {
    console.log(`Could not get Lambda function names: ${error.message}`)
  }

  return []
}

function getRunId (projectRoot) {
  const expDir = path.join(projectRoot, 'infrastructure', 'experiment')

  try {
    const output = execSync('terraform output -json', {
      cwd: expDir,
      encoding: 'utf8'
    })
    const outputs = JSON.parse(output)
    return outputs.run_id?.value || null
  } catch (error) {
    return null
  }
}

function getEdgeLambdaFunctionName (projectRoot) {
  const edgeAuthDir = path.join(projectRoot, 'infrastructure', 'services', 'edge-auth')

  if (!fs.existsSync(path.join(edgeAuthDir, 'terraform.tfstate'))) {
    return null
  }

  try {
    const output = execSync('terraform output -json', {
      cwd: edgeAuthDir,
      encoding: 'utf8'
    })
    const outputs = JSON.parse(output)

    // Extract function name from ARN: arn:aws:lambda:us-east-1:123456789:function:befaas-edge-auth:1
    if (outputs.edge_lambda_arn && outputs.edge_lambda_arn.value) {
      const arn = outputs.edge_lambda_arn.value
      const match = arn.match(/:function:([^:]+)/)
      if (match) {
        return match[1]
      }
    }
  } catch (error) {
    console.log(`Could not get Edge Lambda function name: ${error.message}`)
  }

  return null
}

async function collectLambdaLogs (config, outputDir, startTime, endTime) {
  if (config.architecture !== 'faas') {
    return null
  }

  logSection('Collecting Lambda CloudWatch Logs')

  const projectRoot = path.join(__dirname, '..', '..')
  const awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'

  console.log(`AWS Region: ${awsRegion}`)
  console.log(`Time range: ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`)
  console.log(`Using server-side filter: BEFAAS and REPORT lines only`)

  // Get Lambda function names
  const functionNames = getLambdaFunctionNames(projectRoot)
  if (functionNames.length === 0) {
    console.log('No Lambda functions found, skipping log collection')
    return null
  }

  console.log(`Found ${functionNames.length} Lambda functions`)

  // Get run_id for log group naming
  const runId = getRunId(projectRoot)

  // Initialize CloudWatch Logs client
  const logsClient = new CloudWatchLogsClient({ region: awsRegion })

  // Determine log group prefixes to search
  const logPrefixes = []
  if (runId) {
    logPrefixes.push(`/aws/lambda/${runId}`)
  }
  // Also try function-based naming
  for (const fnName of functionNames) {
    logPrefixes.push(`/aws/lambda/${fnName}`)
  }

  // Find all matching log groups
  const logGroups = new Set()

  for (const prefix of logPrefixes) {
    try {
      const describeCommand = new DescribeLogGroupsCommand({
        logGroupNamePrefix: prefix
      })
      const response = await logsClient.send(describeCommand)

      for (const group of response.logGroups || []) {
        logGroups.add(group.logGroupName)
      }
    } catch (error) {
      console.log(`Could not search log groups with prefix ${prefix}: ${error.message}`)
    }
  }

  if (logGroups.size === 0) {
    console.log('No CloudWatch log groups found for Lambda functions')
    console.log('Searched prefixes:', logPrefixes.slice(0, 5).join(', '))
    return null
  }

  console.log(`Found ${logGroups.size} log groups`)

  // Prepare output
  const logsDir = path.join(outputDir, 'logs')
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }

  const awsLogFile = path.join(logsDir, 'aws.log')
  const logFileHandle = fs.openSync(awsLogFile, 'w')

  let totalEvents = 0
  let totalFunctions = 0
  let totalApiCalls = 0

  for (const logGroupName of logGroups) {
    console.log(`  Collecting from: ${logGroupName}`)

    try {
      let groupEvents = 0
      let nextToken = null

      // Extract function name from log group: /aws/lambda/{runId}_{fnName} or /aws/lambda/{fnName}
      const fnNameMatch = logGroupName.match(/\/aws\/lambda\/(?:[^_]+_)?(.+)$/)
      const fnName = fnNameMatch ? fnNameMatch[1] : 'unknown'

      do {
        const filterCommand = new FilterLogEventsCommand({
          logGroupName,
          startTime,
          endTime,
          filterPattern: '?BEFAAS ?"REPORT RequestId"',
          nextToken,
          limit: 10000 // Max allowed by API
        })

        const response = await logsClient.send(filterCommand)
        totalApiCalls++

        // Write matching events to file (already filtered server-side by filterPattern)
        for (const event of response.events || []) {
          const msg = event.message || ''

          const jsonLine = JSON.stringify({
            timestamp: event.timestamp,
            message: msg,
            ingestionTime: event.ingestionTime,
            logGroup: logGroupName,
            fnName: fnName
          }) + '\n'
          fs.writeSync(logFileHandle, jsonLine)
          groupEvents++
        }

        nextToken = response.nextToken

        // Progress indicator for large log groups
        if (groupEvents > 0 && groupEvents % 50000 === 0) {
          console.log(`    ... ${groupEvents} events collected`)
        }
      } while (nextToken)

      if (groupEvents > 0) {
        console.log(`    Collected ${groupEvents} events`)
        totalEvents += groupEvents
        totalFunctions++
      } else {
        console.log(`    No events found`)
      }
    } catch (groupError) {
      console.log(`    Error reading log group: ${groupError.message}`)
    }
  }

  fs.closeSync(logFileHandle)

  // Get file size for reporting
  const fileStats = fs.statSync(awsLogFile)
  const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2)

  console.log(`\n[OK] Lambda log collection complete`)
  console.log(`  Total events: ${totalEvents}`)
  console.log(`  Functions with logs: ${totalFunctions}`)
  console.log(`  API calls made: ${totalApiCalls}`)
  console.log(`  Output file: ${awsLogFile} (${fileSizeMB} MB)`)

  return {
    totalEvents,
    totalFunctions,
    totalApiCalls,
    fileSizeMB: parseFloat(fileSizeMB),
    logGroups: Array.from(logGroups),
    outputFile: awsLogFile
  }
}

async function collectEdgeLambdaLogs (functionName, outputDir, startTime, endTime) {
  if (!functionName) {
    return null
  }

  logSection('Collecting Lambda@Edge CloudWatch Logs')

  console.log(`Edge Lambda function: ${functionName}`)
  console.log(`Time range: ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`)
  console.log(`Searching in ${EDGE_LOG_REGIONS.length} regions...`)

  // Lambda@Edge log groups use this naming pattern
  const logGroupName = `/aws/lambda/us-east-1.${functionName}`

  // Prepare output
  const logsDir = path.join(outputDir, 'logs')
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }

  const edgeLogFile = path.join(logsDir, 'edge.log')
  const logFileHandle = fs.openSync(edgeLogFile, 'w')

  let totalEvents = 0
  let totalApiCalls = 0
  const regionsWithLogs = []
  const allLogGroups = []

  // Search for logs in each potential edge region
  for (const region of EDGE_LOG_REGIONS) {
    const logsClient = new CloudWatchLogsClient({ region })

    try {
      // Check if log group exists in this region
      const describeCommand = new DescribeLogGroupsCommand({
        logGroupNamePrefix: logGroupName,
        limit: 1
      })
      const describeResponse = await logsClient.send(describeCommand)

      if (!describeResponse.logGroups || describeResponse.logGroups.length === 0) {
        continue
      }

      // Log group exists, collect logs
      const foundLogGroup = describeResponse.logGroups[0].logGroupName
      console.log(`  Found logs in ${region}: ${foundLogGroup}`)
      allLogGroups.push({ logGroupName: foundLogGroup, region })

      // Set 1-day retention on the log group
      try {
        const retentionCommand = new PutRetentionPolicyCommand({
          logGroupName: foundLogGroup,
          retentionInDays: 1
        })
        await logsClient.send(retentionCommand)
        console.log(`    Set 1-day retention on ${foundLogGroup}`)
      } catch (retentionError) {
        console.log(`    Could not set retention: ${retentionError.message}`)
      }

      let regionEvents = 0
      let nextToken = null

      do {
        const filterCommand = new FilterLogEventsCommand({
          logGroupName: foundLogGroup,
          startTime,
          endTime,
          filterPattern: '?BEFAAS ?"REPORT RequestId"',
          nextToken,
          limit: 10000
        })

        const response = await logsClient.send(filterCommand)
        totalApiCalls++

        for (const event of response.events || []) {
          const msg = event.message || ''

          const jsonLine = JSON.stringify({
            timestamp: event.timestamp,
            message: msg,
            ingestionTime: event.ingestionTime,
            logGroup: foundLogGroup,
            region: region,
            fnName: functionName,
            type: 'edge'
          }) + '\n'
          fs.writeSync(logFileHandle, jsonLine)
          regionEvents++
        }

        nextToken = response.nextToken
      } while (nextToken)

      if (regionEvents > 0) {
        console.log(`    Collected ${regionEvents} events from ${region}`)
        totalEvents += regionEvents
        regionsWithLogs.push(region)
      }
    } catch (error) {
      // Ignore ResourceNotFoundException (log group doesn't exist in this region)
      if (error.name !== 'ResourceNotFoundException') {
        console.log(`    Error checking ${region}: ${error.message}`)
      }
    }
  }

  fs.closeSync(logFileHandle)

  if (totalEvents === 0) {
    // Remove empty file
    fs.unlinkSync(edgeLogFile)
    console.log(`\nNo Lambda@Edge logs found in any region`)
    return null
  }

  // Get file size for reporting
  const fileStats = fs.statSync(edgeLogFile)
  const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2)

  console.log(`\n[OK] Lambda@Edge log collection complete`)
  console.log(`  Total events: ${totalEvents}`)
  console.log(`  Regions with logs: ${regionsWithLogs.join(', ')}`)
  console.log(`  API calls made: ${totalApiCalls}`)
  console.log(`  Output file: ${edgeLogFile} (${fileSizeMB} MB)`)

  return {
    totalEvents,
    regionsWithLogs,
    totalApiCalls,
    fileSizeMB: parseFloat(fileSizeMB),
    logGroups: allLogGroups,
    outputFile: edgeLogFile
  }
}

async function cleanupLogGroups (logGroups, awsRegion) {
  if (!logGroups || logGroups.length === 0) {
    return { deleted: 0, failed: 0 }
  }

  console.log(`\nCleaning up ${logGroups.length} CloudWatch log groups...`)

  const logsClient = new CloudWatchLogsClient({ region: awsRegion })
  let deleted = 0
  let failed = 0

  for (const logGroupName of logGroups) {
    try {
      const deleteCommand = new DeleteLogGroupCommand({ logGroupName })
      await logsClient.send(deleteCommand)
      deleted++
      console.log(`  Deleted: ${logGroupName}`)
    } catch (error) {
      // Ignore ResourceNotFoundException (log group may already be deleted)
      if (error.name !== 'ResourceNotFoundException') {
        console.log(`  Failed to delete ${logGroupName}: ${error.message}`)
        failed++
      }
    }
  }

  console.log(`[OK] Log group cleanup complete: ${deleted} deleted, ${failed} failed`)
  return { deleted, failed }
}

async function cleanupEdgeLogGroups (logGroups) {
  if (!logGroups || logGroups.length === 0) {
    return { deleted: 0, failed: 0 }
  }

  console.log(`\nCleaning up ${logGroups.length} Lambda@Edge CloudWatch log groups...`)

  let deleted = 0
  let failed = 0

  for (const { logGroupName, region } of logGroups) {
    try {
      const logsClient = new CloudWatchLogsClient({ region })
      const deleteCommand = new DeleteLogGroupCommand({ logGroupName })
      await logsClient.send(deleteCommand)
      deleted++
      console.log(`  Deleted: ${logGroupName} (${region})`)
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') {
        console.log(`  Failed to delete ${logGroupName} (${region}): ${error.message}`)
        failed++
      }
    }
  }

  console.log(`[OK] Edge log group cleanup complete: ${deleted} deleted, ${failed} failed`)
  return { deleted, failed }
}

async function collectAndCleanupLambdaLogs (config, outputDir, startTime, endTime, cleanup = true) {
  const projectRoot = path.join(__dirname, '..', '..')
  const results = {
    lambda: null,
    edge: null
  }

  // Collect regular Lambda logs for FaaS architecture
  if (config.architecture === 'faas') {
    const result = await collectLambdaLogs(config, outputDir, startTime, endTime)

    if (result && cleanup && result.logGroups && result.logGroups.length > 0) {
      const awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
      const cleanupResult = await cleanupLogGroups(result.logGroups, awsRegion)
      result.cleanup = cleanupResult
    }

    results.lambda = result
  }

  // Collect Lambda@Edge logs if edge auth is enabled
  if (config.auth === 'edge' || config.auth === 'edge-selective') {
    const edgeFunctionName = getEdgeLambdaFunctionName(projectRoot)

    if (edgeFunctionName) {
      const edgeResult = await collectEdgeLambdaLogs(edgeFunctionName, outputDir, startTime, endTime)

      if (edgeResult && cleanup && edgeResult.logGroups && edgeResult.logGroups.length > 0) {
        const edgeCleanupResult = await cleanupEdgeLogGroups(edgeResult.logGroups)
        edgeResult.cleanup = edgeCleanupResult
      }

      results.edge = edgeResult
    } else {
      console.log('No Edge Lambda function found, skipping edge log collection')
    }
  }

  // Return combined result for backward compatibility
  if (results.lambda || results.edge) {
    return {
      totalEvents: (results.lambda?.totalEvents || 0) + (results.edge?.totalEvents || 0),
      totalFunctions: (results.lambda?.totalFunctions || 0) + (results.edge ? 1 : 0),
      lambda: results.lambda,
      edge: results.edge
    }
  }

  return null
}

async function cleanupOldLogGroupsForRun (runId, awsRegion = null) {
  if (!runId) {
    console.log('No run_id provided, skipping log cleanup')
    return { deleted: 0, failed: 0 }
  }

  const region = awsRegion || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
  console.log(`Cleaning up old CloudWatch log groups for run: ${runId}`)

  const logsClient = new CloudWatchLogsClient({ region })

  // Find all log groups matching this run_id
  const logGroups = []
  const prefix = `/aws/lambda/${runId}`

  try {
    let nextToken = null
    do {
      const describeCommand = new DescribeLogGroupsCommand({
        logGroupNamePrefix: prefix,
        nextToken
      })
      const response = await logsClient.send(describeCommand)

      for (const group of response.logGroups || []) {
        logGroups.push(group.logGroupName)
      }
      nextToken = response.nextToken
    } while (nextToken)
  } catch (error) {
    console.log(`Could not search log groups with prefix ${prefix}: ${error.message}`)
    return { deleted: 0, failed: 0 }
  }

  if (logGroups.length === 0) {
    console.log('No old log groups found to clean up')
    return { deleted: 0, failed: 0 }
  }

  console.log(`Found ${logGroups.length} old log groups to clean up`)
  return cleanupLogGroups(logGroups, region)
}

async function cleanupAllOrphanedLogGroups (prefix = '/aws/lambda/faas_', awsRegion = null) {
  const region = awsRegion || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
  console.log(`Cleaning up ALL orphaned CloudWatch log groups with prefix: ${prefix}`)
  console.log(`AWS Region: ${region}`)

  const logsClient = new CloudWatchLogsClient({ region })

  // Find all log groups matching prefix
  const logGroups = []
  let nextToken = null

  try {
    do {
      const describeCommand = new DescribeLogGroupsCommand({
        logGroupNamePrefix: prefix,
        nextToken
      })
      const response = await logsClient.send(describeCommand)

      for (const group of response.logGroups || []) {
        logGroups.push(group.logGroupName)
      }
      nextToken = response.nextToken
    } while (nextToken)
  } catch (error) {
    console.log(`Could not search log groups with prefix ${prefix}: ${error.message}`)
    return { deleted: 0, failed: 0 }
  }

  if (logGroups.length === 0) {
    console.log('No orphaned log groups found to clean up')
    return { deleted: 0, failed: 0 }
  }

  console.log(`Found ${logGroups.length} log groups to clean up:`)
  for (const group of logGroups) {
    console.log(`  - ${group}`)
  }

  return cleanupLogGroups(logGroups, region)
}

async function cleanupAllEdgeLambdaLogs (projectName = 'befaas') {
  const functionName = `${projectName}-edge-auth`
  const logGroupName = `/aws/lambda/us-east-1.${functionName}`

  console.log(`Cleaning up Lambda@Edge log groups for: ${functionName}`)
  console.log(`Searching in ${EDGE_LOG_REGIONS.length} regions...`)

  const allLogGroups = []

  // Find log groups in all edge regions
  for (const region of EDGE_LOG_REGIONS) {
    const logsClient = new CloudWatchLogsClient({ region })

    try {
      const describeCommand = new DescribeLogGroupsCommand({
        logGroupNamePrefix: logGroupName,
        limit: 10
      })
      const response = await logsClient.send(describeCommand)

      for (const group of response.logGroups || []) {
        allLogGroups.push({ logGroupName: group.logGroupName, region })
      }
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') {
        console.log(`  Error checking ${region}: ${error.message}`)
      }
    }
  }

  if (allLogGroups.length === 0) {
    console.log('No Lambda@Edge log groups found to clean up')
    return { deleted: 0, failed: 0 }
  }

  console.log(`Found ${allLogGroups.length} log groups to clean up`)
  return cleanupEdgeLogGroups(allLogGroups)
}

module.exports = {
  collectLambdaLogs,
  collectEdgeLambdaLogs,
  collectAndCleanupLambdaLogs,
  cleanupLogGroups,
  cleanupEdgeLogGroups,
  cleanupOldLogGroupsForRun,
  cleanupAllOrphanedLogGroups,
  cleanupAllEdgeLambdaLogs,
  getLambdaFunctionNames,
  getEdgeLambdaFunctionName,
  getRunId,
  EDGE_LOG_REGIONS
}
