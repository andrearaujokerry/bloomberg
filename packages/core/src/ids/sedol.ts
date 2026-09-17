/**
 * SEDOL — the London Stock Exchange's Stock Exchange Daily Official List number, WORKPLAN §WP-03
 * L580-581 ("SEDOL 1-3-1-7-3-9"), CONTRACTS §4.1 `issues.sedol char(7)` and `etf_holdings.sedol`.
 *
 * Seven characters: a six-character body and a check digit.
 *
 * ```
 *  0  2  6  3  4  9  4          B  0  W  N  L  Y  7
 *  └────────┬───────┘ └ check   └────────┬───────┘ └ check
 *       body (6)                     body (6)
 * ```
 *
 * SEDOLs issued before 26 January 2004 are entirely numeric (`0263494`); every one issued since
 * starts with a letter (`B0WNLY7`) because the numeric space ran out. Both forms are accepted here;
 * the vintage is not something a codec should have an opinion about.
 *
 * The alphabet excludes the vowels `A E I O U`, so a SEDOL cannot spell a word — the same reason
 * FIGI drops them. Character values are `0-9 → 0-9` and `B → 11 … Z → 35` (the gaps where the
 * vowels would be are simply unused, so `B` is 11, not 10).
 *
 * The check digit is a **weighted mod-10** — not a Luhn: the six body characters are weighted
 * `1, 3, 1, 7, 3, 9`, the weighted values are summed *whole* (there is no digit-sum step, unlike
 * CUSIP and FIGI), and the check digit takes that sum to the next multiple of ten.
 *
 * Nothing here throws (QA-05, WORKPLAN L617).
 */

/** Length of a SEDOL, in characters. */
export const SEDOL_LENGTH = 7;

/** Length of the body the check digit is computed over. */
export const SEDOL_BODY_LENGTH = 6;

/** The positional weights applied to the six body characters. */
export const SEDOL_WEIGHTS: readonly number[] = [1, 3, 1, 7, 3, 9];

/** The SEDOL alphabet: digits and the twenty-one consonants — no `A`, `E`, `I`, `O` or `U`. */
export const SEDOL_ALPHABET = '0123456789BCDFGHJKLMNPQRSTVWXYZ';

/** Why an input is not a SEDOL. */
export type SedolProblemCode =
  /** The input was not a string at all. */
  | 'not-a-string'
  /** The input was empty (or whitespace only). */
  | 'empty'
  /** The input was not seven characters long. */
  | 'length'
  /** A character outside the SEDOL alphabet. */
  | 'charset'
  /** A vowel — the specific, common way a SEDOL-shaped string is wrong. */
  | 'vowel'
  /** The last character is not a digit. */
  | 'check-digit-not-numeric'
  /** The last character is a digit, but not the right one. */
  | 'check-digit';

/** One reason an input failed to parse. `index` is a character offset, or -1 for the whole input. */
export interface SedolProblem {
  readonly code: SedolProblemCode;
  readonly message: string;
  /** Offset into `normalised`, or -1 when the problem is about the input as a whole. */
  readonly index: number;
}

/** A successful parse. */
export interface SedolParseOk {
  readonly ok: true;
  readonly value: string;
  readonly normalised: string;
  readonly checkDigit: number;
  /** True for the post-2004 alphanumeric series (the first character is a letter). */
  readonly isAlphanumericSeries: boolean;
  readonly problems: readonly SedolProblem[];
}

/** A failed parse: every reason found, never an exception. */
export interface SedolParseFail {
  readonly ok: false;
  readonly value: null;
  readonly normalised: string;
  readonly problems: readonly SedolProblem[];
}

/** The result of {@link parseSedol}; narrow on `ok`. */
export type SedolParseResult = SedolParseOk | SedolParseFail;

const VOWELS = 'AEIOU';

/** `0-9 → 0-9`, `B-Z (consonants) → 11-35`, anything else (vowels included) → null. */
export function sedolCharValue(ch: string): number | null {
  if (typeof ch !== 'string' || ch.length !== 1) return null;
  const c = ch.charCodeAt(0);
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x5a && !VOWELS.includes(ch)) return c - 55;
  return null;
}

function normalise(raw: string): string {
  return raw.trim().toUpperCase();
}

