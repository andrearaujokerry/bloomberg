// packages/web/src/grid/LiveGrid.tsx — the React half of the live grid (TERM-08).
//
// CLIENT.md §10. The division of labour is the whole design and it is worth stating before the
// code: **React owns structure, `cellRegistry` owns content.** Columns, sort, group, selection,
// focus and the virtual window are React state and re-render when they change — which is when a
// person does something, a few times a minute. Cell values are written imperatively by
// `cellRegistry` and never pass through React at all — which is hundreds of times a second. A grid
// that let the second group through the first cannot hold NFR-02's frame budget at 1 000 rows, and
// no amount of memoisation fixes it, because the cost is in the reconciliation rather than in the
// components.
//
// The two halves meet in exactly one place: `GridCell` registers its element with the registry in a
// layout effect, and from that moment **the registry is the only writer of that element's content**.
// A live cell renders NO text, no `data-st`, no `data-dir`, no `aria-label` and no `title` from JSX;
// `register` paints them once from the newest `QuoteView`, or from the payload when no frame has
// arrived. On a genuine remount (a row scrolled back into view) the same paint shows the current
// price and not the price the payload was built with.
//
// Rendering the payload's number as JSX children looks like it should work — the text for a live cell
// does not change between renders, so React finds nothing to update — and it fails the moment the
// screen repaints with a NEW payload: React writes the payload's number over the live one, the
// registry's `cell.last` still holds what it wrote, and its own "no write on a no-op" rule then
// suppresses the correction when the wire re-states that value. The cell shows a number the cache
// disagrees with, indefinitely, and slow-moving fields (`PX_OPEN`, `PX_HIGH`, `PX_CLOSE_1D`) never
// recover. So a new payload for a registered cell goes through `registry.reseed` instead, which keeps
// whichever of the two is actually newer.
//
// Keyboard: the grid is ONE tab stop (CLIENT.md §5.4). Inside it a roving focus moves over cells in
// two dimensions, with the column headers as row −1 — which is how sorting is reachable without a
// second tab stop and without a mouse. `aria-rowcount` and `aria-colcount` describe the **whole**
// model, not the virtualised window: a screen reader told there are 34 rows when the payload has
// 1 000 has been told something false.

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
} from 'react';

import type { FieldId } from '@terminal/core';

import { formatValue } from '../format/index.js';
import type { Cell, GridColumn, GridRow } from '../screen/types.js';
import { buildVisible, cellOf, indexOfRow } from './GridModel.js';
import { nextGroupBy, toggleCollapsed } from './group.js';
import { gridKeyAction } from './keyboard.js';
import type { GridKeyEnv } from './keyboard.js';
import {
  ariaSort,
  cycleSort,
  isSortable,
  LiveSortGate,
  LIVE_SORT_THROTTLE_MS,
  sortBadge,
  sortsALiveColumn,
} from './sort.js';
import type { LiveValueLookup, SortState } from './sort.js';
import {
  cellLabel,
  cellText,
  cellTitle,
  dirOf,
  useCellRegistry,
  useGridLive,
} from './cellRegistry.js';
import type { CellPresentation, CellRegistry } from './cellRegistry.js';
import type { CellRef, GridApi, LiveGridApiProp, LiveGridProps, VisibleRow } from './types.js';
import {
  DEFAULT_OVERSCAN,
  DEFAULT_ROW_HEIGHT,
  EssentialTracker,
  essentialSubjects,
  rowWindow,
  totalHeight,
  windowOffset,
} from './virtualiser.js';

/** The default column width in `ch`, when a `GridColumn` does not state one. */
const DEFAULT_COLUMN_CH = 12;

/** The header occupies `aria-rowindex` 1, so body rows start at 2. */
const HEADER_ROWINDEX = 1;

/** The focus row index that means "the column header row". */
const HEADER_ROW = -1;

/**
 * How often group aggregates are recomputed from live values (CLIENT.md §10.4: "group aggregates are
 * recomputed every 1 s from `cellRegistry` values, not per delta").
 *
 * Per delta would mean a React render per tick for the header rows, which is the one thing this
 * component is built not to do; never would mean a grouped monitor showing a `PX_VOLUME` sum from the
 * moment the screen opened above rows updating four times a second, with nothing saying the total is
 * old.
 */
const AGGREGATE_INTERVAL_MS = 1_000;

/** How a `Cell` is presented, gathering the column's defaults behind the cell's own values. */
function presentationOf(
  column: GridColumn,
  cell: Cell,
  currency: string | undefined,
  priceDecimals: number | undefined,
): CellPresentation {
  return {
    value: cell.v,
    st: cell.st,
    reason: cell.r,
    fmt: cell.fmt ?? column.fmt,
    decimals: cell.decimals ?? column.decimals,
    priceDecimals,
    currency,
    signed: cell.dir !== undefined,
  };
}

