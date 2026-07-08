const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { spawn } = require('child_process');
const { logSection } = require('./utils');
const { collectAndCleanupLambdaLogs } = require('./lambda-logs');
const { collectEcsLogs } = require('./ecs-logs');

async function collectMetrics(experiment, outputDir, experimentStartTime, architecture = null, auth = null) {
  logSection('Collecting Logs and Metrics');

  const projectRoot = path.join(__dirname, '..', '..');
  const logsScript = path.join(projectRoot, 'scripts', 'logs.sh');
  const experimentJsonPath = path.join(projectRoot, 'experiments', experiment, 'experiment.json');

  if (!fs.existsSync(experimentJsonPath)) {
    console.log('No experiment.json found, skipping logs collection');
    return;
  }

  const experimentConfig = JSON.parse(fs.readFileSync(experimentJsonPath, 'utf8'));
  const destLogsDir = path.join(outputDir, 'logs');

  // Get AWS region
  let awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  try {
    const endpointDir = path.join(projectRoot, 'infrastructure', 'aws', 'endpoint');
    if (fs.existsSync(path.join(endpointDir, 'terraform.tfstate'))) {
      const regionOutput = execSync('terraform output -json', {
        cwd: endpointDir,
        encoding: 'utf8'
      });
      const outputs = JSON.parse(regionOutput);
      if (outputs.AWS_LAMBDA_ENDPOINT && outputs.AWS_LAMBDA_ENDPOINT.value) {
        const match = outputs.AWS_LAMBDA_ENDPOINT.value.match(/execute-api\.([^.]+)\.amazonaws\.com/);
        if (match) {
          awsRegion = match[1];
        }
      }
    }
  } catch (error) {
    console.log(`Could not determine AWS region, using default: ${awsRegion}`);
  }

  // Set AWS region in environment
  process.env.AWS_REGION = awsRegion;
  console.log(`Using AWS region: ${awsRegion}`);

  // Calculate time range
  const startTime = experimentStartTime || Date.now() - 3600000; // Default: 1 hour ago
  const endTime = Date.now() + 60000; // 1 minute buffer

  console.log(`Time range: ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`);

  try {
    // For FaaS architecture, use lambda-logs.js (faster SDK-based collection)
    if (architecture === 'faas') {
      console.log('Using SDK-based Lambda log collection...');

      const config = { architecture: 'faas', auth };
      const result = await collectAndCleanupLambdaLogs(config, outputDir, startTime, endTime, true);

      if (result) {
        console.log(`[OK] Collected ${result.totalEvents} log events from ${result.totalFunctions} functions`);
        if (result.edge) {
          console.log(`  (includes ${result.edge.totalEvents} Lambda@Edge events from ${result.edge.regionsWithLogs?.length || 0} regions)`);
        }
      } else {
        console.log('No Lambda logs collected');
      }
    } else {
      // For other architectures, use bash scripts
      console.log('Running bash log collection script...');

      const logsEnv = {
        ...process.env,
        AWS_REGION: awsRegion,
        EXPERIMENT_START_TIME: startTime.toString(),
        EXPERIMENT_END_TIME: endTime.toString()
      };

      await new Promise((resolve, reject) => {
        const child = spawn(logsScript, [experiment, 'experiment.json'], {
          cwd: projectRoot,
          stdio: ['inherit', 'inherit', 'inherit'],
          shell: '/bin/bash',
          env: logsEnv
        });

        child.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`Logs collection script exited with code ${code}`));
          } else {
            resolve();
          }
        });

        child.on('error', (error) => {
          reject(new Error(`Failed to start logs collection script: ${error.message}`));
        });
      });

      // Copy collected logs to output directory
      const logsDir = path.join(projectRoot, 'logs', experiment);

      if (fs.existsSync(logsDir)) {
        const logDirs = fs.readdirSync(logsDir).sort().reverse();
        if (logDirs.length > 0) {
          const latestLogDir = path.join(logsDir, logDirs[0]);

          console.log(`Copying logs from ${latestLogDir} to ${destLogsDir}`);

          if (!fs.existsSync(destLogsDir)) {
            fs.mkdirSync(destLogsDir, { recursive: true });
          }

          const files = fs.readdirSync(latestLogDir);
          for (const file of files) {
            const srcFile = path.join(latestLogDir, file);
            const destFile = path.join(destLogsDir, file);
            fs.copyFileSync(srcFile, destFile);
          }

          console.log('[OK] Logs collected and copied to output directory');
        }
      }

      // For microservices/monolith, also collect ECS container logs
      if (architecture === 'microservices' || architecture === 'monolith') {
        console.log('Collecting ECS container logs...');
        const config = { architecture };
        const ecsResult = await collectEcsLogs(config, outputDir, startTime, endTime);

        if (ecsResult) {
          console.log(`[OK] Collected ${ecsResult.totalEvents} ECS log events from ${ecsResult.totalContainers} containers`);
        } else {
          console.log('No ECS container logs collected');
        }

        // Also collect edge Lambda logs if edge auth is used
        if (auth === 'edge' || auth === 'edge-selective') {
          console.log('Collecting Lambda@Edge logs...');
          const edgeConfig = { architecture, auth };
          const edgeResult = await collectAndCleanupLambdaLogs(edgeConfig, outputDir, startTime, endTime, true);

          if (edgeResult && edgeResult.edge) {
            console.log(`[OK] Collected ${edgeResult.edge.totalEvents} Lambda@Edge log events from ${edgeResult.edge.regionsWithLogs?.length || 0} regions`);
          } else {
            console.log('No Lambda@Edge logs collected');
          }
        }
      }
    }

    // Copy workload.log to logs directory
    const workloadLogSrc = path.join(outputDir, 'workload.log');
    if (fs.existsSync(workloadLogSrc)) {
      if (!fs.existsSync(destLogsDir)) {
        fs.mkdirSync(destLogsDir, { recursive: true });
      }
      const artilleryLogDest = path.join(destLogsDir, 'artillery.log');
      if (!fs.existsSync(artilleryLogDest) || fs.statSync(artilleryLogDest).size === 0) {
        fs.copyFileSync(workloadLogSrc, artilleryLogDest);
        console.log('[OK] Copied workload.log to logs/artillery.log');
      }
    }

    console.log('[OK] Metrics collection completed');
  } catch (error) {
    console.error('[FAIL] Metrics collection failed:', error.message);
    // Don't throw - logs collection is not critical
  }
}

module.exports = {
  collectMetrics
};