/**
 * `http/routes/auth.ts` — the twelve routes of API.md §1.3 (SEC-01, SEC-02, SEC-03, API-01,
 * ENTL-03, API-06).
 *
 * Everything hard is already built and this module only composes it: `http/auth/session.ts` mints
 * and resolves sessions and owns the guard, `password.ts` verifies the dev credential inside
 * Postgres, `apikeys.ts` mints and resolves bearer keys, `webauthn.ts` is the pure FIDO2 ceremony,
 * `entitlements/licenceRegistry.ts` is the evaluator's own view of a user's grants and
 * `entitlements/quotas.ts` is the live counter set. Nothing here invents a number: every field of
 * `SessionInfo` is read from one of those.
 *
 * Four properties this file is responsible for, none of which is decoration:
 *
 *  1. **No user enumeration.** An unknown email and a wrong password produce the same status, the
 *     same code, the same message and the same *work*: the unknown-email path still runs one
 *     bcrypt (`crypt(password, gen_salt('bf', 12))`) so the two answers cannot be told apart by a
 *     stopwatch. `403 USER_SUSPENDED` is only ever reached **after** the password has been proved,
 *     so it cannot be used to probe which addresses exist.
 *  2. **The rate limit is per IP and counts every attempt** (5 per minute, API.md §1.3), including
 *     the malformed ones — a limiter that only counts well-formed bodies is not a limiter.
 *  3. **A challenge is single-use and expires in five minutes.** It is deleted when it is read, so
 *     a replayed assertion fails on the missing challenge before any signature is checked.
 *  4. **The MFA gate.** `requireSession` lets a session that has not verified MFA reach `/auth/*`
 *     (that is where it goes to verify) and nothing else. The one `/auth` route that must not be
 *     reachable before MFA — minting an API key, which would be a way around the second factor —
 *     re-checks it here.
 *
 * `app.ts` is frozen: this file is picked up by the generated barrel
 * (`npx tsx scripts/gen-function-index.ts`) and registered under `/api/v1`, and the services it
 * needs are reached through `app.deps`, with optional overrides in `app.deps.auth` for a host (or
 * a test) that wants to inject its own.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { FIELD_DICTIONARY_VERSION, type Clock, type Tier } from '@terminal/core';
import {
  ApiKeyCreate,
  LoginRequest,
  WebAuthnLoginOptionsRequest,
  WebAuthnLoginVerifyRequest,
  WebAuthnRegisterVerifyRequest,
  type ApiKeySummary,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type Role,
  type SessionInfo,
  type SessionSummary,
} from '@terminal/sdk/wire/rest/auth';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Db, Tx } from '../../db/client.js';
import {
  apiKeys,
  firms,
  sessions,
  userCredentials,
  users,
} from '../../db/schema/index.js';
import {
  licenceRegistry,
  type GrantRow,
  type LicenceRegistry,
} from '../../entitlements/licenceRegistry.js';
import { minTier } from '../../entitlements/evaluator.js';
import { quotas as buildQuotas, type Quotas } from '../../entitlements/quotas.js';
import { mintApiKey, revokeApiKey } from '../auth/apikeys.js';
import { burnPasswordWork as burnPassword, verifyPassword } from '../auth/password.js';
import {
  requireSession,
  sessionCookieOptions,
  sessionService,
  SESSION_COOKIE,
  type Principal,
  type SessionService,
  type SupersededSession,
} from '../auth/session.js';
import {
  authenticationOptions,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from '../auth/webauthn.js';
import { AppError, ForbiddenError, NotFoundError, ValidationFailedError } from '../errors.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Optional overrides. Absent, every service is built from `app.deps.db` and `app.deps.clock`, which
 * is what a test transaction and a `VirtualClock` make possible without a second code path.
 */
export interface AuthRouteDeps {
  sessions?: SessionService;
  licences?: LicenceRegistry;
  quotas?: Quotas;
  /** Relying-party identity. Derived from the request's own host/origin when omitted. */
  webauthn?: { rpId?: string; rpName?: string; origin?: string };
  /** API.md §1.3: 5 per minute per IP. */
  loginRateLimit?: { max: number; windowMs: number };
  /** `Secure` on the `tsid` cookie. Omitted only for `NODE_ENV=development` on plain HTTP. */
  cookieSecure?: boolean;
}

declare module '../../app.js' {
  // Optional additions only — `buildApp`'s contract (app.ts L60-64) allows exactly this.
  interface AppDeps {
    /** Overrides for `http/routes/auth.ts`; every field has a working default. */
    auth?: AuthRouteDeps;
  }
}

/** The process version reported by `SessionInfo` (and later by `GET /status`, WP-08). */
export const SERVER_VERSION = '0.1.0';

/** The oldest client build this server still speaks to. */
export const MIN_CLIENT_VERSION = '0.1.0';

