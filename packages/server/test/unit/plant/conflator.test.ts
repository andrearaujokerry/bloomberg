/**
 * BUS-03 / BUS-04 — `ws/conflator.ts` and `ws/protocol.ts`
 * (ARCHITECTURE §6.3 L835-878, API.md §6.4 L948-975 and §6.5 L977-998).
 *
 * The plant is a hand-built `PlantReader` over a `Map`: the conflator's contract with the plant is
 * exactly `get(subject)` + `eodView(subject)`, and reading the composite **at flush time** is the
 * whole latest-value guarantee, so a fake that mutates one state object in place is the sharpest
 * test of it — if the conflator ever copied a value at `mark()` time these tests fail.
 *
 * Everything is driven by a `VirtualClock`; nothing here starts a timer (those live in
 * `ws/session.ts`) and nothing touches a socket.
 */

import { describe, expect, it } from 'vitest';

import { VirtualClock, maskOf } from '@terminal/core';
import type { FieldId, QuoteFields, QuoteState } from '@terminal/core';
import type { Delta, ServerMsg, Snap, Status } from '@terminal/sdk/wire/ws';

import type { EodView } from '../../../src/plant/eod.js';
import { Conflator } from '../../../src/ws/conflator.js';
import type { PlantReader, Subscription } from '../../../src/ws/conflator.js';
import {
  ProtocolEncodeError,
  clientFrameLimit,
  decode,
  encode,
  frameBytes,
  MAX_CLIENT_FRAME_BYTES,
  MAX_CLIENT_FRAME_HARD_BYTES,
  MAX_SUBJECT_FRAME_BYTES,
} from '../../../src/ws/protocol.js';

/** 2026-09-15 20:00:00Z — the session close the `policyTier` fixtures use. */
const T0 = Date.parse('2026-09-15T20:00:00.000Z');

// ---------------------------------------------------------------------------
// Fake plant
// ---------------------------------------------------------------------------

class FakePlant implements PlantReader {
  readonly states = new Map<string, QuoteState>();
  readonly eods = new Map<string, EodView>();

  get(subject: string): QuoteState | undefined {
    return this.states.get(subject);
  }

  eodView(subject: string): EodView | null {
    return this.eods.get(subject) ?? null;
  }

  seed(subject: string, instrumentId: number, fields: QuoteFields, atMs: number): QuoteState {
    const fieldTs: QuoteState['fieldTs'] = {};
    for (const id of Object.keys(fields) as (keyof QuoteFields)[]) fieldTs[id] = atMs;
    const state: QuoteState = {
      subject,
      instrumentId,
      assetClass: 'equity',
      seq: 1,
      tier: 'delayed',
      delayMin: 15,
      fields: { ...fields },
      fieldTs,
      ts: { src: atMs, cap: atMs + 1, pub: atMs + 2 },
      session: 'open',
      state: 'live',
      ageMs: 0,
      expectedIntervalMs: 15_000,
      prov: { sourceId: 'cboe.quotes', provenanceId: 88_213, srcSeq: 15_972_883_317 },
      lines: {},
      dq: [],
    };
    this.states.set(subject, state);
    return state;
  }

  /** Apply a patch the way the real plant does: mutate in place, bump `seq`. Returns the mask. */
  apply(subject: string, patch: Partial<QuoteFields>, atMs: number): Uint32Array {
    const state = this.states.get(subject);
    if (state === undefined) throw new Error(`unseeded subject ${subject}`);
    for (const [id, value] of Object.entries(patch)) {
      (state.fields as Record<string, unknown>)[id] = value;
      (state.fieldTs as Record<string, number>)[id] = atMs;
    }
    state.seq += 1;
    state.ts = { src: atMs, cap: atMs + 1, pub: atMs + 2 };
    return maskOf(Object.keys(patch));
  }
}

