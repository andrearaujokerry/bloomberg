/**
 * packages/web/test/shell/statusBar.test.tsx — the quota strip, and the refresh it owns (API-06,
 * CLIENT.md §3.3 L262-270).
 *
 * `state/session.ts#setQuotas` existed and nothing in `packages/web/src` called it, so the three
 * counters in the footer were whatever the login snapshot said and stayed that way for the whole
 * session. The cadence itself is pinned in `test/state/session.test.ts`; what is pinned here is the
 * half that made it dead code — that the strip is what starts and stops it, and that a new set of
 * counters actually reaches the DOM.
 */

import type { SessionInfo } from '@terminal/sdk/wire/rest/auth';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StatusBar } from '../../src/shell/StatusBar.js';
import { useSessionStore } from '../../src/state/session.js';
import type { QuotaCounters } from '../../src/state/session.js';

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

function counters(used: number): QuotaCounters {
  return {
    dailyUniqueInstruments: { ...SESSION.quotas.dailyUniqueInstruments, used },
    monthlyDataPoints: SESSION.quotas.monthlyDataPoints,
    concurrentSubscriptions: SESSION.quotas.concurrentSubscriptions,
  };
}

beforeEach(() => {
  useSessionStore.getState().reset();
});

afterEach(() => {
  useSessionStore.getState().stopQuotaRefresh();
  vi.restoreAllMocks();
});

describe('the quota strip', () => {
  it('starts the counters’ refresh while it is mounted, and stops it when it goes', () => {
    // The strip is the only reader of `quotas`, so it owns the lifetime of their refresh: one page's
    // worth of polling, started where it is displayed. Spied on the store's own actions because THIS
    // is the wiring that was missing — `setQuotas` had no caller at all.
    const start = vi.spyOn(useSessionStore.getState(), 'startQuotaRefresh');
    const stop = vi.spyOn(useSessionStore.getState(), 'stopQuotaRefresh');

    const view = render(<StatusBar connection="open" />);
    expect(start).toHaveBeenCalledTimes(1);
    // `startQuotaRefresh` is idempotent by stopping first (a second call must not leave two timers
    // armed), so the count that matters here is the one the UNMOUNT adds.
    const stoppedOnStart = stop.mock.calls.length;

    view.unmount();
    expect(stop).toHaveBeenCalledTimes(stoppedOnStart + 1);
  });

  it('repaints the counters when they are replaced, meter and digits together', () => {
    useSessionStore.getState().setSession(SESSION);
    render(<StatusBar connection="open" />);

    const daily = screen.getByTestId('quotas').querySelector<HTMLElement>('[data-quota="dailyUniqueInstruments"]');
    expect(daily?.textContent).toContain('3/500');
    expect(daily?.querySelector('meter')?.getAttribute('value')).toBe('3');

    // What a refresh does — the one call that had no caller in the product until the strip made it.
    act(() => {
      useSessionStore.getState().setQuotas(counters(41));
    });

    const after = screen.getByTestId('quotas').querySelector<HTMLElement>('[data-quota="dailyUniqueInstruments"]');
    expect(after?.textContent).toContain('41/500');
    expect(after?.querySelector('meter')?.getAttribute('value')).toBe('41');
    // The other two are untouched by that write: the strip shows three independent counters and a
    // refresh replaces all three from one body, so a shared reference would be visible here.
    expect(after?.textContent).not.toContain('12/2,000,000');
    expect(screen.getByTestId('quotas').textContent).toContain('12/2,000,000');
  });

  it('says `quotas —` rather than zeros before a session has answered', () => {
    render(<StatusBar connection="idle" />);
    expect(screen.getByTestId('quotas').textContent).toBe('quotas —');
  });
});
