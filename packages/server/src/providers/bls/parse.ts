/**
 * `bls.timeseries` and `bls.schedule` — the pure half. PROVIDERS.b §10.5 and §10.6, WORKPLAN WP-05.
 *
 * Two payloads, one family, one `adapter_version`:
 *
 *  - **`bls.timeseries`** is a JSON envelope whose `status` field is a gate: BLS answers `200 OK`
 *    with `status: "REQUEST_NOT_PROCESSED"` when the daily quota is exhausted or a series id is
 *    bad, so the parse never treats an empty `Results` as "no data". It reports the status and the
 *    caller (`ingest/jobs/blsSeries.ts`) raises `ProviderHttpError(200)` on anything other than
 *    `REQUEST_SUCCEEDED` — which trips the breaker and burns no further quota. Raising it here is
 *    impossible by design: `parse.ts` never throws (§1.2, QA-05).
 *  - **`bls.schedule`** is the monthly release calendar, an HTML `<table>` of day cells. Each cell
 *    carries zero or more releases as `<p><strong>Name</strong>Period<br>08:30 AM</p>`. The time
 *    is Eastern and is converted with the US federal DST rule, so a release inside DST and one
 *    outside both land on the right UTC instant; `time_known` is `true` for every BLS row, which
 *    is what upgrades FRED's 08:30 default (§10.2).
 *
 * The one arithmetic reason this file is careful: `M13` is BLS's **annual average**, not a
 * thirteenth month. Treating it as one corrupts every monthly chart, so it is skipped with a
 * `field_dropped` problem and named in the detail.
 */

import type { NormalisedUpdate } from '@terminal/core';

import { decodeHtmlEntities, normaliseSpace, scanHtml } from '../html.js';
import type { NormaliseContext, NormaliseProblem, Normalised, RawRecord } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Eastern wall clock → UTC (pure; §10.6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const MS_PER_HOUR = 3_600_000;

/** Day of the month of the `n`-th Sunday of `month` (1-12) in `year`. */
function nthSunday(year: number, month: number, n: number): number {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstSunday = 1 + ((7 - firstWeekday) % 7);
  return firstSunday + (n - 1) * 7;
}

/**
 * `true` when an Eastern wall-clock instant falls in daylight time: from 02:00 on the second
 * Sunday of March to 02:00 on the first Sunday of November (the US federal rule since 2007).
 *
 * The two boundary hours are the only places this can be asked an unanswerable question — 02:30
 * in March does not exist and 01:30 in November happens twice. Both resolve to daylight time,
 * deterministically, because a golden file may not depend on which way a library guesses. No BLS
 * release is published in either hour.
 */
export function isEasternDaylight(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): boolean {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const start = Date.UTC(year, 2, nthSunday(year, 3, 2), 2, 0);
  const end = Date.UTC(year, 10, nthSunday(year, 11, 1), 2, 0);
  return wall >= start && wall < end;
}

/** An Eastern wall-clock date and time → epoch ms UTC. */
export function easternWallToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const offsetHours = isEasternDaylight(year, month, day, hour, minute) ? 4 : 5;
  return Date.UTC(year, month - 1, day, hour, minute) + offsetHours * MS_PER_HOUR;
}

