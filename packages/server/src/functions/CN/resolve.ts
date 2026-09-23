/**
 * `functions/CN/resolve.ts` — company news (FUNCTIONS_TIER2.md §CN L720-738).
 *
 * ## The linking decision is consumed, not remade
 *
 * A headline reaches this screen because WP-09's linker already wrote a `news_entity_links` row at
 * `confidence ≥ 0.9` under NEWS-02's precision-first rule — which the follow-up commit tightened so
 * that a one-word surface (a bare ticker, a single-token company name) needs corroboration before a
 * link is written at all. CN re-derives none of that. It reads the links, applies
 * `params.minConfidence` as a **floor above** the stored threshold, and when nothing survives it
 * says the stream is empty and why. There is no fallback body search and no relaxed matching: an
 * empty CN is the honest answer for a company the market-wide feeds did not name.
 *
 * ## Filings are folded in, and de-duplicated against the 8-K atom feed
 *
 * NEWS-04 puts the issuer's filings on the same timeline as its headlines. The 8-K atom feed
 * already writes some of them as `news_items` rows whose `provider_guid` carries the accession
 * number, so a filing that arrived both ways would appear twice. The merge keys on the accession
 * number found in a news row's `url` or `items8k`-bearing row and drops the `filings` copy, so one
 * 8-K is one line.
 *
 * ## `members` reads one constituent at a time, and says so
 *
 * §CN's members step 2 calls `data.news.search({ instrumentIds })`. `NewsQuery` has no plural key
 * in this build (`data/news.ts` is WP-04's and not this package's to change), so the union is `k`
 * searches merged and de-duplicated by `newsId`. Each search returns its own `published_at DESC`
 * page of at least `limit` rows, so the first `limit` rows of the merged stream are the first
 * `limit` rows the union would have produced — the same argument NI's rolled-topic merge rests on.
 * The cost is `k` round-trips instead of one, which is recorded here rather than hidden.
 */

import { sql } from 'drizzle-orm';

import type {
  CnFilingRow,
  CnMemberRow,
  CnMemberTag,
  CnParams,
  CnPayload,
  CnRow,
  CnIssuerPayload,
  CnMembersPayload,
  CnWindow,
} from '@terminal/core/functions/manifests/CN';
import {
  CN_MEMBERSHIP_STALE_DAYS,
  CN_NOTE_EMPTY,
  CN_NOTE_ITEM_LABEL_UNKNOWN,
  CN_NOTE_LINK_OUT,
  CN_NOTE_MEMBERSHIP_STALE,
  CN_NOTE_MEMBER_SUBSET,
  CN_NOTE_PRECISION,
  CN_WINDOW_DAYS,
  cnEmptyCounts,
  isCnFilingRow,
} from '@terminal/core/functions/manifests/CN';
import { EIGHT_K_ITEMS, itemLabel } from '@terminal/core/functions/manifests/CF';
import type { AssetClass } from '@terminal/core';

import type { Filing } from '../../data/filings.js';
import type { NewsItem } from '../../data/news.js';
import type { FunctionResolver, ResolveContext } from '../context.js';
import { ProviderUnavailableError } from '../context.js';
import {
  feedHealth,
  filterByLicence,
  newsSourceAccess,
  toNewsRow,
} from '../shared/feedHealth.js';
import { displayOf } from '../shared/instrumentSummary.js';
import { isoInstant } from '../CACS/resolve.js';
import { citeProvenanceIds } from '../MEMB/resolve.js';
import { refreshFeeds } from '../TOP/resolve.js';

const DAY_MS = 86_400_000;

function windowOf(ctx: ResolveContext, label: CnWindow): { from: string; to: string; label: CnWindow } {
  const to = ctx.asOf.validAt;
  const from = new Date(to.getTime() - CN_WINDOW_DAYS[label] * DAY_MS);
  return { from: from.toISOString(), to: to.toISOString(), label };
}

/** The accession number an 8-K atom row carries, so the `filings` copy of it can be dropped. */
function accessionOf(item: NewsItem): string | null {
  const match = /(\d{10}-\d{2}-\d{6})/.exec(item.url);
  if (match !== null) return match[1] ?? null;
  const packed = /\/(\d{18})\//.exec(item.url);
  const digits = packed?.[1];
  if (digits === undefined) return null;
  return `${digits.slice(0, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}`;
}

/** Does this item carry a link, to one of `entityIds` of `kind`, at or above the floor? */
function linkedAtConfidence(
  item: NewsItem,
  kind: 'issuer' | 'instrument',
  entityIds: ReadonlySet<number>,
  floor: number,
): boolean {
  return item.links.some(
    (l) => l.entityKind === kind && entityIds.has(l.entityId) && l.confidence >= floor,
  );
}

