const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand
} = require('@aws-sdk/client-cloudwatch-logs')
const { logSection } = require('./utils')

function getRunId (projectRoot, architecture) {
  const infraDir = path.join(projectRoot, 'infrastructure', architecture, 'aws')

  try {
    const output = execSync('terraform output -json', {
      cwd: infraDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const outputs = JSON.parse(output)
    return outputs.run_id?.value || null
  } catch (error) {
    return null
  }
}

async function collectEcsLogs (config, outputDir, startTime, endTime) {
  if (config.architecture !== 'microservices' && config.architecture !== 'monolith') {
    return null
  }

  logSection(`Collecting ECS CloudWatch Logs (${config.architecture})`)

  const projectRoot = path.join(__dirname, '..', '..')
  const awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'

  console.log(`AWS Region: ${awsRegion}`)
  console.log(`Architecture: ${config.architecture}`)
  console.log(`Time range: ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`)

  const runId = getRunId(projectRoot, config.architecture)
  console.log(`Run ID: ${runId || 'not found'}`)

  const logsClient = new CloudWatchLogsClient({ region: awsRegion })

  const logPrefixes = ['/aws/ecs/containerinsights/befaas']
  if (runId) {
    logPrefixes.unshift(`/aws/ecs/containerinsights/befaas-${runId}`)
  }

  // Find all matching log groups
  const logGroups = new Set()

  for (const prefix of logPrefixes) {
    try {
      let nextToken = null
      do {
        const describeCommand = new DescribeLogGroupsCommand({
          logGroupNamePrefix: prefix,
          nextToken
        })
        const response = await logsClient.send(describeCommand)

        for (const group of response.logGroups || []) {
          if (config.architecture === 'monolith' && group.logGroupName.includes('monolith')) {
            logGroups.add(group.logGroupName)
          } else if (config.architecture === 'microservices' &&
                     (group.logGroupName.includes('microservices') ||
                      group.logGroupName.includes('-service'))) {
            logGroups.add(group.logGroupName)
          }
        }
        nextToken = response.nextToken
      } while (nextToken)
    } catch (error) {
      console.log(`Could not search log groups with prefix ${prefix}: ${error.message}`)
    }
  }

  if (logGroups.size === 0) {
    console.log('No CloudWatch log groups found for ECS containers')
    console.log('Searched prefixes:', logPrefixes.join(', '))
    return null
  }

  console.log(`Found ${logGroups.size} log groups:`)
  for (const group of logGroups) {
    console.log(`  - ${group}`)
  }

  const logsDir = path.join(outputDir, 'logs')
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }

  const ecsLogFile = path.join(logsDir, 'aws.log')
  const logFileHandle = fs.openSync(ecsLogFile, 'w')

  let totalEvents = 0
  let totalContainers = 0
  let totalApiCalls = 0

  for (const logGroupName of logGroups) {
    console.log(`  Collecting from: ${logGroupName}`)

    try {
      let groupEvents = 0
      let nextToken = null

      const serviceMatch = logGroupName.match(/([^/]+)$/)
      const serviceName = serviceMatch ? serviceMatch[1] : 'unknown'

      do {
        const filterCommand = new FilterLogEventsCommand({
          logGroupName,
          startTime,
          endTime,
          filterPattern: '?BEFAAS ?"REPORT RequestId"',
          nextToken,
          limit: 10000
        })

        const response = await logsClient.send(filterCommand)
        totalApiCalls++

        for (const event of response.events || []) {
          const jsonLine = JSON.stringify({
            timestamp: event.timestamp,
            message: event.message,
            ingestionTime: event.ingestionTime,
            logGroup: logGroupName,
            serviceName: serviceName,
            logStreamName: event.logStreamName
          }) + '\n'
          fs.writeSync(logFileHandle, jsonLine)
          groupEvents++
        }

        nextToken = response.nextToken

        if (groupEvents > 0 && groupEvents % 10000 === 0) {
          console.log(`    ... ${groupEvents} events collected`)
        }
      } while (nextToken)

      if (groupEvents > 0) {
        console.log(`    Collected ${groupEvents} events`)
        totalEvents += groupEvents
        totalContainers++
      } else {
        console.log(`    No events found in time range`)
      }
    } catch (groupError) {
      console.log(`    Error reading log group: ${groupError.message}`)
    }
  }

  fs.closeSync(logFileHandle)

  const fileStats = fs.statSync(ecsLogFile)
  const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2)

  console.log(`\n[OK] ECS log collection complete`)
  console.log(`  Total events: ${totalEvents}`)
  console.log(`  Containers with logs: ${totalContainers}`)
  console.log(`  API calls made: ${totalApiCalls}`)
  console.log(`  Output file: ${ecsLogFile} (${fileSizeMB} MB)`)

  return {
    totalEvents,
    totalContainers,
    totalApiCalls,
    fileSizeMB: parseFloat(fileSizeMB),
    logGroups: Array.from(logGroups),
    outputFile: ecsLogFile
  }
}

