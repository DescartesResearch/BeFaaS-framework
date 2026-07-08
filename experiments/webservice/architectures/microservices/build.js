const fs = require('fs');
const path = require('path');

const services = {
  'cart-service': {
    functions: ['getcart', 'addcartitem', 'emptycart', 'cartkvstorage'],
    dependencies: {
      '@befaas/lib': '*',
      express: '^4.18.2',
      lodash: '^4.17.21',
      ioredis: '^5.3.2',
      'aws-sdk': '^2.1400.0',
      'aws-jwt-verify': '^4.0.0',
      axios: '^1.4.0',
      jose: '^5.2.0',
      jsonwebtoken: '^9.0.2'
    },
    port: 3002
  },
  'content-service': {
    functions: ['getads', 'supportedcurrencies', 'currency'],
    copyCurrencyModule: true,
    dependencies: {
      '@befaas/lib': '*',
      express: '^4.18.2',
      'aws-sdk': '^2.1400.0',
      axios: '^1.4.0'
    },
    port: 3004
  },
  'frontend-service': {
    functions: ['login', 'register'],
    copyFrontendHandlers: true,
    dependencies: {
      '@aws-sdk/client-cognito-identity-provider': '^3.705.0',
      '@befaas/lib': '*',
      '@smithy/node-http-handler': '^3.3.2',
      argon2: '^0.41.1',
      axios: '^1.4.0',
      bcryptjs: '^2.4.3',
      'cookie-parser': '^1.4.6',
      express: '^4.18.2',
      ioredis: '^5.3.2',
      jose: '^5.2.0',
      jsonwebtoken: '^9.0.2',
      lodash: '^4.17.21',
      nunjucks: '^3.2.4'
    },
    port: 3000
  },
  'order-service': {
    functions: ['checkout', 'payment', 'shipmentquote', 'shiporder', 'email'],
    dependencies: {
      '@befaas/lib': '*',
      express: '^4.18.2',
      'aws-sdk': '^2.1400.0',
      'aws-jwt-verify': '^4.0.0',
      'card-validator': '^8.1.1',
      axios: '^1.4.0',
      jose: '^5.2.0',
      jsonwebtoken: '^9.0.2'
    },
    port: 3003
  },
  'product-service': {
    functions: ['getproduct', 'listproducts', 'searchproducts', 'listrecommendations'],
    copyProductCatalog: true,
    dependencies: {
      '@befaas/lib': '*',
      express: '^4.18.2',
      lodash: '^4.17.21',
      'aws-sdk': '^2.1400.0',
      axios: '^1.4.0'
    },
    port: 3001
  }
};

function copyFunctionToService (functionName, serviceDir, authStrategy, algorithm) {
  const functionsDir = path.join(serviceDir, 'functions');
  const functionDir = path.join(functionsDir, functionName);

  if (!fs.existsSync(functionDir)) {
    fs.mkdirSync(functionDir, { recursive: true });
  }

  const authMockFunctions = ['login', 'register'];
  let authStrategyDir = path.join(__dirname, '..', '..', 'authentication', authStrategy);
  if (algorithm) {
    authStrategyDir = path.join(authStrategyDir, 'algorithms', algorithm);
  }

  let srcPath;
  if (authMockFunctions.includes(functionName)) {
    const customHandlerPath = path.join(authStrategyDir, `${functionName}.js`);
    if (fs.existsSync(customHandlerPath)) {
      srcPath = customHandlerPath;
      console.log(`    Using custom ${functionName} handler from '${authStrategy}' auth strategy`);
    } else {
      srcPath = path.join(__dirname, '..', '..', 'functions', functionName, 'index.js');
      console.log(`    Using default ${functionName} handler (no custom handler for '${authStrategy}')`);
    }
  } else {
    srcPath = path.join(__dirname, '..', '..', 'functions', functionName, 'index.js');
  }

  const destPath = path.join(functionDir, 'index.js');

  fs.copyFileSync(srcPath, destPath);

  const content = fs.readFileSync(srcPath, 'utf8');

  if (content.includes("require('./auth')")) {
    const authSrcFile = path.join(authStrategyDir, 'index.js');
    const authDestFile = path.join(functionDir, 'auth.js');
    if (fs.existsSync(authSrcFile)) {
      fs.copyFileSync(authSrcFile, authDestFile);
    }
  }
}

