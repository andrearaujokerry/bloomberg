/**
 * The candidate model and the universe snapshot types — FUNCTIONS.md §3.2 L895-917, CONTRACTS §4.1
 * (L898 `Candidate`, L911 `RankContext`), API.md §5.2 (`SearchHit`, `UniverseSnapshot`).
 *
 * Three families of types live here:
 *
 *  1. `Candidate` / `RankContext` — the autocomplete row and the context it is scored in. The same
 *     object is `SearchHit` on the wire (API.md §5.2) and `rank()` is the same function on the
 *     client and on the server (FUNCTIONS.md L921-922), so local and server orderings are identical
 *     only as long as this shape stays identical on both sides. Nothing here is optional "for
 *     convenience": every optional field means something specific (`applicable:false` renders the
 *     row dimmed, `source:'yahoo'` renders a "not in master" badge).
 *
 *  2. `UniverseSnapshot` and its tuples — exactly the payload of `GET /api/v1/universe/snapshot`
 *     (API.md §5.2 L470-486). The wire form is positional tuples rather than objects because the
 *     snapshot carries ≈ 45 k instruments and the field names would be ~60 % of the gzipped bytes.
 *     WP-08's `server/src/search/snapshot.ts` produces it; `UniverseIndex` (`command/index.ts`)
 *     consumes it. The tuple positions are part of the contract — see each type's comment.
 *
 *  3. `UniverseEntry` — the flat, denormalised row the index actually searches (FUNCTIONS.md §3.1
 *     L885: `kind, id, primary, upperTicker/upperCode, nameWords, sector, assetClass, weight,
 *     status`). It is derived from the snapshot once, at build time, so that a keystroke never
 *     upper-cases, splits or concatenates a string: the ≤ 4 ms p95 budget of §3.5 is met by doing
 *     that work O(n) once, not O(n) per keystroke.
 *
 * This file is types only — no runtime values, no IO, nothing to construct.
 */

import type { Tier } from '../functions/manifest.js';
import type { AssetClass, MarketSector } from '../types/instrument.js';

/* -------------------------------------------------------------------------------------------- */
/* Candidate                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** The four things the one command line can complete to (FUNCTIONS.md §3.2 L899). */
export type CandidateKind = 'instrument' | 'function' | 'person' | 'topic';

/**
 * Which index structure produced the match (FUNCTIONS.md §3.2 L905). `'isin' | 'cusip' | 'figi'`
 * never come from the local index — identifiers are not in the snapshot (§3.1 L890) and are
 * resolved by `/ref/resolve` — but they are part of the wire contract because a server hit can
 * carry them.
 */
export type MatchedOn =
  'code' | 'ticker' | 'name' | 'isin' | 'cusip' | 'figi' | 'alias' | 'trigram';

/** Where a hit came from: the local `UniverseIndex`, or the Yahoo search fallback (§3.4). */
export type CandidateSource = 'local' | 'yahoo';

/** A half-open `[start, end)` range of UTF-16 code units in `Candidate.primary` to highlight. */
export type HighlightRange = [number, number];

/**
 * One autocomplete row. `rank()` returns at most twelve of these, best first, and row 0 is by
 * construction what `GO` executes (FUNCTIONS.md §3.3 L958-962).
 */
export interface Candidate {
  kind: CandidateKind;
  /** `instrumentId` (as a string) | function code | `personId` (as a string) | topic code. */
  id: string;
  /** `'AAPL US Equity'` | `'GP'` | `'Jane Doe (Demo Capital)'` | `'FED'`. */
  primary: string;
  /** `'Apple Inc · Common Stock · US'` | `'Price graph'` | `'CFO · Apple Inc'` | `'Federal Reserve'`. */
  secondary: string;
  assetClass?: AssetClass;
  marketSector?: MarketSector;
  score: number;
  matchedOn: MatchedOn;
  /** Highlight ranges in `primary`, ascending and non-overlapping. */
  matched: HighlightRange[];
  /** What `GO` executes for this row: `'AAPL US Equity'` | `'GP'` | `'MSG jane.doe'` | `'NI FED'`. */
  insertText: string;
  source: CandidateSource;
  /** Functions only: applicable in the panel context; rendered dimmed when `false`. */
  applicable?: boolean;
}

/**
 * Structural mirror of `PanelContext` (CONTRACTS §4.1 L687, declared by `command/parser.ts`).
 *
 * `search/types.ts` is imported by the parser's own module graph, so it cannot import back from it
 * without a cycle; the shape is structural, so the parser's `PanelContext` is assignable to this
 * without a cast and the two never drift silently — a field added there and not here fails to
 * compile at the `rank()` call site.
 */
export interface RankPanelContext {
  security: {
    instrumentId: number;
    assetClass: AssetClass;
    marketSector: MarketSector;
    display: string;
  } | null;
  fn: string | null;
  params: Record<string, unknown>;
}

/** One MRU row as it is scored: `rank` 0 is the most recent, `count` is the lifetime use count. */
export interface MruRank {
  rank: number;
  count: number;
}

/**
 * An MRU record as it is persisted (`terminal.mru` in `localStorage`, ≤ 50 rows, FUNCTIONS.md §3.1
 * L878-879) and as it is rebuilt from `panels[].history` on a fresh machine (TERM-05).
 * `lastUsed` is epoch milliseconds; the index turns it into a dense `rank` at build time.
 */
export interface MruRecord {
  kind: CandidateKind;
  id: string;
  lastUsed: number;
  count: number;
}

