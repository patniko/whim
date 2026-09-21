import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile, spawn } from 'child_process';
import type { GitSyncStatus } from '../shared/ipc-contract';
import { notifyAllWindows } from './notify';
import { getLogRoot as getLogRootForWhim, migrateLegacyEventLog } from './log-store';
import { ensureMarkdownH1Title } from '../shared/markdown-title';
import { GitQueue } from './git-queue';
import { startTiming } from '../shared/performance';

const WHIM_DIR = '.whim';
const DB_FILE = 'spaces.db';

const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export function getWhimDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, WHIM_DIR);
}

/**
 * Root of the rotated event-log tree (`<workspace>/.whim/events/`).
 *
 * Replaces the legacy single `events.jsonl` file. All write/read code goes
 * through this root and lets `log-store.ts` decide which segment file to
 * touch.
 */
export function getLogRoot(workspaceRoot: string): string {
  return getLogRootForWhim(path.join(workspaceRoot, WHIM_DIR));
}

export function getDbPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, WHIM_DIR, DB_FILE);
}

/** Ensure the .whim/ directory and .gitignore entries exist in the workspace. */
export function initWorkspace(rootPath: string): void {
  const whimDir = getWhimDir(rootPath);

  if (!fs.existsSync(whimDir)) {
    fs.mkdirSync(whimDir, { recursive: true });
  }

  // Migrate the legacy single-file event log into the rotated tree. Safe
  // to call every launch — idempotent if the file is already gone.
  try {
    migrateLegacyEventLog(whimDir);
  } catch (err) {
    console.warn('[workspace] migrateLegacyEventLog failed:', err);
  }

  // Ensure .agents/skills/ directory exists
  const skillsDir = path.join(rootPath, '.agents', 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const gitignorePath = path.join(rootPath, '.gitignore');
  const requiredEntries = [
    '.whim/*.db',
    '.whim/*.db-journal',
    '.whim/*.db-wal',
    '.whim/*.db-shm',
    '*/attachments/',
    '*/uploads/',
    '*/.workspace/',
    '*/.whim/',
  ];

  let existing = '';
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, 'utf-8');
  }

  const missing = requiredEntries.filter(entry => !existing.includes(entry));
  if (missing.length > 0) {
    const nl = existing && !existing.endsWith('\n') ? '\n' : '';
    const addition = `${nl}# whim app local cache\n${missing.join('\n')}\n`;
    fs.appendFileSync(gitignorePath, addition);
  }
}

/** Generate a filesystem-safe slug from a description, with space ID suffix for uniqueness. */
export function slugify(text: string, spaceId: string): string {
  let slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (slug.length > 60) {
    slug = slug.substring(0, 60).replace(/-$/, '');
  }

  // Guard against Windows reserved names
  const firstSegment = slug.split('-')[0];
  if (RESERVED_NAMES.has(firstSegment)) {
    slug = 'space-' + slug;
  }

  const idSuffix = spaceId.replace(/-/g, '').substring(0, 4);
  return slug ? `${slug}-${idSuffix}` : idSuffix;
}

/**
 * Parse a repository "name" from a git remote URL. Handles https, scp-like ssh
 * (`git@host:owner/repo.git`), local paths, and a trailing `.git`.
 * Returns null when nothing usable can be extracted.
 *
 *   https://github.com/patniko/whim.git  -> "whim"
 *   git@github.com:patniko/whim.git      -> "whim"
 *   /Users/me/code/my-repo/              -> "my-repo"
 */
export function parseRepoNameFromRemote(url: string): string | null {
  if (!url) return null;
  let s = url.trim();
  if (!s) return null;
  s = s.replace(/\/+$/, '');      // drop trailing slashes
  s = s.replace(/\.git$/i, '');   // drop a trailing .git
  const segments = s.split(/[/:]/).filter(Boolean);
  const last = segments.pop();
  return last ? last : null;
}

const profileNameCache = new Map<string, string>();

/**
 * Resolve the default display name for a workspace profile: the git remote
 * repository name (`origin`) when available, otherwise the directory's
 * basename. Results are memoized per path for the life of the process.
 */
