import { beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { WebRemoteInterface } from '../../shared/ipc-contract';
import { WebRemoteBinder, type BoundListener } from './binder';
import { classifyInterfaceScope } from './interfaces';

function iface(name: string, address: string, internal = false): WebRemoteInterface {
  const scope = classifyInterfaceScope(name, address, internal);
  return { name, address, family: 'IPv4', internal, scope, label: `${name} (${address})` };
}

let network: WebRemoteInterface[] = [];

function makeBinder(overrides: Partial<{
  listen: (address: string, port: number) => Promise<BoundListener>;
  now: () => number;
}> = {}) {
  const closed: string[] = [];
  const listen = overrides.listen ?? (async (address: string, port: number): Promise<BoundListener> => ({
    address,
    port,
    server: {} as Server,
    close: async () => { closed.push(address); },
  }));
  // pollIntervalMs is large: every test drives reconciliation explicitly via
  // refresh()/update() so there is no timing flake.
  const binder = new WebRemoteBinder({
    listen,
    pollIntervalMs: 1_000_000,
    retryDelayMs: 15_000,
    now: overrides.now,
    listInterfaces: () => network,
  });
  return { binder, closed };
}

beforeEach(() => {
  network = [iface('lo0', '127.0.0.1', true), iface('en0', '192.168.1.20')];
});

describe('WebRemoteBinder', () => {
  it('binds every address the selections resolve to', async () => {
    const { binder } = makeBinder();
    await binder.start([{ kind: 'interface', interfaceName: 'en0', family: 'IPv4' }], 8899);
    expect(binder.boundAddresses()).toEqual(['192.168.1.20']);
    expect(binder.isFullyBound()).toBe(true);
    await binder.stop();
  });

  it('binds an interface that appears after startup', async () => {
    const { binder } = makeBinder();
    await binder.start([{ kind: 'interface', interfaceName: 'utun4', family: 'IPv4' }], 8899);

    expect(binder.boundAddresses()).toEqual([]);
    expect(binder.status()[0].state).toBe('pending');
    expect(binder.isFullyBound()).toBe(false);

    network = [...network, iface('utun4', '100.90.1.2')];
    await binder.refresh();

    expect(binder.boundAddresses()).toEqual(['100.90.1.2']);
    expect(binder.isFullyBound()).toBe(true);
    await binder.stop();
  });

  it('drops a listener when its interface disappears, and keeps the selection', async () => {
    const { binder, closed } = makeBinder();
    const selection = { kind: 'interface' as const, interfaceName: 'en0', family: 'IPv4' as const };
    await binder.start([selection], 8899);
    expect(binder.boundAddresses()).toEqual(['192.168.1.20']);

    network = [iface('lo0', '127.0.0.1', true)];
    await binder.refresh();

    expect(binder.boundAddresses()).toEqual([]);
    expect(closed).toEqual(['192.168.1.20']);
    // The user's intent survives the interface going away.
    expect(binder.status()).toEqual([
      expect.objectContaining({ selection, state: 'pending' }),
    ]);
    await binder.stop();
  });

  it('rebinds when an interface renumbers', async () => {
    const { binder, closed } = makeBinder();
    await binder.start([{ kind: 'interface', interfaceName: 'en0', family: 'IPv4' }], 8899);

    network = [iface('lo0', '127.0.0.1', true), iface('en0', '10.0.0.7')];
    await binder.refresh();

    expect(binder.boundAddresses()).toEqual(['10.0.0.7']);
    expect(closed).toEqual(['192.168.1.20']);
    await binder.stop();
  });

  it('reports a partial bind as not fully bound', async () => {
    const { binder } = makeBinder({
      listen: async (address, port) => {
        if (address === '192.168.1.20') throw new Error('EADDRINUSE');
        return { address, port, server: {} as Server, close: async () => {} };
      },
    });

    await binder.start([
      { kind: 'address', address: '127.0.0.1' },
      { kind: 'interface', interfaceName: 'en0', family: 'IPv4' },
    ], 8899);

    expect(binder.boundAddresses()).toEqual(['127.0.0.1']);
    expect(binder.isFullyBound()).toBe(false);

    const statuses = binder.status();
    expect(statuses[0].state).toBe('listening');
    expect(statuses[1].state).toBe('failed');
    expect(statuses[1].detail).toContain('EADDRINUSE');
    await binder.stop();
  });

  it('backs off a failed address and retries once the delay elapses', async () => {
    let attempts = 0;
    let clock = 0;
    const { binder } = makeBinder({
      now: () => clock,
      listen: async (address, port) => {
        attempts += 1;
        if (attempts === 1) throw new Error('EADDRINUSE');
        return { address, port, server: {} as Server, close: async () => {} };
      },
    });

    await binder.start([{ kind: 'interface', interfaceName: 'en0', family: 'IPv4' }], 8899);
    expect(attempts).toBe(1);
    expect(binder.boundAddresses()).toEqual([]);

    // Still inside the backoff window: no new attempt.
    clock = 1_000;
    await binder.refresh();
    expect(attempts).toBe(1);

    clock = 20_000;
    await binder.refresh();
    expect(attempts).toBe(2);
    expect(binder.boundAddresses()).toEqual(['192.168.1.20']);
    await binder.stop();
  });

  it('rebinds all listeners when the port changes', async () => {
    const { binder, closed } = makeBinder();
    const selection = { kind: 'interface' as const, interfaceName: 'en0', family: 'IPv4' as const };
    await binder.start([selection], 8899);
    expect(binder.listening()[0].port).toBe(8899);

    await binder.update([selection], 9900);

    expect(closed).toEqual(['192.168.1.20']);
    expect(binder.listening()[0].port).toBe(9900);
    await binder.stop();
  });

  it('applies a selection change even when the network is unchanged', async () => {
    const { binder } = makeBinder();
    await binder.start([{ kind: 'address', address: '127.0.0.1' }], 8899);
    expect(binder.boundAddresses()).toEqual(['127.0.0.1']);

    await binder.update([{ kind: 'interface', interfaceName: 'en0', family: 'IPv4' }], 8899);
    expect(binder.boundAddresses()).toEqual(['192.168.1.20']);
    await binder.stop();
  });

  it('closes everything on stop', async () => {
    const { binder, closed } = makeBinder();
    await binder.start([
      { kind: 'address', address: '127.0.0.1' },
      { kind: 'interface', interfaceName: 'en0', family: 'IPv4' },
    ], 8899);
    expect(binder.boundAddresses()).toHaveLength(2);

    await binder.stop();

    expect(binder.boundAddresses()).toEqual([]);
    expect(binder.isActive()).toBe(false);
    expect(closed.sort()).toEqual(['127.0.0.1', '192.168.1.20']);
  });
});
