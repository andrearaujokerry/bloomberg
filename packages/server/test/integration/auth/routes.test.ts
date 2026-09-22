/**
 * `http/routes/auth.ts` driven through the real application — API.md §1.3's twelve routes, every
 * documented failure code, and the four properties the route module exists to hold.
 *
 * The app is `buildApp` via `createTestApp`: the production trace hook, the production error
 * handler, the production cookie plugin, the production guard and the generated route barrel. The
 * database handle is this file's own open transaction, so the rows the handlers read are the rows
 * the test wrote and everything rolls back (`fixtures/seed/users.json` does not exist — WP-15 owns
 * the seed). Time is a `VirtualClock`; nothing here waits.
 *
 * The WebAuthn ceremonies are run by a software authenticator in this process (ES256 over
 * `node:crypto`), so registration and assertion go through the shipped verifier rather than a stub.
 */

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';

import cookieLib from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppDeps } from '../../../src/app.js';
import { getConfig, type Config } from '../../../src/config.js';
import type { Tx } from '../../../src/db/client.js';
import { requireSession } from '../../../src/http/auth/session.js';
import { setPassword } from '../../../src/http/auth/password.js';
import { registerErrorHandling } from '../../../src/http/errors.js';
import { registerTrace } from '../../../src/http/trace.js';
import { EMAIL_RATE_FACTOR, LOGIN_RATE_MAX } from '../../../src/http/routes/auth.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';

const t = withTxDb();

const PREFIX = '/api/v1';
const PASSWORD = 'correct horse battery staple';
const RP_ID = 'terminal.test';
const ORIGIN = 'https://terminal.test';
/**
 * The relying party comes from CONFIG, never from the request (SEC-02). These headers are still
 * sent on every WebAuthn call so that the phishing case is exercised rather than assumed: they say
 * the right thing here, and `webauthn phishing` below sends attacker-controlled ones and proves the
 * server ignores both.
 */
const RP_HEADERS = { host: RP_ID, origin: ORIGIN } as const;
/** What a deployment sets. Unset, every WebAuthn route fails closed with a 500. */
const RP_CONFIG = { RP_ID, RP_ORIGIN: ORIGIN } as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures this file owns
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface SeededUser {
  userId: number;
  firmId: number;
  firmName: string;
  email: string;
  displayName: string;
}

async function seedUser(
  db: TestDb,
  spec: { role?: string; status?: string; mfaRequired?: boolean; password?: string | null } = {},
): Promise<SeededUser> {
  const firmName = `Auth Routes Firm ${randomUUID().slice(0, 8)}`;
  const firm = await db.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [firmName],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const email = `routes-${randomUUID()}@demo.invalid`;
  const displayName = 'Routes Test User';
  const user = await db.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, desk, role, status, mfa_required)
     VALUES ($1, $2, $3, 'Rates', $4, $5, $6) RETURNING user_id`,
    [firmId, email, displayName, spec.role ?? 'user', spec.status ?? 'active', spec.mfaRequired ?? false],
  );
  const userId = Number(user.rows[0]!.user_id);
  if (spec.password !== null) await setPassword(db.db, userId, spec.password ?? PASSWORD);
  return { userId, firmId, firmName, email, displayName };
}

/** A `deviceId` long enough for `Rest.Auth.LoginRequest` (8-64 characters). */
function deviceId(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The app under test
// ─────────────────────────────────────────────────────────────────────────────────────────────

let started: TestApp | undefined;
let probe: FastifyInstance | undefined;

afterEach(async () => {
  await started?.close();
  started = undefined;
  await probe?.close();
  probe = undefined;
});

async function app(
  clock: VirtualClock = testClock(),
  config: Partial<Config> = RP_CONFIG,
): Promise<FastifyInstance> {
  started = await createTestApp({ db: t.db, clock, config });
  return started.app;
}

/**
 * A one-route instance whose `/probe` is NOT under `/auth` — the only way to prove "an
 * mfa_required session may reach `/auth/*` and nothing else", since every route this repository
 * serves today is either `/health` (unguarded) or `/auth/*`. It is the production guard, the
 * production error handler and the same database handle and cookie secret as the real app.
 */
async function probeApp(db: Tx, clock: VirtualClock): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  const config = getConfig();
  instance.decorate('deps', { config, clock, db } as unknown as AppDeps);
  registerTrace(instance);
  registerErrorHandling(instance);
  await instance.register(cookieLib, {
    secret: config.SESSION_SECRET,
    parseOptions: { httpOnly: true, sameSite: 'strict', path: '/' },
  });
  instance.get('/probe', { preHandler: requireSession() }, (request) =>
    Promise.resolve({ userId: request.principal?.userId }),
  );
  await instance.ready();
  probe = instance;
  return instance;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Request helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function cookieOf(res: InjectResponse): string {
  const jar = res.cookies as { name: string; value: string }[];
  const tsid = jar.find((c) => c.name === 'tsid');
  expect(tsid, 'the response set a tsid cookie').toBeDefined();
  return `tsid=${encodeURIComponent(tsid!.value)}`;
}

function body<T = Record<string, unknown>>(res: InjectResponse): T {
  return JSON.parse(res.body) as T;
}

interface ErrorBody {
  error: { code: string; message: string; traceId: string; retryable: boolean; details?: unknown };
}

