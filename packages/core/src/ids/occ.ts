/**
 * OCC / OSI option contract symbols — parse, format and convert (WORKPLAN L581-583,
 * ARCHITECTURE L139, PROVIDERS §5.2 L738-744).
 *
 * Two spellings of the same 21-character OSI identifier are in play:
 *
 * - **Cboe form** — the root is written unpadded, so the string is 16-21 characters:
 *   `AAPL260916C00245000`. This is what the recorded `cboe-options` chain publishes and what
 *   `option_terms.occ_symbol` stores (`varchar(21)`, CONTRACTS L80, DATA_MODEL L626).
 * - **OSI form** — the root occupies a fixed six-character field, right-padded with spaces, so the
 *   string is always exactly 21 characters: `AAPL  260916C00245000`. It is *derived*, never stored
 *   twice (PROVIDERS L741).
 *
 * The layout after the root field is fixed-width in both forms:
 *
 * ```
 *   AAPL  260916C00245000
 *   └root┘└YYMM┘│└strike┘
 *         └ DD ┘└ C or P
 * ```
 *
 * - `YYMMDD` — expiry. `YY` is a two-digit year in the 2000-2099 window (the only window OSI can
 *   express); the date must be a real calendar date, so `260231` is rejected.
 * - `C` / `P` — call or put (`option_terms.put_call`).
 * - eight digits — the strike in **thousandths** of the quote currency, so `00245000` is 245 and
 *   `00002500` is 2.50. The widest strike OSI can express is 99 999.999.
 *
 * Contract of this module:
 *
 * - **Nothing here ever throws.** Every entry point returns a discriminated `OccResult`, because
 *   QA-05 fuzzes the identifier codecs with 100 k arbitrary strings (TESTING L806) and the command
 *   line runs the shape test on every keystroke (FUNCTIONS.md L712).
 * - **Parsing is case- and whitespace-strict.** Only uppercase roots and rights are accepted and no
 *   surrounding whitespace is trimmed, which is what makes `formatOcc(parseOcc(x)) === x` hold for
 *   every accepted input — the round-trip invariant TESTING §7 (L806) pins. Callers that may hold
 *   user input uppercase it first (the command tokenizer already carries `Token.upper`).
 * - **Strikes are exact.** `strikeThousandths` is the integer the wire carries; `strike` is the
 *   convenience double. Formatting rejects a strike that is not a whole number of thousandths
 *   rather than silently rounding it, so a `numeric(14,4)` value with a sub-thousandth tail is
 *   reported instead of being corrupted.
 */

/** Put or call, matching `option_terms.put_call` (CONTRACTS L80). */
export type OptionRight = 'C' | 'P';

/** Which spelling of the identifier a string is written in. */
export type OccForm = 'cboe' | 'osi';

/** Total length of the OSI (space-padded) form, and of `option_terms.occ_symbol`. */
export const OCC_SYMBOL_LENGTH = 21;

/** Width of the OSI root field; a Cboe-form root may be 1-6 characters. */
export const OCC_ROOT_FIELD_LENGTH = 6;

/** `YYMMDD` + right + eight strike digits — the fixed-width part after the root. */
export const OCC_TAIL_LENGTH = 15;

/** Shortest Cboe-form symbol: a single-character root plus the fixed tail. */
export const OCC_MIN_SYMBOL_LENGTH = OCC_TAIL_LENGTH + 1;

/** The strike field is eight digits of thousandths. */
export const OCC_STRIKE_DIGITS = 8;

/** Strikes are carried in thousandths of the quote currency. */
export const OCC_STRIKE_SCALE = 1000;

/** Largest strike the eight-digit field can express, in thousandths (99 999.999). */
export const OCC_MAX_STRIKE_THOUSANDTHS = 99_999_999;

/** First year the two-digit OSI year can express. */
export const OCC_MIN_YEAR = 2000;

/** Last year the two-digit OSI year can express. */
export const OCC_MAX_YEAR = 2099;

/**
 * Why an OCC string or option record was rejected. The command line maps every one of these onto
 * its own `CommandProblem { code: 'BAD_IDENTIFIER' }` (CONTRACTS L976) and keeps `message`/`span`.
 */
