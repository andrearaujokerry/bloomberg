/**
 * `functions/BTMM/resolve.ts` — Treasury & Money Markets (FUNCTIONS_TIER2.md §BTMM L1898-2079).
 *
 * Five blocks off four reads. Everything on this page is a number somebody published: the NY Fed
 * fixings, the Treasury par (or H.15 constant-maturity) curve, the Treasury bill file, the FOMC
 * calendar and the plant's delayed context quotes. The only arithmetic is subtraction — spreads,
 * the target midpoint, the one-day change — and every derived cell cites the provenance of its
 * primary input (§0.4 rule 4), never a fresh source of its own.
 *
 * The three rules that shape the file:
 *
 *  1. **A spread is never computed from a partial pair.** §BTMM step 6 is explicit and it is the
 *     rule most likely to be broken by accident: `10Y − 2Y` with a missing 2Y is not "the 10Y", it
 *     is not a number at all. {@link spreadOf} returns an `na` cell and records the reason.
 *  2. **SOFRAI is not a rate.** The SOFR averages index publishes `avg30d/90d/180d` and an index
 *     level and nothing else (PROVIDERS §10.4). Its `rate` and percentile cells are `na` with a
 *     `NOT_APPLICABLE` note — a zero there would print a 0.00 % overnight rate on the desk's
 *     morning page.
 *  3. **The curve is only as fresh as last night's job.** `ReadThroughKind` has no
 *     `treasury.yieldcurve` member, so there is nothing to fetch on the request path: a curve date
 *     more than three `USGOVT` business days old sets `curve.stale`, cites its provenance with
 *     `st:'stale'` and adds the `CURVE_STALE` note (TERM-12). The overnight block *does* have a
 *     read-through (`nyfed.rates`), used once and only when the newest fixing is behind.
 *
 * Deviation from §BTMM, recorded here and in BTMM.ts's header: a null-by-design cell is
 * `{ v: null, st:'na', provIdx: -1 }` with the reason in `meta.unavailable`, not
 * `{ …, r:'NO_SOURCE' }`. `ValueCell.r` is the closed `ReasonCode` union (`types/entitlement.ts`)
 * and `'NO_SOURCE'` is not a member of it; `r` means "this was refused", and nothing here was
 * refused. The established shape in DES, GIP, RV and W is the same.
 */

import { sql } from 'drizzle-orm';

import type { FieldId, Tier, ValueCell, ValueState } from '@terminal/core';
import { monitorColumn } from '@terminal/core';
import { addDays, type IsoDate } from '@terminal/core/calendars/calendar';
import type {
  BtmmBillsBlock,
  BtmmCurveBlock,
  BtmmMeeting,
  BtmmNextMeeting,
  BtmmParams,
  BtmmPayload,
  BtmmPolicy,
  BtmmRateCode,
  CurvePointRow,
  CurveQuoteType,
  SpreadDef,
  SpreadLeg,
  SpreadRow,
  RateFixingRow,
} from '@terminal/core/functions/manifests/BTMM';
import {
  BTMM_DISCOUNT_WINDOW_DETAIL,
  BTMM_IMPLIED_PATH_DETAIL,
  BTMM_IORB_DETAIL,
  BTMM_RATE_CODES,
  BTMM_RATE_LABELS,
  BTMM_SOFRAI_DETAIL,
  BTMM_SPREADS,
  CURVE_STALE,
  NO_DISCOUNT_WINDOW_SOURCE,
  NO_FED_FUNDS_FUTURES,
  NO_IORB_SOURCE,
  RATE_REVISED,
} from '@terminal/core/functions/manifests/BTMM';
import type { MonitorRow } from '@terminal/core/functions/shared/monitor';
import { localClock, localTimeToUtc } from '@terminal/core/quote/session';

import type { CurvePoint, CurvePoints } from '../../data/curves.js';
import type { RateFixing } from '../../data/rates.js';
import type { ResolveContext } from '../context.js';
import { cellFromState } from '../shared/cells.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A cell that is absent by design: null, `na`, cites nothing. The reason lives in `meta.unavailable`. */
const naCell = (provIdx = -1): ValueCell => ({ v: null, st: 'na', provIdx });

