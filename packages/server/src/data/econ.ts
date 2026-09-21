/**
 * `data/econ.ts` — economic series, their vintaged observations, the release calendar and the
 * FOMC meeting list (WORKPLAN WP-04 L718, DATA_MODEL §9, FUNCTIONS §1.4.2 L301).
 *
 * Consumed by DES (`econ` variant), GP/GIP (econ series charts), ECO (the calendar), WIRP and
 * FED (`fomc()`), and by CRVF's history mode — FUNCTIONS_TIER1 L266/L454/L720, FUNCTIONS_TIER3
 * L606/L1653/L1815.
 *
 * ## Vintages: the same STOR-06 discipline as fundamentals
 *
 * `econ_observations` never overwrites. A revision of August CPI is a *new row* for the same
 * `obs_date` with a later `vintage_at`, and `is_latest` marks the current one for the fast path.
 * `is_latest` is therefore exactly the wrong thing to read when the question is historical: it
 * answers "what do we say now", not "what did the release say then". So
 * {@link EconService.observations} takes a **required** `knownAt` and selects, per `obs_date`,
 * the newest vintage with `vintage_at <= knownAt` — the same rule, on the same grounds, as
 * `data/fundamentals.ts`: a screen re-run at an old `asOf` must show the number that was on the
 * wire that day, or it is not a re-run.
 *
 * `vintage_at` is a `timestamptz` (a poll instant, unlike the SEC's filing *day*), so the
 * comparison is against the instant itself and needs no day rounding.
 *
 * A `status = 'missing'` observation (`'.'`, `'-'`, `'ND'` in the source) is returned with
 * `value: null`. It is a published gap, not an absence of data, and it is never carried forward
 * or interpolated here (FUNCTIONS §1.3 rule 6) — the chart draws a break and the legend says why.
 *
 * Every row carries its `provenance_id` so the runner can build `PayloadMeta.provenance[]`.
 */

import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import type { SQL } from 'drizzle-orm';

import type { Tx } from '../db/client.js';
import {
  econObservations,
  econReleaseEvents,
  econReleases,
  econSeries,
  fomcMeetings,
} from '../db/schema/econ.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Raised instead of silently widening a read. */
export class EconError extends Error {
  constructor(
    readonly code: 'bad_known_at' | 'bad_range' | 'bad_numeric',
    message: string,
  ) {
    super(message);
    this.name = 'EconError';
  }
}

/** `econ_series` joined to its release (DATA_MODEL §9). */
export interface EconSeries {
  seriesId: number;
  /** The code the command line and `e:<seriesCode>` subjects use: `'DGS10'`, `'CPIAUCSL'`. */
  seriesCode: string;
  sourceId: string;
  providerCode: string;
  name: string;
  units: string;
  frequency: 'D' | 'W' | 'M' | 'Q' | 'A';
  seasonalAdj: string | null;
  country: string;
  /** The `asset_class='econ'` instrument, when one was minted for the command line. */
  instrumentId: number | null;
  decimals: number;
  firstObsDate: string | null;
  lastObsDate: string | null;
  lastUpdatedAt: string | null;
  release: EconRelease | null;
}

/** `econ_releases` — what the ECO calendar groups events under. */
export interface EconRelease {
  releaseId: number;
  sourceId: string;
  providerReleaseId: string;
  name: string;
  country: string;
  url: string | null;
  /** 1 = market moving, 3 = minor. */
  importance: number;
}

/** One vintaged observation. */
export interface EconObs {
  seriesId: number;
  /** Period start: the first of the month for a monthly series, the day for a daily one. */
  obsDate: string;
  /** `null` when `status === 'missing'` — a published gap, never interpolated. */
  value: number | null;
  status: 'final' | 'preliminary' | 'revised' | 'missing';
  footnote: string | null;
  /** When this value was first seen. The point-in-time key. */
  vintageAt: string;
  /** Whether this is also the *current* vintage; false on a value superseded since `knownAt`. */
  isLatest: boolean;
  provenanceId: number;
}

/** One ECO calendar entry. */
export interface EconEvent {
  eventId: number;
  releaseId: number;
  releaseName: string;
  country: string;
  importance: number;
  url: string | null;
  scheduledAt: string;
  /** False when only the day is published (a FRED calendar date, pinned to 08:30 ET). */
  timeKnown: boolean;
  periodLabel: string;
  seriesId: number | null;
  seriesCode: string | null;
  actual: number | null;
  prior: number | null;
  revisedPrior: number | null;
  /** Always `null` in v1 — there is no licensed consensus source (BRIEF §2). */
  consensus: number | null;
  consensusUnavailableReason: string;
  status: 'scheduled' | 'released' | 'revised' | 'delayed' | 'cancelled';
  provenanceId: number;
}

