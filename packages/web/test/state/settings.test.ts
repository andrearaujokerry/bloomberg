/**
 * packages/web/test/state/settings.test.ts — CLIENT.md §7.1 and §8 L606-608.
 *
 * Per-device preferences with no server column. The cases that matter are the ones where storage
 * misbehaves: a private-mode browser throws on every access, and a stored blob may have been
 * written by an older bundle. Neither may take the terminal down, and neither may silently give
 * the user a density they did not choose.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  parseSettings,
  resolveTheme,
  selectSettings,
  useSettingsStore,
} from '../../src/state/settings.js';
import type { SettingsStorage } from '../../src/state/settings.js';

function memoryStorage(seed?: string): SettingsStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  if (seed !== undefined) store.set(SETTINGS_KEY, seed);
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

beforeEach(() => {
  useSettingsStore.getState().configure({ storage: memoryStorage() });
  useSettingsStore.getState().reset();
});

describe('settingsStore', () => {
  it('starts at the terminal defaults', () => {
    expect(selectSettings(useSettingsStore.getState())).toEqual(DEFAULT_SETTINGS);
  });

  it('writes every change straight to the device', () => {
    const storage = memoryStorage();
    useSettingsStore.getState().configure({ storage });

    useSettingsStore.getState().set('density', 'compact');
    useSettingsStore.getState().set('flashMs', 0);

    expect(useSettingsStore.getState().density).toBe('compact');
    expect(JSON.parse(storage.store.get(SETTINGS_KEY) ?? '{}')).toEqual({
      ...DEFAULT_SETTINGS,
      density: 'compact',
      flashMs: 0,
    });
  });

  it('reads what another tab wrote', () => {
    const storage = memoryStorage(JSON.stringify({ ...DEFAULT_SETTINGS, theme: 'light' }));
    useSettingsStore.getState().configure({ storage });
    expect(useSettingsStore.getState().theme).toBe('light');
  });

  it('falls back field by field on a blob it does not recognise', () => {
    expect(parseSettings('not json')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(JSON.stringify({ theme: 'neon', density: 'compact', flashMs: 42 }))).toEqual({
      ...DEFAULT_SETTINGS,
      density: 'compact',
    });
  });

  it('survives a storage that throws on every access (private mode)', () => {
    const hostile: SettingsStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    useSettingsStore.getState().configure({ storage: hostile });
    expect(selectSettings(useSettingsStore.getState())).toEqual(DEFAULT_SETTINGS);

    useSettingsStore.getState().set('keybar', false);
    // The preference still applies to this session; it simply does not outlive it.
    expect(useSettingsStore.getState().keybar).toBe(false);
  });

  it('resolves the system theme against the media query the caller passes', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });
});
