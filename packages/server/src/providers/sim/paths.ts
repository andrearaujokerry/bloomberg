/**
 * The price path of the simulated feed — PROVIDERS.a §4.3 steps 1-3 (L588-594).
 *
 * Pure arithmetic, separated from `feed.ts` so that the path can be tested, plotted and reasoned
 * about without a plant, a clock or a subject. Every function here is a total function of its
 * arguments: no clock, no randomness of its own (the `z`/`u` draws come from `prng.ts`), no state.
 *
 * §4.4's claim that two runs are bit-identical rests on this file doing its arithmetic in a fixed
 * operation order and never touching a locale.
 */

/** 6.5 h × 3600 s × 252 d — the trading seconds in a year, the clock the diffusion runs on. */
export const TRADING_SECONDS_PER_YEAR = 6.5 * 3600 * 252;

/** The year fraction of one tick at `rateHz` updates per second (§4.3 step 1). */
export function dtYears(rateHz: number): number {
  if (!Number.isFinite(rateHz) || rateHz <= 0) return 0;
  return 1 / (rateHz * TRADING_SECONDS_PER_YEAR);
}

/**
 * One geometric-Brownian-motion step: `px · exp((−σ²/2)·dt + σ·√dt·z)`.
 *
 * The `−σ²/2` drift is the Itô correction that makes the *price* a martingale rather than its
 * logarithm — without it a long simulated session drifts visibly upward and every mean-reversion
 * assertion written against the feed becomes a function of how long the test ran.
 */
export function stepPrice(px: number, annualVol: number, dt: number, z: number): number {
  if (!Number.isFinite(px) || px <= 0) return px;
  if (!Number.isFinite(annualVol) || !Number.isFinite(dt) || !Number.isFinite(z)) return px;
  const drift = -0.5 * annualVol * annualVol * dt;
  const diffusion = annualVol * Math.sqrt(dt) * z;
  const next = px * Math.exp(drift + diffusion);
  return Number.isFinite(next) && next > 0 ? next : px;
}

/** Decimal places implied by a tick size: `0.01` → 2, `0.0001` → 4, `1` → 0. */
function decimalsOfTick(tick: number): number {
  if (!Number.isFinite(tick) || tick <= 0) return 2;
  for (let d = 0; d <= 10; d += 1) {
    const scaled = tick * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return d;
  }
  return 10;
}

/**
 * Round `px` to the instrument's tick.
 *
 * The second rounding — to the tick's own decimal count — is not cosmetic: `Math.round(x / 0.01) *
 * 0.01` yields `123.45000000000001` for many inputs, and a golden file full of those is unreadable
 * and compares unequal to the obvious literal.
 */
export function roundToTick(px: number, tick: number): number {
  if (!Number.isFinite(px)) return px;
  if (!Number.isFinite(tick) || tick <= 0) return px;
  const snapped = Math.round(px / tick) * tick;
  const decimals = decimalsOfTick(tick);
  const scale = 10 ** decimals;
  return Math.round(snapped * scale) / scale;
}

/** A two-sided quote straddling `mid` by `spreadBp / 2` on each side, rounded to the tick. */
export function quoteAround(
  mid: number,
  spreadBp: number,
  tick: number,
): { bid: number; ask: number } {
  const half = (Number.isFinite(spreadBp) && spreadBp > 0 ? spreadBp : 0) / 2 / 10_000;
  const bid = roundToTick(mid * (1 - half), tick);
  const askRaw = roundToTick(mid * (1 + half), tick);
  // A tick-wide instrument can round both sides onto the same price; keep the book one tick wide
  // rather than publishing a locked or crossed quote the plant would have to reject.
  const ask = askRaw > bid ? askRaw : roundToTick(bid + tick, tick);
  return { bid, ask };
}

/**
 * An integer trade size: `avgTradeSize · (0.25 + 1.5 · u)` for a uniform `u` (§4.3 step 3), so
 * sizes run from a quarter of the average to 1.75 × it, never zero.
 */
export function tradeSize(avgTradeSize: number, u: number): number {
  if (!Number.isFinite(avgTradeSize) || avgTradeSize <= 0) return 1;
  const draw = Number.isFinite(u) ? u : 0;
  return Math.max(1, Math.round(avgTradeSize * (0.25 + 1.5 * draw)));
}

/** A quote size, drawn on the same scale as a trade but independently for each side. */
export function quoteSize(avgTradeSize: number, u: number): number {
  return tradeSize(avgTradeSize, u);
}
