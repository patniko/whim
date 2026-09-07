import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { merge3, needsMergeWorker, MergeLimitError, type MergeResult } from './text-merge';
import { startTiming } from './performance';

let active = 0;

/** No unbounded queue of document copies; a busy caller retains its unsaved input. */
export async function merge3Async(
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
      const worker = new Worker(path.join(__dirname, 'text-merge-node-worker.js'), {
        workerData: { base, ours, theirs },
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
      });
      let settled = false;
      const finish = (error?: Error, result?: MergeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
        // Do not release a scheduling slot until the cancelled worker exits.
        void worker.terminate().then(() => {
          if (error) reject(error);
          else resolve(result!);
        }, reject);
      };
      const cancel = () => finish(new Error('merge_cancelled'));
      const timeout = setTimeout(() => finish(new Error('merge_timeout: Both versions are unchanged.')), 10_000);
      signal?.addEventListener('abort', cancel, { once: true });
      worker.once('message', (message: { result?: MergeResult; error?: string }) => {
        if (message.error) finish(new Error(message.error));
        else if (message.result) finish(undefined, message.result);
        else finish(new Error('merge_worker_invalid_response'));
      });
      worker.once('error', error => finish(error));
      worker.once('exit', code => {
        if (!settled) finish(new Error(`merge_worker_exited:${code}`));
      });
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
