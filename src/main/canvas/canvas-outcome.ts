/**
 * What a canvas-enabled run actually produced.
 *
 * The scheduler reports success at *launch*, so nothing upstream knows whether
 * a run left a report behind. This tracks publication per run so completion can
 * tell "produced a report" from "finished having published nothing", and so a
 * notification only ever fires for output the user has not already seen.
 */
import type { CanvasArtifact } from './artifact-store';

export type CanvasRunOutcome = 'published' | 'no-output';

export interface CanvasRunResult {
  outcome: CanvasRunOutcome;
  spaceId: string;
  skillId?: string;
  runId?: string;
  scheduled: boolean;
  /** Artifacts published during this run, in publication order. */
  published: Array<{ artifactId: string; title: string; status?: string }>;
}

interface RunState {
  spaceId: string;
  skillId?: string;
  runId?: string;
  scheduled: boolean;
  published: Map<string, { artifactId: string; title: string; status?: string }>;
  /** Set once the outcome has been reported, so a re-idle cannot notify twice. */
  reported: boolean;
}

const runs = new Map<string, RunState>();

export interface CanvasRunRegistration {
  agentId: string;
  spaceId: string;
  skillId?: string;
  runId?: string;
  scheduled?: boolean;
}

/** Start tracking a canvas-enabled run. Re-registering resets it, since a
 *  restart is a fresh attempt whose output should be judged on its own. */
export function beginCanvasRun(registration: CanvasRunRegistration): void {
  runs.set(registration.agentId, {
    spaceId: registration.spaceId,
    ...(registration.skillId ? { skillId: registration.skillId } : {}),
    ...(registration.runId ? { runId: registration.runId } : {}),
    scheduled: registration.scheduled ?? false,
    published: new Map(),
    reported: false,
  });
}

/**
 * Note that a run published an artifact.
 *
 * A republish of the same artifact is recorded once: the user cares that the
 * report is there, not how many times the agent rewrote it.
 */
export function recordCanvasPublication(agentId: string, artifact: CanvasArtifact): void {
  const run = runs.get(agentId);
  if (!run) return;
  run.published.set(artifact.artifactId, {
    artifactId: artifact.artifactId,
    title: artifact.title,
    ...(artifact.status ? { status: artifact.status } : {}),
  });
}

/**
 * Report on a finished run, exactly once.
 *
 * Returns `null` when the run was not canvas-enabled or has already been
 * reported, so callers can wire this into an idle event that may fire more
 * than once without producing duplicate notifications.
 */
export function reportCanvasRun(agentId: string): CanvasRunResult | null {
  const run = runs.get(agentId);
  if (!run || run.reported) return null;
  run.reported = true;

  const published = [...run.published.values()];
  return {
    outcome: published.length > 0 ? 'published' : 'no-output',
    spaceId: run.spaceId,
    ...(run.skillId ? { skillId: run.skillId } : {}),
    ...(run.runId ? { runId: run.runId } : {}),
    scheduled: run.scheduled,
    published,
  };
}

/** Forget a run once its agent is gone. */
export function endCanvasRun(agentId: string): void {
  runs.delete(agentId);
}

/** Test seam. */
export function resetCanvasRuns(): void {
  runs.clear();
}
