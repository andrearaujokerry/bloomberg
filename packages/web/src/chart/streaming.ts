// packages/web/src/chart/streaming.ts — the forming bar and the last price, applied in place
// (CLIENT.md §11.5, CHRT-02, TERM-12).
//
// `Renderer.applyStream` marks only the last two slots dirty and redraws that clip rect, over the
// growable columns IT owns. This file is the other half: the wire. It decodes one `UpdateEvent` into
// the patches a spec's `live` bindings imply, and it carries the subject's staleness verdict along
// with them. Nothing here touches a canvas or the DOM, and nothing here stores a bar — one owner of
// the columns, which is the renderer (see {@link ChartStream}).
//
// ## THE b1m: CONTRACT (WORKPLAN.md open question 10)
//
// WORKPLAN open question 10 records that the contract between `ChartSpec.live` and the WP-13
// `QuoteCache` for the forming bar is written down nowhere and that WP-13 and WP-14 must agree it.
// WP-13 is merged, so it is written down here, and {@link formingBarFrom} is the only place the
// client reads it.
//
// The subject is `b1m:<instrumentId>` — family `b1m`, id the instrument id
// (`server/src/plant/subjects.ts`, `ParsedSubject.family === 'b1m'`; `GIP/Screen.tsx` builds exactly
// that string). Its subscribed field set is API.md §6.1 L853:
// `BAR_TS PX_OPEN PX_HIGH PX_LOW PX_LAST PX_VOLUME IS_FINAL`. The mapping onto
// `StreamPatch['bar']` is:
//
// | Bar | Field | Source of truth |
// | --- | --- | --- |
// | `t` | `BAR_TS`, else `QuoteView.ts.src` | `core/fields/defs/price.ts#BAR_TS`: "start of the interval a forming intraday bar covers, in UTC". Epoch ms, as a number — `FieldValue` has no date type and the plant publishes the instant, not an ISO string. |
// | `o` | `PX_OPEN`, else `c` | A bar whose first print is its only print has one price, and `null` open would draw a gap where there is a trade. |
// | `h` | `PX_HIGH`, else `c` | as above |
// | `l` | `PX_LOW`, else `c` | as above |
// | `c` | `PX_LAST` | Required. No close, no bar: the close is the only field every series type reads. |
// | `v` | `PX_VOLUME`, else `0` | Volume is absent on a subject whose line does not report it; zero is the honest figure for "no volume reported this minute", and it is what the histogram already draws for an untraded minute. |
// | `final` | `IS_FINAL === true` | `core/fields/defs/derived.ts#IS_FINAL`: "The in-progress bar of the current interval is always false". Strictly `=== true`, so an absent field means forming — the safe direction, because a bar wrongly believed final stops updating for the rest of the minute with nothing to say why. |
//
// **The `ts.src` fallback is not defensive padding.** The one producer of this subject in this build
// — `server/src/providers/yahoo/adapter.ts`, the `b${granularity}:` update — publishes
// `ts: { src: newest.barTs, … }` and does NOT put `BAR_TS` in `fields`; its own comment says the
// bar's instant rides `ts.src` because `BAR_TS` has no `QuoteFields` slot. API.md §6.1 nevertheless
// lists `BAR_TS` among the subject's fields, and `server/src/functions/GIP/resolve.ts#formingBarOf`
// reads `f.BAR_TS`. Both are therefore live paths, and reading the field first and the timestamp
// second is what makes this file correct against either.
//
// The two refusals below are `formingBarOf`'s guards, mirrored here so that the chart and GIP's own
// `forming` payload key cannot disagree about which bar is forming:
//
//   * a bar whose `t` is BEFORE the last drawn slot is refused (`behind-the-last-slot`) — the plant
//     is behind the store, and applying it would redraw an earlier minute with newer numbers;
//   * a slot sealed by `final: true` is never reopened (`sealed`) — §11.5's "`final:true` freezes
//     it". The same `BAR_TS` arriving again after the seal is a conflated repeat, not a revision.
//
// `q:<instrumentId>` is the other binding (`replace-last`): the binding's `field` — `PX_LAST` in
// every spec that ships — is read off the same `QuoteView` and rewrites the last `y`. For
// `append-forming-bar` the binding's `field` names nothing but the close column; the rest of the bar
// comes from the six fields above, and a bar binding is not a licence to plot an arbitrary field.
//
// ## Why the verdict travels with the patch
//
// {@link LiveUpdate.st} carries the `QuoteView`'s `ValueState` because WP-13 shipped the opposite: a
// gap grey that never reached a reader, so cells went on saying "live" about numbers the client had
// refused to apply. A forming bar drawn from a subject the 1 s sweep has ruled `stale` must not be
// legended as live either (TERM-12), and the legend cannot ask the cache — it is handed the result of
// the frame. It is not optional: a patch exists because a frame arrived, and that frame had a
// verdict.

