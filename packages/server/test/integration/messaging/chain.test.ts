/**
 * MSG-02 — the WORM message log and its hash chain (WORKPLAN WP-09 acceptance row).
 *
 * Three claims are made about `messages` and all three are proved against the shipped database
 * objects rather than against this module's own idea of them:
 *
 *  1. the chain **verifies** over a room — which is only true if `verifyChain`'s recomputation is
 *     byte-for-byte the `messages_chain` trigger's, down to Postgres' own `jsonb::text` rendering
 *     of `attachments`;
 *  2. an `UPDATE` is **refused** — by the missing grant when the shipped `terminal_app` role tries
 *     it, and by the `messages_worm` trigger when a role that holds every grant tries it;
 *  3. a chain broken by tampering is **detected**, with the first bad `seq` named.
 *
 * The seed does not exist (WP-15 owns it), so every firm, user, room and message here is created
 * inside this file's own transaction and nothing depends on a literal id.
 */

import { randomUUID } from 'node:crypto';

import { sql as sqlTag } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { messagingService, type MessagingService } from '../../../src/messaging/service.js';
import { surveillanceScanner } from '../../../src/messaging/surveillance.js';
import { testClock } from '../../../src/test/clock.js';
import { asAppRole, asUser, withTxDb, type TestDb } from '../../../src/test/db.js';

const t = withTxDb();

const CLOCK_START = Date.parse('2026-09-15T18:41:28Z');

/**
 * The SQLSTATE of a failure, whether it arrived raw from `pg` or wrapped by drizzle's
 * `DrizzleQueryError` (which carries the driver error as `cause`). Asserting on the wrapper's own
 * shape would assert nothing about the database.
 */
function driverError(err: unknown): { code?: string; message?: string } | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        ...(typeof candidate.message === 'string' ? { message: candidate.message } : {}),
      };
    }
    current = candidate.cause ?? null;
  }
  return null;
}
const sqlstate = (err: unknown): string | undefined => driverError(err)?.code;
const pgMessage = (err: unknown): string => driverError(err)?.message ?? String(err);

interface Party {
  userId: number;
  firmId: number;
  firmName: string;
}

async function createFirm(name: string): Promise<number> {
  const res = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [name],
  );
  return Number(res.rows[0]!.firm_id);
}

