import { describe, it, expect } from 'vitest';
import { GitQueue } from './git-queue';

describe('Git scheduling', () => {
  it('cancels background work before running a foreground mutation', async () => {
    const queue = new GitQueue();
    const order: string[] = [];
    const background = queue.enqueue(signal => new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { order.push('cancel'); resolve(); });
    }), true);
    const foreground = queue.enqueue(async () => { order.push('write'); });
    await Promise.all([background, foreground]);
    expect(order).toEqual(['cancel', 'write']);
  });

  it('prioritizes foreground jobs and never overlaps index mutations', async () => {
    const queue = new GitQueue();
    let release!: () => void;
    const first = queue.enqueue(() => new Promise<void>(resolve => { release = resolve; }));
    const order: string[] = [];
    const background = queue.enqueue(async () => { order.push('background'); }, true);
    const foreground = queue.enqueue(async () => { order.push('foreground'); });
    release();
    await Promise.all([first, background, foreground]);
    expect(order).toEqual(['foreground', 'background']);
    await queue.drain();
  });

  it('bounds queued mutations and recovers after a rejected operation', async () => {
    const queue = new GitQueue();
    let release!: () => void;
    const first = queue.enqueue(() => new Promise<void>(resolve => { release = resolve; }));
    const jobs = Array.from({ length: 64 }, () => queue.enqueue(async () => undefined));
    await expect(queue.enqueue(async () => undefined)).rejects.toThrow('full');
    release();
    await Promise.all([first, ...jobs]);
    await expect(queue.enqueue(async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    await expect(queue.enqueue(async () => 'next')).resolves.toBe('next');
  });
});
