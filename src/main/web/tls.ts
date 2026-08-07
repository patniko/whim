/**
 * TLS material for the web remote server.
 *
 * Browsers gate `getUserMedia`, the clipboard API, service workers and PWA
 * install behind a *secure context*. That gate is a property of the page
 * origin, not of the network — an encrypted VPN tunnel does not make an
 * `http://` origin secure as far as the browser is concerned. So anything
 * beyond loopback needs real TLS, which is why 'auto' provisions a
 * self-signed certificate rather than leaving the user on plaintext.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import * as selfsigned from 'selfsigned';
import type { WebRemoteTlsMode, WebRemoteTlsState } from '../../shared/ipc-contract';

export interface TlsMaterial {
  cert: string;
  key: string;
  fingerprint: string;
  expiresAt: string;
  /** Subject alternative names the certificate covers. */
  names: string[];
}

export interface TlsResolution {
  material: TlsMaterial | null;
  state: WebRemoteTlsState;
}

const CERT_VALIDITY_DAYS = 825;
/** Regenerate once the cert is inside this window of expiry. */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

function fingerprintOf(certPem: string): string {
  const body = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(body, 'base64');
  const digest = createHash('sha256').update(der).digest('hex').toUpperCase();
  return (digest.match(/.{2}/g) || []).join(':');
}

function isIpAddress(value: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return true;
  return value.includes(':');
}

/**
 * Names the certificate must cover: every address we might bind, plus the
 * machine's hostnames and any extra hostnames the user configured for a
 * reverse proxy.
 */
export function certificateNames(addresses: string[], extraHosts: string[] = []): string[] {
  const hostname = os.hostname();
  const short = hostname.split('.')[0];
  const names = new Set<string>([
    'localhost',
    '127.0.0.1',
    '::1',
    hostname,
    short,
    `${short}.local`,
    ...addresses,
    ...extraHosts,
  ]);
  return [...names].filter((name) => name && name !== '0.0.0.0' && name !== '::');
}

function generateSelfSigned(names: string[]): TlsMaterial {
  const altNames = names.map((name) => (
    isIpAddress(name) ? { type: 7, ip: name } : { type: 2, value: name }
  ));

  const pems = selfsigned.generate(
    [{ name: 'commonName', value: os.hostname() || 'whim' }],
    {
      days: CERT_VALIDITY_DAYS,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    },
  );

  return {
    cert: pems.cert,
    key: pems.private,
    fingerprint: fingerprintOf(pems.cert),
    expiresAt: new Date(Date.now() + CERT_VALIDITY_DAYS * 86_400_000).toISOString(),
    names,
  };
}

interface CachedCert {
  cert: string;
  key: string;
  expiresAt: string;
  names: string[];
}

function readCache(cachePath: string): CachedCert | null {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as CachedCert;
    if (!parsed.cert || !parsed.key || !Array.isArray(parsed.names)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, material: TlsMaterial): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const payload: CachedCert = {
      cert: material.cert,
      key: material.key,
      expiresAt: material.expiresAt,
      names: material.names,
    };
    fs.writeFileSync(cachePath, JSON.stringify(payload), { mode: 0o600 });
  } catch (err) {
    console.warn('[web-remote] Failed to cache TLS certificate:', err);
  }
}

function cacheIsUsable(cached: CachedCert, names: string[]): boolean {
  const expiry = Date.parse(cached.expiresAt);
  if (!Number.isFinite(expiry) || expiry - Date.now() < RENEW_BEFORE_MS) return false;
  const covered = new Set(cached.names);
  return names.every((name) => covered.has(name));
}

export interface ResolveTlsOptions {
  mode: WebRemoteTlsMode;
  certPath: string;
  keyPath: string;
  /** Addresses that will be bound, used as certificate SANs in 'auto' mode. */
  addresses: string[];
  extraHosts: string[];
  cachePath: string;
  /**
   * When every bound address is loopback, TLS is optional: localhost is
   * already a secure context, so we don't force a cert warning on the user.
   */
  loopbackOnly: boolean;
}

export function resolveTls(options: ResolveTlsOptions): TlsResolution {
  if (options.mode === 'off') {
    // Browsers gate getUserMedia, the clipboard API and service workers on a
    // secure context, and a pairing token plus a long-lived session cookie
    // would otherwise cross the network in the clear. `off` was returning
    // before this check, so the "TLS is required off loopback" invariant held
    // only for the modes that were already generating a certificate.
    if (!options.loopbackOnly) {
      return {
        material: null,
        state: {
          mode: 'off',
          active: false,
          fingerprint: null,
          expiresAt: null,
          error: 'TLS cannot be disabled while binding a non-loopback address. Use automatic or custom certificates.',
        },
      };
    }
    return {
      material: null,
      state: { mode: 'off', active: false, fingerprint: null, expiresAt: null, error: null },
    };
  }

  if (options.mode === 'custom') {
    try {
      if (!options.certPath || !options.keyPath) {
        throw new Error('Certificate and key paths are required for custom TLS.');
      }
      const cert = fs.readFileSync(options.certPath, 'utf-8');
      const key = fs.readFileSync(options.keyPath, 'utf-8');
      const fingerprint = fingerprintOf(cert);
      return {
        material: { cert, key, fingerprint, expiresAt: '', names: [] },
        state: { mode: 'custom', active: true, fingerprint, expiresAt: null, error: null },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        material: null,
        state: { mode: 'custom', active: false, fingerprint: null, expiresAt: null, error: message },
      };
    }
  }

  // 'auto': loopback-only deployments stay on plain HTTP, since http://localhost
  // is already a secure context and a self-signed cert would only add friction.
  if (options.loopbackOnly) {
    return {
      material: null,
      state: { mode: 'auto', active: false, fingerprint: null, expiresAt: null, error: null },
    };
  }

  try {
    const names = certificateNames(options.addresses, options.extraHosts);
    const cached = readCache(options.cachePath);
    let material: TlsMaterial;

    if (cached && cacheIsUsable(cached, names)) {
      material = {
        cert: cached.cert,
        key: cached.key,
        fingerprint: fingerprintOf(cached.cert),
        expiresAt: cached.expiresAt,
        names: cached.names,
      };
    } else {
      // Union with the cached names so a certificate doesn't lose coverage of
      // an interface that merely happens to be down at generation time.
      const union = [...new Set([...(cached?.names ?? []), ...names])];
      material = generateSelfSigned(union);
      writeCache(options.cachePath, material);
    }

    return {
      material,
      state: {
        mode: 'auto',
        active: true,
        fingerprint: material.fingerprint,
        expiresAt: material.expiresAt,
        error: null,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      material: null,
      state: { mode: 'auto', active: false, fingerprint: null, expiresAt: null, error: message },
    };
  }
}
