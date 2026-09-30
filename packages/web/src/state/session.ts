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
//
// ## The counters are re-read, and this is why they are re-read the way they are (API-06)
//
// `setQuotas` existed and nothing called it, so the status strip was seeded once from
// `SessionInfo.quotas` at page load and then frozen for the session — a terminal that had exported
// for an hour still showed the login snapshot's `3/500`. The refresher below closes that, and three
// choices in it are deliberate.
//
// **A slow poll, not a fast one, and not a per-request hook.** The cheapest possible refresh already
// exists on the wire: `x-quota-*` is stamped on every data-bearing response (API.md §8, and
// `server/src/http/routes/data.ts#quotaHeaderHook`) and the SDK parses it into `TraceEvent.quota`.
// It was not used, because reaching it means an `onTrace` on `createClient` in `App.tsx`, and
// `App.tsx` is not this file's to edit this round. The second-cheapest is the one taken: one read a
// minute. At 60 s the strip is never more than a minute behind three advisory counters that no
// trading decision is made on (API-06 is counted, not enforced, for a web session), and it is 60
// requests an hour beside a socket delivering 200 quote frames a second — visible in a log, not a
// load. Anything faster would be a load generator for a number a user glances at.
//
// **Nothing polls a terminal nobody is looking at.** The timer skips while
// `document.visibilityState` is `hidden` and refreshes once when the tab comes back, so a desk of
// parked windows costs nothing and the first glance after returning is fresh.
//
// **The read is `GET /auth/session`, and it writes ONLY the counters.** `GET /usage/quota` is the
// route for this and is strictly cheaper, but the only session port this store is handed is
// `SessionApi` (`{ session() }`) — `App.tsx` passes `sdk.auth`, which declares no quota route — and
// inventing an optional member no host passes would be a dead branch. `SessionInfo.quotas` comes
// from the same `Quotas.state` call `GET /usage/quota` answers from, so the numbers are identical.
// What the refresh must NOT do is call `setSession`: that clears `lock`, so a session superseded from
// another device (SEC-03) would silently unlock itself a minute later. It calls `setQuotas` and
// nothing else, and it does not run at all unless the session is `ready`.
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

import type { QuotaUsage, SessionInfo } from '@terminal/sdk/wire/rest/auth';

import type { Scheduler } from './workspace.js';

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
   * Latest counters. Seeded from `SessionInfo.quotas` at load and re-read on the cadence below, so
   * the strip moves as the session spends its allowance instead of showing the login snapshot all
   * day (API-06; the header explains the cadence).
   */
  quotas: QuotaCounters | null;
  /** `Scheduler.now()` of the last successful counter read; the floor below is measured from it. */
  quotasAt: number | null;
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
  /**
   * Re-read the three counters (API-06). A no-op unless the session is `ready`, a port has been
   * handed to {@link SessionStore.load}, and the floor has elapsed; a failure leaves the last known
   * counters in place, because a strip one minute stale is better than a terminal that reports an
   * error about its own footer.
   */
  refreshQuotas(): Promise<void>;
  /** Start the cadence. Idempotent: a second call replaces the first one's timer. */
  startQuotaRefresh(opts?: QuotaRefreshOptions): void;
  stopQuotaRefresh(): void;
  reset(): void;
}

/** What a test injects; the defaults are the ones the product runs with. */
export interface QuotaRefreshOptions {
  /** The same injected `Scheduler` the workspace and usage stores take (TESTING §2.2). */
  scheduler?: Scheduler;
  /** Clamped up to {@link QUOTA_MIN_GAP_MS}: nothing may ask for a faster poll than the floor. */
  intervalMs?: number;
}

/** One read a minute — the reasoning is in the file header. */
export const QUOTA_REFRESH_MS = 60_000;

/** No two reads closer together than this, whatever asks for one. */
export const QUOTA_MIN_GAP_MS = 5_000;

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
  quotasAt: null,
  error: null,
};

/* ---------------------------------------------------------------------------------------------- */
/* The quota refresher's own state — module scope, like `state/usage.ts`'s batcher                   */
/* ---------------------------------------------------------------------------------------------- */

const defaultScheduler: Scheduler = {
  setTimer: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimer: (handle) => {
    globalThis.clearTimeout(handle);
  },
  now: () => Date.now(),
};

/**
 * The port `load()` was handed, kept for the refresher.
 *
 * `load(api)` takes it per call so the store can be exercised without the page's client (see the
 * header's second departure). The refresher needs the same port on a timer, and asking the caller to
 * pass it twice would let the two disagree.
 */
let sessionApi: SessionApi | null = null;
let scheduler: Scheduler = defaultScheduler;
let refreshMs = QUOTA_REFRESH_MS;
let timer: number | null = null;
let onVisible: (() => void) | null = null;
let inFlight = false;

/** The document, when there is one — this store is also exercised outside a DOM. */
function documentOf(): Document | undefined {
  return typeof globalThis.document === 'undefined' ? undefined : globalThis.document;
}

/** Is anyone looking? An absent `document` counts as visible: it cannot say otherwise. */
function visible(): boolean {
  return documentOf()?.visibilityState !== 'hidden';
}

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
      sessionApi = api;
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

    async refreshQuotas() {
      const api = sessionApi;
      // Four refusals, each for its own reason: no port (nothing to call), not `ready` (an
      // anonymous session has no counters and a locked one must not be touched — see the header),
      // inside the floor, and one already in flight.
      if (api === null || get().status !== 'ready' || inFlight) return;
      const last = get().quotasAt;
      if (last !== null && scheduler.now() - last < QUOTA_MIN_GAP_MS) return;
      inFlight = true;
      try {
        const info = await api.session();
        set({ quotas: quotasOf(info), quotasAt: scheduler.now() });
      } catch {
        // Deliberately silent, and deliberately NOT `error`: that field is what the session gate
        // renders, and a footer that could not refresh is not a reason to take the terminal away.
      } finally {
        inFlight = false;
      }
    },

    startQuotaRefresh(opts = {}) {
      get().stopQuotaRefresh();
      scheduler = opts.scheduler ?? defaultScheduler;
      refreshMs = Math.max(QUOTA_MIN_GAP_MS, opts.intervalMs ?? QUOTA_REFRESH_MS);

      const arm = (): void => {
        timer = scheduler.setTimer(() => {
          timer = null;
          // The strip was seeded by the login snapshot, so the FIRST read is one interval away: an
          // immediate one would re-fetch what the page already has.
          if (visible()) void get().refreshQuotas();
          arm();
        }, refreshMs);
      };
      arm();

      const doc = documentOf();
      if (doc !== undefined) {
        onVisible = (): void => {
          if (visible()) void get().refreshQuotas();
        };
        doc.addEventListener('visibilitychange', onVisible);
      }
    },

    stopQuotaRefresh() {
      if (timer !== null) scheduler.clearTimer(timer);
      timer = null;
      const doc = documentOf();
      if (onVisible !== null && doc !== undefined) doc.removeEventListener('visibilitychange', onVisible);
      onVisible = null;
    },

    reset() {
      get().stopQuotaRefresh();
      sessionApi = null;
      scheduler = defaultScheduler;
      inFlight = false;
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
