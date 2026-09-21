import { getAgentSession, getSkill, isInitialized, listSkills, markSkillRun, updateSkillSchedule } from '../storage';
import { getConfigValue } from '../config';
import { observeProducer } from '../producer-tasks';
import { invokeSkill } from '../skill-invocation';
import { claimScheduledRun, clearSkillSchedule, completeScheduledRun, failScheduledRun, getSkillSchedule, listSkillSchedules, migrateLegacySkillSchedule, recordScheduledRunLaunch } from '../storage';
import type { ScheduledRun, SkillSchedule } from '../../shared/skill-schedule';
import { isRestartInterruptedSession } from './scheduled-run-recovery';

export { computeNextRunAt } from './skill-schedule-store';
const CHECK_INTERVAL_MS = 60_000;
const RUN_TIMEOUT_MS = 2 * 60 * 60_000;
const RUN_TIMEOUT_SUMMARY = 'Scheduled run timed out; it will not be retried automatically.';
let intervalId: ReturnType<typeof setInterval> | null = null;
let isChecking = false;
let generation = 0;
let pendingRecovery = false;
const launchingSchedules = new Set<string>();

/** main.ts starts this after the watcher's initial skill sync finishes. */
export async function startScheduler(): Promise<void> {
  stopScheduler();
  pendingRecovery = true;
  void observeProducer(checkAndRunDueSkills(true)).catch(reportError);
  intervalId = setInterval(() => { void observeProducer(checkAndRunDueSkills()).catch(reportError); }, CHECK_INTERVAL_MS);
}

export function stopScheduler(): void {
  generation++;
  pendingRecovery = false;
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
}

function reportError(error: unknown): void {
  console.error('[scheduler] Durable schedule processing failed:', error);
}

export async function projectSkillSchedule(schedule: SkillSchedule): Promise<void> {
  (await updateSkillSchedule(
    schedule.skillId, schedule.enabled ? schedule.frequency : null,
    schedule.enabled ? schedule.time : null, schedule.enabled ? schedule.day : null,
    schedule.enabled ? schedule.nextRunAt : null,
  ));
  if (schedule.lastRun) (await markSkillRun(schedule.skillId, schedule.lastRun.startedAt, schedule.nextRunAt));
}

async function hasLiveAgent(run: ScheduledRun): Promise<boolean> {
  if (!run.agentId) return false;
  const { getAgentSessionId } = await import('../agent-service');
  const agent = (await getAgentSession(run.agentId));
  return !!agent && (agent.status === 'running' || agent.status === 'waiting-approval') &&
    (!!getAgentSessionId(run.agentId) || agent.run_location === 'cloud');
}

async function stopExpiredRun(workspace: string, scheduleId: string, run: ScheduledRun): Promise<void> {
  if (run.agentId) {
    const { abortAgent } = await import('../agent-service');
    await abortAgent(run.agentId);
    if (await hasLiveAgent(run)) {
      throw new Error('Timed-out scheduled agent is still active; cancellation must finish before another run can start.');
    }
  }
  await failScheduledRun(workspace, scheduleId, run.id, RUN_TIMEOUT_SUMMARY, false);
}

async function reconcileRun(workspace: string, schedule: SkillSchedule, startup: boolean): Promise<boolean> {
  const run = schedule.lastRun;
  // A terminal occurrence no longer owns the agent's later interactive turns.
  if (!run || run.status !== 'running') return false;
  const agent = run.agentId ? (await getAgentSession(run.agentId)) : null;
  const live = await hasLiveAgent(run);
  if (agent?.status === 'completed') {
    // Canvas completion is owned by result delivery, never inferred from launch.
    if (schedule.output === 'legacy') {
      (await completeScheduledRun(workspace, schedule.id, run.id, {
        status: 'ready', summary: agent.summary || 'Scheduled run completed.', spaceId: run.spaceId,
      }));
    } else {
      (await failScheduledRun(workspace, schedule.id, run.id, 'Agent completed without delivering a scheduled result.', false));
    }
    return false;
  }
  const interrupted = isRestartInterruptedSession(agent);
  if (agent?.status === 'failed' && !interrupted) {
    (await failScheduledRun(workspace, schedule.id, run.id, agent.summary || 'Scheduled agent failed.', false));
    return false;
  }
  if (Date.now() - Date.parse(run.startedAt) >= RUN_TIMEOUT_MS) {
    if (live) await stopExpiredRun(workspace, schedule.id, run);
    else await failScheduledRun(workspace, schedule.id, run.id, RUN_TIMEOUT_SUMMARY, false);
    return live;
  }
  if ((startup || interrupted) && !live) {
    (await failScheduledRun(workspace, schedule.id, run.id, 'Scheduled run was interrupted by an app restart.', schedule.output === 'canvas'));
    return false;
  }
  return true;
}

