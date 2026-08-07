import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebTransport, DeniedError, DesktopOnlyError, retryDelayMs } from './transport';
import type { WebRemoteEvent } from '../../main/web/event-hub';

function event(channel: string, args: unknown[]): WebRemoteEvent {
  return {
    channel,
    payload: args[0] ?? null,
    timestamp: new Date().toISOString(),
    seq: 1,
    source: { channel, args },
  };
}

describe('web transport', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: ['a-space'] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone)' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('invoke', () => {
    it('posts the channel and args, and unwraps the envelope', async () => {
      const { transport } = createWebTransport();
      const result = await transport.invoke('space:list');

      expect(result).toEqual(['a-space']);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/invoke');
      expect(init.credentials).toBe('same-origin');
      expect(JSON.parse(init.body)).toEqual({ channel: 'space:list', args: [] });
    });

    it('passes every argument through in order', async () => {
      const { transport } = createWebTransport();
      await transport.invoke('space:update', 'id-1', { title: 'x' });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).args).toEqual(['id-1', { title: 'x' }]);
    });

    /**
     * The server refuses these too. Short-circuiting matters because it turns
     * a confusing 403 into a specific error, and because a renderer that polls
     * a denied channel shouldn't generate remote traffic to be denied.
     */
    it('refuses denied channels without touching the network', async () => {
      const { transport } = createWebTransport();
      await expect(transport.invoke('settings:set', 'theme', 'dark')).rejects.toThrow(DeniedError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses desktop-only channels without touching the network', async () => {
      const { transport } = createWebTransport();
      await expect(transport.invoke('hotkeys:get')).rejects.toThrow(DesktopOnlyError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    /**
     * The pin button is drawn from this value, so a rejection leaves it in
     * whatever state it happened to start in. "Not pinned" isn't a placeholder
     * — a browser tab genuinely cannot be an always-on-top window.
     */
    it('answers desktop-only channels that have a true browser answer', async () => {
      const { transport } = createWebTransport();
      await expect(transport.invoke('window:get-pinned')).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports the server error message when a call fails', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ ok: false, error: { code: 'boom', message: 'Disk is full' } }),
      });
      const { transport } = createWebTransport();
      await expect(transport.invoke('space:list')).rejects.toThrow('Disk is full');
    });

    it('signals an expired session exactly once per failed call', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
      const onUnauthorized = vi.fn();
      const { transport } = createWebTransport({ onUnauthorized });

      await expect(transport.invoke('space:list')).rejects.toThrow(/expired/i);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('survives a response body that is not JSON', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => { throw new SyntaxError('bad json'); },
      });
      const { transport } = createWebTransport();
      await expect(transport.invoke('space:list')).rejects.toThrow(/502/);
    });

    /**
     * boot reads this to decide between the setup flow and the interface. It
     * used to be denied outright, which took the whole boot down with it; the
     * host path is now stripped server-side instead.
     */
    it('sends the CLI runtime status to the server rather than refusing it', async () => {
      const { transport } = createWebTransport();
      await transport.invoke('cli:runtime-status');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).channel).toBe('cli:runtime-status');
    });
  });

  /**
   * A 429 means "ask again shortly", which is not the same as a failure.
   * Surfacing it raw made a momentary budget dip look like a broken app.
   */
  describe('rate limiting', () => {
    function rateLimited(retryAfter: string | null) {
      return {
        ok: false,
        status: 429,
        headers: { get: (name: string) => (name === 'Retry-After' ? retryAfter : null) },
        json: async () => ({ ok: false, error: { code: 'rate_limited', message: 'Too many requests. Slow down.' } }),
      };
    }

    const ok = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: true, result: ['a-space'] }),
    };

    it('waits for Retry-After and succeeds on the second attempt', async () => {
      fetchMock.mockResolvedValueOnce(rateLimited('1')).mockResolvedValueOnce(ok);
      const { transport } = createWebTransport();

      await expect(transport.invoke('space:list')).resolves.toEqual(['a-space']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    /** One retry, not a loop — the client must not become the pile-on. */
    it('gives up after a single retry rather than hammering', async () => {
      fetchMock.mockResolvedValue(rateLimited('1'));
      const { transport } = createWebTransport();

      await expect(transport.invoke('space:list')).rejects.toThrow(/Too many requests/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    /**
     * The wait is server-supplied, so an absurd value must not park a promise
     * indefinitely; a user staring at a spinner deserves to be told.
     */
    it('reports the error instead of waiting out an implausible Retry-After', async () => {
      fetchMock.mockResolvedValue(rateLimited('3600'));
      const { transport } = createWebTransport();

      await expect(transport.invoke('space:list')).rejects.toThrow(/Too many requests/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry when the server sent no Retry-After to honour', async () => {
      fetchMock.mockResolvedValue(rateLimited(null));
      const { transport } = createWebTransport();

      await expect(transport.invoke('space:list')).rejects.toThrow(/Too many requests/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    /**
     * The authenticator answers 429 for a lockout after repeated bad tokens,
     * which looks identical to a rate limit by status alone. Retrying it would
     * extend the lockout and tell the user nothing, so the retry keys off the
     * error code instead.
     */
    it('does not retry an auth lockout that shares the 429 status', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        headers: { get: () => '1' },
        json: async () => ({ ok: false, error: { code: 'auth_failed', message: 'Too many failed attempts. Try again later.' } }),
      });
      const { transport } = createWebTransport();

      await expect(transport.invoke('space:list')).rejects.toThrow(/failed attempts/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('retryDelayMs', () => {
    it('floors a sub-second wait so a retry cannot be immediate', () => {
      expect(retryDelayMs('0')).toBe(250);
    });

    it('converts seconds to milliseconds', () => {
      expect(retryDelayMs('2')).toBe(2000);
    });

    it('refuses a header that is not a number', () => {
      expect(retryDelayMs('Wed, 21 Oct 2015 07:28:00 GMT')).toBeNull();
    });

    it('refuses a negative wait', () => {
      expect(retryDelayMs('-5')).toBeNull();
    });
  });

  describe('events', () => {
    it('delivers events on the channel the renderer subscribed to', () => {
      const { transport, dispatch } = createWebTransport();
      const listener = vi.fn();

      // The renderer subscribes per agent; the flattened `channel` on the
      // event is `chat:event`, so routing must use `source`.
      transport.on('chat:event:agent-9', listener);
      dispatch(event('chat:event:agent-9', [{ type: 'assistant.message' }]));

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][1]).toEqual({ type: 'assistant.message' });
    });

    it('does not deliver an event to a different agent listener', () => {
      const { transport, dispatch } = createWebTransport();
      const listener = vi.fn();

      transport.on('chat:event:agent-9', listener);
      dispatch(event('chat:event:agent-3', [{ type: 'assistant.message' }]));

      expect(listener).not.toHaveBeenCalled();
    });

    it('passes multi-argument events through intact', () => {
      const { transport, dispatch } = createWebTransport();
      const listener = vi.fn();

      transport.on('agent:approval-needed', listener);
      dispatch(event('agent:approval-needed', ['agent-1', 'req-2', { tool: 'bash' }]));

      expect(listener.mock.calls[0].slice(1)).toEqual(['agent-1', 'req-2', { tool: 'bash' }]);
    });

    it('stops delivering after removeListener', () => {
      const { transport, dispatch } = createWebTransport();
      const listener = vi.fn();

      transport.on('workspace:changed', listener);
      transport.removeListener('workspace:changed', listener);
      dispatch(event('workspace:changed', [null]));

      expect(listener).not.toHaveBeenCalled();
    });

    it('lets a listener unsubscribe itself mid-dispatch', () => {
      const { transport, dispatch } = createWebTransport();
      const second = vi.fn();
      const first = vi.fn(() => transport.removeListener('workspace:changed', first));

      transport.on('workspace:changed', first);
      transport.on('workspace:changed', second);
      dispatch(event('workspace:changed', [null]));

      // Mutating the set mid-iteration would otherwise skip `second`.
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('isolates a throwing listener from the others', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { transport, dispatch } = createWebTransport();
      const healthy = vi.fn();

      transport.on('workspace:changed', () => { throw new Error('bad listener'); });
      transport.on('workspace:changed', healthy);
      dispatch(event('workspace:changed', [null]));

      expect(healthy).toHaveBeenCalledTimes(1);
    });

    it('falls back to the flattened shape for events with no source', () => {
      const { transport, dispatch } = createWebTransport();
      const listener = vi.fn();

      transport.on('space:processed', listener);
      dispatch({
        channel: 'space:processed',
        payload: { spaceId: 's-1' },
        timestamp: new Date().toISOString(),
        seq: 4,
      } as WebRemoteEvent);

      expect(listener.mock.calls[0][1]).toEqual({ spaceId: 's-1' });
    });
  });

  describe('fire-and-forget', () => {
    it('drops window-management sends instead of failing', () => {
      const { transport } = createWebTransport();
      expect(() => transport.send('window:hide')).not.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('reports the viewing device platform, not the host', () => {
    const { transport } = createWebTransport();
    expect(transport.platform).toBe('darwin');
  });
});
