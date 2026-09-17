// packages/core/src/ids/securityRef.ts — WP-03 (WORKPLAN L581-582, ARCHITECTURE L140-142).
//
// The security-reference grammar: the eight forms a user may type on the command line and the API
// may send as `SecurityRefInput.ref`, parsed into the `SecurityRef` of `core/types/instrument.ts`
// and formatted back out. Both sides of the wire run this file, which is why the client and the
// server accept exactly the same strings (FUNCTIONS.md L855-856).
//
//   ticker      `AAPL`, `AAPL US`, `AAPL US Equity`, `SPX Index`, `EURUSD Curncy`, `912797VE4 Govt`
//   bond        `T 4.25 08/15/36 Govt`          — a Treasury named by coupon and maturity
//   option      `AAPL 9/16/26 C245 Equity`      — a listed option, Bloomberg style
//   scheme      `/isin/US0378331005`, `/figi/BBG000B9XRY4`, `/cusip/037833100`,
//               `/occ/AAPL260916C00245000`, `/series/fred.csv/DGS10`
//   bare        `BBG000B9XRY4`, `US0378331005`, `912797VE4`, `AAPL260916C00245000`
//               — recognised by shape AND check digit (FUNCTIONS.md L628-630)
//
// This layer *parses*. It never decides which instrument a reference means: no universe, no
// database, no `lookupTicker`. Turning a `SecurityRef` into an `instrument_id` is WP-04's
// `refdata/resolve.ts`, and this file deliberately knows nothing about what exists.
//
// Two invariants hold, and `test/ids/securityRef.test.ts` pins both:
//
//   * **Round-trip.** For every canonical form `s`, `formatSecurityRef(parseSecurityRef(s).ref) === s`.
//     The canonical form of an identifier is its scheme form, so a *bare* identifier round-trips to
//     `/cusip/912797VE4` rather than to itself — `parse` reports `form: 'bare'` when that happened.
//   * **Totality.** No input throws. QA-05 drives 100 000 random strings through it; a malformed
//     reference comes back as `{ ok: false, problems }` and a merely suspicious one as `ok: true`
//     with a non-empty `problems` (a shape that matches an identifier but fails its check digit
//     "adds `BAD_IDENTIFIER` and falls through" to the ticker reading — FUNCTIONS.md L761-762).
//
// Every `problem.span` is a half-open `[start, end)` pair of offsets into the *original* string, so
// `command/parser.ts` can lift it into a `CommandProblem` (CONTRACTS L976) without re-scanning.

import { resolveSector, sectorInUniverse } from '../command/sectors.js';
import type { MarketSector, SecurityRef } from '../types/instrument.js';

import { parseCusip } from './cusip.js';
import { parseFigi } from './figi.js';
import { parseIsin } from './isin.js';
import { formatOcc, isOccSymbol, parseOcc } from './occ.js';

/* -------------------------------------------------------------------------------------------- */
/* Shapes                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** Which production matched. `bare` is an identifier typed without its `/scheme/` prefix. */
export type SecurityRefForm = 'ticker' | 'bond' | 'option' | 'scheme' | 'bare';

/** The `/scheme/` words the grammar recognises (FUNCTIONS.md §2.3 step 2, L754). */
export const SECURITY_REF_SCHEMES: readonly string[] = Object.freeze([
  'isin',
  'figi',
  'cusip',
  'sedol',
  'occ',
  'series',
] as const);

/**
 * `sedol` is a recognised scheme — a `/sedol/…` token is an identifier, not a shell command — but
 * `SecurityRefKind` (CONTRACTS, `core/types/instrument.ts`) has no `'sedol'` member, so parsing one
 * yields `UNSUPPORTED_SCHEME` rather than a ref. WP-04 validates SEDOLs with `ids/sedol.ts`.
 */
export const UNSUPPORTED_REF_SCHEMES: readonly string[] = Object.freeze(['sedol'] as const);

