/**
 * The formula evaluator — CHRT-07 (WORKPLAN §WP-03 L616-618, CLIENT.md §11.10 L968-975).
 *
 * The evaluator is pure and IO-free: every number it needs arrives through a {@link FormulaContext}
 * the caller supplies. That is what lets the same file run in three places with three different
 * contexts and give the same answer (API-05 parity):
 *
 *   * the **server**, resolving `SecurityRefInput.formula` into a chart series and citing both
 *     inputs in `meta.provenance` (CLIENT.md L971-973);
 *   * the **client**, recomputing a watchlist's computed column on each live delta over the row's
 *     *current* field values (CLIENT.md L973-975);
 *   * the **CSV export**, which must agree with the screen byte for byte (API.md §9).
 *
 * It never throws, and it never returns a wrong number in place of no number. Division by zero, a
 * field the row has not got, history shorter than the window, a context that throws, a formula that
 * did not parse — each yields `na`: `value: null`, `na: true` and a {@link FormulaNaReason} saying
 * which. `na` propagates through arithmetic exactly as a blank cell should.
 *
 * Semantics of the four functions:
 *
 * ```
 * RATIO(a, b)              a / b                                      na when b is 0
 * SPREAD(a, b)             a - b
 * MA(series, n)            mean of the last n observations            na with fewer than n
 * NORM(series[, n])        100 * last / first, over the last n        na when the base is 0
 * ```
 *
 * `MA` and `NORM` read history, so their first argument names a series — a field on the row's own
 * security, or a security reference, whose default field is `PX_LAST`. `parser.ts` enforces that
 * statically; this file still checks, because an AST can be built by hand.
 */

import type { FieldId } from '../types/fields.js';
import type { SecurityRef } from '../types/instrument.js';

import type { FormulaNode, FormulaProblem, FormulaSecurityNode } from './ast.js';
import { FORMULA_FUNCTIONS, isSeriesNode } from './ast.js';
import { parseFormula } from './parser.js';

/* -------------------------------------------------------------------------------------------- */
/* Context                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** A security named in a formula, as the context sees it. `canonical` is the lookup key. */
export interface FormulaSecurity {
  readonly ref: SecurityRef;
  /** `formatSecurityRef(ref)` — `'AAPL US Equity'`, `'/isin/US0378331005'`. */
  readonly canonical: string;
  /** Exactly what the formula said. */
  readonly text: string;
}

/**
 * Where values come from. Both accessors take `null` for "the row's own security" — the watchlist
 * row, the chart's anchor — and a named {@link FormulaSecurity} otherwise.
 *
 * Returning `null` or `undefined` means "no value", which becomes `na`; a non-finite number is
 * treated the same way. An accessor that throws is caught and becomes `na` with `CONTEXT_ERROR`, so
 * a buggy adapter cannot take a grid down.
 */
export interface FormulaContext {
  /** The current value of `field`. */
  field(security: FormulaSecurity | null, field: FieldId): number | null | undefined;
  /**
   * History for `field`, oldest first, most recent last. `length` is the window asked for; `0`
   * means "everything available". Returning more than `length` is fine — the last `length` are
   * used. Omit the accessor entirely and `MA`/`NORM` are `na` with `MISSING_SERIES`.
   */
  series?(
    security: FormulaSecurity | null,
    field: FieldId,
    length: number,
  ): readonly number[] | null | undefined;
  /** The field a bare security reference means. Defaults to {@link DEFAULT_FORMULA_FIELD}. */
  readonly defaultField?: FieldId;
}

/** What `RATIO(AAPL US Equity, SPX Index)` reads when the formula names no field. */
export const DEFAULT_FORMULA_FIELD: FieldId = 'PX_LAST';

/** Deepest tree the evaluator will walk. `parser.ts` caps parsed trees well below this. */
const MAX_EVAL_DEPTH = 256;

/* -------------------------------------------------------------------------------------------- */
/* Results                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** Why a formula has no value. Never an exception — always one of these. */
export type FormulaNaReason =
  /** The text did not parse; see `problems`. */
  | 'PARSE_ERROR'
  /** The tree has a hole, an impossible arity, or a `MA`/`NORM` argument that is not a series. */
  | 'BAD_FORMULA'
  /** The context has no current value for a field it was asked for. */
  | 'MISSING_FIELD'
  /** No `series` accessor, or none for that field. */
  | 'MISSING_SERIES'
  /** History shorter than the window, or a gap in it. */
  | 'INSUFFICIENT_HISTORY'
  /** A divisor of zero — `x/0`, `RATIO(x, 0)`, `NORM` off a zero base. */
  | 'DIV_ZERO'
  /** Arithmetic that left the reals: overflow to `Infinity`, `0 * Infinity`, `NaN` in. */
  | 'NOT_A_NUMBER'
  /** A window that is not a whole number of at least one. */
  | 'BAD_WINDOW'
  /** A context accessor threw. */
  | 'CONTEXT_ERROR'
  /** A hand-built tree deeper than the evaluator walks. */
  | 'TOO_DEEP';

