import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebTransport, DeniedError, DesktopOnlyError } from './transport';
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
      await expect(transport.invoke('settings:get', 'theme')).rejects.toThrow(DeniedError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses desktop-only channels without touching the network', async () => {
      const { transport } = createWebTransport();
      await expect(transport.invoke('hotkeys:get')).rejects.toThrow(DesktopOnlyError);
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
