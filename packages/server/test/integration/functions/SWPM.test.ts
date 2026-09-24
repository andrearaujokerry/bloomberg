/**
 * `test/integration/functions/SWPM.test.ts` — WP-11's acceptance row for `SWPM`
 * ("par rate zeroes the NPV; DV01 matches finite difference; schedule honours SIFMA").
 *
 * Three assertions, each aimed at a way a swap pricer is wrong while looking right:
 *
 *  1. **The par rate zeroes the NPV.** This is the pricer's own consistency statement: the rate the
 *     screen offers as "par" must be the rate at which the swap is worth nothing on the same curve,
 *     to engine precision. A par rate solved off a different annuity, a different schedule or a
 *     different discount curve still prints a plausible 3.4-something.
 *  2. **DV01 matches a finite difference this file computes itself.** The resolver publishes
 *     `swap.ois@1.0.0`'s *analytic* parallel-shift derivative. This test recomputes the same
 *     quantity numerically — it reads the build's nodes out of `curve_builds`, shifts the
 *     continuous zero curve by ±1 bp, reprices through the engine and central-differences — so the
 *     two derivations have nothing in common but the curve. A sign error, a `notional` scaling
 *     mistake or a fixed/float mix-up breaks the agreement immediately.
 *  3. **The schedule honours SIFMA.** Every accrual end and every payment date is checked against
 *     the **database-materialised** calendar (REF-06), not against the rule set the engine happens
 *     to hold, and the payment lag is checked as *two business days*, not two calendar days. A
 *     schedule rolled on raw calendar days is wrong even when the discounting is right, and it is
 *     wrong invisibly: the cashflows still discount, the NPV still comes out near zero, and only
 *     the dates give it away.
 *
 * No seed is assumed (WP-15 owns it) and nothing depends on a literal instrument id: every row
 * lives inside `withTxDb()`'s transaction.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PayloadMeta } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import type { DfPoint } from '@terminal/core/analytics/curve/interp';
import type { OisSwapInputs } from '@terminal/core/analytics/swap/ois';
import { oisSwapEngine } from '@terminal/core/analytics/swap/ois';
import type { Calendar } from '@terminal/core/calendars/calendar';
import { daysBetween, nextBusinessDay } from '@terminal/core/calendars/calendar';
import { SIFMA } from '@terminal/core/calendars/sifma';
import { SWPM } from '@terminal/core/functions/manifests/SWPM';
import type { SwpmLeg, SwpmPayload } from '@terminal/core/functions/manifests/SWPM';

import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as SWPMModule from '../../../src/functions/SWPM/resolve.js';
import { CalendarRepository, materialiseCalendar } from '../../../src/refdata/calendars.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, createWebSession, GOLDEN_CAPTURE_MS } from '../ws/helpers.js';
import { expectGolden, idToken } from './golden.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VINTAGE = '2026-09-15T10:00:00.000Z';
const GOLDEN_NAME = 'SWPM.default.json';
const CURVE_DATE = '2026-09-14';
const NOTIONAL = 10_000_000;
const ONE_BP = 1e-4;

const REGISTRY = new FunctionRegistry([SWPM]);
 
const MODULES: Record<string, FunctionServerModule<any, any>> = { SWPM: SWPMModule };

const t: TestDb = withTxDb();

/**
 * The par OIS quotes. **Whole years only**: `curve.ois.bootstrap` schedules each quote as an
 * annual-pay swap and refuses anything that is not a whole number of fixed periods.
 */
const OIS_QUOTES: readonly [string, number, number][] = [
  ['1Y', 365, 3.42],
  ['2Y', 730, 3.38],
  ['3Y', 1096, 3.4],
  ['5Y', 1826, 3.45],
  ['7Y', 2557, 3.52],
  ['10Y', 3653, 3.7],
  ['30Y', 10958, 4.05],
];
const ON_FIXING_PCT = 3.62;