const numberOf = (cell: ValueCell): number | null => (typeof cell.v === 'number' ? cell.v : null);

/** Percent difference → basis points, to one decimal, without the float tail of `x * 100`. */
const bp = (a: number, b: number): number => Math.round((a - b) * 1000) / 10;

/** `blank ≻ na ≻ stale ≻ closed ≻ live` — the worse of two cell states (§FXC step 3, reused here). */
const STATE_RANK: Record<ValueState, number> = {
  blank: 4,
  na: 3,
  stale: 2,
  closed: 1,
  live: 0,
};
const worseState = (a: ValueState, b: ValueState): ValueState =>
  STATE_RANK[a] >= STATE_RANK[b] ? a : b;

/** Every stored value on this page is a published daily figure: §0.4 rule 3's `closed`, tier `eod`. */
const STORED_TIER: Tier = 'eod';

const CURVE_STALE_BUSINESS_DAYS = 3;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Dates
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `ctx.asOf.validAt` as the New York trading day — the day this page is "today". */
function nyDate(ms: number): IsoDate {
  return localClock('America/New_York', ms)?.date ?? new Date(ms).toISOString().slice(0, 10);
}

/** A stored day at a New York wall-clock time, as epoch ms; `null` when the zone is unsupported. */
function nyInstant(date: string, time: string): number | null {
  return localTimeToUtc('America/New_York', date, time) ?? null;
}

