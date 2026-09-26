// packages/e2e/tests/export.spec.ts — PRINT on HP (FUNC-03, WORKPLAN §WP-15, ARCHITECTURE §3.5).
//
// FUNC-03 is one sentence — "PRINT on HP yields a CSV equal to the screen values" — and it has two
// halves that fail in different places. Part 1 already proved the first:
// `server/test/parity/fn-parity.test.ts` runs every manifest over the seeded securities and asserts
// JSON payload = CSV export = WS snapshot at the API. What no test in this repo has ever asserted is
// the SECOND half — that the numbers in the file are the numbers a person can read off the screen.
// That is the assertion this file exists for, and it is made the only way it can be made: against
// the rendered DOM of a real browser, cell by cell.
//
// It is worth being exact about why screen and file are not byte-identical and what "equal" must
// therefore mean. `core/functions/csv.ts#serialiseCell` writes **full stored precision** (§1.6 rule
// 2) — `330.179993`, `-0.8706599355067235` — while the screen renders through the single formatter
// (`core/fields/format.ts`) at the dictionary's decimals — `330.18`, `-0.87%`. So EQUAL means: the
// screen's text is exactly what that CSV number renders as. This file therefore re-derives the
// screen text from the CSV number and compares strings. That is deliberately a SECOND
// implementation of the rendering rule — a black-box one, in the test — because a comparison that
// called the product's own formatter would agree with the product by construction and prove
// nothing. The rule it re-derives is small and pinned below (`DECIMALS`), and the day a column's
// decimals change in the dictionary this file fails and says which column.
//
// ## The thing this spec could not do, and does not pretend to
//
// There is no way for a user to press PRINT. The composition root says so itself (`web/src/App.tsx`
// L56-69): the window-level keyboard dispatcher is not attached, so `Ctrl+P` reaches nothing, and
// `ScreenCtx.export` — which IS wired, to a working `exportResult` at `App.tsx` L891-957 — has no
// caller, because no screen renders a PRINT control and `KeyBar.tsx` was never written. Verified
// against the source: nothing in `packages/web/src` calls `ctx.export()`, and `ScreenRenderer`'s
// `onKeyDown` handles exactly one key, `provenance`.
//
// That gap is recorded as a failing test at the bottom of this file, not worked around. The test
// above it drives everything that DOES exist — the app's own HP run, its own `resultId`, the
// server's own export route, the browser's own download — and stands in for the one missing wire by
// clicking the same `<a download>` element the product clicks (`export/csv.ts#clickDownload`, and
// `App.tsx` L921-927) at the same URL the product would build (`csvUrlFor`, `Functions.Csv` with
// `{resultId}`). Everything either side of that click is the product.
//
// Nothing here imports package source (WORKPLAN §1.2); the only local imports are this package's
// own fixtures.

