/**
 * `wire/rest/portfolios.ts` — `Rest.Portfolios.*`: the 11 portfolio routes of API.md §5.9
 * L670-695 (PORT-01, PORT-02, PORT-07) plus the §9 CSV export L1190.
 * Owned by WP-01 now, by WP-10 (`server/src/http/routes/portfolios.ts`) afterwards.
 *
 * Every table is RLS-isolated by `firm_id` (DATA_MODEL §15); a portfolio of another firm is `404`.
 *
 * Route descriptor shape used by every `wire/rest/*` group (consumed by `client/rest.ts`):
 *   { method, path, params?, query?, body?, response, status, format? }
 */
import { z } from 'zod';

import { InstrumentSummary, SecurityRefInput } from '../common.js';
import { AsOf, Meta } from '../envelope.js';
import { CsvDocument } from './export.js';
import { Payload } from './functions.js';

/* ------------------------------------------------------------------ schemas */

/** API.md §5.9 L675-676, verbatim. */
export const PositionInput = z.object({
  identifier: z.string(),
  quantity: z.number(),
  costPrice: z.number().optional(),
  costCurrency: z.string().length(3).optional(),
  lotId: z.string().default('default'),
  tradeDate: z.iso.date().optional(),
  settleDate: z.iso.date().optional(),
  isCash: z.boolean().default(false),
  cashCurrency: z.string().length(3).optional(),
});
export type PositionInput = z.infer<typeof PositionInput>;

export const ReconStatus = z.enum(['ok', 'unresolved', 'duplicate', 'price_missing']);
export type ReconStatus = z.infer<typeof ReconStatus>;

export const Position = PositionInput.extend({
  positionId: z.number().int(),
  asOfDate: z.iso.date(),
  instrument: InstrumentSummary.nullable(),
  accrued: z.number(),
  reconStatus: ReconStatus,
  importId: z.number().int().nullable(),
});
export type Position = z.infer<typeof Position>;

export const ImportChannel = z.enum(['upload', 'file_drop', 'api', 'manual']);
export type ImportChannel = z.infer<typeof ImportChannel>;

/** PORT-01 reconciliation report. API.md §5.9 L679-683, verbatim. */
export const ImportReport = z.object({
  importId: z.number().int(),
  channel: ImportChannel,
  asOfDate: z.iso.date(),
  status: z.enum(['accepted', 'partial', 'rejected']),
  rowsTotal: z.number().int(),
  rowsOk: z.number().int(),
  rowsError: z.number().int(),
  errors: z.array(
    z.object({
      row: z.number().int(),
      identifier: z.string(),
      column: z.string(),
      reason: z.string(),
    }),
  ),
  reconciliation: z.object({
    matched: z.number().int(),
    added: z.number().int(),
    removed: z.number().int(),
    quantityDiffs: z.array(
      z.object({
        instrumentId: z.number().int(),
        before: z.number(),
        after: z.number(),
      }),
    ),
  }),
});
export type ImportReport = z.infer<typeof ImportReport>;

/** A `portfolios` row as the API returns it (API.md §5.9 L688 `201` body). */
export const Portfolio = z.object({
  portfolioId: z.number().int(),
  name: z.string(),
  baseCurrency: z.string().length(3),
  benchmark: InstrumentSummary.nullable(),
});
export type Portfolio = z.infer<typeof Portfolio>;

/** One open or closed tax lot (API.md §5.9 L694). */
export const Lot = z.object({
  lotId: z.string(),
  instrument: InstrumentSummary.nullable(),
  openDate: z.iso.date(),
  quantity: z.number(),
  unitCost: z.number(),
  currency: z.string().length(3),
  closedDate: z.iso.date().nullable(),
  externalRef: z.string().nullable(),
});
export type Lot = z.infer<typeof Lot>;

export const ScenarioShock = z.object({
  /** a security, or a named risk factor such as `USD`, `SOFR`, `SPX` */
  target: z.union([SecurityRefInput, z.object({ factor: z.string().min(1).max(60) })]),
  kind: z.enum(['price', 'vol', 'rate', 'fx', 'spread']),
  unit: z.enum(['pct', 'bp', 'abs']),
  value: z.number(),
});
export type ScenarioShock = z.infer<typeof ScenarioShock>;

/**
 * A stress scenario for `POST /portfolios/:portfolioId/analytics`.
 *
 * DESIGN GAP: API.md §5.9 L695 references `ScenarioSpec[]` but never declares the schema. This
 * shape is derived from ARCHITECTURE `portfolio/risk.ts` ("scenario shocks", PORT-04/05/06);
 * if the PORT resolver disagrees, this declaration is the one to change.
 */
export const ScenarioSpec = z.object({
  name: z.string().min(1).max(80),
  shocks: z.array(ScenarioShock).min(1),
});
export type ScenarioSpec = z.infer<typeof ScenarioSpec>;

export const PortfolioParams = z.object({ portfolioId: z.number().int().positive() });
export type PortfolioParams = z.infer<typeof PortfolioParams>;

export const PortfolioListResponse = z.object({ items: z.array(Portfolio) });
export type PortfolioListResponse = z.infer<typeof PortfolioListResponse>;

export const CreatePortfolioRequest = z.object({
  name: z.string().min(1).max(120),
  baseCurrency: z.string().length(3).optional(),
  benchmark: SecurityRefInput.optional(),
});
export type CreatePortfolioRequest = z.infer<typeof CreatePortfolioRequest>;

