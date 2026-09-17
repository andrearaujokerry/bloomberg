// packages/core/src/command/rank.ts — WP-03 (WORKPLAN L604-605).
//
// `rank(query, index, ctx, registry)` is FUNCTIONS.md §3.3 (L918-962) implemented literally: the
// four hard rules R0-R3, the six additive score terms, the three-level tie-break, the per-kind cap
// and the twelve-row cut. The same function runs on the client (against the locally built
// `UniverseIndex`) and on the server (`server/src/search/rank.ts`, WP-08), which is why every
// number below is a named constant rather than a literal buried in an expression: the two sides
// have to agree exactly or the list reorders when the server response arrives (§3.4 L964-968).
//
// Two invariants the rest of the terminal leans on:
//
//   * Row 0 is what `GO` executes. `parse()` and `rank()` share this function, so a candidate the
//     hard rule R0 elects is *moved* to index 0 rather than given an artificial score — the score a
//     row carries is always the score §3.3 computes for it, and only the ORDER encodes R0.
//   * `rank()` never throws. It is called on every keystroke with whatever is in the command line,
//     and QA-05 fuzzes it. A non-string query, a `null` context field or an index built from a
//     malformed snapshot yields `[]`, never an exception.
//
// What this file deliberately does NOT do: the Yahoo fallback (§3.4) is a server concern; hits that
// arrive with `source:'yahoo'` are merged by the caller under the same scoring, so the `−25`
// penalty and its "never above a local hit with match ≥ 60" clamp live here as exported constants
// and are applied by `scoreOf` to whatever source a candidate carries, but the local index only
// ever produces `source:'local'`.

import type { AnyFunctionManifest } from '../functions/manifest.js';
import type { FunctionRegistry } from '../functions/registry.js';
import type {
  Candidate,
  CandidateKind,
  CandidateSource,
  HighlightRange,
  MatchedOn,
  MruRank,
  RankContext,
  UniverseEntry,
} from '../search/types.js';
import { mruKey } from '../search/types.js';
import type { AssetClass, MarketSector } from '../types/instrument.js';

import {
  MRU_RANKED,
  MRU_RECENCY_MAX,
  MRU_USE_BONUS_MAX,
  TRIGRAM_MIN_SCORE,
  UniverseIndex,
} from './index.js';
import { sectorAllowsAssetClass } from './sectors.js';

/* ---------------------------------------------------------------------------------------------- */
/* Constants — FUNCTIONS.md §3.3 L940-956                                                           */
/* ---------------------------------------------------------------------------------------------- */

/** `rank()` returns at most this many rows (§3.2 L918, §3.3 L959). */
export const MAX_RESULTS = 12;

/** At most this many rows of one kind, unless the other kinds are empty (§3.3 L959). */
export const MAX_PER_KIND = 8;

/** R3: below two characters, people and topics are excluded; below one, the list is empty. */
export const MIN_QUERY_FOR_PEOPLE_AND_TOPICS = 2;

/** match — function code exact / alias exact / code-or-alias prefix, with its length decay and floor. */
export const MATCH_CODE_EXACT = 100;
export const MATCH_ALIAS_EXACT = 92;
export const MATCH_CODE_PREFIX_BASE = 80;
export const MATCH_CODE_PREFIX_DECAY = 2;
export const MATCH_CODE_PREFIX_FLOOR = 62;

/** match — instrument ticker. */
export const MATCH_TICKER_EXACT = 100;
export const MATCH_TICKER_PREFIX_BASE = 80;
export const MATCH_TICKER_PREFIX_DECAY = 2;
export const MATCH_TICKER_PREFIX_FLOOR = 60;

/** match — names. */
export const MATCH_NAME_FIRST_WORD = 60;
export const MATCH_NAME_OTHER_WORD = 50;
export const MATCH_PERSON_NAME_WORD = 50;
export const MATCH_TOPIC_CODE_PREFIX = 60;
export const MATCH_TOPIC_NAME_WORD = 45;

/** match — trigram fallback: Jaccard `s ∈ [0.4, 1]` scores `40·s`. */
export const MATCH_TRIGRAM_FACTOR = 40;

