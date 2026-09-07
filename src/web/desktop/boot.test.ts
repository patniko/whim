// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebRemoteEvent } from '../../main/web/event-hub';

const state = vi.hoisted(() => ({
  resync: () => {},
  event: (_event: WebRemoteEvent) => {},
  dispatch: vi.fn(),
  reload: vi.fn(),
}));
vi.mock('../lib/client', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  establishSession: vi.fn(),
  WebRemoteClient: class {
    connect(event: typeof state.event, _status: unknown, _unauthorized: unknown, resync: () => void) {
      state.event = event;
      state.resync = resync;
    }
  },
}));
vi.mock('./transport', () => ({
  createWebTransport: () => ({ transport: { platform: 'web' }, dispatch: state.dispatch }),
}));
vi.mock('../../shared/whim-api', () => ({ createWhimAPI: () => ({}) }));

let rendererScript: HTMLScriptElement | undefined;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '<textarea>unsaved draft</textarea>';
  rendererScript = undefined;
  const append = document.body.appendChild.bind(document.body);
  vi.spyOn(document.body, 'appendChild').mockImplementation(node => {
    if (node instanceof HTMLScriptElement) {
      rendererScript = node;
      return node;
    }
    return append(node);
  });
  vi.stubGlobal('window', { location: { search: '', reload: state.reload } });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('__WHIM_DESKTOP_ENTRY__', '/synthetic-entry.js');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function boot() {
  await import('./boot');
  await vi.waitFor(() => expect(rendererScript).toBeDefined());
}
async function finishRenderer() {
  rendererScript!.dispatchEvent(new Event('load'));
  await Promise.resolve();
}

describe('desktop web startup and workspace isolation', () => {
  it.each([true, false])('does not reload on the first handshake (renderer already ready: %s)', async ready => {
    await boot();
    if (ready) await finishRenderer();
    state.resync();
    expect(state.reload).not.toHaveBeenCalled();
    if (!ready) await finishRenderer();
    state.resync();
    expect(state.reload).toHaveBeenCalledOnce();
  });

  it('retains drafts and stops replacement-workspace events until an explicit reload', async () => {
    await boot();
    await finishRenderer();
    state.resync();
    state.event({ channel: 'workspace:changed', payload: '/synthetic-replacement', timestamp: '', source: { channel: 'workspace:changed', args: ['/synthetic-replacement'] }, seq: 1 });
    state.event({ channel: 'space:index-changed', payload: null, timestamp: '', source: { channel: 'space:index-changed', args: [] }, seq: 2 });
    state.resync();
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.reload).not.toHaveBeenCalled();
    expect(document.querySelector('textarea')!.value).toBe('unsaved draft');
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Copy any unsaved drafts');
    document.querySelector<HTMLButtonElement>('.web-workspace-changed button')!.click();
    expect(state.reload).toHaveBeenCalledOnce();
  });
});
