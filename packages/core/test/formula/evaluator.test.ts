// packages/core/test/formula/evaluator.test.ts — WP-03 / CHRT-07 (WORKPLAN L620).
//
// The binding acceptance row is: "`PX_LAST/PX_CLOSE_1D-1`, `RATIO(AAPL US Equity, SPX Index)`,
// `MA(PX_LAST,50)`, division by zero → `na`" (WORKPLAN L620, FUNCTIONS.md §8). Those four are the
// first four blocks below, spelled exactly as the documents spell them — `PX_LAST/PX_CLOSE_1D-1` is
// the computed watchlist column of CONTRACTS L265 and DATA_MODEL L1819, and
// `RATIO(AAPL US Equity, SPX Index)` is the formula *row* of CONTRACTS L268, the command-line
// anchor of FUNCTIONS.md L846 and the API example of API.md L224.
//
// The rest pins what those four depend on: operator precedence, the eight security-reference forms
// inside a formula, the `<…>` wrapper the command line puts round one, the static checks, and the
// rule that *every* failure is `na` with a reason rather than an exception.

import { describe, expect, it } from 'vitest';

import {
  formatFormula,
  formulaDependencies,
  hasErrorNode,
  MAX_FORMULA_LENGTH,
} from '../../src/formula/ast.js';
import type { FormulaContext, FormulaSecurity } from '../../src/formula/evaluator.js';
import { evaluateFormula } from '../../src/formula/evaluator.js';
import { lexFormula } from '../../src/formula/lexer.js';
import { canonicaliseFormula, isFormula, parseFormula } from '../../src/formula/parser.js';

/* -------------------------------------------------------------------------------------------- */
/* A resolution context backed by two plain maps                                                  */
/* -------------------------------------------------------------------------------------------- */

const key = (security: FormulaSecurity | null, field: string): string =>
  `${security?.canonical ?? ''}|${field}`;

interface Bank {
  readonly fields?: Record<string, number>;
  readonly series?: Record<string, readonly number[]>;
  readonly defaultField?: string;
}

function context(bank: Bank): FormulaContext {
  const ctx: FormulaContext = {
    field: (security, field) => bank.fields?.[key(security, field)] ?? null,
    series: (security, field) => bank.series?.[key(security, field)] ?? null,
  };
  return bank.defaultField === undefined ? ctx : { ...ctx, defaultField: bank.defaultField };
}

/** The row's own security has an empty canonical key. */
const own = (field: string): string => `|${field}`;

const value = (formula: string, bank: Bank): number | null =>
  evaluateFormula(formula, context(bank)).value;

/* -------------------------------------------------------------------------------------------- */
/* 1. The watchlist computed column: PX_LAST/PX_CLOSE_1D-1                                        */
/* -------------------------------------------------------------------------------------------- */

