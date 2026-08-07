/**
 * Whether the renderer should take part in the desktop window's slide
 * animation.
 *
 * The Electron app is a panel that slides in and out of the screen edge. To
 * keep the first show from flashing, the renderer starts its content parked
 * off-screen at `opacity: 0` and waits for `window:shown` — emitted by the
 * main process when it shows the window — to slide it into view.
 *
 * A browser has no such window. The page *is* the window, nothing ever shows
 * it, and `window:shown` is listed in `DESKTOP_ONLY_EVENT_CHANNELS`, so the
 * gateway will not forward it even if the desktop window is shown while a
 * browser is connected. Parking the content therefore parks it permanently:
 * the web remote rendered one frame and then sat at opacity 0, fully loaded
 * and completely invisible, with an empty console because nothing had failed.
 *
 * These are two lines of logic, but they are the difference between a working
 * app and a blank page, and the bug was invisible to any check that read the
 * DOM instead of the pixels. They live here so they can be tested without
 * loading the renderer's entire module graph.
 */

export interface WindowChromeContext {
  /** The canvas popout, which manages its own visibility. */
  isCanvasMode: boolean;
  /** The settings popout, likewise. */
  isSettingsMode: boolean;
  /** Running in a browser against the web remote. */
  isWebRemote: boolean;
}

/**
 * Whether to park the content off-screen at startup, waiting for the main
 * process to slide it in.
 */
export function shouldStartHidden(ctx: WindowChromeContext): boolean {
  if (ctx.isWebRemote) return false;
  return !ctx.isCanvasMode && !ctx.isSettingsMode;
}

/**
 * Whether a request to hide the window should actually hide anything.
 *
 * Over the web this must be false. The triggers — the toggle hotkey, the
 * window losing focus, the tour's "hide the pane" step — all assume a hotkey
 * exists to bring the window back. In a tab there is none, so honouring them
 * would blank the page for good; the blur trigger alone would have hidden the
 * app every time the user clicked away from it.
 */
export function shouldHideWindow(ctx: Pick<WindowChromeContext, 'isWebRemote'>): boolean {
  return !ctx.isWebRemote;
}
