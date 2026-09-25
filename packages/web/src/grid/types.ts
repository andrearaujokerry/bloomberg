// packages/web/src/grid/types.ts — the grid's shapes, and one deliberate re-export.
//
// CLIENT.md §10.2 lists `LiveGridProps, GridApi, RowKey, VisibleRow, CellRef, ChangeBatch` here.
// `LiveGridProps` is **re-exported** from `screen/widgets/registry.ts` rather than declared again:
// WP-12's `widgets/Grid.tsx` is the caller, it builds that object today, and a second declaration
// here would be a shape that compiles against nothing. The caller's shape is the contract. The
// other five are this package's own and are declared below.
//
// Nothing in this file has a runtime body — it is types and two small constants — so the grid's
// hot path never pays for it.

import type { Ref } from 'react';

import type { FieldId, FieldValue, ValueState } from '@terminal/core';
import type { QuoteView } from '@terminal/sdk';

import type { Cell, GridColumn, GridRow } from '../screen/types.js';

/**
 * The props `LiveGrid` is handed. THE contract, owned by `screen/widgets/registry.ts`, which is
 * where WP-12's renderer builds it (see the note at the top of this file).
 */
export type { LiveGridProps } from '../screen/widgets/registry.js';

/** A `GridRow.id`. Rows keep DOM identity by this across sort, group and scroll. */
export type RowKey = string;

/**
 * One entry of the flattened visible model (CLIENT.md §10.2). `index` is the position in that flat
 * array, which is what the virtualiser slices and what `aria-rowindex` is derived from — group
 * headers occupy a row of their own, so they are counted.
 */
export type VisibleRow =
  | { kind: 'row'; row: GridRow; index: number }
  | {
      kind: 'group';
      key: string;
      count: number;
      agg: Record<string, number | null>;
      collapsed: boolean;
      index: number;
    };

/**
 * One live cell, as `cellRegistry` holds it (CLIENT.md §10.2).
 *
 * `last`, `lastTs` and `st` are the registry's memory of what it last wrote. They are what makes
 * "no flash on a no-op" possible: without them every conflated frame would repaint and re-flash
 * every subscribed field, whether or not the number moved.
 *
 * `signed` is not in the §10.2 listing and is the one addition. It records that the payload cell
 * carried a `dir`, i.e. that this column shows a *change* rather than a level (`CHG_NET_1D`,
 * `CHG_PCT_1D`). `CellView.tsx` decides "print the sign and the ▲/▼ glyph" from exactly that, and
 * the grid has to reach the same answer from the same fact or a change column would render one way
 * in a `kv` block and another in the grid beside it.
 */
export interface CellRef {
  /** The `role="gridcell"` element. `data-st`, `data-dir` and the flash live here. */
  el: HTMLElement;
  /**
   * Where the text goes, when it is not `el` itself.
   *
   * A signed cell's value is written into a `.chg` span, because that is the element `tokens.css`
   * colours (`[data-dir='up'] .chg`) and the one `CellView.tsx` supplies; a level cell has no
   * wrapper and writes straight to `el`. `cellRegistry.register` creates it and owns it — nothing
   * else may set it.
   */
  valueEl?: HTMLElement | undefined;
  subject: string;
  fieldId: FieldId;
  /** The column's label — the accessible name the registry rewrites with the value. */
  label: string;
  fmt: Cell['fmt'];
  decimals?: number | undefined;
  priceDecimals?: number | undefined;
  currency?: string | undefined;
  /** True for a change column: the value is printed with its sign and a ▲/▼ glyph. */
  signed: boolean;
  /** The last value written, so an unchanged field is skipped rather than repainted. */
  last: FieldValue;
  /** The last per-field source timestamp written (epoch ms), or null. */
  lastTs: number | null;
  /** The last `ValueState` written. */
  st: ValueState;
  /** The `ReasonCode` last written beside a blank, so a blank never loses its explanation. */
  reason: string | undefined;
}

/** What the bridge hands the registry for one subject (CLIENT.md §10.4). */
export interface ChangeBatch {
  subject: string;
  changed: FieldId[];
  state: QuoteView;
}

/**
 * The imperative handle a host can take on a mounted grid (CLIENT.md §10.2).
 *
 * `LiveGridProps` (registry.ts) does not carry `apiRef`, because the `ScreenSpec` renderer has no
 * use for one; `LiveGrid` accepts it as an optional extra prop so a host that does — the export
 * path (`Ctrl+E`), `ctx.focus(nodeId)` — can reach the grid without the contract growing a member
 * every caller would have to ignore.
 */
export interface GridApi {
  focusRow(id: RowKey): void;
  focusCell(rowId: RowKey, colId: string): void;
  scrollToRow(id: RowKey): void;
  /** The virtual window, as indices into the flat visible model. `end` is exclusive. */
  getVisibleRange(): { start: number; end: number };
  getSelection(): RowKey[];
  /** The rows exactly as the payload gave them — never the sorted or grouped projection. */
  exportModel(): { columns: GridColumn[]; rows: GridRow[] };
}

/** `apiRef` is the one prop `LiveGrid` takes beyond the registry contract. */
export interface LiveGridApiProp {
  apiRef?: Ref<GridApi>;
}

/** The direction a cell moved, which is both its flash colour and its `data-dir`. */
export type FlashDir = 'up' | 'down' | 'flat';
