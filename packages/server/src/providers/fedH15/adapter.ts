/**
 * `fed.h15` — the impure half (PROVIDERS §10.3).
 *
 * The Data Download Program takes one opaque `series=` token per request, which is a hash of the
 * series set chosen in its UI: the recorded capture's token
 * `bf17364827e38702b42a58cf8eaa3f78` is the eleven CMT columns in tenor order, and it is a
 * constant here rather than a configuration value because it *is* the request — changing it
 * changes which columns come back, which changes every golden downstream.
 *
 * The remaining parameters are the shape the endpoint demands, empty ones included: `from=`,
 * `to=` and `lastobs=` must be present and may be empty (an absent `from` returns the whole
 * history, an absent `lastobs` the same), `label=include` is what puts the six-line header block
 * in front of the data, and `layout=seriescolumn` is what puts one series in each column. Drop any
 * of them and the CSV that comes back is a different file with the same name.
 *
 * H.15 publishes at ≈ 16:15 ET for the prior business day; `ingest/jobs/fedRates.ts` picks it up
 * at 08:30 ET the next morning together with the NY Fed rates, so an hour of TTL is free.
 */

import type {
  HttpClient,
  Normalised,
  NormaliseContext,
  ProviderAdapter,
  RawRecord,
} from '../types.js';
import type { ProviderRegistry } from '../registry.js';
import { FED_H15_ADAPTER_VERSION, parseH15 } from './parse.js';
import type { FedH15Rows } from './parse.js';

export const H15_DOWNLOAD_URL = 'https://www.federalreserve.gov/datadownload/Output.aspx';

/** The eleven constant-maturity columns, in tenor order — the token the capture was taken with. */
export const H15_CMT_SERIES_TOKEN = 'bf17364827e38702b42a58cf8eaa3f78';

/** One hour (§10.3): the file changes once a day, at ≈ 16:15 ET. */
export const H15_CACHE_TTL_MS = 60 * 60 * 1000;

export interface FedH15Request {
  /** The Data Download series token. Defaults to the eleven CMT columns. */
  seriesToken?: string;
  /** `YYYY-MM-DD`; empty (the default) returns the full history. */
  from?: string;
  to?: string;
  /** The number of trailing observations; empty (the default) means "all". */
  lastObs?: string;
  cacheTtlMs?: number;
  traceId?: string;
  runId?: number;
}

/**
 * The full Output.aspx URL. The parameters are emitted in the order the endpoint documents; the
 * request key canonicalises them by sorting, so this order is for the reader, not the cache.
 */
export function h15Url(req: FedH15Request = {}): string {
  const params = new URLSearchParams({
    filetype: 'csv',
    from: req.from ?? '',
    label: 'include',
    lastobs: req.lastObs ?? '',
    layout: 'seriescolumn',
    rel: 'H15',
    series: req.seriesToken ?? H15_CMT_SERIES_TOKEN,
    to: req.to ?? '',
  });
  return `${H15_DOWNLOAD_URL}?${params.toString()}`;
}

/** `fed.h15` — constant-maturity Treasury yields, the independent check on the par curve. */
export const fedH15Adapter: ProviderAdapter<FedH15Request, FedH15Rows> = {
  id: 'fed.h15',
  sourceId: 'fed.h15',
  adapterVersion: FED_H15_ADAPTER_VERSION,
  fetch(http: HttpClient, req: FedH15Request = {}): Promise<RawRecord> {
    return http.get({
      providerId: 'fed.h15',
      url: h15Url(req),
      headers: { accept: 'text/csv' },
      cacheTtlMs: req.cacheTtlMs ?? H15_CACHE_TTL_MS,
      ...(req.traceId === undefined ? {} : { traceId: req.traceId }),
      ...(req.runId === undefined ? {} : { runId: req.runId }),
    });
  },
  normalise(raw: RawRecord, ctx: NormaliseContext): Normalised<FedH15Rows> {
    return parseH15(raw, ctx);
  },
};

export function registerFedH15Adapters(registry: ProviderRegistry): ProviderRegistry {
  registry.register(fedH15Adapter);
  return registry;
}
