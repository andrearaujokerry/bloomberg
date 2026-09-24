/**
 * `test/integration/functions/GC.test.ts` — WP-11's `GC`, the time view of the curves CRVF builds.
 *
 * GC's whole risk is *fabrication*: every one of its numbers is a difference between two stored
 * rows, and the tempting shortcut at each step invents one. So this file asserts the four places a
 * fabricated number would appear:
 *
 *  1. **A relative comparison resolves to a stored date or is dropped.** `PREV` and `1W` resolve
 *     against `curve.availableDates`; `YTD` against nine stored dates resolves to nothing, and the
 *     entry is dropped with a reason and the `CURVE_DATES_ONLY` caveat — never silently drawn as
 *     another copy of the current curve.
 *  2. **A change is `(current − snapshot) × 100`, and `na` when either side is absent.**
 *  3. **A spread with a missing leg is `na` with the leg named**, not the leg that is present.
 *  4. **History is stored history.** The mapped `econ_series` answers for the 10Y; a tenor with no
 *     series falls back to its own `curve_points` and says the range is truncated; a spread series
 *     is computed on the date intersection of its legs, so a date present in only one leg is
 *     skipped rather than filled.
 *
 * A fifth assertion is structural: GC never bootstraps. After a full run, `curve_builds` is still
 * empty and every snapshot's `buildId` is `null` — a chart that writes to the database would be a
 * defect however right its numbers were.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PayloadMeta } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { SIFMA } from '@terminal/core/calendars/sifma';
import { GC } from '@terminal/core/functions/manifests/GC';
import type { GcPayload } from '@terminal/core/functions/manifests/GC';

import * as GCModule from '../../../src/functions/GC/resolve.js';
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

const REGISTRY = new FunctionRegistry([GC]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { GC: GCModule };

const t: TestDb = withTxDb();

/** Four stored curve dates: the served one, the session before it, and two further back. */
const DATES = ['2026-09-14', '2026-09-11', '2026-09-08', '2026-09-04'] as const;
const VINTAGE = '2026-09-15T10:00:00.000Z';

/** `[tenor, tenorDays, par yield on each of the four dates]`. */
const PAR_POINTS: readonly [string, number, readonly [number, number, number, number]][] = [
  ['3M', 91, [3.99, 3.97, 3.96, 3.94]],
  ['2Y', 730, [3.76, 3.74, 3.72, 3.7]],
  ['5Y', 1826, [3.81, 3.78, 3.76, 3.74]],
  ['10Y', 3653, [4.07, 4.03, 4.01, 3.99]],
  ['30Y', 10958, [4.66, 4.62, 4.6, 4.58]],
];

/** The 10Y's long history, as `econ_observations` stores it (the DGS10 series of §GC's map). */
const DGS10_OBS: readonly [string, number][] = [
  ['2026-09-04', 3.99],
  ['2026-09-08', 4.01],
  ['2026-09-09', 4.02],
  ['2026-09-10', 4.04],
  ['2026-09-11', 4.03],
  ['2026-09-14', 4.07],
];

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
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

