/**
 * `wire/rest/export.ts` — `Rest.Export.*`: the shared CSV contract of API.md §9 L1179-1217
 * (FUNC-03, API-05, ENTL-01), plus the request/response schemas of the two §9 endpoints whose
 * route descriptors live in another group file.
 *
 * Route ownership of the five §9 endpoints:
 *   `GET  /functions/:code/csv`              → descriptor in `rest/functions.ts` (`Functions.Csv`)
 *   `POST /data/csv`                         → descriptor in `rest/data.ts`
 *   `GET  /watchlists/:watchlistId/export.csv` → `rest/watchlists.ts` (`Watchlists.Csv`)
 *   `GET  /portfolios/:portfolioId/export.csv` → `rest/portfolios.ts` (`Portfolios.Csv`)
 *   `GET  /admin/access-log/export.csv` and `GET /admin/declarations?format=csv`
 *                                            → `rest/admin.ts` (`Admin.AccessLogCsv`,
 *                                              `Admin.DeclarationsCsv`)
 *
 * This file therefore declares no route table of its own: it is the one home for the CSV
 * document type and the two cross-group request schemas, so no group re-declares them.
 *
 * Export runs the same resolver and the same `core/functions/csv.ts#toCsv` as the screen, so
 * CSV = screen by construction (ARCHITECTURE §15 "Export equality"). Entitlement re-runs with
 * `usage:'export'`, `purpose:'export:<CODE>'`; **any denied field fails the whole export** with
 * `403 ENTITLEMENT_DENIED` and `details.reasons[]` — a subset is never silently exported.
 */
import { z } from 'zod';

import { DataRequest } from '../dataRequest.js';

/* ------------------------------------------------------------------ schemas */

/**
 * `text/csv; charset=utf-8` body — `CsvDocument` in ARCHITECTURE §5.2: UTF-8, RFC 4180 quoting,
 * `\r\n` line ends, no BOM, leading `#` attribution lines, numbers unformatted at full stored
 * precision (≤ 15 significant digits), dates ISO, booleans `true`/`false`, blanks empty.
 */
export const CsvDocument = z.string();
export type CsvDocument = z.infer<typeof CsvDocument>;

/** Response headers every CSV export sets (API.md §9 L1214-1217). */
export const CsvResponseHeaders = z.object({
  'x-trace-id': z.uuid(),
  'x-as-of-valid': z.iso.datetime(),
  'x-as-of-known': z.iso.datetime(),
  /** comma-separated provenance ids */
  'x-provenance': z.string(),
  'x-engine-version': z.string(),
  'x-regenerated': z.enum(['true', 'false']),
  /** `attachment; filename="HP_AAPL_US_Equity_20260915T184128Z.csv"` (`manifest.csv.filename`) */
  'content-disposition': z.string(),
});
export type CsvResponseHeaders = z.infer<typeof CsvResponseHeaders>;

/* --------------------------------------------- GET /functions/:code/csv */

export const FunctionCsvParams = z.object({ code: z.string().min(1).max(20) });
export type FunctionCsvParams = z.infer<typeof FunctionCsvParams>;

/**
 * Either `resultId` (preferred: the payload's `meta.resultId`) or a re-resolve tuple
 * (`params` as base64url JSON, optional `security`, `validAt`, `knownAt`) for when the cached
 * result has expired — the re-resolve goes through the same resolver at that `asOf`.
 */
export const FunctionCsvQuery = z.object({
  resultId: z.string().min(1).max(64).optional(),
  /** base64url-encoded JSON of the function params */
  params: z.string().optional(),
  /** the command-line security ref, e.g. `AAPL US Equity` */
  security: z.string().min(1).max(120).optional(),
  validAt: z.iso.datetime().optional(),
  knownAt: z.iso.datetime().optional(),
});
export type FunctionCsvQuery = z.infer<typeof FunctionCsvQuery>;

/* --------------------------------------------------- POST /data/csv */

/**
 * Any `DataRequest` kind except `realtime` with more than 500 securities (that cap depends on
 * the resolved security list, so the route enforces it rather than the schema). The schema is
 * re-exported rather than re-declared so the CSV path and the JSON path cannot drift.
 */
export const DataCsvRequest = DataRequest;
export type DataCsvRequest = z.infer<typeof DataCsvRequest>;
