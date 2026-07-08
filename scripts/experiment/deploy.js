const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { logSection } = require('./utils');

function isEdgeAuth(authMethod) {
  return authMethod === 'edge' || authMethod === 'edge-selective';
}

async function runDeploy(experiment, architecture, buildDir, authMethod, algorithm = null, reuseEdgeAuth = false, withCloudfront = false) {
  logSection(`Deploying ${experiment}/${architecture} architecture`);

  const selectiveEdge = authMethod === 'edge-selective';

  const protectedPaths = architecture === 'faas'
    ? ['/frontend/cart', '/frontend/addCartItem', '/frontend/emptyCart', '/frontend/checkout']
    : undefined;

  const jwksMode = process.env.EDGE_JWKS_MODE === 'buildtime' ? 'buildtime' : 'runtime';
  if (isEdgeAuth(authMethod)) {
    logSection(`Edge JWKS mode: ${jwksMode}`);
  }

  try {
    let endpoints = [];
    let edgeKeyPair = null;
    let reusingEdge = false;

    if (algorithm === 'argon2id-eddsa') {
      logSection('Preparing JWT Signing Keys (EdDSA)');

      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      });

      process.env.JWT_PRIVATE_KEY = Buffer.from(privateKey).toString('base64');
      process.env.JWT_PUBLIC_KEY = Buffer.from(publicKey).toString('base64');

      console.log('Generated Ed25519 key pair for JWT signing');
    }

    if (isEdgeAuth(authMethod)) {
      const { generateEd25519KeyPair, hasEdgeAuthState, getEdgeAuthState } = require('../deploy-edge-auth');

      if (reuseEdgeAuth && hasEdgeAuthState()) {
        const existingState = getEdgeAuthState();
        if (existingState) {
          logSection('Reusing Existing Edge Authentication Keys');
          console.log('Existing edge-auth state found, will update in-place after architecture deploy');
          console.log(`  Existing distribution: ${existingState.distributionId}`);

          process.env.EDGE_PUBLIC_KEY = existingState.publicKey;

          const projectRoot = path.join(__dirname, '..', '..');
          const edgeKeyFile = path.join(projectRoot, '.edge_public_key');
          fs.writeFileSync(edgeKeyFile, existingState.publicKey);
          console.log(`Edge public key saved to: ${edgeKeyFile}`);

          reusingEdge = true;
        }
      }

      if (!reusingEdge) {
        logSection('Preparing Edge Authentication Keys');

        edgeKeyPair = generateEd25519KeyPair();
        console.log('Generated new Ed25519 key pair');

        process.env.EDGE_PUBLIC_KEY = edgeKeyPair.publicKey;

        const projectRoot = path.join(__dirname, '..', '..');
        const edgeKeyFile = path.join(projectRoot, '.edge_public_key');
        fs.writeFileSync(edgeKeyFile, edgeKeyPair.publicKey);
        console.log(`Edge public key saved to: ${edgeKeyFile}`);
      }
    }

    switch (architecture) {
      case 'faas': {
        const { deployFaaS } = require('../deploy-faas');
        endpoints = await deployFaaS(experiment, buildDir);
        break;
      }

      case 'microservices': {
        const { deployMicroservices } = require('../deploy-microservices');
        endpoints = await deployMicroservices(experiment, buildDir);
        break;
      }

      case 'monolith': {
        const { deployMonolith } = require('../deploy-monolith');
        endpoints = await deployMonolith(experiment, buildDir);
        break;
      }

      default:
        throw new Error(`Unknown architecture: ${architecture}`);
    }

    if (isEdgeAuth(authMethod)) {
      const { deployEdgeAuth, updateEdgeAuth } = require('../deploy-edge-auth');

      if (endpoints.length === 0) {
        throw new Error('No endpoints available for edge auth deployment');
      }

      const originUrl = new URL(endpoints[0]);
      const originDomain = originUrl.hostname;

      const originProtocol = architecture === 'faas' ? 'https-only' : 'http-only';

      console.log(`Origin domain: ${originDomain}`);
      console.log(`Origin protocol: ${originProtocol}`);

      let edgeConfig;

      if (reusingEdge) {
        logSection('Updating Edge Authentication (in-place)');
        try {
          edgeConfig = await updateEdgeAuth(originDomain, {
            originProtocol,
            originHttpPort: 80,
            originHttpsPort: 443,
            selectiveEdgeRouting: selectiveEdge,
            protectedPaths,
            jwksMode
          });
        } catch (updateError) {
          console.warn('Warning: In-place edge-auth update failed:', updateError.message);
          console.log('Falling back to destroy + fresh deploy...');

          // Fall back to destroy + fresh deploy
          const { destroyEdgeAuth, generateEd25519KeyPair: genKeys } = require('../deploy-edge-auth');
          const fallbackProjectRoot = path.join(__dirname, '..', '..');
          const fallbackExperimentDir = path.join(fallbackProjectRoot, 'infrastructure', 'experiment');

          try {
            const fallbackProjectName = execSync('terraform output -raw project_name', {
              cwd: fallbackExperimentDir,
              encoding: 'utf8'
            }).trim();
            await destroyEdgeAuth(fallbackProjectName);
          } catch (destroyErr) {
            console.warn('Warning: Could not destroy edge auth during fallback:', destroyErr.message);
          }

          edgeKeyPair = genKeys();
          process.env.EDGE_PUBLIC_KEY = edgeKeyPair.publicKey;

          const projectName = execSync('terraform output -raw project_name', {
            cwd: fallbackExperimentDir,
            encoding: 'utf8'
          }).trim();

          edgeConfig = await deployEdgeAuth(projectName, originDomain, {
            originProtocol,
            originHttpPort: 80,
            originHttpsPort: 443,
            keyPair: edgeKeyPair,
            selectiveEdgeRouting: selectiveEdge,
            protectedPaths,
            jwksMode
          });
        }
      } else {
        // Create path: fresh deployment
        logSection('Deploying Edge Authentication');

        // Get the actual project name from terraform output (matches the infrastructure naming)
        const projectRoot = path.join(__dirname, '..', '..');
        const experimentInfraDir = path.join(projectRoot, 'infrastructure', 'experiment');
        const projectName = execSync('terraform output -raw project_name', {
          cwd: experimentInfraDir,
          encoding: 'utf8'
        }).trim();
        console.log(`Using project name from terraform: ${projectName}`);

        edgeConfig = await deployEdgeAuth(projectName, originDomain, {
          originProtocol,
          originHttpPort: 80,
          originHttpsPort: 443,
          keyPair: edgeKeyPair,  // Pass pre-generated keys
          selectiveEdgeRouting: selectiveEdge,
          protectedPaths,
          jwksMode
        });
      }

      // Replace endpoints with CloudFront URL + architecture-specific path for health checking
      let healthPath;
      if (architecture === 'faas') {
        // FaaS: API Gateway has no root route — only function-specific routes
        healthPath = '/frontend';
      } else if (architecture === 'monolith' || architecture === 'microservices') {
        // Monolith/Microservices: Health check endpoint is at /health
        healthPath = '/health';
      } else {
        // Default fallback for unknown architectures
        healthPath = '/health';
      }

      endpoints = [`${edgeConfig.cloudfrontUrl}${healthPath}`];

      // Store the CloudFront URL for workload.sh to use
      const projectRoot = path.join(__dirname, '..', '..');
      const edgeUrlFile = path.join(projectRoot, '.edge_cloudfront_url');
      fs.writeFileSync(edgeUrlFile, edgeConfig.cloudfrontUrl);

      console.log(`[OK] Edge authentication ${reusingEdge ? 'updated' : 'deployed'}`);
      console.log(`  CloudFront URL: ${edgeConfig.cloudfrontUrl}`);
      console.log(`  Health check URL: ${endpoints[0]}`);
    }

    // If --with-cloudfront and NOT edge auth, deploy CloudFront as passthrough proxy
    if (withCloudfront && !isEdgeAuth(authMethod)) {
      const { deployCloudfrontProxy } = require('../deploy-cloudfront-proxy');

      if (endpoints.length === 0) {
        throw new Error('No endpoints available for CloudFront proxy deployment');
      }

      const originUrl = new URL(endpoints[0]);
      const originDomain = originUrl.hostname;
      const originProtocol = architecture === 'faas' ? 'https-only' : 'http-only';

      console.log(`Origin domain: ${originDomain}`);
      console.log(`Origin protocol: ${originProtocol}`);

      logSection('Deploying CloudFront Proxy (passthrough)');

      const projectRoot = path.join(__dirname, '..', '..');
      const experimentInfraDir = path.join(projectRoot, 'infrastructure', 'experiment');
      const projectName = execSync('terraform output -raw project_name', {
        cwd: experimentInfraDir,
        encoding: 'utf8'
      }).trim();

      const proxyConfig = await deployCloudfrontProxy(projectName, originDomain, {
        originProtocol,
        originHttpPort: 80,
        originHttpsPort: 443
      });

      // Replace endpoints with CloudFront URL
      let healthPath;
      if (architecture === 'faas') {
        healthPath = '/frontend';
      } else {
        healthPath = '/health';
      }

      endpoints = [`${proxyConfig.cloudfrontUrl}${healthPath}`];

      // Store the CloudFront URL for workload.sh to use
      const edgeUrlFile = path.join(projectRoot, '.edge_cloudfront_url');
      fs.writeFileSync(edgeUrlFile, proxyConfig.cloudfrontUrl);

      console.log(`[OK] CloudFront proxy deployed`);
      console.log(`  CloudFront URL: ${proxyConfig.cloudfrontUrl}`);
      console.log(`  Health check URL: ${endpoints[0]}`);
    }

    console.log('[OK] Deployment completed');
    return endpoints;

  } catch (error) {
    console.error('[FAIL] Deployment failed:', error.message);
    throw error;
  }
}

