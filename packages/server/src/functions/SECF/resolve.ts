/**
 * `functions/SECF/resolve.ts` — Security Finder (FUNCTIONS_TIER1.md §SECF L2252-2260).
 *
 * Filtered, faceted, keyset-paged search over the security master. Four things decide the shape of
 * this file, and each one is a rule from the tier document rather than a convenience:
 *
 *  1. **Facets are computed over the filtered set, before paging** (§SECF step 4), so the tab
 *     counts do not move as the user pages. They come from their own aggregate statement over the
 *     same predicate the row query uses — the alternative, counting the page, would be a number
 *     that changes every PageDown.
 *  2. **Exact identifier queries short-circuit ranking** (step 2): an ISIN, CUSIP or FIGI is not a
 *     name fragment, and a user who typed one wants that instrument at `score: 1`, not the best
 *     trigram match for its digits.
 *  3. **PAGE FWD means the next `pageSize` hits further down the ranking** (step 5). The cursor is
 *     the last row's sort key — `{s,i}`, `{t,i}` or `{n,i}` — and PAGE BACK re-runs with the
 *     inverted predicate, so page 1 → page 2 → back returns page 1 byte-identically.
 *  4. **A Yahoo hit is never written to the master** (step 6). It is marked, `instrumentId: -1`,
 *     and `Enter` on it goes through `POST /ref/resolve`, which is the only path that may create a
 *     master row.
 *
 * ## Two recorded deviations
 *
 * **Ordering is applied in this process, not in SQL.** §SECF step 1 says the ranking is
 * `rank(query, universeIndex, ctx, registry)` so that SECF and the command line agree byte for
 * byte (TERM-02). `rank()` caps its answer at twelve rows (`MAX_RESULTS`, FUNCTIONS.md §3.3) and
 * SECF pages up to 200 at a time, so it cannot be the orderer here. What this file does instead is
 * use `rank()`'s *own* match constants and tie-break (`compareCandidates`), exported from
 * `core/command/rank.ts`, over the candidate rows SQL returned — so the terms that differ are the
 * ones `rank()` computes from client state SECF does not have (MRU, watchlist, panel context) and
 * the per-kind caps, not the scoring of a ticker or a name. The candidate set is bounded by
 * {@link SECF_MAX_CANDIDATES}; when the filter matches more than that, the truncation is reported
 * in `meta.unavailable` rather than silently served.
 *
 * **The stored Yahoo response lives in the capture store, not in `provenance`.** See
 * {@link yahooHits}: `provenance` records the metadata of an exchange and the bytes are held under
 * its `request_key` by `providers/replayStore.ts`. §SECF step 6's "read the stored response" is
 * therefore two reads, and neither of them is a fetch.
 *
 * **`'yahoo.search'` is not yet a `ReadThroughKind`.** FUNCTIONS.md §1.4.2 declares fourteen kinds
 * and this is the fifteenth (§SECF step 6 records it under "Additions required"). `context.ts`
 * belongs to WP-08, so the union is widened at this one call site instead, and the call behaves
 * exactly as the document specifies: no route is registered for the kind, so `ensure` degrades,
 * and the degradation is reported as `YAHOO_FALLBACK_UNAVAILABLE` with `source: 'master'` — never
 * as an error, and never as a fabricated hit.
 */

import { sql } from 'drizzle-orm';

import type { AssetClass, MatchedOn } from '@terminal/core';
import { compareCandidates, jaccard, trigramsOf } from '@terminal/core';
// `rank()`'s own match constants. The core barrel re-exports `rank` and `compareCandidates` but
// not the constants they are built from, so the scoring terms come from the module itself — which
// is what keeps SECF's ordering byte-identical to the command line's (TERM-02).
import { TRIGRAM_MIN_QUERY_LENGTH, TRIGRAM_MIN_SCORE } from '@terminal/core/command/index';
import {
  MATCH_NAME_FIRST_WORD,
  MATCH_NAME_OTHER_WORD,
  MATCH_TICKER_EXACT,
  MATCH_TICKER_PREFIX_BASE,
  MATCH_TICKER_PREFIX_DECAY,
  MATCH_TICKER_PREFIX_FLOOR,
  MATCH_TRIGRAM_FACTOR,
  PENALTY_INACTIVE,
  POPULARITY_INSTRUMENT_FACTOR,
  POPULARITY_INSTRUMENT_MAX,
} from '@terminal/core/command/rank';
import type {
  SecfCursor,
  SecfHit,
  SecfParams,
  SecfPayload,
} from '@terminal/core/functions/manifests/SECF';

