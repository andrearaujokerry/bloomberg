/**
 * `fred.csv` and `fred.calendar` — the pure half (PROVIDERS §10.1, §10.2).
 *
 * Three parsers, one per recorded capture:
 *
 *  - {@link parseFredCsv}          `fredgraph.csv?id=DGS10` → `econ_observations`;
 *  - {@link normaliseCalendar}     `/releases/calendar`     → `econ_releases` + `econ_release_events`;
 *  - {@link parseReleaseCatalogue} `/releases`              → `econ_releases` (the catalogue page).
 *
 * PURITY (PROVIDERS §1.2, QA-05): no IO, no clock, no randomness, no throw. The two HTML parsers
 * go through the tolerant tokeniser in `providers/html.ts` — a tag/text scanner, not a DOM — so
 * there is no dependency to keep current and no scripting to execute.
 *
 * **The calendar fails closed** (§10.2). FRED's pages are generated HTML with no stable ids, so
 * the only defence against silent drift is the count in
 * `<meta name="description" content="34 economic release dates.">`. When the number of rows parsed
 * does not equal the number advertised, this returns **no** rows at all and a `parse_error`
 * problem naming both numbers: the previous calendar stands and ECO never shows a partially
 * parsed day.
 */

import type { Normalised, NormaliseContext, NormaliseProblem, RawRecord } from '../types.js';
import { field, parseCsvTable, stripBom } from '../csv.js';
import { anchors, extractTables, metaContent, normaliseSpace, stripTags } from '../html.js';
import type { HtmlRow, HtmlTable } from '../html.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `provenance.adapter_version` for both FRED adapters (PROVIDERS §1.4). */
export const FRED_ADAPTER_VERSION = 'fred/1.0.0';

/** `econ_release_events.consensus_unavailable_reason` — v1 has no consensus source (BRIEF §2). */
export const NO_CONSENSUS_REASON =
  'NO_SOURCE: no consensus provider is reachable keyless (BRIEF §2)';

/** The modal US release time, used when the calendar publishes no time for a row (§10.2). */
export const DEFAULT_RELEASE_TIME_ET = '08:30';

/** FRED's missing-observation markers. `'.'` is the published one; the other two are historical. */
const MISSING_MARKERS: ReadonlySet<string> = new Set(['.', 'nd', '', 'na', 'n/a']);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RID_RE = /^\/release\?rid=(\d+)/;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `econ_observations` row, less the columns the ingest upsert owns. */
export interface EconObservationRow {
  /** `econ_series.provider_code` — `'DGS10'`. The job maps it to its `series_code`. */
  providerCode: string;
  /** `YYYY-MM-DD`, period start: a monthly series carries the first of the month. */
  obsDate: string;
  /** `null` with `status 'missing'` for `'.'`, `'ND'` and an empty field. */
  value: number | null;
  status: 'final' | 'missing';
}

/** What the file itself says about the series — everything `econ_series` can learn from a poll. */
export interface FredSeriesFacts {
  /** Column 2's header, which is the authoritative series code (§10.1). */
  providerCode: string | null;
  /** The `id` parameter of the request that produced this body, read back from `raw.url`. */
  requestedCode: string | null;
  firstObsDate: string | null;
  lastObsDate: string | null;
  observationCount: number;
  missingCount: number;
}

export interface FredCsvRows {
  series: FredSeriesFacts;
  observations: EconObservationRow[];
}

/** One `econ_releases` row. */
export interface EconReleaseRow {
  sourceId: 'fred.calendar';
  /** FRED's `rid` — `econ_releases.provider_release_id`, stable across renames. */
  providerReleaseId: string;
  name: string;
  country: 'US';
  url: string;
  /** `econ_releases.importance`, 1–3. FRED publishes none, so every row is the default 2. */
  importance: number;
}

/** One `econ_release_events` row, less `release_id`/`series_id`/`provenance_id`. */
export interface EconReleaseEventRow {
  providerReleaseId: string;
  /** ISO instant, ET wall time converted with the US federal DST rule. */
  scheduledAt: string;
  /** `false` when the row published no time and the 08:30 ET default was used. */
  timeKnown: boolean;
  /** `''` — the calendar publishes no period; `econ_release_events.period_label` is NOT NULL. */
  periodLabel: string;
  status: 'scheduled';
  consensus: null;
  consensusUnavailableReason: string;
}

export interface FredCalendarRows {
  /** The count in the page's own `<meta name="description">`, or `null` when absent. */
  advertisedCount: number | null;
  /** How many release rows the parse actually found. */
  parsedCount: number;
  releases: EconReleaseRow[];
  events: EconReleaseEventRow[];
}

