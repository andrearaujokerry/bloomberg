// packages/web/src/grid/keyboard.ts — the grid region's key bindings (CLIENT.md §5.3 L384-398).
//
// A grid a user cannot drive without a mouse is not a terminal grid (TERM-06: "mouse-only
// affordances are defects"). Everything the grid can do — move, page, select, open a row, sort,
// group, collapse a group, reorder a column — is here, as a pure function from a keystroke and a
// focus position to an ACTION. Nothing in this file touches the DOM, holds state, or renders.
//
// That split is what makes the acceptance test meaningful. `LiveGrid` owns focus, selection and the
// virtual window; this module owns the decision of what a key means. If the decision lived inside
// the component it could only be tested through the component, and a test that drives a component
// it also configured proves the component agrees with itself. Here the mapping is a table with a
// test of its own, and the component is one caller of it — the one the acceptance row drives with
// `user-event`, through real DOM, at the end of this file's contract rather than instead of it.
//
// Keys are matched with `keyboard/keymap.ts#matchesKey`, on `KeyboardEvent.code` with a fallback to
// `key`, so `S` is the same physical key on AZERTY and the modifier rules (`Ctrl` never `Meta`) are
// the ones the rest of the terminal already uses. A second matcher here would be a second answer to
// "did the user press Ctrl+End".
//
// ## What this module deliberately does NOT claim
//
// `Ctrl+I` (provenance), `Ctrl+E` (grid CSV export), `Ctrl+L` (command line), `Tab`/`Shift+Tab`
// (region) and `Escape` (cancel) are RESERVED keys (FUNCTIONS.md §2.6, `keyboard/keymap.ts`). They
// are listed in CLIENT.md §5.3's grid table because they act on the grid, not because the grid
// handles them: the panel's dispatcher owns them, and it reads the focused element — which is why
// `LiveGrid`'s cells must carry `data-prov-idx` (registry.ts). {@link gridKeyAction} returns `null`
// for all of them, so the event keeps bubbling and the one reserved handler answers. A grid that
// consumed `Ctrl+I` itself would answer for the focused CELL in one widget and the focused NODE in
// every other, and the two answers would drift.

import { matchesKey } from '../keyboard/keymap.js';
import type { KeyEventLike } from '../keyboard/keymap.js';

/* -------------------------------------------------------------------------------------------- */
/* The model the bindings read                                                                    */
/* -------------------------------------------------------------------------------------------- */

/** Where the focus is: an index into the VISIBLE rows, and an index into the columns. */
export interface GridFocus {
  row: number;
  col: number;
}

/**
 * The part of a visible row navigation needs to know about.
 *
 * `GridModel`'s `VisibleRow` (a data row, or a group header carrying its count and aggregates)
 * satisfies this structurally, so the grid passes its own array straight in and there is no second
 * row type to keep in step.
 */
export interface GridKeyRow {
  readonly kind: 'row' | 'group';
  /** Group headers only. */
  readonly collapsed?: boolean | undefined;
}

export interface GridKeyEnv {
  /** The visible rows INCLUDING group headers and EXCLUDING the rows of collapsed groups. */
  readonly rows: readonly GridKeyRow[];
  readonly columnCount: number;
  /** Rows per `PageUp`/`PageDown` — the virtualiser's window height, at least 1. */
  readonly pageSize: number;
  /**
   * The screen pages its own data (`ScreenSpec.page`), so `PageUp`/`PageDown` are PAGE FWD/BACK and
   * not a scroll (CLIENT.md §5.3). The grid asks for the next page instead of moving inside a page
   * it has all of.
   */
  readonly pageable: boolean;
  readonly selectable: boolean;
}

/* -------------------------------------------------------------------------------------------- */
/* Actions                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * What a keystroke asks the grid to do.
 *
 * `focus` carries the ABSOLUTE target rather than a delta: clamping, the group-header stops and the
 * page arithmetic are decided here, where they can be tested, instead of in the component where
 * each caller would clamp slightly differently.
 */
