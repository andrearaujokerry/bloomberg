// packages/core/src/command/tokenizer.ts
//
// The command line's lexer (FUNCTIONS.md §2.2 L642-656, CONTRACTS §4.1 L651-652).
//
// Five rules, and nothing else:
//
//  1. split on runs of spaces and tabs (`token := [^ \t]+`, §2.1 L633), keeping the half-open
//     `[start, end)` span into `raw` so every problem the parser reports can be underlined;
//  2. a `<…>` formula is ONE token, from the `<` to the matching `>`, whitespace inside preserved;
//     a bare `NAME( … )` formula is one token from the name to the balancing `)`;
//  3. `KEY=VALUE` stays one token, and a quoted value (`KEY="two words"`) is one token with the
//     quotes stripped from `text` — the span still covers them, because the span addresses `raw`;
//  4. ticker normalisation is `ids/securityRef.ts`'s job: the tokenizer NEVER rewrites text;
//  5. `text` keeps the raw case (free text and quoted values depend on it), `upper` is the
//     upper-cased copy every case-insensitive comparison downstream uses.
//
// Totality (QA-05): `tokenize` accepts any string — unbalanced brackets, lone quotes, control
// characters, 100 kB of astral-plane junk — and always returns tokens whose spans are inside
// `[0, raw.length]`, strictly ordered and non-empty. It never throws and never loops: every branch
// consumes at least one code unit.

/** One lexeme with its exact source span. `raw.slice(start, end)` is what the user typed. */
export interface Token {
  text: string;
  upper: string;
  start: number;
  end: number;
}

/** The quote character a value may be wrapped in (§2.2 rule 3). */
export const QUOTE = '"';

