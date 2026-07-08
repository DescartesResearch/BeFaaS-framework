#!/usr/bin/env node

const path = require('path');
const { analyzeExperimentLogs } = require('./log-analyzer');

const runDir = process.argv[2];
if (!runDir) {
  console.error('Usage: node scripts/experiment/log-analyzer-cli.js <runDir>');
  process.exit(1);
}

analyzeExperimentLogs(path.resolve(runDir))
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('log-analyzer failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
