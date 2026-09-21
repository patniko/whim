import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSession, Skill, SkillInvocationResult } from '../../shared/types';

// Mock the database and other native-dependent modules so we can import
// the scheduler without loading better-sqlite3.
vi.mock('../storage', async () => ({
  ...(await import('../workspace')),
  ...(await import('./skill-schedule-store')),
  ...(await import('../canvas/artifact-store')),
  documentMatches: (await import('../storage-documents')).documentMatches,
  getStorageGeneration: () => 0,
  withWorkspaceContext: (run: () => unknown) => run(),
  withStorageGeneration: (_generation: number, run: () => unknown) => run(),

  ...await import('./skill-schedule-store'),
  getDueSkills: vi.fn(() => []),
  getScheduledSkillsNeedingNextRun: vi.fn(() => []),
  claimSkillRun: vi.fn(() => true),
  updateSkillSchedule: vi.fn(),
  getSkill: vi.fn(),
  createSpace: vi.fn(),
  assignSpaceFolder: vi.fn(),
  isInitialized: vi.fn(() => false),
  listSkills: vi.fn(() => []),
  markSkillRun: vi.fn(),
  getAgentSession: vi.fn(() => null),
}));

vi.mock('../skill-invocation', () => ({ invokeSkill: vi.fn() }));
vi.mock('../agent-service', () => ({ getAgentSessionId: vi.fn(() => null), abortAgent: vi.fn() }));
vi.mock('../config', () => ({
  getConfigValue: vi.fn(() => null),
}));

vi.mock('../workspace', () => ({
  createSpaceFolder: vi.fn(),
  scheduleAutoCommit: vi.fn(),
}));

vi.mock('../frontmatter', () => ({
  serializeFrontmatter: vi.fn((_fm: unknown, body: string) => body),
}));

vi.mock('../notify', () => ({
  notifyAllWindows: vi.fn(),
}));

import { checkAndRunDueSkills, computeNextRunAt, startScheduler, stopScheduler } from './scheduler';
import { getAgentSession, getSkill, isInitialized, listSkills, updateSkillSchedule } from '../storage';
import { getConfigValue } from '../config';
import { abortAgent, getAgentSessionId } from '../agent-service';
import { invokeSkill } from '../skill-invocation';
import {
  claimScheduledRun, clearSkillSchedule, completeScheduledRun, getSkillSchedule, listScheduledRuns,
  migrateLegacySkillSchedule, recordScheduledRunLaunch, saveSkillSchedule,
} from './skill-schedule-store';

