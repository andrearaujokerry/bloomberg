/**
 * BUS-03 property test — TESTING.md §10 row 7, API.md §6.4 ("for any input sequence, the last
 * flushed value of every field equals the last applied value, and the `prev` chain is contiguous
 * per session").
 *
 * 500 seeded schedules, each a different interleaving of arrival times, field subsets, flush jitter
 * and injected `bufferedAmount` (so widen / skip / retain rungs fire mid-schedule). The generator is
 * `providers/sim/prng.ts#xoshiro128ss`, the same deterministic stream the WS integration tests use,
 * so a failure is reproducible from its seed alone — and the seed is printed.
 *
 * The three properties asserted per schedule:
 *  1. latest-value: for every subscribed field, the last value that reached the wire is the last
 *     value applied to the plant (nothing is lost, nothing is stale);
 *  2. prev chain: per subject, every `delta.prev` equals the `seq` of the previous frame that
 *     subject was sent — across batch frames, across flushes and across skipped flushes;
 *  3. field mask (BUS-02): no frame ever carries a field outside the subscription's set.
 */

import { describe, expect, it } from 'vitest';

import { VirtualClock, maskOf } from '@terminal/core';
import type { FieldId, QuoteState } from '@terminal/core';
import type { ServerMsg } from '@terminal/sdk/wire/ws';

import type { EodView } from '../../../src/plant/eod.js';
import { xoshiro128ss } from '../../../src/providers/sim/prng.js';
import { Conflator } from '../../../src/ws/conflator.js';
import type { PlantReader, Subscription } from '../../../src/ws/conflator.js';

const T0 = Date.parse('2026-09-15T13:30:00.000Z');

const POOL: readonly FieldId[] = ['PX_LAST', 'PX_BID', 'PX_ASK', 'PX_VOLUME', 'PX_HIGH', 'PX_LOW'];

/** subject → the fields that subject's session subscribed to. */
const SUBSCRIPTIONS: readonly { subject: string; instrumentId: number; fields: FieldId[] }[] = [
  { subject: 'q:1', instrumentId: 1, fields: [...POOL] },
  { subject: 'q:2', instrumentId: 2, fields: ['PX_LAST', 'PX_VOLUME'] },
  { subject: 'q:3', instrumentId: 3, fields: ['PX_BID', 'PX_ASK', 'PX_HIGH'] },
];

class MapPlant implements PlantReader {
  readonly states = new Map<string, QuoteState>();

  get(subject: string): QuoteState | undefined {
    return this.states.get(subject);
  }

  eodView(): EodView | null {
    return null;
  }

  seed(subject: string, instrumentId: number, atMs: number): void {
    this.states.set(subject, {
      subject,
      instrumentId,
      assetClass: 'equity',
      seq: 1,
      tier: 'delayed',
      delayMin: 15,
      fields: {
        PX_LAST: 100,
        PX_BID: 99.9,
        PX_ASK: 100.1,
        PX_VOLUME: 1_000,
        PX_HIGH: 101,
        PX_LOW: 99,
      },
      fieldTs: {},
      ts: { src: atMs, cap: atMs, pub: atMs },
      session: 'open',
      state: 'live',
      ageMs: 0,
      expectedIntervalMs: 15_000,
      prov: { sourceId: 'sim', provenanceId: 1 },
      lines: {},
      dq: [],
    });
  }

  apply(subject: string, patch: Record<string, number>, atMs: number): Uint32Array {
    const state = this.states.get(subject)!;
    for (const [id, value] of Object.entries(patch)) {
      (state.fields as Record<string, unknown>)[id] = value;
      (state.fieldTs as Record<string, number>)[id] = atMs;
    }
    state.seq += 1;
    state.ts = { src: atMs, cap: atMs, pub: atMs };
    return maskOf(Object.keys(patch));
  }
}

