const fs = require('fs');
const path = require('path');
const { createZip, installDependencies } = require('../experiments/webservice/architectures/shared/buildUtils');
const { runTerraform, getTerraformOutputJson, getTerraformOutput, getVpcIdFromState, cleanupVpcSecurityGroups, importOrphanedVpcResources, ensureCognitoDeployed } = require('./deploy-shared');

async function deployFaaS(experiment, buildDir) {
  console.log(`Deploying FaaS architecture for experiment: ${experiment}`);

  const projectRoot = path.join(__dirname, '..');

  // Check if experiment.json exists
  const experimentJsonPath = path.join(projectRoot, 'experiments', experiment, 'experiment.json');
  if (!fs.existsSync(experimentJsonPath)) {
    throw new Error(`experiment.json not found at ${experimentJsonPath}`);
  }

  const experimentConfig = JSON.parse(fs.readFileSync(experimentJsonPath, 'utf8'));
  const providers = getProvidersFromConfig(experimentConfig);

  console.log(`Found providers: ${providers.join(', ')}`);

  // Generate build timestamp
  const buildTimestamp = new Date().toISOString();
  const buildTimestampFile = path.join(projectRoot, '.build_timestamp');
  fs.writeFileSync(buildTimestampFile, buildTimestamp);

  const endpoints = [];

  try {
    // Step 0: Prepare function zip files
    console.log('\nStep 0: Preparing function zip files...');
    prepareFunctionZips(projectRoot, experiment, buildDir, experimentConfig);

    // Step 1: Deploy experiment infrastructure
    console.log('\nStep 1: Deploying experiment infrastructure...');
    const experimentInfraDir = path.join(projectRoot, 'infrastructure', 'experiment');
    runTerraform(experimentInfraDir, 'init');
    runTerraform(experimentInfraDir, 'apply', {
      vars: {
        experiment: experiment,
        build_timestamp: buildTimestamp
      }
    });

    const deploymentId = getTerraformOutput(experimentInfraDir, 'deployment_id');
    console.log(`Deployment ID: ${deploymentId}`);

    // Step 2: Initialize provider endpoints
    console.log('\nStep 2: Initializing provider endpoints...');
    const states = {};
    for (const provider of providers) {
      const endpointDir = path.join(projectRoot, 'infrastructure', provider, 'endpoint');
      if (fs.existsSync(endpointDir)) {
        console.log(`Initializing ${provider} endpoint...`);
        runTerraform(endpointDir, 'init');
        runTerraform(endpointDir, 'apply');

        const output = getTerraformOutputJson(endpointDir);
        Object.assign(states, output);
      }
    }

    // Step 3: Setup services
    if (experimentConfig.services && Object.keys(experimentConfig.services).length > 0) {
      console.log('\nStep 3: Setting up services...');

      // Setup VPC
      const vpcDir = path.join(projectRoot, 'infrastructure', 'services', 'vpc');
      if (fs.existsSync(vpcDir)) {
        console.log('Setting up VPC...');
        runTerraform(vpcDir, 'init');
        importOrphanedVpcResources(vpcDir);
        runTerraform(vpcDir, 'apply');
      }

      // Setup each service
      for (const service of Object.keys(experimentConfig.services)) {
        if (service === 'workload') continue;

        const serviceDir = path.join(projectRoot, 'infrastructure', 'services', service);
        if (fs.existsSync(serviceDir)) {
          console.log(`Starting service ${service}...`);
          runTerraform(serviceDir, 'init');
          runTerraform(serviceDir, 'apply');

          const output = getTerraformOutputJson(serviceDir);
          Object.assign(states, output);
        }
      }
    }

    // Step 4: Prepare function environment variables
    const fnEnv = extractEndpoints(states);
    console.log('\nFunction environment variables:', fnEnv);

    // Ensure persistent Cognito pool is deployed
    ensureCognitoDeployed(projectRoot);

    // Step 5: Deploy functions to providers
    console.log('\nStep 4: Deploying functions to providers...');
    for (const provider of providers) {
      const providerDir = path.join(projectRoot, 'infrastructure', provider);
      if (fs.existsSync(providerDir) && !providerDir.includes('endpoint')) {
        console.log(`Deploying to ${provider}...`);

        // Set environment variable for function env
        process.env.TF_VAR_fn_env = JSON.stringify(fnEnv);

        // Set edge public key if available
        if (process.env.EDGE_PUBLIC_KEY) {
          process.env.TF_VAR_edge_public_key = process.env.EDGE_PUBLIC_KEY;
        }

        // Set JWT signing keys if available
        if (process.env.JWT_PRIVATE_KEY) {
          process.env.TF_VAR_jwt_private_key = process.env.JWT_PRIVATE_KEY;
        }
        if (process.env.JWT_PUBLIC_KEY) {
          process.env.TF_VAR_jwt_public_key = process.env.JWT_PUBLIC_KEY;
        }

        runTerraform(providerDir, 'init');
        runTerraform(providerDir, 'apply');

        // Get provider endpoints for health checking
        const providerOutput = getTerraformOutputJson(providerDir);
        for (const [key, value] of Object.entries(providerOutput)) {
          if (key.includes('endpoint') || key.includes('url')) {
            const endpoint = value.value || value;
            if (endpoint && (endpoint.startsWith('http://') || endpoint.startsWith('https://'))) {
              endpoints.push(`${endpoint}/frontend`);
            }
          }
        }
      }
    }

    console.log('\n[OK] FaaS deployment completed successfully');
    console.log(`Deployed ${endpoints.length} endpoints`);

    return endpoints;

  } catch (error) {
    console.error('\nERROR: FaaS deployment failed:', error.message);
    throw error;
  }
}

