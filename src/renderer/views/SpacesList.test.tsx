// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Skill, Space } from '../../shared/types';
import type { ScheduledRunStatus } from '../../shared/skill-schedule';
import { spaceStore } from '../state/space-store';
import { skillStore } from '../state/skill-store';
import { agentStore } from '../state/agent-store';
import { groupScheduledSpaces, SpacesList, type SpacesListActions } from './SpacesList';

function space(id: string, source_skill_id: string | null = 'messages'): Space {
  return {
    id, description: id, source_skill_id, body: '', raw_text: '', client: null,
    due_at: null, due_at_utc: null, recurrence: null, completed_at: null, folder: null,
    session_id: null, attachments: [], status: 'captured', created_at: '', updated_at: '',
  };
}
function scheduledSkill(status: ScheduledRunStatus = 'ready'): Skill {
  return {
    id: 'messages', name: 'Missed messages', description: '', emoji: '', folder: '', filePath: '',
    schedule: 'daily', schedule_time: '09:00', schedule_day: null, next_run_at: null,
    last_run_at: null, created_at: '', updated_at: '',
    schedule_details: {
      id: 'schedule', skillId: 'messages', frequency: 'daily', time: '09:00', day: null, enabled: true,
      output: 'canvas', createdAt: '', updatedAt: '', nextRunAt: null,
      timeZone: 'UTC', intent: '', readOnlyServers: [],
    },
    schedule_runs: [
      { id: 'old-run', scheduledAt: '2026-09-06T09:00:00Z', startedAt: '2026-09-06T09:00:00Z', status, attempt: 1, spaceId: 'older' },
      { id: 'new-run', scheduledAt: '2026-09-07T09:00:00Z', startedAt: '2026-09-07T09:00:00Z', status: 'ready', attempt: 1, spaceId: 'newest' },
    ],
  };
}
const spaces = [space('older'), space('manual'), space('newest'), space('unrelated', null)];

describe('scheduled history provenance', () => {
  it('groups only known older completed runs, retaining manual and unrelated spaces', () => {
    const result = groupScheduledSpaces(spaces, [scheduledSkill()], new Set());
    expect(result.current.map(s => s.id)).toEqual(['manual', 'newest', 'unrelated']);
    expect(result.history[0].spaces.map(s => s.id)).toEqual(['older']);
  });
  it.each(['running', 'failed', 'partial', 'needs-connection'] as const)('never hides a %s scheduled outcome', status => {
    expect(groupScheduledSpaces(spaces, [scheduledSkill(status)], new Set()).history).toEqual([]);
  });
  it('does not hide a space with an active session, pending approval, failure, or focus', () => {
    expect(groupScheduledSpaces(spaces, [scheduledSkill()], new Set(['older'])).history).toEqual([]);
  });
  it('does not guess provenance for legacy schedules or lastRun-only data', () => {
    const skill = scheduledSkill();
    expect(groupScheduledSpaces(spaces, [{ ...skill, schedule_details: { ...skill.schedule_details!, output: 'legacy' } }], new Set()).history).toEqual([]);
    expect(groupScheduledSpaces(spaces, [{ ...skill, schedule_runs: undefined }], new Set()).history).toEqual([]);
  });
});

let host: HTMLDivElement;
let root: Root;
let actions: SpacesListActions;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  spaceStore.reset();
  spaceStore.setSpaces(spaces);
  spaceStore.setFocusedSpace(null);
  skillStore.setSkills([scheduledSkill()]);
  agentStore.reset();
  actions = {
    onSpaceClick: vi.fn(), onToggleStatus: vi.fn(), onDelete: vi.fn(), onFocus: vi.fn(),
    onOpenArtifact: vi.fn(), onAgentClick: vi.fn(), onVisibleSpacesChange: vi.fn(),
  };
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  spaceStore.reset();
  skillStore.setSkills([]);
  agentStore.reset();
  vi.unstubAllGlobals();
});
describe('SpacesList history expansion', () => {
  it('shows a complete 44-space list without paging bookkeeping', () => {
    const items = Array.from({ length: 44 }, (_, i) => space(`Space ${i}`, null));
    spaceStore.setPage({ items, total: 44, nextCursor: null, counts: { open: 44, closed: 0 } });
    act(() => root.render(<SpacesList {...actions} />));
    expect(host.querySelector('[data-id="Space 0"]')).not.toBeNull();
    expect(host.querySelector('nav')).toBeNull();
    expect(host.textContent).not.toMatch(/shown|total|Previous|Next/);
  });
  it('expands known history and reports visible row order for keyboard navigation', () => {
    act(() => root.render(<SpacesList {...actions} />));
    expect(host.querySelector('[data-id="older"]')).toBeNull();
    const button = host.querySelector<HTMLButtonElement>('.schedule-history-toggle')!;
    expect(button.textContent).toContain('Missed messages history (1)');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    act(() => button.click());
    expect(host.querySelector('[data-id="older"]')).not.toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(actions.onVisibleSpacesChange).toHaveBeenLastCalledWith([
      spaces[1], spaces[2], spaces[3], spaces[0],
    ]);
    act(() => button.click());
    expect(host.querySelector('[data-id="older"]')).toBeNull();
  });
  it('does not collapse search matches', () => {
    act(() => root.render(<SpacesList {...actions} searchResults={spaces} />));
    expect(host.querySelector('[data-id="older"]')).not.toBeNull();
    expect(host.querySelector('.schedule-history-toggle')).toBeNull();
  });
  it('keeps older spaces with waiting agents visible', () => {
    agentStore.setAgents([{
      agentId: 'agent', spaceId: 'older', sessionId: 'session', status: 'waiting-approval',
      summary: '', selectedText: '', source: 'sdk',
      createdAt: '', pendingApprovalId: null, pendingPermissionKind: null,
      pendingIntention: null, pendingPath: null, personaHandle: null, yoloMode: false,
      sandboxed: false, quotedText: '', runLocation: 'local', anchor: { quote: '', prefix: '', suffix: '' },
    }]);
    act(() => root.render(<SpacesList {...actions} />));
    expect(host.querySelector('[data-id="older"]')).not.toBeNull();
    expect(host.querySelector('.schedule-history-toggle')).toBeNull();
    expect(host.textContent).toContain('needs attention');
  });
});