async function createUser(
  firmId: number,
  firmName: string,
  spec: { desk?: string | null; role?: string } = {},
): Promise<Party> {
  const res = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, desk, role)
     VALUES ($1, $2, $3, $4, $5) RETURNING user_id`,
    [
      firmId,
      `msg-${randomUUID()}@demo.invalid`,
      `User ${randomUUID().slice(0, 6)}`,
      spec.desk ?? null,
      spec.role ?? 'user',
    ],
  );
  return { userId: Number(res.rows[0]!.user_id), firmId, firmName };
}

interface Harness {
  service: MessagingService;
  alice: Party;
  bob: Party;
  roomId: number;
}

/** One internal group room with two members of the same firm and the same desk. */
async function harness(db: TestDb = t): Promise<Harness> {
  const clock = testClock(CLOCK_START);
  const firmName = `Demo Capital ${randomUUID().slice(0, 6)}`;
  const firmId = await createFirm(firmName);
  const alice = await createUser(firmId, firmName, { desk: 'Equities PM' });
  const bob = await createUser(firmId, firmName, { desk: 'Equities PM' });

  const service = messagingService({ db: db.db, clock });
  await asUser(db, alice.userId, firmId);
  const room = await service.createRoom({
    kind: 'group',
    name: 'Trading floor',
    createdBy: alice.userId,
    memberUserIds: [bob.userId],
    firmId,
  });
  return { service, alice, bob, roomId: room.roomId };
}

describe('MSG-02 — the hash chain over a room', () => {
  it('verifies a room whose messages were written by the chain trigger', async () => {
    const { service, alice, bob, roomId } = await harness();

    await service.send({
      roomId,
      senderUserId: alice.userId,
      body: 'morning — flagging the print on the open',
      clientMsgId: randomUUID(),
    });
    await asUser(t, bob.userId, bob.firmId);
    await service.send({
      roomId,
      senderUserId: bob.userId,
      body: 'seen. 245.60 on 1.2m shares',
      attachments: [{ kind: 'security', instrumentId: 4242 }],
      clientMsgId: randomUUID(),
    });
    await asUser(t, alice.userId, alice.firmId);
    await service.send({
      roomId,
      senderUserId: alice.userId,
      body: 'thanks',
      clientMsgId: randomUUID(),
    });

    const verdict = await service.verifyChain(roomId);
    expect(verdict).toEqual({ ok: true, checked: 3 });

    const page = await service.history(roomId, { limit: 50 });
    expect(page.items.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(page.items[0]!.prevHash).toBeNull();
    expect(page.items[1]!.prevHash).toBe(page.items[0]!.hash);
    expect(page.items[2]!.prevHash).toBe(page.items[1]!.hash);
    expect(page.items[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(page.nextCursor).toBeNull();
  });

  it('is idempotent on client_msg_id, so a retry adds no link to the chain', async () => {
    const { service, alice, roomId } = await harness();
    const clientMsgId = randomUUID();

    const first = await service.send({
      roomId,
      senderUserId: alice.userId,
      body: 'sent once',
      clientMsgId,
    });
    const retry = await service.send({
      roomId,
      senderUserId: alice.userId,
      body: 'sent once',
      clientMsgId,
    });

    expect(retry.messageId).toBe(first.messageId);
    expect(retry.seq).toBe(1);
    expect(await service.verifyChain(roomId)).toEqual({ ok: true, checked: 1 });
  });

  it('collapses two concurrent sends of one client_msg_id into a single link', async () => {
    const { service, alice, roomId } = await harness();
    const clientMsgId = randomUUID();

    // Both calls check for the stored row before either insert lands, which is exactly the race
    // the unique key exists for: the loser takes the winner's row rather than failing the send
    // or aborting the caller's transaction.
    const [a, b] = await Promise.all([
      service.send({ roomId, senderUserId: alice.userId, body: 'race', clientMsgId }),
      service.send({ roomId, senderUserId: alice.userId, body: 'race', clientMsgId }),
    ]);

    expect(a.messageId).toBe(b.messageId);
    expect(a.seq).toBe(1);
    const count = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM messages WHERE room_id = $1`,
      [roomId],
    );
    expect(Number(count.rows[0]!.n)).toBe(1);
    expect(await service.verifyChain(roomId)).toEqual({ ok: true, checked: 1 });
  });

  it('stores MSG-04 attachments as references and strips the sender-side values', async () => {
    const { service, alice, roomId } = await harness();

    const message = await service.send({
      roomId,
      senderUserId: alice.userId,
      body: 'my book',
      attachments: [
        // A client that hung its own numbers on the reference: the price it can see, the P&L of
        // the portfolio. None of it may be stored, because the recipient renders the reference
        // under THEIR entitlements (MSG-04, ENTL-05).
        { kind: 'security', instrumentId: 4242, px: 245.6, pnl: -13_400 },
        { kind: 'portfolio', portfolioId: 7, marketValue: 1_200_000 },
      ],
      clientMsgId: randomUUID(),
    });

    expect(message.attachments).toEqual([
      { kind: 'security', instrumentId: 4242 },
      { kind: 'portfolio', portfolioId: 7 },
    ]);

    const stored = await t.client.query<{ attachments: unknown }>(
      `SELECT attachments FROM messages WHERE message_id = $1`,
      [message.messageId],
    );
    expect(JSON.stringify(stored.rows[0]!.attachments)).not.toContain('245.6');
    expect(JSON.stringify(stored.rows[0]!.attachments)).not.toContain('marketValue');
  });
});

