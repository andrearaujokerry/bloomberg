// packages/web/src/screen/widgets/registry.ts — the two delegation contracts and the action surface
// the widget set renders against.
//
// WP-12 renders a `ScreenSpec` through eleven widgets and nothing else. Two of those widgets do not
// draw: `grid` belongs to WP-13's `LiveGrid` and `chart` to WP-14's `ChartCanvas`. Neither exists
// yet, so this file fixes the props each will be handed — the contract is written now, against the
// `ScreenSpec` the 38 screens already emit, so that WP-13 and WP-14 have a shape to satisfy rather
// than a shape to negotiate.
//
// The contracts are CLIENT.md §10.2 (`LiveGridProps`) and §11 (`ChartCanvas`), narrowed to what a
// `ScreenSpec` can actually supply. `packages/web/src/grid/types.ts` should re-export
// `LiveGridProps` from here rather than declare a second copy: the renderer is the caller, so the
// caller's shape is the contract.

import { createContext, useContext } from 'react';
import type { ComponentType } from 'react';

import type { ChartSpec, GridColumn, GridRow, Node } from '../types.js';

/**
 * What a widget may ask the shell to do. `ScreenCtx<P>` (FUNCTIONS.md §1.5) satisfies this
 * structurally, so a panel passes its `ctx` straight in.
 */
export interface ScreenActions {
  /** Execute a command line string in this panel. */
  navigate(command: string): void;
  /** Execute it in the next panel (the Shift+Enter convention). */
  navigateNext(command: string): void;
  /** Open an external link. */
  openUrl(url: string): void;
  /** Tell the shell a provenance panel was requested for `meta.provenance[provIdx]` (DATA-10). */
  provenance(provIdx: number): void;
}

/** A renderer with no shell behind it: every action is recorded nowhere and nothing happens. */
export const INERT_ACTIONS: ScreenActions = {
  navigate: () => undefined,
  navigateNext: () => undefined,
  openUrl: () => undefined,
  provenance: () => undefined,
};

export const ScreenActionsContext = createContext<ScreenActions>(INERT_ACTIONS);

export function useScreenActions(): ScreenActions {
  return useContext(ScreenActionsContext);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WP-13 — LiveGrid
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The props `widgets/Grid.tsx` hands WP-13's `LiveGrid` (CLIENT.md §10.2).
 *
 * Two notes on the callbacks, because the §10.2 listing is ambiguous about who navigates:
 *   * `onEnter` / `onShiftEnter` keep the §10.2 signature — `(row) => string | null` — and the
 *     **renderer** performs the navigation before returning the command. `LiveGrid` calls them on
 *     `Enter` / `Shift+Enter` and may ignore the return value; it is returned so a grid that wants
 *     to show the command it just ran can.
 *   * `sort` is `undefined` when the screen did not express one (the `ScreenSpec` has no `null`
 *     sort). A controlled grid is one whose screen passes `sort` and handles `onSortChange`.
 *
 * **DOM contract, and it is not optional.** `LiveGrid` MUST write `data-prov-idx` on every cell it
 * draws, taken from that cell's `provIdx`. `Ctrl+I` is answered by reading the attribute off the
 * focused element (`ScreenRenderer.provIdxOfFocus`), so a grid that omits it makes every number in
 * the busiest node on the screen unable to name its source — which DATA-10 does not allow. Two
 * columns of one row routinely come from two different sources, so the attribute belongs on the
 * cell and not on the row or the grid; WP-12's placeholder can only cite the first attributed cell
 * in the payload, and that is a stand-in, not the contract. The same applies to `data-st`, which
 * carries the `ValueState` colour and the state glyphs (`CellView.tsx`).
 */
export interface LiveGridProps {
  /** The `ScreenSpec` node id: focus target, persistence key. */
  id: string;
  columns: GridColumn[];
  rows: GridRow[];
  /** `live.subjectOf(row)` names the quote subject whose deltas overwrite the row's live cells. */
  live?: { subjectOf: (row: GridRow) => string | null };
  sort?: { col: string; dir: 'asc' | 'desc' };
  groupBy?: string;
  /** Default 1 — the key column stays put while the rest scroll. */
  frozenColumns?: number;
  selectable?: boolean;
  page?: { index: number; count: number };
  emptyText?: string;
  rowHeight?: number;
  onEnter?: (row: GridRow) => string | null;
  onShiftEnter?: (row: GridRow) => string | null;
  onSortChange?: (sort: { col: string; dir: 'asc' | 'desc' } | null) => void;
  onGroupChange?: (groupBy: string | null) => void;
  onColumnsChange?: (order: string[], widths: Record<string, number>) => void;
  onSelectionChange?: (rowIds: string[]) => void;
  /** Footer key hints and the `Ctrl+I` provenance target follow the focused cell. */
  onFocusCell?: (row: GridRow, column: GridColumn) => void;
  liveSortThrottleMs?: number;
  /** Currency for `ccy` cells — `instruments.currency` at the call site. */
  currency?: string;
  priceDecimals?: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WP-14 — ChartCanvas
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The props `widgets/Chart.tsx` hands WP-14's `ChartCanvas` (CLIENT.md §11).
 *
 * **DOM contract.** Provenance on a chart is per series — `spec.series[i].provIdx` — and a chart
 * drawn from three sources has three answers to `Ctrl+I`, not one. `ChartCanvas` MUST therefore set
 * `data-prov-idx` on its focusable element to the index of whichever series the crosshair or the
 * keyboard is currently on, and update it as that changes. WP-12's placeholder cites a single index
 * only when every series agrees on one, and `-2` otherwise, because naming series 0 for the whole
 * canvas would be a false attribution rather than a missing one.
 */
export interface ChartCanvasProps {
  /** The `ScreenSpec` node id. */
  id: string;
  spec: ChartSpec;
  /** Crosshair readouts, event click-through and annotation saves come back here. */
  onEvent?: (e: { kind: 'event' | 'annotation-save' | 'crosshair'; payload: unknown }) => void;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `custom` components
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The five component names a `custom` node may address (FUNCTIONS.md §1.5). */
export type CustomComponentName = Extract<Node, { kind: 'custom' }>['component'];

/** The props every registered `custom` component receives. */
export interface CustomComponentProps {
  id: string;
  component: CustomComponentName;
  /** Whatever the screen put there; the component knows its own shape. */
  props: unknown;
  actions: ScreenActions;
}

/**
 * The components the renderer delegates to. Everything here is optional: a registry with nothing in
 * it is the state WP-12 ships in, and each widget then renders a placeholder that names what it is
 * waiting for rather than a box that could be mistaken for the real thing.
 */
export interface WidgetRegistry {
  LiveGrid?: ComponentType<LiveGridProps>;
  ChartCanvas?: ComponentType<ChartCanvasProps>;
  custom?: Partial<Record<CustomComponentName, ComponentType<CustomComponentProps>>>;
}

export const EMPTY_REGISTRY: WidgetRegistry = {};

export const WidgetRegistryContext = createContext<WidgetRegistry>(EMPTY_REGISTRY);

export function useWidgetRegistry(): WidgetRegistry {
  return useContext(WidgetRegistryContext);
}
