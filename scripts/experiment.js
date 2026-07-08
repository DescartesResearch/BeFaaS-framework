#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { parseArgs, validateConfig } = require('./experiment/config');
const { validateEnvironment, setHardwareConfig, installTerraformProviders } = require('./experiment/env');
const { runBuild } = require('./experiment/build');
const { runDeploy, runDestroy, resetCognitoUserPool, forceDestroyRedis } = require('./experiment/deploy');
const { runBenchmark } = require('./experiment/benchmark');
const { collectMetrics } = require('./experiment/metrics');
const { collectCloudWatchMetrics } = require('./experiment/cloudwatch-metrics');
const { cleanupOldLogGroupsForRun, cleanupAllOrphanedLogGroups, cleanupAllEdgeLambdaLogs } = require('./experiment/lambda-logs');
const { collectPricingMetrics } = require('./experiment/pricing');
const { analyzeResults } = require('./experiment/analysis');
const {
  S3_BUCKET_NAME,
  logSection,
  checkHealth,
  cleanupBuildArtifacts,
  uploadResultsToS3,
  setupLogging,
  parseCpuInfoFromLogs
} = require('./experiment/utils');
const { getTerraformOutputJson } = require('./deploy-shared');

async function waitForUserConfirmation(message) {
  console.warn(`\nWarning:  ${message}`);
  console.warn('Continuing automatically after 10 seconds...');
  await new Promise(resolve => setTimeout(resolve, 10000));
  return true;
}

function updateHardwareConfigWithScalingRules(config, hardwareConfigDir) {
  const hardwareConfigFile = path.join(hardwareConfigDir, 'hardware_config.json');
  if (!fs.existsSync(hardwareConfigFile)) {
    console.log('hardware_config.json not found, skipping scaling rules update');
    return;
  }

  const projectRoot = path.join(__dirname, '..');
  let terraformDir;

  if (config.architecture === 'monolith') {
    terraformDir = path.join(projectRoot, 'infrastructure', 'monolith', 'aws');
  } else if (config.architecture === 'microservices') {
    terraformDir = path.join(projectRoot, 'infrastructure', 'microservices', 'aws');
  } else {
    // FaaS has no ECS scaling rules
    return;
  }

  try {
    const output = getTerraformOutputJson(terraformDir);
    const scalingConfig = output.scaling_config?.value;

    if (!scalingConfig) {
      console.log('No scaling_config output from Terraform, skipping');
      return;
    }

    const hardwareConfig = JSON.parse(fs.readFileSync(hardwareConfigFile, 'utf8'));
    hardwareConfig.services = scalingConfig;
    fs.writeFileSync(hardwareConfigFile, JSON.stringify(hardwareConfig, null, 2));

    const serviceCount = Object.keys(scalingConfig).length;
    const ruleCount = Object.values(scalingConfig).reduce(
      (sum, svc) => sum + Object.keys(svc.scaling_rules || {}).length, 0
    );
    console.log(`[OK] Updated hardware_config.json with scaling rules (${serviceCount} services, ${ruleCount} rules)`);
  } catch (error) {
    console.warn('Warning: Could not read scaling config from Terraform:', error.message);
  }
}

