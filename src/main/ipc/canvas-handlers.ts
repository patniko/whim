import { registerIpcHandler } from './registry';
import { shell, BrowserWindow } from 'electron';
import { isInitialized, getSpace, getSkill, assignSpaceFolder, updateCanvasContent } from '../database';
import { getConfigValue } from '../config';
import { initSpaceCanvas, ensureSpaceCanvas, readCanvas, scheduleAutoCommit, saveAttachment, resolveAttachmentPath, getMimeType, getSpaceHistory, restoreSpaceVersion, getSpaceVersionContent, resolveSpaceFolder, resolvePagePath, createPage, readPage, writePage, listPages } from '../workspace';
import { parseFrontmatter, serializeFrontmatter } from '../frontmatter';
import { fetchLinkPreview } from '../services/link-preview';
import { startWatching, stopWatching } from '../canvas-watcher';
import { mirrorRendererEvent } from '../web/event-hub';
import { forgetCanvasEditorContent, rememberCanvasEditorContent, writeEditorFileWithMerge, writeMainCanvasWithMerge, type CanvasWriteResult } from '../services/canvas-editor-state';
import { openFileInNewWindow, isWorkspaceMdFile } from '../window-manager';
import { readCanvasFile } from '../canvas/canvas-file-root';
import { resolveLinkTarget, type LinkTarget } from '../canvas/link-target';
import type { SkillFrontmatter } from '../../shared/types';
import * as fs from 'fs';
import * as path from 'path';

const CANVAS_FILE = 'canvas.md';

/** Space lookup for the canvas file resolver, which stays database-agnostic. */
const spaceFolderLookup = (spaceId: string): string | null => getSpace(spaceId)?.folder ?? null;

/** Decide what a link means, or null when there is no workspace to decide against. */
function resolveLinkFor(spaceId: string, url: string): LinkTarget | null {
  const workspace = getConfigValue('workspace');
  if (!workspace) return null;
  return resolveLinkTarget(url, {
    baseDir: resolveCanvasBaseDir(workspace, spaceId),
    isWorkspaceMdFile,
  });
}

function parseSyntheticPageId(spaceId: string): { realSpaceId: string; pageName: string } | null {
  if (!spaceId.startsWith('__page__')) return null;
  const rest = spaceId.slice('__page__'.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx <= 0) return null;
  try {
    return {
      realSpaceId: rest.slice(0, slashIdx),
      pageName: decodeURIComponent(rest.slice(slashIdx + 1)),
    };
  } catch {
    return null;
  }
}

function pageEditorId(spaceId: string, pageName: string): string {
  return `__page__${spaceId}/${encodeURIComponent(pageName)}`;
}

function notifyEditorContentUpdated(editorId: string, content: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('canvas:content-updated', { spaceId: editorId, content });
  }
  mirrorRendererEvent('canvas:content-updated', { spaceId: editorId, content });
}

function watchEditorFile(editorId: string, filePath: string, onChange?: (content: string) => void): void {
  startWatching(editorId, filePath, (content) => {
    onChange?.(content);
    notifyEditorContentUpdated(editorId, content);
  });
}

function closeSucceeded(result: CanvasWriteResult, workspace: string, editorId: string): CanvasWriteResult {
  if (result.success) {
    stopWatching(editorId);
    forgetCanvasEditorContent(editorId);
    scheduleAutoCommit(workspace);
  }
  return result;
}

