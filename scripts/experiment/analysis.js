const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execSync } = require('child_process');
const { logSection } = require('./utils');
const { analyzeExperimentLogs } = require('./log-analyzer');

const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;

async function enrichFileStreaming(filePath, runId, fnNamePrefix) {
  const needsEnrichment = await new Promise((resolve) => {
    const rs = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl2 = readline.createInterface({ input: rs, crlfDelay: Infinity });
    let count = 0;
    let found = false;
    rl2.on('line', (line) => {
      count++;
      if (line.includes('BEFAAS')) {
        found = true;
        rl2.close();
        rs.destroy();
        resolve(true);
      }
      if (count >= 1000) {
        rl2.close();
        rs.destroy();
        resolve(false);
      }
    });
    rl2.on('close', () => { if (!found) resolve(false); });
    rs.on('error', () => resolve(false));
  });

  if (!needsEnrichment) {
    return { enriched: 0, undoubled: 0 };
  }

  const tempPath = filePath + '.enrich.tmp';
  let enriched = 0;
  let undoubled = 0;
  let modified = false;
  let lineCount = 0;

  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const writeStream = fs.createWriteStream(tempPath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: readStream,
      crlfDelay: Infinity
    });

    let isFirst = true;
    let draining = false;

    function writeLine(data) {
      const chunk = isFirst ? data : '\n' + data;
      isFirst = false;
      const ok = writeStream.write(chunk);
      if (!ok && !draining) {
        draining = true;
        rl.pause();
        writeStream.once('drain', () => {
          draining = false;
          rl.resume();
        });
      }
    }

    rl.on('line', (line) => {
      lineCount++;
      if (lineCount % 2000000 === 0) {
        console.log(`    Enriched ${(lineCount / 1000000).toFixed(0)}M lines so far...`);
      }

      const trimmed = line.trim();

      if (!trimmed.includes('BEFAAS')) {
        writeLine(line);
        return;
      }

      const befaasMatch = trimmed.match(/BEFAAS:?\s*(\{.+\})\s*$/);
      if (!befaasMatch) {
        writeLine(line);
        return;
      }

      let befaasJsonStr = befaasMatch[1];
      let parsed;
      let wasUndoubled = false;

      try {
        parsed = JSON.parse(befaasJsonStr);
      } catch (e) {
        const fixed = befaasJsonStr.replace(/\\\\"/g, '\\"');
        try {
          parsed = JSON.parse(fixed);
          befaasJsonStr = fixed;
          wasUndoubled = true;
        } catch (e2) {
          writeLine(line);
          return;
        }
      }

      const fnName = (parsed.fn && parsed.fn.name) || 'unknown';
      const timestamp = parsed.timestamp || Date.now();

      const wrapper = JSON.stringify({
        timestamp: timestamp,
        message: 'BEFAAS' + befaasJsonStr + '\n',
        logGroup: '/aws/lambda/' + runId + '/' + fnName,
        fnName: fnNamePrefix + '/' + fnName
      });

      writeLine(wrapper);
      enriched++;
      modified = true;
      if (wasUndoubled) undoubled++;
    });

    rl.on('close', () => {
      writeStream.end(() => {
        if (modified) {
          fs.renameSync(tempPath, filePath);
        } else {
          try { fs.unlinkSync(tempPath); } catch (e) {}
        }
        if (lineCount > 2000000) {
          console.log(`    Finished: ${(lineCount / 1000000).toFixed(1)}M lines total`);
        }
        resolve({ enriched, undoubled });
      });
    });

    rl.on('error', (err) => {
      writeStream.destroy();
      try { fs.unlinkSync(tempPath); } catch (e) {}
      reject(err);
    });

    readStream.on('error', (err) => {
      writeStream.destroy();
      try { fs.unlinkSync(tempPath); } catch (e) {}
      reject(err);
    });
  });
}


async function enrichLogs(logsDir, outputDir) {
  const runId = path.basename(outputDir);
  const fnNamePrefixMatch = runId.match(/^[^_]+_(.+)$/);
  const fnNamePrefix = fnNamePrefixMatch ? fnNamePrefixMatch[1] : runId;

  let totalEnriched = 0;
  let totalUndoubled = 0;
  const logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));

  for (const file of logFiles) {
    const filePath = path.join(logsDir, file);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;

    if (stat.size > LARGE_FILE_THRESHOLD) {
      console.log(`  Enriching large file (${(stat.size / 1024 / 1024).toFixed(1)} MB): ${file}`);
    }

    const result = await enrichFileStreaming(filePath, runId, fnNamePrefix);
    totalEnriched += result.enriched;
    totalUndoubled += result.undoubled;
  }

  return { enriched: totalEnriched, undoubled: totalUndoubled };
}

