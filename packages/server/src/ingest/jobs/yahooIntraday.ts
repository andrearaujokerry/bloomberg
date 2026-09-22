/**
 * `ingest/jobs/yahooIntraday.ts` — intraday bars from the Yahoo chart endpoint (PROVIDERS §5.5, §13).
 *
 * Cadence (§13): `{everyMs: 60000, offHoursEveryMs: 300000}` over the hot set. §5.5 splits the set
 * in two — "60 s for `b1m:` subscribers, 5 min for the rest of the hot set" — and the split is also
 * a *granularity* split, because a minute chart nobody is watching is 390 rows an hour of data the
 * screen will never draw: a line with a live `b1m:` subscriber is fetched `interval=1m&range=1d`,
 * everything else `interval=5m&range=1d`. {@link intervalFor} is that decision, and it is the only
 * place the hot set's subject shapes are read.
 *
 * This module also carries {@link ingestChart}, the shared `yahoo.chart` ingest that `yahooDaily`
 * and `fxIntraday` import: all three jobs are the same adapter, the same provenance row and the
 * same two bar tables, differing only in the request they build and the rows they keep. Splitting
 * them into three files is §13's naming convention (`IngestJob.id` is the module basename), not
 * three copies of the ingest.
 *
 * **Bar finality (§5.5).** The parser marks every bar but the last `is_final = true`; the last one
 * is `false` because the minute it covers has not closed. The next poll carries a later `bar_ts`,
 * restates the previous last bar as final, and `upsertBarsIntraday` reports it as an *update* — so
 * "the plant never publishes a closed bar it has not seen superseded" is visible in the counters
 * rather than asserted in a comment. A re-run over the *same* capture restates nothing and reports
 * every bar `unchanged`, which is the idempotency this job is held to.
 */

import {
  chartUrl,
  yahooChartAdapter,
  YAHOO_ADAPTER_VERSION,
} from '../../providers/yahoo/adapter.js';
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
  upsertBarsIntraday,
  withIngestRun,
} from './cboeQuotes.js';

import type { NormaliseLine, ProviderId, RawRecord } from '../../providers/types.js';
import type { YahooChartRequest } from '../../providers/yahoo/adapter.js';
import type { MarketJobContext, MarketJobResult, TargetLine } from './cboeQuotes.js';

export const YAHOO_SOURCE_ID = 'yahoo.chart' satisfies ProviderId;

/** §13 `yahooIntraday`: `{everyMs: 60000, offHoursEveryMs: 300000}`. */
export const YAHOO_INTRADAY_SCHEDULE = { everyMs: 60_000, offHoursEveryMs: 300_000 } as const;

/** §5.5: the granularity a line with a live minute-bar subscriber is polled at. */
export const SUBSCRIBED_INTERVAL = '1m';
/** §5.5: the rest of the hot set, polled at 5 minutes. */
export const BACKGROUND_INTERVAL = '5m';

/**
 * `1m` when something is subscribed to this instrument's minute bars, `5m` otherwise.
 *
 * With no hot set wired — a seed run, a replay test — every line is a background line, because
 * "nobody is watching" is the honest reading of an absent subscriber set and the cheaper request is
 * the safe default.
 */
export function intervalFor(ctx: MarketJobContext, instrumentId: number): string {
  const subject = `b1m:${String(instrumentId)}`;
  const subscribed = (ctx.hotset?.subscriberCount(subject) ?? 0) > 0;
  return subscribed ? SUBSCRIBED_INTERVAL : BACKGROUND_INTERVAL;
}

/** What {@link ingestChart} keeps out of a parsed chart payload. */
export interface ChartIngestOptions {
  /** Write `bars_intraday`. */
  intraday: boolean;
  /** Write `bars_daily`. */
  daily: boolean;
  /**
   * Called with the parsed rows after the bars are written, for the jobs that keep more — the
   * corporate actions of `yahooDaily`. Its counts are folded into the result.
   */
  extra?: (args: {
    provenanceId: number;
    rows: ReturnType<typeof yahooChartAdapter.normalise>['rows'];
    target: TargetLine;
    /** `raw.capturedAt` — the only clock a replayed run is allowed to read. */
    capturedAt: number;
  }) => Promise<{ inserted: number; updated: number; unchanged: number }>;
}

