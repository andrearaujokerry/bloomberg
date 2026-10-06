/**
 * `http/auth/emailCodeService.ts` — sending and checking email sign-in codes, against the database.
 *
 * The arithmetic is `emailCode.ts`; this is where its properties are actually ENFORCED, each in a
 * way that no two concurrent requests can both win:
 *
 *   * **Hashed at rest** — only `hashCode(key, codeId, code)` is written; the code itself exists in
 *     this process for one function call and in the user's inbox.
 *   * **One live code per session, and the send limits** — sends for one session are serialised by
 *     an advisory lock taken first in the send transaction; the history (how many, how recent) is
 *     read after it, and earlier live codes are superseded in the same transaction as the insert.
 *   * **Five attempts** — `UPDATE … SET attempts = attempts + 1 WHERE attempts < 5 RETURNING`
 *     counts the guess BEFORE it is compared, so a request that dies mid-compare still spent it.
 *   * **Single use** — `UPDATE … SET consumed_at … WHERE consumed_at IS NULL RETURNING`: of two
 *     correct guesses racing, exactly one gets the row back.
 *
 * Callers pass a session that has ALREADY PROVED THE PASSWORD — the route checks that. Nothing here
 * creates or upgrades a session; the route does that only after `verify` answers `ok`.
 */

import { randomUUID } from 'node:crypto';

import { and, count, desc, eq, isNull, max, sql } from 'drizzle-orm';

import type { Clock } from '@terminal/core';

import type { Db, Tx } from '../../db/client.js';
import { mfaEmailCodes } from '../../db/schema/index.js';
import type { EmailSender } from '../../email/sender.js';
import { AppError, ProviderUnavailableError } from '../errors.js';
import {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  MAX_SENDS_PER_SESSION,
  RESEND_COOLDOWN_MS,
  generateCode,
  hashCode,
  hashesMatch,
  maskEmail,
  normaliseCode,
  renderCodeEmail,
} from './emailCode.js';

export interface EmailCodeServiceDeps {
  readonly db: Db | Tx;
  readonly clock: Clock;
  /** `deriveCodeKey(SESSION_SECRET)` — never the session secret itself. */
  readonly key: Buffer;
  /** `null` when no transport is configured: every send is refused. */
  readonly sender: EmailSender | null;
}

/** What the person signing in is told after a send. Never the code, never the full address. */
export interface CodeSent {
  readonly sentTo: string;
  readonly expiresAt: string;
  readonly resendAvailableAt: string;
  readonly sendsRemaining: number;
}

/** Why a code was not accepted. */
export type CodeRejection = 'malformed' | 'no_code' | 'expired' | 'exhausted' | 'mismatch';

/**
 * `attemptsRemaining` is `null` for a `malformed` entry, which is rejected before the live code is
 * even read and so has no count to report — `null`, not a `-1` sentinel that a screen would print.
 */
export type VerifyOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CodeRejection; readonly attemptsRemaining: number | null };

export interface EmailCodeService {
  send(input: { sessionId: string; userId: number; email: string }): Promise<CodeSent>;
  verify(input: { sessionId: string; code: unknown }): Promise<VerifyOutcome>;
}