/** Runs one seeded schedule; returns `null` when all three properties hold, else the failure. */
function runSchedule(seed: number): string | null {
  const rng = xoshiro128ss(seed);
  const clock = new VirtualClock(T0);
  const plant = new MapPlant();
  const frames: ServerMsg[] = [];
  const buffered = { value: 0 };

  const conflator = new Conflator({
    plant,
    clock,
    requestedMs: 250,
    send: (frame) => frames.push(frame),
    bufferedAmount: () => buffered.value,
  });

  for (const spec of SUBSCRIPTIONS) {
    plant.seed(spec.subject, spec.instrumentId, T0);
    const sub: Subscription = {
      subject: spec.subject,
      fieldMask: maskOf(spec.fields),
      fieldIds: spec.fields,
      lastSentSeq: 0,
      tier: 'delayed',
      essential: true,
      denied: new Map(),
      reason: 'SOURCE_TIER_CAP',
      lastFlushMs: 0,
    };
    conflator.add(sub);
  }

  /** subject → field → last value applied to the plant. */
  const applied = new Map<string, Map<string, number>>(
    SUBSCRIPTIONS.map((s) => [s.subject, new Map<string, number>()]),
  );

  const events = 20 + Math.floor(rng() * 60);
  for (let i = 0; i < events; i += 1) {
    clock.advance(1 + Math.floor(rng() * 40));
    const spec = SUBSCRIPTIONS[Math.floor(rng() * SUBSCRIPTIONS.length)]!;
    const patch: Record<string, number> = {};
    for (const field of POOL) {
      if (rng() < 0.45) patch[field] = Number((50 + rng() * 100).toFixed(4));
    }
    if (Object.keys(patch).length === 0) patch.PX_LAST = Number((50 + rng() * 100).toFixed(4));
    const mask = plant.apply(spec.subject, patch, clock.now());
    for (const [field, value] of Object.entries(patch))
      applied.get(spec.subject)!.set(field, value);
    conflator.mark(spec.subject, mask);

    if (rng() < 0.35) {
      const roll = rng();
      buffered.value = roll < 0.7 ? 0 : roll < 0.85 ? 100_000 : roll < 0.95 ? 300_000 : 3_000_000;
      conflator.flush();
    }
  }

  // Drain: a healthy socket and enough flushes for every retained subject to go out.
  buffered.value = 0;
  conflator.flush();
  conflator.flush();

  // -- property 1 & 3: last flushed value, and nothing outside the mask -----
  const flushed = new Map<string, Map<string, unknown>>(
    SUBSCRIPTIONS.map((s) => [s.subject, new Map<string, unknown>()]),
  );
  const chain = new Map<string, number | null>(SUBSCRIPTIONS.map((s) => [s.subject, null]));

  for (const frame of frames) {
    if (frame.t !== 'batch') continue;
    for (const member of frame.m) {
      const spec = SUBSCRIPTIONS.find((s) => s.subject === member.s);
      if (spec === undefined) return `seed ${seed}: frame for an unknown subject ${member.s}`;
      if (member.t === 'status') continue;
      const typed = member;
      for (const key of Object.keys(typed.f)) {
        if (!spec.fields.includes(key)) {
          return `seed ${seed}: ${member.s} carried unsubscribed field ${key} (BUS-02)`;
        }
        flushed.get(member.s)!.set(key, typed.f[key]);
      }
      // -- property 2: the prev chain ---------------------------------------
      const previous = chain.get(member.s) ?? null;
      if (typed.t === 'delta') {
        if (previous === null) return `seed ${seed}: ${member.s} delta before its snap`;
        if (typed.prev !== previous) {
          return `seed ${seed}: ${member.s} prev ${typed.prev} != previous seq ${previous}`;
        }
        if (typed.seq <= typed.prev) {
          return `seed ${seed}: ${member.s} seq ${typed.seq} did not advance past ${typed.prev}`;
        }
      }
      chain.set(member.s, typed.seq);
    }
  }

  for (const spec of SUBSCRIPTIONS) {
    const state = plant.get(spec.subject)!;
    for (const field of spec.fields) {
      const last = (state.fields as Record<string, unknown>)[field];
      const sent = flushed.get(spec.subject)!.get(field);
      if (sent !== last) {
        return `seed ${seed}: ${spec.subject}.${field} flushed ${String(sent)} but the plant holds ${String(last)}`;
      }
    }
    const appliedFields = applied.get(spec.subject)!;
    for (const [field, value] of appliedFields) {
      if (!spec.fields.includes(field)) continue;
      if (flushed.get(spec.subject)!.get(field) !== value) {
        return `seed ${seed}: ${spec.subject}.${field} last applied ${value} never reached the wire`;
      }
    }
    // Everything that was marked has been delivered by the end of the drain.
    if (conflator.dirtySize() !== 0)
      return `seed ${seed}: ${conflator.dirtySize()} subjects still dirty`;
  }

  return null;
}

describe('conflator property test — 500 seeded schedules (BUS-03)', () => {
  it('keeps the latest-value guarantee and a contiguous prev chain for every schedule', () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 500; seed += 1) {
      const failure = runSchedule(seed);
      if (failure !== null) failures.push(failure);
    }
    expect(failures).toEqual([]);
  });

  it('is deterministic: the same seed produces the same verdict twice', () => {
    expect(runSchedule(42)).toBe(runSchedule(42));
    expect(runSchedule(42)).toBeNull();
  });
});
