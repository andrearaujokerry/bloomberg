/**
 * `UniverseIndex` — the local structure autocomplete searches (FUNCTIONS.md §3.1 L865-893,
 * WORKPLAN L596-597).
 *
 * It is built from a `UniverseSnapshot` that is handed in (`GET /api/v1/universe/snapshot`,
 * produced by WP-08's `server/src/search/snapshot.ts`); this file does no IO, reads no clock and
 * imports nothing outside `@terminal/core`, so the same index runs in the browser Worker
 * (`web/src/command/localIndex.ts`), in Node on the server and in a test.
 *
 * The division of labour with `command/rank.ts` is deliberate: this file owns the *structures*
 * (which entries can possibly match `q`), `rank.ts` owns the *arithmetic* (how good each match is).
 * The §3.5 budget — tokenize + parse + rank ≤ 4 ms p95 over 45 k entries — is met by the
 * structures, not by the scoring: every lookup below is O(log n + hits) or O(1), nothing here is a
 * scan of `entries`, and nothing here upper-cases, splits or concatenates a string at query time.
 *
 * | Structure | Purpose | Lookup |
 * | --- | --- | --- |
 * | `entries` | flat array of every candidate | by index |
 * | `tickerKeys` / `tickerEntries` | instrument tickers, sorted | binary search on a prefix |
 * | `codeKeys` / `codeEntries` | function codes, function aliases and topic codes, sorted | binary search |
 * | `wordIndex` | 3-char prefix of every name word → entries | `get(prefix3)`, filter on the full prefix |
 * | `trigrams` | trigram → text units of notable entries | union of the query's postings, Jaccard |
 * | `mru` | recency boost | O(1) |
 *
 * Two deliberate deviations from the §3.1 table, both documented at their definition:
 *
 *  - `wordIndex` is keyed by `min(3, len)` characters, and a second, much smaller `shortWordIndex`
 *    covers 1- and 2-character prefixes over notable entries only, so that `wordPrefix('GE')` is
 *    not silently empty. Keying every 1- and 2-character prefix of all 45 k rows would cost ~1 MB
 *    of postings and would hand the ranker thousands of rows for a single keystroke.
 *  - the trigram postings address *text units* (ticker, code, alias, full name, each long name
 *    word) rather than entries, so Jaccard is computed per field and an entry scores its best
 *    field. Comparing a 5-trigram query against the 22 trigrams of `'MICROSOFT CORPORATION'` as
 *    one bag would put every real typo below the 0.4 floor of §3.3.
 *
 * Nothing here throws on arbitrary input (QA-05): every query method normalises what it is given
 * and returns an empty result rather than raising.
 */

import type { Tier } from '../functions/manifest.js';
import type {
  CandidateKind,
  MruRank,
  MruRecord,
  UniverseEntry,
  UniverseFunctionTuple,
  UniverseInstrumentTuple,
  UniversePersonTuple,
  UniverseSnapshot,
  UniverseTopicTuple,
} from '../search/types.js';
import { mruKey } from '../search/types.js';
import type { AssetClass, MarketSector } from '../types/instrument.js';

/* ---------------------------------------------------------------------------------------------- */
/* Tunables — the thresholds §3.3 and §3.1 fix                                                      */
/* ---------------------------------------------------------------------------------------------- */

/** Jaccard floor for a trigram match: `s ∈ [0.4, 1] → 40·s` (FUNCTIONS.md §3.3 L946). */
export const TRIGRAM_MIN_SCORE = 0.4;

/** Trigrams are consulted only from three characters up (FUNCTIONS.md §3.1 L889, §3.3 L946). */
export const TRIGRAM_MIN_QUERY_LENGTH = 3;

/** …and only when the prefix structures produced fewer than five hits (FUNCTIONS.md §3.1 L889). */
export const TRIGRAM_PREFIX_HIT_THRESHOLD = 5;

/** Default cap on the rows `trigramSearch` returns; `rank()` keeps at most 12 anyway (§3.3). */
export const TRIGRAM_DEFAULT_LIMIT = 12;

/** `terminal.mru` holds at most 50 rows (FUNCTIONS.md §3.1 L878). */
export const MRU_MAX = 50;

/** Only the 20 most recent MRU rows earn the recency term (FUNCTIONS.md §3.3 L951). */
export const MRU_RANKED = 20;

/** The recency term at rank 0 (FUNCTIONS.md §3.3 L951: `+15·(1 − rank/20)`). */
export const MRU_RECENCY_MAX = 15;

/** `+1 per 10 uses, max +5` (FUNCTIONS.md §3.3 L951). */
export const MRU_USE_BONUS_MAX = 5;

