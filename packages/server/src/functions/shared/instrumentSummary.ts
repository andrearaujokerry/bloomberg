/**
 * `functions/shared/instrumentSummary.ts` — `InstrumentDetail` → the wire's `InstrumentSummary`
 * (API.md §3 L234-240, FUNCTIONS_TIER1.md §0.1).
 *
 * `InstrumentDetail` is the whole hierarchy at one instant: instrument, issue, issuer, every
 * listing, every md line, every identifier, terms and classifications. `InstrumentSummary` is the
 * dozen columns a *reference* to a security needs — the row in a candidate list, the header of a
 * screen, the security block of a payload. Tier 1 screens all resolve the detail once and then
 * need the summary in three places, and every one of them writing its own projection is how two
 * screens end up disagreeing about what `display` looks like.
 *
 * `data/request.ts#toInstrumentSummary` does the same projection from a `ResolveCandidate`, the
 * shape the *resolver* produces. This is the same target shape from the *reader's* input, and the
 * two must agree column for column — a candidate list and the screen it launches show the same
 * security.
 */

import type { MarketSector } from '@terminal/core';
import type { InstrumentSummary } from '@terminal/sdk/wire/common';

import type { InstrumentDetail } from '../../data/reference.js';

/**
 * Exchange codes that stand for "not listed anywhere" (DATA_MODEL §3 `instruments.exch_code`).
 * Mirrors the private set in `refdata/resolve.ts`; both exist so `'SPX Index'` never renders as
 * `'SPX INDEX Index'`.
 */
const SYNTHETIC_EXCH_CODES: ReadonlySet<string> = new Set([
  'GOVT',
  'FX',
  'INDEX',
  'RATE',
  'ECON',
  'CRYPTO',
]);

/** `'AAPL US Equity'` — the canonical command-line form (core `ResolvedRef.display`). */
export function displayOf(ticker: string, exchCode: string, sector: MarketSector): string {
  const spoken = SYNTHETIC_EXCH_CODES.has(exchCode) ? '' : `${exchCode} `;
  return `${ticker} ${spoken}${sector}`;
}

/**
 * The API.md §3 summary of a resolved instrument.
 *
 * Three columns come from outside `instruments` and each has a defined fallback, because a summary
 * that throws is a screen that does not render over a master that is merely incomplete:
 *
 *  - `securityType` is `issues.security_type`. An instrument whose issue row is missing at this
 *    `asOf` reports `''` rather than inventing a type.
 *  - `compositeFigi` is nullable on the wire and optional on the record; `undefined` becomes
 *    `null`, which is what the schema says and what a JSON round-trip preserves.
 *  - `mdLineIds` is every md line the instrument carries at this instant, ascending, so two calls
 *    over the same instant produce byte-identical payloads (the reproducibility ANAL-08 asserts).
 *
 * `primaryListingId` is omitted rather than set to `undefined`: the wire schema marks it optional,
 * `exactOptionalPropertyTypes` distinguishes the two, and `JSON.stringify` drops one and keeps the
 * other — which is the difference between two canonical hashes agreeing and not.
 */
export function toSummary(detail: InstrumentDetail): InstrumentSummary {
  const i = detail.instrument;
  const summary: InstrumentSummary = {
    instrumentId: i.instrumentId,
    assetClass: i.assetClass,
    marketSector: i.marketSector,
    display: displayOf(i.ticker, i.exchCode, i.marketSector),
    name: i.name,
    currency: i.currency,
    mdLineIds: detail.mdLines.map((l) => l.mdLineId).sort((a, b) => a - b),
    ticker: i.ticker,
    exchCode: i.exchCode,
    securityType: detail.issue?.securityType ?? '',
    compositeFigi: i.compositeFigi ?? null,
    status: i.status,
    priceDecimals: i.priceDecimals,
  };
  if (i.primaryListingId !== undefined) summary.primaryListingId = i.primaryListingId;
  return summary;
}
