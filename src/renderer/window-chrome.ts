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

/**
 * Whether opening a canvas should pop out a separate desktop window.
 *
 * On the desktop the main window never renders a canvas itself — it asks the
 * main process for a dedicated window and returns. That request is
 * `canvas-window:open`, a fire-and-forget `send` rather than an `invoke`,
 * because there is no reply to wait for.
 *
 * A browser has no second window to open, and the web transport drops every
 * `send` precisely because each one drives a native surface a tab does not
 * have. So over the web the pop-out branch returned having done nothing at
 * all: clicking a space produced no canvas, no error, no request, and an empty
 * console. The renderer already carries the code to draw a canvas in place —
 * it is what the popout runs — so the browser takes that path instead.
 */
export function shouldPopOutCanvas(
  ctx: Pick<WindowChromeContext, 'isCanvasMode' | 'isWebRemote'>,
): boolean {
  if (ctx.isWebRemote) return false;
  return !ctx.isCanvasMode;
}

/**
 * Whether closing a canvas should close the window it lives in.
 *
 * The popout is a whole window, so closing the canvas closes it. A browser
 * refuses `window.close()` for a tab it did not open, which left the web
 * remote's canvas with no way back to the list — and, because the canvas is
 * drawn in the main window there, no need for one: hiding it reveals the list
 * that was underneath all along.
 */
export function shouldCloseWindowOnCanvasClose(
  ctx: Pick<WindowChromeContext, 'isWebRemote'>,
): boolean {
  return !ctx.isWebRemote;
}
