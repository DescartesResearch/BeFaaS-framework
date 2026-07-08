const fs = require('fs');
const path = require('path');
const { logSection } = require('./utils');

async function runBuild(experiment, architecture, auth, algorithm = null) {
  logSection(`Building ${experiment}/${architecture} architecture with ${auth} auth${algorithm ? ` (algorithm: ${algorithm})` : ''}`);

  const projectRoot = path.join(__dirname, '..', '..');
  const buildScript = path.join(projectRoot, 'experiments', experiment, 'architectures', architecture, 'build.js');

  if (!fs.existsSync(buildScript)) {
    throw new Error(`Build script not found: ${buildScript}`);
  }

  const build = require(buildScript);
  const tmpDir = path.join(projectRoot, 'experiments', experiment, 'architectures', architecture, '_build');

  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }

  await build(tmpDir, auth, algorithm);

  console.log(`[OK] Build completed successfully`);
  return tmpDir;
}

module.exports = {
  runBuild
};
