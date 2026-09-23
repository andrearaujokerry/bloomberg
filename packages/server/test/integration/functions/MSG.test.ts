/**
 * `test/integration/functions/MSG.test.ts` — rooms, the archive and MSG-04
 * (FUNCTIONS_TIER1.md §MSG).
 *
 * The claim this file exists for is MSG-04, and it is the one that is easy to get wrong in a way
 * nobody notices: **an attachment is a reference, resolved under the reader**. The same stored
 * message is read by two members of the same room with different entitlements, and the assertion
 * is deliberately two-sided — the *numbers* differ (`330.27` against `null` with `TIER_EOD`) while
 * the *label* and the *command* are byte-identical, so the recipient can still open what the
 * sender meant and hit the same denial with the same reason there. A resolver that stored the
 * sender's number would pass a test that only checked the label; a resolver that blanked the chip
 * entirely would pass a test that only checked the price.
 *
 * Around it: the hash chain verifies over the window (MSG-02); a room the caller is not a member
 * of degrades with `ROOM_NOT_A_MEMBER` rather than a 422, because MSG has no security to fail on;
 * a portfolio that was not shared resolves to a chip with `NOT_SHARED_WITH_YOU` and no command;
 * paging walks `seq` backwards with no row repeated; and the two absences v1 has — presence and
 * federation — are stated rather than faked.
 *
 * WP-15 owns the seed, so every firm, user, grant, room and message is created here.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden } from './golden.js';

import type { NormalisedUpdate, QuoteFields } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { MSG } from '@terminal/core/functions/manifests/MSG';
import type { MsgPayload } from '@terminal/core/functions/manifests/MSG';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as MSGModule from '../../../src/functions/MSG/resolve.js';
import { messagingService, type MessagingService } from '../../../src/messaging/service.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { asUser, withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS, seedQuoteInstrument } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const GOLDEN_NAME = 'MSG.default.json';

const REGISTRY = new FunctionRegistry([MSG]);
const MODULES: Record<string, FunctionServerModule<never, never>> = {
  MSG: MSGModule as unknown as FunctionServerModule<never, never>,
};

const AAPL_LAST = 330.27;
const AAPL_CLOSE = 333.07;
/** `CHG_PCT_1D` is derived by the plant from the pair and rounded there, never taken from the wire. */
const AAPL_CHG_PCT = -0.8407;
/** REG-01's floor: seven years, which a room may raise and never lower. */
const RETENTION_DAYS = 2557;
/** Enough history in the firm room that `limit` has more than one page to walk. */
const FIRM_NOTES = 25;
/** The plain notes plus the one shared security every member of the firm room can read. */
const FIRM_LAST_SEQ = FIRM_NOTES + 1;

const t: TestDb = withTxDb();

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  service: MessagingService;
  cookie: string;
  janeCookie: string;
  eodCookie: string;
  knownAt: string;
  firmId: number;
  pmId: number;
  janeId: number;
  eodId: number;
  outsiderId: number;
  firmRoomId: number;
  dmRoomId: number;
  otherRoomId: number;
  aapl: number;
  watchlistId: number;
  portfolioId: number;
}

let env: Env;

async function ensureLicences(): Promise<void> {
  const present = await t.client.query(
    `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
  );
  if (present.rowCount === 0) await seedLicences(t.client);
}

async function grantEverySource(
  firmId: number,
  userId: number,
  maxTier: 'realtime' | 'delayed' | 'eod',
): Promise<void> {
  await t.client.query(
    `INSERT INTO entitlement_grants
       (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
        usage_display, usage_export, usage_api, valid_from, valid_to)
     SELECT k.kind, k.id, l.source_id, NULL, NULL, $4::tier, true, true, true,
            $3::timestamptz, 'infinity'::timestamptz
       FROM (SELECT DISTINCT source_id FROM licence_registry WHERE tx_to = 'infinity') l
       CROSS JOIN (VALUES ('firm', $1::bigint), ('user', $2::bigint)) AS k(kind, id)`,
    [firmId, userId, GRANT_FROM, maxTier],
  );
}

async function createFirm(name: string, policy: unknown): Promise<number> {
  const res = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name, policy, retention_days) VALUES ($1, $2::jsonb, $3)
     RETURNING firm_id`,
    [name, JSON.stringify(policy), RETENTION_DAYS],
  );
  return Number(res.rows[0]!.firm_id);
}

