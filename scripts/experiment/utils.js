const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const readline = require('readline');

// S3 bucket configuration for results upload
const S3_BUCKET_NAME = process.env.BEFAAS_RESULTS_BUCKET || 'befaas-benchmark-results';
const S3_REGION = process.env.BEFAAS_RESULTS_REGION || process.env.AWS_REGION || 'us-east-1';

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60) + '\n');
}

async function checkHealth(endpoints, maxRetries = 10, retryDelay = 3000) {
  if (!endpoints || endpoints.length === 0) {
    console.log('No health check endpoints configured, skipping health check');
    return true;
  }

  logSection('Health Check');
  console.log(`Checking ${endpoints.length} endpoint(s)...`);

  async function checkEndpoint(url) {
    return new Promise((resolve) => {
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, { timeout: 5000 }, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  const results = {};
  for (const endpoint of endpoints) {
    results[endpoint] = false;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`\nAttempt ${attempt}/${maxRetries}`);

    for (const endpoint of endpoints) {
      if (results[endpoint]) {
        console.log(`  [OK] ${endpoint} (already healthy)`);
        continue;
      }

      const isHealthy = await checkEndpoint(endpoint);
      results[endpoint] = isHealthy;

      if (isHealthy) {
        console.log(`  [OK] ${endpoint}`);
      } else {
        console.log(`  [FAIL] ${endpoint}`);
      }
    }

    const allHealthy = Object.values(results).every(v => v === true);
    if (allHealthy) {
      console.log('\n[OK] All services are healthy!');
      return true;
    }

    if (attempt < maxRetries) {
      console.log(`\nWaiting ${retryDelay / 1000}s before next check...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }

  const unhealthyEndpoints = Object.entries(results)
    .filter(([_, healthy]) => !healthy)
    .map(([endpoint]) => endpoint);

  if (unhealthyEndpoints.length > 0) {
    console.error('\nERROR: Some services failed health check:');
    unhealthyEndpoints.forEach(endpoint => console.error(`  - ${endpoint}`));
    return false;
  }

  return true;
}

function removeWithRetry(targetPath, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return true;
    } catch (error) {
      if (error.code === 'ENOTEMPTY' && attempt < maxRetries) {
        console.log(`    Retry ${attempt}/${maxRetries} for ${targetPath}...`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      } else if (error.code === 'ENOENT') {
        // Already deleted
        return true;
      } else {
        throw error;
      }
    }
  }
  return false;
}

function cleanupBuildArtifacts(experiment, architecture) {
  logSection('Cleaning up build artifacts');

  const projectRoot = path.join(__dirname, '..', '..');
  const pathsToClean = [
    path.join(projectRoot, 'experiments', experiment, 'architectures', architecture, '_build'),
    path.join(projectRoot, 'experiments', experiment, 'functions', '_build'),
    path.join(projectRoot, 'results', experiment, `${architecture}-*`),
    path.join(projectRoot, '.edge_public_key'),
    path.join(projectRoot, '.edge_cloudfront_url')
  ];

  for (const cleanPath of pathsToClean) {
    if (cleanPath.includes('*')) {
      const dirPath = path.dirname(cleanPath);
      const pattern = path.basename(cleanPath);
      if (fs.existsSync(dirPath)) {
        const entries = fs.readdirSync(dirPath);
        for (const entry of entries) {
          if (entry.match(new RegExp(pattern.replace('*', '.*')))) {
            const fullPath = path.join(dirPath, entry);
            console.log(`  Removing: ${fullPath}`);
            try {
              removeWithRetry(fullPath);
            } catch (error) {
              console.warn(`  Warning: Could not remove ${fullPath}: ${error.message}`);
            }
          }
        }
      }
    } else {
      if (fs.existsSync(cleanPath)) {
        console.log(`  Removing: ${cleanPath}`);
        try {
          removeWithRetry(cleanPath);
        } catch (error) {
          console.warn(`  Warning: Could not remove ${cleanPath}: ${error.message}`);
        }
      }
    }
  }

  console.log('[OK] Cleanup completed');
}

function deleteLocalResults(outputDir) {
  logSection('Deleting Local Results');

  const absoluteOutputDir = path.resolve(outputDir);

  console.log(`Deleting local results from: ${absoluteOutputDir}`);

  try {
    if (fs.existsSync(absoluteOutputDir)) {
      fs.rmSync(absoluteOutputDir, { recursive: true, force: true });
      console.log('[OK] Local results deleted successfully');
    } else {
      console.log('Warning: Output directory does not exist, nothing to delete');
    }
  } catch (error) {
    console.error('[FAIL] Failed to delete local results:', error.message);
  }
}

async function uploadResultsToS3(outputDir, experiment, architecture, auth) {
  const { execSync } = require('child_process');

  logSection('Uploading Results to S3');

  const absoluteOutputDir = path.resolve(outputDir);
  const dirName = path.basename(absoluteOutputDir);
  const s3Key = `${experiment}/${dirName}`;

  console.log(`Uploading results from: ${absoluteOutputDir}`);
  console.log(`S3 destination: s3://${S3_BUCKET_NAME}/${s3Key}/`);

  try {
    const syncCommand = `aws s3 sync "${absoluteOutputDir}" "s3://${S3_BUCKET_NAME}/${s3Key}/" --region ${S3_REGION}`;

    execSync(syncCommand, {
      stdio: 'inherit',
      shell: '/bin/bash'
    });

    console.log(`[OK] Results uploaded to s3://${S3_BUCKET_NAME}/${s3Key}/`);
    return true;
  } catch (error) {
    console.error('[FAIL] Failed to upload results to S3:', error.message);
    return false;
  }
}

function setupLogging(outputDir) {
  const logFile = path.join(outputDir, 'experiment.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk, encoding, callback) => {
    logStream.write(chunk, encoding);
    return originalStdoutWrite(chunk, encoding, callback);
  };

  process.stderr.write = (chunk, encoding, callback) => {
    logStream.write(chunk, encoding);
    return originalStderrWrite(chunk, encoding, callback);
  };

  return logFile;
}

async function parseCpuInfoFromLogs(logsDir) {
  const logFile = path.join(logsDir, 'aws.log');
  if (!fs.existsSync(logFile)) {
    return null;
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(logFile, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.includes('cpuInfo')) continue;

    try {
      const parsed = JSON.parse(line);
      if (parsed.event && parsed.event.cpuInfo) {
        rl.close();
        return parsed.event.cpuInfo;
      }
      if (parsed.message) {
        const befaasMatch = parsed.message.match(/BEFAAS:\s*(.+)/);
        if (befaasMatch) {
          const befaasData = JSON.parse(befaasMatch[1]);
          if (befaasData.event && befaasData.event.cpuInfo) {
            rl.close();
            return befaasData.event.cpuInfo;
          }
        }
      }
    } catch (e) {
      continue;
    }
  }

  return null;
}

module.exports = {
  S3_BUCKET_NAME,
  S3_REGION,
  logSection,
  checkHealth,
  cleanupBuildArtifacts,
  deleteLocalResults,
  uploadResultsToS3,
  setupLogging,
  parseCpuInfoFromLogs
};
