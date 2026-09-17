// packages/core/test/formula/formula.fuzz.test.ts — WP-03 / CHRT-07, QA-05 (WORKPLAN L621).
//
// The binding acceptance row is: "the parser never throws; unbalanced input yields a problem, not
// an exception" (WORKPLAN L621, FUNCTIONS.md §8). A formula reaches `core/formula` from three
// directions — a watchlist column a user types (CONTRACTS L265), `SecurityRefInput.formula` off the
// wire (API.md L224), and the command line's `<…>` anchor (FUNCTIONS.md L628) — so "arbitrary
// input" here means exactly that: unicode, `<`, `/`, `=`, unbalanced parens, half-typed calls.
//
// Everything is generated from `core/analytics/prng.ts` (seeded xoshiro128**), so a failure is
// reproducible from its seed forever, and no test in this file depends on wall-clock time or on
// `Math.random`, which `packages/core` bans.
//
// Five properties are asserted over every generated string:
//
//   P1  `parseFormula` returns; it never throws, whatever the input.
//   P2  every problem span is `0 <= start <= end <= raw.length`, and carries a message.
//   P3  `ok` implies no problems, no hole in the tree, and a non-null canonical spelling.
//   P4  the canonical spelling re-parses to itself — `format` is idempotent, which is what lets a
//       stored column be normalised on the way in.
//   P5  `evaluateFormula` returns; a context whose accessors throw yields `na`, never an exception.

import { describe, expect, it } from 'vitest';

import { makePrng } from '../../src/analytics/prng.js';
import type { Prng } from '../../src/analytics/prng.js';
import { hasErrorNode, MAX_FORMULA_LENGTH } from '../../src/formula/ast.js';
import type { FormulaContext } from '../../src/formula/evaluator.js';
import { evaluateFormula } from '../../src/formula/evaluator.js';
import { lexFormula } from '../../src/formula/lexer.js';
import { parseFormula } from '../../src/formula/parser.js';

/* -------------------------------------------------------------------------------------------- */
/* Generators                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** Characters chosen to hit the parser's seams: the operators, the brackets, `=`, `<`, unicode. */
const HOSTILE_CHARS: readonly string[] = [
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ...'+-*/()[]{},.;:!?=<>#@$%^&|~`\'"\\_',
  ' ',
  ' ',
  '\t',
  '\n',
  'é',
  'ü',
  'ß',
  'Ω',
  'π',
  '中',
  'ك',
  'א',
  'ᚠ',
  '…',
  '—',
  '​',
  '́',
  '﻿',
  '🙂',
  '𝟙',
  '𐍈',
];

/** The vocabulary a real formula is made of, so token soup is grammatical-looking but nonsense. */
const VOCABULARY: readonly string[] = [
  'PX_LAST',
  'PX_CLOSE_1D',
  'PX_BID',
  'VOLUME',
  'RATIO',
  'SPREAD',
  'NORM',
  'MA',
  'BETA',
  'AAPL US Equity',
  'SPX Index',
  'EURUSD Curncy',
  '912797VE4 Govt',
  'T 4.25 08/15/36 Govt',
  'AAPL 9/16/26 C245 Equity',
  '/isin/US0378331005',
  '/figi/BBG000B9XRY4',
  '/cusip/037833100',
  '/occ/AAPL260916C00245000',
  '/series/fred.csv/DGS10',
  'BBG000B9XRY4',
  'US0378331005',
  'Equity',
  'Index',
  'Govt',
  '(',
  ')',
  ',',
  '+',
  '-',
  '*',
  '/',
  '<',
  '>',
  '=',
  '50',
  '0',
  '1',
  '2.5',
  '1e9',
  ' ',
];

/** Formulas that parse, used as the seed corpus for mutation. */
const VALID: readonly string[] = [
  'PX_LAST/PX_CLOSE_1D-1',
  'RATIO(AAPL US Equity, SPX Index)',
  'MA(PX_LAST,50)',
  'NORM(SPX Index, 20)',
  'SPREAD(/isin/US0378331005, T 4.25 08/15/36 Govt)',
  '(PX_LAST+PX_BID)/2',
  '-MA(AAPL US Equity,200)*1e3',
  '<RATIO(AAPL US Equity, SPX Index)>',
];

function randomString(rng: Prng, maxLength: number): string {
  const length = rng.nextInt(maxLength + 1);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += HOSTILE_CHARS[rng.nextInt(HOSTILE_CHARS.length)] ?? 'x';
  }
  return out;
}