/** The word index keys this many leading characters of each name word (FUNCTIONS.md §3.1 L888). */
export const WORD_KEY_LENGTH = 3;

/** An entry is "notable" — trigram-indexed, short-word-indexed — per FUNCTIONS.md §3.1 L889. */
export const NOTABLE_MIN_WEIGHT = 2;

/** At most this many trigram text units per entry, so one long name cannot dominate the postings. */
const MAX_UNITS_PER_ENTRY = 8;

/* ---------------------------------------------------------------------------------------------- */
/* Results                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** One hit from `codePrefix`/`codeExact`: `alias` separates code-exact (100) from alias-exact (92). */
export interface CodeHit {
  /** Index into `entries`. */
  entry: number;
  /** The upper-cased key that matched — the canonical code, or the alias as typed. */
  key: string;
  /** `true` when `key` is a function alias rather than the canonical code. */
  alias: boolean;
}

/** One hit from `trigramSearch`: `score` is the Jaccard similarity of the entry's best field. */
export interface TrigramHit {
  /** Index into `entries`. */
  entry: number;
  /** Jaccard similarity in `[0, 1]`; `rank()` turns it into `40·score`. */
  score: number;
}

/** What `ParseEnv.lookupTicker` (CONTRACTS §4.1 L688) returns, shaped for the parser. */
export interface TickerLookupHit {
  instrumentId: number;
  assetClass: AssetClass;
  marketSector: MarketSector;
  display: string;
}

/** Options for `UniverseIndex.build`. */
export interface BuildOptions {
  /** The persisted MRU (`terminal.mru`, ≤ 50 rows); order does not matter, `lastUsed` does. */
  mru?: readonly MruRecord[];
}

/* ---------------------------------------------------------------------------------------------- */
/* Text normalisation — shared by the word index, the trigram index and every query                 */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Word characters are letters and digits in any script; everything else separates. `'Apple Inc.'`
 * → `['APPLE', 'INC']`, `'AT&T Inc'` → `['AT', 'T', 'INC']`, `'Jane Doe'` → `['JANE', 'DOE']`.
 */
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/** Upper-case and split into word tokens. Never throws; a non-string argument yields `[]`. */
export function normalizeWords(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const words = text.toUpperCase().replace(NON_WORD, ' ').trim();
  if (words.length === 0) return [];
  return words.split(' ');
}

/**
 * The trigram set of a text, pg_trgm style: each word is padded with two leading and one trailing
 * space and cut into 3-grams, so `'GE'` → `['  G', ' GE', 'GE ']` and short words still produce
 * trigrams. The result is sorted and unique, which is what `jaccard` expects.
 */
export function trigramsOf(text: string): string[] {
  const words = normalizeWords(text);
  if (words.length === 0) return [];
  const set = new Set<string>();
  for (const word of words) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) set.add(padded.slice(i, i + 3));
  }
  return [...set].sort();
}

/**
 * Jaccard similarity `|A ∩ B| / |A ∪ B|` of two sorted, unique trigram arrays. Two empty sets are
 * similarity 0 (not 1): an empty query must never match everything.
 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let i = 0;
  let j = 0;
  let inter = 0;
  while (i < a.length && j < b.length) {
    const x = a[i]!;
    const y = b[j]!;
    if (x === y) {
      inter += 1;
      i += 1;
      j += 1;
    } else if (x < y) i += 1;
    else j += 1;
  }
  const union = a.length + b.length - inter;
  return union === 0 ? 0 : inter / union;
}

/* ---------------------------------------------------------------------------------------------- */
/* Entry construction from the snapshot tuples                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Exchange codes that are internal placeholders rather than a real listing venue: they are never
 * rendered into the display form, so `SPX` is `'SPX Index'` and `AAPL` is `'AAPL US Equity'`.
 */
const PSEUDO_EXCH_CODES = new Set(['', 'GOVT', 'INDEX', 'FX', 'RATE', 'ECON', 'CRYPTO', 'NONE']);

/** The `secondary` middle segment: `'Apple Inc · Common Stock · US'` (FUNCTIONS.md §3.2 L902). */
const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  equity: 'Common Stock',
  etf: 'ETF',
  index: 'Index',
  fx: 'Currency',
  govt: 'Government',
  option: 'Option',
  future: 'Future',
  crypto: 'Crypto',
  rate: 'Rate',
  econ: 'Economic Series',
};

const isString = (v: unknown): v is string => typeof v === 'string';
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** `'AAPL US Equity'`, `'SPX Index'`, `'EURUSD Curncy'`, `'912797VE4 Govt'`. */
function instrumentPrimary(ticker: string, sector: MarketSector, exchCode: string): string {
  const exch = PSEUDO_EXCH_CODES.has(exchCode.toUpperCase()) ? '' : exchCode;
  return exch.length > 0 ? `${ticker} ${exch} ${sector}` : `${ticker} ${sector}`;
}