/** The Treasury par curve, for the swap spread. */
const UST_PAR_POINTS: readonly [string, number, number][] = [
  ['2Y', 730, 3.76],
  ['5Y', 1826, 3.81],
  ['10Y', 3653, 4.07],
  ['30Y', 10958, 4.66],
];

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  calendar: Calendar;
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
  tenor: string;
  tenorDays: number;
  quoteType: string;
  value: number;
  provenanceId: number;
}): Promise<void> {
  await t.client.query(
    `INSERT INTO curve_points (curve_id, curve_date, tenor, quote_type, vintage_at, tenor_days,
                               value, is_latest, provenance_id)
     VALUES ($1, $2::date, $3, $4, $5::timestamptz, $6, $7, true, $8)`,
    [
      spec.curveId,
      CURVE_DATE,
      spec.tenor,
      spec.quoteType,
      VINTAGE,
      spec.tenorDays,
      spec.value,
      spec.provenanceId,
    ],
  );
}

beforeEach(async () => {
  await ensureLicences();
  await materialiseCalendar(t.db, SIFMA, { fromYear: 2026, toYear: 2060 });

  const session = await createWebSession(t, { email: `swpm-${randomUUID()}@demo.invalid` });
  await grantEverySource(session.firmId, session.userId);

  const nyfedProv = await bootstrapProvenance(t, 'nyfed.rates', 'swpm-nyfed');
  await t.client.query(
    `INSERT INTO rate_fixings (rate_code, effective_date, vintage_at, rate, revision_indicator,
                               is_latest, provenance_id)
     VALUES ('SOFR', $1::date, $2::timestamptz, $3, '', true, $4)`,
    [CURVE_DATE, VINTAGE, ON_FIXING_PCT, nyfedProv],
  );

  const oisProv = await bootstrapProvenance(t, 'internal.derived', 'swpm-ois');
  const parProv = await bootstrapProvenance(t, 'treasury.yieldcurve', 'swpm-par');

  await seedCurve({
    curveId: 'SOFR_OIS',
    name: 'USD SOFR OIS (proxied)',
    kind: 'ois',
    dayCount: 'ACT/360',
    compounding: 'simple',
    sourceId: 'internal.derived',
  });
  await seedCurve({
    curveId: 'UST_PAR',
    name: 'US Treasury par yield curve',
    kind: 'par',
    dayCount: 'ACT/ACT',
    compounding: 'semiannual',
    sourceId: 'treasury.yieldcurve',
  });

  await seedPoint({
    curveId: 'SOFR_OIS',
    tenor: 'ON',
    tenorDays: 1,
    quoteType: 'fixing',
    value: ON_FIXING_PCT,
    provenanceId: oisProv,
  });
  for (const [tenor, tenorDays, value] of OIS_QUOTES) {
    await seedPoint({
      curveId: 'SOFR_OIS',
      tenor,
      tenorDays,
      quoteType: 'ois_rate',
      value,
      provenanceId: oisProv,
    });
  }
  for (const [tenor, tenorDays, value] of UST_PAR_POINTS) {
    await seedPoint({
      curveId: 'UST_PAR',
      tenor,
      tenorDays,
      quoteType: 'par_yield',
      value,
      provenanceId: parProv,
    });
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
    calendar: await new CalendarRepository(t.db, { fromYear: 2026, toYear: 2060 }).require('SIFMA'),
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: SwpmPayload;
  meta: PayloadMeta;
}

async function runSWPM(params: Record<string, unknown> = {}): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/SWPM/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

const legOf = (payload: SwpmPayload, kind: 'fixed' | 'float'): SwpmLeg => {
  const leg = payload.legs.find((l) => l.kind === kind);
  expect(leg, `${kind} leg is missing`).toBeDefined();
  return leg!;
};

/** The bootstrapped node set the resolver priced on, read straight out of `curve_builds`. */
async function storedNodes(): Promise<DfPoint[]> {
  const res = await t.client.query<{ nodes: { t: number; df: number }[] }>(
    `SELECT nodes FROM curve_builds
      WHERE curve_id = 'SOFR_OIS' AND curve_date = $1::date
      ORDER BY build_id DESC LIMIT 1`,
    [CURVE_DATE],
  );
  expect(res.rowCount, 'no SOFR_OIS build was persisted').toBe(1);
  return res.rows[0]!.nodes.map((n) => ({ t: n.t, df: n.df }));
}

/**
 * Value the same ticket on a curve whose continuous zero rates are shifted by `bp` basis points.
 *
 * Written from the engine's public inputs rather than from anything the resolver does, so that the
 * comparison below is a genuine second derivation of the same number.
 */
function valueShifted(
  nodes: readonly DfPoint[],
  payload: SwpmPayload,
  bp: number,
  fixedRate: number,
): number {
  const shifted: DfPoint[] = nodes.map((n) => ({
    t: n.t,
    df: n.df * Math.exp(-bp * ONE_BP * n.t),
  }));
  const inputs: OisSwapInputs = {
    curveDate: CURVE_DATE,
    curve: { curveId: 'SOFR_OIS', interpolation: 'monotone_convex', points: shifted },
    tenor: payload.trade.tenor,
    effectiveDate: payload.trade.effective,
    fixedRate,
    notional: payload.trade.notional,
    payReceive: payload.trade.side,
    fixedFrequency: 1,
    settlementDays: 2,
    businessDayConvention: 'modified_following',
    calendar: 'SIFMA',
    paymentLagDays: 2,
  };
  return oisSwapEngine(inputs, GOLDEN_ISO).outputs.pv;
}

/** `buildId` is the one sequence-allocated number in a SWPM payload. */
const ID_KEYS: ReadonlySet<string> = new Set(['buildId']);

function normalise(payload: SwpmPayload): unknown {
  const tokens = new Map<number, string>(
    payload.curve.buildId === null ? [] : [[payload.curve.buildId, '<BUILD>']],
  );
  return JSON.parse(
    JSON.stringify(payload, (key, value: unknown) => idToken(key, value, ID_KEYS, tokens)),
  ) as unknown;
}

describe('SWPM — a USD SOFR OIS on the SOFR_OIS build', () => {
  it('solves a par rate that zeroes the NPV', async () => {
    const { data } = await runSWPM();

    expect(data.variant).toBe('default');
    expect(data.trade.fixedRateSource).toBe('par');
    expect(data.trade.tenor).toBe('5Y');
    expect(data.trade.side).toBe('pay');
    expect(data.trade.notional).toBe(NOTIONAL);

    const par = data.results.parRatePct.v as number;
    expect(par).toBeGreaterThan(3);
    expect(par).toBeLessThan(4);
    // The contract rate IS the par rate, and the swap is worth nothing at it.
    expect(data.trade.fixedRate.v).toBe(par);
    expect(data.results.fixedRatePct.v).toBe(par);
    expect(Math.abs(data.results.npv.v as number)).toBeLessThan(1e-6 * NOTIONAL);
    expect(data.results.breakEvenRatePct.v).toBe(par);
    // At par the two legs are worth the same to the last cent.
    expect(data.results.pvFixed.v as number).toBeCloseTo(data.results.pvFloat.v as number, 6);
    expect(Math.abs(data.results.marketValuePctNotional.v as number)).toBeLessThan(1e-6);

    // A rate the user types is not the par rate, and the NPV moves the way the side says it should:
    // a payer of an above-par fixed rate is out of the money.
    const off = await runSWPM({ fixedRate: 3.75 });
    expect(off.data.trade.fixedRateSource).toBe('user');
    expect(off.data.trade.fixedRate.v).toBe(3.75);
    expect(off.data.results.parRatePct.v as number).toBeCloseTo(par, 9);
    expect(off.data.results.npv.v as number).toBeLessThan(0);

    const receive = await runSWPM({ fixedRate: 3.75, side: 'receive' });
    expect(receive.data.results.npv.v as number).toBeCloseTo(-(off.data.results.npv.v as number), 6);
  });

  it('reports a DV01 that matches a finite difference computed here', async () => {
    const { data } = await runSWPM({ fixedRate: 3.75 });
    const nodes = await storedNodes();
    const fixedRate = data.trade.fixedRate.v as number;

    const up = valueShifted(nodes, data, 1, fixedRate);
    const down = valueShifted(nodes, data, -1, fixedRate);
    const base = valueShifted(nodes, data, 0, fixedRate);

    // The reprice reproduces the resolver's own NPV first — otherwise the difference below would
    // be a difference of two different swaps.
    expect(base).toBeCloseTo(data.results.npv.v as number, 6);

    const finiteDifference = (up - down) / 2;
    const reported = data.results.dv01.v as number;
    expect(reported).not.toBe(0);
    // Analytic derivative vs central difference: they agree to well under a hundredth of a
    // basis point of notional.
    expect(Math.abs(reported - finiteDifference) / Math.abs(finiteDifference)).toBeLessThan(1e-4);

    // A payer of fixed gains when rates rise; the sign is the claim, not an artefact.
    expect(reported).toBeGreaterThan(0);
    const receive = await runSWPM({ fixedRate: 3.75, side: 'receive' });
    expect(receive.data.results.dv01.v as number).toBeCloseTo(-reported, 6);

    // The derived presentations are the same number in other units.
    expect(data.results.dv01Per1mm.v as number).toBeCloseTo((reported * 1e6) / NOTIONAL, 9);
    expect(data.results.effectiveDurationYears.v as number).toBeCloseTo(
      reported / (NOTIONAL * ONE_BP),
      9,
    );

    // The annuity PV01 is the fixed leg's own sensitivity and is close to, but not the same as,
    // the ticket DV01.
    const annuity = data.results.annuityPv01.v as number;
    expect(annuity).toBeGreaterThan(0);
    expect(Math.abs(annuity - Math.abs(reported)) / annuity).toBeLessThan(0.05);

    // Key-rate risk partitions the parallel shift: the kernels sum to one over the node axis.
    expect(data.results.keyRateDurations.map((k) => k.tenor)).toEqual(['2Y', '5Y', '10Y', '30Y']);
    const krdSum = data.results.keyRateDurations.reduce((sum, k) => sum + k.dv01, 0);
    expect(Math.abs(krdSum - reported) / Math.abs(reported)).toBeLessThan(0.02);
    for (const k of data.results.keyRateDurations) {
      expect(k.krd).toBeCloseTo(k.dv01 / (NOTIONAL * ONE_BP), 9);
    }
    // A 5Y swap's risk sits at the 5Y key rate and essentially nowhere else.
    const five = data.results.keyRateDurations.find((k) => k.tenor === '5Y')!;
    expect(Math.abs(five.dv01) / Math.abs(reported)).toBeGreaterThan(0.8);
  });

  it('rolls the schedule on the materialised SIFMA calendar', async () => {
    const { data } = await runSWPM();
    const cal = env.calendar;

    // T+2 spot from the valuation date, on business days.
    expect(data.trade.valuationDate).toBe('2026-09-15');
    expect(data.trade.tradeDate).toBe('2026-09-15');
    let spot = data.trade.valuationDate;
    for (let i = 0; i < 2; i += 1) spot = nextBusinessDay(cal, spot);
    expect(data.trade.effective).toBe(spot);

    for (const leg of data.legs) {
      expect(leg.periods).toHaveLength(5); // annual, 5Y
      let previousEnd = data.trade.effective;
      for (const p of leg.periods) {
        expect(p.start, `${leg.kind} period ${String(p.n)} start`).toBe(previousEnd);
        // Every rolled date is a business day on the calendar the database holds.
        expect(cal.isBusinessDay(p.end), `${leg.kind} end ${p.end}`).toBe(true);
        expect(cal.isBusinessDay(p.paymentDate), `${leg.kind} pay ${p.paymentDate}`).toBe(
          true,
        );
        // The payment lag is two BUSINESS days, not two calendar days.
        let expected = p.end;
        for (let i = 0; i < 2; i += 1) expected = nextBusinessDay(cal, expected);
        expect(p.paymentDate, `${leg.kind} payment lag from ${p.end}`).toBe(expected);
        // ACT/360 on the adjusted dates.
        expect(p.days).toBe(daysBetween(p.start, p.end));
        expect(p.accrualFactor).toBeCloseTo(p.days / 360, 12);
        previousEnd = p.end;
      }
      expect(leg.periods[leg.periods.length - 1]!.end).toBe(data.trade.maturity);
    }

    expect(cal.isBusinessDay(data.trade.maturity)).toBe(true);

    // The float leg compounds over business days, and every one of them is projected off the curve
    // (this build values spot- and forward-starting swaps, so nothing is realised).
    for (const p of legOf(data, 'float').periods) {
      expect(p.realisedDays).toBe(0);
      expect(p.projectedDays).toBeGreaterThan(200);
      expect(p.isCurrent).toBe(false);
    }
    expect(data.fixing.usedForRealised).toBe(false);
    expect(data.fixing.rate.v).toBe(ON_FIXING_PCT);
  });

  it('always carries the proxy caveats, the swap spread and the conventions block', async () => {
    const { data, meta } = await runSWPM();

    expect(data.curve.caveats).toEqual(['PROXY_CURVE', 'NO_OIS_SWAP_QUOTES_SOURCE']);
    expect(data.curve.id).toBe('SOFR_OIS');
    expect(data.curve.date).toBe(CURVE_DATE);
    expect(data.curve.method).toBe('ois_bootstrap');
    expect(data.conventions.calendarId).toBe('SIFMA');
    expect(data.conventions.paymentLagDays).toBe(2);
    expect(data.conventions.fixedDayCount).toBe('ACT/360');
    expect(data.conventions.floatDayCount).toBe('ACT/360');

    // The spread is against the matching Treasury tenor, in basis points.
    expect(data.results.spreads).not.toBeNull();
    expect(data.results.spreads!.treasuryTenor).toBe('5Y');
    expect(data.results.spreads!.treasuryYieldPct.v).toBe(3.81);
    expect(data.results.spreads!.swapSpreadBp.v as number).toBeCloseTo(
      ((data.results.fixedRatePct.v as number) - 3.81) * 100,
      9,
    );

    // A per-leg curve DV01 is not computed by subtraction: the float leg says so. It says it as a
    // declined cell — `st:'na'` with no reason code — and not with `NOT_IN_UNIVERSE`, which would
    // claim the number lies outside the served universe rather than that the resolver withheld it.
    expect(legOf(data, 'float').dv01.v).toBeNull();
    expect(legOf(data, 'float').dv01.st).toBe('na');
    expect(legOf(data, 'float').dv01.r).toBeUndefined();
    expect(
      meta.unavailable.some((u) => u.field === 'legs.dv01'),
      JSON.stringify(meta.unavailable),
    ).toBe(true);

    // Every engine that produced a number on this page is named with its inputs hash.
    expect(meta.engines.some((e) => e.name === 'swap.ois' && e.version === '1.0.0')).toBe(true);
    expect(meta.engines.some((e) => e.name === 'curve.ois.bootstrap')).toBe(true);
    for (const e of meta.engines) expect(e.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.engines.some((e) => e.name === 'swap.ois')).toBe(true);
  });

  it('reproduces byte-identical numbers across two runs (ANAL-08)', async () => {
    const first = await runSWPM();
    const second = await runSWPM();
    expect(second.meta.engines).toEqual(first.meta.engines);
    expect(JSON.stringify(second.data)).toBe(JSON.stringify(first.data));

    const cells: [string, { v: unknown; provIdx: number }][] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((item, i) => {
          walk(item, `${path}[${String(i)}]`);
        });
        return;
      }
      const record = node as Record<string, unknown>;
      if ('v' in record && 'st' in record && 'provIdx' in record) {
        cells.push([path, record as { v: unknown; provIdx: number }]);
      }
      for (const [key, value] of Object.entries(record)) {
        walk(value, path === '' ? key : `${path}.${key}`);
      }
    };
    walk(first.data, '');
    expect(cells.length).toBeGreaterThan(50);
    for (const [path, cell] of cells) {
      if (typeof cell.v === 'number') expect(cell.provIdx, path).toBeGreaterThanOrEqual(0);
    }
  });

  it('matches the committed golden payload', async () => {
    const { data } = await runSWPM();
    expectGolden(GOLDEN_NAME, normalise(data));
  });
});
