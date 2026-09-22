/**
 * `providers/http.ts` — the one gate every provider request passes through (PROVIDERS.a §2,
 * WORKPLAN WP-05).
 *
 * One instance per process, injected into every adapter. It owns, in this order:
 *
 *  1. **the mode switch** (§2.1) — `replay | record | live`. `replay` is the default and is a
 *     *wall*: the transport is a stub that throws, the replay store answers or `ReplayMissError`
 *     is raised. No test can reach the network by forgetting an environment variable (QA-02).
 *  2. **a token bucket per `ProviderId`** (§2.2) with the real published limits, of which the
 *     scheduler may consume at most 70 % so an analyst hitting `GO` is never starved by a backfill.
 *  3. **the conditional-request / TTL cache** (§2.4) — `If-None-Match`, `If-Modified-Since`, and a
 *     per-source TTL that answers without a request at all.
 *  4. **retry with jittered exponential backoff** (§2.3) — three attempts, only on the retryable
 *     statuses, and *no* retries in replay mode.
 *  5. **a circuit breaker per `ProviderId`** (§2.5) — five consecutive failures open it, it
 *     half-opens 60 s later and lets exactly one probe through, and opening writes a `dq_events`
 *     row of kind `provider_circuit_open` and marks every `md_lines` row of that source
 *     `PROVIDER_DOWN`.
 *
 * **Every clock reading is `Clock.now()`**, so the whole of the above is driven by a `VirtualClock`
 * in `test/unit/providers/http.test.ts` and no test waits on a real timer. The one deliberate
 * exception is the socket timeout inside {@link undiciTransport}: a real network read is bounded by
 * the platform timer because that is the thing being bounded. A test injects its own `Transport`
 * and never reaches it.
 *
 * This module reads no environment (`config.ts` is the only reader) and opens no database
 * connection of its own: the breaker's database side effect is {@link databaseBreakerSink}, which
 * goes through `db/client.ts#withTx` and is installed by {@link createHttpClient}. The class
 * default is a sink that only remembers, so unit tests need no database.
 */

import { randomInt } from 'node:crypto';

