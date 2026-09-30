// packages/e2e/tests/panels.spec.ts — TERM-04 and TERM-05 (WORKPLAN WP-15: "four panels,
// back-stack, workspace persistence").
//
// ## Why this spec runs as `analyst` and resets first
//
// `fixtures/auth.ts` allocates `analyst@demo.terminal` to this file because everything here MUTATES
// the layout: it launches functions into panels, changes the layout mode, moves focus and reloads.
// The database is provisioned once per run, the shell autosaves (`Shell.tsx`'s debounce, plus a
// flush on `pagehide`), and a spec that handed its rearranged desk to the next one would make spec
// order part of every other result. `resetWorkspace` puts the seeded layout back before each test.
//
// ## The three claims, and the data that decides each one
//
//   * **Four panels (TERM-04)** — four frame stacks, four command lines, one focus. Proved by the
//     four DIFFERENT screens the seeded workspace restores into, each with its own numbers, and by
//     running a command in one panel and finding the other three exactly as they were. "Four panels
//     are visible" would pass against an empty database; `31 rows`, `30 headlines`, `7,585.75` and
//     the five-name `Core` watchlist the layout names, with AAPL at `330.27` in it, would not.
//   * **The back-stack (TERM-04, §2.5 L786)** — Back returns the EARLIER SCREEN WITH ITS VALUES
//     (Apple's `330.27`, then HP's first bar), Forward returns, and a new launch from a back
//     position truncates the forward history rather than leaving a screen the user can walk into.
//     The header's `◀`/`▶` are what the test clicks: `Alt+←` is the documented chord, but the
//     window keyboard dispatcher is built and never attached (BUILD_STATUS.md), so today those keys
//     are dead and the buttons — which `Panel.tsx` added for exactly this reason — are the only
//     path. Asserting the dead chord would be asserting a plan; asserting the buttons is the
//     product.
//   * **Persistence (TERM-05)** — set the desk up, RELOAD, and it comes back: the layout mode, the
//     focused panel, the panel's function and security with its data, and the command history the
//     recall walks. A persistence test that never reloads is a test of a store.
//
// The last test is the regression test for TERM-05's second loss: a restored panel comes back with
// the PARAMETERS it was saved with. It was a `test.fail` for one work package — the restore re-ran
// each frame as the command string `"<security> <fn>"`, and `params` is not in that string — and the
// measurement it recorded is kept in its docstring, because the assertion only means something if
// you can see what it used to report.
//
// A second persistence defect is NOT a test here, deliberately. `Shell.tsx` flushes the workspace
// on `pagehide` so that a desk rearranged and then closed is not lost, and that flush is an
// ordinary `fetch` with no `keepalive` (`grep -rn "keepalive\|sendBeacon" packages/` returns
// nothing), so the navigation usually kills it: a `/layout 2v` followed immediately by a reload
// came back as `4` in 5 of 6 runs, and survived in the sixth. A test that fails five times out of
// six is a flake whichever way it is written, so it is reported as a finding and `savedLayout`
// below keeps it from deciding the test that follows.

import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { E2E_USERS, storageStatePath } from '../fixtures/auth.js';
import { resetWorkspace } from '../fixtures/database.js';

// Not `pm`: see the header. `playwright.config.ts` points `use.storageState` at `pm`, and
// `globalSetup` has minted this one too.
test.use({ storageState: storageStatePath('analyst') });

const panelOf = (page: Page, panelId: string): Locator => page.locator(`[data-panel="${panelId}"]`);

const commandLine = (page: Page, panelId: string): Locator =>
  panelOf(page, panelId).locator('[data-testid="command-line"]');

/**
 * One grid cell, addressed the way `LiveGrid` publishes it: `data-row-id` × `data-col`.
 *
 * `expectUntouched` used to read its numbers off the panel as a whole, which cannot tell "AAPL is
 * at 330.27" from "330.27 appears somewhere on a screen that also lists AAPL" — and on a watchlist
 * where 24 of 25 rows are em dashes, that difference is the whole assertion.
 */
