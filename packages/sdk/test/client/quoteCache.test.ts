/**
 * `test/client/quoteCache.test.ts` — WORKPLAN WP-13 acceptance row:
 * *"`snap` then `delta` produces the same state as a fresh `snap`; the 1 s ticker marks stale using
 * the core function"*.
 *
 * The equality is the whole design. A terminal applies one snapshot and then deltas for hours; a
 * reconnect re-snapshots. If the two paths can diverge by so much as a field timestamp, a cell can
 * show one thing before a reconnect and another after it with nothing having changed in the market —
 * and nothing on screen would say which is true. So the frames here are not hand-written: they come
 * from {@link Plant}, a transcription of the server's own projection
 * (`server/src/plant/policyTier.ts#view` encoded by `server/src/ws/conflator.ts#snapFrame` /
 * `#deltaFrame`), so a `snap` and the `delta`s that lead to the same `seq` are built from ONE state
 * exactly as the server builds them. Then the two caches are compared member by member.
 *
 * The prev-chain block is API.md §6.3 step 3, in the same order as the reference client in
 * `server/test/integration/ws/resync.test.ts` — the other half of this protocol.
 */
import { VirtualClock, valueState } from '@terminal/core';
import { describe, expect, it } from 'vitest';

import {
  CLIENT_DELAY_MIN,
  CLIENT_EXPECTED_INTERVAL_MS,
  QuoteCache,
  STALENESS_TICK_MS,
} from '../../src/client/quoteCache.js';
import type { QuoteView, TickerTimers } from '../../src/client/quoteCache.js';
import type {
  AssetClass,
  FieldId,
  FieldValue,
  ReasonCode,
  SessionState,
  ValueState,
} from '../../src/wire/envelope.js';
import { Delta, Snap, Status } from '../../src/wire/ws.js';
import type { Delta as DeltaFrame, Prov, Snap as SnapFrame, Ts } from '../../src/wire/ws.js';

const SUBJECT = 'q:42';
const INSTRUMENT_ID = 42;
const ASSET_CLASS: AssetClass = 'equity';
/** The subscribed field set — `snap.f` carries exactly these, in this order (BUS-02). */
const SUBSCRIBED: readonly FieldId[] = [
  'PX_LAST',
  'PX_BID',
  'PX_ASK',
  'PX_VOLUME',
  'CHG_PCT_1D',
  'VWAP',
  'IVOL_30D',
];
const T0 = 1_789_497_688_000;

/**
 * The server's half, in miniature: one composite, projected into frames exactly as
 * `plant/policyTier.ts#view` + `ws/conflator.ts` project it.
 *
 * - a field with no value is **absent** from the composite and `null` in a frame;
 * - `fts` carries a stamp only for a field that carries a value;
 * - `r` carries a reason only for a field that is NOT served, and is off the frame when empty;
 * - a `delta` reports only the fields that changed, and `seq` may skip (that is conflation) while
 *   `prev` never does.
 */
class Plant {
  seq = 99;
  readonly fields = new Map<FieldId, Exclude<FieldValue, null>>();
  readonly fieldTs = new Map<FieldId, number>();
  readonly denied = new Map<FieldId, ReasonCode>();
  ts: Ts = { src: T0 - 8_000, cap: T0, pub: T0 + 1 };
  st: ValueState = 'live';
  session: SessionState = 'open';
  prov: Prov = { p: 'cboe.quotes', id: 88_213, seq: 15_972_883_317 };

  /**
   * Apply one update: `undefined` clears a field (the composite loses the member), anything else
   * sets it. Returns the ids that changed, which is what the conflator's dirty mask holds.
   */
  apply(
    patch: Record<string, Exclude<FieldValue, null> | undefined>,
    at: { seq: number; src: number; cap: number },
  ): FieldId[] {
    const changed: FieldId[] = [];
    for (const [id, value] of Object.entries(patch)) {
      if (value === undefined) {
        this.fields.delete(id);
        this.fieldTs.delete(id);
      } else {
        this.fields.set(id, value);
        this.fieldTs.set(id, at.src);
      }
      changed.push(id);
    }
    this.seq = at.seq;
    this.ts = { src: at.src, cap: at.cap, pub: at.cap + 1 };
    return changed;
  }

