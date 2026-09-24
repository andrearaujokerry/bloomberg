/**
 * `ingest/jobs/econCalendar.ts` — the ECO calendar and the FOMC list
 * (PROVIDERS.b §10.2, §10.6, §10.9, §13).
 *
 * §13: `fred.calendar` + `bls.schedule` + `fed.fomc`, `'0 5 * * *'`, priority 3, 120 s, "current +
 * next month". Three sources, one job, because they are three publications of one thing: what is
 * released, when.
 *
 * ## Fail closed, per source
 *
 * Every one of the three parsers already refuses a partial answer — FRED discards the whole page
 * when its row count disagrees with the count the page advertises (§10.2), BLS refuses a page
 * whose `<title>` is not the month that was asked for or that yields fewer than five rows (§10.6),
 * and {@link parseFomcCalendar} refuses a year with fewer than {@link MIN_FOMC_MEETINGS} meetings
 * (§10.9). This job's contribution is to keep those three failures **independent**: a FRED page
 * that changed shape must not take the BLS calendar down with it, so each source is fetched,
 * parsed and written on its own, and a failure is a `JobError` on the result plus a `parse_error`
 * `data_exceptions` row for data ops, with the previous calendar left exactly as it stood.
 *
 * ## Two sources, two release rows — deliberately
 *
 * `econ_releases` is unique on `(source_id, provider_release_id)`, so FRED's CPI (`rid=10`) and
 * BLS's CPI (`cpi`) are two rows, and CONTRACTS provides no mapping between them. §10.6's "this is
 * the source that upgrades FRED's 08:30 default" is therefore a **read-side** rule, not a merge
 * performed here: both events are stored, the BLS one carries `time_known = true` and the FRED one
 * `false`, and ECO prefers the known time. Merging them in the writer would need a cross-source
 * release identity that does not exist, and inventing one would silently drop whichever release
 * the matcher got wrong.
 *
 * ## `fed.fomc` has no recorded capture
 *
 * PROVIDERS §10.9 and §16.9: the FOMC calendar page is not in `fixtures/providers`. The parser is
 * here and is exercised directly; the **fetch** is guarded by {@link hasCapture}, so a replay run
 * reports `NO_CAPTURE` and writes no meetings rather than throwing at the wall or, far worse,
 * inventing a meeting list. With `ctx.http` wired (live/record) it is fetched like anything else.
 */

import { sql } from 'drizzle-orm';

import {
  BLS_ADAPTER_VERSION,
  blsScheduleUrl,
  fetchBlsSchedule,
} from '../../providers/bls/adapter.js';
import { MIN_SCHEDULE_ROWS, normaliseBlsSchedule } from '../../providers/bls/parse.js';
import { FRED_CALENDAR_URL, fredCalendarAdapter } from '../../providers/fred/adapter.js';
import { FRED_ADAPTER_VERSION, NO_CONSENSUS_REASON } from '../../providers/fred/parse.js';
import { normaliseSpace, scanHtml, stripTags } from '../../providers/html.js';
import { openReplayStore, requestKey } from '../../providers/replayStore.js';
import { zonedParts } from '../scheduler.js';
import {
  emptyResult,
  fetchError,
  linesOf,
  normaliseWithProvenance,
  requestEnvelope,
  resolveTargets,
  withIngestRun,
} from './cboeQuotes.js';
import { upsertEconRelease } from './worldMacro.js';
import { recordDqEvent } from './secNport.js';

import type { Tx } from '../../db/client.js';
import type { BlsScheduleRows } from '../../providers/bls/parse.js';
import type { FredCalendarRows } from '../../providers/fred/parse.js';
import type { NormaliseProblem, ProviderId, RawRecord } from '../../providers/types.js';
import type { MarketJobContext, MarketJobResult } from './cboeQuotes.js';

export const FRED_CALENDAR_SOURCE_ID = 'fred.calendar' satisfies ProviderId;
export const BLS_SCHEDULE_SOURCE_ID = 'bls.schedule' satisfies ProviderId;
export const FED_FOMC_SOURCE_ID = 'fed.fomc' satisfies ProviderId;

/** §13 `econCalendar`: 05:00 America/New_York, daily. */
export const ECON_CALENDAR_SCHEDULE = '0 5 * * *';

