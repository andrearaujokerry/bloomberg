/**
 * BUS-05 — composite merge across a Cboe line (md_lines.priority 10, venue, publishes a book and
 * IVOL) and a Yahoo line (priority 20, reference, no book). Per-field `ts.src` wins; provenance
 * stays in `lines[]`; the book is Cboe-only; volume is the max; divergence is flagged.
 */

import { describe, expect, it } from 'vitest';

import { mergeComposite, lineTime, utcSessionDate } from '../../src/quote/merge.js';
import type { MergeOptions } from '../../src/quote/merge.js';
import type { LineState } from '../../src/types/quote.js';

const CBOE = 5101;
const YAHOO = 5102;
const T = 1_789_496_786_000; // AAPL last_trade_time, 2026-09-15T18:26:26Z
const CAP = 1_789_497_688_000;

const priorityOf = (id: number): number => (id === CBOE ? 10 : 20);
const opts: MergeOptions = {
  lineKindOf: (id) => (id === CBOE ? 'venue' : 'reference'),
};

const cboe = (over: Partial<LineState> = {}): LineState => ({
  mdLineId: CBOE,
  sourceId: 'cboe.quotes',
  fields: {
    PX_LAST: 330.27,
    LAST_SIZE: 100,
    LAST_TRADE_TIME: T,
    PX_BID: 330.25,
    PX_ASK: 330.28,
    BID_SIZE: 40,
    ASK_SIZE: 120,
    PX_OPEN: 330.24,
    PX_HIGH: 331.59,
    PX_LOW: 328.35,
    PX_CLOSE_1D: 333.08,
    PX_VOLUME: 16_591_786,
    IVOL_30D: 24.427,
  },
  ts: { src: T, cap: CAP, pub: CAP },
  srcSeq: 15_972_883_317,
  provenanceId: 900_101,
  ...over,
});

const yahoo = (over: Partial<LineState> = {}): LineState => ({
  mdLineId: YAHOO,
  sourceId: 'yahoo.chart',
  fields: {
    PX_LAST: 330.31,
    PX_BID: 999, // Yahoo does not publish a book; a value here must never reach the composite
    PX_ASK: 999,
    PX_OPEN: 330.2,
    PX_HIGH: 331.7,
    PX_LOW: 328.9,
    PX_CLOSE_1D: 333.1,
    PX_VOLUME: 16_601_102,
    IVOL_30D: 99,
  },
  ts: { src: T + 15_000, cap: CAP + 2_000, pub: CAP + 2_000 },
  provenanceId: 900_102,
  ...over,
});

const lines = (...ls: LineState[]): Record<number, LineState> =>
  Object.fromEntries(ls.map((l) => [l.mdLineId, l]));

