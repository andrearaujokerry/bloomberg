/**
 * `data/curves.ts` — the `curve_builds` cache (ANAL-08, WORKPLAN §WP-04 L706-709).
 *
 * The claim under test is the expensive one: **a second build with identical inputs hits the cache
 * and does not recompute.** A boolean return could lie about that, so the proof is physical — the
 * stored `nodes` are tampered with between the two calls, and the second call is required to
 * return the tampered numbers. A bootstrap would have produced the original ones; only a read of
 * `curve_builds` can produce the tampered ones. Row counts back it up: the table still holds one
 * row after the second build.
 *
 * The rest of the file pins what the cache key actually is: the same inputs under a different
 * interpolation are a different build, and a revised input vintage is a different build, because
 * both change the row the key selects.
 *
 * Self-sufficient (TESTING §4.3): WP-15's seed modules do not exist yet, so the fixture writes its
 * own licence row, provenance row, `curves` row and `curve_points` inside the test's own
 * transaction, which is rolled back afterwards. The curve id is unique per test so four forks can
 * run against one database without colliding on the `curves` primary key.
 */

import { describe, expect, it } from 'vitest';

import { buildCurve, readPoints } from '../../../src/data/curves.js';
import { withTxDb } from '../../../src/test/db.js';

import type { TestDb } from '../../../src/test/db.js';

/** The curve date every point below is published for. */
const CURVE_DATE = '2026-09-14';
/** The vintage the Treasury published on. */
const VINTAGE = new Date('2026-09-14T22:15:00Z');
/** "Now" for the reads: after the vintage. */
const AT = { validAt: new Date('2026-09-15T12:00:00Z'), knownAt: new Date('2026-09-15T12:00:00Z') };

/** The published par curve: six tenors, percent, as `curve_points.value` holds them. */
const PAR_QUOTES: readonly { tenor: string; days: number; value: number }[] = [
  { tenor: '1Y', days: 365, value: 4.0 },
  { tenor: '2Y', days: 730, value: 4.1 },
  { tenor: '3Y', days: 1095, value: 4.2 },
  { tenor: '5Y', days: 1826, value: 4.3 },
  { tenor: '7Y', days: 2556, value: 4.4 },
  { tenor: '10Y', days: 3652, value: 4.5 },
];

interface Fixture {
  curveId: string;
  provenanceId: number;
  /** Publish a later vintage of one tenor. */
  revise: (tenor: string, value: number, vintage: Date) => Promise<number>;
}

async function fixture(t: TestDb): Promise<Fixture> {
  await t.client.query(
    `INSERT INTO licence_registry (source_id, source_name, publisher, licence_kind, attribution,
                                   rate_limit, valid_from)
     SELECT 'treasury.yieldcurve', 'Treasury par yield curve', 'US Treasury', 'public_domain',
            'US Treasury', 'n/a', timestamptz '2000-01-01'
      WHERE NOT EXISTS (SELECT 1 FROM licence_registry
                         WHERE source_id = 'treasury.yieldcurve' AND tx_to = 'infinity')`,
  );

  const provenance = async (label: string, capturedAt: Date): Promise<number> => {
    const res = await t.client.query<{ provenance_id: string }>(
      `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                               http_status, bytes, captured_at, adapter_version)
       VALUES ('treasury.yieldcurve', $1, 'test://curves/' || $1, digest($1, 'sha256'),
               digest($1, 'sha256'), 200, 0, $2, 'test/1.0.0')
       RETURNING provenance_id`,
      [`${label}-${String(Math.random()).slice(2)}`, capturedAt.toISOString()],
    );
    return Number(res.rows[0]!.provenance_id);
  };

  // A curve id nothing else can collide with: `curves.curve_id` is the primary key and the
  // harness's rollback does not isolate parallel forks from a duplicate-key error.
  const curveId = `TEST_PAR_${String(Math.random()).slice(2, 12)}`;
  await t.client.query(
    `INSERT INTO curves (curve_id, name, currency, kind, day_count, compounding, source_id,
                         default_interpolation)
     VALUES ($1, 'Test par curve', 'USD', 'par', 'ACT/ACT', 'semiannual', 'treasury.yieldcurve',
             'monotone_convex')`,
    [curveId],
  );

  const provenanceId = await provenance('par', VINTAGE);
  for (const quote of PAR_QUOTES) {
    await t.client.query(
      `INSERT INTO curve_points (curve_id, curve_date, tenor, quote_type, vintage_at, tenor_days,
                                 value, is_latest, provenance_id)
       VALUES ($1, $2::date, $3, 'par_yield', $4, $5, $6, true, $7)`,
      [
        curveId,
        CURVE_DATE,
        quote.tenor,
        VINTAGE.toISOString(),
        quote.days,
        quote.value,
        provenanceId,
      ],
    );
  }

  const revise = async (tenor: string, value: number, vintage: Date): Promise<number> => {
    const revisionProvenance = await provenance('par-revision', vintage);
    const days = PAR_QUOTES.find((q) => q.tenor === tenor)?.days ?? 365;
    await t.client.query(
      `UPDATE curve_points SET is_latest = false
        WHERE curve_id = $1 AND curve_date = $2::date AND tenor = $3 AND quote_type = 'par_yield'`,
      [curveId, CURVE_DATE, tenor],
    );
    await t.client.query(
      `INSERT INTO curve_points (curve_id, curve_date, tenor, quote_type, vintage_at, tenor_days,
                                 value, is_latest, provenance_id)
       VALUES ($1, $2::date, $3, 'par_yield', $4, $5, $6, true, $7)`,
      [curveId, CURVE_DATE, tenor, vintage.toISOString(), days, value, revisionProvenance],
    );
    return revisionProvenance;
  };

  return { curveId, provenanceId, revise };
}

