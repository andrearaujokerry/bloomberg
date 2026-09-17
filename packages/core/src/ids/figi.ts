/**
 * FIGI — the Financial Instrument Global Identifier (Bloomberg Open Symbology), WORKPLAN §WP-03
 * L580-583, FUNCTIONS.md §2.1 L627 ("recognised by shape AND check digit").
 *
 * A FIGI is twelve characters:
 *
 * ```
 *  B  B  G  0  0  0  B  9  X  R  Y  4
 *  └──┬──┘  │  └──────────┬────────┘ │
 *   prefix  │        random body     └ check digit (0-9)
 *           └ always 'G'
 * ```
 *
 *  - characters 1-2 are upper-case **consonants** (vowels are excluded from the whole scheme so a
 *    FIGI can never spell a word) and must not be one of the seven reserved pairs `BS BM GG GB GH
 *    KY VG` — those are the consonant-only ISO 3166 alpha-2 codes, reserved so that a FIGI can
 *    never be mistaken for the first two characters of an ISIN;
 *  - character 3 is always `G`;
 *  - characters 4-11 are consonants or digits;
 *  - character 12 is the modified double-add-double check digit.
 *
 * The check digit is a Luhn variant over the values `0-9 → 0-9`, `A → 10 … Z → 35`: counting from
 * the right of the eleven-character body, every second character is doubled, the **decimal digits**
 * of every value (doubled or not) are summed, and the check digit is what takes that sum to the
 * next multiple of ten. Because letters carry two-digit values, the digit-sum step applies to the
 * undoubled letters too — `B` (11) contributes 2, not 11.
 *
 * Nothing here throws. `parseFigi` takes `unknown` and reports why an input is not a FIGI, because
 * QA-05 (WORKPLAN L617) fuzzes these codecs with arbitrary strings and the command line (§2.1)
 * calls them on every keystroke.
 */

/** Length of a FIGI, in characters. */
export const FIGI_LENGTH = 12;

/** Length of the body the check digit is computed over. */
export const FIGI_BODY_LENGTH = 11;

/**
 * The FIGI alphabet: the twenty-one upper-case consonants (Y counts as a consonant) and the ten
 * digits. `A`, `E`, `I`, `O` and `U` are absent by design.
 */
export const FIGI_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ0123456789';

/**
 * Prefixes a FIGI may not start with: the consonant-only ISO 3166 alpha-2 country codes
 * (Bahamas, Bermuda, Guernsey, United Kingdom, Ghana, Cayman Islands, British Virgin Islands).
 */
export const FIGI_RESERVED_PREFIXES: readonly string[] = ['BS', 'BM', 'GG', 'GB', 'GH', 'KY', 'VG'];

const RESERVED = new Set(FIGI_RESERVED_PREFIXES);

/** Why an input is not a FIGI. */
export type FigiProblemCode =
  /** The input was not a string at all. */
  | 'not-a-string'
  /** The input was empty (or whitespace only). */
  | 'empty'
  /** The input was not twelve characters long. */
  | 'length'
  /** A character outside the consonant-and-digit alphabet. */
  | 'charset'
  /** Characters 1-2 are one of the reserved country-code pairs. */
  | 'reserved-prefix'
  /** Character 1 or 2 is a digit — the prefix must be two consonants. */
  | 'prefix-not-alpha'
  /** Character 3 is not `G`. */
  | 'missing-g'
  /** Character 12 is not a digit. */
  | 'check-digit-not-numeric'
  /** Character 12 is a digit, but not the right one. */
  | 'check-digit';

/** One reason an input failed to parse. `index` is a character offset, or -1 for the whole input. */
export interface FigiProblem {
  readonly code: FigiProblemCode;
  readonly message: string;
  /** Offset into `normalised`, or -1 when the problem is about the input as a whole. */
  readonly index: number;
}

/** A successful parse. `value` is the normalised (trimmed, upper-cased) FIGI. */
export interface FigiParseOk {
  readonly ok: true;
  readonly value: string;
  readonly normalised: string;
  readonly checkDigit: number;
  readonly problems: readonly FigiProblem[];
}

/** A failed parse: every reason found, never an exception. */
export interface FigiParseFail {
  readonly ok: false;
  readonly value: null;
  readonly normalised: string;
  readonly problems: readonly FigiProblem[];
}

/** The result of {@link parseFigi}; narrow on `ok`. */
export type FigiParseResult = FigiParseOk | FigiParseFail;

/** `0-9 → 0-9`, `A-Z → 10-35`, anything else → null. */
function charValue(ch: string): number | null {
  const c = ch.charCodeAt(0);
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x5a) return c - 55;
  return null;
}

/** Sum of the decimal digits of a value in 0…70 (the widest a doubled `Z` reaches). */
function digitSum(v: number): number {
  return Math.floor(v / 10) + (v % 10);
}

/**
 * Trim and upper-case. `toUpperCase` can change a string's length on some code points
 * (`ß → SS`), which is harmless: every length check below runs on the normalised form.
 */
function normalise(raw: string): string {
  return raw.trim().toUpperCase();
}

