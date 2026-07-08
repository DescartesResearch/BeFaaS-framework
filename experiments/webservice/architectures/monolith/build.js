const fs = require('fs');
const path = require('path');
const { copyDirectoryRecursive } = require('../shared/buildUtils');

function createFunctionsDir (tmpDir, authStrategy, algorithm) {
  const functionsDir = path.join(tmpDir, 'functions')
  if (!fs.existsSync(functionsDir)) {
    fs.mkdirSync(functionsDir, { recursive: true })
  }

  const sourceFunctionsDir = path.join(__dirname, '..', '..', 'functions')
  const functionNames = fs.readdirSync(sourceFunctionsDir).filter(file => {
    const fullPath = path.join(sourceFunctionsDir, file)
    return fs.statSync(fullPath).isDirectory()
  })

  // Get auth strategy files
  let authStrategyDir = path.join(__dirname, '..', '..', 'authentication', authStrategy)
  if (algorithm) {
    authStrategyDir = path.join(authStrategyDir, 'algorithms', algorithm)
  }
  const authFiles = fs.readdirSync(authStrategyDir).filter(file => {
    return fs.statSync(path.join(authStrategyDir, file)).isFile()
  })

  // Functions that should use mock handlers in 'none' auth mode
  const authMockFunctions = ['login', 'register']

  console.log(`  Copying ${functionNames.length} functions...`)
  functionNames.forEach(functionName => {
    const srcFunctionDir = path.join(sourceFunctionsDir, functionName)
    const destFunctionDir = path.join(functionsDir, functionName)

    copyDirectoryRecursive(srcFunctionDir, destFunctionDir)

    // For auth strategies with custom login/register handlers, use those instead of default Cognito handlers
    if (authMockFunctions.includes(functionName)) {
      const customHandlerPath = path.join(authStrategyDir, `${functionName}.js`)
      if (fs.existsSync(customHandlerPath)) {
        const destIndexPath = path.join(destFunctionDir, 'index.js')
        fs.copyFileSync(customHandlerPath, destIndexPath)
        console.log(`    Using custom ${functionName} handler from '${authStrategy}' auth strategy`)
      }
    }

    // Copy auth files into each function's directory (functions use require('./auth'))
    const destAuthDir = path.join(destFunctionDir, 'auth')
    if (!fs.existsSync(destAuthDir)) {
      fs.mkdirSync(destAuthDir, { recursive: true })
    }
    authFiles.forEach(file => {
      const srcPath = path.join(authStrategyDir, file)
      const destPath = path.join(destAuthDir, file)
      fs.copyFileSync(srcPath, destPath)
    })
  })
  return { authStrategyDir, authFiles }
}

async function build(tmpDir, authStrategy, bundleMode = 'minimal', algorithm = null) {
  console.log(`Building Monolith architecture with auth strategy: ${authStrategy}${algorithm ? `, algorithm: ${algorithm}` : ''}`);

  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  // 1. Copy index.js and call.js
  const indexPath = path.join(__dirname, 'index.js');
  const destIndexPath = path.join(tmpDir, 'index.js');
  fs.copyFileSync(indexPath, destIndexPath);

  const callPath = path.join(__dirname, 'call.js');
  const destCallPath = path.join(tmpDir, 'call.js');
  fs.copyFileSync(callPath, destCallPath);

  // 2. Copy package.json
  const packagePath = path.join(__dirname, 'package.json');
  const destPackagePath = path.join(tmpDir, 'package.json');
  fs.copyFileSync(packagePath, destPackagePath);

  // 3. Copy Dockerfile if exists
  const dockerfilePath = path.join(__dirname, 'Dockerfile');
  if (fs.existsSync(dockerfilePath)) {
    const destDockerfilePath = path.join(tmpDir, 'Dockerfile');
    fs.copyFileSync(dockerfilePath, destDockerfilePath);
  }

  // 4. Create functions directory and copy all functions (including subdirectories like html_templates)
  const { authStrategyDir, authFiles } = createFunctionsDir(tmpDir, authStrategy, algorithm)

  // 5. Copy the auth strategy to root level too (for any top-level auth imports)
  const authDir = path.join(tmpDir, 'auth');
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  authFiles.forEach(file => {
    const srcPath = path.join(authStrategyDir, file);
    const destPath = path.join(authDir, file);
    fs.copyFileSync(srcPath, destPath);
  });

  // 6. Copy productcatalog data (used by product-related functions)
  const productcatalogSrc = path.join(__dirname, '..', '..', 'productcatalog');
  const productcatalogDest = path.join(tmpDir, 'productcatalog');
  if (fs.existsSync(productcatalogSrc)) {
    console.log('  Copying productcatalog...');
    copyDirectoryRecursive(productcatalogSrc, productcatalogDest);
  }

  // 7. Copy currency data (used by currency functions)
  const currencySrc = path.join(__dirname, '..', '..', 'currency');
  const currencyDest = path.join(tmpDir, 'currency');
  if (fs.existsSync(currencySrc)) {
    console.log('  Copying currency data...');
    copyDirectoryRecursive(currencySrc, currencyDest);
  }

  // 8. Copy shared utilities (call.js requires ../shared/call)
  const sharedSrc = path.join(__dirname, '..', 'shared');
  const sharedDest = path.join(tmpDir, 'shared');
  if (fs.existsSync(sharedSrc)) {
    console.log('  Copying shared utilities...');
    copyDirectoryRecursive(sharedSrc, sharedDest);
  }

  console.log(`Build complete for Monolith in ${tmpDir}`);
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
