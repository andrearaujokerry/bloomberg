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
//   * `pm@demo.terminal`'s active workspace — mode `4`, `p1=WEI p2=TOP p3=GP(SPX Index, 5D)
//     p4=W(Core)`, `conflationMs: 250` (`fixtures/seed/workspaces.json`, seed module 13). The GP
//     panel's range is `5D` and not `1Y` for a measured reason the fixture's `gpRangeNote` and the
//     chart test below both carry: the seeded universe has SPX in `bars_intraday` and nowhere else;
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
  //   * a restore no longer DEGRADES the layout it restores (the regression test near the end of this
  //     file is what holds that), but the tests here still launch functions into these panels, so the
  //     reset is what keeps one test's launches out of the next one's assertions.
  //     `resetWorkspace`'s docstring still describes the old defect.
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
    // THE SUBSCRIPTION COUNTER, which is what this test is named after and what it could not see.
    //
    // `expect(used ?? -1).toBeGreaterThanOrEqual(0)` was the assertion here, against a number the
    // server hardcoded: `entitlements/quotas.ts#state` takes the live count from its caller — the
    // plant holds the subscription set in memory and there is no table to read — and every HTTP
    // caller omitted the argument, so `GET /auth/session` and `GET /usage/quota` both answered
    // `"concurrentSubscriptions":{"used":0}` with 35 subjects live on the socket. The assertion was
    // satisfied by the constant it is named after: the eleventh test in this build that could not
    // fail, and it was guarding the very counter in its own title.
    //
    // Two things are asserted instead, and the first is the one that fails against a constant.
    expect(strip.concurrentSubscriptions?.limit).toBe(live.concurrentSubscriptions?.limit);

    // 1 — the plant's own count, which is NOT zero: the four restored panels subscribe their grid
    // subjects (`Panel.tsx`'s `live` effect) and the chart subscribes its own. Polled, because the
    // subscriptions land a moment after the last panel paints.
    await expect
      .poll(
        async () => {
          const body = (await (await page.request.get('/api/v1/usage/quota')).json()) as {
            concurrentSubscriptions: { used: number };
          };
          return body.concurrentSubscriptions.used;
        },
        { message: 'GET /usage/quota never reported a live subscription', timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    // 2 — and the strip agrees with it. The strip is seeded from `GET /auth/session` at page load,
    // which happens BEFORE any panel has subscribed, and refreshed on a 60 s cadence — too slow for
    // a spec to wait on. `session.ts#startQuotaRefresh` also refreshes on `visibilitychange`, which
    // is the gesture a trader makes by coming back to the tab, so that is the one dispatched here:
    // the product's own listener, not a back door into the store.
    const settled = (await (await page.request.get('/api/v1/usage/quota')).json()) as {
      concurrentSubscriptions: { used: number };
    };
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect
      .poll(async () => (await quotaStrip(page)).concurrentSubscriptions?.used, {
        message: 'the strip never picked up the plant’s subscription count',
        timeout: 15_000,
      })
      .toBe(settled.concurrentSubscriptions.used);

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

    // The seeded workspace's own chart panel is GP of `SPX Index`, and SPX has no DAILY bars — which
    // is why that panel asks for `5D` and is proved intraday by the test below. This one is the DAILY
    // path, on the one security in the universe that has daily history: `select instrument_id,
    // count(*) from bars_daily group by 1` returns 85 (AAPL) with five years of sessions and nine FX
    // pairs with one row each. Nothing else.
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

  // ── THE DEFAULT DESK'S OWN CHART, which was a `test.fail` until the range was measured ────
  //
  // This was the `test.fail` "SEED GAP + SUBSCRIPTION GAP". Both halves were re-measured, both are
  // closed, and it is a required assertion now.
  //
  // THE SEED HALF. `bars_daily` holds AAPL and nine FX pairs and no index at all, so `GP · SPX Index`
  // at the seeded `range: '1Y'` came back with `primary.t[]`/`primary.c[]` empty and said so honestly
  // (`primary: NO_SOURCE — no bars in window`, `Bars 0`, `High —`, `Low —`). The capture that DOES hold
  // SPX is `yahoo-chart-SPX-5d-5m.json`, five-minute and five sessions long, and it is seeded — 376
  // rows in `bars_intraday`. GP reaches it at `1D` and `5D` (its own help text: "Ranges 1D and 5D use
  // 1- and 5-minute bars"), and measured over the seeded database `POST /functions/GP/run
  // {security:{ref:'SPX Index'},params:{range:'5D'}}` answers 200 with 376 bars and
  // `periodicity: '5m'` where `1D`, `1M` and `1Y` each answer 200 with zero. So the fixture asks for
  // `5D` (`fixtures/seed/workspaces.json#gpRangeNote`) and the panel keeps its instrument.
  //
  // **And `5D` does not expire, which is the thing to check before trusting an intraday fixture.** The
  // window GP reports is a ROLLING one off the as-of clock — today it is 2026-09-24 → 2026-10-01, which
  // contains none of the capture — but the bars do not come from it: `data/intraday.ts#recentSessions`
  // takes the last `days` session dates THAT HAVE BARS on or before the as-of date. The panel therefore
  // finds the capture's last five sessions however old they are, and the visible cost is that the
  // `Window` row names the window asked for rather than the one served.
  //
  // THE SUBSCRIPTION HALF, which is why this is not the AAPL retarget the old note proposed.
  // Retargeting used to blank a correct number two panels away: `ChartCanvas` was the app's only
  // subscriber, it asked for `PX_LAST` alone, and a `sub` REPLACES the server's field mask — so the
  // moment the chart took a grid's subject the cache held a view with no `CHG_PCT_1D` and `W · Core`'s
  // Apple row went from `-0.84%` to `— unavailable`. Tier 1 gave every panel its manifest `LiveSpec`,
  // and the union was re-measured in this browser before the fixture was touched. Every `sub` the
  // seeded desk sends, recorded off the socket: `W · Core` asks for `{"s":"q:37367","f":["CHG_PCT_1D",
  // "PX_LAST"]}` on its SPX row and WEI widens the SAME subject to `["CHG_NET_1D","CHG_PCT_1D",
  // "PX_LAST","SESSION_STATE"]`, with Apple's row still reading `▼ -0.84%` — `SubscriptionManager
  // #desiredFields` unions across holders in the shipped app. At `5D` the hazard is structurally absent
  // as well: GP's intraday `LiveSpec` names `b1m:37367`, a different subject from any grid's, so this
  // chart cannot replace a quote's field mask at all. The retarget was therefore SAFE and was still not
  // taken, because it would rename the seeded panel that `panels.spec.ts` L89/L169,
  // `layout-geometry.spec.ts` L133 and `export.spec.ts` L55 each assert on by name, and an index is
  // what the default desk's chart is for.
  //
  // WHAT THIS TEST ASSERTS, and why not `data-chart-state`. That attribute reads `drawn` for an empty
  // canvas — measured: with `Bars 0` on screen it was still `drawn`, because it reports that a frame was
  // painted and not that anything was plotted. So the assertion is the INK: `canvas.chart__base`'s own
  // pixels, counted against the background the theme painted them on. Both states were measured, by
  // re-seeding this panel at `1Y` and reading the same rect — the empty canvas is NOT blank, it rules
  // its gridlines (`drawn 2028 / 63048`, 3 colours, ink in 5 of 142 rows), so the ink assertion is the
  // VERTICAL SPREAD and the colour count and not a pixel floor; see the note on it below, which is
  // where that measurement stopped a twelfth test that could not fail. With the series drawn:
  // `drawn 4308 / 58164`, 12 colours, ink in 131 of 131 rows.
  test('the seeded workspace’s own chart panel plots its index', async ({ page }) => {
    await openRestoredWorkspace(page);
    const panel = page.locator('[data-panel="p3"]');

    // 1 — the payload reached the screen. Both clauses, because either alone is satisfiable by the
    // quote row BESIDE the canvas: the absence of the refusal, and the bar count GP itself reports.
    await expect(panel).not.toContainText('no bars in window', { timeout: 30_000 });
    const summary = (await panel.textContent()) ?? '';
    const bars = Number(/Bars\s*([\d,]+)/.exec(summary)?.[1]?.replace(/,/g, '') ?? '0');
    // 376 is the whole capture; the floor allows GP to drop a partial session without this expiring,
    // and it is two orders of magnitude above the `Bars 0` this test used to accept.
    expect(bars, `GP’s own summary says ${String(bars)} bars`).toBeGreaterThan(300);
    // The window's own high and low, which GP computes from `primary.c` — the very closes the canvas
    // plotted, so no quote row beside it can satisfy them.
    //
    // The seeded level `7,585.75` is deliberately NOT asserted here, and not because it is missing: it
    // IS served, and re-measured straight off `POST /functions/GP/run` on a settled tree the payload
    // answers `last: { v: 7585.75, st: 'stale', provIdx: 1 }` at `5D` exactly as it does at `1Y`. (An
    // earlier draft of this comment recorded it as withheld — `{ v: null, st: 'closed', r: 'TIER_EOD' }`
    // — which was true only of an e2e template seeded in the middle of a licence change, and is not
    // true of the fixture: the two measurements differ by WHEN the database was seeded, not by the
    // range. A number read off a stale template is worth less than no number, so it is corrected here
    // rather than carried.) It is left to the TERM-05 test at the end of this file, which asserts
    // `7,585.75` on this same panel for a different reason — it reaches the screen through the `Last`
    // cell, which a chart that plots nothing would print just as happily. The window extremes cannot
    // be printed without a plotted series, which is why they are this test's number.
    await expect(panel).toContainText('7,676.27'); // window high, off the plotted series
    await expect(panel).toContainText('7,575.58'); // window low
    await expect(panel).toContainText('5m'); // the periodicity GP served, not the one asked for

    // 2 — the INK, and the assertion is NOT a pixel count, because a pixel count here cannot fail.
    //
    // Counted inside the plot rect rather than over the whole canvas, so the axis furniture and the
    // legend cannot pay for a series that is not there: the gutters are 6 ch each (§11.2) and the
    // strip is one line, so an inset of 15 % a side is comfortably inside the plot. That much was
    // sound. What a first draft of this test got wrong is worth keeping, because it is the exact
    // shape of the eleven tests this build has already caught: it asserted `drawn > 500` on the
    // belief that an empty canvas draws nothing inside the rect. MEASURED, on the same panel with
    // the range put back to the committed `1Y` — `{ drawn: 2028, total: 63048, colours: 3, rows: 5
    // of 142 }`. The empty chart still rules its gridlines, so the floor would have been cleared by
    // four times over by a chart that plots NOTHING, and the assertion would have been decoration.
    //
    // So the thing asserted is what the two states actually differ in: a plotted series spreads
    // VERTICALLY and brings its own colours, where gridlines occupy a handful of rows in one colour.
    // Measured at `5D`: `{ drawn: 4308, total: 58164, colours: 12, rows: 131 of 131 }` — every single
    // row of the plot band carries ink, against 5 of 142 when the canvas is empty.
    const ink = await page.locator('[data-panel="p3"] canvas.chart__base').evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      const ctx = canvas.getContext('2d');
      if (ctx === null || canvas.width === 0 || canvas.height === 0) return null;
      const x0 = Math.floor(canvas.width * 0.15);
      const y0 = Math.floor(canvas.height * 0.15);
      const w = Math.max(1, Math.floor(canvas.width * 0.7));
      const h = Math.max(1, Math.floor(canvas.height * 0.7));
      const { data } = ctx.getImageData(x0, y0, w, h);
      // The modal colour IS the background: the plot is mostly empty on any honest chart. Every
      // pixel that is not it is something the renderer drew.
      const tally = new Map<number, number>();
      for (let i = 0; i < data.length; i += 4) {
        const key = ((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      let background = 0;
      let most = -1;
      for (const [key, count] of tally) {
        if (count > most) {
          most = count;
          background = key;
        }
      }
      // Which ROWS of the band carry ink, which is what separates a series from a set of gridlines.
      const rows = new Set<number>();
      for (let i = 0; i < data.length; i += 4) {
        const key = ((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
        if (key !== background) rows.add(Math.floor(i / 4 / w));
      }
      const total = data.length / 4;
      return {
        drawn: total - (tally.get(background) ?? 0),
        total,
        colours: tally.size,
        rows: rows.size,
        h,
      };
    });
    expect(ink, 'canvas.chart__base has no 2-D context or no size').not.toBeNull();
    const rowsWithInk = ink?.rows ?? 0;
    const band = ink?.h ?? 1;
    // Half the band, against 131 of 131 measured and 5 of 142 on the empty canvas: wide enough that
    // a gapped or flattened series fails it, far enough from the measurement to survive a theme that
    // moves a gridline.
    expect(
      rowsWithInk,
      `ink reaches ${String(rowsWithInk)} of ${String(band)} rows of the plot band`,
    ).toBeGreaterThan(band / 2);
    // And the colours, which is the same question asked of the palette rather than of the geometry:
    // 12 with the series drawn, 3 with only gridlines.
    expect(
      ink?.colours ?? 0,
      `${String(ink?.colours)} distinct colours in the plot band`,
    ).toBeGreaterThan(5);
    // The pixel count is kept, above the 2,028 of furniture measured on the empty canvas rather than
    // below it, and PRINTED the way `autocomplete.spec.ts` prints its keystroke budget: the next
    // person to change the seeded range needs the measurement, not just a pass.
    expect(
      ink?.drawn ?? 0,
      `${String(ink?.drawn)} of ${String(ink?.total)} plot px are not background`,
    ).toBeGreaterThan(3_000);
    console.log(
      `chart ink: ${String(ink?.drawn)} of ${String(ink?.total)} plot px are not background, ` +
        `in ${String(ink?.colours)} distinct colours, reaching ${String(rowsWithInk)} of ` +
        `${String(band)} rows`,
    );

    // 3 — and the bars are SPX's five-minute bars, not a flat line at the last price: the crosshair
    // reads the session off the canvas, and an intraday capture gives it a clock time.
    await panel.locator('.chart').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(panel.locator('.chart__readout')).toContainText(/S&P 500 [\d,]{4,}\.\d{2}/);
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

  test('one load reads the session, the workspace and each panel exactly once', async ({ page }) => {
    // THE RESTORE RAN EVERY PANEL TWICE, and nothing could see it.
    //
    // `Shell.tsx` loaded the workspace and re-ran every restored frame in an effect with no guard,
    // and `App.tsx` read the session gate in another; React StrictMode — which `main.tsx` wraps the
    // application in, on purpose, to expose exactly this — mounts, tears down and re-mounts every
    // component in development, so both effects ran twice. Counted off the wire on one authenticated
    // load of the seeded desk: `GET /auth/session` ×2, `GET /workspace` ×2, and `WEI`, `GP`, `W` and
    // `TOP` ×2 each. The plant's own ledger agreed — `select kind, code, count(*),
    // count(distinct trace_id) from usage_events` over three loads gave `fn.launch W=6/6, GP=6/6,
    // WEI=6/6`: two launches, two distinct trace ids, per panel, per load.
    //
    // It cost four duplicate function runs, two `fn.launch` quota rows per panel and two refreshes of
    // `sessions.last_seen_at` per visit, and every screen looked exactly right. So the assertion is a
    // COUNT off the wire, which is the only channel the defect was ever visible on — the DOM half of
    // this file cannot see it, and neither could 254 green vitest files, because none of them renders
    // the shell inside the StrictMode the product uses.
    const calls = new Map<string, number>();
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (!url.pathname.startsWith('/api/v1/')) return;
      const key = `${req.method()} ${url.pathname}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
    });

    await openRestoredWorkspace(page);
    await page.waitForLoadState('networkidle');

    for (const key of [
      'GET /api/v1/auth/session',
      'GET /api/v1/workspace',
      'POST /api/v1/functions/WEI/run',
      'POST /api/v1/functions/GP/run',
      'POST /api/v1/functions/W/run',
      'POST /api/v1/functions/TOP/run',
    ]) {
      // `toBe(1)`, not `toBeLessThan(2)`: zero would mean the page never asked, and this assertion
      // has to fail on that too.
      expect(calls.get(key) ?? 0, `${key} — once per page load`).toBe(1);
    }
  });

  // ── The regression test for the defect this file used to record ─────────────────────────────
  //
  // **A reload keeps the instrument a panel was restored with.**
  //
  // A `test.fail` for one work package, and what it measured is the reason this test reloads twice
  // over. `App.tsx#onRestored` re-ran each restored frame as `"<security display> <fn>"` —
  // `"SPX Index GP"`. The dispatcher resolved that display as a REF (the local universe index is
  // keyed on tickers and does not answer a display), a ref-addressed security has no local instrument
  // id, so the `pushFrame` adapter anchored NO security on the frame it pushed. That pushed frame
  // became the ACTIVE one and was then persisted, so the layout in postgres held a GP frame with
  // `security: null` and the next load rebuilt the command as the bare `"GP"`.
  //
  // Measured then on `pm@demo.terminal`'s `p3` in `bloomberg_e2e`, after two loads:
  //   frameStack[1] = { fn: "GP", security: null, resultId: "01M3F9…" }, index: 1
  //   history       = ["SPX Index GP RANGE=1Y", "SPX Index GP"]
  //   the screen    = "NO_SECURITY_LOADED: GP needs a security — load one, or type 'SECF GP'"
  //
  // The first load was fine — that run was built from the command text, which still named the
  // security — so it was invisible until a user opened the terminal a SECOND time, and then their
  // chart had lost its instrument. `onRestored` now re-runs the frame from its own fields
  // (`command/dispatch.ts#executeFrame`), so the frame it re-runs is the frame that is saved again.
  // TERM-05.
  test('a reload keeps the instrument a panel was restored with (TERM-05)', async ({ page }) => {
    await openRestoredWorkspace(page);
    // The autosave is debounced; `pagehide` flushes it, and a reload fires `pagehide`.
    await page.reload();
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-panel="p3"]')).toContainText('GP · SPX Index · S&P 500', {
      timeout: 30_000,
    });
    // The index's own seeded level, so that "the instrument came back" is a value and not a title:
    // `7,585.75` is the recorded Cboe poll for SPX (`fixtures/providers/raw/`, modules 2-7).
    await expect(page.locator('[data-panel="p3"]')).toContainText('7,585.75');

    // And a THIRD load, because the loss was invisible on the load that caused it: what the second
    // load saved is what the third one reads.
    await page.reload();
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-panel="p3"]')).toContainText('GP · SPX Index · S&P 500', {
      timeout: 30_000,
    });
  });

  test.describe('without the harness’s session', () => {
    // No cookie at all. This is the control for every assertion above: it shows that what gets the
    // browser past the gate is the `storageState` `globalSetup` minted, and not something the app
    // would have done by itself.
    test.use({ storageState: { cookies: [], origins: [] } });

    test('the terminal is a sign-in form, and there is no terminal behind it', async ({ page }) => {
      await page.goto('/');

      const gate = page.getByTestId('session-gate');
      await expect(gate).toBeVisible();
      // `App.tsx`'s `Gate` has four states on `data-gate`; `anonymous` is "the plant answered, and
      // there is no session", as distinct from `unknown` ("it never answered").
      await expect(gate).toHaveAttribute('data-gate', 'anonymous');
      // `anonymous` is the login form (`shell/SignIn.tsx`); `login.spec.ts` signs in through it.
      await expect(gate.getByTestId('login-form')).toBeVisible();
      await expect(gate.getByLabel('Email', { exact: true })).toBeVisible();
      await expect(gate.getByLabel('Password', { exact: true })).toBeVisible();

      // No shell, no panels, no command line — the specs above are past the form only because
      // `fixtures/auth.ts` signed in for them.
      await expect(page.getByTestId('shell')).toHaveCount(0);
      await expect(page.locator('[data-panel]')).toHaveCount(0);
      await expect(page.locator(COMMAND_LINE)).toHaveCount(0);

      // The account the tests above run as is the seeded one, not an invention of this fixture.
      expect(E2E_USERS.pm.email).toBe('pm@demo.terminal');
    });
  });
});
