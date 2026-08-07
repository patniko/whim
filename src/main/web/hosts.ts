/**
 * Host-header validation.
 *
 * This is the DNS-rebinding defense: a malicious page can make a browser send
 * requests to our IP, but it cannot control the Host header, so we only accept
 * hosts we actually expect to be reached by.
 *
 * The allowlist is derived entirely from configuration — bound addresses, the
 * machine's own hostnames, and any extra hostnames the user added for a
 * reverse proxy. There are deliberately no vendor or product special-cases:
 * the previous implementation blanket-accepted an entire third-party domain
 * suffix regardless of what the user had selected, which silently bypassed
 * this check for anyone on that network.
 */
import * as net from 'net';
import * as os from 'os';

export interface HostPolicyInput {
  /** Addresses the server is currently listening on. */
  boundAddresses: string[];
  /** Extra hostnames the user configured (e.g. a reverse-proxy hostname). */
  allowedHosts: string[];
}

export interface HostPolicy {
  allows: (hostHeader: string | undefined) => boolean;
  /** The set of accepted host values, for display in settings. */
  entries: string[];
}

/** Strip the port and IPv6 brackets from a Host header value. */
export function parseHostHeader(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  // An IPv6 literal without brackets has more than one colon; don't treat the
  // final group as a port.
  const colonCount = (trimmed.match(/:/g) || []).length;
  if (colonCount > 1) return trimmed;
  return trimmed.split(':')[0];
}

function machineHostnames(): string[] {
  const hostname = os.hostname().toLowerCase();
  const short = hostname.split('.')[0];
  return [hostname, short, `${short}.local`].filter(Boolean);
}

export function createHostPolicy(input: HostPolicyInput): HostPolicy {
  const entries = new Set<string>(['localhost', '127.0.0.1', '::1']);

  for (const hostname of machineHostnames()) entries.add(hostname);

  for (const address of input.boundAddresses) {
    const lower = address.toLowerCase();
    // A wildcard bind means "every address on this machine", so we can't
    // enumerate them; accept any IP literal plus the configured hostnames.
    if (lower === '0.0.0.0' || lower === '::') continue;
    entries.add(lower);
  }

  for (const host of input.allowedHosts) entries.add(host.trim().toLowerCase());

  const wildcardBind = input.boundAddresses.some((address) => address === '0.0.0.0' || address === '::');

  return {
    entries: [...entries],
    allows(hostHeader: string | undefined): boolean {
      // A missing Host header used to be accepted. HTTP/1.1 requires one, and
      // accepting the absence gives an attacker a trivial way to skip this
      // check entirely — so treat it as a failure.
      if (!hostHeader) return false;
      const host = parseHostHeader(hostHeader);
      if (!host) return false;
      if (entries.has(host)) return true;
      // With a wildcard bind we cannot know every local address up front;
      // accept bare IP literals, which cannot be attacker-controlled DNS.
      if (wildcardBind && net.isIP(host) !== 0) return true;
      return false;
    },
  };
}