async function sanitizeForDocker(inputPath, outputPath, deploymentId) {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(inputPath, { encoding: 'utf8' });
    const writeStream = fs.createWriteStream(outputPath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: readStream,
      crlfDelay: Infinity
    });

    let isFirst = true;
    let count = 0;
    let lineCount = 0;
    let draining = false;
    let failed = false;

    writeStream.on('error', (err) => {
      if (failed) return;
      failed = true;
      rl.close();
      readStream.destroy();
      writeStream.destroy();
      if (err.code === 'ENOSPC') {
        reject(new Error(`Disk full while sanitizing ${path.basename(inputPath)} - not enough space to create sanitized copies`));
      } else {
        reject(err);
      }
    });

    function writeLine(data) {
      if (failed) return;
      const chunk = isFirst ? data : '\n' + data;
      isFirst = false;
      const ok = writeStream.write(chunk);
      if (!ok && !draining) {
        draining = true;
        rl.pause();
        writeStream.once('drain', () => {
          draining = false;
          rl.resume();
        });
      }
    }

    rl.on('line', (line) => {
      if (failed) return;
      lineCount++;
      if (lineCount % 2000000 === 0) {
        console.log(`    Sanitized ${(lineCount / 1000000).toFixed(0)}M lines so far...`);
      }

      const trimmed = line.trim();
      if (!trimmed) return;

      let befaasJsonStr = null;
      let parsed = null;

      if (trimmed.startsWith('{')) {
        try {
          const outer = JSON.parse(trimmed);
          if (outer.message && typeof outer.message === 'string') {
            const msgMatch = outer.message.match(/BEFAAS:?\s*(\{.*\})\s*$/);
            if (msgMatch) {
              try {
                parsed = JSON.parse(msgMatch[1]);
                befaasJsonStr = msgMatch[1];
              } catch (e) {}
            }
          }
        } catch (e) {
          // Not valid outer JSON, skip
        }
        if (!befaasJsonStr) return;
      }

      if (!befaasJsonStr) {
        const rawMatch = trimmed.match(/BEFAAS:?\s*(\{.+\})\s*$/);
        if (!rawMatch) return;
        try {
          parsed = JSON.parse(rawMatch[1]);
          befaasJsonStr = rawMatch[1];
        } catch (e) {
          return;
        }
      }

      if (!parsed) return;

      let needsReserialize = false;
      if (!parsed.version) {
        parsed.version = '1.0';
        needsReserialize = true;
      }
      if (deploymentId && (!parsed.deploymentId || parsed.deploymentId === 'unknownDeploymentId')) {
        parsed.deploymentId = deploymentId;
        needsReserialize = true;
      }
      if (needsReserialize) {
        befaasJsonStr = JSON.stringify(parsed);
      }

      let escapedJson = befaasJsonStr;
      if (befaasJsonStr.includes('\\"')) {
        escapedJson = befaasJsonStr.replace(/\\"/g, '\\\\"');
      }

      writeLine('BEFAAS' + escapedJson);
      count++;
    });

    rl.on('close', () => {
      writeStream.end(() => resolve(count));
    });

    rl.on('error', (err) => {
      writeStream.destroy();
      reject(err);
    });

    readStream.on('error', (err) => {
      writeStream.destroy();
      reject(err);
    });
  });
}

