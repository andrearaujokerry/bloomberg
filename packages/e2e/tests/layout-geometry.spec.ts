// packages/e2e/tests/layout-geometry.spec.ts — the boxes the seeded workspace actually draws
// (TERM-04, TERM-08; CLIENT.md §10.1's "fixed row height per density … so a text change never
// triggers layout of other cells"; BUS-04 for the essential set that rides on the same measurement).
//
// ## Why this spec exists at all, and why it cannot be a vitest file
//
// Two panels of the default four-panel workspace drew ON TOP OF THEMSELVES, and 254 green vitest
// files could not see it, because jsdom does not lay anything out: every `getBoundingClientRect` it
// returns is `0 × 0 at 0,0`, so no jsdom test can tell a row that fits from a row painted across the
// two rows below it. The only instrument that can is a real browser, which is this suite. Everything
// below is read off Chrome at the viewport `playwright.config.ts` fixes, against the SEEDED
// workspace of `pm@demo.terminal` — 41,455 instruments, `WEI` with its 31 indices in three regions
// and `W · Core` with Jane Ruiz's five rows — so it is the product's own layout under measurement
// and not a fixture built to satisfy the assertion.
//
// ## What was wrong, in numbers, before `screen/widgets/widgets.css` gained its `.grid*` rules
//
//   * **`WEI`** — `grid#americas` measured 635 × 200, `grid#emea` 635 × 260 and `grid#apac`
//     635 × 220, each inside a `.split__pane` of 635 × 27. `LiveGrid` asks for `flex: 1 1 auto` on
//     `.grid__viewport`, but `.grid` had no rule anywhere in the repository and so was a block
//     container, which makes that declaration inert: the viewport took its CONTENT's height, which
//     is the height of the whole row model. Each region therefore ran 170-230 px past the box the
//     split had given it and straight over the next region's `AMERICAS`/`EMEA`/`APAC` header.
//   * **`W · Core`** — the same cause with the opposite symptom: `grid#rows` measured 635 × 120
//     inside a pane of 635 × 219 and scrolled its five rows inside a 100 px viewport while 119 px of
//     its own pane stood empty.
//   * **Both** — every row was a 20 px box holding 36 px and 54 px cells. `W`'s formula row
//     `row:0` (`RATIO(AAPL US Equity, SPX Index)`) wrapped to three lines and painted across the two
//     rows beneath it; every grid HEADER did the same, which is why `Percent change` and `1-week
//     return` appeared as a second line struck through the first row of data.
//
// ## One thing the report believed that the measurement refutes, recorded rather than quietly dropped
//
// `W · Core` looked as though its watchlist-picker pane and its grid pane were painting over each
// other — "S&P 500 Top 25 / 25 items / Jane Ruiz" appeared to run through the Security / Name / Last
// price columns. It does not, and cannot: measured, the picker pane is `642 … 781` and the grid pane
// `782 … 1277`, and they have never intersected. What made it look that way is that BOTH panes were
// mangled at once — the picker's items wrap to four lines each in a 139 px column, and the grid
// beside them was painting each row over the next — so two columns of broken text read as one. The
// third test below keeps the pane property under measurement anyway, because it is the property the
// report named and the one a future `position: absolute` in a widget would break.
//
// ## Why each assertion is a property and not a pixel
//
// A hard-coded `expect(row.height).toBe(20)` would fail on the next density or font change and would
// still not say anything about overlap. What is asserted instead is containment and disjointness —
// a cell's box lies within its row's box; a grid's box is exactly the box its pane gave it; two
// sibling panes have zero intersection — which stay true whatever the row height becomes. Each test
// also carries its own anti-vacuity instrument, named in its docstring, because a containment
// assertion over a grid that happens to fit is satisfied by a blank screen.

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { E2E_USERS } from '../fixtures/auth.js';
import { resetWorkspace } from '../fixtures/database.js';

/** Sub-pixel slack: Chrome returns fractional boxes, and a 0.5 px seam is not an overlap. */
const EPS = 0.5;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** One cell whose box escaped the row it belongs to — the shape of the defect this spec records. */
interface Spill {
  where: string;
  text: string;
  row: Box;
  cell: Box;
}

