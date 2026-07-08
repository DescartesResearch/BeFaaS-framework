const fs = require('fs')
const path = require('path')
const {
  CloudWatchClient,
  GetMetricDataCommand
} = require('@aws-sdk/client-cloudwatch')
const { logSection } = require('./utils')
const { getTerraformOutputs } = require('./terraform-helpers')

async function collectCloudWatchMetrics (config, outputDir, startTime, endTime = Date.now()) {
  const { architecture } = config

  if (architecture === 'faas') {
    console.log('FaaS metrics will be derived locally from REPORT lines in aws.log')
    return null
  }

  logSection('Collecting CloudWatch Metrics')

  const projectRoot = path.join(__dirname, '..', '..')

  if (architecture === 'monolith' || architecture === 'microservices') {
    return await collectECSCloudWatchMetrics(config, outputDir, startTime, endTime, projectRoot)
  } else {
    console.log(`Unknown architecture: ${architecture}`)
    return null
  }
}

async function collectECSCloudWatchMetrics (config, outputDir, startTime, endTime, projectRoot) {
  const { architecture } = config

  // Get infrastructure directory
  const infraDir = path.join(projectRoot, 'infrastructure', architecture, 'aws')
  if (!fs.existsSync(path.join(infraDir, 'terraform.tfstate'))) {
    console.log('No Terraform state found, skipping CloudWatch metrics')
    return null
  }

  // Get Terraform outputs
  const outputs = getTerraformOutputs(infraDir)
  if (!outputs) {
    return null
  }

  console.log('Retrieved Terraform outputs:')
  console.log(`  Cluster: ${outputs.cluster_name}`)
  console.log(`  ALB ARN Suffix: ${outputs.alb_arn_suffix}`)

  // Get AWS region
  const awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
  console.log(`  Region: ${awsRegion}`)

  // Initialize CloudWatch client
  const cloudwatch = new CloudWatchClient({ region: awsRegion })

  // Calculate time range
  const startDate = new Date(startTime)
  const endDate = new Date(endTime)
  const durationMinutes = Math.ceil((endTime - startTime) / 60000)

  // Use 1-minute period for granular data
  const period = 60

  console.log(`\nTime range: ${startDate.toISOString()} to ${endDate.toISOString()}`)
  console.log(`Duration: ${durationMinutes} minutes`)

  // Build metric queries
  const metricQueries = []
  let queryId = 0

  // ECS metrics
  const clusterName = outputs.cluster_name
  const serviceNames = architecture === 'monolith'
    ? [outputs.service_name]
    : Object.values(outputs.service_names || {})

  for (const serviceName of serviceNames) {
    // CPU Utilization
    metricQueries.push({
      Id: `ecs_cpu_${queryId++}`,
      MetricStat: {
        Metric: {
          Namespace: 'AWS/ECS',
          MetricName: 'CPUUtilization',
          Dimensions: [
            { Name: 'ClusterName', Value: clusterName },
            { Name: 'ServiceName', Value: serviceName }
          ]
        },
        Period: period,
        Stat: 'Average'
      },
      Label: `ECS CPU - ${serviceName}`
    })

    // Memory Utilization
    metricQueries.push({
      Id: `ecs_mem_${queryId++}`,
      MetricStat: {
        Metric: {
          Namespace: 'AWS/ECS',
          MetricName: 'MemoryUtilization',
          Dimensions: [
            { Name: 'ClusterName', Value: clusterName },
            { Name: 'ServiceName', Value: serviceName }
          ]
        },
        Period: period,
        Stat: 'Average'
      },
      Label: `ECS Memory - ${serviceName}`
    })

    // Running Task Count (Container Insights)
    metricQueries.push({
      Id: `ecs_running_tasks_${queryId++}`,
      MetricStat: {
        Metric: {
          Namespace: 'ECS/ContainerInsights',
          MetricName: 'RunningTaskCount',
          Dimensions: [
            { Name: 'ClusterName', Value: clusterName },
            { Name: 'ServiceName', Value: serviceName }
          ]
        },
        Period: period,
        Stat: 'Average'
      },
      Label: `ECS Running Tasks - ${serviceName}`
    })

    // Desired Task Count (Container Insights)
    metricQueries.push({
      Id: `ecs_desired_tasks_${queryId++}`,
      MetricStat: {
        Metric: {
          Namespace: 'ECS/ContainerInsights',
          MetricName: 'DesiredTaskCount',
          Dimensions: [
            { Name: 'ClusterName', Value: clusterName },
            { Name: 'ServiceName', Value: serviceName }
          ]
        },
        Period: period,
        Stat: 'Average'
      },
      Label: `ECS Desired Tasks - ${serviceName}`
    })
  }

  // ALB metrics
  const albArnSuffix = outputs.alb_arn_suffix
  const targetGroupArnSuffix = outputs.target_group_arn_suffix

  // Request Count
  metricQueries.push({
    Id: `alb_requests_${queryId++}`,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'RequestCount',
        Dimensions: [
          { Name: 'LoadBalancer', Value: albArnSuffix }
        ]
      },
      Period: period,
      Stat: 'Sum'
    },
    Label: 'ALB Request Count'
  })

  // Target Response Time
  metricQueries.push({
    Id: `alb_response_time_${queryId++}`,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'TargetResponseTime',
        Dimensions: [
          { Name: 'LoadBalancer', Value: albArnSuffix }
        ]
      },
      Period: period,
      Stat: 'Average'
    },
    Label: 'ALB Target Response Time (avg)'
  })

  // Target Response Time p95
  metricQueries.push({
    Id: `alb_response_time_p95_${queryId++}`,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'TargetResponseTime',
        Dimensions: [
          { Name: 'LoadBalancer', Value: albArnSuffix }
        ]
      },
      Period: period,
      Stat: 'p95'
    },
    Label: 'ALB Target Response Time (p95)'
  })

  // HTTP 2XX Count
  metricQueries.push({
    Id: `alb_2xx_${queryId++}`,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'HTTPCode_Target_2XX_Count',
        Dimensions: [
          { Name: 'LoadBalancer', Value: albArnSuffix }
        ]
      },
      Period: period,
      Stat: 'Sum'
    },
    Label: 'ALB HTTP 2XX Count'
  })

  // HTTP 4XX Count
  metricQueries.push({
    Id: `alb_4xx_${queryId++}`,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'HTTPCode_Target_4XX_Count',
        Dimensions: [
          { Name: 'LoadBalancer', Value: albArnSuffix }
        ]
      },
      Period: period,
      Stat: 'Sum'
    },
    Label: 'ALB HTTP 4XX Count'
  })

  // HTTP 5XX Count
  metricQueries.push({
    Id: `alb_5xx_${queryId++}`,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'HTTPCode_Target_5XX_Count',
        Dimensions: [
          { Name: 'LoadBalancer', Value: albArnSuffix }
        ]
      },
      Period: period,
      Stat: 'Sum'
    },
    Label: 'ALB HTTP 5XX Count'
  })

  // Fetch metrics (CloudWatch allows max 500 metrics per request)
  console.log(`\nFetching ${metricQueries.length} metric series...`)

  try {
    const command = new GetMetricDataCommand({
      MetricDataQueries: metricQueries,
      StartTime: startDate,
      EndTime: endDate
    })

    const response = await cloudwatch.send(command)

    // Process results
    const metricsData = {
      meta: {
        architecture,
        cluster_name: clusterName,
        service_names: serviceNames,
        alb_arn_suffix: albArnSuffix,
        target_group_arn_suffix: targetGroupArnSuffix,
        region: awsRegion,
        start_time: startDate.toISOString(),
        end_time: endDate.toISOString(),
        period_seconds: period,
        collected_at: new Date().toISOString()
      },
      metrics: {}
    }

    for (const result of response.MetricDataResults) {
      const metricName = result.Label
      const timestamps = result.Timestamps || []
      const values = result.Values || []

      // Combine timestamps and values into data points
      const dataPoints = timestamps.map((ts, i) => ({
        timestamp: ts.toISOString(),
        value: values[i]
      }))

      // Sort by timestamp ascending
      dataPoints.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))

      metricsData.metrics[metricName] = {
        id: result.Id,
        status: result.StatusCode,
        data_points: dataPoints,
        summary: dataPoints.length > 0
          ? {
              count: dataPoints.length,
              min: Math.min(...values),
              max: Math.max(...values),
              avg: values.reduce((a, b) => a + b, 0) / values.length
            }
          : null
      }

      console.log(`  ${metricName}: ${dataPoints.length} data points`)
    }

    // Save metrics to file
    const metricsDir = path.join(outputDir, 'cloudwatch')
    if (!fs.existsSync(metricsDir)) {
      fs.mkdirSync(metricsDir, { recursive: true })
    }

    const metricsFile = path.join(metricsDir, 'metrics.json')
    fs.writeFileSync(metricsFile, JSON.stringify(metricsData, null, 2))
    console.log(`\n[OK] CloudWatch metrics saved to: ${metricsFile}`)

    // Also save a CSV for easy graphing
    await saveMetricsAsCsv(metricsData, metricsDir)

    return metricsData
  } catch (error) {
    console.error(`[FAIL] Failed to collect CloudWatch metrics: ${error.message}`)
    return null
  }
}

