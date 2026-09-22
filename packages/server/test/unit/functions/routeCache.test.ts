/**
 * `http/routes/functions.ts#resultCacheOf` — which `ResultCache` a request gets.
 *
 * The cache has to outlive a request: `GET /functions/:code/csv?resultId=…` arrives on a different
 * request from the run that produced the id, and a share link arrives minutes later. It used to
 * outlive rather more than that — a module-level `sharedCache ??= new ResultCache({ clock })`
 * captured whichever `Clock` asked first and kept it for the life of the process. One app built
 * with a frozen `VirtualClock` before the real one (a test that forgot to reset it, or any future
 * wiring order) and every entry's ten-minute TTL was then measured against a clock that never
 * advances, so nothing ever expired.
 *
 * The cache is now keyed on the clock, which makes that impossible to express rather than merely
 * unlikely.
 */

import { describe, expect, it } from 'vitest';

import type { Clock } from '@terminal/core';

import {
  resetResultCache,
  resultCacheOf,
  type FunctionHostDeps,
} from '../../../src/http/routes/functions.js';
import { testClock } from '../../../src/test/clock.js';

/** The two members `resultCacheOf` reads; the rest of `FunctionHostDeps` is not consulted. */
function deps(clock: Clock): FunctionHostDeps {
  return { clock } as unknown as FunctionHostDeps;
}

describe('resultCacheOf', () => {
  it('gives one cache per clock, and the same cache back for the same clock', () => {
    const a = testClock('2026-09-15T00:00:00.000Z');
    const b = testClock('2026-09-15T00:00:00.000Z');
    try {
      const first = resultCacheOf(deps(a));
      expect(resultCacheOf(deps(a))).toBe(first);
      expect(resultCacheOf(deps(b))).not.toBe(first);
    } finally {
      resetResultCache(a);
      resetResultCache(b);
    }
  });

  it('ages entries on ITS OWN clock, so a frozen clock cannot freeze another app', () => {
    const frozen = testClock('2026-09-15T00:00:00.000Z');
    const moving = testClock('2026-09-15T00:00:00.000Z');
    try {
      const frozenCache = resultCacheOf(deps(frozen));
      const movingCache = resultCacheOf(deps(moving));

      const entry = {
        resultId: 'r1',
        userId: 7,
        firmId: 3,
        code: 'FIX',
        params: {},
        security: 42,
        data: {},
        meta: {} as never,
      };
      frozenCache.put({ ...entry, storedAt: frozen.now() });
      movingCache.put({ ...entry, storedAt: moving.now() });

      moving.advance(600_000);

      // The moving clock's cache expired its entry; the frozen one — a different app, a different
      // clock — is untouched. Under the old process-global cache there was only one of these.
      expect(movingCache.get('r1', 7)).toBeUndefined();
      expect(frozenCache.get('r1', 7)).toBeDefined();
    } finally {
      resetResultCache(frozen);
      resetResultCache(moving);
    }
  });

  it('an injected cache always wins over the per-clock one', () => {
    const clock = testClock('2026-09-15T00:00:00.000Z');
    try {
      const shared = resultCacheOf(deps(clock));
      const injected = resultCacheOf({
        ...deps(clock),
        functions: { resultCache: shared },
      });
      expect(injected).toBe(shared);
    } finally {
      resetResultCache(clock);
    }
  });
});