const cellOf = (page: Page, panelId: string, rowId: string, col: string): Locator =>
  panelOf(page, panelId).locator(
    `[role="row"][data-row-id="${rowId}"] [role="gridcell"][data-col="${col}"]`,
  );

/** `◀` / `▶` in the panel header (`Panel.tsx`), named per panel ordinal. */
const backButton = (page: Page, ordinal: number): Locator =>
  page.getByRole('button', { name: `Back in panel ${String(ordinal)}` });
const forwardButton = (page: Page, ordinal: number): Locator =>
  page.getByRole('button', { name: `Forward in panel ${String(ordinal)}` });

/**
 * The seeded four-panel workspace, restored and finished running.
 *
 * Every panel is waited on by CONTENT rather than by a timer: each title line only appears once
 * `POST /api/v1/functions/<code>/run` has answered for that panel.
 */
async function openTerminal(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
  await expect(panelOf(page, 'p1'), 'p1').toContainText('WEI ·', { timeout: 30_000 });
  await expect(panelOf(page, 'p2'), 'p2').toContainText('TOP ·', { timeout: 30_000 });
  await expect(panelOf(page, 'p3'), 'p3').toContainText('GP · SPX Index', { timeout: 30_000 });
  // `W · Core`, not the looser `W ·`: the seeded layout names `Core` in `params.watchlist`, and the
  // restore now sends the frame's own params, so the FIRST load already shows the right list. While
  // the restore went through the command line this read `W · <the person's default list>`.
  await expect(panelOf(page, 'p4'), 'p4').toContainText('W · Core', { timeout: 30_000 });
}

/** Type into one panel's command line and press GO — the same path `command-line.spec.ts` uses. */
async function go(page: Page, panelId: string, command: string): Promise<void> {
  const input = commandLine(page, panelId);
  await input.click();
  await input.pressSequentially(command, { delay: 10 });
  await input.press('Enter');
}

/**
 * Wait until the autosave has PUT a layout that actually contains `mode` and `focus`, and the plant
 * has acknowledged it with a 200.
 *
 * Not a sleep, and not "any PUT": the predicate reads the REQUEST BODY (`state/workspace.ts#saveNow`
 * sends `{ version, layout }`), so a save that was already in flight when the test changed
 * something cannot satisfy it. That precision is needed because the workspace is saved on a 2 s
 * debounce and the page load itself dirties it — without this the reload below would be racing an
 * unrelated save and the test would pass or fail by machine speed.
 *
 * It is also why the reload tests do not simply reload: the flush on `pagehide` does not reliably
 * cover this window (see the note in this file's header), and a test that reloaded inside it would
 * be reporting that defect instead of the one it is about.
 */
async function savedLayout(page: Page, mode: string, focus: string): Promise<void> {
  await page.waitForResponse(
    (res) => {
      if (!res.url().endsWith('/api/v1/workspace') || res.request().method() !== 'PUT') return false;
      const body = res.request().postDataJSON() as
        | { layout?: { mode?: string; focus?: string } }
        | null;
      return res.status() === 200 && body?.layout?.mode === mode && body.layout.focus === focus;
    },
    { timeout: 20_000 },
  );
}

/**
 * What `analyst@demo.terminal`'s three untouched panels must be showing, with the source of each
 * number. Re-checked after a command runs in a FOURTH panel, which is how "one panel moved and the
 * others did not" is stated in data rather than in geometry.
 */
