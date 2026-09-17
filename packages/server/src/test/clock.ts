/**
 * Test clock — ARCHITECTURE §3.3 L352-353, TESTING.md §1 L20.
 *
 * There is exactly one clock abstraction in the system (`@terminal/core`'s `Clock`), and tests
 * drive `VirtualClock`. Nothing in a test may call `Date.now()`: a replayed plant session must
 * produce byte-identical output on every run, and a golden analytics dataset must not move because
 * the suite ran at a different second.
 *
 * `TEST_NOW` is the fixed instant the fixtures were captured around (the replay store's capture
 * window, DATA_MODEL §16 partitions cover 2026-09), so a virtual clock started here lands inside
 * every seeded partition and every fixture's validity window.
 */

import { VirtualClock, type Clock } from '@terminal/core';

export { VirtualClock } from '@terminal/core';
export type { Clock } from '@terminal/core';

/** 2026-09-17T13:30:00Z — a US cash-session instant inside the seeded partition window. */
export const TEST_NOW_ISO = '2026-09-17T13:30:00.000Z';

/** `TEST_NOW_ISO` in epoch milliseconds. */
export const TEST_NOW = Date.parse(TEST_NOW_ISO);

/**
 * A `VirtualClock` frozen at `TEST_NOW` (or at `start`, which may be an ISO string or epoch ms).
 * Advance it explicitly with `clock.advance(ms)`; it never moves on its own.
 */
export function testClock(start: number | string = TEST_NOW): VirtualClock {
  const epochMs = typeof start === 'string' ? Date.parse(start) : start;
  if (Number.isNaN(epochMs))
    throw new RangeError(`testClock: unparseable instant ${String(start)}`);
  return new VirtualClock(epochMs);
}

/** A `Clock` that always reports `at` — for a single assertion that needs a literal instant. */
export function frozenClock(at: number | string = TEST_NOW): Clock {
  const epochMs = typeof at === 'string' ? Date.parse(at) : at;
  if (Number.isNaN(epochMs)) throw new RangeError(`frozenClock: unparseable instant ${String(at)}`);
  return { now: () => epochMs };
}

/** Advance `clock` by a whole number of seconds — the unit most plant assertions are written in. */
export function advanceSeconds(clock: VirtualClock, seconds: number): void {
  clock.advance(Math.round(seconds * 1_000));
}
