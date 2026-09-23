/**
 * `functions/RV/resolve.ts` — Relative Valuation (FUNCTIONS_TIER2.md §RV L463-643, WORKPLAN WP-10).
 *
 * One equity against its peer group, with the peer distribution beside it. Five decisions:
 *
 *  1. **Peers are read from the store; only the target may be fetched.** `providers.ensure` runs
 *     for the target's companyfacts and nothing else: pulling up to thirty 3.7 MB documents on a
 *     request path is not a screen, it is an outage. A peer whose filings are not ingested stays on
 *     the screen with `dataState:'none'`, `unavailableReason:'FUNDAMENTALS_NOT_INGESTED'` and blank
 *     multiples — visible, excluded from the statistics, and never filled with a peer average.
 *  2. **A degenerate denominator is `null`, not a number.** Zero or negative equity, revenue or
 *     EBITDA yields `{ v: null, st: 'na' }`; `EV_TO_EBITDA` additionally reports `NOT_APPLICABLE`
 *     naming the row, because "EBITDA is not positive" is a fact about the company rather than a
 *     gap in the data.
 *  3. **`n < 3` means no statistics at all.** A median of two peers is a number with no meaning;
 *     every field of that `RvStat` is null with `reason:'INSUFFICIENT_PEERS'` and the gap is in
 *     `meta.unavailable` under the metric's own id.
 *  4. **Prices are live, multiples are not.** `PX_LAST` and `CHG_PCT_1D` are plant cells carrying
 *     `live`; every multiple is a resolver value at `ctx.asOf` with `st:'closed'`. The grid, the
 *     statistics and the CSV therefore cannot disagree (API-05).
 *  5. **Percent metrics are in percent units.** `NET_MARGIN`, `RETURN_COM_EQY`, `SALES_GROWTH_YOY`
 *     and `DVD_YIELD` are `× 100`, matching `core/fields/dictionary.ts` (whose `pct` unit the
 *     shared formatter renders by appending `%` without scaling). §RV's CSV example shows the
 *     fraction; the dictionary and the formatter are the shared vocabulary, so this file follows
 *     them and records the difference here.
 */

import { sql } from 'drizzle-orm';

import type { ValueCell } from '@terminal/core';
import type { Calendar } from '@terminal/core/calendars/calendar';
import type {
  RvParams,
  RvPayload,
  RvPeerBasis,
  RvPeerSet,
  RvRow,
  RvStat,
} from '@terminal/core/functions/manifests/RV';
import { rvColumn } from '@terminal/core/functions/manifests/RV';

import type { FinStatement } from '../../data/fundamentals.js';
import type {
  FunctionResolver,
  FunctionServerModule,
  ReadThroughKind,
  ResolveContext,
} from '../context.js';
import { cellFromState } from '../shared/cells.js';
import { displayOf } from '../shared/instrumentSummary.js';
import { periodReturns, recordPeriodMeta, type PeriodBar } from '../shared/returns.js';

const DAY_MS = 86_400_000;
const BAR_WINDOW_DAYS = 400;

/** GICS code length per basis: sector 2, industry group 4, industry 6, sub-industry 8. */
const GICS_DIGITS: Readonly<Record<string, number>> = {
  SECTOR: 2,
  INDUSTRY_GROUP: 4,
  INDUSTRY: 6,
  SUB_INDUSTRY: 8,
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared plumbing
// ─────────────────────────────────────────────────────────────────────────────────────────────

function knownAtOf(ctx: ResolveContext, param: string | undefined): Date {
  if (param === undefined) return ctx.asOf.knownAt;
  const asked = new Date(param);
  if (Number.isNaN(asked.getTime())) return ctx.asOf.knownAt;
  return asked.getTime() < ctx.asOf.knownAt.getTime() ? asked : ctx.asOf.knownAt;
}

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
    // Stored rows answer the screen; a peer without them is reported, never invented.
  }
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Candidate rows
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One candidate as the peer-set query returns it, before quotes and fundamentals. */
interface Candidate {
  instrumentId: number;
  ticker: string;
  exchCode: string;
  marketSector: string;
  name: string;
  issuerId: number | null;
  cik: string | null;
  gicsCode: string | null;
  gicsLevel: number | null;
  gicsName: string | null;
  gicsSectorName: string | null;
}

const CANDIDATE_COLUMNS = sql`
  i.instrument_id::text AS instrument_id, i.ticker, i.exch_code, i.market_sector, i.name,
  iss.issuer_id::text AS issuer_id, iss.cik,
  ec.code AS gics_code, cc.level AS gics_level, cc.name AS gics_name,
  sec.name AS gics_sector_name`;

