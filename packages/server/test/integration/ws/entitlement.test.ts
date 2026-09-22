/**
 * Entitlement on subscribe: downgrade reason codes, tier views and a grant revoked mid-session
 * (ENTL-05, BUS-06; TESTING.md §10 rows 14-15, API.md §6.6 L999-1011 and §6.8 L1058-1063,
 * ARCHITECTURE §10 rules 3-6).
 *
 * The evaluator under test is a *port*: WP-07 owns the real one, and these tests drive
 * `helpers.ts#fakeEntitlements`, which implements exactly ARCHITECTURE §10 rules 3-6 (source
 * ceiling, firm contract, user subscription, `min` intersection). What is under test is everything
 * the gateway does *with* a decision — the `downgrade` frame, `subAck.accepted[].reason`, the tier
 * projection in `snap`, the 60 s `eod` floor, the blank subject, the `NOT_ENTITLED` rejection —
 * because that is what a client sees and what WP-07 must keep true when it replaces the fake.
 *
 * The rule the whole file exists to pin is the last line of API.md §6.6: **a downgrade always
 * yields the lower tier's fresh value or a blank, never a stale higher-tier value.** It is asserted
 * positively (the delayed view is the live price) and negatively (an `eod` view frozen before a
 * 400.50 print never carries 400.50, on a plant that demonstrably holds it).
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { EntitlementDecision, EntitlementRequest } from '@terminal/core';
import type { Delta, ServerMsg, Snap } from '@terminal/sdk/wire/ws';

import { getConfig } from '../../../src/config.js';
import { buildPlant, type Plant } from '../../../src/plant/tickerPlant.js';
import { SimFeed } from '../../../src/providers/sim/feed.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';
import type { WsEntitlements, WsLimits } from '../../../src/ws/session.js';
import {
  applyAaplGolden,
  createApiSession,
  createWebSession,
  fakeEntitlements,
  GOLDEN_CAPTURE_MS,
  mutableEntitlements,
  seedQuoteInstrument,
  sleep,
  startWsApp,
  WsClient,
  type FakeGrant,
  type SeededInstrument,
  type StartedWsApp,
} from './helpers.js';

const t = withTxDb();

type SubAck = Extract<ServerMsg, { t: 'subAck' }>;
type Downgrade = Extract<ServerMsg, { t: 'downgrade' }>;
type Resync = Extract<ServerMsg, { t: 'resync' }>;

/** The field set of the API.md §6.8 example plus the six `eod` fields. */
const FIELDS = [
  'PX_LAST',
  'PX_BID',
  'PX_ASK',
  'CHG_PCT_1D',
  'PX_OFFICIAL_CLOSE',
  'PX_CLOSE_1D',
  'PX_VOLUME',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
];

/** The six an `eod` view may carry (`plant/eod.ts#EOD_FIELD_IDS`). */
const EOD_FIELDS = [
  'PX_OFFICIAL_CLOSE',
  'PX_CLOSE_1D',
  'PX_VOLUME',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
];

/** Everything else the tests subscribe to: `null` with `r:'TIER_EOD'` for an eod subscriber. */
const NON_EOD_FIELDS = FIELDS.filter((f) => !EOD_FIELDS.includes(f));

const CONFLATION_MS = 50;

interface Harness {
  clock: VirtualClock;
  plant: Plant;
  instrument: SeededInstrument;
  subject: string;
  app: StartedWsApp;
  userId: number;
  firmId: number;
}

let live: { app: StartedWsApp; clients: WsClient[]; feed?: SimFeed } | null = null;

afterEach(async () => {
  if (live === null) return;
  live.feed?.stop();
  for (const client of live.clients) await client.close();
  await live.app.close();
  live = null;
});

/**
 * A seeded instrument carrying the recorded AAPL quote, an app with `entitlements` wired, and one
 * open socket that has already exchanged `hello`/`welcome`.
 */
