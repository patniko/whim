import * as fs from 'fs';
import { checkMaintenanceInterrupt } from './maintenance-interrupt';
import * as path from 'path';
import * as crypto from 'crypto';
import { MAX_SEGMENT_BYTES, SNAPSHOT_FILENAME } from './log-store';

export interface SnapshotChunk {
  path: string;
  bytes: number;
  sha256: string;
}

export interface CoveredSegment {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SnapshotManifest {
  version: 1;
  covered: CoveredSegment[];
  garbage: string[];
  chunked?: true;
}

/** Memory is bounded by a single JSONL record, including for legacy large snapshots. */
export function* readLines(file: string, start = 0): Generator<{ text: string; number: number; terminated: boolean }> {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = start;
    let number = 1;
    let parts: Buffer[] = [];
    let bytes: number;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) {
      checkMaintenanceInterrupt();
      position += bytes;
      let from = 0;
      for (let i = 0; i < bytes; i++) {
        if (buffer[i] !== 10) continue;
        parts.push(Buffer.from(buffer.subarray(from, i)));
        yield { text: Buffer.concat(parts).toString('utf8'), number: number++, terminated: true };
        parts = [];
        from = i + 1;
      }
      if (from < bytes) parts.push(Buffer.from(buffer.subarray(from, bytes)));
    }
    if (parts.length) yield { text: Buffer.concat(parts).toString('utf8'), number, terminated: false };
  } finally {
    fs.closeSync(fd);
  }
}

export function hashFile(file: string, bytes = fs.statSync(file).size): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const hash = crypto.createHash('sha256');
    let position = 0;
    while (position < bytes) {
      checkMaintenanceInterrupt();
      const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, bytes - position), position);
      if (!read) throw new Error(`Log changed while hashing: ${file}`);
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

export function parseManifest(value: unknown): SnapshotManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid snapshot manifest');
  const manifest = value as Partial<SnapshotManifest>;
  if (manifest.version !== 1 || !Array.isArray(manifest.covered) || !Array.isArray(manifest.garbage)) {
    throw new Error('Unsupported snapshot manifest');
  }
  if (Object.keys(manifest).some(key => !['version', 'covered', 'garbage', 'chunked'].includes(key)) ||
      (manifest.chunked !== undefined && manifest.chunked !== true)) {
    throw new Error('Unsupported snapshot manifest field');
  }
  const seen = new Set<string>();
  for (const entry of manifest.covered) {
    if (!entry || typeof entry.path !== 'string' ||
        !/^\d{4}-\d{2}\/events-\d+\.jsonl$/.test(entry.path) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
        typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        seen.has(entry.path)) {
      throw new Error('Invalid covered segment in snapshot');
    }
    seen.add(entry.path);
  }
  if (manifest.garbage.some((entry) => typeof entry !== 'string' || !isContentFilename(entry))) {
    throw new Error('Invalid snapshot garbage path');
  }
  return { version: 1, covered: manifest.covered, garbage: manifest.garbage, ...(manifest.chunked ? { chunked: true } : {}) };
}

export function readSnapshotManifest(logRoot: string): SnapshotManifest {
  const file = path.join(logRoot, SNAPSHOT_FILENAME);
  if (fs.existsSync(file)) {
    for (const line of readLines(file)) {
      if (!line.text.trim()) continue;
      let event;
      try {
        event = JSON.parse(line.text);
      } catch {
        throw new Error(`Corrupt event log at ${file}:${line.number}`);
      }
      if (event.op === 'snapshot.begin') return parseManifest(event.data);
      break; // Legacy single-event snapshots have no coverage manifest.
    }
  }
  return { version: 1, covered: [], garbage: [] };
}

export function parseSnapshotChunk(value: unknown): SnapshotChunk {
  if (!value || typeof value !== 'object') throw new Error('Invalid snapshot chunk');
  const chunk = value as Partial<SnapshotChunk>;
  if (typeof chunk.path !== 'string' || typeof chunk.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(chunk.sha256) || chunk.path !== `snapshots/${chunk.sha256}.jsonl` ||
      typeof chunk.bytes !== 'number' || !Number.isSafeInteger(chunk.bytes) ||
      chunk.bytes <= 0 || chunk.bytes > MAX_SEGMENT_BYTES ||
      Object.keys(chunk).some(key => !['path', 'bytes', 'sha256'].includes(key))) {
    throw new Error('Invalid snapshot chunk');
  }
  return { path: chunk.path, bytes: chunk.bytes, sha256: chunk.sha256 };
}

export function resolveSnapshotChunk(logRoot: string, value: unknown): string {
  const chunk = parseSnapshotChunk(value);
  const file = path.join(logRoot, chunk.path);
  if (fs.statSync(file).size !== chunk.bytes || hashFile(file) !== chunk.sha256) {
    throw new Error(`Corrupt snapshot chunk: ${file}`);
  }
  return file;
}

/** Referenced immutable chunks are replay inputs, but are not append-only log segments. */
export function snapshotChunkFiles(logRoot: string): string[] {
  if (!readSnapshotManifest(logRoot).chunked) return [];
  const root = path.join(logRoot, SNAPSHOT_FILENAME);
  const files = new Set<string>();
  if (fs.existsSync(root)) {
    for (const line of readLines(root)) {
      if (!line.text.trim()) continue;
      const event = JSON.parse(line.text);
      if (event.op === 'snapshot.chunk') {
        files.add(path.join(logRoot, parseSnapshotChunk(event.data).path));
      }
    }
  }
  return [...files];
}

export function segmentCoverage(logRoot: string, file: string): CoveredSegment {
  const bytes = fs.statSync(file).size;
  return { path: path.relative(logRoot, file).split(path.sep).join('/'), bytes, sha256: hashFile(file, bytes) };
}

/** A synced/modified prefix is a conflict, never permission to silently discard events. */
export function coveredOffset(file: string, entry?: CoveredSegment): number {
  if (!entry) return 0;
  if (fs.statSync(file).size < entry.bytes || hashFile(file, entry.bytes) !== entry.sha256) {
    throw new Error(`Covered segment conflicts with snapshot: ${file}`);
  }
  if (entry.bytes > 0) {
    const fd = fs.openSync(file, 'r');
    try {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, entry.bytes - 1);
      if (last[0] !== 10) throw new Error(`Covered segment has an incomplete final line: ${file}`);
    } finally {
      fs.closeSync(fd);
    }
  }
  return entry.bytes;
}

export function isContentFilename(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && /^[A-Za-z0-9._-]+$/.test(value);
}

export function writeAll(fd: number, text: string | Buffer): void {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!written) throw new Error('Incomplete persistence write');
    offset += written;
  }
}

/** Windows does not expose directory fsync through Node. File fsync still precedes rename. */
export function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