  /** `f` for a set of ids: the denial, the value, or `null` when the composite has none. */
  #project(ids: readonly FieldId[]): {
    f: Record<FieldId, FieldValue>;
    fts: Record<FieldId, number>;
    r: Record<FieldId, ReasonCode>;
  } {
    const f: Record<FieldId, FieldValue> = {};
    const fts: Record<FieldId, number> = {};
    const r: Record<FieldId, ReasonCode> = {};
    for (const id of ids) {
      const denial = this.denied.get(id);
      if (denial !== undefined) {
        f[id] = null;
        r[id] = denial;
        continue;
      }
      const value = this.fields.get(id);
      if (value === undefined) {
        f[id] = null;
        continue;
      }
      f[id] = value;
      const stamp = this.fieldTs.get(id);
      if (stamp !== undefined) fts[id] = stamp;
    }
    return { f, fts, r };
  }

  /** One `snap` over the whole subscribed set (API.md §6.3 step 2). */
  snap(): SnapFrame {
    const { f, fts, r } = this.#project(SUBSCRIBED);
    return Snap.parse({
      t: 'snap',
      s: SUBJECT,
      seq: this.seq,
      tier: 'delayed',
      reason: 'SOURCE_TIER_CAP',
      f,
      fts,
      ...(Object.keys(r).length > 0 ? { r } : {}),
      ts: this.ts,
      st: this.st,
      session: this.session,
      prov: this.prov,
      ac: ASSET_CLASS,
      id: INSTRUMENT_ID,
    });
  }

  /** One `delta` over the ids that changed, chained to `prev`. */
  delta(prev: number, ids: readonly FieldId[]): DeltaFrame {
    const { f, fts } = this.#project(ids);
    return Delta.parse({
      t: 'delta',
      s: SUBJECT,
      seq: this.seq,
      prev,
      f,
      ...(Object.keys(fts).length > 0 ? { fts } : {}),
      ts: this.ts,
      st: this.st,
      prov: this.prov,
    });
  }
}

/** A plant holding the opening snapshot of §6.8's recorded exchange, plus a denied field. */
function openedPlant(): Plant {
  const plant = new Plant();
  plant.denied.set('IVOL_30D', 'NO_USER_ENTITLEMENT');
  plant.apply(
    {
      PX_LAST: 330.27,
      PX_BID: 330.25,
      PX_ASK: 330.28,
      PX_VOLUME: 16_591_786,
      CHG_PCT_1D: -0.8436,
    },
    { seq: 100, src: T0 - 8_000, cap: T0 },
  );
  return plant;
}

function view(cache: QuoteCache, subject = SUBJECT): QuoteView {
  const found = cache.get(subject);
  if (found === undefined) throw new Error(`no view for ${subject}`);
  return found;
}