import type { Download, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { E2E_USERS } from '../fixtures/auth.js';
import { resetWorkspace } from '../fixtures/database.js';

/* ---------------------------------------------------------------------------------------------- */
/* The screen under test                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/** The seeded workspace every user restores into (`fixtures/seed/workspaces.json`, seed module 13). */
const SEEDED_PANELS = [
  { panel: 'p1', title: 'WEI · World Equity Indices' },
  { panel: 'p2', title: 'TOP · Top News' },
  { panel: 'p3', title: 'GP · SPX Index · S&P 500' },
  { panel: 'p4', title: 'W · Core' },
] as const;

/** What is typed into `p1`. `1M` keeps the whole table on screen — see {@link readScreenRows}. */
const HP_COMMAND = 'AAPL US Equity HP 1M';

/**
 * HP's default `fields` (`core/functions/manifests/HP.ts#HP_DEFAULT_FIELDS`) plus the two columns
 * the manifest frames every price table with: `date` in front and `adjFactor` behind
 * (`hpCsvColumns`, and `screens/HP/Screen.tsx#columnsOf` — the two lists are built from the same
 * payload, which is the identity this file checks holds all the way to the pixels).
 */
const HP_COLUMNS = [
  'date',
  'PX_LAST',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_VOLUME',
  'CHG_PCT_1D',
  'adjFactor',
] as const;

type HpColumn = (typeof HP_COLUMNS)[number];

/**
 * How each column renders on screen: decimal places, and the suffix the formatter appends.
 *
 * Transcribed from what the terminal actually draws (measured, `AAPL US Equity HP 1M`), and it is
 * the dictionary's: `px` at the instrument's `price_decimals` (2 for AAPL), `shares` at 0, `pct` at
 * 2 with a `%`, and HP's own `adjFactor` column at the 6 its screen declares. Pinned here rather
 * than read off the first row so that a column which quietly lost its decimals fails this file.
 */
const DECIMALS: Readonly<Record<Exclude<HpColumn, 'date'>, { dp: number; suffix: string }>> = {
  PX_LAST: { dp: 2, suffix: '' },
  PX_OPEN: { dp: 2, suffix: '' },
  PX_HIGH: { dp: 2, suffix: '' },
  PX_LOW: { dp: 2, suffix: '' },
  PX_VOLUME: { dp: 0, suffix: '' },
  CHG_PCT_1D: { dp: 2, suffix: '%' },
  adjFactor: { dp: 6, suffix: '' },
};

/* ---------------------------------------------------------------------------------------------- */
/* Driving the terminal                                                                             */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Load `/`, wait for all four restored panels, and let the restore finish.
 *
 * The `networkidle` wait is not padding. `App.tsx#onRestored` re-runs every restored frame, React's
 * StrictMode mounts the app twice in the dev server this suite drives, and the SECOND batch of four
 * runs is still in flight when the first batch has already drawn its titles. A command typed in that
 * window can be overwritten by a restore run that lands after it: measured on `p1`, where the panel
 * header read `HP · AAPL US Equity` while the panel BODY had gone back to WEI — see this package's
 * work-package report. Waiting for the network to go quiet closes the window before a spec types.
 */
async function openRestoredWorkspace(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
  for (const { panel, title } of SEEDED_PANELS) {
    await expect(page.locator(`[data-panel="${panel}"]`), `panel ${panel}`).toContainText(title, {
      timeout: 30_000,
    });
  }
  await page.waitForLoadState('networkidle');
}

/**
 * Run `AAPL US Equity HP 1M` in `p1` and return the `resultId` of the run THE SCREEN IS SHOWING.
 *
 * The id is read off the run's own response rather than invented, because that is the whole point:
 * the export asked for below is an export of this exact result, which is what
 * `Functions.Csv?resultId=…` means and what makes "the CSV of what is on screen" a true statement
 * rather than a second, independently resolved query that happens to look similar.
 */
async function runHpInPanel1(page: Page): Promise<{ resultId: string; traceId: string }> {
  const answered = page.waitForResponse(
    (res) => res.url().endsWith('/api/v1/functions/HP/run') && res.status() === 200,
    { timeout: 30_000 },
  );

  const commandLine = page.getByRole('combobox', { name: 'Command line p1' });
  await commandLine.focus();
  await commandLine.fill(HP_COMMAND);
  await commandLine.press('Enter');

  const body = (await (await answered).json()) as {
    meta: { resultId?: string; traceId: string; tier: string };
  };
  const panel = page.locator('[data-panel="p1"]');
  await expect(panel).toContainText('HP · AAPL US Equity · Apple Inc', { timeout: 30_000 });
  // Again after the grid has had time to virtualise and after any straggling restore run: an
  // assertion that only ever holds for 200 ms is not an assertion about what a user sees.
  await page.waitForLoadState('networkidle');
  await expect(panel).toContainText('HP · AAPL US Equity · Apple Inc');

  const resultId = body.meta.resultId ?? '';
  expect(resultId, 'the HP run returned no resultId — there is nothing to export').not.toBe('');
  return { resultId, traceId: body.meta.traceId };
}

/**
 * Every row the HP grid has drawn, as `date -> column -> text`.
 *
 * `LiveGrid` virtualises (`grid/virtualiser.ts`), so this reads what is IN THE DOM and the test
 * compares that set against the CSV rather than assuming the table is whole. `1M` over the seeded
 * bars is fifteen sessions, which fits, and the assertions below check the two sets are equal —
 * so a window that grew past the viewport would fail this file loudly instead of quietly comparing
 * a subset.
 */
async function readScreenRows(page: Page): Promise<Record<string, Record<string, string>>> {
  return page.evaluate(() => {
    const out: Record<string, Record<string, string>> = {};
    const grid = document.querySelector('[data-panel="p1"] [role="grid"]');
    for (const row of grid?.querySelectorAll('[role="row"][data-row-id]') ?? []) {
      const id = row.getAttribute('data-row-id');
      if (id === null) continue;
      const cells: Record<string, string> = {};
      for (const cell of row.querySelectorAll('[role="gridcell"]')) {
        const col = cell.getAttribute('data-col');
        if (col === null) continue;
        // A grid cell holds its text directly, EXCEPT when the value is signed: then `LiveGrid`
        // nests it in `span.cell__value.chg`, because `[data-dir] .chg` is the rule that colours a
        // change and it matches nothing on the cell itself (`LiveGrid.tsx` L248-251). So: the span
        // when there is one, the cell otherwise. Taking the span also drops the visually-hidden
        // state phrase that `CellView` appends on the other screens.
        const value = cell.querySelector('.cell__value') ?? cell;
        cells[col] = (value.textContent ?? '').trim();
      }
      out[id] = cells;
    }
    return out;
  });
}

/** The column ids the grid has drawn, in order. */
async function readScreenColumns(page: Page): Promise<string[]> {
  return page
    .locator('[data-panel="p1"] [role="grid"] [role="columnheader"]')
    .evaluateAll((heads) => heads.map((h) => h.getAttribute('data-col') ?? ''));
}

/* ---------------------------------------------------------------------------------------------- */
/* PRINT                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Take the panel's result as a file, the way the product takes it.
 *
 * This is the one place the spec stands in for the application, and it stands in for exactly one
 * missing thing: the gesture. `App.tsx#exportResult` fetches `Functions.Csv` with the frame's
 * `resultId` and hands the bytes to an `<a download>` click (L921-927); `export/csv.ts` exports
 * `csvUrlFor` + `navigateToDownload` for the same job without the fetch. Neither has a caller,
 * because nothing in the UI invokes `ctx.export()` — the failing test at the end of this file is
 * that gap, reported rather than patched over.
 *
 * So the click below is the product's own final step at the product's own URL, issued from the
 * page's own origin with the session's own cookie, and Chrome downloads it because the SERVER said
 * `content-disposition: attachment` (API.md §9). Nothing about the file is decided here.
 */
async function printPanelResult(page: Page, resultId: string): Promise<Download> {
  const started = page.waitForEvent('download', { timeout: 20_000 });
  await page.evaluate((id: string) => {
    const a = document.createElement('a');
    a.href = `/api/v1/functions/HP/csv?resultId=${encodeURIComponent(id)}`;
    // Empty on purpose: the server names the file, and `download=""` asks the browser to honour
    // `content-disposition` rather than substituting a name of the spec's choosing.
    a.download = '';
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, resultId);
  return started;
}

/* ---------------------------------------------------------------------------------------------- */
/* Reading the file back                                                                            */
/* ---------------------------------------------------------------------------------------------- */

interface ParsedCsv {
  /** The `#` block of FUNCTIONS §1.6 rule 5, `#` and leading space stripped. */
  comments: string[];
  columns: string[];
  rows: string[][];
}

/**
 * RFC 4180 enough for this file: `writeCsv` quotes on `,`, `"`, CR, LF and edge whitespace, doubles
 * `"` inside a quoted field and ends every record with CRLF. HP's own cells are dates and numbers
 * and are never quoted, but parsing properly is what lets the failure message be about the DATA
 * when a column label one day contains a comma.
 */
function parseCsv(text: string): ParsedCsv {
  const comments: string[] = [];
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  let atRecordStart = true;
  let commentLine: string | null = null;

  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    if (record.length > 1 || record[0] !== '') records.push(record);
    record = [];
    atRecordStart = true;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (commentLine !== null) {
      if (ch === '\n') {
        comments.push(commentLine.replace(/^#\s?/, '').trimEnd());
        commentLine = null;
        atRecordStart = true;
      } else if (ch !== '\r') {
        commentLine += ch;
      }
      continue;
    }
    if (atRecordStart && !quoted && ch === '#') {
      commentLine = ch;
      atRecordStart = false;
      continue;
    }
    atRecordStart = false;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') endField();
    else if (ch === '\n') endRecord();
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || record.length > 0) endRecord();

  const [header, ...rest] = records;
  return { comments, columns: header ?? [], rows: rest };
}

/**
 * What the terminal draws for a CSV number in a column with `dp` decimals.
 *
 * The rendering rule, re-derived rather than imported (see the file header): fixed decimals,
 * thousands separators every three digits, no locale — `core/fields/format.ts#group` takes the
 * no-locale branch, which is exactly why a number reads the same on every desk in the building.
 */
function asScreenText(value: number, dp: number, suffix: string): string {
  const text = value.toFixed(dp);
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf('.');
  const whole = dot === -1 ? body : body.slice(0, dot);
  const fraction = dot === -1 ? '' : body.slice(dot);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction}${suffix}`;
}

/* ---------------------------------------------------------------------------------------------- */
/* The specs                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

test.describe('WP-15 export — PRINT on HP (FUNC-03)', () => {
  // `pm@demo.terminal` is this spec's person (`fixtures/auth.ts#E2E_USERS`), and loading the
  // terminal rewrites their workspace, so the layout goes back to the seeded one first. Without it
  // this file would be asserting against whatever the previous spec left behind, and the restore
  // defect `resetWorkspace` documents would decide the result.
  test.beforeEach(async () => {
    await resetWorkspace(E2E_USERS.pm.email);
  });

  test('the CSV is the screen, cell for cell', async ({ page }) => {
    await openRestoredWorkspace(page);
    const { resultId, traceId } = await runHpInPanel1(page);

    // ── the screen ────────────────────────────────────────────────────────────────────────────
    const screenColumns = await readScreenColumns(page);
    expect(screenColumns, 'the HP grid drew columns this spec does not know about').toEqual([
      ...HP_COLUMNS,
    ]);
    const screen = await readScreenRows(page);
    const screenDates = Object.keys(screen);
    // A seeded floor, not an exact count: `1M` is a window ending NOW, so the number of sessions in
    // it moves with the calendar. Ten is far more than a virtualised viewport would hold back and
    // far more than an empty database would produce.
    expect(
      screenDates.length,
      'HP drew fewer than ten sessions — is the e2e database seeded?',
    ).toBeGreaterThanOrEqual(10);

    // ── the file ──────────────────────────────────────────────────────────────────────────────
    const download = await printPanelResult(page, resultId);
    // API.md §9: the server names the file `<CODE>_<security>_<asOf>.csv`. The browser took the
    // name from `content-disposition`, so asserting it here is asserting the header was sent.
    expect(download.suggestedFilename()).toMatch(/^HP_AAPL_US_Equity_\d{8}T\d{6}Z\.csv$/);

    const path = await download.path();
    expect(path, 'the download produced no file on disk').not.toBeNull();
    const text = await download.createReadStream().then(
      async (stream) =>
        new Promise<string>((resolve, reject) => {
          let acc = '';
          stream.setEncoding('utf8');
          stream.on('data', (chunk: string) => (acc += chunk));
          stream.on('end', () => {
            resolve(acc);
          });
          stream.on('error', reject);
        }),
    );

    // No byte-order mark: `writeCsv` never emits one and Excel is not a reason to start.
    expect(text.startsWith('\uFEFF'), 'the export begins with a BOM').toBe(false);
    expect(text.endsWith('\r\n'), 'records must end CRLF (API.md §9)').toBe(true);

    const csv = parseCsv(text);

    // ── the header block says which run this is (FUNCTIONS §1.6 rule 5) ───────────────────────
    // This is what makes the file a citation rather than a spreadsheet: the function, the security
    // and the params the panel is actually showing, plus the as-of the numbers were resolved at.
    expect(csv.comments[0]).toBe('terminal-export v1');
    expect(csv.comments.join('\n')).toContain('function: HP  security: AAPL US Equity');
    expect(csv.comments.join('\n')).toContain('"range":"1M"');
    // A trace the file can be audited by. NOT the run's own id, and the difference is the missing
    // gesture again: OPS-07's "the export shares the run's id" is `App.tsx#exportResult` passing
    // `traceId: frame.traceId` to the SDK, which sends it as `x-trace-id` — a header an `<a
    // download>` cannot set, so the server minted a fresh one here. Asserted as a shape, with the
    // equality left to the day PRINT has a caller.
    expect(csv.comments.join('\n')).toMatch(
      /trace: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
    expect(traceId, 'the run reported no trace id').not.toBe('');
    // DATA-01: the licence footer is not optional, and the seeded provenance names its source.
    expect(csv.comments.some((line) => line.startsWith('source:'))).toBe(true);

    // ── columns ───────────────────────────────────────────────────────────────────────────────
    // The identity FUNC-03 is really about: the grid and the exporter are two readings of ONE
    // payload (`hpCsvColumns` and `columnsOf` both walk `payload.columns`), so the column lists
    // must be the same list in the same order.
    expect(csv.columns, 'the CSV columns are not the screen columns').toEqual(screenColumns);

    // ── rows ──────────────────────────────────────────────────────────────────────────────────
    const csvByDate = new Map<string, string[]>();
    for (const row of csv.rows) csvByDate.set(row[0] ?? '', row);
    expect(
      [...csvByDate.keys()],
      'the file and the screen list different sessions, or list them in a different order',
    ).toEqual(screenDates);

    // ── every cell ────────────────────────────────────────────────────────────────────────────
    // The screen's text, and the same number out of the file put through the rendering rule. A
    // mismatch is reported with the date and the column so the failure names the cell.
    const mismatches: string[] = [];
    let compared = 0;
    for (const [date, cells] of Object.entries(screen)) {
      const row = csvByDate.get(date) ?? [];
      for (const [index, column] of screenColumns.entries()) {
        const raw = row[index] ?? '';
        const shown = cells[column] ?? '';
        if (column === 'date') {
          if (raw !== shown) mismatches.push(`${date} ${column}: screen "${shown}" file "${raw}"`);
          compared++;
          continue;
        }
        const rule = DECIMALS[column as Exclude<HpColumn, 'date'>];
        if (raw === '') {
          // `null` in the payload is an empty CSV field and the blank glyph on screen. Both are
          // "no value for this session"; neither is a zero.
          if (shown !== '—') mismatches.push(`${date} ${column}: file empty, screen "${shown}"`);
          compared++;
          continue;
        }
        const expected = asScreenText(Number(raw), rule.dp, rule.suffix);
        if (expected !== shown) {
          mismatches.push(`${date} ${column}: screen "${shown}" file "${raw}" → "${expected}"`);
        }
        compared++;
      }
    }
    expect(mismatches, 'the file and the screen disagree').toEqual([]);
    // The count is the guard against a green run over an empty comparison: eight columns over at
    // least ten sessions is eighty cells, and every one of them was checked against the file.
    expect(compared, 'no cells were compared').toBeGreaterThanOrEqual(10 * HP_COLUMNS.length);
    expect(compared).toBe(screenDates.length * screenColumns.length);
  });

  // ── A GAP, recorded rather than hidden ──────────────────────────────────────────────────────
  //
  // `test.fail()` and not `test.skip()`: this runs on every suite, it MUST fail, and the day
  // somebody publishes the panel's focus and attaches `keyboard/dispatcher.ts` at the window,
  // Playwright reports "expected to fail but passed" and the record cannot rot.
  //
  // What is missing. `App.tsx` L56-69 states it: the window-level keyboard dispatcher is not
  // attached, because four members of its `KeyboardHost` need the focus model that `Panel.tsx`
  // holds in local state and does not expose. `Ctrl+P` is therefore bound to nothing. The other
  // route, `ScreenCtx.export()`, is wired all the way to a working `exportResult` (`App.tsx` L891)
  // — and has no caller: no screen in `packages/web/src/screens/**` invokes it, `KeyBar.tsx` was
  // never written, and `ScreenRenderer`'s `onKeyDown` handles exactly one action, `provenance`.
  //
  // So a user looking at the table the test above exported has no way to ask for it. The export
  // path is proven; the gesture is missing. FUNC-03.
  test('PRINT is reachable from the terminal (FUNC-03)', async ({ page }) => {
    test.fail(
      true,
      'GAP: nothing in the UI invokes ScreenCtx.export(), and the window keyboard dispatcher that ' +
        'would bind Ctrl+P is not attached (App.tsx L56-69). PRINT has no gesture.',
    );

    await openRestoredWorkspace(page);
    await runHpInPanel1(page);

    // Focus inside the screen, which is where a user pressing PRINT would be standing, then press
    // the reserved combo `keymap.ts` L285 declares: `Ctrl+P`, "Export the panel result as CSV".
    await page.locator('[data-panel="p1"] [role="grid"]').first().focus();
    const started = page.waitForEvent('download', { timeout: 8_000 });
    await page.keyboard.press('Control+p');
    await started;
  });
});