/** Epoch ms → `YYYY-MM-DDTHH:MM:SSZ` (the manifest's own instant style: no sub-second noise). */
function isoSeconds(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §10.5 — the timeseries payload
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The only `status` value that means the payload carries data (§10.5). */
export const BLS_STATUS_SUCCEEDED = 'REQUEST_SUCCEEDED';

/** One `econ_observations` row, entity ids excluded (the writer assigns them). */
export interface BlsObservationRow {
  /** `econ_series.provider_code` — `'CUUR0000SA0'`. */
  providerCode: string;
  /** Period start: monthly → the 1st, quarterly → the quarter's first day, annual → Jan 1. */
  obsDate: string;
  /** The published period code, kept so a re-parse can be audited: `'M08'`, `'Q02'`, `'A01'`. */
  period: string;
  periodName: string;
  /** `null` with `status 'missing'` when the published value is `'-'`. */
  value: number | null;
  status: 'final' | 'missing';
  /** `footnotes[0].text`; `footnotes: [{}]` is the normal case and yields `null`. */
  footnote: string | null;
}

/** One `econ_series` row's worth of what this payload publishes about a series. */
export interface BlsSeriesRow {
  providerCode: string;
  frequency: 'M' | 'Q' | 'A' | null;
  observationCount: number;
  firstObsDate: string | null;
  lastObsDate: string | null;
  /** The value BLS flags `latest: "true"`, `null` when none is flagged or it is missing. */
  latestValue: number | null;
  latestObsDate: string | null;
}

export interface BlsTimeseriesRows {
  /** The envelope gate (§10.5). Anything but `REQUEST_SUCCEEDED` means no data was published. */
  status: string;
  /** BLS's own warnings, which ride the envelope even on success → `dq_events.details.messages`. */
  messages: string[];
  series: BlsSeriesRow[];
  observations: BlsObservationRow[];
}

/** `true` when the envelope says the payload carries data. The caller raises on `false` (§10.5). */
export function blsRequestSucceeded(rows: BlsTimeseriesRows): boolean {
  return rows.status === BLS_STATUS_SUCCEEDED;
}

/**
 * Code-unit ordering. `String.prototype.localeCompare` is locale- and ICU-dependent, and a golden
 * file may not depend on which collation the host happens to ship.
 */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(body: Buffer | string): string {
  return typeof body === 'string' ? body : body.toString('utf8');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

interface PeriodResolution {
  obsDate: string;
  frequency: 'M' | 'Q' | 'A';
  /** The name BLS should have published for this period, for the §10.5 cross-check. */
  expectedName: string | null;
}

/**
 * `year` + `period` → the period-start date (§10.5).
 *
 * `M01`-`M12` → the 1st of that month; `Q01`-`Q04` → the quarter's first day; `A01` → January 1.
 * `M13` (the annual average) and every other code return `null`: a thirteenth month would be
 * charted as December's successor.
 */
export function blsPeriodStart(year: number, period: string): PeriodResolution | null {
  const code = period.toUpperCase();
  const month = /^M(\d{2})$/.exec(code);
  if (month !== null) {
    const index = Number(month[1]);
    if (index < 1 || index > 12) return null;
    return {
      obsDate: `${String(year)}-${pad2(index)}-01`,
      frequency: 'M',
      expectedName: MONTH_NAMES[index - 1] ?? null,
    };
  }
  const quarter = /^Q(\d{2})$/.exec(code);
  if (quarter !== null) {
    const index = Number(quarter[1]);
    if (index < 1 || index > 4) return null;
    return {
      obsDate: `${String(year)}-${pad2(index * 3 - 2)}-01`,
      frequency: 'Q',
      expectedName: null,
    };
  }
  if (code === 'A01') {
    return { obsDate: `${String(year)}-01-01`, frequency: 'A', expectedName: null };
  }
  return null;
}

/**
 * The BLS v2 timeseries payload → rows.
 *
 * Observations come back **ascending** by `(providerCode, obsDate)`; the payload publishes them
 * newest-first, and a golden that depended on that would reverse itself the first time BLS changed
 * its mind.
 */
export function parseBlsTimeseries(body: Buffer | string): {
  rows: BlsTimeseriesRows;
  problems: NormaliseProblem[];
} {
  const empty: BlsTimeseriesRows = { status: '', messages: [], series: [], observations: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(textOf(body));
  } catch (err) {
    return { rows: empty, problems: [{ kind: 'parse_error', detail: messageOf(err) }] };
  }
  if (!isRecord(doc)) {
    return {
      rows: empty,
      problems: [{ kind: 'schema_drift', detail: 'bls payload is not an object' }],
    };
  }

  const problems: NormaliseProblem[] = [];
  const status = typeof doc.status === 'string' ? doc.status : '';
  const messages = Array.isArray(doc.message)
    ? doc.message.filter((m: unknown): m is string => typeof m === 'string')
    : [];
  if (status !== BLS_STATUS_SUCCEEDED) {
    problems.push({
      kind: 'schema_drift',
      detail:
        `bls answered status '${status}' (not ${BLS_STATUS_SUCCEEDED}) — the quota is exhausted ` +
        `or a series id is bad; messages: ${messages.join('; ')}`,
      path: '/status',
    });
  }

  const results = doc.Results;
  const seriesList = isRecord(results) && Array.isArray(results.series) ? results.series : [];
  if (!isRecord(results) || !Array.isArray(results.series)) {
    if (status === BLS_STATUS_SUCCEEDED) {
      problems.push({
        kind: 'schema_drift',
        detail: 'bls payload carries no Results.series array',
        path: '/Results/series',
      });
    }
    return { rows: { status, messages, series: [], observations: [] }, problems };
  }

  const series: BlsSeriesRow[] = [];
  const observations: BlsObservationRow[] = [];

  seriesList.forEach((entry: unknown, seriesIndex: number) => {
    if (!isRecord(entry)) {
      problems.push({
        kind: 'schema_drift',
        detail: 'bls series entry is not an object',
        path: `/Results/series/${String(seriesIndex)}`,
      });
      return;
    }
    const providerCode = typeof entry.seriesID === 'string' ? entry.seriesID.trim() : '';
    if (providerCode === '') {
      problems.push({
        kind: 'schema_drift',
        detail: 'bls series entry carries no seriesID',
        path: `/Results/series/${String(seriesIndex)}`,
      });
      return;
    }
    const data = Array.isArray(entry.data) ? entry.data : [];
    if (!Array.isArray(entry.data)) {
      problems.push({
        kind: 'schema_drift',
        detail: `bls series ${providerCode} carries no data array`,
        path: `/Results/series/${String(seriesIndex)}/data`,
      });
    }

    const mine: BlsObservationRow[] = [];
    let frequency: 'M' | 'Q' | 'A' | null = null;
    let latestValue: number | null = null;
    let latestObsDate: string | null = null;

    data.forEach((point: unknown, pointIndex: number) => {
      const path = `/Results/series/${String(seriesIndex)}/data/${String(pointIndex)}`;
      if (!isRecord(point)) {
        problems.push({ kind: 'schema_drift', detail: 'bls data point is not an object', path });
        return;
      }
      const yearText = typeof point.year === 'string' ? point.year : '';
      const period = typeof point.period === 'string' ? point.period : '';
      const periodName = typeof point.periodName === 'string' ? point.periodName : '';
      const year = Number(yearText);
      if (!/^\d{4}$/.test(yearText) || !Number.isInteger(year)) {
        problems.push({
          kind: 'schema_drift',
          detail: `bls data point has no four-digit year ('${yearText}')`,
          path,
        });
        return;
      }
      const resolved = blsPeriodStart(year, period);
      if (resolved === null) {
        problems.push({
          kind: 'field_dropped',
          detail:
            period.toUpperCase() === 'M13'
              ? `bls period M13 (${yearText} annual average) is not a month and is skipped`
              : `bls period '${period}' is not a recognised period code`,
          path,
        });
        return;
      }
      frequency ??= resolved.frequency;
      if (resolved.expectedName !== null && periodName !== resolved.expectedName) {
        problems.push({
          kind: 'schema_drift',
          detail:
            `bls periodName '${periodName}' disagrees with period ${period} ` +
            `(expected '${resolved.expectedName}')`,
          path,
        });
      }

      const rawValue = typeof point.value === 'string' ? point.value.trim() : '';
      let value: number | null = null;
      let pointStatus: 'final' | 'missing' = 'final';
      if (rawValue === '' || rawValue === '-' || rawValue === '.' || rawValue === 'ND') {
        pointStatus = 'missing';
      } else {
        const parsed = Number(rawValue.replace(/,/g, ''));
        if (Number.isFinite(parsed)) {
          value = parsed;
        } else {
          pointStatus = 'missing';
          problems.push({
            kind: 'field_dropped',
            detail: `bls value '${rawValue}' is not a number`,
            path: `${path}/value`,
          });
        }
      }

      let footnote: string | null = null;
      const footnotes = point.footnotes;
      if (Array.isArray(footnotes)) {
        for (const note of footnotes) {
          if (isRecord(note) && typeof note.text === 'string' && note.text.trim() !== '') {
            footnote = note.text.trim();
            break;
          }
        }
      }

      const row: BlsObservationRow = {
        providerCode,
        obsDate: resolved.obsDate,
        period: period.toUpperCase(),
        periodName,
        value,
        status: pointStatus,
        footnote,
      };
      mine.push(row);

      // `latest: "true"` is BLS's own marker. Our `is_latest` is per (series, obs_date) and is
      // maintained by the upsert (§10.5), so the flag is used only to report what the payload
      // claims is current — never stored.
      if (point.latest === 'true') {
        latestValue = value;
        latestObsDate = resolved.obsDate;
      }
    });

    mine.sort((a, b) => (a.obsDate < b.obsDate ? -1 : a.obsDate > b.obsDate ? 1 : 0));
    observations.push(...mine);
    series.push({
      providerCode,
      frequency,
      observationCount: mine.length,
      firstObsDate: mine[0]?.obsDate ?? null,
      lastObsDate: mine[mine.length - 1]?.obsDate ?? null,
      latestValue,
      latestObsDate,
    });

    if (mine.length === 0 && status === BLS_STATUS_SUCCEEDED) {
      problems.push({
        kind: 'field_dropped',
        detail: `bls series ${providerCode} returned zero observations on a succeeded request`,
        path: `/Results/series/${String(seriesIndex)}`,
      });
    }
  });

  series.sort((a, b) => cmp(a.providerCode, b.providerCode));
  observations.sort(
    (a, b) =>
      cmp(a.providerCode, b.providerCode) ||
      (a.obsDate < b.obsDate ? -1 : a.obsDate > b.obsDate ? 1 : 0),
  );

  return { rows: { status, messages, series, observations }, problems };
}

/**
 * `bls.timeseries` → rows, plus one plant update per series that has an `md_lines` row
 * (§10.5: subject `e:<seriesId>`, `PX_LAST` = the latest published observation).
 *
 * BLS publishes no instant with the payload, so `sourceTs` is whatever the transport recorded
 * (`null` for every recorded capture) — the release instant belongs to §10.6's calendar, not here.
 */
export function normaliseBlsTimeseries(
  raw: RawRecord,
  ctx: NormaliseContext,
): Normalised<BlsTimeseriesRows> {
  const { rows, problems } = parseBlsTimeseries(raw.body);

  const updates: NormalisedUpdate[] = [];
  for (const entry of rows.series) {
    const line = ctx.lines.get(entry.providerCode);
    if (line === undefined) continue;
    if (entry.latestObsDate === null || entry.latestValue === null) continue;
    const value = entry.latestValue;
    updates.push({
      subject: `e:${entry.providerCode}`,
      instrumentId: line.instrumentId,
      mdLineId: line.mdLineId,
      assetClass: line.assetClass,
      tier: line.tier,
      fields: { PX_LAST: value },
      ts: { src: null, cap: ctx.capturedAt, pub: ctx.capturedAt },
      prov: { sourceId: 'bls.timeseries', provenanceId: ctx.provenanceId },
    });
  }

  return { updates, rows, sourceTs: raw.sourceTs, problems };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §10.6 — the release schedule
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** §10.6: fewer than this many parsed rows means the page changed shape, not that BLS went quiet. */
export const MIN_SCHEDULE_ROWS = 5;

/** One `econ_releases` row (CONTRACTS §1.2), entity ids excluded. */
export interface BlsReleaseRow {
  /** `'cpi'`, `'empsit'` — the BLS release slug, from the page's own "BY NEWS RELEASE" index. */
  providerReleaseId: string;
  name: string;
  country: 'US';
  /** The release's own schedule page, or `null` when the index does not list it. */
  url: string | null;
}

/** One `econ_release_events` row. `scheduledAt` is UTC; `timeKnown` is always true here (§10.6). */
export interface BlsReleaseEventRow {
  providerReleaseId: string;
  name: string;
  /** ISO-8601 UTC, seconds precision. */
  scheduledAt: string;
  timeKnown: true;
  /** `'August 2026'`, `'Second Quarter 2026'`, `'2024-2025'` — exactly as published. */
  periodLabel: string;
  status: 'scheduled';
  /** The Eastern calendar date the page listed it under, for audit. */
  localDate: string;
  /** The Eastern wall time as published, `'08:30'`. */
  localTime: string;
}

export interface BlsScheduleRows {
  /** The month the page is for, from its `<title>`. */
  year: number;
  month: number;
  title: string;
  releases: BlsReleaseRow[];
  events: BlsReleaseEventRow[];
}

/** What the caller knows from the URL it built, for the §10.6 structural assertion. */
export interface BlsScheduleExpectation {
  year: number;
  /** 1-12. */
  month: number;
}

/** `'Consumer Price Index (R)'` → `'CONSUMER PRICE INDEX'`: upper, no parentheticals, no punctuation. */
function foldReleaseName(name: string): string {
  return normaliseSpace(
    name
      .replace(/\([^)]*\)/g, ' ')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' '),
  );
}

function tokensOf(folded: string): string[] {
  return folded === '' ? [] : folded.split(' ');
}

/**
 * Match a calendar entry to a slug from the page's own release index.
 *
 * Three rules, in order, because the two lists genuinely disagree: the calendar says
 * `'Job Openings and Labor Turnover Survey'` where the index says `'Job Openings and Labor
 * Turnover'` (a prefix), and `'U.S. Import and Export Price Indexes'` where the index says
 * `'U.S. Export and Import Price Indexes'` (the same tokens, transposed).
 */
function matchSlug(name: string, index: ReadonlyMap<string, string>): string | null {
  const folded = foldReleaseName(name);
  if (folded === '') return null;
  const exact = index.get(folded);
  if (exact !== undefined) return exact;
  for (const [candidate, slug] of index) {
    if (folded.startsWith(`${candidate} `) || candidate.startsWith(`${folded} `)) return slug;
  }
  const mine = [...tokensOf(folded)].sort();
  for (const [candidate, slug] of index) {
    const theirs = [...tokensOf(candidate)].sort();
    if (mine.length === theirs.length && mine.every((token, i) => token === theirs[i])) return slug;
  }
  return null;
}

/** The fallback provider id for a release the index does not list: `'employee tenure'` → `'employeeTenure'`. */
function slugFromName(name: string): string {
  const words = tokensOf(foldReleaseName(name)).map((word) => word.toLowerCase());
  const first = words[0] ?? 'release';
  return (
    first +
    words
      .slice(1)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('')
  );
}

interface CalendarEntry {
  /** `'0911'`. */
  cell: string;
  segments: string[];
}

/** `'Schedule of Selected Releases for September 2026'` → `{year, month}`. */
export function parseScheduleTitle(title: string): { year: number; month: number } | null {
  const match = /\b([A-Za-z]+)\s+(\d{4})\b/.exec(title);
  if (match === null) return null;
  const monthName = (match[1] ?? '').toLowerCase();
  const index = MONTH_NAMES.findIndex((name) => name.toLowerCase() === monthName);
  if (index < 0) return null;
  return { year: Number(match[2]), month: index + 1 };
}

/** `'08:30 AM'` → `{hour, minute}` on a 24-hour clock; `null` when the cell carries no time. */
export function parseEasternClock(text: string): { hour: number; minute: number } | null {
  const match = /(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?/.exec(text);
  if (match === null) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const meridiem = (match[3] ?? '').toLowerCase();
  if (meridiem === 'p' && hour !== 12) hour += 12;
  if (meridiem === 'a' && hour === 12) hour = 0;
  return { hour, minute };
}

/**
 * The BLS monthly release calendar → `econ_releases` + `econ_release_events`.
 *
 * Cells are addressed by their own `id="dMMDD"`, never by counting columns: the grid starts and
 * ends with `class="other-month"` days, and counting is exactly how the first Monday of the month
 * would be filed under the previous one. A cell whose `MM` is not the page's month belongs to the
 * neighbouring month, with the year rolled when it crosses January.
 *
 * @param expected the month the caller asked for; when given, a title naming a different month is
 *   a `schema_drift` and no rows are returned (§10.6: the previous schedule stands).
 */
export function parseBlsSchedule(
  body: Buffer | string,
  expected?: BlsScheduleExpectation,
): { rows: BlsScheduleRows; problems: NormaliseProblem[] } {
  const source = textOf(body);
  const problems: NormaliseProblem[] = [];
  const empty: BlsScheduleRows = {
    year: expected?.year ?? 0,
    month: expected?.month ?? 0,
    title: '',
    releases: [],
    events: [],
  };

  if (source.trim() === '') {
    return {
      rows: empty,
      problems: [{ kind: 'parse_error', detail: 'bls schedule body is empty' }],
    };
  }

  // ── scan ───────────────────────────────────────────────────────────────────────────────────
  let title = '';
  let inTitle = false;
  /** folded index name → slug, from the page's own "BY NEWS RELEASE" list. */
  const slugIndex = new Map<string, string>();
  let anchorSlug: string | null = null;
  let anchorText = '';
  /** `'0911'` while inside a day cell. */
  let cell: string | null = null;
  let cellDepth = 0;
  let paragraph: string[] | null = null;
  const entries: CalendarEntry[] = [];

  scanHtml(source, {
    onOpen(tag) {
      if (tag.name === 'title' && title === '') {
        inTitle = true;
        return;
      }
      if (tag.name === 'a') {
        const href = tag.attrs.href ?? '';
        const slug = /^\/schedule\/news_release\/([a-z0-9_]+)\.htm$/.exec(href)?.[1];
        anchorSlug = slug ?? null;
        anchorText = '';
        return;
      }
      if (tag.name === 'td') {
        const id = tag.attrs.id ?? '';
        if (/^d\d{4}$/.test(id)) {
          cell = id.slice(1);
          cellDepth = 0;
        }
        return;
      }
      if (cell !== null && tag.name === 'p') {
        // `<p class="day">11</p>` is the day number, not a release.
        if ((tag.attrs.class ?? '') === 'day') {
          paragraph = null;
          return;
        }
        paragraph = [''];
        return;
      }
      if (paragraph !== null && tag.name === 'br') {
        paragraph.push('');
        return;
      }
      if (cell !== null && tag.name === 'table') cellDepth += 1;
    },
    onText(text) {
      if (inTitle) {
        title += text;
        return;
      }
      if (anchorSlug !== null) anchorText += text;
      if (paragraph === null) return;
      const last = paragraph.length - 1;
      paragraph[last] = (paragraph[last] ?? '') + text;
    },
    onClose(name) {
      if (name === 'title') {
        inTitle = false;
        return;
      }
      if (name === 'a') {
        if (anchorSlug !== null) {
          const folded = foldReleaseName(decodeHtmlEntities(anchorText));
          if (folded !== '' && !slugIndex.has(folded)) slugIndex.set(folded, anchorSlug);
        }
        anchorSlug = null;
        anchorText = '';
        return;
      }
      if (name === 'p' && paragraph !== null && cell !== null) {
        const segments = paragraph.map((segment) => normaliseSpace(decodeHtmlEntities(segment)));
        if (segments.some((segment) => segment !== '')) entries.push({ cell, segments });
        paragraph = null;
        return;
      }
      if (name === 'table' && cell !== null && cellDepth > 0) {
        cellDepth -= 1;
        return;
      }
      if (name === 'td' && cell !== null && cellDepth === 0) {
        cell = null;
        paragraph = null;
      }
    },
    onProblem(problem) {
      if (problems.length < 20) problems.push(problem);
    },
  });

  title = normaliseSpace(decodeHtmlEntities(title));
  const fromTitle = parseScheduleTitle(title);
  if (fromTitle === null) {
    problems.push({
      kind: 'schema_drift',
      detail: `bls schedule <title> names no month and year ('${title}')`,
      path: '/html/head/title',
    });
    return { rows: { ...empty, title }, problems };
  }
  if (
    expected !== undefined &&
    (expected.year !== fromTitle.year || expected.month !== fromTitle.month)
  ) {
    problems.push({
      kind: 'schema_drift',
      detail:
        `bls schedule <title> is '${title}' but ${String(expected.year)}-` +
        `${pad2(expected.month)} was requested`,
      path: '/html/head/title',
    });
    return { rows: { ...empty, title, year: fromTitle.year, month: fromTitle.month }, problems };
  }

  // ── rows ───────────────────────────────────────────────────────────────────────────────────
  const releases = new Map<string, BlsReleaseRow>();
  const events: BlsReleaseEventRow[] = [];

  for (const entry of entries) {
    const name = entry.segments[0] ?? '';
    if (name === '') continue;
    const timeText = entry.segments[entry.segments.length - 1] ?? '';
    const clock = parseEasternClock(timeText);
    if (clock === null) continue; // a holiday cell, or a note with no release time

    const month = Number(entry.cell.slice(0, 2));
    const day = Number(entry.cell.slice(2));
    if (!Number.isInteger(month) || month < 1 || month > 12 || day < 1 || day > 31) {
      problems.push({
        kind: 'schema_drift',
        detail: `bls schedule cell id 'd${entry.cell}' is not a MMDD date`,
      });
      continue;
    }
    // A cell from the neighbouring month: December in a January page is the previous year, and
    // January in a December page is the next one.
    let year = fromTitle.year;
    if (month === 12 && fromTitle.month === 1) year -= 1;
    else if (month === 1 && fromTitle.month === 12) year += 1;

    const slug = matchSlug(name, slugIndex);
    const providerReleaseId = slug ?? slugFromName(name);
    if (slug === null) {
      problems.push({
        kind: 'field_dropped',
        detail:
          `bls release '${name}' is not in the page's release index; ` +
          `provider_release_id '${providerReleaseId}' is derived from the name`,
      });
    }
    if (!releases.has(providerReleaseId)) {
      releases.set(providerReleaseId, {
        providerReleaseId,
        name,
        country: 'US',
        url: slug === null ? null : `https://www.bls.gov/schedule/news_release/${slug}.htm`,
      });
    }

    const periodLabel = entry.segments.length >= 3 ? (entry.segments[1] ?? '') : '';
    events.push({
      providerReleaseId,
      name,
      scheduledAt: isoSeconds(easternWallToUtcMs(year, month, day, clock.hour, clock.minute)),
      timeKnown: true,
      periodLabel,
      status: 'scheduled',
      localDate: `${String(year)}-${pad2(month)}-${pad2(day)}`,
      localTime: `${pad2(clock.hour)}:${pad2(clock.minute)}`,
    });
  }

  events.sort(
    (a, b) =>
      (a.scheduledAt < b.scheduledAt ? -1 : a.scheduledAt > b.scheduledAt ? 1 : 0) ||
      cmp(a.providerReleaseId, b.providerReleaseId),
  );

  if (events.length < MIN_SCHEDULE_ROWS) {
    problems.push({
      kind: 'schema_drift',
      detail:
        `bls schedule parsed ${String(events.length)} release rows, fewer than the ` +
        `${String(MIN_SCHEDULE_ROWS)} the page must carry — the previous schedule stands (§10.6)`,
    });
    return {
      rows: { year: fromTitle.year, month: fromTitle.month, title, releases: [], events: [] },
      problems,
    };
  }

  return {
    rows: {
      year: fromTitle.year,
      month: fromTitle.month,
      title,
      releases: [...releases.values()].sort((a, b) =>
        cmp(a.providerReleaseId, b.providerReleaseId),
      ),
      events,
    },
    problems,
  };
}

/** `bls.schedule` → rows. No plant subject and no `md_lines` row (§10.6). */
export function normaliseBlsSchedule(
  raw: RawRecord,
  _ctx: NormaliseContext,
  expected?: BlsScheduleExpectation,
): Normalised<BlsScheduleRows> {
  const { rows, problems } = parseBlsSchedule(raw.body, expected);
  return { updates: [], rows, sourceTs: raw.sourceTs, problems };
}