/** §10.9 — the page, which has no recorded capture (§16.9). */
export const FOMC_CALENDAR_URL =
  'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';

/** §10.9: `adapter_version` for the FOMC page; the parser lives here until `providers/fed/` does. */
export const FOMC_ADAPTER_VERSION = 'fed.fomc/1.0.0';

/** §10.9: the calendar is re-read daily at most. */
export const FOMC_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** §10.9: "fewer than 8 meetings parsed for a year → `schema_drift`". */
export const MIN_FOMC_MEETINGS = 8;

/** §10.9: the statement lands at 14:00 ET on the decision day. */
export const FOMC_STATEMENT_ET = { hour: 14, minute: 0 } as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §10.9 — the FOMC calendar page
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One parsed meeting. `meetingDate` is the **decision** day (§10.9). */
export interface FomcMeetingRow {
  /** `YYYY-MM-DD` — the second day of a two-day meeting. */
  meetingDate: string;
  /** ISO instant: `meetingDate` at 14:00 ET. */
  statementAt: string;
  /** `*` on the page — an associated Summary of Economic Projections. */
  hasSep: boolean;
  /** The year panel this meeting was read from. */
  year: number;
  /** `'January 27-28*'`, exactly as printed, for audit. */
  label: string;
}

export interface FomcCalendarRows {
  meetings: FomcMeetingRow[];
  /** Years the page published a panel for, ascending. */
  years: number[];
}

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The US federal DST rule: second Sunday in March to first Sunday in November, 02:00 local.
 * Duplicated from `providers/bls/parse.ts` rather than exported across a provider boundary —
 * see the note there; a wrong answer here moves a statement time by an hour.
 */
function easternOffsetHours(year: number, month: number, day: number): 4 | 5 {
  const firstOfMarch = new Date(Date.UTC(year, 2, 1)).getUTCDay();
  const secondSundayMarch = 1 + ((7 - firstOfMarch) % 7) + 7;
  const firstOfNovember = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstSundayNovember = 1 + ((7 - firstOfNovember) % 7);
  if (month < 3 || month > 11) return 5;
  if (month > 3 && month < 11) return 4;
  if (month === 3) return day >= secondSundayMarch ? 4 : 5;
  return day < firstSundayNovember ? 4 : 5;
}

/** `2026-09-16` at 14:00 ET → `2026-09-16T18:00:00Z`. */
export function fomcStatementInstant(meetingDate: string): string {
  const year = Number(meetingDate.slice(0, 4));
  const month = Number(meetingDate.slice(5, 7));
  const day = Number(meetingDate.slice(8, 10));
  const offset = easternOffsetHours(year, month, day);
  const ms = Date.UTC(year, month - 1, day, FOMC_STATEMENT_ET.hour + offset, FOMC_STATEMENT_ET.minute);
  return new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
}

/**
 * `'27-28*'` → `{ day: 28, hasSep: true }`; `'3'` → `{ day: 3, hasSep: false }`.
 *
 * **The second day of a range is the answer**, because the decision and the statement belong to
 * it; taking the first would date every two-day meeting a day early and move the whole implied
 * policy path one meeting to the left. A range that crosses a month boundary (`'31-1'`) is
 * reported as `null` rather than guessed: the page prints those under both months and the caller
 * reads the later of the two entries.
 */
export function parseMeetingDays(text: string): { day: number; hasSep: boolean } | null {
  const trimmed = normaliseSpace(text);
  const hasSep = trimmed.includes('*');
  const digits = trimmed.replace(/[^0-9-]/g, '');
  const match = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(digits);
  if (match === null) return null;
  const first = Number(match[1]);
  const second = match[2] === undefined ? first : Number(match[2]);
  if (first < 1 || first > 31 || second < 1 || second > 31) return null;
  // `31-1` crosses into the next month: the page repeats the meeting under the later month too.
  if (second < first) return null;
  return { day: second, hasSep };
}