describe('MSG-02 — WORM', () => {
  it('refuses an UPDATE under the shipped terminal_app grants, and again at the trigger', async () => {
    const { service, alice, roomId } = await harness();
    const message = await service.send({
      roomId,
      senderUserId: alice.userId,
      body: 'the original',
      clientMsgId: randomUUID(),
    });

    // The shipped grants: migration 0015 gives terminal_app SELECT and INSERT on `messages` and
    // never UPDATE, so the statement never reaches the trigger.
    const byGrant = await t
      .savepoint(async () => {
        await asAppRole(t);
        await t.client.query(`UPDATE messages SET body = 'tampered' WHERE message_id = $1`, [
          message.messageId,
        ]);
      })
      .then(
        () => null,
        (err: unknown) => err as { code?: string; message?: string },
      );
    expect(byGrant?.code).toBe('42501');
    expect(byGrant?.message).toContain('messages');

    // Defence in depth: a role that DOES hold every grant (the owner, as this harness runs) is
    // refused by `messages_worm` itself — RAISE EXCEPTION, SQLSTATE P0001.
    const byTrigger = await t
      .savepoint(async () => {
        await t.client.query(`UPDATE messages SET body = 'tampered' WHERE message_id = $1`, [
          message.messageId,
        ]);
      })
      .then(
        () => null,
        (err: unknown) => err as { code?: string; message?: string },
      );
    expect(byTrigger?.code).toBe('P0001');
    expect(byTrigger?.message).toBe('table messages is append-only (WORM)');

    // …and a DELETE is refused by the same trigger.
    const onDelete = await t
      .savepoint(async () => {
        await t.client.query(`DELETE FROM messages WHERE message_id = $1`, [message.messageId]);
      })
      .then(
        () => null,
        (err: unknown) => err as { code?: string },
      );
    expect(onDelete?.code).toBe('P0001');

    // The row is untouched, and the chain still verifies.
    const still = await service.history(roomId, { limit: 10 });
    expect(still.items[0]!.body).toBe('the original');
    expect(await service.verifyChain(roomId)).toEqual({ ok: true, checked: 1 });
  });

  it('detects a deliberately broken chain and reports the first bad seq', async () => {
    const { service, alice, roomId } = await harness();
    for (const body of ['one', 'two', 'three']) {
      await service.send({ roomId, senderUserId: alice.userId, body, clientMsgId: randomUUID() });
    }
    expect(await service.verifyChain(roomId)).toEqual({ ok: true, checked: 3 });

    // Tampering can only come from below the application: the grants and the WORM trigger make an
    // UPDATE impossible, so the forgery is modelled as a row written with the chain trigger
    // disabled — an attacker with owner rights on the database, which is exactly the threat the
    // hash chain exists to detect. (DDL inside the test transaction; the rollback undoes it.)
    await t.client.query(`ALTER TABLE messages DISABLE TRIGGER messages_chain_trg`);
    await t.client.query(
      `INSERT INTO messages (room_id, seq, sender_user_id, sender_firm_id, sent_at, body,
                             attachments, client_msg_id, prev_hash, hash)
       SELECT $1, 4, $2, $3, now(), 'forged', '[]'::jsonb, $4::uuid, m.hash,
              digest('not the digest of this row', 'sha256')
         FROM messages m WHERE m.room_id = $1 AND m.seq = 3`,
      [roomId, alice.userId, alice.firmId, randomUUID()],
    );
    await t.client.query(`ALTER TABLE messages ENABLE TRIGGER messages_chain_trg`);

    const verdict = await service.verifyChain(roomId);
    expect(verdict.ok).toBe(false);
    expect(verdict.firstBadSeq).toBe(4);
    expect(verdict.checked).toBe(3);
    expect(verdict.detail).toContain('digest of its own content');
  });

  it('detects a chain whose linkage was rewritten, not only a bad digest', async () => {
    const { service, alice, roomId } = await harness();
    for (const body of ['one', 'two']) {
      await service.send({ roomId, senderUserId: alice.userId, body, clientMsgId: randomUUID() });
    }

    // seq 2 is removed from the archive, so seq 3 links to a hash that is no longer there.
    await t.client.query(`ALTER TABLE messages DISABLE TRIGGER messages_chain_trg`);
    await t.client.query(
      `INSERT INTO messages (room_id, seq, sender_user_id, sender_firm_id, sent_at, body,
                             attachments, client_msg_id, prev_hash, hash)
       VALUES ($1, 3, $2, $3, now(), 'later', '[]'::jsonb, $4::uuid,
               digest('a hash nothing in this room carries', 'sha256'),
               digest('whatever', 'sha256'))`,
      [roomId, alice.userId, alice.firmId, randomUUID()],
    );
    await t.client.query(`ALTER TABLE messages ENABLE TRIGGER messages_chain_trg`);

    const verdict = await service.verifyChain(roomId);
    expect(verdict.ok).toBe(false);
    expect(verdict.firstBadSeq).toBe(3);
    expect(verdict.detail).toContain('does not link');
  });

  // ── the anchor (migration 0017 §17.g) ──────────────────────────────────────────────────────
  //
  // The three tests above all detect an *inconsistent* chain. None of them detects a chain that
  // was rewritten consistently, and rewriting one consistently is not hard: the digest expression
  // is in the migration, so anybody who can write the table can recompute it. `rooms.last_seq` and
  // `rooms.last_hash` are maintained by the trigger, never decrease, and are the one statement
  // about the room that rewriting `messages` does not restate.

  it('detects a suffix re-hashed with the trigger’s own expression', async () => {
    const { service, alice, roomId } = await harness();
    for (const body of ['one', 'two', 'three', 'four']) {
      await service.send({ roomId, senderUserId: alice.userId, body, clientMsgId: randomUUID() });
    }
    expect(await service.verifyChain(roomId)).toEqual({ ok: true, checked: 4 });

    // Edit seq 2 and recompute seq 2..4 exactly as `messages_chain` would. Every internal check —
    // contiguity, linkage, digest — passes over the forged text afterwards.
    await t.client.query(`ALTER TABLE messages DISABLE TRIGGER USER`);
    await t.client.query(
      `UPDATE messages SET body = 'I never said that' WHERE room_id = $1 AND seq = 2`,
      [roomId],
    );
    for (const seq of [2, 3, 4]) {
      await t.client.query(
        `UPDATE messages m
            SET prev_hash = p.hash,
                hash = digest(coalesce(p.hash, '\\x'::bytea)
                       || convert_to(m.room_id::text || '|' || m.seq::text || '|'
                                     || m.sender_user_id::text || '|'
                                     || to_char(m.sent_at AT TIME ZONE 'UTC',
                                                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|'
                                     || m.body || '|' || m.attachments::text || '|'
                                     || coalesce(m.structured::text, '') || '|'
                                     || m.sender_firm_id::text || '|'
                                     || m.client_msg_id::text, 'UTF8'), 'sha256')
           FROM messages p
          WHERE m.room_id = $1 AND m.seq = $2 AND p.room_id = m.room_id AND p.seq = m.seq - 1`,
        [roomId, seq],
      );
    }
    await t.client.query(`ALTER TABLE messages ENABLE TRIGGER USER`);

    const verdict = await service.verifyChain(roomId);
    expect(verdict.ok).toBe(false);
    expect(verdict.firstBadSeq).toBe(4);
    expect(verdict.detail).toContain('anchored');
  });

  it('detects tail truncation, which needs no forgery at all', async () => {
    const { service, alice, roomId } = await harness();
    for (const body of ['one', 'two', 'three', 'four']) {
      await service.send({ roomId, senderUserId: alice.userId, body, clientMsgId: randomUUID() });
    }

    await t.client.query(`ALTER TABLE messages DISABLE TRIGGER USER`);
    await t.client.query(`DELETE FROM messages WHERE room_id = $1 AND seq = 4`, [roomId]);
    await t.client.query(`ALTER TABLE messages ENABLE TRIGGER USER`);

    const verdict = await service.verifyChain(roomId);
    expect(verdict.ok).toBe(false);
    expect(verdict.firstBadSeq).toBe(4);
    expect(verdict.checked).toBe(3);
    expect(verdict.detail).toContain('has been removed');
  });

  it('detects a whole room rewritten from seq 1', async () => {
    const { service, alice, roomId } = await harness();
    for (const body of ['one', 'two', 'three', 'four']) {
      await service.send({ roomId, senderUserId: alice.userId, body, clientMsgId: randomUUID() });
    }

    await t.client.query(`ALTER TABLE messages DISABLE TRIGGER USER`);
    await t.client.query(`DELETE FROM messages WHERE room_id = $1`, [roomId]);
    let prev: string | null = null;
    for (const [seq, body] of [
      [1, 'nothing untoward happened'],
      [2, 'agreed'],
    ] as const) {
      const inserted = await t.client.query<{ hash: string }>(
        `INSERT INTO messages (room_id, seq, sender_user_id, sender_firm_id, sent_at, body,
                               attachments, client_msg_id, prev_hash, hash, digest_version)
         VALUES ($1::bigint, $2::bigint, $3::bigint, $4::bigint, now(), $5::text, '[]'::jsonb,
                 $6::uuid, decode(coalesce($7::text, ''), 'hex'),
                 digest(decode(coalesce($7::text, ''), 'hex')
                        || convert_to($1::text || '|' || $2::text || '|' || $5::text, 'UTF8'),
                        'sha256'), 2)
         RETURNING encode(hash, 'hex') AS hash`,
        [roomId, seq, alice.userId, alice.firmId, body, randomUUID(), prev],
      );
      prev = inserted.rows[0]!.hash;
    }
    await t.client.query(`ALTER TABLE messages ENABLE TRIGGER USER`);

    const verdict = await service.verifyChain(roomId);
    expect(verdict.ok).toBe(false);
    expect(verdict.checked).toBeLessThan(4);
  });

  it('covers the MSG-06 structured block, the sending firm and the client id', async () => {
    const { service, alice, roomId } = await harness();
    await service.send({
      roomId,
      senderUserId: alice.userId,
      body: 'indication attached',
      clientMsgId: randomUUID(),
      structured: { type: 'ioi', side: 'buy', instrumentId: 1, qty: 10_000, price: 42.5 },
    });
    expect(await service.verifyChain(roomId)).toEqual({ ok: true, checked: 1 });

    // The tradable content of an indication of interest was outside the 0015 digest: buy 10,000 at
    // 42.5 could be rewritten to sell 1 at 9,999 and the chain still verified. Version 2 covers it.
    await t.client.query(`ALTER TABLE messages DISABLE TRIGGER USER`);
    await t.client.query(
      `UPDATE messages
          SET structured =
                '{"type":"ioi","side":"sell","instrumentId":1,"qty":1,"price":9999}'::jsonb
        WHERE room_id = $1 AND seq = 1`,
      [roomId],
    );
    await t.client.query(`ALTER TABLE messages ENABLE TRIGGER USER`);

    const verdict = await service.verifyChain(roomId);
    expect(verdict.ok).toBe(false);
    expect(verdict.firstBadSeq).toBe(1);
    expect(verdict.detail).toContain('digest of its own content');
  });

  it('verifies a version-1 row with the version-1 expression, so an archive keeps verifying', async () => {
    const { service, alice, roomId } = await harness();
    await service.send({
      roomId,
      senderUserId: alice.userId,
      body: 'written before the digest widened',
      clientMsgId: randomUUID(),
    });

    // Re-hash the row the way migration 0015 did and mark it version 1: `verifyChain` picks the
    // expression by version, so the room still verifies rather than reading as tampered.
    await t.client.query(`ALTER TABLE messages DISABLE TRIGGER USER`);
    await t.client.query(
      `UPDATE messages m
          SET digest_version = 1,
              hash = digest(coalesce(m.prev_hash, '\\x'::bytea)
                     || convert_to(m.room_id::text || '|' || m.seq::text || '|'
                                   || m.sender_user_id::text || '|'
                                   || to_char(m.sent_at AT TIME ZONE 'UTC',
                                              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|'
                                   || m.body || '|' || m.attachments::text, 'UTF8'), 'sha256')
        WHERE m.room_id = $1`,
      [roomId],
    );
    // The anchor is monotonic and already holds seq 1, so `anchor_room_chain` would refuse to move
    // it. An archive migrated from the version-1 digest has its anchor rewritten by that
    // migration, which is what this models.
    await t.client.query(
      `UPDATE rooms SET last_hash = (SELECT hash FROM messages WHERE room_id = $1 AND seq = 1)
        WHERE room_id = $1`,
      [roomId],
    );
    await t.client.query(`ALTER TABLE messages ENABLE TRIGGER USER`);

    expect(await service.verifyChain(roomId)).toEqual({ ok: true, checked: 1 });
  });
});