export type OccProblemCode =
  | 'NOT_A_STRING'
  | 'NOT_AN_OBJECT'
  | 'EMPTY'
  | 'BAD_LENGTH'
  | 'BAD_PADDING'
  | 'BAD_ROOT'
  | 'BAD_EXPIRY'
  | 'BAD_RIGHT'
  | 'BAD_STRIKE';

/** A rejection. `span` is a half-open `[start, end)` offset pair into the input string. */
export interface OccProblem {
  readonly code: OccProblemCode;
  readonly message: string;
  readonly span: [number, number];
}

/** The parsed contract terms. */
export interface OccOption {
  /** Root / underlying symbol, unpadded: `AAPL`. 1-6 characters, `[A-Z][A-Z0-9]*`. */
  readonly root: string;
  /** Expiry as an ISO calendar date, `YYYY-MM-DD` — `option_terms.expiry`. */
  readonly expiry: string;
  readonly right: OptionRight;
  /** Strike in currency units, e.g. `245` or `2.5` — `option_terms.strike`. */
  readonly strike: number;
  /** The same strike as the exact integer the wire carries (245 → `245000`). */
  readonly strikeThousandths: number;
}

/**
 * What {@link formatOcc} accepts: a parsed {@link OccOption}, or a hand-built record that gives the
 * strike either way round. Fields are validated at run time, so an untyped record is safe to pass.
 */
export interface OccOptionLike {
  readonly root: string;
  readonly expiry: string;
  readonly right: string;
  readonly strike?: number;
  readonly strikeThousandths?: number;
}

/** Every entry point returns this; none of them throws. */
export type OccResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: OccProblem };

export type OccParseResult = OccResult<OccOption>;

// ── internals ─────────────────────────────────────────────────────────────────────────────────

const CHAR_0 = 48;
const CHAR_9 = 57;
const CHAR_A = 65;
const CHAR_Z = 90;
const CHAR_SPACE = 32;
const CHAR_C = 67;
const CHAR_P = 80;
const CHAR_DASH = 45;

const fail = <T,>(code: OccProblemCode, message: string, span: [number, number]): OccResult<T> => ({
  ok: false,
  problem: { code, message, span },
});

const ok = <T,>(value: T): OccResult<T> => ({ ok: true, value });

const isDigitAt = (s: string, i: number): boolean => {
  const c = s.charCodeAt(i);
  return c >= CHAR_0 && c <= CHAR_9;
};

const isUpperAt = (s: string, i: number): boolean => {
  const c = s.charCodeAt(i);
  return c >= CHAR_A && c <= CHAR_Z;
};

/** Reads `count` ASCII digits starting at `from`, or `null` if any of them is not one. */
const readDigits = (s: string, from: number, count: number): number | null => {
  let n = 0;
  for (let i = from; i < from + count; i += 1) {
    const c = s.charCodeAt(i);
    if (!(c >= CHAR_0 && c <= CHAR_9)) return null;
    n = n * 10 + (c - CHAR_0);
  }
  return n;
};

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Days in a 1-based month of a proleptic-Gregorian year; 0 for an out-of-range month. */
const daysInMonth = (year: number, month: number): number => {
  if (month < 1 || month > 12) return 0;
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return MONTH_LENGTHS[month - 1] ?? 0;
};

const pad2 = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));

const padLeft = (n: number, width: number): string => String(n).padStart(width, '0');

/**
 * Validates an unpadded root: 1-6 characters, first a letter, the rest letters or digits (adjusted
 * and weekly roots such as `AAPL1` and `SPXW` are ordinary roots under this rule).
 * Returns `null` when the root is well formed, otherwise the reason.
 */
const rootProblem = (root: string): string | null => {
  if (root.length === 0) return 'root is empty';
  if (root.length > OCC_ROOT_FIELD_LENGTH) {
    return `root ${JSON.stringify(root)} is longer than ${String(OCC_ROOT_FIELD_LENGTH)} characters`;
  }
  if (!isUpperAt(root, 0)) return `root ${JSON.stringify(root)} must start with A-Z`;
  for (let i = 1; i < root.length; i += 1) {
    if (!isUpperAt(root, i) && !isDigitAt(root, i)) {
      return `root ${JSON.stringify(root)} must be A-Z then A-Z or 0-9`;
    }
  }
  return null;
};

