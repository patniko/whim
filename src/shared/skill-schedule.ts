import type { SkillScheduleFrequency } from './types';

export type ScheduledRunStatus =
  | 'running'
  | 'ready'
  | 'empty'
  | 'partial'
  | 'needs-connection'
  | 'failed';

export interface ScheduleOptions {
  timeZone: string;
  intent: string;
  /** Only MCP operations declared read-only by these servers are authorized. */
  readOnlyServers: string[];
  /** Explicit one-way opt-in for an existing report schedule. */
  migrateToCanvas?: boolean;
}

export interface ScheduledRun {
  id: string;
  scheduledAt: string;
  startedAt: string;
  completedAt?: string;
  status: ScheduledRunStatus;
  attempt: number;
  spaceId?: string;
  agentId?: string;
  summary?: string;
  retryAt?: string;
}

export interface SkillSchedule extends ScheduleOptions {
  id: string;
  skillId: string;
  frequency: SkillScheduleFrequency;
  time: string;
  day: number | null;
  enabled: boolean;
  /** Existing schedules retain their report and space-reuse behavior. */
  output: 'canvas' | 'legacy';
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRun?: ScheduledRun;
  lastSuccessfulRun?: ScheduledRun;
}

export interface ScheduledInvocation {
  scheduleId: string;
  runId: string;
  scheduledAt: string;
  timeZone: string;
  readOnlyServers: string[];
  previousSpaceId?: string;
  lastSuccessfulAt?: string;
  output?: 'canvas' | 'legacy';
  /** A manual preview never consumes or completes a scheduled occurrence. */
  manual?: boolean;
}

export const scheduledRunLabels: Record<ScheduledRunStatus, string> = {
  running: 'Running',
  ready: 'Ready',
  empty: 'Nothing to follow up on',
  partial: 'Partial result',
  'needs-connection': 'Needs connection',
  failed: 'Failed',
};
