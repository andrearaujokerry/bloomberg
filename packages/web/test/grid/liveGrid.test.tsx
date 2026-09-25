/**
 * `packages/web/test/grid/liveGrid.test.tsx` — WP-13's grid acceptance row (WORKPLAN L1428):
 * 1 000 rows × 12 columns, only the changed cells are touched on a delta, the flash is applied and
 * then cleared.
 *
 * **This file drives the real path.** WP-12's audit found three defects that its tests were
 * structurally incapable of catching, and every one of them had the same shape: the test built the
 * unit's input by hand, in a form no real payload produces, so it proved the capability existed
 * without ever touching the product path. So nothing here hand-builds a `QuoteView`. Frames are
 * built as the server sends them, parsed by `wire/ws.ts`'s own zod schemas — the normative wire
 * definition, the same objects WP-06's server tests are written against — and applied through the
 * SDK's real `QuoteCache`, with its real prev-chain rule. What reaches `cellRegistry` is whatever
 * came out of that, and the assertions are on the rendered DOM: the text a person would read, the
 * attributes that colour it, the accessible name a screen reader would hear.
 *
 * The frame pump is `test/setup.tsx`'s (TESTING.md §2.2): `requestAnimationFrame` queues, and
 * `flushFrames(n)` runs n frames. No `setTimeout` waiting appears below.
 */
import { Profiler, useCallback, useState } from 'react';
import type { ProfilerOnRenderCallback, ReactElement } from 'react';

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { format } from '@terminal/core';
import { Delta, QuoteCache, Snap } from '@terminal/sdk';

import { CellRegistry, CellRegistryContext } from '../../src/grid/cellRegistry.js';
import { LiveGrid } from '../../src/grid/LiveGrid.js';
import type { Cell, GridColumn, GridRow } from '../../src/screen/types.js';
import { flushFrames, pendingFrames } from '../setup.js';

/* ------------------------------------------------------------------------------------------- */
/* The payload: 1 000 rows × 12 columns, eleven of them live                                      */
/* ------------------------------------------------------------------------------------------- */

const ROW_COUNT = 1_000;
const ROW_HEIGHT = 20;
const VIEWPORT_PX = 400; // 20 rows visible, ±10 overscan → 40 rendered

/** The eleven live fields, and the change field that is rendered with a sign. */
const LIVE_FIELDS = [
  'PX_LAST',
  'PX_BID',
  'PX_ASK',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_CLOSE_1D',
  'PX_VOLUME',
  'VWAP',
  'CHG_NET_1D',
  'CHG_PCT_1D',
] as const;

const SIGNED_FIELDS = new Set<string>(['CHG_NET_1D', 'CHG_PCT_1D']);

const FMT_OF: Record<string, NonNullable<GridColumn['fmt']>> = {
  PX_LAST: 'px',
  PX_BID: 'px',
  PX_ASK: 'px',
  PX_OPEN: 'px',
  PX_HIGH: 'px',
  PX_LOW: 'px',
  PX_CLOSE_1D: 'px',
  PX_VOLUME: 'int',
  VWAP: 'px',
  CHG_NET_1D: 'px',
  CHG_PCT_1D: 'pct',
};

const COLUMNS: GridColumn[] = [
  { id: 'ticker', label: 'Ticker', fmt: 'text', width: 10, sortable: true },
  ...LIVE_FIELDS.map((field) => ({
    id: field,
    label: field,
    fieldId: field,
    fmt: FMT_OF[field],
    live: true,
    align: 'right' as const,
    width: 12,
  })),
];

function baseValue(rowIndex: number, field: string): number {
  const seed = rowIndex + 1;
  if (field === 'PX_VOLUME') return seed * 1_000;
  if (field === 'CHG_PCT_1D') return (seed % 7) - 3;
  if (field === 'CHG_NET_1D') return ((seed % 5) - 2) / 2;
  return 100 + seed / 10;
}

function makeRows(count = ROW_COUNT): GridRow[] {
  const rows: GridRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const cells: Record<string, Cell> = {
      ticker: { v: `T${String(i)}`, st: 'live', provIdx: 0, fmt: 'text' },
    };
    for (const field of LIVE_FIELDS) {
      const cell: Cell = {
        v: baseValue(i, field),
        st: 'live',
        provIdx: 1,
        fieldId: field,
        fmt: FMT_OF[field],
        ts: 1_789_497_688_000,
      };
      // A change column carries a `dir`; that is what tells CellView — and the grid — to print the
      // sign and the ▲/▼, and it is the only thing that does.
      if (SIGNED_FIELDS.has(field))
        cell.dir = cell.v !== null && Number(cell.v) < 0 ? 'down' : 'up';
      cells[field] = cell;
    }
    rows.push({ id: `r${String(i)}`, subject: `q:${String(i)}`, cells });
  }
  return rows;
}

/* ------------------------------------------------------------------------------------------- */
/* Wire frames, through the normative schemas                                                     */
/* ------------------------------------------------------------------------------------------- */

const TS_BASE = 1_789_497_688_000;

function snapFor(rowIndex: number, seq: number, overrides: Record<string, unknown> = {}): Snap {
  const f: Record<string, number> = {};
  const fts: Record<string, number> = {};
  for (const field of LIVE_FIELDS) {
    f[field] = baseValue(rowIndex, field);
    fts[field] = TS_BASE;
  }
  return Snap.parse({
    t: 'snap',
    s: `q:${String(rowIndex)}`,
    seq,
    tier: 'delayed',
    reason: 'SOURCE_TIER_CAP',
    f,
    fts,
    ts: { src: TS_BASE, cap: TS_BASE + 10, pub: TS_BASE + 11 },
    st: 'live',
    session: 'open',
    prov: { p: 'cboe.quotes', id: 88213, seq: 15_972_883_317 },
    ac: 'equity',
    id: rowIndex,
    ...overrides,
  });
}

