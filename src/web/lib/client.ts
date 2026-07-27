import type { IpcCommandArgs, IpcCommandChannel, IpcCommandResult } from '../../shared/ipc-contract';
import type { WebRemoteEvent } from '../../main/web/event-hub';

export interface InvokeEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Session expired. Re-authenticate to continue.');
    this.name = 'UnauthorizedError';
  }
}

/**
 * Exchange the one-time bootstrap token for an HttpOnly session cookie.
 *
 * Everything after this point authenticates with the cookie, so the token
 * never has to be stored in the page or carried in a URL.
 */
export async function establishSession(token: string): Promise<void> {
  const res = await fetch('/api/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'That token was not accepted.' : `Sign-in failed (${res.status})`);
  }
}

export async function hasSession(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { credentials: 'same-origin' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function endSession(): Promise<void> {
  await fetch('/api/session', { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
}

export class WebRemoteClient {
  async invoke<C extends IpcCommandChannel>(
    channel: C,
    ...args: IpcCommandArgs<C>
  ): Promise<IpcCommandResult<C>> {
    const res = await fetch('/api/invoke', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args }),
    });
    if (res.status === 401) throw new UnauthorizedError();
    const body = await res.json() as InvokeEnvelope<IpcCommandResult<C>>;
    if (!res.ok || !body.ok) {
      throw new Error(body.error?.message || `Request failed (${res.status})`);
    }
    return body.result as IpcCommandResult<C>;
  }

  connect(
    onEvent: (event: WebRemoteEvent) => void,
    onStatus: (status: string) => void,
    onUnauthorized?: () => void,
  ): () => void {
    let closed = false;
    let ws: WebSocket | null = null;
    let retryTimer: number | null = null;

    const open = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // No token in the URL: the browser sends the session cookie on upgrade.
      const url = `${protocol}//${window.location.host}/api/events`;
      ws = new WebSocket(url);
      ws.onopen = () => onStatus('live');
      ws.onclose = (event) => {
        // 1008/1011-style closes and a rejected upgrade both surface here; a
        // dropped session must show a re-auth prompt rather than reconnecting
        // forever with a credential the server no longer accepts.
        if (!closed && event.code === 1006) {
          void hasSession().then((ok) => {
            if (!ok) {
              closed = true;
              onStatus('signed out');
              onUnauthorized?.();
            }
          });
        }
        onStatus('reconnecting');
        if (!closed) retryTimer = window.setTimeout(open, 1500);
      };
      ws.onerror = () => onStatus('connection error');
      ws.onmessage = (message) => {
        const data = JSON.parse(message.data);
        if (data?.type === 'event') onEvent(data.event);
      };
    };

    open();
    return () => {
      closed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      ws?.close();
    };
  }
}
