import * as fs from 'fs';
import * as path from 'path';
import { documentMatches, writeDocument } from '../storage';
import { clearSelfWrite, markSelfWrite } from '../canvas-watcher';
import { notifyAllWindows } from '../notify';
import { resolveSpaceFolder } from '../workspace';
import { merge3, needsMergeWorker, MergeLimitError } from '../../shared/text-merge';
import { merge3Async } from '../../shared/text-merge-node';

const CANVAS_FILE = 'canvas.md';

/**
 * Last content an editor read or wrote, keyed by real space id. Used to merge
 * external agent edits instead of blindly overwriting disk content.
 */
const lastEditorContent = new Map<string, string>();
const pendingWrites = new Map<string, { editorId: string; controller: AbortController }>();
const MAX_FILE_CHARACTERS = 8 * 1024 * 1024;

async function readMergeInput(filePath: string, signal: AbortSignal): Promise<string> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024, signal });
  const chunks: string[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const text = String(chunk);
    length += text.length;
    if (length > MAX_FILE_CHARACTERS) throw new MergeLimitError();
    chunks.push(text);
  }
  return chunks.join('');
}

export function rememberCanvasEditorContent(editorId: string, content: string): void {
  cancelEditorMerge(editorId);
  lastEditorContent.set(editorId, content);
}

export function forgetCanvasEditorContent(editorId: string): void {
  cancelEditorMerge(editorId);
  lastEditorContent.delete(editorId);
}

function cancelEditorMerge(editorId: string): void {
  for (const pending of pendingWrites.values()) {
    if (pending.editorId === editorId) pending.controller.abort();
  }
}

export interface CanvasWriteResult {
  success: boolean;
  /** Present when disk/editor content was merged and differs from the caller's input. */
  content?: string;
  error?: string;
}

export function writeEditorFileWithMerge(
  editorId: string,
  filePath: string,
  content: string,
  write: (contentToWrite: string) => void,
): CanvasWriteResult {
  if (pendingWrites.has(path.resolve(filePath))) return { success: false, error: 'merge_busy' };
  let contentToWrite = content;

  try {
    const diskContent = fs.readFileSync(filePath, 'utf-8');
    const lastKnown = lastEditorContent.get(editorId);
    if (lastKnown !== undefined && diskContent !== lastKnown && diskContent !== content) {
      if (needsMergeWorker(lastKnown, content, diskContent)) {
        return { success: false, error: 'merge_requires_async: Both versions are unchanged.' };
      }
      contentToWrite = merge3(lastKnown, content, diskContent).merged;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { success: false, error: 'read_failed' };
    }
  }

  try {
    markSelfWrite(editorId, contentToWrite);
    write(contentToWrite);
    lastEditorContent.set(editorId, contentToWrite);
    return { success: true, content: contentToWrite !== content ? contentToWrite : undefined };
  } catch {
    clearSelfWrite(editorId);
    return { success: false, error: 'write_failed' };
  }
}

/** The revision remains valid only while the editor snapshot and disk agree. */
export async function writeEditorFileWithMergeAsync(
  editorId: string,
  filePath: string,
  content: string,
  write: (contentToWrite: string, expected: string | undefined) => void | Promise<void>,
  sourceBase?: string,
): Promise<CanvasWriteResult> {
  const key = path.resolve(filePath);
  if (pendingWrites.has(key) || pendingWrites.size >= 8) return { success: false, error: 'merge_busy' };
  if (content.length > MAX_FILE_CHARACTERS) return { success: false, error: new MergeLimitError().message };
  const pending = { editorId, controller: new AbortController() };
  pendingWrites.set(key, pending);
  const editorBase = lastEditorContent.get(editorId);
  const base = sourceBase ?? editorBase;
  try {
    let disk: string | undefined;
    try {
      disk = await readMergeInput(filePath, pending.controller.signal);
    } catch (error) {
      if (pending.controller.signal.aborted) return { success: false, error: 'merge_cancelled' };
      if (error instanceof MergeLimitError) return { success: false, error: error.message };
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { success: false, error: 'read_failed' };
      }
    }
    let merged = content;
    if (base !== undefined && disk !== undefined && disk !== base && disk !== content) {
      try {
        merged = (await merge3Async(base, content, disk, pending.controller.signal)).merged;
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'merge_failed' };
      }
    }
    if (pending.controller.signal.aborted || lastEditorContent.get(editorId) !== editorBase) {
      return { success: false, error: 'merge_stale: Editor changed; retry saving.' };
    }
    // The worker repeats this revision check immediately before publication.
    try {
      if (!await documentMatches(filePath, disk)) return { success: false, error: 'merge_stale: Disk changed; retry saving.' };
    } catch {
      return { success: false, error: 'read_failed' };
    }
    try {
      markSelfWrite(editorId, merged);
      if (pending.controller.signal.aborted || lastEditorContent.get(editorId) !== editorBase) {
        return { success: false, error: 'merge_stale: Editor changed; retry saving.' };
      }
      await write(merged, disk);
      if (lastEditorContent.get(editorId) === editorBase) lastEditorContent.set(editorId, merged);
      return { success: true, content: merged !== content ? merged : undefined };
    } catch (error) {
      clearSelfWrite(editorId);
      return { success: false, error: error instanceof Error ? error.message : 'write_failed' };
    }
  } finally {
    pendingWrites.delete(key);
  }
}

export function writeMainCanvasWithMergeAsync(
  workspace: string, spaceId: string, folder: string, content: string,
  sourceBase?: string,
): Promise<CanvasWriteResult> {
  const canvasPath = path.join(resolveSpaceFolder(workspace, folder), CANVAS_FILE);
  return writeEditorFileWithMergeAsync(spaceId, canvasPath, content, async (contentToWrite, expected) => {
    const titleUpdate = await writeDocument({ filePath: canvasPath, root: workspace, content: contentToWrite, expected, spaceId });
    if (titleUpdate?.titleChanged) {
      notifyAllWindows('space:title-updated', { spaceId, title: titleUpdate.title });
    }
  }, sourceBase);
}

export function writeMainCanvasWithMerge(
  workspace: string,
  spaceId: string,
  folder: string,
  content: string,
): Promise<CanvasWriteResult> {
  return writeMainCanvasWithMergeAsync(workspace, spaceId, folder, content);
}
