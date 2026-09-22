/**
 * `http/auth/apikeys.ts` — bearer keys bound to a natural person (API-01, ENTL-03; API.md §1.1
 * "API keys", §1.3 `/auth/api-keys`).
 *
 * A key is `tk_` + 32 random bytes base64url. Like a session token it exists in clear exactly once,
 * in the `ApiKeyCreated.secret` of the response that mints it; `api_keys.key_hash` holds only
 * `digest(key,'sha256')`.
 *
 * **The key is both the credential and the session token.** The first use creates the
 * `client_kind='api'` session row (24 h sliding, `api_key_id` set) whose `token_hash` is that same
 * digest. That is what makes one bearer value work across all three surfaces: an HTTP request
 * through `requireSession`, a WebSocket `hello.token` resolved by `ws/auth.ts#dbAuthenticator`
 * (which looks up `sessions.token_hash` for `client_kind='api'`), and the quota counters of §8,
 * which are keyed on the session. There is no second secret to mint, store or leak.
 *
 * A key carries `scopes` (`data:read`, `fn:run`, `ws:subscribe`, `server`). Scope is enforced at the
 * point of use, never here: `requireSession({ scopes })` on the HTTP routes that need one (the
 * `/usage` reads ask for `data:read`), and `ws/session.ts`'s `sub` handler, which refuses a frame
 * from a key that does not carry `ws:subscribe`. `fn:run` is checked by the function routes, which
 * WP-08 owns and which do not exist yet — so today a key without `fn:run` is refused nowhere,
 * because there is nothing to refuse it from.
 *
 * Nothing in the data path infers a scope it was not given, and `resolveApiKey` never widens one.
 */

import { randomBytes } from 'node:crypto';

import type { Clock } from '@terminal/core';
import type { Role } from '@terminal/sdk/wire/rest/auth';
import { and, eq, isNull } from 'drizzle-orm';

import type { Db, Tx } from '../../db/client.js';
import { apiKeys, sessions, users } from '../../db/schema/index.js';
import { tokenHash } from '../../ws/auth.js';
import { AppError } from '../errors.js';
import { API_SLIDING_MS, DEFAULT_SCOPES, type Principal } from './session.js';

/** The prefix every bearer key carries, so a token can be told apart from a session cookie value. */
export const API_KEY_PREFIX = 'tk_';

export interface MintApiKeyInput {
  userId: number;
  label: string;
  scopes: readonly string[];
}

export interface MintedApiKey {
  apiKeyId: number;
  /** `tk_…` — shown exactly once (API.md §1.2 `ApiKeyCreated`). */
  secret: string;
}

/**
 * Mint a key for `userId`. An empty `scopes` list means "the defaults" (`Rest.Auth.ApiKeyCreate`
 * defaults to `data:read`, `fn:run`, `ws:subscribe`); nothing here ever adds `server`, which the
 * route grants only to an admin.
 */
export async function mintApiKey(
  db: Db | Tx,
  clock: Clock,
  input: MintApiKeyInput,
): Promise<MintedApiKey> {
  const secret = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const scopes = input.scopes.length > 0 ? [...input.scopes] : [...DEFAULT_SCOPES];
  const inserted = await db
    .insert(apiKeys)
    .values({
      userId: input.userId,
      keyHash: tokenHash(secret),
      label: input.label,
      scopes,
      createdAt: new Date(clock.now()),
    })
    .returning({ apiKeyId: apiKeys.apiKeyId });

  const apiKeyId = inserted[0]?.apiKeyId;
  if (apiKeyId === undefined) throw new AppError('INTERNAL', 'API key insert returned no row.');
  return { apiKeyId, secret };
}

/**
 * Resolve a bearer key to a principal, creating or refreshing its `client_kind='api'` session.
 *
 * `null` for anything that is not a live key of an active user: unknown, revoked, or belonging to a
 * suspended or deprovisioned person. The caller cannot tell which, and never learns whether the
 * prefix or the bytes were wrong.
 *
 * The session row is an upsert on `sessions.token_hash`, so a key that has been idle for more than
 * 24 h resumes on the same `session_id` rather than accumulating a row per use.
 *
 * **A revoked api session is terminal.** The upsert refreshes `last_seen_at` and `expires_at` and
 * nothing else — it must never clear `revoked_at`, or the next bearer request would undo the
 * `DELETE /auth/sessions/:sessionId` the user just issued (API.md §1.3) and that route would
 * silently not work for api sessions. Since the session's `token_hash` IS the key's digest, there
 * is no second row to create: ending the session ends the key, and a new one has to be minted.
 */
export async function resolveApiKey(
  db: Db | Tx,
  clock: Clock,
  secret: string,
): Promise<Principal | null> {
  if (!secret.startsWith(API_KEY_PREFIX)) return null;
  const hash = tokenHash(secret);

  const rows = await db
    .select({
      apiKeyId: apiKeys.apiKeyId,
      scopes: apiKeys.scopes,
      keyRevokedAt: apiKeys.revokedAt,
      userId: users.userId,
      firmId: users.firmId,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
      mfaRequired: users.mfaRequired,
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.userId, apiKeys.userId))
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  if (row.keyRevokedAt !== null) return null;
  if (row.status !== 'active') return null;

  const nowMs = clock.now();
  const now = new Date(nowMs);
  const upserted = await db
    .insert(sessions)
    .values({
      userId: row.userId,
      tokenHash: hash,
      clientKind: 'api',
      apiKeyId: row.apiKeyId,
      // The key was minted from a session that had already satisfied `mfa_required`, and the key
      // itself is the credential from then on — a bearer client has no way to present a second
      // factor. Marking the session verified is what keeps `requireSession`'s MFA rule uniform
      // instead of carving out an exception for `client_kind='api'`.
      mfaVerified: true,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(nowMs + API_SLIDING_MS),
    })
    .onConflictDoUpdate({
      target: sessions.tokenHash,
      set: { lastSeenAt: now, expiresAt: new Date(nowMs + API_SLIDING_MS) },
    })
    .returning({ sessionId: sessions.sessionId, revokedAt: sessions.revokedAt });

  const session = upserted[0];
  if (session === undefined) throw new AppError('INTERNAL', 'API session upsert returned no row.');
  // Read back from the row the statement actually wrote, so a revoke that landed between the
  // SELECT above and this INSERT is still seen. The caller gets the same `null` as an unknown key.
  if (session.revokedAt !== null) return null;
  const sessionId = session.sessionId;

  await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.apiKeyId, row.apiKeyId));

  return {
    userId: row.userId,
    firmId: row.firmId,
    sessionId,
    email: row.email,
    displayName: row.displayName,
    role: row.role as Role,
    clientKind: 'api',
    mfaRequired: row.mfaRequired,
    mfaVerified: true,
    scopes: row.scopes,
  };
}

/**
 * Revoke a key the user owns, and with it the bearer session it minted (`revoke_reason='admin'`,
 * API.md §1.3 `DELETE /auth/api-keys/:apiKeyId`). Scoped by `user_id`: one person can never revoke
 * another's key by guessing an id.
 */
export async function revokeApiKey(
  db: Db | Tx,
  clock: Clock,
  apiKeyId: number,
  userId: number,
): Promise<void> {
  const now = new Date(clock.now());
  await db
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(
      and(eq(apiKeys.apiKeyId, apiKeyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)),
    );
  await db
    .update(sessions)
    .set({ revokedAt: now, revokeReason: 'admin' })
    .where(
      and(
        eq(sessions.apiKeyId, apiKeyId),
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
      ),
    );
}
