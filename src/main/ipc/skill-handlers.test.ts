import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Skill, SkillInvocationResult } from '../../shared/types';
import type { ScheduledRun } from '../../shared/skill-schedule';
import {
  claimScheduledRun, completeScheduledRun, getSkillSchedule,
  listScheduledRuns as readScheduledRuns,
} from '../services/skill-schedule-store';
import { listScheduledRuns } from '../storage';
import { notifyAllWindows } from '../notify';
import { invokeSkill } from '../skill-invocation';
import { registerSkillHandlers } from './skill-handlers';

let workspace = '';
let skill: Skill;
let servers: Record<string, { command: string; env: Record<string, string> }> = {};
const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('./registry', () => ({
  registerIpcHandler: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
}));
vi.mock('electron', () => ({ shell: { openPath: vi.fn() } }));
vi.mock('../config', () => ({ getConfigValue: () => workspace }));
vi.mock('../notify', () => ({ notifyAllWindows: vi.fn() }));
vi.mock('../mcp', () => ({ getAllMcpServers: () => servers }));
vi.mock('../skill-watcher', () => ({ getSkillsDir: (root: string) => path.join(root, '.agents', 'skills') }));
vi.mock('../emoji-picker', () => ({ pickEmoji: () => '' }));
vi.mock('../skill-invocation', () => ({ invokeSkill: vi.fn() }));
vi.mock('../canvas/sdk-canvas-provider', () => ({ WHIM_REPORT_CANVAS_ID: 'whim.report' }));
vi.mock('../canvas/skill-canvas-template', () => ({ loadSkillCanvasDefinition: () => null }));
vi.mock('../storage', async () => ({
  ...(await import('../storage-skills')),
  readDocument: (await import('../storage-documents')).readDocument,
  writeDocument: (await import('../storage-documents')).writeDocument,
  ...(await import('../workspace')),
  ...(await import('../services/skill-schedule-store')),
  ...(await import('../canvas/artifact-store')),
  documentMatches: (await import('../storage-documents')).documentMatches,
  getStorageGeneration: () => 0,
  withWorkspaceContext: (run: () => unknown) => run(),
  withStorageGeneration: (_generation: number, run: () => unknown) => run(),

  ...await import('../services/skill-schedule-store'),
  listScheduledRuns: vi.fn(),
  isInitialized: () => true,
  listSkills: () => [skill],
  getSkill: (id: string) => id === skill.id ? skill : null,
  upsertSkill: vi.fn(),
  removeSkill: vi.fn(),
  markSkillRun: vi.fn(),
  getAgentSession: vi.fn(),
  updateSkillSchedule: (_id: string, frequency: Skill['schedule'], time: string | null, day: number | null, next: string | null) => {
    Object.assign(skill, { schedule: frequency, schedule_time: time, schedule_day: day, next_run_at: next });
  },
}));

async function call(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler({}, ...args);
}

