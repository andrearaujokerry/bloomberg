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
 * apply to every route in every later-registered plugin without a `fastify-plugin` wrapper.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Correlation id for this request; also the `x-trace-id` response header. */
    traceId: string;
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

  app.addHook('onRequest', (request, reply, done) => {
    const traceId = resolveTraceId(request.headers[TRACE_HEADER]);
    request.traceId = traceId;
    // Set on the reply immediately so the header survives every exit path — handler, error
    // handler, not-found handler and a connection dropped mid-handler.
    void reply.header(TRACE_HEADER, traceId);
    request.log = request.log.child({ traceId });
    done();
  });
}
