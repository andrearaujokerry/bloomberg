/**
 * The formula scanner — CHRT-07 (WORKPLAN §WP-03 L616-618).
 *
 * One problem dominates this file: `/` is both division and the first character of an identifier,
 * and a security reference is *several whitespace-separated words* (`T 4.25 08/15/36 Govt`) rather
 * than one token. A context-free scanner cannot tell `PX_LAST/PX_CLOSE_1D` (a division of two
 * fields) from `/isin/US0378331005` (one identifier), nor `4.25 08/15/36` (part of a Treasury) from
 * `4.25` divided by `08`.
 *
 * So at every position where an operand may begin, the scanner first asks whether a security
 * reference starts here, by three rules — and `core/ids/securityRef.ts`, the one authority on the
 * grammar, decides each one:
 *
 *   R1  the text begins `/scheme/`                    `/isin/US0378331005`, `/series/fred.csv/DGS10`
 *   R2  a run of 2-7 words ending at a market sector   `AAPL US Equity`, `SPX Index`, `T 4.25 08/15/36 Govt`
 *   R3  one word that is a bare identifier with a
 *       valid check digit                              `BBG000B9XRY4`, `US0378331005`
 *
 * Only if all three decline is one ordinary token — a number, a word or an operator — emitted, and
 * the question is asked again at the next position. That is what lets `PX_LAST/SPX Index` read as
 * "the row's `PX_LAST` divided by the S&P" while `AAPL US Equity` stays one security.
 *
 * Three details make R2 safe, and each is load-bearing:
 *
 *   * **The sector anchor.** Without it `1+2` is a legal ticker token — `parseSecurityRef('1+2').ok`
 *     is `true` — and every sum in every watchlist would silently become a security. A reference is
 *     therefore only recognised when it *ends* at `Equity`, `Index`, `Curncy`, `Govt`, … which is
 *     the canonical spelling anyway (FUNCTIONS.md L846) and the only one that resolves without a
 *     universe.
 *   * **The word shapes.** The words in front of the sector must look like the parts of a reference
 *     — a ticker, an exchange code, a coupon, a date, an option leg. `PX_LAST/SPX Index` fails that
 *     test at `PX_LAST/SPX`, so it is read as arithmetic rather than as a four-token ticker.
 *   * **The nearest anchor wins, and it may end mid-word.** `SPX Index*2` anchors at `Index`, and
 *     scanning resumes at the `*`; a sector name followed immediately by an operator ends the
 *     reference there.
 *
 * The scanner never throws and never stops early: unusable characters become `error` tokens that
 * the parser reports with their span, so a half-typed formula still yields a full token stream.
 */

import { isSectorToken } from '../command/sectors.js';
import type { SecurityRefForm } from '../ids/securityRef.js';
import { isIdentifierToken, MAX_REF_TOKENS, parseSecurityRef } from '../ids/securityRef.js';
import type { SecurityRef } from '../types/instrument.js';

import type { FormulaProblem, FormulaSpan } from './ast.js';
import { formulaProblem, MAX_FORMULA_LENGTH } from './ast.js';

/* -------------------------------------------------------------------------------------------- */
/* Tokens                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** Every token kind the parser dispatches on. */
export type FormulaTokenKind =
  | 'number'
  | 'word'
  | 'ref'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'plus'
  | 'minus'
  | 'star'
  | 'slash'
  | 'error'
  | 'eof';

/** Punctuation and operators carry nothing but their span. */
export interface FormulaPunctToken {
  readonly kind: 'lparen' | 'rparen' | 'comma' | 'plus' | 'minus' | 'star' | 'slash' | 'eof';
  readonly text: string;
  readonly span: FormulaSpan;
}

/** A finite numeric literal. */
export interface FormulaNumberToken {
  readonly kind: 'number';
  readonly text: string;
  readonly span: FormulaSpan;
  readonly value: number;
}

