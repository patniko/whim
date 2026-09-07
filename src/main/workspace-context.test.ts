import { describe, expect, it, vi } from 'vitest';
import { advanceWorkspaceGeneration, assertWorkspaceContext, withWorkspaceContext, workspaceCallback } from './workspace-context';

describe('workspace continuation isolation', () => {
  it('rejects an old asynchronous continuation before it can notify the new workspace', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const work = withWorkspaceContext(async () => {
      await gate;
      assertWorkspaceContext();
    });
    advanceWorkspaceGeneration();
    release();
    await expect(work).rejects.toThrow('Stale workspace');
    expect(() => withWorkspaceContext(assertWorkspaceContext)).not.toThrow();
  });

  it('does not apply a native notification action to a replacement workspace', () => {
    const action = vi.fn();
    const callback = workspaceCallback(action);
    callback();
    advanceWorkspaceGeneration();
    callback();
    expect(action).toHaveBeenCalledTimes(1);
  });
});
