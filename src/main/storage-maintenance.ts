import { compactOldSegments, getStorageGeneration, withStorageGeneration } from './storage';
import { getLogRoot } from './workspace';

let first: ReturnType<typeof setTimeout> | undefined;
let periodic: ReturnType<typeof setInterval> | undefined;

export function stopStorageMaintenance(): void {
  clearTimeout(first);
  clearInterval(periodic);
  first = periodic = undefined;
}

export function startStorageMaintenance(workspace: string): void {
  stopStorageMaintenance();
  const generation = getStorageGeneration();
  const run = async () => {
    try {
      await withStorageGeneration(generation, () => compactOldSegments(getLogRoot(workspace)));
    } catch (error) {
      console.error('[maintenance] Compaction failed; source data retained:', error);
    }
  };
  first = setTimeout(run, 30_000);
  periodic = setInterval(run, 24 * 60 * 60_000);
  first.unref();
  periodic.unref();
}
