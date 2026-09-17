/**
 * `wire/common.ts` — the common wire vocabulary (API.md §3 L199-250).
 *
 * The enums are byte-identical to `core/types/*.ts` and to the Postgres enums in DATA_MODEL §1.
 * This module sits at the bottom of the `wire/` import graph: `wire/envelope.ts`,
 * `wire/dataRequest.ts`, `wire/ws.ts` and every `wire/rest/*.ts` build on it, and
 * `wire/envelope.ts` re-exports it so either import path names the same schema objects.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Common enums — API.md §3 L202-215 (wire/common.ts)
// ---------------------------------------------------------------------------

export const AssetClass = z.enum([
  'equity',
  'etf',
  'index',
  'fx',
  'govt',
  'option',
  'future',
  'crypto',
  'rate',
  'econ',
]);
export type AssetClass = z.infer<typeof AssetClass>;

export const MarketSector = z.enum([
  'Equity',
  'Index',
  'Curncy',
  'Govt',
  'Corp',
  'Comdty',
  'Mtge',
  'Muni',
  'Pfd',
  'M-Mkt',
  'Crypto',
]);
export type MarketSector = z.infer<typeof MarketSector>;

/** ordered eod < delayed < realtime */
export const Tier = z.enum(['eod', 'delayed', 'realtime']);
export type Tier = z.infer<typeof Tier>;

/** TERM-12; tier is carried separately */
export const ValueState = z.enum(['live', 'stale', 'closed', 'blank', 'na']);
export type ValueState = z.infer<typeof ValueState>;

export const SessionState = z.enum([
  'pre',
  'open',
  'auction',
  'halted',
  'closed',
  'post',
  'unknown',
]);
export type SessionState = z.infer<typeof SessionState>;

export const UsageType = z.enum(['display', 'export', 'api']);
export type UsageType = z.infer<typeof UsageType>;

export const FieldClass = z.enum([
  'price',
  'reference',
  'fundamental',
  'econ',
  'news',
  'analytic',
  'derived',
  'portfolio',
]);
export type FieldClass = z.infer<typeof FieldClass>;

/** REF-09; the only three (DATA_MODEL §20) */
export const AdjustPolicy = z.enum(['unadjusted', 'price', 'total_return']);
export type AdjustPolicy = z.infer<typeof AdjustPolicy>;

/** core/types/bars.ts */
export const BarInterval = z.enum(['1m', '5m', '1d']);
export type BarInterval = z.infer<typeof BarInterval>;

/** resampled from '1d' bars on read */
export const Periodicity = z.enum(['D', 'W', 'M', 'Q', 'Y']);
export type Periodicity = z.infer<typeof Periodicity>;

/** 'PX_LAST'; validated against the dictionary at runtime */
export const FIELD_ID_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;
export const FieldId = z.string().regex(FIELD_ID_PATTERN);
export type FieldId = z.infer<typeof FieldId>;

/** ARCHITECTURE §6.1 — `<family>:<key>` */
export const SUBJECT_ID_PATTERN = /^(q|l|b1m|oc|c|r|e|n|alerts|room|sys):[A-Za-z0-9_.:-]+$/;
export const SubjectId = z.string().regex(SUBJECT_ID_PATTERN);
export type SubjectId = z.infer<typeof SubjectId>;

/** null = blank/denied/unknown; reason in `r` */
export const FieldValue = z.union([z.number(), z.string(), z.boolean(), z.null()]);
export type FieldValue = z.infer<typeof FieldValue>;

/** How a security is addressed anywhere in the API. Exactly one form. */
export const SecurityRefInput = z.union([
  // instrumentId (immutable internal key, REF-01)
  z.object({ id: z.number().int().positive() }),
  // command-line form parsed by core/ids/securityRef.ts:
  //   'AAPL US Equity' · 'AAPL Equity' · 'SPX Index' · 'EURUSD Curncy' · '912797VE4 Govt' ·
  //   'T 4.25 08/15/36 Govt' · 'AAPL 9/16/26 C245 Equity' · 'SOFR Index' · 'CPIAUCSL Index' ·
  //   '/isin/US0378331005' · '/figi/BBG000B9XRY4' · '/cusip/037833100' ·
  //   '/occ/AAPL260916C00245000' · '/series/fred.csv/DGS10'
  z.object({ ref: z.string().min(1).max(120) }),
  // CHRT-07 computed series, core/formula: 'RATIO(AAPL US Equity, SPX Index)'
  z.object({ formula: z.string().min(3).max(400) }),
]);
export type SecurityRefInput = z.infer<typeof SecurityRefInput>;

/** core/types/instrument.ts ResolvedRef, verbatim, plus the display columns every list needs. */
export const ResolvedRef = z.object({
  instrumentId: z.number().int(),
  assetClass: AssetClass,
  marketSector: MarketSector,
  display: z.string(), // 'AAPL US Equity'
  name: z.string(),
  currency: z.string().length(3),
  primaryListingId: z.number().int().optional(),
  mdLineIds: z.array(z.number().int()),
});
export type ResolvedRef = z.infer<typeof ResolvedRef>;

export const InstrumentSummary = ResolvedRef.extend({
  ticker: z.string(),
  exchCode: z.string(),
  securityType: z.string(),
  compositeFigi: z.string().length(12).nullable(),
  status: z.enum(['active', 'delisted', 'pending', 'matured', 'expired']),
  // instruments.price_decimals (display hint; the formatter decides)
  priceDecimals: z.number().int(),
});
export type InstrumentSummary = z.infer<typeof InstrumentSummary>;