function isDigit(ch: string): boolean {
  return ch.length === 1 && ch >= '0' && ch <= '9';
}

/**
 * The SEDOL check digit: `(10 - Σ wᵢ·vᵢ mod 10) mod 10` with weights 1, 3, 1, 7, 3, 9.
 *
 * @param body the six-character body (`'026349'`), or a full seven-character SEDOL (the seventh
 *   character is ignored). Trimmed and upper-cased first.
 * @returns the check digit 0-9, or `null` when `body` is not six (or seven) characters of the
 *   SEDOL alphabet. Never throws.
 */
export function sedolCheckDigit(body: string): number | null {
  if (typeof body !== 'string') return null;
  const s = normalise(body);
  if (s.length !== SEDOL_BODY_LENGTH && s.length !== SEDOL_LENGTH) return null;
  let total = 0;
  for (let i = 0; i < SEDOL_BODY_LENGTH; i++) {
    const v = sedolCharValue(s.charAt(i));
    const w = SEDOL_WEIGHTS[i];
    if (v === null || w === undefined) return null;
    total += v * w;
  }
  return (10 - (total % 10)) % 10;
}

/**
 * Parse a SEDOL, collecting every reason it is not one. Total: any value at all may be passed, and
 * the function never throws.
 */
export function parseSedol(raw: unknown): SedolParseResult {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      value: null,
      normalised: '',
      problems: [
        { code: 'not-a-string', message: `expected a string, received ${typeOf(raw)}`, index: -1 },
      ],
    };
  }

  const s = normalise(raw);
  const problems: SedolProblem[] = [];

  if (s.length === 0) {
    return {
      ok: false,
      value: null,
      normalised: s,
      problems: [
        { code: 'empty', message: 'a SEDOL is 7 characters; the input is empty', index: -1 },
      ],
    };
  }

  if (s.length !== SEDOL_LENGTH) {
    problems.push({
      code: 'length',
      message: `a SEDOL is ${String(SEDOL_LENGTH)} characters; this is ${String(s.length)}`,
      index: -1,
    });
  }

  const last = Math.min(s.length, SEDOL_LENGTH);
  for (let i = 0; i < last; i++) {
    const ch = s.charAt(i);
    if (VOWELS.includes(ch)) {
      problems.push({
        code: 'vowel',
        message: `the SEDOL alphabet has no vowels; found '${ch}'`,
        index: i,
      });
      continue;
    }
    if (sedolCharValue(ch) === null) {
      problems.push({
        code: 'charset',
        message: `${JSON.stringify(ch)} is not a SEDOL character (0-9 and the consonants B-Z)`,
        index: i,
      });
      continue;
    }
    if (i === SEDOL_LENGTH - 1 && !isDigit(ch)) {
      problems.push({
        code: 'check-digit-not-numeric',
        message: `the check digit must be 0-9; found ${JSON.stringify(ch)}`,
        index: i,
      });
    }
  }

  if (problems.length > 0) {
    return { ok: false, value: null, normalised: s, problems };
  }

  const expected = sedolCheckDigit(s);
  const actual = sedolCharValue(s.charAt(SEDOL_LENGTH - 1));
  if (expected === null || actual === null || expected !== actual) {
    return {
      ok: false,
      value: null,
      normalised: s,
      problems: [
        {
          code: 'check-digit',
          message: `check digit is ${s.charAt(SEDOL_LENGTH - 1)}; expected ${String(expected ?? '?')}`,
          index: SEDOL_LENGTH - 1,
        },
      ],
    };
  }

  const first = s.charAt(0);
  return {
    ok: true,
    value: s,
    normalised: s,
    checkDigit: expected,
    isAlphanumericSeries: first >= 'B' && first <= 'Z',
    problems: [],
  };
}

/** True when `raw` is a well-formed SEDOL with a correct check digit. Never throws. */
export function isValidSedol(raw: unknown): boolean {
  return parseSedol(raw).ok;
}

/** The normalised SEDOL, or `null` when `raw` is not one. */
export function toSedol(raw: unknown): string | null {
  const r = parseSedol(raw);
  return r.ok ? r.value : null;
}

/** A description of an arbitrary runtime value, for problem messages. */
function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}
