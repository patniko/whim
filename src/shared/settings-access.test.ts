import { describe, expect, it } from 'vitest';
import { canReadSetting, readableSettings, SECRET_SETTINGS } from './settings-access';

describe('settings access policy', () => {
  it('allows the settings the renderer needs in order to start', () => {
    // The renderer's entire bootstrap hangs off workspace_root: it chooses
    // between the setup flow and the real interface. Denying it meant the web
    // interface silently never mounted.
    expect(canReadSetting('workspace_root')).toBe(true);
    expect(canReadSetting('theme')).toBe(true);
  });

  it('never exposes credentials or host execution config', () => {
    for (const key of SECRET_SETTINGS) {
      expect(canReadSetting(key)).toBe(false);
    }
  });

  it('keeps the secret list and the allowlist disjoint', () => {
    // Guards against someone adding a key to both while chasing a bug.
    const overlap = SECRET_SETTINGS.filter((key) => readableSettings().includes(key));
    expect(overlap).toEqual([]);
  });

  it('refuses unknown keys rather than defaulting to readable', () => {
    expect(canReadSetting('some_setting_added_next_year')).toBe(false);
    expect(canReadSetting('')).toBe(false);
  });

  it('refuses non-string keys', () => {
    // args[0] arrives from a remote JSON body and is not guaranteed to be a
    // string; Set.has would happily return false, but an object key could
    // otherwise reach the config reader.
    expect(canReadSetting(undefined)).toBe(false);
    expect(canReadSetting({ toString: () => 'theme' })).toBe(false);
    expect(canReadSetting(['theme'])).toBe(false);
  });
});