function deltaFor(
  rowIndex: number,
  seq: number,
  prev: number,
  f: Record<string, number | null>,
): Delta {
  const fts: Record<string, number> = {};
  for (const field of Object.keys(f)) if (f[field] !== null) fts[field] = TS_BASE + seq;
  return Delta.parse({
    t: 'delta',
    s: `q:${String(rowIndex)}`,
    seq,
    prev,
    f,
    fts,
    ts: { src: TS_BASE + seq, cap: TS_BASE + seq + 1, pub: TS_BASE + seq + 2 },
    st: 'live',
  });
}

/* ------------------------------------------------------------------------------------------- */
/* Harness                                                                                        */
/* ------------------------------------------------------------------------------------------- */

interface Harness {
  registry: CellRegistry;
  cache: QuoteCache;
  touched: string[];
  /** Apply a frame through the real cache and queue whatever it says changed. */
  feed(frame: Snap | Delta): { changed: string[]; resyncNeeded: boolean };
  commits(): number;
}

let clientHeightSpy: PropertyDescriptor | undefined;

function stubViewportHeight(): void {
  clientHeightSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains('grid__viewport') ? VIEWPORT_PX : 0;
    },
  });
}

function restoreViewportHeight(): void {
  if (clientHeightSpy === undefined) {
    // jsdom's own `clientHeight` is on the prototype as a getter; if it was absent, remove ours.
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    return;
  }
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightSpy);
  clientHeightSpy = undefined;
}

function mountGrid(
  rows: GridRow[],
  props: Record<string, unknown> = {},
  opts: { now?: () => number } = {},
): Harness {
  const touched: string[] = [];
  const registry = new CellRegistry({
    onWrite: (cell) => touched.push(`${cell.subject}/${cell.fieldId}`),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  const cache = new QuoteCache();
  let commits = 0;
  const onRender: ProfilerOnRenderCallback = () => {
    commits += 1;
  };

  render(
    <Profiler id="grid" onRender={onRender}>
      <CellRegistryContext.Provider value={registry}>
        <LiveGrid
          id="g1"
          columns={COLUMNS}
          rows={rows}
          rowHeight={ROW_HEIGHT}
          live={{ subjectOf: (row: GridRow) => row.subject ?? null }}
          {...props}
        />
      </CellRegistryContext.Provider>
    </Profiler>,
  );

  return {
    registry,
    cache,
    touched,
    feed(frame) {
      const result = cache.apply(frame);
      const state = cache.get(frame.s);
      if (state !== undefined) {
        registry.apply({ subject: frame.s, changed: result.changed, state });
      }
      return result;
    },
    commits: () => commits,
  };
}

function cellEl(subject: string, field: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-subject="${subject}"][data-field="${field}"]`,
  );
  if (el === null) throw new Error(`no cell on screen for ${subject} ${field}`);
  return el;
}

/** Every rendered cell of one column, top to bottom: which row it is in and what it reads. */
function columnAsRendered(field: string): { row: string; text: string; value: number }[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-field="${field}"]`)].map((el) => {
    const text = el.textContent ?? '';
    return {
      row: el.closest('[data-row-id]')?.getAttribute('data-row-id') ?? '?',
      text,
      value: Number(text.replace(/[^0-9.-]/g, '')),
    };
  });
}

beforeEach(stubViewportHeight);
afterEach(restoreViewportHeight);

/* ------------------------------------------------------------------------------------------- */

