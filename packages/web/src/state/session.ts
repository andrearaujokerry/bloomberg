// packages/web/src/state/session.ts — who is signed in, what they may see, and how much is left.
//
// CLIENT.md §8 L562-570. One concern: the principal from `GET /auth/session` (API.md §1.2), the
// entitlement summary the shell pre-labels screens with (ENTL-05), the three quota counters the
// status bar shows (API-06), and the two conditions that take the terminal away from the user —
// MFA not yet verified, and this session superseded by a login elsewhere (SEC-03).
//
// Two deliberate departures from the CLIENT.md sketch, both so the store is testable without a
// build step and without a module-scope singleton:
//
//   * `clientVersion` is state, set by `bootstrap/client.ts`, rather than the `__APP_VERSION__`
//     vite define read inside `selectNeedsReload`. A selector that reads a build-time global
//     cannot be exercised by a unit test at all, and the value is already in main.tsx's hand.
//   * `load()` takes the auth namespace as a parameter (a port, structurally satisfied by
//     `TerminalClient['auth']`) instead of importing the page's client. All IO is still the SDK's
//     (API-05); the store merely says *when*.
//
// No entitlement or quota arithmetic happens here. `used`/`limit` are carried exactly as the
// server sent them; what a screen may show is the evaluator's decision, never this store's.
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

import type { QuotaUsage, SessionInfo } from '@terminal/sdk/wire/rest/auth';

/** `unknown` until the first `GET /auth/session` answers (CLIENT §8 L563). */
export type SessionStatus = 'unknown' | 'anonymous' | 'mfa' | 'ready' | 'locked';

/** The three version strings every response echoes (API.md §11). */
export interface ServerVersions {
  serverVersion: string;
  minClientVersion: string;
  dictionaryVersion: string;
}

/** What `POST /auth/login` reports about the web session this one displaced (SEC-03). */
export interface SupersededBy {
  deviceLabel: string;
  createdAt: string;
}

/** The three counters of `SessionInfo.quotas` / `GET /usage/quota` (API.md §5.13). */
export interface QuotaCounters {
  dailyUniqueInstruments: QuotaUsage;
  monthlyDataPoints: QuotaUsage;
  concurrentSubscriptions: QuotaUsage;
}

/** The slice of `TerminalClient['auth']` this store calls. All IO stays in the SDK (API-05). */
export interface SessionApi {
  session(): Promise<SessionInfo>;
}

export interface SessionStore {
  status: SessionStatus;
  info: SessionInfo | null;
  server: ServerVersions | null;
  lock: { supersededBy?: SupersededBy } | null;
  /** `'web/0.1.0'` — what `bootstrap/client.ts` sends as `x-client-version`. */
  clientVersion: string | null;
  /**
   * Latest counters. Seeded from `SessionInfo.quotas` and replaced by `GET /usage/quota`, which is
   * fresher than the login snapshot once a session has been running for a while.
   */
  quotas: QuotaCounters | null;
  /** The last failure of `load()`, for the login screen to show. */
  error: { code: string; message: string } | null;

  setSession(info: SessionInfo | null): void;
  setServerVersion(v: ServerVersions | null): void;
  setClientVersion(v: string): void;
  setQuotas(q: QuotaCounters): void;
  lockSuperseded(d?: SupersededBy): void;
  /** MFA verified in a second step (`/auth/webauthn/login/verify`) without a fresh session body. */
  markMfaVerified(): void;
  /** `GET /auth/session`; a 401/403 means anonymous, not a crash. */
  load(api: SessionApi): Promise<void>;
  reset(): void;
}

/** MFA gate (CLIENT §2): a session that still owes a second factor is not `ready`. */
function statusOf(info: SessionInfo | null): SessionStatus {
  if (info === null) return 'anonymous';
  return info.mfaRequired && !info.mfaVerified ? 'mfa' : 'ready';
}

function versionsOf(info: SessionInfo): ServerVersions {
  return {
    serverVersion: info.serverVersion,
    minClientVersion: info.minClientVersion,
    dictionaryVersion: info.dictionaryVersion,
  };
}

function quotasOf(info: SessionInfo): QuotaCounters {
  return {
    dailyUniqueInstruments: info.quotas.dailyUniqueInstruments,
    monthlyDataPoints: info.quotas.monthlyDataPoints,
    concurrentSubscriptions: info.quotas.concurrentSubscriptions,
  };
}

