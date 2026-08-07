type HotkeyEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> &
  Partial<Pick<KeyboardEvent, 'code'>>;

type Modifier = 'control' | 'meta' | 'shift' | 'alt';

interface ParsedAccelerator {
  key: string;
  modifiers: Set<Modifier>;
}

function isMacPlatform(platform: string): boolean {
  return platform.toUpperCase().includes('MAC');
}

function platformCommandOrControl(platform: string): Modifier {
  return isMacPlatform(platform) ? 'meta' : 'control';
}

function normalizeAcceleratorKey(key: string): string {
  if (key === ' ') return 'Space';
  if (key === 'Esc') return 'Escape';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function normalizeEventKey(event: HotkeyEvent): string {
  if (event.code === 'Space') return 'Space';

  // Option/Alt transforms printable keys on macOS (for example Option+K
  // produces "˚"). Use the physical key code when the transformed value is
  // not valid in Electron's ASCII-only accelerator syntax.
  if (!/^[\x20-\x7e]+$/.test(event.key)) {
    const letter = event.code?.match(/^Key([A-Z])$/)?.[1];
    if (letter) return letter;
    const digit = event.code?.match(/^Digit([0-9])$/)?.[1];
    if (digit) return digit;
  }

  return normalizeAcceleratorKey(event.key);
}

function modifierPartsForEvent(event: HotkeyEvent, platform: string): string[] {
  const parts: string[] = [];
  if (event.metaKey) parts.push(isMacPlatform(platform) ? 'Command' : 'Super');
  if (event.ctrlKey) parts.push('Control');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  return parts;
}

function parseAccelerator(accelerator: string, platform: string): ParsedAccelerator | null {
  const parts = accelerator.split('+').map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const key = normalizeAcceleratorKey(parts[parts.length - 1]);
  const modifiers = new Set<Modifier>();

  for (const part of parts.slice(0, -1)) {
    const modifier = part.toLowerCase();
    if (modifier === 'commandorcontrol' || modifier === 'cmdorctrl') {
      modifiers.add(platformCommandOrControl(platform));
    } else if (modifier === 'control' || modifier === 'ctrl') {
      modifiers.add('control');
    } else if (modifier === 'command' || modifier === 'cmd' || modifier === 'meta' || modifier === 'super') {
      modifiers.add('meta');
    } else if (modifier === 'shift') {
      modifiers.add('shift');
    } else if (modifier === 'alt' || modifier === 'option') {
      modifiers.add('alt');
    }
  }

  return { key, modifiers };
}

function eventHasModifier(event: HotkeyEvent, modifier: Modifier): boolean {
  if (modifier === 'control') return event.ctrlKey;
  if (modifier === 'meta') return event.metaKey;
  if (modifier === 'shift') return event.shiftKey;
  return event.altKey;
}

export function formatAccelerator(accelerator: string, platform: string): string {
  const isMac = isMacPlatform(platform);
  const tokens = accelerator.split('+').map(token => token.trim()).filter(Boolean);
  const labels = tokens.map(token => {
    switch (token) {
      case 'CommandOrControl':
      case 'CmdOrCtrl':
        return isMac ? '⌘' : 'Ctrl';
      case 'Command':
      case 'Cmd':
        return isMac ? '⌘' : 'Cmd';
      case 'Control':
      case 'Ctrl':
        return isMac ? '⌃' : 'Ctrl';
      case 'Shift':
        return isMac ? '⇧' : 'Shift';
      case 'Alt':
      case 'Option':
        return isMac ? '⌥' : 'Alt';
      case 'Meta':
      case 'Super':
        return isMac ? '⌘' : 'Win';
      case 'ArrowUp':
        return '↑';
      case 'ArrowDown':
        return '↓';
      case 'ArrowLeft':
        return '←';
      case 'ArrowRight':
        return '→';
      case 'Escape':
        return 'Esc';
      default:
        return token;
    }
  });

  return labels.join(isMac ? '' : '+');
}

export function keyboardEventToAccelerator(event: HotkeyEvent, platform: string): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null;

  const parts = modifierPartsForEvent(event, platform);
  parts.push(normalizeEventKey(event));
  return parts.join('+');
}

export function modifierEventToAccelerator(event: HotkeyEvent, platform: string): string | null {
  const parts = modifierPartsForEvent(event, platform);
  return parts.length > 0 ? parts.join('+') : null;
}

export function eventMatchesAccelerator(event: HotkeyEvent, accelerator: string, platform: string): boolean {
  const parsed = parseAccelerator(accelerator, platform);
  if (!parsed) return false;

  for (const modifier of ['control', 'meta', 'shift', 'alt'] as const) {
    if (eventHasModifier(event, modifier) !== parsed.modifiers.has(modifier)) {
      return false;
    }
  }

  return normalizeEventKey(event) === parsed.key;
}

export function acceleratorsConflict(first: string, second: string, platform: string): boolean {
  const a = parseAccelerator(first, platform);
  const b = parseAccelerator(second, platform);
  if (!a || !b || a.key !== b.key || a.modifiers.size !== b.modifiers.size) {
    return false;
  }

  for (const modifier of a.modifiers) {
    if (!b.modifiers.has(modifier)) return false;
  }
  return true;
}
