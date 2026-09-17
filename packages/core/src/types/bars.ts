/**
 * Bars and price adjustment (REF-09, DATA_MODEL §20, ARCHITECTURE §4.3).
 *
 * Stored bars are ALWAYS unadjusted; `AdjustPolicy` is applied on read by
 * `server/src/data/historical.ts` using the factors from `core/adjust/corporateActions.ts`.
 */

/** `'1d'` appears in `bars_intraday.bar_interval` only as a resample cache key. */
export type BarInterval = '1m' | '5m' | '1d';

/** REF-09; the only three. */
export type AdjustPolicy = 'unadjusted' | 'price' | 'total_return';

/** Resampling periodicity for historical series (HP/GP/`/history`). */
export type Periodicity = 'D' | 'W' | 'M' | 'Q' | 'Y';

export type BarSession = 'pre' | 'regular' | 'post';

/**
 * One OHLCV bar.
 *
 * `date` is the bar START: `YYYY-MM-DD` for daily bars (`bars_daily.session_date`), an ISO-8601 UTC
 * instant for `1m`/`5m` bars (`bars_intraday.bar_ts`). Prices are in the instrument's quote
 * currency at full stored precision; `volume` is null where the source publishes none (indices, FX).
 */
export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  vwap?: number | null;
  tradeCount?: number | null;
  /** exchange official close when the source states it; daily bars only */
  officialClose?: number | null;
  /** intraday only */
  session?: BarSession;
  /** intraday only: the last bar of a poll is provisional until a later poll passes it (b1m: IS_FINAL) */
  isFinal?: boolean;
}