async function boot(opts: {
  ticker: string;
  entitlements: WsEntitlements;
  kind?: 'web' | 'api';
  email?: string;
  limits?: Partial<WsLimits>;
}): Promise<Harness & { client: WsClient }> {
  const clock = testClock(GOLDEN_CAPTURE_MS);
  const plant = buildPlant({ config: getConfig(), clock });
  const instrument = await seedQuoteInstrument(t, { ticker: opts.ticker });
  await applyAaplGolden(plant, instrument);

  const app = await startWsApp({
    t,
    clock,
    plant,
    entitlements: opts.entitlements,
    limits: { sweepMs: 250, ...opts.limits },
  });
  live = { app, clients: [] };

  const kind = opts.kind ?? 'web';
  const session =
    kind === 'web'
      ? await createWebSession(t, opts.email === undefined ? {} : { email: opts.email })
      : await createApiSession(t, opts.email === undefined ? {} : { email: opts.email });

  const client = await connect(app, session);
  return {
    clock,
    plant,
    instrument,
    subject: instrument.subject,
    app,
    client,
    userId: session.userId,
    firmId: session.firmId,
  };
}

/** One more socket on a running app — a second subscriber with its own principal. */
async function connect(
  app: StartedWsApp,
  session: { token: string; cookie?: string },
): Promise<WsClient> {
  const client = new WsClient(
    app.url,
    session.cookie === undefined ? { bearer: session.token } : { cookie: session.cookie },
  );
  live?.clients.push(client);
  await client.open();
  client.send({ t: 'hello', protocol: 1, client: 'web/0.1.0', conflationMs: CONFLATION_MS });
  await client.next((f) => f.t === 'welcome');
  return client;
}

function sub(
  client: WsClient,
  id: number,
  subject: string,
  tier: 'realtime' | 'delayed' | 'eod' | undefined,
  fields: string[] = FIELDS,
): void {
  client.send({
    t: 'sub',
    id,
    ...(tier === undefined ? {} : { tier }),
    subjects: [{ s: subject, f: fields }],
  });
}

async function ackFor(client: WsClient, id: number): Promise<SubAck> {
  return (await client.next((f) => f.t === 'subAck' && f.id === id)) as SubAck;
}

async function snapFor(client: WsClient, subject: string): Promise<Snap> {
  return (await client.next((f) => f.t === 'snap' && f.s === subject)) as Snap;
}

/**
 * One evaluator for a whole app, answering differently per user — what two subscribers with
 * different grants on the *same* plant need (ARCHITECTURE §10 rule 5: grants are on `user_id`).
 * The per-user rules are registered after `boot`, because a user id only exists once its session
 * has been seeded, and `evaluate` is not called until the first `sub`.
 */
function perUser(fallback: FakeGrant): WsEntitlements & {
  grant(userId: number, g: FakeGrant): void;
} {
  const byId = new Map<number, WsEntitlements>();
  const base = fakeEntitlements(fallback);
  return {
    evaluate(req: EntitlementRequest): Promise<EntitlementDecision> {
      return (byId.get(req.userId) ?? base).evaluate(req);
    },
    grant(userId: number, g: FakeGrant): void {
      byId.set(userId, fakeEntitlements(g));
    },
  };
}

function downgrades(client: WsClient): Downgrade[] {
  return client.frames.filter((f): f is Downgrade => f.t === 'downgrade');
}

