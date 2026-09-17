// packages/core/src/command/sectors.ts — WP-03 (WORKPLAN L584-585).
//
// The `MarketSector` ↔ `AssetClass` map and the yellow-key table of FUNCTIONS.md §2.1 L638-647,
// plus the sector aliases and the case-insensitive lookup the command grammar's `sector` production
// needs (FUNCTIONS.md L627: "case-insensitive; unique prefix >= 3 chars; aliases").
//
// Two different questions are asked of this module and they have two different answers:
//
//   * "which asset classes can a `SPX Index` style reference resolve to?" — `SECTOR_ASSET_CLASSES`,
//     which is the *universe wedge* of FUNCTIONS.md L638-647 verbatim. `Corp`, `Comdty`, `Mtge`,
//     `Muni` and `Pfd` map to nothing: they parse, so the grammar is complete, and then the command
//     line raises `NOT_IN_UNIVERSE` and the server answers `422 NOT_IN_UNIVERSE` (L647).
//   * "which sector is printed after a `crypto` instrument's ticker?" — `ASSET_CLASS_SECTOR`, the
//     display sector of an asset class. It is total over all ten asset classes, so it also answers
//     for `future`, whose display sector is `Comdty` even though no future is in the wedge.
//
// The two maps agree on every asset class in the wedge: for each sector `s` and each
// `ac in SECTOR_ASSET_CLASSES[s]`, `ASSET_CLASS_SECTOR[ac] === s` unless `s` is a *secondary* sector
// for `ac` — the one such case is `rate`, which is reachable as both `SOFR Index` and `SOFR M-Mkt`
// and displays as `Index` (L644). `SECTOR_PRIMARY` records which sector is the display form.
//
// No IO, no clock, no allocation on the hot path: every table is frozen at module load and the
// lookups are three map probes and, at worst, one scan of eleven names.

import type { AssetClass, MarketSector } from '../types/instrument.js';

/* -------------------------------------------------------------------------------------------- */
/* The enums                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** The eleven `market_sector` values, in the order CONTRACTS §1.1 L16 declares them. */
export const MARKET_SECTORS: readonly MarketSector[] = Object.freeze([
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
] as const);

/** The ten `asset_class` values, in the order CONTRACTS §1.1 L15 declares them. */
export const ASSET_CLASSES: readonly AssetClass[] = Object.freeze([
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
] as const);

/* -------------------------------------------------------------------------------------------- */
/* Sector → asset classes (the universe wedge)                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * FUNCTIONS.md §2.1 L638-647 verbatim. An empty list means "parsed, but outside the wedge": the
 * reference is well formed and resolution fails with `NOT_IN_UNIVERSE`, never with a parse error.
 */
export const SECTOR_ASSET_CLASSES: Readonly<Record<MarketSector, readonly AssetClass[]>> =
  Object.freeze({
    // option contracts use the Bloomberg-style `AAPL 9/16/26 C245 Equity` form (L640)
    Equity: Object.freeze(['equity', 'etf', 'option'] as const),
    // `SPX Index`, `SOFR Index`, `CPIAUCSL Index` (L641)
    Index: Object.freeze(['index', 'rate', 'econ'] as const),
    Curncy: Object.freeze(['fx'] as const),
    // `912797VE4 Govt`, `T 4.25 08/15/36 Govt` (L643)
    Govt: Object.freeze(['govt'] as const),
    Corp: Object.freeze([] as const),
    Comdty: Object.freeze([] as const),
    Mtge: Object.freeze([] as const),
    Muni: Object.freeze([] as const),
    Pfd: Object.freeze([] as const),
    // `SOFR M-Mkt` resolves to the same instrument as `SOFR Index`; display form is `Index` (L644)
    'M-Mkt': Object.freeze(['rate'] as const),
    Crypto: Object.freeze(['crypto'] as const),
  });