describe('QuoteCache — a snap plus its deltas is a fresh snap (API.md §6.3, WP-13 acceptance)', () => {
  it('lands on the same state, member by member, as a cold subscribe at the same seq', () => {
    const plant = openedPlant();

    // The warm client: the opening snapshot, then the chain.
    const warm = new QuoteCache();
    warm.apply(plant.snap());
    expect(view(warm).seq).toBe(100);

    // A conflated flush: `seq` skips 101 and 102, `prev` does not.
    const first = plant.apply(
      { PX_LAST: 330.31, PX_VOLUME: 16_601_102 },
      { seq: 103, src: T0 + 15_000, cap: T0 + 15_400 },
    );
    expect(warm.apply(plant.delta(100, first))).toEqual({
      changed: ['PX_LAST', 'PX_VOLUME'],
      resyncNeeded: false,
    });

    // The book is withdrawn (`null`, not a stale number) and a field appears for the first time.
    const second = plant.apply(
      { PX_BID: undefined, VWAP: 330.29 },
      { seq: 105, src: T0 + 25_000, cap: T0 + 25_600 },
    );
    expect(warm.apply(plant.delta(103, second))).toEqual({
      changed: ['PX_BID', 'VWAP'],
      resyncNeeded: false,
    });

    // The cold client: one snapshot of the same composite at the same seq.
    const cold = new QuoteCache();
    cold.apply(plant.snap());

    const a = view(warm);
    const b = view(cold);

    expect(a.seq).toBe(105);
    expect(b.seq).toBe(105);
    // Member by member, because a single `toEqual` would not say WHICH member drifted.
    expect(a.subject).toBe(b.subject);
    expect(a.instrumentId).toBe(b.instrumentId);
    expect(a.assetClass).toBe(b.assetClass);
    expect(a.seq).toBe(b.seq);
    expect(a.tier).toBe(b.tier);
    expect(a.reason).toBe(b.reason);
    expect(a.f).toEqual(b.f);
    expect(a.fts).toEqual(b.fts);
    expect(a.r).toEqual(b.r);
    expect(a.ts).toEqual(b.ts);
    expect(a.st).toBe(b.st);
    expect(a.session).toBe(b.session);
    expect(a.prov).toEqual(b.prov);
    expect(a.status).toBe(b.status);
    // And the whole object, so a member added later cannot escape the comparison.
    expect(a).toEqual(b);

    // The values themselves, so the equality above cannot be two identically wrong states.
    expect(a.f.PX_LAST).toBe(330.31);
    expect(a.f.PX_VOLUME).toBe(16_601_102);
    expect(a.f.VWAP).toBe(330.29);
    expect(a.f.PX_ASK).toBe(330.28);
    // A withdrawn book is blank, not the last bid.
    expect(a.f.PX_BID).toBeNull();
    // ...and it carries no timestamp any more: a stamp on a blank cell is a stamp about nothing.
    expect(a.fts.PX_BID).toBeUndefined();
    expect(a.fts.PX_LAST).toBe(T0 + 15_000);
    expect(a.fts.VWAP).toBe(T0 + 25_000);
    // The denial survived four frames and was never turned into a number (ENTL-05).
    expect(a.f.IVOL_30D).toBeNull();
    expect(a.r.IVOL_30D).toBe('NO_USER_ENTITLEMENT');
  });

  it('keeps the snap-only `session` when the session moves under the chain — the one exception, and it changes no verdict', () => {
    const plant = openedPlant();
    const warm = new QuoteCache();
    warm.apply(plant.snap());
    expect(view(warm).session).toBe('open');

    // The session moves open → post between two frames. `Delta` and `Status` carry no `session`
    // member at all (wire/ws.ts), so the only thing the wire restates is the verdict: `st:'closed'`.
    plant.session = 'post';
    plant.st = 'closed';
    const changed = plant.apply(
      { PX_LAST: 331.44 },
      { seq: 101, src: T0 + 30_000, cap: T0 + 30_100 },
    );
    warm.apply(plant.delta(100, changed));

    const cold = new QuoteCache();
    cold.apply(plant.snap());

    const a = view(warm);
    const b = view(cold);

    // Every member the wire restates still agrees, field for field.
    expect(a.seq).toBe(b.seq);
    expect(a.f).toEqual(b.f);
    expect(a.fts).toEqual(b.fts);
    expect(a.r).toEqual(b.r);
    expect(a.ts).toEqual(b.ts);
    expect(a.st).toBe(b.st);
    expect(a.prov).toEqual(b.prov);
    expect(a.status).toBe(b.status);
    // `session` is the documented exception: it is snap-only, so the delta-fed cache carries the
    // session its last `snap` named. `tier`, `reason`, `assetClass` and `instrumentId` are snap-only
    // for the same reason but cannot move without `downgrade` + `resync` → a fresh `snap`, so only
    // this one can actually differ. Pinned here so a reader of `view.session` finds it stated.
    expect(a.session).toBe('open');
    expect(b.session).toBe('post');
    expect(a.tier).toBe(b.tier);
    expect(a.reason).toBe(b.reason);
    expect(a.assetClass).toBe(b.assetClass);
    expect(a.instrumentId).toBe(b.instrumentId);

    // And the verdict — the only thing that reaches a screen — is identical on both caches, now and
    // after the 1 s ticker, because the closed session is derived from `st` at the point of use
    // instead of being written into `session` (where it could not be undone without a snap).
    const later = T0 + 30_100 + 10 * CLIENT_EXPECTED_INTERVAL_MS.delayed;
    expect(warm.sweep(later)).toEqual([]);
    expect(cold.sweep(later)).toEqual([]);
    expect(view(warm).st).toBe('closed');
    expect(view(cold).st).toBe('closed');
  });

  it('is unchanged by a field absent from the delta (§6.3 step 4: a field-wise merge)', () => {
    const plant = openedPlant();
    const cache = new QuoteCache();
    cache.apply(plant.snap());

    const changed = plant.apply(
      { PX_LAST: 331.02 },
      { seq: 101, src: T0 + 9_000, cap: T0 + 9_100 },
    );
    cache.apply(plant.delta(100, changed));

    const v = view(cache);
    expect(v.f.PX_LAST).toBe(331.02);
    expect(v.f.PX_ASK).toBe(330.28);
    expect(v.f.PX_VOLUME).toBe(16_591_786);
    expect(v.fts.PX_ASK).toBe(T0 - 8_000);
  });

  it('reports only the fields whose value actually moved', () => {
    const plant = openedPlant();
    const cache = new QuoteCache();
    expect(cache.apply(plant.snap()).changed).toEqual([...SUBSCRIBED]);

    // A flush that re-reports PX_ASK at the same value and PX_LAST at a new one.
    const changed = plant.apply(
      { PX_LAST: 330.4, PX_ASK: 330.28 },
      { seq: 102, src: T0 + 11_000, cap: T0 + 11_050 },
    );
    expect(cache.apply(plant.delta(100, changed)).changed).toEqual(['PX_LAST']);
  });

  it('reports nothing changed when a resync snap repeats the state it already holds', () => {
    const plant = openedPlant();
    const cache = new QuoteCache();
    cache.apply(plant.snap());
    expect(cache.apply(plant.snap()).changed).toEqual([]);
  });
});

