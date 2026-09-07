import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSync } from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { merge3Async } from './text-merge-node';
import { merge3 } from './text-merge';

const fixture = vi.hoisted(() => ({ worker: '' }));
vi.mock('node:worker_threads', async importOriginal => {
  const original = await importOriginal<typeof import('node:worker_threads')>();
  return {
    Worker: class extends original.Worker {
      constructor(filename: string, options: import('node:worker_threads').WorkerOptions) {
        expect(path.basename(filename)).toBe('text-merge-node-worker.js');
        super(fixture.worker, options);
      }
    },
  };
});

let directory: string;
beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-merge-worker-'));
  fixture.worker = path.join(directory, 'worker.cjs');
  buildSync({
    entryPoints: [path.resolve('src/shared/text-merge-node-worker.ts')],
    outfile: fixture.worker, bundle: true, platform: 'node', format: 'cjs',
  });
});
afterAll(() => {
  fs.unlinkSync(fixture.worker);
  fs.rmdirSync(directory);
});

const base = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
const ours = base.replace('line 10\n', 'local\n');
const theirs = base.replace('line 3900\n', 'remote\n');

describe('real Node merge workers', () => {
  it('returns the exact merge while the main event loop keeps ticking', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const result = await merge3Async(base, ours, theirs);
      expect(result).toEqual(merge3(base, ours, theirs));
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  });

  it('cancels active workers and releases their scheduling slots', async () => {
    const controller = new AbortController();
    const pending = merge3Async(base, ours, theirs, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('merge_cancelled');
    expect((await merge3Async(base, ours, theirs)).merged).toContain('remote');
  });

  it('rejects excess requests rather than retaining an unbounded queue', async () => {
    const first = merge3Async(base, ours, theirs);
    const second = merge3Async(base, ours, theirs);
    await expect(merge3Async(base, ours, theirs)).rejects.toThrow('merge_busy');
    await Promise.all([first, second]);
  });

  it('surfaces resource-limit errors from the worker without a replacement result', async () => {
    const text = (prefix: string) => Array.from({ length: 6000 }, (_, i) => `${prefix}${i}`).join('\n');
    await expect(merge3Async(text('a'), text('b'), text('c'))).rejects.toThrow('merge_resource_limit');
  });
});
