import { beforeEach, describe, expect, it, vi } from 'vitest';
import { merge3 } from '../../shared/text-merge';

const files = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('fs', () => {
  const readFileSync = vi.fn();
  let bytes: Buffer;
  let offset = 0;
  return {
    readFileSync,
    createReadStream: files.stream,
    openSync: vi.fn(() => { bytes = Buffer.from(readFileSync()); offset = 0; return 1; }),
    readSync: vi.fn((_fd, buffer: Buffer, start: number, length: number) => {
      const count = bytes.copy(buffer, start, offset, offset + length);
      offset += count;
      return count;
    }),
    closeSync: vi.fn(),
  };
});

vi.mock('../../shared/text-merge-node', () => ({
  merge3Async: vi.fn(),
}));

vi.mock('../storage', async () => ({
  ...(await import('../workspace')),
  ...(await import('./skill-schedule-store')),
  ...(await import('../canvas/artifact-store')),
  documentMatches: (await import('../storage-documents')).documentMatches,
  writeDocument: async (input: import('../storage-documents').DocumentWrite) => {
    (await import('../workspace')).writeCanvas(input.root, input.filePath.split('/').slice(-2)[0]!, input.content);
    return (await import('../storage')).updateCanvasContent(input.spaceId!, input.content);
  },
  getStorageGeneration: () => 0,
  withWorkspaceContext: (run: () => unknown) => run(),
  withStorageGeneration: (_generation: number, run: () => unknown) => run(),

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
import { updateCanvasContent } from '../storage';
import { clearSelfWrite, markSelfWrite } from '../canvas-watcher';
import { notifyAllWindows } from '../notify';
import { writeCanvas } from '../workspace';
import { merge3Async } from '../../shared/text-merge-node';
import { forgetCanvasEditorContent, rememberCanvasEditorContent, writeEditorFileWithMerge, writeMainCanvasWithMerge, writeEditorFileWithMergeAsync, writeMainCanvasWithMergeAsync } from './canvas-editor-state';

describe('canvas editor write state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    files.stream.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() { yield fs.readFileSync('/fixture', 'utf8'); },
    }));
    vi.mocked(merge3Async).mockImplementation(async (b, o, t) => merge3(b, o, t));
    vi.mocked(updateCanvasContent).mockResolvedValue({ title: 'title', titleChanged: false });
  });

  describe('asynchronous canvas merge revisions', () => {
    const base = 'base\nbody';
    const local = 'local\nbody';
    const disk = 'base\nremote';

    beforeEach(() => {
      vi.clearAllMocks();
      rememberCanvasEditorContent('async', base);
      files.stream.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() { yield disk; },
      }));
      vi.mocked(fs.readFileSync).mockReturnValue(disk);
      vi.mocked(merge3Async).mockImplementation(async (b, o, t) => merge3(b, o, t));
    });

    it('awaits the merge before marking or committing any content', async () => {
      let complete!: (result: ReturnType<typeof merge3>) => void;
      vi.mocked(merge3Async).mockReturnValue(new Promise(resolve => { complete = resolve; }));
      const pending = writeMainCanvasWithMergeAsync('/workspace', 'async', 'folder', local);
      await vi.waitFor(() => expect(merge3Async).toHaveBeenCalled());
      expect(writeCanvas).not.toHaveBeenCalled();
      expect(markSelfWrite).not.toHaveBeenCalled();
      complete(merge3(base, local, disk));
      expect(await pending).toEqual({ success: true, content: 'local\nremote' });
      expect(writeCanvas).toHaveBeenCalledWith('/workspace', 'folder', 'local\nremote');
    });

    it('refuses a stale disk revision instead of overwriting the newer version', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('newest disk version');
      const write = vi.fn();
      expect(await writeEditorFileWithMergeAsync('async', '/fixture.md', local, write))
        .toMatchObject({ success: false, error: expect.stringContaining('merge_stale') });
      expect(write).not.toHaveBeenCalled();
      expect(markSelfWrite).not.toHaveBeenCalled();
    });

    it('cancels pending work when the editor is reopened or forgotten', async () => {
      const write = vi.fn();
      vi.mocked(merge3Async).mockImplementation(async (_b, _o, _t, signal) => {
        forgetCanvasEditorContent('async');
        expect(signal?.aborted).toBe(true);
        return merge3(base, local, disk);
      });
      expect(await writeEditorFileWithMergeAsync('async', '/fixture.md', local, write))
        .toMatchObject({ success: false, error: expect.stringContaining('merge_stale') });
      expect(write).not.toHaveBeenCalled();
    });

    it('bounds concurrent saves by file path, including synchronous callers', async () => {
      let complete!: (result: ReturnType<typeof merge3>) => void;
      vi.mocked(merge3Async).mockReturnValue(new Promise(resolve => { complete = resolve; }));
      const write = vi.fn();
      const first = writeEditorFileWithMergeAsync('async', '/fixture.md', local, write);
      await vi.waitFor(() => expect(merge3Async).toHaveBeenCalled());
      expect(await writeEditorFileWithMergeAsync('alias', '/fixture.md', 'new local', write))
        .toEqual({ success: false, error: 'merge_busy' });
      expect(writeEditorFileWithMerge('alias', '/fixture.md', 'new local', write))
        .toEqual({ success: false, error: 'merge_busy' });
      complete(merge3(base, local, disk));
      expect((await first).success).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
    });

    it('preserves both versions and propagates worker resource failures', async () => {
      vi.mocked(merge3Async).mockRejectedValue(new Error('merge_resource_limit'));
      const write = vi.fn();
      expect(await writeEditorFileWithMergeAsync('async', '/fixture.md', local, write))
        .toEqual({ success: false, error: 'merge_resource_limit' });
      expect(write).not.toHaveBeenCalled();
      expect(markSelfWrite).not.toHaveBeenCalled();
    });

    it('bounds file reads and pending saves across different documents', async () => {
      const completions: Array<(result: ReturnType<typeof merge3>) => void> = [];
      vi.mocked(merge3Async).mockImplementation(() => new Promise(resolve => completions.push(resolve)));
      const writes = Array.from({ length: 8 }, async (_, index) => {
        rememberCanvasEditorContent(`bounded-${index}`, base);
        return (await writeEditorFileWithMergeAsync(`bounded-${index}`, `/fixture-${index}.md`, local, vi.fn()));
      });
      await vi.waitFor(() => expect(completions).toHaveLength(8));
      expect(await writeEditorFileWithMergeAsync('async', '/overflow.md', local, vi.fn()))
        .toEqual({ success: false, error: 'merge_busy' });
      expect(files.stream).toHaveBeenCalledTimes(8);
      for (const complete of completions) complete(merge3(base, local, disk));
      expect((await Promise.all(writes)).every(result => result.success)).toBe(true);
      for (let index = 0; index < 8; index++) forgetCanvasEditorContent(`bounded-${index}`);
    });

    it('requires async execution for large merges from legacy synchronous callers', () => {
      const largeBase = 'base\n'.repeat(1000);
      rememberCanvasEditorContent('async', largeBase);
      vi.mocked(fs.readFileSync).mockReturnValue(largeBase + 'remote');
      const write = vi.fn();
      expect(writeEditorFileWithMerge('async', '/fixture.md', 'local\n' + largeBase, write))
        .toMatchObject({ success: false, error: expect.stringContaining('merge_requires_async') });
      expect(write).not.toHaveBeenCalled();
    });
  });

  it('merges external disk changes with editor changes before writing', async () => {
    const base = 'title\nbody\n';
    const editor = 'title edited\nbody\n';
    const disk = 'title\nbody from agent\n';
    const expected = merge3(base, editor, disk).merged;

    rememberCanvasEditorContent('space-1', base);
    vi.mocked(fs.readFileSync).mockReturnValue(disk);

    const result = (await writeMainCanvasWithMerge('/workspace', 'space-1', 'space-folder', editor));

    expect(result).toEqual({ success: true, content: expected });
    expect(markSelfWrite).toHaveBeenCalledWith('space-1', expected);
    expect(writeCanvas).toHaveBeenCalledWith('/workspace', 'space-folder', expected);
    expect(vi.mocked(markSelfWrite).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(writeCanvas).mock.invocationCallOrder[0]);
    expect(updateCanvasContent).toHaveBeenCalledWith('space-1', expected);
  });

  it('writes editor content directly when no editor snapshot exists', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('disk changed');

    const result = (await writeMainCanvasWithMerge('/workspace', 'space-2', 'space-folder', 'editor'));

    expect(result).toEqual({ success: true, content: undefined });
    expect(writeCanvas).toHaveBeenCalledWith('/workspace', 'space-folder', 'editor');
  });

  it('notifies renderers when a write changes the derived title', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('editor');
    vi.mocked(updateCanvasContent).mockResolvedValueOnce({ title: 'New Title', titleChanged: true });

    (await writeMainCanvasWithMerge('/workspace', 'space-3', 'space-folder', '# New Title\n'));

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
