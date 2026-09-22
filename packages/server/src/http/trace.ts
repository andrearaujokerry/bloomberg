/**
 * Trace correlation — API.md §2 L196 ("every response, success or error, carries `x-trace-id`"),
 * OPS-07 (`GET /api/v1/admin/trace/:traceId` joins `provenance`, `access_log` and `usage_events` on
 * this id).
 *
 * Accept a caller-supplied `x-trace-id` when it is a syntactically valid UUID v4 — the web client
 * sends one so a panel can link its own request to the server's log lines — and mint one otherwise.
 * Anything malformed is replaced rather than echoed: the id ends up in a `uuid` column, and echoing
 * arbitrary header bytes into a log line is how log injection starts.
 *
 * Registered directly on the root instance (not via `app.register`), so the hook and the decorator
 * apply to every route in every later-registered plugin without a `fastify-plugin` wrapper. That
 * property is also why the HTTP request metrics live here (ARCHITECTURE §11): a hook added inside
 * `observability/metrics.ts`'s plugin would be encapsulated to `/metrics` itself and would measure
 * nothing but the scrape.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Clock } from '@terminal/core';

import { getMetrics } from '../observability/metrics.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Correlation id for this request; also the `x-trace-id` response header. */
    traceId: string;
    /** `clock.now()` at `onRequest`, for the `http_request_duration_ms` histogram. */
    startedAtMs: number;
  }
}

/** RFC 4122 version 4, variant 1 — the shape `randomUUID()` produces and `uuid` columns accept. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TRACE_HEADER = 'x-trace-id';

/** True when `value` is a UUID v4 and may be adopted as the trace id. */
export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

/** The trace id for a request: the caller's if usable, a fresh v4 otherwise. */
export function resolveTraceId(headerValue: unknown): string {
  return isTraceId(headerValue) ? headerValue.toLowerCase() : randomUUID();
}

/**
 * Install the trace plugin on `app`. Must run before the error handler is used, since the envelope
 * carries `traceId`.
 */
export function registerTrace(app: FastifyInstance): void {
  app.decorateRequest('traceId', '');
  app.decorateRequest('startedAtMs', 0);

  app.addHook('onRequest', (request, reply, done) => {
    const traceId = resolveTraceId(request.headers[TRACE_HEADER]);
    request.traceId = traceId;
    request.startedAtMs = clockOf(request)?.now() ?? Date.now();
    // Set on the reply immediately so the header survives every exit path — handler, error
    // handler, not-found handler and a connection dropped mid-handler.
    void reply.header(TRACE_HEADER, traceId);
    request.log = request.log.child({ traceId });
    done();
  });

  // ARCHITECTURE §11 — one counter and one latency histogram for the HTTP surface.
  app.addHook('onResponse', (request, reply, done) => {
    const clock = clockOf(request);
    const route = clock === undefined ? null : routeLabel(request);
    // An unmatched path creates NO series. A label taken from `request.url` would let any caller
    // mint an unbounded number of series by varying the path, which is how a metrics registry
    // becomes a memory leak — so a 404 on a path the router does not know is simply not counted.
    if (route !== null) {
      const labels = { route, method: request.method, status: String(reply.statusCode) };
      getMetrics()
        .counter('http_requests_total', labels, { help: 'HTTP responses by route and status' })
        .inc();
      getMetrics()
        .histogram(
          'http_request_duration_ms',
          { route, method: request.method },
          { help: 'HTTP request duration in milliseconds' },
        )
        .observe(Math.max(0, (clock?.now() ?? Date.now()) - request.startedAtMs));
    }
    done();
  });
}

/**
 * The app's injected clock, or `undefined`.
 *
 * `registerTrace` is also called on bare `Fastify()` instances by unit tests that want the trace
 * header and the error envelope without a whole application — those have no `deps`, so they get a
 * trace id and no metrics rather than a 500 from the hook that was supposed to observe them.
 */
function clockOf(request: FastifyRequest): Clock | undefined {
  const deps = (request.server as { deps?: { clock?: Clock } }).deps;
  return deps?.clock;
}

/**
 * The Fastify **route pattern** (`/api/v1/ref/:instrumentId`), never the raw URL.
 *
 * `null` when the router matched nothing, so an unmatched path contributes no series at all.
 */
export function routeLabel(request: FastifyRequest): string | null {
  const pattern = request.routeOptions.url;
  return typeof pattern === 'string' && pattern.length > 0 ? pattern : null;
}
