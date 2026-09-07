export type PerfSpan = 'startup.storage' | 'startup.shell' | 'startup.capture'
  | 'save.capture' | 'save.document' | 'storage.roundtrip' | 'storage.execution'
  | 'git.queue' | 'git.network' | 'git.reconcile' | 'merge' | 'renderer.refresh' | 'renderer.long-task';

interface Timing { count: number; totalMs: number; maxMs: number; failures: number }
const timings = new Map<PerfSpan, Timing>();
let enabled = typeof process !== 'undefined' && process.env?.WHIM_PERF === '1';

export function enablePerformance(value: boolean): void { enabled = value; }
export function recordTiming(span: PerfSpan, durationMs: number, ok = true): void {
  if (!enabled || !Number.isFinite(durationMs) || durationMs < 0) return;
  const prior = timings.get(span) ?? { count: 0, totalMs: 0, maxMs: 0, failures: 0 };
  timings.set(span, {
    count: prior.count + 1, totalMs: prior.totalMs + durationMs,
    maxMs: Math.max(prior.maxMs, durationMs), failures: prior.failures + Number(!ok),
  });
}
export function startTiming(span: PerfSpan): (ok?: boolean) => void {
  if (!enabled) return () => {};
  const start = performance.now();
  let ended = false;
  return (ok = true) => {
    if (ended) return;
    ended = true;
    recordTiming(span, performance.now() - start, ok);
  };
}
export function getPerformanceTimings(): Partial<Record<PerfSpan, Timing>> {
  return Object.fromEntries([...timings].map(([span, value]) => [span, { ...value }]));
}
