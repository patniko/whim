/**
 * The `whim-report` SDK canvas.
 *
 * Whim is the canvas *provider*: it declares this canvas on the sessions that
 * are allowed to produce artifacts, and the agent drives it with `open_canvas`
 * and `invoke_canvas_action`.
 *
 * Two deliberate shape decisions:
 *
 * 1. `open` is idempotent and read-mostly. The runtime re-issues `canvas.open`
 *    whenever a provider reconnects, so an `open` that published content would
 *    duplicate work, resurrect stale input and fire false notifications on
 *    every app restart. Opening only binds an instance to an artifact.
 *
 * 2. Content arrives by reference, not by value. The agent writes the HTML with
 *    its ordinary file tools and calls `publish` with a relative path. Passing
 *    whole documents through the RPC would persist them in the runtime's
 *    durable session events and replay them on every reconnect.
 *
 * 3. No URL crosses the RPC boundary. `whim-artifact://` is a private Electron
 *    scheme, and the runtime validates the `url` a provider returns from `open`
 *    against the schemes it knows how to render — a private one fails the whole
 *    open, so `publish` never runs and the report is written but never
 *    attached. Nothing needs the URL anyway: whim is its own host and opens
 *    artifact windows from the events below, addressing them by space and
 *    artifact id. `url` stays optional and unset.
 *
 * The canvas is built per run, so the owning space is captured in the closure
 * rather than looked up from a session id — which cannot be resolved reliably
 * during a cold resume, when the provider may reconnect before whim has
 * reconstructed its agent records.
 */
import { createCanvas, type Canvas } from '@github/copilot-sdk';
import {
  bindArtifact,
  getArtifact,
  publishArtifact,
  setArtifactStatus,
  toArtifactId,
  isValidArtifactId,
  CanvasArtifactError,
  type CanvasArtifact,
} from './artifact-store';

export const WHIM_REPORT_CANVAS_ID = 'whim-report';
export const WHIM_CANVAS_PROVIDER_ID = 'whim';
export const WHIM_CANVAS_PROVIDER_NAME = 'Whim';

/** The run a canvas belongs to. Captured per session, never model-supplied. */
export interface CanvasRunContext {
  workspaceRoot: string;
  /** Space folder, relative to the workspace root. */
  folder: string;
  spaceId: string;
  skillId?: string;
  /** Identifies this specific run, so completion can tell new output from old. */
  runId?: string;
  /** A scheduled run must not steal focus when an artifact opens. */
  scheduled?: boolean;
  /**
   * Forces every artifact this run touches to one id, ignoring what the model
   * asks for.
   *
   * Set for comment-launched runs, where the id is derived from the thread. Two
   * threads on the same space are two different questions and must not share a
   * report — but both would default to `report`, and the second publish would
   * overwrite the first with no sign that anything was lost. Nothing in the
   * model's input can distinguish the threads, so the host decides.
   */
  pinnedArtifactId?: string;
}

export interface CanvasProviderEvents {
  /** An instance was bound to an artifact. */
  onBound?: (artifact: CanvasArtifact, ctx: { instanceId: string; run: CanvasRunContext }) => void;
  /** Content was published. `changed` is false when the bytes were identical. */
  onPublished?: (
    artifact: CanvasArtifact,
    ctx: { instanceId?: string; run: CanvasRunContext; changed: boolean },
  ) => void;
  /** Status or title changed without a republish. */
  onStatusChanged?: (artifact: CanvasArtifact, ctx: { run: CanvasRunContext }) => void;
  /** The agent, user or runtime closed an instance. */
  onClosed?: (ctx: { instanceId: string; run: CanvasRunContext }) => void;
}

const DEFAULT_ARTIFACT_ID = 'report';

