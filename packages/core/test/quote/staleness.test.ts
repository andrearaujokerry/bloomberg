/**
 * TERM-12 — `valueState` is the single staleness implementation. The limit is 3 × expectedIntervalMs;
 * an age of exactly 3× is still live, one millisecond more is stale (both sides pinned here).
 */

import { describe, expect, it } from 'vitest';

import type { StalenessInput } from '../../src/quote/staleness.js';
import {
  STALENESS_MULTIPLIER,
  msUntilStale,
  stalenessLimitMs,
  valueState,
} from '../../src/quote/staleness.js';

const T0 = 1_789_497_688_000; // 2026-09-15T18:41:28Z, the AAPL capture
const INTERVAL = 10_000; // cboe.quotes md_lines.expected_interval_ms
const LIMIT = 30_000;

const live = (over: Partial<StalenessInput> = {}): StalenessInput => ({
  ts: { src: T0 - 900_000, cap: T0, pub: T0 + 1 },
  session: 'open',
  expectedIntervalMs: INTERVAL,
  fields: { PX_LAST: 330.27 },
  delayMin: 15,
  dq: [],
  ...over,
});

describe('stalenessLimitMs', () => {
  it('is 3 × expectedIntervalMs', () => {
    expect(STALENESS_MULTIPLIER).toBe(3);
    expect(stalenessLimitMs(INTERVAL)).toBe(LIMIT);
    expect(stalenessLimitMs(60_000)).toBe(180_000);
  });
});

describe('valueState — live → stale at 3 × the interval', () => {
  it('is live while the capture is within the limit, including exactly at it', () => {
    expect(valueState(live(), T0)).toBe('live');
    expect(valueState(live(), T0 + LIMIT - 1)).toBe('live');
    expect(valueState(live(), T0 + LIMIT)).toBe('live');
  });

  it('turns stale one millisecond beyond the limit', () => {
    expect(valueState(live(), T0 + LIMIT + 1)).toBe('stale');
    expect(valueState(live(), T0 + 10 * LIMIT)).toBe('stale');
  });

  it('counts down to the boundary with msUntilStale', () => {
    expect(msUntilStale(live(), T0)).toBe(LIMIT);
    expect(msUntilStale(live(), T0 + LIMIT)).toBe(0);
    expect(msUntilStale(live(), T0 + LIMIT + 1)).toBe(0);
  });

  it('a frozen source during open is stale even while captures keep arriving', () => {
    // Source last advanced 15 min (the intrinsic delay) + limit + 1 ms ago; captured just now.
    const src = T0 - 15 * 60_000 - LIMIT - 1;
    const q = live({ ts: { src, cap: T0, pub: T0 } });
    expect(valueState(q, T0)).toBe('stale');
    // One millisecond younger: still live.
    expect(valueState(live({ ts: { src: src + 1, cap: T0, pub: T0 } }), T0)).toBe('live');
    // Without the delay shift (delayMin undefined → 0) the same source is stale much earlier.
    expect(valueState(live({ ts: { src: T0 - LIMIT - 1, cap: T0, pub: T0 }, delayMin: undefined }), T0)).toBe('stale');
  });

  it('a frozen source outside open is not stale (the frozen-source rule is an open-session rule)', () => {
    const q = live({ ts: { src: T0 - 3_600_000, cap: T0, pub: T0 }, session: 'pre' });
    expect(valueState(q, T0)).toBe('live');
    expect(valueState({ ...q, session: 'halted' }, T0)).toBe('live');
    expect(valueState({ ...q, session: 'auction' }, T0)).toBe('live');
  });

  it('a null source timestamp never triggers the frozen-source rule', () => {
    expect(valueState(live({ ts: { src: null, cap: T0, pub: T0 } }), T0 + LIMIT)).toBe('live');
  });

  it('an open provider circuit is stale regardless of age', () => {
    expect(valueState(live({ circuitOpen: true }), T0)).toBe('stale');
    expect(valueState(live({ dq: ['PROVIDER_DOWN'] }), T0)).toBe('stale');
    expect(valueState(live({ dq: ['CROSS_SOURCE_DIVERGENCE'] }), T0)).toBe('live');
  });
});

describe('valueState — closed outside the session', () => {
  it('is closed for closed and post, however old the print', () => {
    expect(valueState(live({ session: 'closed' }), T0 + 10 * LIMIT)).toBe('closed');
    expect(valueState(live({ session: 'post' }), T0 + 10 * LIMIT)).toBe('closed');
  });

  it('closed beats stale and circuit-open but not blank / na', () => {
    expect(valueState(live({ session: 'closed', circuitOpen: true }), T0)).toBe('closed');
    expect(valueState(live({ session: 'closed', denied: true }), T0)).toBe('blank');
    expect(valueState(live({ session: 'closed', fields: {} }), T0)).toBe('na');
  });
});

describe('valueState — blank and na', () => {
  it('is blank when denied, whatever else is true', () => {
    expect(valueState(live({ denied: true }), T0)).toBe('blank');
    expect(valueState(live({ denied: true, session: 'open' }), T0 + 10 * LIMIT)).toBe('blank');
  });

  it('is blank before anything was captured (ts.cap === 0)', () => {
    expect(valueState(live({ ts: { src: null, cap: 0, pub: 0 }, fields: {} }), T0)).toBe('blank');
  });

  it('is na when the field set carries no value for the instrument', () => {
    expect(valueState(live({ fields: {} }), T0)).toBe('na');
    expect(valueState(live({ fields: { PX_BID: undefined } }), T0)).toBe('na');
    expect(valueState(live({ fields: { PX_BID: 330.25 } }), T0)).toBe('live');
  });
});
