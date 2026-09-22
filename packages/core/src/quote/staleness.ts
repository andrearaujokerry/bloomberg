/**
 * Staleness (TERM-12) — ARCHITECTURE L557-566. **The single implementation.**
 *
 * The server's 1 s sweep (`plant/staleness.ts`) and the SDK's 1 s ticker both call `valueState`;
 * nothing re-implements the rule, so a cell and a `status` frame can never disagree.
 *
 * The verdict, in precedence order:
 *
 *   1. `blank`  — the field may not be shown: entitlement denied (`denied`), or nothing has ever
 *                 been captured for the subject (`ts.cap === 0`). Rendered as '—' + reason, never
 *                 a number (ENTL-05).
 *   2. `na`     — captured, but the field set carries no value for this instrument (a bid on an
 *                 index with no book). Callers pass `fields` already narrowed to the set in question.
 *   3. `closed` — session `closed` or `post`: the value is the official/last print and is not
 *                 expected to change, so it is not stale however old it is.
 *   4. `stale`  — the provider circuit is open (`circuitOpen`, or the `PROVIDER_DOWN` dq flag); or
 *                 no capture within the limit; or, during `open`, the source timestamp (advanced by
 *                 the line's intrinsic delay) has been frozen for longer than the limit.
 *   5. `live`.
 *
 * The limit is `stalenessLimitMs(expectedIntervalMs) = 3 × expectedIntervalMs`.
 *
 * **Boundary:** an age of exactly `3 × expectedIntervalMs` is still `live`; the value turns `stale`
 * strictly beyond it (`age > limit`). With the Cboe cadence of 10 000 ms a value captured 30 000 ms
 * ago is live and one captured 30 001 ms ago is stale. Both sides are pinned in
 * `test/quote/staleness.test.ts`.
 *
 * `delayMin` (the intrinsic delay of the winning line, minutes) shifts the frozen-source check by
 * the delay so a 15-minute-delayed feed is not stale by construction; it defaults to 0 when the
 * caller does not carry it (the SDK cache, for example).
 */

import type { DataQualityFlag, QuoteFields, QuoteState, ValueState } from '../types/quote.js';

/** Multiplier of `expectedIntervalMs` that bounds a live value's age. */
export const STALENESS_MULTIPLIER = 3;

/** The staleness limit for a line polled every `expectedIntervalMs`: `3 × expectedIntervalMs`. */
export function stalenessLimitMs(expectedIntervalMs: number): number {
  return STALENESS_MULTIPLIER * expectedIntervalMs;
}

/** What `valueState` needs: the composite's own members plus the two flags the caller may know. */
export type StalenessInput = Pick<QuoteState, 'ts' | 'session' | 'expectedIntervalMs' | 'fields'> &
  Partial<Pick<QuoteState, 'delayMin' | 'dq'>> & {
    /** The provider circuit breaker for the winning line is open. */
    circuitOpen?: boolean;
    /** Entitlement denied the field (set) — the value may not be shown. */
    denied?: boolean;
  };

function hasAnyValue(fields: QuoteFields): boolean {
  for (const key of Object.keys(fields) as (keyof QuoteFields)[]) {
    if (fields[key] !== undefined) return true;
  }
  return false;
}

function providerDown(dq: readonly DataQualityFlag[] | undefined): boolean {
  return dq?.includes('PROVIDER_DOWN') ?? false;
}

/** The staleness verdict for `q` at `nowMs`. Pure: every timestamp is an argument. */
export function valueState(q: StalenessInput, nowMs: number): ValueState {
  if (q.denied === true) return 'blank';
  if (q.ts.cap === 0) return 'blank';
  if (!hasAnyValue(q.fields)) return 'na';
  if (q.session === 'closed' || q.session === 'post') return 'closed';
  if (q.circuitOpen === true || providerDown(q.dq)) return 'stale';

  const limit = stalenessLimitMs(q.expectedIntervalMs);
  if (nowMs - q.ts.cap > limit) return 'stale';

  if (q.session === 'open' && q.ts.src !== null) {
    const delayMs = (q.delayMin ?? 0) * 60_000;
    if (nowMs - (q.ts.src + delayMs) > limit) return 'stale';
  }
  return 'live';
}

/** Milliseconds until a currently-live value would turn stale, or 0 when it already is not live. */
export function msUntilStale(q: StalenessInput, nowMs: number): number {
  if (valueState(q, nowMs) !== 'live') return 0;
  const limit = stalenessLimitMs(q.expectedIntervalMs);
  let deadline = q.ts.cap + limit;
  if (q.session === 'open' && q.ts.src !== null) {
    deadline = Math.min(deadline, q.ts.src + (q.delayMin ?? 0) * 60_000 + limit);
  }
  return Math.max(0, deadline - nowMs);
}
