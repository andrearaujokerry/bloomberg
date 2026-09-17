/**
 * `wire/rest/status.ts` — `Rest.Status.*`: health, status and metrics (OPS-03, OPS-04).
 *
 * Routes and `StatusResponse` transcribed from API.md §5.15 L816-836.
 * Owned by WP-01 now, by WP-08 (`server/src/http/routes/status.ts`, `health.ts`) afterwards.
 *
 * Routes covered (3):
 *   GET /health            (*public*; `503 STARTING` until startup step 8)
 *   GET /status            (any; *public* summary when `PUBLIC_STATUS=1`)
 *   GET /metrics           (Prometheus text, served at the root, not under `/api/v1`)
 *
 * Route descriptor shape: { method, path, params?, query?, body?, response, status, format? };
 * `root: true` marks a path that is NOT prefixed with `/api/v1`.
 */
import { z } from 'zod';

import { SessionState } from '../common.js';

/* ------------------------------------------------------------------ schemas */

export const HealthResponse = z.object({
  status: z.enum(['starting', 'ok', 'degraded']),
  db: z.boolean(),
  plant: z.boolean(),
  scheduler: z.boolean(),
  migrationsPending: z.number().int(),
  uptimeS: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const CircuitState = z.enum(['closed', 'open', 'half_open']);
export type CircuitState = z.infer<typeof CircuitState>;

export const ProviderStatus = z.object({
  sourceId: z.string(),
  circuit: CircuitState,
  lastOkAt: z.iso.datetime().nullable(),
  lastErrorAt: z.iso.datetime().nullable(),
  p95Ms: z.number().nullable(),
  bucketRemaining: z.number(),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

export const Incident = z.object({
  incidentId: z.number().int(),
  component: z.string(),
  severity: z.enum(['info', 'degraded', 'outage']),
  title: z.string(),
  openedAt: z.iso.datetime(),
  updates: z.array(z.object({ ts: z.iso.datetime(), text: z.string() })),
});
export type Incident = z.infer<typeof Incident>;

export const StatusResponse = z.object({
  serverTime: z.iso.datetime(),
  serverVersion: z.string(),
  minClientVersion: z.string(),
  protocol: z.array(z.literal(1)),
  dictionaryVersion: z.string(),
  registryVersion: z.string(),
  providerMode: z.enum(['live', 'record', 'replay']),
  plant: z.object({
    state: z.enum(['ok', 'degraded']),
    subjects: z.number().int(),
    hotSet: z.number().int(),
    applyP99Ms: z.number(),
    publishP99Ms: z.number(),
    conflationFloorMs: z.number().int(),
  }),
  ws: z.object({
    sessions: z.number().int(),
    subscriptions: z.number().int(),
    slowSessions: z.number().int(),
  }),
  providers: z.array(ProviderStatus),
  /** 'NYSE', 'SIFMA', 'FX' */
  sessions: z.array(
    z.object({
      calendarId: z.string(),
      state: SessionState,
      nextChangeAt: z.iso.datetime().nullable(),
    }),
  ),
  scheduler: z.object({
    leader: z.boolean(),
    lagMs: z.number(),
    running: z.array(z.string()),
    lastFailures: z.array(z.object({ jobId: z.string(), at: z.iso.datetime(), code: z.string() })),
  }),
  dq: z.object({ open: z.number().int(), byKind: z.record(z.string(), z.number().int()) }),
  incidents: z.array(Incident),
  /** read by the Playwright budgets (TESTING.md) */
  timings: z.object({
    autocompleteP95Ms: z.number(),
    fnLaunchP95Ms: z.record(z.string(), z.number()),
    historyP95Ms: z.number(),
  }),
});
export type StatusResponse = z.infer<typeof StatusResponse>;

/** Prometheus text exposition format (ARCHITECTURE §11 metric names). */
export const MetricsResponse = z.string();
export type MetricsResponse = z.infer<typeof MetricsResponse>;

/* ------------------------------------------------------------------- routes */

/** The 3 routes of API.md §5.15. */
export const Status = {
  /** *public*; `503 STARTING` until startup step 8 (ARCHITECTURE §12.1). */
  Health: {
    method: 'GET',
    path: '/health',
    response: HealthResponse,
    status: 200,
  },
  /** Any authenticated user; a *public* summary when `PUBLIC_STATUS=1`. */
  Status: {
    method: 'GET',
    path: '/status',
    response: StatusResponse,
    status: 200,
  },
  /**
   * Served at the root (`/metrics`), not under `/api/v1`. *public* on loopback; otherwise
   * `Authorization: Bearer <METRICS_TOKEN>`.
   */
  Metrics: {
    method: 'GET',
    path: '/metrics',
    root: true,
    response: MetricsResponse,
    status: 200,
    format: 'text',
  },
} as const;
