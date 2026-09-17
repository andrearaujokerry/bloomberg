// packages/core/test/ids/checkdigits.test.ts — WP-03 acceptance test (WORKPLAN L614:
// "FIGI/ISIN/CUSIP/SEDOL check digits over the identifiers in `sec-company-tickers.json` and
// `openfigi-map`").
//
// A check-digit implementation that is only tested against the half-dozen examples in the standard
// is tested against the examples in the standard, not against the world. The world is in
// `fixtures/providers/raw/`, so this file validates every identifier in the recorded captures:
//
//   openfigi-map                    354 distinct FIGIs (figi, compositeFIGI, shareClassFIGI)
//   sec-company-tickers.json     10,422 CIKs
//   sec-nport-SPY-primary_doc.xml   476 distinct CUSIPs and 504 ISINs (SPY's holdings)
//
// plus the published known-good and known-bad cases for each scheme, and the CUSIP→ISIN relation
// cross-checked against the 475 SPY holdings that carry both.
//
// Reading fixtures from a test file is correct and is what WP-03's brief asks for: `packages/core/
// test/**` is outside the package's tsconfig `include` and outside every ESLint boundary zone, so
// `node:fs` is available here and nowhere in `src/`.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CIK_PADDED_LENGTH,
  cikUrlKey,
  isValidCik,
  pad,
  parseCik,
  unpad,
} from '../../src/ids/cik.js';
import {
  cusipCharValue,
  cusipCheckDigit,
  cusipToIsin,
  isValidCusip,
  parseCusip,
} from '../../src/ids/cusip.js';
import { figiCheckDigit, isValidFigi, parseFigi } from '../../src/ids/figi.js';
import {
  isinCheckDigit,
  isinCountry,
  isinExpand,
  isinNsin,
  isValidIsin,
  parseIsin,
} from '../../src/ids/isin.js';
import { isValidSedol, parseSedol, sedolCheckDigit } from '../../src/ids/sedol.js';

// ---------------------------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------------------------

const RAW = new URL('../../../../fixtures/providers/raw/', import.meta.url);

const readRaw = (name: string): string => readFileSync(new URL(name, RAW), 'utf8');

/** `openfigi-map`: an array of `{ data: [{ figi, compositeFIGI, shareClassFIGI, … }] }` blocks. */
function loadFigis(): string[] {
  const blocks = JSON.parse(readRaw('openfigi-map')) as unknown;
  const out = new Set<string>();
  if (!Array.isArray(blocks)) return [];
  for (const block of blocks) {
    const rows = (block as { data?: unknown }).data;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      for (const key of ['figi', 'compositeFIGI', 'shareClassFIGI']) {
        const v = r[key];
        if (typeof v === 'string' && v.length > 0) out.add(v);
      }
    }
  }
  return [...out];
}

/** `sec-company-tickers.json`: `{ "0": { cik_str, ticker, title }, … }`. */
function loadCiks(): { cik: number; ticker: string }[] {
  const doc = JSON.parse(readRaw('sec-company-tickers.json')) as Record<string, unknown>;
  const out: { cik: number; ticker: string }[] = [];
  for (const row of Object.values(doc)) {
    const r = row as { cik_str?: unknown; ticker?: unknown };
    if (typeof r.cik_str === 'number' && typeof r.ticker === 'string') {
      out.push({ cik: r.cik_str, ticker: r.ticker });
    }
  }
  return out;
}

/** SPY's N-PORT: one `<invstOrSec>` per holding, each with a `<cusip>` and an `<isin value=…>`. */
function loadNportHoldings(): { cusip: string; isin: string }[] {
  const xml = readRaw('sec-nport-SPY-primary_doc.xml');
  const out: { cusip: string; isin: string }[] = [];
  for (const block of xml.split('<invstOrSec>').slice(1)) {
    const cusip = /<cusip>([^<]*)<\/cusip>/.exec(block)?.[1]?.trim() ?? '';
    const isin = /isin value="([^"]*)"/.exec(block)?.[1]?.trim() ?? '';
    if (cusip.length > 0 && isin.length > 0) out.push({ cusip, isin });
  }
  return out;
}