function instrumentSecondary(name: string, assetClass: AssetClass, exchCode: string): string {
  const parts = [name, ASSET_CLASS_LABEL[assetClass] ?? assetClass];
  if (!PSEUDO_EXCH_CODES.has(exchCode.toUpperCase())) parts.push(exchCode);
  return parts.join(' · ');
}

function toTier(value: unknown): Tier | null {
  return value === 1 || value === 2 || value === 3 ? value : null;
}

function entryFromInstrument(t: UniverseInstrumentTuple): UniverseEntry | null {
  const [instrumentId, ticker, marketSector, exchCode, name, assetClass, searchWeight, status] = t;
  if (!isFiniteNumber(instrumentId) || !isString(ticker) || ticker.length === 0) return null;
  const sector = isString(marketSector) ? marketSector : 'Equity';
  const cls = isString(assetClass) ? assetClass : 'equity';
  const exch = isString(exchCode) ? exchCode : '';
  const label = isString(name) ? name : '';
  const upperTicker = ticker.toUpperCase();
  return {
    kind: 'instrument',
    id: String(instrumentId),
    instrumentId,
    primary: instrumentPrimary(ticker, sector, exch),
    secondary: instrumentSecondary(label, cls, exch),
    upperTicker,
    upperCode: '',
    upperAliases: [],
    name: label,
    nameWords: normalizeWords(label),
    marketSector: sector,
    assetClass: cls,
    exchCode: exch,
    weight: isFiniteNumber(searchWeight) ? searchWeight : 1,
    tier: null,
    status: status === 0 ? 0 : 1,
  };
}

function entryFromFunction(t: UniverseFunctionTuple): UniverseEntry | null {
  const [code, name, aliases, tier] = t;
  if (!isString(code) || code.length === 0) return null;
  const upperCode = code.toUpperCase();
  const upperAliases = (Array.isArray(aliases) ? aliases : [])
    .filter(isString)
    .map((a) => a.toUpperCase())
    .filter((a) => a.length > 0 && a !== upperCode);
  const label = isString(name) ? name : '';
  const t3 = toTier(tier);
  return {
    kind: 'function',
    id: upperCode,
    instrumentId: null,
    primary: upperCode,
    secondary: label,
    upperTicker: '',
    upperCode,
    upperAliases,
    name: label,
    nameWords: normalizeWords(label),
    marketSector: null,
    assetClass: null,
    exchCode: '',
    // FUNCTIONS.md §3.3 L949 scores functions off `tier`; `weight` keeps the same ordering sense as
    // an instrument's `searchWeight` (higher is more important) for the shared posting order.
    weight: t3 === null ? 1 : 4 - t3,
    tier: t3,
    status: 1,
  };
}

function entryFromPerson(t: UniversePersonTuple): UniverseEntry | null {
  const [personId, name, roleFirm] = t;
  if (!isFiniteNumber(personId) || !isString(name) || name.length === 0) return null;
  const role = isString(roleFirm) ? roleFirm : '';
  // `roleFirm` renders as `'CFO · Apple Inc'`; the firm is what the primary line parenthesises.
  const firm = role.includes('·') ? role.slice(role.indexOf('·') + 1).trim() : '';
  return {
    kind: 'person',
    id: String(personId),
    instrumentId: null,
    primary: firm.length > 0 ? `${name} (${firm})` : name,
    secondary: role,
    upperTicker: '',
    upperCode: '',
    upperAliases: [],
    name,
    nameWords: normalizeWords(name),
    marketSector: null,
    assetClass: null,
    exchCode: '',
    weight: 1,
    tier: null,
    status: 1,
  };
}

function entryFromTopic(t: UniverseTopicTuple): UniverseEntry | null {
  const [code, name] = t;
  if (!isString(code) || code.length === 0) return null;
  const upperCode = code.toUpperCase();
  const label = isString(name) ? name : '';
  return {
    kind: 'topic',
    id: upperCode,
    instrumentId: null,
    primary: upperCode,
    secondary: label,
    upperTicker: '',
    upperCode,
    upperAliases: [],
    name: label,
    nameWords: normalizeWords(label),
    marketSector: null,
    assetClass: null,
    exchCode: '',
    weight: 1,
    tier: null,
    status: 1,
  };
}

/** `true` for the ≈ 700 rows §3.1 L889 keeps in the trigram (and short-word) structures. */
function isNotable(e: UniverseEntry): boolean {
  return e.kind !== 'instrument' || e.weight >= NOTABLE_MIN_WEIGHT;
}

