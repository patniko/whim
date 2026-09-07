import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export const workspaceContext = new AsyncLocalStorage<number>();
export let workspaceGeneration = 0;
const processEpoch = randomUUID();
export function getWorkspaceEpoch(): string { return `${processEpoch}:${workspaceGeneration}`; }

export function advanceWorkspaceGeneration(): void { workspaceGeneration++; }
export function withWorkspaceContext<T>(run: () => T): T {
  return workspaceContext.run(workspaceGeneration, run);
}
export function withStorageGeneration<T>(expected: number, run: () => T): T {
  if (expected !== workspaceGeneration) throw new Error('Stale workspace operation');
  return workspaceContext.run(expected, run);
}
export function assertWorkspaceContext(): void {
  const expected = workspaceContext.getStore();
  if (expected !== undefined && expected !== workspaceGeneration) throw new Error('Stale workspace operation');
}

export function workspaceCallback<T extends unknown[]>(callback: (...args: T) => void): (...args: T) => void {
  const expected = workspaceContext.getStore() ?? workspaceGeneration;
  return (...args) => {
    if (expected !== workspaceGeneration) {
      console.info('[workspace] Ignored a callback from a closed workspace');
      return;
    }
    withStorageGeneration(expected, () => callback(...args));
  };
}
