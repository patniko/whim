import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let workspace = '';
const spaces: any[] = [];
let activeAgentSpaceIds = new Set<string>();
const unarchived: string[] = [];
const cancelledRecurrences: string[] = [];
let unarchiveResult: 'ok' | 'fails' = 'ok';

vi.mock('../database', () => ({
  getLatestSpaceForSkill: (skillId: string) =>
    [...spaces].reverse().find(s => s.source_skill_id === skillId) ?? null,
  hasActiveAgentForSpace: (spaceId: string) => activeAgentSpaceIds.has(spaceId),
}));

vi.mock('./recurrence', () => ({
  cancelPendingRecurrence: (spaceId: string) => { cancelledRecurrences.push(spaceId); },
}));

vi.mock('./space-mutations', () => ({
  unarchiveSpaceFull: async (spaceId: string) => {
    unarchived.push(spaceId);
    if (unarchiveResult === 'fails') return null;
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return null;
    space.status = 'captured';
    space.completed_at = null;
    return space;
  },
}));

import { resolveSpaceForSkill, buildRefreshFraming } from './skill-space-reuse';

function addSpace(overrides: Partial<any> = {}): any {
  const space = {
    id: overrides.id ?? `space-${spaces.length + 1}`,
    source_skill_id: 'reporter',
    status: 'captured',
    folder: overrides.folder ?? `space-${spaces.length + 1}`,
    ...overrides,
  };
  if (space.folder) fs.mkdirSync(path.join(workspace, space.folder), { recursive: true });
  spaces.push(space);
  return space;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-space-reuse-'));
  spaces.length = 0;
  activeAgentSpaceIds = new Set();
  unarchived.length = 0;
  cancelledRecurrences.length = 0;
  unarchiveResult = 'ok';
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('resolveSpaceForSkill', () => {
  it('reuses the space a skill already has, so daily runs do not pile up', async () => {
    const existing = addSpace();
    const result = await resolveSpaceForSkill({ skillId: 'reporter', workspaceRoot: workspace });

    expect(result).toEqual({ space: existing, reason: 'reused' });
  });

  it('creates a new space on the first run', async () => {
    const result = await resolveSpaceForSkill({ skillId: 'reporter', workspaceRoot: workspace });
    expect(result).toEqual({ space: null, reason: 'new-first-run' });
  });

  it('ignores spaces belonging to other skills', async () => {
    addSpace({ source_skill_id: 'something-else' });
    const result = await resolveSpaceForSkill({ skillId: 'reporter', workspaceRoot: workspace });
    expect(result.reason).toBe('new-first-run');
  });

  it('honours a skill that wants a fresh space every time', async () => {
    addSpace();
    const result = await resolveSpaceForSkill({ skillId: 'reporter', workspaceRoot: workspace, spaceMode: 'new' });
    expect(result).toEqual({ space: null, reason: 'new-requested' });
  });

  it('reopens a completed space through unarchive, since completing archives the folder', async () => {
    const existing = addSpace({ status: 'done', completed_at: '2024-01-01T00:00:00.000Z' });

    const result = await resolveSpaceForSkill({ skillId: 'reporter', workspaceRoot: workspace });

    expect(unarchived).toEqual([existing.id]);
    expect(result.reason).toBe('reopened');
    expect(result.space?.completed_at).toBeNull();
  });

  it('cancels the recurrence a completed space queued, so the work is not done twice', async () => {
    const existing = addSpace({ status: 'done' });
    await resolveSpaceForSkill({ skillId: 'reporter', workspaceRoot: workspace });
    expect(cancelledRecurrences).toEqual([existing.id]);
  });

  it('falls back to a new space when the folder cannot be restored', async () => {
    addSpace({ status: 'done' });
    unarchiveResult = 'fails';

    const result = await resolveSpaceForSkill({ skillId: 'reporter', workspaceRoot: workspace });

    expect(result).toEqual({ space: null, reason: 'new-folder-missing' });
  });

  it('falls back to a new space when the folder is gone from disk', async () => {
    const existing = addSpace();
    fs.rmSync(path.join(workspace, existing.folder), { recursive: true, force: true });

    const result = await resolveSpaceForSkill({ skillId: 'reporter', workspaceRoot: workspace });

    expect(result).toEqual({ space: null, reason: 'new-folder-missing' });
  });

  it('does not write into a space that is mid-run', async () => {
    const existing = addSpace();
    activeAgentSpaceIds.add(existing.id);

    const result = await resolveSpaceForSkill({ skillId: 'reporter', workspaceRoot: workspace });

    // Skipping the occurrence would silently drop a scheduled run, which is
    // harder to notice than an extra space.
    expect(result).toEqual({ space: null, reason: 'new-agent-running' });
  });
});

describe('buildRefreshFraming', () => {
  it('is empty when there is nothing to refresh', () => {
    expect(buildRefreshFraming([])).toBe('');
  });

  it('points the agent at the previous report and its id', () => {
    const framing = buildRefreshFraming([
      { artifactId: 'open-questions', title: 'Open questions', relativeHtmlPath: 'reports/open-questions/index.html' },
    ]);

    expect(framing).toContain('reports/open-questions/index.html');
    expect(framing).toContain('open-questions');
    expect(framing).toContain('Publish to the same `artifactId`');
    expect(framing).toContain('what changed since last time');
  });

  it('mentions the structured payload when one exists', () => {
    const framing = buildRefreshFraming([
      {
        artifactId: 'open-questions',
        title: 'Open questions',
        relativeHtmlPath: 'reports/open-questions/index.html',
        relativeDataPath: 'reports/open-questions/data.json',
      },
    ]);

    expect(framing).toContain('data.json');
  });
});
