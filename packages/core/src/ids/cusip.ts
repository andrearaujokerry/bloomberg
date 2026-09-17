/**
 * CUSIP — the CUSIP Global Services nine-character number, WORKPLAN §WP-03 L580 ("CUSIP mod-10
 * double-add-double"), FUNCTIONS.md §2.1 L627 and §2.7 L840-841 (`912797VE4 Govt`), CONTRACTS §4.1
 * `issues.cusip char(9)` and `etf_holdings.cusip`.
 *
 * ```
 *  0  3  7  8  3  3  1  0  0
 *  └────┬────┘  └─┬─┘     └ check digit
 *    issuer (6)  issue (2)
 * ```
 *
 * Character values are `0-9 → 0-9`, `A → 10 … Z → 35`, and the three special characters
 * `* → 36`, `@ → 37`, `# → 38`. Those three are real: they occupy the "issue" positions of private
 * placement numbers, and a codec that rejects them silently drops rows from an N-PORT holdings
 * file. The check digit is mod-10 double-add-double: every second character of the eight-character
 * body is doubled starting with the **second** one, the decimal digits of each value are summed,
 * and the check digit takes the total to the next multiple of ten.
 *
 * A CUSIP whose first character is a letter is a CINS (the ISO 6166 extension for non-US issues,
 * `G0692U109` = Accenture plc); the arithmetic is identical, so no distinction is made here.
 *
 * {@link cusipToIsin} is the other half of the relationship ISO 6166 defines: a US or Canadian ISIN
 * is the country code, the CUSIP verbatim as the NSIN, and a fresh ISIN check digit — which is a
 * *different* algorithm over a *different* body, so it is computed, never copied.
 *
 * Nothing here throws (QA-05, WORKPLAN L617).
 */

import { isinCheckDigit } from './isin.js';

/** Length of a CUSIP, in characters. */
export const CUSIP_LENGTH = 9;

/** Length of the body the check digit is computed over. */
export const CUSIP_BODY_LENGTH = 8;

/** The three non-alphanumeric characters a CUSIP may contain, in value order (36, 37, 38). */
export const CUSIP_SPECIALS = '*@#';

/** Why an input is not a CUSIP. */
export type CusipProblemCode =
  /** The input was not a string at all. */
  | 'not-a-string'
  /** The input was empty (or whitespace only). */
  | 'empty'
  /** The input was not nine characters long. */
  | 'length'
  /** A character outside `[0-9A-Z*@#]`. */
  | 'charset'
  /** The last character is not a digit. */
  | 'check-digit-not-numeric'
  /** The last character is a digit, but not the right one. */
  | 'check-digit';

/** One reason an input failed to parse. `index` is a character offset, or -1 for the whole input. */
export interface CusipProblem {
  readonly code: CusipProblemCode;
  readonly message: string;
  /** Offset into `normalised`, or -1 when the problem is about the input as a whole. */
  readonly index: number;
}

/** A successful parse. */
export interface CusipParseOk {
  readonly ok: true;
  readonly value: string;
  readonly normalised: string;
  /** Characters 1-6: the issuer. */
  readonly issuer: string;
  /** Characters 7-8: the issue. */
  readonly issue: string;
  readonly checkDigit: number;
  /** True when character 1 is a letter — a CINS rather than a domestic CUSIP. */
  readonly isCins: boolean;
  readonly problems: readonly CusipProblem[];
}

/** A failed parse: every reason found, never an exception. */
export interface CusipParseFail {
  readonly ok: false;
  readonly value: null;
  readonly normalised: string;
  readonly problems: readonly CusipProblem[];
}

/** The result of {@link parseCusip}; narrow on `ok`. */
export type CusipParseResult = CusipParseOk | CusipParseFail;

/**
 * The CUSIP value of one character: `0-9 → 0-9`, `A-Z → 10-35`, `* → 36`, `@ → 37`, `# → 38`.
 * Returns `null` for anything else. Never throws.
 */
export function cusipCharValue(ch: string): number | null {
  if (typeof ch !== 'string' || ch.length !== 1) return null;
  const c = ch.charCodeAt(0);
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x5a) return c - 55;
  if (ch === '*') return 36;
  if (ch === '@') return 37;
  if (ch === '#') return 38;
  return null;
}

/** Sum of the decimal digits of a value in 0…76 (a doubled `#`). */
function digitSum(v: number): number {
  return Math.floor(v / 10) + (v % 10);
}

function normalise(raw: string): string {
  return raw.trim().toUpperCase();
}

function isDigit(ch: string): boolean {
  return ch.length === 1 && ch >= '0' && ch <= '9';
}

