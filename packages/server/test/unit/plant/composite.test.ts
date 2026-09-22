/**
 * BUS-05 — `plant/composite.ts` over two md lines (ARCHITECTURE §6.2 step 4).
 *
 * The plant's composition is `core/quote/merge.ts` plus `core/quote/derive.ts` and nothing else:
 * this file pins that equality field by field, so a rule can only ever be changed in `core` and the
 * plant cannot grow a second, divergent merge. The two lines are the two v1 sources — a Cboe
 * composite line (priority 10, publishes a book) and a Yahoo reference line (priority 20, does not).
 */

import { describe, expect, it } from 'vitest';

import { derive, mergeComposite } from '@terminal/core';
import type { LineState, QuoteFields } from '@terminal/core';

import {
  DIVERGENCE_TOLERANCE_PCT,
  NOOP_DQ_SINK,
  dbDivergenceSink,
  defaultLineMeta,
  delayMinFor,
  divergentPair,
  recompose,
  resolveLineMeta,
} from '../../../src/plant/composite.js';

const SRC = Date.parse('2026-09-17T17:59:00.000Z');
const CAP = Date.parse('2026-09-17T18:00:00.000Z');

function cboeLine(fields: QuoteFields, at = SRC): LineState {
  return {
    mdLineId: 5101,
    sourceId: 'cboe.quotes',
    fields,
    ts: { src: at, cap: CAP, pub: 0 },
    srcSeq: 15_972_883_317,
    provenanceId: 900_101,
  };
}

function yahooLine(fields: QuoteFields, at = SRC - 30_000): LineState {
  return {
    mdLineId: 5102,
    sourceId: 'yahoo.quote',
    fields,
    ts: { src: at, cap: CAP, pub: 0 },
    provenanceId: 900_102,
  };
}

/** The pair the plant composes: a Cboe book + print and a Yahoo summary. */
function twoLines(): Record<number, LineState> {
  return {
    5101: cboeLine({
      PX_LAST: 330.27,
      LAST_SIZE: 100,
      LAST_TRADE_TIME: SRC,
      PX_BID: 330.25,
      PX_ASK: 330.28,
      BID_SIZE: 40,
      ASK_SIZE: 120,
      PX_HIGH: 331.59,
      PX_LOW: 328.35,
      PX_VOLUME: 16_591_786,
      IVOL_30D: 24.427,
    }),
    5102: yahooLine({
      PX_LAST: 330.2,
      PX_OPEN: 330.24,
      PX_CLOSE_1D: 333.08,
      PX_HIGH: 331.6,
      PX_LOW: 328.4,
      PX_VOLUME: 16_600_000,
      // A provider's own change fields must never reach the composite.
      CHG_NET_1D: -99,
      CHG_PCT_1D: -99,
      TICK_DIR: 'up',
    }),
  };
}

const metaOf = (lines: Record<number, LineState>) => (mdLineId: number) =>
  resolveLineMeta(mdLineId, lines[mdLineId]?.sourceId ?? '');