export type SecurityRefProblemCode =
  /** The input was not a string. */
  | 'NOT_A_STRING'
  /** The input was empty or whitespace only. */
  | 'EMPTY'
  /** Longer than {@link MAX_REF_LENGTH}; no reference is. */
  | 'TOO_LONG'
  /** More than {@link MAX_REF_TOKENS} whitespace-separated tokens (grammar: <= 5 + exch + sector). */
  | 'TOO_MANY_TOKENS'
  /** Text after a complete reference. */
  | 'TRAILING_TEXT'
  /** `/xyz/…` — not one of {@link SECURITY_REF_SCHEMES}; the command line reads this as a shell word. */
  | 'UNKNOWN_SCHEME'
  /** A recognised scheme with no `SecurityRefKind`: `/sedol/…`. */
  | 'UNSUPPORTED_SCHEME'
  /** Right shape, wrong check digit — or an identifier body the codec rejected. */
  | 'BAD_IDENTIFIER'
  /** A bare token that is a valid identifier under more than one scheme. */
  | 'AMBIGUOUS_IDENTIFIER'
  /** A sector prefix shorter than three characters, or one that names several sectors. */
  | 'UNKNOWN_SECTOR'
  /** `Corp`, `Comdty`, `Mtge`, `Muni`, `Pfd`: parsed, but nothing under them is in the universe. */
  | 'NOT_IN_UNIVERSE'
  /** A coupon that is not a number, or is out of range. */
  | 'BAD_COUPON'
  /** A maturity or expiry that is not a real calendar date. */
  | 'BAD_MATURITY'
  /** An option leg that is not `C`/`P` followed by a strike, or a strike out of range. */
  | 'BAD_OPTION'
  /** A ticker token with characters no ticker has. */
  | 'BAD_TICKER';

/** One reason, with a half-open `[start, end)` span into the original input. */
export interface SecurityRefProblem {
  readonly code: SecurityRefProblemCode;
  readonly message: string;
  readonly span: [number, number];
}

/** The terms of `T 4.25 08/15/36`. `maturity` is an ISO calendar date. */
export interface BondRefTerms {
  readonly ticker: string;
  readonly coupon: number;
  readonly maturity: string;
}

/** The terms of `AAPL 9/16/26 C245`. `expiry` is an ISO calendar date. */
export interface OptionRefTerms {
  readonly root: string;
  readonly expiry: string;
  readonly right: 'C' | 'P';
  readonly strike: number;
}

/** A successful parse. `problems` may still be non-empty — see `NOT_IN_UNIVERSE`, `BAD_IDENTIFIER`. */
export interface SecurityRefParseOk {
  readonly ok: true;
  readonly ref: SecurityRef;
  readonly form: SecurityRefForm;
  /** `formatSecurityRef(ref)` — the canonical spelling, precomputed. */
  readonly canonical: string;
  /** `true` when the input named its sector rather than leaving it to resolution. */
  readonly sectorGiven: boolean;
  /** Present for `form: 'bond'`. */
  readonly bond?: BondRefTerms;
  /** Present for `form: 'option'`. */
  readonly option?: OptionRefTerms;
  /** Present for `form: 'scheme'` and `form: 'bare'`: the scheme word, lower case. */
  readonly scheme?: string;
  readonly problems: readonly SecurityRefProblem[];
}

/** A failed parse: every reason found, never an exception. */
export interface SecurityRefParseFail {
  readonly ok: false;
  readonly ref: null;
  readonly problems: readonly SecurityRefProblem[];
}

export type SecurityRefParseResult = SecurityRefParseOk | SecurityRefParseFail;

/** Longer than any reference: the grammar's five ticker tokens plus an exchange and a sector. */
export const MAX_REF_TOKENS = 7;

/** A hard cap so a hostile string is rejected in O(1) rather than scanned (QA-05). */
export const MAX_REF_LENGTH = 256;

/* -------------------------------------------------------------------------------------------- */
/* Small pure helpers                                                                             */
/* -------------------------------------------------------------------------------------------- */

interface RawToken {
  readonly text: string;
  readonly upper: string;
  readonly start: number;
  readonly end: number;
}

const isSpace = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 13;

function splitTokens(raw: string): RawToken[] {
  const out: RawToken[] = [];
  let i = 0;
  while (i < raw.length) {
    if (isSpace(raw.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < raw.length && !isSpace(raw.charCodeAt(i))) i += 1;
    const text = raw.slice(start, i);
    out.push({ text, upper: text.toUpperCase(), start, end: i });
  }
  return out;
}

const problem = (
  code: SecurityRefProblemCode,
  message: string,
  span: [number, number],
): SecurityRefProblem => ({ code, message, span });

const fail = (...problems: SecurityRefProblem[]): SecurityRefParseFail => ({
  ok: false,
  ref: null,
  problems: Object.freeze(problems),
});

const pad2 = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly iso: string;
}

const MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

/**
 * `M/D/YY`, `MM/DD/YY` or `M/D/YYYY` → a calendar date. A two-digit year pivots at 70: `36` is
 * 2036 and `98` is 1998, which is the convention every bond and option ticker uses. Returns `null`
 * — never throws — for anything that is not a real date, `02/30/26` included.
 */
function parseMdy(text: string): CalendarDate | null {
  const m = MDY.exec(text);
  if (m === null) return null;
  const [, mm, dd, yy] = m;
  if (mm === undefined || dd === undefined || yy === undefined) return null;

  const month = Number(mm);
  const day = Number(dd);
  const rawYear = Number(yy);
  const year = yy.length === 2 ? (rawYear <= 69 ? 2000 + rawYear : 1900 + rawYear) : rawYear;

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (year < 1900 || year > 2199) return null;

  return { year, month, day, iso: `${String(year)}-${pad2(month)}-${pad2(day)}` };
}

/** The bond spelling: zero-padded month and day, two-digit year inside 2000-2099. */
function formatMaturity(d: CalendarDate): string {
  const yy = d.year >= 2000 && d.year <= 2099 ? pad2(d.year - 2000) : String(d.year);
  return `${pad2(d.month)}/${pad2(d.day)}/${yy}`;
}

/** The option spelling: unpadded month and day, two-digit year (`9/16/26`). */
function formatExpiry(d: CalendarDate): string {
  const yy = d.year >= 2000 && d.year <= 2099 ? pad2(d.year - 2000) : String(d.year);
  return `${String(d.month)}/${String(d.day)}/${yy}`;
}

/** A decimal with trailing zeros trimmed: `4.25`, `4`, `2.5`, `245`. */
function decimalText(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  return decimals === 0 ? fixed : fixed.replace(/0+$/u, '').replace(/\.$/u, '');
}

const DECIMAL = /^\d{1,4}(?:\.\d{1,6})?$/;
const INTEGER = /^\d{1,4}$/;
const FRACTION = /^(\d{1,3})\/(\d{1,3})$/;
const OPTION_LEG = /^([CP])(\d{1,5}(?:\.\d{1,3})?)$/;
/**
 * What a ticker token may contain once upper-cased. Covers `BRK/B`, `912797VE4`, `CPIAUCSL`, and
 * the two non-alphanumerics the recorded `openfigi-map` capture actually carries: `AAPL*` (a
 * when-issued line) and `AAPL_KZ`. A ticker always *starts* alphanumeric, which is what keeps
 * `===` and `<RATIO(...)>` out.
 */
const TICKER_TOKEN = /^[A-Z0-9][A-Z0-9./\-_+*&]*$/;
/** `BRK.B`, `BRK-B` → `BRK/B`: the master's spelling (FUNCTIONS.md §2.2 item 4, L716-717). */
const SHARE_CLASS = /^([A-Z]{1,4})[.\-/]([A-Z])$/;

/** Canonicalise a one-token ticker's share-class separator; multi-token tickers are left alone. */
export function canonicaliseTicker(upperToken: string): string {
  const m = SHARE_CLASS.exec(upperToken);
  if (m === null) return upperToken;
  const [, base, cls] = m;
  return base === undefined || cls === undefined ? upperToken : `${base}/${cls}`;
}

/* -------------------------------------------------------------------------------------------- */
/* Formatting                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * The canonical spelling of a `SecurityRef`. Total: a malformed ref yields its best-effort text
 * rather than an exception, because this runs inside render paths.
 *
 * `format(parse(s)) === s` for every canonical form; for a bare identifier the canonical form is
 * the scheme form, so `format(parse('912797VE4')) === '/cusip/912797VE4'`.
 */
export function formatSecurityRef(ref: SecurityRef | null | undefined): string {
  if (ref === null || ref === undefined || typeof ref !== 'object') return '';
  const value = typeof ref.value === 'string' ? ref.value : '';

  if (ref.kind === 'ticker') {
    let out = value;
    if (typeof ref.exchCode === 'string' && ref.exchCode.length > 0) out += ` ${ref.exchCode}`;
    if (typeof ref.sector === 'string' && ref.sector.length > 0) out += ` ${ref.sector}`;
    return out;
  }
  return `/${ref.kind}/${value}`;
}

