// packages/core/test/ids/occ.test.ts — WP-03 (WORKPLAN L581-583, L615).
//
// The binding acceptance row is "round-trip of 3,510 contract symbols from the `cboe-options`
// fixture" (WORKPLAN L615, DATA_MODEL L563). The fixture is the recorded Cboe option chain for
// AAPL, so this file opens it with `node:fs` — tests are outside the core purity zone, and the
// recorded captures are exactly what WP-03's identifier corpora are meant to come from.
//
// Every contract symbol in the chain must satisfy three invariants:
//
//   1. `parseOcc(sym)` succeeds;
//   2. `formatOcc(parsed, 'cboe') === sym` — byte-identical, which is the form
//      `option_terms.occ_symbol` stores (CONTRACTS L80, PROVIDERS L741);
//   3. the padded OSI form is derivable and converts back to exactly the same Cboe string.
//
// The fixture is a single root (`AAPL`, four characters) with strikes 5-600, so the shapes it
// cannot reach — a strike above 1000, a single-character root, a five-character root — are pinned
// explicitly below, alongside the malformed inputs that must return a problem instead of throwing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makePrng } from '../../src/analytics/prng.js';
import {
  OCC_MAX_STRIKE_THOUSANDTHS,
  OCC_SYMBOL_LENGTH,
  formatOcc,
  isCboeOccSymbol,
  isOccSymbol,
  isOsiOccSymbol,
  occStrikeText,
  parseOcc,
  parseOccOrNull,
  toCboeForm,
  toOsiForm,
} from '../../src/ids/occ.js';
import type { OccOption, OccProblemCode } from '../../src/ids/occ.js';

// ── the recorded chain ────────────────────────────────────────────────────────────────────────

const FIXTURE = fileURLToPath(
  new URL('../../../../fixtures/providers/raw/cboe-options', import.meta.url),
);

/**
 * Every contract symbol in the recorded chain, in file order. Deliberately plain `throw`s rather
 * than assertions: this runs at import time, before any test has started.
 */
function readChainSymbols(): string[] {
  const raw: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const options = (raw as { data?: { options?: unknown } } | null)?.data?.options;
  if (!Array.isArray(options)) throw new Error(`${FIXTURE}: data.options is not an array`);
  const symbols: string[] = [];
  for (const row of options as unknown[]) {
    const sym = (row as { option?: unknown } | null)?.option;
    if (typeof sym !== 'string') throw new Error(`${FIXTURE}: an options row has no 'option'`);
    symbols.push(sym);
  }
  return symbols;
}

const SYMBOLS = readChainSymbols();

describe('cboe-options fixture — the corpus itself', () => {
  it('holds the 3,510 contract symbols WORKPLAN L615 names, all distinct', () => {
    expect(SYMBOLS).toHaveLength(3510);
    expect(new Set(SYMBOLS).size).toBe(3510);
  });

  it('is the AAPL chain, written in the unpadded Cboe form', () => {
    for (const sym of SYMBOLS) {
      expect(sym).toMatch(/^AAPL\d{6}[CP]\d{8}$/);
      expect(sym).toHaveLength(19);
    }
  });
});

