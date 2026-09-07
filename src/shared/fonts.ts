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

export type FontChoice = typeof FONT_OPTIONS[number]['id'];

export function isFontChoice(value: unknown): value is FontChoice {
  return FONT_OPTIONS.some(option => option.id === value);
}

export function normalizeFontChoice(value: unknown): FontChoice {
  return isFontChoice(value) ? value : 'default';
}
