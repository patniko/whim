// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Skill } from '../../shared/types';
import { skillStore } from '../state/skill-store';
import { SkillsList, type SkillsListProps } from './SkillsList';

const skill: Skill = {
  id: 'messages', name: 'Missed messages', description: 'Follow-ups', emoji: '',
  folder: '', filePath: '', schedule: 'daily', schedule_time: '09:00', schedule_day: null,
  next_run_at: '2026-09-08T09:00:00Z', last_run_at: '2026-09-07T09:00:00Z', created_at: '', updated_at: '',
  canvas: 'legacy-report',
  schedule_details: {
    id: 'schedule', skillId: 'messages', frequency: 'daily', time: '09:00', day: null,
    enabled: true, output: 'canvas', createdAt: '', updatedAt: '', nextRunAt: null,
    timeZone: 'Europe/London', intent: '', readOnlyServers: [],
    lastRun: {
      id: 'run', scheduledAt: '2026-09-07T09:00:00Z', startedAt: '2026-09-07T09:00:00Z',
      completedAt: '2026-09-07T09:00:00Z', status: 'ready', attempt: 1, spaceId: 'result', summary: 'Three messages need a reply.',
    },
  },
};
let host: HTMLDivElement;
let root: Root;
let actions: Omit<SkillsListProps, 'filterQuery'>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-07T11:00:00Z'));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  skillStore.setSkills([skill]);
  actions = {
    onSkillClick: vi.fn(), onRunNow: vi.fn(), onSchedule: vi.fn(), onOpenResult: vi.fn(),
    onCreateSpace: vi.fn(), onOpenFolder: vi.fn(), onDelete: vi.fn(),
  };
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  skillStore.setSkills([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('SkillsList scheduled outcomes', () => {
  it('shows outcome, summary, timezone and past-tense last run without a report badge', () => {
    act(() => root.render(<SkillsList {...actions} />));
    expect(host.textContent).toContain('Ready');
    expect(host.textContent).toContain('Three messages need a reply.');
    expect(host.textContent).toContain('Europe/London');
    expect(host.textContent).toContain('2h ago');
    expect(host.querySelector('.skill-report')).toBeNull();
    expect(host.querySelector('[title="Edit schedule"]')).not.toBeNull();
  });
  it('opens latest result without opening the skill card', () => {
    act(() => root.render(<SkillsList {...actions} />));
    act(() => host.querySelector<HTMLButtonElement>('.skill-result-link')!.click());
    expect(actions.onOpenResult).toHaveBeenCalledWith('result');
    expect(actions.onSkillClick).not.toHaveBeenCalled();
  });
  it('shows failed latest outcome and links the previous successful result when needed', () => {
    const details = skill.schedule_details!;
    skillStore.setSkills([{ ...skill, schedule_details: {
      ...details, lastRun: { ...details.lastRun!, status: 'failed', spaceId: undefined, summary: 'Connection interrupted.' },
      lastSuccessfulRun: details.lastRun,
    } }]);
    act(() => root.render(<SkillsList {...actions} />));
    expect(host.textContent).toContain('Failed');
    expect(host.textContent).toContain('Connection interrupted.');
    act(() => host.querySelector<HTMLButtonElement>('.skill-result-link')!.click());
    expect(actions.onOpenResult).toHaveBeenCalledWith('result');
  });
  it('keeps legacy report badges and independent run-now behavior', () => {
    skillStore.setSkills([{ ...skill, schedule_details: undefined }]);
    act(() => root.render(<SkillsList {...actions} />));
    expect(host.querySelector('.skill-report')).not.toBeNull();
    expect(host.querySelector('.skill-result-link')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[title="Run now"]')!.click());
    expect(actions.onRunNow).toHaveBeenCalledWith(skill.id);
    expect(actions.onSchedule).not.toHaveBeenCalled();
    expect(actions.onSkillClick).not.toHaveBeenCalled();
  });
});