describe('QuoteCache — the prev chain (API.md §6.3 step 3)', () => {
  it('applies iff prev === lastSeq', () => {
    const plant = openedPlant();
    const cache = new QuoteCache();
    cache.apply(plant.snap());
    const changed = plant.apply({ PX_LAST: 330.31 }, { seq: 103, src: T0 + 1, cap: T0 + 2 });
    expect(cache.apply(plant.delta(100, changed)).resyncNeeded).toBe(false);
    expect(view(cache).seq).toBe(103);
  });

  it('drops a duplicate (seq <= lastSeq) without touching the view', () => {
    const plant = openedPlant();
    const cache = new QuoteCache();
    cache.apply(plant.snap());
    const changed = plant.apply({ PX_LAST: 330.31 }, { seq: 103, src: T0 + 1, cap: T0 + 2 });
    const frame = plant.delta(100, changed);
    cache.apply(frame);
    const before = { ...view(cache).f };

    // The same frame again, and an older one.
    expect(cache.apply(frame)).toEqual({ changed: [], resyncNeeded: false });
    expect(cache.apply({ ...frame, seq: 101, prev: 100 })).toEqual({
      changed: [],
      resyncNeeded: false,
    });
    expect(view(cache).f).toEqual(before);
    expect(view(cache).seq).toBe(103);
    expect(cache.isAwaitingSnap(SUBJECT)).toBe(false);
  });

  it('asks for a resync on a broken chain, never applying the gapped delta', () => {
    const plant = openedPlant();
    const cache = new QuoteCache();
    cache.apply(plant.snap());

    // The delta that would have chained 100 → 103 is lost; 103 → 108 arrives.
    plant.apply({ PX_LAST: 340.5 }, { seq: 103, src: T0 + 1, cap: T0 + 2 });
    const changed = plant.apply({ PX_LAST: 351.75 }, { seq: 108, src: T0 + 3, cap: T0 + 4 });

    expect(cache.apply(plant.delta(103, changed))).toEqual({ changed: [], resyncNeeded: true });
    expect(cache.isAwaitingSnap(SUBJECT)).toBe(true);
    // Not applied: the wrong number never reached the view, and the seq never moved.
    expect(view(cache).f.PX_LAST).toBe(330.27);
    expect(view(cache).seq).toBe(100);
  });

  it('ignores every further delta until a snap, and asks only once', () => {
    const plant = openedPlant();
    const cache = new QuoteCache();
    cache.apply(plant.snap());
    plant.apply({ PX_LAST: 340.5 }, { seq: 103, src: T0 + 1, cap: T0 + 2 });
    const gapped = plant.apply({ PX_LAST: 351.75 }, { seq: 108, src: T0 + 3, cap: T0 + 4 });
    cache.apply(plant.delta(103, gapped));

    // A perfectly chained delta after the gap is still ignored: the chain cannot heal itself.
    const next = plant.apply({ PX_LAST: 352.1 }, { seq: 109, src: T0 + 5, cap: T0 + 6 });
    expect(cache.apply(plant.delta(108, next))).toEqual({ changed: [], resyncNeeded: false });
    expect(view(cache).f.PX_LAST).toBe(330.27);

    // The fresh snap ends the wait and is where the client lands.
    const result = cache.apply(plant.snap());
    expect(result.resyncNeeded).toBe(false);
    expect(result.changed).toEqual(['PX_LAST']);
    expect(cache.isAwaitingSnap(SUBJECT)).toBe(false);
    expect(view(cache).f.PX_LAST).toBe(352.1);
    expect(view(cache).seq).toBe(109);

    // ...and the chain runs again from there.
    const after = plant.apply({ PX_LAST: 352.6 }, { seq: 110, src: T0 + 7, cap: T0 + 8 });
    expect(cache.apply(plant.delta(109, after)).changed).toEqual(['PX_LAST']);
  });

  it('treats a delta for a subject it has never snapped as a gap, not a first value', () => {
    const plant = openedPlant();
    const cache = new QuoteCache();
    const changed = plant.apply({ PX_LAST: 330.31 }, { seq: 103, src: T0 + 1, cap: T0 + 2 });
    expect(cache.apply(plant.delta(100, changed))).toEqual({ changed: [], resyncNeeded: true });
    expect(cache.get(SUBJECT)).toBeUndefined();
    expect(cache.isAwaitingSnap(SUBJECT)).toBe(true);
  });

  it('keeps `known` per subject for the reconnect re-sub (§6.3 step 6)', () => {
    const plant = openedPlant();
    const cache = new QuoteCache();
    cache.apply(plant.snap());
    const changed = plant.apply({ PX_LAST: 330.31 }, { seq: 103, src: T0 + 1, cap: T0 + 2 });
    cache.apply(plant.delta(100, changed));
    expect(cache.known()).toEqual({ [SUBJECT]: 103 });
    cache.delete(SUBJECT);
    expect(cache.known()).toEqual({});
    expect(cache.subjects()).toEqual([]);
  });
});

