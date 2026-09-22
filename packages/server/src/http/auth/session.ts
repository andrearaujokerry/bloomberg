/**
 * `http/auth/session.ts` — cookie sessions, the `sessions` lifecycle and the guard every
 * protected route hangs off (API.md §1.1 L48-70, ARCHITECTURE §10 rule 7, SEC-01/SEC-03/ENTL-03).
 *
 * Four invariants this module exists to hold:
 *
 *  1. **The token is a secret the server cannot read back.** `mintWebSession` returns 32 random
 *     bytes, base64url, exactly once; the database sees only `digest(token,'sha256')` in
 *     `sessions.token_hash` (the same bytes `ws/auth.ts#tokenHash` computes, which is why the WS
 *     gateway and the HTTP guard resolve the identical row). No column, log line or error message
 *     ever carries the clear token.
 *  2. **Resolution is one indexed lookup and one answer.** Expired, revoked, unknown, wrong
 *     `client_kind`, suspended user and revoked API key all return `null` from the same code path:
 *     a caller learns "no session", never *which* of those it was.
 *  3. **One active web session per natural person** (SEC-03). The partial unique index
 *     `sessions_one_active_web` is satisfied, not raced: concurrent logins for one person are
 *     serialised by `pg_advisory_xact_lock` FIRST — a row lock cannot do it, because under READ
 *     COMMITTED the loser's `WHERE revoked_at IS NULL` re-check finds the just-revoked incumbent no
 *     longer matching and reports no incumbent at all, and because there is no row to lock on a
 *     first login — and only then is the incumbent read `FOR UPDATE`, revoked with
 *     `revoke_reason='superseded'`, its `superseded_count` incremented and the new row inserted,
 *     all inside one transaction. The displaced session is returned so the
 *     login route can report it (`LoginResponse.superseded`) and an `access_log` row with
 *     `decision='deny', reason='CONCURRENT_SESSION', purpose='auth.login'` records the event
 *     (ARCHITECTURE §10 rule 7).
 *  4. **Every instant comes from the injected `Clock`.** Sliding 12 h on `last_seen_at`, absolute
 *     7 d on `expires_at` for a web session; 24 h sliding for an API session. A `VirtualClock` in
 *     a test therefore moves expiry exactly as wall-clock time would.
 *
 * `requireSession` is the Fastify `preHandler` that turns a cookie or a bearer token into
 * `request.principal`, applies the CSRF rule (cookie-authenticated mutations must carry
 * `x-requested-with: terminal`; bearer is exempt), the MFA rule (`users.mfa_required` and a session
 * that is not `mfa_verified` may only call `/auth/*`), and the role/scope checks.
 */

import { randomBytes } from 'node:crypto';

import type { Clock, FieldClass, FieldId, ReasonCode, Tier, UsageType } from '@terminal/core';
import type { Role } from '@terminal/sdk/wire/rest/auth';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Db, Tx } from '../../db/client.js';
import { accessLog, apiKeys, sessions, users } from '../../db/schema/index.js';
import { tokenHash } from '../../ws/auth.js';
import { AppError, AuthRequiredError, ForbiddenError } from '../errors.js';
import { resolveApiKey } from './apikeys.js';

/** The session cookie the browser presents (API.md §1.1 "Session token (web)"). */
export const SESSION_COOKIE = 'tsid';

/** Sliding window on `sessions.last_seen_at` for a web session — 12 h (API.md §1.1). */
export const WEB_SLIDING_MS = 12 * 60 * 60 * 1_000;

/** Absolute lifetime of a web session — 7 d, never extended by activity (API.md §1.1). */
export const WEB_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1_000;

/** Sliding lifetime of an API session — 24 h from its last use (API.md §1.1 "API keys"). */
export const API_SLIDING_MS = 24 * 60 * 60 * 1_000;

/** `Rest.Auth.ApiKeyCreate`'s default scopes; also what a web session carries. */
export const DEFAULT_SCOPES: readonly string[] = ['data:read', 'fn:run', 'ws:subscribe'];

