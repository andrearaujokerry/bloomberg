/**
 * The formula language's vocabulary — CHRT-07 (WORKPLAN §WP-03 L616-618, ARCHITECTURE L187-188).
 *
 * A *formula* is the small expression language that `watchlists.columns[].formula` and
 * `watchlist_items.formula` hold (CONTRACTS §1.2 L265-270), that `SecurityRefInput.formula` carries
 * on the wire (API.md L224) and that the command line accepts as a security anchor, canonically in
 * angle brackets — `<RATIO(AAPL US Equity, SPX Index)> GP` (FUNCTIONS.md L628, L846). The accepted
 * syntax *is* the column contract, so it is defined once, here, and both sides of the wire run it.
 *
 * ```
 * expr    := term (('+' | '-') term)*
 * term    := unary (('*' | '/') unary)*
 * unary   := ('+' | '-') unary | primary
 * primary := number | field | security | NAME '(' expr (',' expr)* ')' | '(' expr ')'
 * field   := [A-Za-z_][A-Za-z0-9_]*                  ; 'PX_LAST', 'PX_CLOSE_1D' — the row's security
 * security:= any of the eight forms of core/ids/securityRef.ts, sector-terminated or /scheme/ or bare
 * NAME    := 'RATIO' | 'SPREAD' | 'NORM' | 'MA'
 * ```
 *
 * Four rules the rest of the package leans on:
 *
 *   1. **Nothing here throws.** Malformed input is a {@link FormulaProblem} with a half-open
 *      `[start, end)` span into the raw string — QA-05 fuzzes the parser with random strings.
 *   2. **The AST is data.** Plain frozen objects, no classes, no methods: it serialises, it hashes
 *      (`hash/canonicalJson.ts`) and it crosses the wire unchanged.
 *   3. **Evaluation is IO-free.** Values arrive through a resolution context (`evaluator.ts`); the
 *      AST names securities and fields, it never fetches them.
 *   4. **`format(parse(s))` is canonical and idempotent.** {@link formatFormula} re-prints an AST
 *      with the minimum parentheses; re-parsing that text yields the same AST, which is what lets a
 *      stored column be normalised before it is written.
 */

import { SECURITY_REF_SCHEMES } from '../ids/securityRef.js';
import type { FieldId } from '../types/fields.js';
import type { SecurityRef } from '../types/instrument.js';

/* -------------------------------------------------------------------------------------------- */
/* Limits                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** `z.string().max(400)` on the wire (API.md L224, L648), so the parser refuses more in O(1). */
export const MAX_FORMULA_LENGTH = 400;

/** Deepest nesting the recursive-descent parser will build before it gives up (QA-05: `((((((…`). */
export const MAX_FORMULA_DEPTH = 64;

/** Most arguments any formula function takes, plus slack, so a hostile arg list is bounded. */
export const MAX_FORMULA_ARGS = 8;

/** Largest `MA`/`NORM` window. A window is a bar count, not a price, and history is finite. */
export const MAX_FORMULA_WINDOW = 10_000;

/* -------------------------------------------------------------------------------------------- */
/* Spans and problems                                                                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * A half-open `[start, end)` span into the raw formula text. Mutable-tuple typed on purpose: it is
 * assignable to `CommandProblem['span']` (CONTRACTS §4.1 L668) without a copy.
 */
export type FormulaSpan = [number, number];

/** Why a string is not a formula. Every code is reported with a span; none is ever thrown. */
export type FormulaProblemCode =
  /** The input was not a string. */
  | 'NOT_A_STRING'
  /** The input was empty or whitespace only. */
  | 'EMPTY'
  /** Longer than {@link MAX_FORMULA_LENGTH}. */
  | 'TOO_LONG'
  /** A character the language has no use for (`#`, `@`, an emoji, a stray `<`). */
  | 'UNEXPECTED_CHAR'
  /** A token that cannot start an operand: `)`, `,`, an operator with nothing to its right. */
  | 'MISSING_OPERAND'
  /** `(` with no `)`, or `)` with no `(`. */
  | 'UNBALANCED_PAREN'
  /** A complete expression, then more text: `PX_LAST PX_BID`. */
  | 'TRAILING_INPUT'
  /** Nesting deeper than {@link MAX_FORMULA_DEPTH}. */
  | 'TOO_DEEP'
  /** `/isin/…` or a sector-terminated phrase that `parseSecurityRef` rejected. */
  | 'BAD_SECURITY_REF'
  /** A call to something that is not `RATIO`, `SPREAD`, `NORM` or `MA`. */
  | 'UNKNOWN_FUNCTION'
  /** The right function, the wrong number of arguments. */
  | 'BAD_ARITY'
  /** `MA(PX_LAST+1, 50)` — the argument must *name* a series, not compute one. */
  | 'NOT_A_SERIES'
  /** A window that is not a positive integer literal ≤ {@link MAX_FORMULA_WINDOW}. */
  | 'BAD_WINDOW';

