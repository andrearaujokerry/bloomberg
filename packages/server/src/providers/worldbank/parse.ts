/**
 * `worldbank` — the pure half. PROVIDERS.b §10.7, WORKPLAN WP-05.
 *
 * The World Bank indicator API answers with a **two-element array**: `[meta, data[]]`. Everything
 * awkward about this source follows from that one shape:
 *
 *  - an **error** is returned as a one-element array `[{message: [...]}]` with HTTP `200`, so a
 *    parser that reached for `doc[1]` would read `undefined` and report "no observations" for what
 *    is really a failed request. {@link parseWorldBank} refuses any payload that is not a 2-tuple
 *    whose `[1]` is an array, and {@link worldBankPayloadOk} is what the job asks before it decides
 *    to raise `ProviderHttpError(200)` — raising is not this file's job (§1.2: never throw);
 *  - `meta.pages` must be walked ascending with `&page=n`, so the meta block is returned as rows
 *    rather than discarded: the caller cannot page without it;
 *  - `lastupdated` is the series vintage → `provenance.source_ts` and `econ_series.last_updated_at`.
 *
 * Observations are annual and are stamped at the **period start** (`"2025"` → `2025-01-01`), and
 * they come back ascending by date; the payload publishes them newest-first.
 */

import type { NormalisedUpdate } from '@terminal/core';

import type { NormaliseContext, NormaliseProblem, Normalised, RawRecord } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The `[0]` block: the paging control plus the vintage. */
export interface WorldBankMeta {
  page: number;
  pages: number;
  perPage: number;
  total: number;
  /** The World Bank's own source id (`"2"` = World Development Indicators), as published. */
  sourceId: string | null;
  /** `'2026-07-13'`, or `null`. */
  lastUpdated: string | null;
}

/** What the payload publishes about the series itself → `econ_series`. */
export interface WorldBankSeriesRow {
  /** `econ_series.provider_code` — `'NY.GDP.MKTP.CD'`. */
  providerCode: string;
  name: string;
  /** ISO-2 (`econ_series.country`). */
  country: string;
  countryName: string;
  countryIso3: string | null;
  /** `null` when the payload publishes an empty string, which is the usual case. */
  units: string | null;
  decimals: number | null;
  /** `meta.lastupdated` as an instant, midnight UTC. */
  lastUpdatedAt: string | null;
}

/** One `econ_observations` row. */
export interface WorldBankObservationRow {
  providerCode: string;
  country: string;
  /** Annual series are stamped at the period start: `'2025'` → `'2025-01-01'`. */
  obsDate: string;
  value: number | null;
  /** `'missing'` for a null value; otherwise `obs_status` when it is non-empty, else `'final'`. */
  status: string;
}

export interface WorldBankRows {
  /** `null` when the payload was not a `[meta, data]` tuple — see {@link worldBankPayloadOk}. */
  meta: WorldBankMeta | null;
  series: WorldBankSeriesRow[];
  observations: WorldBankObservationRow[];
}

