/**
 * Telling the user a report is ready.
 *
 * The rule is narrow on purpose: notify only when a run actually published
 * something new. A scheduled skill that finds nothing should be silent —
 * otherwise the feature becomes a source of noise and gets turned off.
 */
import { BrowserWindow, Notification } from 'electron';
import { openArtifactWindow } from './artifact-window';
import type { CanvasRunResult } from './canvas-outcome';

export interface CanvasNotification {
  title: string;
  body: string;
  /** The artifact a click should open. */
  target: { spaceId: string; artifactId: string; title: string };
}

export interface NotifyContext {
  /** Title of the space, used when the artifact has nothing better to say. */
  spaceLabel?: string;
  /** Whether any whim window currently has focus. */
  anyWindowFocused: boolean;
}

/**
 * Decide what, if anything, to tell the user about a finished run.
 *
 * Returns `null` when there is nothing worth interrupting for.
 */
export function buildCanvasNotification(
  result: CanvasRunResult,
  ctx: NotifyContext,
): CanvasNotification | null {
  if (result.outcome !== 'published') return null;

  const artifact = result.published[result.published.length - 1];
  if (!artifact) return null;

  // A manual run already raised the artifact window in the foreground, and the
  // user is sitting right there — a notification on top of that is just noise.
  if (!result.scheduled && ctx.anyWindowFocused) return null;

  const title = ctx.spaceLabel?.trim() || artifact.title || 'Report ready';
  const extra = result.published.length > 1 ? ` (+${result.published.length - 1} more)` : '';
  const body = `${artifact.status?.trim() || artifact.title || 'A new report is ready'}${extra}`;

  return {
    title,
    body,
    target: { spaceId: result.spaceId, artifactId: artifact.artifactId, title: artifact.title },
  };
}

/** Show the notification, if the run earned one. */
export function notifyCanvasRun(result: CanvasRunResult, spaceLabel?: string): void {
  let anyWindowFocused = false;
  try {
    anyWindowFocused = BrowserWindow.getAllWindows().some(w => !w.isDestroyed() && w.isFocused());
  } catch { /* no windows yet */ }

  const notification = buildCanvasNotification(result, {
    ...(spaceLabel ? { spaceLabel } : {}),
    anyWindowFocused,
  });
  if (!notification) return;

  try {
    if (!Notification.isSupported()) return;
    const native = new Notification({ title: notification.title, body: notification.body, silent: true });
    native.on('click', () => {
      openArtifactWindow({
        spaceId: notification.target.spaceId,
        artifactId: notification.target.artifactId,
        title: notification.target.title,
        focus: true,
      });
    });
    native.show();
  } catch (error) {
    console.warn('[canvas] could not show report notification:', error);
  }
}