/** The context `rank()` scores in (FUNCTIONS.md §3.2 L911-917). */
export interface RankContext {
  panel: RankPanelContext;
  hasPanelSecurity: boolean;
  /** Instrument ids in the focused panel's watchlist/monitor rows (the R-context `+8` term). */
  watchlistIds: Set<number>;
  /** Key is `` `${kind}:${id}` ``, as produced by `mruKey()`. */
  mru: Map<string, MruRank>;
  /** Set when a sector was typed: the R1 filter. */
  sectorGiven?: MarketSector;
  /** Set to restrict the kinds returned; `SECF` passes `['instrument']` (R2). */
  kinds?: CandidateKind[];
}

/* -------------------------------------------------------------------------------------------- */
/* Universe snapshot (the wire form, API.md §5.2 L470-486)                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * `[instrumentId, ticker, marketSector, exchCode, name, assetClass, searchWeight, status]`.
 *
 * `exchCode` is `'US'` for listed equities and ETFs and a pseudo-code for everything else
 * (`'GOVT' | 'INDEX' | 'FX' | 'RATE' | 'ECON' | 'CRYPTO'`); `status` is `1` for active and `0`
 * otherwise (the `−30` penalty of §3.3 L954); `searchWeight` is `instruments.search_weight`
 * (1.0 default, 2.0 for index members, 0.5 for Cboe-only lines).
 */
export type UniverseInstrumentTuple = readonly [
  instrumentId: number,
  ticker: string,
  marketSector: MarketSector,
  exchCode: string,
  name: string,
  assetClass: AssetClass,
  searchWeight: number,
  status: number,
];

/** `[code, name, aliases, tier]` — the 38 functions and their aliases (`IB` → `MSG`). */
export type UniverseFunctionTuple = readonly [
  code: string,
  name: string,
  aliases: readonly string[],
  tier: number,
];

/** `[personId, name, roleFirm]` — `roleFirm` is the rendered `'CFO · Apple Inc'` form. */
export type UniversePersonTuple = readonly [personId: number, name: string, roleFirm: string];

/** `[code, name]` — `['FED', 'Federal Reserve']`. */
export type UniverseTopicTuple = readonly [code: string, name: string];

/**
 * The payload of `GET /api/v1/universe/snapshot` (API.md §5.2). `version` is the sha1 of the
 * content and doubles as the `ETag`; `generatedAt` is an ISO-8601 instant.
 *
 * Option contracts are deliberately absent (3.5 k per underlying): they are reached through `OMON`
 * or by typing the OCC / `AAPL 9/16/26 C245 Equity` form, which the server resolves
 * (FUNCTIONS.md §3.1 L871-873).
 */
export interface UniverseSnapshot {
  version: string;
  generatedAt: string;
  instruments: readonly UniverseInstrumentTuple[];
  functions: readonly UniverseFunctionTuple[];
  people: readonly UniversePersonTuple[];
  topics: readonly UniverseTopicTuple[];
}

/* -------------------------------------------------------------------------------------------- */
/* Universe entry (the indexed form, FUNCTIONS.md §3.1 L885)                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * One row of `UniverseIndex.entries`: everything the ranker needs about a candidate, already
 * upper-cased and split, with no optional-property gymnastics at query time.
 *
 * Fields that do not apply to a kind are `''`, `null` or `0` rather than absent, so that the shape
 * is monomorphic: a single hidden class for 45 k objects is the difference between a 6 MB index and
 * a much larger one, and it keeps property access on the hot path polymorphism-free.
 */
export interface UniverseEntry {
  kind: CandidateKind;
  /** Stable identity: `instrumentId`/`personId` stringified, or the function/topic code. */
  id: string;
  /** Numeric instrument id, or `null` for non-instruments (`ctx.watchlistIds` is numeric). */
  instrumentId: number | null;
  /** The rendered first line: `'AAPL US Equity'`, `'GP'`, `'Jane Doe (Demo Capital)'`, `'FED'`. */
  primary: string;
  /** The rendered second line: `'Apple Inc · Common Stock · US'`, `'Price graph'`, … */
  secondary: string;
  /** Instruments: the upper-cased ticker (`'AAPL'`). Empty for every other kind. */
  upperTicker: string;
  /** Functions and topics: the upper-cased code (`'GP'`, `'FED'`). Empty otherwise. */
  upperCode: string;
  /** Upper-cased function aliases (`['IB']` for `MSG`). Empty for every other kind. */
  upperAliases: readonly string[];
  /** The raw name (`'Apple Inc.'`, `'Price graph'`, `'Jane Doe'`, `'Federal Reserve'`). */
  name: string;
  /** The name split into upper-cased word tokens (`['APPLE', 'INC']`); drives the word index. */
  nameWords: readonly string[];
  marketSector: MarketSector | null;
  assetClass: AssetClass | null;
  /** `'US'`, `'INDEX'`, … for instruments; `''` otherwise. */
  exchCode: string;
  /** Instruments: `searchWeight`. Functions: `4 - tier` (tier 1 → 3 … tier 3 → 1). Else `1`. */
  weight: number;
  /** Functions: the catalogue tier. `null` for every other kind. */
  tier: Tier | null;
  /** `1` active, `0` otherwise; only instruments are ever inactive. */
  status: number;
}

/**
 * The MRU key used by `RankContext.mru` and `UniverseIndex`: `` `${kind}:${id}` ``.
 *
 * Declared here rather than in `command/index.ts` because both the ranker and whatever persists the
 * MRU (`web/src/command/localIndex.ts`) have to agree on it, and neither should import the index
 * just to build a string.
 */
export function mruKey(kind: CandidateKind, id: string): string {
  return `${kind}:${id}`;
}
