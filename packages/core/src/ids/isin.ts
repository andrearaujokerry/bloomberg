/**
 * ISIN — ISO 6166, WORKPLAN §WP-03 L580 ("ISIN Luhn over letter expansion"), FUNCTIONS.md §2.1
 * L627, CONTRACTS §4.1 `issues.isin char(12)`.
 *
 * Twelve characters: a two-letter prefix (an ISO 3166 country code for a national numbering agency,
 * or one of the supranational codes `XS` for Euroclear/Clearstream, `EU`, `QS`…), a nine-character
 * NSIN — the national number, which for the United States is the CUSIP — and a check digit:
 *
 * ```
 *  U  S  0  3  7  8  3  3  1  0  0  5
 *  └─┬─┘  └──────────┬────────────┘  └ check digit
 *  prefix         NSIN (= the CUSIP for a US issue)
 * ```
 *
 * The check digit is a **Luhn over the letter expansion**: every letter of the eleven-character
 * body is first replaced by its two-digit value (`A → 10 … Z → 35`), which makes `US037833100`
 * the digit string `3028037833100`; then the standard Luhn rule runs over those digits, doubling
 * every second digit **starting at the rightmost one** (the check digit will occupy the position to
 * its right), summing the decimal digits of each product, and taking the total to the next multiple
 * of ten.
 *
 * The expansion is why the doubling cannot be read off the character positions: `US0378331005`
 * expands to thirteen digits, not eleven, and a body with a different number of letters shifts the
 * parity of every digit to its left.
 *
 * The prefix is validated as two letters, not against the ISO 3166 list: real ISINs are issued
 * under codes that are not countries (`XS`, `EU`, `QS`), and the list changes under us. Nothing
 * here throws — `parseIsin` takes `unknown` and reports problems (QA-05, WORKPLAN L617).
 */

/** Length of an ISIN, in characters. */
export const ISIN_LENGTH = 12;

/** Length of the body the check digit is computed over (prefix + NSIN). */
export const ISIN_BODY_LENGTH = 11;

/** Why an input is not an ISIN. */
export type IsinProblemCode =
  /** The input was not a string at all. */
  | 'not-a-string'
  /** The input was empty (or whitespace only). */
  | 'empty'
  /** The input was not twelve characters long. */
  | 'length'
  /** A character outside `[0-9A-Z]`. */
  | 'charset'
  /** One of the first two characters is not a letter. */
  | 'country-not-alpha'
  /** The last character is not a digit. */
  | 'check-digit-not-numeric'
  /** The last character is a digit, but not the right one. */
  | 'check-digit';

/** One reason an input failed to parse. `index` is a character offset, or -1 for the whole input. */
export interface IsinProblem {
  readonly code: IsinProblemCode;
  readonly message: string;
  /** Offset into `normalised`, or -1 when the problem is about the input as a whole. */
  readonly index: number;
}

/** A successful parse. */
export interface IsinParseOk {
  readonly ok: true;
  readonly value: string;
  readonly normalised: string;
  /** The two-letter prefix, e.g. `'US'`. */
  readonly country: string;
  /** The nine-character national number (the CUSIP, for a `US` ISIN). */
  readonly nsin: string;
  readonly checkDigit: number;
  readonly problems: readonly IsinProblem[];
}

/** A failed parse: every reason found, never an exception. */
export interface IsinParseFail {
  readonly ok: false;
  readonly value: null;
  readonly normalised: string;
  readonly problems: readonly IsinProblem[];
}

/** The result of {@link parseIsin}; narrow on `ok`. */
export type IsinParseResult = IsinParseOk | IsinParseFail;

/** `0-9 → 0-9`, `A-Z → 10-35`, anything else → null. */
function charValue(ch: string): number | null {
  const c = ch.charCodeAt(0);
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x5a) return c - 55;
  return null;
}

function isUpperAlpha(ch: string): boolean {
  return ch.length === 1 && ch >= 'A' && ch <= 'Z';
}

function isDigit(ch: string): boolean {
  return ch.length === 1 && ch >= '0' && ch <= '9';
}

function normalise(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Expand an alphanumeric body to its digit string: letters become two digits (`A → 10`), digits
 * stay as they are. Returns `null` if any character is outside `[0-9A-Z]`.
 */
export function isinExpand(body: string): string | null {
  if (typeof body !== 'string') return null;
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const v = charValue(body.charAt(i));
    if (v === null) return null;
    // A letter contributes two digits, which is what shifts the Luhn parity of everything left
    // of it — the whole reason ISIN check digits cannot be computed off character positions.
    out += String(v);
  }
  return out;
}