/* ---------------------------------------------------------------------------------------------- */
/* Binary search over a sorted key array                                                            */
/* ---------------------------------------------------------------------------------------------- */

/** First index whose key is `>= prefix`; `keys.length` when there is none. */
function lowerBound(keys: readonly string[], prefix: string): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid]! < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * First index at or after `from` whose key does *not* start with `prefix`. Sound because UTF-16
 * code-unit order puts every string carrying a given prefix in one contiguous block.
 */
function prefixUpperBound(keys: readonly string[], prefix: string, from: number): number {
  let lo = from;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid]!.startsWith(prefix)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const EMPTY_U32 = new Uint32Array(0);

/* ---------------------------------------------------------------------------------------------- */
/* UniverseIndex                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

export class UniverseIndex {
  readonly #version: string;
  readonly #generatedAt: string;
  readonly #entries: readonly UniverseEntry[];

  /** Instrument tickers, ascending; `#tickerEntries[i]` is the entry `#tickerKeys[i]` belongs to. */
  readonly #tickerKeys: string[];
  readonly #tickerEntries: Uint32Array;

  /** Function codes, function aliases and topic codes, ascending. */
  readonly #codeKeys: string[];
  readonly #codeEntries: Uint32Array;
  readonly #codeAlias: Uint8Array;

  /** `min(3, len)`-character prefix of every name word → entries, best-first. */
  readonly #wordIndex: Map<string, Uint32Array>;
  /** 1- and 2-character prefixes, notable entries only (see the header note). */
  readonly #shortWordIndex: Map<string, Uint32Array>;

  /** Trigram → text-unit postings, plus the unit → entry and unit → |trigrams| side tables. */
  readonly #trigrams: Map<string, Uint32Array>;
  readonly #unitEntry: Uint32Array;
  readonly #unitSize: Uint16Array;
  /** Query scratch: a generation stamp avoids clearing `#unitCount` between queries. */
  readonly #unitCount: Int32Array;
  readonly #unitStamp: Int32Array;
  #generation = 0;

  /** `instrumentId` → index into `entries`, for watchlist and MRU rehydration. */
  readonly #byInstrumentId: Map<number, number>;

  /** Entry order for postings: weight desc, then `primary` asc — `#order[i]` is entry `i`'s place. */
  readonly #order: Uint32Array;

  #mruRecords: MruRecord[] = [];
  #mru = new Map<string, MruRank>();

  private constructor(
    version: string,
    generatedAt: string,
    entries: readonly UniverseEntry[],
    mru: readonly MruRecord[],
  ) {
    this.#version = version;
    this.#generatedAt = generatedAt;
    this.#entries = entries;
    const n = entries.length;

    // ── posting order: weight desc, primary asc, index asc ────────────────────────────────────
    const byImportance = new Uint32Array(n);
    for (let i = 0; i < n; i += 1) byImportance[i] = i;
    const importance = Array.from(byImportance).sort((a, b) => {
      const ea = entries[a]!;
      const eb = entries[b]!;
      if (ea.weight !== eb.weight) return eb.weight - ea.weight;
      if (ea.primary !== eb.primary) return ea.primary < eb.primary ? -1 : 1;
      return a - b;
    });
    this.#order = new Uint32Array(n);
    for (let place = 0; place < importance.length; place += 1) {
      this.#order[importance[place]!] = place;
    }
    const byOrder = (a: number, b: number): number => this.#order[a]! - this.#order[b]!;

    // ── ticker array ──────────────────────────────────────────────────────────────────────────
    const tickerPairs: number[] = [];
    for (let i = 0; i < n; i += 1) {
      if (entries[i]!.upperTicker.length > 0) tickerPairs.push(i);
    }
    tickerPairs.sort((a, b) => {
      const ka = entries[a]!.upperTicker;
      const kb = entries[b]!.upperTicker;
      if (ka !== kb) return ka < kb ? -1 : 1;
      return byOrder(a, b);
    });
    this.#tickerKeys = tickerPairs.map((i) => entries[i]!.upperTicker);
    this.#tickerEntries = Uint32Array.from(tickerPairs);

    // ── code array (codes, aliases, topic codes) ──────────────────────────────────────────────
    const codePairs: { key: string; entry: number; alias: boolean }[] = [];
    for (let i = 0; i < n; i += 1) {
      const e = entries[i]!;
      if (e.upperCode.length > 0) codePairs.push({ key: e.upperCode, entry: i, alias: false });
      for (const a of e.upperAliases) codePairs.push({ key: a, entry: i, alias: true });
    }
    codePairs.sort((x, y) => {
      if (x.key !== y.key) return x.key < y.key ? -1 : 1;
      if (x.alias !== y.alias) return x.alias ? 1 : -1;
      return byOrder(x.entry, y.entry);
    });
    this.#codeKeys = codePairs.map((p) => p.key);
    this.#codeEntries = Uint32Array.from(codePairs, (p) => p.entry);
    this.#codeAlias = Uint8Array.from(codePairs, (p) => (p.alias ? 1 : 0));

    // ── word index ────────────────────────────────────────────────────────────────────────────
    const wordBuckets = new Map<string, Set<number>>();
    const shortBuckets = new Map<string, Set<number>>();
    for (let i = 0; i < n; i += 1) {
      const e = entries[i]!;
      const notable = isNotable(e);
      for (const word of e.nameWords) {
        const key = word.slice(0, WORD_KEY_LENGTH);
        let bucket = wordBuckets.get(key);
        if (bucket === undefined) {
          bucket = new Set<number>();
          wordBuckets.set(key, bucket);
        }
        bucket.add(i);
        if (!notable) continue;
        for (let k = 1; k < WORD_KEY_LENGTH && k <= word.length; k += 1) {
          const shortKey = word.slice(0, k);
          let short = shortBuckets.get(shortKey);
          if (short === undefined) {
            short = new Set<number>();
            shortBuckets.set(shortKey, short);
          }
          short.add(i);
        }
      }
    }
    this.#wordIndex = freezeBuckets(wordBuckets, byOrder);
    this.#shortWordIndex = freezeBuckets(shortBuckets, byOrder);

    // ── trigram index over the text units of notable entries ──────────────────────────────────
    const unitEntry: number[] = [];
    const unitSize: number[] = [];
    const trigramBuckets = new Map<string, number[]>();
    for (let i = 0; i < n; i += 1) {
      const e = entries[i]!;
      if (!isNotable(e)) continue;
      for (const text of unitTexts(e)) {
        const grams = trigramsOf(text);
        if (grams.length === 0) continue;
        const unit = unitEntry.length;
        unitEntry.push(i);
        unitSize.push(grams.length);
        for (const g of grams) {
          const posting = trigramBuckets.get(g);
          if (posting === undefined) trigramBuckets.set(g, [unit]);
          else posting.push(unit);
        }
      }
    }
    this.#unitEntry = Uint32Array.from(unitEntry);
    this.#unitSize = Uint16Array.from(unitSize, (s) => Math.min(s, 0xffff));
    this.#unitCount = new Int32Array(unitEntry.length);
    this.#unitStamp = new Int32Array(unitEntry.length);
    this.#trigrams = new Map<string, Uint32Array>();
    for (const [gram, posting] of trigramBuckets)
      this.#trigrams.set(gram, Uint32Array.from(posting));

    // ── instrument id lookup ──────────────────────────────────────────────────────────────────
    this.#byInstrumentId = new Map<number, number>();
    for (let i = 0; i < n; i += 1) {
      const id = entries[i]!.instrumentId;
      if (id !== null && !this.#byInstrumentId.has(id)) this.#byInstrumentId.set(id, i);
    }

    this.setMru(mru);
  }

  /**
   * Build an index from a snapshot. O(n log n) and allocation-bounded: ≈ 45 k entries build in well
   * under the 300 ms Worker budget of §3.5. Malformed rows are skipped rather than thrown on, so a
   * stale or truncated snapshot degrades instead of breaking the command line.
   */
  static build(snapshot: UniverseSnapshot, options: BuildOptions = {}): UniverseIndex {
    const entries: UniverseEntry[] = [];
    const push = (e: UniverseEntry | null): void => {
      if (e !== null) entries.push(e);
    };
    for (const t of snapshot?.instruments ?? []) push(entryFromInstrument(t));
    for (const t of snapshot?.functions ?? []) push(entryFromFunction(t));
    for (const t of snapshot?.people ?? []) push(entryFromPerson(t));
    for (const t of snapshot?.topics ?? []) push(entryFromTopic(t));
    return new UniverseIndex(
      isString(snapshot?.version) ? snapshot.version : '',
      isString(snapshot?.generatedAt) ? snapshot.generatedAt : '',
      entries,
      options.mru ?? [],
    );
  }

  /** The index the shell uses before the snapshot has arrived: every lookup returns nothing. */
  static empty(): UniverseIndex {
    return new UniverseIndex('', '', [], []);
  }

  /** The snapshot version, which is also its `ETag` (API.md §5.2). */
  get version(): string {
    return this.#version;
  }

  /** The snapshot's ISO-8601 build instant. */
  get generatedAt(): string {
    return this.#generatedAt;
  }

  /** Number of indexed entries. */
  get size(): number {
    return this.#entries.length;
  }

  /** The flat entry array; every lookup below returns indexes into it. */
  get entries(): readonly UniverseEntry[] {
    return this.#entries;
  }

  /** The entry at `i`, or `undefined` when `i` is out of range. */
  entryAt(i: number): UniverseEntry | undefined {
    return this.#entries[i];
  }

  /* -- prefix lookups ------------------------------------------------------------------------- */

  /**
   * Entries whose ticker starts with `query`, in ascending ticker order (ties: weight desc). The
   * returned array is a **view** into the index — read it, never mutate it. O(log n + hits).
   */
  tickerPrefix(query: string, limit?: number): Uint32Array {
    const q = upperQuery(query);
    if (q.length === 0) return EMPTY_U32;
    const lo = lowerBound(this.#tickerKeys, q);
    if (lo >= this.#tickerKeys.length || !this.#tickerKeys[lo]!.startsWith(q)) {
      return EMPTY_U32;
    }
    const hi = prefixUpperBound(this.#tickerKeys, q, lo);
    const end = limit !== undefined && limit >= 0 ? Math.min(hi, lo + limit) : hi;
    return this.#tickerEntries.subarray(lo, end);
  }

  /** Entries whose ticker equals `query` exactly (several when one ticker lists twice). */
  tickerExact(query: string): Uint32Array {
    const q = upperQuery(query);
    if (q.length === 0) return EMPTY_U32;
    const lo = lowerBound(this.#tickerKeys, q);
    let hi = lo;
    while (hi < this.#tickerKeys.length && this.#tickerKeys[hi] === q) hi += 1;
    return hi === lo ? EMPTY_U32 : this.#tickerEntries.subarray(lo, hi);
  }

  /**
   * Function codes, function aliases and topic codes starting with `query`. Tiny (≈ 70 keys), so
   * this returns objects: the ranker needs to know whether the canonical code or an alias matched.
   */
  codePrefix(query: string, limit?: number): CodeHit[] {
    const q = upperQuery(query);
    if (q.length === 0) return [];
    const lo = lowerBound(this.#codeKeys, q);
    if (lo >= this.#codeKeys.length || !this.#codeKeys[lo]!.startsWith(q)) return [];
    const hi = prefixUpperBound(this.#codeKeys, q, lo);
    const end = limit !== undefined && limit >= 0 ? Math.min(hi, lo + limit) : hi;
    const out: CodeHit[] = [];
    for (let i = lo; i < end; i += 1) {
      out.push({
        entry: this.#codeEntries[i]!,
        key: this.#codeKeys[i]!,
        alias: this.#codeAlias[i] === 1,
      });
    }
    return out;
  }

  /** Codes and aliases equal to `query` — the R0 rule of §3.3 L923 asks exactly this question. */
  codeExact(query: string): CodeHit[] {
    const q = upperQuery(query);
    if (q.length === 0) return [];
    const lo = lowerBound(this.#codeKeys, q);
    const out: CodeHit[] = [];
    for (let i = lo; i < this.#codeKeys.length && this.#codeKeys[i] === q; i += 1) {
      out.push({
        entry: this.#codeEntries[i]!,
        key: q,
        alias: this.#codeAlias[i] === 1,
      });
    }
    return out;
  }

  /**
   * Entries with a name word starting with `query` — leading or not, so `'HOSP'` finds
   * `Apple Hospitality REIT` (FUNCTIONS.md §3.1 L888). Results are best-first (weight desc, then
   * `primary`). Queries shorter than three characters search the notable subset only.
   */
  wordPrefix(query: string, limit?: number): Uint32Array {
    const q = upperQuery(query);
    if (q.length === 0) return EMPTY_U32;
    const bucket =
      q.length >= WORD_KEY_LENGTH
        ? this.#wordIndex.get(q.slice(0, WORD_KEY_LENGTH))
        : this.#shortWordIndex.get(q);
    if (bucket === undefined) return EMPTY_U32;
    // The bucket is keyed on the first three characters; a longer query still has to be checked.
    const cap = limit !== undefined && limit >= 0 ? limit : bucket.length;
    if (cap === 0) return EMPTY_U32;
    const out: number[] = [];
    for (let i = 0; i < bucket.length && out.length < cap; i += 1) {
      const idx = bucket[i]!;
      const words = this.#entries[idx]!.nameWords;
      for (const w of words) {
        if (w.startsWith(q)) {
          out.push(idx);
          break;
        }
      }
    }
    if (out.length === bucket.length && cap >= bucket.length) return bucket;
    return Uint32Array.from(out);
  }

  /** Does a name word of this entry start with `query`, and is it the *first* word (score 60 vs 50)? */
  matchesFirstWord(entry: number, query: string): boolean {
    const q = upperQuery(query);
    if (q.length === 0) return false;
    const e = this.#entries[entry];
    if (e === undefined) return false;
    return e.nameWords[0]?.startsWith(q) === true;
  }

  /* -- trigram fallback ----------------------------------------------------------------------- */

  /**
   * §3.1 L889 / §3.3 L946: trigrams are consulted only when the prefix structures produced fewer
   * than five hits and the query is at least three characters long.
   */
  shouldUseTrigrams(query: string, prefixHits: number): boolean {
    return (
      upperQuery(query).length >= TRIGRAM_MIN_QUERY_LENGTH &&
      prefixHits < TRIGRAM_PREFIX_HIT_THRESHOLD
    );
  }

  /**
   * Fuzzy fallback over the notable subset: the union of the query's trigram postings, each text
   * unit scored by Jaccard, each entry keeping its best unit. Returns hits at or above `minScore`
   * (default `TRIGRAM_MIN_SCORE` = 0.4), best first.
   */
  trigramSearch(query: string, options?: { minScore?: number; limit?: number }): TrigramHit[] {
    const minScore = options?.minScore ?? TRIGRAM_MIN_SCORE;
    const limit = options?.limit ?? TRIGRAM_DEFAULT_LIMIT;
    if (limit <= 0) return [];
    const qt = trigramsOf(query);
    if (qt.length === 0) return [];

    this.#generation += 1;
    const gen = this.#generation;
    const touched: number[] = [];
    for (const gram of qt) {
      const posting = this.#trigrams.get(gram);
      if (posting === undefined) continue;
      for (const unit of posting) {
        if (this.#unitStamp[unit] === gen) {
          this.#unitCount[unit] = this.#unitCount[unit]! + 1;
        } else {
          this.#unitStamp[unit] = gen;
          this.#unitCount[unit] = 1;
          touched.push(unit);
        }
      }
    }

    const best = new Map<number, number>();
    for (const unit of touched) {
      const inter = this.#unitCount[unit]!;
      const size = this.#unitSize[unit]!;
      const union = qt.length + size - inter;
      if (union <= 0) continue;
      const score = inter / union;
      if (score < minScore) continue;
      const entry = this.#unitEntry[unit]!;
      const prev = best.get(entry);
      if (prev === undefined || score > prev) best.set(entry, score);
    }

    const hits: TrigramHit[] = [];
    for (const [entry, score] of best) hits.push({ entry, score });
    hits.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return this.#order[a.entry]! - this.#order[b.entry]!;
    });
    return hits.length > limit ? hits.slice(0, limit) : hits;
  }

  /* -- identity lookups ----------------------------------------------------------------------- */

  /** The entry index for an `instrumentId`, or `-1`. */
  entryOfInstrument(instrumentId: number): number {
    return this.#byInstrumentId.get(instrumentId) ?? -1;
  }

  /** The entry index for a function or topic code (canonical or alias), or `-1`. */
  entryOfCode(code: string): number {
    const hits = this.codeExact(code);
    const first = hits[0];
    return first === undefined ? -1 : first.entry;
  }

  /**
   * `ParseEnv.lookupTicker` (CONTRACTS §4.1 L688): the instruments whose ticker equals
   * `tokens.join(' ')`, case-insensitively, optionally narrowed by exchange code or sector.
   */
  lookupTicker(
    tokens: readonly string[],
    opts?: { exchCode?: string; sector?: MarketSector },
  ): TickerLookupHit[] {
    if (!Array.isArray(tokens) || tokens.length === 0) return [];
    const joined = tokens.filter(isString).join(' ');
    const hits = this.tickerExact(joined);
    if (hits.length === 0) return [];
    const wantExch = opts?.exchCode?.toUpperCase();
    const wantSector = opts?.sector;
    const out: TickerLookupHit[] = [];
    for (const hit of hits) {
      const e = this.#entries[hit];
      if (e?.instrumentId == null) continue;
      if (wantExch !== undefined && e.exchCode.toUpperCase() !== wantExch) continue;
      if (wantSector !== undefined && e.marketSector !== wantSector) continue;
      out.push({
        instrumentId: e.instrumentId,
        assetClass: e.assetClass ?? 'equity',
        marketSector: e.marketSector ?? 'Equity',
        display: e.primary,
      });
    }
    return out;
  }

  /* -- MRU ------------------------------------------------------------------------------------ */

  /** The MRU as `RankContext.mru` wants it: `` `${kind}:${id}` `` → `{ rank, count }`. */
  get mru(): ReadonlyMap<string, MruRank> {
    return this.#mru;
  }

  /** The persisted rows, most recent first — what `web` writes back to `localStorage`. */
  get mruRecords(): readonly MruRecord[] {
    return this.#mruRecords;
  }

  /** `{ rank, count }` for a candidate, or `undefined` when it is not in the MRU. */
  mruOf(kind: CandidateKind, id: string): MruRank | undefined {
    return this.#mru.get(mruKey(kind, id));
  }

  /**
   * The recency term of §3.3 L951: `+15·(1 − rank/20)` for the 20 most recent rows, else 0, plus
   * `+1` per 10 uses capped at `+5`.
   */
  mruBoost(kind: CandidateKind, id: string): number {
    const hit = this.#mru.get(mruKey(kind, id));
    if (hit === undefined) return 0;
    const recency = hit.rank < MRU_RANKED ? MRU_RECENCY_MAX * (1 - hit.rank / MRU_RANKED) : 0;
    const uses = Math.min(MRU_USE_BONUS_MAX, Math.floor(Math.max(0, hit.count) / 10));
    return recency + uses;
  }

  /** Replace the MRU: rows are ordered by `lastUsed` descending and the first 50 are kept. */
  setMru(records: readonly MruRecord[]): void {
    const rows = (Array.isArray(records) ? records : [])
      .filter(
        (r): r is MruRecord =>
          r !== null &&
          typeof r === 'object' &&
          isString((r as MruRecord).id) &&
          isFiniteNumber((r as MruRecord).lastUsed),
      )
      .slice()
      .sort((a, b) => {
        if (a.lastUsed !== b.lastUsed) return b.lastUsed - a.lastUsed;
        return mruKey(a.kind, a.id) < mruKey(b.kind, b.id) ? -1 : 1;
      });
    const kept: MruRecord[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const key = mruKey(r.kind, r.id);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(r);
      if (kept.length >= MRU_MAX) break;
    }
    this.#mruRecords = kept;
    this.#mru = new Map<string, MruRank>();
    for (let i = 0; i < kept.length; i += 1) {
      const r = kept[i]!;
      this.#mru.set(mruKey(r.kind, r.id), {
        rank: i,
        count: isFiniteNumber(r.count) ? r.count : 0,
      });
    }
  }

  /**
   * Record a use. The caller supplies `atMs` — `packages/core` has no ambient clock (ARCHITECTURE
   * L49), so the shell passes `clock.now()`.
   */
  noteUse(kind: CandidateKind, id: string, atMs: number): void {
    const key = mruKey(kind, id);
    const next: MruRecord[] = [];
    let count = 0;
    for (const r of this.#mruRecords) {
      if (mruKey(r.kind, r.id) === key) count = r.count;
      else next.push(r);
    }
    next.push({ kind, id, lastUsed: atMs, count: count + 1 });
    this.setMru(next);
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Build helpers                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

/** Upper-case a query defensively: never throws, and trims the whitespace a keystroke leaves. */
function upperQuery(query: string): string {
  if (typeof query !== 'string' || query.length === 0) return '';
  return query.trim().toUpperCase();
}

/** Turn `Map<string, Set<number>>` buckets into sorted, best-first `Uint32Array` postings. */
function freezeBuckets(
  buckets: Map<string, Set<number>>,
  byOrder: (a: number, b: number) => number,
): Map<string, Uint32Array> {
  const out = new Map<string, Uint32Array>();
  for (const [key, set] of buckets) {
    const arr = [...set].sort(byOrder);
    out.set(key, Uint32Array.from(arr));
  }
  return out;
}

/**
 * The texts a trigram match may be computed against: the ticker or code, each alias, the whole
 * name, and each name word of three characters or more when the name has several. Scoring each
 * field separately is what keeps a real typo above the 0.4 floor (see the header note).
 */
function unitTexts(e: UniverseEntry): string[] {
  const texts: string[] = [];
  const add = (t: string): void => {
    if (t.length > 0 && !texts.includes(t) && texts.length < MAX_UNITS_PER_ENTRY) texts.push(t);
  };
  if (e.upperTicker.length > 0) add(e.upperTicker);
  if (e.upperCode.length > 0) add(e.upperCode);
  for (const a of e.upperAliases) add(a);
  if (e.nameWords.length > 0) {
    add(e.nameWords.join(' '));
    if (e.nameWords.length > 1) {
      for (const w of e.nameWords) if (w.length >= WORD_KEY_LENGTH) add(w);
    }
  }
  return texts;
}
