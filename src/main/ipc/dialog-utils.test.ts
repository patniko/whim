import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockShowOpenDialog, mockGetDisplayMatching, createdWindows } = vi.hoisted(() => ({
  mockShowOpenDialog: vi.fn(),
  mockGetDisplayMatching: vi.fn(),
  createdWindows: [] as any[],
}));

vi.mock('electron', () => {
  class FakeBrowserWindow {
    opts: any;
    destroyed = false;
    ignoredMouse = false;
    shownInactive = false;
    loadedUrl = '';
    constructor(opts: any) {
      this.opts = opts;
      createdWindows.push(this);
    }
    setIgnoreMouseEvents(v: boolean): void { this.ignoredMouse = v; }
    loadURL(url: string): Promise<void> { this.loadedUrl = url; return Promise.resolve(); }
    showInactive(): void { this.shownInactive = true; }
    destroy(): void { this.destroyed = true; }
  }
  return {
    BrowserWindow: FakeBrowserWindow,
    dialog: { showOpenDialog: mockShowOpenDialog },
    screen: { getDisplayMatching: mockGetDisplayMatching },
  };
});

import { showOpenDialog } from './dialog-utils';

/** Stand-in for the real main window. */
function fakeParent(bounds: { x: number; y: number; width: number; height: number }): any {
  return { getBounds: () => bounds, isAlwaysOnTop: () => true };
}

const originalPlatform = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('showOpenDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdWindows.length = 0;
    mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    mockGetDisplayMatching.mockReturnValue({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('uses the parentless dialog when there is no window', async () => {
    setPlatform('darwin');
    await showOpenDialog(null, { properties: ['openDirectory'] });
    expect(mockShowOpenDialog).toHaveBeenCalledWith({ properties: ['openDirectory'] });
    expect(createdWindows).toHaveLength(0);
  });

  it('parents directly to the window off macOS', async () => {
    setPlatform('win32');
    const parent = fakeParent({ x: 100, y: 100, width: 420, height: 900 });
    await showOpenDialog(parent, { properties: ['openDirectory'] });
    expect(mockShowOpenDialog).toHaveBeenCalledWith(parent, { properties: ['openDirectory'] });
    expect(createdWindows).toHaveLength(0);
  });

  it('centers an invisible anchor over the window on macOS', async () => {
    setPlatform('darwin');
    // Narrow strip snapped to the right edge, like the real main window.
    await showOpenDialog(fakeParent({ x: 1480, y: 20, width: 420, height: 1040 }), {
      properties: ['openDirectory'],
    });

    expect(createdWindows).toHaveLength(1);
    const anchor = createdWindows[0];
    // Window center is x=1690; a 760-wide anchor centered there would start at
    // 1310 and end at 2070, so it must be clamped to the work area.
    expect(anchor.opts.x).toBe(1160);
    expect(anchor.opts.x + anchor.opts.width).toBeLessThanOrEqual(1920);
    expect(anchor.opts.y).toBeGreaterThanOrEqual(0);
    expect(anchor.opts.y + anchor.opts.height).toBeLessThanOrEqual(1080);
    expect(anchor.opts.transparent).toBe(true);
    expect(anchor.opts.frame).toBe(false);
    // Must never paint a visible surface behind the sheet.
    expect(anchor.opts.backgroundColor).toBe('#00000000');
    expect(anchor.opts.roundedCorners).toBe(false);
    expect(anchor.opts.hasShadow).toBe(false);
    expect(anchor.loadedUrl).toContain('background%3Atransparent');
    expect(anchor.shownInactive).toBe(true);
    expect(mockShowOpenDialog).toHaveBeenCalledWith(anchor, { properties: ['openDirectory'] });
  });

  it('destroys the anchor even when the dialog rejects', async () => {
    setPlatform('darwin');
    mockShowOpenDialog.mockRejectedValueOnce(new Error('boom'));
    await expect(
      showOpenDialog(fakeParent({ x: 0, y: 0, width: 420, height: 900 }), { properties: ['openDirectory'] })
    ).rejects.toThrow('boom');
    expect(createdWindows[0].destroyed).toBe(true);
  });

  it('destroys the anchor after a successful pick', async () => {
    setPlatform('darwin');
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/picked'] });
    const result = await showOpenDialog(fakeParent({ x: 0, y: 0, width: 420, height: 900 }), {
      properties: ['openDirectory'],
    });
    expect(result.filePaths).toEqual(['/picked']);
    expect(createdWindows[0].destroyed).toBe(true);
  });

  it('falls back to a parentless dialog when the anchor cannot be created', async () => {
    setPlatform('darwin');
    mockGetDisplayMatching.mockImplementation(() => { throw new Error('no display'); });
    await showOpenDialog(fakeParent({ x: 0, y: 0, width: 420, height: 900 }), { properties: ['openDirectory'] });
    expect(mockShowOpenDialog).toHaveBeenCalledWith({ properties: ['openDirectory'] });
  });
});