describe('parseOcc / formatOcc — round-trip of the whole recorded chain', () => {
  it('parses every one of the 3,510 contract symbols', () => {
    const failures: string[] = [];
    for (const sym of SYMBOLS) if (!parseOcc(sym).ok) failures.push(sym);
    expect(failures).toEqual([]);
  });

  it('re-formats every one of them back to itself, byte for byte', () => {
    const mismatches: [string, string][] = [];
    let checked = 0;
    for (const sym of SYMBOLS) {
      const parsed = parseOcc(sym);
      if (!parsed.ok) {
        mismatches.push([sym, `problem ${parsed.problem.code}`]);
        continue;
      }
      const back = formatOcc(parsed.value, 'cboe');
      if (!back.ok) {
        mismatches.push([sym, `format problem ${back.problem.code}`]);
        continue;
      }
      if (back.value !== sym) mismatches.push([sym, back.value]);
      checked += 1;
    }
    expect(mismatches).toEqual([]);
    expect(checked).toBe(3510);
  });

  it('derives the padded OSI form for each and converts it back to the Cboe form', () => {
    const problems: string[] = [];
    for (const sym of SYMBOLS) {
      const osi = toOsiForm(sym);
      if (!osi.ok) {
        problems.push(`${sym}: ${osi.problem.code}`);
        continue;
      }
      if (osi.value.length !== OCC_SYMBOL_LENGTH) problems.push(`${sym}: length ${osi.value}`);
      if (osi.value !== `AAPL  ${sym.slice(4)}`) problems.push(`${sym}: osi ${osi.value}`);
      const back = toCboeForm(osi.value);
      if (!back.ok || back.value !== sym) problems.push(`${sym}: back ${JSON.stringify(back)}`);
    }
    expect(problems).toEqual([]);
  });

  it('agrees with the fixture on the terms of the first contract', () => {
    const parsed = parseOcc('AAPL260916C00245000');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toEqual<OccOption>({
      root: 'AAPL',
      expiry: '2026-09-16',
      right: 'C',
      strike: 245,
      strikeThousandths: 245_000,
    });
  });

  it('covers both rights and every expiry in the chain', () => {
    const rights = new Set<string>();
    const expiries = new Set<string>();
    for (const sym of SYMBOLS) {
      const p = parseOccOrNull(sym);
      expect(p).not.toBeNull();
      if (p) {
        rights.add(p.right);
        expiries.add(p.expiry);
      }
    }
    expect([...rights].sort()).toEqual(['C', 'P']);
    expect(expiries.size).toBe(25);
    expect(expiries.has('2026-09-16')).toBe(true);
    expect(expiries.has('2029-01-19')).toBe(true);
  });

  it('keeps the strike exact in thousandths across the chain', () => {
    for (const sym of SYMBOLS) {
      const p = parseOccOrNull(sym);
      expect(p).not.toBeNull();
      if (!p) continue;
      expect(p.strikeThousandths).toBe(Number(sym.slice(-8)));
      expect(p.strike).toBeCloseTo(p.strikeThousandths / 1000, 12);
    }
  });
});

// ── shapes the fixture cannot reach ───────────────────────────────────────────────────────────

