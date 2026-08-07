import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { certificateNames, resolveTls } from './tls';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-tls-'));
const cachePath = path.join(tmpDir, 'cache.json');

afterEach(() => {
  fs.rmSync(cachePath, { force: true });
});

function autoOptions(overrides: Partial<Parameters<typeof resolveTls>[0]> = {}) {
  return {
    mode: 'auto' as const,
    certPath: '',
    keyPath: '',
    addresses: ['192.168.1.20'],
    extraHosts: [] as string[],
    cachePath,
    loopbackOnly: false,
    ...overrides,
  };
}

describe('certificateNames', () => {
  it('always covers loopback names', () => {
    const names = certificateNames([]);
    expect(names).toContain('localhost');
    expect(names).toContain('127.0.0.1');
  });

  it('includes bound addresses and user hostnames', () => {
    const names = certificateNames(['192.168.1.20'], ['whim.internal.example']);
    expect(names).toContain('192.168.1.20');
    expect(names).toContain('whim.internal.example');
  });

  it('omits wildcard bind addresses, which are not valid SANs', () => {
    const names = certificateNames(['0.0.0.0', '::']);
    expect(names).not.toContain('0.0.0.0');
    expect(names).not.toContain('::');
  });
});

describe('resolveTls', () => {
  it('serves plain HTTP when disabled on loopback', () => {
    const result = resolveTls(autoOptions({ mode: 'off', loopbackOnly: true, addresses: ['127.0.0.1'] }));
    expect(result.material).toBeNull();
    expect(result.state).toMatchObject({ mode: 'off', active: false, error: null });
  });

  /**
   * `off` used to return before any loopback check, so "TLS is required on a
   * routable address" held only for the modes that were already generating a
   * certificate. Choosing `off` put the pairing token and the session cookie
   * on the wire in the clear.
   */
  it('refuses to serve a routable address in the clear', () => {
    const result = resolveTls(autoOptions({ mode: 'off', loopbackOnly: false }));
    expect(result.material).toBeNull();
    expect(result.state.active).toBe(false);
    expect(result.state.error).toMatch(/cannot be disabled/i);
  });

  it('skips certificate generation for a loopback-only bind', () => {
    const result = resolveTls(autoOptions({ loopbackOnly: true, addresses: ['127.0.0.1'] }));
    expect(result.material).toBeNull();
    expect(result.state).toMatchObject({ mode: 'auto', active: false, error: null });
  });

  it('generates a usable self-signed certificate for a routable bind', () => {
    const result = resolveTls(autoOptions());
    expect(result.state.active).toBe(true);
    expect(result.material?.cert).toContain('BEGIN CERTIFICATE');
    expect(result.material?.key).toContain('PRIVATE KEY');
    expect(result.state.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('reuses the cached certificate rather than regenerating on every start', () => {
    const first = resolveTls(autoOptions());
    const second = resolveTls(autoOptions());
    expect(second.state.fingerprint).toBe(first.state.fingerprint);
  });

  it('regenerates when a new address needs coverage, keeping the old names', () => {
    const first = resolveTls(autoOptions());
    const second = resolveTls(autoOptions({ addresses: ['10.9.9.9'] }));

    expect(second.state.fingerprint).not.toBe(first.state.fingerprint);
    // The previously covered address must survive, otherwise an interface that
    // is merely down at generation time loses its certificate coverage.
    expect(second.material?.names).toContain('192.168.1.20');
    expect(second.material?.names).toContain('10.9.9.9');
  });

  it('surfaces a missing custom certificate as an error instead of failing silently', () => {
    const result = resolveTls(autoOptions({
      mode: 'custom',
      certPath: path.join(tmpDir, 'missing.pem'),
      keyPath: path.join(tmpDir, 'missing.key'),
    }));
    expect(result.material).toBeNull();
    expect(result.state.active).toBe(false);
    expect(result.state.error).toBeTruthy();
  });

  it('loads a user-supplied certificate', () => {
    const generated = resolveTls(autoOptions());
    const certPath = path.join(tmpDir, 'custom.pem');
    const keyPath = path.join(tmpDir, 'custom.key');
    fs.writeFileSync(certPath, generated.material!.cert);
    fs.writeFileSync(keyPath, generated.material!.key);

    const result = resolveTls(autoOptions({ mode: 'custom', certPath, keyPath }));
    expect(result.state.active).toBe(true);
    expect(result.state.fingerprint).toBe(generated.state.fingerprint);
  });
});