async function buildCount(t: TestDb, curveId: string): Promise<number> {
  const res = await t.client.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM curve_builds WHERE curve_id = $1',
    [curveId],
  );
  return Number(res.rows[0]!.n);
}

describe('data/curves — points', () => {
  const t = withTxDb();

  it('serves the published vintage with provenance on every point', async () => {
    const { curveId, provenanceId } = await fixture(t);

    const points = await readPoints(t.db, AT, curveId, CURVE_DATE);

    expect(points.curveId).toBe(curveId);
    expect(points.curveDate).toBe(CURVE_DATE);
    expect(points.kind).toBe('par');
    expect(points.compounding).toBe('semiannual');
    expect(points.availableDates).toEqual([CURVE_DATE]);
    expect(points.points.map((p) => p.tenor)).toEqual(['1Y', '2Y', '3Y', '5Y', '7Y', '10Y']);
    expect(points.points.map((p) => p.value)).toEqual([4.0, 4.1, 4.2, 4.3, 4.4, 4.5]);
    for (const point of points.points) {
      expect(point.provenanceId).toBe(provenanceId);
      expect(point.capturedAt).toBe(VINTAGE.toISOString());
      expect(point.quoteType).toBe('par_yield');
    }
  });

  it('does not show a vintage published after knownAt (REF-03)', async () => {
    const { curveId, revise } = await fixture(t);
    const revisionVintage = new Date('2026-09-16T22:15:00Z');
    await revise('10Y', 4.9, revisionVintage);

    // Known on the 15th: the revision has not been published yet.
    const before = await readPoints(t.db, AT, curveId, CURVE_DATE);
    expect(before.points.at(-1)?.tenor).toBe('10Y');
    expect(before.points.at(-1)?.value).toBe(4.5);

    // Known on the 17th: the revision is the answer.
    const after = await readPoints(
      t.db,
      { validAt: AT.validAt, knownAt: new Date('2026-09-17T00:00:00Z') },
      curveId,
      CURVE_DATE,
    );
    expect(after.points.at(-1)?.value).toBe(4.9);
    expect(after.points.at(-1)?.vintageAt).toBe(revisionVintage.toISOString());
  });
});

