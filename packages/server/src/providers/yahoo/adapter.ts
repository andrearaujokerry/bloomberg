/**
 * `yahoo.chart` and `yahoo.search` adapters — PROVIDERS.md §5.5 and §5.6.
 *
 * The impure half of the pair. This file builds URLs and headers and hands the bytes to
 * `providers/http.ts`; it never parses (that is `parse.ts`, which is pure) and never writes (that
 * is the ingest job). `normalise()` is the thin, deterministic layer that binds a parse result to
 * the md lines in `NormaliseContext` and shapes the typed rows the job inserts.
 *
 * Headers are not set here: `http.ts#providerDefaults` already sends the browser-like
 * `User-Agent` §2.2 makes **mandatory** for Yahoo (an unrecognised agent is answered with a
 * zero-length 200, which `http.ts` raises as a `ProviderHttpError` so it trips the breaker instead
 * of reading as "no data"). The adapter states the requirement in `REQUIRED_HEADERS` and asserts
 * nothing overrode it, so a future edit to the defaults table fails here rather than at 3 a.m.
 */

import type { NormalisedUpdate, QuoteFields, SessionState, Tier } from '@terminal/core';

import { BROWSER_USER_AGENT } from '../http.js';
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
import {
  localIsoDate,
  parseYahooChart,
  parseYahooSearch,
  type YahooChartParsed,
  type YahooSearchQuote,
} from './parse.js';

/** PROVIDERS.a §1.4 — one version per adapter family; both Yahoo adapters share it. */
export const YAHOO_ADAPTER_VERSION = 'yahoo/1.0.0';

export const YAHOO_CHART_HOST = 'https://query1.finance.yahoo.com';
/** §5.6: search lives on `query2`, and shares `query1`'s token bucket (the bucket is per family). */
export const YAHOO_SEARCH_HOST = 'https://query2.finance.yahoo.com';

/** §2.2: the header set Yahoo requires. Sent by `http.ts`; named here so the contract is visible. */
export const REQUIRED_HEADERS: Readonly<Record<string, string>> = {
  'user-agent': BROWSER_USER_AGENT,
  accept: 'application/json',
};

/** §2.4: `range=max` is answered from the store for six hours; an intraday range never is. */
export const CHART_LONG_RANGE_TTL_MS = 6 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// URL construction
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface YahooChartRequest {
  /** The Yahoo symbol as `md_lines.provider_symbol` holds it: `AAPL`, `^GSPC`, `EURUSD=X`. */
  symbol: string;
  /** `1d`, `5d`, `5y`, `max`, … Ignored by Yahoo when `period1`/`period2` are given. */
  range?: string;
  /** `1m`, `5m`, `1d`. Always sent, and always compared against `meta.dataGranularity`. */
  interval: string;
  /** `true` adds `events=div|split` — the daily history request (§5.5). */
  events?: boolean;
  /** Epoch **seconds**; the `period1`/`period2` walk-back of the daily backfill. */
  period1?: number;
  period2?: number;
  cacheTtlMs?: number;
  traceId?: string;
  runId?: number;
  budgetShare?: 'scheduler' | 'interactive';
  captureIndex?: number;
}

/**
 * The chart URL. The symbol is percent-encoded (`^GSPC` → `%5EGSPC`, `EURUSD=X` → `EURUSD%3DX`),
 * which is also the spelling `replayStore.canonicalUrl` produces, so a request built here hits the
 * committed capture exactly.
 */
export function chartUrl(req: YahooChartRequest): string {
  const params = new URLSearchParams();
  params.set('interval', req.interval);
  if (req.period1 !== undefined && req.period2 !== undefined) {
    params.set('period1', String(Math.trunc(req.period1)));
    params.set('period2', String(Math.trunc(req.period2)));
  } else if (req.range !== undefined) {
    params.set('range', req.range);
  }
  // `events=div|split`; `URLSearchParams` encodes the pipe as `%7C`, which is what the manifest
  // and `canonicalUrl` both carry.
  if (req.events === true) params.set('events', 'div|split');
  return `${YAHOO_CHART_HOST}/v8/finance/chart/${encodeURIComponent(req.symbol)}?${params.toString()}`;
}

export interface YahooSearchRequest {
  query: string;
  /** Default 8, as the committed capture was taken. */
  quotesCount?: number;
  /** Default 0 — §5.6 ignores `news` entirely, so none is requested. */
  newsCount?: number;
  cacheTtlMs?: number;
  traceId?: string;
  budgetShare?: 'scheduler' | 'interactive';
  captureIndex?: number;
}