export interface FredCatalogueRows {
  /** `332` from `Releases 1 - 50 of 332`, the catalogue's full size across all pages. */
  advertisedTotal: number | null;
  /** The `1` and the `50` of the same line — this page's slice. */
  pageFirst: number | null;
  pageLast: number | null;
  releases: EconReleaseRow[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Eastern time
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The UTC offset of `America/New_York` on an ISO date, by the US federal rule in force since 2007:
 * EDT from the second Sunday in March to the first Sunday in November, EST otherwise.
 *
 * The rule is spelled out rather than delegated to `Intl` on purpose. `scheduled_at` ends up in a
 * committed golden, and an ICU update that shifted a boundary would break the golden of a *past*
 * capture — a parser whose output depends on the machine's tz database is not the pure function
 * `fixtures/providers/normalised/` promises. Transitions happen at 02:00 local, which no release
 * time this parser sees is near, so a date-level offset is exact here.
 */
export function easternOffset(date: string): '-04:00' | '-05:00' {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return '-05:00';
  const key = month * 100 + day;
  const start = 300 + nthSunday(year, 3, 2);
  const end = 1100 + nthSunday(year, 11, 1);
  return key >= start && key < end ? '-04:00' : '-05:00';
}

/** Day of month of the `n`-th Sunday of `month` (1-based) in `year`. */
function nthSunday(year: number, month: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstSunday = 1 + ((7 - firstDow) % 7);
  return firstSunday + (n - 1) * 7;
}

/** `('2026-09-15', '08:30')` → `'2026-09-15T12:30:00.000Z'`, or `null` when unrepresentable. */
export function easternInstant(date: string, time: string): string | null {
  const at = Date.parse(`${date}T${time}:00${easternOffset(date)}`);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §10.1 — fredgraph.csv
// ─────────────────────────────────────────────────────────────────────────────────────────────

const EMPTY_SERIES: FredSeriesFacts = {
  providerCode: null,
  requestedCode: null,
  firstObsDate: null,
  lastObsDate: null,
  observationCount: 0,
  missingCount: 0,
};

function csvFailure(series: FredSeriesFacts, problem: NormaliseProblem): Normalised<FredCsvRows> {
  return {
    updates: [],
    rows: { series, observations: [] },
    sourceTs: null,
    problems: [problem],
  };
}

/** The `id` of the request this body answered, read back from the record's own URL. */
export function requestedSeriesId(url: string): string | null {
  try {
    return new URL(url).searchParams.get('id');
  } catch {
    return null;
  }
}

/**
 * `fred-DGS10.csv` → `econ_observations`.
 *
 * The series code is **column 2's header**, never the request parameter: FRED silently substitutes
 * a series when an id is retired, and the substituted file is well-formed. The two are compared
 * case-sensitively and a mismatch writes nothing.
 *
 * No `NormalisedUpdate` is emitted. The plant subject is `e:<seriesCode>` — *our* `series_code`,
 * not FRED's `provider_code` — and only the job holds that mapping; it publishes the delta from
 * these rows. Revision detection (`status 'revised'`, the `is_latest` flip) is likewise the job's:
 * it needs the stored vintage, which a pure function cannot see. Everything here is `'final'`,
 * meaning "as published in this body".
 */
export function parseFredCsv(raw: RawRecord, ctx: NormaliseContext): Normalised<FredCsvRows> {
  const requestedCode = requestedSeriesId(raw.url);
  const series: FredSeriesFacts = { ...EMPTY_SERIES, requestedCode };
  const text = stripBom(raw.body.toString('utf8'));

  // FRED serves its error page with status 200; the leading `<` is the only tell (§10.1).
  if (text.trimStart().startsWith('<')) {
    return csvFailure(series, {
      kind: 'parse_error',
      detail:
        'the body is HTML, not CSV — FRED serves its error page with status 200, so the job must raise ProviderHttpError rather than store an empty series',
      path: '/',
    });
  }

  const parsed = parseCsvTable(text, { skipEmptyLines: true });
  if (!parsed.ok) return csvFailure(series, parsed.problem);

  const table = parsed.table;
  const problems: NormaliseProblem[] = [...table.problems];
  const dateHeader = (table.header[0] ?? '').trim();
  const codeHeader = (table.header[1] ?? '').trim();

  if (dateHeader.toLowerCase() !== 'observation_date') {
    if (dateHeader.toLowerCase() === 'date') {
      problems.push({
        kind: 'schema_drift',
        detail: `column 1 is '${dateHeader}', not 'observation_date' — accepted, FRED renamed it once`,
        path: '/1/0',
      });
    } else {
      return csvFailure(series, {
        kind: 'schema_drift',
        detail: `column 1 is '${dateHeader}', expected 'observation_date'`,
        path: '/1/0',
      });
    }
  }
  if (codeHeader === '') {
    return csvFailure(series, {
      kind: 'schema_drift',
      detail: 'column 2 has no header, so the file names no series',
      path: '/1/1',
    });
  }
  series.providerCode = codeHeader;
  if (requestedCode !== null && requestedCode !== codeHeader) {
    return csvFailure(series, {
      kind: 'schema_drift',
      detail: `requested id '${requestedCode}' but the file is for '${codeHeader}' — FRED substitutes a series when an id is retired; nothing is written`,
      path: '/1/1',
    });
  }

  const observations: EconObservationRow[] = [];
  let missing = 0;
  table.rows.forEach((row, index) => {
    const line = index + 2; // 1-based, past the header
    const obsDate = (row[0] ?? '').trim();
    if (obsDate === '') return;
    if (!ISO_DATE_RE.test(obsDate)) {
      problems.push({
        kind: 'parse_error',
        detail: `observation_date '${obsDate}' is not an ISO date`,
        path: `/${String(line)}/0`,
      });
      return;
    }
    const cell = field(table, row, codeHeader);
    const cellValue = cell ?? '';
    if (MISSING_MARKERS.has(cellValue.toLowerCase())) {
      missing += 1;
      observations.push({ providerCode: codeHeader, obsDate, value: null, status: 'missing' });
      return;
    }
    const value = Number(cellValue.replace(/,/g, ''));
    if (!Number.isFinite(value)) {
      missing += 1;
      problems.push({
        kind: 'field_dropped',
        detail: `'${cellValue}' is not a number; stored as a missing observation`,
        path: `/${String(line)}/1`,
      });
      observations.push({ providerCode: codeHeader, obsDate, value: null, status: 'missing' });
      return;
    }
    observations.push({ providerCode: codeHeader, obsDate, value, status: 'final' });
  });

  series.observationCount = observations.length;
  series.missingCount = missing;
  series.firstObsDate = observations[0]?.obsDate ?? null;
  series.lastObsDate = observations[observations.length - 1]?.obsDate ?? null;

  void ctx;
  return { updates: [], rows: { series, observations }, sourceTs: null, problems };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §10.2 — the release calendar
// ─────────────────────────────────────────────────────────────────────────────────────────────

const MONTHS: ReadonlyMap<string, number> = new Map([
  ['january', 1],
  ['february', 2],
  ['march', 3],
  ['april', 4],
  ['may', 5],
  ['june', 6],
  ['july', 7],
  ['august', 8],
  ['september', 9],
  ['october', 10],
  ['november', 11],
  ['december', 12],
]);

const DATE_HEADING_RE = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/;
const TIME_RE = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i;

function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}

/** `'Tuesday September 15, 2026'` → `'2026-09-15'`, with an explicit month table (§10.2). */
export function parseCalendarHeading(text: string): string | null {
  const match = DATE_HEADING_RE.exec(normaliseSpace(text));
  if (match === null) return null;
  const month = MONTHS.get((match[1] ?? '').toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month === undefined || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  if (day < 1 || day > 31) return null;
  return `${String(year)}-${pad2(month)}-${pad2(day)}`;
}

/** `'1:00 am'` → `'01:00'`, `'3:15 pm'` → `'15:15'`. `null` for `'N/A'`, `''` and anything else. */
export function parseCalendarTime(text: string): string | null {
  const match = TIME_RE.exec(normaliseSpace(text));
  if (match === null) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = (match[3] ?? '').toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 12 || minute > 59) return null;
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** The `rid` of a `/release?rid=10` href, or `null`. */
export function ridOf(href: string): string | null {
  const match = RID_RE.exec(href.trim());
  return match === null ? null : (match[1] ?? null);
}

/** `'34 economic release dates. FRED: …'` → `34`. */
export function advertisedRowCount(source: string): number | null {
  const description = metaContent(source, 'description');
  if (description === null) return null;
  const match = /(\d[\d,]*)\s+economic release dates/i.exec(description);
  if (match === null) return null;
  const count = Number((match[1] ?? '').replace(/,/g, ''));
  return Number.isFinite(count) ? count : null;
}

/** The table holding the most `/release?rid=` links — bound by content, never by position. */
function releaseTable(tables: readonly HtmlTable[]): HtmlTable | null {
  let best: HtmlTable | null = null;
  let bestCount = 0;
  for (const table of tables) {
    let count = 0;
    for (const row of table.rows) {
      for (const cell of row.cells) {
        for (const link of cell.links) if (ridOf(link.href) !== null) count += 1;
      }
    }
    if (count > bestCount) {
      best = table;
      bestCount = count;
    }
  }
  return best;
}

/** The first `/release?rid=` anchor of a row, with its visible text. */
function releaseLinkOf(row: HtmlRow): { rid: string; name: string } | null {
  for (const cell of row.cells) {
    for (const link of cell.links) {
      const rid = ridOf(link.href);
      if (rid !== null) return { rid, name: link.text };
    }
  }
  return null;
}

function calendarFailure(
  rows: FredCalendarRows,
  problem: NormaliseProblem,
): Normalised<FredCalendarRows> {
  return {
    updates: [],
    rows: { ...rows, releases: [], events: [] },
    sourceTs: null,
    problems: [problem],
  };
}

/**
 * `fred-cal` → `econ_releases` + `econ_release_events`.
 *
 * Two invariants, both cheap and both loud (§10.2): the row count advertised in the page's own
 * `<meta name="description">`, and the `rid` in every release link. A row without an `rid` is
 * skipped; a count that disagrees discards the whole parse.
 *
 * **Deviation from §10.2, recorded here because the capture forced it.** The specification says
 * FRED publishes no time of day and pins every event at 08:30 ET with `time_known = false`. The
 * recorded page does publish times — `1:00 am`, `7:00 am`, `3:15 pm`, `N/A` — in the first cell of
 * each row, printed once per time group and left blank on the rows that share it. This parser
 * therefore reads the time when one is printed (`time_known = true`), inherits it down the group,
 * and falls back to 08:30 ET with `time_known = false` for `N/A` and for a group that starts with
 * no time at all. The fallback is the specified behaviour; taking a published time in preference
 * to a modal guess is strictly better, and it keeps §10.2's rule that a BLS time wins over a FRED
 * one meaningful only where FRED really has nothing.
 */
export function normaliseCalendar(
  raw: RawRecord,
  ctx: NormaliseContext,
): Normalised<FredCalendarRows> {
  const source = raw.body.toString('utf8');
  const advertisedCount = advertisedRowCount(source);
  const empty: FredCalendarRows = {
    advertisedCount,
    parsedCount: 0,
    releases: [],
    events: [],
  };

  const parsed = extractTables(source);
  if (!parsed.ok) return calendarFailure(empty, parsed.problem);

  const table = releaseTable(parsed.tables);
  if (table === null) {
    return calendarFailure(empty, {
      kind: 'schema_drift',
      detail: 'no table on the page contains a /release?rid= link',
      path: '/',
    });
  }

  const problems: NormaliseProblem[] = [];
  const releases = new Map<string, EconReleaseRow>();
  const events: EconReleaseEventRow[] = [];
  let date: string | null = null;
  let groupTime: string | null = null;
  let parsedCount = 0;

  table.rows.forEach((row, index) => {
    if (row.cells.length === 0) return;
    if (row.cells.every((cell) => cell.tag === 'th')) return;

    const link = releaseLinkOf(row);
    if (link === null) {
      // Not a release row: either a date heading or a spacer.
      const heading = parseCalendarHeading(row.cells.map((cell) => cell.text).join(' '));
      if (heading !== null) {
        date = heading;
        groupTime = null;
      }
      return;
    }

    parsedCount += 1;
    if (date === null) {
      problems.push({
        kind: 'schema_drift',
        detail: `release rid=${link.rid} appears before any date heading`,
        path: `/table/${String(index)}`,
      });
      return;
    }

    const cellTime = row.cells.length > 1 ? (row.cells[0]?.text ?? '') : '';
    const printed = normaliseSpace(cellTime);
    if (printed !== '') groupTime = parseCalendarTime(printed);
    const timeKnown = groupTime !== null;
    const scheduledAt = easternInstant(date, groupTime ?? DEFAULT_RELEASE_TIME_ET);
    if (scheduledAt === null) {
      problems.push({
        kind: 'parse_error',
        detail: `could not build an instant from ${date} ${groupTime ?? DEFAULT_RELEASE_TIME_ET} ET`,
        path: `/table/${String(index)}`,
      });
      return;
    }

    const name =
      link.name === '' ? stripTags(row.cells[row.cells.length - 1]?.html ?? '') : link.name;
    if (!releases.has(link.rid)) {
      releases.set(link.rid, {
        sourceId: 'fred.calendar',
        providerReleaseId: link.rid,
        name,
        country: 'US',
        url: `https://fred.stlouisfed.org/release?rid=${link.rid}`,
        importance: 2,
      });
    }
    events.push({
      providerReleaseId: link.rid,
      scheduledAt,
      timeKnown,
      periodLabel: '',
      status: 'scheduled',
      consensus: null,
      consensusUnavailableReason: NO_CONSENSUS_REASON,
    });
  });

  // The whole defence against silent HTML drift — and it fails closed.
  if (advertisedCount === null) {
    return calendarFailure(
      { ...empty, parsedCount },
      {
        kind: 'parse_error',
        detail:
          'the page carries no <meta name="description" content="N economic release dates."> — the row count cannot be verified, so nothing is written',
        path: '/head/meta',
      },
    );
  }
  if (advertisedCount !== parsedCount) {
    return calendarFailure(
      { ...empty, parsedCount },
      {
        kind: 'parse_error',
        detail: `the page advertises ${String(advertisedCount)} economic release dates and ${String(parsedCount)} were parsed; the previous calendar stands`,
        path: '/table',
      },
    );
  }

  void ctx;
  return {
    updates: [],
    rows: {
      advertisedCount,
      parsedCount,
      releases: [...releases.values()],
      events,
    },
    sourceTs: null,
    problems,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §10.2 — the release catalogue (`/releases`)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const PAGER_RE = /releases?\s+([\d,]+)\s*-\s*([\d,]+)\s+of\s+([\d,]+)/i;

function intOf(text: string | undefined): number | null {
  if (text === undefined) return null;
  const value = Number(text.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/** `'Releases 1 - 50 of 332'` → the three numbers, or nulls. */
export function parsePager(source: string): {
  first: number | null;
  last: number | null;
  total: number | null;
} {
  const match = PAGER_RE.exec(stripTags(source));
  if (match === null) return { first: null, last: null, total: null };
  return { first: intOf(match[1]), last: intOf(match[2]), total: intOf(match[3]) };
}

/**
 * `fred-releases.html` → the `econ_releases` catalogue.
 *
 * The catalogue is **paged**: this capture is `Releases 1 - 50 of 332`, so the meta description's
 * `332` is the size of the whole catalogue and not of this page. The invariant that can be checked
 * on one page is the pager's own slice — 50 rows between row 1 and row 50 — and that is what is
 * enforced here, fail-closed like the calendar. The job walks `pageID=2…7` for the rest.
 */
export function parseReleaseCatalogue(
  raw: RawRecord,
  ctx: NormaliseContext,
): Normalised<FredCatalogueRows> {
  const source = raw.body.toString('utf8');
  const pager = parsePager(source);
  const rows: FredCatalogueRows = {
    advertisedTotal: pager.total,
    pageFirst: pager.first,
    pageLast: pager.last,
    releases: [],
  };

  const seen = new Map<string, EconReleaseRow>();
  for (const link of anchors(source)) {
    const rid = ridOf(link.href);
    if (rid === null) continue;
    const name = link.text.trim();
    if (name === '') continue;
    if (!seen.has(rid)) {
      seen.set(rid, {
        sourceId: 'fred.calendar',
        providerReleaseId: rid,
        name,
        country: 'US',
        url: `https://fred.stlouisfed.org/release?rid=${rid}`,
        importance: 2,
      });
    }
  }
  const releases = [...seen.values()];

  // Fail closed, exactly like the calendar's advertised-count check. Without this, a layout change
  // that took the pager and the release links with it would return zero releases and zero
  // problems, which reads downstream as "FRED publishes no releases": no `dq_events
  // kind='parse_error'`, and an empty catalogue served as real data (QA-05).
  if (pager.first === null || pager.last === null) {
    return {
      updates: [],
      rows,
      sourceTs: null,
      problems: [
        {
          kind: 'parse_error',
          detail:
            "the catalogue page carries no 'Releases n - m of N' pager — the page's own slice " +
            'cannot be verified, so nothing is written',
          path: '/',
        },
      ],
    };
  }

  {
    const expected = pager.last - pager.first + 1;
    if (expected !== releases.length) {
      return {
        updates: [],
        rows,
        sourceTs: null,
        problems: [
          {
            kind: 'parse_error',
            detail: `the pager says releases ${String(pager.first)}–${String(pager.last)} (${String(expected)} rows) and ${String(releases.length)} were parsed; nothing is written`,
            path: '/table',
          },
        ],
      };
    }
  }

  void ctx;
  return { updates: [], rows: { ...rows, releases }, sourceTs: null, problems: [] };
}
