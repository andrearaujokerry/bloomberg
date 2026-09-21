/**
 * `data/intraday.ts` — `bars_intraday` as a `SeriesBlock` (FUNCTIONS.md §1.4.2
 * `DataServices.intraday`, DATA_MODEL §7.2).
 *
 * The unit here is the **session**, not the calendar day: `days: 1 | 2 | 5` means the last one,
 * two or five sessions that actually have bars, counted in the exchange's own time zone
 * (`exchanges.tz` via the primary listing), because a US post-market bar at 19:59 ET is on the
 * *next* UTC date and grouping by UTC would split one session across two.
 *
 * Intraday bars are never adjusted: a split that goes ex tomorrow does not move today's 1-minute
 * prints, and a five-session window cannot span one. `SeriesBlock.adjust` is therefore absent
 * rather than `'unadjusted'` — the block was not adjusted, it is not adjustable.
 *
 * `is_final` is why a repeated poll is safe: the last bar of a poll is provisional until a later
 * poll passes it, and the stored row is replaced rather than duplicated. A provisional bar is
 * served (it is the live one) and cited as `'live'`; every closed bar is `'closed'`.
 */

import { sql } from 'drizzle-orm';

import { citeProvenance, citedIndex, instrumentCurrency, utcDate } from './reference.js';

