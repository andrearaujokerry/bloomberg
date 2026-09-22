/**
 * `http/auth/session.ts` against the real `sessions` table — WORKPLAN WP-07 acceptance row
 * "login → cookie, token never stored in clear, second login supersedes the first, expiry and
 * revoke reasons" (API.md §1.1, ARCHITECTURE §10 rule 7).
 *
 * Self-sufficient (WP-15's seed does not exist): every firm, user and session is created inside
 * this file's own `withTxDb()` transaction, which is also the service's and the guard app's `db`,
 * so the rows the handlers read are the rows the test wrote and everything rolls back.
 *
 * Time is a `VirtualClock`. The 12 h sliding and 7 d absolute windows are asserted by moving that
 * clock, never by waiting, and nothing here reads `Date.now()`.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import type { AppDeps } from '../../../src/app.js';
import { getConfig } from '../../../src/config.js';
import {
  requireSession,
  sessionService,
  SESSION_COOKIE,
  WEB_ABSOLUTE_MS,
  WEB_SLIDING_MS,
  type SessionAccessLogRow,
} from '../../../src/http/auth/session.js';
import { setPassword, verifyPassword } from '../../../src/http/auth/password.js';
import { registerErrorHandling } from '../../../src/http/errors.js';
import { registerTrace } from '../../../src/http/trace.js';
import type { Tx } from '../../../src/db/client.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';

const t = withTxDb();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures the test owns
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface SeededUser {
  userId: number;
  firmId: number;
  email: string;
}

async function seedUser(
  db: TestDb,
  spec: { role?: string; mfaRequired?: boolean; status?: string } = {},
): Promise<SeededUser> {
  const firm = await db.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Auth Test Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const email = `auth-${randomUUID()}@demo.invalid`;
  const user = await db.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role, status, mfa_required)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING user_id`,
    [
      firmId,
      email,
      'Auth Test User',
      spec.role ?? 'user',
      spec.status ?? 'active',
      spec.mfaRequired ?? false,
    ],
  );
  return { userId: Number(user.rows[0]!.user_id), firmId, email };
}

/** A device id long enough for `Rest.Auth.LoginRequest` (min 8 characters). */
function deviceId(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A minimal app that exercises the guard exactly as a route would
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The guard's dependencies are `app.deps.db` and `app.deps.clock`, so a five-route Fastify
 * instance is enough to test it — and it is the production `requireSession`, the production
 * trace hook and the production error handler, so the envelopes asserted here are the shipped ones.
 */
async function guardApp(db: Tx, clock: VirtualClock): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const config = getConfig();
  app.decorate('deps', { config, clock, db } as unknown as AppDeps);
  registerTrace(app);
  registerErrorHandling(app);
  await app.register(cookie, {
    secret: config.SESSION_SECRET,
    parseOptions: { httpOnly: true, sameSite: 'strict', path: '/' },
  });

  const ok = (): Promise<{ ok: true }> => Promise.resolve({ ok: true });
  app.get('/me', { preHandler: requireSession() }, (request) =>
    Promise.resolve({
      userId: request.principal?.userId,
      clientKind: request.principal?.clientKind,
      scopes: request.principal?.scopes,
    }),
  );
  app.post('/me', { preHandler: requireSession() }, ok);
  app.get('/auth/whoami', { preHandler: requireSession() }, (request) =>
    Promise.resolve({ userId: request.principal?.userId }),
  );
  app.get('/admin', { preHandler: requireSession({ roles: ['admin'] }) }, ok);
  app.get('/fn', { preHandler: requireSession({ scopes: ['fn:run'] }) }, ok);

  await app.ready();
  return app;
}

