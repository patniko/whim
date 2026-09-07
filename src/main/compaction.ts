/**
 * Fold a cold prefix of the log into a streamed, checksummed snapshot.
 * Coverage is published IN the snapshot before deleting any source. A crash
 * during cleanup therefore cannot replay non-idempotent events twice.
 *
 * Historical retention is unchanged: cold subagent verbose content expires;
 * transcripts, usage and other durable state do not. Hot references protect
 * side files and subagents still used inside the keep window.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { performance } from 'perf_hooks';
import Database from 'better-sqlite3';
import { checkMaintenanceInterrupt, MaintenanceInterrupted } from './maintenance-interrupt';
import { listLogFiles, monthBucket, MAX_SEGMENT_BYTES, SNAPSHOT_FILENAME, LOG_ROOT_DIRNAME } from './log-store';
import { replayFile, validateDurableEvent } from './eventlog';
import { createPersistenceSchema, SNAPSHOT_COLUMNS, type SnapshotTable } from './persistence-schema';
import {
  coveredOffset, hashFile, isContentFilename, readLines, readSnapshotManifest,
  resolveSnapshotChunk, segmentCoverage, snapshotChunkFiles, syncDirectory, writeAll,
  type SnapshotChunk, type SnapshotManifest,
} from './persistence-snapshot';

export const KEEP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const LOCK_FILENAME = '.compacting.lock';
export const LOCK_STALE_MS = 10 * 60 * 1000;

export interface CompactionResult {
  ran: boolean;
  reason?: 'locked' | 'nothing-to-compact' | 'no-segments' | 'write-failed' | 'interrupted';
  compactedSegments?: number;
  removedSideFiles?: number;
  /** Numeric diagnostics only; never contains document content. */
  durationMs?: number;
  inputBytes?: number;
  snapshotBytes?: number;
}

