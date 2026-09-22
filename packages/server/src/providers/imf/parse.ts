/**
 * `imf.datamapper` — the pure half. PROVIDERS.b §10.8, WORKPLAN WP-05.
 *
 * Two endpoints, two payload shapes, one parser that dispatches on which key is present:
 *
 *  - the **catalogue** (`/api/v1/indicators`) is `{indicators: {<ID>: {label, description, source,
 *    unit, dataset, "last-modified"}}}` → `econ_series`;
 *  - the **observations** (`/api/v1/{ID}/{ISO3}`) are `{values: {<ID>: {<ISO3>: {"2025": 2.1}}}}`
 *    → `econ_observations`.
 *
 * Three rules from §10.8 are load-bearing and each is a place a shortcut would fail silently:
 *
 *  1. **`last-modified` is hyphenated.** A dotted-path reader (`indicator.last-modified`) parses as
 *    a subtraction and yields `undefined` without complaining, which is why the key is read with
 *    bracket access and the timestamp is a naive instant read as UTC.
 *  2. **Years are sorted ascending before emission.** JSON object key order is insertion order,
 *    and the IMF does not promise one; a golden pinned to the payload's order would churn.
 *  3. **Forecasts are not actuals.** WEO publishes five years past the current one, and every
 *    observation for a year after the capture's own year is stored with `status 'preliminary'`.
 *    The "current year" is taken from `RawRecord.capturedAt` — the only clock a normaliser sees
 *    (§1.2) — so the classification is reproducible in 2030 from the 2026 capture.
 *
 * **Fixture gap (§10.8, carried into WP-05's notes):** the 48 recorded captures contain the
 * indicator catalogue (`imf-weo.json`) but **no observation capture**, so {@link parseImfValues}
 * has no golden and is covered by unit assertions only until
 * `imf-datamapper-NGDP_RPCH-USA.json` is recorded.
 */

import type { NormalisedUpdate } from '@terminal/core';

import type { NormaliseContext, NormaliseProblem, Normalised, RawRecord } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One catalogue entry → `econ_series`. `description` is not carried: there is no column for it. */
export interface ImfIndicatorRow {
  /** `econ_series.provider_code` — `'NGDP_RPCH'`. */
  providerCode: string;
  /** `label`, whitespace-collapsed: several labels are published with an embedded newline. */
  name: string;
  units: string | null;
  /** `'WEO'`, `'FM'`, `'DEBT'` — the IMF dataset the indicator belongs to. */
  dataset: string | null;
  /** `'World Economic Outlook (April 2026)'` — the vintage label shown on the screen. */
  source: string | null;
  /** `"last-modified"` read as a UTC instant, `null` when absent or unparseable. */
  lastUpdatedAt: string | null;
}

/** One observation of the values endpoint → `econ_observations`. */
export interface ImfObservationRow {
  providerCode: string;
  /** ISO-3 as the IMF publishes it (`'USA'`), or an aggregate code (`'WEOWORLD'`). */
  area: string;
  /** Annual: the period start, `'2025-01-01'`. */
  obsDate: string;
  value: number | null;
  /** `'preliminary'` for any year after the capture's own — WEO forecasts are not actuals. */
  status: 'final' | 'preliminary' | 'missing';
}