/** Methods that never need the CSRF header (API.md §1.1 "CSRF"). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The header a cookie-authenticated mutation must carry. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'terminal';

/** `sessions.revoke_reason` — the CHECK of migration 0011. */
export type RevokeReason = 'logout' | 'superseded' | 'expired' | 'admin' | 'deprovisioned';

/** Who is making this request. Decorated onto `FastifyRequest` by {@link requireSession}. */
export interface Principal {
  userId: number;
  firmId: number;
  /** `sessions.session_id` — the id the access log, the WS gateway and RLS all key on. */
  sessionId: string;
  email: string;
  displayName: string;
  role: Role;
  clientKind: 'web' | 'api';
  /** `users.mfa_required`. */
  mfaRequired: boolean;
  /** `sessions.mfa_verified`. */
  mfaVerified: boolean;
  /** The API key's scopes for a bearer session; {@link DEFAULT_SCOPES} for a web session. */
  scopes: readonly string[];
}

/** The web session a new login displaced — `Rest.Auth.LoginResponse.superseded` (API.md L104). */
export interface SupersededSession {
  sessionId: string;
  deviceId: string | null;
  deviceLabel: string | null;
  lastSeenAt: string;
}

/** A row of `GET /auth/sessions` — `Rest.Auth.SessionSummary` minus `current`, which the route sets. */
export interface SessionSummaryRow {
  sessionId: string;
  clientKind: 'web' | 'api';
  deviceId: string | null;
  deviceLabel: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
}

/**
 * The `entitlements/accessLog.ts` row this module writes for a supersede (ARCHITECTURE §10 rule 7).
 * Declared structurally rather than imported so that session minting does not depend on the
 * batched writer being constructed — an `AccessLog` satisfies it as-is.
 */
export interface SessionAccessLogRow {
  ts: number;
  userId: number;
  firmId: number;
  sessionId: string;
  instrumentId: number | null;
  fieldId: FieldId;
  fieldClass: FieldClass;
  sourceId: string;
  requestedTier: Tier;
  tier: Tier | null;
  usage: UsageType;
  purpose: string;
  decision: 'allow' | 'downgrade' | 'deny';
  reason: ReasonCode;
  traceId: string;
  details?: Record<string, unknown>;
}

/** The single method of `entitlements/accessLog.ts#AccessLog` that this module uses. */
export interface SessionAccessLog {
  append(row: SessionAccessLogRow): number;
}

export interface MintWebSessionInput {
  userId: number;
  deviceId: string;
  deviceLabel?: string;
  ip?: string;
  userAgent?: string;
  mfaVerified: boolean;
  /** Correlation id of the login request, carried into the supersede `access_log` row. */
  traceId?: string;
}

export interface MintedSession {
  /** The clear token. It exists here and nowhere else — hand it to `Set-Cookie` and drop it. */
  token: string;
  sessionId: string;
  expiresAt: string;
  superseded: SupersededSession | null;
}

export interface SessionService {
  mintWebSession(input: MintWebSessionInput): Promise<MintedSession>;
  resolveCookie(token: string): Promise<Principal | null>;
  resolveBearer(token: string): Promise<Principal | null>;
  revoke(sessionId: string, reason: RevokeReason): Promise<void>;
  touch(sessionId: string): Promise<void>;
  listFor(userId: number): Promise<SessionSummaryRow[]>;
  markMfaVerified(sessionId: string): Promise<void>;
}