export async function getDefaultProfileName(dir: string): Promise<string> {
  const cached = profileNameCache.get(dir);
  if (cached) return cached;

  let name: string | null = null;
  try {
    const url = await runGitOutput(dir, ['remote', 'get-url', 'origin']);
    name = parseRepoNameFromRemote(url);
  } catch {
    // Not a git repo, or no `origin` remote — fall back to the folder name.
  }
  if (!name) {
    name = path.basename(dir.replace(/[/\\]+$/, '')) || dir;
  }
  profileNameCache.set(dir, name);
  return name;
}

/** Drop cached default names (all, or one path). */
export function invalidateProfileNameCache(dir?: string): void {
  if (dir) profileNameCache.delete(dir);
  else profileNameCache.clear();
}

/** Create a subfolder for a space inside the workspace. Returns the folder name (relative). */
export function createSpaceFolder(workspaceRoot: string, spaceId: string, description: string): string {
  const folder = slugify(description, spaceId);
  const folderPath = path.join(workspaceRoot, folder);

  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  return folder;
}

const CANVAS_FILE = 'canvas.md';
const ATTACHMENTS_DIR = 'uploads';

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB

/** Get the absolute path to a space's canvas file. */
export function getCanvasPath(workspaceRoot: string, folder: string): string {
  return path.join(workspaceRoot, folder, CANVAS_FILE);
}

/**
 * Resolve the actual folder root for a space, checking the archive
 * location if the primary doesn't exist (space was completed/archived).
 */
export function resolveSpaceFolder(workspaceRoot: string, folder: string): string {
  const primary = path.join(workspaceRoot, folder);
  if (fs.existsSync(primary)) return primary;

  const archived = path.join(workspaceRoot, WHIM_DIR, ARCHIVE_DIR, folder);
  if (fs.existsSync(archived)) return archived;

  return primary;
}

/** Read the canvas content for a space. Returns empty string if file doesn't exist. */
export function readCanvas(workspaceRoot: string, folder: string): string {
  const folderRoot = resolveSpaceFolder(workspaceRoot, folder);
  const canvasPath = path.join(folderRoot, CANVAS_FILE);
  if (!fs.existsSync(canvasPath)) return '';
  return fs.readFileSync(canvasPath, 'utf-8');
}

/** Get the canvas content for a space at a specific git commit (non-destructive). */
export async function getSpaceVersionContent(workspaceRoot: string, folder: string, sha: string): Promise<{ content: string; error?: string }> {
  try {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) {
      return { content: '', error: 'Invalid commit SHA' };
    }
    const content = await runGitOutput(workspaceRoot, ['show', `${sha}:${folder}/${CANVAS_FILE}`]);
    return { content };
  } catch (err: any) {
    return { content: '', error: err?.message || 'Failed to read version' };
  }
}

/** Write content to a space's canvas file. Creates the folder if needed. */
export function writeCanvas(workspaceRoot: string, folder: string, content: string): void {
  const folderPath = path.join(workspaceRoot, folder);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
  const canvasPath = getCanvasPath(workspaceRoot, folder);
  fs.writeFileSync(canvasPath, content, 'utf-8');
}

/** Create a space's folder and seed its canvas with initial content. */
export function initSpaceCanvas(workspaceRoot: string, spaceId: string, description: string, body: string | null): string {
  const folder = createSpaceFolder(workspaceRoot, spaceId, description);
  const canvasPath = getCanvasPath(workspaceRoot, folder);

  // Only seed if canvas doesn't already exist
  if (!fs.existsSync(canvasPath)) {
    const content = body && body.trim() ? body.trim() + '\n' : '';
    fs.writeFileSync(canvasPath, content, 'utf-8');
  }

  return folder;
}

/**
 * Async variant of {@link initSpaceCanvas} for a folder whose name is already
 * known (slug is deterministic). Creates the folder and seeds the canvas using
 * non-blocking fs.promises so it can run off the create critical path.
 */
export async function materializeSpaceCanvas(workspaceRoot: string, folder: string, body: string | null): Promise<void> {
  const folderPath = path.join(workspaceRoot, folder);
  await fs.promises.mkdir(folderPath, { recursive: true });

  const canvasPath = getCanvasPath(workspaceRoot, folder);
  try {
    // wx fails if the file already exists, so we never clobber an existing canvas.
    const content = body && body.trim() ? body.trim() + '\n' : '';
    await fs.promises.writeFile(canvasPath, content, { encoding: 'utf-8', flag: 'wx' });
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }
}

