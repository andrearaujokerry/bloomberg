/**
 * `AppError` → `ErrorEnvelope` — API.md §2 (L133-196).
 *
 * The wire types live in `@terminal/sdk` (`wire/envelope.ts`): `ErrorCode`, `ErrorEnvelope`,
 * `ERROR_CODE_STATUS` and `RETRYABLE_ERROR_CODES`. This module is the server half: an error class
 * carrying a code, and the Fastify handlers that turn anything thrown in a route into exactly the
 * documented body. Nothing else in the server may write an error body by hand.
 *
 * Rules that are not negotiable:
 *  - every error body carries the request's `traceId` (API.md L196);
 *  - `retryable` is true only for the four codes in `RETRYABLE_ERROR_CODES`;
 *  - `retryAfterMs` is also emitted as the `Retry-After` header, in seconds (API.md L189);
 *  - an unrecognised throw is `INTERNAL` with a generic message: the original is logged, never sent.
 */

// Imported from the exact module API.md §2 names (`wire/envelope.ts`) rather than through the
// `@terminal/sdk` barrel: the server needs four symbols, and pulling the whole barrel would drag
// the browser-side REST and WS clients into the server's module graph for nothing.
import {
  ERROR_CODE_STATUS,
  RETRYABLE_ERROR_CODES,
  type ErrorCode,
  type ErrorEnvelope,
} from '@terminal/sdk/wire/envelope';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export type ErrorDetails = Record<string, unknown>;

export interface AppErrorOptions {
  /** Machine-readable extras — the `details.*` shapes documented per code in API.md §2. */
  details?: ErrorDetails;
  /** 429/503 only; also sent as `Retry-After` (seconds, rounded up). */
  retryAfterMs?: number;
  /** The underlying failure, logged but never serialised. */
  cause?: unknown;
}

/**
 * The base of the error hierarchy every service and route throws. The HTTP status is derived from
 * the code (`ERROR_CODE_STATUS`), so a code and a status can never disagree.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: ErrorDetails | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CODE_STATUS[code];
    this.retryable = RETRYABLE_ERROR_CODES.includes(code);
    this.details = options.details;
    this.retryAfterMs = options.retryAfterMs;
  }

  /** The exact body of API.md §2 L199-208. */
  toEnvelope(traceId: string): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        traceId,
        retryable: this.retryable,
        ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** 400 — a zod parse failure. `location` says which part of the request failed (API.md L158). */
export class ValidationFailedError extends AppError {
  constructor(
    location: 'body' | 'query' | 'params' | 'fnParams',
    issues: readonly unknown[],
    extra: ErrorDetails = {},
  ) {
    super('VALIDATION_FAILED', 'Request validation failed.', {
      details: { location, issues, ...extra },
    });
    this.name = 'ValidationFailedError';
  }
}

/** 400 — well-formed but unusable (API.md L159). */
export class BadRequestError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super('BAD_REQUEST', message, details === undefined ? {} : { details });
    this.name = 'BadRequestError';
  }
}

/** 401 — no usable session or bearer token. */
export class AuthRequiredError extends AppError {
  constructor(message = 'Authentication required.') {
    super('AUTH_REQUIRED', message);
    this.name = 'AuthRequiredError';
  }
}

/** 403 — role or scope. `details.requiredRole` / `details.requiredScope` (API.md L167). */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden.', details?: ErrorDetails) {
    super('FORBIDDEN', message, details === undefined ? {} : { details });
    this.name = 'ForbiddenError';
  }
}

/**
 * 404. Tenant-isolated rows the caller may not see are `NOT_FOUND`, never 403 — RLS returns zero
 * rows and the server must not disclose that the row exists (API.md L186).
 */
export class NotFoundError extends AppError {
  constructor(
    message = 'Not found.',
    code: Extract<
      ErrorCode,
      'NOT_FOUND' | 'SECURITY_NOT_FOUND' | 'FUNCTION_NOT_FOUND' | 'FIELD_UNKNOWN' | 'RESULT_EXPIRED'
    > = 'NOT_FOUND',
    details?: ErrorDetails,
  ) {
    super(code, message, details === undefined ? {} : { details });
    this.name = 'NotFoundError';
  }
}

