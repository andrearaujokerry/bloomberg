/**
 * `http/auth/password.ts` — the dev-mode credential of API.md §1.1 ("Dev-mode login (shipped)").
 *
 * The hash is pgcrypto's `crypt(password, gen_salt('bf', 12))` in `user_credentials.secret_hash`
 * (`kind='password'`), and verification is `crypt(password, secret_hash) = secret_hash` **inside
 * the database**. That is deliberate and is the whole point of this module:
 *
 *  - the comparison never happens in JavaScript, so there is no place to get a timing-unsafe
 *    `===` wrong and no copy of a hash in the process heap to leak in a core dump;
 *  - bcrypt's own constant-time comparison and its cost-12 work factor are applied by pgcrypto;
 *  - the password crosses this module as a bound parameter and is never interpolated into SQL,
 *    never logged, and never returned.
 *
 * An unknown user, a user with no password credential and a wrong password are all the same
 * `false`: the login route reports `AUTH_INVALID_CREDENTIALS` for all three (API.md §1.3).
 */

import { sql } from 'drizzle-orm';

import type { Db, Tx } from '../../db/client.js';

/**
 * One bcrypt of work against no account at all — `gen_salt('bf', 12)` fixes the same 4 096 rounds
 * the real comparison pays, so the two are indistinguishable by a stopwatch.
 *
 * Exported because the login route needs it for the unknown-EMAIL branch, where there is no user
 * id to pass to {@link verifyPassword} at all.
 */
export async function burnPasswordWork(db: Db | Tx, password: string): Promise<void> {
  await db.execute(sql`SELECT crypt(${password}, gen_salt('bf', 12)) AS ignored`);
}

/**
 * True when `password` matches the user's active `kind='password'` credential.
 *
 * Returns `false` — never throws — for an unknown user or one with no password credential, so a
 * caller cannot distinguish the cases and accidentally build an account-enumeration oracle.
 *
 * **The no-credential path pays the same bcrypt.** Returning early when the `SELECT` finds no row
 * costs about 0.5 ms against ~240 ms for every other outcome, and that gap is a 500x oracle for
 * exactly the high-value accounts: the WebAuthn-only ones and the ones whose password has been
 * revoked. One unauthenticated request per address enumerates them. So a miss runs the burn.
 */
export async function verifyPassword(
  db: Db | Tx,
  userId: number,
  password: string,
): Promise<boolean> {
  if (password.length === 0) return false;
  const result = await db.execute<{ ok: boolean }>(sql`
    SELECT (crypt(${password}, secret_hash) = secret_hash) AS ok
      FROM user_credentials
     WHERE user_id = ${userId}
       AND kind = 'password'
       AND revoked_at IS NULL
     LIMIT 1`);
  if (result.rows.length === 0) {
    await burnPasswordWork(db, password);
    return false;
  }
  return result.rows[0]?.ok === true;
}

/**
 * Set (or replace) the user's password credential.
 *
 * One statement: the partial unique index `user_credentials_password_uniq` — one live password row
 * per user — is also the conflict target, so a re-set updates the existing row instead of racing a
 * delete-then-insert that would momentarily leave the account without a credential.
 */
export async function setPassword(db: Db | Tx, userId: number, password: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO user_credentials (user_id, kind, secret_hash)
    VALUES (${userId}, 'password', crypt(${password}, gen_salt('bf', 12)))
    ON CONFLICT (user_id) WHERE kind = 'password' AND revoked_at IS NULL
    DO UPDATE SET secret_hash = excluded.secret_hash`);
}
