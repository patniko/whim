/**
 * Builds the canvas half of a session config for one run.
 *
 * This is the only place the runner touches the SDK's canvas surface, so the
 * experimental API stays behind a single seam: if the installed SDK or CLI
 * cannot provide canvases, this returns `null` and the run proceeds normally
 * without them rather than failing to launch.
 */
import type { Canvas } from '@github/copilot-sdk';
import type { CanvasArtifact } from './artifact-store';
import type { CanvasArtifactPolicy } from './canvas-policy';
import {
  createArtifactCanvas,
  WHIM_CANVAS_PROVIDER_ID,
  WHIM_CANVAS_PROVIDER_NAME,
  WHIM_REPORT_CANVAS_ID,
  type CanvasRunContext,
} from './sdk-canvas-provider';

export interface CanvasSessionHooks {
  /** Fired once per publish that changed the artifact's bytes. */
  onArtifactPublished?: (artifact: CanvasArtifact, ctx: { run: CanvasRunContext; instanceId?: string }) => void;
  /** Fired when an artifact is bound, published again unchanged, or restyled. */
  onArtifactChanged?: (artifact: CanvasArtifact, ctx: { run: CanvasRunContext }) => void;
  /** Fired when an instance is closed by the agent, user or runtime. */
  onInstanceClosed?: (ctx: { instanceId: string; run: CanvasRunContext }) => void;
}

/** The canvas-related fields to spread into `createSession` / `resumeSession`. */
export interface CanvasSessionConfig {
  canvases: Canvas[];
  requestCanvasRenderer: true;
  canvasProvider: { id: string; name: string };
}

/**
 * Produce the canvas session fields for a run, or `null` when the run is not
 * allowed to produce artifacts.
 *
 * `requestCanvasRenderer` matters: without it the runtime never advertises the
 * canvas tools, so the agent cannot see a canvas we registered. `canvasProvider`
 * gives whim a stable identity so the runtime can re-attach a reconnecting
 * provider to the instances it already knows about, instead of orphaning them.
 */
export function buildCanvasSessionConfig(
  run: CanvasRunContext,
  policy: CanvasArtifactPolicy,
  hooks: CanvasSessionHooks = {},
): CanvasSessionConfig | null {
  if (!policy.enabled) return null;

  if (policy.canvasId && policy.canvasId !== WHIM_REPORT_CANVAS_ID) {
    // Skill-defined canvas types are not implemented yet. Fall back to the
    // built-in rather than launching with a canvas the agent cannot open.
    console.warn(
      `[canvas] unknown canvas type "${policy.canvasId}" — falling back to ${WHIM_REPORT_CANVAS_ID}`,
    );
  }

  try {
    const canvas = createArtifactCanvas(run, {
      onBound: (artifact) => hooks.onArtifactChanged?.(artifact, { run }),
      onPublished: (artifact, ctx) => {
        hooks.onArtifactChanged?.(artifact, { run });
        if (ctx.changed) hooks.onArtifactPublished?.(artifact, { run, instanceId: ctx.instanceId });
      },
      onStatusChanged: (artifact) => hooks.onArtifactChanged?.(artifact, { run }),
      onClosed: (ctx) => hooks.onInstanceClosed?.({ instanceId: ctx.instanceId, run }),
    });

    return {
      canvases: [canvas],
      requestCanvasRenderer: true,
      canvasProvider: { id: WHIM_CANVAS_PROVIDER_ID, name: WHIM_CANVAS_PROVIDER_NAME },
    };
  } catch (err: any) {
    console.warn(`[canvas] canvas support unavailable, continuing without it: ${err?.message ?? err}`);
    return null;
  }
}
