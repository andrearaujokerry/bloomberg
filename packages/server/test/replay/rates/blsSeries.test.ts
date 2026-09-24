/**
 * `bls-cpi.json` → `econ_observations`, through `ingest/jobs/blsSeries.ts`
 * (WORKPLAN §WP-11, QA-02, PROVIDERS §10.5, §13).
 *
 * **The property this file exists for is the single POST.** The keyless BLS tier allows 25 queries
 * a *day*: a job that fetched per series would exhaust the budget in one run and then serve
 * nothing until midnight — and it would look healthy while doing it, because BLS answers an
 * exhausted quota with HTTP 200. So the request count is asserted directly, from four angles:
 *
 *  1. one series seeded → **one** request, whose body is byte-for-byte the recorded one;
 *  2. *three* series seeded → still **one** request, carrying all three ids in one sorted
 *     `seriesid` array (and the two the payload does not answer become `field_population`
 *     warnings rather than silence);
 *  3. a second run on the same Eastern day spends **no** request at all, whatever the slot;
 *  4. `REQUEST_NOT_PROCESSED` — the shape a spent quota takes — writes nothing and no provenance.
 *
 * ## Two deliberate test doubles, and why each is honest
 *
 * The recorded capture was taken with **one** id and a 2024-2026 window, and the request body is
 * part of the request key (PROVIDERS.a §3.2), so a three-id body has no capture and never will.
 * {@link CountingStore} therefore records what the job asked for and answers from the one capture
 * that exists. It is a *counting* double: what is asserted is the question the job asked, which is
 * exactly the property under test, and the bytes that come back are still the recorded bytes. It
 * never opens a socket, and the primary path (test 1) runs against the unmodified key.
 *
 * {@link RefusingStore} answers with BLS's refusal envelope. There is no recorded capture of an
 * exhausted quota — one cannot be recorded without exhausting a real quota — and the behaviour it
 * guards (write nothing, spend nothing more) is the one that matters most in production, so the
 * envelope is synthesised here and labelled as synthesised.
 *
 * TESTS ARE SELF-SUFFICIENT (WORKPLAN §0.2): WP-15 owns the seed, so every `econ_series`,
 * `econ_releases` and `provenance` row this file needs is built inside its own transaction and no
 * literal id is named anywhere.
 *
 * This file lives under `test/replay/`, the single-worker `server-replay` project.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { VirtualClock } from '@terminal/core';

import {
  BLS_MAX_SERIES_PER_QUERY,
  BLS_TIMESERIES_URL,
  blsTimeseriesBody,
} from '../../../src/providers/bls/adapter.js';
import { parseBlsTimeseries } from '../../../src/providers/bls/parse.js';
import {
  ReplayStore,
  openReplayStore,
  requestKey,
} from '../../../src/providers/replayStore.js';
import {
  BLS_DEFAULT_SLOT,
  BLS_RELEASE_SLOT,
  BLS_SERIES_SCHEDULE,
  BLS_SOURCE_ID,
  blsFetchDecision,
  blsYearWindow,
  easternDate,
  job,
  runBlsSeries,
} from '../../../src/ingest/jobs/blsSeries.js';
import { ensureEconSeries } from '../../../src/ingest/jobs/fredSeries.js';
import { withTxDb } from '../../../src/test/db.js';

import type { Tx } from '../../../src/db/client.js';
import type { MarketJobContext } from '../../../src/ingest/jobs/cboeQuotes.js';
import type { RawRecord } from '../../../src/providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The capture, read once
// ─────────────────────────────────────────────────────────────────────────────────────────────

const CPI = 'CUUR0000SA0';
/** The window the capture was recorded with — §10.5's ten-year window, narrowed by the recorder. */
const WINDOW = { startYear: 2024, endYear: 2026 };

const store = openReplayStore();
const RECORDED_BODY = blsTimeseriesBody({ seriesIds: [CPI], ...WINDOW });
const raw = store.replay({
  providerId: BLS_SOURCE_ID,
  method: 'POST',
  url: BLS_TIMESERIES_URL,
  body: RECORDED_BODY,
});
const parsed = parseBlsTimeseries(raw.body);

