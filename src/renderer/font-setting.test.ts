// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FONT_OPTIONS } from '../shared/fonts';
import { applyFont, initFontSetting } from './font-setting';

function setup(stored: unknown = 'default') {
  let notify: (font: string) => void = () => {};
  const api = {
    getSetting: vi.fn(async () => stored),
    setSetting: vi.fn(async (_key: string, value: string) => value),
    onFontChanged: vi.fn((callback: (font: string) => void) => { notify = callback; }),
  };
  return { api, notify: (font: string) => notify(font) };
}

function trigger() {
  return document.querySelector<HTMLButtonElement>('[role="combobox"]')!;
}

function key(value: string) {
  trigger().dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  document.body.innerHTML = `
    <label id="font-setting-label">Font</label>
    <div id="font-setting"></div>
    <div id="font-setting-error" role="alert" hidden></div>
    <button id="outside">Outside</button>`;
  document.documentElement.removeAttribute('style');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('font setting', () => {
  it('renders every option and the saved label in its own font', async () => {
    await initFontSetting(setup('georgia').api);
    const options = document.querySelectorAll<HTMLElement>('[role="option"]');
    expect(options).toHaveLength(FONT_OPTIONS.length);
    FONT_OPTIONS.forEach((font, i) => {
      const expected = document.createElement('span');
      expected.style.fontFamily = font.family;
      expect(options[i].textContent).toBe(font.label);
      expect(options[i].style.fontFamily).toBe(expected.style.fontFamily);
      expect(options[i].getAttribute('aria-selected')).toBe(String(font.id === 'georgia'));
    });
    expect(trigger().textContent).toBe('Georgia');
    expect(trigger().style.fontFamily).toBe(options[3].style.fontFamily);
    expect(document.documentElement.style.getPropertyValue('--font-body')).toBe('Georgia, serif');
    expect(document.documentElement.style.getPropertyValue('--font-heading')).toBe('Georgia, serif');
  });

  it('saves a clicked option and closes the list', async () => {
    const { api } = setup();
    await initFontSetting(api);
    trigger().click();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    document.getElementById('font-option-fraunces')!.click();
    await vi.waitFor(() => expect(trigger().textContent).toBe('Fraunces'));
    expect(api.setSetting).toHaveBeenCalledWith('font', 'fraunces');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('supports arrows, Home/End, type-ahead, and keyboard selection', async () => {
    const { api } = setup();
    await initFontSetting(api);
    key('ArrowDown');
    key('ArrowDown');
    expect(trigger().getAttribute('aria-activedescendant')).toBe('font-option-fraunces');
    key('End');
    expect(trigger().getAttribute('aria-activedescendant')).toBe('font-option-courier');
    key('Home');
    expect(trigger().getAttribute('aria-activedescendant')).toBe('font-option-default');
    key('ArrowUp');
    expect(trigger().getAttribute('aria-activedescendant')).toBe('font-option-courier');
    key('g');
    key('Enter');
    await vi.waitFor(() => expect(api.setSetting).toHaveBeenCalledWith('font', 'georgia'));
  });

  it('dismisses without saving on Escape, Tab, and outside clicks', async () => {
    const { api } = setup();
    await initFontSetting(api);
    const bubbling = vi.fn();
    document.body.addEventListener('keydown', bubbling);
    trigger().click();
    key('ArrowDown');
    key('Escape');
    expect(bubbling).not.toHaveBeenCalled();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    trigger().click();
    key('Tab');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    trigger().click();
    document.getElementById('outside')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(api.setSetting).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', bubbling);
  });

  it('updates from other windows without writing the setting back', async () => {
    const { api, notify } = setup();
    await initFontSetting(api);
    notify('verdana');
    expect(trigger().textContent).toBe('Verdana');
    expect(document.documentElement.style.getPropertyValue('--font-body')).toBe('Verdana, sans-serif');
    expect(api.setSetting).not.toHaveBeenCalled();
  });

  it('does not overwrite a live change with an older startup read', async () => {
    const { api, notify } = setup();
    let resolve!: (value: unknown) => void;
    api.getSetting.mockReturnValue(new Promise(done => { resolve = done; }));
    const loading = initFontSetting(api);
    notify('georgia');
    resolve('default');
    await loading;
    expect(trigger().textContent).toBe('Georgia');
  });

  it('reports a failed save and retains the previous selection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { api } = setup('georgia');
    api.setSetting.mockRejectedValue(new Error('disk full'));
    await initFontSetting(api);
    trigger().click();
    document.getElementById('font-option-arial')!.click();
    await vi.waitFor(() => expect(document.getElementById('font-setting-error')!.hidden).toBe(false));
    expect(trigger().textContent).toBe('Georgia');
    expect(trigger().disabled).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--font-body')).toBe('Georgia, serif');
  });

  it('reports failed loads and still allows a new selection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { api } = setup();
    api.getSetting.mockRejectedValue(new Error('unavailable'));
    await initFontSetting(api);
    expect(document.getElementById('font-setting-error')!.hidden).toBe(false);
    expect(trigger().disabled).toBe(false);
  });

  it('applies fonts in windows without a Settings control', async () => {
    document.body.innerHTML = '';
    const { api, notify } = setup('arial');
    await initFontSetting(api);
    expect(document.documentElement.style.getPropertyValue('--font-body')).toBe('Arial, Helvetica, sans-serif');
    notify('georgia');
    expect(document.documentElement.style.getPropertyValue('--font-body')).toBe('Georgia, serif');
  });

  it('restores the original body and heading fonts for default or invalid choices', () => {
    applyFont('georgia');
    expect(applyFont('default')).toBe('default');
    expect(document.documentElement.style.getPropertyValue('--font-body')).toBe(FONT_OPTIONS[0].family);
    expect(document.documentElement.style.getPropertyValue('--font-heading')).toBe(FONT_OPTIONS[1].family);
    expect(applyFont('invalid')).toBe('default');
  });
});