async function updateHardwareConfigWithCpuInfo(logsDir, hardwareConfigDir) {
  const cpuInfo = await parseCpuInfoFromLogs(logsDir);
  if (!cpuInfo) {
    console.log('No CPU info found in logs');
    return;
  }

  const hardwareConfigFile = path.join(hardwareConfigDir, 'hardware_config.json');
  if (!fs.existsSync(hardwareConfigFile)) {
    console.log('hardware_config.json not found, skipping CPU info update');
    return;
  }

  try {
    const hardwareConfig = JSON.parse(fs.readFileSync(hardwareConfigFile, 'utf8'));
    hardwareConfig.service_cpu_info = cpuInfo;
    fs.writeFileSync(hardwareConfigFile, JSON.stringify(hardwareConfig, null, 2));
    console.log(`[OK] Updated hardware_config.json with service CPU info: ${cpuInfo.model_name || 'unknown'}`);
  } catch (error) {
    console.warn('Warning: Could not update hardware_config.json with CPU info:', error.message);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const config = validateConfig(parseArgs(args));

  if (config.cleanupLogs) {
    logSection('Cleaning Up ALL Orphaned CloudWatch Log Groups');
    await cleanupAllOrphanedLogGroups();
    console.log('\n[OK] Cleanup complete. Exiting.');
    process.exit(0);
  }

  if (!fs.existsSync(config.outputDir)) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }

  const logFile = setupLogging(config.outputDir);

  console.log('Experiment Configuration:');
  console.log(`  Experiment: ${config.experiment}`);
  console.log(`  Architecture: ${config.architecture}`);
  console.log(`  Auth Strategy: ${config.auth}`);
  console.log(`  Auth Granularity: ${config.authGranularity}`);
  if (config.algorithm) {
    console.log(`  Algorithm: ${config.algorithm}`);
  }
  if (config.withCloudfront) {
    console.log(`  CloudFront Proxy: enabled (passthrough)`);
  }

  if (config.architecture === 'faas') {
    console.log(`  Lambda Memory: ${config.memory} MB`);
  } else {
    console.log(`  Fargate CPU: ${config.cpu} units (${config.cpu / 1024} vCPU)`);
    console.log(`  Fargate Memory: ${config.memoryFargate} MB`);
    console.log(`  Scaling Mode: ${config.scalingMode}`);
  }

  console.log(`  Workload: ${config.workload}`);
  console.log(`  Run ID: ${config.runId}`);
  console.log(`  Output Directory: ${config.outputDir}`);
  console.log(`  Log File: ${logFile}`);

  let buildDir = null;
  let experimentStartTime = null;

  try {
    // Step 0: Validate environment, set hardware config, and install Terraform providers
    validateEnvironment(config.experiment);
    setHardwareConfig(config);
    installTerraformProviders(config.experiment);

    // Make auth granularity available to runtime containers/lambdas via Terraform
    process.env.BEFAAS_AUTH_GRANULARITY = config.authGranularity;
    process.env.TF_VAR_auth_granularity = config.authGranularity;

    if (!config.skipBenchmark) {
      // Step 1: Cleanup and destroy existing infrastructure
      cleanupBuildArtifacts(config.experiment, config.architecture);

      try {
        try {
          await forceDestroyRedis(config.experiment);
        } catch (redisError) {
          console.warn('Warning: Could not force destroy Redis:', redisError.message);
        }

        await runDestroy(config.experiment, config.architecture, config.auth, { skipEdgeAuth: config.reuseEdgeAuth, withCloudfront: config.withCloudfront });
      } catch (error) {
        console.log('No existing infrastructure to destroy or destroy failed:', error.message);
      }

      if (config.architecture === 'faas') {
        logSection('Cleaning Up Old CloudWatch Logs');
        await cleanupOldLogGroupsForRun(config.runId);
      }

      // Step 2: Build
      const buildAuth = config.auth === 'edge-selective' ? 'edge' : config.auth;
      buildDir = await runBuild(config.experiment, config.architecture, buildAuth, config.algorithm);

      // Step 3: Deploy
      experimentStartTime = Date.now() - 60000;

      const timestampFile = path.join(config.outputDir, 'experiment_start_time.txt');
      fs.writeFileSync(timestampFile, `${experimentStartTime}\n${new Date(experimentStartTime).toISOString()}`);
      console.log(`Experiment start time recorded: ${new Date(experimentStartTime).toISOString()}`);

      // Write hardware configuration
      const hardwareConfig = {
        architecture: config.architecture,
        auth_strategy: config.auth,
        auth_granularity: config.authGranularity,
        aws_service: config.architecture === 'faas' ? 'lambda' : 'ecs fargate',
        ram_in_mb: config.architecture === 'faas' ? config.memory : config.memoryFargate,
        with_cloudfront: config.withCloudfront,
        datetime: config.runId.split('_').pop()
      };
      if (config.architecture !== 'faas') {
        hardwareConfig.cpu_in_vcpu = config.cpu / 1024;
        hardwareConfig.scaling_mode = config.scalingMode;
      }
      if (config.algorithm) {
        const algorithmMap = {
          'bcrypt-hs256': { password_hash_algorithm: 'bcrypt', jwt_sign_algorithm: 'HS256' },
          'argon2id-eddsa': { password_hash_algorithm: 'argon2id', jwt_sign_algorithm: 'EdDSA' }
        };
        const algConfig = algorithmMap[config.algorithm];
        if (algConfig) {
          hardwareConfig.password_hash_algorithm = algConfig.password_hash_algorithm;
          hardwareConfig.jwt_sign_algorithm = algConfig.jwt_sign_algorithm;
        }
      }
      const hardwareConfigFile = path.join(config.outputDir, 'hardware_config.json');
      fs.writeFileSync(hardwareConfigFile, JSON.stringify(hardwareConfig, null, 2));
      console.log(`Hardware config written: ${hardwareConfigFile}`);

      const workloadFile = path.join(__dirname, '..', 'experiments', config.experiment, config.workload);
      const workloadYaml = yaml.load(fs.readFileSync(workloadFile, 'utf8'));
      const benchmarkConfig = {
        http_timeout_in_seconds: workloadYaml.config && workloadYaml.config.http && workloadYaml.config.http.timeout || 10
      };
      const benchmarkConfigFile = path.join(config.outputDir, 'benchmark_configuration.json');
      fs.writeFileSync(benchmarkConfigFile, JSON.stringify(benchmarkConfig, null, 2));
      console.log(`Benchmark config written: ${benchmarkConfigFile}`);

      const errorDescFile = path.join(config.outputDir, 'error_description.md');
      fs.writeFileSync(errorDescFile, '');
      console.log(`Error description file created: ${errorDescFile}`);

      process.env.TF_VAR_run_id = config.runId;
      console.log(`Run ID: ${config.runId}`);

      const endpoints = await runDeploy(config.experiment, config.architecture, buildDir, config.auth, config.algorithm, config.reuseEdgeAuth, config.withCloudfront);

      updateHardwareConfigWithScalingRules(config, config.outputDir);

      const isEcsBased = config.architecture === 'monolith' || config.architecture === 'microservices';
      const isEdgeAuth = config.auth === 'edge' || config.auth === 'edge-selective';
      const hasCloudfront = isEdgeAuth || config.withCloudfront;
      const stabilizationDelay = isEcsBased ? 180000 : (hasCloudfront ? 60000 : 5000); // 3 min for ecs, 1 min for edge/cf, 5s for Lambda
      const healthCheckRetries = 120;
      const healthCheckDelay = isEcsBased ? 30000 : 3000; // 30s for ecs, 3s for Lambda

      console.log(`\nWaiting for deployment to stabilize (${stabilizationDelay / 1000}s)...`);
      await new Promise(resolve => setTimeout(resolve, stabilizationDelay));

      const isHealthy = await checkHealth(endpoints, healthCheckRetries, healthCheckDelay);
      if (!isHealthy) {
        throw new Error('Deployment failed health check');
      }

      // Step 4-7: Run Benchmark
      await resetCognitoUserPool();
      await runBenchmark(config.experiment, config.workload, config.outputDir, config.auth, config.architecture, config.algorithm);

      // Record end time
      const experimentEndTime = Date.now() + 60000;

      if (!config.skipMetrics) {
        await collectMetrics(config.experiment, config.outputDir, experimentStartTime, config.architecture, config.auth);

        await collectCloudWatchMetrics(config, config.outputDir, experimentStartTime, experimentEndTime);

        await collectPricingMetrics(config, config.outputDir, experimentStartTime, experimentEndTime);
      }

      await updateHardwareConfigWithCpuInfo(path.join(config.outputDir, 'logs'), config.outputDir);

      await analyzeResults(config.experiment, config.outputDir);
    }

    // Step 8: Destroy infrastructure if requested
    let destroyFailed = false;
    if (config.destroy) {
      try {
        await runDestroy(config.experiment, config.architecture, config.auth, { skipEdgeAuth: config.keepEdgeAuth, withCloudfront: config.withCloudfront });
        cleanupBuildArtifacts(config.experiment, config.architecture);
      } catch (destroyError) {
        destroyFailed = true;
        console.error('\nWarning:  Infrastructure destruction failed:', destroyError.message);
        console.log('Analysis has already been completed. Results are available in the output directory.');
        console.log('You may need to manually destroy the infrastructure or retry later.');
        await waitForUserConfirmation('Infrastructure destruction failed. Please verify AWS resources are cleaned up.');
      }

      // Step 9: Clean up CloudWatch log groups AFTER terraform destroy
      if (config.architecture === 'faas' && config.runId) {
        logSection('Cleaning Up CloudWatch Log Groups');
        try {
          await cleanupOldLogGroupsForRun(config.runId);
        } catch (logError) {
          console.warn('Warning: Could not cleanup CloudWatch logs:', logError.message);
        }
      }

      if ((config.auth === 'edge' || config.auth === 'edge-selective') && !config.keepEdgeAuth) {
        logSection('Cleaning Up Lambda@Edge Log Groups');
        try {
          await cleanupAllEdgeLambdaLogs();
        } catch (edgeLogError) {
          console.warn('Warning: Could not cleanup Lambda@Edge logs:', edgeLogError.message);
        }
      }
    }

    // Step 10: Upload results to S3
    await uploadResultsToS3(
      config.outputDir,
      config.experiment,
      config.architecture,
      config.auth
    );

    logSection('Experiment Complete');
    console.log(`Results saved to: ${config.outputDir}`);
    console.log(`Results uploaded to: s3://${S3_BUCKET_NAME}/${config.experiment}/`);
    if (config.destroy) {
      console.log('Infrastructure has been destroyed and cleaned up');
    }

  } catch (error) {
    console.error('\nERROR: Experiment failed:', error.message);
    console.error(error.stack);

    // Write error description to file
    const errorDescFile = path.join(config.outputDir, 'error_description.md');
    const errorContent = `# Experiment Error

**Error:** ${error.message}

**Timestamp:** ${new Date().toISOString()}

## Stack Trace
\`\`\`
${error.stack}
\`\`\`

## Configuration
- Architecture: ${config.architecture}
- Auth Strategy: ${config.auth}
- Run ID: ${config.runId}
`;
    try {
      fs.writeFileSync(errorDescFile, errorContent);
      console.log(`Error description written to: ${errorDescFile}`);
    } catch (writeError) {
      console.warn('Warning: Could not write error description:', writeError.message);
    }

    console.log('\nAttempting to collect logs and metrics before cleanup...');

    const errorRecoveryStartTime = experimentStartTime || Date.now() - 3600000;
    const errorRecoveryEndTime = Date.now() + 60000; // 1 minute buffer

    try {
      console.log('Collecting metrics...');
      await collectMetrics(config.experiment, config.outputDir, errorRecoveryStartTime, config.architecture, config.auth);
      console.log('[OK] Metrics collection completed');
    } catch (metricsError) {
      console.warn('Warning: Could not collect metrics:', metricsError.message);
    }

    try {
      console.log('Collecting CloudWatch metrics...');
      await collectCloudWatchMetrics(config, config.outputDir, errorRecoveryStartTime, errorRecoveryEndTime);
      console.log('[OK] CloudWatch metrics collection completed');
    } catch (cwError) {
      console.warn('Warning: Could not collect CloudWatch metrics:', cwError.message);
    }

    try {
      console.log('Collecting pricing metrics...');
      await collectPricingMetrics(config, config.outputDir, errorRecoveryStartTime, errorRecoveryEndTime);
      console.log('[OK] Pricing metrics collection completed');
    } catch (pricingError) {
      console.warn('Warning: Could not collect pricing metrics:', pricingError.message);
    }

    console.log('\nAttempting to analyze collected logs...');
    try {
      await analyzeResults(config.experiment, config.outputDir);
      console.log('[OK] Analysis completed on available logs');
    } catch (analysisError) {
      console.warn('Warning: Could not run analysis:', analysisError.message);
    }

    console.log('\nCleaning up infrastructure...');
    try {
      console.log('Force destroying Redis containers...');
      try {
        await forceDestroyRedis(config.experiment);
      } catch (redisError) {
        console.warn('Warning: Could not force destroy Redis:', redisError.message);
      }

      await runDestroy(config.experiment, config.architecture, config.auth, { skipEdgeAuth: config.keepEdgeAuth, withCloudfront: config.withCloudfront });
      cleanupBuildArtifacts(config.experiment, config.architecture);

      if (config.architecture === 'faas' && config.runId) {
        console.log('Cleaning up CloudWatch log groups...');
        try {
          await cleanupOldLogGroupsForRun(config.runId);
        } catch (logError) {
          console.warn('Warning: Could not cleanup CloudWatch logs:', logError.message);
        }
      }

      if ((config.auth === 'edge' || config.auth === 'edge-selective') && !config.keepEdgeAuth) {
        console.log('Cleaning up Lambda@Edge log groups...');
        try {
          await cleanupAllEdgeLambdaLogs();
        } catch (edgeLogError) {
          console.warn('Warning: Could not cleanup Lambda@Edge logs:', edgeLogError.message);
        }
      }
    } catch (cleanupError) {
      console.error('\nWarning:  Infrastructure cleanup failed:', cleanupError.message);
      console.log('Logs and metrics have been collected and analyzed.');
      console.log('You may need to manually destroy the infrastructure or retry later.');
      await waitForUserConfirmation('Infrastructure cleanup failed. Please verify AWS resources are cleaned up before continuing.');
    }

    process.exit(1);
  }
}

main();