/**
 * The display sector of an asset class — what `formatSecurityRef` appends and what
 * `ResolvedRef.display` carries. Total over all ten asset classes.
 *
 * `rate` displays as `Index`, not `M-Mkt`, although both parse (L644). `future` displays as
 * `Comdty`, the sector a future belongs to, although `SECTOR_ASSET_CLASSES.Comdty` is empty: no
 * future is in this system's universe (L647).
 */
export const ASSET_CLASS_SECTOR: Readonly<Record<AssetClass, MarketSector>> = Object.freeze({
  equity: 'Equity',
  etf: 'Equity',
  index: 'Index',
  fx: 'Curncy',
  govt: 'Govt',
  option: 'Equity',
  future: 'Comdty',
  crypto: 'Crypto',
  rate: 'Index',
  econ: 'Index',
});

/**
 * `true` when the sector is the display form for at least one of its asset classes. `M-Mkt` is the
 * one sector in the wedge that is false: it is an accepted input spelling whose output spelling is
 * `Index`.
 */
export const SECTOR_PRIMARY: Readonly<Record<MarketSector, boolean>> = Object.freeze(
  Object.fromEntries(
    MARKET_SECTORS.map((sector) => [
      sector,
      SECTOR_ASSET_CLASSES[sector].some((ac) => ASSET_CLASS_SECTOR[ac] === sector),
    ]),
  ) as Record<MarketSector, boolean>,
);

/** `true` when at least one asset class of this system lives under the sector. */
export const SECTOR_IN_UNIVERSE: Readonly<Record<MarketSector, boolean>> = Object.freeze(
  Object.fromEntries(
    MARKET_SECTORS.map((sector) => [sector, SECTOR_ASSET_CLASSES[sector].length > 0]),
  ) as Record<MarketSector, boolean>,
);

/**
 * The yellow key of FUNCTIONS.md §2.1 L638-647, as a `KeyboardEvent.code`-free label. `null` for
 * `Crypto`, which has no yellow key on a Bloomberg keyboard.
 */
export const SECTOR_YELLOW_KEYS: Readonly<Record<MarketSector, string | null>> = Object.freeze({
  Equity: 'F8',
  Index: 'F10',
  Curncy: 'F11',
  Govt: 'F2',
  Corp: 'F3',
  Comdty: 'F9',
  Mtge: 'F4',
  Muni: 'F6',
  Pfd: 'F7',
  'M-Mkt': 'F5',
  Crypto: null,
});

/* -------------------------------------------------------------------------------------------- */
/* Aliases                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * Every spelling a user may type for a sector, keyed by its upper-case form. The canonical names
 * are included so that one probe answers "is this token a sector?" for names and aliases alike.
 *
 * `Currency` is the alias FUNCTIONS.md L642 names for `Curncy`; `MMKT` the one L644 names for
 * `M-Mkt`. `Comdty` is the canonical spelling and `Cmdty` the common mistyping of it; both are
 * accepted and both format back as `Comdty`.
 */
export const SECTOR_ALIASES: ReadonlyMap<string, MarketSector> = new Map<string, MarketSector>([
  // canonical names
  ['EQUITY', 'Equity'],
  ['INDEX', 'Index'],
  ['CURNCY', 'Curncy'],
  ['GOVT', 'Govt'],
  ['CORP', 'Corp'],
  ['COMDTY', 'Comdty'],
  ['MTGE', 'Mtge'],
  ['MUNI', 'Muni'],
  ['PFD', 'Pfd'],
  ['M-MKT', 'M-Mkt'],
  ['CRYPTO', 'Crypto'],
  // aliases
  ['EQTY', 'Equity'],
  ['CMDTY', 'Comdty'],
  ['CCY', 'Curncy'],
  ['CURRENCY', 'Curncy'],
  ['MMKT', 'M-Mkt'],
]);

/** The shortest prefix the grammar will consider (FUNCTIONS.md L627). */
export const SECTOR_MIN_PREFIX = 3;

const UPPER_NAMES: readonly (readonly [string, MarketSector])[] = Object.freeze(
  MARKET_SECTORS.map((s) => Object.freeze([s.toUpperCase(), s] as const)),
);

