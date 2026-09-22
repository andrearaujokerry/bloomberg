/**
 * WORKPLAN WP-08 acceptance row — `functions/resultCache.ts` (FUNCTIONS.md §1.4.4 L351-356).
 *
 * Three claims, and why each one is a test rather than a code comment:
 *
 *  1. **Ten minutes, on the injected clock, measured from `storedAt`.** The boundary is asserted at
 *     599 999 ms and at exactly 600 000 ms, because "about ten minutes" is not a contract: the
 *     client turns a `RESULT_EXPIRED` 404 into a re-launch, and a cache that kept a result eleven
 *     minutes would serve an entitlement decision that had already lapsed. Reading an entry does
 *     not extend its life — a panel left open all afternoon must still expire.
 *  2. **Another user's `resultId` is `undefined`, not data and not a distinguishable error.** A
 *     share link carries a resultId across firms. If a foreign hit answered differently from a
 *     resultId that never existed, the id space would report whether user X ran a function, which
 *     is a cross-tenant disclosure dressed up as a 404-vs-403 distinction. The test asserts the
 *     two answers are `===` identical.
 *  3. **LRU 500 per user.** The 501st put evicts that user's least recently used entry — where
 *     "recently used" counts reads, not just writes — and touches nothing belonging to anyone
 *     else. A shared bound would let one user's paging loop evict everybody else's share links.
 */

import { describe, expect, it } from 'vitest';

import type { PayloadMeta } from '@terminal/core';

import {
  DEFAULT_PER_USER,
  DEFAULT_TTL_MS,
  ResultCache,
  type CachedResult,
} from '../../../src/functions/resultCache.js';
import { testClock, TEST_NOW } from '../../../src/test/clock.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────────────────────

function meta(over: Partial<PayloadMeta> = {}): PayloadMeta {
  return {
    traceId: '11111111-1111-4111-8111-111111111111',
    resultId: 'R',
    asOf: { validAt: new Date(TEST_NOW).toISOString(), knownAt: new Date(TEST_NOW).toISOString() },
    tier: 'delayed',
    staleness: 'live',
    provenance: [],
    entitlement: [],
    unavailable: [],
    engines: [],
    servedAt: new Date(TEST_NOW).toISOString(),
    ...over,
  };
}