export type GridAction =
  | { kind: 'focus'; focus: GridFocus }
  | { kind: 'page'; dir: 'fwd' | 'back' }
  | { kind: 'select'; extend: boolean }
  | { kind: 'open'; nextPanel: boolean }
  | { kind: 'toggle-group' }
  | { kind: 'sort' }
  | { kind: 'freeze-sort' }
  | { kind: 'group-cycle' }
  | { kind: 'move-column'; delta: -1 | 1 };

/* -------------------------------------------------------------------------------------------- */
/* Navigation arithmetic                                                                          */
/* -------------------------------------------------------------------------------------------- */

const clamp = (n: number, max: number): number => (n < 0 ? 0 : n > max ? max : n);

/**
 * Clamp a focus into the grid.
 *
 * Both axes clamp rather than wrap. A grid is a surface, not a carousel: `ArrowDown` on the last
 * row of a 1 000-row monitor jumping to row 1 would move the eye a screen-height away from where
 * the hand expected, and `ArrowRight` off the last column wrapping into the next row would silently
 * change which security is selected. `Ctrl+Home`/`Ctrl+End` are how you cross the whole grid.
 */
export function clampFocus(focus: GridFocus, env: GridKeyEnv): GridFocus {
  return {
    row: clamp(focus.row, Math.max(0, env.rows.length - 1)),
    col: clamp(focus.col, Math.max(0, env.columnCount - 1)),
  };
}

/**
 * Move `delta` rows.
 *
 * Group headers are ordinary stops on the way: they are focusable and they carry the count and the
 * aggregates (CLIENT.md §5.3), so `ArrowDown` through a grouped grid reads header, rows, header,
 * rows — which is the structure of the grid, spoken. Skipping them would make the aggregates
 * unreachable by keyboard, and they are the only place the group's totals appear.
 */
export function moveRow(focus: GridFocus, env: GridKeyEnv, delta: number): GridFocus {
  return clampFocus({ row: focus.row + delta, col: focus.col }, env);
}

export function moveColumn(focus: GridFocus, env: GridKeyEnv, delta: number): GridFocus {
  return clampFocus({ row: focus.row, col: focus.col + delta }, env);
}

/** The row under the focus, or `undefined` in an empty grid. */
export function rowAt(env: GridKeyEnv, index: number): GridKeyRow | undefined {
  return env.rows[index];
}

/** Is the focused row a group header? */
export function onGroupHeader(focus: GridFocus, env: GridKeyEnv): boolean {
  return rowAt(env, focus.row)?.kind === 'group';
}

/* -------------------------------------------------------------------------------------------- */
/* The binding table                                                                              */
/* -------------------------------------------------------------------------------------------- */

/**
 * Map one keystroke to one action, or `null` when the grid does not claim the key.
 *
 * `null` matters as much as an action: it is what lets a reserved key reach the panel, a screen
 * binding reach `dispatch.ts`, and a printable character reach the command line (CLIENT.md §5.1
 * rule 5 — typing `IBM` anywhere but a form goes to the command line). `S` and `G` are the two
 * printable exceptions the design names, and they are claimed only here, in the grid region.
 */
