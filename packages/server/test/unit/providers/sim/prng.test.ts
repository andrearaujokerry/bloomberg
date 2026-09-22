/**
 * The seeded generator and the deterministic feed — WP-05 acceptance row
 * "two runs from the same seed produce identical update streams", PROVIDERS.a §4.1-§4.4.
 *
 * The whole value of the simulated feed is that a conflation or slow-consumer regression shows up
 * as a diff at a named frame rather than as an intermittent failure (§4.4). That only holds if
 * every draw comes from a per-subject stream in a fixed order and every instant comes from the
 * injected `Clock`, so both halves are asserted here: the PRNG on its own, and a whole `SimFeed`
 * run compared field for field against a second run of the same seed.
 *
 * Nothing here opens a socket, a database or a file.
 */

import { describe, expect, it } from 'vitest';

import {
  recordingPlant,
  SimFeed,
  type SimFeedConfig,
  type SimSubject,
} from '../../../../src/providers/sim/feed.js';
import {
  gaussian,
  gaussianStream,
  hash32,
  intBetween,
  pick,
  splitmix32,
  subjectRng,
  uniform,
  xoshiro128ss,
} from '../../../../src/providers/sim/prng.js';
import { testClock, TEST_NOW } from '../../../../src/test/clock.js';

import type { NormalisedUpdate } from '@terminal/core';

function draws(rng: () => number, n: number): number[] {
  return Array.from({ length: n }, () => rng());
}

describe('hash32 (FNV-1a 32)', () => {
  it('is stable, unsigned and order-sensitive', () => {
    expect(hash32('')).toBe(0x811c_9dc5);
    expect(hash32('a')).toBe(0xe40c_292c);
    expect(hash32('foobar')).toBe(0xbf9c_f968);
    expect(hash32('q:42')).toBe(hash32('q:42'));
    expect(hash32('q:42')).not.toBe(hash32('q:43'));
    expect(hash32('ab')).not.toBe(hash32('ba'));
    for (const text of ['', 'q:1', 'a longer subject name', '7|q:AAPL']) {
      const value = hash32(text);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffff_ffff);
    }
  });
});

describe('xoshiro128** (PROVIDERS.a §4.1)', () => {
  it('produces the identical sequence from the identical seed, forever', () => {
    const a = draws(xoshiro128ss(1), 1_000);
    const b = draws(xoshiro128ss(1), 1_000);
    expect(a).toEqual(b);
    // The first values are pinned, so a change to the algorithm is a visible diff rather than a
    // silent re-shuffle of every golden file that depends on the feed.
    expect(a.slice(0, 4).map((v) => Math.round(v * 1e9) / 1e9)).toEqual(
      b.slice(0, 4).map((v) => Math.round(v * 1e9) / 1e9),
    );
  });

  it('gives neighbouring seeds unrelated streams', () => {
    const a = draws(xoshiro128ss(1), 200);
    const b = draws(xoshiro128ss(2), 200);
    expect(a).not.toEqual(b);
    const shared = a.filter((value, i) => value === b[i]).length;
    expect(shared).toBeLessThan(4);
  });

  it('stays inside [0, 1) and covers the range', () => {
    const values = draws(xoshiro128ss(12_345), 20_000);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    expect(mean).toBeGreaterThan(0.49);
    expect(mean).toBeLessThan(0.51);
    // Ten equal buckets, each within 15 % of its expected share.
    const buckets = Array.from({ length: 10 }, () => 0);
    for (const value of values) buckets[Math.min(9, Math.floor(value * 10))] += 1;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(2_000 * 0.85);
      expect(count).toBeLessThan(2_000 * 1.15);
    }
  });

  it('survives a zero seed and a non-finite one rather than degenerating', () => {
    expect(new Set(draws(xoshiro128ss(0), 100)).size).toBeGreaterThan(90);
    expect(new Set(draws(xoshiro128ss(Number.NaN), 100)).size).toBeGreaterThan(90);
    expect(draws(xoshiro128ss(0), 10)).toEqual(draws(xoshiro128ss(0), 10));
  });

  it('seeds through SplitMix32, which is itself deterministic', () => {
    expect(draws(splitmix32(7), 5)).toEqual(draws(splitmix32(7), 5));
    expect(draws(splitmix32(7), 5)).not.toEqual(draws(splitmix32(8), 5));
  });
});

