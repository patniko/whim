import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { merge3 } from '../../shared/text-merge';
import { merge3Async } from '../../shared/text-merge-node';
import { forgetCanvasEditorContent, rememberCanvasEditorContent, writeEditorFileWithMergeAsync } from './canvas-editor-state';

vi.mock('../storage', async () => ({
  ...(await import('../workspace')),
  ...(await import('./skill-schedule-store')),
  ...(await import('../canvas/artifact-store')),
  documentMatches: (await import('../storage-documents')).documentMatches,
  getStorageGeneration: () => 0,
  withWorkspaceContext: (run: () => unknown) => run(),
  withStorageGeneration: (_generation: number, run: () => unknown) => run(),
 updateCanvasContent: vi.fn() }));
vi.mock('../notify', () => ({ notifyAllWindows: vi.fn() }));
vi.mock('../canvas-watcher', () => ({ markSelfWrite: vi.fn(), clearSelfWrite: vi.fn() }));
vi.mock('../workspace', () => ({ resolveSpaceFolder: vi.fn(), writeCanvas: vi.fn() }));
vi.mock('../../shared/text-merge-node', () => ({ merge3Async: vi.fn() }));

let directory: string;
let file: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-merge-file-'));
  file = path.join(directory, 'canvas.md');
  vi.mocked(merge3Async).mockImplementation(async (base, ours, theirs) => merge3(base, ours, theirs));
});
afterEach(() => {
  forgetCanvasEditorContent('fixture');
  if (fs.existsSync(file)) fs.unlinkSync(file);
  fs.rmdirSync(directory);
});

describe('bounded merge file reads', () => {
  it('round-trips multibyte text across read-chunk boundaries', async () => {
    const base = `${'a'.repeat(65535)}\u{1f600}\nbody\ntail`;
    const disk = base.replace('tail', 'remote tail');
    const local = base.replace('body', 'local body');
    rememberCanvasEditorContent('fixture', base);
    fs.writeFileSync(file, disk);
    const result = await writeEditorFileWithMergeAsync('fixture', file, local, merged => fs.writeFileSync(file, merged));
    expect(result.success).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe(merge3(base, local, disk).merged);
  });

  it('does not overwrite disk changes made while the merge was running', async () => {
    rememberCanvasEditorContent('fixture', 'base');
    fs.writeFileSync(file, 'remote');
    vi.mocked(merge3Async).mockImplementation(async () => {
      fs.writeFileSync(file, 'newest remote');
      return merge3('base', 'local', 'remote');
    });
    const write = vi.fn();
    const result = await writeEditorFileWithMergeAsync('fixture', file, 'local', write);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('merge_stale') });
    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf-8')).toBe('newest remote');
  });

  it('rejects oversized disk input before merging or writing', async () => {
    fs.writeFileSync(file, 'x'.repeat(8 * 1024 * 1024 + 1));
    const size = fs.statSync(file).size;
    const write = vi.fn();
    const result = await writeEditorFileWithMergeAsync('fixture', file, 'local', write);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('merge_resource_limit') });
    expect(write).not.toHaveBeenCalled();
    expect(fs.statSync(file).size).toBe(size);
  });

  it('allows a still-missing new file but refuses deletion during a merge', async () => {
    expect(await writeEditorFileWithMergeAsync('fixture', file, 'new', content => fs.writeFileSync(file, content)))
      .toEqual({ success: true, content: undefined });
    fs.writeFileSync(file, 'remote');
    vi.mocked(merge3Async).mockImplementation(async () => {
      fs.unlinkSync(file);
      return merge3('new', 'local', 'remote');
    });
    const write = vi.fn();
    expect(await writeEditorFileWithMergeAsync('fixture', file, 'local', write))
      .toMatchObject({ success: false, error: expect.stringContaining('merge_stale') });
    expect(write).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });
});
