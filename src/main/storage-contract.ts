import type * as Database from './database';
import type { getActivityStats } from './activity-stats';
import type { initWorkspace } from './workspace';
import type { indexSkills, indexSkillsBatch } from './storage-index';
import type { compactOldSegments } from './compaction';
import type * as Workspace from './workspace';
import type * as Schedules from './services/skill-schedule-store';
import type * as Artifacts from './canvas/artifact-store';
import type { migrateOldDatabase } from './migration';
import type { documentMatches, writeDocument, readDocument } from './storage-documents';
import type * as Skills from './storage-skills';
import type { appendSpaceActivity, readSpaceActivityLog } from './space-eventlog';
import type { RuntimeHistory } from './runtime-history';

export type StorageCommands = Omit<typeof Database, 'getDatabase' | 'isInitialized'>
  & typeof Skills
  & Pick<typeof Workspace, 'readCanvas' | 'writeCanvas' | 'initSpaceCanvas' | 'ensureSpaceCanvas' | 'materializeSpaceCanvas' | 'archiveSpaceFolder' | 'unarchiveSpaceFolder' | 'deleteSpaceFolder' | 'saveAttachment' | 'readSpaceFile' | 'createPage' | 'readPage' | 'writePage' | 'listPages'>
  & Pick<typeof Schedules, 'getSkillSchedule' | 'listSkillSchedules' | 'listScheduledRuns' | 'saveSkillSchedule' | 'migrateLegacySkillSchedule' | 'clearSkillSchedule' | 'claimScheduledRun' | 'recordScheduledRunLaunch' | 'completeScheduledRun' | 'failScheduledRun'>
  & Pick<typeof Artifacts, 'bindArtifact' | 'publishArtifact' | 'acknowledgeArtifactPublication' | 'setArtifactStatus' | 'getArtifact' | 'listArtifacts' | 'getPrimaryArtifact' | 'findArtifactByInstance' | 'deleteArtifact' | 'writeArtifactFile'>
  & {
  getActivityStats: typeof getActivityStats;
  initWorkspace: typeof initWorkspace;
  indexSkills: typeof indexSkills;
  indexSkillsBatch: typeof indexSkillsBatch;
  compactOldSegments: typeof compactOldSegments;
  migrateOldDatabase: typeof migrateOldDatabase;
  documentMatches: typeof documentMatches;
  writeDocument: typeof writeDocument;
  readDocument: typeof readDocument;
  appendSpaceActivity: typeof appendSpaceActivity;
  readSpaceActivityLog: typeof readSpaceActivityLog;
  openRuntimeHistory: RuntimeHistory['open'];
  appendRuntimeHistory: RuntimeHistory['append'];
  queryRuntimeHistory: RuntimeHistory['page'];
  removeRuntimeHistory: RuntimeHistory['remove'];
};
export interface StorageNotification { notification: true; channel: string; args: unknown[]; }
export type StorageMethod = keyof StorageCommands;
export interface StorageRequest {
  id: number;
  generation: number;
  method: StorageMethod;
  args: unknown[];
}
export type StorageReply =
  | { id: number; ok: true; value: unknown; durationMs: number }
  | { id: number; ok: false; error: string; durationMs: number };
