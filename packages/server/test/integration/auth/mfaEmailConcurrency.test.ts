/**
 * `test/integration/auth/mfaEmailConcurrency.test.ts` — two sends for one sign-in, at once.
 *
 * `mfaEmail.test.ts` runs inside one rolled-back transaction, which is exactly the arrangement that
 * cannot see this race: two sends that share a connection are serial by construction. So this file
 * commits, on real pooled connections, and holds the first message in the transport while the
 * second request arrives — the way a double-clicked "Send a new code" does.
 *
 * What the first version of `send` did: it read the session's history (how many codes, when the
 * last) BEFORE its transaction, so the second request read the same empty history while the first
 * one's row sat uncommitted, passed the cooldown and the send limit, superseded nothing (the
 * first row was not visible to it), inserted its own row and mailed a second code. Two live codes
 * for one sign-in, two messages inside the 30-second cooldown — and, fired wide enough, as many
 * messages as requests: the send limit and the cooldown both bypassed by concurrency.
 *
 * The fix is the one `session.ts#create` uses for logins: a transaction-scoped advisory lock keyed
 * on the session, taken FIRST, with the history read inside the transaction after it.
 *
 * Everything this file creates is deleted in `afterEach`: it commits into the shared test database
 * and must leave nothing behind for the files running beside it.
 */

import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getConfig } from '../../../src/config.js';
import type { EmailSender, OutgoingEmail } from '../../../src/email/sender.js';
import { deriveCodeKey } from '../../../src/http/auth/emailCode.js';
import { emailCodeService } from '../../../src/http/auth/emailCodeService.js';
import { testClock } from '../../../src/test/clock.js';
import { testDatabaseUrl, withCleanDb, type TestDb } from '../../../src/test/db.js';

const { Pool } = pg;

/** Nothing is truncated — this harness is here only for a connection whose writes commit. */
const t: TestDb = withCleanDb([]);

let pool: pg.Pool;
let firmId: number;
let userId: number;
let email: string;
let sessionId: string;

/** A transport that holds the FIRST message until released, and records every message it is given. */
function heldSender(): EmailSender & {
  sent: OutgoingEmail[];
  firstArrived: Promise<void>;
  release: () => void;
} {
  const sent: OutgoingEmail[] = [];
  let arrived!: () => void;
  let release!: () => void;
  const firstArrived = new Promise<void>((r) => (arrived = r));
  const held = new Promise<void>((r) => (release = r));
  return {
    kind: 'memory',
    sent,
    firstArrived,
    release,
    async send(message) {
      sent.push(message);
      if (sent.length === 1) {
        arrived();
        await held;
      }
    },
  };
}

beforeAll(() => {
  pool = new Pool({ connectionString: testDatabaseUrl(), max: 4 });
  pool.on('error', () => undefined);
});

beforeEach(async () => {
  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`MFA Race Firm ${randomUUID().slice(0, 8)}`],
  );
  firmId = Number(firm.rows[0]!.firm_id);
  email = `mfa-race-${randomUUID()}@demo.invalid`;
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role, mfa_required)
     VALUES ($1, $2, 'MFA Race User', 'user', true) RETURNING user_id`,
    [firmId, email],
  );
  userId = Number(user.rows[0]!.user_id);
  sessionId = randomUUID();
  await t.client.query(
    `INSERT INTO sessions (session_id, user_id, token_hash, client_kind, expires_at)
     VALUES ($1, $2, digest($3, 'sha256'), 'web', now() + interval '1 day')`,
    [sessionId, userId, randomUUID()],
  );
});

afterEach(async () => {
  // This file commits, so it cleans up after itself: nothing it created may outlive it.
  await t.client.query(`DELETE FROM mfa_email_codes WHERE user_id = $1`, [userId]);
  await t.client.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  await t.client.query(`DELETE FROM users WHERE user_id = $1`, [userId]);
  await t.client.query(`DELETE FROM firms WHERE firm_id = $1`, [firmId]);
});

afterAll(async () => {
  await pool.end();
});

describe('two sends for one sign-in at once', () => {
  it('serialises: the second waits for the first, then meets the cooldown — one code, one message', async () => {
    const sender = heldSender();
    const codes = emailCodeService({
      db: drizzle(pool),
      clock: testClock(),
      key: deriveCodeKey(getConfig().SESSION_SECRET),
      sender,
    });
    const input = { sessionId, userId, email };

    // The first send is inside its transaction — row inserted, not committed — and held there.
    const first = codes.send(input);
    await sender.firstArrived;

    // The second arrives while the first is open. It must WAIT, not read the history around it.
    let settled = false;
    const second = codes.send(input).then(
      (r) => ((settled = true), { ok: true as const, r }),
      (e: unknown) => ((settled = true), { ok: false as const, e }),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Observed, then released, THEN asserted: a failed assertion while the first transaction is held
    // would leave it open, and `afterEach`'s delete would wait on its locks for ever.
    const sentWhileHeld = sender.sent.length;
    const settledWhileHeld = settled;
    sender.release();
    await first;
    const outcome = await second;

    expect(sentWhileHeld, 'a second message went out while the first send was still open').toBe(1);
    expect(settledWhileHeld, 'the second send finished without waiting for the first').toBe(false);

    // The loser saw the winner's committed row: the 30-second cooldown, not a second code.
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.e).toMatchObject({
      code: 'RATE_LIMITED',
      details: { reason: 'cooldown' },
    });
    expect(sender.sent).toHaveLength(1);

    const rows = await t.client.query<{ live: boolean }>(
      `SELECT consumed_at IS NULL AND superseded_at IS NULL AS live
         FROM mfa_email_codes WHERE session_id = $1`,
      [sessionId],
    );
    expect(rows.rows, 'exactly one code exists for the sign-in, and it is live').toEqual([{ live: true }]);
  }, 30_000);
});
