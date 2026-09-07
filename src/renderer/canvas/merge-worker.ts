import { merge3 } from '../../shared/text-merge';

self.onmessage = (event: MessageEvent<{ base: string; ours: string; theirs: string }>) => {
  const { base, ours, theirs } = event.data;
  try {
    self.postMessage({ result: merge3(base, ours, theirs) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'merge_failed' });
  }
};