/** Measured from the capture, not assumed. */
const OBSERVATIONS = 32;
const FIRST_OBS_DATE = '2024-01-01';
const LAST_OBS_DATE = '2026-08-01';
/** The one row BLS published as `'-'`, with the appropriations-lapse footnote (§10.5). */
const GAP_OBS_DATE = '2025-10-01';
const GAP_FOOTNOTE = 'Data unavailable due to the 2025 lapse in appropriations';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Clocks. 2026-09-15 is EDT, so ET + 4 h = UTC.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ET_DATE = '2026-09-15';
/** 09:00 ET — §10.5's default slot. */
const AT_0900_ET = Date.parse('2026-09-15T13:00:00Z');
/** 08:35 ET — §10.5's release-day slot. */
const AT_0835_ET = Date.parse('2026-09-15T12:35:00Z');
/** The frozen clock of the golden suites: 14:41 ET, which is not a slot at all. */
const AT_FROZEN = Date.parse('2026-09-15T18:41:28Z');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Test doubles (see the header)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface RecordedCall {
  providerId: string;
  method: string;
  url: string;
  body: string | undefined;
}

/**
 * Counts what the job asked for and answers from the recorded capture.
 *
 * `answerBody` rewrites the body used for the *lookup* only — the call that is asserted is the one
 * the job made. With `answerBody` unset it is a pure pass-through and the real key is exercised.
 */
class CountingStore extends ReplayStore {
  readonly calls: RecordedCall[] = [];

  constructor(
    source: ReplayStore,
    private readonly answerBody?: string,
  ) {
    super(source.dir, source.manifest);
  }

  override replay(req: {
    providerId: Parameters<ReplayStore['replay']>[0]['providerId'];
    method?: Parameters<ReplayStore['replay']>[0]['method'];
    url: string;
    body?: string;
    captureIndex?: number;
  }): RawRecord {
    this.calls.push({
      providerId: req.providerId,
      method: req.method ?? 'GET',
      url: req.url,
      body: req.body,
    });
    return super.replay(this.answerBody === undefined ? req : { ...req, body: this.answerBody });
  }
}

/** Answers with BLS's HTTP-200 refusal envelope, which no capture can hold (see the header). */
class RefusingStore extends ReplayStore {
  calls = 0;

  constructor(source: ReplayStore) {
    super(source.dir, source.manifest);
  }

