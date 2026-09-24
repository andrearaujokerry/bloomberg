/**
 * `fred-DGS10.csv` → `econ_observations`, through `ingest/jobs/fredSeries.ts` — **vintage
 * detection** (WORKPLAN §WP-11, QA-02, PROVIDERS §10.1).
 *
 * The acceptance row: *replaying a changed value for an existing `obs_date` adds a vintage and
 * flips `is_latest` exactly once*. That is the property the whole point-in-time econ story rests
 * on, so it is asserted from four directions and never from a boolean:
 *
 *  1. **16,879 observations land** — the measured size of the capture, 1962-01-02 … 2026-09-11,
 *     720 of them FRED's `'.'` marker stored as `value NULL, status 'missing'` rather than `0`.
 *  2. **A replay of the same bytes writes nothing.** `count(*)` and a content digest are
 *     identical, and the job reports 16,879 unchanged — because the comparison is numeric:
 *     Postgres hands back `'4.060000'` where the file said `4.06`, and a text comparison would
 *     open 16,879 spurious vintages on every poll.
 *  3. **A changed value opens exactly one new vintage.** The test makes the stored row disagree
 *     with the file — a *different* value at an *earlier* vintage, which is precisely the state a
 *     revised series leaves behind — and replays. One row is added, `is_latest` moves to it, and
 *     the row that was there is still readable with the number it always had.
 *  4. **Exactly once.** A further replay adds nothing: the revision settled, and a job that
 *     re-opened a vintage per poll would grow the table without bound.
 *
 * TESTS ARE SELF-SUFFICIENT (WORKPLAN §0.2): WP-15 owns the seed, so the `econ_series` row is
 * created by running the job, inside this file's own transaction, and no literal series id is
 * named anywhere.
 *
 * This file lives under `test/replay/`, the single-worker `server-replay` project.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { VirtualClock } from '@terminal/core';

import { fredCsvUrl } from '../../../src/providers/fred/adapter.js';
import { parseFredCsv } from '../../../src/providers/fred/parse.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import {
  FRED_MONTHLY_SCHEDULE,
  FRED_SERIES,
  FRED_SERIES_SCHEDULE,
  FRED_SERIES_TIMEOUT_MS,
  FRED_SOURCE_ID,
  job,
  runFredSeries,
} from '../../../src/ingest/jobs/fredSeries.js';
import { withTxDb } from '../../../src/test/db.js';

import type { Tx } from '../../../src/db/client.js';
import type { FredSeriesContext } from '../../../src/ingest/jobs/fredSeries.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The capture, read once
// ─────────────────────────────────────────────────────────────────────────────────────────────

const AS_OF = Date.parse('2026-09-15T18:41:28Z');
const SERIES = 'DGS10';

const store = openReplayStore();
const URL = fredCsvUrl(SERIES);
const raw = store.replay({ providerId: 'fred.csv', url: URL });
const parsed = parseFredCsv(raw, { provenanceId: 1, capturedAt: raw.capturedAt, lines: new Map() });

/** Measured from the capture (and pinned identically by `replay/providers/fredCsv.test.ts`). */
const OBSERVATIONS = 16_879;
const MISSING = 720;
/** The last observation the file carries — the date the revision test operates on. */
const LAST_OBS_DATE = '2026-09-11';

const lastObs = parsed.rows.observations.find((o) => o.obsDate === LAST_OBS_DATE);
/** The value the file publishes for that date, read from the bytes rather than asserted. */
const PUBLISHED_VALUE = lastObs?.value ?? null;
if (PUBLISHED_VALUE === null) {
  throw new Error(`the capture carries no value for ${LAST_OBS_DATE}`);
}

