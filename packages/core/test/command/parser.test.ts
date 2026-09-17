// packages/core/test/command/parser.test.ts — WP-03 (WORKPLAN L608).
//
// The binding acceptance row is "every worked example in FUNCTIONS.md §2.7 (L813-856)". Each of the
// spec's 34 rows is one `it`, asserted on the WHOLE parse result — shape, security text, sector
// flag, function code and alias, args, params and problems — and, where the row's "Executed" column
// says what GO does, on `toRunRequest` as well, because that column is the TERM-03 rule (§2.5) and
// not a restatement of the parse.
//
// The catalogue and the universe below are fixtures: `packages/core/src/functions/manifests/` is
// empty until the function work packages land, and §2.7 names functions (GP, HP, YAS, OVML, QM,
// MEMB, ICVS) and instruments (Wayfair, CF Industries, the 10-year note) from all of them. What the
// parser needs from a manifest is exactly four fields — `assetClasses`, `requiresSecurity`,
// `paramGrammar` and `aliasParams` — so the fixtures state those and default the rest.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AnyFunctionManifest, ParamGrammar } from '../../src/functions/manifest.js';
import { FunctionRegistry } from '../../src/functions/registry.js';
import type { AssetClass, MarketSector } from '../../src/types/instrument.js';
import {
  insertTextFor,
  parse,
  toRunRequest,
  type ParseEnv,
  type ParsedCommand,
  type PanelContext,
  type TickerHit,
} from '../../src/command/parser.js';
import { sectorAllowsAssetClass } from '../../src/command/sectors.js';

/* ---------------------------------------------------------------------------------------------- */
/* Catalogue fixture                                                                                */
/* ---------------------------------------------------------------------------------------------- */

interface ManifestSpec {
  code: string;
  assetClasses: AnyFunctionManifest['assetClasses'];
  aliases?: string[];
  requiresSecurity?: boolean;
  paramGrammar?: ParamGrammar;
  params?: z.ZodObject<z.ZodRawShape>;
  aliasParams?: Record<string, Record<string, unknown>>;
}

const manifest = (spec: ManifestSpec): AnyFunctionManifest => ({
  code: spec.code,
  name: spec.code,
  aliases: spec.aliases ?? [],
  tier: 1,
  category: 'reference',
  assetClasses: spec.assetClasses,
  requiresSecurity: spec.requiresSecurity ?? false,
  variants: {},
  params: spec.params ?? z.object({}),
  paramGrammar: spec.paramGrammar ?? { positional: [] },
  fieldIds: () => [],
  pageable: false,
  live: null,
  csv: { filename: () => 'fixture.csv', columns: [], rows: () => [] },
  help: { summary: '', description: '', params: [], keys: [], sources: [], related: [] },
  keymap: [],
  screenKind: 'declarative',
  payloadVersion: 1,
  ...(spec.aliasParams === undefined ? {} : { aliasParams: spec.aliasParams }),
});

const PRICED: readonly AssetClass[] = [
  'equity',
  'etf',
  'index',
  'fx',
  'govt',
  'option',
  'crypto',
  'rate',
  'econ',
];

const GP_GRAMMAR: ParamGrammar = {
  positional: [{ name: 'range', type: 'range', optional: true }],
  keyed: {
    TYPE: { name: 'type', type: 'enum', values: ['line', 'candle', 'ohlc', 'bar', 'mountain'] },
    ADJ: { name: 'adjust', type: 'enum', values: ['price', 'total_return', 'none'] },
  },
};

const HP_GRAMMAR: ParamGrammar = {
  positional: [
    { name: 'range', type: 'range', optional: true },
    { name: 'start', type: 'date', optional: true },
    { name: 'end', type: 'date', optional: true },
    { name: 'periodicity', type: 'enum', values: ['D', 'W', 'M', 'Q', 'Y'], optional: true },
  ],
};