/** A bare word: a field id, or the name in front of a `(`. */
export interface FormulaWordToken {
  readonly kind: 'word';
  readonly text: string;
  readonly span: FormulaSpan;
  readonly upper: string;
}

/** A security reference, already parsed by `core/ids/securityRef.ts`. */
export interface FormulaRefToken {
  readonly kind: 'ref';
  readonly text: string;
  readonly span: FormulaSpan;
  readonly ref: SecurityRef;
  readonly canonical: string;
  readonly form: SecurityRefForm;
}

/** Text the language cannot use. The parser reports it; the scanner walks on. */
export interface FormulaErrorToken {
  readonly kind: 'error';
  readonly text: string;
  readonly span: FormulaSpan;
  readonly problem: FormulaProblem;
}

export type FormulaToken =
  | FormulaPunctToken
  | FormulaNumberToken
  | FormulaWordToken
  | FormulaRefToken
  | FormulaErrorToken;

/** The scan of one formula. `problems` repeats every `error` token's problem, in source order. */
export interface FormulaLexResult {
  readonly raw: string;
  /** The span actually scanned: the inside of a `<…>` wrapper when there was one. */
  readonly body: FormulaSpan;
  /** `true` when a canonical `<…>` wrapper was stripped (FUNCTIONS.md L628). */
  readonly wrapped: boolean;
  /** Always ends with an `eof` token whose span is empty and at `body[1]`. */
  readonly tokens: readonly FormulaToken[];
  readonly problems: readonly FormulaProblem[];
}

/* -------------------------------------------------------------------------------------------- */
/* Character classes                                                                              */
/* -------------------------------------------------------------------------------------------- */

const isSpace = (c: string): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isStructural = (c: string): boolean => c === '(' || c === ')' || c === ',';
const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isLetter = (c: string): boolean => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
const isWordStart = (c: string): boolean => c === '_' || isLetter(c);
const isWordPart = (c: string): boolean => isWordStart(c) || isDigit(c);
/** A reference starts with an identifier character or a `/scheme/`. Nothing else is worth trying. */
const isRefStart = (c: string): boolean => isLetter(c) || isDigit(c) || c === '/';
/** An operator may follow a sector name immediately: `SPX Index*2`. */
const isOperator = (c: string): boolean => c === '+' || c === '-' || c === '*' || c === '/';
/**
 * What a `/scheme/value` may contain. Identifiers are alphanumeric, and a `/series/` value carries
 * the file and the column — `/series/fred.csv/DGS10`. Stopping at `+` and `*` is what lets
 * `SPREAD_RATIO*\/isin\/US0378331005+1` read as arithmetic; `-` and `/` stay inside the value, so
 * an operator after a scheme reference is written with a space (and `formatFormula` prints one).
 */
const isSchemeValueChar = (c: string): boolean =>
  isLetter(c) || isDigit(c) || c === '.' || c === '/' || c === '_' || c === '-';

/** A bare identifier is alphanumeric only; the codecs check length and check digit (R3). */
const BARE_IDENTIFIER = /^[A-Za-z0-9]{6,24}$/;
/** A ticker, an exchange code, a coupon, an option leg: the ordinary words of a reference. */
const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
/** `08/15/36`, `9/16/26` — the maturity and expiry words. */
const DATE_WORD = /^[0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}$/;
/** `BRK/B` — the share-class separator, which only ever appears in the first word. */
const SHARE_CLASS_WORD = /^[A-Za-z]{1,4}\/[A-Za-z]$/;

/** The shortest sector prefix the grammar accepts (FUNCTIONS.md L622: "unique prefix ≥ 3 chars"). */
const SECTOR_MIN_CHARS = 3;
/** `Comdty` is the longest sector name; `Currency` the longest alias. */
const SECTOR_MAX_CHARS = 8;

