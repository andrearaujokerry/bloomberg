/**
 * `ingest/jobs/fredSeries.ts` — FRED CSV → `econ_observations`, **with vintage detection**
 * (PROVIDERS §10.1, §13; WORKPLAN §WP-11 L1300).
 *
 * §13 row `fredSeries`: provider `fred.csv`, `'30 16 * * 1-5'` for the daily series and
 * `'0 9 * * *'` for the monthly ones gated on `econ_release_events`, "the seeded FRED series list,
 * 1 req/s", priority 2, `timeoutMs` 300 000.
 *
 * ## The property this job exists for
 *
 * `fredgraph.csv` is a **current-vintage** series: it returns today's view of the whole history
 * and says nothing about what it said yesterday (ALFRED's vintage API needs a key, BRIEF §2). So a
 * revision is not announced — it is *detected*, by comparing each observation with the row we
 * already hold for that `obs_date`:
 *
 *  - no row for the date → insert one, `vintage_at = captured_at`, `is_latest true`;
 *  - a row with the same value → **nothing at all**, however many times the file is replayed;
 *  - a row with a **different** value → clear `is_latest` on it and insert a *new* row at this
 *    capture's instant with `status 'revised'`.
 *
 * The old row stays exactly where it was. That is the whole point: "what did the market know about
 * August payrolls on 5 September?" is a question `econ_observations` is keyed
 * `(series_id, obs_date, vintage_at)` to answer, and a writer that updated the value in place
 * would answer it with today's number for ever. {@link upsertEconObservations} is that writer, and
 * `fedRates.ts` shares it for the H.15 series.
 *
 * An observation whose vintage is **not newer** than the one stored is dropped rather than
 * written: an out-of-order or cached response must not overwrite a later belief with an earlier
 * one, or the table would depend on delivery order rather than on time.
 *
 * ## What it does not do
 *
 * It publishes nothing to the plant. §10.1 asks for `e:<seriesCode>` carrying
 * `VALUE PERIOD RELEASED_AT PREV REVISED STATUS`, and none of those field ids exists yet:
 * `core/src/fields/defs/econ.ts` is WP-11's own deliverable and lands beside this one. The tables
 * are written here; the subject is published as soon as the field block exists, and an empty
 * `published` counter is the honest report until then.
 *
 * **Replay is a wall.** With no `HttpClient` wired the recorded capture is read; a series the
 * store does not hold throws `ReplayMissError`, which is recorded as a fetch error against that
 * series and never becomes a socket.
 */

import { sql } from 'drizzle-orm';

import { fredCsvAdapter, fredCsvUrl } from '../../providers/fred/adapter.js';
import { FRED_ADAPTER_VERSION, parseFredCsv } from '../../providers/fred/parse.js';
import { insertProvenance } from '../../providers/provenance.js';
import {
  emptyResult,
  fetchError,
  fetchThrough,
  numericIn,
  provenanceMeta,
  requestEnvelope,
  withIngestRun,
} from './cboeQuotes.js';

import type { Tx } from '../../db/client.js';
import type { MarketJobContext, MarketJobResult } from './cboeQuotes.js';
import type { NormaliseContext, NormaliseLine, ProviderId, RawRecord } from '../../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The scheduler row (PROVIDERS §13)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** §13: the daily series, after the 16:00 ET FRED refresh. */
export const FRED_SERIES_SCHEDULE = '30 16 * * 1-5';
/**
 * §13's second cadence: the monthly series at 09:00 ET on their release day, gated on
 * `econ_release_events`. `IngestJob` carries **one** schedule, so the job row below takes the
 * daily one and this is exported for the release-gated caller (`econCalendar.ts` knows which
 * series are due). Recorded as a deviation rather than silently dropped.
 */
export const FRED_MONTHLY_SCHEDULE = '0 9 * * *';
export const FRED_SERIES_TIMEOUT_MS = 300_000;
export const FRED_SOURCE_ID = 'fred.csv' satisfies ProviderId;

/** §10.1: `econ_observations.value` is `numeric(20,6)`; every comparison is made at that scale. */
export const ECON_VALUE_SCALE = 6;

/** A statement large enough to matter, small enough to keep the query plan flat. */
const OBSERVATION_CHUNK = 5_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The seeded series list (PROVIDERS §10.1 "the seeded FRED series list")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One `econ_series` row, as the list seeds it.
 *
 * The CSV itself carries no metadata beyond the series code and the observations — no name, no
 * units, no frequency — which is exactly why §10.1 calls the list *seeded*. Everything here is
 * FRED's own published description of the series; nothing is derived from the bytes, and a series
 * the list does not name is not polled.
 */
