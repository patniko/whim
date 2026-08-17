#!/usr/bin/env node
/*
 * Make sure native modules are built for whichever runtime is about to use
 * them, without anyone having to think about it.
 *
 *   node scripts/ensure-native.js node       # before vitest
 *   node scripts/ensure-native.js electron   # before the app
 *
 * Why this exists
 * ---------------
 * better-sqlite3 ships a compiled `.node` binary, and Node and Electron have
 * different ABIs (115 and 145 as of writing). A binary built for one crashes
 * the other with ERR_DLOPEN_FAILED.
 *
 * The previous approach wrote a marker file recording which runtime it had
 * last built for and skipped the rebuild when the marker matched. That marker
 * recorded *intent*, not reality, so anything that rebuilt the binary behind
 * its back desynced it — `npm install`, `npm ci`, `npm rebuild`, a dependency
 * bump, or the postinstall hook. The failure mode was nasty: the script would
 * cheerfully print "already built for Electron", and the app would then die on
 * launch with an opaque dlopen error.
 *
 * So this doesn't track state at all. It asks the runtime that actually
 * matters whether it can load the module, which is the only question anyone
 * cares about and cannot go stale.
 *
 * Rebuilding takes a minute or so, which would be miserable to pay on every
 * switch between `npm test` and `npm start`. Successful builds are therefore
 * cached per ABI, so the second and subsequent switches are a file copy.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * `npm` and `npx` are shell shims on Windows (`npm.cmd`, `npx.cmd`), and
 * `execFileSync` does no PATHEXT resolution — asking for the bare name there
 * fails with ENOENT before the build ever starts.
 */
