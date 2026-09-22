/**
 * Derived quote fields — ARCHITECTURE §6.2 step 4, last bullet.
 *
 * `CHG_NET_1D`, `CHG_PCT_1D` and `TICK_DIR` are computed here from the composite and **never taken
 * from a provider**: Cboe's own `price_change` / `price_change_percent` / `tick` are cross-checks in
 * the fixture, not inputs. The recorded AAPL observation (330.27 vs a 333.08 previous close) must
 * reproduce Cboe's `-2.81` / `-0.8436` / `down`, and `test/quote/derive.test.ts` pins exactly that.
 *
 * Rounding: `CHG_PCT_1D` is a percentage rounded to 4 decimals (the precision the venue publishes
 * it at); `CHG_NET_1D` is rounded to 6 decimals, which removes binary-float noise
 * (330.27 − 333.08 is −2.8100000000000023 in IEEE-754) without touching any price tick size in use.
 *
 * Nothing is invented: with no `PX_LAST` there is no change; with no `PX_CLOSE_1D` (or a zero one,
 * which is not a price) there is no change either, rather than a change against zero. A tick
 * direction needs two consecutive prints: on the first observation `TICK_DIR` is absent, not
 * `'flat'` — `quote_ticks.tick_dir` is nullable for the same reason.
 */

import type { QuoteFields, TickDirection } from '../types/quote.js';

export type DerivedQuoteFields = Pick<QuoteFields, 'CHG_NET_1D' | 'CHG_PCT_1D' | 'TICK_DIR'>;

/** Every id `derive` may set. `merge.ts` strips these from provider lines so they are never sourced. */
export const DERIVED_QUOTE_FIELD_IDS = ['CHG_NET_1D', 'CHG_PCT_1D', 'TICK_DIR'] as const;

export const CHG_NET_DECIMALS = 6;
export const CHG_PCT_DECIMALS = 4;

function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  // `+ 0` normalises a `-0` produced by rounding a tiny negative to zero.
  return Math.round(value * f) / f + 0;
}

function isFinitePrice(v: number | undefined): v is number {
  return v !== undefined && Number.isFinite(v);
}

/** `PX_LAST − PX_CLOSE_1D`, or `undefined` when either is missing or the close is zero. */
export function netChange(fields: Pick<QuoteFields, 'PX_LAST' | 'PX_CLOSE_1D'>): number | undefined {
  const { PX_LAST, PX_CLOSE_1D } = fields;
  if (!isFinitePrice(PX_LAST) || !isFinitePrice(PX_CLOSE_1D) || PX_CLOSE_1D === 0) return undefined;
  return roundTo(PX_LAST - PX_CLOSE_1D, CHG_NET_DECIMALS);
}

/** `(PX_LAST − PX_CLOSE_1D) / PX_CLOSE_1D × 100`, rounded to 4 decimals; `undefined` as {@link netChange}. */
export function pctChange(fields: Pick<QuoteFields, 'PX_LAST' | 'PX_CLOSE_1D'>): number | undefined {
  const { PX_LAST, PX_CLOSE_1D } = fields;
  if (!isFinitePrice(PX_LAST) || !isFinitePrice(PX_CLOSE_1D) || PX_CLOSE_1D === 0) return undefined;
  return roundTo(((PX_LAST - PX_CLOSE_1D) / PX_CLOSE_1D) * 100, CHG_PCT_DECIMALS);
}

/**
 * Direction of `PX_LAST` against the previous composite's `PX_LAST`. `undefined` without a previous
 * print. Maps to `quote_ticks.tick_dir` as `u | d | f`.
 */
export function tickDirection(last: number | undefined, prevLast: number | undefined): TickDirection | undefined {
  if (!isFinitePrice(last) || !isFinitePrice(prevLast)) return undefined;
  if (last > prevLast) return 'up';
  if (last < prevLast) return 'down';
  return 'flat';
}

/** `quote_ticks.tick_dir` encoding of a {@link TickDirection}. */
export function tickDirCode(dir: TickDirection): 'u' | 'd' | 'f' {
  return dir === 'up' ? 'u' : dir === 'down' ? 'd' : 'f';
}

/**
 * The derived block for a composite. `prev` is the previous composite's fields (for `TICK_DIR`);
 * omit it on the first observation. Keys whose value cannot be derived are absent, not `undefined`,
 * so the result can be spread into `QuoteFields` without introducing phantom keys.
 */
export function derive(fields: QuoteFields, prev?: QuoteFields): DerivedQuoteFields {
  const out: DerivedQuoteFields = {};
  const net = netChange(fields);
  if (net !== undefined) out.CHG_NET_1D = net;
  const pct = pctChange(fields);
  if (pct !== undefined) out.CHG_PCT_1D = pct;
  const dir = tickDirection(fields.PX_LAST, prev?.PX_LAST);
  if (dir !== undefined) out.TICK_DIR = dir;
  return out;
}
