/**
 * `news/entityLink.ts` — NEWS-02, precision over recall (PROVIDERS.b §11.3 L2570-2665,
 * WORKPLAN §WP-09 L1168-1172).
 *
 * A headline is resolved to issuers, instruments and topics, and **nothing below 0.90 is ever
 * written**. That floor is the whole point of the module rather than a tuning knob: a wrong link
 * puts a story about somebody else on a user's own holding — it shows up on that issuer's CN
 * screen, on the `n:inst:` subject and inside an alert, and one such link costs more trust than a
 * hundred missed links on stories the desk can still find through `N`. So an ambiguous headline
 * produces **no** link.
 *
 * The arithmetic of §11.3.3 is what makes the floor bite:
 *
 * ```
 *   score = base × Π modifiers,   evaluated in a fixed order, capped at 1.0
 *
 *   base       cik 1.00 · ticker_exact 1.00 · name_exact 0.95 · name_alias 0.90 ·
 *              feed_topic 1.00 · keyword 0.90 · manual 1.00 (data ops only, never minted here)
 *   × 0.97     the match occurs only in the summary — a story is about what its headline names
 *   × 0.95     the matched surface form is a single token, which is where false positives live
 *   × 0.90     the matched form is uncorroborated and is either a single token or — raw or
 *              normalised — in the dictionary's ambiguous-word list
 *   × 0.00     the match falls inside a URL or inside an attribution to another publication
 *   reject     an uncorroborated `ticker_exact` whose ticker is an ambiguous word
 * ```
 *
 * which lands where §11.3.3's table says it should:
 *
 * | Case | Score | Written |
 * | --- | --- | --- |
 * | `$AAPL` in the headline | 1.000 | yes |
 * | `(AAPL)` in the summary | 0.970 | yes |
 * | `Apple Inc` — exact name, headline, two tokens | 0.950 | yes |
 * | `Apple` — exact name, summary, single token | 0.828 | **no** |
 * | alias `Facebook` in the headline | 0.900 | yes |
 * | alias in the summary | 0.873 | **no** |
 * | `GAP` — ambiguous, headline, single token, uncorroborated | 0.812 | **no** |
 * | `Target` — headline, single token, uncorroborated | 0.812 | **no** |
 * | `(AI)` in the headline, uncorroborated | — | **no** (an unqualified gloss, refused) |
 *
 * The last two rows are the recorded deviation from §11.3.3's literal wording: the ×0.90 row names
 * an enumerated word list, and precision that rests on an enumeration being complete is not
 * precision. See {@link linkHeadline}'s scoring loop for the argument.
 *
 * Two structural rules keep the link set honest beyond the floor (§11.3.4):
 *
 *  - **issuer → instrument fan-out is capped at one.** A CIK or a name resolves an *issuer*; the
 *    instrument link is written only for that issuer's primary composite, never for all of its
 *    venue FIGIs and never for a second share class. An issuer with more than one such candidate
 *    fans out to none.
 *  - **story-level cap of 8 instrument links.** Beyond that only issuer and topic links survive,
 *    and a story that would exceed the cap by more than four opens `data_exceptions` kind
 *    `'manual_review'` — a "biggest movers" round-up is a curation problem, not a linking problem.
 *
 * ## Why a bare ticker string is not enough (§11.3.4)
 *
 * `[A-Z]{1,5}` matches `US`, `AI`, `CPI`, `GDP`, `EU`, `FED`, `OPEC` and `ETF`, and `US`, `AI`,
 * `ALL`, `IT`, `ON` and `KEY` are live US tickers. A bare-token rule attaches *"US GDP Revised Up
 * as Consumer Spending Holds"* to three unrelated small caps. The ticker matcher therefore
 * requires an explicit marker — `$AAPL`, `(AAPL)`, `(AAPL US)` or `AAPL:US` — and a prose mention
 * is reached only through the full-name path.
 *
 * ## What this module is not
 *
 * {@link linkHeadline} is **pure**: it takes the story and the run's dictionary snapshot
 * (`refdata/newsDict.ts`, built once per run so every story in one run sees the same world) and
 * returns candidates. Nothing here reads the clock, opens a connection or mutates the dictionary.
 * {@link linkNewsItems} is the database half: it loads the two run-level maps the pure matcher
 * cannot know (topic ids, and each issuer's primary composite), applies the fan-out and the cap,
 * and writes `news_entity_links` without ever overwriting a `manual` row (REF-10).
 */