/** One reason a formula is not accepted, with the span of the text that caused it. */
export interface FormulaProblem {
  readonly code: FormulaProblemCode;
  readonly message: string;
  readonly span: FormulaSpan;
}

/** Build a frozen problem. Internal, but exported because the lexer and parser both raise them. */
export function formulaProblem(
  code: FormulaProblemCode,
  message: string,
  span: FormulaSpan,
): FormulaProblem {
  return Object.freeze({ code, message, span: [span[0], span[1]] as FormulaSpan });
}

/* -------------------------------------------------------------------------------------------- */
/* Functions                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** The four functions the language defines (WORKPLAN L617, ARCHITECTURE L188). */
export type FormulaFunctionName = 'RATIO' | 'SPREAD' | 'NORM' | 'MA';

/** What the parser checks statically about a call, before anything is evaluated. */
export interface FormulaFunctionSpec {
  readonly name: FormulaFunctionName;
  readonly minArgs: number;
  readonly maxArgs: number;
  /** Argument positions that must *name* a series: a field or a security reference. */
  readonly seriesArgs: readonly number[];
  /** Argument positions that must be a positive integer literal (a bar count). */
  readonly windowArgs: readonly number[];
  readonly summary: string;
}

/**
 * `RATIO` and `SPREAD` take any two expressions — they are `a / b` and `a - b` named for what a
 * chart does with them. `MA` and `NORM` read history, so their first argument must name a series
 * (a field on the row's security, or a security reference) rather than compute one: the resolution
 * context can serve `(security, field, n)`, it cannot re-evaluate arithmetic bar by bar.
 */
export const FORMULA_FUNCTIONS: Readonly<Record<FormulaFunctionName, FormulaFunctionSpec>> =
  Object.freeze({
    RATIO: Object.freeze({
      name: 'RATIO',
      minArgs: 2,
      maxArgs: 2,
      seriesArgs: Object.freeze([]),
      windowArgs: Object.freeze([]),
      summary: 'RATIO(a, b) — a divided by b; na when b is zero',
    }),
    SPREAD: Object.freeze({
      name: 'SPREAD',
      minArgs: 2,
      maxArgs: 2,
      seriesArgs: Object.freeze([]),
      windowArgs: Object.freeze([]),
      summary: 'SPREAD(a, b) — a minus b',
    }),
    NORM: Object.freeze({
      name: 'NORM',
      minArgs: 1,
      maxArgs: 2,
      seriesArgs: Object.freeze([0]),
      windowArgs: Object.freeze([1]),
      summary: 'NORM(series[, window]) — rebased to 100 at the start of the window (CHRT-03)',
    }),
    MA: Object.freeze({
      name: 'MA',
      minArgs: 2,
      maxArgs: 2,
      seriesArgs: Object.freeze([0]),
      windowArgs: Object.freeze([1]),
      summary: 'MA(series, window) — the mean of the last `window` observations',
    }),
  } as const);

/** The spec for `name` (case-insensitively), or `null` when the language has no such function. */
export function lookupFormulaFunction(name: unknown): FormulaFunctionSpec | null {
  if (typeof name !== 'string') return null;
  const upper = name.toUpperCase();
  if (upper === 'RATIO' || upper === 'SPREAD' || upper === 'NORM' || upper === 'MA') {
    return FORMULA_FUNCTIONS[upper];
  }
  return null;
}

/* -------------------------------------------------------------------------------------------- */
/* Nodes                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** The binary operators, in the two precedence bands. */
export type FormulaBinaryOp = '+' | '-' | '*' | '/';

