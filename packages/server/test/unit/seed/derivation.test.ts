/**
 * The pure halves of seed modules 6-9 (DATA_MODEL §18 rows 6-9): the curated-file reader, the
 * `SOFR_OIS` proxy derivation of FUNCTIONS_TIER3 §CRVF L288, and the two projections `seed/bars.ts`
 * makes over a capture.
 *
 * These are the functions whose *inputs* are the interesting part, so they are tested here where a
 * degenerate case is one object literal rather than a database state: a curated file with a maturity
 * before its dated date, a SOFRAI release from the wrong week, an absent par tenor, a quarterly
 * capture that carries dividends the seed must not take. Each of them is a case this seed would
 * otherwise write a plausible wrong number for.
 */

import { describe, expect, it } from 'vitest';

import { parseCusip } from '@terminal/core/ids/cusip';

import {
  MAX_SOFRAI_LAG_DAYS,
  SOFR_OIS_PROXIES,
  TREASURY_OIS_BASIS_BP,
  deriveSofrOisPoints,
  investmentYieldToAct360,
} from '../../../src/seed/curves.js';
import { RATE_SEED, noteTerms, parseTreasurySeed, publishedRateCodes } from '../../../src/seed/rates.js';
import { eodFieldsJson, filterActions, sessionDateOf } from '../../../src/seed/bars.js';

import type { RawRecord } from '../../../src/providers/types.js';
import type { TreasurySeedSecurity } from '../../../src/seed/rates.js';
import type { YahooChartRows } from '../../../src/providers/yahoo/adapter.js';

const CURVE_DATE = '2026-09-14';
/** The capture instant of `nyfed-all`; every derived vintage is one of these, never a wall clock. */
const CAPTURED_AT = Date.parse('2026-09-15T18:44:51Z');

function security(overrides: Partial<TreasurySeedSecurity> = {}): TreasurySeedSecurity {
  return {
    termLabel: '10Y',
    securityType: 'note',
    cusip: '91282CLN9',
    ticker: 'T 4.25 08/15/36',
    name: 'US Treasury Note 4.25% 15-Aug-2036',
    couponRate: 4.25,
    datedDate: '2026-08-15',
    issueDate: '2026-08-17',
    firstCouponDate: '2027-02-15',
    maturityDate: '2036-08-15',
    amountOutstanding: 42_000_000_000,
    ...overrides,
  };
}

function file(securities: unknown[]): unknown {
  return { asOf: CURVE_DATE, securities };
}

describe('parseTreasurySeed checks the one input no parser has already checked', () => {
  it('accepts the committed fixture and keeps every field', () => {
    const parsed = parseTreasurySeed(file([security()]));
    expect(parsed.asOf).toBe(CURVE_DATE);
    expect(parsed.securities).toHaveLength(1);
    expect(parsed.securities[0]).toEqual(security());
  });

  it('rejects a maturity that is not after the dated date', () => {
    expect(() =>
      parseTreasurySeed(file([security({ datedDate: '2036-08-15', maturityDate: '2036-08-15' })])),
    ).toThrow(/maturityDate must be after datedDate/);
  });

  it('rejects a first coupon on or before the dated date', () => {
    expect(() =>
      parseTreasurySeed(file([security({ firstCouponDate: '2026-08-15' })])),
    ).toThrow(/firstCouponDate must be after datedDate/);
  });

  it('rejects a non-ISO date, a zero coupon size and a security type it cannot write', () => {
    expect(() => parseTreasurySeed(file([security({ maturityDate: '15/08/2036' })]))).toThrow(
      /expected an ISO date/,
    );
    expect(() => parseTreasurySeed(file([security({ amountOutstanding: 0 })]))).toThrow(
      /expected a positive finite number/,
    );
    expect(() =>
      parseTreasurySeed(file([{ ...security(), securityType: 'tips' }])),
    ).toThrow(/expected 'note' or 'bond'/);
  });

  it('rejects an empty file: seven curated securities or a loud failure, never a silent zero', () => {
    expect(() => parseTreasurySeed(file([]))).toThrow(/non-empty array/);
    expect(() => parseTreasurySeed({ securities: [security()] })).toThrow(/`asOf` must be/);
  });
});

