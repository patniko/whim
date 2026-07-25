import * as fs from 'fs';
import * as path from 'path';
import { updateCanvasContent } from '../database';
import { clearSelfWrite, markSelfWrite } from '../canvas-watcher';
import { notifyAllWindows } from '../notify';
import { resolveSpaceFolder, writeCanvas } from '../workspace';
import { merge3 } from '../../shared/text-merge';

const CANVAS_FILE = 'canvas.md';

/**
 * Last content an editor read or wrote, keyed by real space id. Used to merge
 * external agent edits instead of blindly overwriting disk content.
 */
const lastEditorContent = new Map<string, string>();

export function rememberCanvasEditorContent(editorId: string, content: string): void {
  lastEditorContent.set(editorId, content);
}

export function forgetCanvasEditorContent(editorId: string): void {
  lastEditorContent.delete(editorId);
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
  let contentToWrite = content;

  try {
    const diskContent = fs.readFileSync(filePath, 'utf-8');
    const lastKnown = lastEditorContent.get(editorId);
    if (lastKnown !== undefined && diskContent !== lastKnown && diskContent !== content) {
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

export function writeMainCanvasWithMerge(
  workspace: string,
  spaceId: string,
  folder: string,
  content: string,
): CanvasWriteResult {
  const canvasPath = path.join(resolveSpaceFolder(workspace, folder), CANVAS_FILE);
  return writeEditorFileWithMerge(spaceId, canvasPath, content, (contentToWrite) => {
    writeCanvas(workspace, folder, contentToWrite);
    const titleUpdate = updateCanvasContent(spaceId, contentToWrite);
    if (titleUpdate?.titleChanged) {
      notifyAllWindows('space:title-updated', { spaceId, title: titleUpdate.title });
    }
  });
}
