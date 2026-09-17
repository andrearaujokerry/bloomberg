// packages/core/test/command/args.test.ts — WP-03 (WORKPLAN L610).
//
// The binding acceptance row is "every `ArgType` syntax in §2.4 (L735-766)": the fifteen rows of the
// coercion table, each with the syntaxes the table lists and the value it says they produce, plus
// the three mapping rules above it (keyed arguments first, positional slots with the optional-slot
// skip, leftovers into `rest`).
//
// `env.today` is pinned to Thursday 17 September 2026 so that `TODAY` and `T-<n>` are exact: the
// NYSE business days before it are the 16th, 15th, 14th and 11th (the 12th and 13th are a weekend).

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AnyFunctionManifest, ArgType, ParamGrammar } from '../../src/functions/manifest.js';
import { FunctionRegistry } from '../../src/functions/registry.js';
import type { AssetClass, MarketSector } from '../../src/types/instrument.js';
import { coerceArg, parseArgs } from '../../src/command/args.js';
import type { ParseEnv, TickerHit } from '../../src/command/parser.js';
import { sectorAllowsAssetClass } from '../../src/command/sectors.js';

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

const manifest = (code: string, paramGrammar: ParamGrammar): AnyFunctionManifest => ({
  code,
  name: code,
  aliases: [],
  tier: 1,
  category: 'reference',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: z.object({}),
  paramGrammar,
  fieldIds: () => [],
  pageable: false,
  live: null,
  csv: { filename: () => 'fixture.csv', columns: [], rows: () => [] },
  help: { summary: '', description: '', params: [], keys: [], sources: [], related: [] },
  keymap: [],
  screenKind: 'declarative',
  payloadVersion: 1,
});

interface Row extends TickerHit {
  ticker: string;
}
const row = (
  instrumentId: number,
  ticker: string,
  assetClass: AssetClass,
  marketSector: MarketSector,
  display: string,
): Row => ({ instrumentId, ticker, assetClass, marketSector, display });

const UNIVERSE: readonly Row[] = [
  row(1, 'AAPL', 'equity', 'Equity', 'AAPL US Equity'),
  row(5, 'SPX', 'index', 'Index', 'SPX Index'),
];

const env: ParseEnv = {
  registry: new FunctionRegistry([manifest('X', { positional: [] })]),
  panel: { security: null, fn: null, params: {} },
  lookupTicker: (tokens, opts) => {
    const key = tokens.join(' ').toUpperCase();
    return UNIVERSE.filter(
      (r) =>
        r.ticker === key &&
        (opts?.sector === undefined || sectorAllowsAssetClass(opts.sector, r.assetClass)),
    ).map(({ instrumentId, assetClass, marketSector, display }) => ({
      instrumentId,
      assetClass,
      marketSector,
      display,
    }));
  },
  today: '2026-09-17',
};

const value = (type: ArgType, token: string, values?: readonly string[]): unknown => {
  const out = coerceArg(type, token, env, values);
  if (!out.ok) throw new Error(`${type} rejected '${token}': ${out.message}`);
  return out.value;
};

const rejects = (type: ArgType, token: string, values?: readonly string[]): boolean =>
  !coerceArg(type, token, env, values).ok;

/* ---------------------------------------------------------------------------------------------- */
/* §2.4 coercion table                                                                              */
/* ---------------------------------------------------------------------------------------------- */

describe('§2.4 ArgType — tenor', () => {
  it('accepts `^\\d+[DWMY]$` and uppercases it', () => {
    expect(value('tenor', '10D')).toBe('10D');
    expect(value('tenor', '13w')).toBe('13W');
    expect(value('tenor', '6M')).toBe('6M');
    expect(value('tenor', '10Y')).toBe('10Y');
  });

  it('rejects anything else', () => {
    for (const bad of ['10X', '1.5Y', 'Y10', '10', '', 'YTD']) {
      expect(rejects('tenor', bad)).toBe(true);
    }
  });
});

