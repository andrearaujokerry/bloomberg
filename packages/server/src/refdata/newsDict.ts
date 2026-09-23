/**
 * The news matcher dictionary — PROVIDERS §11.3.1 (L2576-2594), WORKPLAN §WP-04 L704 and §18.7.
 *
 * WP-09's `news/entityLink.ts` resolves stories to issuers, instruments and topics with precision
 * over recall (NEWS-02: nothing below confidence 0.90 is ever written). It needs five lookup maps
 * over the whole security master, and it needs them **once per run**, not once per story: a
 * 400-story RSS poll would otherwise issue 400 × 5 queries and — worse — could see the master
 * change underneath it half way through, so two stories in one run would be linked against
 * different worlds. `buildNewsDict()` takes one snapshot at `(validAt, knownAt)` and hands back an
 * immutable dictionary; the run is then reproducible from that pair alone.
 *
 * Every exclusion here exists because the alternative is a wrong link on a user's own holding:
 *
 * | Map | Source | Dropped |
 * | --- | --- | --- |
 * | `ciks` | `identifiers` scheme `CIK`, issuer rows | a CIK claimed by two issuers |
 * | `tickers` | live `equity`/`etf` instruments | **a ticker naming more than one live instrument is removed entirely** — an ambiguous ticker links to nothing rather than to a coin flip |
 * | `names` | `issuers.name` through `normName` | shorter than `MIN_NAME_LENGTH`; any name two issuers share |
 * | `aliases` | `issuer_aliases` (`former_name`, `short_name`, `brand`, `curated`) + `issuers.former_names` | as for names |
 * | `topicKeywords` | `topics.keywords` | a keyword shared by two topics |
 *
 * {@link NewsDictionary.isAmbiguous} is the sixth thing the matcher asks, and it is **not** a map.
 * It answers "can this surface form identify an issuer on its own?", and its rule is structural:
 * **one word is never enough**. Every single-token surface — `APPLE`, `TARGET`, `BUDGET`, `WORLD`,
 * `AAPL` alike — is ambiguous and must be corroborated by something else in the story before it may
 * be linked. `ambiguousWords` survives underneath that rule as curation for *multi-token* surfaces
 * and as documentation of the collisions the recorded feeds actually contain; it is no longer what
 * carries precision. See {@link AMBIGUOUS_WORDS} for why the enumeration could not carry it.
 *
 * Normalisation is `core/text/normName.ts` and nothing else — the same function
 * `refdata/resolve.ts` uses for its name fallback, so "the same name" means one thing in this
 * system (§18.7).
 */

import { sql } from 'drizzle-orm';

import { foldName, normName } from '@terminal/core';