async function runDestroy(experiment, architecture, authMethod, options = {}) {
  logSection(`Destroying ${experiment}/${architecture} infrastructure`);

  try {
    // Destroy CloudFront proxy first (if it exists)
    // Must be destroyed before the origin (API Gateway/ALB)
    if (options.withCloudfront) {
      try {
        const { destroyCloudfrontProxy, hasCloudfrontProxyState } = require('../deploy-cloudfront-proxy');
        if (hasCloudfrontProxyState()) {
          const projectRoot = path.join(__dirname, '..', '..');
          const experimentInfraDir = path.join(projectRoot, 'infrastructure', 'experiment');
          let projectName;
          try {
            projectName = execSync('terraform output -raw project_name', {
              cwd: experimentInfraDir,
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe']
            }).trim();
          } catch {
            projectName = `befaas-${experiment}`;
          }
          await destroyCloudfrontProxy(projectName);
        }
      } catch (proxyError) {
        console.warn('Warning: Could not destroy CloudFront proxy:', proxyError.message);
      }
    }

    // Destroy edge auth first (if it exists)
    // Edge auth must be destroyed before the origin (API Gateway/ALB)
    if (isEdgeAuth(authMethod)) {
      if (options.skipEdgeAuth) {
        console.log('Skipping edge auth destruction (--reuse-edge-auth or --keep-edge-auth)');
      } else {
        try {
          const { destroyEdgeAuth } = require('../deploy-edge-auth');
          // Get the project name from terraform state (if it exists)
          const projectRoot = path.join(__dirname, '..', '..');
          const experimentInfraDir = path.join(projectRoot, 'infrastructure', 'experiment');
          let projectName;
          try {
            projectName = execSync('terraform output -raw project_name', {
              cwd: experimentInfraDir,
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe']
            }).trim();
          } catch {
            // Fallback if terraform state doesn't exist
            projectName = `befaas-${experiment}`;
          }
          await destroyEdgeAuth(projectName);
        } catch (edgeError) {
          console.warn('Warning: Could not destroy edge auth:', edgeError.message);
          // Continue with main infrastructure destruction
        }
      }
    }

    switch (architecture) {
      case 'faas': {
        const { destroyFaaS } = require('../deploy-faas');
        await destroyFaaS(experiment);
        break;
      }

      case 'microservices': {
        const { destroyMicroservices } = require('../deploy-microservices');
        await destroyMicroservices(experiment);
        break;
      }

      case 'monolith': {
        const { destroyMonolith } = require('../deploy-monolith');
        await destroyMonolith(experiment);
        break;
      }

      default:
        throw new Error(`Unknown architecture: ${architecture}`);
    }

    console.log('[OK] Infrastructure destroyed successfully');

  } catch (error) {
    console.error('[FAIL] Destroy failed:', error.message);
    throw error;
  }
}

