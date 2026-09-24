/**
 * The ECO calendar and the FOMC list, through `ingest/jobs/econCalendar.ts`
 * (WORKPLAN §WP-11, QA-02, PROVIDERS §10.2, §10.6, §10.9, §13).
 *
 * Three sources, and the point of the file is that they **fail independently**:
 *
 *  - `fred.calendar` — the recorded `/releases/calendar` page: 34 releases, 34 events, every one
 *    on 2026-09-15, 14 with a published time and 20 falling back to 08:30 ET with
 *    `time_known = false`;
 *  - `bls.schedule` — the recorded `september26.htm`: 13 releases, 16 events, **all** with a known
 *    time, which is what §10.6 means by "the source that upgrades FRED's default". October is not
 *    recorded, so the job reports it and moves on rather than throwing at the replay wall;
 *  - `fed.fomc` — **no capture exists at all** (PROVIDERS §16.9). The job declines the fetch and
 *    writes nothing; the parser is exercised directly against a hand-written structural sample of
 *    the page, which is labelled as a sample and never presented as a capture. Recording the real
 *    page is the prerequisite §16.9 names for covering this half under QA-02.
 *
 * Two release rows for the same CPI — FRED's `rid` and BLS's slug — is deliberate and asserted:
 * `econ_releases` is unique on `(source_id, provider_release_id)` and CONTRACTS defines no
 * cross-source release identity, so ECO chooses the event with the known time at read time.
 *
 * TESTS ARE SELF-SUFFICIENT (WORKPLAN §0.2). This file lives under `test/replay/`, the
 * single-worker `server-replay` project.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { VirtualClock } from '@terminal/core';

import { blsScheduleUrl } from '../../../src/providers/bls/adapter.js';
import { FRED_CALENDAR_URL } from '../../../src/providers/fred/adapter.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import {
  BLS_SCHEDULE_SOURCE_ID,
  ECON_CALENDAR_SCHEDULE,
  FED_FOMC_SOURCE_ID,
  FOMC_CALENDAR_URL,
  FRED_CALENDAR_SOURCE_ID,
  MIN_FOMC_MEETINGS,
  calendarMonths,
  fomcStatementInstant,
  job,
  parseFomcCalendar,
  parseMeetingDays,
  runEconCalendar,
  upsertFomcMeetings,
  upsertReleaseEvents,
} from '../../../src/ingest/jobs/econCalendar.js';
import { upsertEconRelease } from '../../../src/ingest/jobs/worldMacro.js';
import { withTxDb } from '../../../src/test/db.js';

import type { Tx } from '../../../src/db/client.js';
import type { MarketJobContext } from '../../../src/ingest/jobs/cboeQuotes.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The captures, read once
// ─────────────────────────────────────────────────────────────────────────────────────────────

const store = openReplayStore();
const SEPTEMBER_URL = blsScheduleUrl(2026, 9);
const OCTOBER_URL = blsScheduleUrl(2026, 10);

/** Measured from the captures (and pinned identically by the two `replay/providers` suites). */
const FRED_RELEASES = 34;
const FRED_EVENTS = 34;
const FRED_TIME_KNOWN = 14;
const BLS_RELEASES = 13;
const BLS_EVENTS = 16;

const AT = Date.parse('2026-09-15T18:41:28Z');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. §10.9 — the FOMC page parser, against a structural SAMPLE, not a capture
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A hand-written sample of the FOMC calendar page's structure — the year panel, the
 * `fomc-meeting__month` / `fomc-meeting__date` pair and the `*` SEP marker — with the Committee's
 * published 2026 dates.
 *
 * It is **not** a capture and is never stored as one: PROVIDERS §16.9 records that
 * `fomccalendars.htm` has no recorded bytes and must be captured before this half can be covered
 * by QA-02. What this sample proves is the parse rule — month + day range → the *second* day, the
 * marker → `has_sep`, the panel heading → the year — which is the part that would be wrong in a
 * way a capture alone would not reveal.
 */