type CandidateRow = Record<string, unknown> & {
  instrument_id: string;
  ticker: string;
  exch_code: string;
  market_sector: string;
  name: string;
  issuer_id: string | null;
  cik: string | null;
  gics_code: string | null;
  gics_level: number | null;
  gics_name: string | null;
  gics_sector_name: string | null;
};

const toCandidate = (r: CandidateRow): Candidate => ({
  instrumentId: Number(r.instrument_id),
  ticker: r.ticker,
  exchCode: r.exch_code,
  marketSector: r.market_sector,
  name: r.name,
  issuerId: r.issuer_id === null ? null : Number(r.issuer_id),
  cik: r.cik,
  gicsCode: r.gics_code,
  gicsLevel: r.gics_level,
  gicsName: r.gics_name,
  gicsSectorName: r.gics_sector_name,
});

/**
 * The as-of predicates every reference read repeats (REF-03). Written once here because the peer
 * query joins four bitemporal tables and a missing predicate on any one of them silently widens
 * the peer set with rows nobody could see at `ctx.asOf`.
 */
function asOfSql(ctx: ResolveContext): { validAt: string; knownAt: string } {
  return { validAt: ctx.asOf.validAt.toISOString(), knownAt: ctx.asOf.knownAt.toISOString() };
}

async function candidatesByGics(
  ctx: ResolveContext,
  code: string,
  targetInstrumentId: number,
  index: string | null,
): Promise<Candidate[]> {
  const { validAt, knownAt } = asOfSql(ctx);
  const restriction =
    index === null
      ? sql``
      : sql` AND EXISTS (
          SELECT 1 FROM index_members m
            JOIN indices x ON x.index_id = m.index_id
           WHERE x.code = ${index}
             AND m.instrument_id = i.instrument_id
             AND m.valid_from <= ${validAt}::timestamptz AND m.valid_to > ${validAt}::timestamptz
             AND m.tx_from <= ${knownAt}::timestamptz AND m.tx_to > ${knownAt}::timestamptz)`;

  const res = await ctx.db.execute<CandidateRow>(sql`
    SELECT ${CANDIDATE_COLUMNS}
      FROM instruments i
      JOIN issues isu ON isu.issue_id = i.issue_id
       AND isu.valid_from <= ${validAt}::timestamptz AND isu.valid_to > ${validAt}::timestamptz
       AND isu.tx_from <= ${knownAt}::timestamptz AND isu.tx_to > ${knownAt}::timestamptz
      JOIN issuers iss ON iss.issuer_id = isu.issuer_id
       AND iss.valid_from <= ${validAt}::timestamptz AND iss.valid_to > ${validAt}::timestamptz
       AND iss.tx_from <= ${knownAt}::timestamptz AND iss.tx_to > ${knownAt}::timestamptz
      JOIN entity_classifications ec ON ec.entity_kind = 'issuer' AND ec.entity_id = iss.issuer_id
       AND ec.scheme = 'GICS' AND left(ec.code, ${code.length}) = ${code}
       AND ec.valid_from <= ${validAt}::timestamptz AND ec.valid_to > ${validAt}::timestamptz
       AND ec.tx_from <= ${knownAt}::timestamptz AND ec.tx_to > ${knownAt}::timestamptz
      LEFT JOIN classification_codes cc ON cc.scheme = 'GICS' AND cc.code = ec.code
      LEFT JOIN classification_codes sec ON sec.scheme = 'GICS' AND sec.code = left(ec.code, 2)
     WHERE i.asset_class = 'equity'
       AND i.status = 'active'
       AND i.instrument_id <> ${String(targetInstrumentId)}::bigint
       AND i.valid_from <= ${validAt}::timestamptz AND i.valid_to > ${validAt}::timestamptz
       AND i.tx_from <= ${knownAt}::timestamptz AND i.tx_to > ${knownAt}::timestamptz
       ${restriction}
     ORDER BY i.instrument_id`);
  return res.rows.map(toCandidate);
}

