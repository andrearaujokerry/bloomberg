/**
 * `test/integration/functions/YAS.test.ts` — WP-11's acceptance row for `YAS`
 * ("the seeded on-the-run notes/bonds: price↔yield round-trip, accrued on a coupon date, KRDs sum
 * to duration, `meta.engines[]` present").
 *
 * The four assertions are the four ways a pricing screen goes quietly wrong:
 *
 *  1. **Price↔yield is not a round trip unless it is one to full precision.** A yield priced to a
 *     clean price and solved back must return the same yield to 1e-9, not to two decimals: a
 *     solver that stops early is invisible on the screen and wrong in the CSV.
 *  2. **Accrued on a coupon date is exactly zero.** It is the boundary the day-count conventions
 *     disagree on, and a convention error that is 1/365 of a coupon out is unnoticeable anywhere
 *     else in the schedule.
 *  3. **`Σ KRD ≈ modified duration`, and the "≈" is the whole point.** The key-rate durations are
 *     four independent reprices of the bond on a triangular-kernel bump of the pricing curve's zero
 *     curve (`bond.krd@1.0.0`, §0), not an algebraic decomposition of the yield-based duration. The
 *     kernels are a partition of unity, so the four bumps together are a parallel 1 bp shift and
 *     the sum is the curve's **parallel-shift** duration — which differs from the modified duration
 *     by the curve's shape and by the basis the shift is applied on, and differs from the exact
 *     parallel-shift figure by the bump's truncation. An exact sum would mean the numbers came back
 *     from yield space and carry no twist information at all, which is what WP-11 shipped and this
 *     file used to assert at 1e-9. The tolerance is 3 %: the measured residuals on this seed are
 *     +1.88 % (2Y), +1.91 % (10Y), +1.93 % (OLD) and −0.04 % (30Y), dominated by the `y/2` gap
 *     between a continuous zero shift and a semiannual yield derivative.
 *  4. **Every payload carries `meta.engines[]`** with a name, a semver version and a 64-character
 *     inputs hash, and two runs at the same explicit `asOf` produce the same hashes (ANAL-08).
 *
 * No seed is assumed and nothing asserts on a literal instrument id: WP-15 owns the seed and it is
 * not written, so every row lives inside `withTxDb()`'s transaction.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PayloadMeta } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { SIFMA } from '@terminal/core/calendars/sifma';
import { YAS } from '@terminal/core/functions/manifests/YAS';
import type { YasCouponResults, YasPayload } from '@terminal/core/functions/manifests/YAS';

import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as YASModule from '../../../src/functions/YAS/resolve.js';
import { materialiseCalendar } from '../../../src/refdata/calendars.js';
import { masterRepositories } from '../../../src/refdata/master.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, createWebSession, GOLDEN_CAPTURE_MS } from '../ws/helpers.js';
import { expectGolden, idToken, subjectToken } from './golden.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = new Date('2020-01-01T00:00:00Z');

const SYMBOL_TAG = `.t${randomUUID().slice(0, 8)}`;
const REGISTRY = new FunctionRegistry([YAS]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { YAS: YASModule };

const t: TestDb = withTxDb();

/** The curve this file prices against: Monday 2026-09-14, the session before the frozen clock. */
const CURVE_DATE = '2026-09-14';
const VINTAGE = '2026-09-15T10:00:00.000Z';

/**
 * `[tenor, tenorDays, par yield %]`.
 *
 * The Treasury publishes fourteen par tenors starting at 1M; this seeds the nine at or beyond six
 * months, because WP-02's `curve.bootstrap` treats **every** `par_yield` point as a par coupon bond
 * and raises on a tenor shorter than one semiannual coupon period ("a 1-month tenor is not a whole
 * number of 2/yr coupon periods"). The cross-package gap is reported to the integrator; the
 * degraded path it produces is asserted in `CRVF.test.ts` so the defect cannot be lost.
 */
const PAR_POINTS: readonly [string, number, number][] = [
  ['6M', 182, 3.95],
  ['1Y', 365, 3.9],
  ['2Y', 730, 3.76],
  ['3Y', 1096, 3.78],
  ['5Y', 1826, 3.81],
  ['7Y', 2557, 3.95],
  ['10Y', 3653, 4.07],
  ['20Y', 7305, 4.55],
  ['30Y', 10958, 4.66],
];