function copyAuthStrategy (serviceDir, authStrategy, algorithm) {
  const authDir = path.join(serviceDir, 'auth');
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  let authStrategyDir = path.join(__dirname, '..', '..', 'authentication', authStrategy);
  if (algorithm) {
    authStrategyDir = path.join(authStrategyDir, 'algorithms', algorithm);
  }
  const authFiles = fs.readdirSync(authStrategyDir);

  authFiles.forEach(file => {
    const srcPath = path.join(authStrategyDir, file);
    const destPath = path.join(authDir, file);
    if (fs.statSync(srcPath).isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  });
}

function copySharedModules (serviceDir) {
  const sharedDir = path.join(serviceDir, 'shared');
  if (!fs.existsSync(sharedDir)) {
    fs.mkdirSync(sharedDir, { recursive: true });
  }

  // Copy microservices-specific shared files
  const sharedSrcDir = path.join(__dirname, 'shared');
  const sharedFiles = fs.readdirSync(sharedSrcDir);

  sharedFiles.forEach(file => {
    const srcPath = path.join(sharedSrcDir, file);
    const destPath = path.join(sharedDir, file);
    if (fs.statSync(srcPath).isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  });

  // Copy architectures-level shared utilities (call.js, serviceConfig.js) to shared/arch-shared/
  const archSharedSrcDir = path.join(__dirname, '..', 'shared');
  const archSharedDestDir = path.join(sharedDir, 'arch-shared');
  if (!fs.existsSync(archSharedDestDir)) {
    fs.mkdirSync(archSharedDestDir, { recursive: true });
  }

  const archSharedFiles = ['call.js', 'serviceConfig.js', 'authConfig.js', 'metrics.js'];
  archSharedFiles.forEach(file => {
    const srcPath = path.join(archSharedSrcDir, file);
    const destPath = path.join(archSharedDestDir, file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      console.log(`    Copied arch-shared/${file}`);
    }
  });
}

function copyCurrencyModule (serviceDir) {
  const currencySrcDir = path.join(__dirname, '..', '..', 'currency');
  const currencyDestDir = path.join(serviceDir, 'currency');

  if (!fs.existsSync(currencyDestDir)) {
    fs.mkdirSync(currencyDestDir, { recursive: true });
  }

  const exchangeRatesSrc = path.join(currencySrcDir, 'exchangerates.js');
  const exchangeRatesDest = path.join(currencyDestDir, 'exchangerates.js');

  if (fs.existsSync(exchangeRatesSrc)) {
    fs.copyFileSync(exchangeRatesSrc, exchangeRatesDest);
    console.log('    Copied currency/exchangerates.js');
  }
}

function copyProductCatalog (serviceDir) {
  const productSrcDir = path.join(__dirname, '..', '..', 'productcatalog');
  const productDestDir = path.join(serviceDir, 'productcatalog');

  if (!fs.existsSync(productDestDir)) {
    fs.mkdirSync(productDestDir, { recursive: true });
  }

  const productsSrc = path.join(productSrcDir, 'products.js');
  const productsDest = path.join(productDestDir, 'products.js');

  if (fs.existsSync(productsSrc)) {
    fs.copyFileSync(productsSrc, productsDest);
    console.log('    Copied productcatalog/products.js');
  }
}

function copyFrontendHandlers(serviceDir) {
  const frontendSrcDir = path.join(__dirname, '..', '..', 'functions', 'frontend');
  const frontendDestDir = path.join(serviceDir, 'functions', 'frontend');

  if (!fs.existsSync(frontendDestDir)) {
    fs.mkdirSync(frontendDestDir, { recursive: true });
  }

  const handlersSrc = path.join(frontendSrcDir, 'handlers.js');
  const handlersDest = path.join(frontendDestDir, 'handlers.js');
  fs.copyFileSync(handlersSrc, handlersDest);

  const templatesSrcDir = path.join(frontendSrcDir, 'html_templates');
  const templatesDestDir = path.join(frontendDestDir, 'html_templates');

  if (!fs.existsSync(templatesDestDir)) {
    fs.mkdirSync(templatesDestDir, { recursive: true });
  }

  const templateFiles = fs.readdirSync(templatesSrcDir);
  templateFiles.forEach(file => {
    const srcPath = path.join(templatesSrcDir, file);
    const destPath = path.join(templatesDestDir, file);
    if (fs.statSync(srcPath).isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  });

  console.log('    Copied frontend handlers and templates');
}

function copyDockerfile (serviceName, serviceDir) {
  const dockerfileSrc = path.join(__dirname, serviceName, 'Dockerfile');
  const dockerfileDest = path.join(serviceDir, 'Dockerfile');

  if (fs.existsSync(dockerfileSrc)) {
    fs.copyFileSync(dockerfileSrc, dockerfileDest);
  } else {
    const defaultDockerfile = `# Multi-stage build for ${serviceName}
FROM node:18-alpine AS base

# Build stage
FROM base AS builder
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Runtime stage
FROM base AS runner
WORKDIR /app

# Install curl for healthchecks
RUN apk add --no-cache curl

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy service code
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV PORT=${services[serviceName].port}

# Expose service port
EXPOSE ${services[serviceName].port}

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD curl -f http://localhost:${services[serviceName].port}/health || exit 1

# Start the service
CMD ["node", "index.js"]
`;
    fs.writeFileSync(dockerfileDest, defaultDockerfile);
  }
}

function buildService (serviceName, serviceConfig, tmpDir, authStrategy, algorithm) {
  console.log(`  Building ${serviceName}...`);

  const serviceDir = path.join(tmpDir, serviceName);
  const functionsDir = path.join(serviceDir, 'functions');

  if (!fs.existsSync(functionsDir)) {
    fs.mkdirSync(functionsDir, { recursive: true });
  }

  const serviceIndexPath = path.join(__dirname, serviceName, 'index.js');
  const destServiceIndexPath = path.join(serviceDir, 'index.js');
  fs.copyFileSync(serviceIndexPath, destServiceIndexPath);

  copyDockerfile(serviceName, serviceDir);

  serviceConfig.functions.forEach(functionName => {
    copyFunctionToService(functionName, serviceDir, authStrategy, algorithm);
  });

  if (serviceConfig.copyFrontendHandlers) {
    copyFrontendHandlers(serviceDir);
  }

  if (serviceConfig.copyCurrencyModule) {
    copyCurrencyModule(serviceDir);
  }

  if (serviceConfig.copyProductCatalog) {
    copyProductCatalog(serviceDir);
  }

  copySharedModules(serviceDir);

  copyAuthStrategy(serviceDir, authStrategy, algorithm);

  const packageJson = {
    name: serviceName,
    version: '1.0.0',
    description: `${serviceName} microservice`,
    main: 'index.js',
    dependencies: serviceConfig.dependencies,
    scripts: {
      start: 'node index.js'
    }
  };

  const packageJsonPath = path.join(serviceDir, 'package.json');
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
}

async function build (tmpDir, authStrategy, bundleMode = 'minimal', algorithm = null) {
  console.log(`Building Microservices architecture for use case${algorithm ? ` (algorithm: ${algorithm})` : ''}`);

  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  Object.entries(services).forEach(([serviceName, serviceConfig]) => {
    buildService(serviceName, serviceConfig, tmpDir, authStrategy, algorithm);
  });

  console.log(`Build complete for Microservices in ${tmpDir}`);
}

module.exports = build;

if (require.main === module) {
  const outputDir = process.argv[2] || path.join(__dirname, '_build');
  const authStrategy = process.argv[3] || 'none';
  const algorithm = process.argv[4] || null;

  console.log(`Running build with auth: ${authStrategy}, output: ${outputDir}${algorithm ? `, algorithm: ${algorithm}` : ''}`);
  build(outputDir, authStrategy, 'minimal', algorithm)
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Build failed:', error);
      process.exit(1);
    });
}