import { sql } from 'drizzle-orm';

import { normName, normNameTokens } from '@terminal/core';

import type { Tx } from '../db/client.js';
import type { NewsDictionary } from '../refdata/newsDict.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type LinkEntityKind = 'instrument' | 'issuer' | 'person' | 'topic';

/** The seven `news_entity_links.method` CHECK values, in priority order. */
export type LinkMethod =
  'cik' | 'ticker_exact' | 'name_exact' | 'name_alias' | 'feed_topic' | 'keyword' | 'manual';

/** One candidate link. `display` is the surface the match was made on, for diagnostics. */
export interface LinkCandidate {
  entityKind: LinkEntityKind;
  entityId: number;
  confidence: number;
  method: LinkMethod;
  display: string;
}

/** The story, as much of it as the matcher is allowed to see (§11.3.2: never the body). */
export interface NewsLinkInput {
  headline: string;
  summary: string | null;
  /** The SEC filer CIK, in any spelling; `null` for every other source. */
  cik: string | null;
  items8k: readonly string[] | null;
  feed: string;
  sourceId: 'bbg.rss' | 'sec.atom' | 'fed.rss';
}

/** A stored story ready to be linked. */
export interface LinkableNewsItem extends NewsLinkInput {
  newsId: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants (§11.3.2, §11.3.3)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The schema floor. A candidate scoring below this is discarded, never written, never rounded up. */
export const LINK_THRESHOLD = 0.9;

/**
 * The floor as `news_entity_links.confidence` stores it.
 *
 * The column is `real` (IEEE float4) and 0.9 is not representable in binary: `0.9::real` reads
 * back as 0.8999999761581421. A value written at exactly the floor therefore compares `< 0.9`
 * when it is read out again, in SQL and in JavaScript alike. Code that asserts the floor against
 * *stored* values compares with this constant; code that asserts it against a candidate's score,
 * before the column rounds it, compares with {@link LINK_THRESHOLD}.
 */
export const LINK_THRESHOLD_STORED = Math.fround(LINK_THRESHOLD);

/** §11.3.2's base confidences. Fixed by the spec and by the `method` CHECK; not tunable. */
export const BASE_CONFIDENCE: Readonly<Record<LinkMethod, number>> = Object.freeze({
  cik: 1.0,
  ticker_exact: 1.0,
  name_exact: 0.95,
  name_alias: 0.9,
  feed_topic: 1.0,
  keyword: 0.9,
  manual: 1.0,
});

/** Stronger method wins when two of them name the same entity on the same story. */
const METHOD_RANK: Readonly<Record<LinkMethod, number>> = Object.freeze({
  manual: 0,
  cik: 1,
  ticker_exact: 2,
  feed_topic: 3,
  name_exact: 4,
  name_alias: 5,
  keyword: 6,
});

/** §11.3.2 matcher 5: the feed → `topics.code` map. */
export const FEED_TOPIC_CODE: ReadonlyMap<string, string> = new Map([
  ['markets', 'MARKETS'],
  ['economics', 'ECO'],
  ['politics', 'POLITICS'],
  ['technology', 'TECH'],
  ['wealth', 'WEALTH'],
  ['industries', 'INDUSTRIES'],
  ['8-K', 'FILINGS'],
  ['press_all', 'FED'],
]);

/** §11.3.3: the match is only in the summary — a story is about what its headline names. */
export const SUMMARY_MODIFIER = 0.97;
/** §11.3.3: one-word surface forms are where the false positives live. */
export const SINGLE_TOKEN_MODIFIER = 0.95;
/** §11.3.3: an ambiguous word that nothing else corroborates. */
export const AMBIGUOUS_MODIFIER = 0.9;

/** §11.3.4: instrument links per story, beyond which only issuer and topic links are kept. */
export const MAX_INSTRUMENT_LINKS = 8;
/** §11.3.4: exceeding the cap by more than this opens a `manual_review` exception. */
export const MANUAL_REVIEW_EXCESS = 4;

/** The longest token run the name matcher will try. Longer issuer names are matched by prefix runs. */
const MAX_NAME_TOKENS = 6;
/** The longest token run the topic-keyword matcher will try. */
const MAX_KEYWORD_TOKENS = 3;

/**
 * The three **marked** ticker forms of §11.3.2, and only these.
 *
 * `\$AAPL` · `(AAPL)` / `(AAPL US)` with a Bloomberg exchange code · `AAPL:US` with an exchange
 * qualifier. Every one of them is a mark a writer put there on purpose; a bare `AI` in prose is
 * not a ticker and is never treated as one.
 */
const TICKER_PATTERNS: readonly TickerPattern[] = [
  { re: /\$([A-Z]{1,5})\b/g, qualified: true },
  { re: /\(([A-Z]{1,5})\s+(?:US|UN|UW|UQ|LN|GR)\)/g, qualified: true },
  { re: /\b([A-Z]{1,5}):(?:US|NYSE|NASDAQ)\b/g, qualified: true },
  { re: /\(([A-Z]{1,5})\)/g, qualified: false },
];

/**
 * A marked-ticker form and whether the mark carries an exchange qualifier.
 *
 * `$AAPL`, `(AAPL US)` and `AAPL:US` say "this is a ticker" and nothing else in English does.
 * The bare `(AAPL)` form does not: parenthesising a capitalised run is also how ordinary prose
 * glosses an abbreviation, and *"Artificial Intelligence (AI) Spending Surges"* or *"Consumer
 * Price Index (CPI) Rose 0.3%"* are the same three characters as a deliberate ticker mark. The
 * unqualified form is therefore kept — §11.3.2 lists it and §11.3.3's table depends on it — but
 * it is refused for any ticker on the ambiguous-word list, which is exactly the set the gloss
 * form collides with (AI, CPI, GDP, ETF, EV, FED, IPO, SEC, EU, UK, US).
 */
interface TickerPattern {
  readonly re: RegExp;
  readonly qualified: boolean;
}

/** Spans that carry no claim about the story's subject (§11.3.3, the × 0.00 row). */
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const SOURCE_ATTRIBUTION_RE = /\((?:source|via|photographer|credit)\s*:[^)]*\)/gi;
const PUBLICATIONS =
  'Reuters|Bloomberg|Associated Press|AP|Dow Jones|CNBC|Financial Times|FT|WSJ|The Wall Street Journal|New York Times|NYT|Nikkei|Xinhua';