describe('LiveGrid — 1 000 rows × 12 columns', () => {
  it('virtualises: the DOM holds the window, the ARIA counts hold the model', () => {
    mountGrid(makeRows());

    const grid = screen.getByRole('grid');
    // The model, not the window. A screen reader told there are 40 rows when there are 1 000 has
    // been told something false, and it is the count it uses to say "row 3 of …".
    expect(grid.getAttribute('aria-rowcount')).toBe(String(ROW_COUNT + 1));
    expect(grid.getAttribute('aria-colcount')).toBe(String(COLUMNS.length));

    const rendered = document.querySelectorAll('[role="row"][data-row-id]').length;
    expect(rendered).toBeGreaterThan(20);
    expect(rendered).toBeLessThan(60);

    // Every cell names its source (DATA-10; the DOM contract in `screen/widgets/registry.ts`).
    const cells = [...document.querySelectorAll<HTMLElement>('[role="gridcell"]')];
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => c.getAttribute('data-prov-idx') !== null)).toBe(true);
    // `data-st` carries the state colour and the state glyph, and on a live cell it is the REGISTRY
    // that writes it (React writes nothing into a live cell). Every cell still has one before the
    // first frame, or a grid with no socket attached would draw 40 rows with no state at all.
    expect(cells.every((c) => c.getAttribute('data-st') !== null)).toBe(true);
    expect(cells.every((c) => c.getAttribute('aria-label') !== null)).toBe(true);
  });

  it('a snap that restates the payload writes nothing', () => {
    const h = mountGrid(makeRows());
    const result = h.feed(snapFor(0, 4_182));

    expect(result.changed).toHaveLength(LIVE_FIELDS.length);
    flushFrames(1);

    // Eleven fields arrived and eleven fields were already on screen with those exact values. A
    // grid that repainted them would also flash them, four times a second, meaning nothing.
    expect(h.registry.stats.writes).toBe(0);
    expect(h.registry.stats.skipped).toBe(LIVE_FIELDS.length);
    expect(h.touched).toEqual([]);
  });

  it('ONLY the changed cells are touched on a delta', () => {
    const h = mountGrid(makeRows());
    h.feed(snapFor(0, 4_182));
    flushFrames(1);
    h.touched.length = 0;

    const before = new Map<string, string>();
    for (const field of LIVE_FIELDS) before.set(field, cellEl('q:0', field).textContent ?? '');

    const next = { PX_LAST: baseValue(0, 'PX_LAST') + 0.04, PX_VOLUME: 16_601_102 };
    const result = h.feed(deltaFor(0, 4_185, 4_182, next));
    expect(result.resyncNeeded).toBe(false);
    expect(result.changed.sort()).toEqual(['PX_LAST', 'PX_VOLUME']);

    flushFrames(1);

    // The assertion the package exists for: two fields changed, two cells written, and the other
    // nine — on this row, and every cell of the other 39 rendered rows — were not touched at all.
    expect(h.registry.stats.writes).toBe(2);
    expect(h.touched).toEqual(['q:0/PX_LAST', 'q:0/PX_VOLUME']);

    expect(cellEl('q:0', 'PX_LAST').textContent).toBe(format('PX_LAST', next.PX_LAST, {}));
    expect(cellEl('q:0', 'PX_VOLUME').textContent).toBe(format('PX_VOLUME', next.PX_VOLUME, {}));
    for (const field of LIVE_FIELDS) {
      if (field === 'PX_LAST' || field === 'PX_VOLUME') continue;
      expect(cellEl('q:0', field).textContent).toBe(before.get(field));
    }
  });

  it('the flash is applied on the cells that moved and then cleared', () => {
    const h = mountGrid(makeRows());
    h.feed(snapFor(0, 4_182));
    flushFrames(1);

    h.feed(
      deltaFor(0, 4_185, 4_182, {
        PX_LAST: baseValue(0, 'PX_LAST') + 1,
        PX_BID: baseValue(0, 'PX_BID') - 1,
      }),
    );
    flushFrames(1);

    const up = cellEl('q:0', 'PX_LAST');
    const down = cellEl('q:0', 'PX_BID');
    expect(up.classList.contains('flash-up')).toBe(true);
    expect(up.getAttribute('data-dir')).toBe('up');
    expect(down.classList.contains('flash-down')).toBe(true);
    expect(down.getAttribute('data-dir')).toBe('down');
    // Nothing else on screen is lit.
    expect(document.querySelectorAll('.flash-up, .flash-down')).toHaveLength(2);

    // `animationend` does not fire in jsdom (TESTING.md §2.2), so the removal is driven explicitly
    // here and the 700 ms lifetime is Playwright's to assert. A flash that never cleared would
    // leave a cell saying "this just changed" about a number that has not moved since.
    h.registry.endFlash();
    expect(document.querySelectorAll('.flash-up, .flash-down')).toHaveLength(0);
    expect(up.classList.contains('flash-up')).toBe(false);
  });

  it('a delta for an off-screen subject touches nothing', () => {
    const h = mountGrid(makeRows());
    h.feed(snapFor(900, 10));
    h.feed(deltaFor(900, 11, 10, { PX_LAST: 999 }));
    flushFrames(2);

    expect(h.registry.stats.writes).toBe(0);
    expect(document.querySelector('[data-subject="q:900"]')).toBeNull();
  });

  it('fifty deltas between two frames produce one frame and one write per cell', () => {
    const h = mountGrid(makeRows());
    h.feed(snapFor(0, 4_182));
    flushFrames(1);
    h.touched.length = 0;
    const framesBefore = h.registry.stats.frames;

    let seq = 4_182;
    let last = baseValue(0, 'PX_LAST');
    for (let i = 0; i < 50; i += 1) {
      const prev = seq;
      seq += 1;
      last += 0.01;
      h.feed(deltaFor(0, seq, prev, { PX_LAST: last }));
    }

    // Fifty batches, one scheduled frame — `apply` never writes.
    expect(pendingFrames()).toBe(1);
    flushFrames(1);

    expect(h.registry.stats.frames).toBe(framesBefore + 1);
    expect(h.touched).toEqual(['q:0/PX_LAST']);
    // The latest value, not the first: the write reads the live QuoteView at write time.
    expect(cellEl('q:0', 'PX_LAST').textContent).toBe(format('PX_LAST', last, {}));
  });

  it('React is not on the tick path', () => {
    const h = mountGrid(makeRows());
    h.feed(snapFor(0, 4_182));
    flushFrames(1);
    const commitsBefore = h.commits();

    let seq = 4_182;
    let last = baseValue(0, 'PX_LAST');
    for (let i = 0; i < 500; i += 1) {
      const prev = seq;
      seq += 1;
      last += 0.01;
      h.feed(deltaFor(0, seq, prev, { PX_LAST: last }));
      flushFrames(1);
    }

    expect(h.registry.stats.writes).toBeGreaterThanOrEqual(500);
    // Five hundred deltas, five hundred DOM writes, and not one React commit.
    expect(h.commits()).toBe(commitsBefore);
  });

  it('a gapped delta resyncs rather than writing a wrong number (API.md §6.3 step 3)', () => {
    const h = mountGrid(makeRows());
    h.feed(snapFor(0, 4_182));
    flushFrames(1);
    const shown = cellEl('q:0', 'PX_LAST').textContent;
    h.touched.length = 0;

    // prev 4_190 ≠ the cached 4_182: a frame was lost, so this number cannot be trusted to be the
    // next one in the chain. It is not applied, and nothing on screen moves.
    const result = h.feed(deltaFor(0, 4_191, 4_190, { PX_LAST: 1_234.5 }));
    expect(result.resyncNeeded).toBe(true);
    expect(result.changed).toEqual([]);
    flushFrames(1);

    expect(h.touched).toEqual([]);
    expect(cellEl('q:0', 'PX_LAST').textContent).toBe(shown);
  });
});

