// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeInWorker, mergeWorkerUrl } from './merge-client';
import { merge3, type MergeResult } from '../../shared/text-merge';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: { data: { result?: MergeResult; error?: string } }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor(public url: URL) { FakeWorker.instances.push(this); }
}

const base = 'base\n'.repeat(1000);
const ours = base + 'local';
const theirs = 'remote\n' + base;

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('browser merge workers', () => {
  it.each([
    ['copilot-whim://app/renderer/index.html', 'copilot-whim://app/renderer/merge-worker.js'],
    ['file:///app/dist/renderer/index.html', 'file:///app/dist/renderer/merge-worker.js'],
    ['https://whim.test/', 'https://whim.test/merge-worker.js'],
    ['https://whim.test/desktop/', 'https://whim.test/desktop/merge-worker.js'],
    ['https://whim.test/desktop/index.html', 'https://whim.test/desktop/merge-worker.js'],
  ])('uses the explicit worker output URL for %s', (input, expected) => {
    expect(mergeWorkerUrl(new URL(input)).href).toBe(expected);
  });

  it('runs small merges locally but sends large merges to a worker', async () => {
    expect(await mergeInWorker('a', 'b', 'c')).toEqual(merge3('a', 'b', 'c'));
    expect(FakeWorker.instances).toHaveLength(0);
    const pending = mergeInWorker(base, ours, theirs);
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledWith({ base, ours, theirs });
    worker.onmessage?.({ data: { result: merge3(base, ours, theirs) } });
    expect(await pending).toEqual(merge3(base, ours, theirs));
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('cancels, ignores late responses and frees the worker slot', async () => {
    const controller = new AbortController();
    const pending = mergeInWorker(base, ours, theirs, controller.signal);
    const worker = FakeWorker.instances[0];
    controller.abort();
    worker.onmessage?.({ data: { result: merge3(base, ours, theirs) } });
    await expect(pending).rejects.toThrow('merge_cancelled');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('caps outstanding worker requests and surfaces startup failures', async () => {
    const first = mergeInWorker(base, ours, theirs);
    const second = mergeInWorker(base, ours, theirs);
    await expect(mergeInWorker(base, ours, theirs)).rejects.toThrow('merge_busy');
    FakeWorker.instances[0].onerror?.();
    FakeWorker.instances[1].onmessageerror?.();
    await expect(first).rejects.toThrow('merge_worker_failed');
    await expect(second).rejects.toThrow('merge_worker_invalid_response');
  });

  it('terminates timed-out workers without returning a lossy fallback', async () => {
    vi.useFakeTimers();
    const pending = mergeInWorker(base, ours, theirs);
    const assertion = expect(pending).rejects.toThrow('merge_timeout');
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });
});
