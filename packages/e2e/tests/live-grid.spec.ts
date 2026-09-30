// packages/e2e/tests/live-grid.spec.ts — the live grid (TERM-08, TERM-12, ENTL-05).
//
// WORKPLAN WP-15's row: "QM flashes on a replayed session; staleness badge appears after the feed
// stops". Four tests, and all but the first are about what a trader SEES rather than about which call
// was made:
//
//   1. the panel asks the plant for the rows it is showing — the one claim here that is about a frame
//      the app SENDS, because a grid nobody subscribed looks exactly like a grid whose feed is quiet;
//   2. a delta on a subject moves ONE number, so exactly one cell flashes — the assertion that
//      fails if the grid repaints a row, or a screen, instead of a cell (CLIENT.md §10.4);
//   3. a value whose state is not `live` SAYS which state it is, in words, at the point of use —
//      CLIENT.md §12.1's table, and the half of TERM-12 that a colour alone cannot carry;
//   4. and a value whose feed stopped goes stale within a second and says that too (TERM-12).
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
// Two things this spec found and reported as defects when it was written, both since fixed, and both
// now asserted here rather than described:
//
//   * **No grid subject was ever subscribed.** `state/subscriptions.ts#acquire` — which turns a
//     screen's `LiveSpec` into `sub` frames — had no product caller: the only `sub` the app sent was
//     `ChartCanvas`'s, so a loaded workspace subscribed `q:<id> PX_LAST` for the GP panel and nothing
//     at all for the three grids. `shell/Panel.tsx` makes the call now, and the first test below
//     reads the frames the browser sends and asserts a `sub` for the watchlist's own subjects and
//     fields. What made the rest of this spec possible before the fix is unchanged and still true:
//     the grid's cells are registered with their `data-subject`, so a delta that reaches the socket
//     is applied and painted whether or not the browser asked for it.
//   * **The staleness sweep never reached a cell.** `cellRegistry.ts#restyle` returned on its first
//     line because nothing called `setStateSource()`. `rt/wsBridge.ts#attach` does it now, out of the
//     `QuoteCache` the bridge already holds; the last test below carried that defect as a `test.fail`
//     for one package and is a required assertion again.
//
// Nothing below is weakened to fit either. The frames are constructed to the letter of
// `sdk/src/wire/ws.ts` (itself verbatim from API.md §6.2), and every assertion is the one the product
// is supposed to satisfy.

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

/** One `sub` frame the BROWSER sent, decoded (`sdk/src/wire/ws.ts`'s `ClientMsg`). */
interface SubFrame {
  t: 'sub';
  id: number;
  subjects: { s: string; f: string[]; essential?: boolean }[];
}

interface Interposed {
  /** Add a frame to what the browser receives. */
  send: SendFrame;
  opened: Promise<void>;
  /** Every `sub` the app has sent so far, in order — what the plant was actually asked for. */
  subs: () => SubFrame[];
  /**
   * The last `seq` and `tier` the PLANT sent for a subject, or `undefined` before it sent anything.
   *
   * Needed because the grids now subscribe: the plant answers a `sub` with a real `snap`, so
   * `QuoteCache` already holds the subject by the time a test wants to move it, and a delta has to
   * chain onto THAT `seq` (§6.3 step 3 — get `prev` wrong and the cache refuses the frame and asks
   * for a resync). It is also why a snapshot restating the values already on screen no longer
   * repaints anything: `QuoteCache.#applySnap` reports only the fields that CHANGED, and against the
   * plant's own snapshot nothing has.
   */
  serverState: (subject: string) => { seq: number; tier: string } | undefined;
  /** `t:subject` for every frame the plant sent, capped — what a failure message needs to be useful. */
  serverFrames: () => string[];
}

/**
 * Put this spec between the browser and the plant, transparently, and hand back both directions:
 * a way to add a frame to what the browser receives, and a record of what the browser asked for.
 *
 * Installed BEFORE `goto`: `LiveClient` opens its socket during the first render, and a route
 * registered afterwards would watch a connection it never saw the `hello` of.
 *
 * The sent frames are recorded here rather than with `page.on('websocket')` because this route is
 * already the one place both directions pass through, and because a `routeWebSocket` handler
 * SUPPRESSES the `websocket` event for the connection it intercepts.
 */