beforeEach(async () => {
  await ensureLicences();
  await materialiseCalendar(t.db, SIFMA, { fromYear: 2026, toYear: 2027 });

  const session = await createWebSession(t, { email: `gc-${randomUUID()}@demo.invalid` });
  await grantEverySource(session.firmId, session.userId);

  const parProv = await bootstrapProvenance(t, 'treasury.yieldcurve', 'gc-par');
  const fredProv = await bootstrapProvenance(t, 'fred.csv', 'gc-fred');

  await t.client.query(
    `INSERT INTO curves (curve_id, name, currency, kind, day_count, compounding, source_id,
                         default_interpolation)
     VALUES ('UST_PAR', 'US Treasury par yield curve', 'USD', 'par', 'ACT/ACT', 'semiannual',
             'treasury.yieldcurve', 'monotone_convex')
     ON CONFLICT (curve_id) DO NOTHING`,
  );
  for (const [tenor, tenorDays, values] of PAR_POINTS) {
    for (let i = 0; i < DATES.length; i += 1) {
      // The 3M point is deliberately absent from the oldest date: an H.15 `ND` day, and the reason
      // the change column has to have an `na` branch.
      if (tenor === '3M' && DATES[i] === '2026-09-04') continue;
      await t.client.query(
        `INSERT INTO curve_points (curve_id, curve_date, tenor, quote_type, vintage_at, tenor_days,
                                   value, is_latest, provenance_id)
         VALUES ('UST_PAR', $1::date, $2, 'par_yield', $3::timestamptz, $4, $5, true, $6)`,
        [DATES[i], tenor, VINTAGE, tenorDays, values[i], parProv],
      );
    }
  }

  const series = await t.client.query<{ series_id: string }>(
    `INSERT INTO econ_series (series_code, source_id, provider_code, name, units, frequency,
                              seasonal_adj, country, decimals, first_obs_date, last_obs_date)
     VALUES ('DGS10', 'fred.csv', 'DGS10', '10-Year Treasury Constant Maturity Rate', 'Percent',
             'D', NULL, 'US', 2, $1::date, $2::date)
     RETURNING series_id::text AS series_id`,
    [DGS10_OBS[0]![0], DGS10_OBS[DGS10_OBS.length - 1]![0]],
  );
  const seriesId = Number(series.rows[0]!.series_id);
  for (const [obsDate, value] of DGS10_OBS) {
    await t.client.query(
      `INSERT INTO econ_observations (series_id, obs_date, vintage_at, value, status, is_latest,
                                      provenance_id)
       VALUES ($1, $2::date, $3::timestamptz, $4, 'final', true, $5)`,
      [seriesId, obsDate, VINTAGE, value, fredProv],
    );
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

  env = { harness, app: harness.app, clock, cookie: session.cookie, knownAt };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: GcPayload;
  meta: PayloadMeta;
}

async function runGC(params: Record<string, unknown> = {}): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/GC/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

/** A GC payload holds no sequence-allocated id at all; the set is declared to say so. */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId', 'buildId']);

function normalise(payload: GcPayload): unknown {
  const tokens = new Map<number, string>();
  const json = JSON.stringify(payload, (key, value: unknown) => {
    if (typeof value === 'string') return subjectToken(value, tokens);
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

describe('GC — the curve across dates', () => {
  it('draws the served date against the comparisons that exist and drops the ones that do not', async () => {
    const { data, meta } = await runGC({ compare: ['PREV', '1W', 'YTD'] });

    expect(data.mode).toBe('curve');
    expect(data.curve.date).toBe('2026-09-14');
    expect(data.curve.availableDates).toEqual([...DATES]);
    expect(data.history).toBeNull();

    // PREV → the session before; 1W → the latest date at or before 09-07, which is 09-04.
    expect(data.snapshots.map((s) => [s.id, s.date])).toEqual([
      ['CUR', '2026-09-14'],
      ['PREV', '2026-09-11'],
      ['1W', '2026-09-04'],
    ]);
    // YTD asks for 2025-12-31 and nothing is stored that far back.
    const note = meta.unavailable.find((row) => row.field === 'compare.YTD');
    expect(note?.reason).toBe('NO_SOURCE');
    expect(note?.detail).toContain('2025-12-31');
    expect(data.caveats).toContain('CURVE_DATES_ONLY');

    // GC never bootstraps: no build exists, so every snapshot says so.
    const builds = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM curve_builds WHERE curve_id = 'UST_PAR'`,
    );
    expect(Number(builds.rows[0]!.n)).toBe(0);
    expect(data.snapshots.every((s) => s.buildId === null)).toBe(true);
  });

  it('changes are the basis-point difference, and na where a tenor is absent', async () => {
    const { data } = await runGC({ compare: ['PREV', '1W'] });

    const tenYear = data.changes.find((change) => change.tenor === '10Y');
    expect(tenYear?.current.v).toBe(4.07);
    expect(tenYear?.vs[0]?.bp.v as number).toBeCloseTo(4, 9); // 4.07 − 4.03
    expect(tenYear?.vs[1]?.bp.v as number).toBeCloseTo(8, 9); // 4.07 − 3.99

    // The 3M point is absent from 2026-09-04: the change is `na`, not a number computed from the
    // tenor next to it.
    const threeMonth = data.changes.find((change) => change.tenor === '3M');
    expect(threeMonth?.vs[0]?.bp.v as number).toBeCloseTo(2, 9);
    expect(threeMonth?.vs[1]?.bp.v).toBeNull();
    expect(threeMonth?.vs[1]?.bp.st).toBe('na');
  });

  it('spreads the slopes it can and names the leg it cannot', async () => {
    const { data, meta } = await runGC({ compare: ['PREV'], spreads: ['2s10s', '5s30s', '3M10Y'] });

    const twoTen = data.spreads.find((row) => row.id === '2s10s');
    expect(twoTen?.legs).toEqual(['2Y', '10Y']);
    expect(twoTen?.current.v as number).toBeCloseTo((4.07 - 3.76) * 100, 9);
    expect(twoTen?.vs[0]?.bp.v as number).toBeCloseTo(
      (4.07 - 3.76) * 100 - (4.03 - 3.74) * 100,
      9,
    );

    const fiveThirty = data.spreads.find((row) => row.id === '5s30s');
    expect(fiveThirty?.current.v as number).toBeCloseTo((4.66 - 3.81) * 100, 9);

    // 3M is on the curve, so 3M10Y is computed too; drop the leg and the spread goes `na`.
    await t.client.query(
      `DELETE FROM curve_points WHERE curve_id = 'UST_PAR' AND tenor = '3M'
                                  AND curve_date = '2026-09-14'::date`,
    );
    const second = await runGC({ compare: ['PREV'], spreads: ['3M10Y'] });
    const missing = second.data.spreads.find((row) => row.id === '3M10Y');
    expect(missing?.current.v).toBeNull();
    expect(missing?.current.st).toBe('na');
    const note = second.meta.unavailable.find((row) => row.field === 'spreads.3M10Y');
    expect(note?.detail).toContain('3M not on the UST_PAR curve');
    expect(meta.unavailable.some((row) => row.field === 'spreads.3M10Y')).toBe(false);
  });

  it('reads history from the stored series and says where a tenor has none', async () => {
    const { data, meta } = await runGC({
      mode: 'history',
      tenors: ['2Y', '10Y'],
      range: '1Y',
      spreads: ['2s10s'],
    });

    expect(data.mode).toBe('history');
    expect(data.history).not.toBeNull();
    const history = data.history!;
    expect(history.to).toBe('2026-09-14');

    // The 10Y is mapped to DGS10 and comes back whole, in date order, with no invented days.
    const tenYear = history.series.find((s) => s.tenor === '10Y');
    expect(tenYear?.source).toBe('econ_series');
    expect(tenYear?.seriesCode).toBe('DGS10');
    expect(tenYear?.coverage.n).toBe(DGS10_OBS.length);
    expect(tenYear?.obs.map((o) => o.d)).toEqual(DGS10_OBS.map(([d]) => d));
    for (let i = 1; i < (tenYear?.obs.length ?? 0); i += 1) {
      expect(tenYear!.obs[i]!.d > tenYear!.obs[i - 1]!.d).toBe(true);
    }

    // The 2Y has no seeded series, so it falls back to its own stored curve points — four dates,
    // which is far short of the year asked for, and the payload says so rather than stretching it.
    const twoYear = history.series.find((s) => s.tenor === '2Y');
    expect(twoYear?.source).toBe('curve_points');
    expect(twoYear?.obs).toHaveLength(DATES.length);
    expect(twoYear?.truncated).toBe(true);
    expect(meta.unavailable.some((row) => row.field === 'history.2Y')).toBe(true);
    expect(data.caveats).toContain('NO_LONG_HISTORY_FOR_TENOR');

    // The spread series exists only on the dates both legs have: the four curve dates, not the six
    // DGS10 days.
    const spread = history.spreadSeries.find((s) => s.id === '2s10s');
    expect(spread?.obs.map((o) => o.d)).toEqual([...DATES].sort());
    const last = spread?.obs.at(-1);
    expect(last?.v ?? Number.NaN).toBeCloseTo((4.07 - 3.76) * 100, 9);
  });

  it('serves an explicitly requested earlier date and refuses one with no curve', async () => {
    const { data } = await runGC({ date: '2026-09-11', compare: [] });
    expect(data.curve.date).toBe('2026-09-11');
    expect(data.curve.requestedDate).toBe('2026-09-11');
    expect(data.snapshots).toHaveLength(1);

    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/GC/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { date: '2020-01-01' },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses SOFR_FIX, which has no term structure', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/GC/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { curveId: 'SOFR_FIX' },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; details?: { location?: string } } }>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details?.location).toBe('fnParams');
  });

  it('matches the committed goldens', async () => {
    const curve = await runGC({ compare: ['PREV', '1W'] });
    expectGolden('GC.default.json', normalise(curve.data));

    const history = await runGC({ mode: 'history', tenors: ['10Y'], range: '5Y' });
    expectGolden('GC.default.history.json', normalise(history.data));
  });
});