describe('fredSeries — the capture and the scheduler row (PROVIDERS §10.1, §13)', () => {
  it('reads the recorded capture, never a socket', () => {
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.requestKey).toBe(requestKey('fred.csv', 'GET', URL));
    expect(parsed.rows.observations).toHaveLength(OBSERVATIONS);
    expect(parsed.rows.observations.filter((o) => o.status === 'missing')).toHaveLength(MISSING);
    expect(parsed.rows.series.providerCode).toBe(SERIES);
    expect(parsed.rows.series.lastObsDate).toBe(LAST_OBS_DATE);
  });

  it('declares the §13 scheduler row and seeds the series list', () => {
    expect(job.id).toBe('fredSeries');
    expect(job.schedule).toBe(FRED_SERIES_SCHEDULE);
    expect(FRED_SERIES_SCHEDULE).toBe('30 16 * * 1-5');
    // §13's second cadence: one `IngestJob` carries one schedule, so the monthly one is exported.
    expect(FRED_MONTHLY_SCHEDULE).toBe('0 9 * * *');
    expect(job.priority).toBe(2);
    expect(job.timeoutMs).toBe(FRED_SERIES_TIMEOUT_MS);
    expect(FRED_SERIES_TIMEOUT_MS).toBe(300_000);
    expect(job.provider).toBe(FRED_SOURCE_ID);

    // The list is seeded, not derived: the CSV carries no name, units or frequency.
    const dgs10 = FRED_SERIES.find((s) => s.providerCode === SERIES);
    expect(dgs10?.units).toBe('Percent');
    expect(dgs10?.frequency).toBe('D');
    expect(new Set(FRED_SERIES.map((s) => s.seriesCode)).size).toBe(FRED_SERIES.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job, against a database it builds for itself
// ─────────────────────────────────────────────────────────────────────────────────────────────

const t = withTxDb();

function jobContext(tx: Tx): FredSeriesContext {
  return { tx, clock: new VirtualClock(AS_OF), replay: store, seriesIds: [SERIES] };
}

async function seriesId(tx: Tx): Promise<number> {
  const rows = await tx.execute<{ series_id: string }>(sql`
    SELECT series_id FROM econ_series
     WHERE source_id = ${FRED_SOURCE_ID} AND provider_code = ${SERIES}`);
  const row = rows.rows[0];
  if (row === undefined) throw new Error('econ_series row absent');
  return Number(row.series_id);
}

interface ObsShape {
  rows: number;
  latest: number;
  missing: number;
  digest: string | null;
}

async function obsShape(tx: Tx): Promise<ObsShape> {
  const out = await tx.execute<{
    n: string;
    latest: string;
    missing: string;
    digest: string | null;
  }>(sql`
    SELECT count(*)::text AS n,
           count(*) FILTER (WHERE is_latest)::text AS latest,
           count(*) FILTER (WHERE status = 'missing')::text AS missing,
           md5(string_agg(line, E'\n' ORDER BY line)) AS digest
      FROM (
        SELECT obs_date::text || '|' || vintage_at::text || '|' || coalesce(value::text, '~') ||
               '|' || status || '|' || is_latest::text AS line,
               is_latest, status
          FROM econ_observations) s`);
  const row = out.rows[0];
  return {
    rows: Number(row?.n ?? '0'),
    latest: Number(row?.latest ?? '0'),
    missing: Number(row?.missing ?? '0'),
    digest: row?.digest ?? null,
  };
}

/** Every vintage of one `obs_date`, oldest first. */
async function vintagesOf(tx: Tx, obsDate: string): Promise<
  { vintage_at: string; value: string | null; status: string; is_latest: boolean }[]
> {
  const out = await tx.execute<{
    vintage_at: string;
    value: string | null;
    status: string;
    is_latest: boolean;
  }>(sql`
    SELECT vintage_at::text AS vintage_at, value::text AS value, status, is_latest
      FROM econ_observations WHERE obs_date = ${obsDate}::date ORDER BY vintage_at`);
  return out.rows;
}

describe('fredSeries — vintage detection (QA-02, PROVIDERS §10.1)', () => {
  it('lands the whole history once, and a replay of the same bytes writes nothing', async () => {
    const first = await runFredSeries(jobContext(t.db));
    expect(first.errors).toEqual([]);
    expect(first.series).toBe(1);
    expect(first.observationsInserted).toBe(OBSERVATIONS);
    expect(first.vintagesOpened).toBe(0);

    const afterFirst = await obsShape(t.db);
    expect(afterFirst.rows).toBe(OBSERVATIONS);
    expect(afterFirst.latest).toBe(OBSERVATIONS);
    // 720 missing markers stored as NULL with `status 'missing'`, never as zero.
    expect(afterFirst.missing).toBe(MISSING);

    const zeroes = await t.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM econ_observations WHERE status = 'missing' AND value = 0`);
    expect(zeroes.rows[0]?.n).toBe('0');

    const second = await runFredSeries(jobContext(t.db));
    expect(second.errors).toEqual([]);
    expect(second.observationsInserted).toBe(0);
    expect(second.vintagesOpened).toBe(0);
    expect(second.observationsUnchanged).toBe(OBSERVATIONS);

    expect(await obsShape(t.db)).toEqual(afterFirst);

    const runs = await t.db.execute<{ n: string; statuses: string }>(sql`
      SELECT count(*)::text AS n, string_agg(DISTINCT status, ',') AS statuses
        FROM ingest_runs WHERE job_id = 'fredSeries'`);
    expect(runs.rows[0]?.n).toBe('2');
    expect(runs.rows[0]?.statuses).toBe('ok');
  });

  it('opens a new vintage exactly once for a changed value, and keeps the old one readable', async () => {
    await runFredSeries(jobContext(t.db));
    const id = await seriesId(t.db);

    // Put the table in the state a *previous* poll of a since-revised series leaves behind: a
    // different value for the same `obs_date`, at an earlier vintage. Nothing else is touched,
    // so the other 16,878 observations still agree with the file.
    const priorValue = PUBLISHED_VALUE + 0.5;
    await t.db.execute(sql`
      UPDATE econ_observations
         SET value = ${priorValue.toFixed(6)}::numeric,
             vintage_at = vintage_at - interval '1 day'
       WHERE series_id = ${id}::bigint AND obs_date = ${LAST_OBS_DATE}::date`);

    const revision = await runFredSeries(jobContext(t.db));
    expect(revision.errors).toEqual([]);
    // Exactly one new vintage across the whole 16,879-row history.
    expect(revision.vintagesOpened).toBe(1);
    expect(revision.observationsInserted).toBe(0);
    expect(revision.observationsUnchanged).toBe(OBSERVATIONS - 1);

    const shape = await obsShape(t.db);
    expect(shape.rows).toBe(OBSERVATIONS + 1);
    // One `is_latest` per `obs_date` — the partial unique index, asserted rather than assumed.
    expect(shape.latest).toBe(OBSERVATIONS);

    const vintages = await vintagesOf(t.db, LAST_OBS_DATE);
    expect(vintages).toHaveLength(2);
    // The prior vintage is still there, still carrying the number it always carried.
    expect(vintages[0]?.is_latest).toBe(false);
    expect(Number(vintages[0]?.value)).toBeCloseTo(priorValue, 6);
    // The new one is the capture's own instant and says it is a revision.
    expect(vintages[1]?.is_latest).toBe(true);
    expect(Number(vintages[1]?.value)).toBeCloseTo(PUBLISHED_VALUE, 6);
    expect(vintages[1]?.status).toBe('revised');
    expect(Date.parse(vintages[1]?.vintage_at ?? '')).toBe(raw.capturedAt);
    expect(Date.parse(vintages[1]?.vintage_at ?? '')).toBeGreaterThan(
      Date.parse(vintages[0]?.vintage_at ?? ''),
    );

    // EXACTLY ONCE: replaying the same bytes again settles, it does not re-revise.
    const settled = await runFredSeries(jobContext(t.db));
    expect(settled.vintagesOpened).toBe(0);
    expect(settled.observationsUnchanged).toBe(OBSERVATIONS);
    const afterSettled = await obsShape(t.db);
    expect(afterSettled.rows).toBe(OBSERVATIONS + 1);
    expect(afterSettled.digest).toBe(shape.digest);
    expect(await vintagesOf(t.db, LAST_OBS_DATE)).toHaveLength(2);
  });

  it('refuses to overwrite a later belief with an earlier capture', async () => {
    await runFredSeries(jobContext(t.db));
    const id = await seriesId(t.db);

    // The stored row disagrees with the file *and* is newer than the capture: a cached or
    // out-of-order response. The capture must be dropped, not written, or the table would depend
    // on delivery order rather than on time.
    await t.db.execute(sql`
      UPDATE econ_observations
         SET value = ${(PUBLISHED_VALUE + 1).toFixed(6)}::numeric,
             vintage_at = vintage_at + interval '1 day'
       WHERE series_id = ${id}::bigint AND obs_date = ${LAST_OBS_DATE}::date`);

    const stale = await runFredSeries(jobContext(t.db));
    expect(stale.vintagesOpened).toBe(0);
    const vintages = await vintagesOf(t.db, LAST_OBS_DATE);
    expect(vintages).toHaveLength(1);
    expect(Number(vintages[0]?.value)).toBeCloseTo(PUBLISHED_VALUE + 1, 6);
    expect(vintages[0]?.is_latest).toBe(true);
  });

  it('records the series facts the poll genuinely learns, and nothing else', async () => {
    await runFredSeries(jobContext(t.db));

    const rows = await t.db.execute<{
      series_code: string;
      units: string;
      frequency: string;
      first_obs_date: string;
      last_obs_date: string;
      last_updated_at: string;
    }>(sql`
      SELECT series_code, units, frequency, first_obs_date::text AS first_obs_date,
             last_obs_date::text AS last_obs_date, last_updated_at::text AS last_updated_at
        FROM econ_series WHERE source_id = ${FRED_SOURCE_ID} AND provider_code = ${SERIES}`);
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];
    expect(row?.series_code).toBe(SERIES);
    // From the seeded list, which is the only thing that knows them.
    expect(row?.units).toBe('Percent');
    expect(row?.frequency).toBe('D');
    // From the bytes.
    expect(row?.first_obs_date).toBe('1962-01-02');
    expect(row?.last_obs_date).toBe(LAST_OBS_DATE);
    expect(Date.parse(row?.last_updated_at ?? '')).toBe(raw.capturedAt);
  });

  it('refuses a series the list does not seed rather than inventing metadata', async () => {
    const result = await runFredSeries({
      ...jobContext(t.db),
      seriesIds: ['NOT_A_SEEDED_SERIES'],
    });
    expect(result.series).toBe(0);
    expect(result.errors.map((e) => e.code)).toEqual(['SERIES_NOT_SEEDED']);
    expect(
      (await t.db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM econ_observations`))
        .rows[0]?.n,
    ).toBe('0');
  });
});