/** `'September'` → 9, `null` for anything else. */
export function parseMeetingMonth(text: string): number | null {
  const folded = normaliseSpace(stripTags(text)).toLowerCase().replace(/[^a-z]/g, '');
  const index = MONTH_NAMES.findIndex((name) => folded.startsWith(name.slice(0, 3)) && name.startsWith(folded.slice(0, 3)));
  if (index < 0) return null;
  // `mar`/`march` match; `m` alone does not, because it is ambiguous between three months.
  return folded.length >= 3 ? index + 1 : null;
}

/**
 * The FOMC calendar page → meetings (§10.9).
 *
 * The page groups meetings into year panels; each meeting is a month element and a day-range
 * element, both marked with a `fomc-meeting__*` class, and the panel's heading carries the year.
 * The scan keys on those class names and on the heading, never on element order, because the page
 * has been re-laid-out twice without the classes changing.
 *
 * **Fails closed**: a year that yields fewer than {@link MIN_FOMC_MEETINGS} meetings contributes
 * **none** of them and a `schema_drift` problem naming the count, so a re-skinned page leaves the
 * stored calendar alone instead of truncating it.
 */
export function parseFomcCalendar(body: Buffer | string): {
  rows: FomcCalendarRows;
  problems: NormaliseProblem[];
} {
  const source = typeof body === 'string' ? body : body.toString('utf8');
  const problems: NormaliseProblem[] = [];

  interface Pending {
    year: number | null;
    month: number | null;
    monthText: string;
  }
  const pending: Pending = { year: null, month: null, monthText: '' };
  const byYear = new Map<number, FomcMeetingRow[]>();

  /** Which `fomc-meeting__*` element we are inside, if any, and the heading capture. */
  let capture: 'month' | 'date' | 'heading' | null = null;
  let buffer = '';
  let depth = 0;

  const flushHeading = (): void => {
    const match = /\b(19|20)\d{2}\b/.exec(normaliseSpace(buffer));
    if (match !== null) pending.year = Number(match[0]);
  };

  const flushMonth = (): void => {
    const month = parseMeetingMonth(buffer);
    pending.month = month;
    pending.monthText = normaliseSpace(buffer);
  };

  const flushDate = (): void => {
    const year = pending.year;
    const month = pending.month;
    if (year === null || month === null) return;
    const parsed = parseMeetingDays(buffer);
    if (parsed === null) return;
    const meetingDate = `${String(year)}-${pad2(month)}-${pad2(parsed.day)}`;
    const list = byYear.get(year) ?? [];
    if (list.some((m) => m.meetingDate === meetingDate)) return;
    list.push({
      meetingDate,
      statementAt: fomcStatementInstant(meetingDate),
      hasSep: parsed.hasSep,
      year,
      label: `${pending.monthText} ${normaliseSpace(buffer)}`.trim(),
    });
    byYear.set(year, list);
  };

  scanHtml(source, {
    onOpen(tag) {
      if (capture !== null) {
        depth += 1;
        return;
      }
      const className = tag.attrs.class ?? '';
      if (className.includes('fomc-meeting__month')) {
        capture = 'month';
        buffer = '';
        depth = 0;
        return;
      }
      if (className.includes('fomc-meeting__date')) {
        capture = 'date';
        buffer = '';
        depth = 0;
        return;
      }
      if (/^h[1-6]$/.test(tag.name) || className.includes('panel-heading')) {
        capture = 'heading';
        buffer = '';
        depth = 0;
      }
    },
    onClose() {
      if (capture === null) return;
      if (depth > 0) {
        depth -= 1;
        return;
      }
      if (capture === 'heading') flushHeading();
      else if (capture === 'month') flushMonth();
      else flushDate();
      capture = null;
      buffer = '';
    },
    onText(text) {
      if (capture !== null) buffer += text;
    },
  });

  const meetings: FomcMeetingRow[] = [];
  const years: number[] = [];
  for (const year of [...byYear.keys()].sort((a, b) => a - b)) {
    const list = byYear.get(year)!;
    if (list.length < MIN_FOMC_MEETINGS) {
      problems.push({
        kind: 'schema_drift',
        detail:
          `FOMC ${String(year)} yielded ${String(list.length)} meetings, fewer than the ` +
          `${String(MIN_FOMC_MEETINGS)} the Committee always holds; the year is discarded and ` +
          'the stored calendar stands (PROVIDERS §10.9)',
        path: `/${String(year)}`,
      });
      continue;
    }
    years.push(year);
    meetings.push(...list.sort((a, b) => (a.meetingDate < b.meetingDate ? -1 : 1)));
  }

  return { rows: { meetings, years }, problems };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Writers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What one half of the job **wrote**, never what it looked at.
 *
 * All three are written counts: `upsertReleaseEvents` and `upsertFomcMeetings` carry a
 * `WHERE … IS DISTINCT FROM` guard and `RETURNING` only the rows they changed, and
 * `upsertEconRelease` now does too. A re-run over an identical capture therefore reports
 * `{ releases: 0, events: 0, meetings: 0 }` and `inserted: 0`, which is what makes "a nightly
 * poll learned nothing" visible in `ingest_runs` — it is read by `dqMonitors` and the ops view,
 * and a count of rows *offered* would make a poll that learned nothing look like one that
 * learned 47 things.
 */
export interface CalendarCounts {
  releases: number;
  events: number;
  meetings: number;
}

function noCalendarCounts(): CalendarCounts {
  return { releases: 0, events: 0, meetings: 0 };
}

/**
 * Insert or refresh one `econ_release_events` row on its natural key
 * `(release_id, scheduled_at, period_label)`.
 *
 * A re-run of the same calendar writes nothing: the `DO UPDATE … WHERE` compares every column the
 * calendar owns, and a row whose `WHERE` is false is not returned at all. It deliberately does not
 * touch `actual` / `prior` / `revised_prior` / `status` once they have moved past `'scheduled'` —
 * those are filled by the series ingest when the number lands (§10.6), and a nightly calendar poll
 * must not reset a released event to scheduled.
 */
export async function upsertReleaseEvents(
  tx: Tx,
  rows: readonly {
    releaseId: number;
    scheduledAt: string;
    timeKnown: boolean;
    periodLabel: string;
    seriesId: number | null;
    provenanceId: number;
  }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await tx.execute<{ event_id: string }>(sql`
    INSERT INTO econ_release_events
      (release_id, scheduled_at, time_known, period_label, series_id, consensus,
       consensus_unavailable_reason, status, provenance_id)
    SELECT i.release_id, i.scheduled_at, i.time_known, i.period_label, i.series_id, NULL,
           ${NO_CONSENSUS_REASON}, 'scheduled', i.provenance_id
      FROM unnest(${sql.param(rows.map((r) => r.releaseId))}::bigint[],
                  ${sql.param(rows.map((r) => r.scheduledAt))}::timestamptz[],
                  ${sql.param(rows.map((r) => r.timeKnown))}::boolean[],
                  ${sql.param(rows.map((r) => r.periodLabel))}::text[],
                  ${sql.param(rows.map((r) => r.seriesId))}::bigint[],
                  ${sql.param(rows.map((r) => r.provenanceId))}::bigint[])
        AS i(release_id, scheduled_at, time_known, period_label, series_id, provenance_id)
    ON CONFLICT (release_id, scheduled_at, period_label) DO UPDATE
       SET time_known = EXCLUDED.time_known,
           series_id = COALESCE(EXCLUDED.series_id, econ_release_events.series_id),
           consensus_unavailable_reason = EXCLUDED.consensus_unavailable_reason,
           provenance_id = EXCLUDED.provenance_id
     WHERE econ_release_events.time_known IS DISTINCT FROM EXCLUDED.time_known
        OR econ_release_events.consensus_unavailable_reason
             IS DISTINCT FROM EXCLUDED.consensus_unavailable_reason
        OR (econ_release_events.series_id IS NULL AND EXCLUDED.series_id IS NOT NULL)
    RETURNING event_id`);
  return res.rows.length;
}

/**
 * Insert or refresh `fomc_meetings` on its primary key.
 *
 * `decision_bp` is never written here: §10.9 leaves it NULL and `fed.rss` fills it after the
 * meeting from the statement's target range. A calendar poll that reset it to NULL would erase
 * every past decision every night.
 */
export async function upsertFomcMeetings(
  tx: Tx,
  rows: readonly FomcMeetingRow[],
  provenanceId: number,
): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await tx.execute<{ meeting_date: string }>(sql`
    INSERT INTO fomc_meetings (meeting_date, statement_at, has_sep, provenance_id)
    SELECT i.meeting_date, i.statement_at, i.has_sep, ${provenanceId}::bigint
      FROM unnest(${sql.param(rows.map((r) => r.meetingDate))}::date[],
                  ${sql.param(rows.map((r) => r.statementAt))}::timestamptz[],
                  ${sql.param(rows.map((r) => r.hasSep))}::boolean[])
        AS i(meeting_date, statement_at, has_sep)
    ON CONFLICT (meeting_date) DO UPDATE
       SET statement_at = EXCLUDED.statement_at,
           has_sep = EXCLUDED.has_sep,
           provenance_id = EXCLUDED.provenance_id
     WHERE fomc_meetings.statement_at IS DISTINCT FROM EXCLUDED.statement_at
        OR fomc_meetings.has_sep IS DISTINCT FROM EXCLUDED.has_sep
    RETURNING meeting_date`);
  return res.rows.length;
}