/* -------------------------------------------------------------------------------------------- */
/* Wrapper                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * The span of the formula inside an optional `<…>` wrapper. The command line's canonical spelling
 * brackets a formula so the tokenizer can take it as one token (FUNCTIONS.md L628, L656-657); the
 * wire carries the bare string (FUNCTIONS.md L1352). Accepting both here means a formula copied off
 * the command line parses unchanged — and spans stay absolute, into the string as given.
 */
export function formulaBody(raw: string): { start: number; end: number; wrapped: boolean } {
  let start = 0;
  let end = raw.length;
  while (start < end) {
    const c = raw[start];
    if (c === undefined || !isSpace(c)) break;
    start++;
  }
  while (end > start) {
    const c = raw[end - 1];
    if (c === undefined || !isSpace(c)) break;
    end--;
  }
  if (end - start >= 2 && raw[start] === '<' && raw[end - 1] === '>') {
    const inner = raw.slice(start + 1, end - 1);
    if (!inner.includes('<') && !inner.includes('>')) {
      return { start: start + 1, end: end - 1, wrapped: true };
    }
  }
  return { start, end, wrapped: false };
}

/* -------------------------------------------------------------------------------------------- */
/* Words                                                                                          */
/* -------------------------------------------------------------------------------------------- */

interface Word {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** The maximal run of non-space, non-structural characters starting at `from`. */
function wordAt(raw: string, from: number, end: number): Word {
  let i = from;
  while (i < end) {
    const c = raw[i];
    if (c === undefined || isSpace(c) || isStructural(c)) break;
    i++;
  }
  return { text: raw.slice(from, i), start: from, end: i };
}

/** Up to `max` further words after `from`, stopping at the first structural character or at `end`. */
function wordsAfter(raw: string, from: number, end: number, max: number): Word[] {
  const words: Word[] = [];
  let i = from;
  while (words.length < max) {
    while (i < end) {
      const c = raw[i];
      if (c === undefined || !isSpace(c)) break;
      i++;
    }
    if (i >= end) break;
    const c = raw[i];
    if (c === undefined || isStructural(c)) break;
    const word = wordAt(raw, i, end);
    if (word.end === word.start) break;
    words.push(word);
    i = word.end;
  }
  return words;
}

/** `true` when a word can be part of a reference in front of its sector. */
function isReferenceWord(text: string, first: boolean): boolean {
  if (PLAIN_WORD.test(text)) return true;
  if (DATE_WORD.test(text)) return true;
  return first && SHARE_CLASS_WORD.test(text);
}

/**
 * How many characters of `text` are a market sector that an operator immediately follows, or `null`.
 * `Index*2` cuts after `Index`; `INDEXCO` does not cut, because `CO` is not an operator.
 */
function sectorCut(text: string): number | null {
  const limit = Math.min(text.length - 1, SECTOR_MAX_CHARS);
  for (let length = limit; length >= SECTOR_MIN_CHARS; length--) {
    const after = text[length];
    if (after === undefined || !isOperator(after)) continue;
    if (isSectorToken(text.slice(0, length))) return length;
  }
  return null;
}

/* -------------------------------------------------------------------------------------------- */
/* The scanner                                                                                    */
/* -------------------------------------------------------------------------------------------- */

const PUNCT: Readonly<Record<string, FormulaPunctToken['kind']>> = Object.freeze({
  '(': 'lparen',
  ')': 'rparen',
  ',': 'comma',
  '+': 'plus',
  '-': 'minus',
  '*': 'star',
  '/': 'slash',
});

function eofToken(at: number): FormulaPunctToken {
  return { kind: 'eof', text: '', span: [at, at] };
}

/**
 * Scan `raw` into tokens. Total: every input yields a token stream ending in `eof`, every character
 * of the body belongs to exactly one token or is whitespace, and the scan always advances.
 */
export function lexFormula(raw: unknown): FormulaLexResult {
  if (typeof raw !== 'string') {
    const span: FormulaSpan = [0, 0];
    return Object.freeze({
      raw: '',
      body: span,
      wrapped: false,
      tokens: Object.freeze([eofToken(0)]),
      problems: Object.freeze([formulaProblem('NOT_A_STRING', 'a formula is a string', span)]),
    });
  }

  if (raw.length > MAX_FORMULA_LENGTH) {
    const span: FormulaSpan = [0, raw.length];
    return Object.freeze({
      raw,
      body: span,
      wrapped: false,
      tokens: Object.freeze([eofToken(raw.length)]),
      problems: Object.freeze([
        formulaProblem(
          'TOO_LONG',
          `a formula is at most ${String(MAX_FORMULA_LENGTH)} characters`,
          span,
        ),
      ]),
    });
  }

  const tokens: FormulaToken[] = [];
  const problems: FormulaProblem[] = [];
  const pushError = (text: string, problem: FormulaProblem): void => {
    tokens.push({ kind: 'error', text, span: problem.span, problem });
    problems.push(problem);
  };
  const pushRef = (word: { text: string; start: number; end: number }, parsed: { ref: SecurityRef; canonical: string; form: SecurityRefForm }): void => {
    tokens.push({
      kind: 'ref',
      text: word.text,
      span: [word.start, word.end],
      ref: parsed.ref,
      canonical: parsed.canonical,
      form: parsed.form,
    });
  };

  const { start, end, wrapped } = formulaBody(raw);

  let i = start;
  while (i < end) {
    const c = raw[i];
    if (c === undefined) break;

    if (isSpace(c)) {
      i++;
      continue;
    }

    const punct = PUNCT[c];
    if (punct !== undefined && isStructural(c)) {
      tokens.push({ kind: punct, text: c, span: [i, i + 1] });
      i++;
      continue;
    }

    if (isRefStart(c)) {
      const next = scanReference(raw, i, end, pushRef, pushError);
      if (next > i) {
        i = next;
        continue;
      }
    }

    i = scanToken(raw, i, end, tokens, pushError);
  }

  tokens.push(eofToken(end));
  return Object.freeze({
    raw,
    body: [start, end] as FormulaSpan,
    wrapped,
    tokens: Object.freeze(tokens),
    problems: Object.freeze(problems),
  });
}

/**
 * The three reference rules, at position `from`. Returns the position just past the reference, or
 * `from` when none of them matched and an ordinary token should be scanned instead.
 */
function scanReference(
  raw: string,
  from: number,
  end: number,
  pushRef: (
    word: Word,
    parsed: { ref: SecurityRef; canonical: string; form: SecurityRefForm },
  ) => void,
  pushError: (text: string, problem: FormulaProblem) => void,
): number {
  const first = wordAt(raw, from, end);
  if (first.end === first.start) return from;

  // R1 — `/scheme/value`. A leading `/` that is not a scheme is division; say so by declining.
  if (first.text.startsWith('/')) {
    let stop = first.start;
    while (stop < first.end && isSchemeValueChar(raw[stop] ?? '')) stop++;
    const text = raw.slice(first.start, stop);
    if (!isIdentifierToken(text)) return from;
    const parsed = parseSecurityRef(text);
    if (parsed.ok) {
      pushRef({ text, start: first.start, end: stop }, parsed);
    } else {
      const reason = parsed.problems[0]?.message ?? 'not a security reference';
      pushError(
        text,
        formulaProblem('BAD_SECURITY_REF', `'${text}': ${reason}`, [first.start, stop]),
      );
    }
    return stop;
  }

  // R2 — words ending at a market sector, nearest anchor first. Checked before R3 so that
  // `912797VE4 Govt` is the Treasury rather than the bare CUSIP with a stray word after it.
  if (isReferenceWord(first.text, true)) {
    const rest = wordsAfter(raw, first.end, end, MAX_REF_TOKENS - 1);
    for (const word of rest) {
      if (!isLetter(word.text[0] ?? '')) {
        // Not a sector, so it must be usable as an inner word of the reference — or R2 is over.
        if (!isReferenceWord(word.text, false)) break;
        continue;
      }
      let stop: number | null = null;
      if (isSectorToken(word.text)) stop = word.end;
      else {
        const cut = sectorCut(word.text);
        if (cut !== null) stop = word.start + cut;
      }
      if (stop === null) {
        if (!isReferenceWord(word.text, false)) break;
        continue;
      }
      const text = raw.slice(first.start, stop);
      const parsed = parseSecurityRef(text);
      if (parsed.ok) {
        pushRef({ text, start: first.start, end: stop }, parsed);
        return stop;
      }
      // The anchor was real but the reference was not; anything further is not one either.
      break;
    }
  }

  // R3 — a bare identifier, recognised by shape *and* check digit. Like a sector, it may be
  // followed immediately by an operator: `BBG000B9XRY4*2`.
  let idLength = 0;
  while (idLength < first.text.length) {
    const c = first.text[idLength];
    if (c === undefined || !(isLetter(c) || isDigit(c))) break;
    idLength++;
  }
  const after = first.text[idLength];
  if ((after === undefined || isOperator(after)) && BARE_IDENTIFIER.test(first.text.slice(0, idLength))) {
    const text = first.text.slice(0, idLength);
    const parsed = parseSecurityRef(text);
    if (parsed.ok && parsed.form === 'bare') {
      pushRef({ text, start: first.start, end: first.start + idLength }, parsed);
      return first.start + idLength;
    }
  }

  return from;
}

/** Emit exactly one ordinary token at `from`, and return the position after it. */
function scanToken(
  raw: string,
  from: number,
  end: number,
  tokens: FormulaToken[],
  pushError: (text: string, problem: FormulaProblem) => void,
): number {
  const c = raw[from];
  if (c === undefined) return from + 1;

  if (isDigit(c) || (c === '.' && isDigit(raw[from + 1] ?? ''))) {
    let i = from;
    while (i < end && isDigit(raw[i] ?? '')) i++;
    if (i < end && raw[i] === '.') {
      i++;
      while (i < end && isDigit(raw[i] ?? '')) i++;
    }
    // An exponent counts only when it is complete: `1e3`, `1e-3`. `1e` is `1` and then the word `e`.
    if (i < end && (raw[i] === 'e' || raw[i] === 'E')) {
      let j = i + 1;
      if (j < end && (raw[j] === '+' || raw[j] === '-')) j++;
      if (j < end && isDigit(raw[j] ?? '')) {
        while (j < end && isDigit(raw[j] ?? '')) j++;
        i = j;
      }
    }
    const text = raw.slice(from, i);
    const value = Number(text);
    if (Number.isFinite(value)) tokens.push({ kind: 'number', text, span: [from, i], value });
    else {
      pushError(text, formulaProblem('UNEXPECTED_CHAR', `'${text}' is not a number`, [from, i]));
    }
    return i;
  }

  if (isWordStart(c)) {
    let i = from;
    while (i < end && isWordPart(raw[i] ?? '')) i++;
    const text = raw.slice(from, i);
    tokens.push({ kind: 'word', text, span: [from, i], upper: text.toUpperCase() });
    return i;
  }

  const punct = PUNCT[c];
  if (punct !== undefined) {
    tokens.push({ kind: punct, text: c, span: [from, from + 1] });
    return from + 1;
  }

  // Everything else — `#`, `=`, `<`, an emoji surrogate pair — is one error token per code point.
  const code = raw.codePointAt(from);
  const width = code !== undefined && code > 0xffff ? 2 : 1;
  const text = raw.slice(from, from + width);
  pushError(
    text,
    formulaProblem('UNEXPECTED_CHAR', `'${text}' has no meaning in a formula`, [
      from,
      from + width,
    ]),
  );
  return from + width;
}