/** Synchronous disk claims plus this guard serialize the single local owner. */
export async function checkAndRunDueSkills(startup = false): Promise<void> {
  const workspace = getConfigValue('workspace');
  if (!workspace || !isInitialized() || isChecking) return;
  startup ||= pendingRecovery;
  pendingRecovery = false;
  isChecking = true;
  const currentGeneration = generation;
  try {
    for (const skill of (await listSkills())) (await migrateLegacySkillSchedule(workspace, skill));
    for (const schedule of (await listSkillSchedules(workspace))) {
      if (currentGeneration !== generation || getConfigValue('workspace') !== workspace) break;
      if (!(await getSkill(schedule.skillId))) {
        if (schedule.enabled) (await clearSkillSchedule(workspace, schedule.skillId));
        continue;
      }
      (await projectSkillSchedule(schedule));
      try {
        if (launchingSchedules.has(schedule.id) || await reconcileRun(workspace, schedule, startup) || !schedule.enabled) continue;
        if (currentGeneration !== generation || getConfigValue('workspace') !== workspace) break;
        const run = (await claimScheduledRun(workspace, schedule.id));
        if (!run) continue;
        const claimedSchedule = (await getSkillSchedule(workspace, schedule.skillId))!;
        (await projectSkillSchedule(claimedSchedule));
        const launchSchedule = (await getSkillSchedule(workspace, schedule.skillId))!;
        if (!launchSchedule.enabled || currentGeneration !== generation || getConfigValue('workspace') !== workspace) {
          (await completeScheduledRun(workspace, schedule.id, run.id, {
            status: 'failed', summary: 'Schedule stopped before the run could launch.',
          }));
          continue;
        }
        await launchSkillForSchedule(schedule.skillId, { workspace, schedule: launchSchedule, run });
        (await projectSkillSchedule((await getSkillSchedule(workspace, schedule.skillId))!));
      } catch (error) {
        reportError(error);
      }
    }
  } finally {
    isChecking = false;
  }
}

export async function launchSkillForSchedule(
  skillId: string,
  occurrence?: { workspace: string; schedule: SkillSchedule; run: ScheduledRun },
): Promise<{ success: boolean; error?: string }> {
  const workspace = occurrence?.workspace ?? getConfigValue('workspace');
  if (!workspace || !isInitialized()) return { success: false, error: 'no_workspace' };
  const schedule = occurrence?.schedule;
  const run = occurrence?.run;
  let acknowledged = false;
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error('Scheduled launch timed out; it will not be retried automatically.');
  try {
    if (schedule) launchingSchedules.add(schedule.id);
    const invocation = Promise.resolve().then(() => invokeSkill({
      skillId, run: true, source: 'schedule',
      ...(schedule && run ? {
        ...(schedule.output === 'canvas' ? { intent: schedule.intent } : {}),
        scheduledRun: {
          scheduleId: schedule.id, runId: run.id, scheduledAt: run.scheduledAt,
          output: schedule.output,
          timeZone: schedule.timeZone, readOnlyServers: schedule.readOnlyServers,
          previousSpaceId: schedule.lastSuccessfulRun?.spaceId,
          lastSuccessfulAt: schedule.lastSuccessfulRun?.completedAt,
        },
      } : {}),
    })).then(async result => {
      acknowledged = true;
      if ('space' in result && schedule && run) {
        (await recordScheduledRunLaunch(workspace, schedule.id, run.id, {
          spaceId: result.space.id, agentId: result.agent?.agentId,
        }));
      }
      if (timedOut && schedule && run) {
        const current = await getSkillSchedule(workspace, skillId);
        if (current?.lastRun?.id === run.id && current.lastRun.status === 'running') {
          await stopExpiredRun(workspace, schedule.id, current.lastRun);
        }
      }
      return result;
    }).catch(error => {
      if (timedOut) console.error(`[scheduler] Timed-out launch later failed for ${skillId}:`, error);
      throw error;
    }).finally(() => {
      if (schedule) launchingSchedules.delete(schedule.id);
    });
    const result = await Promise.race([
      invocation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(timeoutError);
        }, RUN_TIMEOUT_MS);
      }),
    ]);
    if ('space' in result && !result.error) return { success: true };
    const error = result.error || 'launch_failed';
    if (schedule && run) (await failScheduledRun(workspace, schedule.id, run.id, error, true));
    return { success: false, error };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An exception may follow a launch with external effects. Only read-only
    // canvas attempts are safe to retry when launch acknowledgement is lost.
    if (schedule && run) {
      if (error === timeoutError) {
        const current = await getSkillSchedule(workspace, skillId);
        // A launch without an acknowledged agent identity remains claimed.
        // Its late return must revoke publishing privileges before expiration.
        if (current?.lastRun?.id === run.id && current.lastRun.status === 'running' && current.lastRun.agentId) {
          await stopExpiredRun(workspace, schedule.id, current.lastRun);
        }
      } else {
        await failScheduledRun(workspace, schedule.id, run.id, message, schedule.output === 'canvas' && !acknowledged);
      }
    }
    console.error(`[scheduler] Launch failed for ${skillId}:`, error);
    return { success: false, error: message };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
