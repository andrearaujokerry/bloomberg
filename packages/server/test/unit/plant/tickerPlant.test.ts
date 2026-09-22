/**
 * BUS-01/02/05, FEED-02/05 — `plant/tickerPlant.ts` (ARCHITECTURE §6.2, WORKPLAN WP-06).
 *
 * Four things this file exists to prove, all of them acceptance rows:
 *
 *   - `seq` increases strictly, per subject, across a burst — driven by WP-05's deterministic
 *     `providers/sim/feed.ts` at 50 Hz over ten virtual seconds on a `VirtualClock`, which is the
 *     same feed the WS integration tests use, so the plant is exercised by the exact update stream
 *     the gateway will see (and by nothing else: no network, no timers).
 *   - a replayed `src_seq` is **dropped** (step 2) and `ts.cap` still advances, because the capture
 *     really happened and staleness is measured from it.
 *   - `snapshot(subject)` equals the applied state.
 *   - the one recorded observation, `fixtures/providers/normalised/cboe-quote-AAPL.json`, applied
 *     once, composes to Cboe's own cross-check: `PX_LAST 330.27`, `CHG_PCT_1D −0.8436`.
 *
 * plus the composition and fan-out behaviour the gateway depends on.
 */

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { maskToIds } from '@terminal/core';
import type { FieldId, NormalisedUpdate, QuoteState } from '@terminal/core';

import { getConfig } from '../../../src/config.js';
import { buildPlant, changedFieldIds, tickKindOf } from '../../../src/plant/tickerPlant.js';
import type { Plant, PlantEvent } from '../../../src/plant/tickerPlant.js';
import { SimFeed } from '../../../src/providers/sim/feed.js';
import type { SimSubject } from '../../../src/providers/sim/feed.js';
import { TEST_NOW, testClock } from '../../../src/test/clock.js';
import { readNormalised } from '../../../src/test/fixtures.js';

// `src/test/fixtures.ts` resolves `REPLAY_DIR` against `packages/server`, and the repository's
// `.env` carries the root-relative `./fixtures/providers`, which lands one directory too deep.
// The captures are a fixed part of the repository, so this file pins the absolute path (the same
// thing `test/unit/plant/policyTier.test.ts` does).
process.env.REPLAY_DIR = fileURLToPath(
  new URL('../../../../../fixtures/providers', import.meta.url),
);

interface NormalisedFixture {
  updates: NormalisedUpdate[];
  rows: { crossChecks: { priceChange: number; priceChangePercent: number; tick: string }[] };
}

function plantOn(clock = testClock()): { plant: Plant; clock: ReturnType<typeof testClock> } {
  return { plant: buildPlant({ config: getConfig(), clock }), clock };
}

