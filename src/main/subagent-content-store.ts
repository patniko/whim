/**
 * Side-file content store for heavy sub-agent payloads.
 *
 * Big strings (assistant turn content, tool-call results) used to be stored
 * inline inside every `subagent.updated` / `subagent_tool.updated` event.
 * A single completed sub-agent could carry multiple MB of text into the
 * append-only event log, which dominated `events.jsonl` growth.
 *
 * This module moves anything larger than {@link INLINE_THRESHOLD} bytes
 * into a side file under `<workspace>/.whim/subagent-content/`. The event
 * log + SQLite cache then only need to remember a stable relative path and
 * a small digest. Callers that want the full text (e.g. the renderer's
 * subagent detail overlay) read the side file on demand.
 *
 * Side files are tracked in git so multi-client sync still has the full
 * fidelity available; compaction (Phase 4) is responsible for pruning the
 * ones whose parent sub-agent has aged out of the keep window.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { isContentFilename, syncDirectory, writeAll } from './persistence-snapshot';

/** Content shorter than this many UTF-8 bytes stays inline in the event log. */
export const INLINE_THRESHOLD = 4096;

/** Cheap summary that lets us reason about content even when the side file is gone. */
export interface ContentDigest {
  length: number;
  sha256: string;
  /** First 256 chars — useful for previews. */
  head: string;
  /** Last 256 chars when length > 256; empty otherwise. */
  tail: string;
}

/**
 * Either inline content (small) or a relative path to a side file (big).
 * `digest` is always populated so the UI can show a preview without a
 * disk read.
 */
export interface ContentRef {
  /** Relative to the content dir; set when content is in a side file. */
  path?: string;
  /** Full content when small; undefined when `path` is set. */
  inline?: string;
  digest: ContentDigest;
}

let contentDir: string | null = null;

/**
 * Initialise the side-file store. Call once after the workspace path is
 * known and before any subagent persistence happens.
 *
 * Creates `<dir>` if missing. Safe to call multiple times for the same
 * workspace (idempotent).
 */
export function initContentStore(dir: string): void {
  contentDir = dir;
  try {
    fs.mkdirSync(contentDir, { recursive: true });
  } catch (err) {
    // Non-fatal: storeContent will fall back to inline if the dir is unwritable.
    console.warn('[content-store] Failed to ensure content dir:', err);
  }
}

/** Tear down state when the workspace is closed. */
export function closeContentStore(): void {
  contentDir = null;
}

/** Return the active content directory (or null if uninitialised). */
export function getContentDir(): string | null {
  return contentDir;
}

/** Compute a stable digest for a piece of content. Pure / synchronous. */
export function makeDigest(content: string): ContentDigest {
  const length = content.length;
  const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  const head = content.slice(0, 256);
  const tail = length > 256 ? content.slice(-256) : '';
  return { length, sha256, head, tail };
}

/**
 * Materialise `content` keyed by `key`. Returns a {@link ContentRef}:
 *   • `inline` set when content ≤ {@link INLINE_THRESHOLD} bytes (no disk write).
 *   • `path` set when content was written to a side file.
 *
 * New paths include the content hash, leaving earlier logged versions intact.
 * Writes use fsync + atomic rename before a path is returned to a log writer.
 * A write failure falls back to inline so callers never lose data.
 */
export function storeContent(key: string, content: string): ContentRef {
  const digest = makeDigest(content);
  if (Buffer.byteLength(content, 'utf8') <= INLINE_THRESHOLD || !contentDir) {
    return { inline: content, digest };
  }
  // Never overwrite content referenced by an earlier durable event. A crash
  // between this write and the log append must leave the old version intact.
  const relPath = `${sanitizeKey(key).slice(0, 130)}.${digest.sha256}`;
  const fullPath = path.join(contentDir, relPath);
  const tmpPath = `${fullPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fd = fs.openSync(tmpPath, 'wx');
    try {
      writeAll(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, fullPath);
    syncDirectory(contentDir);
    return { path: relPath, digest };
  } catch (err) {
    console.warn(`[content-store] Failed to write side file ${relPath}, falling back to inline:`, err);
    try { fs.unlinkSync(tmpPath); } catch { /* tmp may not exist */ }
    return { inline: content, digest };
  }
}

/**
 * Read a previously-stored side file. Returns `null` when the file is
 * missing (e.g. compacted, never synced, or store not initialised).
 * Callers should treat null as "full content unavailable" and fall back
 * to the digest preview.
 */
export function readContent(relPath: string): string | null {
  if (!contentDir) return null;
  if (!isContentFilename(relPath)) throw new Error('Invalid content path');
  try {
    return fs.readFileSync(path.join(contentDir, relPath), 'utf8');
  } catch {
    return null;
  }
}

/** Remove a side file. Used by compaction. No-op if the file is missing. */
export function deleteContent(relPath: string): void {
  if (!contentDir) return;
  if (!isContentFilename(relPath)) throw new Error('Invalid content path');
  try {
    fs.unlinkSync(path.join(contentDir, relPath));
    syncDirectory(contentDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Resolve a {@link ContentRef} (from event log or DB columns) back to its
 * full text. When `path` is set, the side file is authoritative — this is
 * the normal case for off-loaded content, where the DB's inline column
 * holds the empty string only as a sentinel. Falls back to `inline` when
 * no path is set (small content), and finally to the empty string.
 */
export function resolveContent(ref: { path?: string | null; inline?: string | null }): string {
  if (ref.path) {
    const text = readContent(ref.path);
    if (text != null) return text;
  }
  if (ref.inline != null) return ref.inline;
  return '';
}

/**
 * Conservative filename sanitiser. Keeps alphanumerics + `._-`, replaces
 * everything else with `_`, and caps at 200 chars to stay well under
 * common filesystem limits. Keys are produced by us (sub-agent IDs, tool
 * call IDs), so collisions after sanitisation are extremely unlikely.
 */
function sanitizeKey(key: string): string {
  const sanitized = key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  if (!isContentFilename(sanitized)) throw new Error('Invalid content key');
  return sanitized;
}
