/**
 * `hello` → `welcome` → `sub` → `subAck` → `snap` → `delta` (TESTING.md §10 rows 1-2, BUS-01/02/07).
 *
 * This is the exchange of API.md §6.8 (L1031-1057) driven over a **real** socket against the
 * production `buildApp`, with the recorded `cboe-quote-AAPL` poll as the snapshot and WP-05's
 * seeded `SimFeed` as the follow-on ticks. That split is not a convenience: the fixture is a single
 * 531-byte poll with one `seqno` and one `last_trade_time`, and there is no second observation for
 * any quote source anywhere in `fixtures/providers/raw/`, so **no delta can be derived from it**.
 * The `snap` is the recording; every tick after it is the deterministic feed, seeded from that
 * snapshot's own price.
 *
 * The clock starts at the fixture's own capture instant, so the values it carries are live rather
 * than a day stale — the frames asserted here are the frames a terminal would have seen at 14:41 ET
 * on 2026-09-15.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Delta, ServerMsg, Snap } from '@terminal/sdk/wire/ws';

import { getConfig } from '../../../src/config.js';
import { buildPlant, type Plant } from '../../../src/plant/tickerPlant.js';
import { SimFeed } from '../../../src/providers/sim/feed.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';
import {
  applyAaplGolden,
  createWebSession,
  delayedEntitlements,
  GOLDEN_CAPTURE_MS,
  seedQuoteInstrument,
  startWsApp,
  WsClient,
  type SeededInstrument,
  type StartedWsApp,
} from './helpers.js';

const t = withTxDb();

const CONFLATION_MS = 50;

interface Harness {
  clock: VirtualClock;
  plant: Plant;
  instrument: SeededInstrument;
  subject: string;
  app: StartedWsApp;
  client: WsClient;
  feed: SimFeed;
}

let live: Harness | null = null;

afterEach(async () => {
  if (live === null) return;
  await live.client.close();
  await live.app.close();
  live = null;
});

/** The whole world one test needs: a seeded instrument, the golden quote, an open socket. */
async function harness(): Promise<Harness> {
  const clock = testClock(GOLDEN_CAPTURE_MS);
  const plant = buildPlant({ config: getConfig(), clock });
  const instrument = await seedQuoteInstrument(t, { ticker: 'AAPL', name: 'Apple Inc' });
  await applyAaplGolden(plant, instrument);
  const web = await createWebSession(t);
  const app = await startWsApp({
    t,
    clock,
    plant,
    entitlements: delayedEntitlements(),
    limits: { sweepMs: 250 },
  });
  const client = new WsClient(app.url, { cookie: web.cookie });
  await client.open();

  const feed = new SimFeed(
    {
      seed: 20260915,
      startMs: GOLDEN_CAPTURE_MS,
      rateHz: 4,
      sessionOf: () => 'open',
      subjects: [
        {
          subject: instrument.subject,
          instrumentId: instrument.instrumentId,
          // A second line for the same instrument: the Cboe line keeps supplying `PX_CLOSE_1D`
          // (it is the primary, priority 10) while the sim line supplies the prints.
          mdLineId: instrument.mdLineId + 1,
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
    { clock, plant, provenanceId: instrument.provenanceId },
  );
  feed.start();

  const h: Harness = {
    clock,
    plant,
    instrument,
    subject: instrument.subject,
    app,
    client,
    feed,
  };
  live = h;
  return h;
}

function hello(client: WsClient): void {
  client.send({ t: 'hello', protocol: 1, client: 'web/0.1.0', conflationMs: CONFLATION_MS });
}

function subscribe(client: WsClient, subject: string, fields: string[], id = 1): void {
  client.send({ t: 'sub', id, subjects: [{ s: subject, f: fields }] });
}

const QUOTE_FIELDS = ['PX_LAST', 'PX_BID', 'PX_ASK', 'PX_VOLUME', 'CHG_PCT_1D'];

/** Drive `ticks` sim updates through the plant, letting the socket breathe between chunks. */
async function pump(h: Harness, chunks: number, ticksPerChunk: number): Promise<void> {
  for (let i = 0; i < chunks; i += 1) {
    h.clock.advance(250 * ticksPerChunk);
    h.feed.pump();
    await new Promise<void>((resolve) => setTimeout(resolve, CONFLATION_MS + 20));
  }
}

describe('ws handshake — hello, welcome and the pinned limits (BUS-01)', () => {
  it('answers hello with welcome: protocol 1, heartbeat 15 s, 10 000 subjects, 100 fields', async () => {
    const h = await harness();
    hello(h.client);

    const welcome = await h.client.next((f) => f.t === 'welcome');
    expect(welcome).toMatchObject({
      t: 'welcome',
      protocol: 1,
      heartbeatMs: 15_000,
      conflationMs: CONFLATION_MS,
      limits: { maxSubscriptions: 10_000, maxFields: 100 },
    });
    expect((welcome as { serverTime: number }).serverTime).toBe(GOLDEN_CAPTURE_MS);
  });
});

describe('ws handshake — sub, subAck and exactly one snap (BUS-01, BUS-02, ENTL-05)', () => {
  it('acknowledges at the delayed tier with SOURCE_TIER_CAP and sends the recorded quote', async () => {
    const h = await harness();
    hello(h.client);
    await h.client.next((f) => f.t === 'welcome');
    subscribe(h.client, h.subject, QUOTE_FIELDS);

    const ack = (await h.client.next((f) => f.t === 'subAck')) as Extract<
      ServerMsg,
      { t: 'subAck' }
    >;
    expect(ack.id).toBe(1);
    expect(ack.rejected).toEqual([]);
    expect(ack.accepted).toEqual([
      { s: h.subject, tier: 'delayed', reason: 'SOURCE_TIER_CAP' },
    ]);

    const snap = (await h.client.next((f) => f.t === 'snap')) as Snap;
    expect(snap.s).toBe(h.subject);
    expect(snap.tier).toBe('delayed');
    expect(snap.reason).toBe('SOURCE_TIER_CAP');
    expect(snap.f).toEqual({
      PX_LAST: 330.27,
      PX_BID: 330.25,
      PX_ASK: 330.28,
      PX_VOLUME: 16_591_786,
      CHG_PCT_1D: -0.8436,
    });
    expect(snap.prov).toEqual({
      p: 'cboe.quotes',
      id: h.instrument.provenanceId,
      seq: 15_972_883_317,
    });
    expect(snap.ts.src).toBe(1_789_496_786_000);
    expect(snap.st).toBe('live');
    expect(snap.session).toBe('open');
    expect(snap.ac).toBe('equity');
    expect(snap.id).toBe(h.instrument.instrumentId);

    // Exactly one snap for the subject, and it travelled inside a `batch` (API.md §6.3 step 2).
    expect(h.client.frames.filter((f) => f.t === 'snap')).toHaveLength(1);
    expect(h.client.envelopes.some((f) => f.t === 'batch')).toBe(true);
  });
});

describe('ws handshake — snap then deltas, prev-chained (BUS-01, BUS-03)', () => {
  it('never sends a delta before the snap and chains prev to the previous seq', async () => {
    const h = await harness();
    hello(h.client);
    await h.client.next((f) => f.t === 'welcome');
    subscribe(h.client, h.subject, QUOTE_FIELDS);
    await h.client.next((f) => f.t === 'snap');

    await pump(h, 6, 2);
    await h.client.next((f) => f.t === 'delta');

    // Frame-order census: the snap precedes every delta for the subject.
    const ordered = h.client.frames.filter(
      (f): f is Snap | Delta =>
        (f.t === 'snap' || f.t === 'delta') && (f).s === h.subject,
    );
    expect(ordered.length).toBeGreaterThan(1);
    expect(ordered[0]!.t).toBe('snap');
    expect(ordered.filter((f) => f.t === 'snap')).toHaveLength(1);

    let previous = ordered[0]!.seq;
    for (const frame of ordered.slice(1)) {
      expect(frame.t).toBe('delta');
      expect((frame as Delta).prev).toBe(previous);
      expect(frame.seq).toBeGreaterThan(previous);
      previous = frame.seq;
    }

    const last = ordered[ordered.length - 1] as Delta;
    expect(last.f.PX_LAST).toBe(h.plant.get(h.subject)?.fields.PX_LAST);
  });
});

describe('ws field masks — a client subscribing to PX_LAST never receives PX_BID (BUS-02)', () => {
  it('emits only the subscribed field, however many others changed', async () => {
    const h = await harness();
    hello(h.client);
    await h.client.next((f) => f.t === 'welcome');
    subscribe(h.client, h.subject, ['PX_LAST']);
    const snap = (await h.client.next((f) => f.t === 'snap')) as Snap;
    expect(Object.keys(snap.f)).toEqual(['PX_LAST']);

    await pump(h, 6, 2);
    await h.client.next((f) => f.t === 'delta');

    const deltas = h.client.frames.filter((f): f is Delta => f.t === 'delta');
    expect(deltas.length).toBeGreaterThan(0);
    for (const delta of deltas) {
      expect(Object.keys(delta.f)).toEqual(['PX_LAST']);
      expect(delta.f.PX_BID).toBeUndefined();
    }
  });
});
