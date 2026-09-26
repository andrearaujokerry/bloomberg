// packages/e2e/tests/live-grid.spec.ts — the live grid (TERM-08, TERM-12, ENTL-05).
//
// WORKPLAN WP-15's row: "QM flashes on a replayed session; staleness badge appears after the feed
// stops". Two halves, and both are about what a trader SEES rather than about which call was made:
//
//   1. a delta on a subject moves ONE number, so exactly one cell flashes — the assertion that
//      fails if the grid repaints a row, or a screen, instead of a cell (CLIENT.md §10.4);
//   2. a value whose state is not `live` SAYS which state it is, in words, at the point of use —
//      CLIENT.md §12.1's table, and the half of TERM-12 that a colour alone cannot carry.
//
// ## Where the deltas come from, and why they are interposed rather than provoked
//
// Nothing in the e2e stack can make the plant publish a quote. Startup step 8 — the ingest leader
// lock and the scheduler — is one of the five this process still defers to a merged package
// (BUILD_STATUS.md, `server/src/index.ts#PENDING_STEPS`), so no job ever polls, `POST
// /admin/ingest/run/:jobId` answers `503 STARTING` by design, and the plant's only market data is
// the warm-up from `quote_snapshots` — captured on the fixture's dates and therefore `stale` before
// the first paint. A spec that waited for a tick would wait forever.
//
// So this file interposes itself on the socket with `page.routeWebSocket`: every frame the browser
// sends still reaches the real plant and every frame the plant sends still reaches the browser
// (`connectToServer`), and the two frames below are added to that stream. What is faked is the
// FEED; everything the assertions are about — `LiveClient`, the prev-chain rule in `QuoteCache`,
// `rt/wsBridge.ts`'s fan-out, `grid/cellRegistry.ts`'s per-cell write and `grid/flash.ts` — is the
// product, reached the way the product reaches it. It is the same standing-in the replay harness
// does for the same reason (`server/src/replay/harness.ts`), one layer further out.
//
// Two things found while writing this, reported here and NOT worked around, because both are
// composition-root wiring and this package owns no client source:
//
//   * **No grid subject is ever subscribed.** `state/subscriptions.ts#acquire` — which turns a
//     screen's `LiveSpec` into `sub` frames — is called from no product file; `grep -rn 'acquire('
//     packages/web/src` finds the store, its two unit tests and nothing else. The only `sub` this
//     app ever sends is `ChartCanvas`'s (`App.tsx` L304), which is why a loaded workspace subscribes
//     `q:37367 PX_LAST` for the GP panel and nothing at all for the three grids. The grid's cells
//     ARE registered with their `data-subject`, so a delta that reaches the socket is applied and
//     painted — which is what makes this spec possible at all, and it is also why `subs 0/10,000`
//     in the status bar is the literal truth.
//   * **The staleness sweep never reaches a cell.** See the `test.fail` at the end of this file.
//
// Nothing below is weakened to fit either. The frames are constructed to the letter of
// `sdk/src/wire/ws.ts` (itself verbatim from API.md §6.2), and the third test asserts the behaviour
// the product is supposed to have.

import type { Locator, Page, WebSocketRoute } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { E2E_USERS } from '../fixtures/auth.js';
import { resetWorkspace } from '../fixtures/database.js';

/** The app's socket. The other one on this origin is vite's HMR channel, which must be left alone. */
const WS_ROUTE = /\/ws\/v1/;

/** `grid/flash.ts#FLASH_CLASS` — the two classes a change flash adds. `flat` adds none. */
const FLASH_CLASSES = ['flash-up', 'flash-down'] as const;

/** `grid/flash.ts`: `FLASH_MS` × `FLASH_SWEEP_FACTOR` — the outer bound on a flash's life. */
const FLASH_LIFETIME_MS = 700 * 3;

/**
 * `grid/cellRegistry.ts#STATE_PHRASE`, transcribed rather than imported (WORKPLAN §1.2: a spec
 * drives the app over the wire and never reads package source). Transcribing is the point: if
 * somebody edits the phrase in the product, this file has to be edited too, deliberately, which is
 * what makes these five strings a contract instead of a tautology.
 */
