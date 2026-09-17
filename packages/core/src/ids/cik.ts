/**
 * CIK — the SEC's Central Index Key, and the one identifier in the system that has **two** correct
 * spellings (WORKPLAN §WP-03 L583, PROVIDERS.md §7 L1268-1272):
 *
 * ```
 *  data.sec.gov  https://data.sec.gov/submissions/CIK0000320193.json   ← zero-padded to ten
 *  /Archives     https://www.sec.gov/Archives/edgar/data/884394/…      ← bare, no padding
 * ```
 *
 * Storage (`issuers.cik char(10)`, `filings.cik`, `identifiers.value`) holds the padded form;
 * `/Archives` paths need the bare one. Getting it backwards returns a `404` that looks exactly like
 * a delisting, which is why PROVIDERS.md names this file as the only place that converts.
 *
 * {@link pad} and {@link unpad} are therefore **total and mutually inverse**: every input has a
 * defined result, nothing throws, and for any CIK
 *
 * ```ts
 * pad(unpad(x)) === pad(x)        unpad(pad(x)) === unpad(x)
 * pad(pad(x))   === pad(x)        unpad(unpad(x)) === unpad(x)
 * ```
 *
 * Inputs that are not CIKs — the empty string, `'0000000000'`, a float, `null` — produce `null`
 * rather than an exception, because the alternative is a throw on the hot path of a provider
 * adapter parsing a capture file. Both functions accept every spelling the SEC itself emits: the
 * integer `1045810` (`company_tickers.json` `cik_str`), the padded string `'0001045810'`, and the
 * `'CIK0001045810'` form that appears in `submissions.filings.files[].name`.
 */

/** The width of the zero-padded form `data.sec.gov` requires. */
export const CIK_PADDED_LENGTH = 10;

/** The largest CIK the ten-digit form can hold. */
export const CIK_MAX = 9_999_999_999;

/** Why an input is not a CIK. */
export type CikProblemCode =
  /** Not a string or a number. */
  | 'not-a-string-or-number'
  /** A number that is not a non-negative safe integer (NaN, Infinity, 1.5, -3). */
  | 'not-an-integer'
  /** Empty, or whitespace / a bare `CIK` prefix only. */
  | 'empty'
  /** A character that is not a digit (after the optional `CIK` prefix is removed). */
  | 'non-digit'
  /** More than ten significant digits. */
  | 'too-long'
  /** Numerically zero — there is no CIK 0. */
  | 'zero';

/** One reason an input is not a CIK. `index` is an offset into the normalised text, or -1. */
export interface CikProblem {
  readonly code: CikProblemCode;
  readonly message: string;
  readonly index: number;
}

/** A successful parse: both spellings, plus the numeric value. */
export interface CikParseOk {
  readonly ok: true;
  /** The zero-padded ten-character form, e.g. `'0000320193'` — what every `cik` column holds. */
  readonly padded: string;
  /** The bare form with no leading zeros, e.g. `'320193'` — what `/Archives` paths take. */
  readonly bare: string;
  /** The numeric value, always a safe integer ≥ 1. */
  readonly value: number;
  readonly problems: readonly CikProblem[];
}

/** A failed parse: every reason found, never an exception. */
export interface CikParseFail {
  readonly ok: false;
  readonly padded: null;
  readonly bare: null;
  readonly value: null;
  readonly problems: readonly CikProblem[];
}

/** The result of {@link parseCik}; narrow on `ok`. */
export type CikParseResult = CikParseOk | CikParseFail;

/**
 * Strip whitespace and an optional case-insensitive `CIK` prefix.
 * `'  CIK0000320193 '` → `'0000320193'`.
 */
function strip(raw: string): string {
  let s = raw.trim();
  if (s.length >= 3 && s.slice(0, 3).toUpperCase() === 'CIK') s = s.slice(3).trim();
  return s;
}

