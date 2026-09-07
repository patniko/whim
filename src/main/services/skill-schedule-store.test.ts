import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Skill } from '../../shared/types';
import {
  claimScheduledRun, clearSkillSchedule, completeScheduledRun, computeNextRunAt, failScheduledRun,
  getSkillSchedule, listScheduledRuns, listSkillSchedules, migrateLegacySkillSchedule,
  recordScheduledRunLaunch, saveSkillSchedule,
} from './skill-schedule-store';

vi.mock('../notify', () => ({ notifyAllWindows: vi.fn() }));
vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>() }));
let workspace: string;
const options = { timeZone: 'America/New_York', intent: 'Find follow-ups', readOnlyServers: ['github'] };
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-schedules-'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-01-31T18:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('durable skill schedules', () => {
  it('persists independent schedules and occurrence history across module reloads', async () => {
    const schedule = saveSkillSchedule(workspace, 'triage', 'daily', '09:00', null, options);
    expect(schedule.output).toBe('canvas');
    vi.setSystemTime(new Date(schedule.nextRunAt!));
    const run = claimScheduledRun(workspace, schedule.id)!;
    completeScheduledRun(workspace, schedule.id, run.id, { status: 'ready', summary: 'Two issues', spaceId: 'space' });
    vi.resetModules();
    const reloaded = await import('./skill-schedule-store');
    expect(reloaded.getSkillSchedule(workspace, 'triage')?.lastSuccessfulRun?.id).toBe(run.id);
    expect(reloaded.listScheduledRuns(workspace, schedule.id)).toHaveLength(1);
    expect(reloaded.claimScheduledRun(workspace, schedule.id)).toBeNull();
  });

  it('catches up one overdue occurrence and skips the backlog', () => {
    const schedule = saveSkillSchedule(workspace, 'triage', 'daily', '09:00', null, options);
    vi.setSystemTime(new Date('2024-03-10T18:00:00Z'));
    const run = claimScheduledRun(workspace, schedule.id)!;
    expect(run.scheduledAt).toBe(schedule.nextRunAt);
    expect(getSkillSchedule(workspace, 'triage')?.nextRunAt).toBe('2024-03-11T13:00:00.000Z');
    expect(claimScheduledRun(workspace, schedule.id)).toBeNull();
    completeScheduledRun(workspace, schedule.id, run.id, { status: 'empty', summary: 'Nothing new' });
    expect(claimScheduledRun(workspace, schedule.id)).toBeNull();
  });

  it('keeps last success separate and does not overwrite early completion at launch return', () => {
    const schedule = saveSkillSchedule(workspace, 'triage', 'daily', '09:00', null, options);
    vi.setSystemTime(new Date(schedule.nextRunAt!));
    const run = claimScheduledRun(workspace, schedule.id)!;
    completeScheduledRun(workspace, schedule.id, run.id, { status: 'ready', summary: 'Done' });
    recordScheduledRunLaunch(workspace, schedule.id, run.id, { spaceId: 's', agentId: 'a' });
    expect(getSkillSchedule(workspace, 'triage')?.lastRun).toMatchObject({ status: 'ready', spaceId: 's', agentId: 'a' });
    vi.setSystemTime(new Date(getSkillSchedule(workspace, 'triage')!.nextRunAt!));
    const second = claimScheduledRun(workspace, schedule.id)!;
    completeScheduledRun(workspace, schedule.id, second.id, { status: 'failed', summary: 'Connection failed' });
    expect(getSkillSchedule(workspace, 'triage')?.lastSuccessfulRun?.id).toBe(run.id);
    expect(getSkillSchedule(workspace, 'triage')?.lastRun?.id).toBe(second.id);
  });

  it('bounds launch retries to three attempts at the same occurrence', () => {
    const schedule = saveSkillSchedule(workspace, 'triage', 'daily', '09:00', null, options);
    vi.setSystemTime(new Date(schedule.nextRunAt!));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const run = claimScheduledRun(workspace, schedule.id)!;
      expect(run.attempt).toBe(attempt);
      expect(run.scheduledAt).toBe(schedule.nextRunAt);
      failScheduledRun(workspace, schedule.id, run.id, 'Could not launch', true);
      expect(claimScheduledRun(workspace, schedule.id)).toBeNull();
      vi.advanceTimersByTime(attempt * 60_000);
    }
    expect(claimScheduledRun(workspace, schedule.id)).toBeNull();
    expect(listScheduledRuns(workspace, schedule.id)).toHaveLength(3);
  });

  it('does not retry completed execution failures', () => {
    const schedule = saveSkillSchedule(workspace, 'triage', 'daily', '09:00', null, options);
    vi.setSystemTime(new Date(schedule.nextRunAt!));
    const run = claimScheduledRun(workspace, schedule.id)!;
    completeScheduledRun(workspace, schedule.id, run.id, { status: 'failed', summary: 'Execution failed' });
    failScheduledRun(workspace, schedule.id, run.id, 'Late launch failure', true);
    vi.advanceTimersByTime(300_000);
    expect(claimScheduledRun(workspace, schedule.id)).toBeNull();
  });

  it('advances to the future when a pending retry is recovered days later', () => {
    const schedule = saveSkillSchedule(workspace, 'triage', 'daily', '09:00', null, options);
    vi.setSystemTime(new Date(schedule.nextRunAt!));
    const first = claimScheduledRun(workspace, schedule.id)!;
    failScheduledRun(workspace, schedule.id, first.id, 'Interrupted', true);
    vi.advanceTimersByTime(7 * 86_400_000);
    const retry = claimScheduledRun(workspace, schedule.id)!;
    expect(retry.scheduledAt).toBe(first.scheduledAt);
    completeScheduledRun(workspace, schedule.id, retry.id, { status: 'ready', summary: 'Caught up' });
    expect(claimScheduledRun(workspace, schedule.id)).toBeNull();
    expect(Date.parse(getSkillSchedule(workspace, 'triage')!.nextRunAt!)).toBeGreaterThan(Date.now());
  });

  it('preserves legacy output on timing edits and keeps clear tombstones', () => {
    const skill = {
      id: 'old', schedule: 'daily', schedule_time: '09:00', schedule_day: null, next_run_at: null,
    } as Skill;
    expect(migrateLegacySkillSchedule(workspace, skill)?.output).toBe('legacy');
    expect(saveSkillSchedule(workspace, 'old', 'weekly', '11:00', 2, options).output).toBe('legacy');
    clearSkillSchedule(workspace, 'old');
    expect(migrateLegacySkillSchedule(workspace, skill)).toMatchObject({ enabled: false, nextRunAt: null, output: 'legacy' });
    expect(listSkillSchedules(workspace)).toHaveLength(1);
    expect(saveSkillSchedule(workspace, 'old', 'daily', '11:00', null, options).output).toBe('canvas');
  });

  it('explicitly migrates an enabled legacy schedule one-way without persisting the command flag', () => {
    migrateLegacySkillSchedule(workspace, {
      id: 'old', schedule: 'daily', schedule_time: '09:00', schedule_day: null, next_run_at: null,
    } as Skill);
    const migrated = saveSkillSchedule(workspace, 'old', 'daily', '11:00', null, { ...options, migrateToCanvas: true });
    expect(migrated.output).toBe('canvas');
    expect(migrated).not.toHaveProperty('migrateToCanvas');
    expect(saveSkillSchedule(workspace, 'old', 'daily', '12:00', null, { ...options, migrateToCanvas: false }).output).toBe('canvas');
    expect(fs.readFileSync(path.join(workspace, '.whim', 'skill-schedules.json'), 'utf8')).not.toContain('migrateToCanvas');
  });

  it('retains old occurrence history while recreating a cleared legacy schedule as canvas', () => {
    const legacy = migrateLegacySkillSchedule(workspace, {
      id: 'old', schedule: 'daily', schedule_time: '09:00', schedule_day: null, next_run_at: null,
    } as Skill)!;
    vi.setSystemTime(new Date(legacy.nextRunAt!));
    const run = claimScheduledRun(workspace, legacy.id)!;
    completeScheduledRun(workspace, legacy.id, run.id, { status: 'ready', summary: 'Old report', spaceId: 'old-space' });
    clearSkillSchedule(workspace, 'old');
    const recreated = saveSkillSchedule(workspace, 'old', 'daily', '12:00', null, options);
    expect(recreated).toMatchObject({ enabled: true, output: 'canvas' });
    expect(listScheduledRuns(workspace, legacy.id)).toMatchObject([{ id: run.id, spaceId: 'old-space', status: 'ready' }]);
  });

  it('does not relabel an in-flight legacy run when recreating its cleared schedule', () => {
    const legacy = migrateLegacySkillSchedule(workspace, {
      id: 'old', schedule: 'daily', schedule_time: '09:00', schedule_day: null, next_run_at: null,
    } as Skill)!;
    vi.setSystemTime(new Date(legacy.nextRunAt!));
    claimScheduledRun(workspace, legacy.id);
    clearSkillSchedule(workspace, 'old');
    expect(() => saveSkillSchedule(workspace, 'old', 'daily', '12:00', null, options))
      .toThrow('Wait for the current scheduled run');
    expect(getSkillSchedule(workspace, 'old')).toMatchObject({ enabled: false, output: 'legacy' });
  });

  it('writes a tombstone even when no durable schedule existed', () => {
    clearSkillSchedule(workspace, 'old');
    expect(getSkillSchedule(workspace, 'old')).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('surfaces corrupted state instead of replacing it with an empty state', () => {
    saveSkillSchedule(workspace, 'triage', 'daily', '09:00', null, options);
    const file = path.join(workspace, '.whim', 'skill-schedules.json');
    fs.writeFileSync(file, '{broken');
    expect(() => listSkillSchedules(workspace)).toThrow();
    expect(() => saveSkillSchedule(workspace, 'triage', 'daily', '09:00', null, options)).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    fs.writeFileSync(file, '{"version":1,"records":[{}]}');
    expect(() => getSkillSchedule(workspace, 'triage')).toThrow('Invalid skill schedule record');
  });

  it('preserves the previous snapshot if atomic publication fails', () => {
    saveSkillSchedule(workspace, 'triage', 'daily', '09:00', null, options);
    const original = fs.readFileSync(path.join(workspace, '.whim', 'skill-schedules.json'), 'utf8');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('publication failed'); });
    expect(() => clearSkillSchedule(workspace, 'triage')).toThrow('publication failed');
    expect(fs.readFileSync(path.join(workspace, '.whim', 'skill-schedules.json'), 'utf8')).toBe(original);
    expect(fs.readdirSync(path.join(workspace, '.whim'))).toEqual(['skill-schedules.json']);
  });

  it('does not accept extra option properties as schedule identity or secret state', () => {
    const schedule = saveSkillSchedule(workspace, 'triage', 'daily', '09:00', null, {
      ...options, ...{ skillId: 'other', id: 'injected', secret: 'not schedule data' },
    });
    expect(schedule.skillId).toBe('triage');
    expect(schedule.id).not.toBe('injected');
    expect(JSON.stringify(schedule)).not.toContain('not schedule data');
  });
});