const FOMC_SAMPLE = `<!doctype html><html><head><title>FOMC Calendars</title></head><body>
<div class="panel panel-default">
  <div class="panel-heading"><h4>2026 FOMC Meetings</h4></div>
  <div class="panel-body">
    <div class="row fomc-meeting">
      <div class="fomc-meeting__month col-xs-5"><strong>January</strong></div>
      <div class="fomc-meeting__date col-xs-4">27-28</div>
    </div>
    <div class="row fomc-meeting">
      <div class="fomc-meeting__month col-xs-5"><strong>March</strong></div>
      <div class="fomc-meeting__date col-xs-4">17-18*</div>
    </div>
    <div class="row fomc-meeting">
      <div class="fomc-meeting__month col-xs-5"><strong>April/May</strong></div>
      <div class="fomc-meeting__date col-xs-4">28-29</div>
    </div>
    <div class="row fomc-meeting">
      <div class="fomc-meeting__month col-xs-5"><strong>June</strong></div>
      <div class="fomc-meeting__date col-xs-4">16-17*</div>
    </div>
    <div class="row fomc-meeting">
      <div class="fomc-meeting__month col-xs-5"><strong>July</strong></div>
      <div class="fomc-meeting__date col-xs-4">28-29</div>
    </div>
    <div class="row fomc-meeting">
      <div class="fomc-meeting__month col-xs-5"><strong>September</strong></div>
      <div class="fomc-meeting__date col-xs-4">15-16*</div>
    </div>
    <div class="row fomc-meeting">
      <div class="fomc-meeting__month col-xs-5"><strong>October</strong></div>
      <div class="fomc-meeting__date col-xs-4">27-28</div>
    </div>
    <div class="row fomc-meeting">
      <div class="fomc-meeting__month col-xs-5"><strong>December</strong></div>
      <div class="fomc-meeting__date col-xs-4">8-9*</div>
    </div>
  </div>
</div>
<p>* Meeting associated with a Summary of Economic Projections.</p>
</body></html>`;

/** The same page after a re-skin that lost half the panel — the fail-closed case. */
const FOMC_SHORT_SAMPLE = `<div class="panel panel-default">
  <div class="panel-heading"><h4>2027 FOMC Meetings</h4></div>
  <div class="row fomc-meeting">
    <div class="fomc-meeting__month"><strong>January</strong></div>
    <div class="fomc-meeting__date">26-27</div>
  </div>
  <div class="row fomc-meeting">
    <div class="fomc-meeting__month"><strong>March</strong></div>
    <div class="fomc-meeting__date">16-17*</div>
  </div>
</div>`;

