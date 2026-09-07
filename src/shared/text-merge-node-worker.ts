import { parentPort, workerData } from 'node:worker_threads';
import { merge3 } from './text-merge';

const { base, ours, theirs } = workerData as { base: string; ours: string; theirs: string };
try {
  parentPort!.postMessage({ result: merge3(base, ours, theirs) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : 'merge_failed' });
}