/** One `(security, field)` the evaluation actually asked for — the provenance of the number. */
export interface FormulaInputRead {
  /** The canonical security spelling, or `null` for the row's own security. */
  readonly security: string | null;
  readonly field: FieldId;
  /** The largest window read for this input: `0` when only the current value was taken. */
  readonly window: number;
}

/** The outcome of evaluating a formula. `na === (value === null)`, always. */
export interface FormulaEvaluation {
  readonly value: number | null;
  readonly na: boolean;
  readonly reason: FormulaNaReason | null;
  readonly inputs: readonly FormulaInputRead[];
  readonly problems: readonly FormulaProblem[];
}

/* -------------------------------------------------------------------------------------------- */
/* Internals                                                                                      */
/* -------------------------------------------------------------------------------------------- */

type Value =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: FormulaNaReason };

const num = (value: number): Value =>
  Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: 'NOT_A_NUMBER' };

const na = (reason: FormulaNaReason): Value => ({ ok: false, reason });

interface Read {
  readonly security: string | null;
  readonly field: FieldId;
  window: number;
}

class Evaluator {
  private readonly reads = new Map<string, Read>();
  private depth = 0;

  constructor(private readonly ctx: FormulaContext) {}

  private get defaultField(): FieldId {
    const declared = this.ctx.defaultField;
    return typeof declared === 'string' && declared.length > 0 ? declared : DEFAULT_FORMULA_FIELD;
  }

  private record(security: string | null, field: FieldId, window: number): void {
    const key = `${security ?? ''}|${field}`;
    const seen = this.reads.get(key);
    if (seen === undefined) this.reads.set(key, { security, field, window });
    else if (window > seen.window) seen.window = window;
  }

  inputs(): readonly FormulaInputRead[] {
    return Object.freeze(
      [...this.reads.values()].map((r) =>
        Object.freeze({ security: r.security, field: r.field, window: r.window }),
      ),
    );
  }

  /** The `(security, field)` a series-valued node names. */
  private target(node: FormulaNode): { security: FormulaSecurity | null; field: FieldId } | null {
    if (node.kind === 'field') return { security: null, field: node.field };
    if (node.kind === 'security') return { security: securityOf(node), field: this.defaultField };
    return null;
  }

  private readField(security: FormulaSecurity | null, field: FieldId): Value {
    this.record(security?.canonical ?? null, field, 0);
    let raw: number | null | undefined;
    try {
      raw = this.ctx.field(security, field);
    } catch {
      return na('CONTEXT_ERROR');
    }
    if (typeof raw !== 'number') return na('MISSING_FIELD');
    return Number.isFinite(raw) ? { ok: true, value: raw } : na('MISSING_FIELD');
  }

  private readSeries(
    security: FormulaSecurity | null,
    field: FieldId,
    window: number,
  ): readonly number[] | FormulaNaReason {
    this.record(security?.canonical ?? null, field, window);
    if (typeof this.ctx.series !== 'function') return 'MISSING_SERIES';
    let raw: readonly number[] | null | undefined;
    try {
      raw = this.ctx.series(security, field, window);
    } catch {
      return 'CONTEXT_ERROR';
    }
    if (raw === null || raw === undefined || !Array.isArray(raw)) return 'MISSING_SERIES';
    const all = raw as readonly number[];
    const used = window > 0 ? all.slice(-window) : all.slice();
    if (used.length === 0) return 'INSUFFICIENT_HISTORY';
    if (window > 0 && used.length < window) return 'INSUFFICIENT_HISTORY';
    for (const point of used) {
      if (typeof point !== 'number' || !Number.isFinite(point)) return 'INSUFFICIENT_HISTORY';
    }
    return used;
  }

  /** The window literal of a `MA`/`NORM` call, or a reason it is unusable. */
  private window(node: FormulaNode | undefined, required: boolean): number | FormulaNaReason {
    if (node === undefined) return required ? 'BAD_WINDOW' : 0;
    if (node.kind !== 'number') return 'BAD_WINDOW';
    const { value } = node;
    if (!Number.isInteger(value) || value < 1) return 'BAD_WINDOW';
    return value;
  }

  evaluate(node: FormulaNode): Value {
    if (++this.depth > MAX_EVAL_DEPTH) {
      this.depth--;
      return na('TOO_DEEP');
    }
    const result = this.dispatch(node);
    this.depth--;
    return result;
  }

