/**
 * `test/integration/functions/CRVF.test.ts` — WP-11's acceptance row for `CRVF`
 * ("a build reprices its inputs; the same inputs produce the same `inputs_hash` and reuse the
 * `curve_builds` row; two dates compare").
 *
 * Those three are the whole claim of ANAL-02/ANAL-08, and each one fails silently otherwise:
 *
 *  1. **A bootstrap that does not reprice its own inputs is not a bootstrap.** Every par quote the
 *     build consumed must price to exactly 100 on the curve it produced (`parBondPrice`, the same
 *     pure function the engine solved against), and every bill quote must return its own discount
 *     factor. A node set that is merely monotone looks right on a chart and is wrong everywhere a
 *     number is read off it.
 *  2. **The cache is keyed on the inputs hash, not on the date.** Running the same screen twice
 *     must return the same `buildId`, the same `inputsHash` and leave exactly one `curve_builds`
 *     row: a second row for identical inputs means the hash is a function of something that is not
 *     the inputs (a clock, a row order), and the "reproducible build" claim is void.
 *  3. **Two dates compare in basis points**, and a comparison date with nothing stored is dropped
 *     with a reason rather than drawn as a copy of the current curve.
 *
 * Two further tests cover the short end. The Treasury publishes fourteen par tenors and
 * `ingest/jobs/treasuryCurves.ts` writes all of them; five — 1M, 1.5M, 2M, 3M, 4M — mature before
 * the first semiannual coupon date. `curve.bootstrap` used to treat every `par_yield` as a par
 * coupon bond and raise on those, which is a build that never succeeds on this system's own
 * production data; they are money-market points now, and the first of the two tests seeds the whole
 * published grid so the realistic case is pinned rather than avoided. The second keeps the degraded
 * path honest with a tenor that genuinely cannot be bootstrapped (`9M`, more than one coupon period
 * but not a whole number of them): the screen keeps the published inputs instead of answering 500.
 *
 * No seed is assumed and nothing asserts on a literal instrument id.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PayloadMeta } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { SIFMA } from '@terminal/core/calendars/sifma';
import { makeCurve } from '@terminal/core/analytics/curve/curve';
import { parBondPrice, parScheduleOf } from '@terminal/core/analytics/curve/bootstrap';
import { CRVF } from '@terminal/core/functions/manifests/CRVF';
import type { CrvfPayload } from '@terminal/core/functions/manifests/CRVF';

import * as CRVFModule from '../../../src/functions/CRVF/resolve.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import { materialiseCalendar } from '../../../src/refdata/calendars.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, createWebSession, GOLDEN_CAPTURE_MS } from '../ws/helpers.js';
import { expectGolden, idToken, subjectToken } from './golden.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';

const REGISTRY = new FunctionRegistry([CRVF]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { CRVF: CRVFModule };

const t: TestDb = withTxDb();

const CURVE_DATE = '2026-09-14';
const PRIOR_DATE = '2026-09-11';
const VINTAGE = '2026-09-15T10:00:00.000Z';

/**
 * `[tenor, tenorDays, 09-14 par yield %, 09-11 par yield %]` — six months and beyond, the tenors
 * that are a whole number of semiannual coupon periods.
 *
 * The five shorter published tenors are seeded by the test that pins them ({@link SHORT_PAR_POINTS})
 * rather than here, so that the golden and the `inputs_hash` this file shares with SRCH's keep
 * pinning the coupon-only build they have always pinned.
 */
const PAR_POINTS: readonly [string, number, number, number][] = [
  ['6M', 182, 3.95, 3.93],
  ['1Y', 365, 3.9, 3.88],
  ['2Y', 730, 3.76, 3.74],
  ['3Y', 1096, 3.78, 3.75],
  ['5Y', 1826, 3.81, 3.78],
  ['7Y', 2557, 3.95, 3.92],
  ['10Y', 3653, 4.07, 4.03],
  ['20Y', 7305, 4.55, 4.5],
  ['30Y', 10958, 4.66, 4.62],
];

