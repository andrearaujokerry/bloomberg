/**
 * `http/auth/apikeys.ts` — API-01: "bearer key scopes gate `fn:run` and `ws:subscribe`; a revoked
 * key 401s" (WORKPLAN WP-07 acceptance; API.md §1.1 "API keys", §1.3 `/auth/api-keys`).
 *
 * Also the ENTL-03/SEC-03 boundary that is easy to get wrong: an API session is a *second* session
 * for the same natural person, so it must never trip the `sessions_one_active_web` supersede path,
 * and a web login must never take a bearer client's session away.
 *
 * Self-sufficient: firms, users and keys are created in this file's own `withTxDb()` transaction,
 * which is also the guard app's `db`.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import type { AppDeps } from '../../../src/app.js';
import { getConfig } from '../../../src/config.js';
import { mintApiKey, resolveApiKey, revokeApiKey } from '../../../src/http/auth/apikeys.js';
import {
  requireSession,
  sessionService,
  API_SLIDING_MS,
  SESSION_COOKIE,
} from '../../../src/http/auth/session.js';
import { registerErrorHandling } from '../../../src/http/errors.js';
import { registerTrace } from '../../../src/http/trace.js';
import type { Tx } from '../../../src/db/client.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';

const t = withTxDb();

interface SeededUser {
  userId: number;
  firmId: number;
  email: string;
}

async function seedUser(db: TestDb, spec: { role?: string } = {}): Promise<SeededUser> {
  const firm = await db.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Key Test Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const email = `key-${randomUUID()}@demo.invalid`;
  const user = await db.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role) VALUES ($1, $2, $3, $4)
     RETURNING user_id`,
    [firmId, email, 'Key Test User', spec.role ?? 'user'],
  );
  return { userId: Number(user.rows[0]!.user_id), firmId, email };
}

/** Four scoped routes and one mutation — the shapes API-01 actually gates. */
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
  app.get('/data', { preHandler: requireSession({ scopes: ['data:read'] }) }, (request) =>
    Promise.resolve({
      userId: request.principal?.userId,
      clientKind: request.principal?.clientKind,
    }),
  );
  app.get('/fn', { preHandler: requireSession({ scopes: ['fn:run'] }) }, ok);
  app.get('/sub', { preHandler: requireSession({ scopes: ['ws:subscribe'] }) }, ok);
  app.post('/mutate', { preHandler: requireSession() }, ok);

  await app.ready();
  return app;
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Minting and resolution
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('mintApiKey', () => {
  it('returns tk_ + 32 random bytes and stores only the digest', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const minted = await mintApiKey(t.db, clock, {
      userId: user.userId,
      label: 'desktop',
      scopes: [],
    });

    expect(minted.secret).toMatch(/^tk_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(minted.secret.slice(3), 'base64url')).toHaveLength(32);

    const row = await t.client.query<{
      whole: string;
      matches: boolean;
      hex: string;
      scopes: string[];
      created_at: Date;
    }>(
      `SELECT k::text AS whole,
              k.key_hash = digest($2, 'sha256') AS matches,
              encode(k.key_hash, 'hex') AS hex,
              k.scopes, k.created_at
         FROM api_keys k WHERE k.api_key_id = $1`,
      [minted.apiKeyId, minted.secret],
    );
    expect(row.rows[0]!.matches).toBe(true);
    expect(row.rows[0]!.hex).toBe(createHash('sha256').update(minted.secret, 'utf8').digest('hex'));
    expect(row.rows[0]!.whole).not.toContain(minted.secret);
    // `Rest.Auth.ApiKeyCreate` defaults.
    expect(row.rows[0]!.scopes).toEqual(['data:read', 'fn:run', 'ws:subscribe']);
    expect(row.rows[0]!.created_at.getTime()).toBe(clock.now());
  });

  it('creates the api session on first use and reuses it afterwards', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const minted = await mintApiKey(t.db, clock, {
      userId: user.userId,
      label: 'server',
      scopes: ['data:read', 'fn:run', 'ws:subscribe'],
    });

    const first = await resolveApiKey(t.db, clock, minted.secret);
    expect(first).not.toBeNull();
    expect(first).toMatchObject({
      userId: user.userId,
      firmId: user.firmId,
      clientKind: 'api',
      email: user.email,
      role: 'user',
    });
    expect(first!.scopes).toEqual(['data:read', 'fn:run', 'ws:subscribe']);

    const row = await t.client.query<{
      client_kind: string;
      api_key_id: string;
      mfa_verified: boolean;
      expires_at: Date;
      matches: boolean;
    }>(
      `SELECT client_kind, api_key_id, mfa_verified, expires_at,
              token_hash = digest($2, 'sha256') AS matches
         FROM sessions WHERE session_id = $1`,
      [first!.sessionId, minted.secret],
    );
    expect(row.rows[0]!.client_kind).toBe('api');
    expect(Number(row.rows[0]!.api_key_id)).toBe(minted.apiKeyId);
    expect(row.rows[0]!.mfa_verified).toBe(true);
    expect(row.rows[0]!.expires_at.getTime()).toBe(clock.now() + API_SLIDING_MS);
    // The bearer key IS the session token, which is how `ws/auth.ts` resolves `hello.token`.
    expect(row.rows[0]!.matches).toBe(true);

    // Second use: same session, slid 24 h from now, `last_used_at` moved.
    clock.advance(60 * 60 * 1_000);
    const second = await resolveApiKey(t.db, clock, minted.secret);
    expect(second!.sessionId).toBe(first!.sessionId);

    const after = await t.client.query<{ n: string; expires_at: Date; last_used_at: Date }>(
      `SELECT (SELECT count(*)::text FROM sessions WHERE api_key_id = $1) AS n,
              (SELECT expires_at FROM sessions WHERE api_key_id = $1) AS expires_at,
              (SELECT last_used_at FROM api_keys WHERE api_key_id = $1) AS last_used_at`,
      [minted.apiKeyId],
    );
    expect(after.rows[0]!.n).toBe('1');
    expect(after.rows[0]!.expires_at.getTime()).toBe(clock.now() + API_SLIDING_MS);
    expect(after.rows[0]!.last_used_at.getTime()).toBe(clock.now());
  });

  it('refuses anything that is not a live key', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const minted = await mintApiKey(t.db, clock, {
      userId: user.userId,
      label: 'desktop',
      scopes: [],
    });

    expect(await resolveApiKey(t.db, clock, 'tk_not-a-real-key')).toBeNull();
    // A well-formed secret without the prefix is not a key, whatever its bytes.
    expect(await resolveApiKey(t.db, clock, minted.secret.slice(3))).toBeNull();

    await t.client.query(`UPDATE users SET status = 'suspended' WHERE user_id = $1`, [user.userId]);
    expect(await resolveApiKey(t.db, clock, minted.secret)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// API-01 — scopes
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('scopes gate fn:run and ws:subscribe (API-01)', () => {
  it('refuses the uses the key was not minted for', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const readOnly = await mintApiKey(t.db, clock, {
      userId: user.userId,
      label: 'read-only',
      scopes: ['data:read'],
    });
    const full = await mintApiKey(t.db, clock, {
      userId: user.userId,
      label: 'full',
      scopes: ['data:read', 'fn:run', 'ws:subscribe'],
    });
    const app = await guardApp(t.db, clock);
    try {
      const data = await app.inject({ method: 'GET', url: '/data', headers: bearer(readOnly.secret) });
      expect(data.statusCode).toBe(200);
      expect(data.json()).toEqual({ userId: user.userId, clientKind: 'api' });

      const fn = await app.inject({ method: 'GET', url: '/fn', headers: bearer(readOnly.secret) });
      expect(fn.statusCode).toBe(403);
      const body = fn.json<{ error: { code: string; details: { requiredScope: string[] } } }>();
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.details.requiredScope).toEqual(['fn:run']);

      const sub = await app.inject({ method: 'GET', url: '/sub', headers: bearer(readOnly.secret) });
      expect(sub.statusCode).toBe(403);
      expect(
        sub.json<{ error: { details: { requiredScope: string[] } } }>().error.details.requiredScope,
      ).toEqual(['ws:subscribe']);

      for (const url of ['/data', '/fn', '/sub']) {
        const allowed = await app.inject({ method: 'GET', url, headers: bearer(full.secret) });
        expect(allowed.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it('exempts bearer requests from the CSRF header a cookie needs', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const key = await mintApiKey(t.db, clock, {
      userId: user.userId,
      label: 'desktop',
      scopes: [],
    });
    const service = sessionService({ db: t.db, clock });
    const web = await service.mintWebSession({
      userId: user.userId,
      deviceId: `device-${randomUUID().slice(0, 8)}`,
      mfaVerified: true,
    });
    const app = await guardApp(t.db, clock);
    try {
      const withKey = await app.inject({
        method: 'POST',
        url: '/mutate',
        headers: bearer(key.secret),
      });
      expect(withKey.statusCode).toBe(200);

      const withCookie = await app.inject({
        method: 'POST',
        url: '/mutate',
        cookies: { [SESSION_COOKIE]: cookie.sign(web.token, getConfig().SESSION_SECRET) },
      });
      expect(withCookie.statusCode).toBe(403);
      expect(withCookie.json<{ error: { code: string } }>().error.code).toBe('CSRF_REJECTED');
    } finally {
      await app.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Revocation
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('revokeApiKey', () => {
  it('kills the key, its session and every route that used it', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const key = await mintApiKey(t.db, clock, {
      userId: user.userId,
      label: 'desktop',
      scopes: [],
    });
    const principal = await resolveApiKey(t.db, clock, key.secret);
    const app = await guardApp(t.db, clock);
    try {
      expect(
        (await app.inject({ method: 'GET', url: '/data', headers: bearer(key.secret) })).statusCode,
      ).toBe(200);

      clock.advance(1_000);
      await revokeApiKey(t.db, clock, key.apiKeyId, user.userId);

      expect(await resolveApiKey(t.db, clock, key.secret)).toBeNull();
      const refused = await app.inject({
        method: 'GET',
        url: '/data',
        headers: bearer(key.secret),
      });
      expect(refused.statusCode).toBe(401);
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('AUTH_REQUIRED');

      const row = await t.client.query<{
        session_id: string;
        key_revoked: Date | null;
        session_revoked: Date | null;
        revoke_reason: string | null;
      }>(
        `SELECT s.session_id, k.revoked_at AS key_revoked, s.revoked_at AS session_revoked,
                s.revoke_reason
           FROM api_keys k JOIN sessions s ON s.api_key_id = k.api_key_id
          WHERE k.api_key_id = $1`,
        [key.apiKeyId],
      );
      expect(row.rows[0]!.key_revoked?.getTime()).toBe(clock.now());
      expect(row.rows[0]!.session_revoked?.getTime()).toBe(clock.now());
      expect(row.rows[0]!.revoke_reason).toBe('admin');
      // The dead session no longer resolves as a bearer session either.
      expect(await sessionService({ db: t.db, clock }).resolveBearer(key.secret)).toBeNull();
      // It is the very session the first use minted that was taken away.
      expect(row.rows[0]!.session_id).toBe(principal!.sessionId);
    } finally {
      await app.close();
    }
  });

  it('never lets one person revoke another person\'s key', async () => {
    const clock = testClock();
    const owner = await seedUser(t);
    const stranger = await seedUser(t);
    const key = await mintApiKey(t.db, clock, {
      userId: owner.userId,
      label: 'desktop',
      scopes: [],
    });

    await revokeApiKey(t.db, clock, key.apiKeyId, stranger.userId);
    expect(await resolveApiKey(t.db, clock, key.secret)).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SEC-03 — an api session is not a web session
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('an api session never supersedes a web session', () => {
  it('leaves the web session alone, and survives a web login that supersedes another', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const service = sessionService({ db: t.db, clock });

    const web = await service.mintWebSession({
      userId: user.userId,
      deviceId: `device-${randomUUID().slice(0, 8)}`,
      mfaVerified: true,
    });
    const key = await mintApiKey(t.db, clock, {
      userId: user.userId,
      label: 'desktop',
      scopes: [],
    });
    const api = await resolveApiKey(t.db, clock, key.secret);

    // The bearer session did not displace the browser.
    expect(api!.sessionId).not.toBe(web.sessionId);
    expect(await service.resolveCookie(web.token)).not.toBeNull();

    // A second web login supersedes only the web session.
    clock.advance(60_000);
    const web2 = await service.mintWebSession({
      userId: user.userId,
      deviceId: `device-${randomUUID().slice(0, 8)}`,
      mfaVerified: true,
    });
    expect(web2.superseded!.sessionId).toBe(web.sessionId);

    const rows = await t.client.query<{
      session_id: string;
      client_kind: string;
      revoked_at: Date | null;
      revoke_reason: string | null;
    }>(
      `SELECT session_id, client_kind, revoked_at, revoke_reason FROM sessions WHERE user_id = $1`,
      [user.userId],
    );
    const apiRow = rows.rows.find((r) => r.session_id === api!.sessionId);
    expect(apiRow!.client_kind).toBe('api');
    expect(apiRow!.revoked_at).toBeNull();
    expect(await resolveApiKey(t.db, clock, key.secret)).not.toBeNull();

    const displaced = rows.rows.find((r) => r.session_id === web.sessionId);
    expect(displaced!.revoke_reason).toBe('superseded');

    // Exactly one active web session, and the api session beside it.
    const active = await t.client.query<{ client_kind: string; n: string }>(
      `SELECT client_kind, count(*)::text AS n FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL GROUP BY client_kind ORDER BY client_kind`,
      [user.userId],
    );
    expect(active.rows).toEqual([
      { client_kind: 'api', n: '1' },
      { client_kind: 'web', n: '1' },
    ]);
  });
});
