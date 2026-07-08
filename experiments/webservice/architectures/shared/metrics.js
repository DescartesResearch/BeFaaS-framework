
const { performance } = require('perf_hooks');
const fs = require('fs');

const fnName = process.env.BEFAAS_FN_NAME || 'unknown';

let isColdStart = true;
let requestCount = 0;

function logCpuInfo () {
  try {
    const cpuInfoRaw = fs.readFileSync('/proc/cpuinfo', 'utf8')
    const fields = ['model name', 'vendor_id', 'cpu MHz', 'cache size', 'cpu cores', 'bogomips']
    const cpuInfo = {}
    for (const field of fields) {
      const match = cpuInfoRaw.match(new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm'))
      if (match) {
        cpuInfo[field.replace(/ /g, '_')] = match[1].trim()
      }
    }
    if (Object.keys(cpuInfo).length > 0) {
      const metric = {
        timestamp: Date.now(),
        fn: { name: process.env.BEFAAS_FN_NAME || 'unknown' },
        event: { cpuInfo }
      }
      console.log('BEFAAS: ' + JSON.stringify(metric))
    }
  } catch (e) {
    // /proc/cpuinfo not available (e.g., macOS, Windows) - skip silently
  }
}

function logMetric (event) {
  const metric = {
    timestamp: Date.now(),
    fn: { name: fnName },
    event
  };
  // "BEFAAS: " format (with colon+space) - plain "BEFAAS{" format gets filtered by CloudWatch
  console.log('BEFAAS: ' + JSON.stringify(metric));
}

function logColdStartIfNeeded () {
  if (isColdStart) {
    logMetric({
      coldStart: true
    });
    isColdStart = false;
  }
}

function startHandlerTiming (contextId, xPair, route) {
  const startTime = performance.now();
  const isFirst = requestCount === 0;
  requestCount++;

  logColdStartIfNeeded();

  return (statusCode = 200) => {
    const durationMs = performance.now() - startTime;
    logMetric({
      contextId,
      xPair,
      handler: {
        route,
        durationMs,
        coldStart: isFirst,
        statusCode
      }
    });
  };
}

function logRpcCall (contextId, sourceXPair, targetFn, callXPair, durationMs) {
  logMetric({
    contextId,
    xPair: sourceXPair,
    rpcOut: {
      target: targetFn,
      callXPair,
      durationMs
    }
  });
}

function startRpcTiming (contextId, sourceXPair, targetFn, callXPair) {
  const startTime = performance.now();

  return () => {
    const durationMs = performance.now() - startTime;
    logRpcCall(contextId, sourceXPair, targetFn, callXPair, durationMs);
  };
}

function logRpcIn (contextId, xPair) {
  logColdStartIfNeeded();
  logMetric({
    contextId,
    xPair,
    rpcIn: {
      coldStart: requestCount === 0
    }
  });
  requestCount++;
}

function getMetricsState () {
  return {
    fnName,
    isColdStart,
    requestCount
  };
}

// Log CPU info once at module load time (cold start)
logCpuInfo()

module.exports = {
  logMetric,
  logColdStartIfNeeded,
  startHandlerTiming,
  logRpcCall,
  startRpcTiming,
  logRpcIn,
  getMetricsState,
  fnName
};