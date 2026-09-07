const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { assertPreloadSelfContained, mergeWorkerOptions, fingerprintMergeWorkers, rendererOptions, webOptions, writeAssetManifest } = require('./build-renderer');

function fixture(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preload-guard-'));
  const file = path.join(dir, 'preload.js');
  fs.writeFileSync(file, contents);
  return file;
}

/*
 * A sandboxed preload can only require what the sandbox provides. When tsc's
 * unbundled output shipped instead of a bundle, the preload failed to load,
 * window.whimAPI was never defined, and every control in the app was inert
 * while the UI still rendered — so nothing looked obviously broken.
 */
test('accepts a bundle that only requires electron', () => {
  const file = fixture('const { contextBridge } = require("electron");');
  assert.doesNotThrow(() => assertPreloadSelfContained(file));
});

test('rejects a preload that requires an app module', () => {
  const file = fixture('const api = require("../shared/whim-api");');
  assert.throws(
    () => assertPreloadSelfContained(file),
    /requires '\.\.\/shared\/whim-api'.*must be fully bundled/s,
  );
});

test('rejects a preload that requires a bare package', () => {
  const file = fixture('require("electron"); require("js-yaml");');
  assert.throws(() => assertPreloadSelfContained(file), /js-yaml/);
});

test('allows the other modules the sandbox provides', () => {
  const file = fixture('require("events"); require("url"); require("timers");');
  assert.doesNotThrow(() => assertPreloadSelfContained(file));
});

test('allows node: prefixed built-ins', () => {
  const file = fixture('require("node:events"); require("node:url");');
  assert.doesNotThrow(() => assertPreloadSelfContained(file));
});

/*
 * A guard that only understands string literals silently ignores exactly the
 * calls it cannot reason about, which is the opposite of what a guard should
 * do. Anything non-literal is reported rather than skipped.
 */
test('rejects a computed require it cannot evaluate', () => {
  const file = fixture('const name = "fs"; require(name);');
  assert.throws(() => assertPreloadSelfContained(file), /computed specifier/);
});

test('rejects a template-literal require', () => {
  const file = fixture('require(`./${name}`);');
  assert.throws(() => assertPreloadSelfContained(file), /computed specifier/);
});

test('ignores property calls such as module.require', () => {
  // `foo.require(x)` is not the CJS loader, so it must not trip the guard.
  const file = fixture('custom.require(somethingElse); require("electron");');
  assert.doesNotThrow(() => assertPreloadSelfContained(file));
});

test('emits self-contained merge workers for Electron, mobile web and desktop web', async () => {
  const esbuild = require('esbuild');
  assert.deepStrictEqual(mergeWorkerOptions.map(options =>
    path.relative(path.join(__dirname, '..', 'dist'), options.outfile).split(path.sep).join('/')),
  ['renderer/merge-worker.js', 'web/merge-worker.js', 'web/desktop/merge-worker.js']);
  for (const options of mergeWorkerOptions) {
    const result = await esbuild.build({ ...options, write: false, logLevel: 'silent' });
    const javascript = result.outputFiles.find(file => file.path.endsWith('.js')).text;
    assert.match(javascript, /onmessage/);
    assert.doesNotMatch(javascript, /\brequire\(|import\.meta|node:worker_threads/);
  }
});

test('fingerprints worker URLs consistently and changes them with worker content', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-worker-bundle-'));
  const options = ['renderer', 'web', 'desktop'].map(name => ({ outfile: path.join(directory, name, 'merge-worker.js') }));
  try {
    for (const option of options) {
      fs.mkdirSync(path.dirname(option.outfile));
      fs.writeFileSync(option.outfile, 'self.onmessage = () => {};');
    }
    const first = fingerprintMergeWorkers(options);
    assert.match(first, /^merge-worker\.[0-9a-f]{12}\.js$/);
    for (const option of options) assert.ok(fs.existsSync(path.join(path.dirname(option.outfile), first)));
    for (const option of options) fs.writeFileSync(option.outfile, 'self.onmessage = event => self.postMessage(event.data);');
    const second = fingerprintMergeWorkers(options);
    assert.notStrictEqual(first, second);
    for (const option of options) {
      assert.ok(!fs.existsSync(path.join(path.dirname(option.outfile), first)));
      assert.ok(fs.existsSync(path.join(path.dirname(option.outfile), second)));
    }
  } finally {
    for (const option of options) {
      const parent = path.dirname(option.outfile);
      for (const name of fs.readdirSync(parent)) fs.unlinkSync(path.join(parent, name));
      fs.rmdirSync(parent);
    }
    fs.rmdirSync(directory);
  }
});

test('renderer worker clients use the emitted fingerprint in every shell', async () => {
  const esbuild = require('esbuild');
  const vm = require('node:vm');
  const filename = 'merge-worker.012345abcdef.js';
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'renderer', 'canvas', 'merge-client.ts')],
    bundle: true, write: false, format: 'cjs', platform: 'browser',
    define: { __WHIM_MERGE_WORKER_FILE__: JSON.stringify(filename) },
  });

  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, URL });
  for (const base of ['copilot-whim://app/renderer/', 'https://whim.test/', 'https://whim.test/desktop/']) {
    assert.strictEqual(module.exports.mergeWorkerUrl(new URL(base)).href, base + filename);
  }
});

test('editor, chat and settings are actual non-initial split outputs', async () => {
  const esbuild = require('esbuild');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-split-'));
  try {
    const options = { ...rendererOptions, outdir: directory, sourcemap: false, logLevel: 'silent' };
    const result = await esbuild.build(options);
    const manifest = writeAssetManifest(result, options);
    const initial = new Set(manifest.initial);
    for (const entry of ['canvas/mount.tsx', 'chat/mount.tsx', 'settings/controls.ts', 'settings/font-picker.ts']) {
      const output = Object.entries(result.metafile.outputs).find(([, value]) => value.entryPoint?.endsWith(entry));
      assert.ok(output, `No split output for ${entry}`);
      const relative = path.relative(directory, path.resolve(output[0])).split(path.sep).join('/');
      assert.ok(manifest.lazy.includes(relative), `${entry} is not lazy`);
      assert.ok(!initial.has(relative), `${entry} was included in initial imports`);
    }
    const inputBytes = manifest.initial.reduce((sum, asset) => sum + fs.statSync(path.join(directory, asset)).size, 0);
    assert.ok(inputBytes < 550_000, `Initial renderer graph is ${inputBytes} bytes`);
    for (const [output, metadata] of Object.entries(result.metafile.outputs)) {
      const relative = path.relative(directory, path.resolve(output)).split(path.sep).join('/');
      if (initial.has(relative)) {
        assert.ok(!Object.keys(metadata.inputs).some(input => /settings\/(?:controls|template)\.ts$/.test(input)),
          'Settings controls or markup leaked into the initial graph');
      }
    }
    const shell = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
    assert.ok(!shell.includes('id="agents-editor"'), 'Settings DOM was constructed in the initial HTML');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('mobile formatted documents are outside its initial graph', async () => {
  const esbuild = require('esbuild');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-mobile-split-'));
  try {
    const options = { ...webOptions, outdir: directory, sourcemap: false, logLevel: 'silent' };
    const result = await esbuild.build(options);
    const manifest = writeAssetManifest(result, options);
    assert.ok(manifest.lazy.some(file => file.includes('markdown.')));
    assert.ok(!manifest.initial.some(file => file.includes('markdown.')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
