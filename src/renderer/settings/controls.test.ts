// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsHost } from '../app';
import { FormDrafts, trackSettingWrites } from '../save-lifecycle';
import { DebouncedSave } from '../debounced-save';
import { mountSettings } from './controls';

const forms = [
  { name: 'runtime', add: 'runtime-add-btn', list: 'runtimes-list', method: 'saveRuntimes' },
  { name: 'export destination', add: 'export-dest-add-btn', list: 'export-destinations-list', method: 'saveExportDestinations' },
  { name: 'MCP server', add: 'mcp-add-btn', list: 'mcp-custom-list', method: 'saveCustomMcp' },
  { name: 'CLI tool', add: 'cli-tool-add-btn', list: 'cli-tools-list', method: 'saveCliTools' },
] as const;

function fixture() {
  const fail = () => vi.fn().mockResolvedValue({ error: 'disk full' });
  const raw = {
    saveRuntimes: fail(), saveExportDestinations: fail(), saveCustomMcp: fail(), saveCliTools: fail(),
    setSetting: fail(),
    getSetting: vi.fn().mockResolvedValue(null),
    listExportDestinations: vi.fn().mockResolvedValue([]),
    listCustomMcp: vi.fn().mockResolvedValue([]),
    listCliTools: vi.fn().mockResolvedValue([]),
    listInstalledFonts: vi.fn().mockResolvedValue([]),
    onFontChanged: vi.fn(),
    onUpdateStateChanged: vi.fn(),
    getUpdateState: vi.fn().mockResolvedValue({ status: 'idle' }),
  };
  const settingsAPI: Partial<SettingsHost['whimAPI']> = raw;
  const bridgeAPI: Partial<SettingsHost['bridgeApi']> = raw;
  const tracked = trackSettingWrites(settingsAPI as SettingsHost['whimAPI']);
  const settingsOverlay = document.createElement('div');
  document.body.append(settingsOverlay);
  const settingsDrafts = new FormDrafts();
  const changed = (event: Event) => {
    const form = (event.target as Element).closest('.persona-form');
    if (form) settingsDrafts.changed(form);
  };
  settingsOverlay.addEventListener('input', changed, true);
  settingsOverlay.addEventListener('change', changed, true);
  const host: Partial<SettingsHost> = {
    settingsOverlay, settingsDrafts, settingWrites: tracked, whimAPI: tracked.api,
    bridgeApi: bridgeAPI as SettingsHost['bridgeApi'],
    currentWorkspacePath: null,
    closeSettings: vi.fn(), hideSettings: vi.fn(), showStatus: vi.fn(),
    updateWorkspaceDisplay: vi.fn(), loadThemeSetting: vi.fn().mockResolvedValue(undefined),
    refreshProfiles: vi.fn().mockResolvedValue(undefined), loadHotkeys: vi.fn().mockResolvedValue(undefined),
    DebouncedSave,
  };
  const controller = mountSettings(host as SettingsHost);
  return { raw, tracked, settingsDrafts, controller };
}

function openForm(config: typeof forms[number], name = 'draft') {
  document.getElementById(config.add)!.click();
  const form = document.querySelector<HTMLElement>(`#${config.list} .persona-form`)!;
  for (const [index, input] of [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].entries()) {
    input.value = index === 0 ? name : 'fixture value';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return form;
}

async function failSave(form: HTMLElement) {
  form.querySelector<HTMLButtonElement>('.persona-form-save')!.click();
  await vi.waitFor(() => expect(form.querySelector('.persona-form-error')?.textContent).toBe('disk full'));
  expect(form.isConnected).toBe(true);
}

function cancel(form: HTMLElement) {
  form.querySelector<HTMLButtonElement>('.persona-form-cancel')!.click();
  expect(form.isConnected).toBe(false);
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.stubGlobal('localStorage', { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() });
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(forms)('mounted $name cancellation', config => {
  it.each(['result', 'rejection'])('discards its failed %s write and permits a clean lifecycle flush', async failure => {
    const { raw, tracked, settingsDrafts, controller } = fixture();
    await controller.refresh();
    if (failure === 'rejection') raw[config.method].mockRejectedValue(new Error('disk full'));
    const form = openForm(config);
    await failSave(form);
    expect(settingsDrafts.hasDirty()).toBe(true);
    await expect(tracked.flush()).rejects.toThrow('failed');
    cancel(form);
    expect(() => settingsDrafts.assertClean()).not.toThrow();
    await controller.flush();
    await expect(tracked.flush()).resolves.toBeUndefined();

    // A discarded optimistic addition must not leak into a later save.
    const next = openForm(config, 'next');
    await failSave(next);
    const calls = raw[config.method].mock.calls;
    expect(calls[calls.length - 1][0]).toHaveLength(1);
    const sent = calls[calls.length - 1][0][0];
    expect(sent.label ?? sent.name).toBe('next');
    cancel(next);
  });

  it('does not erase an independent setting failure', async () => {
    const { tracked, controller } = fixture();
    await controller.refresh();
    const form = openForm(config);
    await failSave(form);
    await tracked.api.setSetting('theme', 'dark');
    cancel(form);
    await expect(tracked.flush()).rejects.toThrow('failed');
    tracked.discardFailure('setSetting:theme');
    await expect(tracked.flush()).resolves.toBeUndefined();
  });

  it('does not erase a newer failure from another operation using the same save method', async () => {
    const { tracked, controller } = fixture();
    await controller.refresh();
    const form = openForm(config);
    await failSave(form);
    const independent = tracked.api[config.method]([]);
    await independent;
    cancel(form);
    await expect(tracked.flush()).rejects.toThrow('failed');
    tracked.discardFailure(config.method, independent);
    await expect(tracked.flush()).resolves.toBeUndefined();
  });

  it('does not discard a previous failure when cancelling a form that never saved', async () => {
    const { tracked, controller } = fixture();
    await controller.refresh();
    await tracked.api[config.method]([]);
    cancel(openForm(config));
    await expect(tracked.flush()).rejects.toThrow('failed');
  });

  it('discards all its failed retries without erasing an earlier independent failure', async () => {
    const { raw, tracked, controller } = fixture();
    await controller.refresh();
    const independent = tracked.api[config.method]([]);
    await independent;
    const form = openForm(config);
    await failSave(form);
    form.querySelector('.persona-form-error')!.textContent = '';
    await failSave(form);
    expect(raw[config.method]).toHaveBeenCalledTimes(3);
    cancel(form);
    await expect(tracked.flush()).rejects.toThrow('failed');
    tracked.discardFailure(config.method, independent);
    await expect(tracked.flush()).resolves.toBeUndefined();
  });
});