import { sha256Hex, SystemClock, type Clock } from '@terminal/core';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { getConfig, type Config } from '../config.js';
import type { ProviderMode } from '../config.js';
import { withTx } from '../db/client.js';
import { dqEvents, schemaMeta } from '../db/schema/ops.js';
import { mdLines } from '../db/schema/reference.js';
import { canonicalUrl, openReplayStore, requestHash, requestKey } from './replayStore.js';
import type { ReplayStore } from './replayStore.js';
import type {
  BreakerState,
  BucketState,
  HttpClient,
  HttpMethod,
  HttpRequest,
  ProviderId,
  RawRecord,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Errors (PROVIDERS.a §2, L250-256)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A provider answered, and the answer is not usable. Counts toward the breaker (see §2.5). */
export class ProviderHttpError extends Error {
  constructor(
    readonly providerId: ProviderId,
    readonly status: number,
    readonly url: string,
    readonly requestKey: string,
    readonly bodyPreview: string,
  ) {
    super(`${providerId} ${url} → HTTP ${status}: ${bodyPreview}`);
    this.name = 'ProviderHttpError';
  }
}

/** The socket produced no answer inside the per-provider timeout. Retryable, counts as a failure. */
export class ProviderTimeoutError extends Error {
  constructor(
    readonly providerId: ProviderId,
    readonly url: string,
    readonly timeoutMs: number,
    override readonly cause?: unknown,
  ) {
    super(`${providerId} ${url} timed out after ${timeoutMs} ms`);
    this.name = 'ProviderTimeoutError';
  }
}

/** The breaker is open (or a half-open probe is already in flight). No token is consumed. */
export class CircuitOpenError extends Error {
  constructor(
    readonly providerId: ProviderId,
    readonly openedAt: number,
    readonly retryAtMs: number,
  ) {
    super(
      `circuit for '${providerId}' is open (opened at ${new Date(openedAt).toISOString()}, ` +
        `next probe at ${new Date(retryAtMs).toISOString()}) — PROVIDERS.a §2.5`,
    );
    this.name = 'CircuitOpenError';
  }
}

/**
 * The token bucket could not produce a token inside {@link HttpClientOptions.maxWaitMs}.
 *
 * **Addition to PROVIDERS.a §2.2 (§18).** The document says a request that would breach the
 * interactive reserve is "refused"; refusing it *immediately* would make every scheduler job fail
 * the moment a bucket runs dry, so the client waits for the refill and only gives up when the wait
 * would exceed the ceiling. That distinction is the difference between a paced backfill and a
 * failing one — and unlike a silent wait, the ceiling is observable.
 */
export class RateLimitError extends Error {
  constructor(
    readonly providerId: ProviderId,
    readonly waitMs: number,
    readonly maxWaitMs: number,
    readonly budgetShare: BudgetShare,
  ) {
    super(
      `${providerId}: a ${budgetShare} request would wait ${waitMs} ms for a token, over the ` +
        `${maxWaitMs} ms ceiling (PROVIDERS.a §2.2)`,
    );
    this.name = 'RateLimitError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type BudgetShare = 'scheduler' | 'interactive';

/** §2.2: the scheduler may consume at most 70 % of any bucket; 30 % is the interactive reserve. */
export const SCHEDULER_BUDGET_SHARE = 0.7;

/** §2.3: three attempts, then the failure is real. */
export const MAX_ATTEMPTS = 3;

/** §2.3: the backoff is capped before the jitter is applied. */
export const MAX_BACKOFF_MS = 30_000;

/** §2.3: `Retry-After` overrides the computed delay only when it is smaller than this. */
export const MAX_RETRY_AFTER_MS = 30_000;

/** §2.5: five consecutive failures open the breaker. */
export const BREAKER_FAILURE_THRESHOLD = 5;

/** §2.5: an open breaker half-opens this long after it opened, and lets one probe through. */
export const BREAKER_HALF_OPEN_MS = 60_000;

/**
 * §2.2: Yahoo, SSGA and the RSS hosts serve an unfamiliar agent an empty body or an HTML error
 * page. This exact string is what the 2026-09-15 captures were recorded with.
 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * §2.2: `SEC_USER_AGENT` must be a descriptive string carrying a contact email — the SEC fair-access
 * policy. `config.ts` only requires it to be non-empty (it is `min(1)` there, and that file is
 * WP-01's); the shape is enforced here, at the point where the header is actually sent, and only in
 * `live`/`record` mode so that a replayed test needs no real contact address.
 */
export const SEC_USER_AGENT_RE = /^.+\s+\S+@\S+\.\S+$/;

/** §2.2: the keyless OpenFIGI tier maps 10 jobs per request; a key raises it to 100. */
export function openfigiJobsPerRequest(config: Config): number {
  return config.OPENFIGI_API_KEY === undefined ? 10 : 100;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Per-provider defaults (PROVIDERS.a §2.2, the real limits)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ProviderDefaults {
  /** Burst size, in tokens. */
  readonly capacity: number;
  /** Sustained rate, tokens per second. */
  readonly refillPerSec: number;
  /** Socket timeout for one attempt. */
  readonly timeoutMs: number;
  /** Merged under the caller's headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** A bucket whose window is a day is persisted, so a crash loop cannot breach the quota. */
  readonly daily: boolean;
}

/** `'sec.tickers'` → `'sec'`; `'frankfurter'` → `'frankfurter'`. */
function family(providerId: ProviderId): string {
  const dot = providerId.indexOf('.');
  return dot === -1 ? providerId : providerId.slice(0, dot);
}

/**
 * The §2.2 table, verbatim. A bucket is per `ProviderId` family, not per host: `query1` and
 * `query2` share Yahoo's budget and all four Cboe adapters share Cboe's.
 */
export function providerDefaults(providerId: ProviderId, config: Config): ProviderDefaults {
  switch (family(providerId)) {
    case 'openfigi': {
      // Keyless: 25 requests/minute. With a key the bucket is raised by config, not by code.
      const apiKey = config.OPENFIGI_API_KEY;
      const keyed = apiKey !== undefined;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      };
      if (apiKey !== undefined) headers['x-openfigi-apikey'] = apiKey;
      return {
        capacity: 25,
        refillPerSec: keyed ? 25 / 6 : 25 / 60,
        timeoutMs: 10_000,
        headers,
        daily: false,
      };
    }
    case 'sec':
      return {
        capacity: 10,
        refillPerSec: 10,
        timeoutMs: 20_000,
        headers: {
          'user-agent': config.SEC_USER_AGENT,
          'accept-encoding': 'gzip, deflate',
        },
        daily: false,
      };
    case 'cboe':
      return {
        capacity: 8,
        refillPerSec: 4,
        timeoutMs: 10_000,
        headers: { accept: 'application/json', 'accept-encoding': 'gzip' },
        daily: false,
      };
    case 'yahoo':
      return {
        capacity: 4,
        refillPerSec: 2,
        timeoutMs: 15_000,
        headers: { 'user-agent': BROWSER_USER_AGENT, accept: 'application/json' },
        daily: false,
      };
    case 'frankfurter':
      return {
        capacity: 2,
        refillPerSec: 1,
        timeoutMs: 10_000,
        headers: { accept: 'application/json' },
        daily: false,
      };
    case 'coingecko':
      return {
        capacity: 2,
        refillPerSec: 1,
        timeoutMs: 10_000,
        headers: { accept: 'application/json' },
        daily: false,
      };
    case 'fred':
      return { capacity: 2, refillPerSec: 1, timeoutMs: 20_000, headers: {}, daily: false };
    case 'bls':
      // 25 requests/day on the keyless tier — the bucket is persisted in `schema_meta` so a
      // restart does not reset it (§2.2). A crash loop is the likeliest way to breach a daily quota.
      return {
        capacity: 25,
        refillPerSec: 25 / 86_400,
        timeoutMs: 20_000,
        headers: { 'content-type': 'application/json' },
        daily: true,
      };
    case 'treasury':
      // The yield-curve XML takes ≈ 18 s, so 45 s is the timeout and the bucket is 1/minute.
      // Scheduler-only (§2.6): the read-through never fetches it.
      return { capacity: 1, refillPerSec: 1 / 60, timeoutMs: 45_000, headers: {}, daily: false };
    case 'ssga':
    case 'bbg':
      // §14/§16.5: the SSGA and Bloomberg CDNs serve HTML (or nothing) to an unfamiliar agent.
      // The §2.2 "everything else" row for the bucket, plus the browser UA the captures carry.
      return {
        capacity: 2,
        refillPerSec: 1,
        timeoutMs: 20_000,
        headers: { 'user-agent': BROWSER_USER_AGENT },
        daily: false,
      };
    default:
      return { capacity: 2, refillPerSec: 1, timeoutMs: 20_000, headers: {}, daily: false };
  }
}

/**
 * §2.4 "TTLs in use". A request that names its own `cacheTtlMs` wins — `yahoo.chart` is `0` for a
 * `1m`/`5m` range and 6 h for `range=max`, which only the adapter knows.
 */
export function defaultCacheTtlMs(providerId: ProviderId): number {
  switch (providerId) {
    case 'cboe.symbolBook':
      return 6 * 60 * 60 * 1000;
    case 'yahoo.search':
      return 5 * 60 * 1000;
    case 'frankfurter':
      return 60 * 60 * 1000;
    case 'coingecko.simple':
      return 30 * 1000;
    default:
      return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Backoff (PROVIDERS.a §2.3)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `delayMs = min(30_000, 500 * 2 ** (n - 1)) * (0.5 + rng())`, rounded to whole milliseconds.
 *
 * Pure, and exported, because the sequence is an acceptance row: with `rng = () => 0.5` the delays
 * after attempts 1, 2 and 3 are exactly 500, 1000 and 2000 ms.
 *
 * @param attempt 1-based attempt number that just failed.
 * @param rng uniform in `[0, 1)`.
 */
export function backoffDelayMs(attempt: number, rng: () => number): number {
  const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1));
  return Math.round(base * (0.5 + rng()));
}

/** §2.3: retried statuses. Any other `4xx` is terminal — a `404` is a data matter, not a network one. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * Whether a terminal HTTP status counts toward the breaker (§2.5 reads "five consecutive
 * failures"; §2.3 says a `404` is a `NormaliseProblem` matter).
 *
 * A `404`/`400`/`410` is the provider answering correctly about a symbol that does not exist, and
 * opening the circuit on it would take a whole source down because one ticker was delisted. A
 * `401`/`403`/`429`/`5xx`/timeout is the provider refusing *us*, which is exactly what the breaker
 * is for.
 */
export function countsAsProviderFailure(status: number): boolean {
  if (status === 401 || status === 403) return true;
  return isRetryableStatus(status);
}

/** `Retry-After`: delta-seconds or an HTTP date. `null` when absent or unparseable. */
export function parseRetryAfterMs(value: string | undefined, nowMs: number): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface TransportRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly timeoutMs: number;
}

export interface TransportResponse {
  readonly status: number;
  /** Header names lower-cased; repeated headers joined with `', '`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

/** The socket. Injected, so a test never has one. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** Thrown by a transport that could not complete the exchange; retryable per §2.3. */
export class TransportError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ETIMEDOUT',
  'ABORT_ERR',
]);

function isTimeoutError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && TIMEOUT_CODES.has(code)) return true;
  return (err as { name?: unknown }).name === 'TimeoutError';
}

function lowerCaseHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * The real transport, over undici. `headersTimeout`/`bodyTimeout` are the platform timers that
 * bound a real socket — the only wall-clock reading in this module, and unreachable from a test,
 * which injects its own transport.
 */
export function undiciTransport(maxRedirects = 3): Transport {
  return async (req: TransportRequest): Promise<TransportResponse> => {
    const { request } = await import('undici');
    let url = req.url;
    let method = req.method;
    let body = req.body;
    for (let hop = 0; ; hop += 1) {
      let status: number;
      let headers: Record<string, string>;
      let bytes: Buffer;
      try {
        const res = await request(url, {
          method,
          headers: { ...req.headers },
          ...(body === undefined ? {} : { body }),
          headersTimeout: req.timeoutMs,
          bodyTimeout: req.timeoutMs,
        });
        status = res.statusCode;
        headers = lowerCaseHeaders(res.headers);
        bytes = Buffer.from(await res.body.arrayBuffer());
      } catch (err) {
        if (isTimeoutError(err)) throw err;
        throw new TransportError(`${method} ${url}: ${(err as Error).message}`, err);
      }

      // Redirects are followed here rather than by the dispatcher so that the record the client
      // returns carries the *final* URL — `canonicalUrl` of the redirect target is what the
      // request key and `provenance.request_url` must name (PROVIDERS.a §1.1).
      const location = headers.location;
      const redirected =
        status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
      if (!redirected || location === undefined || hop >= maxRedirects) {
        return { status, headers, body: bytes };
      }
      url = new URL(location, url).toString();
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
    }
  };
}

/**
 * §2.1: in `replay` mode no transport is constructed at all. This stub is what stands in its place,
 * so that a code path which somehow escapes the replay lookup fails loudly instead of quietly
 * dialling out of a CI box.
 */