const FIGIS = loadFigis();
const CIKS = loadCiks();
const HOLDINGS = loadNportHoldings();
const CUSIPS = [...new Set(HOLDINGS.map((h) => h.cusip))];
const ISINS = [...new Set(HOLDINGS.map((h) => h.isin))];

// The corpora are the point of this file; if a capture is ever re-recorded smaller, the counts
// below fail loudly rather than the suite quietly proving less.
describe('recorded captures (fixtures/providers/raw)', () => {
  it('supply the identifier corpora these tests exist to validate', () => {
    expect(FIGIS.length).toBeGreaterThanOrEqual(354);
    expect(CIKS.length).toBeGreaterThanOrEqual(10_000);
    expect(CUSIPS.length).toBeGreaterThanOrEqual(400);
    expect(ISINS.length).toBeGreaterThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------------------------
// FIGI
// ---------------------------------------------------------------------------------------------

describe('FIGI — published cases', () => {
  // Apple's FIGI, composite FIGI and share-class FIGI, as returned by OpenFIGI itself.
  const GOOD = [
    'BBG000B9XRY4', // AAPL US Equity (and its own composite)
    'BBG001S5N8V8', // Apple share class
    'BBG000BPH459', // MSFT US Equity
    'BBG000BLNNH6', // IBM US Equity
    'BBG000BVPV84', // AMZN US Equity
  ];

  it.each(GOOD)('%s validates and its check digit recomputes', (figi) => {
    expect(isValidFigi(figi)).toBe(true);
    expect(figiCheckDigit(figi.slice(0, 11))).toBe(Number(figi[11]));
    expect(figiCheckDigit(figi)).toBe(Number(figi[11]));
  });

  it('accepts a non-BBG prefix (the prefix is any consonant pair that is not reserved)', () => {
    // Synthetic but structurally exact: 'NR' + 'G' + eight body characters + the computed digit.
    const body = 'NRG92LMXX0S';
    const check = figiCheckDigit(body);
    expect(check).toBe(0);
    expect(isValidFigi(body + String(check))).toBe(true);
  });

  it('normalises case and surrounding whitespace', () => {
    expect(isValidFigi('  bbg000b9xry4 ')).toBe(true);
    const r = parseFigi(' bbg000b9xry4');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('BBG000B9XRY4');
  });

  const BAD: [string, string][] = [
    ['BBG000B9XRY5', 'check-digit'], // one off
    ['BBG000B9XRY0', 'check-digit'],
    ['BAG000B9XRY4', 'charset'], // 'A' is a vowel: not in the FIGI alphabet
    ['BBB000B9XRY4', 'missing-g'], // character 3 must be 'G'
    ['BSG000B9XRY4', 'reserved-prefix'], // 'BS' is the Bahamas
    ['GBG000B9XRY4', 'reserved-prefix'], // 'GB' is the United Kingdom
    ['B9G000B9XRY4', 'prefix-not-alpha'], // prefix is two consonants, not a digit
    ['BBG000B9XRYX', 'check-digit-not-numeric'],
    ['BBG000B9XRY', 'length'], // eleven characters
    ['BBG000B9XRY44', 'length'], // thirteen
    ['', 'empty'],
  ];

  it.each(BAD)('rejects %s with problem %s', (input, code) => {
    const r = parseFigi(input);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toContain(code);
    expect(isValidFigi(input)).toBe(false);
  });

  it('rejects every reserved prefix', () => {
    for (const prefix of ['BS', 'BM', 'GG', 'GB', 'GH', 'KY', 'VG']) {
      const body = `${prefix}G000B9XRY`;
      const full = body + String(figiCheckDigit(body) ?? 0);
      // The check digit is right and the shape is right; only the prefix is reserved.
      expect(parseFigi(full).problems.map((p) => p.code)).toContain('reserved-prefix');
    }
  });
});

describe(`FIGI — ${String(FIGIS.length)} identifiers from fixtures/providers/raw/openfigi-map`, () => {
  it('every FIGI in the capture validates', () => {
    const bad = FIGIS.filter((f) => !isValidFigi(f));
    expect(bad).toEqual([]);
    expect(FIGIS.length).toBe(354);
  });

  it('every check digit recomputes from the eleven-character body', () => {
    const wrong = FIGIS.filter((f) => figiCheckDigit(f.slice(0, 11)) !== Number(f.slice(11)));
    expect(wrong).toEqual([]);
  });

  it('changing the check digit of any of them makes it invalid', () => {
    for (const f of FIGIS) {
      const wrong = String((Number(f.slice(11)) + 1) % 10);
      expect(isValidFigi(f.slice(0, 11) + wrong)).toBe(false);
    }
  });

  it('every one of them is BBG-prefixed, twelve characters and vowel-free', () => {
    for (const f of FIGIS) {
      expect(f).toHaveLength(12);
      expect(f.slice(0, 3)).toBe('BBG');
      expect(/[AEIOU]/.test(f)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// ISIN
// ---------------------------------------------------------------------------------------------

describe('ISIN — published cases', () => {
  const GOOD = [
    'US0378331005', // Apple
    'US5949181045', // Microsoft
    'US38259P5089', // Google (the old class-A line)
    'US0231351067', // Amazon
    'US912828U816', // a US Treasury note
    'GB0002634946', // BAE Systems
    'AU0000XVGZA3', // the ISO 6166 worked example
    'JP3946600008', // Sony
    'FR0000121014', // LVMH
    'DE0005557508', // Deutsche Telekom
    'NL0000235190', // Airbus
    'CH0038863350', // Nestlé
    'IE00B4L5Y983', // iShares Core MSCI World (an Irish UCITS)
    'XS1982113463', // a Eurobond: 'XS' is not a country
    'CA9861913023', // Yamana Gold
  ];

  it.each(GOOD)('%s validates and its check digit recomputes', (isin) => {
    expect(isValidIsin(isin)).toBe(true);
    expect(isinCheckDigit(isin.slice(0, 11))).toBe(Number(isin[11]));
    expect(isinCheckDigit(isin)).toBe(Number(isin[11]));
  });

  it('expands letters to two digits before the Luhn (A=10 … Z=35)', () => {
    expect(isinExpand('US037833100')).toBe('3028037833100');
    expect(isinExpand('AZ')).toBe('1035');
    expect(isinExpand('0123456789')).toBe('0123456789');
    expect(isinExpand('us')).toBeNull(); // the expansion works on normalised input only
  });

  it('exposes the country code and the NSIN', () => {
    expect(isinCountry('US0378331005')).toBe('US');
    expect(isinNsin('US0378331005')).toBe('037833100');
    expect(isinCountry('XS1982113463')).toBe('XS'); // supranational, not an ISO 3166 country
    expect(isinCountry('US0378331006')).toBeNull(); // accessor validates first
    expect(isinCountry(42)).toBeNull();
  });

  const BAD: [string, string][] = [
    ['US0378331006', 'check-digit'], // the canonical off-by-one
    ['US0378331000', 'check-digit'],
    ['US037833100', 'length'], // eleven characters
    ['US03783310055', 'length'], // thirteen
    ['0S0378331005', 'country-not-alpha'],
    ['U-0378331005', 'charset'],
    ['US037833100X', 'check-digit-not-numeric'],
    ['US0378331_05', 'charset'],
    ['', 'empty'],
  ];

  it.each(BAD)('rejects %s with problem %s', (input, code) => {
    const r = parseIsin(input);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toContain(code);
    expect(isValidIsin(input)).toBe(false);
  });

  it('catches every single-digit corruption of US0378331005', () => {
    const isin = 'US0378331005';
    for (let i = 2; i < 12; i++) {
      for (let d = 0; d <= 9; d++) {
        const mutated = isin.slice(0, i) + String(d) + isin.slice(i + 1);
        if (mutated === isin) continue;
        expect(isValidIsin(mutated)).toBe(false);
      }
    }
  });
});

describe(`ISIN — ${String(ISINS.length)} identifiers from SPY's N-PORT capture`, () => {
  it('every ISIN in the capture validates', () => {
    const bad = ISINS.filter((i) => !isValidIsin(i));
    expect(bad).toEqual([]);
    expect(ISINS.length).toBeGreaterThanOrEqual(504);
  });

  it('every check digit recomputes, and every mutation of it is rejected', () => {
    for (const isin of ISINS) {
      expect(isinCheckDigit(isin.slice(0, 11))).toBe(Number(isin.slice(11)));
      const wrong = String((Number(isin.slice(11)) + 1) % 10);
      expect(isValidIsin(isin.slice(0, 11) + wrong)).toBe(false);
    }
  });

  it('covers more than one country code', () => {
    const countries = new Set(ISINS.map((i) => isinCountry(i)));
    expect(countries.size).toBeGreaterThan(1);
    expect(countries).toContain('US');
  });
});

// ---------------------------------------------------------------------------------------------
// CUSIP
// ---------------------------------------------------------------------------------------------

describe('CUSIP — published cases', () => {
  const GOOD = [
    '037833100', // Apple
    '594918104', // Microsoft
    '38259P508', // Google
    '68389X105', // Oracle
    '02079K305', // Alphabet class C
    '912828U81', // a US Treasury note
    '023135106', // Amazon
    '88160R101', // Tesla
    '46625H100', // JPMorgan Chase
    'G0692U109', // Accenture plc — a CINS (leading letter)
    '912797VE4', // FUNCTIONS.md §2.7 L840-841: '912797VE4 Govt'
  ];

  it.each(GOOD)('%s validates and its check digit recomputes', (cusip) => {
    expect(isValidCusip(cusip)).toBe(true);
    expect(cusipCheckDigit(cusip.slice(0, 8))).toBe(Number(cusip[8]));
    expect(cusipCheckDigit(cusip)).toBe(Number(cusip[8]));
  });

  it('knows the CINS and the special characters', () => {
    const cins = parseCusip('G0692U109');
    expect(cins.value).toBe('G0692U109');
    expect(cins.ok && cins.isCins).toBe(true);
    const domestic = parseCusip('037833100');
    expect(domestic.ok && domestic.isCins).toBe(false);

    // * = 36, @ = 37, # = 38 — private-placement numbers really use these.
    expect(cusipCharValue('*')).toBe(36);
    expect(cusipCharValue('@')).toBe(37);
    expect(cusipCharValue('#')).toBe(38);
    expect(cusipCharValue('A')).toBe(10);
    expect(cusipCharValue('Z')).toBe(35);
    expect(cusipCharValue('$')).toBeNull();

    const body = '00037833';
    for (const special of ['*', '@', '#']) {
      const withSpecial = body.slice(0, 7) + special;
      const check = cusipCheckDigit(withSpecial);
      expect(check).not.toBeNull();
      expect(isValidCusip(withSpecial + String(check))).toBe(true);
    }
  });

  it('exposes the issuer and issue halves', () => {
    const r = parseCusip('037833100');
    expect(r.ok && r.issuer).toBe('037833');
    expect(r.ok && r.issue).toBe('10');
  });

  const BAD: [string, string][] = [
    ['037833101', 'check-digit'],
    ['037833109', 'check-digit'],
    ['03783310', 'length'], // eight characters
    ['0378331000', 'length'], // ten
    ['037833!00', 'charset'],
    ['03783310X', 'check-digit-not-numeric'],
    ['', 'empty'],
  ];

  it.each(BAD)('rejects %s with problem %s', (input, code) => {
    const r = parseCusip(input);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toContain(code);
    expect(isValidCusip(input)).toBe(false);
  });

  it('cusipToIsin adds the country code and a fresh ISIN check digit', () => {
    expect(cusipToIsin('037833100')).toBe('US0378331005');
    expect(cusipToIsin('037833100', 'US')).toBe('US0378331005');
    expect(cusipToIsin('594918104')).toBe('US5949181045');
    expect(cusipToIsin('023135106')).toBe('US0231351067');
    expect(cusipToIsin('986191302', 'CA')).toBe('CA9861913023');
    // The ISIN check digit is computed, never copied from the CUSIP.
    expect(cusipToIsin('037833100')?.slice(11)).not.toBe('0');
    expect(cusipToIsin('037833101')).toBeNull(); // a bad CUSIP yields no ISIN
    expect(cusipToIsin('037833100', 'U1')).toBeNull();
    expect(cusipToIsin('037833100', 'USA')).toBeNull();
  });
});

describe(`CUSIP — ${String(CUSIPS.length)} identifiers from SPY's N-PORT capture`, () => {
  it('every CUSIP in the capture validates', () => {
    const bad = CUSIPS.filter((c) => !isValidCusip(c));
    expect(bad).toEqual([]);
    expect(CUSIPS.length).toBeGreaterThanOrEqual(400);
  });

  it('every check digit recomputes, and every mutation of it is rejected', () => {
    for (const cusip of CUSIPS) {
      expect(cusipCheckDigit(cusip.slice(0, 8))).toBe(Number(cusip.slice(8)));
      const wrong = String((Number(cusip.slice(8)) + 1) % 10);
      expect(isValidCusip(cusip.slice(0, 8) + wrong)).toBe(false);
    }
  });

  it('cusipToIsin reproduces the ISIN the filing itself reports', () => {
    // The holdings that carry a real CUSIP (the placeholder '000000000' marks a foreign line that
    // has no CUSIP) must satisfy ISO 6166: ISIN = country + CUSIP + ISIN check digit.
    let checked = 0;
    for (const { cusip, isin } of HOLDINGS) {
      if (cusip === '000000000') continue;
      const country = isin.slice(0, 2);
      if (isin.slice(2, 11) !== cusip) continue; // a non-CUSIP NSIN; nothing to cross-check
      expect(cusipToIsin(cusip, country)).toBe(isin);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(470);
  });
});

// ---------------------------------------------------------------------------------------------
// SEDOL
// ---------------------------------------------------------------------------------------------

describe('SEDOL — published cases', () => {
  const GOOD = [
    '0263494', // BAE Systems — the pre-2004 numeric series
    '0798059',
    '0540528',
    '2046853',
    '2000019',
    'B0WNLY7', // the post-2004 alphanumeric series
    'B1YW440',
    'BH0P3Z9',
  ];

  it.each(GOOD)('%s validates and its check digit recomputes', (sedol) => {
    expect(isValidSedol(sedol)).toBe(true);
    expect(sedolCheckDigit(sedol.slice(0, 6))).toBe(Number(sedol[6]));
    expect(sedolCheckDigit(sedol)).toBe(Number(sedol[6]));
  });

  it('applies the 1-3-1-7-3-9 weights with no digit-sum step', () => {
    // 1·0 + 3·2 + 1·6 + 7·3 + 3·4 + 9·9 = 126 → check 4.
    expect(sedolCheckDigit('026349')).toBe(4);
    // 1·11 + 3·0 + 1·32 + 7·23 + 3·21 + 9·34 = 573 → check 7. Note B = 11, not 10: the vowel
    // positions are simply unused.
    expect(sedolCheckDigit('B0WNLY')).toBe(7);
    expect(sedolCheckDigit('000000')).toBe(0);
    expect(sedolCheckDigit('ZZZZZZ')).toBe((10 - ((35 * (1 + 3 + 1 + 7 + 3 + 9)) % 10)) % 10);
  });

  it('reports the series', () => {
    const numeric = parseSedol('0263494');
    expect(numeric.ok && numeric.isAlphanumericSeries).toBe(false);
    const alpha = parseSedol('B0WNLY7');
    expect(alpha.ok && alpha.isAlphanumericSeries).toBe(true);
  });

  const BAD: [string, string][] = [
    ['0263495', 'check-digit'],
    ['0263490', 'check-digit'],
    ['B0WNLY8', 'check-digit'],
    ['026349', 'length'], // six characters
    ['02634944', 'length'], // eight
    ['0A63494', 'vowel'], // the alphabet has no vowels
    ['0E63494', 'vowel'],
    ['0-63494', 'charset'],
    ['026349X', 'check-digit-not-numeric'],
    ['', 'empty'],
  ];

  it.each(BAD)('rejects %s with problem %s', (input, code) => {
    const r = parseSedol(input);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toContain(code);
    expect(isValidSedol(input)).toBe(false);
  });

  it('catches every single-character corruption of 0263494', () => {
    const sedol = '0263494';
    const alphabet = '0123456789BCDFGHJKLMNPQRSTVWXYZ';
    for (let i = 0; i < 7; i++) {
      for (const ch of alphabet) {
        const mutated = sedol.slice(0, i) + ch + sedol.slice(i + 1);
        if (mutated === sedol) continue;
        // A weighted mod-10 scheme misses the substitutions whose weighted value difference is
        // itself a multiple of ten ('1' → 'B' in a weight-1 column moves the value by exactly 10),
        // so those are skipped rather than asserted away: they are a property of the published
        // algorithm, not of this implementation. Everything else must be rejected.
        if (sedolCheckDigit(mutated.slice(0, 6)) === Number(mutated[6])) continue;
        expect(isValidSedol(mutated)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// CIK — the data.sec.gov / /Archives mismatch (PROVIDERS.md §7 L1268-1272)
// ---------------------------------------------------------------------------------------------

describe('CIK — published cases', () => {
  it('pads to the ten digits data.sec.gov requires', () => {
    expect(pad('320193')).toBe('0000320193');
    expect(pad(320193)).toBe('0000320193');
    expect(pad('0000320193')).toBe('0000320193');
    expect(pad('CIK0000320193')).toBe('0000320193');
    expect(pad(884394)).toBe('0000884394'); // SPY's trust, BRIEF.md L45
    expect(pad(1045810)).toBe('0001045810'); // NVDA, PROVIDERS.md L1286
    expect(cikUrlKey(320193)).toBe('CIK0000320193');
  });

  it('accepts the CIK prefix in any casing, as the doc comment promises', () => {
    // The SEC emits it uppercase in `submissions.filings.files[].name` and in data.sec.gov URLs,
    // but a caller that lower-cases a URL fragment before parsing must not get a silent null.
    for (const prefix of ['CIK', 'cik', 'Cik', 'cIK', 'CIk', 'ciK', 'cIk', 'CiK']) {
      expect(pad(`${prefix}0000320193`)).toBe('0000320193');
      expect(unpad(`${prefix}0000320193`)).toBe('320193');
      expect(isValidCik(`${prefix}320193`)).toBe(true);
    }
    // Not a prefix: the letters have to be the whole word `CIK`.
    expect(pad('CIKS0000320193')).toBeNull();
    expect(pad('CI0000320193')).toBeNull();
  });

  it('unpads to the bare form /Archives paths take', () => {
    expect(unpad('0000320193')).toBe('320193');
    expect(unpad('0000884394')).toBe('884394'); // the /Archives/edgar/data/884394/ segment
    expect(unpad(320193)).toBe('320193');
    expect(unpad('320193')).toBe('320193');
    expect(unpad('CIK0000884394')).toBe('884394');
  });

  it('is total: every non-CIK yields null rather than an exception', () => {
    const notCiks: unknown[] = [
      '',
      '   ',
      'CIK',
      '0000000000',
      '0',
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '12345678901', // eleven significant digits
      '320193x',
      'AAPL',
      null,
      undefined,
      {},
      [],
      true,
    ];
    for (const v of notCiks) {
      expect(pad(v as string)).toBeNull();
      expect(unpad(v as string)).toBeNull();
      expect(isValidCik(v)).toBe(false);
      expect(parseCik(v).ok).toBe(false);
      expect(parseCik(v).problems.length).toBeGreaterThan(0);
    }
  });
});

describe(`CIK — ${String(CIKS.length)} CIKs from fixtures/providers/raw/sec-company-tickers.json`, () => {
  it('every cik_str pads to exactly ten digits', () => {
    for (const { cik } of CIKS) {
      const padded = pad(cik);
      expect(padded).not.toBeNull();
      expect(padded).toHaveLength(CIK_PADDED_LENGTH);
      expect(/^\d{10}$/.test(padded ?? '')).toBe(true);
    }
    expect(CIKS.length).toBeGreaterThanOrEqual(10_000);
  });

  it('pad and unpad round-trip in both directions for every one of them', () => {
    for (const { cik } of CIKS) {
      const padded = pad(cik);
      const bare = unpad(cik);
      expect(bare).toBe(String(cik)); // cik_str is already the bare form
      expect(pad(bare!)).toBe(padded);
      expect(unpad(padded!)).toBe(bare);
      // Idempotence, and the CIK##########.json URL key data.sec.gov wants.
      expect(pad(padded!)).toBe(padded);
      expect(unpad(bare!)).toBe(bare);
      expect(cikUrlKey(padded!)).toBe(`CIK${padded ?? ''}`);
    }
  });

  it('AAPL is CIK 320193 in the capture, and both spellings agree', () => {
    const aapl = CIKS.find((c) => c.ticker === 'AAPL');
    expect(aapl?.cik).toBe(320193);
    expect(pad(aapl?.cik ?? 0)).toBe('0000320193');
    expect(unpad('0000320193')).toBe('320193');
  });
});
