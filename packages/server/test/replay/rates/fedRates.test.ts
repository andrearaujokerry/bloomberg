/**
 * `nyfed-all` + `nyfed-sofr` + `nyfed-effr.json` + `fed-h15.csv` → `rate_fixings`, `curve_points`
 * and `econ_observations`, through `ingest/jobs/fedRates.ts` (WORKPLAN §WP-11, QA-02).
 *
 * The acceptance row asks for two things: *`rate_fixings` carry percentiles and volumes, and a
 * `revisionIndicator` opens a new vintage*. Every number below is measured from the captures:
 *
 *  - **19 distinct `(rate_code, effective_date)` fixings** out of 21 parsed rows. `/all/latest`
 *    carries all six types in one request, `/secured/sofr/last/5` five days and
 *    `/unsecured/effr/last/10` ten; SOFR and EFFR each publish 2026-09-14 twice, and the second
 *    sighting agrees with the first, so it writes **nothing** rather than opening a vintage.
 *  - **percentiles and volume on every type but `SOFRAI`.** The SOFR Averages and Index publishes
 *    no `percentRate` at all, so its `rate`, percentiles and volume stay NULL — the screen shows
 *    `—`, which is correct, rather than a fabricated zero. Every other row carries all four
 *    percentiles *and* a volume, ordered `p1 ≤ p25 ≤ rate ≤ p75 ≤ p99`.
 *  - **`targetRateFrom`/`targetRateTo` on EFFR alone**, 3.50–3.75 (§10.4).
 *  - **a revision opens a vintage, and only a revision does.** Both paths are exercised: a changed
 *    *value*, and a changed `revisionIndicator` alone — §10.4 says a non-empty one **always**
 *    opens a vintage, even when it changes no number we can see. In both cases the superseded row
 *    stays readable and `is_latest` moves exactly once.
 *  - **H.15**: 11 series, 55 observations of which 11 are the all-`ND` Sunday 2026-09-07, and
 *    therefore **44** `UST_CMT` curve points over four dates, not 55 over five.
 *
 * TESTS ARE SELF-SUFFICIENT (WORKPLAN §0.2): the `curves` and `econ_series` rows are created by
 * running the job, inside this file's own transaction. No literal id is named.
 *
 * This file lives under `test/replay/`, the single-worker `server-replay` project.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { VirtualClock } from '@terminal/core';

import { h15Url } from '../../../src/providers/fedH15/adapter.js';
import { parseH15 } from '../../../src/providers/fedH15/parse.js';
import { lastNUrl, latestAllUrl } from '../../../src/providers/nyfed/adapter.js';
import { parseRefRates } from '../../../src/providers/nyfed/parse.js';
import { openReplayStore } from '../../../src/providers/replayStore.js';
import {
  FED_H15_SOURCE_ID,
  FED_RATES_SCHEDULE,
  FED_RATES_TIMEOUT_MS,
  NYFED_BACKFILL,
  NYFED_SOURCE_ID,
  job,
  runFedRates,
  upsertRateFixings,
} from '../../../src/ingest/jobs/fedRates.js';
import { withTxDb } from '../../../src/test/db.js';

import type { Tx } from '../../../src/db/client.js';
import type { FedRatesContext } from '../../../src/ingest/jobs/fedRates.js';
import type { RateFixingRow } from '../../../src/providers/nyfed/parse.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The captures, read once
// ─────────────────────────────────────────────────────────────────────────────────────────────

const AS_OF = Date.parse('2026-09-15T18:41:28Z');
const store = openReplayStore();

const NYFED_URLS = [latestAllUrl(), lastNUrl('SOFR', 5), lastNUrl('EFFR', 10)];

const nyfedParses = NYFED_URLS.map((url) => {
  const raw = store.replay({ providerId: 'nyfed.rates', url });
  return {
    url,
    raw,
    parsed: parseRefRates(raw, {
      provenanceId: 1,
      capturedAt: raw.capturedAt,
      lines: new Map(),
    }),
  };
});

const h15Raw = store.replay({ providerId: 'fed.h15', url: h15Url() });
const h15Parsed = parseH15(h15Raw, {
  provenanceId: 1,
  capturedAt: h15Raw.capturedAt,
  lines: new Map(),
});

/** Every fixing the three captures parse to, in fetch order — 6 + 5 + 10. */
const ALL_FIXINGS: RateFixingRow[] = nyfedParses.flatMap((p) => p.parsed.rows.fixings);
/** The distinct keys they cover: 2026-09-14 is published by two of the three captures. */
const FIXING_KEYS = new Set(ALL_FIXINGS.map((f) => `${f.rateCode}|${f.effectiveDate}`));