/** FUNCTIONS_TIER3 §0.1 — the WIRP / FED policy-path node. */
export interface FomcMeeting {
  meetingDate: string;
  statementAt: string | null;
  hasSep: boolean;
  decisionBp: number | null;
  provenanceId: number | null;
}

/** {@link EconService.observations} query. `knownAt` is required (see the header). */
export interface EconObsQuery {
  /** Inclusive ISO day bounds on `obs_date`. */
  from?: string;
  to?: string;
  knownAt: Date;
  /** Keep only the last `limit` observations of the range; the result stays date-ascending. */
  limit?: number;
}

/** {@link EconService.calendar} query — API.md `GET /econ/calendar`. */
export interface EconCalendarQuery {
  /** ISO day or full ISO instant. A day means 00:00:00Z on that day. */
  from: string;
  /** ISO day or full ISO instant. A **day is inclusive**: it covers up to 23:59:59.999Z. */
  to: string;
  country: 'US' | 'ALL';
  /** Keep only events at least this important (1 = most). */
  minImportance?: number;
  limit?: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function instant(knownAt: Date, label: string): string {
  const t = knownAt.getTime();
  if (!Number.isFinite(t)) {
    throw new EconError('bad_known_at', `${label} must be a valid Date`);
  }
  return new Date(t).toISOString();
}

function num(value: string | null, column: string): number | null {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new EconError('bad_numeric', `${column} = ${JSON.stringify(value)} is not finite`);
  }
  return n;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A day bound becomes the start (`end: false`) or the very end (`end: true`) of that UTC day. */
function boundary(value: string, end: boolean, label: string): Date {
  const text = ISO_DAY.test(value) ? `${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z` : value;
  const d = new Date(text);
  if (!Number.isFinite(d.getTime())) {
    throw new EconError(
      'bad_range',
      `${label} = ${JSON.stringify(value)} is not an ISO day or instant`,
    );
  }
  return d;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : value.toISOString();
}

function obsStatus(value: string): EconObs['status'] {
  if (value === 'final' || value === 'preliminary' || value === 'revised' || value === 'missing') {
    return value;
  }
  throw new EconError(
    'bad_numeric',
    `econ_observations.status = ${JSON.stringify(value)} is outside the CHECK`,
  );
}

function eventStatus(value: string): EconEvent['status'] {
  if (
    value === 'scheduled' ||
    value === 'released' ||
    value === 'revised' ||
    value === 'delayed' ||
    value === 'cancelled'
  ) {
    return value;
  }
  throw new EconError(
    'bad_numeric',
    `econ_release_events.status = ${JSON.stringify(value)} is outside the CHECK`,
  );
}

function frequency(value: string): EconSeries['frequency'] {
  if (value === 'D' || value === 'W' || value === 'M' || value === 'Q' || value === 'A') {
    return value;
  }
  throw new EconError(
    'bad_numeric',
    `econ_series.frequency = ${JSON.stringify(value)} is outside the CHECK`,
  );
}

function toRelease(r: typeof econReleases.$inferSelect | null): EconRelease | null {
  if (r === null) return null;
  return {
    releaseId: Number(r.releaseId),
    sourceId: r.sourceId,
    providerReleaseId: r.providerReleaseId,
    name: r.name,
    country: r.country,
    url: r.url,
    importance: r.importance,
  };
}

function toSeries(
  s: typeof econSeries.$inferSelect,
  r: typeof econReleases.$inferSelect | null,
): EconSeries {
  return {
    seriesId: Number(s.seriesId),
    seriesCode: s.seriesCode,
    sourceId: s.sourceId,
    providerCode: s.providerCode,
    name: s.name,
    units: s.units,
    frequency: frequency(s.frequency),
    seasonalAdj: s.seasonalAdj,
    country: s.country,
    instrumentId: s.instrumentId === null ? null : Number(s.instrumentId),
    decimals: s.decimals,
    firstObsDate: s.firstObsDate,
    lastObsDate: s.lastObsDate,
    lastUpdatedAt: iso(s.lastUpdatedAt),
    release: toRelease(r),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One instance per transaction, like every repository in this package. */
export class EconService {
  constructor(private readonly tx: Tx) {}

  /**
   * FUNCTIONS §1.4.2 `series(code)` — the series definition and its release.
   *
   * `null` when the code is unknown, which is a fact the caller turns into
   * `SECURITY_NOT_FOUND` / `NO_SOURCE`; it is not an exception, because "is this a series?" is a
   * question DES asks before it knows the answer.
   */
  async series(code: string): Promise<EconSeries | null> {
    const rows = await this.tx
      .select({ series: econSeries, release: econReleases })
      .from(econSeries)
      .leftJoin(econReleases, eq(econSeries.releaseId, econReleases.releaseId))
      .where(eq(econSeries.seriesCode, code))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toSeries(row.series, row.release);
  }

  /** The same, keyed on the `asset_class='econ'` instrument a command line resolved. */
  async seriesForInstrument(instrumentId: number): Promise<EconSeries | null> {
    const rows = await this.tx
      .select({ series: econSeries, release: econReleases })
      .from(econSeries)
      .leftJoin(econReleases, eq(econSeries.releaseId, econReleases.releaseId))
      .where(eq(econSeries.instrumentId, instrumentId))
      .orderBy(asc(econSeries.seriesId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toSeries(row.series, row.release);
  }

  /** Several series in one round trip — GP overlays and CRVF's tenor map. */
  async seriesByCodes(codes: readonly string[]): Promise<Map<string, EconSeries>> {
    if (codes.length === 0) return new Map();
    const rows = await this.tx
      .select({ series: econSeries, release: econReleases })
      .from(econSeries)
      .leftJoin(econReleases, eq(econSeries.releaseId, econReleases.releaseId))
      .where(inArray(econSeries.seriesCode, [...codes]));
    return new Map(rows.map((r) => [r.series.seriesCode, toSeries(r.series, r.release)]));
  }

  /**
   * FUNCTIONS §1.4.2 `observations(code, { from, to, knownAt })` — one row per `obs_date`, the
   * newest vintage published on or before `knownAt`, oldest date first.
   *
   * An unknown series code yields `[]`: {@link series} is the call that distinguishes "no such
   * series" from "no observations in this window".
   */
  async observations(code: string, q: EconObsQuery): Promise<EconObs[]> {
    const series = await this.tx
      .select({ seriesId: econSeries.seriesId })
      .from(econSeries)
      .where(eq(econSeries.seriesCode, code))
      .limit(1);
    const row = series[0];
    if (row === undefined) return [];
    return this.observationsBySeriesId(Number(row.seriesId), q);
  }

  /** {@link observations} for a series whose id the caller already holds. */
  async observationsBySeriesId(seriesId: number, q: EconObsQuery): Promise<EconObs[]> {
    const knownAt = instant(q.knownAt, 'knownAt');
    const filters: (SQL | undefined)[] = [
      eq(econObservations.seriesId, seriesId),
      lte(econObservations.vintageAt, sql`${knownAt}::timestamptz`),
    ];
    if (q.from !== undefined) filters.push(gte(econObservations.obsDate, q.from));
    if (q.to !== undefined) filters.push(lte(econObservations.obsDate, q.to));

    // `limit` means "the last n of the range", so when it is set the newest dates are taken
    // first and the page is reversed below — never the first n, which would be the 1950s.
    const newestFirst = q.limit !== undefined;
    const query = this.tx
      .selectDistinctOn([econObservations.obsDate])
      .from(econObservations)
      .where(and(...filters))
      .orderBy(
        newestFirst ? desc(econObservations.obsDate) : asc(econObservations.obsDate),
        desc(econObservations.vintageAt),
      );
    const rows = await (q.limit === undefined ? query : query.limit(Math.max(0, q.limit)));

    const obs = rows.map((r): EconObs => ({
      seriesId: Number(r.seriesId),
      obsDate: r.obsDate,
      value: num(r.value, 'econ_observations.value'),
      status: obsStatus(r.status),
      vintageAt: iso(r.vintageAt) ?? '',
      footnote: r.footnote,
      isLatest: r.isLatest,
      provenanceId: Number(r.provenanceId),
    }));
    return newestFirst ? obs.reverse() : obs;
  }

  /**
   * FUNCTIONS §1.4.2 `calendar({ from, to, country })` — the ECO grid, earliest first.
   *
   * `country: 'US'` filters on the *release's* country, which is where the attribute lives;
   * `'ALL'` keeps every country.
   */
  async calendar(q: EconCalendarQuery): Promise<EconEvent[]> {
    const from = boundary(q.from, false, 'from');
    const to = boundary(q.to, true, 'to');
    if (to.getTime() < from.getTime()) {
      throw new EconError(
        'bad_range',
        `calendar window ends (${q.to}) before it starts (${q.from})`,
      );
    }
    const filters: (SQL | undefined)[] = [
      gte(econReleaseEvents.scheduledAt, sql`${from.toISOString()}::timestamptz`),
      lte(econReleaseEvents.scheduledAt, sql`${to.toISOString()}::timestamptz`),
    ];
    if (q.country !== 'ALL') filters.push(eq(econReleases.country, q.country));
    if (q.minImportance !== undefined) {
      filters.push(lte(econReleases.importance, q.minImportance));
    }

    const query = this.tx
      .select({
        event: econReleaseEvents,
        release: econReleases,
        seriesCode: econSeries.seriesCode,
      })
      .from(econReleaseEvents)
      .innerJoin(econReleases, eq(econReleaseEvents.releaseId, econReleases.releaseId))
      .leftJoin(econSeries, eq(econReleaseEvents.seriesId, econSeries.seriesId))
      .where(and(...filters))
      .orderBy(asc(econReleaseEvents.scheduledAt), asc(econReleaseEvents.eventId));
    const rows = await (q.limit === undefined ? query : query.limit(Math.max(0, q.limit)));

    return rows.map((r) => toEvent(r.event, r.release, r.seriesCode));
  }

  /**
   * The next scheduled entry of one release after `after` — DES's `nextRelease` cell
   * (FUNCTIONS_TIER1 L266). `null` when the release has no calendar entry ahead, which DES
   * reports as `NO_SOURCE` rather than as an empty date.
   */
  async nextRelease(releaseId: number, after: Date): Promise<EconEvent | null> {
    const rows = await this.tx
      .select({
        event: econReleaseEvents,
        release: econReleases,
        seriesCode: econSeries.seriesCode,
      })
      .from(econReleaseEvents)
      .innerJoin(econReleases, eq(econReleaseEvents.releaseId, econReleases.releaseId))
      .leftJoin(econSeries, eq(econReleaseEvents.seriesId, econSeries.seriesId))
      .where(
        and(
          eq(econReleaseEvents.releaseId, releaseId),
          sql`${econReleaseEvents.scheduledAt} > ${instant(after, 'after')}::timestamptz`,
        ),
      )
      .orderBy(asc(econReleaseEvents.scheduledAt), asc(econReleaseEvents.eventId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toEvent(row.event, row.release, row.seriesCode);
  }

  /**
   * FUNCTIONS §1.4.2 `fomc()` — every stored meeting, earliest first. WIRP and FED split the
   * list themselves on the valuation date (`decisionBp` filled = past, `null` = scheduled), so
   * this read deliberately does not.
   */
  async fomc(q: { from?: string; to?: string } = {}): Promise<FomcMeeting[]> {
    const filters: (SQL | undefined)[] = [];
    if (q.from !== undefined) filters.push(gte(fomcMeetings.meetingDate, q.from));
    if (q.to !== undefined) filters.push(lte(fomcMeetings.meetingDate, q.to));
    const rows = await this.tx
      .select()
      .from(fomcMeetings)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(asc(fomcMeetings.meetingDate));
    return rows.map((r): FomcMeeting => ({
      meetingDate: r.meetingDate,
      statementAt: iso(r.statementAt),
      hasSep: r.hasSep,
      decisionBp: r.decisionBp,
      provenanceId: r.provenanceId === null ? null : Number(r.provenanceId),
    }));
  }
}

function toEvent(
  e: typeof econReleaseEvents.$inferSelect,
  r: typeof econReleases.$inferSelect,
  seriesCode: string | null,
): EconEvent {
  return {
    eventId: Number(e.eventId),
    releaseId: Number(e.releaseId),
    releaseName: r.name,
    country: r.country,
    importance: r.importance,
    url: r.url,
    scheduledAt: iso(e.scheduledAt) ?? '',
    timeKnown: e.timeKnown,
    periodLabel: e.periodLabel,
    seriesId: e.seriesId === null ? null : Number(e.seriesId),
    seriesCode,
    actual: num(e.actual, 'econ_release_events.actual'),
    prior: num(e.prior, 'econ_release_events.prior'),
    revisedPrior: num(e.revisedPrior, 'econ_release_events.revised_prior'),
    consensus: num(e.consensus, 'econ_release_events.consensus'),
    consensusUnavailableReason: e.consensusUnavailableReason,
    status: eventStatus(e.status),
    provenanceId: Number(e.provenanceId),
  };
}
