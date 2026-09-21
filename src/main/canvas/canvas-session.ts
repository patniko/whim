/**
 * Builds the canvas half of a session config for one run.
 *
 * This is the only place the runner touches the SDK's canvas surface, so the
 * experimental API stays behind a single seam: if the installed SDK or CLI
 * cannot provide canvases, this returns `null` and the run proceeds normally
 * without them rather than failing to launch.
 */
import type { Canvas } from '@github/copilot-sdk';
import { acknowledgeArtifactPublication, getArtifact } from '../storage';
import type { CanvasArtifact } from './artifact-store';
import type { CanvasArtifactPolicy } from './canvas-policy';
import { createSkillTemplateCanvas } from './skill-canvas-provider';
import { resolveSkillCanvasDefinition } from './skill-canvas-template';
import {
  createArtifactCanvas,
  WHIM_CANVAS_PROVIDER_ID,
  WHIM_CANVAS_PROVIDER_NAME,
  WHIM_REPORT_CANVAS_ID,
  type CanvasProviderEvents,
  type CanvasRunContext,
} from './sdk-canvas-provider';

export interface CanvasSessionHooks {
  /** Delivered for changed content, retried until acknowledged. Must be idempotent. */
  onArtifactPublished?: (artifact: CanvasArtifact, ctx: { run: CanvasRunContext; instanceId?: string }) => void | Promise<void>;
  /** Fired when an instance is bound to an artifact, including on reconnect. */
  onArtifactBound?: (artifact: CanvasArtifact, ctx: { run: CanvasRunContext; instanceId: string }) => void | Promise<void>;
  /** Fired when an artifact is bound, published again unchanged, or restyled. */
  onArtifactChanged?: (artifact: CanvasArtifact, ctx: { run: CanvasRunContext }) => void | Promise<void>;
  /** Fired when an instance is closed by the agent, user or runtime. */
  onInstanceClosed?: (ctx: { instanceId: string; run: CanvasRunContext }) => void | Promise<void>;
}

/** The canvas-related fields to spread into `createSession` / `resumeSession`. */
export interface CanvasSessionConfig {
  canvases: Canvas[];
  requestCanvasRenderer: true;
  canvasProvider: { id: string; name: string };
}

export interface CanvasSessionSetup {
  /** Spread into the SDK session config verbatim. */
  config: CanvasSessionConfig;
  /**
   * The canvas the agent will actually see.
   *
   * Returned separately because it can differ from the requested one — a
   * template that failed to resolve falls back to the built-in report canvas —
   * and the instruction contract has to name the canvas that exists, not the
   * one that was asked for.
   */
  canvasId: string;
}

const publicationDeliveries = new Map<string, Promise<void>>();

/** Serialize delivery across sessions; the manifest, not this queue, owns retry state. */
async function deliverPublication(
  artifact: CanvasArtifact,
  run: CanvasRunContext,
  deliver: (current: CanvasArtifact) => void | Promise<void>,
): Promise<void> {
  const previous = publicationDeliveries.get(artifact.dir) ?? Promise.resolve();
  const delivery = previous.then(async () => {
    const current = await getArtifact(run.workspaceRoot, run.folder, artifact.artifactId);
    // Another publisher may have superseded this revision or acknowledged it.
    if (!current?.published || current.pendingPublicationId !== artifact.pendingPublicationId) return;
    await deliver(current);
    if (current.pendingPublicationId) {
      await acknowledgeArtifactPublication({
        workspaceRoot: run.workspaceRoot, folder: run.folder, artifactId: current.artifactId,
        publicationId: current.pendingPublicationId,
      });
    }
  });
  const tail = delivery.then(() => {}, () => {});
  publicationDeliveries.set(artifact.dir, tail);
  try {
    await delivery;
  } finally {
    if (publicationDeliveries.get(artifact.dir) === tail) publicationDeliveries.delete(artifact.dir);
  }
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
): CanvasSessionSetup | null {
  if (!policy.enabled) return null;

  try {
    const events: CanvasProviderEvents = {
      onBound: async (artifact, ctx) => {
        await hooks.onArtifactBound?.(artifact, { run, instanceId: ctx.instanceId });
        await hooks.onArtifactChanged?.(artifact, { run });
      },
      onPublished: async (artifact, ctx) => {
        await hooks.onArtifactChanged?.(artifact, { run });
        if (ctx.changed || artifact.pendingPublicationId) {
          await deliverPublication(artifact, run, current =>
            hooks.onArtifactPublished?.(current, { run, instanceId: ctx.instanceId }));
        }
      },
      onStatusChanged: (artifact) => hooks.onArtifactChanged?.(artifact, { run }),
      onClosed: (ctx) => hooks.onInstanceClosed?.({ instanceId: ctx.instanceId, run }),
    };

    // A skill that ships a template gets that canvas *instead of* the built-in
    // one. Offering both would leave the model to choose, and it would
    // sometimes choose the generic one — which is exactly the inconsistency
    // the skill author shipped a template to avoid.
    const definition = policy.canvasId !== WHIM_REPORT_CANVAS_ID && run.skillId
      ? resolveSkillCanvasDefinition(run.workspaceRoot, run.skillId, policy.canvasId)
      : null;

    if (policy.canvasId !== WHIM_REPORT_CANVAS_ID && !definition) {
      console.warn(
        `[canvas] no template found for canvas type "${policy.canvasId}" — falling back to ${WHIM_REPORT_CANVAS_ID}`,
      );
    }

    const canvas = definition
      ? createSkillTemplateCanvas(run, definition, events)
      : createArtifactCanvas(run, events);

    return {
      config: {
        canvases: [canvas],
        requestCanvasRenderer: true,
        canvasProvider: { id: WHIM_CANVAS_PROVIDER_ID, name: WHIM_CANVAS_PROVIDER_NAME },
      },
      canvasId: definition?.canvasId ?? WHIM_REPORT_CANVAS_ID,
    };
  } catch (err: any) {
    console.warn(`[canvas] canvas support unavailable, continuing without it: ${err?.message ?? err}`);
    return null;
  }
}