async function candidatesBySic(
  ctx: ResolveContext,
  sic: string,
  targetInstrumentId: number,
): Promise<Candidate[]> {
  const { validAt, knownAt } = asOfSql(ctx);
  const res = await ctx.db.execute<CandidateRow>(sql`
    SELECT ${CANDIDATE_COLUMNS}
      FROM instruments i
      JOIN issues isu ON isu.issue_id = i.issue_id
       AND isu.valid_from <= ${validAt}::timestamptz AND isu.valid_to > ${validAt}::timestamptz
       AND isu.tx_from <= ${knownAt}::timestamptz AND isu.tx_to > ${knownAt}::timestamptz
      JOIN issuers iss ON iss.issuer_id = isu.issuer_id AND iss.sic = ${sic}
       AND iss.valid_from <= ${validAt}::timestamptz AND iss.valid_to > ${validAt}::timestamptz
       AND iss.tx_from <= ${knownAt}::timestamptz AND iss.tx_to > ${knownAt}::timestamptz
      LEFT JOIN entity_classifications ec ON ec.entity_kind = 'issuer' AND ec.entity_id = iss.issuer_id
       AND ec.scheme = 'GICS'
       AND ec.valid_from <= ${validAt}::timestamptz AND ec.valid_to > ${validAt}::timestamptz
       AND ec.tx_from <= ${knownAt}::timestamptz AND ec.tx_to > ${knownAt}::timestamptz
      LEFT JOIN classification_codes cc ON cc.scheme = 'GICS' AND cc.code = ec.code
      LEFT JOIN classification_codes sec ON sec.scheme = 'GICS' AND sec.code = left(ec.code, 2)
     WHERE i.asset_class = 'equity'
       AND i.status = 'active'
       AND i.instrument_id <> ${String(targetInstrumentId)}::bigint
       AND i.valid_from <= ${validAt}::timestamptz AND i.valid_to > ${validAt}::timestamptz
       AND i.tx_from <= ${knownAt}::timestamptz AND i.tx_to > ${knownAt}::timestamptz
     ORDER BY i.instrument_id`);
  return res.rows.map(toCandidate);
}

async function candidatesByIds(
  ctx: ResolveContext,
  ids: readonly number[],
): Promise<Candidate[]> {
  if (ids.length === 0) return [];
  const { validAt, knownAt } = asOfSql(ctx);
  const list = sql.join(
    ids.map((id) => sql`${String(id)}::bigint`),
    sql`, `,
  );
  const res = await ctx.db.execute<CandidateRow>(sql`
    SELECT ${CANDIDATE_COLUMNS}
      FROM instruments i
      LEFT JOIN issues isu ON isu.issue_id = i.issue_id
       AND isu.valid_from <= ${validAt}::timestamptz AND isu.valid_to > ${validAt}::timestamptz
       AND isu.tx_from <= ${knownAt}::timestamptz AND isu.tx_to > ${knownAt}::timestamptz
      LEFT JOIN issuers iss ON iss.issuer_id = isu.issuer_id
       AND iss.valid_from <= ${validAt}::timestamptz AND iss.valid_to > ${validAt}::timestamptz
       AND iss.tx_from <= ${knownAt}::timestamptz AND iss.tx_to > ${knownAt}::timestamptz
      LEFT JOIN entity_classifications ec ON ec.entity_kind = 'issuer' AND ec.entity_id = iss.issuer_id
       AND ec.scheme = 'GICS'
       AND ec.valid_from <= ${validAt}::timestamptz AND ec.valid_to > ${validAt}::timestamptz
       AND ec.tx_from <= ${knownAt}::timestamptz AND ec.tx_to > ${knownAt}::timestamptz
      LEFT JOIN classification_codes cc ON cc.scheme = 'GICS' AND cc.code = ec.code
      LEFT JOIN classification_codes sec ON sec.scheme = 'GICS' AND sec.code = left(ec.code, 2)
     WHERE i.instrument_id IN (${list})
       AND i.valid_from <= ${validAt}::timestamptz AND i.valid_to > ${validAt}::timestamptz
       AND i.tx_from <= ${knownAt}::timestamptz AND i.tx_to > ${knownAt}::timestamptz
     ORDER BY i.instrument_id`);
  return res.rows.map(toCandidate);
}

/** The current members of one index, by its `indices.code`. */
async function indexMemberIds(ctx: ResolveContext, code: string): Promise<number[]> {
  const { validAt, knownAt } = asOfSql(ctx);
  const res = await ctx.db.execute<{ instrument_id: string }>(sql`
    SELECT m.instrument_id::text AS instrument_id
      FROM index_members m
      JOIN indices x ON x.index_id = m.index_id
     WHERE x.code = ${code}
       AND m.valid_from <= ${validAt}::timestamptz AND m.valid_to > ${validAt}::timestamptz
       AND m.tx_from <= ${knownAt}::timestamptz AND m.tx_to > ${knownAt}::timestamptz
     ORDER BY m.instrument_id`);
  return res.rows.map((r) => Number(r.instrument_id));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Statistics (§RV step 7)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `p = (n−1)·q`, linear interpolation between the neighbouring order statistics. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] ?? null;
  const p = (sorted.length - 1) * q;
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  const a = sorted[lo];
  const b = sorted[hi];
  if (a === undefined || b === undefined) return null;
  return a + (p - lo) * (b - a);
}