async function login(
  instance: FastifyInstance,
  email: string,
  spec: {
    password?: string;
    deviceId?: string;
    deviceLabel?: string;
    remoteAddress?: string;
    /** `X-Forwarded-For`: what `trustProxy` would make `request.ip` — and what must NOT key the limiter. */
    forwardedFor?: string;
  } = {},
): Promise<InjectResponse> {
  return instance.inject({
    method: 'POST',
    url: `${PREFIX}/auth/login`,
    ...(spec.remoteAddress === undefined ? {} : { remoteAddress: spec.remoteAddress }),
    ...(spec.forwardedFor === undefined ? {} : { headers: { 'x-forwarded-for': spec.forwardedFor } }),
    payload: {
      email,
      password: spec.password ?? PASSWORD,
      deviceId: spec.deviceId ?? deviceId('dev'),
      ...(spec.deviceLabel === undefined ? {} : { deviceLabel: spec.deviceLabel }),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A software authenticator (ES256), so the ceremonies run against the shipped verifier
// ─────────────────────────────────────────────────────────────────────────────────────────────

function cborHead(major: number, argument: number): Buffer {
  if (argument < 24) return Buffer.from([(major << 5) | argument]);
  if (argument < 0x100) return Buffer.from([(major << 5) | 24, argument]);
  if (argument < 0x10000) return Buffer.from([(major << 5) | 25, argument >> 8, argument & 0xff]);
  const head = Buffer.alloc(5);
  head[0] = (major << 5) | 26;
  head.writeUInt32BE(argument, 1);
  return head;
}
const cborInt = (v: number): Buffer => (v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v));
const cborBytes = (v: Uint8Array): Buffer => Buffer.concat([cborHead(2, v.length), Buffer.from(v)]);
const cborText = (v: string): Buffer => {
  const utf8 = Buffer.from(v, 'utf8');
  return Buffer.concat([cborHead(3, utf8.length), utf8]);
};
const cborMap = (entries: readonly (readonly [Buffer, Buffer])[]): Buffer =>
  Buffer.concat([cborHead(5, entries.length), ...entries.map(([k, v]) => Buffer.concat([k, v]))]);

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const COSE_ES256 = -7;

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest();

class SoftwareAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly aaguid = randomBytes(16);
  private readonly pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  private readonly cose: Buffer;

  constructor() {
    const jwk = this.pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.cose = cborMap([
      [cborInt(1), cborInt(2)],
      [cborInt(3), cborInt(COSE_ES256)],
      [cborInt(-1), cborInt(1)],
      [cborInt(-2), cborBytes(Buffer.from(jwk.x, 'base64url'))],
      [cborInt(-3), cborBytes(Buffer.from(jwk.y, 'base64url'))],
    ]);
  }

  private authData(flags: number, signCount: number, attested: boolean): Buffer {
    const head = Buffer.alloc(37);
    sha256(Buffer.from(RP_ID, 'utf8')).copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(signCount, 33);
    if (!attested) return head;
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credentialId.length, 0);
    return Buffer.concat([head, this.aaguid, len, this.credentialId, this.cose]);
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }),
      'utf8',
    );
  }

  register(challengeB64u: string): Record<string, unknown> {
    const authData = this.authData(FLAG_UP | FLAG_UV | FLAG_AT, 0, true);
    const clientDataJSON = this.clientData('webauthn.create', challengeB64u);
    const attestationObject = cborMap([
      [cborText('fmt'), cborText('none')],
      [cborText('attStmt'), cborMap([])],
      [cborText('authData'), cborBytes(authData)],
    ]);
    const rawId = b64u(this.credentialId);
    return {
      id: rawId,
      rawId,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  assert(challengeB64u: string, signCount = 1): Record<string, unknown> {
    const authData = this.authData(FLAG_UP | FLAG_UV, signCount, false);
    const clientDataJSON = this.clientData('webauthn.get', challengeB64u);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), {
      key: this.pair.privateKey,
      dsaEncoding: 'der',
    });
    const rawId = b64u(this.credentialId);
    return {
      id: rawId,
      rawId,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: null,
      },
      clientExtensionResults: {},
    };
  }
}

