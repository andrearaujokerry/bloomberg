/**
 * Seed module 7 (DATA_MODEL §18 row 7): the five `curves`, the ≈300 published `curve_points` and the
 * one cached `curve_builds` row for `SOFR_OIS`.
 *
 * What is actually being checked is the **derivation**, because it is the only curve in the system
 * with no published input: FUNCTIONS_TIER3 §CRVF L288 says what each proxy point must be made of and
 * this file asserts that the stored numbers are exactly those transformations of the stored inputs —
 * the SOFR fixing, the SOFRAI realised averages, the 52-week bill's investment yield and the
 * Treasury par yields. A proxy that quietly became something else (an interpolation, a carried
 * forward value, a zero) would still build a curve and still look like a curve; it would fail here.
 *
 * `test/globalSetup.ts` has already run the seed (TESTING §4.2 step 5), so the module is re-run
 * inside this test's transaction to prove it writes nothing the second time, and everything it did
 * write is rolled back.
 */

import { describe, expect, it } from 'vitest';

import { getConfig } from '../../../src/config.js';
import { buildCurve } from '../../../src/data/curves.js';
import {
  CURVES_TABLES,
  SOFR_OIS_CURVE_ID,
  SOFR_OIS_PROXIES,
  TREASURY_OIS_BASIS_BP,
  investmentYieldToAct360,
  seedCurves,
} from '../../../src/seed/curves.js';
import { countTables } from '../../../src/seed/rates.js';
import { frozenClock, TEST_NOW } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';

import type { SeedContext } from '../../../src/seed/index.js';
import type { TestDb } from '../../../src/test/db.js';

const RETRY = { retry: 2 } as const;

/** The curve date FUNCTIONS_TIER3 §0 L11 pins for this fixture set. */
const CURVE_DATE = '2026-09-14';

function seedContext(t: TestDb, log: string[] = []): SeedContext {
  return {
    query: (text, values) => t.client.query(text, values),
    db: t.db,
    config: getConfig(),
    clock: frozenClock(TEST_NOW),
    log: (message) => log.push(message),
  };
}

async function rows<R extends Record<string, unknown>>(t: TestDb, sql: string): Promise<R[]> {
  return (await t.client.query<R>(sql)).rows;
}

async function value(t: TestDb, sql: string): Promise<string | null> {
  const row = (await t.client.query<{ v: string | null }>(sql)).rows[0];
  return row?.v ?? null;
}

