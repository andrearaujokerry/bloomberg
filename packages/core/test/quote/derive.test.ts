/**
 * `core/quote/derive.ts`: CHG_NET_1D, CHG_PCT_1D and TICK_DIR are derived, never sourced. The
 * recorded Cboe AAPL observation (fixtures/providers/normalised/cboe-quote-AAPL.json) carries the
 * venue's own cross-check — price_change −2.81, price_change_percent −0.8436, tick down — which
 * this module must reproduce from 330.27 and 333.08.
 */

import { describe, expect, it } from 'vitest';

import {
  DERIVED_QUOTE_FIELD_IDS,
  derive,
  netChange,
  pctChange,
  tickDirCode,
  tickDirection,
} from '../../src/quote/derive.js';

const AAPL = { PX_LAST: 330.27, PX_CLOSE_1D: 333.08 };

describe('derive — the Cboe AAPL cross-check', () => {
  it('reproduces −2.81 / −0.8436 exactly', () => {
    expect(netChange(AAPL)).toBe(-2.81);
    expect(pctChange(AAPL)).toBe(-0.8436);
    expect(derive(AAPL)).toEqual({ CHG_NET_1D: -2.81, CHG_PCT_1D: -0.8436 });
  });

  it('rounds away binary-float noise instead of publishing it', () => {
    expect(330.27 - 333.08).not.toBe(-2.81); // the raw subtraction is -2.8100000000000023
    expect(netChange({ PX_LAST: 0.1 + 0.2, PX_CLOSE_1D: 0.3 })).toBe(0);
    expect(Object.is(netChange({ PX_LAST: 0.1 + 0.2, PX_CLOSE_1D: 0.3 }), -0)).toBe(false);
    expect(pctChange({ PX_LAST: 101, PX_CLOSE_1D: 100 })).toBe(1);
    expect(pctChange({ PX_LAST: 100.123456, PX_CLOSE_1D: 100 })).toBe(0.1235);
  });
});

describe('derive — nothing is invented', () => {
  it('yields no change without a last price or a previous close', () => {
    expect(derive({ PX_LAST: 330.27 })).toEqual({});
    expect(derive({ PX_CLOSE_1D: 333.08 })).toEqual({});
    expect(derive({})).toEqual({});
  });

  it('never divides by a zero close', () => {
    expect(derive({ PX_LAST: 1, PX_CLOSE_1D: 0 })).toEqual({});
    expect(netChange({ PX_LAST: 1, PX_CLOSE_1D: 0 })).toBeUndefined();
  });

  it('ignores non-finite inputs', () => {
    expect(derive({ PX_LAST: Number.NaN, PX_CLOSE_1D: 10 })).toEqual({});
    expect(derive({ PX_LAST: 10, PX_CLOSE_1D: Number.POSITIVE_INFINITY })).toEqual({});
  });

  it('has no tick direction on the first print', () => {
    expect(derive(AAPL)).not.toHaveProperty('TICK_DIR');
    expect(derive(AAPL, {})).not.toHaveProperty('TICK_DIR');
    expect(tickDirection(330.27, undefined)).toBeUndefined();
  });
});

describe('derive — TICK_DIR from consecutive prints', () => {
  it('is down / up / flat against the previous PX_LAST', () => {
    expect(derive(AAPL, { PX_LAST: 330.3 }).TICK_DIR).toBe('down');
    expect(derive(AAPL, { PX_LAST: 330.2 }).TICK_DIR).toBe('up');
    expect(derive(AAPL, { PX_LAST: 330.27 }).TICK_DIR).toBe('flat');
  });

  it('encodes to the quote_ticks.tick_dir CHECK values', () => {
    expect(tickDirCode('up')).toBe('u');
    expect(tickDirCode('down')).toBe('d');
    expect(tickDirCode('flat')).toBe('f');
  });

  it('names exactly the three derived ids merge.ts strips from provider lines', () => {
    expect([...DERIVED_QUOTE_FIELD_IDS]).toEqual(['CHG_NET_1D', 'CHG_PCT_1D', 'TICK_DIR']);
  });
});