const options = { timeZone: 'America/New_York', intent: 'Find follow-ups', readOnlyServers: ['github'] };
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-schedule-ipc-'));
  const folder = '.agents/skills/triage';
  fs.mkdirSync(path.join(workspace, folder), { recursive: true });
  const filePath = path.join(workspace, folder, 'SKILL.md');
  fs.writeFileSync(filePath, '---\nname: Triage\ncanvas: true\nspace_mode: reuse\n---\nReusable skill instructions.\n');
  skill = {
    id: 'triage', name: 'Triage', description: '', emoji: '', folder, filePath,
    schedule: null, schedule_time: null, schedule_day: null, next_run_at: null, last_run_at: null,
    created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
  };
  servers = { github: { command: 'secret executable', env: { TOKEN: 'never disclose' } } };
  handlers.clear();
  vi.clearAllMocks();
  vi.mocked(listScheduledRuns).mockReset().mockImplementation(async (...args) => readScheduledRuns(...args));
  registerSkillHandlers();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('skill schedule IPC', () => {
  it('returns launch errors instead of a partially created space', async () => {
    vi.mocked(invokeSkill).mockResolvedValueOnce({
      space: { id: 'partial-space' }, canvasContent: 'Launch failed', error: 'Connection unavailable',
    } as SkillInvocationResult);
    expect(await call('skill:launch', skill.id)).toEqual({ error: 'Connection unavailable' });
  });

  it('preserves successful launch spaces and errors without a space', async () => {
    const success = { space: { id: 'ready-space' }, canvasContent: '' } as SkillInvocationResult;
    vi.mocked(invokeSkill).mockResolvedValueOnce(success);
    expect(await call('skill:launch', skill.id)).toEqual(success.space);
    vi.mocked(invokeSkill).mockResolvedValueOnce({ error: 'not_found' });
    expect(await call('skill:launch', skill.id)).toEqual({ error: 'not_found' });
  });

  it('exposes only exact durable canvas runs, including after clearing, without inferring manual spaces', async () => {
    vi.useFakeTimers();
    await call('skill:set-schedule', skill.id, 'daily', '09:00', null, options);
    const schedule = getSkillSchedule(workspace, skill.id)!;
    vi.setSystemTime(new Date(schedule.nextRunAt!));
    const run = claimScheduledRun(workspace, schedule.id)!;
    completeScheduledRun(workspace, schedule.id, run.id, { status: 'ready', summary: 'Found follow-ups', spaceId: 'scheduled-space' });
    await call('skill:invoke', { skillId: skill.id, run: true, source: 'api' });
    expect(await call('skill:list')).toMatchObject([{
      schedule_runs: [{ id: run.id, scheduledAt: run.scheduledAt, spaceId: 'scheduled-space' }],
    }]);
    await call('skill:clear-schedule', skill.id);
    const listed = await call('skill:list') as Skill[];
    expect(listed[0].schedule_runs).toHaveLength(1);
    expect(listed[0].schedule_runs?.[0].id).toBe(run.id);
  });

  it('bounds exposed ledger history to the latest 100 exact runs', async () => {
    await call('skill:set-schedule', skill.id, 'daily', '09:00', null, options);
    const runs: ScheduledRun[] = Array.from({ length: 105 }, (_, index) => ({
      id: `run-${index}`, scheduledAt: new Date(index * 86_400_000).toISOString(),
      startedAt: new Date(index * 86_400_000).toISOString(), status: 'ready', attempt: 1,
      spaceId: `space-${index}`,
    }));
    vi.mocked(listScheduledRuns).mockResolvedValueOnce(runs);
    const listed = await call('skill:list') as Skill[];
    expect(listed[0].schedule_runs).toEqual(runs.slice(5));
  });

  it('does not attach canvas grouping metadata to legacy schedules', async () => {
    skill.schedule = 'daily';
    skill.schedule_time = '09:00';
    const listed = await call('skill:list') as Skill[];
    expect(listed[0].schedule_details?.output).toBe('legacy');
    expect(listed[0]).not.toHaveProperty('schedule_runs');
    expect(listScheduledRuns).not.toHaveBeenCalled();
  });

  it('whitelists public invocation fields and strips injected schedule authority', async () => {
    await call('skill:invoke', {
      skillId: skill.id, intent: 'Review changes', run: true, preferredAgent: null, source: 'api',
      scheduledRun: { scheduleId: 'forged', runId: 'forged', readOnlyServers: ['*'], output: 'legacy' },
      readOnlyServers: ['*'], authorizedSources: ['*'], manual: false,
    });
    expect(invokeSkill).toHaveBeenCalledExactlyOnceWith({
      skillId: skill.id, intent: 'Review changes', run: true, preferredAgent: null, source: 'api',
    });
  });

  it('rejects forged schedule provenance instead of bypassing saved manual preview policy', async () => {
    expect(await call('skill:invoke', { skillId: skill.id, run: true, source: 'schedule' }))
      .toEqual({ error: 'invalid_source' });
    expect(invokeSkill).not.toHaveBeenCalled();
  });

  it.each([null, {}, { skillId: 'triage', run: 'true' }, { skillId: 'triage', intent: {} }])(
    'rejects malformed public invocation input', async input => {
      expect(await call('skill:invoke', input)).toEqual({ error: 'invalid_invocation' });
      expect(invokeSkill).not.toHaveBeenCalled();
    },
  );

  it('sets and clears separate durable state without mutating SKILL.md', async () => {
    const before = fs.readFileSync(skill.filePath, 'utf8');
    expect(await call('skill:set-schedule', skill.id, 'daily', '09:00', null, options)).toMatchObject({
      schedule: 'daily', schedule_time: '09:00',
      schedule_details: { output: 'canvas', enabled: true, ...options },
    });
    expect(fs.readFileSync(skill.filePath, 'utf8')).toBe(before);
    expect(skill.next_run_at).toBe(getSkillSchedule(workspace, skill.id)?.nextRunAt);
    expect(await call('skill:clear-schedule', skill.id)).toEqual({ success: true });
    expect(fs.readFileSync(skill.filePath, 'utf8')).toBe(before);
    expect(getSkillSchedule(workspace, skill.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(notifyAllWindows).toHaveBeenCalledWith('skills:changed');
  });

  it('defaults new no-options calls to local time with empty intent and sources', async () => {
    await call('skill:set-schedule', skill.id, 'daily', '09:00', null);
    expect(getSkillSchedule(workspace, skill.id)).toMatchObject({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, intent: '', readOnlyServers: [], output: 'canvas',
    });
  });

  it('preserves legacy report/reuse and tombstones override watcher frontmatter projections', async () => {
    fs.writeFileSync(skill.filePath, '---\nname: Triage\nschedule: daily\nschedule_time: 09:00\ncanvas: true\nspace_mode: reuse\n---\nOriginal.\n');
    const before = fs.readFileSync(skill.filePath, 'utf8');
    skill.schedule = 'daily';
    skill.schedule_time = '09:00';
    expect(await call('skill:set-schedule', skill.id, 'weekly', '10:00', 2)).toMatchObject({
      canvas: 'whim.report', space_mode: 'reuse', schedule_details: { output: 'legacy' },
    });
    await call('skill:clear-schedule', skill.id);
    // A watcher sync still sees old frontmatter, but durable state wins.
    skill.schedule = 'daily';
    skill.schedule_time = '09:00';
    expect(await call('skill:list')).toMatchObject([{ schedule: null, next_run_at: null, schedule_details: { enabled: false } }]);
    expect(skill.schedule).toBeNull();
    expect(fs.readFileSync(skill.filePath, 'utf8')).toBe(before);
  });

  it('only returns configured source names, never configuration or credentials', async () => {
    expect(await call('skill:schedule-sources')).toEqual([{ name: 'github' }]);
    expect(JSON.stringify(await call('skill:schedule-sources'))).not.toContain('TOKEN');
  });

  it('requires explicit migration for enabled legacy schedules and preserves reusable skill settings', async () => {
    skill.schedule = 'daily';
    skill.schedule_time = '09:00';
    const before = fs.readFileSync(skill.filePath, 'utf8');
    expect(await call('skill:set-schedule', skill.id, 'daily', '10:00', null, options))
      .toMatchObject({ schedule_details: { output: 'legacy' } });
    expect(await call('skill:set-schedule', skill.id, 'daily', '10:00', null, { ...options, migrateToCanvas: true }))
      .toMatchObject({ canvas: 'whim.report', space_mode: 'reuse', schedule_details: { output: 'canvas' } });
    expect(getSkillSchedule(workspace, skill.id)).not.toHaveProperty('migrateToCanvas');
    expect(fs.readFileSync(skill.filePath, 'utf8')).toBe(before);
  });

  it('recreates a cleared legacy schedule as canvas with fresh defaults and source consent', async () => {
    skill.schedule = 'daily';
    skill.schedule_time = '09:00';
    const before = fs.readFileSync(skill.filePath, 'utf8');
    await call('skill:set-schedule', skill.id, 'daily', '09:00', null, options);
    await call('skill:clear-schedule', skill.id);
    servers = {};
    expect(await call('skill:set-schedule', skill.id, 'daily', '10:00', null, options))
      .toEqual({ error: 'invalid_read_only_servers' });
    expect(await call('skill:set-schedule', skill.id, 'daily', '10:00', null))
      .toMatchObject({ schedule_details: {
        output: 'canvas', intent: '', readOnlyServers: [], timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      } });
    expect(fs.readFileSync(skill.filePath, 'utf8')).toBe(before);
  });

  it.each(['*', 'github*', 'GitHub', 'unknown'])('rejects unauthorized source %s', async name => {
    expect(await call('skill:set-schedule', skill.id, 'daily', '09:00', null, { ...options, readOnlyServers: [name] })).toMatchObject({
      error: expect.any(String),
    });
    expect(getSkillSchedule(workspace, skill.id)).toBeNull();
  });

  it('allows retained disconnected sources and preserves options for old timing-only calls', async () => {
    await call('skill:set-schedule', skill.id, 'daily', '09:00', null, options);
    servers = {};
    expect(await call('skill:set-schedule', skill.id, 'daily', '10:00', null, options)).toMatchObject({ schedule: 'daily' });
    await call('skill:set-schedule', skill.id, 'daily', '11:00', null);
    expect(getSkillSchedule(workspace, skill.id)).toMatchObject(options);
  });

  it('rejects bad time zones without changing durable state', async () => {
    expect(await call('skill:set-schedule', skill.id, 'daily', '09:00', null, { ...options, timeZone: 'Not/AZone' }))
      .toEqual({ error: 'invalid_time_zone' });
    expect(getSkillSchedule(workspace, skill.id)).toBeNull();
  });

  it('keeps a disabled tombstone when deleting a scheduled skill', async () => {
    await call('skill:set-schedule', skill.id, 'daily', '09:00', null, options);
    expect(await call('skill:delete', skill.id)).toBe(true);
    expect(getSkillSchedule(workspace, skill.id)?.enabled).toBe(false);
    expect(fs.existsSync(skill.filePath)).toBe(false);
  });

  it('surfaces corrupt durable state on list and edit instead of overwriting it', async () => {
    await call('skill:set-schedule', skill.id, 'daily', '09:00', null, options);
    fs.writeFileSync(path.join(workspace, '.whim', 'skill-schedules.json'), '{bad');
    await expect(call('skill:list')).rejects.toThrow();
    await expect(call('skill:set-schedule', skill.id, 'daily', '10:00', null, options)).rejects.toThrow();
  });
});