describe('§2.4 ArgType — range', () => {
  it('accepts the eleven range words, case-insensitively', () => {
    for (const r of ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '2Y', '5Y', '10Y', 'MAX']) {
      expect(value('range', r.toLowerCase())).toBe(r);
    }
  });

  it("accepts a tenor only when the manifest's enum lists it", () => {
    expect(value('range', '13W', ['1D', '13W', 'MAX'])).toBe('13W');
    expect(rejects('range', '13W')).toBe(true);
  });

  it("the manifest's enum extends the eleven words, it does not replace them", () => {
    // §2.4 L759 states the accepted syntax as the fixed list and adds only that "a tenor is
    // accepted when the manifest's enum lists it". A manifest that names a couple of extra tenors
    // must not stop accepting the standard ranges its own screen supports.
    const enumeration = ['1D', '13W', 'MAX'];
    for (const r of ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '2Y', '5Y', '10Y', 'MAX']) {
      expect(value('range', r.toLowerCase(), enumeration)).toBe(r);
    }
    expect(value('range', '13w', enumeration)).toBe('13W');
    expect(rejects('range', '7X', enumeration)).toBe(true);
  });
});

describe('§2.4 ArgType — date', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(value('date', '2026-09-15')).toBe('2026-09-15');
  });

  it('accepts M/D/YY and M/D/YYYY', () => {
    expect(value('date', '9/16/26')).toBe('2026-09-16');
    expect(value('date', '12/1/2026')).toBe('2026-12-01');
    expect(value('date', '9/16/99')).toBe('1999-09-16');
  });

  it('accepts DDMMMYY and DDMMMYYYY', () => {
    expect(value('date', '15SEP26')).toBe('2026-09-15');
    expect(value('date', '15sep2026')).toBe('2026-09-15');
    expect(value('date', '1JAN27')).toBe('2027-01-01');
  });

  it('accepts TODAY and T-<n>, counting NYSE business days', () => {
    expect(value('date', 'TODAY')).toBe('2026-09-17');
    expect(value('date', 'T-0')).toBe('2026-09-17');
    expect(value('date', 'T-1')).toBe('2026-09-16');
    expect(value('date', 'T-3')).toBe('2026-09-14');
    // The 12th and 13th are a weekend, so four business days back is Friday the 11th.
    expect(value('date', 'T-4')).toBe('2026-09-11');
  });

  it('skips a market holiday: the day before Thanksgiving 2026 is Wednesday the 25th', () => {
    const thanksgivingEnv: ParseEnv = { ...env, today: '2026-11-27' };
    const out = coerceArg('date', 'T-1', thanksgivingEnv);
    expect(out).toEqual({ ok: true, value: '2026-11-25' });
  });

  it('rejects impossible dates and unknown shapes', () => {
    for (const bad of ['2026-02-30', '13/1/26', '32SEP26', '15XXX26', 'YESTERDAY', '']) {
      expect(rejects('date', bad)).toBe(true);
    }
  });

  it('reports rather than guesses when env.today is absent', () => {
    const clockless: ParseEnv = {
      registry: env.registry,
      panel: env.panel,
      lookupTicker: (tokens, opts) => env.lookupTicker(tokens, opts),
    };
    expect(rejects('date', 'TODAY')).toBe(false);
    expect(coerceArg('date', 'TODAY', clockless).ok).toBe(false);
    expect(coerceArg('date', 'T-5', clockless).ok).toBe(false);
  });
});

describe('§2.4 ArgType — datetime', () => {
  it('accepts a date plus T HH:MM, assuming Eastern time, and answers in UTC', () => {
    expect(value('datetime', '2026-09-15T14:30')).toBe('2026-09-15T18:30:00Z');
    expect(value('datetime', '2026-01-15T09:30')).toBe('2026-01-15T14:30:00Z');
  });

  it('accepts the bare date forms as Eastern midnight', () => {
    expect(value('datetime', '2026-09-15')).toBe('2026-09-15T04:00:00Z');
    expect(value('datetime', '15JAN26')).toBe('2026-01-15T05:00:00Z');
  });

  it('rejects impossible times', () => {
    expect(rejects('datetime', '2026-09-15T25:00')).toBe(true);
    expect(rejects('datetime', '2026-09-15T14:99')).toBe(true);
  });
});

describe('§2.4 ArgType — number and int', () => {
  it('accepts a JS numeric literal', () => {
    expect(value('number', '4.25')).toBe(4.25);
    expect(value('number', '-2.5')).toBe(-2.5);
    expect(value('number', '1e3')).toBe(1000);
  });

  it('accepts % and bp suffixes', () => {
    expect(value('number', '50bp')).toBeCloseTo(0.005, 12);
    expect(value('number', '50BPS')).toBeCloseTo(0.005, 12);
    expect(value('number', '10%')).toBeCloseTo(0.1, 12);
  });

  it('accepts _ and , thousands separators', () => {
    expect(value('number', '1_000')).toBe(1000);
    expect(value('number', '1,250,000')).toBe(1_250_000);
  });

  it('int rejects fractions', () => {
    expect(value('int', '42')).toBe(42);
    expect(value('int', '1_000')).toBe(1000);
    expect(rejects('int', '4.25')).toBe(true);
    expect(rejects('int', '50bp')).toBe(true);
  });

  it('rejects what is not a number', () => {
    for (const bad of ['', 'NaN', 'Infinity', '4..2', '0x10', '4 25']) {
      expect(rejects('number', bad)).toBe(true);
    }
  });
});