async function interposePlant(page: Page): Promise<Interposed> {
  let route: WebSocketRoute | undefined;
  let announce: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const subs: SubFrame[] = [];
  const fromPlant = new Map<string, { seq: number; tier: string }>();
  const plantFrames: string[] = [];

  await page.routeWebSocket(WS_ROUTE, (ws) => {
    route = ws;
    // The real plant, still: the session's `hello`, its `subAck` and its snapshots all go through
    // untouched. Interposing must not become mocking, or the assertions stop being about the app
    // that ships.
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      // Recorded, then forwarded unchanged. A frame this spec failed to parse is a frame the plant
      // still receives: the record is an observation, never a filter.
      if (typeof message === 'string') {
        try {
          const frame = JSON.parse(message) as { t?: unknown };
          if (frame.t === 'sub') subs.push(frame as unknown as SubFrame);
        } catch {
          /* not JSON — the plant will say so, and this spec has nothing to add. */
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      // Observed on the way past, exactly as the browser-bound half is: what the plant said about a
      // subject is what a delta added to this stream has to be consistent with.
      //
      // Unwrapped, because the snapshot burst does not arrive as bare `snap`s. `server/src/ws/
      // session.ts` L951 sends `{ t: 'batch', m: [...] }` — "one `snap` per accepted subject, inside
      // `batch` frames, split at the cap" — so a reader that only looked at the envelope's own `t`
      // would conclude the plant had sent nothing about any subject at all. It is the same shape
      // `LiveClient` unwraps; this spec has to do the same or it is watching a different stream.
      if (typeof message === 'string') {
        try {
          const outer = JSON.parse(message) as { t?: unknown; m?: unknown };
          const frames: unknown[] = outer.t === 'batch' && Array.isArray(outer.m) ? outer.m : [outer];
          for (const item of frames) {
            const frame = item as { t?: unknown; s?: unknown; seq?: unknown; tier?: unknown };
            if (plantFrames.length < 80) {
              plantFrames.push(`${String(frame.t)}${typeof frame.s === 'string' ? ` ${frame.s}` : ''}`);
            }
            if (
              (frame.t === 'snap' || frame.t === 'delta') &&
              typeof frame.s === 'string' &&
              typeof frame.seq === 'number'
            ) {
              const previous = fromPlant.get(frame.s);
              fromPlant.set(frame.s, {
                seq: frame.seq,
                tier: typeof frame.tier === 'string' ? frame.tier : (previous?.tier ?? 'unknown'),
              });
            }
          }
        } catch {
          /* not JSON — the client will say so, and this spec has nothing to add. */
        }
      }
      ws.send(message);
    });
    announce();
  });

  return {
    opened,
    subs: () => [...subs],
    serverState: (subject) => fromPlant.get(subject),
    serverFrames: () => [...plantFrames],
    send: (frame) => {
      if (route === undefined) throw new Error('the app has not opened /ws/v1 yet');
      route.send(JSON.stringify(frame));
    },
  };
}

/**
 * `Snap` (`wire/ws.ts`): every member is required, so every member is stated.
 *
 * TWO THINGS ABOUT IT CHANGED when the panels started subscribing, and both are forced by the
 * product rather than chosen here:
 *
 *   * **`seq` is a parameter now, taken from the plant's own snapshot.** The plant answers a `sub`
 *     with a real `snap`, so `QuoteCache` already holds the row at the plant's `seq` when this frame
 *     arrives; the deltas that chain onto this one must be above it (`#applyDelta`: `seq <= lastSeq`
 *     is a duplicate and is dropped).
 *   * **The values it carries must DIFFER from the ones the plant sent.** `QuoteCache.#applySnap`
 *     reports only the fields that changed against the previous view, and `cellRegistry` writes only
 *     the fields reported changed — deliberately, so a conflated frame restating a static price does
 *     not flash it. A snapshot at the values already on screen therefore repaints nothing at all, and
 *     that is what it did: both tests below failed on `data-st="stale"` the first time they ran
 *     against a subscribing grid. Each one moves the field it is about.
 *
 * `session: 'open'` and `tier: 'delayed'` are still this frame's own, and that is the point of still
 * injecting one rather than leaning on the plant's: the staleness arithmetic below is 3 × 10 s over a
 * `delayed` line in an OPEN session (`core/quote/staleness.ts`), and a seeded session that happened
 * to be `closed` would make `valueState` answer `closed` — a different verdict, correctly, and not
 * the one TERM-12's "the feed stopped" case is about.
 */