/** §10.2/§10.6/§10.9 all fail closed to the same place: a `parse_error` for data ops. */
export async function recordCalendarFailure(
  tx: Tx,
  args: { sourceId: string; subject: string; key: string; detail: string },
): Promise<void> {
  const candidates = [
    { sourceId: args.sourceId, provenanceId: null, value: { key: args.key, detail: args.detail } },
  ];
  await tx.execute(sql`
    INSERT INTO data_exceptions (kind, entity_kind, entity_id, field, candidates, status,
                                 sla_due_at)
    SELECT 'parse_error', NULL, NULL, ${`${args.sourceId}:${args.subject}`},
           ${JSON.stringify(candidates)}::jsonb, 'open',
           clock_timestamp() + interval '2 days'
     WHERE NOT EXISTS (
       SELECT 1 FROM data_exceptions
        WHERE kind = 'parse_error'
          AND field = ${`${args.sourceId}:${args.subject}`}
          AND status = 'open'
          AND candidates -> 0 -> 'value' ->> 'key' = ${args.key})`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface EconCalendarOptions {
  /** The ET month to start from; default is the clock's. Used with {@link EconCalendarOptions.months}. */
  from?: { year: number; month: number };
  /** §13: "current + next month". */
  months?: number;
  /** Skip a source entirely — for a focused test, never in production. */
  sources?: readonly ('fred.calendar' | 'bls.schedule' | 'fed.fomc')[];
}

export interface EconCalendarResult extends MarketJobResult {
  fred: CalendarCounts;
  bls: CalendarCounts;
  fomc: CalendarCounts;
  /** URLs not requested because the replay store holds no capture for them (§16.9). */
  noCapture: string[];
}

function emptyCalendarResult(): EconCalendarResult {
  return {
    ...emptyResult(),
    fred: noCalendarCounts(),
    bls: noCalendarCounts(),
    fomc: noCalendarCounts(),
    noCapture: [],
  };
}

/** `true` when a GET for this URL is answerable — live always, replay only with a capture. */
export function hasCapture(ctx: MarketJobContext, providerId: ProviderId, url: string): boolean {
  if (ctx.http !== undefined) return true;
  const store = ctx.replay ?? openReplayStore();
  return store.has(requestKey(providerId, 'GET', url));
}

async function fetchGet(
  ctx: MarketJobContext,
  providerId: ProviderId,
  url: string,
  live: () => Promise<RawRecord>,
): Promise<RawRecord> {
  if (ctx.http !== undefined) return live();
  const store = ctx.replay ?? openReplayStore();
  return store.replay({ providerId, url });
}

/** The ET months this run covers: the current one and `months - 1` after it (§13). */
export function calendarMonths(
  from: { year: number; month: number },
  months: number,
): { year: number; month: number }[] {
  const out: { year: number; month: number }[] = [];
  for (let i = 0; i < months; i += 1) {
    const zero = from.month - 1 + i;
    out.push({ year: from.year + Math.floor(zero / 12), month: (zero % 12) + 1 });
  }
  return out;
}

/** `econ_series.series_id` by provider code, across every source — the event's headline series. */
async function seriesByCode(tx: Tx): Promise<Map<string, number>> {
  const res = await tx.execute<{ series_code: string; series_id: string }>(sql`
    SELECT series_code, series_id FROM econ_series`);
  const map = new Map<string, number>();
  for (const row of res.rows) map.set(row.series_code.toLowerCase(), Number(row.series_id));
  return map;
}

/**
 * Refresh the ECO calendar and the FOMC list.
 *
 * Idempotent by construction: `econ_releases` is upserted on `(source_id, provider_release_id)`,
 * `econ_release_events` on `(release_id, scheduled_at, period_label)` and `fomc_meetings` on its
 * primary key, and every one of the three refuses to write a row whose columns are unchanged, so a
 * second run reports zeroes across the board.
 */
export async function runEconCalendar(
  ctx: MarketJobContext,
  options: EconCalendarOptions = {},
): Promise<EconCalendarResult> {
  const enabled = new Set(
    options.sources ?? ([FRED_CALENDAR_SOURCE_ID, BLS_SCHEDULE_SOURCE_ID, FED_FOMC_SOURCE_ID] as const),
  );
  const outer = await withIngestRun(
    ctx,
    { id: 'econCalendar', sourceId: FRED_CALENDAR_SOURCE_ID },
    async () => {
      const result = emptyCalendarResult();
      const parts = zonedParts(ctx.clock.now());
      const from = options.from ?? { year: parts.year, month: parts.month };
      const months = calendarMonths(from, options.months ?? 2);
      const codes = await seriesByCode(ctx.tx);

      if (enabled.has(FRED_CALENDAR_SOURCE_ID)) await runFredHalf(ctx, result);
      if (enabled.has(BLS_SCHEDULE_SOURCE_ID)) await runBlsHalf(ctx, months, codes, result);
      if (enabled.has(FED_FOMC_SOURCE_ID)) await runFomcHalf(ctx, result);

      ctx.log?.info?.('econCalendar.done', {
        months: months.length,
        fred: result.fred,
        bls: result.bls,
        fomc: result.fomc,
        noCapture: result.noCapture.length,
      });
      return result;
    },
  );
  return outer as EconCalendarResult;
}

// ── fred.calendar (§10.2) ───────────────────────────────────────────────────────────────────

async function runFredHalf(ctx: MarketJobContext, result: EconCalendarResult): Promise<void> {
  const url = FRED_CALENDAR_URL;
  if (!hasCapture(ctx, FRED_CALENDAR_SOURCE_ID, url)) {
    result.noCapture.push(url);
    return;
  }

  let raw: RawRecord;
  try {
    raw = await fetchGet(ctx, FRED_CALENDAR_SOURCE_ID, url, () =>
      fredCalendarAdapter.fetch(ctx.http!, { page: 'calendar', ...requestEnvelope(ctx) }),
    );
  } catch (err) {
    result.errors.push(fetchError(err, url));
    return;
  }
  if (raw.status === 304) {
    result.skipped += 1;
    return;
  }
  result.fetched += 1;

  const lines = linesOf(await resolveTargets(ctx, FRED_CALENDAR_SOURCE_ID, { instrumentIds: null }));
  const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
    raw,
    adapterVersion: FRED_ADAPTER_VERSION,
    lines,
    normalise: (r, nctx) => fredCalendarAdapter.normalise(r, nctx),
  });
  result.provenanceIds.push(provenanceId);
  result.problems.push(...norm.problems);

  const rows = norm.rows as FredCalendarRows;
  // §10.2 fails closed inside the parser: a count mismatch yields zero rows and a `parse_error`.
  if (rows.events.length === 0) {
    const detail =
      `fred.calendar parsed ${String(rows.parsedCount)} rows against an advertised ` +
      `${String(rows.advertisedCount ?? -1)}; the previous calendar stands (§10.2)`;
    result.errors.push({ code: 'FRED_CALENDAR_FAILED_CLOSED', message: detail, url });
    await recordCalendarFailure(ctx.tx, {
      sourceId: FRED_CALENDAR_SOURCE_ID,
      subject: 'calendar',
      key: String(raw.sha256),
      detail,
    });
    return;
  }

  const releaseIds = new Map<string, number>();
  for (const release of rows.releases) {
    const { releaseId, written } = await upsertEconRelease(ctx.tx, {
      sourceId: FRED_CALENDAR_SOURCE_ID,
      providerReleaseId: release.providerReleaseId,
      name: release.name,
      country: release.country,
      url: release.url,
    });
    releaseIds.set(release.providerReleaseId, releaseId);
    if (written) result.fred.releases += 1;
  }

  const events = rows.events.flatMap((event) => {
    const releaseId = releaseIds.get(event.providerReleaseId);
    return releaseId === undefined
      ? []
      : [
          {
            releaseId,
            scheduledAt: event.scheduledAt,
            timeKnown: event.timeKnown,
            periodLabel: event.periodLabel,
            seriesId: null,
            provenanceId,
          },
        ];
  });
  result.fred.events = await upsertReleaseEvents(ctx.tx, events);
  result.inserted += result.fred.releases + result.fred.events;
  result.skipped +=
    rows.releases.length - result.fred.releases + (events.length - result.fred.events);
}

