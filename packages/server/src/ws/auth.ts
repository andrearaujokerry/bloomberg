/**
 * `ws/auth.ts` — who is on the other end of the socket (SEC-01, SEC-03; API.md §6.3 step 1).
 *
 * The gateway authenticates a socket in one of two ways and never a third:
 *
 *  - **cookie on the upgrade** — the signed `tsid` session cookie the browser already holds. A
 *    valid cookie is a `web` principal, and the four panels of one terminal share that one socket
 *    (TERM-04).
 *  - **bearer in `hello.token`** — an API client that cannot set a cookie. It is an `api`
 *    principal, which is a different `usage` in the entitlement evaluator (`'api'`, not
 *    `'display'`) and a different subscription limit (2 000, not 10 000).
 *
 * Both resolve through {@link dbAuthenticator}: `sessions.token_hash = sha256(token)`, the row not
 * revoked and not expired, joined to `users` for the firm and the role. The token itself is never
 * stored and never logged; only its digest crosses this module.
 *
 * {@link WsAuthenticator} is a **port**. WP-07 owns login, refresh and the session lifecycle; until
 * it lands the gateway needs exactly one question answered — "whose session is this token?" — and a
 * port is how that question is asked without WP-06 growing an auth subsystem it does not own. A
 * test passes its own implementation; production passes `dbAuthenticator(app.deps.db, clock)`.
 */

import { createHash } from 'node:crypto';

import { and, eq, gt, isNull } from 'drizzle-orm';

import type { Clock } from '@terminal/core';

import type { Db, Tx } from '../db/client.js';
import { sessions, users } from '../db/schema/users.js';

/** The identity every frame of a session is attributed to. */
export interface WsPrincipal {
  userId: number;
  firmId: number;
  /** `sessions.session_id` (uuid) — the key a second socket supersedes on (API.md §6.3 step 1). */
  sessionId: string;
  clientKind: 'web' | 'api';
  /** `users.role` — the RLS identity a later query would run under. */
  role: string;
}

/** What the gateway found on the wire: a cookie from the upgrade, a token from `hello`, or both. */
export interface WsAuthInput {
  /** The unsigned value of the `tsid` cookie. */
  cookieToken?: string;
  /** `hello.token`, or an `Authorization: Bearer` header on the upgrade. */
  bearerToken?: string;
}

export interface WsAuthenticator {
  /** The principal, or `null` when nothing on the wire identifies a live session. */
  authenticate(input: WsAuthInput): Promise<WsPrincipal | null>;
}

/** `digest(token, 'sha256')` — the `bytea` stored in `sessions.token_hash`. */
export function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * The production authenticator over the `sessions` table.
 *
 * A cookie is only ever a `web` session and a bearer token only ever an `api` session: the two
 * `client_kind` values are different entitlement usages (ENTL-02), so accepting a web session's
 * token as a bearer would silently upgrade an API caller's licence position. The cookie is tried
 * first, because a browser that also sends a token is still a browser.
 */
export function dbAuthenticator(db: Db | Tx, clock: Clock): WsAuthenticator {
  async function lookup(token: string, kind: 'web' | 'api'): Promise<WsPrincipal | null> {
    if (token.length === 0) return null;
    const rows = await db
      .select({
        sessionId: sessions.sessionId,
        clientKind: sessions.clientKind,
        userId: users.userId,
        firmId: users.firmId,
        role: users.role,
        status: users.status,
      })
      .from(sessions)
      .innerJoin(users, eq(users.userId, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date(clock.now())),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;
    if (row.clientKind !== kind) return null;
    if (row.status !== 'active') return null;
    return {
      userId: row.userId,
      firmId: row.firmId,
      sessionId: row.sessionId,
      clientKind: kind,
      role: row.role,
    };
  }

  return {
    async authenticate(input: WsAuthInput): Promise<WsPrincipal | null> {
      if (input.cookieToken !== undefined) {
        const web = await lookup(input.cookieToken, 'web');
        if (web !== null) return web;
      }
      if (input.bearerToken !== undefined) return lookup(input.bearerToken, 'api');
      return null;
    },
  };
}
