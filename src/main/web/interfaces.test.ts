import { describe, expect, it } from 'vitest';
import type { WebRemoteInterface } from '../../shared/ipc-contract';
import {
  classifyInterfaceScope,
  defaultBindSelections,
  interfaceFingerprint,
  migrateBindAddresses,
  normalizeBindSelections,
  resolveBindAddresses,
  resolveBindSelections,
} from './interfaces';

function iface(partial: Partial<WebRemoteInterface> & { name: string; address: string }): WebRemoteInterface {
  const family = partial.family ?? 'IPv4';
  const internal = partial.internal ?? false;
  const scope = partial.scope ?? classifyInterfaceScope(partial.name, partial.address, internal);
  return {
    name: partial.name,
    address: partial.address,
    family,
    internal,
    scope,
    label: partial.label ?? `${partial.name} (${partial.address})`,
  };
}

describe('classifyInterfaceScope', () => {
  it('classifies loopback', () => {
    expect(classifyInterfaceScope('lo0', '127.0.0.1', true)).toBe('loopback');
    expect(classifyInterfaceScope('lo0', '127.0.0.1', false)).toBe('loopback');
    expect(classifyInterfaceScope('lo0', '::1', false)).toBe('loopback');
  });

  it('classifies RFC1918 and link-local as private', () => {
    expect(classifyInterfaceScope('en0', '10.1.2.3', false)).toBe('private');
    expect(classifyInterfaceScope('en0', '172.16.0.1', false)).toBe('private');
    expect(classifyInterfaceScope('en0', '172.32.0.1', false)).toBe('public');
    expect(classifyInterfaceScope('en0', '192.168.1.10', false)).toBe('private');
    expect(classifyInterfaceScope('en0', '169.254.1.1', false)).toBe('private');
    expect(classifyInterfaceScope('en0', 'fd00::1', false)).toBe('private');
  });

  it('classifies CGNAT space and tunnel devices as vpn, without vendor checks', () => {
    expect(classifyInterfaceScope('en0', '100.64.0.1', false)).toBe('vpn');
    expect(classifyInterfaceScope('en0', '100.127.255.254', false)).toBe('vpn');
    // 100.128.x is outside 100.64.0.0/10 and is ordinary public space.
    expect(classifyInterfaceScope('en0', '100.128.0.1', false)).toBe('public');
    expect(classifyInterfaceScope('utun3', '10.5.0.2', false)).toBe('vpn');
    expect(classifyInterfaceScope('wg0', '192.168.9.2', false)).toBe('vpn');
  });

  it('classifies routable addresses as public', () => {
    expect(classifyInterfaceScope('en0', '203.0.113.9', false)).toBe('public');
    expect(classifyInterfaceScope('en0', '2606:4700::1111', false)).toBe('public');
  });
});

describe('normalizeBindSelections', () => {
  it('falls back to loopback for garbage input', () => {
    expect(normalizeBindSelections(undefined)).toEqual(defaultBindSelections());
    expect(normalizeBindSelections([])).toEqual(defaultBindSelections());
    expect(normalizeBindSelections([null, 42, {}])).toEqual(defaultBindSelections());
  });

  it('accepts legacy bare address strings', () => {
    expect(normalizeBindSelections(['192.168.1.5'])).toEqual([
      { kind: 'address', address: '192.168.1.5' },
    ]);
  });

  it('deduplicates equivalent selections', () => {
    const result = normalizeBindSelections([
      { kind: 'interface', interfaceName: 'utun4', family: 'IPv4' },
      { kind: 'interface', interfaceName: 'utun4', family: 'IPv4' },
      { kind: 'interface', interfaceName: 'utun4', family: 'IPv6' },
    ]);
    expect(result).toHaveLength(2);
  });

  it('keeps a selection whose interface is not currently present', () => {
    const result = normalizeBindSelections([
      { kind: 'interface', interfaceName: 'utun99', family: 'IPv4' },
    ]);
    expect(result).toEqual([{ kind: 'interface', interfaceName: 'utun99', family: 'IPv4' }]);
  });
});

