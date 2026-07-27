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

  const transport: IpcTransport = {
    async invoke(channel: string, ...args: any[]): Promise<any> {
      // Consult the shared classification before spending a round trip. The
      // server enforces this too — this only makes the failure immediate and
      // the message specific.
      const access = webAccessFor(channel);
      if (access === 'deny') throw new DeniedError(channel);
      if (access === 'desktop-only') throw new DesktopOnlyError(channel);

      const res = await fetch('/api/invoke', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, args }),
      });

      if (res.status === 401) {
        options.onUnauthorized?.();
        throw new Error('Session expired.');
      }

      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error?.message || `"${channel}" failed (${res.status})`);
      }
      return body.result;
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