describe('mergeComposite — a cboe line and a yahoo line', () => {
  it('takes the trade block from the freshest line by ts.src, atomically', () => {
    const r = mergeComposite(lines(cboe(), yahoo()), priorityOf, opts);
    expect(r.winner?.mdLineId).toBe(YAHOO);
    expect(r.fields.PX_LAST).toBe(330.31);
    expect(r.fieldTs.PX_LAST).toBe(T + 15_000);
    // Yahoo carries no size/time: the composite does not borrow Cboe's older ones.
    expect(r.fields.LAST_SIZE).toBeUndefined();
    expect(r.fields.LAST_TRADE_TIME).toBeUndefined();
  });

  it('takes the trade block from cboe when it is the fresher line', () => {
    const r = mergeComposite(lines(cboe({ ts: { src: T + 30_000, cap: CAP, pub: CAP } }), yahoo()), priorityOf, opts);
    expect(r.winner?.mdLineId).toBe(CBOE);
    expect(r.fields.PX_LAST).toBe(330.27);
    expect(r.fields.LAST_SIZE).toBe(100);
    expect(r.fields.LAST_TRADE_TIME).toBe(T);
    expect(r.fieldTs.PX_LAST).toBe(T + 30_000);
  });

  it('breaks a ts.src tie by the lowest priority number (cboe 10 beats yahoo 20)', () => {
    const r = mergeComposite(lines(cboe(), yahoo({ ts: { src: T, cap: CAP + 5_000, pub: CAP + 5_000 } })), priorityOf, opts);
    expect(r.winner?.mdLineId).toBe(CBOE);
    expect(r.fields.PX_LAST).toBe(330.27);
  });

  it('consults srcSeq only after priority, and only inside one source', () => {
    // ARCHITECTURE §6.2 step 4: "ties: lowest priority". A srcSeq on the lower-priority line does
    // not promote it — two providers' counters are not in one number space.
    const cboeNoSeq: LineState = {
      mdLineId: CBOE,
      sourceId: 'cboe.quotes',
      fields: cboe().fields,
      ts: cboe().ts,
      provenanceId: 900_101,
    };
    const r = mergeComposite(
      lines(cboeNoSeq, yahoo({ ts: { src: T, cap: CAP, pub: CAP }, srcSeq: 5 })),
      priorityOf,
      opts,
    );
    expect(r.winner?.mdLineId).toBe(CBOE);
    expect(r.fields.PX_LAST).toBe(330.27);
    expect(r.fields.LAST_SIZE).toBe(100);
    expect(r.fields.LAST_TRADE_TIME).toBe(T);
    // Two lines of the same source at the same priority and the same time: the greater srcSeq wins.
    const early = cboe({ mdLineId: 5103, srcSeq: 1, fields: { PX_LAST: 1 } });
    const late = cboe({ mdLineId: 5104, srcSeq: 2, fields: { PX_LAST: 2 } });
    const same = mergeComposite(lines(early, late), () => 10, {
      lineKindOf: () => 'venue',
    });
    expect(same.winner?.mdLineId).toBe(5104);
    expect(same.fields.PX_LAST).toBe(2);
  });

  it('falls back to ts.cap for a line without a source timestamp', () => {
    const y = yahoo({ ts: { src: null, cap: T + 60_000, pub: T + 60_000 } });
    expect(lineTime(y)).toBe(T + 60_000);
    const r = mergeComposite(lines(cboe(), y), priorityOf, opts);
    expect(r.fields.PX_LAST).toBe(330.31);
    expect(r.fieldTs.PX_LAST).toBe(T + 60_000);
  });

  it('takes the book only from a venue/composite line that publishes one', () => {
    const r = mergeComposite(lines(cboe(), yahoo()), priorityOf, opts);
    expect(r.fields.PX_BID).toBe(330.25);
    expect(r.fields.PX_ASK).toBe(330.28);
    expect(r.fields.BID_SIZE).toBe(40);
    expect(r.fields.ASK_SIZE).toBe(120);
    expect(r.fieldTs.PX_BID).toBe(T);
    // A reference line alone leaves the book empty rather than inventing one.
    const only = mergeComposite(lines(yahoo()), priorityOf, opts);
    expect(only.fields.PX_BID).toBeUndefined();
    expect(only.fields.PX_ASK).toBeUndefined();
  });

  it('PX_VOLUME is the max, PX_HIGH the max and PX_LOW the min across the session', () => {
    const r = mergeComposite(lines(cboe(), yahoo()), priorityOf, opts);
    expect(r.fields.PX_VOLUME).toBe(16_601_102);
    expect(r.fieldTs.PX_VOLUME).toBe(T + 15_000);
    expect(r.fields.PX_HIGH).toBe(331.7);
    expect(r.fields.PX_LOW).toBe(328.35);
  });

  it('excludes a line still reporting the previous session from the volume, high and low', () => {
    // A line a session behind carries a FULL session's volume, so including it in the max would
    // publish yesterday's count as today's and stamp fieldTs a day in the past — which then reads
    // as a stale quote. ARCHITECTURE §6.2 step 4's volume bullet carries the same "same session
    // date" qualifier as its high/low bullet for exactly this reason.
    const stale = yahoo({
      fields: { PX_VOLUME: 99_000_000, PX_HIGH: 400, PX_LOW: 1 },
      ts: { src: T - 86_400_000, cap: CAP, pub: CAP },
    });
    expect(utcSessionDate(stale)).toBe('2026-09-14');
    expect(utcSessionDate(cboe())).toBe('2026-09-15');
    const r = mergeComposite(lines(cboe(), stale), priorityOf, opts);
    expect(r.fields.PX_VOLUME).toBe(16_591_786);
    expect(r.fieldTs.PX_VOLUME).toBe(T);
    expect(r.fields.PX_HIGH).toBe(331.59);
    expect(r.fields.PX_LOW).toBe(328.35);
  });

  it('honours an injected session-date function', () => {
    const r = mergeComposite(lines(cboe(), yahoo()), priorityOf, {
      ...opts,
      sessionDateOf: (l) => (l.mdLineId === CBOE ? 'A' : 'B'),
    });
    // Winner is yahoo (session 'B'); cboe's aggregates are excluded.
    expect(r.fields.PX_VOLUME).toBe(16_601_102);
    expect(r.fields.PX_HIGH).toBe(331.7);
    expect(r.fields.PX_LOW).toBe(328.9);
  });

  it('takes PX_OPEN, PX_CLOSE_1D and PX_OFFICIAL_CLOSE from the primary line even when it is older', () => {
    const r = mergeComposite(lines(cboe(), yahoo()), priorityOf, opts);
    expect(r.fields.PX_OPEN).toBe(330.24);
    expect(r.fields.PX_CLOSE_1D).toBe(333.08);
    expect(r.fieldTs.PX_CLOSE_1D).toBe(T);
    // Falls down the primary order when the primary line lacks the field.
    const noClose = cboe({ fields: { ...cboe().fields, PX_CLOSE_1D: undefined } });
    const r2 = mergeComposite(lines(noClose, yahoo()), priorityOf, opts);
    expect(r2.fields.PX_CLOSE_1D).toBe(333.1);
    // An explicit primary overrides the priority order.
    const r3 = mergeComposite(lines(cboe(), yahoo()), priorityOf, { ...opts, primaryMdLineId: YAHOO });
    expect(r3.fields.PX_CLOSE_1D).toBe(333.1);
    expect(r3.fields.PX_OPEN).toBe(330.2);
  });

  it('takes IVOL_30D from Cboe only', () => {
    const r = mergeComposite(lines(cboe(), yahoo()), priorityOf, opts);
    expect(r.fields.IVOL_30D).toBe(24.427);
    const only = mergeComposite(lines(yahoo()), priorityOf, opts);
    expect(only.fields.IVOL_30D).toBeUndefined();
    const custom = mergeComposite(lines(yahoo()), priorityOf, { ...opts, publishesIvol: () => true });
    expect(custom.fields.IVOL_30D).toBe(99);
  });

  it('never takes a derived field from a provider line', () => {
    const r = mergeComposite(
      lines(cboe({ fields: { ...cboe().fields, CHG_NET_1D: -2.81, CHG_PCT_1D: -0.8436, TICK_DIR: 'down' } })),
      priorityOf,
      opts,
    );
    expect(r.fields.CHG_NET_1D).toBeUndefined();
    expect(r.fields.CHG_PCT_1D).toBeUndefined();
    expect(r.fields.TICK_DIR).toBeUndefined();
  });

  it('applies field-level last-writer-wins to everything else', () => {
    const a = cboe({ fields: { PX_LAST: 1, VWAP: 10, OPT_IV: 0.2 } });
    const b = yahoo({ fields: { VWAP: 11 }, ts: { src: T + 1, cap: CAP, pub: CAP } });
    const r = mergeComposite(lines(a, b), priorityOf, opts);
    expect(r.fields.VWAP).toBe(11);
    expect(r.fieldTs.VWAP).toBe(T + 1);
    expect(r.fields.OPT_IV).toBe(0.2);
    expect(r.fieldTs.OPT_IV).toBe(T);
  });

  it('retains per-line provenance: the inputs are untouched and the winner is the line object itself', () => {
    const c = cboe();
    const y = yahoo();
    const before = JSON.stringify([c, y]);
    const r = mergeComposite(lines(c, y), priorityOf, opts);
    expect(JSON.stringify([c, y])).toBe(before);
    expect(r.winner).toBe(y);
    expect(r.winner?.provenanceId).toBe(900_102);
    expect(c.provenanceId).toBe(900_101);
    expect(c.srcSeq).toBe(15_972_883_317);
  });

  it('is deterministic regardless of insertion order', () => {
    const a = mergeComposite(lines(cboe(), yahoo()), priorityOf, opts);
    const b = mergeComposite(lines(yahoo(), cboe()), priorityOf, opts);
    expect(b.fields).toEqual(a.fields);
    expect(b.fieldTs).toEqual(a.fieldTs);
    expect(b.dq).toEqual(a.dq);
  });

  it('handles no lines and a single line', () => {
    const none = mergeComposite({}, priorityOf, opts);
    expect(none).toEqual({ fields: {}, fieldTs: {}, winner: undefined, dq: [] });
    const one = mergeComposite(lines(cboe()), priorityOf, opts);
    expect(one.winner?.mdLineId).toBe(CBOE);
    expect(one.fields).toEqual(cboe().fields);
    expect(one.dq).toEqual([]);
  });
});