describe('§2.4 ArgType — enum', () => {
  const values = ['price', 'total_return', 'none'];

  it('accepts the exact value, case-insensitively', () => {
    expect(value('enum', 'TOTAL_RETURN', values)).toBe('total_return');
  });

  it('accepts a unique case-insensitive prefix', () => {
    expect(value('enum', 'pr', values)).toBe('price');
    expect(value('enum', 'tot', values)).toBe('total_return');
  });

  it("accepts the short alias form: 'TR' -> total_return (§2.4 L763)", () => {
    expect(value('enum', 'TR', values)).toBe('total_return');
  });

  it('rejects an ambiguous prefix and names the candidates', () => {
    const ambiguous = coerceArg('enum', 'c', env, ['candle', 'close']);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.message).toContain('candle');
      expect(ambiguous.message).toContain('close');
    }
  });

  it('rejects a value outside the list, and any value when the list is empty', () => {
    expect(rejects('enum', 'zigzag', values)).toBe(true);
    expect(rejects('enum', 'price')).toBe(true);
  });
});

describe('§2.4 ArgType — boolean', () => {
  it('accepts 1 0 Y N YES NO TRUE FALSE ON OFF', () => {
    for (const t of ['1', 'Y', 'yes', 'TRUE', 'on']) expect(value('boolean', t)).toBe(true);
    for (const f of ['0', 'N', 'no', 'FALSE', 'off']) expect(value('boolean', f)).toBe(false);
  });

  it('rejects anything else', () => {
    expect(rejects('boolean', 'maybe')).toBe(true);
  });
});

describe('§2.4 ArgType — string', () => {
  it('takes any token as typed, keeping its case', () => {
    expect(value('string', 'Tender Offer')).toBe('Tender Offer');
    expect(rejects('string', '')).toBe(true);
  });
});

describe('§2.4 ArgType — security', () => {
  it('accepts a ticker key with a sector', () => {
    expect(value('security', 'AAPL US Equity')).toEqual({ id: 1 });
  });

  it('accepts an identifier', () => {
    expect(value('security', '/isin/US0378331005')).toEqual({ ref: '/isin/US0378331005' });
    expect(value('security', '912797VE4')).toEqual({ ref: '/cusip/912797VE4' });
  });

  it('accepts a bare ticker, resolved through env.lookupTicker', () => {
    expect(value('security', 'AAPL')).toEqual({ id: 1 });
    expect(value('security', 'ZZZZ')).toEqual({ ref: 'ZZZZ' });
  });

  it('accepts a formula', () => {
    expect(value('security', '<RATIO(AAPL US Equity, SPX Index)>')).toEqual({
      formula: 'RATIO(AAPL US Equity, SPX Index)',
    });
  });
});

