/**
 * `coingecko.simple` adapter — crypto context, PROVIDERS.md §5.8.
 *
 * One request covers every id, so the whole crypto universe costs one token a minute (§5.8
 * cadence). The ids are the CoinGecko slugs held in `md_lines.provider_symbol`, comma-joined and
 * percent-encoded into the canonical URL.
 *
 * Crypto trades continuously, so every update carries `session: 'open'`: the calendar entry for a
 * crypto instrument is always-open, `session_state` never becomes `'closed'`, and `valueState`
 * therefore never short-circuits to `'closed'` — staleness is decided by `ts.cap` alone, because
 * the payload carries no source timestamp at all.
 */

import type { NormalisedUpdate, QuoteFields, Tier } from '@terminal/core';

import type { ProviderRegistry } from '../registry.js';
import type {
  HttpClient,
  HttpRequest,
  NormaliseContext,
  NormaliseProblem,
  Normalised,
  ProviderAdapter,
  RawRecord,
} from '../types.js';
import { parseCoingeckoSimple } from './parse.js';

export const COINGECKO_ADAPTER_VERSION = 'coingecko/1.0.0';
export const COINGECKO_HOST = 'https://api.coingecko.com';

/** §2.4 / §5.8: 30 s, against a 60 s poll — a restarted job does not pay twice for one minute. */
export const COINGECKO_CACHE_TTL_MS = 30 * 1000;

/** §5.8: context only (BRIEF §1 non-goal), and the licence caps the source at `delayed`. */
export const COINGECKO_CONDITIONS = ['delayed'] as const;

export interface CoingeckoRequest {
  /** CoinGecko slugs: `['bitcoin', 'ethereum']`. */
  ids: readonly string[];
  /** Default `['usd']`; the terminal prices crypto in USD and converts through `fx_rates`. */
  vsCurrencies?: readonly string[];
  /** Default `true` — the rolling 24-hour move `PX_CLOSE_1D` is reconstructed from. */
  include24hChange?: boolean;
  cacheTtlMs?: number;
  traceId?: string;
  runId?: number;
  budgetShare?: 'scheduler' | 'interactive';
  captureIndex?: number;
}

export function simplePriceUrl(req: CoingeckoRequest): string {
  const params = new URLSearchParams();
  params.set('ids', [...req.ids].join(','));
  params.set('vs_currencies', [...(req.vsCurrencies ?? ['usd'])].join(','));
  params.set('include_24hr_change', String(req.include24hChange ?? true));
  return `${COINGECKO_HOST}/api/v3/simple/price?${params.toString()}`;
}

/** `quote_ticks` (§5.8 Writes). No bars: CRYP charts are built from the tick history. */
export interface CoingeckoTickRow {
  captureTs: string;
  instrumentId: number;
  mdLineId: number;
  kind: 'summary';
  /** Always `null`: the payload carries no publication instant. */
  sourceTs: null;
  publishTs: string;
  price: number;
  /** The reconstructed 24-hour-ago price, or `null` when it could not be reconstructed. */
  prevClose: number | null;
  sessionState: 'open';
  conditions: string[];
}

export interface CoingeckoRows {
  quoteTicks: CoingeckoTickRow[];
}

export const coingeckoAdapter: ProviderAdapter<CoingeckoRequest, CoingeckoRows> = {
  id: 'coingecko.simple',
  sourceId: 'coingecko.simple',
  adapterVersion: COINGECKO_ADAPTER_VERSION,

  async fetch(http: HttpClient, req: CoingeckoRequest): Promise<RawRecord> {
    const request: HttpRequest = {
      providerId: 'coingecko.simple',
      url: simplePriceUrl(req),
      cacheTtlMs: req.cacheTtlMs ?? COINGECKO_CACHE_TTL_MS,
    };
    if (req.traceId !== undefined) request.traceId = req.traceId;
    if (req.runId !== undefined) request.runId = req.runId;
    if (req.budgetShare !== undefined) request.budgetShare = req.budgetShare;
    if (req.captureIndex !== undefined) request.captureIndex = req.captureIndex;
    return http.get(request);
  },

  normalise(raw: RawRecord, ctx: NormaliseContext): Normalised<CoingeckoRows> {
    const parsed = parseCoingeckoSimple({ body: raw.body, url: raw.url });
    if (!parsed.ok) {
      return {
        updates: [],
        rows: { quoteTicks: [] },
        sourceTs: null,
        problems: [...parsed.problems],
      };
    }

    const problems: NormaliseProblem[] = [...parsed.problems];
    const updates: NormalisedUpdate[] = [];
    const rows: CoingeckoRows = { quoteTicks: [] };
    const captureTs = new Date(ctx.capturedAt).toISOString();
    const prov = { sourceId: 'coingecko.simple', provenanceId: ctx.provenanceId };

    for (const quote of parsed.quotes) {
      const line = ctx.lines.get(quote.id);
      if (line === undefined) {
        problems.push({
          kind: 'unknown_symbol',
          detail: `no md_lines row with provider_symbol '${quote.id}' for source 'coingecko.simple'`,
          path: `/${quote.id}`,
        });
        continue;
      }
      const tier: Tier = line.tier;
      const fields: Partial<QuoteFields> = { PX_LAST: quote.usd, SESSION_STATE: 'open' };
      if (quote.impliedPrevClose !== null) fields.PX_CLOSE_1D = quote.impliedPrevClose;

      updates.push({
        subject: `q:${line.instrumentId}`,
        instrumentId: line.instrumentId,
        mdLineId: line.mdLineId,
        assetClass: line.assetClass,
        tier,
        fields,
        // `src` is null — §5.8. `cap` is the fetch instant and the only clock here.
        ts: { src: null, cap: ctx.capturedAt, pub: ctx.capturedAt },
        prov,
        session: 'open',
      });

      rows.quoteTicks.push({
        captureTs,
        instrumentId: line.instrumentId,
        mdLineId: line.mdLineId,
        kind: 'summary',
        sourceTs: null,
        publishTs: captureTs,
        price: quote.usd,
        prevClose: quote.impliedPrevClose,
        sessionState: 'open',
        conditions: [...COINGECKO_CONDITIONS],
      });
    }

    // §5.8: `provenance.source_ts` is NULL for this source, always.
    return { updates, rows, sourceTs: null, problems };
  },
};

export function registerCoingeckoAdapter(registry: ProviderRegistry): ProviderRegistry {
  registry.register(coingeckoAdapter);
  return registry;
}