/** Parses a strict `YYYY-MM-DD` calendar date. */
const parseIsoDate = (text: string): { year: number; month: number; day: number } | null => {
  if (text.length !== 10) return null;
  if (text.charCodeAt(4) !== CHAR_DASH || text.charCodeAt(7) !== CHAR_DASH) return null;
  const year = readDigits(text, 0, 4);
  const month = readDigits(text, 5, 2);
  const day = readDigits(text, 8, 2);
  if (year === null || month === null || day === null) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
};

/** Splits a symbol into its root and its fixed-width tail, enforcing the padding rules. */
const splitSymbol = (symbol: string): OccResult<{ root: string; tailAt: number }> => {
  const len = symbol.length;
  if (len === 0) return fail('EMPTY', 'OCC symbol is empty', [0, 0]);
  if (len < OCC_MIN_SYMBOL_LENGTH || len > OCC_SYMBOL_LENGTH) {
    return fail(
      'BAD_LENGTH',
      `OCC symbol must be ${String(OCC_MIN_SYMBOL_LENGTH)}-${String(OCC_SYMBOL_LENGTH)} characters, got ${String(len)}`,
      [0, len],
    );
  }
  const tailAt = len - OCC_TAIL_LENGTH;
  const head = symbol.slice(0, tailAt);
  if (!head.includes(' ')) return ok({ root: head, tailAt });

  // A space in the root field means the OSI form, which is padded to exactly 21 characters.
  if (len !== OCC_SYMBOL_LENGTH) {
    return fail(
      'BAD_PADDING',
      `a space-padded OCC root is only valid in the ${String(OCC_SYMBOL_LENGTH)}-character OSI form, got ${String(len)} characters`,
      [0, tailAt],
    );
  }
  let end = head.length;
  while (end > 0 && head.charCodeAt(end - 1) === CHAR_SPACE) end -= 1;
  const root = head.slice(0, end);
  if (root.includes(' ')) {
    return fail('BAD_PADDING', 'OCC root is padded with spaces on the right only', [0, tailAt]);
  }
  if (root.length === 0) return fail('BAD_ROOT', 'OCC root is blank', [0, tailAt]);
  return ok({ root, tailAt });
};

// ── parsing ───────────────────────────────────────────────────────────────────────────────────

/**
 * Parses an OCC option symbol in either the Cboe form (`AAPL260916C00245000`) or the padded OSI
 * form (`AAPL  260916C00245000`). Never throws: an unparseable input comes back as a problem.
 */
export function parseOcc(symbol: string): OccParseResult {
  if (typeof symbol !== 'string') {
    return fail('NOT_A_STRING', 'OCC symbol must be a string', [0, 0]);
  }
  const split = splitSymbol(symbol);
  if (!split.ok) return split;
  const { root, tailAt } = split.value;

  const badRoot = rootProblem(root);
  if (badRoot !== null) return fail('BAD_ROOT', badRoot, [0, tailAt]);

  const dateAt = tailAt;
  const yy = readDigits(symbol, dateAt, 2);
  const mm = readDigits(symbol, dateAt + 2, 2);
  const dd = readDigits(symbol, dateAt + 4, 2);
  if (yy === null || mm === null || dd === null) {
    return fail(
      'BAD_EXPIRY',
      `expiry ${JSON.stringify(symbol.slice(dateAt, dateAt + 6))} must be six digits, YYMMDD`,
      [dateAt, dateAt + 6],
    );
  }
  const year = OCC_MIN_YEAR + yy;
  if (dd < 1 || dd > daysInMonth(year, mm)) {
    return fail(
      'BAD_EXPIRY',
      `expiry ${symbol.slice(dateAt, dateAt + 6)} is not a calendar date`,
      [dateAt, dateAt + 6],
    );
  }

  const rightAt = dateAt + 6;
  const rightCode = symbol.charCodeAt(rightAt);
  if (rightCode !== CHAR_C && rightCode !== CHAR_P) {
    return fail(
      'BAD_RIGHT',
      `option right ${JSON.stringify(symbol.slice(rightAt, rightAt + 1))} must be C or P`,
      [rightAt, rightAt + 1],
    );
  }

  const strikeAt = rightAt + 1;
  const strikeThousandths = readDigits(symbol, strikeAt, OCC_STRIKE_DIGITS);
  if (strikeThousandths === null) {
    return fail(
      'BAD_STRIKE',
      `strike ${JSON.stringify(symbol.slice(strikeAt))} must be ${String(OCC_STRIKE_DIGITS)} digits of thousandths`,
      [strikeAt, strikeAt + OCC_STRIKE_DIGITS],
    );
  }
  if (strikeThousandths === 0) {
    return fail('BAD_STRIKE', 'strike must be greater than zero', [
      strikeAt,
      strikeAt + OCC_STRIKE_DIGITS,
    ]);
  }

  return ok({
    root,
    expiry: `${String(year)}-${pad2(mm)}-${pad2(dd)}`,
    right: rightCode === CHAR_C ? 'C' : 'P',
    strike: strikeThousandths / OCC_STRIKE_SCALE,
    strikeThousandths,
  });
}

