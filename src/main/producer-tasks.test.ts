import { describe, expect, it } from 'vitest';
import { drainProducers, pauseWorkspaceCommands, runWorkspaceCommand } from './producer-tasks';

describe('workspace command drainage', () => {
  it('allows updater preparation to drain without waiting for its own IPC handler', async () => {
    expect(await runWorkspaceCommand('update:install', async () => {
      await drainProducers();
      return 'prepared';
    })).toBe('prepared');
  });

  it('rejects new commands during teardown and resumes after cancellation', async () => {
    const resume = pauseWorkspaceCommands();
    try {
      await expect(runWorkspaceCommand('space:create', () => 'not admitted')).rejects.toThrow('transition');
    } finally { resume(); }
    expect(await runWorkspaceCommand('space:create', () => 'admitted')).toBe('admitted');
  });
});
