/**
 * Canvas artifact store — durable, session-independent output artifacts.
 *
 * An artifact is a self-contained HTML document produced by an agent run and
 * stored inside the owning space folder:
 *
 *   {spaceFolder}/.whim/canvases/{artifactId}/
 *     manifest.json   metadata (title, status, binding, hash)
 *     index.html      the published artifact
 *     data.json       optional structured payload
 *
 * Disk is the source of truth. Nothing here writes to the event log or the
 * SQLite projection — artifacts are discovered by scanning space folders, so
 * they survive a cold DB rebuild, a git sync, or a workspace move.
 *
 * This module is deliberately free of Electron and SDK imports so it can be
 * unit tested directly.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { resolveSpaceFolder } from '../workspace';

export const CANVASES_DIR = path.join('.whim', 'canvases');
export const ARTIFACT_FILE = 'index.html';
export const ARTIFACT_DATA_FILE = 'data.json';
export const MANIFEST_FILE = 'manifest.json';

/** Hard ceiling on a published artifact. Agent-authored HTML is untrusted input. */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
/** Hard ceiling on the optional structured payload. */
export const MAX_DATA_BYTES = 1 * 1024 * 1024;

const ARTIFACT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface CanvasArtifactManifest {
  artifactId: string;
  spaceId: string;
  title: string;
  status?: string;
  skillId?: string;
  /** Run that most recently published this artifact. */
  runId?: string;
  /** SDK canvas instance bound to this artifact, for idempotent re-opens. */
  instanceId?: string;
  canvasId?: string;
  contentHash?: string;
  contentBytes?: number;
  hasData?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Set on the first successful publish; absent while an artifact is only bound. */
  publishedAt?: string;
}

export interface CanvasArtifact extends CanvasArtifactManifest {
  /** Absolute path to the artifact directory. */
  dir: string;
  /** Absolute path to index.html, whether or not it exists yet. */
  htmlPath: string;
  /** Whether index.html is present on disk. */
  published: boolean;
}

export class CanvasArtifactError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CanvasArtifactError';
  }
}

export function isValidArtifactId(id: string): boolean {
  return typeof id === 'string' && ARTIFACT_ID_RE.test(id);
}

