// packages/e2e/tests/entitlement.spec.ts — ENTL-05 (WORKPLAN §WP-15, ARCHITECTURE §3.5 L401-409).
//
// "Export denied shows the reason code; the `eod@demo` user sees frozen values."
//
// Both halves need a SECOND person, which is what makes this the one spec in the suite with two
// sessions open at once. `eod@demo.terminal` is seeded with an end-of-day grant where the others
// have delayed or realtime (`fixtures/seed/entitlements.json`), and the evaluator answers the same
// screen two different ways for the two of them. That difference is the assertion: this file runs
// **the same command on the same instrument as two people** and compares what the two terminals
// draw. A spec that only looked at the `eod` user would pass against a terminal that showed
// everybody the same thing.
//
// ## What the evaluator actually does here, measured rather than assumed
//
// `AAPL US Equity DES`, seeded database, the two sessions side by side:
//
//   * `pm@demo.terminal` — `meta.entitlement` is EMPTY. `PX_LAST` renders `330.27` in state
//     `stale` (the recorded Cboe poll, no fresh update since).
//   * `eod@demo.terminal` — `meta.entitlement` carries a `downgrade` / `NOT_ENTITLED_TIER` note
//     with `effectiveTier: 'eod'` for every price field. `PX_LAST`, `PX_BID`, `PX_ASK` and
//     `LAST_TRADE_TIME` are withheld; `PX_OPEN`, `PX_HIGH`, `PX_LOW`, `PX_CLOSE_1D` and
//     `PX_VOLUME` — the closed session — render the SAME numbers `pm` sees, in state `closed`.
//
// That is what "frozen values" means on this screen and it is a sharper thing to assert than a
// blank page: the eod desk is not shown less data, it is shown the session that has finished. So
// the shared fields are asserted EQUAL across the two users and the tier-bound ones are asserted
// different, which cannot both be satisfied by an entitlement layer that had stopped working.
//
//   * an export — `GET /functions/HP/csv` — is refused for `eod` with `403 ENTITLEMENT_DENIED` and
//     a `deny` / `NO_USER_ENTITLEMENT` reason for every field, while the same request succeeds for
//     `pm`. ARCHITECTURE §10 rule 2: ANY denied field fails the whole export.
//
// ## The second session
//
// `globalSetup` pre-mints five people and `eod` is not one of them (`fixtures/auth.ts`:
// `PREMINTED_USERS` is five long because five is the per-IP login budget for a minute). So this
// file asks the fixture for the sixth, once, in a `beforeAll` — {@link ensureEodSession} — rather
// than hand-rolling a login: the pacing, the supersede rule and the verification all belong to
// `mintStorageState` and are not re-implemented here. Running with `TERMINAL_E2E_USERS=pm,eod`
// makes that step a no-op, and is what a debugging loop on this file wants.
//
// Nothing here imports package source (WORKPLAN §1.2).

import { existsSync } from 'node:fs';

import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { E2E_USERS, mintStorageState, storageStatePath } from '../fixtures/auth.js';
import { resetWorkspace } from '../fixtures/database.js';

/* ---------------------------------------------------------------------------------------------- */
/* The two people                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/** The delayed desk — `use.storageState`'s default, minted by `globalSetup`. */
const PM_STATE = storageStatePath('pm');
/** The end-of-day desk. Not pre-minted; see {@link ensureEodSession}. */
const EOD_STATE = storageStatePath('eod');

/** API.md §1.3 allows five logins a minute per IP; a sixth has to wait the window out. */
const LOGIN_WINDOW_MS = 61_000;

/**
 * Make sure `eod@demo.terminal` has a `storageState`, minting one through the fixture if not.
 *
 * `globalSetup` has usually just spent the per-IP login budget on the five it pre-mints, so the
 * sixth login can come back `429 RATE_LIMITED`. That is a security control doing its job and the
 * right response is to wait, not to widen it — `fixtures/auth.ts` makes the same argument where it
 * paces itself. One retry after the window is enough, because the budget is a sliding minute.
 */
