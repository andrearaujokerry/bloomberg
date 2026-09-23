/**
 * `functions/HDS/resolve.ts` — holders and fund holdings (FUNCTIONS_TIER2.md §HDS L1608-1627).
 *
 * ## The reserved block is the point of this screen
 *
 * `institutional` is emitted on **every** equity run as `{ holders: null, reason:
 * '13F_NOT_AVAILABLE' }`, with the matching `meta.unavailable` entry. There is no 13F-HR source in
 * this build — SEC full-text search is blocked and no 13F fixture is recorded (BRIEF §2, API.md
 * §14.3) — so institutional ownership is a question this system cannot answer. It answers it by
 * saying so, in the payload, on a screen that otherwise renders perfectly: a run that *failed*
 * because one block has no source would take the fund ownership down with it, and fund ownership
 * is real, cited and useful. `holderKind: '13f'` stays in the wire shape and is never produced.
 *
 * Insider ownership is the same shape of answer one level down. Forms 3, 4 and 5 are listed with
 * their accession numbers and their sec.gov links; the ownership documents are not parsed in v1, so
 * `shares` and `transactions` are `null` with `INSIDER_HOLDINGS_NOT_PARSED` rather than a number
 * nobody computed.
 *
 * ## Two variants, one table read from both ends
 *
 * `etf_holdings` is the only ownership source. Read by `holding_instrument_id` it answers "which
 * ingested funds report this name" (the `equity` variant); read by `etf_instrument_id` it answers
 * "what does this fund hold" (the `fund` variant). Coverage is therefore exactly the set of funds
 * whose files are ingested, which the `HOLDERS_LIMITED_TO_SEEDED_FUNDS` note states on an equity
 * that nothing reports — never an empty grid that reads as "nobody owns this".
 *
 * ## Provenance
 *
 * Every holdings row carries the `provenance_id` of the file it came from, and this resolver
 * re-cites it through `ctx.prov` rather than passing the reader's own index through: the data
 * services are built over a **separate** `ProvenanceIndex` (`http/routes/functions.ts`), so a
 * reader's `provIdx` indexes an array the payload never carries. `functions/MEMB/resolve.ts`
 * documents the same trap.
 */

import { sql } from 'drizzle-orm';

import type { ValueCell } from '@terminal/core';
import type {
  HdsEquityPayload,
  HdsFile,
  HdsFund,
  HdsFundHolding,
  HdsFundPayload,
  HdsHolder,
  HdsInsiderFiling,
  HdsParams,
  HdsShareBase,
  HdsSourceId,
  HdsSummary,
} from '@terminal/core/functions/manifests/HDS';
import {
  HDS_INSIDERS_DETAIL,
  HDS_INSIDER_FORMS,
  HDS_NOTE_HOLDERS_LIMITED,
  HDS_NOTE_INSIDERS_NOT_PARSED,
  HDS_NOTE_NO_13F,
  HDS_NOTE_PROXY_LAGS,
  HDS_NOTE_UNRESOLVED,
  HDS_NO_13F_DETAIL,
} from '@terminal/core/functions/manifests/HDS';

import type { EtfHolding, Holder } from '../../data/holdings.js';
import type { ResolveContext } from '../context.js';
import { cellFromState, pendingCell, storedCell } from '../shared/cells.js';
import { displayOf } from '../shared/instrumentSummary.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

const NA_CELL: ValueCell = { v: null, st: 'na', provIdx: -1 };

function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function asSourceId(value: string): HdsSourceId {
  return value === 'ssga.holdings' ? 'ssga.holdings' : 'sec.archives';
}

/**
 * `providers.ensure`, downgraded to "try".
 *
 * `ensure` raises `ProviderUnavailableError` when it can neither fetch nor find anything stored,
 * and the runner turns that into a 503. That is the right answer for a screen whose *only* content
 * is the resource being refreshed; it is the wrong one here, where the refresh is an optimisation
 * over a file this function is perfectly able to serve from the store. So a failed refresh is
 * swallowed and the payload reports what really exists, with its own reason when that is nothing.
 */
