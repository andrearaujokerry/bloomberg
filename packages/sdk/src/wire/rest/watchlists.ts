/**
 * `wire/rest/watchlists.ts` — `Rest.Watchlists.*`: the 6 watchlist routes of API.md §5.8
 * L643-668 (W, CHRT-07) plus the §9 CSV export L1189.
 * Owned by WP-01 now, by WP-09 (`server/src/http/routes/watchlists.ts`) afterwards.
 *
 * Watchlist members of connected users join the plant hot set (ARCHITECTURE §6.2).
 *
 * Route descriptor shape used by every `wire/rest/*` group (consumed by `client/rest.ts`):
 *   { method, path, params?, query?, body?, response, status, format? }
 */
import { z } from 'zod';

import { FieldId, InstrumentSummary, SecurityRefInput } from '../common.js';
import { CsvDocument } from './export.js';

/* ------------------------------------------------------------------ schemas */

/** A dictionary field, or a computed column evaluated by `core/formula` over the row's fields. */
export const WatchlistColumn = z.union([
  z.object({
    id: FieldId,
    label: z.string().optional(),
    decimals: z.number().int().optional(),
  }),
  z.object({
    id: z.string().regex(/^c[0-9]+$/),
    formula: z.string().max(400),
    label: z.string(),
    decimals: z.number().int().optional(),
  }),
]);
export type WatchlistColumn = z.infer<typeof WatchlistColumn>;

export const WatchlistItemInput = z.union([
  z.object({
    security: SecurityRefInput,
    label: z.string().optional(),
    note: z.string().max(500).optional(),
  }),
  z.object({
    formula: z.string().max(400),
    label: z.string(),
    note: z.string().max(500).optional(),
  }),
]);
export type WatchlistItemInput = z.infer<typeof WatchlistItemInput>;

export const WatchlistSort = z.object({
  col: z.string(),
  dir: z.enum(['asc', 'desc']),
});
export type WatchlistSort = z.infer<typeof WatchlistSort>;

export const WatchlistSharedScope = z.enum(['private', 'firm', 'users']);
export type WatchlistSharedScope = z.infer<typeof WatchlistSharedScope>;

export const WatchlistItem = z.object({
  position: z.number().int(),
  instrument: InstrumentSummary.nullable(),
  formula: z.string().nullable(),
  label: z.string().nullable(),
  note: z.string().nullable(),
  addedAt: z.iso.datetime(),
});
export type WatchlistItem = z.infer<typeof WatchlistItem>;

/** API.md §5.8 L654-657, verbatim. */
export const Watchlist = z.object({
  watchlistId: z.number().int(),
  ownerUserId: z.number().int(),
  name: z.string(),
  columns: z.array(WatchlistColumn),
  sort: z.array(WatchlistSort),
  groupBy: z.string().nullable(),
  sharedScope: WatchlistSharedScope,
  sharedUserIds: z.array(z.number().int()),
  updatedAt: z.iso.datetime(),
  /** omitted by the list route; present on every single-watchlist response */
  items: z.array(WatchlistItem).optional(),
});
export type Watchlist = z.infer<typeof Watchlist>;

export const WatchlistParams = z.object({ watchlistId: z.number().int().positive() });
export type WatchlistParams = z.infer<typeof WatchlistParams>;

/** Own + shared; `items` is omitted on every row. */
export const WatchlistListResponse = z.object({ items: z.array(Watchlist) });
export type WatchlistListResponse = z.infer<typeof WatchlistListResponse>;

export const CreateWatchlistRequest = z.object({
  name: z.string().min(1).max(120),
  columns: z.array(WatchlistColumn),
  sort: z.array(WatchlistSort).optional(),
  groupBy: z.string().nullable().optional(),
  sharedScope: WatchlistSharedScope.optional(),
  sharedUserIds: z.array(z.number().int()).optional(),
  items: z.array(WatchlistItemInput).max(2000).optional(),
});
export type CreateWatchlistRequest = z.infer<typeof CreateWatchlistRequest>;

/** "PUT same as POST minus items" (API.md §5.8 L664). */
export const UpdateWatchlistRequest = CreateWatchlistRequest.omit({ items: true });
export type UpdateWatchlistRequest = z.infer<typeof UpdateWatchlistRequest>;

/** Full replace, at most 2 000 rows. */
export const ReplaceWatchlistItemsRequest = z.object({
  items: z.array(WatchlistItemInput).max(2000),
});
export type ReplaceWatchlistItemsRequest = z.infer<typeof ReplaceWatchlistItemsRequest>;

/* ------------------------------------------------------------------- routes */

/** The 5 routes of API.md §5.8 plus the §9 CSV export (`http/routes/watchlists.ts`). */
export const Watchlists = {
  /** Own + shared; `items` omitted. */
  List: {
    method: 'GET',
    path: '/watchlists',
    response: WatchlistListResponse,
    status: 200,
  },
  Create: {
    method: 'POST',
    path: '/watchlists',
    body: CreateWatchlistRequest,
    response: Watchlist,
    status: 201,
  },
  /** Any reader of the list (own, firm-shared or explicitly shared); with `items`. */
  Get: {
    method: 'GET',
    path: '/watchlists/:watchlistId',
    params: WatchlistParams,
    response: Watchlist,
    status: 200,
  },
  /** Owner only. */
  Update: {
    method: 'PUT',
    path: '/watchlists/:watchlistId',
    params: WatchlistParams,
    body: UpdateWatchlistRequest,
    response: Watchlist,
    status: 200,
  },
  /** Owner only. */
  Delete: {
    method: 'DELETE',
    path: '/watchlists/:watchlistId',
    params: WatchlistParams,
    response: z.void(),
    status: 204,
  },
  /** Owner only; full replace of the membership. */
  ReplaceItems: {
    method: 'PUT',
    path: '/watchlists/:watchlistId/items',
    params: WatchlistParams,
    body: ReplaceWatchlistItemsRequest,
    response: Watchlist,
    status: 200,
  },
  /**
   * API.md §9 L1189: the W grid with the same field values the screen shows (resolved via
   * `kind:'realtime'`); computed columns evaluated by `core/formula`.
   */
  Csv: {
    method: 'GET',
    path: '/watchlists/:watchlistId/export.csv',
    params: WatchlistParams,
    response: CsvDocument,
    status: 200,
    format: 'csv',
  },
} as const;
