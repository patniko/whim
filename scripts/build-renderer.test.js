const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { assertPreloadSelfContained } = require('./build-renderer');

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
