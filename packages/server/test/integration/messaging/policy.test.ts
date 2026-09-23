/**
 * MSG-03 — ethical walls, permitted counterparties, the external-firm rule, the join disclaimer
 * and the seven-year retention floor (WORKPLAN WP-09 acceptance row).
 *
 * Policy is enforced twice, on join and on send, and both are asserted here: a wall that is only
 * checked at the door lets anyone who was already inside keep talking after their desk moves.
 *
 * Each firm's own `firms.policy` governs what that firm's people may do. A cross-firm room is
 * therefore legal for one side and not the other until both have listed each other, which is what
 * a counterparty permission means in practice.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canJoin,
  canMessage,
  deskCarriesTag,
  messagingService,
  readFirmPolicy,
  RETENTION_FLOOR_DAYS,
  type MessagingService,
} from '../../../src/messaging/service.js';
import { testClock } from '../../../src/test/clock.js';
import { asUser, withTxDb } from '../../../src/test/db.js';

const t = withTxDb();

const CLOCK_START = Date.parse('2026-09-15T18:41:28Z');

interface Party {
  userId: number;
  firmId: number;
  firmName: string;
}

interface FirmSpec {
  permittedCounterpartyFirms?: string[];
  ethicalWalls?: { deskA: string; deskB: string }[];
  disclaimer?: string;
  retentionDays?: number;
}

async function createFirm(
  label: string,
  spec: FirmSpec = {},
): Promise<{ firmId: number; name: string }> {
  const name = `${label} ${randomUUID().slice(0, 6)}`;
  const policy = {
    permittedCounterpartyFirms: spec.permittedCounterpartyFirms ?? [],
    ethicalWalls: spec.ethicalWalls ?? [],
    ...(spec.disclaimer === undefined ? {} : { disclaimer: spec.disclaimer }),
  };
  const res = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name, policy, retention_days) VALUES ($1, $2::jsonb, $3) RETURNING firm_id`,
    [name, JSON.stringify(policy), spec.retentionDays ?? RETENTION_FLOOR_DAYS],
  );
  return { firmId: Number(res.rows[0]!.firm_id), name };
}

async function createUser(
  firm: { firmId: number; name: string },
  spec: { desk?: string | null; role?: string } = {},
): Promise<Party> {
  const res = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, desk, role)
     VALUES ($1, $2, $3, $4, $5) RETURNING user_id`,
    [
      firm.firmId,
      `pol-${randomUUID()}@demo.invalid`,
      `User ${randomUUID().slice(0, 6)}`,
      spec.desk ?? null,
      spec.role ?? 'user',
    ],
  );
  return { userId: Number(res.rows[0]!.user_id), firmId: firm.firmId, firmName: firm.name };
}

function service(): MessagingService {
  return messagingService({ db: t.db, clock: testClock(CLOCK_START) });
}

async function memberCount(roomId: number): Promise<number> {
  const res = await t.client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM room_members WHERE room_id = $1 AND left_at IS NULL`,
    [roomId],
  );
  return Number(res.rows[0]!.n);
}

describe('MSG-03 — ethical walls', () => {
  it("blocks a cross-desk join of a room whose wall_tag the joiner's desk does not carry", async () => {
    const firm = await createFirm('Demo Capital');
    const banker = await createUser(firm, { desk: 'ECM Syndicate' });
    const trader = await createUser(firm, { desk: 'Equities PM' });
    const msg = service();

    await asUser(t, banker.userId, firm.firmId);
    const room = await msg.createRoom({
      kind: 'group',
      name: 'Deal team',
      createdBy: banker.userId,
      memberUserIds: [],
      firmId: firm.firmId,
      wallTag: 'ECM',
    });
    expect(await memberCount(room.roomId)).toBe(1);

    await asUser(t, trader.userId, firm.firmId);
    const refusal = await msg.join(room.roomId, trader.userId).then(
      () => null,
      (err: unknown) =>
        err as { reason?: string; code?: string; status?: number; details?: unknown },
    );
    expect(refusal?.reason).toBe('ETHICAL_WALL');
    expect(refusal?.code).toBe('MESSAGE_POLICY_BLOCKED');
    expect(refusal?.status).toBe(403);
    expect(refusal?.details).toEqual({ rule: 'ethical_wall' });
    // Refused at the door: no membership row was written.
    expect(await memberCount(room.roomId)).toBe(1);

    // A desk that does carry the tag joins, and is shown the room's disclaimer.
    const analyst = await createUser(firm, { desk: 'ECM Execution' });
    await asUser(t, analyst.userId, firm.firmId);
    const joined = await msg.join(room.roomId, analyst.userId);
    expect(joined.members.map((m) => m.userId).sort()).toEqual(
      [banker.userId, analyst.userId].sort(),
    );
  });

  it('blocks a desk pair listed in firms.policy.ethicalWalls, on join and on send', async () => {
    const firm = await createFirm('Demo Capital', {
      ethicalWalls: [{ deskA: 'Research', deskB: 'Equities Trading' }],
    });
    const analyst = await createUser(firm, { desk: 'Research' });
    const trader = await createUser(firm, { desk: 'Equities Trading' });
    const msg = service();

    await asUser(t, analyst.userId, firm.firmId);
    const room = await msg.createRoom({
      kind: 'group',
      name: 'Research desk',
      createdBy: analyst.userId,
      memberUserIds: [],
      firmId: firm.firmId,
    });

    await asUser(t, trader.userId, firm.firmId);
    await expect(msg.join(room.roomId, trader.userId)).rejects.toMatchObject({
      reason: 'ETHICAL_WALL',
    });

    // The same wall is enforced on send, not only on join: a member whose desk moves behind a
    // wall after joining stops being able to talk.
    const colleague = await createUser(firm, { desk: 'Research' });
    await asUser(t, colleague.userId, firm.firmId);
    await msg.join(room.roomId, colleague.userId);
    await msg.send({
      roomId: room.roomId,
      senderUserId: colleague.userId,
      body: 'draft note attached',
      clientMsgId: randomUUID(),
    });

    await t.client.query(`UPDATE users SET desk = 'Equities Trading' WHERE user_id = $1`, [
      colleague.userId,
    ]);
    expect(await msg.sendBlockedReason(room.roomId, analyst.userId)).toBe('ETHICAL_WALL');
    await expect(
      msg.send({
        roomId: room.roomId,
        senderUserId: colleague.userId,
        body: 'and now from the trading desk',
        clientMsgId: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'ETHICAL_WALL' });
  });

  it('walls the newsroom from every other desk unconditionally (SEC-06)', async () => {
    const firm = await createFirm('Demo Capital');
    const trader = await createUser(firm, { desk: 'Equities PM' });
    const reporter = await createUser(firm, { desk: 'Newsroom', role: 'newsroom' });
    const msg = service();

    await asUser(t, trader.userId, firm.firmId);
    const room = await msg.createRoom({
      kind: 'group',
      name: 'Floor',
      createdBy: trader.userId,
      memberUserIds: [],
      firmId: firm.firmId,
    });

    await asUser(t, reporter.userId, firm.firmId);
    await expect(msg.join(room.roomId, reporter.userId)).rejects.toMatchObject({
      reason: 'ETHICAL_WALL',
    });
  });

  it('matches a wall tag by whole desk or by token, never by substring', () => {
    expect(deskCarriesTag('ECM', 'ecm')).toBe(true);
    expect(deskCarriesTag('ECM Syndicate', 'ECM')).toBe(true);
    expect(deskCarriesTag('Equities PM', 'ECM')).toBe(false);
    expect(deskCarriesTag('Research', 'sear')).toBe(false);
    expect(deskCarriesTag(null, 'ECM')).toBe(false);
  });
});

describe('MSG-03 — permitted counterparties and the external-firm rule', () => {
  it('refuses a counterparty firm that the joining firm has not permitted, and admits it once listed', async () => {
    const mine = await createFirm('Demo Capital');
    const theirs = await createFirm('Counterparty LLP');
    const me = await createUser(mine, { desk: 'Equities PM' });
    const them = await createUser(theirs, { desk: 'Sales' });
    const msg = service();

    await asUser(t, me.userId, mine.firmId);
    const room = await msg.createRoom({
      kind: 'group',
      name: 'Street chat',
      createdBy: me.userId,
      memberUserIds: [],
    });

    // Their firm has permitted nobody: the join is refused on the counterparty rule.
    await asUser(t, them.userId, theirs.firmId);
    const refusal = await msg.join(room.roomId, them.userId).then(
      () => null,
      (err: unknown) => err as { reason?: string; details?: unknown },
    );
    expect(refusal?.reason).toBe('MESSAGE_POLICY_BLOCKED');
    expect(refusal?.details).toEqual({ rule: 'counterparty' });

    await t.client.query(
      `UPDATE firms SET policy = jsonb_set(policy, '{permittedCounterpartyFirms}', $2::jsonb)
        WHERE firm_id = $1`,
      [theirs.firmId, JSON.stringify([mine.name])],
    );
    const joined = await msg.join(room.roomId, them.userId);
    expect(joined.members).toHaveLength(2);

    // My firm has still permitted nobody, so I may not send into the room they just joined.
    await asUser(t, me.userId, mine.firmId);
    expect(await msg.sendBlockedReason(room.roomId, me.userId)).toBe('MESSAGE_POLICY_BLOCKED');
    await expect(
      msg.send({
        roomId: room.roomId,
        senderUserId: me.userId,
        body: 'any colour on the open?',
        clientMsgId: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'MESSAGE_POLICY_BLOCKED' });

    await t.client.query(
      `UPDATE firms SET policy = jsonb_set(policy, '{permittedCounterpartyFirms}', $2::jsonb)
        WHERE firm_id = $1`,
      [mine.firmId, JSON.stringify([theirs.name])],
    );
    const sent = await msg.send({
      roomId: room.roomId,
      senderUserId: me.userId,
      body: 'any colour on the open?',
      clientMsgId: randomUUID(),
    });
    expect(sent.seq).toBe(1);
  });

  it('refuses an external room unless the room itself allows external members', async () => {
    const mine = await createFirm('Demo Capital', {
      permittedCounterpartyFirms: [],
    });
    const me = await createUser(mine, { desk: 'Equities PM' });
    const colleague = await createUser(mine, { desk: 'Equities PM' });
    const msg = service();

    await asUser(t, me.userId, mine.firmId);

    // The creator passes the same gate every joiner does (MSG-03): an external room whose own
    // policy forbids external members is a room nobody — including its creator — may be in, and
    // `createRoom` refuses it rather than seating the creator first and checking afterwards.
    const createRefusal = await msg
      .createRoom({
        kind: 'group',
        name: 'Street-wide',
        createdBy: me.userId,
        memberUserIds: [],
        scope: 'external',
      })
      .then(
        () => null,
        (err: unknown) => err as { reason?: string },
      );
    expect(createRefusal?.reason).toBe('EXTERNAL_NOT_PERMITTED');

    const room = await msg.createRoom({
      kind: 'group',
      name: 'Street-wide',
      createdBy: me.userId,
      memberUserIds: [],
      scope: 'external',
      allowExternal: true,
    });
    // …and the join rule is then exercised against the room as it stands, with `allowExternal`
    // taken back off the way a policy edit would.
    await t.client.query(
      `UPDATE rooms SET policy = jsonb_set(policy, '{allowExternal}', 'false'::jsonb)
        WHERE room_id = $1`,
      [room.roomId],
    );

    await asUser(t, colleague.userId, mine.firmId);
    const refusal = await msg.join(room.roomId, colleague.userId).then(
      () => null,
      (err: unknown) => err as { reason?: string; details?: unknown },
    );
    expect(refusal?.reason).toBe('EXTERNAL_NOT_PERMITTED');
    expect(refusal?.details).toEqual({ rule: 'external' });

    await t.client.query(
      `UPDATE rooms SET policy = jsonb_set(policy, '{allowExternal}', 'true'::jsonb)
        WHERE room_id = $1`,
      [room.roomId],
    );
    const joined = await msg.join(room.roomId, colleague.userId);
    expect(joined.scope).toBe('external');
  });

  it('narrows the firm list with the room list: a permitted firm can still be off this room', async () => {
    const mine = await createFirm('Demo Capital');
    const theirs = await createFirm('Counterparty LLP', {
      permittedCounterpartyFirms: [],
    });
    const other = await createFirm('Third Firm SA');
    const me = await createUser(mine, { desk: 'Equities PM' });
    const them = await createUser(theirs, { desk: 'Sales' });
    const msg = service();

    await t.client.query(
      `UPDATE firms SET policy = jsonb_set(policy, '{permittedCounterpartyFirms}', $2::jsonb)
        WHERE firm_id = $1`,
      [theirs.firmId, JSON.stringify([mine.name])],
    );

    await asUser(t, me.userId, mine.firmId);
    const room = await msg.createRoom({
      kind: 'group',
      name: 'Named counterparties only',
      createdBy: me.userId,
      memberUserIds: [],
      permittedFirms: [other.name],
    });

    await asUser(t, them.userId, theirs.firmId);
    await expect(msg.join(room.roomId, them.userId)).rejects.toMatchObject({
      reason: 'MESSAGE_POLICY_BLOCKED',
    });
  });

  it('shows the disclaimer on join, falling back to the firm policy', async () => {
    const firm = await createFirm('Demo Capital', {
      disclaimer: 'Messages are archived and monitored (MSG-03).',
    });
    const owner = await createUser(firm, { desk: 'Equities PM' });
    const joiner = await createUser(firm, { desk: 'Equities PM' });
    const msg = service();

    await asUser(t, owner.userId, firm.firmId);
    const firmDefault = await msg.createRoom({
      kind: 'group',
      name: 'No room disclaimer',
      createdBy: owner.userId,
      memberUserIds: [],
      firmId: firm.firmId,
    });
    const roomSpecific = await msg.createRoom({
      kind: 'group',
      name: 'With a room disclaimer',
      createdBy: owner.userId,
      memberUserIds: [],
      firmId: firm.firmId,
      disclaimer: 'This room is shared with an external counterparty.',
    });

    await asUser(t, joiner.userId, firm.firmId);
    const joinedDefault = await msg.join(firmDefault.roomId, joiner.userId);
    expect(joinedDefault.disclaimer).toBeNull();
    expect(await msg.disclaimerFor(firmDefault.roomId, joiner.userId)).toBe(
      'Messages are archived and monitored (MSG-03).',
    );

    const joinedRoom = await msg.join(roomSpecific.roomId, joiner.userId);
    expect(joinedRoom.disclaimer).toBe('This room is shared with an external counterparty.');
    expect(await msg.disclaimerFor(roomSpecific.roomId, joiner.userId)).toBe(
      'This room is shared with an external counterparty.',
    );
  });
});

describe('MSG-03 / REG-01 — the retention floor', () => {
  it('refuses a room created below seven years, and refuses to lower an existing room', async () => {
    const firm = await createFirm('Demo Capital');
    const owner = await createUser(firm, { desk: 'Equities PM' });
    const msg = service();
    await asUser(t, owner.userId, firm.firmId);

    await expect(
      msg.createRoom({
        kind: 'group',
        name: 'Short memory',
        createdBy: owner.userId,
        memberUserIds: [],
        firmId: firm.firmId,
        retentionDays: 365,
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      details: { field: 'retentionDays', requested: 365, floorDays: RETENTION_FLOOR_DAYS },
    });

    const room = await msg.createRoom({
      kind: 'group',
      name: 'Normal room',
      createdBy: owner.userId,
      memberUserIds: [],
      firmId: firm.firmId,
    });
    const stored = await t.client.query<{ retention_days: number }>(
      `SELECT retention_days FROM rooms WHERE room_id = $1`,
      [room.roomId],
    );
    expect(stored.rows[0]!.retention_days).toBe(RETENTION_FLOOR_DAYS);

    await expect(
      msg.setRetentionDays(room.roomId, RETENTION_FLOOR_DAYS - 1, owner.userId),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', details: { floorDays: RETENTION_FLOOR_DAYS } });

    // Raising it is allowed; the floor is a floor, not a value.
    const raised = await msg.setRetentionDays(room.roomId, 3_650, owner.userId);
    expect(raised.roomId).toBe(room.roomId);
    const after = await t.client.query<{ retention_days: number }>(
      `SELECT retention_days FROM rooms WHERE room_id = $1`,
      [room.roomId],
    );
    expect(after.rows[0]!.retention_days).toBe(3_650);
  });

  it("takes the firm's own longer retention as the floor", async () => {
    const firm = await createFirm('Long Memory LLP', { retentionDays: 3_000 });
    const owner = await createUser(firm, { desk: 'Equities PM' });
    const msg = service();
    await asUser(t, owner.userId, firm.firmId);

    const room = await msg.createRoom({
      kind: 'group',
      name: 'Firm floor',
      createdBy: owner.userId,
      memberUserIds: [],
      firmId: firm.firmId,
    });
    const stored = await t.client.query<{ retention_days: number }>(
      `SELECT retention_days FROM rooms WHERE room_id = $1`,
      [room.roomId],
    );
    expect(stored.rows[0]!.retention_days).toBe(3_000);

    // 2557 is the statutory floor but below this firm's own policy, so it is refused too.
    await expect(
      msg.setRetentionDays(room.roomId, RETENTION_FLOOR_DAYS, owner.userId),
    ).rejects.toMatchObject({ details: { floorDays: 3_000 } });
  });
});

describe('MSG-03 — the pure policy functions', () => {
  it('reads a malformed firms.policy as granting nothing', () => {
    expect(readFirmPolicy(null)).toEqual({
      permittedCounterpartyFirms: [],
      disclaimer: null,
      ethicalWalls: [],
    });
    expect(
      readFirmPolicy({ permittedCounterpartyFirms: 'Demo', ethicalWalls: [{ deskA: 1 }] }),
    ).toEqual({ permittedCounterpartyFirms: [], disclaimer: null, ethicalWalls: [] });
  });

  it('reports NOT_A_MEMBER last, after the policy rules', () => {
    const policy = { permittedCounterpartyFirms: [], disclaimer: null, ethicalWalls: [] };
    const me = {
      userId: 1,
      firmId: 1,
      firmName: 'Demo Capital',
      displayName: 'Me',
      desk: 'Equities PM',
      role: 'user' as const,
      firmPolicy: policy,
      firmRetentionDays: RETENTION_FLOOR_DAYS,
    };
    const room = {
      roomId: 9,
      kind: 'group' as const,
      name: 'Floor',
      scope: 'internal' as const,
      firmId: 1,
      wallTag: null,
      disclaimer: null,
      retentionDays: RETENTION_FLOOR_DAYS,
      permittedFirms: [],
      allowExternal: false,
      createdBy: 2,
      createdAt: '2026-09-15T18:41:28.000Z',
      members: [
        {
          userId: 2,
          firmId: 1,
          firmName: 'Demo Capital',
          displayName: 'Other',
          desk: 'Equities PM',
          role: 'user' as const,
        },
      ],
    };
    expect(canMessage(me, null, room)).toBe('NOT_A_MEMBER');
    // canJoin never reports NOT_A_MEMBER: membership is what is being asked for.
    expect(canJoin(me, room)).toBe('OK');
  });
});
