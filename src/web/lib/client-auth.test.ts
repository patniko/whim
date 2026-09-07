import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasSession, WebRemoteClient } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('web session availability', () => {
  it('pins requests to the epoch received during authentication and never retries a stale draft', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', {
      status: 200, headers: { 'X-Whim-Workspace-Epoch': 'synthetic:1' },
    })).mockResolvedValueOnce(new Response('{}', {
      status: 200, headers: { 'X-Whim-Workspace-Epoch': 'synthetic:2' },
    })).mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { message: 'Workspace changed' } }), { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    expect(await hasSession()).toBe(true);
    expect(await hasSession()).toBe(true);
    await expect(new WebRemoteClient().invoke('canvas:write', 'same-id', 'draft')).rejects.toThrow('Workspace changed');
    expect(JSON.parse(fetch.mock.calls[2][1].body).workspaceEpoch).toBe('synthetic:1');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('distinguishes an expired cookie from an unavailable desktop', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetch);
    expect(await hasSession()).toBe(false);
    await expect(hasSession()).rejects.toThrow('HTTP 429');
    await expect(hasSession()).rejects.toThrow('Failed to fetch');
  });
});