describe('the curated securities carry identifiers the master will accept', () => {
  it('every CUSIP in the shipped fixture passes the mod-10 check digit (REF-02)', async () => {
    // The check `refdata/identifiers.ts` makes on every `CUSIP` write. FUNCTIONS_TIER3 L13 prints
    // '91282CLM6', '91282CLV6' and '91282CLW4', whose check digits are 1, 1 and 9 — the fixture
    // deliberately carries the valid forms, and this test is why.
    const { readSeedFile } = await import('../../../src/seed/rates.js');
    const parsed = parseTreasurySeed((await readSeedFile('treasuries.json')).document);
    expect(parsed.securities).toHaveLength(7);
    for (const s of parsed.securities) {
      const result = parseCusip(s.cusip);
      expect(result.ok, `${s.ticker} ${s.cusip}: ${JSON.stringify(result)}`).toBe(true);
    }
    expect(parsed.securities.map((s) => s.termLabel)).toEqual([
      '2Y',
      '3Y',
      '5Y',
      '7Y',
      '10Y',
      '20Y',
      '30Y',
    ]);
  });

  it('noteTerms states every column and binds numerics as text', () => {
    const terms = noteTerms(security());
    // `numeric(9,6)`: a float literal would round-trip through binary64.
    expect(terms.couponRate).toBe('4.250000');
    expect(terms.amountOutstanding).toBe('42000000000.00');
    expect(terms.dayCount).toBe('ACT/ACT');
    expect(terms.couponFreq).toBe(2);
    expect(terms.calendarId).toBe('SIFMA');
    expect(terms.onTheRun).toBe(true);
    // The final coupon of a Treasury note is a regular one.
    expect(terms.lastRegularCoupon).toBe(terms.maturityDate);
  });
});

describe('publishedRateCodes mints only what the capture names', () => {
  function raw(body: string): RawRecord {
    return {
      providerId: 'nyfed.rates',
      method: 'GET',
      url: 'https://markets.newyorkfed.org/api/rates/all/latest.json',
      requestKey: 'k',
      requestHash: 'a'.repeat(64),
      status: 200,
      headers: {},
      body: Buffer.from(body, 'utf8'),
      capturedAt: CAPTURED_AT,
      sha256: 'b'.repeat(64),
      sourceTs: null,
      origin: 'replay',
    };
  }

  it('returns the six published types in registry order', () => {
    const codes = publishedRateCodes(
      raw(JSON.stringify({ refRates: RATE_SEED.map((r) => ({ type: r.rateCode })) })),
    );
    expect(codes).toEqual(['SOFR', 'EFFR', 'OBFR', 'TGCR', 'BGCR', 'SOFRAI']);
  });

  it('drops a type the registry does not know and survives a payload with no refRates', () => {
    expect(publishedRateCodes(raw(JSON.stringify({ refRates: [{ type: 'LIBOR' }] })))).toEqual([]);
    expect(publishedRateCodes(raw(JSON.stringify({})))).toEqual([]);
  });
});

