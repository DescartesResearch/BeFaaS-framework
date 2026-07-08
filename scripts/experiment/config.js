const fs = require('fs');
const path = require('path');

function printUsage() {
  console.log(`
Usage: node scripts/experiment.js --architecture <arch> --auth <auth> [options]

Required:
  --architecture, -a    Architecture to deploy (faas, microservices, monolith)
  --auth, -u           Authentication strategy (none, service-integrated, service-integrated-manual, edge, edge-selective)

Optional:
  --experiment, -e     Experiment to run (default: webservice)
                       Available: iot, smartFactory, streaming, test, topics, webservice
  --memory             AWS Lambda memory in MB (FaaS only, default: 512, range: 128-10240)
  --cpu                Fargate CPU units (Monolith/Microservices only, default: 512)
                       256 = 0.25 vCPU, 512 = 0.5 vCPU, 1024 = 1.0 vCPU
  --memory-fargate     Fargate memory in MB (Monolith/Microservices only, default: 1024)
  --keep-infra         Keep infrastructure running after experiment (default: destroy)
  --skip-benchmark     Skip benchmark execution
  --skip-metrics       Skip metrics collection
  --workload           Workload file (default: workload-constant.yml)
  --output-dir         Output directory for results (default: ./results/<experiment>/<arch>_<auth>_<mem>_<timestamp>)
  --algorithm           Algorithm variant for service-integrated-manual auth
                       (bcrypt-hs256, argon2id-eddsa; default: argon2id-eddsa)
  --auth-granularity   Where token verification happens for monolith/microservices
                       (per-function, per-service; default: per-service)
                       per-function: every function verifies independently (legacy/measured behavior)
                       per-service:  one verification at the service entry boundary (k=1 monolith, k=d microservices)
                       Ignored for FaaS (each function is its own service boundary).
  --cleanup-logs       Clean up ALL orphaned CloudWatch log groups and exit (no experiment run)
  --with-cloudfront    Deploy CloudFront as passthrough proxy in front of origin (for non-edge auth)
                       Adds realistic network path overhead without authentication at the edge
  --reuse-edge-auth    Reuse existing CloudFront/Lambda@Edge (update in-place instead of destroy/create)
  --keep-edge-auth     Keep CloudFront/Lambda@Edge alive after experiment (skip edge-auth destruction)
  --help, -h           Show this help message

Scaling Options (ECS-only, ignored for FaaS):
  --scaling-mode       Auto-scaling mode: request_count (default), latency, or none
  --min-capacity       Minimum number of ECS tasks (default: 2 monolith, 1 microservices)
  --max-capacity       Maximum number of ECS tasks (default: 30 monolith, 25 microservices)
  --min-capacity-frontend  Min frontend tasks, microservices only (default: 2)
  --target-request-count   Target requests/target/min for request_count mode
                           (default: 2500 monolith, 3000 microservices)
  --target-response-time   Target avg response time in ms for latency mode (default: 300)
  --scale-out-cooldown     Scale-out cooldown in seconds (default: 30)
  --scale-in-cooldown      Scale-in cooldown in seconds (default: 300 monolith, 180 microservices)
  --desired-count      Initial task count, also used as fixed count in none mode
                       (default: 3 monolith, 1 microservices)

Examples:
  # Full experiment run (infra auto-destroyed at the end)
  node scripts/experiment.js -a faas -u none

  # Lambda with custom memory (SMALL/MEDIUM/LARGE)
  node scripts/experiment.js -a faas -u none --memory 256
  node scripts/experiment.js -a faas -u none --memory 512
  node scripts/experiment.js -a faas -u none --memory 1769

  # Monolith with custom CPU/Memory (SMALL/MEDIUM/LARGE)
  node scripts/experiment.js -a monolith -u service-integrated --cpu 256 --memory-fargate 512
  node scripts/experiment.js -a monolith -u service-integrated --cpu 512 --memory-fargate 1024
  node scripts/experiment.js -a monolith -u service-integrated --cpu 1024 --memory-fargate 2048

  # Microservices with custom CPU/Memory
  node scripts/experiment.js -a microservices -u service-integrated --cpu 1024 --memory-fargate 2048

  # Monolith with latency-based scaling
  node scripts/experiment.js -a monolith -u service-integrated --cpu 512 --memory-fargate 1024 \\
    --scaling-mode latency --target-response-time 300 --max-capacity 30

  # Microservices with fixed capacity (no auto-scaling)
  node scripts/experiment.js -a microservices -u service-integrated --cpu 256 --memory-fargate 512 \\
    --scaling-mode none --desired-count 3

  # Keep infrastructure running after experiment (for debugging)
  node scripts/experiment.js -a faas -u none --keep-infra
`);
}

