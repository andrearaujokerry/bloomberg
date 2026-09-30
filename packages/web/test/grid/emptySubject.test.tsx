/**
 * `packages/web/test/grid/emptySubject.test.tsx` — a row that belongs to no security must not be
 * painted as a live one (TERM-12).
 *
 * `GridRow.subject` is a string, and a screen that has no subject for a row writes `''` rather than
 * leaving the key off: `W`'s formula rows do, and the manifest documents it
 * (`core/functions/manifests/W.ts` — "a formula row has `instrumentId: 0` and `subject: ''`").
 * `LiveGrid` resolved the subject with `?? null`, which does not treat `''` as absent, so the whole
 * live path accepted a subject that cannot exist:
 *
 *   * the cell counted as `live`, so React stopped writing its state and handed it to `cellRegistry`;
 *   * the element carried `data-subject=""`;
 *   * the 1 s staleness sweep then asked `quoteCache.get('')`, got `undefined`, and skipped it.
 *
 * A cell registered as live that nothing can update and nothing can grey. Measured on the seeded
 * desk: `RATIO(AAPL US Equity, SPX Index)` read `data-st="live"` and "Last price: 0.04, live",
 * byte-identical after 70 s, while both of its inputs read "stale, no fresh update".
 *
 * The fix is in `LiveGrid` rather than in `W`'s screen because this is the seam every grid goes
 * through, so the assertions below are about the grid: one subject-less row beside one ordinary row,
 * and the ordinary row proves the live path still works — a grid that marked nothing live would pass
 * every assertion about the formula row on its own.
 */
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { QuoteCache, Snap } from '@terminal/sdk';

import { CellRegistry, CellRegistryContext } from '../../src/grid/cellRegistry.js';
import { LiveGrid } from '../../src/grid/LiveGrid.js';
import type { Cell, GridColumn, GridRow } from '../../src/screen/types.js';
import { flushFrames } from '../setup.js';

const COLUMNS: GridColumn[] = [
  { id: 'key', label: 'Security', fmt: 'text' },
  { id: 'PX_LAST', label: 'Last', fieldId: 'PX_LAST', fmt: 'px', live: true },
];

const TS = 1_789_497_688_000;

function liveCell(v: number): Cell {
  return { v, st: 'live', provIdx: 1, fieldId: 'PX_LAST', fmt: 'px', ts: TS };
}

/** One ordinary row, and one formula row exactly as `W`'s resolver emits it. */
const ROWS: GridRow[] = [
  {
    id: 'row:85',
    subject: 'q:85',
    cells: { key: { v: 'AAPL US Equity', st: 'live', provIdx: 0, fmt: 'text' }, PX_LAST: liveCell(330.27) },
  },
  {
    id: 'row:0',
    // The formula row. `instrumentId: 0`, and the empty subject the manifest documents.
    subject: '',
    instrumentId: 0,
    cells: {
      key: { v: 'RATIO(AAPL US Equity, SPX Index)', st: 'live', provIdx: 0, fmt: 'text' },
      PX_LAST: liveCell(0.0435),
    },
  },
];

let clientHeight: PropertyDescriptor | undefined;

beforeEach(() => {
  clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains('grid__viewport') ? 400 : 0;
    },
  });
});

afterEach(() => {
  if (clientHeight === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  else Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
  clientHeight = undefined;
});

interface Harness {
  registry: CellRegistry;
  /** `"<subject>/<field>"` for every cell the registry wrote to. */
  written: string[];
  feed(frame: Snap): void;
}

function mount(): Harness {
  const written: string[] = [];
  const registry = new CellRegistry({
    onWrite: (cell) => written.push(`${cell.subject}/${cell.fieldId}`),
  });
  const cache = new QuoteCache();

  render(
    <CellRegistryContext.Provider value={registry}>
      <LiveGrid
        id="g1"
        columns={COLUMNS}
        rows={ROWS}
        rowHeight={20}
        live={{ subjectOf: (row: GridRow): string | null => row.subject ?? null }}
      />
    </CellRegistryContext.Provider>,
  );

  return {
    registry,
    written,
    feed(frame) {
      const result = cache.apply(frame);
      const state = cache.get(frame.s);
      if (state !== undefined) registry.apply({ subject: frame.s, changed: result.changed, state });
    },
  };
}

function cellOf(rowId: string, column: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-row-id="${rowId}"] [data-col="${column}"]`,
  );
  if (el === null) throw new Error(`no cell for ${rowId}/${column}`);
  return el;
}

describe('a grid row with an empty subject', () => {
  it('is not given one, and is not claimed by the live registry', () => {
    const h = mount();

    // The DOM contract first: `''` is not a subject and must never be written as one.
    expect(document.querySelectorAll('[data-subject=""]')).toHaveLength(0);
    expect(cellOf('row:0', 'PX_LAST').hasAttribute('data-subject')).toBe(false);

    // And nothing under the empty subject was registered, so nothing was painted for it: every
    // write the registry made names a real subject.
    expect(h.written.filter((w) => w.startsWith('/'))).toEqual([]);

    // The row still shows its number and its payload state — it is not blanked, it is simply not
    // live-managed. This is the assertion that keeps the fix from being "hide the row".
    expect(cellOf('row:0', 'PX_LAST').textContent).toContain('0.04');
    expect(cellOf('row:0', 'PX_LAST').getAttribute('data-st')).toBe('live');
  });

  it('leaves the ordinary row on the live path, so the grid is still a live grid', () => {
    const h = mount();

    expect(cellOf('row:85', 'PX_LAST').getAttribute('data-subject')).toBe('q:85');

    h.feed(
      // Parsed by the normative wire schema, so the frame is the one the server sends.
      Snap.parse({
        t: 'snap',
        s: 'q:85',
        seq: 2,
        tier: 'delayed',
        reason: 'SOURCE_TIER_CAP',
        f: { PX_LAST: 331.5 },
        fts: { PX_LAST: TS + 1_000 },
        ts: { src: TS + 1_000, cap: TS + 1_010, pub: TS + 1_011 },
        st: 'stale',
        session: 'open',
        prov: { p: 'cboe.quotes', id: 88_213, seq: 15_972_883_317 },
        ac: 'equity',
        id: 85,
      }),
    );
    act(() => {
      flushFrames(2);
    });

    const el = cellOf('row:85', 'PX_LAST');
    expect(el.textContent).toContain('331.5');
    expect(el.getAttribute('data-st')).toBe('stale');
    // The registry wrote to the real subject and to nothing else.
    expect(h.written).toContain('q:85/PX_LAST');
  });
});
