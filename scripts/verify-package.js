const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const platformIndex = args.indexOf('--platform');
const platform = platformIndex === -1 ? process.platform : args[platformIndex + 1];
const buildDirIndex = args.indexOf('--build-dir');
const buildDir = buildDirIndex === -1
  ? path.resolve(__dirname, '..', 'build')
  : path.resolve(args[buildDirIndex + 1]);
const { getCopilotPlatformEntrypoints, getBundledSdkRuntimePaths } = require('../dist/main/copilot-runtime-path');

const macDirectory = fs.existsSync(buildDir)
  ? fs.readdirSync(buildDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
      .map((entry) => path.join(buildDir, entry.name, 'whim.app'))
      .find((candidate) => fs.existsSync(candidate))
  : undefined;

function findCopilotRuntime(resourcesDirectory, targetPlatform) {
  const unpackedApp = path.join(resourcesDirectory, 'app.asar.unpacked');
  const candidates = getCopilotPlatformEntrypoints(targetPlatform, process.arch)
    .map((entrypoint) => path.join(unpackedApp, entrypoint.appRelativePath));
  return candidates.find((candidate) => fs.existsSync(candidate));
}

const macResources = macDirectory && path.join(macDirectory, 'Contents', 'Resources');
const winResources = path.join(buildDir, 'win-unpacked', 'resources');
const macCopilotRuntime = macResources && findCopilotRuntime(macResources, 'darwin');
const winCopilotRuntime = findCopilotRuntime(winResources, 'win32');
const macSdkRuntime = macResources && getBundledSdkRuntimePaths(path.join(macResources, 'app.asar'), 'darwin');
const winSdkRuntime = getBundledSdkRuntimePaths(path.join(winResources, 'app.asar'), 'win32');
const checks = {
  mac: [
    macDirectory && path.join(macDirectory, 'Contents', 'MacOS', 'whim'),
    macResources && path.join(macResources, 'app.asar'),
    macResources && path.join(macResources, 'assets'),
    macResources && path.join(macResources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    macCopilotRuntime,
    macSdkRuntime && macSdkRuntime.executable,
    macSdkRuntime && macSdkRuntime.library,
  ],
  win: [
    path.join(buildDir, 'win-unpacked', 'whim.exe'),
    path.join(winResources, 'app.asar'),
    path.join(winResources, 'assets'),
    path.join(winResources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    winCopilotRuntime,
    winSdkRuntime.executable,
    winSdkRuntime.library,
  ],
};

if (!checks[platform]) {
  throw new Error(`Unsupported package platform: ${platform}`);
}

const missing = checks[platform].filter((file) => !file || !fs.existsSync(file));
if (missing.length > 0) {
  throw new Error(`Packaged application is missing:\n${missing.join('\n')}`);
}

const copilotRuntime = platform === 'mac' ? macCopilotRuntime : winCopilotRuntime;
const appExecutable = platform === 'mac'
  ? path.join(macDirectory, 'Contents', 'MacOS', 'whim')
  : path.join(buildDir, 'win-unpacked', 'whim.exe');
const runtimeCheck = spawnSync(appExecutable, [copilotRuntime, '--version'], {
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
if (runtimeCheck.status !== 0) {
  throw new Error(`Packaged Copilot runtime failed to start:\n${runtimeCheck.stderr || runtimeCheck.error}`);
}

const appArchive = path.join(platform === 'mac' ? macResources : winResources, 'app.asar');
for (const transport of ['stdio', 'inprocess']) {
  const result = spawnSync(appExecutable, [path.join(__dirname, 'smoke-sdk-runtime.js'), appArchive, transport], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 45_000,
  });
  if (result.status !== 0) {
    throw new Error(`Packaged SDK ${transport} failed:\n${result.stderr || result.error}\n${result.stdout}`);
  }
  console.log(result.stdout.trim());
}

console.log(`Packaged ${platform} application contains its executable, app.asar, assets, native database module, full CLI, and SDK runtime`);
console.log(runtimeCheck.stdout.trim());
