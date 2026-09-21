// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  render: vi.fn(),
  health: vi.fn(),
  invoke: vi.fn(),
  write: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('react-dom/client', () => ({
  createRoot: () => ({ render: mock.render }),
}));
vi.mock('./lib/client', () => ({
  hasSession: mock.health,
  establishSession: vi.fn(),
  endSession: vi.fn(),
  WebRemoteClient: class {
    invoke = mock.invoke;
    connect() { return mock.disconnect; }
  },
}));

let app: ReactNode;
let root: Root | undefined;
const space = {
  id: 'document', description: 'Review document', body: '', status: 'captured',
  created_at: '2026-09-10T12:00:00Z', updated_at: '2026-09-10T12:00:00Z',
  client: null, due_at: null, due_at_utc: null, recurrence: null,
};

beforeAll(async () => {
  await import('./index');
  app = mock.render.mock.calls[0][0];
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  mock.health.mockReset().mockResolvedValue(true);
  mock.write.mockReset().mockResolvedValue({ success: true });
  mock.invoke.mockReset().mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'personas:list') return [];
    if (channel === 'workspace:git-status') return { available: false };
    if (channel === 'space:get') return space;
    if (channel === 'canvas:read') return { content: '' };
    if (channel === 'canvas:write') return mock.write(...args);
    if (channel === 'canvas:close') return { success: true };
    return {
      items: channel === 'space:list-page' ? [space] : [],
      total: channel === 'space:list-page' ? 1 : 0,
      nextCursor: null,
      counts: { open: 1, closed: 0, running: 0, waiting: 0, completed: 0, failed: 0 },
    };
  });
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
  const { createRoot } = await vi.importActual<typeof import('react-dom/client')>('react-dom/client');
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root!.render(app); });
}

async function typeInto(textarea: HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('mobile reconnect draft preservation', () => {
  it('reconnects an offline startup shell when connectivity returns', async () => {
    mock.health.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await mount();
    expect(document.body.textContent).toContain('Cannot reach Whim');
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(mock.health).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.capture textarea')).not.toBeNull();
  });

  it('retains an authenticated capture draft without remounting or reauthenticating', async () => {
    await mount();
    const textarea = document.querySelector<HTMLTextAreaElement>('.capture textarea')!;
    await typeInto(textarea, 'Unsaved capture draft');
    expect(document.querySelector<HTMLButtonElement>('.capture button')!.disabled).toBe(false);
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    expect(document.querySelector('.capture textarea')).toBe(textarea);
    expect(textarea.value).toBe('Unsaved capture draft');
    expect(mock.disconnect).not.toHaveBeenCalled();
    expect(mock.health).toHaveBeenCalledOnce();
  });

  it('retains a failed canvas draft and its unload guard through reconnect, then saves on retry', async () => {
    mock.write.mockRejectedValueOnce(new Error('Desktop is offline'));
    await mount();
    await act(async () => { document.querySelector<HTMLElement>('.space-item')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('.screen-top-actions button')!.click(); });
    const textarea = document.querySelector<HTMLTextAreaElement>('.canvas-edit')!;
    await typeInto(textarea, 'Canvas draft while offline');
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(document.body.textContent).toContain('Desktop is offline');
    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(document.querySelector('.canvas-edit')).toBe(textarea);
    expect(textarea.value).toBe('Canvas draft while offline');
    expect(mock.disconnect).not.toHaveBeenCalled();
    expect(mock.health).toHaveBeenCalledOnce();

    await act(async () => { document.querySelector<HTMLButtonElement>('.canvas-screen [role="alert"] button')!.click(); });
    expect(mock.write).toHaveBeenLastCalledWith('document', 'Canvas draft while offline');
    expect(mock.write).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('Desktop is offline');
    const savedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(savedUnload);
    expect(savedUnload.defaultPrevented).toBe(false);
  });
});