describe('LiveGrid — the states a cell can be in (TERM-12, ENTL-05)', () => {
  it('a denied field shows its reason in the visible text, not a hidden span', () => {
    const rows = makeRows(4);
    const h = mountGrid(rows);

    h.feed(
      snapFor(0, 1, {
        reason: 'NO_USER_ENTITLEMENT',
        f: { ...Object.fromEntries(LIVE_FIELDS.map((f) => [f, null])), PX_LAST: null },
        fts: {},
        r: Object.fromEntries(LIVE_FIELDS.map((f) => [f, 'NO_USER_ENTITLEMENT'])),
        st: 'blank',
      }),
    );
    flushFrames(1);

    const cell = cellEl('q:0', 'PX_LAST');
    expect(cell.getAttribute('data-st')).toBe('blank');
    // The reason is IN the cell's own text. WP-12 found 73 blanks whose reason sat in a span
    // clipped to one pixel, which made a price withheld by entitlement and a price the source does
    // not have look identical. `textContent` here is what a person reads on the screen.
    expect(cell.textContent).toContain('NO_USER_ENTITLEMENT');
    expect(cell.textContent).toContain('—');
    expect(cell.getAttribute('aria-label')).toContain('unavailable');
  });

  it('a live cell and a stale cell with the same number do not read alike', () => {
    const h = mountGrid(makeRows(4));
    h.feed(snapFor(0, 1));
    h.feed(snapFor(1, 1));
    flushFrames(1);

    const live = cellEl('q:0', 'PX_LAST');
    const before = live.getAttribute('aria-label');
    expect(live.getAttribute('data-st')).toBe('live');

    // The real staleness path: the SDK cache re-runs `core/quote/staleness.ts#valueState` — the
    // same function the server's sweep calls — and the grid restyles whatever moved (TERM-12).
    const moved = h.cache.sweep(TS_BASE + 10 * 60 * 1_000);
    expect(moved).toContain('q:0');
    h.registry.restyle(moved, (subject) => h.cache.get(subject)?.st);

    expect(live.getAttribute('data-st')).toBe('stale');
    expect(live.getAttribute('aria-label')).not.toBe(before);
    expect(live.getAttribute('aria-label')).toContain('stale, no fresh update');
    // The number is unchanged — going stale is not the number changing — and nothing flashed.
    expect(live.textContent).toBe(format('PX_LAST', baseValue(0, 'PX_LAST'), {}));
    expect(document.querySelectorAll('.flash-up, .flash-down')).toHaveLength(0);
  });

  it('a shed subject keeps its value, says so, and stops looking live (API.md §6.5)', () => {
    const h = mountGrid(makeRows(4));
    h.feed(snapFor(0, 1));
    flushFrames(1);

    const cell = cellEl('q:0', 'PX_LAST');
    const value = cell.textContent;
    h.registry.setSubjectStatus('q:0', 'shed');

    expect(cell.textContent).toBe(value);
    expect(cell.getAttribute('data-status')).toBe('shed');
    expect(cell.getAttribute('data-st')).toBe('stale');
    expect(cell.getAttribute('aria-label')).toContain('shed');
  });

  it('a change column prints its sign and its glyph, as CellView does', () => {
    const h = mountGrid(makeRows(4));
    h.feed(snapFor(0, 1));
    flushFrames(1);
    h.feed(deltaFor(0, 2, 1, { CHG_PCT_1D: -1.5 }));
    flushFrames(1);

    const cell = cellEl('q:0', 'CHG_PCT_1D');
    expect(cell.textContent?.startsWith('▼')).toBe(true);
    expect(cell.textContent).toContain(format('CHG_PCT_1D', -1.5, { signed: true }));
    // `data-dir` on a change cell is the SIGN — what colours it — while the flash is the movement.
    // −1.5 % rose from baseValue(0, 'CHG_PCT_1D') = −2, so it flashes up and stays red.
    expect(cell.getAttribute('data-dir')).toBe('down');
    expect(cell.classList.contains('flash-up')).toBe(true);
  });
});