/** The unary operators. `+` is kept rather than folded away so spans survive a re-print. */
export type FormulaUnaryOp = '+' | '-';

/** A numeric literal: `50`, `1`, `0.25`, `1e3`. Always finite. */
export interface FormulaNumberNode {
  readonly kind: 'number';
  readonly value: number;
  readonly span: FormulaSpan;
}

/** A field on the row's *own* security: `PX_LAST`, `PX_CLOSE_1D`. `field` is upper case. */
export interface FormulaFieldNode {
  readonly kind: 'field';
  readonly field: FieldId;
  readonly span: FormulaSpan;
}

/**
 * A named security: `AAPL US Equity`, `SPX Index`, `/isin/US0378331005`, `BBG000B9XRY4`. It
 * evaluates to the context's default field (`PX_LAST`) for that security.
 */
export interface FormulaSecurityNode {
  readonly kind: 'security';
  readonly ref: SecurityRef;
  /** `formatSecurityRef(ref)` — the canonical spelling, and the key of a context lookup. */
  readonly canonical: string;
  /** Exactly what the user typed, for echoing back in an error. */
  readonly text: string;
  readonly span: FormulaSpan;
}

/** `-PX_LAST`, `+3`. */
export interface FormulaUnaryNode {
  readonly kind: 'unary';
  readonly op: FormulaUnaryOp;
  readonly operand: FormulaNode;
  readonly span: FormulaSpan;
}

/** `a + b`, `a / b`. Left-associative within a band; `*` and `/` bind tighter than `+` and `-`. */
export interface FormulaBinaryNode {
  readonly kind: 'binary';
  readonly op: FormulaBinaryOp;
  readonly left: FormulaNode;
  readonly right: FormulaNode;
  readonly span: FormulaSpan;
}

/** `RATIO(a, b)`, `MA(PX_LAST, 50)`. `name` is upper case and always one of the four. */
export interface FormulaCallNode {
  readonly kind: 'call';
  readonly name: FormulaFunctionName;
  readonly args: readonly FormulaNode[];
  /** The span of the name alone, for underlining an `UNKNOWN_FUNCTION`. */
  readonly nameSpan: FormulaSpan;
  readonly span: FormulaSpan;
}

/**
 * A hole where an operand should have been. The parser produces one instead of throwing so that a
 * half-typed formula still yields a tree the editor can highlight; `parseFormula().ok` is false
 * whenever one is present.
 */
export interface FormulaErrorNode {
  readonly kind: 'error';
  readonly span: FormulaSpan;
}

/** Every node of the language. */
export type FormulaNode =
  | FormulaNumberNode
  | FormulaFieldNode
  | FormulaSecurityNode
  | FormulaUnaryNode
  | FormulaBinaryNode
  | FormulaCallNode
  | FormulaErrorNode;

/** `true` when the node *names* a series the context can serve history for (`MA`, `NORM`). */
export function isSeriesNode(node: FormulaNode): node is FormulaFieldNode | FormulaSecurityNode {
  return node.kind === 'field' || node.kind === 'security';
}

/** `true` when the tree contains a hole — i.e. the parse did not complete. */
export function hasErrorNode(node: FormulaNode): boolean {
  let found = false;
  walkFormula(node, (n) => {
    if (n.kind === 'error') found = true;
  });
  return found;
}

/* -------------------------------------------------------------------------------------------- */
/* Traversal                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** Pre-order traversal. Iterative, so a deep tree cannot overflow the stack. */
export function walkFormula(root: FormulaNode, visit: (node: FormulaNode) => void): void {
  const stack: FormulaNode[] = [root];
  for (;;) {
    const node = stack.pop();
    if (node === undefined) return;
    visit(node);
    if (node.kind === 'unary') stack.push(node.operand);
    else if (node.kind === 'binary') stack.push(node.right, node.left);
    else if (node.kind === 'call') for (let i = node.args.length - 1; i >= 0; i--) {
      const arg = node.args[i];
      if (arg !== undefined) stack.push(arg);
    }
  }
}

/** What a formula reads: enough for `W` to subscribe and for a chart to cite provenance. */
export interface FormulaDependencies {
  /** Field ids named against the row's own security, de-duplicated, in first-seen order. */
  readonly fields: readonly FieldId[];
  /** Securities named explicitly, de-duplicated by canonical spelling, in first-seen order. */
  readonly securities: readonly FormulaSecurityNode[];
  /** The functions used, de-duplicated. */
  readonly functions: readonly FormulaFunctionName[];
  /** The largest `MA`/`NORM` window, or `0` when the formula reads no history. */
  readonly maxWindow: number;
}