describe('§2.4 ArgType — topic, watchlist, index, currency, curve', () => {
  it('topic: a topic code, uppercased', () => {
    expect(value('topic', 'FED')).toBe('FED');
    expect(value('topic', 'markets')).toBe('MARKETS');
    expect(rejects('topic', '@@')).toBe(true);
  });

  it('watchlist: a name or a numeric id', () => {
    expect(value('watchlist', 'MAG7')).toEqual({ kind: 'watchlist', name: 'MAG7' });
    expect(value('watchlist', '42')).toEqual({ kind: 'watchlist', id: 42 });
  });

  it('index: an index code resolved to its Index instrument', () => {
    expect(value('index', 'SPX')).toEqual({ id: 5 });
    expect(value('index', 'NDX')).toEqual({ ref: 'NDX Index' });
  });

  it('currency: ISO 4217, uppercased', () => {
    expect(value('currency', 'usd')).toBe('USD');
    expect(rejects('currency', 'US')).toBe(true);
    expect(rejects('currency', 'DOLLAR')).toBe(true);
  });

  it('curve: a curve id, uppercased', () => {
    expect(value('curve', 'ust_par')).toBe('UST_PAR');
    expect(value('curve', 'SOFR_OIS')).toBe('SOFR_OIS');
    expect(rejects('curve', '1')).toBe(true);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* §2.4 mapping rules 1-3                                                                           */
/* ---------------------------------------------------------------------------------------------- */

const HP: ParamGrammar = {
  positional: [
    { name: 'range', type: 'range', optional: true },
    { name: 'periodicity', type: 'enum', values: ['D', 'W', 'M', 'Q', 'Y'], optional: true },
  ],
  keyed: {
    ADJ: { name: 'adjust', type: 'enum', values: ['price', 'total_return'] },
    FX: { name: 'currency', type: 'currency' },
  },
};

describe('§2.4 rule 1 — keyed arguments', () => {
  it('maps KEY=VALUE onto the grammar key, case-insensitively', () => {
    const out = parseArgs(HP, ['adj=TR', 'FX=usd'], env);
    expect(out.params).toEqual({ adjust: 'total_return', currency: 'USD' });
    expect(out.problems).toEqual([]);
  });

  it('reports an unknown key and drops it', () => {
    const out = parseArgs(HP, ['BOGUS=1'], env);
    expect(out.params).toEqual({});
    expect(out.problems.map((p) => p.code)).toEqual(['ARG_PARSE']);
    expect(out.problems[0]?.message).toContain('BOGUS');
  });

  it('reports a keyed value that fails its type', () => {
    const out = parseArgs(HP, ['FX=DOLLAR'], env);
    expect(out.params).toEqual({});
    expect(out.problems[0]?.code).toBe('ARG_PARSE');
    expect(out.problems[0]?.message).toContain('FX');
  });

  it('carries the span of the offending token when the parser supplies one', () => {
    const out = parseArgs(HP, ['BOGUS=1'], env, { spans: [[3, 10]] });
    expect(out.problems[0]?.span).toEqual([3, 10]);
  });
});

describe('§2.4 rule 2 — positional slots', () => {
  it("fills slots in order: 'HP 1Y W'", () => {
    const out = parseArgs(HP, ['1Y', 'W'], env);
    expect(out.params).toEqual({ range: '1Y', periodicity: 'W' });
    expect(out.problems).toEqual([]);
  });

  it("skips an optional slot the token does not fit: 'HP W' fills periodicity", () => {
    const out = parseArgs(HP, ['W'], env);
    expect(out.params).toEqual({ periodicity: 'W' });
    expect(out.problems).toEqual([]);
  });

  it('reports a required slot with no token', () => {
    const grammar: ParamGrammar = {
      positional: [
        { name: 'topic', type: 'topic' },
        { name: 'limit', type: 'int', optional: true },
      ],
    };
    const out = parseArgs(grammar, [], env);
    expect(out.params).toEqual({});
    expect(out.problems.map((p) => p.code)).toEqual(['ARG_PARSE']);
    expect(out.problems[0]?.message).toContain('topic');
  });

  it('fills a required slot then an optional one', () => {
    const grammar: ParamGrammar = {
      positional: [
        { name: 'topic', type: 'topic' },
        { name: 'limit', type: 'int', optional: true },
      ],
    };
    expect(parseArgs(grammar, ['FED', '25'], env).params).toEqual({ topic: 'FED', limit: 25 });
  });
});

describe('§2.4 rule 3 — leftovers', () => {
  it('joins leftovers into rest with single spaces, keeping the raw case', () => {
    const grammar: ParamGrammar = { positional: [], rest: { name: 'query', type: 'text' } };
    const out = parseArgs(grammar, ['tender', 'Offer', 'Corp'], env);
    expect(out.params).toEqual({ query: 'tender Offer Corp' });
    expect(out.problems).toEqual([]);
  });

  it('reports the first leftover when the grammar has no rest slot', () => {
    const out = parseArgs(HP, ['1Y', 'W', 'EXTRA', 'MORE'], env);
    expect(out.params).toEqual({ range: '1Y', periodicity: 'W' });
    expect(out.problems.map((p) => p.code)).toEqual(['ARG_PARSE']);
    expect(out.problems[0]?.message).toContain('EXTRA');
  });

  it('takes no arguments at all without complaint when the grammar is empty', () => {
    expect(parseArgs({ positional: [] }, [], env)).toEqual({ params: {}, problems: [] });
  });

  it('never throws on hostile input', () => {
    const nasty = ['=', '==', 'K=', '=V', ' ', '😀', 'A'.repeat(5000)];
    expect(() => parseArgs(HP, nasty, env)).not.toThrow();
    const grammar: ParamGrammar = { positional: [], rest: { name: 'query', type: 'text' } };
    expect(() => parseArgs(grammar, nasty, env)).not.toThrow();
  });
});