async function tryEnsure(
  ctx: ResolveContext,
  kind: Parameters<ResolveContext['providers']['ensure']>[0],
  key: string,
  maxAgeMs: number,
): Promise<boolean> {
  try {
    const result = await ctx.providers.ensure(kind, key, { maxAgeMs });
    return result.fresh;
  } catch {
    return false;
  }
}

interface KeyRow extends Record<string, unknown> {
  instrument_id: string;
  ticker: string;
  exch_code: string;
  market_sector: string;
  name: string;
}

/** `'AAPL US Equity'` per instrument id, as-of `ctx.asOf`. */
async function instrumentKeys(
  ctx: ResolveContext,
  ids: readonly number[],
): Promise<Map<number, { key: string; name: string }>> {
  const out = new Map<number, { key: string; name: string }>();
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return out;
  const validAt = ctx.asOf.validAt.toISOString();
  const knownAt = ctx.asOf.knownAt.toISOString();
  const res = await ctx.db.execute<KeyRow>(sql`
    SELECT instrument_id::text AS instrument_id, ticker, exch_code,
           market_sector::text AS market_sector, name
      FROM instruments
     WHERE instrument_id = ANY(${sql.param(wanted.map(String))}::bigint[])
       AND bt_as_of(valid_from, valid_to, tx_from, tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)`);
  for (const row of res.rows) {
    out.set(Number(row.instrument_id), {
      key: displayOf(row.ticker, row.exch_code, row.market_sector as never),
      name: row.name,
    });
  }
  return out;
}

