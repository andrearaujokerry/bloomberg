/**
 * `ingest/jobs/fxIntraday.ts` — the G10 FX pairs during the day (PROVIDERS §5.5, §13).
 *
 * §13: `yahoo.chart`, `{everyMs: 60000}`, priority 1, 15 s, "the G10 pairs in the always-on set".
 * Its own row rather than a branch of `yahooIntraday` because the target set is fixed and the
 * cadence is unconditional: FX is quoted around the clock, so there is no market-hours gate and no
 * `b1m:`/background split — the pairs are polled every minute whether or not anyone has FXC open,
 * which is what keeps the always-on WEI/FX seed from ever rendering blank (TERM-12).
 *
 * The target set is the `yahoo.chart` md lines whose `provider_symbol` is an FX pair in the Yahoo
 * spelling (`EURUSD=X`), intersected with the always-on seed keys of `ingest/hotset.ts` so that a
 * watchlist that happens to hold `NOKSEK=X` does not quietly join the 60-second budget. `ingest/
 * hotset.ts` lists the nine seeded pairs; this job polls whatever of them the database actually
 * has lines for, and nothing that is absent is an error — WP-15's seed has not run yet.
 *
 * Granularity is `5m`, matching the recorded capture and §5.5's shared 2 req/s Yahoo bucket: nine
 * pairs a minute at 1-minute bars would take the whole scheduler share and leave GP's read-through
 * with none.
 */

import { ALWAYS_ON_SEED_KEYS } from '../hotset.js';
import { ingestChart, isFxSymbol, YAHOO_SOURCE_ID } from './yahooIntraday.js';
import { emptyResult, linesOf, resolveTargets, withIngestRun } from './cboeQuotes.js';

import type { MarketJobContext, MarketJobResult, TargetLine } from './cboeQuotes.js';

/** §13 `fxIntraday`: `{everyMs: 60000}`, no market-hours gate. */
export const FX_INTRADAY_SCHEDULE = { everyMs: 60_000 } as const;

/** §5.5: five-minute bars, which is what the 2 req/s Yahoo bucket affords nine pairs a minute. */
export const FX_INTERVAL = '5m';
export const FX_RANGE = '1d';

/**
 * The G10 pairs of the always-on seed, in the Yahoo spelling — `ingest/hotset.ts`'s seed list is
 * the single source, so adding a pair there adds it here and nowhere else.
 */
export const G10_PAIRS: readonly string[] = ALWAYS_ON_SEED_KEYS.filter(
  (key) => key.sourceId === YAHOO_SOURCE_ID && isFxSymbol(key.providerSymbol),
).map((key) => key.providerSymbol);

const G10_SET: ReadonlySet<string> = new Set(G10_PAIRS);

/**
 * The seeded pairs this database has lines for.
 *
 * When the caller named `ctx.symbols` the filter is theirs, not the seed's: a backfill that asks
 * for one pair gets one pair, and `resolveTargets` has already narrowed to it.
 */
export function fxTargets(targets: readonly TargetLine[], explicit: boolean): TargetLine[] {
  return targets.filter(
    (t) => isFxSymbol(t.providerSymbol) && (explicit || G10_SET.has(t.providerSymbol)),
  );
}

/** Poll the G10 pairs for five-minute bars and a `q:` quote. */
export async function runFxIntraday(ctx: MarketJobContext): Promise<MarketJobResult> {
  return withIngestRun(ctx, { id: 'fxIntraday', sourceId: YAHOO_SOURCE_ID }, async () => {
    const result = emptyResult();
    // `instrumentIds: null` — the seed set is always on and does not decay out of the hot set, so
    // it is resolved from `md_lines` directly rather than from whatever is subscribed right now.
    const all = await resolveTargets(ctx, YAHOO_SOURCE_ID, { instrumentIds: null });
    const targets = fxTargets(all, ctx.symbols !== undefined);
    if (targets.length === 0) {
      ctx.log?.info?.('fxIntraday.no_targets', { seeded: G10_PAIRS.length });
      return result;
    }

    const lines = linesOf(all);
    for (const target of targets) {
      await ingestChart(ctx, {
        target,
        request: { symbol: target.providerSymbol, interval: FX_INTERVAL, range: FX_RANGE },
        lines,
        options: { intraday: true, daily: false },
        result,
      });
    }

    ctx.log?.info?.('fxIntraday.done', {
      pairs: targets.length,
      fetched: result.fetched,
      inserted: result.inserted,
      updated: result.updated,
    });
    return result;
  });
}

/** The scheduler row (PROVIDERS §13). */
export const job = {
  id: 'fxIntraday',
  schedule: FX_INTRADAY_SCHEDULE,
  provider: YAHOO_SOURCE_ID,
  priority: 1 as const,
  timeoutMs: 15_000,
  run: (ctx: MarketJobContext): Promise<MarketJobResult> => runFxIntraday(ctx),
};
