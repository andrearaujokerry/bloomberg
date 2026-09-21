/**
 * `data/rates.ts` — reference-rate fixings (WORKPLAN §WP-04 L706-709, FUNCTIONS.md §1.4.2 L302,
 * FUNCTIONS_TIER3 §0.1, PROVIDERS §10.4).
 *
 * `rate_fixings` is keyed `(rate_code, effective_date, vintage_at)`: the New York Fed republishes a
 * rate with `revisionIndicator` set, which opens a **new vintage** of the same effective date. Both
 * reads here therefore take one row per effective date — the newest vintage whose
 * `vintage_at ≤ knownAt` — so a past-dated read returns the number as it stood then and a revision
 * published later is invisible (DATA-10, STOR-06). `is_latest` is the "now" shortcut and is
 * deliberately **not** in the predicate: it would leak the revision into an earlier `knownAt`.
 *
 * `SOFRAI` (the SOFR averages/index release) has no `percentRate` and no percentiles: those columns
 * are `null` and stay `null`. Nothing here substitutes a zero — the screen prints `—`.
 *
 * Every row carries its `provenanceId` plus the provenance row's `capturedAt`/`sourceTs`, so the
 * runner can build `PayloadMeta.provenance[]` without a second query.
 */

import { sql } from 'drizzle-orm';

import type { Tx } from '../db/client.js';
import type { AsOf } from '../db/bitemporal.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shape (FUNCTIONS_TIER3 §0.1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One published fixing of one overnight rate. Percent, as the Fed publishes it. */
export interface RateFixing {
  rateCode: string;
  effectiveDate: string;
  vintageAt: string;
  rate: number | null;
  pct1: number | null;
  pct25: number | null;
  pct75: number | null;
  pct99: number | null;
  volumeBn: number | null;
  targetFrom: number | null;
  targetTo: number | null;
  avg30d: number | null;
  avg90d: number | null;
  avg180d: number | null;
  indexValue: number | null;
  revisionIndicator: string | null;
  isLatest: boolean;
  provenanceId: number;
  capturedAt: string;
  sourceTs: string | null;
}

/** Raised rather than returning a fabricated fixing. */
export class RateDataError extends Error {
  readonly code: 'not_found';
  readonly rateCode: string;
  constructor(code: 'not_found', rateCode: string, message: string) {
    super(message);
    this.name = 'RateDataError';
    this.code = code;
    this.rateCode = rateCode;
  }
}