/**
 * Synchronously ensure a space's folder + canvas exist on disk for a folder
 * whose name is already known. Safety net for readers that may run before the
 * deferred {@link materializeSpaceCanvas} write has landed. Never clobbers an
 * existing canvas and does not recompute the folder from the description (which
 * may have changed after AI refinement).
 */
export function ensureSpaceCanvas(workspaceRoot: string, folder: string, body: string | null): void {
  // Completed spaces live under .whim/archive. Recreating the live folder here
  // would shadow the archived canvas on the subsequent read with a blank copy.
  const folderPath = resolveSpaceFolder(workspaceRoot, folder);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
  const canvasPath = path.join(folderPath, CANVAS_FILE);
  if (!fs.existsSync(canvasPath)) {
    const content = body && body.trim() ? body.trim() + '\n' : '';
    fs.writeFileSync(canvasPath, content, 'utf-8');
  }
}

const ARCHIVE_DIR = 'archive';

/** Move a space folder into .whim/archive/ for safekeeping. */
export function archiveSpaceFolder(workspaceRoot: string, folder: string): void {
  if (!folder) return;
  const src = path.join(workspaceRoot, folder);
  if (!fs.existsSync(src)) return;

  const archiveDir = path.join(workspaceRoot, WHIM_DIR, ARCHIVE_DIR);
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const dest = path.join(archiveDir, folder);
  // If destination already exists (e.g. re-completing), remove it first
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }

  fs.renameSync(src, dest);
}

/** Move a space folder from .whim/archive/ back to the workspace root. */
export function unarchiveSpaceFolder(workspaceRoot: string, folder: string): void {
  if (!folder) return;
  const archivePath = path.join(workspaceRoot, WHIM_DIR, ARCHIVE_DIR, folder);
  if (!fs.existsSync(archivePath)) return;

  const dest = path.join(workspaceRoot, folder);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }

  fs.renameSync(archivePath, dest);
}

/** Remove a space folder from disk (workspace root and/or archive). */
export function deleteSpaceFolder(workspaceRoot: string, folder: string): void {
  if (!folder) return;

  const livePath = path.join(workspaceRoot, folder);
  if (fs.existsSync(livePath)) {
    fs.rmSync(livePath, { recursive: true, force: true });
  }

  const archivePath = path.join(workspaceRoot, WHIM_DIR, ARCHIVE_DIR, folder);
  if (fs.existsSync(archivePath)) {
    fs.rmSync(archivePath, { recursive: true, force: true });
  }
}

// ── Auto-commit ─────────────────────────────────────────

let commitTimer: ReturnType<typeof setTimeout> | null = null;
let commitInFlight = false;
const COMMIT_DEBOUNCE_MS = 2000;

function runGit(workspaceRoot: string, args: string[]): Promise<void> {
  return runGitStreaming(workspaceRoot, args);
}