/** Derive a stable, filesystem-safe artifact id from arbitrary text. */
export function toArtifactId(text: string, fallback = 'report'): string {
  const slug = (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return isValidArtifactId(slug) ? slug : fallback;
}

/** Root directory holding every artifact for a space. */
export function getArtifactsRoot(workspaceRoot: string, folder: string): string {
  return path.join(resolveSpaceFolder(workspaceRoot, folder), CANVASES_DIR);
}

/**
 * Resolve an artifact directory, rejecting ids that could escape the space.
 * Validation is on the id itself rather than on the joined path, so traversal
 * is impossible by construction rather than by string comparison.
 */
export function resolveArtifactDir(workspaceRoot: string, folder: string, artifactId: string): string {
  if (!isValidArtifactId(artifactId)) {
    throw new CanvasArtifactError('invalid_artifact_id', `Invalid artifact id: ${artifactId}`);
  }
  return path.join(getArtifactsRoot(workspaceRoot, folder), artifactId);
}

/**
 * Resolve an agent-supplied relative path against the space folder, following
 * symlinks and rejecting anything that lands outside. Lexical checks alone are
 * not enough: a symlink inside the space can point anywhere on disk.
 */
export function resolveInsideSpace(workspaceRoot: string, folder: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new CanvasArtifactError('invalid_path', 'A relative path is required');
  }
  if (path.isAbsolute(relativePath)) {
    throw new CanvasArtifactError('invalid_path', 'Path must be relative to the space folder');
  }

  const spaceRoot = resolveSpaceFolder(workspaceRoot, folder);
  const candidate = path.resolve(spaceRoot, relativePath);
  const realRoot = realpathOrSelf(spaceRoot);
  const realCandidate = realpathOrSelf(candidate);

  if (!isInside(realRoot, realCandidate)) {
    throw new CanvasArtifactError('path_escape', 'Path resolves outside the space folder');
  }
  return candidate;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // Not yet created — fall back to the nearest existing ancestor so a path
    // under a symlinked parent is still caught.
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realpathOrSelf(parent), path.basename(p));
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function hashContent(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ── Manifest IO ──────────────────────────────────────────

export function readManifest(dir: string): CanvasArtifactManifest | null {
  try {
    const raw = fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as CanvasArtifactManifest;
    if (!parsed || typeof parsed.artifactId !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write the manifest atomically so a crash cannot leave a truncated file. */
function writeManifest(dir: string, manifest: CanvasArtifactManifest): void {
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
}

function writeFileAtomic(target: string, content: string | Buffer): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

function toArtifact(dir: string, manifest: CanvasArtifactManifest): CanvasArtifact {
  const htmlPath = path.join(dir, ARTIFACT_FILE);
  return { ...manifest, dir, htmlPath, published: fs.existsSync(htmlPath) };
}

// ── Write serialization ──────────────────────────────────

/**
 * Serialize mutations per artifact directory. A manual run and a scheduled run
 * can target the same artifact; without this, two read-modify-write cycles can
 * interleave and lose a field.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function withArtifactLock<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const key = path.resolve(dir);
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  // Store a never-rejecting tail so one failure cannot poison later writes.
  writeQueues.set(key, next.then(() => undefined, () => undefined));
  return next;
}

// ── Public operations ────────────────────────────────────

export interface BindArtifactInput {
  workspaceRoot: string;
  folder: string;
  spaceId: string;
  artifactId: string;
  title: string;
  instanceId?: string;
  canvasId?: string;
  skillId?: string;
}

/**
 * Create or update an artifact's binding without publishing content.
 *
 * The runtime re-issues `canvas.open` whenever a provider reconnects, so this
 * must be idempotent: repeated calls for the same instance return the existing
 * artifact untouched rather than resetting its content or timestamps.
 */
export function bindArtifact(input: BindArtifactInput): Promise<CanvasArtifact> {
  const dir = resolveArtifactDir(input.workspaceRoot, input.folder, input.artifactId);
  return withArtifactLock(dir, () => {
    const now = new Date().toISOString();
    const existing = readManifest(dir);

    const manifest: CanvasArtifactManifest = existing
      ? {
          ...existing,
          // Binding metadata may legitimately change on reconnect; content
          // metadata (hash, publishedAt) is owned by publishArtifact.
          title: existing.title || input.title,
          instanceId: input.instanceId ?? existing.instanceId,
          canvasId: input.canvasId ?? existing.canvasId,
          skillId: input.skillId ?? existing.skillId,
          updatedAt: now,
        }
      : {
          artifactId: input.artifactId,
          spaceId: input.spaceId,
          title: input.title,
          ...(input.instanceId ? { instanceId: input.instanceId } : {}),
          ...(input.canvasId ? { canvasId: input.canvasId } : {}),
          ...(input.skillId ? { skillId: input.skillId } : {}),
          createdAt: now,
          updatedAt: now,
        };

    writeManifest(dir, manifest);
    return toArtifact(dir, manifest);
  });
}

export interface PublishArtifactInput {
  workspaceRoot: string;
  folder: string;
  spaceId: string;
  artifactId: string;
  title: string;
  status?: string;
  runId?: string;
  skillId?: string;
  /**
   * Path to the agent-written HTML, relative to the space folder. The agent
   * writes the file with its normal file tools; we only import it. Passing whole
   * documents through the canvas RPC would persist them in the runtime's durable
   * session events and replay them on every reconnect.
   */
  sourceRelativePath: string;
  /** Optional structured payload, also relative to the space folder. */
  dataRelativePath?: string;
  /** Optional sha256 of the HTML, verified before publishing. */
  contentHash?: string;
}

export interface PublishArtifactResult {
  artifact: CanvasArtifact;
  /** True when the published bytes differ from what was already stored. */
  changed: boolean;
}

/** Import an agent-written file as the artifact's current content. */
export function publishArtifact(input: PublishArtifactInput): Promise<PublishArtifactResult> {
  const dir = resolveArtifactDir(input.workspaceRoot, input.folder, input.artifactId);
  return withArtifactLock(dir, () => {
    const sourcePath = resolveInsideSpace(input.workspaceRoot, input.folder, input.sourceRelativePath);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new CanvasArtifactError('source_missing', `No artifact file at ${input.sourceRelativePath}`);
    }

    const bytes = fs.readFileSync(sourcePath);
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new CanvasArtifactError(
        'too_large',
        `Artifact is ${bytes.byteLength} bytes, over the ${MAX_ARTIFACT_BYTES} byte limit`,
      );
    }

    const contentHash = hashContent(bytes);
    if (input.contentHash && input.contentHash !== contentHash) {
      throw new CanvasArtifactError('hash_mismatch', 'Artifact content hash does not match');
    }

    let hasData = false;
    let dataBytes: Buffer | null = null;
    if (input.dataRelativePath) {
      const dataPath = resolveInsideSpace(input.workspaceRoot, input.folder, input.dataRelativePath);
      if (fs.existsSync(dataPath) && fs.statSync(dataPath).isFile()) {
        dataBytes = fs.readFileSync(dataPath);
        if (dataBytes.byteLength > MAX_DATA_BYTES) {
          throw new CanvasArtifactError(
            'data_too_large',
            `Artifact data is ${dataBytes.byteLength} bytes, over the ${MAX_DATA_BYTES} byte limit`,
          );
        }
        hasData = true;
      }
    }

    const existing = readManifest(dir);
    const changed = existing?.contentHash !== contentHash;
    const now = new Date().toISOString();

    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, ARTIFACT_FILE);
    // Publishing into the artifact's own directory would be a no-op copy when
    // the agent wrote straight there; skip it so we never truncate the source.
    if (path.resolve(sourcePath) !== path.resolve(target)) {
      writeFileAtomic(target, bytes);
    }
    if (dataBytes) writeFileAtomic(path.join(dir, ARTIFACT_DATA_FILE), dataBytes);

    const manifest: CanvasArtifactManifest = {
      ...(existing ?? {
        artifactId: input.artifactId,
        spaceId: input.spaceId,
        title: input.title,
        createdAt: now,
      }),
      artifactId: input.artifactId,
      spaceId: input.spaceId,
      title: input.title || existing?.title || input.artifactId,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.skillId ? { skillId: input.skillId } : existing?.skillId ? { skillId: existing.skillId } : {}),
      contentHash,
      contentBytes: bytes.byteLength,
      hasData: hasData || existing?.hasData === true,
      updatedAt: now,
      publishedAt: now,
    };

    writeManifest(dir, manifest);
    return { artifact: toArtifact(dir, manifest), changed };
  });
}