/** `{ code, message }` from a `TerminalApiError`, or a generic shape from anything else. */
function errorOf(err: unknown): { code: string; message: string } {
  if (typeof err === 'object' && err !== null) {
    const bag = err as { code?: unknown; message?: unknown };
    const code = typeof bag.code === 'string' ? bag.code : 'UNKNOWN';
    const message = typeof bag.message === 'string' ? bag.message : 'unknown error';
    return { code, message };
  }
  return { code: 'UNKNOWN', message: typeof err === 'string' ? err : 'unknown error' };
}

/** 401/403 (and the transport's own `AUTH_REQUIRED`) mean "not signed in", not "broken". */
function isAnonymous(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const bag = err as { status?: unknown; code?: unknown };
  if (bag.status === 401 || bag.status === 403) return true;
  return bag.code === 'AUTH_REQUIRED' || bag.code === 'FORBIDDEN';
}

const INITIAL = {
  status: 'unknown' as SessionStatus,
  info: null,
  server: null,
  lock: null,
  clientVersion: null,
  quotas: null,
  error: null,
};

export const useSessionStore = create<SessionStore>()(
  subscribeWithSelector((set, get) => ({
    ...INITIAL,

    setSession(info) {
      set({
        info,
        status: statusOf(info),
        quotas: info === null ? null : quotasOf(info),
        server: info === null ? get().server : versionsOf(info),
        error: null,
        lock: null,
      });
    },

    setServerVersion(v) {
      set({ server: v });
    },

    setClientVersion(v) {
      set({ clientVersion: v });
    },

    setQuotas(q) {
      set({ quotas: q });
    },

    lockSuperseded(d) {
      set({ status: 'locked', lock: d === undefined ? {} : { supersededBy: d } });
    },

    markMfaVerified() {
      const info = get().info;
      if (info === null) return;
      const next: SessionInfo = { ...info, mfaVerified: true };
      set({ info: next, status: statusOf(next) });
    },

    async load(api) {
      try {
        const info = await api.session();
        get().setSession(info);
      } catch (err) {
        if (isAnonymous(err)) {
          set({ info: null, status: 'anonymous', quotas: null, error: null });
          return;
        }
        set({ status: 'unknown', error: errorOf(err) });
      }
    },

    reset() {
      set({ ...INITIAL, clientVersion: get().clientVersion, status: 'anonymous' });
    },
  })),
);

/* ---------------------------------------------------------------------------------------------- */
/* Selectors                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** CLIENT §8 L571. `'delayed'` for every seeded user; the floor a screen labels itself with. */
export const selectDefaultTier = (s: SessionStore): 'eod' | 'delayed' | 'realtime' =>
  s.info?.entitlementSummary.defaultTier ?? 'delayed';

export const selectExportAllowed = (s: SessionStore): boolean =>
  s.info?.entitlementSummary.exportAllowed ?? false;

export const selectIsReady = (s: SessionStore): boolean => s.status === 'ready';

export const selectQuota =
  (kind: keyof QuotaCounters) =>
  (s: SessionStore): QuotaUsage | null =>
    s.quotas?.[kind] ?? null;

/**
 * Numeric-core semver comparison (`0.9.3 < 0.10.0`), tolerant of the `web/` prefix the client
 * version carries and of pre-release suffixes, which are ignored: `1.0.0-rc.1` compares as `1.0.0`.
 * String comparison is wrong here and quietly so — `'0.9' > '0.10'` lexically.
 */
export function semverLt(a: string, b: string): boolean {
  const parts = (v: string): number[] => {
    const core = v.replace(/^[^0-9]*/, '').split(/[-+]/, 1)[0] ?? '';
    return core.split('.').map((n) => {
      const parsed = Number.parseInt(n, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
  };
  const left = parts(a);
  const right = parts(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r;
  }
  return false;
}

/** CLIENT §8 L572 — the reload badge when the plant has moved past this bundle (API.md §11). */
export const selectNeedsReload = (s: SessionStore): boolean =>
  s.server !== null && s.clientVersion !== null && semverLt(s.clientVersion, s.server.minClientVersion);
