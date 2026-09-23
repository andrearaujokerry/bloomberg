/**
 * `functions/DES/resolve.ts` — Security Description, all eight variants
 * (FUNCTIONS_TIER1.md §DES L107-379, FUNCTIONS.md §6 L1076).
 *
 * DES is the reason `FunctionManifest.variants` exists (FUNC-02): nine asset classes, eight
 * entirely different screens, one code. The runner asserts `payload.variant` against the
 * manifest's map at step 7, so a resolver that returned the wrong block for a class fails the run
 * instead of rendering the wrong screen.
 *
 * Five decisions are worth stating, because each one had an easier wrong answer.
 *
 *  1. **Provenance is re-cited by `provenance_id`, never copied from a reader's `provIdx`.**
 *     `routes/functions.ts` builds the `DataServices` over its *own* `ProvenanceIndex` and
 *     `buildContext` builds `ctx.prov` over another, so `SeriesBlock.provIdx` and
 *     `InstrumentDetail.provIdx` index a list that is **not** `meta.provenance`. Copying one into a
 *     cell would attribute a number to whatever happens to sit at that index. {@link citeMany}
 *     therefore reads `provenance` once per run for every id the blocks name and registers each
 *     through `ctx.prov.add`, which is the collector the runner publishes — and, as a side effect,
 *     guarantees the runner's `assertProvenanceExists` check passes by construction.
 *  2. **A read-through failure degrades, it never fails the screen.** `ctx.providers.ensure`
 *     throws `ProviderUnavailableError` when the circuit is open (or, as in every test and every
 *     `PROVIDER_MODE=replay` run, when no route is wired) *and* nothing is stored. DES's job is to
 *     describe a security, which the tables can do without a fresh quote: the ensure is a
 *     freshness attempt, so it is wrapped and its failure leaves the plant cells pending (§0.4
 *     rule 1) rather than turning a reference screen into a 503.
 *  3. **`tab` is ignored.** Every block is in the payload regardless, so a tab switch is one
 *     `fn.param` usage row served from the plant and the open transaction (§DES L131).
 *  4. **Nothing is computed on raw calendar days.** Period statistics go through
 *     `shared/returns.ts#periodReturns` with the venue's calendar, and a venue with no seeded
 *     calendar loses its returns with `NO_CALENDAR_FOR_VENUE` rather than gaining wrong ones
 *     (§0.6).
 *  5. **Every gap is a `null` plus a reason.** There is no fabricated number anywhere in this
 *     file: a missing curve point, a missing fixing, a missing XBRL fact and a never-polled
 *     subject each produce a null cell and a `meta.unavailable` entry (FUNCTIONS.md §1.3 rule 6).
 */

import { sql } from 'drizzle-orm';

import type { AssetClass, FieldId, ValueCell } from '@terminal/core';
import { canonicalJson, sha256Hex } from '@terminal/core';
import type {
  DesCalendarBlock,
  DesEconPayload,
  DesEquityFundamentals,
  DesEquityPayload,
  DesFilingRow,
  DesFxPayload,
  DesGovtPayload,
  DesIdentifierRow,
  DesIndexPayload,
  DesIssuerBlock,
  DesListingRow,
  DesMembershipRow,
  DesOptionPayload,
  DesParams,
  DesPayload,
  DesQuoteBlock,
  DesRatePayload,
  DesStatsBlock,
} from '@terminal/core/functions/manifests/DES';
import type { NewsRow } from '@terminal/core/functions/shared/news';
import { bill } from '@terminal/core/analytics/bill';
import type { BondTerms, CouponFrequency } from '@terminal/core/analytics/bond/cashflows';
import { priceFromYield } from '@terminal/core/analytics/bond/price';
import { bondRisk } from '@terminal/core/analytics/bond/risk';
import { addBusinessDays } from '@terminal/core/calendars/calendar';
import type { Calendar } from '@terminal/core/calendars/calendar';

import type { InstrumentDetail } from '../../data/reference.js';
import type {
  FunctionResolver,
  FunctionServerModule,
  GatedQuoteState,
  ReadThroughKind,
  ResolveContext,
} from '../context.js';
import { cellFromState, pendingCell, storedCell } from '../shared/cells.js';
import { toSummary } from '../shared/instrumentSummary.js';
import type { PeriodBar } from '../shared/returns.js';
import { beta1y, periodReturns, recordPeriodMeta, venueCalendar } from '../shared/returns.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small shared helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `'YYYY-MM-DD'` of an instant, UTC. */
function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `n` calendar days before an ISO day. */
function minusDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

/** Whole calendar days between two ISO days (`to − from`). */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  );
}

/** A `numeric` column as Postgres returned it, or `null`. Never `NaN`. */
function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Epoch ms of an ISO day at midnight UTC — the `ts` a session-dated cell carries. */
function dayMs(day: string | null): number | null {
  return day === null ? null : Date.parse(`${day}T00:00:00.000Z`);
}

/** A cell that is absent for a stated reason. The caller adds the `meta.unavailable` half. */
function naCell(provIdx = -1): ValueCell {
  return { v: null, st: 'na', provIdx };
}

/** `ANAL-08`'s `inputsHash`, computed the way every other side computes it. */
function inputsHash(inputs: unknown): string {
  return sha256Hex(canonicalJson(inputs));
}

/**
 * Register every `provenance_id` a reader handed back, in one statement, and return
 * `provenance_id → meta.provenance` index.
 *
 * See decision 1 in the header: a data service's own `provIdx` indexes a different list. The rows
 * are registered in the order the caller named them, so the indices are a function of the payload
 * and not of the planner's row order — which is what makes the goldens stable.
 */
async function citeMany(
  ctx: ResolveContext,
  ids: readonly (number | null | undefined)[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const want: number[] = [];
  for (const id of ids) {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) continue;
    if (!want.includes(id)) want.push(id);
  }
  if (want.length === 0) return out;

  const list = sql.join(
    want.map((id) => sql`${String(id)}::bigint`),
    sql`, `,
  );
  const res = await ctx.db.execute<{
    provenance_id: string;
    source_id: string;
    captured_at: string;
    source_ts: string | null;
  }>(sql`
    SELECT provenance_id::text AS provenance_id, source_id,
           to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
           to_char(source_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS source_ts
      FROM provenance
     WHERE provenance_id IN (${list})`);

  const rows = new Map(res.rows.map((row) => [Number(row.provenance_id), row]));
  for (const id of want) {
    const row = rows.get(id);
    if (row === undefined) continue;
    out.set(
      id,
      ctx.prov.add({
        sourceId: row.source_id,
        provenanceId: id,
        capturedAt: new Date(row.captured_at),
        sourceTs: row.source_ts === null ? null : new Date(row.source_ts),
        st: 'closed',
        tier: 'eod',
      }),
    );
  }
  return out;
}

/**
 * One freshness attempt that cannot fail the screen (decision 2).
 *
 * `ensure` throws when the circuit is open and nothing is stored, and that is exactly the state a
 * replay run or a test without a wired route is in. DES answers from the tables either way.
 */
