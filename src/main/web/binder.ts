/**
 * Reconciles the user's bind intent against the live network.
 *
 * The previous implementation bound once at startup and never looked again,
 * which meant any interface that appeared later (VPN connect, Wi-Fi
 * association, dock, DHCP renewal) was simply never served. This binder
 * continuously converges the set of live listeners onto the set of addresses
 * the user's selections currently resolve to, and reports honest per-selection
 * status so the UI can say *why* something isn't reachable.
 */
import type { Server } from 'http';
import type {
  WebRemoteBindingStatus,
  WebRemoteBindSelection,
} from '../../shared/ipc-contract';
import type { WebRemoteInterface } from '../../shared/ipc-contract';
import {
  interfaceFingerprint,
  listWebRemoteInterfaces,
  resolveBindSelections,
} from './interfaces';

export interface BoundListener {
  address: string;
  port: number;
  server: Server;
  close: () => Promise<void>;
}

export interface BinderOptions {
  /** Create and start listening on one address. Rejects on bind failure. */
  listen: (address: string, port: number) => Promise<BoundListener>;
  /** How often to poll for interface changes. */
  pollIntervalMs?: number;
  /** Backoff applied to an address whose bind failed, before retrying. */
  retryDelayMs?: number;
  /** Injectable for tests; defaults to the live network. */
  listInterfaces?: () => WebRemoteInterface[];
  onChange?: () => void;
  now?: () => number;
}

interface FailureRecord {
  message: string;
  retryAt: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 15_000;

export class WebRemoteBinder {
  private selections: WebRemoteBindSelection[] = [];
  private port = 0;
  private active = false;
  private readonly listeners = new Map<string, BoundListener>();
  private readonly failures = new Map<string, FailureRecord>();
  private timer: NodeJS.Timeout | null = null;
  private fingerprint = '';
  private reconciling: Promise<void> | null = null;

  private readonly pollIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private readonly listInterfaces: () => WebRemoteInterface[];

  constructor(private readonly options: BinderOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.now = options.now ?? Date.now;
    this.listInterfaces = options.listInterfaces ?? listWebRemoteInterfaces;
  }

  isActive(): boolean {
    return this.active;
  }

  listening(): BoundListener[] {
    return [...this.listeners.values()];
  }

  boundAddresses(): string[] {
    return [...this.listeners.keys()];
  }

  async start(selections: WebRemoteBindSelection[], port: number): Promise<void> {
    this.selections = selections;
    this.port = port;
    this.active = true;
    this.failures.clear();
    await this.reconcile();
    this.startPolling();
  }

  async update(selections: WebRemoteBindSelection[], port: number): Promise<void> {
    const portChanged = port !== this.port;
    this.selections = selections;
    this.port = port;
    // A port change invalidates every existing listener.
    if (portChanged) await this.closeAll();
    this.failures.clear();
    // Intent changed, so the last-seen network fingerprint is no longer a
    // valid reason to skip work.
    this.fingerprint = '';
    if (this.active) await this.reconcile();
  }

  async stop(): Promise<void> {
    this.active = false;
    this.stopPolling();
    this.failures.clear();
    // Forget the last-seen topology, otherwise a later start() on an unchanged
    // network would see a matching fingerprint and skip binding entirely.
    this.fingerprint = '';
    // A reconcile already awaiting listen() would otherwise resolve after
    // closeAll() and register a live listener on a binder that is no longer
    // active — so turning remote access off could leave a socket accepting
    // connections with nothing tracking it.
    await this.reconciling?.catch(() => { /* its own failure is recorded */ });
    await this.closeAll();
  }

  /**
   * Force an immediate reconcile — used on wake from sleep, where interface
   * state routinely changes while the poll timer was suspended.
   */
  async refresh(): Promise<void> {
    if (!this.active) return;
    this.fingerprint = '';
    await this.reconcile();
  }

  /** Per-selection status for the settings UI. */
  status(): WebRemoteBindingStatus[] {
    const resolved = resolveBindSelections(this.selections, this.listInterfaces());
    return resolved.map((entry) => {
      const bound = entry.addresses.filter((address) => this.listeners.has(address));
      const failed = entry.addresses
        .map((address) => this.failures.get(this.key(address)))
        .filter((failure): failure is FailureRecord => failure !== undefined);

      if (entry.addresses.length === 0) {
        return {
          selection: entry.selection,
          label: entry.label,
          scope: entry.scope,
          state: 'pending' as const,
          addresses: [],
          detail: 'Interface is not currently available. It will be bound automatically when it comes up.',
        };
      }

      if (bound.length === entry.addresses.length) {
        return {
          selection: entry.selection,
          label: entry.label,
          scope: entry.scope,
          state: 'listening' as const,
          addresses: bound,
          detail: null,
        };
      }

      return {
        selection: entry.selection,
        label: entry.label,
        scope: entry.scope,
        state: 'failed' as const,
        addresses: bound,
        detail: failed[0]?.message ?? 'Failed to bind.',
      };
    });
  }

  /** True only when every selection is fully listening. */
  isFullyBound(): boolean {
    const statuses = this.status();
    return statuses.length > 0 && statuses.every((entry) => entry.state === 'listening');
  }

  private key(address: string): string {
    return `${address}:${this.port}`;
  }

  private startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reconcile();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  private stopPolling(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async closeAll(): Promise<void> {
    const closing = [...this.listeners.values()].map((listener) => listener.close());
    this.listeners.clear();
    await Promise.all(closing);
  }

  private reconcile(): Promise<void> {
    // Serialize: interface polls and explicit updates can overlap.
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.doReconcile().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  private async doReconcile(): Promise<void> {
    if (!this.active) return;

    const interfaces = this.listInterfaces();
    const fingerprint = interfaceFingerprint(interfaces);
    const hasRetryDue = [...this.failures.values()].some((failure) => failure.retryAt <= this.now());
    if (fingerprint === this.fingerprint && !hasRetryDue) return;
    this.fingerprint = fingerprint;

    const desired = new Set<string>();
    for (const entry of resolveBindSelections(this.selections, interfaces)) {
      for (const address of entry.addresses) desired.add(address);
    }

    let changed = false;

    // Drop listeners whose address is no longer selected or no longer exists.
    for (const [address, listener] of [...this.listeners]) {
      if (desired.has(address)) continue;
      this.listeners.delete(address);
      changed = true;
      await listener.close().catch(() => { /* already gone */ });
    }

    for (const address of desired) {
      if (this.listeners.has(address)) continue;

      const key = this.key(address);
      const failure = this.failures.get(key);
      if (failure && failure.retryAt > this.now()) continue;

      try {
        const listener = await this.options.listen(address, this.port);
        if (!this.active) {
          // Stopped while this bind was in flight.
          await listener.close().catch(() => { /* nothing to undo */ });
          return;
        }
        this.listeners.set(address, listener);
        this.failures.delete(key);
        changed = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.failures.set(key, { message, retryAt: this.now() + this.retryDelayMs });
        changed = true;
      }
    }

    if (changed) this.options.onChange?.();
  }
}