/** The `match ≥ 60` a local hit needs for the yahoo clamp of §3.3 L955. */
export const LOCAL_HIT_MATCH_FLOOR = 60;

/** kindPrior. */
export const KIND_PRIOR_FUNCTION_APPLICABLE = 12;
export const KIND_PRIOR_FUNCTION_WRONG_CLASS = -20;
export const KIND_PRIOR_FUNCTION_NEEDS_SECURITY = -4;
export const KIND_PRIOR_INSTRUMENT = 0;
export const KIND_PRIOR_PERSON = -8;
export const KIND_PRIOR_TOPIC = -6;

/** popularity. */
export const POPULARITY_INSTRUMENT_FACTOR = 5;
export const POPULARITY_INSTRUMENT_MAX = 10;
export const POPULARITY_FUNCTION_BY_TIER: Readonly<Record<1 | 2 | 3, number>> = Object.freeze({
  1: 6,
  2: 3,
  3: 0,
});

/** context. */
export const CONTEXT_WATCHLIST = 8;
export const CONTEXT_SAME_ISSUER = 4;

/** context — the sector default, applied only to a ticker match with no sector typed (§3.3 L953). */
export const SECTOR_DEFAULT_BONUS: Readonly<Partial<Record<MarketSector, number>>> = Object.freeze({
  Equity: 4,
  Index: 3,
  Curncy: 2,
  Govt: 2,
  Crypto: 1,
});

/** penalties. */
export const PENALTY_INACTIVE = -30;
export const PENALTY_YAHOO = -25;

/** Kind order for the last tie-break (§3.3 L957). */
export const KIND_ORDER: Readonly<Record<CandidateKind, number>> = Object.freeze({
  instrument: 0,
  function: 1,
  topic: 2,
  person: 3,
});

/* ---------------------------------------------------------------------------------------------- */
/* Candidate-set caps                                                                               */
/* ---------------------------------------------------------------------------------------------- */
//
// A one-character query can touch thousands of tickers; scoring all of them would blow the ≤ 4 ms
// p95 budget of §3.5 for no benefit, because only twelve rows survive. The caps below bound the
// work per keystroke. They are safe rather than arbitrary: `tickerPrefix` hands back the prefix
// block in ascending ticker order, and among strings sharing a prefix the SHORTEST sort first,
// which is exactly the order the ticker-prefix match term rewards (`80 − 2·(len − len(q))`). The
// rows a cap can drop are therefore rows whose match term is already at its floor, and the only
// terms that could lift one back into the top twelve (popularity ≤ 10, recency ≤ 20) cannot span
// the gap over hundreds of better-matching rows.

/** Ticker-prefix rows scored per keystroke. */
export const TICKER_PREFIX_LIMIT = 512;

/** Word-index rows scored per keystroke. */
export const WORD_PREFIX_LIMIT = 256;

/** Code rows scored per keystroke (the code array holds ≈ 70 keys in total). */
export const CODE_PREFIX_LIMIT = 64;

/** Trigram rows scored per keystroke, when the fallback runs at all. */
export const TRIGRAM_LIMIT = 24;

/* ---------------------------------------------------------------------------------------------- */
/* Small helpers                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

const isString = (v: unknown): v is string => typeof v === 'string';

/** Upper-case and trim a query defensively; a non-string yields `''`. */
function normalizeQuery(query: unknown): string {
  if (!isString(query) || query.length === 0) return '';
  return query.trim().toUpperCase();
}

/**
 * Applicability, exactly as R0 states it (§3.3 L923-924): `'none' | 'any'`, or the panel security's
 * asset class is in the list, or the panel is empty and the function does not require a security.
 */
export function isFunctionApplicable(
  manifest: Pick<AnyFunctionManifest, 'assetClasses' | 'requiresSecurity'>,
  panelAssetClass: AssetClass | null,
): boolean {
  const classes = manifest.assetClasses;
  if (classes === 'none' || classes === 'any') return true;
  if (panelAssetClass !== null) {
    return Array.isArray(classes) && classes.includes(panelAssetClass);
  }
  return manifest.requiresSecurity !== true;
}

