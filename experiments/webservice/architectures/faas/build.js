const fs = require('fs');
const path = require('path');
const { copyDirectoryRecursive } = require('../shared/buildUtils');

function buildFrontendFunction (useCaseDir, tmpDir, useCase) {
  copyDirectoryRecursive(useCaseDir, tmpDir)

  const packagePath = path.join(__dirname, 'package.json')
  const destPackagePath = path.join(tmpDir, 'package.json')
  fs.copyFileSync(packagePath, destPackagePath)

  const sharedDir = path.join(__dirname, '..', 'shared')
  const destSharedDir = path.join(tmpDir, 'shared')
  if (!fs.existsSync(destSharedDir)) {
    fs.mkdirSync(destSharedDir, { recursive: true })
  }
  const frontendSharedFiles = ['metrics.js']
  for (const file of frontendSharedFiles) {
    const srcPath = path.join(sharedDir, file)
    const destPath = path.join(destSharedDir, file)
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath)
      console.log(`  [OK] Copied shared/${file}`)
    }
  }

  const experimentJsonPath = path.join(__dirname, '..', '..', 'experiment.json')
  const destExperimentJsonPath = path.join(tmpDir, 'experiment.json')
  if (fs.existsSync(experimentJsonPath)) {
    fs.copyFileSync(experimentJsonPath, destExperimentJsonPath)
  } else {
    console.warn(`  Warning:  Warning: experiment.json not found at ${experimentJsonPath}`)
  }

  console.log(`Build complete for ${useCase} in ${tmpDir}`)
}

function copyIndexJs (tmpDir) {
  const indexPath = path.join(__dirname, 'index.js')
  const destIndexPath = path.join(tmpDir, 'index.js')
  fs.copyFileSync(indexPath, destIndexPath)

  // 1. Copy ./restHandler.js to tmpDir (REST handler with conditional auth)
  const restHandlerPath = path.join(__dirname, 'restHandler.js')
  const destRestHandlerPath = path.join(tmpDir, 'restHandler.js')
  fs.copyFileSync(restHandlerPath, destRestHandlerPath)

  // 2. Copy ./call.js to tmpDir (FaaS call provider with direct Lambda invocation)
  const callPath = path.join(__dirname, 'call.js')
  const destCallPath = path.join(tmpDir, 'call.js')
  fs.copyFileSync(callPath, destCallPath)

  // 3. Copy shared modules to tmpDir/shared/ (required by restHandler.js and call.js)
  const sharedDir = path.join(__dirname, '..', 'shared')
  const destSharedDir = path.join(tmpDir, 'shared')
  if (!fs.existsSync(destSharedDir)) {
    fs.mkdirSync(destSharedDir, { recursive: true })
  }

  const sharedFiles = ['authConfig.js', 'call.js', 'serviceConfig.js', 'metrics.js']
  for (const file of sharedFiles) {
    const srcPath = path.join(sharedDir, file)
    const destPath = path.join(destSharedDir, file)
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath)
      console.log(`  [OK] Copied shared/${file}`)
    }
  }
}

function copyUseCase (authStrategy, algorithm, useCase, useCaseDir, tmpDir) {
  const authOverrideFunctions = ['login', 'register']
  let authStrategyDir = path.join(__dirname, '..', '..', 'authentication', authStrategy)
  if (algorithm) {
    authStrategyDir = path.join(authStrategyDir, 'algorithms', algorithm)
  }

  let useCasePath
  if (authOverrideFunctions.includes(useCase)) {

    // Check if the auth strategy has a custom handler for this function
    const customHandlerPath = path.join(authStrategyDir, `${useCase}.js`)
    if (fs.existsSync(customHandlerPath)) {
      useCasePath = customHandlerPath
      console.log(`  Using custom ${useCase} handler from '${authStrategy}' auth strategy`)
    } else {
      useCasePath = path.join(useCaseDir, 'index.js')
      console.log(`  Using default ${useCase} handler (no custom handler for '${authStrategy}')`)
    }
  } else {
    useCasePath = path.join(useCaseDir, 'index.js')
  }

  const handlerPath = path.join(tmpDir, 'handler.js')

  let handlerCode = fs.readFileSync(useCasePath, 'utf8')

  handlerCode = handlerCode.replace(/require\(['"]\.\.\/\.\.\/([^'"]+)['"]\)/g, 'require(\'./$1\')')

  fs.writeFileSync(handlerPath, handlerCode, 'utf8')
  return authStrategyDir
}

