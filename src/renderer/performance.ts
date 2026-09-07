import { enablePerformance, recordTiming } from '../shared/performance';
export { startTiming, getPerformanceTimings } from '../shared/performance';

const enabled = new URLSearchParams(location.search).get('perf') === '1';
enablePerformance(enabled);
export function observeRendererTasks(): () => void {
  if (!enabled || typeof PerformanceObserver === 'undefined' ||
    !PerformanceObserver.supportedEntryTypes.includes('longtask')) return () => {};
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) recordTiming('renderer.long-task', entry.duration);
  });
  observer.observe({ type: 'longtask', buffered: true });
  return () => observer.disconnect();
}
