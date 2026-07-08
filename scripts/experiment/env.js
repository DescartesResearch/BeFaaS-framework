const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { logSection } = require('./utils');

function getProvidersFromConfig(config) {
  const providers = new Set();
  if (config.program && config.program.functions) {
    for (const func of Object.values(config.program.functions)) {
      if (func.provider) {
        providers.add(func.provider);
      }
    }
  }
  return Array.from(providers);
}

function validateEnvironment(experiment) {
  logSection('Validating Environment');

  const projectRoot = path.join(__dirname, '..', '..');
  const experimentJsonPath = path.join(projectRoot, 'experiments', experiment, 'experiment.json');

  if (!fs.existsSync(experimentJsonPath)) {
    console.log('Warning: experiment.json not found, skipping provider validation');
    return;
  }

  const experimentConfig = JSON.parse(fs.readFileSync(experimentJsonPath, 'utf8'));
  const providers = getProvidersFromConfig(experimentConfig);

  console.log(`Checking environment for providers: ${providers.join(', ')}`);

  // Check AWS
  if (providers.includes('aws')) {
    if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
      console.error('ERROR: Error: AWS_REGION environment variable should be set');
      process.exit(1);
    }
    console.log(`[OK] AWS_REGION: ${process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION}`);
  }

  // Check Google Cloud
  if (providers.includes('google')) {
    if (!process.env.GOOGLE_REGION) {
      console.error('ERROR: Error: GOOGLE_REGION environment variable should be set');
      process.exit(1);
    }
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.error('ERROR: Error: GOOGLE_APPLICATION_CREDENTIALS environment variable should be set');
      process.exit(1);
    }
    if (!process.env.GOOGLE_PROJECT) {
      console.error('ERROR: Error: GOOGLE_PROJECT environment variable should be set');
      process.exit(1);
    }
    console.log(`[OK] GOOGLE_REGION: ${process.env.GOOGLE_REGION}`);
    console.log(`[OK] GOOGLE_PROJECT: ${process.env.GOOGLE_PROJECT}`);
  }

  // Set Terraform variables for all providers
  if (providers.includes('tinyfaas')) {
    process.env.TF_VAR_TINYFAAS_ADDRESS = process.env.TINYFAAS_ADDRESS || '';
    process.env.TF_VAR_TINYFAAS_MPORT = process.env.TINYFAAS_MPORT || '';
    process.env.TF_VAR_TINYFAAS_FPORT = process.env.TINYFAAS_FPORT || '';
    if (process.env.TINYFAAS_ADDRESS) {
      console.log(`[OK] TinyFaaS configured: ${process.env.TINYFAAS_ADDRESS}`);
    }
  }

  if (providers.includes('openfaas')) {
    process.env.TF_VAR_OPENFAAS_GATEWAY = process.env.OPENFAAS_GATEWAY || '';
    process.env.TF_VAR_OPENFAAS_USER = 'admin';
    process.env.TF_VAR_OPENFAAS_TOKEN = process.env.OPENFAAS_TOKEN || '';
    if (process.env.OPENFAAS_GATEWAY) {
      console.log(`[OK] OpenFaaS configured: ${process.env.OPENFAAS_GATEWAY}`);
    }
  }

  if (providers.includes('openwhisk')) {
    process.env.TF_VAR_OPENWHISK_EXTERNAL = process.env.OPENWHISK_EXTERNAL || '';
    if (process.env.OPENWHISK_EXTERNAL) {
      console.log(`[OK] OpenWhisk configured: ${process.env.OPENWHISK_EXTERNAL}`);
    }
  }

  if (process.env.DOCKERHUB_USER && !process.env.TF_VAR_DOCKERHUB_USER) {
    process.env.TF_VAR_DOCKERHUB_USER = process.env.DOCKERHUB_USER;
  }

  // Set Terraform config file
  const tfConfigPath = '/experiments/dev.tfrc';
  if (fs.existsSync(tfConfigPath)) {
    process.env.TF_CLI_CONFIG_FILE = tfConfigPath;
  }

  console.log('[OK] Environment validation completed');
}