function deltasFor(client: WsClient, subject: string): Delta[] {
  return client.frames.filter((f): f is Delta => f.t === 'delta' && f.s === subject);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row 14 — downgrade reason codes
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ws entitlement — the source ceiling (ARCHITECTURE §10 rule 3, ENTL-05)', () => {
  it('downgrades a realtime request on a Cboe subject to delayed with SOURCE_TIER_CAP', async () => {
    // A PM whose firm and user grants are both `realtime`. No v1 source can serve it: the licence
    // ceiling on `cboe.quotes` is `delayed` (API.md §6.6, first row), so the ceiling is what binds.
    const h = await boot({
      ticker: 'AAPL',
      email: 'pm@demo.invalid',
      entitlements: fakeEntitlements({
        firmTier: 'realtime',
        userTier: 'realtime',
        sourceCap: 'delayed',
      }),
    });

    sub(h.client, 1, h.subject, 'realtime');
    const ack = await ackFor(h.client, 1);

    expect(ack.rejected).toEqual([]);
    expect(ack.accepted).toEqual([{ s: h.subject, tier: 'delayed', reason: 'SOURCE_TIER_CAP' }]);

    const snap = await snapFor(h.client, h.subject);
    expect(downgrades(h.client)).toEqual([
      { t: 'downgrade', s: h.subject, from: 'realtime', to: 'delayed', reason: 'SOURCE_TIER_CAP' },
    ]);

    // The lower tier's *fresh* value, not a blank and not a stale one (API.md §6.6 last line).
    expect(snap.tier).toBe('delayed');
    expect(snap.reason).toBe('SOURCE_TIER_CAP');
    expect(snap.st).toBe('live');
    expect(snap.f.PX_LAST).toBe(330.27);
    expect(snap.f.PX_CLOSE_1D).toBe(333.08);
    expect(snap.r?.PX_LAST ?? 'OK').toBe('OK');

    // Exactly one downgrade — one subject, one decision, one frame.
    await sleep(120);
    expect(downgrades(h.client)).toHaveLength(1);
  });

  it('reports NOT_ENTITLED_TIER when the grant, not the licence, is what binds', async () => {
    // Firm `delayed`, user `eod`: the intersection (ARCHITECTURE §10 rule 5) is `eod`, which is
    // below the `delayed` licence ceiling, so the *grant* is the binding cap.
    const h = await boot({
      ticker: 'MSFT',
      email: 'capped@demo.invalid',
      entitlements: fakeEntitlements({
        firmTier: 'delayed',
        userTier: 'eod',
        sourceCap: 'delayed',
      }),
    });

    sub(h.client, 2, h.subject, 'delayed');
    const ack = await ackFor(h.client, 2);

    expect(ack.rejected).toEqual([]);
    expect(ack.accepted).toEqual([{ s: h.subject, tier: 'eod', reason: 'NOT_ENTITLED_TIER' }]);
    expect(downgrades(h.client)).toEqual([
      { t: 'downgrade', s: h.subject, from: 'delayed', to: 'eod', reason: 'NOT_ENTITLED_TIER' },
    ]);
  });
});