async function main () {
  const args = process.argv.slice(2)

  if (args.length < 1) {
    console.log('Usage: node ecs-logs.js <results-directory> [start-time] [end-time]')
    console.log('')
    console.log('Examples:')
    console.log('  node ecs-logs.js results/webservice/monolith_service-integrated_512MB_2026-01-14T15-49-12-487Z')
    console.log('  node ecs-logs.js results/webservice/microservices_service-integrated_512MB_2026-01-14T15-16-15-513Z')
    console.log('')
    console.log('If start-time and end-time are not provided, they will be read from the results directory.')
    process.exit(1)
  }

  const resultsDir = path.resolve(args[0])

  if (!fs.existsSync(resultsDir)) {
    console.error(`Results directory not found: ${resultsDir}`)
    process.exit(1)
  }

  // Determine architecture from directory name
  let architecture = 'unknown'
  if (resultsDir.includes('monolith')) {
    architecture = 'monolith'
  } else if (resultsDir.includes('microservices')) {
    architecture = 'microservices'
  } else {
    console.error('Could not determine architecture from directory name')
    process.exit(1)
  }

  // Get time range
  let startTime, endTime

  if (args.length >= 3) {
    startTime = new Date(args[1]).getTime()
    endTime = new Date(args[2]).getTime()
  } else {
    // Try to read from experiment_start_time.txt
    const startTimeFile = path.join(resultsDir, 'experiment_start_time.txt')
    if (fs.existsSync(startTimeFile)) {
      const startTimeStr = fs.readFileSync(startTimeFile, 'utf8').trim()
      startTime = new Date(startTimeStr).getTime()
    } else {
      // Fallback: use directory name timestamp
      const timestampMatch = resultsDir.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/)
      if (timestampMatch) {
        const ts = timestampMatch[1].replace(/-/g, (m, i) => i > 9 ? ':' : '-')
        startTime = new Date(ts).getTime()
      } else {
        console.error('Could not determine start time')
        process.exit(1)
      }
    }

    // End time: check cloudwatch metrics or use now
    const metricsFile = path.join(resultsDir, 'cloudwatch', 'metrics.json')
    if (fs.existsSync(metricsFile)) {
      const metrics = JSON.parse(fs.readFileSync(metricsFile, 'utf8'))
      endTime = new Date(metrics.meta.end_time).getTime()
    } else {
      // Use 1 hour after start as default
      endTime = startTime + (60 * 60 * 1000)
    }
  }

  console.log(`Results directory: ${resultsDir}`)
  console.log(`Architecture: ${architecture}`)
  console.log(`Time range: ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`)

  const config = { architecture }

  try {
    const result = await collectEcsLogs(config, resultsDir, startTime, endTime)

    if (result) {
      console.log('\nECS logs saved to:', result.outputFile)
    } else {
      console.log('\nNo logs collected')
    }
  } catch (error) {
    console.error('Error collecting ECS logs:', error.message)
    process.exit(1)
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error)
}

module.exports = {
  collectEcsLogs,
  getRunId
}