function parseArgs(args) {
  const config = {
    experiment: 'webservice',
    architecture: null,
    auth: null,
    destroy: true,
    skipBenchmark: false,
    skipMetrics: false,
    workload: 'scnast.yml',
    outputDir: null,
    memory: 512,
    cpu: 512,
    memoryFargate: 1024,
    cleanupLogs: false,
    algorithm: null,
    authGranularity: 'per-service',
    scalingMode: null,
    minCapacity: null,
    maxCapacity: null,
    minCapacityFrontend: null,
    targetRequestCount: null,
    targetResponseTime: null,
    scaleOutCooldown: null,
    scaleInCooldown: null,
    desiredCount: null,
    reuseEdgeAuth: false,
    keepEdgeAuth: false,
    withCloudfront: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      case '--experiment':
      case '-e':
        config.experiment = args[++i];
        break;
      case '--architecture':
      case '-a':
        config.architecture = args[++i];
        break;
      case '--auth':
      case '-u':
        config.auth = args[++i];
        break;
      case '--destroy':
        config.destroy = true;
        break;
      case '--keep-infra':
        config.destroy = false;
        break;
      case '--skip-benchmark':
        config.skipBenchmark = true;
        break;
      case '--skip-metrics':
        config.skipMetrics = true;
        break;
      case '--workload':
        config.workload = args[++i];
        break;
      case '--output-dir':
        config.outputDir = args[++i];
        break;
      case '--memory':
        config.memory = parseInt(args[++i]);
        break;
      case '--cpu':
        config.cpu = parseInt(args[++i]);
        break;
      case '--memory-fargate':
        config.memoryFargate = parseInt(args[++i]);
        break;
      case '--algorithm':
        config.algorithm = args[++i];
        break;
      case '--auth-granularity':
        config.authGranularity = args[++i];
        break;
      case '--cleanup-logs':
        config.cleanupLogs = true;
        break;
      case '--reuse-edge-auth':
        config.reuseEdgeAuth = true;
        break;
      case '--keep-edge-auth':
        config.keepEdgeAuth = true;
        break;
      case '--with-cloudfront':
        config.withCloudfront = true;
        break;
      case '--scaling-mode':
        config.scalingMode = args[++i];
        break;
      case '--min-capacity':
        config.minCapacity = parseInt(args[++i]);
        break;
      case '--max-capacity':
        config.maxCapacity = parseInt(args[++i]);
        break;
      case '--min-capacity-frontend':
        config.minCapacityFrontend = parseInt(args[++i]);
        break;
      case '--target-request-count':
        config.targetRequestCount = parseInt(args[++i]);
        break;
      case '--target-response-time':
        config.targetResponseTime = parseInt(args[++i]);
        break;
      case '--scale-out-cooldown':
        config.scaleOutCooldown = parseInt(args[++i]);
        break;
      case '--scale-in-cooldown':
        config.scaleInCooldown = parseInt(args[++i]);
        break;
      case '--desired-count':
        config.desiredCount = parseInt(args[++i]);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  return config;
}

function validateConfig(config) {
  if (config.cleanupLogs) {
    return config;
  }

  if (!config.architecture) {
    console.error('Error: --architecture is required');
    printUsage();
    process.exit(1);
  }

  if (!config.auth) {
    console.error('Error: --auth is required');
    printUsage();
    process.exit(1);
  }

  const validArchitectures = ['faas', 'microservices', 'monolith'];
  if (!validArchitectures.includes(config.architecture)) {
    console.error(`Error: Invalid architecture. Must be one of: ${validArchitectures.join(', ')}`);
    process.exit(1);
  }

  const validAuth = ['none', 'service-integrated', 'service-integrated-manual', 'edge', 'edge-selective'];
  if (!validAuth.includes(config.auth)) {
    console.error(`Error: Invalid auth strategy. Must be one of: ${validAuth.join(', ')}`);
    process.exit(1);
  }

  if (config.withCloudfront && (config.auth === 'edge' || config.auth === 'edge-selective')) {
    console.error(`Error: --with-cloudfront cannot be used with edge or edge-selective auth (they already deploy CloudFront)`);
    process.exit(1);
  }

  if (config.algorithm && config.auth !== 'service-integrated-manual') {
    console.error(`Error: --algorithm can only be used with --auth service-integrated-manual`);
    process.exit(1);
  }

  if (config.auth === 'service-integrated-manual' && !config.algorithm) {
    config.algorithm = 'argon2id-eddsa';
  }

  const validAuthGranularity = ['per-function', 'per-service'];
  if (!validAuthGranularity.includes(config.authGranularity)) {
    console.error(`Error: Invalid --auth-granularity. Must be one of: ${validAuthGranularity.join(', ')}`);
    process.exit(1);
  }

  if (config.authGranularity === 'per-service' && config.architecture === 'faas') {
    console.warn('Warning: --auth-granularity is ignored for FaaS (each function is its own service boundary)');
  }

  if (config.authGranularity === 'per-service' && config.auth === 'none') {
    console.warn('Warning: --auth-granularity has no effect when --auth=none');
  }

  if (config.algorithm) {
    const algorithmDir = path.join(__dirname, '..', '..', 'experiments', 'webservice', 'authentication', 'service-integrated-manual', 'algorithms', config.algorithm);
    if (!fs.existsSync(algorithmDir)) {
      console.error(`Error: Algorithm variant '${config.algorithm}' not found at ${algorithmDir}`);
      const algorithmsBase = path.join(__dirname, '..', '..', 'experiments', 'webservice', 'authentication', 'service-integrated-manual', 'algorithms');
      if (fs.existsSync(algorithmsBase)) {
        const available = fs.readdirSync(algorithmsBase).filter(f => {
          return fs.statSync(path.join(algorithmsBase, f)).isDirectory();
        });
        console.error(`Available algorithms: ${available.join(', ')}`);
      }
      process.exit(1);
    }
  }

  const projectRoot = path.join(__dirname, '..', '..');
  const experimentsDir = path.join(projectRoot, 'experiments');
  const validExperiments = fs.readdirSync(experimentsDir).filter(file => {
    const fullPath = path.join(experimentsDir, file);
    return fs.statSync(fullPath).isDirectory();
  });

  if (!validExperiments.includes(config.experiment)) {
    console.error(`Error: Invalid experiment. Must be one of: ${validExperiments.join(', ')}`);
    process.exit(1);
  }

  if (config.memory) {
    if (isNaN(config.memory) || config.memory < 128 || config.memory > 10240) {
      console.error('Error: Memory must be between 128 MB and 10240 MB');
      process.exit(1);
    }
  }

  const scalingFlags = ['scalingMode', 'minCapacity', 'maxCapacity', 'minCapacityFrontend',
    'targetRequestCount', 'targetResponseTime', 'scaleOutCooldown', 'scaleInCooldown', 'desiredCount'];
  const hasExplicitScalingFlags = scalingFlags.some(f => config[f] !== null);

  if (config.architecture === 'faas' && hasExplicitScalingFlags) {
    console.warn('Warning: Scaling flags are ignored for FaaS architecture (auto-scaling is managed by AWS Lambda)');
  }

  if (config.scalingMode !== null) {
    const validScalingModes = ['request_count', 'latency', 'none'];
    if (!validScalingModes.includes(config.scalingMode)) {
      console.error(`Error: Invalid scaling mode '${config.scalingMode}'. Must be one of: ${validScalingModes.join(', ')}`);
      process.exit(1);
    }
  }

  if (config.architecture === 'monolith' || config.architecture === 'microservices') {
    const isMono = config.architecture === 'monolith';

    if (config.scalingMode === null) config.scalingMode = 'request_count';
    if (config.minCapacity === null) config.minCapacity = isMono ? 2 : 1;
    if (config.maxCapacity === null) config.maxCapacity = isMono ? 30 : 25;
    if (config.targetRequestCount === null) config.targetRequestCount = isMono ? 2500 : 3000;
    if (config.targetResponseTime === null) config.targetResponseTime = 300;
    if (config.scaleOutCooldown === null) config.scaleOutCooldown = 30;
    if (config.scaleInCooldown === null) config.scaleInCooldown = isMono ? 300 : 180;
    if (config.desiredCount === null) config.desiredCount = isMono ? 3 : 1;
    if (config.minCapacityFrontend === null) config.minCapacityFrontend = 2;

    if (config.scalingMode === 'none') {
      config.minCapacity = config.desiredCount;
      config.maxCapacity = config.desiredCount;
      if (config.architecture === 'microservices') {
        config.minCapacityFrontend = config.desiredCount;
      }
    }

    if (config.scalingMode === 'latency' && (!config.targetResponseTime || config.targetResponseTime <= 0)) {
      console.error('Error: --target-response-time must be a positive number for latency scaling mode');
      process.exit(1);
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parts = [config.architecture, config.auth];

  if (config.withCloudfront) {
    parts.push('cf');
  }

  if (config.architecture === 'faas') {
    parts.push(`${config.memory}MB`);
  } else {
    parts.push(`${config.cpu}cpu`);
    parts.push(`${config.memoryFargate}MB`);
  }
  parts.push(timestamp);

  config.runId = parts.join('_');

  if (!config.outputDir) {
    config.outputDir = path.join('results', config.experiment, config.runId);
  }

  return config;
}

module.exports = {
  printUsage,
  parseArgs,
  validateConfig
}