export function registerCanvasHandlers(): void {
  // Lightweight probe: does this space have a non-empty canvas.md on disk?
  // No side effects (does not create folders, does not start watchers).
  registerIpcHandler('canvas:has-content', (_event, spaceId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { hasContent: false };

    // Workspace .md file pseudo-spaces map to a real file on disk.
    if (spaceId.startsWith('__file__')) {
      const filePath = decodeURIComponent(spaceId.slice('__file__'.length));
      try {
        return { hasContent: fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf-8').trim().length > 0 };
      } catch {
        return { hasContent: false };
      }
    }

    if (spaceId.startsWith('__page__') || spaceId.startsWith('__skill__')) {
      return { hasContent: false };
    }

    const space = getSpace(spaceId);
    if (!space || !space.folder) return { hasContent: false };

    try {
      const canvasPath = path.join(resolveSpaceFolder(workspace, space.folder), CANVAS_FILE);
      if (!fs.existsSync(canvasPath)) {
        // Canvas file may not be materialized yet (deferred off the create
        // critical path). Fall back to the in-DB body so the content indicator
        // is accurate during that brief window.
        return { hasContent: !!(space.body && space.body.trim().length > 0) };
      }
      return { hasContent: fs.readFileSync(canvasPath, 'utf-8').trim().length > 0 };
    } catch {
      return { hasContent: false };
    }
  });

  registerIpcHandler('canvas:read', (_event, spaceId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { content: '', error: 'no_workspace' };

    // Route workspace file reads to the actual file on disk
    if (spaceId.startsWith('__file__')) {
      const filePath = decodeURIComponent(spaceId.slice('__file__'.length));
      if (!isWorkspaceMdFile(filePath)) return { content: '', error: 'not_in_workspace' };
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        rememberCanvasEditorContent(spaceId, content);
        watchEditorFile(spaceId, filePath);
        return { content };
      } catch {
        return { content: '', error: 'read_failed' };
      }
    }

    // Route page reads to page files
    const pageTarget = parseSyntheticPageId(spaceId);
    if (pageTarget) {
      const { realSpaceId, pageName } = pageTarget;
      const space = getSpace(realSpaceId);
      if (!space) return { content: '', error: 'not_found' };
      let folder = space.folder;
      if (!folder) {
        folder = initSpaceCanvas(workspace, realSpaceId, space.description, space.body);
        assignSpaceFolder(realSpaceId, folder);
      }
      const result = readPage(workspace, folder, pageName);
      if ('error' in result) return { content: '', error: result.error };
      const resolvedPage = resolvePagePath(workspace, folder, pageName);
      if (!('error' in resolvedPage)) {
        rememberCanvasEditorContent(spaceId, result.content);
        watchEditorFile(spaceId, resolvedPage.path);
      }
      return { content: result.content };
    }

    const space = getSpace(spaceId);
    if (!space) return { content: '', error: 'not_found' };

    // Ensure folder exists (for spaces created before canvas feature)
    let folder = space.folder;
    if (!folder) {
      folder = initSpaceCanvas(workspace, spaceId, space.description, space.body);
      assignSpaceFolder(spaceId, folder);
    } else {
      // Folder name is recorded at creation, but the on-disk folder/canvas may
      // still be pending (materialized off the create critical path). Ensure it
      // exists before reading so an immediate open never sees an empty canvas.
      ensureSpaceCanvas(workspace, folder, space.body);
    }

    const content = readCanvas(workspace, folder);
    rememberCanvasEditorContent(spaceId, content);

    // Start watching for external changes (e.g. from agents)
    const folderRoot = resolveSpaceFolder(workspace, folder);
    const canvasPath = path.join(folderRoot, CANVAS_FILE);
    watchEditorFile(spaceId, canvasPath, (newContent: string) => {
      const titleUpdate = updateCanvasContent(spaceId, newContent);
      if (titleUpdate.titleChanged) {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('space:title-updated', { spaceId, title: titleUpdate.title });
        }
        mirrorRendererEvent('space:title-updated', { spaceId, title: titleUpdate.title });
      }
    });

    return { content };
  });

  registerIpcHandler('canvas:write', (_event, spaceId: string, content: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { success: false, error: 'no_workspace' };

    // Route workspace file writes to the actual file on disk
    if (spaceId.startsWith('__file__')) {
      const filePath = decodeURIComponent(spaceId.slice('__file__'.length));
      if (!isWorkspaceMdFile(filePath)) return { success: false, error: 'not_in_workspace' };
      const result = writeEditorFileWithMerge(spaceId, filePath, content, (contentToWrite) => {
        fs.writeFileSync(filePath, contentToWrite, 'utf-8');
      });
      if (result.success) {
        scheduleAutoCommit(workspace);
      }
      return result;
    }

    // Route skill autosaves to the skill file
    if (spaceId.startsWith('__skill__')) {
      const skillId = spaceId.slice('__skill__'.length);
      const skill = getSkill(skillId);
      if (!skill) return { success: false, error: 'not_found' };
      try {
        const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(content);
        const fileContent = serializeFrontmatter(frontmatter, body);
        fs.writeFileSync(skill.filePath, fileContent, 'utf-8');
        return { success: true };
      } catch {
        return { success: false, error: 'write_failed' };
      }
    }

    // Route page autosaves to the page file
    const pageTarget = parseSyntheticPageId(spaceId);
    if (pageTarget) {
      const { realSpaceId, pageName } = pageTarget;
      const space = getSpace(realSpaceId);
      if (!space) return { success: false, error: 'not_found' };
      let folder = space.folder;
      if (!folder) {
        folder = initSpaceCanvas(workspace, realSpaceId, space.description, space.body);
        assignSpaceFolder(realSpaceId, folder);
      }
      const resolvedPage = resolvePagePath(workspace, folder, pageName);
      if ('error' in resolvedPage) return { success: false, error: resolvedPage.error };
      return writeEditorFileWithMerge(spaceId, resolvedPage.path, content, (contentToWrite) => {
        const result = writePage(workspace, folder, pageName, contentToWrite);
        if ('error' in result) throw new Error(result.error);
      });
    }

    const space = getSpace(spaceId);
    if (!space) return { success: false, error: 'not_found' };

    let folder = space.folder;
    if (!folder) {
      folder = initSpaceCanvas(workspace, spaceId, space.description, space.body);
      assignSpaceFolder(spaceId, folder);
    }

    return writeMainCanvasWithMerge(workspace, spaceId, folder, content);
  });

  // Save canvas + trigger a commit (called when leaving the canvas)
  registerIpcHandler('canvas:close', (_event, spaceId: string, content: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { success: false, error: 'no_workspace' };

    // Route workspace file closes to the actual file on disk
    if (spaceId.startsWith('__file__')) {
      const filePath = decodeURIComponent(spaceId.slice('__file__'.length));
      if (!isWorkspaceMdFile(filePath)) return { success: false, error: 'not_in_workspace' };
      const result = writeEditorFileWithMerge(spaceId, filePath, content, (contentToWrite) => {
        fs.writeFileSync(filePath, contentToWrite, 'utf-8');
      });
      return closeSucceeded(result, workspace, spaceId);
    }

    // Route page closes to page files
    const pageTarget = parseSyntheticPageId(spaceId);
    if (pageTarget) {
      const { realSpaceId, pageName } = pageTarget;
      const space = getSpace(realSpaceId);
      if (!space) return { success: false, error: 'not_found' };
      let folder = space.folder;
      if (!folder) {
        folder = initSpaceCanvas(workspace, realSpaceId, space.description, space.body);
        assignSpaceFolder(realSpaceId, folder);
      }
      const resolvedPage = resolvePagePath(workspace, folder, pageName);
      if ('error' in resolvedPage) return { success: false, error: resolvedPage.error };
      const result = writeEditorFileWithMerge(spaceId, resolvedPage.path, content, (contentToWrite) => {
        const pageResult = writePage(workspace, folder, pageName, contentToWrite);
        if ('error' in pageResult) throw new Error(pageResult.error);
      });
      return closeSucceeded(result, workspace, spaceId);
    }

    const space = getSpace(spaceId);
    if (!space) return { success: false, error: 'not_found' };

    let folder = space.folder;
    if (!folder) {
      folder = initSpaceCanvas(workspace, spaceId, space.description, space.body);
      assignSpaceFolder(spaceId, folder);
    }

    return closeSucceeded(writeMainCanvasWithMerge(workspace, spaceId, folder, content), workspace, spaceId);
  });

  // ── Canvas file paste ─────────────────────────────────
  registerIpcHandler('canvas:paste-file', (_event, spaceId: string, filename: string, dataArray: number[]) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const space = getSpace(spaceId);
    if (!space) return { error: 'not_found' };

    let folder = space.folder;
    if (!folder) {
      folder = initSpaceCanvas(workspace, spaceId, space.description, space.body);
      assignSpaceFolder(spaceId, folder);
    }

    const data = Buffer.from(dataArray);
    const result = saveAttachment(workspace, folder, filename, data);
    return result;
  });

  // ── Attachment file serving ───────────────────────────
  registerIpcHandler('canvas:resolve-attachment', (_event, spaceId: string, relativePath: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const space = getSpace(spaceId);
    if (!space || !space.folder) return { error: 'not_found' };

    const absPath = resolveAttachmentPath(workspace, space.folder, relativePath);
    if (!absPath) return { error: 'not_found' };

    const mimeType = getMimeType(absPath);
    return { path: absPath, mimeType };
  });

  // ── Read file from space folder (for canvas storage) ──
  registerIpcHandler('canvas:read-file', (_event, spaceId: string, relativePath: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    // Pages and linked workspace files are canvases too, and their ids are
    // synthetic — looking them up as spaces is why their images never loaded.
    const result = readCanvasFile(workspace, spaceId, relativePath, spaceFolderLookup);
    if (!result) return { error: 'not_found' };

    // Return as array of bytes + mimeType so it can cross the IPC boundary
    return { data: Array.from(result.data), mimeType: result.mimeType };
  });

  // ── Open space folder in OS file manager ─────────────
  registerIpcHandler('canvas:open-folder', (_event, spaceId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return;

    const space = getSpace(spaceId);
    if (!space || !space.folder) return;

    shell.openPath(resolveSpaceFolder(workspace, space.folder));
  });

  // ── Link preview ──────────────────────────────────────
  registerIpcHandler('canvas:fetch-link-meta', async (_event, url: string) => {
    return fetchLinkPreview(url);
  });

  // ── Canvas history ──────────────────────────────────────
  registerIpcHandler('canvas:history', async (_event, spaceId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { commits: [], error: 'no_workspace' };

    const space = getSpace(spaceId);
    if (!space || !space.folder) return { commits: [], error: 'not_found' };

    const commits = await getSpaceHistory(workspace, space.folder);
    return { commits };
  });

  registerIpcHandler('canvas:restore', async (_event, spaceId: string, sha: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { success: false, error: 'no_workspace' };

    const space = getSpace(spaceId);
    if (!space || !space.folder) return { success: false, error: 'not_found' };

    const result = await restoreSpaceVersion(workspace, space.folder, sha);
    if (result.success) {
      // Re-read canvas and update DB
      const content = readCanvas(workspace, space.folder);
      const titleUpdate = updateCanvasContent(spaceId, content);
      if (titleUpdate.titleChanged) {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('space:title-updated', { spaceId, title: titleUpdate.title });
        }
        mirrorRendererEvent('space:title-updated', { spaceId, title: titleUpdate.title });
      }
    }
    return result;
  });

  registerIpcHandler('canvas:preview-version', async (_event, spaceId: string, sha: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { content: '', error: 'no_workspace' };

    const space = getSpace(spaceId);
    if (!space || !space.folder) return { content: '', error: 'not_found' };

    return getSpaceVersionContent(workspace, space.folder, sha);
  });

  registerIpcHandler('canvas:read-activity-log', async (_event, spaceId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { events: [], error: 'no_workspace' };

    const space = getSpace(spaceId);
    if (!space || !space.folder) return { events: [], error: 'not_found' };

    const { readSpaceActivityLog } = await import('../space-eventlog');
    return { events: readSpaceActivityLog(workspace, space.folder) };
  });

  // ── Child pages ──────────────────────────────────────────
  registerIpcHandler('canvas:create-page', (_event, spaceId: string, pageName: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { success: false, page: '', error: 'no_workspace' };

    const space = getSpace(spaceId);
    if (!space) return { success: false, page: '', error: 'not_found' };

    let folder = space.folder;
    if (!folder) {
      folder = initSpaceCanvas(workspace, spaceId, space.description, space.body);
      assignSpaceFolder(spaceId, folder);
    }

    const result = createPage(workspace, folder, pageName);
    if ('error' in result) return { success: false, page: '', error: result.error };

    scheduleAutoCommit(workspace);
    return { success: true, page: result.page };
  });

  registerIpcHandler('canvas:read-page', (_event, spaceId: string, pageName: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { content: '', error: 'no_workspace' };

    const space = getSpace(spaceId);
    if (!space) return { content: '', error: 'not_found' };

    let folder = space.folder;
    if (!folder) {
      folder = initSpaceCanvas(workspace, spaceId, space.description, space.body);
      assignSpaceFolder(spaceId, folder);
    }

    const result = readPage(workspace, folder, pageName);
    if ('error' in result) return { content: '', error: result.error };
    const editorId = pageEditorId(spaceId, pageName);
    const resolvedPage = resolvePagePath(workspace, folder, pageName);
    if (!('error' in resolvedPage)) {
      rememberCanvasEditorContent(editorId, result.content);
      watchEditorFile(editorId, resolvedPage.path);
    }
    return { content: result.content };
  });

  registerIpcHandler('canvas:write-page', (_event, spaceId: string, pageName: string, content: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { success: false, error: 'no_workspace' };

    const space = getSpace(spaceId);
    if (!space) return { success: false, error: 'not_found' };

    let folder = space.folder;
    if (!folder) {
      folder = initSpaceCanvas(workspace, spaceId, space.description, space.body);
      assignSpaceFolder(spaceId, folder);
    }

    const resolvedPage = resolvePagePath(workspace, folder, pageName);
    if ('error' in resolvedPage) return { success: false, error: resolvedPage.error };
    const editorId = pageEditorId(spaceId, pageName);
    return writeEditorFileWithMerge(editorId, resolvedPage.path, content, (contentToWrite) => {
      const result = writePage(workspace, folder, pageName, contentToWrite);
      if ('error' in result) throw new Error(result.error);
    });
  });

  registerIpcHandler('canvas:close-page', (_event, spaceId: string, pageName: string, content: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { success: false, error: 'no_workspace' };

    const space = getSpace(spaceId);
    if (!space) return { success: false, error: 'not_found' };

    let folder = space.folder;
    if (!folder) {
      folder = initSpaceCanvas(workspace, spaceId, space.description, space.body);
      assignSpaceFolder(spaceId, folder);
    }

    const resolvedPage = resolvePagePath(workspace, folder, pageName);
    if ('error' in resolvedPage) return { success: false, error: resolvedPage.error };
    const editorId = pageEditorId(spaceId, pageName);
    const result = writeEditorFileWithMerge(editorId, resolvedPage.path, content, (contentToWrite) => {
      const pageResult = writePage(workspace, folder, pageName, contentToWrite);
      if ('error' in pageResult) throw new Error(pageResult.error);
    });
    return closeSucceeded(result, workspace, editorId);
  });

  registerIpcHandler('canvas:list-pages', (_event, spaceId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { pages: [], error: 'no_workspace' };

    const space = getSpace(spaceId);
    if (!space) return { pages: [], error: 'not_found' };

    let folder = space.folder;
    if (!folder) {
      folder = initSpaceCanvas(workspace, spaceId, space.description, space.body);
      assignSpaceFolder(spaceId, folder);
    }

    return { pages: listPages(workspace, folder) };
  });

  // ── Open link from canvas ─────────────────────────────────
  // Resolves file paths relative to the current canvas context and opens
  // .md files under workspace in a new canvas window, or opens externally.
  registerIpcHandler('canvas:open-link', (_event, spaceId: string, url: string) => {
    const target = resolveLinkFor(spaceId, url);
    if (!target) return { action: 'none' as const, error: 'no_workspace' };

    switch (target.kind) {
      case 'external':
        shell.openExternal(target.url);
        return { action: 'external' as const };
      case 'canvas':
        openFileInNewWindow(target.filePath);
        return { action: 'canvas' as const };
      case 'file':
        // Not a canvas — hand it to whatever the OS opens it with.
        shell.openPath(target.filePath);
        return { action: 'external' as const };
      default:
        return target.reason === 'invalid_url'
          ? { action: 'none' as const, error: 'invalid_url' }
          : { action: 'none' as const };
    }
  });

  // ── Decide what a link means, without acting on it ────
  //
  // The browser needs the same answer `canvas:open-link` acts on, but every
  // action above happens on the desktop machine — so it gets the decision and
  // applies it where it is: a new tab, or navigation within the page.
  registerIpcHandler('canvas:resolve-link', (_event, spaceId: string, url: string) => {
    return resolveLinkFor(spaceId, url) ?? { kind: 'none' as const, reason: 'no_workspace' as const };
  });

  // ── Rehydrate live comment-thread agents for a (re)mounted canvas ──
  // Returns the current state of every agent bound to a comment thread in this
  // space so the renderer can restore presence cursors, thread status, and
  // pending interactions after navigation, a pop-out, or an app restart.
  registerIpcHandler('canvas:get-agent-state', async (_event, spaceId: string) => {
    const { getCanvasAgentState } = await import('../agent-service');
    return getCanvasAgentState(spaceId);
  });
}

/** Resolve the base directory for relative path resolution based on the canvas context. */
function resolveCanvasBaseDir(workspace: string, spaceId: string): string | null {
  if (spaceId.startsWith('__file__')) {
    const filePath = decodeURIComponent(spaceId.slice('__file__'.length));
    return path.dirname(filePath);
  }

  const pageTarget = parseSyntheticPageId(spaceId);
  if (pageTarget) {
    const space = getSpace(pageTarget.realSpaceId);
    if (space?.folder) return resolveSpaceFolder(workspace, space.folder);
  }

  if (spaceId.startsWith('__skill__')) {
    return null; // Skills don't have a meaningful base dir for relative links
  }

  // Normal space
  const space = getSpace(spaceId);
  if (space?.folder) return resolveSpaceFolder(workspace, space.folder);

  return workspace;
}
