/**
 * `http/rateLimit.ts` — the token buckets of API.md §8 L1165-1176.
 *
 * The route-level behaviour (which bucket each route spends, and the `429 RATE_LIMITED` envelope)
 * is proved end to end in `test/integration/functions/limits.test.ts`. What is proved here is the
 * arithmetic underneath it, on a `VirtualClock`, where the two properties that are hard to see
 * through HTTP can be stated directly: the **sliding** hourly window the export routes carry, and
 * the sweep that keeps a long-lived process from holding one bucket per session it ever saw.
 *
 * (It lives beside the function unit tests because `rateLimit.ts` is a WP-08 file and this is the
 * package's unit directory; nothing here is specific to the function surface.)
 */

import { describe, expect, it } from 'vitest';

import {
  EXPORT_LIMIT,
  rateLimiter,
  REST_LIMIT,
  SEARCH_LIMIT,
  type RateLimitRule,
} from '../../../src/http/rateLimit.js';
import { AppError } from '../../../src/http/errors.js';
import { testClock } from '../../../src/test/clock.js';

/** Take `n` tokens and return how many were refused. */
function drain(limiter: ReturnType<typeof rateLimiter>, key: string, rule: RateLimitRule, n: number): number {
  let refused = 0;
  for (let i = 0; i < n; i += 1) {
    try {
      limiter.take(key, rule);
    } catch {
      refused += 1;
    }
  }
  return refused;
}

describe('the documented rates', () => {
  it('matches API.md §8 row for row', () => {
    expect(REST_LIMIT).toMatchObject({ ratePerSec: 20, burst: 60 });
    expect(SEARCH_LIMIT).toMatchObject({ ratePerSec: 30, burst: 60 });
    expect(EXPORT_LIMIT).toMatchObject({ ratePerSec: 2, burst: 2, perHour: 60 });
  });
});

describe('the token bucket', () => {
  it('spends the burst, refuses, then refills at the documented rate', () => {
    const clock = testClock();
    const limiter = rateLimiter(clock);

    expect(drain(limiter, 's1', REST_LIMIT, 60)).toBe(0);
    expect(drain(limiter, 's1', REST_LIMIT, 1)).toBe(1);

    clock.advance(500); // half a second buys ten tokens
    expect(drain(limiter, 's1', REST_LIMIT, 10)).toBe(0);
    expect(drain(limiter, 's1', REST_LIMIT, 1)).toBe(1);
  });

  it('never refills past the burst, however long a session sits idle', () => {
    const clock = testClock();
    const limiter = rateLimiter(clock);
    limiter.take('s1', REST_LIMIT);
    clock.advance(24 * 60 * 60 * 1_000);
    expect(drain(limiter, 's1', REST_LIMIT, 60)).toBe(0);
    expect(drain(limiter, 's1', REST_LIMIT, 1)).toBe(1);
  });

  it('keeps one bucket per (rule, key): two scopes and two sessions never share', () => {
    const clock = testClock();
    const limiter = rateLimiter(clock);
    drain(limiter, 's1', REST_LIMIT, 60);
    expect(drain(limiter, 's1', REST_LIMIT, 1)).toBe(1);
    // Same session, different scope.
    expect(drain(limiter, 's1', SEARCH_LIMIT, 1)).toBe(0);
    // Different session, same scope.
    expect(drain(limiter, 's2', REST_LIMIT, 1)).toBe(0);
  });

  it('answers RATE_LIMITED with a retryAfterMs a client can actually wait on', () => {
    const clock = testClock();
    const limiter = rateLimiter(clock);
    drain(limiter, 's1', REST_LIMIT, 60);

    let thrown: unknown;
    try {
      limiter.take('s1', REST_LIMIT);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const error = thrown as AppError;
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBeGreaterThan(0);

    // Waiting exactly that long is enough — a `Retry-After` that is still too early would put a
    // well-behaved client into a retry loop.
    clock.advance(error.retryAfterMs!);
    expect(drain(limiter, 's1', REST_LIMIT, 1)).toBe(0);
  });
});

describe('the hourly cap the export routes carry (API.md §8: "2 req/s, 60 per hour")', () => {
  it('refuses the 61st export in an hour even at a leisurely pace', () => {
    const clock = testClock();
    const limiter = rateLimiter(clock);

    // One export every fifty seconds: the per-second bucket refills long before each take, so
    // the only thing that can refuse the 61st is the hourly cap.
    for (let i = 0; i < 60; i += 1) {
      limiter.take('s1', EXPORT_LIMIT);
      clock.advance(50_000);
    }
    // Fifty minutes have passed and all sixty are still inside the hour.
    expect(drain(limiter, 's1', EXPORT_LIMIT, 1)).toBe(1);
  });

  it('is a SLIDING window: the budget frees up as the oldest export ages out', () => {
    const clock = testClock();
    const limiter = rateLimiter(clock);

    for (let i = 0; i < 60; i += 1) {
      limiter.take('s1', EXPORT_LIMIT);
      clock.advance(1_000);
    }
    expect(drain(limiter, 's1', EXPORT_LIMIT, 1)).toBe(1);

    // A fixed window resetting on the hour would let a caller spend the whole hour's budget twice
    // across the boundary; a sliding one hands back exactly one slot as the oldest one expires.
    // Advance to the instant the FIRST export leaves the window, and no further.
    clock.advance(3_600_000 - 60_000);
    expect(drain(limiter, 's1', EXPORT_LIMIT, 1)).toBe(0);
    expect(drain(limiter, 's1', EXPORT_LIMIT, 1)).toBe(1);
  });
});

describe('retention', () => {
  it('forgets buckets that are full and idle, and keeps the ones still deciding', () => {
    const clock = testClock();
    const limiter = rateLimiter(clock);

    // Enough takes across enough keys to cross the sweep threshold.
    for (let i = 0; i < 600; i += 1) limiter.take(`s${String(i)}`, REST_LIMIT);
    const held = limiter.size();
    expect(held).toBeGreaterThan(0);

    // An hour later every one of those buckets is full again and carries no decision.
    clock.advance(3_600_000);
    drain(limiter, 'sweeper', REST_LIMIT, 512);
    expect(limiter.size()).toBeLessThan(held);

    limiter.reset();
    expect(limiter.size()).toBe(0);
  });
});