describe('LiveGrid — keyboard and structure', () => {
  it('is one tab stop even when it is empty', () => {
    render(
      <LiveGrid
        id="empty"
        columns={COLUMNS}
        rows={[]}
        emptyText="No positions."
        rowHeight={ROW_HEIGHT}
      />,
    );
    const grid = screen.getByRole('grid');
    expect(grid.getAttribute('tabindex')).toBe('0');
    expect(screen.getByText('No positions.')).toBeInTheDocument();
    // The headers are still there and still reachable — an empty node that cannot be focused is a
    // node the keyboard has lost, which is the defect WP-12 found on a government bond's DES.
    expect(screen.getAllByRole('columnheader')).toHaveLength(COLUMNS.length);
  });

  it('arrow keys move the focused cell and Enter on a header sorts', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    mountGrid(makeRows(50));

    const grid = screen.getByRole('grid');
    const firstCell = document.querySelector<HTMLElement>('[data-row-id="r0"] [data-col="ticker"]');
    expect(firstCell).not.toBeNull();
    firstCell?.focus();
    expect(document.activeElement).toBe(firstCell);

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.getAttribute('data-col')).toBe('PX_LAST');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.closest('[data-row-id]')?.getAttribute('data-row-id')).toBe(
      'r1',
    );
    await user.keyboard('{Home}');
    expect(document.activeElement?.getAttribute('data-col')).toBe('ticker');

    // Up from the first body row lands on the header, which is how sorting is reached with no
    // second tab stop and no mouse.
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(document.activeElement?.getAttribute('role')).toBe('columnheader');
    expect(grid.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Enter}');
    const header = screen.getAllByRole('columnheader')[0];
    expect(header?.getAttribute('aria-sort')).toBe('ascending');
  });

  it('S sorts, G groups, Space selects and Ctrl+Arrow reorders — on the shipped component', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const selections: string[][] = [];
    const orders: string[][] = [];
    mountGrid(makeRows(30), {
      selectable: true,
      onSelectionChange: (ids: string[]) => selections.push(ids),
      onColumnsChange: (order: string[]) => orders.push(order),
    });

    const cell = document.querySelector<HTMLElement>('[data-row-id="r0"] [data-col="PX_LAST"]');
    cell?.focus();
    const headerOf = (col: string): HTMLElement | undefined =>
      screen.getAllByRole('columnheader').find((h) => h.dataset.col === col);
    expect(headerOf('PX_LAST')?.getAttribute('aria-sort')).toBe('none');
    expect(document.querySelectorAll('.grid__row--group')).toHaveLength(0);

    // `S` is `keyboard.ts`'s sort binding, and it must reach the same `cycleSort` the header's
    // Enter does — one answer to "what does sorting do next", driven here through the real grid.
    await user.keyboard('s');
    expect(headerOf('PX_LAST')?.getAttribute('aria-sort')).toBe('ascending');

    await user.keyboard(' ');
    expect(selections.at(-1)).toEqual(['r0']);

    await user.keyboard('{Control>}{ArrowRight}{/Control}');
    expect(orders.at(-1)?.[0]).toBe('ticker');
    expect(orders.at(-1)?.indexOf('PX_LAST')).toBeGreaterThan(1);

    await user.keyboard('g');
    expect(document.querySelectorAll('.grid__row--group').length).toBeGreaterThan(0);
  });

  it('a row scrolled out and back shows the live value, not the payload value', () => {
    const h = mountGrid(makeRows());
    h.feed(snapFor(0, 1));
    h.feed(deltaFor(0, 2, 1, { PX_LAST: 4_242.5 }));
    flushFrames(1);
    expect(cellEl('q:0', 'PX_LAST').textContent).toBe(format('PX_LAST', 4_242.5, {}));

    // Scroll far past row 0 and back. Virtualisation unmounts the row and mounts a fresh one whose
    // React content is the payload's original price; the registry repaints it from the newest view
    // it holds, so the cell that comes back is not a stale number wearing a live face.
    const viewport = document.querySelector<HTMLElement>('.grid__viewport');
    if (viewport === null) throw new Error('no viewport');
    act(() => {
      viewport.scrollTop = 20_000;
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(document.querySelector('[data-subject="q:0"]')).toBeNull();

    act(() => {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(cellEl('q:0', 'PX_LAST').textContent).toBe(format('PX_LAST', 4_242.5, {}));
  });
});

/** A grid inside a component that can change its own props, for the controlled-sort path. */
function Controlled({ rows }: { rows: GridRow[] }): ReactElement {
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null);
  const onSortChange = useCallback((next: { col: string; dir: 'asc' | 'desc' } | null) => {
    setSort(next);
  }, []);
  return (
    <LiveGrid
      id="c1"
      columns={COLUMNS}
      rows={rows}
      rowHeight={ROW_HEIGHT}
      {...(sort === null ? {} : { sort })}
      onSortChange={onSortChange}
    />
  );
}

describe('LiveGrid — sorting', () => {
  it('a controlled grid reorders when its screen gives it a new sort', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const rows = makeRows(30);
    render(<Controlled rows={rows} />);

    const firstBefore = document.querySelector('[data-row-id]')?.getAttribute('data-row-id');
    expect(firstBefore).toBe('r0');

    const header = screen.getAllByRole('columnheader')[1];
    header?.focus();
    await user.keyboard('{Enter}');

    // PX_LAST ascends with the row index, so ascending leaves r0 first; descending must not.
    await user.keyboard('{Enter}');
    expect(screen.getAllByRole('columnheader')[1]?.getAttribute('aria-sort')).toBe('descending');
    expect(document.querySelector('[data-row-id]')?.getAttribute('data-row-id')).toBe('r29');
  });
});

/* ------------------------------------------------------------------------------------------- */
/* The live order and the live aggregates (CLIENT.md §10.3, §10.4)                                */
/* ------------------------------------------------------------------------------------------- */

