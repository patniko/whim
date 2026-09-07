import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { syncDirectory, writeAll } from '../persistence-snapshot';
import { notifyAllWindows } from '../notify';
import type { Skill, SkillScheduleFrequency } from '../../shared/types';
import type { ScheduleOptions, ScheduledRun, ScheduledRunStatus, SkillSchedule } from '../../shared/skill-schedule';

const FREQUENCIES: SkillScheduleFrequency[] = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly'];
const STATUSES: ScheduledRunStatus[] = ['running', 'ready', 'empty', 'partial', 'needs-connection', 'failed'];
const DAY_MS = 86_400_000;
export const MAX_SCHEDULE_ATTEMPTS = 3;
interface ScheduleRecord {
  schedule: SkillSchedule;
  anchorAt: string;
  runs: ScheduledRun[];
}
interface ScheduleState {
  version: 1;
  records: ScheduleRecord[];
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function validateScheduleOptions(options: ScheduleOptions): void {
  if (!options || typeof options.timeZone !== 'string' || !options.timeZone || /^[+-]/.test(options.timeZone) ||
      typeof options.intent !== 'string' || !Array.isArray(options.readOnlyServers) ||
      options.readOnlyServers.some(name => typeof name !== 'string' || !name || name.includes('*')) ||
      (options.migrateToCanvas !== undefined && typeof options.migrateToCanvas !== 'boolean')) {
    throw new Error('invalid_schedule_options');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: options.timeZone }).format();
  } catch {
    throw new Error('invalid_time_zone');
  }
}

function validateTiming(frequency: SkillScheduleFrequency, time: string, day: number | null): void {
  if (!FREQUENCIES.includes(frequency)) throw new Error('invalid_frequency');
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('invalid_time');
  if (day !== null && (!Number.isInteger(day) || day < 0 || day > 6)) throw new Error('invalid_day');
}

function wallTime(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)!.value);
  return Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
}

/** DST: choose the earlier fold; shift nonexistent wall times forward by the gap. */
function resolveWallTime(wall: number, timeZone: string): number {
  const offsets = new Set([-36, 0, 36].map(hours => {
    const instant = wall + hours * 3_600_000;
    return wallTime(new Date(instant), timeZone) - instant;
  }));
  const candidates = [...offsets].map(offset => wall - offset).sort((a, b) => a - b);
  const exact = candidates.find(instant => wallTime(new Date(instant), timeZone) === wall);
  if (exact !== undefined) return exact;
  const shifted = candidates.filter(instant => wallTime(new Date(instant), timeZone) > wall)
    .sort((a, b) => wallTime(new Date(a), timeZone) - wallTime(new Date(b), timeZone))[0];
  if (shifted === undefined) throw new Error('Cannot resolve scheduled wall time');
  return shifted;
}

export interface NextRunOptions {
  timeZone?: string;
  /** Calendar anchor; for biweekly schedules this is an occurrence in the desired phase. */
  anchorAt?: string;
  after?: Date;
}