export interface FredSeriesDefinition {
  /** `econ_series.series_code` — §10.1: "the command-line code", which for FRED is its own id. */
  seriesCode: string;
  /** `econ_series.provider_code` — the `id` parameter of the request. */
  providerCode: string;
  name: string;
  units: string;
  frequency: 'D' | 'W' | 'M' | 'Q' | 'A';
  seasonalAdj: string | null;
  decimals: number;
}

/** The headline set (PROVIDERS §10.1). Rates first, then the monthly and quarterly indicators. */
export const FRED_SERIES: readonly FredSeriesDefinition[] = Object.freeze([
  {
    seriesCode: 'DGS10',
    providerCode: 'DGS10',
    name: 'Market Yield on U.S. Treasury Securities at 10-Year Constant Maturity, Quoted on an Investment Basis',
    units: 'Percent',
    frequency: 'D',
    seasonalAdj: 'NSA',
    decimals: 2,
  },
  {
    seriesCode: 'DGS2',
    providerCode: 'DGS2',
    name: 'Market Yield on U.S. Treasury Securities at 2-Year Constant Maturity, Quoted on an Investment Basis',
    units: 'Percent',
    frequency: 'D',
    seasonalAdj: 'NSA',
    decimals: 2,
  },
  {
    seriesCode: 'DGS30',
    providerCode: 'DGS30',
    name: 'Market Yield on U.S. Treasury Securities at 30-Year Constant Maturity, Quoted on an Investment Basis',
    units: 'Percent',
    frequency: 'D',
    seasonalAdj: 'NSA',
    decimals: 2,
  },
  {
    seriesCode: 'DTB3',
    providerCode: 'DTB3',
    name: '3-Month Treasury Bill Secondary Market Rate, Discount Basis',
    units: 'Percent',
    frequency: 'D',
    seasonalAdj: 'NSA',
    decimals: 2,
  },
  {
    seriesCode: 'T10Y2Y',
    providerCode: 'T10Y2Y',
    name: '10-Year Treasury Constant Maturity Minus 2-Year Treasury Constant Maturity',
    units: 'Percent',
    frequency: 'D',
    seasonalAdj: 'NSA',
    decimals: 2,
  },
  {
    seriesCode: 'DFF',
    providerCode: 'DFF',
    name: 'Federal Funds Effective Rate',
    units: 'Percent',
    frequency: 'D',
    seasonalAdj: 'NSA',
    decimals: 2,
  },
  {
    seriesCode: 'FEDFUNDS',
    providerCode: 'FEDFUNDS',
    name: 'Federal Funds Effective Rate',
    units: 'Percent',
    frequency: 'M',
    seasonalAdj: 'NSA',
    decimals: 2,
  },
  {
    seriesCode: 'CPIAUCSL',
    providerCode: 'CPIAUCSL',
    name: 'Consumer Price Index for All Urban Consumers: All Items in U.S. City Average',
    units: 'Index 1982-1984=100',
    frequency: 'M',
    seasonalAdj: 'SA',
    decimals: 3,
  },
  {
    seriesCode: 'CPIAUCNS',
    providerCode: 'CPIAUCNS',
    name: 'Consumer Price Index for All Urban Consumers: All Items in U.S. City Average',
    units: 'Index 1982-1984=100',
    frequency: 'M',
    seasonalAdj: 'NSA',
    decimals: 3,
  },
  {
    seriesCode: 'UNRATE',
    providerCode: 'UNRATE',
    name: 'Unemployment Rate',
    units: 'Percent',
    frequency: 'M',
    seasonalAdj: 'SA',
    decimals: 1,
  },
  {
    seriesCode: 'PAYEMS',
    providerCode: 'PAYEMS',
    name: 'All Employees, Total Nonfarm',
    units: 'Thousands of Persons',
    frequency: 'M',
    seasonalAdj: 'SA',
    decimals: 0,
  },
  {
    seriesCode: 'GDP',
    providerCode: 'GDP',
    name: 'Gross Domestic Product',
    units: 'Billions of Dollars',
    frequency: 'Q',
    seasonalAdj: 'SAAR',
    decimals: 3,
  },
  {
    seriesCode: 'GDPC1',
    providerCode: 'GDPC1',
    name: 'Real Gross Domestic Product',
    units: 'Billions of Chained 2017 Dollars',
    frequency: 'Q',
    seasonalAdj: 'SAAR',
    decimals: 3,
  },
]);

