/**
 * The formula parser — CHRT-07 (WORKPLAN §WP-03 L616-618).
 *
 * Recursive descent over `lexer.ts`'s tokens, with two hard guarantees that QA-05 pins:
 *
 *   1. **It never throws.** Every input — a stray `)`, a hundred `(`, an emoji, the empty string,
 *      something that is not a string at all — returns a {@link FormulaParseResult} whose
 *      `problems` say what was wrong and where. There is no path out of this file that raises.
 *   2. **It always terminates.** Every loop consumes a token before it iterates, `primary()`
 *      reports a missing operand *without* consuming only at a token a caller has already agreed to
 *      stop at, and depth is capped at `MAX_FORMULA_DEPTH` by an abort flag rather than by
 *      unwinding. A 400-character adversarial string is bounded work.
 *
 * After the tree is built it is checked statically, which is where `RATIO(1)`, `MA(PX_LAST+1, 50)`
 * and `MA(PX_LAST, 0)` are caught: arity, series-valued arguments and integer windows are properties
 * of the text, so they are parse problems rather than evaluation surprises.
 */

import type {
  FormulaFunctionName,
  FormulaNode,
  FormulaProblem,
  FormulaSpan,
} from './ast.js';
import {
  formatFormula,
  formulaProblem,
  hasErrorNode,
  isSeriesNode,
  lookupFormulaFunction,
  MAX_FORMULA_ARGS,
  MAX_FORMULA_DEPTH,
  MAX_FORMULA_WINDOW,
  walkFormula,
} from './ast.js';
import type { FormulaToken } from './lexer.js';
import { lexFormula } from './lexer.js';

/** The result of parsing. `ok` means: a complete tree, no holes, no problems. */
export interface FormulaParseResult {
  readonly ok: boolean;
  /** The input, or `''` when it was not a string. */
  readonly raw: string;
  /** The tree, or `null` when there was nothing to parse at all. */
  readonly ast: FormulaNode | null;
  /** The canonical re-print of `ast`, or `null`. Stable: parsing it yields the same tree. */
  readonly canonical: string | null;
  readonly problems: readonly FormulaProblem[];
  readonly tokens: readonly FormulaToken[];
}

const EMPTY_SPAN: FormulaSpan = [0, 0];

class Parser {
  private index = 0;
  private depth = 0;
  private aborted = false;
  readonly problems: FormulaProblem[] = [];

  constructor(private readonly tokens: readonly FormulaToken[]) {}

  private peek(): FormulaToken {
    const token = this.tokens[this.index];
    if (token !== undefined) return token;
    const last = this.tokens[this.tokens.length - 1];
    return last ?? { kind: 'eof', text: '', span: EMPTY_SPAN };
  }

  private next(): FormulaToken {
    const token = this.peek();
    if (this.index < this.tokens.length - 1) this.index++;
    return token;
  }

  private atEnd(): boolean {
    return this.peek().kind === 'eof';
  }

  private problem(code: FormulaProblem['code'], message: string, span: FormulaSpan): void {
    this.problems.push(formulaProblem(code, message, span));
  }

  /** `expr := term (('+' | '-') term)*` */
  private expression(): FormulaNode {
    if (this.aborted) return this.hole();
    if (++this.depth > MAX_FORMULA_DEPTH) {
      this.abort(this.peek().span);
      this.depth--;
      return this.hole();
    }
    let left = this.term();
    for (;;) {
      if (this.aborted) break;
      const token = this.peek();
      if (token.kind !== 'plus' && token.kind !== 'minus') break;
      this.next();
      const right = this.term();
      left = {
        kind: 'binary',
        op: token.kind === 'plus' ? '+' : '-',
        left,
        right,
        span: [left.span[0], right.span[1]],
      };
    }
    this.depth--;
    return left;
  }

  /** `term := unary (('*' | '/') unary)*` */
  private term(): FormulaNode {
    if (this.aborted) return this.hole();
    let left = this.unary();
    for (;;) {
      if (this.aborted) break;
      const token = this.peek();
      if (token.kind !== 'star' && token.kind !== 'slash') break;
      this.next();
      const right = this.unary();
      left = {
        kind: 'binary',
        op: token.kind === 'star' ? '*' : '/',
        left,
        right,
        span: [left.span[0], right.span[1]],
      };
    }
    return left;
  }

  /** `unary := ('+' | '-') unary | primary` */
  private unary(): FormulaNode {
    if (this.aborted) return this.hole();
    const token = this.peek();
    if (token.kind === 'plus' || token.kind === 'minus') {
      this.next();
      if (++this.depth > MAX_FORMULA_DEPTH) {
        this.abort(token.span);
        this.depth--;
        return this.hole(token.span);
      }
      const operand = this.unary();
      this.depth--;
      return {
        kind: 'unary',
        op: token.kind === 'plus' ? '+' : '-',
        operand,
        span: [token.span[0], operand.span[1]],
      };
    }
    return this.primary();
  }

