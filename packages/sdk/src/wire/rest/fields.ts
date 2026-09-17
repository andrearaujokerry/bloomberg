/**
 * `wire/rest/fields.ts` — `Rest.Fields.*`: the field dictionary routes (API-07).
 *
 * Routes transcribed from API.md §5.5 L559-565; `FieldDef`, `FieldDictionary` and
 * `LicenceSummary` are the zod mirror of API.md §7 L1080-1103 (the TypeScript source of truth
 * is `packages/core/src/fields/dictionary.ts`, serialised to `sdk/src/fields/fields.json`).
 * Owned by WP-01 now, by WP-08 (`server/src/http/routes/fields.ts`) afterwards.
 *
 * Routes covered (3):
 *   GET /fields
 *   GET /fields/:id
 *   GET /fields/changelog
 *
 * Route descriptor shape: { method, path, params?, query?, body?, response, status, format? }.
 */
import { z } from 'zod';

import { AssetClass, FieldClass, FieldId, Tier } from '../common.js';

/* ------------------------------------------------------------------ schemas */

export const FieldType = z.enum([
  'number',
  'integer',
  'string',
  'boolean',
  'date',
  'datetime',
  'enum',
]);
export type FieldType = z.infer<typeof FieldType>;

export const FieldUnit = z
  .enum([
    'price',
    'pct',
    'bp',
    'shares',
    'contracts',
    'ccy',
    'ratio',
    'years',
    'days',
    'count',
    'bn',
    'text',
    'date',
    'datetime',
    'enum',
  ])
  .nullable();
export type FieldUnit = z.infer<typeof FieldUnit>;

export const UpdateFreq = z.enum([
  'tick',
  '10s',
  '1m',
  'daily',
  'weekly',
  'twice_monthly',
  'monthly',
  'quarterly',
  'annual',
  'on_filing',
  'static',
]);
export type UpdateFreq = z.infer<typeof UpdateFreq>;

/** `= field_licence` rows + the raw provider path (e.g. `cboe.quotes → data.current_price`). */
export const FieldSource = z.object({
  assetClass: z.union([AssetClass, z.literal('*')]),
  sourceId: z.string(),
  endpoint: z.string(),
  providerPath: z.string(),
});
export type FieldSource = z.infer<typeof FieldSource>;

export const FieldDeprecation = z.object({
  since: z.string(),
  replacement: FieldId.nullable(),
  removeAfter: z.string(),
});
export type FieldDeprecation = z.infer<typeof FieldDeprecation>;

/** API.md §7 L1082-1099 — one dictionary entry (API-07). */
export const FieldDef = z.object({
  /** 'PX_LAST'; stable, never reused */
  id: FieldId,
  /** 'Last price' (column header) */
  label: z.string(),
  /** one unambiguous paragraph */
  definition: z.string(),
  type: FieldType,
  unit: FieldUnit,
  /** null = instrument `price_decimals` (prices) or the unit default */
  decimals: z.number().int().nullable(),
  enumValues: z.array(z.string()).optional(),
  /** = `field_licence.field_class` (the entitlement dimension) */
  fieldClass: FieldClass,
  /** where the field is meaningful; [] for subject-only fields (n:, c:, e:, sys:) */
  assetClasses: z.array(AssetClass),
  sources: z.array(FieldSource),
  updateFreq: UpdateFreq,
  /** true = the value depends on `knownAt` (fundamentals, econ vintages, terms) */
  pit: z.boolean(),
  /** for fieldClass 'derived'/'analytic': the formula or engine name (ANAL-08) */
  derivation: z.string().optional(),
  /** worked example from a recorded fixture */
  example: z.object({
    ref: z.string(),
    value: z.union([z.number(), z.string(), z.boolean()]),
    asOf: z.string(),
  }),
  /** dictionary version that introduced it */
  since: z.string(),
  deprecated: FieldDeprecation.optional(),
});
export type FieldDef = z.infer<typeof FieldDef>;

export const FieldDictionary = z.object({
  /** '2026.09.1' */
  version: z.string(),
  generatedAt: z.iso.datetime(),
  fields: z.array(FieldDef),
});
export type FieldDictionary = z.infer<typeof FieldDictionary>;

/** The governing `licence_registry` row (API.md §7 L1101-1102). */
export const LicenceSummary = z.object({
  sourceId: z.string(),
  sourceName: z.string(),
  publisher: z.string(),
  licenceKind: z.string(),
  attribution: z.string(),
  display: z.boolean(),
  exportAllowed: z.boolean(),
  apiAllowed: z.boolean(),
  redistribution: z.boolean(),
  maxTier: Tier,
  intrinsicDelayMin: z.number().int(),
  retentionDays: z.number().int().nullable(),
  termsUrl: z.string().nullable(),
});
export type LicenceSummary = z.infer<typeof LicenceSummary>;

/** `FieldDef & { licence: LicenceSummary }` — the per-asset-class governing licence. */
export const FieldDetail = FieldDef.extend({ licence: LicenceSummary });
export type FieldDetail = z.infer<typeof FieldDetail>;

export const FieldsQuery = z.object({
  fieldClass: FieldClass.optional(),
  assetClass: AssetClass.optional(),
  /** substring on id/label */
  q: z.string().min(1).max(80).optional(),
  /** dictionary version; the current one when omitted */
  version: z.string().optional(),
});
export type FieldsQuery = z.infer<typeof FieldsQuery>;

export const ChangelogEntry = z.object({
  version: z.string(),
  date: z.iso.date(),
  added: z.array(FieldId),
  deprecated: z.array(
    z.object({ id: FieldId, replacement: FieldId.nullable(), removeAfter: z.string() }),
  ),
  removed: z.array(FieldId),
  changed: z.array(z.object({ id: FieldId, what: z.string() })),
});
export type ChangelogEntry = z.infer<typeof ChangelogEntry>;

export const ChangelogResponse = z.object({ versions: z.array(ChangelogEntry) });
export type ChangelogResponse = z.infer<typeof ChangelogResponse>;

/* ------------------------------------------------------------------- routes */

/** The 3 routes of API.md §5.5 (`http/routes/fields.ts`). */
export const Fields = {
  /** `ETag`-cached; *public* when `PUBLIC_FIELDS=1`. */
  Dictionary: {
    method: 'GET',
    path: '/fields',
    query: FieldsQuery,
    response: FieldDictionary,
    status: 200,
  },
  /** One field plus the governing licence row (attribution, usage flags, `maxTier`). */
  Get: {
    method: 'GET',
    path: '/fields/:id',
    params: z.object({ id: FieldId }),
    response: FieldDetail,
    status: 200,
  },
  /** API-03 deprecation window: every dictionary change since `since`. */
  Changelog: {
    method: 'GET',
    path: '/fields/changelog',
    query: z.object({ since: z.string().optional() }),
    response: ChangelogResponse,
    status: 200,
  },
} as const;
