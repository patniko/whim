export const FONT_OPTIONS = [
  { id: 'default', label: 'Default (System)', family: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif" },
  { id: 'fraunces', label: 'Fraunces', family: "'Fraunces', Georgia, serif" },
  { id: 'arial', label: 'Arial', family: 'Arial, Helvetica, sans-serif' },
  { id: 'georgia', label: 'Georgia', family: 'Georgia, serif' },
  { id: 'verdana', label: 'Verdana', family: 'Verdana, sans-serif' },
  { id: 'trebuchet', label: 'Trebuchet MS', family: "'Trebuchet MS', sans-serif" },
  { id: 'times', label: 'Times New Roman', family: "'Times New Roman', Times, serif" },
  { id: 'courier', label: 'Courier New', family: "'Courier New', Courier, monospace" },
] as const;

export type FontChoice = typeof FONT_OPTIONS[number]['id'] | `local:${string}`;

export interface FontOption {
  id: FontChoice;
  label: string;
  family: string;
}

export function isFontFamily(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value.trim() === value && Array.from(value).every(char => {
      const code = char.codePointAt(0);
      return code !== undefined && code >= 32 && code !== 127 && (code < 0xd800 || code > 0xdfff);
    });
}

export function isFontChoice(value: unknown): value is FontChoice {
  return FONT_OPTIONS.some(option => option.id === value)
    || (typeof value === 'string' && value.startsWith('local:') && isFontFamily(value.slice(6)));
}

export function normalizeFontChoice(value: unknown): FontChoice {
  return isFontChoice(value) ? value : 'default';
}

export function getFontOption(value: unknown): FontOption {
  const choice = normalizeFontChoice(value);
  const builtin = FONT_OPTIONS.find(option => option.id === choice);
  if (builtin) return builtin;
  const name = choice.slice(6);
  // A family is one CSS string, not a user-supplied font stack.
  const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return { id: choice, label: name, family: `"${escaped}", sans-serif` };
}

export function installedFontFamilies(names: readonly string[]): string[] {
  const families = new Map<string, string>();
  for (const name of names) {
    if (isFontFamily(name) && !families.has(name.toLowerCase())) {
      families.set(name.toLowerCase(), name);
    }
  }
  return [...families.values()].sort((a, b) => a.localeCompare(b));
}

export function buildFontOptions(names: readonly string[], selected: FontChoice): FontOption[] {
  const bundled = FONT_OPTIONS[1];
  const installed = installedFontFamilies(names)
    .filter(name => name.toLowerCase() !== bundled.label.toLowerCase())
    .map(name => {
      // Retain IDs from the original picker so existing preferences keep working.
      const legacy = FONT_OPTIONS.slice(2).find(font => font.label.toLowerCase() === name.toLowerCase());
      return legacy ?? getFontOption(`local:${name}`);
    });
  const options: FontOption[] = [FONT_OPTIONS[0], bundled, ...installed];
  if (!options.some(option => option.id === selected)) {
    const font = getFontOption(selected);
    options.push({ ...font, label: `${font.label} (not installed)` });
  }
  return options;
}