function subscription(
  subject: string,
  ids: FieldId[],
  over: Partial<Subscription> = {},
): Subscription {
  return {
    subject,
    fieldMask: maskOf(ids),
    fieldIds: ids,
    lastSentSeq: 0,
    tier: 'delayed',
    essential: true,
    denied: new Map(),
    reason: 'SOURCE_TIER_CAP',
    lastFlushMs: 0,
    ...over,
  };
}

interface Harness {
  clock: VirtualClock;
  plant: FakePlant;
  conflator: Conflator;
  frames: ServerMsg[];
  events: { kind: string; [k: string]: unknown }[];
  /** What `bufferedAmount()` returns on the next flush. */
  buffered: { value: number };
  batches(): Extract<ServerMsg, { t: 'batch' }>[];
  members(): (Snap | Delta | Status)[];
  deltas(): Delta[];
  notices(): Extract<ServerMsg, { t: 'notice' }>[];
}

function harness(
  opts: { requestedMs?: number; thresholds?: Record<string, number> } = {},
): Harness {
  const clock = new VirtualClock(T0);
  const plant = new FakePlant();
  const frames: ServerMsg[] = [];
  const events: { kind: string; [k: string]: unknown }[] = [];
  const buffered = { value: 0 };
  const conflator = new Conflator({
    plant,
    clock,
    requestedMs: opts.requestedMs ?? 250,
    send: (frame) => frames.push(frame),
    bufferedAmount: () => buffered.value,
    ...(opts.thresholds === undefined ? {} : { thresholds: opts.thresholds }),
    onEvent: (ev) => events.push(ev),
  });
  const batches = (): Extract<ServerMsg, { t: 'batch' }>[] =>
    frames.filter((f): f is Extract<ServerMsg, { t: 'batch' }> => f.t === 'batch');
  const members = (): (Snap | Delta | Status)[] => batches().flatMap((b) => b.m);
  return {
    clock,
    plant,
    conflator,
    frames,
    events,
    buffered,
    batches,
    members,
    deltas: () => members().filter((m): m is Delta => m.t === 'delta'),
    notices: () => frames.filter((f): f is Extract<ServerMsg, { t: 'notice' }> => f.t === 'notice'),
  };
}

// ---------------------------------------------------------------------------
// BUS-03 — the latest-value guarantee
// ---------------------------------------------------------------------------