/** The WS protocol this server speaks (API.md §11). */
const WS_PROTOCOL = 1 as const;

/** API.md §1.3: "challenge cached 5 min per session". */
export const CHALLENGE_TTL_MS = 5 * 60 * 1_000;

/** API.md §1.3 login rate limit. */
export const LOGIN_RATE_MAX = 5;
export const LOGIN_RATE_WINDOW_MS = 60_000;

/**
 * The per-email ceiling, as a multiple of the per-IP one. A person retrying from a phone and a
 * desk must not trip it, so it is deliberately looser than the per-IP limit; its job is to bound
 * credential stuffing spread across many addresses, not to replace the per-IP limit.
 */
export const EMAIL_RATE_FACTOR = 4;

/** Entries in the attempt map above which every attempt also sweeps the expired ones. */
export const ATTEMPTS_SOFT_CAP = 1_000;

/**
 * Live WebAuthn login challenges the server will hold for anonymous callers. `login/options` is
 * unauthenticated by design (it must answer identically for an unknown email), so without a
 * ceiling it is a memory-growth primitive: 32 bytes plus a map entry per call, held for five
 * minutes. Beyond this, the oldest entries are evicted.
 */
export const MAX_LIVE_CHALLENGES = 2_000;

/** The relying-party name shown by the authenticator. */
const RP_NAME = 'Terminal';

/** One message for "unknown email" and for "wrong password" — the anti-enumeration invariant. */
const INVALID_CREDENTIALS = 'Email or password is incorrect.';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function parseOrThrow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  location: 'body' | 'params' | 'query',
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationFailedError(location, parsed.error.issues);
  return parsed.data;
}

function iso(value: Date): string {
  return value.toISOString();
}

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * The relying-party identity this deployment's WebAuthn ceremonies are verified against: `RP_ID`
 * and `RP_ORIGIN` from {@link Config}, or the explicit `app.deps.auth.webauthn` override.
 *
 * **Never the request's own `Host` or `Origin`.** The two checks that make WebAuthn phishing-proof
 * are `clientDataJSON.origin === expectedOrigin` and `authData.rpIdHash === sha256(rpId)`. If the
 * expected values are read off the request, an attacker who serves the page from `evil.test` gets
 * `rpId: 'evil.test'` in the options, signs an assertion that carries `sha256('evil.test')` and
 * `origin: 'https://evil.test'`, and both comparisons pass — the attacker's value compared with
 * itself. So the value is configuration, and a deployment that has not set it cannot run the
 * ceremony at all.
 *
 * @throws AppError('INTERNAL') when neither the config nor an override supplies the pair.
 */
function relyingParty(app: FastifyInstance): {
  rpId: string;
  rpName: string;
  origin: string;
} {
  const injected = app.deps.auth?.webauthn;
  const rpId = injected?.rpId ?? app.deps.config.RP_ID;
  const origin = (injected?.origin ?? app.deps.config.RP_ORIGIN)?.trim();
  if (rpId === undefined || rpId.length === 0 || origin === undefined || origin.length === 0) {
    // Fail closed, loudly. Guessing here is the whole vulnerability.
    throw new AppError(
      'INTERNAL',
      'WebAuthn is not configured on this server: set RP_ID and RP_ORIGIN.',
    );
  }
  return { rpId, rpName: injected?.rpName ?? RP_NAME, origin };
}

/**
 * Refuse a bearer principal.
 *
 * `requireSession` cannot do this for the `/auth/api-keys` routes, because a bearer session is
 * exactly what most of `/auth/*` is meant to serve. It is these three routes — mint, list, revoke —
 * that API.md §1.3 binds to a web session, so they say so themselves.
 */
function requireWebSession(principal: Principal, message: string): void {
  if (principal.clientKind !== 'web') throw new ForbiddenError(message);
}

/**
 * Re-apply the MFA gate inside an `/auth` route.
 *
 * `requireSession` deliberately lets an unverified session reach `/auth/*` — that is where it goes
 * to verify. Every route that manages a long-lived bearer credential has to undo that exemption
 * itself, or listing, minting and revoking keys all happen before the second factor.
 */
function requireVerifiedMfa(principal: Principal): void {
  if (principal.mfaRequired && !principal.mfaVerified) {
    throw new AppError('MFA_REQUIRED', 'Verify your security key first.');
  }
}

/**
 * Does this principal already carry `scope`?
 *
 * A web session is the person and carries everything; a bearer session carries exactly the scopes
 * minted into its key (`http/auth/apikeys.ts`).
 */