export function emailCodeService(deps: EmailCodeServiceDeps): EmailCodeService {
  const { db, clock, key, sender } = deps;

  return {
    async send({ sessionId, userId, email }) {
      // Fail closed. Not "log it for now": see `email/sender.ts`.
      if (sender === null) {
        throw new ProviderUnavailableError(
          'Sign-in codes are not configured on this server, so a second factor cannot be sent.',
        );
      }

      // Lock, read the history, supersede, insert, SEND — one transaction.
      //
      // The lock comes FIRST, and the history is read after it. Read before the transaction (the
      // first version), two sends for one session both saw the history as it was before either
      // committed: both passed the cooldown and the send limit, neither could see the other's row
      // to supersede it, and both mailed a code — the limits bypassed by sending in parallel
      // (`mfaEmailConcurrency.test.ts`). A row lock cannot order them, because a session with no
      // code yet has no row to lock; an advisory lock exists whether or not a row does, as in
      // `session.ts#create`. The `mfa-email:` prefix keeps it out of the `session:` namespace.
      //
      // If the provider refuses, the insert rolls back: a row exists exactly when a message was
      // handed off, so a failed send leaves no phantom code and charges no cooldown for a message
      // that never left.
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended('mfa-email:' || ${sessionId}::text, 0))`,
          );

          // After the lock, so a send that waited for another one sees its row — and its time.
          const nowMs = clock.now();
          const history = await tx
            .select({ sends: count(), last: max(mfaEmailCodes.createdAt) })
            .from(mfaEmailCodes)
            .where(eq(mfaEmailCodes.sessionId, sessionId));
          const sends = Number(history[0]?.sends ?? 0);
          const last = history[0]?.last ?? null;

          if (sends >= MAX_SENDS_PER_SESSION) {
            // Not retryable by waiting: the remedy is a new login, which costs the password again.
            throw new AppError(
              'RATE_LIMITED',
              'Too many codes have been sent for this sign-in. Sign in again to get a new one.',
              { details: { reason: 'send_limit', limit: MAX_SENDS_PER_SESSION } },
            );
          }
          if (last !== null) {
            const waitMs = last.getTime() + RESEND_COOLDOWN_MS - nowMs;
            if (waitMs > 0) {
              throw new AppError('RATE_LIMITED', 'A code was sent a moment ago. Wait before asking for another.', {
                retryAfterMs: waitMs,
                details: { reason: 'cooldown' },
              });
            }
          }

          const codeId = randomUUID();
          const code = generateCode();
          const createdAt = new Date(nowMs);
          const expiresAt = new Date(nowMs + CODE_TTL_MS);
          const message = renderCodeEmail({ code, ttlMinutes: CODE_TTL_MS / 60_000 });

          await tx
            .update(mfaEmailCodes)
            .set({ supersededAt: createdAt })
            .where(
              and(
                eq(mfaEmailCodes.sessionId, sessionId),
                isNull(mfaEmailCodes.consumedAt),
                isNull(mfaEmailCodes.supersededAt),
              ),
            );
          await tx.insert(mfaEmailCodes).values({
            codeId,
            sessionId,
            userId,
            codeHash: hashCode(key, codeId, code),
            sentTo: email,
            createdAt,
            expiresAt,
          });
          await sender.send({ to: email, subject: message.subject, text: message.text });

          return {
            sentTo: maskEmail(email),
            expiresAt: expiresAt.toISOString(),
            resendAvailableAt: new Date(nowMs + RESEND_COOLDOWN_MS).toISOString(),
            sendsRemaining: MAX_SENDS_PER_SESSION - (sends + 1),
          };
        });
      } catch (cause) {
        if (cause instanceof AppError) throw cause;
        // The provider's own message can carry the server's banner or the address; neither belongs
        // in a response. It goes to the log through `cause`, not to the person signing in.
        throw new ProviderUnavailableError('The sign-in code could not be sent. Try again shortly.', {
          cause,
        });
      }
    },

    async verify({ sessionId, code: raw }) {
      // A typo of the wrong shape is rejected before anything is hashed or counted — it should not
      // cost one of the five guesses.
      const code = normaliseCode(raw);
      if (code === null) return { ok: false, reason: 'malformed', attemptsRemaining: null };

      const live = await db
        .select({
          codeId: mfaEmailCodes.codeId,
          codeHash: mfaEmailCodes.codeHash,
          expiresAt: mfaEmailCodes.expiresAt,
          attempts: mfaEmailCodes.attempts,
        })
        .from(mfaEmailCodes)
        .where(
          and(
            eq(mfaEmailCodes.sessionId, sessionId),
            isNull(mfaEmailCodes.consumedAt),
            isNull(mfaEmailCodes.supersededAt),
          ),
        )
        .orderBy(desc(mfaEmailCodes.createdAt))
        .limit(1);
      const row = live[0];
      if (row === undefined) return { ok: false, reason: 'no_code', attemptsRemaining: 0 };

      const now = new Date(clock.now());
      if (row.expiresAt.getTime() <= now.getTime()) {
        return { ok: false, reason: 'expired', attemptsRemaining: 0 };
      }

      // Count the guess FIRST, atomically. `attempts < MAX_ATTEMPTS` in the WHERE is the enforcement;
      // migration 0020's CHECK is the ceiling behind it.
      const counted = await db
        .update(mfaEmailCodes)
        .set({ attempts: sql`${mfaEmailCodes.attempts} + 1` })
        .where(
          and(
            eq(mfaEmailCodes.codeId, row.codeId),
            sql`${mfaEmailCodes.attempts} < ${MAX_ATTEMPTS}`,
            isNull(mfaEmailCodes.consumedAt),
            isNull(mfaEmailCodes.supersededAt),
          ),
        )
        .returning({ attempts: mfaEmailCodes.attempts });
      const spent = counted[0]?.attempts;
      if (spent === undefined) return { ok: false, reason: 'exhausted', attemptsRemaining: 0 };

      if (!hashesMatch(row.codeHash, hashCode(key, row.codeId, code))) {
        return { ok: false, reason: 'mismatch', attemptsRemaining: MAX_ATTEMPTS - spent };
      }

      // Single use. Of two correct guesses racing, the second finds `consumed_at` already set and
      // gets no row back. The expiry is re-checked here so a code cannot be spent in the instant
      // after it died.
      const consumed = await db
        .update(mfaEmailCodes)
        .set({ consumedAt: now })
        .where(
          and(
            eq(mfaEmailCodes.codeId, row.codeId),
            isNull(mfaEmailCodes.consumedAt),
            isNull(mfaEmailCodes.supersededAt),
            sql`${mfaEmailCodes.expiresAt} > ${now.toISOString()}::timestamptz`,
          ),
        )
        .returning({ codeId: mfaEmailCodes.codeId });
      if (consumed.length === 0) return { ok: false, reason: 'no_code', attemptsRemaining: 0 };
      return { ok: true };
    },
  };
}
