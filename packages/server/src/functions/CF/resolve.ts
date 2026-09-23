/**
 * `functions/CF/resolve.ts` — Company Filings (FUNCTIONS_TIER2.md §CF L999-1155, WORKPLAN WP-10).
 *
 * One variant, `issuer`, for both `equity` and `etf`: an ETF is a filer like any other and only
 * its form mix differs, which `formCounts` shows without a second code path.
 *
 * Four decisions:
 *
 *  1. **`knownAt` is compared against `accepted_at`, not `filed_date`.** `filings` is not
 *     bitemporal — a filing is an immutable published document and a correction is a new filing —
 *     so the knowledge instant is EDGAR's `acceptanceDateTime`: the moment the document became
 *     public. A `KNOWN=2025-06-30` run therefore shows what a reader could have seen that day, and
 *     CF and FA agree about it (STOR-06). A row with no `accepted_at` (an older index row) falls
 *     back to the filing day, which is the coarsest honest answer.
 *  2. **The page cursor is the filings service's own.** §CF step 9 sketches
 *     `base64url({acceptedAt, accessionNo})`; `data/filings.ts` already implements keyset paging on
 *     `(filed_date, accession_no)` and validates its own cursor, so this resolver passes
 *     `ctx.page.cursor` straight through rather than inventing a second encoding that would have to
 *     be translated back into the first. The cursor stays opaque to the client either way, which is
 *     what API.md §2 promises.
 *  3. **`formCounts` and `coverage` are aggregates over the whole window, not the page.** That is
 *     what makes an ETF's form mix visible on the first screen, and what makes
 *     `HISTORY_LIMITED_RECENT_FILE` a statement about the store rather than about the page.
 *  4. **Three gaps are declared on every run**, not discovered: no full-text search, no stored
 *     documents, and a recent-window-only history when that is what the store holds.
 */

import { sql } from 'drizzle-orm';

import type { CfFiling, CfParams, CfPayload } from '@terminal/core/functions/manifests/CF';
import {
  DOCUMENT_LINK_OUT_DETAIL,
  FILING_FULLTEXT_DETAIL,
  FORM_GROUPS,
  HISTORY_LIMITED_DETAIL,
  ITEMS_ONLY_ON_8K_DETAIL,
  formGroupOf,
  itemLabel,
} from '@terminal/core/functions/manifests/CF';

import type { Filing } from '../../data/filings.js';
import type {
  FunctionResolver,
  FunctionServerModule,
  ReadThroughKind,
  ResolveContext,
} from '../context.js';
import { displayOf } from '../shared/instrumentSummary.js';

const SIX_HOURS_MS = 6 * 3_600_000;
const THREE_YEARS_DAYS = 1096;
const DAY_MS = 86_400_000;

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
    // Stored filings answer the screen; a failed refresh is not a 503 (decision 4 of DES).
  }
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * A stored instant as ISO-8601. `filings.accepted_at` is read back as Postgres renders it
 * (`'2026-07-30 20:31:00+00'`); a payload timestamp is ISO-8601 (FUNCTIONS.md §1.3 rule 3).
 */
