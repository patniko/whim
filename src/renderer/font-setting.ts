import { FONT_OPTIONS, getFontOption, normalizeFontChoice, type FontChoice } from '../shared/fonts';
import type { WhimAPI } from '../shared/whim-api';

export function applyFont(value: unknown): FontChoice {
  const choice = normalizeFontChoice(value);
  const font = getFontOption(choice);
  document.documentElement.style.setProperty('--font-body', font.family);
  document.documentElement.style.setProperty('--font-heading', choice === 'default' ? FONT_OPTIONS[1].family : font.family);
  return choice;
}

export async function initFontSetting(
  api: Pick<WhimAPI, 'getSetting' | 'setSetting' | 'onFontChanged' | 'listInstalledFonts'>,
  allowSelection = true,
): Promise<void> {
  let revision = 0;
  let latest: unknown;
  const listeners = new Set<(font: FontChoice) => void>();
  const readOnly = !allowSelection && document.getElementById('font-setting');
  const trigger = readOnly ? document.createElement('button') : null;
  if (trigger && readOnly) {
    trigger.type = 'button';
    trigger.disabled = true;
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-expanded', 'false');
    readOnly.appendChild(trigger);
  }
  const sync = (font: unknown) => {
    const choice = applyFont(font);
    if (trigger) trigger.textContent = getFontOption(choice).label;
    for (const listener of listeners) listener(choice);
  };
  api.onFontChanged(font => { revision++; latest = font; sync(font); });
  const initialRevision = revision;
  const initial = api.getSetting('font').then(stored => {
    if (initialRevision === revision) latest = stored;
    return { ok: true as const };
  }, error => ({ ok: false as const, error }));
  const readInitial = async () => {
    const result = await initial;
    if (!result.ok) throw result.error;
    return latest;
  };
  if (allowSelection) {
    const picker = await import('./settings/font-picker');
    return picker.initFontSetting({
      ...api,
      getSetting: key => key === 'font' ? readInitial() : api.getSetting(key),
      onFontChanged: listener => { listeners.add(listener); },
    }, true);
  }
  sync(await readInitial());
}