interface GridBox {
  where: string;
  /** The grid's own border box. */
  grid: Box;
  /** The box the split (or the screen body) handed it, as its content height. */
  hostClientHeight: number;
  /** Whether that host has been forced to scroll — it must not be; the grid scrolls itself. */
  hostScrollHeight: number;
  /** The grid's own scrollport: how much model there is, and how much of it is shown. */
  viewportScrollHeight: number;
  viewportClientHeight: number;
}

interface PanePair {
  where: string;
  a: Box;
  b: Box;
  intersection: number;
}

interface Measurement {
  panels: string[];
  cellsMeasured: number;
  /** Cells whose text is wider than its `ch` track — the proof that the clip is under load. */
  cellsTruncated: number;
  spills: Spill[];
  grids: GridBox[];
  panePairs: PanePair[];
}

/**
 * The seeded four-panel workspace, restored and finished running.
 *
 * Waited on by SEEDED ROWS, and that precision is the difference between this spec measuring the
 * product and measuring nothing at all. Both `WEI` and `W` render a loading `ScreenSpec` first, and
 * that skeleton is a real `LiveGrid` with real `[role="row"]` elements — `skeleton:Americas:0`,
 * `skeleton:EMEA:0` — carrying a `textCell(null)` em dash in every column. Waiting on the panel
 * title admits that skeleton: measured, `WEI`'s three grids were still six skeleton rows apiece at
 * the moment the title had painted, and every one of their cells trivially fitted its row, because a
 * `—` is one character. A geometry assertion satisfied by a placeholder is exactly the shape of test
 * this build has already shipped ten of, so the wait is on rows only the seed can produce: `wei:VIX`,
 * one of the two WEI indices carrying a recorded quote, and `row:85`, Jane Ruiz's Apple row.
 */
async function openTerminal(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-panel="p1"]'), 'p1').toContainText(
    'WEI · World Equity Indices',
    {
      timeout: 30_000,
    },
  );
  await expect(page.locator('[data-panel="p2"]'), 'p2').toContainText('TOP ·', { timeout: 30_000 });
  await expect(page.locator('[data-panel="p3"]'), 'p3').toContainText('GP · SPX Index', {
    timeout: 30_000,
  });
  await expect(page.locator('[data-panel="p4"]'), 'p4').toContainText('W · Core', {
    timeout: 30_000,
  });
  await expect(page.locator('[data-panel="p1"]'), 'p1 · the 31 seeded indices').toContainText(
    '31 rows',
    { timeout: 30_000 },
  );
  await expect(
    page.locator('[data-panel="p1"] [role="row"][data-row-id="wei:VIX"]'),
    'p1 · the VIX row of the real payload',
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-panel="p4"] [role="row"][data-row-id="row:85"]'),
    'p4 · the Apple row of the real payload',
  ).toBeVisible({ timeout: 30_000 });
  // And no skeleton row may remain anywhere. WEI's three regions are three separate grids that
  // resolve together but are three separate elements, and a wait that named only one of them could
  // still have been measuring the other two.
  await expect(page.locator('[role="row"][data-row-id^="skeleton:"]'), 'skeleton rows').toHaveCount(
    0,
    { timeout: 30_000 },
  );
}

/**
 * Read every box this spec judges, in one pass in the page.
 *
 * One `evaluate` rather than a locator per element, for a reason that is about correctness and not
 * speed: the grids carry live cells, and a measurement spread over hundreds of round trips could
 * read a row's box before a re-layout and its cell's box after one. One pass is one instant.
 */
