// packages/web/src/chart/events.ts — the event marker band: geometry, hit testing, focus order
// (CLIENT.md §11.7, CHRT-06).
//
// `ChartSpec.events[]` are the eight things that happened to the instrument — earnings, a dividend,
// a split, a headline, a filing, an index addition or deletion, an FOMC date — and they are drawn as
// single glyphs in a one-row band at the bottom of the main pane, at the slot of `t`. Their whole
// point is click-through: `Enter` on a focused marker runs `event.command` (`CACS` for a dividend,
// `AAPL US Equity CN` for a news marker), so a marker the keyboard cannot reach is a marker that
// does nothing at all.
//
// This file owns three things and draws nothing: where each glyph goes, what is under a pointer, and
// what `Ctrl+ArrowLeft/Right` moves to. `ChartCanvas` wires the keys and paints the glyphs; the
// renderer decides whether the band exists at all (`PaneLayout.eventBand` is absent once `E` has
// hidden it, §11.7). Keeping the geometry here is what makes TERM-06 structural: the mouse path
// calls {@link hitTestEventMarkers} and the key path calls {@link nextEventMarker}, and both of them
// end up at the same `EventMarker` with the same slot, so a click cannot reach a marker a key
// cannot.
//
// **A marker carries its whole event, not just an index into `spec.events`.** The index is kept too,
// because `ChartFocus { kind: 'event'; index }` is expressed in spec indices, but the key handler
// reads `marker.event.command` rather than indexing the spec a second time. Two arrays and an index
// that has to agree between them is how `Enter` ends up running the wrong function after a spec
// rebuild drops one event.

import type { ChartFonts, ChartSpec, Hit, Rect } from './types.js';

/** One entry of `ChartSpec.events[]` — derived, so an added field arrives here for free. */
export type ChartEvent = NonNullable<ChartSpec['events']>[number];

/** The eight marker kinds (§11.7). */
export type ChartEventKind = ChartEvent['kind'];

/**
 * The glyph per kind: `E D S N F + − ●` (§11.7).
 *
 * A `satisfies Record<ChartEventKind, string>` table, for the reason `SERIES_TYPE_TABLE` in
 * `types.ts` is one: a ninth kind added to `ChartSpec.events[].kind` becomes a compile error here
 * rather than a marker that draws as `undefined` in a trader's event band.
 *
 * The last two are not the ASCII hyphen and a lowercase o. `−` is U+2212 MINUS SIGN, which is the
 * width of `+` in a tabular-figures mono font so that an index add and an index drop sit on the same
 * grid, and `●` is U+25CF BLACK CIRCLE, which is the FOMC dot §11.7 spells.
 */
const EVENT_GLYPH_TABLE = {
  earnings: 'E',
  dividend: 'D',
  split: 'S',
  news: 'N',
  filing: 'F',
  index_add: '+',
  index_drop: '−',
  fomc: '●',
} as const satisfies Record<ChartEventKind, string>;

export const EVENT_GLYPH: Readonly<Record<ChartEventKind, string>> =
  Object.freeze(EVENT_GLYPH_TABLE);

/** The eight kinds, in the order §11.7 lists them. */
export const EVENT_KINDS: readonly ChartEventKind[] = Object.freeze(
  Object.keys(EVENT_GLYPH_TABLE) as ChartEventKind[],
);

/**
 * The narrowest hit rect a marker may have, in CSS px.
 *
 * A glyph is one character wide, and at the compact density one character is under 6 px — a target
 * the mouse misses more often than it hits. The rect is widened to this without moving its centre,
 * which costs nothing (the glyph is still drawn centred on the slot) and makes a marker clickable.
 * The keyboard path is unaffected: it never measures anything.
 */
export const MARKER_MIN_HIT_PX = 9;

/**
 * One marker, placed.
 *
 * `index` is the index in `ChartSpec.events` — what `ChartFocus { kind: 'event' }` and
 * `Hit { kind: 'event' }` carry. `row` is 0 for a marker in the band itself and counts upward for
 * the ones stacked above it.
 */
export interface EventMarker {
  readonly index: number;
  readonly event: ChartEvent;
  /** The integer slot of `event.t` on the `TradingDayIndex`. */
  readonly slot: number;
  readonly row: number;
  /** The hit rect, in CSS px relative to the canvas origin. */
  readonly rect: Rect;
  readonly glyph: string;
}

/**
 * What {@link layoutEventMarkers} needs. Every member is a fact the renderer already has.
 *
 * `slotOf` is the `TradingDayIndex` and `x` is `SeriesScales.x`; they are passed as functions rather
 * than imported because this file does not own either module and does not need to: an event's place
 * on the axis is entirely determined by those two answers.
 */
export interface EventBandInput {
  /** `PaneLayout.eventBand` — the one-row strip at the bottom of the main pane. */
  readonly band: Rect;
  /** The main pane's `plot` rect. The upward stack may not leave it. */
  readonly plot: Rect;
  readonly fonts: ChartFonts;
  /**
   * Slot of a timestamp; negative or non-finite when `t` is on no slot of this axis.
   *
   * This is `TradingDayIndex.slotOf` — the EXACT one, which answers `-1` for a timestamp that is not
   * a bar — and deliberately not its `nearestSlot`, which clamps into the axis. An event has a real
   * instant behind it: a dividend's ex-date is a session, so on an axis that loaded that session it
   * matches a bar exactly, and on an axis that did not it belongs nowhere. `nearestSlot` would put
   * a 2021 dividend on the first bar of a one-month chart, which reads as a dividend that day.
   */
  slotOf(t: number): number;
  /** Slot → CSS px x, the same function the series are drawn with. */
  x(slot: number): number;
}