describe('ws entitlement — the eod tier view (API.md §6.6, §6.8 L1058-1063)', () => {
  it('populates only the six close fields; everything else is null with TIER_EOD and st closed', async () => {
    const h = await boot({
      ticker: 'IBM',
      email: 'eod@demo.invalid',
      entitlements: fakeEntitlements({ firmTier: 'eod', userTier: 'eod', sourceCap: 'delayed' }),
    });
    // The official close the eod tier is frozen on (`plant/eod.ts`), captured before anyone subs.
    const eod = h.plant.captureEod(h.subject, '2026-09-14', GOLDEN_CAPTURE_MS - 86_400_000);
    expect(eod).not.toBeNull();

    sub(h.client, 3, h.subject, 'delayed');
    const ack = await ackFor(h.client, 3);
    expect(ack.accepted).toEqual([{ s: h.subject, tier: 'eod', reason: 'NOT_ENTITLED_TIER' }]);

    const snap = await snapFor(h.client, h.subject);
    expect(snap.tier).toBe('eod');
    expect(snap.st).toBe('closed');
    expect(snap.session).toBe('closed');

    // The six the fixture supplies, at the frozen close — `PX_OFFICIAL_CLOSE` from the last print.
    expect(snap.f.PX_OFFICIAL_CLOSE).toBe(330.27);
    expect(snap.f.PX_CLOSE_1D).toBe(333.08);
    expect(snap.f.PX_VOLUME).toBe(16_591_786);
    expect(snap.f.PX_OPEN).toBe(330.24);
    expect(snap.f.PX_HIGH).toBe(331.59);
    expect(snap.f.PX_LOW).toBe(328.35);

    for (const id of EOD_FIELDS) {
      expect(snap.r?.[id]).toBeUndefined();
      expect(snap.fts?.[id]).toBe(GOLDEN_CAPTURE_MS - 86_400_000);
    }
    // Every other requested field: null, and the reason says why (never a stale number).
    for (const id of NON_EOD_FIELDS) {
      expect(snap.f[id]).toBeNull();
      expect(snap.r?.[id]).toBe('TIER_EOD');
    }
    expect(snap.ts.src).toBe(GOLDEN_CAPTURE_MS - 86_400_000);
  });

  it('flushes an eod subscriber at most once per 60 virtual seconds while a feed runs', async () => {
    const entitlements = perUser({ firmTier: 'eod', userTier: 'eod', sourceCap: 'delayed' });
    const h = await boot({
      ticker: 'ORCL',
      email: 'eod-floor@demo.invalid',
      // A very long idle timeout: this test advances the clock by 150 virtual seconds without the
      // client speaking, and the 45 s idle rule (tested in limits.test.ts) is not what is under
      // test here.
      limits: { sweepMs: 100, idleTimeoutMs: 600_000 },
      entitlements,
    });
    h.plant.captureEod(h.subject, '2026-09-14', GOLDEN_CAPTURE_MS - 86_400_000);

    // A second principal on the same app and the same plant, entitled to `delayed`: the control
    // that proves the feed really is producing frames the eod session is not being sent.
    const other = await createWebSession(t, { email: 'delayed-control@demo.invalid' });
    entitlements.grant(other.userId, { firmTier: 'delayed', sourceCap: 'delayed' });
    const control = await connect(h.app, other);

    const feed = new SimFeed(
      {
        seed: 20260915,
        startMs: GOLDEN_CAPTURE_MS,
        rateHz: 4,
        sessionOf: () => 'open',
        subjects: [
          {
            subject: h.subject,
            instrumentId: h.instrument.instrumentId,
            mdLineId: h.instrument.mdLineId + 1,
            assetClass: 'equity',
            tier: 'delayed',
            px0: 330.27,
            annualVolPct: 22,
            spreadBp: 3,
            avgTradeSize: 100,
            calendarId: 'XNYS',
          },
        ],
      },
      { clock: h.clock, plant: h.plant, provenanceId: h.instrument.provenanceId },
    );
    feed.start();
    if (live !== null) live.feed = feed;

    sub(h.client, 4, h.subject, 'delayed');
    sub(control, 5, h.subject, 'delayed');
    await snapFor(h.client, h.subject);
    await snapFor(control, h.subject);

    // 150 virtual seconds of feed, in 5 s steps, with the flush timer running in real time. The
    // feed moves the sim line's prints; the explicit tick moves `PX_VOLUME` on the Cboe line,
    // which is one of the six fields an `eod` subscriber may see — so every step leaves that
    // subscriber genuinely owed a frame, and the floor is the only thing withholding it.
    const elapsedMs = 150_000;
    for (let i = 0; i < 30; i += 1) {
      h.clock.advance(5_000);
      feed.pump();
      await applyAaplGolden(h.plant, h.instrument, {
        fields: { PX_VOLUME: 16_591_786 + (i + 1) * 1_000 },
        srcSeqDelta: i + 1,
        srcMs: GOLDEN_CAPTURE_MS + (i + 1) * 5_000,
        capMs: GOLDEN_CAPTURE_MS + (i + 1) * 5_000,
      });
      await sleep(15);
    }
    await sleep(150);

    const eodFrames = h.client.frames.filter(
      (f) => (f.t === 'snap' || f.t === 'delta') && f.s === h.subject,
    );
    const controlFrames = control.frames.filter(
      (f) => (f.t === 'snap' || f.t === 'delta') && f.s === h.subject,
    );

    // One snapshot plus at most one flush per 60 000 ms (API.md §6.4 eod floor).
    const maxFlushes = 1 + Math.ceil(elapsedMs / 60_000);
    expect(eodFrames.length).toBeLessThanOrEqual(maxFlushes);
    // …and the floor is what limits it, not a lack of news: the subscriber was owed a frame at
    // every one of the 30 steps and got the two the floor let through.
    expect(eodFrames.length).toBeGreaterThanOrEqual(2);
    // …while the delayed subscriber, on the same plant and the same feed, gets many more.
    expect(controlFrames.length).toBeGreaterThan(eodFrames.length);

    // Whatever did go out is still the frozen close, down to the volume: 30 fresher `PX_VOLUME`
    // prints went into the plant and not one of them reached this subscriber (ENTL-05).
    for (const frame of eodFrames) {
      if ('PX_OFFICIAL_CLOSE' in frame.f) expect(frame.f.PX_OFFICIAL_CLOSE).toBe(330.27);
      if ('PX_VOLUME' in frame.f) expect(frame.f.PX_VOLUME).toBe(16_591_786);
      expect(frame.f.PX_LAST ?? null).toBeNull();
    }
  });
});