function randomSoup(rng: Prng, maxTokens: number): string {
  const count = rng.nextInt(maxTokens + 1);
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push(VOCABULARY[rng.nextInt(VOCABULARY.length)] ?? '1');
  return parts.join(rng.nextInt(3) === 0 ? ' ' : '');
}

function mutate(rng: Prng, source: string): string {
  let out = source;
  const edits = 1 + rng.nextInt(3);
  for (let i = 0; i < edits; i++) {
    if (out.length === 0) return HOSTILE_CHARS[rng.nextInt(HOSTILE_CHARS.length)] ?? '(';
    const at = rng.nextInt(out.length);
    switch (rng.nextInt(4)) {
      case 0: // delete — the commonest way to unbalance a formula
        out = out.slice(0, at) + out.slice(at + 1);
        break;
      case 1: // insert
        out =
          out.slice(0, at) + (HOSTILE_CHARS[rng.nextInt(HOSTILE_CHARS.length)] ?? '(') + out.slice(at);
        break;
      case 2: // truncate
        out = out.slice(0, at);
        break;
      default: // duplicate a stretch
        out = out.slice(0, at) + out.slice(at, at + 1 + rng.nextInt(5)) + out.slice(at);
        break;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------------------------- */
/* Properties                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** A context that fails every way a context can: it throws. */
const HOSTILE_CONTEXT: FormulaContext = {
  field: () => {
    throw new Error('plant down');
  },
  series: () => {
    throw new Error('plant down');
  },
};

/** A context that answers everything, so the evaluator's arithmetic paths are exercised too. */
const GENEROUS_CONTEXT: FormulaContext = {
  field: () => 42,
  series: (_security, _field, length) => Array.from({ length: Math.max(length, 8) }, (_, i) => i + 1),
};

/** Check every property of one input. Returns a description of the first failure, or `null`. */
function check(raw: string): string | null {
  let parsed;
  try {
    parsed = parseFormula(raw); // P1
  } catch (error) {
    return `parseFormula threw: ${String(error)}`;
  }

  for (const problem of parsed.problems) {
    // P2
    const [start, end] = problem.span;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return `non-integer span ${String(start)},${String(end)}`;
    if (start < 0 || end > raw.length || start > end) {
      return `span [${String(start)}, ${String(end)}] outside [0, ${String(raw.length)}]`;
    }
    if (problem.message.length === 0) return `problem ${problem.code} has no message`;
  }

  if (parsed.ok) {
    // P3
    if (parsed.problems.length > 0) return 'ok with problems';
    if (parsed.ast === null) return 'ok with no tree';
    if (hasErrorNode(parsed.ast)) return 'ok with a hole in the tree';
    if (parsed.canonical === null) return 'ok with no canonical spelling';

    // P4
    let again;
    try {
      again = parseFormula(parsed.canonical);
    } catch (error) {
      return `re-parsing the canonical spelling threw: ${String(error)}`;
    }
    if (!again.ok) return `canonical ${JSON.stringify(parsed.canonical)} does not re-parse`;
    if (again.canonical !== parsed.canonical) {
      return `canonical is not idempotent: ${JSON.stringify(parsed.canonical)} → ${JSON.stringify(again.canonical)}`;
    }
  } else if (parsed.problems.length === 0) {
    return 'not ok but no problem reported';
  }

  // P5
  for (const ctx of [HOSTILE_CONTEXT, GENEROUS_CONTEXT]) {
    try {
      const result = evaluateFormula(raw, ctx);
      if (result.na !== (result.value === null)) return 'na disagrees with value';
      if (result.value !== null && !Number.isFinite(result.value)) return 'a non-finite value';
      if (result.na && result.reason === null) return 'na with no reason';
    } catch (error) {
      return `evaluateFormula threw: ${String(error)}`;
    }
  }

  return null;
}

/** The scan must cover the body monotonically, which is what keeps spans usable for highlighting. */
function checkTokens(raw: string): string | null {
  let lexed;
  try {
    lexed = lexFormula(raw);
  } catch (error) {
    return `lexFormula threw: ${String(error)}`;
  }
  let previous = lexed.body[0];
  for (const token of lexed.tokens) {
    if (token.span[0] < previous) return `token ${token.kind} goes backwards`;
    if (token.span[1] < token.span[0]) return `token ${token.kind} has an inverted span`;
    if (token.span[1] > raw.length) return `token ${token.kind} runs past the input`;
    previous = token.span[0];
  }
  const last = lexed.tokens[lexed.tokens.length - 1];
  if (last?.kind !== 'eof') return 'the stream does not end with eof';
  return null;
}

/* -------------------------------------------------------------------------------------------- */
/* The fuzz                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/** 25 000 per generator — 75 000 strings in all, in about two seconds. */
const ROUNDS = 25_000;

function fuzz(seed: string, make: (rng: Prng) => string): void {
  const rng = makePrng(seed);
  for (let i = 0; i < ROUNDS; i++) {
    const raw = make(rng);
    const failure = check(raw) ?? checkTokens(raw);
    if (failure !== null) {
      throw new Error(`seed ${seed}, round ${String(i)}: ${failure}\ninput: ${JSON.stringify(raw)}`);
    }
  }
}

describe('QA-05 — the formula parser never throws', () => {
  it(`${String(ROUNDS)} random strings over a hostile alphabet`, () => {
    expect(() => {
      fuzz('formula:chars', (rng) => randomString(rng, 60));
    }).not.toThrow();
  });

  it(`${String(ROUNDS)} random token soups`, () => {
    expect(() => {
      fuzz('formula:soup', (rng) => randomSoup(rng, 12));
    }).not.toThrow();
  });

  it(`${String(ROUNDS)} mutations of valid formulas`, () => {
    expect(() => {
      fuzz('formula:mutate', (rng) => mutate(rng, VALID[rng.nextInt(VALID.length)] ?? 'PX_LAST'));
    }).not.toThrow();
  });

  it('long and over-long inputs are bounded work, not an exception', () => {
    const rng = makePrng('formula:long');
    for (let i = 0; i < 200; i++) {
      const raw = randomString(rng, 600);
      expect(check(raw)).toBeNull();
      if (raw.length > MAX_FORMULA_LENGTH) {
        expect(parseFormula(raw).problems.map((p) => p.code)).toEqual(['TOO_LONG']);
      }
    }
  });

  it('is deterministic: the same seed makes the same corpus', () => {
    const draw = (): string[] => {
      const rng = makePrng('formula:chars');
      return Array.from({ length: 5 }, () => randomString(rng, 60));
    };
    expect(draw()).toEqual(draw());
  });
});

describe('QA-05 — unbalanced input yields a problem, not an exception', () => {
  const unbalanced: readonly string[] = [
    '(',
    ')',
    '()',
    '(()',
    '())',
    '((((((((((',
    '))))))))))',
    '(PX_LAST',
    'PX_LAST)',
    '(PX_LAST+1',
    'RATIO(',
    'RATIO(AAPL US Equity',
    'RATIO(AAPL US Equity,',
    'RATIO(AAPL US Equity, SPX Index',
    'MA(PX_LAST,',
    'MA(PX_LAST,)',
    'MA(,)',
    'MA(,,,,,,,,,,)',
    '<RATIO(AAPL US Equity, SPX Index)',
    'RATIO(AAPL US Equity, SPX Index)>',
    '<<>>',
    '<>',
    '(((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((1',
    'RATIO((((PX_LAST))))',
    'PX_LAST+',
    '+',
    '*',
    '/',
    '1/',
    ',',
    '((PX_LAST)',
    'NORM(NORM(NORM(NORM(PX_LAST',
  ];

  for (const raw of unbalanced) {
    it(`${JSON.stringify(raw)} is a problem`, () => {
      let parsed;
      expect(() => {
        parsed = parseFormula(raw);
      }).not.toThrow();
      parsed = parseFormula(raw);
      expect(parsed.ok).toBe(false);
      expect(parsed.canonical).toBeNull();
      expect(parsed.problems.length).toBeGreaterThan(0);
      for (const problem of parsed.problems) {
        expect(problem.span[0]).toBeGreaterThanOrEqual(0);
        expect(problem.span[1]).toBeLessThanOrEqual(raw.length);
      }
      const result = evaluateFormula(raw, GENEROUS_CONTEXT);
      expect(result.value).toBeNull();
      expect(result.reason).toBe('PARSE_ERROR');
    });
  }

  it('deep nesting is reported rather than overflowing the stack', () => {
    const deep = `${'('.repeat(100)}1${')'.repeat(99)}`;
    const parsed = parseFormula(deep);
    expect(parsed.ok).toBe(false);
    expect(parsed.problems.map((p) => p.code)).toContain('TOO_DEEP');
  });

  it('a balanced but deeply nested call chain is bounded too', () => {
    const chain = `${'NORM('.repeat(60)}PX_LAST${')'.repeat(60)}`;
    expect(() => parseFormula(chain)).not.toThrow();
    expect(parseFormula(chain).ok).toBe(false);
  });
});
