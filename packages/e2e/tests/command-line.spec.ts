// packages/e2e/tests/command-line.spec.ts — TERM-01 and TERM-03, driven from the one line the
// terminal is driven from (WORKPLAN WP-15: "`AAPL US Equity DES <GO>`, function-only and
// security-only input").
//
// ## The three input shapes, and why each test ends in a number
//
// FUNCTIONS.md §2.5 L773-789 is a three-row table, and the three tests below are its three rows:
//
//   | typed                  | what must happen                                                |
//   | ---------------------- | --------------------------------------------------------------- |
//   | `AAPL US Equity DES`   | both replaced — DES runs on Apple                                 |
//   | `HP`                   | the function is replaced, the panel's SECURITY is carried          |
//   | `AAPL US Equity`       | the security is replaced, the panel's FUNCTION is kept and re-runs |
//
// A spec that proved those by looking for a non-empty panel would pass against an empty database,
// against the wrong instrument, and against a screen that drew its skeleton and never filled it —
// this build has already shipped nine tests of that shape. So every assertion here names a value
// that only the seeded universe can produce, and says where it comes from:
//
//   * `330.27 / ▼ -2.81` — AAPL's last and net change from the one recorded Cboe poll
//     (`fixtures/providers/raw/cboe-quote-AAPL.json`, seed module 7);
//   * `2026-09-15 · 330.18 · 17,504,609` and `244` bars — AAPL's seeded daily bars, which are the
//     ONLY equity bars in the universe (`select … from bars_daily` returns AAPL 1255 and ten FX
//     pairs with one row each), so an HP that carried the wrong security has nothing to draw;
//   * `Microsoft Corp` / CIK `0000789019` — the security master and SEC submissions (modules 2-4).
//
// and the price cell is followed to its source: `Ctrl+I` on it opens the provenance panel, which
// must name `cboe.quotes` (DATA-10 — the whole point of `data-prov-idx` is that a user can ask).
//
// ## The autocomplete contract this file also pins
//
// The last test is here because the behaviour it asserts was WRONG until WP-15 part 1 and is the
// kind that regresses silently: with the popup open and nothing arrowed onto, GO runs THE TYPED
// TEXT, not the top row (`App.tsx` L1033-L1040, `CommandLine.tsx#go`). The old code reported
// `selected: 0` for every fresh list, so GO executed whatever the ranking had put first.
//
// It needs a typed string whose meaning DIFFERS from row 0, or it proves nothing. `AAPL US Equity
// DES` is not one: row 0 there is the function `DES`, and substituting `DES` into the completed
// token gives back the same line. `MICROSOFT` is: row 0 is `MSFT US Equity` (measured), while the
// text itself is nine characters the parser reads as a malformed identifier. So the two paths end
// in two different places, and the test can tell them apart.
//
// Everything is driven over the wire, as the suite's other specs are (WORKPLAN §1.2); the only
// imports are this package's own fixtures.

import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { E2E_USERS } from '../fixtures/auth.js';
import { resetWorkspace } from '../fixtures/database.js';

/** `data-testid="command-line"` is on the `<input>` of `shell/CommandLine.tsx` — one PER PANEL. */
const commandLine = (page: Page, panelId: string): Locator =>
  page.locator(`[data-panel="${panelId}"] [data-testid="command-line"]`);

const panelOf = (page: Page, panelId: string): Locator => page.locator(`[data-panel="${panelId}"]`);

/**
 * The panel's own header line: `p1 DES AAPL US Equity trace …`.
 *
 * It is the panel SAYING which security it holds (`Panel.tsx`: `frame?.security?.display ??
 * frame?.instrument?.display`), which is a different claim from the screen's title — the title
 * comes from the payload the plant returned, the header from what the frame anchored. The
 * function-only test needs the second one, because a frame that anchored nothing is a panel with no
 * security to carry.
 */
const headerOf = (page: Page, panelId: string): Locator =>
  panelOf(page, panelId).locator('> div').first();

/** The seeded workspace, restored and finished running — the same four titles `smoke.spec.ts` waits on. */
async function openTerminal(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-panel="p1"]'), 'p1').toContainText('WEI ·', { timeout: 30_000 });
  await expect(page.locator('[data-panel="p2"]'), 'p2').toContainText('TOP ·', { timeout: 30_000 });
  await expect(page.locator('[data-panel="p4"]'), 'p4').toContainText('W ·', { timeout: 30_000 });
}

