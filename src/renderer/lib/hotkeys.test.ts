import { describe, expect, it } from 'vitest';
import {
  acceleratorsConflict,
  eventMatchesAccelerator,
  formatAccelerator,
  keyboardEventToAccelerator,
  modifierEventToAccelerator,
} from './hotkeys';

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: 'a',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe('renderer hotkeys', () => {
  it('captures Command and Control as distinct modifiers on macOS', () => {
    expect(keyboardEventToAccelerator(
      keyEvent({ key: 'k', metaKey: true }),
      'MacIntel',
    )).toBe('Command+K');

    expect(keyboardEventToAccelerator(
      keyEvent({ key: 'k', ctrlKey: true }),
      'MacIntel',
    )).toBe('Control+K');
  });

  it('captures Control and Super as distinct modifiers off macOS', () => {
    expect(keyboardEventToAccelerator(
      keyEvent({ key: 'k', ctrlKey: true }),
      'Win32',
    )).toBe('Control+K');

    expect(keyboardEventToAccelerator(
      keyEvent({ key: 'k', metaKey: true }),
      'Win32',
    )).toBe('Super+K');
  });

  it('previews held modifiers without saving modifier-only presses', () => {
    const event = keyEvent({ key: 'Shift', metaKey: true, shiftKey: true });

    expect(keyboardEventToAccelerator(event, 'MacIntel')).toBeNull();
    expect(modifierEventToAccelerator(event, 'MacIntel')).toBe('Command+Shift');
  });

  it('captures Option+Command+Space as an ASCII Electron accelerator', () => {
    expect(keyboardEventToAccelerator(
      keyEvent({ key: '\u00a0', code: 'Space', metaKey: true, altKey: true }),
      'MacIntel',
    )).toBe('Command+Alt+Space');
  });

  it('uses the physical key when Option transforms a printable macOS key', () => {
    expect(keyboardEventToAccelerator(
      keyEvent({ key: '˚', code: 'KeyK', altKey: true }),
      'MacIntel',
    )).toBe('Alt+K');
  });

  it('matches CommandOrControl using platform-specific Electron semantics', () => {
    const shortcut = 'CommandOrControl+Shift+Space';

    expect(eventMatchesAccelerator(
      keyEvent({ key: ' ', metaKey: true, shiftKey: true }),
      shortcut,
      'MacIntel',
    )).toBe(true);
    expect(eventMatchesAccelerator(
      keyEvent({ key: ' ', ctrlKey: true, shiftKey: true }),
      shortcut,
      'MacIntel',
    )).toBe(false);

    expect(eventMatchesAccelerator(
      keyEvent({ key: ' ', ctrlKey: true, shiftKey: true }),
      shortcut,
      'Win32',
    )).toBe(true);
    expect(eventMatchesAccelerator(
      keyEvent({ key: ' ', metaKey: true, shiftKey: true }),
      shortcut,
      'Win32',
    )).toBe(false);
  });

  it('detects conflicts after resolving CommandOrControl for the active platform', () => {
    const shortcut = 'CommandOrControl+Shift+Space';

    expect(acceleratorsConflict(shortcut, 'Command+Shift+Space', 'MacIntel')).toBe(true);
    expect(acceleratorsConflict(shortcut, 'Control+Shift+Space', 'MacIntel')).toBe(false);
    expect(acceleratorsConflict(shortcut, 'Control+Shift+Space', 'Win32')).toBe(true);
    expect(acceleratorsConflict(shortcut, 'Super+Shift+Space', 'Win32')).toBe(false);
  });

  it('formats exact modifier accelerators for display', () => {
    expect(formatAccelerator('Control+Alt+K', 'MacIntel')).toBe('⌃⌥K');
    expect(formatAccelerator('Command+Shift+Space', 'MacIntel')).toBe('⌘⇧Space');
    expect(formatAccelerator('Control+Alt+K', 'Win32')).toBe('Ctrl+Alt+K');
    expect(formatAccelerator('Super+Shift+K', 'Win32')).toBe('Win+Shift+K');
  });
});