/** {@link parseOcc} reduced to a value or `null`, for call sites that do not want the reason. */
export function parseOccOrNull(symbol: string): OccOption | null {
  const r = parseOcc(symbol);
  return r.ok ? r.value : null;
}

/** True when the string is a valid OCC symbol in either form. */
export function isOccSymbol(symbol: string): boolean {
  return parseOcc(symbol).ok;
}

/**
 * True when the string is a valid symbol written with an **unpadded** root — the Cboe form that
 * `option_terms.occ_symbol` holds. A six-character root makes both forms the same string, so this
 * and {@link isOsiOccSymbol} are both true for it.
 */
export function isCboeOccSymbol(symbol: string): boolean {
  if (typeof symbol !== 'string' || symbol.includes(' ')) return false;
  return parseOcc(symbol).ok;
}

/** True when the string is a valid symbol written in the 21-character, space-padded OSI form. */
export function isOsiOccSymbol(symbol: string): boolean {
  if (typeof symbol !== 'string' || symbol.length !== OCC_SYMBOL_LENGTH) return false;
  return parseOcc(symbol).ok;
}

// ── formatting ────────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the strike of an {@link OccOptionLike} to exact integer thousandths.
 *
 * This is the single shared entry point for `formatOcc` and `occStrikeText`, so the
 * non-object guard lives here: `OccOptionLike` is a structural interface, which means a row read
 * back from the database or handed over by an untyped provider adapter can be `null` at run time
 * and must still come back as a problem rather than a `TypeError` (QA-05).
 */
const strikeThousandthsOf = (option: OccOptionLike): OccResult<number> => {
  if (typeof option !== 'object' || option === null) {
    return fail('NOT_AN_OBJECT', 'option must be an object', [0, 0]);
  }
  const explicit = option.strikeThousandths;
  if (explicit !== undefined) {
    if (typeof explicit !== 'number' || !Number.isInteger(explicit)) {
      return fail('BAD_STRIKE', 'strikeThousandths must be an integer', [0, 0]);
    }
    if (explicit <= 0 || explicit > OCC_MAX_STRIKE_THOUSANDTHS) {
      return fail(
        'BAD_STRIKE',
        `strikeThousandths must be 1-${String(OCC_MAX_STRIKE_THOUSANDTHS)}, got ${String(explicit)}`,
        [0, 0],
      );
    }
    // Both fields present: they must agree. A record whose `strike numeric(14,4)` column and
    // derived thousandths have drifted formats to whichever field wins silently otherwise, so
    // the disagreement is reported instead of resolved.
    const alsoStrike = option.strike;
    if (typeof alsoStrike === 'number' && Number.isFinite(alsoStrike)) {
      const scaledOther = Math.round(alsoStrike * OCC_STRIKE_SCALE);
      if (scaledOther !== explicit) {
        return fail(
          'BAD_STRIKE',
          `strike ${String(alsoStrike)} and strikeThousandths ${String(explicit)} disagree ` +
            `(strike scales to ${String(scaledOther)} thousandths)`,
          [0, 0],
        );
      }
    }
    return ok(explicit);
  }
  const strike = option.strike;
  if (typeof strike !== 'number' || !Number.isFinite(strike)) {
    return fail('BAD_STRIKE', 'strike must be a finite number', [0, 0]);
  }
  const scaled = Math.round(strike * OCC_STRIKE_SCALE);
  // Reject a strike finer than a thousandth rather than rounding it away. The comparison is
  // relative because `strike * 1000` is not exact in binary for every representable strike.
  if (Math.abs(strike - scaled / OCC_STRIKE_SCALE) > 1e-9 * Math.max(1, Math.abs(strike))) {
    return fail(
      'BAD_STRIKE',
      `strike ${String(strike)} is not a whole number of thousandths and cannot be written in OSI`,
      [0, 0],
    );
  }
  if (scaled <= 0 || scaled > OCC_MAX_STRIKE_THOUSANDTHS) {
    return fail(
      'BAD_STRIKE',
      `strike ${String(strike)} is outside the OSI range 0.001-${String(OCC_MAX_STRIKE_THOUSANDTHS / OCC_STRIKE_SCALE)}`,
      [0, 0],
    );
  }
  return ok(scaled);
};

