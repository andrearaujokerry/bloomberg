/**
 * `wire/rest/search.ts` — `Rest.Search.*`: autocomplete and the local universe snapshot.
 *
 * Routes and schemas transcribed from API.md §5.2 L438-486 (TERM-02). The client ranks locally
 * with `core/command/rank.ts` over `/universe/snapshot`; the server is consulted only for name
 * queries ≥ 3 characters with no local hit, debounced 60 ms.
 * Owned by WP-01 now, by WP-08 (`server/src/http/routes/search.ts`) afterwards.
 *
 * Routes covered (2):
 *   GET /search
 *   GET /universe/snapshot
 *
 * Route descriptor shape: { method, path, params?, query?, body?, response, status, format? }.
 */
import { z } from 'zod';

import { AssetClass, MarketSector } from '../common.js';

/** A repeated (`?kinds=a&kinds=b`) or comma-separated (`?kinds=a,b`) query list. */
const listQuery = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (v: unknown) => (typeof v === 'string' ? v.split(',').filter((s) => s.length > 0) : v),
    z.array(item),
  );

export const SearchKind = z.enum(['instrument', 'function', 'person', 'topic']);
export type SearchKind = z.infer<typeof SearchKind>;

/**
 * API.md §5.2 L450-455. Numbers are `z.coerce` here because the same schema validates the URL
 * query on the server, where every value arrives as a string; the accepted values are exactly
 * those the design declares.
 */
export const SearchQuery = z.object({
  q: z.string().min(1).max(80),
  limit: z.coerce.number().int().min(1).max(25).default(12),
  kinds: listQuery(SearchKind).optional(),
  /** TERM-03 context boosts */
  panelSecurityId: z.coerce.number().int().optional(),
  panelFunction: z.string().optional(),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

/** = `core/search/types.ts` `Candidate` + the display fields. */
export const SearchHit = z.object({
  kind: SearchKind,
  /** instrumentId | function code | personId | topic code */
  id: z.string(),
  /** 'AAPL US Equity' | 'GP' | 'Jane Doe (Demo Desk)' | 'MARKETS' */
  primary: z.string(),
  /** 'Apple Inc · Common Stock · US' | 'Price graph' */
  secondary: z.string(),
  assetClass: AssetClass.optional(),
  marketSector: MarketSector.optional(),
  score: z.number(),
  matchedOn: z.enum(['code', 'ticker', 'name', 'isin', 'cusip', 'figi', 'alias', 'trigram']),
  /** highlight ranges in `primary` */
  matched: z.array(z.tuple([z.number().int(), z.number().int()])),
  /** what GO executes: 'AAPL US Equity' | 'GP' */
  insertText: z.string(),
  /** Yahoo fallback hits (≤ 8) are never auto-added to the master */
  source: z.enum(['local', 'yahoo']).default('local'),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const SearchResponse = z.object({
  hits: z.array(SearchHit),
  tookMs: z.number(),
  traceId: z.uuid(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

/** The compact tuple form the client indexes locally (gzip + `ETag: "<version>"`). */
export const UniverseSnapshot = z.object({
  /** sha1 of content = ETag */
  version: z.string(),
  generatedAt: z.iso.datetime(),
  instruments: z.array(
    z.tuple([
      z.number().int(), // instrumentId
      z.string(), // ticker
      MarketSector,
      z.string(), // exchCode ('US','GOVT','INDEX','FX','RATE','ECON','CRYPTO')
      z.string(), // name
      AssetClass,
      z.number(), // searchWeight (instruments.search_weight)
      z.number().int(), // status: 1 active, 0 otherwise
    ]),
  ),
  /** code, name, aliases, tier */
  functions: z.array(z.tuple([z.string(), z.string(), z.array(z.string()), z.number().int()])),
  /** personId, name, role/firm */
  people: z.array(z.tuple([z.number().int(), z.string(), z.string()])),
  /** code, name */
  topics: z.array(z.tuple([z.string(), z.string()])),
});
export type UniverseSnapshot = z.infer<typeof UniverseSnapshot>;

/* ------------------------------------------------------------------- routes */

/** The 2 routes of API.md §5.2 (`http/routes/search.ts`, `http/routes/universe.ts`). */
export const Search = {
  /** p95 < 80 ms; ranking is identical to the client's (`core/command/rank.ts`). */
  Query: {
    method: 'GET',
    path: '/search',
    query: SearchQuery,
    response: SearchResponse,
    status: 200,
  },
  /**
   * `If-None-Match` → `304` when unchanged; otherwise gzip with
   * `ETag: "<version>"` and `Cache-Control: private, max-age=3600`.
   * `client/rest.ts` keeps the ETag cache for this route.
   */
  UniverseSnapshot: {
    method: 'GET',
    path: '/universe/snapshot',
    response: UniverseSnapshot,
    status: 200,
  },
} as const;