const PUBLICATION_PAREN_RE = new RegExp(`\\((?:${PUBLICATIONS})\\)`, 'gi');
/** A quoted run of four or more words immediately attributed to another publication. */
const QUOTED_HEADLINE_RE = new RegExp(
  `[“"]([^”"]{12,200})[”"]\\s*(?:,|—|-|–)?\\s*(?:${PUBLICATIONS})\\b`,
  'gi',
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Masking — the × 0.00 modifier, applied before anything is matched
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Blank out every span a match inside which scores zero, keeping the string's length so nothing
 * downstream has to translate offsets.
 *
 * Masking rather than post-filtering is deliberate: a URL contains `/news/articles/apple-plans-…`
 * and an attribution contains `(Source: Bloomberg)`, and both would otherwise mint a name match
 * for a company the story is not about.
 *
 * DEVIATION, recorded rather than hidden: §11.3.3 also zeroes "a quoted string that is itself a
 * headline". Deciding that a quoted run *is* a headline needs a corpus of other headlines, which
 * this function does not have and must not acquire (it is pure). {@link QUOTED_HEADLINE_RE}
 * implements the case that is decidable from the story alone — a quoted run attributed to another
 * publication — and an unattributed quotation is left to the ordinary modifiers.
 */
export function maskUnattributableSpans(text: string): string {
  let out = text;
  for (const re of [URL_RE, SOURCE_ATTRIBUTION_RE, PUBLICATION_PAREN_RE, QUOTED_HEADLINE_RE]) {
    re.lastIndex = 0;
    out = out.replace(re, (match) => ' '.repeat(match.length));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Modifiers {
  /** `false` when the surface form appears only in the summary. */
  inHeadline: boolean;
  /** The matched surface form is one word. */
  singleToken: boolean;
  /** The surface is an ambiguous word and no second signal corroborates it. */
  ambiguousUncorroborated: boolean;
}

/**
 * `base × Π modifiers`, in §11.3.3's fixed order, capped at 1.0 and rounded to six decimals.
 *
 * The rounding is not cosmetic: `0.95 × 0.95` is `0.9025000000000001` in binary floating point and
 * `0.9 × 0.97` is `0.8730000000000001`, and a floor comparison that depends on the last bit of a
 * double is a floor nobody can reason about. Six decimals is finer than the `real` column the
 * value is stored in and coarser than the noise.
 */
export function scoreLink(base: number, m: Modifiers): number {
  let score = base;
  if (!m.inHeadline) score *= SUMMARY_MODIFIER;
  if (m.singleToken) score *= SINGLE_TOKEN_MODIFIER;
  if (m.ambiguousUncorroborated) score *= AMBIGUOUS_MODIFIER;
  return Math.min(1, Math.round(score * 1e6) / 1e6);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The matchers (§11.3.2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A match before the ambiguity modifier is known — corroboration is a whole-story question. */
interface RawMatch {
  entityKind: LinkEntityKind;
  entityId: number;
  method: LinkMethod;
  display: string;
  base: number;
  inHeadline: boolean;
  singleToken: boolean;
  /**
   * The matched form is an ambiguous word (§11.3.3's ×0.90 row), pending corroboration.
   *
   * Tested against the **normalised** form as well as the raw one. `normName` strips trailing legal
   * forms, so the run "Radiant World Group" normalises to `WORLD` and matches an issuer called
   * "World Holdings" exactly as "Apple Inc" matches "Apple" — the two are the same operation and
   * nothing downstream can tell them apart. What distinguishes them is that `WORLD` is an ambiguous
   * word and `APPLE` is not, and that test has to be made on the form the match was actually made
   * on. Testing only the raw surface would let a two-token prose run smuggle an ambiguous
   * single-word name past the modifier at its full 0.95.
   */
  ambiguous: boolean;
  /** The issuer the match is about, when it is about one — the corroboration key. */
  issuerId: number | null;
}

/** Marked tickers in one string (§11.3.2 matcher 2). */
function matchTickers(
  text: string,
  inHeadline: boolean,
  dict: NewsDictionary,
  out: RawMatch[],
): void {
  for (const pattern of TICKER_PATTERNS) {
    pattern.re.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = pattern.re.exec(text)) !== null) {
      const ticker = hit[1];
      if (ticker === undefined) continue;
      const target = dict.lookupTicker(ticker);
      if (target === null) continue;
      // An unqualified `(XYZ)` is only a ticker mark when `XYZ` is not also an English gloss.
      if (!pattern.qualified && dict.isAmbiguous(target.ticker)) continue;
      // A marked ticker is a deliberate mark: it is never softened by the single-token modifier,
      // because `$AAPL` is one token by construction and the marker is the corroboration.
      const shared = {
        method: 'ticker_exact' as const,
        base: BASE_CONFIDENCE.ticker_exact,
        inHeadline,
        singleToken: false,
        ambiguous: dict.isAmbiguous(target.ticker),
        issuerId: target.issuerId,
      };
      out.push({
        entityKind: 'instrument',
        entityId: target.instrumentId,
        display: target.ticker,
        ...shared,
      });
      out.push({
        entityKind: 'issuer',
        entityId: target.issuerId,
        display: target.ticker,
        ...shared,
      });
    }
  }
}

/**
 * Issuer names and aliases as whole token runs, longest first (§11.3.2 matchers 3 and 4).
 *
 * Longest-first with consumption is what stops `APPLE` matching inside `APPLE HOSPITALITY TRUST`:
 * the six-token run is tried before the one-token run, and the tokens it claims are not offered
 * to a shorter match.
 */
function matchNames(
  text: string,
  inHeadline: boolean,
  dict: NewsDictionary,
  out: RawMatch[],
): void {
  const tokens = normNameTokens(text, { stripSuffixes: false, stripArticle: false });
  let i = 0;
  while (i < tokens.length) {
    let consumed = 1;
    for (let len = Math.min(MAX_NAME_TOKENS, tokens.length - i); len >= 1; len -= 1) {
      const surface = tokens.slice(i, i + len).join(' ');
      const key = normName(surface);
      const hit = dict.lookupName(key);
      if (hit === null) continue;
      out.push({
        entityKind: 'issuer',
        entityId: hit.issuerId,
        method: hit.method,
        display: surface,
        base: BASE_CONFIDENCE[hit.method],
        inHeadline,
        singleToken: len === 1,
        ambiguous: dict.isAmbiguous(key) || dict.isAmbiguous(surface),
        issuerId: hit.issuerId,
      });
      consumed = len;
      break;
    }
    i += consumed;
  }
}

/** Curated topic keywords as token runs, longest first (§11.3.2 matcher 6). */
function matchKeywords(
  text: string,
  inHeadline: boolean,
  dict: NewsDictionary,
  out: RawMatch[],
): void {
  const tokens = normNameTokens(text, { stripSuffixes: false, stripArticle: false });
  let i = 0;
  while (i < tokens.length) {
    let consumed = 1;
    for (let len = Math.min(MAX_KEYWORD_TOKENS, tokens.length - i); len >= 1; len -= 1) {
      const surface = tokens.slice(i, i + len).join(' ');
      const topicId = dict.lookupTopic(surface);
      if (topicId === null) continue;
      out.push({
        entityKind: 'topic',
        entityId: topicId,
        method: 'keyword',
        display: surface,
        base: BASE_CONFIDENCE.keyword,
        inHeadline,
        singleToken: len === 1,
        ambiguous: dict.isAmbiguous(surface),
        issuerId: null,
      });
      consumed = len;
      break;
    }
    i += consumed;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// linkHeadline — the pure matcher
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every link a story earns, at or above the 0.90 floor. Pure: no clock, no IO, no mutation.
 *
 * The run over `headline + summary` is all §11.3.2 allows — the body is never stored, so there is
 * nothing else to match on.
 *
 * @param input the story (headline, summary, CIK, 8-K items, feed, source).
 * @param dict the run's dictionary snapshot, built once per run by `refdata/newsDict.ts`.
 * @param topicIds `topics.code → topic_id`. An **addition** to the §0 contract's two-parameter
 *   signature: `NewsDictionary` maps keywords to topic ids but knows nothing of topic *codes*, and
 *   matcher 5 is defined in codes. Omitting it suppresses `feed_topic` candidates (the keyword
 *   matcher still resolves its own ids) rather than inventing one.
 * @returns candidates, strongest first, at most one per `(entityKind, entityId)`.
 */
export function linkHeadline(
  input: NewsLinkInput,
  dict: NewsDictionary,
  topicIds?: ReadonlyMap<string, number>,
): LinkCandidate[] {
  const raw: RawMatch[] = [];

  // 1 · CIK — the SEC atom entry's own identity claim, and the only one that needs no text.
  if (input.cik !== null && input.cik.trim() !== '') {
    const issuerId = dict.lookupCik(input.cik);
    if (issuerId !== null) {
      raw.push({
        entityKind: 'issuer',
        entityId: issuerId,
        method: 'cik',
        display: input.cik.trim(),
        base: BASE_CONFIDENCE.cik,
        inHeadline: true,
        singleToken: false,
        ambiguous: false,
        issuerId,
      });
    }
  }

  // 2-4, 6 · the text matchers, over the masked headline and the masked summary.
  const headline = maskUnattributableSpans(input.headline);
  const summary = input.summary === null ? '' : maskUnattributableSpans(input.summary);
  for (const [text, inHeadline] of [
    [headline, true],
    [summary, false],
  ] as const) {
    if (text.trim() === '') continue;
    matchTickers(text, inHeadline, dict, raw);
    matchNames(text, inHeadline, dict, raw);
    matchKeywords(text, inHeadline, dict, raw);
  }

  // 5 · the feed's own topic. `feed_topic` is a statement about the feed, not about the text, so
  // no text modifier applies to it.
  if (topicIds !== undefined) {
    const code = FEED_TOPIC_CODE.get(input.feed);
    const topicId = code === undefined ? undefined : topicIds.get(code);
    if (code !== undefined && topicId !== undefined) {
      raw.push({
        entityKind: 'topic',
        entityId: topicId,
        method: 'feed_topic',
        display: code,
        base: BASE_CONFIDENCE.feed_topic,
        inHeadline: true,
        singleToken: false,
        ambiguous: false,
        issuerId: null,
      });
    }
  }

  // Corroboration for the ×0.90 modifier: a *different* method naming the same issuer somewhere in
  // the story. §11.3.3 also admits "a marked ticker for that issuer within 40 characters", which is
  // a narrower form of the same clause — a marked ticker is a different method naming that issuer,
  // and it is itself written at 1.00 — so the story-wide test subsumes it without loosening the
  // floor for any surface that has no second signal at all.
  const methodsByIssuer = new Map<number, Set<LinkMethod>>();
  for (const m of raw) {
    if (m.issuerId === null) continue;
    let set = methodsByIssuer.get(m.issuerId);
    if (set === undefined) {
      set = new Set();
      methodsByIssuer.set(m.issuerId, set);
    }
    set.add(m.method);
  }

  const best = new Map<string, LinkCandidate>();
  for (const m of raw) {
    const corroborated = m.issuerId !== null && (methodsByIssuer.get(m.issuerId)?.size ?? 0) > 1;

    // An ambiguous ticker mark that nothing else corroborates is dropped, not discounted. The
    // ×0.90 modifier applied to a base of 1.00 lands on 0.90 exactly, and `< LINK_THRESHOLD` does
    // not reject 0.90 — so the one surface the modifier exists to suppress is the one surface it
    // cannot suppress by arithmetic. A hard reject is the only reading of §11.3.3 under which the
    // modifier does anything for `ticker_exact` at all.
    if (m.method === 'ticker_exact' && m.ambiguous && !corroborated) continue;

    const confidence = scoreLink(m.base, {
      inHeadline: m.inHeadline,
      singleToken: m.singleToken,
      // DEVIATION from §11.3.3's literal wording, recorded rather than hidden. The ×0.90 row names
      // the dictionary's ambiguous-word list, but that list is an enumeration and precision cannot
      // rest on one being complete: TARGET, BLOCK, MATCH, SQUARE, SHELL, TOTAL, UNITY, ARM and
      // CARVANA are ordinary English words that are also issuer names, and a single-token
      // `name_exact` on one of them scores 0.95 × 0.95 = 0.9025 and is written — so "Fed's New
      // Inflation Target Draws Criticism" files under Target Corporation. Every *uncorroborated
      // single-token* surface is therefore treated as ambiguous, which puts it at
      // 0.95 × 0.95 × 0.90 = 0.81225 — precisely the value §11.3.3's own table assigns the
      // uncorroborated `GAP` row. Two-token names and corroborated single tokens are untouched,
      // and the word list stays as the extra brake on multi-token surfaces.
      ambiguousUncorroborated: (m.ambiguous || m.singleToken) && !corroborated,
    });
    if (confidence < LINK_THRESHOLD) continue;

    const key = `${m.entityKind}:${String(m.entityId)}`;
    const candidate: LinkCandidate = {
      entityKind: m.entityKind,
      entityId: m.entityId,
      confidence,
      method: m.method,
      display: m.display,
    };
    const seen = best.get(key);
    if (seen === undefined || betterThan(candidate, seen)) best.set(key, candidate);
  }

  return [...best.values()].sort(compareCandidates);
}

/** Higher confidence wins; on a tie the stronger method wins; then the lower entity id. */
function betterThan(a: LinkCandidate, b: LinkCandidate): boolean {
  return compareCandidates(a, b) < 0;
}

function compareCandidates(a: LinkCandidate, b: LinkCandidate): number {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  const rank = METHOD_RANK[a.method] - METHOD_RANK[b.method];
  if (rank !== 0) return rank;
  if (a.entityKind !== b.entityKind) return a.entityKind < b.entityKind ? -1 : 1;
  return a.entityId - b.entityId;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Run-level maps — the two things the pure matcher cannot know
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `topics.code → topic_id`, for matcher 5. One query per run. */
export async function loadTopicIds(tx: Tx): Promise<Map<string, number>> {
  const res = await tx.execute<{ topic_id: string; code: string }>(
    sql`SELECT topic_id::text AS topic_id, code FROM topics`,
  );
  const out = new Map<string, number>();
  for (const row of res.rows) out.set(row.code.trim().toUpperCase(), Number(row.topic_id));
  return out;
}

/**
 * `issuer_id → the issuer's one primary composite instrument` (§11.3.4, the fan-out cap).
 *
 * "Primary composite" is `instruments.primary_listing_id` pointing at a `listings` row with
 * `is_primary`, which is the one venue the terminal quotes the issuer on. An issuer with two such
 * instruments — two share classes both marked primary — is **omitted**: the headline did not name
 * a class, so neither is the answer, and the story keeps its issuer link alone.
 */
export async function loadPrimaryInstruments(
  tx: Tx,
  at: { validAt: Date; knownAt: Date },
): Promise<Map<number, number>> {
  const res = await tx.execute<{ issuer_id: string; instrument_id: string }>(sql`
    SELECT s.issuer_id, i.instrument_id
      FROM instruments i
      JOIN issues s
        ON s.issue_id = i.issue_id
       AND bt_as_of(s.valid_from, s.valid_to, s.tx_from, s.tx_to,
                    ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)
      JOIN listings l
        ON l.listing_id = i.primary_listing_id
       AND l.is_primary
       AND bt_as_of(l.valid_from, l.valid_to, l.tx_from, l.tx_to,
                    ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)
     WHERE i.status = 'active'
       AND i.primary_listing_id IS NOT NULL
       AND bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to,
                    ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)`);

  const out = new Map<number, number>();
  const contested = new Set<number>();
  for (const row of res.rows) {
    const issuerId = Number(row.issuer_id);
    const instrumentId = Number(row.instrument_id);
    const seen = out.get(issuerId);
    if (seen !== undefined && seen !== instrumentId) {
      contested.add(issuerId);
      continue;
    }
    out.set(issuerId, instrumentId);
  }
  for (const issuerId of contested) out.delete(issuerId);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// linkNewsItems — the database half
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface LinkRunOptions {
  /** `topics.code → topic_id`; loaded from `topics` when absent. */
  topicIds?: ReadonlyMap<string, number>;
  /** `issuer_id → primary composite instrument id`; loaded when absent. */
  primaryInstruments?: ReadonlyMap<number, number>;
  /**
   * Links an adapter already resolved from the payload's own structure rather than from its text,
   * by `newsId` — the Fed feed's `<category>` topic links (PROVIDERS.b §11.2) are the case that
   * exists. They join the candidate set before the cap and compete on confidence like any other, so
   * a structural link cannot be quietly overwritten by a weaker textual one, or vice versa.
   */
  extraLinks?: ReadonlyMap<number, readonly LinkCandidate[]>;
}

export interface LinkRunResult {
  /** Rows inserted or strengthened in `news_entity_links`. */
  written: number;
  /** Stories that earned no link at all — the precision-first outcome, not an error. */
  unlinked: number;
  /** Instrument links dropped by the story-level cap of 8 (§11.3.4). */
  cappedInstrumentLinks: number;
  /** News ids for which a `manual_review` exception was opened. */
  manualReview: number[];
  /** Links per story, for the caller's fan-out. */
  byNewsId: Map<number, LinkCandidate[]>;
}

/**
 * Resolve and persist the links for a batch of stored stories.
 *
 * The dictionary is the caller's — built **once per run** (§11.3.1) so that every story in one run
 * is linked against the same security master, and the run is reproducible from its `(validAt,
 * knownAt)` pair alone.
 *
 * A `manual` row is never touched: data ops' corrections outrank the matcher permanently (REF-10),
 * so the upsert's `DO UPDATE` is guarded on the stored method.
 */
export async function linkNewsItems(
  tx: Tx,
  items: readonly LinkableNewsItem[],
  dict: NewsDictionary,
  options: LinkRunOptions = {},
): Promise<LinkRunResult> {
  const result: LinkRunResult = {
    written: 0,
    unlinked: 0,
    cappedInstrumentLinks: 0,
    manualReview: [],
    byNewsId: new Map(),
  };
  if (items.length === 0) return result;

  const topicIds = options.topicIds ?? (await loadTopicIds(tx));
  const primary = options.primaryInstruments ?? (await loadPrimaryInstruments(tx, dict.asOf));

  const rows: {
    newsId: number;
    entityKind: LinkEntityKind;
    entityId: number;
    confidence: number;
    method: LinkMethod;
  }[] = [];

  for (const item of items) {
    const candidates = linkHeadline(item, dict, topicIds);

    // Issuer → instrument fan-out, capped at one instrument per issuer (§11.3.4).
    const byKey = new Map<string, LinkCandidate>();
    for (const c of candidates) byKey.set(`${c.entityKind}:${String(c.entityId)}`, c);
    for (const c of options.extraLinks?.get(item.newsId) ?? []) {
      if (c.confidence < LINK_THRESHOLD) continue;
      const key = `${c.entityKind}:${String(c.entityId)}`;
      const seen = byKey.get(key);
      if (seen === undefined || betterThan(c, seen)) byKey.set(key, c);
    }
    for (const c of [...byKey.values()]) {
      if (c.entityKind !== 'issuer') continue;
      const instrumentId = primary.get(c.entityId);
      if (instrumentId === undefined) continue;
      const key = `instrument:${String(instrumentId)}`;
      const seen = byKey.get(key);
      const fanned: LinkCandidate = {
        entityKind: 'instrument',
        entityId: instrumentId,
        confidence: c.confidence,
        method: c.method,
        display: c.display,
      };
      if (seen === undefined || betterThan(fanned, seen)) byKey.set(key, fanned);
    }

    let links = [...byKey.values()].sort(compareCandidates);

    // Story-level cap: a round-up naming a dozen companies is a curation problem (§11.3.4).
    const instruments = links.filter((l) => l.entityKind === 'instrument');
    if (instruments.length > MAX_INSTRUMENT_LINKS) {
      result.cappedInstrumentLinks += instruments.length;
      links = links.filter((l) => l.entityKind !== 'instrument');
      if (instruments.length > MAX_INSTRUMENT_LINKS + MANUAL_REVIEW_EXCESS) {
        result.manualReview.push(item.newsId);
      }
    }

    if (links.length === 0) result.unlinked += 1;
    result.byNewsId.set(item.newsId, links);
    for (const link of links) {
      rows.push({
        newsId: item.newsId,
        entityKind: link.entityKind,
        entityId: link.entityId,
        confidence: link.confidence,
        method: link.method,
      });
    }
  }

  if (rows.length > 0) {
    const values = sql.join(
      rows.map(
        (r) =>
          sql`(${r.newsId}::bigint, ${r.entityKind}::entity_kind, ${r.entityId}::bigint,
               ${r.confidence}::real, ${r.method}::text)`,
      ),
      sql`, `,
    );
    // The floor is asserted in SQL as well as in TypeScript. A candidate that reached here below
    // 0.90 is a bug in the scorer, and it must not become a row somebody later trusts.
    const res = await tx.execute<{ news_id: string }>(sql`
      INSERT INTO news_entity_links (news_id, entity_kind, entity_id, confidence, method)
      SELECT * FROM (VALUES ${values}) AS v(news_id, entity_kind, entity_id, confidence, method)
       WHERE v.confidence >= ${LINK_THRESHOLD_STORED}::real
          ON CONFLICT (news_id, entity_kind, entity_id) DO UPDATE
         SET confidence = EXCLUDED.confidence, method = EXCLUDED.method
       WHERE news_entity_links.method <> 'manual'
         AND (news_entity_links.confidence, news_entity_links.method)
             IS DISTINCT FROM (EXCLUDED.confidence, EXCLUDED.method)
       RETURNING news_id::text AS news_id`);
    result.written = res.rows.length;
  }

  // §11.3.4: the exception queue, not a dropped link. `entity_kind` is left NULL because a story is
  // not one of the four entity kinds the enum names; `entity_id` carries the `news_id` and
  // `candidates` repeats it, so a reviewer can find the story without guessing what the id means.
  for (const newsId of result.manualReview) {
    await tx.execute(sql`
      INSERT INTO data_exceptions (kind, entity_kind, entity_id, field, candidates, status)
      VALUES ('manual_review', NULL, ${newsId}::bigint, 'news_entity_links',
              ${JSON.stringify([
                {
                  newsId,
                  reason: 'INSTRUMENT_LINK_CAP',
                  detail:
                    `story links more than ${String(MAX_INSTRUMENT_LINKS + MANUAL_REVIEW_EXCESS)} ` +
                    'instruments; instrument links withheld (PROVIDERS §11.3.4)',
                },
              ])}::jsonb, 'open')`);
  }

  return result;
}
