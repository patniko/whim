import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

type Worker = {
  agentId: string;
  status: string;
  summary: string;
  selectedText: string;
  source: string;
  spaceId: string;
};

// All shared mock state lives in vi.hoisted so the (hoisted) vi.mock factories
// below can reference it without a TDZ error.
const h = vi.hoisted(() => {
  const lastTemplateRef = { current: null as MenuItemConstructorOptions[] | null };
  const trayClickRef = { current: null as null | (() => void) };
  const trayInstance = {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'click') trayClickRef.current = handler;
    }),
    destroy: vi.fn(),
  };
  const wm = {
    toggleWindow: vi.fn(),
    getOpenCanvases: vi.fn((): { winId: number; label: string }[] => []),
    focusCanvasWindow: vi.fn(),
    onCanvasWindowsChanged: vi.fn((_cb: () => void) => () => {}),
    openAgentChatInMainWindow: vi.fn(),
  };
  const artifacts = {
    listActiveArtifacts: vi.fn((): any[] => []),
  };
  const artifactWindow = {
    openArtifactWindow: vi.fn(),
  };
  const canvasEvents = {
    onArtifactPublished: vi.fn((_cb: () => void) => () => {}),
  };
  const svc = {
    listTrayWorkers: vi.fn((): Worker[] => []),
    onAgentListChanged: vi.fn((_cb: () => void) => () => {}),
    setAppRemote: vi.fn().mockResolvedValue({ enabled: true, agents: [] }),
  };
  return { lastTemplateRef, trayClickRef, trayInstance, wm, svc, artifacts, artifactWindow, canvasEvents };
});

vi.mock('electron', () => {
  class MockTray {
    setToolTip = h.trayInstance.setToolTip;
    setContextMenu = h.trayInstance.setContextMenu;
    on = h.trayInstance.on;
    destroy = h.trayInstance.destroy;
  }
  return {
    Tray: MockTray,
    Menu: {
      buildFromTemplate: vi.fn((tmpl: MenuItemConstructorOptions[]) => {
        h.lastTemplateRef.current = tmpl;
        return { __isMenu: true, template: tmpl };
      }),
    },
    nativeImage: { createFromPath: vi.fn(() => ({ setTemplateImage: vi.fn() })) },
    app: { isPackaged: false, quit: vi.fn() },
  };
});

vi.mock('./window-manager', () => h.wm);
vi.mock('./agent-service', () => h.svc);
vi.mock('./ipc/canvas-artifact-handlers', () => h.artifacts);
vi.mock('./canvas/artifact-window', () => h.artifactWindow);
vi.mock('./canvas/canvas-events', () => h.canvasEvents);
vi.mock('./config', () => {
  const store: Record<string, any> = { remoteEnabled: false };
  return { getConfigValue: vi.fn((key: string) => store[key]) };
});

import { createTray, rebuildTrayMenu, destroyTray } from './tray';
import { Menu } from 'electron';

const buildFromTemplateMock = Menu.buildFromTemplate as unknown as ReturnType<typeof vi.fn>;

function template(): MenuItemConstructorOptions[] {
  return h.lastTemplateRef.current ?? [];
}
function labels(): string[] {
  return template().map((i) => (i.type === 'separator' ? '---' : String(i.label)));
}
function itemByLabelIncludes(substr: string): MenuItemConstructorOptions | undefined {
  return template().find((i) => typeof i.label === 'string' && i.label.includes(substr));
}