describe('anchored zone recurrences', () => {
  it('shifts a spring gap forward and selects the earlier fall fold once', () => {
    expect(computeNextRunAt('daily', '02:30', null, {
      timeZone: 'America/New_York', after: new Date('2024-03-10T05:00:00Z'),
    })).toBe('2024-03-10T07:30:00.000Z');
    expect(computeNextRunAt('daily', '01:30', null, {
      timeZone: 'America/New_York', after: new Date('2024-11-03T04:00:00Z'),
    })).toBe('2024-11-03T05:30:00.000Z');
    expect(computeNextRunAt('daily', '01:30', null, {
      timeZone: 'America/New_York', after: new Date('2024-11-03T05:45:00Z'),
    })).toBe('2024-11-04T06:30:00.000Z');
  });

  it('retains January 31 as the monthly anchor after February clamping', () => {
    const anchorAt = '2024-01-31T18:00:00Z';
    expect(computeNextRunAt('monthly', '09:00', null, {
      timeZone: 'America/New_York', anchorAt, after: new Date('2024-02-29T15:00:00Z'),
    })).toBe('2024-03-31T13:00:00.000Z');
  });

  it('preserves biweekly calendar phase across DST and delayed ticks', () => {
    expect(computeNextRunAt('biweekly', '09:00', 1, {
      timeZone: 'America/New_York', anchorAt: '2024-02-26T15:00:00Z',
      after: new Date('2024-03-12T15:00:00Z'),
    })).toBe('2024-03-25T13:00:00.000Z');
  });

  it('does not change biweekly phase when editing time across the original creation time', () => {
    vi.setSystemTime(new Date('2024-02-26T15:00:00Z'));
    const first = saveSkillSchedule(workspace, 'triage', 'biweekly', '09:00', 1, options);
    expect(first.nextRunAt).toBe('2024-03-11T13:00:00.000Z');
    const edited = saveSkillSchedule(workspace, 'triage', 'biweekly', '11:00', 1, options);
    expect(edited.nextRunAt).toBe('2024-03-11T15:00:00.000Z');
  });

  it('retains the monthly calendar anchor when changing zones', () => {
    vi.setSystemTime(new Date('2024-01-31T00:30:00Z'));
    saveSkillSchedule(workspace, 'triage', 'monthly', '09:00', null, { ...options, timeZone: 'UTC' });
    vi.setSystemTime(new Date('2024-01-31T12:00:00Z'));
    const edited = saveSkillSchedule(workspace, 'triage', 'monthly', '09:00', null, {
      ...options, timeZone: 'America/Los_Angeles',
    });
    expect(edited.nextRunAt).toBe('2024-01-31T17:00:00.000Z');
  });

  it('handles half-hour DST gaps', () => {
    expect(computeNextRunAt('daily', '02:15', null, {
      timeZone: 'Australia/Lord_Howe', after: new Date('2024-10-05T12:00:00Z'),
    })).toBe('2024-10-05T15:45:00.000Z');
  });
});