/** The service as `DataServices.rates` declares it. */
export interface RatesService {
  latest(code: string): Promise<RateFixing>;
  history(code: string, days: number): Promise<RateFixing[]>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────────────────────

type FixingRow = {
  rate_code: string;
  effective_date: string;
  vintage_at: Date;
  rate: string | null;
  pct_1: string | null;
  pct_25: string | null;
  pct_75: string | null;
  pct_99: string | null;
  volume_bn: string | null;
  target_from: string | null;
  target_to: string | null;
  avg_30d: string | null;
  avg_90d: string | null;
  avg_180d: string | null;
  index_value: string | null;
  revision_indicator: string | null;
  is_latest: boolean;
  provenance_id: string;
  captured_at: Date;
  source_ts: Date | null;
};

function num(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function reqIso(value: Date | string, what: string): string {
  const s = iso(value);
  if (s === null) throw new TypeError(`data/rates: ${what} is null`);
  return s;
}

function toFixing(row: FixingRow): RateFixing {
  return {
    rateCode: row.rate_code,
    effectiveDate: row.effective_date,
    vintageAt: reqIso(row.vintage_at, 'vintage_at'),
    rate: num(row.rate),
    pct1: num(row.pct_1),
    pct25: num(row.pct_25),
    pct75: num(row.pct_75),
    pct99: num(row.pct_99),
    volumeBn: num(row.volume_bn),
    targetFrom: num(row.target_from),
    targetTo: num(row.target_to),
    avg30d: num(row.avg_30d),
    avg90d: num(row.avg_90d),
    avg180d: num(row.avg_180d),
    indexValue: num(row.index_value),
    revisionIndicator: row.revision_indicator,
    isLatest: row.is_latest,
    provenanceId: Number(row.provenance_id),
    capturedAt: reqIso(row.captured_at, 'captured_at'),
    sourceTs: iso(row.source_ts),
  };
}

const FIXING_COLUMNS = sql`
  f.rate_code, f.effective_date::text AS effective_date, f.vintage_at,
  f.rate::text AS rate, f.pct_1::text AS pct_1, f.pct_25::text AS pct_25,
  f.pct_75::text AS pct_75, f.pct_99::text AS pct_99, f.volume_bn::text AS volume_bn,
  f.target_from::text AS target_from, f.target_to::text AS target_to,
  f.avg_30d::text AS avg_30d, f.avg_90d::text AS avg_90d, f.avg_180d::text AS avg_180d,
  f.index_value::text AS index_value, f.revision_indicator, f.is_latest,
  f.provenance_id::text AS provenance_id, p.captured_at, p.source_ts`;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The newest fixing of `code` with `effective_date ≤ validAt` and `vintage_at ≤ knownAt`.
 *
 * @throws RateDataError `not_found` when the code has published nothing by then. A blank cell is
 *         the caller's decision (`ValueCell { v: null, r: 'NO_SOURCE' }`); this reader does not
 *         invent a row to stand in for one.
 */
export async function latestFixing(tx: Tx, at: AsOf, code: string): Promise<RateFixing> {
  const res = await tx.execute<FixingRow>(sql`
    SELECT ${FIXING_COLUMNS}
      FROM rate_fixings f
      JOIN provenance p ON p.provenance_id = f.provenance_id
     WHERE f.rate_code = ${code}
       AND f.effective_date <= ${at.validAt}::timestamptz::date
       AND f.vintage_at <= ${at.knownAt}::timestamptz
     ORDER BY f.effective_date DESC, f.vintage_at DESC
     LIMIT 1`);
  const row = res.rows[0];
  if (row === undefined) {
    throw new RateDataError(
      'not_found',
      code,
      `data/rates: '${code}' has no fixing on or before ${at.validAt.toISOString().slice(0, 10)} ` +
        `known at ${at.knownAt.toISOString()}`,
    );
  }
  return toFixing(row);
}

/**
 * The last `days` **effective dates** of `code`, newest first, one row per date (the newest vintage
 * known at `knownAt`).
 *
 * `days` counts published dates, not calendar days: the Fed publishes on business days, so
 * `history('SOFR', 2)` is "today's and yesterday's fixing", which is exactly what a 1-day change
 * needs.
 */
export async function fixingHistory(
  tx: Tx,
  at: AsOf,
  code: string,
  days: number,
): Promise<RateFixing[]> {
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(`data/rates: days must be a positive integer, got ${String(days)}`);
  }
  const res = await tx.execute<FixingRow>(sql`
    SELECT ${FIXING_COLUMNS}
      FROM (
        SELECT DISTINCT ON (rate_code, effective_date) *
          FROM rate_fixings
         WHERE rate_code = ${code}
           AND effective_date <= ${at.validAt}::timestamptz::date
           AND vintage_at <= ${at.knownAt}::timestamptz
         ORDER BY rate_code, effective_date DESC, vintage_at DESC
      ) f
      JOIN provenance p ON p.provenance_id = f.provenance_id
     ORDER BY f.effective_date DESC
     LIMIT ${days}`);
  return res.rows.map(toFixing);
}

/** `DataServices.rates`, bound to one transaction and one `(validAt, knownAt)` pair. */
export function ratesService(tx: Tx, at: AsOf): RatesService {
  return {
    latest: (code) => latestFixing(tx, at, code),
    history: (code, days) => fixingHistory(tx, at, code, days),
  };
}
