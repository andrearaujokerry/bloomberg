/**
 * packages/web/test/grid/keyboard.test.tsx — the WP-13 acceptance row for grid keyboard operability
 * (WORKPLAN L1443: "arrow/page navigation, sort toggling, group collapse, all keyboard-only").
 *
 * Every assertion below is produced by a keystroke through `@testing-library/user-event` on a real
 * DOM, and there is not one `click` in the file. That is the point: CLIENT.md §5.3 specifies a grid
 * region a trader drives without ever reaching for a mouse, and TERM-06 makes a mouse-only
 * affordance a defect. A test that called the handlers directly would prove the handlers work while
 * proving nothing about whether a key can reach them.
 *
 * ## What the harness is, and what it is not
 *
 * `GridHarness` below is a minimal grid: it composes `grid/sort.ts`, `grid/group.ts` and
 * `grid/keyboard.ts` exactly as `LiveGrid.tsx` does — sort, then group, then flatten to visible
 * rows, then route every `keydown` through `gridKeyAction` — over real ARIA roles, with a roving
 * tab stop. It has no virtualiser, no cell registry and no socket, because none of those change
 * what a key means.
 *
 * It is a harness and not the component on purpose. The component-level row is
 * `LiveGrid.keyboard.test.tsx` (TESTING.md §13), which drives the shipped `LiveGrid` including its
 * virtual window and its live cells. This file is the row underneath it: the key map itself, over a
 * grid whose contents the test states in full, so that when both are red the failure says which of
 * the two is wrong. What the harness must not do is decide anything the modules decide — no
 * clamping, no cycling, no aggregation is written here — and it does not: every branch it takes is
 * a value returned by the module under test.
 *
 * `user-event` runs with `delay: null`: a web test drives frames, never `setTimeout`
 * (TESTING.md §2.2).
 */

import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import {
  groupRows,
  nextGroupBy,
  toggleCollapsed,
  UNGROUPED_KEY,
} from '../../src/grid/group.js';
import type { GroupBlock } from '../../src/grid/group.js';
import { clampFocus, gridKeyAction, gridKeyHints } from '../../src/grid/keyboard.js';
import type { GridFocus, GridKeyEnv } from '../../src/grid/keyboard.js';
import type { KeyEventLike } from '../../src/keyboard/keymap.js';
import {
  ariaSort,
  cycleSort,
  isSortable,
  LiveSortGate,
  sortBadge,
  sortRows,
} from '../../src/grid/sort.js';
import type { SortState } from '../../src/grid/sort.js';
import type { Cell, GridColumn, GridRow } from '../../src/screen/types.js';

/* -------------------------------------------------------------------------------------------- */
/* The grid under the keys                                                                        */
/* -------------------------------------------------------------------------------------------- */

const COLUMNS: GridColumn[] = [
  { id: 'ticker', label: 'Ticker', fmt: 'text' },
  { id: 'sector', label: 'Sector', fmt: 'text' },
  { id: 'last', label: 'Last', fmt: 'px', live: true, fieldId: 'PX_LAST' },
  { id: 'vol', label: 'Volume', fmt: 'int', live: true, fieldId: 'PX_VOLUME' },
];

const cell = (v: Cell['v'], st: Cell['st'] = 'live', provIdx = 0): Cell => ({ v, st, provIdx });