  private primary(): FormulaNode {
    if (this.aborted) return this.hole();
    const token = this.peek();
    switch (token.kind) {
      case 'number':
        this.next();
        return { kind: 'number', value: token.value, span: token.span };

      case 'ref':
        this.next();
        return {
          kind: 'security',
          ref: token.ref,
          canonical: token.canonical,
          text: token.text,
          span: token.span,
        };

      case 'word': {
        this.next();
        if (this.peek().kind === 'lparen') return this.call(token.upper, token.span);
        return { kind: 'field', field: token.upper, span: token.span };
      }

      case 'lparen': {
        this.next();
        if (++this.depth > MAX_FORMULA_DEPTH) {
          this.abort(token.span);
          this.depth--;
          return this.hole(token.span);
        }
        const inner = this.expression();
        this.depth--;
        const close = this.peek();
        if (close.kind === 'rparen') {
          this.next();
          return inner;
        }
        this.problem('UNBALANCED_PAREN', "'(' with no matching ')'", [
          token.span[0],
          close.span[1],
        ]);
        return inner;
      }

      case 'error':
        // The scanner already reported it; consuming it keeps the scan and the parse in step.
        this.next();
        return this.hole(token.span);

      case 'rparen':
        // Reported here rather than swallowed: a lone ')' is the commonest half-typed formula.
        this.problem('UNBALANCED_PAREN', "')' with no matching '('", token.span);
        this.next();
        return this.hole(token.span);

      default:
        // `,`, an operator with nothing to its right, or the end of the input. Not consumed: the
        // caller decides what to do with it, which is what keeps `MA(,)` and `1+` terminating.
        this.problem(
          'MISSING_OPERAND',
          token.kind === 'eof'
            ? 'the formula ends where a value was expected'
            : `'${token.text}' is not a value`,
          token.span,
        );
        return this.hole(token.span);
    }
  }

  /** `NAME '(' expr (',' expr)* ')'` — the `(` is the current token. */
  private call(upper: string, nameSpan: FormulaSpan): FormulaNode {
    const open = this.next(); // '('
    const args: FormulaNode[] = [];
    if (++this.depth > MAX_FORMULA_DEPTH) {
      this.abort(open.span);
      this.depth--;
      return this.hole([nameSpan[0], open.span[1]]);
    }

    if (this.peek().kind !== 'rparen') {
      for (;;) {
        if (this.aborted) break;
        const arg = this.expression();
        if (args.length < MAX_FORMULA_ARGS) args.push(arg);
        if (this.peek().kind !== 'comma') break;
        this.next();
      }
    }
    this.depth--;

    const close = this.peek();
    const endsAt = close.span[1];
    if (close.kind === 'rparen') {
      this.next();
    } else if (!this.aborted) {
      this.problem('UNBALANCED_PAREN', `'${upper}(' with no matching ')'`, [
        nameSpan[0],
        close.span[1],
      ]);
    }

    const spec = lookupFormulaFunction(upper);
    if (spec === null) {
      this.problem(
        'UNKNOWN_FUNCTION',
        `'${upper}' is not a formula function (RATIO, SPREAD, NORM, MA)`,
        nameSpan,
      );
      return this.hole([nameSpan[0], endsAt]);
    }

    return {
      kind: 'call',
      name: spec.name,
      args: Object.freeze(args),
      nameSpan,
      span: [nameSpan[0], endsAt],
    };
  }

  private abort(span: FormulaSpan): void {
    if (this.aborted) return;
    this.aborted = true;
    this.problem(
      'TOO_DEEP',
      `a formula nests at most ${String(MAX_FORMULA_DEPTH)} levels deep`,
      span,
    );
    // Consume the rest so the caller does not also report trailing input.
    while (!this.atEnd()) this.next();
  }

  private hole(span?: FormulaSpan): FormulaNode {
    const at = span ?? this.peek().span;
    return { kind: 'error', span: [at[0], at[1]] };
  }

