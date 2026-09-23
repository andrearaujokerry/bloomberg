/**
 * `functions/FXC/resolve.ts` — the FX cross matrix (FUNCTIONS_TIER2.md §FXC L2080-2225).
 *
 * Nine instruments, one hundred cells. Everything that is not one of those nine is arithmetic, and
 * the payload says which arithmetic: `kind` is `unity | direct | inverse | cross`, `derivation`
 * spells it (`'EURUSD × USDJPY'`, `'1 / USDJPY'`) and `via` names the vehicle currency.
 *
 * The rule this file exists to get right is **a derived cross cites both legs**. §FXC's acceptance
 * row is exact about it: "a derived cross must cite the provenance of both legs, not one". A
 * `ValueCell` has room for a single `provIdx`, so the cell carries `provIdx` (the base leg, as
 * §FXC step 3 specifies) *and* `legProvIdx` — every provenance index the number depends on, in leg
 * order, with `legSourceIds` beside it for the CSV. Ctrl+I on a cross then shows two rows, which is
 * the truth: EURJPY at 178.93 is a Yahoo EURUSD print multiplied by a Yahoo USDJPY print, and a
 * user who wants to know when that number was captured needs both capture instants, not one.
 *
 * The other rules:
 *
 *  - **A null leg is not a cross.** One missing leg gives `{ v: null, st:'na' }` and a
 *    `meta.unavailable` entry, never the surviving leg on its own and never `NaN`.
 *  - **The state is the worse of the two legs** (`blank ≻ na ≻ stale ≻ closed ≻ live`): a cross is
 *    exactly as fresh as its staler half.
 *  - **Rounding happens at display time.** The payload carries full precision so JSON, CSV and the
 *    WebSocket snapshot are value-identical (API-05); `decimals` travels with the cell as a
 *    rendering hint derived from `fx_terms.pip_size`.
 *  - **No read-through, in either mode** (§0.4 rule 2, and `ReadThroughKind` has no `frankfurter`).
 *
 * The unity cell carries `null`, not `1`: see FXC.ts's header — the runner rejects a finite number
 * with `provIdx: -1`, and no source publishes a currency against itself.
 */

import { sql } from 'drizzle-orm';

import type { ValueCell, ValueState } from '@terminal/core';
import { monitorColumn } from '@terminal/core';
import type {
  FxcCell,
  FxcEcbCompare,
  FxcParams,
  FxcPayload,
} from '@terminal/core/functions/manifests/FXC';
import {
  CROSSES_DERIVED_VIA_USD,
  ECB_FIXING_STALE,
  FXC_DEPTH_DETAIL,
  FXC_ECB_CHG_DETAIL,
  FXC_FORWARD_DETAIL,
  FXC_PAIR_FIELDS,
  fxcDecimals,
  INDICATIVE_MID_ONLY,
  NO_FX_DEPTH_SOURCE,
} from '@terminal/core/functions/manifests/FXC';
import type { MonitorColumn, MonitorRow } from '@terminal/core/functions/shared/monitor';

import type { ResolveContext } from '../context.js';
import { cellFromState } from '../shared/cells.js';
import { displayOf } from '../shared/instrumentSummary.js';

const VEHICLE = 'USD';

/** ECB fixings are published once a day at 16:00 CET; the wire timestamp §FXC specifies is 14:15Z. */
const ECB_FIXING_TIME = 'T14:15:00.000Z';
const ECB_STALE_DAYS = 4;

const naCell = (provIdx = -1): ValueCell => ({ v: null, st: 'na', provIdx });

const STATE_RANK: Record<ValueState, number> = { blank: 4, na: 3, stale: 2, closed: 1, live: 0 };
const worseState = (a: ValueState, b: ValueState): ValueState =>
  STATE_RANK[a] >= STATE_RANK[b] ? a : b;

