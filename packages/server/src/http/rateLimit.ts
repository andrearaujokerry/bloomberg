/**
 * `http/rateLimit.ts` — the per-session token buckets of API.md §8 L1165-1176, WORKPLAN WP-08.
 *
 * ```
 * | Scope                                              | Limit                |
 * | REST, per session                                  | 20 req/s, burst 60   |
 * | /search                                            | 30 req/s, burst 60   |
 * | /data with kind 'tick' or historical over 10 years | 5 req/s              |
 * | Export routes (§9)                                 | 2 req/s, 60 per hour |
 * ```
 *
 * Three decisions, each of which is the difference between a limiter and the appearance of one:
 *
 * **1. The key is the session, never a header.** `request.principal.sessionId` is minted by the
 * server and presented by a cookie or a bearer key; `X-Forwarded-For` is typed by the caller, and
 * `buildApp` sets `trustProxy: true`, so `request.ip` is whatever the client put in that header.
 * A limiter keyed on it is a limiter with an unlimited number of buckets. (WP-07's `/auth/login`
 * limiter has the same property for the same reason: it keys on the socket peer, which the kernel
 * decides.) Where there is no session at all — `GET /fields` with `PUBLIC_FIELDS=1` — the socket
 * peer is the fallback, for the same reason.
 *
 * **2. Time comes from the injected `Clock`.** Every other deadline in this server does, and a
 * limiter that read `Date.now()` would be the one component a `VirtualClock` could not test. It
 * also means a test that wants to watch a bucket refill advances the clock instead of sleeping.
 *
 * **3. The buckets belong to a clock, not to the module.** A process-global map would be captured
 * by whichever clock asked first and would leak state between tests built minutes apart in virtual
 * time. `bucketsFor(clock)` gives each clock its own, and a clock that is collected takes its
 * buckets with it.
 *
 * A refusal is the documented `429 RATE_LIMITED` with `retryable: true` and `retryAfterMs`;
 * `http/errors.ts` turns that into the `Retry-After` header API.md §2 requires.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Clock } from '@terminal/core';

import { AppError } from './errors.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RateLimitRule {
  /** Bucket namespace, so one session's `/search` budget is not its REST budget. */
  readonly name: string;
  /** Sustained rate, requests per second. */
  readonly ratePerSec: number;
  /** Bucket depth — the burst a client may spend at once. */
  readonly burst: number;
  /** An additional sliding cap over the last hour (API.md §8 gives one to the export routes). */
  readonly perHour?: number;
}

/** API.md §8: "REST, per session — 20 req/s, burst 60". */
export const REST_LIMIT: RateLimitRule = { name: 'rest', ratePerSec: 20, burst: 60 };

/** API.md §8: "`/search` — 30 req/s, burst 60". */
export const SEARCH_LIMIT: RateLimitRule = { name: 'search', ratePerSec: 30, burst: 60 };

/**
 * API.md §8: "`/data` with `kind:'tick'` or `historical` over 10 years — 5 req/s".
 *
 * The burst is the rate: a tick read is the most expensive read the server serves, and §8 gives
 * this row no burst allowance of its own.
 */
export const HEAVY_DATA_LIMIT: RateLimitRule = { name: 'data.heavy', ratePerSec: 5, burst: 5 };

/** API.md §8: "Export routes (§9) — 2 req/s, 60 per hour". */
export const EXPORT_LIMIT: RateLimitRule = {
  name: 'export',
  ratePerSec: 2,
  burst: 2,
  perHour: 60,
};

/** A historical span this long or longer counts as a heavy read (API.md §8, "over 10 years"). */
export const LONG_HISTORY_MS = 10 * 365.25 * 24 * 60 * 60 * 1_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The buckets
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Bucket {
  /** Tokens available at {@link at}. */
  tokens: number;
  /** When `tokens` was last computed, on the injected clock. */
  at: number;
  /** Timestamps of the takes in the last hour — only kept when the rule has a `perHour`. */
  hour?: number[];
}

export interface RateLimiter {
  /** Spend one token, or throw the documented `429 RATE_LIMITED`. */
  take(key: string, rule: RateLimitRule): void;
  /** Buckets currently held (the leak test). */
  size(): number;
  /** Forget everything — tests, and nothing on a request path. */
  reset(): void;
}

/** How many takes pass between sweeps of the idle buckets. */
const SWEEP_EVERY = 512;