const STATE_PHRASE: Readonly<Record<string, string>> = {
  live: 'live',
  stale: 'stale, no fresh update',
  closed: 'closed, session ended',
  blank: 'unavailable',
  na: 'not applicable',
};

/* ---------------------------------------------------------------------------------------------- */
/* The interposed plant                                                                             */
/* ---------------------------------------------------------------------------------------------- */

/** One frame added to the stream, or the whole spec is a test of an empty grid. */
type SendFrame = (frame: Record<string, unknown>) => void;

/**
 * Put this spec between the browser and the plant, transparently, and hand back a way to add a
 * frame to what the browser receives.
 *
 * Installed BEFORE `goto`: `LiveClient` opens its socket during the first render, and a route
 * registered afterwards would watch a connection it never saw the `hello` of.
 */
async function interposePlant(page: Page): Promise<{ send: SendFrame; opened: Promise<void> }> {
  let route: WebSocketRoute | undefined;
  let announce: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    announce = resolve;
  });

  await page.routeWebSocket(WS_ROUTE, (ws) => {
    route = ws;
    // The real plant, still: the session's `hello`, its `subAck` and its snapshots all go through
    // untouched. Interposing must not become mocking, or the assertions stop being about the app
    // that ships.
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      server.send(message);
    });
    server.onMessage((message) => {
      ws.send(message);
    });
    announce();
  });

  return {
    opened,
    send: (frame) => {
      if (route === undefined) throw new Error('the app has not opened /ws/v1 yet');
      route.send(JSON.stringify(frame));
    },
  };
}

/** `Snap` (`wire/ws.ts`): every member is required, so every member is stated. */
function snapFrame(subject: string, fields: Record<string, number>, capturedAt: number): Record<string, unknown> {
  return {
    t: 'snap',
    s: subject,
    seq: 1,
    // What the plant's own `subAck` grants on this stack, and what fixes the staleness basis at
    // `CLIENT_EXPECTED_INTERVAL_MS.delayed` = 10 s (so the limit is 3 × 10 s — `core/quote/staleness.ts`).
    tier: 'delayed',
    reason: 'OK',
    f: fields,
    ts: { src: capturedAt, cap: capturedAt, pub: capturedAt },
    st: 'live',
    session: 'open',
    prov: { p: 'cboe.quotes', id: 36 },
    ac: 'equity',
    id: 85,
  };
}

