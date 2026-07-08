#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
  DescribeUserPoolCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const projectRoot = path.join(__dirname, '..');
const usersFile = path.join(projectRoot, 'artillery', 'users.csv');

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { limit: null, batchSize: 10 };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--limit':
      case '-l':
        config.limit = parseInt(args[++i], 10);
        break;
      case '--batch-size':
      case '-b':
        config.batchSize = parseInt(args[++i], 10);
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
    }
  }

  return config;
}

function printUsage() {
  console.log(`
Usage: node scripts/preregister-cognito.js [options]

Options:
  --limit, -l       Limit number of users to register (default: all)
  --batch-size, -b  Number of concurrent registrations (default: 10)
  --help, -h        Show help

Examples:
  node scripts/preregister-cognito.js
  node scripts/preregister-cognito.js --limit 100
  node scripts/preregister-cognito.js --batch-size 20
`);
}

function getCognitoConfig() {
  const cognitoDir = path.join(projectRoot, 'infrastructure', 'services', 'cognito');
  const awsDir = path.join(projectRoot, 'infrastructure', 'aws');

  try {
    const output = execSync('terraform output -json', {
      cwd: cognitoDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const outputs = JSON.parse(output);

    const userPoolId = outputs.cognito_user_pool_id?.value ||
                       outputs.COGNITO_USER_POOL_ID?.value;
    const clientId = outputs.cognito_client_id?.value ||
                     outputs.COGNITO_CLIENT_ID?.value;

    if (userPoolId && clientId) {
      console.log('Using persistent Cognito pool from services/cognito');
      return { userPoolId, clientId };
    }
  } catch (error) {
    // Persistent pool not deployed, try AWS infrastructure
  }

  // Fall back to per-experiment Cognito pool
  try {
    const output = execSync('terraform output -json', {
      cwd: awsDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const outputs = JSON.parse(output);

    const userPoolId = outputs.cognito_user_pool_id?.value ||
                       outputs.COGNITO_USER_POOL_ID?.value;
    const clientId = outputs.cognito_client_id?.value ||
                     outputs.COGNITO_CLIENT_ID?.value;

    if (!userPoolId || !clientId) {
      throw new Error('Could not find Cognito User Pool ID or Client ID in Terraform outputs');
    }

    console.log('Using per-experiment Cognito pool from infrastructure/aws');
    return { userPoolId, clientId };
  } catch (error) {
    console.error('No Cognito infrastructure found.');
    console.error('This script will attempt to deploy Cognito during validation.');
    console.error('If that fails, deploy manually:');
    console.error('  cd infrastructure/services/cognito && terraform init && terraform apply');
    console.error('Error:', error.message);
    process.exit(1);
  }
}

async function validateUserPoolExists(cognitoClient, userPoolId) {
  try {
    await cognitoClient.send(new DescribeUserPoolCommand({
      UserPoolId: userPoolId
    }));
    return true;
  } catch (error) {
    if (error.name === 'ResourceNotFoundException' || error.message.includes('does not exist')) {
      return false;
    }
    throw error; // Re-throw other errors
  }
}

async function deployCognitoWhenNeeded(region) {
  const cognitoDir = path.join(projectRoot, 'infrastructure', 'services', 'cognito');

  console.log('User pool does not exist in AWS. Deploying persistent Cognito pool...');

  try {
    if (fs.existsSync(path.join(cognitoDir, 'main.tf'))) {
      console.log('  Initializing and deploying persistent Cognito pool...');
      execSync('terraform init', { cwd: cognitoDir, stdio: 'pipe' });
      execSync('terraform apply -auto-approve', { cwd: cognitoDir, stdio: 'inherit' });
      console.log('  ✅ Persistent Cognito pool deployed successfully');

      const output = execSync('terraform output -json', {
        cwd: cognitoDir,
        encoding: 'utf8'
      });

      const outputs = JSON.parse(output);
      const userPoolId = outputs.cognito_user_pool_id?.value ||
                         outputs.COGNITO_USER_POOL_ID?.value;
      const clientId = outputs.cognito_client_id?.value ||
                       outputs.COGNITO_CLIENT_ID?.value;

      if (userPoolId && clientId) {
        console.log('  📋 New Cognito configuration:');
        console.log(`    User Pool ID: ${userPoolId}`);
        console.log(`    Client ID: ${clientId}`);
        return { userPoolId, clientId };
      } else {
        throw new Error('Failed to get valid Cognito configuration after deployment');
      }
    } else {
      throw new Error('Persistent Cognito terraform files not found');
    }
  } catch (deployError) {
    console.error('Failed to deploy persistent Cognito pool:', deployError.message);
    throw deployError;
  }
}

function getAwsRegion() {
  if (process.env.AWS_REGION) {
    return process.env.AWS_REGION;
  }

  const experimentDir = path.join(projectRoot, 'infrastructure', 'experiment');
  try {
    const output = execSync('terraform output -raw aws_region 2>/dev/null || echo "us-east-1"', {
      cwd: experimentDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return output.trim() || 'us-east-1';
  } catch {
    return 'us-east-1';
  }
}

function parseUsersCSV(limit = null) {
  const content = fs.readFileSync(usersFile, 'utf8');
  const lines = content.trim().split('\n');
  const header = lines[0].split(',');

  const userNameIndex = header.indexOf('userName');
  const passwordIndex = header.indexOf('password');

  if (userNameIndex === -1 || passwordIndex === -1) {
    throw new Error('users.csv must have userName and password columns');
  }

  const users = [];
  const maxLines = limit ? Math.min(limit + 1, lines.length) : lines.length;

  for (let i = 1; i < maxLines; i++) {
    const fields = lines[i].split(',');
    if (fields.length > Math.max(userNameIndex, passwordIndex)) {
      users.push({
        userName: fields[userNameIndex],
        password: fields[passwordIndex]
      });
    }
  }

  return users;
}

async function registerUser(cognitoClient, userPoolId, userName, password) {
  try {
    await cognitoClient.send(new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: userName
    }));
    return { status: 'exists' };
  } catch (error) {
    if (error.name !== 'UserNotFoundException') {
      throw error;
    }
  }

  try {
    await cognitoClient.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: userName,
      TemporaryPassword: password,
      MessageAction: 'SUPPRESS',
    }));
  } catch (error) {
    if (error.name === 'UsernameExistsException') {
      return { status: 'exists' };
    }
    throw error;
  }

  await cognitoClient.send(new AdminSetUserPasswordCommand({
    UserPoolId: userPoolId,
    Username: userName,
    Password: password,
    Permanent: true
  }));

  return { status: 'registered', password };
}

async function registerUsersInBatches(cognitoClient, userPoolId, users, batchSize) {
  let registered = 0;
  let alreadyExists = 0;
  let failed = 0;

  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, Math.min(i + batchSize, users.length));

    const results = await Promise.allSettled(
      batch.map(user => registerUser(cognitoClient, userPoolId, user.userName, user.password))
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const user = batch[j];

      if (result.status === 'fulfilled') {
        if (result.value.status === 'registered') {
          registered++;
        } else if (result.value.status === 'exists') {
          alreadyExists++;
        }
      } else {
        failed++;
        console.error(`\nFailed to register ${user.userName}: ${result.reason?.message || result.reason}`);
      }
    }

    const progress = Math.min(i + batchSize, users.length);
    process.stdout.write(`\rProgress: ${progress}/${users.length} (${Math.round(progress / users.length * 100)}%)`);
  }

  console.log('\n');

  return { registered, alreadyExists, failed };
}