describe('migrateBindAddresses', () => {
  const interfaces = [
    iface({ name: 'lo0', address: '127.0.0.1', internal: true }),
    iface({ name: 'en0', address: '192.168.1.20' }),
    iface({ name: 'utun4', address: '100.90.1.2' }),
  ];

  it('promotes routable addresses to durable interface selections', () => {
    expect(migrateBindAddresses(['192.168.1.20', '100.90.1.2'], interfaces)).toEqual([
      { kind: 'interface', interfaceName: 'en0', family: 'IPv4' },
      { kind: 'interface', interfaceName: 'utun4', family: 'IPv4' },
    ]);
  });

  it('keeps loopback pinned rather than widening to the whole interface', () => {
    expect(migrateBindAddresses(['127.0.0.1'], interfaces)).toEqual([
      { kind: 'address', address: '127.0.0.1' },
    ]);
  });

  it('preserves addresses whose interface is currently down', () => {
    expect(migrateBindAddresses(['10.55.0.9'], interfaces)).toEqual([
      { kind: 'address', address: '10.55.0.9' },
    ]);
  });
});

describe('resolveBindSelections', () => {
  const interfaces = [
    iface({ name: 'lo0', address: '127.0.0.1', internal: true }),
    iface({ name: 'en0', address: '192.168.1.20' }),
    iface({ name: 'en0', address: '192.168.1.21' }),
  ];

  it('resolves an interface selection to all of its current addresses', () => {
    const [resolved] = resolveBindSelections(
      [{ kind: 'interface', interfaceName: 'en0', family: 'IPv4' }],
      interfaces,
    );
    expect(resolved.addresses).toEqual(['192.168.1.20', '192.168.1.21']);
    expect(resolved.scope).toBe('private');
  });

  it('reports an unavailable interface as pending rather than dropping it', () => {
    const [resolved] = resolveBindSelections(
      [{ kind: 'interface', interfaceName: 'utun99', family: 'IPv4' }],
      interfaces,
    );
    expect(resolved.addresses).toEqual([]);
    expect(resolved.label).toContain('not currently available');
  });

  it('follows an interface across renumbering', () => {
    const selection = [{ kind: 'interface' as const, interfaceName: 'en0', family: 'IPv4' as const }];
    expect(resolveBindAddresses(selection, interfaces)).toEqual(['192.168.1.20', '192.168.1.21']);

    const renumbered = [iface({ name: 'en0', address: '10.0.0.7' })];
    expect(resolveBindAddresses(selection, renumbered)).toEqual(['10.0.0.7']);
  });

  it('resolves the all-interfaces selection to a wildcard address', () => {
    expect(resolveBindAddresses([{ kind: 'all', family: 'IPv4' }], interfaces)).toEqual(['0.0.0.0']);
    expect(resolveBindAddresses([{ kind: 'all', family: 'IPv6' }], interfaces)).toEqual(['::']);
  });

  it('treats loopback addresses as always available', () => {
    expect(resolveBindAddresses([{ kind: 'address', address: '127.0.0.1' }], [])).toEqual(['127.0.0.1']);
  });

  it('reports a pinned address whose interface vanished as unavailable', () => {
    expect(resolveBindAddresses([{ kind: 'address', address: '192.168.5.5' }], interfaces)).toEqual([]);
  });
});

describe('interfaceFingerprint', () => {
  it('is stable under ordering and changes when an address changes', () => {
    const a = [iface({ name: 'en0', address: '192.168.1.20' }), iface({ name: 'lo0', address: '127.0.0.1', internal: true })];
    const b = [a[1], a[0]];
    expect(interfaceFingerprint(a)).toBe(interfaceFingerprint(b));
    expect(interfaceFingerprint(a)).not.toBe(
      interfaceFingerprint([iface({ name: 'en0', address: '192.168.1.21' })]),
    );
  });
});
