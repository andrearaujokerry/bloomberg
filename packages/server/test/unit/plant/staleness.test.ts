/**
 * TERM-12 — `plant/staleness.ts`, the 1 s sweep (ARCHITECTURE §6.2/§6.6, WORKPLAN WP-06).
 *
 * The sweep exists so the gateway emits a `status` frame **only on transition**: a quote that went
 * stale says so once, not once a second. The verdict itself is `core/quote/staleness.ts#valueState`
 * — the single implementation — so this file pins the loop around it, including the boundary the
 * core module documents: an age of exactly `3 × expectedIntervalMs` is still `live`, and the value
 * turns `stale` strictly beyond it.
 */

import { describe, expect, it } from 'vitest';

import { stalenessLimitMs } from '@terminal/core';
import type { QuoteState } from '@terminal/core';

import { SWEEP_INTERVAL_MS, stalenessSweeper } from '../../../src/plant/staleness.js';
import { TEST_NOW } from '../../../src/test/clock.js';

const EXPECTED_INTERVAL_MS = 10_000;
const LIMIT = stalenessLimitMs(EXPECTED_INTERVAL_MS);

function liveState(overrides: Partial<QuoteState> = {}): QuoteState {
  return {
    subject: 'q:101',
    instrumentId: 101,
    assetClass: 'equity',
    seq: 4,
    tier: 'delayed',
    delayMin: 0,
    fields: { PX_LAST: 330.27 },
    fieldTs: { PX_LAST: TEST_NOW },
    ts: { src: TEST_NOW, cap: TEST_NOW, pub: TEST_NOW },
    session: 'open',
    state: 'live',
    ageMs: 0,
    expectedIntervalMs: EXPECTED_INTERVAL_MS,
    prov: { sourceId: 'cboe.quotes', provenanceId: 900_101, srcSeq: 1 },
    lines: {},
    dq: [],
    ...overrides,
  };
}

/** A sweep source over a literal map of states. */
function sourceOf(states: Map<string, QuoteState>): {
  subjects(): Iterable<string>;
  get(subject: string): QuoteState | undefined;
} {
  return { subjects: () => states.keys(), get: (subject) => states.get(subject) };
}

describe('plant/staleness.ts — the sweep', () => {
  it('reports the live → stale transition exactly once, at the limit', () => {
    const states = new Map([['q:101', liveState()]]);
    const sweeper = stalenessSweeper(sourceOf(states));

    // Inside the limit, and exactly on it: still live, nothing to say.
    expect(sweeper.sweep(TEST_NOW + LIMIT - 1)).toEqual([]);
    expect(sweeper.sweep(TEST_NOW + LIMIT)).toEqual([]);
    expect(states.get('q:101')?.state).toBe('live');

    // One millisecond beyond: exactly one transition.
    const crossed = sweeper.sweep(TEST_NOW + LIMIT + 1);
    expect(crossed).toEqual([
      { subject: 'q:101', from: 'live', to: 'stale', at: TEST_NOW + LIMIT + 1 },
    ]);
    expect(states.get('q:101')?.state).toBe('stale');

    // And never again while it stays stale.
    expect(sweeper.sweep(TEST_NOW + LIMIT + 2)).toEqual([]);
    expect(sweeper.sweep(TEST_NOW + LIMIT + 60_000)).toEqual([]);
  });

  it('writes the age back so a snapshot served between updates tells the truth', () => {
    const states = new Map([['q:101', liveState()]]);
    const sweeper = stalenessSweeper(sourceOf(states));
    sweeper.sweep(TEST_NOW + 12_000);
    expect(states.get('q:101')?.ageMs).toBe(12_000);
    expect(sweeper.size()).toBe(1);
  });

  it('reports the way back: a fresh capture turns a stale subject live again', () => {
    const state = liveState();
    const states = new Map([['q:101', state]]);
    const sweeper = stalenessSweeper(sourceOf(states));

    expect(sweeper.sweep(TEST_NOW + LIMIT + 1)).toHaveLength(1);
    // The poll lands: `apply` would move `cap` and `src` forward.
    const recovered = TEST_NOW + LIMIT + 5_000;
    state.ts = { src: recovered, cap: recovered, pub: recovered };
    const back = sweeper.sweep(recovered);
    expect(back).toEqual([{ subject: 'q:101', from: 'stale', to: 'live', at: recovered }]);
    expect(sweeper.sweep(recovered + 1)).toEqual([]);
  });

  it('a closed session is never stale, however old the print is', () => {
    const states = new Map([['q:101', liveState({ session: 'closed', state: 'closed' })]]);
    const sweeper = stalenessSweeper(sourceOf(states));
    expect(sweeper.sweep(TEST_NOW + 86_400_000)).toEqual([]);
    expect(states.get('q:101')?.state).toBe('closed');
  });

  it('an open provider circuit is stale whatever the capture says', () => {
    const states = new Map([['q:101', liveState()]]);
    let open = false;
    const sweeper = stalenessSweeper(sourceOf(states), { circuitOpen: () => open });
    expect(sweeper.sweep(TEST_NOW + 1_000)).toEqual([]);
    open = true;
    expect(sweeper.sweep(TEST_NOW + 2_000)).toEqual([
      { subject: 'q:101', from: 'live', to: 'stale', at: TEST_NOW + 2_000 },
    ]);
  });

  it('sweeps every subject and reports each transition once', () => {
    const states = new Map([
      ['q:101', liveState()],
      ['q:202', liveState({ subject: 'q:202', instrumentId: 202, expectedIntervalMs: 60_000 })],
    ]);
    const sweeper = stalenessSweeper(sourceOf(states));
    // q:101's limit is 30 s, q:202's is 180 s.
    expect(sweeper.sweep(TEST_NOW + 31_000).map((t) => t.subject)).toEqual(['q:101']);
    expect(sweeper.sweep(TEST_NOW + 181_000).map((t) => t.subject)).toEqual(['q:202']);
    expect(sweeper.sweep(TEST_NOW + 200_000)).toEqual([]);
  });

  it('nextDueMs says when the earliest subject would turn, so the caller can schedule', () => {
    const states = new Map([
      ['q:101', liveState()],
      ['q:202', liveState({ subject: 'q:202', instrumentId: 202, expectedIntervalMs: 60_000 })],
    ]);
    const sweeper = stalenessSweeper(sourceOf(states));
    expect(sweeper.nextDueMs(TEST_NOW)).toBe(LIMIT);
    expect(sweeper.nextDueMs(TEST_NOW + LIMIT)).toBe(1);
    // Past every limit nothing is live any more, so nothing is pending.
    expect(sweeper.nextDueMs(TEST_NOW + 1_000_000)).toBe(Number.POSITIVE_INFINITY);
    expect(SWEEP_INTERVAL_MS).toBe(1_000);
  });

  it('a subject with no captured value is blank, not stale', () => {
    const states = new Map([
      ['q:101', liveState({ ts: { src: null, cap: 0, pub: 0 }, state: 'live', fields: {} })],
    ]);
    const sweeper = stalenessSweeper(sourceOf(states));
    expect(sweeper.sweep(TEST_NOW)).toEqual([
      { subject: 'q:101', from: 'live', to: 'blank', at: TEST_NOW },
    ]);
  });
});