export const PositionListQuery = z.object({ asOfDate: z.iso.date().optional() });
export type PositionListQuery = z.infer<typeof PositionListQuery>;

export const PositionListResponse = z.object({
  meta: Meta,
  asOfDate: z.iso.date(),
  positions: z.array(Position),
});
export type PositionListResponse = z.infer<typeof PositionListResponse>;

/** API channel: a full replace for that date. */
export const ReplacePositionsRequest = z.object({
  asOfDate: z.iso.date(),
  positions: z.array(PositionInput),
});
export type ReplacePositionsRequest = z.infer<typeof ReplacePositionsRequest>;

/**
 * The non-file fields of the `multipart/form-data` import body; the `file` part is a CSV with
 * the header `identifier,quantity,cost_price,cost_currency,lot_id,trade_date` and is streamed,
 * not validated as a JSON value.
 */
export const ImportPositionsRequest = z.object({ asOfDate: z.iso.date() });
export type ImportPositionsRequest = z.infer<typeof ImportPositionsRequest>;

/** The CSV column order `POST /portfolios/:portfolioId/import` accepts. */
export const IMPORT_CSV_COLUMNS = [
  'identifier',
  'quantity',
  'cost_price',
  'cost_currency',
  'lot_id',
  'trade_date',
] as const;

export const ImportListQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50),
});
export type ImportListQuery = z.infer<typeof ImportListQuery>;

export const ImportListResponse = z.object({ items: z.array(ImportReport) });
export type ImportListResponse = z.infer<typeof ImportListResponse>;

export const LotListQuery = z.object({
  /** true → only lots with `closedDate === null` */
  open: z.boolean().optional(),
});
export type LotListQuery = z.infer<typeof LotListQuery>;

export const LotListResponse = z.object({ items: z.array(Lot) });
export type LotListResponse = z.infer<typeof LotListResponse>;

export const PortfolioAnalyticsRequest = z.object({
  asOf: AsOf.optional(),
  benchmark: SecurityRefInput.optional(),
  scenarios: z.array(ScenarioSpec).optional(),
});
export type PortfolioAnalyticsRequest = z.infer<typeof PortfolioAnalyticsRequest>;

export const PortfolioCsvQuery = z.object({ asOfDate: z.iso.date().optional() });
export type PortfolioCsvQuery = z.infer<typeof PortfolioCsvQuery>;

/* ------------------------------------------------------------------- routes */

/** The 11 routes of API.md §5.9 plus the §9 CSV export (`http/routes/portfolios.ts`). */
export const Portfolios = {
  List: {
    method: 'GET',
    path: '/portfolios',
    response: PortfolioListResponse,
    status: 200,
  },
  Create: {
    method: 'POST',
    path: '/portfolios',
    body: CreatePortfolioRequest,
    response: Portfolio,
    status: 201,
  },
  /** Owner or firm admin. */
  Get: {
    method: 'GET',
    path: '/portfolios/:portfolioId',
    params: PortfolioParams,
    response: Portfolio,
    status: 200,
  },
  /** Owner or firm admin; same body as `Create`. */
  Update: {
    method: 'PUT',
    path: '/portfolios/:portfolioId',
    params: PortfolioParams,
    body: CreatePortfolioRequest,
    response: Portfolio,
    status: 200,
  },
  /** Owner or firm admin. */
  Delete: {
    method: 'DELETE',
    path: '/portfolios/:portfolioId',
    params: PortfolioParams,
    response: z.void(),
    status: 204,
  },
  Positions: {
    method: 'GET',
    path: '/portfolios/:portfolioId/positions',
    params: PortfolioParams,
    query: PositionListQuery,
    response: PositionListResponse,
    status: 200,
  },
  /** API channel, full replace for that date (PORT-01 reconciliation runs either way). */
  PutPositions: {
    method: 'PUT',
    path: '/portfolios/:portfolioId/positions',
    params: PortfolioParams,
    body: ReplacePositionsRequest,
    response: ImportReport,
    status: 200,
  },
  /** `multipart/form-data`: the `file` CSV part plus `asOfDate` (PORT-01). */
  Import: {
    method: 'POST',
    path: '/portfolios/:portfolioId/import',
    params: PortfolioParams,
    body: ImportPositionsRequest,
    response: ImportReport,
    status: 200,
  },
  Imports: {
    method: 'GET',
    path: '/portfolios/:portfolioId/imports',
    params: PortfolioParams,
    query: ImportListQuery,
    response: ImportListResponse,
    status: 200,
  },
  Lots: {
    method: 'GET',
    path: '/portfolios/:portfolioId/lots',
    params: PortfolioParams,
    query: LotListQuery,
    response: LotListResponse,
    status: 200,
  },
  /** The same resolver as function `PORT` — a single implementation. */
  Analytics: {
    method: 'POST',
    path: '/portfolios/:portfolioId/analytics',
    params: PortfolioParams,
    body: PortfolioAnalyticsRequest,
    response: Payload,
    status: 200,
  },
  /** API.md §9 L1190: positions with the PORT analytics columns (firm only). */
  Csv: {
    method: 'GET',
    path: '/portfolios/:portfolioId/export.csv',
    params: PortfolioParams,
    query: PortfolioCsvQuery,
    response: CsvDocument,
    status: 200,
    format: 'csv',
  },
} as const;
