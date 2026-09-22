/**
 * The four Cboe adapters — PROVIDERS.a §5.1-§5.4.
 *
 * This is the impure half of the fetch/normalise split (§1.2): it builds URLs, names the provider
 * and hands the request to `providers/http.ts`. It parses nothing, writes nothing, and reads no
 * environment — `providerDefaults('cboe.*')` in `http.ts` already owns the headers
 * (`Accept: application/json`, `Accept-Encoding: gzip`), the 4 req/s bucket shared by all four
 * adapters, the `If-None-Match` revalidation and the 6-hour TTL on the symbol book, so an adapter
 * that set any of them here would be overriding the one place they are configured.
 *
 * All four cite a `ProviderId` that **is** their `licence_registry.source_id` (DATA-09): the ids
 * `cboe.quotes`, `cboe.options`, `cboe.symbolBook` and `cboe.euIndices` are rows 1-4 of
 * `providers/licences.ts`, and `ProviderRegistry.register` refuses an adapter whose source is not
 * there.
 */

import type { HttpClient, HttpRequest, ProviderAdapter, RawRecord } from '../types.js';
import type { ProviderRegistry } from '../registry.js';
import type {
  CboeChainOptions,
  CboeChainRows,
  CboeEuIndexRows,
  CboeQuoteOptions,
  CboeQuoteRows,
  CboeSymbolBookRows,
} from './parse.js';
import { normaliseChain, normaliseEuIndex, normaliseQuote, normaliseSymbolBook } from './parse.js';

/** `provenance.adapter_version` — `'<family>/<semver>'` (§1.4). */
export const CBOE_ADAPTER_VERSION = 'cboe/1.0.0';

/** §5.1 / §5.2 / §5.3 live under one CDN root; §5.4 does not (see {@link CBOE_EU_INDEX_BASE}). */
export const CBOE_DELAYED_QUOTES_BASE = 'https://cdn.cboe.com/api/global/delayed_quotes';

export const CBOE_QUOTES_BASE = `${CBOE_DELAYED_QUOTES_BASE}/quotes`;
export const CBOE_OPTIONS_BASE = `${CBOE_DELAYED_QUOTES_BASE}/options`;
export const CBOE_SYMBOL_BOOK_URL = `${CBOE_DELAYED_QUOTES_BASE}/symbol_book/symbol-book.json`;

/**
 * §5.4's open question: BRIEF §2 gives the European path relative to the Cboe API root without
 * saying whether it sits under `/delayed_quotes/`. The recorded capture settles it — the manifest
 * entry for `cboe-eu-indices` is
 * `https://cdn.cboe.com/api/global/european_indices/index_quotes/BUK100P.json`, which is **not**
 * under `/delayed_quotes/`. This constant is that URL, and the replay store would miss on any
 * other spelling.
 */
export const CBOE_EU_INDEX_BASE = 'https://cdn.cboe.com/api/global/european_indices/index_quotes';

/**
 * A Cboe path segment: the equity ticker (`AAPL`), the underscore index form (`_SPX`, `_VIX`) or
 * a European index code (`BUK100P`). Anything with a slash, a dot or a space would either change
 * the path or silently change the request key, so it is rejected here rather than at the CDN.
 */
const SYMBOL_RE = /^[A-Za-z0-9_^.-]{1,24}$/;

function assertSymbol(symbol: string, what: string): string {
  if (!SYMBOL_RE.test(symbol)) {
    throw new Error(
      `'${symbol}' is not a usable Cboe ${what}; md_lines.provider_symbol stores exactly what ` +
        "goes in the URL ('AAPL', '_SPX', 'BUK100P')",
    );
  }
  return symbol;
}

/** `'AAPL'` → `…/quotes/AAPL.json`; `'_SPX'` → `…/quotes/_SPX.json` (§5.1). */
export function cboeQuoteUrl(providerSymbol: string): string {
  return `${CBOE_QUOTES_BASE}/${assertSymbol(providerSymbol, 'provider symbol')}.json`;
}

/** `'AAPL'` → `…/options/AAPL.json` (§5.2). */
export function cboeOptionsUrl(providerSymbol: string): string {
  return `${CBOE_OPTIONS_BASE}/${assertSymbol(providerSymbol, 'underlying symbol')}.json`;
}

/** `'BUK100P'` → `…/european_indices/index_quotes/BUK100P.json` (§5.4). */
export function cboeEuIndexUrl(indexCode: string): string {
  return `${CBOE_EU_INDEX_BASE}/${assertSymbol(indexCode, 'European index code')}.json`;
}

/** What every Cboe fetch may carry beyond its symbol. */
export interface CboeFetchRequest {
  /** OPS-07 — copied onto `provenance.trace_id`. */
  traceId?: string;
  /** `ingest_runs.run_id` when the scheduler is the caller. */
  runId?: number;
  /** The scheduler may consume at most 70 % of the Cboe bucket (§2.2). */
  budgetShare?: 'scheduler' | 'interactive';
  /** Replay only: walk successive captures of the same request (§3.3). */
  captureIndex?: number;
}

export interface CboeQuoteRequest extends CboeFetchRequest {
  /** `md_lines.provider_symbol`, exactly as it goes in the URL. */
  providerSymbol: string;
}