// ── bls.schedule (§10.6) ────────────────────────────────────────────────────────────────────

async function runBlsHalf(
  ctx: MarketJobContext,
  months: readonly { year: number; month: number }[],
  codes: ReadonlyMap<string, number>,
  result: EconCalendarResult,
): Promise<void> {
  const lines = linesOf(await resolveTargets(ctx, BLS_SCHEDULE_SOURCE_ID, { instrumentIds: null }));

  for (const month of months) {
    const url = blsScheduleUrl(month.year, month.month);
    if (!hasCapture(ctx, BLS_SCHEDULE_SOURCE_ID, url)) {
      result.noCapture.push(url);
      continue;
    }

    let raw: RawRecord;
    try {
      raw = await fetchGet(ctx, BLS_SCHEDULE_SOURCE_ID, url, () =>
        fetchBlsSchedule(ctx.http!, { ...month, ...requestEnvelope(ctx) }),
      );
    } catch (err) {
      result.errors.push(fetchError(err, url));
      continue;
    }
    if (raw.status === 304) {
      result.skipped += 1;
      continue;
    }
    result.fetched += 1;

    const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
      raw,
      adapterVersion: BLS_ADAPTER_VERSION,
      lines,
      // The caller knows the month it asked for, so the stronger §10.6 assertion runs.
      normalise: (r, nctx) => normaliseBlsSchedule(r, nctx, month),
    });
    result.provenanceIds.push(provenanceId);
    result.problems.push(...norm.problems);

    const rows: BlsScheduleRows = norm.rows;
    if (rows.events.length < MIN_SCHEDULE_ROWS) {
      const detail =
        `bls.schedule ${url} yielded ${String(rows.events.length)} events, fewer than the ` +
        `${String(MIN_SCHEDULE_ROWS)} minimum; the previous schedule stands (§10.6)`;
      result.errors.push({ code: 'BLS_SCHEDULE_FAILED_CLOSED', message: detail, url });
      await recordCalendarFailure(ctx.tx, {
        sourceId: BLS_SCHEDULE_SOURCE_ID,
        subject: `${String(month.year)}-${pad2(month.month)}`,
        key: String(raw.sha256),
        detail,
      });
      continue;
    }

    const releaseIds = new Map<string, number>();
    let releasesWritten = 0;
    for (const release of rows.releases) {
      const { releaseId, written } = await upsertEconRelease(ctx.tx, {
        sourceId: BLS_SCHEDULE_SOURCE_ID,
        providerReleaseId: release.providerReleaseId,
        name: release.name,
        country: release.country,
        url: release.url,
      });
      releaseIds.set(release.providerReleaseId, releaseId);
      if (written) releasesWritten += 1;
    }
    result.bls.releases += releasesWritten;

    const events = rows.events.flatMap((event) => {
      const releaseId = releaseIds.get(event.providerReleaseId);
      return releaseId === undefined
        ? []
        : [
            {
              releaseId,
              scheduledAt: event.scheduledAt,
              timeKnown: event.timeKnown,
              periodLabel: event.periodLabel,
              // §10.6: the headline series when the seed named one under this slug.
              seriesId: codes.get(event.providerReleaseId.toLowerCase()) ?? null,
              provenanceId,
            },
          ];
    });
    const written = await upsertReleaseEvents(ctx.tx, events);
    result.bls.events += written;
    result.inserted += releasesWritten + written;
    result.skipped += rows.releases.length - releasesWritten + (events.length - written);
  }

  if (months.length > 0 && result.bls.events === 0 && result.noCapture.length === months.length) {
    ctx.log?.info?.('econCalendar.bls_no_capture', { months: months.length });
  }
}