describe('QuoteCache — the 1 s staleness ticker calls the core function (TERM-12)', () => {
  /** A snapshot of a subject that is trading, captured now. */
  function liveCache(clock: VirtualClock): QuoteCache {
    const plant = new Plant();
    plant.ts = { src: clock.now() - 1_000, cap: clock.now(), pub: clock.now() };
    plant.apply({ PX_LAST: 330.27 }, { seq: 100, src: clock.now() - 1_000, cap: clock.now() });
    const cache = new QuoteCache({ clock });
    cache.apply(plant.snap());
    return cache;
  }

  it('marks a subject stale exactly when core/quote/staleness.ts does, on a VirtualClock', () => {
    const clock = new VirtualClock(T0);
    const cache = liveCache(clock);
    const limit = 3 * CLIENT_EXPECTED_INTERVAL_MS.delayed;

    expect(view(cache).st).toBe('live');
    // A second of silence changes nothing, and a sweep that changes nothing reports nothing.
    clock.advance(1_000);
    expect(cache.tick()).toEqual([]);
    expect(view(cache).st).toBe('live');

    // The boundary: an age of exactly 3 × expectedIntervalMs is still live.
    clock.advanceTo(T0 + limit);
    expect(cache.tick()).toEqual([]);
    expect(view(cache).st).toBe('live');

    // One millisecond beyond it is stale — and it is the CORE function that says so, called with
    // the cache's own input, on both sides of the boundary.
    const stalenessInput = {
      ts: view(cache).ts,
      session: 'open' as const,
      expectedIntervalMs: CLIENT_EXPECTED_INTERVAL_MS.delayed,
      delayMin: CLIENT_DELAY_MIN.delayed,
      fields: { PX_LAST: 330.27 },
    };
    expect(valueState(stalenessInput, clock.now())).toBe('live');
    clock.advance(1);
    expect(valueState(stalenessInput, clock.now())).toBe('stale');
    expect(cache.tick()).toEqual([SUBJECT]);
    expect(view(cache).st).toBe('stale');

    // Only on transition: a stale subject does not re-announce itself every second.
    clock.advance(1_000);
    expect(cache.tick()).toEqual([]);
  });

  it('installs a 1 000 ms interval and sweeps on every tick', () => {
    const clock = new VirtualClock(T0);
    const installed: number[] = [];
    let fire: (() => void) | null = null;
    let cleared = 0;
    const timers: TickerTimers = {
      setInterval: (handler, ms) => {
        installed.push(ms);
        fire = handler;
        return 'handle';
      },
      clearInterval: () => {
        cleared += 1;
      },
    };
    const plant = new Plant();
    plant.ts = { src: T0 - 1_000, cap: T0, pub: T0 };
    plant.apply({ PX_LAST: 330.27 }, { seq: 100, src: T0 - 1_000, cap: T0 });
    const cache = new QuoteCache({ clock, timers });
    cache.apply(plant.snap());

    const swept: string[][] = [];
    const stop = cache.startTicker((subjects) => swept.push(subjects));
    expect(installed).toEqual([STALENESS_TICK_MS]);
    expect(STALENESS_TICK_MS).toBe(1_000);
    expect(cache.ticking).toBe(true);
    // Starting twice installs one timer, not two, and does not drop the first handler.
    cache.startTicker();
    expect(installed).toEqual([STALENESS_TICK_MS]);

    const tick = (): void => {
      clock.advance(STALENESS_TICK_MS);
      if (fire === null) throw new Error('no ticker installed');
      fire();
    };
    for (let i = 0; i < 30; i += 1) tick();
    expect(view(cache).st).toBe('live'); // 30 000 ms: exactly the limit
    expect(swept).toEqual([]);
    tick();
    expect(view(cache).st).toBe('stale');
    expect(swept).toEqual([[SUBJECT]]);

    stop();
    expect(cleared).toBe(1);
    expect(cache.ticking).toBe(false);
  });

  it('does not recompute a closed session into a stale one', () => {
    const clock = new VirtualClock(T0);
    const cache = liveCache(clock);
    // The server's 1 s sweep closed it (`ws/session.ts#onStalenessTransition`).
    cache.apply(
      Status.parse({ t: 'status', s: SUBJECT, st: 'closed', reason: 'STALENESS', ts: T0 }),
    );
    expect(view(cache).st).toBe('closed');

    // A closed official print is not stale however old it is — and the client must not disagree
    // with the `status` frame it just applied, because a `delta` carries no `session`.
    clock.advance(10 * 60_000);
    expect(cache.tick()).toEqual([]);
    expect(view(cache).st).toBe('closed');
  });

  it('keeps a denied subject blank rather than stale', () => {
    const clock = new VirtualClock(T0);
    const plant = new Plant();
    for (const id of SUBSCRIBED) plant.denied.set(id, 'NO_FIRM_ENTITLEMENT');
    plant.apply({}, { seq: 7, src: T0 - 1_000, cap: T0 });
    plant.st = 'blank';
    const blank = plant.snap();
    const cache = new QuoteCache({ clock });
    cache.apply({ ...blank, reason: 'NO_FIRM_ENTITLEMENT' });
    expect(view(cache).st).toBe('blank');

    clock.advance(10 * 60_000);
    expect(cache.tick()).toEqual([]);
    expect(view(cache).st).toBe('blank');
  });

  it('honours an injected expectedIntervalMs, per subject', () => {
    const clock = new VirtualClock(T0);
    const cache = new QuoteCache({ clock, expectedIntervalMs: 15_000 });
    const plant = new Plant();
    plant.ts = { src: T0 - 1_000, cap: T0, pub: T0 };
    plant.apply({ PX_LAST: 330.27 }, { seq: 100, src: T0 - 1_000, cap: T0 });
    cache.apply(plant.snap());

    clock.advanceTo(T0 + 45_000);
    expect(cache.tick()).toEqual([]);
    clock.advance(1);
    expect(cache.tick()).toEqual([SUBJECT]);
  });
});