export function computeNextRunAt(
  frequency: SkillScheduleFrequency, time: string, day: number | null, options: NextRunOptions = {},
): string {
  validateTiming(frequency, time, day);
  const timeZone = options.timeZone ?? localTimeZone();
  const after = options.after ?? new Date();
  const anchor = new Date(wallTime(new Date(options.anchorAt ?? after.toISOString()), timeZone));
  const today = new Date(wallTime(after, timeZone));
  const [hours, minutes] = time.split(':').map(Number);
  const anchorDay = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  let firstBiweekly = anchorDay;
  const targetDay = day ?? 1;
  if (frequency === 'biweekly') {
    while (new Date(firstBiweekly).getUTCDay() !== targetDay) firstBiweekly += DAY_MS;
    if (!options.anchorAt) {
      if (resolveWallTime(firstBiweekly + (hours * 60 + minutes) * 60_000, timeZone) <= after.getTime()) firstBiweekly += 7 * DAY_MS;
      if (resolveWallTime(firstBiweekly + (hours * 60 + minutes) * 60_000, timeZone) - after.getTime() < 7 * DAY_MS) firstBiweekly += 7 * DAY_MS;
    }
  }
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  for (let offset = 0; offset < 400; offset++) {
    const date = new Date(start + offset * DAY_MS);
    const weekday = date.getUTCDay();
    if (frequency === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
    if (frequency === 'weekly' && weekday !== targetDay) continue;
    if (frequency === 'biweekly' && ((date.getTime() - firstBiweekly) % (14 * DAY_MS) !== 0 || date.getTime() < firstBiweekly)) continue;
    if (frequency === 'monthly') {
      const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      if (date.getUTCDate() !== Math.min(anchor.getUTCDate(), monthEnd)) continue;
    }
    const candidate = resolveWallTime(date.getTime() + (hours * 60 + minutes) * 60_000, timeZone);
    if (candidate > after.getTime()) return new Date(candidate).toISOString();
  }
  throw new Error('Cannot calculate next scheduled occurrence');
}

function statePath(workspace: string): string {
  return path.join(workspace, '.whim', 'skill-schedules.json');
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateRun(run: ScheduledRun): void {
  if (!run || typeof run.id !== 'string' || !run.id || !isDate(run.scheduledAt) ||
      !isDate(run.startedAt) || !STATUSES.includes(run.status) ||
      !Number.isInteger(run.attempt) || run.attempt < 1 || run.attempt > MAX_SCHEDULE_ATTEMPTS ||
      (run.completedAt !== undefined && !isDate(run.completedAt)) ||
      (run.retryAt !== undefined && !isDate(run.retryAt)) ||
      (run.spaceId !== undefined && typeof run.spaceId !== 'string') ||
      (run.agentId !== undefined && typeof run.agentId !== 'string') ||
      (run.summary !== undefined && typeof run.summary !== 'string') ||
      (run.status !== 'running' && !run.completedAt) ||
      (run.status === 'running' && run.completedAt !== undefined) ||
      (run.retryAt !== undefined && (run.status !== 'failed' || run.attempt >= MAX_SCHEDULE_ATTEMPTS))) {
    throw new Error('Invalid scheduled run');
  }
}

function sameRun(left: ScheduledRun | undefined, right: ScheduledRun | undefined): boolean {
  if (!left || !right) return left === right;
  const fields = ['id', 'scheduledAt', 'startedAt', 'completedAt', 'status', 'attempt', 'spaceId', 'agentId', 'summary', 'retryAt'] as const;
  return fields.every(field => left[field] === right[field]);
}

function readState(workspace: string): ScheduleState {
  let text: string;
  try {
    text = fs.readFileSync(statePath(workspace), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
    throw error;
  }
  const state: ScheduleState = JSON.parse(text);
  if (!state || state.version !== 1 || !Array.isArray(state.records)) throw new Error('Invalid skill schedule state');
  const skills = new Set<string>();
  const ids = new Set<string>();
  for (const record of state.records) {
    const schedule = record?.schedule;
    if (!schedule || typeof schedule.id !== 'string' || !schedule.id || typeof schedule.skillId !== 'string' ||
        !schedule.skillId || skills.has(schedule.skillId) || ids.has(schedule.id) ||
        typeof schedule.enabled !== 'boolean' || !['canvas', 'legacy'].includes(schedule.output) ||
        !isDate(schedule.createdAt) || !isDate(schedule.updatedAt) || !isDate(record.anchorAt) ||
        (schedule.nextRunAt !== null && !isDate(schedule.nextRunAt)) || !Array.isArray(record.runs)) {
      throw new Error('Invalid skill schedule record');
    }
    validateScheduleOptions(schedule);
    validateTiming(schedule.frequency, schedule.time, schedule.day);
    record.runs.forEach(validateRun);
    if (schedule.lastRun) validateRun(schedule.lastRun);
    if (schedule.lastSuccessfulRun) validateRun(schedule.lastSuccessfulRun);
    const successes = record.runs.filter(run => run.status === 'ready' || run.status === 'empty');
    const attempts = new Map<string, number>();
    for (const run of record.runs) {
      const attempt = (attempts.get(run.scheduledAt) ?? 0) + 1;
      if (run.attempt !== attempt) throw new Error('Inconsistent scheduled run attempts');
      attempts.set(run.scheduledAt, attempt);
    }
    if ((schedule.enabled && !schedule.nextRunAt) || (!schedule.enabled && schedule.nextRunAt !== null) ||
        new Set(record.runs.map(run => run.id)).size !== record.runs.length ||
        record.runs.filter(run => run.status === 'running').length > 1 ||
        record.runs.some(run => run.status === 'running' && run.id !== schedule.lastRun?.id) ||
        !sameRun(schedule.lastRun, record.runs[record.runs.length - 1]) ||
        !sameRun(schedule.lastSuccessfulRun, successes[successes.length - 1])) {
      throw new Error('Inconsistent skill schedule history');
    }
    skills.add(schedule.skillId);
    ids.add(schedule.id);
  }
  return state;
}

/** Atomic snapshots are owned by one local main process, not a cross-device lease. */
function writeState(workspace: string, state: ScheduleState): void {
  const target = statePath(workspace);
  const directory = path.dirname(target);
  const directoryExisted = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true });
  if (!directoryExisted) syncDirectory(workspace);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      writeAll(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
    syncDirectory(directory);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  notifyAllWindows('skills:changed');
}

export function getSkillSchedule(workspace: string, skillId: string): SkillSchedule | null {
  return readState(workspace).records.find(record => record.schedule.skillId === skillId)?.schedule ?? null;
}

export function listSkillSchedules(workspace: string): SkillSchedule[] {
  return readState(workspace).records.map(record => record.schedule);
}

export function listScheduledRuns(workspace: string, scheduleId: string): ScheduledRun[] {
  return readState(workspace).records.find(record => record.schedule.id === scheduleId)?.runs ?? [];
}

function newRecord(skillId: string, frequency: SkillScheduleFrequency, time: string, day: number | null, options: ScheduleOptions): ScheduleRecord {
  if (typeof skillId !== 'string' || !skillId) throw new Error('invalid_skill_id');
  const now = new Date().toISOString();
  const nextRunAt = computeNextRunAt(frequency, time, day, { timeZone: options.timeZone });
  const schedule: SkillSchedule = {
    id: randomUUID(), skillId, frequency, time, day,
    timeZone: options.timeZone, intent: options.intent, readOnlyServers: [...new Set(options.readOnlyServers)],
    enabled: true, output: 'canvas',
    createdAt: now, updatedAt: now,
    nextRunAt,
  };
  return { schedule, anchorAt: frequency === 'biweekly' ? nextRunAt : now, runs: [] };
}

export function saveSkillSchedule(
  workspace: string, skillId: string, frequency: SkillScheduleFrequency, time: string,
  day: number | null, options: ScheduleOptions,
): SkillSchedule {
  validateTiming(frequency, time, day);
  validateScheduleOptions(options);
  const state = readState(workspace);
  let record = state.records.find(entry => entry.schedule.skillId === skillId);
  if (!record) {
    record = newRecord(skillId, frequency, time, day, options);
    state.records.push(record);
  } else {
    const schedule = record.schedule;
    const useCanvas = !schedule.enabled || options.migrateToCanvas === true;
    if (useCanvas && schedule.output === 'legacy' && record.runs.some(run => run.status === 'running')) {
      throw new Error('Wait for the current scheduled run to finish before changing its output.');
    }
    if (!schedule.enabled || schedule.frequency !== frequency) {
      record.anchorAt = frequency === 'biweekly'
        ? computeNextRunAt(frequency, time, day, { timeZone: options.timeZone })
        : new Date().toISOString();
    } else if (schedule.timeZone !== options.timeZone) {
      record.anchorAt = new Date(resolveWallTime(
        wallTime(new Date(record.anchorAt), schedule.timeZone), options.timeZone,
      )).toISOString();
    }
    Object.assign(schedule, {
      frequency, time, day, timeZone: options.timeZone, intent: options.intent,
      readOnlyServers: [...new Set(options.readOnlyServers)], enabled: true,
      output: useCanvas ? 'canvas' : schedule.output,
      updatedAt: new Date().toISOString(),
      nextRunAt: computeNextRunAt(frequency, time, day, { timeZone: options.timeZone, anchorAt: record.anchorAt }),
    });
    delete schedule.migrateToCanvas;
  }
  writeState(workspace, state);
  return record.schedule;
}

/** Import only once; a disabled record deliberately wins over stale frontmatter. */
export function migrateLegacySkillSchedule(workspace: string, skill: Skill): SkillSchedule | null {
  const state = readState(workspace);
  const existing = state.records.find(record => record.schedule.skillId === skill.id);
  if (existing) return existing.schedule;
  if (!skill.schedule) return null;
  const record = newRecord(skill.id, skill.schedule, skill.schedule_time ?? '09:00', skill.schedule_day, {
    timeZone: localTimeZone(), intent: '', readOnlyServers: [],
  });
  record.schedule.output = 'legacy';
  if (skill.next_run_at) {
    record.schedule.nextRunAt = skill.next_run_at;
    if (skill.schedule === 'biweekly') record.anchorAt = skill.next_run_at;
  }
  state.records.push(record);
  writeState(workspace, state);
  return record.schedule;
}

export function clearSkillSchedule(workspace: string, skillId: string): void {
  const state = readState(workspace);
  let record = state.records.find(entry => entry.schedule.skillId === skillId);
  if (!record) {
    record = newRecord(skillId, 'daily', '09:00', null, { timeZone: localTimeZone(), intent: '', readOnlyServers: [] });
    state.records.push(record);
  }
  record.schedule.enabled = false;
  record.schedule.nextRunAt = null;
  record.schedule.updatedAt = new Date().toISOString();
  for (const run of record.runs) delete run.retryAt;
  if (record.schedule.lastRun) delete record.schedule.lastRun.retryAt;
  writeState(workspace, state);
}

export function claimScheduledRun(workspace: string, scheduleId: string, now = new Date()): ScheduledRun | null {
  const state = readState(workspace);
  const record = state.records.find(entry => entry.schedule.id === scheduleId);
  if (!record || !record.schedule.enabled || record.runs.some(run => run.status === 'running')) return null;
  const schedule = record.schedule;
  const previous = schedule.lastRun;
  const retry = previous?.retryAt && previous.attempt < MAX_SCHEDULE_ATTEMPTS;
  if (retry ? previous.retryAt! > now.toISOString() : !schedule.nextRunAt || schedule.nextRunAt > now.toISOString()) return null;
  const run: ScheduledRun = {
    id: randomUUID(), scheduledAt: retry ? previous.scheduledAt : schedule.nextRunAt!,
    startedAt: now.toISOString(), status: 'running', attempt: retry ? previous.attempt + 1 : 1,
  };
  if (previous) delete previous.retryAt;
  for (const previousRun of record.runs) delete previousRun.retryAt;
  schedule.nextRunAt = computeNextRunAt(schedule.frequency, schedule.time, schedule.day, {
    after: now, timeZone: schedule.timeZone, anchorAt: record.anchorAt,
  });
  record.runs.push(run);
  schedule.lastRun = run;
  schedule.updatedAt = now.toISOString();
  writeState(workspace, state);
  return run;
}

export function recordScheduledRunLaunch(workspace: string, scheduleId: string, runId: string, launch: { spaceId: string; agentId?: string }): void {
  const state = readState(workspace);
  const record = state.records.find(entry => entry.schedule.id === scheduleId);
  const run = record?.runs.find(entry => entry.id === runId);
  if (!record || !run) throw new Error('Scheduled run not found');
  // Completion can race the awaited launch. Attach identity without replacing status.
  run.spaceId = launch.spaceId;
  if (launch.agentId) run.agentId = launch.agentId;
  if (record.schedule.lastRun?.id === runId) record.schedule.lastRun = run;
  if (record.schedule.lastSuccessfulRun?.id === runId) record.schedule.lastSuccessfulRun = run;
  writeState(workspace, state);
}

export function completeScheduledRun(
  workspace: string, scheduleId: string, runId: string,
  result: { status: Exclude<ScheduledRunStatus, 'running'>; summary: string; spaceId?: string },
): void {
  const state = readState(workspace);
  const record = state.records.find(entry => entry.schedule.id === scheduleId);
  const run = record?.runs.find(entry => entry.id === runId);
  if (!record || !run) throw new Error('Scheduled run not found');
  if (run.status !== 'running') return;
  if (!STATUSES.includes(result.status) || result.status === ('running' as ScheduledRunStatus) ||
      typeof result.summary !== 'string' || (result.spaceId !== undefined && typeof result.spaceId !== 'string')) {
    throw new Error('Invalid scheduled run completion');
  }
  run.status = result.status;
  run.summary = result.summary;
  run.completedAt = new Date().toISOString();
  if (result.spaceId !== undefined) run.spaceId = result.spaceId;
  delete run.retryAt;
  if (record.schedule.lastRun?.id === runId) record.schedule.lastRun = run;
  if (result.status === 'ready' || result.status === 'empty') record.schedule.lastSuccessfulRun = run;
  record.schedule.updatedAt = new Date().toISOString();
  writeState(workspace, state);
}

/** Only launch failures and interrupted read-only attempts may be retried. */
export function failScheduledRun(workspace: string, scheduleId: string, runId: string, summary: string, retryable: boolean): void {
  const state = readState(workspace);
  const record = state.records.find(entry => entry.schedule.id === scheduleId);
  const run = record?.runs.find(entry => entry.id === runId);
  if (!record || !run) throw new Error('Scheduled run not found');
  if (run.status !== 'running') return;
  run.status = 'failed';
  run.summary = summary;
  run.completedAt = new Date().toISOString();
  if (retryable && record.schedule.enabled && run.attempt < MAX_SCHEDULE_ATTEMPTS) {
    run.retryAt = new Date(Date.now() + 60_000 * run.attempt).toISOString();
  }
  if (record.schedule.lastRun?.id === run.id) record.schedule.lastRun = run;
  record.schedule.updatedAt = run.completedAt;
  writeState(workspace, state);
}