function readString(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the artifact an instance refers to.
 *
 * The model may name an artifact, but only within its own run's space — the
 * space itself is never model-supplied, so one run cannot write into another's
 * space by passing a different id.
 */
function resolveArtifactId(input: Record<string, unknown> | undefined, run: CanvasRunContext): string {
  // A pinned id wins over anything the model supplies. Silently, and without
  // an error: the model has no way to know the id is host-assigned, so failing
  // its publish over a name it was never told is a pointless way to lose a
  // report that has already been written.
  if (run.pinnedArtifactId) return run.pinnedArtifactId;

  const requested = readString(input, 'artifactId');
  // An explicit id is validated rather than slugified. Slugifying it makes
  // "Q&A" and "Q A" the same directory, so one report quietly replaces another;
  // rejecting it tells the model to pick a different one while it can still act.
  if (requested) {
    if (!isValidArtifactId(requested)) {
      throw new CanvasArtifactError(
        'invalid_artifact_id',
        `artifactId must be lowercase letters, digits and hyphens (got "${requested}")`,
      );
    }
    return requested;
  }

  const title = readString(input, 'title');
  if (title) return toArtifactId(title, DEFAULT_ARTIFACT_ID);

  return DEFAULT_ARTIFACT_ID;
}

function describeError(err: unknown): string {
  if (err instanceof CanvasArtifactError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Build the `whim-report` canvas for one run. */
export function createArtifactCanvas(run: CanvasRunContext, events: CanvasProviderEvents = {}): Canvas {
  return createCanvas({
    id: WHIM_REPORT_CANVAS_ID,
    displayName: 'Whim report',
    description:
      'A durable HTML report attached to this space. Write the report to a file in the space, ' +
      'then publish it here so the user can reopen it later.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title shown in the window and the space list.' },
        artifactId: {
          type: 'string',
          description:
            'Optional stable id for this report. Reuse the same id across runs to refresh one report ' +
            'instead of creating another. Lowercase letters, digits and hyphens only.',
        },
        status: { type: 'string', description: 'Short status line, e.g. "7 open questions".' },
      },
    },
    actions: [
      {
        name: 'publish',
        description:
          'Publish an HTML file you have already written as the current content of this report. ' +
          'The path must be relative to the space folder. Call this before finishing the run.',
        inputSchema: {
          type: 'object',
          required: ['path'],
          properties: {
            path: {
              type: 'string',
              description: 'Path to the HTML file, relative to the space folder.',
            },
            dataPath: {
              type: 'string',
              description: 'Optional path to a JSON payload, relative to the space folder.',
            },
            title: { type: 'string', description: 'Title shown in the window and the space list.' },
            status: { type: 'string', description: 'Short status line, e.g. "7 open questions".' },
            artifactId: { type: 'string', description: 'Report to publish into. Defaults to the opened one.' },
            contentHash: { type: 'string', description: 'Optional sha256 of the file, verified before publishing.' },
          },
        },
        handler: async ctx => {
          const input = ctx.input as Record<string, unknown> | undefined;
          const relativePath = readString(input, 'path');
          if (!relativePath) {
            return { ok: false, error: 'A relative `path` to the HTML file is required.' };
          }

          try {
            const artifactId = resolveArtifactId(input, run);
            const title = readString(input, 'title') ?? getArtifact(run.workspaceRoot, run.folder, artifactId)?.title
              ?? 'Report';
            const { artifact, changed } = await publishArtifact({
              workspaceRoot: run.workspaceRoot,
              folder: run.folder,
              spaceId: run.spaceId,
              artifactId,
              title,
              sourceRelativePath: relativePath,
              ...(readString(input, 'dataPath') ? { dataRelativePath: readString(input, 'dataPath')! } : {}),
              ...(readString(input, 'status') !== undefined ? { status: readString(input, 'status') } : {}),
              ...(readString(input, 'contentHash') ? { contentHash: readString(input, 'contentHash')! } : {}),
              ...(run.runId ? { runId: run.runId } : {}),
              ...(run.skillId ? { skillId: run.skillId } : {}),
            });

            events.onPublished?.(artifact, { instanceId: ctx.instanceId, run, changed });
            return {
              ok: true,
              artifactId: artifact.artifactId,
              changed,
            };
          } catch (err) {
            // Publication failure must be visible to the model so it can report
            // it, rather than finishing as if the run succeeded.
            return { ok: false, error: describeError(err) };
          }
        },
      },
      {
        name: 'set_status',
        description: 'Update the short status line of a report without republishing its content.',
        inputSchema: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string' },
            title: { type: 'string' },
            artifactId: { type: 'string' },
          },
        },
        handler: async ctx => {
          const input = ctx.input as Record<string, unknown> | undefined;
          const status = readString(input, 'status');
          if (!status) return { ok: false, error: 'A `status` is required.' };

          let artifactId: string;
          try {
            artifactId = resolveArtifactId(input, run);
          } catch (err) {
            return { ok: false, error: describeError(err) };
          }
          try {
            const artifact = await setArtifactStatus({              workspaceRoot: run.workspaceRoot,
              folder: run.folder,
              artifactId,
              status,
              ...(readString(input, 'title') ? { title: readString(input, 'title')! } : {}),
            });
            if (!artifact) return { ok: false, error: `No report named "${artifactId}" yet.` };

            events.onStatusChanged?.(artifact, { run });
            return { ok: true, artifactId: artifact.artifactId };
          } catch (err) {
            return { ok: false, error: describeError(err) };
          }
        },
      },
    ],
    open: async ctx => {
      const input = ctx.input as Record<string, unknown> | undefined;
      const artifactId = resolveArtifactId(input, run);
      const title = readString(input, 'title') ?? 'Report';

      const artifact = await bindArtifact({
        workspaceRoot: run.workspaceRoot,
        folder: run.folder,
        spaceId: run.spaceId,
        artifactId,
        title,
        instanceId: ctx.instanceId,
        canvasId: WHIM_REPORT_CANVAS_ID,
        ...(run.skillId ? { skillId: run.skillId } : {}),
      });

      events.onBound?.(artifact, { instanceId: ctx.instanceId, run });

      return {
        // Deliberately no `url` — see the note at the top of this file.
        title: artifact.title,
        // Until content is published there is nothing to render; say so rather
        // than showing an empty window with no explanation.
        status: artifact.published ? (artifact.status ?? 'Ready') : 'Waiting for content',
      };
    },
    onClose: ctx => {
      events.onClosed?.({ instanceId: ctx.instanceId, run });
    },
  });
}
