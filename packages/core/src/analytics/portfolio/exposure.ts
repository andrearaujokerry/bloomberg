/**
 * Portfolio exposure aggregation — WORKPLAN L516 ("exposure by sector/asset/currency"),
 * ARCHITECTURE L176, FUNCTIONS_TIER2 L1435 (`portfolio/exposure@1.0.0`).
 *
 * Everything here is arithmetic over a list of positions, in one stated base currency. The two
 * things that make exposure a real analytic rather than a `reduce` are **cash** and **shorts**,
 * and this module refuses to be vague about either:
 *
 *   - a **short** carries a negative market value, so it carries a negative *net* weight and a
 *     positive *gross* weight. Net weights sum to 1; gross weights sum to 1 over the non-cash
 *     book. The two denominators are different on purpose and both are named in `Conventions`.
 *   - **cash** is a position like any other for net asset value (it is in the denominator), and
 *     is excluded from gross market exposure (you cannot be "levered into cash"). That is the
 *     only asymmetry, and `Conventions.cashTreatment` states it.
 *
 * Every total is accumulated with Neumaier compensated summation, so `Σ weight` comes back as
 * exactly 1 for the portfolios a test can reasonably write down, instead of `0.9999999999999999`.
 *
 * Pure: no clock, no IO, no `Date` (packages/core rule).
 */

import type { AssetClass } from '../../types/instrument.js';
import type { Conventions } from '../engine.js';
import { defineEngine } from '../engine.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `AssetClass` union plus `'cash'`. `core/types/instrument.ts` has no cash asset class — cash
 * is not an instrument — but a portfolio always holds some, so the exposure grid needs the bucket.
 */
export type PortfolioAssetClass = AssetClass | 'cash';

/** The three dimensions WORKPLAN L516 names. */
export type ExposureDimension = 'sector' | 'assetClass' | 'currency';

/** The bucket a position with no sector falls into. */
export const UNCLASSIFIED_SECTOR = 'Unclassified';

/** The bucket a cash position falls into on the sector dimension. */
export const CASH_SECTOR = 'Cash';

/**
 * One holding. Either give `quantity`/`price` (and `multiplier`/`fxRate` where they are not 1),
 * or give `marketValue` directly when the caller has already valued the line — `marketValue`
 * wins when both are present, which is how a cash balance is expressed.
 */
export interface Position {
  /** Immutable internal key (REF-01). Used verbatim in per-position output rows. */
  readonly instrumentId: string;
  readonly assetClass: PortfolioAssetClass;
  /** GICS-style sector name; `null`/absent lands in {@link UNCLASSIFIED_SECTOR}. */
  readonly sector?: string | null;
  /** ISO 4217 code of the currency the position is *quoted* in. */
  readonly currency: string;
  /** Signed: negative for a short. */
  readonly quantity?: number;
  /** Price in `currency`. */
  readonly price?: number;
  /** Contract multiplier / point value; 1 for cash equities. */
  readonly multiplier?: number;
  /** Units of the base currency per unit of `currency`; 1 when `currency === baseCurrency`. */
  readonly fxRate?: number;
  /** Pre-valued line, in the **base** currency, signed. Takes precedence when present. */
  readonly marketValue?: number;
}

/** Convention overrides accepted by {@link exposure}. */
export interface ExposureConventionOverrides {
  readonly baseCurrency?: string;
  readonly unclassifiedSector?: string;
  readonly cashSector?: string;
  /** `true` (the default): cash is excluded from gross market exposure. */
  readonly cashExcludedFromGross?: boolean;
}

/** The exposure convention set, echoed in the outputs (ANAL-07). */
export interface ExposureConventions extends Conventions {
  /** The currency every market value and total is expressed in. */
  readonly baseCurrency: string;
  readonly valuation: string;
  readonly navBasis: string;
  readonly netWeightBasis: string;
  readonly grossWeightBasis: string;
  readonly shortTreatment: string;
  readonly cashTreatment: string;
  readonly unclassifiedSector: string;
  readonly cashSector: string;
  readonly cashExcludedFromGross: boolean;
  readonly bucketOrder: string;
}

