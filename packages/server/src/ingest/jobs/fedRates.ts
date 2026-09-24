/**
 * `ingest/jobs/fedRates.ts` — the NY Fed reference rates and the H.15 constant maturities
 * (PROVIDERS §10.3, §10.4, §13).
 *
 * §13 row `fedRates`: providers `nyfed.rates` + `fed.h15`, schedule `'30 8 * * 1-5'`, target "all
 * six NY Fed types + 11 H.15 CMT series", priority 2, `timeoutMs` 60 000. 08:30 ET is chosen by
 * the publications, not by convenience: the NY Fed posts SOFR at about 08:00 ET, and H.15 posts at
 * about 16:15 ET for the *previous* business day — so one morning run picks up today's fixings and
 * yesterday's constant maturities together.
 *
 * ## What it writes
 *
 *  1. **`rate_fixings`** — the full record, percentiles and volume included, keyed
 *     `(rate_code, effective_date, vintage_at)`. The NY Fed revises: a fixing carries a
 *     `revisionIndicator`, and §10.4 is explicit that a non-empty one **always** opens a new
 *     vintage. {@link upsertRateFixings} does that, and clears `is_latest` on the row it
 *     supersedes rather than overwriting it — the rate the market saw at 08:00 stays readable
 *     after the 13:00 correction.
 *  2. **`curve_points`** on `SOFR_FIX` (the overnight fixing as a curve point, tenor `ON`) and on
 *     `UST_CMT` (the eleven H.15 tenors), through `treasuryCurves.ts`'s writer — one vintaged
 *     `curve_points` upsert for every curve in the system, not four copies of one.
 *  3. **`econ_observations`** for the eleven H.15 series, through `fredSeries.ts`'s vintaged
 *     writer, so a revised constant maturity behaves exactly like a revised FRED series.
 *
 * ## What it does not do
 *
 * `rate_terms` is seeded (§10.4 lists it under the seed, and it hangs off an `asset_class 'rate'`
 * instrument WP-15 mints); this job writes the fixings, not the instrument master. And the
 * `e:<seriesCode>` plant subjects for the H.15 series wait on `core/src/fields/defs/econ.ts`, a
 * sibling WP-11 deliverable — the `r:<rateCode>` subjects, whose fields exist today, are published
 * here and are the reason `publish` is wired at all.
 *
 * **Replay is a wall.** A capture the store does not hold throws `ReplayMissError`, recorded as a
 * fetch error on the run. It never becomes a socket.
 */

import { sql } from 'drizzle-orm';

import { fedH15Adapter, h15Url } from '../../providers/fedH15/adapter.js';
import { FED_H15_ADAPTER_VERSION, UST_CMT_CURVE_ID, parseH15 } from '../../providers/fedH15/parse.js';
import { lastNUrl, latestAllUrl, nyFedRatesAdapter } from '../../providers/nyfed/adapter.js';
import { NYFED_ADAPTER_VERSION, SOFR_FIX_CURVE_ID, parseRefRates } from '../../providers/nyfed/parse.js';
import { insertProvenance } from '../../providers/provenance.js';
import {
  emptyResult,
  fetchError,
  fetchThrough,
  linesOf,
  numericIn,
  provenanceMeta,
  publish,
  requestEnvelope,
  resolveTargets,
  tally,
  withIngestRun,
} from './cboeQuotes.js';
import { ensureCurves, upsertCurvePoints } from './treasuryCurves.js';
import { ensureEconSeries, recordSeriesFacts, upsertEconObservations } from './fredSeries.js';

import type { Tx } from '../../db/client.js';
import type { CurveDefinition } from './treasuryCurves.js';
import type { MarketJobContext, MarketJobResult } from './cboeQuotes.js';
import type { NormaliseContext, NormaliseLine, ProviderId, RawRecord } from '../../providers/types.js';
import type { RateCode, RateFixingRow } from '../../providers/nyfed/parse.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The scheduler row (PROVIDERS §13)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** §13: 08:30 ET on weekdays — the NY Fed publishes SOFR at ≈08:00 ET. */
export const FED_RATES_SCHEDULE = '30 8 * * 1-5';
export const FED_RATES_TIMEOUT_MS = 60_000;