async function resetCognitoUserPool(force = false) {
  if (!force) {
    console.log('Skipping Cognito User Pool reset (users are pre-registered)');
    return;
  }

  logSection('Resetting Cognito User Pool');

  const projectRoot = path.join(__dirname, '..', '..');
  const awsDir = path.join(projectRoot, 'infrastructure', 'aws');

  // Check if Cognito resources exist in state
  try {
    const stateList = execSync('terraform state list', {
      cwd: awsDir,
      encoding: 'utf8'
    });

    const cognitoResources = [
      'aws_cognito_user_pool.main',
      'aws_cognito_user_pool_client.main',
      'aws_cognito_user_pool_domain.main'
    ];

    const existingResources = cognitoResources.filter(r => stateList.includes(r));

    if (existingResources.length === 0) {
      console.log('No Cognito resources found in state, skipping reset');
      return;
    }

    // Taint Cognito resources to force recreation
    console.log('Tainting Cognito resources for recreation...');
    for (const resource of existingResources) {
      try {
        execSync(`terraform taint ${resource}`, {
          cwd: awsDir,
          stdio: 'pipe'
        });
        console.log(`  [OK] Tainted: ${resource}`);
      } catch (error) {
        console.log(`  Warning: Could not taint ${resource}: ${error.message}`);
      }
    }

    // Apply to recreate the tainted resources
    console.log('\nRecreating Cognito resources...');
    execSync('terraform apply -auto-approve', {
      cwd: awsDir,
      stdio: 'inherit'
    });

    console.log('[OK] Cognito User Pool reset successfully');

  } catch (error) {
    console.error('Warning: Failed to reset Cognito User Pool:', error.message);
    console.log('Continuing with existing Cognito configuration...');
  }
}