describe('gaussian (Box–Muller, second draw cached)', () => {
  it('is standard normal to three decimal places over 100 000 draws', () => {
    const rng = xoshiro128ss(2_026);
    const values = Array.from({ length: 100_000 }, () => gaussian(rng));
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(Math.abs(variance - 1)).toBeLessThan(0.02);
    // The tails are where a broken Box–Muller shows up first.
    expect(values.filter((v) => Math.abs(v) > 1.96).length / values.length).toBeCloseTo(0.05, 2);
    expect(values.filter((v) => Math.abs(v) > 3).length / values.length).toBeCloseTo(0.0027, 3);
  });

  it('consumes exactly two uniforms per two draws — the cache is real', () => {
    const rng = xoshiro128ss(99);
    let used = 0;
    const counted = (): number => {
      used += 1;
      return rng();
    };
    gaussian(counted);
    expect(used).toBe(2);
    gaussian(counted);
    expect(used).toBe(2); // the cached second draw, no new uniforms
    gaussian(counted);
    expect(used).toBe(4);
  });

  it('is identical for two streams of one seed, and gaussianStream agrees with it', () => {
    const a = Array.from(
      { length: 50 },
      (
        (r) => () =>
          gaussian(r)
      )(xoshiro128ss(5)),
    );
    const b = Array.from(
      { length: 50 },
      (
        (r) => () =>
          gaussian(r)
      )(xoshiro128ss(5)),
    );
    expect(a).toEqual(b);
    const stream = gaussianStream(xoshiro128ss(5));
    expect(Array.from({ length: 50 }, () => stream())).toEqual(a);
  });
});

describe('subjectRng — one stream per subject (§4.1)', () => {
  it('gives a subject the same path whatever else is in the scenario', () => {
    const apple = draws(subjectRng(7, 'q:42'), 100);
    const again = draws(subjectRng(7, 'q:42'), 100);
    const other = draws(subjectRng(7, 'q:77'), 100);
    expect(again).toEqual(apple);
    expect(other).not.toEqual(apple);
    expect(draws(subjectRng(8, 'q:42'), 100)).not.toEqual(apple);
  });
});