/**
 * Place every event of a spec, sorted by slot and stacked where several share one.
 *
 * §11.7 asks for a ONE-ROW band, and also for markers to be stacked when several share a slot. Both
 * hold: the band is one row tall, so the price pane pays one line of height for it whatever happens,
 * and a slot with an earnings release and three dividends on it stacks the extras UPWARD out of the
 * band and over the plot. The alternatives were to shrink the glyphs until nothing was legible, or
 * to draw the first and lose the rest — and losing the rest means losing its `command`, which is the
 * only thing a marker is for.
 *
 * The stack is clamped to the rows that fit inside `plot`. Beyond that the markers share the top
 * row: they overlap visually and {@link hitTestEventMarkers} can only return the first of them, but
 * every one of them stays in the focus order, so `Ctrl+ArrowRight` still reaches an occluded marker
 * and `Enter` still runs its command. A target the mouse cannot reach is a limitation; one the
 * keyboard cannot reach would be a TERM-06 failure.
 *
 * An event whose `t` has no slot is DROPPED rather than placed at slot 0. A dividend whose ex-date
 * precedes the first loaded bar belongs to no position on this axis, and drawing it at the left edge
 * would put it on a day it did not happen.
 */
export function layoutEventMarkers(
  events: readonly ChartEvent[],
  input: EventBandInput,
): EventMarker[] {
  const rowHeight = Math.max(1, input.fonts.lineHeightPx);
  const width = Math.max(MARKER_MIN_HIT_PX, input.fonts.digitPx + 2);
  // Row 0 sits in the band; each further row is one line higher. The band is at the bottom of the
  // plot, so the rows that fit are the band's own plus however many lines separate it from the top.
  const maxRows = Math.max(1, 1 + Math.floor(Math.max(0, input.band.y - input.plot.y) / rowHeight));

  const placed: { index: number; event: ChartEvent; slot: number }[] = [];
  for (const [index, event] of events.entries()) {
    const slot = input.slotOf(event.t);
    if (!Number.isFinite(slot) || slot < 0) continue;
    placed.push({ index, event, slot: Math.round(slot) });
  }
  // Slot order, then spec order within a slot: the focus order IS the array order, and a reader
  // moving right through the band moves forward through time. `sort` is stable in ES2019 and later,
  // which is what makes "then spec order" true without a second key.
  placed.sort((a, b) => a.slot - b.slot);

  const markers: EventMarker[] = [];
  let runSlot = Number.NaN;
  let runCount = 0;
  for (const entry of placed) {
    if (entry.slot === runSlot) runCount += 1;
    else {
      runSlot = entry.slot;
      runCount = 0;
    }
    const row = Math.min(runCount, maxRows - 1);
    const centre = input.x(entry.slot);
    markers.push({
      index: entry.index,
      event: entry.event,
      slot: entry.slot,
      row,
      rect: {
        x: centre - width / 2,
        y: input.band.y - row * rowHeight,
        w: width,
        h: rowHeight,
      },
      glyph: EVENT_GLYPH[entry.event.kind],
    });
  }
  return markers;
}

/**
 * The marker under a pointer, as a `Hit` — `Renderer.hitTest`'s event case.
 *
 * Reported in data coordinates (the spec index and the slot) and not in pixels, which is what lets a
 * click and `Ctrl+ArrowRight` hand the same thing to the same handler (§11.1).
 *
 * The first containing rect wins. Rows do not overlap, so "first" only decides the clamped-overflow
 * case of {@link layoutEventMarkers}, and there the lowest spec index — the earliest event the
 * payload listed — is the one a click gets.
 */
export function hitTestEventMarkers(
  markers: readonly EventMarker[],
  px: number,
  py: number,
): Hit | null {
  for (const marker of markers) {
    const r = marker.rect;
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
      return { kind: 'event', index: marker.index, slot: marker.slot };
    }
  }
  return null;
}

/**
 * The marker `Ctrl+ArrowLeft/Right` moves to, or `null` when there is none in that direction.
 *
 * `null` rather than wrapping or standing still, and the distinction matters to the caller: focus
 * stays where it is and the crosshair does not move, which is what a trader stepping through
 * earnings dates expects at the last one. Wrapping from the last event to the first would jump the
 * crosshair across ten years of chart on a key press that reads as "next".
 *
 * `current` is a `ChartSpec.events` index — `ChartFocus { kind: 'event' }`'s own — or `null` when
 * nothing is focused yet, in which case `Ctrl+ArrowRight` takes the first marker and
 * `Ctrl+ArrowLeft` the last. A `current` that is not in `markers` (its event fell off the axis on a
 * range change) is treated the same way, because focus on a marker that no longer exists has to go
 * somewhere and the end of the band is where the user was heading.
 */
export function nextEventMarker(
  markers: readonly EventMarker[],
  current: number | null,
  direction: 1 | -1,
): EventMarker | null {
  if (markers.length === 0) return null;
  const at = current === null ? -1 : markers.findIndex((m) => m.index === current);
  if (at === -1) return direction === 1 ? (markers[0] ?? null) : (markers[markers.length - 1] ?? null);
  return markers[at + direction] ?? null;
}

/** The placed marker for one `ChartSpec.events` index, or `null` when it has no slot. */
export function markerOfEvent(
  markers: readonly EventMarker[],
  index: number,
): EventMarker | null {
  return markers.find((m) => m.index === index) ?? null;
}
