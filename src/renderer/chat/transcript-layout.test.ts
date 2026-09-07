import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../shared/chat-types';
import { MAX_WINDOW_ROWS, prependHistoryPage, TranscriptLayout } from './transcript-layout';

const messages = (count: number): ChatMessage[] => Array.from({ length: count }, (_, i) => ({
  id: String(i), type: 'assistant', content: `synthetic ${i}`, isStreaming: false, timestamp: '',
}));

describe('variable-height transcript geometry', () => {
  it('keeps pinned historical requests in sequence and reconciles later durable resolutions', () => {
    const pending: ChatMessage = {
      id: 'pending', type: 'approval', agentId: 'agent', requestId: 'request',
      permissionKind: 'write', responded: false, timestamp: '', sequence: 1,
    };
    const latest: ChatMessage = { ...messages(1)[0], id: 'latest', sequence: 100 };
    const older: ChatMessage = { ...messages(1)[0], id: 'older', sequence: 50 };
    const merged = prependHistoryPage([pending, latest], [older]);
    expect(merged.map(message => message.id)).toEqual(['pending', 'older', 'latest']);
    const resolved = prependHistoryPage(merged, [{ ...pending, responded: true, approved: true }]);
    expect(resolved[0]).toMatchObject({ responded: true, approved: true });
    expect(prependHistoryPage(resolved, [pending])[0]).toMatchObject({ responded: true, approved: true });
  });
  it('bounds a 100,000-message transcript to 80 ordinary mounted rows', () => {
    const fixture = messages(100_000);
    const started = performance.now();
    const layout = new TranscriptLayout(fixture, new Map());
    const geometryBuildMs = performance.now() - started;
    const samples: number[] = [];
    let maximumRows = 0;
    for (let i = 0; i < 1000; i++) {
      const startTime = performance.now();
      const range = layout.window(i * 9999, 600);
      samples.push(performance.now() - startTime);
      maximumRows = Math.max(maximumRows, range.end - range.start);
    }
    samples.sort((a, b) => a - b);
    console.info('[chat-perf-fixture]', JSON.stringify({
      rows: fixture.length, geometryBuildMs, lookupP95Ms: samples[949], maximumRows,
    }));
    for (const top of [0, 50_000, 5_000_000, 9_999_400]) {
      const { start, end } = layout.window(top, 600);
      expect(end - start).toBeLessThanOrEqual(MAX_WINDOW_ROWS);
      expect(start).toBeLessThanOrEqual(layout.indexAt(top));
      expect(end).toBeGreaterThan(layout.indexAt(top));
    }
  });

  it('updates prefix heights and locates rows after expansion', () => {
    const layout = new TranscriptLayout(messages(100), new Map());
    expect(layout.measure('2', 204)).toBe(true);
    expect(layout.offset(3)).toBe(404);
    expect(layout.indexAt(403)).toBe(2);
    expect(layout.indexAt(404)).toBe(3);
    expect(layout.total).toBe(10_104);
    expect(layout.measure('2', 204)).toBe(false);
  });

  it('does not leave viewport gaps for unusually short rows or tall windows', () => {
    const fixture = messages(10_000);
    const layout = new TranscriptLayout(fixture, new Map(fixture.map(message => [message.id, 4])));
    for (const height of [600, 4000]) {
      const range = layout.window(1000, height);
      expect(layout.offset(range.start)).toBeLessThanOrEqual(1000);
      expect(layout.offset(range.end)).toBeGreaterThan(1000 + height);
      expect(range.end - range.start).toBeLessThanOrEqual(Math.ceil(height / 4) + 18);
    }
  });

  it('retains measured heights and anchor offsets across overlapping prepends', () => {
    const current = messages(20).slice(10);
    const older = messages(15);
    const merged = prependHistoryPage(current, older);
    expect(merged).toHaveLength(20);
    expect(merged[10]).toBe(current[0]);
    const measured = new Map([['12', 304]]);
    const before = new TranscriptLayout(current, measured);
    const after = new TranscriptLayout(merged, measured);
    const anchor = { id: '13', offset: 17 };
    const oldTop = before.offset(before.positions.get(anchor.id)!) + anchor.offset;
    const newTop = after.offset(after.positions.get(anchor.id)!) + anchor.offset;
    expect(newTop - oldTop).toBe(1000);
    expect(after.indexAt(newTop)).toBe(13);
  });

  it('keeps live interaction resolutions when older pages use different display IDs', () => {
    const current: ChatMessage = { id: 'live', type: 'approval', agentId: 'a',
      requestId: 'request', permissionKind: 'read', responded: true, approved: false, timestamp: '' };
    const older = { ...current, id: 'history:request', responded: false };
    expect(prependHistoryPage([current], [older])).toEqual([current]);
  });
});