import type { BarSession, FieldId } from '@terminal/core';
import type { AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';
import type { SeriesBlock } from './historical.js';
import type { DataDeps, ProvenanceSink } from './reference.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `DataServices.intraday.bars`'s query (FUNCTIONS.md L293). */
export interface IntradayQuery {
  /** How many sessions back, counted over the sessions that have bars. */
  days: 1 | 2 | 5;
  interval: '1m' | '5m';
  /** `'regular'` is the main session only; `'extended'` adds pre and post (FEED-06). */
  session: 'regular' | 'extended';
}

/** One contiguous run of bars of the same kind, for the chart's session bands (CHRT-02). */
export interface SessionBand {
  /** ISO-8601 UTC instant of the first bar in the band. */
  start: string;
  /** ISO-8601 UTC instant one interval after the last bar — the band's exclusive end. */
  end: string;
  kind: BarSession;
}

/** What `bars()` returns: a `SeriesBlock` plus the bands the chart shades. */
export type IntradaySeries = SeriesBlock & { sessions: SessionBand[] };

/** The columns an intraday block carries. */
export const INTRADAY_FIELDS: readonly FieldId[] = Object.freeze([
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_LAST',
  'PX_VOLUME',
]);

/** One `bars_intraday` row. */
export interface IntradayBar {
  /** Bar start, ISO-8601 UTC. */
  ts: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  session: BarSession;
  isFinal: boolean;
  provenanceId: number;
}

const INTERVAL_MS: Readonly<Record<'1m' | '5m', number>> = Object.freeze({
  '1m': 60_000,
  '5m': 300_000,
});

const SESSION_KINDS: ReadonlySet<string> = new Set(['pre', 'regular', 'post']);

function num(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `DataServices.intraday` (FUNCTIONS.md §1.4.2 L293). */
export class IntradayService {
  readonly #tx: Tx;
  readonly #at: AsOf;
  readonly #prov: ProvenanceSink;

  constructor(deps: DataDeps) {
    this.#tx = deps.tx;
    this.#at = deps.asOf;
    this.#prov = deps.prov;
  }

  /**
   * The last `q.days` sessions of `q.interval` bars, ascending by bar start.
   *
   * @throws DataNotFoundError when the instrument has no version at `(validAt, knownAt)`.
   */
  async bars(id: number, q: IntradayQuery): Promise<IntradaySeries> {
    const currency = await instrumentCurrency(this.#tx, id, this.#at);
    const tz = await this.#exchangeTz(id);
    const asOfDate = utcDate(this.#at.validAt);

    const sessionDates = await this.#recentSessions(id, q, tz, asOfDate);
    const bars = sessionDates.length === 0 ? [] : await this.#loadBars(id, q, tz, sessionDates);

    const citation = await citeProvenance(
      this.#tx,
      this.#prov,
      bars.map((bar) => bar.provenanceId),
      // A provisional bar is the live one; the rest are closed prints. `worstState()` takes the
      // worse of the two, which is what `meta.staleness` should say about a window that ends in
      // an open session.
      { st: bars.some((bar) => !bar.isFinal) ? 'live' : 'closed' },
    );

    const index: string[] = [];
    const rows: (number | null)[][] = [];
    const rowProvIdx: number[] = [];
    const rowProvenanceIds: number[] = [];
    for (const bar of bars) {
      index.push(bar.ts);
      rows.push([bar.open, bar.high, bar.low, bar.close, bar.volume]);
      rowProvenanceIds.push(bar.provenanceId);
      rowProvIdx.push(citedIndex(citation.provIdxOf, bar.provenanceId));
    }

    return {
      columns: [...INTRADAY_FIELDS],
      index,
      rows,
      currency,
      rowProvIdx,
      rowProvenanceIds,
      sessions: bands(bars, INTERVAL_MS[q.interval]),
      ...citation,
    };
  }

  /**
   * The instrument's exchange time zone, via its primary listing's MIC.
   *
   * `'UTC'` when the instrument has no listing with a known MIC — indices, FX and rates, whose
   * bars are already keyed on a single continuous clock.
   */
  async #exchangeTz(instrumentId: number): Promise<string> {
    const res = await this.#tx.execute<{ tz: string | null }>(sql`
        SELECT e.tz
          FROM listings l
          JOIN exchanges e ON e.mic = l.mic
         WHERE l.instrument_id = ${instrumentId}
           AND bt_as_of(l.valid_from, l.valid_to, l.tx_from, l.tx_to,
                        ${this.#at.validAt}::timestamptz, ${this.#at.knownAt}::timestamptz)
         ORDER BY l.is_primary DESC, l.listing_id
         LIMIT 1`);
    return res.rows[0]?.tz ?? 'UTC';
  }

  /** The last `q.days` local dates on or before the as-of date that have bars, ascending. */
  async #recentSessions(
    instrumentId: number,
    q: IntradayQuery,
    tz: string,
    asOfDate: string,
  ): Promise<string[]> {
    const res = await this.#tx.execute<{ d: string }>(sql`
        SELECT DISTINCT ((bar_ts AT TIME ZONE ${tz})::date)::text AS d
          FROM bars_intraday
         WHERE instrument_id = ${instrumentId}
           AND bar_interval = ${q.interval}
           AND (bar_ts AT TIME ZONE ${tz})::date <= ${asOfDate}::date
           ${q.session === 'regular' ? sql`AND session = 'regular'` : sql``}
         ORDER BY d DESC
         LIMIT ${q.days}`);
    return res.rows.map((row) => row.d).reverse();
  }

  /** Every bar of those sessions, ascending by bar start. */
  async #loadBars(
    instrumentId: number,
    q: IntradayQuery,
    tz: string,
    sessionDates: readonly string[],
  ): Promise<IntradayBar[]> {
    const first = sessionDates[0];
    const last = sessionDates[sessionDates.length - 1];
    if (first === undefined || last === undefined) return [];
    const res = await this.#tx.execute<{
      bar_ts: string;
      open: string | null;
      high: string | null;
      low: string | null;
      close: string;
      volume: string | null;
      session: string;
      is_final: boolean;
      provenance_id: string;
    }>(sql`
        SELECT to_char(bar_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS bar_ts,
               open::text, high::text, low::text, close::text, volume::text,
               session, is_final, provenance_id::text AS provenance_id
          FROM bars_intraday
         WHERE instrument_id = ${instrumentId}
           AND bar_interval = ${q.interval}
           AND (bar_ts AT TIME ZONE ${tz})::date BETWEEN ${first}::date AND ${last}::date
           ${q.session === 'regular' ? sql`AND session = 'regular'` : sql``}
         ORDER BY bar_ts`);

    return res.rows.map((row) => ({
      ts: row.bar_ts,
      open: num(row.open),
      high: num(row.high),
      low: num(row.low),
      close: Number(row.close),
      volume: num(row.volume),
      session: (SESSION_KINDS.has(row.session) ? row.session : 'regular') as BarSession,
      isFinal: row.is_final,
      provenanceId: Number(row.provenance_id),
    }));
  }
}

/**
 * Contiguous runs of same-kind bars, in order. A run ends when the kind changes or when the gap to
 * the next bar exceeds one interval — an overnight break between two sessions is a gap, and two
 * regular sessions must not be shaded as one band.
 */
export function bands(bars: readonly IntradayBar[], intervalMs: number): SessionBand[] {
  const out: SessionBand[] = [];
  let open: { start: string; end: number; kind: BarSession } | null = null;

  for (const bar of bars) {
    const startMs = Date.parse(bar.ts);
    if (open !== null && (open.kind !== bar.session || startMs > open.end)) {
      out.push({ start: open.start, end: new Date(open.end).toISOString(), kind: open.kind });
      open = null;
    }
    if (open === null) open = { start: bar.ts, end: startMs + intervalMs, kind: bar.session };
    else open.end = startMs + intervalMs;
  }
  if (open !== null) {
    out.push({ start: open.start, end: new Date(open.end).toISOString(), kind: open.kind });
  }
  return out;
}

/** `intradayService({ tx, asOf, prov }).bars(42, { days: 1, interval: '1m', session: 'regular' })`. */
export function intradayService(deps: DataDeps): IntradayService {
  return new IntradayService(deps);
}