import type { FieldId, ValueState } from '@terminal/sdk';
import type { QuoteView, UpdateEvent } from '@terminal/sdk';

import type { ChartSeries, ChartSpec, StreamPatch, Viewport } from './types.js';

/* -------------------------------------------------------------------------------------------- */
/* The contract, as data                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * The seven fields a `b1m:` subscription names (API.md §6.1), in that order.
 *
 * Exported because two other places need the same list and neither should retype it: a panel's
 * `LiveSpec` subscribes them, and `streaming.test.ts` asserts this file reads every one of them.
 */
export const FORMING_BAR_FIELDS: readonly FieldId[] = Object.freeze([
  'BAR_TS',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_LAST',
  'PX_VOLUME',
  'IS_FINAL',
]);

/** The bar half of {@link StreamPatch}, named so the reader of a signature can see what it is. */
export type FormingBar = Extract<StreamPatch, { mode: 'append-forming-bar' }>['bar'];

/** One `ChartSeries.live` binding, with the series it belongs to. */
export interface LiveBinding {
  readonly seriesId: string;
  readonly subject: string;
  readonly field: FieldId;
  readonly mode: NonNullable<ChartSeries['live']>['mode'];
}

/**
 * Every live binding in a spec, in series order.
 *
 * A separate function from {@link ChartStream} because the panel's subscription list is built from
 * the same information before any canvas exists: the shell has to `sub` the subjects a spec names
 * whether or not the chart has mounted yet (CLIENT.md §9).
 */
export function liveBindings(spec: ChartSpec): LiveBinding[] {
  const out: LiveBinding[] = [];
  for (const series of spec.series) {
    const live = series.live;
    if (live === undefined) continue;
    out.push({ seriesId: series.id, subject: live.subject, field: live.field, mode: live.mode });
  }
  return out;
}

/** A `FieldValue` that is a usable number, or `null`. `NaN` is not a price. */
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The forming bar a `b1m:` view describes, or `null` when it describes none.
 *
 * The table in the file header is this function; it is not repeated here. `null` is returned for a
 * view with no close, because every series type reads the close and a bar without one cannot be
 * drawn — not because a missing close is unexpected. It is exactly what an entitlement denial or a
 * blanked composite looks like on the wire (`f.PX_LAST === null`, API.md §6.3 step 4), and refusing
 * to draw is the correct answer to both (ENTL-05).
 */