const numberOf = (cell: ValueCell): number | null => (typeof cell.v === 'number' ? cell.v : null);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The seeded pairs (§FXC resolver step 1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface PairRow extends Record<string, unknown> {
  instrument_id: string;
  ticker: string;
  name: string;
  exch_code: string;
  market_sector: string;
  asset_class: string;
  base_ccy: string;
  quote_ccy: string;
  pip_size: string | null;
}

interface Pair {
  instrumentId: number;
  key: string;
  ticker: string;
  name: string;
  exchCode: string;
  marketSector: MonitorRow['marketSector'];
  assetClass: MonitorRow['assetClass'];
  base: string;
  quote: string;
  pipSize: number | null;
  subject: string;
}

/**
 * Every current `fx` instrument whose two currencies are both in the requested set (plus the
 * vehicle). One statement: §FXC's budget is one DB query and one plant snapshot in live mode, and
 * ten currencies is at most forty-five candidate pairs.
 */
async function seededPairs(ctx: ResolveContext, ccys: readonly string[]): Promise<Pair[]> {
  const wanted = [...new Set([...ccys, VEHICLE])];
  const res = await ctx.db.execute<PairRow>(sql`
    SELECT ins.instrument_id::text AS instrument_id, ins.ticker, ins.name, ins.exch_code,
           ins.market_sector::text AS market_sector, ins.asset_class::text AS asset_class,
           trim(ft.base_ccy) AS base_ccy, trim(ft.quote_ccy) AS quote_ccy,
           ft.pip_size::text AS pip_size
      FROM fx_terms ft
      JOIN instruments ins
        ON ins.instrument_id = ft.instrument_id
       AND bt_as_of(ins.valid_from, ins.valid_to, ins.tx_from, ins.tx_to,
                    ${ctx.asOf.validAt}::timestamptz, ${ctx.asOf.knownAt}::timestamptz)
     WHERE ins.asset_class = 'fx'
       AND bt_as_of(ft.valid_from, ft.valid_to, ft.tx_from, ft.tx_to,
                    ${ctx.asOf.validAt}::timestamptz, ${ctx.asOf.knownAt}::timestamptz)
       AND trim(ft.base_ccy)  = ANY(${sql.param(wanted)}::text[])
       AND trim(ft.quote_ccy) = ANY(${sql.param(wanted)}::text[])
     ORDER BY ins.search_weight DESC, ins.ticker ASC`);

  return res.rows.map((row) => {
    const instrumentId = Number(row.instrument_id);
    const marketSector = row.market_sector as MonitorRow['marketSector'];
    return {
      instrumentId,
      key: displayOf(row.ticker, row.exch_code, marketSector),
      ticker: row.ticker,
      name: row.name,
      exchCode: row.exch_code,
      marketSector,
      assetClass: row.asset_class as MonitorRow['assetClass'],
      base: row.base_ccy,
      quote: row.quote_ccy,
      pipSize: row.pip_size === null ? null : Number(row.pip_size),
      subject: ctx.plant.subjectFor(instrumentId),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ECB fixings (§FXC resolver step 2, ecb mode)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface FxRateRow extends Record<string, unknown> {
  base_ccy: string;
  quote_ccy: string;
  rate: string;
  rate_date: string;
  source_id: string;
  provenance_id: string;
  captured_at: string;
  source_ts: string | null;
}

async function ecbRateDate(ctx: ResolveContext, wanted: string | undefined): Promise<string | null> {
  const bound = wanted ?? ctx.asOf.validAt.toISOString().slice(0, 10);
  const res = await ctx.db.execute<{ rate_date: string | null }>(sql`
    SELECT max(rate_date)::text AS rate_date
      FROM fx_rates
     WHERE source_id = 'frankfurter'
       AND rate_date <= ${bound}::date`);
  return res.rows[0]?.rate_date ?? null;
}

async function ecbRates(
  ctx: ResolveContext,
  rateDate: string,
  ccys: readonly string[],
): Promise<FxRateRow[]> {
  const wanted = [...new Set([...ccys, VEHICLE])];
  const res = await ctx.db.execute<FxRateRow>(sql`
    SELECT trim(r.base_ccy) AS base_ccy, trim(r.quote_ccy) AS quote_ccy, r.rate::text AS rate,
           r.rate_date::text AS rate_date, r.source_id, r.provenance_id::text AS provenance_id,
           to_char(p.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
           to_char(p.source_ts   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS source_ts
      FROM fx_rates r
      JOIN provenance p ON p.provenance_id = r.provenance_id
     WHERE r.source_id = 'frankfurter'
       AND r.rate_date = ${rateDate}::date
       AND trim(r.base_ccy)  = ANY(${sql.param(wanted)}::text[])
       AND trim(r.quote_ccy) = ANY(${sql.param(wanted)}::text[])`);
  return [...res.rows];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rate lookup
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One published rate the matrix can build from: the value, its state and its citation. */
interface Quoted {
  v: number | null;
  st: ValueState;
  provIdx: number;
  sourceId: string;
  key: string | null;
  /** `'EURUSD'` — what a derivation string names, without the sector suffix. */
  ticker: string | null;
  subject: string | null;
  instrumentId: number | null;
  pipSize: number | null;
  ts?: number | null;
}

type RateBook = Map<string, Quoted>;

const bookKey = (base: string, quote: string): string => `${base}/${quote}`;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolve
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: FxcParams): Promise<FxcPayload> {
  const requested = [...new Set(params.ccys.map((c) => c.toUpperCase()))];
  const pairs = await seededPairs(ctx, requested);

  // Which currencies can be reached at all: the vehicle itself, plus anything with a seeded USD
  // pair in either direction. A currency with no path to the dollar cannot be crossed and is
  // dropped from the axes rather than rendered as a row of dashes.
  const reachable = new Set<string>([VEHICLE]);
  for (const p of pairs) {
    if (p.base === VEHICLE) reachable.add(p.quote);
    if (p.quote === VEHICLE) reachable.add(p.base);
  }
  const missing = requested.filter((c) => !reachable.has(c));
  for (const ccy of missing) {
    ctx.unavailable.add({
      field: ccy,
      reason: 'NO_SOURCE',
      detail: 'no seeded USD pair for this currency',
    });
  }
  const axis = requested.filter((c) => reachable.has(c));

  const book: RateBook = new Map();
  const notes: string[] = [INDICATIVE_MID_ONLY, NO_FX_DEPTH_SOURCE];
  let rateDate: string | null = null;
  let monitorRows: MonitorRow[] = [];

  if (params.quote === 'live') {
    // ── live mode: the plant, and only the plant (§0.4 rule 2) ──────────────────────────────
    const subjects = pairs.map((p) => p.subject);
    ctx.plant.ensureHot(subjects);
    const states = ctx.plant.snapshotMany(subjects);

    monitorRows = pairs.map((p) => {
      const state = states.get(p.subject);
      const cells: Record<string, ValueCell> = {};
      for (const field of FXC_PAIR_FIELDS) {
        cells[field] = cellFromState(ctx, state, field, p.subject);
      }
      return {
        instrumentId: p.instrumentId,
        key: p.key,
        name: p.name,
        assetClass: p.assetClass,
        marketSector: p.marketSector,
        exchCode: p.exchCode,
        gicsSector: null,
        subject: p.subject,
        cells,
      };
    });

    for (const [i, p] of pairs.entries()) {
      const cell = monitorRows[i]?.cells.PX_LAST;
      if (cell === undefined) continue;
      book.set(bookKey(p.base, p.quote), {
        v: numberOf(cell),
        st: cell.st,
        provIdx: cell.provIdx,
        sourceId: 'yahoo.chart',
        key: p.key,
        ticker: p.ticker,
        subject: p.subject,
        instrumentId: p.instrumentId,
        pipSize: p.pipSize,
        ts: cell.ts ?? null,
      });
    }
  } else {
    // ── ecb mode: the stored frankfurter fixings ────────────────────────────────────────────
    rateDate = await ecbRateDate(ctx, params.date);
    if (rateDate === null) {
      ctx.unavailable.add({
        field: 'rateDate',
        reason: 'NO_SOURCE',
        detail: 'no stored frankfurter fixing on or before this date',
      });
    } else {
      const ageDays = Math.floor(
        (Date.parse(`${ctx.asOf.validAt.toISOString().slice(0, 10)}T00:00:00Z`) -
          Date.parse(`${rateDate}T00:00:00Z`)) /
          86_400_000,
      );
      const stale = ageDays > ECB_STALE_DAYS;
      if (stale) notes.push(ECB_FIXING_STALE);
      const ts = Date.parse(`${rateDate}${ECB_FIXING_TIME}`);
      const pipByPair = new Map(pairs.map((p) => [bookKey(p.base, p.quote), p]));
      for (const row of await ecbRates(ctx, rateDate, axis)) {
        const provIdx = ctx.prov.add({
          sourceId: row.source_id,
          provenanceId: Number(row.provenance_id),
          capturedAt: new Date(row.captured_at),
          sourceTs: row.source_ts === null ? null : new Date(row.source_ts),
          st: stale ? 'stale' : 'closed',
          tier: 'eod',
        });
        const pair = pipByPair.get(bookKey(row.base_ccy, row.quote_ccy));
        book.set(bookKey(row.base_ccy, row.quote_ccy), {
          v: Number(row.rate),
          st: stale ? 'stale' : 'closed',
          provIdx,
          sourceId: row.source_id,
          key: pair?.key ?? null,
          ticker: pair?.ticker ?? `${row.base_ccy}${row.quote_ccy}`,
          subject: null,
          instrumentId: pair?.instrumentId ?? null,
          pipSize: pair?.pipSize ?? null,
          ts,
        });
      }
    }
    ctx.unavailable.add({
      field: 'chgPct1d',
      reason: 'NOT_APPLICABLE',
      detail: FXC_ECB_CHG_DETAIL,
    });

    // The `pairs` grid stays on screen in ecb mode, filled from the same stored fixings: §FXC's
    // entitlement note is that the ECB tab is the one FX view an export- or API-only grant can
    // always serve, and a tab that renders an empty grid is not that. The intraday columns are
    // `na` — the ECB publishes one fixing a day and there is no open, high, low or last trade.
    monitorRows = pairs.map((p) => {
      const quoted = book.get(bookKey(p.base, p.quote));
      const cells: Record<string, ValueCell> = {};
      for (const field of FXC_PAIR_FIELDS) {
        cells[field] =
          field === 'PX_LAST' && quoted !== undefined && quoted.v !== null
            ? { v: quoted.v, st: quoted.st, ts: quoted.ts ?? null, provIdx: quoted.provIdx }
            : naCell(quoted?.provIdx ?? -1);
      }
      return {
        instrumentId: p.instrumentId,
        key: p.key,
        name: p.name,
        assetClass: p.assetClass,
        marketSector: p.marketSector,
        exchCode: p.exchCode,
        gicsSector: null,
        subject: p.subject,
        cells,
      };
    });
  }

  // ── step 3: the matrix ────────────────────────────────────────────────────────────────────
  const chgByPair = new Map<string, ValueCell>();
  if (params.quote === 'live') {
    for (const [i, p] of pairs.entries()) {
      const cell = monitorRows[i]?.cells.CHG_PCT_1D;
      if (cell !== undefined) chgByPair.set(bookKey(p.base, p.quote), cell);
    }
  }

  let anyCross = false;
  const matrix: FxcCell[][] = axis.map((base) =>
    axis.map((quote): FxcCell => {
      const decimalsFor = (pip: number | null): number => fxcDecimals(params.decimals, pip);

      if (base === quote) {
        return {
          base,
          quote,
          kind: 'unity',
          rate: naCell(),
          chgPct1d: naCell(),
          decimals: decimalsFor(null),
          instrumentId: null,
          key: null,
          subject: null,
          via: null,
          derivation: null,
          provIdx: -1,
          legProvIdx: [],
          legSourceIds: [],
        };
      }

      const direct = book.get(bookKey(base, quote));
      if (direct !== undefined) {
        const rate: ValueCell =
          direct.v === null
            ? { v: null, st: direct.st, provIdx: direct.provIdx }
            : { v: direct.v, st: direct.st, ts: direct.ts ?? null, provIdx: direct.provIdx };
        if (direct.v !== null && direct.subject !== null) {
          rate.live = { subject: direct.subject, field: 'PX_LAST' };
        }
        return {
          base,
          quote,
          kind: 'direct',
          rate,
          chgPct1d: chgByPair.get(bookKey(base, quote)) ?? naCell(direct.provIdx),
          decimals: decimalsFor(direct.pipSize),
          instrumentId: direct.instrumentId,
          key: direct.key,
          subject: direct.subject,
          via: null,
          derivation: null,
          provIdx: direct.provIdx,
          legProvIdx: direct.provIdx < 0 ? [] : [direct.provIdx],
          legSourceIds: [direct.sourceId],
        };
      }

      const inverse = book.get(bookKey(quote, base));
      if (inverse !== undefined) {
        // The screen recomputes an inverse from the direct cell's live value, so the cell carries
        // no `live` of its own: one flash per tick, on the pair that actually ticked (TERM-08).
        const v = inverse.v === null || inverse.v === 0 ? null : 1 / inverse.v;
        return {
          base,
          quote,
          kind: 'inverse',
          rate:
            v === null
              ? { v: null, st: inverse.st, provIdx: inverse.provIdx }
              : { v, st: inverse.st, ts: inverse.ts ?? null, provIdx: inverse.provIdx },
          chgPct1d: naCell(inverse.provIdx),
          decimals: decimalsFor(inverse.pipSize),
          instrumentId: inverse.instrumentId,
          key: inverse.key,
          subject: null,
          via: null,
          derivation: inverse.ticker === null ? null : `1 / ${inverse.ticker}`,
          provIdx: inverse.provIdx,
          legProvIdx: inverse.provIdx < 0 ? [] : [inverse.provIdx],
          legSourceIds: [inverse.sourceId],
        };
      }

      // ── a cross, via the dollar ─────────────────────────────────────────────────────────
      anyCross = true;
      const first = legOf(book, base, VEHICLE);
      const second = legOf(book, VEHICLE, quote);
      const decimals = decimalsFor(second?.pipSize ?? null);
      if (first === null || second === null || first.v === null || second.v === null) {
        ctx.unavailable.add({
          field: `matrix.${base}${quote}`,
          reason: 'NO_SOURCE',
          detail: 'one leg of the cross is unavailable',
        });
        return {
          base,
          quote,
          kind: 'cross',
          rate: naCell(first?.provIdx ?? -1),
          chgPct1d: naCell(first?.provIdx ?? -1),
          decimals,
          instrumentId: null,
          key: null,
          subject: null,
          via: VEHICLE,
          derivation:
            first === null || second === null ? null : `${first.label} × ${second.label}`,
          provIdx: first?.provIdx ?? -1,
          legProvIdx: [first?.provIdx, second?.provIdx].filter(
            (idx): idx is number => typeof idx === 'number' && idx >= 0,
          ),
          legSourceIds: [first?.sourceId, second?.sourceId].filter(
            (s): s is string => s !== undefined,
          ),
        };
      }

      const st = worseState(first.st, second.st);
      return {
        base,
        quote,
        kind: 'cross',
        rate: { v: first.v * second.v, st, provIdx: first.provIdx },
        chgPct1d: naCell(first.provIdx),
        decimals,
        instrumentId: null,
        key: null,
        subject: null,
        via: VEHICLE,
        derivation: `${first.label} × ${second.label}`,
        // §FXC acceptance: BOTH legs, in the order the derivation names them.
        provIdx: first.provIdx,
        legProvIdx: [first.provIdx, second.provIdx].filter((idx) => idx >= 0),
        legSourceIds: [first.sourceId, second.sourceId],
      };
    }),
  );
  if (anyCross) notes.push(CROSSES_DERIVED_VIA_USD);

  // ── step 4: the ECB comparison ────────────────────────────────────────────────────────────
  let ecbCompare: FxcEcbCompare[] | null = null;
  if (params.quote === 'live' && pairs.length > 0) {
    const fixingDate = await ecbRateDate(ctx, undefined);
    if (fixingDate !== null) {
      const fixings = new Map(
        (await ecbRates(ctx, fixingDate, axis)).map((r) => [
          bookKey(r.base_ccy, r.quote_ccy),
          Number(r.rate),
        ]),
      );
      ecbCompare = pairs.map((p) => {
        const live = book.get(bookKey(p.base, p.quote))?.v ?? null;
        const ecb = fixings.get(bookKey(p.base, p.quote)) ?? null;
        return {
          base: p.base,
          quote: p.quote,
          live,
          ecb,
          diffPct: live === null || ecb === null || ecb === 0 ? null : (live / ecb - 1) * 100,
        };
      });
    }
  }

  // ── step 5: the standing gaps ─────────────────────────────────────────────────────────────
  ctx.unavailable.add({ field: 'bidAsk', reason: 'NO_SOURCE', detail: FXC_DEPTH_DETAIL });
  ctx.unavailable.add({
    field: 'forwardPoints',
    reason: 'NOT_APPLICABLE',
    detail: FXC_FORWARD_DETAIL,
  });

  // ── step 6: transpose ─────────────────────────────────────────────────────────────────────
  const finalMatrix = params.transpose ? transpose(matrix) : matrix;

  return {
    variant: 'default',
    quote: params.quote,
    rateDate,
    ccys: axis,
    matrix: finalMatrix,
    pairs: monitorRows,
    pairColumns: FXC_PAIR_COLUMNS,
    ecbCompare,
    missing,
    notes,
    asOf: ctx.asOf.validAt.toISOString(),
  };
}

/** A leg of a cross, with the label the derivation string uses. */
function legOf(
  book: RateBook,
  base: string,
  quote: string,
): (Quoted & { label: string }) | null {
  const direct = book.get(bookKey(base, quote));
  if (direct !== undefined) {
    return { ...direct, label: direct.ticker ?? `${base}${quote}` };
  }
  const inverse = book.get(bookKey(quote, base));
  if (inverse === undefined) return null;
  return {
    ...inverse,
    v: inverse.v === null || inverse.v === 0 ? null : 1 / inverse.v,
    label: inverse.ticker === null ? `1 / ${quote}${base}` : `1 / ${inverse.ticker}`,
  };
}

function transpose(matrix: FxcCell[][]): FxcCell[][] {
  const rows = matrix.length;
  const cols = matrix[0]?.length ?? 0;
  const out: FxcCell[][] = [];
  for (let j = 0; j < cols; j += 1) {
    const row: FxcCell[] = [];
    for (let i = 0; i < rows; i += 1) {
      const cell = matrix[i]?.[j];
      if (cell !== undefined) row.push(cell);
    }
    out.push(row);
  }
  return out;
}

/** The `pairs` grid's columns, derived from the dictionary once (§0.2 `monitorColumn`). */
export const FXC_PAIR_COLUMNS: MonitorColumn[] = FXC_PAIR_FIELDS.map((f) => monitorColumn(f));