export const NYFED_SOURCE_ID = 'nyfed.rates' satisfies ProviderId;
export const FED_H15_SOURCE_ID = 'fed.h15' satisfies ProviderId;

/** `rate_fixings.rate`, `pct_*` and the averages are `numeric(12,8)`. */
export const RATE_SCALE = 8;
/** `volume_bn` is `numeric(14,2)`; `target_from`/`target_to` are `numeric(8,4)`. */
export const VOLUME_SCALE = 2;
export const TARGET_SCALE = 4;
/** `index_value` is `numeric(18,10)` — the SOFR index carries ten places and they all matter. */
export const INDEX_SCALE = 10;

/**
 * §10.4: `/all/latest.json` covers all six types in one request; the `last/{n}.json` endpoints
 * exist "only for the seed backfill and to pick up revisions (n = 10)". These two are the recorded
 * back-fill: the secured curve needs SOFR's recent history for `SOFR_FIX`, and EFFR's ten days are
 * what the revision sweep reads.
 */
export const NYFED_BACKFILL: readonly { code: RateCode; days: number }[] = Object.freeze([
  { code: 'SOFR', days: 5 },
  { code: 'EFFR', days: 10 },
]);

/** The two curves this job publishes (§10.3, §10.4). */
export const FED_RATES_CURVE_DEFINITIONS: readonly CurveDefinition[] = Object.freeze([
  {
    curveId: SOFR_FIX_CURVE_ID,
    name: 'SOFR overnight fixing',
    currency: 'USD',
    kind: 'fixing',
    dayCount: 'ACT/360',
    compounding: 'simple',
    sourceId: NYFED_SOURCE_ID,
  },
  {
    curveId: UST_CMT_CURVE_ID,
    name: 'US Treasury constant maturity (H.15)',
    currency: 'USD',
    kind: 'cmt',
    dayCount: 'ACT/ACT',
    compounding: 'semiannual',
    sourceId: FED_H15_SOURCE_ID,
  },
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `rate_fixings` — the vintaged write
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What {@link upsertRateFixings} did. `revised` is the number of new vintages opened. */
export interface FixingCounts {
  inserted: number;
  revised: number;
  unchanged: number;
  /** Dropped because the capture is not newer than the vintage already held (§10.4). */
  stale: number;
}

function noFixingCounts(): FixingCounts {
  return { inserted: 0, revised: 0, unchanged: 0, stale: 0 };
}

/** The twelve measured columns of a fixing, each at the scale its `numeric` declares. */
interface FixingValues {
  rate: string | null;
  pct_1: string | null;
  pct_25: string | null;
  pct_75: string | null;
  pct_99: string | null;
  volume_bn: string | null;
  target_from: string | null;
  target_to: string | null;
  avg_30d: string | null;
  avg_90d: string | null;
  avg_180d: string | null;
  index_value: string | null;
}

/** Every measured column, at the scale its `numeric` declares. The comparison key of a fixing. */
function fixingValues(row: RateFixingRow): FixingValues {
  return {
    rate: numericIn(row.rate, RATE_SCALE),
    pct_1: numericIn(row.pct1, RATE_SCALE),
    pct_25: numericIn(row.pct25, RATE_SCALE),
    pct_75: numericIn(row.pct75, RATE_SCALE),
    pct_99: numericIn(row.pct99, RATE_SCALE),
    volume_bn: numericIn(row.volumeBn, VOLUME_SCALE),
    target_from: numericIn(row.targetFrom, TARGET_SCALE),
    target_to: numericIn(row.targetTo, TARGET_SCALE),
    avg_30d: numericIn(row.avg30d, RATE_SCALE),
    avg_90d: numericIn(row.avg90d, RATE_SCALE),
    avg_180d: numericIn(row.avg180d, RATE_SCALE),
    index_value: numericIn(row.indexValue, INDEX_SCALE),
  };
}

const FIXING_COLUMNS = [
  'rate',
  'pct_1',
  'pct_25',
  'pct_75',
  'pct_99',
  'volume_bn',
  'target_from',
  'target_to',
  'avg_30d',
  'avg_90d',
  'avg_180d',
  'index_value',
] as const;

/**
 * Upsert fixings, opening a vintage whenever the NY Fed says something different.
 *
 *  - no `is_latest` row for `(rate_code, effective_date)` → **insert**;
 *  - one exists agreeing on every measured column *and* on `revision_indicator` → **nothing**;
 *  - otherwise → clear `is_latest` on it and **insert a new vintage** at this capture's instant.
 *
 * §10.4's rule that "a non-empty `revisionIndicator` always opens a new vintage" falls out of the
 * second clause rather than being bolted on: a revision the NY Fed labels but whose numbers we
 * already hold still disagrees on `revision_indicator`, so it still opens a vintage, and the
 * revision is recorded even when it changed nothing we can see.
 *
 * A capture not newer than the vintage held is dropped (`stale`) — §10.4's cached edge response.
 */
export async function upsertRateFixings(
  tx: Tx,
  rows: readonly RateFixingRow[],
  provenanceId: number,
): Promise<FixingCounts> {
  const counts = noFixingCounts();
  if (rows.length === 0) return counts;

  const codes = [...new Set(rows.map((r) => r.rateCode))].sort();
  const dates = [...new Set(rows.map((r) => r.effectiveDate))].sort();
  const existing = await tx.execute<Record<string, string | null>>(sql`
    SELECT rate_code, effective_date::text AS effective_date, vintage_at::text AS vintage_at,
           rate::text AS rate, pct_1::text AS pct_1, pct_25::text AS pct_25,
           pct_75::text AS pct_75, pct_99::text AS pct_99, volume_bn::text AS volume_bn,
           target_from::text AS target_from, target_to::text AS target_to,
           avg_30d::text AS avg_30d, avg_90d::text AS avg_90d, avg_180d::text AS avg_180d,
           index_value::text AS index_value, revision_indicator
      FROM rate_fixings
     WHERE is_latest
       AND rate_code = ANY(${sql.param(codes)}::text[])
       AND effective_date = ANY(${sql.param(dates)}::date[])`);

  const held = new Map<string, Record<string, string | null>>();
  for (const row of existing.rows) {
    held.set(`${String(row.rate_code)}|${String(row.effective_date)}`, row);
  }

  for (const row of rows) {
    const key = `${row.rateCode}|${row.effectiveDate}`;
    const values = fixingValues(row);
    const current = held.get(key);
    const vintageAt = Date.parse(row.vintageAt);

    if (current !== undefined) {
      if (sameFixing(current, values, row.revisionIndicator)) {
        counts.unchanged += 1;
        continue;
      }
      if (vintageAt <= Date.parse(String(current.vintage_at))) {
        counts.stale += 1;
        continue;
      }
      await tx.execute(sql`
        UPDATE rate_fixings SET is_latest = false
         WHERE rate_code = ${row.rateCode} AND effective_date = ${row.effectiveDate}::date
           AND is_latest`);
      counts.revised += 1;
    } else {
      counts.inserted += 1;
    }

    await tx.execute(sql`
      INSERT INTO rate_fixings (rate_code, effective_date, vintage_at, rate, pct_1, pct_25, pct_75,
                                pct_99, volume_bn, target_from, target_to, avg_30d, avg_90d,
                                avg_180d, index_value, revision_indicator, is_latest,
                                provenance_id)
      VALUES (${row.rateCode}, ${row.effectiveDate}::date, ${row.vintageAt}::timestamptz,
              ${values.rate}::numeric, ${values.pct_1}::numeric, ${values.pct_25}::numeric,
              ${values.pct_75}::numeric, ${values.pct_99}::numeric,
              ${values.volume_bn}::numeric, ${values.target_from}::numeric,
              ${values.target_to}::numeric, ${values.avg_30d}::numeric,
              ${values.avg_90d}::numeric, ${values.avg_180d}::numeric,
              ${values.index_value}::numeric, ${row.revisionIndicator}, true,
              ${provenanceId}::bigint)
      ON CONFLICT (rate_code, effective_date, vintage_at) DO NOTHING`);

    held.set(key, {
      ...values,
      vintage_at: row.vintageAt,
      revision_indicator: row.revisionIndicator,
    });
  }
  return counts;
}

/** Every measured column, compared as a number, plus the revision label compared as text. */
function sameFixing(
  stored: Record<string, string | null>,
  values: FixingValues,
  revisionIndicator: string,
): boolean {
  if ((stored.revision_indicator ?? '') !== revisionIndicator) return false;
  for (const column of FIXING_COLUMNS) {
    const a = stored[column] ?? null;
    const b = values[column] ?? null;
    if (a === null || b === null) {
      if (a !== b) return false;
      continue;
    }
    if (Number(a) !== Number(b)) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface FedRatesContext extends MarketJobContext {
  /** Override §10.4's recorded back-fill. `[]` fetches `/all/latest.json` alone. */
  backfill?: readonly { code: RateCode; days: number }[];
  /** `false` skips the H.15 half — for a run that only wants the morning fixings. */
  h15?: boolean;
}

export interface FedRatesResult extends MarketJobResult {
  fixingsInserted: number;
  /** New `rate_fixings` vintages opened — revisions the NY Fed published. */
  fixingVintages: number;
  fixingsUnchanged: number;
  sofrPoints: number;
  cmtPoints: number;
  h15Series: number;
  h15Observations: number;
}

function emptyFedRatesResult(): FedRatesResult {
  return {
    ...emptyResult(),
    fixingsInserted: 0,
    fixingVintages: 0,
    fixingsUnchanged: 0,
    sofrPoints: 0,
    cmtPoints: 0,
    h15Series: 0,
    h15Observations: 0,
  };
}

const NO_LINES: ReadonlyMap<string, NormaliseLine> = new Map();

/** `/all/latest.json`, then the back-fill endpoints, then H.15 — §10.4's order. */
export async function runFedRates(ctx: FedRatesContext): Promise<FedRatesResult> {
  const backfill = ctx.backfill ?? NYFED_BACKFILL;
  return (await withIngestRun(ctx, { id: 'fedRates', sourceId: NYFED_SOURCE_ID }, async () => {
    const out = emptyFedRatesResult();
    await ensureCurves(ctx.tx, FED_RATES_CURVE_DEFINITIONS);

    // The md lines for this source are keyed by the rate code itself, so the parser emits the
    // `r:<rateCode>` updates and the job only has to hand it the lines it resolved.
    const targets = await resolveTargets(ctx, NYFED_SOURCE_ID, { instrumentIds: null });
    const lines = linesOf(targets);

    await pollNyFed(ctx, { kind: 'latest' }, latestAllUrl(), lines, out);
    for (const window of backfill) {
      await pollNyFed(
        ctx,
        { kind: 'last', code: window.code, days: window.days },
        lastNUrl(window.code, window.days),
        lines,
        out,
      );
    }
    if (ctx.h15 !== false) await pollH15(ctx, out);

    ctx.log?.info?.('fedRates.done', {
      fixings: out.fixingsInserted,
      vintages: out.fixingVintages,
      unchanged: out.fixingsUnchanged,
      sofrPoints: out.sofrPoints,
      cmtPoints: out.cmtPoints,
      h15Series: out.h15Series,
      errors: out.errors.length,
    });
    return out;
  })) as FedRatesResult;
}

async function pollNyFed(
  ctx: FedRatesContext,
  request: Parameters<typeof nyFedRatesAdapter.fetch>[1],
  url: string,
  lines: ReadonlyMap<string, NormaliseLine>,
  out: FedRatesResult,
): Promise<void> {
  let raw: RawRecord;
  try {
    raw = await fetchThrough(ctx, nyFedRatesAdapter, { ...request, ...requestEnvelope(ctx) }, url);
  } catch (err) {
    out.errors.push(fetchError(err, url));
    return;
  }
  if (raw.status === 304) {
    out.skipped += 1;
    return;
  }
  out.fetched += 1;

  const probe = parseRefRates(raw, { provenanceId: 0, capturedAt: raw.capturedAt, lines });
  const provenanceId = await insertProvenance(
    ctx.tx,
    raw,
    provenanceMeta(ctx, NYFED_ADAPTER_VERSION, probe.sourceTs ?? raw.sourceTs),
  );
  out.provenanceIds.push(provenanceId);
  const parsed = parseRefRates(raw, { provenanceId, capturedAt: raw.capturedAt, lines });
  out.problems.push(...parsed.problems);

  const counts = await upsertRateFixings(ctx.tx, parsed.rows.fixings, provenanceId);
  out.inserted += counts.inserted;
  out.updated += counts.revised;
  out.skipped += counts.unchanged + counts.stale;
  out.fixingsInserted += counts.inserted;
  out.fixingVintages += counts.revised;
  out.fixingsUnchanged += counts.unchanged;

  tally(out, await upsertCurvePoints(ctx.tx, parsed.rows.curvePoints, provenanceId));
  out.sofrPoints += parsed.rows.curvePoints.length;
  out.published += publish(ctx, parsed.updates, out.errors);
}

/** §10.3 — `fed-h15.csv` → `econ_observations` + `curve_points('UST_CMT')`. */
async function pollH15(ctx: FedRatesContext, out: FedRatesResult): Promise<void> {
  const url = h15Url();
  let raw: RawRecord;
  try {
    raw = await fetchThrough(ctx, fedH15Adapter, requestEnvelope(ctx), url);
  } catch (err) {
    out.errors.push(fetchError(err, url));
    return;
  }
  if (raw.status === 304) {
    out.skipped += 1;
    return;
  }
  out.fetched += 1;

  const nctx: NormaliseContext = { provenanceId: 0, capturedAt: raw.capturedAt, lines: NO_LINES };
  const parsed = parseH15(raw, nctx);
  out.problems.push(...parsed.problems);
  if (parsed.rows.series.length === 0) return;

  const provenanceId = await insertProvenance(
    ctx.tx,
    raw,
    provenanceMeta(ctx, FED_H15_ADAPTER_VERSION, parsed.sourceTs ?? raw.sourceTs),
  );
  out.provenanceIds.push(provenanceId);

  // Unlike FRED, the H.15 file *carries* its own metadata — the description and the unit are in
  // the header block — so nothing here is seeded and nothing is invented. `series_code` is the
  // published column name (`RIFLGFCY10_N.B`): H.15 has no shorter public identifier, and inventing
  // a prettier one would make `econ_series.series_code` unresolvable against the source.
  const byProviderCode = new Map<string, number>();
  for (const series of parsed.rows.series) {
    const seriesId = await ensureEconSeries(ctx.tx, {
      seriesCode: series.providerCode,
      sourceId: FED_H15_SOURCE_ID,
      providerCode: series.providerCode,
      name: series.name,
      units: series.units,
      frequency: 'D',
      seasonalAdj: 'NSA',
      decimals: 2,
    });
    byProviderCode.set(series.providerCode, seriesId);
  }
  out.h15Series += byProviderCode.size;

  const byCode = new Map<string, { obsDate: string; value: number | null; status: 'final' | 'missing' }[]>();
  for (const observation of parsed.rows.observations) {
    const bucket = byCode.get(observation.providerCode);
    const row = {
      obsDate: observation.obsDate,
      value: observation.value,
      status: observation.status,
    };
    if (bucket === undefined) byCode.set(observation.providerCode, [row]);
    else bucket.push(row);
  }

  for (const [providerCode, observations] of [...byCode.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    const seriesId = byProviderCode.get(providerCode);
    if (seriesId === undefined) continue;
    const counts = await upsertEconObservations(ctx.tx, seriesId, observations, {
      provenanceId,
      capturedAt: raw.capturedAt,
    });
    out.inserted += counts.inserted;
    out.updated += counts.revised;
    out.skipped += counts.unchanged + counts.stale;
    out.h15Observations += counts.inserted + counts.revised;

    const dates = observations.map((o) => o.obsDate).sort();
    await recordSeriesFacts(ctx.tx, seriesId, {
      firstObsDate: dates[0] ?? null,
      lastObsDate: dates[dates.length - 1] ?? null,
      capturedAt: raw.capturedAt,
    });
  }

  tally(out, await upsertCurvePoints(ctx.tx, parsed.rows.curvePoints, provenanceId));
  out.cmtPoints += parsed.rows.curvePoints.length;
}

/** The scheduler row (PROVIDERS §13). */
export const job = {
  id: 'fedRates',
  schedule: FED_RATES_SCHEDULE,
  provider: [NYFED_SOURCE_ID, FED_H15_SOURCE_ID] as const,
  priority: 2 as const,
  timeoutMs: FED_RATES_TIMEOUT_MS,
  run: (ctx: FedRatesContext): Promise<FedRatesResult> => runFedRates(ctx),
};