describe('ws entitlement — a subject with no grant at all (ARCHITECTURE §10 rule 4)', () => {
  it('accepts the subject and renders it blank rather than making it disappear', async () => {
    const h = await boot({
      ticker: 'TSLA',
      email: 'nogrant@demo.invalid',
      entitlements: fakeEntitlements({ firmTier: null }),
    });

    sub(h.client, 6, h.subject, 'delayed');
    const ack = await ackFor(h.client, 6);

    // Accepted, not rejected: the row is still on the screen, downgraded (ENTL-05).
    expect(ack.rejected).toEqual([]);
    expect(ack.accepted).toEqual([
      { s: h.subject, tier: 'delayed', reason: 'NO_FIRM_ENTITLEMENT' },
    ]);

    const snap = await snapFor(h.client, h.subject);
    expect(snap.reason).toBe('NO_FIRM_ENTITLEMENT');
    expect(snap.st).toBe('blank');
    for (const id of FIELDS) {
      expect(snap.f[id]).toBeNull();
      expect(snap.r?.[id]).toBe('NO_FIRM_ENTITLEMENT');
    }
    // Nothing invented: not one field carries the number the plant is holding.
    expect(Object.values(snap.f)).not.toContain(330.27);
  });
});

describe('ws entitlement — api usage on a source that forbids it (rule 2)', () => {
  it('rejects the subject NOT_ENTITLED with LICENCE_FORBIDS_USAGE', async () => {
    const h = await boot({
      ticker: 'NVDA',
      kind: 'api',
      email: 'bot@demo.invalid',
      entitlements: fakeEntitlements({
        firmTier: 'delayed',
        sourceCap: 'delayed',
        apiAllowed: false,
      }),
    });

    sub(h.client, 7, h.subject, 'delayed');
    const ack = await ackFor(h.client, 7);

    expect(ack.accepted).toEqual([]);
    expect(ack.rejected).toEqual([
      { s: h.subject, code: 'NOT_ENTITLED', reason: 'LICENCE_FORBIDS_USAGE' },
    ]);

    // A rejection is a rejection: no snapshot follows it.
    await sleep(150);
    expect(h.client.frames.some((f) => f.t === 'snap')).toBe(false);
  });
});

