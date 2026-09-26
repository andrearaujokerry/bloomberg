// packages/e2e/tests/smoke.spec.ts — the harness's own acceptance test (WORKPLAN §1.11, WP-15).
//
// WP-01's version of this file was written against the scaffold `App.tsx`: one command line with
// `aria-label="Command line"`, a `getByTestId("panel-frame")`, and an uppercase echo of whatever was
// typed. The composition root replaced all three — the command line is now per panel
// (`Command line p1`), `panel-frame` does not exist, and a command runs a function instead of being
// echoed — so the one committed Playwright spec in this repo had stopped describing the product. It
// is rewritten here against the real terminal, and against SEEDED data.
//
// ## What this spec is for
//
// Three siblings write specs against `fixtures/{auth,database,serverProcess}.ts` immediately after
// this one, so this file is where the harness itself is proved:
//
//   * the plant boots against a database that HAS a universe in it (`fixtures/database.ts`);
//   * the `storageState` minted by `globalSetup` gets a real browser past the gate
//     (`fixtures/auth.ts`) — and the last test in this file shows what the same page looks like
//     WITHOUT it, which is what makes every session assertion above it mean something;
//   * the vite dev server proxies `/api` and `/ws` to THIS run's plant and not to some other one
//     (`webEnv()`), which is why the API assertions name status codes.
//
// ## Every assertion here is about data
//
// Nine tests in this build have shipped that could not fail, and "four panels are visible" would
// have been the tenth: an empty database renders four panels perfectly well. So the values asserted
// below are the SEEDED ones, and each names where it comes from:
//
//   * `pm@demo.terminal`'s active workspace — mode `4`, `p1=WEI p2=TOP p3=GP(SPX Index) p4=W(Core)`,
//     `conflationMs: 250` (`fixtures/seed/workspaces.json`, seed module 13);
//   * `AAPL US Equity` / `Apple Inc` / `330.27` and `SPX Index` / `S&P 500` / `7,585.75` — the
//     recorded Cboe poll and the seeded daily bars (`fixtures/providers/raw/`, modules 2-7);
//   * grid cells that all carry `data-prov-idx` — the DOM half of DATA-10, which is what `Ctrl+I`
//     reads (`screen/widgets/registry.ts` L64, `screen/ScreenRenderer.tsx` L151).
//
// Drop the seed and this file fails on its first universe assertion rather than passing green.
//
// Everything is driven over the wire; the only local imports are this package's own fixtures
// (WORKPLAN §1.2).

import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { E2E_USERS } from '../fixtures/auth.js';
import { forgetInstrumentSeen, resetWorkspace } from '../fixtures/database.js';
import { HEALTH_URL, SERVER_URL, WEB_URL } from '../fixtures/serverProcess.js';

/** `data-testid="command-line"` on the `<input>` of `shell/CommandLine.tsx` — one PER PANEL. */
const COMMAND_LINE = '[data-testid="command-line"]';

/** The four panels of the seeded workspace, and the function each one restores into. */
const SEEDED_PANELS = [
  { panel: 'p1', code: 'WEI', title: 'WEI · World Equity Indices' },
  { panel: 'p2', code: 'TOP', title: 'TOP · Top News' },
  { panel: 'p3', code: 'GP', title: 'GP · SPX Index · S&P 500' },
  { panel: 'p4', code: 'W', title: 'W · Core' },
] as const;

/**
 * Loads `/` and waits until all four panels have finished their function run.
 *
 * The wait is on CONTENT, not on a timer: each panel's own title line only appears once
 * `POST /api/v1/functions/<code>/run` has answered and `ScreenRenderer` has drawn the spec. A fixed
 * sleep here would be the thing that makes the rest of the file flaky on a slow machine and
 * vacuous on a fast one.
 */
async function openRestoredWorkspace(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
  for (const { panel, title } of SEEDED_PANELS) {
    await expect(page.locator(`[data-panel="${panel}"]`), `panel ${panel}`).toContainText(title, {
      timeout: 30_000,
    });
  }
}

/**
 * One grid cell, addressed the way `LiveGrid` publishes it: `data-row-id` × `data-col`.
 *
 * Row counts are not values. Every assertion in this file that used to read "31 rows" or "5 rows"
 * passes against a grid that resolved its row set and then drew nothing into it, and the seeded
 * universe is mostly that grid: 28 of WEI's 31 index rows are em dashes and two of W · Core's five
 * instruments have no recorded quote. So the assertions that matter address a NAMED cell and check
 * the NUMBER in it, which no empty grid can satisfy however many rows it has.
 */
function gridCell(page: Page, panel: string, row: string, col: string): Locator {
  return page.locator(
    `[data-panel="${panel}"] [role="row"][data-row-id="${row}"] [role="gridcell"][data-col="${col}"]`,
  );
}