async function forceDestroyRedis(experiment) {
  logSection('Force Destroying Redis Containers');

  const projectRoot = path.join(__dirname, '..', '..');

  // Check if experiment.json exists
  const experimentJsonPath = path.join(projectRoot, 'experiments', experiment, 'experiment.json');
  if (!fs.existsSync(experimentJsonPath)) {
    console.log('No experiment.json found, skipping Redis force destroy...');
    return;
  }

  const experimentConfig = JSON.parse(fs.readFileSync(experimentJsonPath, 'utf8'));

  // Only proceed if Redis service is configured
  if (!experimentConfig.services || !experimentConfig.services.redisAws) {
    console.log('No Redis AWS service configured, skipping...');
    return;
  }

  const redisDir = path.join(projectRoot, 'infrastructure', 'services', 'redisAws');

  // Check if Redis infrastructure state exists
  const redisStateFile = path.join(redisDir, 'terraform.tfstate');
  if (!fs.existsSync(redisStateFile)) {
    console.log('No Redis Terraform state found, skipping...');
    return;
  }

  try {
    // Ensure providers are installed before reading state
    if (!fs.existsSync(path.join(redisDir, '.terraform'))) {
      console.log('Initializing Terraform providers for redisAws...');
      execSync('terraform init', { cwd: redisDir, stdio: 'inherit' });
    }

    // Get Redis instance information from Terraform state
    console.log('Getting Redis instance information...');
    const stateData = execSync('terraform show -json', {
      cwd: redisDir,
      encoding: 'utf8'
    });

    const state = JSON.parse(stateData);
    const redisInstances = [];

    // Find Redis instances in the state
    if (state.values && state.values.root_module && state.values.root_module.resources) {
      for (const resource of state.values.root_module.resources) {
        if (resource.type === 'aws_instance' && resource.name === 'redis' && resource.values) {
          redisInstances.push({
            publicIp: resource.values.public_ip,
            privateKey: resource.values.private_key || null
          });
        }
      }
    }

    if (redisInstances.length === 0) {
      console.log('No Redis instances found in Terraform state');
      return;
    }

    // Get SSH private key from VPC state
    const vpcDir = path.join(projectRoot, 'infrastructure', 'services', 'vpc');
    let privateKey = null;

    if (fs.existsSync(vpcDir)) {
      try {
        if (!fs.existsSync(path.join(vpcDir, '.terraform'))) {
          execSync('terraform init', { cwd: vpcDir, stdio: 'inherit' });
        }
        const vpcOutput = execSync('terraform output -json ssh_private_key', {
          cwd: vpcDir,
          encoding: 'utf8'
        });
        privateKey = JSON.parse(vpcOutput);
      } catch (error) {
        console.warn('Could not get SSH private key from VPC state:', error.message);
      }
    }

    // Force destroy containers on each Redis instance
    for (const instance of redisInstances) {
      console.log(`Attempting to force destroy containers on Redis instance ${instance.publicIp}...`);

      if (!instance.publicIp) {
        console.warn('No public IP found for Redis instance, skipping...');
        continue;
      }

      try {
        // Create temporary SSH key file if we have the private key
        const tempDir = fs.mkdtempSync(path.join(__dirname, 'temp-ssh-'));
        const keyFile = path.join(tempDir, 'key.pem');

        if (privateKey) {
          fs.writeFileSync(keyFile, privateKey, { mode: 0o600 });
        } else {
          console.warn('No SSH private key available, cannot connect to Redis instance');
          continue;
        }

        // Execute Docker stop and remove commands via SSH
        const sshCommands = [
          'sudo docker stop befaas-redis || true',
          'sudo docker rm befaas-redis || true',
          'sudo docker system prune -f || true'
        ];

        for (const command of sshCommands) {
          try {
            console.log(`  Running: ${command}`);
            execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "${keyFile}" ubuntu@${instance.publicIp} "${command}"`, {
              timeout: 30000,
              stdio: 'pipe'
            });
            console.log(`  [OK] ${command} completed`);
          } catch (error) {
            console.log(`  Warning: ${command} failed: ${error.message}`);
          }
        }

        // Cleanup temp files
        fs.rmSync(tempDir, { recursive: true, force: true });

        console.log(`[OK] Force destroy completed for ${instance.publicIp}`);

      } catch (error) {
        console.warn(`Failed to force destroy containers on ${instance.publicIp}:`, error.message);
      }
    }

    // Also try to terminate instances directly via AWS CLI if available
    console.log('Attempting to terminate Redis instances via AWS CLI...');
    try {
      const instanceIds = [];

      // Get instance IDs from Terraform output
      try {
        const instanceId = execSync('terraform output -raw redis_instance_id', {
          cwd: redisDir,
          encoding: 'utf8'
        }).trim();

        if (instanceId && instanceId !== 'null') {
          instanceIds.push(instanceId);
        }
      } catch (error) {
        // Instance ID output might not exist, try to get it from state
        for (const resource of state.values.root_module.resources) {
          if (resource.type === 'aws_instance' && resource.name === 'redis' && resource.values.id) {
            instanceIds.push(resource.values.id);
          }
        }
      }

      if (instanceIds.length > 0) {
        console.log(`Found instance IDs: ${instanceIds.join(', ')}`);
        const awsRegion = process.env.AWS_REGION || 'us-east-1';

        for (const instanceId of instanceIds) {
          try {
            execSync(`aws ec2 terminate-instances --instance-ids ${instanceId} --region ${awsRegion}`, {
              timeout: 10000,
              stdio: 'pipe'
            });
            console.log(`  [OK] Initiated termination for instance ${instanceId}`);
          } catch (error) {
            console.log(`  Warning: Failed to terminate instance ${instanceId}: ${error.message}`);
          }
        }

        // Wait for instances to actually terminate (prevents VPC deletion issues)
        console.log('Waiting for Redis instances to fully terminate...');
        const maxWaitMs = 180000; // 3 minutes max wait
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitMs) {
          try {
            const result = execSync(
              `aws ec2 describe-instances --instance-ids ${instanceIds.join(' ')} --query "Reservations[*].Instances[*].State.Name" --output text --region ${awsRegion}`,
              { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();

            const states = result.split(/\s+/).filter(s => s);
            const nonTerminated = states.filter(s => s !== 'terminated');

            if (nonTerminated.length === 0) {
              console.log('  [OK] All Redis instances terminated');
              break;
            }

            console.log(`  Waiting for ${nonTerminated.length} instance(s) to terminate (current states: ${states.join(', ')})...`);
            await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10s between checks
          } catch (error) {
            // Instances might not exist anymore, which is fine
            console.log('  [OK] Instances no longer exist');
            break;
          }
        }
      }

    } catch (error) {
      console.warn('Could not terminate instances via AWS CLI:', error.message);
    }

    console.log('[OK] Redis force destroy completed');

  } catch (error) {
    console.warn('Redis force destroy failed:', error.message);
  }
}

module.exports = {
  runDeploy,
  runDestroy,
  resetCognitoUserPool,
  forceDestroyRedis
}
