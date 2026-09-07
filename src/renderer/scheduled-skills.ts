import type { Skill } from '../shared/types';
import type { ScheduleOptions } from '../shared/skill-schedule';
import { scheduledRunLabels } from '../shared/skill-schedule';

export function formatScheduleDate(value: string, now = Date.now()): string {
  const date = new Date(value);
  const diff = date.getTime() - now;
  if (!Number.isFinite(diff)) return 'Unknown time';
  const minutes = Math.floor(Math.abs(diff) / 60000);
  if (diff <= 0) {
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
    return `${Math.floor(minutes / 1440)}d ago`;
  }
  if (minutes < 1) return 'soon';
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 1440) return `in ${Math.floor(minutes / 60)}h`;
  return date.toLocaleDateString();
}

export function scheduleSources(
  configured: { name: string }[],
  saved: string[] | undefined,
): { name: string; checked: boolean; connected: boolean }[] {
  const names = new Set(configured.map(source => source.name));
  return [...new Set([...names, ...(saved ?? [])])].map(name => ({
    name,
    checked: saved === undefined ? true : saved.includes(name),
    connected: names.has(name),
  }));
}

export interface SchedulePickerAPI {
  listSkillScheduleSources(): Promise<{ name: string }[] | { error: string }>;
  setSkillSchedule(id: string, frequency: string, time: string, day: number | null, options: ScheduleOptions): Promise<Skill | { error: string }>;
  clearSkillSchedule(id: string): Promise<{ success: boolean } | { error: string }>;
}

