// packages/web/src/state/device.ts — which browser this is, for `POST /auth/login`.
//
// `LoginRequest.deviceId` (8-64 chars) is stored in `sessions.device_id`, and `deviceLabel` is what
// another window is told when this login supersedes it (SEC-03: "Another window took this session
// at 14:02 (Chrome on macOS)"). Neither identifies a PERSON — the id is a random UUID made here, and
// the label is the browser and platform, never the user agent string verbatim (which is a
// fingerprint).
//
// `localStorage` through a port, for the same reason `state/settings.ts` uses one: a private-mode
// browser throws on every access, and that has to be an ordinary case, not a broken sign-in. With no
// storage the id lives for this page only — a new id per visit, which costs nothing but a less useful
// "which window" message.

export const DEVICE_KEY = 'terminal.deviceId';

export interface DeviceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): DeviceStorage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

let ephemeral: string | null = null;

/** A stable random id for this browser, made on first use. Never throws. */
export function deviceId(storage: DeviceStorage | null = defaultStorage()): string {
  try {
    const stored = storage?.getItem(DEVICE_KEY);
    if (stored !== null && stored !== undefined && stored.length >= 8 && stored.length <= 64) return stored;
  } catch {
    /* unreadable storage: fall through to a fresh id */
  }
  const made = globalThis.crypto.randomUUID();
  try {
    storage?.setItem(DEVICE_KEY, made);
    return made;
  } catch {
    // Private mode or quota: keep one id for the life of the page so repeated attempts agree.
    ephemeral ??= made;
    return ephemeral;
  }
}

/**
 * `Chrome on macOS` — a browser and a platform, at most 80 characters (`LoginRequest.deviceLabel`).
 * Deliberately coarse: the label exists so a person recognises their own window, not to identify a
 * machine, and the raw user agent would do the second job too well.
 */
export function deviceLabel(userAgent: string = globalThis.navigator?.userAgent ?? ''): string {
  const browser = userAgent.includes('Edg/')
    ? 'Edge'
    : userAgent.includes('Firefox/')
      ? 'Firefox'
      : userAgent.includes('Chrome/')
        ? 'Chrome'
        : userAgent.includes('Safari/')
          ? 'Safari'
          : 'A browser';
  // ORDER MATTERS: an iPhone's agent says "like Mac OS X" and an Android one says "Linux", so the
  // mobile platforms are tested before the desktop ones they mention.
  const platform = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : userAgent.includes('Android')
      ? 'Android'
      : /Mac OS X|Macintosh/.test(userAgent)
        ? 'macOS'
        : userAgent.includes('Windows')
          ? 'Windows'
          : userAgent.includes('Linux')
            ? 'Linux'
            : 'an unknown platform';
  return `${browser} on ${platform}`.slice(0, 80);
}