describe('conflator — latest-value guarantee (BUS-03)', () => {
  it('collapses N updates inside one window into one delta carrying the latest of every field', () => {
    const h = harness();
    const state = h.plant.seed(
      'q:101',
      101,
      { PX_LAST: 330.27, PX_BID: 330.25, PX_ASK: 330.28, PX_VOLUME: 16_591_786 },
      T0,
    );
    const ids: FieldId[] = ['PX_LAST', 'PX_BID', 'PX_ASK', 'PX_VOLUME'];
    h.conflator.add(subscription('q:101', ids, { lastSentSeq: state.seq }), { snapshot: false });

    // 40 updates inside one 250 ms window: 10 of them move PX_BID only, the rest move the trio.
    let last = 330.27;
    let volume = 16_591_786;
    for (let i = 0; i < 40; i += 1) {
      h.clock.advance(5);
      const now = h.clock.now();
      last = Number((330.27 + i * 0.01).toFixed(2));
      volume += 100;
      const patch: Partial<QuoteFields> =
        i % 4 === 0
          ? { PX_BID: Number((last - 0.02).toFixed(2)) }
          : { PX_LAST: last, PX_VOLUME: volume };
      h.conflator.mark('q:101', h.plant.apply('q:101', patch, now));
    }

    const outcome = h.conflator.flush();

    expect(outcome.frames).toBe(1);
    expect(outcome.subjects).toBe(1);
    expect(h.deltas()).toHaveLength(1);
    const delta = h.deltas()[0]!;
    expect(delta.s).toBe('q:101');
    expect(delta.prev).toBe(1); // the seq the subscription was sitting on
    expect(delta.seq).toBe(41); // 40 applies, conflated into one frame — seq skips, prev does not
    // Every field that changed in the window is present, with its LAST value — nothing is lost.
    expect(delta.f).toEqual({
      PX_LAST: 330.66, // last applied at i = 39
      PX_BID: 330.61, // last applied at i = 36
      PX_VOLUME: 16_595_786, // 40 increments of 100
    });
    expect(delta.f.PX_LAST).toBe(h.plant.get('q:101')!.fields.PX_LAST);
    expect(delta.f.PX_VOLUME).toBe(h.plant.get('q:101')!.fields.PX_VOLUME);
    // PX_ASK never changed, so it is absent from the delta (a delta is a patch, not a snapshot).
    expect(delta.f.PX_ASK).toBeUndefined();
    expect(h.conflator.dirtySize()).toBe(0);
  });

  it('never sends a field outside the subscription mask (BUS-02)', () => {
    const h = harness();
    const state = h.plant.seed('q:101', 101, { PX_LAST: 100, PX_BID: 99, PX_ASK: 101 }, T0);
    h.conflator.add(subscription('q:101', ['PX_LAST'], { lastSentSeq: state.seq }), {
      snapshot: false,
    });

    h.clock.advance(10);
    h.conflator.mark('q:101', h.plant.apply('q:101', { PX_BID: 98.5 }, h.clock.now()));
    expect(h.conflator.flush().sent).toBe(false); // nothing subscribed changed

    h.clock.advance(10);
    h.conflator.mark(
      'q:101',
      h.plant.apply('q:101', { PX_LAST: 101.5, PX_ASK: 102 }, h.clock.now()),
    );
    h.conflator.flush();

    expect(h.deltas()).toHaveLength(1);
    expect(h.deltas()[0]!.f).toEqual({ PX_LAST: 101.5 });
  });

  it('answers a new subscription with one snap carrying the full field set and reason map', () => {
    const h = harness();
    h.plant.seed('q:101', 101, { PX_LAST: 330.27, PX_VOLUME: 16_591_786 }, T0);
    const denied = new Map<FieldId, typeof reason>();
    const reason = 'NO_FIRM_ENTITLEMENT' as const;
    denied.set('PX_BID', reason);
    h.conflator.add(subscription('q:101', ['PX_LAST', 'PX_BID', 'PX_VOLUME'], { denied }));

    h.conflator.flush();

    const snaps = h.members().filter((m): m is Snap => m.t === 'snap');
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.f).toEqual({ PX_LAST: 330.27, PX_BID: null, PX_VOLUME: 16_591_786 });
    // `r` lists only what is not served (ENTL-05); the two granted fields carry no key.
    expect(snaps[0]!.r).toEqual({ PX_BID: 'NO_FIRM_ENTITLEMENT' });
    expect(snaps[0]!.tier).toBe('delayed');
    expect(snaps[0]!.prov).toEqual({ p: 'cboe.quotes', id: 88_213, seq: 15_972_883_317 });
    expect(snaps[0]!.ac).toBe('equity');
    expect(snaps[0]!.id).toBe(101);

    // A later delta never introduces the denial again — the snap's `r` map owns it.
    h.clock.advance(300);
    h.conflator.mark(
      'q:101',
      h.plant.apply('q:101', { PX_LAST: 331, PX_BID: 330.9 }, h.clock.now()),
    );
    h.conflator.flush();
    expect(h.deltas()).toHaveLength(1);
    expect(h.deltas()[0]!.f).toEqual({ PX_LAST: 331 });
    expect(h.deltas()[0]!.prev).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// NEWS-01 — the queued carve-out
// ---------------------------------------------------------------------------

describe('conflator — n:* headlines are queued, not conflated (NEWS-01)', () => {
  /** A news publication: the plant's state for `n:<scope>` carries the headline's fields. */
  function headline(subject: string, seq: number, id: string, publishedAt: number): QuoteState {
    return {
      subject,
      instrumentId: 0,
      assetClass: 'equity',
      seq,
      tier: 'delayed',
      delayMin: 0,
      // News fields are dictionary fields but not `QuoteFields` keys; the plant's `publish()`
      // carries them in the same bag, so the test does what the plant does.
      fields: {
        NEWS_ID: id,
        HEADLINE: `headline ${id}`,
        PUBLISHED_AT: publishedAt,
      } as unknown as QuoteFields,
      fieldTs: {},
      ts: { src: publishedAt, cap: publishedAt, pub: publishedAt },
      session: 'open',
      state: 'live',
      ageMs: 0,
      expectedIntervalMs: 60_000,
      prov: { sourceId: 'gdelt', provenanceId: 5 },
      lines: {},
      dq: [],
    };
  }

  it('emits one delta per headline, in publishedAt order, inside one window', () => {
    const h = harness();
    const first = headline('n:all', 2, 'N1', T0 + 10);
    const second = headline('n:all', 3, 'N2', T0 + 40);
    h.plant.states.set('n:all', second); // the plant only holds the LATEST publication
    h.conflator.add(subscription('n:all', [], { lastSentSeq: 1, essential: false }), {
      snapshot: false,
    });

    h.conflator.markQueued('n:all', first.seq, first);
    h.conflator.markQueued('n:all', second.seq, second);
    h.clock.advance(250);
    const outcome = h.conflator.flush();

    expect(outcome.subjects).toBe(1);
    const deltas = h.deltas();
    expect(deltas).toHaveLength(2); // two headlines, two deltas — never one
    expect(deltas.map((d) => d.f.NEWS_ID)).toEqual(['N1', 'N2']);
    expect(deltas.map((d) => d.f.HEADLINE)).toEqual(['headline N1', 'headline N2']);
    expect(deltas.map((d) => d.f.PUBLISHED_AT)).toEqual([T0 + 10, T0 + 40]);
    // The prev chain across the two is contiguous.
    expect(deltas[0]!.prev).toBe(1);
    expect(deltas[0]!.seq).toBe(2);
    expect(deltas[1]!.prev).toBe(2);
    expect(deltas[1]!.seq).toBe(3);
    expect(h.conflator.queuedSize()).toBe(0);
  });

  it('keeps every headline across a skipped flush', () => {
    const h = harness();
    h.plant.states.set('n:all', headline('n:all', 3, 'N2', T0 + 40));
    h.conflator.add(subscription('n:all', [], { lastSentSeq: 1 }), { snapshot: false });
    h.conflator.markQueued('n:all', 2, headline('n:all', 2, 'N1', T0 + 10));

    h.buffered.value = 3_000_000; // > HARD_BYTES
    expect(h.conflator.flush().skipped).toBe(true);
    h.conflator.markQueued('n:all', 3, headline('n:all', 3, 'N2', T0 + 40));

    h.buffered.value = 0;
    h.conflator.flush();
    expect(h.deltas().map((d) => d.f.NEWS_ID)).toEqual(['N1', 'N2']);
  });
});

// ---------------------------------------------------------------------------
// The eod floor
// ---------------------------------------------------------------------------

describe('conflator — eod-tier subjects flush at most every 60 s', () => {
  it('does not flush an eod subject twice inside 60 000 ms on a VirtualClock', () => {
    const h = harness();
    h.plant.seed('q:101', 101, { PX_LAST: 330.27, PX_VOLUME: 16_591_786 }, T0);
    h.plant.eods.set('q:101', {
      sessionDate: '2026-09-15',
      closeTs: T0,
      fields: { PX_OFFICIAL_CLOSE: 333.08, PX_CLOSE_1D: 333.08, PX_VOLUME: 16_591_786 },
      flags: [],
    });
    h.conflator.add(
      subscription('q:101', ['PX_LAST', 'PX_VOLUME'], {
        tier: 'eod',
        lastSentSeq: 1,
        reason: 'NOT_ENTITLED_TIER',
      }),
      { snapshot: false },
    );

    h.clock.advance(1_000);
    h.conflator.mark('q:101', h.plant.apply('q:101', { PX_VOLUME: 16_600_000 }, h.clock.now()));
    expect(h.conflator.flush().sent).toBe(true);
    expect(h.deltas()).toHaveLength(1);
    // The eod view is frozen at the official close: the intraday volume is NOT what goes out.
    expect(h.deltas()[0]!.f).toEqual({ PX_VOLUME: 16_591_786 });

    // 59 s later, 20 more updates, 20 flushes: not one frame.
    for (let i = 0; i < 20; i += 1) {
      h.clock.advance(2_950);
      h.conflator.mark(
        'q:101',
        h.plant.apply('q:101', { PX_VOLUME: 16_600_000 + i }, h.clock.now()),
      );
      h.conflator.flush();
    }
    expect(h.deltas()).toHaveLength(1);
    expect(h.conflator.dirtySize()).toBe(1); // retained, not dropped

    // Past the 60 s floor it flushes again, once.
    h.clock.advance(2_000);
    h.conflator.flush();
    expect(h.deltas()).toHaveLength(2);
    expect(h.deltas()[1]!.prev).toBe(h.deltas()[0]!.seq);
  });

  it('never lets a delayed-tier subject inherit the eod floor', () => {
    const h = harness();
    h.plant.seed('q:101', 101, { PX_LAST: 330.27 }, T0);
    h.conflator.add(subscription('q:101', ['PX_LAST'], { lastSentSeq: 1 }), { snapshot: false });
    for (let i = 0; i < 5; i += 1) {
      h.clock.advance(250);
      h.conflator.mark('q:101', h.plant.apply('q:101', { PX_LAST: 330 + i }, h.clock.now()));
      h.conflator.flush();
    }
    expect(h.deltas()).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// The 1 MiB frame cap (API.md §6.4 snapshot-burst exception)
// ---------------------------------------------------------------------------

describe('conflator — a flush past the 1 MiB cap is split across consecutive batch frames', () => {
  it('splits the snapshot burst and keeps every per-subject prev chain contiguous', () => {
    const h = harness();
    const ids: FieldId[] = [
      'PX_LAST',
      'PX_BID',
      'PX_ASK',
      'PX_VOLUME',
      'PX_OPEN',
      'PX_HIGH',
      'PX_LOW',
    ];
    const subjects: string[] = [];
    for (let i = 0; i < 4_000; i += 1) {
      const subject = `q:${1_000 + i}`;
      subjects.push(subject);
      h.plant.seed(
        subject,
        1_000 + i,
        {
          PX_LAST: 330.27 + i / 100,
          PX_BID: 330.25 + i / 100,
          PX_ASK: 330.28 + i / 100,
          PX_VOLUME: 16_591_786 + i,
          PX_OPEN: 329.1,
          PX_HIGH: 331.9,
          PX_LOW: 328.4,
        },
        T0,
      );
      h.conflator.add(subscription(subject, ids));
    }

    const burst = h.conflator.flush();

    expect(burst.frames).toBeGreaterThan(1); // several MiB of snapshots cannot be one frame
    expect(burst.subjects).toBe(4_000);
    for (const batch of h.batches()) {
      expect(frameBytes(encode(batch))).toBeLessThanOrEqual(1_048_576);
    }
    // Exactly one snap per subject, across the run of frames, in dirty-map insertion order.
    const snaps = h.members().filter((m): m is Snap => m.t === 'snap');
    expect(snaps).toHaveLength(4_000);
    expect(snaps.map((s) => s.s)).toEqual(subjects);

    // Now a delta burst on every subject: the prev chain picks up from each snap's seq.
    const seqAtSnap = new Map(snaps.map((s) => [s.s, s.seq]));
    h.frames.length = 0;
    h.clock.advance(250);
    for (const subject of subjects) {
      h.conflator.mark(
        'q:' + subject.slice(2),
        h.plant.apply(subject, { PX_LAST: 999.99 }, h.clock.now()),
      );
    }
    const second = h.conflator.flush();

    expect(second.subjects).toBe(4_000);
    const deltas = h.deltas();
    expect(deltas).toHaveLength(4_000);
    for (const delta of deltas) {
      expect(delta.prev).toBe(seqAtSnap.get(delta.s));
      expect(delta.seq).toBeGreaterThan(delta.prev);
      expect(delta.f).toEqual({ PX_LAST: 999.99 });
    }
  });

  it('splits at whatever cap it is given, one subject per frame at the extreme', () => {
    const h = harness({ thresholds: { frameCapBytes: 260 } });
    for (let i = 0; i < 6; i += 1) {
      const subject = `q:${200 + i}`;
      h.plant.seed(subject, 200 + i, { PX_LAST: 10 + i, PX_VOLUME: 1_000 + i }, T0);
      h.conflator.add(subscription(subject, ['PX_LAST', 'PX_VOLUME']));
    }
    const outcome = h.conflator.flush();
    expect(outcome.frames).toBe(6);
    expect(h.members()).toHaveLength(6);
    expect(new Set(h.members().map((m) => m.s)).size).toBe(6); // still at most once per subject
  });
});

// ---------------------------------------------------------------------------
// BUS-04 — the §6.5 ladder
// ---------------------------------------------------------------------------

describe('conflator — the slow-consumer ladder walks every rung in order (BUS-04)', () => {
  it('widens, skips, sheds, warns and asks for 4008, then restores', () => {
    const h = harness();
    h.plant.seed('q:101', 101, { PX_LAST: 330.27 }, T0);
    h.plant.seed('n:all', 0, { PX_LAST: 1 }, T0);
    h.conflator.add(subscription('q:101', ['PX_LAST'], { lastSentSeq: 1 }), { snapshot: false });
    h.conflator.add(subscription('n:all', ['PX_LAST'], { lastSentSeq: 1, essential: false }), {
      snapshot: false,
    });

    const tick = (ms: number): void => {
      h.clock.advance(ms);
      h.conflator.mark(
        'q:101',
        h.plant.apply('q:101', { PX_LAST: 330 + ms / 1_000 }, h.clock.now()),
      );
    };

    // Rung 0 — healthy.
    tick(250);
    expect(h.conflator.flush().sent).toBe(true);
    expect(h.conflator.effectiveMs).toBe(250);

    // Rung 1 — bufferedAmount > SOFT: double, capped at MAX_MS, one notice per change.
    h.buffered.value = 300_000;
    for (const expected of [500, 1_000, 2_000, 4_000, 5_000]) {
      tick(250);
      h.conflator.flush();
      expect(h.conflator.effectiveMs).toBe(expected);
    }
    expect(h.notices().map((n) => n.conflationMs)).toEqual([500, 1_000, 2_000, 4_000, 5_000]);
    tick(250);
    h.conflator.flush();
    expect(h.conflator.effectiveMs).toBe(5_000); // capped, and no further notice
    expect(h.notices()).toHaveLength(5);

    // Rung 3 — bufferedAmount > HARD: the flush is skipped and the dirty set retained.
    h.buffered.value = 3_000_000;
    const framesBefore = h.batches().length;
    tick(5_000);
    const skipped = h.conflator.flush();
    expect(skipped.skipped).toBe(true);
    expect(skipped.dirty).toBe(1);
    expect(h.batches()).toHaveLength(framesBefore);

    // Rung 4 — still over after GRACE_MS: shed the non-essential subject, then notice.
    h.conflator.mark('n:all', h.plant.apply('n:all', { PX_LAST: 2 }, h.clock.now()));
    h.clock.advance(10_000);
    h.conflator.flush();
    const shed = h.frames.filter((f): f is Status => f.t === 'status' && f.st === 'shed');
    expect(shed.map((s) => s.s)).toEqual(['n:all']);
    expect(shed[0]!.reason).toBe('SLOW_CONSUMER');
    expect(h.notices().at(-1)).toEqual({ t: 'notice', kind: 'slow-consumer', action: 'shed' });
    expect(h.conflator.subs.has('q:101')).toBe(true); // the essential row survives

    // Rung 5 — still over after another GRACE_MS: disconnect-soon plus a close event for 4008.
    h.clock.advance(10_000);
    const exhausted = h.conflator.flush();
    expect(h.notices().at(-1)).toEqual({
      t: 'notice',
      kind: 'slow-consumer',
      action: 'disconnect-soon',
    });
    expect(exhausted.closed).toBe(true);
    expect(h.events.filter((e) => e.kind === 'close')).toEqual([
      { kind: 'close', code: 4008, reason: 'SLOW_CONSUMER', bufferedBytes: 3_000_000 },
    ]);

    // The rungs are in order, and every one of them is an event the session can persist.
    expect(h.events.map((e) => e.kind).filter((k) => k !== 'flushed')).toEqual([
      'conflation-widened',
      'conflation-widened',
      'conflation-widened',
      'conflation-widened',
      'conflation-widened',
      'flush-skipped',
      'shed',
      'flush-skipped',
      'disconnect-soon',
      'close',
      'flush-skipped',
    ]);

    // Recovery — < SOFT/4 for three consecutive flushes halves effectiveMs, never below requested.
    h.buffered.value = 10_000;
    h.conflator.flush();
    h.conflator.flush();
    expect(h.conflator.effectiveMs).toBe(5_000);
    h.conflator.flush();
    expect(h.conflator.effectiveMs).toBe(2_500);
    expect(h.notices().at(-1)).toEqual({
      t: 'notice',
      kind: 'slow-consumer',
      action: 'conflation-restored',
      conflationMs: 2_500,
    });

    // Nothing was lost across the skips: the retained dirty mask flushed the plant's latest value.
    const delivered = h.deltas().at(-1)!;
    expect(delivered.f.PX_LAST).toBe(h.plant.get('q:101')!.fields.PX_LAST);
    expect(delivered.s).toBe('q:101');
  });

  it('never restores below the requested interval and obeys the overload floor', () => {
    const h = harness({ requestedMs: 250 });
    h.plant.seed('q:101', 101, { PX_LAST: 1 }, T0);
    h.conflator.add(subscription('q:101', ['PX_LAST'], { lastSentSeq: 1 }), { snapshot: false });

    h.buffered.value = 300_000;
    h.conflator.flush();
    h.conflator.flush();
    expect(h.conflator.effectiveMs).toBe(1_000);

    h.buffered.value = 0;
    for (let i = 0; i < 12; i += 1) h.conflator.flush();
    expect(h.conflator.effectiveMs).toBe(250); // back to the client's request, never below

    // Plant overload: a global floor of 1 000 ms that the recovery rung cannot undercut.
    h.conflator.setFloor(1_000);
    expect(h.conflator.effectiveMs).toBe(1_000);
    expect(h.notices().at(-1)).toEqual({
      t: 'notice',
      kind: 'overload',
      action: 'conflation-widened',
      conflationMs: 1_000,
    });
    for (let i = 0; i < 12; i += 1) h.conflator.flush();
    expect(h.conflator.effectiveMs).toBe(1_000);
  });

  it('overload shedding never takes PX_LAST, CHG_NET_1D or CHG_PCT_1D away', () => {
    const h = harness();
    h.plant.seed('q:101', 101, { PX_LAST: 1 }, T0);
    h.plant.seed('b1m:101', 101, { PX_VOLUME: 1 }, T0);
    h.conflator.add(subscription('q:101', ['PX_LAST', 'CHG_PCT_1D'], { essential: false }), {
      snapshot: false,
    });
    h.conflator.add(subscription('b1m:101', ['PX_VOLUME'], { essential: false }), {
      snapshot: false,
    });

    expect(h.conflator.shedNonEssential('OVERLOAD', { protectCoreFields: true })).toEqual([
      'b1m:101',
    ]);
    expect(h.conflator.subs.has('q:101')).toBe(true);
    // The slow-consumer ladder has no such protection (API.md §6.8 sheds q:42 itself).
    expect(h.conflator.shedNonEssential('SLOW_CONSUMER')).toEqual(['q:101']);
  });
});

// ---------------------------------------------------------------------------
// ws/protocol.ts
// ---------------------------------------------------------------------------

describe('protocol — encode/decode strictly through the SDK schemas', () => {
  it('encodes a valid server frame and refuses one the server got wrong', () => {
    const pong: ServerMsg = { t: 'pong', n: 7, serverTime: T0 };
    expect(JSON.parse(encode(pong))).toEqual({ t: 'pong', n: 7, serverTime: T0 });
    expect(() => encode({ t: 'pong', n: 1.5, serverTime: T0 })).toThrow(ProtocolEncodeError);
    expect(() => encode({ t: 'nope' } as unknown as ServerMsg)).toThrow(ProtocolEncodeError);
  });

  it('decodes a client frame with the schema defaults applied', () => {
    const text = '{"t":"hello","protocol":1,"client":"web/0.1.0"}';
    expect(decode(text)).toEqual({
      ok: true,
      msg: { t: 'hello', protocol: 1, client: 'web/0.1.0', conflationMs: 250, resume: false },
      bytes: frameBytes(text),
    });
  });

  it('answers bad JSON, a bad frame and an oversized frame with a code, never an exception', () => {
    expect(decode('{')).toMatchObject({ ok: false, code: 'BAD_JSON' });
    expect(decode('{"t":"sub"}')).toMatchObject({ ok: false, code: 'BAD_FRAME' });
    expect(decode('{"t":"unknown"}')).toMatchObject({ ok: false, code: 'BAD_FRAME' });

    // API.md §6.7: 64 KiB for a client frame in general, 1 MiB for the subject-array frames — a
    // `sub` of 10 000 subjects × 100 fields (§6.4) does not fit in 64 KiB. The ceiling is applied
    // by the caller (`ws/session.ts`), which needs the parsed frame to answer a `sub` with `LIMIT`.
    expect(clientFrameLimit('ping')).toBe(MAX_CLIENT_FRAME_BYTES);
    expect(clientFrameLimit('hello')).toBe(MAX_CLIENT_FRAME_BYTES);
    for (const t of ['sub', 'unsub', 'resync'] as const) {
      expect(clientFrameLimit(t)).toBe(MAX_SUBJECT_FRAME_BYTES);
    }

    const huge = `{"t":"ping","n":1,"pad":"${'x'.repeat(MAX_CLIENT_FRAME_BYTES)}"}`;
    expect(decode(huge, MAX_CLIENT_FRAME_BYTES)).toMatchObject({
      ok: false,
      code: 'FRAME_TOO_LARGE',
    });
    // Under the hard bound it parses, and reports its size so the caller can judge it.
    expect(decode(huge)).toMatchObject({ ok: true, bytes: frameBytes(huge) });
    const past = `{"t":"sub","id":1,"subjects":[],"pad":"${'x'.repeat(MAX_CLIENT_FRAME_HARD_BYTES)}"}`;
    expect(decode(past)).toMatchObject({ ok: false, code: 'FRAME_TOO_LARGE' });
  });

  it('measures frames in UTF-8 bytes', () => {
    expect(frameBytes('abc')).toBe(3);
    expect(frameBytes('€')).toBe(3);
  });
});