export function replayWallTransport(): Transport {
  return (req: TransportRequest): Promise<TransportResponse> =>
    Promise.reject(
      new Error(
        `PROVIDER_MODE=replay: refusing to open a socket for ${req.method} ${req.url}. ` +
          'A replay miss is a missing fixture, not a reason to go to the network (PROVIDERS.a §2.1).',
      ),
    );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Sleeper — the only way this module waits
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Waiting, injected. `SystemSleeper` is a real timer; a test passes one that advances its
 * `VirtualClock` instead, so the backoff sequence and a 60 s half-open window cost no wall time.
 */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export const systemSleeper: Sleeper = {
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Token bucket (PROVIDERS.a §2.2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Floating-point slack, so 0.30000000000000004 never refuses a request that is exactly at the floor. */
const EPSILON = 1e-9;

export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSec: number;
  readonly daily: boolean;
  #available: number;
  #lastRefillMs: number;

  constructor(defaults: ProviderDefaults, nowMs: number) {
    this.capacity = defaults.capacity;
    this.refillPerSec = defaults.refillPerSec;
    this.daily = defaults.daily;
    this.#available = defaults.capacity;
    this.#lastRefillMs = nowMs;
  }

  /** Tokens available as of `nowMs`. */
  available(nowMs: number): number {
    this.#refill(nowMs);
    return this.#available;
  }

  /** Persisted daily state (§2.2) — restored across restarts. */
  restore(available: number, atMs: number): void {
    this.#available = Math.max(0, Math.min(this.capacity, available));
    this.#lastRefillMs = atMs;
  }

  snapshot(nowMs: number): { available: number; atMs: number } {
    this.#refill(nowMs);
    return { available: this.#available, atMs: this.#lastRefillMs };
  }

  /**
   * The floor a `budgetShare` may not cross. The scheduler leaves 30 % of the capacity for
   * interactive read-through calls (§2.2) — *except* on a one-token bucket, which cannot be split:
   * `treasury.*` has capacity 1 and is scheduler-only by registration, so reserving its single
   * token for an interactive caller that is forbidden to use it would simply stop the job forever.
   */
  floorFor(share: BudgetShare): number {
    if (share === 'interactive' || this.capacity < 2) return 0;
    return this.capacity * (1 - SCHEDULER_BUDGET_SHARE);
  }

  /** Take one token if the share allows it. */
  tryTake(nowMs: number, share: BudgetShare): boolean {
    this.#refill(nowMs);
    if (this.#available - 1 + EPSILON < this.floorFor(share)) return false;
    this.#available -= 1;
    return true;
  }

  /** Milliseconds until `tryTake` would succeed. `0` means it would succeed now. */
  waitMs(nowMs: number, share: BudgetShare): number {
    this.#refill(nowMs);
    const needed = 1 + this.floorFor(share) - this.#available;
    if (needed <= EPSILON) return 0;
    if (this.refillPerSec <= 0) return Number.POSITIVE_INFINITY;
    return Math.ceil((needed / this.refillPerSec) * 1000);
  }

  #refill(nowMs: number): void {
    if (nowMs <= this.#lastRefillMs) return;
    const elapsedSec = (nowMs - this.#lastRefillMs) / 1000;
    this.#available = Math.min(this.capacity, this.#available + elapsedSec * this.refillPerSec);
    this.#lastRefillMs = nowMs;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Circuit breaker (PROVIDERS.a §2.5)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What the breaker publishes when it opens — `dq_events.details` plus the routing keys. */
export interface CircuitOpenEvent {
  readonly providerId: ProviderId;
  readonly openedAt: number;
  readonly consecutiveFailures: number;
  readonly lastStatus: number | null;
  readonly lastUrl: string;
  /** `openedAt + 60_000`: when the half-open probe is allowed. */
  readonly retryAtMs: number;
}

/**
 * The side effect of an opening. Returns the `md_lines` ids that are now `PROVIDER_DOWN`, which
 * the client remembers (`downMdLines`) so the plant can stamp `QuoteState.dq` (TERM-12, BUS-08).
 */
export interface BreakerSink {
  circuitOpened(event: CircuitOpenEvent): Promise<readonly number[]> | readonly number[];
  circuitClosed(providerId: ProviderId, closedAtMs: number): Promise<void> | void;
}

/** The class default: remembers nothing but the call. Unit tests need no database. */
export const noopBreakerSink: BreakerSink = {
  circuitOpened: () => [],
  circuitClosed: () => undefined,
};

/**
 * §2.5 steps 2 and 3, in the database: one `dq_events` row per opening, and the current `md_lines`
 * of that source, which are what the plant marks `PROVIDER_DOWN`. Closing resolves the open row.
 *
 * Installed by {@link createHttpClient}; it runs on `db/client.ts#withTx(null, …)` — an ingest-side
 * transaction with no `app.*` context, exactly like a job.
 */
export function databaseBreakerSink(): BreakerSink {
  return {
    async circuitOpened(event: CircuitOpenEvent): Promise<readonly number[]> {
      return withTx(null, async (tx) => {
        await tx.insert(dqEvents).values({
          kind: 'provider_circuit_open',
          severity: 'error',
          sourceId: event.providerId,
          details: {
            consecutiveFailures: event.consecutiveFailures,
            lastStatus: event.lastStatus,
            lastUrl: event.lastUrl,
            openedAt: new Date(event.openedAt).toISOString(),
          },
        });
        const rows = await tx
          .selectDistinct({ mdLineId: mdLines.mdLineId })
          .from(mdLines)
          .where(
            and(
              eq(mdLines.sourceId, event.providerId),
              sql`${mdLines.txTo} = 'infinity'`,
              sql`${mdLines.validTo} = 'infinity'`,
            ),
          );
        return rows.map((row) => Number(row.mdLineId));
      });
    },
    async circuitClosed(providerId: ProviderId): Promise<void> {
      await withTx(null, async (tx) => {
        await tx
          .update(dqEvents)
          .set({ resolvedAt: sql`now()` })
          .where(
            and(
              eq(dqEvents.kind, 'provider_circuit_open'),
              eq(dqEvents.sourceId, providerId),
              isNull(dqEvents.resolvedAt),
            ),
          );
      });
    },
  };
}

interface Breaker {
  state: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  openedAt: number | null;
  probeInFlight: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Daily-bucket persistence (PROVIDERS.a §2.2, `bls.*`)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface BucketPersistence {
  load(providerId: ProviderId): Promise<{ available: number; atMs: number } | null>;
  save(providerId: ProviderId, state: { available: number; atMs: number }): Promise<void>;
}

/** `schema_meta['provider_bucket:<id>'] = {"available":n,"atMs":ms}` — survives a restart. */
export function schemaMetaBucketPersistence(): BucketPersistence {
  const key = (providerId: ProviderId): string => `provider_bucket:${providerId}`;
  return {
    async load(providerId: ProviderId): Promise<{ available: number; atMs: number } | null> {
      return withTx(null, async (tx) => {
        const rows = await tx
          .select({ value: schemaMeta.value })
          .from(schemaMeta)
          .where(eq(schemaMeta.key, key(providerId)));
        const row = rows[0];
        if (row === undefined) return null;
        try {
          const parsed: unknown = JSON.parse(row.value);
          if (typeof parsed !== 'object' || parsed === null) return null;
          const { available, atMs } = parsed as { available?: unknown; atMs?: unknown };
          if (typeof available !== 'number' || typeof atMs !== 'number') return null;
          return { available, atMs };
        } catch {
          return null;
        }
      });
    },
    async save(providerId: ProviderId, state: { available: number; atMs: number }): Promise<void> {
      await withTx(null, async (tx) => {
        await tx
          .insert(schemaMeta)
          .values({ key: key(providerId), value: JSON.stringify(state) })
          .onConflictDoUpdate({
            target: schemaMeta.key,
            set: { value: JSON.stringify(state), updatedAt: sql`now()` },
          });
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The client
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `requestKey` → the last body we hold for it, and what it can be revalidated with (§2.4). */
interface CacheEntry {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  sha256: string;
  etag: string | undefined;
  lastModified: string | undefined;
  /** The instant the *bytes* were fetched — FEED-05 `cap`, which a 304 deliberately does not advance. */
  capturedAtMs: number;
  /** The instant the entry was last known fresh — what the TTL is measured from. */
  validatedAtMs: number;
  sourceTs: Date | null;
}

export interface HttpClientOptions {
  config?: Config;
  clock?: Clock;
  sleeper?: Sleeper;
  transport?: Transport;
  store?: ReplayStore;
  /** Uniform in `[0, 1)`; crypto-seeded in `live`/`record`, fixed in tests (§2.3). */
  rng?: () => number;
  breakerSink?: BreakerSink;
  persistence?: BucketPersistence;
  /** Ceiling on how long a request may wait for a token before {@link RateLimitError}. */
  maxWaitMs?: number;
  /** Side-effect failures (a sink, a persistence write) are reported here, never thrown at the caller. */
  onError?: (err: unknown, context: string) => void;
}

/** 32 bits of crypto randomness, uniform in `[0, 1)` — the `live`/`record` jitter source. */
function cryptoRng(): number {
  return randomInt(0, 2 ** 32) / 2 ** 32;
}

/**
 * The shared client. Construct one per process (`createHttpClient`), or one per test with an
 * injected clock, sleeper and transport.
 */
export class ProviderHttpClient implements HttpClient {
  readonly mode: ProviderMode;
  readonly #config: Config;
  readonly #clock: Clock;
  readonly #sleeper: Sleeper;
  readonly #transport: Transport;
  readonly #rng: () => number;
  readonly #sink: BreakerSink;
  readonly #persistence: BucketPersistence | undefined;
  readonly #maxWaitMs: number;
  readonly #onError: (err: unknown, context: string) => void;

  readonly #buckets = new Map<ProviderId, TokenBucket>();
  readonly #breakers = new Map<ProviderId, Breaker>();
  readonly #cache = new Map<string, CacheEntry>();
  readonly #down = new Map<ProviderId, readonly number[]>();
  #store: ReplayStore | undefined;

  constructor(options: HttpClientOptions = {}) {
    this.#config = options.config ?? getConfig();
    this.mode = this.#config.PROVIDER_MODE;
    this.#clock = options.clock ?? new SystemClock();
    this.#sleeper = options.sleeper ?? systemSleeper;
    this.#transport =
      options.transport ?? (this.mode === 'replay' ? replayWallTransport() : undiciTransport());
    this.#rng = options.rng ?? cryptoRng;
    this.#sink = options.breakerSink ?? noopBreakerSink;
    this.#persistence = options.persistence;
    this.#maxWaitMs = options.maxWaitMs ?? 120_000;
    this.#onError = options.onError ?? ((): void => undefined);
    this.#store = options.store;
  }

  get(req: HttpRequest): Promise<RawRecord> {
    return this.#execute({ ...req, method: req.method ?? 'GET' });
  }

  post(req: HttpRequest & { body: string }): Promise<RawRecord> {
    return this.#execute({ ...req, method: 'POST' });
  }

  /** Observable breaker state. Reading it reports the half-open window but does not claim the probe. */
  breaker(id: ProviderId): BreakerState {
    const breaker = this.#breaker(id);
    const state =
      breaker.state === 'open' &&
      breaker.openedAt !== null &&
      this.#clock.now() - breaker.openedAt >= BREAKER_HALF_OPEN_MS
        ? 'half_open'
        : breaker.state;
    return {
      state,
      consecutiveFailures: breaker.consecutiveFailures,
      openedAt: breaker.openedAt,
    };
  }

  tokens(id: ProviderId): BucketState {
    const bucket = this.#bucket(id);
    return {
      capacity: bucket.capacity,
      available: bucket.available(this.#clock.now()),
      refillPerSec: bucket.refillPerSec,
    };
  }

  /** `true` while the breaker for `id` is open — the lines below are `PROVIDER_DOWN` (§2.5 step 3). */
  isProviderDown(id: ProviderId): boolean {
    return this.#down.has(id);
  }

  /** The `md_lines` the last opening marked, as the sink reported them. */
  downMdLines(id: ProviderId): readonly number[] {
    return this.#down.get(id) ?? [];
  }

  /** Restore the persisted daily buckets (`bls.*`) at startup — §2.2. */
  async restoreBuckets(ids: readonly ProviderId[]): Promise<void> {
    if (this.#persistence === undefined) return;
    for (const id of ids) {
      const bucket = this.#bucket(id);
      if (!bucket.daily) continue;
      try {
        const state = await this.#persistence.load(id);
        if (state !== null) bucket.restore(state.available, state.atMs);
      } catch (err) {
        this.#onError(err, `restoring the persisted bucket for ${id}`);
      }
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────

  #bucket(id: ProviderId): TokenBucket {
    let bucket = this.#buckets.get(id);
    if (bucket === undefined) {
      bucket = new TokenBucket(providerDefaults(id, this.#config), this.#clock.now());
      this.#buckets.set(id, bucket);
    }
    return bucket;
  }

  #breaker(id: ProviderId): Breaker {
    let breaker = this.#breakers.get(id);
    if (breaker === undefined) {
      breaker = { state: 'closed', consecutiveFailures: 0, openedAt: null, probeInFlight: false };
      this.#breakers.set(id, breaker);
    }
    return breaker;
  }

  #replayStore(): ReplayStore {
    return (this.#store ??= openReplayStore(this.#config.REPLAY_DIR));
  }

  async #execute(req: HttpRequest & { method: HttpMethod }): Promise<RawRecord> {
    const { providerId, method } = req;
    const url = canonicalUrl(req.url);
    const key = requestKey(providerId, method, url, req.body);

    // ── replay: the wall (§2.1, §3.6). No tokens, no retries, no breaker accounting — a missing
    // fixture is a test defect and tripping the breaker would hide it behind a stale screen.
    if (this.mode === 'replay') {
      const record = this.#replayStore().replay({
        providerId,
        method,
        url: req.url,
        ...(req.body === undefined ? {} : { body: req.body }),
        ...(req.captureIndex === undefined ? {} : { captureIndex: req.captureIndex }),
      });
      return record;
    }

    this.#assertCredentials(providerId);

    const share: BudgetShare = req.budgetShare ?? 'scheduler';
    const defaults = providerDefaults(providerId, this.#config);
    const timeoutMs = req.timeoutMs ?? defaults.timeoutMs;
    const ttlMs = req.cacheTtlMs ?? defaultCacheTtlMs(providerId);
    const requestHashHex = requestHash(method, url, req.body);

    const isProbe = this.#gateBreaker(providerId);
    try {
      // ── §2.4: a fresh TTL entry is answered without a request and without a token.
      const cached = this.#cache.get(key);
      if (ttlMs > 0 && cached !== undefined && this.#clock.now() - cached.validatedAtMs < ttlMs) {
        return this.#fromCache(cached, providerId, method, url, key, requestHashHex, cached.status);
      }

      let lastError: Error | undefined;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        await this.#acquire(providerId, share);
        const headers = this.#headers(defaults, cached, req.headers);
        const startedAt = this.#clock.now();

        let response: TransportResponse;
        try {
          response = await this.#transport({
            method,
            url,
            headers,
            body: req.body,
            timeoutMs,
          });
        } catch (err) {
          const failure = isTimeoutError(err)
            ? new ProviderTimeoutError(providerId, url, timeoutMs, err)
            : err instanceof Error
              ? err
              : new TransportError(`${method} ${url}: ${String(err)}`, err);
          lastError = failure;
          if (attempt < MAX_ATTEMPTS) {
            await this.#sleeper.sleep(backoffDelayMs(attempt, this.#rng));
            continue;
          }
          this.#onFailure(providerId, null, url, isProbe);
          throw failure;
        }

        // ── 304: the stored bytes are still current (§2.4). No provenance row, no update.
        if (response.status === 304) {
          if (cached === undefined) {
            this.#onFailure(providerId, 304, url, isProbe);
            throw new ProviderHttpError(
              providerId,
              304,
              url,
              key,
              'a 304 arrived with nothing in the conditional cache to serve — the request carried ' +
                'no validator, or the entry was evicted between the two',
            );
          }
          cached.validatedAtMs = this.#clock.now();
          const etag = response.headers.etag;
          if (etag !== undefined) cached.etag = etag;
          const lastModified = response.headers['last-modified'];
          if (lastModified !== undefined) cached.lastModified = lastModified;
          this.#onSuccess(providerId, isProbe);
          return this.#fromCache(cached, providerId, method, url, key, requestHashHex, 304);
        }

        if (response.status >= 200 && response.status <= 299) {
          // §2.2: a Yahoo 200 with a zero-length body is the endpoint refusing a non-browser
          // agent. Parsed, it reads as "no bars"; raised, it trips the breaker, which is correct.
          if (family(providerId) === 'yahoo' && response.body.length === 0) {
            const err = new ProviderHttpError(
              providerId,
              200,
              url,
              key,
              'HTTP 200 with a zero-length body — Yahoo answers an unrecognised User-Agent this ' +
                'way; treated as a hard failure, never as "no data" (PROVIDERS.a §2.2)',
            );
            this.#onFailure(providerId, 200, url, isProbe);
            throw err;
          }
          const raw = this.#record(
            providerId,
            method,
            url,
            key,
            requestHashHex,
            response,
            startedAt,
          );
          this.#store200(key, raw, response);
          this.#onSuccess(providerId, isProbe);
          if (this.mode === 'record') this.#recordCapture(raw);
          return raw;
        }

        // ── a status we did not want.
        const err = new ProviderHttpError(
          providerId,
          response.status,
          url,
          key,
          preview(response.body),
        );
        if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS) {
          lastError = err;
          const retryAfter = parseRetryAfterMs(response.headers['retry-after'], this.#clock.now());
          const computed = backoffDelayMs(attempt, this.#rng);
          const delay =
            retryAfter !== null && retryAfter < MAX_RETRY_AFTER_MS ? retryAfter : computed;
          await this.#sleeper.sleep(delay);
          continue;
        }
        if (countsAsProviderFailure(response.status)) {
          this.#onFailure(providerId, response.status, url, isProbe);
        } else if (isProbe) {
          // A 404 is the provider answering: the probe proved the provider is up.
          this.#onSuccess(providerId, isProbe);
        }
        throw err;
      }

      /* c8 ignore next 2 — the loop either returns or throws; this is belt and braces. */
      throw lastError ?? new Error(`${providerId} ${url}: exhausted ${MAX_ATTEMPTS} attempts`);
    } finally {
      if (isProbe) this.#breaker(providerId).probeInFlight = false;
    }
  }

  /**
   * §2.5 step 1. Returns `true` when this request is the single half-open probe.
   *
   * @throws CircuitOpenError while the breaker is open, without consuming a token.
   */
  #gateBreaker(providerId: ProviderId): boolean {
    const breaker = this.#breaker(providerId);
    if (breaker.state === 'closed') return false;
    const openedAt = breaker.openedAt ?? this.#clock.now();
    const retryAtMs = openedAt + BREAKER_HALF_OPEN_MS;
    if (this.#clock.now() < retryAtMs || breaker.probeInFlight) {
      throw new CircuitOpenError(providerId, openedAt, retryAtMs);
    }
    breaker.state = 'half_open';
    breaker.probeInFlight = true;
    return true;
  }

  #onSuccess(providerId: ProviderId, isProbe: boolean): void {
    const breaker = this.#breaker(providerId);
    const wasOpen = breaker.state !== 'closed';
    breaker.consecutiveFailures = 0;
    breaker.state = 'closed';
    breaker.openedAt = null;
    breaker.probeInFlight = false;
    if (wasOpen || isProbe) {
      this.#down.delete(providerId);
      void this.#emitClosed(providerId);
    }
  }

  #onFailure(providerId: ProviderId, status: number | null, url: string, isProbe: boolean): void {
    const breaker = this.#breaker(providerId);
    breaker.consecutiveFailures += 1;
    breaker.probeInFlight = false;
    // A failed half-open probe re-opens for the same 60 s (§2.5).
    if (isProbe || breaker.consecutiveFailures >= BREAKER_FAILURE_THRESHOLD) {
      const openedAt = this.#clock.now();
      breaker.state = 'open';
      breaker.openedAt = openedAt;
      void this.#emitOpened({
        providerId,
        openedAt,
        consecutiveFailures: breaker.consecutiveFailures,
        lastStatus: status,
        lastUrl: url,
        retryAtMs: openedAt + BREAKER_HALF_OPEN_MS,
      });
    }
  }

  async #emitOpened(event: CircuitOpenEvent): Promise<void> {
    // Marked down *before* the sink runs: the state the rest of the process reads must not depend
    // on a database round trip completing.
    this.#down.set(event.providerId, this.#down.get(event.providerId) ?? []);
    try {
      const lines = await this.#sink.circuitOpened(event);
      if (this.#down.has(event.providerId)) this.#down.set(event.providerId, lines);
    } catch (err) {
      this.#onError(err, `writing the provider_circuit_open dq_event for ${event.providerId}`);
    }
  }

  async #emitClosed(providerId: ProviderId): Promise<void> {
    try {
      await this.#sink.circuitClosed(providerId, this.#clock.now());
    } catch (err) {
      this.#onError(err, `resolving the provider_circuit_open dq_event for ${providerId}`);
    }
  }

  /** Wait for a token, or refuse past the ceiling (§2.2). */
  async #acquire(providerId: ProviderId, share: BudgetShare): Promise<void> {
    const bucket = this.#bucket(providerId);
    let waited = 0;
    // Bounded: every iteration either takes a token or sleeps a strictly positive interval.
    for (let guard = 0; guard < 1024; guard += 1) {
      if (bucket.tryTake(this.#clock.now(), share)) {
        if (bucket.daily) this.#persistDaily(providerId, bucket);
        return;
      }
      const wait = bucket.waitMs(this.#clock.now(), share);
      if (!Number.isFinite(wait) || waited + wait > this.#maxWaitMs) {
        throw new RateLimitError(providerId, wait, this.#maxWaitMs, share);
      }
      waited += wait;
      await this.#sleeper.sleep(wait);
    }
    /* c8 ignore next */
    throw new RateLimitError(providerId, waited, this.#maxWaitMs, share);
  }

  #persistDaily(providerId: ProviderId, bucket: TokenBucket): void {
    const persistence = this.#persistence;
    if (persistence === undefined) return;
    void persistence.save(providerId, bucket.snapshot(this.#clock.now())).catch((err: unknown) => {
      this.#onError(err, `persisting the daily bucket for ${providerId}`);
    });
  }

  /**
   * §2.2 defaults, then §2.4 validators, then the caller's headers — the caller wins, because an
   * adapter that sets `Accept: text/csv` knows something the table does not.
   */
  #headers(
    defaults: ProviderDefaults,
    cached: CacheEntry | undefined,
    caller: Record<string, string> | undefined,
  ): Record<string, string> {
    const headers: Record<string, string> = { ...defaults.headers };
    if (cached !== undefined) {
      if (cached.etag !== undefined) headers['if-none-match'] = cached.etag;
      if (cached.lastModified !== undefined) headers['if-modified-since'] = cached.lastModified;
    }
    if (caller !== undefined) {
      for (const [name, value] of Object.entries(caller)) headers[name.toLowerCase()] = value;
    }
    return headers;
  }

  /** §2.2: the SEC fair-access User-Agent is mandatory on the wire, not merely configured. */
  #assertCredentials(providerId: ProviderId): void {
    if (family(providerId) !== 'sec') return;
    if (!SEC_USER_AGENT_RE.test(this.#config.SEC_USER_AGENT)) {
      throw new Error(
        `SEC_USER_AGENT must be a descriptive string carrying a contact email address ` +
          `(e.g. 'Terminal Clone 1.0 (ops@example.com)'); got '${this.#config.SEC_USER_AGENT}'. ` +
          'SEC answers a default agent with 403 and an HTML body (PROVIDERS.a §2.2).',
      );
    }
  }

  #record(
    providerId: ProviderId,
    method: HttpMethod,
    url: string,
    key: string,
    requestHashHex: string,
    response: TransportResponse,
    capturedAtMs: number,
  ): RawRecord {
    return {
      providerId,
      method,
      url,
      requestKey: key,
      requestHash: requestHashHex,
      status: response.status,
      headers: { ...response.headers },
      body: response.body,
      capturedAt: capturedAtMs,
      sha256: sha256Hex(response.body),
      sourceTs: parseHttpDate(response.headers['last-modified']),
      origin: 'live',
    };
  }

  #fromCache(
    entry: CacheEntry,
    providerId: ProviderId,
    method: HttpMethod,
    url: string,
    key: string,
    requestHashHex: string,
    status: number,
  ): RawRecord {
    return {
      providerId,
      method,
      url,
      requestKey: key,
      requestHash: requestHashHex,
      status,
      headers: { ...entry.headers },
      body: entry.body,
      // FEED-05: `cap` is when the *bytes* were captured. A revalidation publishes nothing new, so
      // it deliberately does not advance it (§2.4) and the staleness renderer keeps ageing.
      capturedAt: entry.capturedAtMs,
      sha256: entry.sha256,
      sourceTs: entry.sourceTs,
      origin: 'cache',
    };
  }

  #store200(key: string, raw: RawRecord, response: TransportResponse): void {
    this.#cache.set(key, {
      status: response.status,
      headers: { ...response.headers },
      body: response.body,
      sha256: raw.sha256,
      etag: response.headers.etag,
      lastModified: response.headers['last-modified'],
      capturedAtMs: raw.capturedAt,
      validatedAtMs: raw.capturedAt,
      sourceTs: raw.sourceTs,
    });
  }

  /** `record` mode writes through to the replay store (§3.4); a failure there is a recording defect. */
  #recordCapture(raw: RawRecord): void {
    try {
      this.#replayStore().record(raw);
    } catch (err) {
      this.#onError(err, `recording the capture for ${raw.providerId} ${raw.url}`);
    }
  }
}

/** First 200 bytes of a body, for an error message. */
function preview(body: Buffer): string {
  const text = body.subarray(0, 200).toString('utf8').replace(/\s+/g, ' ').trim();
  return body.length > 200 ? `${text}…` : text;
}

/** `Last-Modified` → the provider-published instant the transport knows (`RawRecord.sourceTs`). */
function parseHttpDate(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at);
}

/**
 * The process-wide client: config's mode, the real clock, real timers, the undici transport in
 * `live`/`record`, and the database breaker sink and daily-bucket persistence.
 */
export function createHttpClient(options: HttpClientOptions = {}): ProviderHttpClient {
  return new ProviderHttpClient({
    breakerSink: databaseBreakerSink(),
    persistence: schemaMetaBucketPersistence(),
    ...options,
  });
}