/** `Delta`: `prev` is the chain (§6.3 step 3) — get it wrong and `QuoteCache` refuses the frame. */
function deltaFrame(
  subject: string,
  fields: Record<string, number>,
  seq: number,
  at: number,
): Record<string, unknown> {
  return {
    t: 'delta',
    s: subject,
    seq,
    prev: seq - 1,
    f: fields,
    ts: { src: at, cap: at, pub: at },
    st: 'live',
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* The screen                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/** `W · Core` — `p4` of every seeded workspace, and the only panel with a fixed row set. */
const WATCHLIST = '[data-panel="p4"]';

/** Loads `/` and waits for the watchlist to have drawn its seeded rows. */
async function openWatchlist(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
  // The row, not the panel: a panel frame appears before its function has answered, and every
  // assertion below is about cells that only exist once `POST /api/v1/functions/W/run` has.
  await expect(page.locator(WATCHLIST)).toContainText('AAPL US Equity', { timeout: 30_000 });
  await expect(page.locator(`${WATCHLIST} [role="gridcell"]`)).toHaveCount(25);
}

/**
 * The `q:<instrumentId>` the watchlist drew AAPL's price under.
 *
 * Read off the DOM rather than written down: the id is the seed's `instruments.instrument_id`, and
 * a spec that hard-coded it would start asserting about whatever row that number landed on the next
 * time the universe module's insert order changed.
 */
async function aaplSubject(page: Page): Promise<string> {
  const subject = await page
    .locator(`${WATCHLIST} [data-col="PX_LAST"][data-subject]`)
    .first()
    .getAttribute('data-subject');
  expect(subject, 'the watchlist drew no live-addressed price cell').toMatch(/^q:\d+$/);
  return subject ?? '';
}

/** What the grid is showing for one `(subject, column)` right now, cell attributes and all. */
function cellOf(page: Page, subject: string, column: string): Locator {
  return page.locator(`${WATCHLIST} [data-subject="${subject}"][data-col="${column}"]`);
}

/* ---------------------------------------------------------------------------------------------- */
/* The flash watcher                                                                                */
/* ---------------------------------------------------------------------------------------------- */

/** One recorded class change: which cell, and what its class list said at that moment. */
interface FlashRecord {
  key: string;
  className: string;
}

declare global {
  interface Window {
    /** Installed by {@link watchFlashes}; read by {@link flashesSeen}. */
    __e2eFlashes?: FlashRecord[];
  }
}

/**
 * Record every element that gains a flash class from now on, across the WHOLE document.
 *
 * Polling for `.flash-up` would be the obvious version and it cannot work: a flash lives 700 ms and
 * clears itself, so a poll that arrives late reports a cell that never flashed, and one that
 * arrives early reports a document mid-write. More to the point, the assertion this spec exists for
 * is a NEGATIVE one — that the neighbouring cell did not flash — and a poll can only ever say
 * "not flashing now", never "never flashed". The observer says the second.
 */
async function watchFlashes(page: Page): Promise<void> {
  await page.evaluate((classes: readonly string[]) => {
    const seen: FlashRecord[] = [];
    window.__e2eFlashes = seen;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const el = record.target as HTMLElement;
        if (!classes.some((c) => el.classList.contains(c))) continue;
        const panel = el.closest('[data-panel]')?.getAttribute('data-panel') ?? '?';
        const subject = el.getAttribute('data-subject') ?? '-';
        const column = el.getAttribute('data-col') ?? el.getAttribute('data-field') ?? '-';
        seen.push({ key: `${panel}/${subject}/${column}`, className: el.className });
      }
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }, FLASH_CLASSES);
}

/**
 * Which cells have flashed since {@link watchFlashes} — the distinct set, in first-seen order.
 *
 * Distinct, because one flash can be two class writes: re-triggering a cell that is still lit
 * removes the class and re-adds it, deliberately, since re-adding a class an element already has
 * does not restart a CSS animation (`grid/flash.ts#trigger`). Both writes are separate mutation
 * records and a `MutationObserver` delivers them in one batch, after both have landed, so both read
 * as "this cell is flashing". Counting the writes would be counting an implementation detail; the
 * claim this spec makes — and the one a repainting grid would break — is about WHICH cells lit.
 */
async function flashesSeen(page: Page): Promise<FlashRecord[]> {
  const records = await page.evaluate(() => window.__e2eFlashes ?? []);
  const byKey = new Map<string, FlashRecord>();
  for (const record of records) {
    const already = byKey.get(record.key);
    if (already === undefined) byKey.set(record.key, record);
    else already.className = `${already.className} ${record.className}`;
  }
  return [...byKey.values()];
}

/** How many elements carry a flash class at this instant. */
async function litNow(page: Page): Promise<number> {
  return page.evaluate(
    (classes: readonly string[]) => document.querySelectorAll(classes.map((c) => `.${c}`).join(',')).length,
    FLASH_CLASSES,
  );
}

/* ---------------------------------------------------------------------------------------------- */

test.describe('WP-15 live grid — TERM-08 flash, TERM-12 states', () => {
  // The same reset `smoke.spec.ts` takes, for the same reason: merely LOADING the terminal rewrites
  // `pm`'s workspace, and one of those rewrites is a live defect (`resetWorkspace`'s docstring). A
  // spec whose grid depends on which spec ran before it is a spec whose result is an accident.
  test.beforeEach(async () => {
    await resetWorkspace(E2E_USERS.pm.email);
  });

  test('a delta flashes the cell whose number moved, and only that cell (TERM-08)', async ({
    page,
  }) => {
    const plant = await interposePlant(page);
    await openWatchlist(page);
    await plant.opened;

    const subject = await aaplSubject(page);
    const price = cellOf(page, subject, 'PX_LAST');
    const change = cellOf(page, subject, 'CHG_PCT_1D');

    // The number the seeded screen is showing — `330.27`, the last of the one recorded Cboe poll.
    // Parsed rather than asserted so the flash below is provably a MOVE from what was on screen.
    const before = Number((await price.textContent())?.replace(/[^\d.-]/g, ''));
    expect(before, 'the watchlist is not showing a price to move').toBeGreaterThan(0);
    const changeBefore = await change.textContent();

    // 1. A snapshot at the values already on screen. This is the subscribe-and-snap the plant would
    //    send if step 8 were wired; it puts both cells into `live` and seeds `QuoteCache` with the
    //    `seq` the delta will chain onto. The percent is re-stated to two decimals, which is all the
    //    DOM carries, so this frame may itself flash the change cell — hence the settle below.
    const capturedAt = Date.now();
    plant.send(
      snapFrame(subject, { PX_LAST: before, CHG_PCT_1D: Number(changeBefore?.replace(/[^\d.-]/g, '')) }, capturedAt),
    );
    await expect(price, 'the snapshot did not reach the cell').toHaveAttribute('data-st', 'live');
    await expect(change).toHaveAttribute('data-st', 'live');

    // 2. Let every flash the snapshot caused expire. `grid/flash.ts` guarantees this: `animationend`
    //    normally, and the registry's per-frame/per-second sweep as the backstop. Asserting it here
    //    is therefore also the assertion that a flash ENDS — a cell left permanently lit says "this
    //    just changed" about a number that has not moved, which is worse than no flash at all.
    await expect
      .poll(async () => litNow(page), {
        message: 'a flash outlived 3 × --flash-ms — grid/flash.ts’s sweep is not clearing it',
        timeout: FLASH_LIFETIME_MS + 2_000,
      })
      .toBe(0);

    // 3. Now watch, and move exactly ONE field.
    await watchFlashes(page);
    const moved = Number((before + 2.23).toFixed(2));
    plant.send(deltaFrame(subject, { PX_LAST: moved }, 2, Date.now()));

    // The value is the delta's, formatted by the client's own formatter (2 dp for a price).
    await expect(price, 'the delta did not reach the price cell').toHaveText(moved.toFixed(2));

    // …and the neighbour in the SAME ROW, on the SAME SUBJECT, did not move. A delta that named one
    // field must not restate another, or the screen shows a change nobody sent.
    await expect(change).toHaveText(changeBefore ?? '');

    // The flash itself. `data-dir` is the direction the level moved (`cellRegistry.ts#dirOf`), and
    // `flash-up` is the class `tokens.css` animates for it.
    const flashes = await flashesSeen(page);
    expect(flashes.map((f) => f.key), 'the delta lit a cell nobody sent a number for').toEqual([
      `p4/${subject}/PX_LAST`,
    ]);
    expect(flashes[0]?.className).toContain('flash-up');
    await expect(price).toHaveAttribute('data-dir', 'up');

    // And it is still `live`, with the state said in the accessible name beside the new number.
    await expect(price).toHaveAttribute('data-st', 'live');
    await expect(price).toHaveAttribute('aria-label', `Last price: ${moved.toFixed(2)}, live`);

    // Finally the second direction, on the same cell, chained onto the delta above: a fall flashes
    // `flash-down`. One direction proved twice would leave `dirOf` free to return `up` always.
    await watchFlashes(page);
    const back = Number((moved - 4.5).toFixed(2));
    plant.send(deltaFrame(subject, { PX_LAST: back }, 3, Date.now()));
    await expect(price).toHaveText(back.toFixed(2));
    const down = await flashesSeen(page);
    expect(down.map((f) => f.key), 'the second delta lit more than the cell it moved').toEqual([
      `p4/${subject}/PX_LAST`,
    ]);
    expect(down[0]?.className).toContain('flash-down');
    await expect(price).toHaveAttribute('data-dir', 'down');
  });

  test('every value state is said in words at the point of use (TERM-12, ENTL-05)', async ({
    page,
  }) => {
    await openWatchlist(page);
    // The other three panels are drawn too; this assertion is about the whole workspace, because
    // ENTL-05 is a property of every rendered value and not of one grid.
    await expect(page.locator('[data-panel="p1"]')).toContainText('31 rows', { timeout: 30_000 });

    const audit = await page.evaluate((phrase: Record<string, string>) => {
      const states: Record<string, { total: number; said: number; numbersInBlank: number; texts: string[] }> = {};
      // Two exclusions, both named rather than filtered quietly:
      //
      //  * the status bar is outside `[data-panel]` already — it carries one SAMPLE cell per state
      //    as its legend (`StatusBar.tsx`), and a legend is a picture of a value, not a value;
      //  * `.chart__legend-value` is excluded here. CLIENT §12.1 names the chart legend as a fourth
      //    surface applying the same mapping, and on the seeded GP panel it does not: it renders
      //    `<span class="chart__legend-value" data-st="stale">—</span>` — an em dash, no accessible
      //    name, no phrase — which is byte-identical to how it would render a `blank`. That is a
      //    finding against WP-14's legend, reported as one; it is not this test's subject, and
      //    folding it in would mean either weakening the assertion for every cell or failing this
      //    test for a defect in a different widget.
      for (const el of document.querySelectorAll('[data-panel] [data-st]:not(.chart__legend-value)')) {
        const st = el.getAttribute('data-st') ?? '?';
        const entry = (states[st] ??= { total: 0, said: 0, numbersInBlank: 0, texts: [] });
        entry.total += 1;
        const label = el.getAttribute('aria-label') ?? '';
        const text = (el.textContent ?? '').trim();
        const wanted = phrase[st];
        // Two surfaces, two places the words live, and both count as said. The imperative grid cell
        // carries them in its accessible name, because `cellRegistry` owns that element and a label
        // is one attribute write (`cellRegistry.ts#cellLabel`); `CellView.tsx` — the `kv` and
        // `table` cells — carries them in the text itself, as `7,585.75 (stale, no fresh update)`,
        // which WP-12's audit chose deliberately so the reason cannot hide in a clipped span.
        if (wanted !== undefined && (label.endsWith(wanted) || text.includes(`(${wanted})`))) {
          entry.said += 1;
        }
        if (st === 'blank' && /\d/.test(text)) entry.numbersInBlank += 1;
        if (entry.texts.length < 3) entry.texts.push(text);
      }
      return states;
    }, STATE_PHRASE);

    // All five are on the seeded screen, which is what makes the rest of this test an assertion
    // about the product rather than about four states and a hole: `closed` (the seeded sessions),
    // `blank` (instruments with no captured quote), `na` (returns on an index with no book),
    // `stale` (the recorded Cboe poll, days old) and `live` (the computed RATIO row).
    for (const state of Object.keys(STATE_PHRASE)) {
      expect(audit[state]?.total ?? 0, `no cell on the seeded workspace renders \`${state}\``).toBeGreaterThan(0);
    }

    // Each one SAYS which it is. A colour cannot be read by a screen reader and cannot be
    // distinguished by the 8 % of male traders with a red-green deficiency, so CLIENT §12.1's
    // mapping has to reach words — every cell, not a sampled one.
    for (const [state, phrase] of Object.entries(STATE_PHRASE)) {
      const entry = audit[state];
      expect(
        entry?.said ?? -1,
        `cells rendering \`${state}\` that never say "${phrase}" — sample: ${JSON.stringify(entry?.texts ?? [])}`,
      ).toBe(entry?.total ?? -2);
    }

    // ENTL-05: a blank is never a number. A denied or unknown value that printed its last known
    // price in grey would be the whole failure the rule exists to prevent.
    expect(audit.blank?.numbersInBlank, 'a `blank` cell printed a number').toBe(0);

    // `na` and `stale` share the `·` glyph by design — CLIENT §12.1 specifies it for both and
    // BUILD_STATUS.md carries it as an open, deliberate WP-12 finding. So the distinction CANNOT be
    // asserted visually, and asserting it visually is how this test would silently start passing for
    // the wrong reason. It is asserted where the difference actually lives: the words.
    expect(STATE_PHRASE.na).not.toBe(STATE_PHRASE.stale);
    const phrases = Object.values(STATE_PHRASE);
    expect(new Set(phrases).size, 'two value states are spoken with the same phrase').toBe(phrases.length);
  });

  // ── A DEFECT, recorded rather than hidden ───────────────────────────────────────────────────
  //
  // `test.fail()`, following `smoke.spec.ts`: it RUNS on every suite, it must fail, and the day the
  // wiring lands Playwright reports "expected to fail but passed", so the fix cannot land unnoticed
  // and this record cannot rot. The assertion is the one the product is supposed to satisfy and it
  // is not weakened by a millisecond.
  //
  // What happens. `grid/cellRegistry.ts#restyle` — the sweep's only route to the DOM — opens with
  // `if (stateOf === undefined) return;`, and `stateOf` is set by `CellRegistry.setStateSource()`,
  // whose docstring says "wsBridge calls this when the client connects". Nothing calls it:
  // `grep -rn 'setStateSource' packages/web/src` matches the definition and nothing else. So the
  // 1 s ticker runs (`wsBridge.start()` starts it), `QuoteCache.sweep` correctly flips the view to
  // `stale`, `#onSweep` correctly calls `restyle(subjects)` — and `restyle` returns on its first
  // line. The cache and the screen then disagree, silently and permanently.
  //
  // Measured on this stack, `q:85 PX_LAST` in `p4`, with a snapshot captured 28 s before it was
  // sent (so the value crosses 3 × 10 000 ms two seconds later):
  //    t+0.5 s   data-st="live"  aria-label="Last price: 330.27, live"
  //    t+4.5 s   data-st="live"  aria-label="Last price: 330.27, live"
  //    …and with `cap = now`, still "live" 46 s later, connection `LIVE` throughout.
  //
  // This is the client-side twin of BUILD_STATUS.md's startup step 9 (the server's own 1 s sweep,
  // also skipped). Either one alone would have put the badge on the screen; neither is wired, so
  // TERM-12's "a dead feed cannot leave a live number on the screen" does not hold in this build.
  test('a value goes stale when the feed stops, and says so (TERM-12)', async ({ page }) => {
    test.fail(
      true,
      'DEFECT: cellRegistry.setStateSource() is never called, so CellRegistry.restyle() returns ' +
        'immediately and the 1 s staleness sweep never reaches a cell. web/src/grid/cellRegistry.ts ' +
        'L720 + L797, rt/wsBridge.ts L531.',
    );

    const plant = await interposePlant(page);
    await openWatchlist(page);
    await plant.opened;
    const subject = await aaplSubject(page);
    const price = cellOf(page, subject, 'PX_LAST');

    // A capture 28 s old: inside 3 × 10 s, so `live` now, and past it 2 s from now. The plant warms
    // exactly this way from `quote_snapshots`, so the frame is not a contrivance — it is the last
    // print of a feed that has just gone quiet.
    const capturedAt = Date.now() - 28_000;
    plant.send(snapFrame(subject, { PX_LAST: 330.27 }, capturedAt));
    await expect(price, 'a 28 s old capture is inside the limit and must read live').toHaveAttribute(
      'data-st',
      'live',
    );

    // Nothing more is sent: this is the feed stopping. Within one sweep of crossing the limit the
    // cell must say so, in the attribute the stylesheet greys on AND in the words a reader hears.
    await expect(price, 'the cell never left `live` after the feed stopped').toHaveAttribute(
      'data-st',
      'stale',
      { timeout: 12_000 },
    );
    await expect(price).toHaveAttribute('aria-label', /stale, no fresh update$/);

    // And it is the staleness verdict that did it, not a reconnect: a socket that dropped would
    // also grey the screen (`wsBridge`'s resync path), for a different reason, and this test would
    // be passing on a failure it was not written to find.
    await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'LIVE');
  });
});
