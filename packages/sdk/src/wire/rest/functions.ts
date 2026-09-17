/**
 * `wire/rest/functions.ts` — `Rest.Functions.*`: the function registry, run and paging routes.
 *
 * Routes and schemas transcribed from API.md §5.3 L489-527; the CSV export route is API.md §9
 * L1187 (its request/response schemas live in `rest/export.ts`, which owns the CSV contract).
 * Owned by WP-01 now, by WP-08 (`server/src/http/routes/functions.ts`) afterwards.
 *
 * Routes covered (7):
 *   GET  /functions
 *   GET  /functions/:code
 *   GET  /functions/:code/help
 *   POST /functions/:code/run
 *   POST /functions/:code/page
 *   GET  /results/:resultId
 *   GET  /functions/:code/csv                (API.md §9)
 *
 * Route descriptor shape: { method, path, params?, query?, body?, response, status, format? }.
 */
import { z } from 'zod';

import { AssetClass, FieldId, SecurityRefInput } from '../common.js';
import { AsOf, PayloadMeta } from '../envelope.js';
import { CsvDocument, FunctionCsvParams, FunctionCsvQuery } from './export.js';

/* ------------------------------------------------------------------ schemas */

export const FunctionCategory = z.enum([
  'reference',
  'pricing',
  'charting',
  'news',
  'fundamentals',
  'screening',
  'rates',
  'derivatives',
  'portfolio',
  'messaging',
  'monitor',
  'system',
]);
export type FunctionCategory = z.infer<typeof FunctionCategory>;

export const FunctionTier = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type FunctionTier = z.infer<typeof FunctionTier>;

export const CsvColumn = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(['string', 'number', 'date', 'datetime', 'boolean']),
  decimals: z.number().int().optional(),
});
export type CsvColumn = z.infer<typeof CsvColumn>;

export const HelpParam = z.object({
  name: z.string(),
  text: z.string(),
  example: z.string().optional(),
});
export type HelpParam = z.infer<typeof HelpParam>;

export const HelpKey = z.object({ key: z.string(), action: z.string() });
export type HelpKey = z.infer<typeof HelpKey>;

export const KeyBinding = z.object({
  key: z.string(),
  action: z.string(),
  when: z.enum(['grid', 'chart', 'form', 'always']).optional(),
  description: z.string(),
});
export type KeyBinding = z.infer<typeof KeyBinding>;

/** `FunctionManifest` minus code (ARCHITECTURE §5.2) — what the server publishes. */
export const FunctionManifestPublic = z.object({
  code: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  tier: FunctionTier,
  category: FunctionCategory,
  assetClasses: z.union([z.array(AssetClass), z.literal('any'), z.literal('none')]),
  requiresSecurity: z.boolean(),
  pageable: z.boolean(),
  screenKind: z.enum(['declarative', 'custom']),
  /** `z.toJSONSchema(manifest.params)` */
  paramsSchema: z.record(z.string(), z.unknown()),
  /** `ParamGrammar` */
  paramGrammar: z.record(z.string(), z.unknown()),
  /** per asset class ('*' for none) */
  fieldIds: z.record(z.string(), z.array(FieldId)),
  /** null when the columns depend on the payload */
  csvColumns: z.array(CsvColumn).nullable(),
  help: z.object({
    summary: z.string(),
    description: z.string(),
    params: z.array(HelpParam),
    keys: z.array(HelpKey),
    sources: z.array(z.string()),
    related: z.array(z.string()),
  }),
  keymap: z.array(KeyBinding),
});
export type FunctionManifestPublic = z.infer<typeof FunctionManifestPublic>;

export const FunctionListResponse = z.object({
  registryVersion: z.string(),
  functions: z.array(FunctionManifestPublic),
});
export type FunctionListResponse = z.infer<typeof FunctionListResponse>;