describe('parseFomcCalendar (§10.9)', () => {
  it('takes the SECOND day of a two-day meeting and the SEP marker', () => {
    const { rows, problems } = parseFomcCalendar(FOMC_SAMPLE);
    expect(problems).toEqual([]);
    expect(rows.years).toEqual([2026]);
    expect(rows.meetings).toHaveLength(8);
    // The decision day, not the day the meeting opened: taking the first would move the whole
    // implied policy path one meeting to the left.
    expect(rows.meetings.map((m) => m.meetingDate)).toEqual([
      '2026-01-28',
      '2026-03-18',
      '2026-04-29',
      '2026-06-17',
      '2026-07-29',
      '2026-09-16',
      '2026-10-28',
      '2026-12-09',
    ]);
    expect(rows.meetings.filter((m) => m.hasSep).map((m) => m.meetingDate)).toEqual([
      '2026-03-18',
      '2026-06-17',
      '2026-09-16',
      '2026-12-09',
    ]);
    // `April/May` still resolves to April: the range is printed under the month it opens in.
    expect(rows.meetings[2]?.label).toBe('April/May 28-29');
  });

  it('puts the statement at 14:00 ET, on both sides of the DST boundary', () => {
    // September is EDT (UTC−4); January is EST (UTC−5).
    expect(fomcStatementInstant('2026-09-16')).toBe('2026-09-16T18:00:00Z');
    expect(fomcStatementInstant('2026-01-28')).toBe('2026-01-28T19:00:00Z');
    expect(fomcStatementInstant('2026-03-18')).toBe('2026-03-18T18:00:00Z');
    expect(fomcStatementInstant('2026-12-09')).toBe('2026-12-09T19:00:00Z');
    const { rows } = parseFomcCalendar(FOMC_SAMPLE);
    expect(rows.meetings.find((m) => m.meetingDate === '2026-09-16')?.statementAt).toBe(
      '2026-09-16T18:00:00Z',
    );
  });

  it('reads the day range and refuses to guess at a month-crossing one', () => {
    expect(parseMeetingDays('27-28')).toEqual({ day: 28, hasSep: false });
    expect(parseMeetingDays('15-16*')).toEqual({ day: 16, hasSep: true });
    expect(parseMeetingDays(' 3 ')).toEqual({ day: 3, hasSep: false });
    // `31-1` is printed under both months; taking `1` would date it in the wrong month.
    expect(parseMeetingDays('31-1')).toBeNull();
    expect(parseMeetingDays('Cancelled')).toBeNull();
    expect(parseMeetingDays('')).toBeNull();
  });

  it('discards a year that lost meetings rather than truncating the calendar', () => {
    const { rows, problems } = parseFomcCalendar(FOMC_SHORT_SAMPLE);
    expect(rows.meetings).toEqual([]);
    expect(rows.years).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe('schema_drift');
    expect(problems[0]?.detail).toContain(String(MIN_FOMC_MEETINGS));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The job
// ─────────────────────────────────────────────────────────────────────────────────────────────

const t = withTxDb();

function ctxOf(tx: Tx): MarketJobContext {
  return { tx, clock: new VirtualClock(AT), replay: store };
}

/** Every `econ_releases` row's physical tuple, so a no-op rewrite cannot hide behind equal values. */
async function releaseTuples(tx: Tx): Promise<string[]> {
  const res = await tx.execute<{ ctid: string }>(sql`
    SELECT ctid::text AS ctid FROM econ_releases ORDER BY source_id, provider_release_id`);
  return res.rows.map((r) => r.ctid);
}

async function counts(tx: Tx): Promise<{ releases: number; events: number; meetings: number }> {
  const res = await tx.execute<{ releases: string; events: string; meetings: string }>(sql`
    SELECT (SELECT count(*) FROM econ_releases)::text       AS releases,
           (SELECT count(*) FROM econ_release_events)::text AS events,
           (SELECT count(*) FROM fomc_meetings)::text       AS meetings`);
  const row = res.rows[0];
  return {
    releases: Number(row?.releases ?? '0'),
    events: Number(row?.events ?? '0'),
    meetings: Number(row?.meetings ?? '0'),
  };
}

describe('econCalendar — the §13 scheduler row and the month window', () => {
  it('declares the row', () => {
    expect(job.id).toBe('econCalendar');
    expect(job.schedule).toBe(ECON_CALENDAR_SCHEDULE);
    expect(ECON_CALENDAR_SCHEDULE).toBe('0 5 * * *');
    expect(job.priority).toBe(3);
    expect(job.timeoutMs).toBe(120_000);
    expect(job.provider).toEqual([
      FRED_CALENDAR_SOURCE_ID,
      BLS_SCHEDULE_SOURCE_ID,
      FED_FOMC_SOURCE_ID,
    ]);
  });

  it('covers the current month and the next, across a year end', () => {
    expect(calendarMonths({ year: 2026, month: 9 }, 2)).toEqual([
      { year: 2026, month: 9 },
      { year: 2026, month: 10 },
    ]);
    expect(calendarMonths({ year: 2026, month: 12 }, 2)).toEqual([
      { year: 2026, month: 12 },
      { year: 2027, month: 1 },
    ]);
  });

  it('holds a capture for September but not for October, and none for the FOMC page', () => {
    expect(store.has(requestKey(FRED_CALENDAR_SOURCE_ID, 'GET', FRED_CALENDAR_URL))).toBe(true);
    expect(store.has(requestKey(BLS_SCHEDULE_SOURCE_ID, 'GET', SEPTEMBER_URL))).toBe(true);
    expect(store.has(requestKey(BLS_SCHEDULE_SOURCE_ID, 'GET', OCTOBER_URL))).toBe(false);
    // PROVIDERS §16.9 — this is the assertion that records the missing fixture.
    expect(store.has(requestKey(FED_FOMC_SOURCE_ID, 'GET', FOMC_CALENDAR_URL))).toBe(false);
  });
});

describe('econCalendar — the recorded calendars', () => {
  it('writes both publications, keeping the known time distinct from the default', async () => {
    const tx = t.db;
    const result = await runEconCalendar(ctxOf(tx));

    expect(result.errors).toEqual([]);
    expect(result.fetched).toBe(2); // the FRED page and September; October and the FOMC page have no capture
    expect(result.noCapture.sort()).toEqual([FOMC_CALENDAR_URL, OCTOBER_URL].sort());

    expect(result.fred).toEqual({ releases: FRED_RELEASES, events: FRED_EVENTS, meetings: 0 });
    expect(result.bls).toEqual({ releases: BLS_RELEASES, events: BLS_EVENTS, meetings: 0 });
    expect(result.fomc).toEqual({ releases: 0, events: 0, meetings: 0 });

    expect(await counts(tx)).toEqual({
      releases: FRED_RELEASES + BLS_RELEASES,
      events: FRED_EVENTS + BLS_EVENTS,
      meetings: 0,
    });

    // §10.2's deviation, carried through: FRED publishes a time for 14 of the 34 rows and the
    // rest fall back to 08:30 ET with `time_known = false`.
    const fred = await tx.execute<{ known: string; unknown: string; dates: string }>(sql`
      SELECT count(*) FILTER (WHERE e.time_known)::text     AS known,
             count(*) FILTER (WHERE NOT e.time_known)::text AS unknown,
             count(DISTINCT (e.scheduled_at AT TIME ZONE 'America/New_York')::date)::text AS dates
        FROM econ_release_events e JOIN econ_releases r ON r.release_id = e.release_id
       WHERE r.source_id = ${FRED_CALENDAR_SOURCE_ID}`);
    expect(fred.rows[0]?.known).toBe(String(FRED_TIME_KNOWN));
    expect(fred.rows[0]?.unknown).toBe(String(FRED_EVENTS - FRED_TIME_KNOWN));
    expect(fred.rows[0]?.dates).toBe('1');

    // §10.6: every BLS row carries a published ET time, and a period label FRED does not have.
    const bls = await tx.execute<{ known: string; labelled: string }>(sql`
      SELECT count(*) FILTER (WHERE e.time_known)::text          AS known,
             count(*) FILTER (WHERE e.period_label <> '')::text  AS labelled
        FROM econ_release_events e JOIN econ_releases r ON r.release_id = e.release_id
       WHERE r.source_id = ${BLS_SCHEDULE_SOURCE_ID}`);
    expect(bls.rows[0]?.known).toBe(String(BLS_EVENTS));
    expect(bls.rows[0]?.labelled).toBe(String(BLS_EVENTS));

    // No merge across sources: every release row is keyed by the source that published it, and
    // the two sets are disjoint even where they describe the same event. The clearest instance in
    // these captures is the FOMC: FRED lists it as a release (`rid`) while `fed.fomc` files its
    // own 'FOMC statement' row — two rows, deliberately, because CONTRACTS defines no cross-source
    // release identity and a matcher that guessed one would silently drop whichever it got wrong.
    const bySource = await tx.execute<{ source_id: string; n: string }>(sql`
      SELECT source_id, count(*)::text AS n FROM econ_releases GROUP BY source_id
       ORDER BY source_id`);
    expect(bySource.rows).toEqual([
      { source_id: BLS_SCHEDULE_SOURCE_ID, n: String(BLS_RELEASES) },
      { source_id: FRED_CALENDAR_SOURCE_ID, n: String(FRED_RELEASES) },
    ]);
    const fomcRelease = await tx.execute<{ source_id: string; name: string }>(sql`
      SELECT source_id, name FROM econ_releases WHERE name LIKE 'FOMC%' ORDER BY source_id`);
    expect(fomcRelease.rows).toEqual([
      { source_id: FRED_CALENDAR_SOURCE_ID, name: 'FOMC Press Release' },
    ]);
    // The BLS slugs are BLS's own, never a FRED `rid`.
    const blsIds = await tx.execute<{ provider_release_id: string }>(sql`
      SELECT provider_release_id FROM econ_releases
       WHERE source_id = ${BLS_SCHEDULE_SOURCE_ID} ORDER BY provider_release_id`);
    expect(blsIds.rows.map((r) => r.provider_release_id)).toContain('cpi');
    expect(blsIds.rows.every((r) => !/^\d+$/.test(r.provider_release_id))).toBe(true);

    // v1 has no consensus source, and every event says so rather than leaving a bare NULL.
    const consensus = await tx.execute<{ n: string; reasons: string }>(sql`
      SELECT count(*)::text AS n, count(DISTINCT consensus_unavailable_reason)::text AS reasons
        FROM econ_release_events WHERE consensus IS NULL`);
    expect(consensus.rows[0]?.n).toBe(String(FRED_EVENTS + BLS_EVENTS));
    expect(consensus.rows[0]?.reasons).toBe('1');
  }, 120_000);

  it('writes nothing on a second run, and says so in ingest_runs', async () => {
    const tx = t.db;
    const first = await runEconCalendar(ctxOf(tx));
    expect(first.errors).toEqual([]);
    expect(first.inserted).toBe(FRED_RELEASES + FRED_EVENTS + BLS_RELEASES + BLS_EVENTS);
    const before = await counts(tx);
    // `ctid` is the physical tuple. It is read here because a no-op `DO UPDATE` is invisible to
    // `count(*)` and to every value comparison: the row says the same thing at a new address.
    const tuplesBefore = await releaseTuples(tx);

    const second = await runEconCalendar(ctxOf(tx));
    expect(second.errors).toEqual([]);
    expect(second.fred).toEqual({ releases: 0, events: 0, meetings: 0 });
    expect(second.bls).toEqual({ releases: 0, events: 0, meetings: 0 });
    // The counter a nightly poll is judged by: nothing learned is reported as nothing written,
    // not as 47 releases re-offered.
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(FRED_RELEASES + FRED_EVENTS + BLS_RELEASES + BLS_EVENTS);
    expect(await counts(tx)).toEqual(before);
    // Not one `econ_releases` tuple moved: the guarded upsert wrote no dead tuples.
    expect(await releaseTuples(tx)).toEqual(tuplesBefore);

    const runs = await tx.execute<{ n: string; inserted: number; skipped: number }>(sql`
      SELECT count(*)::text AS n,
             max(inserted) FILTER (WHERE run_id = (SELECT max(run_id) FROM ingest_runs
                                                    WHERE job_id = 'econCalendar')) AS inserted,
             max(skipped)  FILTER (WHERE run_id = (SELECT max(run_id) FROM ingest_runs
                                                    WHERE job_id = 'econCalendar')) AS skipped
        FROM ingest_runs WHERE job_id = 'econCalendar'`);
    expect(runs.rows[0]?.n).toBe('2');
    expect(runs.rows[0]?.inserted).toBe(0);
    expect(runs.rows[0]?.skipped).toBe(FRED_RELEASES + FRED_EVENTS + BLS_RELEASES + BLS_EVENTS);
  }, 120_000);

  it('does not let one source take another down: BLS alone still writes', async () => {
    const tx = t.db;
    const result = await runEconCalendar(ctxOf(tx), { sources: [BLS_SCHEDULE_SOURCE_ID] });
    expect(result.errors).toEqual([]);
    expect(result.bls.events).toBe(BLS_EVENTS);
    expect(result.fred).toEqual({ releases: 0, events: 0, meetings: 0 });
    expect(await counts(tx)).toEqual({
      releases: BLS_RELEASES,
      events: BLS_EVENTS,
      meetings: 0,
    });
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. `fomc_meetings` — the writers, driven by the parsed sample (§10.9)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('econCalendar — fomc_meetings', () => {
  it('writes eight meetings, then nothing, and never clears decision_bp', async () => {
    const tx = t.db;
    const provenanceId = await seedProvenance(tx);
    const { rows } = parseFomcCalendar(FOMC_SAMPLE);

    expect(await upsertFomcMeetings(tx, rows.meetings, provenanceId)).toBe(8);
    const stored = await tx.execute<{
      meeting_date: string;
      statement_at: string;
      has_sep: boolean;
    }>(sql`
      SELECT meeting_date::text AS meeting_date, statement_at::text AS statement_at, has_sep
        FROM fomc_meetings ORDER BY meeting_date`);
    expect(stored.rows.map((r) => r.meeting_date)).toEqual(rows.meetings.map((m) => m.meetingDate));
    expect(stored.rows.filter((r) => r.has_sep)).toHaveLength(4);

    // `fed.rss` fills `decision_bp` after a meeting; a nightly calendar poll must not erase it.
    await tx.execute(sql`
      UPDATE fomc_meetings SET decision_bp = -25 WHERE meeting_date = date '2026-07-29'`);
    expect(await upsertFomcMeetings(tx, rows.meetings, provenanceId)).toBe(0);
    const decision = await tx.execute<{ decision_bp: number | null }>(sql`
      SELECT decision_bp FROM fomc_meetings WHERE meeting_date = date '2026-07-29'`);
    expect(decision.rows[0]?.decision_bp).toBe(-25);
  }, 120_000);

  it('files one ECO event per meeting, and leaves a released event alone', async () => {
    const tx = t.db;
    const provenanceId = await seedProvenance(tx);
    const { rows } = parseFomcCalendar(FOMC_SAMPLE);
    const { releaseId } = await upsertEconRelease(tx, {
      sourceId: FED_FOMC_SOURCE_ID,
      providerReleaseId: 'FOMC',
      name: 'FOMC statement',
      country: 'US',
      url: FOMC_CALENDAR_URL,
    });

    const events = rows.meetings.map((meeting) => ({
      releaseId,
      scheduledAt: meeting.statementAt,
      timeKnown: true,
      periodLabel: meeting.meetingDate,
      seriesId: null,
      provenanceId,
    }));
    expect(await upsertReleaseEvents(tx, events)).toBe(8);
    expect(await upsertReleaseEvents(tx, events)).toBe(0);

    // A past meeting's event has moved on; the calendar poll must not reset it to 'scheduled'.
    await tx.execute(sql`
      UPDATE econ_release_events SET status = 'released', actual = -25
       WHERE release_id = ${releaseId}::bigint AND period_label = '2026-07-29'`);
    expect(await upsertReleaseEvents(tx, events)).toBe(0);
    const released = await tx.execute<{ status: string; actual: string | null }>(sql`
      SELECT status, actual::text AS actual FROM econ_release_events
       WHERE release_id = ${releaseId}::bigint AND period_label = '2026-07-29'`);
    expect(released.rows[0]?.status).toBe('released');
    expect(Number(released.rows[0]?.actual)).toBe(-25);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Seed helper
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function seedProvenance(tx: Tx): Promise<number> {
  const res = await tx.execute<{ provenance_id: string }>(sql`
    INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                            http_status, bytes, captured_at, adapter_version)
    VALUES ('internal.derived', 'test:fomc', 'test://fomc', sha256('test:fomc'::bytea),
            sha256('test:fomc'::bytea), 200, 0, timestamptz '2026-09-01 00:00:00+00', 'test/1.0.0')
    RETURNING provenance_id`);
  return Number(res.rows[0]!.provenance_id);
}
