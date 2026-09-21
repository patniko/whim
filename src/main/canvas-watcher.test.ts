import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { startWatching, stopWatching, markSelfWrite, isWatching, stopAllWatchers, refreshWatchedCanvases } from './canvas-watcher';

describe('canvas-watcher', () => {
  let tmpDir: string;
  let canvasPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-watcher-'));
    canvasPath = path.join(tmpDir, 'canvas.md');
    fs.writeFileSync(canvasPath, '# Initial content\n', 'utf-8');
  });

  afterEach(() => {
    stopAllWatchers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts and stops watching without error', () => {
    const onChange = vi.fn();
    startWatching('space1', canvasPath, onChange);
    expect(isWatching('space1')).toBe(true);
    stopWatching('space1');
    expect(isWatching('space1')).toBe(false);
  });

  it('detects external file changes', async () => {
    const onChange = vi.fn();
    startWatching('space1', canvasPath, onChange);

    // Small delay to let fs.watch fully initialize
    await new Promise(resolve => setTimeout(resolve, 100));

    // Simulate agent writing to the file
    fs.writeFileSync(canvasPath, '# Agent modified\n', 'utf-8');

    // Wait for debounce (250ms) + some margin
    await new Promise(resolve => setTimeout(resolve, 500));

    expect(onChange).toHaveBeenCalledWith('# Agent modified\n');

    stopWatching('space1');
  });

  it('retries a failed delivery without another disk revision or fs event', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onChange = vi.fn().mockRejectedValueOnce(new Error('Storage busy')).mockResolvedValue(undefined);
    startWatching('space1', canvasPath, onChange);
    fs.writeFileSync(canvasPath, '# Retry this revision\n');
    await expect(refreshWatchedCanvases()).rejects.toThrow('Storage busy');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await refreshWatchedCanvases();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls.map(call => call[0])).toEqual(['# Retry this revision\n', '# Retry this revision\n']);
  });

  it('serializes refreshes and reads the newest revision after a pending delivery', async () => {
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const delivered: string[] = [];
    const onChange = vi.fn(async (content: string) => {
      if (content === '# First\n') { entered(); await pending; }
      delivered.push(content);
    });
    startWatching('space1', canvasPath, onChange);
    fs.writeFileSync(canvasPath, '# First\n');
    const first = refreshWatchedCanvases();
    await ready;
    fs.writeFileSync(canvasPath, '# Superseded\n');
    const second = refreshWatchedCanvases();
    fs.writeFileSync(canvasPath, '# Newest\n');
    const third = refreshWatchedCanvases();
    expect(onChange).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second, third]);
    expect(delivered).toEqual(['# First\n', '# Newest\n']);
    await refreshWatchedCanvases();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('retains self-write suppression after a failed external delivery', async () => {
    const onChange = vi.fn().mockRejectedValueOnce(new Error('Storage busy')).mockResolvedValue(undefined);
    startWatching('space1', canvasPath, onChange);
    fs.writeFileSync(canvasPath, '# External\n');
    await expect(refreshWatchedCanvases()).rejects.toThrow('Storage busy');
    markSelfWrite('space1', '# Editor\n');
    fs.writeFileSync(canvasPath, '# Editor\n');
    await refreshWatchedCanvases();
    expect(onChange).toHaveBeenCalledTimes(1);
    fs.writeFileSync(canvasPath, '# New external\n');
    await refreshWatchedCanvases();
    expect(onChange).toHaveBeenLastCalledWith('# New external\n');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('ignores self-writes when markSelfWrite is called', async () => {
    const onChange = vi.fn();
    startWatching('space1', canvasPath, onChange);

    const newContent = '# Editor wrote this\n';
    markSelfWrite('space1', newContent);
    fs.writeFileSync(canvasPath, newContent, 'utf-8');

    await new Promise(resolve => setTimeout(resolve, 500));

    expect(onChange).not.toHaveBeenCalled();

    stopWatching('space1');
  });

  it('fires for changes after a self-write', async () => {
    const onChange = vi.fn();
    startWatching('space1', canvasPath, onChange);

    // First: self-write (should be ignored)
    const editorContent = '# Editor content\n';
    markSelfWrite('space1', editorContent);
    fs.writeFileSync(canvasPath, editorContent, 'utf-8');

    await new Promise(resolve => setTimeout(resolve, 500));
    expect(onChange).not.toHaveBeenCalled();

    // Second: external write (should be detected)
    fs.writeFileSync(canvasPath, '# Agent content\n', 'utf-8');

    await new Promise(resolve => setTimeout(resolve, 500));
    expect(onChange).toHaveBeenCalledWith('# Agent content\n');

    stopWatching('space1');
  });

  it('does not fire for identical content', async () => {
    const onChange = vi.fn();
    startWatching('space1', canvasPath, onChange);

    // Write the same content that's already there
    fs.writeFileSync(canvasPath, '# Initial content\n', 'utf-8');

    await new Promise(resolve => setTimeout(resolve, 500));

    expect(onChange).not.toHaveBeenCalled();

    stopWatching('space1');
  });

  it('handles re-watching the same spaceId', () => {
    const onChange1 = vi.fn();
    const onChange2 = vi.fn();

    startWatching('space1', canvasPath, onChange1);
    expect(isWatching('space1')).toBe(true);

    // Re-start should close the old watcher
    startWatching('space1', canvasPath, onChange2);
    expect(isWatching('space1')).toBe(true);

    stopWatching('space1');
  });

  it('stopAllWatchers cleans up everything', () => {
    const onChange = vi.fn();
    startWatching('space1', canvasPath, onChange);
    startWatching('space2', canvasPath, onChange);
    expect(isWatching('space1')).toBe(true);
    expect(isWatching('space2')).toBe(true);

    stopAllWatchers();
    expect(isWatching('space1')).toBe(false);
    expect(isWatching('space2')).toBe(false);
  });

  it('restores watchers and reconciles changes made during cancelled shutdown', async () => {
    const onChange = vi.fn();
    startWatching('space1', canvasPath, onChange);
    const restore = stopAllWatchers();
    fs.writeFileSync(canvasPath, '# Changed while suspended\n');
    expect(onChange).not.toHaveBeenCalled();
    await restore();
    expect(isWatching('space1')).toBe(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith('# Changed while suspended\n');
  });

  it('watches the directory even before a document is created', () => {
    const onChange = vi.fn();
    const fakePath = path.join(tmpDir, 'nonexistent.md');
    // Should not throw
    startWatching('space-fake', fakePath, onChange);
    expect(isWatching('space-fake')).toBe(true);
  });

  it('continues observing replacements after an atomic self-save', async () => {
    const changed = vi.fn();
    startWatching('space1', canvasPath, changed);
    const replacement = path.join(tmpDir, 'replacement');
    markSelfWrite('space1', '# Saved\n');
    fs.writeFileSync(replacement, '# Saved\n');
    fs.renameSync(replacement, canvasPath);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(changed).not.toHaveBeenCalled();
    fs.writeFileSync(replacement, '# External replacement\n');
    fs.renameSync(replacement, canvasPath);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('# External replacement\n'), { timeout: 2000 });
    fs.writeFileSync(canvasPath, '# Later external edit\n');
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('# Later external edit\n'), { timeout: 2000 });
  });
});
