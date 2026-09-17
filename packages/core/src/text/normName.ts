// packages/core/src/text/normName.ts — WP-03 (WORKPLAN L583).
//
// The one name normaliser. `refdata/resolve.ts` uses it to match a typed or provider-supplied
// company name against `issuers.name` / `issues.name`, and the news entity matcher (§18.7) uses it
// to decide whether "Apple Inc." in a headline is the same issuer as "APPLE INC" in the master.
// There is exactly one of these in the system: two normalisers would mean the resolver and the
// news matcher disagreeing about who an article is about, silently.
//
// The pipeline, in order:
//
//   1. non-strings and unnormalisable input → `''` (the function is total; it never throws)
//   2. Unicode NFD, then every combining mark U+0300-U+036F dropped   — "Nestlé" → "Nestle"
//   3. upper-case (locale-independent `toUpperCase`; 'ß' → "SS" by that rule alone)
//   4. the letters NFD cannot decompose are folded by table               — "Ørsted" → "ORSTED"
//   5. apostrophes and full stops are *deleted*, not spaced   — "McDonald's" → "MCDONALDS",
//      "U.S. Bancorp" → "US BANCORP", "Apple Inc." → "APPLE INC"
//   6. every other non-letter, non-digit becomes a space — so "&" separates: "AT&T" → "AT T" and
//      "Procter & Gamble" → "PROCTER GAMBLE". Both sides of a comparison are folded the same way,
//      which is what matters; a headline writing "AT&T" and a master writing "AT & T" agree.
//   7. runs of whitespace collapse, ends are trimmed
//   8. a leading "THE" is dropped, then trailing legal suffixes are dropped repeatedly
//      ("Smith Holdings Group Limited" → "SMITH"), never below one token: `normName('Group PLC')`
//      is `'GROUP'`, and `normName('PLC')` is `'PLC'`, because a name is never normalised away.
//
// Deterministic: same input, same output, no clock, no locale, no configuration read at run time.

/* -------------------------------------------------------------------------------------------- */
/* Folding                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * Upper-case letters that carry their diacritic inside the code point rather than as a combining
 * mark, so NFD leaves them alone. Applied after `toUpperCase`, so only the upper-case forms appear.
 */
const FOLD: ReadonlyMap<string, string> = new Map([
  ['Ø', 'O'],
  ['Æ', 'AE'],
  ['Œ', 'OE'],
  ['Đ', 'D'],
  ['Ð', 'D'],
  ['Ł', 'L'],
  ['Þ', 'TH'],
  ['Ħ', 'H'],
  ['Ŧ', 'T'],
  ['Ŋ', 'NG'],
  ['Ĳ', 'IJ'],
  ['Ʒ', 'Z'],
  ['Ə', 'E'],
]);

/** Combining marks left behind by NFD. */
const COMBINING = /[̀-ͯ]/gu;

/** Deleted outright, so that "McDonald's" and "U.S." close up instead of splitting. */
const ELIDED = /['‘’ʼ`´.]/gu;

/** Everything that is neither a letter nor a digit becomes a single space. */
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;

/**
 * Case-folded, diacritic-folded, punctuation-folded text — steps 1-7, without suffix stripping.
 * Exported because the news matcher needs the un-stripped form to compare a headline's full span
 * against a name, and because `normName` is defined in terms of it.
 */
export function foldName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';

  let s: string;
  try {
    s = raw.normalize('NFD');
  } catch {
    // A lone surrogate can make `normalize` throw in some engines; the raw text still folds.
    s = raw;
  }

  s = s.replace(COMBINING, '').toUpperCase();

  if (FOLD.size > 0) {
    let folded = '';
    for (const ch of s) folded += FOLD.get(ch) ?? ch;
    s = folded;
  }

  return s.replace(ELIDED, '').replace(NON_ALNUM, ' ').trim();
}

/* -------------------------------------------------------------------------------------------- */
/* Legal suffixes                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * The trailing tokens that carry no identity. The comma-and-period spellings ("Apple, Inc.",
 * "Apple Inc.") reduce to these by step 5-6 before this set is consulted, so `INC` covers all four
 * of `Inc`, `Inc.`, `, Inc` and `, Inc.`.
 */
export const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  'INC',
  'INCORPORATED',
  'CORP',
  'CORPORATION',
  'CO',
  'COMPANY',
  'LTD',
  'LIMITED',
  'PLC',
  'LLC',
  'LLP',
  'LP',
  'NV',
  'SA',
  'AG',
  'HOLDINGS',
  'HOLDING',
  'HLDGS',
  'HLDG',
  'GROUP',
  'GRP',
]);

/** The leading token that carries no identity: "The Coca-Cola Company" → "COCA COLA". */
export const LEADING_ARTICLES: ReadonlySet<string> = new Set(['THE']);

/**
 * Drop trailing legal suffixes, repeatedly, never returning an empty list: `['GROUP','PLC']` →
 * `['GROUP']` and `['PLC']` → `['PLC']`. Pure; the input array is not modified.
 */
export function stripLegalSuffixes(tokens: readonly string[]): string[] {
  let end = tokens.length;
  while (end > 1) {
    const last = tokens[end - 1];
    if (last === undefined || !LEGAL_SUFFIXES.has(last)) break;
    end -= 1;
  }
  return tokens.slice(0, end);
}

/* -------------------------------------------------------------------------------------------- */
/* normName                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/** Switches for the two lossy steps. Both default to `true`. */
export interface NormNameOptions {
  /** Drop trailing `Inc` / `Corp` / `Ltd` / … (step 8). */
  readonly stripSuffixes?: boolean;
  /** Drop a leading `The` (step 8). */
  readonly stripArticle?: boolean;
}

/** The normalised tokens of a name — `normName(raw).split(' ')`, without the join and re-split. */
export function normNameTokens(raw: unknown, options?: NormNameOptions): string[] {
  const folded = foldName(raw);
  if (folded.length === 0) return [];

  let tokens = folded.split(' ');

  if (options?.stripArticle !== false && tokens.length > 1) {
    const first = tokens[0];
    if (first !== undefined && LEADING_ARTICLES.has(first)) tokens = tokens.slice(1);
  }

  if (options?.stripSuffixes !== false) tokens = stripLegalSuffixes(tokens);

  return tokens;
}

/**
 * The normalised name: upper-case, diacritic-free, punctuation-free, legal-suffix-free, single
 * spaces. Total — every input, including `null`, a number or a lone surrogate, yields a string.
 */
export function normName(raw: unknown, options?: NormNameOptions): string {
  return normNameTokens(raw, options).join(' ');
}

/**
 * `true` when two names normalise to the same string. The comparison the news matcher makes before
 * it falls back to token overlap.
 */
export function sameName(a: unknown, b: unknown, options?: NormNameOptions): boolean {
  const left = normName(a, options);
  return left.length > 0 && left === normName(b, options);
}