/**
 * The CUSIP check digit: mod-10 double-add-double over the eight-character body.
 *
 * @param body the eight-character body (`'03783310'`), or a full nine-character CUSIP (the ninth
 *   character is ignored). Trimmed and upper-cased first.
 * @returns the check digit 0-9, or `null` when `body` is not eight (or nine) characters of
 *   `[0-9A-Z*@#]`. Never throws.
 */
export function cusipCheckDigit(body: string): number | null {
  if (typeof body !== 'string') return null;
  const s = normalise(body);
  if (s.length !== CUSIP_BODY_LENGTH && s.length !== CUSIP_LENGTH) return null;
  let total = 0;
  for (let i = 0; i < CUSIP_BODY_LENGTH; i++) {
    const v = cusipCharValue(s.charAt(i));
    if (v === null) return null;
    // Positions are 1-based in the published rule: double every character in an even position,
    // i.e. the odd zero-based indices.
    total += digitSum(i % 2 === 1 ? v * 2 : v);
  }
  return (10 - (total % 10)) % 10;
}

/**
 * Parse a CUSIP, collecting every reason it is not one. Total: any value at all may be passed, and
 * the function never throws.
 */
export function parseCusip(raw: unknown): CusipParseResult {
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
  const problems: CusipProblem[] = [];

  if (s.length === 0) {
    return {
      ok: false,
      value: null,
      normalised: s,
      problems: [
        { code: 'empty', message: 'a CUSIP is 9 characters; the input is empty', index: -1 },
      ],
    };
  }

  if (s.length !== CUSIP_LENGTH) {
    problems.push({
      code: 'length',
      message: `a CUSIP is ${String(CUSIP_LENGTH)} characters; this is ${String(s.length)}`,
      index: -1,
    });
  }

  const last = Math.min(s.length, CUSIP_LENGTH);
  for (let i = 0; i < last; i++) {
    const ch = s.charAt(i);
    if (cusipCharValue(ch) === null) {
      problems.push({
        code: 'charset',
        message: `${JSON.stringify(ch)} is not a CUSIP character (A-Z, 0-9, ${CUSIP_SPECIALS})`,
        index: i,
      });
      continue;
    }
    if (i === CUSIP_LENGTH - 1 && !isDigit(ch)) {
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

  const expected = cusipCheckDigit(s);
  const actual = cusipCharValue(s.charAt(CUSIP_LENGTH - 1));
  if (expected === null || actual === null || expected !== actual) {
    return {
      ok: false,
      value: null,
      normalised: s,
      problems: [
        {
          code: 'check-digit',
          message: `check digit is ${s.charAt(CUSIP_LENGTH - 1)}; expected ${String(expected ?? '?')}`,
          index: CUSIP_LENGTH - 1,
        },
      ],
    };
  }

  const first = s.charAt(0);
  return {
    ok: true,
    value: s,
    normalised: s,
    issuer: s.slice(0, 6),
    issue: s.slice(6, 8),
    checkDigit: expected,
    isCins: first >= 'A' && first <= 'Z',
    problems: [],
  };
}

/** True when `raw` is a well-formed CUSIP with a correct check digit. Never throws. */
export function isValidCusip(raw: unknown): boolean {
  return parseCusip(raw).ok;
}

/** The normalised CUSIP, or `null` when `raw` is not one. */
export function toCusip(raw: unknown): string | null {
  const r = parseCusip(raw);
  return r.ok ? r.value : null;
}

/**
 * Build the ISIN a CUSIP maps to under ISO 6166: `country + cusip + isinCheckDigit(country+cusip)`.
 *
 * `cusipToIsin('037833100')` → `'US0378331005'`. The ISIN check digit is recomputed — it is a
 * different algorithm over a different body, and is never the CUSIP's own check digit.
 *
 * @param cusip a nine-character CUSIP; it must itself be valid, check digit included.
 * @param country the two-letter ISIN prefix; `'US'` by default, `'CA'` for a Canadian issue.
 * @returns the twelve-character ISIN, or `null` when either input is malformed. Never throws.
 */
export function cusipToIsin(cusip: string, country = 'US'): string | null {
  const c = parseCusip(cusip);
  if (!c.ok) return null;
  if (typeof country !== 'string') return null;
  const cc = country.trim().toUpperCase();
  if (cc.length !== 2 || !/^[A-Z]{2}$/.test(cc)) return null;
  const body = cc + c.value;
  const check = isinCheckDigit(body);
  if (check === null) return null;
  return body + String(check);
}

/** A description of an arbitrary runtime value, for problem messages. */
function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}