async function createSanitizedCopy(logsDir) {
  const logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
  let totalLogSize = 0;
  for (const file of logFiles) {
    const stat = fs.statSync(path.join(logsDir, file));
    if (stat.isFile()) totalLogSize += stat.size;
  }

  const tmpDir = os.tmpdir();
  try {
    const dfOutput = execSync(`df -k "${tmpDir}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = dfOutput.trim().split('\n');
    if (lines.length >= 2) {
      const fields = lines[1].split(/\s+/);
      const availableKB = parseInt(fields[3], 10);
      if (!isNaN(availableKB)) {
        const availableBytes = availableKB * 1024;
        const requiredBytes = totalLogSize * 1.2;
        if (availableBytes < requiredBytes) {
          throw new Error(
            `Insufficient disk space for sanitized copies: need ~${(requiredBytes / 1024 / 1024 / 1024).toFixed(1)} GB ` +
            `(1.2x ${(totalLogSize / 1024 / 1024 / 1024).toFixed(1)} GB of logs), ` +
            `but only ${(availableBytes / 1024 / 1024 / 1024).toFixed(1)} GB available in ${tmpDir}`
          );
        }
      }
    }
  } catch (spaceErr) {
    if (spaceErr.message.startsWith('Insufficient disk space')) throw spaceErr;
    console.log('  Warning: could not check available disk space, proceeding anyway');
  }

  const tempDir = fs.mkdtempSync(path.join(tmpDir, 'befaas-analysis-'));

  try {
    const deploymentIdFile = path.join(logsDir, 'deployment_id.txt');
    let deploymentId = null;
    if (fs.existsSync(deploymentIdFile)) {
      deploymentId = fs.readFileSync(deploymentIdFile, 'utf8').trim();
      fs.copyFileSync(deploymentIdFile, path.join(tempDir, 'deployment_id.txt'));
    }

    let totalBefaas = 0;

    for (const file of logFiles) {
      const inputPath = path.join(logsDir, file);
      const stat = fs.statSync(inputPath);
      if (!stat.isFile()) continue;

      if (stat.size > LARGE_FILE_THRESHOLD) {
        console.log(`  Creating sanitized copy (${(stat.size / 1024 / 1024).toFixed(1)} MB): ${file}`);
      }

      const count = await sanitizeForDocker(inputPath, path.join(tempDir, file), deploymentId);
      totalBefaas += count;
    }

    console.log(`  Temp directory: ${tempDir} (${totalBefaas} BEFAAS entries)`);
    return tempDir;
  } catch (err) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log('  Cleaned up partial temp directory after failure');
    } catch (cleanupErr) {
      console.log(`  Warning: could not cleanup temp dir ${tempDir}: ${cleanupErr.message}`);
    }
    throw err;
  }
}

async function analyzeResults(experiment, outputDir) {
  logSection('Analyzing Results');

  console.log(`Analyzing results in ${outputDir}...`);

  const logsDir = path.join(outputDir, 'logs');
  if (!fs.existsSync(logsDir)) {
    console.log('No logs directory found, skipping analysis');
    return;
  }

  const analysisDir = path.join(outputDir, 'analysis');
  if (!fs.existsSync(analysisDir)) {
    fs.mkdirSync(analysisDir, { recursive: true });
  }

  const projectRoot = path.join(__dirname, '..', '..');
  const absoluteLogsDir = path.resolve(logsDir);
  const absoluteAnalysisDir = path.resolve(analysisDir);
  const absoluteOutputDir = path.resolve(outputDir);

  try {
    console.log('\nStep 0a: Enriching logs (raw BEFAAS -> CloudWatch JSON)...');
    const enrichResult = await enrichLogs(absoluteLogsDir, absoluteOutputDir);
    if (enrichResult.enriched > 0) {
      console.log(`  Enriched ${enrichResult.enriched} raw BEFAAS entries to CloudWatch JSON format`);
    }
    if (enrichResult.undoubled > 0) {
      console.log(`  Fixed ${enrichResult.undoubled} double-escaped entries`);
    }
    if (enrichResult.enriched === 0) {
      console.log('  All entries already in CloudWatch JSON format');
    }

    const artilleryLog = path.join(absoluteLogsDir, 'artillery.log');
    const deploymentIdFile = path.join(absoluteLogsDir, 'deployment_id.txt');
    if (fs.existsSync(artilleryLog)) {
      const logDeploymentId = await new Promise((resolveId, rejectId) => {
        const rs = fs.createReadStream(artilleryLog, { encoding: 'utf8' });
        const rl2 = readline.createInterface({ input: rs, crlfDelay: Infinity });
        let found = false;
        rl2.on('line', (line) => {
          const m = line.match(/"deploymentId":"([^"]+)"/);
          if (m) {
            found = true;
            rl2.close();
            rs.destroy();
            resolveId(m[1]);
          }
        });
        rl2.on('close', () => { if (!found) resolveId(null); });
        rl2.on('error', rejectId);
        rs.on('error', (err) => { if (!found) rejectId(err); });
      });

      if (logDeploymentId) {
        const currentId = fs.existsSync(deploymentIdFile)
          ? fs.readFileSync(deploymentIdFile, 'utf8').trim()
          : '';
        if (currentId !== logDeploymentId) {
          console.log(`  Syncing deployment_id.txt: ${currentId || '(empty)'} -> ${logDeploymentId}`);
          fs.writeFileSync(deploymentIdFile, logDeploymentId);
        }
      }
    }

    let dockerStepsSucceeded = false;
    try {
      try {
        execSync('docker info', {
          stdio: 'pipe',
          timeout: 10000,
          killSignal: 'SIGKILL',
        });
      } catch (dockerCheckErr) {
        throw new Error('Docker is not running, not installed, or unresponsive');
      }

      console.log('\nStep 0c: Creating sanitized copy for Docker...');
      const tempLogsDir = await createSanitizedCopy(absoluteLogsDir);

      console.log('\nStep 1: Generating dump.json from logs...');
      const dumpFile = path.join(analysisDir, 'dump.json');

      try {
        execSync(`docker run --rm -v "${tempLogsDir}":/data/logs -v "${absoluteAnalysisDir}":/data/output befaas/analysis "/data/logs" "/data/output"`, {
          stdio: 'inherit',
          shell: '/bin/bash'
        });
      } finally {
        // Always cleanup temp directory
        try {
          fs.rmSync(tempLogsDir, { recursive: true, force: true });
          console.log('  Cleaned up temp directory');
        } catch (cleanupErr) {
          console.log(`  Warning: could not cleanup temp dir ${tempLogsDir}: ${cleanupErr.message}`);
        }
      }

      if (!fs.existsSync(dumpFile)) {
        console.log('dump.json not created by container, skipping dump/insights analysis');
      } else {
        let dumpContent = fs.readFileSync(dumpFile, 'utf8').trim();
        if (dumpContent === '[]' || dumpContent === '{}' || dumpContent.length < 10) {
          console.log('dump.json is empty, skipping insights analysis');
        } else {
          if (!dumpContent.endsWith(']')) {
            console.log('  Fixing incomplete dump.json (missing closing bracket)');
            fs.appendFileSync(dumpFile, ']');
          }

          console.log('dump.json generated successfully');

          console.log('\nStep 2: Generating insights.json...');
          const generateInsightsScript = path.join(projectRoot, 'scripts', 'generate_insights.py');
          const requirementsFile = path.join(projectRoot, 'scripts', 'requirements.txt');

          if (fs.existsSync(generateInsightsScript)) {
            try {
              try {
                execSync('python3 -c "import numpy"', { stdio: 'pipe' });
              } catch (importError) {
                console.log('Installing Python dependencies...');
                if (fs.existsSync(requirementsFile)) {
                  execSync(`pip3 install -r "${requirementsFile}"`, { stdio: 'inherit' });
                } else {
                  execSync('pip3 install numpy', { stdio: 'inherit' });
                }
              }

              execSync(`python3 "${generateInsightsScript}" "${dumpFile}" "${analysisDir}"`, {
                stdio: 'inherit'
              });
              console.log('insights.json generated successfully');
            } catch (error) {
              console.error('Insights generation failed:', error.message);
              console.log('   Try: pip3 install numpy');
            }
          } else {
            console.log('generate_insights.py not found, skipping insights generation');
          }

          dockerStepsSucceeded = true;
        }
      }
    } catch (dockerError) {
      console.error('Docker analysis failed:', dockerError.message);
      console.log('Continuing with log analysis (Step 3)...');
    }

    console.log('\nStep 3: Analyzing logs for auth & Lambda metrics...');
    try {
      const logAnalysis = await analyzeExperimentLogs(outputDir);
      if (logAnalysis) {
        if (logAnalysis.auth_metrics) {
          console.log('  Auth metrics analysis complete');
        }
        if (logAnalysis.lambda_metrics) {
          console.log('  Lambda metrics analysis complete');
        }
      }
    } catch (logError) {
      console.error('Log analysis failed:', logError.message);
    }

    console.log('\nAnalysis completed' + (dockerStepsSucceeded ? ' successfully' : ' (Docker steps skipped)'));
    console.log(`\nAnalysis results saved to: ${analysisDir}`);
    if (dockerStepsSucceeded) {
      console.log('  - dump.json: Raw performance data from logs');
      console.log('  - insights.json: Comprehensive performance metrics');
      console.log('    - HTTP status distribution and response times');
      console.log('    - Per-endpoint metrics (request count, response times, auth times)');
      console.log('    - Per-function metrics (request count, response times, auth times)');
      console.log('    - Throughput timeline (requests/auth ops per minute)');
      console.log('    - Correlations (load vs latency, load vs errors)');
      console.log('    - Call chain breakdowns (time spent in each function)');
      console.log('    - Auth chain breakdowns (auth time per function in chain)');
    }
    console.log('  - log-analysis.json: Auth success/failure rates and Lambda metrics');
    console.log('    - Auth request success/failure by endpoint and phase');
    console.log('    - Cold start count, frequency, and duration');
    console.log('    - Memory usage efficiency and right-sizing recommendations');

  } catch (error) {
    console.error('Analysis failed:', error.message);
  }
}

module.exports = {
  analyzeResults
};