/** The panel's asset class, or `null` when the panel holds no security. */
function panelAssetClassOf(ctx: RankContext): AssetClass | null {
  if (ctx.hasPanelSecurity === false) return null;
  const security = ctx.panel?.security ?? null;
  return security === null ? null : (security.assetClass ?? null);
}

/** The first token of a panel security's display form: `'AAPL US Equity'` → `'AAPL'`. */
function panelTicker(ctx: RankContext): string {
  const display = ctx.panel?.security?.display;
  if (!isString(display)) return '';
  const space = display.indexOf(' ');
  return (space < 0 ? display : display.slice(0, space)).toUpperCase();
}

/** `'BRK/A'` → `'BRK'`: share classes and dual listings share an issuer root. */
function tickerRoot(ticker: string): string {
  const cut = ticker.search(/[/.\- ]/);
  return cut < 0 ? ticker : ticker.slice(0, cut);
}

/**
 * The `+4 same issuer as the panel security` term (§3.3 L952). Without issuer ids in the snapshot
 * (API.md §5.2 carries no issuer column) this recognises the two cases the snapshot *does* express:
 * a second listing of the same ticker and a share class of the same root (`BRK/A` ↔ `BRK/B`). The
 * ETF ↔ index proxy pairing named in the spec needs issuer data the client does not hold and is
 * applied server-side, where `issuer_aliases` is available; scoring it here would need a table this
 * package cannot see, and guessing it would reorder rows differently on the two sides.
 */
function isSameIssuer(entry: UniverseEntry, ctx: RankContext): boolean {
  if (entry.kind !== 'instrument') return false;
  const panel = panelTicker(ctx);
  if (panel.length === 0) return false;
  const panelId = ctx.panel?.security?.instrumentId ?? null;
  if (panelId !== null && entry.instrumentId === panelId) return false;
  const root = tickerRoot(panel);
  return root.length > 0 && tickerRoot(entry.upperTicker) === root;
}

/** The recency term of §3.3 L951, read from `ctx.mru` (`{ rank, count }`, rank 0 = most recent). */
export function recencyBoost(ctx: RankContext, kind: CandidateKind, id: string): number {
  const mru = ctx.mru;
  if (!(mru instanceof Map)) return 0;
  const hit = mru.get(mruKey(kind, id));
  if (hit === undefined) return 0;
  const rank = typeof hit.rank === 'number' && Number.isFinite(hit.rank) ? hit.rank : MRU_RANKED;
  const count = typeof hit.count === 'number' && Number.isFinite(hit.count) ? hit.count : 0;
  const recency = rank >= 0 && rank < MRU_RANKED ? MRU_RECENCY_MAX * (1 - rank / MRU_RANKED) : 0;
  const uses = Math.min(MRU_USE_BONUS_MAX, Math.floor(Math.max(0, count) / 10));
  return recency + uses;
}

/** Highlight ranges in `primary`: the one occurrence of the query, or none when it is not there. */
function highlightsOf(primary: string, q: string): HighlightRange[] {
  if (q.length === 0 || primary.length === 0) return [];
  const at = primary.toUpperCase().indexOf(q);
  return at < 0 ? [] : [[at, at + q.length]];
}

/** `'Jane Doe'` → `'jane.doe'`, the handle `MSG` takes (§3.2 L909). */
function personHandle(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0);
  return words.join('.');
}

/**
 * What `GO` executes for a row (§3.2 L909).
 *
 * For a function matched through an alias this is the ALIAS, not the canonical code: §3.3's result
 * assembly says row 0 is exactly `parse(text)[0]`'s leading candidate, `parse` keeps the alias
 * (`fn.alias`) and `toRunRequest` applies the manifest's `aliasParams` from it. Emitting `CRVF` for
 * a row the user reached by typing `ICVS` would launch the same screen with `params {}` — a blank
 * curve instead of SOFR OIS — so the row would execute something other than what it shows.
 */
