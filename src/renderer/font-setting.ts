import { FONT_OPTIONS, buildFontOptions, getFontOption, normalizeFontChoice, type FontChoice } from '../shared/fonts';
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
  const root = document.getElementById('font-setting');
  const error = document.getElementById('font-setting-error');
  let choice: FontChoice = 'default';
  let active = 0;
  let expanded = false;
  let revision = 0;
  let saving = false;
  let loading = false;
  let families: string[] = [];
  let fonts = buildFontOptions(families, choice);
  let options: HTMLDivElement[] = [];
  let typed = '';
  let lastTypedAt = 0;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = 'font-setting-trigger';
  trigger.className = 'font-picker-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-labelledby', 'font-setting-label');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-controls', 'font-setting-options');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.disabled = true;

  // Native select popups ignore option fonts on macOS, so render the list ourselves.
  const list = document.createElement('div');
  list.id = 'font-setting-options';
  list.className = 'font-picker-options';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-labelledby', 'font-setting-label');
  list.hidden = true;
  root?.append(trigger, list);

  function renderOptions(): void {
    const activeId = fonts[active]?.id;
    fonts = buildFontOptions(families, choice);
    options = fonts.map(font => {
      const option = document.createElement('div');
      option.id = `font-option-${encodeURIComponent(font.id)}`;
      option.className = 'font-picker-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(font.id === choice));
      option.textContent = font.label;
      option.style.fontFamily = font.family;
      option.addEventListener('mousedown', event => event.preventDefault());
      option.addEventListener('click', () => { void select(font.id); });
      return option;
    });
    list.replaceChildren(...options);
    if (expanded) {
      const index = fonts.findIndex(font => font.id === activeId);
      highlight(index === -1 ? fonts.findIndex(font => font.id === choice) : index);
    }
  }

  function sync(value: unknown): void {
    choice = applyFont(value);
    const font = getFontOption(choice);
    trigger.textContent = font.label;
    trigger.style.fontFamily = font.family;
    renderOptions();
  }

  function highlight(index: number): void {
    active = (index + options.length) % options.length;
    options.forEach((option, i) => option.classList.toggle('active', i === active));
    trigger.setAttribute('aria-activedescendant', options[active].id);
    options[active].scrollIntoView({ block: 'nearest' });
  }

  function toggle(open: boolean): void {
    expanded = open;
    list.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    typed = '';
    if (open) {
      highlight(fonts.findIndex(font => font.id === choice));
      void refreshFonts();
    }
    else trigger.removeAttribute('aria-activedescendant');
  }

  function reportError(message: string, cause: unknown): void {
    console.error(message, cause);
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
  }

  async function refreshFonts(): Promise<void> {
    if (loading || !allowSelection || !root) return;
    loading = true;
    trigger.setAttribute('aria-busy', 'true');
    try {
      families = await api.listInstalledFonts();
      renderOptions();
      if (error?.dataset.source === 'fonts') error.hidden = true;
    } catch (cause) {
      reportError('Could not load installed fonts. Reopen the dropdown to try again.', cause);
      if (error) error.dataset.source = 'fonts';
    } finally {
      loading = false;
      trigger.removeAttribute('aria-busy');
    }
  }

  async function select(font: FontChoice): Promise<void> {
    if (saving) return;
    toggle(false);
    trigger.focus();
    saving = true;
    trigger.disabled = true;
    if (error) error.hidden = true;
    try {
      await api.setSetting('font', font);
      sync(font);
    } catch (cause) {
      reportError('Could not save the font. Please try again.', cause);
      if (error) error.dataset.source = 'save';
    } finally {
      saving = false;
      trigger.disabled = false;
      if (document.activeElement === document.body) trigger.focus();
    }
  }

  trigger.addEventListener('click', () => toggle(!expanded));
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Tab') {
      toggle(false);
      return;
    }
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'];
    if (!keys.includes(event.key) && event.key.length !== 1) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape' && !expanded) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') toggle(false);
    else if (event.key === 'Enter' || (event.key === ' ' && (!typed || Date.now() - lastTypedAt > 700))) {
      if (expanded) void select(fonts[active].id);
      else toggle(true);
    } else {
      const wasExpanded = expanded;
      if (!expanded) toggle(true);
      if (event.key === 'Home') highlight(0);
      else if (event.key === 'End') highlight(options.length - 1);
      else if (event.key === 'ArrowDown' && wasExpanded) highlight(active + 1);
      else if (event.key === 'ArrowUp' && wasExpanded) highlight(active - 1);
      else if (event.key.length === 1) {
        const now = Date.now();
        typed = now - lastTypedAt > 700 ? event.key : typed + event.key;
        lastTypedAt = now;
        const repeated = [...typed].every(char => char.toLowerCase() === typed[0].toLowerCase());
        const prefix = (repeated ? typed[0] : typed).toLowerCase();
        const start = repeated ? active + 1 : active;
        const index = Array.from({ length: fonts.length }, (_, i) => (start + i) % fonts.length)
          .find(i => fonts[i].label.toLowerCase().startsWith(prefix));
        if (index !== undefined) highlight(index);
      }
    }
  });
  document.addEventListener('pointerdown', event => {
    if (event.target instanceof Node && !root?.contains(event.target)) toggle(false);
  });
  root?.addEventListener('focusout', event => {
    if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) toggle(false);
  });

  sync('default');
  api.onFontChanged(font => {
    revision++;
    sync(font);
    if (expanded) highlight(fonts.findIndex(option => option.id === choice));
  });
  const initialRevision = revision;
  try {
    const stored = await api.getSetting('font');
    if (revision === initialRevision) sync(stored);
  } catch (cause) {
    reportError('Could not load the font setting.', cause);
  } finally {
    await refreshFonts();
    trigger.disabled = !allowSelection;
  }
}
