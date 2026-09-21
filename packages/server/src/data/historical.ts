/**
 * `data/historical.ts` — daily history with the adjustment policy applied **on read**
 * (FUNCTIONS.md §1.4.2 `DataServices.historical`, REF-09, DATA_MODEL §6.1, API.md §4 rule 3).
 *
 * `bars_daily` is always unadjusted (ARCHITECTURE §4.3): the stored row is what the exchange
 * printed that session, forever. `unadjusted`, `price` and `total_return` are three different
 * readings of those same rows, and the steps used are echoed in `meta.adjustments` so a screen can
 * say *why* a 2020 close is 124.81 rather than 499.23.
 *
 * ## The lead-in session
 *
 * The read loads one session **before** `start`. Two things need it and neither can be recovered
 * afterwards:
 *
 *  1. the cash-dividend factor is `1 − amount / closeBeforeEx`, where `closeBeforeEx` is the
 *     unadjusted close of the last session *strictly before* the ex-date (CRSP / Yahoo
 *     convention). When the first action in the window is a dividend going ex on the window's
 *     first session, that close lies outside the window — `refdata/corporateActions.ts#loadCloses`
 *     loads it for the factor computation for exactly this reason;
 *  2. `TOT_RETURN_INDEX` is a chain, `TR_t = TR_{t−1} × (P_t + D_t) / P_{t−1}`. Without the prior
 *     session the first link is missing and a dividend going ex on the first row is silently lost.
 *
 * The extra row is dropped before the block is returned, so a caller always gets exactly the
 * window it asked for.
 *
 * ## Provenance (DATA-10)
 *
 * Every session in the block carries the `provenance_id` of the `bars_daily` row that supplied it,
 * and every corporate action that moved a price carries its own. `provIdx` is the distinct set of
 * `meta.provenance` indexes the block cites; `rowProvIdx[i]` is the index for `index[i]`.
 */

import { cumulativeFactors, totalReturnIndex } from '@terminal/core/adjust/corporateActions';
import { sql } from 'drizzle-orm';

import {
  actionsAsOf,
  isAdjusting,
  loadAdjustment,
  toCaForAdjust,
} from '../refdata/corporateActions.js';
import {
  citeProvenance,
  citedIndex,
  fxMultipliers,
  instrumentCurrency,
  utcDate,
} from './reference.js';

