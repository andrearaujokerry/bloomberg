/**
 * `ingest/jobs/yahooDaily.ts` — the daily close and the corporate-action feed (PROVIDERS §5.5, §13).
 *
 * §13: `'30 17 * * 1-5'`, priority 2, 900 s, over "every instrument with a `yahoo.chart` md line;
 * `range=5y` windows at seed". The request is `interval=1d&range=5y&events=div|split`, which is the
 * shape §5.5 says Yahoo actually honours — `range=max` silently downgrades `meta.dataGranularity`
 * to `3mo`, the parser refuses to write quarterly bars into `bars_daily`, and the whole history is
 * therefore walked back in five-year windows rather than asked for in one request.
 *
 * Two writes, both idempotent by construction:
 *
 *  - `bars_daily` on `(instrument_id, session_date)`. A 5-year window re-fetched tomorrow restates
 *    1,254 bars unchanged and inserts one, which is what the counters report.
 *  - `corporate_actions` through `recordAction` → `upsertVersion` on the natural key
 *    `(instrument_id, ca_type, ex_date, source_id)`. Re-parsing the same `events` block writes no
 *    version at all (`versionId: null`); the `ca_id` is reused rather than reallocated, because a
 *    fresh surrogate key for an action the feed has already reported violates
 *    `corporate_actions_natural_excl` and takes the run down with it.
 *
 * Every parsed action lands `review_state 'queued'` (the parser's doing) and therefore adjusts no
 * price until a data-ops user reviews it — REF-10's dual key. This job never sets `reviewed`.
 */

import { recordAction } from '../../refdata/corporateActions.js';
import { ingestChart, YAHOO_SOURCE_ID } from './yahooIntraday.js';
import { emptyResult, linesOf, resolveTargets, withIngestRun } from './cboeQuotes.js';

import type { Tx } from '../../db/client.js';
import type { YahooChartRows } from '../../providers/yahoo/adapter.js';
import type { MarketJobContext, MarketJobResult, WriteCounts } from './cboeQuotes.js';

/** §13 `yahooDaily`: 17:30 ET, weekdays. */
export const YAHOO_DAILY_SCHEDULE = '30 17 * * 1-5';

/** §5.5: the window Yahoo returns at `1d` granularity without downgrading it. */
export const DAILY_RANGE = '5y';
export const DAILY_INTERVAL = '1d';

/**
 * Write the parsed dividends and splits.
 *
 * `validFrom` is left to `recordAction` (`declaredDate ?? exDate`), because when an action became
 * true in the world is the ex-date, not when Yahoo happened to publish it; `txFrom` is the capture
 * instant, so a replayed 2026 capture records 2026 as the knowledge instant rather than the day the
 * replay ran.
 *
 * @returns row counts: `inserted` for a version written, `unchanged` for one `upsertVersion`
 *          declined to write because the row already said exactly this.
 */
export async function writeCorporateActions(
  tx: Tx,
  actions: YahooChartRows['corporateActions'],
  args: { provenanceId: number; capturedAt: number },
): Promise<WriteCounts> {
  const counts: WriteCounts = { inserted: 0, updated: 0, unchanged: 0 };
  for (const action of actions) {
    const result = await recordAction(tx, {
      instrumentId: action.instrumentId,
      caType: action.caType,
      status: action.status,
      exDate: action.exDate,
      amount: action.amount,
      currency: action.currency,
      ratioNew: action.ratioNew,
      ratioOld: action.ratioOld,
      details: action.details,
      sourceId: action.sourceId,
      reviewState: action.reviewState,
      provenanceId: args.provenanceId,
      txFrom: new Date(args.capturedAt),
    });
    if (result.versionId === null) counts.unchanged += 1;
    else counts.inserted += 1;
  }
  return counts;
}

/**
 * Fetch the daily history for every instrument with a `yahoo.chart` md line.
 *
 * The hot set is deliberately **not** consulted: §13's target set for this row is "every instrument
 * with a `yahoo.chart` md line", because a daily close is written once and read for years, and an
 * instrument nobody had open at 17:30 still needs its bar.
 */
export async function runYahooDaily(ctx: MarketJobContext): Promise<MarketJobResult> {
  return withIngestRun(ctx, { id: 'yahooDaily', sourceId: YAHOO_SOURCE_ID }, async () => {
    const result = emptyResult();
    const targets = await resolveTargets(ctx, YAHOO_SOURCE_ID, { instrumentIds: null });
    if (targets.length === 0) {
      ctx.log?.info?.('yahooDaily.no_targets', { sourceId: YAHOO_SOURCE_ID });
      return result;
    }

    const lines = linesOf(targets);
    for (const target of targets) {
      await ingestChart(ctx, {
        target,
        request: {
          symbol: target.providerSymbol,
          interval: DAILY_INTERVAL,
          range: DAILY_RANGE,
          events: true,
        },
        lines,
        options: {
          intraday: false,
          daily: true,
          extra: async ({ provenanceId, rows, capturedAt }) =>
            writeCorporateActions(ctx.tx, rows.corporateActions, { provenanceId, capturedAt }),
        },
        result,
      });
    }

    ctx.log?.info?.('yahooDaily.done', {
      targets: targets.length,
      fetched: result.fetched,
      inserted: result.inserted,
      updated: result.updated,
      unchanged: result.skipped,
    });
    return result;
  });
}

/** The scheduler row (PROVIDERS §13). */
export const job = {
  id: 'yahooDaily',
  schedule: YAHOO_DAILY_SCHEDULE,
  provider: YAHOO_SOURCE_ID,
  priority: 2 as const,
  timeoutMs: 900_000,
  run: (ctx: MarketJobContext): Promise<MarketJobResult> => runYahooDaily(ctx),
};