/** A bare formula's head: `RATIO(`, `MA(` — §2.1 L629 `tokens[0]` matches `/^[A-Z]+\(/`. */
const BARE_FORMULA_HEAD = /^[A-Za-z]+\(/u;

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t';

/**
 * The index just past the `>` that closes the `<` at `from`, or `-1` when nothing closes it.
 *
 * A `>` closes its `<` only at the parenthesis depth the `<` was opened at, so both
 * `<MA(<RATIO(A,B)>,50)>` (nested angles) and `<RATIO(A>B)>` (a comparison inside the body) are one
 * token. Without the depth test the two spellings of a formula disagree — the bare `NAME(…)` scan
 * below ends at the balancing `)`, so `RATIO(A>B)` is one token while `<RATIO(A>B)>` would end at
 * the `>` in the middle — and `insertText` would stop being a fixed point of `parse` (QA-05).
 */
function closeAngleBalanced(raw: string, from: number): number {
  // The parenthesis depth each open `<` was seen at; the innermost is last.
  const opened: number[] = [];
  let parens = 0;
  for (let i = from; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (ch === '<') opened.push(parens);
    else if (ch === '(') parens++;
    else if (ch === ')') {
      if (parens > 0) parens--;
    } else if (ch === '>') {
      if (opened.length > 0 && opened[opened.length - 1] === parens) {
        opened.pop();
        if (opened.length === 0) return i + 1;
      }
    }
  }
  return -1;
}

/** The plain scan: `>` closes `<` whatever the parentheses are doing. */
function closeAngleFlat(raw: string, from: number): number {
  let depth = 0;
  for (let i = from; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (ch === '<') depth++;
    else if (ch === '>') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The index just past the `>` that closes the `<` at `from`, or `-1` when nothing closes it.
 *
 * The parenthesis-aware scan runs first; when it finds nothing — a half-typed `<MA(PX_LAST, 50>`
 * whose parentheses never balance — the flat scan still closes the token, so partially typed input
 * keeps lexing as the single formula token it did before.
 */
function closeAngle(raw: string, from: number): number {
  const balanced = closeAngleBalanced(raw, from);
  return balanced === -1 ? closeAngleFlat(raw, from) : balanced;
}

/**
 * The index just past the `)` that balances the bare formula starting at `from`, or `-1` when the
 * token is not a bare formula (no `NAME(` head) or its parentheses never balance.
 */
function closeBareFormula(raw: string, from: number): number {
  // A head of at most 32 letters: `RATIO(`, `SPREAD(`. The slice is bounded so a megabyte of
  // letters is not copied on every token.
  if (!BARE_FORMULA_HEAD.test(raw.slice(from, from + 33))) return -1;
  let i = raw.indexOf('(', from);
  if (i === -1) return -1;
  let depth = 0;
  for (; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** `true` when `text` is a whole formula token: `<…>` or a balanced `NAME(…)`. */
export function isFormulaToken(text: unknown): boolean {
  if (typeof text !== 'string' || text.length < 3) return false;
  if (text.startsWith('<')) return closeAngle(text, 0) === text.length;
  return closeBareFormula(text, 0) === text.length;
}

/**
 * The formula inside a formula token: `'<RATIO(A, B)>'` → `'RATIO(A, B)'`, and a bare
 * `'RATIO(A, B)'` → itself. Returns `null` when `text` is not a formula token.
 */
export function formulaBody(text: unknown): string | null {
  if (!isFormulaToken(text) || typeof text !== 'string') return null;
  return text.startsWith('<') ? text.slice(1, -1).trim() : text.trim();
}

/**
 * The single-token spelling of a formula body — what `insertText` and `CommandSecurity.text` carry.
 *
 * The `<…>` form is canonical and is used whenever it re-lexes to the same body. It does not always:
 * a body may itself contain an unpaired `<` (`RATIO(A<B)`), and wrapping that would produce a string
 * the lexer splits somewhere else, so GO would run a different command from the row it was shown on.
 * When the angle form does not round-trip, the bare `NAME(…)` spelling — which ends at the balancing
 * `)` and therefore survives any operator inside it — is emitted instead. The check is performed
 * rather than predicted, so the two spellings can never drift apart (QA-05 idempotence).
 */
export function formulaTokenText(body: string): string {
  const wrapped = `<${body}>`;
  if (formulaBody(wrapped) === body) return wrapped;
  return isFormulaToken(body) ? body : wrapped;
}

/**
 * Re-quote a token's `text` so that `tokenize(quoteToken(t))` yields the same `text` again.
 *
 * Only whitespace needs quoting: a token's `text` can never contain a `"` (the lexer consumes
 * quotes as mode switches and never copies them), and a formula token re-lexes as one token on its
 * own. This is what makes `insertText` a fixed point of `parse` (QA-05's idempotence check).
 */
export function quoteToken(text: string): string {
  // An explicitly empty token (`""`) must survive the round trip, or re-parsing `insertText` would
  // silently drop an argument.
  if (text.length === 0) return `${QUOTE}${QUOTE}`;
  if (isFormulaToken(text)) return text;
  const eq = text.indexOf('=');
  const spaced = /[ \t]/u.test(text);
  // Whitespace is not the only thing that needs quoting. A token whose text merely *starts* a
  // formula — `<RATIO(A>B)>'`, which the lexer produced because the user typed `""` in front of it —
  // re-lexes into two tokens, since the `<…>` scan ends before the text does. The test is performed
  // rather than predicted: whatever the lexer does, a token that does not come back as itself is
  // quoted, which forces the ordinary scan and makes `insertText` a fixed point (QA-05).
  if (!spaced) {
    const relexed = tokenize(text);
    if (relexed.length === 1 && relexed[0]?.text === text) return text;
  }
  // `KEY=two words` re-quotes as `KEY="two words"`, which is how it was typed.
  if (eq > 0 && !/[ \t]/u.test(text.slice(0, eq))) {
    return `${text.slice(0, eq + 1)}${QUOTE}${text.slice(eq + 1)}${QUOTE}`;
  }
  return `${QUOTE}${text}${QUOTE}`;
}

/** Join tokens back into a command line, quoting what needs it (`insertText` assembly). */
export function joinTokens(texts: readonly string[]): string {
  return texts.map(quoteToken).join(' ');
}

/**
 * Split `raw` into tokens (FUNCTIONS.md §2.2). Total: never throws, for any input.
 */
export function tokenize(raw: string): Token[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];

  const tokens: Token[] = [];
  const n = raw.length;
  let i = 0;

  while (i < n) {
    if (isSpace(raw.charAt(i))) {
      i++;
      continue;
    }

    const start = i;

    // ── rule 2: a whole formula is one token, whitespace and all ─────────────────────────────
    const angle = raw.charAt(i) === '<' ? closeAngle(raw, i) : -1;
    const bare = angle === -1 ? closeBareFormula(raw, i) : -1;
    const formulaEnd = angle !== -1 ? angle : bare;
    if (formulaEnd > start) {
      const text = raw.slice(start, formulaEnd);
      tokens.push({ text, upper: text.toUpperCase(), start, end: formulaEnd });
      i = formulaEnd;
      continue;
    }

    // ── rules 1 and 3: an ordinary token, with quoted runs spliced in ────────────────────────
    let text = '';
    let inQuote = false;
    while (i < n) {
      const ch = raw.charAt(i);
      if (ch === QUOTE) {
        inQuote = !inQuote;
        i++;
        continue;
      }
      if (!inQuote && isSpace(ch)) break;
      text += ch;
      i++;
    }

    // `""` is a token the user typed (an explicitly empty value); it keeps its span and is handed
    // to the parser, which decides what an empty argument means. A zero-length span never occurs
    // for any other reason, because every other branch copied at least one character.
    tokens.push({ text, upper: text.toUpperCase(), start, end: i });
  }

  return tokens;
}