function insertTextOf(
  entry: UniverseEntry,
  registry: FunctionRegistry | undefined,
  matchedOn: MatchedOn,
  matchedText: string | undefined,
): string {
  switch (entry.kind) {
    case 'function': {
      if (matchedOn === 'alias' && matchedText !== undefined && matchedText.length > 0) {
        return matchedText.toUpperCase();
      }
      const canonical = registry?.canonical?.(entry.upperCode);
      return isString(canonical) && canonical.length > 0 ? canonical : entry.primary;
    }
    case 'person':
      return `MSG ${personHandle(entry.name)}`;
    case 'topic':
      return `NI ${entry.upperCode}`;
    default:
      return entry.primary;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Scoring                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** One entry with the best match term found for it, before the additive terms are applied. */
interface Hit {
  entry: UniverseEntry;
  match: number;
  matchedOn: MatchedOn;
  /**
   * The key the match was found under, when it is not the entry's own code — the alias the user is
   * typing. `insertText` needs it: an alias is a different command from its canonical code, not a
   * different spelling of it (`ICVS` carries `aliasParams { curveId: 'SOFR_OIS' }`).
   */
  matchedText?: string;
}

/** A scored row, carrying the sort keys the tie-break needs. */
interface Scored extends Hit {
  score: number;
  applicable: boolean | null;
  source: CandidateSource;
}

/** The `kindPrior` term (§3.3 L947-948). */
export function kindPrior(
  kind: CandidateKind,
  manifest: AnyFunctionManifest | undefined,
  panelAssetClass: AssetClass | null,
): number {
  switch (kind) {
    case 'function': {
      if (manifest === undefined) return KIND_PRIOR_FUNCTION_APPLICABLE;
      if (isFunctionApplicable(manifest, panelAssetClass)) return KIND_PRIOR_FUNCTION_APPLICABLE;
      if (panelAssetClass !== null) return KIND_PRIOR_FUNCTION_WRONG_CLASS;
      return KIND_PRIOR_FUNCTION_NEEDS_SECURITY;
    }
    case 'person':
      return KIND_PRIOR_PERSON;
    case 'topic':
      return KIND_PRIOR_TOPIC;
    default:
      return KIND_PRIOR_INSTRUMENT;
  }
}

/** The `popularity` term (§3.3 L949-950). */
export function popularity(entry: UniverseEntry, manifest: AnyFunctionManifest | undefined): number {
  if (entry.kind === 'instrument') {
    const weight = Number.isFinite(entry.weight) ? entry.weight : 1;
    return Math.min(POPULARITY_INSTRUMENT_MAX, POPULARITY_INSTRUMENT_FACTOR * Math.max(0, weight));
  }
  if (entry.kind === 'function') {
    const tier = manifest?.tier ?? entry.tier;
    if (tier === 1 || tier === 2 || tier === 3) return POPULARITY_FUNCTION_BY_TIER[tier];
    return 0;
  }
  return 0;
}

/** The `context` term (§3.3 L952-953). */
function contextBonus(hit: Hit, ctx: RankContext): number {
  const entry = hit.entry;
  let bonus = 0;
  if (
    entry.kind === 'instrument' &&
    entry.instrumentId !== null &&
    ctx.watchlistIds instanceof Set &&
    ctx.watchlistIds.has(entry.instrumentId)
  ) {
    bonus += CONTEXT_WATCHLIST;
  }
  if (isSameIssuer(entry, ctx)) bonus += CONTEXT_SAME_ISSUER;
  if (ctx.sectorGiven === undefined && hit.matchedOn === 'ticker' && entry.marketSector !== null) {
    bonus += SECTOR_DEFAULT_BONUS[entry.marketSector] ?? 0;
  }
  return bonus;
}

/** The `penalties` term (§3.3 L954-955). */
function penalties(entry: UniverseEntry, source: CandidateSource): number {
  let p = 0;
  if (entry.kind === 'instrument' && entry.status !== 1) p += PENALTY_INACTIVE;
  if (source === 'yahoo') p += PENALTY_YAHOO;
  return p;
}

/** `score(c) = match + kindPrior + popularity + recency + context − penalties` (§3.3 L940). */
function scoreOf(
  hit: Hit,
  ctx: RankContext,
  registry: FunctionRegistry | undefined,
  panelAssetClass: AssetClass | null,
  source: CandidateSource,
): Scored {
  const entry = hit.entry;
  const manifest =
    entry.kind === 'function' ? tryGetManifest(registry, entry.upperCode) : undefined;
  const score =
    hit.match +
    kindPrior(entry.kind, manifest, panelAssetClass) +
    popularity(entry, manifest) +
    recencyBoost(ctx, entry.kind, entry.id) +
    contextBonus(hit, ctx) +
    penalties(entry, source);
  return {
    ...hit,
    score,
    applicable:
      entry.kind === 'function'
        ? manifest === undefined || isFunctionApplicable(manifest, panelAssetClass)
        : null,
    source,
  };
}

function tryGetManifest(
  registry: FunctionRegistry | undefined,
  code: string,
): AnyFunctionManifest | undefined {
  if (registry === undefined || typeof registry.get !== 'function') return undefined;
  try {
    return registry.get(code);
  } catch {
    return undefined;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Tie-breaks                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * §3.3 L957: score desc, then shorter `primary`, then `primary` alphabetical, then
 * `instrument < function < topic < person`. The final `id` comparison is not in the spec; it is
 * there because two rows can be equal on all four keys (the same ticker listed twice) and a sort
 * that is not a total order is not reproducible between the client and the server.
 */
export function compareCandidates(
  a: Pick<Candidate, 'score' | 'primary' | 'kind' | 'id'>,
  b: Pick<Candidate, 'score' | 'primary' | 'kind' | 'id'>,
): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.primary.length !== b.primary.length) return a.primary.length - b.primary.length;
  if (a.primary !== b.primary) return a.primary < b.primary ? -1 : 1;
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareScored(a: Scored, b: Scored): number {
  return compareCandidates(
    { score: a.score, primary: a.entry.primary, kind: a.entry.kind, id: a.entry.id },
    { score: b.score, primary: b.entry.primary, kind: b.entry.kind, id: b.entry.id },
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* rank()                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Score the token being completed against the universe and return at most twelve rows, best first
 * (FUNCTIONS.md §3.3). Never throws.
 */
export function rank(
  query: string,
  index: UniverseIndex,
  ctx: RankContext,
  registry: FunctionRegistry,
): Candidate[] {
  const q = normalizeQuery(query);
  // R3, second half: below one character there is nothing to complete.
  if (q.length === 0) return [];
  if (!(index instanceof UniverseIndex)) return [];
  const context = normalizeContext(ctx);
  const allowed = allowedKinds(q, context);
  if (allowed.size === 0) return [];

  const panelAssetClass = panelAssetClassOf(context);
  const hits = collect(q, index, context, allowed);
  if (hits.size === 0) return [];

  const scored: Scored[] = [];
  for (const hit of hits.values()) {
    scored.push(scoreOf(hit, context, registry, panelAssetClass, 'local'));
  }
  scored.sort(compareScored);

  const chosen = applyKindCap(scored);
  const rows = chosen.map((s) => toCandidate(s, q, registry));
  return promoteRow0(rows, q, index, registry, panelAssetClass, context);
}

/* -- R1 / R2 / R3: the kinds and the sector wedge ------------------------------------------------ */

/** The kinds that survive R1 (sector typed), R2 (`ctx.kinds`) and R3 (query shorter than two). */
function allowedKinds(q: string, ctx: RankContext): Set<CandidateKind> {
  let kinds: CandidateKind[] = ['instrument', 'function', 'person', 'topic'];
  // R1 — a sector was typed: instruments only.
  if (ctx.sectorGiven !== undefined) kinds = ['instrument'];
  // R2 — `ctx.kinds` given: only those kinds.
  if (Array.isArray(ctx.kinds)) {
    const wanted = new Set(ctx.kinds);
    kinds = kinds.filter((k) => wanted.has(k));
  }
  // R3 — below two characters, people and topics are excluded.
  if (q.length < MIN_QUERY_FOR_PEOPLE_AND_TOPICS) {
    kinds = kinds.filter((k) => k !== 'person' && k !== 'topic');
  }
  return new Set(kinds);
}

/** R1's second half: with a sector typed, only instruments inside that sector's wedge survive. */
function passesSectorWedge(entry: UniverseEntry, ctx: RankContext): boolean {
  const sector = ctx.sectorGiven;
  if (sector === undefined) return true;
  if (entry.kind !== 'instrument') return false;
  if (entry.assetClass === null) return false;
  return sectorAllowsAssetClass(sector, entry.assetClass);
}

/** A context that is safe to read even when the caller hands over a partial object. */
function normalizeContext(ctx: RankContext): RankContext {
  const base: RankContext = {
    panel: ctx?.panel ?? { security: null, fn: null, params: {} },
    hasPanelSecurity: ctx?.hasPanelSecurity === true,
    watchlistIds: ctx?.watchlistIds instanceof Set ? ctx.watchlistIds : new Set<number>(),
    mru: ctx?.mru instanceof Map ? ctx.mru : new Map<string, MruRank>(),
  };
  if (ctx?.sectorGiven !== undefined) base.sectorGiven = ctx.sectorGiven;
  if (Array.isArray(ctx?.kinds)) base.kinds = ctx.kinds;
  return base;
}

/* -- candidate collection ------------------------------------------------------------------------ */

/**
 * Every entry the four index structures offer for `q`, each keyed once and holding its BEST match
 * term: a row that matches both its ticker and a name word is one row scored on the ticker.
 */
function collect(
  q: string,
  index: UniverseIndex,
  ctx: RankContext,
  allowed: Set<CandidateKind>,
): Map<string, Hit> {
  const hits = new Map<string, Hit>();

  const note = (
    entry: UniverseEntry | undefined,
    match: number,
    matchedOn: MatchedOn,
    matchedText?: string,
  ): void => {
    if (entry === undefined) return;
    if (!allowed.has(entry.kind)) return;
    if (!passesSectorWedge(entry, ctx)) return;
    const key = `${entry.kind}:${entry.id}`;
    const prev = hits.get(key);
    if (prev === undefined || match > prev.match) {
      hits.set(key, {
        entry,
        match,
        matchedOn,
        ...(matchedText === undefined ? {} : { matchedText }),
      });
    }
  };

  // ── codes and aliases: functions and topics ───────────────────────────────────────────────────
  if (allowed.has('function') || allowed.has('topic')) {
    for (const hit of index.codePrefix(q, CODE_PREFIX_LIMIT)) {
      const entry = index.entryAt(hit.entry);
      if (entry === undefined) continue;
      if (entry.kind === 'topic') {
        note(entry, MATCH_TOPIC_CODE_PREFIX, 'code');
        continue;
      }
      const exact = hit.key.length === q.length;
      const match = exact
        ? hit.alias
          ? MATCH_ALIAS_EXACT
          : MATCH_CODE_EXACT
        : Math.max(
            MATCH_CODE_PREFIX_FLOOR,
            MATCH_CODE_PREFIX_BASE - MATCH_CODE_PREFIX_DECAY * (hit.key.length - q.length),
          );
      note(entry, match, hit.alias ? 'alias' : 'code', hit.alias ? hit.key : undefined);
    }
  }

  // ── instrument tickers ────────────────────────────────────────────────────────────────────────
  if (allowed.has('instrument')) {
    const block = index.tickerPrefix(q, TICKER_PREFIX_LIMIT);
    for (const at of block) {
      const entry = index.entryAt(at);
      if (entry === undefined) continue;
      const ticker = entry.upperTicker;
      const match =
        ticker.length === q.length
          ? MATCH_TICKER_EXACT
          : Math.max(
              MATCH_TICKER_PREFIX_FLOOR,
              MATCH_TICKER_PREFIX_BASE - MATCH_TICKER_PREFIX_DECAY * (ticker.length - q.length),
            );
      note(entry, match, 'ticker');
    }
  }

  // ── name words (instruments, functions, people, topics) ───────────────────────────────────────
  const words = index.wordPrefix(q, WORD_PREFIX_LIMIT);
  for (const idx of words) {
    const entry = index.entryAt(idx);
    if (entry === undefined) continue;
    const match =
      entry.kind === 'person'
        ? MATCH_PERSON_NAME_WORD
        : entry.kind === 'topic'
          ? MATCH_TOPIC_NAME_WORD
          : index.matchesFirstWord(idx, q)
            ? MATCH_NAME_FIRST_WORD
            : MATCH_NAME_OTHER_WORD;
    note(entry, match, 'name');
  }

  // ── trigram fallback, only under the §3.1 L889 thresholds ─────────────────────────────────────
  if (index.shouldUseTrigrams(q, hits.size)) {
    for (const hit of index.trigramSearch(q, {
      minScore: TRIGRAM_MIN_SCORE,
      limit: TRIGRAM_LIMIT,
    })) {
      note(index.entryAt(hit.entry), MATCH_TRIGRAM_FACTOR * hit.score, 'trigram');
    }
  }

  return hits;
}

/* -- assembly ------------------------------------------------------------------------------------ */

/**
 * "at most 8 of one kind unless the other kinds are empty" (§3.3 L959). The cap is applied first;
 * rows it dropped are reinstated only when the capped kind is the ONLY kind present, which is the
 * exact exception the sentence carves out.
 */
function applyKindCap(scored: readonly Scored[]): Scored[] {
  const perKind = new Map<CandidateKind, number>();
  const kept: Scored[] = [];
  const overflow: Scored[] = [];
  const kindsSeen = new Set<CandidateKind>();

  for (const row of scored) {
    kindsSeen.add(row.entry.kind);
    if (kept.length >= MAX_RESULTS && overflow.length >= MAX_RESULTS) break;
    const used = perKind.get(row.entry.kind) ?? 0;
    if (used >= MAX_PER_KIND) {
      overflow.push(row);
      continue;
    }
    perKind.set(row.entry.kind, used + 1);
    if (kept.length < MAX_RESULTS) kept.push(row);
  }

  if (kindsSeen.size === 1 && kept.length < MAX_RESULTS) {
    for (const row of overflow) {
      if (kept.length >= MAX_RESULTS) break;
      kept.push(row);
    }
  }
  return kept.length > MAX_RESULTS ? kept.slice(0, MAX_RESULTS) : kept;
}

function toCandidate(row: Scored, q: string, registry: FunctionRegistry | undefined): Candidate {
  const e = row.entry;
  const candidate: Candidate = {
    kind: e.kind,
    id: e.id,
    primary: e.primary,
    secondary: e.secondary,
    score: row.score,
    matchedOn: row.matchedOn,
    matched: highlightsOf(e.primary, q),
    insertText: insertTextOf(e, registry, row.matchedOn, row.matchedText),
    source: row.source,
  };
  if (e.assetClass !== null) candidate.assetClass = e.assetClass;
  if (e.marketSector !== null) candidate.marketSector = e.marketSector;
  if (row.applicable !== null) candidate.applicable = row.applicable;
  return candidate;
}

/**
 * R0 (§3.3 L923-925): when `q` is exactly a function code or alias and that function is applicable
 * in the panel context, that function is row 0 — typing `W` opens Watchlists even though `W US
 * Equity` (Wayfair) matches the ticker exactly too. The row keeps its computed score; only its
 * position is forced, so `rank()[0]` and `parse()[0]` agree by construction.
 *
 * When the registry knows the code but the universe snapshot does not carry it (a function added
 * between two snapshot versions), the row is synthesised from the manifest rather than dropped:
 * R0 is the rule that keeps `GO` predictable, and it may not depend on snapshot freshness.
 */
function promoteRow0(
  rows: Candidate[],
  q: string,
  index: UniverseIndex,
  registry: FunctionRegistry | undefined,
  panelAssetClass: AssetClass | null,
  ctx: RankContext,
): Candidate[] {
  // R1/R2 exclude functions entirely; R0 cannot resurrect one.
  if (ctx.sectorGiven !== undefined) return rows;
  if (Array.isArray(ctx.kinds) && !ctx.kinds.includes('function')) return rows;

  const manifest = tryGetManifest(registry, q);
  if (manifest === undefined) return rows;
  if (!isFunctionApplicable(manifest, panelAssetClass)) return rows;

  const code = isString(manifest.code) ? manifest.code.toUpperCase() : '';
  if (code.length === 0) return rows;

  const at = rows.findIndex((r) => r.kind === 'function' && r.id === code);
  if (at === 0) return rows;
  if (at > 0) {
    const [row] = rows.splice(at, 1);
    if (row !== undefined) rows.unshift(row);
    return rows;
  }

  // Not in the list at all: score it from the manifest and put it first.
  const entryIdx = index.entryOfCode(code);
  const entry = entryIdx >= 0 ? index.entryAt(entryIdx) : undefined;
  const synthetic: UniverseEntry = entry ?? syntheticEntry(manifest, code);
  const isAlias = code !== q;
  const hit: Hit = {
    entry: synthetic,
    match: isAlias ? MATCH_ALIAS_EXACT : MATCH_CODE_EXACT,
    matchedOn: isAlias ? 'alias' : 'code',
    ...(isAlias ? { matchedText: q } : {}),
  };
  const scored = scoreOf(hit, ctx, registry, panelAssetClass, 'local');
  rows.unshift(toCandidate(scored, q, registry));
  return rows.length > MAX_RESULTS ? rows.slice(0, MAX_RESULTS) : rows;
}

/** A `UniverseEntry` for a function the registry knows and the snapshot does not carry. */
function syntheticEntry(manifest: AnyFunctionManifest, code: string): UniverseEntry {
  const name = isString(manifest.name) ? manifest.name : '';
  const tier = manifest.tier === 1 || manifest.tier === 2 || manifest.tier === 3 ? manifest.tier : null;
  return {
    kind: 'function',
    id: code,
    instrumentId: null,
    primary: code,
    secondary: name,
    upperTicker: '',
    upperCode: code,
    upperAliases: Array.isArray(manifest.aliases)
      ? manifest.aliases.filter(isString).map((a) => a.toUpperCase())
      : [],
    name,
    nameWords: name.toUpperCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0),
    marketSector: null,
    assetClass: null,
    exchCode: '',
    weight: tier === null ? 1 : 4 - tier,
    tier,
    status: 1,
  };
}

/** How far below the weakest local row a clamped yahoo row's score lands. */
const YAHOO_CLAMP_EPSILON = 0.001;

/**
 * §3.3's yahoo penalty: `−25 (and never above a local hit with match ≥ 60)`.
 *
 * Re-exported so callers merging server hits (§3.4) can apply the same clamp.
 *
 * The clamp moves the SCORE as well as the position. Ordering alone is not enough: the merged list
 * travels to the client as `SearchHit` rows carrying `score`, and anything that re-sorts by that
 * field — a server merge, a UI that stitches two responses together, the bench's monotonicity
 * assertion — would otherwise undo the clamp and float the yahoo row back above the local hit. The
 * whole yahoo block is shifted by one delta, so the yahoo rows keep their order among themselves.
 */
export function clampYahooBelowLocal(rows: readonly Candidate[]): Candidate[] {
  const local = rows.filter((r) => r.source !== 'yahoo');
  const yahoo = rows.filter((r) => r.source === 'yahoo');
  const strongLocal = local.some((r) => r.score >= LOCAL_HIT_MATCH_FLOOR);
  if (!strongLocal || yahoo.length === 0) return [...rows].sort(compareCandidates);

  const sortedLocal = local.sort(compareCandidates);
  const sortedYahoo = yahoo.sort(compareCandidates);
  const weakestLocal = sortedLocal.reduce(
    (min, r) => (r.score < min ? r.score : min),
    Number.POSITIVE_INFINITY,
  );
  const ceiling = weakestLocal - YAHOO_CLAMP_EPSILON;
  const strongestYahoo = sortedYahoo[0]?.score ?? 0;
  const delta = strongestYahoo > ceiling ? strongestYahoo - ceiling : 0;
  const clamped =
    delta === 0 ? sortedYahoo : sortedYahoo.map((r) => ({ ...r, score: r.score - delta }));
  return [...sortedLocal, ...clamped].slice(0, MAX_RESULTS);
}