const registry = new FunctionRegistry([
  manifest({ code: 'DES', assetClasses: PRICED, requiresSecurity: true }),
  manifest({
    code: 'GP',
    assetClasses: PRICED,
    requiresSecurity: true,
    paramGrammar: GP_GRAMMAR,
    params: z.object({ range: z.string().default('1Y') }),
  }),
  manifest({
    code: 'HP',
    assetClasses: PRICED,
    requiresSecurity: true,
    paramGrammar: HP_GRAMMAR,
  }),
  manifest({ code: 'YAS', assetClasses: ['govt'], requiresSecurity: true }),
  manifest({ code: 'OVML', assetClasses: ['option'], requiresSecurity: true }),
  manifest({ code: 'CF', assetClasses: ['equity', 'etf'], requiresSecurity: true }),
  manifest({
    code: 'N',
    assetClasses: 'any',
    paramGrammar: { positional: [], rest: { name: 'query', type: 'text' } },
  }),
  manifest({
    code: 'NI',
    assetClasses: 'none',
    paramGrammar: { positional: [{ name: 'topic', type: 'topic' }] },
  }),
  manifest({ code: 'TOP', assetClasses: 'none' }),
  manifest({
    code: 'QM',
    assetClasses: 'none',
    paramGrammar: { positional: [{ name: 'source', type: 'watchlist' }] },
  }),
  manifest({
    code: 'MEMB',
    assetClasses: 'none',
    paramGrammar: { positional: [{ name: 'index', type: 'index' }] },
  }),
  manifest({
    code: 'ECO',
    assetClasses: 'none',
    params: z.object({ country: z.string().default('US') }),
  }),
  manifest({ code: 'W', assetClasses: 'none' }),
  manifest({ code: 'MSG', aliases: ['IB'], assetClasses: 'none' }),
  manifest({
    code: 'CRVF',
    aliases: ['ICVS'],
    assetClasses: 'none',
    aliasParams: { ICVS: { curveId: 'SOFR_OIS' } },
    paramGrammar: { positional: [{ name: 'curveId', type: 'curve', optional: true }] },
  }),
  manifest({ code: 'SECF', assetClasses: 'none' }),
  manifest({ code: 'HELP', assetClasses: 'none' }),
]);

/* ---------------------------------------------------------------------------------------------- */
/* Universe fixture                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

interface UniverseRow extends TickerHit {
  ticker: string;
  exchCode: string;
}

const row = (
  instrumentId: number,
  ticker: string,
  assetClass: AssetClass,
  marketSector: MarketSector,
  display: string,
  exchCode = 'US',
): UniverseRow => ({ instrumentId, ticker, assetClass, marketSector, display, exchCode });

const UNIVERSE: readonly UniverseRow[] = [
  row(1, 'AAPL', 'equity', 'Equity', 'AAPL US Equity'),
  row(2, 'MSFT', 'equity', 'Equity', 'MSFT US Equity'),
  row(3, 'W', 'equity', 'Equity', 'W US Equity'),
  row(4, 'CF', 'equity', 'Equity', 'CF US Equity'),
  row(5, 'SPX', 'index', 'Index', 'SPX Index', 'INDEX'),
  row(6, 'EURUSD', 'fx', 'Curncy', 'EURUSD Curncy', 'FX'),
  row(7, 'SOFR', 'rate', 'Index', 'SOFR Index', 'RATE'),
  row(8, 'T', 'equity', 'Equity', 'T US Equity'),
  row(9, 'T 4.25 08/15/36', 'govt', 'Govt', 'T 4.25 08/15/36 Govt', 'GOVT'),
  row(10, '912797VE4', 'govt', 'Govt', '912797VE4 Govt', 'GOVT'),
  row(11, 'AAPL 9/16/26 C245', 'option', 'Equity', 'AAPL 9/16/26 C245 Equity'),
  row(12, 'GPC', 'equity', 'Equity', 'GPC US Equity'),
];

const lookupTicker = (
  tokens: string[],
  opts?: { exchCode?: string; sector?: MarketSector },
): TickerHit[] => {
  const key = tokens.join(' ').toUpperCase();
  return UNIVERSE.filter((r) => {
    if (r.ticker.toUpperCase() !== key) return false;
    if (opts?.exchCode !== undefined && r.exchCode !== opts.exchCode.toUpperCase()) return false;
    if (opts?.sector !== undefined && !sectorAllowsAssetClass(opts.sector, r.assetClass)) {
      return false;
    }
    return true;
  }).map(({ instrumentId, assetClass, marketSector, display }) => ({
    instrumentId,
    assetClass,
    marketSector,
    display,
  }));
};

const emptyPanel: PanelContext = { security: null, fn: null, params: {} };

const panelOn = (
  id: number,
  fn: string | null,
  params: Record<string, unknown> = {},
): PanelContext => {
  const found = UNIVERSE.find((r) => r.instrumentId === id);
  if (found === undefined) throw new Error(`no fixture instrument ${String(id)}`);
  return {
    security: {
      instrumentId: found.instrumentId,
      assetClass: found.assetClass,
      marketSector: found.marketSector,
      display: found.display,
    },
    fn,
    params,
  };
};

const envWith = (panel: PanelContext): ParseEnv => ({
  registry,
  panel,
  lookupTicker,
  today: '2026-09-17',
  panelId: 'p1',
});

const env = envWith(emptyPanel);

const codes = (cmds: readonly ParsedCommand[]): string[] =>
  cmds.map(
    (c) => `${c.shape}:${c.security?.text ?? ''}${c.fn === undefined ? '' : `/${c.fn.code}`}`,
  );

/* ---------------------------------------------------------------------------------------------- */
/* §2.7 worked examples                                                                             */
/* ---------------------------------------------------------------------------------------------- */