export function searchUrl(req: YahooSearchRequest): string {
  const params = new URLSearchParams();
  params.set('q', req.query);
  params.set('quotesCount', String(req.quotesCount ?? 8));
  params.set('newsCount', String(req.newsCount ?? 0));
  return `${YAHOO_SEARCH_HOST}/v1/finance/search?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `bars_intraday`, camel-cased column names (CONTRACTS §1.2). */
export interface YahooIntradayBarRow {
  instrumentId: number;
  barInterval: string;
  /** ISO-8601 UTC — `bar_ts`, the bar **start**. */
  barTs: string;
  mdLineId: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  session: string;
  /**
   * §5.5: the last bar of any poll is written `is_final = false` and flipped to `true` by the next
   * poll that carries a later `bar_ts` — the plant never publishes a closed bar it has not seen
   * superseded.
   */
  isFinal: boolean;
  captureTs: string;
}

/** `bars_daily`. */
export interface YahooDailyBarRow {
  instrumentId: number;
  sessionDate: string;
  mdLineId: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  /** Reconciliation only; never served (REF-09 adjusts on read from our own corporate actions). */
  srcAdjClose: number | null;
  sourceTs: string | null;
  captureTs: string;
}

/** `corporate_actions` — bitemporal, `upsertVersion` on `(instrument_id, ca_type, ex_date, source_id)`. */
export interface YahooCorporateActionRow {
  instrumentId: number;
  caType: 'cash_dividend' | 'split' | 'reverse_split';
  /** `ca_status` (DATA_MODEL enum): a past split is `confirmed`, there being no `effective`. */
  status: 'announced' | 'paid' | 'confirmed';
  exDate: string;
  amount: number | null;
  currency: string | null;
  ratioNew: number | null;
  ratioOld: number | null;
  details: Record<string, unknown>;
  sourceId: string;
  /** REF-10 dual key: a parsed action never adjusts a price until data-ops reviews it. */
  reviewState: 'queued';
}

export interface YahooChartRows {
  barsIntraday: YahooIntradayBarRow[];
  barsDaily: YahooDailyBarRow[];
  corporateActions: YahooCorporateActionRow[];
}

export interface YahooSearchRows {
  /** §5.6 writes nothing; the rows are the fallback block handed to `GET /api/v1/search`. */
  quotes: YahooSearchQuote[];
}

function emptyChartRows(): YahooChartRows {
  return { barsIntraday: [], barsDaily: [], corporateActions: [] };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// normalise
// ─────────────────────────────────────────────────────────────────────────────────────────────

function isoOrNull(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return new Date(ms).toISOString();
}

function quoteFields(parsed: YahooChartParsed): Partial<QuoteFields> {
  const source = parsed.quote.fields;
  const fields: Partial<QuoteFields> = {};
  const last = source.PX_LAST;
  const high = source.PX_HIGH;
  const low = source.PX_LOW;
  const volume = source.PX_VOLUME;
  const close1d = source.PX_CLOSE_1D;
  if (last !== undefined) fields.PX_LAST = last;
  if (high !== undefined) fields.PX_HIGH = high;
  if (low !== undefined) fields.PX_LOW = low;
  if (volume !== undefined) fields.PX_VOLUME = volume;
  if (close1d !== undefined) fields.PX_CLOSE_1D = close1d;
  return fields;
}

/** The parse result's session word, in the plant's vocabulary. */
function sessionState(parsed: YahooChartParsed): SessionState {
  switch (parsed.quote.session) {
    case 'open':
      return 'open';
    case 'pre':
      return 'pre';
    case 'post':
      return 'post';
    case 'closed':
      return 'closed';
    default:
      return 'unknown';
  }
}

/**
 * `yahoo.chart`. `Req` is `YahooChartRequest`; `Rows` carries the two bar tables and the corporate
 * actions of §5.5.
 */
export const yahooChartAdapter: ProviderAdapter<YahooChartRequest, YahooChartRows> = {
  id: 'yahoo.chart',
  sourceId: 'yahoo.chart',
  adapterVersion: YAHOO_ADAPTER_VERSION,

  async fetch(http: HttpClient, req: YahooChartRequest): Promise<RawRecord> {
    const url = chartUrl(req);
    const request: HttpRequest = {
      providerId: 'yahoo.chart',
      url,
      // §2.4: an intraday range must always revalidate; only `range=max` is cached, and only the
      // adapter knows which was asked for.
      cacheTtlMs: req.cacheTtlMs ?? (req.range === 'max' ? CHART_LONG_RANGE_TTL_MS : 0),
    };
    if (req.traceId !== undefined) request.traceId = req.traceId;
    if (req.runId !== undefined) request.runId = req.runId;
    if (req.budgetShare !== undefined) request.budgetShare = req.budgetShare;
    if (req.captureIndex !== undefined) request.captureIndex = req.captureIndex;
    return http.get(request);
  },

  normalise(raw: RawRecord, ctx: NormaliseContext): Normalised<YahooChartRows> {
    const parsed = parseYahooChart({ body: raw.body, url: raw.url });
    if (!parsed.ok) {
      return {
        updates: [],
        rows: emptyChartRows(),
        sourceTs: null,
        problems: [...parsed.problems],
      };
    }

    const problems: NormaliseProblem[] = [...parsed.problems];
    const sourceTs = parsed.quote.sourceTsMs === null ? null : new Date(parsed.quote.sourceTsMs);
    const line = ctx.lines.get(parsed.symbol);
    if (line === undefined) {
      problems.push({
        kind: 'unknown_symbol',
        detail:
          `no md_lines row with provider_symbol '${parsed.symbol}' for source 'yahoo.chart'; ` +
          'nothing is published and no bar is written',
        path: '/chart/result/0/meta/symbol',
      });
      return { updates: [], rows: emptyChartRows(), sourceTs, problems };
    }

    const captureTs = new Date(ctx.capturedAt).toISOString();
    const tier: Tier = line.tier;
    const updates: NormalisedUpdate[] = [];
    const prov = { sourceId: 'yahoo.chart', provenanceId: ctx.provenanceId };

    const fields = quoteFields(parsed);
    const session = sessionState(parsed);
    if (Object.keys(fields).length > 0) {
      fields.SESSION_STATE = session;
      updates.push({
        subject: `q:${line.instrumentId}`,
        instrumentId: line.instrumentId,
        mdLineId: line.mdLineId,
        assetClass: line.assetClass,
        tier,
        fields,
        ts: { src: parsed.quote.sourceTsMs, cap: ctx.capturedAt, pub: ctx.capturedAt },
        prov,
        session,
      });
    }

    const rows = emptyChartRows();
    const granularity = parsed.granularity;

    if (parsed.barsWritable && granularity !== null && parsed.bars.length > 0) {
      const last = parsed.bars.length - 1;
      if (parsed.barKind === 'intraday') {
        for (let i = 0; i < parsed.bars.length; i++) {
          const bar = parsed.bars[i]!;
          const barTs = isoOrNull(bar.barTs);
          if (barTs === null) {
            problems.push({
              kind: 'out_of_range',
              detail: `bar timestamp ${bar.barTs} is not a representable instant`,
              path: `/chart/result/0/timestamp/${i}`,
            });
            continue;
          }
          rows.barsIntraday.push({
            instrumentId: line.instrumentId,
            barInterval: granularity,
            barTs,
            mdLineId: line.mdLineId,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
            session: bar.session,
            isFinal: i !== last,
            captureTs,
          });
        }

        // §5.5: the plant carries the newest bar on its own subject. `BAR_TS` and `IS_FINAL` have
        // no `QuoteFields` slot (core `types/quote.ts`), so the bar's instant rides `ts.src` and
        // its finality is carried by the row, not by the update — see the WP-05 notes.
        const newest = parsed.bars[last];
        if (newest !== undefined) {
          updates.push({
            subject: `b${granularity}:${line.instrumentId}`,
            instrumentId: line.instrumentId,
            mdLineId: line.mdLineId,
            assetClass: line.assetClass,
            tier,
            fields: {
              PX_OPEN: newest.open,
              PX_HIGH: newest.high,
              PX_LOW: newest.low,
              PX_LAST: newest.close,
              ...(newest.volume === null ? {} : { PX_VOLUME: newest.volume }),
            },
            ts: { src: newest.barTs, cap: ctx.capturedAt, pub: ctx.capturedAt },
            prov,
          });
        }
      } else if (parsed.barKind === 'daily') {
        for (let i = 0; i < parsed.bars.length; i++) {
          const bar = parsed.bars[i]!;
          const sessionDate = localIsoDate(bar.barTs / 1000, parsed.meta.gmtOffsetSec);
          if (sessionDate === null) {
            problems.push({
              kind: 'out_of_range',
              detail: `bar timestamp ${bar.barTs} is not a representable instant`,
              path: `/chart/result/0/timestamp/${i}`,
            });
            continue;
          }
          rows.barsDaily.push({
            instrumentId: line.instrumentId,
            sessionDate,
            mdLineId: line.mdLineId,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
            srcAdjClose: bar.adjClose,
            sourceTs: isoOrNull(bar.barTs),
            captureTs,
          });
        }
      }
    }

    // Corporate actions. `status` is the one clock reading a normaliser is allowed: `capturedAt`
    // (§1.2), never `Date.now()` — which is what makes a replayed 2026 capture stamp 2026.
    const today = localIsoDate(ctx.capturedAt / 1000, parsed.meta.gmtOffsetSec);
    for (const dividend of parsed.dividends) {
      rows.corporateActions.push({
        instrumentId: line.instrumentId,
        caType: 'cash_dividend',
        status: today !== null && dividend.exDate < today ? 'paid' : 'announced',
        exDate: dividend.exDate,
        amount: dividend.amount,
        currency: dividend.currency,
        ratioNew: null,
        ratioOld: null,
        details: { barTs: isoOrNull(dividend.barTsMs), exTs: isoOrNull(dividend.exTsMs) },
        sourceId: 'yahoo.chart',
        reviewState: 'queued',
      });
    }
    for (const split of parsed.splits) {
      rows.corporateActions.push({
        instrumentId: line.instrumentId,
        caType: split.caType,
        status: today !== null && split.exDate < today ? 'confirmed' : 'announced',
        exDate: split.exDate,
        amount: null,
        currency: null,
        ratioNew: split.numerator,
        ratioOld: split.denominator,
        details: { splitRatio: split.splitRatio, exTs: isoOrNull(split.exTsMs) },
        sourceId: 'yahoo.chart',
        reviewState: 'queued',
      });
    }

    return { updates, rows, sourceTs, problems };
  },
};

/**
 * `yahoo.search`. Read-only by design (§5.6): no `md_lines` row, no plant subject, no stored
 * value, and therefore no updates — the rows are the fallback block the command line appends
 * below every local candidate.
 */
export const yahooSearchAdapter: ProviderAdapter<YahooSearchRequest, YahooSearchRows> = {
  id: 'yahoo.search',
  sourceId: 'yahoo.search',
  adapterVersion: YAHOO_ADAPTER_VERSION,

  async fetch(http: HttpClient, req: YahooSearchRequest): Promise<RawRecord> {
    const request: HttpRequest = {
      providerId: 'yahoo.search',
      url: searchUrl(req),
      // §5.6: on demand only, five minutes on the canonical URL, so the same query from ten users
      // costs one request; and it is the user's keystroke, not the scheduler, paying for it.
      budgetShare: req.budgetShare ?? 'interactive',
    };
    if (req.cacheTtlMs !== undefined) request.cacheTtlMs = req.cacheTtlMs;
    if (req.traceId !== undefined) request.traceId = req.traceId;
    if (req.captureIndex !== undefined) request.captureIndex = req.captureIndex;
    return http.get(request);
  },

  normalise(raw: RawRecord, _ctx: NormaliseContext): Normalised<YahooSearchRows> {
    const parsed = parseYahooSearch({ body: raw.body, url: raw.url });
    if (!parsed.ok) {
      return { updates: [], rows: { quotes: [] }, sourceTs: null, problems: [...parsed.problems] };
    }
    // The payload carries no publication instant, so `provenance.source_ts` is NULL.
    return {
      updates: [],
      rows: { quotes: parsed.quotes },
      sourceTs: null,
      problems: [...parsed.problems],
    };
  },
};

/** Both Yahoo adapters, in `PROVIDER_IDS` order. */
export const yahooAdapters = [yahooChartAdapter, yahooSearchAdapter] as const;

/** Register both with a `ProviderRegistry` (ARCHITECTURE §12.1 startup path). */
export function registerYahooAdapters(registry: ProviderRegistry): ProviderRegistry {
  registry.register(yahooChartAdapter);
  registry.register(yahooSearchAdapter);
  return registry;
}
