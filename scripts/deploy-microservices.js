const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runTerraform, getTerraformOutputJson, hasState, getAwsAccountId, getVpcIdFromState, waitForInstancesTerminated, cleanupVpcNetworkInterfaces, cleanupVpcSecurityGroups, importOrphanedVpcResources, ensureCognitoDeployed } = require('./deploy-shared');

const SERVICES = [
  'frontend-service',
  'product-service',
  'cart-service',
  'order-service',
  'content-service'
];

async function deployMicroservices(experiment, buildDir) {
  console.log(`Deploying microservices architecture for experiment: ${experiment}`);

  const projectRoot = path.join(__dirname, '..');
  const awsRegion = process.env.AWS_REGION || 'us-east-1';

  try {
    // Step 1: Initialize experiment infrastructure
    console.log('\nStep 1: Initializing experiment infrastructure...');
    const expDir = path.join(projectRoot, 'infrastructure', 'experiment');
    runTerraform(expDir, 'init');
    runTerraform(expDir, 'apply', {
      vars: {
        experiment: experiment,
        project_prefix: 'befaas'
      }
    });

    // Step 2: Setup VPC
    console.log('\nStep 2: Setting up VPC...');
    const vpcDir = path.join(projectRoot, 'infrastructure', 'services', 'vpc');
    if (!fs.existsSync(vpcDir)) {
      throw new Error('VPC infrastructure not found at infrastructure/services/vpc');
    }

    runTerraform(vpcDir, 'init');
    importOrphanedVpcResources(vpcDir);
    runTerraform(vpcDir, 'apply');

    // Step 3: Setup Redis
    console.log('\nStep 3: Setting up Redis...');
    const redisDir = path.join(projectRoot, 'infrastructure', 'services', 'redisAws');
    if (!fs.existsSync(redisDir)) {
      throw new Error('Redis infrastructure not found at infrastructure/services/redisAws');
    }

    runTerraform(redisDir, 'init');
    runTerraform(redisDir, 'apply');

    // Ensure persistent Cognito pool is deployed
    ensureCognitoDeployed(projectRoot);

    // Step 4: Create ECR repositories via Terraform
    console.log('\nStep 4: Creating ECR repositories...');
    const microservicesDir = path.join(projectRoot, 'infrastructure', 'microservices', 'aws');

    if (!fs.existsSync(microservicesDir)) {
      throw new Error('Microservices infrastructure not found at infrastructure/microservices/aws');
    }

    // Get project name to construct ECR URLs
    const expOutput = getTerraformOutputJson(expDir);
    const projectName = expOutput.project_name?.value;
    if (!projectName) {
      throw new Error('Could not get project_name from experiment terraform output');
    }

    const accountId = getAwsAccountId();
    const ecrBaseUrl = `${accountId}.dkr.ecr.${awsRegion}.amazonaws.com`;

    // Create ECR repositories
    runTerraform(microservicesDir, 'init');

    // Create only ECR resources
    const ecrTargets = SERVICES.flatMap(service => [
      `aws_ecr_repository.service["${service}"]`,
      `aws_ecr_lifecycle_policy.service["${service}"]`
    ]);

    runTerraform(microservicesDir, 'apply', {
      vars: {
        aws_region: awsRegion,
        image_tag: 'initial'
      },
      targets: ecrTargets
    });

    // Step 5: Build and push Docker images for all services
    console.log('\nStep 5: Building and pushing Docker images...');
    const imageTag = Date.now().toString();

    // Login to ECR
    console.log('Logging into ECR...');
    execSync(
      `aws ecr get-login-password --region ${awsRegion} | docker login --username AWS --password-stdin ${ecrBaseUrl}`,
      { stdio: 'inherit' }
    );

    // Build and push each service
    for (const serviceName of SERVICES) {
      const serviceDir = path.join(buildDir, serviceName);
      const ecrRepoUrl = `${ecrBaseUrl}/${projectName}-${serviceName}`;

      if (!fs.existsSync(serviceDir)) {
        throw new Error(`Service directory not found: ${serviceDir}`);
      }

      console.log(`\nBuilding ${serviceName}...`);
      console.log(`  ECR Repository: ${ecrRepoUrl}`);

      // Build Docker image
      execSync(
        `docker build --platform linux/amd64 -t ${ecrRepoUrl}:${imageTag} -t ${ecrRepoUrl}:latest .`,
        { cwd: serviceDir, stdio: 'inherit' }
      );

      // Push Docker image
      console.log(`  Pushing ${serviceName}...`);
      execSync(`docker push ${ecrRepoUrl}:${imageTag}`, { stdio: 'inherit' });
      execSync(`docker push ${ecrRepoUrl}:latest`, { stdio: 'inherit' });
    }

    // Step 6: Deploy full infrastructure with the new images
    console.log('\nStep 6: Deploying ECS services...');
    const ecsVars = {
      aws_region: awsRegion,
      image_tag: imageTag
    };
    // Add edge public key if available
    if (process.env.EDGE_PUBLIC_KEY) {
      ecsVars.edge_public_key = process.env.EDGE_PUBLIC_KEY;
    }
    // Add JWT signing keys if available
    if (process.env.JWT_PRIVATE_KEY) {
      ecsVars.jwt_private_key = process.env.JWT_PRIVATE_KEY;
    }
    if (process.env.JWT_PUBLIC_KEY) {
      ecsVars.jwt_public_key = process.env.JWT_PUBLIC_KEY;
    }
    runTerraform(microservicesDir, 'apply', {
      vars: ecsVars
    });

    const output = getTerraformOutputJson(microservicesDir);
    const albUrl = output.alb_dns_name?.value;
    const healthUrl = output.health_url?.value;

    console.log('\n[OK] Microservices deployed to AWS ECS');
    if (albUrl) {
      console.log(`ALB URL: http://${albUrl}`);
      console.log(`Health URL: ${healthUrl}`);

      // Write endpoints to file for reference
      const endpointsFile = path.join(buildDir, 'endpoints.json');
      fs.writeFileSync(endpointsFile, JSON.stringify({
        alb_url: `http://${albUrl}`,
        health_url: healthUrl,
        services: SERVICES.map(s => ({
          name: s,
          ecr_repository: `${ecrBaseUrl}/${projectName}-${s}`
        })),
        image_tag: imageTag,
        cognito_user_pool_id: output.cognito_user_pool_id?.value,
        cognito_client_id: output.cognito_client_id?.value
      }, null, 2));

      return [healthUrl];
    }

    return [];

  } catch (error) {
    console.error('\nERROR: Microservices deployment failed:', error.message);
    throw error;
  }
}