describe('parseOcc — explicit cases', () => {
  const cases: [string, string, OccOption][] = [
    [
      'fractional strike (272.50, the half-dollar strikes in the chain)',
      'AAPL260916C00272500',
      {
        root: 'AAPL',
        expiry: '2026-09-16',
        right: 'C',
        strike: 272.5,
        strikeThousandths: 272_500,
      },
    ],
    [
      'sub-dollar fractional strike (2.50)',
      'SIRI260116P00002500',
      { root: 'SIRI', expiry: '2026-01-16', right: 'P', strike: 2.5, strikeThousandths: 2500 },
    ],
    [
      'strike above 1000 (6,500 on an index option)',
      'SPX261218C06500000',
      {
        root: 'SPX',
        expiry: '2026-12-18',
        right: 'C',
        strike: 6500,
        strikeThousandths: 6_500_000,
      },
    ],
    [
      'the widest strike the eight-digit field can express (99,999.999)',
      'BRKA260116C99999999',
      {
        root: 'BRKA',
        expiry: '2026-01-16',
        right: 'C',
        strike: 99_999.999,
        strikeThousandths: OCC_MAX_STRIKE_THOUSANDTHS,
      },
    ],
    [
      'weekly expiry — a Wednesday, not the monthly third Friday',
      'AAPL260923P00245000',
      {
        root: 'AAPL',
        expiry: '2026-09-23',
        right: 'P',
        strike: 245,
        strikeThousandths: 245_000,
      },
    ],
    [
      'weekly root (SPXW) on a Monday expiry',
      'SPXW260921P05000000',
      {
        root: 'SPXW',
        expiry: '2026-09-21',
        right: 'P',
        strike: 5000,
        strikeThousandths: 5_000_000,
      },
    ],
    [
      'single-letter root',
      'F260116C00012000',
      { root: 'F', expiry: '2026-01-16', right: 'C', strike: 12, strikeThousandths: 12_000 },
    ],
    [
      'five-character root',
      'GOOGL260116C00200000',
      {
        root: 'GOOGL',
        expiry: '2026-01-16',
        right: 'C',
        strike: 200,
        strikeThousandths: 200_000,
      },
    ],
    [
      'six-character root — the root field is full, so both forms are the same string',
      'BRKBQQ260116P00400000',
      {
        root: 'BRKBQQ',
        expiry: '2026-01-16',
        right: 'P',
        strike: 400,
        strikeThousandths: 400_000,
      },
    ],
    [
      'adjusted root carrying a digit',
      'AAPL1260916C00245000',
      {
        root: 'AAPL1',
        expiry: '2026-09-16',
        right: 'C',
        strike: 245,
        strikeThousandths: 245_000,
      },
    ],
    [
      'leap day expiry',
      'SPY280229C00600000',
      { root: 'SPY', expiry: '2028-02-29', right: 'C', strike: 600, strikeThousandths: 600_000 },
    ],
    [
      'the last year the two-digit OSI year can express',
      'T990116C00030000',
      { root: 'T', expiry: '2099-01-16', right: 'C', strike: 30, strikeThousandths: 30_000 },
    ],
  ];

  for (const [label, symbol, expected] of cases) {
    it(`parses and re-formats ${label}: ${symbol}`, () => {
      const parsed = parseOcc(symbol);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value).toEqual(expected);
      const back = formatOcc(parsed.value, 'cboe');
      expect(back.ok && back.value).toBe(symbol);
      expect(isOccSymbol(symbol)).toBe(true);
      expect(isCboeOccSymbol(symbol)).toBe(true);
    });
  }

  it('reads the padded OSI form of every explicit case identically', () => {
    for (const [, symbol, expected] of cases) {
      const osi = toOsiForm(symbol);
      expect(osi.ok).toBe(true);
      if (!osi.ok) continue;
      expect(osi.value).toHaveLength(OCC_SYMBOL_LENGTH);
      expect(osi.value).toBe(`${expected.root.padEnd(6, ' ')}${symbol.slice(expected.root.length)}`);
      expect(parseOccOrNull(osi.value)).toEqual(expected);
      expect(isOsiOccSymbol(osi.value)).toBe(true);
      const back = toCboeForm(osi.value);
      expect(back.ok && back.value).toBe(symbol);
    }
  });

  it('treats a six-character root as both forms at once', () => {
    const sym = 'BRKBQQ260116P00400000';
    expect(sym).toHaveLength(OCC_SYMBOL_LENGTH);
    expect(isCboeOccSymbol(sym)).toBe(true);
    expect(isOsiOccSymbol(sym)).toBe(true);
    expect(toOsiForm(sym)).toEqual({ ok: true, value: sym });
    expect(toCboeForm(sym)).toEqual({ ok: true, value: sym });
  });
});

// ── malformed input: a problem, never an exception ────────────────────────────────────────────