/** 409. */
export class ConflictError extends AppError {
  constructor(
    code: Extract<
      ErrorCode,
      'AMBIGUOUS_SECURITY' | 'WORKSPACE_VERSION_CONFLICT' | 'DUPLICATE_NAME'
    >,
    message: string,
    details?: ErrorDetails,
  ) {
    super(code, message, details === undefined ? {} : { details });
    this.name = 'ConflictError';
  }
}

/**
 * 503 — a provider could not be reached and nothing usable is stored (API.md §2, retryable).
 *
 * Raised by `functions/context.ts#readThrough` when the circuit is open, the fetch failed or the
 * source is scheduler-only **and** the store holds nothing for the resource. When the store holds
 * something stale the read-through returns it labelled `fresh: false` instead, because a stale
 * number with an honest age beats a 503 on a screen that only needed a reference read.
 */
export class ProviderUnavailableError extends AppError {
  constructor(message: string, options: { retryAfterMs?: number; cause?: unknown } = {}) {
    super('PROVIDER_UNAVAILABLE', message, {
      retryAfterMs: options.retryAfterMs ?? 5_000,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'ProviderUnavailableError';
  }
}

/** 503 — the process has not finished ARCHITECTURE §12.1 step 8 yet. Retryable. */
export class StartingError extends AppError {
  constructor(retryAfterMs = 2_000) {
    super('STARTING', 'Server is starting.', { retryAfterMs });
    this.name = 'StartingError';
  }
}

/**
 * Not an `AppError`: a module that WP-01 scaffolded but did not implement. It maps to `INTERNAL`
 * on the wire (there is no `NOT_IMPLEMENTED` wire code) while keeping the reason greppable in logs
 * and in tests that assert the scaffold is still a scaffold.
 */
export class NotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED' as const;

  constructor(what: string) {
    super(`NOT_IMPLEMENTED: ${what}`);
    this.name = 'NotImplementedError';
  }
}

interface FastifyValidationError extends Error {
  validation?: unknown[];
  validationContext?: string;
  statusCode?: number;
}

function isFastifyValidationError(err: unknown): err is FastifyValidationError {
  return err instanceof Error && Array.isArray((err as FastifyValidationError).validation);
}

const VALIDATION_LOCATIONS = new Set(['body', 'query', 'params']);

/** Map anything thrown in a route to the `AppError` that describes it. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof z.ZodError) {
    return new ValidationFailedError('body', err.issues);
  }

  if (isFastifyValidationError(err)) {
    const ctx = err.validationContext ?? 'body';
    const location = VALIDATION_LOCATIONS.has(ctx) ? (ctx as 'body' | 'query' | 'params') : 'body';
    return new ValidationFailedError(location, err.validation ?? []);
  }

  // Fastify's own 4xx (bad JSON, unsupported media type, payload too large) arrive as errors with
  // a statusCode; keep the status honest instead of reporting 500.
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const message = err instanceof Error ? err.message : 'Bad request.';
    return new BadRequestError(message, { cause: err });
  }

  return new AppError('INTERNAL', 'Internal server error.', { cause: err });
}

/** Write an `AppError` to a reply as the documented envelope. */
export function sendError(request: FastifyRequest, reply: FastifyReply, error: AppError): void {
  if (error.retryAfterMs !== undefined) {
    void reply.header('Retry-After', String(Math.ceil(error.retryAfterMs / 1_000)));
  }
  void reply.status(error.status).type('application/json; charset=utf-8');
  void reply.send(error.toEnvelope(request.traceId));
}

/**
 * Install the error and not-found handlers on the root instance. Registered directly (not through
 * `app.register`) so that they cover every route in every later-registered plugin.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    const appError = toAppError(err);
    const payload = {
      err,
      code: appError.code,
      status: appError.status,
      traceId: request.traceId,
      method: request.method,
      url: request.url,
    };
    // 5xx is a defect; 4xx is the client's problem and must not page anyone.
    if (appError.status >= 500) request.log.error(payload, appError.message);
    else request.log.warn(payload, appError.message);
    sendError(request, reply, appError);
  });

  app.setNotFoundHandler((request, reply) => {
    sendError(
      request,
      reply,
      new NotFoundError(`No route for ${request.method} ${request.url}.`, 'NOT_FOUND'),
    );
  });
}