/** What the status bar's quota strip is showing, read off the `<meter>`s rather than its text. */
async function quotaStrip(page: Page): Promise<Record<string, { used: number; limit: number }>> {
  return page.getByTestId('quotas').evaluate((strip) => {
    const out: Record<string, { used: number; limit: number }> = {};
    for (const row of strip.querySelectorAll<HTMLElement>('[data-quota]')) {
      const key = row.dataset.quota;
      const meter = row.querySelector('meter');
      if (key === undefined || meter === null) continue;
      out[key] = { used: Number(meter.getAttribute('value')), limit: Number(meter.getAttribute('max')) };
    }
    return out;
  });
}

test.describe('WP-15 smoke — the terminal, against the seeded universe', () => {
  // Every test here loads the terminal as `pm@demo.terminal`, and loading the terminal REWRITES that
  // person's workspace (the shell autosaves; `Shell.tsx` also flushes one on `pagehide`). Two
  // consequences, and the second is a live defect:
  //
  //   * without a reset, the second test in this file would be asserting against the first test's
  //     layout, and spec order would be part of the result;
  //   * restoring a workspace currently DEGRADES it — see `resetWorkspace`'s docstring and the
  //     `test.fail` near the end of this file. The reset is what stops that defect from deciding
  //     whether the assertions above it pass.
  //
  // `resetWorkspace` goes to postgres directly, which is a harness affordance rather than a breach of
  // WORKPLAN §1.2: no package source is imported, and there is no API for "put this workspace back".
  test.beforeEach(async () => {
    await resetWorkspace(E2E_USERS.pm.email);
  });

  test('the replay-mode plant is up, and its database is the seeded one', async ({ request }) => {
    // API.md §5.15: `503 STARTING` until startup completes, `200` afterwards. `playwright.config.ts`
    // already waited on this URL, so by now it must be the `200`.
    const res = await request.get(HEALTH_URL);
    expect(res.status(), `GET ${HEALTH_URL}`).toBe(200);

    const body = (await res.json()) as {
      status: string;
      db: boolean;
      plant: boolean;
      migrationsPending: number;
    };
    // `degraded` is accepted and is CURRENTLY the honest answer: five startup steps in
    // `server/src/index.ts` still defer to work packages that have since been merged (the field
    // dictionary, the function-registry check, the universe search snapshot, the ingest scheduler,
    // and the usage/DQ writers with their 1 s staleness sweep). That is recorded in BUILD_STATUS.md
    // and it is not this suite's to fix — but `db` and `migrationsPending` are not negotiable,
    // because a plant that cannot read its schema cannot render a screen.
    expect(['ok', 'degraded']).toContain(body.status);
    expect(body.db, 'the plant has no database connection').toBe(true);
    expect(body.migrationsPending, 'the e2e database is behind the migrations').toBe(0);

    // And the database is SEEDED, over the wire rather than by counting rows in psql: the universe
    // snapshot is what autocomplete ranks against, and an empty one is the failure that would make
    // every other spec in this suite pass without meaning anything.
    //
    // Worth knowing: startup step 5, which was to BUILD this snapshot, is one of the five skipped
    // ones. The route builds it lazily instead (`routes/universe.ts` → `universeCacheFor(app).get()`),
    // so it answers correctly on a degraded plant — which is why this is an assertion rather than a
    // finding.
    const snapshot = await request.get(`${SERVER_URL}/api/v1/universe/snapshot`);
    expect(snapshot.status(), 'GET /api/v1/universe/snapshot').toBe(200);
    // API.md §5.2: `{ version, generatedAt, instruments, functions, people, topics }`, the
    // instruments as tuples. 41,455 of them in the seeded universe, so the floor is generous and
    // still nowhere near what a migrations-only database would report.
    const universe = (await snapshot.json()) as { instruments: unknown[]; functions: unknown[] };
    expect(
      universe.instruments.length,
      'the universe snapshot is empty — is the e2e database seeded?',
    ).toBeGreaterThan(10_000);
    expect(universe.functions.length, 'no functions in the snapshot').toBeGreaterThan(30);
  });

  test('the app loads and the harness’s storageState is past the gate', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status(), `GET ${WEB_URL}/`).toBeLessThan(400);

    // index.html: <title>TERMINAL</title>, and <html data-theme="dark" data-density="normal">.
    await expect(page).toHaveTitle('TERMINAL');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-density', 'normal');

    // `App.tsx` renders EITHER the gate or the shell. Asserting the shell is present is not the same
    // as asserting the gate is absent — a gate still on the page would mean the session resolved and
    // then something put it back — so both are checked.
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('session-gate')).toHaveCount(0);

    // The socket. `StatusBar.tsx` writes the connection state onto `data-connection`, and `LIVE`
    // means `/ws/v1` completed its handshake through the vite proxy — i.e. `webEnv()`'s
    // `TERMINAL_WS_TARGET` is pointing at this run's plant and not at a default port.
    await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'LIVE', {
      timeout: 20_000,
    });
  });

  test('the seeded workspace restores into four panels, each running its function', async ({
    page,
  }) => {
    await openRestoredWorkspace(page);

    // `workspaces.layout.mode` is "4" for every seeded user, and `PanelGrid` publishes it.
    await expect(page.getByTestId('panel-grid')).toHaveAttribute('data-layout', '4');
    await expect(page.locator('[data-panel]')).toHaveCount(4);

    // The function code in each panel header, and the panel's accessible name. `p3` also carries
    // its security, which is what makes it the GP of SPX Index rather than of nothing.
    for (const [index, { panel, code }] of SEEDED_PANELS.entries()) {
      const frame = page.locator(`[data-panel="${panel}"]`);
      await expect(frame).toHaveAttribute('aria-label', `Panel ${String(index + 1)}`);
      await expect(frame.getByText(code, { exact: true }).first()).toBeVisible();
    }
    await expect(page.locator('[data-panel="p3"]')).toContainText('SPX Index');

    // Four command lines, one per panel, keyboard-first and named per panel. The scaffold had ONE
    // with `aria-label="Command line"`; that is the assertion this rewrite exists for.
    await expect(page.locator(COMMAND_LINE)).toHaveCount(4);
    for (const { panel } of SEEDED_PANELS) {
      await expect(
        page.getByRole('combobox', { name: `Command line ${panel}` }),
        `the command line of ${panel}`,
      ).toBeVisible();
    }

    // Not one widget is a placeholder. `data-pending` is written by `screen/widgets/{Grid,Chart,
    // Custom}.tsx` when a widget the spec asked for has no implementation, so zero of them is the
    // statement that the composition root wired the real `LiveGrid` and the real `ChartCanvas`
    // rather than their stand-ins.
    await expect(page.locator('[data-pending]')).toHaveCount(0);
  });

  test('the panels show values that only a seeded database can produce', async ({ page }) => {
    await openRestoredWorkspace(page);

    // W · Core — the watchlist's own rows, from `fixtures/seed/workspaces.json` plus the recorded
    // Cboe poll for the quotes. Addressed cell by cell (`data-row-id` is the instrument id) rather
    // than by substring, so this states what is IN the grid and not merely that the grid exists:
    //
    //   85    AAPL US Equity  330.27      ▼ -0.84%   the recorded Cboe poll
    //   37367 SPX Index       7,585.75    ▼ -0.45%   the same poll's index line
    //   0     RATIO(…)        0.04        ▲ +1.88%   COMPUTED by the screen from the two above
    //
    // The RATIO row is the one that makes this more than a data dump: 330.27 / 7585.75 = 0.0435, so
    // a grid drawing the right numbers in the wrong rows fails here.
    const watchlist = page.locator('[data-panel="p4"]');
    await expect(watchlist).toContainText('5 rows');
    await expect(gridCell(page, 'p4', 'row:85', 'key')).toHaveText('AAPL US Equity');
    await expect(gridCell(page, 'p4', 'row:85', 'name')).toHaveText('Apple Inc');
    await expect(gridCell(page, 'p4', 'row:85', 'PX_LAST')).toContainText('330.27');
    await expect(gridCell(page, 'p4', 'row:85', 'CHG_PCT_1D')).toContainText('-0.84%');
    await expect(gridCell(page, 'p4', 'row:37367', 'PX_LAST')).toContainText('7,585.75');
    await expect(gridCell(page, 'p4', 'row:0', 'PX_LAST')).toContainText('0.04');
    await expect(gridCell(page, 'p4', 'row:0', 'CHG_PCT_1D')).toContainText('+1.88%');
    // Each of those numbers is cited, and the two instruments with NO recorded quote say so instead
    // of borrowing a neighbour's: MSFT renders the blank mark at `data-st="blank"`, not a price.
    // (§0.4 rule 1 — a value that was never observed is pending, never invented.)
    for (const col of ['PX_LAST', 'CHG_PCT_1D']) {
      await expect(gridCell(page, 'p4', 'row:85', col)).not.toHaveAttribute('data-prov-idx', '-1');
      await expect(gridCell(page, 'p4', 'row:21133', col)).toHaveAttribute('data-st', 'blank');
      await expect(gridCell(page, 'p4', 'row:21133', col)).toHaveText('—');
    }

    // GP · SPX Index — the index's seeded level, formatted by the client's own `px` formatter
    // (thousands separator, 2 dp), which is why the assertion carries the comma.
    await expect(page.locator('[data-panel="p3"]')).toContainText('7,585.75');

    // WEI — the row count AND the two index levels the seed actually recorded. Twenty-eight of the
    // thirty-one rows are pending (the screen says so itself: "28 indices pending — no recorded
    // quote"), so a count alone is satisfied by a grid of em dashes; VIX and the Cboe UK 100 are
    // the two that carry numbers, and they carry them from two different recorded polls.
    await expect(page.locator('[data-panel="p1"]')).toContainText('31 rows');
    await expect(gridCell(page, 'p1', 'wei:VIX', 'PX_LAST')).toContainText('17.50');
    await expect(gridCell(page, 'p1', 'wei:VIX', 'CHG_NET_1D')).toContainText('+0.40');
    await expect(gridCell(page, 'p1', 'wei:VIX', 'CHG_PCT_1D')).toContainText('+2.34%');
    await expect(gridCell(page, 'p1', 'wei:BUK100P', 'PX_LAST')).toContainText('1,059.46');
    await expect(gridCell(page, 'p1', 'wei:VIX', 'PX_LAST')).not.toHaveAttribute(
      'data-prov-idx',
      '-1',
    );

    // TOP — the count, and a headline out of the seeded news fixture. `160 news items` are seeded
    // and TOP pages thirty of them; the text below is one of them, so a news table that resolved
    // thirty empty rows cannot satisfy this.
    await expect(page.locator('[data-panel="p2"]')).toContainText('30 headlines');
    await expect(page.locator('[data-panel="p2"]')).toContainText(
      'Trump’s Kennedy Center Board Votes to Close Facility for Repairs',
    );

    // The status bar's conflation interval is the workspace's own `conflationMs: 250` — the seeded
    // value having survived the whole path: postgres → GET /api/v1/workspace → the workspace store
    // → the realtime bridge → the bar.
    await expect(page.getByTestId('status-bar')).toContainText('conf 250ms');
  });

  test('the shell fills the window, and every panel is big enough to draw in', async ({ page }) => {
    await openRestoredWorkspace(page);

    // A DEFECT this suite shipped past, and the reason it is a test rather than a note.
    //
    // `Shell.tsx`'s root is `height: 100%`, and until `theme/tokens.css` gave `html`, `body` and
    // `#root` a height, that percentage resolved against `auto`. Measured in Chrome at 1280 × 720
    // on this very workspace: shell 337 px, panel grid 318 px, `grid-template-rows: 156px 156px`,
    // `.screen__body` inside `p3` 42 px, and the chart host 635 × 0 with a canvas sized 635 × 1.
    // The terminal was a band across the top third of a black window.
    //
    // Nothing in the DOM was wrong, so every content assertion in this file stayed green through
    // it — which is exactly why the assertion here is about BOXES. `getBoundingClientRect` is the
    // only thing that can see this class of defect, and one number (the shell's height against the
    // viewport's) is what the whole chain reduces to.
    const shell = await page.getByTestId('shell').boundingBox();
    const viewport = page.viewportSize();
    expect(shell, 'no shell box').not.toBeNull();
    expect(viewport, 'no viewport').not.toBeNull();
    expect(
      shell?.height ?? 0,
      `the shell is ${String(shell?.height)} px in a ${String(viewport?.height)} px window`,
    ).toBeGreaterThanOrEqual((viewport?.height ?? 0) - 2);

    // And the space reaches the panels rather than stopping at the grid: four panels over two rows
    // of a 720 px window is ~350 px each, and a panel under 200 px cannot show a screen.
    for (const { panel } of SEEDED_PANELS) {
      const box = await page.locator(`[data-panel="${panel}"]`).boundingBox();
      expect(box?.height ?? 0, `panel ${panel} is ${String(box?.height)} px tall`).toBeGreaterThan(
        200,
      );
    }
  });

  test('the quota strip reports the plant’s own counters, not a constant', async ({ page }) => {
    await openRestoredWorkspace(page);

    // `toContainText('0/500')` was the assertion here, and it failed on EVERY full-suite run —
    // `1 failed / 30 passed`, twice from a cold database, with 11.1 s of expect-timeout each time.
    // The numerator is a live counter: this file runs alphabetically last of eight, and by the time
    // it loads, `export.spec.ts` has exported an AAPL screen and `quota_instruments_seen` holds a
    // row. Measured: `inst/d 1/500`, `pts/mo 240/2,000,000`.
    //
    // The cause is narrower than "any function run bumps it". A WEB function run charges nothing —
    // `entitlements/evaluator.ts` rule 8 charges only `usage === 'api'`. Measured: running
    // `XOM US Equity DES` in a panel left both counters exactly where they were; fetching that same
    // result's CSV moved them 1 → 2 and 240 → 708, because `functions/export.ts` L342 charges for
    // any client kind. So the counter is real, it is charged on the export and data paths, and it
    // is not a number a spec may hard-code.
    //
    // What IS assertable is that the screen and the plant agree, which is what API.md §5.13's
    // reconciliation clause is for. Both counters are quiet for the length of this test (nothing
    // here exports), so the comparison is exact rather than a tolerance.
    const strip = await quotaStrip(page);
    const live = (await (await page.request.get('/api/v1/usage/quota')).json()) as Record<
      string,
      { used: number; limit: number }
    >;

    expect(Object.keys(strip).sort(), 'the strip drew no quota meters').toEqual([
      'concurrentSubscriptions',
      'dailyUniqueInstruments',
      'monthlyDataPoints',
    ]);
    for (const key of ['dailyUniqueInstruments', 'monthlyDataPoints'] as const) {
      expect(strip[key]?.used, `${key}: the strip and GET /usage/quota disagree`).toBe(
        live[key]?.used,
      );
      expect(strip[key]?.limit, `${key}: limit`).toBe(live[key]?.limit);
    }
    // The subscription counter is the one that can move under the test (the socket is live), so it
    // is the ceiling that is compared and the numerator that is merely bounded.
    expect(strip.concurrentSubscriptions?.limit).toBe(live.concurrentSubscriptions?.limit);
    expect(strip.concurrentSubscriptions?.used ?? -1).toBeGreaterThanOrEqual(0);

    // The ceilings are `quota_limits`' two seeded rows (`fixtures/seed/entitlements.json`, module
    // 12): firm 1 at 500 / 2,000,000 / 2,000 and user 1 at 500 / 2,000,000 / **10,000**. The
    // subscription ceiling is the one that proves a row was read rather than a column default
    // applied — the table's own default is 2,000, and the strip shows the user row's 10,000.
    expect(strip.dailyUniqueInstruments?.limit).toBe(500);
    expect(strip.monthlyDataPoints?.limit).toBe(2_000_000);
    expect(strip.concurrentSubscriptions?.limit).toBe(10_000);
  });

  test('an export moves the daily instrument counter (API-06)', async ({ page }) => {
    // The counter is per `(user, day, instrument)` and the database outlives a single run, so this
    // test forgets its own instrument first. Without that it would be right once and wrong on the
    // second run against the same database — which is the exact shape of the defect it replaced.
    await forgetInstrumentSeen(E2E_USERS.pm.email, 'XOM');
    await openRestoredWorkspace(page);
    const before = (await (await page.request.get('/api/v1/usage/quota')).json()) as {
      dailyUniqueInstruments: { used: number };
      monthlyDataPoints: { used: number };
    };

    // The drive the assertion above cannot do by looking. `XOM US Equity` is deliberately an
    // instrument no other spec in this suite touches (grep: the others use AAPL, MSFT and NVDA), so
    // the +1 below is this test's own and not somebody else's leftover.
    const answered = page.waitForResponse(
      (res) => res.url().endsWith('/api/v1/functions/DES/run') && res.status() === 200,
      { timeout: 30_000 },
    );
    const line = page.locator(`[data-panel="p2"] ${COMMAND_LINE}`);
    await line.click();
    await line.pressSequentially('XOM US Equity DES', { delay: 10 });
    await line.press('Enter');
    const run = (await (await answered).json()) as { meta: { resultId?: string } };
    await expect(page.locator('[data-panel="p2"]')).toContainText('DES · XOM US Equity', {
      timeout: 30_000,
    });

    const resultId = run.meta.resultId ?? '';
    expect(resultId, 'the DES run returned no resultId — there is nothing to export').not.toBe('');
    // The product's own export URL, with the session's own cookie — `App.tsx#exportResult`'s.
    const csv = await page.request.get(
      `/api/v1/functions/DES/csv?resultId=${encodeURIComponent(resultId)}`,
    );
    expect(csv.status(), 'GET /functions/DES/csv').toBe(200);
    expect((await csv.text()).length, 'an empty CSV charges nothing').toBeGreaterThan(0);

    const after = (await (await page.request.get('/api/v1/usage/quota')).json()) as typeof before;
    // Exactly one: `quota_instruments_seen` is insert-if-absent per `(user, day, instrument)`, so a
    // second export of the same name would add nothing — which is the property that makes a daily
    // unique-instrument quota mean what it says.
    expect(
      after.dailyUniqueInstruments.used - before.dailyUniqueInstruments.used,
      'exporting a screen for an instrument seen for the first time today',
    ).toBe(1);
    expect(after.monthlyDataPoints.used, 'the cells served were not charged').toBeGreaterThan(
      before.monthlyDataPoints.used,
    );
  });

  test('a chart of a security with history actually draws it (TERM-10, DATA-10)', async ({
    page,
  }) => {
    await openRestoredWorkspace(page);

    // The seeded workspace's own chart panel is GP of `SPX Index`, and SPX has no daily bars — see
    // the `test.fail` below. So the chart is proved on the one security in the universe that DOES
    // have history: `select instrument_id, count(*) from bars_daily group by 1` returns 85 (AAPL)
    // with a year of sessions and nine FX pairs with one row each. Nothing else.
    const line = page.locator(`[data-panel="p3"] ${COMMAND_LINE}`);
    await line.click();
    await line.pressSequentially('AAPL US Equity GP', { delay: 10 });
    await line.press('Enter');
    await expect(page.locator('[data-panel="p3"]')).toContainText('GP · AAPL US Equity · Apple Inc', {
      timeout: 30_000,
    });

    // 1 — the payload. GP's own summary counts what it received: 243 trading sessions on the day
    // this was written, out of AAPL's 1,255 seeded daily bars. Asserted as a floor rather than as
    // 243, because the 1-year window slides with the wall clock while the fixture's last bar does
    // not, so the count falls by about one a day and an exact number would make this file expire.
    // The floor is what matters — SPX gives `Bars 0`, and `Bars 0` is what this file used to accept.
    const panel = page.locator('[data-panel="p3"]');
    const summary = (await panel.textContent()) ?? '';
    const bars = Number(/Bars\s*([\d,]+)/.exec(summary)?.[1]?.replace(/,/g, '') ?? '0');
    expect(bars, `GP's own summary says ${String(bars)} bars`).toBeGreaterThan(100);
    // And the window has a high above its low, both drawn from `bars_daily` rather than from the
    // quote — a chart that plotted the last price 243 times would satisfy a bar count and not this.
    const high = Number(/High\s*([\d,.]+)/.exec(summary)?.[1]?.replace(/,/g, '') ?? '0');
    const low = Number(/Low\s*([\d,.]+)/.exec(summary)?.[1]?.replace(/,/g, '') ?? '0');
    expect(high, `High ${String(high)} / Low ${String(low)}`).toBeGreaterThan(low);
    expect(low, 'the window low is not a price').toBeGreaterThan(0);

    // 2 — the BOX, which is the half no content assertion can see. `ChartCanvas`'s two canvases are
    // `position: absolute; inset: 0` and its root is `height: 100%`, so before `widgets.css` gave
    // `.custom-host` / `.chart-host` a height the host measured 635 × 0 and the canvas was sized
    // 635 × 1: a year of Apple painted one pixel tall, beside a summary that correctly said 243
    // bars. The readout, the legend and the provenance attribute below ALL still worked at 1 px —
    // they are DOM — which is why the height is asserted first and separately.
    const host = await page.locator('[data-panel="p3"] .chart-host').boundingBox();
    expect(host?.height ?? 0, `the chart host is ${String(host?.height)} px tall`).toBeGreaterThan(
      80,
    );
    const canvas = page.locator('[data-panel="p3"] canvas.chart__base');
    const drawn = await canvas.evaluate((el) => ({
      w: (el as HTMLCanvasElement).width,
      h: (el as HTMLCanvasElement).height,
    }));
    expect(drawn.h, `canvas.chart__base is sized ${String(drawn.w)} × ${String(drawn.h)}`).toBeGreaterThan(80);

    // 3 — the crosshair reads a REAL bar off that canvas. Keyboard only (CLIENT §4.1), and the
    // readout it writes names the session, the close and the volume of the bar it landed on.
    await page.locator('[data-panel="p3"] .chart').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const readout = page.locator('[data-panel="p3"] .chart__readout');
    await expect(readout).toContainText(/\d{4}-\d{2}-\d{2} · Apple Inc \d{3}\.\d{2}/);
    await expect(readout).toContainText(/Volume [\d,]{5,}/);

    // 4 — and it is citable. `Ctrl+I` is answered by `ScreenRenderer` reading `data-prov-idx` off
    // whatever has focus, and a chart's citation is per series, written as the crosshair moves.
    await expect(page.locator('[data-panel="p3"] .chart')).not.toHaveAttribute(
      'data-prov-idx',
      '-1',
    );
    const seriesCitations = await page
      .locator('[data-panel="p3"] .chart__legend-entry')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-prov-idx')));
    expect(seriesCitations.length, 'the chart drew no series').toBeGreaterThan(0);
    expect(seriesCitations, 'a plotted series with no provenance').not.toContain('-1');
  });

  // ── A GAP IN THE SEED, recorded where the plan expected to read the chart ───────────────────
  //
  // `test.fail()` for the same reason as the defect at the end of this file: it runs, it must fail,
  // and the day the seed gains index history Playwright reports "expected to fail but passed".
  //
  // The default desk's chart panel does not plot, and the obvious fix makes the terminal WORSE.
  // Both halves are measured, because one of them cost a suite run to learn.
  //
  // THE DATA. `bars_daily` holds AAPL (1,255 closes) and nine FX pairs with a single row each. SPX
  // has none, so `GP · SPX Index` — p3 of every seeded workspace — comes back with `primary.t[]` and
  // `primary.c[]` empty and the panel says so honestly: `primary: NO_SOURCE — no bars in window`,
  // `Bars 0 / Adjustments 0 / Events 0`, legend `S&P 500 —`. No capture can fix it:
  // `yahoo-chart-SPX-5d-5m.json` is five-minute intraday, and the seed may not invent history.
  //
  // WHY NOT JUST POINT IT AT AAPL. Tried, measured, reverted. Retargeting p3 to `AAPL US Equity`
  // does draw the chart — and it BLANKS a correct number two panels away. `ChartCanvas` is the only
  // thing in the app that subscribes anything (`state/subscriptions.ts#acquire` has no product
  // caller, so no grid subject is ever subscribed), and it subscribes `fields: ['PX_LAST']`. The
  // server answers a `sub` by REPLACING its field mask and sending a fresh `snap`, so the moment the
  // chart subscribes `q:85` the cache holds a view of AAPL with no `CHG_PCT_1D`, and `W · Core`'s
  // Apple row — which had `-0.84%` from its payload — renders `—  unavailable`. Two of these tests
  // caught it: this file's seeded-values test on `CHG_PCT_1D`, and `live-grid.spec.ts`'s TERM-08
  // flash, whose injected snapshot stopped reaching a cell that was no longer masked for it.
  //
  // So the order is: wire grid subscriptions so the union of fields is what the server is told, THEN
  // retarget this panel. Doing it the other way round trades an empty canvas for a wrong cell, and
  // a wrong cell is worse. Both halves are in BUILD_STATUS.md.
  test('the seeded workspace’s own chart panel plots its index', async ({ page }) => {
    test.fail(
      true,
      'SEED GAP + SUBSCRIPTION GAP: bars_daily has no SPX row, so GP · SPX Index draws an empty ' +
        'canvas on every load; and retargeting the panel at a security with history blanks ' +
        "W · Core's CHG_PCT_1D, because the chart is the app's only subscriber and it asks for " +
        'PX_LAST alone. Wire state/subscriptions.ts#acquire first.',
    );

    await openRestoredWorkspace(page);
    // Short: this assertion is already decided, and a 30 s wait for a known failure would be half a
    // minute on every run of the suite.
    await expect(page.locator('[data-panel="p3"]')).not.toContainText('no bars in window', {
      timeout: 8_000,
    });
  });

  test('every value on screen can be cited — the DOM half of DATA-10', async ({ page }) => {
    await openRestoredWorkspace(page);

    // First, that a grid drew the seeded data at all, on the one panel whose row count is fixed:
    // W · Core is a 5-instrument watchlist and the screen gives it five columns, so 25 cells — and
    // `toHaveCount` retries, which matters because `LiveGrid` virtualises. (WEI's grid genuinely
    // grows from 180 cells to 465 as the viewport is measured, which is why the assertion is not a
    // total over the page.)
    const watchlistCells = page.locator('[data-panel="p4"] [role="gridcell"]');
    await expect(watchlistCells, 'W · Core drew no grid — is the database seeded?').toHaveCount(25);
    await expect(page.locator('[data-panel="p4"] [role="columnheader"]')).toHaveText([
      'Security',
      'Name',
      'Last price',
      'Percent change',
      'Chg',
    ]);

    // Now the contract. `screen/widgets/registry.ts` L64: "LiveGrid MUST write `data-prov-idx` on
    // every cell it draws", because `Ctrl+I` is answered by `ScreenRenderer` reading that attribute
    // off whatever has focus. The two counts are compared with each other rather than against a
    // number, so this fails the moment one cell loses its citation — and both are taken inside ONE
    // `evaluate`, because two `count()` calls either side of a virtualised grid's growth would be
    // comparing two different pages.
    const provenance = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('[role="gridcell"]')];
      return {
        total: cells.length,
        cited: cells.filter((cell) => cell.hasAttribute('data-prov-idx')).length,
      };
    });
    expect(provenance.total, 'no grid cells on the page').toBeGreaterThan(0);
    expect(provenance.cited, 'grid cells without a `data-prov-idx`').toBe(provenance.total);

    // The `kv` widget cites at ROW level (`screen/widgets/KeyValue.tsx` L67) and `role="cell"` is
    // the value span inside it, so those resolve their citation through `closest()` — exactly as
    // `ScreenRenderer.tsx` L151 does it. Checked the way the product reads it, rather than by
    // assuming the attribute sits on the same element.
    const valueCells = page.locator('[role="cell"]');
    const uncitable = await valueCells.evaluateAll(
      (els) => els.filter((el) => el.closest('[data-prov-idx]') === null).length,
    );
    expect(await valueCells.count(), 'no kv values were drawn').toBeGreaterThan(0);
    expect(uncitable, 'value cells with no citable ancestor').toBe(0);
  });

  test('an authenticated load makes no failed request, and stays on its own origin', async ({
    page,
  }) => {
    // Two contracts in one pass, because both are properties of the same page load.
    //
    //  * Nothing 4xx/5xx. A restored workspace runs four functions, reads the session, the
    //    workspace and the universe snapshot, saves the workspace back and posts a usage event; if
    //    any of that were refused the screen would still draw, with a reason code in place of a
    //    value, and a spec looking only at the DOM would not notice.
    //  * API-05 at runtime, complementing the static check in `web/test/no-direct-io.test.ts`:
    //    every request goes to the page's own origin and reaches the plant through the proxy.
    const failed: string[] = [];
    const offOrigin: string[] = [];
    const runs = new Set<string>();

    page.on('response', (res) => {
      const url = res.url();
      if (res.status() >= 400) {
        failed.push(`${String(res.status())} ${res.request().method()} ${url}`);
      }
      const run = /\/api\/v1\/functions\/([A-Z]+)\/run$/.exec(url);
      if (run?.[1] !== undefined && res.status() === 200) runs.add(run[1]);
    });
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url.startsWith('blob:')) return;
      if (!url.startsWith(WEB_URL)) offOrigin.push(`${req.method()} ${url}`);
    });

    await openRestoredWorkspace(page);
    await page.waitForLoadState('networkidle');

    expect(failed, 'the page made requests that were refused').toEqual([]);
    expect(offOrigin, `the page talked to an origin other than ${WEB_URL}`).toEqual([]);
    // Sanity, so the assertion above has teeth: the plant's origin really is a different one.
    expect(SERVER_URL).not.toBe(WEB_URL);
    // And the four runs happened — otherwise "no failed request" is satisfied by a page that asked
    // for nothing at all.
    expect([...runs].sort()).toEqual(['GP', 'TOP', 'W', 'WEI']);
  });

  // ── A DEFECT, recorded rather than hidden ───────────────────────────────────────────────────
  //
  // `test.fail()` and not `test.skip()`: this runs on every suite, it MUST fail, and the day somebody
  // fixes the restore path Playwright reports "expected to fail but passed" — so the fix cannot land
  // unnoticed and the record cannot rot. Nothing is weakened to accommodate it; the assertion below
  // is the one the product should satisfy.
  //
  // What happens. `App.tsx#onRestored` (L1135) re-runs each restored frame as
  // `"<security display> <fn>"` — `"SPX Index GP"`. The dispatcher resolves that display as a REF,
  // and a ref-addressed security has no local instrument id, so the `pushFrame` adapter at
  // `App.tsx` L664 anchors NO security on the frame it pushes. Its comment describes that choice
  // deliberately, and only in terms of the panel header; what it does not consider is that the
  // pushed frame becomes the ACTIVE one and is then persisted. The layout in postgres now holds a GP
  // frame with `security: null`, so the next load rebuilds the command as bare `"GP"`.
  //
  // Measured on `pm@demo.terminal`'s `p3` in `bloomberg_e2e`, after two loads:
  //   frameStack[1] = { fn: "GP", security: null, resultId: "01M3F9…" }, index: 1
  //   history       = ["SPX Index GP RANGE=1Y", "SPX Index GP"]
  //   the screen    = "NO_SECURITY_LOADED: GP needs a security — load one, or type 'SECF GP'"
  //
  // The first load is fine — the run is built from the command text, which still names the security —
  // so this is invisible until a user opens the terminal a second time, and then their chart has lost
  // its instrument. TERM-05.
  test('a reload keeps the instrument a panel was restored with (TERM-05)', async ({ page }) => {
    test.fail(
      true,
      'DEFECT: the frame pushed by onRestored is persisted with security: null, so the second ' +
        'load restores GP with no instrument. App.tsx L1135 + L664.',
    );

    await openRestoredWorkspace(page);
    // The autosave is debounced; `pagehide` flushes it, and a reload fires `pagehide`.
    await page.reload();
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
    // A short timeout on purpose: this assertion is expected to fail, and a 30 s wait for a failure
    // that is already decided would add half a minute to every run of the suite.
    await expect(page.locator('[data-panel="p3"]')).toContainText('GP · SPX Index · S&P 500', {
      timeout: 8_000,
    });
  });

  test.describe('without the harness’s session', () => {
    // No cookie at all. This is the control for every assertion above: it shows that what gets the
    // browser past the gate is the `storageState` `globalSetup` minted, and not something the app
    // would have done by itself.
    test.use({ storageState: { cookies: [], origins: [] } });

    test('the terminal is a gate, and there is nothing to type into', async ({ page }) => {
      await page.goto('/');

      const gate = page.getByTestId('session-gate');
      await expect(gate).toBeVisible();
      // `App.tsx`'s `Gate` has four states on `data-gate`; `anonymous` is "the plant answered, and
      // there is no session", as distinct from `unknown` ("it never answered").
      await expect(gate).toHaveAttribute('data-gate', 'anonymous');
      await expect(gate).toContainText('NO SESSION');
      await expect(gate).toContainText('This terminal has no sign-in screen');

      // No shell, no panels, no command line — which is precisely why `fixtures/auth.ts` exists.
      await expect(page.getByTestId('shell')).toHaveCount(0);
      await expect(page.locator('[data-panel]')).toHaveCount(0);
      await expect(page.locator(COMMAND_LINE)).toHaveCount(0);

      // The account the tests above run as is the seeded one, not an invention of this fixture.
      expect(E2E_USERS.pm.email).toBe('pm@demo.terminal');
    });
  });
});