import type { FunctionServerModule, ReadThroughKind, ResolveContext } from '../context.js';
import { openReplayStore } from '../../providers/replayStore.js';
import { ValidationFailedError } from '../../http/errors.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The most candidate rows one search scores. Beyond this the truncation is reported. */
export const SECF_MAX_CANDIDATES = 5_000;

/** Yahoo contributes at most this many rows, and only below {@link FALLBACK_HIT_FLOOR} master hits. */
export const YAHOO_FALLBACK_MAX = 8;
export const FALLBACK_HIT_FLOOR = 3;
export const FALLBACK_MIN_QUERY_LENGTH = 3;

/** §SECF step 6: the fifteenth read-through kind (see the module docstring). */
const YAHOO_SEARCH = 'yahoo.search' as ReadThroughKind;
const YAHOO_MAX_AGE_MS = 3_600_000;

/** Exact-identifier shapes (step 2). */
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const CUSIP_RE = /^[A-Z0-9]{9}$/;
const FIGI_RE = /^BBG[A-Z0-9]{8}\d$/;

/** The synthetic `exch_code`s of the classes that are not listed anywhere (§SECF L2319). */
const PSEUDO_VENUES: ReadonlySet<string> = new Set([
  'GOVT',
  'FX',
  'INDEX',
  'RATE',
  'ECON',
  'CRYPTO',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SQL row shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface CandidateRow extends Record<string, unknown> {
  instrument_id: string;
  asset_class: AssetClass;
  market_sector: string;
  ticker: string;
  exch_code: string;
  name: string;
  currency: string;
  status: string;
  price_decimals: number;
  search_weight: number;
  composite_figi: string | null;
  primary_listing_id: string | null;
  md_line_ids: string[] | null;
  security_type: string | null;
  country_of_issue: string | null;
  issuer_id: string | null;
  listings: number;
  bbg_exch_code: string | null;
  gics_sector: string | null;
  figi: string | null;
  isin: string | null;
  cusip: string | null;
  member_of: string[] | null;
  provenance_id: string;
  source_id: string;
  captured_at: string;
}

interface FacetRow extends Record<string, unknown> {
  bucket: string;
  key: string;
  n: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Matching (the `match` term of FUNCTIONS.md §3.3, verbatim constants)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Match {
  matchedOn: MatchedOn;
  score: number;
  matched: [number, number][];
}

/** Highlight range of `q` inside `display`, or none when the two do not literally overlap. */
function highlight(display: string, q: string): [number, number][] {
  const at = display.toUpperCase().indexOf(q);
  return at < 0 ? [] : [[at, at + q.length]];
}

/**
 * The best match of `q` against one row, scored with `rank()`'s own constants.
 *
 * Order matters: a ticker match beats a name match at every length, because `80 − 2·(len − |q|)`
 * bottoms out at 60 and a non-first name word scores 50. That is the ordering the command line
 * shows, and SECF showing a different one would make `Enter` on row 0 mean two different things.
 */
function matchOf(row: CandidateRow, q: string, display: string): Match | null {
  if (q === '') return { matchedOn: 'ticker', score: 0, matched: [] };

  const ticker = row.ticker.toUpperCase();
  if (ticker === q) {
    return { matchedOn: 'ticker', score: MATCH_TICKER_EXACT, matched: highlight(display, q) };
  }
  if (ticker.startsWith(q)) {
    const score = Math.max(
      MATCH_TICKER_PREFIX_FLOOR,
      MATCH_TICKER_PREFIX_BASE - MATCH_TICKER_PREFIX_DECAY * (ticker.length - q.length),
    );
    return { matchedOn: 'ticker', score, matched: highlight(display, q) };
  }

  const words = row.name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((w) => w.length > 0);
  const wordIndex = words.findIndex((w) => w.startsWith(q));
  if (wordIndex === 0) {
    return { matchedOn: 'name', score: MATCH_NAME_FIRST_WORD, matched: highlight(display, q) };
  }
  if (wordIndex > 0) {
    return { matchedOn: 'name', score: MATCH_NAME_OTHER_WORD, matched: highlight(display, q) };
  }

  if (q.length >= TRIGRAM_MIN_QUERY_LENGTH) {
    const similarity = Math.max(
      jaccard(trigramsOf(q), trigramsOf(row.name)),
      jaccard(trigramsOf(q), trigramsOf(row.ticker)),
    );
    if (similarity >= TRIGRAM_MIN_SCORE) {
      return {
        matchedOn: 'trigram',
        score: MATCH_TRIGRAM_FACTOR * similarity,
        matched: highlight(display, q),
      };
    }
  }
  return null;
}

/** `popularity` and `penalties` for an instrument row (§3.3 L949, L955). */
function nonMatchTerms(row: CandidateRow): number {
  const weight = Number.isFinite(row.search_weight) ? row.search_weight : 1;
  const pop = Math.min(
    POPULARITY_INSTRUMENT_MAX,
    POPULARITY_INSTRUMENT_FACTOR * Math.max(0, weight),
  );
  return pop + (row.status === 'active' ? 0 : PENALTY_INACTIVE);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cursor
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function encodeCursor(cursor: SecfCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** A cursor that does not decode is `400 VALIDATION_FAILED page.cursor` (§SECF step 5). */
export function decodeCursor(raw: string): SecfCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw cursorError(raw);
  }
  if (typeof parsed !== 'object' || parsed === null) throw cursorError(raw);
  const c = parsed as Record<string, unknown>;
  if (typeof c.i !== 'number') throw cursorError(raw);
  if (typeof c.s === 'number') return { s: c.s, i: c.i };
  if (typeof c.t === 'string') return { t: c.t, i: c.i };
  if (typeof c.n === 'string') return { n: c.n, i: c.i };
  throw cursorError(raw);
}

function cursorError(raw: string): ValidationFailedError {
  return new ValidationFailedError('body', [
    { code: 'custom', path: ['page', 'cursor'], message: `cursor does not decode: ${raw}` },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Scored {
  row: CandidateRow;
  hit: SecfHit;
  /** The sort key, by `params.sort`. */
  key: SecfCursor;
}

export async function resolve(ctx: ResolveContext, params: SecfParams): Promise<SecfPayload> {
  const q = params.query.trim().toUpperCase();
  const exact = exactIdentifier(q);

  const filters = await buildFilters(ctx, params);
  const predicate = wherePredicate(params, filters, q, exact);

  const [rows, facets] = await Promise.all([
    candidates(ctx, predicate),
    facetCounts(ctx, predicate),
  ]);

  if (facets.total > SECF_MAX_CANDIDATES) {
    ctx.unavailable.add({
      field: 'hits',
      reason: 'NO_SOURCE',
      detail:
        `${String(facets.total)} instruments match these filters; only the first ` +
        `${String(SECF_MAX_CANDIDATES)} by search weight were ranked — narrow the query`,
    });
  }

  // ── score, decorate, order ────────────────────────────────────────────────────────────────
  const scored: Scored[] = [];
  let gicsMissing = false;
  for (const row of rows) {
    const display = displayOf(row);
    const match =
      exact === null
        ? matchOf(row, q, display)
        : { matchedOn: exact.scheme, score: 1, matched: highlight(display, q) };
    if (match === null) continue;

    const provIdx = ctx.prov.add({
      sourceId: row.source_id,
      provenanceId: Number(row.provenance_id),
      capturedAt: new Date(row.captured_at),
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    });

    const score = exact === null ? match.score + nonMatchTerms(row) : match.score;
    if (row.gics_sector === null) gicsMissing = true;

    const hit: SecfHit & { provIdx: number } = {
      instrument: {
        instrumentId: Number(row.instrument_id),
        assetClass: row.asset_class,
        marketSector: row.market_sector as SecfHit['instrument']['marketSector'],
        display,
        name: row.name,
        currency: row.currency.trim(),
        mdLineIds: (row.md_line_ids ?? []).map(Number).sort((a, b) => a - b),
        ticker: row.ticker,
        exchCode: row.exch_code,
        securityType: row.security_type ?? '',
        compositeFigi: row.composite_figi,
        status: row.status as SecfHit['instrument']['status'],
        priceDecimals: row.price_decimals,
        ...(row.primary_listing_id === null
          ? {}
          : { primaryListingId: Number(row.primary_listing_id) }),
      },
      matchedOn: match.matchedOn,
      matched: match.matched,
      score,
      identifiers: { figi: row.figi, isin: row.isin, cusip: row.cusip },
      memberOf: row.member_of ?? [],
      listings: row.listings,
      gicsSector: row.gics_sector,
      provIdx,
    };
    scored.push({ row, hit, key: sortKey(params.sort, row, score) });
  }

  scored.sort((a, b) => compare(params.sort, a, b));

  // ── page ──────────────────────────────────────────────────────────────────────────────────
  const page = pageOf(scored, params, ctx);
  let hits = page.hits.map((s) => s.hit);
  let source: SecfPayload['source'] = 'master';

  // ── Yahoo fallback (step 6) ───────────────────────────────────────────────────────────────
  if (hits.length < FALLBACK_HIT_FLOOR && params.query.trim().length >= FALLBACK_MIN_QUERY_LENGTH) {
    source = await fallback(ctx, params, hits);
  }

  // ── the standing notes (§SECF L2309-2319) ─────────────────────────────────────────────────
  if (hits.length === 0) {
    ctx.unavailable.add({
      field: 'hits',
      reason: 'NO_SOURCE',
      detail: `no instrument matches "${params.query}" with these filters`,
    });
  }
  ctx.unavailable.add({
    field: 'memberOf',
    reason: 'NO_SOURCE',
    detail:
      'membership is sourced only for SPX (SPY N-PORT + SSGA daily holdings); other indices have ' +
      'indices.membership_source_id = null',
  });
  if (gicsMissing) {
    ctx.unavailable.add({
      field: 'hits[].gicsSector',
      reason: 'NO_SOURCE',
      detail: 'GICS names are seeded from wiki.sp500 for S&P 500 issuers only',
    });
  }
  if (filters.droppedIndexMember !== null) {
    ctx.unavailable.add({
      field: 'indexMember',
      reason: 'NO_SOURCE',
      detail: `index ${filters.droppedIndexMember} has no membership source — the IDX filter was ignored`,
    });
  }
  if (Object.keys(facets.exchange).some((code) => PSEUDO_VENUES.has(code))) {
    ctx.unavailable.add({
      field: 'facets.exchange',
      reason: 'NOT_APPLICABLE',
      detail: 'non-listed instruments (govt, fx, rate, econ, crypto) have no exchange',
    });
  }
  for (const hit of hits) {
    if (hit.identifiers.isin === null && hit.instrument.instrumentId > 0) {
      ctx.unavailable.add({
        field: 'hits[].identifiers.isin',
        reason: 'NO_SOURCE',
        detail: 'OpenFIGI publishes no ISIN for this instrument',
      });
      break;
    }
  }

  // A Yahoo row is clamped below every master hit and never reorders one (step 6).
  hits = [...hits];
  return { variant: 'default', hits, total: facets.total, facets: facets.facets, source };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Filters, predicate and the two statements
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Filters {
  /** `indices.index_id` the `IDX=` filter resolved to, or `null` when it was dropped. */
  indexId: number | null;
  /** The index code whose filter was dropped for want of a membership source. */
  droppedIndexMember: string | null;
}

async function buildFilters(ctx: ResolveContext, params: SecfParams): Promise<Filters> {
  if (params.indexMember === undefined) return { indexId: null, droppedIndexMember: null };
  const code = params.indexMember.trim().toUpperCase();
  const res = await ctx.db.execute<{ index_id: string; membership_source_id: string | null }>(sql`
    SELECT index_id::text AS index_id, membership_source_id FROM indices WHERE code = ${code}`);
  const row = res.rows[0];
  // §SECF L2314: an index with no membership source drops the filter and returns every hit,
  // rather than an empty grid the user cannot explain.
  if ((row?.membership_source_id ?? null) === null) {
    return { indexId: null, droppedIndexMember: code };
  }
  return { indexId: Number(row!.index_id), droppedIndexMember: null };
}

type ExactScheme = Extract<MatchedOn, 'isin' | 'cusip' | 'figi'>;

/**
 * Which identifier a query *is*, tested most-specific first.
 *
 * **FIGI before ISIN, deliberately.** Every FIGI satisfies the ISIN shape as well —
 * `BBG000B9XRY4` is two letters, nine alphanumerics and a check digit — so testing ISIN first
 * would mean no FIGI was ever recognised and `SECF BBG000B9XRY4` would look up a Barbadian ISIN
 * that does not exist. `BBG` + eight + a digit is the stronger signal, and the collision only ever
 * runs the other way for a hypothetical Barbados ISIN beginning `BBG`, which would then be found
 * by the FIGI branch's `composite_figi`/`FIGI` lookups and miss — the same miss it would have had.
 */
function exactIdentifier(q: string): { scheme: ExactScheme; value: string } | null {
  if (FIGI_RE.test(q)) return { scheme: 'figi', value: q };
  if (ISIN_RE.test(q)) return { scheme: 'isin', value: q };
  if (CUSIP_RE.test(q)) return { scheme: 'cusip', value: q };
  return null;
}

/** The one `WHERE` both statements share, so the facets describe exactly the rows. */
function wherePredicate(
  params: SecfParams,
  filters: Filters,
  q: string,
  exact: { scheme: ExactScheme; value: string } | null,
): ReturnType<typeof sql> {
  const clauses = [sql`i.tx_to = 'infinity' AND i.valid_to = 'infinity'`];

  if (params.status === 'active') clauses.push(sql`i.status = 'active'`);
  if (params.assetClass !== undefined) {
    clauses.push(sql`i.asset_class = ${params.assetClass}::asset_class`);
  }
  if (params.sector !== undefined) {
    clauses.push(sql`i.market_sector = ${params.sector}::market_sector`);
  }
  if (params.country !== undefined) {
    clauses.push(sql`iss.country_of_issue = ${params.country.toUpperCase()}`);
  }
  if (params.exchange !== undefined) {
    // `EXCH=UW`, `EXCH=XNAS` and `EXCH=US` all match the same listing (step 2).
    const code = params.exchange.toUpperCase();
    clauses.push(sql`(
      i.exch_code = ${code}
      OR EXISTS (
        SELECT 1 FROM listings l2
          LEFT JOIN exchanges x2 ON x2.mic = l2.mic
         WHERE l2.instrument_id = i.instrument_id AND l2.tx_to = 'infinity'
           AND (upper(l2.exch_code) = ${code} OR l2.mic = ${code}
                OR upper(x2.bbg_exch_code) = ${code} OR upper(x2.composite_code) = ${code}))
    )`);
  }
  if (filters.indexId !== null) {
    clauses.push(sql`EXISTS (
      SELECT 1 FROM index_members im2
       WHERE im2.instrument_id = i.instrument_id AND im2.index_id = ${filters.indexId}::bigint
         AND im2.tx_to = 'infinity' AND im2.valid_to = 'infinity')`);
  }

  if (exact !== null) {
    const schemes =
      exact.scheme === 'figi'
        ? sql`('FIGI','COMPOSITE_FIGI','SHARE_CLASS_FIGI')`
        : exact.scheme === 'isin'
          ? sql`('ISIN')`
          : sql`('CUSIP')`;
    clauses.push(sql`(
      i.composite_figi = ${exact.value}
      OR EXISTS (
        SELECT 1 FROM identifiers id2
         WHERE id2.entity_kind = 'instrument' AND id2.entity_id = i.instrument_id
           AND id2.tx_to = 'infinity' AND upper(id2.value) = ${exact.value}
           AND id2.scheme::text IN ${schemes}))`);
  } else if (q !== '') {
    clauses.push(sql`(
      upper(i.ticker) LIKE ${`${q}%`}
      OR i.name ILIKE ${`%${q}%`}
      OR i.name % ${q}
      OR EXISTS (
        SELECT 1 FROM issuer_aliases ia
         WHERE ia.issuer_id = iss.issuer_id AND upper(ia.alias) LIKE ${`${q}%`}))`);
  }

  return sql.join(clauses, sql` AND `);
}

/** The candidate rows, decorated, bounded by {@link SECF_MAX_CANDIDATES}. */
async function candidates(
  ctx: ResolveContext,
  predicate: ReturnType<typeof sql>,
): Promise<CandidateRow[]> {
  const res = await ctx.db.execute<CandidateRow>(sql`
    SELECT i.instrument_id::text AS instrument_id, i.asset_class, i.market_sector::text AS market_sector,
           i.ticker, i.exch_code, i.name, i.currency, i.status, i.price_decimals, i.search_weight,
           i.composite_figi, i.primary_listing_id::text AS primary_listing_id,
           i.provenance_id::text AS provenance_id,
           p.source_id,
           to_char(p.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
           iss.security_type, iss.country_of_issue, isr.issuer_id::text AS issuer_id,
           (SELECT count(*)::int FROM listings l
             WHERE l.instrument_id = i.instrument_id AND l.tx_to = 'infinity'
               AND l.valid_to = 'infinity') AS listings,
           (SELECT array_agg(m.md_line_id::text ORDER BY m.md_line_id) FROM md_lines m
             WHERE m.instrument_id = i.instrument_id AND m.tx_to = 'infinity'
               AND m.valid_to = 'infinity') AS md_line_ids,
           (SELECT x.bbg_exch_code FROM listings l
              JOIN exchanges x ON x.mic = l.mic
             WHERE l.instrument_id = i.instrument_id AND l.tx_to = 'infinity'
             ORDER BY l.is_primary DESC, l.listing_id LIMIT 1) AS bbg_exch_code,
           (SELECT cc.name FROM entity_classifications ec
              JOIN classification_codes cc ON cc.scheme = ec.scheme AND cc.code = ec.code
             WHERE ec.entity_kind = 'issuer' AND ec.entity_id = isr.issuer_id
               AND ec.scheme = 'GICS' AND ec.tx_to = 'infinity' AND ec.valid_to = 'infinity'
               AND cc.level = 1 LIMIT 1) AS gics_sector,
           (SELECT id.value FROM identifiers id
             WHERE id.entity_kind = 'instrument' AND id.entity_id = i.instrument_id
               AND id.scheme = 'FIGI' AND id.tx_to = 'infinity' AND id.valid_to = 'infinity'
             ORDER BY id.is_primary DESC, id.version_id LIMIT 1) AS figi,
           (SELECT id.value FROM identifiers id
             WHERE id.entity_kind = 'instrument' AND id.entity_id = i.instrument_id
               AND id.scheme = 'ISIN' AND id.tx_to = 'infinity' AND id.valid_to = 'infinity'
             ORDER BY id.is_primary DESC, id.version_id LIMIT 1) AS isin,
           (SELECT id.value FROM identifiers id
             WHERE id.entity_kind = 'instrument' AND id.entity_id = i.instrument_id
               AND id.scheme = 'CUSIP' AND id.tx_to = 'infinity' AND id.valid_to = 'infinity'
             ORDER BY id.is_primary DESC, id.version_id LIMIT 1) AS cusip,
           (SELECT array_agg(ix.code ORDER BY ix.code) FROM index_members im
              JOIN indices ix ON ix.index_id = im.index_id
             WHERE im.instrument_id = i.instrument_id AND im.tx_to = 'infinity'
               AND im.valid_to = 'infinity') AS member_of
      FROM instruments i
      JOIN provenance p ON p.provenance_id = i.provenance_id
      LEFT JOIN issues iss ON iss.issue_id = i.issue_id AND iss.tx_to = 'infinity'
                          AND iss.valid_to = 'infinity'
      LEFT JOIN issuers isr ON isr.issuer_id = iss.issuer_id AND isr.tx_to = 'infinity'
                           AND isr.valid_to = 'infinity'
     WHERE ${predicate}
     ORDER BY i.search_weight DESC, i.instrument_id
     LIMIT ${SECF_MAX_CANDIDATES}`);
  return res.rows;
}

interface Facets {
  total: number;
  facets: SecfPayload['facets'];
  exchange: Record<string, number>;
}

/** The three `group by` aggregates and the total, over the filtered set before paging (step 4). */
async function facetCounts(
  ctx: ResolveContext,
  predicate: ReturnType<typeof sql>,
): Promise<Facets> {
  const res = await ctx.db.execute<FacetRow>(sql`
    WITH filtered AS (
      SELECT i.instrument_id, i.asset_class::text AS asset_class, i.status,
             coalesce((SELECT x.bbg_exch_code FROM listings l
                         JOIN exchanges x ON x.mic = l.mic
                        WHERE l.instrument_id = i.instrument_id AND l.tx_to = 'infinity'
                        ORDER BY l.is_primary DESC, l.listing_id LIMIT 1), i.exch_code) AS venue
        FROM instruments i
        LEFT JOIN issues iss ON iss.issue_id = i.issue_id AND iss.tx_to = 'infinity'
                            AND iss.valid_to = 'infinity'
        LEFT JOIN issuers isr ON isr.issuer_id = iss.issuer_id AND isr.tx_to = 'infinity'
                             AND isr.valid_to = 'infinity'
       WHERE ${predicate})
    SELECT 'assetClass' AS bucket, asset_class AS key, count(*)::text AS n FROM filtered GROUP BY 1, 2
    UNION ALL
    SELECT 'exchange', venue, count(*)::text FROM filtered GROUP BY 1, 2
    UNION ALL
    SELECT 'status', status, count(*)::text FROM filtered GROUP BY 1, 2
    UNION ALL
    SELECT 'total', '', count(*)::text FROM filtered`);

  const facets: SecfPayload['facets'] = { assetClass: {}, exchange: {}, status: {} };
  let total = 0;
  for (const row of res.rows) {
    const n = Number(row.n);
    if (row.bucket === 'total') total = n;
    else if (row.bucket === 'assetClass') facets.assetClass[row.key] = n;
    else if (row.bucket === 'exchange') facets.exchange[row.key] = n;
    else facets.status[row.key] = n;
  }
  return { total, facets, exchange: facets.exchange };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Ordering and paging
// ─────────────────────────────────────────────────────────────────────────────────────────────

function displayOf(row: CandidateRow): string {
  const spoken = PSEUDO_VENUES.has(row.exch_code) ? '' : `${row.exch_code} `;
  return `${row.ticker} ${spoken}${row.market_sector}`;
}

function sortKey(sort: SecfParams['sort'], row: CandidateRow, score: number): SecfCursor {
  const i = Number(row.instrument_id);
  if (sort === 'ticker') return { t: row.ticker, i };
  if (sort === 'name') return { n: row.name, i };
  return { s: score, i };
}

function compare(sort: SecfParams['sort'], a: Scored, b: Scored): number {
  if (sort === 'ticker') {
    return a.row.ticker < b.row.ticker
      ? -1
      : a.row.ticker > b.row.ticker
        ? 1
        : Number(a.row.instrument_id) - Number(b.row.instrument_id);
  }
  if (sort === 'name') {
    return a.row.name < b.row.name
      ? -1
      : a.row.name > b.row.name
        ? 1
        : Number(a.row.instrument_id) - Number(b.row.instrument_id);
  }
  // `rank()`'s own tie-break: score desc, then the shorter display, then alphabetical, then id.
  return compareCandidates(
    {
      score: a.hit.score,
      primary: a.hit.instrument.display,
      kind: 'instrument',
      id: a.row.instrument_id,
    },
    {
      score: b.hit.score,
      primary: b.hit.instrument.display,
      kind: 'instrument',
      id: b.row.instrument_id,
    },
  );
}

/** True when `key` is strictly after `cursor` in the ordering `sort` defines. */
function after(sort: SecfParams['sort'], key: SecfCursor, cursor: SecfCursor): boolean {
  if (sort === 'rank' && 's' in key && 's' in cursor) {
    return key.s < cursor.s || (key.s === cursor.s && key.i > cursor.i);
  }
  if (sort === 'ticker' && 't' in key && 't' in cursor) {
    return key.t > cursor.t || (key.t === cursor.t && key.i > cursor.i);
  }
  if (sort === 'name' && 'n' in key && 'n' in cursor) {
    return key.n > cursor.n || (key.n === cursor.n && key.i > cursor.i);
  }
  throw cursorError(JSON.stringify(cursor));
}

/**
 * The page, and `ctx.page.set` (step 5).
 *
 * PAGE BACK is the inverted predicate re-reversed: the `pageSize` rows immediately *before* the
 * cursor, in the forward order. Because the ordering is total (every key carries the instrument
 * id) the two directions cannot disagree about where a page starts.
 */
function pageOf(
  scored: readonly Scored[],
  params: SecfParams,
  ctx: ResolveContext,
): { hits: Scored[] } {
  const size = params.pageSize;
  const page = ctx.page;
  const cursor = page?.cursor ?? null;
  const direction = page?.direction ?? 'fwd';

  let start = 0;
  if (cursor !== null) {
    const decoded = decodeCursor(cursor);
    const at = scored.findIndex((s) => after(params.sort, s.key, decoded));
    if (direction === 'fwd') {
      start = at < 0 ? scored.length : at;
    } else {
      // The cursor names the last row of the page the caller is on; the previous page ends just
      // before the row that page started with.
      const end = at < 0 ? scored.length : at;
      start = Math.max(0, end - 2 * size);
    }
  }

  const hits = scored.slice(start, start + size);
  const last = hits[hits.length - 1];
  const count = Math.max(1, Math.ceil(scored.length / size));
  page?.set({
    index: Math.floor(start / size),
    count,
    cursor: last === undefined || start + size >= scored.length ? null : encodeCursor(last.key),
  });
  return { hits };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The Yahoo fallback (step 6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Add up to eight Yahoo rows, or say why there are none.
 *
 * The grant is checked before the provider is touched: a firm with no `yahoo.search` contract must
 * not cause a fetch at all, and the reason the user sees is `NOT_LICENSED`, not "unavailable".
 * Nothing here can add a hit that is not in the stored response, and no row is written to the
 * master — `instrumentId: -1` says so, and `Enter` on such a row goes through `POST /ref/resolve`.
 */
async function fallback(
  ctx: ResolveContext,
  params: SecfParams,
  hits: SecfHit[],
): Promise<SecfPayload['source']> {
  const granted = await hasYahooGrant(ctx);
  if (!granted) {
    ctx.unavailable.add({
      field: 'source',
      reason: 'NOT_LICENSED',
      detail: 'this firm has no yahoo.search grant — master hits only',
    });
    return 'master';
  }

  try {
    const ensured = await ctx.providers.ensure(YAHOO_SEARCH, params.query.trim(), {
      maxAgeMs: YAHOO_MAX_AGE_MS,
    });
    if (ensured.provenanceId === null) {
      ctx.unavailable.add({
        field: 'source',
        reason: 'NO_SOURCE',
        detail: 'Yahoo search unavailable (circuit open) — master hits only',
      });
      return 'master';
    }
    const added = await yahooHits(ctx, params, ensured.provenanceId, ensured.capturedAt);
    if (added.length === 0) {
      ctx.unavailable.add({
        field: 'source',
        reason: 'NO_SOURCE',
        detail: 'the stored Yahoo search response carried no quotes — master hits only',
      });
      return 'master';
    }
    hits.push(...added);
    return 'master+yahoo';
  } catch {
    // §SECF L2247: "the circuit being open is not an error". Nothing is stored and nothing can be
    // fetched, so the payload stays master-only and says so.
    ctx.unavailable.add({
      field: 'source',
      reason: 'NO_SOURCE',
      detail: 'Yahoo search unavailable (circuit open) — master hits only',
    });
    return 'master';
  }
}

/** A live firm grant for `yahoo.search` (or a source-wide grant), as-of the injected clock. */
async function hasYahooGrant(ctx: ResolveContext): Promise<boolean> {
  const now = new Date(ctx.clock.now()).toISOString();
  const res = await ctx.db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM entitlement_grants
     WHERE subject_kind = 'firm' AND subject_id = ${String(ctx.user.firmId)}::bigint
       AND (source_id IS NULL OR source_id = 'yahoo.search')
       AND valid_from <= ${now}::timestamptz AND valid_to > ${now}::timestamptz`);
  return Number(res.rows[0]?.n ?? '0') > 0;
}

interface StoredQuote {
  symbol?: unknown;
  shortname?: unknown;
  longname?: unknown;
  quoteType?: unknown;
  exchDisp?: unknown;
  score?: unknown;
}

/**
 * The recorded response, mapped to hits.
 *
 * **Recorded deviation.** §SECF step 6 says "read the stored response", and this file's first
 * draft read it from `provenance.response_body`. There is no such column: `provenance`
 * (migration `0002`) records the *metadata* of an exchange — key, URL, hashes, status, byte count,
 * instants — and the bytes themselves live in the capture store (`providers/replayStore.ts`,
 * ARCHITECTURE §8.1), keyed by exactly the `request_key` the provenance row carries. So the read
 * is: the row for the id `ensure` returned, then that key's capture. Nothing is fetched here — the
 * capture is the one `ensure` has just guaranteed is fresh, and a miss contributes no hits rather
 * than an invented one.
 *
 * A response that is not the shape Yahoo publishes contributes nothing: there is no default row
 * and no invented symbol.
 */
async function yahooHits(
  ctx: ResolveContext,
  params: SecfParams,
  provenanceId: number,
  capturedAt: Date | null,
): Promise<SecfHit[]> {
  const res = await ctx.db.execute<{ request_key: string }>(sql`
    SELECT request_key FROM provenance WHERE provenance_id = ${String(provenanceId)}::bigint`);
  const requestKey = res.rows[0]?.request_key ?? null;
  if (requestKey === null) return [];

  let body: string;
  try {
    const raw = openReplayStore().lookup(requestKey);
    if (raw === null) return [];
    body = raw.body.toString('utf8');
  } catch {
    // A capture whose file no longer hashes to its manifest entry is a broken fixture, not a
    // reason to fail a search: the payload stays master-only and says so.
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const quotes = (parsed as { quotes?: unknown }).quotes;
  if (!Array.isArray(quotes)) return [];

  const provIdx = ctx.prov.add({
    sourceId: 'yahoo.search',
    provenanceId,
    capturedAt: capturedAt ?? new Date(ctx.clock.now()),
    sourceTs: null,
    st: 'stale',
    tier: 'eod',
  });

  const out: SecfHit[] = [];
  for (const raw of quotes.slice(0, YAHOO_FALLBACK_MAX)) {
    const quote = raw as StoredQuote;
    const symbol = typeof quote.symbol === 'string' ? quote.symbol : null;
    if (symbol === null) continue;
    const name =
      typeof quote.longname === 'string'
        ? quote.longname
        : typeof quote.shortname === 'string'
          ? quote.shortname
          : symbol;
    // Clamped below every master hit: a row that is not in the master may never outrank one.
    const score = typeof quote.score === 'number' ? Math.min(quote.score / 1e6, 0.5) : 0;
    out.push({
      instrument: {
        instrumentId: -1,
        assetClass: yahooAssetClass(quote.quoteType),
        marketSector: 'Equity',
        display: symbol,
        name,
        currency: '',
        mdLineIds: [],
        ticker: symbol,
        exchCode: typeof quote.exchDisp === 'string' ? quote.exchDisp : '',
        securityType: typeof quote.quoteType === 'string' ? quote.quoteType : '',
        compositeFigi: null,
        status: 'pending',
        priceDecimals: 2,
      },
      matchedOn: 'trigram',
      matched: [],
      score,
      identifiers: { figi: null, isin: null, cusip: null },
      memberOf: [],
      listings: 0,
      gicsSector: null,
      provIdx,
    } satisfies SecfHit & { provIdx: number });
  }
  void params;
  return out;
}

function yahooAssetClass(quoteType: unknown): AssetClass {
  switch (typeof quoteType === 'string' ? quoteType.toUpperCase() : '') {
    case 'ETF':
      return 'etf';
    case 'INDEX':
      return 'index';
    case 'CURRENCY':
      return 'fx';
    case 'CRYPTOCURRENCY':
      return 'crypto';
    default:
      return 'equity';
  }
}

const module_: FunctionServerModule<SecfParams, SecfPayload> = { resolve };

export default module_;