/** Cite one holdings-file capture. Idempotent on `provenanceId`, so one file is one entry. */
function citeFile(
  ctx: ResolveContext,
  row: { sourceId: string; provenanceId: number; capturedAt: string; sourceTs: string | null },
): number {
  return ctx.prov.add({
    sourceId: row.sourceId,
    provenanceId: row.provenanceId,
    capturedAt: new Date(row.capturedAt),
    sourceTs: row.sourceTs === null ? null : new Date(row.sourceTs),
    st: 'closed',
    tier: 'eod',
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Paging (§HDS step 7)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Cursor {
  w?: number | null;
  n?: string;
  l?: number;
  d?: string;
  a?: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new TypeError(`HDS: '${cursor}' is not a holdings cursor`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TypeError(`HDS: '${cursor}' is not a holdings cursor`);
  }
  return parsed;
}

/**
 * One keyset page over an already-sorted list. PAGE FWD takes the rows after the cursor row;
 * PAGE BACK takes the `limit` rows before it, so a back-page is byte-identical to the page the
 * cursor was minted on.
 */
function pageOf<T>(
  ctx: ResolveContext,
  limit: number,
  sorted: readonly T[],
  matches: (row: T, c: Cursor) => boolean,
  cursorOf: (row: T) => Cursor,
): T[] {
  const page = ctx.page;
  if (page === undefined) return sorted.slice(0, limit);

  let start = 0;
  const cursor = page.cursor;
  if (cursor !== null && cursor !== '') {
    const decoded = decodeCursor(cursor);
    const at = sorted.findIndex((row) => matches(row, decoded));
    if (at >= 0) start = page.direction === 'fwd' ? at + 1 : Math.max(0, at - limit);
  }
  const rows = sorted.slice(start, start + limit);
  const last = rows[rows.length - 1];
  page.set({
    index: start,
    count: sorted.length,
    cursor:
      last === undefined || start + rows.length >= sorted.length
        ? null
        : encodeCursor(cursorOf(last)),
  });
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// equity (§HDS "Resolver", equity)
// ─────────────────────────────────────────────────────────────────────────────────────────────

function compareHolders(sort: HdsParams['sort'], a: HdsHolder, b: HdsHolder): number {
  if (sort === 'name') {
    if (a.holderName !== b.holderName) return a.holderName < b.holderName ? -1 : 1;
    return 0;
  }
  const pick = (h: HdsHolder): number =>
    (sort === 'weight' ? h.weightInHolder : sort === 'shares' ? h.shares : h.marketValue) ??
    Number.NEGATIVE_INFINITY;
  const av = pick(a);
  const bv = pick(b);
  if (av !== bv) return bv - av;
  return a.holderName < b.holderName ? -1 : a.holderName > b.holderName ? 1 : 0;
}

/**
 * Shares outstanding from the issuer's own `dei:EntityCommonStockSharesOutstanding` fact.
 *
 * §HDS step 2 reads the whole `shareBase` through `data.snapshot.fields`. That reader is built over
 * the route's separate `ProvenanceIndex` and its cells therefore carry a `provIdx` that indexes an
 * array this payload does not ship — and, unlike a holdings row, a `ValueCell` does not expose the
 * `provenance_id` it rests on, so the index cannot be remapped. The fact reader does expose it, so
 * this is read from `xbrl_facts` and cited honestly instead; `EQY_SH_OUT` is a filed number, not a
 * quote, and this is where it is filed.
 */
async function sharesOutstanding(
  ctx: ResolveContext,
  cik: string | null,
): Promise<{ cell: ValueCell; value: number | null }> {
  if (cik === null) return { cell: NA_CELL, value: null };
  const read = async (): Promise<ValueCell & { value: number | null }> => {
    const facts = await ctx.data.fundamentals.facts(
      {
        cik,
        concepts: ['dei:EntityCommonStockSharesOutstanding', 'EntityCommonStockSharesOutstanding'],
        unit: 'shares',
        periods: 'any',
        limit: 1,
      },
      ctx.asOf.knownAt,
    );
    const fact = facts[0];
    if (fact === undefined) return { ...NA_CELL, value: null };
    const provIdx = ctx.prov.add({
      sourceId: 'sec.companyfacts',
      provenanceId: fact.provenanceId,
      capturedAt: new Date(fact.capturedAt),
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    });
    return { ...storedCell({ v: fact.value, provIdx }), value: fact.value };
  };

  let out = await read();
  if (out.value === null) {
    // §HDS step 2: one read-through, then one re-read. A refresh that cannot happen leaves the
    // blank exactly as it was, with its reason.
    if (await tryEnsure(ctx, 'sec.companyfacts', cik, 86_400_000)) out = await read();
  }
  if (out.value === null) {
    ctx.unavailable.add({
      field: 'EQY_SH_OUT',
      reason: 'NO_SOURCE',
      detail:
        'no dei:EntityCommonStockSharesOutstanding fact for this issuer; ' +
        'percent-of-shares-outstanding cannot be computed',
    });
  }
  const { value, ...cell } = out;
  return { cell, value };
}

export async function resolveEquity(
  ctx: ResolveContext,
  params: HdsParams,
): Promise<HdsEquityPayload> {
  const instrument = ctx.instrument;
  if (instrument === null) {
    throw new TypeError('HDS: the runner guarantees a security on a requiresSecurity function');
  }
  const detail = await ctx.data.reference.instrument(instrument.instrumentId);
  const cik = detail.issuer?.cik ?? null;
  const security = {
    instrumentId: instrument.instrumentId,
    key: displayOf(instrument.ticker, instrument.exchCode, instrument.marketSector),
    name: instrument.name,
    issuerId: detail.issuer?.issuerId ?? 0,
    cik,
  };
  const notes: string[] = [HDS_NOTE_NO_13F];

  // ── shareBase ───────────────────────────────────────────────────────────────────────────────
  const subject = ctx.plant.subjectFor(instrument.instrumentId);
  ctx.plant.ensureHot([subject]);
  const state = ctx.plant.snapshot(subject);
  const px = cellFromState(ctx, state, 'PX_LAST', subject);
  const { cell: sharesOut, value: sharesOutValue } = await sharesOutstanding(ctx, cik);
  const pxValue = typeof px.v === 'number' ? px.v : null;
  const marketCap: ValueCell =
    pxValue === null || sharesOutValue === null || px.provIdx < 0
      ? { ...NA_CELL, ...(px.live === undefined ? {} : { live: px.live }) }
      : {
          v: pxValue * sharesOutValue,
          st: px.st,
          provIdx: px.provIdx,
          ...(px.live === undefined ? {} : { live: px.live }),
        };
  if (marketCap.v === null) {
    ctx.unavailable.add({
      field: 'CUR_MKT_CAP',
      reason: 'NO_SOURCE',
      detail:
        'market capitalisation needs both a price and a shares-outstanding fact; one of the two ' +
        'is blank for this security',
    });
  }
  ctx.unavailable.add({
    field: 'EQY_FLOAT_PCT',
    reason: 'NO_SOURCE',
    detail:
      'FLOAT_NOT_SOURCED: no free-float source is licensable in this wedge; the percentage of ' +
      'shares outstanding that trades freely is not published by SEC company facts',
  });
  const shareBase: HdsShareBase = {
    sharesOut,
    floatPct: NA_CELL,
    marketCap,
    px,
  };

  // ── the reserved institutional block, on every run ──────────────────────────────────────────
  ctx.unavailable.add({ field: 'institutional', reason: 'NO_SOURCE', detail: HDS_NO_13F_DETAIL });

  // `insiders.shares` and `insiders.transactions` are null in *every* view — forms 3/4/5 are listed
  // and never parsed (HDS.ts §"honest limits") — so the two columns are named on every run rather
  // than only on the view that lists the filings; the HOLDERS view used to carry the same two
  // blanks with nothing in the footer to explain them. They are named column by column, not as
  // `insiders`, so that the block-level entry stays free for the reason the *filings* are missing
  // (an issuer with no CIK), which entries de-duplicated on `(field, reason)` would otherwise hide.
  for (const field of ['insiders.shares', 'insiders.transactions']) {
    ctx.unavailable.add({ field, reason: 'NO_SOURCE', detail: HDS_INSIDERS_DETAIL });
  }

  // ── insiders ────────────────────────────────────────────────────────────────────────────────
  if (params.view === 'INSIDERS') {
    const insiders = await insiderFilings(ctx, params, cik);
    notes.push(HDS_NOTE_INSIDERS_NOT_PARSED);
    return {
      variant: 'equity',
      security,
      view: params.view,
      shareBase,
      summary: {
        holderCount: 0,
        sharesHeld: null,
        marketValueHeld: null,
        pctSharesOutHeld: null,
        asOfDate: null,
        sources: [],
        provIdx: -1,
      },
      holders: [],
      insiders,
      institutional: { holders: null, reason: HDS_NOTE_NO_13F },
      notes,
    };
  }

  // ── holders ─────────────────────────────────────────────────────────────────────────────────
  const response = await ctx.data.holdings.holders(instrument.instrumentId, params.asOfDate);
  const filtered = response.holders.filter(
    (h) =>
      (params.source === 'any' || h.sourceId === params.source) &&
      (h.weightInHolder ?? 0) >= params.minWeight,
  );

  // One row per **fund**, not per file.
  //
  // `data.holdings.holders` answers per `(etf_instrument_id, source_id)` — the reader's documented
  // contract — so a fund that publishes both an N-PORT filing and a daily SSGA sheet comes back
  // twice for the same position. Summing that set would double-count the shares it holds and
  // report a percentage of shares outstanding roughly twice the truth, which is the one number
  // this screen exists to state. So the same tie-break the fund variant uses applies here: the
  // newest file wins, and `ssga.holdings` wins an equal date because its file is daily.
  const deduped = new Map<string, Holder>();
  for (const row of filtered) {
    const key = row.holderInstrumentId === null ? row.holderName : String(row.holderInstrumentId);
    const held = deduped.get(key);
    if (held === undefined) {
      deduped.set(key, row);
      continue;
    }
    const newer = row.asOfDate > held.asOfDate;
    const sameDateBetterSource =
      row.asOfDate === held.asOfDate && row.sourceId === 'ssga.holdings';
    if (newer || sameDateBetterSource) deduped.set(key, row);
  }

  const holders: HdsHolder[] = [...deduped.values()].map((row: Holder): HdsHolder => {
    const provIdx = citeFile(ctx, row);
    const shares = row.shares;
    return {
      holderName: row.holderName,
      holderKind: 'etf',
      holderInstrumentId: row.holderInstrumentId,
      holderKey: row.holderKey,
      shares,
      marketValue: row.marketValue,
      weightInHolder: row.weightInHolder,
      pctSharesOut:
        shares === null || sharesOutValue === null || sharesOutValue === 0
          ? null
          : shares / sharesOutValue,
      asOfDate: row.asOfDate,
      sourceId: asSourceId(row.sourceId),
      provIdx,
    };
  });
  holders.sort((a, b) => compareHolders(params.sort, a, b));

  // The summary aggregates the UNPAGED set (§HDS step 4).
  const sharesHeld = sumOf(holders.map((h) => h.shares));
  const marketValueHeld = sumOf(holders.map((h) => h.marketValue));
  const summary: HdsSummary = {
    holderCount: holders.length,
    sharesHeld,
    marketValueHeld,
    pctSharesOutHeld:
      sharesHeld === null || sharesOutValue === null || sharesOutValue === 0
        ? null
        : sharesHeld / sharesOutValue,
    asOfDate: holders.reduce<string | null>(
      (max, h) => (max === null || h.asOfDate > max ? h.asOfDate : max),
      null,
    ),
    sources: [...new Set(holders.map((h) => h.sourceId))].sort(),
    provIdx: holders[0]?.provIdx ?? -1,
  };

  if (holders.length === 0) {
    notes.push(HDS_NOTE_HOLDERS_LIMITED);
    ctx.unavailable.add({
      field: 'holders',
      reason: 'NO_SOURCE',
      detail:
        'HOLDERS_LIMITED_TO_SEEDED_FUNDS: no seeded fund files (SEC N-PORT / SSGA) list this ' +
        'instrument; only funds whose holdings are ingested can appear',
    });
  }

  const page = pageOf(
    ctx,
    params.limit,
    holders,
    (row, c) => row.holderName === c.n && (row.weightInHolder ?? null) === (c.w ?? null),
    (row) => ({ w: row.weightInHolder, n: row.holderName }),
  );

  return {
    variant: 'equity',
    security,
    view: params.view,
    shareBase,
    summary,
    holders: page,
    insiders: {
      filings: [],
      shares: null,
      transactions: null,
      reason: HDS_NOTE_INSIDERS_NOT_PARSED,
    },
    institutional: { holders: null, reason: HDS_NOTE_NO_13F },
    notes,
  };
}

function sumOf(values: readonly (number | null)[]): number | null {
  let seen = false;
  let sum = 0;
  for (const value of values) {
    if (value === null) continue;
    seen = true;
    sum += value;
  }
  return seen ? sum : null;
}

async function insiderFilings(
  ctx: ResolveContext,
  params: HdsParams,
  cik: string | null,
): Promise<HdsEquityPayload['insiders']> {
  const empty: HdsEquityPayload['insiders'] = {
    filings: [],
    shares: null,
    transactions: null,
    reason: HDS_NOTE_INSIDERS_NOT_PARSED,
  };
  if (cik === null) {
    ctx.unavailable.add({
      field: 'insiders',
      reason: 'NO_SOURCE',
      detail: 'issuer has no SEC CIK (not an SEC filer)',
    });
    return empty;
  }

  await tryEnsure(ctx, 'sec.submissions', cik, 21_600_000);
  const cursor = ctx.page?.cursor ?? undefined;
  const page = await ctx.data.filings.list(cik, {
    forms: [...HDS_INSIDER_FORMS],
    limit: params.limit,
    ...(cursor === undefined || cursor === '' ? {} : { cursor }),
  });

  const filings: HdsInsiderFiling[] = page.items.map((f): HdsInsiderFiling => ({
    accessionNo: f.accessionNo,
    form: f.form,
    filedDate: f.filedDate,
    acceptedAt: f.acceptedAt,
    reportDate: f.reportDate,
    primaryDocDesc: f.primaryDocDesc,
    url: f.url,
    provIdx: ctx.prov.add({
      sourceId: 'sec.submissions',
      provenanceId: f.provenanceId,
      capturedAt: new Date(f.capturedAt),
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    }),
  }));

  ctx.page?.set({ index: 0, count: page.total, cursor: page.nextCursor });
  ctx.unavailable.add({
    field: 'insiders',
    reason: 'NO_SOURCE',
    detail: HDS_INSIDERS_DETAIL,
  });
  return { ...empty, filings };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// fund (§HDS "Resolver", fund)
// ─────────────────────────────────────────────────────────────────────────────────────────────

function compareHoldings(sort: HdsParams['sort'], a: HdsFundHolding, b: HdsFundHolding): number {
  if (sort === 'name') {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.lineNo - b.lineNo;
  }
  const pick = (h: HdsFundHolding): number =>
    (sort === 'weight' ? h.weight : sort === 'shares' ? h.shares : h.marketValue) ??
    Number.NEGATIVE_INFINITY;
  const av = pick(a);
  const bv = pick(b);
  if (av !== bv) return bv - av;
  return a.lineNo - b.lineNo;
}

/**
 * §HDS step 3: one file, not a merge. `params.source` pins one; otherwise the newest `as_of_date`
 * wins and, when two sources report the same date, `ssga.holdings` does — its file is daily and
 * N-PORT is quarterly, and merging two files of the same fund would double-count every line.
 */
function chooseFile(
  lines: readonly EtfHolding[],
  source: HdsParams['source'],
): EtfHolding[] {
  const eligible = source === 'any' ? lines : lines.filter((l) => l.sourceId === source);
  if (eligible.length === 0) return [];
  let best: { asOfDate: string; sourceId: string } | null = null;
  for (const line of eligible) {
    if (best === null || line.asOfDate > best.asOfDate) {
      best = { asOfDate: line.asOfDate, sourceId: line.sourceId };
      continue;
    }
    if (line.asOfDate === best.asOfDate && line.sourceId === 'ssga.holdings') {
      best = { asOfDate: line.asOfDate, sourceId: line.sourceId };
    }
  }
  if (best === null) return [];
  const chosen = best;
  return eligible.filter((l) => l.asOfDate === chosen.asOfDate && l.sourceId === chosen.sourceId);
}

export async function resolveFund(
  ctx: ResolveContext,
  params: HdsParams,
): Promise<HdsFundPayload> {
  const instrument = ctx.instrument;
  if (instrument === null) {
    throw new TypeError('HDS: the runner guarantees a security on a requiresSecurity function');
  }
  const detail = await ctx.data.reference.instrument(instrument.instrumentId);
  const terms = detail.terms?.kind === 'fund' ? detail.terms.terms : null;
  const notes: string[] = [];

  const trackedId = terms?.trackedIndexInstrumentId ?? null;
  const trackedKeys =
    trackedId === null
      ? new Map<number, { key: string; name: string }>()
      : await instrumentKeys(ctx, [trackedId]);
  const fund: HdsFund = {
    instrumentId: instrument.instrumentId,
    key: displayOf(instrument.ticker, instrument.exchCode, instrument.marketSector),
    name: instrument.name,
    fundType: terms?.fundType ?? 'etf',
    sponsor: terms?.sponsor ?? null,
    cik: terms?.cik ?? null,
    expenseRatio: terms?.expenseRatio === undefined || terms.expenseRatio === null ? null : Number(terms.expenseRatio),
    trackedIndex:
      trackedId === null
        ? null
        : { instrumentId: trackedId, key: trackedKeys.get(trackedId)?.key ?? '' },
  };

  // NAV
  const fundSubject = ctx.plant.subjectFor(instrument.instrumentId);
  ctx.plant.ensureHot([fundSubject]);
  const fundState = ctx.plant.snapshot(fundSubject);
  const nav = {
    px: cellFromState(ctx, fundState, 'PX_LAST', fundSubject),
    chgPct: cellFromState(ctx, fundState, 'CHG_PCT_1D', fundSubject),
  };

  // The file
  let lines = chooseFile(
    await ctx.data.holdings.etfHoldings(instrument.instrumentId, params.asOfDate),
    params.source,
  );
  if (lines.length === 0 && fund.cik !== null) {
    if (await tryEnsure(ctx, 'sec.nport', fund.cik, 86_400_000)) {
      lines = chooseFile(
        await ctx.data.holdings.etfHoldings(instrument.instrumentId, params.asOfDate),
        params.source,
      );
    }
  }

  if (lines.length === 0) {
    ctx.unavailable.add({
      field: 'holdings',
      reason: 'NO_SOURCE',
      detail: 'no N-PORT filing or issuer holdings file for this fund',
    });
    return {
      variant: 'fund',
      fund,
      nav,
      file: {
        asOfDate: params.asOfDate ?? utcDate(ctx.asOf.validAt),
        sourceId: params.source === 'ssga.holdings' ? 'ssga.holdings' : 'sec.archives',
        count: 0,
        netAssets: null,
        provIdx: -1,
      },
      holdings: [],
      byAssetCat: [],
      unresolved: { count: 0, reason: null },
      notes,
    };
  }

  const head = lines[0]!;
  const fileProvIdx = citeFile(ctx, {
    sourceId: head.sourceId,
    provenanceId: head.provenanceId,
    capturedAt: head.capturedAt,
    sourceTs: head.sourceTs,
  });
  for (const line of lines.slice(1)) {
    citeFile(ctx, {
      sourceId: line.sourceId,
      provenanceId: line.provenanceId,
      capturedAt: line.capturedAt,
      sourceTs: line.sourceTs,
    });
  }

  // `etf_holdings` has no net-assets column (CONTRACTS §etf_holdings), so the N-PORT header value
  // is not stored anywhere this read can reach. It is reported as absent with a reason rather than
  // reconstructed from Σ market value, which is the fund's holdings, not its net assets.
  ctx.unavailable.add({
    field: 'file.netAssets',
    reason: 'NO_SOURCE',
    detail:
      'NET_ASSETS_NOT_STORED: the N-PORT netAssets header is not persisted by the holdings ' +
      'ingest (etf_holdings has no column for it); the sum of the lines is not substituted for it',
  });

  const eligible = lines.filter((l) => (l.weight ?? 0) >= params.minWeight);
  const keys = await instrumentKeys(
    ctx,
    eligible.flatMap((l) => (l.holdingInstrumentId === null ? [] : [l.holdingInstrumentId])),
  );

  const all: HdsFundHolding[] = eligible.map((line): HdsFundHolding => {
    const id = line.holdingInstrumentId;
    const subject = id === null ? null : ctx.plant.subjectFor(id);
    return {
      lineNo: line.lineNo,
      holdingInstrumentId: id,
      key: id === null ? null : (keys.get(id)?.key ?? null),
      name: line.name,
      cusip: line.cusip,
      isin: line.isin,
      ticker: line.ticker,
      shares: line.shares,
      marketValue: line.marketValue,
      weight: line.weight,
      assetCat: line.assetCat,
      issuerCat: line.issuerCat,
      country: line.country,
      // Filled below, once the page is cut: only the page's rows are snapshotted.
      px: id === null ? storedCell({ v: null, provIdx: fileProvIdx, st: 'na' }) : NA_CELL,
      chgPct: id === null ? storedCell({ v: null, provIdx: fileProvIdx, st: 'na' }) : NA_CELL,
      subject,
    };
  });
  all.sort((a, b) => compareHoldings(params.sort, a, b));

  // Subtotals and the unresolved count are computed over the UNPAGED set (§HDS step 6).
  const byAssetCat = groupByAssetCat(all);
  const unresolvedCount = all.filter((h) => h.holdingInstrumentId === null).length;
  if (unresolvedCount > 0) {
    notes.push(HDS_NOTE_UNRESOLVED);
    ctx.unavailable.add({
      field: 'holdings.key',
      reason: 'NO_SOURCE',
      detail:
        `UNRESOLVED_CONSTITUENTS: ${String(unresolvedCount)} line(s) could not be resolved to an ` +
        'instrument by CUSIP/ISIN; a data_exceptions row exists for each',
    });
  }

  const page = pageOf(
    ctx,
    params.limit,
    all,
    (row, c) => row.lineNo === c.l && (row.weight ?? null) === (c.w ?? null),
    (row) => ({ w: row.weight, l: row.lineNo }),
  );

  // §HDS step 5: live cells for the page only. The resolver never calls `providers.ensure` for a
  // row quote — a cold row renders `…` and fills from the WS `snap` (cell rule 2).
  const subjects = page.flatMap((row) => (row.subject === null ? [] : [row.subject]));
  ctx.plant.ensureHot(subjects);
  const states = ctx.plant.snapshotMany(subjects);
  const holdings = page.map((row): HdsFundHolding => {
    if (row.subject === null) return row;
    const state = states.get(row.subject);
    return {
      ...row,
      px:
        state === undefined
          ? pendingCell(row.subject, 'PX_LAST')
          : cellFromState(ctx, state, 'PX_LAST', row.subject),
      chgPct:
        state === undefined
          ? pendingCell(row.subject, 'CHG_PCT_1D')
          : cellFromState(ctx, state, 'CHG_PCT_1D', row.subject),
    };
  });

  const file: HdsFile = {
    asOfDate: head.asOfDate,
    sourceId: asSourceId(head.sourceId),
    count: all.length,
    netAssets: null,
    provIdx: fileProvIdx,
  };
  if (file.asOfDate < utcDate(ctx.asOf.validAt)) notes.push(HDS_NOTE_PROXY_LAGS);

  return {
    variant: 'fund',
    fund,
    nav,
    file,
    holdings,
    byAssetCat,
    unresolved: {
      count: unresolvedCount,
      reason: unresolvedCount > 0 ? 'UNRESOLVED_IDENTIFIER' : null,
    },
    notes,
  };
}

function groupByAssetCat(
  rows: readonly HdsFundHolding[],
): { assetCat: string; weight: number; count: number }[] {
  const buckets = new Map<string, { weight: number; count: number }>();
  for (const row of rows) {
    const key = row.assetCat ?? 'UNCLASSIFIED';
    const bucket = buckets.get(key) ?? { weight: 0, count: 0 };
    bucket.weight += row.weight ?? 0;
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[1].weight - a[1].weight || (a[0] < b[0] ? -1 : 1))
    .map(([assetCat, b]) => ({ assetCat, weight: b.weight, count: b.count }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const resolve = resolveEquity;

export const variants = {
  equity: resolveEquity,
  etf: resolveFund,
};

export default { resolve, variants };
