/**
 * WORKPLAN WP-09 — `functions/shared/{cells,returns,instrumentSummary}.ts`, the three helpers
 * every Tier 1 resolver leans on (FUNCTIONS_TIER1.md §0.1, §0.4, §0.6).
 *
 * A unit test in the strict sense: no database, no network, no clock but the virtual one. The
 * plant, the licence registry and the entitlement evaluator are stubs, and the calendar is one of
 * `core/calendars`' rule calendars, so every session boundary in here is a fact about the calendar
 * rather than about a fixture.
 *
 * What is proved:
 *
 *  1. **Pending is not denied.** The distinction §0.4 rule 1 draws, on both plant paths
 *     (`snapshot` and `snapshotMany`): a subject the plant never polled yields `st: 'blank'`,
 *     `provIdx: -1`, **no** `r` and an untouched `meta.provenance`; a field the entitlement gate
 *     refused yields `v: null` with the gate's reason and a real provenance citation, over a
 *     composite that is holding a perfectly good number for it. Get this backwards and a screen
 *     either claims an entitlement problem the user does not have, or hides one they do.
 *  2. **The period statistics are what §0.6 defines**, checked against values derived here from
 *     the bar series by hand — `(125/118 − 1) × 100`, not "whatever the function returned last
 *     time". Including the two things the calendar is *for*: a Saturday bar is not a session, and
 *     a bar after `asOfDate` is not in the window.
 *  3. **No calendar ⇒ no number.** §0.6's degradation, exactly: nine nulls, nine `NO_SOURCE`
 *     entries naming the venue, the `NO_CALENDAR_FOR_VENUE` footer code — and specifically *not*
 *     a one-day return computed off two consecutive calendar days, which the bars would allow.
 *  4. **Beta's 200-session floor.** Below it, `null` with `NOT_APPLICABLE`; above it, the OLS
 *     slope, checked on a series built so the answer is exactly 2.
 *  5. **`toSummary` projects the API.md §3 columns** and keeps `primaryListingId` optional rather
 *     than `undefined`, which is the difference between two canonical hashes agreeing and not.
 */

import { describe, expect, it } from 'vitest';

import type {
  EntitlementDecision,
  FieldId,
  Instrument,
  ProvRef,
  QuoteState,
  ReasonCode,
} from '@terminal/core';
import {
  addDays,
  dayOfWeek,
  getCalendar,
  type Calendar,
  type IsoDate,
} from '@terminal/core/calendars/calendar';
import '@terminal/core/calendars/weekend';

import type { DataServices, ResolveContext } from '../../../src/functions/context.js';
import { buildContext } from '../../../src/functions/context.js';
import { cellFromState, pendingCell } from '../../../src/functions/shared/cells.js';
import { toSummary } from '../../../src/functions/shared/instrumentSummary.js';
import {
  beta1y,
  fixedCalendarId,
  periodReturns,
  primaryMic,
  recordPeriodMeta,
  venueCalendar,
  type PeriodBar,
} from '../../../src/functions/shared/returns.js';
import type { InstrumentDetail } from '../../../src/data/reference.js';
import type { Tx } from '../../../src/db/client.js';
import type { Evaluator } from '../../../src/entitlements/evaluator.js';
import type { LicenceEntry, LicenceRegistry } from '../../../src/entitlements/licenceRegistry.js';
import type { EodView } from '../../../src/plant/eod.js';
import type { Plant } from '../../../src/plant/tickerPlant.js';
import { testClock, TEST_NOW } from '../../../src/test/clock.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Nothing in this file reaches Postgres; a context that tried would fail loudly, not silently. */
const NO_DB = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`the unit context touched the database (db.${String(prop)})`);
    },
  },
) as unknown as Tx;

const SOURCE = 'cboe.quotes';
const SUBJECT = 'q:42';