function tally(rows: readonly CnRow[]): CnPayload['counts'] {
  const counts = cnEmptyCounts();
  for (const row of rows) counts[row.kind] += 1;
  return counts;
}

/** Newest first; a filing and a headline at the same instant order by their own identifier. */
function byPublishedDesc(a: CnRow, b: CnRow): number {
  if (a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? 1 : -1;
  const an = a.newsId ?? 0;
  const bn = b.newsId ?? 0;
  if (an !== bn) return bn - an;
  const aa = isCnFilingRow(a) ? a.accessionNo : '';
  const ba = isCnFilingRow(b) ? b.accessionNo : '';
  return aa < ba ? 1 : aa > ba ? -1 : 0;
}

function encodeCursor(row: CnRow | undefined): string | null {
  if (row === undefined) return null;
  return Buffer.from(
    JSON.stringify({
      publishedAt: row.publishedAt,
      newsId: row.newsId,
      accessionNo: isCnFilingRow(row) ? row.accessionNo : null,
    }),
    'utf8',
  ).toString('base64url');
}

/** Refresh the market-wide feeds when they are behind, tolerating a dead upstream (TERM-12). */
async function refreshNewsFeeds(ctx: ResolveContext): Promise<void> {
  const health = await feedHealth(ctx);
  await refreshFeeds(ctx, health);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Filings fold-in (§CN issuer step 4)
// ─────────────────────────────────────────────────────────────────────────────────────────────

function filingHeadline(filing: Filing, notes: string[]): string {
  const labels = filing.items.map((code) => {
    if (!(code in EIGHT_K_ITEMS) && !notes.includes(CN_NOTE_ITEM_LABEL_UNKNOWN)) {
      notes.push(CN_NOTE_ITEM_LABEL_UNKNOWN);
    }
    return itemLabel(code);
  });
  const tail =
    labels.length > 0 ? labels.join('; ') : (filing.primaryDocDesc ?? 'filing');
  const items = filing.items.length > 0 ? ` (Item ${filing.items.join(', ')})` : '';
  return `${filing.form} — ${tail}${items}`;
}

function toFilingRow(
  ctx: ResolveContext,
  filing: Filing,
  issuer: { issuerId: number | null; name: string },
  notes: string[],
): CnFilingRow {
  // Rule 6 is per cell, and `newsId` is a declared numeric column, so the one row shape that is
  // *never* a `news_items` row says so rather than showing a blank the screen cannot explain. It is
  // the union's discriminant (CN.ts: `newsId === null` is what makes a row a filing), not a gap in
  // a source — hence NOT_APPLICABLE, and hence `accessionNo` beside it.
  ctx.unavailable.add({
    field: 'rows.newsId',
    reason: 'NOT_APPLICABLE',
    detail:
      'a filing headline (NEWS-04) is rendered from the SEC filings index rather than from a ' +
      'news_items row, so it is identified by its accessionNo and carries no newsId',
  });
  return {
    newsId: null,
    accessionNo: filing.accessionNo,
    headline: filingHeadline(filing, notes),
    summary: filing.primaryDocDesc,
    sourceId: 'sec.submissions',
    feed: 'edgar',
    kind: 'filing',
    author: null,
    category: filing.form,
    cik: filing.cik,
    items8k: filing.items.length > 0 ? filing.items : null,
    publishedAt:
      filing.acceptedAt === null
        ? `${filing.filedDate}T00:00:00.000Z`
        : isoInstant(filing.acceptedAt),
    capturedAt: isoInstant(filing.capturedAt),
    url: filing.url,
    isCorrection: filing.isCorrection,
    machineGenerated: false,
    links:
      issuer.issuerId === null
        ? []
        : [
            {
              entityKind: 'issuer',
              entityId: issuer.issuerId,
              display: issuer.name,
              confidence: 1,
              method: 'cik',
            },
          ],
    provIdx: ctx.prov.add({
      sourceId: 'sec.submissions',
      provenanceId: filing.provenanceId,
      capturedAt: new Date(filing.capturedAt),
      sourceTs: filing.acceptedAt === null ? null : new Date(filing.acceptedAt),
      st: 'closed',
      tier: 'eod',
    }),
  };
}

/** Was this filer's submissions index captured inside the read-through's own freshness window? */
async function filingsAreFresh(ctx: ResolveContext, cik: string): Promise<boolean> {
  const since = new Date(ctx.clock.now() - 21_600_000).toISOString();
  const res = await ctx.db.execute<{ fresh: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM filings
       WHERE cik = ${cik}
         AND captured_at >= ${since}::timestamptz
    ) AS fresh`);
  return res.rows[0]?.fresh === true;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// issuer variant
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function issuer(ctx: ResolveContext, params: CnParams): Promise<CnIssuerPayload> {
  const instrument = ctx.instrument;
  if (instrument === null) throw new TypeError('CN: the issuer variant needs a security');

  const notes: string[] = [CN_NOTE_PRECISION, CN_NOTE_LINK_OUT];
  const detail = await ctx.data.reference.instrument(instrument.instrumentId);
  const issuerId = detail.issuer?.issuerId ?? null;
  const issuerName = detail.issuer?.name ?? instrument.name;
  const cik = detail.issuer?.cik ?? null;
  const window = windowOf(ctx, params.window);

  await refreshNewsFeeds(ctx);

  // 3 — the headline page. The service filters the link join at the stored 0.9 floor; a higher
  // `minConfidence` is applied here, over the links the item carries.
  const page = await ctx.data.news.search({
    ...(issuerId === null ? { instrumentId: instrument.instrumentId } : { issuerId }),
    kinds: params.kinds,
    ...(params.q === undefined ? {} : { q: params.q }),
    from: window.from,
    to: window.to,
    ...(ctx.page?.cursor == null ? {} : { cursor: ctx.page.cursor }),
    limit: params.limit,
  });

  const entityKind = issuerId === null ? 'instrument' : 'issuer';
  const entityIds = new Set<number>([issuerId ?? instrument.instrumentId]);
  const confident = page.items.filter((item) =>
    linkedAtConfidence(item, entityKind, entityIds, params.minConfidence),
  );

  const access = await newsSourceAccess(ctx);
  const { kept } = filterByLicence(ctx, confident, access, 'CN');
  const headlines: CnRow[] = kept.map((item) => toNewsRow(ctx, item));
  const seenAccessions = new Set<string>();
  for (const item of kept) {
    const accession = accessionOf(item);
    if (accession !== null) seenAccessions.add(accession);
  }

  // 4 — the filings fold-in.
  const filingRows: CnFilingRow[] = [];
  if (params.kinds.includes('filing') && cik !== null) {
    // §CN step 4's read-through, made conditional on the stored index actually being stale: a
    // screen whose filings were captured minutes ago has no business probing the provider path,
    // and a circuit that happens to be open would otherwise be reported as a staleness the data
    // does not have.
    if (ctx.usage !== 'export' && !(await filingsAreFresh(ctx, cik))) {
      try {
        await ctx.providers.ensure('sec.submissions', cik, { maxAgeMs: 21_600_000 });
      } catch (err) {
        if (!(err instanceof ProviderUnavailableError)) throw err;
        ctx.unavailable.add({
          field: 'filings',
          reason: 'NO_SOURCE',
          detail: 'PROVIDER_DOWN: serving the stored filings index',
        });
      }
    }
    const filings = await ctx.data.filings.list(cik, {
      from: window.from.slice(0, 10),
      to: window.to.slice(0, 10),
      limit: params.limit,
    });
    for (const filing of filings.items) {
      if (seenAccessions.has(filing.accessionNo)) continue;
      filingRows.push(
        toFilingRow(ctx, filing, { issuerId, name: issuerName }, notes),
      );
    }
  } else if (params.kinds.includes('filing') && cik === null) {
    ctx.unavailable.add({
      field: 'filings',
      reason: 'NO_SOURCE',
      detail: 'issuer has no SEC CIK (not an SEC filer)',
    });
  }

  // 5 — merge, tally the untruncated set, truncate.
  const merged = [...headlines, ...filingRows].sort(byPublishedDesc);
  const counts = tally(merged);
  const rows = merged.slice(0, params.limit);
  const total = page.total + filingRows.length;

  // 6 — paging.
  ctx.page?.set({
    index: 0,
    count: total,
    cursor: rows.length < total ? encodeCursor(rows.at(-1)) : null,
  });

  // 7 — the notes and the one entry every run carries.
  ctx.unavailable.add({
    field: 'summary',
    reason: 'NOT_LICENSED',
    detail:
      `${CN_NOTE_LINK_OUT}: Bloomberg RSS is link-out only; the article body is never stored or ` +
      'served (DATA_MODEL §10)',
  });
  if (rows.length === 0) {
    notes.push(CN_NOTE_EMPTY);
    ctx.unavailable.add({
      field: 'rows',
      reason: 'NO_SOURCE',
      detail:
        `${CN_NOTE_EMPTY}: no headline in the Bloomberg RSS feeds was linked to this issuer at ` +
        'confidence ≥ 0.9 in the window (NEWS-02 is precision-first); widen the window or press F ' +
        'for filings only',
    });
  }

  return {
    variant: 'issuer',
    security: {
      instrumentId: instrument.instrumentId,
      key: displayOf(instrument.ticker, instrument.exchCode, instrument.marketSector),
      name: instrument.name,
    },
    issuer: { issuerId, name: issuerName, cik },
    window,
    rows,
    counts,
    total,
    liveSubject: `n:inst:${String(instrument.instrumentId)}`,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// members variant
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function membersVariant(ctx: ResolveContext, params: CnParams): Promise<CnMembersPayload> {
  const instrument = ctx.instrument;
  if (instrument === null) throw new TypeError('CN: the members variant needs an index');

  const notes: string[] = [CN_NOTE_PRECISION, CN_NOTE_LINK_OUT, CN_NOTE_MEMBER_SUBSET];
  const window = windowOf(ctx, params.window);

  const roster = await ctx.data.reference.members(instrument.instrumentId);
  const shown = [...roster.members]
    .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
    .slice(0, params.members);
  const byId = new Map(shown.map((m) => [m.instrumentId, m]));
  const shownIds = new Set(shown.map((m) => m.instrumentId));

  const ageDays =
    (ctx.asOf.validAt.getTime() - Date.parse(`${roster.asOfDate}T00:00:00Z`)) / DAY_MS;
  if (ageDays > CN_MEMBERSHIP_STALE_DAYS) notes.push(CN_NOTE_MEMBERSHIP_STALE);

  await refreshNewsFeeds(ctx);

  // One search per shown constituent, merged — see the file header.
  const merged = new Map<number, NewsItem>();
  for (const member of shown) {
    const page = await ctx.data.news.search({
      instrumentId: member.instrumentId,
      kinds: params.kinds,
      ...(params.q === undefined ? {} : { q: params.q }),
      from: window.from,
      to: window.to,
      limit: params.limit,
    });
    for (const item of page.items) {
      if (!linkedAtConfidence(item, 'instrument', shownIds, params.minConfidence)) continue;
      merged.set(item.newsId, item);
    }
  }

  const access = await newsSourceAccess(ctx);
  const { kept } = filterByLicence(ctx, [...merged.values()], access, 'CN');
  const rows: CnMemberRow[] = kept
    .map((item): CnMemberRow => {
      const tags: CnMemberTag[] = [];
      for (const link of item.links) {
        if (link.entityKind !== 'instrument') continue;
        const member = byId.get(link.entityId);
        if (member === undefined) continue;
        if (link.confidence < params.minConfidence) continue;
        tags.push({
          instrumentId: member.instrumentId,
          key: displayOf(member.ticker, member.exchCode, member.marketSector),
          weight: member.weight,
        });
      }
      return { ...toNewsRow(ctx, item), members: tags };
    })
    .sort(byPublishedDesc);

  const counts = tally(rows);
  const paged = rows.slice(0, params.limit);

  ctx.page?.set({
    index: 0,
    count: rows.length,
    cursor: paged.length < rows.length ? encodeCursor(paged.at(-1)) : null,
  });

  ctx.unavailable.add({
    field: 'summary',
    reason: 'NOT_LICENSED',
    detail:
      `${CN_NOTE_LINK_OUT}: Bloomberg RSS is link-out only; the article body is never stored or ` +
      'served (DATA_MODEL §10)',
  });
  if (paged.length === 0) {
    notes.push(CN_NOTE_EMPTY);
    ctx.unavailable.add({
      field: 'rows',
      reason: 'NO_SOURCE',
      detail: `${CN_NOTE_EMPTY}: no headline linked to the top N constituents in the window`,
    });
  }

  // See `functions/MEMB/resolve.ts#citeProvenanceIds`: a reader's `provIdx` indexes the data
  // services' own provenance array, not the payload's.
  const rosterProv = await citeProvenanceIds(ctx, shown.map((m) => m.provenanceId));
  const membershipProvIdx =
    shown[0] === undefined ? -1 : (rosterProv.get(shown[0].provenanceId) ?? -1);

  return {
    variant: 'members',
    index: {
      instrumentId: instrument.instrumentId,
      key: displayOf(instrument.ticker, instrument.exchCode, instrument.marketSector),
      name: instrument.name,
      indexId: roster.indexId,
    },
    membership: {
      asOfDate: roster.asOfDate,
      sourceId: shown[0]?.sourceId ?? '',
      shown: shown.length,
      total: roster.members.length,
      provIdx: membershipProvIdx,
    },
    window,
    rows: paged,
    counts,
    total: rows.length,
    liveSubjects: shown.map((m) => `n:inst:${String(m.instrumentId)}`),
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const variants = {
  equity: issuer,
  etf: issuer,
  index: membersVariant,
} satisfies Partial<Record<AssetClass, FunctionResolver<CnParams, CnPayload>>>;

export const resolve: FunctionResolver<CnParams, CnPayload> = issuer;

export default { resolve, variants };
