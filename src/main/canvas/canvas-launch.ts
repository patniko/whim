/**
 * Glue between an agent launch and the canvas artifact stack.
 *
 * The runner asks one question — "may this run produce artifacts, and if so
 * with what context?" — and gets back either the canvas session fields or
 * `null`. Keeping the decision here means the create, resume and restart paths
 * in `sdk-runner` all reach the same answer, which matters because a run that
 * loses its canvases on resume would silently stop refreshing its artifact.
 */
import * as fs from 'fs';
import * as path from 'path';
import { openArtifactWindow, reloadArtifactWindow, setArtifactWindowTitle } from './artifact-window';
import { bindCanvasInstance } from './canvas-lifecycle';
import { beginCanvasRun, recordCanvasPublication } from './canvas-outcome';
import { emitArtifactPublished } from './canvas-events';
import { resolveCanvasPolicy, type CanvasArtifactPolicy } from './canvas-policy';
import { buildCanvasSessionConfig, type CanvasSessionConfig, type CanvasSessionHooks } from './canvas-session';
import type { CanvasArtifact } from './artifact-store';
import { sendToAllWindows } from '../ipc/typed-handler';
import type { CanvasRunContext } from './sdk-canvas-provider';

const WORKSPACE_SPACE_ID = '__workspace__';

export interface RunCanvasSetup {
  /** Fields to spread into the SDK session config. */
  session: CanvasSessionConfig;
  /** Context the run was built with, for callers that need to know how it runs. */
  run: CanvasRunContext;
}

export interface ResolveRunCanvasParams {
  workspaceRoot: string;
  /** Absolute working directory of the run — the space folder. */
  workingDir: string;
  spaceId: string | null | undefined;
  /** The agent running this session, used to reach it when a window closes. */
  agentId?: string;
  /** Extra behaviour on top of the default window handling. */
  hooks?: CanvasSessionHooks;
}

/** Read a space's `canvas.md`, if it has one. */
function readSpaceDocument(workingDir: string): string {
  try {
    const canvasPath = path.join(workingDir, 'canvas.md');
    return fs.existsSync(canvasPath) ? fs.readFileSync(canvasPath, 'utf-8') : '';
  } catch {
    return '';
  }
}

/**
 * Default artifact handling: show the artifact when it first appears and keep
 * an already-open window in sync afterwards.
 *
 * Scheduled runs deliberately open without focus. The whole point of scheduling
 * is that the user is elsewhere; stealing the foreground mid-task would make
 * the feature something people turn off.
 */
function defaultHooks(run: CanvasRunContext, agentId: string | undefined, extra?: CanvasSessionHooks): CanvasSessionHooks {
  const show = (artifact: CanvasArtifact, instanceId?: string) => {
    if (!artifact.published) return;
    const key = { spaceId: run.spaceId, artifactId: artifact.artifactId };
    openArtifactWindow({ ...key, title: artifact.title, focus: !run.scheduled, ...(instanceId ? { instanceId } : {}) });
    reloadArtifactWindow(key);
  };

  const announce = (artifact: CanvasArtifact) => {
    if (!artifact.published) return;
    const event = { spaceId: run.spaceId, artifactId: artifact.artifactId, title: artifact.title };
    emitArtifactPublished(event);
    try {
      sendToAllWindows('canvas-artifact:published', event);
    } catch { /* the renderer may not exist yet; the list reloads on next read */ }
  };

  return {
    onArtifactBound: (artifact, ctx) => {
      if (agentId) {
        bindCanvasInstance(ctx.instanceId, {
          agentId,
          spaceId: run.spaceId,
          artifactId: artifact.artifactId,
        });
      }
      extra?.onArtifactBound?.(artifact, ctx);
    },
    onArtifactPublished: (artifact, ctx) => {
      show(artifact, ctx.instanceId);
      announce(artifact);
      if (agentId) recordCanvasPublication(agentId, artifact);
      extra?.onArtifactPublished?.(artifact, ctx);
    },
    onArtifactChanged: (artifact, ctx) => {
      setArtifactWindowTitle({ spaceId: run.spaceId, artifactId: artifact.artifactId }, artifact.title);
      announce(artifact);
      extra?.onArtifactChanged?.(artifact, ctx);
    },
    onInstanceClosed: (ctx) => extra?.onInstanceClosed?.(ctx),
  };
}

/**
 * Decide whether a run gets canvases, and build them if so.
 *
 * Runs without an owning space are excluded up front: quick, selection and
 * supervisor sessions have nowhere to write an artifact, and the workspace-level
 * session is shared rather than owned by any one skill.
 */
export function resolveRunCanvasConfig(params: ResolveRunCanvasParams): RunCanvasSetup | null {
  const { workspaceRoot, workingDir, spaceId, agentId } = params;
  if (!spaceId || spaceId === WORKSPACE_SPACE_ID) return null;

  const document = readSpaceDocument(workingDir);
  if (!document) return null;

  const policy: CanvasArtifactPolicy = resolveCanvasPolicy(document);
  if (!policy.enabled) return null;

  const folder = path.relative(workspaceRoot, workingDir);
  if (!folder || folder.startsWith('..') || path.isAbsolute(folder)) {
    console.warn(`[canvas] working dir ${workingDir} is outside the workspace — skipping canvases`);
    return null;
  }

  const run: CanvasRunContext = {
    workspaceRoot,
    folder,
    spaceId,
    ...(policy.skillId ? { skillId: policy.skillId } : {}),
    ...(policy.runId ? { runId: policy.runId } : {}),
    scheduled: policy.scheduled,
  };

  const session = buildCanvasSessionConfig(run, policy, defaultHooks(run, agentId, params.hooks));
  if (!session) return null;

  if (agentId) {
    beginCanvasRun({
      agentId,
      spaceId: run.spaceId,
      ...(run.skillId ? { skillId: run.skillId } : {}),
      ...(run.runId ? { runId: run.runId } : {}),
      scheduled: run.scheduled ?? false,
    });
  }

  return { session, run };
}