describe('data/curves — the build cache (ANAL-08)', () => {
  const t = withTxDb();

  it('a second build with identical inputs is served from curve_builds and is not recomputed', async () => {
    const { curveId } = await fixture(t);

    const first = await buildCurve(t.db, AT, curveId, CURVE_DATE);
    expect(first.cached).toBe(false);
    expect(first.method).toBe('bills+par_bootstrap');
    expect(first.interpolation).toBe('monotone_convex');
    expect(first.engine.name).toBe('curve.bootstrap');
    expect(first.nodes).toHaveLength(PAR_QUOTES.length);
    expect(first.inputs.map((i) => i.tenor)).toEqual(['1Y', '2Y', '3Y', '5Y', '7Y', '10Y']);
    expect(first.inputs.every((i) => i.proxy === false)).toBe(true);
    expect(await buildCount(t, curveId)).toBe(1);

    // The physical proof. Overwrite the stored `zero` of every node with a number no bootstrap
    // would ever produce. `makeCurve` reads only `(t, df)`, so the row stays re-hydratable.
    const tampered = first.nodes.map((node) => ({ ...node, zero: 999 }));
    await t.client.query('UPDATE curve_builds SET nodes = $2::jsonb WHERE build_id = $1', [
      first.buildId,
      JSON.stringify(tampered),
    ]);

    const second = await buildCurve(t.db, AT, curveId, CURVE_DATE);

    expect(second.cached).toBe(true);
    expect(second.buildId).toBe(first.buildId);
    // Recomputing would have restored the real zeros; these are the tampered ones.
    expect(second.nodes.map((n) => n.zero)).toEqual(tampered.map((n) => n.zero));
    expect(second.nodes.map((n) => n.df)).toEqual(first.nodes.map((n) => n.df));
    expect(second.engine.inputsHash).toBe(first.engine.inputsHash);
    expect(second.valuationTs).toBe(first.valuationTs);
    // Counted, not inferred: the second build wrote no row.
    expect(await buildCount(t, curveId)).toBe(1);

    // The re-hydrated curve is the stored one: df(t) at a node equals the stored df.
    const node = second.nodes[0]!;
    expect(second.curve.df(node.t)).toBeCloseTo(node.df, 12);
  });

  it('a different interpolation is a different cache entry', async () => {
    const { curveId } = await fixture(t);

    const monotone = await buildCurve(t.db, AT, curveId, CURVE_DATE);
    const linear = await buildCurve(t.db, AT, curveId, CURVE_DATE, 'linear_zero');

    expect(monotone.cached).toBe(false);
    expect(linear.cached).toBe(false);
    expect(linear.buildId).not.toBe(monotone.buildId);
    expect(linear.interpolation).toBe('linear_zero');
    // Same inputs, so the same hash — the interpolation is a separate column of the key.
    expect(linear.engine.inputsHash).not.toBe(monotone.engine.inputsHash);
    expect(await buildCount(t, curveId)).toBe(2);

    const again = await buildCurve(t.db, AT, curveId, CURVE_DATE, 'linear_zero');
    expect(again.cached).toBe(true);
    expect(again.buildId).toBe(linear.buildId);
    expect(await buildCount(t, curveId)).toBe(2);
  });

  it('a revised input vintage misses the cache and builds again', async () => {
    const { curveId, revise } = await fixture(t);
    const first = await buildCurve(t.db, AT, curveId, CURVE_DATE);

    const revisionVintage = new Date('2026-09-15T01:00:00Z');
    await revise('10Y', 4.75, revisionVintage);

    const second = await buildCurve(t.db, AT, curveId, CURVE_DATE);

    expect(second.cached).toBe(false);
    expect(second.buildId).not.toBe(first.buildId);
    expect(second.engine.inputsHash).not.toBe(first.engine.inputsHash);
    expect(second.inputs.at(-1)?.value).toBe(4.75);
    expect(await buildCount(t, curveId)).toBe(2);

    // And the *original* inputs are still cached: reading as known before the revision returns the
    // first build, untouched.
    const asKnownBefore = await buildCurve(
      t.db,
      { validAt: AT.validAt, knownAt: new Date('2026-09-14T23:00:00Z') },
      curveId,
      CURVE_DATE,
    );
    expect(asKnownBefore.cached).toBe(true);
    expect(asKnownBefore.buildId).toBe(first.buildId);
    expect(await buildCount(t, curveId)).toBe(2);
  });
});
