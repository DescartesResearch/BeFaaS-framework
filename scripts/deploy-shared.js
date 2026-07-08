const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function runTerraform(workingDir, command, options = {}) {
  const { vars = {}, targets = [], target = null, parallelism = null } = options;

  if (command !== 'init' && !fs.existsSync(path.join(workingDir, '.terraform'))) {
    console.log(`  → terraform init (auto: .terraform missing)`);
    execSync('terraform init', { cwd: workingDir, stdio: 'inherit' });
  }

  let cmd = `terraform ${command}`;

  if (target) {
    cmd += ` -target=${target}`;
  }

  if (targets.length > 0) {
    targets.forEach(t => {
      cmd += ` -target='${t}'`;
    });
  }

  for (const [key, value] of Object.entries(vars)) {
    cmd += ` -var="${key}=${value}"`;
  }

  if (command === 'apply' || command === 'destroy') {
    cmd += ' -auto-approve';
  }

  if (command === 'destroy') {
    cmd += ` -parallelism=${parallelism || 50}`;
  }

  console.log(`  → ${cmd}`);
  execSync(cmd, {
    cwd: workingDir,
    stdio: 'inherit'
  });
}

function getTerraformOutputJson(workingDir) {
  try {
    const cmd = 'terraform output -json';
    const result = execSync(cmd, {
      cwd: workingDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return JSON.parse(result);
  } catch (error) {
    console.warn(`Warning: Could not get Terraform output from ${workingDir}`);
    return {};
  }
}

function getTerraformOutput(workingDir, outputName) {
  const cmd = `terraform output -raw ${outputName}`;
  const result = execSync(cmd, {
    cwd: workingDir,
    encoding: 'utf8'
  });
  return result.trim();
}

function hasState(workingDir) {
  const stateFile = path.join(workingDir, 'terraform.tfstate');
  if (!fs.existsSync(stateFile)) {
    return false;
  }
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return state.resources && state.resources.length > 0;
  } catch {
    return false;
  }
}

function getAwsAccountId() {
  try {
    const result = execSync('aws sts get-caller-identity --query Account --output text', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim();
  } catch (error) {
    throw new Error('Could not get AWS account ID. Ensure AWS CLI is configured.');
  }
}

function getVpcIdFromState(vpcDir) {
  try {
    const stateFile = path.join(vpcDir, 'terraform.tfstate');
    if (!fs.existsSync(stateFile)) return null;

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!state.resources) return null;

    for (const resource of state.resources) {
      if (resource.type === 'aws_vpc' && resource.name === 'default') {
        return resource.instances?.[0]?.attributes?.id;
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

async function waitForInstancesTerminated(vpcId, awsRegion, maxWaitSeconds = 300) {
  console.log(`Waiting for EC2 instances in VPC ${vpcId} to terminate...`);
  const startTime = Date.now();
  const maxWaitMs = maxWaitSeconds * 1000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const result = execSync(
        `aws ec2 describe-instances --filters "Name=vpc-id,Values=${vpcId}" "Name=instance-state-name,Values=pending,running,stopping,shutting-down" --query "Reservations[*].Instances[*].InstanceId" --output text --region ${awsRegion}`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      if (!result || result === '') {
        console.log('  [OK] All instances terminated');
        return true;
      }

      const instanceIds = result.split(/\s+/).filter(id => id);
      console.log(`  Waiting for ${instanceIds.length} instance(s) to terminate: ${instanceIds.join(', ')}`);
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10s between checks
    } catch (error) {
      console.log('  Could not check instances, proceeding...');
      return true;
    }
  }

  console.log(`  Warning: Timeout waiting for instances to terminate after ${maxWaitSeconds}s`);
  return false;
}

async function cleanupVpcNetworkInterfaces(vpcId, awsRegion) {
  console.log(`Cleaning up network interfaces in VPC ${vpcId}...`);

  try {
    const result = execSync(
      `aws ec2 describe-network-interfaces --filters "Name=vpc-id,Values=${vpcId}" --query "NetworkInterfaces[*].{Id:NetworkInterfaceId,Status:Status,AttachmentId:Attachment.AttachmentId}" --output json --region ${awsRegion}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const enis = JSON.parse(result);
    if (!enis || enis.length === 0) {
      console.log('  No network interfaces found');
      return;
    }

    console.log(`  Found ${enis.length} network interface(s)`);

    for (const eni of enis) {
      try {
        if (eni.AttachmentId && eni.Status === 'in-use') {
          console.log(`  Detaching ENI ${eni.Id}...`);
          execSync(
            `aws ec2 detach-network-interface --attachment-id ${eni.AttachmentId} --force --region ${awsRegion}`,
            { stdio: 'pipe' }
          );
          await new Promise(resolve => setTimeout(resolve, 5000));
        }

        console.log(`  Deleting ENI ${eni.Id}...`);
        execSync(
          `aws ec2 delete-network-interface --network-interface-id ${eni.Id} --region ${awsRegion}`,
          { stdio: 'pipe' }
        );
        console.log(`  [OK] Deleted ENI ${eni.Id}`);
      } catch (error) {
        console.log(`  Warning: Could not delete ENI ${eni.Id}: ${error.message}`);
      }
    }
  } catch (error) {
    console.log(`  Could not cleanup ENIs: ${error.message}`);
  }
}

async function cleanupVpcSecurityGroups(vpcId, awsRegion) {
  console.log(`Cleaning up security groups in VPC ${vpcId}...`);

  try {
    const result = execSync(
      `aws ec2 describe-security-groups --filters "Name=vpc-id,Values=${vpcId}" --query "SecurityGroups[?GroupName!='default'].{Id:GroupId,Name:GroupName}" --output json --region ${awsRegion}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const sgs = JSON.parse(result);
    if (!sgs || sgs.length === 0) {
      console.log('  No non-default security groups found');
      return;
    }

    console.log(`  Found ${sgs.length} security group(s)`);

    for (const sg of sgs) {
      try {
        console.log(`  Deleting security group ${sg.Name} (${sg.Id})...`);
        execSync(
          `aws ec2 delete-security-group --group-id ${sg.Id} --region ${awsRegion}`,
          { stdio: 'pipe' }
        );
        console.log(`  [OK] Deleted security group ${sg.Name} (${sg.Id})`);
      } catch (error) {
        console.log(`  Warning: Could not delete security group ${sg.Name} (${sg.Id}): ${error.message}`);
      }
    }
  } catch (error) {
    console.log(`  Could not cleanup security groups: ${error.message}`);
  }
}

function importOrphanedVpcResources(vpcDir) {
  const awsRegion = process.env.AWS_REGION || 'us-east-1';
  const vpcId = getVpcIdFromState(vpcDir);
  if (!vpcId) {
    return;
  }

  let stateResources = [];
  try {
    const stateList = execSync('terraform state list', {
      cwd: vpcDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    stateResources = stateList.trim().split('\n').filter(Boolean);
  } catch {
    return;
  }

  const sgResources = [
    { tfName: 'aws_security_group.ssh', awsName: 'ssh-access' },
    { tfName: 'aws_security_group.redis', awsName: 'redis-access' }
  ];

  for (const { tfName, awsName } of sgResources) {
    if (stateResources.includes(tfName)) {
      continue;
    }

    try {
      const result = execSync(
        `aws ec2 describe-security-groups --filters "Name=group-name,Values=${awsName}" "Name=vpc-id,Values=${vpcId}" --query "SecurityGroups[0].GroupId" --output text --region ${awsRegion}`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      if (result && result !== 'None') {
        console.log(`  Importing orphaned security group ${awsName} (${result}) into Terraform state...`);
        execSync(`terraform import '${tfName}' '${result}'`, {
          cwd: vpcDir,
          stdio: 'inherit'
        });
        console.log(`  [OK] Imported ${awsName}`);
      }
    } catch (error) {
      console.log(`  Warning: Could not check/import ${awsName}: ${error.message}`);
    }
  }
}

function ensureCognitoDeployed(projectRoot) {
  const cognitoDir = path.join(projectRoot, 'infrastructure', 'services', 'cognito');
  const cognitoState = path.join(cognitoDir, 'terraform.tfstate');

  if (!fs.existsSync(cognitoDir)) {
    return;
  }

  if (fs.existsSync(cognitoState)) {
    try {
      const state = JSON.parse(fs.readFileSync(cognitoState, 'utf8'));
      if (state.resources && state.resources.length > 0) {
        return;
      }
    } catch {
      // Fall through to deploy
    }
  }

  console.log('Deploying persistent Cognito user pool (required by provider infrastructure)...');
  runTerraform(cognitoDir, 'init');
  runTerraform(cognitoDir, 'apply');
}

module.exports = {
  runTerraform,
  getTerraformOutputJson,
  getTerraformOutput,
  hasState,
  getAwsAccountId,
  getVpcIdFromState,
  waitForInstancesTerminated,
  cleanupVpcNetworkInterfaces,
  cleanupVpcSecurityGroups,
  importOrphanedVpcResources,
  ensureCognitoDeployed
};