describe('LiveGrid — the order it claims is the order it has', () => {
  it('re-sorts on live values, so the rendered order matches the rendered numbers', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    // Throttle 0: the policy is `LiveSortGate`'s and has its own test; what is asserted here is that
    // the grid is WIRED to it, which is what was missing.
    const h = mountGrid(makeRows(6), { liveSortThrottleMs: 0 });

    const header = screen.getAllByRole('columnheader')[1];
    expect(header?.getAttribute('data-col')).toBe('PX_LAST');
    header?.focus();
    await user.keyboard('{Enter}');
    expect(screen.getAllByRole('columnheader')[1]?.getAttribute('aria-sort')).toBe('ascending');
    expect(columnAsRendered('PX_LAST').map((c) => c.row)).toEqual([
      'r0',
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
    ]);

    // Invert the column on the wire: r0 becomes the highest.
    for (let i = 0; i < 6; i += 1) {
      h.feed(snapFor(i, 1));
      h.feed(deltaFor(i, 2, 1, { PX_LAST: 200 - i }));
    }
    act(() => {
      flushFrames(1);
    });

    const rendered = columnAsRendered('PX_LAST');
    // The defect this replaces: the column read 1 000 / 990 / 980 top to bottom while the header
    // said `aria-sort="ascending"`. The screen and the screen reader both asserted an order the grid
    // did not have. So the assertion is on the NUMBERS as drawn, not on the row ids alone.
    expect(rendered.map((c) => c.value)).toEqual([195, 196, 197, 198, 199, 200]);
    expect(rendered.map((c) => c.row)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1', 'r0']);
    expect(screen.getAllByRole('columnheader')[1]?.getAttribute('aria-sort')).toBe('ascending');
    // React was on this path exactly once — the re-sort — not once per delta.
    expect(h.registry.stats.frames).toBe(1);
  });

  it('keeps the focus on the row a re-sort moved, not on the slot it left', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const h = mountGrid(makeRows(6), { liveSortThrottleMs: 0 });

    const header = screen.getAllByRole('columnheader')[1];
    header?.focus();
    await user.keyboard('{Enter}');
    // Down onto the first body row, which is r0 while the order is the payload's.
    await user.keyboard('{ArrowDown}');
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.closest('[data-row-id]')?.getAttribute('data-row-id')).toBe('r0');

    for (let i = 0; i < 6; i += 1) {
      h.feed(snapFor(i, 1));
      h.feed(deltaFor(i, 2, 1, { PX_LAST: 200 - i }));
    }
    act(() => {
      flushFrames(1);
    });

    // r0 is now last. The focus is still on r0's cell, and the grid's own idea of where the focus is
    // has followed it — so the next ArrowUp moves off r0 rather than off whatever took its slot.
    const after = document.activeElement as HTMLElement | null;
    expect(after?.closest('[data-row-id]')?.getAttribute('data-row-id')).toBe('r0');
    expect(after?.getAttribute('tabindex')).toBe('0');
    await user.keyboard('{ArrowUp}');
    expect(
      (document.activeElement as HTMLElement | null)
        ?.closest('[data-row-id]')
        ?.getAttribute('data-row-id'),
    ).toBe('r1');
  });

  it('Shift+S freezes the order, says which state it is in, and lets it move again', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const h = mountGrid(makeRows(6), { liveSortThrottleMs: 0 });

    const header = screen.getAllByRole('columnheader')[1];
    header?.focus();
    await user.keyboard('{Enter}');

    const grid = screen.getByRole('grid');
    // A live sort is periodic, so the grid says so rather than leaving the user to wonder why the
    // rows move on their own.
    expect(grid.getAttribute('data-sort-badge')).toBe('SORT LIVE');
    expect(screen.getByText('SORT LIVE')).toBeDefined();

    await user.keyboard('{Shift>}S{/Shift}');
    expect(grid.getAttribute('data-sort-frozen')).toBe('true');
    expect(grid.getAttribute('data-sort-badge')).toBe('SORT FROZEN');

    for (let i = 0; i < 6; i += 1) {
      h.feed(snapFor(i, 1));
      h.feed(deltaFor(i, 2, 1, { PX_LAST: 200 - i }));
    }
    act(() => {
      flushFrames(1);
    });

    // Frozen means frozen: the numbers updated in place and the rows did not move.
    expect(columnAsRendered('PX_LAST').map((c) => c.row)).toEqual([
      'r0',
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
    ]);
    expect(columnAsRendered('PX_LAST').map((c) => c.value)).toEqual([
      200, 199, 198, 197, 196, 195,
    ]);

    await user.keyboard('{Shift>}S{/Shift}');
    h.feed(deltaFor(0, 3, 2, { PX_LAST: 200.5 }));
    act(() => {
      flushFrames(1);
    });
    expect(grid.getAttribute('data-sort-badge')).toBe('SORT LIVE');
    expect(columnAsRendered('PX_LAST').map((c) => c.row)).toEqual([
      'r5',
      'r4',
      'r3',
      'r2',
      'r1',
      'r0',
    ]);
  });

  it('does not re-order under a held key', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const h = mountGrid(makeRows(6), { liveSortThrottleMs: 0 });

    const header = screen.getAllByRole('columnheader')[1];
    header?.focus();
    await user.keyboard('{Enter}');
    for (let i = 0; i < 6; i += 1) h.feed(snapFor(i, 1));
    act(() => {
      flushFrames(1);
    });

    // ArrowDown held down, no keyup yet: a row that moved out from under the key would take the
    // user somewhere they did not navigate to.
    await user.keyboard('{ArrowDown>}');
    for (let i = 0; i < 6; i += 1) h.feed(deltaFor(i, 2, 1, { PX_LAST: 200 - i }));
    act(() => {
      flushFrames(1);
    });
    expect(columnAsRendered('PX_LAST').map((c) => c.row)).toEqual([
      'r0',
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
    ]);

    await user.keyboard('{/ArrowDown}');
    h.feed(deltaFor(0, 3, 2, { PX_LAST: 200.5 }));
    act(() => {
      flushFrames(1);
    });
    expect(columnAsRendered('PX_LAST').map((c) => c.row)).toEqual([
      'r5',
      'r4',
      'r3',
      'r2',
      'r1',
      'r0',
    ]);
  });
});

