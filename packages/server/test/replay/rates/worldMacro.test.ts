/**
 * `worldbank` + `imf-weo.json` → `econ_series` / `econ_observations`, through
 * `ingest/jobs/worldMacro.ts` (WORKPLAN §WP-11, QA-02, PROVIDERS §10.7, §10.8, §13).
 *
 * Four properties, each measured from the recorded bytes:
 *
 *  1. **The `[meta, data]` tuple becomes rows.** The capture is page 1 of 22 at `per_page=3`, so
 *     three annual observations land, stamped at the period *start* (`'2025'` → `2025-01-01`),
 *     with GDP carried to the last digit the payload publishes — 30 769 700 000 000 is thirteen
 *     significant figures and a float round-trip would lose them.
 *  2. **A re-run writes nothing**, and the vintage rule is `fredSeries.ts`'s, not a second copy:
 *     the same bytes replayed are 3 unchanged, 0 inserted, 0 revised.
 *  3. **A changed value opens exactly one vintage** and flips `is_latest` once — the World Bank
 *     revises its back series every July, so this is the ordinary case for this source.
 *  4. **The HTTP-200 error shape writes nothing.** §10.7's first trap: an error comes back as a
 *     *one*-element array with status 200, and a job that read `[1]` off it would write an empty
 *     series over a good one.
 *
 * And the IMF half, whose state is fixed by PROVIDERS §16.9: **the observations endpoint has no
 * recorded capture**. The catalogue does, so `econ_series` is built from it and the values call is
 * reported as `NO_CAPTURE` and never made. The replay wall is intact either way — what is asserted
 * is that the job *declines* rather than throwing, and that it invents no observation in the
 * meantime.
 *
 * TESTS ARE SELF-SUFFICIENT (WORKPLAN §0.2): every row is built inside this file's transaction and
 * no literal id is named. This file lives under `test/replay/`, the single-worker `server-replay`
 * project.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { VirtualClock } from '@terminal/core';

import { IMF_INDICATORS_URL, imfUrl } from '../../../src/providers/imf/adapter.js';
import { ReplayStore, openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { worldBankUrl } from '../../../src/providers/worldbank/adapter.js';
import { parseWorldBank } from '../../../src/providers/worldbank/parse.js';
import {
  IMF_DEFAULT_AREA,
  IMF_SOURCE_ID,
  IMF_WEO_HEADLINE_INDICATORS,
  IMF_WEO_RELEASE_NAME,
  WORLDBANK_DEFAULT_TARGETS,
  WORLDBANK_SOURCE_ID,
  WORLD_MACRO_SCHEDULE,
  job,
  runWorldMacro,
} from '../../../src/ingest/jobs/worldMacro.js';
import { withTxDb } from '../../../src/test/db.js';

import type { Tx } from '../../../src/db/client.js';
import type { MarketJobContext } from '../../../src/ingest/jobs/cboeQuotes.js';
import type { RawRecord } from '../../../src/providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The captures, read once
// ─────────────────────────────────────────────────────────────────────────────────────────────

const INDICATOR = 'NY.GDP.MKTP.CD';
const COUNTRY = 'US';
/** The capture was recorded with `per_page=3`; production uses 100 (§10.7). */
const PER_PAGE = 3;

const store = openReplayStore();
const WB_URL = worldBankUrl({ country: COUNTRY, indicator: INDICATOR, page: 1, perPage: PER_PAGE });
const wbRaw = store.replay({ providerId: WORLDBANK_SOURCE_ID, url: WB_URL });
const wbParsed = parseWorldBank(wbRaw.body);

const imfRaw = store.replay({ providerId: IMF_SOURCE_ID, url: IMF_INDICATORS_URL });

/** Measured from the capture. */
const OBSERVATIONS = 3;
const YEARS = ['2023-01-01', '2024-01-01', '2025-01-01'];
const GDP_2025 = '30769700000000';
const LAST_UPDATED = '2026-07-13';

