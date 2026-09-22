/**
 * `ingest/jobs/crypto.ts` — CoinGecko simple prices for CRYP (PROVIDERS §5.8, §13).
 *
 * §13: `coingecko.simple`, `{everyMs: 60000}`, priority 1, 10 s, "the fixed crypto id list, one
 * request". Not hot-set driven: the crypto universe is small and fixed, one request covers every id
 * (`?ids=bitcoin,ethereum`), and the whole universe therefore costs one token a minute out of a
 * 1 req/s keyless bucket. Polling only what is subscribed would save nothing and would make CRYP's
 * first paint wait a minute.
 *
 * The id list is read from `md_lines`, not from a constant here: the top-level keys of the response
 * are CoinGecko slugs and join **directly** to `md_lines.provider_symbol` (§5.8), so the lines the
 * database holds are both the request and the join. An id the database asks for and CoinGecko does
 * not return is an `unknown_symbol` problem and no update — and, deliberately, the line is *not*
 * marked stale, because it never ticked.
 *
 * **No timestamp anywhere.** The payload carries none: `ts.src` is null, `provenance.source_ts` is
 * NULL, and `quote_ticks.source_ts` is NULL. `valueState` therefore rests entirely on `ts.cap` and
 * `expected_interval_ms`, which is exactly the branch `staleness.ts` writes the `q.ts.src !== null`
 * guard for. `publish_ts` is the capture instant rather than a plant stamp, because for this source
 * the two are the same thing and a NULL there would hide the only time the row has.
 *
 * **Session.** Crypto trades continuously, so `session_state` is `'open'` at every hour of every
 * day and never becomes `'closed'` — the parser sets it, and nothing here overrides it with a
 * calendar the asset class does not have.
 */

import {
  coingeckoAdapter,
  simplePriceUrl,
  COINGECKO_ADAPTER_VERSION,
} from '../../providers/coingecko/adapter.js';
import {
  emptyResult,
  fetchError,
  fetchThrough,
  insertQuoteTicks,
  linesOf,
  normaliseWithProvenance,
  publish,
  requestEnvelope,
  resolveTargets,
  tally,
  withIngestRun,
} from './cboeQuotes.js';

import type { ProviderId, RawRecord } from '../../providers/types.js';
import type { MarketJobContext, MarketJobResult } from './cboeQuotes.js';

export const COINGECKO_SOURCE_ID = 'coingecko.simple' satisfies ProviderId;

/** §13 `crypto`: `{everyMs: 60000}`. */
export const CRYPTO_SCHEDULE = { everyMs: 60_000 } as const;

/** §5.8: the terminal prices crypto in USD and converts through `fx_rates`. */
export const CRYPTO_VS_CURRENCIES: readonly string[] = ['usd'];

/**
 * Poll every CoinGecko id the database has a line for, in one request.
 *
 * The ids are sorted before the URL is built: `simplePriceUrl` joins them in the order given, the
 * request key is a hash of the canonical URL, and an id list whose order depended on `md_line_id`
 * allocation would produce a different cache key — and a different replay-store key — for the same
 * question. Sorting makes the request a function of the universe, not of the seed order.
 */
export async function runCrypto(ctx: MarketJobContext): Promise<MarketJobResult> {
  return withIngestRun(ctx, { id: 'crypto', sourceId: COINGECKO_SOURCE_ID }, async () => {
    const result = emptyResult();
    const targets = await resolveTargets(ctx, COINGECKO_SOURCE_ID, { instrumentIds: null });
    if (targets.length === 0) {
      ctx.log?.info?.('crypto.no_targets', { sourceId: COINGECKO_SOURCE_ID });
      return result;
    }

    const ids = [...new Set(targets.map((t) => t.providerSymbol))].sort();
    const request = { ids, vsCurrencies: CRYPTO_VS_CURRENCIES, ...requestEnvelope(ctx) };
    const url = simplePriceUrl(request);

    let raw: RawRecord;
    try {
      raw = await fetchThrough(ctx, coingeckoAdapter, request, url);
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
      adapterVersion: COINGECKO_ADAPTER_VERSION,
      lines: linesOf(targets),
      normalise: (r, nctx) => coingeckoAdapter.normalise(r, nctx),
    });
    result.provenanceIds.push(provenanceId);
    result.problems.push(...norm.problems);
    result.published += publish(ctx, norm.updates, result.errors);

    tally(result, await insertQuoteTicks(ctx.tx, norm.rows.quoteTicks, provenanceId));

    ctx.log?.info?.('crypto.done', {
      ids: ids.length,
      ticks: norm.rows.quoteTicks.length,
      inserted: result.inserted,
      unchanged: result.skipped,
    });
    return result;
  });
}

/** The scheduler row (PROVIDERS §13). */
export const job = {
  id: 'crypto',
  schedule: CRYPTO_SCHEDULE,
  provider: COINGECKO_SOURCE_ID,
  priority: 1 as const,
  timeoutMs: 10_000,
  run: (ctx: MarketJobContext): Promise<MarketJobResult> => runCrypto(ctx),
};