describe('deriveSofrOisPoints — FUNCTIONS_TIER3 §CRVF L288, and every input absent', () => {
  const vintageAt = new Date(CAPTURED_AT).toISOString();

  function fixing(overrides: Record<string, unknown> = {}): never | {
    effectiveDate: string;
    rate: number | null;
    avg30d: number | null;
    avg90d: number | null;
    avg180d: number | null;
    provenanceId: number;
    capturedAt: number;
  } {
    return {
      effectiveDate: CURVE_DATE,
      rate: 3.62,
      avg30d: null,
      avg90d: null,
      avg180d: null,
      provenanceId: 11,
      capturedAt: CAPTURED_AT,
      ...overrides,
    };
  }

  function point(tenor: string, value: number) {
    return { tenor, value, provenanceId: 22, capturedAt: CAPTURED_AT };
  }

  const parYields = new Map([
    ['2Y', point('2Y', 4.65)],
    ['3Y', point('3Y', 4.73)],
    ['5Y', point('5Y', 4.8)],
    ['7Y', point('7Y', 4.88)],
    ['10Y', point('10Y', 4.97)],
    ['20Y', point('20Y', 5.37)],
    ['30Y', point('30Y', 5.34)],
  ]);
  const billYields = new Map([['52WK', point('52WK', 4.35)]]);
  const sofrai = fixing({
    effectiveDate: '2026-09-15',
    rate: null,
    avg30d: 3.6485,
    avg90d: 3.64603,
    avg180d: 3.65767,
    provenanceId: 33,
  });

  function derive(overrides: Record<string, unknown> = {}) {
    return deriveSofrOisPoints({
      curveDate: CURVE_DATE,
      vintageAt,
      sofr: fixing(),
      sofrai,
      parYields,
      billYields,
      ...overrides,
    });
  }

  it('produces all twelve points, ascending, with the documented quote types', () => {
    const derived = derive();
    expect(derived.missing).toEqual([]);
    expect(derived.points).toHaveLength(SOFR_OIS_PROXIES.length);
    expect(derived.points.map((p) => p.tenor)).toEqual([
      'ON',
      '1M',
      '3M',
      '6M',
      '1Y',
      '2Y',
      '3Y',
      '5Y',
      '7Y',
      '10Y',
      '20Y',
      '30Y',
    ]);
    // The overnight anchor is the fixing the bootstrap reads; the realised averages are term (zero)
    // rates the annual-frequency OIS engine cannot consume; everything else is a par-swap proxy.
    expect(derived.points.filter((p) => p.quoteType === 'fixing').map((p) => p.tenor)).toEqual(['ON']);
    expect(derived.points.filter((p) => p.quoteType === 'zero_rate').map((p) => p.tenor)).toEqual([
      '1M',
      '3M',
      '6M',
    ]);
    expect(derived.points.filter((p) => p.quoteType === 'ois_rate')).toHaveLength(8);
    // No derived point claims to be a security's quote.
    expect(derived.points.every((p) => p.instrumentId === null && p.maturityDate === null)).toBe(true);
    expect(derived.points.every((p) => p.vintageAt === vintageAt)).toBe(true);
  });

  it('takes the ON node from the SOFR fixing and the term points from their stated sources', () => {
    const derived = derive();
    const at = (tenor: string): number => derived.points.find((p) => p.tenor === tenor)!.value;
    expect(at('ON')).toBe(3.62);
    expect(at('1M')).toBe(3.6485);
    expect(at('3M')).toBe(3.64603);
    expect(at('6M')).toBe(3.65767);
    // The 52-week bill's investment yield on an ACT/360 basis: 4.35 × 360/365.
    expect(at('1Y')).toBeCloseTo((4.35 * 360) / 365, 12);
    expect(at('1Y')).toBeCloseTo(4.2904109589, 9);
    // Par yields less the stated Treasury-OIS basis, which is zero and named.
    expect(TREASURY_OIS_BASIS_BP).toBe(0);
    expect(at('10Y')).toBe(4.97);
    expect(at('30Y')).toBe(5.34);
  });

  it('knows its inputs: the latest capture instant and every provenance id it consumed', () => {
    const derived = derive({
      sofr: fixing({ capturedAt: CAPTURED_AT - 60_000 }),
      sofrai: { ...sofrai, capturedAt: CAPTURED_AT + 120_000 },
    });
    expect(derived.knewAtMs).toBe(CAPTURED_AT + 120_000);
    expect(derived.inputProvenanceIds).toEqual([11, 22, 33]);
    expect(derived.inputs).toHaveLength(12);
    expect(derived.inputs.every((i) => i.source !== '')).toBe(true);
  });

  it('writes no ON point and no curve at all when the SOFR fixing is missing', () => {
    const derived = derive({ sofr: null });
    expect(derived.points.map((p) => p.tenor)).not.toContain('ON');
    expect(derived.missing[0]).toEqual({
      tenor: 'ON',
      reason: 'no SOFR fixing on the curve date',
    });
    // The term points still stand: a hole is a hole, not a reason to invent an overnight rate.
    expect(derived.points).toHaveLength(11);
  });

  it('refuses a SOFRAI release from outside the realised window rather than using it', () => {
    const stale = {
      ...sofrai,
      effectiveDate: new Date(
        Date.parse(`${CURVE_DATE}T00:00:00Z`) + (MAX_SOFRAI_LAG_DAYS + 1) * 86_400_000,
      )
        .toISOString()
        .slice(0, 10),
    };
    const derived = derive({ sofrai: stale });
    expect(derived.points.map((p) => p.tenor)).not.toContain('1M');
    expect(derived.missing.map((m) => m.tenor)).toEqual(['1M', '3M', '6M']);
    expect(derived.missing[0]?.reason).toMatch(/is 6 days from the curve date/);
  });

  it('skips an average the release published as NULL', () => {
    const derived = derive({ sofrai: { ...sofrai, avg90d: null } });
    expect(derived.missing).toEqual([
      { tenor: '3M', reason: 'SOFRAI avg_90d is NULL in the release' },
    ]);
    expect(derived.points.map((p) => p.tenor)).not.toContain('3M');
  });

  it('skips a tenor the par curve did not publish and the 1Y when no 52-week bill exists', () => {
    const gapped = new Map(parYields);
    gapped.delete('7Y');
    const derived = derive({ parYields: gapped, billYields: new Map() });
    expect(derived.missing.map((m) => m.tenor).sort()).toEqual(['1Y', '7Y']);
    expect(derived.points.map((p) => p.tenor)).not.toContain('7Y');
    expect(derived.points).toHaveLength(10);
  });

  it('derives nothing from nothing', () => {
    const derived = deriveSofrOisPoints({
      curveDate: CURVE_DATE,
      vintageAt,
      sofr: null,
      sofrai: null,
      parYields: new Map(),
      billYields: new Map(),
    });
    expect(derived.points).toEqual([]);
    expect(derived.missing).toHaveLength(SOFR_OIS_PROXIES.length);
    expect(derived.knewAtMs).toBe(0);
    expect(derived.inputProvenanceIds).toEqual([]);
  });
});

