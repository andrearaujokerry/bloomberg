// packages/core/src/functions/schemas.ts
//
// The zod 4 enums every Tier 1 manifest validates its params against (FUNCTIONS_TIER1 §0.1).
//
// These declarations are BYTE-IDENTICAL to `packages/sdk/src/wire/common.ts`, and
// `packages/core/test/functions/shared.test.ts` asserts it by reading both files and comparing the
// declaration text — not by comparing the parsed shapes, because two enums can agree on their
// members and still disagree on their order, their regex or their refinements.
//
// Why a copy at all: `@terminal/core` is the bottom of the dependency graph and cannot import
// `@terminal/sdk` (the SDK depends on core, so the other direction would be a cycle). The intended
// end state, stated in FUNCTIONS_TIER1 §0.1, is that the SDK re-exports these from core; until that
// move happens the test is what keeps the two copies from drifting.
//
// `SortSpec` is the one declaration with no counterpart in the SDK today — see the test's
// `SDK_MISSING` list, which is the recorded finding rather than a silent divergence.

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

/** REF-09; the only three (DATA_MODEL §20) */
export const AdjustPolicy = z.enum(['unadjusted', 'price', 'total_return']);
export type AdjustPolicy = z.infer<typeof AdjustPolicy>;

/** resampled from '1d' bars on read */
export const Periodicity = z.enum(['D', 'W', 'M', 'Q', 'Y']);
export type Periodicity = z.infer<typeof Periodicity>;

/** 'PX_LAST'; validated against the dictionary at runtime */
export const FIELD_ID_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;
export const FieldId = z.string().regex(FIELD_ID_PATTERN);
export type FieldId = z.infer<typeof FieldId>;

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

/** One column of a grid sort, as QM/W/SECF/TOP take it (FUNCTIONS_TIER1 §0.1). */
export const SortSpec = z.object({ col: z.string(), dir: z.enum(['asc', 'desc']) });
export type SortSpec = z.infer<typeof SortSpec>;