export function formingBarFrom(view: QuoteView): FormingBar | null {
  const close = finiteNumber(view.f.PX_LAST);
  if (close === null) return null;
  const t = finiteNumber(view.f.BAR_TS) ?? view.ts.src;
  if (t === null || !Number.isFinite(t)) return null;
  return {
    t,
    o: finiteNumber(view.f.PX_OPEN) ?? close,
    h: finiteNumber(view.f.PX_HIGH) ?? close,
    l: finiteNumber(view.f.PX_LOW) ?? close,
    c: close,
    v: finiteNumber(view.f.PX_VOLUME) ?? 0,
    final: view.f.IS_FINAL === true,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* One frame → the patches it implies                                                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * One patch, with the verdict the cache reached about the subject it came off (TERM-12).
 *
 * The verdict travels WITH the patch because the legend cannot ask the cache: `ChartCanvas` is handed
 * `UpdateEvent`s through a port and has no `QuoteCache` (see its `ChartLiveSource`). CLIENT.md §12.1
 * names the chart legend as one of the four surfaces that must apply the `ValueState` mapping, and
 * rule (1) is that a value whose subject is resyncing or whose socket has closed renders `stale`
 * within a second — a chart that went on showing a stale number in white would be WP-13's shipped
 * blocker again, one surface over.
 */
export interface LiveUpdate {
  readonly patch: StreamPatch;
  readonly st: ValueState;
}

/**
 * Every live series of one spec, and the patches one frame implies for them (§11.5).
 *
 * **This class decodes and does not store, and that is the resolution of a duplication.** It used to
 * carry growable columns of its own (`LiveSeriesBuffer`) with a second copy of §11.5's three rules —
 * the same-timestamp overwrite, the `IS_FINAL` seal, the behind-the-last-slot refusal — while
 * `Renderer.applyStream` implemented the same three over the arrays it actually draws from. Nothing
 * in the product ever called this half: the component read `patchesFrom` and handed the patch to the
 * renderer. So twenty-five tests proved a contract no chart used, and two implementations of one
 * contract drift. The renderer owns the columns, because it owns the dirty region and the draw; this
 * file owns the WIRE — the `b1m:` field mapping in the header, the bindings, and the `st` that has to
 * reach the legend.
 */
export class ChartStream {
  readonly #bindings: LiveBinding[];
  readonly #bySubject = new Map<string, LiveBinding[]>();

  constructor(spec: ChartSpec) {
    // Every binding names a series of this spec by construction — `liveBindings` reads them OFF the
    // series — so there is no unbound-series case to refuse here. A patch for a series the RENDERER
    // does not hold is refused there, which is the only place the two can diverge (`applyStream`).
    this.#bindings = liveBindings(spec);
    for (const binding of this.#bindings) {
      const list = this.#bySubject.get(binding.subject);
      if (list === undefined) this.#bySubject.set(binding.subject, [binding]);
      else list.push(binding);
    }
  }

  /** The spec's live bindings, in series order. */
  get bindings(): readonly LiveBinding[] {
    return this.#bindings;
  }

  /**
   * The patches one `UpdateEvent` implies — zero, one, or one per series bound to its subject.
   *
   * Two charts on the same instrument share the subject, and so do a candle series and a VWAP line
   * on the same panel; the fan-out is per binding, which is why a `Map<subject, LiveBinding[]>`
   * rather than a single lookup.
   */
  updatesFrom(e: UpdateEvent): LiveUpdate[] {
    const bindings = this.#bySubject.get(e.subject);
    if (bindings === undefined) return [];
    const st = e.state.st;
    const out: LiveUpdate[] = [];
    for (const binding of bindings) {
      if (binding.mode === 'append-forming-bar') {
        const bar = formingBarFrom(e.state);
        if (bar !== null) out.push({ patch: { seriesId: binding.seriesId, mode: binding.mode, bar }, st });
        continue;
      }
      const y = finiteNumber(e.state.f[binding.field]);
      if (y === null) continue;
      const t = e.state.ts.src ?? e.state.ts.cap;
      out.push({ patch: { seriesId: binding.seriesId, mode: 'replace-last', t, y }, st });
    }
    return out;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Auto-follow (§11.5)                                                                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * How close to the last slot the right edge must be to count as being ON it.
 *
 * A millionth of a slot, which is far under one device pixel at any zoom this engine offers. It is
 * not slack for a sloppy caller: `Viewport` bounds are fractional because a zoom is anchored on the
 * crosshair (§11.1), so a viewport that reached the last slot through a chain of zooms can land a
 * hair short of it in binary floating point. A chart that then refused to follow would quietly stop
 * updating for a user who had done nothing but zoom, which is the failure this tolerance prevents.
 */
const FOLLOW_EPSILON = 1e-6;

/**
 * The viewport after an append — pinned to the new last slot, or exactly where it was (§11.5).
 *
 * "When the viewport's right edge is the last slot it stays pinned on append; otherwise the view is
 * unchanged." A chart the user scrolled back to look at March must not jump to today because a bar
 * closed, so the unpinned case returns THE SAME OBJECT: identity is how the renderer knows the view
 * did not move and skips marking the base canvas dirty.
 *
 * `lastSlotBefore` is the last slot as it was before the append, because pinning is a statement
 * about where the user was looking when the bar arrived, not about where the data now ends.
 */
export function followOnAppend(
  view: Viewport,
  lastSlotBefore: number,
  appended: number,
): Viewport {
  if (appended <= 0) return view;
  if (view.slot1 < lastSlotBefore - FOLLOW_EPSILON) return view;
  return { slot0: view.slot0 + appended, slot1: view.slot1 + appended };
}
