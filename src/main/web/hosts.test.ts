import { describe, expect, it } from 'vitest';
import { createHostPolicy, parseHostHeader } from './hosts';

describe('parseHostHeader', () => {
  it('strips the port', () => {
    expect(parseHostHeader('example.com:8899')).toBe('example.com');
  });

  it('unwraps a bracketed IPv6 literal', () => {
    expect(parseHostHeader('[fd00::1]:8899')).toBe('fd00::1');
  });

  it('does not mistake an IPv6 group for a port', () => {
    expect(parseHostHeader('fd00::1')).toBe('fd00::1');
  });

  it('lowercases', () => {
    expect(parseHostHeader('Example.COM')).toBe('example.com');
  });
});

describe('createHostPolicy', () => {
  const policy = createHostPolicy({
    boundAddresses: ['192.168.1.20', 'fd00::5'],
    allowedHosts: ['whim.internal.example'],
  });

  it('allows loopback names', () => {
    expect(policy.allows('localhost:8899')).toBe(true);
    expect(policy.allows('127.0.0.1:8899')).toBe(true);
    expect(policy.allows('[::1]:8899')).toBe(true);
  });

  it('allows bound addresses', () => {
    expect(policy.allows('192.168.1.20:8899')).toBe(true);
    expect(policy.allows('[fd00::5]:8899')).toBe(true);
  });

  it('allows user-configured hostnames', () => {
    expect(policy.allows('whim.internal.example')).toBe(true);
    expect(policy.allows('WHIM.INTERNAL.EXAMPLE:443')).toBe(true);
  });

  it('rejects an arbitrary hostname', () => {
    expect(policy.allows('evil.example.com')).toBe(false);
  });

  it('rejects an address we are not bound to', () => {
    expect(policy.allows('10.0.0.9:8899')).toBe(false);
  });

  it('has no vendor-specific domain bypass', () => {
    expect(policy.allows('whim.tailnet-abc.ts.net')).toBe(false);
  });

  it('rejects a missing Host header instead of waving it through', () => {
    expect(policy.allows(undefined)).toBe(false);
    expect(policy.allows('')).toBe(false);
  });

  it('accepts bare IP literals only when bound to a wildcard', () => {
    const wildcard = createHostPolicy({ boundAddresses: ['0.0.0.0'], allowedHosts: [] });
    expect(wildcard.allows('10.0.0.9:8899')).toBe(true);
    // A DNS name is still attacker-controllable, so it stays rejected.
    expect(wildcard.allows('evil.example.com')).toBe(false);
  });
});
