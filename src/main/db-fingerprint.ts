/**
 * DB fingerprint sidecar — skip the rebuild-from-log when nothing changed.
 *
 * The SQLite cache at `<whim>/spaces.db` is a derived view of the rotated
 * event log under `<whim>/events/`. Rebuilding it on every startup
 * (delete + replay every event) dominates cold-start time once a heavy
 * user has accumulated thousands of events.
 *
 * This module records, after each successful rebuild, a fingerprint of
 * the inputs:
 *   • Schema version of the materialised DB.
 *   • Size + mtime + sha256 of every log file the replay consumed.
 *   • Size + mtime of the DB file itself (so external tampering forces a
 *     rebuild instead of silently trusting the old data).
 *
 * On the next startup, if the on-disk fingerprint still matches the
 * current state of those files, we open the existing DB directly. If
 * anything moved (new events appended, a new segment rolled, schema
 * bumped, DB file replaced), we fall back to the safe path: delete the
 * DB and replay.
 *
 * Sha256 is only recomputed for files whose size or mtime differ from
 * the previous fingerprint — the steady-state fast path is stat-only.
 */
import * as fs from 'fs';
import * as path from 'path';
import { listLogFiles } from './log-store';
import { hashFile, snapshotChunkFiles } from './persistence-snapshot';

/** Bump this when the DB schema in initDatabase changes. Mismatches force a rebuild. */
export const SCHEMA_VERSION = 6;

/** Sibling filename next to spaces.db. */
export const FINGERPRINT_FILENAME = 'db.fingerprint.json';

export interface LogFileFingerprint {
  /** Absolute path so reads/writes are unambiguous. */
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface DbFileFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface Fingerprint {
  schemaVersion: number;
  /** Wall-clock ts of the last successful build, mostly for diagnostics. */
  createdAt: string;
  logFiles: LogFileFingerprint[];
  db?: DbFileFingerprint;
}

/** Convenience: full path to the sidecar given the workspace's .whim dir. */
export function fingerprintPathFor(dbPath: string): string {
  return path.join(path.dirname(dbPath), FINGERPRINT_FILENAME);
}

/** Read + parse the sidecar, returning null on missing or corrupt data. */
export function readFingerprint(sidecarPath: string): Fingerprint | null {
  if (!fs.existsSync(sidecarPath)) return null;
  try {
    const text = fs.readFileSync(sidecarPath, 'utf-8');
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!Number.isSafeInteger(parsed.schemaVersion)) return null;
    if (!Array.isArray(parsed.logFiles)) return null;
    const validStat = (entry: unknown): entry is DbFileFingerprint => {
      if (!entry || typeof entry !== 'object') return false;
      const stat = entry as Partial<DbFileFingerprint>;
      return typeof stat.path === 'string' && typeof stat.size === 'number' &&
        Number.isSafeInteger(stat.size) && stat.size >= 0 &&
        typeof stat.mtimeMs === 'number' && Number.isFinite(stat.mtimeMs);
    };
    if (parsed.logFiles.some((entry: unknown) => !validStat(entry) ||
        typeof (entry as LogFileFingerprint).sha256 !== 'string')) return null;
    if (parsed.db !== undefined && !validStat(parsed.db)) return null;
    if (new Set(parsed.logFiles.map((entry: LogFileFingerprint) => entry.path)).size !== parsed.logFiles.length) return null;
    return parsed as Fingerprint;
  } catch {
    return null;
  }
}

/** Atomic write — temp file + rename, so a partial write can't poison a future startup. */
export function writeFingerprint(sidecarPath: string, fp: Fingerprint): void {
  const tmp = `${sidecarPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(fp), 'utf-8');
    fs.renameSync(tmp, sidecarPath);
  } catch (err) {
    console.warn('[db-fingerprint] Failed to write sidecar:', err);
    try { fs.unlinkSync(tmp); } catch { /* may not exist */ }
  }
}

/**
 * Compute the current fingerprint for `logRoot`. When `previous` is
 * provided, file hashes are reused for any file whose size+mtime match
 * the previous entry — this is the steady-state cheap path.
 *
 * Includes the DB file's stat (when present) so external tampering with
 * spaces.db forces a rebuild.
 */
export function computeFingerprint(
  logRoot: string,
  dbPath: string,
  previous?: Fingerprint | null,
): Fingerprint {
  const previousByPath = new Map<string, LogFileFingerprint>();
  if (previous) {
    for (const entry of previous.logFiles) {
      previousByPath.set(entry.path, entry);
    }
  }

  const logFiles: LogFileFingerprint[] = [];
  for (const file of [...listLogFiles(logRoot), ...snapshotChunkFiles(logRoot)]) {
    const { size, mtimeMs } = fs.statSync(file);

    const prev = previousByPath.get(file);
    let sha256: string;
    if (prev && prev.size === size && prev.mtimeMs === mtimeMs) {
      sha256 = prev.sha256;
    } else {
      sha256 = hashFile(file, size);
    }
    logFiles.push({ path: file, size, mtimeMs, sha256 });
  }

  let db: DbFileFingerprint | undefined;
  try {
    const stat = fs.statSync(dbPath);
    db = { path: dbPath, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    db = undefined;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    logFiles,
    db,
  };
}

/**
 * Decide whether the cached DB can be reused. Returns true only when:
 *   • The sidecar exists and parses.
 *   • Schema versions match.
 *   • The DB file still exists with the same size + mtime as recorded.
 *   • Every log file (and only those log files) matches by size + mtime.
 *
 * Hashes must also agree. computeFingerprint reuses hashes when the OS
 * reports unchanged size+mtime; this remains a stat-based cache, not a
 * defense against modifications that deliberately preserve those metadata.
 */
export function canSkipReplay(
  previous: Fingerprint | null,
  current: Fingerprint,
): boolean {
  if (!previous) return false;
  if (previous.schemaVersion !== current.schemaVersion) return false;

  // DB file must exist and look identical to what we recorded.
  if (!previous.db || !current.db) return false;
  if (previous.db.size !== current.db.size) return false;
  if (previous.db.mtimeMs !== current.db.mtimeMs) return false;
  if (previous.db.path !== current.db.path) return false;

  return sameLogState(previous, current);
}

/** Compare observed log inputs, independently of the derived database's mtime. */
export function sameLogState(previous: Fingerprint, current: Fingerprint): boolean {
  if (previous.logFiles.length !== current.logFiles.length) return false;

  // Cheap path: index previous entries by path.
  const prevByPath = new Map(previous.logFiles.map((e) => [e.path, e]));
  for (const entry of current.logFiles) {
    const prev = prevByPath.get(entry.path);
    if (!prev) return false;
    if (prev.size !== entry.size) return false;
    if (prev.mtimeMs !== entry.mtimeMs) return false;
    if (prev.sha256 !== entry.sha256) return false;
  }
  return true;
}