describe('investmentYieldToAct360', () => {
  it('is the ACT/365 → ACT/360 day-count conversion of a simple rate', () => {
    expect(investmentYieldToAct360(365)).toBe(360);
    expect(investmentYieldToAct360(0)).toBe(0);
    expect(investmentYieldToAct360(4.35)).toBeCloseTo(4.290410958904, 12);
  });
});

describe('storeAtCapture pins the replay store to one capture of a request', () => {
  it('serves the second capture of the AAPL minute request, and refuses a third', async () => {
    const { openReplayStore } = await import('../../../src/providers/replayStore.js');
    const { chartUrl } = await import('../../../src/providers/yahoo/adapter.js');
    const { storeAtCapture } = await import('../../../src/seed/bars.js');

    const store = openReplayStore();
    const url = chartUrl({ symbol: 'AAPL', interval: '1m', range: '1d' });
    const first = storeAtCapture(store, 'yahoo.chart', url, 0).replay({
      providerId: 'yahoo.chart',
      url,
    });
    const second = storeAtCapture(store, 'yahoo.chart', url, 1).replay({
      providerId: 'yahoo.chart',
      url,
    });
    // Two polls of one request, four minutes apart: the same key, different bytes and instants.
    expect(first.requestKey).toBe(second.requestKey);
    expect(second.capturedAt).toBeGreaterThan(first.capturedAt);
    expect(second.sha256).not.toBe(first.sha256);
    // Index 0 is the store itself — no manifest copy is made for the common case.
    expect(storeAtCapture(store, 'yahoo.chart', url, 0)).toBe(store);
    // A capture the manifest does not hold is a loud failure, never a silent fall back to the first:
    // that would write the wrong bar count and look like a success.
    expect(() => storeAtCapture(store, 'yahoo.chart', url, 2)).toThrow(/capture 2 cannot be replayed/);
  });
});

describe('what seed/bars.ts takes from a capture', () => {
  function action(
    caType: 'cash_dividend' | 'split',
    exDate: string,
  ): YahooChartRows['corporateActions'][number] {
    return {
      instrumentId: 1,
      caType,
      status: 'confirmed',
      exDate,
      amount: caType === 'cash_dividend' ? 0.26 : null,
      currency: 'USD',
      ratioNew: caType === 'split' ? 4 : null,
      ratioOld: caType === 'split' ? 1 : null,
      details: {},
      sourceId: 'yahoo.chart',
      reviewState: 'queued',
    };
  }

  it('takes only the splits from the quarterly max capture (the TESTING §7.3 trap)', () => {
    const actions = [
      action('cash_dividend', '1987-05-11'),
      action('split', '1987-06-16'),
      action('cash_dividend', '2026-08-10'),
      action('split', '2020-08-31'),
      // A consolidation is a split in the other direction (`providers/yahoo/parse.ts` L590) and is
      // part of the capital-structure history the split filter exists for.
      { ...action('split', '1999-01-04'), caType: 'reverse_split' },
    ];
    expect(filterActions(actions, 'splits').map((a) => a.exDate)).toEqual([
      '1987-06-16',
      '2020-08-31',
      '1999-01-04',
    ]);
    expect(filterActions(actions, 'all')).toHaveLength(5);
    expect(filterActions(actions, 'none')).toEqual([]);
  });

  it('projects an eod view onto the six-field alphabet and keeps the substitution flag', () => {
    const json = eodFieldsJson({
      sessionDate: '2026-09-15',
      closeTs: CAPTURED_AT,
      fields: { PX_OFFICIAL_CLOSE: 330.3, PX_VOLUME: 1_000, PX_BID: 330.2 },
      flags: ['OFFICIAL_CLOSE_FROM_LAST'],
    });
    expect(json).toEqual({
      PX_OFFICIAL_CLOSE: 330.3,
      PX_VOLUME: 1_000,
      // The flags travel under a key that is not a dictionary field id.
      _flags: ['OFFICIAL_CLOSE_FROM_LAST'],
    });
    // A field outside the alphabet never reaches `eod_snapshots.fields`.
    expect(Object.keys(json)).not.toContain('PX_BID');
  });

  it('leaves _flags out when nothing was substituted', () => {
    const json = eodFieldsJson({
      sessionDate: '2026-09-15',
      closeTs: CAPTURED_AT,
      fields: { PX_OFFICIAL_CLOSE: 1 },
      flags: [],
    });
    expect(json).toEqual({ PX_OFFICIAL_CLOSE: 1 });
  });

  it('dates the session from the capture instant, never from a wall clock', () => {
    expect(sessionDateOf(CAPTURED_AT)).toBe('2026-09-15');
  });
});