describe('tray menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.lastTemplateRef.current = null;
    h.trayClickRef.current = null;
    h.wm.getOpenCanvases.mockReturnValue([]);
    h.svc.listTrayWorkers.mockReturnValue([]);
    h.artifacts.listActiveArtifacts.mockReturnValue([]);
  });

  afterEach(() => {
    destroyTray();
  });

  it('renders only base items when there are no workers or canvases', () => {
    createTray();
    expect(labels()).toEqual(['📱 Remote Control', '---', 'Quit']);
    expect(itemByLabelIncludes('Show/Hide')).toBeUndefined();
    expect(itemByLabelIncludes('Workers')).toBeUndefined();
    expect(itemByLabelIncludes('Canvases')).toBeUndefined();
    expect(itemByLabelIncludes('Reports')).toBeUndefined();
  });

  it('lists reports from the artifact index and opens one on click', () => {
    h.artifacts.listActiveArtifacts.mockReturnValue([
      { spaceId: 's1', artifactId: 'questions', title: 'Open questions', status: '3 open questions', published: true, updatedAt: '', url: '' },
    ]);
    createTray();

    expect(itemByLabelIncludes('Reports')?.enabled).toBe(false);

    const report = itemByLabelIncludes('3 open questions');
    expect(report?.label).toContain('📊');

    (report!.click as any)();
    expect(h.artifactWindow.openArtifactWindow).toHaveBeenCalledWith({
      spaceId: 's1',
      artifactId: 'questions',
      title: 'Open questions',
      focus: true,
    });
  });

  it('caps the report list so the menu stays usable', () => {
    h.artifacts.listActiveArtifacts.mockReturnValue(
      Array.from({ length: 20 }, (_, i) => ({
        spaceId: `s${i}`, artifactId: `a${i}`, title: `Report ${i}`, published: true, updatedAt: '', url: '',
      })),
    );
    createTray();

    const reportItems = template().filter(i => typeof i.label === 'string' && i.label.includes('Report '));
    expect(reportItems).toHaveLength(8);
  });

  it('survives a workspace that cannot be read', () => {
    h.artifacts.listActiveArtifacts.mockImplementation(() => { throw new Error('no workspace'); });

    expect(() => createTray()).not.toThrow();
    expect(itemByLabelIncludes('Reports')).toBeUndefined();
  });

  it('refreshes when a run publishes a report', () => {
    createTray();
    expect(h.canvasEvents.onArtifactPublished).toHaveBeenCalledTimes(1);
  });

  it('shows a Workers section with status icon + summary and wires the click', () => {
    h.svc.listTrayWorkers.mockReturnValue([
      { agentId: 'a1', status: 'running', summary: 'Refactor auth module', selectedText: 'sel-1', source: 'sdk', spaceId: 's1' },
      { agentId: 'a2', status: 'waiting-approval', summary: 'Write tests', selectedText: 'sel-2', source: 'cli', spaceId: 's2' },
    ]);
    createTray();

    expect(itemByLabelIncludes('Workers')?.enabled).toBe(false);

    const running = itemByLabelIncludes('Refactor auth module');
    expect(running?.label).toContain('▶');
    const waiting = itemByLabelIncludes('Write tests');
    expect(waiting?.label).toContain('⏸');

    (running!.click as any)();
    expect(h.wm.openAgentChatInMainWindow).toHaveBeenCalledWith({
      agentId: 'a1',
      agentPrompt: 'sel-1',
      agentStatus: 'running',
      agentSource: 'sdk',
      spaceId: 's1',
    });
  });

  it('falls back to selectedText and truncates long worker labels', () => {
    const long = 'x'.repeat(120);
    h.svc.listTrayWorkers.mockReturnValue([
      { agentId: 'a1', status: 'running', summary: '', selectedText: long, source: 'sdk', spaceId: 's1' },
    ]);
    createTray();
    const item = template().find((i) => typeof i.label === 'string' && i.label.includes('x'));
    expect(String(item!.label).length).toBeLessThan(60);
    expect(String(item!.label)).toContain('…');
  });

  it('shows a Canvases section and focuses the window on click', () => {
    h.wm.getOpenCanvases.mockReturnValue([{ winId: 7, label: 'My Canvas' }]);
    createTray();

    expect(itemByLabelIncludes('Canvases')?.enabled).toBe(false);
    const canvasItem = itemByLabelIncludes('My Canvas');
    expect(canvasItem).toBeTruthy();

    (canvasItem!.click as any)();
    expect(h.wm.focusCanvasWindow).toHaveBeenCalledWith(7);
  });

  it('tray icon click toggles the window', () => {
    createTray();
    expect(h.trayClickRef.current).toBeTruthy();
    h.trayClickRef.current!();
    expect(h.wm.toggleWindow).toHaveBeenCalledTimes(1);
  });

  it('rebuildTrayMenu re-reads current worker/canvas state', () => {
    createTray();
    expect(itemByLabelIncludes('Workers')).toBeUndefined();

    h.svc.listTrayWorkers.mockReturnValue([
      { agentId: 'a1', status: 'running', summary: 'New work', selectedText: 'sel', source: 'sdk', spaceId: 's1' },
    ]);
    rebuildTrayMenu();
    expect(itemByLabelIncludes('Workers')).toBeTruthy();
    expect(itemByLabelIncludes('New work')).toBeTruthy();
  });

  it('subscribes to worker + canvas changes and rebuilds (debounced)', () => {
    vi.useFakeTimers();
    try {
      createTray();
      expect(h.svc.onAgentListChanged).toHaveBeenCalledTimes(1);
      expect(h.wm.onCanvasWindowsChanged).toHaveBeenCalledTimes(1);

      const before = buildFromTemplateMock.mock.calls.length;

      // Fire the agent-change callback several times in a burst.
      const agentCb = h.svc.onAgentListChanged.mock.calls[0][0];
      agentCb();
      agentCb();
      agentCb();
      // Nothing yet (debounced).
      expect(buildFromTemplateMock.mock.calls.length).toBe(before);

      vi.advanceTimersByTime(250);
      // Exactly one extra rebuild after the debounce window.
      expect(buildFromTemplateMock.mock.calls.length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroyTray unsubscribes and destroys the tray', () => {
    const unsubAgent = vi.fn();
    const unsubCanvas = vi.fn();
    h.svc.onAgentListChanged.mockReturnValueOnce(unsubAgent);
    h.wm.onCanvasWindowsChanged.mockReturnValueOnce(unsubCanvas);

    createTray();
    destroyTray();

    expect(unsubAgent).toHaveBeenCalledTimes(1);
    expect(unsubCanvas).toHaveBeenCalledTimes(1);
    expect(h.trayInstance.destroy).toHaveBeenCalled();
  });
});