/** A Cboe-shaped update for `q:101`, line 5101. */
function cboeUpdate(
  fields: NormalisedUpdate['fields'],
  at: number,
  srcSeq: number,
): NormalisedUpdate {
  return {
    subject: 'q:101',
    instrumentId: 101,
    mdLineId: 5101,
    assetClass: 'equity',
    tier: 'delayed',
    fields,
    ts: { src: at, cap: at + 1_000, pub: 0 },
    prov: { sourceId: 'cboe.quotes', provenanceId: 900_101, srcSeq },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The deterministic burst
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SIM_SUBJECTS: SimSubject[] = [
  {
    subject: 'q:101',
    instrumentId: 101,
    mdLineId: 5101,
    assetClass: 'equity',
    tier: 'delayed',
    px0: 330.27,
    annualVolPct: 22,
    spreadBp: 3,
    avgTradeSize: 120,
    calendarId: 'XNYS',
  },
  {
    subject: 'q:202',
    instrumentId: 202,
    mdLineId: 5202,
    assetClass: 'etf',
    tier: 'delayed',
    px0: 612.4,
    annualVolPct: 14,
    spreadBp: 2,
    avgTradeSize: 400,
    calendarId: 'XNYS',
  },
];

describe('plant/tickerPlant.ts — apply over a SimFeed burst', () => {
  it('advances seq strictly, per subject, for ten virtual seconds at 50 Hz', async () => {
    const { plant, clock } = plantOn();
    await plant.start();

    const seen: PlantEvent[] = [];
    const unsubscribe = plant.subscribe((ev) => seen.push(ev));

    const feed = new SimFeed(
      { seed: 7, startMs: clock.now(), rateHz: 50, subjects: SIM_SUBJECTS },
      { clock, plant, provenanceId: 900_900 },
    );
    expect(feed.problems).toEqual([]);
    feed.start();

    const seqs = new Map<string, number[]>([
      ['q:101', []],
      ['q:202', []],
    ]);
    // 10 virtual seconds in 20 ms steps: the feed's own tick interval at 50 Hz.
    for (let step = 0; step < 500; step += 1) {
      clock.advance(20);
      feed.pump();
      for (const [subject, history] of seqs) history.push(plant.get(subject)?.seq ?? 0);
    }
    unsubscribe();

    // Every tick moves the cumulative volume, so every tick is a new composite version.
    const ticksPerSubject = feed.ticks / SIM_SUBJECTS.length;
    expect(ticksPerSubject).toBeGreaterThan(500);
    for (const [subject, history] of seqs) {
      expect(plant.get(subject)?.seq).toBe(ticksPerSubject);
      for (let i = 1; i < history.length; i += 1) {
        expect(history[i]!).toBeGreaterThan(history[i - 1]!);
      }
    }

    // One fan-out event per version bump, carrying the subject's own seq.
    expect(seen).toHaveLength(feed.ticks);
    expect(seen.every((ev) => !ev.queued)).toBe(true);
    expect(maskToIds(seen[0]!.changed)).toContain('PX_LAST');
    // Cumulative volume moves on every print, so every fan-out carries at least it; a tick that
    // re-prints the same price simply does not carry PX_LAST, which is the point of the mask.
    expect(seen.every((ev) => maskToIds(ev.changed).includes('PX_VOLUME'))).toBe(true);

    const stats = plant.stats();
    expect(stats.updatesApplied).toBe(feed.ticks);
    expect(stats.updatesDroppedStaleSeq).toBe(0);
    expect(stats.subjects).toBe(2);
    // ARCHITECTURE §6.2 step 8: publish latency is `pub − cap`, budget < 1 ms p99 in process.
    expect(stats.publishLatencyP99Ms).toBeLessThan(1);

    // The plant is serving, and the sim subjects are live inside their 3 × interval window.
    expect(plant.state).toBe('ok');
    expect(plant.ready()).toBe(true);
    expect(plant.get('q:101')?.state).toBe('live');
    expect(plant.get('q:101')?.session).toBe('open');
  });

  it('is bit-identical across two runs of one seed', async () => {
    const runOnce = async (): Promise<QuoteState | undefined> => {
      const { plant, clock } = plantOn();
      await plant.start();
      const feed = new SimFeed(
        { seed: 7, startMs: clock.now(), rateHz: 50, subjects: SIM_SUBJECTS },
        { clock, plant, provenanceId: 900_900 },
      );
      feed.start();
      for (let step = 0; step < 50; step += 1) {
        clock.advance(20);
        feed.pump();
      }
      return plant.snapshot('q:101');
    };
    expect(await runOnce()).toEqual(await runOnce());
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 2: the replayed sequence
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('plant/tickerPlant.ts — a replayed src_seq', () => {
  it('is dropped without a version bump, and ts.cap still advances', async () => {
    const { plant, clock } = plantOn();
    await plant.start();

    const first = cboeUpdate({ PX_LAST: 330.27, PX_CLOSE_1D: 333.08 }, TEST_NOW, 100);
    plant.apply(first);
    const afterFirst = plant.snapshot('q:101')!;
    expect(afterFirst.seq).toBe(1);

    // The next poll returns the same seqno 30 s later — the same data, a real capture.
    clock.advance(30_000);
    const replay = cboeUpdate({ PX_LAST: 330.27, PX_CLOSE_1D: 333.08 }, TEST_NOW, 100);
    replay.ts = { src: TEST_NOW, cap: TEST_NOW + 30_000, pub: 0 };
    plant.apply(replay);

    const after = plant.get('q:101')!;
    expect(after.seq).toBe(1);
    expect(after.ts.cap).toBe(TEST_NOW + 30_000);
    expect(after.lines[5101]?.ts.cap).toBe(TEST_NOW + 30_000);
    expect(after.lines[5101]?.srcSeq).toBe(100);
    expect(after.fields).toEqual(afterFirst.fields);
    expect(plant.stats().updatesDroppedStaleSeq).toBe(1);
    expect(plant.stats().updatesApplied).toBe(1);

    // An older sequence is dropped too; a newer one is applied.
    plant.apply(cboeUpdate({ PX_LAST: 331 }, TEST_NOW + 1, 99));
    expect(plant.get('q:101')?.seq).toBe(1);
    expect(plant.stats().updatesDroppedStaleSeq).toBe(2);

    plant.apply(cboeUpdate({ PX_LAST: 331 }, TEST_NOW + 2, 101));
    expect(plant.get('q:101')?.seq).toBe(2);
    expect(plant.get('q:101')?.fields.PX_LAST).toBe(331);
  });

  it('a poll that returns the same numbers under a new seqno is not a new version', async () => {
    const { plant } = plantOn();
    await plant.start();
    plant.apply(cboeUpdate({ PX_LAST: 330.27, PX_CLOSE_1D: 333.08 }, TEST_NOW, 100));

    // The second identical poll does change one thing: re-printing the same price establishes a
    // tick direction, which the first print (with nothing to compare against) had none of.
    plant.apply(cboeUpdate({ PX_LAST: 330.27, PX_CLOSE_1D: 333.08 }, TEST_NOW, 101));
    expect(plant.get('q:101')?.seq).toBe(2);
    expect(plant.get('q:101')?.fields.TICK_DIR).toBe('flat');

    // From there a repeated poll composes to exactly what the plant already holds: no version, no
    // fan-out, only the capture instant moves (step 5).
    const before = plant.snapshot('q:101')!;
    const events: PlantEvent[] = [];
    plant.subscribe((ev) => events.push(ev));
    const repeat = cboeUpdate({ PX_LAST: 330.27, PX_CLOSE_1D: 333.08 }, TEST_NOW, 102);
    repeat.ts = { src: TEST_NOW, cap: TEST_NOW + 10_000, pub: 0 };
    plant.apply(repeat);

    const after = plant.get('q:101')!;
    expect(after.seq).toBe(before.seq);
    expect(after.fields).toEqual(before.fields);
    expect(after.ts.cap).toBe(TEST_NOW + 10_000);
    expect(events).toEqual([]);
    // The update was applied — the line now carries the new seqno — but nothing changed.
    expect(after.lines[5101]?.srcSeq).toBe(102);
    expect(plant.stats().updatesApplied).toBe(3);
    expect(plant.stats().updatesDroppedStaleSeq).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The recorded AAPL observation
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('plant/tickerPlant.ts — the recorded Cboe observation', () => {
  it('composes to the venue cross-check: 330.27 and −0.8436', async () => {
    const fx = await readNormalised<NormalisedFixture>('cboe-quote-AAPL');
    const update = fx.updates[0]!;
    const crossCheck = fx.rows.crossChecks[0]!;

    const { plant } = plantOn();
    await plant.start();
    plant.apply(update);

    const state = plant.get('q:101')!;
    expect(state.seq).toBe(1);
    expect(state.fields.PX_LAST).toBe(330.27);
    expect(state.fields.PX_CLOSE_1D).toBe(333.08);
    // Derived here, never taken from the provider — and equal to what the venue published.
    expect(state.fields.CHG_PCT_1D).toBe(crossCheck.priceChangePercent);
    expect(state.fields.CHG_PCT_1D).toBe(-0.8436);
    expect(state.fields.CHG_NET_1D).toBe(crossCheck.priceChange);
    // A first print has no previous price, so it has no direction (the venue's `down` is against
    // the previous close, which is `CHG_NET_1D`'s job, not `TICK_DIR`'s).
    expect(state.fields.TICK_DIR).toBeUndefined();

    // FEED-05: three timestamps, `pub` stamped by the plant from the injected clock.
    expect(state.ts.src).toBe(update.ts.src);
    expect(state.ts.cap).toBe(update.ts.cap);
    expect(state.ts.pub).toBe(TEST_NOW);
    expect(state.fieldTs.PX_LAST).toBe(update.ts.src);
    expect(state.prov).toEqual(update.prov);
    expect(state.tier).toBe('delayed');
    expect(state.delayMin).toBe(15);
    expect(state.expectedIntervalMs).toBe(10_000);
    // The line is kept whole: per-field provenance for the QM per-venue view (BUS-05).
    expect(state.lines[5101]?.fields.PX_LAST).toBe(330.27);
    expect(state.lines[5101]?.provenanceId).toBe(900_101);
  });

  it('a later, older, lower-priority line moves neither ts.src nor prov off the winner', async () => {
    // ARCHITECTURE §6.2 step 6: the composite's `ts` and `prov` describe the line that supplied its
    // price. A Yahoo line arriving five minutes *behind* the Cboe print contributes only VWAP, so
    // the composite must keep Cboe's source time (and stay `live`) and keep pointing Ctrl+I at the
    // Cboe observation that produced `PX_LAST` (DATA-10).
    const fx = await readNormalised<NormalisedFixture>('cboe-quote-AAPL');
    const cboe = fx.updates[0]!;
    // At the capture instant, so the composite is live rather than two days stale.
    const { plant, clock } = plantOn(testClock(cboe.ts.cap));
    await plant.start();
    plant.apply(cboe);

    const afterCboe = plant.get('q:101')!;
    expect(afterCboe.ts.src).toBe(cboe.ts.src);
    expect(afterCboe.state).toBe('live');

    const older = (cboe.ts.src ?? 0) - 300_000;
    clock.advance(1_000);
    plant.apply({
      subject: 'q:101',
      instrumentId: 101,
      mdLineId: 5102,
      assetClass: 'equity',
      tier: 'delayed',
      fields: { VWAP: 330.11 },
      ts: { src: older, cap: cboe.ts.cap + 1_000, pub: 0 },
      prov: { sourceId: 'yahoo.quote', provenanceId: 900_102 },
    });

    const state = plant.get('q:101')!;
    expect(state.seq).toBe(2);
    expect(state.fields.VWAP).toBe(330.11);
    // Unchanged: the Cboe line still wins PX_LAST, so it still dates and attributes the composite.
    expect(state.fields.PX_LAST).toBe(330.27);
    expect(state.fieldTs.PX_LAST).toBe(cboe.ts.src);
    expect(state.ts.src).toBe(cboe.ts.src);
    expect(state.state).toBe('live');
    expect(state.prov).toEqual(cboe.prov);
    expect(state.tier).toBe('delayed');
    expect(state.expectedIntervalMs).toBe(10_000);
    // The capture instant still advances — it is what staleness is measured from.
    expect(state.ts.cap).toBe(cboe.ts.cap + 1_000);
  });

  it('snapshot(subject) equals the applied state and is detached from it', async () => {
    const fx = await readNormalised<NormalisedFixture>('cboe-quote-AAPL');
    const { plant } = plantOn();
    await plant.start();
    plant.apply(fx.updates[0]!);

    const snapshot = plant.snapshot('q:101')!;
    expect(snapshot).toEqual(plant.get('q:101'));
    expect(snapshot).not.toBe(plant.get('q:101'));

    // Mutating a snapshot cannot reach the plant's truth.
    snapshot.fields.PX_LAST = 1;
    expect(plant.get('q:101')?.fields.PX_LAST).toBe(330.27);

    const many = plant.snapshotMany(['q:101', 'q:999']);
    expect([...many.keys()]).toEqual(['q:101']);
    expect(many.get('q:101')).toEqual(plant.get('q:101'));
    expect(plant.snapshot('q:999')).toBeUndefined();
    expect(plant.has('q:101')).toBe(true);
    expect([...plant.subjects()]).toEqual(['q:101']);
    expect(plant.subjectCount()).toBe(1);
  });

  it('a second line whose price diverges raises the dq flag', async () => {
    const fx = await readNormalised<NormalisedFixture>('cboe-quote-AAPL');
    const update = fx.updates[0]!;
    const { plant } = plantOn();
    await plant.start();
    plant.apply(update);
    expect(plant.get('q:101')?.dq).toEqual([]);

    // A Yahoo line 30 s later at 340.00 — 2.9 % away from 330.27, inside the 60 s window.
    plant.apply({
      ...update,
      mdLineId: 5102,
      fields: { PX_LAST: 340, PX_CLOSE_1D: 333.08 },
      ts: { src: update.ts.src! + 30_000, cap: update.ts.cap + 30_000, pub: 0 },
      prov: { sourceId: 'yahoo.quote', provenanceId: 900_102 },
    });

    const state = plant.get('q:101')!;
    expect(state.dq).toContain('CROSS_SOURCE_DIVERGENCE');
    expect(state.seq).toBe(2);
    // The freshest line carrying a print wins the trade block (BUS-05).
    expect(state.fields.PX_LAST).toBe(340);
    // The book still comes from the Cboe line: a reference line publishes none.
    expect(state.fields.PX_BID).toBe(330.25);
    expect(Object.keys(state.lines)).toEqual(['5101', '5102']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fan-out, publish, sweep
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('plant/tickerPlant.ts — fan-out and non-quote subjects', () => {
  it('fans out only the changed fields, as a dictionary bitset', async () => {
    const { plant } = plantOn();
    await plant.start();
    const events: PlantEvent[] = [];
    const off = plant.subscribe((ev) => events.push(ev));

    plant.apply(cboeUpdate({ PX_LAST: 330.27, PX_CLOSE_1D: 333.08 }, TEST_NOW, 1));
    expect(maskToIds(events[0]!.changed).sort()).toEqual(
      ['CHG_NET_1D', 'CHG_PCT_1D', 'PX_CLOSE_1D', 'PX_LAST'].sort(),
    );

    plant.apply(cboeUpdate({ PX_LAST: 330.5, PX_CLOSE_1D: 333.08 }, TEST_NOW + 1, 2));
    expect(maskToIds(events[1]!.changed).sort()).toEqual(
      ['CHG_NET_1D', 'CHG_PCT_1D', 'PX_LAST', 'TICK_DIR'].sort(),
    );
    expect(plant.get('q:101')?.fields.TICK_DIR).toBe('up');

    off();
    plant.apply(cboeUpdate({ PX_LAST: 331 }, TEST_NOW + 2, 3));
    expect(events).toHaveLength(2);
  });

  it('a listener that throws does not stop the plant', async () => {
    const problems: string[] = [];
    const clock = testClock();
    const plant = buildPlant({
      config: getConfig(),
      clock,
      onError: (_err, detail) => problems.push(detail),
    });
    await plant.start();
    plant.subscribe(() => {
      throw new Error('subscriber exploded');
    });
    expect(() => plant.apply(cboeUpdate({ PX_LAST: 330.27 }, TEST_NOW, 1))).not.toThrow();
    expect(plant.get('q:101')?.seq).toBe(1);
    expect(problems).toHaveLength(1);
  });

  it('publishes non-quote subjects with their own seq, and queues news (NEWS-01)', async () => {
    const { plant, clock } = plantOn();
    await plant.start();
    const events: PlantEvent[] = [];
    plant.subscribe((ev) => events.push(ev));

    const headline = (id: number, at: number): Record<FieldId, string | number> => ({
      NEWS_ID: id,
      HEADLINE: `headline ${String(id)}`,
      PUBLISHED_AT: at,
    });
    plant.publish('n:all', headline(1, TEST_NOW), { ts: { src: TEST_NOW, cap: TEST_NOW, pub: 0 } });
    clock.advance(10);
    plant.publish('n:all', headline(2, TEST_NOW + 10), {
      ts: { src: TEST_NOW + 10, cap: TEST_NOW + 10, pub: 0 },
    });

    // Two headlines inside one conflation window are two versions, both retained in order.
    expect(plant.get('n:all')?.seq).toBe(2);
    expect(events.map((ev) => ev.queued)).toEqual([true, true]);
    const queued = plant.queuedAfter('n:all', 0);
    expect(queued.map((s) => s.seq)).toEqual([1, 2]);
    expect(queued.map((s) => (s.fields as Record<string, unknown>).NEWS_ID)).toEqual([1, 2]);
    expect(plant.queuedAfter('n:all', 1).map((s) => s.seq)).toEqual([2]);

    // `sys:status` is not queued: the latest value is the whole truth.
    plant.publish(
      'sys:status',
      { PLANT_STATE: 'ok', CONFLATION_FLOOR_MS: 250 },
      { ts: { src: null, cap: clock.now(), pub: 0 } },
    );
    expect(plant.get('sys:status')?.seq).toBe(1);
    expect(events[2]?.queued).toBe(false);
    expect(plant.queuedAfter('sys:status', 0)).toEqual([]);
  });

  it('sweeps staleness and asks for a resync on demand', async () => {
    const { plant, clock } = plantOn();
    await plant.start();
    plant.apply(cboeUpdate({ PX_LAST: 330.27, PX_CLOSE_1D: 333.08 }, TEST_NOW, 1));
    expect(plant.get('q:101')?.state).toBe('live');

    // The Cboe cadence is 10 s, so the limit is 30 s past the capture (which is TEST_NOW + 1 s).
    clock.advance(31_000);
    expect(plant.sweep()).toEqual([]);
    clock.advance(1_000);
    const transitions = plant.sweep();
    expect(transitions.map((t) => [t.subject, t.from, t.to])).toEqual([['q:101', 'live', 'stale']]);
    expect(plant.sweep()).toEqual([]);
    expect(plant.nextStalenessMs()).toBe(Number.POSITIVE_INFINITY);

    const resyncs: PlantEvent[] = [];
    plant.subscribe((ev) => resyncs.push(ev));
    plant.forceResync(['q:101', 'q:404']);
    expect(resyncs).toHaveLength(1);
    expect(resyncs[0]?.resync).toBe(true);
    expect(maskToIds(resyncs[0]!.changed)).toContain('PX_LAST');
  });

  it('freezes an official close for the eod tier', async () => {
    const { plant } = plantOn();
    await plant.start();
    plant.apply(
      cboeUpdate(
        { PX_LAST: 330.27, PX_CLOSE_1D: 333.08, PX_OPEN: 330.24, PX_VOLUME: 16_591_786 },
        TEST_NOW,
        1,
      ),
    );

    // With no explicit capture the view is built from the last completed NYSE close.
    const auto = plant.eodView('q:101');
    expect(auto?.fields.PX_OFFICIAL_CLOSE).toBe(330.27);
    expect(auto?.flags).toEqual(['OFFICIAL_CLOSE_FROM_LAST']);
    expect(auto?.sessionDate).toBe('2026-09-16');

    const captured = plant.captureEod('q:101', '2026-09-17', Date.parse('2026-09-17T20:00:00.000Z'));
    expect(captured?.fields.PX_VOLUME).toBe(16_591_786);
    expect(plant.eodView('q:101')).toEqual(captured);
    expect(plant.eodView('q:999')).toBeNull();
  });

  it('starts degraded and has no store to flush without a database', async () => {
    const { plant } = plantOn();
    expect(plant.state).toBe('degraded');
    expect(plant.ready()).toBe(false);
    await plant.start();
    expect(plant.ready()).toBe(true);
    expect(plant.state).toBe('degraded');
    plant.apply(cboeUpdate({ PX_LAST: 330.27 }, TEST_NOW, 1));
    expect(plant.state).toBe('ok');
    await expect(plant.flushStore()).resolves.toBeUndefined();
    await plant.stop();
    expect(plant.ready()).toBe(false);
    expect(plant.warmSkipped()).toEqual([]);
  });
});

describe('plant/tickerPlant.ts — helpers', () => {
  it('changedFieldIds is NaN-safe and treats null as a value', () => {
    expect(changedFieldIds({ PX_LAST: 330.27 }, { PX_LAST: 330.27 })).toEqual([]);
    expect(changedFieldIds({ PX_LAST: Number.NaN }, { PX_LAST: Number.NaN })).toEqual([]);
    expect(changedFieldIds({ PX_LAST: 330.27 }, {})).toEqual(['PX_LAST']);
    expect(changedFieldIds({}, { PX_LAST: 330.27 })).toEqual(['PX_LAST']);
    expect(
      changedFieldIds({ PX_LAST: null as unknown as number }, { PX_LAST: 0 }),
    ).toEqual(['PX_LAST']);
  });

  it('classifies a tick row by what the update carries', () => {
    expect(tickKindOf({ PX_LAST: 330.27, PX_CLOSE_1D: 333.08 })).toBe('summary');
    expect(tickKindOf({ PX_LAST: 330.27, LAST_SIZE: 100 })).toBe('trade');
    expect(tickKindOf({ PX_BID: 330.25, PX_ASK: 330.28 })).toBe('quote');
  });
});
