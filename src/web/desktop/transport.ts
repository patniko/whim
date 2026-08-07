/*
 * The browser half of whim's API surface.
 *
 * `src/shared/whim-api.ts` defines what the renderer can call; this satisfies
 * that contract over HTTP and a WebSocket instead of Electron IPC. Because
 * both bridges are built from the same definition, the browser automatically
 * gains any capability the desktop gains — the drift that motivated this work
 * is now structurally impossible.
 */
import type { IpcTransport } from '../../shared/whim-api';
import { webAccessFor } from '../../shared/web-access';
import type { WebRemoteEvent } from '../../main/web/event-hub';

type Listener = (event: unknown, ...args: any[]) => void;

/** Raised when a command is withheld from the remote on purpose. */
export class DeniedError extends Error {
  constructor(channel: string) {
    super(`"${channel}" is not available over the web remote.`);
    this.name = 'DeniedError';
  }
}

/** Raised when a command only means something on the desktop. */
export class DesktopOnlyError extends Error {
  constructor(channel: string) {
    super(`"${channel}" only works in the desktop app.`);
    this.name = 'DesktopOnlyError';
  }
}

export interface WebTransportOptions {
  /** Called when the server stops accepting our session cookie. */
  onUnauthorized?: () => void;
}

/**
 * Fan events out to the renderer's listeners.
 *
 * Electron delivers `(event, ...args)`; the first parameter is an IpcRenderer
 * event object that no whim code reads. Passing a plain object keeps the
 * shared surface honest without pretending to reimplement Electron.
 */
class EventRouter {
  private listeners = new Map<string, Set<Listener>>();

  on(channel: string, listener: Listener): void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
  }

  removeListener(channel: string, listener: Listener): void {
    const set = this.listeners.get(channel);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this.listeners.delete(channel);
  }

  dispatch(channel: string, args: unknown[]): void {
    const set = this.listeners.get(channel);
    if (!set) return;
    // Copy first: a listener that unsubscribes itself is common (single-shot
    // handlers) and would otherwise mutate the set mid-iteration.
    for (const listener of [...set]) {
      try {
        listener({}, ...args);
      } catch (err) {
        console.error(`[web] listener for ${channel} threw`, err);
      }
    }
  }
}

export interface WebTransport {
  transport: IpcTransport;
  /** Feed a server event in; it reaches whichever renderer listeners want it. */
  dispatch: (event: WebRemoteEvent) => void;
}

export function createWebTransport(options: WebTransportOptions = {}): WebTransport {
  const router = new EventRouter();

  async function remoteInvoke(channel: string, args: unknown[]): Promise<any> {
    // One retry, and only for a rate limit. A 429 is the server saying "ask
    // again shortly", which is a different thing from a failure — surfacing it
    // raw made a transient budget dip look like a broken app. Retrying more
    // than once would turn the client into the very pile-on the limit exists
    // to stop, so a single deferred attempt is the whole allowance.
    const first = await attempt(channel, args);
    if (first.status !== 429) return finish(channel, first);

    const wait = retryDelayMs(first.res.headers?.get('Retry-After') ?? null);
    if (wait === null) return finish(channel, first);
    await sleep(wait);
    return finish(channel, await attempt(channel, args));
  }

  async function attempt(channel: string, args: unknown[]) {
    const res = await fetch('/api/invoke', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args }),
    });
    return { res, status: res.status };
  }

  async function finish(channel: string, { res }: { res: Response }): Promise<any> {
    if (res.status === 401) {
      options.onUnauthorized?.();
      throw new Error('Session expired.');
    }

    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) {
      throw new Error(body?.error?.message || `"${channel}" failed (${res.status})`);
    }
    return body.result;
  }

  const transport: IpcTransport = {
    invoke(channel: string, ...args: any[]): Promise<any> {
      // Consult the shared classification before spending a round trip. The
      // server enforces this too — this only makes the failure immediate and
      // the message specific.
      const access = webAccessFor(channel);
      if (access === 'desktop-only' && channel in BROWSER_TRUTH) {
        return Promise.resolve(BROWSER_TRUTH[channel]);
      }
      if (access === 'deny') return preRejected(new DeniedError(channel));
      if (access === 'desktop-only') return preRejected(new DesktopOnlyError(channel));

      return remoteInvoke(channel, args);
    },

    send(channel: string, ..._args: any[]): void {
      // Every fire-and-forget channel drives a native window: hide, pin, open
      // a canvas window. There is nothing to do in a browser tab and nothing
      // to report, so these are dropped rather than failed.
      if (webAccessFor(channel) === 'allow') {
        console.warn(`[web] dropped fire-and-forget "${channel}"`);
      }
    },

    on: (channel, listener) => router.on(channel, listener),
    removeListener: (channel, listener) => router.removeListener(channel, listener),
    platform: detectPlatform(),
  };

  return {
    transport,
    dispatch: (event) => {
      // Replay the channel the renderer actually subscribed to, not the
      // flattened view the lightweight client consumes.
      const source = event.source;
      if (source) router.dispatch(source.channel, source.args);
      else router.dispatch(event.channel, [event.payload]);
    },
  };
}

/**
 * How long to wait before the single 429 retry, or `null` to give up now.
 *
 * The server's `Retry-After` is authoritative, but it is also attacker- and
 * bug-controllable from the client's point of view, so an absurd value must
 * not park a promise forever. Anything beyond a few seconds is reported to
 * the caller instead — a user staring at a spinner deserves to be told.
 */
const MAX_RETRY_WAIT_MS = 5000;

export function retryDelayMs(header: string | null): number | null {
  // `Number(null)` and `Number('')` are both 0, which would read as "retry
  // straight away" — the opposite of what a server that declined to say
  // anything is asking for.
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const ms = Math.ceil(seconds * 1000);
  return ms > MAX_RETRY_WAIT_MS ? null : Math.max(ms, 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The renderer uses the platform only for adaptive styling and shortcut
 * labels, so the browser's best guess is good enough — and reporting the
 * *viewing* device is more useful here than reporting the host it connects to.
 */
function detectPlatform(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) return 'darwin';
  if (/Win/i.test(ua)) return 'win32';
  return 'linux';
}

/**
 * Reject, but count the rejection as already observed.
 *
 * The renderer was written against a desktop where every channel exists, so it
 * calls things like `window:get-pinned` on boot and ignores the result. In a
 * browser those calls fail, and each one surfaced as an "Uncaught (in promise)"
 * error — noise that buries the failures that do matter, and that looks like a
 * broken page to anyone opening devtools.
 *
 * Resolving these to a placeholder instead would be worse: `window:get-pinned`
 * returns a boolean, and a truthy stand-in would render the wrong UI. So the
 * promise still rejects — callers that await it get an accurate, specific
 * error — and a no-op handler is attached to the same promise so callers that
 * discard it stay silent. Unhandled-rejection tracking is per-promise, so this
 * marks exactly this one as observed without swallowing anything.
 */
function preRejected(error: Error): Promise<never> {
  const rejected = Promise.reject(error);
  rejected.catch(() => {});
  return rejected;
}

/**
 * Desktop-only channels that nonetheless have a true answer in a browser.
 *
 * The bar for this table is narrow on purpose: the value must be *correct*,
 * not merely inoffensive. A browser tab is never an always-on-top window, so
 * "not pinned" is the honest state of the world, and the renderer draws an
 * accurate button from it. Anything where the truthful answer is "there is no
 * such thing here" belongs in the rejecting path instead, where the caller
 * finds out rather than being misled.
 */
const BROWSER_TRUTH: Record<string, unknown> = {
  'window:get-pinned': false,
};