export interface SessionServiceDeps {
  db: Db | Tx;
  clock: Clock;
  /**
   * Optional batched access log. When present the supersede event is appended to it (never on the
   * request path); when absent the row is inserted directly inside the supersede transaction, so
   * the audit row exists either way.
   */
  log?: SessionAccessLog;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** 32 random bytes, base64url — the opaque session token of API.md §1.1. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Run `fn` in a transaction. When `db` is already the caller's transaction (a request handler, or
 * the test harness's held-open transaction) drizzle issues `SAVEPOINT`, so the supersede is still
 * atomic with respect to its own failure without opening a second connection.
 */
async function inTx<T>(db: Db | Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

/** The `access_log` shape of a superseded session — one place, two writers. */
function supersedeLogRow(input: {
  nowMs: number;
  userId: number;
  firmId: number;
  supersededSessionId: string;
  newSessionId: string;
  deviceId: string;
  traceId: string;
}): SessionAccessLogRow {
  return {
    ts: input.nowMs,
    userId: input.userId,
    firmId: input.firmId,
    // The session the decision is *about*: the one being taken away (ARCHITECTURE §10 rule 7).
    sessionId: input.supersededSessionId,
    instrumentId: null,
    // `access_log.field_id` is `text NOT NULL`; an auth event has no field, so it carries the
    // sentinel the declaration query filters out (`field_class='reference'`, `source_id='internal'`
    // never appear in `licence_registry`, so no declaration can count these rows as data usage).
    fieldId: 'SESSION',
    fieldClass: 'reference',
    sourceId: 'internal',
    requestedTier: 'eod',
    tier: null,
    usage: 'display',
    purpose: 'auth.login',
    decision: 'deny',
    reason: 'CONCURRENT_SESSION',
    traceId: input.traceId,
    details: {
      supersededSessionId: input.supersededSessionId,
      newSessionId: input.newSessionId,
      deviceId: input.deviceId,
    },
  };
}

/** The trace id used when a caller supplies none — a zero uuid, never a random one in a log row. */
const NO_TRACE = '00000000-0000-0000-0000-000000000000';

/**
 * Cookie attributes for `tsid` (API.md §1.1): `HttpOnly; SameSite=Strict; Path=/; Secure`.
 *
 * `secure` is a parameter rather than a read of `NODE_ENV`: `config.ts` is the only module allowed
 * to touch `process.env`, and its schema has no environment flag, so the caller (the login route)
 * decides — the default is the safe one.
 */
export function sessionCookieOptions(
  options: { secure?: boolean; expiresAt?: string } = {},
): CookieSerializeOptions {
  const base: CookieSerializeOptions = {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: options.secure ?? true,
    signed: true,
  };
  if (options.expiresAt === undefined) return base;
  return { ...base, expires: new Date(options.expiresAt) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The columns every resolution reads — one indexed lookup on `sessions.token_hash`. */
const RESOLVE_COLUMNS = {
  sessionId: sessions.sessionId,
  clientKind: sessions.clientKind,
  apiKeyId: sessions.apiKeyId,
  mfaVerified: sessions.mfaVerified,
  lastSeenAt: sessions.lastSeenAt,
  expiresAt: sessions.expiresAt,
  revokedAt: sessions.revokedAt,
  userId: users.userId,
  firmId: users.firmId,
  email: users.email,
  displayName: users.displayName,
  role: users.role,
  status: users.status,
  mfaRequired: users.mfaRequired,
  keyScopes: apiKeys.scopes,
  keyRevokedAt: apiKeys.revokedAt,
} as const;

export function sessionService(deps: SessionServiceDeps): SessionService {
  const { db, clock } = deps;

  /**
   * Resolve a token to a principal, or to `null`. Every rejection path — unknown hash, wrong
   * `client_kind`, revoked, past `expires_at`, idle past the sliding window, suspended user,
   * revoked API key — returns the same `null` after the same single query.
   */
  async function resolve(token: string, kind: 'web' | 'api'): Promise<Principal | null> {
    if (token.length === 0) return null;
    const nowMs = clock.now();
    const rows = await db
      .select(RESOLVE_COLUMNS)
      .from(sessions)
      .innerJoin(users, eq(users.userId, sessions.userId))
      .leftJoin(apiKeys, eq(apiKeys.apiKeyId, sessions.apiKeyId))
      .where(eq(sessions.tokenHash, tokenHash(token)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;
    if (row.clientKind !== kind) return null;
    if (row.revokedAt !== null) return null;
    if (row.expiresAt.getTime() <= nowMs) return null;
    if (row.status !== 'active') return null;
    // Sliding idle window. The absolute cap is `expires_at`, already checked above.
    const idleLimitMs = kind === 'web' ? WEB_SLIDING_MS : API_SLIDING_MS;
    if (nowMs - row.lastSeenAt.getTime() >= idleLimitMs) return null;
    // A bearer session outlives neither its key nor the key's revocation.
    if (kind === 'api' && (row.apiKeyId === null || row.keyRevokedAt !== null)) return null;

    return {
      userId: row.userId,
      firmId: row.firmId,
      sessionId: row.sessionId,
      email: row.email,
      displayName: row.displayName,
      role: row.role as Role,
      clientKind: kind,
      mfaRequired: row.mfaRequired,
      mfaVerified: row.mfaVerified,
      scopes: kind === 'api' ? (row.keyScopes ?? DEFAULT_SCOPES) : DEFAULT_SCOPES,
    };
  }

  return {
    async mintWebSession(input: MintWebSessionInput): Promise<MintedSession> {
      const nowMs = clock.now();
      const now = new Date(nowMs);
      const expiresAt = new Date(nowMs + WEB_ABSOLUTE_MS);
      const token = newSessionToken();
      const hash = tokenHash(token);
      // `sessions` has no `device_label` column (migration 0011), so the client's own label is what
      // `user_agent` carries when it sends one; the raw UA header is the fallback.
      const label = input.deviceLabel ?? input.userAgent ?? null;

      return inTx(db, async (tx) => {
        // Serialise per PERSON before reading anything.
        //
        // `SELECT ... FOR UPDATE WHERE revoked_at IS NULL` is not enough on its own. Under READ
        // COMMITTED the loser of a race blocks on the incumbent's row, and when the winner commits
        // EvalPlanQual re-checks the predicate against the NEW version — which now has
        // `revoked_at` set. The row no longer matches, so the loser is handed nothing, concludes
        // there is no incumbent, inserts, and violates `sessions_one_active_web`. (Measured: three
        // simultaneous logins returned 500, 200, 500.) It also locks nothing at all when the
        // person has no session yet, which is the two-first-logins case.
        //
        // An advisory transaction lock has neither problem: it exists whether or not a row does,
        // and it is released at commit. `hashtextextended` with a fixed seed keeps the key stable
        // across servers, and the `session:` prefix keeps it out of any other lock namespace.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended('session:' || ${input.userId}::text, 0))`,
        );

        // Now the incumbent, still `FOR UPDATE`: the advisory lock orders the logins, and the row
        // lock keeps an unrelated writer (a `touch`, a revoke) out of the supersede.
        const incumbent = await tx
          .select({
            sessionId: sessions.sessionId,
            deviceId: sessions.deviceId,
            userAgent: sessions.userAgent,
            lastSeenAt: sessions.lastSeenAt,
            supersededCount: sessions.supersededCount,
          })
          .from(sessions)
          .where(
            and(
              eq(sessions.userId, input.userId),
              eq(sessions.clientKind, 'web'),
              isNull(sessions.revokedAt),
            ),
          )
          .for('update')
          .limit(1);

        const prev = incumbent[0];
        let superseded: SupersededSession | null = null;
        // The chain count the DDL comment describes: how many logins displaced this row's
        // predecessors. The displaced row records its own displacement at the same value.
        let chain = 0;

        if (prev !== undefined) {
          chain = prev.supersededCount + 1;
          await tx
            .update(sessions)
            .set({ revokedAt: now, revokeReason: 'superseded', supersededCount: chain })
            .where(eq(sessions.sessionId, prev.sessionId));
          superseded = {
            sessionId: prev.sessionId,
            deviceId: prev.deviceId,
            deviceLabel: prev.userAgent,
            lastSeenAt: prev.lastSeenAt.toISOString(),
          };
        }

        const insertValues = {
          userId: input.userId,
          tokenHash: hash,
          clientKind: 'web',
          deviceId: input.deviceId,
          userAgent: label,
          mfaVerified: input.mfaVerified,
          createdAt: now,
          lastSeenAt: now,
          expiresAt,
          supersededCount: chain,
          ...(input.ip === undefined ? {} : { ip: input.ip }),
        };
        const inserted = await tx
          .insert(sessions)
          .values(insertValues)
          .returning({ sessionId: sessions.sessionId });
        const sessionId = inserted[0]?.sessionId;
        if (sessionId === undefined) {
          throw new AppError('INTERNAL', 'Session insert returned no row.');
        }

        if (superseded !== null) {
          const owner = await tx
            .select({ firmId: users.firmId })
            .from(users)
            .where(eq(users.userId, input.userId))
            .limit(1);
          const row = supersedeLogRow({
            nowMs,
            userId: input.userId,
            firmId: owner[0]?.firmId ?? 0,
            supersededSessionId: superseded.sessionId,
            newSessionId: sessionId,
            deviceId: input.deviceId,
            traceId: input.traceId ?? NO_TRACE,
          });
          if (deps.log !== undefined) {
            // Batched writer: never awaits a database round trip on the login path.
            deps.log.append(row);
          } else {
            await tx.insert(accessLog).values({
              ts: new Date(row.ts),
              userId: row.userId,
              firmId: row.firmId,
              sessionId: row.sessionId,
              instrumentId: row.instrumentId,
              fieldId: row.fieldId,
              fieldClass: row.fieldClass,
              sourceId: row.sourceId,
              requestedTier: row.requestedTier,
              tier: row.tier,
              usage: row.usage,
              purpose: row.purpose,
              decision: row.decision,
              reason: row.reason,
              traceId: row.traceId,
              details: row.details ?? null,
            });
          }
        }

        return { token, sessionId, expiresAt: expiresAt.toISOString(), superseded };
      });
    },

    resolveCookie(token: string): Promise<Principal | null> {
      return resolve(token, 'web');
    },

    resolveBearer(token: string): Promise<Principal | null> {
      return resolve(token, 'api');
    },

    async revoke(sessionId: string, reason: RevokeReason): Promise<void> {
      await db
        .update(sessions)
        .set({ revokedAt: new Date(clock.now()), revokeReason: reason })
        .where(and(eq(sessions.sessionId, sessionId), isNull(sessions.revokedAt)));
    },

    async touch(sessionId: string): Promise<void> {
      const nowMs = clock.now();
      const apiExpiry = new Date(nowMs + API_SLIDING_MS).toISOString();
      await db
        .update(sessions)
        .set({
          lastSeenAt: new Date(nowMs),
          // A web session's absolute 7 d is never extended; an API session slides 24 h per use.
          expiresAt: sql`CASE WHEN ${sessions.clientKind} = 'api'
                             THEN ${apiExpiry}::timestamptz
                             ELSE ${sessions.expiresAt} END`,
        })
        .where(and(eq(sessions.sessionId, sessionId), isNull(sessions.revokedAt)));
    },

    async listFor(userId: number): Promise<SessionSummaryRow[]> {
      const rows = await db
        .select({
          sessionId: sessions.sessionId,
          clientKind: sessions.clientKind,
          deviceId: sessions.deviceId,
          userAgent: sessions.userAgent,
          ip: sessions.ip,
          createdAt: sessions.createdAt,
          lastSeenAt: sessions.lastSeenAt,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, new Date(clock.now())),
          ),
        )
        .orderBy(desc(sessions.createdAt));
      return rows.map((row) => ({
        sessionId: row.sessionId,
        clientKind: row.clientKind as 'web' | 'api',
        deviceId: row.deviceId,
        deviceLabel: row.userAgent,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
      }));
    },

    async markMfaVerified(sessionId: string): Promise<void> {
      await db
        .update(sessions)
        .set({ mfaVerified: true, lastSeenAt: new Date(clock.now()) })
        .where(and(eq(sessions.sessionId, sessionId), isNull(sessions.revokedAt)));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The guard
// ─────────────────────────────────────────────────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by {@link requireSession}; absent on an unauthenticated route. */
    principal?: Principal;
  }
}

export interface GuardOptions {
  /** Allowed `users.role` values; any role passes when omitted. */
  roles?: readonly Role[];
  /** Scopes the principal must hold (bearer keys; a web session holds {@link DEFAULT_SCOPES}). */
  scopes?: readonly string[];
  /** Let a session that has not completed MFA through — only `/auth/*` needs this. */
  allowUnverifiedMfa?: boolean;
}

export type SessionGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** `/auth/*` — reachable before MFA is verified (API.md §1.1 "WebAuthn"). */
function isAuthRoute(request: FastifyRequest): boolean {
  const path = (request.routeOptions?.url ?? request.url).split('?')[0] ?? '';
  return /^(\/api\/v1)?\/auth(\/|$)/.test(path);
}

/** The bearer token of an `Authorization` header, or `undefined`. */
function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

/**
 * The `preHandler` every protected route uses. Resolves a cookie or bearer session, applies CSRF,
 * MFA, role and scope, and decorates `request.principal`.
 *
 * The service comes from `app.deps.sessions` when the process wires one (an optional `AppDeps`
 * field, which is the only kind of change `app.ts` accepts), and is otherwise built per request
 * from the same `db` and `clock` — a closure over two references, not a connection.
 */
export function requireSession(options: GuardOptions = {}): SessionGuard {
  return async function requireSessionGuard(request: FastifyRequest): Promise<void> {
    const deps = request.server.deps as {
      db: Db;
      clock: Clock;
      sessions?: SessionService;
    };
    const service = deps.sessions ?? sessionService({ db: deps.db, clock: deps.clock });

    const bearer = bearerToken(request);
    let principal: Principal | null = null;
    let viaCookie = false;

    if (bearer !== undefined) {
      // `tk_…` is an API key (API-01): its first use mints the `client_kind='api'` session.
      principal = bearer.startsWith('tk_')
        ? await resolveApiKey(deps.db, deps.clock, bearer)
        : await service.resolveBearer(bearer);
    } else {
      const raw = request.cookies?.[SESSION_COOKIE];
      if (typeof raw === 'string' && raw.length > 0) {
        const unsigned = request.unsignCookie(raw);
        if (unsigned.valid && unsigned.value !== null) {
          principal = await service.resolveCookie(unsigned.value);
          viaCookie = principal !== null;
        }
      }
    }

    if (principal === null) throw new AuthRequiredError();

    // CSRF (API.md §1.1): cookie-authenticated mutations must be made by the terminal client.
    // Bearer requests cannot be made by a browser's ambient credentials and are exempt.
    if (viaCookie && !SAFE_METHODS.has(request.method.toUpperCase())) {
      const header = request.headers[CSRF_HEADER];
      if (header !== CSRF_HEADER_VALUE) {
        throw new AppError(
          'CSRF_REJECTED',
          `A cookie-authenticated ${request.method} must carry ${CSRF_HEADER}: ${CSRF_HEADER_VALUE}.`,
        );
      }
    }

    // MFA: an unverified session may only reach `/auth/*` until WebAuthn succeeds.
    if (
      principal.mfaRequired &&
      !principal.mfaVerified &&
      options.allowUnverifiedMfa !== true &&
      !isAuthRoute(request)
    ) {
      throw new AppError('MFA_REQUIRED', 'Multi-factor authentication is required.');
    }

    if (options.roles !== undefined && !options.roles.includes(principal.role)) {
      throw new ForbiddenError('Your role may not use this route.', {
        requiredRole: [...options.roles],
      });
    }

    if (options.scopes !== undefined) {
      const missing = options.scopes.filter((scope) => !principal.scopes.includes(scope));
      if (missing.length > 0) {
        throw new ForbiddenError('This key does not carry the required scope.', {
          requiredScope: missing,
        });
      }
    }

    request.principal = principal;
    // Sliding expiry: activity refreshes `last_seen_at` (and an API session's 24 h window).
    await service.touch(principal.sessionId);
  };
}