const INSTRUMENT: Instrument = {
  versionId: 1,
  validFrom: '2020-01-01T00:00:00.000Z',
  validTo: '9999-12-31T00:00:00.000Z',
  txFrom: '2020-01-01T00:00:00.000Z',
  txTo: '9999-12-31T00:00:00.000Z',
  provenanceId: 1,
  instrumentId: 42,
  issueId: 7,
  assetClass: 'equity',
  marketSector: 'Equity',
  ticker: 'AAPL',
  exchCode: 'US',
  name: 'Apple Inc',
  currency: 'USD',
  status: 'active',
  searchWeight: 5,
};

function quoteState(over: Partial<QuoteState> = {}): QuoteState {
  const prov: ProvRef = { sourceId: SOURCE, provenanceId: 31 };
  return {
    subject: SUBJECT,
    instrumentId: 42,
    assetClass: 'equity',
    seq: 4,
    tier: 'delayed',
    delayMin: 15,
    fields: { PX_LAST: 188.5, PX_BID: 188.4 },
    fieldTs: { PX_LAST: TEST_NOW - 1_000, PX_BID: TEST_NOW - 2_000 },
    ts: { src: TEST_NOW - 1_000, cap: TEST_NOW - 500, pub: TEST_NOW - 400 },
    session: 'open',
    state: 'live',
    ageMs: 500,
    expectedIntervalMs: 15_000,
    prov,
    lines: {},
    dq: [],
    ...over,
  };
}

function fakePlant(states: readonly QuoteState[]): Plant {
  const bySubject = new Map(states.map((s) => [s.subject, s]));
  const plant = {
    snapshot: (subject: string): QuoteState | undefined => {
      const held = bySubject.get(subject);
      return held === undefined ? undefined : structuredClone(held);
    },
    snapshotMany: (subjects: readonly string[]): Map<string, QuoteState> => {
      const out = new Map<string, QuoteState>();
      for (const subject of subjects) {
        const held = bySubject.get(subject);
        if (held !== undefined) out.set(subject, structuredClone(held));
      }
      return out;
    },
    eodView: (): EodView | null => null,
  };
  return plant as unknown as Plant;
}

const registry: LicenceRegistry = {
  licence: (sourceId: string): LicenceEntry | undefined =>
    ({ sourceId, attribution: 'Source: Cboe One' }) as unknown as LicenceEntry,
  fieldSource: () => undefined,
  grantsFor: () => [],
  version: () => 1,
  reload: () => Promise.resolve(),
  refreshIfStale: () => Promise.resolve(),
  stats: () => ({ version: 1, licences: 0, fieldLicences: 0, grants: 0, loads: 1, freshChecks: 0 }),
};

const evaluator: Evaluator = {
  evaluate: () =>
    Promise.resolve({ effectiveTier: 'delayed', fields: [], downgrades: [], logIds: [] }),
  invalidate: () => undefined,
  stats: () => ({ evaluations: 0, cacheHits: 0, cacheMisses: 0 }),
};

function denial(fieldId: FieldId, reason: ReasonCode): EntitlementDecision {
  return {
    effectiveTier: 'delayed',
    fields: [
      {
        fieldId,
        sourceId: SOURCE,
        fieldClass: 'market_data',
        decision: 'deny',
        effectiveTier: null,
        reason,
      },
    ],
    downgrades: [],
    logIds: [],
  };
}