async function tryEnsure(
  ctx: ResolveContext,
  kind: ReadThroughKind,
  key: string,
  maxAgeMs: number,
): Promise<void> {
  if (ctx.usage === 'export') return;
  if (key.trim() === '') return;
  try {
    await ctx.providers.ensure(kind, key, { maxAgeMs });
  } catch {
    // The plant cell stays pending / the stored row stays what it is, and the block that needed
    // the data reports its own gap. Nothing is invented here.
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The prologue every variant runs (§DES L246)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** §0.6 / §DES L246: the calendar a class is described on, before any database is consulted. */
function fixedCalendarFor(assetClass: AssetClass): string | null {
  switch (assetClass) {
    case 'fx':
      return 'FX_USD';
    case 'crypto':
      return 'WEEKEND';
    case 'govt':
    case 'rate':
      return 'SIFMA';
    case 'econ':
      return 'USGOVT';
    default:
      return null;
  }
}

interface Prologue {
  detail: InstrumentDetail;
  instrument: ReturnType<typeof toSummary>;
  calendar: DesCalendarBlock;
  /** The materialised calendar, `null` when the id has no seeded rows. */
  cal: Calendar | null;
  /** What to name in `no calendar seeded for <label>`. */
  venueLabel: string;
  /** `provenance_id → meta.provenance` index for every reference row of the detail. */
  cite: Map<number, number>;
  /** The instrument row's own citation — the block index every reference block carries. */
  refIdx: number;
  asOfDate: string;
}

async function prologue(ctx: ResolveContext): Promise<Prologue> {
  const instrumentRow = ctx.instrument;
  if (instrumentRow === null) {
    throw new Error('DES: requiresSecurity is true, so the runner must supply an instrument');
  }
  const detail = await ctx.data.reference.instrument(instrumentRow.instrumentId);
  const assetClass = detail.instrument.assetClass;

  const fixed = fixedCalendarFor(assetClass);
  let calendarId: string | null = fixed;
  let venueLabel = fixed ?? 'this venue';
  if (fixed === null) {
    const venue = await venueCalendar(ctx, detail);
    calendarId = venue.calendarId;
    venueLabel = venue.label;
  }

  const cal =
    calendarId === null ? null : await ctx.data.reference.calendar(calendarId).catch(() => null);
  if (cal === null) {
    ctx.unavailable.add({
      field: 'calendar',
      reason: 'NO_SOURCE',
      detail: `no calendar seeded for ${venueLabel}`,
    });
  }

  // Every reference row of the detail, cited once. The instrument row leads, so `refIdx` is the
  // first entry of `meta.provenance` on every DES payload.
  const cite = await citeMany(ctx, [
    detail.instrument.provenanceId,
    detail.issue?.provenanceId,
    detail.issuer?.provenanceId,
    detail.terms?.terms.provenanceId,
    ...detail.listings.map((l) => l.provenanceId),
    ...detail.identifiers.map((i) => i.provenanceId),
    ...detail.classifications.map((c) => c.provenanceId),
  ]);

  return {
    detail,
    instrument: toSummary(detail),
    calendar: { calendarId: calendarId ?? '', tz: cal?.tz ?? '' },
    cal,
    venueLabel,
    cite,
    refIdx: cite.get(detail.instrument.provenanceId) ?? -1,
    asOfDate: utcDate(ctx.asOf.validAt),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reference blocks shared by several variants
// ─────────────────────────────────────────────────────────────────────────────────────────────

function identifierRows(p: Prologue): DesIdentifierRow[] {
  return [...p.detail.identifiers]
    .sort((a, b) =>
      a.scheme === b.scheme
        ? a.value < b.value
          ? -1
          : a.value > b.value
            ? 1
            : 0
        : a.scheme < b.scheme
          ? -1
          : 1,
    )
    .map((row) => ({
      scheme: row.scheme,
      value: row.value,
      qualifier: row.qualifier,
      isPrimary: row.isPrimary,
      validFrom: row.validFrom,
    }));
}

function listingRows(p: Prologue): DesListingRow[] {
  return [...p.detail.listings]
    .sort((a, b) => a.listingId - b.listingId)
    .map((listing) => ({
      listingId: listing.listingId,
      figi: listing.figi ?? null,
      mic: listing.mic ?? null,
      exchCode: listing.exchCode,
      localTicker: listing.localTicker,
      isPrimary: listing.isPrimary,
      listingStatus: listing.listingStatus,
      mdLines: p.detail.mdLines
        .filter((line) => line.listingId === listing.listingId)
        .sort((a, b) => a.mdLineId - b.mdLineId)
        .map((line) => ({
          mdLineId: line.mdLineId,
          sourceId: line.sourceId,
          providerSymbol: line.providerSymbol,
          lineKind: line.lineKind,
          intrinsicDelayMin: line.intrinsicDelayMin,
        })),
    }));
}

/** The GICS / SIC view of the issuer's classifications, by scheme and level. */
function classified(
  p: Prologue,
  scheme: string,
  level: number,
): { code: string; name: string | null } | null {
  const issuerId = p.detail.issuer?.issuerId;
  if (issuerId === undefined) return null;
  const row = p.detail.classifications.find(
    (c) =>
      c.entityKind === 'issuer' &&
      c.entityId === issuerId &&
      c.scheme === scheme &&
      c.level === level,
  );
  return row === undefined ? null : { code: row.code, name: row.name };
}

function issuerBlock(ctx: ResolveContext, p: Prologue): DesIssuerBlock {
  const issuer = p.detail.issuer;
  if (issuer === null) {
    ctx.unavailable.add({
      field: 'issuer',
      reason: 'NO_SOURCE',
      detail: 'the instrument has no issuer row at this asOf',
    });
    return {
      issuerId: -1,
      name: p.detail.instrument.name,
      legalName: null,
      cik: null,
      lei: null,
      sicCode: null,
      sicDescription: null,
      gicsSector: null,
      gicsIndustryGroup: null,
      gicsSubIndustry: null,
      countryOfIncorp: null,
      stateOfInc: null,
      fiscalYearEnd: null,
      filerCategory: null,
      entityType: 'other',
      formerNames: [],
      website: null,
      provIdx: p.refIdx,
    };
  }
  return {
    issuerId: issuer.issuerId,
    name: issuer.name,
    legalName: issuer.legalName ?? null,
    cik: issuer.cik ?? null,
    lei: issuer.lei ?? null,
    sicCode: issuer.sic ?? null,
    sicDescription: issuer.sicDescription ?? null,
    gicsSector: classified(p, 'GICS', 1)?.name ?? null,
    gicsIndustryGroup: classified(p, 'GICS', 2)?.name ?? null,
    gicsSubIndustry: classified(p, 'GICS', 4)?.name ?? null,
    countryOfIncorp: issuer.country ?? null,
    stateOfInc: issuer.stateOfInc ?? null,
    fiscalYearEnd: issuer.fiscalYearEnd ?? null,
    filerCategory: issuer.filerCategory ?? null,
    entityType: issuer.entityType,
    formerNames: issuer.formerNames.map((n) => ({
      name: n.name,
      from: n.from ?? '',
      to: n.to ?? null,
    })),
    website: issuer.website ?? null,
    provIdx: p.cite.get(issuer.provenanceId) ?? p.refIdx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The quote block (§0.4 rule 1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `DesQuoteBlock` member → the dictionary field it renders. */
const QUOTE_FIELDS = {
  px: 'PX_LAST',
  chgNet: 'CHG_NET_1D',
  chgPct: 'CHG_PCT_1D',
  open: 'PX_OPEN',
  high: 'PX_HIGH',
  low: 'PX_LOW',
  prevClose: 'PX_CLOSE_1D',
  volume: 'PX_VOLUME',
  bid: 'PX_BID',
  ask: 'PX_ASK',
  bidSize: 'BID_SIZE',
  askSize: 'ASK_SIZE',
  lastTradeTime: 'LAST_TRADE_TIME',
  ivol30d: 'IVOL_30D',
  sessionState: 'SESSION_STATE',
} as const satisfies Record<keyof DesQuoteBlock, FieldId>;

function quoteBlock(
  ctx: ResolveContext,
  state: GatedQuoteState | undefined,
  subject: string,
): DesQuoteBlock {
  const out = {} as Record<keyof DesQuoteBlock, ValueCell>;
  for (const [key, field] of Object.entries(QUOTE_FIELDS) as [keyof DesQuoteBlock, FieldId][]) {
    out[key] = cellFromState(ctx, state, field, subject);
  }
  return out;
}

/**
 * The composite for a single-security screen, after at most one read-through (§0.4 rule 2).
 *
 * A blank subject is worth one provider call because the screen is showing one security; a monitor
 * gets none. When the call cannot be made the cells stay pending, which is the honest answer.
 */
async function snapshotWithEnsure(
  ctx: ResolveContext,
  p: Prologue,
  route: { kind: ReadThroughKind; maxAgeMs: number; sourceId: string } | null,
): Promise<{ subject: string; state: GatedQuoteState | undefined }> {
  const id = p.detail.instrument.instrumentId;
  const subject = ctx.plant.subjectFor(id);
  ctx.plant.ensureHot([subject]);

  let state = ctx.plant.snapshot(subject);
  const cold = state === undefined || state.state === 'blank';
  if (cold && route !== null) {
    const line = p.detail.mdLines.find((l) => l.sourceId === route.sourceId) ?? p.detail.mdLines[0];
    if (line !== undefined) {
      await tryEnsure(ctx, route.kind, line.providerSymbol, route.maxAgeMs);
      state = ctx.plant.snapshot(subject);
    }
  }
  if (state === undefined) {
    ctx.unavailable.add({
      field: 'quote',
      reason: 'NO_SOURCE',
      detail: 'the plant holds no quote for this security yet — the scheduler polls it next',
    });
  }
  return { subject, state };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The stats block (§0.6, §DES step 2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** How far back the bar window reaches: 400 calendar days covers 252 sessions plus holidays. */
const BAR_WINDOW_DAYS = 400;

interface BarSeries {
  bars: PeriodBar[];
  /** `meta.provenance` index of the row that supplied the last bar. */
  provIdx: number;
  lastDate: string | null;
}

async function loadBars(ctx: ResolveContext, id: number, asOfDate: string): Promise<BarSeries> {
  let block;
  try {
    block = await ctx.data.historical.bars(id, {
      start: minusDays(asOfDate, BAR_WINDOW_DAYS),
      end: asOfDate,
      periodicity: 'D',
      adjust: 'price',
      fields: ['PX_LAST', 'PX_HIGH', 'PX_LOW', 'PX_VOLUME'],
    });
  } catch {
    // A bar read that cannot be served is a missing history, not a failed screen.
    return { bars: [], provIdx: -1, lastDate: null };
  }

  const at = (field: FieldId): number => block.columns.indexOf(field);
  const close = at('PX_LAST');
  const high = at('PX_HIGH');
  const low = at('PX_LOW');
  const volume = at('PX_VOLUME');
  const bars: PeriodBar[] = [];
  for (let i = 0; i < block.index.length; i += 1) {
    const row = block.rows[i];
    const date = block.index[i];
    if (row === undefined || date === undefined) continue;
    bars.push({
      date,
      close: close < 0 ? null : (row[close] ?? null),
      high: high < 0 ? null : (row[high] ?? null),
      low: low < 0 ? null : (row[low] ?? null),
      volume: volume < 0 ? null : (row[volume] ?? null),
    });
  }

  const lastProvenanceId = block.rowProvenanceIds[block.rowProvenanceIds.length - 1];
  const cite = await citeMany(ctx, [lastProvenanceId]);
  return {
    bars,
    provIdx: lastProvenanceId === undefined ? -1 : (cite.get(lastProvenanceId) ?? -1),
    lastDate: bars[bars.length - 1]?.date ?? null,
  };
}

/** The `SPX Index` benchmark §0.6 measures beta against, when the master carries one. */
async function benchmarkId(ctx: ResolveContext): Promise<number | null> {
  const res = await ctx.db.execute<{ instrument_id: string }>(sql`
    SELECT instrument_id::text AS instrument_id
      FROM instruments
     WHERE ticker = 'SPX' AND asset_class = 'index'
       AND tx_to = 'infinity' AND valid_to = 'infinity'
     ORDER BY instrument_id
     LIMIT 1`);
  const row = res.rows[0];
  return row === undefined ? null : Number(row.instrument_id);
}

async function statsBlock(ctx: ResolveContext, p: Prologue): Promise<DesStatsBlock> {
  const id = p.detail.instrument.instrumentId;
  const series = await loadBars(ctx, id, p.asOfDate);

  const blank = (): DesStatsBlock => ({
    high52w: naCell(),
    low52w: naCell(),
    avgVolume30d: naCell(),
    vol30d: naCell(),
    ret1d: naCell(),
    ret1w: naCell(),
    ret1m: naCell(),
    retYtd: naCell(),
    ret1y: naCell(),
    beta1y: naCell(),
    barsAsOf: null,
  });

  if (series.bars.length < 2) {
    ctx.unavailable.add({
      field: 'stats',
      reason: 'NO_SOURCE',
      detail: 'no daily bars for instrument',
    });
    return blank();
  }

  const values = periodReturns(series.bars, p.cal, p.asOfDate, p.venueLabel);
  recordPeriodMeta(ctx, values);
  const ts = dayMs(series.lastDate);
  const cell = (v: number | null): ValueCell =>
    v === null ? naCell(series.provIdx) : storedCell({ v, provIdx: series.provIdx, ts });

  // Beta needs the benchmark's own history over the same sessions; §0.6's 200-session floor and
  // the missing-benchmark case are both `null` with the reason, never a short-window number.
  let betaCell = naCell(series.provIdx);
  const benchmark = await benchmarkId(ctx);
  if (benchmark === null || benchmark === id) {
    ctx.unavailable.add({
      field: 'stats.beta1y',
      reason: 'NO_SOURCE',
      detail: "no 'SPX Index' benchmark history is seeded for the beta regression",
    });
  } else {
    const bench = await loadBars(ctx, benchmark, p.asOfDate);
    const result = beta1y(series.bars, bench.bars, p.cal, p.asOfDate, p.venueLabel);
    recordPeriodMeta(ctx, result);
    betaCell =
      result.beta1y === null
        ? naCell(series.provIdx)
        : storedCell({ v: result.beta1y, provIdx: series.provIdx, ts });
  }

  return {
    high52w: cell(values.high52w),
    low52w: cell(values.low52w),
    avgVolume30d: cell(values.avgVolume30d),
    vol30d: cell(values.vol30d),
    ret1d: cell(values.ret1d),
    ret1w: cell(values.ret1w),
    ret1m: cell(values.ret1m),
    retYtd: cell(values.retYtd),
    ret1y: cell(values.ret1y),
    beta1y: betaCell,
    barsAsOf: values.asOfSession,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// equity (and etf) — §DES steps 1-11
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SEC_SUBMISSIONS_MAX_AGE_MS = 6 * 3_600_000;
const SEC_FACTS_MAX_AGE_MS = 24 * 3_600_000;

async function filingRows(
  ctx: ResolveContext,
  cik: string | null,
  limit: number,
): Promise<DesFilingRow[]> {
  if (cik === null) {
    ctx.unavailable.add({
      field: 'filings',
      reason: 'NOT_APPLICABLE',
      detail: 'issuer has no CIK',
    });
    return [];
  }
  await tryEnsure(ctx, 'sec.submissions', cik, SEC_SUBMISSIONS_MAX_AGE_MS);
  const page = await ctx.data.filings.list(cik, { limit });
  const cite = await citeMany(
    ctx,
    page.items.map((f) => f.provenanceId),
  );
  if (page.items.length === 0) {
    ctx.unavailable.add({
      field: 'filings',
      reason: 'NO_SOURCE',
      detail: `no filings ingested for CIK ${cik}`,
    });
  }
  return page.items.map((f) => ({
    accessionNo: f.accessionNo,
    form: f.form,
    filedDate: f.filedDate,
    reportDate: f.reportDate,
    acceptedAt: f.acceptedAt,
    items: [...f.items],
    primaryDocDesc: f.primaryDocDesc,
    url: f.url,
    isXbrl: f.isXbrl,
    provIdx: cite.get(f.provenanceId) ?? -1,
  }));
}

/**
 * The next reporting date, projected from the issuer's own filing cadence (§DES step 6).
 *
 * BRIEF §2: there is no licensed consensus or estimates source in v1, so this is never an
 * "estimate" in the analyst sense — it is arithmetic over `filed_date`, labelled `method` so a
 * screen can say where it came from. Fewer than one periodic filing and the answer is `null`.
 */
function nextEarningsOf(filings: readonly DesFilingRow[]): DesEquityFundamentals['nextEarnings'] {
  const periodic = filings
    .filter((f) => f.form === '10-Q' || f.form === '10-K')
    .map((f) => f.filedDate)
    .sort()
    .slice(-8);
  if (periodic.length === 0) return null;

  const last = periodic[periodic.length - 1]!;
  let gapDays: number;
  let method: 'cadence' | 'prior_year';
  if (periodic.length >= 3) {
    const gaps: number[] = [];
    for (let i = 1; i < periodic.length; i += 1)
      gaps.push(daysBetween(periodic[i - 1]!, periodic[i]!));
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    gapDays = gaps.length % 2 === 1 ? gaps[mid]! : Math.round((gaps[mid - 1]! + gaps[mid]!) / 2);
    method = 'cadence';
  } else {
    gapDays = 365;
    method = 'prior_year';
  }
  const expected = new Date(Date.parse(`${last}T00:00:00.000Z`) + gapDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    expectedDate: expected,
    window: [minusDays(expected, 7), minusDays(expected, -7)],
    method,
    estimated: true,
  };
}

type DividendRow = {
  ex_date: string;
  pay_date: string | null;
  amount: string | null;
  currency: string | null;
  status: string;
  provenance_id: string;
};

async function fundamentalsBlock(
  ctx: ResolveContext,
  p: Prologue,
  quote: DesQuoteBlock,
  filings: readonly DesFilingRow[],
): Promise<DesEquityFundamentals> {
  const id = p.detail.instrument.instrumentId;
  const cik = p.detail.issuer?.cik ?? null;
  const px = typeof quote.px.v === 'number' ? quote.px.v : null;

  let sharesOut: ValueCell = naCell();
  let sharesOutAsOf: string | null = null;
  let publicFloat: ValueCell = naCell();
  let epsTtmDil: ValueCell = naCell();
  let revenueTtm: ValueCell = naCell();
  let netIncomeTtm: ValueCell = naCell();
  let statementsAsOf: DesEquityFundamentals['statementsAsOf'] = null;

  if (cik === null) {
    ctx.unavailable.add({
      field: 'fundamentals',
      reason: 'NOT_APPLICABLE',
      detail: 'issuer has no CIK',
    });
  } else {
    await tryEnsure(ctx, 'sec.companyfacts', cik, SEC_FACTS_MAX_AGE_MS);

    const facts = await ctx.data.fundamentals.facts(
      {
        cik,
        concepts: ['dei:EntityCommonStockSharesOutstanding', 'dei:EntityPublicFloat'],
        periods: 'instant',
      },
      ctx.asOf.knownAt,
    );
    const statements = await ctx.data.fundamentals.statementsForCik(cik, {
      periodType: 'TTM',
      periods: 1,
      knownAt: ctx.asOf.knownAt,
    });
    const ttm = statements[0] ?? null;

    const cite = await citeMany(ctx, [
      ...facts.map((f) => f.provenanceId),
      ...(ttm?.provenanceIds ?? []),
    ]);

    const shares = facts.find((f) => f.concept.endsWith('EntityCommonStockSharesOutstanding'));
    const float = facts.find((f) => f.concept.endsWith('EntityPublicFloat'));
    if (shares !== undefined) {
      sharesOut = storedCell({
        v: shares.value,
        provIdx: cite.get(shares.provenanceId) ?? -1,
        ts: dayMs(shares.filedAt),
      });
      sharesOutAsOf = shares.periodEnd;
    }
    if (float !== undefined) {
      publicFloat = storedCell({
        v: float.value,
        provIdx: cite.get(float.provenanceId) ?? -1,
        ts: dayMs(float.filedAt),
      });
    }

    if (ttm === null) {
      ctx.unavailable.add({
        field: 'fundamentals',
        reason: 'NO_SOURCE',
        detail: `no XBRL facts ingested for CIK ${cik}`,
      });
    } else {
      const idx = cite.get(ttm.provenanceIds[0] ?? -1) ?? -1;
      const ts = dayMs(ttm.filedAt);
      const statementCell = (v: number | null): ValueCell =>
        v === null ? naCell(idx) : storedCell({ v, provIdx: idx, ts });
      epsTtmDil = statementCell(ttm.epsDil);
      revenueTtm = statementCell(ttm.revenue);
      netIncomeTtm = statementCell(ttm.netInc);
      statementsAsOf = {
        periodEnd: ttm.periodEnd,
        filedAt: ttm.filedAt,
        accessionNo: ttm.accessionNo,
      };
    }
    if (shares === undefined || float === undefined) {
      ctx.unavailable.add({
        field: 'fundamentals.shares',
        reason: 'NO_SOURCE',
        detail: `no dei share-count facts ingested for CIK ${cik}`,
      });
    }
  }

  // Derived cells cite the provenance of their primary input (§0.4 rule 4). `mktCap` follows the
  // live `px` cell, which is why the screen can recompute it on every tick without a re-resolve.
  const shareCount = typeof sharesOut.v === 'number' ? sharesOut.v : null;
  const mktCap: ValueCell =
    px === null || shareCount === null
      ? naCell(quote.px.provIdx)
      : storedCell({ v: px * shareCount, provIdx: quote.px.provIdx, ts: quote.px.ts ?? null });
  if (mktCap.v === null) {
    ctx.unavailable.add({
      field: 'fundamentals.mktCap',
      reason: 'NO_SOURCE',
      detail: 'market cap needs a last price and a share count; one of them is absent',
    });
  }

  const eps = typeof epsTtmDil.v === 'number' ? epsTtmDil.v : null;
  const peTtm: ValueCell =
    px === null || eps === null || eps <= 0
      ? naCell(quote.px.provIdx)
      : storedCell({ v: px / eps, provIdx: quote.px.provIdx, ts: quote.px.ts ?? null });
  if (peTtm.v === null) {
    ctx.unavailable.add({
      field: 'fundamentals.peTtm',
      reason: 'NOT_APPLICABLE',
      detail: 'P/E needs a last price and a positive diluted TTM EPS',
    });
  }

  // Dividends (§DES step 5): the trailing twelve months of cash distributions, as-of.
  const res = await ctx.db.execute<DividendRow>(sql`
    SELECT to_char(ex_date, 'YYYY-MM-DD') AS ex_date,
           to_char(pay_date, 'YYYY-MM-DD') AS pay_date,
           amount::text AS amount, currency, status::text AS status,
           provenance_id::text AS provenance_id
      FROM corporate_actions
     WHERE instrument_id = ${String(id)}::bigint
       AND ca_type IN ('cash_dividend', 'special_dividend')
       AND status IN ('announced', 'confirmed', 'paid')
       AND ex_date >= ${minusDays(p.asOfDate, 365)}::date
       AND ex_date <= ${p.asOfDate}::date
       AND tx_to = 'infinity' AND valid_to = 'infinity'
     ORDER BY ex_date DESC`);

  const dividends = res.rows;
  const divCite = await citeMany(
    ctx,
    dividends.map((d) => Number(d.provenance_id)),
  );
  const total = dividends.reduce((sum, d) => sum + (num(d.amount) ?? 0), 0);
  const newest = dividends[0];
  const divIdx =
    newest === undefined ? p.refIdx : (divCite.get(Number(newest.provenance_id)) ?? -1);

  const dvdSh12m = storedCell({ v: total, provIdx: divIdx });
  const dvdYield: ValueCell =
    px === null || px === 0
      ? naCell(quote.px.provIdx)
      : storedCell({ v: (total / px) * 100, provIdx: quote.px.provIdx, ts: quote.px.ts ?? null });
  if (dvdYield.v === null) {
    ctx.unavailable.add({
      field: 'fundamentals.dvdYield',
      reason: 'NO_SOURCE',
      detail: 'the dividend yield needs a last price',
    });
  }

  const lastDividend =
    newest === undefined || num(newest.amount) === null
      ? null
      : {
          exDate: newest.ex_date,
          payDate: newest.pay_date,
          amount: num(newest.amount)!,
          currency: (newest.currency ?? p.detail.instrument.currency).trim(),
          status: newest.status,
          provIdx: divIdx,
        };
  if (lastDividend === null) {
    ctx.unavailable.add({
      field: 'fundamentals.lastDividend',
      reason: 'NO_SOURCE',
      detail: 'no cash distribution with an ex-date in the trailing 365 days',
    });
  }

  // Short interest (§DES step 7).
  const siRes = await ctx.db.execute<{
    settlement_date: string;
    short_qty: string | null;
    days_to_cover: string | null;
    change_pct: string | null;
    provenance_id: string;
  }>(sql`
    SELECT to_char(settlement_date, 'YYYY-MM-DD') AS settlement_date,
           short_qty::text AS short_qty, days_to_cover::text AS days_to_cover,
           change_pct::text AS change_pct, provenance_id::text AS provenance_id
      FROM short_interest
     WHERE instrument_id = ${String(id)}::bigint AND settlement_date <= ${p.asOfDate}::date
     ORDER BY settlement_date DESC
     LIMIT 1`);
  const siRow = siRes.rows[0];
  let shortInterest: DesEquityFundamentals['shortInterest'] = null;
  if (siRow === undefined || num(siRow.short_qty) === null) {
    ctx.unavailable.add({
      field: 'fundamentals.shortInterest',
      reason: 'NO_SOURCE',
      detail: 'no FINRA consolidated short-interest row on or before this date',
    });
  } else {
    const siCite = await citeMany(ctx, [Number(siRow.provenance_id)]);
    shortInterest = {
      settlementDate: siRow.settlement_date,
      shortQty: num(siRow.short_qty)!,
      daysToCover: num(siRow.days_to_cover),
      changePct: num(siRow.change_pct),
      provIdx: siCite.get(Number(siRow.provenance_id)) ?? -1,
    };
  }

  const nextEarnings = nextEarningsOf(filings);
  if (nextEarnings === null) {
    ctx.unavailable.add({
      field: 'nextEarnings',
      reason: 'NO_SOURCE',
      detail: 'no estimates source; no filing cadence available',
    });
  }

  return {
    sharesOut,
    sharesOutAsOf,
    publicFloat,
    mktCap,
    epsTtmDil,
    peTtm,
    revenueTtm,
    netIncomeTtm,
    dvdSh12m,
    dvdYield,
    lastDividend,
    nextEarnings,
    shortInterest,
    statementsAsOf,
  };
}

type MembershipSqlRow = {
  code: string;
  index_instrument_id: string;
  ticker: string;
  exch_code: string;
  market_sector: string;
  weight: string | null;
  shares: string | null;
  as_of_date: string;
  source_id: string;
  provenance_id: string;
};

async function membershipRows(ctx: ResolveContext, p: Prologue): Promise<DesMembershipRow[]> {
  const res = await ctx.db.execute<MembershipSqlRow>(sql`
    SELECT ix.code, ix.instrument_id::text AS index_instrument_id,
           i.ticker, i.exch_code, i.market_sector::text AS market_sector,
           im.weight::text AS weight, im.shares::text AS shares,
           to_char(im.as_of_date, 'YYYY-MM-DD') AS as_of_date,
           im.source_id, im.provenance_id::text AS provenance_id
      FROM index_members im
      JOIN indices ix ON ix.index_id = im.index_id
      LEFT JOIN instruments i ON i.instrument_id = ix.instrument_id
                             AND i.tx_to = 'infinity' AND i.valid_to = 'infinity'
     WHERE im.instrument_id = ${String(p.detail.instrument.instrumentId)}::bigint
       AND im.tx_to = 'infinity' AND im.valid_to = 'infinity'
     ORDER BY ix.code`);

  const cite = await citeMany(
    ctx,
    res.rows.map((r) => Number(r.provenance_id)),
  );
  return res.rows.map((row) => ({
    indexCode: row.code,
    indexInstrumentId: Number(row.index_instrument_id),
    indexKey: `${row.ticker} ${row.market_sector}`,
    weight: num(row.weight),
    shares: num(row.shares),
    asOfDate: row.as_of_date,
    sourceId: row.source_id,
    provIdx: cite.get(Number(row.provenance_id)) ?? -1,
  }));
}

async function newsRows(ctx: ResolveContext, id: number, limit: number): Promise<NewsRow[]> {
  const items = await ctx.data.news.top('instrument', String(id), limit);
  const cite = await citeMany(
    ctx,
    items.map((i) => i.provenanceId),
  );
  if (items.length === 0) {
    ctx.unavailable.add({
      field: 'news',
      reason: 'NO_SOURCE',
      detail: 'no headline is linked to this security at or above the 0.9 confidence floor',
    });
  }
  return items.map((item) => ({
    newsId: item.newsId,
    headline: item.headline,
    summary: item.summary,
    sourceId: item.sourceId as NewsRow['sourceId'],
    feed: item.feed,
    kind: item.kind,
    author: item.author,
    category: item.category,
    cik: item.cik,
    items8k: item.items8k,
    publishedAt: item.publishedAt,
    capturedAt: item.capturedAt,
    url: item.url,
    isCorrection: item.isCorrection,
    machineGenerated: false,
    links: item.links.map((l) => ({ ...l })),
    provIdx: cite.get(item.provenanceId) ?? -1,
  }));
}

async function fundBlock(ctx: ResolveContext, p: Prologue): Promise<DesEquityPayload['fund']> {
  const terms = p.detail.terms;
  if (terms?.kind !== 'fund') return null;
  const row = terms.terms;

  let trackedIndex: { instrumentId: number; key: string } | null = null;
  if (row.trackedIndexInstrumentId !== null) {
    const res = await ctx.db.execute<{ ticker: string; market_sector: string }>(sql`
      SELECT ticker, market_sector::text AS market_sector
        FROM instruments
       WHERE instrument_id = ${String(row.trackedIndexInstrumentId)}::bigint
         AND tx_to = 'infinity' AND valid_to = 'infinity'
       LIMIT 1`);
    const found = res.rows[0];
    trackedIndex =
      found === undefined
        ? null
        : {
            instrumentId: row.trackedIndexInstrumentId,
            key: `${found.ticker} ${found.market_sector}`,
          };
  }

  const holdings = await ctx.data.holdings
    .etfHoldings(p.detail.instrument.instrumentId)
    .catch(() => []);
  if (holdings.length === 0) {
    ctx.unavailable.add({
      field: 'fund.holdings',
      reason: 'NO_SOURCE',
      detail: 'no N-PORT or SSGA holdings file ingested for this fund',
    });
  }

  return {
    fundType: row.fundType,
    trackedIndex,
    sponsor: row.sponsor,
    expenseRatio: num(row.expenseRatio),
    inceptionDate: row.inceptionDate,
    holdingsAsOf: holdings[0]?.asOfDate ?? null,
    holdingsCount: holdings.length === 0 ? null : holdings.length,
    provIdx: p.cite.get(row.provenanceId) ?? p.refIdx,
  };
}

async function equity(ctx: ResolveContext, params: DesParams): Promise<DesPayload> {
  const p = await prologue(ctx);
  const { subject, state } = await snapshotWithEnsure(ctx, p, {
    kind: 'cboe.quote',
    maxAgeMs: 30_000,
    sourceId: 'cboe.quotes',
  });

  const quote = quoteBlock(ctx, state, subject);
  const stats = await statsBlock(ctx, p);
  const issuer = issuerBlock(ctx, p);
  const filings = await filingRows(ctx, issuer.cik, params.filingsLimit);
  const fundamentals = await fundamentalsBlock(ctx, p, quote, filings);
  const membership = await membershipRows(ctx, p);
  const news = await newsRows(ctx, p.detail.instrument.instrumentId, params.newsLimit);
  const fund = await fundBlock(ctx, p);

  return {
    variant: 'equity',
    instrument: p.instrument,
    issuer,
    fund,
    quote,
    stats,
    fundamentals,
    membership,
    filings,
    news,
    identifiers: identifierRows(p),
    listings: listingRows(p),
    calendar: p.calendar,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// index
// ─────────────────────────────────────────────────────────────────────────────────────────────

type IndexRegistryRow = {
  code: string;
  membership_source_id: string | null;
  provider: string;
  proxy_fund_instrument_id: string | null;
};

async function indexVariant(ctx: ResolveContext): Promise<DesPayload> {
  const p = await prologue(ctx);
  const id = p.detail.instrument.instrumentId;
  const { subject, state } = await snapshotWithEnsure(ctx, p, {
    kind: 'cboe.quote',
    maxAgeMs: 30_000,
    sourceId: 'cboe.quotes',
  });

  const full = quoteBlock(ctx, state, subject);
  const quote: DesIndexPayload['quote'] = {
    px: full.px,
    chgNet: full.chgNet,
    chgPct: full.chgPct,
    open: full.open,
    high: full.high,
    low: full.low,
    prevClose: full.prevClose,
    ivol30d: full.ivol30d,
    sessionState: full.sessionState,
  };

  const registry = await ctx.db.execute<IndexRegistryRow>(sql`
    SELECT code, membership_source_id, provider,
           proxy_fund_instrument_id::text AS proxy_fund_instrument_id
      FROM indices
     WHERE instrument_id = ${String(id)}::bigint
     LIMIT 1`);
  const reg = registry.rows[0] ?? null;

  const termsRow = p.detail.terms?.kind === 'index' ? p.detail.terms.terms : null;
  if (termsRow === null) {
    ctx.unavailable.add({
      field: 'terms',
      reason: 'NO_SOURCE',
      detail: 'no index_terms row for this index',
    });
  }

  let proxyFund: { instrumentId: number; key: string } | null = null;
  const registryProxy = reg?.proxy_fund_instrument_id ?? null;
  const proxyId =
    termsRow?.proxyFundInstrumentId ?? (registryProxy === null ? null : Number(registryProxy));
  if (proxyId !== null) {
    const res = await ctx.db.execute<{
      ticker: string;
      exch_code: string;
      market_sector: string;
    }>(sql`
      SELECT ticker, exch_code, market_sector::text AS market_sector
        FROM instruments
       WHERE instrument_id = ${String(proxyId)}::bigint
         AND tx_to = 'infinity' AND valid_to = 'infinity'
       LIMIT 1`);
    const row = res.rows[0];
    if (row !== undefined) {
      proxyFund = {
        instrumentId: proxyId,
        key: `${row.ticker} ${row.exch_code} ${row.market_sector}`,
      };
    }
  }

  const terms: DesIndexPayload['terms'] = {
    provider: termsRow?.provider ?? reg?.provider ?? '',
    methodology: termsRow?.methodology ?? '',
    calcCurrency: (termsRow?.calcCurrency ?? p.detail.instrument.currency).trim(),
    region: termsRow?.region ?? null,
    baseDate: termsRow?.baseDate ?? null,
    baseValue: num(termsRow?.baseValue ?? null),
    constituentCount: termsRow?.constituentCount ?? null,
    proxyFund,
    membershipSourceId: reg?.membership_source_id ?? null,
    provIdx: termsRow === null ? p.refIdx : (p.cite.get(termsRow.provenanceId) ?? p.refIdx),
  };

  const stats = await statsBlock(ctx, p);

  // Membership (§DES index): only an index with a declared source has one, and REF-07 says the
  // absence is stated rather than filled with a guess.
  let membership: DesIndexPayload['membership'] = null;
  const membershipSourceId = reg?.membership_source_id ?? null;
  if (membershipSourceId === null) {
    ctx.unavailable.add({
      field: 'membership',
      reason: 'NO_SOURCE',
      detail: `no membership source for ${reg?.code ?? p.detail.instrument.ticker} (only SPX has N-PORT/SSGA membership)`,
    });
  } else {
    const roster = await ctx.data.reference.members(id, p.asOfDate).catch(() => null);
    if (roster === null || roster.members.length === 0) {
      ctx.unavailable.add({
        field: 'membership',
        reason: 'NO_SOURCE',
        detail: `no constituents recorded for ${reg?.code ?? p.detail.instrument.ticker} at ${p.asOfDate}`,
      });
    } else {
      const cite = await citeMany(
        ctx,
        roster.members.map((m) => m.provenanceId),
      );
      const withWeight = roster.members.filter((m) => m.weight !== null);
      const top10 = [...withWeight]
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.instrumentId - b.instrumentId)
        .slice(0, 10)
        .map((m) => ({
          instrumentId: m.instrumentId,
          key: `${m.ticker} ${m.exchCode} ${m.marketSector}`,
          name: m.name,
          weight: m.weight!,
        }));

      const sectors = await sectorWeights(
        ctx,
        roster.members.map((m) => ({ instrumentId: m.instrumentId, weight: m.weight })),
      );
      membership = {
        asOfDate: roster.asOfDate,
        count: roster.members.length,
        sourceId: membershipSourceId,
        top10,
        sectorWeights: sectors,
        provIdx: cite.get(roster.members[0]!.provenanceId) ?? p.refIdx,
      };
    }
  }

  const related: { key: string; label: string }[] = [];
  if (proxyFund !== null) related.push({ key: proxyFund.key, label: 'Proxy fund' });
  if ((reg?.code ?? '') === 'SPX') related.push({ key: 'VIX Index', label: 'Volatility index' });

  return {
    variant: 'index',
    instrument: p.instrument,
    terms,
    quote,
    stats,
    membership,
    related,
    calendar: p.calendar,
  };
}

/** GICS level-1 weights over a roster, one query. Unclassified members are counted as `null`. */
async function sectorWeights(
  ctx: ResolveContext,
  members: readonly { instrumentId: number; weight: number | null }[],
): Promise<{ sector: string; weight: number; count: number }[]> {
  if (members.length === 0) return [];
  const ids = sql.join(
    members.map((m) => sql`${String(m.instrumentId)}::bigint`),
    sql`, `,
  );
  const res = await ctx.db.execute<{ instrument_id: string; sector: string | null }>(sql`
    SELECT i.instrument_id::text AS instrument_id, cc.name AS sector
      FROM instruments i
      LEFT JOIN issues iss ON iss.issue_id = i.issue_id
                          AND iss.tx_to = 'infinity' AND iss.valid_to = 'infinity'
      LEFT JOIN entity_classifications ec ON ec.entity_kind = 'issuer'
                          AND ec.entity_id = iss.issuer_id AND ec.scheme = 'GICS'
                          AND ec.tx_to = 'infinity' AND ec.valid_to = 'infinity'
      LEFT JOIN classification_codes cc ON cc.scheme = ec.scheme AND cc.code = ec.code
                          AND cc.level = 1
     WHERE i.instrument_id IN (${ids})
       AND i.tx_to = 'infinity' AND i.valid_to = 'infinity'`);

  const sectorOf = new Map(res.rows.map((r) => [Number(r.instrument_id), r.sector]));
  const buckets = new Map<string, { weight: number; count: number }>();
  for (const member of members) {
    const sector = sectorOf.get(member.instrumentId) ?? null;
    if (sector === null) continue;
    const bucket = buckets.get(sector) ?? { weight: 0, count: 0 };
    bucket.weight += member.weight ?? 0;
    bucket.count += 1;
    buckets.set(sector, bucket);
  }
  return [...buckets.entries()]
    .map(([sector, b]) => ({ sector, weight: b.weight, count: b.count }))
    .sort((a, b) => b.weight - a.weight || (a.sector < b.sector ? -1 : 1));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// fx
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function fx(ctx: ResolveContext): Promise<DesPayload> {
  const p = await prologue(ctx);
  const { subject, state } = await snapshotWithEnsure(ctx, p, {
    kind: 'yahoo.fx',
    maxAgeMs: 60_000,
    sourceId: 'yahoo.chart',
  });

  const full = quoteBlock(ctx, state, subject);
  const quote: DesFxPayload['quote'] = {
    px: full.px,
    chgNet: full.chgNet,
    chgPct: full.chgPct,
    open: full.open,
    high: full.high,
    low: full.low,
    prevClose: full.prevClose,
    sessionState: full.sessionState,
  };

  const row = p.detail.terms?.kind === 'fx' ? p.detail.terms.terms : null;
  if (row === null) {
    ctx.unavailable.add({
      field: 'terms',
      reason: 'NO_SOURCE',
      detail: 'no fx_terms row for this pair',
    });
  }
  const baseCcy = (row?.baseCcy ?? '').trim();
  const quoteCcy = (row?.quoteCcy ?? '').trim();
  const terms: DesFxPayload['terms'] = {
    baseCcy,
    quoteCcy,
    spotLag: row?.spotLag ?? 0,
    calendarId: row?.calendarId ?? p.calendar.calendarId,
    pipSize: num(row?.pipSize ?? null) ?? 0,
    quoteConvention:
      row?.quoteConvention === 'base_per_quote' ? 'base_per_quote' : 'quote_per_base',
    provIdx: row === null ? p.refIdx : (p.cite.get(row.provenanceId) ?? p.refIdx),
  };

  const px = typeof quote.px.v === 'number' ? quote.px.v : null;
  const inverse: ValueCell =
    px === null || px === 0
      ? naCell(quote.px.provIdx)
      : storedCell({ v: 1 / px, provIdx: quote.px.provIdx, ts: quote.px.ts ?? null });
  if (inverse.v === null) {
    ctx.unavailable.add({
      field: 'inverse',
      reason: 'NO_SOURCE',
      detail: 'the inverse rate needs a last price',
    });
  }

  const stats = await statsBlock(ctx, p);
  const ecb = await ecbReference(ctx, p, baseCcy, quoteCcy);

  return {
    variant: 'fx',
    instrument: p.instrument,
    terms,
    quote,
    inverse,
    stats,
    ecb,
    calendar: p.calendar,
  };
}

/** The ECB reference cross (`frankfurter`, base USD), or `null` with the reason. */
async function ecbReference(
  ctx: ResolveContext,
  p: Prologue,
  baseCcy: string,
  quoteCcy: string,
): Promise<DesFxPayload['ecb']> {
  if (baseCcy === '' || quoteCcy === '') {
    ctx.unavailable.add({
      field: 'ecb',
      reason: 'NO_SOURCE',
      detail: 'currency not in ECB reference set',
    });
    return null;
  }
  const res = await ctx.db.execute<{
    rate_date: string;
    quote_ccy: string;
    rate: string;
    provenance_id: string;
  }>(sql`
    SELECT to_char(rate_date, 'YYYY-MM-DD') AS rate_date, quote_ccy, rate::text AS rate,
           provenance_id::text AS provenance_id
      FROM fx_rates
     WHERE source_id = 'frankfurter' AND base_ccy = 'USD'
       AND rate_date = (SELECT max(rate_date) FROM fx_rates
                         WHERE source_id = 'frankfurter' AND base_ccy = 'USD'
                           AND rate_date <= ${p.asOfDate}::date)`);

  const rows = res.rows;
  if (rows.length === 0) {
    ctx.unavailable.add({
      field: 'ecb',
      reason: 'NO_SOURCE',
      detail: 'currency not in ECB reference set',
    });
    return null;
  }
  const rateOf = (ccy: string): number | null =>
    ccy === 'USD' ? 1 : num(rows.find((r) => r.quote_ccy.trim() === ccy)?.rate ?? null);

  const basePerUsd = rateOf(baseCcy);
  const quotePerUsd = rateOf(quoteCcy);
  if (basePerUsd === null || quotePerUsd === null) {
    ctx.unavailable.add({
      field: 'ecb',
      reason: 'NO_SOURCE',
      detail: 'currency not in ECB reference set',
    });
    return null;
  }
  const cite = await citeMany(ctx, [Number(rows[0]!.provenance_id)]);
  return {
    rateDate: rows[0]!.rate_date,
    baseCcyPerUsd: basePerUsd,
    quoteCcyPerUsd: quotePerUsd,
    crossRate: basePerUsd === 0 ? null : quotePerUsd / basePerUsd,
    provIdx: cite.get(Number(rows[0]!.provenance_id)) ?? p.refIdx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// govt (ANAL-01, ANAL-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const GOVT_TYPES = ['bill', 'note', 'bond', 'tips', 'frn'] as const;
type GovtType = (typeof GOVT_TYPES)[number];

function govtTypeOf(raw: string): GovtType | null {
  const lower = raw.trim().toLowerCase();
  return (GOVT_TYPES as readonly string[]).includes(lower) ? (lower as GovtType) : null;
}

/** Linear interpolation of a curve's `value` in `tenorDays`, or `null` outside a usable bracket. */
function interpolate(
  points: readonly { tenorDays: number; value: number }[],
  days: number,
): number | null {
  const sorted = [...points].sort((a, b) => a.tenorDays - b.tenorDays);
  if (sorted.length === 0) return null;
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (days <= first.tenorDays) return first.value;
  if (days >= last.tenorDays) return last.value;
  for (let i = 1; i < sorted.length; i += 1) {
    const lo = sorted[i - 1]!;
    const hi = sorted[i]!;
    if (days <= hi.tenorDays) {
      const span = hi.tenorDays - lo.tenorDays;
      if (span === 0) return lo.value;
      return lo.value + ((days - lo.tenorDays) * (hi.value - lo.value)) / span;
    }
  }
  return last.value;
}

async function govt(ctx: ResolveContext): Promise<DesPayload> {
  const p = await prologue(ctx);
  const id = p.detail.instrument.instrumentId;
  const row = p.detail.terms?.kind === 'govt' ? p.detail.terms.terms : null;

  if (row === null) {
    ctx.unavailable.add({
      field: 'terms',
      reason: 'NO_SOURCE',
      detail: 'no govt_terms row for this security',
    });
    ctx.unavailable.add({
      field: 'pricing',
      reason: 'NO_SOURCE',
      detail: 'pricing needs the contractual terms, which are not recorded',
    });
    return {
      variant: 'govt',
      instrument: p.instrument,
      terms: {
        cusip: '',
        securityType: 'bond',
        termLabel: null,
        issueDate: null,
        datedDate: null,
        maturityDate: p.asOfDate,
        couponType: '',
        couponRate: null,
        couponFreq: 2,
        dayCount: '',
        firstCouponDate: null,
        businessDayConv: '',
        calendarId: p.calendar.calendarId,
        settlementDays: 1,
        minDenomination: 0,
        amountOutstanding: null,
        onTheRun: false,
        issuer: p.detail.issuer?.name ?? '',
        provIdx: p.refIdx,
      },
      pricing: null,
      identifiers: identifierRows(p),
      calendar: p.calendar,
    };
  }

  const securityType = govtTypeOf(row.securityType);
  if (securityType === null) {
    ctx.unavailable.add({
      field: 'terms.securityType',
      reason: 'NOT_APPLICABLE',
      detail: `govt_terms.security_type ${JSON.stringify(row.securityType)} is not one of bill/note/bond/tips/frn`,
    });
  }
  const kind: GovtType = securityType ?? 'bond';

  const terms: DesGovtPayload['terms'] = {
    cusip: row.cusip.trim(),
    securityType: kind,
    termLabel: row.termLabel,
    issueDate: row.issueDate,
    datedDate: row.datedDate,
    maturityDate: row.maturityDate,
    couponType: row.couponType,
    couponRate: num(row.couponRate),
    couponFreq: row.couponFreq,
    dayCount: row.dayCount,
    firstCouponDate: row.firstCouponDate,
    businessDayConv: row.businessDayConv,
    calendarId: row.calendarId,
    settlementDays: row.settlementDays,
    minDenomination: num(row.minDenomination) ?? 0,
    amountOutstanding: num(row.amountOutstanding),
    onTheRun: row.onTheRun,
    issuer: p.detail.issuer?.name ?? 'US Treasury',
    provIdx: p.cite.get(row.provenanceId) ?? p.refIdx,
  };

  // Settlement: T+`settlementDays` on the SIFMA calendar. Without a seeded calendar there is no
  // business-day arithmetic to do, and a raw-calendar settlement would be a different number.
  let settlementDate: string | null = null;
  if (p.cal !== null) settlementDate = addBusinessDays(p.cal, p.asOfDate, row.settlementDays);
  if (settlementDate === null) {
    ctx.unavailable.add({
      field: 'pricing',
      reason: 'NO_SOURCE',
      detail: `no calendar seeded for ${row.calendarId}; settlement cannot be rolled to a business day`,
    });
    return {
      variant: 'govt',
      instrument: p.instrument,
      terms,
      pricing: null,
      identifiers: identifierRows(p),
      calendar: p.calendar,
    };
  }

  if (settlementDate >= row.maturityDate) {
    ctx.unavailable.add({ field: 'pricing', reason: 'NOT_APPLICABLE', detail: 'matured' });
    return {
      variant: 'govt',
      instrument: p.instrument,
      terms,
      pricing: null,
      identifiers: identifierRows(p),
      calendar: p.calendar,
    };
  }

  const daysToMaturity = daysBetween(settlementDate, row.maturityDate);
  const curveId = kind === 'bill' ? 'UST_BILL' : 'UST_PAR';
  const curve = await ctx.data.curves.points(curveId, p.asOfDate).catch(() => null);
  if (curve === null || curve.points.length === 0) {
    ctx.unavailable.add({
      field: 'pricing',
      reason: 'NO_SOURCE',
      detail: `no ${curveId} curve stored on or before ${p.asOfDate}`,
    });
    return {
      variant: 'govt',
      instrument: p.instrument,
      terms,
      pricing: null,
      identifiers: identifierRows(p),
      calendar: p.calendar,
    };
  }

  const cite = await citeMany(
    ctx,
    curve.points.map((pt) => pt.provenanceId),
  );
  const curveIdx = cite.get(curve.points[0]!.provenanceId) ?? p.refIdx;
  const curveTs = Date.parse(curve.points[0]!.vintageAt);

  const cell = (v: number | null): ValueCell =>
    v === null ? naCell(curveIdx) : storedCell({ v, provIdx: curveIdx, ts: curveTs });

  if (kind === 'tips' || kind === 'frn') {
    ctx.unavailable.add({
      field: 'pricing.inflation',
      reason: 'NO_SOURCE',
      detail: 'no index ratio / reference fixing source; priced as nominal',
    });
  }

  let pricing: DesGovtPayload['pricing'];

  if (kind === 'bill') {
    const own = curve.points.find(
      (pt) => pt.instrumentId === id && pt.quoteType === 'discount_rate',
    );
    const discounts = curve.points
      .filter((pt) => pt.quoteType === 'discount_rate')
      .map((pt) => ({ tenorDays: pt.tenorDays, value: pt.value }));
    const discountRate = own?.value ?? interpolate(discounts, daysToMaturity);
    if (discountRate === null) {
      ctx.unavailable.add({
        field: 'pricing',
        reason: 'NO_SOURCE',
        detail: 'the UST_BILL curve carries no discount rate for this tenor',
      });
      return {
        variant: 'govt',
        instrument: p.instrument,
        terms,
        pricing: null,
        identifiers: identifierRows(p),
        calendar: p.calendar,
      };
    }

    const inputs = { face: 100, daysToMaturity, discountRate: discountRate / 100 };
    const out = bill(inputs);
    ctx.engines.add({ name: 'bill', version: '1.0.0', inputsHash: inputsHash(inputs) });

    const macDuration = daysToMaturity / 365;
    const modDuration = macDuration / (1 + (out.investmentYieldPercent / 100) * macDuration);
    pricing = {
      settlementDate,
      daysToMaturity,
      yieldSource: own === undefined ? 'par_interp' : 'bill_quote',
      curveId: 'UST_BILL',
      curveDate: curve.curveDate,
      yield: cell(out.investmentYieldPercent),
      discountRate: cell(out.discountRatePercent),
      price: cell(out.price),
      accrued: cell(0),
      dirtyPrice: cell(out.price),
      macDuration: cell(macDuration),
      modDuration: cell(modDuration),
      convexity: cell(macDuration * macDuration),
      dv01: cell(modDuration * out.price * 1e-4),
      provIdx: curveIdx,
    };
  } else {
    const pars = curve.points
      .filter((pt) => pt.quoteType === 'par_yield')
      .map((pt) => ({ tenorDays: pt.tenorDays, value: pt.value }));
    const parYield = interpolate(pars, daysToMaturity);
    const couponRate = num(row.couponRate);
    if (parYield === null || couponRate === null) {
      ctx.unavailable.add({
        field: 'pricing',
        reason: 'NO_SOURCE',
        detail:
          parYield === null
            ? 'the UST_PAR curve carries no par yield for this tenor'
            : 'the security carries no coupon rate',
      });
      return {
        variant: 'govt',
        instrument: p.instrument,
        terms,
        pricing: null,
        identifiers: identifierRows(p),
        calendar: p.calendar,
      };
    }

    const bondTerms: BondTerms = {
      face: 100,
      couponRate: couponRate / 100,
      frequency: (row.couponFreq as CouponFrequency) ?? 2,
      datedDate: row.datedDate ?? row.issueDate ?? settlementDate,
      maturity: row.maturityDate,
      dayCount: 'ACT/ACT',
      ...(row.firstCouponDate === null ? {} : { firstCouponDate: row.firstCouponDate }),
    };
    const y = parYield / 100;
    const priced = priceFromYield(bondTerms, settlementDate, y);
    const risk = bondRisk(bondTerms, settlementDate, y);
    const engineInputs = { ...bondTerms, settlement: settlementDate, yield: y };
    ctx.engines.add({ name: 'bond.price', version: '1.0.0', inputsHash: inputsHash(engineInputs) });
    ctx.engines.add({ name: 'bond.risk', version: '1.0.0', inputsHash: inputsHash(engineInputs) });

    pricing = {
      settlementDate,
      daysToMaturity,
      yieldSource: 'par_interp',
      curveId: 'UST_PAR',
      curveDate: curve.curveDate,
      yield: cell(parYield),
      discountRate: naCell(curveIdx),
      price: cell(priced.cleanPrice),
      accrued: cell(priced.accrued),
      dirtyPrice: cell(priced.dirtyPrice),
      macDuration: cell(risk.macaulayDuration),
      modDuration: cell(risk.modifiedDuration),
      convexity: cell(risk.convexity),
      dv01: cell(risk.dv01),
      provIdx: curveIdx,
    };
    ctx.unavailable.add({
      field: 'pricing.discountRate',
      reason: 'NOT_APPLICABLE',
      detail: 'a bank-discount rate is quoted for bills only',
    });
  }

  return {
    variant: 'govt',
    instrument: p.instrument,
    terms,
    pricing,
    identifiers: identifierRows(p),
    calendar: p.calendar,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// option (REF-05)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const OPTION_QUOTE_FIELDS = {
  bid: 'PX_BID',
  ask: 'PX_ASK',
  last: 'PX_LAST',
  lastTradeTime: 'LAST_TRADE_TIME',
  volume: 'PX_VOLUME',
  oi: 'OPT_OI',
  prevClose: 'PX_CLOSE_1D',
  chgNet: 'CHG_NET_1D',
  chgPct: 'CHG_PCT_1D',
  iv: 'OPT_IV',
  delta: 'OPT_DELTA',
  gamma: 'OPT_GAMMA',
  vega: 'OPT_VEGA',
  theta: 'OPT_THETA',
  rho: 'OPT_RHO',
  theo: 'OPT_THEO',
} as const satisfies Record<keyof DesOptionPayload['quote'], FieldId>;

async function option(ctx: ResolveContext): Promise<DesPayload> {
  const p = await prologue(ctx);
  const id = p.detail.instrument.instrumentId;
  const row = p.detail.terms?.kind === 'option' ? p.detail.terms.terms : null;

  const contractSubject = ctx.plant.subjectFor(id);
  ctx.plant.ensureHot([contractSubject]);

  if (row === null) {
    // Without contract terms there is no underlying to follow and no moneyness to compute; the
    // quote block is still honest, and every derived block says why it is empty.
    ctx.unavailable.add({
      field: 'terms',
      reason: 'NO_SOURCE',
      detail: 'no option_terms row for this contract',
    });
    const state = ctx.plant.snapshot(contractSubject);
    const quote = {} as Record<keyof DesOptionPayload['quote'], ValueCell>;
    for (const [key, field] of Object.entries(OPTION_QUOTE_FIELDS) as [
      keyof DesOptionPayload['quote'],
      FieldId,
    ][]) {
      quote[key] = cellFromState(ctx, state, field, contractSubject);
    }
    ctx.unavailable.add({
      field: 'moneyness',
      reason: 'NO_SOURCE',
      detail: 'moneyness needs the strike and the underlying price',
    });
    ctx.unavailable.add({
      field: 'chain',
      reason: 'NO_SOURCE',
      detail: 'no chain summary for underlying',
    });
    return {
      variant: 'option',
      instrument: p.instrument,
      terms: {
        occSymbol: p.detail.instrument.ticker,
        root: '',
        underlying: { instrumentId: -1, key: '', name: '' },
        expiry: p.asOfDate,
        strike: 0,
        putCall: 'C',
        exerciseStyle: '',
        settlement: '',
        amPm: '',
        multiplier: 0,
        isWeekly: false,
        lastTradeDate: null,
        daysToExpiry: 0,
        provIdx: p.refIdx,
      },
      quote,
      underlying: {
        px: pendingCell(contractSubject, 'OPT_UNDL_PX'),
        chgPct: pendingCell(contractSubject, 'CHG_PCT_1D'),
      },
      moneyness: { intrinsic: naCell(), timeValue: naCell(), pctFromSpot: naCell() },
      chain: null,
      calendar: p.calendar,
    };
  }

  const underlyingId = row.underlyingInstrumentId;
  const underlyingSubject = ctx.plant.subjectFor(underlyingId);
  const chainSubject = ctx.plant.subjectFor(underlyingId, 'oc');
  ctx.plant.ensureHot([underlyingSubject, chainSubject]);

  let state = ctx.plant.snapshot(contractSubject);
  if (state === undefined || state.state === 'blank') {
    const undl = await ctx.data.reference.instrument(underlyingId).catch(() => null);
    const line = undl?.mdLines.find((l) => l.sourceId === 'cboe.options') ?? undl?.mdLines[0];
    if (line !== undefined) {
      await tryEnsure(ctx, 'cboe.options', line.providerSymbol, 60_000);
      state = ctx.plant.snapshot(contractSubject);
    }
  }
  if (state === undefined) {
    ctx.unavailable.add({
      field: 'quote',
      reason: 'NO_SOURCE',
      detail: 'the plant holds no quote for this contract yet — the scheduler polls it next',
    });
  }

  const quote = {} as Record<keyof DesOptionPayload['quote'], ValueCell>;
  for (const [key, field] of Object.entries(OPTION_QUOTE_FIELDS) as [
    keyof DesOptionPayload['quote'],
    FieldId,
  ][]) {
    quote[key] = cellFromState(ctx, state, field, contractSubject);
  }

  const undlDetail = await ctx.data.reference.instrument(underlyingId).catch(() => null);
  const undlState = ctx.plant.snapshot(underlyingSubject);
  const underlying = {
    px: cellFromState(ctx, undlState, 'PX_LAST', underlyingSubject),
    chgPct: cellFromState(ctx, undlState, 'CHG_PCT_1D', underlyingSubject),
  };
  if (undlState === undefined) {
    ctx.unavailable.add({
      field: 'underlying',
      reason: 'NO_SOURCE',
      detail: 'the plant holds no quote for the underlying yet',
    });
  }

  const strike = num(row.strike) ?? 0;
  const putCall: 'C' | 'P' = row.putCall.trim().toUpperCase() === 'P' ? 'P' : 'C';
  const terms: DesOptionPayload['terms'] = {
    occSymbol: row.occSymbol,
    root: row.root,
    underlying: {
      instrumentId: underlyingId,
      key:
        undlDetail === null
          ? ''
          : `${undlDetail.instrument.ticker} ${undlDetail.instrument.exchCode} ${undlDetail.instrument.marketSector}`,
      name: undlDetail?.instrument.name ?? '',
    },
    expiry: row.expiry,
    strike,
    putCall,
    exerciseStyle: row.exerciseStyle,
    settlement: row.settlement,
    amPm: row.amPmSettlement.trim(),
    multiplier: row.multiplier,
    isWeekly: row.isWeekly,
    lastTradeDate: row.lastTradeDate,
    daysToExpiry: daysBetween(p.asOfDate, row.expiry),
    provIdx: p.cite.get(row.provenanceId) ?? p.refIdx,
  };

  // Moneyness is derived from the quote and the underlying, and cites the underlying's row.
  const spot = typeof underlying.px.v === 'number' ? underlying.px.v : null;
  const bid = typeof quote.bid.v === 'number' ? quote.bid.v : null;
  const ask = typeof quote.ask.v === 'number' ? quote.ask.v : null;
  const mid = bid === null || ask === null ? null : (bid + ask) / 2;
  const intrinsicValue =
    spot === null
      ? null
      : putCall === 'C'
        ? Math.max(0, spot - strike)
        : Math.max(0, strike - spot);
  const moneyness = {
    intrinsic:
      intrinsicValue === null
        ? naCell(underlying.px.provIdx)
        : storedCell({
            v: intrinsicValue,
            provIdx: underlying.px.provIdx,
            ts: underlying.px.ts ?? null,
          }),
    timeValue:
      mid === null || intrinsicValue === null
        ? naCell(underlying.px.provIdx)
        : storedCell({
            v: mid - intrinsicValue,
            provIdx: underlying.px.provIdx,
            ts: underlying.px.ts ?? null,
          }),
    pctFromSpot:
      spot === null || spot === 0
        ? naCell(underlying.px.provIdx)
        : storedCell({
            v: (strike / spot - 1) * 100,
            provIdx: underlying.px.provIdx,
            ts: underlying.px.ts ?? null,
          }),
  };
  if (moneyness.intrinsic.v === null || moneyness.timeValue.v === null) {
    ctx.unavailable.add({
      field: 'moneyness',
      reason: 'NO_SOURCE',
      detail: 'moneyness needs the underlying price and a two-sided contract quote',
    });
  }

  const chainState = ctx.plant.snapshot(chainSubject);
  let chain: DesOptionPayload['chain'] = null;
  if (chainState === undefined) {
    ctx.unavailable.add({
      field: 'chain',
      reason: 'NO_SOURCE',
      detail: 'no chain summary for underlying',
    });
  } else {
    const raw = chainState.fields as Record<string, unknown>;
    const expiries =
      typeof raw.EXPIRIES === 'string' ? raw.EXPIRIES.split(',').filter((s) => s !== '') : [];
    const chainIdx = ctx.prov.addQuote(chainState);
    chain = {
      expiries,
      contractCount: typeof raw.CONTRACT_COUNT === 'number' ? raw.CONTRACT_COUNT : null,
      atmIv: cellFromState(ctx, chainState, 'ATM_IV', chainSubject),
      putCallRatio: cellFromState(ctx, chainState, 'PUT_CALL_RATIO', chainSubject),
    };
    if (chain.contractCount === null) {
      ctx.unavailable.add({
        field: 'chain.contractCount',
        reason: 'NO_SOURCE',
        detail: 'the chain summary publishes no contract count',
      });
    }
    void chainIdx;
  }

  return {
    variant: 'option',
    instrument: p.instrument,
    terms,
    quote,
    underlying,
    moneyness,
    chain,
    calendar: p.calendar,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// crypto
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function crypto(ctx: ResolveContext): Promise<DesPayload> {
  const p = await prologue(ctx);
  const line =
    p.detail.mdLines.find((l) => l.sourceId === 'coingecko.simple') ?? p.detail.mdLines[0];
  const coingeckoId = line?.providerSymbol ?? '';
  if (coingeckoId === '') {
    ctx.unavailable.add({
      field: 'coingeckoId',
      reason: 'NO_SOURCE',
      detail: 'no coingecko.simple market-data line for this coin',
    });
  }

  const { subject, state } = await snapshotWithEnsure(ctx, p, {
    kind: 'coingecko.simple',
    maxAgeMs: 60_000,
    sourceId: 'coingecko.simple',
  });

  const px = cellFromState(ctx, state, 'PX_LAST', subject);
  const chg24hPct = cellFromState(ctx, state, 'CHG_PCT_1D', subject);
  const asOfMs = state === undefined ? null : (state.ts.src ?? state.ts.cap);

  // The crypto screen is two numbers and a caveat; each absence has to say so itself, because
  // there is no other block on the payload to carry the explanation (§1.3 rule 6).
  if (px.v === null && px.r === undefined) {
    ctx.unavailable.add({
      field: 'px',
      reason: 'NO_SOURCE',
      detail: 'the plant holds no CoinGecko price for this coin yet',
    });
  }
  if (chg24hPct.v === null && chg24hPct.r === undefined) {
    ctx.unavailable.add({
      field: 'chg24hPct',
      reason: 'NO_SOURCE',
      detail: 'the 24-hour change needs a prior close, which the plant has not seen yet',
    });
  }
  if (asOfMs === null) {
    ctx.unavailable.add({
      field: 'asOf',
      reason: 'NO_SOURCE',
      detail: 'no capture instant: the coin has never been polled',
    });
  }

  return {
    variant: 'crypto',
    instrument: p.instrument,
    coingeckoId,
    px,
    chg24hPct,
    asOf: asOfMs === null ? null : new Date(asOfMs).toISOString(),
    source: 'coingecko.simple',
    caveat: 'CONTEXT_ONLY_NOT_EXCHANGE_DATA',
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// rate
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** §DES L272: the fixed description each published overnight rate carries. */
export const RATE_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  SOFR:
    'Secured Overnight Financing Rate — volume-weighted median of overnight Treasury repo; ' +
    'published 08:00 ET by the New York Fed; ACT/360',
  EFFR:
    'Effective Federal Funds Rate — volume-weighted median of overnight federal funds ' +
    'transactions; published 09:00 ET by the New York Fed; ACT/360',
  OBFR:
    'Overnight Bank Funding Rate — volume-weighted median of federal funds and Eurodollar ' +
    'transactions; published 09:00 ET by the New York Fed; ACT/360',
  TGCR:
    'Tri-party General Collateral Rate — volume-weighted median of tri-party Treasury repo ' +
    'excluding GCF and FICC-cleared trades; published 08:00 ET by the New York Fed; ACT/360',
  BGCR:
    'Broad General Collateral Rate — volume-weighted median of tri-party Treasury repo ' +
    'including GCF; published 08:00 ET by the New York Fed; ACT/360',
});

const RATE_LATEST_FIELDS = {
  rate: 'RATE',
  pct1: 'RATE_P1',
  pct25: 'RATE_P25',
  pct75: 'RATE_P75',
  pct99: 'RATE_P99',
  volumeBn: 'RATE_VOLUME_BN',
} as const;

async function rate(ctx: ResolveContext): Promise<DesPayload> {
  const p = await prologue(ctx);
  const id = p.detail.instrument.instrumentId;
  const row = p.detail.terms?.kind === 'rate' ? p.detail.terms.terms : null;
  const rateCode = row?.rateCode ?? p.detail.instrument.ticker;

  if (row === null) {
    ctx.unavailable.add({
      field: 'terms',
      reason: 'NO_SOURCE',
      detail: 'no rate_terms row for this rate',
    });
  }

  const terms: DesRatePayload['terms'] = {
    rateCode,
    publisher: row?.publisher ?? '',
    dayCount: row?.dayCount ?? '',
    publicationTimeEt: row?.publicationTimeEt ?? null,
    tenorDays: row?.tenorDays ?? 1,
    compounding: row?.compounding ?? '',
    seriesCode: null,
    provIdx: row === null ? p.refIdx : (p.cite.get(row.provenanceId) ?? p.refIdx),
  };

  await tryEnsure(ctx, 'nyfed.rates', rateCode, 3_600_000);

  const subject = ctx.plant.subjectFor(id);
  ctx.plant.ensureHot([subject]);

  const fixing = await ctx.data.rates.latest(rateCode).catch(() => null);
  let latest: DesRatePayload['latest'] = null;
  if (fixing === null) {
    ctx.unavailable.add({
      field: 'latest',
      reason: 'NO_SOURCE',
      detail: `no ${rateCode} fixing is stored`,
    });
  } else {
    const cite = await citeMany(ctx, [fixing.provenanceId]);
    const idx = cite.get(fixing.provenanceId) ?? p.refIdx;
    const ts = Date.parse(fixing.vintageAt);
    const cell = (v: number | null, field: FieldId): ValueCell =>
      v === null
        ? { v: null, st: 'na', provIdx: idx, live: { subject, field } }
        : { v, st: 'closed', ts, provIdx: idx, live: { subject, field } };

    const hasTarget = rateCode === 'EFFR';
    if (!hasTarget) {
      ctx.unavailable.add({
        field: 'latest.target',
        reason: 'NOT_APPLICABLE',
        detail: 'the FOMC target range is published against EFFR only',
      });
    }
    latest = {
      effectiveDate: fixing.effectiveDate,
      rate: cell(fixing.rate, RATE_LATEST_FIELDS.rate),
      pct1: cell(fixing.pct1, RATE_LATEST_FIELDS.pct1),
      pct25: cell(fixing.pct25, RATE_LATEST_FIELDS.pct25),
      pct75: cell(fixing.pct75, RATE_LATEST_FIELDS.pct75),
      pct99: cell(fixing.pct99, RATE_LATEST_FIELDS.pct99),
      volumeBn: cell(fixing.volumeBn, RATE_LATEST_FIELDS.volumeBn),
      targetFrom: hasTarget ? cell(fixing.targetFrom, 'TARGET_FROM') : cell(null, 'TARGET_FROM'),
      targetTo: hasTarget ? cell(fixing.targetTo, 'TARGET_TO') : cell(null, 'TARGET_TO'),
      revisionIndicator: fixing.revisionIndicator,
      vintageAt: fixing.vintageAt,
    };
    for (const [key, field] of Object.entries(RATE_LATEST_FIELDS)) {
      if (latest[key as keyof typeof RATE_LATEST_FIELDS].v === null) {
        ctx.unavailable.add({
          field: `latest.${key}`,
          reason: 'NO_SOURCE',
          detail: `the ${rateCode} publication carries no ${field}`,
        });
      }
    }
  }

  let averages: DesRatePayload['averages'] = null;
  if (rateCode === 'SOFR') {
    const ai = await ctx.data.rates.latest('SOFRAI').catch(() => null);
    if (ai === null) {
      ctx.unavailable.add({
        field: 'averages',
        reason: 'NO_SOURCE',
        detail: 'no SOFRAI averages/index row is stored',
      });
    } else {
      const cite = await citeMany(ctx, [ai.provenanceId]);
      averages = {
        effectiveDate: ai.effectiveDate,
        avg30d: ai.avg30d,
        avg90d: ai.avg90d,
        avg180d: ai.avg180d,
        indexValue: ai.indexValue,
        provIdx: cite.get(ai.provenanceId) ?? p.refIdx,
      };
    }
  } else {
    ctx.unavailable.add({
      field: 'averages',
      reason: 'NOT_APPLICABLE',
      detail: 'compounded averages and an index value are published for SOFR only',
    });
  }

  const history = await ctx.data.rates.history(rateCode, 30).catch(() => []);
  if (history.length === 0) {
    ctx.unavailable.add({
      field: 'history',
      reason: 'NO_SOURCE',
      detail: `no ${rateCode} fixing history is stored`,
    });
  }
  const historyCite = await citeMany(
    ctx,
    history.map((h) => h.provenanceId),
  );

  const description = RATE_DESCRIPTIONS[rateCode];
  if (description === undefined) {
    ctx.unavailable.add({
      field: 'description',
      reason: 'NO_SOURCE',
      detail: `no published description is recorded for ${rateCode}`,
    });
  }

  return {
    variant: 'rate',
    instrument: p.instrument,
    terms,
    latest,
    averages,
    history: [...history]
      .sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : 1))
      .map((h) => ({
        effectiveDate: h.effectiveDate,
        rate: h.rate,
        provIdx: historyCite.get(h.provenanceId) ?? p.refIdx,
      })),
    description: description ?? '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// econ
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ECON_HISTORY = 24;

async function econ(ctx: ResolveContext): Promise<DesPayload> {
  const p = await prologue(ctx);
  const id = p.detail.instrument.instrumentId;

  const series =
    (await ctx.data.econ.seriesForInstrument(id)) ??
    (await ctx.data.econ.series(p.detail.instrument.ticker));

  if (series === null) {
    ctx.unavailable.add({
      field: 'series',
      reason: 'NO_SOURCE',
      detail: `no econ_series row for ${p.detail.instrument.ticker}`,
    });
    ctx.unavailable.add({
      field: 'latest',
      reason: 'NO_SOURCE',
      detail: 'the series definition is missing, so no observation can be read',
    });
    ctx.unavailable.add({
      field: 'nextRelease',
      reason: 'NO_SOURCE',
      detail: 'series has no release calendar entry',
    });
    return {
      variant: 'econ',
      instrument: p.instrument,
      series: {
        seriesId: -1,
        code: p.detail.instrument.ticker,
        name: p.detail.instrument.name,
        sourceId: '',
        providerCode: '',
        units: '',
        frequency: 'M',
        seasonalAdj: null,
        country: '',
        releaseName: null,
        decimals: 0,
        firstObsDate: null,
        lastObsDate: null,
        provIdx: p.refIdx,
      },
      latest: null,
      prior: null,
      change: null,
      nextRelease: null,
      history: [],
      knownAt: ctx.asOf.knownAt.toISOString(),
    };
  }

  if (series.sourceId === 'fred.csv') {
    await tryEnsure(ctx, 'fred.series', series.providerCode, 6 * 3_600_000);
  }

  const obs = await ctx.data.econ.observationsBySeriesId(series.seriesId, {
    to: p.asOfDate,
    knownAt: ctx.asOf.knownAt,
    limit: ECON_HISTORY + 1,
  });
  const cite = await citeMany(
    ctx,
    obs.map((o) => o.provenanceId),
  );

  const newest = obs[obs.length - 1] ?? null;
  const previous = obs[obs.length - 2] ?? null;

  let latest: DesEconPayload['latest'] = null;
  if (newest === null) {
    ctx.unavailable.add({
      field: 'latest',
      reason: 'NO_SOURCE',
      detail: `no observation of ${series.seriesCode} is public at this knownAt`,
    });
  } else {
    const idx = cite.get(newest.provenanceId) ?? p.refIdx;
    latest = {
      obsDate: newest.obsDate,
      value:
        newest.value === null
          ? naCell(idx)
          : storedCell({ v: newest.value, provIdx: idx, ts: Date.parse(newest.vintageAt) }),
      status: newest.status,
      vintageAt: newest.vintageAt,
    };
    if (newest.value === null) {
      ctx.unavailable.add({
        field: 'latest.value',
        reason: 'NO_SOURCE',
        detail: 'the publisher reported this period as missing',
      });
    }
  }

  const prior =
    previous === null
      ? null
      : {
          obsDate: previous.obsDate,
          value: previous.value,
          provIdx: cite.get(previous.provenanceId) ?? p.refIdx,
        };
  if (prior === null) {
    ctx.unavailable.add({
      field: 'prior',
      reason: 'NO_SOURCE',
      detail: 'only one observation is public at this knownAt',
    });
  }

  let change: DesEconPayload['change'] = null;
  if (newest !== null && previous !== null && newest.value !== null && previous.value !== null) {
    const abs = newest.value - previous.value;
    change = {
      abs,
      pct: previous.value === 0 ? null : (abs / Math.abs(previous.value)) * 100,
      // §0.4 rule 4: the primary input is the latest observation.
      provIdx: cite.get(newest.provenanceId) ?? p.refIdx,
    };
    if (change.pct === null) {
      ctx.unavailable.add({
        field: 'change.pct',
        reason: 'NOT_APPLICABLE',
        detail: 'the prior observation is zero, so a percentage change is undefined',
      });
    }
  } else {
    ctx.unavailable.add({
      field: 'change',
      reason: 'NO_SOURCE',
      detail: 'a change needs two consecutive published observations',
    });
  }

  let nextRelease: DesEconPayload['nextRelease'] = null;
  if (series.release === null) {
    ctx.unavailable.add({
      field: 'nextRelease',
      reason: 'NO_SOURCE',
      detail: 'series has no release calendar entry',
    });
  } else {
    const res = await ctx.db.execute<{
      scheduled_at: string;
      time_known: boolean;
      period_label: string;
      release_id: string;
    }>(sql`
      SELECT to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS scheduled_at,
             time_known, period_label, release_id::text AS release_id
        FROM econ_release_events
       WHERE release_id = ${String(series.release.releaseId)}::bigint
         AND scheduled_at > ${ctx.asOf.validAt.toISOString()}::timestamptz
       ORDER BY scheduled_at
       LIMIT 1`);
    const row = res.rows[0];
    if (row === undefined) {
      ctx.unavailable.add({
        field: 'nextRelease',
        reason: 'NO_SOURCE',
        detail: 'series has no release calendar entry',
      });
    } else {
      nextRelease = {
        scheduledAt: row.scheduled_at,
        timeKnown: row.time_known,
        periodLabel: row.period_label,
        releaseId: Number(row.release_id),
      };
    }
  }

  const history = obs
    .slice(0, Math.max(0, obs.length - 1))
    .slice(-ECON_HISTORY)
    .map((o) => ({
      obsDate: o.obsDate,
      value: o.value,
      status: o.status,
      provIdx: cite.get(o.provenanceId) ?? p.refIdx,
    }));
  if (history.some((h) => h.value === null)) {
    ctx.unavailable.add({
      field: 'history',
      reason: 'NO_SOURCE',
      detail: 'the publisher reported one or more periods of this series as missing',
    });
  }

  return {
    variant: 'econ',
    instrument: p.instrument,
    series: {
      seriesId: series.seriesId,
      code: series.seriesCode,
      name: series.name,
      sourceId: series.sourceId,
      providerCode: series.providerCode,
      units: series.units,
      frequency: series.frequency,
      seasonalAdj: series.seasonalAdj,
      country: series.country.trim(),
      releaseName: series.release?.name ?? null,
      decimals: series.decimals,
      firstObsDate: series.firstObsDate,
      lastObsDate: series.lastObsDate,
      provIdx: newest === null ? p.refIdx : (cite.get(newest.provenanceId) ?? p.refIdx),
    },
    latest,
    prior,
    change,
    nextRelease,
    history,
    knownAt: ctx.asOf.knownAt.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module (§DES L245)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export { equity, indexVariant as index, fx, govt, option, crypto, rate, econ };

/** FUNC-02: nine asset classes, eight payload shapes. The runner asserts the map's answer. */
export const variants = {
  equity,
  etf: equity,
  index: indexVariant,
  fx,
  govt,
  option,
  crypto,
  rate,
  econ,
} satisfies Partial<Record<AssetClass, FunctionResolver<DesParams, DesPayload>>>;

/** The dispatcher the runner falls back to; `assetClasses` never lets it be reached in practice. */
export const resolve = equity;

const module_: FunctionServerModule<DesParams, DesPayload> = { resolve, variants };

export default module_;