async function saveMetricsAsCsv (metricsData, metricsDir) {
  // Create separate CSVs for ECS and ALB metrics
  const ecsMetrics = {}
  const albMetrics = {}

  for (const [name, metric] of Object.entries(metricsData.metrics)) {
    if (name.startsWith('ECS')) {
      ecsMetrics[name] = metric
    } else {
      albMetrics[name] = metric
    }
  }

  // Save ECS metrics CSV
  if (Object.keys(ecsMetrics).length > 0) {
    const ecsCsvFile = path.join(metricsDir, 'ecs_metrics.csv')
    const ecsCsv = generateCsv(ecsMetrics)
    fs.writeFileSync(ecsCsvFile, ecsCsv)
    console.log(`[OK] ECS metrics CSV saved to: ${ecsCsvFile}`)
  }

  // Save ALB metrics CSV
  if (Object.keys(albMetrics).length > 0) {
    const albCsvFile = path.join(metricsDir, 'alb_metrics.csv')
    const albCsv = generateCsv(albMetrics)
    fs.writeFileSync(albCsvFile, albCsv)
    console.log(`[OK] ALB metrics CSV saved to: ${albCsvFile}`)
  }
}

function generateCsv (metrics) {
  // Get all unique timestamps across all metrics
  const allTimestamps = new Set()
  for (const metric of Object.values(metrics)) {
    for (const dp of metric.data_points) {
      allTimestamps.add(dp.timestamp)
    }
  }

  const sortedTimestamps = Array.from(allTimestamps).sort()
  const metricNames = Object.keys(metrics)

  // Build header
  const header = ['timestamp', ...metricNames].join(',')

  // Build rows
  const rows = sortedTimestamps.map(ts => {
    const values = metricNames.map(name => {
      const dp = metrics[name].data_points.find(d => d.timestamp === ts)
      return dp ? dp.value : ''
    })
    return [ts, ...values].join(',')
  })

  return [header, ...rows].join('\n')
}

module.exports = {
  collectCloudWatchMetrics
}