describe('computeNextRunAt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  describe('durable scheduler loop', () => {
    let workspace: string;
    const skill = { id: 'digest', name: 'Digest', schedule: null } as Skill;
    const options = { timeZone: 'UTC', intent: 'Find relevant changes', readOnlyServers: ['github'] };
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T08:00:00Z'));
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-scheduler-'));
      vi.mocked(isInitialized).mockReturnValue(true);
      vi.mocked(getConfigValue).mockReturnValue(workspace);
      vi.mocked(listSkills).mockResolvedValue([skill]);
      vi.mocked(getSkill).mockResolvedValue(skill);
      vi.mocked(getAgentSession).mockResolvedValue(null);
      vi.mocked(updateSkillSchedule).mockReset();
      vi.mocked(getAgentSessionId).mockReturnValue(null);
      vi.mocked(abortAgent).mockReset().mockResolvedValue(undefined);
      vi.mocked(invokeSkill).mockReset();
      vi.mocked(invokeSkill).mockResolvedValue({
        space: { id: 'result' }, agent: { agentId: 'agent', sessionId: 'session' }, canvasContent: '',
      } as SkillInvocationResult);
    });
    afterEach(() => {
      stopScheduler();
      vi.useRealTimers();
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('runs one overdue startup digest with persisted invocation context', async () => {
      const schedule = saveSkillSchedule(workspace, skill.id, 'daily', '09:00', null, options);
      vi.setSystemTime(new Date('2024-01-10T12:00:00Z'));
      await checkAndRunDueSkills(true);
      expect(invokeSkill).toHaveBeenCalledExactlyOnceWith({
        skillId: skill.id, run: true, source: 'schedule', intent: options.intent,
        scheduledRun: {
          scheduleId: schedule.id, runId: expect.any(String), scheduledAt: schedule.nextRunAt,
          output: 'canvas',
          timeZone: 'UTC', readOnlyServers: ['github'], previousSpaceId: undefined, lastSuccessfulAt: undefined,
        },
      });
      expect(getSkillSchedule(workspace, skill.id)).toMatchObject({
        nextRunAt: '2024-01-11T09:00:00.000Z',
        lastRun: { status: 'running', agentId: 'agent', spaceId: 'result' },
      });
      await checkAndRunDueSkills();
      expect(invokeSkill).toHaveBeenCalledTimes(1);
    });

    it('keeps scheduling after a completed occurrence gets an interactive approval-waiting followup', async () => {
      const schedule = saveSkillSchedule(workspace, skill.id, 'daily', '09:00', null, options);
      vi.setSystemTime(new Date(schedule.nextRunAt!));
      await checkAndRunDueSkills();
      const first = getSkillSchedule(workspace, skill.id)!.lastRun!;
      completeScheduledRun(workspace, schedule.id, first.id, {
        status: 'ready', summary: 'Original daily result', spaceId: 'result',
      });
      const completed = listScheduledRuns(workspace, schedule.id)[0];
      const followup: AgentSession = {
        id: 'agent', session_id: 'session', space_id: 'result', prompt: 'Investigate this result',
        status: 'waiting-approval', summary: 'Waiting for an interactive approval',
        source: 'sdk', run_location: 'local', working_dir: workspace,
        persona_handle: null, quoted_text: null,
        created_at: first.startedAt, updated_at: '2024-01-01T10:00:00.000Z',
      };
      vi.mocked(getAgentSession).mockImplementation(async id => id === followup.id ? followup : null);
      vi.mocked(getAgentSessionId).mockImplementation(id => id === followup.id ? followup.session_id : null);
      vi.mocked(invokeSkill).mockResolvedValue({
        space: { id: 'next-result' }, agent: { agentId: 'next-agent', sessionId: 'next-session' }, canvasContent: '',
      } as SkillInvocationResult);

      for (const day of [2, 3]) {
        vi.setSystemTime(new Date(`2024-01-0${day}T09:00:00Z`));
        await checkAndRunDueSkills();
        const next = getSkillSchedule(workspace, skill.id)!.lastRun!;
        expect(next).toMatchObject({
          scheduledAt: `2024-01-0${day}T09:00:00.000Z`, status: 'running',
          attempt: 1, agentId: 'next-agent',
        });
        expect(next.id).not.toBe(first.id);
        completeScheduledRun(workspace, schedule.id, next.id, { status: 'ready', summary: 'Next daily result' });
      }

      expect(invokeSkill).toHaveBeenCalledTimes(3);
      expect(listScheduledRuns(workspace, schedule.id)[0]).toEqual(completed);
      expect(followup.status).toBe('waiting-approval');
      expect(abortAgent).not.toHaveBeenCalled();
    });

    it('recovers interrupted read-only claims and retries the same occurrence', async () => {
      const schedule = saveSkillSchedule(workspace, skill.id, 'daily', '09:00', null, options);
      vi.setSystemTime(new Date(schedule.nextRunAt!));
      const first = claimScheduledRun(workspace, schedule.id)!;
      await checkAndRunDueSkills(true);
      expect(invokeSkill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      await checkAndRunDueSkills();
      expect(getSkillSchedule(workspace, skill.id)?.lastRun).toMatchObject({
        scheduledAt: first.scheduledAt, attempt: 2, status: 'running',
      });
    });

    it('does not retry interrupted legacy runs with possible external effects', async () => {
      const legacy = { ...skill, schedule: 'daily' as const, schedule_time: '09:00', schedule_day: null };
      const schedule = migrateLegacySkillSchedule(workspace, legacy)!;
      vi.setSystemTime(new Date(schedule.nextRunAt!));
      claimScheduledRun(workspace, schedule.id);
      await checkAndRunDueSkills(true);
      vi.advanceTimersByTime(300_000);
      await checkAndRunDueSkills();
      expect(invokeSkill).not.toHaveBeenCalled();
      expect(getSkillSchedule(workspace, skill.id)?.lastRun).toMatchObject({ status: 'failed', attempt: 1 });
    });

    it('passes legacy completion context without selecting canvas output', async () => {
      const schedule = migrateLegacySkillSchedule(workspace, {
        ...skill, schedule: 'daily', schedule_time: '09:00', schedule_day: null,
      })!;
      vi.setSystemTime(new Date(schedule.nextRunAt!));
      await checkAndRunDueSkills();
      expect(invokeSkill).toHaveBeenCalledWith({
        skillId: skill.id, run: true, source: 'schedule',
        scheduledRun: {
          scheduleId: schedule.id, runId: expect.any(String), scheduledAt: schedule.nextRunAt,
          output: 'legacy', timeZone: schedule.timeZone, readOnlyServers: [],
          previousSpaceId: undefined, lastSuccessfulAt: undefined,
        },
      });
      expect(getSkillSchedule(workspace, skill.id)?.lastRun?.status).toBe('running');
      vi.mocked(getAgentSession).mockResolvedValue({ status: 'completed', summary: 'Report published' } as NonNullable<Awaited<ReturnType<typeof getAgentSession>>>);
      await checkAndRunDueSkills();
      expect(getSkillSchedule(workspace, skill.id)?.lastSuccessfulRun).toMatchObject({ status: 'ready', summary: 'Report published' });
    });

    it.each(['running', 'waiting-approval'] as const)('stops an unfinished %s agent on timeout before launching again', async status => {
      const schedule = saveSkillSchedule(workspace, skill.id, 'daily', '09:00', null, options);
      vi.setSystemTime(new Date(schedule.nextRunAt!));
      const run = claimScheduledRun(workspace, schedule.id)!;
      recordScheduledRunLaunch(workspace, schedule.id, run.id, { spaceId: 's', agentId: 'agent' });
      vi.mocked(getAgentSession).mockResolvedValue({ status } as NonNullable<Awaited<ReturnType<typeof getAgentSession>>>);
      vi.mocked(getAgentSessionId).mockReturnValue('session');
      await checkAndRunDueSkills(true);
      expect(getSkillSchedule(workspace, skill.id)?.lastRun?.status).toBe('running');
      expect(abortAgent).not.toHaveBeenCalled();
      let finishAbort!: () => void;
      vi.mocked(abortAgent).mockImplementationOnce(() => new Promise(resolve => {
        finishAbort = () => {
          vi.mocked(getAgentSession).mockResolvedValue({ status: 'failed' } as NonNullable<Awaited<ReturnType<typeof getAgentSession>>>);
          resolve();
        };
      }));
      vi.advanceTimersByTime(25 * 60 * 60_000);
      const tick = checkAndRunDueSkills();
      await vi.advanceTimersByTimeAsync(0);
      expect(abortAgent).toHaveBeenCalledExactlyOnceWith('agent');
      expect(getSkillSchedule(workspace, skill.id)?.lastRun?.status).toBe('running');
      expect(invokeSkill).not.toHaveBeenCalled();
      finishAbort();
      await tick;
      expect(getSkillSchedule(workspace, skill.id)?.lastRun?.status).toBe('failed');
      expect(invokeSkill).not.toHaveBeenCalled();
    });

    it('keeps a live run claimed when timeout cancellation fails', async () => {
      const schedule = saveSkillSchedule(workspace, skill.id, 'daily', '09:00', null, options);
      vi.setSystemTime(new Date(schedule.nextRunAt!));
      const run = claimScheduledRun(workspace, schedule.id)!;
      recordScheduledRunLaunch(workspace, schedule.id, run.id, { spaceId: 's', agentId: 'agent' });
      vi.mocked(getAgentSession).mockResolvedValue({ status: 'running' } as NonNullable<Awaited<ReturnType<typeof getAgentSession>>>);
      vi.mocked(getAgentSessionId).mockReturnValue('session');
      vi.mocked(abortAgent).mockRejectedValue(new Error('Could not stop cloud agent'));
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.advanceTimersByTime(25 * 60 * 60_000);
      await checkAndRunDueSkills();
      await checkAndRunDueSkills();
      expect(getSkillSchedule(workspace, skill.id)?.lastRun).toMatchObject({ status: 'running', attempt: 1 });
      expect(invokeSkill).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalled();
      errors.mockRestore();
    });

    it('preserves completion that arrives before launch returns', async () => {
      const schedule = saveSkillSchedule(workspace, skill.id, 'daily', '09:00', null, options);
      vi.setSystemTime(new Date(schedule.nextRunAt!));
      vi.mocked(invokeSkill).mockImplementation(async input => {
        const run = input.scheduledRun!;
        completeScheduledRun(workspace, run.scheduleId, run.runId, { status: 'empty', summary: 'All caught up' });
        return { space: { id: 's' }, agent: { agentId: 'a', sessionId: 'session' }, canvasContent: '' } as SkillInvocationResult;
      });
      await checkAndRunDueSkills();
      expect(getSkillSchedule(workspace, skill.id)?.lastRun).toMatchObject({ status: 'empty', agentId: 'a', spaceId: 's' });
    });

    it('does not launch a claim cleared while its async projection is being saved', async () => {
      const schedule = saveSkillSchedule(workspace, skill.id, 'daily', '09:00', null, options);
      vi.setSystemTime(new Date(schedule.nextRunAt!));
      vi.mocked(updateSkillSchedule)
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(async () => { clearSkillSchedule(workspace, skill.id); });
      await checkAndRunDueSkills();
      expect(invokeSkill).not.toHaveBeenCalled();
      expect(getSkillSchedule(workspace, skill.id)).toMatchObject({
        enabled: false, lastRun: { status: 'failed', summary: 'Schedule stopped before the run could launch.' },
      });
    });

    it('bounds repeated launch failures and stops the local ticker cleanly', async () => {
      const schedule = saveSkillSchedule(workspace, skill.id, 'daily', '09:00', null, options);
      vi.mocked(invokeSkill).mockResolvedValue({ error: 'launch_failed' });
      vi.setSystemTime(new Date(schedule.nextRunAt!));
      (await startScheduler());
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      stopScheduler();
      expect(invokeSkill).toHaveBeenCalledTimes(3);
      expect(listScheduledRuns(workspace, schedule.id)).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps a timed-out unacknowledged launch claimed until its late agent is stopped', async () => {
      const schedule = saveSkillSchedule(workspace, skill.id, 'daily', '09:00', null, options);
      let finish!: (result: SkillInvocationResult) => void;
      vi.mocked(invokeSkill).mockReturnValue(new Promise(resolve => { finish = resolve; }));
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.setSystemTime(new Date(schedule.nextRunAt!));
      const firstTick = checkAndRunDueSkills();
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      await firstTick;
      expect(getSkillSchedule(workspace, skill.id)?.lastRun?.status).toBe('running');
      expect(abortAgent).not.toHaveBeenCalled();
      vi.advanceTimersByTime(24 * 60 * 60_000);
      await checkAndRunDueSkills();
      expect(invokeSkill).toHaveBeenCalledTimes(1);
      finish({ space: { id: 'late-space' }, agent: { agentId: 'late-agent', sessionId: 'session' }, canvasContent: '' } as SkillInvocationResult);
      await vi.advanceTimersByTimeAsync(0);
      expect(abortAgent).toHaveBeenCalledExactlyOnceWith('late-agent');
      expect(getSkillSchedule(workspace, skill.id)?.lastRun).toMatchObject({ status: 'failed', agentId: 'late-agent' });
      errors.mockRestore();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('daily', () => {
    it('schedules for later today if time has not yet passed', () => {
      // Monday 2024-01-15 at 08:00 local
      vi.setSystemTime(new Date(2024, 0, 15, 8, 0, 0));
      const next = new Date(computeNextRunAt('daily', '17:00', null));
      expect(next.getFullYear()).toBe(2024);
      expect(next.getMonth()).toBe(0);
      expect(next.getDate()).toBe(15);
      expect(next.getHours()).toBe(17);
    });

    it('schedules for tomorrow if time has already passed today', () => {
      // Monday 2024-01-15 at 18:00 local
      vi.setSystemTime(new Date(2024, 0, 15, 18, 0, 0));
      const next = new Date(computeNextRunAt('daily', '09:00', null));
      expect(next.getDate()).toBe(16);
      expect(next.getHours()).toBe(9);
    });
  });

  describe('weekdays', () => {
    it('skips Saturday to Monday', () => {
      // Friday 2024-01-12 at 18:00 → next weekday is Monday Jan 15
      vi.setSystemTime(new Date(2024, 0, 12, 18, 0, 0));
      const next = new Date(computeNextRunAt('weekdays', '09:00', null));
      expect(next.getDay()).toBe(1); // Monday
      expect(next.getDate()).toBe(15);
    });

    it('runs the same day if before time on a weekday', () => {
      // Wednesday 2024-01-17 at 08:00
      vi.setSystemTime(new Date(2024, 0, 17, 8, 0, 0));
      const next = new Date(computeNextRunAt('weekdays', '09:00', null));
      expect(next.getDate()).toBe(17);
      expect(next.getHours()).toBe(9);
    });
  });

  describe('weekly', () => {
    it('lands on the requested day of week', () => {
      // Wednesday 2024-01-17 at 10:00, schedule for Tuesday (day=2)
      vi.setSystemTime(new Date(2024, 0, 17, 10, 0, 0));
      const next = new Date(computeNextRunAt('weekly', '09:00', 2));
      expect(next.getDay()).toBe(2); // Tuesday
      // Next Tuesday is Jan 23
      expect(next.getDate()).toBe(23);
    });

    it('defaults to Monday when day is null', () => {
      // Wednesday 2024-01-17
      vi.setSystemTime(new Date(2024, 0, 17, 10, 0, 0));
      const next = new Date(computeNextRunAt('weekly', '09:00', null));
      expect(next.getDay()).toBe(1); // Monday
    });
  });

  describe('biweekly', () => {
    it('produces a date at least 7 days in the future', () => {
      // Monday 2024-01-15 at 10:00, schedule for Tuesday (day=2)
      vi.setSystemTime(new Date(2024, 0, 15, 10, 0, 0));
      const next = new Date(computeNextRunAt('biweekly', '09:00', 2));
      const diffMs = next.getTime() - Date.now();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThanOrEqual(7);
      expect(next.getDay()).toBe(2); // Tuesday
    });
  });

  describe('monthly', () => {
    it('schedules for next month if time has passed today', () => {
      // Jan 15 at 18:00 → Feb 15 at 09:00
      vi.setSystemTime(new Date(2024, 0, 15, 18, 0, 0));
      const next = new Date(computeNextRunAt('monthly', '09:00', null));
      expect(next.getMonth()).toBe(1); // Feb
      expect(next.getDate()).toBe(15);
    });

    it('clamps to last day of month when target day overshoots (Jan 31 → Feb 29 in leap year)', () => {
      // Jan 31 2024 (leap year) at 18:00 → should be Feb 29 (not Mar 2)
      vi.setSystemTime(new Date(2024, 0, 31, 18, 0, 0));
      const next = new Date(computeNextRunAt('monthly', '09:00', null));
      expect(next.getMonth()).toBe(1); // Feb (not Mar!)
      expect(next.getDate()).toBe(29); // last day of Feb in 2024
      expect(next.getHours()).toBe(9);
    });

    it('clamps to last day of month when target day overshoots (Jan 31 → Feb 28 in non-leap year)', () => {
      // Jan 31 2023 at 18:00 → should be Feb 28
      vi.setSystemTime(new Date(2023, 0, 31, 18, 0, 0));
      const next = new Date(computeNextRunAt('monthly', '09:00', null));
      expect(next.getMonth()).toBe(1); // Feb
      expect(next.getDate()).toBe(28);
    });
  });

  describe('return value', () => {
    it('returns a valid ISO 8601 UTC string', () => {
      vi.setSystemTime(new Date(2024, 0, 15, 8, 0, 0));
      const result = computeNextRunAt('daily', '09:00', null);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // Should be parseable back to a Date
      expect(new Date(result).toString()).not.toBe('Invalid Date');
    });
  });
});