interface GridCellProps {
  column: GridColumn;
  cell: Cell;
  /** The quote subject behind this cell, or null when it is not live. */
  subject: string | null;
  fieldId: FieldId | undefined;
  currency: string | undefined;
  priceDecimals: number | undefined;
  tabIndex: 0 | -1;
  focused: boolean;
  style: CSSProperties;
  registry: CellRegistry;
  onFocus: () => void;
  /** The grid's focus ref, so the element it must focus next is the one it already has. */
  bindFocus: (el: HTMLElement | null) => void;
}

/**
 * One cell. The element carries `data-st`, `data-dir` and — mandatory, see `registry.ts` —
 * `data-prov-idx`, because `Ctrl+I` is answered by reading that attribute off the focused element
 * and two columns of one row routinely come from two different sources.
 *
 * The initial content is the payload's, rendered through the single formatter. From the moment the
 * layout effect registers the element, the registry owns its text.
 */
function GridCell(props: GridCellProps): ReactElement {
  const { column, cell, subject, fieldId, registry, currency, priceDecimals } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const presentation = presentationOf(column, cell, currency, priceDecimals);
  const live = column.live === true && subject !== null && fieldId !== undefined;
  const { bindFocus, focused } = props;

  // One element, two interests: the registry writes to it and the grid focuses it. A wrapper per
  // cell would be 400 extra nodes in the viewport for no gain, so the one ref serves both.
  const setRef = useCallback(
    (el: HTMLDivElement | null): void => {
      ref.current = el;
      if (focused) bindFocus(el);
    },
    [bindFocus, focused],
  );

  const registered = useRef<CellRef | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!live || el === null || subject === null || fieldId === undefined) return undefined;
    const ref_: CellRef = {
      el,
      subject,
      fieldId,
      label: column.label,
      fmt: presentation.fmt,
      decimals: presentation.decimals,
      priceDecimals: presentation.priceDecimals,
      currency: presentation.currency,
      signed: presentation.signed,
      last: cell.v,
      lastTs: cell.ts ?? null,
      st: cell.st,
      reason: cell.r,
    };
    registered.current = ref_;
    const unregister = registry.register(ref_);
    return () => {
      registered.current = null;
      unregister();
    };
    // Deliberately narrow: the registration is identified by what it points AT. Re-running it
    // because a formatting option changed would unregister and re-register every cell on an
    // unrelated re-render, and each re-registration repaints from the cache — work, and a moment
    // where the cell is not in the registry at all, for no change anyone can see.
  }, [registry, live, subject, fieldId, column.label]);

  // A new payload for a cell the registry already owns. Declared AFTER the registration effect so
  // that on mount the registration paints first and this is a no-op; on a repaint it is the only
  // thing that reaches the DOM, and `reseed` decides which of the payload and the wire is newer.
  // Without it a screen repaint would leave the payload's value invisible when no socket is attached.
  useLayoutEffect(() => {
    const ref_ = registered.current;
    if (ref_ === null) return;
    registry.reseed(ref_, {
      value: cell.v,
      st: cell.st,
      reason: cell.r,
      ts: cell.ts ?? null,
    });
  }, [registry, cell.v, cell.st, cell.r, cell.ts]);

  return (
    <div
      ref={setRef}
      className={`grid__cell${focused ? ' is-focused' : ''}`}
      role="gridcell"
      style={props.style}
      tabIndex={props.tabIndex}
      {...(live
        ? // A live cell's state, direction, name and tooltip are the registry's to write, for the
          // same reason its text is: React re-rendering them from an older payload would contradict
          // the value beside them. `register` sets all four before the browser paints.
          {}
        : {
            'data-st': cell.st,
            'data-dir': dirOf(presentation, null),
            'aria-label': cellLabel(column.label, presentation),
            title: cellTitle(presentation, cell.ts ?? null),
          })}
      data-prov-idx={cell.provIdx}
      data-col={column.id}
      {...(live && subject !== null && fieldId !== undefined
        ? { 'data-subject': subject, 'data-field': fieldId }
        : {})}
      {...(cell.command === undefined
        ? {}
        : { 'data-command': cell.command, 'aria-keyshortcuts': 'Enter' })}
      onFocus={props.onFocus}
    >
      {live ? null : presentation.signed ? (
        // A signed value goes inside `.chg`, which is the element `tokens.css` colours through
        // `[data-dir='up'] .chg` and the element `CellView.tsx` supplies. Written on the cell itself
        // the rule matches nothing, and a +2.1 % and a −2.1 % come out the same colour in a grid and
        // opposite colours in the block beside it. The registry creates the same span for a live
        // signed cell (`cellRegistry.#prepareElement`), so both paths render one shape.
        <span className="cell__value chg">{cellText(presentation)}</span>
      ) : (
        cellText(presentation)
      )}
    </div>
  );
}