function npmBin(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

/**
 * Native modules that must match the host runtime's ABI.
 *
 * `probe` has to *exercise* the binding, not merely require the package.
 * better-sqlite3 resolves its `.node` file lazily on first use, so a bare
 * `require()` succeeds even against a binary built for a different ABI — a
 * check written that way passes while the app is moments from dying.
 */
const NATIVE_MODULES = [
  {
    name: 'better-sqlite3',
    binary: 'better_sqlite3.node',
    probe: "new (require('better-sqlite3'))(':memory:').close();",
  },
];

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', 'whim-native');

function log(message) {
  console.log(`[native] ${message}`);
}

/** Absolute path to the Electron executable, or null if it isn't installed. */
function electronBinary() {
  try {
    const resolved = require(path.join(ROOT, 'node_modules', 'electron'));
    return typeof resolved === 'string' && fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Run a snippet under the target runtime. Electron is invoked with
 * ELECTRON_RUN_AS_NODE so it behaves as a plain Node process — no window, no
 * app lifecycle — while still using Electron's ABI, which is the thing being
 * tested.
 */
function runIn(target, script) {
  if (target === 'node') {
    return spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf-8' });
  }
  const binary = electronBinary();
  if (!binary) return { status: 1, stderr: 'Electron is not installed.', stdout: '' };
  return spawnSync(binary, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

function abiFor(target) {
  const result = runIn(target, 'process.stdout.write(process.versions.modules)');
  const abi = (result.stdout || '').trim();
  if (result.status !== 0 || !abi) {
    throw new Error(`Could not determine the ${target} ABI: ${(result.stderr || '').trim() || 'no output'}`);
  }
  return abi;
}

/** The only question that matters: can this runtime actually use the module? */
function canLoad(target, moduleEntry) {
  const script = `try { ${moduleEntry.probe} } catch (err) { process.exit(1); }`;
  return runIn(target, script).status === 0;
}

function binaryPath(moduleName, binary) {
  return path.join(ROOT, 'node_modules', moduleName, 'build', 'Release', binary);
}

function cachePath(moduleName, abi) {
  return path.join(CACHE_DIR, `${moduleName.replace(/[/\\]/g, '-')}-abi${abi}-${process.arch}.node`);
}

function saveToCache(moduleName, binary, abi) {
  const built = binaryPath(moduleName, binary);
  if (!fs.existsSync(built)) return;
  const destination = cachePath(moduleName, abi);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(built, destination);
}

function restoreFromCache(moduleName, binary, abi) {
  const cached = cachePath(moduleName, abi);
  if (!fs.existsSync(cached)) return false;
  const destination = binaryPath(moduleName, binary);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(cached, destination);
  return true;
}

function build(target, moduleName) {
  const cwd = path.join(ROOT, 'node_modules', moduleName);

  if (target === 'node') {
    // npm resolves `node` from PATH, which is not necessarily the interpreter
    // running this script — and if they differ, the build silently targets the
    // wrong ABI. Put our own interpreter first so they cannot disagree.
    const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
    execFileSync(npmBin('npm'), ['rebuild', moduleName], { cwd: ROOT, stdio: 'pipe', env });
    return;
  }

  const version = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
  execFileSync(
    npmBin('npx'),
    [
      '--yes', 'node-gyp', 'rebuild',
      `--target=${version}`,
      `--arch=${process.arch}`,
      '--dist-url=https://electronjs.org/headers',
      '--runtime=electron',
    ],
    { cwd, stdio: 'pipe' },
  );
}

/**
 * The binary we are about to overwrite was built for *something*. If that
 * something is the other runtime, cache it before it's clobbered — otherwise
 * the first switch after a fresh `npm install` throws away a perfectly good
 * build and pays to recreate it later.
 */
function preserveExistingBinary(target, moduleEntry) {
  const other = target === 'node' ? 'electron' : 'node';
  if (other === 'electron' && !electronBinary()) return;
  if (!canLoad(other, moduleEntry)) return;
  try {
    saveToCache(moduleEntry.name, moduleEntry.binary, abiFor(other));
  } catch {
    // Best-effort: losing the old binary only costs a rebuild.
  }
}

function ensure(target, moduleEntry) {
  const { name, binary } = moduleEntry;

  if (!fs.existsSync(path.join(ROOT, 'node_modules', name))) {
    log(`${name} is not installed — skipping.`);
    return;
  }

  if (canLoad(target, moduleEntry)) return;

  const abi = abiFor(target);

  // A previous build for this ABI is just a file copy away.
  if (restoreFromCache(name, binary, abi) && canLoad(target, moduleEntry)) {
    log(`${name} restored from cache for ${target} (ABI ${abi}).`);
    return;
  }

  process.stdout.write(`[native] Building ${name} for ${target} (ABI ${abi})... `);
  preserveExistingBinary(target, moduleEntry);
  try {
    build(target, name);
  } catch (err) {
    console.log('failed');
    const detail = (err.stderr?.toString() || err.message || '').split('\n').slice(0, 5).join('\n');
    // A running app holds the .node file open, which is by far the most
    // common reason this fails. Say so instead of dumping a gyp trace.
    if (/EBUSY|ETXTBSY|Resource busy/i.test(detail)) {
      throw new Error(`Could not rebuild ${name}: the file is in use. Quit the running whim app and try again.`);
    }
    throw new Error(`Could not rebuild ${name} for ${target}:\n${detail}`);
  }

  if (!canLoad(target, moduleEntry)) {
    throw new Error(`${name} still cannot be loaded by ${target} after rebuilding.`);
  }

  saveToCache(name, binary, abi);
  console.log('done');
}

function main() {
  const target = process.argv[2];
  if (target !== 'node' && target !== 'electron') {
    console.error('Usage: node scripts/ensure-native.js <node|electron>');
    process.exit(1);
  }

  if (target === 'electron' && !electronBinary()) {
    log('Electron is not installed — skipping.');
    return;
  }

  for (const moduleEntry of NATIVE_MODULES) {
    ensure(target, moduleEntry);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[native] ${err.message}`);
    process.exit(1);
  }
}

module.exports = { abiFor, canLoad, cachePath, electronBinary, NATIVE_MODULES };
