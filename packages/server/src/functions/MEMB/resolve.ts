/**
 * `functions/MEMB/resolve.ts` — index constituents (FUNCTIONS_TIER2.md §MEMB L1797-1808).
 *
 * The resolver's whole job is to say, for every number it shows, which file it came from — and to
 * refuse to show one when no file carries it.
 *
 * ## Three sources, not one
 *
 * A MEMB payload cites the membership file (`sec.archives` N-PORT or `ssga.holdings`) for the
 * roster, the weights, the shares and the market values, and `wiki.sp500` for the GICS sector,
 * because **neither membership source carries a sector**: the N-PORT XML publishes `assetCat` and
 * `issuerCat` (regulatory categories, not GICS), and the SSGA sheet's `Sector` column is the
 * literal `-` on every sampled row. So the sector column is a join into `entity_classifications`
 * against a third, CC BY-SA licensed source, and both attributions travel in `meta.provenance`
 * (DATA-09). A member with no GICS row is `null` with an `unavailable` entry — the honest answer,
 * and the one the acceptance row requires; §MEMB step 5's "no `unavailable` entry" reading would
 * also leave the runner's rule-3 check with an unexplained gap.
 *
 * ## What the reader gives and what this file has to add
 *
 * `data.reference.members` returns the roster as of `(asOfDate, knownAt)` with each row's
 * `provIdx` already registered, and it **drops** a constituent whose instrument row cannot be read
 * at that instant, counting it in `unresolved`. §MEMB's payload wants those lines listed with
 * `instrumentId: null`; they are not reachable through the reader, so `unresolved.count` carries
 * them and `UNRESOLVED_CONSTITUENTS` names them. That is a narrower answer than the spec's, and it
 * is recorded here rather than worked around with a second raw read of `index_members`.
 *
 * ## No provider call for a missing source
 *
 * An index with `indices.membership_source_id IS NULL` returns `members: []` and
 * `NO_MEMBERSHIP_SOURCE`. Nothing is fetched, nothing is guessed: the reachable world publishes no
 * constituent list for it, and a partial list would be worse than none.
 */

import { sql } from 'drizzle-orm';

import type {
  MembChangeRow,
  MembChanges,
  MembGroup,
  MembIndexBlock,
  MembMember,
  MembParams,
  MembPayload,
  MembVia,
  MembWeightMove,
} from '@terminal/core/functions/manifests/MEMB';
import {
  MEMB_MAX_AVAILABLE_DATES,
  MEMB_MAX_WEIGHT_MOVES,
  MEMB_NOTE_GICS_NOT_IN_SOURCE,
  MEMB_NOTE_HISTORY_LIMITED,
  MEMB_NOTE_NO_SOURCE,
  MEMB_NOTE_UNRESOLVED,
  MEMB_NOTE_VIA_PROXY,
  MEMB_UNCLASSIFIED,
  MEMB_WEIGHT_MOVE_FLOOR,
} from '@terminal/core/functions/manifests/MEMB';

import type { MemberView, MembersResponse } from '../../data/reference.js';
import type { EtfHolding } from '../../data/holdings.js';
import { findIndexByInstrumentId } from '../../refdata/indexMembership.js';
import type { IndexRecord } from '../../refdata/indexMembership.js';
import type { ResolveContext } from '../context.js';
import { cellFromState } from '../shared/cells.js';
import { displayOf } from '../shared/instrumentSummary.js';


// ─────────────────────────────────────────────────────────────────────────────────────────────
// Citing a reader's provenance into the payload's own index
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface ProvRow extends Record<string, unknown> {
  provenance_id: string;
  source_id: string;
  captured_at: string;
  source_ts: string | null;
}

/**
 * `provenance_id` → the index into `meta.provenance`, for rows a data service read.
 *
 * This is not redundant with the `provIdx` those readers already return. `buildDataServices` is
 * handed its **own** `ProvenanceIndex` (`http/routes/functions.ts`), separate from `ctx.prov`, so a
 * `MemberView.provIdx` indexes an array the payload never carries — citing it in a payload would
 * point a reader's `Ctrl+I` at whatever happened to sit at that position in `meta.provenance`, or
 * at nothing. The honest move is to re-cite the row's `provenanceId` through `ctx.prov`, which is
 * idempotent, so one membership file is one entry however many rows rest on it.
 *
 * Exported because CACS, CN and EQS have exactly the same problem with the same readers.
 */