describe('mergeComposite — data-quality flags', () => {
  it('flags CROSS_SOURCE_DIVERGENCE when PX_LAST differs by more than 0.5 % within 60 s', () => {
    const y = yahoo({ fields: { PX_LAST: 330.27 * 1.0051 } });
    expect(mergeComposite(lines(cboe(), y), priorityOf, opts).dq).toContain('CROSS_SOURCE_DIVERGENCE');
    // 0.5 % exactly is not a divergence.
    const edge = yahoo({ fields: { PX_LAST: 330.27 * 1.005 } });
    expect(mergeComposite(lines(cboe(), edge), priorityOf, opts).dq).not.toContain('CROSS_SOURCE_DIVERGENCE');
    // 61 s apart: not compared.
    const far = yahoo({ fields: { PX_LAST: 340 }, ts: { src: T + 61_000, cap: CAP, pub: CAP } });
    expect(mergeComposite(lines(cboe(), far), priorityOf, opts).dq).not.toContain('CROSS_SOURCE_DIVERGENCE');
    // Exactly 60 s apart: compared.
    const edgeT = yahoo({ fields: { PX_LAST: 340 }, ts: { src: T + 60_000, cap: CAP, pub: CAP } });
    expect(mergeComposite(lines(cboe(), edgeT), priorityOf, opts).dq).toContain('CROSS_SOURCE_DIVERGENCE');
    // The recorded lines agree (330.27 vs 330.31): no flag.
    expect(mergeComposite(lines(cboe(), yahoo()), priorityOf, opts).dq).toEqual([]);
  });

  it('flags MISSING_CLOSE when there is a last price but no previous close', () => {
    const r = mergeComposite(lines(cboe({ fields: { PX_LAST: 330.27 } })), priorityOf, opts);
    expect(r.dq).toEqual(['MISSING_CLOSE']);
    const rate = mergeComposite(lines(cboe({ fields: { RATE: 4.31 } })), priorityOf, opts);
    expect(rate.dq).toEqual([]);
  });
});