describe('LiveGrid — group aggregates track the cells under them (CLIENT.md §10.4)', () => {
  it("recomputes a group's sum from live values, at most once a second", () => {
    const rows = makeRows(4).map((row, i) => ({ ...row, group: i < 2 ? 'A' : 'B' }));
    let now = 10_000;
    const h = mountGrid(rows, { groupBy: 'ticker' }, { now: () => now });

    const groupA = document.querySelector<HTMLElement>('[data-group="A"]');
    if (groupA === null) throw new Error('no group header for A');
    const volumeOf = (header: HTMLElement): string =>
      header.querySelector<HTMLElement>('[data-col="PX_VOLUME"]')?.textContent ?? '';

    // The payload's sum: rows 0 and 1 hold 1 000 and 2 000.
    expect(volumeOf(groupA)).toBe(format('PX_VOLUME', 3_000, {}));

    for (const i of [0, 1]) {
      h.feed(snapFor(i, 1));
      h.feed(deltaFor(i, 2, 1, { PX_VOLUME: 5_000 }));
    }
    act(() => {
      flushFrames(1);
    });

    // A total from the moment the screen opened, sitting above rows that are updating four times a
    // second, is a wrong number that looks like a right one. It tracks the cells.
    const headerA = document.querySelector<HTMLElement>('[data-group="A"]');
    if (headerA === null) throw new Error('group A vanished');
    expect(volumeOf(headerA)).toBe(format('PX_VOLUME', 10_000, {}));

    // …and not per delta: inside the same second the header holds still.
    h.feed(deltaFor(0, 3, 2, { PX_VOLUME: 9_000 }));
    act(() => {
      flushFrames(1);
    });
    expect(
      document.querySelector<HTMLElement>('[data-group="A"]')?.querySelector('[data-col="PX_VOLUME"]')
        ?.textContent,
    ).toBe(format('PX_VOLUME', 10_000, {}));

    now += 1_000;
    h.feed(deltaFor(0, 4, 3, { PX_VOLUME: 9_500 }));
    act(() => {
      flushFrames(1);
    });
    expect(
      document.querySelector<HTMLElement>('[data-group="A"]')?.querySelector('[data-col="PX_VOLUME"]')
        ?.textContent,
    ).toBe(format('PX_VOLUME', 14_500, {}));
  });
});

/* ------------------------------------------------------------------------------------------- */
/* One writer per cell                                                                            */
/* ------------------------------------------------------------------------------------------- */

describe('LiveGrid — the registry is the only writer of a live cell', () => {
  it('a repaint carrying an older payload cannot put its number back on screen', () => {
    const rows = makeRows(4);
    const registry = new CellRegistry();
    const cache = new QuoteCache();
    const feed = (frame: Snap | Delta): void => {
      const result = cache.apply(frame);
      const state = cache.get(frame.s);
      if (state !== undefined) {
        registry.apply({ subject: frame.s, changed: result.changed, state });
      }
    };

    const view = (r: GridRow[]): ReactElement => (
      <CellRegistryContext.Provider value={registry}>
        <LiveGrid
          id="g1"
          columns={COLUMNS}
          rows={r}
          rowHeight={ROW_HEIGHT}
          live={{ subjectOf: (row: GridRow) => row.subject ?? null }}
        />
      </CellRegistryContext.Provider>
    );
    const { rerender } = render(view(rows));

    feed(snapFor(0, 1));
    feed(deltaFor(0, 2, 1, { PX_LAST: 555 }));
    flushFrames(1);
    expect(cellEl('q:0', 'PX_LAST').textContent).toBe(format('PX_LAST', 555, {}));

    // A screen repaint: `ctx.rerun`, a param change, a poll. Its payload was built before the delta.
    const repainted = makeRows(4).map((row, i) =>
      i === 0 ? { ...row, cells: { ...row.cells, PX_LAST: { v: 111, st: 'live' as const, provIdx: 1, fieldId: 'PX_LAST', fmt: 'px' as const } } } : row,
    );
    rerender(view(repainted));
    expect(cellEl('q:0', 'PX_LAST').textContent).toBe(format('PX_LAST', 555, {}));

    // And the wire re-stating the value the registry already wrote must not be skipped into a lie:
    // this is the step that used to leave 111 on screen with 555 in the cache.
    feed(deltaFor(0, 3, 2, { PX_LAST: 555 }));
    flushFrames(1);
    expect(cellEl('q:0', 'PX_LAST').textContent).toBe(format('PX_LAST', 555, {}));
    expect(cache.get('q:0')?.f.PX_LAST).toBe(555);
  });

  it('a repaint with no frame behind it adopts the new payload', () => {
    const rows = makeRows(4);
    const registry = new CellRegistry();
    const view = (r: GridRow[]): ReactElement => (
      <CellRegistryContext.Provider value={registry}>
        <LiveGrid
          id="g1"
          columns={COLUMNS}
          rows={r}
          rowHeight={ROW_HEIGHT}
          live={{ subjectOf: (row: GridRow) => row.subject ?? null }}
        />
      </CellRegistryContext.Provider>
    );
    const { rerender } = render(view(rows));
    expect(cellEl('q:0', 'PX_LAST').textContent).toBe(
      format('PX_LAST', baseValue(0, 'PX_LAST'), {}),
    );

    // No socket: the payload is the only truth there is, so a new one must reach the screen. Every
    // static screen in the application depends on this.
    const repainted = makeRows(4).map((row, i) =>
      i === 0 ? { ...row, cells: { ...row.cells, PX_LAST: { v: 777.5, st: 'live' as const, provIdx: 1, fieldId: 'PX_LAST', fmt: 'px' as const } } } : row,
    );
    rerender(view(repainted));
    expect(cellEl('q:0', 'PX_LAST').textContent).toBe(format('PX_LAST', 777.5, {}));
    expect(cellEl('q:0', 'PX_LAST').getAttribute('aria-label')).toContain(
      format('PX_LAST', 777.5, {}),
    );
  });
});

/* ------------------------------------------------------------------------------------------- */
/* The change colour, the `na` exception, and the flash guarantees                                 */
/* ------------------------------------------------------------------------------------------- */

