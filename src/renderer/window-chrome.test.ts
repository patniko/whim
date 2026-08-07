import { describe, it, expect } from 'vitest';
import { shouldStartHidden, shouldHideWindow, shouldPopOutCanvas, shouldCloseWindowOnCanvasClose } from './window-chrome';
import { DESKTOP_ONLY_EVENT_CHANNELS } from '../main/web/event-hub';

/**
 * The blank web remote. The renderer parked its content off-screen at
 * `opacity: 0` waiting for `window:shown`, which the gateway is designed never
 * to send to a browser — so the page loaded perfectly and showed nothing.
 *
 * Note what made this hard to catch: the DOM was fully populated the whole
 * time, spaces and all, and the console was empty because nothing had thrown.
 * Only the pixels were wrong.
 */
describe('window chrome', () => {
  describe('shouldStartHidden', () => {
    it('parks the desktop main window off-screen so the first show has no flash', () => {
      expect(shouldStartHidden({ isCanvasMode: false, isSettingsMode: false, isWebRemote: false })).toBe(true);
    });

    it('never parks the web remote, which has nothing to slide it back in', () => {
      expect(shouldStartHidden({ isCanvasMode: false, isSettingsMode: false, isWebRemote: true })).toBe(false);
    });

    it('leaves the popouts alone; they manage their own visibility', () => {
      expect(shouldStartHidden({ isCanvasMode: true, isSettingsMode: false, isWebRemote: false })).toBe(false);
      expect(shouldStartHidden({ isCanvasMode: false, isSettingsMode: true, isWebRemote: false })).toBe(false);
    });

    it('stays visible over the web even in a popout mode', () => {
      expect(shouldStartHidden({ isCanvasMode: true, isSettingsMode: false, isWebRemote: true })).toBe(false);
    });
  });

  describe('shouldHideWindow', () => {
    it('hides the desktop window when asked', () => {
      expect(shouldHideWindow({ isWebRemote: false })).toBe(true);
    });

    /*
     * The triggers are the toggle hotkey, the window losing focus, and the
     * tour. Honouring the blur one in a browser would blank the app every
     * time the user clicked away, with no hotkey to bring it back.
     */
    it('refuses to hide a browser tab, which cannot be brought back', () => {
      expect(shouldHideWindow({ isWebRemote: true })).toBe(false);
    });
  });

  /*
   * This is the constraint the whole module exists to satisfy. If someone ever
   * forwards `window:shown` to the web, the reasoning above changes and this
   * test should be the thing that makes them notice.
   */
  it('confirms the reveal event is never forwarded to a browser', () => {
    expect(DESKTOP_ONLY_EVENT_CHANNELS.has('window:shown')).toBe(true);
    expect(DESKTOP_ONLY_EVENT_CHANNELS.has('window:toggle')).toBe(true);
  });
});

/**
 * Where a canvas is drawn, and what closing it means.
 *
 * The desktop main window hands canvases to a dedicated window with a
 * fire-and-forget send, and the web transport drops every send — so clicking a
 * space in a browser produced no canvas, no request and no error. Closing had
 * the mirror problem: `window.close()` on a tab the app did not open.
 */
describe('shouldPopOutCanvas', () => {
  it('pops out from the desktop main window', () => {
    expect(shouldPopOutCanvas({ isCanvasMode: false, isWebRemote: false })).toBe(true);
  });

  it('does not pop out from the popout itself', () => {
    expect(shouldPopOutCanvas({ isCanvasMode: true, isWebRemote: false })).toBe(false);
  });

  it('never pops out in a browser, which has no window to open', () => {
    expect(shouldPopOutCanvas({ isCanvasMode: false, isWebRemote: true })).toBe(false);
  });

  it('pins that the request to pop out is a dropped send', async () => {
    // The reason this decision exists: `canvas-window:open` is not in the
    // access map at all, because it is a send rather than an invoke — so a
    // browser cannot make it fail loudly, only quietly do nothing.
    const { WEB_ACCESS } = await import('../shared/web-access');
    expect('canvas-window:open' in WEB_ACCESS).toBe(false);
  });
});

describe('shouldCloseWindowOnCanvasClose', () => {
  it('closes the popout window on the desktop', () => {
    expect(shouldCloseWindowOnCanvasClose({ isWebRemote: false })).toBe(true);
  });

  it('leaves the browser tab alone', () => {
    expect(shouldCloseWindowOnCanvasClose({ isWebRemote: true })).toBe(false);
  });
});
