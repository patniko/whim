// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorFlushRequest, EditorFlushResult } from '../shared/ipc-contract';
import { FormDrafts, installSaveLifecycle, trackSettingWrites } from './save-lifecycle';
import { DebouncedSave } from './debounced-save';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe('durable renderer lifecycle', () => {
  it('locks every shell, awaits durable work, and unlocks only the matching release', async () => {
    let request!: (value: EditorFlushRequest) => void;
    let release!: (token: string) => void;
    const replies: EditorFlushResult[] = [];
    const pending = deferred<void>();
    const lock = vi.fn();
    const cleanup = installSaveLifecycle({
      onEditorFlushRequest: callback => { request = callback; return vi.fn(); },
      onEditorFlushReleased: callback => { release = callback; return vi.fn(); },
      respondEditorFlush: reply => replies.push(reply),
    }, () => pending.promise, vi.fn(), lock);
    request({ token: 'fixture', reason: 'quit' });
    expect(lock).toHaveBeenLastCalledWith(true);
    expect(replies).toEqual([]);
    pending.resolve();
    await vi.waitFor(() => expect(replies).toEqual([{ token: 'fixture', ok: true }]));
    release('stale');
    expect(lock).toHaveBeenLastCalledWith(true);
    release('fixture');
    expect(lock).toHaveBeenLastCalledWith(false);
    cleanup();
  });

  it('retains a failed setting write until that write succeeds on retry', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue('saved');
    const tracked = trackSettingWrites(Object.freeze({ setSetting: write }));
    await expect(tracked.api.setSetting('theme', 'dark')).rejects.toThrow('disk full');
    await expect(tracked.flush()).rejects.toThrow('failed');
    await tracked.api.setSetting('theme', 'dark');
    await expect(tracked.flush()).resolves.toBeUndefined();
  });

  it('does not acknowledge an error-shaped settings result', async () => {
    const tracked = trackSettingWrites({ savePersonas: async () => ({ error: 'invalid' }) });
    await expect(tracked.api.savePersonas()).resolves.toEqual({ error: 'invalid' });
    await expect(tracked.flush()).rejects.toThrow('failed');
  });

  it('explicitly cancels only the selected failed settings operation', async () => {
    const fail = async () => ({ error: 'invalid' });
    const tracked = trackSettingWrites({ savePersonas: fail, saveRuntimes: fail });
    await tracked.api.savePersonas();
    await tracked.api.saveRuntimes();
    tracked.discardFailure('savePersonas');
    await expect(tracked.flush()).rejects.toThrow('failed');
    tracked.discardFailure('saveRuntimes');
    await expect(tracked.flush()).resolves.toBeUndefined();
  });

  it('flushes a debounce and edits queued behind an in-flight write', async () => {
    vi.useFakeTimers();
    let value = 'first';
    const saved: string[] = [];
    const first = deferred<void>();
    const write = vi.fn(async () => {
      const snapshot = value;
      if (write.mock.calls.length === 1) await first.promise;
      saved.push(snapshot);
    });
    const draft = new DebouncedSave(write, vi.fn());
    draft.schedule();
    const flushing = draft.flush();
    const simultaneous = draft.flush();
    value = 'newer';
    draft.schedule();
    first.resolve();
    await Promise.all([flushing, simultaneous]);
    expect(saved).toEqual(['first', 'newer']);
    await vi.advanceTimersByTimeAsync(500);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('keeps rejected debounced content retryable', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const draft = new DebouncedSave(write, vi.fn());
    draft.schedule();
    await expect(draft.flush()).rejects.toThrow('disk full');
    await draft.flush();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('does not clear a settings form modified after its save snapshot', () => {
    const form = document.createElement('form');
    document.body.append(form);
    const drafts = new FormDrafts();
    drafts.changed(form);
    const revision = drafts.revision(form);
    drafts.changed(form);
    expect(drafts.saved(form, revision)).toBe(false);
    expect(() => drafts.assertClean()).toThrow('Save or cancel');
    expect(drafts.saved(form, drafts.revision(form))).toBe(true);
    expect(() => drafts.assertClean()).not.toThrow();
  });
});