/**
 * `[tenor, tenorDays, 09-14 par yield %]` — the five published tenors that mature **before** the
 * first semiannual coupon date, exactly as `providers/treasury/parse.ts#PAR_TENORS` spells them
 * (`1.5M` is the one label that cannot be read as whole months, which is why the quote carries its
 * days through to the engine).
 */
const SHORT_PAR_POINTS: readonly [string, number, number][] = [
  ['1M', 30, 4.02],
  ['1.5M', 45, 4.0],
  ['2M', 61, 3.99],
  ['3M', 91, 3.98],
  ['4M', 122, 3.97],
];

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  parProv: number;
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
  curveDate: string;
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
      spec.curveDate,
      spec.tenor,
      spec.quoteType,
      VINTAGE,
      spec.tenorDays,
      spec.value,
      spec.provenanceId,
    ],
  );
}

async function buildRowCount(curveId: string, curveDate: string): Promise<number> {
  const res = await t.client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM curve_builds WHERE curve_id = $1 AND curve_date = $2::date`,
    [curveId, curveDate],
  );
  return Number(res.rows[0]?.n ?? '0');
}

beforeEach(async () => {
  await ensureLicences();
  await materialiseCalendar(t.db, SIFMA, { fromYear: 2026, toYear: 2027 });

  const session = await createWebSession(t, { email: `crvf-${randomUUID()}@demo.invalid` });
  await grantEverySource(session.firmId, session.userId);

  const parProv = await bootstrapProvenance(t, 'treasury.yieldcurve', 'crvf-par');
  await seedCurve({
    curveId: 'UST_PAR',
    name: 'US Treasury par yield curve',
    kind: 'par',
    dayCount: 'ACT/ACT',
    compounding: 'semiannual',
    sourceId: 'treasury.yieldcurve',
  });
  for (const [tenor, tenorDays, value, prior] of PAR_POINTS) {
    await seedPoint({
      curveId: 'UST_PAR',
      curveDate: CURVE_DATE,
      tenor,
      tenorDays,
      quoteType: 'par_yield',
      value,
      provenanceId: parProv,
    });
    await seedPoint({
      curveId: 'UST_PAR',
      curveDate: PRIOR_DATE,
      tenor,
      tenorDays,
      quoteType: 'par_yield',
      value: prior,
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

  env = { harness, app: harness.app, clock, cookie: session.cookie, knownAt, parProv };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: CrvfPayload;
  meta: PayloadMeta;
}

async function runCRVF(params: Record<string, unknown> = {}): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/CRVF/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

/** The one key of a CRVF payload that holds a sequence-allocated id. */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId']);

function normalise(payload: CrvfPayload): unknown {
  const tokens = new Map<number, string>();
  const json = JSON.stringify(payload, (key, value: unknown) => {
    // `buildId` is a `bigserial`; the *hash* is what pins the build, and it is asserted directly.
    if (key === 'buildId' && typeof value === 'number' && value > 0) return '<BUILD>';
    if (typeof value === 'string') return subjectToken(value, tokens);
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

describe('CRVF — the build is the product', () => {
  it('reprices every input it consumed', async () => {
    const { data, meta } = await runCRVF();
    expect(data.variant).toBe('default');
    expect(data.curve.date).toBe(CURVE_DATE);
    expect(data.build.method).toBe('bills+par_bootstrap');
    expect(data.build.engine?.name).toBe('curve.bootstrap');
    expect(data.build.engine?.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.engines.map((e) => e.name)).toContain('curve.bootstrap');

    // Rebuild the curve from the payload's own nodes — exactly what `curve_builds.nodes` stores —
    // and reprice each published par quote on it. A par bond is worth 100 by definition.
    const curve = makeCurve({
      curveId: data.curve.id,
      curveDate: data.curve.date,
      dayCount: 'ACT/ACT',
      compounding: 'semiannual',
      interpolation: 'monotone_convex',
      points: data.nodes.map((node) => ({ t: node.t, df: node.df! })),
    });
    for (const input of data.inputs) {
      const schedule = parScheduleOf(data.curve.date, input.tenor, 2, 'ACT/ACT');
      const price = parBondPrice(curve, schedule, (input.value.v as number) / 100);
      // Eight decimals: the bootstrap solves to a 1e-12 residual, so anything looser here would
      // hide a node whose `t` is a day out — which is precisely the defect this assertion caught.
      expect(price, `${input.tenor} must reprice to par on its own build`).toBeCloseTo(100, 8);
    }

    // The node table is a curve: discount factors strictly decreasing, zeros finite.
    for (let i = 1; i < data.nodes.length; i += 1) {
      expect(data.nodes[i]!.df!).toBeLessThan(data.nodes[i - 1]!.df!);
    }
    // The par column reproduces the published quote at every input tenor (§CRVF node table).
    for (const node of data.nodes) {
      const input = data.inputs.find((row) => row.tenor === node.tenor);
      expect(node.isInput).toBe(true);
      expect(node.par!).toBeCloseTo(input?.value.v as number, 6);
    }
  });

  it('reuses the stored build rather than writing a second row for the same inputs', async () => {
    expect(await buildRowCount('UST_PAR', CURVE_DATE)).toBe(0);

    const first = await runCRVF();
    expect(first.data.build.cached).toBe(false);
    expect(await buildRowCount('UST_PAR', CURVE_DATE)).toBe(1);

    const second = await runCRVF();
    expect(second.data.build.cached).toBe(true);
    expect(second.data.build.buildId).toBe(first.data.build.buildId);
    expect(second.data.build.engine?.inputsHash).toBe(first.data.build.engine?.inputsHash);
    expect(await buildRowCount('UST_PAR', CURVE_DATE)).toBe(1);

    // Same inputs, same payload — the ANAL-08 claim, asserted rather than assumed. `build.cached`
    // is the one field that legitimately differs: it records where this run's curve came from, not
    // what the curve is.
    expect(normalise({ ...second.data, build: { ...second.data.build, cached: false } })).toEqual(
      normalise(first.data),
    );

    // A different interpolation is a different build, not a silent re-use of this one.
    const other = await runCRVF({ interpolation: 'linear_zero' });
    expect(other.data.build.buildId).not.toBe(first.data.build.buildId);
    expect(await buildRowCount('UST_PAR', CURVE_DATE)).toBe(2);
  });

  it('compares two dates in basis points and drops a date with nothing stored', async () => {
    const { data } = await runCRVF({ compare: [PRIOR_DATE, '2020-01-01'] });
    expect(data.compare).toHaveLength(1);
    expect(data.compare[0]?.date).toBe(PRIOR_DATE);

    const tenYear = data.changes.find((change) => change.tenor === '10Y');
    expect(tenYear?.vsCompare[0]?.date).toBe(PRIOR_DATE);
    // 4.07 − 4.03 = 4 bp on the published quotes, and the built par rates agree.
    const change = tenYear?.vsCompare[0];
    expect(change?.parBp ?? Number.NaN).toBeCloseTo(4, 6);
    expect(change?.zeroBp ?? Number.NaN).toBeGreaterThan(0);

    const { data: served } = await runCRVF({ date: PRIOR_DATE });
    expect(served.curve.date).toBe(PRIOR_DATE);
    expect(served.curve.requestedDate).toBe(PRIOR_DATE);
    expect(served.curve.availableDates).toEqual([CURVE_DATE, PRIOR_DATE]);
  });

  it('bootstraps the whole published Treasury par grid, the five short tenors included', async () => {
    // This is what `ingest/jobs/treasuryCurves.ts` actually writes: fourteen par tenors, five of
    // them maturing before the first semiannual coupon date. The bootstrap used to raise on them
    // ("a 1-month tenor is not a whole number of 2/yr coupon periods"), which took the whole build
    // down and left CRVF, YAS's curve mode, SRCH's analytics and GC on terms only for every day of
    // production data. They are money-market points now, and this test is the realistic case rather
    // than a seed that avoids it.
    for (const [tenor, tenorDays, value] of SHORT_PAR_POINTS) {
      await seedPoint({
        curveId: 'UST_PAR',
        curveDate: CURVE_DATE,
        tenor,
        tenorDays,
        quoteType: 'par_yield',
        value,
        provenanceId: env.parProv,
      });
    }

    const { data, meta } = await runCRVF();
    expect(data.build.caveats).not.toContain('BOOTSTRAP_UNAVAILABLE');
    expect(data.build.method).toBe('bills+par_bootstrap');
    expect(data.build.buildId).toBeGreaterThan(0);
    expect(data.inputs).toHaveLength(SHORT_PAR_POINTS.length + PAR_POINTS.length);
    expect(data.inputs.map((row) => row.tenor)).toEqual([
      '1M',
      '1.5M',
      '2M',
      '3M',
      '4M',
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

    const curve = makeCurve({
      curveId: data.curve.id,
      curveDate: data.curve.date,
      dayCount: 'ACT/ACT',
      compounding: 'semiannual',
      interpolation: 'monotone_convex',
      points: data.nodes.map((node) => ({ t: node.t, df: node.df! })),
    });
    const shortTenors = new Set(SHORT_PAR_POINTS.map(([tenor]) => tenor));
    for (const input of data.inputs) {
      const quote = (input.value.v as number) / 100;
      const node = data.nodes.find((row) => row.tenor === input.tenor);
      expect(node, `${input.tenor} must be a node`).toBeDefined();
      if (shortTenors.has(input.tenor)) {
        // A stub is one payment of `1 + y·t` at maturity, bought for 1: simple interest, and the
        // node is known outright rather than solved, so it holds to floating point.
        expect(node!.df!, `${input.tenor} is a money-market point`).toBeCloseTo(
          1 / (1 + quote * node!.t),
          12,
        );
        // §CRVF deviation 2: no bond has a 1-month coupon schedule, so the par column stays blank
        // instead of printing a money-market rate where a desk reads bond yields.
        expect(node!.par).toBeNull();
        expect(node!.zero).not.toBeNull();
      } else {
        const schedule = parScheduleOf(data.curve.date, input.tenor, 2, 'ACT/ACT');
        expect(
          parBondPrice(curve, schedule, quote),
          `${input.tenor} must still reprice to par with the short end in the build`,
        ).toBeCloseTo(100, 8);
      }
    }
    // The short end did not break monotonicity: a discount curve falls.
    for (let i = 1; i < data.nodes.length; i += 1) {
      expect(data.nodes[i]!.df!).toBeLessThan(data.nodes[i - 1]!.df!);
    }
    expect(
      meta.unavailable.some((row) => row.field === 'nodes.par' && row.reason === 'NOT_APPLICABLE'),
      JSON.stringify(meta.unavailable),
    ).toBe(true);
  });

  it('degrades with a reason when a published tenor cannot be bootstrapped at all', async () => {
    // A tenor of more than one coupon period that is not a whole number of them is a different
    // instrument, not a stub: a 9-month par bond pays a coupon in between, and simple interest
    // would price something else. The bootstrap still raises, and the screen must keep the
    // published inputs rather than answer 500.
    await seedPoint({
      curveId: 'UST_PAR',
      curveDate: CURVE_DATE,
      tenor: '9M',
      tenorDays: 273,
      quoteType: 'par_yield',
      value: 3.94,
      provenanceId: env.parProv,
    });

    const { data, meta } = await runCRVF();
    expect(data.build.caveats).toContain('BOOTSTRAP_UNAVAILABLE');
    expect(data.build.method).toBe('none');
    expect(data.build.engine).toBeNull();
    expect(data.build.buildId).toBe(-1);
    // The published inputs survive, the 9M quote among them; the derived columns do not.
    expect(data.inputs.map((row) => row.tenor)).toContain('9M');
    expect(data.inputs.every((row) => typeof row.value.v === 'number')).toBe(true);
    expect(data.nodes.every((node) => node.par === null && node.df === null)).toBe(true);
    const note = meta.unavailable.find((row) => row.field === 'nodes');
    expect(note?.reason).toBe('NO_SOURCE');
    expect(note?.detail).toContain('9-month tenor is not a whole number of 2/yr coupon periods');
  });

  it('refuses a typed date with no curve on or before it', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/CRVF/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { date: '2020-01-01' },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; details?: { field?: string } } }>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details?.field).toBe('date');
  });

  it('matches the committed golden', async () => {
    const { data } = await runCRVF({ compare: [PRIOR_DATE] });
    expectGolden('CRVF.default.json', normalise(data));
  });
});