/**
 * Formats contract terms as an OCC symbol. `form` picks the spelling: `'cboe'` (the default, root
 * unpadded — what `option_terms.occ_symbol` stores) or `'osi'` (root padded to six characters).
 *
 * Never throws; every field is validated, so `formatOcc` is safe on records read back from the
 * database or built by a caller.
 */
export function formatOcc(option: OccOptionLike, form: OccForm = 'cboe'): OccResult<string> {
  if (typeof option !== 'object' || option === null) {
    return fail('NOT_AN_OBJECT', 'option must be an object', [0, 0]);
  }
  const root = option.root;
  if (typeof root !== 'string') return fail('BAD_ROOT', 'root must be a string', [0, 0]);
  const badRoot = rootProblem(root);
  if (badRoot !== null) return fail('BAD_ROOT', badRoot, [0, 0]);

  if (typeof option.expiry !== 'string') {
    return fail('BAD_EXPIRY', 'expiry must be an ISO YYYY-MM-DD string', [0, 0]);
  }
  const date = parseIsoDate(option.expiry);
  if (date === null) {
    return fail('BAD_EXPIRY', `expiry ${JSON.stringify(option.expiry)} is not YYYY-MM-DD`, [0, 0]);
  }
  if (date.year < OCC_MIN_YEAR || date.year > OCC_MAX_YEAR) {
    return fail(
      'BAD_EXPIRY',
      `expiry year ${String(date.year)} is outside the OSI window ${String(OCC_MIN_YEAR)}-${String(OCC_MAX_YEAR)}`,
      [0, 0],
    );
  }

  if (option.right !== 'C' && option.right !== 'P') {
    return fail('BAD_RIGHT', `right ${JSON.stringify(option.right)} must be C or P`, [0, 0]);
  }

  const strike = strikeThousandthsOf(option);
  if (!strike.ok) return strike;

  const rootField = form === 'osi' ? root.padEnd(OCC_ROOT_FIELD_LENGTH, ' ') : root;
  return ok(
    `${rootField}${pad2(date.year - OCC_MIN_YEAR)}${pad2(date.month)}${pad2(date.day)}${option.right}${padLeft(strike.value, OCC_STRIKE_DIGITS)}`,
  );
}

/** The strike as a fixed four-decimal string, the shape `option_terms.strike numeric(14,4)` takes. */
export function occStrikeText(option: OccOptionLike): OccResult<string> {
  const strike = strikeThousandthsOf(option);
  if (!strike.ok) return strike;
  const units = Math.floor(strike.value / OCC_STRIKE_SCALE);
  const milli = strike.value - units * OCC_STRIKE_SCALE;
  return ok(`${String(units)}.${padLeft(milli, 3)}0`);
}

// ── conversion ────────────────────────────────────────────────────────────────────────────────

/**
 * Rewrites a symbol (in either form) into the padded OSI form. A six-character root is already
 * six characters wide, so the result equals the input for those.
 */
export function toOsiForm(symbol: string): OccResult<string> {
  const parsed = parseOcc(symbol);
  if (!parsed.ok) return parsed;
  return formatOcc(parsed.value, 'osi');
}

/**
 * Rewrites a symbol (in either form) into the Cboe form with the root unpadded — the canonical
 * spelling for `option_terms.occ_symbol` (PROVIDERS L741).
 */
export function toCboeForm(symbol: string): OccResult<string> {
  const parsed = parseOcc(symbol);
  if (!parsed.ok) return parsed;
  return formatOcc(parsed.value, 'cboe');
}
