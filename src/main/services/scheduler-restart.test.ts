import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSession, Skill, SkillInvocationResult } from '../../shared/types';

const state = vi.hoisted(() => ({
  workspace: '',
  sessions: new Map<string, AgentSession>(),
}));
const skill = { id: 'weekly-digest', name: 'Weekly digest', schedule: null } as Skill;

vi.mock('../storage', async () => ({
  ...await import('./skill-schedule-store'),
  isInitialized: () => true,
  getStorageGeneration: () => 0,
  withWorkspaceContext: (run: () => unknown) => run(),
  withStorageGeneration: (_generation: number, run: () => unknown) => run(),
  listSkills: async () => [skill],
  getSkill: async () => skill,
  updateSkillSchedule: vi.fn(),
  markSkillRun: vi.fn(),
  getAgentSession: async (id: string) => state.sessions.get(id) ?? null,
  listAgentSessions: async () => [...state.sessions.values()],
  updateAgentSessionStatus: async (id: string, status: AgentSession['status'], summary: string) => {
    const row = state.sessions.get(id);
    if (!row) throw new Error(`Missing agent session: ${id}`);
    state.sessions.set(id, { ...row, status, summary, updated_at: new Date().toISOString() });
  },
  listAllRunningAgents: async () => [],
}));
vi.mock('../config', () => ({ getConfigValue: () => state.workspace }));
vi.mock('../notify', () => ({ notifyAllWindows: vi.fn() }));
vi.mock('../skill-invocation', () => ({ invokeSkill: vi.fn() }));
vi.mock('../agents/sdk-runner', () => ({
  initSdkRunner: vi.fn(),
  setupAgentEventListeners: vi.fn(),
  finishScheduledAgent: vi.fn(),
  resumeAgentSession: vi.fn(),
}));
vi.mock('../agents/cli-runner', () => ({ initCliRunner: vi.fn() }));
vi.mock('../agents/comment-workflow', () => ({ initCommentWorkflow: vi.fn() }));
vi.mock('../agents/agent-notifier', () => ({ AgentNotifier: class {} }));
vi.mock('../agents/interaction-broker', () => ({ InteractionBroker: class {} }));

import { reconcileStaleAgents } from '../agent-service';
import { invokeSkill } from '../skill-invocation';
import { checkAndRunDueSkills, stopScheduler } from './scheduler';
import {
  getSkillSchedule, listScheduledRuns, MAX_SCHEDULE_ATTEMPTS, migrateLegacySkillSchedule, saveSkillSchedule,
} from './skill-schedule-store';

const options = { timeZone: 'UTC', intent: 'Read the weekly changes', readOnlyServers: ['github'] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-01-01T08:00:00Z'));
  state.workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-scheduler-restart-'));
  state.sessions.clear();
  vi.mocked(invokeSkill).mockReset().mockImplementation(async () => {
    const id = `agent-${state.sessions.size + 1}`;
    const now = new Date().toISOString();
    const row: AgentSession = {
      id, session_id: `${id}-session`, space_id: `${id}-space`,
      prompt: 'Read the weekly changes', status: 'running', summary: 'Working...',
      working_dir: state.workspace, source: 'sdk', persona_handle: null, quoted_text: null,
      run_location: 'local', created_at: now, updated_at: now,
    };
    state.sessions.set(id, row);
    return {
      space: { id: row.space_id }, agent: { agentId: id, sessionId: row.session_id }, canvasContent: '',
    } as SkillInvocationResult;
  });
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
  fs.rmSync(state.workspace, { recursive: true, force: true });
});

