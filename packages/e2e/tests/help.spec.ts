// packages/e2e/tests/help.spec.ts — TERM-09 (WORKPLAN §WP-15, FUNCTIONS.md §4 L989-1010,
// CLIENT.md §5.2, §15 L1166-1169).
//
// "HELP once explains, twice opens a ticket."
//
// Both halves are asserted here, and so is the third thing, which is the one that decides whether
// the ticket is worth opening: that it carries THE SCREEN THE USER WAS ON. A ticket saying only
// "somebody pressed HELP twice" costs the desk a round of "what were you looking at?"; FUNCTIONS §4
// answers that by attaching the panel, the function, the params, the trace id and every visible
// value with its provenance index, so the desk can rebuild the exact screen — same as-of, same
// sources, same numbers. That harvest is done from the DOM by
// `shell/TicketDialog.tsx#collectScreenState`, which is why it can only be checked from a browser,
// and why this file checks it by harvesting the same DOM independently and comparing the two.
//
// **That third clause does not hold, and the failing test near the end of this file is why.**
// Opening the HELP overlay makes the terminal re-load the workspace and re-run every panel, so by
// the time the ticket is composed the screen the user asked about is gone and the ticket describes
// the restored one. The mechanism is in that test's comment; the two green tests above it are
// written so that they say what IS true without leaning on what is not.
//
// ## Why the command line and not `F1`
//
// TERM-09 is a key, and the key is not bound: the window-level keyboard dispatcher is complete and
// tested (`keyboard/dispatcher.ts`) but not attached, because four members of its `KeyboardHost`
// need the focus model `Panel.tsx` keeps in local state — `App.tsx` L52-69 sets this out. The
// TRANSITION, though, is the same function either way: `App.tsx#onHelp` calls
// `dispatcher.ts#nextHelpEffect`, so `HELP` typed twice inside ten seconds drives the identical
// state machine `F1` pressed twice would. That is what this file drives. If `F1` is ever bound at
// the window, the right change here is to add a case, not to replace one.
//
// ## What is measured, not assumed
//
// Driven against the seeded database as `pm@demo.terminal`:
//
//   * `AAPL US Equity HP 1M` then `HELP` → `GET /api/v1/help/HP` 200, and `role="dialog"`
//     `aria-label="Help · HP"` carrying HP's own summary and parameter list.
//   * `HELP` again → `aria-label="Open a helpdesk ticket"`, pre-filled with the panel, the
//     function, the params and "N values with provenance".
//   * `GO` posts `/api/v1/help/tickets` and the plant answers `201 {"ticketId":1,"roomId":3}`.
//
// Nothing here imports package source (WORKPLAN §1.2).

import type { Page, Request } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { E2E_USERS } from '../fixtures/auth.js';
import { resetWorkspace } from '../fixtures/database.js';

/* ---------------------------------------------------------------------------------------------- */
/* The screen HELP is asked about                                                                   */
/* ---------------------------------------------------------------------------------------------- */

const PANELS = ['p1', 'p2', 'p3', 'p4'] as const;

/**
 * A function with enough on screen for the ticket to be worth reading: HP over one security draws a
 * toolbar, a summary and a paged grid, so `collectScreenState` has dozens of cited values to
 * attach. Asking HELP about an empty panel would make the ticket's screen state trivially empty and
 * the assertions below vacuous.
 */
const HP_COMMAND = 'AAPL US Equity HP 1M';

/** `shell/HelpOverlay.tsx` — `role="dialog"`, `className="help"`. */
const HELP_OVERLAY = '.help[role="dialog"]';
/** `shell/TicketDialog.tsx` — `role="dialog" aria-modal aria-label="Open a helpdesk ticket"`. */
const TICKET_DIALOG = '[role="dialog"][aria-label="Open a helpdesk ticket"]';

/**
 * Load `/`, wait out the restore, and run HP in `p1`.
 *
 * The `networkidle` waits are load-bearing rather than padding. `App.tsx#onRestored` re-runs every
 * restored frame and the dev server this suite drives mounts the app twice (StrictMode), so a
 * second batch of four runs is still in flight when the first batch has drawn its titles. A command
 * typed inside that window is overwritten by a restore run that lands after it.
 *
 * The panel titles are matched loosely (` · `, the separator every screen title uses) because the
 * four seeded screens are not identical for every seeded person — see `entitlement.spec.ts`.
 */