describe('parseOcc — malformed input returns a problem and never throws', () => {
  const bad: [string, string, OccProblemCode][] = [
    ['empty string', '', 'EMPTY'],
    ['root only', 'AAPL', 'BAD_LENGTH'],
    ['the tail alone, with no root', '260916C00245000', 'BAD_LENGTH'],
    ['a root wider than the six-character field', 'AAPLXYZ260916C00245000', 'BAD_LENGTH'],
    ['a symbol one character short of the layout', 'AAPL260916C0024500', 'BAD_EXPIRY'],
    ['root starting with a digit', '1AAP260916C00245000', 'BAD_ROOT'],
    ['lowercase root', 'aapl260916C00245000', 'BAD_ROOT'],
    ['lowercase right', 'AAPL260916c00245000', 'BAD_RIGHT'],
    ['right is neither C nor P', 'AAPL260916X00245000', 'BAD_RIGHT'],
    ['month 13', 'AAPL261316C00245000', 'BAD_EXPIRY'],
    ['month 00', 'AAPL260016C00245000', 'BAD_EXPIRY'],
    ['day 00', 'AAPL260900C00245000', 'BAD_EXPIRY'],
    ['31 February', 'AAPL260231C00245000', 'BAD_EXPIRY'],
    ['29 February in a common year', 'AAPL260229C00245000', 'BAD_EXPIRY'],
    ['31 September', 'AAPL260931C00245000', 'BAD_EXPIRY'],
    ['non-digit in the expiry', 'AAPL2609X6C00245000', 'BAD_EXPIRY'],
    ['non-digit in the strike', 'AAPL260916C0024500X', 'BAD_STRIKE'],
    ['zero strike', 'AAPL260916C00000000', 'BAD_STRIKE'],
    ['unicode digits in the strike', 'AAPL260916C００２４５０００', 'BAD_STRIKE'],
    ['a leading space', ' AAPL260916C00245000', 'BAD_PADDING'],
    ['a space between root and expiry outside the OSI form', 'AAPL 260916C00245000', 'BAD_PADDING'],
    ['a root padded past the six-character field', 'AAPL   260916C00245000', 'BAD_LENGTH'],
    ['a root field of nothing but spaces', '      260916C00245000', 'BAD_ROOT'],
    ['a trailing newline', 'AAPL260916C00245000\n', 'BAD_EXPIRY'],
    ['a dotted root', 'BRK.B260916C00245000', 'BAD_ROOT'],
    ['a root of emoji', '🙂🙂🙂260916C00245000', 'BAD_ROOT'],
    ['an accented root', 'ÉCLR260916C00245000', 'BAD_ROOT'],
  ];

  for (const [label, input, code] of bad) {
    it(`rejects ${label}: ${JSON.stringify(input)}`, () => {
      const r = parseOcc(input);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.problem.code).toBe(code);
      expect(r.problem.message.length).toBeGreaterThan(0);
      const [start, end] = r.problem.span;
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThanOrEqual(start);
      expect(end).toBeLessThanOrEqual(Math.max(input.length, 0));
      expect(parseOccOrNull(input)).toBeNull();
      expect(isOccSymbol(input)).toBe(false);
    });
  }

  it('rejects a non-string without throwing', () => {
    for (const value of [null, undefined, 42, {}, [], Symbol('x')]) {
      const r = parseOcc(value as string);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem.code).toBe('NOT_A_STRING');
    }
  });

  it('never throws on deterministic mutations of the recorded chain', () => {
    const rng = makePrng('occ-mutation');
    const alphabet = ' ABCPXZ0159-./\\\t\né中😀';
    let accepted = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const base = SYMBOLS[rng.nextInt(SYMBOLS.length)] ?? '';
      const chars = [...base];
      const edits = 1 + rng.nextInt(3);
      for (let e = 0; e < edits; e += 1) {
        const at = rng.nextInt(chars.length + 1);
        const ch = alphabet[rng.nextInt(alphabet.length)] ?? 'A';
        const op = rng.nextInt(3);
        if (op === 0 && at < chars.length) chars[at] = ch;
        else if (op === 1) chars.splice(at, 0, ch);
        else if (chars.length > 0) chars.splice(Math.min(at, chars.length - 1), 1);
      }
      const mutated = chars.join('');
      const r = parseOcc(mutated);
      if (r.ok) {
        accepted += 1;
        // Anything accepted must still round-trip exactly.
        const back = formatOcc(r.value, mutated.length === OCC_SYMBOL_LENGTH ? 'osi' : 'cboe');
        expect(back.ok).toBe(true);
        if (back.ok && !mutated.includes(' ')) expect(back.value).toBe(mutated);
      } else {
        expect(r.problem.span[0]).toBeGreaterThanOrEqual(0);
        expect(r.problem.span[1]).toBeLessThanOrEqual(mutated.length);
      }
    }
    // The corpus is mostly digit edits, so a healthy share stays valid; the assertion that matters
    // is that no call above threw.
    expect(accepted).toBeGreaterThan(0);
  });
});

// ── formatting from terms ─────────────────────────────────────────────────────────────────────