/** Register a credential for the session behind `cookie`, through the real routes. */
async function enrol(
  instance: FastifyInstance,
  cookie: string,
): Promise<SoftwareAuthenticator> {
  const authenticator = new SoftwareAuthenticator();
  const options = await instance.inject({
    method: 'POST',
    url: `${PREFIX}/auth/webauthn/register/options`,
    headers: { ...RP_HEADERS, cookie, 'x-requested-with': 'terminal' },
    payload: {},
  });
  expect(options.statusCode).toBe(200);
  const challenge = body<{ challenge: string; rp: { id: string } }>(options);
  expect(challenge.rp.id).toBe(RP_ID);

  const verified = await instance.inject({
    method: 'POST',
    url: `${PREFIX}/auth/webauthn/register/verify`,
    headers: { ...RP_HEADERS, cookie, 'x-requested-with': 'terminal' },
    payload: { credential: authenticator.register(challenge.challenge), label: 'YubiKey' },
  });
  expect(verified.statusCode, verified.body).toBe(200);
  expect(body<{ credentialId: string }>(verified).credentialId).toBe(
    b64u(authenticator.credentialId),
  );
  return authenticator;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The happy path
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST /auth/login → GET /auth/session → POST /auth/logout', () => {
  it('logs in, serves SessionInfo from the cookie and revokes on logout', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const instance = await app(clock);

    const res = await login(instance, user.email, { deviceLabel: 'Chrome on macOS' });
    expect(res.statusCode, res.body).toBe(200);

    const payload = body<{
      session: Record<string, unknown> & { quotas: Record<string, { limit: number }> };
      mfaRequired: boolean;
      superseded: unknown;
    }>(res);
    expect(payload.mfaRequired).toBe(false);
    expect(payload.superseded).toBeNull();
    expect(payload.session).toMatchObject({
      userId: user.userId,
      firmId: user.firmId,
      firmName: user.firmName,
      email: user.email,
      displayName: user.displayName,
      desk: 'Rates',
      role: 'user',
      clientKind: 'web',
      mfaRequired: false,
      mfaVerified: true,
      webauthnEnrolled: false,
      protocol: 1,
    });
    // No grants exist for this brand-new firm, so the summary is the most restrictive one there is.
    expect(payload.session.entitlementSummary).toEqual({
      defaultTier: 'eod',
      exportAllowed: false,
      apiAllowed: false,
    });
    // Live counters, read from `quotas.ts` — not invented here.
    expect(payload.session.quotas.dailyUniqueInstruments).toMatchObject({ used: 0, limit: 500 });
    expect(payload.session.quotas.monthlyDataPoints).toMatchObject({ used: 0, limit: 2_000_000 });
    expect(payload.session.quotas.concurrentSubscriptions.limit).toBeGreaterThan(0);

    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Strict');
    expect(raw).toContain('Path=/');

    const cookie = cookieOf(res);
    // The cookie value is not the token: `sessions.token_hash` is a digest and nothing else.
    const stored = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sessions WHERE token_hash = $1::bytea`,
      [Buffer.from(decodeURIComponent(cookie.slice('tsid='.length)), 'utf8')],
    );
    expect(stored.rows[0]!.n).toBe('0');

    clock.advance(60_000);
    const session = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/auth/session`,
      headers: { cookie },
    });
    expect(session.statusCode, session.body).toBe(200);
    expect(body<{ sessionId: string }>(session).sessionId).toBe(payload.session.sessionId);

    // The guard refreshed `last_seen_at` (API.md §1.3 "refreshes last_seen_at").
    const seen = await t.client.query<{ last_seen_at: Date }>(
      `SELECT last_seen_at FROM sessions WHERE session_id = $1`,
      [payload.session.sessionId],
    );
    expect(seen.rows[0]!.last_seen_at.getTime()).toBe(clock.now());

    const out = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/logout`,
      headers: { cookie, 'x-requested-with': 'terminal' },
    });
    expect(out.statusCode, out.body).toBe(204);

    const revoked = await t.client.query<{ reason: string }>(
      `SELECT revoke_reason AS reason FROM sessions WHERE session_id = $1`,
      [payload.session.sessionId],
    );
    expect(revoked.rows[0]!.reason).toBe('logout');

    const after = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/auth/session`,
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
    expect(body<ErrorBody>(after).error.code).toBe('AUTH_REQUIRED');
  });

  it('reports the entitlement summary the evaluator would compute from the grants', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    for (const [kind, id] of [
      ['firm', user.firmId],
      ['user', user.userId],
    ] as const) {
      await t.client.query(
        // `valid_from` is explicit: the grant must already be live at the VirtualClock's instant,
        // and `DEFAULT now()` is real wall-clock time, which is later than `TEST_NOW`.
        `INSERT INTO entitlement_grants (subject_kind, subject_id, max_tier, usage_display,
                                         usage_export, usage_api, valid_from)
         VALUES ($1, $2, 'delayed', true, true, false, '-infinity')`,
        [kind, id],
      );
    }
    const instance = await app(clock);

    const res = await login(instance, user.email);
    expect(res.statusCode, res.body).toBe(200);
    expect(body<{ session: { entitlementSummary: unknown } }>(res).session.entitlementSummary).toEqual(
      { defaultTier: 'delayed', exportAllowed: true, apiAllowed: false },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The documented failures
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST /auth/login failures', () => {
  it('answers an unknown email and a wrong password identically, in body and in timing', async () => {
    const user = await seedUser(t);
    const instance = await app();

    const startUnknown = Date.now();
    const unknown = await login(instance, `nobody-${randomUUID()}@demo.invalid`);
    const unknownMs = Date.now() - startUnknown;

    const startWrong = Date.now();
    const wrong = await login(instance, user.email, { password: 'not the password' });
    const wrongMs = Date.now() - startWrong;

    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    const a = body<ErrorBody>(unknown).error;
    const b = body<ErrorBody>(wrong).error;
    expect(a.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(b.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(a.message).toBe(b.message);
    expect(a.details).toBeUndefined();
    expect(b.details).toBeUndefined();
    // Neither answer names the email, and neither says which half was wrong.
    expect(a.message).not.toContain(user.email);

    // Both paths pay one bcrypt at cost 12, so neither is a stopwatch oracle. The bound is
    // generous (the assertion is "same order of magnitude", not "same millisecond").
    expect(unknownMs).toBeGreaterThan(5);
    expect(wrongMs).toBeGreaterThan(5);
    const ratio = Math.max(unknownMs, wrongMs) / Math.max(1, Math.min(unknownMs, wrongMs));
    expect(ratio).toBeLessThan(5);
  });

  it('answers 403 USER_SUSPENDED only once the password is proved', async () => {
    const user = await seedUser(t, { status: 'suspended' });
    const instance = await app();

    const wrong = await login(instance, user.email, { password: 'not the password' });
    // A suspended account is not an enumeration oracle: the wrong password still looks like every
    // other wrong password.
    expect(wrong.statusCode).toBe(401);
    expect(body<ErrorBody>(wrong).error.code).toBe('AUTH_INVALID_CREDENTIALS');

    const res = await login(instance, user.email);
    expect(res.statusCode).toBe(403);
    expect(body<ErrorBody>(res).error.code).toBe('USER_SUSPENDED');
  });

  it('rate limits to 5 attempts per minute per IP, then answers 429 RATE_LIMITED', async () => {
    const clock = testClock();
    const instance = await app(clock);
    const email = `nobody-${randomUUID()}@demo.invalid`;

    for (let i = 0; i < LOGIN_RATE_MAX; i += 1) {
      const res = await login(instance, email, { remoteAddress: '203.0.113.9' });
      expect(res.statusCode, `attempt ${String(i + 1)}`).toBe(401);
    }

    const limited = await login(instance, email, { remoteAddress: '203.0.113.9' });
    expect(limited.statusCode).toBe(429);
    const envelope = body<ErrorBody & { error: { retryAfterMs?: number } }>(limited).error;
    expect(envelope.code).toBe('RATE_LIMITED');
    expect(envelope.retryable).toBe(true);
    expect(envelope.retryAfterMs).toBeGreaterThan(0);

    // Another address is unaffected — the window is per IP.
    const other = await login(instance, email, { remoteAddress: '198.51.100.4' });
    expect(other.statusCode).toBe(401);

    // And the window slides: a minute later the first address is allowed again.
    clock.advance(61_000);
    const later = await login(instance, email, { remoteAddress: '203.0.113.9' });
    expect(later.statusCode).toBe(401);
  });

  it('rejects a malformed body with 400 VALIDATION_FAILED', async () => {
    const instance = await app();
    const res = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/login`,
      payload: { email: 'not-an-email', password: 'short', deviceId: 'x' },
    });
    expect(res.statusCode).toBe(400);
    const error = body<ErrorBody & { error: { details: { location: string } } }>(res).error;
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details.location).toBe('body');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSRF
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('CSRF', () => {
  it('rejects a cookie-authenticated mutation without x-requested-with', async () => {
    const user = await seedUser(t);
    const instance = await app();
    const cookie = cookieOf(await login(instance, user.email));

    const bare = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/logout`,
      headers: { cookie },
    });
    expect(bare.statusCode).toBe(403);
    expect(body<ErrorBody>(bare).error.code).toBe('CSRF_REJECTED');

    // The session survived the rejected request.
    const still = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/auth/session`,
      headers: { cookie },
    });
    expect(still.statusCode).toBe(200);

    const withHeader = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/logout`,
      headers: { cookie, 'x-requested-with': 'terminal' },
    });
    expect(withHeader.statusCode).toBe(204);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SEC-03 — the supersede report
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('concurrent sessions', () => {
  it('reports the displaced web session, revokes it and writes the CONCURRENT_SESSION row', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const instance = await app(clock);

    const firstDevice = deviceId('laptop');
    const first = await login(instance, user.email, {
      deviceId: firstDevice,
      deviceLabel: 'Chrome on macOS',
    });
    expect(first.statusCode, first.body).toBe(200);
    const firstCookie = cookieOf(first);
    const firstId = body<{ session: { sessionId: string } }>(first).session.sessionId;

    clock.advance(5_000);
    const second = await login(instance, user.email, {
      deviceId: deviceId('desk'),
      deviceLabel: 'Firefox on Linux',
    });
    expect(second.statusCode, second.body).toBe(200);
    const payload = body<{
      session: { sessionId: string };
      superseded: { sessionId: string; deviceId: string; deviceLabel: string; lastSeenAt: string };
    }>(second);

    expect(payload.superseded).not.toBeNull();
    expect(payload.superseded.sessionId).toBe(firstId);
    expect(payload.superseded.deviceId).toBe(firstDevice);
    expect(payload.superseded.deviceLabel).toBe('Chrome on macOS');
    expect(Date.parse(payload.superseded.lastSeenAt)).toBeGreaterThan(0);
    expect(payload.session.sessionId).not.toBe(firstId);

    const revoked = await t.client.query<{ reason: string; count: number }>(
      `SELECT revoke_reason AS reason, superseded_count AS count
         FROM sessions WHERE session_id = $1`,
      [firstId],
    );
    expect(revoked.rows[0]!.reason).toBe('superseded');
    expect(Number(revoked.rows[0]!.count)).toBe(1);

    const logged = await t.client.query<{ decision: string; purpose: string }>(
      `SELECT decision, purpose FROM access_log
        WHERE user_id = $1 AND reason = 'CONCURRENT_SESSION'`,
      [user.userId],
    );
    expect(logged.rowCount).toBe(1);
    expect(logged.rows[0]!.decision).toBe('deny');
    expect(logged.rows[0]!.purpose).toBe('auth.login');

    // The displaced cookie is dead on arrival.
    const stale = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/auth/session`,
      headers: { cookie: firstCookie },
    });
    expect(stale.statusCode).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GET /auth/sessions and DELETE /auth/sessions/:sessionId
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the session list', () => {
  it('lists the caller\'s own sessions, flags the current one and revokes by id', async () => {
    const user = await seedUser(t);
    const instance = await app();
    const cookie = cookieOf(await login(instance, user.email, { deviceLabel: 'Chrome' }));

    // A second, unrelated person's session must never appear in this list.
    const other = await seedUser(t);
    await login(instance, other.email);

    const created = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/api-keys`,
      headers: { cookie, 'x-requested-with': 'terminal' },
      payload: { label: 'desktop' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const secret = body<{ secret: string }>(created).secret;

    // First use of the key mints its `client_kind='api'` session.
    const viaKey = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/auth/session`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(viaKey.statusCode, viaKey.body).toBe(200);
    expect(body<{ clientKind: string }>(viaKey).clientKind).toBe('api');

    const list = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/auth/sessions`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const items = body<{
      items: { sessionId: string; clientKind: string; current: boolean; deviceLabel: string | null }[]
    }>(list).items;
    expect(items).toHaveLength(2);
    expect(items.filter((i) => i.current)).toHaveLength(1);
    expect(items.map((i) => i.clientKind).sort()).toEqual(['api', 'web']);

    const apiSession = items.find((i) => i.clientKind === 'api')!;
    const gone = await instance.inject({
      method: 'DELETE',
      url: `${PREFIX}/auth/sessions/${apiSession.sessionId}`,
      headers: { cookie, 'x-requested-with': 'terminal' },
    });
    expect(gone.statusCode, gone.body).toBe(204);

    const after = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/auth/sessions`,
      headers: { cookie },
    });
    expect(body<{ items: unknown[] }>(after).items).toHaveLength(1);

    // Someone else's session id is a 404 — never a 403, which would confirm it exists.
    const foreign = await instance.inject({
      method: 'DELETE',
      url: `${PREFIX}/auth/sessions/${randomUUID()}`,
      headers: { cookie, 'x-requested-with': 'terminal' },
    });
    expect(foreign.statusCode).toBe(404);
    expect(body<ErrorBody>(foreign).error.code).toBe('NOT_FOUND');

    const malformed = await instance.inject({
      method: 'DELETE',
      url: `${PREFIX}/auth/sessions/not-a-uuid`,
      headers: { cookie, 'x-requested-with': 'terminal' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(body<ErrorBody>(malformed).error.code).toBe('VALIDATION_FAILED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// API keys
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('/auth/api-keys', () => {
  it('mints a key once, lists it without the secret, and revokes it with its session', async () => {
    const user = await seedUser(t);
    const instance = await app();
    const cookie = cookieOf(await login(instance, user.email));

    const created = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/api-keys`,
      headers: { cookie, 'x-requested-with': 'terminal' },
      payload: { label: 'desktop', scopes: ['data:read', 'fn:run', 'ws:subscribe'] },
    });
    expect(created.statusCode, created.body).toBe(201);
    const key = body<{ apiKeyId: number; secret: string; scopes: string[]; revokedAt: null }>(created);
    expect(key.secret).toMatch(/^tk_[A-Za-z0-9_-]{43}$/);
    expect(key.scopes).toEqual(['data:read', 'fn:run', 'ws:subscribe']);
    expect(key.revokedAt).toBeNull();

    const list = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/auth/api-keys`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const items = body<{ items: Record<string, unknown>[] }>(list).items;
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('secret');
    expect(items[0]).toMatchObject({ apiKeyId: key.apiKeyId, label: 'desktop' });

    const used = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/auth/session`,
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(used.statusCode).toBe(200);

    const revoked = await instance.inject({
      method: 'DELETE',
      url: `${PREFIX}/auth/api-keys/${String(key.apiKeyId)}`,
      headers: { cookie, 'x-requested-with': 'terminal' },
    });
    expect(revoked.statusCode, revoked.body).toBe(204);

    const dead = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/auth/session`,
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(dead.statusCode).toBe(401);

    const session = await t.client.query<{ reason: string }>(
      `SELECT revoke_reason AS reason FROM sessions WHERE api_key_id = $1`,
      [key.apiKeyId],
    );
    expect(session.rows[0]!.reason).toBe('admin');

    // A second revoke of a key that is already gone is a 404, not a silent 204.
    const again = await instance.inject({
      method: 'DELETE',
      url: `${PREFIX}/auth/api-keys/${String(key.apiKeyId)}`,
      headers: { cookie, 'x-requested-with': 'terminal' },
    });
    expect(again.statusCode).toBe(404);
  });

  it('gates the `server` scope on role=admin', async () => {
    const plain = await seedUser(t);
    const admin = await seedUser(t, { role: 'admin' });
    const instance = await app();

    const asUser = cookieOf(await login(instance, plain.email));
    const refused = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/api-keys`,
      headers: { cookie: asUser, 'x-requested-with': 'terminal' },
      payload: { label: 'unattended', scopes: ['data:read', 'server'] },
    });
    expect(refused.statusCode).toBe(403);
    const error = body<ErrorBody & { error: { details: { requiredRole: string[] } } }>(refused).error;
    expect(error.code).toBe('FORBIDDEN');
    expect(error.details.requiredRole).toEqual(['admin']);

    const asAdmin = cookieOf(await login(instance, admin.email));
    const minted = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/api-keys`,
      headers: { cookie: asAdmin, 'x-requested-with': 'terminal' },
      payload: { label: 'unattended', scopes: ['data:read', 'server'] },
    });
    expect(minted.statusCode, minted.body).toBe(201);
    expect(body<{ scopes: string[] }>(minted).scopes).toContain('server');
  });

  it('refuses another person\'s key id with 404', async () => {
    const mine = await seedUser(t);
    const yours = await seedUser(t);
    const instance = await app();

    const yourCookie = cookieOf(await login(instance, yours.email));
    const yourKey = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/api-keys`,
      headers: { cookie: yourCookie, 'x-requested-with': 'terminal' },
      payload: { label: 'yours' },
    });
    expect(yourKey.statusCode).toBe(201);
    const yourKeyId = body<{ apiKeyId: number }>(yourKey).apiKeyId;

    const myCookie = cookieOf(await login(instance, mine.email));
    const attempt = await instance.inject({
      method: 'DELETE',
      url: `${PREFIX}/auth/api-keys/${String(yourKeyId)}`,
      headers: { cookie: myCookie, 'x-requested-with': 'terminal' },
    });
    expect(attempt.statusCode).toBe(404);

    const alive = await t.client.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM api_keys WHERE api_key_id = $1`,
      [yourKeyId],
    );
    expect(alive.rows[0]!.revoked_at).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WebAuthn and the MFA gate
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('WebAuthn', () => {
  it('holds an mfa_required session to /auth/* until the assertion verifies', async () => {
    const clock = testClock();
    const user = await seedUser(t, { mfaRequired: true });
    const instance = await app(clock);
    const guard = await probeApp(t.db, clock);

    const res = await login(instance, user.email);
    expect(res.statusCode, res.body).toBe(200);
    const payload = body<{ session: { mfaVerified: boolean }; mfaRequired: boolean }>(res);
    expect(payload.mfaRequired).toBe(true);
    expect(payload.session.mfaVerified).toBe(false);
    const cookie = cookieOf(res);

    // `/auth/*` is reachable — it is where the second factor is completed.
    const info = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/auth/session`,
      headers: { cookie },
    });
    expect(info.statusCode).toBe(200);

    // Nothing else is.
    const blocked = await guard.inject({ method: 'GET', url: '/probe', headers: { cookie } });
    expect(blocked.statusCode).toBe(401);
    expect(body<ErrorBody>(blocked).error.code).toBe('MFA_REQUIRED');

    // Nor is the one `/auth` route that would hand out a credential which bypasses MFA.
    const key = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/api-keys`,
      headers: { cookie, 'x-requested-with': 'terminal' },
      payload: { label: 'sneaky' },
    });
    expect(key.statusCode).toBe(401);
    expect(body<ErrorBody>(key).error.code).toBe('MFA_REQUIRED');

    const authenticator = await enrol(instance, cookie);

    const options = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/webauthn/login/options`,
      headers: RP_HEADERS,
      payload: { email: user.email },
    });
    expect(options.statusCode, options.body).toBe(200);
    const offered = body<{
      challengeId: string;
      options: { challenge: string; rpId: string; allowCredentials: { id: string }[] };
    }>(options);
    expect(offered.options.rpId).toBe(RP_ID);
    expect(offered.options.allowCredentials.map((c) => c.id)).toEqual([
      b64u(authenticator.credentialId),
    ]);

    const assertion = {
      challengeId: offered.challengeId,
      credential: authenticator.assert(offered.options.challenge),
      deviceId: deviceId('laptop'),
    };
    const verified = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/webauthn/login/verify`,
      headers: { ...RP_HEADERS, cookie, 'x-requested-with': 'terminal' },
      payload: assertion,
    });
    expect(verified.statusCode, verified.body).toBe(200);
    const upgraded = body<{
      session: { sessionId: string; mfaVerified: boolean; webauthnEnrolled: boolean };
      superseded: unknown;
    }>(verified);
    expect(upgraded.session.mfaVerified).toBe(true);
    expect(upgraded.session.webauthnEnrolled).toBe(true);
    // The password session was upgraded, not replaced.
    expect(upgraded.superseded).toBeNull();

    // The whole surface is open now.
    const allowed = await guard.inject({ method: 'GET', url: '/probe', headers: { cookie } });
    expect(allowed.statusCode, allowed.body).toBe(200);
    const nowMinted = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/api-keys`,
      headers: { cookie, 'x-requested-with': 'terminal' },
      payload: { label: 'after mfa' },
    });
    expect(nowMinted.statusCode, nowMinted.body).toBe(201);

    // `sign_count` moved and the challenge is spent: the identical assertion never works twice.
    const counted = await t.client.query<{ sign_count: string; last_used_at: Date | null }>(
      `SELECT sign_count, last_used_at FROM user_credentials WHERE credential_id = $1::bytea`,
      [authenticator.credentialId],
    );
    expect(Number(counted.rows[0]!.sign_count)).toBe(1);
    expect(counted.rows[0]!.last_used_at).not.toBeNull();

    const replay = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/webauthn/login/verify`,
      headers: { ...RP_HEADERS, cookie, 'x-requested-with': 'terminal' },
      payload: assertion,
    });
    expect(replay.statusCode).toBe(401);
    expect(body<ErrorBody>(replay).error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('mints a passwordless session from an assertion alone', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const instance = await app(clock);

    const cookie = cookieOf(await login(instance, user.email));
    const authenticator = await enrol(instance, cookie);

    // Log the password session out: what follows uses nothing but the authenticator.
    const out = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/logout`,
      headers: { cookie, 'x-requested-with': 'terminal' },
    });
    expect(out.statusCode).toBe(204);

    const options = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/webauthn/login/options`,
      headers: RP_HEADERS,
      payload: { email: user.email },
    });
    const offered = body<{ challengeId: string; options: { challenge: string } }>(options);

    const verified = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/webauthn/login/verify`,
      headers: RP_HEADERS,
      payload: {
        challengeId: offered.challengeId,
        credential: authenticator.assert(offered.options.challenge),
        deviceId: deviceId('phone'),
        deviceLabel: 'Safari on iOS',
      },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    const fresh = body<{ session: { sessionId: string; mfaVerified: boolean } }>(verified);
    expect(fresh.session.mfaVerified).toBe(true);

    // A real cookie came back with it, and it works.
    const freshCookie = cookieOf(verified);
    const info = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/auth/session`,
      headers: { cookie: freshCookie },
    });
    expect(info.statusCode).toBe(200);
    expect(body<{ sessionId: string }>(info).sessionId).toBe(fresh.session.sessionId);
  });

  it('answers an unknown email with the same shape as a known one', async () => {
    const user = await seedUser(t);
    const instance = await app();

    const known = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/webauthn/login/options`,
      headers: RP_HEADERS,
      payload: { email: user.email },
    });
    const unknown = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/webauthn/login/options`,
      headers: RP_HEADERS,
      payload: { email: `nobody-${randomUUID()}@demo.invalid` },
    });

    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    const a = body<{ challengeId: string; options: Record<string, unknown> }>(known);
    const b = body<{ challengeId: string; options: Record<string, unknown> }>(unknown);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(Object.keys(a.options).sort()).toEqual(Object.keys(b.options).sort());
    expect(a.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    // Neither carries a credential for a user who has enrolled none.
    expect(a.options.allowCredentials).toEqual([]);
    expect(b.options.allowCredentials).toEqual([]);

    // And an assertion against the challenge minted for an unknown email cannot resolve.
    const forged = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/webauthn/login/verify`,
      headers: RP_HEADERS,
      payload: {
        challengeId: b.challengeId,
        credential: new SoftwareAuthenticator().assert('AAAA'),
        deviceId: deviceId('attacker'),
      },
    });
    expect(forged.statusCode).toBe(401);
    expect(body<ErrorBody>(forged).error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('expires a registration challenge after five minutes', async () => {
    const clock = testClock();
    const user = await seedUser(t);
    const instance = await app(clock);
    const cookie = cookieOf(await login(instance, user.email));

    const options = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/webauthn/register/options`,
      headers: { ...RP_HEADERS, cookie, 'x-requested-with': 'terminal' },
      payload: {},
    });
    expect(options.statusCode).toBe(200);
    const challenge = body<{ challenge: string }>(options).challenge;

    clock.advance(5 * 60_000 + 1);
    const late = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/webauthn/register/verify`,
      headers: { ...RP_HEADERS, cookie, 'x-requested-with': 'terminal' },
      payload: { credential: new SoftwareAuthenticator().register(challenge) },
    });
    expect(late.statusCode).toBe(400);
    expect(body<ErrorBody>(late).error.code).toBe('BAD_REQUEST');

    const none = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_credentials WHERE user_id = $1 AND kind = 'webauthn'`,
      [user.userId],
    );
    expect(none.rows[0]!.n).toBe('0');
  });

  it('requires a session to ask for registration options', async () => {
    const instance = await app();
    const res = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/webauthn/register/options`,
      headers: RP_HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(body<ErrorBody>(res).error.code).toBe('AUTH_REQUIRED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Audit regressions — each of these is a hole an auditor opened before it was closed
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the relying party comes from configuration, never from the request', () => {
  it('ignores an attacker-chosen Host and Origin when issuing login options', async () => {
    const user = await seedUser(t);
    const instance = await app();

    const offered = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/webauthn/login/options`,
      headers: { host: 'evil.test', origin: 'https://evil.test' },
      payload: { email: user.email },
    });
    expect(offered.statusCode, offered.body).toBe(200);
    // Before the fix this answered `rpId: 'evil.test'`, and the verify step then compared the
    // attacker's `rpIdHash` and `origin` against the attacker's own values — both checks passed
    // and a session cookie was minted for a page served from evil.test.
    expect(body<{ options: { rpId: string } }>(offered).options.rpId).toBe(RP_ID);
  });

  it('refuses the ceremony outright when RP_ID and RP_ORIGIN are unset', async () => {
    const user = await seedUser(t);
    // A deployment that never configured a relying party must not guess one from the wire.
    // Explicit `undefined`, not `{}`: `.env` sets RP_ID/RP_ORIGIN for the dev server, and
    // `createTestApp` merges its overrides OVER the parsed environment.
    const instance = await app(testClock(), { RP_ID: undefined, RP_ORIGIN: undefined });

    const res = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/webauthn/login/options`,
      headers: { host: 'evil.test', origin: 'https://evil.test' },
      payload: { email: user.email },
    });
    expect(res.statusCode).toBe(500);
    expect(body<ErrorBody>(res).error.code).toBe('INTERNAL');
  });

  it('offers userVerification: required, the ceremony the server will actually accept', async () => {
    const user = await seedUser(t);
    const instance = await app();
    const cookie = cookieOf(await login(instance, user.email));

    const reg = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/webauthn/register/options`,
      headers: { ...RP_HEADERS, cookie, 'x-requested-with': 'terminal' },
      payload: {},
    });
    expect(
      body<{ authenticatorSelection: { userVerification: string } }>(reg).authenticatorSelection
        .userVerification,
    ).toBe('required');

    const assertOpts = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/webauthn/login/options`,
      headers: RP_HEADERS,
      payload: { email: user.email },
    });
    expect(
      body<{ options: { userVerification: string } }>(assertOpts).options.userVerification,
    ).toBe('required');
  });
});

describe('the login rate limit counts the real peer', () => {
  it('cannot be reset by a fresh X-Forwarded-For on every attempt', async () => {
    const instance = await app();
    const email = `nobody-${randomUUID()}@demo.invalid`;

    // One socket, a different forwarded address each time. `buildApp` sets `trustProxy: true`, so
    // keying on `request.ip` made every attempt look like a new client and the limit blocked none.
    const codes: number[] = [];
    for (let i = 0; i < LOGIN_RATE_MAX + 1; i += 1) {
      const res = await login(instance, email, {
        remoteAddress: '203.0.113.20',
        forwardedFor: `198.51.100.${String(i + 1)}`,
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, LOGIN_RATE_MAX)).toEqual(Array<number>(LOGIN_RATE_MAX).fill(401));
    expect(codes[LOGIN_RATE_MAX]).toBe(429);
  });

  it('bounds attempts against one address however many peers they come from', async () => {
    const instance = await app();
    // The per-IP counter cannot see a distributed attempt at all; the per-email counter can.
    // Tightened here so the case costs a handful of bcrypts rather than twenty.
    started!.deps.auth = { loginRateLimit: { max: 2, windowMs: 60_000 } };
    const email = `nobody-${randomUUID()}@demo.invalid`;

    const codes: number[] = [];
    for (let i = 0; i < 2 * EMAIL_RATE_FACTOR + 1; i += 1) {
      // A new peer every time, so the per-IP counter never fires.
      const res = await login(instance, email, { remoteAddress: `198.51.100.${String(i + 1)}` });
      codes.push(res.statusCode);
    }
    expect(codes.filter((c) => c === 401)).toHaveLength(2 * EMAIL_RATE_FACTOR);
    expect(codes[codes.length - 1]).toBe(429);
  });

  it('applies the same limiter to the anonymous WebAuthn options route', async () => {
    const instance = await app();
    const email = `nobody-${randomUUID()}@demo.invalid`;

    const ask = (): Promise<InjectResponse> =>
      instance.inject({
        method: 'POST',
        url: `${PREFIX}/auth/webauthn/login/options`,
        headers: RP_HEADERS,
        remoteAddress: '203.0.113.31',
        payload: { email },
      });

    for (let i = 0; i < LOGIN_RATE_MAX; i += 1) expect((await ask()).statusCode).toBe(200);
    // Unauthenticated, unlimited and it minted a 32-byte challenge into a map nothing pruned.
    expect((await ask()).statusCode).toBe(429);
  });
});

describe('an account with no password credential is not a timing oracle', () => {
  it('costs the same as a wrong password', async () => {
    const webauthnOnly = await seedUser(t, { password: null });
    const withPassword = await seedUser(t);
    const instance = await app();

    // Warm the connection and pgcrypto.
    await login(instance, withPassword.email, { password: 'warm up the pool' });

    const startNoCredential = Date.now();
    const noCredential = await login(instance, webauthnOnly.email, { password: 'anything at all' });
    const noCredentialMs = Date.now() - startNoCredential;

    const startWrong = Date.now();
    const wrong = await login(instance, withPassword.email, { password: 'not the password' });
    const wrongMs = Date.now() - startWrong;

    expect(noCredential.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(body<ErrorBody>(noCredential).error.code).toBe('AUTH_INVALID_CREDENTIALS');
    // It used to answer in half a millisecond against ~240 ms, a 500x oracle that named exactly
    // the WebAuthn-only and password-revoked accounts.
    expect(noCredentialMs).toBeGreaterThan(5);
    const ratio = Math.max(noCredentialMs, wrongMs) / Math.max(1, Math.min(noCredentialMs, wrongMs));
    expect(ratio).toBeLessThan(5);
  });
});

describe('an API key is not a way around the second factor', () => {
  it('cannot mint, list or revoke API keys', async () => {
    const admin = await seedUser(t, { role: 'admin' });
    const instance = await app();
    const cookie = cookieOf(await login(instance, admin.email));

    const narrow = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/api-keys`,
      headers: { cookie, 'x-requested-with': 'terminal' },
      payload: { label: 'read only', scopes: ['data:read'] },
    });
    expect(narrow.statusCode, narrow.body).toBe(201);
    const secret = body<{ secret: string; apiKeyId: number }>(narrow).secret;

    // The whole point: one leaked read-only key must not be able to mint a `server` key and
    // become a self-renewing, full-privilege credential.
    const escalate = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/api-keys`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { label: 'escalated', scopes: ['server'] },
    });
    expect(escalate.statusCode, escalate.body).toBe(403);

    // Listing is allowed for a bearer — reading your own key labels escalates nothing — but
    // revoking is not: a stolen key must not be able to disable the others.
    const listed = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/auth/api-keys`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(listed.statusCode).toBe(200);

    const revoke = await instance.inject({
      method: 'DELETE',
      url: `${PREFIX}/auth/api-keys/${String(body<{ apiKeyId: number }>(narrow).apiKeyId)}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(revoke.statusCode).toBe(403);
  });

  it('will not list keys before MFA is verified', async () => {
    const user = await seedUser(t, { mfaRequired: true });
    const instance = await app();
    const cookie = cookieOf(await login(instance, user.email));

    // `requireSession` exempts every `/auth/*` path from the MFA gate — that is where MFA is
    // completed — so these three routes have to re-apply it themselves.
    for (const [method, url] of [
      ['GET', `${PREFIX}/auth/api-keys`],
      ['DELETE', `${PREFIX}/auth/api-keys/1`],
    ] as const) {
      const res = await instance.inject({
        method,
        url,
        headers: { cookie, 'x-requested-with': 'terminal' },
      });
      expect(body<ErrorBody>(res).error.code, `${method} ${url}`).toBe('MFA_REQUIRED');
    }
  });

  it('enforces the scopes it was minted with', async () => {
    const user = await seedUser(t);
    const instance = await app();
    const cookie = cookieOf(await login(instance, user.email));

    const mint = async (scopes: readonly string[]): Promise<string> => {
      const res = await instance.inject({
        method: 'POST',
        url: `${PREFIX}/auth/api-keys`,
        headers: { cookie, 'x-requested-with': 'terminal' },
        payload: { label: `key ${scopes.join('+')}`, scopes: [...scopes] },
      });
      expect(res.statusCode, res.body).toBe(201);
      return body<{ secret: string }>(res).secret;
    };

    const reader = await mint(['data:read']);
    const runner = await mint(['fn:run']);

    const allowed = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/usage/quota`,
      headers: { authorization: `Bearer ${reader}` },
    });
    expect(allowed.statusCode, allowed.body).toBe(200);

    // A key without `data:read` used to read the same route: `requireSession({scopes})` existed
    // and no route ever passed `scopes`.
    const refused = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/usage/quota`,
      headers: { authorization: `Bearer ${runner}` },
    });
    expect(refused.statusCode).toBe(403);
    const error = body<ErrorBody & { error: { details: { requiredScope: string[] } } }>(refused)
      .error;
    expect(error.code).toBe('FORBIDDEN');
    expect(error.details.requiredScope).toEqual(['data:read']);
  });

  it('does not resurrect the api session a user just revoked', async () => {
    const user = await seedUser(t);
    const instance = await app();
    const cookie = cookieOf(await login(instance, user.email));

    const created = await instance.inject({
      method: 'POST',
      url: `${PREFIX}/auth/api-keys`,
      headers: { cookie, 'x-requested-with': 'terminal' },
      payload: { label: 'desktop' },
    });
    const secret = body<{ secret: string }>(created).secret;

    const first = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/auth/session`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(first.statusCode).toBe(200);
    const apiSessionId = body<{ sessionId: string }>(first).sessionId;

    const killed = await instance.inject({
      method: 'DELETE',
      url: `${PREFIX}/auth/sessions/${apiSessionId}`,
      headers: { cookie, 'x-requested-with': 'terminal' },
    });
    expect(killed.statusCode, killed.body).toBe(204);

    // The upsert used to SET revoked_at = NULL, so the very next bearer request undid the revoke.
    const after = await instance.inject({
      method: 'GET',
      url: `${PREFIX}/auth/session`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(after.statusCode).toBe(401);

    const row = await t.client.query<{ revoked_at: Date | null; reason: string | null }>(
      `SELECT revoked_at, revoke_reason AS reason FROM sessions WHERE session_id = $1`,
      [apiSessionId],
    );
    expect(row.rows[0]!.revoked_at).not.toBeNull();
    expect(row.rows[0]!.reason).toBe('logout');
  });
});

/**
 * The advisory lock of `mintWebSession` cannot be RACED here: `withTxDb()` hands every request one
 * pg client inside one transaction, so three "concurrent" logins are three statements on one
 * connection that all see each other's uncommitted rows — a collision the lock is not there to
 * solve. What can be asserted here is the rule the lock protects, and it is asserted above in
 * "concurrent sessions": a second login supersedes the first, reports what it displaced, and
 * leaves exactly one active web row. The lock itself is stated where it belongs, in
 * `http/auth/session.ts`, with the EvalPlanQual reasoning that makes `FOR UPDATE` insufficient.
 */