function snapFrame(
  subject: string,
  fields: Record<string, number>,
  capturedAt: number,
  seq: number,
): Record<string, unknown> {
  return {
    t: 'snap',
    s: subject,
    seq,
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

/**
 * The plant's own last word about a subject, once it has stopped talking.
 *
 * Four panels subscribe, several of them overlapping, and every `sub` is answered with a `snap`, so a
 * subject's `seq` moves a few times in the first second of the session. Two identical readings is
 * what "the plant has finished" looks like from outside; taking the first reading instead would race
 * a later snapshot, and a delta chained onto a superseded `seq` is a gap, not a tick.
 */
async function plantSnapshot(
  plant: Interposed,
  subject: string,
): Promise<{ seq: number; tier: string }> {
  let last: { seq: number; tier: string } | undefined;
  await expect
    .poll(
      () => {
        const now = plant.serverState(subject);
        const settled = now !== undefined && now.seq === last?.seq;
        last = now;
        return settled;
      },
      {
        message: `the plant sent no snapshot for ${subject} — is the panel subscribing it?`,
        timeout: 20_000,
      },
    )
    .toBe(true)
    .catch((error: unknown) => {
      // What it DID send, because "no snapshot" has several causes and they are told apart by the
      // frames that arrived instead: a `subAck` that rejected the subject, a `status`, or nothing.
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nframes from the plant: ` +
          `${plant.serverFrames().join(', ')}`,
      );
    });
  if (last === undefined) throw new Error(`no plant state for ${subject}`);
  return last;
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

  /**
   * The subscription itself, asserted on the wire rather than inferred from a repaint.
   *
   * Until `shell/Panel.tsx` made the call, the app's answer to "what does this screen want off the
   * plant?" was nothing: the grids drew their payload and no `sub` frame ever named a row of them.
   * That is unobservable from the DOM — a grid with no subscription looks exactly like a grid whose
   * feed is quiet, which is the whole reason it survived fifteen packages — so this test reads the
   * frames the BROWSER sends, through the same interposed socket the rest of the file uses.
   *
   * The expectation is taken from the screen on the page, not written down: every subject the grid
   * drew a live-addressed cell for must appear in a `sub`, and the fields asked for that subject must
   * cover every dictionary column it drew. A spec that named `q:85 PX_LAST` would keep passing if the
   * panel subscribed one row of twenty-five.
   */
  test('the grid tells the plant what it is showing — a sub for every row it drew', async ({ page }) => {
    const plant = await interposePlant(page);
    await openWatchlist(page);
    await plant.opened;

    // What is on screen: per row, the subject its cells are addressed to and the columns it drew.
    const drawn = await page.evaluate((selector: string) => {
      const byRow = new Map<string, Set<string>>();
      for (const el of document.querySelectorAll(`${selector} [data-subject][data-col]`)) {
        const subject = el.getAttribute('data-subject') ?? '';
        const columns = byRow.get(subject) ?? new Set<string>();
        columns.add(el.getAttribute('data-col') ?? '');
        byRow.set(subject, columns);
      }
      return [...byRow].map(([subject, columns]) => ({ subject, columns: [...columns] }));
    }, WATCHLIST);

    // A FORMULA row has no plant subject at all: `server/src/functions/W/resolve.ts` L12-13 gives it
    // `subject: ''` and `deps` instead — the subjects its inputs are on, which is what W's `live`
    // unions in so the computed cell moves when either input does. `W · Core`'s fifth row is
    // `RATIO(AAPL US Equity, SPX Index)`, so one of the subjects collected above is the empty string,
    // and it is excluded here by the wire grammar rather than by count: a subject the plant cannot be
    // asked for is not a row this assertion is about. Measured on the seeded desk: five rows drawn,
    // four wire subjects.
    const rows = drawn.filter((row) => /^[a-z0-9]+:[A-Za-z0-9_.:-]+$/.test(row.subject));
    expect(rows.length, 'the watchlist drew no live-addressed cells').toBeGreaterThan(1);

    /** Subject → the union of the fields some `sub` frame named for it. */
    const asked = (): Map<string, Set<string>> => {
      const out = new Map<string, Set<string>>();
      for (const frame of plant.subs()) {
        for (const entry of frame.subjects) {
          const fields = out.get(entry.s) ?? new Set<string>();
          for (const field of entry.f) fields.add(field);
          out.set(entry.s, fields);
        }
      }
      return out;
    };

    // Polled, not awaited once: the subscription is made after the payload paints, and this is the
    // one assertion in the file about a frame the app sends on its own schedule.
    await expect
      .poll(() => JSON.stringify(rows.filter((row) => !asked().has(row.subject)).map((r) => r.subject)), {
        message: 'rows the watchlist drew that the app never sent a `sub` for',
        timeout: 15_000,
      })
      .toBe('[]');

    // Every dictionary column a row drew is in the field mask for THAT row's subject.
    //
    // Per row, not sampled on one, because of what the seeded desk happens to contain: `W · Core`'s
    // third row is SPX, and p3 of the same workspace is `GP · SPX Index`, whose chart subscribes the
    // SAME subject asking for `PX_LAST` alone. A `sub` REPLACES the plant's field mask for a subject,
    // so before the grids subscribed, the chart's narrow `sub` was the last word and the watchlist's
    // `CHG_PCT_1D` cell for SPX went `— unavailable` (`smoke.spec.ts`'s chart `test.fail` records
    // it). `SubscriptionManager#desiredFields` unions across holders; this is the assertion that the
    // union is what the plant is told, on the one subject where two panels disagree.
    const fields = asked();
    for (const row of rows) {
      const asFields = [...(fields.get(row.subject) ?? [])];
      for (const column of row.columns.filter((c) => /^[A-Z][A-Z0-9_]*$/.test(c))) {
        expect(
          asFields,
          `${row.subject} was subscribed without the field its \`${column}\` cell shows`,
        ).toContain(column);
      }
    }
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

    // 1. The plant's own snapshot of this row first — the one the panel's `sub` provoked, which is
    //    the evidence the subscription happened at all — and then a snapshot of this spec's own on
    //    top of it, one `seq` higher and at MOVED values, which puts both cells into `live` on a
    //    session and a tier this spec controls. Both cells have to move or the unmoved one is not
    //    written at all and never reads `live`; see `snapFrame`'s header.
    const snapshot = await plantSnapshot(plant, subject);
    const seeded = Number((await price.textContent())?.replace(/[^\d.-]/g, ''));
    expect(seeded, 'the watchlist is not showing a price at all').toBeGreaterThan(0);
    const seededChange = Number((await change.textContent())?.replace(/[^\d.-]/g, ''));
    plant.send(
      snapFrame(
        subject,
        { PX_LAST: Number((seeded + 1.5).toFixed(2)), CHG_PCT_1D: Number((seededChange + 0.25).toFixed(2)) },
        Date.now(),
        snapshot.seq + 1,
      ),
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

    // 3. Now watch, and move exactly ONE field. Both numbers are re-read here, after the snapshot
    //    landed, so `moved` is provably a MOVE from what is on the screen and the neighbour assertion
    //    below is about what the DELTA did rather than about what the snapshot did.
    const before = Number((await price.textContent())?.replace(/[^\d.-]/g, ''));
    expect(before, 'the watchlist is not showing a price to move').toBeGreaterThan(0);
    const changeBefore = await change.textContent();
    await watchFlashes(page);
    const moved = Number((before + 2.23).toFixed(2));
    plant.send(deltaFrame(subject, { PX_LAST: moved }, snapshot.seq + 2, Date.now()));

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
    plant.send(deltaFrame(subject, { PX_LAST: back }, snapshot.seq + 3, Date.now()));
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
    // THE `live` CELL IS MANUFACTURED HERE, AND IT HAS TO BE.
    //
    // This test asserts that all five `ValueState`s are present on screen before asserting that each
    // says which it is, so that it is a statement about the product and not about four states and a
    // hole. Four of the five come from the seeded desk. The fifth used to come from `W · Core`'s
    // computed `RATIO(...)` row — and that row was `live` because `W`'s resolver stamped a literal
    // `'live'` on every formula cell, while both of the prices it divides read "stale, no fresh
    // update". It was TERM-12's own clause, and this test was resting on it: when the resolver
    // started reporting the worst state of the inputs it read, the seeded workspace had no `live`
    // cell left and this assertion failed with `no cell on the seeded workspace renders \`live\``.
    //
    // Which is correct. The replay plant's last capture is days old, so NOTHING on the seeded desk is
    // legitimately live, and a spec that needs a live cell has to produce one the way a live cell is
    // produced — a fresh frame on the socket, at this spec's own capture instant, exactly as the two
    // tests above do. Reading the `live` row off a resolver's constant is how this test came to be
    // green about a cell the whole file exists to catch.
    const plant = await interposePlant(page);
    await openWatchlist(page);
    await plant.opened;
    // The other three panels are drawn too; this assertion is about the whole workspace, because
    // ENTL-05 is a property of every rendered value and not of one grid.
    await expect(page.locator('[data-panel="p1"]')).toContainText('31 rows', { timeout: 30_000 });

    const subject = await aaplSubject(page);
    const price = cellOf(page, subject, 'PX_LAST');
    const snapshot = await plantSnapshot(plant, subject);
    const seeded = Number((await price.textContent())?.replace(/[^\d.-]/g, ''));
    expect(seeded, 'the watchlist is not showing a price to move').toBeGreaterThan(0);
    // A MOVED value, or `QuoteCache` reports no changed field and the cell is never rewritten
    // (`snapFrame`'s header).
    plant.send(
      snapFrame(subject, { PX_LAST: Number((seeded + 1.75).toFixed(2)) }, Date.now(), snapshot.seq + 1),
    );
    await expect(price, 'the injected snapshot did not reach the cell').toHaveAttribute(
      'data-st',
      'live',
    );

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

    // All five are on the screen, which is what makes the rest of this test an assertion about the
    // product rather than about four states and a hole: `closed` (the seeded sessions), `blank`
    // (instruments with no captured quote), `na` (returns on an index with no book), `stale` (the
    // recorded Cboe poll, days old) and `live` (the frame this test just sent — see the note at the
    // top about why it is not the computed `RATIO` row any more).
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

  // ── A DEFECT THAT WAS RECORDED HERE AS A `test.fail` FOR ONE PACKAGE, NOW A REQUIRED ASSERTION ──
  //
  // What it was. `grid/cellRegistry.ts#restyle` — the sweep's only route to the DOM — opens with
  // `if (stateOf === undefined) return;`, and `stateOf` is set by `CellRegistry.setStateSource()`,
  // whose docstring said "wsBridge calls this when the client connects". Nothing called it. So the
  // 1 s ticker ran (`wsBridge.start()` starts it), `QuoteCache.sweep` correctly flipped the view to
  // `stale`, `#onSweep` correctly called `restyle(subjects)` — and `restyle` returned on its first
  // line. The cache and the screen disagreed, silently and permanently, and what was measured on this
  // stack for `q:85 PX_LAST` in `p4` was `data-st="live"`, `aria-label="…, 330.27, live"`, 46 s after
  // the last frame.
  //
  // What fixed it. `rt/wsBridge.ts#attach` installs the source as it attaches the registry — a closure
  // over the `QuoteCache` the bridge already owns, which is the only object in the client that holds a
  // subject's verdict (TERM-04 allows exactly one). Attaching is the right moment and connecting was
  // not: `App` builds the bridge before the first grid mounts.
  //
  // The assertion below has not been touched. It is the one the product was always supposed to
  // satisfy, and it is the client-side half of TERM-12 — the server's own 1 s sweep is startup step 9,
  // still deferred (BUILD_STATUS.md), so this is the only thing standing between a dead feed and a
  // live number on a trader's screen.
  test('a value goes stale when the feed stops, and says so (TERM-12)', async ({ page }) => {
    const plant = await interposePlant(page);
    await openWatchlist(page);
    await plant.opened;
    const subject = await aaplSubject(page);
    const price = cellOf(page, subject, 'PX_LAST');

    // A capture 28 s old, at a price the plant did not send, one `seq` above the plant's own snapshot
    // of this row: inside 3 × 10 s, so `live` now, and past it 2 s from now. The plant warms exactly
    // this way from `quote_snapshots`, so the frame is not a contrivance — it is the last print of a
    // feed that has just gone quiet.
    //
    // `plantSnapshot` first, for the `seq`: the panel subscribes this row now, so the plant has
    // already snapped it and `QuoteCache` already holds it. The moved price is the other consequence
    // of that — see `snapFrame`'s header — and the 28 s is arithmetic over `snapFrame`'s own
    // `tier: 'delayed'` (expected every 10 s, stale at 3 × that: `core/quote/staleness.ts`).
    const snapshot = await plantSnapshot(plant, subject);
    const seeded = Number((await price.textContent())?.replace(/[^\d.-]/g, ''));
    expect(seeded, 'the watchlist is not showing a price at all').toBeGreaterThan(0);
    plant.send(
      snapFrame(
        subject,
        { PX_LAST: Number((seeded + 1.5).toFixed(2)) },
        Date.now() - 28_000,
        snapshot.seq + 1,
      ),
    );
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
