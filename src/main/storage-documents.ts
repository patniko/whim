import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { isPathContainedBy } from './workspace';
import { updateCanvasContent } from './database';
import { syncDirectory, writeAll } from './persistence-snapshot';

export function documentMatches(filePath: string, expected: string | undefined): boolean {
  let fd: number;
  try { fd = fs.openSync(filePath, 'r'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return expected === undefined;
    throw error;
  }
  try {
    if (expected === undefined) return false;
    const bytes = Buffer.from(expected);
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) return position === bytes.length;
      if (!chunk.subarray(0, count).equals(bytes.subarray(position, position + count))) return false;
      position += count;
    }
  } finally { fs.closeSync(fd); }
}

export interface DocumentWrite {
  filePath: string;
  root: string;
  content: string;
  expected: string | undefined;
  spaceId?: string;
  strict?: boolean;
}

export function checkDocumentPath(root: string, filePath: string): void {
  if (!isPathContainedBy(root, filePath)) throw new Error('Document is outside the permitted workspace');
  let current = root;
  for (const part of path.relative(root, filePath).split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic-link paths are not authorized.');
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('The owned canvas must be an ordinary, unlinked file.');
}

export function readDocument(filePath: string, root: string, strict = false): string {
  if (!isPathContainedBy(root, filePath)) throw new Error('Document is outside the permitted workspace');
  if (strict) checkDocumentPath(root, filePath);
  if (fs.statSync(filePath).size > 8 * 1024 * 1024) throw new Error('Canvas exceeds the safe merge size.');
  return fs.readFileSync(filePath, 'utf8');
}

/** Compare and durably publish in the sole persistence owner, then update the projection. */
export function writeDocument(input: DocumentWrite): { title?: string; titleChanged?: boolean } {
  if (!isPathContainedBy(input.root, input.filePath)) throw new Error('Document is outside the permitted workspace');
  if (input.strict) checkDocumentPath(input.root, input.filePath);
  if (!documentMatches(input.filePath, input.expected)) throw new Error('merge_stale: Disk changed; retry saving.');
  let mode = 0o600;
  try { mode = fs.statSync(input.filePath).mode & 0o777; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const target = fs.existsSync(input.filePath) ? fs.realpathSync(input.filePath) : input.filePath;
  const temporary = path.join(path.dirname(target), `.whim-save-${randomUUID()}`);
  try {
    const fd = fs.openSync(temporary, 'wx', mode);
    try {
      writeAll(fd, input.content);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (!isPathContainedBy(input.root, target) || !documentMatches(target, input.expected)) {
      throw new Error('merge_stale: Disk changed; retry saving.');
    }
    if (input.strict) checkDocumentPath(input.root, input.filePath);
    fs.renameSync(temporary, target);
    syncDirectory(path.dirname(target));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return input.spaceId ? updateCanvasContent(input.spaceId, input.content) : {};
}