describe('LiveGrid — a change cell is coloured by the same rule CellView is', () => {
  it('emits the .chg element `[data-dir] .chg` needs, in the grid as well as in the block', async () => {
    const { CellView } = await import('../../src/screen/widgets/CellView.js');
    const h = mountGrid(makeRows(4));
    h.feed(snapFor(0, 1));
    h.feed(snapFor(1, 1));
    // baseValue: r0's CHG_PCT_1D is -2 and r1's is -1; move one up and one down.
    h.feed(deltaFor(0, 2, 1, { CHG_PCT_1D: 2.1 }));
    h.feed(deltaFor(1, 2, 1, { CHG_PCT_1D: -2.1 }));
    flushFrames(1);

    const rising = cellEl('q:0', 'CHG_PCT_1D');
    const falling = cellEl('q:1', 'CHG_PCT_1D');
    expect(rising.getAttribute('data-dir')).toBe('up');
    expect(falling.getAttribute('data-dir')).toBe('down');

    // `tokens.css` colours the change through `[data-dir='up'] .chg`, so the rule needs an element
    // to match. Written straight onto the cell it matched nothing, and +2.1 % and −2.1 % came out
    // the same colour in the grid while being opposite colours in the `kv` block beside it.
    const up = rising.querySelector('.chg');
    const down = falling.querySelector('.chg');
    expect(up?.textContent).toBe(rising.textContent);
    expect(down?.textContent).toBe(falling.textContent);
    expect(up?.matches("[data-dir='up'] .chg")).toBe(true);
    expect(down?.matches("[data-dir='down'] .chg")).toBe(true);
    expect(up?.matches("[data-dir='down'] .chg")).toBe(false);

    // The same two selectors resolve on `CellView`'s markup, which is what "the same colour for the
    // same data, in both surfaces" means.
    const block = document.createElement('div');
    document.body.appendChild(block);
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(block);
    act(() => {
      root.render(
        <>
          <CellView cell={{ v: 2.1, st: 'live', provIdx: 1, fmt: 'pct', dir: 'up' }} label="Chg" />
          <CellView
            cell={{ v: -2.1, st: 'live', provIdx: 1, fmt: 'pct', dir: 'down' }}
            label="Chg"
          />
        </>,
      );
    });
    const spans = [...block.querySelectorAll('.chg')];
    expect(spans).toHaveLength(2);
    expect(spans[0]?.matches("[data-dir='up'] .chg")).toBe(true);
    expect(spans[1]?.matches("[data-dir='down'] .chg")).toBe(true);
    act(() => {
      root.unmount();
    });
    block.remove();
  });
});

describe('LiveGrid — the staleness sweep does not contradict `na`', () => {
  it('a payload `na` cell survives a sweep that greys the row around it', () => {
    const rows = makeRows(2).map((row, i) =>
      i === 0
        ? {
            ...row,
            cells: {
              ...row.cells,
              PX_LOW: { v: null, st: 'na' as const, provIdx: 1, fieldId: 'PX_LOW', fmt: 'px' as const },
            },
          }
        : row,
    );
    const h = mountGrid(rows);
    // A snap that says nothing about PX_LOW: the field does not apply to this instrument, and no
    // wire frame contradicts that.
    const f: Record<string, number> = {};
    for (const field of LIVE_FIELDS) if (field !== 'PX_LOW') f[field] = baseValue(0, field);
    h.feed(snapFor(0, 1, { f }));
    flushFrames(1);

    const na = cellEl('q:0', 'PX_LOW');
    const last = cellEl('q:0', 'PX_LAST');
    expect(na.getAttribute('data-st')).toBe('na');

    h.registry.restyle(['q:0'], () => 'stale');

    // The row went stale; the field that does not exist did not acquire a missing update.
    expect(last.getAttribute('data-st')).toBe('stale');
    expect(na.getAttribute('data-st')).toBe('na');
    expect(na.getAttribute('aria-label')).toContain('not applicable');
    expect(na.getAttribute('aria-label')).not.toContain('no fresh update');
  });
});

describe('LiveGrid — the flash ends, and costs nothing to end', () => {
  it('adds exactly one animationend listener per cell however many times it flashes', () => {
    const h = mountGrid(makeRows(2));
    h.feed(snapFor(0, 1));
    flushFrames(1);

    const cell = cellEl('q:0', 'PX_LAST');
    let added = 0;
    let removed = 0;
    const realAdd = cell.addEventListener.bind(cell);
    const realRemove = cell.removeEventListener.bind(cell);
    cell.addEventListener = (type: string, ...rest: unknown[]): void => {
      if (type === 'animationend') added += 1;
      (realAdd as (t: string, ...r: unknown[]) => void)(type, ...rest);
    };
    cell.removeEventListener = (type: string, ...rest: unknown[]): void => {
      if (type === 'animationend') removed += 1;
      (realRemove as (t: string, ...r: unknown[]) => void)(type, ...rest);
    };

    for (let i = 0; i < 300; i += 1) {
      h.feed(deltaFor(0, i + 2, i + 1, { PX_LAST: 100 + i }));
      flushFrames(1);
    }

    // 300 listeners with `{ once: true }` and nothing to fire them is an unbounded leak on every
    // live cell of a terminal left open all day — and because `addEventListener` scans for a
    // duplicate, it made the tick path quadratic in ticks per cell.
    expect(added).toBe(1);
    expect(removed).toBe(0);
    expect(h.registry.stats.writes).toBe(300);
  });

  it('is cleared by the 1 s ticker when the feed stops, not only by the next frame', () => {
    let now = 5_000;
    const h = mountGrid(makeRows(2), {}, { now: () => now });
    h.feed(snapFor(0, 1));
    flushFrames(1);
    h.feed(deltaFor(0, 2, 1, { PX_LAST: 999 }));
    flushFrames(1);

    const cell = cellEl('q:0', 'PX_LAST');
    expect(cell.classList.contains('flash-up')).toBe(true);
    // The last delta of the session. `animationend` never fires in jsdom — and in a browser it never
    // fires for a panel the animation never ran in — and no further frame is ever scheduled, so the
    // per-frame sweep is unreachable. A cell left lit says "this just changed" about the closing
    // print for the rest of the day.
    expect(pendingFrames()).toBe(0);

    now += 3 * 700 + 1;
    expect(h.registry.sweepFlashes(now)).toBe(1);
    expect(cell.classList.contains('flash-up')).toBe(false);
  });
});
