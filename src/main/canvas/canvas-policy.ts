/**
 * Whether a run is allowed to produce canvas artifacts.
 *
 * The capability is derived from the space's `canvas.md` frontmatter rather
 * than stored in a new column, for two reasons:
 *
 * - Frontmatter is already the durable record of how a run was invoked, so the
 *   capability survives resume, restart and a cold database rebuild for free.
 * - Whim's SQLite is a projection replayed from the event log; adding a column
 *   would mean a schema-version bump plus snapshot and replay changes in
 *   compaction, which is far more machinery than this needs.
 *
 * Canvases are scoped deliberately: only skill-launched document runs get them.
 * Quick, selection, comment and supervisor sessions have no owning space to
 * write into, and adding canvas tools to ordinary chat would push the model
 * toward opening canvases nobody asked for.
 */
import { parseFrontmatter } from '../frontmatter';
import { WHIM_REPORT_CANVAS_ID } from './sdk-canvas-provider';

export interface CanvasArtifactPolicy {
  enabled: boolean;
  /** Canvas type the skill prefers. */
  canvasId: string;
  /** Skill that owns the run, when it came from one. */
  skillId?: string;
  /** True when the scheduler started the run, so it must not steal focus. */
  scheduled: boolean;
  /** Identifies this occurrence, so a fresh report can be told from a stale one. */
  runId?: string;
}

export const DISABLED_CANVAS_POLICY: CanvasArtifactPolicy = {
  enabled: false,
  canvasId: WHIM_REPORT_CANVAS_ID,
  scheduled: false,
};

interface CanvasFrontmatter extends Record<string, unknown> {
  canvas_artifacts?: unknown;
  skill_invocation?: { skill_id?: unknown; source?: unknown; run_id?: unknown };
}

/**
 * Read the canvas capability out of a space document.
 *
 * `canvas_artifacts` accepts a boolean or a canvas id, so a skill can opt out
 * explicitly (`canvas_artifacts: false`) or name a specific canvas type.
 */
export function resolveCanvasPolicy(documentContent: string): CanvasArtifactPolicy {
  let frontmatter: CanvasFrontmatter;
  try {
    frontmatter = parseFrontmatter<CanvasFrontmatter>(documentContent).frontmatter ?? {};
  } catch {
    return DISABLED_CANVAS_POLICY;
  }

  const raw = frontmatter.canvas_artifacts;
  if (raw === false || raw === 'false') return DISABLED_CANVAS_POLICY;
  if (raw === undefined || raw === null || raw === '') return DISABLED_CANVAS_POLICY;

  const canvasId = typeof raw === 'string' && raw.trim() && raw.trim() !== 'true'
    ? raw.trim()
    : WHIM_REPORT_CANVAS_ID;

  const invocation = frontmatter.skill_invocation;
  const skillId = typeof invocation?.skill_id === 'string' && invocation.skill_id.trim()
    ? invocation.skill_id.trim()
    : undefined;

  const runId = typeof invocation?.run_id === 'string' && invocation.run_id.trim()
    ? invocation.run_id.trim()
    : undefined;

  return {
    enabled: true,
    canvasId,
    ...(skillId ? { skillId } : {}),
    scheduled: invocation?.source === 'schedule',
    ...(runId ? { runId } : {}),
  };
}
