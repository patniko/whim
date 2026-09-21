import { parentPort, workerData } from 'worker_threads';
import { performance } from 'perf_hooks';
import * as database from './database';
import { getActivityStats } from './activity-stats';
import { initWorkspace, readCanvas, writeCanvas, initSpaceCanvas, ensureSpaceCanvas, materializeSpaceCanvas,
  archiveSpaceFolder, unarchiveSpaceFolder, deleteSpaceFolder, saveAttachment,
  readSpaceFile, createPage, readPage, writePage, listPages } from './workspace';
import { getSkillSchedule, listSkillSchedules, listScheduledRuns, saveSkillSchedule,
  migrateLegacySkillSchedule, clearSkillSchedule, claimScheduledRun,
  recordScheduledRunLaunch, completeScheduledRun, failScheduledRun } from './services/skill-schedule-store';
import { bindArtifact, publishArtifact, acknowledgeArtifactPublication, setArtifactStatus, getArtifact, listArtifacts,
  getPrimaryArtifact, findArtifactByInstance, deleteArtifact, writeArtifactFile } from './canvas/artifact-store';
import { indexSkills, indexSkillsBatch } from './storage-index';
import { resolveContent } from './subagent-content-store';
import { compactOldSegments } from './compaction';
import { setMaintenanceInterrupt } from './maintenance-interrupt';
import { migrateOldDatabase } from './migration';
import { documentMatches, writeDocument, readDocument } from './storage-documents';
import * as skills from './storage-skills';
import { appendSpaceActivity, readSpaceActivityLog } from './space-eventlog';
import { CanvasSearchWatch } from './canvas-search-watch';
import type { StorageCommands, StorageReply, StorageRequest } from './storage-contract';
import { RuntimeHistory } from './runtime-history';

if (!parentPort) throw new Error('Storage must run in a worker');
const port = parentPort;
const runtimeHistory = new RuntimeHistory();
const canvasSearch = new CanvasSearchWatch(database.invalidateCanvasMetadata, database.syncCanvasBatch, error => {
  port.postMessage({ notification: true, channel: 'space:index-changed', args: [error ? { error } : {}] });
});
let generation = 0;
const interrupt = new Int32Array(workerData.interrupt);
const { getDatabase: _getDatabase, isInitialized: _isInitialized, ...databaseCommands } = database;
const commands: StorageCommands = {
  ...skills,
  ...databaseCommands,
  openRuntimeHistory: (...args) => runtimeHistory.open(...args),
  appendRuntimeHistory: (...args) => runtimeHistory.append(...args),
  queryRuntimeHistory: (...args) => runtimeHistory.page(...args),
  removeRuntimeHistory: (...args) => runtimeHistory.remove(...args),
  syncCanvasBatch(root, cursor) {
    canvasSearch.start(root);
    return database.syncCanvasBatch(root, cursor);
  },
  readCanvas, writeCanvas, initSpaceCanvas, ensureSpaceCanvas, materializeSpaceCanvas,
  archiveSpaceFolder, unarchiveSpaceFolder, deleteSpaceFolder, saveAttachment,
  readSpaceFile, createPage, readPage, writePage, listPages,
  getSkillSchedule, listSkillSchedules, listScheduledRuns, saveSkillSchedule,
  migrateLegacySkillSchedule, clearSkillSchedule, claimScheduledRun,
  recordScheduledRunLaunch, completeScheduledRun, failScheduledRun,
  bindArtifact, publishArtifact, acknowledgeArtifactPublication, setArtifactStatus, getArtifact, listArtifacts,
  getPrimaryArtifact, findArtifactByInstance, deleteArtifact, writeArtifactFile,
  getActivityStats, initWorkspace, indexSkills, indexSkillsBatch,
  migrateOldDatabase,
  documentMatches, writeDocument, readDocument,
  appendSpaceActivity, readSpaceActivityLog,
  compactOldSegments(root, options) {
    setMaintenanceInterrupt(interrupt);
    try {
      const result = compactOldSegments(root, options);
      if (result.reason === 'write-failed') throw new Error('Compaction failed; source data retained');
      return result;
    } finally { setMaintenanceInterrupt(); }
  },
  listSubagentRecords(id) {
    return database.listSubagentRecords(id).map(row => ({
      ...row,
      turns_json: resolveContent({ inline: row.turns_json, path: row.turns_path }),
      streaming_content: resolveContent({ inline: row.streaming_content, path: row.streaming_content_path }),
    }));
  },
  listSubagentToolCalls(id) {
    return database.listSubagentToolCalls(id).map(row => ({
      ...row, result: resolveContent({ inline: row.result, path: row.result_path }),
    }));
  },
};

// One FIFO mailbox is the serialization point for all log and cache operations.
// Reads cannot overtake writes or cross a workspace transition.
let tail = Promise.resolve();
port.on('message', (message: StorageRequest) => {
  tail = tail.then(() => dispatch(message));
});
async function dispatch(message: StorageRequest): Promise<void> {
  const started = performance.now();
  let reply: StorageReply;
  try {
    if (!Object.prototype.hasOwnProperty.call(commands, message.method)) throw new Error('Unknown storage command');
    if (message.method === 'initDatabase') {
      canvasSearch.stop();
      runtimeHistory.close();
      generation = message.generation;
    } else if (message.method !== 'initWorkspace' && message.method !== 'migrateOldDatabase' && message.generation !== generation) {
      throw new Error('Stale workspace operation');
    }
    const command = commands[message.method] as (...args: unknown[]) => unknown;
    if (message.method === 'closeDatabase') {
      canvasSearch.stop();
      runtimeHistory.close();
    }
    const value = await command(...message.args);
    reply = { id: message.id, ok: true, value, durationMs: performance.now() - started };
  } catch (error) {
    reply = { id: message.id, ok: false, error: error instanceof Error ? error.message : 'Storage operation failed', durationMs: performance.now() - started };
  }
  port.postMessage(reply);
}
