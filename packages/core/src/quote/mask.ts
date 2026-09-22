/**
 * Field masks (BUS-02) — ARCHITECTURE §6.2.
 *
 * A field mask is a `Uint32Array` bitset over the dictionary's field index: bit `i` is the field at
 * position `i` of `fieldIds()` (sorted by id, so the index is stable for a given dictionary version).
 * The plant ORs a subject's changed-field mask into every subscribed session's dirty mask, and the
 * conflator ANDs the dirty mask with the subscription's field mask at flush time — O(words) per
 * subscriber, no string work on the hot path. A session subscribed to `PX_LAST` never sees
 * `PX_BID` because its bit is never set in the session's mask.
 *
 * Every mask this module allocates has the same length ({@link MASK_WORDS}), so the in-place
 * `maskOr` never has to grow its target. A mask from elsewhere that is shorter is still accepted:
 * missing words read as zero.
 *
 * Unknown ids have no bit: `fieldIndex` returns -1 and `maskOf` skips them. The gateway rejects
 * unknown ids with `FIELD_UNKNOWN` before a mask is ever built, so a silent skip here cannot lose a
 * subscribed field.
 */

import { fieldIds } from '../fields/dictionary.js';
import type { FieldId } from '../types/fields.js';

/** The dictionary order the bit positions follow. Computed once; the dictionary is immutable. */
const ORDERED_IDS: readonly FieldId[] = fieldIds();

const INDEX_OF: ReadonlyMap<FieldId, number> = new Map(ORDERED_IDS.map((id, i) => [id, i]));

/** Number of fields the mask alphabet covers (= `fieldIds().length`). */
export const MASK_BITS: number = ORDERED_IDS.length;

/** Words in every mask this module allocates: `ceil(MASK_BITS / 32)`. */
export const MASK_WORDS: number = Math.ceil(MASK_BITS / 32);

/** Position of `id` in `fieldIds()`, or -1 when the dictionary does not know it. */
export function fieldIndex(id: FieldId): number {
  return INDEX_OF.get(id) ?? -1;
}

/** The field id at bit position `index`, or `undefined` outside the alphabet. */
export function fieldAt(index: number): FieldId | undefined {
  return ORDERED_IDS[index];
}

/** A mask with no bit set. */
export function emptyMask(): Uint32Array {
  return new Uint32Array(MASK_WORDS);
}

/** A mask with the bit of every known id in `ids` set. Unknown ids are skipped. */
export function maskOf(ids: Iterable<FieldId>): Uint32Array {
  const m = emptyMask();
  for (const id of ids) {
    const i = INDEX_OF.get(id);
    if (i !== undefined) m[i >>> 5] = (m[i >>> 5] ?? 0) | (1 << (i & 31));
  }
  return m;
}

/** Sets the bit of `id` in place. A no-op for an unknown id. Returns `into`. */
export function maskSet(into: Uint32Array, id: FieldId): Uint32Array {
  const i = INDEX_OF.get(id);
  if (i !== undefined && i >>> 5 < into.length) {
    into[i >>> 5] = (into[i >>> 5] ?? 0) | (1 << (i & 31));
  }
  return into;
}

/** `into |= from`, in place. Words `from` has beyond `into`'s length are ignored. Returns `into`. */
export function maskOr(into: Uint32Array, from: Uint32Array): Uint32Array {
  const n = Math.min(into.length, from.length);
  for (let w = 0; w < n; w += 1) into[w] = (into[w] ?? 0) | (from[w] ?? 0);
  return into;
}

/** A new mask `a & b`. */
export function maskAnd(a: Uint32Array, b: Uint32Array): Uint32Array {
  const out = new Uint32Array(Math.max(a.length, b.length, MASK_WORDS));
  const n = Math.min(a.length, b.length);
  for (let w = 0; w < n; w += 1) out[w] = (a[w] ?? 0) & (b[w] ?? 0);
  return out;
}

/** Clears every bit in place. Returns `m`. */
export function maskClear(m: Uint32Array): Uint32Array {
  m.fill(0);
  return m;
}

export function maskIsEmpty(m: Uint32Array): boolean {
  for (const word of m) if (word !== 0) return false;
  return true;
}

export function maskHas(m: Uint32Array, id: FieldId): boolean {
  const i = INDEX_OF.get(id);
  if (i === undefined) return false;
  return (((m[i >>> 5] ?? 0) >>> (i & 31)) & 1) === 1;
}

/** Number of set bits. */
export function maskCount(m: Uint32Array): number {
  let n = 0;
  for (const word of m) {
    let v = word;
    while (v !== 0) {
      v &= v - 1;
      n += 1;
    }
  }
  return n;
}

/** Same bits set (a missing trailing word counts as zero). */
export function maskEquals(a: Uint32Array, b: Uint32Array): boolean {
  const n = Math.max(a.length, b.length);
  for (let w = 0; w < n; w += 1) if ((a[w] ?? 0) !== (b[w] ?? 0)) return false;
  return true;
}

/** The ids whose bit is set, in dictionary (sorted) order. */
export function maskToIds(m: Uint32Array): FieldId[] {
  const out: FieldId[] = [];
  const words = Math.min(m.length, MASK_WORDS);
  for (let w = 0; w < words; w += 1) {
    const v = m[w] ?? 0;
    if (v === 0) continue;
    for (let b = 0; b < 32; b += 1) {
      if (((v >>> b) & 1) === 1) {
        const id = ORDERED_IDS[w * 32 + b];
        if (id !== undefined) out.push(id);
      }
    }
  }
  return out;
}
