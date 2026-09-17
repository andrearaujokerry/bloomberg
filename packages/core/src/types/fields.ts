/**
 * Field dictionary shapes (API-03, API-05, API-07) — API.md §7.
 *
 * The dictionary itself lives in `core/src/fields/dictionary.ts`; these are the types it is built
 * from, mirrored as zod in `sdk/wire/rest/fields.ts`.
 */

import type { AssetClass } from './instrument.js';

/**
 * A dictionary field id such as 'PX_LAST'. Stable, never reused; a semantic change is a new id
 * (API-03). Wire shape is `^[A-Z][A-Z0-9_]{1,39}$` (validated by the zod mirror, not by the type).
 */
export type FieldId = string;

/** The entitlement dimension; equals `field_licence.field_class` (ARCHITECTURE §12.1). */
export type FieldClass =
  'price' | 'reference' | 'fundamental' | 'econ' | 'news' | 'analytic' | 'derived' | 'portfolio';

/** null = blank / denied / unknown; the reason travels beside it as a `ReasonCode` (ENTL-05). */
export type FieldValue = number | string | boolean | null;

export type FieldType = 'number' | 'integer' | 'string' | 'boolean' | 'date' | 'datetime' | 'enum';

export type FieldUnit =
  | 'price'
  | 'pct'
  | 'bp'
  | 'shares'
  | 'contracts'
  | 'ccy'
  | 'ratio'
  | 'years'
  | 'days'
  | 'count'
  | 'bn'
  | 'text'
  | 'date'
  | 'datetime'
  | 'enum';

export type FieldUpdateFreq =
  | 'tick'
  | '10s'
  | '1m'
  | 'daily'
  | 'weekly'
  | 'twice_monthly'
  | 'monthly'
  | 'quarterly'
  | 'annual'
  | 'on_filing'
  | 'static';

/** One `field_licence` row plus the raw provider path (e.g. cboe.quotes → `data.current_price`). */
export interface FieldSource {
  assetClass: AssetClass | '*';
  sourceId: string;
  endpoint: string;
  providerPath: string;
}

/** API-03 deprecation record: kept for two dictionary minor versions and six months before removal. */
export interface FieldDeprecation {
  since: string;
  replacement: FieldId | null;
  removeAfter: string;
}

/** A worked example taken from a recorded fixture. */
export interface FieldExample {
  /** 'AAPL US Equity' */
  ref: string;
  value: number | string | boolean;
  asOf: string;
}

export interface FieldDef {
  /** 'PX_LAST'; stable, never reused */
  id: FieldId;
  /** 'Last price' (column header) */
  label: string;
  /** one unambiguous paragraph */
  definition: string;
  type: FieldType;
  unit: FieldUnit | null;
  /** null = instrument price_decimals (prices) or unit default */
  decimals: number | null;
  enumValues?: readonly string[];
  /** = field_licence.field_class (entitlement dimension) */
  fieldClass: FieldClass;
  /** where the field is meaningful; [] for subject-only fields (n:, c:, e:, sys:) */
  assetClasses: readonly AssetClass[];
  sources: readonly FieldSource[];
  updateFreq: FieldUpdateFreq;
  /** true = value depends on knownAt (fundamentals, econ vintages, terms) */
  pit: boolean;
  /** for fieldClass 'derived'/'analytic': the formula or engine name (ANAL-08) */
  derivation?: string;
  example: FieldExample;
  /** dictionary version that introduced it */
  since: string;
  deprecated?: FieldDeprecation;
}
