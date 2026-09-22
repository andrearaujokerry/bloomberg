/**
 * `frankfurter` adapter — ECB reference FX, PROVIDERS.md §5.7.
 *
 * Fetches `v1/latest?base=USD` (the daily fixing) or `v1/{from}..{to}?base=USD` (the seed
 * backfill), and turns one parsed fixing into `fx_rates` rows in **both** directions plus a
 * close-only `bars_daily` row for every conventional pair that has an md line.
 *
 * Two rules from §5.7 are load-bearing and are implemented here rather than in the job:
 *
 *  - `open`/`high`/`low`/`volume` stay **NULL** on `bars_daily`. The ECB publishes one reference
 *    fixing, not a bar; fabricating `open = high = low = close` would make FXC's candle chart lie.
 *  - the inversion is driven by the md line's own pair (`fx_terms.base_ccy`/`quote_ccy`), never by
 *    a hard-coded list of inverted majors, and it is rounded once at `numeric(18,8)`.
 */

import type { NormalisedUpdate, Tier } from '@terminal/core';

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
import { EXPECTED_BASE, crossRate, parseFrankfurter } from './parse.js';

export const FRANKFURTER_ADAPTER_VERSION = 'frankfurter/1.0.0';
export const FRANKFURTER_HOST = 'https://api.frankfurter.dev';

/** §2.4 / §5.7: one hour. The ECB publishes once a day; re-asking sooner buys nothing. */
export const FRANKFURTER_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * The `md_lines.provider_symbol` of the reference line (§5.7 staleness tier). It carries no price;
 * it exists so that "the ECB fixing has not arrived" is a measurable, renderable fact.
 */
export const REFERENCE_LINE_SYMBOL = 'USD';

export interface FrankfurterRequest {
  /** `undefined` → `v1/latest`. A pair of dates → the `v1/{from}..{to}` history window. */
  from?: string;
  to?: string;
  /** Restrict the response to these quote currencies; the job asks for all of them. */
  symbols?: readonly string[];
  cacheTtlMs?: number;
  traceId?: string;
  runId?: number;
  budgetShare?: 'scheduler' | 'interactive';
  captureIndex?: number;
}

