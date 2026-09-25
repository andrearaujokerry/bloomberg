// packages/web/src/grid/virtualiser.ts — which rows exist in the DOM, and which subjects the
// server is allowed to shed.
//
// CLIENT.md §10.5. Two jobs, both pure, so both are unit-testable without a DOM:
//
//  1. **The window.** Fixed row height, so the visible slice is arithmetic rather than measurement:
//     `start = floor(scrollTop / rowHeight) − overscan`, `end = start + ceil(height / rowHeight) +
//     2 × overscan`. Overscan is 10 rows, which is what stops a fast scroll showing a band of
//     nothing while React catches up.
//
//  2. **The essential set** (BUS-04, API.md §6.5). A subject whose row is on screen is *essential*;
//     one scrolled out of the window is not. That flag is the client's half of slow-consumer
//     shedding: when a session's socket backs up, the server sheds the non-essential subjects
//     first, and it can only do that if somebody told it which ones those are. A grid that never
//     called `setEssential` would leave every subject essential forever, and the server's only
//     remaining option under load would be to disconnect (§6.5's last row). So the window diff is
//     not a performance detail — it is what keeps a slow connection degrading instead of dropping.
//
// The diff is computed here and *applied* by `LiveGrid`, which calls the SDK. Nothing in this file
// touches the DOM, React or the socket.

import type { GridRow } from '../screen/types.js';
import type { VisibleRow } from './types.js';

/** CLIENT.md §10.5 — ten rows either side of the viewport. */
export const DEFAULT_OVERSCAN = 10;

/** The default row height in pixels at `normal` density (CLIENT.md §12.3). */
export const DEFAULT_ROW_HEIGHT = 20;

/**
 * What a container that reports zero height is taken to be showing.
 *
 * Zero is ambiguous: a genuinely collapsed panel, or a container that has not been laid out yet —
 * which is every container before the first layout pass, and every container in jsdom. Rendering
 * nothing for the ambiguous case means a grid that paints only once a `ResizeObserver` fires, so
 * the first frame of every real grid would be empty. One screenful is assumed instead, and the
 * first real measurement replaces it.
 */
export const FALLBACK_VISIBLE_ROWS = 24;

/** A half-open slice of the flat visible model: rows `start` (inclusive) to `end` (exclusive). */
export interface RowWindow {
  start: number;
  end: number;
}

/** What changed about the essential set between two windows. */
export interface EssentialDiff {
  added: string[];
  removed: string[];
}

export interface WindowInput {
  scrollTop: number;
  /** The viewport's inner height in pixels. Zero means "not laid out" — see {@link FALLBACK_VISIBLE_ROWS}. */
  viewportHeight: number;
  rowHeight: number;
  rowCount: number;
  overscan?: number;
}

/**
 * The rows to render. Clamped to `[0, rowCount]`, so an over-scrolled container (elastic scrolling,
 * a shrinking model) yields an empty window rather than negative indices.
 */
export function rowWindow(input: WindowInput): RowWindow {
  const { scrollTop, viewportHeight, rowCount } = input;
  const rowHeight = input.rowHeight > 0 ? input.rowHeight : DEFAULT_ROW_HEIGHT;
  const overscan = input.overscan ?? DEFAULT_OVERSCAN;
  const height = viewportHeight > 0 ? viewportHeight : rowHeight * FALLBACK_VISIBLE_ROWS;

  if (rowCount <= 0) return { start: 0, end: 0 };

  const first = Math.floor(Math.max(scrollTop, 0) / rowHeight);
  const start = Math.max(0, first - overscan);
  const span = Math.ceil(height / rowHeight) + 2 * overscan;
  const end = Math.min(rowCount, start + span);
  return { start, end: Math.max(start, end) };
}

/** The pixel offset of the rendered block, so `transform: translateY` places it (CLIENT.md §10.1). */
export function windowOffset(window: RowWindow, rowHeight: number): number {
  return window.start * rowHeight;
}

/** The total scrollable height, so the scrollbar reflects the whole model and not the window. */
export function totalHeight(rowCount: number, rowHeight: number): number {
  return Math.max(0, rowCount) * rowHeight;
}

/**
 * The subjects inside `window` — the essential set.
 *
 * Group headers have no subject and a collapsed group's rows are not in the visible model at all,
 * which is CLIENT.md §10.3's "collapsed groups … release their subjects' essential flag" falling
 * out of the model rather than being a second rule here.
 */
export function essentialSubjects(
  visible: readonly VisibleRow[],
  window: RowWindow,
  subjectOf: (row: GridRow) => string | null,
): Set<string> {
  const out = new Set<string>();
  for (let i = window.start; i < window.end; i += 1) {
    const entry = visible[i];
    if (entry?.kind !== 'row') continue;
    const subject = subjectOf(entry.row);
    if (subject !== null && subject !== '') out.add(subject);
  }
  return out;
}

/**
 * What to tell the SDK after a window change: the subjects that became essential and the ones that
 * stopped being. Both lists are usually empty — a scroll of one row moves one subject each way —
 * which is why this is cheap enough to run on every scroll event.
 */
export function diffEssential(
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>,
): EssentialDiff {
  const added: string[] = [];
  const removed: string[] = [];
  for (const subject of next) if (!previous.has(subject)) added.push(subject);
  for (const subject of previous) if (!next.has(subject)) removed.push(subject);
  return { added, removed };
}

/**
 * The essential set over time. Holds the last set, hands back the diff, and answers "is this
 * subject on screen?" — which is what a `status:'shed'` row asks before it re-subscribes.
 */
export class EssentialTracker {
  #current: ReadonlySet<string> = new Set<string>();

  /** Replace the set; returns what changed. A no-op change returns two empty arrays. */
  update(next: ReadonlySet<string>): EssentialDiff {
    const diff = diffEssential(this.#current, next);
    this.#current = next;
    return diff;
  }

  /** Everything currently on screen. */
  get current(): ReadonlySet<string> {
    return this.#current;
  }

  has(subject: string): boolean {
    return this.#current.has(subject);
  }

  /** Drop everything — on unmount, so the grid does not leave the world marked essential. */
  clear(): EssentialDiff {
    return this.update(new Set<string>());
  }
}
