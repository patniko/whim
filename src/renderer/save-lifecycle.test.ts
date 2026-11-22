// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorFlushRequest, EditorFlushResult } from '../shared/ipc-contract';
import { FormDrafts, installSaveLifecycle, trackSettingWrites } from './save-lifecycle';

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
    const tracked = trackSettingWrites({ savePersonas: fail, saveCliTools: fail });
    await tracked.api.savePersonas();
    await tracked.api.saveCliTools();
    tracked.discardFailure('savePersonas');
    await expect(tracked.flush()).rejects.toThrow('failed');
    tracked.discardFailure('saveCliTools');
    await expect(tracked.flush()).resolves.toBeUndefined();
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