/**
 * Type a command into one panel's command line and press GO.
 *
 * `pressSequentially`, not `fill`: the autocomplete ranks per keystroke (CLIENT §4.1) and a command
 * that arrived in one DOM write would skip the very code path the last test in this file is about.
 * `press('Enter')` goes to the input, where `CommandLine`'s own handler consumes it — the window
 * dispatcher never sees it — and today could not anyway: the window dispatcher is built and never
 * attached (BUILD_STATUS.md), so `CommandLine`'s own `onKeyDown` is the only thing listening.
 */
async function go(page: Page, panelId: string, command: string): Promise<void> {
  const input = commandLine(page, panelId);
  await input.click();
  await input.pressSequentially(command, { delay: 10 });
  await input.press('Enter');
}

/**
 * Run `command` in `panelId` until the panel reports it is holding `security`.
 *
 * The retry is a precondition, not a tolerance, and it exists because of a measured race rather
 * than out of caution. `LocalUniverseIndex.load()` builds the 41,455-entry index in a worker, and
 * until it has, `ParseEnv.lookupTicker` answers nothing: the parser then addresses the security by
 * REF, `dispatch.ts#frameSecurityOf` gives the frame `{ id: null, … }`, and `App.tsx` L664 — which
 * cannot store a security with no instrument id — anchors NONE. The run still works (the plant
 * resolves the ref and the screen draws Apple), but the panel is left holding no security, so the
 * NEXT function-only command answers `NO_SECURITY_LOADED`.
 *
 * Measured on this stack, twice: a GO 744 ms after `goto` anchors nothing; the same GO at 919 ms
 * anchors `AAPL US Equity`. The snapshot response lands at ~420 ms either way, so waiting on the
 * request is not the signal — the build finishes later and announces itself nowhere. Reported as a
 * finding; pressing GO again is what a user does, and what this does.
 */