export function createSchedulePicker(
  skill: Skill,
  api: SchedulePickerAPI,
  actions: { onClose(): void; onSaved(skill: Skill): void; onRunNow(): void },
): HTMLDivElement {
  const details = skill.schedule_details;
  const editing = !!skill.schedule || details?.enabled === true;
  const legacy = editing && (!details || details.output === 'legacy');
  const overlay = document.createElement('div');
  overlay.id = 'schedule-picker-overlay';
  overlay.className = 'schedule-picker-overlay';
  // User-provided values are assigned through DOM properties, never HTML.
  overlay.innerHTML = `
    <form class="schedule-picker" role="dialog" aria-modal="true" aria-labelledby="schedule-title">
      <div class="schedule-picker-header">
        <span id="schedule-title"></span>
        <button type="button" class="schedule-picker-close" aria-label="Close schedule">×</button>
      </div>
      <div class="schedule-picker-body">
        <div class="schedule-primary-fields">
          <div>
            <label for="schedule-frequency">Frequency</label>
            <select id="schedule-frequency">
              <option value="daily">Daily</option><option value="weekdays">Weekdays</option>
              <option value="weekly">Weekly</option><option value="biweekly">Every 2 weeks</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div>
            <label for="schedule-time">Time</label>
            <input type="time" id="schedule-time" required />
          </div>
        </div>
        <div id="schedule-day-row">
          <label for="schedule-day">Weekday</label>
          <select id="schedule-day">
            <option value="0">Sunday</option><option value="1">Monday</option>
            <option value="2">Tuesday</option><option value="3">Wednesday</option>
            <option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option>
          </select>
        </div>
        <details class="schedule-details" id="schedule-timezone-details">
          <summary>Time zone: <span id="schedule-timezone-summary"></span></summary>
          <input type="text" id="schedule-timezone" aria-label="Time zone" placeholder="America/Los_Angeles" required />
          <div class="schedule-hint">Use an IANA time zone, such as America/Los_Angeles.</div>
        </details>
        <details class="schedule-details" id="schedule-intent-details">
          <summary id="schedule-intent-summary">Additional instructions (optional)</summary>
          <textarea id="schedule-intent" aria-label="Additional instructions" rows="3"></textarea>
        </details>
        <fieldset class="schedule-section"><legend>Sources</legend>
          <div id="schedule-sources" aria-live="polite">Loading sources...</div>
          <button type="button" class="schedule-retry" hidden>Retry loading sources</button>
          <div class="schedule-hint">Saving explicitly approves only read-only operations from selected servers to run unattended. Messages are not sent automatically. Other permissions surface as needs attention.</div>
        </fieldset>
        <div class="schedule-hint">Runs while Whim is running. If a run is missed, Whim catches up once when you reopen it.</div>
        <div class="${legacy ? 'schedule-section schedule-migration' : 'schedule-output'}">
          <div class="schedule-preview"></div>
          ${legacy ? `
            <label class="schedule-check">
              <input type="checkbox" id="schedule-migrate-canvas" />
              <span>Use the new canvas experience</span>
            </label>
            <div class="schedule-hint">One-way change for future runs. Existing spaces and reports are kept.</div>
          ` : ''}
        </div>
        <div class="schedule-next-run"></div>
        <div class="schedule-last-run"></div>
        <div class="schedule-error" role="alert" hidden></div>
      </div>
      <div class="schedule-picker-footer">
        <button type="button" class="schedule-run-btn" title="Run saved settings without saving changes">Run now</button>
        <span class="schedule-footer-spacer"></span>
        <button type="button" class="schedule-clear-btn">Remove schedule</button>
        <button type="submit" class="schedule-save-btn" disabled></button>
      </div>
    </form>`;
  const form = overlay.querySelector('form')!;
  const frequency = overlay.querySelector<HTMLSelectElement>('#schedule-frequency')!;
  const time = overlay.querySelector<HTMLInputElement>('#schedule-time')!;
  const day = overlay.querySelector<HTMLSelectElement>('#schedule-day')!;
  const zone = overlay.querySelector<HTMLInputElement>('#schedule-timezone')!;
  const intent = overlay.querySelector<HTMLTextAreaElement>('#schedule-intent')!;
  const save = overlay.querySelector<HTMLButtonElement>('.schedule-save-btn')!;
  const remove = overlay.querySelector<HTMLButtonElement>('.schedule-clear-btn')!;
  const run = overlay.querySelector<HTMLButtonElement>('.schedule-run-btn')!;
  const sources = overlay.querySelector<HTMLDivElement>('#schedule-sources')!;
  const retry = overlay.querySelector<HTMLButtonElement>('.schedule-retry')!;
  const error = overlay.querySelector<HTMLDivElement>('.schedule-error')!;
  const close = overlay.querySelector<HTMLButtonElement>('.schedule-picker-close')!;
  const migrate = overlay.querySelector<HTMLInputElement>('#schedule-migrate-canvas');
  let busy = false;
  let sourcesLoaded = false;
  const showError = (message: string) => { error.textContent = message; error.hidden = false; };
  const setBusy = (value: boolean) => {
    busy = value;
    form.setAttribute('aria-busy', String(value));
    save.disabled = value || !sourcesLoaded;
    remove.disabled = run.disabled = close.disabled = value;
  };
  const requestClose = () => { if (!busy) actions.onClose(); };
  form.addEventListener('invalid', event => {
    if (event.target instanceof HTMLElement) {
      const section = event.target.closest('details');
      if (section) section.open = true;
    }
  }, true);
  close.onclick = requestClose;
  overlay.onclick = event => { if (event.target === overlay) requestClose(); };
  overlay.onkeydown = event => {
    if (event.key === 'Escape') { event.stopPropagation(); requestClose(); }
    if (event.key === 'Tab') {
      const focusable = [...form.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, summary')]
        .filter(element => !element.hidden && !element.closest('[hidden]')
          && (element.tagName === 'SUMMARY' || !element.closest('details:not([open])')));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  overlay.querySelector('#schedule-title')!.textContent = `Schedule: ${skill.name}`;
  frequency.value = editing ? details?.frequency ?? skill.schedule ?? 'daily' : 'daily';
  time.value = editing ? details?.time ?? skill.schedule_time ?? '09:00' : '09:00';
  day.value = String(editing ? details?.day ?? skill.schedule_day ?? 1 : 1);
  zone.value = (editing ? details?.timeZone : undefined) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  intent.value = editing ? details?.intent ?? '' : '';
  const updateZoneSummary = () => {
    overlay.querySelector('#schedule-timezone-summary')!.textContent = zone.value;
  };
  const updateIntentSummary = () => {
    overlay.querySelector('#schedule-intent-summary')!.textContent =
      intent.value.trim() ? 'Additional instructions (included)' : 'Additional instructions (optional)';
  };
  zone.oninput = updateZoneSummary;
  intent.oninput = updateIntentSummary;
  updateZoneSummary();
  updateIntentSummary();
  const updateDay = () => {
    overlay.querySelector<HTMLElement>('#schedule-day-row')!.hidden = !['weekly', 'biweekly'].includes(frequency.value);
  };
  frequency.onchange = updateDay;
  updateDay();
  save.textContent = editing ? 'Save changes' : 'Create schedule';
  remove.hidden = !editing;
  const updatePreview = () => {
    overlay.querySelector('.schedule-preview')!.textContent = legacy && !migrate?.checked
      ? 'Existing report and space behavior is preserved for this legacy schedule.'
      : 'Creates a dated space with results on its canvas.';
  };
  if (migrate) migrate.onchange = updatePreview;
  updatePreview();
  const nextRunAt = editing ? details?.nextRunAt ?? skill.next_run_at : null;
  overlay.querySelector('.schedule-next-run')!.textContent = nextRunAt ? `Next run: ${formatScheduleDate(nextRunAt)}` : '';
  const lastRun = details?.lastRun;
  overlay.querySelector('.schedule-last-run')!.textContent = lastRun
    ? `Last outcome: ${scheduledRunLabels[lastRun.status]} · ${formatScheduleDate(lastRun.completedAt ?? lastRun.startedAt)}${lastRun.summary ? ` — ${lastRun.summary}` : ''}`
    : skill.last_run_at ? `Last run: ${formatScheduleDate(skill.last_run_at)}` : 'Never run yet';

  const loadSources = async () => {
    retry.hidden = true;
    error.hidden = true;
    try {
      const result = await api.listSkillScheduleSources();
      if (!overlay.isConnected) return;
      if ('error' in result) throw new Error(result.error);
      sources.replaceChildren();
      for (const source of scheduleSources(result, editing ? details?.readOnlyServers ?? [] : undefined)) {
        const label = document.createElement('label');
        label.className = 'schedule-check';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = source.name;
        input.checked = source.checked;
        label.append(input, document.createTextNode(`${source.name}${source.connected ? '' : ' (not configured)'}`));
        sources.append(label);
      }
      if (!sources.childElementCount) sources.textContent = 'No sources configured.';
      sourcesLoaded = true;
      setBusy(busy);
    } catch (cause) {
      if (!overlay.isConnected) return;
      sources.textContent = 'Could not load sources.';
      showError(cause instanceof Error ? cause.message : String(cause));
      retry.hidden = false;
    }
  };
  retry.onclick = () => { void loadSources(); };
  // Allow the caller to mount the dialog before the first response is applied.
  queueMicrotask(() => { void loadSources(); frequency.focus(); });
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || !sourcesLoaded || !form.reportValidity()) return;
    error.hidden = true;
    setBusy(true);
    try {
      const result = await api.setSkillSchedule(skill.id, frequency.value, time.value,
        ['weekly', 'biweekly'].includes(frequency.value) ? Number(day.value) : null, {
          timeZone: zone.value.trim(),
          intent: intent.value.trim(),
          readOnlyServers: [...sources.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value),
          ...(legacy && migrate?.checked ? { migrateToCanvas: true } : {}),
        });
      if ('error' in result) throw new Error(result.error);
      if (overlay.isConnected) actions.onSaved(result);
    } catch (cause) {
      if (overlay.isConnected) showError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  remove.onclick = async () => {
    if (busy) return;
    error.hidden = true;
    setBusy(true);
    try {
      const result = await api.clearSkillSchedule(skill.id);
      if ('error' in result) throw new Error(result.error);
      if (!result.success) throw new Error('Could not remove schedule.');
      if (overlay.isConnected) actions.onSaved({
        ...skill, schedule: null, schedule_time: null, schedule_day: null, next_run_at: null,
        schedule_details: details ? { ...details, enabled: false, nextRunAt: null } : undefined,
      });
    } catch (cause) {
      if (overlay.isConnected) showError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  run.onclick = () => {
    if (busy) return;
    actions.onClose();
    actions.onRunNow();
  };
  return overlay;
}
