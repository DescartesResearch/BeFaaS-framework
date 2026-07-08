const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function bundleAndZip (sourceDir, outputZip, options = {}) {
  const { entryPoint = 'index.js', minify = false } = options;

  console.log(`  Bundling ${sourceDir}...`);

  const buildDir = path.join(sourceDir, '_build');
  const entryFile = path.join(sourceDir, entryPoint);

  if (!fs.existsSync(entryFile)) {
    throw new Error(`Entry file not found: ${entryFile}`);
  }

  createBuildDir(buildDir)

  bundleWithNcc(entryFile, buildDir, minify, sourceDir)

  createMinimalPackageJson(sourceDir, buildDir)

  createZipFile(outputZip, buildDir, sourceDir)

  // Clean up build directory
  fs.rmSync(buildDir, { recursive: true });

  console.log(`  [OK] Created ${outputZip}`);
}

function installDependencies(dir, production = true) {
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    console.warn(`  No package.json found in ${dir}, skipping npm install`);
    return;
  }

  console.log(`  Installing dependencies in ${dir}...`);
  const platformFlags = '--arch=x64 --platform=linux --libc=glibc';
  const cmd = production
    ? `npm install --production ${platformFlags}`
    : `npm install ${platformFlags}`;

  try {
    execSync(cmd, { stdio: 'inherit', cwd: dir });
  } catch (error) {
    console.error(`Failed to install dependencies in ${dir}: ${error.message}`);
    throw error;
  }

  verifyNativePrebuilds(dir);
}

function verifyNativePrebuilds (dir) {
  const argon2Prebuilds = path.join(dir, 'node_modules', 'argon2', 'prebuilds');
  if (!fs.existsSync(argon2Prebuilds)) return;

  const platforms = fs.readdirSync(argon2Prebuilds);
  const hasLinux = platforms.some(p => p.startsWith('linux-x64'));
  if (!hasLinux) {
    throw new Error(
      `argon2 native binding missing linux-x64 prebuild in ${argon2Prebuilds} (got: ${platforms.join(', ')}). ` +
      'Lambda runtime is linux-x64 — a darwin/arm64 prebuild will fail at require time.'
    );
  }
}

function buildDockerImage (serviceDir, imageName, tag = 'latest') {
  if (!fs.existsSync(path.join(serviceDir, 'Dockerfile'))) {
    throw new Error(`Dockerfile not found in ${serviceDir}`);
  }

  console.log(`  Building Docker image ${imageName}:${tag}...`);

  try {
    execSync(`docker build -t ${imageName}:${tag} ${serviceDir}`, { stdio: 'inherit' });
    console.log(`  [OK] Built image ${imageName}:${tag}`);
  } catch (error) {
    console.error(`Failed to build Docker image: ${error.message}`);
    throw error;
  }
}

function pushDockerImage (imageName, tag = 'latest') {
  console.log(`  Pushing Docker image ${imageName}:${tag}...`);

  try {
    execSync(`docker push ${imageName}:${tag}`, { stdio: 'inherit' });
    console.log(`  [OK] Pushed image ${imageName}:${tag}`);
  } catch (error) {
    console.error(`Failed to push Docker image: ${error.message}`);
    throw error;
  }
}

function createZip (sourceDir, outputZip) {
  const outputDir = path.dirname(outputZip);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`  Creating zip: ${outputZip}`);
  try {
    execSync(`cd ${sourceDir} && zip -r ${path.resolve(outputZip)} .`, { stdio: 'pipe' });
    console.log(`  [OK] Created ${outputZip}`);
  } catch (error) {
    console.error(`Failed to create zip: ${error.message}`);
    throw error;
  }
}

function cleanDirectory (dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

function copyDirectoryRecursive (src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function createZipFile (outputZip, buildDir, sourceDir) {
  const outputDir = path.dirname(outputZip)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  console.log(`  Creating zip: ${outputZip}`)
  try {
    execSync(`cd ${buildDir} && zip -r ${path.resolve(outputZip)} .`, { stdio: 'pipe' })
  } catch (error) {
    console.error(`Failed to create zip for ${sourceDir}: ${error.message}`)
    throw error
  }
}

function createMinimalPackageJson (sourceDir, buildDir) {
  const packageJson = {
    name: path.basename(sourceDir),
    version: '1.0.0',
    main: 'index.js'
  }
  fs.writeFileSync(
    path.join(buildDir, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  )
}

function bundleWithNcc (entryFile, buildDir, minify, sourceDir) {
  const nccCmd = `npx ncc build ${entryFile} -o ${buildDir}${minify ? ' --minify' : ''}`
  try {
    execSync(nccCmd, { stdio: 'pipe', cwd: path.resolve('.') })
  } catch (error) {
    console.error(`Failed to bundle ${sourceDir}: ${error.message}`)
    throw error
  }
}

function createBuildDir (buildDir) {
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true })
  }
  fs.mkdirSync(buildDir, { recursive: true })
}

module.exports = {
  bundleAndZip,
  installDependencies,
  buildDockerImage,
  pushDockerImage,
  createZip,
  cleanDirectory,
  copyDirectoryRecursive
};