function isoInstant(value: string | null): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The knowledge instant of a filing: `accepted_at`, or the filing day when none was recorded. */
function knowableAt(f: Filing): number {
  if (f.acceptedAt !== null) {
    const ms = Date.parse(f.acceptedAt);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.parse(`${f.filedDate}T00:00:00Z`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

const issuerVariant: FunctionResolver<CfParams, CfPayload> = async (ctx, params) => {
  const instrumentRow = ctx.instrument;
  if (instrumentRow === null) {
    throw new Error('CF: requiresSecurity is true, so the runner must supply an instrument');
  }
  const knownAt = knownAtOf(ctx, params.knownAt);
  const detail = await ctx.data.reference.instrument(instrumentRow.instrumentId);
  const issuer = detail.issuer;
  const fundCik = detail.terms?.kind === 'fund' ? (detail.terms.terms.cik ?? null) : null;
  const cik = issuer?.cik ?? fundCik;
  const assetClass = detail.instrument.assetClass === 'etf' ? 'etf' : 'equity';

  const forms = params.forms.length > 0 ? params.forms : [...FORM_GROUPS[params.group]];
  const from = params.from ?? isoDay(ctx.asOf.validAt.getTime() - THREE_YEARS_DAYS * DAY_MS);
  const to = params.to ?? isoDay(ctx.asOf.validAt.getTime());

  const notes = ['FILING_FULLTEXT_UNAVAILABLE', 'DOCUMENT_NOT_STORED_LINK_OUT'];
  ctx.unavailable.add({ field: 'q', reason: 'NO_SOURCE', detail: FILING_FULLTEXT_DETAIL });
  ctx.unavailable.add({
    field: 'document',
    reason: 'NOT_LICENSED',
    detail: DOCUMENT_LINK_OUT_DETAIL,
  });

  const shell = (
    filings: CfFiling[],
    formCounts: CfPayload['formCounts'],
    latest: CfPayload['latest'],
    coverage: CfPayload['coverage'],
    total: number,
  ): CfPayload => ({
    variant: 'issuer',
    security: {
      instrumentId: detail.instrument.instrumentId,
      key: displayOf(
        detail.instrument.ticker,
        detail.instrument.exchCode,
        detail.instrument.marketSector,
      ),
      name: detail.instrument.name,
      assetClass,
    },
    issuer: {
      issuerId: issuer?.issuerId ?? null,
      name: issuer?.name ?? detail.instrument.name,
      cik,
      sic: issuer?.sic ?? null,
      sicDescription: issuer?.sicDescription ?? null,
      filerCategory: issuer?.filerCategory ?? null,
      fiscalYearEnd: issuer?.fiscalYearEnd ?? null,
      entityType: issuer?.entityType ?? null,
      formerNames: (issuer?.formerNames ?? []).map((n) => ({
        name: n.name,
        from: n.from ?? '',
        to: n.to ?? '',
      })),
      website: issuer?.website ?? null,
    },
    filter: {
      forms,
      group: params.group,
      items: params.items,
      xbrlOnly: params.xbrlOnly,
      from,
      to,
    },
    filings,
    formCounts,
    latest,
    coverage,
    total,
    knownAt: knownAt.toISOString(),
    notes,
  });

  const emptyLatest: CfPayload['latest'] = {
    annual: null,
    quarterly: null,
    current8k: null,
    fundHoldings: null,
  };

  if (cik === null || cik === '') {
    ctx.unavailable.add({
      field: 'filings',
      reason: 'NO_SOURCE',
      detail: 'issuer has no SEC CIK (not an SEC filer)',
    });
    ctx.page?.set({ index: 0, count: 0, cursor: null });
    return shell([], [], emptyLatest, {
      from: null,
      to: null,
      sourceId: 'sec.submissions',
      recentOnly: false,
      countInStore: 0,
    }, 0);
  }

  await tryEnsure(ctx, 'sec.submissions', cik, SIX_HOURS_MS);

  const page = await ctx.data.filings.list(cik, {
    ...(forms.length > 0 ? { forms } : {}),
    from,
    to,
    ...(ctx.page?.cursor == null ? {} : { cursor: ctx.page.cursor }),
    limit: params.limit,
  });

  const knownAtMs = knownAt.getTime();
  const kept = page.items.filter((f) => {
    if (knowableAt(f) > knownAtMs) return false;
    if (params.items.length > 0 && !params.items.every((i) => f.items.includes(i))) return false;
    if (params.xbrlOnly && !f.isXbrl && !f.isInlineXbrl) return false;
    return true;
  });

  const cite = await citeMany(
    ctx,
    kept.map((f) => f.provenanceId),
  );
  const amends = await amendsMap(ctx, cik, kept);
  const filings = kept.map((f) => toCfFiling(f, cite, amends));

  const counts = await formCountsFor(ctx, cik, from, to, knownAt);
  const coverage = await coverageFor(ctx, cik, from);
  const latest = await latestFor(ctx, cik, from, to, knownAtMs, cite, amends);

  if (coverage.recentOnly) {
    notes.push('HISTORY_LIMITED_RECENT_FILE');
    ctx.unavailable.add({
      field: 'coverage',
      reason: 'NO_SOURCE',
      detail: `${HISTORY_LIMITED_DETAIL}${coverage.from ?? from} are absent`,
    });
  }
  if (
    params.items.length > 0 &&
    forms.length > 0 &&
    !forms.some((f) => f.toUpperCase().startsWith('8-K') || f.toUpperCase() === '6-K')
  ) {
    ctx.unavailable.add({
      field: 'items',
      reason: 'NOT_APPLICABLE',
      detail: ITEMS_ONLY_ON_8K_DETAIL,
    });
  }
  if (assetClass === 'etf' && latest.annual === null && latest.quarterly === null) {
    notes.push('PERIODIC_NOT_FILED_FUND');
  }
  if (filings.some((f) => (f.items ?? []).some((code) => itemLabel(code).startsWith('Item ')))) {
    notes.push('ITEM_LABEL_UNKNOWN');
  }

  ctx.page?.set({
    index: filings.length,
    count: page.total,
    cursor: page.nextCursor,
  });

  return shell(filings, counts, latest, coverage, page.total);
};

function toCfFiling(
  f: Filing,
  cite: ReadonlyMap<number, number>,
  amends: ReadonlyMap<string, string>,
): CfFiling {
  const accessionNo = f.accessionNo.trim();
  const isAmendment = f.form.endsWith('/A');
  return {
    accessionNo,
    form: f.form,
    formGroup: formGroupOf(f.form),
    filedDate: f.filedDate,
    acceptedAt: isoInstant(f.acceptedAt),
    reportDate: f.reportDate,
    items: f.items.length > 0 ? f.items : null,
    itemLabels: f.items.length > 0 ? f.items.map(itemLabel) : null,
    primaryDoc: f.primaryDoc ?? '',
    primaryDocDesc: f.primaryDocDesc,
    isXbrl: f.isXbrl,
    isInlineXbrl: f.isInlineXbrl,
    sizeBytes: f.sizeBytes,
    url: f.url,
    isAmendment,
    amends: isAmendment ? (amends.get(accessionNo) ?? null) : null,
    provIdx: cite.get(f.provenanceId) ?? -1,
  };
}

/**
 * `accession of the amendment → accession of the filing it amends`.
 *
 * The newest stored non-amendment filing of the same base form with the same `report_date`. No
 * such row → the amendment simply carries `null`: EDGAR does not publish the link, so it is
 * derived where it can be and absent where it cannot, never guessed from adjacency.
 */
async function amendsMap(
  ctx: ResolveContext,
  cik: string,
  rows: readonly Filing[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const amendments = rows.filter((f) => f.form.endsWith('/A') && f.reportDate !== null);
  if (amendments.length === 0) return out;

  for (const a of amendments) {
    const base = a.form.slice(0, -2);
    const res = await ctx.db.execute<{ accession_no: string }>(sql`
      SELECT accession_no
        FROM filings
       WHERE cik = ${cik}
         AND form = ${base}
         AND report_date = ${a.reportDate}::date
       ORDER BY filed_date DESC, accession_no DESC
       LIMIT 1`);
    const hit = res.rows[0];
    if (hit !== undefined) out.set(a.accessionNo.trim(), hit.accession_no.trim());
  }
  return out;
}

/** `count(*)` and `max(filed_date)` per form over the whole window — not the page (§CF step 6). */
async function formCountsFor(
  ctx: ResolveContext,
  cik: string,
  from: string,
  to: string,
  knownAt: Date,
): Promise<CfPayload['formCounts']> {
  const res = await ctx.db.execute<{ form: string; n: string; newest: string }>(sql`
    SELECT form, count(*)::text AS n, max(filed_date)::text AS newest
      FROM filings
     WHERE cik = ${cik}
       AND filed_date >= ${from}::date
       AND filed_date <= ${to}::date
       AND coalesce(accepted_at, filed_date::timestamptz) <= ${knownAt.toISOString()}::timestamptz
     GROUP BY form
     ORDER BY count(*) DESC, form ASC`);
  return res.rows.map((r) => ({
    form: r.form,
    formGroup: formGroupOf(r.form),
    count: Number(r.n),
    newest: r.newest,
  }));
}

/**
 * What the store holds for this filer, whatever the window asked for.
 *
 * `recentOnly` is true when the store is at the submissions file's inline cap (1000 rows) or when
 * the oldest stored filing is *later* than the window start — both mean the user is looking at the
 * file's window rather than the issuer's history, which is what `HISTORY_LIMITED_RECENT_FILE` says.
 */
async function coverageFor(
  ctx: ResolveContext,
  cik: string,
  from: string,
): Promise<CfPayload['coverage']> {
  const res = await ctx.db.execute<{ lo: string | null; hi: string | null; n: string }>(sql`
    SELECT min(filed_date)::text AS lo, max(filed_date)::text AS hi, count(*)::text AS n
      FROM filings
     WHERE cik = ${cik}`);
  const row = res.rows[0];
  const lo = row?.lo ?? null;
  const countInStore = Number(row?.n ?? 0);
  return {
    from: lo,
    to: row?.hi ?? null,
    sourceId: 'sec.submissions',
    recentOnly: countInStore >= 1000 || (lo !== null && lo > from),
    countInStore,
  };
}

/** The newest annual, quarterly, 8-K and N-PORT in the window, each `null` when there is none. */
async function latestFor(
  ctx: ResolveContext,
  cik: string,
  from: string,
  to: string,
  knownAtMs: number,
  cite: ReadonlyMap<number, number>,
  amends: ReadonlyMap<string, string>,
): Promise<CfPayload['latest']> {
  const newest = async (forms: string[]): Promise<CfFiling | null> => {
    const page = await ctx.data.filings.list(cik, { forms, from, to, limit: 5 });
    const hit = page.items.find((f) => knowableAt(f) <= knownAtMs);
    if (hit === undefined) return null;
    const cited = cite.has(hit.provenanceId)
      ? cite
      : await citeMany(ctx, [hit.provenanceId]).then((m) => new Map([...cite, ...m]));
    return toCfFiling(hit, cited, amends);
  };
  const [annual, quarterly, current8k, fundHoldings] = await Promise.all([
    newest(['10-K', '20-F', '40-F']),
    newest(['10-Q']),
    newest(['8-K']),
    newest(['NPORT-P']),
  ]);
  return { annual, quarterly, current8k, fundHoldings };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────────────────────────

export { issuerVariant as issuer };

export const resolve: FunctionResolver<CfParams, CfPayload> = issuerVariant;

/** FUNC-02: `equity, etf → 'issuer'` — one shape, one code path (§CF L1010). */
export const variants = { equity: issuerVariant, etf: issuerVariant };

const module_: FunctionServerModule<CfParams, CfPayload> = { resolve, variants };

export default module_;