describe('QuoteCache — status frames (API.md §6.5, §10.2)', () => {
  function cacheWithSnap(): QuoteCache {
    const plant = openedPlant();
    const cache = new QuoteCache();
    cache.apply(plant.snap());
    return cache;
  }

  it('records shed and keeps the last values on screen', () => {
    const cache = cacheWithSnap();
    const result = cache.apply(
      Status.parse({ t: 'status', s: SUBJECT, st: 'shed', reason: 'SLOW_CONSUMER', ts: T0 }),
    );
    expect(result).toEqual({ changed: [], resyncNeeded: false });
    expect(view(cache).status).toBe('shed');
    expect(view(cache).f.PX_LAST).toBe(330.27);
  });

  it('puts a halt on the session, not on the value state', () => {
    const cache = cacheWithSnap();
    cache.apply(Status.parse({ t: 'status', s: SUBJECT, st: 'halted', ts: T0 }));
    expect(view(cache).session).toBe('halted');
    expect(view(cache).st).toBe('live');
  });

  it('ignores a status for a subject no snap has described', () => {
    const cache = new QuoteCache();
    expect(cache.apply(Status.parse({ t: 'status', s: 'q:999', st: 'gone', ts: T0 }))).toEqual({
      changed: [],
      resyncNeeded: false,
    });
    expect(cache.subjects()).toEqual([]);
  });

  it('a fresh snap re-marks a shed subject live', () => {
    const plant = openedPlant();
    const cache = new QuoteCache();
    cache.apply(plant.snap());
    cache.apply(Status.parse({ t: 'status', s: SUBJECT, st: 'shed', reason: 'SHED', ts: T0 }));
    expect(view(cache).status).toBe('shed');
    cache.apply(plant.snap());
    expect(view(cache).status).toBe('live');
  });
});
