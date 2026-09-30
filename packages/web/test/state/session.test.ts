/**
 * packages/web/test/state/session.test.ts — CLIENT.md §8 L562-572.
 *
 * The session store is the gate: what it says about `status` decides whether the shell renders at
 * all. The cases worth asserting are the ones where "signed in" is not a boolean — MFA owed, a
 * session superseded from another device (SEC-03), and a client older than the plant will talk to
 * (API.md §11). The `SessionInfo` here is API.md §1.2's own example body.
 */
import type { SessionInfo } from '@terminal/sdk/wire/rest/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  QUOTA_MIN_GAP_MS,
  QUOTA_REFRESH_MS,
  selectDefaultTier,
  selectExportAllowed,
  selectNeedsReload,
  selectQuota,
  semverLt,
  useSessionStore,
} from '../../src/state/session.js';
import type { Scheduler } from '../../src/state/workspace.js';

const SESSION: SessionInfo = {
  sessionId: '6a1c0f2b-0000-4000-8000-0000000000aa',
  userId: 2,
  firmId: 1,
  firmName: 'Demo Capital',
  email: 'pm@demo.terminal',
  displayName: 'Demo PM',
  desk: 'Equities PM',
  role: 'user',
  clientKind: 'web',
  mfaRequired: false,
  mfaVerified: false,
  webauthnEnrolled: false,
  createdAt: '2026-09-15T18:40:00Z',
  expiresAt: '2026-09-22T18:40:00Z',
  entitlementSummary: { defaultTier: 'delayed', exportAllowed: true, apiAllowed: true },
  quotas: {
    dailyUniqueInstruments: { used: 3, limit: 500, resetsAt: '2026-09-16T00:00:00Z' },
    monthlyDataPoints: { used: 12, limit: 2_000_000, resetsAt: '2026-10-01T00:00:00Z' },
    concurrentSubscriptions: { used: 40, limit: 10_000, resetsAt: '2026-09-15T18:40:00Z' },
  },
  protocol: 1,
  serverVersion: '0.1.0',
  minClientVersion: '0.1.0',
  dictionaryVersion: '2026.09.1',
};

/** A `TerminalApiError`-shaped rejection: what `RestClient` throws (`status`, `code`). */
function apiError(status: number, code: string): Error & { status: number; code: string } {
  return Object.assign(new Error(code), { status, code });
}

beforeEach(() => {
  useSessionStore.getState().reset();
  useSessionStore.setState({ status: 'unknown' });
});