/** `false` when the response was the HTTP-200 error shape; the caller raises (§10.7). */
export function worldBankPayloadOk(rows: WorldBankRows): boolean {
  return rows.meta !== null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

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

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** `'2026-07-13'` → `'2026-07-13T00:00:00Z'`; anything else → `null`. */
export function worldBankInstant(day: string | null): string | null {
  if (day === null || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(ms) ? null : `${day}T00:00:00Z`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Parse
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The `[meta, data]` payload → rows. Never throws. */
export function parseWorldBank(body: Buffer | string): {
  rows: WorldBankRows;
  problems: NormaliseProblem[];
} {
  const empty: WorldBankRows = { meta: null, series: [], observations: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(textOf(body));
  } catch (err) {
    return { rows: empty, problems: [{ kind: 'parse_error', detail: messageOf(err) }] };
  }
  if (!Array.isArray(doc) || doc.length !== 2 || !Array.isArray(doc[1])) {
    // The one-element `[{message: [...]}]` error shape lands here, and so does anything else.
    let detail = 'worldbank payload is not a [meta, data] pair';
    const first: unknown = Array.isArray(doc) ? doc[0] : undefined;
    if (isRecord(first) && Array.isArray(first.message)) {
      const texts = first.message
        .map((entry: unknown) => (isRecord(entry) ? stringOrNull(entry.value) : null))
        .filter((value): value is string => value !== null);
      detail = `worldbank returned an error with HTTP 200: ${texts.join('; ')}`;
    }
    return { rows: empty, problems: [{ kind: 'schema_drift', detail }] };
  }

  const problems: NormaliseProblem[] = [];
  const metaRaw: unknown = doc[0];
  const meta: WorldBankMeta = {
    page: (isRecord(metaRaw) ? numberOrNull(metaRaw.page) : null) ?? 0,
    pages: (isRecord(metaRaw) ? numberOrNull(metaRaw.pages) : null) ?? 0,
    perPage: (isRecord(metaRaw) ? numberOrNull(metaRaw.per_page) : null) ?? 0,
    total: (isRecord(metaRaw) ? numberOrNull(metaRaw.total) : null) ?? 0,
    sourceId: isRecord(metaRaw) ? stringOrNull(metaRaw.sourceid) : null,
    lastUpdated: isRecord(metaRaw) ? stringOrNull(metaRaw.lastupdated) : null,
  };
  if (!isRecord(metaRaw)) {
    problems.push({
      kind: 'schema_drift',
      detail: 'worldbank meta block is not an object',
      path: '/0',
    });
  }
  const lastUpdatedAt = worldBankInstant(meta.lastUpdated);

  const seriesIndex = new Map<string, WorldBankSeriesRow>();
  const observations: WorldBankObservationRow[] = [];

  (doc[1] as unknown[]).forEach((entry: unknown, index: number) => {
    const path = `/1/${String(index)}`;
    if (!isRecord(entry)) {
      problems.push({
        kind: 'schema_drift',
        detail: 'worldbank observation is not an object',
        path,
      });
      return;
    }
    const indicator = entry.indicator;
    const country = entry.country;
    const providerCode = isRecord(indicator) ? stringOrNull(indicator.id) : null;
    const indicatorName = isRecord(indicator) ? stringOrNull(indicator.value) : null;
    const countryCode = isRecord(country) ? stringOrNull(country.id) : null;
    const countryName = isRecord(country) ? stringOrNull(country.value) : null;
    if (providerCode === null || countryCode === null) {
      problems.push({
        kind: 'schema_drift',
        detail: 'worldbank observation carries no indicator.id / country.id',
        path,
      });
      return;
    }

    const date = stringOrNull(entry.date);
    if (date === null || !/^\d{4}$/.test(date)) {
      problems.push({
        kind: 'field_dropped',
        detail: `worldbank date '${date ?? ''}' is not an annual period`,
        path: `${path}/date`,
      });
      return;
    }

    const value = numberOrNull(entry.value);
    const obsStatus = stringOrNull(entry.obs_status);
    const status = value === null ? 'missing' : (obsStatus ?? 'final');
    observations.push({
      providerCode,
      country: countryCode,
      obsDate: `${date}-01-01`,
      value,
      status,
    });

    const key = `${providerCode}|${countryCode}`;
    if (!seriesIndex.has(key)) {
      seriesIndex.set(key, {
        providerCode,
        name: indicatorName ?? providerCode,
        country: countryCode,
        countryName: countryName ?? countryCode,
        countryIso3: stringOrNull(entry.countryiso3code),
        units: stringOrNull(entry.unit),
        decimals: numberOrNull(entry.decimal),
        lastUpdatedAt,
      });
    }
  });

  observations.sort(
    (a, b) =>
      cmp(a.providerCode, b.providerCode) ||
      cmp(a.country, b.country) ||
      (a.obsDate < b.obsDate ? -1 : a.obsDate > b.obsDate ? 1 : 0),
  );

  const series = [...seriesIndex.values()].sort(
    (a, b) => cmp(a.providerCode, b.providerCode) || cmp(a.country, b.country),
  );

  return { rows: { meta, series, observations }, problems };
}

/**
 * `worldbank` → rows plus one plant update per series with an `md_lines` row (§10.7: subject
 * `e:<indicatorId>`, `PX_LAST` = the newest non-null annual value).
 *
 * `sourceTs` is `meta.lastupdated`, which is the series' publication vintage — not the fetch
 * instant, and not the last observation's year.
 */
export function normaliseWorldBank(
  raw: RawRecord,
  ctx: NormaliseContext,
): Normalised<WorldBankRows> {
  const { rows, problems } = parseWorldBank(raw.body);
  const lastUpdatedAt =
    rows.series[0]?.lastUpdatedAt ?? worldBankInstant(rows.meta?.lastUpdated ?? null);
  const sourceTs = lastUpdatedAt === null ? raw.sourceTs : new Date(lastUpdatedAt);

  const updates: NormalisedUpdate[] = [];
  for (const entry of rows.series) {
    const line = ctx.lines.get(entry.providerCode);
    if (line === undefined) continue;
    let newestDate: string | null = null;
    let newestValue: number | null = null;
    for (const observation of rows.observations) {
      if (observation.providerCode !== entry.providerCode) continue;
      if (observation.country !== entry.country) continue;
      if (observation.value === null) continue;
      if (newestDate === null || observation.obsDate > newestDate) {
        newestDate = observation.obsDate;
        newestValue = observation.value;
      }
    }
    if (newestValue === null) continue;
    updates.push({
      subject: `e:${entry.providerCode}`,
      instrumentId: line.instrumentId,
      mdLineId: line.mdLineId,
      assetClass: line.assetClass,
      tier: line.tier,
      fields: { PX_LAST: newestValue },
      ts: {
        src: sourceTs === null ? null : sourceTs.getTime(),
        cap: ctx.capturedAt,
        pub: ctx.capturedAt,
      },
      prov: { sourceId: 'worldbank', provenanceId: ctx.provenanceId },
    });
  }

  return { updates, rows, sourceTs, problems };
}