function isDigits(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

/**
 * Parse any of the spellings the SEC emits into both canonical forms. Total: any value at all may
 * be passed, and the function never throws.
 */
export function parseCik(raw: unknown): CikParseResult {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) {
      return fail({
        code: 'not-an-integer',
        message: `a CIK is a non-negative integer; received ${String(raw)}`,
        index: -1,
      });
    }
    if (raw === 0) {
      return fail({ code: 'zero', message: 'there is no CIK 0', index: -1 });
    }
    if (raw > CIK_MAX) {
      return fail({
        code: 'too-long',
        message: `a CIK has at most ${String(CIK_PADDED_LENGTH)} digits; received ${String(raw)}`,
        index: -1,
      });
    }
    const bare = String(raw);
    return {
      ok: true,
      padded: bare.padStart(CIK_PADDED_LENGTH, '0'),
      bare,
      value: raw,
      problems: [],
    };
  }

  if (typeof raw !== 'string') {
    return fail({
      code: 'not-a-string-or-number',
      message: `expected a string or a number, received ${typeOf(raw)}`,
      index: -1,
    });
  }

  const s = strip(raw);
  if (s.length === 0) {
    return fail({ code: 'empty', message: 'a CIK has at least one digit', index: -1 });
  }
  if (!isDigits(s)) {
    let index = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x30 || c > 0x39) {
        index = i;
        break;
      }
    }
    return fail({
      code: 'non-digit',
      message: `a CIK is digits only; found ${JSON.stringify(s.charAt(index))}`,
      index,
    });
  }

  // Strip leading zeros to get the significant digits; '0000000000' collapses to ''.
  let i = 0;
  while (i < s.length && s.charAt(i) === '0') i++;
  const bare = s.slice(i);

  if (bare.length === 0) {
    return fail({ code: 'zero', message: 'there is no CIK 0', index: -1 });
  }
  if (bare.length > CIK_PADDED_LENGTH) {
    return fail({
      code: 'too-long',
      message: `a CIK has at most ${String(CIK_PADDED_LENGTH)} significant digits; this has ${String(bare.length)}`,
      index: -1,
    });
  }

  return {
    ok: true,
    padded: bare.padStart(CIK_PADDED_LENGTH, '0'),
    bare,
    value: Number(bare),
    problems: [],
  };
}

/**
 * The zero-padded ten-character CIK `data.sec.gov` requires: `pad('320193') === '0000320193'`,
 * `pad(320193) === '0000320193'`, `pad('CIK0000320193') === '0000320193'`.
 *
 * @returns the padded form, or `null` when `cik` is not a CIK. Never throws.
 */
export function pad(cik: string | number): string | null {
  const r = parseCik(cik);
  return r.ok ? r.padded : null;
}

/**
 * The bare CIK an `/Archives/edgar/data/` path takes: `unpad('0000884394') === '884394'`.
 *
 * @returns the unpadded form, or `null` when `cik` is not a CIK. Never throws.
 */
export function unpad(cik: string | number): string | null {
  const r = parseCik(cik);
  return r.ok ? r.bare : null;
}

/** Explicit alias of {@link pad}, for call sites that import several id codecs at once. */
export const padCik = pad;

/** Explicit alias of {@link unpad}, for call sites that import several id codecs at once. */
export const unpadCik = unpad;

/** True when `raw` is a CIK in any of its accepted spellings. Never throws. */
export function isValidCik(raw: unknown): boolean {
  return parseCik(raw).ok;
}

/**
 * The `CIK##########` form used in `data.sec.gov/submissions/` URLs and in
 * `submissions.filings.files[].name`, or `null`. Never throws.
 */
export function cikUrlKey(cik: string | number): string | null {
  const p = pad(cik);
  return p === null ? null : `CIK${p}`;
}

function fail(problem: CikProblem): CikParseFail {
  return { ok: false, padded: null, bare: null, value: null, problems: [problem] };
}

/** A description of an arbitrary runtime value, for problem messages. */
function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}