export async function citeProvenanceIds(
  ctx: ResolveContext,
  provenanceIds: readonly number[],
  fallbackTier: 'eod' | 'delayed' = 'eod',
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const distinct = [...new Set(provenanceIds)];
  if (distinct.length === 0) return out;
  const res = await ctx.db.execute<ProvRow>(sql`
    SELECT provenance_id::text AS provenance_id, source_id,
           to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
           to_char(source_ts  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS source_ts
      FROM provenance
     WHERE provenance_id = ANY(${sql.param(distinct.map(String))}::bigint[])`);
  for (const row of res.rows) {
    const provenanceId = Number(row.provenance_id);
    out.set(
      provenanceId,
      ctx.prov.add({
        sourceId: row.source_id,
        provenanceId,
        capturedAt: new Date(row.captured_at),
        sourceTs: row.source_ts === null ? null : new Date(row.source_ts),
        st: 'closed',
        tier: fallbackTier,
      }),
    );
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

interface DateRow extends Record<string, unknown> {
  as_of_date: string;
}

/** Every captured `as_of_date` for this index, newest first, as-of `ctx.asOf.knownAt` (REF-03). */
async function availableDates(
  ctx: ResolveContext,
  indexId: number,
  sourceId: string | null,
): Promise<string[]> {
  const knownAt = ctx.asOf.knownAt.toISOString();
  const res = await ctx.db.execute<DateRow>(sql`
    SELECT DISTINCT to_char(m.as_of_date, 'YYYY-MM-DD') AS as_of_date
      FROM index_members m
     WHERE m.index_id = ${indexId}::bigint
       AND m.tx_from <= ${knownAt}::timestamptz
       AND m.tx_to   >  ${knownAt}::timestamptz
       AND (${sourceId}::text IS NULL OR m.source_id = ${sourceId}::text)
     ORDER BY as_of_date DESC
     LIMIT ${MEMB_MAX_AVAILABLE_DATES}`);
  return res.rows.map((r) => r.as_of_date);
}

interface IndexTermsRow extends Record<string, unknown> {
  provider: string | null;
  methodology: string | null;
  calc_currency: string | null;
  constituent_count: number | null;
}

async function indexTerms(
  ctx: ResolveContext,
  instrumentId: number,
): Promise<IndexTermsRow | undefined> {
  const validAt = ctx.asOf.validAt.toISOString();
  const knownAt = ctx.asOf.knownAt.toISOString();
  const res = await ctx.db.execute<IndexTermsRow>(sql`
    SELECT provider, methodology, calc_currency, constituent_count
      FROM index_terms
     WHERE instrument_id = ${instrumentId}::bigint
       AND bt_as_of(valid_from, valid_to, tx_from, tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
     LIMIT 1`);
  return res.rows[0];
}

interface SectorRow extends Record<string, unknown> {
  instrument_id: string;
  sector: string | null;
  source_id: string | null;
  provenance_id: string | null;
  captured_at: string | null;
}

/**
 * GICS level-1 name per member, with the provenance row of the classification version that
 * supplied it — the second attribution a MEMB payload carries (DATA-09).
 *
 * The classification may sit on the instrument or on its issuer (the `wiki.sp500` capture assigns
 * by issuer); the instrument's own row wins when both exist, which is the same precedence QM uses.
 */
async function sectorsFor(
  ctx: ResolveContext,
  ids: readonly number[],
): Promise<Map<number, SectorRow>> {
  const out = new Map<number, SectorRow>();
  if (ids.length === 0) return out;
  const validAt = ctx.asOf.validAt.toISOString();
  const knownAt = ctx.asOf.knownAt.toISOString();
  const res = await ctx.db.execute<SectorRow>(sql`
    SELECT ins.instrument_id::text AS instrument_id,
           gics.name               AS sector,
           gics.source_id          AS source_id,
           gics.provenance_id::text AS provenance_id,
           to_char(gics.captured_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at
      FROM instruments ins
      LEFT JOIN issues iss
        ON iss.issue_id = ins.issue_id
       AND bt_as_of(iss.valid_from, iss.valid_to, iss.tx_from, iss.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
      LEFT JOIN LATERAL (
        SELECT c.name, p.source_id, p.provenance_id, p.captured_at
          FROM entity_classifications ec
          JOIN classification_codes c ON c.scheme = 'GICS' AND c.code = left(ec.code, 2)
          JOIN provenance p ON p.provenance_id = ec.provenance_id
         WHERE ec.scheme = 'GICS'
           AND ((ec.entity_kind = 'instrument' AND ec.entity_id = ins.instrument_id)
             OR (ec.entity_kind = 'issuer' AND ec.entity_id = iss.issuer_id))
           AND bt_as_of(ec.valid_from, ec.valid_to, ec.tx_from, ec.tx_to,
                        ${validAt}::timestamptz, ${knownAt}::timestamptz)
         ORDER BY (ec.entity_kind = 'instrument') DESC
         LIMIT 1
      ) gics ON true
     WHERE ins.instrument_id = ANY(${sql.param(ids.map(String))}::bigint[])
       AND bt_as_of(ins.valid_from, ins.valid_to, ins.tx_from, ins.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)`);
  for (const row of res.rows) out.set(Number(row.instrument_id), row);
  return out;
}

/** The proxy fund's holdings line per member, for `cusip`/`isin`/`assetCat`/`country`. */
async function holdingLines(
  ctx: ResolveContext,
  fundInstrumentId: number | null,
  asOfDate: string,
): Promise<Map<number, EtfHolding>> {
  const out = new Map<number, EtfHolding>();
  if (fundInstrumentId === null) return out;
  let lines: EtfHolding[];
  try {
    lines = await ctx.data.holdings.etfHoldings(fundInstrumentId, asOfDate);
  } catch {
    // A fund with no holdings file at that date enriches nothing; the membership still stands.
    return out;
  }
  for (const line of lines) {
    if (line.holdingInstrumentId === null) continue;
    out.set(line.holdingInstrumentId, line);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Sorting and paging (§MEMB step 6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Cursor {
  w?: number | null;
  k?: string | null;
  n: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function compareMembers(sort: MembParams['sort'], a: MembMember, b: MembMember): number {
  if (sort === 'weight' || sort === 'shares') {
    const av = (sort === 'weight' ? a.weight : a.shares) ?? Number.NEGATIVE_INFINITY;
    const bv = (sort === 'weight' ? b.weight : b.shares) ?? Number.NEGATIVE_INFINITY;
    if (av !== bv) return bv - av;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  }
  const av = (sort === 'key' ? a.key : a.name) ?? '';
  const bv = (sort === 'key' ? b.key : b.name) ?? '';
  if (av !== bv) return av < bv ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The payload an index with no reachable constituent source returns (§MEMB step 2). */
function noSourcePayload(
  ctx: ResolveContext,
  variant: 'index' | 'default',
  index: MembIndexBlock,
  asOfDate: string,
): MembPayload {
  ctx.unavailable.add({
    field: 'members',
    reason: 'NO_SOURCE',
    detail:
      `${MEMB_NOTE_NO_SOURCE}: this index has no reachable constituent source — no N-PORT proxy ` +
      'fund and no issuer holdings file are published for it (BRIEF §2); the index level and ' +
      'history are still available on GP and WEI',
  });
  return {
    variant,
    index,
    membership: {
      asOfDate,
      sourceId: '',
      via: { kind: 'direct' },
      count: 0,
      weightSum: 0,
      availableDates: [],
      provIdx: -1,
    },
    members: [],
    groups: [],
    changes: null,
    unresolved: { count: 0, reason: null },
    notes: [MEMB_NOTE_NO_SOURCE],
  };
}

/** The empty block MEMB returns when it was launched without an index at all (§MEMB step 1). */
function noIndexPayload(ctx: ResolveContext, detail: string): MembPayload {
  ctx.unavailable.add({ field: 'index', reason: 'NOT_APPLICABLE', detail });
  return {
    variant: 'default',
    index: {
      instrumentId: 0,
      key: '',
      name: '',
      code: '',
      provider: null,
      methodology: null,
      calcCurrency: null,
      constituentCount: null,
    },
    membership: {
      asOfDate: '',
      sourceId: '',
      via: { kind: 'direct' },
      count: 0,
      weightSum: 0,
      availableDates: [],
      provIdx: -1,
    },
    members: [],
    groups: [],
    changes: null,
    unresolved: { count: 0, reason: null },
    notes: [],
  };
}

interface ResolvedIndex {
  instrumentId: number;
  key: string;
  name: string;
}

async function resolveIndex(
  ctx: ResolveContext,
  params: MembParams,
): Promise<ResolvedIndex | { error: string }> {
  if (ctx.instrument !== null) {
    const inst = ctx.instrument;
    return {
      instrumentId: inst.instrumentId,
      key: displayOf(inst.ticker, inst.exchCode, inst.marketSector),
      name: inst.name,
    };
  }
  const ref = params.index;
  if (ref === undefined) {
    return { error: 'MEMB needs an index: type MEMB SPX or load an index in the panel' };
  }
  // `SecurityRefInput`'s three forms narrow onto the resolver's own input type. A `formula` row is
  // a computed series, not a security, and there is no index behind one to list members of.
  if ('formula' in ref) {
    return { error: `${ref.formula} is a formula, not an index` };
  }
  const item = await ctx.data.reference.resolve('id' in ref ? { id: ref.id } : ref.ref);
  const found = item.instrument;
  if (found === null) {
    return { error: `${'id' in ref ? String(ref.id) : ref.ref} did not resolve to a security` };
  }
  const key = displayOf(found.ticker, found.exchCode, found.marketSector);
  if (found.assetClass !== 'index') return { error: `${key} is not an index` };
  return { instrumentId: found.instrumentId, key, name: found.name };
}

export async function resolve(ctx: ResolveContext, params: MembParams): Promise<MembPayload> {
  const variant: 'index' | 'default' = ctx.instrument === null ? 'default' : 'index';

  // 1 — the index.
  const resolved = await resolveIndex(ctx, params);
  if ('error' in resolved) return noIndexPayload(ctx, resolved.error);

  // 2 — the index block, and the no-source exit.
  const idx: IndexRecord | null = await findIndexByInstrumentId(ctx.db, resolved.instrumentId);
  const terms = await indexTerms(ctx, resolved.instrumentId);
  const indexBlock: MembIndexBlock = {
    instrumentId: resolved.instrumentId,
    key: resolved.key,
    name: resolved.name,
    code: idx?.code ?? '',
    provider: terms?.provider ?? idx?.provider ?? null,
    methodology: terms?.methodology ?? null,
    calcCurrency: terms?.calc_currency ?? null,
    constituentCount: terms?.constituent_count ?? null,
  };
  const requestedDate = params.asOfDate ?? utcDate(ctx.asOf.validAt);
  if (idx?.membershipSourceId == null) {
    return noSourcePayload(ctx, variant, indexBlock, requestedDate);
  }

  // 3 — the roster. `params.source` pins the file; `'any'` takes the newest capture at that date.
  const pinned = params.source === 'any' ? null : params.source;
  const dates = await availableDates(ctx, idx.indexId, pinned);
  const chosen = dates.find((d) => d <= requestedDate) ?? null;
  const notes: string[] = [];

  if (chosen === null) {
    ctx.unavailable.add({
      field: 'members',
      reason: 'NO_SOURCE',
      detail:
        `no membership snapshot on or before ${requestedDate}; earliest captured snapshot is ` +
        `${dates.at(-1) ?? 'none'}`,
    });
    return {
      variant,
      index: indexBlock,
      membership: {
        asOfDate: requestedDate,
        sourceId: pinned ?? idx.membershipSourceId,
        via: { kind: 'direct' },
        count: 0,
        weightSum: 0,
        availableDates: dates,
        provIdx: -1,
      },
      members: [],
      groups: [],
      changes: null,
      unresolved: { count: 0, reason: null },
      notes,
    };
  }

  const roster: MembersResponse = await ctx.data.reference.members(resolved.instrumentId, chosen);
  const rows: MemberView[] =
    pinned === null ? roster.members : roster.members.filter((m) => m.sourceId === pinned);

  // 4 — how the roster reached us, and what we cite for it.
  const via: MembVia =
    idx.proxyFundInstrumentId === null
      ? { kind: 'direct' }
      : {
          kind: 'proxy_fund',
          instrumentId: idx.proxyFundInstrumentId,
          key: await proxyFundKey(ctx, idx.proxyFundInstrumentId),
        };
  if (via.kind === 'proxy_fund') notes.push(MEMB_NOTE_VIA_PROXY);

  const membershipSourceId = rows[0]?.sourceId ?? pinned ?? idx.membershipSourceId;
  const rosterProv = await citeProvenanceIds(ctx, rows.map((r) => r.provenanceId));
  const membershipProvIdx =
    rows[0] === undefined ? -1 : (rosterProv.get(rows[0].provenanceId) ?? -1);

  // 5 — enrichment. Two joins, one per extra source.
  const ids = rows.map((r) => r.instrumentId);
  const sectors = await sectorsFor(ctx, ids);
  const holdings = await holdingLines(ctx, idx.proxyFundInstrumentId, chosen);

  // 7 — live cells for the whole roster (the page is cut afterwards, and the unpaged set is what
  // the group subtotals are computed over).
  const subjects = ids.map((id) => ctx.plant.subjectFor(id));
  ctx.plant.ensureHot([...subjects, ctx.plant.subjectFor(resolved.instrumentId)]);
  const states = ctx.plant.snapshotMany(subjects);

  let missingSector = 0;
  const members: MembMember[] = rows.map((row) => {
    const subject = ctx.plant.subjectFor(row.instrumentId);
    const state = states.get(subject);
    const px = cellFromState(ctx, state, 'PX_LAST', subject);
    const chgPct = cellFromState(ctx, state, 'CHG_PCT_1D', subject);
    const sector = sectors.get(row.instrumentId);
    const line = holdings.get(row.instrumentId);
    if (sector?.sector == null) missingSector += 1;
    else if (sector.provenance_id !== null && sector.source_id !== null) {
      // The GICS name's own citation — the second attribution the screen renders (DATA-09).
      ctx.prov.add({
        sourceId: sector.source_id,
        provenanceId: Number(sector.provenance_id),
        capturedAt: new Date(sector.captured_at ?? ctx.asOf.knownAt.toISOString()),
        sourceTs: null,
        st: 'closed',
        tier: 'eod',
      });
    }
    const chg = typeof chgPct.v === 'number' ? chgPct.v : null;
    return {
      instrumentId: row.instrumentId,
      key: row.ticker === '' ? null : displayOf(row.ticker, row.exchCode, row.marketSector),
      name: row.name,
      cusip: line?.cusip ?? null,
      isin: line?.isin ?? null,
      ticker: row.ticker === '' ? null : row.ticker,
      gicsSector: sector?.sector ?? null,
      country: line?.country ?? null,
      assetCat: line?.assetCat ?? null,
      weight: row.weight,
      shares: row.shares,
      marketValue: row.marketValue,
      px,
      chgPct,
      contribPct: row.weight === null || chg === null ? null : row.weight * chg,
      subject,
    };
  });

  if (missingSector > 0) {
    ctx.unavailable.add({
      field: 'members.gicsSector',
      reason: 'NO_SOURCE',
      detail:
        `${MEMB_NOTE_GICS_NOT_IN_SOURCE}: neither membership source carries a GICS sector (the ` +
        "N-PORT filing publishes assetCat/issuerCat and the SSGA sheet's Sector column is '-'), " +
        `and ${String(missingSector)} of ${String(members.length)} members have no ` +
        `entity_classifications row from wiki.sp500; their sector column is blank and they ` +
        `subtotal under the '${MEMB_UNCLASSIFIED}' group — a bucket for the absence, never a ` +
        'sector inferred from the name or the industry',
    });
  }
  reportEnrichmentGaps(ctx, members, via.kind === 'proxy_fund');

  const weightSum = members.reduce((sum, m) => sum + (m.weight ?? 0), 0);
  const unresolvedCount = roster.unresolved;
  if (unresolvedCount > 0) {
    notes.push(MEMB_NOTE_UNRESOLVED);
    ctx.unavailable.add({
      field: 'members.key',
      reason: 'NO_SOURCE',
      detail:
        `UNRESOLVED_CONSTITUENTS: ${String(unresolvedCount)} line(s) of the membership file did ` +
        'not resolve to an instrument by CUSIP/ISIN; each has a data_exceptions row',
    });
  }

  // 8 — subtotals over the UNPAGED set.
  const groups = params.groupBy === 'none' ? [] : groupMembers(members, params.groupBy);

  // 9 — adds, drops and weight moves.
  const changes = await computeChanges(ctx, params, resolved.instrumentId, members, dates, notes);

  // 6 — sort and page.
  const sorted = [...members].sort((a, b) => compareMembers(params.sort, a, b));
  const page = pageOf(ctx, params, sorted);

  return {
    variant,
    index: indexBlock,
    membership: {
      asOfDate: chosen,
      sourceId: membershipSourceId,
      via,
      count: sorted.length,
      weightSum,
      availableDates: dates,
      provIdx: membershipProvIdx,
    },
    members: page,
    groups,
    changes,
    unresolved: {
      count: unresolvedCount,
      reason: unresolvedCount > 0 ? 'UNRESOLVED_IDENTIFIER' : null,
    },
    notes,
  };
}

/**
 * One `unavailable` entry per enrichment column that came back empty for at least one row.
 *
 * These columns are exported (`membCsvColumns`), so a `null` in one of them is a gap the payload
 * has to explain — FUNCTIONS.md §1.3 rule 6, and the rule the runner enforces. The detail names
 * the file that would have carried the value, so "blank" and "we never had a file" are told apart.
 */
function reportEnrichmentGaps(
  ctx: ResolveContext,
  members: readonly MembMember[],
  hasProxyFund: boolean,
): void {
  const columns: { field: keyof MembMember; label: string }[] = [
    { field: 'cusip', label: 'CUSIP' },
    { field: 'isin', label: 'ISIN' },
    { field: 'country', label: 'country' },
    { field: 'assetCat', label: 'asset category' },
  ];
  for (const { field, label } of columns) {
    const missing = members.filter((m) => m[field] === null).length;
    if (missing === 0) continue;
    ctx.unavailable.add({
      field: `members.${String(field)}`,
      reason: 'NO_SOURCE',
      detail:
        `${String(missing)} of ${String(members.length)} members have no ${label}: it comes from ` +
        (hasProxyFund
          ? "the proxy fund's holdings line for the same file date, and no line matched"
          : 'a holdings file, and this index has no proxy fund to take one from'),
    });
  }
  const noWeight = members.filter((m) => m.weight === null).length;
  if (noWeight > 0) {
    ctx.unavailable.add({
      field: 'members.weight',
      reason: 'NO_SOURCE',
      detail: `${String(noWeight)} member(s) carry no weight in the membership file`,
    });
  }
  for (const [field, label] of [
    ['shares', 'share count'],
    ['marketValue', 'market value'],
  ] as const) {
    const missing = members.filter((m) => m[field] === null).length;
    if (missing === 0) continue;
    ctx.unavailable.add({
      field: `members.${field}`,
      reason: 'NO_SOURCE',
      detail: `${String(missing)} member(s) carry no ${label} in the membership file`,
    });
  }
}

async function proxyFundKey(ctx: ResolveContext, instrumentId: number): Promise<string> {
  const validAt = ctx.asOf.validAt.toISOString();
  const knownAt = ctx.asOf.knownAt.toISOString();
  const res = await ctx.db.execute<{ ticker: string; exch_code: string; market_sector: string }>(sql`
    SELECT ticker, exch_code, market_sector::text AS market_sector
      FROM instruments
     WHERE instrument_id = ${instrumentId}::bigint
       AND bt_as_of(valid_from, valid_to, tx_from, tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
     LIMIT 1`);
  const row = res.rows[0];
  if (row === undefined) return '';
  return displayOf(row.ticker, row.exch_code, row.market_sector as never);
}

function groupMembers(
  members: readonly MembMember[],
  groupBy: Exclude<MembParams['groupBy'], 'none'>,
): MembGroup[] {
  const pick = (m: MembMember): string | null =>
    groupBy === 'gics_sector' ? m.gicsSector : groupBy === 'country' ? m.country : m.assetCat;

  const buckets = new Map<string, { weight: number; count: number; num: number; den: number }>();
  for (const m of members) {
    const key = pick(m) ?? MEMB_UNCLASSIFIED;
    const bucket = buckets.get(key) ?? { weight: 0, count: 0, num: 0, den: 0 };
    bucket.weight += m.weight ?? 0;
    bucket.count += 1;
    const chg = typeof m.chgPct.v === 'number' ? m.chgPct.v : null;
    if (chg !== null && m.weight !== null) {
      bucket.num += m.weight * chg;
      bucket.den += m.weight;
    }
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[1].weight - a[1].weight || (a[0] < b[0] ? -1 : 1))
    .map(([key, b]) => ({
      key,
      label: key,
      weight: b.weight,
      count: b.count,
      chgPctWeighted: b.den === 0 ? null : b.num / b.den,
    }));
}

async function computeChanges(
  ctx: ResolveContext,
  params: MembParams,
  indexInstrumentId: number,
  members: readonly MembMember[],
  dates: readonly string[],
  notes: string[],
): Promise<MembChanges | null> {
  const compareDate = params.compareDate;
  if (compareDate === undefined) return null;

  const earliest = dates.at(-1);
  if (earliest === undefined || compareDate < earliest) {
    notes.push(MEMB_NOTE_HISTORY_LIMITED);
    ctx.unavailable.add({
      field: 'changes',
      reason: 'NO_SOURCE',
      detail:
        `${MEMB_NOTE_HISTORY_LIMITED}: the earliest captured membership snapshot is ` +
        `${earliest ?? 'none'}; adds and drops before it cannot be computed`,
    });
    return null;
  }

  const before = await ctx.data.reference.members(indexInstrumentId, compareDate);
  const beforeById = new Map(before.members.map((m) => [m.instrumentId, m]));
  const afterById = new Map(members.map((m) => [m.instrumentId, m]));

  const adds: MembChangeRow[] = members
    .filter((m) => m.instrumentId !== null && !beforeById.has(m.instrumentId))
    .map((m) => ({ instrumentId: m.instrumentId, key: m.key, name: m.name, weight: m.weight }));

  const drops: MembChangeRow[] = before.members
    .filter((m) => !afterById.has(m.instrumentId))
    .map((m) => ({
      instrumentId: m.instrumentId,
      key: displayOf(m.ticker, m.exchCode, m.marketSector),
      name: m.name,
      weight: m.weight,
    }));

  const moves: MembWeightMove[] = [];
  for (const m of members) {
    if (m.instrumentId === null || m.weight === null) continue;
    const previous = beforeById.get(m.instrumentId);
    if (previous?.weight == null) continue;
    const delta = m.weight - previous.weight;
    if (Math.abs(delta) < MEMB_WEIGHT_MOVE_FLOOR) continue;
    moves.push({
      instrumentId: m.instrumentId,
      key: m.key,
      name: m.name,
      weightFrom: previous.weight,
      weightTo: m.weight,
      deltaBp: Math.round(delta * 10_000 * 10) / 10,
    });
  }
  moves.sort((a, b) => Math.abs(b.deltaBp) - Math.abs(a.deltaBp) || (a.name < b.name ? -1 : 1));

  const compareProv = await citeProvenanceIds(
    ctx,
    before.members.map((m) => m.provenanceId),
  );
  const firstCompare = before.members[0];
  return {
    compareDate: before.asOfDate,
    compareSourceId: firstCompare?.sourceId ?? '',
    adds,
    drops,
    weightMoves: moves.slice(0, MEMB_MAX_WEIGHT_MOVES),
    provIdx:
      firstCompare === undefined ? -1 : (compareProv.get(firstCompare.provenanceId) ?? -1),
  };
}

/** §MEMB step 6's keyset page over the already-sorted roster. */
function pageOf(
  ctx: ResolveContext,
  params: MembParams,
  sorted: readonly MembMember[],
): MembMember[] {
  const page = ctx.page;
  if (page === undefined) return [...sorted];

  let start = 0;
  const cursor = page.cursor;
  if (cursor !== null && cursor !== '') {
    const decoded = decodeCursor(cursor);
    const at = sorted.findIndex((m) => matchesCursor(params.sort, m, decoded));
    if (at >= 0) start = page.direction === 'fwd' ? at + 1 : Math.max(0, at - params.limit);
  }
  const rows = sorted.slice(start, start + params.limit);
  const last = rows.at(-1);
  page.set({
    index: start,
    count: sorted.length,
    cursor:
      last === undefined || start + rows.length >= sorted.length
        ? null
        : encodeCursor(cursorOf(params.sort, last)),
  });
  return rows;
}

function cursorOf(sort: MembParams['sort'], m: MembMember): Cursor {
  if (sort === 'weight') return { w: m.weight, n: m.name };
  if (sort === 'shares') return { w: m.shares, n: m.name };
  return { k: sort === 'key' ? m.key : m.name, n: m.name };
}

function decodeCursor(cursor: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new TypeError(`MEMB: '${cursor}' is not a members cursor`);
  }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Cursor).n !== 'string') {
    throw new TypeError(`MEMB: '${cursor}' is not a members cursor`);
  }
  return parsed as Cursor;
}

function matchesCursor(sort: MembParams['sort'], m: MembMember, c: Cursor): boolean {
  if (m.name !== c.n) return false;
  if (sort === 'weight') return (m.weight ?? null) === (c.w ?? null);
  if (sort === 'shares') return (m.shares ?? null) === (c.w ?? null);
  return (sort === 'key' ? m.key : m.name) === (c.k ?? null);
}

export default { resolve };