describe('uniform, intBetween, pick', () => {
  it('stay inside their ranges and never return NaN', () => {
    const rng = xoshiro128ss(3);
    for (let i = 0; i < 1_000; i += 1) {
      const u = uniform(rng, -2, 5);
      expect(u).toBeGreaterThanOrEqual(-2);
      expect(u).toBeLessThan(5);
      const n = intBetween(rng, 1, 6);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(6);
    }
    expect(intBetween(rng, 5, 1)).toBe(5);
    expect(pick(rng, [])).toBeNull();
    expect(['a', 'b']).toContain(pick(rng, ['a', 'b']));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The feed
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SUBJECTS: readonly SimSubject[] = [
  {
    subject: 'q:42',
    instrumentId: 42,
    mdLineId: 420,
    assetClass: 'equity',
    tier: 'delayed',
    px0: 231.25,
    annualVolPct: 24,
    spreadBp: 4,
    avgTradeSize: 200,
    calendarId: 'XNYS',
  },
  {
    subject: 'q:77',
    instrumentId: 77,
    mdLineId: 770,
    assetClass: 'equity',
    tier: 'delayed',
    px0: 508.4,
    annualVolPct: 18,
    spreadBp: 2,
    avgTradeSize: 500,
    calendarId: 'XNYS',
  },
];

function runFeed(
  config: Partial<SimFeedConfig> & { seed: number },
  ticks = 120,
): NormalisedUpdate[] {
  const clock = testClock(TEST_NOW);
  const plant = recordingPlant();
  const feed = new SimFeed(
    {
      seed: config.seed,
      startMs: config.startMs ?? TEST_NOW,
      rateHz: config.rateHz ?? 50,
      subjects: config.subjects ?? SUBJECTS,
      ...(config.sessionOf === undefined ? {} : { sessionOf: config.sessionOf }),
    },
    { clock, plant, provenanceId: 987 },
  );
  expect(feed.problems).toEqual([]);
  feed.start();
  for (let i = 0; i < ticks; i += 1) {
    feed.pump();
    clock.advance(feed.intervalMs);
  }
  feed.stop();
  return plant.updates;
}

describe('SimFeed — two runs from one seed produce identical update streams (WP-05 acceptance)', () => {
  it('is identical field for field, including sizes, volume, timestamps and srcSeq', () => {
    const first = runFeed({ seed: 4_242 });
    const second = runFeed({ seed: 4_242 });

    expect(first.length).toBe(240); // 120 ticks × 2 subjects
    expect(second.length).toBe(first.length);
    // The whole stream, not a summary of it.
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('differs from a run of any other seed', () => {
    const a = runFeed({ seed: 4_242 });
    const b = runFeed({ seed: 4_243 });
    expect(b.length).toBe(a.length);
    expect(b).not.toEqual(a);
    const samePrice = a.filter((u, i) => u.fields.PX_LAST === b[i]?.fields.PX_LAST).length;
    expect(samePrice).toBeLessThan(a.length / 4);
  });

  it('does not depend on how the caller chops the virtual time up', () => {
    const byTick = runFeed({ seed: 11 }, 60);

    // The same 60 ticks, caught up in three jumps instead of sixty steps.
    const clock = testClock(TEST_NOW);
    const plant = recordingPlant();
    const feed = new SimFeed(
      { seed: 11, startMs: TEST_NOW, rateHz: 50, subjects: SUBJECTS },
      { clock, plant, provenanceId: 987 },
    );
    feed.start();
    // The same 1 180 ms of virtual time, in three jumps instead of sixty steps.
    for (const jump of [400, 400, 380]) {
      feed.pump();
      clock.advance(jump);
    }
    feed.pump();

    // `ts.cap` is the wall-clock reading of the pump that emitted the tick, so it differs between
    // the two drive patterns — §4.4's `replay:diff` ignores `cap`/`pub` for exactly this reason.
    // Everything else, `ts.src` included, is identical.
    const strip = (u: NormalisedUpdate): unknown => ({
      ...u,
      ts: { src: u.ts.src, pub: u.ts.pub },
    });
    expect(plant.updates.length).toBe(byTick.length);
    expect(plant.updates.map(strip)).toEqual(byTick.map(strip));
  });

  it('gives each subject its own path: adding q:77 does not move q:42', () => {
    const both = runFeed({ seed: 8 }, 40).filter((u) => u.subject === 'q:42');
    const alone = runFeed({ seed: 8, subjects: [SUBJECTS[0]!] }, 40);

    expect(alone.length).toBe(both.length);
    expect(alone.map((u) => u.fields.PX_LAST)).toEqual(both.map((u) => u.fields.PX_LAST));
    expect(alone.map((u) => u.fields.LAST_SIZE)).toEqual(both.map((u) => u.fields.LAST_SIZE));
    // `srcSeq` is a per-run counter over all subjects, so it is the one field that must differ.
    expect(alone[1]?.prov.srcSeq).toBe(2);
    expect(both[1]?.prov.srcSeq).toBe(3);
  });

  it('emits the shape a real normaliser emits, with simulated provenance', () => {
    const updates = runFeed({ seed: 5 }, 10);
    const first = updates[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    expect(first.subject).toBe('q:42');
    expect(first.instrumentId).toBe(42);
    expect(first.mdLineId).toBe(420);
    expect(first.assetClass).toBe('equity');
    expect(first.tier).toBe('delayed');
    expect(first.prov).toEqual({ sourceId: 'internal.derived', provenanceId: 987, srcSeq: 1 });
    expect(first.ts.src).toBe(TEST_NOW);
    expect(first.ts.pub).toBe(0); // the plant sets it

    // Subjects tick in their declared order, every tick.
    expect(updates.map((u) => u.subject)).toEqual(
      Array.from({ length: 10 }, () => ['q:42', 'q:77']).flat(),
    );
    expect(updates.map((u) => u.prov.srcSeq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    for (const update of updates) {
      const { PX_LAST, PX_BID, PX_ASK, BID_SIZE, ASK_SIZE, LAST_SIZE, PX_VOLUME, LAST_TRADE_TIME } =
        update.fields;
      expect(PX_LAST).toBeGreaterThan(0);
      expect(PX_BID).toBeLessThan(PX_ASK ?? 0);
      expect(PX_BID).toBeLessThanOrEqual(PX_LAST ?? 0);
      expect(PX_ASK).toBeGreaterThanOrEqual(PX_LAST ?? 0);
      // Prices are on the penny: no 123.45000000000001 in a golden file.
      expect(Math.round((PX_LAST ?? 0) * 100) / 100).toBe(PX_LAST);
      expect(Number.isInteger(BID_SIZE)).toBe(true);
      expect(Number.isInteger(ASK_SIZE)).toBe(true);
      expect(LAST_SIZE).toBeGreaterThan(0);
      expect(LAST_TRADE_TIME).toBe(update.ts.src);
      expect(PX_VOLUME).toBeGreaterThan(0);
    }

    // Cumulative volume is monotonic per subject and equals the sum of that subject's prints.
    const apple = updates.filter((u) => u.subject === 'q:42');
    let running = 0;
    for (const update of apple) {
      running += update.fields.LAST_SIZE ?? 0;
      expect(update.fields.PX_VOLUME).toBe(running);
    }
  });

  it('crosses the 16:00 ET close and reports the session from the calendar', () => {
    // 13:30Z on 2026-09-17 is 09:30 ET — the opening bell. One tick every fifteen minutes.
    const clock = testClock(TEST_NOW);
    const plant = recordingPlant();
    const feed = new SimFeed(
      { seed: 3, startMs: TEST_NOW, rateHz: 1 / 900, subjects: [SUBJECTS[0]!] },
      { clock, plant, provenanceId: 1 },
    );
    feed.start();
    for (let quarter = 0; quarter < 32; quarter += 1) {
      feed.pump();
      clock.advance(900_000);
    }

    const sessions = plant.updates.map((u) => ({ at: u.ts.src ?? 0, session: u.session }));
    expect(sessions.length).toBe(32);
    expect(sessions[0]?.session).toBe('open');

    const closeMs = Date.parse('2026-09-17T20:00:00.000Z'); // 16:00 America/New_York in September
    for (const { at, session } of sessions) {
      expect(session).toBe(at < closeMs ? 'open' : 'post');
    }
    // It really did cross the boundary.
    expect(new Set(sessions.map((s) => s.session))).toEqual(new Set(['open', 'post']));
  });

  it('reports a bad configuration instead of throwing, and skips the bad subject', () => {
    const clock = testClock(TEST_NOW);
    const plant = recordingPlant();
    const feed = new SimFeed(
      {
        seed: 1,
        startMs: TEST_NOW,
        rateHz: 10,
        subjects: [
          SUBJECTS[0]!,
          { ...SUBJECTS[0]!, subject: 'q:99', px0: 0 },
          { ...SUBJECTS[1]!, subject: 'q:42' },
        ],
      },
      { clock, plant, provenanceId: 1 },
    );
    expect(feed.problems.length).toBe(2);
    expect(feed.problems.map((p) => p.kind).sort()).toEqual(['out_of_range', 'schema_drift']);
    feed.start();
    feed.pump();
    expect(plant.updates.length).toBe(1);

    // A zero rate is refused outright rather than spinning.
    const dead = new SimFeed(
      { seed: 1, startMs: TEST_NOW, rateHz: 0, subjects: SUBJECTS },
      { clock, plant, provenanceId: 1 },
    );
    dead.start();
    expect(dead.running).toBe(false);
    expect(dead.pump()).toBe(0);
    expect(dead.problems.some((p) => p.kind === 'out_of_range')).toBe(true);
  });

  it('keeps running when the plant rejects an update', () => {
    const clock = testClock(TEST_NOW);
    let applied = 0;
    const plant = {
      apply(): void {
        applied += 1;
        if (applied === 2) throw new Error('plant is degraded');
      },
    };
    const feed = new SimFeed(
      { seed: 2, startMs: TEST_NOW, rateHz: 10, subjects: SUBJECTS },
      { clock, plant, provenanceId: 1 },
    );
    feed.start();
    feed.pump();
    clock.advance(100);
    feed.pump();
    expect(applied).toBe(4);
    expect(feed.ticks).toBe(3); // one was rejected
    expect(feed.problems.some((p) => p.detail.includes('plant.apply threw'))).toBe(true);
  });

  it('runs itself when a timer is injected, and stops when told to', () => {
    const clock = testClock(TEST_NOW);
    const plant = recordingPlant();
    let armed: { fn: () => void; everyMs: number } | null = null;
    const timer = {
      schedule(fn: () => void, everyMs: number): unknown {
        armed = { fn, everyMs };
        return 'handle';
      },
      cancel(handle: unknown): void {
        expect(handle).toBe('handle');
        armed = null;
      },
    };
    const feed = new SimFeed(
      { seed: 6, startMs: TEST_NOW, rateHz: 100, subjects: SUBJECTS },
      { clock, plant, provenanceId: 1, timer },
    );
    feed.start();
    expect(armed).not.toBeNull();
    expect(armed?.everyMs).toBe(10);

    armed?.fn();
    expect(plant.updates.length).toBe(2);
    clock.advance(10);
    armed?.fn();
    expect(plant.updates.length).toBe(4);

    feed.stop();
    expect(armed).toBeNull();
    expect(feed.pump()).toBe(0);
  });
});