async function expectUntouched(page: Page, panelIds: readonly string[]): Promise<void> {
  for (const id of panelIds) {
    const panel = panelOf(page, id);
    switch (id) {
      case 'p1':
        // 31 seeded index instruments across the three regions (seed module 5) — and the two of
        // them that carry a recorded level. The count alone was not enough: the screen itself
        // reports "28 indices pending — no recorded quote", so a WEI whose every cell had gone to
        // an em dash still said `31 rows`. VIX and the Cboe UK 100 are the rows with numbers, from
        // two different polls, and `cellOf` addresses them by id rather than by substring.
        await expect(panel, 'p1 · WEI').toContainText('WEI · World Equity Indices');
        await expect(panel).toContainText('31 rows');
        await expect(cellOf(page, id, 'wei:VIX', 'PX_LAST'), 'p1 · VIX').toContainText('17.50');
        await expect(cellOf(page, id, 'wei:BUK100P', 'PX_LAST'), 'p1 · BUK100P').toContainText(
          '1,059.46',
        );
        break;
      case 'p2':
        // TOP's 30-headline page out of the 160 seeded news items (module 11), and one of those
        // headlines by its text: thirty empty rows would satisfy the count.
        await expect(panel, 'p2 · TOP').toContainText('TOP · Top News');
        await expect(panel).toContainText('30 headlines');
        await expect(panel, 'p2 · a seeded headline').toContainText(
          'Trump’s Kennedy Center Board Votes to Close Facility for Repairs',
        );
        break;
      case 'p3':
        // The index's seeded level, through the client's own `px` formatter (hence the comma) —
        // AND the chart host's box, because the kv row this clause reads sits BESIDE the canvas
        // and not on it. Measured before `widgets.css` gave the host a height: `.chart-host`
        // 635 × 0 with a canvas sized 635 × 1, and this clause green throughout. SPX has no daily
        // bars to plot (`smoke.spec.ts` carries that finding); what is asserted here is that the
        // canvas is a canvas and not a collapsed div.
        await expect(panel, 'p3 · GP').toContainText('GP · SPX Index · S&P 500');
        await expect(panel).toContainText('7,585.75');
        await expect(panel.locator('.chart-host')).toHaveAttribute('data-chart-state', 'drawn');
        expect(
          (await panel.locator('.chart-host').boundingBox())?.height ?? 0,
          'p3 · the chart host has collapsed to nothing',
        ).toBeGreaterThan(40);
        break;
      case 'p4':
        // `Core`, with its five names — the list the seeded LAYOUT names in `params.watchlist`
        // (`fixtures/seed/workspaces.json`, seed module 13), shared to the firm by Alex Pardo and so
        // visible to Jane Ruiz. This clause used to read `25 rows`, which was `S&P 500 Top 25`:
        // Jane's OWN default list, drawn because the restore dropped the frame's params and ran the
        // bare `W`. AAPL is in both lists, which is why only the count and the reason change here.
        // Its last comes from the recorded Cboe poll; `row:85` is its instrument id, so this states
        // that the price is on APPLE'S ROW rather than merely somewhere on the screen.
        await expect(panel, 'p4 · W').toContainText('W · Core');
        await expect(panel).toContainText('5 rows');
        await expect(cellOf(page, id, 'row:85', 'key'), 'p4 · AAPL').toHaveText('AAPL US Equity');
        await expect(cellOf(page, id, 'row:85', 'PX_LAST'), 'p4 · AAPL last').toContainText(
          '330.27',
        );
        await expect(cellOf(page, id, 'row:85', 'CHG_PCT_1D'), 'p4 · AAPL chg').toContainText(
          '-0.84%',
        );
        break;
      default:
        throw new Error(`no expectation written for ${id}`);
    }
  }
}