async function destroyMicroservices(experiment) {
  console.log(`Destroying microservices deployment for experiment: ${experiment}`);

  const projectRoot = path.join(__dirname, '..');
  const awsRegion = process.env.AWS_REGION || 'us-east-1';

  const expDir = path.join(projectRoot, 'infrastructure', 'experiment');
  let projectName = null;
  try {
    const expOutput = getTerraformOutputJson(expDir);
    projectName = expOutput.project_name?.value;
  } catch (e) {
    console.log('Could not get project name, skipping ECS scale-down');
  }

  // Scale down ECS services to 0 first for faster cleanup
  if (projectName) {
    const clusterName = `${projectName}-microservices`;
    console.log(`Scaling down ECS services in cluster ${clusterName}...`);
    for (const serviceName of SERVICES) {
      try {
        execSync(
          `aws ecs update-service --cluster ${clusterName} --service ${serviceName} --desired-count 0 --region ${awsRegion}`,
          { stdio: 'pipe' }
        );
        console.log(`  [OK] Scaled down ${serviceName}`);
      } catch (e) {
        // Service might not exist, ignore
      }
    }
    // Wait a few seconds for tasks to start draining
    console.log('Waiting for tasks to drain (5s)...');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  // Destroy in reverse order
  const microservicesDir = path.join(projectRoot, 'infrastructure', 'microservices', 'aws');
  if (fs.existsSync(microservicesDir) && hasState(microservicesDir)) {
    console.log('Destroying microservices ECS infrastructure...');
    runTerraform(microservicesDir, 'destroy');
  }

  const redisDir = path.join(projectRoot, 'infrastructure', 'services', 'redisAws');
  if (fs.existsSync(redisDir) && hasState(redisDir)) {
    console.log('Destroying Redis...');
    runTerraform(redisDir, 'destroy');
  }

  const vpcDir = path.join(projectRoot, 'infrastructure', 'services', 'vpc');
  const vpcId = getVpcIdFromState(vpcDir);

  if (vpcId) {
    await waitForInstancesTerminated(vpcId, awsRegion, 120);
    await cleanupVpcNetworkInterfaces(vpcId, awsRegion);
    await cleanupVpcSecurityGroups(vpcId, awsRegion);
  }

  if (fs.existsSync(vpcDir) && hasState(vpcDir)) {
    console.log('Destroying VPC...');
    runTerraform(vpcDir, 'destroy');
  }

  console.log('[OK] Microservices infrastructure destroyed');
}

module.exports = { deployMicroservices, destroyMicroservices };
