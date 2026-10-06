/**
 * `POST /auth/mfa/email/send` and `/verify` driven through the real application — the email second
 * factor, and every property `http/auth/emailCode.ts` claims for it.
 *
 * The app is `createTestApp` over this file's own open transaction, with a `memorySender` as the
 * transport: the suite runs with no network (QA-02), so a "sent" message is one the test reads back
 * off an array. Time is a `VirtualClock`, so a code expires by advancing it, not by waiting.
 *
 * Organised by the claim each test defends, because for a security feature the useful question is
 * not "does it work" but "what stops it from being misused":
 *
 *   * it gates — a password-verified session that owes a second factor cannot reach data;
 *   * it is a SECOND factor only — no path through it mints a session;
 *   * a code is hashed at rest, single-use, session-bound, five guesses, ten minutes;
 *   * resends are throttled, and a failed send leaves nothing behind;
 *   * it fails closed when no mail transport is configured;
 *   * the grants in migration 0020 are what the code needs, checked as the app role.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { afterEach, describe, expect, it } from 'vitest';

import { getConfig } from '../../../src/config.js';
import { memorySender, type MemorySender } from '../../../src/email/sender.js';
import {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  MAX_SENDS_PER_SESSION,
  RESEND_COOLDOWN_MS,
  deriveCodeKey,
} from '../../../src/http/auth/emailCode.js';
import { emailCodeService } from '../../../src/http/auth/emailCodeService.js';
import { setPassword } from '../../../src/http/auth/password.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';

const t = withTxDb();

const PREFIX = '/api/v1';
const PASSWORD = 'correct horse battery staple';
const CSRF = { 'x-requested-with': 'terminal' } as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures this file owns
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface SeededUser {
  userId: number;
  email: string;
}

async function seedUser(db: TestDb, spec: { mfaRequired?: boolean } = {}): Promise<SeededUser> {
  const firm = await db.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`MFA Email Firm ${randomUUID().slice(0, 8)}`],
  );
  const email = `mfa-${randomUUID()}@demo.invalid`;
  const user = await db.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, desk, role, status, mfa_required)
     VALUES ($1, $2, 'MFA Test User', 'Rates', 'user', 'active', $3) RETURNING user_id`,
    [Number(firm.rows[0]!.firm_id), email, spec.mfaRequired ?? true],
  );
  const userId = Number(user.rows[0]!.user_id);
  await setPassword(db.db, userId, PASSWORD);
  return { userId, email };
}

let started: TestApp | undefined;
afterEach(async () => {
  await started?.close();
  started = undefined;
});

interface Harness {
  app: FastifyInstance;
  clock: VirtualClock;
  outbox: MemorySender;
}

async function harness(opts: { sender?: MemorySender | null } = {}): Promise<Harness> {
  const clock = testClock();
  const outbox = opts.sender === undefined ? memorySender() : opts.sender;
  started = await createTestApp({ db: t.db, clock, auth: { emailSender: outbox } });
  return { app: started.app, clock, outbox: outbox ?? memorySender() };
}

function cookieOf(res: InjectResponse): string {
  const jar = res.cookies as { name: string; value: string }[];
  const tsid = jar.find((c) => c.name === 'tsid');
  expect(tsid, 'the response set a tsid cookie').toBeDefined();
  return `tsid=${encodeURIComponent(tsid!.value)}`;
}

function json<T = Record<string, unknown>>(res: InjectResponse): T {
  return JSON.parse(res.body) as T;
}

interface ErrorBody {
  error: { code: string; message: string; retryAfterMs?: number; details?: Record<string, unknown> };
}

/** Log in with the password; returns the PENDING session's cookie. */
async function login(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `${PREFIX}/auth/login`,
    payload: { email, password: PASSWORD, deviceId: `dev-${randomUUID().slice(0, 8)}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  return cookieOf(res);
}

const send = (app: FastifyInstance, cookie: string): Promise<InjectResponse> =>
  app.inject({ method: 'POST', url: `${PREFIX}/auth/mfa/email/send`, headers: { cookie, ...CSRF } });

const verify = (app: FastifyInstance, cookie: string, code: string): Promise<InjectResponse> =>
  app.inject({
    method: 'POST',
    url: `${PREFIX}/auth/mfa/email/verify`,
    headers: { cookie, ...CSRF },
    payload: { code },
  });

/** The six digits out of the n-th message sent. */
function codeIn(outbox: MemorySender, n = -1): string {
  const message = outbox.sent.at(n);
  expect(message, 'a message was sent').toBeDefined();
  const match = /\b(\d{6})\b/.exec(message!.text);
  expect(match, `the message carries a six-digit code:\n${message!.text}`).not.toBeNull();
  return match![1]!;
}

/** A code guaranteed to differ from `code`. */
const wrong = (code: string): string => (code === '000000' ? '111111' : '000000');

const dataRoute = (app: FastifyInstance, cookie: string): Promise<InjectResponse> =>
  app.inject({ method: 'GET', url: `${PREFIX}/workspace`, headers: { cookie } });

// ─────────────────────────────────────────────────────────────────────────────────────────────
// It gates
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the gate — a session that owes a second factor cannot reach data', () => {
  it('refuses a data route with 401 MFA_REQUIRED until the code is entered, then lets it through', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);

    const before = await dataRoute(h.app, cookie);
    expect(before.statusCode).toBe(401);
    expect(json<ErrorBody>(before).error.code).toBe('MFA_REQUIRED');

    expect((await send(h.app, cookie)).statusCode).toBe(200);
    const ok = await verify(h.app, cookie, codeIn(h.outbox));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(json<{ session: { mfaVerified: boolean } }>(ok).session.mfaVerified).toBe(true);

    const after = await dataRoute(h.app, cookie);
    expect(after.statusCode, 'the same cookie, upgraded').not.toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// It is a second factor only
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('a second factor ONLY — no path through it creates a session', () => {
  it('refuses verify with no session at all, even holding a valid code', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);
    await send(h.app, cookie);
    const code = codeIn(h.outbox);

    const res = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/auth/mfa/email/verify`,
      headers: CSRF,
      payload: { code },
    });
    expect(res.statusCode).toBe(401);
    expect(json<ErrorBody>(res).error.code).toBe('AUTH_REQUIRED');
    expect(res.cookies, 'no session cookie is minted').toHaveLength(0);
  });

  it('refuses send with no session, so the route cannot be used to mail anyone', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'POST', url: `${PREFIX}/auth/mfa/email/send`, headers: CSRF });
    expect(res.statusCode).toBe(401);
    expect(h.outbox.sent).toHaveLength(0);
  });

  it('refuses a session that does not owe a second factor', async () => {
    const h = await harness();
    const user = await seedUser(t, { mfaRequired: false });
    const cookie = await login(h.app, user.email);
    const res = await send(h.app, cookie);
    expect(res.statusCode).toBe(400);
    expect(h.outbox.sent).toHaveLength(0);
  });

  it('refuses a session that already passed it', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);
    await send(h.app, cookie);
    expect((await verify(h.app, cookie, codeIn(h.outbox))).statusCode).toBe(200);

    h.clock.advance(RESEND_COOLDOWN_MS);
    expect((await send(h.app, cookie)).statusCode).toBe(400);
  });

  it('requires the CSRF header on both, like every cookie-authenticated mutation', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);
    const res = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/auth/mfa/email/send`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(json<ErrorBody>(res).error.code).toBe('CSRF_REJECTED');
    expect(h.outbox.sent).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The message
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the message, and what the response says about it', () => {
  it('goes to the account address, with the code in the body and NOT in the subject', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);
    const res = await send(h.app, cookie);
    expect(res.statusCode, res.body).toBe(200);

    expect(h.outbox.sent).toHaveLength(1);
    const message = h.outbox.sent[0]!;
    expect(message.to).toBe(user.email);
    const code = codeIn(h.outbox);
    // A subject is what a locked phone shows; the second factor must not be readable from it.
    expect(message.subject).not.toContain(code);
    expect(message.subject).not.toMatch(/\d{6}/);
  });

  it('answers with a MASKED address, the expiry and the resend time — never the code', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);
    const res = await send(h.app, cookie);
    const sent = json<{ sentTo: string; expiresAt: string; resendAvailableAt: string; sendsRemaining: number }>(res);
    const code = codeIn(h.outbox);

    expect(res.body).not.toContain(code);
    expect(sent.sentTo).not.toBe(user.email);
    expect(sent.sentTo).toContain('*');
    expect(sent.sentTo.endsWith('.invalid')).toBe(true);
    expect(Date.parse(sent.expiresAt) - h.clock.now()).toBe(CODE_TTL_MS);
    expect(Date.parse(sent.resendAvailableAt) - h.clock.now()).toBe(RESEND_COOLDOWN_MS);
    expect(sent.sendsRemaining).toBe(MAX_SENDS_PER_SESSION - 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The code itself
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('a code — hashed, single-use, session-bound, five guesses, ten minutes', () => {
  it('is stored as a 32-byte keyed hash, and the digits appear nowhere in the row', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);
    await send(h.app, cookie);
    const code = codeIn(h.outbox);

    const rows = await t.client.query<Record<string, unknown>>(
      `SELECT *, encode(code_hash, 'hex') AS hex FROM mfa_email_codes WHERE user_id = $1`,
      [user.userId],
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect((row.code_hash as Buffer).length).toBe(32);
    // Every column, as text: the code is nowhere — not in the hash's hex, not in any other field.
    for (const [column, value] of Object.entries(row)) {
      expect(String(value), `column ${column}`).not.toContain(code);
    }
  });

  it('cannot be used twice', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);
    await send(h.app, cookie);
    const code = codeIn(h.outbox);

    expect((await verify(h.app, cookie, code)).statusCode).toBe(200);
    // The session is now verified, so a second verify is refused at the gate — and the row is
    // consumed, which the next assertion checks directly rather than through the route.
    const consumed = await t.client.query<{ consumed: boolean }>(
      `SELECT consumed_at IS NOT NULL AS consumed FROM mfa_email_codes WHERE user_id = $1`,
      [user.userId],
    );
    expect(consumed.rows[0]?.consumed).toBe(true);
  });

  it('dies after five wrong guesses — after which even the right code is refused', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);
    await send(h.app, cookie);
    const code = codeIn(h.outbox);

    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      const res = await verify(h.app, cookie, wrong(code));
      expect(res.statusCode).toBe(401);
      const err = json<ErrorBody>(res).error;
      expect(err.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(err.details).toMatchObject({ reason: 'mismatch', attemptsRemaining: MAX_ATTEMPTS - i });
    }

    const late = await verify(h.app, cookie, code);
    expect(late.statusCode).toBe(401);
    expect(json<ErrorBody>(late).error.details).toMatchObject({ reason: 'exhausted', attemptsRemaining: 0 });
    expect((await dataRoute(h.app, cookie)).statusCode).toBe(401);
  });

  it('expires after ten minutes, to the millisecond', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);
    await send(h.app, cookie);
    const code = codeIn(h.outbox);

    h.clock.advance(CODE_TTL_MS);
    const res = await verify(h.app, cookie, code);
    expect(res.statusCode).toBe(401);
    expect(json<ErrorBody>(res).error.details).toMatchObject({ reason: 'expired' });
  });

  it('is still good one millisecond before it expires', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);
    await send(h.app, cookie);
    h.clock.advance(CODE_TTL_MS - 1);
    expect((await verify(h.app, cookie, codeIn(h.outbox))).statusCode).toBe(200);
  });

  it('belongs to the session that asked: a new login cannot use the old login’s code', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const first = await login(h.app, user.email);
    await send(h.app, first);
    const firstCode = codeIn(h.outbox);

    // SEC-03: one active web session per user, so this login supersedes the first.
    const second = await login(h.app, user.email);
    const res = await verify(h.app, second, firstCode);
    expect(res.statusCode).toBe(401);
    expect(json<ErrorBody>(res).error.details).toMatchObject({ reason: 'no_code' });
  });

  it('forgives the spacing a mail client adds, and does not charge a guess for a malformed entry', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);
    await send(h.app, cookie);
    const code = codeIn(h.outbox);

    const malformed = await verify(h.app, cookie, '12345');
    expect(malformed.statusCode).toBe(401);
    expect(json<ErrorBody>(malformed).error.details).toEqual({ reason: 'malformed' });
    const attempts = await t.client.query<{ attempts: number }>(
      `SELECT attempts FROM mfa_email_codes WHERE user_id = $1`,
      [user.userId],
    );
    expect(attempts.rows[0]?.attempts, 'a malformed entry is not a guess').toBe(0);

    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect((await verify(h.app, cookie, spaced)).statusCode).toBe(200);
  });

  it('lets exactly one of two concurrent correct guesses through', async () => {
    // The single-use UPDATE is `WHERE consumed_at IS NULL … RETURNING`, so the loser gets no row.
    // Driven at the service, against one handle, because two route calls through one inject queue
    // would not be concurrent at the statement level.
    const user = await seedUser(t);
    const clock = testClock();
    const sender = memorySender();
    const sessionId = randomUUID();
    await t.client.query(
      `INSERT INTO sessions (session_id, user_id, token_hash, client_kind, expires_at)
       VALUES ($1, $2, digest($3, 'sha256'), 'web', now() + interval '1 day')`,
      [sessionId, user.userId, randomUUID()],
    );
    const codes = emailCodeService({
      db: t.db,
      clock,
      key: deriveCodeKey(getConfig().SESSION_SECRET),
      sender,
    });
    await codes.send({ sessionId, userId: user.userId, email: user.email });
    const code = codeIn(sender);

    const results = await Promise.all([
      codes.verify({ sessionId, code }),
      codes.verify({ sessionId, code }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Sending
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('sending — throttled, superseding, and atomic with the message', () => {
  it('refuses a resend inside thirty seconds, saying how long to wait', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);
    await send(h.app, cookie);

    h.clock.advance(RESEND_COOLDOWN_MS - 1_000);
    const res = await send(h.app, cookie);
    expect(res.statusCode).toBe(429);
    const err = json<ErrorBody>(res).error;
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterMs).toBe(1_000);
    expect(h.outbox.sent).toHaveLength(1);
  });

  it('makes the previous code useless when a new one is sent', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);
    await send(h.app, cookie);
    const oldCode = codeIn(h.outbox, 0);

    h.clock.advance(RESEND_COOLDOWN_MS);
    expect((await send(h.app, cookie)).statusCode).toBe(200);
    const newCode = codeIn(h.outbox, 1);

    if (oldCode !== newCode) {
      const stale = await verify(h.app, cookie, oldCode);
      expect(stale.statusCode).toBe(401);
    }
    expect((await verify(h.app, cookie, newCode)).statusCode).toBe(200);
  });

  /**
   * SUPERSESSION, ASSERTED AS THE STATE IT PRODUCES — and why not as a behaviour.
   *
   * The first version of this test exhausted the new code and expected the old one to stay dead. It
   * passed with supersession switched off, and a mutation run is how that came out: `verify` reads
   * only the NEWEST live code, and an exhausted code still holds that slot, so the old code is never
   * reached either way. Within the current lookup, supersession cannot change what `verify` answers.
   *
   * It is kept as defence in depth: it makes "one live code per session" a fact about the TABLE
   * rather than only about the lookup, so a later `verify` that read "any live code" would not
   * quietly start accepting old ones. So it is asserted where it acts — on the rows.
   */
  it('retires the previous code in the table when a new one is sent', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);
    await send(h.app, cookie);
    h.clock.advance(RESEND_COOLDOWN_MS);
    await send(h.app, cookie);

    const rows = await t.client.query<{ superseded: boolean; live: boolean }>(
      `SELECT superseded_at IS NOT NULL AS superseded,
              consumed_at IS NULL AND superseded_at IS NULL AS live
         FROM mfa_email_codes WHERE user_id = $1 ORDER BY created_at`,
      [user.userId],
    );
    expect(rows.rows).toEqual([
      { superseded: true, live: false },
      { superseded: false, live: true },
    ]);
  });

  it('stops after five sends for one sign-in', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);
    for (let i = 0; i < MAX_SENDS_PER_SESSION; i += 1) {
      expect((await send(h.app, cookie)).statusCode, `send ${String(i + 1)}`).toBe(200);
      h.clock.advance(RESEND_COOLDOWN_MS);
    }
    const res = await send(h.app, cookie);
    expect(res.statusCode).toBe(429);
    expect(json<ErrorBody>(res).error.details).toMatchObject({ reason: 'send_limit' });
    expect(h.outbox.sent).toHaveLength(MAX_SENDS_PER_SESSION);
  });

  it('leaves no row and charges no cooldown when the provider refuses the message', async () => {
    const h = await harness();
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);

    h.outbox.failNext(new Error('550 relay denied by mail.example (banner text)'));
    const failed = await send(h.app, cookie);
    expect(failed.statusCode).toBe(503);
    const err = json<ErrorBody>(failed).error;
    expect(err.code).toBe('PROVIDER_UNAVAILABLE');
    // The provider's own words stay in the log; the person signing in gets ours.
    expect(err.message).not.toContain('550');
    expect(err.message).not.toContain('mail.example');

    const rows = await t.client.query(`SELECT 1 FROM mfa_email_codes WHERE user_id = $1`, [user.userId]);
    expect(rows.rows, 'the insert rolled back with the failed send').toHaveLength(0);

    // No cooldown for a message that never left: an immediate retry goes through.
    expect((await send(h.app, cookie)).statusCode).toBe(200);
    expect((await verify(h.app, cookie, codeIn(h.outbox))).statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Failing closed
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('no transport — it fails closed', () => {
  it('answers 503 and stores nothing when no mail transport is configured', async () => {
    const h = await harness({ sender: null });
    const user = await seedUser(t);
    const cookie = await login(h.app, user.email);

    const res = await send(h.app, cookie);
    expect(res.statusCode).toBe(503);
    expect(json<ErrorBody>(res).error.code).toBe('PROVIDER_UNAVAILABLE');
    const rows = await t.client.query(`SELECT 1 FROM mfa_email_codes WHERE user_id = $1`, [user.userId]);
    expect(rows.rows).toHaveLength(0);
    // And the session stays exactly as gated as it was.
    expect((await dataRoute(h.app, cookie)).statusCode).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The grants, as the role the application actually connects as
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('migration 0020’s grants are exactly what the code needs — checked as terminal_app', () => {
  it('sends and verifies under SET LOCAL ROLE terminal_app', async () => {
    // The local owner is a superuser and bypasses every grant, so the routes above prove nothing
    // about §20.b. This runs the service's own statements as the application role.
    const user = await seedUser(t);
    const sessionId = randomUUID();
    await t.client.query(
      `INSERT INTO sessions (session_id, user_id, token_hash, client_kind, expires_at)
       VALUES ($1, $2, digest($3, 'sha256'), 'web', now() + interval '1 day')`,
      [sessionId, user.userId, randomUUID()],
    );
    const sender = memorySender();
    const codes = emailCodeService({
      db: t.db,
      clock: testClock(),
      key: deriveCodeKey(getConfig().SESSION_SECRET),
      sender,
    });

    await t.client.query('SET LOCAL ROLE terminal_app');
    try {
      await codes.send({ sessionId, userId: user.userId, email: user.email });
      const wrongOutcome = await codes.verify({ sessionId, code: wrong(codeIn(sender)) });
      expect(wrongOutcome).toMatchObject({ ok: false, reason: 'mismatch' });
      expect(await codes.verify({ sessionId, code: codeIn(sender) })).toEqual({ ok: true });
    } finally {
      await t.client.query('RESET ROLE');
    }
  });

  it('cannot rewrite a hash or an expiry, and cannot delete a code', async () => {
    const privileges = await t.client.query<Record<string, boolean>>(
      `SELECT has_column_privilege('terminal_app', 'mfa_email_codes', 'code_hash', 'UPDATE')  AS hash,
              has_column_privilege('terminal_app', 'mfa_email_codes', 'expires_at', 'UPDATE') AS expiry,
              has_column_privilege('terminal_app', 'mfa_email_codes', 'session_id', 'UPDATE') AS session,
              has_table_privilege('terminal_app', 'mfa_email_codes', 'DELETE')                AS del`,
    );
    expect(privileges.rows[0]).toEqual({ hash: false, expiry: false, session: false, del: false });
  });
});
