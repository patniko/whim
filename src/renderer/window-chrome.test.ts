import { describe, it, expect } from 'vitest';
import { shouldStartHidden, shouldHideWindow } from './window-chrome';
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