const PARSED_FIXINGS = 21;
const DISTINCT_FIXINGS = 19;
/** SOFR's own five days become five `SOFR_FIX` points at tenor `ON`. */
const SOFR_POINTS = 5;
const H15_SERIES = 11;
const H15_OBSERVATIONS = 55;
const H15_MISSING = 11;
const CMT_POINTS = 44;

describe('fedRates — the captures and the scheduler row (PROVIDERS §10.3, §10.4, §13)', () => {
  it('reads four recorded captures, never a socket', () => {
    for (const { raw } of nyfedParses) {
      expect(raw.origin).toBe('replay');
      expect(raw.status).toBe(200);
      expect(raw.providerId).toBe('nyfed.rates');
    }
    expect(h15Raw.origin).toBe('replay');
    expect(h15Raw.providerId).toBe('fed.h15');
    expect(ALL_FIXINGS).toHaveLength(PARSED_FIXINGS);
    expect(FIXING_KEYS.size).toBe(DISTINCT_FIXINGS);
    expect(h15Parsed.rows.series).toHaveLength(H15_SERIES);
    expect(h15Parsed.rows.observations).toHaveLength(H15_OBSERVATIONS);
    expect(h15Parsed.rows.curvePoints).toHaveLength(CMT_POINTS);
    expect(h15Parsed.rows.allMissingDates).toEqual(['2026-09-07']);
  });

  it('declares the §13 scheduler row and §10.4 back-fill', () => {
    expect(job.id).toBe('fedRates');
    expect(job.schedule).toBe(FED_RATES_SCHEDULE);
    expect(FED_RATES_SCHEDULE).toBe('30 8 * * 1-5');
    expect(job.priority).toBe(2);
    expect(job.timeoutMs).toBe(FED_RATES_TIMEOUT_MS);
    expect(FED_RATES_TIMEOUT_MS).toBe(60_000);
    expect(job.provider).toEqual([NYFED_SOURCE_ID, FED_H15_SOURCE_ID]);
    expect(NYFED_BACKFILL).toEqual([
      { code: 'SOFR', days: 5 },
      { code: 'EFFR', days: 10 },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job, against a database it builds for itself
// ─────────────────────────────────────────────────────────────────────────────────────────────

const t = withTxDb();

function jobContext(tx: Tx): FedRatesContext {
  return { tx, clock: new VirtualClock(AS_OF), replay: store };
}

async function rows<T extends Record<string, unknown>>(
  tx: Tx,
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  return (await tx.execute<T>(query)).rows;
}

async function countOf(tx: Tx, query: ReturnType<typeof sql>): Promise<number> {
  const out = await tx.execute<{ n: string }>(query);
  return Number(out.rows[0]?.n ?? '0');
}

describe('fedRates — the job over all four captures (QA-02)', () => {
  it('writes 19 fixings with percentiles and volumes, and a second run writes nothing', async () => {
    const first = await runFedRates(jobContext(t.db));
    expect(first.errors).toEqual([]);
    expect(first.fetched).toBe(4);
    expect(first.fixingsInserted).toBe(DISTINCT_FIXINGS);
    expect(first.fixingVintages).toBe(0);
    // The two days both a `latest` and a `last/n` capture publish agree, so they write nothing.
    expect(first.fixingsUnchanged).toBe(PARSED_FIXINGS - DISTINCT_FIXINGS);

    expect(await countOf(t.db, sql`SELECT count(*)::text AS n FROM rate_fixings`)).toBe(
      DISTINCT_FIXINGS,
    );
    expect(
      await countOf(t.db, sql`SELECT count(*)::text AS n FROM rate_fixings WHERE is_latest`),
    ).toBe(DISTINCT_FIXINGS);

    // Percentiles and volume: every type but SOFRAI, which publishes none at all.
    const byCode = await rows<{
      rate_code: string;
      n: string;
      with_pct: string;
      with_volume: string;
      with_rate: string;
      with_target: string;
    }>(
      t.db,
      sql`SELECT rate_code, count(*)::text AS n,
                 count(*) FILTER (WHERE pct_1 IS NOT NULL AND pct_25 IS NOT NULL
                                    AND pct_75 IS NOT NULL AND pct_99 IS NOT NULL)::text AS with_pct,
                 count(volume_bn)::text AS with_volume,
                 count(rate)::text AS with_rate,
                 count(target_from)::text AS with_target
            FROM rate_fixings GROUP BY rate_code ORDER BY rate_code`,
    );
    expect(byCode.map((r) => r.rate_code)).toEqual([
      'BGCR',
      'EFFR',
      'OBFR',
      'SOFR',
      'SOFRAI',
      'TGCR',
    ]);
    const sofrai = byCode.find((r) => r.rate_code === 'SOFRAI');
    expect(sofrai).toEqual({
      rate_code: 'SOFRAI',
      n: '1',
      with_pct: '0',
      with_volume: '0',
      with_rate: '0',
      with_target: '0',
    });
    for (const row of byCode.filter((r) => r.rate_code !== 'SOFRAI')) {
      expect({ code: row.rate_code, pct: row.with_pct, vol: row.with_volume }).toEqual({
        code: row.rate_code,
        pct: row.n,
        vol: row.n,
      });
    }
    // §10.4: the target range is EFFR's alone.
    expect(byCode.find((r) => r.rate_code === 'EFFR')?.with_target).toBe(
      byCode.find((r) => r.rate_code === 'EFFR')?.n,
    );
    expect(
      byCode.filter((r) => r.rate_code !== 'EFFR').every((r) => r.with_target === '0'),
    ).toBe(true);

    // The percentiles bracket the rate on every row that has them — a transposed pair would show.
    expect(
      await countOf(
        t.db,
        sql`SELECT count(*)::text AS n FROM rate_fixings
             WHERE rate IS NOT NULL AND pct_1 IS NOT NULL
               AND NOT (pct_1 <= pct_25 AND pct_25 <= rate AND rate <= pct_75
                        AND pct_75 <= pct_99)`,
      ),
    ).toBe(0);
    // The SOFR index carries ten decimal places and they are kept.
    const index = await rows<{ index_value: string | null }>(
      t.db,
      sql`SELECT index_value::text AS index_value FROM rate_fixings WHERE rate_code = 'SOFRAI'`,
    );
    expect(Number(index[0]?.index_value)).toBeGreaterThan(1);

    // The curves the job publishes.
    expect(first.sofrPoints).toBe(SOFR_POINTS + 1);
    expect(
      await countOf(t.db, sql`SELECT count(*)::text AS n FROM curve_points
                               WHERE curve_id = 'SOFR_FIX'`),
    ).toBe(SOFR_POINTS);
    expect(first.cmtPoints).toBe(CMT_POINTS);
    expect(
      await countOf(t.db, sql`SELECT count(*)::text AS n FROM curve_points
                               WHERE curve_id = 'UST_CMT'`),
    ).toBe(CMT_POINTS);

    const second = await runFedRates(jobContext(t.db));
    expect(second.errors).toEqual([]);
    expect(second.fixingsInserted).toBe(0);
    expect(second.fixingVintages).toBe(0);
    expect(second.fixingsUnchanged).toBe(PARSED_FIXINGS);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(await countOf(t.db, sql`SELECT count(*)::text AS n FROM rate_fixings`)).toBe(
      DISTINCT_FIXINGS,
    );
    expect(await countOf(t.db, sql`SELECT count(*)::text AS n FROM curve_points`)).toBe(
      SOFR_POINTS + CMT_POINTS,
    );
    expect(await countOf(t.db, sql`SELECT count(*)::text AS n FROM econ_observations`)).toBe(
      H15_OBSERVATIONS,
    );

    const runs = await rows<{ n: string; statuses: string }>(
      t.db,
      sql`SELECT count(*)::text AS n, string_agg(DISTINCT status, ',') AS statuses
            FROM ingest_runs WHERE job_id = 'fedRates'`,
    );
    expect(runs[0]?.n).toBe('2');
    expect(runs[0]?.statuses).toBe('ok');
  });

  it('opens a new vintage for a revised rate, and keeps the superseded one readable', async () => {
    await runFedRates(jobContext(t.db));

    const before = await rows<{ rate: string; vintage_at: string }>(
      t.db,
      sql`SELECT rate::text AS rate, vintage_at::text AS vintage_at FROM rate_fixings
           WHERE rate_code = 'SOFR' AND effective_date = '2026-09-14'::date AND is_latest`,
    );
    expect(before).toHaveLength(1);
    const publishedRate = Number(before[0]?.rate);
    expect(publishedRate).toBeGreaterThan(0);

    // Put the table in the state the *pre-revision* poll left behind: a different rate at an
    // earlier vintage. Replaying the capture must then be read as a revision.
    await t.db.execute(sql`
      UPDATE rate_fixings
         SET rate = ${(publishedRate + 0.05).toFixed(8)}::numeric,
             vintage_at = vintage_at - interval '6 hours'
       WHERE rate_code = 'SOFR' AND effective_date = '2026-09-14'::date`);

    const revised = await runFedRates(jobContext(t.db));
    expect(revised.fixingVintages).toBe(1);
    expect(revised.fixingsInserted).toBe(0);

    const vintages = await rows<{
      rate: string;
      vintage_at: string;
      is_latest: boolean;
    }>(
      t.db,
      sql`SELECT rate::text AS rate, vintage_at::text AS vintage_at, is_latest
            FROM rate_fixings
           WHERE rate_code = 'SOFR' AND effective_date = '2026-09-14'::date
           ORDER BY vintage_at`,
    );
    expect(vintages).toHaveLength(2);
    expect(vintages[0]?.is_latest).toBe(false);
    expect(Number(vintages[0]?.rate)).toBeCloseTo(publishedRate + 0.05, 8);
    expect(vintages[1]?.is_latest).toBe(true);
    expect(Number(vintages[1]?.rate)).toBeCloseTo(publishedRate, 8);

    // Exactly once: a further replay settles rather than re-revising.
    const settled = await runFedRates(jobContext(t.db));
    expect(settled.fixingVintages).toBe(0);
    expect(
      await countOf(
        t.db,
        sql`SELECT count(*)::text AS n FROM rate_fixings
             WHERE rate_code = 'SOFR' AND effective_date = '2026-09-14'::date`,
      ),
    ).toBe(2);
  });

  it('opens a vintage for a revisionIndicator alone, changing no number (§10.4)', async () => {
    const first = await runFedRates(jobContext(t.db));
    expect(first.errors).toEqual([]);
    // Every recorded fixing carries an empty indicator, so this is the one path the captures
    // cannot exercise by themselves — the writer is driven directly.
    expect(ALL_FIXINGS.every((f) => f.revisionIndicator === '')).toBe(true);

    const source = ALL_FIXINGS.find(
      (f) => f.rateCode === 'EFFR' && f.effectiveDate === '2026-09-11',
    );
    expect(source).toBeDefined();
    if (source === undefined) throw new Error('no EFFR fixing for 2026-09-11');

    const provenanceId = first.provenanceIds[0];
    if (provenanceId === undefined) throw new Error('the run recorded no provenance row');

    // The same numbers, an hour later, now labelled a revision. §10.4: that always opens a vintage.
    const announced: RateFixingRow = {
      ...source,
      vintageAt: new Date(Date.parse(source.vintageAt) + 3_600_000).toISOString(),
      revisionIndicator: 'Y',
    };
    const counts = await upsertRateFixings(t.db, [announced], provenanceId);
    expect(counts).toEqual({ inserted: 0, revised: 1, unchanged: 0, stale: 0 });

    const vintages = await rows<{
      rate: string;
      revision_indicator: string | null;
      is_latest: boolean;
    }>(
      t.db,
      sql`SELECT rate::text AS rate, revision_indicator, is_latest FROM rate_fixings
           WHERE rate_code = 'EFFR' AND effective_date = '2026-09-11'::date
           ORDER BY vintage_at`,
    );
    expect(vintages).toHaveLength(2);
    expect(vintages[0]?.revision_indicator).toBe('');
    expect(vintages[0]?.is_latest).toBe(false);
    expect(vintages[1]?.revision_indicator).toBe('Y');
    expect(vintages[1]?.is_latest).toBe(true);
    // The numbers are identical; only the label changed, and that was enough.
    expect(Number(vintages[1]?.rate)).toBe(Number(vintages[0]?.rate));

    // Replaying the same announcement again is idempotent.
    expect(await upsertRateFixings(t.db, [announced], provenanceId)).toEqual({
      inserted: 0,
      revised: 0,
      unchanged: 1,
      stale: 0,
    });
    expect(
      await countOf(
        t.db,
        sql`SELECT count(*)::text AS n FROM rate_fixings
             WHERE rate_code = 'EFFR' AND effective_date = '2026-09-11'::date`,
      ),
    ).toBe(2);
  });

  it('lands the eleven H.15 series, the Sunday as missing and no curve point for it', async () => {
    const first = await runFedRates(jobContext(t.db));
    expect(first.h15Series).toBe(H15_SERIES);
    expect(first.h15Observations).toBe(H15_OBSERVATIONS);

    expect(
      await countOf(
        t.db,
        sql`SELECT count(*)::text AS n FROM econ_series WHERE source_id = ${FED_H15_SOURCE_ID}`,
      ),
    ).toBe(H15_SERIES);

    const observations = await rows<{ n: string; missing: string; dates: string }>(
      t.db,
      sql`SELECT count(*)::text AS n,
                 count(*) FILTER (WHERE status = 'missing')::text AS missing,
                 count(DISTINCT obs_date)::text AS dates
            FROM econ_observations`,
    );
    expect(observations[0]).toEqual({
      n: String(H15_OBSERVATIONS),
      missing: String(H15_MISSING),
      dates: '5',
    });
    // The whole Sunday is `ND`: eleven missing observations and not one curve point.
    expect(
      await countOf(
        t.db,
        sql`SELECT count(*)::text AS n FROM econ_observations
             WHERE obs_date = '2026-09-07'::date AND status = 'missing'`,
      ),
    ).toBe(H15_MISSING);
    expect(
      await countOf(
        t.db,
        sql`SELECT count(*)::text AS n FROM curve_points
             WHERE curve_id = 'UST_CMT' AND curve_date = '2026-09-07'::date`,
      ),
    ).toBe(0);

    const cmt = await rows<{ dates: string; tenors: string; quote_types: string }>(
      t.db,
      sql`SELECT count(DISTINCT curve_date)::text AS dates,
                 count(DISTINCT tenor)::text AS tenors,
                 string_agg(DISTINCT quote_type, ',') AS quote_types
            FROM curve_points WHERE curve_id = 'UST_CMT'`,
    );
    expect(cmt[0]).toEqual({ dates: '4', tenors: '11', quote_types: 'cmt_yield' });

    // The names come from the file's own header block: nothing about H.15 is seeded.
    const series = await rows<{ series_code: string; name: string; units: string }>(
      t.db,
      sql`SELECT series_code, name, units FROM econ_series
           WHERE source_id = ${FED_H15_SOURCE_ID} AND provider_code = 'RIFLGFCY10_N.B'`,
    );
    expect(series[0]?.series_code).toBe('RIFLGFCY10_N.B');
    expect(series[0]?.units).toBe('Percent');
    expect(series[0]?.name).toContain('10-year constant maturity');

    // The two curve definitions this job owns were created by it, not by a seed.
    const curves = await rows<{ curve_id: string; kind: string; source_id: string }>(
      t.db,
      sql`SELECT curve_id, kind, source_id FROM curves ORDER BY curve_id`,
    );
    expect(curves).toEqual([
      { curve_id: 'SOFR_FIX', kind: 'fixing', source_id: NYFED_SOURCE_ID },
      { curve_id: 'UST_CMT', kind: 'cmt', source_id: FED_H15_SOURCE_ID },
    ]);
  });
});