function copyAuthStrategy (tmpDir, authStrategyDir) {
  const authDir = path.join(tmpDir, 'auth')
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true })
  }

  const authFiles = fs.readdirSync(authStrategyDir)

  authFiles.forEach(file => {
    const srcPath = path.join(authStrategyDir, file)
    const destPath = path.join(authDir, file)
    if (fs.statSync(srcPath).isFile()) {
      fs.copyFileSync(srcPath, destPath)
    }
  })
}

function copySharedModules (useCase, tmpDir) {
  const sharedModuleDeps = {
    'currency': ['currency/exchangerates.js'],
    'supportedcurrencies': ['currency/exchangerates.js'],
    'getproduct': ['productcatalog/products.js'],
    'listproducts': ['productcatalog/products.js'],
    'searchproducts': ['productcatalog/products.js']
  }

  if (sharedModuleDeps[useCase]) {
    console.log(`  Copying shared modules for ${useCase}...`)

    for (const modulePath of sharedModuleDeps[useCase]) {
      const parts = modulePath.split('/')
      const moduleDir = parts[0]
      const moduleFile = parts[1]

      const destModuleDir = path.join(tmpDir, moduleDir)
      if (!fs.existsSync(destModuleDir)) {
        fs.mkdirSync(destModuleDir, { recursive: true })
      }

      const srcModulePath = path.join(__dirname, '..', '..', modulePath)
      const destModulePath = path.join(destModuleDir, moduleFile)

      if (fs.existsSync(srcModulePath)) {
        fs.copyFileSync(srcModulePath, destModulePath)
        console.log(`    [OK] Copied ${modulePath}`)
      } else {
        console.warn(`    Warning:  Warning: Shared module not found: ${srcModulePath}`)
      }
    }
  }
}

async function buildSingleFunction(useCase, tmpDir, authStrategy, algorithm) {
  console.log(`Building FaaS architecture for use case: ${useCase}`);

  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const useCaseDir = path.join(__dirname, '..', '..', 'functions', useCase);

  // Special handling for frontend function (uses router pattern)
  if (useCase === 'frontend') {
    buildFrontendFunction(useCaseDir, tmpDir, useCase)
    return;
  }

  // 1. Copy index.js, restHandler.js, call.js and shared modules
  copyIndexJs(tmpDir)

  // 2. Copy ./package.json to tmpDir
  const packagePath = path.join(__dirname, 'package.json');
  const destPackagePath = path.join(tmpDir, 'package.json');
  fs.copyFileSync(packagePath, destPackagePath);

  // 3. Copy the usecase handler and auth strategy
  const authStrategyDir = copyUseCase(authStrategy, algorithm, useCase, useCaseDir, tmpDir)
  copyAuthStrategy(tmpDir, authStrategyDir)

  // 4. Copy shared modules that this function depends on
  copySharedModules(useCase, tmpDir)

  // 5. Copy experiment.json to tmpDir
  const experimentJsonPath = path.join(__dirname, '..', '..', 'experiment.json');
  const destExperimentJsonPath = path.join(tmpDir, 'experiment.json');
  if (fs.existsSync(experimentJsonPath)) {
    fs.copyFileSync(experimentJsonPath, destExperimentJsonPath);
  } else {
    console.warn(`  Warning:  Warning: experiment.json not found at ${experimentJsonPath}`);
  }

  console.log(`Build complete for ${useCase} in ${tmpDir}`);
}

async function build(tmpDir, authStrategy, algorithm = null) {
  console.log(`Building FaaS architecture with auth strategy: ${authStrategy}${algorithm ? `, algorithm: ${algorithm}` : ''}`);

  const experimentJsonPath = path.join(__dirname, '..', '..', 'experiment.json');
  const experimentConfig = JSON.parse(fs.readFileSync(experimentJsonPath, 'utf8'));
  const useCases = Object.keys(experimentConfig.program.functions);
  console.log(`Building ${useCases.length} functions from experiment.json: ${useCases.join(', ')}`);

  for (const useCase of useCases) {
    const functionDir = path.join(tmpDir, useCase);
    await buildSingleFunction(useCase, functionDir, authStrategy, algorithm);
  }

  console.log(`Build complete for all functions in ${tmpDir}`);
}

module.exports = build;

// Allow running as a standalone script
if (require.main === module) {
  const outputDir = process.argv[2] || path.join(__dirname, '_build');
  const authStrategy = process.argv[3] || 'none';
  const algorithm = process.argv[4] || null;

  console.log(`Running build with auth: ${authStrategy}, output: ${outputDir}${algorithm ? `, algorithm: ${algorithm}` : ''}`);
  build(outputDir, authStrategy, algorithm)
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Build failed:', error);
      process.exit(1);
    });
}