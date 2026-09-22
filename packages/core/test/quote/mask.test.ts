/**
 * BUS-02 field masks: bitsets over the dictionary index (ARCHITECTURE §6.2). The dictionary has
 * more than 32 fields, so every test crosses word boundaries by construction.
 */

import { describe, expect, it } from 'vitest';

import { fieldIds } from '../../src/fields/dictionary.js';
import {
  MASK_BITS,
  MASK_WORDS,
  emptyMask,
  fieldAt,
  fieldIndex,
  maskAnd,
  maskClear,
  maskCount,
  maskEquals,
  maskHas,
  maskIsEmpty,
  maskOf,
  maskOr,
  maskSet,
  maskToIds,
} from '../../src/quote/mask.js';

const IDS = fieldIds();

describe('field index', () => {
  it('follows fieldIds() order exactly and sizes the mask from it', () => {
    expect(MASK_BITS).toBe(IDS.length);
    expect(MASK_BITS).toBeGreaterThan(64);
    expect(MASK_WORDS).toBe(Math.ceil(IDS.length / 32));
    IDS.forEach((id, i) => {
      expect(fieldIndex(id)).toBe(i);
      expect(fieldAt(i)).toBe(id);
    });
  });

  it('returns -1 / undefined outside the alphabet', () => {
    expect(fieldIndex('NOT_A_FIELD')).toBe(-1);
    expect(fieldAt(-1)).toBeUndefined();
    expect(fieldAt(MASK_BITS)).toBeUndefined();
  });
});

describe('maskOf / maskHas / maskToIds', () => {
  it('sets exactly the requested bits, across words, and reads them back in dictionary order', () => {
    const last = IDS[IDS.length - 1]!;
    const mid = IDS[40]!;
    const m = maskOf(['PX_LAST', last, mid, 'PX_BID']);
    expect(m.length).toBe(MASK_WORDS);
    expect(maskHas(m, 'PX_LAST')).toBe(true);
    expect(maskHas(m, 'PX_BID')).toBe(true);
    expect(maskHas(m, last)).toBe(true);
    expect(maskHas(m, mid)).toBe(true);
    expect(maskHas(m, 'PX_ASK')).toBe(false);
    expect(maskCount(m)).toBe(4);
    expect(maskToIds(m)).toEqual(['PX_BID', 'PX_LAST', last, mid].sort());
  });

  it('a subscription to PX_LAST does not carry PX_BID (BUS-02)', () => {
    const sub = maskOf(['PX_LAST']);
    const changed = maskOf(['PX_BID', 'PX_ASK']);
    expect(maskIsEmpty(maskAnd(sub, changed))).toBe(true);
    expect(maskToIds(maskAnd(sub, maskOf(['PX_LAST', 'PX_BID'])))).toEqual(['PX_LAST']);
  });

  it('ignores unknown ids and never reports them', () => {
    const m = maskOf(['NOT_A_FIELD', 'PX_LAST']);
    expect(maskToIds(m)).toEqual(['PX_LAST']);
    expect(maskHas(m, 'NOT_A_FIELD')).toBe(false);
    expect(maskSet(m, 'NOT_A_FIELD')).toBe(m);
    expect(maskCount(m)).toBe(1);
  });

  it('round-trips the entire alphabet', () => {
    const m = maskOf(IDS);
    expect(maskCount(m)).toBe(IDS.length);
    expect(maskToIds(m)).toEqual(IDS);
  });
});

describe('maskOr / maskAnd / maskClear / maskEquals', () => {
  it('ORs in place (fan-out) and returns the target', () => {
    const dirty = emptyMask();
    expect(maskIsEmpty(dirty)).toBe(true);
    const r = maskOr(dirty, maskOf(['PX_LAST']));
    expect(r).toBe(dirty);
    maskOr(dirty, maskOf(['PX_VOLUME', IDS[IDS.length - 1]!]));
    expect(maskToIds(dirty)).toEqual(['PX_LAST', 'PX_VOLUME', IDS[IDS.length - 1]!].sort());
  });

  it('ANDs into a fresh mask and leaves the operands alone', () => {
    const a = maskOf(['PX_LAST', 'PX_BID']);
    const b = maskOf(['PX_BID', 'PX_ASK']);
    const c = maskAnd(a, b);
    expect(maskToIds(c)).toEqual(['PX_BID']);
    expect(maskToIds(a)).toEqual(['PX_BID', 'PX_LAST']);
    expect(maskToIds(b)).toEqual(['PX_ASK', 'PX_BID']);
  });

  it('treats a shorter mask as zero-padded', () => {
    const short = new Uint32Array(1);
    maskSet(short, 'ASK_SIZE'); // index < 32
    const full = maskOf(['ASK_SIZE', IDS[IDS.length - 1]!]);
    expect(maskToIds(maskAnd(short, full))).toEqual(['ASK_SIZE']);
    const into = emptyMask();
    maskOr(into, short);
    expect(maskToIds(into)).toEqual(['ASK_SIZE']);
    expect(maskEquals(short, maskOf(['ASK_SIZE']))).toBe(true);
    expect(maskEquals(short, full)).toBe(false);
  });

  it('clears in place', () => {
    const m = maskOf(IDS);
    expect(maskClear(m)).toBe(m);
    expect(maskIsEmpty(m)).toBe(true);
    expect(maskCount(m)).toBe(0);
  });
});