/* -------------------------------------------------------------------------------------------- */
/* Identifiers                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/** `true` when `word` is one of {@link SECURITY_REF_SCHEMES}, in any case and with no slashes. */
export function isSecurityRefScheme(word: unknown): boolean {
  return typeof word === 'string' && SECURITY_REF_SCHEMES.includes(word.toLowerCase());
}

/**
 * The §2.3 step-2 test: `true` when a token that starts with `/` is an identifier rather than a
 * shell word (FUNCTIONS.md L754). The trailing slash is required — `/isin/US0378331005` is an
 * identifier, `/isin` is a shell word, exactly as the spec's `^/(isin|figi|cusip|sedol|occ|series)/`
 * reads.
 */
export function isIdentifierToken(token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const cut = token.indexOf('/', 1);
  if (!token.startsWith('/') || cut === -1) return false;
  return SECURITY_REF_SCHEMES.includes(token.slice(1, cut).toLowerCase());
}

interface IdentifierHit {
  readonly scheme: 'isin' | 'cusip' | 'figi' | 'occ';
  readonly value: string;
}

/**
 * Every identifier scheme a bare token satisfies *including its check digit*. Ordered by how
 * specific the shape is, so `[0]` is the reading to take when more than one matches.
 *
 * Bare SEDOLs are deliberately not detected: seven upper-case alphanumerics is the shape of an
 * ordinary ticker, and §2.1 L629 lists only FIGI, ISIN, CUSIP and OCC as bare identifiers.
 */
function identifierHits(upper: string): IdentifierHit[] {
  const hits: IdentifierHit[] = [];

  if (upper.length >= 16 && isOccSymbol(upper)) {
    const occ = parseOcc(upper);
    if (occ.ok) {
      const cboe = formatOcc(occ.value, 'cboe');
      if (cboe.ok) hits.push({ scheme: 'occ', value: cboe.value });
    }
  }

  if (upper.length === 12) {
    const figi = parseFigi(upper);
    if (figi.ok) hits.push({ scheme: 'figi', value: figi.value });
    const isin = parseIsin(upper);
    if (isin.ok) hits.push({ scheme: 'isin', value: isin.value });
  }

  if (upper.length === 9) {
    const cusip = parseCusip(upper);
    if (cusip.ok) hits.push({ scheme: 'cusip', value: cusip.value });
  }

  return hits;
}

/** `true` when the token has the *shape* of an identifier, whatever its check digit says. */
function looksLikeIdentifier(upper: string): boolean {
  if (!/^[A-Z0-9]+$/u.test(upper)) return false;
  if (upper.length === 12 || upper.length === 9) return true;
  return upper.length >= 16 && isOccSymbol(upper);
}