/* -------------------------------------------------------------------------------------------- */
/* Lookup                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** How a sector token was recognised, in the order the lookup tries them. */
export type SectorMatchKind = 'name' | 'alias' | 'prefix';

/** Why a token is not a sector. `too-short` is a prefix under {@link SECTOR_MIN_PREFIX}. */
export type SectorMissReason = 'empty' | 'too-short' | 'unknown' | 'ambiguous';

/** The result of {@link resolveSector}; narrow on `ok`. Never throws, for any input. */
export type SectorLookup =
  | { readonly ok: true; readonly sector: MarketSector; readonly matched: SectorMatchKind }
  | {
      readonly ok: false;
      readonly reason: SectorMissReason;
      /** The sectors a `too-short` or `ambiguous` token could have meant; `[]` otherwise. */
      readonly candidates: readonly MarketSector[];
    };

const miss = (
  reason: SectorMissReason,
  candidates: readonly MarketSector[] = [],
): SectorLookup => ({ ok: false, reason, candidates });

/**
 * Case-insensitive sector lookup: exact canonical name, then alias, then a unique prefix of at
 * least {@link SECTOR_MIN_PREFIX} characters over the canonical names (FUNCTIONS.md L627).
 *
 * Total: any value, including `undefined` and a hostile string, yields a miss rather than an
 * exception, because QA-05 fuzzes the command line that calls it.
 */
export function resolveSector(raw: unknown): SectorLookup {
  if (typeof raw !== 'string') return miss('unknown');
  const token = raw.trim().toUpperCase();
  if (token.length === 0) return miss('empty');

  for (const [upper, sector] of UPPER_NAMES)
    if (upper === token) return { ok: true, sector, matched: 'name' };

  const alias = SECTOR_ALIASES.get(token);
  if (alias !== undefined) return { ok: true, sector: alias, matched: 'alias' };

  const hits: MarketSector[] = [];
  for (const [upper, sector] of UPPER_NAMES) if (upper.startsWith(token)) hits.push(sector);
  if (hits.length === 0) return miss('unknown');
  // Ambiguity is reported before shortness: `C` names four sectors and saying so is more use than
  // saying it is one character long, and a one-letter ticker like `C` must not be read as a sector.
  if (hits.length > 1) return miss('ambiguous', Object.freeze(hits));
  if (token.length < SECTOR_MIN_PREFIX) return miss('too-short', Object.freeze(hits));

  const only = hits[0];
  if (only === undefined) return miss('unknown');
  return { ok: true, sector: only, matched: 'prefix' };
}

/** {@link resolveSector} reduced to the sector, or `null`. */
export function lookupSector(raw: unknown): MarketSector | null {
  const found = resolveSector(raw);
  return found.ok ? found.sector : null;
}

/** `true` when the token names a sector by name, alias or unique prefix. */
export function isSectorToken(raw: unknown): boolean {
  return resolveSector(raw).ok;
}

/** The asset classes a sector can resolve to; `[]` for a sector outside the universe. */
export function assetClassesForSector(sector: MarketSector): readonly AssetClass[] {
  return SECTOR_ASSET_CLASSES[sector];
}

/** The display sector of an asset class. */
export function sectorForAssetClass(assetClass: AssetClass): MarketSector {
  return ASSET_CLASS_SECTOR[assetClass];
}

/** `true` when an instrument of `assetClass` may be named with `sector`. */
export function sectorAllowsAssetClass(sector: MarketSector, assetClass: AssetClass): boolean {
  return SECTOR_ASSET_CLASSES[sector].includes(assetClass);
}

/** `true` when the sector has at least one asset class in this system's universe. */
export function sectorInUniverse(sector: MarketSector): boolean {
  return SECTOR_IN_UNIVERSE[sector];
}

/** The yellow key for a sector, or `null` when it has none. */
export function yellowKeyForSector(sector: MarketSector): string | null {
  return SECTOR_YELLOW_KEYS[sector];
}