/**
 * One `yahoo.chart` exchange, end to end: fetch, provenance, normalise, publish, write.
 *
 * Shared by `yahooIntraday`, `yahooDaily` and `fxIntraday` — three rows of §13 that are one
 * adapter. The caller supplies the request (which fixes the interval, the range and whether
 * `events=div|split` is asked for) and says which bar table the answer belongs in.
 */
export async function ingestChart(
  ctx: MarketJobContext,
  args: {
    target: TargetLine;
    request: Omit<YahooChartRequest, 'traceId' | 'runId' | 'budgetShare'>;
    lines: ReadonlyMap<string, NormaliseLine>;
    options: ChartIngestOptions;
    result: MarketJobResult;
  },
): Promise<void> {
  const request: YahooChartRequest = { ...args.request, ...requestEnvelope(ctx) };
  const url = chartUrl(request);

  let raw: RawRecord;
  try {
    raw = await fetchThrough(ctx, yahooChartAdapter, request, url);
  } catch (err) {
    args.result.errors.push(fetchError(err, url));
    return;
  }
  if (raw.status === 304) {
    // §1.3: a revalidation publishes nothing and writes no provenance row.
    args.result.skipped += 1;
    return;
  }
  args.result.fetched += 1;

  const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
    raw,
    adapterVersion: YAHOO_ADAPTER_VERSION,
    lines: args.lines,
    normalise: (r, nctx) => yahooChartAdapter.normalise(r, nctx),
  });
  args.result.provenanceIds.push(provenanceId);
  args.result.problems.push(...norm.problems);
  args.result.published += publish(ctx, norm.updates, args.result.errors);

  if (args.options.intraday && norm.rows.barsIntraday.length > 0) {
    tally(args.result, await upsertBarsIntraday(ctx.tx, norm.rows.barsIntraday, provenanceId));
  }
  if (args.options.daily && norm.rows.barsDaily.length > 0) {
    tally(args.result, await upsertBarsDaily(ctx.tx, norm.rows.barsDaily, provenanceId));
  }
  if (args.options.extra !== undefined) {
    const counts = await args.options.extra({
      provenanceId,
      rows: norm.rows,
      target: args.target,
      capturedAt: raw.capturedAt,
    });
    tally(args.result, counts);
  }
}

/**
 * Poll the hot set's Yahoo lines for intraday bars.
 *
 * FX pairs are deliberately left out: `fxIntraday` owns the G10 `=X` symbols on its own §13 row and
 * its own 60-second cadence, and polling them twice would spend the same 2 req/s bucket twice for
 * the same bytes.
 */
export async function runYahooIntraday(ctx: MarketJobContext): Promise<MarketJobResult> {
  return withIngestRun(ctx, { id: 'yahooIntraday', sourceId: YAHOO_SOURCE_ID }, async () => {
    const result = emptyResult();
    const all = await resolveTargets(ctx, YAHOO_SOURCE_ID);
    const targets = all.filter((t) => !isFxSymbol(t.providerSymbol));
    if (targets.length === 0) {
      ctx.log?.info?.('yahooIntraday.no_targets', { sourceId: YAHOO_SOURCE_ID });
      return result;
    }

    const lines = linesOf(all);
    for (const target of targets) {
      await ingestChart(ctx, {
        target,
        request: {
          symbol: target.providerSymbol,
          interval: intervalFor(ctx, target.instrumentId),
          range: '1d',
        },
        lines,
        options: { intraday: true, daily: false },
        result,
      });
    }

    ctx.log?.info?.('yahooIntraday.done', {
      targets: targets.length,
      fetched: result.fetched,
      inserted: result.inserted,
      updated: result.updated,
    });
    return result;
  });
}

/** `EURUSD=X` — the Yahoo spelling of an FX pair, and `fxIntraday`'s target set (§13). */
export function isFxSymbol(providerSymbol: string): boolean {
  return /^[A-Z]{6}=X$/.test(providerSymbol);
}

/** The scheduler row (PROVIDERS §13). */
export const job = {
  id: 'yahooIntraday',
  schedule: YAHOO_INTRADAY_SCHEDULE,
  provider: YAHOO_SOURCE_ID,
  priority: 1 as const,
  timeoutMs: 15_000,
  run: (ctx: MarketJobContext): Promise<MarketJobResult> => runYahooIntraday(ctx),
};
