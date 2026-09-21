import { Worker } from 'worker_threads';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { AsyncLocalStorage } from 'async_hooks';
import { notifyAllWindows } from './notify';
import type * as Database from './database';
import type { StorageCommands, StorageMethod, StorageReply, StorageRequest, StorageNotification } from './storage-contract';
import { recordTiming, startTiming } from '../shared/performance';
import { workspaceContext, workspaceGeneration as generation, advanceWorkspaceGeneration, withWorkspaceContext, withStorageGeneration } from './workspace-context';
export { withWorkspaceContext, withStorageGeneration, assertWorkspaceContext } from './workspace-context';

type AsyncCommands = {
  [K in StorageMethod]: (...args: Parameters<StorageCommands[K]>) => Promise<Awaited<ReturnType<StorageCommands[K]>>>;
};

const MAX_PENDING = 256;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
let worker: Worker | undefined;
let sequence = 0;
let initialized = false;
let closing = false;
let closePromise: Promise<void> | undefined;
let pendingBytes = 0;
const interrupt = new Int32Array(new SharedArrayBuffer(4));
let failure: Error | undefined;
const barrierContext = new AsyncLocalStorage<boolean>();
let barrier: Promise<void> | undefined;
let deferredBytes = 0;
const deferred = new Set<() => void>();

/** Pause admission across the short local Git mutation, never across network IO. */
export async function withStorageBarrier<T>(run: () => Promise<T>): Promise<T> {
  if (barrier) throw new Error('Workspace mutation already in progress');
  let release!: () => void;
  barrier = new Promise<void>(resolve => { release = resolve; });
  try {
    return await barrierContext.run(true, async () => {
      await request('applyIncomingChanges', []);
      await request('checkpointAppliedState', []);
      return run();
    });
  } finally {
    barrier = undefined;
    release();
    for (const resume of deferred) resume();
  }
}
const pending = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  bytes: number;
  started: number;
  method: StorageMethod;
}>();

export type StorageReadiness = import('../shared/ipc-contract').StorageStatus;
let indexing = false;
export function getStorageReadiness(): StorageReadiness {
  return {
    state: failure ? 'failed' : closing ? 'closing' : initialized ? 'ready' : worker ? 'opening' : 'closed',
    generation, pending: pending.size + deferred.size, indexing,
  };
}
export function isInitialized(): boolean { return initialized; }
export function getStorageGeneration(): number { return generation; }

function fail(error: Error): void {
  failure = error;
  initialized = false;
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
  pendingBytes = 0;
}

function ensureWorker(): Worker {
  if (failure) throw failure;
  if (worker) return worker;
  const instance = new Worker(path.join(__dirname, 'storage-worker.js'), { workerData: { interrupt: interrupt.buffer } });
  worker = instance;
  instance.on('message', (reply: StorageReply | StorageNotification) => {
    if ('notification' in reply) {
      if (worker === instance) withWorkspaceContext(() => notifyAllWindows(reply.channel, ...reply.args));
      return;
    }
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    pendingBytes -= entry.bytes;
    const elapsed = performance.now() - entry.started;
    recordTiming('storage.roundtrip', elapsed, reply.ok);
    recordTiming('storage.execution', reply.durationMs, reply.ok);
    if (process.env.WHIM_PERF === '1' && elapsed >= 50) console.info('[perf:storage]', {
      method: entry.method, durationMs: elapsed, executionMs: reply.durationMs, queued: pending.size,
    });
    if (reply.ok) entry.resolve(reply.value);
    else entry.reject(new Error(reply.error));
  });
  instance.on('error', error => { if (worker === instance) fail(error); });
  instance.on('exit', code => {
    if (worker === instance) {
      worker = undefined;
      if (!closing || pending.size) fail(new Error(`Storage worker exited (${code})`));
    }
  });
  return instance;
}

function request<K extends StorageMethod>(
  method: K, args: Parameters<StorageCommands[K]>, allowClosing = false,
): Promise<Awaited<ReturnType<StorageCommands[K]>>> {
  if (closing && !allowClosing) return Promise.reject(new Error('Storage is closing'));
  if (method !== 'compactOldSegments') Atomics.store(interrupt, 0, 1);
  const requestGeneration = workspaceContext.getStore() ?? generation;
  if (requestGeneration !== generation) return Promise.reject(new Error('Stale workspace operation'));
  // Bound admission before structured-cloning large documents into the worker.
  const bytes = Buffer.byteLength(JSON.stringify(args));
  if (!allowClosing && (pending.size + deferred.size >= MAX_PENDING || pendingBytes + deferredBytes + bytes > MAX_PENDING_BYTES)) {
    return Promise.reject(new Error('Storage busy: queue capacity exceeded; retry the operation'));
  }
  if (barrier && !barrierContext.getStore()) {
    deferredBytes += bytes;
    return new Promise((resolve, reject) => {
      const resume = () => {
        deferred.delete(resume);
        deferredBytes -= bytes;
        try {
          withStorageGeneration(requestGeneration, () => request(method, args, allowClosing)).then(resolve, reject);
        } catch (error) { reject(error); }
      };
      deferred.add(resume);
    });
  }
  return new Promise((resolve, reject) => {
    const instance = ensureWorker();
    const id = ++sequence;
    pendingBytes += bytes;
    pending.set(id, {
      resolve: value => resolve(value as Awaited<ReturnType<StorageCommands[K]>>),
      reject, bytes, started: performance.now(), method,
    });
    try {
      instance.postMessage({ id, method, args, generation: requestGeneration } satisfies StorageRequest);
    } catch (error) {
      pending.delete(id);
      pendingBytes -= bytes;
      reject(error);
    }
  });
}