// ── fed.fomc (§10.9) ────────────────────────────────────────────────────────────────────────

async function runFomcHalf(ctx: MarketJobContext, result: EconCalendarResult): Promise<void> {
  const url = FOMC_CALENDAR_URL;
  if (!hasCapture(ctx, FED_FOMC_SOURCE_ID, url)) {
    // PROVIDERS §16.9: this page is not recorded. Writing nothing is the honest outcome.
    result.noCapture.push(url);
    ctx.log?.info?.('econCalendar.fomc_no_capture', { url });
    return;
  }

  let raw: RawRecord;
  try {
    raw = await fetchGet(ctx, FED_FOMC_SOURCE_ID, url, () =>
      ctx.http!.get({
        providerId: FED_FOMC_SOURCE_ID,
        url,
        cacheTtlMs: FOMC_CACHE_TTL_MS,
        ...requestEnvelope(ctx),
      }),
    );
  } catch (err) {
    result.errors.push(fetchError(err, url));
    return;
  }
  if (raw.status === 304) {
    result.skipped += 1;
    return;
  }
  result.fetched += 1;

  const lines = linesOf(await resolveTargets(ctx, FED_FOMC_SOURCE_ID, { instrumentIds: null }));
  const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
    raw,
    adapterVersion: FOMC_ADAPTER_VERSION,
    lines,
    normalise: (r) => {
      const parsed = parseFomcCalendar(r.body);
      return { updates: [], rows: parsed.rows, sourceTs: r.sourceTs, problems: parsed.problems };
    },
  });
  result.provenanceIds.push(provenanceId);
  result.problems.push(...norm.problems);

  if (norm.rows.meetings.length === 0) {
    const detail =
      'fed.fomc yielded no usable year panel; the stored FOMC calendar stands (§10.9)';
    result.errors.push({ code: 'FOMC_CALENDAR_FAILED_CLOSED', message: detail, url });
    await recordDqEvent(ctx.tx, {
      kind: 'parse_error',
      severity: 'error',
      sourceId: FED_FOMC_SOURCE_ID,
      subject: 'fomc_meetings',
      key: String(raw.sha256),
      details: { url, years: norm.rows.years },
    });
    return;
  }

  const written = await upsertFomcMeetings(ctx.tx, norm.rows.meetings, provenanceId);
  result.fomc.meetings = written;
  result.inserted += written;
  result.skipped += norm.rows.meetings.length - written;

  // §10.9: one `econ_releases` row and one event per meeting, so FOMC days appear on ECO.
  const release = await upsertEconRelease(ctx.tx, {
    sourceId: FED_FOMC_SOURCE_ID,
    providerReleaseId: 'FOMC',
    name: 'FOMC statement',
    country: 'US',
    url,
  });
  result.fomc.releases = release.written ? 1 : 0;
  result.inserted += result.fomc.releases;
  result.skipped += 1 - result.fomc.releases;
  const events = norm.rows.meetings.map((meeting) => ({
    releaseId: release.releaseId,
    scheduledAt: meeting.statementAt,
    timeKnown: true,
    periodLabel: meeting.meetingDate,
    seriesId: null,
    provenanceId,
  }));
  result.fomc.events = await upsertReleaseEvents(ctx.tx, events);
  result.inserted += result.fomc.events;
  result.skipped += events.length - result.fomc.events;
}

/** The scheduler row (PROVIDERS §13). */
export const job = {
  id: 'econCalendar',
  schedule: ECON_CALENDAR_SCHEDULE,
  provider: [
    FRED_CALENDAR_SOURCE_ID,
    BLS_SCHEDULE_SOURCE_ID,
    FED_FOMC_SOURCE_ID,
  ] as readonly ProviderId[],
  priority: 3 as const,
  timeoutMs: 120_000,
  run: (ctx: MarketJobContext): Promise<MarketJobResult> => runEconCalendar(ctx),
};