describe('PX_LAST/PX_CLOSE_1D-1 — the computed column of CONTRACTS L265', () => {
  const bank: Bank = { fields: { [own('PX_LAST')]: 195, [own('PX_CLOSE_1D')]: 190 } };

  it('is a percentage change', () => {
    const result = evaluateFormula('PX_LAST/PX_CLOSE_1D-1', context(bank));
    expect(result.na).toBe(false);
    expect(result.value).toBeCloseTo(195 / 190 - 1, 12);
    expect(result.reason).toBeNull();
  });

  it('parses as (PX_LAST/PX_CLOSE_1D)-1, not PX_LAST/(PX_CLOSE_1D-1)', () => {
    const parsed = parseFormula('PX_LAST/PX_CLOSE_1D-1');
    expect(parsed.ok).toBe(true);
    expect(parsed.ast).toMatchObject({
      kind: 'binary',
      op: '-',
      left: { kind: 'binary', op: '/' },
      right: { kind: 'number', value: 1 },
    });
    expect(parsed.canonical).toBe('PX_LAST/PX_CLOSE_1D-1');
  });

  it('names both fields on the row’s own security as its inputs', () => {
    const result = evaluateFormula('PX_LAST/PX_CLOSE_1D-1', context(bank));
    expect(result.inputs).toEqual([
      { security: null, field: 'PX_LAST', window: 0 },
      { security: null, field: 'PX_CLOSE_1D', window: 0 },
    ]);
  });

  it('is na when the row has no previous close', () => {
    const result = evaluateFormula('PX_LAST/PX_CLOSE_1D-1', context({ fields: { [own('PX_LAST')]: 195 } }));
    expect(result.value).toBeNull();
    expect(result.na).toBe(true);
    expect(result.reason).toBe('MISSING_FIELD');
  });

  it('lower-cased field names are the same field', () => {
    expect(value('px_last/px_close_1d-1', bank)).toBeCloseTo(195 / 190 - 1, 12);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 2. The formula row: RATIO(AAPL US Equity, SPX Index)                                           */
/* -------------------------------------------------------------------------------------------- */

describe('RATIO(AAPL US Equity, SPX Index) — the formula row of CONTRACTS L268', () => {
  const bank: Bank = {
    fields: { 'AAPL US Equity|PX_LAST': 245.5, 'SPX Index|PX_LAST': 5_500 },
  };

  it('divides the two securities’ default field', () => {
    const result = evaluateFormula('RATIO(AAPL US Equity, SPX Index)', context(bank));
    expect(result.na).toBe(false);
    expect(result.value).toBeCloseTo(245.5 / 5_500, 12);
  });

  it('reads each name as one security, not as three fields', () => {
    const parsed = parseFormula('RATIO(AAPL US Equity, SPX Index)');
    expect(parsed.ok).toBe(true);
    expect(parsed.ast).toMatchObject({
      kind: 'call',
      name: 'RATIO',
      args: [
        { kind: 'security', canonical: 'AAPL US Equity', ref: { kind: 'ticker', value: 'AAPL' } },
        { kind: 'security', canonical: 'SPX Index' },
      ],
    });
  });

  it('cites both inputs, which is what meta.provenance needs (CLIENT.md L971-973)', () => {
    const result = evaluateFormula('RATIO(AAPL US Equity, SPX Index)', context(bank));
    expect(result.inputs).toEqual([
      { security: 'AAPL US Equity', field: 'PX_LAST', window: 0 },
      { security: 'SPX Index', field: 'PX_LAST', window: 0 },
    ]);
  });

  it('accepts the command line’s angle-bracket spelling (FUNCTIONS.md L628)', () => {
    expect(canonicaliseFormula('<RATIO(AAPL US Equity, SPX Index)>')).toBe(
      'RATIO(AAPL US Equity, SPX Index)',
    );
    expect(lexFormula('<RATIO(AAPL US Equity, SPX Index)>').wrapped).toBe(true);
    expect(value('<RATIO(AAPL US Equity, SPX Index)>', bank)).toBeCloseTo(245.5 / 5_500, 12);
  });

  it('is spacing-insensitive and canonicalises to one spelling', () => {
    for (const spelling of [
      'RATIO(AAPL US Equity,SPX Index)',
      'RATIO( AAPL US Equity ,  SPX Index )',
      'ratio(AAPL US Equity, SPX Index)',
    ]) {
      expect(canonicaliseFormula(spelling)).toBe('RATIO(AAPL US Equity, SPX Index)');
    }
  });

  it('is na when either leg is missing', () => {
    const half = evaluateFormula(
      'RATIO(AAPL US Equity, SPX Index)',
      context({ fields: { 'AAPL US Equity|PX_LAST': 245.5 } }),
    );
    expect(half.value).toBeNull();
    expect(half.reason).toBe('MISSING_FIELD');
  });

  it('SPREAD is the difference of the same two legs', () => {
    expect(value('SPREAD(AAPL US Equity, SPX Index)', bank)).toBeCloseTo(245.5 - 5_500, 9);
  });

  it('a formula over the row’s own fields and a named security mixes freely', () => {
    const mixed: Bank = { fields: { ...bank.fields, [own('PX_LAST')]: 110 } };
    expect(value('PX_LAST/RATIO(AAPL US Equity, SPX Index)', mixed)).toBeCloseTo(
      110 / (245.5 / 5_500),
      6,
    );
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 3. MA(PX_LAST,50)                                                                              */
/* -------------------------------------------------------------------------------------------- */

describe('MA(PX_LAST,50)', () => {
  // 60 closes: 1 … 60, oldest first. The last 50 are 11 … 60, whose mean is 35.5.
  const closes = Array.from({ length: 60 }, (_, i) => i + 1);
  const bank: Bank = { series: { [own('PX_LAST')]: closes } };

  it('averages the last 50 observations', () => {
    const result = evaluateFormula('MA(PX_LAST,50)', context(bank));
    expect(result.na).toBe(false);
    expect(result.value).toBeCloseTo(35.5, 12);
  });

  it('records the window it read, for a history subscription', () => {
    const result = evaluateFormula('MA(PX_LAST,50)', context(bank));
    expect(result.inputs).toEqual([{ security: null, field: 'PX_LAST', window: 50 }]);
    const parsed = parseFormula('MA(PX_LAST,50)');
    expect(parsed.ast).not.toBeNull();
    expect(formulaDependencies(parsed.ast!)).toMatchObject({
      fields: ['PX_LAST'],
      functions: ['MA'],
      maxWindow: 50,
    });
  });

  it('is na with fewer than 50 observations', () => {
    const short = evaluateFormula('MA(PX_LAST,50)', context({ series: { [own('PX_LAST')]: [1, 2, 3] } }));
    expect(short.value).toBeNull();
    expect(short.reason).toBe('INSUFFICIENT_HISTORY');
  });

  it('is na when the context serves no history at all', () => {
    const noSeries = evaluateFormula('MA(PX_LAST,50)', { field: () => 10 });
    expect(noSeries.value).toBeNull();
    expect(noSeries.reason).toBe('MISSING_SERIES');
  });

  it('takes a moving average of a named security too', () => {
    const named: Bank = { series: { 'SPX Index|PX_LAST': [10, 20, 30, 40] } };
    expect(value('MA(SPX Index,4)', named)).toBeCloseTo(25, 12);
  });

  it('composes with arithmetic: PX_LAST/MA(PX_LAST,50)-1', () => {
    const both: Bank = { fields: { [own('PX_LAST')]: 60 }, series: { [own('PX_LAST')]: closes } };
    expect(value('PX_LAST/MA(PX_LAST,50)-1', both)).toBeCloseTo(60 / 35.5 - 1, 12);
  });

  it('NORM rebases a series to 100 at the start of its window', () => {
    const norm: Bank = { series: { [own('PX_LAST')]: [50, 60, 75] } };
    expect(value('NORM(PX_LAST)', norm)).toBeCloseTo(150, 12);
    expect(value('NORM(PX_LAST,2)', norm)).toBeCloseTo(125, 12);
  });

  it('NORM is na off a zero base', () => {
    const zeroBase = evaluateFormula('NORM(PX_LAST)', context({ series: { [own('PX_LAST')]: [0, 5] } }));
    expect(zeroBase.value).toBeNull();
    expect(zeroBase.reason).toBe('DIV_ZERO');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 4. Division by zero, and every other way to be na                                              */
/* -------------------------------------------------------------------------------------------- */

describe('division by zero yields na, never an exception', () => {
  it('x/0', () => {
    const result = evaluateFormula('PX_LAST/0', context({ fields: { [own('PX_LAST')]: 195 } }));
    expect(result.value).toBeNull();
    expect(result.na).toBe(true);
    expect(result.reason).toBe('DIV_ZERO');
  });

  it('a zero-valued denominator field', () => {
    const bank: Bank = { fields: { [own('PX_LAST')]: 195, [own('PX_CLOSE_1D')]: 0 } };
    expect(evaluateFormula('PX_LAST/PX_CLOSE_1D-1', context(bank)).reason).toBe('DIV_ZERO');
  });

  it('RATIO with a zero second leg', () => {
    const bank: Bank = { fields: { 'AAPL US Equity|PX_LAST': 245.5, 'SPX Index|PX_LAST': 0 } };
    const result = evaluateFormula('RATIO(AAPL US Equity, SPX Index)', context(bank));
    expect(result.value).toBeNull();
    expect(result.reason).toBe('DIV_ZERO');
  });

  it('0/0', () => {
    expect(evaluateFormula('0/0', context({})).reason).toBe('DIV_ZERO');
  });

  it('na propagates through the arithmetic around it', () => {
    const bank: Bank = { fields: { [own('PX_LAST')]: 195 } };
    expect(value('(PX_LAST/0)*2+1', bank)).toBeNull();
    expect(value('MA(PX_BID,10)+PX_LAST', bank)).toBeNull();
  });

  it('a context accessor that throws is na, not an exception', () => {
    const hostile: FormulaContext = {
      field: () => {
        throw new Error('plant down');
      },
      series: () => {
        throw new Error('plant down');
      },
    };
    expect(() => evaluateFormula('PX_LAST+1', hostile)).not.toThrow();
    expect(evaluateFormula('PX_LAST+1', hostile).reason).toBe('CONTEXT_ERROR');
    expect(evaluateFormula('MA(PX_LAST,5)', hostile).reason).toBe('CONTEXT_ERROR');
  });

  it('a formula that does not parse is na with PARSE_ERROR and the problems attached', () => {
    const result = evaluateFormula('RATIO(PX_LAST,', context({}));
    expect(result.value).toBeNull();
    expect(result.reason).toBe('PARSE_ERROR');
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it('overflow is na rather than Infinity', () => {
    expect(evaluateFormula('1e308*1e308', context({})).reason).toBe('NOT_A_NUMBER');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 5. Operator precedence and associativity                                                       */
/* -------------------------------------------------------------------------------------------- */

describe('operator precedence', () => {
  const cases: readonly (readonly [string, number])[] = [
    ['1+2*3', 7],
    ['2*3+1', 7],
    ['(1+2)*3', 9],
    ['1+2-3+4', 4],
    ['2-3-4', -5],
    ['100/2/5', 10],
    ['100/(2/5)', 250],
    ['2*3/4', 1.5],
    ['-2+3', 1],
    ['-(2+3)', -5],
    ['-2*-3', 6],
    ['+7', 7],
    ['3-(-4)', 7],
    ['((((1))))+1', 2],
    ['1+2*3-4/2', 5],
  ];

  for (const [formula, expected] of cases) {
    it(`${formula} = ${String(expected)}`, () => {
      expect(value(formula, {})).toBeCloseTo(expected, 12);
    });
  }

  it('re-printing is canonical and idempotent', () => {
    for (const [formula] of cases) {
      const once = canonicaliseFormula(formula);
      expect(once).not.toBeNull();
      expect(canonicaliseFormula(once!)).toBe(once);
      expect(value(once!, {})).toBe(value(formula, {}));
    }
  });

  it('the canonical spelling keeps only the parentheses precedence needs', () => {
    expect(canonicaliseFormula('(1+2)*3')).toBe('(1+2)*3');
    expect(canonicaliseFormula('1+(2*3)')).toBe('1+2*3');
    expect(canonicaliseFormula('100/(2/5)')).toBe('100/(2/5)');
    expect(canonicaliseFormula('(100/2)/5')).toBe('100/2/5');
    expect(canonicaliseFormula('2-(3-4)')).toBe('2-(3-4)');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 6. Security references: the eight forms, inside a formula                                      */
/* -------------------------------------------------------------------------------------------- */

describe('the eight security-reference forms are one token inside a formula', () => {
  const forms: readonly (readonly [string, string])[] = [
    ['AAPL US Equity', 'AAPL US Equity'],
    ['SPX Index', 'SPX Index'],
    ['EURUSD Curncy', 'EURUSD Curncy'],
    ['912797VE4 Govt', '912797VE4 Govt'],
    ['T 4.25 08/15/36 Govt', 'T 4.25 08/15/36 Govt'],
    ['AAPL 9/16/26 C245 Equity', 'AAPL 9/16/26 C245 Equity'],
    ['/isin/US0378331005', '/isin/US0378331005'],
    ['/figi/BBG000B9XRY4', '/figi/BBG000B9XRY4'],
    ['/cusip/037833100', '/cusip/037833100'],
    ['/occ/AAPL260916C00245000', '/occ/AAPL260916C00245000'],
    ['/series/fred.csv/DGS10', '/series/fred.csv/DGS10'],
    ['BBG000B9XRY4', '/figi/BBG000B9XRY4'],
    ['US0378331005', '/isin/US0378331005'],
  ];

  for (const [typed, canonical] of forms) {
    it(`${typed} → ${canonical}`, () => {
      const parsed = parseFormula(`RATIO(${typed}, SPX Index)`);
      expect(parsed.problems).toEqual([]);
      expect(parsed.ok).toBe(true);
      expect(parsed.ast).toMatchObject({
        kind: 'call',
        name: 'RATIO',
        args: [{ kind: 'security', canonical }, { kind: 'security', canonical: 'SPX Index' }],
      });
      // A literal denominator, so the row survives `typed === 'SPX Index'` naming the same key.
      const bank: Bank = { fields: { [`${canonical}|PX_LAST`]: 8 } };
      expect(value(`RATIO(${typed}, 2)`, bank)).toBeCloseTo(4, 12);
      // A `/scheme/` value runs to whitespace, so an operator after one is spaced; everywhere
      // else the reference may abut its operator.
      expect(value(`${typed} * 2`, bank)).toBeCloseTo(16, 12);
    });
  }

  it('a security is an operand like any other', () => {
    const bank: Bank = { fields: { 'AAPL US Equity|PX_LAST': 200, 'SPX Index|PX_LAST': 50 } };
    expect(value('AAPL US Equity/SPX Index-1', bank)).toBeCloseTo(3, 12);
    expect(value('AAPL US Equity - SPX Index', bank)).toBeCloseTo(150, 12);
  });

  it('the default field is the context’s when it declares one', () => {
    const bank: Bank = { fields: { 'SPX Index|PX_BID': 5 }, defaultField: 'PX_BID' };
    expect(value('SPX Index*2', bank)).toBeCloseTo(10, 12);
  });

  it('a bare word is a field on the row, never a ticker', () => {
    const parsed = parseFormula('AAPL');
    expect(parsed.ast).toMatchObject({ kind: 'field', field: 'AAPL' });
  });

  it('a sum is never mistaken for a ticker', () => {
    // parseSecurityRef('1+2') is a legal ticker token; the sector anchor is what stops it here.
    expect(parseFormula('1+2').ast).toMatchObject({ kind: 'binary', op: '+' });
  });

  it('a malformed identifier is a problem, not a throw', () => {
    const parsed = parseFormula('/isin/US0378331006');
    expect(parsed.ok).toBe(false);
    expect(parsed.problems.map((p) => p.code)).toContain('BAD_SECURITY_REF');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 7. Static checks — spans, arity, windows                                                       */
/* -------------------------------------------------------------------------------------------- */

describe('problems carry a code and an in-bounds span', () => {
  const rows: readonly (readonly [string, string])[] = [
    ['RATIO(PX_LAST', 'UNBALANCED_PAREN'],
    ['(PX_LAST+1', 'UNBALANCED_PAREN'],
    ['PX_LAST+1)', 'UNBALANCED_PAREN'],
    ['PX_LAST+', 'MISSING_OPERAND'],
    ['*PX_LAST', 'MISSING_OPERAND'],
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['PX_LAST # 2', 'UNEXPECTED_CHAR'],
    ['BETA(PX_LAST, 2)', 'UNKNOWN_FUNCTION'],
    ['RATIO(PX_LAST)', 'BAD_ARITY'],
    ['RATIO(1,2,3)', 'BAD_ARITY'],
    ['MA(PX_LAST+1, 50)', 'NOT_A_SERIES'],
    ['MA(PX_LAST, 0)', 'BAD_WINDOW'],
    ['MA(PX_LAST, 2.5)', 'BAD_WINDOW'],
    ['MA(PX_LAST, PX_BID)', 'BAD_WINDOW'],
    ['MA(PX_LAST)', 'BAD_ARITY'],
    ['PX_LAST PX_BID', 'TRAILING_INPUT'],
  ];

  for (const [formula, code] of rows) {
    it(`${JSON.stringify(formula)} → ${code}`, () => {
      const parsed = parseFormula(formula);
      expect(parsed.ok).toBe(false);
      expect(parsed.canonical).toBeNull();
      expect(parsed.problems.map((p) => p.code)).toContain(code);
      for (const problem of parsed.problems) {
        expect(problem.span[0]).toBeGreaterThanOrEqual(0);
        expect(problem.span[1]).toBeLessThanOrEqual(formula.length);
        expect(problem.span[0]).toBeLessThanOrEqual(problem.span[1]);
        expect(problem.message.length).toBeGreaterThan(0);
      }
      expect(evaluateFormula(formula, context({})).reason).toBe('PARSE_ERROR');
    });
  }

  it('the span points at the offending text', () => {
    const parsed = parseFormula('BETA(PX_LAST, 2)');
    const problem = parsed.problems.find((p) => p.code === 'UNKNOWN_FUNCTION');
    expect(problem).toBeDefined();
    expect('BETA(PX_LAST, 2)'.slice(problem!.span[0], problem!.span[1])).toBe('BETA');
  });

  it('a non-string and an over-long formula are rejected in O(1)', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      const parsed = parseFormula(bad);
      expect(parsed.ok).toBe(false);
      expect(parsed.ast).toBeNull();
      expect(parsed.problems[0]?.code).toBe('NOT_A_STRING');
    }
    const long = `1+${'1+'.repeat(MAX_FORMULA_LENGTH)}1`;
    expect(parseFormula(long).problems[0]?.code).toBe('TOO_LONG');
  });

  it('a hole in the tree is reported by hasErrorNode', () => {
    const parsed = parseFormula('PX_LAST+');
    expect(parsed.ast).not.toBeNull();
    expect(hasErrorNode(parsed.ast!)).toBe(true);
    expect(formatFormula(parsed.ast!)).toBe('PX_LAST+?');
  });

  it('isFormula is the column contract in one call', () => {
    expect(isFormula('PX_LAST/PX_CLOSE_1D-1')).toBe(true);
    expect(isFormula('RATIO(AAPL US Equity, SPX Index)')).toBe(true);
    expect(isFormula('MA(PX_LAST,50)')).toBe(true);
    expect(isFormula('NORM(SPX Index, 20)')).toBe(true);
    expect(isFormula('DROP TABLE watchlists')).toBe(false);
    expect(isFormula('')).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 8. Dependencies — what a watchlist column has to subscribe to                                  */
/* -------------------------------------------------------------------------------------------- */

describe('formulaDependencies', () => {
  it('lists fields, securities, functions and the largest window once each', () => {
    const parsed = parseFormula('MA(PX_LAST,50)/MA(AAPL US Equity,200)+PX_LAST-NORM(SPX Index,20)');
    expect(parsed.ok).toBe(true);
    const deps = formulaDependencies(parsed.ast!);
    expect(deps.fields).toEqual(['PX_LAST']);
    expect(deps.securities.map((s) => s.canonical)).toEqual(['AAPL US Equity', 'SPX Index']);
    expect([...deps.functions].sort()).toEqual(['MA', 'NORM']);
    expect(deps.maxWindow).toBe(200);
  });

  it('a formula with no history has a zero window', () => {
    const parsed = parseFormula('PX_LAST/PX_CLOSE_1D-1');
    expect(formulaDependencies(parsed.ast!).maxWindow).toBe(0);
  });
});
