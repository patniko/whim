import * as https from 'https';
import * as http from 'http';
import * as dns from 'dns';
import * as net from 'net';
import { URL } from 'url';
import { LinkPreviewMeta } from '../../shared/types';

const linkPreviewCache = new Map<string, { meta: LinkPreviewMeta; ts: number }>();
const LINK_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function fetchLinkPreview(urlStr: string): Promise<LinkPreviewMeta> {
  // Check cache
  const cached = linkPreviewCache.get(urlStr);
  if (cached && Date.now() - cached.ts < LINK_CACHE_TTL) {
    return cached.meta;
  }

  const result: LinkPreviewMeta = {
    url: urlStr,
    title: null,
    description: null,
    image: null,
    favicon: null,
  };

  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return result;
    }

    // Reachability is enforced inside fetchUrl, per hop, so a redirect cannot
    // walk us onto an address the first hop was not allowed to reach.
    const html = await fetchUrl(urlStr, 8000, 100 * 1024); // 8s timeout, 100KB max
    if (!html) return result;

    // Extract OG meta tags
    result.title = extractMeta(html, 'og:title') || extractTitle(html);
    result.description = extractMeta(html, 'og:description') || extractMeta(html, 'description');
    result.image = extractMeta(html, 'og:image');
    result.favicon = `${parsed.protocol}//${parsed.host}/favicon.ico`;

    linkPreviewCache.set(urlStr, { meta: result, ts: Date.now() });
  } catch (err) {
    console.error('[link-preview] Fetch failed:', err);
  }

  return result;
}

/**
 * Link previews fetch an attacker-influenced URL from inside the app, so the
 * destination has to be checked against the *resolved address*, not the
 * hostname text. The old check was a prefix match on the hostname, which let
 * through `169.254.169.254` (cloud metadata), `0.0.0.0`, IPv6 forms, and any
 * DNS name that simply resolves to a private address.
 *
 * This does not close DNS rebinding: we resolve here and the socket resolves
 * again, so a name that flips between answers can still slip past. Closing
 * that needs a pinned-address connection, which is a larger change than this.
 */
function isPrivateAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true; // IETF protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped/compatible forms carry an embedded v4 address. `new URL()`
    // normalises `::ffff:127.0.0.1` to the hex form `::ffff:7f00:1`, so both
    // spellings have to be recognised.
    const dotted = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (dotted) return isPrivateAddress(dotted[1]);
    const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return isPrivateAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }
    if (lower === '::' || lower === '::1') return true;
    if (/^f[cd]/.test(lower)) return true; // unique local fc00::/7
    if (/^fe[89ab]/.test(lower)) return true; // link-local fe80::/10
    if (lower.startsWith('ff')) return true; // multicast
    return false;
  }
  return true;
}

const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa'];

async function isPubliclyRoutableHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost') return false;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;

  if (net.isIP(host)) return !isPrivateAddress(host);

  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(host, { all: true });
  } catch {
    return false;
  }
  // Every answer must be routable — one private answer is enough to abuse.
  return addresses.length > 0 && addresses.every((entry) => !isPrivateAddress(entry.address));
}

const MAX_REDIRECTS = 1;

async function fetchUrl(
  urlStr: string,
  timeout: number,
  maxBytes: number,
  hops = 0,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!(await isPubliclyRoutableHost(parsed.hostname))) return null;

  return new Promise((resolve) => {
    const mod = parsed.protocol === 'https:' ? https : http;

    const req = mod.get(urlStr, { timeout, headers: { 'User-Agent': 'whim-LinkPreview/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // `res.destroy()` rather than `req.destroy()`: this callback can run
        // before the `req` binding is initialised, which threw a TDZ
        // ReferenceError and swallowed the redirect entirely.
        res.destroy();
        if (hops >= MAX_REDIRECTS) {
          resolve(null);
          return;
        }
        let next: string;
        try {
          next = new URL(res.headers.location, urlStr).toString();
        } catch {
          resolve(null);
          return;
        }
        void fetchUrl(next, timeout, maxBytes, hops + 1).then(resolve);
        return;
      }

      if (res.statusCode !== 200) {
        res.destroy();
        resolve(null);
        return;
      }

      let data = '';
      let bytes = 0;
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          res.destroy();
          return;
        }
        data += chunk;
      });
      res.on('end', () => resolve(data));
      res.on('error', () => resolve(null));
    });

    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function extractMeta(html: string, property: string): string | null {
  // Try og: property first, then name
  const ogRegex = new RegExp(`<meta[^>]+(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]+content=["']([^"']+)["']`, 'i');
  const match = ogRegex.exec(html);
  if (match) return match[1];

  // Try reversed attribute order
  const revRegex = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
  const revMatch = revRegex.exec(html);
  return revMatch ? revMatch[1] : null;
}

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return match ? match[1].trim() : null;
}
