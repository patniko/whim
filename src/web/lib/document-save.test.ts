import { describe, expect, it, vi } from 'vitest';
import { DocumentSave } from './document-save';
import type { CanvasSaveResult } from '../../shared/ipc-contract';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

describe('revision-aware browser document saves', () => {
  it('keeps rejected workspace saves dirty and supports explicit retry', async () => {
    let content = 'unsaved draft';
    const write = vi.fn().mockRejectedValueOnce(new Error('Workspace changed'))
      .mockResolvedValue({ success: true });
    const save = new DocumentSave(() => content, next => { content = next; }, write);
    save.changed();
    await expect(save.flush()).rejects.toThrow('Workspace changed');
    expect(save.hasDirty()).toBe(true);
    expect(content).toBe('unsaved draft');
    await save.flush();
    expect(save.hasDirty()).toBe(false);
  });

  it('never acknowledges a failed save result as durable', async () => {
    const save = new DocumentSave(() => 'draft', vi.fn(), async () => ({ success: false, error: 'merge_stale' }));
    save.changed();
    await expect(save.flush()).rejects.toThrow('merge_stale');
    expect(save.hasDirty()).toBe(true);
  });

  it('serializes saves and preserves typing that arrives during an acknowledgement', async () => {
    let content = 'one\ntwo\nthree';
    const first = deferred<CanvasSaveResult>();
    const write = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ success: true });
    const save = new DocumentSave(() => content, next => { content = next; }, write);
    save.changed();
    const flushing = save.flush();
    expect(save.flush()).toBe(flushing);
    content = 'one\nnewer local\nthree';
    save.changed();
    first.resolve({ success: true, content: 'one\ntwo\nremote edit' });
    await flushing;
    expect(write.mock.calls.map(args => args[0])).toEqual([
      'one\ntwo\nthree', 'one\nnewer local\nremote edit',
    ]);
    expect(content).toBe('one\nnewer local\nremote edit');
    expect(save.hasDirty()).toBe(false);
  });

  it('preserves both conflicting versions and requires explicit review before another write', async () => {
    let content = 'original';
    const first = deferred<CanvasSaveResult>();
    const write = vi.fn().mockReturnValueOnce(first.promise);
    const save = new DocumentSave(() => content, next => { content = next; }, write);
    save.changed();
    const flushing = save.flush();
    content = 'local edit';
    save.changed();
    first.resolve({ success: true, content: 'remote edit' });
    await expect(flushing).rejects.toThrow('Review');
    expect(content).toContain('local edit');
    expect(content).toContain('remote edit');
    expect(save.hasDirty()).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