function holdsScope(principal: Principal, scope: string): boolean {
  return principal.clientKind === 'web' || principal.scopes.includes(scope);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entitlement summary — the evaluator's own inputs, not a second opinion
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The lowest tier of a grant set, or `null` when the set is empty. */
function lowestTier(grants: readonly GrantRow[]): Tier | null {
  let low: Tier | null = null;
  for (const grant of grants) low = low === null ? grant.maxTier : minTier(low, grant.maxTier);
  return low;
}

/**
 * `SessionInfo.entitlementSummary` (API.md §1.2): the *floor* of what this person may see, read
 * from the same `entitlement_grants` rows the evaluator reads (ARCHITECTURE §10 rules 4-5), through
 * the same registry object and the same tier algebra.
 *
 * ENTL-02 makes the effective tier the intersection of the firm's contract and the user's
 * subscription, so a user with no grant of their own — or a firm with none — has no floor to report
 * and the summary is the most restrictive one there is (`eod`, no export, no API). Nothing here
 * grants anything: it is a display of what the evaluator would decide, and the evaluator decides
 * again per field on every read.
 */
function entitlementSummary(
  registry: LicenceRegistry,
  userId: number,
  firmId: number,
): SessionInfo['entitlementSummary'] {
  const userGrants = registry.grantsFor('user', userId);
  const firmGrants = registry.grantsFor('firm', firmId);
  const userTier = lowestTier(userGrants);
  const firmTier = lowestTier(firmGrants);
  if (userTier === null || firmTier === null) {
    return { defaultTier: 'eod', exportAllowed: false, apiAllowed: false };
  }
  return {
    defaultTier: minTier(userTier, firmTier),
    exportAllowed: userGrants.some((g) => g.usageExport) && firmGrants.some((g) => g.usageExport),
    apiAllowed: userGrants.some((g) => g.usageApi) && firmGrants.some((g) => g.usageApi),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The plugin
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface CachedChallenge {
  challenge: Buffer;
  /** The user the ceremony is for; `null` for a login challenge minted for an unknown email. */
  userId: number | null;
  expiresAt: number;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  const db: Db | Tx = app.deps.db;
  const clock: Clock = app.deps.clock;

  /** Login attempts per IP, newest last. Pruned on every attempt; bounded by the window. */
  const attempts = new Map<string, number[]>();

  /**
   * Live WebAuthn challenges, keyed `reg:<sessionId>` or `login:<challengeId>`. In process memory
   * on purpose: a challenge is worthless after five minutes, must not survive a restart, and must
   * never reach a table where it could be read back (the same rule as a session token).
   */
  const challenges = new Map<string, CachedChallenge>();

  let registryMemo: Promise<LicenceRegistry> | undefined;

  // `app.deps.sessions` is the optional field `requireSession` also reads; it is reached through
  // the same structural cast rather than a second declaration of it on `AppDeps`.
  const hosted = (app.deps as { sessions?: SessionService }).sessions;
  const service: SessionService =
    app.deps.auth?.sessions ?? hosted ?? sessionService({ db, clock });
  const quotaService: Quotas = app.deps.auth?.quotas ?? buildQuotas({ db, clock });

  async function registry(): Promise<LicenceRegistry> {
    const injected = app.deps.auth?.licences;
    if (injected !== undefined) {
      await injected.refreshIfStale();
      return injected;
    }
    if (registryMemo === undefined) {
      const loading = (async (): Promise<LicenceRegistry> => {
        const built = licenceRegistry({ db, clock });
        await built.reload();
        return built;
      })();
      // A failed first load must not be memoised, or the process would serve the failure forever.
      registryMemo = loading.catch((err: unknown) => {
        registryMemo = undefined;
        throw err;
      });
      return loading;
    }
    const held = await registryMemo;
    await held.refreshIfStale();
    return held;
  }

  function takeChallenge(key: string): CachedChallenge | undefined {
    const nowMs = clock.now();
    for (const [k, v] of challenges) if (v.expiresAt <= nowMs) challenges.delete(k);
    const held = challenges.get(key);
    // Single use: reading it consumes it, so a replay finds nothing.
    challenges.delete(key);
    if (held === undefined || held.expiresAt <= nowMs) return undefined;
    return held;
  }

  /**
   * Mint and hold a challenge.
   *
   * Expiry was previously only noticed by {@link takeChallenge}, which an attacker simply never
   * calls — so pruning happens on the WRITE path too, and the map is hard-capped: over
   * {@link MAX_LIVE_CHALLENGES} live entries the oldest are evicted (a `Map` iterates in insertion
   * order, and the TTL is uniform, so the first entries are the nearest to expiring). Evicting
   * beats refusing: a dropped challenge costs its owner one retry, while refusing would let an
   * attacker deny logins to everyone else.
   */
  function putChallenge(key: string, userId: number | null): Buffer {
    const nowMs = clock.now();
    for (const [k, v] of challenges) if (v.expiresAt <= nowMs) challenges.delete(k);
    const challenge = randomBytes(32);
    challenges.set(key, { challenge, userId, expiresAt: nowMs + CHALLENGE_TTL_MS });
    while (challenges.size > MAX_LIVE_CHALLENGES) {
      const oldest = challenges.keys().next();
      if (oldest.done === true) break;
      challenges.delete(oldest.value);
    }
    return challenge;
  }

  /**
   * The limiter's subject: the address that actually opened the socket.
   *
   * NOT `request.ip`. `buildApp` sets `trustProxy: true`, so `request.ip` is whatever the caller
   * put in `X-Forwarded-For` — one header per attempt and the limit stops nobody, while every
   * distinct spoofed value also leaves a permanent entry in `attempts`. The peer address is the
   * one value a client cannot choose. A deployment behind a real proxy configures the proxy's
   * own rate limit, or gives `trustProxy` a list of trusted addresses; it does not get to trust
   * an arbitrary header here.
   */
  function peerKey(request: FastifyRequest): string {
    return request.socket.remoteAddress ?? 'unknown-peer';
  }

  /**
   * Record one attempt against `key` and refuse when the window is full.
   *
   * Two independent counters call this: the peer address (API.md §1.3's "5/min per IP") and the
   * submitted email, lower-cased. The second is what bounds credential stuffing that is spread
   * across many source addresses, which the first cannot see at all.
   */
  function countAttempt(key: string, max: number, windowMs: number, nowMs: number): void {
    const seen = (attempts.get(key) ?? []).filter((at) => at > nowMs - windowMs);
    if (seen.length >= max) {
      const oldest = seen[0] ?? nowMs;
      attempts.set(key, seen);
      throw new AppError('RATE_LIMITED', 'Too many login attempts. Try again shortly.', {
        retryAfterMs: Math.max(1_000, oldest + windowMs - nowMs),
        details: { limit: max, windowMs },
      });
    }
    seen.push(nowMs);
    attempts.set(key, seen);
  }

  /**
   * Drop every key whose newest attempt is outside the window.
   *
   * A key was only ever pruned by a LATER attempt from that same key, so an attacker who never
   * repeats a key grew the map without bound. This runs on every attempt once the map is over
   * {@link ATTEMPTS_SOFT_CAP}, which is far above any honest load and costs nothing until then.
   */
  function sweepAttempts(nowMs: number, windowMs: number): void {
    if (attempts.size <= ATTEMPTS_SOFT_CAP) return;
    for (const [key, at] of attempts) {
      const newest = at[at.length - 1];
      if (newest === undefined || newest <= nowMs - windowMs) attempts.delete(key);
    }
  }

  function rateWindow(): { max: number; windowMs: number } {
    const limit = app.deps.auth?.loginRateLimit;
    return { max: limit?.max ?? LOGIN_RATE_MAX, windowMs: limit?.windowMs ?? LOGIN_RATE_WINDOW_MS };
  }

  /** API.md §1.3: 5 per minute per IP, counting malformed attempts too. */
  function rateLimit(request: FastifyRequest): void {
    const { max, windowMs } = rateWindow();
    const nowMs = clock.now();
    sweepAttempts(nowMs, windowMs);
    countAttempt(`ip:${peerKey(request)}`, max, windowMs, nowMs);
  }

  /**
   * The second counter: attempts against ONE address, whatever they came from. An attacker with a
   * pool of source addresses defeats the per-IP limit entirely; this is what still bounds them.
   */
  function rateLimitEmail(email: string): void {
    if (email.length === 0) return;
    const { max, windowMs } = rateWindow();
    countAttempt(`email:${email.toLowerCase()}`, max * EMAIL_RATE_FACTOR, windowMs, clock.now());
  }

  /**
   * One bcrypt of work with no account behind it. The unknown-email branch of login calls this so
   * that "no such user" costs what "wrong password" costs.
   */
  async function burnPasswordWork(password: string): Promise<void> {
    await burnPassword(db, password);
  }

  // ── SessionInfo ────────────────────────────────────────────────────────────────────────────

  async function sessionInfo(sessionId: string): Promise<SessionInfo> {
    const rows = await db
      .select({
        sessionId: sessions.sessionId,
        clientKind: sessions.clientKind,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
        mfaVerified: sessions.mfaVerified,
        userId: users.userId,
        firmId: users.firmId,
        email: users.email,
        displayName: users.displayName,
        desk: users.desk,
        role: users.role,
        mfaRequired: users.mfaRequired,
        firmName: firms.name,
      })
      .from(sessions)
      .innerJoin(users, eq(users.userId, sessions.userId))
      .innerJoin(firms, eq(firms.firmId, users.firmId))
      .where(eq(sessions.sessionId, sessionId))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      // The guard resolved this session moments ago; it can only be gone if it was revoked
      // concurrently, and a revoked session has no info to report.
      throw new AppError('AUTH_REQUIRED', 'Session is no longer valid.');
    }

    const enrolled = await db
      .select({ credentialPk: userCredentials.credentialPk })
      .from(userCredentials)
      .where(
        and(
          eq(userCredentials.userId, row.userId),
          eq(userCredentials.kind, 'webauthn'),
          isNull(userCredentials.revokedAt),
        ),
      )
      .limit(1);

    const [reg, quotaState] = await Promise.all([
      registry(),
      quotaService.state(row.userId, row.firmId, row.clientKind === 'api' ? 'api' : 'web'),
    ]);

    return {
      sessionId: row.sessionId,
      userId: row.userId,
      firmId: row.firmId,
      firmName: row.firmName,
      email: row.email,
      displayName: row.displayName,
      desk: row.desk,
      role: row.role as Role,
      clientKind: row.clientKind === 'api' ? 'api' : 'web',
      mfaRequired: row.mfaRequired,
      mfaVerified: row.mfaVerified,
      webauthnEnrolled: enrolled.length > 0,
      createdAt: iso(row.createdAt),
      expiresAt: iso(row.expiresAt),
      entitlementSummary: entitlementSummary(reg, row.userId, row.firmId),
      quotas: {
        dailyUniqueInstruments: quotaState.dailyUniqueInstruments,
        monthlyDataPoints: quotaState.monthlyDataPoints,
        concurrentSubscriptions: quotaState.concurrentSubscriptions,
      },
      protocol: WS_PROTOCOL,
      serverVersion: SERVER_VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
      dictionaryVersion: FIELD_DICTIONARY_VERSION,
    };
  }

  function setSessionCookie(reply: FastifyReply, token: string, expiresAt: string): void {
    void reply.setCookie(
      SESSION_COOKIE,
      token,
      sessionCookieOptions({ secure: app.deps.auth?.cookieSecure ?? true, expiresAt }),
    );
  }

  // ── POST /auth/login ───────────────────────────────────────────────────────────────────────

  app.post('/auth/login', async (request, reply) => {
    // The IP counter runs BEFORE the body is parsed, so a malformed attempt still counts (module
    // docstring, property 2); the email counter needs the parsed body and runs right after.
    rateLimit(request);
    const body = parseOrThrow(LoginRequest, request.body, 'body');
    rateLimitEmail(body.email);

    const found = await db
      .select({
        userId: users.userId,
        status: users.status,
        mfaRequired: users.mfaRequired,
      })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${body.email})`)
      .limit(1);

    const user = found[0];
    if (user === undefined) {
      // Same answer, same cost (see the module docstring, property 1).
      await burnPasswordWork(body.password);
      throw new AppError('AUTH_INVALID_CREDENTIALS', INVALID_CREDENTIALS);
    }

    const ok = await verifyPassword(db, user.userId, body.password);
    if (!ok) throw new AppError('AUTH_INVALID_CREDENTIALS', INVALID_CREDENTIALS);

    // Only a caller who has already proved the password learns that the account is not usable, so
    // this is never an oracle for which addresses exist.
    if (user.status !== 'active') {
      throw new AppError('USER_SUSPENDED', 'This account is not active. Contact your administrator.');
    }

    const minted = await service.mintWebSession({
      userId: user.userId,
      deviceId: body.deviceId,
      ...(body.deviceLabel === undefined ? {} : { deviceLabel: body.deviceLabel }),
      ip: request.ip,
      mfaVerified: !user.mfaRequired,
      traceId: request.traceId,
    });

    await db
      .update(users)
      .set({ lastLoginAt: new Date(clock.now()) })
      .where(eq(users.userId, user.userId));

    setSessionCookie(reply, minted.token, minted.expiresAt);

    return {
      session: await sessionInfo(minted.sessionId),
      mfaRequired: user.mfaRequired,
      superseded: minted.superseded,
    };
  });

  // ── POST /auth/logout ──────────────────────────────────────────────────────────────────────

  app.post(
    '/auth/logout',
    { preHandler: requireSession({ allowUnverifiedMfa: true }) },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) throw new AppError('AUTH_REQUIRED', 'Authentication required.');
      await service.revoke(principal.sessionId, 'logout');
      // The displaced socket learns of it from the gateway's own session bookkeeping; there is no
      // session-scoped push on `WsGateway` to call from here (see the notes for the integrator).
      void reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.status(204).send();
    },
  );

  // ── GET /auth/session ──────────────────────────────────────────────────────────────────────

  app.get(
    '/auth/session',
    { preHandler: requireSession({ allowUnverifiedMfa: true }) },
    async (request) => {
      const principal = request.principal;
      if (principal === undefined) throw new AppError('AUTH_REQUIRED', 'Authentication required.');
      // `requireSession` has already refreshed `last_seen_at` (API.md §1.3).
      return sessionInfo(principal.sessionId);
    },
  );

  // ── GET /auth/sessions ─────────────────────────────────────────────────────────────────────

  app.get(
    '/auth/sessions',
    { preHandler: requireSession({ allowUnverifiedMfa: true }) },
    async (request) => {
      const principal = request.principal;
      if (principal === undefined) throw new AppError('AUTH_REQUIRED', 'Authentication required.');
      const rows = await service.listFor(principal.userId);
      const items: SessionSummary[] = rows.map((row) => ({
        sessionId: row.sessionId,
        clientKind: row.clientKind,
        deviceId: row.deviceId,
        deviceLabel: row.deviceLabel,
        ip: row.ip,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        current: row.sessionId === principal.sessionId,
      }));
      return { items };
    },
  );

  // ── DELETE /auth/sessions/:sessionId ───────────────────────────────────────────────────────

  const SessionParams = z.object({ sessionId: z.uuid() });

  app.delete(
    '/auth/sessions/:sessionId',
    { preHandler: requireSession({ allowUnverifiedMfa: true }) },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) throw new AppError('AUTH_REQUIRED', 'Authentication required.');
      const params = parseOrThrow(SessionParams, request.params, 'params');

      // Scoped by `user_id`: another person's session id is a 404, never a 403 — the caller must
      // not learn that the row exists (API.md §2, the RLS rule).
      const owned = await db
        .select({ sessionId: sessions.sessionId })
        .from(sessions)
        .where(
          and(
            eq(sessions.sessionId, params.sessionId),
            eq(sessions.userId, principal.userId),
            isNull(sessions.revokedAt),
          ),
        )
        .limit(1);
      if (owned.length === 0) throw new NotFoundError('No such session.');

      await service.revoke(params.sessionId, 'logout');
      if (params.sessionId === principal.sessionId) {
        void reply.clearCookie(SESSION_COOKIE, { path: '/' });
      }
      return reply.status(204).send();
    },
  );

  // ── POST /auth/webauthn/register/options ───────────────────────────────────────────────────

  app.post(
    '/auth/webauthn/register/options',
    { preHandler: requireSession({ allowUnverifiedMfa: true }) },
    async (request): Promise<PublicKeyCredentialCreationOptionsJSON> => {
      const principal = request.principal;
      if (principal === undefined) throw new AppError('AUTH_REQUIRED', 'Authentication required.');
      const rp = relyingParty(app);

      const existing = await db
        .select({ credentialId: userCredentials.credentialId })
        .from(userCredentials)
        .where(
          and(
            eq(userCredentials.userId, principal.userId),
            eq(userCredentials.kind, 'webauthn'),
            isNull(userCredentials.revokedAt),
          ),
        );

      const challenge = putChallenge(`reg:${principal.sessionId}`, principal.userId);
      return registrationOptions({
        userId: principal.userId,
        email: principal.email,
        displayName: principal.displayName,
        challenge,
        rpId: rp.rpId,
        rpName: rp.rpName,
        existing: existing.flatMap((row) => (row.credentialId === null ? [] : [row.credentialId])),
      });
    },
  );

  // ── POST /auth/webauthn/register/verify ────────────────────────────────────────────────────

  app.post(
    '/auth/webauthn/register/verify',
    { preHandler: requireSession({ allowUnverifiedMfa: true }) },
    async (request) => {
      const principal = request.principal;
      if (principal === undefined) throw new AppError('AUTH_REQUIRED', 'Authentication required.');
      const body = parseOrThrow(WebAuthnRegisterVerifyRequest, request.body, 'body');
      const rp = relyingParty(app);

      const held = takeChallenge(`reg:${principal.sessionId}`);
      if (held === undefined) {
        throw new AppError('BAD_REQUEST', 'No live registration challenge for this session.');
      }

      const result = verifyRegistration({
        response: body.credential,
        expectedChallenge: held.challenge,
        rpId: rp.rpId,
        origin: rp.origin,
        requireUserVerification: true,
      });
      if (!result.ok) {
        throw new AppError('BAD_REQUEST', 'WebAuthn registration could not be verified.', {
          details: { reason: result.reason },
        });
      }

      await db.insert(userCredentials).values({
        userId: principal.userId,
        kind: 'webauthn',
        credentialId: Buffer.from(result.credentialId),
        publicKey: Buffer.from(result.publicKey),
        signCount: result.signCount,
        transports: result.transports,
        aaguid: result.aaguid,
        createdAt: new Date(clock.now()),
      });

      return { credentialId: b64u(result.credentialId) };
    },
  );

  // ── POST /auth/webauthn/login/options ──────────────────────────────────────────────────────

  app.post(
    '/auth/webauthn/login/options',
    async (request): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> => {
      // Unauthenticated and it mints state, so it is limited exactly like `POST /auth/login`:
      // without this it is an anonymous way to keep the server's memory climbing.
      rateLimit(request);
      const body = parseOrThrow(WebAuthnLoginOptionsRequest, request.body, 'body');
      rateLimitEmail(body.email);
      const rp = relyingParty(app);

      const found = await db
        .select({ userId: users.userId, status: users.status })
        .from(users)
        .where(sql`lower(${users.email}) = lower(${body.email})`)
        .limit(1);
      // An account that is not active is treated exactly like one that does not exist.
      const user = found[0]?.status === 'active' ? found[0] : undefined;

      // An unknown email gets a real challenge and an empty credential list — the same body shape,
      // the same status and the same work as a known one with no key enrolled (API.md §1.3).
      const allowCredentials: Buffer[] =
        user === undefined
          ? []
          : (
              await db
                .select({ credentialId: userCredentials.credentialId })
                .from(userCredentials)
                .where(
                  and(
                    eq(userCredentials.userId, user.userId),
                    eq(userCredentials.kind, 'webauthn'),
                    isNull(userCredentials.revokedAt),
                  ),
                )
            ).flatMap((row) => (row.credentialId === null ? [] : [row.credentialId]));

      const challengeId = randomUUID();
      const challenge = putChallenge(`login:${challengeId}`, user?.userId ?? null);

      return {
        challengeId,
        options: authenticationOptions({ challenge, rpId: rp.rpId, allowCredentials }),
      };
    },
  );

  // ── POST /auth/webauthn/login/verify ───────────────────────────────────────────────────────

  app.post('/auth/webauthn/login/verify', async (request, reply) => {
    const body = parseOrThrow(WebAuthnLoginVerifyRequest, request.body, 'body');
    const rp = relyingParty(app);

    const held = takeChallenge(`login:${body.challengeId}`);
    if (held === undefined) {
      throw new AppError('AUTH_INVALID_CREDENTIALS', 'This challenge is unknown or has expired.');
    }

    const rawId = Buffer.from(body.credential.rawId, 'base64url');
    const found = await db
      .select({
        credentialPk: userCredentials.credentialPk,
        publicKey: userCredentials.publicKey,
        signCount: userCredentials.signCount,
        userId: users.userId,
        status: users.status,
        mfaRequired: users.mfaRequired,
      })
      .from(userCredentials)
      .innerJoin(users, eq(users.userId, userCredentials.userId))
      .where(
        and(
          eq(userCredentials.credentialId, rawId),
          eq(userCredentials.kind, 'webauthn'),
          isNull(userCredentials.revokedAt),
        ),
      )
      .limit(1);

    const credential = found[0];
    const publicKey = credential?.publicKey ?? null;
    // The challenge was minted for one person: a credential belonging to anyone else, or a
    // credential the registry does not know, is the same failure.
    if (
      credential === undefined ||
      publicKey === null ||
      (held.userId !== null && held.userId !== credential.userId)
    ) {
      throw new AppError('AUTH_INVALID_CREDENTIALS', 'This credential could not be verified.');
    }
    if (credential.status !== 'active') {
      throw new AppError('USER_SUSPENDED', 'This account is not active. Contact your administrator.');
    }

    const result = verifyAuthentication({
      response: body.credential,
      expectedChallenge: held.challenge,
      rpId: rp.rpId,
      origin: rp.origin,
      publicKey,
      storedSignCount: credential.signCount,
      requireUserVerification: true,
    });
    if (!result.ok) {
      throw new AppError('AUTH_INVALID_CREDENTIALS', 'This credential could not be verified.', {
        details: { reason: result.reason },
      });
    }

    await db
      .update(userCredentials)
      .set({ signCount: result.newSignCount, lastUsedAt: new Date(clock.now()) })
      .where(eq(userCredentials.credentialPk, credential.credentialPk));

    // Two ways in: upgrade the password session this browser already holds, or — passwordless —
    // mint one. Either way the session that comes out is `mfa_verified`.
    const existing = await currentPrincipal(request);
    let sessionId: string;
    let superseded: SupersededSession | null = null;

    if (existing !== null && existing.userId === credential.userId && existing.clientKind === 'web') {
      await service.markMfaVerified(existing.sessionId);
      sessionId = existing.sessionId;
    } else {
      const minted = await service.mintWebSession({
        userId: credential.userId,
        deviceId: body.deviceId,
        ...(body.deviceLabel === undefined ? {} : { deviceLabel: body.deviceLabel }),
        ip: request.ip,
        mfaVerified: true,
        traceId: request.traceId,
      });
      setSessionCookie(reply, minted.token, minted.expiresAt);
      sessionId = minted.sessionId;
      superseded = minted.superseded;
    }

    await db
      .update(users)
      .set({ lastLoginAt: new Date(clock.now()) })
      .where(eq(users.userId, credential.userId));

    return {
      session: await sessionInfo(sessionId),
      mfaRequired: credential.mfaRequired,
      superseded,
    };
  });

  /**
   * The cookie session this request already carries, or `null`. Used by the WebAuthn login verify
   * route, which is reachable with and without one.
   */
  async function currentPrincipal(request: FastifyRequest): Promise<Principal | null> {
    const raw = request.cookies?.[SESSION_COOKIE];
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || unsigned.value === null) return null;
    return service.resolveCookie(unsigned.value);
  }

  // ── GET /auth/api-keys ─────────────────────────────────────────────────────────────────────

  app.get('/auth/api-keys', { preHandler: requireSession() }, async (request) => {
    const principal = request.principal;
    if (principal === undefined) throw new AppError('AUTH_REQUIRED', 'Authentication required.');
    // Reading your own key labels is not an escalation, so a bearer principal may do it; what it
    // may NOT do is skip the second factor to get there.
    requireVerifiedMfa(principal);
    const rows = await db
      .select({
        apiKeyId: apiKeys.apiKeyId,
        label: apiKeys.label,
        scopes: apiKeys.scopes,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.userId, principal.userId))
      .orderBy(apiKeys.apiKeyId);

    const items: ApiKeySummary[] = rows.map((row) => ({
      apiKeyId: row.apiKeyId,
      label: row.label,
      scopes: [...row.scopes],
      createdAt: iso(row.createdAt),
      lastUsedAt: row.lastUsedAt === null ? null : iso(row.lastUsedAt),
      revokedAt: row.revokedAt === null ? null : iso(row.revokedAt),
    }));
    return { items };
  });

  // ── POST /auth/api-keys ────────────────────────────────────────────────────────────────────

  app.post('/auth/api-keys', { preHandler: requireSession() }, async (request, reply) => {
    const principal = request.principal;
    if (principal === undefined) throw new AppError('AUTH_REQUIRED', 'Authentication required.');
    const body = parseOrThrow(ApiKeyCreate, request.body ?? {}, 'body');

    // API.md §1.3: this route "requires a web session". Without that check a BEARER principal
    // could mint keys, and `resolveApiKey` always reports `mfaVerified: true`, so for a user whose
    // `mfa_required` is false the MFA gate below never fires either: one leaked narrow key becomes
    // a self-renewing credential that never has to cross the second factor again.
    requireWebSession(principal, 'Minting an API key requires a web session.');
    requireVerifiedMfa(principal);

    if (body.scopes.includes('server') && principal.role !== 'admin') {
      throw new ForbiddenError('The `server` scope may only be minted by an admin.', {
        requiredRole: ['admin'],
      });
    }

    // Defence in depth: a key may never carry a scope its minter does not hold. A web session
    // carries every scope (it IS the person), so this only ever binds a non-web principal — which
    // the check above has already refused — and a future caller that forgets it.
    const over = body.scopes.filter((scope) => !holdsScope(principal, scope));
    if (over.length > 0) {
      throw new ForbiddenError('A key cannot carry a scope you do not hold.', {
        requiredScope: over,
      });
    }

    const minted = await mintApiKey(db, clock, {
      userId: principal.userId,
      label: body.label,
      scopes: body.scopes,
    });

    const rows = await db
      .select({
        apiKeyId: apiKeys.apiKeyId,
        label: apiKeys.label,
        scopes: apiKeys.scopes,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.apiKeyId, minted.apiKeyId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new AppError('INTERNAL', 'Minted key did not read back.');

    void reply.status(201);
    return {
      apiKeyId: row.apiKeyId,
      label: row.label,
      scopes: [...row.scopes],
      createdAt: iso(row.createdAt),
      lastUsedAt: row.lastUsedAt === null ? null : iso(row.lastUsedAt),
      revokedAt: row.revokedAt === null ? null : iso(row.revokedAt),
      // The one and only time these bytes are readable (API.md §1.2 `ApiKeyCreated`).
      secret: minted.secret,
    };
  });

  // ── DELETE /auth/api-keys/:apiKeyId ────────────────────────────────────────────────────────

  const ApiKeyParams = z.object({ apiKeyId: z.coerce.number().int() });

  app.delete('/auth/api-keys/:apiKeyId', { preHandler: requireSession() }, async (request, reply) => {
    const principal = request.principal;
    if (principal === undefined) throw new AppError('AUTH_REQUIRED', 'Authentication required.');
    // Revoking is as sensitive as minting: a stolen key must not be able to disable the others.
    requireWebSession(principal, 'Revoking an API key requires a web session.');
    requireVerifiedMfa(principal);
    const params = parseOrThrow(ApiKeyParams, request.params, 'params');

    const owned = await db
      .select({ apiKeyId: apiKeys.apiKeyId })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.apiKeyId, params.apiKeyId),
          eq(apiKeys.userId, principal.userId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .limit(1);
    if (owned.length === 0) throw new NotFoundError('No such API key.');

    await revokeApiKey(db, clock, params.apiKeyId, principal.userId);
    return reply.status(204).send();
  });

  await Promise.resolve();
};

export default authRoutes;