describe('FUNCTIONS.md §2.7 worked examples', () => {
  it("'AAPL' (empty panel) — S: AAPL US Equity, no function; GO runs DES", () => {
    const out = parse('AAPL', env);
    const first = out[0];
    expect(first).toBeDefined();
    expect(first?.shape).toBe('security');
    expect(first?.security?.text).toBe('AAPL US Equity');
    expect(first?.security?.sectorGiven).toBe(false);
    expect(first?.security?.instrumentId).toBe(1);
    expect(first?.security?.assetClass).toBe('equity');
    expect(first?.security?.ref).toEqual({ kind: 'ticker', value: 'AAPL', sector: 'Equity' });
    expect(first?.security?.span).toEqual([0, 4]);
    expect(first?.fn).toBeUndefined();
    expect(first?.args).toEqual([]);
    expect(first?.problems).toEqual([]);

    expect(toRunRequest(out[0]!, env)).toEqual({
      code: 'DES',
      body: { security: { id: 1 }, params: {}, panelId: 'p1', launchKind: 'launch' },
    });
  });

  it("'AAPL' (panel: MSFT / GP {range:'5Y'}) — TERM-03 keeps the panel function and params", () => {
    const panel = envWith(panelOn(2, 'GP', { range: '5Y' }));
    const out = parse('AAPL', panel);
    expect(out[0]?.shape).toBe('security');
    expect(out[0]?.security?.text).toBe('AAPL US Equity');
    expect(out[0]?.fn).toBeUndefined();

    expect(toRunRequest(out[0]!, panel)).toEqual({
      code: 'GP',
      body: {
        security: { id: 1 },
        params: { range: '5Y' },
        panelId: 'p1',
        launchKind: 'launch',
      },
    });
  });

  it("'AAPL US' — S with the exchange code given", () => {
    const out = parse('AAPL US', env);
    expect(out[0]?.shape).toBe('security');
    expect(out[0]?.security?.text).toBe('AAPL US Equity');
    expect(out[0]?.security?.sectorGiven).toBe(false);
    expect(out[0]?.security?.ref).toEqual({
      kind: 'ticker',
      value: 'AAPL',
      exchCode: 'US',
      sector: 'Equity',
    });
    expect(out[0]?.security?.span).toEqual([0, 7]);
    expect(out[0]?.problems).toEqual([]);
    expect(toRunRequest(out[0]!, env)).toEqual({
      code: 'DES',
      body: { security: { id: 1 }, params: {}, panelId: 'p1', launchKind: 'launch' },
    });
  });

  it("'AAPL US Equity' — sector anchor", () => {
    const out = parse('AAPL US Equity', env);
    expect(out[0]?.shape).toBe('security');
    expect(out[0]?.security?.sectorGiven).toBe(true);
    expect(out[0]?.security?.text).toBe('AAPL US Equity');
    expect(out[0]?.security?.ref).toEqual({
      kind: 'ticker',
      value: 'AAPL',
      exchCode: 'US',
      sector: 'Equity',
    });
    expect(out[0]?.security?.instrumentId).toBe(1);
    expect(out[0]?.problems).toEqual([]);
  });

  it("'aapl equity gp 1y' — sector anchor + F, case-insensitive", () => {
    const out = parse('aapl equity gp 1y', env);
    const first = out[0];
    expect(first?.shape).toBe('security+function');
    expect(first?.security?.text).toBe('AAPL US Equity');
    expect(first?.security?.sectorGiven).toBe(true);
    expect(first?.fn?.code).toBe('GP');
    expect(first?.fn?.alias).toBeUndefined();
    expect(first?.args).toEqual(['1y']);
    expect(first?.params).toEqual({ range: '1Y' });
    expect(first?.problems).toEqual([]);

    expect(toRunRequest(first!, env)).toEqual({
      code: 'GP',
      body: { security: { id: 1 }, params: { range: '1Y' }, panelId: 'p1', launchKind: 'launch' },
    });
  });

  it("'GP' (panel: AAPL) — F, R0, runs on the panel security", () => {
    const panel = envWith(panelOn(1, 'DES'));
    const out = parse('GP', panel);
    expect(out[0]?.shape).toBe('function');
    expect(out[0]?.fn?.code).toBe('GP');
    expect(out[0]?.security).toBeUndefined();
    expect(out[0]?.params).toEqual({});
    expect(out[0]?.problems).toEqual([]);

    expect(toRunRequest(out[0]!, panel)).toEqual({
      code: 'GP',
      body: { security: { id: 1 }, params: { range: '1Y' }, panelId: 'p1', launchKind: 'launch' },
    });
  });

  it("'GP' (empty panel) — F with NO_SECURITY_LOADED; row 2 offers SECF GP", () => {
    const out = parse('GP', env);
    expect(out[0]?.shape).toBe('function');
    expect(out[0]?.fn?.code).toBe('GP');
    expect(out[0]?.problems).toHaveLength(1);
    expect(out[0]?.problems[0]?.code).toBe('NO_SECURITY_LOADED');
    expect(out[0]?.problems[0]?.span).toEqual([0, 2]);
    expect(out[0]?.problems[0]?.message).toContain('SECF GP');

    const run = toRunRequest(out[0]!, env);
    expect(run).toEqual({
      problem: {
        code: 'NO_SECURITY_LOADED',
        span: [0, 2],
        message: expect.stringContaining('SECF GP'),
      },
    });
  });

  it("'GP 5Y TYPE=CANDLE ADJ=TR' — F with positional and keyed args", () => {
    const panel = envWith(panelOn(1, 'DES'));
    const out = parse('GP 5Y TYPE=CANDLE ADJ=TR', panel);
    expect(out[0]?.shape).toBe('function');
    expect(out[0]?.fn?.code).toBe('GP');
    expect(out[0]?.args).toEqual(['5Y', 'TYPE=CANDLE', 'ADJ=TR']);
    expect(out[0]?.argSpan).toEqual([3, 24]);
    expect(out[0]?.params).toEqual({ range: '5Y', type: 'candle', adjust: 'total_return' });
    expect(out[0]?.problems).toEqual([]);
  });

  it("'W' — R0: the Watchlists function, with Wayfair as row 2", () => {
    const out = parse('W', env);
    expect(out[0]?.shape).toBe('function');
    expect(out[0]?.fn?.code).toBe('W');
    expect(out[0]?.problems).toEqual([]);
    expect(out[1]?.shape).toBe('security');
    expect(out[1]?.security?.text).toBe('W US Equity');
    expect(out[1]?.security?.instrumentId).toBe(3);
  });

  it("'W US Equity' — sector anchor: DES on Wayfair", () => {
    const out = parse('W US Equity', env);
    expect(out).toHaveLength(1);
    expect(out[0]?.shape).toBe('security');
    expect(out[0]?.security?.text).toBe('W US Equity');
    expect(out[0]?.security?.sectorGiven).toBe(true);
    expect(out[0]?.fn).toBeUndefined();
    expect(toRunRequest(out[0]!, env)).toEqual({
      code: 'DES',
      body: { security: { id: 3 }, params: {}, panelId: 'p1', launchKind: 'launch' },
    });
  });

  it("'CF' (panel: AAPL) — R0: Company Filings is applicable to equity", () => {
    const panel = envWith(panelOn(1, 'DES'));
    const out = parse('CF', panel);
    expect(out[0]?.shape).toBe('function');
    expect(out[0]?.fn?.code).toBe('CF');
    expect(out[0]?.problems).toEqual([]);
    expect(codes(out)).toEqual(['function:/CF', 'security:CF US Equity']);
    expect(toRunRequest(out[0]!, panel)).toEqual({
      code: 'CF',
      body: { security: { id: 1 }, params: {}, panelId: 'p1', launchKind: 'launch' },
    });
  });

  it("'CF' (panel: EURUSD Curncy) — not applicable to fx, so CF Industries sorts first", () => {
    const panel = envWith(panelOn(6, 'DES'));
    const out = parse('CF', panel);
    expect(codes(out)).toEqual(['security:CF US Equity', 'function:/CF']);
    expect(out[0]?.security?.instrumentId).toBe(4);
    expect(out[1]?.problems[0]?.code).toBe('NOT_APPLICABLE');
    expect(out[1]?.problems[0]?.message).toContain('Curncy');

    expect(toRunRequest(out[0]!, panel)).toEqual({
      code: 'DES',
      body: { security: { id: 4 }, params: {}, panelId: 'p1', launchKind: 'launch' },
    });
    expect(toRunRequest(out[1]!, panel)).toEqual({
      problem: {
        code: 'NOT_APPLICABLE',
        span: [0, 2],
        message: expect.stringContaining('CF'),
      },
    });
  });

  it("'SPX' — S: SPX Index", () => {
    const out = parse('SPX', env);
    expect(out[0]?.shape).toBe('security');
    expect(out[0]?.security?.text).toBe('SPX Index');
    expect(out[0]?.security?.assetClass).toBe('index');
    expect(out[0]?.security?.ref).toEqual({ kind: 'ticker', value: 'SPX', sector: 'Index' });
  });

  it("'EURUSD' — S: EURUSD Curncy", () => {
    const out = parse('EURUSD', env);
    expect(out).toHaveLength(1);
    expect(out[0]?.security?.text).toBe('EURUSD Curncy');
    expect(out[0]?.security?.assetClass).toBe('fx');
  });

  it("'SOFR' — S: SOFR Index, the M-Mkt spelling of the same instrument listed once", () => {
    const out = parse('SOFR', env);
    expect(out).toHaveLength(1);
    expect(out[0]?.security?.text).toBe('SOFR Index');
    expect(out[0]?.security?.instrumentId).toBe(7);
    // The same instrument under its other sector spelling is the same row, not a second one.
    expect(parse('SOFR M-Mkt', env)[0]?.security?.instrumentId).toBe(7);
    expect(parse('SOFR M-Mkt', env)[0]?.security?.sectorGiven).toBe(true);
  });

  it("'T 4.25 08/15/36 Govt YAS' — sector anchor at k=3 + F", () => {
    const out = parse('T 4.25 08/15/36 Govt YAS', env);
    const first = out[0];
    expect(first?.shape).toBe('security+function');
    expect(first?.security?.text).toBe('T 4.25 08/15/36 Govt');
    expect(first?.security?.sectorGiven).toBe(true);
    expect(first?.security?.instrumentId).toBe(9);
    expect(first?.security?.span).toEqual([0, 20]);
    expect(first?.fn?.code).toBe('YAS');
    expect(first?.args).toEqual([]);
    expect(first?.problems).toEqual([]);
    expect(toRunRequest(first!, env)).toEqual({
      code: 'YAS',
      body: { security: { id: 9 }, params: {}, panelId: 'p1', launchKind: 'launch' },
    });
  });

  it("'T 4.25 08/15/36' — S with j=2, the three-token ticker", () => {
    const out = parse('T 4.25 08/15/36', env);
    expect(out[0]?.shape).toBe('security');
    expect(out[0]?.security?.text).toBe('T 4.25 08/15/36 Govt');
    expect(out[0]?.security?.instrumentId).toBe(9);
    expect(out[0]?.security?.sectorGiven).toBe(false);
    expect(out[0]?.security?.ref).toEqual({
      kind: 'ticker',
      value: 'T 4.25 08/15/36',
      sector: 'Govt',
    });
  });

  it("'912797VE4 Govt' — sector anchor over a CUSIP token", () => {
    const out = parse('912797VE4 Govt', env);
    expect(out[0]?.shape).toBe('security');
    expect(out[0]?.security?.sectorGiven).toBe(true);
    expect(out[0]?.security?.text).toBe('912797VE4 Govt');
    expect(out[0]?.security?.instrumentId).toBe(10);
    expect(out[0]?.security?.ref).toEqual({
      kind: 'ticker',
      value: '912797VE4',
      sector: 'Govt',
    });
  });

  it("'912797VE4' — identifier anchor, CUSIP check digit ok", () => {
    const out = parse('912797VE4', env);
    expect(out[0]?.shape).toBe('security');
    expect(out[0]?.security?.ref).toEqual({ kind: 'cusip', value: '912797VE4' });
    expect(out[0]?.security?.text).toBe('/cusip/912797VE4');
    expect(out[0]?.security?.sectorGiven).toBe(false);
    expect(out[0]?.problems).toEqual([]);
    expect(toRunRequest(out[0]!, env)).toEqual({
      code: 'DES',
      body: {
        security: { ref: '/cusip/912797VE4' },
        params: {},
        panelId: 'p1',
        launchKind: 'launch',
      },
    });
  });

  it("'912797VE5' — the same shape with a wrong check digit reports BAD_IDENTIFIER", () => {
    const out = parse('912797VE5', env);
    expect(out[0]?.problems.some((p) => p.code === 'BAD_IDENTIFIER')).toBe(true);
    expect(out[0]?.problems[0]?.span).toEqual([0, 9]);
  });

  it('a failing check digit is reported once, not once per layer (§2.3 step 4)', () => {
    // Step 4 is singular: a shape match with a failing check digit "adds BAD_IDENTIFIER and falls
    // through". Both the gate and the reading it falls through to notice the same fault, and the
    // footer renders every problem's text, so the user must not read the same complaint twice.
    for (const raw of ['US0378331006', 'BBG000B9XRY0', '912797VE5', '/isin/US0378331006']) {
      const out = parse(raw, env);
      for (const cmd of out) {
        const keys = cmd.problems.map((p) => `${p.code}:${String(p.span[0])}:${String(p.span[1])}`);
        expect(new Set(keys).size).toBe(keys.length);
      }
      expect(out[0]?.problems.filter((p) => p.code === 'BAD_IDENTIFIER')).toHaveLength(1);
    }
  });

  it('a bare identifier is canonicalised to its /scheme/value spelling in `text`', () => {
    // `CommandSecurity.text` is canonical display text: a ticker becomes the matched instrument's
    // display (`AAPL` -> `AAPL US Equity`) and a bare identifier becomes its scheme form, which is
    // unambiguous where the bare form is not and is exactly the string the run request carries for
    // the server to re-parse. Pinned here so the spelling cannot drift silently.
    expect(parse('912797VE4', env)[0]?.security?.text).toBe('/cusip/912797VE4');
    expect(parse('BBG000B9XRY4', env)[0]?.security?.text).toBe('/figi/BBG000B9XRY4');
    expect(parse('/isin/US0378331005', env)[0]?.security?.text).toBe('/isin/US0378331005');
    // A sector anchor keeps the typed key: there the ref is a ticker, not an identifier.
    expect(parse('912797VE4 Govt', env)[0]?.security?.text).toBe('912797VE4 Govt');
  });

  it("'BBG000B9XRY4 HP 2020-01-01 2020-12-31 W' — identifier anchor (FIGI) + F + args", () => {
    const out = parse('BBG000B9XRY4 HP 2020-01-01 2020-12-31 W', env);
    const first = out[0];
    expect(first?.shape).toBe('security+function');
    expect(first?.security?.ref).toEqual({ kind: 'figi', value: 'BBG000B9XRY4' });
    expect(first?.security?.text).toBe('/figi/BBG000B9XRY4');
    expect(first?.fn?.code).toBe('HP');
    expect(first?.args).toEqual(['2020-01-01', '2020-12-31', 'W']);
    expect(first?.params).toEqual({
      start: '2020-01-01',
      end: '2020-12-31',
      periodicity: 'W',
    });
    expect(first?.problems).toEqual([]);
    expect(toRunRequest(first!, env)).toEqual({
      code: 'HP',
      body: {
        security: { ref: '/figi/BBG000B9XRY4' },
        params: { start: '2020-01-01', end: '2020-12-31', periodicity: 'W' },
        panelId: 'p1',
        launchKind: 'launch',
      },
    });
  });

  it("'/isin/US0378331005 DES' — identifier anchor in scheme form + F", () => {
    const out = parse('/isin/US0378331005 DES', env);
    expect(out[0]?.shape).toBe('security+function');
    expect(out[0]?.security?.ref).toEqual({ kind: 'isin', value: 'US0378331005' });
    expect(out[0]?.security?.text).toBe('/isin/US0378331005');
    expect(out[0]?.fn?.code).toBe('DES');
    expect(out[0]?.problems).toEqual([]);
  });

  it("'/panel 3' — shell", () => {
    const out = parse('/panel 3', env);
    expect(out).toHaveLength(1);
    expect(out[0]?.shape).toBe('shell');
    expect(out[0]?.shell).toEqual({ word: 'panel', args: ['3'] });
    expect(out[0]?.problems).toEqual([]);
    expect(toRunRequest(out[0]!, env)).toEqual({
      problem: {
        code: 'NOT_APPLICABLE',
        span: [0, 8],
        message: expect.any(String),
      },
    });
  });

  it("'/panel 9' and '/nope' are still shell lines, with a problem", () => {
    expect(parse('/panel 9', env)[0]?.problems[0]?.code).toBe('ARG_PARSE');
    expect(parse('/nope', env)[0]?.shape).toBe('shell');
    expect(parse('/nope', env)[0]?.problems[0]?.code).toBe('UNKNOWN_FUNCTION');
  });

  it("'AAPL 9/16/26 C245 Equity OVML' — sector anchor at k=3 over the option form + F", () => {
    const out = parse('AAPL 9/16/26 C245 Equity OVML', env);
    const first = out[0];
    expect(first?.shape).toBe('security+function');
    expect(first?.security?.text).toBe('AAPL 9/16/26 C245 Equity');
    expect(first?.security?.sectorGiven).toBe(true);
    expect(first?.security?.instrumentId).toBe(11);
    expect(first?.security?.assetClass).toBe('option');
    expect(first?.fn?.code).toBe('OVML');
    expect(first?.problems).toEqual([]);
    expect(toRunRequest(first!, env)).toEqual({
      code: 'OVML',
      body: { security: { id: 11 }, params: {}, panelId: 'p1', launchKind: 'launch' },
    });
  });

  it("'<RATIO(AAPL US Equity, SPX Index)> GP' — formula anchor + F", () => {
    const raw = '<RATIO(AAPL US Equity, SPX Index)> GP';
    const out = parse(raw, env);
    const first = out[0];
    expect(first?.shape).toBe('security+function');
    expect(first?.security?.ref).toEqual({
      kind: 'formula',
      value: 'RATIO(AAPL US Equity, SPX Index)',
    });
    expect(first?.security?.span).toEqual([0, 34]);
    expect(first?.security?.sectorGiven).toBe(false);
    expect(first?.fn?.code).toBe('GP');
    expect(first?.problems).toEqual([]);
    expect(toRunRequest(first!, env)).toEqual({
      code: 'GP',
      body: {
        security: { formula: 'RATIO(AAPL US Equity, SPX Index)' },
        params: { range: '1Y' },
        panelId: 'p1',
        launchKind: 'launch',
      },
    });
  });

  it("'N tender offer' — F with a rest argument", () => {
    const out = parse('N tender offer', env);
    expect(out[0]?.shape).toBe('function');
    expect(out[0]?.fn?.code).toBe('N');
    expect(out[0]?.args).toEqual(['tender', 'offer']);
    expect(out[0]?.params).toEqual({ query: 'tender offer' });
    expect(out[0]?.problems).toEqual([]);
  });

  it("'NI FED' — F with a positional topic", () => {
    const out = parse('NI FED', env);
    expect(out[0]?.shape).toBe('function');
    expect(out[0]?.fn?.code).toBe('NI');
    expect(out[0]?.params).toEqual({ topic: 'FED' });
    expect(out[0]?.problems).toEqual([]);
  });

  it("'TOP' — F", () => {
    const out = parse('TOP', env);
    expect(out[0]?.shape).toBe('function');
    expect(out[0]?.fn?.code).toBe('TOP');
    expect(toRunRequest(out[0]!, env)).toEqual({
      code: 'TOP',
      body: { params: {}, panelId: 'p1', launchKind: 'launch' },
    });
  });

  it("'QM MAG7' — F with a positional watchlist", () => {
    const out = parse('QM MAG7', env);
    expect(out[0]?.fn?.code).toBe('QM');
    expect(out[0]?.params).toEqual({ source: { kind: 'watchlist', name: 'MAG7' } });
  });

  it("'MEMB SPX' — F with a positional index resolved to its Index instrument", () => {
    const out = parse('MEMB SPX', env);
    expect(out[0]?.fn?.code).toBe('MEMB');
    expect(out[0]?.params).toEqual({ index: { id: 5 } });
  });

  it("'ECO' — F; the manifest default reaches the run request", () => {
    const out = parse('ECO', env);
    expect(out[0]?.shape).toBe('function');
    expect(out[0]?.params).toEqual({});
    expect(toRunRequest(out[0]!, env)).toEqual({
      code: 'ECO',
      body: { params: { country: 'US' }, panelId: 'p1', launchKind: 'launch' },
    });
  });

  it("'HELP YAS' — help for a registry code", () => {
    const out = parse('HELP YAS', env);
    expect(out).toHaveLength(1);
    expect(out[0]?.shape).toBe('help');
    expect(out[0]?.help).toEqual({ code: 'YAS' });
    expect(toRunRequest(out[0]!, env)).toEqual({
      code: 'HELP',
      body: { params: { code: 'YAS' }, panelId: 'p1', launchKind: 'launch' },
    });
  });

  it("'HELP duration' — help search over manifests and the field dictionary", () => {
    const out = parse('HELP duration', env);
    expect(out[0]?.shape).toBe('help');
    expect(out[0]?.help).toEqual({ query: 'duration' });
    expect(parse('HELP', env)[0]?.help).toEqual({});
  });

  it("'IB' — the alias of MSG", () => {
    const out = parse('IB', env);
    expect(out[0]?.shape).toBe('function');
    expect(out[0]?.fn?.code).toBe('MSG');
    expect(out[0]?.fn?.alias).toBe('IB');
    expect(toRunRequest(out[0]!, env)).toEqual({
      code: 'MSG',
      alias: 'IB',
      body: { params: {}, panelId: 'p1', launchKind: 'launch' },
    });
  });

  it("'ICVS' — the alias of CRVF, carrying aliasParams", () => {
    const out = parse('ICVS', env);
    expect(out[0]?.fn?.code).toBe('CRVF');
    expect(out[0]?.fn?.alias).toBe('ICVS');
    expect(out[0]?.params).toEqual({ curveId: 'SOFR_OIS' });
    expect(toRunRequest(out[0]!, env)).toEqual({
      code: 'CRVF',
      alias: 'ICVS',
      body: { params: { curveId: 'SOFR_OIS' }, panelId: 'p1', launchKind: 'launch' },
    });
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The steps the examples imply (§2.3)                                                              */
/* ---------------------------------------------------------------------------------------------- */

describe('parse — the §2.3 algorithm', () => {
  it('step 1: an empty or blank line is the empty command', () => {
    for (const raw of ['', '   ', '\t\t']) {
      const out = parse(raw, env);
      expect(out).toHaveLength(1);
      expect(out[0]?.shape).toBe('empty');
      expect(out[0]?.problems).toEqual([]);
    }
  });

  it("step 2: '/isin/…' is an identifier, '/layout 4' is a shell word", () => {
    expect(parse('/isin/US0378331005', env)[0]?.shape).toBe('security');
    expect(parse('/layout 4', env)[0]?.shape).toBe('shell');
    expect(parse('/layout 4', env)[0]?.problems).toEqual([]);
  });

  it('step 5: a non-function after an anchored security reports UNKNOWN_FUNCTION and offers the security alone', () => {
    const out = parse('AAPL US Equity ZZZZ', env);
    expect(out).toHaveLength(2);
    expect(out[0]?.shape).toBe('security');
    expect(out[0]?.problems[0]?.code).toBe('UNKNOWN_FUNCTION');
    expect(out[0]?.problems[0]?.span).toEqual([15, 19]);
    expect(out[1]?.shape).toBe('security');
    expect(out[1]?.problems).toEqual([]);
  });

  it('step 6 S+F unknown: an unknown ticker stays unresolved for the server to decide', () => {
    const out = parse('ZZZZ', env);
    expect(out[0]?.shape).toBe('security');
    expect(out[0]?.security?.instrumentId).toBeUndefined();
    expect(out[0]?.security?.ref).toEqual({ kind: 'ticker', value: 'ZZZZ' });
    expect(toRunRequest(out[0]!, env)).toEqual({
      code: 'DES',
      body: { security: { ref: 'ZZZZ' }, params: {}, panelId: 'p1', launchKind: 'launch' },
    });
  });

  it('step 6 S+F unknown: a second token that is not a function adds UNKNOWN_FUNCTION', () => {
    const out = parse('ZZZZ QQQQ', env);
    expect(out[0]?.shape).toBe('security');
    expect(out[0]?.problems[0]?.code).toBe('UNKNOWN_FUNCTION');
    expect(out[0]?.args).toEqual(['QQQQ']);
  });

  it('step 6: an unknown ticker with a known function still launches it', () => {
    const out = parse('ZZZZ DES', env);
    expect(out[0]?.shape).toBe('security+function');
    expect(out[0]?.fn?.code).toBe('DES');
    expect(out[0]?.security?.text).toBe('ZZZZ');
  });

  it('step 8: a malformed argument is a problem, not a refusal to launch', () => {
    const panel = envWith(panelOn(1, 'DES'));
    const out = parse('GP NOPE TYPE=ZIGZAG BOGUS=1', panel);
    expect(out[0]?.shape).toBe('function');
    expect(out[0]?.fn?.code).toBe('GP');
    expect(out[0]?.params).toEqual({});
    expect(out[0]?.problems.map((p) => p.code)).toEqual(['ARG_PARSE', 'ARG_PARSE', 'ARG_PARSE']);
    for (const p of out[0]?.problems ?? []) {
      expect(p.span[0]).toBeGreaterThanOrEqual(0);
      expect(p.span[1]).toBeLessThanOrEqual('GP NOPE TYPE=ZIGZAG BOGUS=1'.length);
    }
    const run = toRunRequest(out[0]!, panel);
    expect(run).toHaveProperty('code', 'GP');
  });

  it('a sector outside the universe wedge parses and reports NOT_IN_UNIVERSE', () => {
    const out = parse('IBM Corp', env);
    expect(out[0]?.shape).toBe('security');
    expect(out[0]?.security?.text).toBe('IBM Corp');
    expect(out[0]?.problems.map((p) => p.code)).toContain('NOT_IN_UNIVERSE');
  });

  it('an ambiguous sector prefix is not a sector anchor', () => {
    // 'C' names four sectors (Curncy, Corp, Comdty, Crypto), so it can only be a ticker token.
    const out = parse('AAPL C', env);
    expect(out[0]?.security?.sectorGiven).toBe(false);
  });

  it('a lookupTicker that throws does not take the command line down', () => {
    const hostile: ParseEnv = {
      registry,
      panel: emptyPanel,
      lookupTicker: () => {
        throw new Error('index not built');
      },
    };
    const out = parse('AAPL GP', hostile);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.shape).toBe('security+function');
  });

  it('TERM-03: a security alone falls back to DES when the panel function does not apply', () => {
    const panel = envWith(panelOn(9, 'YAS')); // panel shows the 10-year note under YAS
    const out = parse('AAPL', panel);
    expect(out[0]?.shape).toBe('security');
    expect(toRunRequest(out[0]!, panel)).toEqual({
      code: 'DES',
      body: { security: { id: 1 }, params: {}, panelId: 'p1', launchKind: 'launch' },
    });
  });

  it('TERM-03: security+function never inherits the panel params', () => {
    const panel = envWith(panelOn(2, 'GP', { range: '5Y', type: 'candle' }));
    const out = parse('AAPL US Equity GP', panel);
    expect(toRunRequest(out[0]!, panel)).toEqual({
      code: 'GP',
      body: { security: { id: 1 }, params: { range: '1Y' }, panelId: 'p1', launchKind: 'launch' },
    });
  });

  it('insertText re-parses to the same reading (the §3.2 row contract)', () => {
    const cases = [
      'aapl equity gp 1y',
      'AAPL',
      'GP 5Y TYPE=CANDLE',
      '<RATIO(AAPL US Equity, SPX Index)> GP',
      '/panel 3',
      'HELP YAS',
      'T 4.25 08/15/36',
      '912797VE4',
      'N tender offer',
    ];
    for (const raw of cases) {
      const first = parse(raw, env)[0];
      expect(first).toBeDefined();
      const text = insertTextFor(first!);
      const again = parse(text, env)[0];
      expect(again?.shape).toBe(first?.shape);
      expect(again?.fn?.code).toBe(first?.fn?.code);
      expect(again?.security?.text).toBe(first?.security?.text);
      expect(again?.params).toEqual(first?.params);
      expect(insertTextFor(again!)).toBe(text);
    }
  });
});