export const FunctionRunRequest = z.object({
  /** required when `manifest.requiresSecurity` → else `422 NO_SECURITY_CONTEXT` */
  security: SecurityRefInput.optional(),
  /** validated by `manifest.params` → `400 VALIDATION_FAILED` with `details.location='fnParams'` */
  params: z.record(z.string(), z.unknown()).default({}),
  asOf: AsOf.optional(),
  /** 'p1'..'p4' for `usage_events.panel_id` */
  panelId: z.string().max(16).optional(),
  /** → `usage_events.kind` fn.launch | fn.param (FUNC-04) */
  launchKind: z.enum(['launch', 'param', 'refresh']).default('launch'),
});
export type FunctionRunRequest = z.infer<typeof FunctionRunRequest>;

/**
 * The function payload envelope. `data` is the screen payload of FUNCTIONS.md `<CODE>`;
 * `data.variant` discriminates the screen (FUNC-02). The manifest's `PayloadOf<C>` types it
 * on the SDK side; on the wire it is opaque.
 */
export const Payload = z.object({ data: z.unknown(), meta: PayloadMeta });
export type Payload = z.infer<typeof Payload>;

export const FunctionPageRequest = z.object({
  resultId: z.string(),
  direction: z.enum(['fwd', 'back']),
});
export type FunctionPageRequest = z.infer<typeof FunctionPageRequest>;

export const HelpResponse = z.object({
  code: z.string(),
  name: z.string(),
  summary: z.string(),
  description: z.string(),
  params: z.array(HelpParam),
  keys: z.array(HelpKey),
  /** the fields the screen shows, from the dictionary (API-07) */
  fields: z.array(
    z.object({
      id: FieldId,
      label: z.string(),
      definition: z.string(),
      sourceId: z.string(),
      attribution: z.string(),
    }),
  ),
  sources: z.array(z.string()),
  related: z.array(z.string()),
});
export type HelpResponse = z.infer<typeof HelpResponse>;

/** Aliases resolve here: `IB` → `MSG` (API.md §5.3 L494). */
export const FunctionCodeParams = z.object({ code: z.string().min(1).max(20) });
export const HelpQuery = z.object({ assetClass: AssetClass.optional() });
export const ResultParams = z.object({ resultId: z.string().min(1).max(64) });

/* ------------------------------------------------------------------- routes */

/** The 6 routes of API.md §5.3 plus the §9 CSV export (`http/routes/functions.ts`). */
export const Functions = {
  /** ETag-cached registry listing. */
  List: {
    method: 'GET',
    path: '/functions',
    response: FunctionListResponse,
    status: 200,
  },
  Get: {
    method: 'GET',
    path: '/functions/:code',
    params: FunctionCodeParams,
    response: FunctionManifestPublic,
    status: 200,
  },
  /** HELP ×1 content (TERM-09). */
  Help: {
    method: 'GET',
    path: '/functions/:code/help',
    params: FunctionCodeParams,
    query: HelpQuery,
    response: HelpResponse,
    status: 200,
  },
  /** `422 FUNCTION_NOT_APPLICABLE` / `NO_SECURITY_CONTEXT`; one `usage_events` row per run. */
  Run: {
    method: 'POST',
    path: '/functions/:code/run',
    params: FunctionCodeParams,
    body: FunctionRunRequest,
    response: Payload,
    status: 200,
  },
  /** Returns a payload with a new `resultId`. */
  Page: {
    method: 'POST',
    path: '/functions/:code/page',
    params: FunctionCodeParams,
    body: FunctionPageRequest,
    response: Payload,
    status: 200,
  },
  /**
   * The cached result (10 min TTL); when the viewer is not the producer the server re-runs at
   * the cached `meta.asOf` under the viewer's entitlements (MSG-04 share links).
   */
  Result: {
    method: 'GET',
    path: '/results/:resultId',
    params: ResultParams,
    response: Payload,
    status: 200,
  },
  /** FUNC-03 export: `200 text/csv; charset=utf-8` (API.md §9 L1187). */
  Csv: {
    method: 'GET',
    path: '/functions/:code/csv',
    params: FunctionCsvParams,
    query: FunctionCsvQuery,
    response: CsvDocument,
    status: 200,
    format: 'csv',
  },
} as const;
