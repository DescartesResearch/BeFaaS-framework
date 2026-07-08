const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { runTerraform, getTerraformOutputJson, hasState } = require('./deploy-shared');

async function deployCloudfrontProxy(projectName, originDomain, options = {}) {
  const projectRoot = path.join(__dirname, '..');
  const awsRegion = process.env.AWS_REGION || 'us-east-1';

  const {
    originProtocol = 'https-only',
    originHttpPort = 80,
    originHttpsPort = 443
  } = options;

  console.log('\n========================================');
  console.log('Deploying CloudFront Proxy (passthrough)');
  console.log('========================================\n');

  const cloudfrontProxyDir = path.join(projectRoot, 'infrastructure', 'services', 'cloudfront-proxy');
  const cloudfrontSecret = crypto.randomBytes(32).toString('hex');

  // Write terraform vars
  const tfvarsPath = path.join(cloudfrontProxyDir, 'terraform.auto.tfvars.json');
  fs.writeFileSync(tfvarsPath, JSON.stringify({
    project_name: projectName,
    origin_domain: originDomain,
    origin_protocol_policy: originProtocol,
    origin_http_port: originHttpPort,
    origin_https_port: originHttpsPort,
    cloudfront_secret: cloudfrontSecret,
    aws_region: awsRegion
  }, null, 2));

  let output;
  try {
    runTerraform(cloudfrontProxyDir, 'init');
    runTerraform(cloudfrontProxyDir, 'apply');
    output = getTerraformOutputJson(cloudfrontProxyDir);
  } finally {
    if (fs.existsSync(tfvarsPath)) fs.unlinkSync(tfvarsPath);
  }

  const cloudfrontDomain = output.cloudfront_domain?.value;
  const cloudfrontUrl = output.cloudfront_url?.value || `https://${cloudfrontDomain}`;

  console.log('\n========================================');
  console.log('CloudFront Proxy Deployed');
  console.log('========================================');
  console.log(`CloudFront Domain: ${cloudfrontDomain}`);
  console.log(`CloudFront URL: ${cloudfrontUrl}`);
  console.log('========================================\n');

  return {
    cloudfrontDomain,
    cloudfrontUrl,
    distributionId: output.cloudfront_distribution_id?.value
  };
}

async function destroyCloudfrontProxy(projectName) {
  const projectRoot = path.join(__dirname, '..');
  const cloudfrontProxyDir = path.join(projectRoot, 'infrastructure', 'services', 'cloudfront-proxy');

  console.log('\nDestroying CloudFront Proxy infrastructure...');

  if (!fs.existsSync(path.join(cloudfrontProxyDir, 'terraform.tfstate'))) {
    console.log('No cloudfront-proxy state found, skipping...');
    return;
  }

  try {
    const tfvarsPath = path.join(cloudfrontProxyDir, 'terraform.auto.tfvars.json');
    const currentVars = fs.existsSync(tfvarsPath)
      ? JSON.parse(fs.readFileSync(tfvarsPath, 'utf8'))
      : {};

    fs.writeFileSync(tfvarsPath, JSON.stringify({
      project_name: projectName || currentVars.project_name || 'befaas',
      origin_domain: currentVars.origin_domain || 'placeholder.example.com',
      cloudfront_secret: currentVars.cloudfront_secret || 'placeholder'
    }, null, 2));

    runTerraform(cloudfrontProxyDir, 'destroy');

    if (fs.existsSync(tfvarsPath)) fs.unlinkSync(tfvarsPath);

    console.log('[OK] CloudFront Proxy infrastructure destroyed');
  } catch (error) {
    console.error('Warning: Failed to destroy cloudfront-proxy:', error.message);
  }
}

function hasCloudfrontProxyState() {
  const projectRoot = path.join(__dirname, '..');
  const cloudfrontProxyDir = path.join(projectRoot, 'infrastructure', 'services', 'cloudfront-proxy');
  return hasState(cloudfrontProxyDir);
}

module.exports = {
  deployCloudfrontProxy,
  destroyCloudfrontProxy,
  hasCloudfrontProxyState
};
