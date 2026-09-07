import { describe, expect, it } from 'vitest';
import { buildFontOptions, getFontOption, installedFontFamilies, isFontChoice, normalizeFontChoice } from './fonts';

describe('installed fonts', () => {
  it('deduplicates and sorts families while preserving display names', () => {
    expect(installedFontFamilies(['Verdana', 'Arial', 'arial', 'Apex Serif', '', 'bad\nfont']))
      .toEqual(['Apex Serif', 'Arial', 'Verdana']);
  });

  it('keeps bundled defaults, includes installed fonts, and preserves legacy choices', () => {
    const options = buildFontOptions(['Georgia', 'Fraunces', 'Apex Serif', 'Georgia'], 'georgia');
    expect(options.map(font => font.id)).toEqual(['default', 'fraunces', 'local:Apex Serif', 'georgia']);
    expect(getFontOption('georgia').family).toBe('Georgia, serif');
  });

  it('accepts installed-family selections and rejects malformed values', () => {
    expect(isFontChoice('local:Apex New')).toBe(true);
    expect(isFontChoice('local:日本語')).toBe(true);
    for (const value of ['local:', 'local: ', 'local:bad\nfont', 'local:\ud800', 'local:' + 'a'.repeat(257), 42, null, 'not-a-font']) {
      expect(normalizeFontChoice(value)).toBe('default');
    }
  });

  it('quotes arbitrary font names as a single CSS family', () => {
    const name = 'Custom "Font"\\Name, serif';
    expect(getFontOption(`local:${name}`)).toEqual({
      id: `local:${name}`,
      label: name,
      family: '"Custom \\"Font\\"\\\\Name, serif", sans-serif',
    });
  });
});