  parse(): FormulaNode {
    const node = this.expression();
    if (!this.aborted && !this.atEnd()) {
      const token = this.peek();
      const last = this.tokens[this.tokens.length - 1];
      const span: FormulaSpan = [token.span[0], last?.span[1] ?? token.span[1]];
      if (token.kind === 'rparen') this.problem('UNBALANCED_PAREN', "')' with no matching '('", span);
      else this.problem('TRAILING_INPUT', `unexpected '${token.text}' after the formula`, span);
    }
    return node;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Static checks                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/** Arity, series-valued arguments and integer windows — everything decidable without data. */
function checkStatically(root: FormulaNode, problems: FormulaProblem[]): void {
  walkFormula(root, (node) => {
    if (node.kind !== 'call') return;
    const spec = lookupFormulaFunction(node.name);
    if (spec === null) return;

    if (node.args.length < spec.minArgs || node.args.length > spec.maxArgs) {
      const arity =
        spec.minArgs === spec.maxArgs
          ? String(spec.minArgs)
          : `${String(spec.minArgs)}-${String(spec.maxArgs)}`;
      problems.push(
        formulaProblem(
          'BAD_ARITY',
          `${node.name} takes ${arity} arguments, not ${String(node.args.length)}`,
          node.span,
        ),
      );
      return;
    }

    for (const index of spec.seriesArgs) {
      const arg = node.args[index];
      if (arg === undefined || arg.kind === 'error') continue;
      if (!isSeriesNode(arg)) {
        problems.push(
          formulaProblem(
            'NOT_A_SERIES',
            `${node.name} argument ${String(index + 1)} must name a field or a security`,
            arg.span,
          ),
        );
      }
    }

    for (const index of spec.windowArgs) {
      const arg = node.args[index];
      if (arg === undefined || arg.kind === 'error') continue;
      const bad =
        arg.kind !== 'number' ||
        !Number.isInteger(arg.value) ||
        arg.value < 1 ||
        arg.value > MAX_FORMULA_WINDOW;
      if (bad) {
        problems.push(
          formulaProblem(
            'BAD_WINDOW',
            `${node.name} needs a whole-number window between 1 and ${String(MAX_FORMULA_WINDOW)}`,
            arg.span,
          ),
        );
      }
    }
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Entry points                                                                                   */
/* -------------------------------------------------------------------------------------------- */

function failed(raw: string, problems: readonly FormulaProblem[], tokens: readonly FormulaToken[]): FormulaParseResult {
  return Object.freeze({
    ok: false,
    raw,
    ast: null,
    canonical: null,
    problems: Object.freeze([...problems]),
    tokens,
  });
}

/**
 * Parse a formula. Total: never throws, for any input of any type.
 *
 * `ok` is true only when the tree is complete and nothing was reported — an editor can therefore
 * treat `problems` as the underline list and `canonical` as the text to store.
 */
export function parseFormula(raw: unknown): FormulaParseResult {
  const lexed = lexFormula(raw);
  const text = lexed.raw;

  if (typeof raw !== 'string' || lexed.problems.some((p) => p.code === 'TOO_LONG')) {
    return failed(text, lexed.problems, lexed.tokens);
  }

  const bodyStart = lexed.body[0];
  const bodyEnd = lexed.body[1];
  if (bodyEnd <= bodyStart) {
    return failed(
      text,
      [formulaProblem('EMPTY', 'a formula has no text', [bodyStart, bodyEnd])],
      lexed.tokens,
    );
  }

  const parser = new Parser(lexed.tokens);
  const ast = parser.parse();
  // The scanner's problems come first: a character it could not use is the earliest thing wrong,
  // and it is reported whether or not the parser ever reached that token.
  const problems = [...lexed.problems, ...parser.problems];
  checkStatically(ast, problems);

  // Source order makes the first problem the one to show, which is the one furthest left.
  problems.sort((a, b) => a.span[0] - b.span[0] || a.span[1] - b.span[1]);

  const ok = problems.length === 0 && !hasErrorNode(ast);
  return Object.freeze({
    ok,
    raw: text,
    ast,
    canonical: ok ? formatFormula(ast) : null,
    problems: Object.freeze([...problems]),
    tokens: lexed.tokens,
  });
}

/** {@link parseFormula} reduced to the tree, or `null`. */
export function parseFormulaOrNull(raw: unknown): FormulaNode | null {
  const parsed = parseFormula(raw);
  return parsed.ok ? parsed.ast : null;
}

/**
 * The canonical spelling of a formula, or `null` when it does not parse. Idempotent — store this,
 * not the raw text, and `<RATIO(AAPL US Equity, SPX Index)>` and `RATIO(AAPL US Equity,SPX Index)`
 * become the same row.
 */
export function canonicaliseFormula(raw: unknown): string | null {
  return parseFormula(raw).canonical;
}

/** `true` when the string is a well-formed formula. */
export function isFormula(raw: unknown): boolean {
  return parseFormula(raw).ok;
}

/** The functions a caller may name, for a help line or a picker. */
export type { FormulaFunctionName };
