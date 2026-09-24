/**
 * packages/web/test/state/session.test.ts — CLIENT.md §8 L562-572.
 *
 * The session store is the gate: what it says about `status` decides whether the shell renders at
 * all. The cases worth asserting are the ones where "signed in" is not a boolean — MFA owed, a
 * session superseded from another device (SEC-03), and a client older than the plant will talk to
 * (API.md §11). The `SessionInfo` here is API.md §1.2's own example body.
 */
import type { SessionInfo } from '@terminal/sdk/wire/rest/auth';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  selectDefaultTier,
  selectExportAllowed,
  selectNeedsReload,
  selectQuota,
  semverLt,
  useSessionStore,
} from '../../src/state/session.js';

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
