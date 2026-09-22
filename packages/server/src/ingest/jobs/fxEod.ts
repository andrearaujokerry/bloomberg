/**
 * `ingest/jobs/fxEod.ts` — the ECB daily fixing (PROVIDERS §5.7, §13).
 *
 * §13: `frankfurter`, `'15 16 * * 1-5'` in **Europe/Berlin**, priority 2, 20 s, "all 30 published
 * currencies". One request covers the whole fixing — `GET /v1/latest?base=USD` returns every
 * currency the ECB published that day — so the target set is not a list of symbols to fetch but a
 * list of md lines to *distribute* the one payload over. That is why this job's loop is inside the
 * normaliser rather than around the fetch: `frankfurter/adapter.ts` walks `ctx.lines` and produces
 * one `bars_daily` row and one `PX_OFFICIAL_CLOSE` update per fx line it can price.
 *
 * The timezone matters and is declared on the job: the ECB publishes around 16:00 CET, and a cron
 * expression read in `America/New_York` (the scheduler default) would fire ten hours early in
 * summer and miss the fixing entirely.
 *
 * **Writes.** `fx_rates` in both directions — `USD→EUR` and `EUR→USD` — so a cross-rate query needs
 * no conditional logic, keyed `(base_ccy, quote_ccy, rate_date, source_id)`, which makes a re-run a
 * no-op by construction. `bars_daily` gets only the conventional pair, `open`/`high`/`low`/`volume`
 * left NULL: the ECB publishes one reference fixing, not a bar, and fabricating
 * `open = high = low = close` would make FXC's candle chart lie.
 *
 * **Tier.** `frankfurter`'s `licence_registry.max_tier` is `eod`, not `delayed` — `lineTier` reads
 * it, so the updates this job publishes are tagged `eod` and the staleness renderer treats a missed
 * fixing as three days late rather than three minutes.
 */

import {
  frankfurterAdapter,
  frankfurterUrl,
  FRANKFURTER_ADAPTER_VERSION,
  REFERENCE_LINE_SYMBOL,
} from '../../providers/frankfurter/adapter.js';
import {
  emptyResult,
  fetchError,
  fetchThrough,
  linesOf,
  normaliseWithProvenance,
  publish,
  requestEnvelope,
  resolveTargets,
  tally,
  upsertBarsDaily,
  upsertFxRates,
  withIngestRun,
} from './cboeQuotes.js';

import type { ProviderId, RawRecord } from '../../providers/types.js';
import type { MarketJobContext, MarketJobResult } from './cboeQuotes.js';

export const FRANKFURTER_SOURCE_ID = 'frankfurter' satisfies ProviderId;

/** §13 `fxEod`: 16:15 Europe/Berlin, weekdays — the ECB publishes around 16:00 CET. */
export const FX_EOD_SCHEDULE = '15 16 * * 1-5';
export const FX_EOD_TIMEZONE = 'Europe/Berlin';

/** §5.7: the fixing is always requested `base=USD`; the parser asserts it (`EXPECTED_BASE`). */
export const FX_EOD_BASE = 'USD';

/**
 * Fetch the fixing once and distribute it over every `frankfurter` md line.
 *
 * A currency the fixing does not carry becomes a `field_dropped` problem and no row — never a zero
 * and never yesterday's rate carried forward. The reference line (`provider_symbol 'USD'`, the
 * `line_kind 'reference'` row of §5.7) produces an update with no fields at all, whose only job is
 * to advance `ts.cap` so `staleness.ts` can say "three fixings missed".
 */
export async function runFxEod(ctx: MarketJobContext): Promise<MarketJobResult> {
  return withIngestRun(ctx, { id: 'fxEod', sourceId: FRANKFURTER_SOURCE_ID }, async () => {
    const result = emptyResult();
    // One payload, many lines: the whole fixing is resolved, not a hot-set slice.
    const targets = await resolveTargets(ctx, FRANKFURTER_SOURCE_ID, { instrumentIds: null });
    if (targets.length === 0) {
      ctx.log?.info?.('fxEod.no_targets', { sourceId: FRANKFURTER_SOURCE_ID });
      return result;
    }

    // `frankfurterUrl` pins `base=USD` itself (the parser asserts it); the request carries only
    // the envelope, so the URL the job builds is the one `manifest.json` holds for `/v1/latest`.
    const request = { ...requestEnvelope(ctx) };
    const url = frankfurterUrl({});

    let raw: RawRecord;
    try {
      raw = await fetchThrough(ctx, frankfurterAdapter, request, url);
    } catch (err) {
      result.errors.push(fetchError(err, url));
      return result;
    }
    if (raw.status === 304) {
      result.skipped += 1;
      return result;
    }
    result.fetched += 1;

    const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
      raw,
      adapterVersion: FRANKFURTER_ADAPTER_VERSION,
      lines: linesOf(targets),
      normalise: (r, nctx) => frankfurterAdapter.normalise(r, nctx),
    });
    result.provenanceIds.push(provenanceId);
    result.problems.push(...norm.problems);
    result.published += publish(ctx, norm.updates, result.errors);

    tally(result, await upsertFxRates(ctx.tx, norm.rows.fxRates, provenanceId));
    tally(
      result,
      await upsertBarsDaily(
        ctx.tx,
        norm.rows.barsDaily.map((bar) => ({
          instrumentId: bar.instrumentId,
          sessionDate: bar.sessionDate,
          mdLineId: bar.mdLineId,
          // §5.7: one fixing, not a bar. NULL is the truth; `close` is the fixing itself.
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          sourceTs: bar.sourceTs,
          captureTs: bar.captureTs,
        })),
        provenanceId,
      ),
    );

    ctx.log?.info?.('fxEod.done', {
      lines: targets.length,
      reference: targets.some((t) => t.providerSymbol === REFERENCE_LINE_SYMBOL),
      rates: norm.rows.fxRates.length,
      bars: norm.rows.barsDaily.length,
      inserted: result.inserted,
      updated: result.updated,
      unchanged: result.skipped,
    });
    return result;
  });
}

/** The scheduler row (PROVIDERS §13). */
export const job = {
  id: 'fxEod',
  schedule: FX_EOD_SCHEDULE,
  timezone: FX_EOD_TIMEZONE,
  provider: FRANKFURTER_SOURCE_ID,
  priority: 2 as const,
  timeoutMs: 20_000,
  run: (ctx: MarketJobContext): Promise<MarketJobResult> => runFxEod(ctx),
};
