/**
 * `nyfed.rates` — the impure half (PROVIDERS §10.4).
 *
 * Three URL shapes, one adapter:
 *
 *  - `/api/rates/all/latest.json` — all six types in one request. This is what
 *    `ingest/jobs/fedRates.ts` calls daily at 08:30 ET, because six types for one request is the
 *    whole reason the endpoint exists;
 *  - `/api/rates/secured/{sofr|bgcr|tgcr|sofrai}/last/{n}.json`
 *  - `/api/rates/unsecured/{effr|obfr}/last/{n}.json` — n days of one type, used for the seed
 *    back-fill and to pick up revisions (n = 10).
 *
 * `cacheTtlMs 0` with `If-None-Match`: these are fixings, published once a day at ≈ 08:00 ET, and
 * `max_tier` is `realtime` on them — the entitlement evaluator can grant realtime here where it
 * cannot on any exchange source, so the age shown on BTMM must be the age of the fetch, not of a
 * TTL window.
 */

import type {
  HttpClient,
  Normalised,
  NormaliseContext,
  ProviderAdapter,
  RawRecord,
} from '../types.js';
import type { ProviderRegistry } from '../registry.js';
import { NYFED_ADAPTER_VERSION, parseRefRates } from './parse.js';
import type { NyFedRatesRows, RateCode } from './parse.js';

export const NYFED_API_BASE = 'https://markets.newyorkfed.org/api/rates';

/** The API's own grouping: three secured rates, two unsecured, and SOFRAI with the secured set. */
export const RATE_GROUPS: Readonly<Record<RateCode, 'secured' | 'unsecured'>> = {
  SOFR: 'secured',
  BGCR: 'secured',
  TGCR: 'secured',
  SOFRAI: 'secured',
  EFFR: 'unsecured',
  OBFR: 'unsecured',
};

/** `https://markets.newyorkfed.org/api/rates/all/latest.json`. */
export function latestAllUrl(): string {
  return `${NYFED_API_BASE}/all/latest.json`;
}

/** `https://…/api/rates/secured/sofr/last/5.json`. */
export function lastNUrl(code: RateCode, days: number): string {
  const n = Math.trunc(days);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`lastNUrl: 'days' must be a positive integer, got ${String(days)}`);
  }
  return `${NYFED_API_BASE}/${RATE_GROUPS[code]}/${code.toLowerCase()}/last/${String(n)}.json`;
}

export type NyFedRequest =
  | { kind: 'latest'; traceId?: string; runId?: number }
  | { kind: 'last'; code: RateCode; days: number; traceId?: string; runId?: number };

/** `nyfed.rates` — SOFR, EFFR, OBFR, BGCR, TGCR and the SOFR averages/index. */
export const nyFedRatesAdapter: ProviderAdapter<NyFedRequest, NyFedRatesRows> = {
  id: 'nyfed.rates',
  sourceId: 'nyfed.rates',
  adapterVersion: NYFED_ADAPTER_VERSION,
  fetch(http: HttpClient, req: NyFedRequest): Promise<RawRecord> {
    return http.get({
      providerId: 'nyfed.rates',
      url: req.kind === 'latest' ? latestAllUrl() : lastNUrl(req.code, req.days),
      headers: { accept: 'application/json' },
      cacheTtlMs: 0,
      ...(req.traceId === undefined ? {} : { traceId: req.traceId }),
      ...(req.runId === undefined ? {} : { runId: req.runId }),
    });
  },
  normalise(raw: RawRecord, ctx: NormaliseContext): Normalised<NyFedRatesRows> {
    return parseRefRates(raw, ctx);
  },
};

export function registerNyFedAdapters(registry: ProviderRegistry): ProviderRegistry {
  registry.register(nyFedRatesAdapter);
  return registry;
}