describe('REG-01 and MSG-03 at the database, under terminal_app', () => {
  const room = async (): Promise<Harness> => harness();

  it('refuses a retention_days below the seven-year floor even from the room’s creator', async () => {
    const { roomId } = await room();

    // `rooms_member`'s WITH CHECK is `created_by = app_user_id()` and 15.b grants UPDATE on rooms,
    // so the creator can write the row. `setRetentionDays` refuses the value, but until 0017 §17.a
    // nothing below the service did: one future writer that forgets the check lowers a seven-year
    // retention silently, which is precisely what REG-01 exists to prevent.
    const refused = await t
      .savepoint(async () => {
        await asAppRole(t);
        await t.client.query(`UPDATE rooms SET retention_days = 1 WHERE room_id = $1`, [roomId]);
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(sqlstate(refused)).toBe('23514');
    expect(pgMessage(refused)).toContain('rooms_retention_floor');
  });

  it('refuses a principal who seats themselves in a room they were never added to', async () => {
    const { alice, roomId } = await room();
    const outsiderFirm = `Rival Partners LLP ${randomUUID().slice(0, 6)}`;
    const outsider = await createUser(await createFirm(outsiderFirm), outsiderFirm, {
      desk: 'Research',
    });

    // The MSG-03 ethical wall lives in `messaging/service.ts#canJoin`, and the routes happen to be
    // its only callers. Until 0017 §17.c the database backstop was `WITH CHECK (app_user_id() IS
    // NOT NULL)` — vacuous — so any authenticated principal could write their own membership row
    // into any room by id and `messages_member` would then let them read it.
    const refused = await t
      .savepoint(async () => {
        await asUser(t, outsider.userId, outsider.firmId);
        await asAppRole(t);
        await t.client.query(
          `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`,
          [roomId, outsider.userId],
        );
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(sqlstate(refused)).toBe('42501');
    expect(pgMessage(refused)).toContain('room_members');

    // A steward of the room may still seat somebody, which is what the route does.
    await asUser(t, alice.userId, alice.firmId);
    await asAppRole(t);
    await t.client.query(
      `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`,
      [roomId, outsider.userId],
    );
    await t.client.query('RESET ROLE');
    const seats = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM room_members WHERE room_id = $1`,
      [roomId],
    );
    expect(Number(seats.rows[0]!.n)).toBe(3);
  });

  it('creates a room as terminal_app: the INSERT … RETURNING satisfies its own policy', async () => {
    const firmName = `Demo Capital ${randomUUID().slice(0, 6)}`;
    const firmId = await createFirm(firmName);
    const creator = await createUser(firmId, firmName, { desk: 'Equities PM' });

    await asUser(t, creator.userId, firmId);
    await asAppRole(t);
    const service = messagingService({ db: t.db, clock: testClock(CLOCK_START) });

    // `INSERT INTO rooms … RETURNING room_id` must satisfy `rooms_member`'s USING clause for the
    // returned row, and the creator is not a member yet — the room_members insert comes after. The
    // 0015 policy therefore raised 42501 and POST /api/v1/rooms and POST /api/v1/help/tickets
    // 500'd in any deployment where RLS applies. The suite missed it because it runs as the owner.
    const created = await service.createRoom({
      kind: 'group',
      name: 'Created under RLS',
      createdBy: creator.userId,
      memberUserIds: [],
    });
    expect(created.roomId).toBeGreaterThan(0);
    expect(created.members.map((m) => m.userId)).toEqual([creator.userId]);

    // …and the REG-01 floor is what the row actually carries.
    await t.client.query('RESET ROLE');
    const stored = await t.client.query<{ retention_days: number }>(
      `SELECT retention_days FROM rooms WHERE room_id = $1`,
      [created.roomId],
    );
    expect(stored.rows[0]!.retention_days).toBeGreaterThanOrEqual(2557);
  });
});

describe('MSG-02 — lexicon surveillance', () => {
  it('records one open hit per matching term, idempotently, and reviews it', async () => {
    const { service, alice, roomId } = await harness();
    const message = await service.send({
      roomId,
      senderUserId: alice.userId,
      body: 'between us, this is a guaranteed return — keep it off the record',
      clientMsgId: randomUUID(),
    });

    const global = await t.client.query<{ term_id: string }>(
      `INSERT INTO surveillance_lexicon (firm_id, pattern, severity, note)
       VALUES (NULL, 'guarantee(d)?\\s+return', 3, 'promissory language')
       RETURNING term_id`,
    );
    const firmTerm = await t.client.query<{ term_id: string }>(
      `INSERT INTO surveillance_lexicon (firm_id, pattern, severity, note)
       VALUES ($1, 'off the record', 2, 'evasion') RETURNING term_id`,
      [alice.firmId],
    );
    const broken = await t.client.query<{ term_id: string }>(
      `INSERT INTO surveillance_lexicon (firm_id, pattern, severity, note)
       VALUES (NULL, '([unclosed', 1, 'a compliance typo') RETURNING term_id`,
    );
    const inactive = await t.client.query<{ term_id: string }>(
      `INSERT INTO surveillance_lexicon (firm_id, pattern, severity, active, note)
       VALUES (NULL, 'morning', 1, false, 'retired') RETURNING term_id`,
    );

    const problems: string[] = [];
    const scanner = surveillanceScanner({
      db: t.db,
      clock: testClock(CLOCK_START),
      onError: (_err, detail) => problems.push(detail),
    });

    const hits = await scanner.scanMessage({
      messageId: message.messageId,
      firmId: alice.firmId,
      body: 'between us, this is a guaranteed return — keep it off the record',
    });
    expect(hits.map((h) => h.matchedText).sort()).toEqual(['guaranteed return', 'off the record']);
    expect(hits.map((h) => h.termId).sort()).toEqual(
      [Number(global.rows[0]!.term_id), Number(firmTerm.rows[0]!.term_id)].sort(),
    );
    // The unparseable pattern is reported, not thrown, and the retired one never runs.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(broken.rows[0]!.term_id);
    expect(hits.some((h) => h.termId === Number(inactive.rows[0]!.term_id))).toBe(false);

    // A re-scan (a replay, a back-fill) cannot double-report the same message against a term.
    await scanner.scanMessage({
      messageId: message.messageId,
      firmId: alice.firmId,
      body: 'between us, this is a guaranteed return — keep it off the record',
    });
    const count = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM surveillance_hits WHERE message_id = $1`,
      [message.messageId],
    );
    expect(Number(count.rows[0]!.n)).toBe(2);

    const open = await scanner.open();
    const mine = open.filter((h) => h.messageId === message.messageId);
    expect(mine).toHaveLength(2);
    expect(mine.every((h) => h.reviewStatus === 'open')).toBe(true);
    expect(mine.map((h) => h.severity).sort()).toEqual([2, 3]);

    const escalate = mine.find((h) => h.severity === 3)!;
    await scanner.review(escalate.hitId, {
      status: 'escalated',
      reviewerUserId: alice.userId,
      note: 'referred to compliance',
    });
    const after = await t.client.query<{ review_status: string; reviewer_note: string }>(
      `SELECT review_status, reviewer_note FROM surveillance_hits WHERE hit_id = $1`,
      [escalate.hitId],
    );
    expect(after.rows[0]!.review_status).toBe('escalated');
    expect(after.rows[0]!.reviewer_note).toBe('referred to compliance');
  });

  it('keeps the message when the scan fails: a supervision gap never loses a send', async () => {
    const clock = testClock(CLOCK_START);
    const firmName = `Demo Capital ${randomUUID().slice(0, 6)}`;
    const firmId = await createFirm(firmName);
    const alice = await createUser(firmId, firmName, { desk: 'Equities PM' });

    const problems: string[] = [];
    const service = messagingService({
      db: t.db,
      clock,
      onError: (_err, detail) => problems.push(detail),
      surveillance: {
        // A scan that raises inside the caller's transaction — which is exactly what the RLS
        // policy on `surveillance_hits` does to a non-compliance context.
        scanMessage: async () => {
          await t.db.execute(sqlTag`SELECT 1 / 0`);
          return [];
        },
      },
    });
    await asUser(t, alice.userId, firmId);
    const room = await service.createRoom({
      kind: 'group',
      name: 'Floor',
      createdBy: alice.userId,
      memberUserIds: [],
      firmId,
    });

    const message = await service.send({
      roomId: room.roomId,
      senderUserId: alice.userId,
      body: 'this must survive a failing scan',
      clientMsgId: randomUUID(),
    });
    expect(message.seq).toBe(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('surveillance scan');

    // The transaction is still usable — without the savepoint every statement from here on, and
    // the COMMIT with it, would fail with 25P02 and the message would be lost.
    const page = await service.history(room.roomId, { limit: 10 });
    expect(page.items.map((m) => m.body)).toEqual(['this must survive a failing scan']);
    expect(await service.verifyChain(room.roomId)).toEqual({ ok: true, checked: 1 });
  });

  it('writes hits under the shipped compliance policy, as terminal_app', async () => {
    const { service, alice, roomId } = await harness();
    const supervisor = await createUser(alice.firmId, alice.firmName, { role: 'compliance' });
    const message = await service.send({
      roomId,
      senderUserId: alice.userId,
      body: 'this stays between us',
      clientMsgId: randomUUID(),
    });
    await t.client.query(
      `INSERT INTO surveillance_lexicon (firm_id, pattern, severity) VALUES (NULL, 'between us', 3)`,
    );

    // MSG-02 has to record a hit from where the body is: inside the SENDER's transaction, under
    // `app.role = 'user'`, as terminal_app. The policy on `surveillance_hits` is compliance-only,
    // so a direct INSERT there is refused with 42501, swallowed by the savepoint and handed to
    // `onError` — which is what used to happen, and it left the archive silently empty. Migration
    // 0017 §17.e routes the write through `record_surveillance_hit`, a SECURITY DEFINER writer, so
    // the scan records without the sender's transaction pretending to be compliance.
    await asUser(t, alice.userId, alice.firmId);
    await asAppRole(t);
    const asSender = surveillanceScanner({ db: t.db, clock: testClock(CLOCK_START) });
    const senderHits = await asSender.scanMessage({
      messageId: message.messageId,
      firmId: alice.firmId,
      body: 'this stays between us',
    });
    expect(senderHits).toHaveLength(1);

    // …and it is a writer only. The sender still cannot read the review queue — the count below
    // reads 0 under their own role for exactly that reason, which is the point of the assertion
    // rather than an inconvenience to work around.
    expect(await asSender.open()).toEqual([]);
    const asSenderCount = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM surveillance_hits WHERE message_id = $1`,
      [message.messageId],
    );
    expect(Number(asSenderCount.rows[0]!.n)).toBe(0);

    // A re-scan is idempotent on (message_id, term_id): no second row, no error.
    await asSender.scanMessage({
      messageId: message.messageId,
      firmId: alice.firmId,
      body: 'this stays between us',
    });

    // The compliance officer of a firm in the room sees exactly one hit, once.
    await asUser(t, supervisor.userId, supervisor.firmId, 'compliance');
    await asAppRole(t);
    const scanner = surveillanceScanner({ db: t.db, clock: testClock(CLOCK_START) });
    const queue = (await scanner.open()).filter((h) => h.messageId === message.messageId);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.matchedText).toBe('between us');
  });

  it('keeps one firm’s surveillance hits out of another firm’s compliance queue', async () => {
    const { service, alice, roomId } = await harness();
    const message = await service.send({
      roomId,
      senderUserId: alice.userId,
      body: 'guarantee a 20% return, keep this off the record',
      clientMsgId: randomUUID(),
    });
    await t.client.query(
      `INSERT INTO surveillance_lexicon (firm_id, pattern, severity) VALUES (NULL, 'off the record', 3)`,
    );
    await asUser(t, alice.userId, alice.firmId);
    await asAppRole(t);
    await surveillanceScanner({ db: t.db, clock: testClock(CLOCK_START) }).scanMessage({
      messageId: message.messageId,
      firmId: alice.firmId,
      body: 'guarantee a 20% return, keep this off the record',
    });

    // Read the hit back as the table owner, which is the only role in this test that is allowed
    // to see it without making a claim about firms.
    await t.client.query('RESET ROLE');
    const hitId = Number(
      (
        await t.client.query<{ hit_id: string }>(
          `SELECT hit_id::text AS hit_id FROM surveillance_hits WHERE message_id = $1`,
          [message.messageId],
        )
      ).rows[0]!.hit_id,
    );

    // A compliance officer at an unrelated firm. `matched_text` is a verbatim excerpt of a message
    // body, so it must not escape the boundary the message row itself respects: the 0015 policy
    // was `app_role() = 'compliance'` with no firm predicate, and firm B read — and cleared —
    // firm A's hits through it.
    const rivalFirmName = `Rival Partners LLP ${randomUUID().slice(0, 6)}`;
    const rivalFirmId = await createFirm(rivalFirmName);
    const rival = await createUser(rivalFirmId, rivalFirmName, { role: 'compliance' });
    await asUser(t, rival.userId, rival.firmId, 'compliance');
    await asAppRole(t);
    const rivalScanner = surveillanceScanner({ db: t.db, clock: testClock(CLOCK_START) });
    expect(await rivalScanner.open()).toEqual([]);

    await rivalScanner.review(hitId, { status: 'cleared', reviewerUserId: rival.userId });

    await t.client.query('RESET ROLE');
    const status = await t.client.query<{ review_status: string; reviewed_by: string | null }>(
      `SELECT review_status, reviewed_by::text AS reviewed_by FROM surveillance_hits
        WHERE hit_id = $1`,
      [hitId],
    );
    expect(status.rows[0]!.review_status).toBe('open');
    expect(status.rows[0]!.reviewed_by).toBeNull();
  });
});