  override replay(): RawRecord {
    this.calls += 1;
    const body = Buffer.from(
      JSON.stringify({
        status: 'REQUEST_NOT_PROCESSED',
        responseTime: 0,
        message: ['Daily threshold for Series exceeded.'],
        Results: {},
      }),
      'utf8',
    );
    return {
      ...raw,
      body,
      status: 200,
      sha256: 'f'.repeat(64),
      origin: 'replay',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The capture and the scheduler row — no database
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('blsSeries — the capture and the §13 scheduler row', () => {
  it('reads the recorded POST, never a socket', () => {
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.method).toBe('POST');
    expect(RECORDED_BODY).toBe('{"seriesid":["CUUR0000SA0"],"startyear":"2024","endyear":"2026"}');
    expect(raw.requestKey).toBe(
      requestKey(BLS_SOURCE_ID, 'POST', BLS_TIMESERIES_URL, RECORDED_BODY),
    );
    expect(parsed.rows.status).toBe('REQUEST_SUCCEEDED');
    expect(parsed.rows.observations).toHaveLength(OBSERVATIONS);
  });

  it('declares the §13 row, with §10.5’s two cadences folded into one cron', () => {
    expect(job.id).toBe('blsSeries');
    expect(job.priority).toBe(2);
    expect(job.timeoutMs).toBe(30_000);
    expect(job.provider).toBe(BLS_SOURCE_ID);
    // §13 gives two expressions — '35 8 * * 1-5' on release days, '0 9 * * *' otherwise — and an
    // `IngestJob` carries one. The union fires at both and `blsFetchDecision` picks the slot.
    expect(job.schedule).toBe(BLS_SERIES_SCHEDULE);
    expect(BLS_SERIES_SCHEDULE).toBe('0,35 8,9 * * *');
    expect(BLS_RELEASE_SLOT).toEqual({ hour: 8, minute: 35 });
    expect(BLS_DEFAULT_SLOT).toEqual({ hour: 9, minute: 0 });
  });

  it('asks for ten years, and no more than 25 ids in one query', () => {
    expect(blsYearWindow('2026-09-15')).toEqual({ startYear: 2017, endYear: 2026 });
    expect(BLS_MAX_SERIES_PER_QUERY).toBe(25);
    expect(easternDate(AT_0900_ET)).toBe(ET_DATE);
    // 00:30 UTC on the 16th is still the 15th in New York — the day the quota belongs to.
    expect(easternDate(Date.parse('2026-09-16T00:30:00Z'))).toBe(ET_DATE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The job
// ─────────────────────────────────────────────────────────────────────────────────────────────

const t = withTxDb();

function ctxOf(tx: Tx, at: number, replay: ReplayStore = store): MarketJobContext {
  return { tx, clock: new VirtualClock(at), replay };
}

async function seedSeries(tx: Tx, providerCode: string): Promise<number> {
  return ensureEconSeries(tx, {
    seriesCode: providerCode,
    sourceId: BLS_SOURCE_ID,
    providerCode,
    name: `BLS ${providerCode}`,
    units: 'Index 1982-1984=100',
    frequency: 'M',
    seasonalAdj: 'NSA',
    decimals: 3,
  });
}

interface ObsRow {
  obs_date: string;
  value: string | null;
  status: string;
  footnote: string | null;
  is_latest: boolean;
  vintage_at: string;
}

async function observationsOf(tx: Tx, seriesId: number): Promise<ObsRow[]> {
  const res = await tx.execute<ObsRow>(sql`
    SELECT obs_date::text AS obs_date, value::text AS value, status, footnote, is_latest,
           vintage_at::text AS vintage_at
      FROM econ_observations WHERE series_id = ${seriesId}::bigint
     ORDER BY obs_date, vintage_at`);
  return res.rows;
}

async function countOf(tx: Tx, table: 'econ_observations' | 'provenance'): Promise<number> {
  const res = await tx.execute<{ n: string }>(
    table === 'provenance'
      ? sql`SELECT count(*)::text AS n FROM provenance WHERE source_id = ${BLS_SOURCE_ID}`
      : sql`SELECT count(*)::text AS n FROM econ_observations`,
  );
  return Number(res.rows[0]?.n ?? '0');
}

describe('blsSeries — one POST, and what it writes', () => {
  it('spends one request for the seeded series and lands the whole window', async () => {
    const tx = t.db;
    const seriesId = await seedSeries(tx, CPI);
    const counting = new CountingStore(store);

    const first = await runBlsSeries(ctxOf(tx, AT_FROZEN, counting), {
      force: true,
      window: WINDOW,
    });
    expect(first.errors).toEqual([]);
    expect(first.decision.reason).toBe('FORCED');

    // THE assertion: one POST, carrying the id list, at the recorded key.
    expect(first.requests).toBe(1);
    expect(counting.calls).toHaveLength(1);
    expect(counting.calls[0]).toEqual({
      providerId: BLS_SOURCE_ID,
      method: 'POST',
      url: BLS_TIMESERIES_URL,
      body: RECORDED_BODY,
    });
    expect(first.seriesIds).toEqual([CPI]);

    expect(first.observations.inserted).toBe(OBSERVATIONS);
    expect(first.observations.revised).toBe(0);
    expect(first.emptySeries).toEqual([]);
    expect(first.provenanceIds).toHaveLength(1);

    const rows = await observationsOf(tx, seriesId);
    expect(rows).toHaveLength(OBSERVATIONS);
    expect(rows.every((r) => r.is_latest)).toBe(true);
    expect(rows[0]?.obs_date).toBe(FIRST_OBS_DATE);
    expect(rows.at(-1)?.obs_date).toBe(LAST_OBS_DATE);
    // Monthly periods land on the first of the month, never on the publication day.
    expect(rows.every((r) => r.obs_date.endsWith('-01'))).toBe(true);
    // The vintage is the capture instant, not the clock: replaying one capture is one vintage.
    expect(new Set(rows.map((r) => r.vintage_at)).size).toBe(1);
    expect(Date.parse(rows[0]!.vintage_at)).toBe(raw.capturedAt);

    // §10.5: `'-'` is a published gap — NULL with `status 'missing'` and BLS's footnote, never 0.
    const gap = rows.find((r) => r.obs_date === GAP_OBS_DATE);
    expect(gap?.value).toBeNull();
    expect(gap?.status).toBe('missing');
    expect(gap?.footnote).toBe(GAP_FOOTNOTE);
    expect(rows.filter((r) => r.footnote !== null)).toHaveLength(1);

    // The August index, to the third decimal the file publishes.
    const august = rows.find((r) => r.obs_date === LAST_OBS_DATE);
    expect(Number(august?.value)).toBe(334.98);

    // The series' own span is advanced from what landed.
    const series = await tx.execute<{ first: string; last: string; updated: string }>(sql`
      SELECT first_obs_date::text AS first, last_obs_date::text AS last,
             last_updated_at::text AS updated
        FROM econ_series WHERE series_id = ${seriesId}::bigint`);
    expect(series.rows[0]?.first).toBe(FIRST_OBS_DATE);
    expect(series.rows[0]?.last).toBe(LAST_OBS_DATE);
  }, 120_000);

  it('writes nothing on a replay of the same bytes', async () => {
    const tx = t.db;
    const seriesId = await seedSeries(tx, CPI);
    const ctx = ctxOf(tx, AT_FROZEN);

    const first = await runBlsSeries(ctx, { force: true, window: WINDOW });
    expect(first.errors).toEqual([]);
    const before = await observationsOf(tx, seriesId);
    expect(before).toHaveLength(OBSERVATIONS);

    const second = await runBlsSeries(ctx, { force: true, window: WINDOW });
    expect(second.errors).toEqual([]);
    expect(second.requests).toBe(1);
    expect(second.observations.inserted).toBe(0);
    expect(second.observations.revised).toBe(0);
    expect(second.observations.unchanged).toBe(OBSERVATIONS);
    // Byte-identical, vintages included.
    expect(await observationsOf(tx, seriesId)).toEqual(before);

    // Two executions, two `ingest_runs` rows — exactly one per execution (PROVIDERS §13).
    const runs = await tx.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM ingest_runs WHERE job_id = 'blsSeries'`);
    expect(runs.rows[0]?.n).toBe('2');
  }, 120_000);

  it('carries every headline series in ONE request, not one request per series', async () => {
    const tx = t.db;
    const extra = ['CES0000000001', 'LNS14000000'];
    const ids = [CPI, ...extra];
    for (const code of ids) await seedSeries(tx, code);

    // The recorded capture holds one id; the double answers from it while recording the question.
    const counting = new CountingStore(store, RECORDED_BODY);
    const result = await runBlsSeries(ctxOf(tx, AT_FROZEN, counting), {
      force: true,
      window: WINDOW,
    });

    expect(result.errors).toEqual([]);
    expect(result.requests).toBe(1);
    expect(counting.calls).toHaveLength(1);
    // One sorted `seriesid` array carrying all three — the whole point of §10.5.
    expect(counting.calls[0]?.body).toBe(
      blsTimeseriesBody({ seriesIds: [...ids].sort(), ...WINDOW }),
    );
    expect(result.seriesIds).toEqual([...ids].sort());

    // §10.5: a series that came back empty while the envelope succeeded is a warning, not silence.
    expect(result.emptySeries.sort()).toEqual([...extra].sort());
    const events = await tx.execute<{ subject: string; kind: string; severity: string }>(sql`
      SELECT subject, kind, severity FROM dq_events
       WHERE source_id = ${BLS_SOURCE_ID} AND kind = 'field_population' ORDER BY subject`);
    expect(events.rows.map((r) => r.subject)).toEqual(extra.map((c) => `e:${c}`).sort());
    expect(events.rows.every((r) => r.severity === 'warn')).toBe(true);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. The daily budget (§10.5) — the gate that keeps a crash loop inside 25 queries
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('blsSeries — the 25-queries-a-day budget', () => {
  it('fetches at 09:00 ET and refuses a second fetch on the same Eastern day', async () => {
    const tx = t.db;
    await seedSeries(tx, CPI);
    const counting = new CountingStore(store);

    const first = await runBlsSeries(ctxOf(tx, AT_0900_ET, counting), { window: WINDOW });
    expect(first.decision).toEqual({ fetch: true, reason: 'DEFAULT_SLOT', etDate: ET_DATE });
    expect(first.requests).toBe(1);

    // A restart five minutes later — the crash-loop case §10.5 is written against.
    const second = await runBlsSeries(
      ctxOf(tx, AT_0900_ET + 5 * 60_000, counting),
      { window: WINDOW },
    );
    expect(second.decision.reason).toBe('ALREADY_POLLED_TODAY');
    expect(second.requests).toBe(0);
    expect(second.fetched).toBe(0);
    expect(counting.calls).toHaveLength(1);

    // …and the next Eastern day is a new budget.
    const tomorrow = await blsFetchDecision(ctxOf(tx, AT_0900_ET + 24 * 3_600_000));
    expect(tomorrow).toEqual({ fetch: true, reason: 'DEFAULT_SLOT', etDate: '2026-09-16' });
  }, 120_000);

  it('takes the 08:35 slot only on a day BLS has a release scheduled', async () => {
    const tx = t.db;

    // No BLS release on the calendar: 08:35 is not this day's slot.
    expect(await blsFetchDecision(ctxOf(tx, AT_0835_ET))).toEqual({
      fetch: false,
      reason: 'NOT_A_SLOT',
      etDate: ET_DATE,
    });
    // Neither is the frozen clock's 14:41 ET.
    expect((await blsFetchDecision(ctxOf(tx, AT_FROZEN))).reason).toBe('NOT_A_SLOT');

    await seedBlsReleaseEvent(tx, '2026-09-15T12:30:00Z');
    expect(await blsFetchDecision(ctxOf(tx, AT_0835_ET))).toEqual({
      fetch: true,
      reason: 'RELEASE_SLOT',
      etDate: ET_DATE,
    });
    // The release is the 15th's, so the 16th's 08:35 is still not a slot.
    expect((await blsFetchDecision(ctxOf(tx, AT_0835_ET + 24 * 3_600_000))).reason).toBe(
      'NOT_A_SLOT',
    );
  }, 120_000);

  it('writes nothing at all when BLS refuses the request (HTTP 200, REQUEST_NOT_PROCESSED)', async () => {
    const tx = t.db;
    const seriesId = await seedSeries(tx, CPI);
    const refusing = new RefusingStore(store);

    const before = { obs: await countOf(tx, 'econ_observations'), prov: await countOf(tx, 'provenance') };
    const result = await runBlsSeries(ctxOf(tx, AT_FROZEN, refusing), {
      force: true,
      window: WINDOW,
    });

    expect(refusing.calls).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('BLS_REQUEST_NOT_PROCESSED');
    expect(result.errors[0]?.message).toContain('REQUEST_NOT_PROCESSED');
    expect(result.errors[0]?.message).toContain('Daily threshold');
    expect(result.observations.inserted).toBe(0);

    // Nothing written, and — because the envelope is checked before any provenance row —
    // not even a provenance row claiming a fetch that published nothing.
    expect(await observationsOf(tx, seriesId)).toEqual([]);
    expect(await countOf(tx, 'econ_observations')).toBe(before.obs);
    expect(await countOf(tx, 'provenance')).toBe(before.prov);

    const dq = await tx.execute<{ kind: string; severity: string }>(sql`
      SELECT kind, severity FROM dq_events WHERE source_id = ${BLS_SOURCE_ID}`);
    expect(dq.rows).toEqual([{ kind: 'poll_anomaly', severity: 'error' }]);

    // The run is recorded as failed, so `sys:status` can say BLS is degraded for the day.
    const runs = await tx.execute<{ status: string }>(sql`
      SELECT status FROM ingest_runs WHERE job_id = 'blsSeries'`);
    expect(runs.rows.map((r) => r.status)).toEqual(['failed']);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Seed helpers — this file builds everything it needs (WORKPLAN §0.2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function seedProvenance(tx: Tx): Promise<number> {
  const res = await tx.execute<{ provenance_id: string }>(sql`
    INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                            http_status, bytes, captured_at, adapter_version)
    VALUES ('internal.derived', 'test:bls:calendar', 'test://bls/calendar',
            sha256('test:bls:calendar'::bytea), sha256('test:bls:calendar'::bytea),
            200, 0, timestamptz '2026-09-01 00:00:00+00', 'test/1.0.0')
    RETURNING provenance_id`);
  return Number(res.rows[0]!.provenance_id);
}

/** One `bls.schedule` release with one scheduled event — what makes 08:35 a slot. */
async function seedBlsReleaseEvent(tx: Tx, scheduledAt: string): Promise<void> {
  const provenanceId = await seedProvenance(tx);
  const release = await tx.execute<{ release_id: string }>(sql`
    INSERT INTO econ_releases (source_id, provider_release_id, name, country, url, importance)
    VALUES ('bls.schedule', 'cpi', 'Consumer Price Index', 'US', NULL, 1)
    RETURNING release_id`);
  await tx.execute(sql`
    INSERT INTO econ_release_events (release_id, scheduled_at, time_known, period_label,
                                     consensus_unavailable_reason, status, provenance_id)
    VALUES (${Number(release.rows[0]!.release_id)}::bigint, ${scheduledAt}::timestamptz, true,
            'August 2026', 'NO_SOURCE', 'scheduled', ${provenanceId}::bigint)`);
}