describe('acknowledged scheduled sessions across app restart', () => {
  it.each(['agents-first', 'scheduler-first'] as const)(
    'retries the same weekly occurrence with bounded backoff when recovery runs %s',
    async order => {
      const schedule = saveSkillSchedule(state.workspace, skill.id, 'weekly', '09:00', 1, options);
      vi.setSystemTime(new Date(schedule.nextRunAt!));
      await checkAndRunDueSkills();

      for (let attempt = 1; attempt <= MAX_SCHEDULE_ATTEMPTS; attempt++) {
        const running = getSkillSchedule(state.workspace, skill.id)!.lastRun!;
        expect(running).toMatchObject({
          status: 'running', attempt, scheduledAt: schedule.nextRunAt,
          agentId: `agent-${attempt}`, spaceId: `agent-${attempt}-space`,
        });
        expect(state.sessions.get(running.agentId!)?.status).toBe('running');
        vi.advanceTimersByTime(5 * 60_000);
        if (order === 'agents-first') {
          await reconcileStaleAgents();
          expect(state.sessions.get(running.agentId!)?.status).toBe('failed');
        }
        await checkAndRunDueSkills(true);
        if (order === 'scheduler-first') await reconcileStaleAgents();

        const failed = getSkillSchedule(state.workspace, skill.id)!;
        expect(failed.nextRunAt).toBe('2024-01-08T09:00:00.000Z');
        expect(failed.lastRun).toMatchObject({ id: running.id, status: 'failed', attempt });
        if (attempt === MAX_SCHEDULE_ATTEMPTS) {
          expect(failed.lastRun?.retryAt).toBeUndefined();
          break;
        }
        expect(failed.lastRun?.retryAt).toBe(new Date(Date.now() + attempt * 60_000).toISOString());
        vi.advanceTimersByTime(attempt * 60_000 - 1);
        await checkAndRunDueSkills();
        expect(invokeSkill).toHaveBeenCalledTimes(attempt);
        vi.advanceTimersByTime(1);
        await checkAndRunDueSkills();
      }

      vi.advanceTimersByTime(10 * 60_000);
      await checkAndRunDueSkills();
      expect(invokeSkill).toHaveBeenCalledTimes(MAX_SCHEDULE_ATTEMPTS);
      expect(listScheduledRuns(state.workspace, schedule.id)).toHaveLength(MAX_SCHEDULE_ATTEMPTS);
    },
  );

  it('recovers an already-reconciled interruption even outside the startup tick', async () => {
    const schedule = saveSkillSchedule(state.workspace, skill.id, 'weekly', '09:00', 1, options);
    vi.setSystemTime(new Date(schedule.nextRunAt!));
    await checkAndRunDueSkills();
    vi.advanceTimersByTime(5 * 60_000);
    await reconcileStaleAgents();
    await checkAndRunDueSkills();
    expect(getSkillSchedule(state.workspace, skill.id)?.lastRun?.retryAt)
      .toBe(new Date(Date.now() + 60_000).toISOString());
  });

  it('does not retry a genuine terminal failure', async () => {
    const schedule = saveSkillSchedule(state.workspace, skill.id, 'weekly', '09:00', 1, options);
    vi.setSystemTime(new Date(schedule.nextRunAt!));
    await checkAndRunDueSkills();
    const row = state.sessions.get('agent-1')!;
    state.sessions.set(row.id, { ...row, status: 'failed', summary: 'The runtime reported a permanent failure.' });
    vi.advanceTimersByTime(5 * 60_000);
    await reconcileStaleAgents();
    await checkAndRunDueSkills(true);
    expect(getSkillSchedule(state.workspace, skill.id)?.lastRun).toMatchObject({
      status: 'failed', summary: 'The runtime reported a permanent failure.',
    });
    expect(getSkillSchedule(state.workspace, skill.id)?.lastRun?.retryAt).toBeUndefined();
  });

  it('keeps a surviving cloud execution claimed instead of overlapping it with a retry', async () => {
    const schedule = saveSkillSchedule(state.workspace, skill.id, 'weekly', '09:00', 1, options);
    vi.setSystemTime(new Date(schedule.nextRunAt!));
    await checkAndRunDueSkills();
    const row = state.sessions.get('agent-1')!;
    state.sessions.set(row.id, { ...row, run_location: 'cloud', status: 'waiting-approval' });
    vi.advanceTimersByTime(5 * 60_000);
    await reconcileStaleAgents();
    await checkAndRunDueSkills(true);
    expect(state.sessions.get(row.id)?.status).toBe('waiting-approval');
    expect(getSkillSchedule(state.workspace, skill.id)?.lastRun).toMatchObject({
      status: 'running', agentId: row.id, attempt: 1,
    });
    expect(invokeSkill).toHaveBeenCalledTimes(1);
  });

  it('does not let restart recovery bypass the run timeout', async () => {
    const schedule = saveSkillSchedule(state.workspace, skill.id, 'weekly', '09:00', 1, options);
    vi.setSystemTime(new Date(schedule.nextRunAt!));
    await checkAndRunDueSkills();
    vi.advanceTimersByTime(2 * 60 * 60_000);
    await reconcileStaleAgents();
    await checkAndRunDueSkills(true);
    expect(getSkillSchedule(state.workspace, skill.id)?.lastRun).toMatchObject({
      status: 'failed', summary: 'Scheduled run timed out; it will not be retried automatically.',
    });
    expect(getSkillSchedule(state.workspace, skill.id)?.lastRun?.retryAt).toBeUndefined();
  });

  it('never retries an interrupted legacy run with possible external effects', async () => {
    const schedule = migrateLegacySkillSchedule(state.workspace, {
      ...skill, schedule: 'weekly', schedule_time: '09:00', schedule_day: 1,
      next_run_at: '2024-01-01T09:00:00.000Z',
    })!;
    vi.setSystemTime(new Date(schedule.nextRunAt!));
    await checkAndRunDueSkills();
    vi.advanceTimersByTime(5 * 60_000);
    await reconcileStaleAgents();
    await checkAndRunDueSkills(true);
    expect(getSkillSchedule(state.workspace, skill.id)?.lastRun).toMatchObject({ status: 'failed', attempt: 1 });
    expect(getSkillSchedule(state.workspace, skill.id)?.lastRun?.retryAt).toBeUndefined();
    expect(invokeSkill).toHaveBeenCalledTimes(1);
  });
});