export function rateLimiter(clock: Clock): RateLimiter {
  const buckets = new Map<string, Bucket>();
  let takes = 0;

  /**
   * Drop buckets that are full and have not been touched for an hour.
   *
   * A full bucket carries no information — a caller arriving at one is in exactly the state a
   * caller arriving at no bucket is — so forgetting it changes no decision, and it is what keeps
   * a long-lived process from holding a row per session that ever made a request. Buckets with a
   * live hourly window are kept, because those *do* still carry a decision.
   */
  function sweep(nowMs: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.hour !== undefined && bucket.hour.length > 0) continue;
      if (nowMs - bucket.at < 3_600_000) continue;
      buckets.delete(key);
    }
  }

  return {
    take(key: string, rule: RateLimitRule): void {
      const nowMs = clock.now();
      takes += 1;
      if (takes % SWEEP_EVERY === 0) sweep(nowMs);

      const id = `${rule.name}:${key}`;
      let bucket = buckets.get(id);
      if (bucket === undefined) {
        bucket = { tokens: rule.burst, at: nowMs, ...(rule.perHour === undefined ? {} : { hour: [] }) };
        buckets.set(id, bucket);
      }

      // Refill for the elapsed time, capped at the burst depth.
      const elapsedMs = Math.max(0, nowMs - bucket.at);
      bucket.tokens = Math.min(rule.burst, bucket.tokens + (elapsedMs / 1_000) * rule.ratePerSec);
      bucket.at = nowMs;

      if (rule.perHour !== undefined) {
        const hour = (bucket.hour ??= []);
        const cutoff = nowMs - 3_600_000;
        // Sliding window rather than a counter that resets on the hour: a fixed window lets a
        // caller spend the whole hour's budget twice across the boundary.
        while (hour.length > 0 && hour[0]! <= cutoff) hour.shift();
        if (hour.length >= rule.perHour) {
          const oldest = hour[0]!;
          throw rateLimited(rule, Math.max(1, oldest + 3_600_000 - nowMs));
        }
      }

      if (bucket.tokens < 1) {
        // How long until one whole token exists.
        const waitMs = Math.ceil(((1 - bucket.tokens) / rule.ratePerSec) * 1_000);
        throw rateLimited(rule, Math.max(1, waitMs));
      }

      bucket.tokens -= 1;
      bucket.hour?.push(nowMs);
    },

    size(): number {
      return buckets.size;
    },

    reset(): void {
      buckets.clear();
    },
  };
}

function rateLimited(rule: RateLimitRule, retryAfterMs: number): AppError {
  return new AppError(
    'RATE_LIMITED',
    `Too many requests for ${rule.name}: the limit is ${String(rule.ratePerSec)} per second` +
      `${rule.perHour === undefined ? '' : ` and ${String(rule.perHour)} per hour`}.`,
    {
      retryAfterMs,
      details: {
        scope: rule.name,
        ratePerSec: rule.ratePerSec,
        burst: rule.burst,
        ...(rule.perHour === undefined ? {} : { perHour: rule.perHour }),
      },
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// One limiter per clock
// ─────────────────────────────────────────────────────────────────────────────────────────────

const limiters = new WeakMap<Clock, RateLimiter>();

/** The limiter this clock's app shares across every route group. */
export function limiterFor(clock: Clock): RateLimiter {
  let held = limiters.get(clock);
  if (held === undefined) {
    held = rateLimiter(clock);
    limiters.set(clock, held);
  }
  return held;
}

/** Drop a clock's buckets — a test that wants a cold start. */
export function resetRateLimits(clock: Clock): void {
  limiters.get(clock)?.reset();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The preHandler
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The bucket key: the session, or — where a route may be reached without one — the socket peer.
 *
 * `request.socket.remoteAddress`, never `request.ip`: with `trustProxy: true` the latter is the
 * left-most `X-Forwarded-For` entry, which the caller writes (`observability/metrics.ts#isLoopback`
 * makes the same distinction for the same reason).
 */
export function limitKey(request: FastifyRequest): string {
  const sessionId = request.principal?.sessionId;
  if (sessionId !== undefined) return `s:${sessionId}`;
  return `p:${request.socket.remoteAddress ?? 'unknown'}`;
}

export type RateLimitHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * A `preHandler` that spends one token of `rule`.
 *
 * Registered **after** `requireSession` in the handler's `preHandler` array, so the principal is
 * decorated by the time the key is computed: a limiter that ran first would bucket every caller
 * of a route under their socket address rather than their session.
 */
export function rateLimit(rule: RateLimitRule): RateLimitHook {
  return (request: FastifyRequest): Promise<void> => {
    limiterFor(clockOf(request)).take(limitKey(request), rule);
    return Promise.resolve();
  };
}

/**
 * The app's clock, or the process clock.
 *
 * Every route that installs a limiter is registered by `buildApp`, so `deps.clock` is there in
 * practice; the fallback exists so a bare `Fastify()` instance in a unit test cannot turn a rate
 * limit into a `500`.
 */
const FALLBACK_CLOCK: Clock = { now: () => Date.now() };

function clockOf(request: FastifyRequest): Clock {
  const deps = (request.server as { deps?: { clock?: Clock } }).deps;
  return deps?.clock ?? FALLBACK_CLOCK;
}

/**
 * A `preHandler` that spends a token only when `when` says this particular request is heavy.
 *
 * `/data` is one route serving six request kinds, and §8 rate-limits two of them differently. The
 * decision therefore has to see the body, which means it happens here and not in the route table.
 */
export function rateLimitWhen(
  rule: RateLimitRule,
  when: (request: FastifyRequest) => boolean,
): RateLimitHook {
  return (request: FastifyRequest): Promise<void> => {
    if (when(request)) limiterFor(clockOf(request)).take(limitKey(request), rule);
    return Promise.resolve();
  };
}