async function openHpInPanel1(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-panel]')).toHaveCount(PANELS.length, { timeout: 30_000 });
  for (const panel of PANELS) {
    await expect(page.locator(`[data-panel="${panel}"]`), `panel ${panel}`).toContainText(' · ', {
      timeout: 30_000,
    });
  }
  await page.waitForLoadState('networkidle');

  const commandLine = page.getByRole('combobox', { name: 'Command line p1' });
  await commandLine.focus();
  await commandLine.fill(HP_COMMAND);
  await commandLine.press('Enter');
  await expect(page.locator('[data-panel="p1"]')).toContainText('HP · AAPL US Equity · Apple Inc', {
    timeout: 30_000,
  });
  await page.waitForLoadState('networkidle');
  // Again after the settle: a title that held for 200 ms is not what the user is looking at.
  await expect(page.locator('[data-panel="p1"]')).toContainText('HP · AAPL US Equity · Apple Inc');
}

/**
 * Type `HELP` into `p1`'s command line and run it.
 *
 * `focus()` rather than `click()`: the HELP overlay is positioned over the right of the panel and
 * traps `Tab`, so the second HELP has to reach the input without a pointer — which is also how the
 * terminal is meant to be used (TERM-06).
 */
async function pressHelp(page: Page): Promise<void> {
  const commandLine = page.getByRole('combobox', { name: 'Command line p1' });
  await commandLine.focus();
  await commandLine.fill('HELP');
  await commandLine.press('Enter');
}

/* ---------------------------------------------------------------------------------------------- */
/* The screen state, harvested the way the product harvests it                                      */
/* ---------------------------------------------------------------------------------------------- */

interface VisibleField {
  id: string;
  provIdx: number;
}

/**
 * Every cited value in `p1`'s body, read straight out of the DOM.
 *
 * This is `collectScreenState`'s rule restated: every element standing for a value carries
 * `data-prov-idx` (DATA-10, `ScreenRenderer.tsx`), the id is the `data-field` of a live cell or the
 * element's own first line of text, and the list stops at `MAX_VISIBLE_FIELDS = 200`. Restated
 * rather than imported, because a comparison against the product's own harvester would agree with
 * it by construction; restated in the test, the two can disagree and the test says so.
 */
async function visibleFields(page: Page): Promise<{ fields: VisibleField[]; nodes: string[] }> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="panel-body-p1"]');
    const nodes: string[] = [];
    for (const node of root?.querySelectorAll('[data-node-id]') ?? []) {
      const id = node.getAttribute('data-node-id');
      if (id !== null && id !== '' && !nodes.includes(id)) nodes.push(id);
    }
    const fields: { id: string; provIdx: number }[] = [];
    for (const element of root?.querySelectorAll('[data-prov-idx]') ?? []) {
      if (fields.length >= 200) break;
      const raw = element.getAttribute('data-prov-idx');
      if (raw === null) continue;
      const provIdx = Number.parseInt(raw, 10);
      if (Number.isNaN(provIdx)) continue;
      const named = element.querySelector('[data-field]');
      const id =
        named?.getAttribute('data-field') ??
        element.getAttribute('data-field') ??
        (element.textContent ?? '').trim().split('\n')[0]?.slice(0, 40) ??
        '';
      if (id === '') continue;
      fields.push({ id, provIdx });
    }
    return { fields, nodes };
  });
}

interface TicketBody {
  panelId: string;
  functionCode?: string;
  security?: { id?: number };
  params?: Record<string, unknown>;
  traceId?: string;
  question: string;
  screenState: { fields?: VisibleField[]; nodes?: string[] };
}

/** Watch for the one `POST /help/tickets` a ticket makes, so its body can be read afterwards. */
function watchTicketPosts(page: Page): Request[] {
  const posted: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/v1/help/tickets')) {
      posted.push(request);
    }
  });
  return posted;
}