/**
 * The ISIN check digit: Luhn over the letter expansion of the body.
 *
 * @param body the eleven-character body (`'US037833100'`), or a full twelve-character ISIN (the
 *   twelfth character is ignored). Trimmed and upper-cased first.
 * @returns the check digit 0-9, or `null` when `body` is not eleven (or twelve) characters of
 *   `[0-9A-Z]`. Never throws.
 */
export function isinCheckDigit(body: string): number | null {
  if (typeof body !== 'string') return null;
  const s = normalise(body);
  if (s.length !== ISIN_BODY_LENGTH && s.length !== ISIN_LENGTH) return null;
  const expanded = isinExpand(s.slice(0, ISIN_BODY_LENGTH));
  if (expanded === null) return null;

  let total = 0;
  // The check digit will sit immediately to the right of the expansion, so the rightmost expanded
  // digit is the first one doubled.
  let double = true;
  for (let i = expanded.length - 1; i >= 0; i--) {
    const d = expanded.charCodeAt(i) - 0x30;
    const v = double ? d * 2 : d;
    total += v > 9 ? v - 9 : v;
    double = !double;
  }
  return (10 - (total % 10)) % 10;
}

/**
 * Parse an ISIN, collecting every reason it is not one. Total: any value at all may be passed, and
 * the function never throws.
 */
export function parseIsin(raw: unknown): IsinParseResult {
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
  const problems: IsinProblem[] = [];

  if (s.length === 0) {
    return {
      ok: false,
      value: null,
      normalised: s,
      problems: [
        { code: 'empty', message: 'an ISIN is 12 characters; the input is empty', index: -1 },
      ],
    };
  }

  if (s.length !== ISIN_LENGTH) {
    problems.push({
      code: 'length',
      message: `an ISIN is ${String(ISIN_LENGTH)} characters; this is ${String(s.length)}`,
      index: -1,
    });
  }

  const last = Math.min(s.length, ISIN_LENGTH);
  for (let i = 0; i < last; i++) {
    const ch = s.charAt(i);
    if (charValue(ch) === null) {
      problems.push({
        code: 'charset',
        message: `${JSON.stringify(ch)} is not an ISIN character (A-Z, 0-9)`,
        index: i,
      });
      continue;
    }
    if (i < 2 && !isUpperAlpha(ch)) {
      problems.push({
        code: 'country-not-alpha',
        message: `character ${String(i + 1)} of an ISIN is a letter (the prefix is a two-letter code)`,
        index: i,
      });
    }
    if (i === ISIN_LENGTH - 1 && !isDigit(ch)) {
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

  const expected = isinCheckDigit(s);
  const actual = charValue(s.charAt(ISIN_LENGTH - 1));
  if (expected === null || actual === null || expected !== actual) {
    return {
      ok: false,
      value: null,
      normalised: s,
      problems: [
        {
          code: 'check-digit',
          message: `check digit is ${s.charAt(ISIN_LENGTH - 1)}; expected ${String(expected ?? '?')}`,
          index: ISIN_LENGTH - 1,
        },
      ],
    };
  }

  return {
    ok: true,
    value: s,
    normalised: s,
    country: s.slice(0, 2),
    nsin: s.slice(2, 11),
    checkDigit: expected,
    problems: [],
  };
}

/** True when `raw` is a well-formed ISIN with a correct check digit. Never throws. */
export function isValidIsin(raw: unknown): boolean {
  return parseIsin(raw).ok;
}

/**
 * The two-letter prefix of a valid ISIN (`'US0378331005' → 'US'`), or `null` when `raw` is not a
 * valid ISIN. Not checked against the ISO 3166 list: `XS`, `EU` and `QS` are real ISIN prefixes.
 */
export function isinCountry(raw: unknown): string | null {
  const r = parseIsin(raw);
  return r.ok ? r.country : null;
}

/**
 * The nine-character national number of a valid ISIN — the CUSIP for a `US` or `CA` issue — or
 * `null` when `raw` is not a valid ISIN.
 */
export function isinNsin(raw: unknown): string | null {
  const r = parseIsin(raw);
  return r.ok ? r.nsin : null;
}

/** The normalised ISIN, or `null` when `raw` is not one. */
export function toIsin(raw: unknown): string | null {
  const r = parseIsin(raw);
  return r.ok ? r.value : null;
}

/** A description of an arbitrary runtime value, for problem messages. */
function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}