export function statFor(metric: RvStat['metric'], peerValues: readonly number[], target: number | null): RvStat {
  const sorted = [...peerValues].sort((a, b) => a - b);
  const n = sorted.length;
  if (n < 3) {
    return {
      metric,
      n,
      min: null,
      p25: null,
      median: null,
      p75: null,
      max: null,
      mean: null,
      target,
      targetPercentile: null,
      premiumToMedianPct: null,
      reason: 'INSUFFICIENT_PEERS',
    };
  }
  const median = quantile(sorted, 0.5);
  return {
    metric,
    n,
    min: sorted[0] ?? null,
    p25: quantile(sorted, 0.25),
    median,
    p75: quantile(sorted, 0.75),
    max: sorted[n - 1] ?? null,
    mean: sorted.reduce((s, v) => s + v, 0) / n,
    target,
    targetPercentile:
      target === null ? null : sorted.filter((v) => v <= target).length / n,
    premiumToMedianPct:
      target === null || median === null || median === 0 ? null : target / median - 1,
    reason: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Multiples (§RV step 6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ratio = (a: number | null, b: number | null): number | null => {
  if (a === null || b === null || b <= 0) return null;
  const v = a / b;
  return Number.isFinite(v) ? v : null;
};

const pct = (v: number | null): number | null => (v === null ? null : v * 100);

/** Every input a row's multiples are computed from, gathered before any cell is built. */
interface RowInputs {
  candidate: Candidate;
  statements: FinStatement[];
  sharesOut: number | null;
  sharesProvIdx: number;
  dividend12m: number | null;
  dividendProvIdx: number;
  ret1y: number | null;
  quote: { px: ValueCell; chgPct: ValueCell };
  fundamentalsProvIdx: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

const equity: FunctionResolver<RvParams, RvPayload> = async (ctx, params) => {
  const instrumentRow = ctx.instrument;
  if (instrumentRow === null) {
    throw new Error('RV: requiresSecurity is true, so the runner must supply an instrument');
  }
  const knownAt = knownAtOf(ctx, params.knownAt);
  const detail = await ctx.data.reference.instrument(instrumentRow.instrumentId);
  const targetCik = detail.issuer?.cik ?? null;
  const notes: string[] = [];

  // ── 1. the target as a candidate ─────────────────────────────────────────────────────────
  const targetGics = detail.classifications.filter(
    (c) => c.scheme === 'GICS' && c.entityKind === 'issuer',
  );
  const deepestGics = [...targetGics].sort((a, b) => b.code.length - a.code.length)[0] ?? null;
  const sectorRow = targetGics.find((c) => c.code.length === 2) ?? null;
  const targetCandidate: Candidate = {
    instrumentId: detail.instrument.instrumentId,
    ticker: detail.instrument.ticker,
    exchCode: detail.instrument.exchCode,
    marketSector: detail.instrument.marketSector,
    name: detail.instrument.name,
    issuerId: detail.issuer?.issuerId ?? null,
    cik: targetCik,
    gicsCode: deepestGics?.code ?? null,
    gicsLevel: deepestGics?.level ?? null,
    gicsName: deepestGics?.name ?? null,
    gicsSectorName: sectorRow?.name ?? null,
  };

  if (targetCik === null || targetCik === '') {
    ctx.unavailable.add({
      field: 'target',
      reason: 'NO_SOURCE',
      detail:
        'issuer has no SEC CIK (not an SEC filer); multiples cannot be computed',
    });
  }

  // ── 2. the peer set ──────────────────────────────────────────────────────────────────────
  const requestedBasis: RvPeerBasis = params.peerBasis;
  let basis: RvPeerBasis = requestedBasis;
  let scheme: RvPeerSet['scheme'] = 'GICS';
  let code: string | null = null;
  let label = '';
  let candidates: Candidate[] = [];
  let peerSetProvenanceId: number | null = deepestGics?.provenanceId ?? null;
  const restrictedToIndex =
    params.peerBasis === 'CUSTOM' || params.peerBasis === 'INDEX'
      ? null
      : params.restrictToIndex
        ? params.index
        : null;

  if (params.peerBasis === 'CUSTOM') {
    scheme = 'CUSTOM';
    label = 'Custom peer list';
    const ids: number[] = [];
    for (const ref of params.peers) {
      const resolved = await ctx.data.reference.resolve(ref);
      const id = resolved.instrument?.instrumentId ?? null;
      if (id === null) {
        ctx.unavailable.add({
          field: 'peers',
          reason: 'NO_SOURCE',
          detail: `${ref} did not resolve to an instrument`,
        });
        continue;
      }
      if (id !== targetCandidate.instrumentId) ids.push(id);
    }
    candidates = await candidatesByIds(ctx, ids);
  } else if (params.peerBasis === 'INDEX') {
    scheme = 'INDEX';
    code = params.index;
    label = `${params.index} members`;
    const ids = (await indexMemberIds(ctx, params.index)).filter(
      (id) => id !== targetCandidate.instrumentId,
    );
    candidates = await candidatesByIds(ctx, ids);
  } else {
    const digits = GICS_DIGITS[params.peerBasis] ?? 8;
    const target = targetGics.find((c) => c.code.length === digits)?.code ??
      (deepestGics !== null && deepestGics.code.length > digits
        ? deepestGics.code.slice(0, digits)
        : null);
    if (target !== null) {
      code = target;
      const name =
        targetGics.find((c) => c.code === target)?.name ??
        (await codeName(ctx, target)) ??
        target;
      label = `${name} (GICS ${target})`;
      candidates = await candidatesByGics(
        ctx,
        target,
        targetCandidate.instrumentId,
        restrictedToIndex,
      );
    } else if (detail.issuer?.sic != null && detail.issuer.sic !== '') {
      // Offline, only the S&P 500 names carry GICS (`wiki.sp500`), so this is the ordinary path
      // for everything else — and it says so rather than returning an empty screen.
      basis = 'SIC';
      scheme = 'SIC';
      code = detail.issuer.sic;
      label = `${detail.issuer.sicDescription ?? 'SIC'} (SIC ${detail.issuer.sic})`;
      notes.push('PEER_BASIS_FALLBACK_SIC');
      peerSetProvenanceId = detail.issuer.provenanceId;
      ctx.unavailable.add({
        field: 'peerSet',
        reason: 'NO_SOURCE',
        detail:
          'NO_GICS_CLASSIFICATION: no GICS row for this issuer (GICS is seeded for S&P 500 ' +
          `members only); peers taken from SIC ${detail.issuer.sic}`,
      });
      candidates = await candidatesBySic(ctx, detail.issuer.sic, targetCandidate.instrumentId);
    } else {
      scheme = 'SIC';
      label = 'No peer basis';
      ctx.unavailable.add({
        field: 'peerSet',
        reason: 'NO_SOURCE',
        detail:
          'NO_PEER_BASIS: issuer has neither a GICS nor a SIC classification; pass peers ' +
          'explicitly (RV CUSTOM …)',
      });
    }
  }

  const candidateCount = candidates.length;

  // ── 3. rank and truncate ─────────────────────────────────────────────────────────────────
  // `CUR_MKT_CAP` ranking needs the market caps, which need the quotes — so the ordering is
  // applied after the cells are built, on the rows themselves. Here only `name` can be applied
  // cheaply; the rest is a stable id order that the later sort refines.
  const ordered =
    params.rank === 'name'
      ? [...candidates].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      : candidates;

  const cite = await citeMany(ctx, [peerSetProvenanceId]);
  const peerSetProvIdx = cite.get(peerSetProvenanceId ?? -1) ?? -1;

  // ── 4. quotes (no DB round-trip) ─────────────────────────────────────────────────────────
  const all = [targetCandidate, ...ordered];
  const subjects = all.map((c) => ctx.plant.subjectFor(c.instrumentId));
  ctx.plant.ensureHot(subjects);
  const states = ctx.plant.snapshotMany(subjects);

  // ── 5. fundamentals ──────────────────────────────────────────────────────────────────────
  if (targetCik !== null && targetCik !== '') {
    const probe = await ctx.data.fundamentals.statementsForCik(targetCik, {
      statement: 'IS',
      periodType: params.periodType,
      periods: 1,
      knownAt,
      at: ctx.asOf,
    });
    if (probe.length === 0) await tryEnsure(ctx, 'sec.companyfacts', targetCik, DAY_MS);
  }

  const wantRet1y = params.metrics.includes('RET_1Y');
  const asOfDate = isoDay(ctx.asOf.validAt.getTime());
  const inputs: RowInputs[] = [];
  for (const candidate of all) {
    const subject = ctx.plant.subjectFor(candidate.instrumentId);
    const state = states.get(subject);
    const quote = {
      px: cellFromState(ctx, state, 'PX_LAST', subject),
      chgPct: cellFromState(ctx, state, 'CHG_PCT_1D', subject),
    };
    const statements =
      candidate.cik === null
        ? []
        : await ctx.data.fundamentals.statementsForCik(candidate.cik, {
            statement: 'IS',
            periodType: params.periodType,
            periods: 5,
            knownAt,
            at: ctx.asOf,
          });
    const fundamentalsCite = await citeMany(
      ctx,
      statements.map((s) => s.provenanceIds[0]),
    );
    const shares =
      candidate.cik === null
        ? []
        : await ctx.data.fundamentals.facts(
            {
              cik: candidate.cik,
              concepts: ['dei:EntityCommonStockSharesOutstanding'],
              periods: 'any',
              limit: 1,
            },
            knownAt,
          );
    const sharesFact = shares[0];
    const sharesCite = await citeMany(ctx, [sharesFact?.provenanceId]);
    const dividends = await dividends12m(ctx, candidate.instrumentId, asOfDate);
    const dividendCite = await citeMany(ctx, [dividends.provenanceId]);
    const ret1y = wantRet1y ? await ret1yFor(ctx, candidate.instrumentId, asOfDate) : null;

    inputs.push({
      candidate,
      statements,
      sharesOut: sharesFact?.value ?? null,
      sharesProvIdx: sharesCite.get(sharesFact?.provenanceId ?? -1) ?? -1,
      dividend12m: dividends.amount,
      dividendProvIdx: dividendCite.get(dividends.provenanceId ?? -1) ?? -1,
      ret1y,
      quote,
      fundamentalsProvIdx: fundamentalsCite.get(statements[0]?.provenanceIds[0] ?? -1) ?? -1,
    });
  }

  // ── 6. the rows ──────────────────────────────────────────────────────────────────────────
  const metrics = params.metrics.map(rvColumn);
  const rows = inputs.map((input) =>
    buildRow(ctx, input, params, input.candidate.instrumentId === targetCandidate.instrumentId),
  );
  const target = rows[0];
  if (target === undefined) throw new Error('RV: the target row is always present');
  let peers = rows.slice(1);

  // The market-cap ranking, now that the caps exist. Nulls last, always.
  const rankMetric = params.rank === 'metric' ? (params.metrics[0] ?? 'CUR_MKT_CAP') : 'CUR_MKT_CAP';
  if (params.rank !== 'name') {
    peers = [...peers].sort((a, b) => {
      const av = numberOf(a.cells[rankMetric]);
      const bv = numberOf(b.cells[rankMetric]);
      if (av === null && bv === null) return a.instrumentId - b.instrumentId;
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });
  }
  if (peers.length > params.maxPeers) {
    peers = peers.slice(0, params.maxPeers);
    notes.push('PEERS_TRUNCATED');
  }

  // ── 7. statistics ────────────────────────────────────────────────────────────────────────
  const stats = params.metrics.map((metric) => {
    const values = peers.flatMap((p) => {
      const v = numberOf(p.cells[metric]);
      return v === null ? [] : [v];
    });
    const stat = statFor(metric, values, numberOf(target.cells[metric]));
    if (stat.reason === 'INSUFFICIENT_PEERS') {
      ctx.unavailable.add({
        field: metric,
        reason: 'NO_SOURCE',
        detail:
          `INSUFFICIENT_PEERS: ${String(stat.n)} peers have a value for ${metric}; at least 3 ` +
          'are needed for a median',
      });
    }
    return stat;
  });

  // ── 8. what is missing, counted ──────────────────────────────────────────────────────────
  const missing = peers.filter((p) => p.unavailableReason === 'FUNDAMENTALS_NOT_INGESTED').length;
  if (missing > 0) {
    notes.push('FUNDAMENTALS_NOT_INGESTED');
    ctx.unavailable.add({
      field: 'peers',
      reason: 'NO_SOURCE',
      detail:
        `FUNDAMENTALS_NOT_INGESTED: SEC companyfacts are not ingested for ${String(missing)} of ` +
        `${String(peers.length)} peers; their multiple cells are blank and they are excluded ` +
        'from the statistics',
    });
  }

  return {
    variant: 'equity',
    target,
    peerSet: {
      basis,
      requestedBasis,
      scheme,
      code,
      label,
      restrictedToIndex,
      candidates: candidateCount,
      returned: peers.length,
      provIdx: peerSetProvIdx,
    },
    metrics,
    peers,
    stats,
    periodType: params.periodType,
    knownAt: knownAt.toISOString(),
    notes,
  };
};

const numberOf = (cell: ValueCell | undefined): number | null =>
  typeof cell?.v === 'number' && Number.isFinite(cell.v) ? cell.v : null;

/** A stored (non-live) cell. A finite number with nothing to cite is not emitted (DATA-10). */
function storedValue(v: number | null, provIdx: number, ts: number | null): ValueCell {
  if (v === null || provIdx < 0) return { v: null, st: 'na', provIdx: -1 };
  return { v, st: 'closed', ts, provIdx };
}

function buildRow(
  ctx: ResolveContext,
  input: RowInputs,
  params: RvParams,
  isTarget: boolean,
): RvRow {
  const { candidate, statements, quote } = input;
  const latest = statements[0] ?? null;
  const priorYear =
    latest === null
      ? undefined
      : statements.find(
          (s) =>
            s.fiscalPeriod === latest.fiscalPeriod &&
            latest.fiscalYear !== null &&
            s.fiscalYear === latest.fiscalYear - 1,
        );
  const provIdx = input.fundamentalsProvIdx;
  const filedMs = latest === null ? null : Date.parse(`${latest.filedAt}T00:00:00Z`);
  const px = numberOf(quote.px);
  const quoteIdx = quote.px.provIdx;

  const marketCap =
    px === null || input.sharesOut === null ? null : px * input.sharesOut;
  const marketCapIdx = quoteIdx >= 0 ? quoteIdx : input.sharesProvIdx;
  const ebitda = latest?.operInc == null ? null : latest.operInc + (latest.dda ?? 0);
  const enterpriseValue =
    marketCap === null || latest === null
      ? null
      : marketCap + (latest.ltDebt ?? 0) - (latest.cash ?? 0);

  const cells: Record<string, ValueCell> = {};
  for (const metric of params.metrics) {
    switch (metric) {
      case 'PX_LAST':
        cells[metric] = quote.px;
        break;
      case 'CHG_PCT_1D':
        cells[metric] = quote.chgPct;
        break;
      case 'CUR_MKT_CAP':
        cells[metric] = storedValue(marketCap, marketCapIdx, filedMs);
        break;
      case 'RET_1Y':
        cells[metric] = storedValue(input.ret1y, input.ret1y === null ? -1 : quoteIdx, null);
        break;
      case 'PE_RATIO':
        cells[metric] = storedValue(ratio(px, latest?.epsDil ?? null), provIdx, filedMs);
        break;
      case 'PX_TO_BOOK_RATIO':
        cells[metric] = storedValue(ratio(marketCap, latest?.equity ?? null), provIdx, filedMs);
        break;
      case 'PX_TO_SALES_RATIO':
        cells[metric] = storedValue(ratio(marketCap, latest?.revenue ?? null), provIdx, filedMs);
        break;
      case 'EV_TO_EBITDA': {
        const value = ratio(enterpriseValue, ebitda);
        if (value === null && ebitda !== null && ebitda <= 0) {
          ctx.unavailable.add({
            field: 'EV_TO_EBITDA',
            reason: 'NOT_APPLICABLE',
            detail: `EBITDA is not positive for ${displayOf(candidate.ticker, candidate.exchCode, candidate.marketSector as never)}`,
          });
        }
        cells[metric] = storedValue(value, provIdx, filedMs);
        break;
      }
      case 'DVD_YIELD':
        cells[metric] = storedValue(
          pct(ratio(input.dividend12m, px)),
          input.dividendProvIdx,
          filedMs,
        );
        break;
      case 'NET_MARGIN':
        cells[metric] = storedValue(
          pct(ratio(latest?.netInc ?? null, latest?.revenue ?? null)),
          provIdx,
          filedMs,
        );
        break;
      case 'RETURN_COM_EQY':
        cells[metric] = storedValue(
          pct(ratio(latest?.netInc ?? null, latest?.equity ?? null)),
          provIdx,
          filedMs,
        );
        break;
      case 'SALES_GROWTH_YOY': {
        const now = latest?.revenue ?? null;
        const then = priorYear?.revenue ?? null;
        const growth = now === null || then === null || then <= 0 ? null : (now / then - 1) * 100;
        cells[metric] = storedValue(growth, provIdx, filedMs);
        break;
      }
      case 'SALES_REV_TURN':
        cells[metric] = storedValue(latest?.revenue ?? null, provIdx, filedMs);
        break;
      case 'NET_INCOME':
        cells[metric] = storedValue(latest?.netInc ?? null, provIdx, filedMs);
        break;
      case 'IS_EPS_DIL':
        cells[metric] = storedValue(latest?.epsDil ?? null, provIdx, filedMs);
        break;
      case 'BS_TOT_ASSET':
        cells[metric] = storedValue(latest?.totAssets ?? null, provIdx, filedMs);
        break;
      case 'TOTAL_EQUITY':
        cells[metric] = storedValue(latest?.equity ?? null, provIdx, filedMs);
        break;
      case 'FREE_CASH_FLOW':
        cells[metric] = storedValue(latest?.fcf ?? null, provIdx, filedMs);
        break;
    }
  }

  const resolved = params.metrics.filter((m) => numberOf(cells[m]) !== null).length;
  const dataState: RvRow['dataState'] =
    latest === null ? 'none' : resolved === params.metrics.length ? 'full' : 'partial';
  const unavailableReason: RvRow['unavailableReason'] =
    candidate.cik === null || candidate.cik === ''
      ? 'NO_CIK'
      : latest === null
        ? 'FUNDAMENTALS_NOT_INGESTED'
        : null;

  return {
    instrumentId: candidate.instrumentId,
    key: displayOf(candidate.ticker, candidate.exchCode, candidate.marketSector as never),
    name: candidate.name,
    subject: ctx.plant.subjectFor(candidate.instrumentId),
    issuerId: candidate.issuerId,
    cik: candidate.cik,
    exchCode: candidate.exchCode,
    gicsSector: candidate.gicsSectorName,
    gicsSubIndustry: candidate.gicsLevel === 4 ? candidate.gicsName : null,
    isTarget,
    cells,
    fundamentals:
      latest === null
        ? null
        : {
            periodEnd: latest.periodEnd,
            periodType: params.periodType,
            filedAt: latest.filedAt,
            accessionNo: latest.accessionNo.trim(),
            provIdx,
          },
    dataState,
    unavailableReason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The two reads that are not statements
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `DVD_SH_12M` per TIER1 §0.3: cash dividends with an ex-date in the trailing 365 days. */
async function dividends12m(
  ctx: ResolveContext,
  instrumentId: number,
  asOfDate: string,
): Promise<{ amount: number | null; provenanceId: number | null }> {
  const from = isoDay(Date.parse(`${asOfDate}T00:00:00Z`) - 365 * DAY_MS);
  const res = await ctx.db.execute<{ total: string | null; provenance_id: string | null }>(sql`
    SELECT sum(amount)::text AS total, max(provenance_id)::text AS provenance_id
      FROM corporate_actions
     WHERE instrument_id = ${String(instrumentId)}::bigint
       AND ca_type = 'cash_dividend'
       AND status IN ('announced', 'confirmed', 'paid')
       AND ex_date > ${from}::date
       AND ex_date <= ${asOfDate}::date
       AND tx_to = 'infinity'`);
  const row = res.rows[0];
  const total = row?.total === null || row?.total === undefined ? null : Number(row.total);
  return {
    amount: total === null || !Number.isFinite(total) ? null : total,
    provenanceId: row?.provenance_id == null ? null : Number(row.provenance_id),
  };
}

/** `RET_1Y` through the shared §0.6 statistics, on the instrument's own venue calendar. */
async function ret1yFor(
  ctx: ResolveContext,
  instrumentId: number,
  asOfDate: string,
): Promise<number | null> {
  const calendar = await calendarFor(ctx, instrumentId);
  if (calendar === null) return null;
  let bars: PeriodBar[];
  try {
    const block = await ctx.data.historical.bars(instrumentId, {
      start: isoDay(Date.parse(`${asOfDate}T00:00:00Z`) - BAR_WINDOW_DAYS * DAY_MS),
      end: asOfDate,
      periodicity: 'D',
      adjust: 'price',
      fields: ['PX_LAST'],
    });
    const close = block.columns.indexOf('PX_LAST');
    bars = block.index.flatMap((date, i) => {
      const row = block.rows[i];
      if (row === undefined || close < 0) return [];
      return [{ date, close: row[close] ?? null }];
    });
  } catch {
    return null;
  }
  const result = periodReturns(bars, calendar, asOfDate);
  recordPeriodMeta(ctx, { unavailable: [], engine: result.engine });
  return result.ret1y;
}

/** `instruments.primary_listing_id → listings.mic → exchanges.calendar_id`, materialised. */
async function calendarFor(ctx: ResolveContext, instrumentId: number): Promise<Calendar | null> {
  const { validAt, knownAt } = asOfSql(ctx);
  const res = await ctx.db.execute<{ calendar_id: string | null }>(sql`
    SELECT e.calendar_id
      FROM instruments i
      JOIN listings l ON l.listing_id = i.primary_listing_id
       AND l.valid_from <= ${validAt}::timestamptz AND l.valid_to > ${validAt}::timestamptz
       AND l.tx_from <= ${knownAt}::timestamptz AND l.tx_to > ${knownAt}::timestamptz
      JOIN exchanges e ON e.mic = l.mic
     WHERE i.instrument_id = ${String(instrumentId)}::bigint
       AND i.valid_from <= ${validAt}::timestamptz AND i.valid_to > ${validAt}::timestamptz
       AND i.tx_from <= ${knownAt}::timestamptz AND i.tx_to > ${knownAt}::timestamptz
     LIMIT 1`);
  const id = res.rows[0]?.calendar_id ?? null;
  if (id === null) return null;
  return ctx.data.reference.calendar(id).catch(() => null);
}

/** `classification_codes.name` for a code the target's own rows did not carry. */
async function codeName(ctx: ResolveContext, code: string): Promise<string | null> {
  const res = await ctx.db.execute<{ name: string }>(sql`
    SELECT name FROM classification_codes WHERE scheme = 'GICS' AND code = ${code} LIMIT 1`);
  return res.rows[0]?.name ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────────────────────────

export { equity };

export const resolve: FunctionResolver<RvParams, RvPayload> = equity;

export const variants = { equity };

const module_: FunctionServerModule<RvParams, RvPayload> = { resolve, variants };

export default module_;