/* ---------------------------------------------------------------------------------------------- */
/* The specs                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

test.describe('WP-15 help — once explains, twice opens a ticket (TERM-09)', () => {
  // Loading the terminal rewrites `pm`'s workspace, so it goes back to the seeded layout first.
  test.beforeEach(async () => {
    await resetWorkspace(E2E_USERS.pm.email);
  });

  test('once explains the function this panel is running', async ({ page }) => {
    await openHpInPanel1(page);

    // The explanation is fetched, not built in the client: `HelpOverlay#loadHelp` asks the plant
    // at `GET /help/:code` (`Rest.Help.Get`, API.md §5.12).
    const answered = page.waitForResponse(
      (res) => /\/api\/v1\/help\/HP(\?|$)/.test(res.url()) && res.status() === 200,
      { timeout: 20_000 },
    );
    await pressHelp(page);
    const served = (await (await answered).json()) as {
      code: string;
      name: string;
      summary: string;
      params: { name: string }[];
      keys: { key: string; action: string }[];
    };

    const overlay = page.locator(HELP_OVERLAY);
    await expect(overlay).toBeVisible({ timeout: 20_000 });
    // HP, because HP is what the panel was running when HELP was pressed. `HELP` was typed with no
    // argument, so the code came from the frame (`App.tsx#onHelp`); a bare HELP that explained
    // some other function, or the shell in general, is the failure this assertion is for.
    await expect(overlay).toHaveAttribute('aria-label', 'Help · HP');

    // And what it shows is what the plant served — the manifest's own documentation, not a
    // placeholder and not the generic function index.
    expect(served.code).toBe('HP');
    expect(served.name).toBe('Historical Price Table');
    await expect(overlay).toContainText(`${served.code} · ${served.name}`);
    await expect(overlay).toContainText(served.summary);
    expect(served.summary).toContain('Historical price table at any periodicity');

    // Every documented parameter is on the panel, by name: HP's `range`, `periodicity`, `adjust`,
    // `fields`, `order`, `pageSize`. Compared against the SERVED list rather than a transcription,
    // so a manifest that grows a parameter the overlay does not draw fails here.
    expect(served.params.length, 'HP documents no parameters').toBeGreaterThan(3);
    const listed = await overlay.locator('dt').allInnerTexts();
    for (const param of served.params) {
      expect(listed, `the overlay does not list the "${param.name}" parameter`).toContain(
        param.name,
      );
    }
    // The reserved keys the shell owns are documented here because the manifest may not bind them
    // (FUNCTIONS §2.6); `Ctrl+I` is the one every screen must answer (DATA-10).
    await expect(overlay).toContainText('Keys');
    expect(served.keys.map((key) => key.key)).toContain('Ctrl+I');

    // ONCE. The distinction TERM-09 is made of: the first HELP must not open a ticket.
    await expect(page.locator(TICKET_DIALOG)).toHaveCount(0);
  });

  test('twice opens a ticket, with the screen that is on the display attached', async ({
    page,
  }) => {
    await openHpInPanel1(page);
    const posted = watchTicketPosts(page);

    await pressHelp(page);
    await expect(page.locator(HELP_OVERLAY)).toBeVisible({ timeout: 20_000 });

    // The second HELP, over an already-open overlay — a ticket however long it has been open, and
    // a ticket anyway inside the ten-second window (`dispatcher.ts#nextHelpEffect`).
    await pressHelp(page);
    const ticket = page.locator(TICKET_DIALOG);
    await expect(ticket).toBeVisible({ timeout: 20_000 });
    // One overlay at a time (CLIENT §3.4): the explanation gives way to the ticket.
    await expect(page.locator(HELP_OVERLAY)).toHaveCount(0);

    // What is on the display at the moment the ticket is composed. This is the comparison that
    // makes the attachment mean something: `collectScreenState` must attach THIS, value for value
    // and provenance index for provenance index — not a summary, not a sample, not nothing.
    //
    // (WHICH screen this is, is a separate question, and the answer is wrong — see the failing
    // test below. What is asserted here is that the harvester tells the truth about the panel it
    // is pointed at, which it does.)
    const onScreen = await visibleFields(page);
    expect(
      onScreen.fields.length,
      'nothing on the panel carries a provenance index — is the database seeded?',
    ).toBeGreaterThan(20);
    expect(onScreen.nodes.length, 'the panel drew no addressable nodes').toBeGreaterThan(0);

    // The dialog shows the user what it is about to send, before they send it.
    await expect(ticket).toContainText('Open a ticket');
    await expect(ticket).toContainText('p1');
    await expect(ticket).toContainText(`${String(onScreen.fields.length)} values with provenance`);

    const question = 'Why is the adjustment factor 1 on every row?';
    await page.locator('#ticket-question-p1').fill(question);
    const answered = page.waitForResponse(
      (res) => res.url().endsWith('/api/v1/help/tickets') && res.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await page.locator('.ticket__submit').click();
    const response = await answered;

    // The plant opened it, and opened a room for the answer to arrive in (API.md §5.12).
    expect(response.status(), 'POST /help/tickets').toBe(201);
    const created = (await response.json()) as { ticketId: number; roomId: number };
    expect(created.ticketId, 'the ticket has no id').toBeGreaterThan(0);
    expect(created.roomId, 'no helpdesk room was opened for the ticket').toBeGreaterThan(0);

    // ── and now what it actually carried ──────────────────────────────────────────────────────
    expect(posted.length, 'no ticket was posted').toBe(1);
    const body = posted[0]?.postDataJSON() as TicketBody;

    expect(body.panelId, 'the ticket does not name the panel').toBe('p1');
    expect(body.question).toBe(question);
    expect(body.traceId, 'the ticket carries no trace id (OPS-07)').toMatch(/^[0-9a-f-]{36}$/);
    expect(body.functionCode, 'the ticket names no function').not.toBeUndefined();
    expect(
      body.screenState.nodes,
      'the ticket lists different nodes from the ones on the display',
    ).toEqual(onScreen.nodes);
    expect(
      body.screenState.fields,
      'the ticket attached a different set of values from the one on the display',
    ).toEqual(onScreen.fields);
  });

  // ── A DEFECT, recorded rather than hidden ───────────────────────────────────────────────────
  //
  // `test.fail()` and not `test.skip()`: it runs on every suite and it MUST fail, so the day the
  // restore effect stops firing, Playwright reports "expected to fail but passed".
  //
  // **Opening the HELP overlay throws away the screen it is explaining.**
  //
  //   `Shell.tsx` L113-123 loads the workspace and restores it in a `useEffect` whose dependency
  //   list is `[workspace, scheduler, onRestored]` — its own comment says "here they happen
  //   together, once". `onRestored` is not stable: `App.tsx` L1131 declares it
  //   `useCallback(…, [dispatchDeps, run])`, `dispatchDeps` is a `useMemo` over `[…, onHelp, …]`,
  //   and `onHelp` is `useCallback(…, [sdk, overlay, setProblem])` — it closes over the overlay
  //   because `nextHelpEffect` has to know whether one is already open.
  //
  //   So `setOverlay(…)` → new `onHelp` → new `dispatchDeps` → new `onRestored` → the effect
  //   re-runs → `GET /api/v1/workspace` → `onRestored()` → all four panels are re-run from the
  //   SAVED layout. Whatever the user had launched is discarded.
  //
  // Measured on `pm@demo.terminal`, `bloomberg_e2e`, with the network log beside the DOM:
  //   `AAPL US Equity HP 1M` → the panel reads `HP · AAPL US Equity · Apple Inc`
  //   `HELP`                 → `GET /help/HP` 200, then `GET /workspace`, then TOP/GP/W/WEI re-run
  //                            the overlay says `Help · HP` (the code was captured before the
  //                            restore) over a panel body that is WEI again, with `now: —` beside
  //                            every one of HP's parameters
  //   `HELP` again           → the ticket posts `functionCode: "WEI"`, WEI's params and WEI's 180
  //                            pending cells (`provIdx: -1`) as the screen state
  //
  // The consequence for TERM-09 is the whole value of the feature: the desk receives a faithful
  // capture of a screen the user never asked about, and the one they did ask about has gone from
  // their display too. It is a TERM-05 defect in its own right — a workspace restore that fires on
  // an unrelated piece of UI state will discard a user's work at any time, not only under HELP.
  test('the ticket carries the screen the user was on (TERM-09)', async ({ page }) => {
    test.fail(
      true,
      'DEFECT: Shell.tsx’s workspace-restore effect depends on onRestored, whose identity changes ' +
        'whenever the HELP overlay opens (App.tsx: onHelp → dispatchDeps → onRestored). Opening ' +
        'HELP re-restores the workspace, so the ticket describes the restored screen.',
    );

    await openHpInPanel1(page);
    const posted = watchTicketPosts(page);

    await pressHelp(page);
    await expect(page.locator(HELP_OVERLAY)).toBeVisible({ timeout: 20_000 });

    // Where it actually breaks. A short timeout on purpose: the failure is already decided, and a
    // 20 s wait for it would be twenty seconds on every run of the suite.
    await expect(
      page.locator('[data-panel="p1"]'),
      'the panel HELP was opened over has been restored out from under it',
    ).toContainText('HP · AAPL US Equity · Apple Inc', { timeout: 5_000 });

    // …and then what the desk should receive.
    await pressHelp(page);
    await expect(page.locator(TICKET_DIALOG)).toBeVisible({ timeout: 20_000 });
    await page.locator('#ticket-question-p1').fill('The adjustment factors look wrong.');
    const answered = page.waitForResponse(
      (res) => res.url().endsWith('/api/v1/help/tickets') && res.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await page.locator('.ticket__submit').click();
    await answered;

    const body = posted[0]?.postDataJSON() as TicketBody;
    expect(body.functionCode, 'the ticket names the wrong function').toBe('HP');
    expect(body.params?.range, 'the ticket carries the wrong params').toBe('1M');
    expect(body.security?.id, 'the ticket names no security').toBeGreaterThan(0);
  });

  // ── A SECOND GAP, in the same feature ───────────────────────────────────────────────────────
  //
  // `TicketDialog` has a `sent` state that renders `role="status"` — "Ticket 1 opened. The
  // helpdesk room is open in the next panel (MSG room 3)." — and it is unreachable in this
  // composition: `App.tsx#PanelOverlay` passes `onOpened={() => { onClose(); }}` and
  // `TicketDialog#submit` calls `onOpened(result)` in the same tick it sets `sent`, so the dialog
  // unmounts before that branch can paint. Measured: the dialog disappears; no status, no toast,
  // no footer line, nothing in the panel changes.
  //
  // So a user presses HELP twice, types their question, presses GO — and the screen goes back to
  // what it was. The ticket WAS opened (the green test above proves it on the wire, `201
  // {ticketId:1, roomId:3}`) and there is no way for the person who opened it to know that, or to
  // find the room the answer will arrive in. `App.tsx`'s own comment says closing is "what is
  // certainly right" because navigating to `MSG` needs param grammar it cannot spell; that is a
  // fair reason not to navigate, and not a reason to say nothing.
  test('the terminal says which ticket it opened (TERM-09)', async ({ page }) => {
    test.fail(
      true,
      'GAP: App.tsx#PanelOverlay closes the dialog from onOpened, so TicketDialog’s "Ticket N ' +
        'opened / MSG room M" confirmation never paints. The user is told nothing.',
    );

    await openHpInPanel1(page);
    await pressHelp(page);
    await expect(page.locator(HELP_OVERLAY)).toBeVisible({ timeout: 20_000 });
    await pressHelp(page);
    await expect(page.locator(TICKET_DIALOG)).toBeVisible({ timeout: 20_000 });
    await page.locator('#ticket-question-p1').fill('The adjustment factors look wrong.');

    const answered = page.waitForResponse(
      (res) => res.url().endsWith('/api/v1/help/tickets') && res.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await page.locator('.ticket__submit').click();
    const created = (await (await answered).json()) as { ticketId: number; roomId: number };

    // The assertion the product should satisfy: the confirmation `TicketDialog` already writes,
    // naming the ticket and the room the answer will arrive in. Matched on that sentence rather
    // than on the bare id, because a low ticket number appears in a dozen unrelated places on a
    // terminal full of numbers.
    await expect(
      page.getByRole('status'),
      'the ticket was opened and the user was not told',
    ).toContainText(`Ticket ${String(created.ticketId)} opened`, { timeout: 5_000 });
  });
});
