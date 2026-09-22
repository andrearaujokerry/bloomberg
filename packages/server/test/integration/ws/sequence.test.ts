/**
 * Sequence continuity via the prev-chain (TESTING.md §10 row 3, BUS-01/BUS-03).
 *
 * Two thousand updates from WP-05's seeded `SimFeed` are pushed through the plant while one session
 * holds a real socket open at a 50 ms conflation window. The property under test is the one the
 * client's apply rule depends on (API.md §6.3 step 3):
 *
 *  - `delta.prev` is always the `seq` of the previous frame **this session** received for the
 *    subject — the chain never gaps, whatever the conflator collapsed;
 *  - `seq` itself is strictly increasing and *does* skip, because that is what conflation is;
 *  - the last value on the wire is the last value in the plant: nothing is lost in a window.
 *
 * The feed is deterministic (seed + `startMs` → a bit-identical update stream), so the numbers below
 * are reproducible; only the socket's latency is real.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Delta, Snap } from '@terminal/sdk/wire/ws';

import { getConfig } from '../../../src/config.js';
import { buildPlant } from '../../../src/plant/tickerPlant.js';
import { SimFeed } from '../../../src/providers/sim/feed.js';
import { testClock } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';
import {
  applyAaplGolden,
  createWebSession,
  delayedEntitlements,
  GOLDEN_CAPTURE_MS,
  seedQuoteInstrument,
  sleep,
  startWsApp,
  WsClient,
  type StartedWsApp,
} from './helpers.js';

const t = withTxDb();

const CONFLATION_MS = 50;
const RATE_HZ = 50;
const TICKS = 2_000;
const CHUNKS = 25;

let open: { app: StartedWsApp; client: WsClient } | null = null;

afterEach(async () => {
  if (open === null) return;
  await open.client.close();
  await open.app.close();
  open = null;
});

describe('ws sequence — 2 000 updates, one contiguous prev chain (BUS-03)', () => {
  it('chains prev across every frame, skips seq, and ends on the plant’s own last value', async () => {
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
      limits: { sweepMs: 500 },
    });
    const client = new WsClient(app.url, { cookie: web.cookie });
    await client.open();
    open = { app, client };

    const subject = instrument.subject;
    const feed = new SimFeed(
      {
        seed: 20260915,
        startMs: GOLDEN_CAPTURE_MS,
        rateHz: RATE_HZ,
        sessionOf: () => 'open',
        subjects: [
          {
            subject,
            instrumentId: instrument.instrumentId,
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

    client.send({ t: 'hello', protocol: 1, client: 'web/0.1.0', conflationMs: CONFLATION_MS });
    await client.next((f) => f.t === 'welcome');
    client.send({
      t: 'sub',
      id: 1,
      subjects: [{ s: subject, f: ['PX_LAST', 'PX_BID', 'PX_ASK', 'PX_VOLUME', 'CHG_PCT_1D'] }],
    });
    await client.next((f) => f.t === 'snap');

    const perChunk = TICKS / CHUNKS;
    for (let i = 0; i < CHUNKS; i += 1) {
      clock.advance((1_000 / RATE_HZ) * perChunk);
      feed.pump();
      // 40 virtual seconds pass over the burst; a real client pings every `heartbeatMs`, and a
      // session silent for 45 s is closed `4000 IDLE` (API.md §6.3 step 8).
      client.send({ t: 'ping', n: i });
      await sleep(CONFLATION_MS + 15);
    }
    expect(client.frames.filter((f) => f.t === 'pong').length).toBeGreaterThan(0);
    // The feed also emits the tick due at `startMs` itself, so the burst is 2 000 updates plus
    // that first one.
    expect(feed.ticks).toBeGreaterThanOrEqual(TICKS);

    // Let the tail of the burst drain: the subject stays dirty until it has been flushed.
    const applied = plant.get(subject);
    expect(applied).toBeDefined();
    for (let i = 0; i < 40; i += 1) {
      const last = [...client.frames].reverse().find((f) => f.t === 'delta') as Delta | undefined;
      if (last?.seq === applied!.seq) break;
      await sleep(CONFLATION_MS);
    }

    const ordered = client.frames.filter(
      (f): f is Snap | Delta => (f.t === 'snap' || f.t === 'delta') && f.s === subject,
    );
    expect(ordered[0]!.t).toBe('snap');
    expect(ordered.filter((f) => f.t === 'snap')).toHaveLength(1);
    expect(ordered.length).toBeGreaterThan(5);

    let previous = ordered[0]!.seq;
    let skipped = 0;
    for (const frame of ordered.slice(1)) {
      const delta = frame as Delta;
      expect(delta.t).toBe('delta');
      expect(delta.prev).toBe(previous); // the chain never gaps
      expect(delta.seq).toBeGreaterThan(previous); // seq is strictly increasing
      if (delta.seq > previous + 1) skipped += 1; // …and does skip: that is conflation
      previous = delta.seq;
    }

    // Conflation really happened: 2 000 updates did not become 2 000 frames.
    expect(ordered.length).toBeLessThan(TICKS / 4);
    expect(skipped).toBeGreaterThan(0);

    const last = ordered[ordered.length - 1] as Delta;
    expect(last.seq).toBe(applied!.seq);
    expect(last.f.PX_LAST).toBe(applied!.fields.PX_LAST);

    // Applying the stream the way a client does (a field absent from `f` is unchanged) lands on
    // exactly the plant's composite: nothing was lost in a conflation window, and the one field
    // the burst never moved — `PX_VOLUME`, still the recorded session total, because the simulated
    // prints never exceed it — is still the value the snapshot carried.
    const merged: Record<string, unknown> = {};
    for (const frame of ordered) Object.assign(merged, frame.f);
    expect(merged.PX_LAST).toBe(applied!.fields.PX_LAST);
    expect(merged.PX_BID).toBe(applied!.fields.PX_BID);
    expect(merged.PX_ASK).toBe(applied!.fields.PX_ASK);
    expect(merged.PX_VOLUME).toBe(applied!.fields.PX_VOLUME);
  });
});