describe('sessionStore', () => {
  it('hydrates the principal, versions and quota counters from GET /auth/session', async () => {
    await useSessionStore.getState().load({ session: () => Promise.resolve(SESSION) });
    const s = useSessionStore.getState();

    expect(s.status).toBe('ready');
    expect(s.info?.displayName).toBe('Demo PM');
    expect(s.server).toEqual({
      serverVersion: '0.1.0',
      minClientVersion: '0.1.0',
      dictionaryVersion: '2026.09.1',
    });
    expect(selectQuota('dailyUniqueInstruments')(s)).toEqual({
      used: 3,
      limit: 500,
      resetsAt: '2026-09-16T00:00:00Z',
    });
    expect(selectDefaultTier(s)).toBe('delayed');
    expect(selectExportAllowed(s)).toBe(true);
  });

  it('gates on MFA until the second factor is verified', () => {
    useSessionStore.getState().setSession({ ...SESSION, mfaRequired: true, mfaVerified: false });
    expect(useSessionStore.getState().status).toBe('mfa');

    useSessionStore.getState().markMfaVerified();
    expect(useSessionStore.getState().status).toBe('ready');
    expect(useSessionStore.getState().info?.mfaVerified).toBe(true);
  });

  it('treats 401 as anonymous and anything else as an error worth showing', async () => {
    await useSessionStore.getState().load({ session: () => Promise.reject(apiError(401, 'AUTH_REQUIRED')) });
    expect(useSessionStore.getState().status).toBe('anonymous');
    expect(useSessionStore.getState().error).toBeNull();

    await useSessionStore.getState().load({ session: () => Promise.reject(apiError(503, 'UPSTREAM_UNAVAILABLE')) });
    expect(useSessionStore.getState().status).toBe('unknown');
    expect(useSessionStore.getState().error).toEqual({
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('locks when the session is superseded from another device', () => {
    useSessionStore.getState().setSession(SESSION);
    useSessionStore
      .getState()
      .lockSuperseded({ deviceLabel: 'Chrome on macOS', createdAt: '2026-09-15T19:00:00Z' });

    const s = useSessionStore.getState();
    expect(s.status).toBe('locked');
    expect(s.lock?.supersededBy?.deviceLabel).toBe('Chrome on macOS');
  });

  it('compares versions numerically, not lexically', () => {
    // '0.9.3' > '0.10.0' as strings, which is exactly the bug the reload badge would ship with.
    expect(semverLt('0.9.3', '0.10.0')).toBe(true);
    expect(semverLt('web/0.9.3', '0.10.0')).toBe(true);
    expect(semverLt('1.0.0', '1.0.0')).toBe(false);
    expect(semverLt('1.2.0', '1.1.9')).toBe(false);
    expect(semverLt('1.0.0-rc.1', '1.0.0')).toBe(false);
  });

  it('asks for a reload only when the plant outgrew this bundle', () => {
    useSessionStore.getState().setClientVersion('web/0.9.3');
    useSessionStore.getState().setSession(SESSION);
    expect(selectNeedsReload(useSessionStore.getState())).toBe(false);

    useSessionStore.getState().setSession({ ...SESSION, minClientVersion: '0.10.0' });
    expect(selectNeedsReload(useSessionStore.getState())).toBe(true);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The quota strip's own cadence (API-06)                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * `setQuotas` had no caller anywhere in `packages/web/src`, so the three counters in the status bar
 * were the login snapshot for the whole session: a terminal that had exported all afternoon still
 * read `3/500`. These are the properties of the refresher that closes that, and most of them are
 * about restraint — a strip that polls hard, or that writes more than the counters, costs more than
 * it is worth.
 *
 * The clock is the injected `Scheduler` the other stores take, so nothing here waits on wall time
 * (TESTING §2.2).
 */
interface FakeTimer {
  readonly fn: () => void;
  readonly ms: number;
  readonly handle: number;
}

function fakeScheduler(): {
  scheduler: Scheduler;
  timers: FakeTimer[];
  fire: () => void;
  cleared: number[];
  tick: (ms: number) => void;
} {
  let now = 1_000_000;
  const timers: FakeTimer[] = [];
  const cleared: number[] = [];
  let next = 1;
  return {
    scheduler: {
      setTimer: (fn, ms) => {
        const handle = next++;
        timers.push({ fn, ms, handle });
        return handle;
      },
      clearTimer: (handle) => {
        cleared.push(handle);
      },
      now: () => now,
    },
    timers,
    cleared,
    tick: (ms) => {
      now += ms;
    },
    /** Run the newest armed timer, as the runtime would when it comes due. */
    fire: () => {
      const timer = timers[timers.length - 1];
      if (timer === undefined) throw new Error('no timer is armed');
      timer.fn();
    },
  };
}

/** `SessionInfo` with the daily counter moved, as an export would move it. */
function spent(used: number): SessionInfo {
  return {
    ...SESSION,
    quotas: { ...SESSION.quotas, dailyUniqueInstruments: { ...SESSION.quotas.dailyUniqueInstruments, used } },
  };
}

/** jsdom's `visibilityState` is read-only; the property is redefined for the test that needs it. */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

describe('the quota refresher', () => {
  afterEach(() => {
    useSessionStore.getState().stopQuotaRefresh();
    setVisibility('visible');
  });

  it('re-reads the counters and replaces them — the strip moves', async () => {
    let served = SESSION;
    await useSessionStore.getState().load({ session: () => Promise.resolve(served) });
    expect(selectQuota('dailyUniqueInstruments')(useSessionStore.getState())?.used).toBe(3);

    served = spent(41);
    await useSessionStore.getState().refreshQuotas();
    expect(selectQuota('dailyUniqueInstruments')(useSessionStore.getState())?.used).toBe(41);
    expect(useSessionStore.getState().quotasAt).not.toBeNull();
  });

  it('writes ONLY the counters, so a superseded session stays locked (SEC-03)', async () => {
    // The reason the refresh does not call `setSession`: that action clears `lock`, and a session
    // taken by another device would silently unlock itself on the next tick. It also must not call at
    // all while locked — the terminal is gone, and the footer is not a reason to keep polling.
    let calls = 0;
    await useSessionStore.getState().load({
      session: () => {
        calls += 1;
        return Promise.resolve(SESSION);
      },
    });
    useSessionStore.getState().lockSuperseded({ deviceLabel: 'Chrome on macOS', createdAt: '2026-09-15T19:00:00Z' });
    const before = calls;

    await useSessionStore.getState().refreshQuotas();

    expect(useSessionStore.getState().status).toBe('locked');
    expect(useSessionStore.getState().lock?.supersededBy?.deviceLabel).toBe('Chrome on macOS');
    expect(calls, 'a locked session was polled anyway').toBe(before);
  });

  it('cannot unlock a session superseded WHILE a read was in flight (SEC-03)', async () => {
    // The sharp version of the rule above, and the one a guard on `status` alone does not cover: the
    // read is awaited, so the supersede can land between the request and the response. A refresh that
    // wrote the whole `SessionInfo` back would clear `lock` and set `status: 'ready'` here — the
    // terminal would hand itself back to a session another device has taken. Only the counters are
    // written, so the lock survives its own refresh.
    let release: ((info: SessionInfo) => void) | null = null;
    const inFlightBody = new Promise<SessionInfo>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    await useSessionStore.getState().load({
      session: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve(SESSION) : inFlightBody;
      },
    });
    expect(useSessionStore.getState().status).toBe('ready');

    const pending = useSessionStore.getState().refreshQuotas();
    useSessionStore
      .getState()
      .lockSuperseded({ deviceLabel: 'Chrome on macOS', createdAt: '2026-09-15T19:00:00Z' });
    release?.(spent(41));
    await pending;

    expect(useSessionStore.getState().status, 'a superseded session unlocked itself').toBe('locked');
    expect(useSessionStore.getState().lock?.supersededBy?.deviceLabel).toBe('Chrome on macOS');
    // …and the body that did arrive was used for the one thing it is read for.
    expect(selectQuota('dailyUniqueInstruments')(useSessionStore.getState())?.used).toBe(41);
  });

  it('does nothing before a port has been handed over, or for an anonymous session', async () => {
    // Nothing is thrown and nothing is invented: this is what the store looks like on a page that has
    // not signed in, which is where the status bar mounts first.
    await useSessionStore.getState().refreshQuotas();
    expect(useSessionStore.getState().quotas).toBeNull();

    await useSessionStore.getState().load({ session: () => Promise.reject(apiError(401, 'AUTH_REQUIRED')) });
    await useSessionStore.getState().refreshQuotas();
    expect(useSessionStore.getState().quotas).toBeNull();
    expect(useSessionStore.getState().error).toBeNull();
  });

  it('keeps the last known counters when a refresh fails, and reports no session error', async () => {
    let fail = false;
    await useSessionStore.getState().load({
      session: () => (fail ? Promise.reject(apiError(503, 'UPSTREAM_UNAVAILABLE')) : Promise.resolve(SESSION)),
    });
    fail = true;
    await useSessionStore.getState().refreshQuotas();

    // A footer that could not refresh must not take the terminal away through the session gate.
    expect(selectQuota('dailyUniqueInstruments')(useSessionStore.getState())?.used).toBe(3);
    expect(useSessionStore.getState().status).toBe('ready');
    expect(useSessionStore.getState().error).toBeNull();
  });

  it('refuses two reads inside the floor, whatever asks for them', async () => {
    const clock = fakeScheduler();
    let calls = 0;
    await useSessionStore.getState().load({
      session: () => {
        calls += 1;
        return Promise.resolve(SESSION);
      },
    });
    useSessionStore.getState().startQuotaRefresh({ scheduler: clock.scheduler });
    const afterLoad = calls;

    await useSessionStore.getState().refreshQuotas();
    expect(calls).toBe(afterLoad + 1);
    await useSessionStore.getState().refreshQuotas();
    expect(calls, 'the floor did not hold').toBe(afterLoad + 1);

    clock.tick(QUOTA_MIN_GAP_MS + 1);
    await useSessionStore.getState().refreshQuotas();
    expect(calls).toBe(afterLoad + 2);
  });

  it('arms one timer at the interval, reads when it fires, and re-arms', async () => {
    const clock = fakeScheduler();
    let served = SESSION;
    await useSessionStore.getState().load({ session: () => Promise.resolve(served) });
    useSessionStore.getState().startQuotaRefresh({ scheduler: clock.scheduler });

    expect(clock.timers).toHaveLength(1);
    expect(clock.timers[0]?.ms).toBe(QUOTA_REFRESH_MS);
    // The first read is one interval away, not at start: the strip was seeded by the login snapshot
    // moments earlier and an immediate read would fetch what the page already has.
    expect(selectQuota('dailyUniqueInstruments')(useSessionStore.getState())?.used).toBe(3);

    served = spent(17);
    clock.tick(QUOTA_REFRESH_MS);
    clock.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(selectQuota('dailyUniqueInstruments')(useSessionStore.getState())?.used).toBe(17);
    expect(clock.timers, 'the cadence stopped after one tick').toHaveLength(2);
  });

  it('will not be asked to poll faster than the floor', () => {
    const clock = fakeScheduler();
    useSessionStore.getState().startQuotaRefresh({ scheduler: clock.scheduler, intervalMs: 5 });
    expect(clock.timers[0]?.ms).toBe(QUOTA_MIN_GAP_MS);
  });

  it('does not poll a terminal nobody is looking at, and catches up when it comes back', async () => {
    const clock = fakeScheduler();
    let calls = 0;
    let served = SESSION;
    await useSessionStore.getState().load({
      session: () => {
        calls += 1;
        return Promise.resolve(served);
      },
    });
    useSessionStore.getState().startQuotaRefresh({ scheduler: clock.scheduler });
    const armed = calls;

    setVisibility('hidden');
    clock.tick(QUOTA_REFRESH_MS);
    clock.fire();
    await Promise.resolve();
    expect(calls, 'a hidden tab was polled').toBe(armed);
    // …and the cadence is still running: a hidden tab skips a read, it does not stop the timer.
    expect(clock.timers).toHaveLength(2);

    served = spent(88);
    setVisibility('visible');
    clock.tick(QUOTA_MIN_GAP_MS + 1);
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    await Promise.resolve();
    expect(selectQuota('dailyUniqueInstruments')(useSessionStore.getState())?.used).toBe(88);
  });

  it('stops: no timer, and no listener left on the document', async () => {
    const clock = fakeScheduler();
    let calls = 0;
    await useSessionStore.getState().load({
      session: () => {
        calls += 1;
        return Promise.resolve(SESSION);
      },
    });
    useSessionStore.getState().startQuotaRefresh({ scheduler: clock.scheduler });
    const armed = calls;
    useSessionStore.getState().stopQuotaRefresh();

    expect(clock.cleared).toEqual([clock.timers[0]?.handle]);
    clock.tick(QUOTA_REFRESH_MS + 1);
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(calls, 'a stopped refresher still answered the document').toBe(armed);
  });
});