describe('plant/composite.ts — recompose', () => {
  it('matches core/quote/merge.ts for every field, plus the derived block', () => {
    const lines = twoLines();
    const meta = metaOf(lines);
    const expected = mergeComposite(lines, (id) => meta(id).priority, {
      lineKindOf: (id) => meta(id).lineKind,
    });
    const derived = derive(expected.fields);

    const result = recompose({ lines, meta });

    expect(result.fields).toEqual({ ...expected.fields, ...derived });
    expect(result.winner).toBe(expected.winner);
    expect(result.dq).toEqual(expected.dq);

    // Every merged field keeps the merge's own as-of time; the derived block takes PX_LAST's.
    const expectedTs = { ...expected.fieldTs };
    for (const id of ['CHG_NET_1D', 'CHG_PCT_1D'] as const) {
      if (derived[id] !== undefined) expectedTs[id] = expected.fieldTs.PX_LAST;
    }
    expect(result.fieldTs).toEqual(expectedTs);
  });

  it('applies the BUS-05 rules: Cboe book and print, Yahoo close, volume max', () => {
    const result = recompose({ lines: twoLines(), meta: metaOf(twoLines()) });

    // Freshest line carrying PX_LAST is Cboe (SRC vs SRC-30s); the trade block travels together.
    expect(result.fields.PX_LAST).toBe(330.27);
    expect(result.fields.LAST_SIZE).toBe(100);
    // Only a venue/composite line may supply a book; Yahoo is a reference line.
    expect(result.fields.PX_BID).toBe(330.25);
    expect(result.fields.PX_ASK).toBe(330.28);
    // The primary (priority 10) line has no open/close; the merge falls down the primary order.
    expect(result.fields.PX_OPEN).toBe(330.24);
    expect(result.fields.PX_CLOSE_1D).toBe(333.08);
    // Volume is the max across lines of the session date; high max, low min.
    expect(result.fields.PX_VOLUME).toBe(16_600_000);
    expect(result.fields.PX_HIGH).toBe(331.6);
    expect(result.fields.PX_LOW).toBe(328.35);
    // Implied vol is Cboe only.
    expect(result.fields.IVOL_30D).toBe(24.427);
  });

  it('derives the change fields and never takes a provider value for them', () => {
    const result = recompose({ lines: twoLines(), meta: metaOf(twoLines()) });
    expect(result.fields.CHG_NET_1D).toBe(-2.81);
    expect(result.fields.CHG_PCT_1D).toBe(-0.8436);
    // First observation: there is no previous print, so there is no direction (not 'flat').
    expect(result.fields.TICK_DIR).toBeUndefined();

    const withPrev = recompose({
      lines: twoLines(),
      meta: metaOf(twoLines()),
      prev: { PX_LAST: 330.0 },
    });
    expect(withPrev.fields.TICK_DIR).toBe('up');
  });

  it('flags a cross-source divergence and names both lines', () => {
    const lines = twoLines();
    // 340 against 330.27 is 2.9 % — well beyond the 0.5 % threshold, inside the 60 s window.
    lines[5102] = yahooLine({ ...lines[5102]!.fields, PX_LAST: 340 });
    const result = recompose({ lines, meta: metaOf(lines) });

    expect(result.dq).toContain('CROSS_SOURCE_DIVERGENCE');
    expect(result.divergence).not.toBeNull();
    // The line we trust more is the lower priority number: Cboe.
    expect(result.divergence?.expected.mdLineId).toBe(5101);
    expect(result.divergence?.actual.mdLineId).toBe(5102);
    expect(result.divergence?.fraction).toBeGreaterThan(DIVERGENCE_TOLERANCE_PCT / 100);
  });

  it('reports no divergence when the two prices are more than the window apart', () => {
    const lines = twoLines();
    lines[5102] = yahooLine({ ...lines[5102]!.fields, PX_LAST: 340 }, SRC - 120_000);
    const result = recompose({ lines, meta: metaOf(lines) });
    expect(result.dq).not.toContain('CROSS_SOURCE_DIVERGENCE');
    expect(result.divergence).toBeNull();
    expect(divergentPair(lines, (id) => metaOf(lines)(id).priority, 0.005, 60_000)).toBeNull();
  });

  it('flags MISSING_CLOSE when a price has no previous close to change against', () => {
    const lines = { 5101: cboeLine({ PX_LAST: 330.27 }) };
    const result = recompose({ lines, meta: metaOf(lines) });
    expect(result.dq).toContain('MISSING_CLOSE');
    expect(result.fields.CHG_PCT_1D).toBeUndefined();
  });

  it('reads the session date in the instrument calendar zone', () => {
    // 20:30 ET on 2026-09-17 is 00:30 UTC on the 18th: a post-market print is still the 17th's
    // session, so its volume is comparable with the rest of the session's lines.
    const lateEt = Date.parse('2026-09-18T00:30:00.000Z');
    const lines = {
      5101: cboeLine({ PX_LAST: 330.27, PX_HIGH: 331.59, PX_VOLUME: 16_591_786 }, lateEt),
      // 19:30 ET, an hour earlier: the same session, but the previous UTC day.
      5102: yahooLine({ PX_LAST: 330.2, PX_HIGH: 332.4, PX_VOLUME: 16_600_000 }, lateEt - 3_600_000),
    };
    const utc = recompose({ lines, meta: metaOf(lines) });
    const et = recompose({ lines, meta: metaOf(lines), tz: 'America/New_York' });
    // In UTC the two lines fall on different calendar days, so the Yahoo line is out of session.
    expect(utc.fields.PX_HIGH).toBe(331.59);
    expect(et.fields.PX_HIGH).toBe(332.4);
    // PX_VOLUME carries the same session-date qualifier as the high and low, so it moves with them
    // rather than against them: excluded from the UTC composite, included in the zone-aware one.
    // This is the whole reason the plant passes the instrument's calendar zone — under the UTC
    // default a post-market print is filed against the next day and its session's own values stop
    // aggregating. Understating the volume by the last hour of an evening session is the small
    // error; the large one is the reverse rule, where a line still reporting YESTERDAY carries a
    // full session's count and publishes it as today's (see core/test/quote/merge.test.ts).
    expect(utc.fields.PX_VOLUME).toBe(16_591_786);
    expect(et.fields.PX_VOLUME).toBe(16_600_000);
  });

  it('empty input composes to nothing', () => {
    const result = recompose({ lines: {}, meta: () => defaultLineMeta('cboe.quotes') });
    expect(result.fields).toEqual({});
    expect(result.winner).toBeUndefined();
    expect(result.dq).toEqual([]);
  });
});