describe('seed/curves derives SOFR_OIS from proxies and caches one build', () => {
  const t = withTxDb();

  it('is idempotent by table delta', RETRY, async () => {
    const ctx = seedContext(t);
    await seedCurves(ctx);

    const before = await countTables(t.db, CURVES_TABLES);
    const deltas = await seedCurves(ctx);
    const after = await countTables(t.db, CURVES_TABLES);
    for (const table of CURVES_TABLES) {
      expect(deltas[table], `${table} delta`).toBe(0);
      expect(after[table], `${table} count`).toBe(before[table]);
    }
  });

  it('defines the five curves CONTRACTS §1.2 names, and no sixth', RETRY, async () => {
    await seedCurves(seedContext(t));
    const defined = await rows<{ curve_id: string; kind: string; source_id: string }>(
      t,
      'SELECT curve_id, kind, source_id FROM curves ORDER BY curve_id',
    );
    expect(defined.map((c) => c.curve_id)).toEqual([
      'SOFR_FIX',
      'SOFR_OIS',
      'UST_BILL',
      'UST_CMT',
      'UST_PAR',
    ]);
    const ois = defined.find((c) => c.curve_id === SOFR_OIS_CURVE_ID);
    expect(ois?.kind).toBe('ois');
    // The proxy curve is `internal.derived`, which is what makes `CurveBuildInput.proxy` true and
    // the PROXY_CURVE badge appear on CRVF, SWPM, WIRP and FED.
    expect(ois?.source_id).toBe('internal.derived');
  });

  it('writes each proxy point as the stated transformation of a stored published number', RETRY, async () => {
    await seedCurves(seedContext(t));

    const points = await rows<{
      tenor: string;
      quote_type: string;
      value: string;
      tenor_days: number;
      instrument_id: string | null;
      maturity_date: string | null;
      source_id: string;
      curve_date: string;
    }>(
      t,
      `SELECT cp.tenor, cp.quote_type, cp.value::text AS value, cp.tenor_days,
              cp.instrument_id::text AS instrument_id, cp.maturity_date::text AS maturity_date,
              p.source_id, cp.curve_date::text AS curve_date
         FROM curve_points cp
         JOIN provenance p ON p.provenance_id = cp.provenance_id
        WHERE cp.curve_id = '${SOFR_OIS_CURVE_ID}' AND cp.is_latest
        ORDER BY cp.tenor_days`,
    );
    expect(points).toHaveLength(SOFR_OIS_PROXIES.length);
    expect(points.every((p) => p.curve_date === CURVE_DATE)).toBe(true);
    // Every derived row is attributed to the derived source, carries no instrument and no maturity.
    expect(points.every((p) => p.source_id === 'internal.derived')).toBe(true);
    expect(points.every((p) => p.instrument_id === null && p.maturity_date === null)).toBe(true);
    expect(points.map((p) => p.tenor)).toEqual(SOFR_OIS_PROXIES.map((r) => r.tenor));
    expect(points.map((p) => p.quote_type)).toEqual(SOFR_OIS_PROXIES.map((r) => r.quoteType));
    expect(points.map((p) => p.tenor_days)).toEqual(SOFR_OIS_PROXIES.map((r) => r.tenorDays));

    const at = (tenor: string): number => Number(points.find((p) => p.tenor === tenor)!.value);

    // ON = the SOFR fixing of the curve date.
    const sofr = await value(
      t,
      `SELECT rate::text AS v FROM rate_fixings
        WHERE rate_code = 'SOFR' AND effective_date = '${CURVE_DATE}' AND is_latest`,
    );
    expect(at('ON')).toBeCloseTo(Number(sofr), 8);

    // 1M/3M/6M = the SOFRAI realised averages, verbatim.
    const averages = (
      await rows<{ avg_30d: string; avg_90d: string; avg_180d: string }>(
        t,
        `SELECT avg_30d::text AS avg_30d, avg_90d::text AS avg_90d, avg_180d::text AS avg_180d
           FROM rate_fixings WHERE rate_code = 'SOFRAI' AND is_latest ORDER BY effective_date DESC LIMIT 1`,
      )
    )[0]!;
    expect(at('1M')).toBeCloseTo(Number(averages.avg_30d), 8);
    expect(at('3M')).toBeCloseTo(Number(averages.avg_90d), 8);
    expect(at('6M')).toBeCloseTo(Number(averages.avg_180d), 8);

    // 1Y = the 52-week bill's investment yield on an ACT/360 basis.
    const bill = await value(
      t,
      `SELECT value::text AS v FROM curve_points
        WHERE curve_id = 'UST_BILL' AND curve_date = '${CURVE_DATE}' AND tenor = '52WK'
          AND quote_type = 'investment_yield' AND is_latest`,
    );
    expect(at('1Y')).toBeCloseTo(investmentYieldToAct360(Number(bill)), 7);

    // 2Y…30Y = the par yield less the named basis assumption, which is zero.
    expect(TREASURY_OIS_BASIS_BP).toBe(0);
    for (const tenor of ['2Y', '3Y', '5Y', '7Y', '10Y', '20Y', '30Y']) {
      const par = await value(
        t,
        `SELECT value::text AS v FROM curve_points
          WHERE curve_id = 'UST_PAR' AND curve_date = '${CURVE_DATE}' AND tenor = '${tenor}'
            AND quote_type = 'par_yield' AND is_latest`,
      );
      expect(par, `UST_PAR ${tenor}`).not.toBeNull();
      expect(at(tenor)).toBeCloseTo(Number(par) - TREASURY_OIS_BASIS_BP / 100, 8);
    }
  });

  it('vintages the derived points at the capture instant of their inputs, not at `now`', RETRY, async () => {
    await seedCurves(seedContext(t));
    const vintages = await rows<{ vintage_at: string; captured_at: string; status: number; key: string }>(
      t,
      `SELECT DISTINCT cp.vintage_at::text AS vintage_at, p.captured_at::text AS captured_at,
              p.http_status AS status, p.request_key AS key
         FROM curve_points cp
         JOIN provenance p ON p.provenance_id = cp.provenance_id
        WHERE cp.curve_id = '${SOFR_OIS_CURVE_ID}'`,
    );
    expect(vintages).toHaveLength(1);
    const row = vintages[0]!;
    // The derivation's provenance row: a registered source, a key that names the derivation rather
    // than a URL, and `http_status 0` because nothing was fetched (PROVIDERS §4.3).
    expect(row.key).toBe(`derive:${SOFR_OIS_CURVE_ID}:${CURVE_DATE}`);
    expect(row.status).toBe(0);
    // The vintage is the latest capture instant among the inputs — inside the recorded window, not
    // the day the seed ran.
    expect(row.vintage_at).toBe(row.captured_at);
    expect(new Date(row.captured_at).toISOString().slice(0, 10)).toBe('2026-09-15');
  });

  it('caches exactly one build, which the reader answers from without bootstrapping again', RETRY, async () => {
    await seedCurves(seedContext(t));

    const builds = await rows<{
      curve_date: string;
      method: string;
      interpolation: string;
      engine_name: string;
      nodes: unknown;
      provenance_ids: string[];
    }>(
      t,
      `SELECT curve_date::text AS curve_date, method, interpolation, engine_name, nodes,
              provenance_ids::text[] AS provenance_ids
         FROM curve_builds WHERE curve_id = '${SOFR_OIS_CURVE_ID}' ORDER BY build_id`,
    );
    expect(builds).toHaveLength(1);
    const build = builds[0]!;
    expect(build.curve_date).toBe(CURVE_DATE);
    expect(build.method).toBe('ois_bootstrap');
    expect(build.interpolation).toBe('monotone_convex');
    expect(build.engine_name).toBe('curve.ois.bootstrap');
    expect(build.provenance_ids.length).toBeGreaterThan(0);

    // The bootstrap consumed the overnight fixing and the eight par-swap-equivalent points; the three
    // realised averages are `zero_rate` and the annual-frequency OIS engine cannot take a sub-annual
    // par swap (`oisScheduleOf: 1M is not a whole number of 1/yr fixed periods`), so they are stored
    // as inputs of the curve and not as inputs of the build.
    const nodes = build.nodes as { t: number; df: number; zero: number; fwd: number }[];
    expect(nodes).toHaveLength(9);
    expect(nodes.every((n) => Number.isFinite(n.df) && n.df > 0 && n.df <= 1)).toBe(true);
    // A discount curve is monotone: every later node discounts more than an earlier one.
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i]!.t).toBeGreaterThan(nodes[i - 1]!.t);
      expect(nodes[i]!.df).toBeLessThan(nodes[i - 1]!.df);
    }

    // The reader finds it by `inputs_hash` and re-hydrates rather than bootstrapping (ANAL-08).
    const at = { validAt: new Date(TEST_NOW), knownAt: new Date(TEST_NOW) };
    const again = await buildCurve(t.db, at, SOFR_OIS_CURVE_ID, CURVE_DATE);
    expect(again.cached).toBe(true);
    expect(again.nodes).toEqual(nodes);
    expect(again.inputs).toHaveLength(9);
    // FUNCTIONS_TIER3 `PROXY_CURVE`: every input the build consumed is a proxy, and says so.
    expect(again.inputs.every((input) => input.proxy)).toBe(true);
    expect(await countTables(t.db, ['curve_builds'])).toEqual({ curve_builds: 1 });
  });
});
