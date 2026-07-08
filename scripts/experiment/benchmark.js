const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { logSection } = require('./utils');

async function runBenchmark(experiment, workload, outputDir, authMode = 'none', architecture = 'faas', algorithm = 'argon2id-eddsa') {
  logSection('Running Benchmark');

  const projectRoot = path.join(__dirname, '..', '..');
  const experimentJsonPath = path.join(projectRoot, 'experiments', experiment, 'experiment.json');

  if (!fs.existsSync(experimentJsonPath)) {
    throw new Error(`experiment.json not found: ${experimentJsonPath}`);
  }

  const experimentConfig = JSON.parse(fs.readFileSync(experimentJsonPath, 'utf8'));

  // Check if workload service is configured
  if (!experimentConfig.services || !experimentConfig.services.workload) {
    console.log('No workload service configured, skipping benchmark');
    return;
  }

  // Use provided workload parameter or fall back to experiment.json config
  let workloadConfigName = workload || experimentConfig.services.workload.config;
  if (!workloadConfigName) {
    throw new Error('Workload config not defined (services.workload.config)');
  }

  // Ensure workload has .yml extension
  if (!workloadConfigName.endsWith('.yml') && !workloadConfigName.endsWith('.yaml')) {
    workloadConfigName = `workload-${workloadConfigName}.yml`;
  }

  const workloadPath = path.join(projectRoot, 'experiments', experiment, workloadConfigName);
  if (!fs.existsSync(workloadPath)) {
    throw new Error(`Workload file not found: ${workloadPath}`);
  }

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`Using workload: ${workloadConfigName}`);
  console.log(`Output directory: ${outputDir}`);
  console.log(`Auth mode: ${authMode}`);

  // Run the workload.sh script and capture logs
  const logFile = path.join(outputDir, 'workload.log');
  const workloadScript = path.join(projectRoot, 'scripts', 'workload.sh');

  return new Promise((resolve, reject) => {
    console.log('Running workload script...');

    const workloadLogStream = fs.createWriteStream(logFile);

    const scriptArgs = [experiment, 'experiment.json', workloadConfigName];
    const child = spawn(workloadScript, scriptArgs, {
      cwd: projectRoot,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: '/bin/bash',
      env: { ...process.env, AUTH_MODE: authMode, ARCHITECTURE: architecture, ALGORITHM: algorithm }
    });

    child.stdout.on('data', (data) => {
      process.stdout.write(data);
      workloadLogStream.write(data);
    });

    child.stderr.on('data', (data) => {
      process.stderr.write(data);
      workloadLogStream.write(data);
    });

    child.on('close', (code) => {
      workloadLogStream.end();

      if (code !== 0) {
        reject(new Error(`Workload script exited with code ${code}`));
      } else {
        console.log('[OK] Benchmark completed');
        resolve();
      }
    });

    child.on('error', (error) => {
      workloadLogStream.end();
      reject(new Error(`Failed to start workload script: ${error.message}`));
    });
  });
}

module.exports = {
  runBenchmark
};