export interface ImfRows {
  /** Which endpoint the payload came from; `'unknown'` when it is neither. */
  kind: 'catalogue' | 'values' | 'unknown';
  indicators: ImfIndicatorRow[];
  observations: ImfObservationRow[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(body: Buffer | string): string {
  return typeof body === 'string' ? body : body.toString('utf8');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = collapse(value);
  return trimmed === '' ? null : trimmed;
}

/**
 * `'2026-04-08 16:07:34'` → `'2026-04-08T16:07:34Z'`. A naive timestamp with no zone, read as UTC
 * because that is what the IMF publishes it in; anything that is not that shape → `null`.
 */
export function imfInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value.trim());
  if (match === null) return null;
  const iso = `${match[1] ?? ''}T${match[2] ?? ''}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The catalogue
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `/api/v1/indicators` → `econ_series` rows, sorted by indicator id. Never throws. */
export function parseImfIndicators(body: Buffer | string): {
  indicators: ImfIndicatorRow[];
  problems: NormaliseProblem[];
} {
  let doc: unknown;
  try {
    doc = JSON.parse(textOf(body));
  } catch (err) {
    return { indicators: [], problems: [{ kind: 'parse_error', detail: messageOf(err) }] };
  }
  if (!isRecord(doc) || !isRecord(doc.indicators)) {
    return {
      indicators: [],
      problems: [
        {
          kind: 'schema_drift',
          detail: 'imf catalogue carries no indicators object',
          path: '/indicators',
        },
      ],
    };
  }

  const problems: NormaliseProblem[] = [];
  const indicators: ImfIndicatorRow[] = [];
  for (const providerCode of Object.keys(doc.indicators).sort()) {
    const entry: unknown = doc.indicators[providerCode];
    if (!isRecord(entry)) {
      problems.push({
        kind: 'schema_drift',
        detail: `imf indicator ${providerCode} is not an object`,
        path: `/indicators/${providerCode}`,
      });
      continue;
    }
    const name = stringOrNull(entry.label);
    if (name === null) {
      problems.push({
        kind: 'field_dropped',
        detail: `imf indicator ${providerCode} publishes no label`,
        path: `/indicators/${providerCode}/label`,
      });
    }
    indicators.push({
      providerCode,
      name: name ?? providerCode,
      units: stringOrNull(entry.unit),
      dataset: stringOrNull(entry.dataset),
      source: stringOrNull(entry.source),
      // Bracket access, deliberately: `entry.last-modified` is a subtraction (§10.8).
      lastUpdatedAt: imfInstant(entry['last-modified']),
    });
  }
  return { indicators, problems };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The observations
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `/api/v1/{ID}/{ISO3}` → `econ_observations` rows.
 *
 * @param currentYear the capture's own UTC year; every later year is a WEO forecast and is stored
 *   `preliminary`.
 */
export function parseImfValues(
  body: Buffer | string,
  currentYear: number,
): { observations: ImfObservationRow[]; problems: NormaliseProblem[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(textOf(body));
  } catch (err) {
    return { observations: [], problems: [{ kind: 'parse_error', detail: messageOf(err) }] };
  }
  if (!isRecord(doc) || !isRecord(doc.values)) {
    return {
      observations: [],
      problems: [
        { kind: 'schema_drift', detail: 'imf payload carries no values object', path: '/values' },
      ],
    };
  }

  const problems: NormaliseProblem[] = [];
  const observations: ImfObservationRow[] = [];
  for (const providerCode of Object.keys(doc.values).sort()) {
    const byArea: unknown = doc.values[providerCode];
    if (!isRecord(byArea)) {
      problems.push({
        kind: 'schema_drift',
        detail: `imf values for ${providerCode} is not an object`,
        path: `/values/${providerCode}`,
      });
      continue;
    }
    for (const area of Object.keys(byArea).sort()) {
      const byYear: unknown = byArea[area];
      if (!isRecord(byYear)) {
        problems.push({
          kind: 'schema_drift',
          detail: `imf values for ${providerCode}/${area} is not an object`,
          path: `/values/${providerCode}/${area}`,
        });
        continue;
      }
      for (const year of Object.keys(byYear).sort()) {
        const path = `/values/${providerCode}/${area}/${year}`;
        if (!/^\d{4}$/.test(year)) {
          problems.push({
            kind: 'field_dropped',
            detail: `imf value key '${year}' is not a year`,
            path,
          });
          continue;
        }
        const published: unknown = byYear[year];
        let value: number | null = null;
        if (typeof published === 'number' && Number.isFinite(published)) {
          value = published;
        } else if (typeof published === 'string' && published.trim() !== '') {
          const parsed = Number(published);
          if (Number.isFinite(parsed)) value = parsed;
        }
        if (value === null && published !== null) {
          problems.push({
            kind: 'field_dropped',
            detail: `imf value for ${providerCode}/${area}/${year} is not a number`,
            path,
          });
        }
        observations.push({
          providerCode,
          area,
          obsDate: `${year}-01-01`,
          value,
          status: value === null ? 'missing' : Number(year) > currentYear ? 'preliminary' : 'final',
        });
      }
    }
  }
  return { observations, problems };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// normalise
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `imf.datamapper` → rows, dispatching on the payload's own top-level key.
 *
 * `sourceTs` is the newest `last-modified` in the catalogue — the vintage of the most recently
 * revised indicator, which is the only publication instant this source carries. The observations
 * endpoint publishes none, so it falls back to whatever the transport recorded.
 *
 * No plant update: the catalogue carries no values, and the observations endpoint has no recorded
 * capture to pin one against (§10.8).
 */
export function normaliseImf(raw: RawRecord, ctx: NormaliseContext): Normalised<ImfRows> {
  const text = textOf(raw.body);
  const problems: NormaliseProblem[] = [];

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return {
      updates: [],
      rows: { kind: 'unknown', indicators: [], observations: [] },
      sourceTs: raw.sourceTs,
      problems: [{ kind: 'parse_error', detail: messageOf(err) }],
    };
  }

  if (isRecord(doc) && isRecord(doc.indicators)) {
    const parsed = parseImfIndicators(text);
    problems.push(...parsed.problems);
    let newest: string | null = null;
    for (const indicator of parsed.indicators) {
      if (indicator.lastUpdatedAt === null) continue;
      if (newest === null || indicator.lastUpdatedAt > newest) newest = indicator.lastUpdatedAt;
    }
    return {
      updates: [],
      rows: { kind: 'catalogue', indicators: parsed.indicators, observations: [] },
      sourceTs: newest === null ? raw.sourceTs : new Date(newest),
      problems,
    };
  }

  if (isRecord(doc) && isRecord(doc.values)) {
    const currentYear = new Date(ctx.capturedAt).getUTCFullYear();
    const parsed = parseImfValues(text, currentYear);
    problems.push(...parsed.problems);
    const updates: NormalisedUpdate[] = [];
    return {
      updates,
      rows: { kind: 'values', indicators: [], observations: parsed.observations },
      sourceTs: raw.sourceTs,
      problems,
    };
  }

  return {
    updates: [],
    rows: { kind: 'unknown', indicators: [], observations: [] },
    sourceTs: raw.sourceTs,
    problems: [
      {
        kind: 'schema_drift',
        detail: 'imf payload carries neither an indicators nor a values object',
      },
    ],
  };
}