async function main() {
  const config = parseArgs();

  console.log('='.repeat(60));
  console.log('  Pre-registering Users in AWS Cognito');
  console.log('='.repeat(60));

  // Parse users
  console.log('\nReading users from users.csv...');
  const users = parseUsersCSV(config.limit);
  console.log(`Found ${users.length} users to register`);

  // Get Cognito configuration
  console.log('\nGetting Cognito configuration from Terraform...');
  const cognitoConfig = getCognitoConfig();
  console.log(`User Pool ID: ${cognitoConfig.userPoolId}`);
  console.log(`Client ID: ${cognitoConfig.clientId}`);

  // Get AWS region
  const region = getAwsRegion();
  console.log(`AWS Region: ${region}`);

  // Create Cognito client
  const cognitoClient = new CognitoIdentityProviderClient({ region });

  // Validate that the user pool actually exists in AWS
  console.log('\nValidating Cognito user pool exists in AWS...');
  const poolExists = await validateUserPoolExists(cognitoClient, cognitoConfig.userPoolId);

  let finalCognitoConfig = cognitoConfig;

  if (!poolExists) {
    console.log(`ERROR: User pool ${cognitoConfig.userPoolId} does not exist in AWS`);
    finalCognitoConfig = await deployCognitoWhenNeeded(region);
    console.log(`✅ Deployed new user pool: ${finalCognitoConfig.userPoolId}`);
  } else {
    console.log(`✅ User pool ${cognitoConfig.userPoolId} exists in AWS`);
  }

  // Register users
  console.log(`\nRegistering users (batch size: ${config.batchSize})...`);
  const results = await registerUsersInBatches(
    cognitoClient,
    finalCognitoConfig.userPoolId,
    users,
    config.batchSize
  );

  console.log('Results:');
  console.log(`  Registered: ${results.registered}`);
  console.log(`  Already existed: ${results.alreadyExists}`);
  console.log(`  Failed: ${results.failed}`);

  console.log('\n' + '='.repeat(60));
  console.log('  Pre-registration Complete');
  console.log('='.repeat(60));

  if (results.failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Error:', error.message);
  console.error(error.stack);
  process.exit(1);
});