  private dispatch(node: FormulaNode): Value {
    switch (node.kind) {
      case 'number':
        return num(node.value);

      case 'field':
        return this.readField(null, node.field);

      case 'security':
        return this.readField(securityOf(node), this.defaultField);

      case 'unary': {
        const inner = this.evaluate(node.operand);
        if (!inner.ok) return inner;
        return num(node.op === '-' ? -inner.value : inner.value);
      }

      case 'binary': {
        const left = this.evaluate(node.left);
        if (!left.ok) return left;
        const right = this.evaluate(node.right);
        if (!right.ok) return right;
        return applyBinary(node.op, left.value, right.value);
      }

      case 'call':
        return this.callFunction(node);

      default:
        return na('BAD_FORMULA');
    }
  }

  private callFunction(node: Extract<FormulaNode, { kind: 'call' }>): Value {
    const spec = FORMULA_FUNCTIONS[node.name];
    if (node.args.length < spec.minArgs || node.args.length > spec.maxArgs) return na('BAD_FORMULA');

    if (node.name === 'RATIO' || node.name === 'SPREAD') {
      const first = node.args[0];
      const second = node.args[1];
      if (first === undefined || second === undefined) return na('BAD_FORMULA');
      const a = this.evaluate(first);
      if (!a.ok) return a;
      const b = this.evaluate(second);
      if (!b.ok) return b;
      return applyBinary(node.name === 'RATIO' ? '/' : '-', a.value, b.value);
    }

    // MA and NORM: a named series, then a window.
    const operand = node.args[0];
    if (operand === undefined || !isSeriesNode(operand)) return na('BAD_FORMULA');
    const target = this.target(operand);
    if (target === null) return na('BAD_FORMULA');

    const window = this.window(node.args[1], node.name === 'MA');
    if (typeof window === 'string') return na(window);

    const series = this.readSeries(target.security, target.field, window);
    if (typeof series === 'string') return na(series);

    if (node.name === 'MA') {
      let total = 0;
      for (const point of series) total += point;
      return num(total / series.length);
    }

    // NORM — rebase to 100 at the start of the window (CHRT-03's chart normalisation).
    if (series.length < 2) return na('INSUFFICIENT_HISTORY');
    const base = series[0];
    const last = series[series.length - 1];
    if (base === undefined || last === undefined) return na('INSUFFICIENT_HISTORY');
    if (base === 0) return na('DIV_ZERO');
    return num((100 * last) / base);
  }
}

function securityOf(node: FormulaSecurityNode): FormulaSecurity {
  return { ref: node.ref, canonical: node.canonical, text: node.text };
}

function applyBinary(op: '+' | '-' | '*' | '/', a: number, b: number): Value {
  switch (op) {
    case '+':
      return num(a + b);
    case '-':
      return num(a - b);
    case '*':
      return num(a * b);
    default:
      return b === 0 ? na('DIV_ZERO') : num(a / b);
  }
}

function finish(
  value: Value,
  inputs: readonly FormulaInputRead[],
  problems: readonly FormulaProblem[],
): FormulaEvaluation {
  return Object.freeze({
    value: value.ok ? value.value : null,
    na: !value.ok,
    reason: value.ok ? null : value.reason,
    inputs,
    problems,
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Entry points                                                                                   */
/* -------------------------------------------------------------------------------------------- */

const NO_PROBLEMS: readonly FormulaProblem[] = Object.freeze([]);
const NO_INPUTS: readonly FormulaInputRead[] = Object.freeze([]);

/** Evaluate a parsed formula. Total: never throws, whatever the tree or the context does. */
export function evaluateFormulaNode(node: FormulaNode, ctx: FormulaContext): FormulaEvaluation {
  const evaluator = new Evaluator(ctx);
  const value = evaluator.evaluate(node);
  return finish(value, evaluator.inputs(), NO_PROBLEMS);
}

/**
 * Parse and evaluate in one step — the call a watchlist column makes on every delta.
 *
 * A formula that does not parse is `na` with `PARSE_ERROR` and the parser's problems attached, so a
 * bad column shows a blank cell and a tooltip rather than breaking the grid.
 */
export function evaluateFormula(raw: unknown, ctx: FormulaContext): FormulaEvaluation {
  const parsed = parseFormula(raw);
  if (!parsed.ok || parsed.ast === null) {
    return finish(na('PARSE_ERROR'), NO_INPUTS, parsed.problems);
  }
  const evaluator = new Evaluator(ctx);
  const value = evaluator.evaluate(parsed.ast);
  return finish(value, evaluator.inputs(), parsed.problems);
}