describe('formatOcc — from contract terms', () => {
  it('writes the Cboe form by default and the OSI form on request', () => {
    const terms = { root: 'AAPL', expiry: '2026-09-16', right: 'C', strike: 245 } as const;
    expect(formatOcc(terms)).toEqual({ ok: true, value: 'AAPL260916C00245000' });
    expect(formatOcc(terms, 'cboe')).toEqual({ ok: true, value: 'AAPL260916C00245000' });
    expect(formatOcc(terms, 'osi')).toEqual({ ok: true, value: 'AAPL  260916C00245000' });
  });

  it('accepts the strike as exact thousandths', () => {
    expect(
      formatOcc({ root: 'F', expiry: '2026-01-16', right: 'P', strikeThousandths: 12_500 }),
    ).toEqual({ ok: true, value: 'F260116P00012500' });
  });

  it('writes the strike as a numeric(14,4) decimal string', () => {
    expect(occStrikeText({ root: 'AAPL', expiry: '2026-09-16', right: 'C', strike: 245 })).toEqual({
      ok: true,
      value: '245.0000',
    });
    const p = parseOcc('AAPL260916C00272500');
    expect(p.ok && occStrikeText(p.value)).toEqual({ ok: true, value: '272.5000' });
    const tiny = parseOcc('SIRI260116P00000001');
    expect(tiny.ok && occStrikeText(tiny.value)).toEqual({ ok: true, value: '0.0010' });
  });

  const badTerms: [string, unknown, OccProblemCode][] = [
    ['a non-object', null, 'NOT_AN_OBJECT'],
    ['a missing root', { expiry: '2026-09-16', right: 'C', strike: 245 }, 'BAD_ROOT'],
    ['an empty root', { root: '', expiry: '2026-09-16', right: 'C', strike: 245 }, 'BAD_ROOT'],
    [
      'a seven-character root',
      { root: 'ABCDEFG', expiry: '2026-09-16', right: 'C', strike: 245 },
      'BAD_ROOT',
    ],
    [
      'a lowercase root',
      { root: 'aapl', expiry: '2026-09-16', right: 'C', strike: 245 },
      'BAD_ROOT',
    ],
    ['a non-ISO expiry', { root: 'AAPL', expiry: '16/09/2026', right: 'C', strike: 245 }, 'BAD_EXPIRY'],
    [
      'an impossible expiry',
      { root: 'AAPL', expiry: '2026-02-30', right: 'C', strike: 245 },
      'BAD_EXPIRY',
    ],
    [
      'an expiry before the OSI window',
      { root: 'AAPL', expiry: '1999-09-16', right: 'C', strike: 245 },
      'BAD_EXPIRY',
    ],
    [
      'an expiry after the OSI window',
      { root: 'AAPL', expiry: '2100-09-16', right: 'C', strike: 245 },
      'BAD_EXPIRY',
    ],
    ['a bad right', { root: 'AAPL', expiry: '2026-09-16', right: 'X', strike: 245 }, 'BAD_RIGHT'],
    [
      'a strike finer than a thousandth',
      { root: 'AAPL', expiry: '2026-09-16', right: 'C', strike: 245.00005 },
      'BAD_STRIKE',
    ],
    ['a zero strike', { root: 'AAPL', expiry: '2026-09-16', right: 'C', strike: 0 }, 'BAD_STRIKE'],
    [
      'a negative strike',
      { root: 'AAPL', expiry: '2026-09-16', right: 'C', strike: -1 },
      'BAD_STRIKE',
    ],
    [
      'a strike wider than eight digits',
      { root: 'AAPL', expiry: '2026-09-16', right: 'C', strike: 100_000 },
      'BAD_STRIKE',
    ],
    [
      'a NaN strike',
      { root: 'AAPL', expiry: '2026-09-16', right: 'C', strike: Number.NaN },
      'BAD_STRIKE',
    ],
    [
      'an infinite strike',
      { root: 'AAPL', expiry: '2026-09-16', right: 'C', strike: Number.POSITIVE_INFINITY },
      'BAD_STRIKE',
    ],
    ['a missing strike', { root: 'AAPL', expiry: '2026-09-16', right: 'C' }, 'BAD_STRIKE'],
    [
      'non-integer thousandths',
      { root: 'AAPL', expiry: '2026-09-16', right: 'C', strikeThousandths: 1.5 },
      'BAD_STRIKE',
    ],
  ];

  for (const [label, terms, code] of badTerms) {
    it(`rejects ${label}`, () => {
      const r = formatOcc(terms as never);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem.code).toBe(code);
    });
  }
});

describe('toOsiForm / toCboeForm — conversion between the two spellings', () => {
  it('converts in both directions and is idempotent on its own output', () => {
    const cboe = 'F260116C00012000';
    const osi = toOsiForm(cboe);
    expect(osi).toEqual({ ok: true, value: 'F     260116C00012000' });
    if (!osi.ok) return;
    expect(toOsiForm(osi.value)).toEqual(osi);
    expect(toCboeForm(osi.value)).toEqual({ ok: true, value: cboe });
    expect(toCboeForm(cboe)).toEqual({ ok: true, value: cboe });
  });

  it('passes a problem through instead of throwing', () => {
    const r = toOsiForm('nonsense');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.code).toBe('BAD_LENGTH');
    const c = toCboeForm('AAPL260916X00245000');
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.problem.code).toBe('BAD_RIGHT');
  });
});