async function destroyFaaS(experiment) {
  console.log(`Destroying FaaS infrastructure for experiment: ${experiment}`);

  const projectRoot = path.join(__dirname, '..');
  const awsRegion = process.env.AWS_REGION || 'us-east-1';
  const experimentJsonPath = path.join(projectRoot, 'experiments', experiment, 'experiment.json');

  if (!fs.existsSync(experimentJsonPath)) {
    console.log('No experiment.json found, skipping...');
    return;
  }

  const experimentConfig = JSON.parse(fs.readFileSync(experimentJsonPath, 'utf8'));
  const providers = getProvidersFromConfig(experimentConfig);

  // Force destroy Redis containers first
  if (experimentConfig.services && experimentConfig.services.redisAws) {
    console.log('Force destroying Redis containers before infrastructure destruction...');
    try {
      const { forceDestroyRedis } = require('./experiment/deploy');
      await forceDestroyRedis(experiment);
    } catch (error) {
      console.warn('Warning: Redis force destroy failed:', error.message);
    }
  }

  // Set empty fn_env for destroy operations
  process.env.TF_VAR_fn_env = JSON.stringify({});

  // Destroy providers first
  for (const provider of providers) {
    const providerDir = path.join(projectRoot, 'infrastructure', provider);
    if (fs.existsSync(providerDir)) {
      console.log(`Destroying ${provider}...`);
      try {
        runTerraform(providerDir, 'destroy', { autoApprove: true });
      } catch (error) {
        console.warn(`Warning: Failed to destroy ${provider}:`, error.message);
      }
    }
  }

  // Destroy services
  if (experimentConfig.services && Object.keys(experimentConfig.services).length > 0) {
    const services = Object.keys(experimentConfig.services).filter(s => s !== 'workload');

    // Destroy each service
    for (const service of services) {
      const serviceDir = path.join(projectRoot, 'infrastructure', 'services', service);
      if (fs.existsSync(serviceDir)) {
        console.log(`Destroying service ${service}...`);
        try {
          runTerraform(serviceDir, 'destroy', { autoApprove: true });
        } catch (error) {
          console.warn(`Warning: Failed to destroy ${service}:`, error.message);
        }
      }
    }

    // Destroy VPC last
    const vpcDir = path.join(projectRoot, 'infrastructure', 'services', 'vpc');
    const vpcId = getVpcIdFromState(vpcDir);
    if (fs.existsSync(vpcDir)) {
      console.log('Destroying VPC...');
      try {
        runTerraform(vpcDir, 'destroy', { autoApprove: true });
      } catch (error) {
        console.warn(`Warning: Failed to destroy VPC:`, error.message);
      }
    }
    // Cleanup any orphaned security groups that survived terraform destroy
    if (vpcId) {
      await cleanupVpcSecurityGroups(vpcId, awsRegion);
    }
  }

  console.log('[OK] FaaS infrastructure destroyed');
}

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

function extractEndpoints(states) {
  const endpoints = {};
  for (const [key, value] of Object.entries(states)) {
    if (key.endsWith('ENDPOINT') || key.endsWith('_endpoint')) {
      endpoints[key] = value.value || value;
    }
  }
  return endpoints;
}

function prepareFunctionZips(projectRoot, experiment, buildDir, experimentConfig) {
  const targetBuildDir = path.join(projectRoot, 'experiments', experiment, 'functions', '_build');

  if (!fs.existsSync(targetBuildDir)) {
    fs.mkdirSync(targetBuildDir, { recursive: true });
  }

  if (!fs.existsSync(buildDir)) {
    throw new Error(`Build directory not found: ${buildDir}. Did you run the build step?`);
  }

  const functionDirs = fs.readdirSync(buildDir).filter(file => {
    const fullPath = path.join(buildDir, file);
    return fs.statSync(fullPath).isDirectory();
  });

  console.log(`Found ${functionDirs.length} functions to package: ${functionDirs.join(', ')}`);

  for (const functionName of functionDirs) {
    const functionDir = path.join(buildDir, functionName);
    const zipPath = path.join(targetBuildDir, `${functionName}.zip`);

    console.log(`\nProcessing function: ${functionName}`);

    if (fs.existsSync(path.join(functionDir, 'package.json'))) {
      try {
        installDependencies(functionDir, true);
      } catch (error) {
        console.warn(`  Warning: Failed to install dependencies for ${functionName}: ${error.message}`);
      }
    }

    const befaasLogPath = path.join(functionDir, 'node_modules', '@befaas', 'lib', 'log.js');
    if (fs.existsSync(befaasLogPath)) {
      const silentLog = `const fnName = process.env.BEFAAS_FN_NAME || 'unknownFn'
function log() {}
module.exports = log
module.exports.fnName = fnName
`;
      fs.writeFileSync(befaasLogPath, silentLog, 'utf8');
      console.log(`  [OK] Silenced @befaas/lib logging for ${functionName}`);
    }

    createZip(functionDir, zipPath);
  }

  console.log(`\n[OK] All function zips created in ${targetBuildDir}`);
}

module.exports = { deployFaaS, destroyFaaS };