async function ensureEodSession(): Promise<void> {
  if (existsSync(EOD_STATE)) return;
  // The wait is inside this hook, so the hook needs longer than a test.
  test.setTimeout(LOGIN_WINDOW_MS + 60_000);
  try {
    await mintStorageState('eod');
  } catch (error) {
    if (!String(error).includes('answered 429')) throw error;
    process.stdout.write(
      `  eod is not in PREMINTED_USERS and the login budget is spent — waiting ` +
        `${String(Math.round(LOGIN_WINDOW_MS / 1000))} s (run with TERMINAL_E2E_USERS=pm,eod to ` +
        'skip this)\n',
    );
    await new Promise((resolve) => setTimeout(resolve, LOGIN_WINDOW_MS));
    await mintStorageState('eod');
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* The screen under test                                                                            */
/* ---------------------------------------------------------------------------------------------- */

const SEEDED_PANELS = ['p1', 'p2', 'p3', 'p4'] as const;

/**
 * Load `/` and wait until the restored workspace has stopped moving.
 *
 * Deliberately NOT asserting the four seeded titles the way `smoke.spec.ts` does: the two people in
 * this file do not restore into the same four screens. `p4` is `W`, and `W` opens the user's active
 * watchlist — `pm@demo.terminal` has `Core` and draws `W · Core`, while `eod@demo.terminal` has no
 * watchlist of their own and draws `W · Watchlists` with the firm's three offered for selection. So
 * the wait here is on the SHAPE (four panels, each with a screen title) and on the network going
 * quiet, and the data assertions are made on `p1`, where both people run the same command.
 *
 * The `networkidle` wait is load-bearing rather than padding. `App.tsx#onRestored` re-runs every
 * restored frame, React's StrictMode mounts the app twice in the dev server this suite drives, and
 * the second batch of four runs is still in flight when the first has drawn. A command typed inside
 * that window can be overwritten by a restore run that lands after it — measured, with the panel
 * header reading `HP · AAPL US Equity` over a body that had gone back to `WEI`.
 */
async function openRestoredWorkspace(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-panel]')).toHaveCount(SEEDED_PANELS.length, { timeout: 30_000 });
  for (const panel of SEEDED_PANELS) {
    // `<CODE> · <title>` — every screen's own title line, which only the renderer draws.
    await expect(page.locator(`[data-panel="${panel}"]`), `panel ${panel}`).toContainText(' · ', {
      timeout: 30_000,
    });
  }
  await page.waitForLoadState('networkidle');
}

/**
 * DES over one instrument, which is the screen where the two grants differ visibly.
 *
 * Deliberately not QM: QM is a quote monitor over a WATCHLIST, and `eod@demo.terminal` has none
 * seeded, so QM renders an empty list for them and the comparison would be between a screen and a
 * blank — which is precisely the shape of vacuous test this suite exists not to add.
 */
const DES_COMMAND = 'AAPL US Equity DES';

/** Fields DES draws that the closed session already settled — the same for both desks. */
const SETTLED_FIELDS = ['PX_OPEN', 'PX_HIGH', 'PX_LOW', 'PX_CLOSE_1D', 'PX_VOLUME'] as const;

/** Fields the `eod` grant does not reach: the live book and the last print. */
const TIER_BOUND_FIELDS = ['PX_LAST', 'PX_BID', 'PX_ASK', 'LAST_TRADE_TIME'] as const;

interface ShownCell {
  /** `data-st` — the `ValueState` the renderer put on the element (CLIENT §12.1). */
  state: string;
  /** The value span's text, without the visually-hidden state phrase. */
  text: string;
  /** The `title`, which is `CellView#cellTooltip`: state · reason · timestamp. */
  title: string;
  /** `.cell__reason` — the visible `ReasonCode` beside a blank value, when there is one. */
  reason: string | null;
}

/** Load `/`, wait out the restore, run DES in `p1` and read its value cells by field id. */
async function desAs(context: BrowserContext): Promise<{
  page: Page;
  cells: Record<string, ShownCell>;
  badges: string[];
  entitlement: { fieldId: string; decision: string; effectiveTier: string | null; reason: string }[];
}> {
  const page = await context.newPage();
  const answered = page.waitForResponse(
    (res) => res.url().endsWith('/api/v1/functions/DES/run') && res.status() === 200,
    { timeout: 30_000 },
  );

  await openRestoredWorkspace(page);

  const commandLine = page.getByRole('combobox', { name: 'Command line p1' });
  await commandLine.focus();
  await commandLine.fill(DES_COMMAND);
  await commandLine.press('Enter');

  const body = (await (await answered).json()) as {
    meta: {
      entitlement: {
        fieldId: string;
        decision: string;
        effectiveTier: string | null;
        reason: string;
      }[];
    };
  };
  await expect(page.locator('[data-panel="p1"]')).toContainText('DES · AAPL US Equity', {
    timeout: 30_000,
  });
  await page.waitForLoadState('networkidle');

  const cells: Record<string, ShownCell> = await page.evaluate(() => {
    const out: Record<string, { state: string; text: string; title: string; reason: string | null }> =
      {};
    for (const el of document.querySelectorAll('[data-panel="p1"] [data-field][data-st]')) {
      const field = el.getAttribute('data-field');
      if (field === null || field in out) continue;
      const value = el.querySelector('.cell__value');
      out[field] = {
        state: el.getAttribute('data-st') ?? '',
        text: (value?.textContent ?? '').trim(),
        title: el.getAttribute('title') ?? '',
        reason: el.querySelector('.cell__reason')?.textContent?.trim() ?? null,
      };
    }
    return out;
  });

  // The entitlement strip (`screens/shared/quoteHeader.ts#entitlementBadges`, drawn by
  // `widgets/Badges.tsx` as `span.badge`) — ENTL-05: "the screen only renders the badge". Read the
  // way a user reads it, as visible text.
  const badges = await page.locator('[data-panel="p1"] .badge').allInnerTexts();

  return { page, cells, badges, entitlement: body.meta.entitlement };
}

/* ---------------------------------------------------------------------------------------------- */
/* The specs                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

test.describe('WP-15 entitlement — two desks, one instrument (ENTL-05)', () => {
  test.beforeAll(async () => {
    await ensureEodSession();
  });

  test.beforeEach(async () => {
    // Both people load the terminal here, and loading it rewrites the workspace.
    await resetWorkspace(E2E_USERS.pm.email);
    await resetWorkspace(E2E_USERS.eod.email);
  });

  test('the eod desk sees the frozen session, and is told which fields were downgraded', async ({
    browser,
  }) => {
    const pmContext = await browser.newContext({ storageState: PM_STATE });
    const eodContext = await browser.newContext({ storageState: EOD_STATE });
    try {
      const pm = await desAs(pmContext);
      const eod = await desAs(eodContext);

      // ── the control ───────────────────────────────────────────────────────────────────────
      // The delayed desk is NOT downgraded, and it is looking at the seeded quote: `330.27` is
      // AAPL's last in the recorded Cboe poll (`fixtures/providers/raw/cboe-quote-AAPL.json`),
      // `stale` because no second observation of it exists to refresh it (TERM-12).
      expect(pm.entitlement, 'the delayed desk was downgraded — check the seeded grants').toEqual(
        [],
      );
      expect(pm.cells.PX_LAST?.text).toBe('330.27');
      expect(pm.cells.PX_LAST?.state).toBe('stale');
      expect(pm.cells.PX_LAST?.title).toContain('stale, no fresh update');

      // ── the downgrade, on the wire ────────────────────────────────────────────────────────
      const notes = new Map(eod.entitlement.map((note) => [note.fieldId, note]));
      expect(
        notes.size,
        'the eod desk saw no entitlement notes at all — is the seeded grant still eod?',
      ).toBeGreaterThan(0);
      for (const field of [...SETTLED_FIELDS, ...TIER_BOUND_FIELDS]) {
        const note = notes.get(field);
        expect(note, `no entitlement note for ${field}`).toBeDefined();
        expect(note?.decision, `${field} decision`).toBe('downgrade');
        expect(note?.reason, `${field} reason`).toBe('NOT_ENTITLED_TIER');
        expect(note?.effectiveTier, `${field} effectiveTier`).toBe('eod');
      }

      // ── the downgrade, on the screen (ENTL-05: "the screen only renders the badge") ────────
      // The reason code is VISIBLE text, not an attribute: a user who cannot read why a value is
      // missing has not been told.
      const badgeText = eod.badges.join('\n');
      for (const field of TIER_BOUND_FIELDS) {
        expect(badgeText, `no visible badge for ${field}`).toContain(
          `${field}: NOT_ENTITLED_TIER`,
        );
      }
      expect(badgeText).toContain('downgraded to eod');
      // And the control desk has no such strip — otherwise the badge says nothing about grants.
      expect(pm.badges.join('\n')).not.toContain('NOT_ENTITLED_TIER');

      // ── frozen: the settled session is the SAME session both desks are looking at ──────────
      // Identical numbers, different states. This is what an entitlement downgrade does and what
      // a broken one could not fake: withholding everything would fail the first loop, showing
      // everything would fail the second.
      for (const field of SETTLED_FIELDS) {
        expect(eod.cells[field]?.text, `${field} on the eod desk`).toBe(pm.cells[field]?.text);
        expect(eod.cells[field]?.text, `${field} is blank on both desks`).not.toBe('—');
        expect(eod.cells[field]?.state, `${field} state on the eod desk`).toBe('closed');
        expect(pm.cells[field]?.state, `${field} state on the delayed desk`).toBe('stale');
      }

      // ── and the tier-bound fields are gone, only for the eod desk ──────────────────────────
      for (const field of TIER_BOUND_FIELDS) {
        expect(pm.cells[field]?.text, `${field} should be readable by the delayed desk`).not.toBe(
          '—',
        );
        expect(eod.cells[field]?.text, `${field} should be withheld from the eod desk`).toBe('—');
        // `cellTooltip` puts the server's own `ReasonCode` after the state phrase.
        expect(eod.cells[field]?.title, `${field} tooltip`).toContain('TIER_EOD');
      }
    } finally {
      await pmContext.close();
      await eodContext.close();
    }
  });

  test('an export by the eod desk is refused, field by field, with its reason code', async ({
    browser,
  }) => {
    const eodContext = await browser.newContext({ storageState: EOD_STATE });
    const pmContext = await browser.newContext({ storageState: PM_STATE });
    try {
      // Run the SAME function as the same two people, then ask each page — from its own origin,
      // with its own session — for the export of its own result. `App.tsx#exportResult` makes
      // exactly this request; what it would do with the answer is the UI half, and that half has
      // no gesture behind it (see `export.spec.ts`'s recorded gap).
      const eodResult = await hpResultId(eodContext);
      const pmResult = await hpResultId(pmContext);

      const denied = await requestCsv(eodResult.page, eodResult.resultId);
      expect(denied.status, 'the eod desk was allowed to export').toBe(403);
      const error = (JSON.parse(denied.body) as { error: ApiError }).error;
      expect(error.code).toBe('ENTITLEMENT_DENIED');
      expect(error.traceId, 'a refusal with no trace cannot be audited (OPS-07)').toMatch(
        /^[0-9a-f-]{36}$/,
      );

      const reasons = error.details?.reasons ?? [];
      expect(reasons.length, 'the refusal named no fields').toBeGreaterThan(0);
      for (const reason of reasons) {
        expect(reason.decision, `${reason.fieldId} decision`).toBe('deny');
        expect(reason.reason, `${reason.fieldId} reason`).toBe('NO_USER_ENTITLEMENT');
      }
      // ARCHITECTURE §10 rule 2: ANY denied field fails the WHOLE export. The message says how
      // many, and the refusal covers the price fields the screen was showing.
      expect(error.message).toContain(`${String(reasons.length)} field(s) are not licensed`);
      expect(reasons.map((r) => r.fieldId)).toEqual(
        expect.arrayContaining(['PX_LAST', 'PX_OPEN', 'PX_HIGH', 'PX_LOW', 'PX_VOLUME']),
      );

      // The control: the same route, the same function, a desk that IS licensed to export. Without
      // it, "the export was refused" is satisfied by an export route that refuses everybody.
      const allowed = await requestCsv(pmResult.page, pmResult.resultId);
      expect(allowed.status, 'the delayed desk could not export either').toBe(200);
      expect(allowed.body).toContain('# function: HP  security: AAPL US Equity');
    } finally {
      await eodContext.close();
      await pmContext.close();
    }
  });

  // ── A DEFECT, recorded rather than hidden ───────────────────────────────────────────────────
  //
  // `test.fail()` and not `test.skip()`: it runs on every suite and it MUST fail, so the day the
  // renderer tells the truth about a withheld cell, Playwright reports "expected to fail but
  // passed" and this record cannot rot.
  //
  // What happens. `ScreenRenderer.tsx`'s rule 4 and `CellView.tsx`'s own header both say a blank
  // cell must print the `ReasonCode` that denied it — "Without it a withheld price and a missing
  // price are the same em dash." But `CellView` renders `.cell__reason` only when
  // `cell.st === 'blank'`, and a value withheld by the eod grant does not arrive as `blank`: the
  // payload carries `st: 'closed'`, `v: null`, `r: 'TIER_EOD'`. So `formatCell` prints the blank
  // glyph, the reason span is never rendered, and the visually-hidden state phrase reads
  // "closed, session ended".
  //
  // Measured on `eod@demo.terminal`'s `AAPL US Equity DES` in `bloomberg_e2e`:
  //   PX_LAST  data-st="closed"  text "—"  title "closed, session ended · TIER_EOD"
  //
  // The user sees an em dash and is told the session ended, which is true of the session and false
  // of this value — it is absent because of their tier, and the only place that says so is a
  // `title` attribute nobody hovers. The field-level badge strip does carry
  // `PX_LAST: NOT_ENTITLED_TIER` (asserted above, and it is why the test above passes), so the
  // information is on the screen; it is not on the CELL, which is the distinction ENTL-05 draws
  // and the one that decides whether a person reading a row knows what they are looking at.
  test('a withheld cell says it was withheld, not that the session ended (ENTL-05)', async ({
    browser,
  }) => {
    test.fail(
      true,
      'DEFECT: an entitlement-withheld cell arrives as st:"closed" with r:"TIER_EOD", and ' +
        'CellView only renders .cell__reason for st:"blank" — so the cell shows a bare em dash. ' +
        'CellView.tsx L162, ScreenRenderer.tsx rule 4.',
    );

    const eodContext = await browser.newContext({ storageState: EOD_STATE });
    try {
      const eod = await desAs(eodContext);
      const withheld = eod.cells.PX_LAST;
      expect(withheld?.text, 'PX_LAST is not withheld — the grant has changed').toBe('—');
      // The assertion the product should satisfy: the reason travels with the cell, visibly.
      expect(withheld?.reason, 'the withheld cell carries no visible ReasonCode').not.toBeNull();
    } finally {
      await eodContext.close();
    }
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Helpers used by the export half                                                                  */
/* ---------------------------------------------------------------------------------------------- */

interface ApiError {
  code: string;
  message: string;
  traceId: string;
  details?: {
    reasons?: { fieldId: string; decision: string; effectiveTier: string | null; reason: string }[];
  };
}

/** Run `AAPL US Equity HP 1M` in `p1` and hand back the page and the result it is showing. */
async function hpResultId(
  context: BrowserContext,
): Promise<{ page: Page; resultId: string }> {
  const page = await context.newPage();
  const answered = page.waitForResponse(
    (res) => res.url().endsWith('/api/v1/functions/HP/run') && res.status() === 200,
    { timeout: 30_000 },
  );

  await openRestoredWorkspace(page);

  const commandLine = page.getByRole('combobox', { name: 'Command line p1' });
  await commandLine.focus();
  await commandLine.fill('AAPL US Equity HP 1M');
  await commandLine.press('Enter');

  const body = (await (await answered).json()) as { meta: { resultId?: string } };
  await expect(page.locator('[data-panel="p1"]')).toContainText('HP · AAPL US Equity', {
    timeout: 30_000,
  });
  const resultId = body.meta.resultId ?? '';
  expect(resultId, 'the HP run returned no resultId').not.toBe('');
  return { page, resultId };
}

/**
 * Ask for the export of a result from inside the page.
 *
 * The request is made by the page so that it carries the session cookie and goes through the vite
 * proxy — the same route, the same origin and the same credentials `App.tsx#exportResult` uses.
 * What this spec does NOT do is pretend the answer reaches the user: it cannot, because nothing in
 * the UI can ask for an export (see `export.spec.ts`).
 */
async function requestCsv(
  page: Page,
  resultId: string,
): Promise<{ status: number; body: string }> {
  return page.evaluate(async (id: string) => {
    const res = await fetch(`/api/v1/functions/HP/csv?resultId=${encodeURIComponent(id)}`);
    return { status: res.status, body: await res.text() };
  }, resultId);
}