export function gridKeyAction(
  e: KeyEventLike,
  focus: GridFocus,
  env: GridKeyEnv,
): GridAction | null {
  // ── Column reordering (before the plain arrows: the modifier changes the meaning) ────────────
  if (matchesKey(e, 'Ctrl+ArrowLeft')) return { kind: 'move-column', delta: -1 };
  if (matchesKey(e, 'Ctrl+ArrowRight')) return { kind: 'move-column', delta: 1 };

  // ── Whole-grid jumps ────────────────────────────────────────────────────────────────────────
  // CLIENT.md §5.3 calls these "first / last row" and TESTING.md §13 calls them "grid start / end".
  // Going to the corner satisfies both readings and is the only one that is reversible: from the
  // last row's last column, `Ctrl+Home` returns to exactly where a fresh grid starts.
  if (matchesKey(e, 'Ctrl+Home')) return { kind: 'focus', focus: clampFocus({ row: 0, col: 0 }, env) };
  if (matchesKey(e, 'Ctrl+End')) {
    return {
      kind: 'focus',
      focus: clampFocus({ row: env.rows.length - 1, col: env.columnCount - 1 }, env),
    };
  }

  // ── Arrows ──────────────────────────────────────────────────────────────────────────────────
  if (matchesKey(e, 'ArrowDown')) return { kind: 'focus', focus: moveRow(focus, env, 1) };
  if (matchesKey(e, 'ArrowUp')) return { kind: 'focus', focus: moveRow(focus, env, -1) };
  if (matchesKey(e, 'ArrowRight')) return { kind: 'focus', focus: moveColumn(focus, env, 1) };
  if (matchesKey(e, 'ArrowLeft')) return { kind: 'focus', focus: moveColumn(focus, env, -1) };

  // ── Row ends ────────────────────────────────────────────────────────────────────────────────
  if (matchesKey(e, 'Home')) return { kind: 'focus', focus: clampFocus({ ...focus, col: 0 }, env) };
  if (matchesKey(e, 'End')) {
    return { kind: 'focus', focus: clampFocus({ ...focus, col: env.columnCount - 1 }, env) };
  }

  // ── Paging ──────────────────────────────────────────────────────────────────────────────────
  // A pageable screen has more rows than it was handed, so moving a viewport inside the rows in
  // hand would walk to the bottom of page 1 and stop there with no sign that pages 2..n exist.
  if (matchesKey(e, 'PageDown')) {
    return env.pageable
      ? { kind: 'page', dir: 'fwd' }
      : { kind: 'focus', focus: moveRow(focus, env, Math.max(1, env.pageSize)) };
  }
  if (matchesKey(e, 'PageUp')) {
    return env.pageable
      ? { kind: 'page', dir: 'back' }
      : { kind: 'focus', focus: moveRow(focus, env, -Math.max(1, env.pageSize)) };
  }

  // ── Selection ───────────────────────────────────────────────────────────────────────────────
  if (env.selectable && !onGroupHeader(focus, env)) {
    if (matchesKey(e, 'Space')) return { kind: 'select', extend: false };
    if (matchesKey(e, 'Shift+Space')) return { kind: 'select', extend: true };
  }

  // ── Enter ───────────────────────────────────────────────────────────────────────────────────
  // On a group header `Enter` collapses or expands; on a data row it runs the row's command. The
  // same key, because it is the same question — "open what is under the focus" — and a group is
  // opened by expanding it.
  if (matchesKey(e, 'Enter')) {
    return onGroupHeader(focus, env) ? { kind: 'toggle-group' } : { kind: 'open', nextPanel: false };
  }
  if (matchesKey(e, 'Shift+Enter')) {
    return onGroupHeader(focus, env) ? { kind: 'toggle-group' } : { kind: 'open', nextPanel: true };
  }

  // ── Sort and group ──────────────────────────────────────────────────────────────────────────
  if (matchesKey(e, 'S')) return { kind: 'sort' };
  if (matchesKey(e, 'Shift+S')) return { kind: 'freeze-sort' };
  if (matchesKey(e, 'G')) return { kind: 'group-cycle' };

  return null;
}

/**
 * The key hints the footer shows for the grid region (CLIENT.md §3.3).
 *
 * Every entry is a key this module actually claims, derived from the same table rather than typed
 * out beside it: a footer that advertises a key the grid does not handle is a promise the terminal
 * does not keep, and that is how a keyboard-only surface quietly becomes mouse-only in one place.
 */
export function gridKeyHints(env: GridKeyEnv): { key: string; label: string }[] {
  const hints: { key: string; label: string }[] = [
    { key: '↑↓←→', label: 'MOVE' },
    { key: 'PgUp/PgDn', label: env.pageable ? 'PAGE' : 'SCROLL' },
    { key: 'Home/End', label: 'ROW ENDS' },
    { key: 'Enter', label: 'OPEN' },
  ];
  if (env.selectable) hints.push({ key: 'Space', label: 'SELECT' });
  hints.push({ key: 'S', label: 'SORT' }, { key: 'G', label: 'GROUP' });
  return hints;
}