const BASE_CONVENTIONS = {
  valuation: 'marketValue(base) = marketValue ?? quantity × price × multiplier × fxRate',
  navBasis: 'netAssetValue = Σ marketValue over every position, cash included',
  netWeightBasis: 'netWeight = marketValue / netAssetValue; Σ netWeight = 1',
  grossWeightBasis:
    'grossWeight = |marketValue| / grossExposure; Σ grossWeight = 1 over the non-cash book',
  shortTreatment:
    'signed: a short carries a negative marketValue, a negative netWeight and a positive grossWeight',
  cashTreatment:
    'cash is a position for netAssetValue and is excluded from grossExposure and from leverage',
  bucketOrder: 'buckets sorted by key ascending, by UTF-16 code unit — deterministic, locale-free',
} as const;

/** The default exposure conventions: USD base, cash out of gross. */
export const DEFAULT_EXPOSURE_CONVENTIONS: ExposureConventions = Object.freeze({
  baseCurrency: 'USD',
  unclassifiedSector: UNCLASSIFIED_SECTOR,
  cashSector: CASH_SECTOR,
  cashExcludedFromGross: true,
  ...BASE_CONVENTIONS,
} satisfies ExposureConventions);

/** Merge overrides onto {@link DEFAULT_EXPOSURE_CONVENTIONS} and validate. */
export function resolveExposureConventions(
  overrides?: ExposureConventionOverrides,
): ExposureConventions {
  const merged: ExposureConventions = {
    ...DEFAULT_EXPOSURE_CONVENTIONS,
    ...(overrides ?? {}),
    ...BASE_CONVENTIONS,
  };
  if (typeof merged.baseCurrency !== 'string' || merged.baseCurrency.length === 0) {
    throw new RangeError('exposure: conventions.baseCurrency must be a non-empty ISO 4217 code');
  }
  return Object.freeze(merged);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Outputs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One valued position, with both weights. */
export interface PositionExposure {
  readonly instrumentId: string;
  readonly assetClass: PortfolioAssetClass;
  readonly sector: string;
  readonly currency: string;
  /** Base-currency, signed. */
  readonly marketValue: number;
  /** `marketValue / netAssetValue`. Negative for a short. */
  readonly netWeight: number;
  /** `|marketValue| / grossExposure`; 0 for cash while `cashExcludedFromGross`. */
  readonly grossWeight: number;
  readonly isCash: boolean;
  readonly isShort: boolean;
}

/** One row of an exposure breakdown. */
export interface ExposureBucket {
  readonly key: string;
  readonly positions: number;
  /** Signed sum of the bucket's market values. */
  readonly marketValue: number;
  /** Sum of the positive market values in the bucket. */
  readonly longMarketValue: number;
  /** Sum of the negative market values in the bucket (≤ 0). */
  readonly shortMarketValue: number;
  /** `longMarketValue − shortMarketValue = Σ |marketValue|`, cash included. */
  readonly grossMarketValue: number;
  readonly netWeight: number;
  readonly grossWeight: number;
}

/** A full breakdown along one dimension. */
export interface ExposureBreakdown {
  readonly dimension: ExposureDimension;
  readonly buckets: readonly ExposureBucket[];
  /** Σ of the buckets' `netWeight` — 1 for a non-degenerate portfolio. */
  readonly netWeightSum: number;
  /** Σ of the buckets' `grossWeight` — 1 when the book holds anything but cash. */
  readonly grossWeightSum: number;
}

/** What {@link exposure} returns. */
export interface ExposureResult {
  readonly positions: readonly PositionExposure[];
  /** Σ marketValue, cash included. The denominator of every net weight. */
  readonly netAssetValue: number;
  /** Σ marketValue over positive non-cash lines. */
  readonly longExposure: number;
  /** Σ marketValue over negative non-cash lines (≤ 0). */
  readonly shortExposure: number;
  /** `longExposure + shortExposure`. */
  readonly netExposure: number;
  /** `longExposure − shortExposure`. The denominator of every gross weight. */
  readonly grossExposure: number;
  /** Σ marketValue over cash lines. */
  readonly cash: number;
  readonly cashWeight: number;
  /** `netExposure / netAssetValue`. */
  readonly netLeverage: number;
  /** `grossExposure / netAssetValue`. */
  readonly grossLeverage: number;
  readonly longCount: number;
  readonly shortCount: number;
  readonly bySector: ExposureBreakdown;
  readonly byAssetClass: ExposureBreakdown;
  readonly byCurrency: ExposureBreakdown;
  readonly conventions: ExposureConventions;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Summation
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Neumaier compensated summation. A portfolio total is a sum of numbers of wildly different
 * magnitude (a 9-figure NAV, a 2-figure odd lot), which is exactly where naive accumulation
 * loses the low bits and a weight column stops summing to 1.
 */
export function compensatedSum(xs: readonly number[]): number {
  let sum = 0;
  let c = 0;
  for (const x of xs) {
    const t = sum + x;
    c += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum;
    sum = t;
  }
  return sum + c;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * Assert without narrowing. A bare `Array.isArray(xs)` on a `readonly T[]` parameter narrows it to
 * `any[]`, which turns every later property access into an `any` — so the check takes `unknown`
 * and returns nothing, leaving the caller's declared type intact.
 */
function requireArray(label: string, xs: unknown): void {
  if (!Array.isArray(xs)) {
    throw new TypeError(`exposure: ${label} must be an array`);
  }
}

/** Value one position in the base currency, with `marketValue` taking precedence. */
export function positionMarketValue(p: Position): number {
  if (p.marketValue !== undefined) {
    if (!isFiniteNumber(p.marketValue)) {
      throw new RangeError(
        `exposure: position '${p.instrumentId}' marketValue must be a finite number`,
      );
    }
    return p.marketValue;
  }
  const quantity = p.quantity ?? 0;
  const price = p.price ?? 0;
  const multiplier = p.multiplier ?? 1;
  const fxRate = p.fxRate ?? 1;
  for (const [label, value] of [
    ['quantity', quantity],
    ['price', price],
    ['multiplier', multiplier],
    ['fxRate', fxRate],
  ] as const) {
    if (!isFiniteNumber(value)) {
      throw new RangeError(
        `exposure: position '${p.instrumentId}' ${label} must be a finite number, got ${String(value)}`,
      );
    }
  }
  return quantity * price * multiplier * fxRate;
}

function byKeyAscending(a: ExposureBucket, b: ExposureBucket): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function breakdown(
  dimension: ExposureDimension,
  rows: readonly PositionExposure[],
  keyOf: (row: PositionExposure) => string,
  nav: number,
  gross: number,
  cashExcludedFromGross: boolean,
): ExposureBreakdown {
  const groups = new Map<string, PositionExposure[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [row]);
    else bucket.push(row);
  }

  const buckets: ExposureBucket[] = [];
  for (const [key, members] of groups) {
    const marketValue = compensatedSum(members.map((m) => m.marketValue));
    const longMarketValue = compensatedSum(
      members.filter((m) => m.marketValue > 0).map((m) => m.marketValue),
    );
    const shortMarketValue = compensatedSum(
      members.filter((m) => m.marketValue < 0).map((m) => m.marketValue),
    );
    const grossMembers = members.filter((m) => !(cashExcludedFromGross && m.isCash));
    const grossMarketValue = compensatedSum(grossMembers.map((m) => Math.abs(m.marketValue)));
    buckets.push({
      key,
      positions: members.length,
      marketValue,
      longMarketValue,
      shortMarketValue,
      grossMarketValue,
      netWeight: marketValue / nav,
      grossWeight: gross === 0 ? 0 : grossMarketValue / gross,
    });
  }
  buckets.sort(byKeyAscending);

  return Object.freeze({
    dimension,
    buckets: Object.freeze(buckets),
    netWeightSum: compensatedSum(buckets.map((b) => b.netWeight)),
    grossWeightSum: compensatedSum(buckets.map((b) => b.grossWeight)),
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The analytic
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate exposure by sector, asset class and currency.
 *
 * Throws when net asset value is exactly zero: every net weight would be an infinity or a NaN,
 * and silently returning those is how a blank exposure screen gets shipped.
 */
export function exposure(
  positions: readonly Position[],
  conventions?: ExposureConventionOverrides,
): ExposureResult {
  const conv = resolveExposureConventions(conventions);
  requireArray('positions', positions);

  const rowsRaw = positions.map((p): Omit<PositionExposure, 'netWeight' | 'grossWeight'> => {
    if (typeof p.instrumentId !== 'string' || p.instrumentId.length === 0) {
      throw new RangeError('exposure: every position needs a non-empty instrumentId');
    }
    if (typeof p.currency !== 'string' || p.currency.length === 0) {
      throw new RangeError(`exposure: position '${p.instrumentId}' needs a currency`);
    }
    const isCash = p.assetClass === 'cash';
    const marketValue = positionMarketValue(p);
    const sector =
      p.sector === undefined || p.sector === null || p.sector.length === 0
        ? isCash
          ? conv.cashSector
          : conv.unclassifiedSector
        : p.sector;
    return {
      instrumentId: p.instrumentId,
      assetClass: p.assetClass,
      sector,
      currency: p.currency,
      marketValue,
      isCash,
      isShort: marketValue < 0,
    };
  });

  const cash = compensatedSum(rowsRaw.filter((r) => r.isCash).map((r) => r.marketValue));
  const securities = rowsRaw.filter((r) => !(conv.cashExcludedFromGross && r.isCash));
  const longExposure = compensatedSum(
    securities.filter((r) => r.marketValue > 0).map((r) => r.marketValue),
  );
  const shortExposure = compensatedSum(
    securities.filter((r) => r.marketValue < 0).map((r) => r.marketValue),
  );
  const netExposure = longExposure + shortExposure;
  const grossExposure = longExposure - shortExposure;
  const netAssetValue = compensatedSum(rowsRaw.map((r) => r.marketValue));

  if (netAssetValue === 0) {
    throw new RangeError(
      'exposure: net asset value is exactly zero, so no weight is defined — pass a portfolio with a non-zero NAV',
    );
  }

  const rows: PositionExposure[] = rowsRaw.map((r) => ({
    ...r,
    netWeight: r.marketValue / netAssetValue,
    grossWeight:
      grossExposure === 0 || (conv.cashExcludedFromGross && r.isCash)
        ? 0
        : Math.abs(r.marketValue) / grossExposure,
  }));

  return Object.freeze({
    positions: Object.freeze(rows),
    netAssetValue,
    longExposure,
    shortExposure,
    netExposure,
    grossExposure,
    cash,
    cashWeight: cash / netAssetValue,
    netLeverage: netExposure / netAssetValue,
    grossLeverage: grossExposure / netAssetValue,
    longCount: rowsRaw.filter((r) => !r.isCash && r.marketValue > 0).length,
    shortCount: rowsRaw.filter((r) => !r.isCash && r.marketValue < 0).length,
    bySector: breakdown(
      'sector',
      rows,
      (r) => r.sector,
      netAssetValue,
      grossExposure,
      conv.cashExcludedFromGross,
    ),
    byAssetClass: breakdown(
      'assetClass',
      rows,
      (r) => r.assetClass,
      netAssetValue,
      grossExposure,
      conv.cashExcludedFromGross,
    ),
    byCurrency: breakdown(
      'currency',
      rows,
      (r) => r.currency,
      netAssetValue,
      grossExposure,
      conv.cashExcludedFromGross,
    ),
    conventions: conv,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The engine (ANAL-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The declared input set of the `portfolio/exposure` engine. */
export type ExposureEngineInputs = {
  readonly positions: readonly Position[];
  readonly conventions?: ExposureConventionOverrides;
};

/**
 * `portfolio/exposure@1.0.0` (FUNCTIONS_TIER2 L1435), wrapped in `defineEngine` so a result
 * carries its inputs, the engine identity and the `char(64)` `inputsHash` (ANAL-08).
 */
export const exposureEngine = defineEngine<ExposureEngineInputs, ExposureResult>(
  'portfolio/exposure',
  '1.0.0',
  (inputs) => exposure(inputs.positions, inputs.conventions),
);
