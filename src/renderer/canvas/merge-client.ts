import { merge3, needsMergeWorker, MergeLimitError, type MergeResult } from '../../shared/text-merge';
import { startTiming } from '../../shared/performance';

let active = 0;
declare const __WHIM_MERGE_WORKER_FILE__: string;
const workerFile = typeof __WHIM_MERGE_WORKER_FILE__ === 'string' ? __WHIM_MERGE_WORKER_FILE__ : 'merge-worker.js';

export function mergeWorkerUrl(location: Pick<Location, 'protocol' | 'href' | 'pathname'>): URL {
  // Desktop and popouts load under renderer/. The two browser shells are
  // served at / and /desktop/; document.baseURI is deliberately not used (CSP).
  if (location.protocol === 'copilot-whim:' || location.protocol === 'file:') {
    return new URL(workerFile, location.href);
  }
  const desktop = location.pathname === '/desktop' || location.pathname.startsWith('/desktop/');
  return new URL(`${desktop ? '/desktop/' : '/'}${workerFile}`, location.href);
}

export async function mergeInWorker(
  base: string, ours: string, theirs: string, signal?: AbortSignal,
): Promise<MergeResult> {
  if (signal?.aborted) throw new Error('merge_cancelled');
  if (!needsMergeWorker(base, ours, theirs)) return merge3(base, ours, theirs);
  if (base.length + ours.length + theirs.length > 8 * 1024 * 1024) throw new MergeLimitError();
  if (active >= 2) throw new Error('merge_busy: Retry saving; both versions are unchanged.');
  active++;
  const end = startTiming('merge');
  try {
    return await new Promise<MergeResult>((resolve, reject) => {
      const worker = new Worker(mergeWorkerUrl(window.location));
      let settled = false;
      const finish = (error?: Error, result?: MergeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
        worker.terminate();
        if (error) reject(error);
        else resolve(result!);
      };
      const cancel = () => finish(new Error('merge_cancelled'));
      const timeout = setTimeout(() => finish(new Error('merge_timeout: Both versions are unchanged.')), 10_000);
      signal?.addEventListener('abort', cancel, { once: true });
      worker.onmessage = (event: MessageEvent<{ result?: MergeResult; error?: string }>) => {
        if (event.data.error) finish(new Error(event.data.error));
        else if (event.data.result) finish(undefined, event.data.result);
        else finish(new Error('merge_worker_invalid_response'));
      };
      worker.onerror = () => finish(new Error('merge_worker_failed: Both versions are unchanged.'));
      worker.onmessageerror = () => finish(new Error('merge_worker_invalid_response'));
      try {
        worker.postMessage({ base, ours, theirs });
      } catch (error) {
        finish(error instanceof Error ? error : new Error('merge_worker_failed'));
      }
      if (signal?.aborted) cancel();
    });
  } catch (error) {
    end(false);
    throw error;
  } finally {
    end();
    active--;
  }
}