export function frankfurterUrl(req: FrankfurterRequest = {}): string {
  const path = req.from !== undefined && req.to !== undefined ? `${req.from}..${req.to}` : 'latest';
  const params = new URLSearchParams();
  params.set('base', EXPECTED_BASE);
  if (req.symbols !== undefined && req.symbols.length > 0) {
    params.set('symbols', [...req.symbols].join(','));
  }
  return `${FRANKFURTER_HOST}/v1/${path}?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `fx_rates`; primary key `(base_ccy, quote_ccy, rate_date, source_id)`, so a re-run is a no-op. */
export interface FxRateRow {
  baseCcy: string;
  quoteCcy: string;
  rateDate: string;
  rate: number;
  sourceId: string;
}

/** `bars_daily`, close only (§5.7). */
export interface FrankfurterDailyBarRow {
  instrumentId: number;
  sessionDate: string;
  mdLineId: number;
  open: null;
  high: null;
  low: null;
  close: number;
  volume: null;
  sourceTs: string;
  captureTs: string;
}

export interface FrankfurterRows {
  fxRates: FxRateRow[];
  barsDaily: FrankfurterDailyBarRow[];
}

function emptyRows(): FrankfurterRows {
  return { fxRates: [], barsDaily: [] };
}

/**
 * `md_lines.provider_symbol` → the `(base, quote)` pair it names. `EURUSD` and `EURUSD=X` (the
 * Yahoo spelling, which a composite line may reuse) both read as EUR/USD; `USD` is the reference
 * line and names no pair.
 */
export function pairForLine(providerSymbol: string): { base: string; quote: string } | null {
  const trimmed = providerSymbol.endsWith('=X') ? providerSymbol.slice(0, -2) : providerSymbol;
  if (!/^[A-Z]{6}$/.test(trimmed)) return null;
  return { base: trimmed.slice(0, 3), quote: trimmed.slice(3) };
}

export const frankfurterAdapter: ProviderAdapter<FrankfurterRequest, FrankfurterRows> = {
  id: 'frankfurter',
  sourceId: 'frankfurter',
  adapterVersion: FRANKFURTER_ADAPTER_VERSION,

  async fetch(http: HttpClient, req: FrankfurterRequest = {}): Promise<RawRecord> {
    const request: HttpRequest = {
      providerId: 'frankfurter',
      url: frankfurterUrl(req),
      cacheTtlMs: req.cacheTtlMs ?? FRANKFURTER_CACHE_TTL_MS,
    };
    if (req.traceId !== undefined) request.traceId = req.traceId;
    if (req.runId !== undefined) request.runId = req.runId;
    if (req.budgetShare !== undefined) request.budgetShare = req.budgetShare;
    if (req.captureIndex !== undefined) request.captureIndex = req.captureIndex;
    return http.get(request);
  },

  normalise(raw: RawRecord, ctx: NormaliseContext): Normalised<FrankfurterRows> {
    const parsed = parseFrankfurter({ body: raw.body, url: raw.url });
    if (!parsed.ok) {
      return { updates: [], rows: emptyRows(), sourceTs: null, problems: [...parsed.problems] };
    }

    const problems: NormaliseProblem[] = [...parsed.problems];
    const sourceTs = new Date(parsed.sourceTsMs);
    const sourceTsIso = sourceTs.toISOString();
    const captureTs = new Date(ctx.capturedAt).toISOString();
    const rows = emptyRows();

    // Both directions, so a cross-rate query needs no conditional logic (§5.7).
    for (const rate of parsed.rates) {
      rows.fxRates.push({
        baseCcy: EXPECTED_BASE,
        quoteCcy: rate.currency,
        rateDate: parsed.date,
        rate: rate.quotePerUsd,
        sourceId: 'frankfurter',
      });
      rows.fxRates.push({
        baseCcy: rate.currency,
        quoteCcy: EXPECTED_BASE,
        rateDate: parsed.date,
        rate: rate.usdPerQuote,
        sourceId: 'frankfurter',
      });
    }

    const updates: NormalisedUpdate[] = [];
    const prov = { sourceId: 'frankfurter', provenanceId: ctx.provenanceId };

    for (const [providerSymbol, line] of ctx.lines) {
      const tier: Tier = line.tier;
      const ts = { src: parsed.sourceTsMs, cap: ctx.capturedAt, pub: ctx.capturedAt };

      if (providerSymbol === REFERENCE_LINE_SYMBOL) {
        // The reference line carries no price — §5.7 gives it `line_kind 'reference'`. The update
        // exists so `ts.cap` advances and `staleness.ts` can say "three fixings missed".
        updates.push({
          subject: `q:${line.instrumentId}`,
          instrumentId: line.instrumentId,
          mdLineId: line.mdLineId,
          assetClass: line.assetClass,
          tier,
          fields: {},
          ts,
          prov,
        });
        continue;
      }

      const pair = pairForLine(providerSymbol);
      if (pair === null) {
        problems.push({
          kind: 'unknown_symbol',
          detail: `md line provider_symbol '${providerSymbol}' is neither the reference line nor a currency pair`,
        });
        continue;
      }
      const rate = crossRate(parsed, pair.base, pair.quote);
      if (rate === null) {
        problems.push({
          kind: 'field_dropped',
          detail: `the fixing carries no rate for ${pair.base}/${pair.quote}`,
          path: `/rates/${pair.quote}`,
        });
        continue;
      }

      updates.push({
        subject: `q:${line.instrumentId}`,
        instrumentId: line.instrumentId,
        mdLineId: line.mdLineId,
        assetClass: line.assetClass,
        tier,
        // §5.7: the `q:` line for an fx instrument is Yahoo's; frankfurter supplies only the
        // official close, and never `PX_LAST`.
        fields: { PX_OFFICIAL_CLOSE: rate },
        ts,
        prov,
      });

      rows.barsDaily.push({
        instrumentId: line.instrumentId,
        sessionDate: parsed.date,
        mdLineId: line.mdLineId,
        open: null,
        high: null,
        low: null,
        close: rate,
        volume: null,
        sourceTs: sourceTsIso,
        captureTs,
      });
    }

    return { updates, rows, sourceTs, problems };
  },
};

export function registerFrankfurterAdapter(registry: ProviderRegistry): ProviderRegistry {
  registry.register(frankfurterAdapter);
  return registry;
}