const commands = new Proxy({} as AsyncCommands, {
  get: (_target, method: StorageMethod) => (...args: Parameters<StorageCommands[StorageMethod]>) => request(method, args),
});

export async function initDatabase(...args: Parameters<typeof Database.initDatabase>): Promise<void> {
  const end = startTiming('startup.storage');
  if (closing) throw new Error('Storage is closing');
  initialized = false;
  advanceWorkspaceGeneration();
  const current = generation;
  try { await workspaceContext.run(generation, () => request('initDatabase', args)); }
  catch (error) { end(false); throw error; }
  if (current !== generation) throw new Error('Workspace changed during initialization');
  initialized = true;
  end();
}

/** Admission closes synchronously; the final message follows every admitted operation. */
export function closeDatabase(): Promise<void> {
  if (!closePromise) {
    closePromise = closeWorker().finally(() => { closePromise = undefined; });
  }
  return closePromise;
}

async function closeWorker(): Promise<void> {
  if (barrier && !barrierContext.getStore()) await barrier;
  const instance = worker;
  closing = true;
  initialized = false;
  try {
    if (failure) throw failure;
    if (instance) await request('closeDatabase', [], true);
  } finally {
    try {
      if (instance) await instance.terminate();
    } finally {
      // Keep the instance registered until exit so unexpected exits settle
      // admitted requests. A failed worker can be reopened after this close.
      if (worker === instance) worker = undefined;
      if (pending.size) fail(new Error('Storage closed before pending operations completed'));
      failure = undefined;
      if (instance) advanceWorkspaceGeneration();
      closing = false;
    }
  }
}

export async function syncCanvasContent(workspace: string): Promise<void> {
  indexing = true;
  const current = generation;
  try {
    let cursor: string | undefined;
    do {
      if (generation !== current) throw new Error('Workspace changed during canvas indexing');
      cursor = (await request('syncCanvasBatch', [workspace, cursor])).cursor;
    } while (cursor);
  }
  finally { indexing = false; }
}

export async function indexSkills(workspace: string): Promise<void> {
  const current = workspaceContext.getStore() ?? generation;
  let cursor: string | undefined;
  do {
    const batch = await withStorageGeneration(current, () => request('indexSkillsBatch', [workspace, cursor]));
    if (current !== generation) throw new Error('Stale workspace operation');
    cursor = batch.cursor;
  } while (cursor);
}

export const {
  openRuntimeHistory, appendRuntimeHistory, queryRuntimeHistory, removeRuntimeHistory,
  mergeSessionIds, createSpace, getSpace, listSpaces, updateSpace, updateSpaceCAS,
  listSpaceSummaries, listSpaceEventsPage,
  listAgentSummaries,
  listAgentHistoryPage,
  listActivityPage,
  getSpaceSummary,
  assignSpaceFolder, logSpaceEvent, listSpaceEvents, setSpaceSessionId, deleteSpace,
  updateCanvasContent, getLatestSpaceForSkill, hasActiveAgentForSpace, searchSpaces,
  createCanvasAgent, updateCanvasAgentStatus, listCanvasAgents, listAllRunningAgents,
  createAgentSession, updateAgentSessionStatus, updateAgentSessionCcaResult,
  updateAgentSessionYolo, getAgentSession, listAgentSessions, updateAgentSessionId,
  deleteAgentSession, appendAgentChatEvent, listAgentChatEvents, clearAgentChatEvents,
  upsertSkill, removeSkill, listSkills, getSkill, getDueSkills, updateSkillSchedule,
  markSkillRun, claimSkillRun, getScheduledSkillsNeedingNextRun, createSubagentRecord,
  updateSubagentRecord, listSubagentRecords, createSubagentToolCall,
  updateSubagentToolCall, listSubagentToolCalls, getActivityStats,
  initWorkspace, applyIncomingChanges, checkpointAppliedState, migrateOldDatabase,
  documentMatches, writeDocument, readDocument, createSkillDocument, deleteSkillDirectory, getSkillCanvasSettings,
  appendSpaceActivity, readSpaceActivityLog,
  readCanvas, writeCanvas, initSpaceCanvas, ensureSpaceCanvas, materializeSpaceCanvas,
  archiveSpaceFolder, unarchiveSpaceFolder, deleteSpaceFolder, saveAttachment,
  readSpaceFile, createPage, readPage, writePage, listPages,
  getSkillSchedule, listSkillSchedules, listScheduledRuns, saveSkillSchedule,
  migrateLegacySkillSchedule, clearSkillSchedule, claimScheduledRun,
  recordScheduledRunLaunch, completeScheduledRun, failScheduledRun,
  bindArtifact, publishArtifact, acknowledgeArtifactPublication, setArtifactStatus, getArtifact, listArtifacts,
  getPrimaryArtifact, findArtifactByInstance, deleteArtifact, writeArtifactFile,
} = commands;

/** Only idle maintenance is admitted, and new foreground work interrupts it. */
export async function compactOldSegments(...args: Parameters<StorageCommands['compactOldSegments']>): Promise<Awaited<ReturnType<StorageCommands['compactOldSegments']>>> {
  if (pending.size || closing || barrier) return { ran: false, reason: 'interrupted' };
  Atomics.store(interrupt, 0, 0);
  return request('compactOldSegments', args);
}

export type { SpaceEvent, SubagentRecordRow, SubagentToolCallRow } from './database';