/** `[tenor, tenorDays, discount rate %, investment yield %]`. */
const BILL_POINTS: readonly [string, number, number, number][] = [
  ['4WK', 28, 3.69, 3.76],
  ['13WK', 91, 3.9, 4.0],
  ['26WK', 182, 3.88, 4.01],
  ['52WK', 364, 3.7, 3.85],
];

interface SeededBond {
  instrumentId: number;
  key: string;
}

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  bonds: Record<string, SeededBond>;
}

let env: Env;

async function ensureLicences(): Promise<void> {
  const present = await t.client.query(
    `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
  );
  if (present.rowCount === 0) await seedLicences(t.client);
}

async function grantEverySource(firmId: number, userId: number): Promise<void> {
  await t.client.query(
    `INSERT INTO entitlement_grants
       (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
        usage_display, usage_export, usage_api, valid_from, valid_to)
     SELECT k.kind, k.id, l.source_id, NULL, NULL, 'realtime'::tier, true, true, true,
            $3::timestamptz, 'infinity'::timestamptz
       FROM (SELECT DISTINCT source_id FROM licence_registry WHERE tx_to = 'infinity') l
       CROSS JOIN (VALUES ('firm', $1::bigint), ('user', $2::bigint)) AS k(kind, id)`,
    [firmId, userId, GRANT_FROM],
  );
}

interface BondSpec {
  ticker: string;
  name: string;
  securityType: 'bill' | 'note' | 'bond' | 'tips';
  cusip: string;
  termLabel: string | null;
  couponRate: number | null;
  couponFreq: number;
  dayCount: string;
  datedDate: string;
  maturityDate: string;
  onTheRun: boolean;
}

async function seedBond(spec: BondSpec, provenanceId: number): Promise<SeededBond> {
  const repos = masterRepositories(t.db);
  const o = { validFrom: VALID_FROM, provenanceId };
  const issuerId = await repos.issuers.insert({ name: 'United States Treasury' }, o);
  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass: 'govt',
      securityType: 'US GOVERNMENT',
      name: spec.name,
      currency: 'USD',
    },
    o,
  );
  const instrumentId = await repos.instruments.insert(
    {
      issueId,
      assetClass: 'govt',
      marketSector: 'Govt',
      ticker: spec.ticker,
      exchCode: 'GOVT',
      name: spec.name,
      currency: 'USD',
      searchWeight: 60,
    },
    o,
  );
  await repos.mdLines.upsertBySymbol(
    {
      instrumentId,
      sourceId: 'treasury.bills',
      providerSymbol: `${spec.cusip}${SYMBOL_TAG}`,
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 60_000,
      priority: 10,
    },
    o,
  );
  await t.client.query(
    `INSERT INTO govt_terms (instrument_id, security_type, cusip, term_label, issue_date,
                             dated_date, maturity_date, coupon_type, coupon_rate, coupon_freq,
                             day_count, business_day_conv, calendar_id, settlement_days,
                             min_denomination, on_the_run, valid_from, provenance_id)
     VALUES ($1, $2, $3, $4, $5::date, $5::date, $6::date, $7, $8, $9, $10, 'following', 'SIFMA',
             1, 100, $11, $12::timestamptz, $13)`,
    [
      instrumentId,
      spec.securityType,
      spec.cusip,
      spec.termLabel,
      spec.datedDate,
      spec.maturityDate,
      spec.couponRate === null ? 'zero' : 'fixed',
      spec.couponRate,
      spec.couponFreq,
      spec.dayCount,
      spec.onTheRun,
      VALID_FROM.toISOString(),
      provenanceId,
    ],
  );
  return { instrumentId, key: `${spec.ticker} Govt` };
}

async function seedCurve(spec: {
  curveId: string;
  name: string;
  kind: string;
  dayCount: string;
  compounding: string;
  sourceId: string;
}): Promise<void> {
  await t.client.query(
    `INSERT INTO curves (curve_id, name, currency, kind, day_count, compounding, source_id,
                         default_interpolation)
     VALUES ($1, $2, 'USD', $3, $4, $5, $6, 'monotone_convex')
     ON CONFLICT (curve_id) DO NOTHING`,
    [spec.curveId, spec.name, spec.kind, spec.dayCount, spec.compounding, spec.sourceId],
  );
}

async function seedPoint(spec: {
  curveId: string;
  curveDate: string;
  tenor: string;
  tenorDays: number;
  quoteType: string;
  value: number;
  instrumentId?: number;
  maturityDate?: string;
  provenanceId: number;
}): Promise<void> {
  await t.client.query(
    `INSERT INTO curve_points (curve_id, curve_date, tenor, quote_type, vintage_at, tenor_days,
                               value, instrument_id, maturity_date, is_latest, provenance_id)
     VALUES ($1, $2::date, $3, $4, $5::timestamptz, $6, $7, $8, $9::date, true, $10)`,
    [
      spec.curveId,
      spec.curveDate,
      spec.tenor,
      spec.quoteType,
      VINTAGE,
      spec.tenorDays,
      spec.value,
      spec.instrumentId ?? null,
      spec.maturityDate ?? null,
      spec.provenanceId,
    ],
  );
}

beforeEach(async () => {
  await ensureLicences();
  await materialiseCalendar(t.db, SIFMA, { fromYear: 2026, toYear: 2027 });

  const session = await createWebSession(t, { email: `yas-${randomUUID()}@demo.invalid` });
  await grantEverySource(session.firmId, session.userId);

  const treasuryProv = await bootstrapProvenance(t, 'treasury.yieldcurve', 'yas-par');
  const billProv = await bootstrapProvenance(t, 'treasury.bills', 'yas-bill');
  const refProv = await bootstrapProvenance(t, 'internal.user', 'yas-ref');

  await seedCurve({
    curveId: 'UST_PAR',
    name: 'US Treasury par yield curve',
    kind: 'par',
    dayCount: 'ACT/ACT',
    compounding: 'semiannual',
    sourceId: 'treasury.yieldcurve',
  });
  await seedCurve({
    curveId: 'UST_BILL',
    name: 'US Treasury bill rates',
    kind: 'bill',
    dayCount: 'ACT/360',
    compounding: 'simple',
    sourceId: 'treasury.bills',
  });
  for (const [tenor, tenorDays, value] of PAR_POINTS) {
    await seedPoint({
      curveId: 'UST_PAR',
      curveDate: CURVE_DATE,
      tenor,
      tenorDays,
      quoteType: 'par_yield',
      value,
      provenanceId: treasuryProv,
    });
  }

  // The seeded universe: the on-the-run 2Y, 10Y and 30Y, one off-the-run note (so the benchmark
  // column has something to point at) and the on-the-run four-week bill.
  const note2y = await seedBond(
    {
      ticker: 'T 3.75 09/15/28',
      name: 'US Treasury Note 3.75% 15-Sep-2028',
      securityType: 'note',
      cusip: '91282CLM1',
      termLabel: '2Y',
      couponRate: 3.75,
      couponFreq: 2,
      dayCount: 'ACT/ACT',
      datedDate: '2026-09-15',
      maturityDate: '2028-09-15',
      onTheRun: true,
    },
    refProv,
  );
  const note10y = await seedBond(
    {
      ticker: 'T 4.25 08/15/36',
      name: 'US Treasury Note 4.25% 15-Aug-2036',
      securityType: 'note',
      cusip: '91282CLN9',
      termLabel: '10Y',
      couponRate: 4.25,
      couponFreq: 2,
      dayCount: 'ACT/ACT',
      datedDate: '2026-08-15',
      maturityDate: '2036-08-15',
      onTheRun: true,
    },
    refProv,
  );
  const bond30y = await seedBond(
    {
      ticker: 'T 4.625 08/15/56',
      name: 'US Treasury Bond 4.625% 15-Aug-2056',
      securityType: 'bond',
      cusip: '912810UF3',
      termLabel: '30Y',
      couponRate: 4.625,
      couponFreq: 2,
      dayCount: 'ACT/ACT',
      datedDate: '2026-08-15',
      maturityDate: '2056-08-15',
      onTheRun: true,
    },
    refProv,
  );
  const oldNote = await seedBond(
    {
      ticker: 'T 4.00 05/15/34',
      name: 'US Treasury Note 4.00% 15-May-2034',
      securityType: 'note',
      cusip: '91282CJK8',
      termLabel: null,
      couponRate: 4.0,
      couponFreq: 2,
      dayCount: 'ACT/ACT',
      datedDate: '2024-05-15',
      maturityDate: '2034-05-15',
      onTheRun: false,
    },
    refProv,
  );
  const bill = await seedBond(
    {
      ticker: '912797VE4',
      name: 'US Treasury Bill 4WK 29-Sep-2026',
      securityType: 'bill',
      cusip: '912797VE4',
      termLabel: '4WK',
      couponRate: null,
      couponFreq: 0,
      dayCount: 'ACT/360',
      datedDate: '2026-09-01',
      maturityDate: '2026-09-29',
      onTheRun: true,
    },
    refProv,
  );

  for (const [tenor, tenorDays, discount, investment] of BILL_POINTS) {
    for (const [quoteType, value] of [
      ['discount_rate', discount],
      ['investment_yield', investment],
    ] as const) {
      await seedPoint({
        curveId: 'UST_BILL',
        curveDate: CURVE_DATE,
        tenor,
        tenorDays,
        quoteType,
        value,
        ...(tenor === '4WK'
          ? { instrumentId: bill.instrumentId, maturityDate: '2026-09-29' }
          : {}),
        provenanceId: billProv,
      });
    }
  }

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };

  env = {
    harness,
    app: harness.app,
    clock,
    cookie: session.cookie,
    knownAt,
    bonds: {
      '2Y': note2y,
      '10Y': note10y,
      '30Y': bond30y,
      OLD: oldNote,
      BILL: bill,
    },
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: YasPayload;
  meta: PayloadMeta;
}

async function runYAS(bond: string, params: Record<string, unknown> = {}): Promise<Run> {
  const seeded = env.bonds[bond];
  if (seeded === undefined) throw new Error(`YAS test: nothing seeded under '${bond}'`);
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/YAS/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params,
      security: { id: seeded.instrumentId },
      asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

function coupon(payload: YasPayload): YasCouponResults {
  expect(payload.results.kind).toBe('coupon');
  return payload.results as YasCouponResults;
}

/**
 * The keys of a YAS payload that hold a sequence-allocated id: the instrument and the
 * `curve_builds.build_id`. `tenorDays`, `days`, `couponFreq` and every price, yield and
 * basis-point number are measurements — a value-based rule would rename whichever of them the
 * sequence happens to reach (WP-10's golden defect).
 */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId', 'buildId']);

function normalise(payload: YasPayload): unknown {
  const tokens = new Map<number, string>(
    Object.entries(env.bonds).map(([key, seeded]) => [seeded.instrumentId, `<${key}>`]),
  );
  const json = JSON.stringify(payload, (key, value: unknown) => {
    // `knownAt` is `clock_timestamp()` plus a second: the one field of this payload that a re-run
    // legitimately changes, and the only one substituted by name rather than by id.
    if (key === 'knownAt') return '<KNOWNAT>';
    if (key === 'buildId' && typeof value === 'number' && value > 0) return '<BUILD>';
    if (typeof value === 'string') return subjectToken(value, tokens);
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

describe('YAS — the seeded on-the-run notes and bonds', () => {
  it('prices the 10Y note off the curve and carries an engine note for every number', async () => {
    const { data, meta } = await runYAS('10Y');

    expect(data.variant).toBe('govt');
    expect(data.instrument.securityType).toBe('note');
    expect(data.settlement.date).toBe('2026-09-16');
    expect(data.settlement.rule).toBe('T+1 SIFMA');
    expect(data.curve).not.toBeNull();
    expect(data.curve?.id).toBe('UST_PAR');
    expect(data.curve?.date).toBe(CURVE_DATE);

    const results = coupon(data);
    // The yield came from the curve, interpolated at the note's own remaining life.
    expect(results.yieldPct.v).toBeCloseTo(
      results.spreads.interpolatedCurveYieldPct.v as number,
      12,
    );
    expect(results.spreads.toCurveBp.v).toBeCloseTo(0, 9);
    expect(results.cleanPrice.v as number).toBeGreaterThan(50);
    expect(results.dirtyPrice.v as number).toBeGreaterThan(results.cleanPrice.v as number);

    // ANAL-08: an engine note per computation, each with a semver version and a 64-hex hash.
    const names = meta.engines.map((e) => e.name).sort();
    expect(names).toContain('bond.price');
    expect(names).toContain('bond.risk');
    expect(names).toContain('curve.bootstrap');
    expect(names).toContain('curve.interp');
    expect(names).toContain('bond.zspread');
    for (const engine of meta.engines) {
      expect(engine.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(engine.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('round-trips price and yield to full precision', async () => {
    const priced = await runYAS('10Y', { input: 'yield', yield: 4.95 });
    const results = coupon(priced.data);
    expect(results.yieldPct.v).toBe(4.95);
    const cleanPrice = results.cleanPrice.v as number;

    const solved = await runYAS('10Y', { input: 'price', price: cleanPrice });
    const back = coupon(solved.data);
    expect(back.yieldPct.v as number).toBeCloseTo(4.95, 9);
    expect(back.cleanPrice.v as number).toBeCloseTo(cleanPrice, 9);
  });

  it('accrues exactly nothing on a coupon date, and a full period the day before the next', async () => {
    const onCoupon = await runYAS('10Y', { settlement: '2027-02-15' });
    const results = coupon(onCoupon.data);
    expect(results.accrued.v).toBe(0);
    expect(results.accruedDays).toBe(0);

    // One day into the period: a single day of the semiannual coupon, and nothing else.
    const nextDay = await runYAS('10Y', { settlement: '2027-02-16' });
    const after = coupon(nextDay.data);
    expect(after.accruedDays).toBe(1);
    expect(after.accrued.v as number).toBeGreaterThan(0);
    expect(after.accrued.v as number).toBeLessThan(4.25 / 2);
    expect(after.daysInPeriod).toBe(181);
  });

  it('sums the key-rate durations to the modified duration within the bump gap, for every seeded coupon security', async () => {
    for (const key of ['2Y', '10Y', '30Y', 'OLD']) {
      const { data } = await runYAS(key);
      const results = coupon(data);
      expect(results.keyRateDurations).toHaveLength(4);
      expect(results.keyRateDurations.map((k) => k.tenor)).toEqual(['2Y', '5Y', '10Y', '30Y']);
      const sum = results.keyRateDurations.reduce((acc, krd) => acc + (krd.krd ?? Number.NaN), 0);
      const modified = results.modifiedDuration.v as number;
      // Header note 3: a reprice-based sum is close to the modified duration, never equal to it.
      expect(
        Math.abs(sum - modified) / modified,
        `${key}: Σ KRD ${String(sum)} against modified duration ${String(modified)}`,
      ).toBeLessThan(0.03);
      // …and not so close that it could be the yield decomposition wearing a curve's name.
      expect(sum).not.toBe(modified);
    }
  });

  it('measures the key-rate durations on the curve, not on the yield', async () => {
    const { data, meta } = await runYAS('10Y');
    const results = coupon(data);
    const bucket = (tenor: string): number =>
      results.keyRateDurations.find((k) => k.tenor === tenor)?.krd ?? Number.NaN;

    // `bond.krd` ran, and its inputs hash covers the curve nodes and the fixed Z-spread (ANAL-08).
    const krdEngine = meta.engines.find((e) => e.name === 'bond.krd');
    expect(krdEngine, 'no bond.krd engine note').toBeDefined();
    expect(krdEngine?.inputsHash).toMatch(/^[0-9a-f]{64}$/);

    // The 10Y note's last cashflow is inside ten years, so a *yield*-space tent at 30y is exactly
    // zero by construction. A curve bump at 30y is not: `monotone_convex` propagates the 20y and
    // 30y nodes into the forwards just below 10y, so the bucket is small, non-zero and negative.
    // This is the assertion that fails if the curve never reaches the engine.
    expect(bucket('30Y')).not.toBe(0);
    expect(Math.abs(bucket('30Y'))).toBeLessThan(0.05);
    expect(bucket('10Y')).toBeGreaterThan(bucket('5Y'));
    expect(bucket('5Y')).toBeGreaterThan(bucket('2Y'));
  });

  it('blanks the key-rate durations rather than reporting the yield decomposition, with no curve', async () => {
    const { data, meta } = await runYAS('10Y', {
      curveId: 'UST_CMT', // never seeded: no points, so no build and no Z-spread
      input: 'yield',
      yield: 4.95,
    });
    const results = coupon(data);
    expect(data.curve).toBeNull();
    // The bond still prices on the user's yield — only the curve-derived numbers go.
    expect(results.modifiedDuration.v).toBeTypeOf('number');
    expect(results.keyRateDurations).toHaveLength(4);
    expect(results.keyRateDurations.map((k) => k.krd)).toEqual([null, null, null, null]);
    const entry = meta.unavailable.find((u) => u.field === 'results.keyRateDurations');
    expect(entry?.reason).toBe('NO_SOURCE');
    expect(entry?.detail).toContain('zero curve');
  });

  it('discounts its own cashflows to the dirty price at the solved Z-spread', async () => {
    const { data } = await runYAS('10Y', { face: 1_000_000 });
    const results = coupon(data);
    const pv = data.cashflows.reduce((acc, flow) => acc + (flow.pv ?? 0), 0);
    expect(data.cashflows.every((flow) => flow.fromCurve)).toBe(true);
    expect(pv).toBeCloseTo((results.dirtyPrice.v as number) * 10_000, 4);
    expect(results.spreads.zSpreadBp?.v).toBeTypeOf('number');
  });

  it('spreads an off-the-run note to the on-the-run benchmark', async () => {
    const { data } = await runYAS('OLD');
    const results = coupon(data);
    expect(results.spreads.benchmark).not.toBeNull();
    expect(results.spreads.benchmark?.key).toBe('T 4.25 08/15/36 Govt');
    expect(results.spreads.benchmark?.spreadBp).toBeCloseTo(
      ((results.yieldPct.v as number) - (results.spreads.benchmark?.yieldPct ?? 0)) * 100,
      9,
    );
  });

  it('prices the four-week bill on the discount basis', async () => {
    const { data, meta } = await runYAS('BILL');
    expect(data.results.kind).toBe('bill');
    if (data.results.kind !== 'bill') return;
    const bill = data.results;
    expect(bill.daysToMaturity).toBe(13);
    expect(bill.discountRatePct.v).toBeCloseTo(3.69, 12);
    // P = 100 × (1 − d·t/360), the published identity the `bill` engine implements.
    expect(bill.price.v as number).toBeCloseTo(100 * (1 - 0.0369 * (13 / 360)), 10);
    expect(bill.investmentYieldPct.v as number).toBeGreaterThan(3.69);
    expect(bill.spreads.zSpreadBp).toBeNull();
    expect(data.cashflows).toHaveLength(1);
    expect(data.cashflows[0]?.total).toBe(1_000_000);
    expect(meta.engines.map((e) => e.name)).toContain('bill');
  });

  it('reproduces the same payload and the same engine hashes on two runs (ANAL-08)', async () => {
    const first = await runYAS('10Y');
    const second = await runYAS('10Y');
    expect(normalise(second.data)).toEqual(normalise(first.data));
    expect(second.meta.engines).toEqual(first.meta.engines);
  });

  it('refuses to price a TIPS rather than pricing it on the nominal convention', async () => {
    const tips = await seedBond(
      {
        ticker: 'TII 1.75 01/15/36',
        name: 'US Treasury Inflation-Indexed Note 1.75% 15-Jan-2036',
        securityType: 'tips',
        cusip: '91282CLT6',
        termLabel: '10Y',
        couponRate: 1.75,
        couponFreq: 2,
        dayCount: 'ACT/ACT',
        datedDate: '2026-01-15',
        maturityDate: '2036-01-15',
        onTheRun: true,
      },
      await bootstrapProvenance(t, 'internal.user', `yas-tips-${randomUUID().slice(0, 8)}`),
    );
    env.bonds.TIPS = tips;

    const { data, meta } = await runYAS('TIPS');
    expect(data.instrument.securityType).toBe('tips');
    const results = coupon(data);
    expect(results.yieldPct.v).toBeNull();
    expect(results.yieldPct.st).toBe('na');
    expect(data.cashflows).toEqual([]);
    const note = meta.unavailable.find((row) => row.field === 'results');
    expect(note?.reason).toBe('NOT_APPLICABLE');
    expect(note?.detail).toContain('TIPS/FRN pricing needs an inflation/reference-rate engine');
  });

  it('still prices a user yield when no curve is stored, and says the curve is missing', async () => {
    await t.client.query(`DELETE FROM curve_points WHERE curve_id = 'UST_PAR'`);

    const { data, meta } = await runYAS('10Y', { input: 'yield', yield: 4.5 });
    expect(data.curve).toBeNull();
    const results = coupon(data);
    // The bond still prices: price, accrued and risk need no curve at all.
    expect(results.yieldPct.v).toBe(4.5);
    expect(results.cleanPrice.v as number).toBeGreaterThan(50);
    expect(results.modifiedDuration.v as number).toBeGreaterThan(0);
    // The comparison does not, and says so rather than showing a zero spread.
    expect(results.spreads.toCurveBp.v).toBeNull();
    expect(results.spreads.toCurveBp.r).toBe('PROVIDER_DOWN');
    expect(meta.unavailable.map((row) => row.field)).toContain('curve');
  });

  it('matches the committed golden', async () => {
    const { data } = await runYAS('10Y');
    expectGolden('YAS.govt.json', normalise(data));
    const bill = await runYAS('BILL');
    expectGolden('YAS.govt.bill.json', normalise(bill.data));
  });
});
