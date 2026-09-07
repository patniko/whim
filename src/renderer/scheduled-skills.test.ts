// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Skill } from '../shared/types';
import { createSchedulePicker, formatScheduleDate, scheduleSources, type SchedulePickerAPI } from './scheduled-skills';

const skill: Skill = {
  id: 'missed-messages', name: 'Missed messages', description: '', emoji: '',
  folder: '', filePath: '', schedule: null, schedule_time: null, schedule_day: null,
  next_run_at: null, last_run_at: null, created_at: '', updated_at: '',
};
const scheduled: Skill = {
  ...skill, schedule: 'daily', canvas: 'original-template', space_mode: 'reuse',
  schedule_details: {
    id: 'schedule', skillId: skill.id, frequency: 'daily', time: '09:00', day: null,
    enabled: true, output: 'canvas', createdAt: '', updatedAt: '', nextRunAt: null,
    timeZone: 'America/New_York', intent: 'Look for follow-ups', readOnlyServers: ['disconnected'],
  },
};

async function mount(value = skill, overrides: Partial<SchedulePickerAPI> = {}) {
  const api = {
    listSkillScheduleSources: vi.fn(async () => [{ name: 'Slack' }, { name: 'GitHub' }]),
    setSkillSchedule: vi.fn(async () => scheduled),
    clearSkillSchedule: vi.fn(async () => ({ success: true })),
    ...overrides,
  };
  const actions = { onClose: vi.fn(), onSaved: vi.fn(), onRunNow: vi.fn() };
  const picker = createSchedulePicker(value, api, actions);
  actions.onClose.mockImplementation(() => picker.remove());
  document.body.append(picker);
  await new Promise(resolve => setTimeout(resolve, 0));
  return { api, actions, picker };
}
function input<T extends HTMLElement>(picker: HTMLElement, selector: string): T {
  return picker.querySelector<T>(selector)!;
}
async function submit(picker: HTMLElement) {
  picker.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('scheduled skill picker', () => {
  it('keeps timing primary and optional details collapsed with the time zone visible', async () => {
    const { picker } = await mount(scheduled);
    expect(picker.querySelector('.schedule-primary-fields #schedule-frequency')).not.toBeNull();
    expect(picker.querySelector('.schedule-primary-fields #schedule-time')).not.toBeNull();
    expect(input<HTMLDetailsElement>(picker, '#schedule-timezone-details').open).toBe(false);
    expect(input<HTMLDetailsElement>(picker, '#schedule-intent-details').open).toBe(false);
    expect(picker.querySelector('#schedule-timezone-summary')?.textContent).toBe('America/New_York');
    expect(picker.querySelector('#schedule-intent-summary')?.textContent).toBe('Additional instructions (included)');
    expect(input<HTMLTextAreaElement>(picker, '#schedule-intent').value).toBe('Look for follow-ups');
    const zone = input<HTMLInputElement>(picker, '#schedule-timezone');
    zone.value = 'Europe/London';
    zone.dispatchEvent(new Event('input'));
    expect(picker.querySelector('#schedule-timezone-summary')?.textContent).toBe('Europe/London');
  });

  it('reveals collapsed time zone details when required-field validation fails', async () => {
    const { picker, actions } = await mount();
    input<HTMLInputElement>(picker, '#schedule-timezone').value = '';
    await submit(picker);
    expect(input<HTMLDetailsElement>(picker, '#schedule-timezone-details').open).toBe(true);
    expect(actions.onSaved).not.toHaveBeenCalled();
  });

  it('defaults to daily and local time zone, with sources checked but not approved until saving', async () => {
    const { picker, api } = await mount();
    expect(input<HTMLSelectElement>(picker, '#schedule-frequency').value).toBe('daily');
    expect(input<HTMLInputElement>(picker, '#schedule-timezone').value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(picker.querySelectorAll('#schedule-sources input:checked')).toHaveLength(2);
    expect(picker.textContent).toContain('Creates a dated space with results on its canvas');
    expect(picker.textContent).toContain('Messages are not sent automatically');
    expect(picker.textContent).toContain('catches up once');
    expect(picker.textContent).not.toContain('Publish a report');
    expect(picker.querySelector('#schedule-migrate-canvas')).toBeNull();
    expect(picker.querySelector('option[value=""]')).toBeNull();
    expect(api.setSkillSchedule).not.toHaveBeenCalled();
    await submit(picker);
    expect(api.setSkillSchedule).toHaveBeenCalledWith(skill.id, 'daily', '09:00', null, {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, intent: '', readOnlyServers: ['Slack', 'GitHub'],
    });
  });

  it('preserves saved consent and disconnected sources when editing', async () => {
    const { picker, api } = await mount(scheduled);
    expect(picker.textContent).toContain('disconnected (not configured)');
    expect([...picker.querySelectorAll<HTMLInputElement>('#schedule-sources input:checked')].map(i => i.value)).toEqual(['disconnected']);
    expect(input<HTMLInputElement>(picker, '#schedule-timezone').value).toBe('America/New_York');
    expect(input<HTMLTextAreaElement>(picker, '#schedule-intent').value).toBe('Look for follow-ups');
    await submit(picker);
    expect(api.setSkillSchedule).toHaveBeenCalledWith(skill.id, 'daily', '09:00', null, {
      timeZone: 'America/New_York', intent: 'Look for follow-ups', readOnlyServers: ['disconnected'],
    });
  });

  it('preserves legacy output instead of changing canvas settings', async () => {
    const { picker, api } = await mount({ ...scheduled, schedule_details: undefined });
    expect(picker.textContent).toContain('legacy schedule');
    expect(picker.querySelectorAll('#schedule-sources input:checked')).toHaveLength(0);
    expect(input<HTMLInputElement>(picker, '#schedule-migrate-canvas').checked).toBe(false);
    await submit(picker);
    expect(api.setSkillSchedule).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.setSkillSchedule).mock.calls[0]?.[4]).not.toHaveProperty('migrateToCanvas');
  });

  it('migrates a legacy schedule only on explicit opt-in with the chosen read-only sources', async () => {
    const { picker, api } = await mount({
      ...scheduled, schedule_details: { ...scheduled.schedule_details!, output: 'legacy' },
    });
    const migrate = input<HTMLInputElement>(picker, '#schedule-migrate-canvas');
    expect(migrate.checked).toBe(false);
    migrate.click();
    expect(picker.querySelector('.schedule-preview')?.textContent).toContain('Creates a dated space');
    expect(picker.textContent).toContain('Existing spaces and reports are kept');
    input<HTMLInputElement>(picker, '#schedule-sources input[value="Slack"]').checked = true;
    expect(api.setSkillSchedule).not.toHaveBeenCalled();
    await submit(picker);
    expect(api.setSkillSchedule).toHaveBeenCalledWith(skill.id, 'daily', '09:00', null, {
      timeZone: 'America/New_York', intent: 'Look for follow-ups',
      readOnlyServers: ['Slack', 'disconnected'], migrateToCanvas: true,
    });
  });

  it('does not migrate when opting back out or running now', async () => {
    const { picker, api } = await mount({
      ...scheduled, schedule_details: { ...scheduled.schedule_details!, output: 'legacy' },
    });
    const migrate = input<HTMLInputElement>(picker, '#schedule-migrate-canvas');
    migrate.click();
    migrate.click();
    expect(picker.querySelector('.schedule-preview')?.textContent).toContain('legacy schedule');
    await submit(picker);
    expect(vi.mocked(api.setSkillSchedule).mock.calls[0]?.[4]).not.toHaveProperty('migrateToCanvas');
    vi.mocked(api.setSkillSchedule).mockClear();
    migrate.click();
    input<HTMLButtonElement>(picker, '.schedule-run-btn').click();
    expect(api.setSkillSchedule).not.toHaveBeenCalled();
  });

  it('previews a fresh canvas schedule after removing a legacy schedule', async () => {
    const { picker, api } = await mount({
      ...scheduled, schedule: null,
      schedule_details: { ...scheduled.schedule_details!, enabled: false, output: 'legacy' },
    });
    expect(picker.querySelector('#schedule-migrate-canvas')).toBeNull();
    expect(picker.querySelector('.schedule-preview')?.textContent).toContain('Creates a dated space');
    expect(input<HTMLButtonElement>(picker, '.schedule-save-btn').textContent).toBe('Create schedule');
    await submit(picker);
    expect(vi.mocked(api.setSkillSchedule).mock.calls[0]?.[4]).not.toHaveProperty('migrateToCanvas');
  });

  it('uses fresh defaults and new source consent after removal, without disconnected approvals', async () => {
    const { picker, api } = await mount({
      ...scheduled, schedule: null, schedule_details: {
        ...scheduled.schedule_details!, enabled: false, frequency: 'weekly', time: '17:30', day: 4,
      },
    });
    expect(input<HTMLButtonElement>(picker, '.schedule-save-btn').textContent).toBe('Create schedule');
    expect(input<HTMLButtonElement>(picker, '.schedule-clear-btn').hidden).toBe(true);
    expect(input<HTMLSelectElement>(picker, '#schedule-frequency').value).toBe('daily');
    expect(input<HTMLInputElement>(picker, '#schedule-time').value).toBe('09:00');
    expect(input<HTMLTextAreaElement>(picker, '#schedule-intent').value).toBe('');
    expect(input<HTMLInputElement>(picker, '#schedule-timezone').value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect([...picker.querySelectorAll<HTMLInputElement>('#schedule-sources input:checked')].map(i => i.value)).toEqual(['Slack', 'GitHub']);
    expect(picker.textContent).not.toContain('disconnected');
    await submit(picker);
    expect(api.setSkillSchedule).toHaveBeenCalledWith(skill.id, 'daily', '09:00', null, {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, intent: '', readOnlyServers: ['Slack', 'GitHub'],
    });
  });

  it('shows weekday only when relevant and sends edited fields on save', async () => {
    const { picker, api } = await mount();
    const frequency = input<HTMLSelectElement>(picker, '#schedule-frequency');
    expect(input(picker, '#schedule-day-row').hidden).toBe(true);
    frequency.value = 'weekly';
    frequency.dispatchEvent(new Event('change'));
    expect(input(picker, '#schedule-day-row').hidden).toBe(false);
    input<HTMLSelectElement>(picker, '#schedule-day').value = '4';
    input<HTMLInputElement>(picker, '#schedule-time').value = '13:20';
    input<HTMLInputElement>(picker, '#schedule-timezone').value = 'Europe/London';
    await submit(picker);
    expect(api.setSkillSchedule).toHaveBeenCalledWith(skill.id, 'weekly', '13:20', 4, expect.objectContaining({ timeZone: 'Europe/London' }));
  });

  it('run now closes and runs without saving unsaved fields or source consent', async () => {
    const { picker, api, actions } = await mount(scheduled);
    input<HTMLInputElement>(picker, '#schedule-timezone').value = 'Not/AZone';
    input<HTMLTextAreaElement>(picker, '#schedule-intent').value = 'unsaved changes';
    input<HTMLButtonElement>(picker, '.schedule-run-btn').click();
    expect(actions.onClose).toHaveBeenCalledOnce();
    expect(actions.onRunNow).toHaveBeenCalledOnce();
    expect(actions.onClose.mock.invocationCallOrder[0]).toBeLessThan(actions.onRunNow.mock.invocationCallOrder[0]);
    expect(api.setSkillSchedule).not.toHaveBeenCalled();
    expect(api.clearSkillSchedule).not.toHaveBeenCalled();
  });

  it.each(['response', 'rejection'])('keeps fields and displays a save %s error', async kind => {
    const setSkillSchedule = vi.fn<SchedulePickerAPI['setSkillSchedule']>();
    if (kind === 'response') setSkillSchedule.mockResolvedValue({ error: 'Invalid time zone' });
    else setSkillSchedule.mockRejectedValue(new Error('Invalid time zone'));
    const { picker, actions } = await mount(skill, { setSkillSchedule });
    input<HTMLInputElement>(picker, '#schedule-timezone').value = 'Invalid/Zone';
    await submit(picker);
    expect(picker.isConnected).toBe(true);
    expect(picker.querySelector('[role="alert"]')?.textContent).toBe('Invalid time zone');
    expect(input<HTMLInputElement>(picker, '#schedule-timezone').value).toBe('Invalid/Zone');
    expect(actions.onSaved).not.toHaveBeenCalled();
    expect(input<HTMLButtonElement>(picker, '.schedule-save-btn').disabled).toBe(false);
  });

  it('shows removal errors without claiming success, and retries successfully', async () => {
    const clearSkillSchedule = vi.fn<SchedulePickerAPI['clearSkillSchedule']>()
      .mockResolvedValueOnce({ error: 'Could not write schedule' }).mockResolvedValue({ success: true });
    const { picker, actions } = await mount(scheduled, { clearSkillSchedule });
    input<HTMLButtonElement>(picker, '.schedule-clear-btn').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(picker.querySelector('[role="alert"]')?.textContent).toBe('Could not write schedule');
    expect(actions.onSaved).not.toHaveBeenCalled();
    input<HTMLButtonElement>(picker, '.schedule-clear-btn').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(actions.onSaved).toHaveBeenCalledWith(expect.objectContaining({ schedule: null, canvas: 'original-template', space_mode: 'reuse' }));
  });

  it('blocks saving until source loading succeeds and offers retry', async () => {
    const listSkillScheduleSources = vi.fn<SchedulePickerAPI['listSkillScheduleSources']>()
      .mockResolvedValueOnce({ error: 'Connection unavailable' }).mockResolvedValue([{ name: 'Recovered' }]);
    const { picker, actions } = await mount(skill, { listSkillScheduleSources });
    expect(input<HTMLButtonElement>(picker, '.schedule-save-btn').disabled).toBe(true);
    expect(picker.querySelector('[role="alert"]')?.textContent).toBe('Connection unavailable');
    await submit(picker);
    expect(actions.onSaved).not.toHaveBeenCalled();
    input<HTMLButtonElement>(picker, '.schedule-retry').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(input<HTMLButtonElement>(picker, '.schedule-save-btn').disabled).toBe(false);
    expect(picker.textContent).toContain('Recovered');
  });

  it('ignores a stale source response after a different picker opens', async () => {
    let resolve!: (sources: { name: string }[]) => void;
    const first = await mount(skill, {
      listSkillScheduleSources: () => new Promise(res => { resolve = res; }),
    });
    first.picker.remove();
    const second = await mount(scheduled);
    resolve([{ name: 'Stale source' }]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(second.picker.textContent).not.toContain('Stale source');
    expect(second.picker.querySelectorAll('#schedule-sources input:checked')).toHaveLength(1);
  });

  it('renders source names as text, not executable markup', async () => {
    const { picker } = await mount(skill, { listSkillScheduleSources: async () => [{ name: '<img src=x onerror=alert(1)>' }] });
    expect(picker.querySelector('img')).toBeNull();
    expect(picker.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('schedule display helpers', () => {
  it('uses past tense for outcomes and future tense for upcoming runs', () => {
    const now = Date.parse('2026-09-07T10:00:00Z');
    expect(formatScheduleDate('2026-09-07T08:00:00Z', now)).toBe('2h ago');
    expect(formatScheduleDate('2026-09-06T10:00:00Z', now)).toBe('1d ago');
    expect(formatScheduleDate('2026-09-07T10:15:00Z', now)).toBe('in 15m');
    expect(formatScheduleDate('invalid', now)).toBe('Unknown time');
  });
  it('distinguishes new defaults from an explicitly empty saved selection', () => {
    expect(scheduleSources([{ name: 'Slack' }, { name: 'Slack' }], undefined)).toEqual([{ name: 'Slack', checked: true, connected: true }]);
    expect(scheduleSources([{ name: 'Slack' }], [])).toEqual([{ name: 'Slack', checked: false, connected: true }]);
  });
});