async function goHolding(
  page: Page,
  panelId: string,
  command: string,
  security: string,
): Promise<void> {
  await expect(async () => {
    await go(page, panelId, command);
    await expect(headerOf(page, panelId)).toContainText(security, { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

/** One `kv` row by its label — `screen/widgets/KeyValue.tsx`: `role="row"` › rowheader + cell. */
function kvRow(page: Page, panelId: string, label: string): Locator {
  return panelOf(page, panelId)
    .locator('[role="row"]')
    .filter({ has: page.getByRole('rowheader', { name: label, exact: true }) })
    .first();
}

test.describe('WP-15 — the command line (TERM-01, TERM-03)', () => {
  // Loading the terminal rewrites the workspace (the shell autosaves and flushes on `pagehide`),
  // and every test here launches functions into `pm`'s panels. Without the reset, test 2 would be
  // asserting against test 1's layout and the order of this file would be part of its result.
  test.beforeEach(async () => {
    await resetWorkspace(E2E_USERS.pm.email);
  });

  test('`AAPL US Equity DES <GO>` runs DES on Apple, and the price it shows can be cited', async ({
    page,
  }) => {
    await openTerminal(page);
    // p1 restores as `WEI` — a world-indices grid with no security — so nothing about the panel
    // before this line could produce Apple.
    await expect(panelOf(page, 'p1')).toContainText('WEI · World Equity Indices');

    await go(page, 'p1', 'AAPL US Equity DES');

    // The screen's title and classification line are built from the payload the plant returned:
    // `instruments.name`, `.asset_class`/`issue type`, `.exch_code`, `.currency`.
    const p1 = panelOf(page, 'p1');
    await expect(p1).toContainText('DES · AAPL US Equity · Apple Inc', { timeout: 20_000 });
    await expect(p1).toContainText('Common Stock · US · USD');

    // The quote block, from the recorded Cboe poll. Four numbers, because one of them could be a
    // coincidence and four of them are the fixture.
    const last = kvRow(page, 'p1', 'Last');
    await expect(last.getByRole('cell')).toContainText('330.27');
    await expect(kvRow(page, 'p1', 'Chg').getByRole('cell')).toContainText('▼ -2.81');
    await expect(kvRow(page, 'p1', 'Prev').getByRole('cell')).toContainText('333.08');
    await expect(kvRow(page, 'p1', 'Volume').getByRole('cell')).toContainText('16,591,786');

    // DATA-10, followed all the way. The row carries a `data-prov-idx`, that index is a real entry
    // rather than the `-1` an unattributed value gets, and `Ctrl+I` on the row — the renderer's own
    // reserved key, `ScreenRenderer.tsx` L297 — opens the panel that names the source. `cboe.quotes`
    // is the `provenance.source_id` the seed wrote for that poll.
    const provIdx = Number(await last.getAttribute('data-prov-idx'));
    expect(provIdx, 'the last price cites no provenance entry').toBeGreaterThanOrEqual(0);
    await last.focus();
    await last.press('Control+i');
    const provenance = p1.getByRole('dialog', { name: 'Provenance' });
    await expect(provenance).toBeVisible();
    await expect(provenance).toContainText('cboe.quotes');
    await expect(provenance).toContainText('Provenance id');
    // Not the "this value has not been attributed yet" branch, which is what a `-1` would have
    // rendered — the assertion above would otherwise be satisfied by an open but empty panel.
    await expect(provenance).not.toContainText('Pending —');

    // §2.5 L783: a GO clears the draft. It is the shell that has to do it (the input is
    // uncontrolled), and when it did not, the second command of a session arrived as `DESGP`.
    await expect(commandLine(page, 'p1')).toHaveValue('');
  });

  test('a function on its own is run against the security the panel already holds (TERM-03)', async ({
    page,
  }) => {
    await openTerminal(page);
    await goHolding(page, 'p1', 'AAPL US Equity DES', 'AAPL US Equity');
    await expect(panelOf(page, 'p1')).toContainText('DES · AAPL US Equity · Apple Inc', {
      timeout: 20_000,
    });

    // Two characters, no security — the panel's own is carried (`parser.ts#functionRunRequest`).
    await go(page, 'p1', 'HP');

    const p1 = panelOf(page, 'p1');
    await expect(p1).toContainText('HP · AAPL US Equity · Apple Inc', { timeout: 20_000 });
    await expect(headerOf(page, 'p1')).toContainText('AAPL US Equity');
    // The manifest's defaults, applied over nothing the user typed: 1 year of daily price bars.
    await expect(p1).toContainText('1Y · D · price · USD');

    // AAPL's seeded bars. The top row is the last session in the fixture and its five values are
    // the row `bars_daily` holds for 2026-09-15; the summary counts the whole window. No other
    // equity in the seeded universe has a single daily bar, so an HP that had carried the wrong
    // security — or none — would be drawing "no daily bars in window" here.
    const grid = p1.locator('[role="gridcell"]');
    await expect(grid.nth(0)).toHaveText('2026-09-15');
    await expect(grid.nth(1)).toHaveText('330.18');
    await expect(grid.nth(5)).toHaveText('17,504,609');
    await expect(kvRow(page, 'p1', 'Bars').getByRole('cell')).toContainText('244');
    await expect(kvRow(page, 'p1', 'High').getByRole('cell')).toContainText('344.57');
    await expect(kvRow(page, 'p1', 'From').getByRole('cell')).toContainText('2025-09-25');

    // Every cell of the grid cites something, and the price columns cite a real entry — the bars
    // came from `yahoo.chart`, the `date` and `adjFactor` columns are the screen's own and carry
    // `-1` by design (`screens/HP/Screen.tsx#rowsOf`).
    const citations = await grid.evaluateAll((cells) => ({
      total: cells.length,
      attributed: cells.filter((c) => c.hasAttribute('data-prov-idx')).length,
      cited: cells.filter((c) => Number(c.getAttribute('data-prov-idx')) >= 0).length,
    }));
    expect(citations.total, 'HP drew no grid').toBeGreaterThan(0);
    expect(citations.attributed, 'grid cells with no `data-prov-idx`').toBe(citations.total);
    expect(citations.cited, 'no grid cell cites a provenance entry').toBeGreaterThan(0);
    await grid.nth(1).focus();
    await grid.nth(1).press('Control+i');
    await expect(p1.getByRole('dialog', { name: 'Provenance' })).toContainText('yahoo.chart');
  });

  test('a security on its own re-runs the panel’s function for it (TERM-03)', async ({ page }) => {
    await openTerminal(page);

    // The panel is put on DES with a DIFFERENT company first, so that "it shows Apple" at the end
    // cannot be the seeded workspace or a leftover: p1 restores as WEI, and this replaces it.
    await go(page, 'p1', 'MSFT US Equity DES');
    const p1 = panelOf(page, 'p1');
    await expect(p1).toContainText('DES · MSFT US Equity · Microsoft Corp', { timeout: 20_000 });
    // `sec.submissions`' CIK for Microsoft, so the screen is reading the security master and not
    // echoing the ticker that was typed.
    await expect(kvRow(page, 'p1', 'CIK').getByRole('cell')).toContainText('0000789019');

    // No function typed. The panel keeps DES and runs it for the new security (§2.5 row 2).
    await go(page, 'p1', 'AAPL US Equity');

    await expect(p1).toContainText('DES · AAPL US Equity · Apple Inc', { timeout: 20_000 });
    await expect(p1).not.toContainText('Microsoft Corp');
    await expect(kvRow(page, 'p1', 'CIK').getByRole('cell')).toContainText('0000320193');
    // The function survived, with the seeded quote under it: this is DES, not the `DES` fallback
    // that §2.5 would have used had the panel lost its function — those are the same code here, so
    // the value below is what makes the assertion mean something.
    await expect(kvRow(page, 'p1', 'Last').getByRole('cell')).toContainText('330.27');
    await expect(headerOf(page, 'p1')).toContainText('DES');
  });

  test('GO runs the typed text, not the row the popup happens to have first (TERM-01)', async ({
    page,
  }) => {
    await openTerminal(page);
    await goHolding(page, 'p1', 'AAPL US Equity DES', 'AAPL US Equity');
    const p1 = panelOf(page, 'p1');
    await expect(p1).toContainText('DES · AAPL US Equity · Apple Inc', { timeout: 20_000 });

    const input = commandLine(page, 'p1');
    const popup = page.locator('#ac-p1');

    // Nine characters of a company name. The popup opens with `MSFT US Equity` first — and nothing
    // is highlighted, which is the invariant: `aria-expanded` is true while `aria-activedescendant`
    // is absent, because a combobox with no active row must not announce one (WAI-ARIA 1.2).
    await input.click();
    await input.pressSequentially('MICROSOFT', { delay: 60 });
    await expect(popup).toBeVisible();
    const rows = popup.getByRole('option');
    await expect(rows.first()).toContainText('MSFT US Equity');
    await expect(rows.first()).toContainText('Microsoft Corp');
    await expect(rows.first()).toHaveAttribute('aria-selected', 'false');
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(await input.getAttribute('aria-activedescendant')).toBeNull();

    // GO. The typed text is what runs, so this is refused — `MICROSOFT` has the shape of an
    // identifier and fails its check digit — and §2.5's "a command that cannot run is not sent"
    // means no function run leaves the browser at all.
    let runsAfterGo = 0;
    page.on('request', (req) => {
      if (/\/api\/v1\/functions\/[A-Z]+\/run$/.test(req.url())) runsAfterGo += 1;
    });
    await input.press('Enter');
    await expect(page.locator('#cmd-problem-p1')).toContainText('BAD_IDENTIFIER');
    await expect(page.locator('#cmd-problem-p1')).toContainText('MICROSOFT');
    // The panel is untouched: still Apple's DES, with its price. Had GO executed row 0, this would
    // be Microsoft — which is exactly what the pre-part-1 shell did.
    await expect(p1).toContainText('DES · AAPL US Equity · Apple Inc');
    await expect(kvRow(page, 'p1', 'Last').getByRole('cell')).toContainText('330.27');
    await expect(p1).not.toContainText('Microsoft Corp');
    expect(runsAfterGo, 'a refused command was sent to the plant').toBe(0);

    // And the other half of the contract, so that "nothing was run" is not satisfied by a popup
    // whose rows do nothing: ArrowDown adopts row 0 — the input announces it as the active
    // descendant — and GO then runs it. `MSFT US Equity` on its own is a security, so the panel
    // keeps DES and re-runs it (§2.5 row 2), which is Microsoft's DES.
    await input.click();
    await input.pressSequentially('MICROSOFT', { delay: 60 });
    await expect(popup).toBeVisible();
    await input.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', 'ac-p1-opt-0');
    await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
    await input.press('Enter');

    await expect(p1).toContainText('DES · MSFT US Equity · Microsoft Corp', { timeout: 20_000 });
    await expect(kvRow(page, 'p1', 'CIK').getByRole('cell')).toContainText('0000789019');
  });

  /* ------------------------------------------------------------------------------------------ */
  /* The launch budget — CLIENT §16.1 row 3, which names THIS file as its measurer                */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * REQUIREMENTS L306 / ARCHITECTURE L630 / CLIENT §16.1: Tier-1 function launch **to first paint**,
   * < 500 ms p95. CLIENT §16.1 names `e2e/command-line.spec.ts` as the place it is checked; nothing
   * checked it, here or anywhere, and `packages/e2e/tests/perf.spec.ts` — which TESTING §17
   * L953/L955 names for the keystroke and launch budgets — does not exist.
   *
   * Two measurements below, because they are two different quantities and only one of them is the
   * requirement:
   *
   *  1. **`go → first paint`, measured in the browser.** The budgeted quantity, from the `keydown`
   *     that carries `<GO>` to the animation frame on which the result is on screen. This is the
   *     guard.
   *  2. **`go → payload`, read from the plant.** `command/dispatch.ts` L528 times `sdk.fn.run` and
   *     posts it as `fn.launch`; `routes/status.ts` L306-313 answers `percentile_cont(0.95)` over
   *     `usage_events.duration_ms` per code for the last hour. It is a real measurement of a real
   *     thing, and it is NOT this budget: it stops at the payload, and its hour-long window pools
   *     every launch shape, including the four-at-once of a workspace restore. Measured across
   *     three runs of this suite, WEI's figure there was 491.9 ms (n=24), 641.8 ms (n=22) and
   *     589.5 ms (n=31, the auditor's), while WEI's go → first paint launched on its own is
   *     430-450 ms. The spread is the restore's concurrency, not the code getting slower. So this
   *     one is asserted where it is stable and PRINTED where it is not, and the requirement rests
   *     on the browser measurement above it.
   */
  const LAUNCH_BUDGET_MS = 500;

  /** `GET /api/v1/status` → `timings.fnLaunchP95Ms`, `{ [code]: p95 }` over the last hour. */
  async function launchP95(page: Page): Promise<Record<string, number>> {
    const res = await page.request.get('/api/v1/status');
    expect(res.status(), 'GET /api/v1/status').toBe(200);
    const body = (await res.json()) as { timings: { fnLaunchP95Ms: Record<string, number> } };
    return body.timings.fnLaunchP95Ms;
  }

  /**
   * Arm a probe that times `<GO>` → the frame on which `needle` is on `panelId`'s screen.
   *
   * The two instants are the product's own: the `keydown` the command line is about to run `go`
   * from, captured on the input itself, and the `requestAnimationFrame` after the mutation that put
   * the result's own text in the panel. `needle` must be text only the FINISHED screen has — a
   * skeleton must not stop the clock — and the probe only arms when the needle is absent, so a
   * launch cannot be timed against the previous launch's screen still being up.
   */
  async function armLaunchProbe(page: Page, panelId: string, needle: string): Promise<void> {
    await page.evaluate(
      ({ panelId: id, needle: text }: { panelId: string; needle: string }) => {
        const w = window as unknown as { __launch: number[] };
        w.__launch = [];
        const root = document.querySelector(`[data-panel="${id}"]`);
        const input = root?.querySelector('[data-testid="command-line"]');
        if (root === null || input === null || input === undefined) throw new Error(`no ${id}`);
        let started: number | null = null;
        input.addEventListener(
          'keydown',
          (event) => {
            if ((event as KeyboardEvent).key !== 'Enter') return;
            started = (root.textContent ?? '').includes(text) ? null : performance.now();
          },
          true,
        );
        new MutationObserver(() => {
          if (started === null || !(root.textContent ?? '').includes(text)) return;
          const from = started;
          started = null;
          requestAnimationFrame(() => w.__launch.push(performance.now() - from));
        }).observe(root, { subtree: true, childList: true, characterData: true });
      },
      { panelId, needle },
    );
  }

  /** What the probe collected, sorted, with its p95. */
  async function launchSamples(page: Page): Promise<{ sorted: number[]; p95: number }> {
    const samples = await page.evaluate(
      () => (window as unknown as { __launch: number[] }).__launch,
    );
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] ?? 0;
    return { sorted, p95 };
  }

  test('WEI — the first screen of every seeded workspace — paints inside 500 ms (NFR)', async ({
    page,
  }) => {
    await openTerminal(page);

    // WEI is `p1` of all seven seeded workspaces and the heaviest Tier-1 code in the build: it
    // resolves 31 index instruments and their quotes, sessions and returns in one run. If any
    // Tier-1 launch is going to miss the budget it is this one, which is why it is the one measured
    // here. `31 rows` is WEI's own count of the seeded index universe, so a skeleton cannot stop
    // the clock; `TOP` is launched between samples to take that text off the panel.
    await armLaunchProbe(page, 'p2', '31 rows');
    for (let i = 0; i < 6; i += 1) {
      await go(page, 'p2', 'WEI');
      await expect(panelOf(page, 'p2')).toContainText('31 rows', { timeout: 30_000 });
      await go(page, 'p2', 'TOP');
      await expect(panelOf(page, 'p2')).toContainText('30 headlines', { timeout: 30_000 });
    }

    const { sorted, p95 } = await launchSamples(page);
    const line =
      `WEI go → first paint: n=${String(sorted.length)} ` +
      sorted.map((ms) => ms.toFixed(0)).join('/') +
      ` ms · p95 ${p95.toFixed(1)} ms (budget ${String(LAUNCH_BUDGET_MS)})`;
    console.log(line);

    // The sample set first: a percentile over three numbers is not a percentile, and a probe that
    // silently stopped recording would otherwise report a flawless p95 over nothing.
    expect(sorted.length, `only ${String(sorted.length)} launches were measured`).toBeGreaterThanOrEqual(
      5,
    );
    expect(Math.min(...sorted), `a launch that took no time is a probe fault: ${line}`).toBeGreaterThan(
      20,
    );
    expect(p95, line).toBeLessThanOrEqual(LAUNCH_BUDGET_MS);
  });

  test('the plant publishes the launch timing it measures, and it agrees (OPS-03)', async ({
    page,
  }) => {
    await openTerminal(page);
    // Four Tier-1 launches. Every command names its security explicitly rather than relying on the
    // panel to carry one: `HP` on its own is BOTH a Tier-1 code and a seeded ticker (Helmerich &
    // Payne), and which of the two the parser picks depends on whether the universe index has
    // finished building — measured here as `DES · HP US Equity · Helmerich and Payne Inc`. That
    // ambiguity is the subject of the function-only test above; it has no business deciding a
    // timing sample.
    for (const command of [
      'AAPL US Equity DES',
      'AAPL US Equity HP',
      'MSFT US Equity DES',
      'SPX Index GP',
    ]) {
      await go(page, 'p1', command);
      await expect(panelOf(page, 'p1'), command).toContainText(
        `${command.split(' ').slice(-1)[0] ?? ''} ·`,
        { timeout: 30_000 },
      );
    }

    // `toPass`, because the usage event is posted after the payload and the p95 is a query over the
    // rows it lands in: reading the route the instant the last screen painted is reading it too
    // early. This is the only wait in the test and it is on the DATA, not on a clock.
    let p95: Record<string, number> = {};
    await expect(async () => {
      p95 = await launchP95(page);
      for (const code of ['DES', 'HP', 'GP']) {
        expect(p95[code], `${code} was launched but the plant has no p95 for it`).toBeGreaterThan(0);
      }
    }).toPass({ timeout: 30_000 });

    console.log(
      'fn.launch p95, go → payload (ms): ' +
        Object.entries(p95)
          .map(([code, ms]) => `${code}=${ms.toFixed(1)}`)
          .join(' '),
    );

    // The channel carries something real — `autocompleteP95Ms` and `historyP95Ms` in the same
    // object are hard-coded zeros (that route's header says so, and `autocomplete.spec.ts` records
    // it), so a spec that asserted `<= 500` without the lines above would pass just as happily
    // against a placeholder.
    expect(Object.keys(p95).length, 'the plant reported no launch timings').toBeGreaterThan(0);

    // And the budget, over the codes this figure is stable for. WEI is not one of them and is not
    // silently dropped: its aggregate pools the four-at-once launches of every workspace restore in
    // the last hour, which is a different quantity from a single launch, and its actual budgeted
    // quantity — go → first paint — is asserted by the test above. See this section's docstring for
    // the three measurements that establish that.
    const over = Object.entries(p95)
      .filter(([code, ms]) => code !== 'WEI' && ms > LAUNCH_BUDGET_MS)
      .map(([code, ms]) => `${code} ${ms.toFixed(1)} ms`);
    expect(over, `launch p95 over ${String(LAUNCH_BUDGET_MS)} ms`).toEqual([]);
  });
});
