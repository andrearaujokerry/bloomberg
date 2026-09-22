/**
 * The staleness sweep (TERM-12) — ARCHITECTURE §6.2 / §6.3, WORKPLAN WP-06.
 *
 * Every second the plant re-asks `core/quote/staleness.ts#valueState` for every subject it holds.
 * A subject whose verdict has not moved produces nothing; a subject that crossed
 * `3 × expectedIntervalMs` — or came back to life on a fresh capture, or closed with the session —
 * produces one {@link StalenessTransition}, and the gateway turns that into exactly one `status`
 * frame. **Only on transition**: a stale quote does not re-announce itself every second.
 *
 * The verdict is not recomputed here. `valueState` is the single implementation the SDK's own 1 s
 * ticker calls, so a cell and a `status` frame can never disagree; this module is only the loop
 * around it, plus the write-back of `state.state` / `state.ageMs` so that a snapshot served between
 * two updates tells the truth about age (a warm-started subject is `stale` until a poll lands, and
 * `plant/warm.ts` writes exactly that).
 *
 * **No timers.** `packages/core`'s `Clock` has none and `VirtualClock` has no timer queue, so the
 * sweep is a pull: the WS session (the one place a real timer is allowed) calls `sweep(now)` on its
 * own schedule, and a test calls it after advancing a virtual clock. {@link nextDueMs} says when
 * the earliest subject would change verdict, so a caller can schedule instead of poll.
 *
 * A transition never touches `seq`: it is not a new composite version, and a client that has seen
 * `seq` must not be forced into a resync because a value went stale.
 */

import { msUntilStale, valueState } from '@terminal/core';
import type { QuoteState, ValueState } from '@terminal/core';

/** ARCHITECTURE §6.6: the terminal re-evaluates staleness once a second. */
export const SWEEP_INTERVAL_MS = 1_000;

export interface StalenessTransition {
  subject: string;
  from: ValueState;
  to: ValueState;
  /** The instant the sweep ran. */
  at: number;
}

/** What the sweep reads — the plant, narrowed to two members (`Pick<Plant,'subjects'|'get'>`). */
export interface SweepSource {
  subjects(): Iterable<string>;
  get(subject: string): QuoteState | undefined;
}

export interface SweeperOptions {
  /**
   * Whether the provider circuit breaker of a subject's winning line is open (FEED-07); an open
   * circuit is `stale` however fresh the last capture was. Default: never open.
   */
  circuitOpen?: (subject: string, state: QuoteState) => boolean;
}

export interface StalenessSweeper {
  /** Re-evaluate every subject; returns one entry per subject whose verdict changed. */
  sweep(nowMs: number): StalenessTransition[];
  /**
   * Milliseconds until the earliest currently-live subject would turn stale, or
   * `Number.POSITIVE_INFINITY` when none can. A caller sleeps `min(nextDueMs, SWEEP_INTERVAL_MS)`.
   */
  nextDueMs(nowMs: number): number;
  /** Subjects visited by the last sweep. */
  size(): number;
}

/**
 * Build the sweeper over `source`.
 *
 * The previous verdict is `state.state` itself — the plant's own stored verdict, which `apply`
 * writes on every change — so there is no second copy to drift, and a sweep that runs after an
 * apply reports only what the apply did not already account for.
 */
export function stalenessSweeper(
  source: SweepSource,
  options: SweeperOptions = {},
): StalenessSweeper {
  let visited = 0;

  return {
    sweep(nowMs: number): StalenessTransition[] {
      const transitions: StalenessTransition[] = [];
      let count = 0;
      for (const subject of source.subjects()) {
        const state = source.get(subject);
        if (state === undefined) continue;
        count += 1;
        const circuitOpen = options.circuitOpen?.(subject, state) ?? false;
        const next = valueState(circuitOpen ? { ...state, circuitOpen } : state, nowMs);
        state.ageMs = Math.max(0, nowMs - state.ts.cap);
        if (next === state.state) continue;
        transitions.push({ subject, from: state.state, to: next, at: nowMs });
        state.state = next;
      }
      visited = count;
      return transitions;
    },

    nextDueMs(nowMs: number): number {
      let soonest = Number.POSITIVE_INFINITY;
      for (const subject of source.subjects()) {
        const state = source.get(subject);
        if (state === undefined) continue;
        const circuitOpen = options.circuitOpen?.(subject, state) ?? false;
        const input = circuitOpen ? { ...state, circuitOpen } : state;
        // A subject that is not live has no pending transition of its own: a fresh capture, not
        // the clock, is what moves it. A live one sitting exactly on the boundary (an age of
        // exactly the limit is still live) flips on the next millisecond.
        if (valueState(input, nowMs) !== 'live') continue;
        const due = Math.max(1, msUntilStale(input, nowMs));
        if (due < soonest) soonest = due;
      }
      return soonest;
    },

    size(): number {
      return visited;
    },
  };
}
