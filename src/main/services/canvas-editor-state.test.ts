import { beforeEach, describe, expect, it, vi } from 'vitest';
import { merge3 } from '../../shared/text-merge';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('../database', () => ({
  updateCanvasContent: vi.fn(),
}));

vi.mock('../notify', () => ({
  notifyAllWindows: vi.fn(),
}));

vi.mock('../canvas-watcher', () => ({
  clearSelfWrite: vi.fn(),
  markSelfWrite: vi.fn(),
}));

vi.mock('../workspace', () => ({
  resolveSpaceFolder: vi.fn((workspace: string, folder: string) => `${workspace}/${folder}`),
  writeCanvas: vi.fn(),
}));

import * as fs from 'fs';
import { updateCanvasContent } from '../database';
import { clearSelfWrite, markSelfWrite } from '../canvas-watcher';
import { notifyAllWindows } from '../notify';
import { writeCanvas } from '../workspace';
import { rememberCanvasEditorContent, writeEditorFileWithMerge, writeMainCanvasWithMerge } from './canvas-editor-state';

describe('canvas editor write state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateCanvasContent).mockReturnValue({ title: 'title', titleChanged: false });
  });

  it('merges external disk changes with editor changes before writing', () => {
    const base = 'title\nbody\n';
    const editor = 'title edited\nbody\n';
    const disk = 'title\nbody from agent\n';
    const expected = merge3(base, editor, disk).merged;

    rememberCanvasEditorContent('space-1', base);
    vi.mocked(fs.readFileSync).mockReturnValueOnce(disk);

    const result = writeMainCanvasWithMerge('/workspace', 'space-1', 'space-folder', editor);

    expect(result).toEqual({ success: true, content: expected });
    expect(markSelfWrite).toHaveBeenCalledWith('space-1', expected);
    expect(writeCanvas).toHaveBeenCalledWith('/workspace', 'space-folder', expected);
    expect(vi.mocked(markSelfWrite).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(writeCanvas).mock.invocationCallOrder[0]);
    expect(updateCanvasContent).toHaveBeenCalledWith('space-1', expected);
  });

  it('writes editor content directly when no editor snapshot exists', () => {
    vi.mocked(fs.readFileSync).mockReturnValueOnce('disk changed');

    const result = writeMainCanvasWithMerge('/workspace', 'space-2', 'space-folder', 'editor');

    expect(result).toEqual({ success: true, content: undefined });
    expect(writeCanvas).toHaveBeenCalledWith('/workspace', 'space-folder', 'editor');
  });

  it('notifies renderers when a write changes the derived title', () => {
    vi.mocked(fs.readFileSync).mockReturnValueOnce('editor');
    vi.mocked(updateCanvasContent).mockReturnValueOnce({ title: 'New Title', titleChanged: true });

    writeMainCanvasWithMerge('/workspace', 'space-3', 'space-folder', '# New Title\n');

    expect(notifyAllWindows).toHaveBeenCalledWith('space:title-updated', {
      spaceId: 'space-3',
      title: 'New Title',
    });
  });

  it('merges external changes for any editor-backed markdown file', () => {
    const write = vi.fn();
    rememberCanvasEditorContent('__page__space-1/notes', 'base\n');
    vi.mocked(fs.readFileSync).mockReturnValueOnce('base\nexternal\n');

    const result = writeEditorFileWithMerge(
      '__page__space-1/notes',
      '/workspace/space/notes.md',
      'local\n',
      write,
    );

    const expected = merge3('base\n', 'local\n', 'base\nexternal\n').merged;
    expect(result).toEqual({ success: true, content: expected });
    expect(markSelfWrite).toHaveBeenCalledWith('__page__space-1/notes', expected);
    expect(write).toHaveBeenCalledWith(expected);
  });

  it('refuses to overwrite when the current disk content cannot be read', () => {
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => { throw error; });
    const write = vi.fn();

    expect(writeEditorFileWithMerge('file', '/workspace/file.md', 'editor', write))
      .toEqual({ success: false, error: 'read_failed' });
    expect(write).not.toHaveBeenCalled();
  });

  it('returns a structured failure when the file write fails', () => {
    vi.mocked(fs.readFileSync).mockReturnValueOnce('base');

    const result = writeEditorFileWithMerge('file', '/workspace/file.md', 'editor', () => {
      throw new Error('disk full');
    });

    expect(result).toEqual({ success: false, error: 'write_failed' });
    expect(clearSelfWrite).toHaveBeenCalledWith('file');
  });
});
