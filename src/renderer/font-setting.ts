import { FONT_OPTIONS, normalizeFontChoice, type FontChoice } from '../shared/fonts';
import type { WhimAPI } from '../shared/whim-api';

export function applyFont(value: unknown): FontChoice {
  const choice = normalizeFontChoice(value);
  const font = FONT_OPTIONS.find(option => option.id === choice)!;
  document.documentElement.style.setProperty('--font-body', font.family);
  document.documentElement.style.setProperty('--font-heading', choice === 'default' ? FONT_OPTIONS[1].family : font.family);
  return choice;
}

export async function initFontSetting(api: Pick<WhimAPI, 'getSetting' | 'setSetting' | 'onFontChanged'>): Promise<void> {
  const root = document.getElementById('font-setting');
  const error = document.getElementById('font-setting-error');
  let choice: FontChoice = 'default';
  let active = 0;
  let expanded = false;
  let revision = 0;
  let saving = false;

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
  const options = FONT_OPTIONS.map((font, index) => {
    const option = document.createElement('div');
    option.id = `font-option-${font.id}`;
    option.className = 'font-picker-option';
    option.setAttribute('role', 'option');
    option.textContent = font.label;
    option.style.fontFamily = font.family;
    option.addEventListener('mousedown', event => event.preventDefault());
    option.addEventListener('click', () => { void select(index); });
    list.append(option);
    return option;
  });
  root?.append(trigger, list);

  function sync(value: unknown): void {
    choice = applyFont(value);
    const index = FONT_OPTIONS.findIndex(font => font.id === choice);
    trigger.textContent = FONT_OPTIONS[index].label;
    trigger.style.fontFamily = FONT_OPTIONS[index].family;
    options.forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
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
    if (open) highlight(FONT_OPTIONS.findIndex(font => font.id === choice));
    else trigger.removeAttribute('aria-activedescendant');
  }

  function reportError(message: string, cause: unknown): void {
    console.error(message, cause);
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
  }

  async function select(index: number): Promise<void> {
    if (saving) return;
    toggle(false);
    trigger.focus();
    saving = true;
    trigger.disabled = true;
    if (error) error.hidden = true;
    try {
      const font = FONT_OPTIONS[index].id;
      await api.setSetting('font', font);
      sync(font);
    } catch (cause) {
      reportError('Could not save the font. Please try again.', cause);
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
    else if (event.key === 'Enter' || event.key === ' ') {
      if (expanded) void select(active);
      else toggle(true);
    } else {
      const wasExpanded = expanded;
      if (!expanded) toggle(true);
      if (event.key === 'Home') highlight(0);
      else if (event.key === 'End') highlight(options.length - 1);
      else if (event.key === 'ArrowDown' && wasExpanded) highlight(active + 1);
      else if (event.key === 'ArrowUp' && wasExpanded) highlight(active - 1);
      else if (event.key.length === 1) {
        const index = FONT_OPTIONS.findIndex(font => font.label.toLowerCase().startsWith(event.key.toLowerCase()));
        if (index !== -1) highlight(index);
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
    if (expanded) highlight(FONT_OPTIONS.findIndex(option => option.id === choice));
  });
  const initialRevision = revision;
  try {
    const stored = await api.getSetting('font');
    if (revision === initialRevision) sync(stored);
  } catch (cause) {
    reportError('Could not load the font setting.', cause);
  } finally {
    trigger.disabled = false;
  }
}