async function measure(page: Page): Promise<Measurement> {
  return page.evaluate((eps: number): Measurement => {
    const boxOf = (el: Element): Box => {
      const b = el.getBoundingClientRect();
      return {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        top: b.top,
        right: b.right,
        bottom: b.bottom,
        left: b.left,
      };
    };

    const panels = Array.from(document.querySelectorAll<HTMLElement>('[data-panel]'));
    const out: Measurement = {
      panels: panels.map((p) => p.dataset.panel ?? '?'),
      cellsMeasured: 0,
      cellsTruncated: 0,
      spills: [],
      grids: [],
      panePairs: [],
    };

    for (const panel of panels) {
      const pid = panel.dataset.panel ?? '?';

      for (const grid of Array.from(panel.querySelectorAll<HTMLElement>('.grid'))) {
        const gid = grid.dataset.nodeId ?? '?';

        // Every rendered row — the header row included, because the header is a `.grid__row` with
        // the same fixed height and it was overflowing exactly as the data rows were.
        for (const row of Array.from(grid.querySelectorAll<HTMLElement>('[role="row"]'))) {
          const rowBox = boxOf(row);
          const rid = row.dataset.rowId ?? 'head';
          for (const cell of Array.from(row.children)) {
            if (!(cell instanceof HTMLElement)) continue;
            const cellBox = boxOf(cell);
            out.cellsMeasured += 1;
            if (cell.scrollWidth > cell.clientWidth) out.cellsTruncated += 1;
            if (cellBox.top < rowBox.top - eps || cellBox.bottom > rowBox.bottom + eps) {
              out.spills.push({
                where: `${pid} · ${gid} · row ${rid} · col ${cell.dataset.col ?? '?'}`,
                text: (cell.textContent ?? '').slice(0, 40),
                row: rowBox,
                cell: cellBox,
              });
            }
          }
        }

        // The box the grid was given. `.grid-host` is the wrapper `widgets/Grid.tsx` draws; the pane
        // — or, for a screen whose whole body is one grid, the screen body — is what sized it.
        const host = grid.closest<HTMLElement>('.split__pane, .screen__body');
        if (host === null) continue;
        const viewport = grid.querySelector<HTMLElement>('.grid__viewport');
        out.grids.push({
          where: `${pid} · ${gid}`,
          grid: boxOf(grid),
          hostClientHeight: host.clientHeight,
          hostScrollHeight: host.scrollHeight,
          viewportScrollHeight: viewport === null ? 0 : viewport.scrollHeight,
          viewportClientHeight: viewport === null ? 0 : viewport.clientHeight,
        });
      }

      // Sibling panes of one split, pairwise.
      for (const split of Array.from(panel.querySelectorAll<HTMLElement>('.split'))) {
        const panes = Array.from(split.children).filter(
          (c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('split__pane'),
        );
        for (let i = 0; i < panes.length; i += 1) {
          for (let j = i + 1; j < panes.length; j += 1) {
            const first = panes[i];
            const second = panes[j];
            if (first === undefined || second === undefined) continue;
            const a = boxOf(first);
            const b = boxOf(second);
            const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            const intersection =
              overlapX > eps && overlapY > eps ? (overlapX - eps) * (overlapY - eps) : 0;
            out.panePairs.push({
              where: `${pid} · ${split.className} · panes ${String(i)}×${String(j)}`,
              a,
              b,
              intersection,
            });
          }
        }
      }
    }

    return out;
  }, EPS);
}

/** A box, printed so a failure names the geometry rather than a boolean. */
const fmt = (b: Box): string =>
  `${b.x.toFixed(1)},${b.y.toFixed(1)} ${b.width.toFixed(1)}×${b.height.toFixed(1)}`;

test.describe('the seeded workspace draws inside its own boxes', () => {
  // Read-only as far as the product is concerned, but the shell autosaves the workspace on every
  // load and restoring one currently DEGRADES it (`resetWorkspace`'s docstring, and the two
  // `test.fail` records in `smoke.spec.ts` and `panels.spec.ts`). Without this, the four panels this
  // spec measures would be whichever four the previous spec happened to leave behind.
  test.beforeEach(async () => {
    await resetWorkspace(E2E_USERS.pm.email);
  });

  /**
   * CLIENT.md §10.1: the grid is "a CSS grid with fixed column widths (`ch` units) and a fixed row
   * height per density … so a text change never triggers layout of other cells". `LiveGrid` writes
   * that fixed height onto every row, so the property is simply that a cell stays inside it — a cell
   * taller than its row is, by construction, a cell painting over the row below.
   *
   * The anti-vacuity instrument is `cellsTruncated`. Containment holds trivially in a grid whose
   * every value is short, so the test also insists that some cell's text is genuinely wider than its
   * `ch` track and is being clipped: that is the load under which the old layout wrapped and spilled.
   * `AAPL US Equity` in a 12 ch column is one of them, and `RATIO(AAPL US Equity, SPX Index)` is the
   * row that used to be a 20 px box holding 54 px cells.
   */
  test('no grid cell paints outside the row it belongs to', async ({ page }) => {
    await openTerminal(page);
    const m = await measure(page);

    expect(m.panels, 'the four-panel workspace').toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(m.cellsMeasured, 'cells measured — a handful would prove nothing').toBeGreaterThan(100);

    const report = m.spills
      .map((s) => `${s.where} "${s.text}" — row ${fmt(s.row)}, cell ${fmt(s.cell)}`)
      .join('\n');
    expect(report, 'cells whose box escapes its row').toBe('');

    // The vacuity guard comes AFTER the claim it protects, on purpose. Both orders catch the same
    // two failures, but this one reports the more useful of them first: remove the clip and the
    // listing above names all twenty-five spilling cells with their boxes, whereas the guard would
    // only have said "nothing is being truncated". It still fires on the day the grids go empty,
    // because an empty grid spills nothing and would sail through the assertion above.
    expect(
      m.cellsTruncated,
      'cells whose text is wider than their column — without one, the containment above is vacuous',
    ).toBeGreaterThan(0);
  });

  /**
   * A grid takes exactly the box its pane gave it, and does its own scrolling.
   *
   * This is the property the WEI defect broke in both directions at once: `grid#americas` was 200 px
   * in a 27 px pane and `W`'s `grid#rows` 120 px in a 219 px one. Equality is the right statement
   * rather than "fits inside", because a grid SHORTER than its pane is the same fault — the viewport
   * sized by the model instead of by the layout — and because that is what makes the second half
   * true: `virtualiser.ts#rowWindow` is handed the viewport's `clientHeight`, so a viewport sized to
   * its own model reports that every row is visible, and the essential set BUS-04 sheds by becomes
   * the whole grid.
   *
   * Two anti-vacuity instruments. The pane must not itself be scrolling (`hostScrollHeight` equals
   * `hostClientHeight`), which is what "the pane is no longer the thing cutting the grid" means; and
   * at least one measured grid must hold more rows than fit, or every grid on screen happens to be
   * short enough that none of this is under test.
   */
  test('a grid is exactly the box its pane gave it, and scrolls its own rows', async ({ page }) => {
    await openTerminal(page);
    const m = await measure(page);

    expect(m.grids.length, 'grids measured').toBeGreaterThanOrEqual(4);

    const wrong = m.grids
      .filter(
        (g) =>
          Math.abs(g.grid.height - g.hostClientHeight) > EPS ||
          g.hostScrollHeight > g.hostClientHeight + EPS,
      )
      .map(
        (g) =>
          `${g.where} — grid ${fmt(g.grid)}, pane content height ${String(g.hostClientHeight)}` +
          `, pane scroll height ${String(g.hostScrollHeight)}`,
      )
      .join('\n');
    expect(wrong, 'grids that do not fill, or that overflow, the box their pane gave them').toBe(
      '',
    );

    // After the claim it protects, for the reason given in the test above: with the box rules gone
    // no viewport scrolls at all, so this guard would fire first and say only "nothing is under
    // test" where the listing above names each grid and the pane it did not fit.
    expect(
      m.grids.some((g) => g.viewportScrollHeight > g.viewportClientHeight),
      'at least one grid holds more rows than it can show — otherwise nothing here is under test',
    ).toBe(true);
  });

  /**
   * Two sibling panes of one `split` never intersect.
   *
   * This is the property the report named — `W · Core`'s picker drawn through its grid — and the
   * measurement says it has always held: the panes tile, `642 … 781` beside `782 … 1277`, and a flex
   * row cannot make them do otherwise. It is kept because it is cheap, because it is the assertion
   * that would catch a widget acquiring a `position: absolute` or a negative margin, and because a
   * report that was investigated and refuted is worth carrying as a measurement rather than as a
   * sentence in a commit message.
   *
   * The anti-vacuity instrument is the pair count: the seeded workspace's splits must actually have
   * siblings to compare, and `WEI`'s seven-pane column alone contributes 21 pairs.
   */
  test('sibling panes of a split tile, and never intersect', async ({ page }) => {
    await openTerminal(page);
    const m = await measure(page);

    expect(m.panePairs.length, 'sibling pane pairs compared').toBeGreaterThan(20);

    const overlapping = m.panePairs
      .filter((p) => p.intersection > 0)
      .map((p) => `${p.where} — ${fmt(p.a)} ∩ ${fmt(p.b)} = ${p.intersection.toFixed(1)} px²`)
      .join('\n');
    expect(overlapping, 'sibling panes that share pixels').toBe('');
  });
});