async function createUser(
  firmId: number,
  displayName: string,
  desk: string | null,
): Promise<number> {
  const res = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, desk, role, person_verified_at)
     VALUES ($1, $2, $3, $4, 'user', now()) RETURNING user_id`,
    [firmId, `msg-${randomUUID()}@demo.invalid`, displayName, desk],
  );
  return Number(res.rows[0]!.user_id);
}

async function createSession(userId: number): Promise<string> {
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  return `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`;
}

function quote(
  instrumentId: number,
  mdLineId: number,
  provenanceId: number,
  fields: Partial<QuoteFields>,
): NormalisedUpdate {
  return {
    subject: `q:${String(instrumentId)}`,
    instrumentId,
    mdLineId,
    assetClass: 'equity',
    tier: 'delayed',
    fields,
    ts: { src: GOLDEN_CAPTURE_MS - 900_000, cap: GOLDEN_CAPTURE_MS, pub: 0 },
    prov: { sourceId: 'cboe.quotes', provenanceId },
  };
}

beforeEach(async () => {
  await ensureLicences();

  const firmName = `Demo Capital ${randomUUID().slice(0, 6)}`;
  const permittedName = `Permitted Bank ${randomUUID().slice(0, 6)}`;
  const firmId = await createFirm(firmName, {
    permittedCounterpartyFirms: [permittedName],
    disclaimer: 'Messages are archived and monitored.',
    ethicalWalls: [{ deskA: 'Equities PM', deskB: 'Research' }],
  });
  const outsideFirmId = await createFirm(`Other Bank ${randomUUID().slice(0, 6)}`, {});

  const pmId = await createUser(firmId, 'Alex Pardo', 'Equities PM');
  const janeId = await createUser(firmId, 'Jane Ruiz', 'Equities PM');
  const eodId = await createUser(firmId, 'Eve Odell', 'Equities PM');
  const outsiderId = await createUser(outsideFirmId, 'Otto Sider', 'Sales');

  await grantEverySource(firmId, pmId, 'realtime');
  await grantEverySource(firmId, janeId, 'realtime');
  // The same firm grant is already realtime; the *user* grant caps this reader at end-of-day,
  // which is exactly the ENTL-05 downgrade MSG-04 has to survive.
  await t.client.query(
    `INSERT INTO entitlement_grants
       (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
        usage_display, usage_export, usage_api, valid_from, valid_to)
     SELECT 'user', $1::bigint, l.source_id, NULL, NULL, 'eod'::tier, true, true, true,
            $2::timestamptz, 'infinity'::timestamptz
       FROM (SELECT DISTINCT source_id FROM licence_registry WHERE tx_to = 'infinity') l`,
    [eodId, GRANT_FROM],
  );

  const aapl = await seedQuoteInstrument(t, { ticker: 'AAPL', name: 'Apple Inc' });

  const watchlist = await t.client.query<{ watchlist_id: string }>(
    `INSERT INTO watchlists (owner_user_id, firm_id, name, columns, shared_scope)
     VALUES ($1, $2, 'Core', '[{"id":"PX_LAST"}]'::jsonb, 'firm') RETURNING watchlist_id`,
    [pmId, firmId],
  );
  const watchlistId = Number(watchlist.rows[0]!.watchlist_id);
  // A portfolio reference the reader cannot read. The resolver sees the same thing whether the
  // row is hidden by `portfolios_tenant` RLS or no longer exists — no row comes back — and both
  // must render as a chip that says so rather than as a broken one. (The integration harness runs
  // as the database owner, which bypasses non-FORCE RLS, so the unreadable case is expressed as
  // an id that resolves to nothing; `test/integration/workspaces` owns the RLS proof itself.)
  const owned = await t.client.query<{ portfolio_id: string }>(
    `INSERT INTO portfolios (firm_id, owner_user_id, name) VALUES ($1, $2, 'Demo Fund I')
     RETURNING portfolio_id`,
    [outsideFirmId, outsiderId],
  );
  const portfolioId = Number(owned.rows[0]!.portfolio_id) + 1_000_000;

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const service = messagingService({ db: t.db, clock });

  await asUser(t, pmId, firmId);
  const firmRoom = await service.createRoom({
    kind: 'firm',
    name: firmName,
    createdBy: pmId,
    memberUserIds: [janeId, eodId],
    firmId,
    disclaimer: 'Messages are archived and monitored.',
    retentionDays: RETENTION_DAYS,
  });
  const dmRoom = await service.createRoom({
    kind: 'dm',
    name: null,
    createdBy: pmId,
    memberUserIds: [janeId],
    firmId,
  });
  // A room the caller is NOT a member of, for the ROOM_NOT_A_MEMBER degradation.
  await asUser(t, janeId, firmId);
  const otherRoom = await service.createRoom({
    kind: 'group',
    name: 'Jane and Eve',
    createdBy: janeId,
    memberUserIds: [eodId],
    firmId,
  });

  await asUser(t, pmId, firmId);
  for (let i = 0; i < FIRM_NOTES; i += 1) {
    await service.send({
      roomId: firmRoom.roomId,
      senderUserId: i % 2 === 0 ? pmId : janeId,
      body: `firm note ${String(i + 1)}`,
      clientMsgId: randomUUID(),
    });
  }

  // One shared security in the room ALL THREE members belong to: the same stored message read by
  // two people with different grants is what MSG-04 is about.
  await service.send({
    roomId: firmRoom.roomId,
    senderUserId: pmId,
    body: 'desk copy',
    attachments: [{ kind: 'security', instrumentId: aapl.instrumentId }],
    clientMsgId: randomUUID(),
  });

  // The dm carries the four attachment shapes MSG-04 has to resolve, and one IOI.
  await service.send({
    roomId: dmRoom.roomId,
    senderUserId: janeId,
    body: 'morning — flagging the print on the open',
    clientMsgId: randomUUID(),
  });
  await service.send({
    roomId: dmRoom.roomId,
    senderUserId: pmId,
    body: 'here it is',
    attachments: [
      { kind: 'security', instrumentId: aapl.instrumentId },
      { kind: 'chart', instrumentId: aapl.instrumentId, params: { range: '1Y' }, annotationIds: [] },
      { kind: 'watchlist', watchlistId },
      { kind: 'portfolio', portfolioId },
      { kind: 'function', code: 'ZZQQ', instrumentId: null, params: {} },
    ],
    clientMsgId: randomUUID(),
  });
  await service.send({
    roomId: dmRoom.roomId,
    senderUserId: janeId,
    body: '',
    structured: {
      type: 'ioi',
      side: 'buy',
      instrumentId: aapl.instrumentId,
      qty: 25_000,
      price: 330,
    },
    clientMsgId: randomUUID(),
  });
  // Jane has read everything; the pm has read nothing in the firm room.
  await service.markRead(dmRoom.roomId, pmId, 2);

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };
  const quoteProv = await bootstrapProvenance(t, 'cboe.quotes', 'msg-quote');
  harness.deps.plant.apply(
    quote(aapl.instrumentId, aapl.mdLineId, quoteProv, {
      PX_LAST: AAPL_LAST,
      PX_CLOSE_1D: AAPL_CLOSE,
    }),
  );

  env = {
    harness,
    app: harness.app,
    clock,
    service,
    cookie: await createSession(pmId),
    janeCookie: await createSession(janeId),
    eodCookie: await createSession(eodId),
    knownAt,
    firmId,
    pmId,
    janeId,
    eodId,
    outsiderId,
    firmRoomId: firmRoom.roomId,
    dmRoomId: dmRoom.roomId,
    otherRoomId: otherRoom.roomId,
    aapl: aapl.instrumentId,
    watchlistId,
    portfolioId,
  };
});

afterEach(async () => {
  await env.harness?.close();
});

interface Run {
  data: MsgPayload;
  meta: {
    provenance: { sourceId: string }[];
    unavailable: { field: string; reason: string; detail: string }[];
    page?: { index: number; count: number; cursor: string | null };
    resultId: string;
  };
}

type Who = 'pm' | 'jane' | 'eod';

async function runMsg(params: Record<string, unknown> = {}, who: Who = 'pm'): Promise<Run> {
  const cookies = { pm: env.cookie, jane: env.janeCookie, eod: env.eodCookie };
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/MSG/run`,
    headers: { cookie: cookies[who], 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

async function pageMsg(resultId: string, direction: 'fwd' | 'back'): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/MSG/page`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { resultId, direction },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

function normalise(payload: MsgPayload): unknown {
  const tokens = new Map<number, string>([
    [env.firmId, '<FIRM>'],
    [env.pmId, '<PM>'],
    [env.janeId, '<JANE>'],
    [env.eodId, '<EOD>'],
    [env.firmRoomId, '<FIRMROOM>'],
    [env.dmRoomId, '<DM>'],
    [env.otherRoomId, '<OTHERROOM>'],
    [env.aapl, '<AAPL>'],
    [env.watchlistId, '<WATCHLIST>'],
    [env.portfolioId, '<PORTFOLIO>'],
  ]);
  return JSON.parse(
    JSON.stringify(payload, (key, value: unknown) => {
      // Identity values and wall-clock instants are the row's own, not the payload's claim.
      if (key === 'messageId' || key === 'clientMsgId' || key === 'hash' || key === 'prevHash') {
        return value === null ? null : '<VOLATILE>';
      }
      if (key === 'sentAt' || key === 'lastMessageAt') return value === null ? null : '<VOLATILE>';
      if (key === 'createdAt' || key === 'firmName' || key === 'senderFirmName' || key === 'name') {
        return typeof value === 'string' && value.startsWith('Demo Capital')
          ? '<FIRMNAME>'
          : '<VOLATILE>';
      }
      if (key === 'permittedCounterpartyFirms') return ['<PERMITTED>'];
      // A number is an id only under a key that names one. Tokenising *every* number that
      // happens to equal a sequence-allocated id makes the golden a function of the database's
      // sequence state rather than of the payload: the run on which `chat_rooms` reached 330
      // rewrote the seeded IOI's `price: 330` as `<OTHERROOM>`. This is the number-valued twin
      // of the subject-shape rule `golden.ts` documents for strings.
      if (typeof value === 'number' && key.endsWith('Id') && tokens.has(value)) {
        return tokens.get(value);
      }
      if (typeof value === 'string') {
        let out = value;
        for (const [id, token] of tokens) out = out.split(String(id)).join(token);
        return out;
      }
      return value;
    }),
  );
}

describe('MSG — rooms, the archive and MSG-04 attachments', () => {
  it('lists every room the caller is a member of, with unread counts and previews', async () => {
    const { data } = await runMsg();

    expect(data.variant).toBe('default');
    expect(data.me.userId).toBe(env.pmId);
    expect(data.me.desk).toBe('Equities PM');
    expect(data.rooms.map((r) => r.roomId)).toEqual([env.dmRoomId, env.firmRoomId]);
    expect(data.rooms.some((r) => r.roomId === env.otherRoomId)).toBe(false);
    expect(data.totals.rooms).toBe(2);

    const dm = data.rooms.find((r) => r.roomId === env.dmRoomId)!;
    // A dm has no stored name: the counterparty is the name.
    expect(dm.kind).toBe('dm');
    expect(dm.name).toBe('Jane Ruiz');
    expect(dm.subject).toBe(`room:${String(env.dmRoomId)}`);
    expect(dm.lastSeq).toBe(3);
    expect(dm.lastReadSeq).toBe(2);
    expect(dm.unread).toBe(1);

    const firm = data.rooms.find((r) => r.roomId === env.firmRoomId)!;
    expect(firm.unread).toBe(FIRM_LAST_SEQ);
    // The preview renders an attachment as a chip, which is what the room list actually shows.
    expect(firm.lastMessagePreview).toBe('desk copy [AAPL US Equity]');
    expect(firm.retentionDays).toBe(RETENTION_DAYS);
    expect(data.totals.unread).toBe(FIRM_LAST_SEQ + 1);
  });

  it('opens the most recently active room and verifies its chain (MSG-02)', async () => {
    const { data } = await runMsg();

    expect(data.active?.room.roomId).toBe(env.dmRoomId);
    const messages = data.active!.messages;
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    for (const message of messages) {
      expect(message.chainOk).toBe(true);
      expect(message.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(messages[0]!.prevHash).toBeNull();
    expect(messages[1]!.prevHash).toBe(messages[0]!.hash);
    expect(messages[0]!.isOwn).toBe(false);
    expect(messages[1]!.isOwn).toBe(true);
    expect(messages[2]!.unread).toBe(true);
    expect(data.active?.canSend).toBe(true);
    expect(data.active?.sendBlockedReason).toBe('OK');
  });

  it('resolves every attachment shape as a reference (MSG-04)', async () => {
    const { data, meta } = await runMsg();
    const chips = data.active!.messages[1]!.attachments;

    expect(chips.map((c) => c.kind)).toEqual([
      'security',
      'chart',
      'watchlist',
      'portfolio',
      'function',
    ]);

    const security = chips[0]!;
    expect(security.label).toBe('AAPL US Equity');
    expect(security.command).toBe('AAPL US Equity DES');
    expect(security.subject).toBe(`q:${String(env.aapl)}`);
    expect(security.px?.v).toBe(AAPL_LAST);
    expect(security.px?.live).toEqual({ subject: `q:${String(env.aapl)}`, field: 'PX_LAST' });
    expect(security.chgPct?.v).toBe(AAPL_CHG_PCT);
    expect(security.resolvable).toBe(true);

    const chart = chips[1]!;
    expect(chart.label).toBe('GP · AAPL US Equity · 1Y');
    expect(chart.command).toBe('AAPL US Equity GP RANGE=1Y');
    expect(chart.code).toBe('GP');

    expect(chips[2]!.label).toBe('Core');
    expect(chips[2]!.command).toBe(`W ${String(env.watchlistId)}`);

    // RLS hides the other firm's portfolio: the chip says so and offers no command.
    const portfolio = chips[3]!;
    expect(portfolio.resolvable).toBe(false);
    expect(portfolio.reason).toBe('NOT_SHARED_WITH_YOU');
    expect(portfolio.command).toBeNull();

    const unknown = chips[4]!;
    expect(unknown.resolvable).toBe(false);
    expect(unknown.reason).toBe('FUNCTION_NOT_FOUND');

    expect(meta.unavailable.map((u) => u.detail)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('NOT_SHARED_WITH_YOU'),
        expect.stringContaining('FUNCTION_NOT_FOUND'),
      ]),
    );
  });

  it('shows two readers of the same message different numbers and the same chip', async () => {
    const pm = await runMsg({ roomId: env.firmRoomId, limit: 20 });
    const eod = await runMsg({ roomId: env.firmRoomId, limit: 20 }, 'eod');

    const lastOf = (run: Run): (typeof run.data.active)['messages'][number] =>
      run.data.active!.messages[run.data.active!.messages.length - 1]!;
    expect(lastOf(pm).seq).toBe(FIRM_LAST_SEQ);
    const mine = lastOf(pm).attachments[0]!;
    const theirs = lastOf(eod).attachments[0]!;

    // The reference is the same object for both readers…
    expect(theirs.label).toBe(mine.label);
    expect(theirs.command).toBe(mine.command);
    expect(theirs.subject).toBe(mine.subject);
    // …and the number is not (ENTL-05: a downgrade yields a blank with the reason, never the
    // higher tier's value).
    expect(mine.px?.v).toBe(AAPL_LAST);
    expect(theirs.px?.v).toBeNull();
    expect(theirs.px?.r).toBe('TIER_EOD');
    expect(theirs.chgPct?.v).toBeNull();
    // The IOI's context price follows the same rule, in the dm both PMs share.
    const ioiPm = await runMsg({ roomId: env.dmRoomId });
    expect(ioiPm.data.active!.messages[2]!.structured?.px?.v).toBe(AAPL_LAST);
  });

  it('renders a structured message as display only (MSG-06)', async () => {
    const { data, meta } = await runMsg();
    const ioi = data.active!.messages[2]!.structured!;

    expect(ioi.type).toBe('ioi');
    expect(ioi.side).toBe('buy');
    expect(ioi.qty).toBe(25_000);
    expect(ioi.price).toBe(330);
    expect(ioi.display).toBe('AAPL US Equity');
    expect(meta.unavailable).toContainEqual({
      field: 'structured',
      reason: 'NOT_APPLICABLE',
      detail:
        'IOI_DISPLAY_ONLY: structured messages are displayed, never routed — execution is out of ' +
        'scope (MSG-06, BRIEF §1)',
    });
  });

  it('states the firm policy, and the two things v1 does not have', async () => {
    const { data, meta } = await runMsg();

    expect(data.policy.retentionDays).toBe(RETENTION_DAYS);
    expect(data.policy.archived).toBe(true);
    expect(data.policy.surveillance).toBe(true);
    expect(data.policy.federation).toBe('NOT_IN_SCOPE_V1');
    expect(data.policy.legalHoldActive).toBe(false);
    expect(data.policy.ethicalWalls).toEqual([{ deskA: 'Equities PM', deskB: 'Research' }]);

    expect(meta.unavailable.map((u) => u.detail)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('PRESENCE_NOT_AVAILABLE'),
        expect.stringContaining('FEDERATION_NOT_IN_SCOPE_V1'),
      ]),
    );
  });

  it('reports an open legal hold over the caller', async () => {
    await t.client.query(
      `INSERT INTO legal_holds (firm_id, scope, reason, created_by)
       VALUES ($1, $2::jsonb, 'investigation', $3)`,
      [env.firmId, JSON.stringify({ userIds: [env.pmId] }), env.pmId],
    );
    const { data } = await runMsg();
    expect(data.policy.legalHoldActive).toBe(true);
  });

  it('degrades a room the caller is not a member of, rather than failing', async () => {
    const { data, meta } = await runMsg({ roomId: env.otherRoomId });

    expect(data.active).toBeNull();
    expect(meta.unavailable).toContainEqual({
      field: 'active',
      reason: 'NOT_APPLICABLE',
      detail: `ROOM_NOT_A_MEMBER: you are not a member of room ${String(env.otherRoomId)}`,
    });
    // The room list still paints — MSG has no security context to fail on.
    expect(data.rooms).toHaveLength(2);
  });

  it('filters the room list by name and by unread', async () => {
    // The filter matches room names AND member display names, so a name that appears in only one
    // room is the honest probe: 'Jane Ruiz' is a member of both.
    const byName = await runMsg({ filter: 'Eve' });
    expect(byName.data.rooms.map((r) => r.roomId)).toEqual([env.firmRoomId]);
    // `totals.rooms` counts membership, not the filtered view.
    expect(byName.data.totals.rooms).toBe(2);

    const unread = await runMsg({ unreadOnly: true, roomId: env.firmRoomId });
    expect(unread.data.rooms.every((r) => r.unread > 0)).toBe(true);
  });

  it('pages the archive backwards by seq with no message repeated', async () => {
    const first = await runMsg({ roomId: env.firmRoomId, limit: 20 });
    expect(first.data.active!.messages.map((m) => m.seq)).toEqual(
      Array.from({ length: 20 }, (_unused, i) => i + FIRM_LAST_SEQ - 19),
    );
    expect(first.meta.page?.index).toBe(0);
    expect(first.meta.page?.count).toBe(Math.ceil(FIRM_LAST_SEQ / 20));

    const older = await pageMsg(first.meta.resultId, 'fwd');
    const seqs = older.data.active!.messages.map((m) => m.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
    expect(older.meta.page?.index).toBe(1);
    expect(older.data.active?.olderCursor).toBeNull();
    // PAGE FWD is older: nothing from the first window comes back.
    for (const seq of seqs) expect(seq).toBeLessThan(FIRM_LAST_SEQ - 19);
  });

  it('answers the directory with a policy verdict per counterparty (MSG-01, MSG-03)', async () => {
    const { data } = await runMsg({ view: 'directory', filter: 'Otto' });

    expect(data.view).toBe('directory');
    const otto = data.directory.find((d) => d.userId === env.outsiderId)!;
    expect(otto.verified).toBe(true);
    // Another firm, not on the permitted-counterparty list.
    expect(otto.canMessage).toBe(false);
    expect(otto.blockedReason).toBe('MESSAGE_POLICY_BLOCKED');
    expect(data.totals.directoryMatches).toBe(data.directory.length);
  });

  it('opens the dm behind a directory name, and offers the directory when none exists', async () => {
    const existing = await runMsg({ to: 'Jane Ruiz' });
    expect(existing.data.active?.room.roomId).toBe(env.dmRoomId);
    expect(existing.data.directory.map((d) => d.userId)).toContain(env.janeId);

    // No dm with Eve yet: the resolver does not create one — the composer does, on first send.
    const none = await runMsg({ to: 'Eve Odell' });
    expect(none.data.active).toBeNull();
    expect(none.data.view).toBe('directory');
  });

  it('subscribes to every room and to each attachment instrument', async () => {
    const { data } = await runMsg();
    const live = MSG.live!(
      { roomId: null, to: null, view: 'split', limit: 50, filter: '', unreadOnly: false },
      data,
    )!;

    expect(live.subjects).toContain(`room:${String(env.dmRoomId)}`);
    expect(live.subjects).toContain(`room:${String(env.firmRoomId)}`);
    expect(live.subjects).toContain(`q:${String(env.aapl)}`);
    expect(live.fields).toContain('PX_LAST');
    expect(live.essential).toEqual([`room:${String(env.dmRoomId)}`]);
    expect(live.conflationMs).toBe(250);
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    const { data } = await runMsg();
    expectGolden(GOLDEN_NAME, normalise(data));
  });
});