describe('ws entitlement — a downgrade never yields a stale higher-tier value (ENTL-05)', () => {
  it('does not leak a print applied after the close into the frozen eod view', async () => {
    const entitlements = perUser({ firmTier: 'eod', userTier: 'eod', sourceCap: 'delayed' });
    const h = await boot({
      ticker: 'AMZN',
      email: 'eod-stale@demo.invalid',
      entitlements,
    });
    const closeTs = GOLDEN_CAPTURE_MS - 86_400_000;
    const eod = h.plant.captureEod(h.subject, '2026-09-14', closeTs);
    expect(eod?.fields.PX_OFFICIAL_CLOSE).toBe(330.27);

    // A *fresher* delayed print, after the close was frozen: the value an eod subscriber may
    // never be shown, and the value a delayed subscriber must be shown.
    await applyAaplGolden(h.plant, h.instrument, {
      fields: { PX_LAST: 400.5, PX_BID: 400.45, PX_ASK: 400.55 },
      srcSeqDelta: 1,
      srcMs: GOLDEN_CAPTURE_MS - 1_000,
      capMs: GOLDEN_CAPTURE_MS,
    });
    expect(h.plant.get(h.subject)?.fields.PX_LAST).toBe(400.5);

    sub(h.client, 8, h.subject, 'delayed');
    await ackFor(h.client, 8);
    const snap = await snapFor(h.client, h.subject);

    expect(snap.tier).toBe('eod');
    expect(snap.f.PX_LAST).toBeNull();
    expect(snap.r?.PX_LAST).toBe('TIER_EOD');
    expect(snap.f.PX_OFFICIAL_CLOSE).toBe(330.27);
    // Not one field of the eod view carries the post-close print, under any name.
    expect(Object.values(snap.f)).not.toContain(400.5);
    expect(Object.values(snap.f)).not.toContain(400.45);
    expect(Object.values(snap.f)).not.toContain(400.55);

    // The control: a `delayed` principal on the same plant does see it, so the eod view is frozen,
    // not merely empty.
    const entitled = await createWebSession(t, { email: 'delayed-peer@demo.invalid' });
    entitlements.grant(entitled.userId, { firmTier: 'delayed', sourceCap: 'delayed' });
    const peer = await connect(h.app, entitled);
    sub(peer, 9, h.subject, 'delayed');
    await ackFor(peer, 9);
    const peerSnap = await snapFor(peer, h.subject);
    expect(peerSnap.tier).toBe('delayed');
    expect(peerSnap.f.PX_LAST).toBe(400.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row 15 — a grant revoked mid-session
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ws entitlement — a grant revoked mid-session (TESTING.md §10 row 15)', () => {
  it('sends downgrade + resync, then a fresh blank snap, and never denies inside a delta', async () => {
    const entitlements = mutableEntitlements({ firmTier: 'delayed', sourceCap: 'delayed' });
    const h = await boot({
      ticker: 'GOOG',
      email: 'revoked@demo.invalid',
      entitlements,
    });

    sub(h.client, 10, h.subject, 'delayed');
    const ack = await ackFor(h.client, 10);
    expect(ack.accepted[0]?.tier).toBe('delayed');
    const first = await snapFor(h.client, h.subject);
    expect(first.f.PX_LAST).toBe(330.27);

    // A tick, so the session is genuinely streaming deltas when the grant goes away.
    await applyAaplGolden(h.plant, h.instrument, {
      fields: { PX_LAST: 331.11 },
      srcSeqDelta: 1,
      srcMs: GOLDEN_CAPTURE_MS - 500,
    });
    const delta = (await h.client.next(
      (f) => f.t === 'delta' && f.s === h.subject,
    )) as Delta;
    expect(delta.f.PX_LAST).toBe(331.11);
    expect(delta.prev).toBe(first.seq);

    // The firm's contract is torn up. The gateway's grant-change path re-evaluates every hold.
    entitlements.set({ firmTier: null });
    h.app.app.wsGateway.revalidateEntitlements(h.userId);

    const resync = (await h.client.next((f) => f.t === 'resync')) as Resync;
    expect(resync.subjects).toEqual([h.subject]);

    const down = downgrades(h.client);
    expect(down).toEqual([
      { t: 'downgrade', s: h.subject, from: 'delayed', to: null, reason: 'NO_FIRM_ENTITLEMENT' },
    ]);
    // Order matters: the client is told what changed before it is told to ask again.
    const iDown = h.client.frames.findIndex((f) => f.t === 'downgrade');
    const iResync = h.client.frames.findIndex((f) => f.t === 'resync');
    expect(iDown).toBeGreaterThanOrEqual(0);
    expect(iDown).toBeLessThan(iResync);

    // Nothing flows for the subject until the client re-subscribes (API.md §6.3 step 7).
    const before = h.client.frames.length;
    await applyAaplGolden(h.plant, h.instrument, {
      fields: { PX_LAST: 332.22 },
      srcSeqDelta: 2,
      srcMs: GOLDEN_CAPTURE_MS - 400,
    });
    await sleep(150);
    expect(
      h.client.frames
        .slice(before)
        .filter((f) => (f.t === 'delta' || f.t === 'snap') && f.s === h.subject),
    ).toEqual([]);

    // The re-`sub` is answered with the new decision and a fresh, blank `snap`.
    sub(h.client, 11, h.subject, 'delayed');
    const ack2 = await ackFor(h.client, 11);
    expect(ack2.accepted).toEqual([
      { s: h.subject, tier: 'delayed', reason: 'NO_FIRM_ENTITLEMENT' },
    ]);

    const blank = (await h.client.next(
      (f) => f.t === 'snap' && f.s === h.subject && f.st === 'blank',
    )) as Snap;
    expect(blank.reason).toBe('NO_FIRM_ENTITLEMENT');
    for (const id of FIELDS) {
      expect(blank.f[id]).toBeNull();
      expect(blank.r?.[id]).toBe('NO_FIRM_ENTITLEMENT');
    }
    expect(Object.values(blank.f)).not.toContain(332.22);

    // The invariant of TESTING.md row 5 and §6.4: **no** delta ever introduced a denial. Every
    // delta this session received carried real values and no `r` map at all — the denial arrived
    // as a `downgrade` and a `snap`, which is the only frame allowed to say `r`.
    const seen = deltasFor(h.client, h.subject);
    expect(seen.length).toBeGreaterThan(0);
    for (const frame of seen) {
      expect(frame).not.toHaveProperty('r');
      for (const [id, value] of Object.entries(frame.f)) {
        expect(value, `delta ${String(frame.seq)} field ${id}`).not.toBeNull();
      }
    }
  });
});