import type { AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What a ticker resolves to: the live composite instrument and the issuer behind it. */
export interface TickerTarget {
  instrumentId: number;
  issuerId: number;
  ticker: string;
}

export interface NewsDictStats {
  ciks: number;
  tickers: number;
  ambiguousTickers: number;
  names: number;
  droppedNames: number;
  aliases: number;
  droppedAliases: number;
  topicKeywords: number;
}

/**
 * The snapshot. Every map is read-only: a matcher must not be able to teach the dictionary
 * something half way through a run.
 */
export interface NewsDictionary {
  /** The `(validAt, knownAt)` the snapshot was taken at — the run is reproducible from it. */
  readonly asOf: AsOf;
  /** Padded CIK → `issuerId`. */
  readonly ciks: ReadonlyMap<string, number>;
  /** Upper-cased ticker → the live instrument, ambiguous ones already removed. */
  readonly tickers: ReadonlyMap<string, TickerTarget>;
  /** The tickers that were removed, kept for diagnostics and for `dq_events`. */
  readonly ambiguousTickers: ReadonlySet<string>;
  /** `normName(issuer.name)` → `issuerId`. */
  readonly names: ReadonlyMap<string, number>;
  /** `normName(alias)` → `issuerId`. */
  readonly aliases: ReadonlyMap<string, number>;
  /** Upper-cased keyword → `topicId`. */
  readonly topicKeywords: ReadonlyMap<string, number>;
  /** The curated multi-token additions to the structural rule, normalised (§11.3.3). */
  readonly ambiguousWords: ReadonlySet<string>;
  readonly stats: NewsDictStats;

  /**
   * `true` when this surface form cannot identify an issuer on its own and needs corroboration.
   *
   * **Every one-word surface is ambiguous**, whatever the word is. That is the whole rule for
   * single tokens: not "every word on a list", which is an enumeration precision may not rest on
   * (see {@link AMBIGUOUS_WORDS}), but every word there is. A multi-token surface is ambiguous only
   * when data ops have said so — {@link AMBIGUOUS_WORDS} plus
   * {@link BuildNewsDictOptions.extraAmbiguousWords}.
   *
   * The input is folded first (`core/text/normName.ts`), so `'Apple Inc.'` is two tokens and
   * `' apple '` is one; the caller may pass a raw surface or a normalised key.
   */
  isAmbiguous(surface: string): boolean;
  /** The issuer a normalised surface form names, by exact name then alias. `null` when none. */
  lookupName(surface: string): { issuerId: number; method: 'name_exact' | 'name_alias' } | null;
  /** The live instrument a marked ticker names. `null` for an unknown or ambiguous ticker. */
  lookupTicker(ticker: string): TickerTarget | null;
  /** The issuer a CIK names, in any spelling of the CIK. */
  lookupCik(cik: string | number): number | null;
  /** The topic a keyword names. */
  lookupTopic(keyword: string): number | null;
}

/** PROVIDERS §11.3.1: "a normalised name under 5 characters is dropped". */
export const MIN_NAME_LENGTH = 5;

/** `issuer_aliases.kind` values the matcher trusts. `ticker` aliases are not names. */
export const ALIAS_KINDS = ['former_name', 'short_name', 'brand', 'curated'] as const;

export interface BuildNewsDictOptions {
  /** Alias kinds to load; defaults to `ALIAS_KINDS`. */
  aliasKinds?: readonly string[];
  /** Extra words to treat as ambiguous (data-ops curation, REF-10). */
  extraAmbiguousWords?: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The ambiguous-word list
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * English words, financial abbreviations and country codes that are also live US tickers or issuer
 * names. Each entry is a real collision: `ALL` (Allstate), `KEY` (KeyCorp), `GAP` (The Gap),
 * `ON` (ON Semiconductor), `IT` (Gartner), `CAT` (Caterpillar), `SO` (Southern Company),
 * `LOW` (Lowe's), `ALLY` (Ally Financial), `WELL` (Welltower), `PLAY` (Dave & Buster's),
 * `FAST` (Fastenal), `OPEN` (Opendoor), `HOOD` (Robinhood), `RUN` (Sunrun), `SAVE` (Spirit),
 * `CAR` (Avis), `TRIP` (TripAdvisor), `EAT` (Brinker), `WOOF` (Petco), `FUN` (Cedar Fair).
 *
 * **This list is no longer what makes the matcher precise, and it never could have been.** It was:
 * a single-token `name_exact` scored 0.95 × 0.95 = 0.9025 and was written unless the word appeared
 * here, so precision held only for the 253 words somebody had thought of. `TARGET`, `BLOCK`,
 * `MATCH`, `SQUARE`, `SHELL`, `TOTAL`, `BUDGET`, `OUTLOOK`, `UNITY` and `CARVANA` are ordinary
 * English words that are also issuer names and are on no list here — and on the recorded feeds that
 * filed *"Sri Lanka's Growth Misses Forecast"* under Outlook Group Corp, because its summary says
 * "clouding the outlook". An enumeration whose incompleteness costs *precision* is not a
 * mechanism; there are more English words than anyone will enumerate. So the rule became
 * structural — {@link NewsDictionary.isAmbiguous} calls **every** one-word surface ambiguous — and
 * what is left here is curation: a record of the collisions the recorded feeds contain, a lever for
 * data ops to mark a *multi-token* phrase ambiguous through
 * {@link BuildNewsDictOptions.extraAmbiguousWords} (§11.3.5's 50-link daily sample), and a set the
 * single-token rule now subsumes entirely. Its incompleteness costs recall, never precision.
 */
export const AMBIGUOUS_WORDS: readonly string[] = Object.freeze([
  // Live tickers that are ordinary words.
  'ALL',
  'ALLY',
  'ARE',
  'BEST',
  'BIG',
  'BILL',
  'BLD',
  'BOOM',
  'BOX',
  'BRO',
  'CAKE',
  'CALM',
  'CAR',
  'CARS',
  'CASH',
  'CAT',
  'CHEF',
  'CLEAN',
  'CODE',
  'COIN',
  'COLD',
  'COOK',
  'COST',
  'CUBE',
  'DASH',
  'DATA',
  'DAY',
  'DINE',
  'DOC',
  'DOG',
  'DOOR',
  'DRIVE',
  'EAT',
  'EDIT',
  'ELF',
  'EYE',
  'FAST',
  'FIVE',
  'FIX',
  'FLOW',
  'FOLD',
  'FOR',
  'FORM',
  'FOUR',
  'FREE',
  'FUEL',
  'FUN',
  'GAIN',
  'GAP',
  'GLAD',
  'GOOD',
  'GOLD',
  'GREEN',
  'GROW',
  'HAS',
  'HEAR',
  'HELP',
  'HIGH',
  'HIT',
  'HOME',
  'HOOD',
  'HOPE',
  'HOT',
  'HOUR',
  'HUGE',
  'HUM',
  'ICE',
  'IMAX',
  'INN',
  'IT',
  'JACK',
  'JOB',
  'JOBS',
  'JOE',
  'KEY',
  'KEYS',
  'KIND',
  'LAB',
  'LAND',
  'LAW',
  'LAZY',
  'LIFE',
  'LIGHT',
  'LINE',
  'LINK',
  'LIVE',
  'LOAN',
  'LOCK',
  'LOGIC',
  'LONG',
  'LOOP',
  'LOVE',
  'LOW',
  'LUCK',
  'MAIN',
  'MAN',
  'MANY',
  'MAP',
  'MARK',
  'MASS',
  'MAX',
  'MEAL',
  'MEET',
  'MIND',
  'MOVE',
  'MOVIE',
  'NEAR',
  'NEW',
  'NEWS',
  'NEXT',
  'NICE',
  'NIGHT',
  'NOW',
  'OFF',
  'OIL',
  'OLD',
  'ON',
  'ONE',
  'OPEN',
  'OPTION',
  'OUT',
  'OWN',
  'PACK',
  'PARK',
  'PATH',
  'PAY',
  'PEAK',
  'PLAN',
  'PLAY',
  'PLUS',
  'POST',
  'POWER',
  'PURE',
  'PUSH',
  'RACE',
  'RAIL',
  'RARE',
  'REAL',
  'RIDE',
  'RISE',
  'ROAD',
  'ROCK',
  'ROOT',
  'RUN',
  'RUSH',
  'SAFE',
  'SAIL',
  'SAVE',
  'SEAT',
  'SEE',
  'SELL',
  'SHIP',
  'SHOP',
  'SHOT',
  'SIGN',
  'SITE',
  'SIX',
  'SKY',
  'SLOW',
  'SNAP',
  'SO',
  'SOLO',
  'SOUND',
  'SPOT',
  'STAR',
  'STAY',
  'STEP',
  'STOP',
  'STORE',
  'SUN',
  'SURE',
  'SWAP',
  'TAKE',
  'TALK',
  'TAP',
  'TEAM',
  'TECH',
  'TELL',
  'TEN',
  'THE',
  'THINK',
  'TIME',
  'TINY',
  'TOP',
  'TOUR',
  'TOWN',
  'TREE',
  'TRIP',
  'TRUE',
  'TRUST',
  'TURN',
  'TWO',
  'VERY',
  'VIEW',
  'VOTE',
  'WAIT',
  'WALK',
  'WALL',
  'WANT',
  'WARM',
  'WASH',
  'WATCH',
  'WAVE',
  'WAY',
  'WELL',
  'WEST',
  'WIN',
  'WIND',
  'WISE',
  'WOOD',
  'WOOF',
  'WORK',
  'WORLD',
  'YELL',
  'YES',
  'ZOOM',
  // Financial abbreviations and macro terms that read as tickers.
  'AI',
  'API',
  'ATM',
  'BID',
  'BPS',
  'CAP',
  'CDS',
  'CEO',
  'CFO',
  'CPI',
  'DEBT',
  'EPS',
  'ESG',
  'ETF',
  'EV',
  'FED',
  'FOMC',
  'FX',
  'GDP',
  'GAAP',
  'IPO',
  'IRR',
  'LBO',
  'M&A',
  'NAV',
  'OPEC',
  'PPI',
  'ROE',
  'ROI',
  'SEC',
  'SPAC',
  'TIPS',
  'YIELD',
  // Country and region codes that are also tickers or read as prose.
  'EU',
  'UK',
  'US',
  'USA',
  'UAE',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the dictionary from the master as of `(validAt, knownAt)`. Five queries, all as-of, all
 * in the caller's transaction.
 */
export async function buildNewsDict(
  tx: Tx,
  at: AsOf,
  options: BuildNewsDictOptions = {},
): Promise<NewsDictionary> {
  const validAt = at.validAt;
  const knownAt = at.knownAt;

  // ── CIKs ──────────────────────────────────────────────────────────────────────────────────
  const cikRows = await tx.execute<{ value: string; entity_id: string }>(sql`
    SELECT value, entity_id
      FROM identifiers
     WHERE scheme = 'CIK'
       AND entity_kind = 'issuer'
       AND bt_as_of(valid_from, valid_to, tx_from, tx_to, ${validAt}::timestamptz, ${knownAt}::timestamptz)`);

  const ciks = new Map<string, number>();
  const cikConflicts = new Set<string>();
  for (const row of cikRows.rows) {
    const cik = row.value.trim();
    const issuerId = Number(row.entity_id);
    const seen = ciks.get(cik);
    if (seen !== undefined && seen !== issuerId) cikConflicts.add(cik);
    else ciks.set(cik, issuerId);
  }
  for (const cik of cikConflicts) ciks.delete(cik);

  // ── tickers ───────────────────────────────────────────────────────────────────────────────
  const tickerRows = await tx.execute<{
    ticker: string;
    instrument_id: string;
    issuer_id: string;
  }>(sql`
    SELECT upper(i.ticker) AS ticker, i.instrument_id, s.issuer_id
      FROM instruments i
      JOIN issues s
        ON s.issue_id = i.issue_id
       AND bt_as_of(s.valid_from, s.valid_to, s.tx_from, s.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
     WHERE i.asset_class IN ('equity', 'etf')
       AND i.status = 'active'
       AND bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)`);

  const tickers = new Map<string, TickerTarget>();
  const ambiguousTickers = new Set<string>();
  for (const row of tickerRows.rows) {
    const ticker = row.ticker.trim();
    if (ticker.length === 0) continue;
    const instrumentId = Number(row.instrument_id);
    const seen = tickers.get(ticker);
    if (seen !== undefined && seen.instrumentId !== instrumentId) {
      // More than one live instrument answers to this ticker: link to neither (§11.3.1).
      ambiguousTickers.add(ticker);
      continue;
    }
    tickers.set(ticker, { instrumentId, issuerId: Number(row.issuer_id), ticker });
  }
  for (const ticker of ambiguousTickers) tickers.delete(ticker);

  // ── issuer names ──────────────────────────────────────────────────────────────────────────
  const issuerRows = await tx.execute<{
    issuer_id: string;
    name: string;
    former_names: unknown;
  }>(sql`
    SELECT issuer_id, name, former_names
      FROM issuers
     WHERE bt_as_of(valid_from, valid_to, tx_from, tx_to, ${validAt}::timestamptz, ${knownAt}::timestamptz)`);

  const names = new Map<string, number>();
  const droppedNames = new Set<string>();
  const aliasPairs: { alias: string; issuerId: number }[] = [];

  for (const row of issuerRows.rows) {
    const issuerId = Number(row.issuer_id);
    addUnique(names, droppedNames, normName(row.name), issuerId);
    for (const former of formerNames(row.former_names)) {
      aliasPairs.push({ alias: former, issuerId });
    }
  }

  // ── aliases ───────────────────────────────────────────────────────────────────────────────
  const kinds = options.aliasKinds ?? ALIAS_KINDS;
  const aliasRows = await tx.execute<{ issuer_id: string; alias: string }>(sql`
    SELECT issuer_id, alias
      FROM issuer_aliases
     WHERE kind IN (${sql.join(
       kinds.map((k) => sql`${k}`),
       sql`, `,
     )})`);
  for (const row of aliasRows.rows) {
    aliasPairs.push({ alias: row.alias, issuerId: Number(row.issuer_id) });
  }

  const aliases = new Map<string, number>();
  const droppedAliases = new Set<string>();
  for (const pair of aliasPairs) {
    addUnique(aliases, droppedAliases, normName(pair.alias), pair.issuerId);
  }
  // An alias that is already an exact issuer name adds nothing and would only lower the
  // confidence of a match the `names` map already scores at 0.95.
  for (const key of aliases.keys()) {
    if (names.has(key)) aliases.delete(key);
  }

  // ── topic keywords ────────────────────────────────────────────────────────────────────────
  const topicRows = await tx.execute<{ topic_id: string; keyword: string }>(sql`
    SELECT t.topic_id, upper(k) AS keyword
      FROM topics t, unnest(t.keywords) AS k`);

  const topicKeywords = new Map<string, number>();
  const topicConflicts = new Set<string>();
  for (const row of topicRows.rows) {
    const keyword = row.keyword.trim();
    if (keyword.length === 0) continue;
    const topicId = Number(row.topic_id);
    const seen = topicKeywords.get(keyword);
    if (seen !== undefined && seen !== topicId) topicConflicts.add(keyword);
    else topicKeywords.set(keyword, topicId);
  }
  for (const keyword of topicConflicts) topicKeywords.delete(keyword);

  // ── the dictionary ────────────────────────────────────────────────────────────────────────
  const ambiguousWords = new Set<string>(
    [...AMBIGUOUS_WORDS, ...(options.extraAmbiguousWords ?? [])]
      .map((w) => w.trim().toUpperCase())
      .filter((w) => w.length > 0),
  );

  const stats: NewsDictStats = {
    ciks: ciks.size,
    tickers: tickers.size,
    ambiguousTickers: ambiguousTickers.size,
    names: names.size,
    droppedNames: droppedNames.size,
    aliases: aliases.size,
    droppedAliases: droppedAliases.size,
    topicKeywords: topicKeywords.size,
  };

  return {
    asOf: { validAt, knownAt },
    ciks,
    tickers,
    ambiguousTickers,
    names,
    aliases,
    topicKeywords,
    ambiguousWords,
    stats,
    isAmbiguous(surface: string): boolean {
      const folded = foldName(surface);
      if (folded.length === 0) return false;
      // One word is never enough on its own — whatever the word is. The list below it only ever
      // adds multi-token phrases data ops have flagged.
      if (!folded.includes(' ')) return true;
      return ambiguousWords.has(folded);
    },
    lookupName(surface: string) {
      const key = normName(surface);
      if (key.length < MIN_NAME_LENGTH) return null;
      const exact = names.get(key);
      if (exact !== undefined) return { issuerId: exact, method: 'name_exact' as const };
      const alias = aliases.get(key);
      if (alias !== undefined) return { issuerId: alias, method: 'name_alias' as const };
      return null;
    },
    lookupTicker(ticker: string): TickerTarget | null {
      return tickers.get(ticker.trim().toUpperCase()) ?? null;
    },
    lookupCik(cik: string | number): number | null {
      const digits = String(cik).trim().replace(/^0+/, '');
      if (digits.length === 0 || digits.length > 10) return null;
      return ciks.get(digits.padStart(10, '0')) ?? null;
    },
    lookupTopic(keyword: string): number | null {
      return topicKeywords.get(keyword.trim().toUpperCase()) ?? null;
    },
  };
}

/**
 * Add `key → id`, dropping the key entirely when a second, different id claims it, and dropping
 * anything shorter than `MIN_NAME_LENGTH`. Precision over recall, in five lines.
 */
function addUnique(map: Map<string, number>, dropped: Set<string>, key: string, id: number): void {
  if (key.length < MIN_NAME_LENGTH) {
    if (key.length > 0) dropped.add(key);
    return;
  }
  if (dropped.has(key)) return;
  const seen = map.get(key);
  if (seen === undefined) {
    map.set(key, id);
    return;
  }
  if (seen !== id) {
    map.delete(key);
    dropped.add(key);
  }
}

/** `issuers.former_names` is `[{name, from, to}]` jsonb; anything else is ignored. */
function formerNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      out.push(entry);
      continue;
    }
    if (entry !== null && typeof entry === 'object' && 'name' in entry) {
      const name = (entry as { name: unknown }).name;
      if (typeof name === 'string') out.push(name);
    }
  }
  return out;
}