/** Business days between two ISO days on `cal`, counting the later one. `null` when no calendar. */
function businessDaysBetween(
  cal: { isBusinessDay(d: IsoDate): boolean } | null,
  from: IsoDate,
  to: IsoDate,
): number | null {
  if (cal === null || from > to) return from > to ? 0 : null;
  let count = 0;
  let cursor = from;
  // A curve that is years behind is still only a boolean question; 400 days is more than enough to
  // answer it and bounds the loop against a corrupt date.
  for (let i = 0; i < 400 && cursor < to; i += 1) {
    cursor = addDays(cursor, 1);
    if (cal.isBusinessDay(cursor)) count += 1;
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface CiteInput {
  sourceId: string;
  provenanceId: number;
  capturedAt: string;
  sourceTs: string | null;
  st: ValueState;
}

function cite(ctx: ResolveContext, input: CiteInput): number {
  return ctx.prov.add({
    sourceId: input.sourceId,
    provenanceId: input.provenanceId,
    capturedAt: new Date(input.capturedAt),
    sourceTs: input.sourceTs === null ? null : new Date(input.sourceTs),
    st: input.st,
    tier: STORED_TIER,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Overnight (§BTMM resolver step 2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The two newest fixings of every code, in one call per code.
 *
 * `history(code, 2)` returns them newest first, so `[0]` is the fixing and `[1]` is the one the
 * change column subtracts. A code with nothing stored comes back empty and still produces a row —
 * the screen's six lines are fixed by the source set, and a missing SOFR is a visible `na` line,
 * not a row that vanishes.
 */
async function readFixings(
  ctx: ResolveContext,
): Promise<Map<BtmmRateCode, readonly RateFixing[]>> {
  const out = new Map<BtmmRateCode, readonly RateFixing[]>();
  for (const code of BTMM_RATE_CODES) {
    out.set(code, await ctx.data.rates.history(code, 2));
  }
  return out;
}

function newestEffectiveDate(fixings: Map<BtmmRateCode, readonly RateFixing[]>): string | null {
  let newest: string | null = null;
  for (const rows of fixings.values()) {
    const row = rows[0];
    if (row === undefined) continue;
    if (newest === null || row.effectiveDate > newest) newest = row.effectiveDate;
  }
  return newest;
}

function fixingRow(
  ctx: ResolveContext,
  code: BtmmRateCode,
  rows: readonly RateFixing[],
): RateFixingRow {
  const subject = `r:${code}`;
  const latest = rows[0];
  const prior = rows[1];
  if (latest === undefined) {
    const blank = naCell();
    return {
      rateCode: code,
      label: BTMM_RATE_LABELS[code],
      publisher: 'NY Fed',
      effectiveDate: '',
      vintageAt: '',
      isLatest: false,
      subject,
      rate: blank,
      p1: blank,
      p25: blank,
      p75: blank,
      p99: blank,
      volumeBn: blank,
      avg30d: blank,
      avg90d: blank,
      avg180d: blank,
      indexValue: blank,
      chg1dBp: blank,
      revisionIndicator: '',
      provIdx: -1,
    };
  }

  const provIdx = cite(ctx, {
    sourceId: 'nyfed.rates',
    provenanceId: latest.provenanceId,
    capturedAt: latest.capturedAt,
    sourceTs: latest.sourceTs,
    st: 'closed',
  });
  const ts = nyInstant(latest.effectiveDate, '08:00');
  const stored = (v: number | null): ValueCell =>
    v === null ? naCell(provIdx) : { v, st: 'closed', ts, provIdx };

  // `SOFRAI` publishes averages and an index level only: its rate and percentile cells are `na`
  // with a reason, never a fabricated zero (§BTMM step 2).
  const isIndex = code === 'SOFRAI';
  const rate: ValueCell = isIndex
    ? naCell(provIdx)
    : { ...stored(latest.rate), live: { subject, field: 'RATE' } };

  const priorRate = prior?.rate ?? null;
  const chg1dBp: ValueCell =
    isIndex || latest.rate === null || priorRate === null
      ? naCell(provIdx)
      : { v: bp(latest.rate, priorRate), st: 'closed', ts, provIdx };

  return {
    rateCode: code,
    label: BTMM_RATE_LABELS[code],
    publisher: 'NY Fed',
    effectiveDate: latest.effectiveDate,
    vintageAt: latest.vintageAt,
    isLatest: latest.isLatest,
    subject,
    rate,
    p1: isIndex ? naCell(provIdx) : stored(latest.pct1),
    p25: isIndex ? naCell(provIdx) : stored(latest.pct25),
    p75: isIndex ? naCell(provIdx) : stored(latest.pct75),
    p99: isIndex ? naCell(provIdx) : stored(latest.pct99),
    volumeBn: isIndex ? naCell(provIdx) : stored(latest.volumeBn),
    avg30d: stored(latest.avg30d),
    avg90d: stored(latest.avg90d),
    avg180d: stored(latest.avg180d),
    indexValue: stored(latest.indexValue),
    chg1dBp,
    revisionIndicator: latest.revisionIndicator ?? '',
    provIdx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Curves (§BTMM resolver steps 4 and 5)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const DICTIONARY_TENORS = new Set([
  '1M',
  '3M',
  '6M',
  '1Y',
  '2Y',
  '3Y',
  '5Y',
  '7Y',
  '10Y',
  '20Y',
  '30Y',
]);

/** `'CRV_10Y'` for a tenor the dictionary carries; `null` for `1.5M`, `2M`, `4M` and the bills. */
function tenorFieldId(tenor: string): FieldId | null {
  return DICTIONARY_TENORS.has(tenor) ? (`CRV_${tenor}`) : null;
}

interface CurveRead {
  points: CurvePoints | null;
  compare: CurvePoints | null;
}

/**
 * The curve and the curve it is compared with.
 *
 * `data.curves.points` throws `CurveDataError` when a curve has no points at or before the as-of
 * date. That is a fact about the store, not a server fault: the morning page says the block is
 * missing rather than returning 500 because last night's ingest has not run.
 */
async function readCurve(
  ctx: ResolveContext,
  curveId: string,
  compareDate: string | undefined,
): Promise<CurveRead> {
  let points: CurvePoints | null = null;
  try {
    points = await ctx.data.curves.points(curveId);
  } catch {
    return { points: null, compare: null };
  }
  const wanted =
    compareDate ?? points.availableDates.find((d) => d < points.curveDate) ?? null;
  if (wanted === null) return { points, compare: null };
  try {
    const compare = await ctx.data.curves.points(curveId, wanted);
    return { points, compare: compare.curveDate === points.curveDate ? null : compare };
  } catch {
    return { points, compare: null };
  }
}

interface GovtTermRow extends Record<string, unknown> {
  instrument_id: string;
  cusip: string;
  maturity_date: string | null;
  on_the_run: boolean;
}

/** `govt_terms` for the bill instruments the curve points name, as of the request. */
async function billTerms(
  ctx: ResolveContext,
  instrumentIds: readonly number[],
): Promise<Map<number, GovtTermRow>> {
  const out = new Map<number, GovtTermRow>();
  if (instrumentIds.length === 0) return out;
  const list = sql.join(
    instrumentIds.map((id) => sql`${String(id)}::bigint`),
    sql`, `,
  );
  const res = await ctx.db.execute<GovtTermRow>(sql`
    SELECT instrument_id::text AS instrument_id, cusip, maturity_date::text AS maturity_date,
           on_the_run
      FROM govt_terms
     WHERE instrument_id IN (${list})
       AND bt_as_of(valid_from, valid_to, tx_from, tx_to,
                    ${ctx.asOf.validAt}::timestamptz, ${ctx.asOf.knownAt}::timestamptz)`);
  for (const row of res.rows) out.set(Number(row.instrument_id), row);
  return out;
}

function curvePointRow(args: {
  ctx: ResolveContext;
  curveId: string;
  sourceId: string;
  point: CurvePoint;
  compare: CurvePoint | undefined;
  stale: boolean;
  terms: GovtTermRow | undefined;
}): CurvePointRow {
  const { ctx, point, compare, stale } = args;
  const st: ValueState = stale ? 'stale' : 'closed';
  const provIdx = cite(ctx, {
    sourceId: args.sourceId,
    provenanceId: point.provenanceId,
    capturedAt: point.capturedAt,
    sourceTs: point.sourceTs,
    st,
  });
  const value: ValueCell = { v: point.value, st, provIdx };
  const compareValue: ValueCell =
    compare === undefined
      ? naCell(provIdx)
      : {
          v: compare.value,
          st,
          provIdx: cite(ctx, {
            sourceId: args.sourceId,
            provenanceId: compare.provenanceId,
            capturedAt: compare.capturedAt,
            sourceTs: compare.sourceTs,
            st,
          }),
        };
  const chgBp: ValueCell =
    compare === undefined ? naCell(provIdx) : { v: bp(point.value, compare.value), st, provIdx };

  return {
    curveId: args.curveId,
    tenor: point.tenor,
    tenorDays: point.tenorDays,
    quoteType: point.quoteType as CurveQuoteType,
    value,
    compareValue,
    chgBp,
    instrumentId: point.instrumentId,
    cusip: args.terms?.cusip ?? null,
    maturityDate: args.terms?.maturity_date ?? point.maturityDate,
    onTheRun: args.terms?.on_the_run ?? false,
    fieldId: tenorFieldId(point.tenor),
    provIdx,
  };
}

const byTenorDays = (a: CurvePoint, b: CurvePoint): number =>
  a.tenorDays === b.tenorDays ? a.tenor.localeCompare(b.tenor) : a.tenorDays - b.tenorDays;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Spreads (§BTMM resolver step 6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface SpreadInputs {
  curve: Map<string, CurvePointRow>;
  cmt: Map<string, CurvePointRow>;
  bills: Map<string, CurvePointRow>;
  rates: Map<BtmmRateCode, RateFixingRow>;
  targetMid: ValueCell;
}

/** One leg's `(value, compare, provIdx, state)`, or `null` when the leg has no number. */
function legOf(
  inputs: SpreadInputs,
  leg: SpreadLeg,
): { value: number; compare: number | null; provIdx: number; st: ValueState } | null {
  if (leg.kind === 'targetMid') {
    const v = numberOf(inputs.targetMid);
    return v === null
      ? null
      : { value: v, compare: null, provIdx: inputs.targetMid.provIdx, st: inputs.targetMid.st };
  }
  if (leg.kind === 'rate') {
    const row = inputs.rates.get(leg.code);
    const v = row === undefined ? null : numberOf(row.rate);
    return v === null || row === undefined
      ? null
      : { value: v, compare: null, provIdx: row.rate.provIdx, st: row.rate.st };
  }
  const point =
    leg.kind === 'curve'
      ? inputs.curve.get(leg.tenor)
      : leg.kind === 'cmt'
        ? inputs.cmt.get(leg.tenor)
        : inputs.bills.get(`${leg.tenor}|${leg.quoteType}`);
  const v = point === undefined ? null : numberOf(point.value);
  if (v === null || point === undefined) return null;
  return {
    value: v,
    compare: numberOf(point.compareValue),
    provIdx: point.value.provIdx,
    st: point.value.st,
  };
}

/**
 * One spread row. A missing leg produces an `na` cell and one `meta.unavailable` entry — never a
 * number built from the leg that happened to survive.
 */
function spreadOf(ctx: ResolveContext, def: SpreadDef, inputs: SpreadInputs, unit: 'bp' | 'pct'): SpreadRow {
  const from = legOf(inputs, def.from);
  const minus = legOf(inputs, def.minus);
  if (from === null || minus === null) {
    ctx.unavailable.add({
      field: `spreads.${def.id}`,
      reason: 'NO_SOURCE',
      detail: 'one leg of the spread is unavailable for this date',
    });
    const blank = naCell();
    return {
      id: def.id,
      label: def.label,
      definition: def.definition,
      value: blank,
      compareValue: blank,
      chgBp: blank,
      unit,
      fieldId: null,
      provIdx: -1,
    };
  }

  const st = worseState(from.st, minus.st);
  const raw = from.value - minus.value;
  const scaled = unit === 'bp' ? bp(from.value, minus.value) : Math.round(raw * 1e8) / 1e8;
  const value: ValueCell = { v: scaled, st, provIdx: from.provIdx };

  let compareValue: ValueCell = naCell(from.provIdx);
  let chgBp: ValueCell = naCell(from.provIdx);
  if (from.compare !== null && minus.compare !== null) {
    const rawCompare = from.compare - minus.compare;
    compareValue = {
      v: unit === 'bp' ? bp(from.compare, minus.compare) : Math.round(rawCompare * 1e8) / 1e8,
      st,
      provIdx: from.provIdx,
    };
    chgBp = { v: bp(raw, rawCompare), st, provIdx: from.provIdx };
  }

  return {
    id: def.id,
    label: def.label,
    definition: def.definition,
    value,
    compareValue,
    chgBp,
    unit,
    fieldId: null,
    provIdx: from.provIdx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Context (§BTMM resolver step 7)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const BTMM_CONTEXT_FX = ['EURUSD Curncy', 'USDJPY Curncy', 'GBPUSD Curncy'] as const;
export const BTMM_CONTEXT_INDICES = ['SPX Index', 'VIX Index', 'TNX Index'] as const;

const CONTEXT_FIELDS: readonly FieldId[] = Object.freeze(['PX_LAST', 'CHG_NET_1D', 'CHG_PCT_1D']);

/**
 * The context grid: three crosses and three indices, read from the plant and nowhere else.
 *
 * §0.4 rule 2 — a monitor never calls `ctx.providers.ensure` for a quote. A name the scheduler has
 * not polled is a pending cell the WebSocket fills; a name that is not seeded at all is simply not
 * a row, because a grid line with no instrument behind it has nothing to say.
 */
async function contextRows(ctx: ResolveContext, refs: readonly string[]): Promise<MonitorRow[]> {
  const resolved: { ref: string; id: number; name: string; display: string; assetClass: MonitorRow['assetClass']; marketSector: MonitorRow['marketSector']; exchCode: string }[] = [];
  for (const ref of refs) {
    const item = await ctx.data.reference.resolve(ref);
    const hit = item.instrument;
    if (hit === null) continue;
    resolved.push({
      ref,
      id: hit.instrumentId,
      name: hit.name,
      display: hit.display,
      assetClass: hit.assetClass,
      marketSector: hit.marketSector,
      exchCode: hit.exchCode,
    });
  }
  if (resolved.length === 0) return [];

  const subjects = resolved.map((r) => ctx.plant.subjectFor(r.id));
  ctx.plant.ensureHot(subjects);
  const states = ctx.plant.snapshotMany(subjects);

  return resolved.map((r, i) => {
    const subject = subjects[i] ?? ctx.plant.subjectFor(r.id);
    const state = states.get(subject);
    const cells: Record<string, ValueCell> = {};
    for (const field of CONTEXT_FIELDS) cells[field] = cellFromState(ctx, state, field, subject);
    return {
      instrumentId: r.id,
      key: r.display,
      name: r.name,
      assetClass: r.assetClass,
      marketSector: r.marketSector,
      exchCode: r.exchCode,
      gicsSector: null,
      subject,
      cells,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolve
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: BtmmParams): Promise<BtmmPayload> {
  const today = nyDate(ctx.asOf.validAt.getTime());
  const notes: string[] = [];

  let calendar: { isBusinessDay(d: IsoDate): boolean } | null = null;
  try {
    calendar = await ctx.data.reference.calendar('USGOVT');
  } catch {
    // No seeded USGOVT calendar: staleness falls back to the curve date itself, which is the
    // conservative answer (a stale curve stays flagged, a fresh one is never flagged wrongly).
    calendar = null;
  }

  // ── step 2: overnight ─────────────────────────────────────────────────────────────────────
  let fixings = await readFixings(ctx);
  const newest = newestEffectiveDate(fixings);
  const behind = newest === null ? null : businessDaysBetween(calendar, newest, today);
  if (ctx.usage !== 'export' && (newest === null || (behind !== null && behind > 1))) {
    try {
      await ctx.providers.ensure('nyfed.rates', 'all', { maxAgeMs: 3_600_000 });
      fixings = await readFixings(ctx);
    } catch {
      // A refused or circuit-open refresh leaves the stored fixings on screen (TERM-12); it is
      // never a 503 when there is something to show.
    }
  }

  const overnight = BTMM_RATE_CODES.map((code) => fixingRow(ctx, code, fixings.get(code) ?? []));
  const rateRows = new Map<BtmmRateCode, RateFixingRow>(overnight.map((r) => [r.rateCode, r]));
  if (overnight.some((r) => r.revisionIndicator !== '')) notes.push(RATE_REVISED);
  ctx.unavailable.add({
    field: 'overnight.SOFRAI.rate',
    reason: 'NOT_APPLICABLE',
    detail: BTMM_SOFRAI_DETAIL,
  });

  // ── step 3: policy ────────────────────────────────────────────────────────────────────────
  const effr = fixings.get('EFFR')?.[0] ?? null;
  const effrRow = rateRows.get('EFFR');
  const effrProvIdx = effrRow?.provIdx ?? -1;
  const effrTs = effr === null ? null : nyInstant(effr.effectiveDate, '08:00');
  const rangeFrom = effr?.targetFrom ?? null;
  const rangeTo = effr?.targetTo ?? null;
  const targetFrom: ValueCell =
    rangeFrom === null
      ? naCell(effrProvIdx)
      : { v: rangeFrom, st: 'closed', ts: effrTs, provIdx: effrProvIdx };
  const targetTo: ValueCell =
    rangeTo === null
      ? naCell(effrProvIdx)
      : { v: rangeTo, st: 'closed', ts: effrTs, provIdx: effrProvIdx };
  const targetMid: ValueCell =
    rangeFrom === null || rangeTo === null
      ? naCell(effrProvIdx)
      : {
          v: Math.round(((rangeFrom + rangeTo) / 2) * 1e8) / 1e8,
          st: 'closed',
          ts: effrTs,
          provIdx: effrProvIdx,
        };
  if (targetFrom.v === null) {
    ctx.unavailable.add({
      field: 'policy.targetRange',
      reason: 'NO_SOURCE',
      detail: 'no EFFR fixing with a target range is stored on or before this date',
    });
  }

  const meetings = await ctx.data.econ.fomc();
  const citeMeeting = (provenanceId: number | null): number => {
    if (provenanceId === null) return -1;
    return ctx.prov.add({
      sourceId: 'fed.fomc',
      provenanceId,
      capturedAt: ctx.asOf.knownAt,
      sourceTs: null,
      st: 'closed',
      tier: STORED_TIER,
    });
  };
  const past = meetings.filter((m) => m.meetingDate <= today);
  const future = meetings.filter((m) => m.meetingDate > today);
  const lastRaw = past[past.length - 1];
  const nextRaw = future[0];
  const lastMeeting: BtmmMeeting | null =
    lastRaw === undefined
      ? null
      : {
          meetingDate: lastRaw.meetingDate,
          statementAt: lastRaw.statementAt,
          hasSep: lastRaw.hasSep,
          decisionBp: lastRaw.decisionBp,
          provIdx: citeMeeting(lastRaw.provenanceId),
        };
  const nextMeeting: BtmmNextMeeting | null =
    nextRaw === undefined
      ? null
      : {
          meetingDate: nextRaw.meetingDate,
          statementAt: nextRaw.statementAt,
          hasSep: nextRaw.hasSep,
          // `decisionBp` before the meeting is null and is never estimated (§BTMM step 3).
          decisionBp: nextRaw.decisionBp,
          daysAway: Math.round(
            (Date.parse(`${nextRaw.meetingDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
              86_400_000,
          ),
          provIdx: citeMeeting(nextRaw.provenanceId),
        };

  const policy: BtmmPolicy = {
    targetFrom,
    targetTo,
    targetMid,
    effectiveDate: effr?.effectiveDate ?? null,
    lastMeeting,
    nextMeeting,
    iorb: { v: null, r: NO_IORB_SOURCE },
    discountWindow: { v: null, r: NO_DISCOUNT_WINDOW_SOURCE },
  };

  // ── step 4: the curve ─────────────────────────────────────────────────────────────────────
  const curveRead = await readCurve(ctx, params.curveId, params.compareDate);
  const curveStale =
    curveRead.points === null
      ? false
      : (businessDaysBetween(calendar, curveRead.points.curveDate, today) ?? 0) >
        CURVE_STALE_BUSINESS_DAYS;
  const curveCompareByTenor = new Map(
    (curveRead.compare?.points ?? []).map((p) => [`${p.tenor}|${p.quoteType}`, p]),
  );
  const curvePoints = [...(curveRead.points?.points ?? [])]
    .sort(byTenorDays)
    .map((point) =>
      curvePointRow({
        ctx,
        curveId: params.curveId,
        sourceId: curveRead.points?.sourceId ?? 'treasury.yieldcurve',
        point,
        compare: curveCompareByTenor.get(`${point.tenor}|${point.quoteType}`),
        stale: curveStale,
        terms: undefined,
      }),
    );
  const curve: BtmmCurveBlock = {
    curveId: params.curveId,
    curveDate: curveRead.points?.curveDate ?? null,
    compareDate: curveRead.compare?.curveDate ?? null,
    points: curvePoints,
    stale: curveStale,
  };
  if (curveRead.points === null) {
    ctx.unavailable.add({
      field: `curve.${params.curveId}`,
      reason: 'NO_SOURCE',
      detail: `no stored ${params.curveId} curve on or before ${today}`,
    });
  }
  if (curveStale) notes.push(CURVE_STALE);

  // The cross-source check of PROVIDERS §10.3 always needs the CMT curve, whichever curve the
  // user is looking at.
  const cmtRead =
    params.curveId === 'UST_CMT' ? curveRead : await readCurve(ctx, 'UST_CMT', params.compareDate);
  const cmtByTenor = new Map<string, CurvePointRow>();
  if (params.curveId === 'UST_CMT') {
    for (const row of curvePoints) cmtByTenor.set(row.tenor, row);
  } else {
    for (const point of cmtRead.points?.points ?? []) {
      cmtByTenor.set(
        point.tenor,
        curvePointRow({
          ctx,
          curveId: 'UST_CMT',
          sourceId: cmtRead.points?.sourceId ?? 'fed.h15',
          point,
          compare: undefined,
          stale: false,
          terms: undefined,
        }),
      );
    }
  }

  // ── step 5: bills ─────────────────────────────────────────────────────────────────────────
  const billRead = await readCurve(ctx, 'UST_BILL', params.compareDate);
  const billIds = [
    ...new Set(
      (billRead.points?.points ?? [])
        .map((p) => p.instrumentId)
        .filter((id): id is number => id !== null),
    ),
  ];
  const terms = await billTerms(ctx, billIds);
  const billCompareByTenor = new Map(
    (billRead.compare?.points ?? []).map((p) => [`${p.tenor}|${p.quoteType}`, p]),
  );
  const billPoints = [...(billRead.points?.points ?? [])].sort(byTenorDays).map((point) =>
    curvePointRow({
      ctx,
      curveId: 'UST_BILL',
      sourceId: billRead.points?.sourceId ?? 'treasury.bills',
      point,
      compare: billCompareByTenor.get(`${point.tenor}|${point.quoteType}`),
      stale: false,
      terms: point.instrumentId === null ? undefined : terms.get(point.instrumentId),
    }),
  );
  const bills: BtmmBillsBlock = {
    curveDate: billRead.points?.curveDate ?? null,
    compareDate: billRead.compare?.curveDate ?? null,
    points: billPoints,
  };

  // ── step 6: spreads ───────────────────────────────────────────────────────────────────────
  const spreadInputs: SpreadInputs = {
    curve: new Map(curvePoints.map((p) => [p.tenor, p])),
    cmt: cmtByTenor,
    bills: new Map(billPoints.map((p) => [`${p.tenor}|${p.quoteType}`, p])),
    rates: rateRows,
    targetMid,
  };
  const spreads = BTMM_SPREADS.map((def) => spreadOf(ctx, def, spreadInputs, params.spreadUnits));

  // ── step 7: context ───────────────────────────────────────────────────────────────────────
  const context = {
    fx: await contextRows(ctx, BTMM_CONTEXT_FX),
    indices: await contextRows(ctx, BTMM_CONTEXT_INDICES),
  };

  // ── step 8: the standing gaps ─────────────────────────────────────────────────────────────
  ctx.unavailable.add({ field: 'policy.iorb', reason: 'NO_SOURCE', detail: BTMM_IORB_DETAIL });
  ctx.unavailable.add({
    field: 'policy.discountWindow',
    reason: 'NO_SOURCE',
    detail: BTMM_DISCOUNT_WINDOW_DETAIL,
  });
  notes.push(NO_IORB_SOURCE, NO_DISCOUNT_WINDOW_SOURCE);
  if (params.section === 'ALL' || params.section === 'POLICY') {
    ctx.unavailable.add({
      field: 'policy.impliedPath',
      reason: 'NO_SOURCE',
      detail: BTMM_IMPLIED_PATH_DETAIL,
    });
    notes.push(NO_FED_FUNDS_FUTURES);
  }

  return {
    variant: 'default',
    section: params.section,
    policy,
    overnight,
    bills,
    curve,
    spreads,
    context,
    notes,
  };
}

/** Exported for the manifest's column helper and the screen; `monitorColumn` is the single source. */
export const BTMM_CONTEXT_COLUMNS = CONTEXT_FIELDS.map((f) => monitorColumn(f));