describe('plant/composite.ts — line metadata', () => {
  it('defaults Cboe to 10 and Yahoo to 20, as md_lines.priority does', () => {
    expect(defaultLineMeta('cboe.quotes').priority).toBe(10);
    expect(defaultLineMeta('cboe.quotes').lineKind).toBe('composite');
    expect(defaultLineMeta('yahoo.quote').priority).toBe(20);
    expect(defaultLineMeta('yahoo.quote').lineKind).toBe('reference');
    // Anything unknown takes the column default.
    expect(defaultLineMeta('acme.feed').priority).toBe(100);
  });

  it('lets a lookup override any member and keeps the defaults for the rest', () => {
    const meta = resolveLineMeta(5101, 'cboe.quotes', () => ({ priority: 5 }));
    expect(meta.priority).toBe(5);
    expect(meta.lineKind).toBe('composite');
    expect(meta.expectedIntervalMs).toBe(10_000);
    expect(resolveLineMeta(9, 'cboe.quotes', () => undefined)).toEqual(defaultLineMeta('cboe.quotes'));
  });

  it('a delayed line with no md_lines row is 15 minutes behind at source', () => {
    expect(delayMinFor({ ...defaultLineMeta('acme.feed') }, 'delayed')).toBe(15);
    expect(delayMinFor({ ...defaultLineMeta('acme.feed') }, 'realtime')).toBe(0);
    expect(delayMinFor(defaultLineMeta('cboe.quotes'), 'delayed')).toBe(15);
  });
});

describe('plant/composite.ts — the DQ sink', () => {
  it('is a no-op without a database and never throws', () => {
    expect(dbDivergenceSink(undefined)).toBe(NOOP_DQ_SINK);
    expect(() =>
      dbDivergenceSink(undefined)({
        subject: 'q:101',
        instrumentId: 101,
        sourceId: 'cboe.quotes',
        expected: 330.27,
        actual: 340,
        tolerancePct: DIVERGENCE_TOLERANCE_PCT,
        expectedMdLineId: 5101,
        actualMdLineId: 5102,
      }),
    ).not.toThrow();
  });
});
