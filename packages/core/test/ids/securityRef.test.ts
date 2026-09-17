// packages/core/test/ids/securityRef.test.ts — WP-03 (WORKPLAN L614).
//
// The binding acceptance row is "each of the eight ref forms parses and re-formats identically"
// (WORKPLAN L614, ARCHITECTURE L140-142). That is the first block below: a table of the canonical
// spellings, each asserted component by component and then required to satisfy
//
//     formatSecurityRef(parseSecurityRef(s).ref) === s
//
// byte for byte. A ninth row, `/series/fred.csv/DGS10`, is carried too — the grammar lists it
// (FUNCTIONS.md L628) and `SecurityRefKind` has a `'series'` member for it.
//
// The one deliberate asymmetry: a *bare* identifier (`912797VE4`, `BBG000B9XRY4`) is not its own
// canonical form. Its canonical form is the scheme form, `/cusip/912797VE4`, so the round-trip is
// stated as "the canonical spelling is a fixed point" — `parse(canonical).canonical === canonical`.
//
// Two recorded captures supply the corpora, which is what WP-03's tests are meant to read
// (fixtures/providers/raw, WORKPLAN L613): `openfigi-map` gives real (ticker, exchCode,
// marketSector, figi) quadruples, and `sec-company-tickers.json` gives 10 422 live US tickers,
// including the 544 with a share-class separator (`BRK-B`) that §2.2 item 4 says must canonicalise
// to the master's `BRK/B`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveSector } from '../../src/command/sectors.js';
import { parseFigi } from '../../src/ids/figi.js';
import { parseIsin } from '../../src/ids/isin.js';
import {
  canonicaliseTicker,
  formatSecurityRef,
  isIdentifierToken,
  isSecurityRefScheme,
  parseSecurityRef,
  parseSecurityRefOrNull,
  SECURITY_REF_SCHEMES,
} from '../../src/ids/securityRef.js';
import type { SecurityRefParseOk } from '../../src/ids/securityRef.js';

/* -------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                       */
/* -------------------------------------------------------------------------------------------- */

const RAW = fileURLToPath(new URL('../../../../fixtures/providers/raw/', import.meta.url));

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(RAW + name, 'utf8'));
}

interface FigiRow {
  figi: string;
  ticker: string;
  exchCode: string;
  marketSector: string;
  name: string;
}

/** Every distinct OpenFIGI mapping row in the recorded capture. */
const figiRows: FigiRow[] = (() => {
  const doc = readJson('openfigi-map') as { data?: FigiRow[] }[];
  const seen = new Set<string>();
  const out: FigiRow[] = [];
  for (const block of doc)
    for (const row of block.data ?? []) {
      if (typeof row.figi !== 'string' || typeof row.ticker !== 'string') continue;
      if (seen.has(row.figi)) continue;
      seen.add(row.figi);
      out.push(row);
    }
  return out;
})();

/** `{ "0": { cik_str, ticker, title }, … }` — the SEC's ticker file. */
const secTickers: { ticker: string; title: string }[] = Object.values(
  readJson('sec-company-tickers.json') as Record<string, { ticker: string; title: string }>,
);

/** Narrow a parse that must have succeeded, with the failure's problems in the message. */
function ok(input: string): SecurityRefParseOk {
  const parsed = parseSecurityRef(input);
  if (!parsed.ok) {
    throw new Error(
      `expected ${JSON.stringify(input)} to parse, got ${parsed.problems
        .map((p) => `${p.code}: ${p.message}`)
        .join('; ')}`,
    );
  }
  return parsed;
}

/* -------------------------------------------------------------------------------------------- */
/* The eight canonical forms                                                                      */
/* -------------------------------------------------------------------------------------------- */