/** The `tsid` cookie value a browser would present for `token`. */
function signed(token: string): string {
  return cookie.sign(token, getConfig().SESSION_SECRET);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Minting
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('sessionService.mintWebSession', () => {
  it('stores only digest(token,\'sha256\') — the clear token is in no column', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const service = sessionService({ db: t.db, clock });

    const minted = await service.mintWebSession({
      userId: user.userId,
      deviceId: deviceId('device'),
      deviceLabel: 'Chrome on macOS',
      ip: '203.0.113.7',
      mfaVerified: true,
    });

    // 32 random bytes, base64url.
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(minted.token, 'base64url')).toHaveLength(32);

    const row = await t.client.query<{ whole: string; matches: boolean; hex: string }>(
      `SELECT s::text AS whole,
              s.token_hash = digest($2, 'sha256') AS matches,
              encode(s.token_hash, 'hex') AS hex
         FROM sessions s
        WHERE s.session_id = $1`,
      [minted.sessionId, minted.token],
    );
    expect(row.rowCount).toBe(1);
    // pgcrypto's digest and node's sha256 are the same bytes — this is the contract `ws/auth.ts`
    // also relies on.
    expect(row.rows[0]!.matches).toBe(true);
    expect(row.rows[0]!.hex).toBe(createHash('sha256').update(minted.token, 'utf8').digest('hex'));
    // No column of the row — cast whole to text — contains the clear token.
    expect(row.rows[0]!.whole).not.toContain(minted.token);

    // Nor does any other session column anywhere.
    const anywhere = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sessions s WHERE s::text LIKE '%' || $1 || '%'`,
      [minted.token],
    );
    expect(anywhere.rows[0]!.n).toBe('0');
  });

  it('resolves the cookie it minted to the natural person behind it', async () => {
    const clock = testClock();
    const user = await seedUser(t, { role: 'compliance' });
    const service = sessionService({ db: t.db, clock });

    const minted = await service.mintWebSession({
      userId: user.userId,
      deviceId: deviceId('device'),
      mfaVerified: true,
    });
    const principal = await service.resolveCookie(minted.token);

    expect(principal).not.toBeNull();
    expect(principal).toMatchObject({
      userId: user.userId,
      firmId: user.firmId,
      sessionId: minted.sessionId,
      email: user.email,
      role: 'compliance',
      clientKind: 'web',
      mfaVerified: true,
      mfaRequired: false,
    });
    expect(principal!.scopes).toEqual(['data:read', 'fn:run', 'ws:subscribe']);
    // A web token is not a bearer token: the two client kinds are different licence positions.
    expect(await service.resolveBearer(minted.token)).toBeNull();
    expect(minted.expiresAt).toBe(new Date(clock.now() + WEB_ABSOLUTE_MS).toISOString());
  });

  it('records the login instant from the injected clock, not the wall clock', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const service = sessionService({ db: t.db, clock });
    const minted = await service.mintWebSession({
      userId: user.userId,
      deviceId: deviceId('device'),
      mfaVerified: false,
    });
    const row = await t.client.query<{ created_at: Date; expires_at: Date }>(
      `SELECT created_at, expires_at FROM sessions WHERE session_id = $1`,
      [minted.sessionId],
    );
    expect(row.rows[0]!.created_at.getTime()).toBe(clock.now());
    expect(row.rows[0]!.expires_at.getTime()).toBe(clock.now() + WEB_ABSOLUTE_MS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SEC-03 — one active web session per natural person
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('a second web login supersedes the first (SEC-03, ARCHITECTURE §10 rule 7)', () => {
  it('revokes the incumbent, counts the displacement and reports what it displaced', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const service = sessionService({ db: t.db, clock });

    const first = await service.mintWebSession({
      userId: user.userId,
      deviceId: deviceId('desk'),
      deviceLabel: 'Chrome on macOS',
      mfaVerified: true,
    });
    clock.advance(60_000);
    const second = await service.mintWebSession({
      userId: user.userId,
      deviceId: deviceId('home'),
      deviceLabel: 'Safari on iPad',
      mfaVerified: true,
    });

    expect(second.superseded).not.toBeNull();
    expect(second.superseded!.sessionId).toBe(first.sessionId);
    expect(second.superseded!.deviceLabel).toBe('Chrome on macOS');

    const rows = await t.client.query<{
      session_id: string;
      revoked_at: Date | null;
      revoke_reason: string | null;
      superseded_count: number;
    }>(
      `SELECT session_id, revoked_at, revoke_reason, superseded_count
         FROM sessions WHERE user_id = $1 ORDER BY created_at`,
      [user.userId],
    );
    expect(rows.rows).toHaveLength(2);
    const [displaced, current] = rows.rows;
    expect(displaced!.session_id).toBe(first.sessionId);
    expect(displaced!.revoked_at?.getTime()).toBe(clock.now());
    expect(displaced!.revoke_reason).toBe('superseded');
    expect(displaced!.superseded_count).toBe(1);
    expect(current!.session_id).toBe(second.sessionId);
    expect(current!.revoked_at).toBeNull();
    expect(current!.superseded_count).toBe(1);

    // The displaced token is dead; the new one lives.
    expect(await service.resolveCookie(first.token)).toBeNull();
    expect(await service.resolveCookie(second.token)).not.toBeNull();

    // The partial unique index `sessions_one_active_web` is satisfied, not raced.
    const active = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sessions
        WHERE user_id = $1 AND client_kind = 'web' AND revoked_at IS NULL`,
      [user.userId],
    );
    expect(active.rows[0]!.n).toBe('1');
  });

  it('writes the CONCURRENT_SESSION access_log row for the displaced session', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const service = sessionService({ db: t.db, clock });
    const traceId = randomUUID();

    const first = await service.mintWebSession({
      userId: user.userId,
      deviceId: deviceId('desk'),
      mfaVerified: true,
    });
    const second = await service.mintWebSession({
      userId: user.userId,
      deviceId: deviceId('home'),
      mfaVerified: true,
      traceId,
    });

    const log = await t.client.query<{
      user_id: string;
      firm_id: string;
      session_id: string;
      decision: string;
      reason: string;
      purpose: string;
      tier: string | null;
      trace_id: string;
      details: { newSessionId: string };
      ts: Date;
    }>(
      `SELECT user_id, firm_id, session_id, decision, reason, purpose, tier, trace_id, details, ts
         FROM access_log WHERE user_id = $1`,
      [user.userId],
    );
    expect(log.rows).toHaveLength(1);
    const row = log.rows[0]!;
    expect(Number(row.firm_id)).toBe(user.firmId);
    expect(row.decision).toBe('deny');
    expect(row.reason).toBe('CONCURRENT_SESSION');
    expect(row.purpose).toBe('auth.login');
    expect(row.tier).toBeNull();
    expect(row.session_id).toBe(first.sessionId);
    expect(row.trace_id).toBe(traceId);
    expect(row.details.newSessionId).toBe(second.sessionId);
    expect(row.ts.getTime()).toBe(clock.now());
  });

  it('hands the row to an injected AccessLog instead of writing it inline', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const appended: SessionAccessLogRow[] = [];
    const service = sessionService({
      db: t.db,
      clock,
      log: {
        append(row) {
          appended.push(row);
          return appended.length;
        },
      },
    });

    await service.mintWebSession({
      userId: user.userId,
      deviceId: deviceId('desk'),
      mfaVerified: true,
    });
    await service.mintWebSession({
      userId: user.userId,
      deviceId: deviceId('home'),
      mfaVerified: true,
    });

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      decision: 'deny',
      reason: 'CONCURRENT_SESSION',
      purpose: 'auth.login',
      usage: 'display',
      userId: user.userId,
      firmId: user.firmId,
    });
    // Batched: nothing reached the table on the login path.
    const inline = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM access_log WHERE user_id = $1`,
      [user.userId],
    );
    expect(inline.rows[0]!.n).toBe('0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Expiry and revocation
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('expiry and revocation', () => {
  it('rejects an expired, a revoked and an unknown token alike', async () => {
    const clock = testClock();
    const service = sessionService({ db: t.db, clock });

    const expiredUser = await seedUser(t);
    const expired = await service.mintWebSession({
      userId: expiredUser.userId,
      deviceId: deviceId('device'),
      mfaVerified: true,
    });
    const revokedUser = await seedUser(t);
    const revoked = await service.mintWebSession({
      userId: revokedUser.userId,
      deviceId: deviceId('device'),
      mfaVerified: true,
    });
    await service.revoke(revoked.sessionId, 'logout');

    clock.advance(WEB_ABSOLUTE_MS + 1);

    expect(await service.resolveCookie(expired.token)).toBeNull();
    expect(await service.resolveCookie(revoked.token)).toBeNull();
    expect(await service.resolveCookie('not-a-token-at-all')).toBeNull();
    expect(await service.resolveCookie('')).toBeNull();

    const reason = await t.client.query<{ revoke_reason: string | null }>(
      `SELECT revoke_reason FROM sessions WHERE session_id = $1`,
      [revoked.sessionId],
    );
    expect(reason.rows[0]!.revoke_reason).toBe('logout');
  });

  it('refuses a session whose user is no longer active', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const service = sessionService({ db: t.db, clock });
    const minted = await service.mintWebSession({
      userId: user.userId,
      deviceId: deviceId('device'),
      mfaVerified: true,
    });
    expect(await service.resolveCookie(minted.token)).not.toBeNull();

    await t.client.query(`UPDATE users SET status = 'deprovisioned' WHERE user_id = $1`, [
      user.userId,
    ]);
    expect(await service.resolveCookie(minted.token)).toBeNull();
  });

  it('slides 12 h on activity and still dies at the 7 d absolute cap', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const service = sessionService({ db: t.db, clock });
    const minted = await service.mintWebSession({
      userId: user.userId,
      deviceId: deviceId('device'),
      mfaVerified: true,
    });

    // Just inside the sliding window.
    clock.advance(WEB_SLIDING_MS - 1_000);
    expect(await service.resolveCookie(minted.token)).not.toBeNull();

    // Activity refreshes `last_seen_at`, so another 11 h is still fine.
    await service.touch(minted.sessionId);
    clock.advance(WEB_SLIDING_MS - 1_000);
    expect(await service.resolveCookie(minted.token)).not.toBeNull();

    // Idle past 12 h without activity: gone, though `expires_at` is days away.
    clock.advance(1_001);
    expect(await service.resolveCookie(minted.token)).toBeNull();

    // And activity never pushes the absolute 7 d cap out.
    const start = clock.now();
    while (clock.now() - start < WEB_ABSOLUTE_MS) {
      await service.touch(minted.sessionId);
      clock.advance(6 * 60 * 60 * 1_000);
    }
    await service.touch(minted.sessionId);
    expect(await service.resolveCookie(minted.token)).toBeNull();
  });

  it('lists a user\'s live sessions and marks MFA verified', async () => {
    const clock = testClock();
    const user = await seedUser(t, { mfaRequired: true });
    const service = sessionService({ db: t.db, clock });
    const minted = await service.mintWebSession({
      userId: user.userId,
      deviceId: deviceId('device'),
      deviceLabel: 'Chrome on macOS',
      ip: '203.0.113.9',
      mfaVerified: false,
    });

    const listed = await service.listFor(user.userId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      sessionId: minted.sessionId,
      clientKind: 'web',
      deviceLabel: 'Chrome on macOS',
      ip: '203.0.113.9',
    });

    expect((await service.resolveCookie(minted.token))!.mfaVerified).toBe(false);
    await service.markMfaVerified(minted.sessionId);
    expect((await service.resolveCookie(minted.token))!.mfaVerified).toBe(true);

    await service.revoke(minted.sessionId, 'logout');
    expect(await service.listFor(user.userId)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The guard
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('requireSession', () => {
  it('401s without a session and serves the principal with one', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const service = sessionService({ db: t.db, clock });
    const minted = await service.mintWebSession({
      userId: user.userId,
      deviceId: deviceId('device'),
      mfaVerified: true,
    });
    const app = await guardApp(t.db, clock);
    try {
      const anonymous = await app.inject({ method: 'GET', url: '/me' });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json<{ error: { code: string } }>().error.code).toBe('AUTH_REQUIRED');

      // A cookie that is not signed with the server's secret is not a session.
      const forged = await app.inject({
        method: 'GET',
        url: '/me',
        cookies: { [SESSION_COOKIE]: minted.token },
      });
      expect(forged.statusCode).toBe(401);

      const ok = await app.inject({
        method: 'GET',
        url: '/me',
        cookies: { [SESSION_COOKIE]: signed(minted.token) },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({
        userId: user.userId,
        clientKind: 'web',
        scopes: ['data:read', 'fn:run', 'ws:subscribe'],
      });
    } finally {
      await app.close();
    }
  });

  it('rejects a cookie-authenticated mutation without x-requested-with (CSRF)', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const service = sessionService({ db: t.db, clock });
    const minted = await service.mintWebSession({
      userId: user.userId,
      deviceId: deviceId('device'),
      mfaVerified: true,
    });
    const app = await guardApp(t.db, clock);
    try {
      const bare = await app.inject({
        method: 'POST',
        url: '/me',
        cookies: { [SESSION_COOKIE]: signed(minted.token) },
      });
      expect(bare.statusCode).toBe(403);
      expect(bare.json<{ error: { code: string } }>().error.code).toBe('CSRF_REJECTED');

      const withHeader = await app.inject({
        method: 'POST',
        url: '/me',
        cookies: { [SESSION_COOKIE]: signed(minted.token) },
        headers: { 'x-requested-with': 'terminal' },
      });
      expect(withHeader.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('holds an unverified MFA session to /auth/* until it verifies', async () => {
    const clock = testClock();
    const user = await seedUser(t, { mfaRequired: true });
    const service = sessionService({ db: t.db, clock });
    const minted = await service.mintWebSession({
      userId: user.userId,
      deviceId: deviceId('device'),
      mfaVerified: false,
    });
    const app = await guardApp(t.db, clock);
    const jar = { [SESSION_COOKIE]: signed(minted.token) };
    try {
      const blocked = await app.inject({ method: 'GET', url: '/me', cookies: jar });
      expect(blocked.statusCode).toBe(401);
      expect(blocked.json<{ error: { code: string } }>().error.code).toBe('MFA_REQUIRED');

      const auth = await app.inject({ method: 'GET', url: '/auth/whoami', cookies: jar });
      expect(auth.statusCode).toBe(200);

      await service.markMfaVerified(minted.sessionId);
      const verified = await app.inject({ method: 'GET', url: '/me', cookies: jar });
      expect(verified.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('403s a role the route does not allow and refreshes last_seen_at on success', async () => {
    const clock = testClock();
    const plain = await seedUser(t);
    const admin = await seedUser(t, { role: 'admin' });
    const service = sessionService({ db: t.db, clock });
    const plainSession = await service.mintWebSession({
      userId: plain.userId,
      deviceId: deviceId('device'),
      mfaVerified: true,
    });
    const adminSession = await service.mintWebSession({
      userId: admin.userId,
      deviceId: deviceId('device'),
      mfaVerified: true,
    });
    const app = await guardApp(t.db, clock);
    try {
      const denied = await app.inject({
        method: 'GET',
        url: '/admin',
        cookies: { [SESSION_COOKIE]: signed(plainSession.token) },
      });
      expect(denied.statusCode).toBe(403);
      const body = denied.json<{ error: { code: string; details: { requiredRole: string[] } } }>();
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.details.requiredRole).toEqual(['admin']);

      clock.advance(60_000);
      const allowed = await app.inject({
        method: 'GET',
        url: '/admin',
        cookies: { [SESSION_COOKIE]: signed(adminSession.token) },
      });
      expect(allowed.statusCode).toBe(200);

      const seen = await t.client.query<{ last_seen_at: Date }>(
        `SELECT last_seen_at FROM sessions WHERE session_id = $1`,
        [adminSession.sessionId],
      );
      expect(seen.rows[0]!.last_seen_at.getTime()).toBe(clock.now());
    } finally {
      await app.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The dev-mode credential (API.md §1.1 "Dev-mode login")
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('password credentials', () => {
  it('hashes with bcrypt cost 12 and verifies inside the database', async () => {
    const user = await seedUser(t);
    await setPassword(t.db, user.userId, 'correct horse battery staple');

    const row = await t.client.query<{ secret_hash: string; kind: string; whole: string }>(
      `SELECT c.secret_hash, c.kind, c::text AS whole
         FROM user_credentials c WHERE c.user_id = $1`,
      [user.userId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.kind).toBe('password');
    // `$2a$12$…` — blowfish, cost 12, salted; the password itself appears nowhere.
    expect(row.rows[0]!.secret_hash).toMatch(/^\$2[aby]\$12\$/);
    expect(row.rows[0]!.whole).not.toContain('correct horse battery staple');

    expect(await verifyPassword(t.db, user.userId, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(t.db, user.userId, 'Correct horse battery staple')).toBe(false);
    expect(await verifyPassword(t.db, user.userId, '')).toBe(false);
  });

  it('answers false for a user with no credential, and replaces one in place', async () => {
    const user = await seedUser(t);
    expect(await verifyPassword(t.db, user.userId, 'anything at all')).toBe(false);

    await setPassword(t.db, user.userId, 'first password');
    await setPassword(t.db, user.userId, 'second password');

    const count = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_credentials
        WHERE user_id = $1 AND kind = 'password' AND revoked_at IS NULL`,
      [user.userId],
    );
    expect(count.rows[0]!.n).toBe('1');
    expect(await verifyPassword(t.db, user.userId, 'first password')).toBe(false);
    expect(await verifyPassword(t.db, user.userId, 'second password')).toBe(true);
  });
});