import type { CaForAdjust, FactorStep } from '@terminal/core/adjust/corporateActions';
import type { AdjustPolicy, Bar, FieldId, PayloadAdjustment, Periodicity } from '@terminal/core';
import type { AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';
import type { CorporateActionRecord } from '../refdata/corporateActions.js';
import type { DataDeps, ProvenanceCitation, ProvenanceSink } from './reference.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * API.md §4 L334 `SeriesBlock`: column-major-friendly, one block per security.
 *
 * `rows[i][j]` is the value of `columns[j]` at `index[i]`; `null` is "no value for this session",
 * never zero. `index` is `YYYY-MM-DD` for daily history and an ISO-8601 UTC instant for intraday.
 */
export interface SeriesBlock extends ProvenanceCitation {
  columns: FieldId[];
  index: string[];
  rows: (number | null)[][];
  /** Echoed, never inferred: the policy the caller asked for. */
  adjust?: AdjustPolicy;
  /** ISO-4217 of the values in `rows` — the instrument's quote currency unless converted. */
  currency: string;
  /** `meta.provenance` index of the row that supplied `index[i]`. */
  rowProvIdx: number[];
  /** `provenance_id` of the row that supplied `index[i]` (DATA-10). */
  rowProvenanceIds: number[];
}

/** `DataServices.historical.bars`'s query (FUNCTIONS.md L292). */
export interface HistoryQuery {
  /** `YYYY-MM-DD`, inclusive. */
  start: string;
  /** `YYYY-MM-DD`, inclusive; default the as-of date. */
  end?: string;
  periodicity: Periodicity;
  adjust: AdjustPolicy;
  /** ISO-4217; converts through `fx_rates` when it differs from the quote currency (CHRT-03). */
  currency?: string;
  /** Default `PX_OPEN, PX_HIGH, PX_LOW, PX_LAST, PX_VOLUME`. */
  fields?: FieldId[];
}

/** What `bars()` returns: a `SeriesBlock` plus the steps `meta.adjustments` reports. */
export type HistorySeries = SeriesBlock & { adjustments: PayloadAdjustment[] };

/** The bar fields this service can serve (API.md §4 rule 3). */
export const HISTORY_FIELDS: readonly FieldId[] = Object.freeze([
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_LAST',
  'PX_VOLUME',
  'VWAP',
  'PX_OFFICIAL_CLOSE',
  'TOT_RETURN_INDEX',
]);

/** What HP, GP and `/history` ask for when the caller names no fields. */
export const DEFAULT_HISTORY_FIELDS: readonly FieldId[] = Object.freeze([
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_LAST',
  'PX_VOLUME',
]);

/** One unadjusted `bars_daily` row, at full stored precision. */
export interface DailyBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  vwap: number | null;
  tradeCount: number | null;
  officialClose: number | null;
  provenanceId: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, what: string): string {
  if (!DATE_RE.test(value)) {
    throw new RangeError(`historical: ${what} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  return value;
}

function num(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Unadjusted daily bars over `[start, end]` **plus the last session strictly before `start`** when
 * one exists, ascending.
 *
 * One query: the lead-in bound is a scalar subquery rather than a second round trip, because the
 * database is the only thing that knows which session was last across a holiday.
 */
export async function loadDailyBars(
  tx: Tx,
  instrumentId: number,
  start: string,
  end: string,
): Promise<DailyBar[]> {
  assertDate(start, 'start');
  assertDate(end, 'end');
  const res = await tx.execute<{
    session_date: string;
    open: string | null;
    high: string | null;
    low: string | null;
    close: string;
    volume: string | null;
    vwap: string | null;
    trade_count: number | null;
    official_close: string | null;
    provenance_id: string;
  }>(sql`
      SELECT session_date::text AS session_date, open::text, high::text, low::text, close::text,
             volume::text, vwap::text, trade_count, official_close::text,
             provenance_id::text AS provenance_id
        FROM bars_daily
       WHERE instrument_id = ${instrumentId}
         AND session_date <= ${end}::date
         AND session_date >= COALESCE(
               (SELECT max(session_date) FROM bars_daily
                 WHERE instrument_id = ${instrumentId} AND session_date < ${start}::date),
               ${start}::date)
       ORDER BY session_date`);

  return res.rows.map((row) => ({
    date: row.session_date,
    open: num(row.open),
    high: num(row.high),
    low: num(row.low),
    close: Number(row.close),
    volume: num(row.volume),
    vwap: num(row.vwap),
    tradeCount: row.trade_count === null ? null : Number(row.trade_count),
    officialClose: num(row.official_close),
    provenanceId: Number(row.provenance_id),
  }));
}

/** ISO-8601 week key (`2020-W36`) — Thursday decides the year, as ISO-8601 says. */
function isoWeekKey(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((d.getTime() - jan1) / 86_400_000 / 7) + 1;
  return `${String(year)}-W${String(week).padStart(2, '0')}`;
}

/** The resampling bucket a session falls in. */
function bucketKey(date: string, periodicity: Periodicity): string {
  switch (periodicity) {
    case 'D':
      return date;
    case 'W':
      return isoWeekKey(date);
    case 'M':
      return date.slice(0, 7);
    case 'Q': {
      const month = Number(date.slice(5, 7));
      return `${date.slice(0, 4)}-Q${String(Math.floor((month - 1) / 3) + 1)}`;
    }
    case 'Y':
      return date.slice(0, 4);
  }
}

/** A session with its policy-adjusted values and, when asked for, its total-return level. */
interface AdjustedBar extends DailyBar {
  totalReturn: number | null;
}

/**
 * Aggregate daily bars into one periodicity bucket: first open, highest high, lowest low, last
 * close, summed volume. The bucket is labelled with its **last session's date**, which is what a
 * weekly or monthly history prints.
 */
function aggregate(bars: readonly AdjustedBar[]): AdjustedBar {
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (first === undefined || last === undefined) {
    throw new RangeError('historical: cannot aggregate an empty bucket');
  }

  let high: number | null = null;
  let low: number | null = null;
  let volume: number | null = null;
  let tradeCount: number | null = null;
  let turnover = 0;
  let vwapVolume = 0;
  let vwapComplete = true;

  for (const bar of bars) {
    if (bar.high !== null) high = high === null ? bar.high : Math.max(high, bar.high);
    if (bar.low !== null) low = low === null ? bar.low : Math.min(low, bar.low);
    if (bar.volume !== null) volume = (volume ?? 0) + bar.volume;
    if (bar.tradeCount !== null) tradeCount = (tradeCount ?? 0) + bar.tradeCount;
    if (bar.vwap !== null && bar.volume !== null) {
      turnover += bar.vwap * bar.volume;
      vwapVolume += bar.volume;
    } else {
      vwapComplete = false;
    }
  }

  return {
    date: last.date,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
    vwap: vwapComplete && vwapVolume > 0 ? turnover / vwapVolume : null,
    tradeCount,
    officialClose: last.officialClose,
    totalReturn: last.totalReturn,
    // The bucket is cited by the row that closed it; every contributing row is still registered
    // with the collector, so `provIdx` lists them all.
    provenanceId: last.provenanceId,
  };
}

/** `Bar[]` for `totalReturnIndex`, which reads `date` and `close` only. */
function asBars(rows: readonly DailyBar[]): Bar[] {
  return rows.map((row) => ({
    date: row.date,
    // `Bar` declares OHL as numbers; the total-return chain reads neither, and a session with no
    // published open is not an invitation to invent one, so the close stands in.
    open: row.open ?? row.close,
    high: row.high ?? row.close,
    low: row.low ?? row.close,
    close: row.close,
    volume: row.volume,
  }));
}

/** The value of one field on one adjusted bar. */
function valueOf(bar: AdjustedBar, field: FieldId): number | null {
  switch (field) {
    case 'PX_OPEN':
      return bar.open;
    case 'PX_HIGH':
      return bar.high;
    case 'PX_LOW':
      return bar.low;
    case 'PX_LAST':
      return bar.close;
    case 'PX_VOLUME':
      return bar.volume;
    case 'VWAP':
      return bar.vwap;
    case 'PX_OFFICIAL_CLOSE':
      return bar.officialClose;
    case 'TOT_RETURN_INDEX':
      return bar.totalReturn;
    default:
      throw new RangeError(
        `historical: field ${field} is not a bar field; supported: ${HISTORY_FIELDS.join(', ')}`,
      );
  }
}

/** Fields whose values are prices and therefore move with an FX conversion. */
const PRICE_FIELDS: ReadonlySet<FieldId> = new Set<FieldId>([
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_LAST',
  'VWAP',
  'PX_OFFICIAL_CLOSE',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `DataServices.historical` (FUNCTIONS.md §1.4.2 L292). */
export class HistoricalService {
  readonly #tx: Tx;
  readonly #at: AsOf;
  readonly #prov: ProvenanceSink;

  constructor(deps: DataDeps) {
    this.#tx = deps.tx;
    this.#at = deps.asOf;
    this.#prov = deps.prov;
  }

  /**
   * The daily history of one instrument under one adjustment policy.
   *
   * The three policies differ exactly as REF-09 says: `unadjusted` returns the stored prints;
   * `price` applies ratio actions (splits, reverse splits, stock dividends, rights) so a 4:1 split
   * scales every earlier price by 0.25 and every earlier volume by 4; `total_return` applies those
   * *and* the cash actions, each as `1 − amount / closeBeforeEx`.
   *
   * @throws DataNotFoundError when the instrument has no version at `(validAt, knownAt)`.
   * @throws RangeError on a malformed date or an unsupported field.
   */
  async bars(id: number, q: HistoryQuery): Promise<HistorySeries> {
    const start = assertDate(q.start, 'start');
    const end = assertDate(q.end ?? utcDate(this.#at.validAt), 'end');
    if (end < start) {
      throw new RangeError(`historical: end ${end} is before start ${start}`);
    }
    const fields = [...(q.fields ?? DEFAULT_HISTORY_FIELDS)];
    for (const field of fields) {
      if (!HISTORY_FIELDS.includes(field)) {
        throw new RangeError(
          `historical: field ${field} is not a bar field; supported: ${HISTORY_FIELDS.join(', ')}`,
        );
      }
    }

    const quoteCurrency = await instrumentCurrency(this.#tx, id, this.#at);
    const target = q.currency ?? quoteCurrency;

    // `[start − 1 session, end]`: the lead-in is what the first cash factor and the first
    // total-return link need, and it is dropped again below.
    const loaded = await loadDailyBars(this.#tx, id, start, end);
    const adjustment = await loadAdjustment(this.#tx, {
      instrumentId: id,
      start,
      end,
      policy: q.adjust,
      asOf: this.#at,
    });

    // The total-return chain carries the cash actions itself, so it needs them even under
    // `unadjusted` (where `loadAdjustment` correctly returns none) and it needs the ones going ex
    // on the first session of the window (which the factor read excludes as inert). Asked for
    // only when the column is.
    const trActions = fields.includes('TOT_RETURN_INDEX')
      ? (
          await actionsAsOf(
            this.#tx,
            { instrumentId: id, from: loaded[0]?.date ?? start, to: end },
            this.#at,
          )
        ).filter(isAdjusting)
      : [];

    const adjusted = this.#applyPolicy(loaded, adjustment.steps, trActions, fields);
    const window = adjusted.filter((bar) => bar.date >= start && bar.date <= end);

    const fx =
      target === quoteCurrency
        ? null
        : await this.#loadFx(quoteCurrency, target, start, end, window);

    const buckets = this.#resample(window, q.periodicity);

    // Only the actions that actually produced a step are cited: under `price` a cash dividend is
    // read and then does nothing, and `meta.provenance[]` must not carry a source no value on the
    // screen points at.
    const stepDates = new Set(adjustment.steps.map((step) => step.beforeDate));
    const citedProvenance = [
      ...loaded.filter((b) => b.date >= start).map((b) => b.provenanceId),
      ...adjustment.applied
        .filter((action) => stepDates.has(action.exDate))
        .map((action) => action.provenanceId),
      ...(fx === null ? [] : fx.provenanceIds),
    ];
    // A completed session's close never changes again; that is `'closed'`, not `'stale'`.
    const citation = await citeProvenance(this.#tx, this.#prov, citedProvenance, {
      st: 'closed',
    });

    const index: string[] = [];
    const rows: (number | null)[][] = [];
    const rowProvIdx: number[] = [];
    const rowProvenanceIds: number[] = [];

    for (const bar of buckets) {
      const rate = fx === null ? 1 : fx.rateOn(bar.date);
      if (rate === undefined) continue; // no published rate on or before this session
      index.push(bar.date);
      rows.push(
        fields.map((field) => {
          const value = valueOf(bar, field);
          if (value === null) return null;
          return rate !== 1 && PRICE_FIELDS.has(field) ? value * rate : value;
        }),
      );
      rowProvenanceIds.push(bar.provenanceId);
      rowProvIdx.push(citedIndex(citation.provIdxOf, bar.provenanceId));
    }

    const adjustments: PayloadAdjustment[] = adjustment.steps.map((step) => ({
      beforeDate: step.beforeDate,
      priceFactor: step.priceFactor,
      volumeFactor: step.volumeFactor,
      kind: step.kind,
    }));

    return {
      columns: fields,
      index,
      rows,
      adjust: q.adjust,
      currency: target,
      rowProvIdx,
      rowProvenanceIds,
      adjustments,
      ...citation,
    };
  }

  /**
   * Apply the cumulative factors to every loaded session and, when `TOT_RETURN_INDEX` is asked
   * for, chain the total-return level off the **unadjusted** closes (the chain carries the splits
   * itself, so applying them twice would compound them).
   */
  #applyPolicy(
    loaded: readonly DailyBar[],
    steps: readonly FactorStep[],
    trActions: readonly CorporateActionRecord[],
    fields: readonly FieldId[],
  ): AdjustedBar[] {
    const wantsTr = fields.includes('TOT_RETURN_INDEX');
    let trByDate: Map<string, number> | null = null;
    if (wantsTr) {
      const actions: CaForAdjust[] = trActions.map(toCaForAdjust);
      trByDate = new Map(
        totalReturnIndex(asBars(loaded), actions).map((point) => [point.date, point.value]),
      );
    }

    const factors = cumulativeFactors(
      loaded.map((bar) => bar.date),
      steps,
    );

    return loaded.map((bar, i) => {
      const factor = factors[i];
      const price = factor?.priceFactor ?? 1;
      const volume = factor?.volumeFactor ?? 1;
      return {
        date: bar.date,
        open: bar.open === null ? null : bar.open * price,
        high: bar.high === null ? null : bar.high * price,
        low: bar.low === null ? null : bar.low * price,
        close: bar.close * price,
        volume: bar.volume === null ? null : bar.volume * volume,
        vwap: bar.vwap === null ? null : bar.vwap * price,
        tradeCount: bar.tradeCount,
        officialClose: bar.officialClose === null ? null : bar.officialClose * price,
        totalReturn: trByDate?.get(bar.date) ?? null,
        provenanceId: bar.provenanceId,
      };
    });
  }

  /** Group adjusted sessions into `periodicity` buckets; `'D'` is the identity. */
  #resample(bars: readonly AdjustedBar[], periodicity: Periodicity): AdjustedBar[] {
    if (periodicity === 'D' || bars.length === 0) return [...bars];
    const out: AdjustedBar[] = [];
    let key: string | undefined;
    let bucket: AdjustedBar[] = [];
    for (const bar of bars) {
      const k = bucketKey(bar.date, periodicity);
      if (key !== undefined && k !== key) {
        out.push(aggregate(bucket));
        bucket = [];
      }
      key = k;
      bucket.push(bar);
    }
    if (bucket.length > 0) out.push(aggregate(bucket));
    return out;
  }

  /**
   * ECB reference rates for the window, with forward fill: the rate in force on a session with no
   * published rate (a holiday on the ECB's calendar, not on the exchange's) is the last published
   * one. A session before the first published rate gets no row at all rather than a wrong price.
   */
  async #loadFx(
    from: string,
    to: string,
    start: string,
    end: string,
    window: readonly AdjustedBar[],
  ): Promise<{ rateOn(date: string): number | undefined; provenanceIds: number[] }> {
    // 30 days of lead-in: enough to carry a rate across any ECB closure.
    const lead = new Date(`${start}T00:00:00.000Z`);
    lead.setUTCDate(lead.getUTCDate() - 30);
    const rates = await fxMultipliers(this.#tx, from, to, utcDate(lead), end);
    const dates = [...rates.keys()].sort();

    const resolved = new Map<string, { rate: number; provenanceId: number }>();
    for (const bar of window) {
      const exact = rates.get(bar.date);
      if (exact !== undefined) {
        resolved.set(bar.date, exact);
        continue;
      }
      let carried: { rate: number; provenanceId: number } | undefined;
      for (const date of dates) {
        if (date > bar.date) break;
        carried = rates.get(date);
      }
      if (carried !== undefined) resolved.set(bar.date, carried);
    }

    return {
      rateOn: (date: string) => resolved.get(date)?.rate,
      provenanceIds: [...new Set([...resolved.values()].map((r) => r.provenanceId))],
    };
  }
}

/** `historicalService({ tx, asOf, prov }).bars(42, { start: '2020-08-27', … })`. */
export function historicalService(deps: DataDeps): HistoricalService {
  return new HistoricalService(deps);
}

export { DataNotFoundError } from './reference.js';