function setHardwareConfig(config) {
  logSection('Configuring Hardware');

  // Set Lambda memory configuration for FaaS
  if (config.architecture === 'faas' && config.memory) {
    process.env.TF_VAR_memory_size = config.memory.toString();
    console.log(`[OK] Lambda memory configured: ${config.memory} MB`);
  }

  // Set Fargate CPU/Memory configuration for Monolith and Microservices
  if (config.architecture === 'monolith' || config.architecture === 'microservices') {
    if (config.cpu) {
      process.env.TF_VAR_cpu = config.cpu.toString();
      const vCPU = config.cpu / 1024;
      console.log(`[OK] Fargate CPU configured: ${config.cpu} units (${vCPU} vCPU)`);
    }
    if (config.memoryFargate) {
      process.env.TF_VAR_memory = config.memoryFargate.toString();
      console.log(`[OK] Fargate memory configured: ${config.memoryFargate} MB`);
    }

    // Scaling configuration
    process.env.TF_VAR_scaling_mode = config.scalingMode;
    process.env.TF_VAR_min_capacity = config.minCapacity.toString();
    process.env.TF_VAR_max_capacity = config.maxCapacity.toString();
    process.env.TF_VAR_scale_out_cooldown = config.scaleOutCooldown.toString();
    process.env.TF_VAR_scale_in_cooldown = config.scaleInCooldown.toString();
    process.env.TF_VAR_desired_count = config.desiredCount.toString();
    process.env.TF_VAR_target_request_count = config.targetRequestCount.toString();
    // Convert ms → seconds for Terraform (ALB TargetResponseTime metric is in seconds)
    process.env.TF_VAR_target_response_time = (config.targetResponseTime / 1000).toString();

    if (config.architecture === 'microservices') {
      process.env.TF_VAR_min_capacity_frontend = config.minCapacityFrontend.toString();
    }

    console.log(`[OK] Scaling mode: ${config.scalingMode}`);
    console.log(`[OK] Scaling capacity: min=${config.minCapacity}, max=${config.maxCapacity}, desired=${config.desiredCount}`);
    if (config.scalingMode === 'latency') {
      console.log(`[OK] Target response time: ${config.targetResponseTime} ms`);
    } else if (config.scalingMode === 'request_count') {
      console.log(`[OK] Target request count: ${config.targetRequestCount} req/target/min`);
    }
    console.log(`[OK] Cooldowns: scale-out=${config.scaleOutCooldown}s, scale-in=${config.scaleInCooldown}s`);
  }
}

function installTerraformProviders(experiment) {
  logSection('Installing Terraform Providers');

  const projectRoot = path.join(__dirname, '..', '..');

  // Check if the experiment actually needs custom providers (openfaas, tinyfaas, openwhisk).
  // These require building from source with Go and are only used for non-AWS platforms.
  const customProviders = ['openfaas', 'tinyfaas', 'openwhisk'];
  const experimentJsonPath = path.join(projectRoot, 'experiments', experiment, 'experiment.json');
  if (fs.existsSync(experimentJsonPath)) {
    const experimentConfig = JSON.parse(fs.readFileSync(experimentJsonPath, 'utf8'));
    const neededProviders = getProvidersFromConfig(experimentConfig);
    const neededCustom = neededProviders.filter(p => customProviders.includes(p));
    if (neededCustom.length === 0) {
      console.log('No custom Terraform providers needed for this experiment, skipping.');
      return;
    }
    console.log(`Custom providers needed: ${neededCustom.join(', ')}`);
  }

  const installScript = path.join(projectRoot, 'scripts', 'install-provider.sh');

  if (!fs.existsSync(installScript)) {
    console.log('Warning: install-provider.sh not found, skipping...');
    return;
  }

  try {
    console.log('Installing custom Terraform providers...');
    execSync(installScript, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: '/bin/bash'
    });
    console.log('[OK] Terraform providers installed');
  } catch (error) {
    console.error('ERROR: Failed to install Terraform providers:', error.message);
    throw error;
  }
}

module.exports = {
  getProvidersFromConfig,
  validateEnvironment,
  setHardwareConfig,
  installTerraformProviders
};
