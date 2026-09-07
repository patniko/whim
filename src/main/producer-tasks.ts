const active = new Set<Promise<unknown>>();
let paused = false;

export function pauseWorkspaceCommands(): () => void {
  if (paused) throw new Error('Workspace transition already in progress');
  paused = true;
  return () => { paused = false; };
}

export async function runWorkspaceCommand<T>(channel: string, run: () => T): Promise<Awaited<T>> {
  if (paused) throw new Error('Workspace transition in progress; retry the operation');
  // The transition drains commands; it must not wait for itself.
  if (['workspace:select', 'workspace:clear', 'profiles:add', 'profiles:activate', 'profiles:cycle', 'profiles:remove', 'update:install'].includes(channel)) {
    return await run();
  }
  return await observeProducer(Promise.resolve().then(run));
}

/** Keep asynchronous event listeners observable even when the emitter ignores their return value. */
export function observeProducer<T>(operation: Promise<T>): Promise<T> {
  active.add(operation);
  void operation.then(
    () => active.delete(operation),
    error => {
      active.delete(operation);
      console.error('[producer] Background operation failed:', error);
    },
  );
  return operation;
}

export async function drainProducers(): Promise<void> {
  while (active.size) await Promise.all([...active]);
}