/** The daily half of the list — what `'30 16 * * 1-5'` polls. */
export const FRED_DAILY_SERIES: readonly FredSeriesDefinition[] = Object.freeze(
  FRED_SERIES.filter((s) => s.frequency === 'D'),
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `econ_series`
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What {@link ensureEconSeries} needs, for FRED and for any other econ source that shares it. */
export interface EconSeriesSeed {
  seriesCode: string;
  sourceId: string;
  providerCode: string;
  name: string;
  units: string;
  frequency: 'D' | 'W' | 'M' | 'Q' | 'A';
  seasonalAdj: string | null;
  country?: string;
  decimals?: number;
}

/**
 * The `series_id` for `(source_id, provider_code)`, creating the row the first time.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert of the descriptive columns: the name and units
 * are the *seed's* statement about the series, and a poll has nothing better to say about them.
 * `first_obs_date`, `last_obs_date` and `last_updated_at` are what a poll does know, and
 * {@link recordSeriesFacts} writes those.
 */
export async function ensureEconSeries(tx: Tx, seed: EconSeriesSeed): Promise<number> {
  await tx.execute(sql`
    INSERT INTO econ_series (series_code, source_id, provider_code, name, units, frequency,
                             seasonal_adj, country, decimals)
    VALUES (${seed.seriesCode}, ${seed.sourceId}, ${seed.providerCode}, ${seed.name},
            ${seed.units}, ${seed.frequency}, ${seed.seasonalAdj}, ${seed.country ?? 'US'},
            ${seed.decimals ?? 2})
    ON CONFLICT (source_id, provider_code) DO NOTHING`);
  const rows = await tx.execute<{ series_id: string }>(sql`
    SELECT series_id FROM econ_series
     WHERE source_id = ${seed.sourceId} AND provider_code = ${seed.providerCode}`);
  const row = rows.rows[0];
  if (row === undefined) {
    throw new Error(
      `econ_series row for ${seed.sourceId}/${seed.providerCode} is absent immediately after ` +
        'an insert that reported no conflict — the unique key (source_id, provider_code) moved',
    );
  }
  return Number(row.series_id);
}

/** The three columns a poll genuinely learns: the observed span and when we last looked. */
export async function recordSeriesFacts(
  tx: Tx,
  seriesId: number,
  facts: { firstObsDate: string | null; lastObsDate: string | null; capturedAt: number },
): Promise<void> {
  await tx.execute(sql`
    UPDATE econ_series
       SET first_obs_date = ${facts.firstObsDate}::date,
           last_obs_date = ${facts.lastObsDate}::date,
           last_updated_at = to_timestamp(${facts.capturedAt}::double precision / 1000.0)
     WHERE series_id = ${seriesId}::bigint`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `econ_observations` — the vintaged write
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One observation as any econ source produces it (FRED, H.15, BLS, World Bank, IMF). */
export interface ObservationInput {
  obsDate: string;
  value: number | null;
  status: 'final' | 'preliminary' | 'revised' | 'missing';
  /**
   * `econ_observations.footnote` — BLS publishes one per observation (`footnotes[0].text`,
   * PROVIDERS §10.5); FRED and H.15 publish none and leave it `undefined`, which is written as
   * NULL. It participates in the change comparison: a value that acquired the footnote *"Data
   * unavailable due to the 2025 lapse in appropriations"* is a new statement about that period
   * even when the number itself did not move.
   */
  footnote?: string | null;
}

/** What {@link upsertEconObservations} did. `revised` is the number of *new vintages* opened. */
export interface ObservationCounts {
  inserted: number;
  revised: number;
  unchanged: number;
  /** Dropped because the capture is not newer than the vintage already held. */
  stale: number;
}

function noObservationCounts(): ObservationCounts {
  return { inserted: 0, revised: 0, unchanged: 0, stale: 0 };
}

/**
 * Write observations, opening a vintage for every value that differs from the one held.
 *
 * See the module header for the rule. Two details that are load-bearing:
 *
 *  - **values are compared as numbers, not as text.** Postgres returns `numeric(20,6)` as
 *    `'4.060000'` and the CSV says `4.06`; a text comparison would open a fresh vintage for every
 *    observation on every poll and turn a 262 KB file into 16,879 spurious revisions a day.
 *  - **`status` is part of the comparison.** A date that went from `'.'` to a number is a
 *    revision even though "null → 4.06" would also be caught by the value test; a date that went
 *    from a number to `'.'` is one too, and that direction the value test alone would miss when
 *    the stored value is already NULL.
 */
export async function upsertEconObservations(
  tx: Tx,
  seriesId: number,
  rows: readonly ObservationInput[],
  o: { provenanceId: number; capturedAt: number },
): Promise<ObservationCounts> {
  const counts = noObservationCounts();
  if (rows.length === 0) return counts;

  const existing = await tx.execute<{
    obs_date: string;
    value: string | null;
    status: string;
    footnote: string | null;
    vintage_at: string;
  }>(sql`
    SELECT obs_date::text AS obs_date, value::text AS value, status, footnote,
           vintage_at::text AS vintage_at
      FROM econ_observations
     WHERE series_id = ${seriesId}::bigint AND is_latest`);

  const held = new Map<
    string,
    { value: string | null; status: string; footnote: string | null; vintageAt: number }
  >();
  for (const row of existing.rows) {
    held.set(row.obs_date, {
      value: row.value,
      status: row.status,
      footnote: row.footnote,
      vintageAt: Date.parse(row.vintage_at),
    });
  }

  const vintage = new Date(o.capturedAt).toISOString();
  const fresh: {
    obsDate: string;
    value: string | null;
    status: string;
    footnote: string | null;
  }[] = [];

  for (const row of rows) {
    const value = numericIn(row.value, ECON_VALUE_SCALE);
    const footnote = row.footnote ?? null;
    const current = held.get(row.obsDate);
    if (current === undefined) {
      fresh.push({ obsDate: row.obsDate, value, status: row.status, footnote });
      continue;
    }
    if (
      sameObservation(current.value, current.status, value, row.status) &&
      current.footnote === footnote
    ) {
      counts.unchanged += 1;
      continue;
    }
    if (o.capturedAt <= current.vintageAt) {
      counts.stale += 1;
      continue;
    }
    // A revision: the row we hold stops being the latest and stays exactly as it is.
    await tx.execute(sql`
      UPDATE econ_observations SET is_latest = false
       WHERE series_id = ${seriesId}::bigint AND obs_date = ${row.obsDate}::date AND is_latest`);
    await tx.execute(sql`
      INSERT INTO econ_observations (series_id, obs_date, vintage_at, value, status, footnote,
                                     is_latest, provenance_id)
      VALUES (${seriesId}::bigint, ${row.obsDate}::date, ${vintage}::timestamptz,
              ${value}::numeric, ${value === null ? 'missing' : 'revised'}, ${footnote}, true,
              ${o.provenanceId}::bigint)
      ON CONFLICT (series_id, obs_date, vintage_at) DO NOTHING`);
    counts.revised += 1;
    held.set(row.obsDate, {
      value,
      status: value === null ? 'missing' : 'revised',
      footnote,
      vintageAt: o.capturedAt,
    });
  }

  for (let start = 0; start < fresh.length; start += OBSERVATION_CHUNK) {
    const chunk = fresh.slice(start, start + OBSERVATION_CHUNK);
    await tx.execute(sql`
      INSERT INTO econ_observations (series_id, obs_date, vintage_at, value, status, footnote,
                                     is_latest, provenance_id)
      SELECT ${seriesId}::bigint, u.obs_date::date, ${vintage}::timestamptz, u.value::numeric,
             u.status, u.footnote, true, ${o.provenanceId}::bigint
        FROM unnest(${sql.param(chunk.map((r) => r.obsDate))}::text[],
                    ${sql.param(chunk.map((r) => r.value))}::text[],
                    ${sql.param(chunk.map((r) => r.status))}::text[],
                    ${sql.param(chunk.map((r) => r.footnote))}::text[])
             AS u(obs_date, value, status, footnote)
      ON CONFLICT (series_id, obs_date, vintage_at) DO NOTHING`);
    counts.inserted += chunk.length;
  }
  return counts;
}

/** `'4.060000'` and `4.06` are the same observation; `null` and `null` are too. */
function sameObservation(
  storedValue: string | null,
  storedStatus: string,
  value: string | null,
  status: string,
): boolean {
  if (storedStatus !== status) {
    // A value that was revised keeps `status 'revised'` while the file still says `'final'`;
    // that is our own label for the same number, not a change in the number.
    const settled = storedStatus === 'revised' && status === 'final';
    if (!settled) return false;
  }
  if (storedValue === null || value === null) return storedValue === value;
  return Number(storedValue) === Number(value);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface FredSeriesContext extends MarketJobContext {
  /** `['DGS10']`. Default: the daily half of {@link FRED_SERIES}. */
  seriesIds?: readonly string[];
}

export interface FredSeriesResult extends MarketJobResult {
  series: number;
  observationsInserted: number;
  /** New vintages opened — the number of detected revisions. */
  vintagesOpened: number;
  observationsUnchanged: number;
}

function emptyFredResult(): FredSeriesResult {
  return {
    ...emptyResult(),
    series: 0,
    observationsInserted: 0,
    vintagesOpened: 0,
    observationsUnchanged: 0,
  };
}

const NO_LINES: ReadonlyMap<string, NormaliseLine> = new Map();

/** Poll each series once, in list order, and write what changed. */
export async function runFredSeries(ctx: FredSeriesContext): Promise<FredSeriesResult> {
  const wanted = ctx.seriesIds ?? FRED_DAILY_SERIES.map((s) => s.providerCode);
  const byProviderCode = new Map(FRED_SERIES.map((s) => [s.providerCode, s]));

  return (await withIngestRun(
    ctx,
    { id: 'fredSeries', sourceId: FRED_SOURCE_ID },
    async () => {
      const out = emptyFredResult();
      for (const providerCode of wanted) {
        const definition = byProviderCode.get(providerCode);
        if (definition === undefined) {
          out.errors.push({
            code: 'SERIES_NOT_SEEDED',
            message:
              `'${providerCode}' is not in FRED_SERIES: PROVIDERS §10.1 polls a seeded list, ` +
              'and a series with no name, units or frequency has no `econ_series` row to write to',
          });
          continue;
        }
        await pollSeries(ctx, definition, out);
      }
      ctx.log?.info?.('fredSeries.done', {
        series: out.series,
        inserted: out.observationsInserted,
        vintages: out.vintagesOpened,
        unchanged: out.observationsUnchanged,
        errors: out.errors.length,
      });
      return out;
    },
  )) as FredSeriesResult;
}

async function pollSeries(
  ctx: FredSeriesContext,
  definition: FredSeriesDefinition,
  out: FredSeriesResult,
): Promise<void> {
  const url = fredCsvUrl(definition.providerCode);
  const request = { seriesId: definition.providerCode, ...requestEnvelope(ctx) };

  let raw: RawRecord;
  try {
    raw = await fetchThrough(ctx, fredCsvAdapter, request, url);
  } catch (err) {
    out.errors.push(fetchError(err, url));
    return;
  }
  if (raw.status === 304) {
    // A conditional request that changed nothing: §10.1's "the conditional request makes an
    // unchanged day free". No provenance row, no observation, no vintage.
    out.skipped += 1;
    return;
  }
  out.fetched += 1;
  out.series += 1;

  const nctx: NormaliseContext = {
    provenanceId: 0,
    capturedAt: raw.capturedAt,
    lines: NO_LINES,
  };
  const parsed = parseFredCsv(raw, nctx);
  out.problems.push(...parsed.problems);
  if (parsed.rows.observations.length === 0) {
    // A schema drift (FRED substituted a retired id) or its HTML error page: nothing is written,
    // which is §10.1's rule, and the problem list says why.
    return;
  }

  const provenanceId = await insertProvenance(
    ctx.tx,
    raw,
    provenanceMeta(ctx, FRED_ADAPTER_VERSION, parsed.sourceTs ?? raw.sourceTs),
  );
  out.provenanceIds.push(provenanceId);

  const seriesId = await ensureEconSeries(ctx.tx, {
    seriesCode: definition.seriesCode,
    sourceId: FRED_SOURCE_ID,
    providerCode: definition.providerCode,
    name: definition.name,
    units: definition.units,
    frequency: definition.frequency,
    seasonalAdj: definition.seasonalAdj,
    decimals: definition.decimals,
  });

  const counts = await upsertEconObservations(
    ctx.tx,
    seriesId,
    parsed.rows.observations,
    { provenanceId, capturedAt: raw.capturedAt },
  );
  out.inserted += counts.inserted;
  out.updated += counts.revised;
  out.skipped += counts.unchanged + counts.stale;
  out.observationsInserted += counts.inserted;
  out.vintagesOpened += counts.revised;
  out.observationsUnchanged += counts.unchanged;

  await recordSeriesFacts(ctx.tx, seriesId, {
    firstObsDate: parsed.rows.series.firstObsDate,
    lastObsDate: parsed.rows.series.lastObsDate,
    capturedAt: raw.capturedAt,
  });
}

/** The scheduler row (PROVIDERS §13). */
export const job = {
  id: 'fredSeries',
  schedule: FRED_SERIES_SCHEDULE,
  provider: FRED_SOURCE_ID,
  priority: 2 as const,
  timeoutMs: FRED_SERIES_TIMEOUT_MS,
  run: (ctx: FredSeriesContext): Promise<FredSeriesResult> => runFredSeries(ctx),
};