export interface CboeOptionsRequest extends CboeFetchRequest {
  /** The underlying ticker; `md_lines.provider_symbol` for the `cboe.options` line. */
  providerSymbol: string;
}

export interface CboeEuIndexRequest extends CboeFetchRequest {
  /** The Cboe European index code — `indices.code`, e.g. `'BUK100P'`. */
  indexCode: string;
}

export type CboeSymbolBookRequest = CboeFetchRequest;

/**
 * Assemble the `HttpRequest`. `exactOptionalPropertyTypes` is on, so an absent option is left out
 * rather than set to `undefined` — a property whose value is `undefined` is not the same as an
 * absent one to the client's defaults.
 */
function httpRequest(
  providerId: HttpRequest['providerId'],
  url: string,
  req: CboeFetchRequest,
): HttpRequest {
  return {
    providerId,
    url,
    ...(req.traceId === undefined ? {} : { traceId: req.traceId }),
    ...(req.runId === undefined ? {} : { runId: req.runId }),
    ...(req.budgetShare === undefined ? {} : { budgetShare: req.budgetShare }),
    ...(req.captureIndex === undefined ? {} : { captureIndex: req.captureIndex }),
  };
}

/** §5.1 — delayed top-of-book and session summary. */
export const cboeQuotesAdapter: ProviderAdapter<CboeQuoteRequest, CboeQuoteRows> = {
  id: 'cboe.quotes',
  sourceId: 'cboe.quotes',
  adapterVersion: CBOE_ADAPTER_VERSION,
  fetch(http: HttpClient, req: CboeQuoteRequest): Promise<RawRecord> {
    return http.get(httpRequest('cboe.quotes', cboeQuoteUrl(req.providerSymbol), req));
  },
  normalise: (raw, ctx) => normaliseQuote(raw, ctx, { sourceId: 'cboe.quotes' }),
};

/** §5.2 — the full chain with greeks and IV, plus the underlying quote in the same payload. */
export const cboeOptionsAdapter: ProviderAdapter<CboeOptionsRequest, CboeChainRows> = {
  id: 'cboe.options',
  sourceId: 'cboe.options',
  adapterVersion: CBOE_ADAPTER_VERSION,
  fetch(http: HttpClient, req: CboeOptionsRequest): Promise<RawRecord> {
    return http.get(httpRequest('cboe.options', cboeOptionsUrl(req.providerSymbol), req));
  },
  normalise: (raw, ctx) => normaliseChain(raw, ctx, { sourceId: 'cboe.options' }),
};

/** §5.3 — the 35,618-entry universe. Writes no master rows; feeds `refdata/universe.ts`. */
export const cboeSymbolBookAdapter: ProviderAdapter<CboeSymbolBookRequest, CboeSymbolBookRows> = {
  id: 'cboe.symbolBook',
  sourceId: 'cboe.symbolBook',
  adapterVersion: CBOE_ADAPTER_VERSION,
  fetch(http: HttpClient, req: CboeSymbolBookRequest = {}): Promise<RawRecord> {
    return http.get(httpRequest('cboe.symbolBook', CBOE_SYMBOL_BOOK_URL, req));
  },
  normalise: (raw, ctx) => normaliseSymbolBook(raw, ctx),
};

/** §5.4 — European index quotes. Its own adapter because all three timestamp rules differ. */
export const cboeEuIndicesAdapter: ProviderAdapter<CboeEuIndexRequest, CboeEuIndexRows> = {
  id: 'cboe.euIndices',
  sourceId: 'cboe.euIndices',
  adapterVersion: CBOE_ADAPTER_VERSION,
  fetch(http: HttpClient, req: CboeEuIndexRequest): Promise<RawRecord> {
    return http.get(httpRequest('cboe.euIndices', cboeEuIndexUrl(req.indexCode), req));
  },
  normalise: (raw, ctx) => normaliseEuIndex(raw, ctx, { sourceId: 'cboe.euIndices' }),
};

/**
 * The normalise options an adapter cannot know by itself — the session from
 * `refdata/calendars.ts`, and the subscribed contracts from the plant. The job calls the parser
 * directly with these; `adapter.normalise` is the zero-knowledge path, and it deliberately
 * publishes no `PX_OFFICIAL_CLOSE` (§5.1: intra-session `close` mirrors `current_price`).
 */
export type CboeSessionOptions = CboeQuoteOptions;
export type CboeChainJobOptions = CboeChainOptions;

/** Register all four in `PROVIDER_IDS` order (ARCHITECTURE §12.1). */
export function registerCboeAdapters(registry: ProviderRegistry): ProviderRegistry {
  registry.register(cboeQuotesAdapter);
  registry.register(cboeOptionsAdapter);
  // §5.3: the book is a 2.2 MB daily object with no plant subject — never fetched by the
  // interactive read-through (§2.6).
  registry.register(cboeSymbolBookAdapter, { schedulerOnly: true });
  registry.register(cboeEuIndicesAdapter);
  return registry;
}

/** The four adapters, for a registry built from a list. */
export const CBOE_ADAPTERS = [
  cboeQuotesAdapter,
  cboeOptionsAdapter,
  cboeSymbolBookAdapter,
  cboeEuIndicesAdapter,
] as const;