function contextFor(decision?: EntitlementDecision): ResolveContext {
  return buildContext(
    {
      clock: testClock(),
      db: NO_DB,
      data: {} as unknown as DataServices,
      plant: fakePlant([quoteState()]),
      registry,
      entitlements: evaluator,
    },
    {
      user: { userId: 5, firmId: 2, sessionId: 'sess-1', role: 'user' },
      traceId: '11111111-1111-4111-8111-111111111111',
      instrument: INSTRUMENT,
      asOf: { validAt: new Date(TEST_NOW), knownAt: new Date(TEST_NOW) },
      usage: 'display',
      purpose: 'DES',
      ...(decision === undefined ? {} : { decision }),
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §0.4 rule 1 — pending is not denied
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('cellFromState / pendingCell (FUNCTIONS_TIER1 §0.4 rule 1)', () => {
  it('a served field carries its value, its timestamp, a provenance index and no reason', () => {
    const ctx = contextFor();
    const state = ctx.plant.snapshot(SUBJECT);
    const cell = cellFromState(ctx, state, 'PX_LAST', SUBJECT);

    expect(cell).toEqual({
      v: 188.5,
      st: 'live',
      ts: TEST_NOW - 1_000,
      provIdx: 0,
      live: { subject: SUBJECT, field: 'PX_LAST' },
    });
    expect('r' in cell).toBe(false);
    expect(ctx.prov.list()).toHaveLength(1);
  });

  it('a never-polled subject is PENDING: blank, provIdx −1, no reason, provenance untouched', () => {
    const ctx = contextFor();
    // The plant holds q:42 only, so this is the "instrument known, never polled" case.
    const state = ctx.plant.snapshot('q:99');
    expect(state).toBeUndefined();

    const cell = cellFromState(ctx, state, 'PX_LAST', 'q:99');
    expect(cell).toEqual({
      v: null,
      st: 'blank',
      provIdx: -1,
      live: { subject: 'q:99', field: 'PX_LAST' },
    });
    expect('r' in cell).toBe(false);
    // The documented consequence: nothing was cited, so meta.provenance stays empty.
    expect(ctx.prov.list()).toEqual([]);
    expect(ctx.prov.size()).toBe(0);
    // pendingCell() alone must agree with the state-less path.
    expect(cellFromState(ctx, undefined, 'PX_LAST', 'q:99')).toEqual(pendingCell('q:99', 'PX_LAST'));
  });

  it('a DENIED field keeps the gate’s reason and still cites the snapshot', () => {
    const ctx = contextFor(denial('PX_BID', 'NOT_LICENSED'));
    const state = ctx.plant.snapshot(SUBJECT);

    const bid = cellFromState(ctx, state, 'PX_BID', SUBJECT);
    expect(bid.v).toBeNull();
    expect(bid.r).toBe('NOT_LICENSED');
    expect(bid.provIdx).toBe(0);
    expect(bid.live).toEqual({ subject: SUBJECT, field: 'PX_BID' });
    // Denied, not pending: a real provenance row was cited.
    expect(ctx.prov.list()).toHaveLength(1);
    expect(ctx.prov.list()[0]?.provenanceId).toBe(31);

    // …and the composite is holding a number for it. The gate is what blanked it, not the data.
    expect(quoteState().fields.PX_BID).toBe(188.4);
    // The sibling field on the same snapshot is unaffected.
    expect(cellFromState(ctx, state, 'PX_LAST', SUBJECT).v).toBe(188.5);
  });

  it('draws the same distinction on the snapshotMany path', () => {
    const ctx = contextFor(denial('PX_BID', 'NOT_LICENSED'));
    const many = ctx.plant.snapshotMany([SUBJECT, 'q:99']);

    const denied = cellFromState(ctx, many.get(SUBJECT), 'PX_BID', SUBJECT);
    const pending = cellFromState(ctx, many.get('q:99'), 'PX_BID', 'q:99');

    expect(denied.r).toBe('NOT_LICENSED');
    expect(denied.provIdx).toBe(0);
    expect(pending.v).toBeNull();
    expect('r' in pending).toBe(false);
    expect(pending.provIdx).toBe(-1);
    expect(pending.st).toBe('blank');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §0.6 — periodReturns
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Mon–Fri is a session, Sat/Sun is not — enough calendar to make every window here exact. */
const WEEKEND: Calendar = getCalendar('WEEKEND');

/** The eleven September 2026 sessions the hand-computed expectations below are read off. */
const SEPT: readonly (readonly [IsoDate, number, number, number, number])[] = [
  // date, close, high, low, volume
  ['2026-09-01', 100, 101, 99, 1_000],
  ['2026-09-02', 102, 103, 100, 1_200],
  ['2026-09-03', 101, 104, 98, 900],
  ['2026-09-04', 105, 106, 101, 1_100],
  ['2026-09-07', 110, 112, 104, 1_300],
  ['2026-09-08', 108, 111, 107, 0],
  ['2026-09-09', 112, 113, 108, 1_400],
  ['2026-09-10', 111, 115, 110, 1_500],
  ['2026-09-11', 120, 121, 111, 1_600],
  ['2026-09-14', 118, 122, 117, 1_700],
  ['2026-09-15', 125, 126, 118, 1_800],
];

function septBars(): PeriodBar[] {
  const bars: PeriodBar[] = SEPT.map(([date, close, high, low, volume]) => ({
    date,
    close,
    high,
    low,
    volume,
  }));
  // Two bars that must be ignored, and are the whole reason the calendar is a parameter:
  // a Saturday is not a session, and a bar after asOfDate is not in the window.
  bars.push({ date: '2026-09-05', close: 999, high: 999, low: 999, volume: 9_999 });
  bars.push({ date: '2026-09-16', close: 1, high: 1, low: 1, volume: 1 });
  return bars;
}

describe('periodReturns (FUNCTIONS_TIER1 §0.6)', () => {
  it('computes the period returns from the session series, in percent', () => {
    const r = periodReturns(septBars(), WEEKEND, '2026-09-15', 'XNYS');

    expect(r.asOfSession).toBe('2026-09-15');
    expect(r.sessions).toBe(11);

    // t = 2026-09-15 close 125; previous session 2026-09-14 close 118.
    expect(r.ret1d).toBeCloseTo((125 / 118 - 1) * 100, 12);
    expect(r.ret1d).toBeCloseTo(5.932203389830503, 10);

    // t − 7 calendar days = 2026-09-08, itself a session, close 108.
    expect(r.ret1w).toBeCloseTo((125 / 108 - 1) * 100, 12);
    expect(r.ret1w).toBeCloseTo(15.74074074074074, 10);

    // max high / min low over the eleven sessions — 999 is a Saturday and 1 is tomorrow.
    expect(r.high52w).toBe(126);
    expect(r.low52w).toBe(98);

    // Ten traded sessions: 2026-09-08 has volume 0 and is excluded, not counted as a zero.
    const traded = [1_000, 1_200, 900, 1_100, 1_300, 1_400, 1_500, 1_600, 1_700, 1_800];
    expect(r.avgVolume30d).toBeCloseTo(traded.reduce((a, b) => a + b, 0) / 10, 12);
    expect(r.avgVolume30d).toBe(1_350);

    expect(r.conventions).toEqual({
      returns: 'simple',
      priceBasis: 'close',
      adjust: 'price',
      annualisation: 252,
      volWindow: 30,
      betaBenchmark: 'SPX Index',
      betaWindow: 252,
    });
    expect(r.engine.name).toBe('stats');
    expect(r.engine.version).toBe('1.0.0');
    expect(r.engine.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.footerCodes).toEqual([]);
  });

  it('reports a window the history does not cover as null with a reason, never as a guess', () => {
    const r = periodReturns(septBars(), WEEKEND, '2026-09-15', 'XNYS');

    // The series starts 2026-09-01, so a month, a year and last new year are all out of reach.
    expect(r.ret1m).toBeNull();
    expect(r.ret1y).toBeNull();
    expect(r.retYtd).toBeNull();
    // Eleven sessions give ten returns; thirty are needed.
    expect(r.vol30d).toBeNull();

    const byField = new Map(r.unavailable.map((u) => [u.field, u]));
    for (const field of ['RET_1M', 'RET_1Y', 'RET_YTD', 'VOL_30D']) {
      expect(byField.get(field)?.reason).toBe('NO_SOURCE');
      expect(byField.get(field)?.detail).not.toBe('');
    }
    expect(byField.get('RET_1M')?.detail).toContain('2026-08-15');
    expect(byField.get('RET_YTD')?.detail).toContain('2025-12-31');
    // Nothing is claimed unavailable that was in fact served.
    expect(byField.has('RET_1D')).toBe(false);
    expect(byField.has('PX_HIGH_52W')).toBe(false);
  });

  it('ignores a bar on a non-session day: the Saturday close never becomes t−1', () => {
    // 2026-09-14 (Mon) as-of. Its previous *session* is Friday 2026-09-11 (close 120), not the
    // Saturday bar (close 999) that sits between them on the calendar.
    const r = periodReturns(septBars(), WEEKEND, '2026-09-14', 'XNYS');
    expect(r.asOfSession).toBe('2026-09-14');
    expect(r.ret1d).toBeCloseTo((118 / 120 - 1) * 100, 12);
    expect(r.high52w).toBe(122);
  });

  it('annualises a 30-day volatility the textbook way', () => {
    // 31 sessions whose 30 daily returns alternate exactly ±2 %: mean 0, so the sample variance is
    // Σr²/(n−1) = 30 × 0.02² / 29, and vol = √that × √252 × 100.
    const dates = weekdaysEndingAt('2026-09-15', 31);
    const closes: number[] = [100];
    for (let i = 1; i < 31; i += 1) {
      closes.push(closes[i - 1]! * (i % 2 === 1 ? 1.02 : 0.98));
    }
    const bars: PeriodBar[] = dates.map((date, i) => ({ date, close: closes[i]! }));

    const r = periodReturns(bars, WEEKEND, '2026-09-15', 'XNYS');
    expect(r.sessions).toBe(31);

    const expected = Math.sqrt((30 * 0.02 ** 2) / 29) * Math.sqrt(252) * 100;
    expect(r.vol30d).not.toBeNull();
    expect(r.vol30d).toBeCloseTo(expected, 8);
    expect(r.vol30d).toBeCloseTo(32.2917732664, 8);
  });

  it('degrades exactly as §0.6 says when the venue has no calendar', () => {
    const r = periodReturns(septBars(), null, '2026-09-15', 'ARCX');

    expect(r.asOfSession).toBeNull();
    expect(r.sessions).toBe(0);
    // Every figure, not just the returns: "session" is undefined without a calendar.
    expect({
      ret1d: r.ret1d,
      ret1w: r.ret1w,
      ret1m: r.ret1m,
      retYtd: r.retYtd,
      ret1y: r.ret1y,
      high52w: r.high52w,
      low52w: r.low52w,
      avgVolume30d: r.avgVolume30d,
      vol30d: r.vol30d,
    }).toEqual({
      ret1d: null,
      ret1w: null,
      ret1m: null,
      retYtd: null,
      ret1y: null,
      high52w: null,
      low52w: null,
      avgVolume30d: null,
      vol30d: null,
    });

    expect(r.footerCodes).toEqual(['NO_CALENDAR_FOR_VENUE']);
    expect(r.unavailable).toHaveLength(9);
    for (const note of r.unavailable) {
      expect(note.reason).toBe('NO_SOURCE');
      expect(note.detail).toBe('no calendar seeded for ARCX');
    }
    expect(r.unavailable.map((u) => u.field).sort()).toEqual([
      'PX_HIGH_52W',
      'PX_LOW_52W',
      'RET_1D',
      'RET_1M',
      'RET_1W',
      'RET_1Y',
      'RET_YTD',
      'VOLUME_AVG_30D',
      'VOL_30D',
    ]);
    // The bars contain 2026-09-14 and 2026-09-15 back to back, so a raw-calendar-day
    // implementation would happily have produced 5.93 % here. §0.6 forbids it.
    expect(r.ret1d).toBeNull();
  });

  it('recordPeriodMeta copies the notes and the engine into the run’s meta', () => {
    const ctx = contextFor();
    const r = periodReturns(septBars(), null, '2026-09-15', 'ARCX');
    const codes = recordPeriodMeta(ctx, r);

    expect(codes).toEqual(['NO_CALENDAR_FOR_VENUE']);
    // The collector de-duplicates on (field, reason), and these nine fields are distinct.
    expect(ctx.unavailable.list()).toHaveLength(9);
    expect(ctx.engines.list()).toEqual([r.engine]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §0.6 — beta1y
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `n` weekday dates ending at `end` (which must itself be a weekday), ascending. */
function weekdaysEndingAt(end: IsoDate, n: number): IsoDate[] {
  const out: IsoDate[] = [];
  let d = end;
  while (out.length < n) {
    const dow = dayOfWeek(d);
    if (dow >= 1 && dow <= 5) out.unshift(d);
    d = addDays(d, -1);
  }
  return out;
}

/** Closes that realise `returns` exactly, compounded from 100. */
function closesFrom(returns: readonly number[]): number[] {
  const out = [100];
  for (const r of returns) out.push(out[out.length - 1]! * (1 + r));
  return out;
}

describe('beta1y (FUNCTIONS_TIER1 §0.6)', () => {
  it('is null with NOT_APPLICABLE below 200 overlapping sessions', () => {
    const dates = weekdaysEndingAt('2026-09-15', 150);
    const benchRets = dates.slice(1).map((_, i) => ((i % 7) - 3) / 500);
    const bench = closesFrom(benchRets);
    const asset = closesFrom(benchRets.map((r) => r * 2));

    const bars: PeriodBar[] = dates.map((date, i) => ({ date, close: asset[i]! }));
    const benchBars: PeriodBar[] = dates.map((date, i) => ({ date, close: bench[i]! }));

    const r = beta1y(bars, benchBars, WEEKEND, '2026-09-15');
    expect(r.beta1y).toBeNull();
    expect(r.overlap).toBe(149);
    expect(r.unavailable).toEqual([
      { field: 'BETA_1Y', reason: 'NOT_APPLICABLE', detail: 'fewer than 200 overlapping sessions' },
    ]);
  });

  it('is the OLS slope once the floor is met — 2.0 on a series built to move twice as far', () => {
    const dates = weekdaysEndingAt('2026-09-15', 220);
    const benchRets = dates.slice(1).map((_, i) => ((i % 7) - 3) / 500);
    const bench = closesFrom(benchRets);
    const asset = closesFrom(benchRets.map((r) => r * 2));

    const bars: PeriodBar[] = dates.map((date, i) => ({ date, close: asset[i]! }));
    const benchBars: PeriodBar[] = dates.map((date, i) => ({ date, close: bench[i]! }));

    const r = beta1y(bars, benchBars, WEEKEND, '2026-09-15');
    expect(r.overlap).toBe(219);
    expect(r.beta1y).not.toBeNull();
    expect(r.beta1y).toBeCloseTo(2, 6);
    expect(r.unavailable).toEqual([]);
  });

  it('degrades with the venue when there is no calendar', () => {
    const r = beta1y([], [], null, '2026-09-15', 'ARCX');
    expect(r.beta1y).toBeNull();
    expect(r.unavailable).toEqual([
      { field: 'BETA_1Y', reason: 'NO_SOURCE', detail: 'no calendar seeded for ARCX' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §0.6 — the calendar join
// ─────────────────────────────────────────────────────────────────────────────────────────────

function detailFor(over: {
  assetClass?: Instrument['assetClass'];
  primaryListingId?: number;
  listings?: InstrumentDetail['listings'];
  securityType?: string;
  compositeFigi?: string;
  mdLineIds?: number[];
} = {}): InstrumentDetail {
  const bitemporal = {
    versionId: 1,
    validFrom: '2020-01-01T00:00:00.000Z',
    validTo: '9999-12-31T00:00:00.000Z',
    txFrom: '2020-01-01T00:00:00.000Z',
    txTo: '9999-12-31T00:00:00.000Z',
    provenanceId: 1,
  };
  const instrument = {
    ...INSTRUMENT,
    priceDecimals: 2,
    ...(over.assetClass === undefined ? {} : { assetClass: over.assetClass }),
    ...(over.primaryListingId === undefined ? {} : { primaryListingId: over.primaryListingId }),
    ...(over.compositeFigi === undefined ? {} : { compositeFigi: over.compositeFigi }),
  };
  return {
    instrument,
    issue:
      over.securityType === undefined
        ? null
        : {
            ...bitemporal,
            issueId: 7,
            issuerId: 3,
            assetClass: instrument.assetClass,
            securityType: over.securityType,
            name: 'Apple Inc',
            currency: 'USD',
          },
    issuer: null,
    listings: over.listings ?? [],
    mdLines: (over.mdLineIds ?? []).map((mdLineId) => ({
      ...bitemporal,
      mdLineId,
      instrumentId: 42,
      sourceId: SOURCE,
      providerSymbol: 'AAPL',
      lineKind: 'composite' as const,
      intrinsicDelayMin: 15,
      expectedIntervalMs: 15_000,
      priority: 1,
    })),
    identifiers: [],
    terms: null,
    classifications: [],
    provIdx: [],
    provIdxOf: {},
  };
}

function listing(listingId: number, mic: string | undefined, isPrimary: boolean) {
  return {
    versionId: listingId,
    validFrom: '2020-01-01T00:00:00.000Z',
    validTo: '9999-12-31T00:00:00.000Z',
    txFrom: '2020-01-01T00:00:00.000Z',
    txTo: '9999-12-31T00:00:00.000Z',
    provenanceId: 1,
    listingId,
    instrumentId: 42,
    exchCode: 'UW',
    localTicker: 'AAPL',
    isPrimary,
    listingStatus: 'active' as const,
    ...(mic === undefined ? {} : { mic }),
  };
}

/** A `ctx` with only what `venueCalendar` reads: a one-row `exchanges` select and the repository. */
function calendarCtx(rows: { calendarId: string }[], seeded: ReadonlySet<string>) {
  const queries: string[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            queries.push('exchanges');
            return Promise.resolve(rows);
          },
        }),
      }),
    }),
  } as unknown as ResolveContext['db'];
  const data = {
    reference: {
      calendar: (calendarId: string): Promise<Calendar> =>
        seeded.has(calendarId)
          ? Promise.resolve(getCalendar(calendarId))
          : Promise.reject(new Error(`no calendar '${calendarId}' in the database`)),
    },
  } as unknown as DataServices;
  return { ctx: { db, data }, queries };
}

describe('venueCalendar (FUNCTIONS_TIER1 §0.6 join)', () => {
  it('fx and crypto are fixed by the asset class and never touch exchanges', async () => {
    expect(fixedCalendarId('fx')).toBe('FX_USD');
    expect(fixedCalendarId('crypto')).toBe('WEEKEND');
    expect(fixedCalendarId('equity')).toBeNull();

    const { ctx, queries } = calendarCtx([], new Set(['WEEKEND']));
    const crypto = await venueCalendar(ctx, detailFor({ assetClass: 'crypto' }));
    expect(crypto.calendarId).toBe('WEEKEND');
    expect(crypto.calendar?.id).toBe('WEEKEND');
    expect(queries).toEqual([]);
  });

  it('resolves primary_listing_id → mic', () => {
    const listings = [listing(1, 'XNYS', false), listing(2, 'XNAS', true)];
    expect(primaryMic(detailFor({ listings, primaryListingId: 1 }))).toBe('XNYS');
    // No primary_listing_id: the listing flagged primary is the same venue by another route.
    expect(primaryMic(detailFor({ listings }))).toBe('XNAS');
    expect(primaryMic(detailFor({ listings: [listing(3, undefined, true)] }))).toBeNull();
    expect(primaryMic(detailFor())).toBeNull();
  });

  it('a venue with no exchanges row degrades to no calendar, labelled by its mic', async () => {
    const { ctx, queries } = calendarCtx([], new Set(['XNYS']));
    const v = await venueCalendar(
      ctx,
      detailFor({ listings: [listing(1, 'ARCX', true)], primaryListingId: 1 }),
    );
    expect(queries).toEqual(['exchanges']);
    expect(v.mic).toBe('ARCX');
    expect(v.calendarId).toBeNull();
    expect(v.calendar).toBeNull();
    expect(v.label).toBe('ARCX');
  });

  it('a calendar_id that was never materialised degrades too, rather than throwing', async () => {
    const { ctx } = calendarCtx([{ calendarId: 'XNYS' }], new Set());
    const v = await venueCalendar(
      ctx,
      detailFor({ listings: [listing(1, 'ARCX', true)], primaryListingId: 1 }),
    );
    expect(v.calendarId).toBe('XNYS');
    expect(v.calendar).toBeNull();
    expect(v.label).toBe('ARCX');
  });

  it('an instrument with no primary listing says so in the label', async () => {
    const { ctx, queries } = calendarCtx([], new Set());
    const v = await venueCalendar(ctx, detailFor());
    expect(queries).toEqual([]);
    expect(v.calendar).toBeNull();
    expect(v.label).toBe('equity with no primary listing');
  });

  it('a seeded venue resolves to its calendar', async () => {
    const { ctx } = calendarCtx([{ calendarId: 'XNYS' }], new Set(['XNYS']));
    const v = await venueCalendar(
      ctx,
      detailFor({ listings: [listing(1, 'ARCX', true)], primaryListingId: 1 }),
    );
    expect(v.calendarId).toBe('XNYS');
    expect(v.calendar?.id).toBe('XNYS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// API.md §3 — toSummary
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('toSummary (API.md §3)', () => {
  it('projects the §3 columns, with the canonical display form', () => {
    const detail = detailFor({
      listings: [listing(9, 'XNAS', true)],
      primaryListingId: 9,
      securityType: 'Common Stock',
      compositeFigi: 'BBG000B9XRY4',
      mdLineIds: [12, 3, 8],
    });

    expect(toSummary(detail)).toEqual({
      instrumentId: 42,
      assetClass: 'equity',
      marketSector: 'Equity',
      display: 'AAPL US Equity',
      name: 'Apple Inc',
      currency: 'USD',
      primaryListingId: 9,
      mdLineIds: [3, 8, 12],
      ticker: 'AAPL',
      exchCode: 'US',
      securityType: 'Common Stock',
      compositeFigi: 'BBG000B9XRY4',
      status: 'active',
      priceDecimals: 2,
    });
  });

  it('omits primaryListingId rather than setting it undefined, and never invents a type', () => {
    const summary = toSummary(detailFor());
    expect('primaryListingId' in summary).toBe(false);
    expect(summary.securityType).toBe('');
    expect(summary.compositeFigi).toBeNull();
    expect(summary.mdLineIds).toEqual([]);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it('does not speak a synthetic exchange code: SPX Index, not SPX INDEX Index', () => {
    const detail = detailFor();
    const index = {
      ...detail,
      instrument: {
        ...detail.instrument,
        assetClass: 'index' as const,
        marketSector: 'Index' as const,
        ticker: 'SPX',
        exchCode: 'INDEX',
        name: 'S&P 500 Index',
      },
    };
    expect(toSummary(index).display).toBe('SPX Index');
  });
});