export function compactOldSegments(
  logRoot: string,
  options: { now?: Date; keepWindowMs?: number } = {},
): CompactionResult {
  const started = performance.now();
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - (options.keepWindowMs ?? KEEP_WINDOW_MS);
  if (!fs.existsSync(logRoot)) return { ran: false, reason: 'no-segments' };
  if (!acquireLock(logRoot)) return { ran: false, reason: 'locked' };

  let scratch: string | undefined;
  let temporarySnapshot: string | undefined;
  const newChunks: string[] = [];
  let snapshotPublished = false;
  try {
    const snapshotPath = path.join(logRoot, SNAPSHOT_FILENAME);
    const allFiles = listLogFiles(logRoot);
    const segments = allFiles.filter(file => file !== snapshotPath);
    const manifest = readSnapshotManifest(logRoot);
    const coverage = new Map(manifest.covered.map(entry => [entry.path, entry]));
    const offsets = new Map(segments.map(file => [
      file, coveredOffset(file, coverage.get(relativeSegment(logRoot, file))),
    ]));
    const cold: string[] = [];
    // Only a prefix may move ahead of the retained log. Folding a later cold
    // file over an earlier hot update would change the replay result.
    for (const file of segments) {
      if (coverage.has(relativeSegment(logRoot, file)) && offsets.get(file) === fs.statSync(file).size) continue;
      if (path.basename(path.dirname(file)) === monthBucket(now) ||
          !isSegmentCold(file, cutoff, offsets.get(file)!)) break;
      cold.push(file);
    }
    const pendingCleanup = segments.some(file =>
      coverage.has(relativeSegment(logRoot, file)) && offsets.get(file) === fs.statSync(file).size);
    if (!cold.length && !pendingCleanup && !manifest.garbage.length) {
      return { ran: false, reason: 'nothing-to-compact' };
    }

    // A disk-backed materialisation and row-at-a-time snapshots avoid holding
    // the whole transcript/history in either JS arrays or an in-memory SQLite DB.
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-compaction-'));
    const database = new Database(path.join(scratch, 'state.db'));
    try {
      database.pragma('foreign_keys = OFF');
      database.pragma('cache_size = -2048');
      createPersistenceSchema(database);
      const previousChunks = snapshotChunkFiles(logRoot);
      const inputs = [...allFiles, ...previousChunks].map(file => ({ file, bytes: fs.statSync(file).size, hash: hashFile(file) }));
      const retained = segments.filter(file => !cold.includes(file));
      database.exec(`
        CREATE TABLE protected_paths (path TEXT PRIMARY KEY);
        CREATE TABLE protected_subagents (id TEXT PRIMARY KEY);
        CREATE TABLE garbage (path TEXT PRIMARY KEY);
      `);
      database.transaction(() => {
        if (fs.existsSync(snapshotPath)) replayFile(snapshotPath, database, { strict: true });
        for (const file of cold) {
          replayFile(file, database, { start: offsets.get(file), strict: true });
          coverage.set(relativeSegment(logRoot, file), segmentCoverage(logRoot, file));
        }
        for (const file of retained) protectReferences(database, file, offsets.get(file)!);
        const garbage = database.prepare('INSERT OR IGNORE INTO garbage VALUES (?)');
        for (const file of manifest.garbage) garbage.run(file);
        for (const file of cold) {
          for (const line of readLines(file, offsets.get(file))) {
            if (!line.text.trim()) continue;
            visitContentPaths(JSON.parse(line.text).data, relative => garbage.run(relative));
          }
        }
        expireColdContent(database);
        database.exec(`
          DELETE FROM garbage WHERE path IN (
            SELECT path FROM protected_paths
            UNION SELECT streaming_content_path FROM subagent_records WHERE streaming_content_path IS NOT NULL
            UNION SELECT turns_path FROM subagent_records WHERE turns_path IS NOT NULL
            UNION SELECT result_path FROM subagent_tool_calls WHERE result_path IS NOT NULL
          );
        `);
      })();

      const nextManifest: SnapshotManifest = {
        version: 1,
        covered: [...coverage.values()].sort((a, b) => a.path.localeCompare(b.path)),
        garbage: database.prepare('SELECT path FROM garbage ORDER BY path').all()
          .map(row => (row as { path: string }).path)
          .filter(file => fs.existsSync(path.join(path.dirname(logRoot), 'subagent-content', file))),
      };
      temporarySnapshot = `${snapshotPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
      writeSnapshot(temporarySnapshot, database, nextManifest, now.toISOString());
      shardSnapshot(temporarySnapshot, logRoot, nextManifest, now.toISOString(), newChunks);
      // Do not publish a state assembled across different versions of a synced log.
      assertInputsUnchanged(logRoot, inputs);
      fs.renameSync(temporarySnapshot, snapshotPath);
      temporarySnapshot = undefined;
      snapshotPublished = true;
      syncDirectory(logRoot);

      // If a peer appended to a covered file, leave it intact. Replay verifies
      // and skips only the covered prefix, then applies the appended suffix.
      let removedSegments = 0;
      for (const entry of nextManifest.covered) {
        checkMaintenanceInterrupt();
        const file = path.join(logRoot, entry.path);
        if (!fs.existsSync(file)) continue;
        const offset = coveredOffset(file, entry);
        if (fs.statSync(file).size !== offset) continue;
        fs.unlinkSync(file);
        syncDirectory(path.dirname(file));
        removedSegments++;
      }

      // Re-scan retained/hot logs AFTER segment cleanup. Unknown or malformed
      // data blocks GC, rather than guessing that no reference exists.
      database.exec('DELETE FROM protected_paths; DELETE FROM protected_subagents;');
      for (const file of listLogFiles(logRoot)) protectReferences(database, file, 0);
      let removedSideFiles = 0;
      const contentDir = path.join(path.dirname(logRoot), 'subagent-content');
      const protectedPath = database.prepare('SELECT 1 FROM protected_paths WHERE path = ?');
      for (const file of nextManifest.garbage) {
        checkMaintenanceInterrupt();
        if (protectedPath.get(file)) continue;
        try {
          fs.unlinkSync(path.join(contentDir, file));
          removedSideFiles++;
        } catch (err) {
          if (err instanceof MaintenanceInterrupted) return { ran: false, reason: 'interrupted', durationMs: performance.now() - started };
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      if (fs.existsSync(contentDir)) syncDirectory(contentDir);
      const currentChunks = new Set(snapshotChunkFiles(logRoot));
      for (const file of previousChunks) {
        if (!currentChunks.has(file)) fs.unlinkSync(file);
      }
      if (previousChunks.length) syncDirectory(path.join(logRoot, 'snapshots'));
      pruneEmptyBuckets(logRoot);
      return {
        ran: true, compactedSegments: removedSegments, removedSideFiles,
        durationMs: performance.now() - started,
        inputBytes: inputs.reduce((sum, input) => sum + input.bytes, 0),
        snapshotBytes: fs.statSync(snapshotPath).size + [...currentChunks].reduce((sum, file) => sum + fs.statSync(file).size, 0),
      };
    } finally {
      database.close();
    }
  } catch (err) {
    console.warn('[compaction] Compaction failed; source coverage is retained:', err);
    return { ran: false, reason: 'write-failed', durationMs: performance.now() - started };
  } finally {
    try {
      try {
        if (temporarySnapshot && fs.existsSync(temporarySnapshot)) fs.unlinkSync(temporarySnapshot);
        if (!snapshotPublished) {
          for (const file of newChunks) fs.unlinkSync(file);
        }
      } finally {
        if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
      }
    } finally {
      releaseLock(logRoot);
    }
  }
}

function relativeSegment(logRoot: string, file: string): string {
  return path.relative(logRoot, file).split(path.sep).join('/');
}

function isSegmentCold(file: string, cutoff: number, start: number): boolean {
  for (const line of readLines(file, start)) {
    if (!line.text.trim()) continue;
    // Corruption is not evidence of age and must never be compacted away.
    const event = JSON.parse(line.text);
    if (!line.terminated) throw new Error(`Incomplete segment: ${file}`);
    const ts = typeof event.ts === 'string' ? Date.parse(event.ts) : NaN;
    if (!Number.isFinite(ts)) throw new Error(`Invalid event timestamp: ${file}`);
    if (ts >= cutoff) return false;
  }
  return true;
}

function protectReferences(database: Database.Database, file: string, start: number): void {
  const protectPath = database.prepare('INSERT OR IGNORE INTO protected_paths VALUES (?)');
  const protectAgent = database.prepare('INSERT OR IGNORE INTO protected_subagents VALUES (?)');
  for (const line of readLines(file, start)) {
    if (!line.text.trim()) continue;
    if (!line.terminated) throw new Error(`Incomplete retained segment: ${file}`);
    const event = JSON.parse(line.text);
    if (typeof event.op !== 'string' || !event.data || typeof event.data !== 'object') {
      throw new Error(`Invalid retained event: ${file}`);
    }
    if (event.op === 'snapshot.begin' || event.op === 'snapshot.end') continue;
    if (event.op === 'snapshot.chunk' && path.basename(file) === SNAPSHOT_FILENAME) {
      protectReferences(database, resolveSnapshotChunk(path.dirname(file), event.data), 0);
      continue;
    }
    validateDurableEvent(event);
    visitContentPaths(event.data, relative => protectPath.run(relative));
    if (event.op.startsWith('subagent.')) protectAgent.run(event.data.id);
    if (event.op.startsWith('subagent_tool.')) protectAgent.run(event.data.subagent_id);
  }
}

function visitContentPaths(value: unknown, visit: (relative: string) => void): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['streaming_content_path', 'turns_path', 'result_path'].includes(key) && typeof child === 'string') {
      if (!isContentFilename(child)) throw new Error('Invalid content path in event log');
      visit(child);
    } else {
      visitContentPaths(child, visit);
    }
  }
}

function expireColdContent(database: Database.Database): void {
  for (const table of ['subagent_records', 'subagent_tool_calls'] as const) {
    const columns = table === 'subagent_records'
      ? [['streaming_content', 'streaming_content_path', ''], ['turns_json', 'turns_path', '[]']] as const
      : [['result', 'result_path', null]] as const;
    const id = table === 'subagent_records' ? 'id' : 'subagent_id';
    for (const [inline, side, empty] of columns) {
      const eligible = `${id} NOT IN (SELECT id FROM protected_subagents)
        AND (${side} IS NULL OR ${side} NOT IN (SELECT path FROM protected_paths))`;
      for (const row of database.prepare(`SELECT ${side} AS path FROM ${table} WHERE ${eligible} AND ${side} IS NOT NULL`).iterate()) {
        const value = (row as { path: string }).path;
        if (!isContentFilename(value)) throw new Error('Invalid cold content path');
      }
      database.prepare(`INSERT OR IGNORE INTO garbage SELECT ${side} FROM ${table} WHERE ${eligible} AND ${side} IS NOT NULL`).run();
      database.prepare(`UPDATE ${table} SET ${inline} = ?, ${side} = NULL WHERE ${eligible}`).run(empty);
    }
  }
}

function writeSnapshot(file: string, database: Database.Database, manifest: SnapshotManifest, ts: string): void {
  const fd = fs.openSync(file, 'wx');
  try {
    const hash = crypto.createHash('sha256');
    let rows = 0;
    const write = (event: object) => {
      const line = JSON.stringify(event) + '\n';
      writeAll(fd, line);
      hash.update(line);
    };
    write({ ts, op: 'snapshot.begin', data: manifest });
    for (const table of Object.keys(SNAPSHOT_COLUMNS) as SnapshotTable[]) {
      const order = table === 'agent_chat_events' ? 'agent_id, seq' : 'id';
      for (const row of database.prepare(`SELECT ${SNAPSHOT_COLUMNS[table]} FROM ${table} ORDER BY ${order}`).iterate()) {
        checkMaintenanceInterrupt();
        write({ ts, op: 'snapshot', data: { [table]: [row] } });
        rows++;
      }
    }
    writeAll(fd, JSON.stringify({ ts, op: 'snapshot.end', data: { rows, sha256: hash.digest('hex') } }) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Keep every published file below the same 25 MB budget as log segments.
 * Immutable chunks are durable before the small root index is published.
 */
function shardSnapshot(file: string, logRoot: string, manifest: SnapshotManifest, ts: string, newChunks: string[]): void {
  if (fs.statSync(file).size <= MAX_SEGMENT_BYTES) return;
  const directory = path.join(logRoot, 'snapshots');
  fs.mkdirSync(directory, { recursive: true });
  const indexPath = `${file}.index`;
  const indexFd = fs.openSync(indexPath, 'wx');
  let chunkFd: number | undefined;
  let chunkTemp: string | undefined;
  let chunkHash = crypto.createHash('sha256');
  let chunkBytes = 0;
  let chunks = 0;
  let ready = false;
  const indexHash = crypto.createHash('sha256');
  const writeIndex = (event: object) => {
    const line = JSON.stringify(event) + '\n';
    writeAll(indexFd, line);
    indexHash.update(line);
  };
  const finishChunk = () => {
    if (chunkFd === undefined || !chunkTemp) return;
    fs.fsyncSync(chunkFd);
    fs.closeSync(chunkFd);
    chunkFd = undefined;
    const sha256 = chunkHash.digest('hex');
    const chunk: SnapshotChunk = { path: `snapshots/${sha256}.jsonl`, bytes: chunkBytes, sha256 };
    const target = path.join(logRoot, chunk.path);
    if (fs.existsSync(target)) {
      resolveSnapshotChunk(logRoot, chunk);
      fs.unlinkSync(chunkTemp);
    } else {
      fs.renameSync(chunkTemp, target);
      newChunks.push(target);
    }
    chunkTemp = undefined;
    writeIndex({ ts, op: 'snapshot.chunk', data: chunk });
    chunks++;
  };
  try {
    writeIndex({ ts, op: 'snapshot.begin', data: { ...manifest, chunked: true } });
    for (const input of readLines(file)) {
      if (JSON.parse(input.text).op !== 'snapshot') continue;
      const line = input.text + '\n';
      const bytes = Buffer.byteLength(line);
      if (bytes > MAX_SEGMENT_BYTES) throw new Error('A durable snapshot row exceeds the syncable file-size budget');
      if (chunkBytes + bytes > MAX_SEGMENT_BYTES) finishChunk();
      if (chunkFd === undefined) {
        chunkTemp = path.join(directory, `.chunk-${process.pid}-${crypto.randomUUID()}`);
        chunkFd = fs.openSync(chunkTemp, 'wx');
        chunkHash = crypto.createHash('sha256');
        chunkBytes = 0;
      }
      writeAll(chunkFd, line);
      chunkHash.update(line);
      chunkBytes += bytes;
    }
    finishChunk();
    writeAll(indexFd, JSON.stringify({ ts, op: 'snapshot.end', data: { rows: chunks, sha256: indexHash.digest('hex') } }) + '\n');
    fs.fsyncSync(indexFd);
    if (fs.fstatSync(indexFd).size > MAX_SEGMENT_BYTES) throw new Error('Snapshot metadata exceeds the syncable file-size budget');
    syncDirectory(directory);
    syncDirectory(logRoot);
    ready = true;
  } finally {
    if (chunkFd !== undefined) fs.closeSync(chunkFd);
    if (chunkTemp && fs.existsSync(chunkTemp)) fs.unlinkSync(chunkTemp);
    fs.closeSync(indexFd);
    if (!ready && fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
  }
  try {
    fs.renameSync(indexPath, file);
  } finally {
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
  }
}

function assertInputsUnchanged(logRoot: string, inputs: Array<{ file: string; bytes: number; hash: string }>): void {
  const current = [...listLogFiles(logRoot), ...snapshotChunkFiles(logRoot)];
  if (current.length !== inputs.length || inputs.some((input, i) =>
    current[i] !== input.file || fs.statSync(input.file).size !== input.bytes || hashFile(input.file) !== input.hash)) {
    throw new Error('Log changed during compaction; retry after sync/writes finish');
  }
}

function pruneEmptyBuckets(logRoot: string): void {
  for (const entry of fs.readdirSync(logRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}$/.test(entry.name)) continue;
    const dir = path.join(logRoot, entry.name);
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch (err) {
      if (!['ENOENT', 'ENOTEMPTY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
    }
  }
  syncDirectory(logRoot);
}

function acquireLock(logRoot: string): boolean {
  const target = path.join(logRoot, LOCK_FILENAME);
  try {
    const fd = fs.openSync(target, 'wx');
    try { writeAll(fd, `${process.pid} ${Date.now()}`); } finally { fs.closeSync(fd); }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.warn('[compaction] Lock acquisition failed:', err);
      return false;
    }
  }
  try {
    if (Date.now() - fs.statSync(target).mtimeMs <= LOCK_STALE_MS) return false;
    const pid = Number(fs.readFileSync(target, 'utf8').split(' ')[0]);
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') return false;
      }
    }
    fs.unlinkSync(target);
    return acquireLock(logRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[compaction] Lock reclaim failed:', err);
    return false;
  }
}

function releaseLock(logRoot: string): void {
  try { fs.unlinkSync(path.join(logRoot, LOCK_FILENAME)); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[compaction] Lock release failed:', err);
  }
}

export { LOG_ROOT_DIRNAME };