/** Six names, three sectors, one withheld price and one tie — every rule has a row that shows it. */
const ROWS: GridRow[] = [
  {
    id: 'r-aapl',
    subject: 'q:1',
    cells: {
      ticker: cell('AAPL'),
      sector: cell('Tech'),
      last: cell(189.5),
      vol: cell(1_200),
    },
  },
  {
    id: 'r-msft',
    subject: 'q:2',
    cells: {
      ticker: cell('MSFT'),
      sector: cell('Tech'),
      last: cell(402.1),
      vol: cell(900),
    },
  },
  {
    id: 'r-xom',
    subject: 'q:3',
    cells: {
      ticker: cell('XOM'),
      sector: cell('Energy'),
      // Withheld by entitlement: blank, and it must sort last in BOTH directions (ENTL-05).
      last: { v: null, st: 'blank', r: 'NO_USER_ENTITLEMENT', provIdx: 0 },
      vol: cell(1_100),
    },
  },
  {
    id: 'r-cvx',
    subject: 'q:4',
    cells: {
      ticker: cell('CVX'),
      sector: cell('Energy'),
      last: cell(158.9),
      vol: cell(700),
    },
  },
  {
    id: 'r-jpm',
    subject: 'q:5',
    cells: {
      ticker: cell('JPM'),
      sector: cell('Financials'),
      last: cell(198),
      vol: cell(1_500),
    },
  },
  {
    id: 'r-gs',
    subject: 'q:6',
    cells: {
      ticker: cell('GS'),
      sector: cell('Financials'),
      // Ties MSFT exactly: a stable sort keeps the payload's order, MSFT before GS.
      last: cell(402.1),
      vol: cell(500),
    },
  },
];

/* -------------------------------------------------------------------------------------------- */
/* The harness                                                                                    */
/* -------------------------------------------------------------------------------------------- */

type VisibleRow =
  | { kind: 'row'; row: GridRow }
  | { kind: 'group'; key: string; count: number; agg: Record<string, number | null>; collapsed: boolean };

interface HarnessProps {
  rows?: GridRow[];
  pageSize?: number;
  pageable?: boolean;
  selectable?: boolean;
}

/** What the test reads back about actions that leave the grid (paging, opening a row, columns). */
interface Log {
  pages: string[];
  opened: string[];
  columnMoves: number[];
}

function buildVisible(
  rows: readonly GridRow[],
  sort: SortState | null,
  groupBy: string | null,
  collapsed: ReadonlySet<string>,
): VisibleRow[] {
  const sorted = sortRows(rows, sort, COLUMNS);
  if (groupBy === null) return sorted.map((row) => ({ kind: 'row', row }));
  const blocks: GroupBlock[] = groupRows(sorted, groupBy, COLUMNS);
  return blocks.flatMap((block): VisibleRow[] => {
    const isCollapsed = collapsed.has(block.key);
    const header: VisibleRow = {
      kind: 'group',
      key: block.key,
      count: block.count,
      agg: block.agg,
      collapsed: isCollapsed,
    };
    if (isCollapsed) return [header];
    return [header, ...block.rows.map((row): VisibleRow => ({ kind: 'row', row }))];
  });
}

