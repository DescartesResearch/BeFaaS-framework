const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runTerraform, getTerraformOutputJson, hasState, getAwsAccountId, getVpcIdFromState, waitForInstancesTerminated, cleanupVpcNetworkInterfaces, cleanupVpcSecurityGroups, importOrphanedVpcResources, ensureCognitoDeployed } = require('./deploy-shared');

async function deployMonolith(experiment, buildDir) {
  console.log(`Deploying monolith architecture for experiment: ${experiment}`);

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

    // Step 4: Create ECR repository via Terraform
    console.log('\nStep 4: Creating ECR repository...');
    const monolithDir = path.join(projectRoot, 'infrastructure', 'monolith', 'aws');

    if (!fs.existsSync(monolithDir)) {
      throw new Error('Monolith infrastructure not found at infrastructure/monolith/aws');
    }

    // Get project name to construct ECR URL
    const expOutput = getTerraformOutputJson(expDir);
    const projectName = expOutput.project_name?.value;
    if (!projectName) {
      throw new Error('Could not get project_name from experiment terraform output');
    }

    const accountId = getAwsAccountId();
    const ecrRepoUrl = `${accountId}.dkr.ecr.${awsRegion}.amazonaws.com/${projectName}-monolith`;

    // Create ECR repository first
    runTerraform(monolithDir, 'init');
    runTerraform(monolithDir, 'apply', {
      vars: {
        aws_region: awsRegion,
        image_tag: 'initial'
      },
      targets: ['aws_ecr_repository.monolith', 'aws_ecr_lifecycle_policy.monolith']
    });

    // Step 5: Build and push Docker image
    console.log('\nStep 5: Building and pushing Docker image...');
    const imageTag = Date.now().toString();

    console.log(`ECR Repository URL: ${ecrRepoUrl}`);
    console.log(`Image Tag: ${imageTag}`);

    // Login to ECR
    console.log('Logging into ECR...');
    execSync(
      `aws ecr get-login-password --region ${awsRegion} | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.${awsRegion}.amazonaws.com`,
      { stdio: 'inherit' }
    );

    // Build Docker image from the build directory
    console.log('Building Docker image...');
    execSync(
      `docker build --platform linux/amd64 -t ${ecrRepoUrl}:${imageTag} -t ${ecrRepoUrl}:latest .`,
      { cwd: buildDir, stdio: 'inherit' }
    );

    // Push Docker image
    console.log('Pushing Docker image...');
    execSync(
      `docker push ${ecrRepoUrl}:${imageTag}`,
      { stdio: 'inherit' }
    );
    execSync(
      `docker push ${ecrRepoUrl}:latest`,
      { stdio: 'inherit' }
    );

    // Step 6: Deploy full infrastructure with the new image
    console.log('\nStep 6: Deploying ECS service...');
    const ecsVars = {
      aws_region: awsRegion,
      image_tag: imageTag
    };
    if (process.env.EDGE_PUBLIC_KEY) {
      ecsVars.edge_public_key = process.env.EDGE_PUBLIC_KEY;
    }
    if (process.env.JWT_PRIVATE_KEY) {
      ecsVars.jwt_private_key = process.env.JWT_PRIVATE_KEY;
    }
    if (process.env.JWT_PUBLIC_KEY) {
      ecsVars.jwt_public_key = process.env.JWT_PUBLIC_KEY;
    }
    runTerraform(monolithDir, 'apply', {
      vars: ecsVars
    });

    const output = getTerraformOutputJson(monolithDir);
    const albUrl = output.alb_dns_name?.value;
    const healthUrl = output.health_url?.value;

    console.log('\n[OK] Monolith deployed to AWS ECS');
    if (albUrl) {
      console.log(`ALB URL: http://${albUrl}`);
      console.log(`Health URL: ${healthUrl}`);

      // Write endpoints to file for reference
      const endpointsFile = path.join(buildDir, 'endpoints.json');
      fs.writeFileSync(endpointsFile, JSON.stringify({
        alb_url: `http://${albUrl}`,
        health_url: healthUrl,
        ecr_repository: ecrRepoUrl,
        image_tag: imageTag
      }, null, 2));

      return [healthUrl];
    }

    return [];

  } catch (error) {
    console.error('\nERROR: Monolith deployment failed:', error.message);
    throw error;
  }
}

async function destroyMonolith(experiment) {
  console.log(`Destroying monolith deployment for experiment: ${experiment}`);

  const projectRoot = path.join(__dirname, '..');
  const awsRegion = process.env.AWS_REGION || 'us-east-1';

  // Get project name for ECS cluster identification
  const expDir = path.join(projectRoot, 'infrastructure', 'experiment');
  let projectName = null;
  try {
    const expOutput = getTerraformOutputJson(expDir);
    projectName = expOutput.project_name?.value;
  } catch (e) {
    console.log('Could not get project name, skipping ECS scale-down');
  }

  // Scale down ECS service to 0 first
  if (projectName) {
    const clusterName = `${projectName}-monolith`;
    console.log(`Scaling down ECS service in cluster ${clusterName}...`);
    try {
      execSync(
        `aws ecs update-service --cluster ${clusterName} --service monolith --desired-count 0 --region ${awsRegion}`,
        { stdio: 'pipe' }
      );
      console.log('  [OK] Scaled down monolith service');
    } catch (e) {
      // Service might not exist, ignore
    }
    console.log('Waiting for tasks to drain (5s)...');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  const monolithDir = path.join(projectRoot, 'infrastructure', 'monolith', 'aws');
  if (fs.existsSync(monolithDir) && hasState(monolithDir)) {
    console.log('Destroying monolith ECS infrastructure...');
    runTerraform(monolithDir, 'destroy');
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

  console.log('[OK] Monolith infrastructure destroyed');
}

module.exports = { deployMonolith, destroyMonolith };