/** Parse the body of a `/scheme/value` reference. */
function parseSchemeBody(
  scheme: string,
  body: string,
  span: [number, number],
): SecurityRefParseResult {
  const upper = body.toUpperCase();

  if (scheme === 'series') {
    // `/series/fred.csv/DGS10` — `econ_series.source_id` + `/` + `econ_series.series_code`. The
    // value is opaque here; `econ_series` decides whether it exists (DATA_MODEL L203).
    if (body.length === 0) return fail(problem('BAD_IDENTIFIER', 'empty series code', span));
    const ref: SecurityRef = { kind: 'series', value: body };
    return {
      ok: true,
      ref,
      form: 'scheme',
      canonical: formatSecurityRef(ref),
      sectorGiven: false,
      scheme,
      problems: Object.freeze([]),
    };
  }

  let value: string | null = null;
  let why = '';

  if (scheme === 'isin') {
    const r = parseIsin(upper);
    if (r.ok) value = r.value;
    else why = r.problems[0]?.message ?? 'not an ISIN';
  } else if (scheme === 'cusip') {
    const r = parseCusip(upper);
    if (r.ok) value = r.value;
    else why = r.problems[0]?.message ?? 'not a CUSIP';
  } else if (scheme === 'figi') {
    const r = parseFigi(upper);
    if (r.ok) value = r.value;
    else why = r.problems[0]?.message ?? 'not a FIGI';
  } else if (scheme === 'occ') {
    const r = parseOcc(upper);
    if (r.ok) {
      const cboe = formatOcc(r.value, 'cboe');
      if (cboe.ok) value = cboe.value;
      else why = cboe.problem.message;
    } else why = r.problem.message;
  }

  if (value === null) {
    return fail(
      problem('BAD_IDENTIFIER', `${body} is not a valid ${scheme.toUpperCase()}: ${why}`, span),
    );
  }

  const kind = scheme as 'isin' | 'cusip' | 'figi' | 'occ';
  const ref: SecurityRef = { kind, value };
  return {
    ok: true,
    ref,
    form: 'scheme',
    canonical: formatSecurityRef(ref),
    sectorGiven: false,
    scheme,
    problems: Object.freeze([]),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* The ticker family                                                                              */
/* -------------------------------------------------------------------------------------------- */

interface TickerBody {
  readonly value: string;
  readonly form: SecurityRefForm;
  readonly bond?: BondRefTerms;
  readonly option?: OptionRefTerms;
  readonly problems: readonly SecurityRefProblem[];
}

/**
 * The `ticker_tokens` production, once the exchange and the sector have been taken off the end:
 * a plain ticker, a bond by coupon and maturity, or an option by expiry, right and strike.
 */
function parseTickerBody(tokens: readonly RawToken[]): TickerBody | SecurityRefParseFail {
  const span: [number, number] = [tokens[0]?.start ?? 0, tokens[tokens.length - 1]?.end ?? 0];

  for (const token of tokens) {
    if (!TICKER_TOKEN.test(token.upper)) {
      return fail(
        problem('BAD_TICKER', `'${token.text}' is not a ticker`, [token.start, token.end]),
      );
    }
  }

  // ── option: ROOT M/D/YY {C|P}STRIKE ──────────────────────────────────────────────────────────
  if (tokens.length === 3) {
    const [root, date, leg] = tokens;
    if (root !== undefined && date !== undefined && leg !== undefined && date.text.includes('/')) {
      const expiry = parseMdy(date.text);
      const m = OPTION_LEG.exec(leg.upper);
      if (expiry !== null && m !== null) {
        const [, right, strikeText] = m;
        const strike = Number(strikeText);
        if (right === undefined || !Number.isFinite(strike) || strike <= 0 || strike > 99_999.999) {
          return fail(problem('BAD_OPTION', `'${leg.text}' is not a strike`, [leg.start, leg.end]));
        }
        const canonicalStrike = decimalText(strike, 3);
        return {
          value: `${root.upper} ${formatExpiry(expiry)} ${right}${canonicalStrike}`,
          form: 'option',
          option: { root: root.upper, expiry: expiry.iso, right: right as 'C' | 'P', strike },
          problems: Object.freeze([]),
        };
      }
      if (expiry !== null && OPTION_LEG.exec(leg.upper) === null && /^[CP]/u.test(leg.upper)) {
        return fail(problem('BAD_OPTION', `'${leg.text}' is not a strike`, [leg.start, leg.end]));
      }
      if (expiry === null && /^\d{1,2}\/\d{1,2}\/\d{2,4}$/u.test(date.text)) {
        return fail(
          problem('BAD_MATURITY', `'${date.text}' is not a date`, [date.start, date.end]),
        );
      }
    }
  }

  // ── bond: TICKER COUPON MM/DD/YY, and the mixed-fraction spelling `T 4 1/4 08/15/36` ─────────
  if (tokens.length === 3 || tokens.length === 4) {
    const ticker = tokens[0];
    const date = tokens[tokens.length - 1];
    if (ticker !== undefined && date?.text.includes('/') === true) {
      let coupon: number | null = null;
      let couponSpan: [number, number] = [0, 0];

      if (tokens.length === 3) {
        const c = tokens[1];
        if (c !== undefined && DECIMAL.test(c.text)) {
          coupon = Number(c.text);
          couponSpan = [c.start, c.end];
        }
      } else {
        const whole = tokens[1];
        const frac = tokens[2];
        const f = frac === undefined ? null : FRACTION.exec(frac.text);
        if (whole !== undefined && frac !== undefined && f !== null && INTEGER.test(whole.text)) {
          const num = Number(f[1]);
          const den = Number(f[2]);
          if (den > 0) {
            coupon = Number(whole.text) + num / den;
            couponSpan = [whole.start, frac.end];
          }
        }
      }

      if (coupon !== null) {
        const maturity = parseMdy(date.text);
        if (maturity === null) {
          return fail(
            problem('BAD_MATURITY', `'${date.text}' is not a maturity`, [date.start, date.end]),
          );
        }
        if (!Number.isFinite(coupon) || coupon < 0 || coupon > 100) {
          return fail(problem('BAD_COUPON', `'${String(coupon)}' is not a coupon`, couponSpan));
        }
        const canonicalCoupon = decimalText(coupon, 6);
        return {
          value: `${ticker.upper} ${canonicalCoupon} ${formatMaturity(maturity)}`,
          form: 'bond',
          bond: { ticker: ticker.upper, coupon, maturity: maturity.iso },
          problems: Object.freeze([]),
        };
      }
    }
  }

  // ── plain ticker ─────────────────────────────────────────────────────────────────────────────
  if (tokens.length > 5) {
    return fail(problem('TOO_MANY_TOKENS', 'a ticker is at most five tokens', span));
  }

  const problems: SecurityRefProblem[] = [];
  const first = tokens[0];
  if (
    tokens.length === 1 &&
    first !== undefined &&
    looksLikeIdentifier(first.upper) &&
    identifierHits(first.upper).length === 0
  ) {
    // Shape of an identifier, but no scheme accepted it: report and fall through to the ticker
    // reading, which is what FUNCTIONS.md L761-762 requires of the identifier anchor.
    problems.push(
      problem(
        'BAD_IDENTIFIER',
        `'${first.text}' has the shape of an identifier but fails its check digit`,
        [first.start, first.end],
      ),
    );
  }

  const value =
    tokens.length === 1 && first !== undefined
      ? canonicaliseTicker(first.upper)
      : tokens.map((t) => t.upper).join(' ');

  return { value, form: 'ticker', problems: Object.freeze(problems) };
}

/* -------------------------------------------------------------------------------------------- */
/* parseSecurityRef                                                                               */
/* -------------------------------------------------------------------------------------------- */

const EXCH_CODE = /^[A-Z]{2}$/;

/**
 * Parse any of the eight reference forms. Never throws, for any input of any type.
 *
 * `{ ok: true }` carries the `SecurityRef`, the production that matched, the canonical spelling and
 * any non-fatal problems (`NOT_IN_UNIVERSE` for a sector outside the wedge, `BAD_IDENTIFIER` for a
 * token shaped like an identifier whose check digit failed). `{ ok: false }` carries every reason.
 */
export function parseSecurityRef(raw: unknown): SecurityRefParseResult {
  if (typeof raw !== 'string') return fail(problem('NOT_A_STRING', 'not a string', [0, 0]));
  if (raw.length > MAX_REF_LENGTH) {
    return fail(
      problem('TOO_LONG', `longer than ${String(MAX_REF_LENGTH)} characters`, [0, raw.length]),
    );
  }

  const tokens = splitTokens(raw);
  if (tokens.length === 0) return fail(problem('EMPTY', 'empty reference', [0, raw.length]));
  if (tokens.length > MAX_REF_TOKENS) {
    return fail(
      problem('TOO_MANY_TOKENS', `more than ${String(MAX_REF_TOKENS)} tokens`, [0, raw.length]),
    );
  }

  const head = tokens[0];
  if (head === undefined) return fail(problem('EMPTY', 'empty reference', [0, raw.length]));

  // ── scheme form ──────────────────────────────────────────────────────────────────────────────
  if (head.text.startsWith('/')) {
    const span: [number, number] = [head.start, head.end];
    const cut = head.text.indexOf('/', 1);
    const scheme = (cut === -1 ? head.text.slice(1) : head.text.slice(1, cut)).toLowerCase();
    const body = cut === -1 ? '' : head.text.slice(cut + 1);

    if (cut === -1 || !SECURITY_REF_SCHEMES.includes(scheme)) {
      // No `/scheme/` at all, or a scheme nobody owns: the command line reads this as a shell word.
      return fail(problem('UNKNOWN_SCHEME', `'${head.text}' is not an identifier`, span));
    }
    if (UNSUPPORTED_REF_SCHEMES.includes(scheme)) {
      return fail(problem('UNSUPPORTED_SCHEME', `'/${scheme}/' has no SecurityRef kind`, span));
    }
    if (body.length === 0) {
      return fail(problem('BAD_IDENTIFIER', `'/${scheme}/' has no value`, span));
    }
    if (tokens.length > 1) {
      const extra = tokens[1];
      return fail(
        problem('TRAILING_TEXT', 'text after an identifier', [
          extra?.start ?? head.end,
          raw.length,
        ]),
      );
    }
    return parseSchemeBody(scheme, body, span);
  }

  // ── bare identifier ──────────────────────────────────────────────────────────────────────────
  if (tokens.length === 1) {
    const hits = identifierHits(head.upper);
    const best = hits[0];
    if (best !== undefined) {
      const problems: SecurityRefProblem[] = [];
      if (hits.length > 1) {
        problems.push(
          problem(
            'AMBIGUOUS_IDENTIFIER',
            `'${head.text}' is a valid ${hits.map((h) => h.scheme.toUpperCase()).join(' and ')}; read as ${best.scheme.toUpperCase()}`,
            [head.start, head.end],
          ),
        );
      }
      const ref: SecurityRef = { kind: best.scheme, value: best.value };
      return {
        ok: true,
        ref,
        form: 'bare',
        canonical: formatSecurityRef(ref),
        sectorGiven: false,
        scheme: best.scheme,
        problems: Object.freeze(problems),
      };
    }
  }

  // ── ticker family: [ticker tokens] [exch] [sector] ───────────────────────────────────────────
  let rest = tokens;
  const problems: SecurityRefProblem[] = [];

  let sector: MarketSector | undefined;
  const last = rest[rest.length - 1];
  if (rest.length > 1 && last !== undefined) {
    const found = resolveSector(last.upper);
    if (found.ok) {
      sector = found.sector;
      rest = rest.slice(0, -1);
      if (!sectorInUniverse(found.sector)) {
        problems.push(
          problem('NOT_IN_UNIVERSE', `no ${found.sector} instrument is in this system's universe`, [
            last.start,
            last.end,
          ]),
        );
      }
    } else if (found.reason === 'ambiguous') {
      problems.push(
        problem('UNKNOWN_SECTOR', `'${last.text}' could be ${found.candidates.join(' or ')}`, [
          last.start,
          last.end,
        ]),
      );
    }
  }

  let exchCode: string | undefined;
  const beforeSector = rest[rest.length - 1];
  if (
    rest.length > 1 &&
    beforeSector !== undefined &&
    EXCH_CODE.test(beforeSector.upper) &&
    (sector === undefined || sector === 'Equity')
  ) {
    exchCode = beforeSector.upper;
    rest = rest.slice(0, -1);
  }

  if (rest.length === 0) {
    // The whole input was a sector word: `Equity` alone is not a security.
    return fail(problem('EMPTY', 'a sector is not a security', [0, raw.length]));
  }

  const body = parseTickerBody(rest);
  if ('ok' in body) return body;

  const ref: SecurityRef = {
    kind: 'ticker',
    value: body.value,
    ...(exchCode === undefined ? {} : { exchCode }),
    ...(sector === undefined ? {} : { sector }),
  };

  return {
    ok: true,
    ref,
    form: body.form,
    canonical: formatSecurityRef(ref),
    sectorGiven: sector !== undefined,
    ...(body.bond === undefined ? {} : { bond: body.bond }),
    ...(body.option === undefined ? {} : { option: body.option }),
    problems: Object.freeze([...problems, ...body.problems]),
  };
}

/** {@link parseSecurityRef} reduced to the ref, or `null`. */
export function parseSecurityRefOrNull(raw: unknown): SecurityRef | null {
  const parsed = parseSecurityRef(raw);
  return parsed.ok ? parsed.ref : null;
}

/** The canonical spelling of a reference string, or `null` when it does not parse. */
export function canonicaliseSecurityRef(raw: unknown): string | null {
  const parsed = parseSecurityRef(raw);
  return parsed.ok ? parsed.canonical : null;
}

/** `true` when the string parses as a security reference. */
export function isSecurityRef(raw: unknown): boolean {
  return parseSecurityRef(raw).ok;
}