export interface SetArtifactStatusInput {
  workspaceRoot: string;
  folder: string;
  artifactId: string;
  status: string;
  title?: string;
}

/** Update the status line (and optionally title) without republishing content. */
export function setArtifactStatus(input: SetArtifactStatusInput): Promise<CanvasArtifact | null> {
  const dir = resolveArtifactDir(input.workspaceRoot, input.folder, input.artifactId);
  return withArtifactLock(dir, () => {
    const existing = readManifest(dir);
    if (!existing) return null;
    const manifest: CanvasArtifactManifest = {
      ...existing,
      status: input.status,
      ...(input.title ? { title: input.title } : {}),
      updatedAt: new Date().toISOString(),
    };
    writeManifest(dir, manifest);
    return toArtifact(dir, manifest);
  });
}

/** Read a single artifact, or null when it is unknown or its manifest is unreadable. */
export function getArtifact(workspaceRoot: string, folder: string, artifactId: string): CanvasArtifact | null {
  let dir: string;
  try {
    dir = resolveArtifactDir(workspaceRoot, folder, artifactId);
  } catch {
    return null;
  }
  const manifest = readManifest(dir);
  if (!manifest) return null;
  return toArtifact(dir, manifest);
}

/**
 * List a space's artifacts, newest first.
 *
 * Directories without a readable manifest are skipped rather than repaired:
 * disk is authoritative, so a half-written artifact simply does not exist yet.
 */
export function listArtifacts(workspaceRoot: string, folder: string): CanvasArtifact[] {
  const root = getArtifactsRoot(workspaceRoot, folder);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const artifacts: CanvasArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidArtifactId(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const manifest = readManifest(dir);
    if (!manifest) continue;
    artifacts.push(toArtifact(dir, manifest));
  }

  return artifacts.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** The artifact an "open the canvas for this space" action should target. */
export function getPrimaryArtifact(workspaceRoot: string, folder: string): CanvasArtifact | null {
  const published = listArtifacts(workspaceRoot, folder).filter(a => a.published);
  return published[0] ?? null;
}

/** Find the artifact already bound to an SDK canvas instance, if any. */
export function findArtifactByInstance(
  workspaceRoot: string,
  folder: string,
  instanceId: string,
): CanvasArtifact | null {
  return listArtifacts(workspaceRoot, folder).find(a => a.instanceId === instanceId) ?? null;
}

/** Remove an artifact directory entirely. */
export function deleteArtifact(workspaceRoot: string, folder: string, artifactId: string): Promise<boolean> {
  const dir = resolveArtifactDir(workspaceRoot, folder, artifactId);
  return withArtifactLock(dir, () => {
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  });
}