function GridHarness({
  rows = ROWS,
  pageSize = 3,
  pageable = false,
  selectable = true,
}: HarnessProps): ReactElement {
  const [sort, setSort] = useState<SortState | null>(null);
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set<string>());
  const [focus, setFocus] = useState<GridFocus>({ row: 0, col: 0 });
  const [selected, setSelected] = useState<string[]>([]);
  const [badge, setBadge] = useState<string | null>(null);
  const [log, setLog] = useState<Log>({ pages: [], opened: [], columnMoves: [] });
  const gate = useRef(new LiveSortGate({ now: () => 0 })).current;
  const gridRef = useRef<HTMLDivElement | null>(null);
  /**
   * Whether the grid holds the keyboard.
   *
   * A ref and not state, and it is not cleared by every `blur`, because of a trap the real grid has
   * too: re-rendering the rows (a sort, a grouping, a collapse) UNMOUNTS the focused cell, and the
   * browser then moves focus to `document.body`. Restoring it only when the grid still contains the
   * active element would therefore restore it never — the grid would go dead after the first `G`,
   * and every later keystroke would land on the body. So entry is remembered, and only a `blur`
   * that hands focus to a real element outside the grid gives it up.
   */
  const entered = useRef(false);

  const visible = buildVisible(rows, sort, groupBy, collapsed);
  const env: GridKeyEnv = {
    rows: visible,
    columnCount: COLUMNS.length,
    pageSize,
    pageable,
    selectable,
  };

  // The focus can be left dangling by a collapse (the rows under it went away), so it is clamped
  // against the CURRENT model on every render — the same call the component makes.
  const safeFocus = clampFocus(focus, env);

  // The roving tab stop IS the focus: the cell carrying `tabIndex={0}` is focused after every
  // keystroke that moved it. Focus is never STOLEN — the effect only acts once the grid already has
  // it, so the test's own `Tab` is what enters the node, exactly as a user's would be.
  useEffect(() => {
    const grid = gridRef.current;
    if (grid === null || !entered.current) return;
    const stop = grid.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]');
    if (stop !== null && stop !== document.activeElement) stop.focus();
  });

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    const action = gridKeyAction(e, safeFocus, env);
    if (action === null) return;
    e.preventDefault();
    switch (action.kind) {
      case 'focus':
        setFocus(action.focus);
        return;
      case 'page':
        setLog((prev) => ({ ...prev, pages: [...prev.pages, action.dir] }));
        return;
      case 'select': {
        const target = visible[safeFocus.row];
        if (target?.kind !== 'row') return;
        const id = target.row.id;
        setSelected((prev) =>
          action.extend
            ? prev.includes(id)
              ? prev
              : [...prev, id]
            : prev.includes(id)
              ? prev.filter((x) => x !== id)
              : [...prev, id],
        );
        return;
      }
      case 'open': {
        const target = visible[safeFocus.row];
        if (target?.kind !== 'row') return;
        setLog((prev) => ({
          ...prev,
          opened: [...prev.opened, `${action.nextPanel ? 'next:' : 'here:'}${target.row.id}`],
        }));
        return;
      }
      case 'toggle-group': {
        const target = visible[safeFocus.row];
        if (target?.kind !== 'group') return;
        setCollapsed((prev) => toggleCollapsed(prev, target.key));
        return;
      }
      case 'sort': {
        const column = COLUMNS[safeFocus.col];
        if (column === undefined || !isSortable(column)) return;
        const next = cycleSort(sort, column.id);
        setSort(next);
        gate.reset(0);
        setBadge(sortBadge(next, COLUMNS, gate));
        return;
      }
      case 'freeze-sort':
        gate.toggleFreeze();
        setBadge(sortBadge(sort, COLUMNS, gate));
        return;
      case 'group-cycle': {
        const next = nextGroupBy(groupBy, COLUMNS);
        setGroupBy(next);
        setCollapsed(new Set<string>());
        setFocus({ row: 0, col: safeFocus.col });
        return;
      }
      case 'move-column':
        setLog((prev) => ({ ...prev, columnMoves: [...prev.columnMoves, action.delta] }));
        return;
    }
  };

  return (
    <div>
      <div
        ref={gridRef}
        role="grid"
        aria-label="Keyboard harness"
        aria-rowcount={rows.length + 1}
        aria-colcount={COLUMNS.length}
        onKeyDown={onKeyDown}
        onFocus={() => {
          entered.current = true;
        }}
        onBlur={(e) => {
          const to = e.relatedTarget;
          if (to !== null && !e.currentTarget.contains(to)) entered.current = false;
        }}
      >
        <div role="row" aria-rowindex={1}>
          {COLUMNS.map((column) => (
            <span key={column.id} role="columnheader" aria-sort={ariaSort(sort, column.id)}>
              {column.label}
            </span>
          ))}
        </div>
        {visible.map((entry, ri) => {
          const key = entry.kind === 'group' ? `g:${entry.key}` : `r:${entry.row.id}`;
          return (
            <div key={key} role="row" aria-rowindex={ri + 2}>
              {COLUMNS.map((column, ci) => {
                const isFocused = ri === safeFocus.row && ci === safeFocus.col;
                if (entry.kind === 'group') {
                  const agg = entry.agg[column.id];
                  return (
                    <span
                      key={column.id}
                      role="gridcell"
                      tabIndex={isFocused ? 0 : -1}
                      data-prov-idx={-1}
                      {...(ci === 0 ? { 'aria-expanded': !entry.collapsed } : {})}
                    >
                      {ci === 0
                        ? `${entry.key} (${String(entry.count)})`
                        : agg === null
                          ? ''
                          : String(agg)}
                    </span>
                  );
                }
                const c: Cell | undefined = entry.row.cells[column.id];
                return (
                  <span
                    key={column.id}
                    role="gridcell"
                    tabIndex={isFocused ? 0 : -1}
                    data-prov-idx={c?.provIdx ?? -1}
                    data-st={c?.st ?? 'blank'}
                    aria-selected={selected.includes(entry.row.id)}
                  >
                    {c?.v === null || c?.v === undefined ? '—' : String(c.v)}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
      <output data-testid="focus">{`${String(safeFocus.row)}:${String(safeFocus.col)}`}</output>
      <output data-testid="selected">{selected.join(',')}</output>
      <output data-testid="badge">{badge ?? ''}</output>
      <output data-testid="pages">{log.pages.join(',')}</output>
      <output data-testid="opened">{log.opened.join(',')}</output>
      <output data-testid="columns">{log.columnMoves.join(',')}</output>
      <output data-testid="groupby">{groupBy ?? ''}</output>
    </div>
  );
}

/* -------------------------------------------------------------------------------------------- */
/* Helpers the assertions read                                                                    */
/* -------------------------------------------------------------------------------------------- */

const user = (): ReturnType<typeof userEvent.setup> => userEvent.setup({ delay: null });

/** `row:col` of the cell that currently owns the tab stop, read off the DOM rather than off state. */
function focusedAt(): string {
  return screen.getByTestId('focus').textContent ?? '';
}

/** The ticker column of every data row, in the order the grid draws them. */
function tickerColumn(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.firstElementChild?.textContent ?? '')
    .filter((text) => !text.includes('('));
}

/** Every row label the grid draws, group headers included. */
function rowLabels(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.firstElementChild?.textContent ?? '');
}

/* -------------------------------------------------------------------------------------------- */
/* Navigation                                                                                     */
/* -------------------------------------------------------------------------------------------- */

describe('grid keyboard navigation', () => {
  it('enters the grid on Tab and moves the focused cell with the arrows', async () => {
    const u = user();
    render(<GridHarness />);

    // One tab stop for the whole node (CLIENT.md §5.4): Tab lands on the focused cell, not on 24
    // separate cells.
    await u.tab();
    expect(document.activeElement).toHaveTextContent('AAPL');
    expect(focusedAt()).toBe('0:0');

    await u.keyboard('{ArrowDown}');
    expect(focusedAt()).toBe('1:0');
    expect(document.activeElement).toHaveTextContent('MSFT');

    await u.keyboard('{ArrowRight}{ArrowRight}');
    expect(focusedAt()).toBe('1:2');
    expect(document.activeElement).toHaveTextContent('402.1');

    await u.keyboard('{ArrowUp}{ArrowLeft}');
    expect(focusedAt()).toBe('0:1');
    expect(document.activeElement).toHaveTextContent('Tech');
  });

  it('clamps at every edge instead of wrapping', async () => {
    const u = user();
    render(<GridHarness />);
    await u.tab();

    await u.keyboard('{ArrowUp}{ArrowUp}{ArrowLeft}{ArrowLeft}');
    expect(focusedAt()).toBe('0:0');

    await u.keyboard('{Control>}{End}{/Control}');
    expect(focusedAt()).toBe('5:3');

    await u.keyboard('{ArrowDown}{ArrowRight}');
    expect(focusedAt()).toBe('5:3');
  });

  it('Home/End move along the row and Ctrl+Home/Ctrl+End cross the grid', async () => {
    const u = user();
    render(<GridHarness />);
    await u.tab();

    await u.keyboard('{ArrowDown}{ArrowDown}{End}');
    expect(focusedAt()).toBe('2:3');
    await u.keyboard('{Home}');
    expect(focusedAt()).toBe('2:0');

    await u.keyboard('{Control>}{End}{/Control}');
    expect(focusedAt()).toBe('5:3');
    await u.keyboard('{Control>}{Home}{/Control}');
    expect(focusedAt()).toBe('0:0');
  });

  it('PageDown/PageUp move one viewport of rows when the screen is not pageable', async () => {
    const u = user();
    render(<GridHarness pageSize={3} />);
    await u.tab();

    await u.keyboard('{PageDown}');
    expect(focusedAt()).toBe('3:0');
    await u.keyboard('{PageDown}');
    // Six rows: the second page lands on the last row rather than off the end.
    expect(focusedAt()).toBe('5:0');
    await u.keyboard('{PageUp}');
    expect(focusedAt()).toBe('2:0');
    expect(screen.getByTestId('pages').textContent).toBe('');
  });

  it('defers PageDown/PageUp to PAGE FWD/BACK on a pageable screen', async () => {
    const u = user();
    render(<GridHarness pageable />);
    await u.tab();

    await u.keyboard('{PageDown}{PageUp}');
    // The focus does not move: the rows for the next page are not in hand yet.
    expect(focusedAt()).toBe('0:0');
    expect(screen.getByTestId('pages').textContent).toBe('fwd,back');
  });

  it('opens a row with Enter and the next panel with Shift+Enter, and selects with Space', async () => {
    const u = user();
    render(<GridHarness />);
    await u.tab();

    await u.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByTestId('opened').textContent).toBe('here:r-msft');

    await u.keyboard('{Shift>}{Enter}{/Shift}');
    expect(screen.getByTestId('opened').textContent).toBe('here:r-msft,next:r-msft');

    await u.keyboard(' ');
    expect(screen.getByTestId('selected').textContent).toBe('r-msft');
    await u.keyboard('{ArrowDown} ');
    expect(screen.getByTestId('selected').textContent).toBe('r-msft,r-xom');
    await u.keyboard(' ');
    expect(screen.getByTestId('selected').textContent).toBe('r-msft');
  });

  it('moves a column with Ctrl+Arrow rather than the focus', async () => {
    const u = user();
    render(<GridHarness />);
    await u.tab();

    await u.keyboard('{ArrowRight}');
    expect(focusedAt()).toBe('0:1');
    await u.keyboard('{Control>}{ArrowRight}{/Control}');
    expect(focusedAt()).toBe('0:1');
    expect(screen.getByTestId('columns').textContent).toBe('1');
    await u.keyboard('{Control>}{ArrowLeft}{/Control}');
    expect(screen.getByTestId('columns').textContent).toBe('1,-1');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Sorting                                                                                        */
/* -------------------------------------------------------------------------------------------- */

describe('grid sort toggling', () => {
  it('cycles S over the focused column: ascending, descending, none', async () => {
    const u = user();
    render(<GridHarness />);
    await u.tab();

    const payloadOrder = ['AAPL', 'MSFT', 'XOM', 'CVX', 'JPM', 'GS'];
    expect(tickerColumn()).toEqual(payloadOrder);

    // Focus the `last` column and sort it.
    await u.keyboard('{ArrowRight}{ArrowRight}s');
    expect(tickerColumn()).toEqual(['CVX', 'AAPL', 'JPM', 'MSFT', 'GS', 'XOM']);

    await u.keyboard('s');
    expect(tickerColumn()).toEqual(['MSFT', 'GS', 'JPM', 'AAPL', 'CVX', 'XOM']);

    await u.keyboard('s');
    expect(tickerColumn()).toEqual(payloadOrder);
  });

  it('sinks the withheld price last in both directions and keeps ties in payload order', async () => {
    const u = user();
    render(<GridHarness />);
    await u.tab();
    await u.keyboard('{ArrowRight}{ArrowRight}s');

    // XOM's price is denied, not small: it is last ascending…
    expect(tickerColumn().at(-1)).toBe('XOM');
    await u.keyboard('s');
    // …and last descending too.
    expect(tickerColumn().at(-1)).toBe('XOM');
    // MSFT and GS both print 402.1; the payload put MSFT first and a stable sort leaves it there.
    expect(tickerColumn().slice(0, 2)).toEqual(['MSFT', 'GS']);
  });

  it('reports the sort in aria-sort on the column header', async () => {
    const u = user();
    render(<GridHarness />);
    await u.tab();

    const headers = screen.getAllByRole('columnheader');
    expect(headers.map((h) => h.getAttribute('aria-sort'))).toEqual([
      'none',
      'none',
      'none',
      'none',
    ]);

    await u.keyboard('{ArrowRight}{ArrowRight}s');
    expect(screen.getAllByRole('columnheader')[2]).toHaveAttribute('aria-sort', 'ascending');
    await u.keyboard('s');
    expect(screen.getAllByRole('columnheader')[2]).toHaveAttribute('aria-sort', 'descending');
    await u.keyboard('s');
    expect(screen.getAllByRole('columnheader')[2]).toHaveAttribute('aria-sort', 'none');
  });

  it('says in the footer that a live sort is periodic, and that Shift+S froze it', async () => {
    const u = user();
    render(<GridHarness />);
    await u.tab();

    // A payload column carries no badge: a static order needs no explanation.
    await u.keyboard('s');
    expect(screen.getByTestId('badge').textContent).toBe('');

    // `last` is a live column: the order is re-evaluated periodically, and the grid says so.
    await u.keyboard('{ArrowRight}{ArrowRight}s');
    expect(screen.getByTestId('badge').textContent).toBe('SORT LIVE');

    await u.keyboard('{Shift>}S{/Shift}');
    expect(screen.getByTestId('badge').textContent).toBe('SORT FROZEN');
    await u.keyboard('{Shift>}S{/Shift}');
    expect(screen.getByTestId('badge').textContent).toBe('SORT LIVE');
  });

  it('starts a new column at ascending rather than inheriting the previous direction', async () => {
    const u = user();
    render(<GridHarness />);
    await u.tab();

    await u.keyboard('ss');
    expect(screen.getAllByRole('columnheader')[0]).toHaveAttribute('aria-sort', 'descending');
    await u.keyboard('{ArrowRight}s');
    expect(screen.getAllByRole('columnheader')[0]).toHaveAttribute('aria-sort', 'none');
    expect(screen.getAllByRole('columnheader')[1]).toHaveAttribute('aria-sort', 'ascending');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Grouping and collapse                                                                          */
/* -------------------------------------------------------------------------------------------- */

describe('grid grouping and collapse', () => {
  it('cycles G over the groupable columns and back to ungrouped', async () => {
    const u = user();
    render(<GridHarness />);
    await u.tab();

    await u.keyboard('g');
    expect(screen.getByTestId('groupby').textContent).toBe('ticker');
    await u.keyboard('g');
    expect(screen.getByTestId('groupby').textContent).toBe('sector');
    // `last` and `vol` are live quantity columns and are not groupable, so the cycle ends here.
    await u.keyboard('g');
    expect(screen.getByTestId('groupby').textContent).toBe('');
    expect(rowLabels()).toEqual(['AAPL', 'MSFT', 'XOM', 'CVX', 'JPM', 'GS']);
  });

  it('draws one header per group with its count, and walks through headers with the arrows', async () => {
    const u = user();
    render(<GridHarness />);
    await u.tab();
    await u.keyboard('gg');

    expect(rowLabels()).toEqual([
      'Tech (2)',
      'AAPL',
      'MSFT',
      'Energy (2)',
      'XOM',
      'CVX',
      'Financials (2)',
      'JPM',
      'GS',
    ]);

    // A group header is a focus stop, not a gap: its aggregates are reachable by keyboard.
    expect(focusedAt()).toBe('0:0');
    await u.keyboard('{ArrowDown}');
    expect(focusedAt()).toBe('1:0');
    expect(document.activeElement).toHaveTextContent('AAPL');
  });

  it('collapses and expands a group with Enter on its header', async () => {
    const u = user();
    render(<GridHarness />);
    await u.tab();
    await u.keyboard('gg');

    await u.keyboard('{Enter}');
    expect(rowLabels()).toEqual(['Tech (2)', 'Energy (2)', 'XOM', 'CVX', 'Financials (2)', 'JPM', 'GS']);
    expect(screen.getAllByRole('gridcell')[0]).toHaveAttribute('aria-expanded', 'false');

    await u.keyboard('{Enter}');
    expect(rowLabels()).toEqual([
      'Tech (2)',
      'AAPL',
      'MSFT',
      'Energy (2)',
      'XOM',
      'CVX',
      'Financials (2)',
      'JPM',
      'GS',
    ]);
    expect(screen.getAllByRole('gridcell')[0]).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the focus inside the grid when a collapse removes the rows under it', async () => {
    const u = user();
    render(<GridHarness />);
    await u.tab();
    await u.keyboard('gg');

    // Focus the last row of the last group, then collapse every group from the bottom up.
    await u.keyboard('{Control>}{End}{/Control}');
    expect(focusedAt()).toBe('8:3');

    await u.keyboard('{ArrowUp}{ArrowUp}{Enter}');
    expect(rowLabels()).toEqual([
      'Tech (2)',
      'AAPL',
      'MSFT',
      'Energy (2)',
      'XOM',
      'CVX',
      'Financials (2)',
    ]);
    // The two rows that were below the focus are gone; the focus is on the header that swallowed
    // them, which is now the last row, and it is still a real cell.
    expect(focusedAt()).toBe('6:3');
    expect(document.activeElement).toHaveAttribute('role', 'gridcell');
    await u.keyboard('{ArrowDown}');
    expect(focusedAt()).toBe('6:3');
  });

  it('aggregates a grouped column as §10.3 says: sum for int, nothing for px', async () => {
    const u = user();
    render(<GridHarness />);
    await u.tab();
    await u.keyboard('gg');

    const techHeader = screen.getAllByRole('row')[1];
    const headerCells = [...(techHeader?.children ?? [])].map((el) => el.textContent);
    // ticker: the group label; sector: text, no aggregate; last: a price, deliberately blank;
    // vol: an integer column, summed (1 200 + 900).
    expect(headerCells).toEqual(['Tech (2)', '', '', '2100']);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The bindings the DOM cannot show                                                                */
/* -------------------------------------------------------------------------------------------- */

describe('grid key map', () => {
  const env: GridKeyEnv = {
    rows: [{ kind: 'group', collapsed: false }, { kind: 'row' }, { kind: 'row' }],
    columnCount: 3,
    pageSize: 10,
    pageable: false,
    selectable: true,
  };
  const base: KeyEventLike = {
    key: '',
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
  };
  const press = (over: Partial<KeyEventLike>): KeyEventLike => ({ ...base, ...over });

  it('leaves the reserved keys alone so the panel can answer them', () => {
    const focus: GridFocus = { row: 1, col: 1 };
    for (const [key, code] of [
      ['i', 'KeyI'],
      ['e', 'KeyE'],
      ['l', 'KeyL'],
    ] as const) {
      expect(gridKeyAction(press({ key, code, ctrlKey: true }), focus, env)).toBeNull();
    }
    expect(gridKeyAction(press({ key: 'Tab', code: 'Tab' }), focus, env)).toBeNull();
    expect(gridKeyAction(press({ key: 'Escape', code: 'Escape' }), focus, env)).toBeNull();
    // A printable key that is not S or G belongs to the command line (CLIENT.md §5.1 rule 5).
    expect(gridKeyAction(press({ key: 'q', code: 'KeyQ' }), focus, env)).toBeNull();
  });

  it('never claims Space on a group header, where there is nothing to select', () => {
    const onHeader: GridFocus = { row: 0, col: 0 };
    expect(gridKeyAction(press({ key: ' ', code: 'Space' }), onHeader, env)).toBeNull();
    expect(gridKeyAction(press({ key: ' ', code: 'Space' }), { row: 1, col: 0 }, env)).toEqual({
      kind: 'select',
      extend: false,
    });
  });

  it('offers no key hint it does not handle', () => {
    const hints = gridKeyHints(env).map((h) => h.key);
    expect(hints).toContain('S');
    expect(hints).toContain('G');
    expect(hints).toContain('Space');
    expect(gridKeyHints({ ...env, selectable: false }).map((h) => h.key)).not.toContain('Space');
  });

  it('names the ungrouped bucket rather than dropping rows that have no group value', () => {
    const blocks = groupRows(
      [{ id: 'x', cells: { sector: { v: null, st: 'blank', provIdx: 0 } } }],
      'sector',
      COLUMNS,
    );
    expect(blocks.map((b) => b.key)).toEqual([UNGROUPED_KEY]);
    expect(blocks[0]?.count).toBe(1);
  });
});