async function runGitStreaming(
  workspaceRoot: string, args: string[], visitPath?: (file: string) => Promise<void>,
): Promise<void> {
  const child = spawn('git', args, { cwd: workspaceRoot, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  let error: Error | undefined;
  let stderr = '';
  child.on('error', caught => { error = caught; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk.slice(0, Math.max(0, 16 * 1024 - stderr.length)); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdout.setEncoding('utf8');
  let remainder = '';
  try {
    for await (const chunk of child.stdout) {
      if (!visitPath) continue;
      remainder += chunk;
      let start = 0;
      let end: number;
      while ((end = remainder.indexOf('\0', start)) !== -1) {
        if (end > start) await visitPath(remainder.slice(start, end));
        start = end + 1;
      }
      remainder = remainder.slice(start);
    }
    const result = await closed;
    if (error) throw error;
    if (result.code !== 0) {
      throw Object.assign(new Error(`git ${args[0]} failed (${result.signal ?? result.code}): ${stderr.trim()}`), result);
    }
    if (remainder) throw new Error('Incomplete Git path listing');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
}

function runGitOutput(workspaceRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: workspaceRoot, timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Run a git command with longer timeout for network operations (fetch/push/pull). */
function runGitNetwork(workspaceRoot: string, args: string[], signal?: AbortSignal): Promise<string> {
  const end = startTiming('git.network');
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: workspaceRoot,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout) => {
      end(!err);
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// ── Git operation queue ─────────────────────────────────
// Serializes all git operations to prevent .git/index.lock races.

const gitQueue = new GitQueue();

function enqueueGitOp<T>(fn: () => Promise<T>): Promise<T> {
  return gitQueue.enqueue(fn);
}

export function cancelGitPolling(): void { gitQueue.cancelBackground(); }
export async function drainGitOperations(): Promise<void> {
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = null;
  await gitQueue.drain();
}

async function writeOversizedPathspecs(
  workspaceRoot: string, args: string[], target: string, exclude: boolean,
): Promise<number> {
  const output = await fs.promises.open(target, 'w');
  let count = 0;
  try {
    if (exclude) await output.writeFile('.\0');
    await runGitStreaming(workspaceRoot, args, async file => {
      let stat: fs.Stats;
      try { stat = await fs.promises.lstat(path.join(workspaceRoot, file)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (stat.isFile() && stat.size > 50 * 1024 * 1024) {
        await output.writeFile(`:(top,${exclude ? 'exclude,' : ''}literal)${file}\0`);
        count++;
      }
    });
    return count;
  } finally { await output.close(); }
}

async function stageWorkspace(workspaceRoot: string): Promise<void> {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'whim-git-stage-'));
  try {
    // Stream both the inventory and exclusions: neither stdout nor argv grows
    // with the repository. Git still owns ignore, deletion and pathspec semantics.
    const exclusions = path.join(temporary, 'exclusions');
    const large = await writeOversizedPathspecs(workspaceRoot,
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], exclusions, true);
    await runGit(workspaceRoot, ['add', '-A', `--pathspec-from-file=${exclusions}`, '--pathspec-file-nul']);
    if (large) {
      const staged = path.join(temporary, 'staged');
      const stagedLarge = await writeOversizedPathspecs(workspaceRoot,
        ['diff', '--cached', '--name-only', '-z'], staged, false);
      if (stagedLarge) {
        let hasHead = true;
        try { await runGit(workspaceRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']); }
        catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 1) throw error;
          hasHead = false;
        }
        await runGit(workspaceRoot, [
          ...(hasHead ? ['restore', '--staged'] : ['rm', '--cached', '--force', '--ignore-unmatch']),
          `--pathspec-from-file=${staged}`, '--pathspec-file-nul',
        ]);
      }
      console.warn('[workspace] Excluded oversized files from auto-commit:', { count: large, limitBytes: 50 * 1024 * 1024 });
    }
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}

async function doCommit(workspaceRoot: string): Promise<void> {
  return enqueueGitOp(async () => {
    if (commitInFlight) return;
    commitInFlight = true;
    try {
      // Check if this is a git repo
      await runGit(workspaceRoot, ['rev-parse', '--git-dir']);

      // Stage the .whim/ dir (event log) and all tracked/new files (space folders)
      const storage = await import('./storage');
      if (storage.isInitialized()) {
        await storage.withStorageBarrier(() => stageWorkspace(workspaceRoot));
      } else {
        await stageWorkspace(workspaceRoot);
      }

      // Check if there's anything to commit
      try {
        await runGit(workspaceRoot, ['diff', '--cached', '--quiet']);
        // No changes staged — nothing to commit
        return;
      } catch {
        // diff --quiet exits non-zero when there ARE changes — that's what we want
      }

      const timestamp = new Date().toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      await runGit(workspaceRoot, ['commit', '-m', `space: auto-save ${timestamp}`, '--no-verify']);
      console.log(`[workspace] Auto-committed at ${timestamp}`);

      // Notify renderer so history panel can refresh
      notifyAllWindows('workspace:committed');
    } catch (err: any) {
      // Silently skip if not a git repo or git not available
      if (err?.message?.includes('not a git repository') || err?.code === 'ENOENT') {
        return;
      }
      console.warn('[workspace] Auto-commit failed:', err?.message || err);
      throw err;
    } finally {
      commitInFlight = false;
    }
  });
}

/**
 * Schedule an auto-commit for the workspace. Debounced so rapid changes
 * (typing, canvas saves, multiple space updates) coalesce into one commit.
 */
export function scheduleAutoCommit(workspaceRoot: string): void {
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    commitTimer = null;
    void doCommit(workspaceRoot).catch(error => console.error('[workspace] Scheduled commit failed:', error));
  }, COMMIT_DEBOUNCE_MS);
}

/**
 * Immediately commit all pending changes (non-debounced).
 * Cancels any pending debounced commit. Use before archiving a folder
 * so that all canvas/attachment changes are captured in git history first.
 */
export async function commitNow(workspaceRoot: string): Promise<void> {
  if (commitTimer) {
    clearTimeout(commitTimer);
    commitTimer = null;
  }
  await doCommit(workspaceRoot);
}

// ── Git sync ────────────────────────────────────────────

const UNAVAILABLE: GitSyncStatus = { available: false, branch: null, ahead: 0, behind: 0 };

/** Get sync status relative to the upstream tracking branch. */
export async function getGitSyncStatus(workspaceRoot: string): Promise<GitSyncStatus> {
    try {
      // Check if git repo
      await runGit(workspaceRoot, ['rev-parse', '--git-dir']);
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { ...UNAVAILABLE, unavailableReason: 'git-not-found' };
      return { ...UNAVAILABLE, unavailableReason: 'not-a-repo' };
    }

    try {
      // Get branch name
      const branch = (await runGitOutput(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      if (branch === 'HEAD') {
        return { ...UNAVAILABLE, unavailableReason: 'detached-head' };
      }

      // Check if upstream is configured
      try {
        await runGitOutput(workspaceRoot, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]);
      } catch {
        return { ...UNAVAILABLE, unavailableReason: 'no-upstream', branch };
      }

      // Get ahead/behind counts
      const refs = (await runGitOutput(workspaceRoot, ['rev-parse', 'HEAD', `${branch}@{upstream}`])).trim().split(/\s+/);
      const output = (await runGitOutput(workspaceRoot, ['rev-list', '--count', '--left-right', `${refs[0]}...${refs[1]}`])).trim();
      const [aheadStr, behindStr] = output.split(/\s+/);
      const ahead = parseInt(aheadStr, 10) || 0;
      const behind = parseInt(behindStr, 10) || 0;

      return { available: true, branch, ahead, behind };
    } catch {
      return { ...UNAVAILABLE, unavailableReason: 'not-a-repo' };
    }
}

/** Fetch from origin. */
export async function gitFetchOrigin(workspaceRoot: string, background = false): Promise<void> {
  return gitQueue.enqueue(async signal => {
    await runGitNetwork(workspaceRoot, ['fetch', 'origin', '--quiet'], signal);
  }, background);
}

/** Push current branch to origin. Flushes pending auto-commit first. */
export async function gitPush(workspaceRoot: string): Promise<{ ok: true } | { error: string }> {
  // Flush pending auto-commit before pushing
  await commitNow(workspaceRoot);

  return enqueueGitOp(async () => {
    try {
      const branch = (await runGitOutput(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      await runGitNetwork(workspaceRoot, ['push', 'origin', branch]);
      return { ok: true as const };
    } catch (err: any) {
      const msg = err?.message || 'Push failed';
      if (msg.includes('rejected') || msg.includes('non-fast-forward')) {
        return { error: 'Remote has new changes. Pull first, then push.' };
      }
      return { error: msg };
    }
  });
}

/** Pull from origin using fast-forward only. Returns conflict flag if diverged. */
export async function gitPull(workspaceRoot: string): Promise<{ ok: true } | { error: string; conflict?: boolean }> {
  // Flush pending auto-commit before pulling
  await commitNow(workspaceRoot);

  return enqueueGitOp(async () => {
    try {
      const branch = (await runGitOutput(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      const { withStorageBarrier, applyIncomingChanges, syncCanvasContent, mergeSessionIds, getStorageGeneration } = await import('./storage');
      const generation = getStorageGeneration();
      await runGitNetwork(workspaceRoot, ['fetch', 'origin', branch]);
      if (generation !== getStorageGeneration()) throw new Error('Workspace changed during fetch');
      await withStorageBarrier(async () => {
        const endReconcile = startTiming('git.reconcile');
        try {
        await runGit(workspaceRoot, ['merge', '--ff-only', 'FETCH_HEAD']);
        await applyIncomingChanges();
        const { getConfigValue } = await import('./config');
        await mergeSessionIds(getConfigValue('sessions'));
        await syncCanvasContent(workspaceRoot);
        const { syncAllSkills } = await import('./skill-watcher');
        await syncAllSkills(workspaceRoot);
        const { refreshWatchedCanvases } = await import('./canvas-watcher');
        await refreshWatchedCanvases();
        endReconcile();
        } catch (error) { endReconcile(false); throw error; }
      });

      // Notify renderer so history/canvas can refresh
      notifyAllWindows('workspace:committed');
      return { ok: true as const };
    } catch (err: any) {
      const msg = err?.message || 'Pull failed';
      if (msg.includes('Not possible to fast-forward') || msg.includes('divergent')) {
        return { error: 'Branches have diverged. Resolve conflicts to continue.', conflict: true };
      }
      if (msg.includes('uncommitted changes') || msg.includes('overwritten by merge')) {
        return { error: 'You have uncommitted changes. Commit or stash them first.' };
      }
      return { error: msg };
    }
  });
}

// ── Git history ─────────────────────────────────────────

export interface FolderCommit {
  sha: string;
  shortSha: string;
  message: string;
  date: string;       // ISO 8601
  relativeDate: string;
  filesChanged: string[];
}

/** Get git commit history for an space folder. */
export async function getSpaceHistory(workspaceRoot: string, folder: string, limit = 50): Promise<FolderCommit[]> {
  try {
    const SEPARATOR = '---COMMIT---';
    // Search both live and archive paths so history survives archiving
    const archivePath = path.join(WHIM_DIR, ARCHIVE_DIR, folder).replace(/\\/g, '/');
    const raw = await runGitOutput(workspaceRoot, [
      'log', `--max-count=${limit}`,
      `--format=${SEPARATOR}%n%H%n%h%n%s%n%aI%n%ar`,
      '--name-only',
      '--', `${folder}/`, `${archivePath}/`,
    ]);

    if (!raw.trim()) return [];

    const commits: FolderCommit[] = [];
    const blocks = raw.split(SEPARATOR).filter(b => b.trim());

    for (const block of blocks) {
      const lines = block.split('\n').filter(l => l !== '');
      if (lines.length < 5) continue;

      const [sha, shortSha, message, date, relativeDate, ...fileLines] = lines;
      commits.push({
        sha,
        shortSha,
        message,
        date,
        relativeDate,
        filesChanged: fileLines.filter(f => {
          // git always uses forward slashes in output, normalize folder to match
          const prefix = folder.replace(/\\/g, '/') + '/';
          return f.startsWith(prefix) || f.startsWith(archivePath + '/');
        }),
      });
    }

    return commits;
  } catch {
    return [];
  }
}

/** Restore an space folder to a specific commit's state. */
export async function restoreSpaceVersion(workspaceRoot: string, folder: string, sha: string): Promise<{ success: boolean; error?: string }> {
  return enqueueGitOp(async () => {
  try {
    // Validate sha looks legit
    if (!/^[0-9a-f]{7,40}$/.test(sha)) {
      return { success: false, error: 'Invalid commit SHA' };
    }

    // Checkout the folder contents from that commit
    await runGit(workspaceRoot, ['checkout', sha, '--', `${folder}/`]);

    // Auto-commit the restoration
    await stageWorkspace(workspaceRoot);
    try {
      await runGit(workspaceRoot, ['diff', '--cached', '--quiet']);
      // No changes — already at this version
      return { success: true };
    } catch {
      // Has changes — commit the restore
    }

    const timestamp = new Date().toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    await runGit(workspaceRoot, ['commit', '-m', `space: restore to ${sha.slice(0, 7)} (${timestamp})`, '--no-verify']);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Restore failed' };
  }
  });
}

// ── Attachment handling ─────────────────────────────────

/** Sanitize a filename for safe filesystem use. */
function sanitizeFilename(name: string): string {
  // Remove path separators and null bytes
  let safe = name.replace(/[/\\:\0]/g, '_');
  // Remove leading dots (hidden files)
  safe = safe.replace(/^\.+/, '');
  // Guard against Windows reserved names
  const baseName = safe.split('.')[0].toLowerCase();
  if (RESERVED_NAMES.has(baseName)) {
    safe = '_' + safe;
  }
  // Truncate to reasonable length
  if (safe.length > 200) {
    const ext = path.extname(safe);
    safe = safe.substring(0, 200 - ext.length) + ext;
  }
  return safe || 'attachment';
}

/** Deduplicate a filename by adding a numeric suffix. */
function deduplicateFilename(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let n = 1;
  while (fs.existsSync(path.join(dir, `${base} (${n})${ext}`))) n++;
  return `${base} (${n})${ext}`;
}

export interface SaveAttachmentResult {
  success: boolean;
  relativePath?: string;
  filename?: string;
  error?: string;
}

/** Save a pasted file into the space's attachments folder. */
export function saveAttachment(
  workspaceRoot: string,
  folder: string,
  filename: string,
  data: Buffer
): SaveAttachmentResult {
  if (data.length > MAX_ATTACHMENT_SIZE) {
    return { success: false, error: `File too large (max ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB)` };
  }

  const sanitized = sanitizeFilename(filename);
  const attachDir = path.join(workspaceRoot, folder, ATTACHMENTS_DIR);

  if (!fs.existsSync(attachDir)) {
    fs.mkdirSync(attachDir, { recursive: true });
  }

  const finalName = deduplicateFilename(attachDir, sanitized);
  const filePath = path.join(attachDir, finalName);

  // Verify resolved path is within the space folder
  const resolved = path.resolve(filePath);
  const folderRoot = path.resolve(path.join(workspaceRoot, folder));
  if (!isPathInside(folderRoot, resolved)) {
    return { success: false, error: 'Invalid file path' };
  }

  fs.writeFileSync(filePath, data);
  return {
    success: true,
    relativePath: `${ATTACHMENTS_DIR}/${finalName}`,
    filename: finalName,
  };
}

/**
 * True when `candidate` resolves to `root` itself or something beneath it.
 *
 * A bare `startsWith(root)` treats `/w/foo-private` as inside `/w/foo`,
 * because the shared prefix ends mid-segment. `realpath` is applied where the
 * path exists so a symlink inside the space cannot point out of it — which
 * matters more now that these helpers back channels the web remote can reach.
 */
function isPathInside(root: string, candidate: string): boolean {
  const realRoot = realpathOrSelf(root);
  const realCandidate = realpathOrSelf(candidate);
  if (realCandidate === realRoot) return true;
  const relative = path.relative(realRoot, realCandidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * `realpath` of the deepest part of `target` that exists, with the missing
 * tail appended.
 *
 * A file being written does not exist yet, so it cannot be realpath'd
 * directly — but its parent can, and that is where a symlink would have to
 * be. Resolving only one side would also break on macOS, where the root
 * realpaths to `/private/var/...` while an unresolved candidate stays
 * `/var/...` and every comparison fails.
 */
function realpathOrSelf(target: string): string {
  let current = path.resolve(target);
  const trailing: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...trailing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve `relativePath` inside `root`, or null if it escapes or is missing.
 *
 * The one place the containment check lives, so every caller that serves a
 * file to a canvas — over IPC or over the web remote's HTTP endpoint — gets
 * the same symlink-aware guard rather than its own approximation of one.
 */
export function resolveFileInDir(root: string, relativePath: string): string | null {
  const resolved = path.resolve(path.join(root, relativePath));
  if (!isPathInside(root, resolved)) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

/** Resolve an attachment path to an absolute path (with security check). */
export function resolveAttachmentPath(
  workspaceRoot: string,
  folder: string,
  relativePath: string
): string | null {
  return resolveFileInDir(resolveSpaceFolder(workspaceRoot, folder), relativePath);
}

/** True when `candidate` is contained by `root` (symlinks resolved). */
export function isPathContainedBy(root: string, candidate: string): boolean {
  return isPathInside(root, candidate);
}

/** Read a file from an space folder and return its raw bytes + MIME type. */
export function readSpaceFile(
  workspaceRoot: string,
  folder: string,
  relativePath: string
): { data: Buffer; mimeType: string } | null {
  const resolved = resolveAttachmentPath(workspaceRoot, folder, relativePath);
  if (!resolved) return null;
  const data = fs.readFileSync(resolved);
  const mimeType = getMimeType(resolved);
  return { data, mimeType };
}

/** Get MIME type from file extension. */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    // Images
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp', '.ico': 'image/x-icon',
    // Audio
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
    '.webm': 'audio/webm',
    // Video
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska', '.webm_v': 'video/webm',
    // Documents
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
    '.json': 'application/json', '.csv': 'text/csv',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // Code
    '.js': 'application/javascript', '.ts': 'text/typescript',
    '.html': 'text/html', '.css': 'text/css',
    '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip',
  };
  // Special handling for .webm (could be audio or video)
  if (ext === '.webm') return 'video/webm';
  return mimeMap[ext] || 'application/octet-stream';
}

// ── Child pages ──────────────────────────────────────────

const PAGE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_PAGE_NAMES = new Set(['canvas', 'uploads', 'reports', '.whim', '.workspace', '.git', '.ds_store']);

/** Validate and normalize a page name to a safe filename slug. */
export function sanitizePageName(name: string): string | null {
  // Normalize: trim, lowercase, replace spaces/underscores with hyphens, strip invalid chars
  let slug = name.trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');

  if (!slug || !PAGE_SLUG_PATTERN.test(slug)) return null;
  if (RESERVED_PAGE_NAMES.has(slug)) return null;
  if (slug.length > 80) slug = slug.slice(0, 80).replace(/-$/, '');
  return slug;
}

/** Create a new child page in a space folder. Returns the sanitized page slug. */
export function createPage(workspaceRoot: string, folder: string, pageName: string): { page: string } | { error: string } {
  const slug = sanitizePageName(pageName);
  if (!slug) return { error: 'Invalid page name. Use letters, numbers, and hyphens only.' };

  const folderRoot = resolveSpaceFolder(workspaceRoot, folder);
  const pagePath = path.join(folderRoot, `${slug}.md`);

  // Safety: ensure resolved path is inside the space folder
  const resolved = path.resolve(pagePath);
  if (!isPathInside(folderRoot, resolved)) {
    return { error: 'Invalid page path' };
  }

  if (fs.existsSync(pagePath)) return { error: 'A page with that name already exists.' };

  fs.writeFileSync(pagePath, ensureMarkdownH1Title('', pageName).content, 'utf-8');
  return { page: slug };
}

/** Read a child page's content. */
export function readPage(workspaceRoot: string, folder: string, pageName: string): { content: string } | { error: string } {
  const resolvedPage = resolvePagePath(workspaceRoot, folder, pageName);
  if ('error' in resolvedPage) return resolvedPage;
  const pagePath = resolvedPage.path;

  if (!fs.existsSync(pagePath)) return { error: 'Page not found' };
  return { content: fs.readFileSync(pagePath, 'utf-8') };
}

export function resolvePagePath(workspaceRoot: string, folder: string, pageName: string): { path: string } | { error: string } {
  const slug = sanitizePageName(pageName);
  if (!slug) return { error: 'Invalid page name' };

  const folderRoot = resolveSpaceFolder(workspaceRoot, folder);
  const pagePath = path.join(folderRoot, `${slug}.md`);

  const resolved = path.resolve(pagePath);
  if (!isPathInside(folderRoot, resolved)) {
    return { error: 'Invalid page path' };
  }

  return { path: pagePath };
}

/** Write content to a child page. */
export function writePage(workspaceRoot: string, folder: string, pageName: string, content: string): { success: boolean } | { error: string } {
  const resolvedPage = resolvePagePath(workspaceRoot, folder, pageName);
  if ('error' in resolvedPage) return resolvedPage;

  fs.writeFileSync(resolvedPage.path, content, 'utf-8');
  return { success: true };
}

/** List all child pages in a space folder (all .md files except canvas.md). */
export function listPages(workspaceRoot: string, folder: string): string[] {
  const folderRoot = resolveSpaceFolder(workspaceRoot, folder);
  if (!fs.existsSync(folderRoot)) return [];

  try {
    return fs.readdirSync(folderRoot)
      .filter(f => f.endsWith('.md') && f !== 'canvas.md')
      .map(f => f.replace(/\.md$/, ''))
      .sort();
  } catch {
    return [];
  }
}
