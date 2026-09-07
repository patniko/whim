import { describe, expect, it } from 'vitest';
import { getBundledSdkRuntimePaths } from './copilot-runtime-path';

describe('getBundledSdkRuntimePaths', () => {
  it('uses a native SDK bundle, not the full CLI, in development', () => {
    expect(getBundledSdkRuntimePaths('/whim', 'darwin', 'arm64')).toEqual({
      executable: '/whim/node_modules/@github/copilot-sdk-darwin-arm64/prebuilds/darwin-arm64/copilot-runtime',
      library: '/whim/node_modules/@github/copilot-sdk-darwin-arm64/prebuilds/darwin-arm64/runtime.node',
    });
  });

  it('resolves native libraries outside ASAR on macOS', () => {
    const result = getBundledSdkRuntimePaths('/whim/app.asar', 'darwin', 'x64');
    expect(result.executable).toBe('/whim/app.asar.unpacked/node_modules/@github/copilot-sdk-darwin-x64/prebuilds/darwin-x64/copilot-runtime');
    expect(result.library).toBe('/whim/app.asar.unpacked/node_modules/@github/copilot-sdk-darwin-x64/prebuilds/darwin-x64/runtime.node');
  });

  it('uses the executable and DLL-library paths for Windows', () => {
    expect(getBundledSdkRuntimePaths('C:\\whim\\app.asar', 'win32', 'x64')).toEqual({
      executable: 'C:\\whim\\app.asar.unpacked\\node_modules\\@github\\copilot-sdk-win32-x64\\prebuilds\\win32-x64\\copilot-runtime.exe',
      library: 'C:\\whim\\app.asar.unpacked\\node_modules\\@github\\copilot-sdk-win32-x64\\prebuilds\\win32-x64\\runtime.node',
    });
  });

  it.each([true, false])('selects the matching Linux libc (musl=%s)', musl => {
    const variant = musl ? 'linuxmusl' : 'linux';
    const result = getBundledSdkRuntimePaths('/whim', 'linux', 'arm64', musl);
    expect(result.library).toBe(`/whim/node_modules/@github/copilot-sdk-${variant}-arm64/prebuilds/${variant}-arm64/runtime.node`);
  });
});