test.describe('WP-15 — panels, the back-stack and the workspace (TERM-04, TERM-05)', () => {
  test.beforeEach(async () => {
    await resetWorkspace(E2E_USERS.analyst.email);
  });

  test('four panels, four frame stacks, and one of them has the keyboard (TERM-04)', async ({
    page,
  }) => {
    await openTerminal(page);

    // `workspaces.layout.mode` is `4`, and `PanelGrid` publishes it.
    await expect(page.getByTestId('panel-grid')).toHaveAttribute('data-layout', '4');
    await expect(page.locator('[data-panel]')).toHaveCount(4);
    // One command line PER panel — the unit of the terminal is the panel, not the window.
    await expect(page.locator('[data-testid="command-line"]')).toHaveCount(4);
    for (const [index, id] of ['p1', 'p2', 'p3', 'p4'].entries()) {
      await expect(page.getByRole('combobox', { name: `Command line ${id}` })).toBeVisible();
      await expect(panelOf(page, id)).toHaveAttribute('aria-label', `Panel ${String(index + 1)}`);
    }

    // Four different functions, each with its own data.
    await expectUntouched(page, ['p1', 'p2', 'p3', 'p4']);

    // Focus is single and visible: clicking into p3's command line moves the ring there, and
    // `aria-current` says so for a screen reader (TERM-04's "where does the next keystroke go?").
    await commandLine(page, 'p3').click();
    await expect(panelOf(page, 'p3')).toHaveAttribute('data-focused', 'true');
    await expect(panelOf(page, 'p3')).toHaveAttribute('aria-current', 'true');
    for (const id of ['p1', 'p2', 'p4']) {
      await expect(panelOf(page, id), `${id} kept the focus ring`).toHaveAttribute(
        'data-focused',
        'false',
      );
    }

    // A command goes to the panel it was typed in, and to no other. p3 stops being a chart of the
    // S&P and becomes Apple's DES; the other three are re-checked value by value.
    await go(page, 'p3', 'AAPL US Equity DES');
    await expect(panelOf(page, 'p3')).toContainText('DES · AAPL US Equity · Apple Inc', {
      timeout: 20_000,
    });
    await expect(panelOf(page, 'p3')).not.toContainText('GP · SPX Index');
    await expectUntouched(page, ['p1', 'p2', 'p4']);
  });

  test('back and forward walk one panel’s frames, and a new launch truncates them (TERM-04)', async ({
    page,
  }) => {
    await openTerminal(page);

    await go(page, 'p2', 'AAPL US Equity DES');
    await expect(panelOf(page, 'p2')).toContainText('DES · AAPL US Equity · Apple Inc', {
      timeout: 20_000,
    });
    await go(page, 'p2', 'AAPL US Equity HP');
    await expect(panelOf(page, 'p2')).toContainText('HP · AAPL US Equity · Apple Inc', {
      timeout: 20_000,
    });
    // The last bar of the capture, not the bar COUNT: `HP`'s `1Y` window is measured from now, so a
    // literal count is a test that rots on the calendar (it read 244 when this file was written and
    // 242 four days later). `2026-09-15` is the newest bar in `yahoo-chart-events.json` and does not
    // move, and it is the better assertion anyway — it says the panel really ran HP over the seeded
    // history rather than that some three-digit number appeared somewhere in the panel.
    await expect(panelOf(page, 'p2')).toContainText('2026-09-15');

    // Back. The earlier screen returns WITH THE VALUES IT HAD — the frame keeps its payload, so
    // this is the DES the user saw, not a fresh run that happens to look like it.
    await expect(forwardButton(page, 2), 'nothing to go forward to yet').toBeDisabled();
    await backButton(page, 2).click();
    await expect(panelOf(page, 'p2')).toContainText('DES · AAPL US Equity · Apple Inc');
    await expect(panelOf(page, 'p2')).toContainText('330.27');
    await expect(panelOf(page, 'p2')).not.toContainText('HP · AAPL');
    await expect(forwardButton(page, 2), 'Forward is now available').toBeEnabled();

    // The stacks are per panel: walking p2's history moved nothing in p1, whose own Forward is
    // still empty and whose screen is still WEI.
    await expect(forwardButton(page, 1)).toBeDisabled();
    await expectUntouched(page, ['p1', 'p3', 'p4']);

    // Forward returns to HP, with its bars.
    await forwardButton(page, 2).click();
    await expect(panelOf(page, 'p2')).toContainText('HP · AAPL US Equity · Apple Inc');
    await expect(panelOf(page, 'p2').locator('[role="gridcell"]').nth(1)).toHaveText('330.18');

    // §2.5 L786: a launch from anywhere but the top truncates the forward history. Go back to DES
    // and launch something else — the HP frame must be gone, not parked one `▶` away.
    await backButton(page, 2).click();
    await expect(panelOf(page, 'p2')).toContainText('DES · AAPL US Equity · Apple Inc');
    await go(page, 'p2', 'MSFT US Equity DES');
    await expect(panelOf(page, 'p2')).toContainText('DES · MSFT US Equity · Microsoft Corp', {
      timeout: 20_000,
    });
    // What is behind the new frame is the frame it was launched FROM — Apple's DES — and what is
    // in front of it is the new frame itself. The HP screen that used to sit between them is gone.
    // Both steps matter: `canGoForward` is `index < length - 1` and a launch always lands on the
    // top, so "Forward is disabled" would be true whether the stack was truncated or not; walking
    // it is what tells the two apart. Without the truncation of §2.5 L786 these two clicks land on
    // HP twice.
    await backButton(page, 2).click();
    await expect(panelOf(page, 'p2')).toContainText('DES · AAPL US Equity · Apple Inc');
    await expect(panelOf(page, 'p2')).toContainText('330.27');
    await forwardButton(page, 2).click();
    await expect(panelOf(page, 'p2')).toContainText('DES · MSFT US Equity · Microsoft Corp');
    await expect(panelOf(page, 'p2'), 'the truncated HP frame is still reachable').not.toContainText(
      'HP · AAPL',
    );
  });

  test('the desk comes back after a reload: layout, focus, screen and history (TERM-05)', async ({
    page,
  }) => {
    await openTerminal(page);

    // Three different kinds of state, so that "it came back" is not one lucky field:
    //   1. a panel's frame — a function on a security, with a payload behind it;
    //   2. the layout mode, through the shell command that sets it (§2.6);
    //   3. the focused panel, moved by `/panel` from a DIFFERENT panel's command line, so that
    //      focus is not merely "wherever the caret last was".
    await go(page, 'p2', 'AAPL US Equity DES');
    await expect(panelOf(page, 'p2')).toContainText('DES · AAPL US Equity · Apple Inc', {
      timeout: 20_000,
    });
    await go(page, 'p1', '/layout 2v');
    await expect(page.getByTestId('panel-grid')).toHaveAttribute('data-layout', '2v');
    await expect(page.locator('[data-panel]')).toHaveCount(2);
    // Registered before the last change and awaited after it, so the save this waits for is the one
    // that carries BOTH: `{ layout: { mode: '2v', focus: 'p2', panels: [...] } }`.
    const saved = savedLayout(page, '2v', 'p2');
    await go(page, 'p1', '/panel 2');
    await expect(panelOf(page, 'p2')).toHaveAttribute('data-focused', 'true');
    await saved;

    // The line the whole test is about — without it nothing has been persisted or restored at all.
    await page.reload();
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });

    await expect(page.getByTestId('panel-grid'), 'the layout mode').toHaveAttribute(
      'data-layout',
      '2v',
    );
    await expect(page.locator('[data-panel]')).toHaveCount(2);
    await expect(panelOf(page, 'p2'), 'the focused panel').toHaveAttribute('data-focused', 'true');
    await expect(panelOf(page, 'p1')).toHaveAttribute('data-focused', 'false');

    // The panel's own screen, re-run from the restored frame and carrying the seeded quote again —
    // `App.tsx#onRestored`. p1 is still the workspace's WEI, so the restore was of the layout and
    // not of one panel.
    await expect(panelOf(page, 'p2')).toContainText('DES · AAPL US Equity · Apple Inc', {
      timeout: 30_000,
    });
    await expect(panelOf(page, 'p2')).toContainText('330.27');
    await expect(panelOf(page, 'p1')).toContainText('WEI · World Equity Indices');

    // `PanelState.history` came back too: ArrowUp on an empty draft walks the panel's own commands,
    // most recent first (CLIENT §4.4), and the most recent is what this browser typed before the
    // reload. A history that had not persisted would leave the input empty.
    const input = commandLine(page, 'p2');
    await input.click();
    await input.press('ArrowUp');
    await expect(input).toHaveValue('AAPL US Equity DES');
  });

  // ── The regression test for the defect this file used to record ─────────────────────────────
  //
  // **A restored panel comes back with the parameters it was saved with.**
  //
  // This was a `test.fail` for one work package, and what it reported is worth keeping: the restore
  // re-ran each frame as the COMMAND STRING `"<security display> <fn>"`. A frame is five fields
  // (CLIENT §8 L574-577) and `params` is one of them; that string carried two. So a panel came back
  // running the same function on the manifest's defaults instead of on the parameters it was saved
  // with. Measured then on `analyst@demo.terminal`'s p4: with `W Core` launched by hand the panel
  // showed `W · Core`, `5 rows` and the frame was persisted as
  //   { fn: "W", params: { view: "grid", watchlist: { name: "Core" } }, security: null }
  // and after a reload the same panel showed `W · S&P 500 Top 25`, `25 rows` — Jane Ruiz's own list,
  // because the re-run command was the bare `W`.
  //
  // `App.tsx#onRestored` now re-runs the frame through `command/dispatch.ts#executeFrame`, which
  // sends the frame's own fields and never builds a command line. It was the same line as the
  // defect `smoke.spec.ts` recorded (a restored GP losing its instrument) and a different loss:
  // that one was the security, this one the params. TERM-05.
  //
  // The list this test sets is `MAG7` and not the seeded `Core`, deliberately: `MAG7` is neither
  // what the layout ships with nor what `W` falls back to for this person, so the only way it can be
  // on the screen after a reload is that the params made the round trip. Its own columns prove it
  // too — `Core` has no market-cap column.
  test('a restored panel comes back with the parameters it was saved with (TERM-05)', async ({
    page,
  }) => {
    await openTerminal(page);

    // `MAG7` is Alex Pardo's list, shared to the firm, so Jane Ruiz can open it (SEC-05: a
    // firm-shared list is visible inside the firm). The panel shows it when asked.
    const saved = savedLayout(page, '4', 'p4');
    await go(page, 'p4', 'W MAG7');
    await expect(panelOf(page, 'p4')).toContainText('W · MAG7', { timeout: 20_000 });
    await expect(panelOf(page, 'p4')).toContainText('7 rows');
    // Wait for the save that carries this panel, so that what the reload tests is the PARAMS and not
    // the flush defect this file's header describes.
    await saved;

    await page.reload();
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });

    // The assertion TERM-05 asks for: the same list, and it is the person's own default list that
    // used to be here. Not spelled as `not.toContainText('S&P 500 Top 25')` — `W`'s own list picker
    // names every watchlist this person can open, so that string is on the screen either way; the
    // header, the count and the columns below are what tell the two lists apart.
    await expect(panelOf(page, 'p4')).toContainText('W · MAG7', { timeout: 30_000 });
    await expect(panelOf(page, 'p4')).toContainText('7 rows');
    // The columns come with the list (`watchlists.columns`, seed module 13): `MAG7` carries volume
    // and market cap, `Core` carries neither — so this is the restored list's own definition and not
    // only its title. And a row count is not a value: AAPL's last comes from the recorded Cboe poll
    // and `row:85` is its instrument id, so the number is on APPLE'S ROW of the list that came back.
    await expect(panelOf(page, 'p4').locator('[role="columnheader"]')).toHaveText([
      'Security',
      'Name',
      'Last price',
      'Percent change',
      'Volume',
      'Market capitalisation',
    ]);
    await expect(cellOf(page, 'p4', 'row:85', 'PX_LAST'), 'p4 · AAPL last').toContainText('330.27');
  });
});