describe('the canonical reference forms (ARCHITECTURE L140-142)', () => {
  it('1. `AAPL US Equity` — ticker, composite exchange, sector', () => {
    const r = ok('AAPL US Equity');
    expect(r.form).toBe('ticker');
    expect(r.ref).toEqual({ kind: 'ticker', value: 'AAPL', exchCode: 'US', sector: 'Equity' });
    expect(r.sectorGiven).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('2. `SPX Index` — ticker and sector, no exchange', () => {
    const r = ok('SPX Index');
    expect(r.form).toBe('ticker');
    expect(r.ref).toEqual({ kind: 'ticker', value: 'SPX', sector: 'Index' });
    expect(r.ref.exchCode).toBeUndefined();
  });

  it('3. `EURUSD Curncy` — a currency pair', () => {
    const r = ok('EURUSD Curncy');
    expect(r.ref).toEqual({ kind: 'ticker', value: 'EURUSD', sector: 'Curncy' });
  });

  it('4. `912797VE4 Govt` — a CUSIP used as the ticker of a bill', () => {
    const r = ok('912797VE4 Govt');
    expect(r.form).toBe('ticker');
    expect(r.ref).toEqual({ kind: 'ticker', value: '912797VE4', sector: 'Govt' });
    // The token is a valid CUSIP, so no BAD_IDENTIFIER is raised against it.
    expect(r.problems).toEqual([]);
  });

  it('5. `T 4.25 08/15/36 Govt` — a Treasury by coupon and maturity', () => {
    const r = ok('T 4.25 08/15/36 Govt');
    expect(r.form).toBe('bond');
    expect(r.ref).toEqual({ kind: 'ticker', value: 'T 4.25 08/15/36', sector: 'Govt' });
    expect(r.bond).toEqual({ ticker: 'T', coupon: 4.25, maturity: '2036-08-15' });
    expect(r.option).toBeUndefined();
  });

  it('6. `AAPL 9/16/26 C245 Equity` — a listed option', () => {
    const r = ok('AAPL 9/16/26 C245 Equity');
    expect(r.form).toBe('option');
    expect(r.ref).toEqual({ kind: 'ticker', value: 'AAPL 9/16/26 C245', sector: 'Equity' });
    expect(r.option).toEqual({ root: 'AAPL', expiry: '2026-09-16', right: 'C', strike: 245 });
    expect(r.bond).toBeUndefined();
  });

  it('7. `/isin/US0378331005`', () => {
    const r = ok('/isin/US0378331005');
    expect(r.form).toBe('scheme');
    expect(r.scheme).toBe('isin');
    expect(r.ref).toEqual({ kind: 'isin', value: 'US0378331005' });
  });

  it('8. `/figi/BBG000B9XRY4`', () => {
    const r = ok('/figi/BBG000B9XRY4');
    expect(r.ref).toEqual({ kind: 'figi', value: 'BBG000B9XRY4' });
  });

  it('9. `/cusip/037833100` and `/occ/…` and `/series/…`', () => {
    expect(ok('/cusip/037833100').ref).toEqual({ kind: 'cusip', value: '037833100' });
    expect(ok('/occ/AAPL260916C00245000').ref).toEqual({
      kind: 'occ',
      value: 'AAPL260916C00245000',
    });
    expect(ok('/series/fred.csv/DGS10').ref).toEqual({ kind: 'series', value: 'fred.csv/DGS10' });
  });

  const canonical = [
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
    // the sector-less and exchange-less spellings of §2.7
    'AAPL',
    'AAPL US',
    'SPX',
    'EURUSD',
    'SOFR',
    'T 4.25 08/15/36',
    'W US Equity',
    'CF US Equity',
    'BTC Crypto',
    'SOFR M-Mkt',
    'BRK/B US Equity',
  ] as const;

  it.each(canonical)('format(parse(%j)) is identical', (input) => {
    const r = ok(input);
    expect(formatSecurityRef(r.ref)).toBe(input);
    expect(r.canonical).toBe(input);
  });

  it.each(canonical)('re-parsing the canonical form of %j is a fixed point', (input) => {
    const once = ok(input);
    const twice = ok(once.canonical);
    expect(twice.canonical).toBe(once.canonical);
    expect(twice.ref).toEqual(once.ref);
    expect(twice.form).toBe(once.form);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Case, aliases and normalisation                                                                */
/* -------------------------------------------------------------------------------------------- */

describe('input tolerance', () => {
  it('is case-insensitive and canonicalises to upper case (§2.2 item 5)', () => {
    expect(ok('aapl us equity').canonical).toBe('AAPL US Equity');
    expect(ok('  spx   index  ').canonical).toBe('SPX Index');
  });

  it('accepts a sector alias and a unique >= 3-character prefix (§2.1 L627)', () => {
    expect(ok('AAPL Eqty').canonical).toBe('AAPL Equity');
    expect(ok('AAPL Equ').canonical).toBe('AAPL Equity');
    expect(ok('EURUSD Ccy').canonical).toBe('EURUSD Curncy');
    expect(ok('EURUSD Currency').canonical).toBe('EURUSD Curncy');
    expect(ok('SOFR MMKT').canonical).toBe('SOFR M-Mkt');
    expect(ok('CL Cmdty').ref.sector).toBe('Comdty');
  });

  it('canonicalises `BRK.B`, `BRK-B` and `BRK/B` to the master spelling (§2.2 item 4)', () => {
    for (const typed of ['BRK.B', 'BRK-B', 'BRK/B']) {
      expect(ok(`${typed} US Equity`).ref.value).toBe('BRK/B');
    }
    expect(canonicaliseTicker('BF-B')).toBe('BF/B');
    // Only a single trailing class letter is a share class; a preferred line is left alone.
    expect(canonicaliseTicker('ICR-PA')).toBe('ICR-PA');
    expect(canonicaliseTicker('EURUSD')).toBe('EURUSD');
  });

  it('accepts the mixed-fraction coupon and normalises it to a decimal', () => {
    const r = ok('T 4 1/4 08/15/36 Govt');
    expect(r.form).toBe('bond');
    expect(r.bond).toEqual({ ticker: 'T', coupon: 4.25, maturity: '2036-08-15' });
    expect(r.canonical).toBe('T 4.25 08/15/36 Govt');
  });

  it('pivots a two-digit year at 70', () => {
    expect(ok('T 6 02/15/26 Govt').bond?.maturity).toBe('2026-02-15');
    expect(ok('T 6 02/15/98 Govt').bond?.maturity).toBe('1998-02-15');
  });

  it('keeps a fractional option strike', () => {
    const r = ok('SPY 1/16/26 P2.5 Equity');
    expect(r.option).toEqual({ root: 'SPY', expiry: '2026-01-16', right: 'P', strike: 2.5 });
    expect(r.canonical).toBe('SPY 1/16/26 P2.5 Equity');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Bare identifiers                                                                               */
/* -------------------------------------------------------------------------------------------- */

describe('bare identifiers (FUNCTIONS.md L628-630, §2.7)', () => {
  it.each([
    ['912797VE4', 'cusip', '/cusip/912797VE4'],
    ['BBG000B9XRY4', 'figi', '/figi/BBG000B9XRY4'],
    ['US0378331005', 'isin', '/isin/US0378331005'],
    ['AAPL260916C00245000', 'occ', '/occ/AAPL260916C00245000'],
  ])('%s is recognised by shape and check digit as a %s', (input, kind, canonical) => {
    const r = ok(input);
    expect(r.form).toBe('bare');
    expect(r.ref.kind).toBe(kind);
    expect(r.canonical).toBe(canonical);
    // The canonical (scheme) form is the fixed point, not the bare spelling.
    expect(ok(canonical).canonical).toBe(canonical);
    expect(formatSecurityRef(r.ref)).toBe(canonical);
  });

  it('is case-insensitive about a bare identifier', () => {
    expect(ok('bbg000b9xry4').ref).toEqual({ kind: 'figi', value: 'BBG000B9XRY4' });
  });

  it('falls through to a ticker when the shape matches but the check digit does not (L761)', () => {
    const r = ok('912797VE5');
    expect(r.form).toBe('ticker');
    expect(r.ref).toEqual({ kind: 'ticker', value: '912797VE5' });
    expect(r.problems.map((p) => p.code)).toEqual(['BAD_IDENTIFIER']);
    expect(r.problems[0]?.span).toEqual([0, 9]);
  });

  it('does not read a four-letter ticker as an identifier', () => {
    expect(ok('AAPL').ref).toEqual({ kind: 'ticker', value: 'AAPL' });
    expect(ok('AAPL').problems).toEqual([]);
  });

  it('reports AMBIGUOUS_IDENTIFIER when one token is valid under two schemes', () => {
    // A FIGI's check digit is a digit, and a FIGI body is all `[A-Z0-9]` with two leading letters,
    // so a FIGI can also satisfy the ISIN Luhn. This one does; FIGI wins because its shape is the
    // more constrained of the two.
    const both = 'BBG00BB0S001';
    expect(parseFigi(both).ok).toBe(true);
    expect(parseIsin(both).ok).toBe(true);

    const r = ok(both);
    expect(r.ref).toEqual({ kind: 'figi', value: both });
    expect(r.problems.map((p) => p.code)).toEqual(['AMBIGUOUS_IDENTIFIER']);
    expect(r.problems[0]?.message).toContain('ISIN');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Problems                                                                                       */
/* -------------------------------------------------------------------------------------------- */

describe('malformed and ambiguous input yields problems, never an exception', () => {
  const failures: [string, unknown, string][] = [
    ['a non-string', 42, 'NOT_A_STRING'],
    ['null', null, 'NOT_A_STRING'],
    ['undefined', undefined, 'NOT_A_STRING'],
    ['the empty string', '', 'EMPTY'],
    ['whitespace only', ' \t\n ', 'EMPTY'],
    ['an unknown scheme', '/panel/3', 'UNKNOWN_SCHEME'],
    ['a scheme with no value', '/isin/', 'BAD_IDENTIFIER'],
    ['a scheme word with no second slash — a shell word', '/isin', 'UNKNOWN_SCHEME'],
    ['a SEDOL, which has no SecurityRefKind', '/sedol/2046251', 'UNSUPPORTED_SCHEME'],
    ['a bad ISIN check digit', '/isin/US0378331006', 'BAD_IDENTIFIER'],
    ['a bad CUSIP check digit', '/cusip/037833101', 'BAD_IDENTIFIER'],
    ['a bad FIGI check digit', '/figi/BBG000B9XRY5', 'BAD_IDENTIFIER'],
    ['a malformed OCC symbol', '/occ/AAPL260916X00245000', 'BAD_IDENTIFIER'],
    ['text after an identifier', '/isin/US0378331005 DES', 'TRAILING_TEXT'],
    ['too many tokens', 'A B C D E F G H', 'TOO_MANY_TOKENS'],
    ['an impossible maturity', 'T 4.25 02/30/36 Govt', 'BAD_MATURITY'],
    ['a month that does not exist', 'T 4.25 13/01/36 Govt', 'BAD_MATURITY'],
    ['an option leg with no strike', 'AAPL 9/16/26 C Equity', 'BAD_OPTION'],
    ['an impossible expiry', 'AAPL 2/30/26 C245 Equity', 'BAD_MATURITY'],
    ['a ticker with characters no ticker has', 'AA<PL US Equity', 'BAD_TICKER'],
    ['a ticker that is only punctuation', '=== Equity', 'BAD_TICKER'],
    ['a reference longer than the cap', `${'A'.repeat(300)} Equity`, 'TOO_LONG'],
  ];

  it.each(failures)('rejects %s with %s', (_label, input, code) => {
    const r = parseSecurityRef(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.code)).toContain(code);
    expect(r.problems.length).toBeGreaterThan(0);
    for (const p of r.problems) {
      expect(p.message.length).toBeGreaterThan(0);
      expect(p.span[0]).toBeLessThanOrEqual(p.span[1]);
      expect(p.span[0]).toBeGreaterThanOrEqual(0);
      if (typeof input === 'string') expect(p.span[1]).toBeLessThanOrEqual(input.length);
    }
    expect(parseSecurityRefOrNull(input)).toBeNull();
  });

  it('parses a sector outside the universe and flags it NOT_IN_UNIVERSE (L647)', () => {
    for (const sector of ['Corp', 'Comdty', 'Mtge', 'Muni', 'Pfd']) {
      const r = ok(`XYZ ${sector}`);
      expect(r.ref.sector).toBe(sector);
      expect(r.canonical).toBe(`XYZ ${sector}`);
      expect(r.problems.map((p) => p.code)).toEqual(['NOT_IN_UNIVERSE']);
    }
  });

  it('flags an ambiguous sector prefix rather than guessing', () => {
    // `C` is the start of Curncy, Corp, Comdty and Crypto, so it is not a sector — and `C` is also
    // Citigroup's ticker, which is why the token is left in the ticker rather than consumed.
    const lookup = resolveSector('C');
    expect(lookup.ok).toBe(false);
    if (!lookup.ok) {
      expect(lookup.reason).toBe('ambiguous');
      expect(lookup.candidates).toEqual(['Curncy', 'Corp', 'Comdty', 'Crypto']);
    }

    const r = ok('AAPL C');
    expect(r.ref).toEqual({ kind: 'ticker', value: 'AAPL C' });
    expect(r.problems.map((p) => p.code)).toEqual(['UNKNOWN_SECTOR']);
    expect(ok('C').ref).toEqual({ kind: 'ticker', value: 'C' });
  });

  it('never throws on hostile input', () => {
    const hostile = [
      '<>',
      '///',
      '/',
      '//isin//US0378331005',
      ' ',
      '💥 Equity',
      'AAPL\tUS\tEquity',
      '-'.repeat(50),
      'T 4.25 08/15/36 Govt Equity Index',
      'NaN Infinity Equity',
      '0/0/0 0/0/0 0/0/0',
    ];
    for (const input of hostile) {
      expect(() => parseSecurityRef(input)).not.toThrow();
      const r = parseSecurityRef(input);
      expect(typeof r.ok).toBe('boolean');
    }
    expect(formatSecurityRef(null)).toBe('');
    expect(formatSecurityRef(undefined)).toBe('');
  });

  it('knows which `/word/` tokens are identifiers and which are shell words (§2.3 step 2)', () => {
    for (const scheme of SECURITY_REF_SCHEMES) {
      expect(isSecurityRefScheme(scheme)).toBe(true);
      expect(isSecurityRefScheme(scheme.toUpperCase())).toBe(true);
      expect(isIdentifierToken(`/${scheme}/x`)).toBe(true);
      // the trailing slash is what the spec's regex requires
      expect(isIdentifierToken(`/${scheme}`)).toBe(false);
    }
    for (const shell of ['/panel', '/panel 3', '/layout', '/quit', '/', '', 'isin']) {
      expect(isIdentifierToken(shell)).toBe(false);
    }
    expect(isSecurityRefScheme(7)).toBe(false);
    expect(isIdentifierToken(7)).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Corpora                                                                                        */
/* -------------------------------------------------------------------------------------------- */

describe('recorded corpora', () => {
  it('has loaded both captures', () => {
    expect(figiRows.length).toBeGreaterThan(10);
    expect(secTickers.length).toBeGreaterThan(10_000);
  });

  it('round-trips every `ticker exchCode marketSector` triple in `openfigi-map`', () => {
    for (const row of figiRows) {
      const sector = resolveSector(row.marketSector);
      if (!sector.ok) continue; // a sector this system does not model
      const text = `${canonicaliseTicker(row.ticker.toUpperCase())} ${row.exchCode} ${sector.sector}`;
      const r = ok(text);
      expect(r.ref.kind).toBe('ticker');
      expect(r.ref.sector).toBe(sector.sector);
      expect(formatSecurityRef(r.ref)).toBe(text);
    }
  });

  it('round-trips every FIGI in `openfigi-map` in its scheme form', () => {
    for (const row of figiRows) {
      const text = `/figi/${row.figi}`;
      const r = ok(text);
      expect(r.ref).toEqual({ kind: 'figi', value: row.figi });
      expect(formatSecurityRef(r.ref)).toBe(text);
      // and bare, recognised by its check digit
      const bare = ok(row.figi);
      expect(bare.form).toBe('bare');
      expect(bare.ref).toEqual({ kind: 'figi', value: row.figi });
    }
  });

  it('canonicalises all 10 422 SEC tickers to a fixed point', () => {
    let shareClasses = 0;
    for (const { ticker } of secTickers) {
      const r = ok(`${ticker} US Equity`);
      expect(r.ref.exchCode).toBe('US');
      expect(r.ref.sector).toBe('Equity');
      expect(r.canonical).toBe(`${r.ref.value} US Equity`);
      // idempotent: the canonical spelling re-parses to itself
      expect(ok(r.canonical).canonical).toBe(r.canonical);
      if (r.ref.value !== ticker.toUpperCase()) {
        shareClasses += 1;
        expect(r.ref.value).toBe(ticker.toUpperCase().replace('-', '/'));
      }
    }
    // `BRK-B`, `BF-B`, `MOG-A`, … — the share-class lines of §2.2 item 4. Only a *single* trailing
    // class letter converts, so the `XYZ-PA` preferred lines in the same file are left alone.
    expect(shareClasses).toBeGreaterThan(20);
    expect(ok('BRK-B US Equity').ref.value).toBe('BRK/B');
    expect(ok('BF-B US Equity').ref.value).toBe('BF/B');
    expect(ok('MOG-A US Equity').ref.value).toBe('MOG/A');
    expect(ok('ICR-PA US Equity').ref.value).toBe('ICR-PA');
  });

  it('never throws on a SEC ticker in any of the eleven sectors', () => {
    const sectors = [
      'Equity',
      'Index',
      'Curncy',
      'Govt',
      'Corp',
      'Comdty',
      'Mtge',
      'Muni',
      'Pfd',
      'M-Mkt',
      'Crypto',
    ];
    for (const { ticker } of secTickers.slice(0, 500)) {
      for (const sector of sectors) {
        expect(() => parseSecurityRef(`${ticker} ${sector}`)).not.toThrow();
      }
    }
  });
});