const AT = Date.parse('2026-09-15T18:41:28Z');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A double for the one shape no capture can hold: §10.7's HTTP-200 error
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Answers the World Bank URL with the error shape §10.7 documents — a **one**-element array with
 * HTTP 200. It cannot be recorded (it is what the API returns for a bad indicator, and recording
 * one would pin a capture of a mistake), so it is synthesised here and labelled as synthesised.
 * Every other request still goes to the recorded bytes.
 */
class ErrorShapeStore extends ReplayStore {
  constructor(source: ReplayStore) {
    super(source.dir, source.manifest);
  }

  override replay(req: Parameters<ReplayStore['replay']>[0]): RawRecord {
    if (req.providerId !== WORLDBANK_SOURCE_ID) return super.replay(req);
    return {
      ...wbRaw,
      body: Buffer.from(
        JSON.stringify([
          { message: [{ id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' }] },
        ]),
        'utf8',
      ),
      status: 200,
      sha256: 'e'.repeat(64),
      origin: 'replay',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The captures and the scheduler row — no database
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('worldMacro — the captures and the §13 scheduler row', () => {
  it('reads both recorded pages, never a socket', () => {
    expect(wbRaw.origin).toBe('replay');
    expect(wbRaw.status).toBe(200);
    expect(wbRaw.requestKey).toBe(requestKey(WORLDBANK_SOURCE_ID, 'GET', WB_URL));
    expect(wbParsed.rows.meta).toMatchObject({
      page: 1,
      pages: 22,
      perPage: PER_PAGE,
      total: 66,
      lastUpdated: LAST_UPDATED,
    });
    expect(wbParsed.rows.observations).toHaveLength(OBSERVATIONS);

    expect(imfRaw.origin).toBe('replay');
    expect(imfRaw.requestKey).toBe(requestKey(IMF_SOURCE_ID, 'GET', IMF_INDICATORS_URL));
    // §16.9: the observations endpoint is NOT recorded, and this is the assertion that says so.
    expect(
      store.has(
        requestKey(
          IMF_SOURCE_ID,
          'GET',
          imfUrl({ kind: 'values', indicator: 'NGDP_RPCH', area: IMF_DEFAULT_AREA.area }),
        ),
      ),
    ).toBe(false);
  });

  it('declares the §13 row', () => {
    expect(job.id).toBe('worldMacro');
    expect(job.schedule).toBe(WORLD_MACRO_SCHEDULE);
    expect(WORLD_MACRO_SCHEDULE).toBe('0 4 * * 0');
    expect(job.priority).toBe(3);
    expect(job.timeoutMs).toBe(600_000);
    expect(job.provider).toEqual([WORLDBANK_SOURCE_ID, IMF_SOURCE_ID]);
    expect(WORLDBANK_DEFAULT_TARGETS).toEqual([{ indicator: INDICATOR, country: COUNTRY }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The job
// ─────────────────────────────────────────────────────────────────────────────────────────────

const t = withTxDb();

function ctxOf(tx: Tx, replay: ReplayStore = store): MarketJobContext {
  return { tx, clock: new VirtualClock(AT), replay };
}

/** The World Bank half alone: one page, no IMF. */
const WB_ONLY = { perPage: PER_PAGE, maxPages: 1, imf: null } as const;

async function seriesIdOf(tx: Tx, sourceId: string, providerCode: string): Promise<number> {
  const res = await tx.execute<{ series_id: string }>(sql`
    SELECT series_id FROM econ_series
     WHERE source_id = ${sourceId} AND provider_code = ${providerCode}`);
  const row = res.rows[0];
  if (row === undefined) throw new Error(`no econ_series row for ${sourceId}/${providerCode}`);
  return Number(row.series_id);
}

interface ObsRow {
  obs_date: string;
  value: string | null;
  status: string;
  is_latest: boolean;
  vintage_at: string;
}

async function observationsOf(tx: Tx, seriesId: number): Promise<ObsRow[]> {
  const res = await tx.execute<ObsRow>(sql`
    SELECT obs_date::text AS obs_date, value::text AS value, status, is_latest,
           vintage_at::text AS vintage_at
      FROM econ_observations WHERE series_id = ${seriesId}::bigint
     ORDER BY obs_date, vintage_at`);
  return res.rows;
}

describe('worldMacro — the World Bank half (§10.7)', () => {
  it('turns the [meta, data] tuple into a series and its annual observations', async () => {
    const tx = t.db;
    const result = await runWorldMacro(ctxOf(tx), WB_ONLY);

    expect(result.errors).toEqual([]);
    expect(result.worldBank.requests).toBe(1);
    expect(result.worldBank.series).toBe(1);
    expect(result.worldBank.observations.inserted).toBe(OBSERVATIONS);
    expect(result.worldBank.observations.revised).toBe(0);

    const seriesId = await seriesIdOf(tx, WORLDBANK_SOURCE_ID, INDICATOR);
    const rows = await observationsOf(tx, seriesId);
    expect(rows.map((r) => r.obs_date)).toEqual(YEARS);
    expect(rows.every((r) => r.is_latest)).toBe(true);
    expect(rows.every((r) => r.status === 'final')).toBe(true);
    // Annual series are stamped at the period start, never at the year end.
    expect(rows.every((r) => r.obs_date.endsWith('-01-01'))).toBe(true);
    // The vintage is the capture instant, so one capture is one vintage.
    expect(new Set(rows.map((r) => r.vintage_at)).size).toBe(1);
    expect(Date.parse(rows[0]!.vintage_at)).toBe(wbRaw.capturedAt);

    // Thirteen significant figures, intact.
    const gdp2025 = rows.find((r) => r.obs_date === '2025-01-01');
    expect(gdp2025?.value?.replace(/\.0+$/, '')).toBe(GDP_2025);

    const series = await tx.execute<{
      name: string;
      country: string;
      frequency: string;
      first: string;
      last: string;
      release: string;
    }>(sql`
      SELECT s.name, s.country, s.frequency, s.first_obs_date::text AS first,
             s.last_obs_date::text AS last, r.name AS release
        FROM econ_series s JOIN econ_releases r ON r.release_id = s.release_id
       WHERE s.series_id = ${seriesId}::bigint`);
    expect(series.rows[0]).toEqual({
      name: 'GDP (current US$)',
      country: COUNTRY,
      frequency: 'A',
      first: '2023-01-01',
      last: '2025-01-01',
      release: 'World Development Indicators',
    });
  }, 120_000);

  it('writes nothing on a replay of the same bytes', async () => {
    const tx = t.db;
    const first = await runWorldMacro(ctxOf(tx), WB_ONLY);
    expect(first.errors).toEqual([]);
    const seriesId = await seriesIdOf(tx, WORLDBANK_SOURCE_ID, INDICATOR);
    const before = await observationsOf(tx, seriesId);

    const second = await runWorldMacro(ctxOf(tx), WB_ONLY);
    expect(second.errors).toEqual([]);
    expect(second.worldBank.requests).toBe(1);
    expect(second.worldBank.observations).toEqual({
      inserted: 0,
      revised: 0,
      unchanged: OBSERVATIONS,
      stale: 0,
    });
    expect(await observationsOf(tx, seriesId)).toEqual(before);

    const runs = await tx.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM ingest_runs WHERE job_id = 'worldMacro'`);
    expect(runs.rows[0]?.n).toBe('2');
  }, 120_000);

  it('opens exactly one vintage when a published value changes', async () => {
    const tx = t.db;
    await runWorldMacro(ctxOf(tx), WB_ONLY);
    const seriesId = await seriesIdOf(tx, WORLDBANK_SOURCE_ID, INDICATOR);

    // The state a revision leaves behind: a DIFFERENT value at an EARLIER vintage, which is what
    // last week's poll would have written. The file then disagrees with it.
    await tx.execute(sql`
      UPDATE econ_observations
         SET value = 30000000000000, vintage_at = timestamptz '2026-07-01 00:00:00+00'
       WHERE series_id = ${seriesId}::bigint AND obs_date = date '2025-01-01'`);

    const revised = await runWorldMacro(ctxOf(tx), WB_ONLY);
    expect(revised.errors).toEqual([]);
    expect(revised.worldBank.observations.revised).toBe(1);
    expect(revised.worldBank.observations.inserted).toBe(0);
    expect(revised.worldBank.observations.unchanged).toBe(OBSERVATIONS - 1);

    const vintages = (await observationsOf(tx, seriesId)).filter(
      (r) => r.obs_date === '2025-01-01',
    );
    expect(vintages).toHaveLength(2);
    // The old belief is still readable, with the number it always had, and is no longer latest.
    expect(vintages[0]?.is_latest).toBe(false);
    expect(Number(vintages[0]?.value)).toBe(30_000_000_000_000);
    expect(vintages[1]?.is_latest).toBe(true);
    expect(vintages[1]?.status).toBe('revised');
    expect(vintages[1]?.value?.replace(/\.0+$/, '')).toBe(GDP_2025);

    // Exactly once: a further replay settles rather than re-opening a vintage every poll.
    const again = await runWorldMacro(ctxOf(tx), WB_ONLY);
    expect(again.worldBank.observations.revised).toBe(0);
    expect(again.worldBank.observations.unchanged).toBe(OBSERVATIONS);
    expect(
      (await observationsOf(tx, seriesId)).filter((r) => r.obs_date === '2025-01-01'),
    ).toHaveLength(2);
  }, 120_000);

  it('stamps last_updated_at from the capture, not from the clock (ANAL-08)', async () => {
    const tx = t.db;
    await runWorldMacro(ctxOf(tx), WB_ONLY);
    const seriesId = await seriesIdOf(tx, WORLDBANK_SOURCE_ID, INDICATOR);
    const stampOf = async (): Promise<string | null> => {
      const res = await tx.execute<{ last_updated_at: string | null }>(sql`
        SELECT last_updated_at::text AS last_updated_at FROM econ_series
         WHERE series_id = ${seriesId}::bigint`);
      return res.rows[0]?.last_updated_at ?? null;
    };
    const first = await stampOf();
    expect(first).not.toBeNull();
    expect(Date.parse(first!)).toBe(wbRaw.capturedAt);
    // Not the clock: the frozen `asOf` and the capture instant are different instants, and the
    // column names the second one.
    expect(Date.parse(first!)).not.toBe(AT);

    // A day later, the same bytes. A wall-clock stamp would move; a capture stamp cannot.
    const later: MarketJobContext = { tx, clock: new VirtualClock(AT + 86_400_000), replay: store };
    const second = await runWorldMacro(later, WB_ONLY);
    expect(second.errors).toEqual([]);
    expect(await stampOf()).toBe(first);
  }, 120_000);

  it('reports an uncaptured page as a capture gap, never as a job failure (§16.9)', async () => {
    const tx = t.db;
    // No options at all: the production walk, at `per_page=100`, for which no page is recorded.
    const result = await runWorldMacro(ctxOf(tx));

    expect(result.errors).toEqual([]);
    expect(result.worldBank.noCapture).toEqual([
      worldBankUrl({ country: COUNTRY, indicator: INDICATOR, page: 1, perPage: 100 }),
    ]);
    // Declined, so no request was made and nothing was invented for the World Bank half.
    expect(result.worldBank.requests).toBe(0);
    expect(result.worldBank.series).toBe(0);
    expect(result.worldBank.observations.inserted).toBe(0);
    // The IMF half still ran: one source's capture gap does not take the job down.
    expect(result.imf.series).toBe(IMF_WEO_HEADLINE_INDICATORS.length);

    const run = await tx.execute<{ status: string }>(sql`
      SELECT status FROM ingest_runs WHERE job_id = 'worldMacro'
       ORDER BY run_id DESC LIMIT 1`);
    expect(run.rows[0]?.status).not.toBe('failed');

    const wbObs = await tx.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM econ_observations o
        JOIN econ_series s ON s.series_id = o.series_id
       WHERE s.source_id = ${WORLDBANK_SOURCE_ID}`);
    expect(wbObs.rows[0]?.n).toBe('0');
  }, 120_000);

  it('writes nothing for §10.7’s HTTP-200 error shape', async () => {
    const tx = t.db;
    // A good run first, so the test proves the error does not overwrite good data.
    await runWorldMacro(ctxOf(tx), WB_ONLY);
    const seriesId = await seriesIdOf(tx, WORLDBANK_SOURCE_ID, INDICATOR);
    const before = await observationsOf(tx, seriesId);

    const result = await runWorldMacro(ctxOf(tx, new ErrorShapeStore(store)), WB_ONLY);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('WORLDBANK_PAYLOAD_NOT_A_TUPLE');
    expect(result.worldBank.observations.inserted).toBe(0);
    expect(await observationsOf(tx, seriesId)).toEqual(before);

    const dq = await tx.execute<{ kind: string; severity: string }>(sql`
      SELECT kind, severity FROM dq_events WHERE source_id = ${WORLDBANK_SOURCE_ID}`);
    expect(dq.rows).toEqual([{ kind: 'poll_anomaly', severity: 'error' }]);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. The IMF half (§10.8) — a catalogue with a capture, observations without one (§16.9)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('worldMacro — the IMF half (§10.8, §16.9)', () => {
  it('builds econ_series from the catalogue and declines the unrecorded values endpoint', async () => {
    const tx = t.db;
    const result = await runWorldMacro(ctxOf(tx), { worldBank: null, perPage: PER_PAGE });

    expect(result.errors).toEqual([]);
    // One request: the catalogue. The six values calls are not made at all.
    expect(result.imf.requests).toBe(1);
    expect(result.imf.series).toBe(IMF_WEO_HEADLINE_INDICATORS.length);
    expect(result.imf.observations.inserted).toBe(0);
    expect(result.imf.noCapture).toHaveLength(IMF_WEO_HEADLINE_INDICATORS.length);
    expect(result.imf.noCapture).toContain(
      imfUrl({ kind: 'values', indicator: 'NGDP_RPCH', area: IMF_DEFAULT_AREA.area }),
    );

    const series = await tx.execute<{
      provider_code: string;
      name: string;
      units: string;
      frequency: string;
      country: string;
      release: string;
    }>(sql`
      SELECT s.provider_code, s.name, s.units, s.frequency, s.country, r.name AS release
        FROM econ_series s JOIN econ_releases r ON r.release_id = s.release_id
       WHERE s.source_id = ${IMF_SOURCE_ID}
       ORDER BY s.provider_code`);
    expect(series.rows.map((r) => r.provider_code)).toEqual([...IMF_WEO_HEADLINE_INDICATORS]);
    expect(series.rows.every((r) => r.release === IMF_WEO_RELEASE_NAME)).toBe(true);
    expect(series.rows.every((r) => r.frequency === 'A')).toBe(true);
    expect(series.rows.every((r) => r.country === IMF_DEFAULT_AREA.country)).toBe(true);
    // The label is whitespace-collapsed: `NGDPDPC` is published with a trailing newline.
    expect(series.rows.find((r) => r.provider_code === 'NGDP_RPCH')).toMatchObject({
      name: 'Real GDP growth',
      units: 'Annual percent change',
    });
    expect(series.rows.find((r) => r.provider_code === 'NGDPDPC')?.name).toBe(
      'GDP per capita, current prices',
    );

    // Nothing was invented in the absence of the values capture.
    const obs = await tx.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM econ_observations o
        JOIN econ_series s ON s.series_id = o.series_id
       WHERE s.source_id = ${IMF_SOURCE_ID}`);
    expect(obs.rows[0]?.n).toBe('0');
  }, 120_000);

  it('re-reads the catalogue without rewriting a thing', async () => {
    const tx = t.db;
    await runWorldMacro(ctxOf(tx), { worldBank: null, perPage: PER_PAGE });
    const before = await tx.execute<{ digest: string }>(sql`
      SELECT md5(string_agg(provider_code || '|' || name || '|' || units, E'\n' ORDER BY provider_code))
             AS digest
        FROM econ_series WHERE source_id = ${IMF_SOURCE_ID}`);

    const second = await runWorldMacro(ctxOf(tx), { worldBank: null, perPage: PER_PAGE });
    expect(second.errors).toEqual([]);
    const after = await tx.execute<{ digest: string }>(sql`
      SELECT md5(string_agg(provider_code || '|' || name || '|' || units, E'\n' ORDER BY provider_code))
             AS digest
        FROM econ_series WHERE source_id = ${IMF_SOURCE_ID}`);
    expect(after.rows[0]?.digest).toBe(before.rows[0]?.digest);
  }, 120_000);
});