/** True when `ch` is one of the twenty-one FIGI consonants (no vowels, no digits). */
export function isFigiConsonant(ch: string): boolean {
  return ch.length === 1 && ch >= 'B' && ch <= 'Z' && FIGI_ALPHABET.includes(ch);
}

/** True when `ch` is in the FIGI alphabet (consonants and digits). */
export function isFigiChar(ch: string): boolean {
  return ch.length === 1 && FIGI_ALPHABET.includes(ch);
}

/**
 * The modified double-add-double check digit for a FIGI body.
 *
 * @param body the eleven-character body, or a full twelve-character FIGI (the twelfth character is
 *   ignored). Trimmed and upper-cased first.
 * @returns the check digit 0-9, or `null` when `body` is not eleven (or twelve) characters of
 *   `[0-9A-Z]`. Never throws.
 */
export function figiCheckDigit(body: string): number | null {
  if (typeof body !== 'string') return null;
  const s = normalise(body);
  if (s.length !== FIGI_BODY_LENGTH && s.length !== FIGI_LENGTH) return null;
  let total = 0;
  for (let i = 0; i < FIGI_BODY_LENGTH; i++) {
    const v = charValue(s.charAt(i));
    if (v === null) return null;
    // Counting from the right of the eleven-character body, every second character is doubled.
    // With a fixed odd-length body that is exactly the odd left-hand indices.
    total += digitSum((FIGI_BODY_LENGTH - 1 - i) % 2 === 1 ? v * 2 : v);
  }
  return (10 - (total % 10)) % 10;
}

/**
 * Parse a FIGI, collecting every reason it is not one. Total: any value at all may be passed, and
 * the function never throws.
 */
export function parseFigi(raw: unknown): FigiParseResult {
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
  const problems: FigiProblem[] = [];

  if (s.length === 0) {
    return {
      ok: false,
      value: null,
      normalised: s,
      problems: [
        { code: 'empty', message: 'a FIGI is 12 characters; the input is empty', index: -1 },
      ],
    };
  }

  if (s.length !== FIGI_LENGTH) {
    problems.push({
      code: 'length',
      message: `a FIGI is ${String(FIGI_LENGTH)} characters; this is ${String(s.length)}`,
      index: -1,
    });
  }

  // Character-level checks run over whatever length we actually have, so a short or long input
  // still reports the useful problems rather than only "wrong length".
  const last = Math.min(s.length, FIGI_LENGTH);
  for (let i = 0; i < last; i++) {
    const ch = s.charAt(i);
    if (i === FIGI_LENGTH - 1) {
      if (!(ch >= '0' && ch <= '9')) {
        problems.push({
          code: 'check-digit-not-numeric',
          message: `the check digit must be 0-9; found ${JSON.stringify(ch)}`,
          index: i,
        });
      }
      continue;
    }
    if (!isFigiChar(ch)) {
      problems.push({
        code: 'charset',
        message: `${JSON.stringify(ch)} is not a FIGI character (consonants BCDFGHJKLMNPQRSTVWXYZ and digits 0-9)`,
        index: i,
      });
      continue;
    }
    if (i < 2 && !isFigiConsonant(ch)) {
      problems.push({
        code: 'prefix-not-alpha',
        message: `character ${String(i + 1)} of a FIGI is a consonant, not a digit`,
        index: i,
      });
    }
    if (i === 2 && ch !== 'G') {
      problems.push({
        code: 'missing-g',
        message: `character 3 of a FIGI is always 'G'; found ${JSON.stringify(ch)}`,
        index: 2,
      });
    }
  }

  if (s.length >= 2 && RESERVED.has(s.slice(0, 2))) {
    problems.push({
      code: 'reserved-prefix',
      message: `'${s.slice(0, 2)}' is a reserved FIGI prefix (it is an ISO 3166 country code)`,
      index: 0,
    });
  }

  if (problems.length > 0) {
    return { ok: false, value: null, normalised: s, problems };
  }

  const expected = figiCheckDigit(s);
  const actual = charValue(s.charAt(FIGI_LENGTH - 1));
  if (expected === null || actual === null || expected !== actual) {
    return {
      ok: false,
      value: null,
      normalised: s,
      problems: [
        {
          code: 'check-digit',
          message: `check digit is ${s.charAt(FIGI_LENGTH - 1)}; expected ${String(expected ?? '?')}`,
          index: FIGI_LENGTH - 1,
        },
      ],
    };
  }

  return { ok: true, value: s, normalised: s, checkDigit: expected, problems: [] };
}

/** True when `raw` is a well-formed FIGI with a correct check digit. Never throws. */
export function isValidFigi(raw: unknown): boolean {
  return parseFigi(raw).ok;
}

/**
 * The normalised FIGI, or `null` when `raw` is not one — the convenience form of {@link parseFigi}
 * for callers that do not need the problems.
 */
export function toFigi(raw: unknown): string | null {
  const r = parseFigi(raw);
  return r.ok ? r.value : null;
}

/** A description of an arbitrary runtime value, for problem messages. */
function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}