function entry(over: Partial<CachedResult> & Pick<CachedResult, 'resultId' | 'userId'>): CachedResult {
  return {
    firmId: 3,
    code: 'FIX',
    params: { range: '1Y' },
    security: 42,
    data: { variant: 'equity', px: 188.5 },
    meta: meta({ resultId: over.resultId }),
    storedAt: TEST_NOW,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ResultCache — the documented defaults', () => {
  it('is 500 entries per user and 10 minutes', () => {
    expect(DEFAULT_PER_USER).toBe(500);
    expect(DEFAULT_TTL_MS).toBe(600_000);
  });

  it('refuses a nonsensical bound rather than quietly using a default', () => {
    const clock = testClock();
    expect(() => new ResultCache({ clock, perUser: 0 })).toThrow(RangeError);
    expect(() => new ResultCache({ clock, ttlMs: 0 })).toThrow(RangeError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. Expiry
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ResultCache — the ten-minute TTL', () => {
  it('serves at 9:59.999 and is gone at exactly 10:00.000', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock });
    cache.put(entry({ resultId: 'r1', userId: 7, storedAt: clock.now() }));

    clock.advance(DEFAULT_TTL_MS - 1);
    expect(cache.get('r1', 7)?.resultId).toBe('r1');

    clock.advance(1);
    expect(cache.get('r1', 7)).toBeUndefined();
    expect(cache.stats().expired).toBe(1);
    // The dead entry is swept, not merely hidden: a stale row must not hold a slot.
    expect(cache.size()).toBe(0);
  });

  it('does not extend a result because somebody read it', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock });
    cache.put(entry({ resultId: 'r1', userId: 7, storedAt: clock.now() }));

    // Read it every minute for nine minutes; the TTL still runs from storedAt.
    for (let i = 0; i < 9; i += 1) {
      clock.advance(60_000);
      expect(cache.get('r1', 7)).toBeDefined();
    }
    clock.advance(60_000);
    expect(cache.get('r1', 7)).toBeUndefined();
  });

  it('never treats an expired entry as live through peek()', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock });
    cache.put(entry({ resultId: 'r1', userId: 7, storedAt: clock.now() }));
    expect(cache.peek('r1', 3)).toBeDefined();
    clock.advance(DEFAULT_TTL_MS);
    expect(cache.peek('r1', 3)).toBeUndefined();
  });

  it('sweeps a user’s dead entries on the next put rather than evicting a live one', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock, perUser: 2 });
    cache.put(entry({ resultId: 'old1', userId: 7, storedAt: clock.now() }));
    cache.put(entry({ resultId: 'old2', userId: 7, storedAt: clock.now() }));

    clock.advance(DEFAULT_TTL_MS);
    cache.put(entry({ resultId: 'fresh', userId: 7, storedAt: clock.now() }));

    expect(cache.size()).toBe(1);
    expect(cache.get('fresh', 7)).toBeDefined();
    expect(cache.stats().expired).toBe(2);
    expect(cache.stats().evictions).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The producer check
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ResultCache — a resultId belongs to its producer', () => {
  it('answers another user with exactly what it answers an unknown id', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock });
    cache.put(entry({ resultId: 'r1', userId: 7, storedAt: clock.now() }));

    const foreign = cache.get('r1', 8);
    const missing = cache.get('never-existed', 8);

    expect(foreign).toBeUndefined();
    expect(missing).toBeUndefined();
    // Indistinguishable: same value, same type, nothing thrown on either path.
    expect(foreign).toBe(missing);
  });

  it('does not leak the producer’s data to a viewer', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock });
    cache.put(
      entry({ resultId: 'r1', userId: 7, storedAt: clock.now(), data: { variant: 'equity', px: 1 } }),
    );
    expect(cache.get('r1', 8)).toBeUndefined();
    // The producer still has it — the entry was hidden, not deleted.
    expect(cache.get('r1', 7)?.data).toEqual({ variant: 'equity', px: 1 });
  });

  it('counts a foreign read for the operator without disclosing it to the caller', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock });
    cache.put(entry({ resultId: 'r1', userId: 7, storedAt: clock.now() }));

    cache.get('r1', 8);
    cache.get('nope', 8);

    const stats = cache.stats();
    expect(stats.foreign).toBe(1);
    expect(stats.misses).toBe(1);
  });

  it('refuses to reassign a resultId to a second owner', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock });
    cache.put(entry({ resultId: 'r1', userId: 7, storedAt: clock.now() }));
    expect(() => cache.put(entry({ resultId: 'r1', userId: 8, storedAt: clock.now() }))).toThrow(
      /already belongs to user 7/,
    );
    expect(cache.get('r1', 7)).toBeDefined();
  });

  it('peek() finds the row for the share-link re-run without handing over the values', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock });
    cache.put(entry({ resultId: 'r1', userId: 7, storedAt: clock.now() }));

    // `peek` is how `GET /results/:resultId` learns the code, params and asOf it must re-run at.
    const shared = cache.peek('r1', 3);
    expect(shared?.code).toBe('FIX');
    expect(shared?.userId).toBe(7);
    // …and it is still the producer-only `get` that decides whether the cached data may be served.
    expect(cache.get('r1', 8)).toBeUndefined();
  });

  it('peek() answers undefined across a firm boundary, exactly as a bogus id does', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock });
    cache.put(entry({ resultId: 'r1', userId: 7, firmId: 3, storedAt: clock.now() }));

    // A share link is an MSG-04 link, and messages never leave a firm. A viewer from firm 4
    // therefore gets the same answer a resultId that never existed gets — the id space is not an
    // existence oracle across tenants.
    expect(cache.peek('r1', 4)).toBeUndefined();
    expect(cache.peek('nope', 4)).toBeUndefined();
    expect(cache.peek('r1', 3)).toBeDefined();
    expect(cache.stats().foreign).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2b. Retention — the TTL leaves memory, not only reads
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ResultCache — the background sweep', () => {
  it('drops expired entries without anybody reading them', () => {
    const clock = testClock();
    let tick: (() => void) | undefined;
    let everyMs: number | undefined;
    let cleared = false;
    const cache = new ResultCache({
      clock,
      timers: {
        setInterval: (fn, ms) => {
          tick = fn;
          everyMs = ms;
          return 'handle';
        },
        clearInterval: () => {
          cleared = true;
        },
      },
    });

    cache.start();
    cache.start(); // idempotent
    expect(everyMs).toBe(60_000);

    for (let i = 0; i < 5; i += 1) {
      cache.put(entry({ resultId: `r${String(i)}`, userId: 7, storedAt: clock.now() }));
    }
    expect(cache.size()).toBe(5);

    // Nobody reads, nobody writes: without a sweep these five entitlement-filtered payloads
    // would stay resident until the process restarted, which is not a ten-minute retention.
    clock.advance(DEFAULT_TTL_MS);
    tick?.();
    expect(cache.size()).toBe(0);
    expect(cache.stats().expired).toBe(5);

    cache.stop();
    expect(cleared).toBe(true);
    cache.stop(); // idempotent — a second stop must not clear a handle it no longer owns
  });

  it('leaves live entries alone', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock });
    cache.put(entry({ resultId: 'r1', userId: 7, storedAt: clock.now() }));
    clock.advance(DEFAULT_TTL_MS - 1);
    expect(cache.sweepAll()).toBe(0);
    expect(cache.size()).toBe(1);
    clock.advance(1);
    expect(cache.sweepAll()).toBe(1);
    expect(cache.size()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. LRU, per user
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ResultCache — LRU 500 per user', () => {
  it('evicts the least recently used entry at the 501st put', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock });

    for (let i = 0; i < DEFAULT_PER_USER; i += 1) {
      cache.put(entry({ resultId: `r${i}`, userId: 7, storedAt: clock.now() }));
    }
    expect(cache.size()).toBe(DEFAULT_PER_USER);

    cache.put(entry({ resultId: 'r500', userId: 7, storedAt: clock.now() }));

    expect(cache.size()).toBe(DEFAULT_PER_USER);
    expect(cache.get('r0', 7)).toBeUndefined();
    expect(cache.get('r1', 7)).toBeDefined();
    expect(cache.get('r500', 7)).toBeDefined();
    expect(cache.stats().evictions).toBe(1);
  });

  it('counts a read as a use, so the oldest *read* is what goes', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock, perUser: 3 });
    cache.put(entry({ resultId: 'a', userId: 7, storedAt: clock.now() }));
    cache.put(entry({ resultId: 'b', userId: 7, storedAt: clock.now() }));
    cache.put(entry({ resultId: 'c', userId: 7, storedAt: clock.now() }));

    // Touch 'a': now 'b' is the least recently used.
    expect(cache.get('a', 7)).toBeDefined();
    cache.put(entry({ resultId: 'd', userId: 7, storedAt: clock.now() }));

    expect(cache.get('b', 7)).toBeUndefined();
    expect(cache.get('a', 7)).toBeDefined();
    expect(cache.get('c', 7)).toBeDefined();
    expect(cache.get('d', 7)).toBeDefined();
  });

  it('never evicts another user’s entry', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock, perUser: 2 });
    cache.put(entry({ resultId: 'mine-1', userId: 7, storedAt: clock.now() }));
    cache.put(entry({ resultId: 'theirs-1', userId: 8, storedAt: clock.now() }));
    cache.put(entry({ resultId: 'theirs-2', userId: 8, storedAt: clock.now() }));

    // User 8 overflows their own bound three times over.
    for (let i = 3; i <= 6; i += 1) {
      cache.put(entry({ resultId: `theirs-${i}`, userId: 8, storedAt: clock.now() }));
    }

    expect(cache.get('mine-1', 7)).toBeDefined();
    expect(cache.get('theirs-5', 8)).toBeDefined();
    expect(cache.get('theirs-6', 8)).toBeDefined();
    expect(cache.get('theirs-1', 8)).toBeUndefined();
    expect(cache.stats().users).toBe(2);
  });

  it('replaces rather than duplicates a repeated resultId, and makes it the newest', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock, perUser: 2 });
    cache.put(entry({ resultId: 'a', userId: 7, storedAt: clock.now() }));
    cache.put(entry({ resultId: 'b', userId: 7, storedAt: clock.now() }));
    cache.put(
      entry({ resultId: 'a', userId: 7, storedAt: clock.now(), data: { variant: 'equity', px: 2 } }),
    );

    expect(cache.size()).toBe(2);
    expect(cache.get('a', 7)?.data).toEqual({ variant: 'equity', px: 2 });

    cache.put(entry({ resultId: 'c', userId: 7, storedAt: clock.now() }));
    // 'b' was the least recently used after 'a' was rewritten.
    expect(cache.get('b', 7)).toBeUndefined();
  });

  it('delete() and clear() forget both the entry and its ownership', () => {
    const clock = testClock();
    const cache = new ResultCache({ clock });
    cache.put(entry({ resultId: 'r1', userId: 7, storedAt: clock.now() }));

    expect(cache.delete('r1')).toBe(true);
    expect(cache.delete('r1')).toBe(false);
    expect(cache.size()).toBe(0);
    // Ownership is gone too, so the id may be reissued to anyone.
    cache.put(entry({ resultId: 'r1', userId: 8, storedAt: clock.now() }));
    expect(cache.get('r1', 8)).toBeDefined();

    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.stats().users).toBe(0);
  });
});