/** The column widths as a CSS grid template, and the sticky offset of each frozen column. */
function useColumnGeometry(
  columns: readonly GridColumn[],
  frozenColumns: number,
): { template: string; styleOf: (index: number) => CSSProperties } {
  return useMemo(() => {
    const widths = columns.map((c) => c.width ?? DEFAULT_COLUMN_CH);
    const template = widths.map((w) => `${String(w)}ch`).join(' ');
    const offsets: number[] = [];
    let running = 0;
    for (const width of widths) {
      offsets.push(running);
      running += width;
    }
    const styleOf = (index: number): CSSProperties => {
      const column = columns[index];
      const base: CSSProperties = { textAlign: column?.align ?? 'left' };
      if (index >= frozenColumns) return base;
      return { ...base, position: 'sticky', left: `${String(offsets[index] ?? 0)}ch`, zIndex: 1 };
    };
    return { template, styleOf };
  }, [columns, frozenColumns]);
}

/**
 * `LiveGrid` (TERM-08). `props` is `LiveGridProps` — the contract `screen/widgets/registry.ts`
 * declares and `widgets/Grid.tsx` builds — plus the optional `apiRef` a host may take.
 */
export function LiveGrid(props: LiveGridProps & LiveGridApiProp): ReactElement {
  const {
    id,
    columns: propColumns,
    rows,
    live,
    sort: controlledSort,
    groupBy: propGroupBy,
    frozenColumns = 1,
    selectable = false,
    page,
    emptyText,
    rowHeight = DEFAULT_ROW_HEIGHT,
    currency,
    priceDecimals,
    liveSortThrottleMs,
    onEnter,
    onShiftEnter,
    onSortChange,
    onGroupChange,
    onColumnsChange,
    onSelectionChange,
    onFocusCell,
    apiRef,
  } = props;

  const registry = useCellRegistry();
  const bridge = useGridLive();

  // ── structure state ───────────────────────────────────────────────────────────────────────
  const [internalSort, setInternalSort] = useState<SortState | null>(null);
  const [columnOrder, setColumnOrder] = useState<string[] | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [groupBy, setGroupBy] = useState<string | null>(propGroupBy ?? null);
  const [focus, setFocus] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const [sortFrozen, setSortFrozen] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    setGroupBy(propGroupBy ?? null);
  }, [propGroupBy]);

  // A controlled grid is one whose screen passes `sort` AND handles `onSortChange` (CLIENT §10.2).
  const isControlled = controlledSort !== undefined && onSortChange !== undefined;
  const sort: SortState | null = isControlled ? (controlledSort ?? null) : internalSort;

  const columns = useMemo(() => {
    if (columnOrder === null) return propColumns;
    const byId = new Map(propColumns.map((c) => [c.id, c]));
    const ordered = columnOrder
      .map((cid) => byId.get(cid))
      .filter((c): c is GridColumn => c !== undefined);
    // Any column the order does not name (the payload grew one) keeps its payload position at the
    // end rather than vanishing: a column silently missing from a grid is data silently missing.
    for (const column of propColumns) if (!columnOrder.includes(column.id)) ordered.push(column);
    return ordered;
  }, [propColumns, columnOrder]);

  const subjectOf = useCallback(
    (row: GridRow): string | null => live?.subjectOf(row) ?? row.subject ?? null,
    [live],
  );

  // ── the live order and the live aggregates (CLIENT.md §10.3, §10.4) ───────────────────────
  //
  // A monitor sorted by `CHG_PCT_1D` is sorted by numbers that keep arriving, and a grouped one totals
  // numbers that keep arriving. Neither can be answered per delta: the order and the header rows are
  // React's structure, and re-rendering structure on the tick path is what this component exists not
  // to do. Both are therefore recomputed from `cellRegistry` values on a throttle — the order at most
  // every `liveSortThrottleMs` and only when no key is held down, the aggregates at most once a
  // second — and both are driven by the registry's own frame, so nothing recomputes on a second when
  // no live value moved.
  //
  // The alternative is not "a feature is missing". A grid sorted ascending by keyboard, fed deltas,
  // rendered its column strictly DESCENDING while the header still said `aria-sort="ascending"`: the
  // screen and the screen reader both asserted an order the grid did not have.
  const liveValues = useCallback<LiveValueLookup>(
    (subject, field) => registry.value(subject, field),
    [registry],
  );

  /** The registry's clock, sampled on each frame, so the throttle and the writes share one `now`. */
  const clock = useRef(0);
  const gate = useMemo(
    () =>
      new LiveSortGate({
        throttleMs: liveSortThrottleMs ?? LIVE_SORT_THROTTLE_MS,
        now: () => clock.current,
      }),
    [liveSortThrottleMs],
  );
  const [liveRev, setLiveRev] = useState(0);
  const aggregatedAt = useRef(0);

  const visible = useMemo(
    // `liveRev` is the only dependency that is not data: it is how a throttled re-sort and a
    // once-a-second aggregate recompute ask for the model to be rebuilt. `liveValues` is stable.
    () => buildVisible(rows, { columns, sort, groupBy, collapsed, liveValues }),
    [rows, columns, sort, groupBy, collapsed, liveValues, liveRev],
  );

  const liveSort = sortsALiveColumn(sort, columns);
  const grouped = groupBy !== null && groupBy !== '';

  /**
   * The field ids the sorted column can show. A delta touching one of them may have changed the
   * order; a delta touching anything else cannot, so it must not mark the gate dirty.
   */
  const sortedFields = useMemo(() => {
    const fields = new Set<FieldId>();
    if (!liveSort || sort === null) return fields;
    const column = columns.find((c) => c.id === sort.col);
    if (column === undefined) return fields;
    if (column.fieldId !== undefined) fields.add(column.fieldId);
    for (const row of rows) {
      const cell = row.cells[column.id];
      const field = cell?.live?.field ?? cell?.fieldId;
      if (field !== undefined) fields.add(field);
    }
    return fields;
  }, [liveSort, sort, columns, rows]);

  /** The row id the focus is on, so a re-sort can keep the focus on the ROW and not on the slot. */
  const focusedRowId = useRef<string | null>(null);
  const remapTo = useRef<string | null>(null);

  useEffect(() => {
    if (!liveSort && !grouped) return undefined;
    return registry.onFlush((info) => {
      clock.current = info.now;
      let rebuild = false;
      if (liveSort) {
        for (const field of sortedFields) {
          if (info.fields.has(field)) {
            gate.markDirty();
            break;
          }
        }
        if (gate.take(info.now)) rebuild = true;
      }
      if (grouped && info.now - aggregatedAt.current >= AGGREGATE_INTERVAL_MS) {
        aggregatedAt.current = info.now;
        rebuild = true;
      }
      if (!rebuild) return;
      remapTo.current = focusedRowId.current;
      setLiveRev((current) => current + 1);
    });
  }, [registry, gate, liveSort, grouped, sortedFields]);

  // A new payload, a new sort or a new column set re-orders the rows for a reason the user caused, so
  // the throttle starts again from here rather than firing immediately afterwards.
  useEffect(() => {
    gate.reset(clock.current);
    aggregatedAt.current = clock.current;
  }, [gate, rows, sort, columns]);

  // Focus follows the ROW through a re-sort, not the slot the row was in (CLIENT.md §10.3). The
  // element itself keeps the browser's focus — React moves the keyed node rather than remounting it —
  // so what has to be corrected is the grid's own idea of where the focus is, or the next arrow key
  // would move from a row the user is no longer on.
  useLayoutEffect(() => {
    const want = remapTo.current;
    if (want === null) return;
    remapTo.current = null;
    const index = indexOfRow(visible, want);
    if (index < 0) return;
    setFocus((current) => (current.row === index ? current : { ...current, row: index }));
  }, [visible]);

  // Declared after the remap so the pair recorded is always (this model, this focus).
  useLayoutEffect(() => {
    const entry = visible[focus.row];
    focusedRowId.current = entry?.kind === 'row' ? entry.row.id : null;
  }, [visible, focus.row]);

  // ── the virtual window ────────────────────────────────────────────────────────────────────
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const window_ = useMemo(
    () =>
      rowWindow({
        scrollTop,
        viewportHeight,
        rowHeight,
        rowCount: visible.length,
        overscan: DEFAULT_OVERSCAN,
      }),
    [scrollTop, viewportHeight, rowHeight, visible.length],
  );
  const slice = useMemo(
    () => visible.slice(window_.start, window_.end),
    [visible, window_.start, window_.end],
  );

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (el === null) return undefined;
    const measure = (): void => {
      setViewportHeight(el.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // Passive: the scroll handler reads and sets state, it never calls preventDefault, and telling
    // the browser so is what keeps scrolling off the main thread's critical path.
    const onScroll = (): void => {
      setScrollTop(el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  // ── the essential set (BUS-04) ────────────────────────────────────────────────────────────
  const tracker = useRef<EssentialTracker>(new EssentialTracker());
  useEffect(() => {
    const next = essentialSubjects(visible, window_, subjectOf);
    const diff = tracker.current.update(next);
    if (diff.added.length > 0) bridge.setEssential(diff.added, true);
    if (diff.removed.length > 0) bridge.setEssential(diff.removed, false);
  }, [visible, window_, subjectOf, bridge]);

  const trackerRef = tracker;
  useEffect(
    () => () => {
      // On unmount every subject this grid was holding on screen stops being essential. Leaving
      // them marked would tell the server it may never shed rows that no longer exist.
      const diff = trackerRef.current.clear();
      if (diff.removed.length > 0) bridge.setEssential(diff.removed, false);
    },
    [bridge, trackerRef],
  );

  // ── focus ─────────────────────────────────────────────────────────────────────────────────
  const focusRef = useRef<HTMLElement | null>(null);
  const wantFocus = useRef(false);
  const bindFocusRef = useCallback((el: HTMLElement | null): void => {
    focusRef.current = el;
  }, []);
  useLayoutEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    focusRef.current?.focus();
  });

  const clampFocus = useCallback(
    (next: { row: number; col: number }): { row: number; col: number } => {
      const maxRow = visible.length - 1;
      const row = Math.min(Math.max(next.row, HEADER_ROW), Math.max(maxRow, HEADER_ROW));
      const col = Math.min(Math.max(next.col, 0), Math.max(columns.length - 1, 0));
      return { row, col };
    },
    [visible.length, columns.length],
  );

  const scrollRowIntoView = useCallback(
    (index: number): void => {
      const el = viewportRef.current;
      if (el === null || index < 0) return;
      const top = index * rowHeight;
      const height = el.clientHeight > 0 ? el.clientHeight : viewportHeight;
      if (top < el.scrollTop) {
        el.scrollTop = top;
        setScrollTop(top);
      } else if (height > 0 && top + rowHeight > el.scrollTop + height) {
        const next = top + rowHeight - height;
        el.scrollTop = next;
        setScrollTop(next);
      }
    },
    [rowHeight, viewportHeight],
  );

  const moveFocus = useCallback(
    (next: { row: number; col: number }): void => {
      const clamped = clampFocus(next);
      wantFocus.current = true;
      setFocus(clamped);
      scrollRowIntoView(clamped.row);
      const entry = visible[clamped.row];
      const column = columns[clamped.col];
      if (entry?.kind === 'row' && column !== undefined) {
        onFocusCell?.(entry.row, column);
      }
    },
    [clampFocus, scrollRowIntoView, visible, columns, onFocusCell],
  );

  // ── sort, group, selection ────────────────────────────────────────────────────────────────
  //
  // Every decision below is `sort.ts`'s or `group.ts`'s; what is here is the state it lands in and
  // the callback it is reported through. A second `cycleSort` in this file would be a second answer
  // to "what does S do next", and only one of them would be the one with a test.
  const applySort = useCallback(
    (column: GridColumn | undefined): void => {
      if (column === undefined || !isSortable(column)) return;
      const next = cycleSort(sort, column.id);
      if (isControlled) onSortChange?.(next);
      else setInternalSort(next);
    },
    [sort, isControlled, onSortChange],
  );

  const toggleGroup = useCallback((key: string): void => {
    setCollapsed((current) => toggleCollapsed(current, key));
  }, []);

  const cycleGrouping = useCallback((): void => {
    const next = nextGroupBy(groupBy, columns);
    setGroupBy(next);
    onGroupChange?.(next);
  }, [groupBy, columns, onGroupChange]);

  /** The row `Shift+Space` extends a selection from. */
  const anchor = useRef<number | null>(null);

  const applySelection = useCallback(
    (rowIndex: number, extend: boolean): void => {
      const entry = visible[rowIndex];
      if (entry?.kind !== 'row') return;
      setSelection((current) => {
        const next = new Set(current);
        if (extend && anchor.current !== null) {
          const [from, to] =
            anchor.current <= rowIndex ? [anchor.current, rowIndex] : [rowIndex, anchor.current];
          for (let i = from; i <= to; i += 1) {
            const row = visible[i];
            if (row?.kind === 'row') next.add(row.row.id);
          }
        } else if (next.has(entry.row.id)) {
          next.delete(entry.row.id);
        } else {
          next.add(entry.row.id);
        }
        onSelectionChange?.([...next]);
        return next;
      });
      if (!extend) anchor.current = rowIndex;
    },
    [visible, onSelectionChange],
  );

  const moveColumn = useCallback(
    (from: number, delta: number): void => {
      const to = from + delta;
      if (to < 0 || to >= columns.length) return;
      const order = columns.map((c) => c.id);
      const [moved] = order.splice(from, 1);
      if (moved === undefined) return;
      order.splice(to, 0, moved);
      setColumnOrder(order);
      const widths: Record<string, number> = {};
      for (const column of columns) widths[column.id] = column.width ?? DEFAULT_COLUMN_CH;
      onColumnsChange?.(order, widths);
      setFocus((current) => ({ ...current, col: to }));
      wantFocus.current = true;
    },
    [columns, onColumnsChange],
  );

  // ── the keyboard ──────────────────────────────────────────────────────────────────────────
  //
  // The mapping from keystroke to action is `keyboard.ts`'s, which is a pure table with a test of
  // its own; this component is one caller of it. What stays here is what only a mounted grid knows:
  // where the focus is, what the rows are, and the column-header row.
  //
  // The header is focus row −1, a position `keyboard.ts` does not model because it is not a row of
  // the data. It exists so the grid stays ONE tab stop (CLIENT.md §5.4) while its headers remain
  // reachable: `ArrowUp` off the first row lands on them and `Enter` there sorts the column, which
  // is what TESTING.md §13 drives with `user-event`. `S` on a body cell does the same thing through
  // `keyboard.ts`; both routes call `applySort`, so they cannot disagree.
  const pageSize = Math.max(
    1,
    Math.floor((viewportHeight > 0 ? viewportHeight : rowHeight * 20) / rowHeight),
  );

  const keyEnv: GridKeyEnv = useMemo(
    () => ({
      rows: visible,
      columnCount: columns.length,
      pageSize,
      // `LiveGridProps` carries no paging callback, so the grid cannot ask the screen for the next
      // page; it scrolls inside the rows it was handed and the panel owns `ctx.page()`. Claiming
      // `pageable` here would map PageDown to an action with nobody to perform it.
      pageable: false,
      selectable,
    }),
    [visible, columns.length, pageSize, selectable],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      // "Only when no key is held down in the grid" (CLIENT.md §10.3). A row must not move out from
      // under a held ArrowDown, so the gate counts keys down and refuses to re-sort while any is.
      // `repeat` is excluded because auto-repeat sends many keydowns and exactly one keyup.
      if (!e.repeat) gate.setHeld(true);
      const { row, col } = focus;

      if (row === HEADER_ROW) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          moveFocus({ row: 0, col });
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (e.ctrlKey) moveColumn(col, 1);
          else moveFocus({ row, col: col + 1 });
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (e.ctrlKey) moveColumn(col, -1);
          else moveFocus({ row, col: col - 1 });
        } else if (e.key === 'Home') {
          e.preventDefault();
          moveFocus({ row, col: 0 });
        } else if (e.key === 'End') {
          e.preventDefault();
          moveFocus({ row, col: columns.length - 1 });
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          applySort(columns[col]);
        } else {
          // The grid-wide keys behave the same on the header row as on a body cell, and the mapping
          // is `keyboard.ts`'s for both: a header branch that answered `Shift+S` itself would be a
          // second answer to "is the order frozen", and the header is where the user just sorted.
          const headerAction = gridKeyAction(e, { row: 0, col }, keyEnv);
          if (headerAction?.kind === 'freeze-sort') {
            e.preventDefault();
            setSortFrozen(gate.toggleFreeze());
          } else if (headerAction?.kind === 'sort') {
            e.preventDefault();
            applySort(columns[col]);
          } else if (headerAction?.kind === 'group-cycle') {
            e.preventDefault();
            cycleGrouping();
          }
        }
        return;
      }

      // The one body-row case `keyboard.ts` cannot express: it clamps at row 0, and the header is
      // above row 0.
      if (e.key === 'ArrowUp' && !e.ctrlKey && row === 0) {
        e.preventDefault();
        moveFocus({ row: HEADER_ROW, col });
        return;
      }

      const action = gridKeyAction(e, focus, keyEnv);
      // `null` is a decision: a reserved key (Ctrl+I, Ctrl+E, Escape, Tab) must keep bubbling to
      // the one handler that owns it. Consuming it here would answer for the grid alone.
      if (action === null) return;
      e.preventDefault();

      switch (action.kind) {
        case 'focus':
          moveFocus(action.focus);
          return;
        case 'page':
          return;
        case 'select':
          applySelection(row, action.extend);
          return;
        case 'open': {
          const entry = visible[row];
          if (entry?.kind !== 'row') return;
          if (action.nextPanel) onShiftEnter?.(entry.row);
          else onEnter?.(entry.row);
          return;
        }
        case 'toggle-group': {
          const entry = visible[row];
          if (entry?.kind === 'group') toggleGroup(entry.key);
          return;
        }
        case 'sort':
          applySort(columns[col]);
          return;
        case 'freeze-sort':
          // One answer, held by the gate: `take()` refuses while it is frozen, and the state below is
          // what the badge and `data-sort-frozen` are rendered from. Two flags would be two answers to
          // "is the order still moving", and the screen would show whichever one was asked.
          setSortFrozen(gate.toggleFreeze());
          return;
        case 'group-cycle':
          cycleGrouping();
          return;
        case 'move-column':
          moveColumn(col, action.delta);
          return;
      }
    },
    [
      focus,
      visible,
      columns,
      keyEnv,
      moveFocus,
      moveColumn,
      applySort,
      applySelection,
      toggleGroup,
      cycleGrouping,
      onEnter,
      onShiftEnter,
      gate,
    ],
  );

  const onKeyUp = useCallback(
    (): void => {
      gate.setHeld(false);
    },
    [gate],
  );

  const onBlur = useCallback(
    (e: ReactFocusEvent<HTMLDivElement>): void => {
      // The focus left the grid entirely: no `keyup` is coming for whatever is still down, so the
      // count is forced back to zero rather than locking the order for the rest of the session.
      if (e.currentTarget.contains(e.relatedTarget)) return;
      gate.releaseHeld();
    },
    [gate],
  );

  // ── the imperative handle ─────────────────────────────────────────────────────────────────
  useImperativeHandle(
    apiRef,
    (): GridApi => ({
      focusRow: (rowId) => {
        const index = indexOfRow(visible, rowId);
        if (index >= 0) moveFocus({ row: index, col: focus.col });
      },
      focusCell: (rowId, colId) => {
        const index = indexOfRow(visible, rowId);
        const colIndex = columns.findIndex((c) => c.id === colId);
        if (index >= 0 && colIndex >= 0) moveFocus({ row: index, col: colIndex });
      },
      scrollToRow: (rowId) => {
        const index = indexOfRow(visible, rowId);
        if (index >= 0) scrollRowIntoView(index);
      },
      getVisibleRange: () => ({ start: window_.start, end: window_.end }),
      getSelection: () => [...selection],
      // The rows as the payload gave them — never the sorted or grouped projection (CLIENT §13.2).
      exportModel: () => ({ columns: [...propColumns], rows: [...rows] }),
    }),
    [
      visible,
      columns,
      propColumns,
      rows,
      selection,
      window_,
      focus.col,
      moveFocus,
      scrollRowIntoView,
    ],
  );

  useEffect(
    () => () => {
      registry.endFlash();
    },
    [registry],
  );

  // ── render ────────────────────────────────────────────────────────────────────────────────
  const geometry = useColumnGeometry(columns, frozenColumns);
  const isEmpty = rows.length === 0;
  const focusInWindow = focus.row >= window_.start && focus.row < window_.end;
  // The grid keeps its tab stop in every state. An empty grid with no tab stop is a node the
  // keyboard cannot reach at all — WP-12 found exactly that on a government bond's DES — and a grid
  // whose focused row has scrolled out of the DOM would lose it the same way.
  const containerTabIndex = isEmpty || (!focusInWindow && focus.row !== HEADER_ROW) ? 0 : -1;

  // `SORT LIVE` / `SORT FROZEN` (CLIENT.md §10.3): `null` for a static order, which needs no
  // explanation. It is stated on the element as well as drawn, so the shell's footer can read one
  // answer off the focused grid rather than keeping a second copy of the state.
  const badge = sortBadge(sort, columns, { frozen: sortFrozen });

  const rowStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: geometry.template,
    height: `${String(rowHeight)}px`,
  };

  return (
    <div
      className="grid"
      data-node-id={id}
      role="grid"
      aria-label={`Grid ${id}`}
      aria-rowcount={visible.length + 1}
      aria-colcount={columns.length}
      {...(selectable ? { 'aria-multiselectable': true } : {})}
      data-sort-frozen={sortFrozen}
      {...(badge === null ? {} : { 'data-sort-badge': badge })}
      tabIndex={containerTabIndex}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={onBlur}
    >
      <div className="grid__head" role="rowgroup">
        <div
          className="grid__row grid__row--head"
          role="row"
          aria-rowindex={HEADER_ROWINDEX}
          style={rowStyle}
        >
          {columns.map((column, ci) => (
            <div
              key={column.id}
              className="grid__th"
              role="columnheader"
              style={geometry.styleOf(ci)}
              data-col={column.id}
              tabIndex={focus.row === HEADER_ROW && focus.col === ci ? 0 : -1}
              ref={
                focus.row === HEADER_ROW && focus.col === ci
                  ? (el) => {
                      focusRef.current = el;
                    }
                  : undefined
              }
              {...(isSortable(column)
                ? { 'aria-sort': ariaSort(sort, column.id), 'aria-keyshortcuts': 'Enter' }
                : {})}
              onFocus={() => {
                setFocus({ row: HEADER_ROW, col: ci });
              }}
            >
              {column.label}
            </div>
          ))}
        </div>
      </div>

      {isEmpty ? (
        <p className="widget__empty">{emptyText ?? `No rows in ${id}.`}</p>
      ) : (
        <div
          className="grid__viewport"
          ref={viewportRef}
          style={{ overflow: 'auto', flex: '1 1 auto' }}
        >
          <div
            className="grid__spacer"
            style={{
              height: `${String(totalHeight(visible.length, rowHeight))}px`,
              position: 'relative',
            }}
          >
            <div
              className="grid__rows"
              role="rowgroup"
              style={{ transform: `translateY(${String(windowOffset(window_, rowHeight))}px)` }}
            >
              {slice.map((entry) =>
                entry.kind === 'group' ? (
                  <GroupRow
                    key={`group:${entry.key}`}
                    entry={entry}
                    columns={columns}
                    style={rowStyle}
                    focused={focus.row === entry.index}
                    focusCol={focus.col}
                    currency={currency}
                    priceDecimals={priceDecimals}
                    onFocusSelf={(ci) => {
                      setFocus({ row: entry.index, col: ci });
                    }}
                    bindFocus={(el) => {
                      if (focus.row === entry.index) focusRef.current = el;
                    }}
                    onToggle={() => {
                      toggleGroup(entry.key);
                    }}
                  />
                ) : (
                  <div
                    key={entry.row.id}
                    className={`grid__row${entry.row.tone === undefined ? '' : ` grid__row--${entry.row.tone}`}`}
                    role="row"
                    aria-rowindex={entry.index + HEADER_ROWINDEX + 1}
                    {...(selectable ? { 'aria-selected': selection.has(entry.row.id) } : {})}
                    style={rowStyle}
                    data-row-id={entry.row.id}
                  >
                    {columns.map((column, ci) => {
                      const cell = cellOf(entry.row, column.id);
                      const subject = cell.live?.subject ?? subjectOf(entry.row);
                      const fieldId = cell.live?.field ?? cell.fieldId ?? column.fieldId;
                      const focused = focus.row === entry.index && focus.col === ci;
                      return (
                        <GridCell
                          key={column.id}
                          column={column}
                          cell={cell}
                          subject={subject}
                          fieldId={fieldId}
                          currency={currency}
                          priceDecimals={priceDecimals}
                          registry={registry}
                          focused={focused}
                          tabIndex={focused ? 0 : -1}
                          style={geometry.styleOf(ci)}
                          bindFocus={bindFocusRef}
                          onFocus={() => {
                            setFocus({ row: entry.index, col: ci });
                            const col = columns[ci];
                            if (col !== undefined) onFocusCell?.(entry.row, col);
                          }}
                        />
                      );
                    })}
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      )}

      {badge === null ? null : (
        <p className="grid__badge" data-badge={badge}>
          {badge}
        </p>
      )}

      {page === undefined ? null : (
        <p className="grid__page">{`Page ${String(page.index + 1)} of ${String(page.count)}`}</p>
      )}
    </div>
  );
}

interface GroupRowProps {
  entry: Extract<VisibleRow, { kind: 'group' }>;
  columns: readonly GridColumn[];
  style: CSSProperties;
  focused: boolean;
  focusCol: number;
  currency: string | undefined;
  priceDecimals: number | undefined;
  onFocusSelf: (columnIndex: number) => void;
  bindFocus: (el: HTMLElement | null) => void;
  onToggle: () => void;
}

/**
 * A group header. It is a row of `gridcell`s like any other so that the arrow keys reach it and
 * `aria-rowindex` stays truthful — a header that were not a row would make every row below it
 * report an index one short of where a screen reader would count it.
 *
 * Aggregates are rendered through the single formatter, and a column with nothing to aggregate is
 * empty rather than `0`: a zero in a numeric column is a number a trader reads as a number.
 */
function GroupRow(props: GroupRowProps): ReactElement {
  const { entry, columns, style, focused, focusCol } = props;
  return (
    <div
      className="grid__row grid__row--group"
      role="row"
      aria-rowindex={entry.index + HEADER_ROWINDEX + 1}
      style={style}
      data-group={entry.key}
    >
      {columns.map((column, ci) => {
        const isFirst = ci === 0;
        const value = entry.agg[column.id];
        const text = isFirst
          ? `${entry.collapsed ? '▸' : '▾'} ${entry.key === '' ? '(none)' : entry.key} (${String(entry.count)})`
          : value === null || value === undefined
            ? ''
            : formatValue(column.fmt ?? 'px', value, {
                ...(props.currency === undefined ? {} : { currency: props.currency }),
                ...(props.priceDecimals === undefined
                  ? {}
                  : { priceDecimals: props.priceDecimals }),
                ...(column.decimals === undefined ? {} : { decimals: column.decimals }),
              });
        const cellFocused = focused && focusCol === ci;
        return (
          <div
            key={column.id}
            className="grid__cell grid__cell--group"
            role="gridcell"
            style={{ ...(column.align === undefined ? {} : { textAlign: column.align }) }}
            tabIndex={cellFocused ? 0 : -1}
            ref={cellFocused ? props.bindFocus : undefined}
            data-prov-idx={-1}
            data-col={column.id}
            {...(isFirst
              ? { 'aria-expanded': !entry.collapsed, 'aria-keyshortcuts': 'Enter' }
              : {})}
            onFocus={() => {
              props.onFocusSelf(ci);
            }}
            onClick={isFirst ? props.onToggle : undefined}
          >
            {text}
          </div>
        );
      })}
    </div>
  );
}
