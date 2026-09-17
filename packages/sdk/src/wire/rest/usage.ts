/**
 * `wire/rest/usage.ts` — `Rest.Usage.*`: the 4 usage, quota and entitlement routes.
 *
 * Schemas and routes transcribed from API.md §5.13 L766-785 (FUNC-04, API-06, ENTL-05).
 * Owned by WP-01 now, by WP-07 (`server/src/http/routes/usage.ts`) afterwards.
 *
 * Route descriptor shape used by every `wire/rest/*` group (consumed by `client/rest.ts`):
 *   { method, path, params?, query?, body?, response, status, format? }
 */
import { z } from 'zod';

import { AssetClass, FieldClass, Tier } from '../common.js';
import { QuotaUsage } from './auth.js';
import { LicenceSummary } from './fields.js';

/* ------------------------------------------------------------------ schemas */

export const UsageEventKind = z.enum([
  'fn.launch',
  'fn.param',
  'fn.page',
  'fn.export',
  'fn.help',
  'search.select',
  'cmd.parse_error',
  'panel.switch',
  'ws.subscribe',
  'ws.slow',
  'ws.resync',
  'ticket.open',
]);
export type UsageEventKind = z.infer<typeof UsageEventKind>;

/**
 * API.md §5.13 L776-781, verbatim. Server-originated kinds (`fn.launch`, `fn.param`, `fn.page`,
 * `fn.export`, `ws.*`) are written by the server; a client posting them is accepted but flagged
 * `details.clientReported=true`.
 */
export const UsageEvent = z.object({
  ts: z.iso.datetime(),
  kind: UsageEventKind,
  panelId: z.string().optional(),
  code: z.string().optional(),
  paramsHash: z.string().length(64).optional(),
  instrumentId: z.number().int().optional(),
  durationMs: z.number().int().optional(),
  traceId: z.uuid().optional(),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type UsageEvent = z.infer<typeof UsageEvent>;

/** Client-side events, batched every 5 s or 100 events and on `pagehide`. */
export const UsageEventsRequest = z.object({
  events: z.array(UsageEvent).max(100),
});
export type UsageEventsRequest = z.infer<typeof UsageEventsRequest>;

export const QuotaResponse = z.object({
  dailyUniqueInstruments: QuotaUsage,
  monthlyDataPoints: QuotaUsage,
  concurrentSubscriptions: QuotaUsage,
  /** true for `api` sessions (API-06 is advisory for the web client) */
  enforced: z.boolean(),
});
export type QuotaResponse = z.infer<typeof QuotaResponse>;

/** A grant as the evaluator will apply it, so a screen can pre-label denied fields. */
export const EntitlementSummaryGrant = z.object({
  subjectKind: z.enum(['user', 'firm']),
  sourceId: z.string().nullable(),
  assetClass: AssetClass.nullable(),
  fieldClass: FieldClass.nullable(),
  maxTier: Tier,
  usageDisplay: z.boolean(),
  usageExport: z.boolean(),
  usageApi: z.boolean(),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime(),
});
export type EntitlementSummaryGrant = z.infer<typeof EntitlementSummaryGrant>;

export const EntitlementsResponse = z.object({
  defaultTier: Tier,
  grants: z.array(EntitlementSummaryGrant),
  licences: z.array(LicenceSummary),
});
export type EntitlementsResponse = z.infer<typeof EntitlementsResponse>;

/** The roadmap query (ARCHITECTURE §11); `admin`, `dataops` only. */
export const FunctionUsageQuery = z.object({
  days: z.number().int().min(1).max(365).default(30),
});
export type FunctionUsageQuery = z.infer<typeof FunctionUsageQuery>;

export const FunctionUsageRow = z.object({
  code: z.string(),
  launches: z.number().int(),
  users: z.number().int(),
  exports: z.number().int(),
});
export type FunctionUsageRow = z.infer<typeof FunctionUsageRow>;

export const FunctionUsageResponse = z.object({ items: z.array(FunctionUsageRow) });
export type FunctionUsageResponse = z.infer<typeof FunctionUsageResponse>;

/* ------------------------------------------------------------------- routes */

/** The 4 routes of API.md §5.13 (`http/routes/usage.ts`). */
export const Usage = {
  /** `202 Accepted`, no body. */
  Events: {
    method: 'POST',
    path: '/usage/events',
    body: UsageEventsRequest,
    response: z.void(),
    status: 202,
  },
  Quota: {
    method: 'GET',
    path: '/usage/quota',
    response: QuotaResponse,
    status: 200,
  },
  /** What the evaluator will decide, so a screen can pre-label (ENTL-05). */
  Entitlements: {
    method: 'GET',
    path: '/usage/entitlements',
    response: EntitlementsResponse,
    status: 200,
  },
  /** `admin`, `dataops` only. */
  Functions: {
    method: 'GET',
    path: '/usage/functions',
    query: FunctionUsageQuery,
    response: FunctionUsageResponse,
    status: 200,
  },
} as const;
