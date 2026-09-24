// packages/web/src/state/settings.ts — the four preferences that belong to the device, not the user.
//
// CLIENT.md §7.1 and §8 L606-608. Theme, density, key-bar visibility and the flash lifetime are
// **per device**: there is no server column for them (CLIENT §18 Q1), and there should not be —
// a trading desk's 27-inch monitor and the same user's laptop want different densities, and the
// workspace row is shared between them.
//
// `localStorage` is therefore the store of record here, and it is read through a port so a test
// (and a private-mode browser, where every access throws) is an ordinary case rather than a crash.
// Nothing is retried and nothing is awaited: a preference that fails to persist still applies to
// this session.
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export type Theme = 'dark' | 'light' | 'system';
export type Density = 'compact' | 'normal' | 'comfortable';
/** 700 ms is the terminal default; 350 ms for a fast desk; 0 turns the flash off (TERM-11). */
export type FlashMs = 700 | 350 | 0;

export interface Settings {
  theme: Theme;
  density: Density;
  keybar: boolean;
  flashMs: FlashMs;
}

export const SETTINGS_KEY = 'terminal.settings';

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  theme: 'dark',
  density: 'normal',
  keybar: true,
  flashMs: 700,
});

/** The two `localStorage` methods this store uses, so tests and private mode are the same case. */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): SettingsStorage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

let storage: SettingsStorage | null = defaultStorage();

const THEMES: readonly Theme[] = ['dark', 'light', 'system'];
const DENSITIES: readonly Density[] = ['compact', 'normal', 'comfortable'];
const FLASHES: readonly FlashMs[] = [700, 350, 0];

/**
 * A stored blob is untrusted input — a hand-edited `localStorage`, or a value written by an older
 * bundle. Every field is validated individually and a bad one falls back to its default rather
 * than taking the whole object down with it.
 */
export function parseSettings(raw: string | null): Settings {
  if (raw === null) return { ...DEFAULT_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SETTINGS };
  const bag = parsed as Partial<Record<keyof Settings, unknown>>;
  return {
    theme: THEMES.includes(bag.theme as Theme) ? (bag.theme as Theme) : DEFAULT_SETTINGS.theme,
    density: DENSITIES.includes(bag.density as Density)
      ? (bag.density as Density)
      : DEFAULT_SETTINGS.density,
    keybar: typeof bag.keybar === 'boolean' ? bag.keybar : DEFAULT_SETTINGS.keybar,
    flashMs: FLASHES.includes(bag.flashMs as FlashMs)
      ? (bag.flashMs as FlashMs)
      : DEFAULT_SETTINGS.flashMs,
  };
}

function read(): Settings {
  try {
    return parseSettings(storage?.getItem(SETTINGS_KEY) ?? null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function write(settings: Settings): void {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode, quota, or no storage at all: the preference still applies to this session. */
  }
}

export interface SettingsStore extends Settings {
  configure(opts: { storage?: SettingsStorage | null }): void;
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
  /** Re-read the device's stored preferences (another tab wrote them; `storage` event). */
  hydrate(): void;
  reset(): void;
}

export const useSettingsStore = create<SettingsStore>()(
  subscribeWithSelector((setState, get) => ({
    ...read(),

    configure(opts) {
      if (opts.storage !== undefined) {
        storage = opts.storage;
        get().hydrate();
      }
    },

    set<K extends keyof Settings>(key: K, value: Settings[K]) {
      setState({ [key]: value } as Pick<Settings, K>);
      const s = get();
      write({ theme: s.theme, density: s.density, keybar: s.keybar, flashMs: s.flashMs });
    },

    hydrate() {
      setState(read());
    },

    reset() {
      setState({ ...DEFAULT_SETTINGS });
      write({ ...DEFAULT_SETTINGS });
    },
  })),
);

/* ---------------------------------------------------------------------------------------------- */
/* Selectors                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

export const selectSettings = (s: SettingsStore): Settings => ({
  theme: s.theme,
  density: s.density,
  keybar: s.keybar,
  flashMs: s.flashMs,
});

/**
 * `'system'` resolved against the media query, for `density.ts`'s `data-theme` attribute. The
 * caller passes the match so this stays a pure function (and so a test does not need `matchMedia`).
 */
export const resolveTheme = (theme: Theme, prefersDark: boolean): 'dark' | 'light' =>
  theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