/** Everything {@link FormulaDependencies} describes, in one pass over the tree. */
export function formulaDependencies(root: FormulaNode): FormulaDependencies {
  const fields: FieldId[] = [];
  const securities: FormulaSecurityNode[] = [];
  const functions: FormulaFunctionName[] = [];
  const seenField = new Set<string>();
  const seenSecurity = new Set<string>();
  const seenFunction = new Set<string>();
  let maxWindow = 0;

  walkFormula(root, (node) => {
    if (node.kind === 'field' && !seenField.has(node.field)) {
      seenField.add(node.field);
      fields.push(node.field);
    } else if (node.kind === 'security' && !seenSecurity.has(node.canonical)) {
      seenSecurity.add(node.canonical);
      securities.push(node);
    } else if (node.kind === 'call') {
      if (!seenFunction.has(node.name)) {
        seenFunction.add(node.name);
        functions.push(node.name);
      }
      const spec = FORMULA_FUNCTIONS[node.name];
      for (const index of spec.windowArgs) {
        const arg = node.args[index];
        if (arg?.kind === 'number' && arg.value > maxWindow) maxWindow = arg.value;
      }
    }
  });

  return Object.freeze({
    fields: Object.freeze(fields),
    securities: Object.freeze(securities),
    functions: Object.freeze(functions),
    maxWindow,
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Printing                                                                                       */
/* -------------------------------------------------------------------------------------------- */

const BINDING: Readonly<Record<FormulaBinaryOp, number>> = Object.freeze({
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
});

const UNARY_BINDING = 3;
const PRIMARY_BINDING = 4;

function bindingOf(node: FormulaNode): number {
  if (node.kind === 'binary') return BINDING[node.op];
  if (node.kind === 'unary') return UNARY_BINDING;
  return PRIMARY_BINDING;
}

/**
 * `true` when the printed text ends in a `/scheme/value` reference, whose value runs to the next
 * space. An operator written straight after one would be swallowed into the identifier, so
 * {@link formatFormula} spaces the operator out — `'/isin/US0378331005 + /cusip/037833100'`.
 */
const TRAILING_SCHEME_REF = new RegExp(
  `/(?:${SECURITY_REF_SCHEMES.join('|')})/[A-Za-z0-9./_-]*$`,
);

function endsWithSchemeRef(text: string): boolean {
  return TRAILING_SCHEME_REF.test(text);
}

/** `50`, `0.25`, `1000` — the shortest round-tripping spelling JavaScript has. */
function printNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : 'na';
}

/**
 * Re-print an AST as the canonical formula text: one space after each comma, no space around
 * operators, and the minimum parentheses the precedence needs. `parse(format(ast))` is `ast`, so
 * `format` is idempotent and safe to store.
 */
export function formatFormula(node: FormulaNode): string {
  switch (node.kind) {
    case 'number':
      return printNumber(node.value);
    case 'field':
      return node.field;
    case 'security':
      return node.canonical;
    case 'error':
      return '?';
    case 'unary': {
      const inner = formatFormula(node.operand);
      const wrap = node.operand.kind === 'unary' || node.operand.kind === 'binary';
      return `${node.op}${wrap ? `(${inner})` : inner}`;
    }
    case 'call':
      return `${node.name}(${node.args.map((a) => formatFormula(a)).join(', ')})`;
    case 'binary': {
      const mine = BINDING[node.op];
      const left = formatFormula(node.left);
      const right = formatFormula(node.right);
      const leftWrapped = bindingOf(node.left) < mine ? `(${left})` : left;
      const rightBinding = bindingOf(node.right);
      const rightNeedsParens =
        rightBinding < mine || (rightBinding === mine && (node.op === '-' || node.op === '/'));
      const rightWrapped = rightNeedsParens ? `(${right})` : right;
      const pad = endsWithSchemeRef(leftWrapped) ? ' ' : '';
      return `${leftWrapped}${pad}${node.op}${pad}${rightWrapped}`;
    }
    default:
      return '?';
  }
}
