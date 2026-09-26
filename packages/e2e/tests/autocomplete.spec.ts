// packages/e2e/tests/autocomplete.spec.ts — per-keystroke ranking and its budget (TERM-02).
//
// WORKPLAN WP-15's row: "per-keystroke ranking under the 80 ms budget via `/api/v1/status`
// timings". The budget is CLIENT.md §16.1's two rows:
//
//   | keystroke → visual feedback | ≤ 16 ms for 95 % of keystrokes |
//   | autocomplete result set     | local ≤ 16 ms; server fallback ≤ 80 ms incl. 60 ms debounce; ≤ 80 ms p95 |
//
// ## Neither timing source named in the plan exists, so this spec measures it itself
//
// Both were checked before anything was written, and both are absent rather than merely quiet:
//
//   * `GET /api/v1/status` → `timings.autocompleteP95Ms` is the literal constant `0`.
//     `server/src/http/routes/status.ts`'s header says so in as many words — "no client or server
//     timer writes either one anywhere. **Not measured: 0.**" — which is the right way to report an
//     unmeasured figure, and it means a spec asserting `autocompleteP95Ms < 80` would be asserting
//     `0 < 80` for the life of the product. That is the tenth could-not-fail test this build was
//     warned about, and it is not in this file.
//   * `window.__terminalPerf` (CLIENT §16.2's ring buffer of the last 2 000 measures, with
//     `p50/p95/p99` accessors "for Playwright") is `undefined` on the running app, and
//     `packages/web/src/perf/marks.ts` does not exist: `grep -rn 'performance.mark' packages/web/src`
//     finds nothing. No `cmd:input`, no `ac:paint`, no `ac` measure. Reported as a finding.
//
// So the measurement is taken in the browser, from the product's own DOM, by {@link installProbe}:
// the `input` event the command line raises is the keystroke, and the moment the suggestion list
// reflects it is the result set. That is the same pair of instants `cmd:input`→`ac:paint` would
// have bracketed, read off the thing the user actually sees rather than off a mark the app would
// have had to remember to emit. Nothing is imported from `packages/web` (WORKPLAN §1.2); the probe
// knows only `[data-testid="command-line"]` and the popup's `role="listbox"`.
//
// ## Why it is a p95 over a long run and not a stopwatch on one keystroke
//
// The ranking is synchronous inside the input handler (`Autocomplete.tsx#createAutocompleteEngine`
// → `rankLocal` → `parse` + `rank` over the whole universe index), so the FIRST keystroke of a
// session is not the expensive one — a one-character query is, because it matches most of 41 455
// instruments, and the twelfth keystroke of a long line is, because the parse has more to do. A
// budget asserted on one keystroke is how this build shipped a quadratic tick path (BUILD_STATUS.md
// on `grid/flash.ts`'s listener leak: "a budget asserted only on the fastest round"). This types
// three realistic command lines character by character, keeps every sample including the
// backspaces, and asserts the percentile.

import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { E2E_USERS } from '../fixtures/auth.js';
import { resetWorkspace } from '../fixtures/database.js';

/** CLIENT §16.1: keystroke → visual feedback, 95 % of keystrokes. */
const FEEDBACK_BUDGET_MS = 16;

/** CLIENT §16.1: the result set, p95 — the outer budget, which covers the server fallback too. */
const RESULT_SET_BUDGET_MS = 80;

/** `core/search` → `MAX_RESULTS`, which FUNCTIONS §3.3 fixes at twelve rows. */
const MAX_ROWS = 12;

/**
 * Between keystrokes. Faster than a person types, on purpose: a slow gap would let each keystroke's
 * work finish in its own idle browser, which is precisely the favourable sample.
 */
const KEYSTROKE_GAP_MS = 30;

/* ---------------------------------------------------------------------------------------------- */
/* The probe                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** One keystroke, measured. */
interface Sample {
  /** `input` → the suggestion list in the DOM. CLIENT §16.2's `ac` measure, `cmd:input`→`ac:paint`. */
  toRows: number;
  /** `input` → the animation frame that paints it. The browser's half, which the app does not own. */
  toFrame: number;
}

interface ProbeResult {
  samples: Sample[];
  /** Every `input` event seen, so a shrunken sample set cannot hide behind a healthy percentile. */
  keystrokes: number;
  /** Keystrokes that changed no row — see {@link installProbe}. */
  unresolved: number;
}

declare global {
  interface Window {
    __e2eAc?: ProbeResult;
  }
}

/**
 * Time every keystroke from the `input` event to the suggestion list that answers it.
 *
 * Three decisions worth stating, because each one could otherwise flatter the result:
 *
 *  1. **The clock starts in the capture phase of `input`, on the document.** That is before
 *     `CommandLine.tsx`'s own handler runs, so the parse, the rank, the React render and the DOM
 *     write are all inside the interval. Starting it in Playwright instead would add the CDP
 *     round-trip to every sample and measure the harness.
 *  2. **The clock stops on the first mutation INSIDE the popup**, not on any mutation anywhere: the
 *     status bar repaints on its own timer and the grid's registry writes cells continuously, and
 *     either would stop the clock early on a keystroke whose rows had not been computed yet.
 *  3. **A keystroke that changes no row is dropped, not counted as zero.** Those are the cheap ones
 *     — the ranker ran and produced the list that is already on screen — so dropping them removes
 *     FAST samples and makes the percentile worse, never better. They are counted separately so the
 *     test can insist the sample set is most of the run.
 */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const result: ProbeResult = { samples: [], keystrokes: 0, unresolved: 0 };
    window.__e2eAc = result;

    let startedAt: number | null = null;
    document.addEventListener(
      'input',
      (event) => {
        if (!(event.target instanceof HTMLInputElement)) return;
        if (event.target.dataset.testid !== 'command-line') return;
        if (startedAt !== null) result.unresolved += 1;
        result.keystrokes += 1;
        startedAt = performance.now();
      },
      true,
    );

    const inPopup = (node: Node | null): boolean => {
      const el = node instanceof Element ? node : node?.parentElement ?? null;
      return el !== null && (el.classList.contains('ac') || el.closest('.ac') !== null);
    };
    const touchesPopup = (record: MutationRecord): boolean => {
      if (inPopup(record.target)) return true;
      for (const node of record.addedNodes) if (inPopup(node)) return true;
      for (const node of record.removedNodes) if (inPopup(node)) return true;
      return false;
    };

    const observer = new MutationObserver((records) => {
      if (startedAt === null) return;
      if (!records.some(touchesPopup)) return;
      const start = startedAt;
      startedAt = null;
      const toRows = performance.now() - start;
      requestAnimationFrame(() => {
        result.samples.push({ toRows, toFrame: performance.now() - start });
      });
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

/** What the probe collected. Read once, at the end, so reading it cannot perturb the run. */
async function probeResult(page: Page): Promise<ProbeResult> {
  return page.evaluate(() => window.__e2eAc ?? { samples: [], keystrokes: 0, unresolved: 0 });
}

/** The `q`-th percentile by nearest-rank, which is what a budget table means by p95. */
function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}

/** p50/p95/p99/max on one line, so a failure says what the distribution was and not only that it lost. */
function distribution(values: readonly number[]): string {
  const round = (n: number): string => n.toFixed(1);
  return (
    `n=${String(values.length)} p50=${round(percentile(values, 0.5))} ` +
    `p95=${round(percentile(values, 0.95))} p99=${round(percentile(values, 0.99))} ` +
    `max=${round(Math.max(...values))} ms`
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Driving the command line                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** `data-testid="command-line"` — one per panel (`shell/CommandLine.tsx`). */
const COMMAND_LINE = '[data-testid="command-line"]';

/** The popup of the panel the shell focused on load. `p1` is `WEI` in every seeded workspace. */
function suggestions(page: Page): Locator {
  return page.getByRole('listbox', { name: 'Command suggestions p1' });
}

/**
 * Open the terminal and leave the caret in `p1`'s command line, with the universe index BUILT.
 *
 * The wait on a ranked row is the point. `command/localIndex.ts` builds the index in a worker from
 * `GET /api/v1/universe/snapshot` (41 455 instruments), and until it is ready `rankLocal` ranks
 * against an empty index — fast, and wrong. Measuring that window would be measuring a ranker with
 * nothing to rank, and asserting a ranking against it would fail for a reason that is not the
 * product's. So this types one probe query, waits for the answer only a built index can give, and
 * clears it again.
 */
async function openTerminalWithIndex(page: Page): Promise<Locator> {
  await page.goto('/');
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-panel="p4"]')).toContainText('AAPL US Equity', { timeout: 30_000 });

  const input = page.locator(COMMAND_LINE).first();
  // `App.tsx` focuses the focused panel's command line once the session is ready; this is belt and
  // braces for the case where that effect has not run yet, and costs nothing when it has.
  await input.focus();
  await expect(input).toBeFocused();

  await input.pressSequentially('AAPL', { delay: KEYSTROKE_GAP_MS });
  await expect(
    suggestions(page).getByRole('option').first(),
    'the local universe index never produced a ranked row — is the snapshot reaching the worker?',
  ).toContainText('AAPL US Equity', { timeout: 30_000 });
  await clear(page, input, 4);
  return input;
}

/** Backspace the draft away, which is how a trader clears one (CLIENT §4.1: no pointer anywhere). */
async function clear(page: Page, input: Locator, chars: number): Promise<void> {
  for (let i = 0; i < chars; i += 1) {
    await input.press('Backspace');
    await page.waitForTimeout(KEYSTROKE_GAP_MS);
  }
}

/** The rows on screen right now, top first. */
async function rows(page: Page): Promise<{ kind: string | null; primary: string; secondary: string }[]> {
  return suggestions(page)
    .getByRole('option')
    .evaluateAll((els) =>
      els.map((el) => ({
        kind: el.getAttribute('data-kind'),
        primary: el.querySelector('.ac__primary')?.textContent ?? '',
        secondary: el.querySelector('.ac__secondary')?.textContent ?? '',
      })),
    );
}

/* ---------------------------------------------------------------------------------------------- */

test.describe('WP-15 autocomplete — TERM-02', () => {
  // As in `smoke.spec.ts`: loading the terminal rewrites `pm`'s workspace, and one of those rewrites
  // is a live defect (`resetWorkspace`'s docstring). Nothing here executes a command — GO is
  // `command-line.spec.ts`'s subject — but the reset keeps this file independent of run order.
  test.beforeEach(async () => {
    await resetWorkspace(E2E_USERS.pm.email);
  });

  test('a ticker prefix ranks its security first, against the seeded universe', async ({ page }) => {
    const input = await openTerminalWithIndex(page);

    // The exact ticker is row 0 — ahead of the four leveraged ETFs whose NAMES contain "AAPL"
    // (`AAPB`, `AAPD`, `AAPE`, `AAPW` are all in the seeded universe and all match the query), which
    // is what makes this an assertion about RANKING and not about matching.
    await input.pressSequentially('AAPL', { delay: KEYSTROKE_GAP_MS });
    const aapl = await rows(page);
    expect(aapl.length, 'no suggestions for AAPL').toBeGreaterThan(1);
    expect(aapl.length, `FUNCTIONS §3.3 caps the list at ${String(MAX_ROWS)} rows`).toBeLessThanOrEqual(MAX_ROWS);
    expect(aapl[0]?.primary).toBe('AAPL US Equity');
    expect(aapl[0]?.kind).toBe('instrument');
    // The name comes from the seeded `instruments` row, so an empty database cannot satisfy this.
    expect(aapl[0]?.secondary).toContain('Apple Inc');
    await clear(page, input, 4);

    // A second ticker, because one security ranking first could be one security being popular.
    await input.pressSequentially('MSFT', { delay: KEYSTROKE_GAP_MS });
    const msft = await rows(page);
    expect(msft[0]?.primary).toBe('MSFT US Equity');
    expect(msft[0]?.secondary).toContain('Microsoft Corp');
    await clear(page, input, 4);

    // And a NAME rather than a ticker: `rank()` scores the description too (FUNCTIONS §3.3), so the
    // trader who knows the company but not the symbol still gets there. `APLE` (Apple Hospitality
    // REIT) and `AAPI` (Apple Isports) both match "Apple" and both must rank below it.
    await input.pressSequentially('Apple', { delay: KEYSTROKE_GAP_MS });
    const byName = await rows(page);
    expect(byName[0]?.primary, `"Apple" ranked ${JSON.stringify(byName.slice(0, 3))}`).toBe(
      'AAPL US Equity',
    );
    await clear(page, input, 5);

    // A function code completes against the functions, with the security on the line anchored —
    // FUNCTIONS §3.3's "only the token being completed is scored". `DES` is a Tier-1 code AND a
    // seeded ticker (`DES US Equity`, WisdomTree SmallCap Dividend), and with a security already
    // anchored the function is what row 0 must be, or GO would open a fund instead of a description.
    await input.pressSequentially('AAPL US Equity DES', { delay: KEYSTROKE_GAP_MS });
    const withFn = await rows(page);
    expect(withFn[0]?.primary).toBe('DES');
    expect(withFn[0]?.kind).toBe('function');
    expect(withFn[0]?.secondary).toContain('Security Description');
    expect(withFn.length).toBeLessThanOrEqual(MAX_ROWS);

    // The popup is wired to the input as a combobox, which is what lets the list be read out while
    // the caret stays where the next keystroke belongs (TERM-01 — focus never leaves the line).
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    await expect(input).toHaveAttribute('aria-controls', 'ac-p1');
    await expect(suggestions(page)).toBeVisible();
  });

  test('every keystroke is ranked inside the budget (TERM-02, CLIENT §16.1)', async ({ page }) => {
    // Every request the page makes while typing, so the numbers below can be attributed. §3.4 sends
    // the client to `GET /api/v1/search` only when the local index is not built or three characters
    // have produced no strong local hit; on a seeded universe with a built index that never happens,
    // and the budget measured here is therefore the local ≤ 16 ms path.
    const searches: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/search')) searches.push(request.url());
    });

    const input = await openTerminalWithIndex(page);
    // The warm-up itself DOES fall back — `openTerminalWithIndex` types into a terminal whose index
    // is still building, which is §3.4's first condition (`!ready`) and is exactly what the fallback
    // is for. Those requests are not what this test measures, so the tally starts here. (Leaving
    // them in made this assertion depend on how warm the machine was, which is a flake, not a fact.)
    searches.length = 0;
    await installProbe(page);

    // Three realistic command lines, typed and then deleted — the deletions are keystrokes too, and
    // a ranker is asked for a WIDER candidate set on the way back down than on the way up.
    for (const line of ['AAPL US Equity DES', 'MSFT US Equity GP', 'NVDA US Equity Q']) {
      await input.pressSequentially(line, { delay: KEYSTROKE_GAP_MS });
      await clear(page, input, line.length);
    }

    const result = await probeResult(page);
    const toRows = result.samples.map((s) => s.toRows);
    const toFrame = result.samples.map((s) => s.toFrame);

    // The sample set first: a percentile over four keystrokes is not a percentile, and a probe that
    // silently stopped recording would otherwise report a flawless p95 over nothing.
    expect(result.keystrokes, 'the probe saw almost no keystrokes').toBeGreaterThanOrEqual(90);
    expect(
      result.samples.length,
      `only ${String(result.samples.length)} of ${String(result.keystrokes)} keystrokes changed the list`,
    ).toBeGreaterThanOrEqual(60);

    // CLIENT §16.1 row 1: keystroke → visual feedback, 95 % of keystrokes. Measured to the DOM
    // write, which is the app's own work; the frame that paints it is the browser's and is the
    // second assertion.
    expect(percentile(toRows, 0.95), `keystroke → rows: ${distribution(toRows)}`).toBeLessThanOrEqual(
      FEEDBACK_BUDGET_MS,
    );

    // CLIENT §16.1 row 2: the result set, p95, measured to the painted frame — so this figure
    // contains the render AND the frame the user waits for, and it is still the 80 ms budget.
    expect(percentile(toFrame, 0.95), `keystroke → frame: ${distribution(toFrame)}`).toBeLessThanOrEqual(
      RESULT_SET_BUDGET_MS,
    );

    // No single keystroke may blow the outer budget either. The p95 alone would forgive one
    // keystroke in twenty taking a second, which on a command line is the one the user notices.
    expect(Math.max(...toRows), `worst keystroke: ${distribution(toRows)}`).toBeLessThanOrEqual(
      RESULT_SET_BUDGET_MS,
    );

    // Where the rows came from, and it IS asserted as zero — the comment that used to sit here said
    // the opposite of the line beneath it. With a built index, CLIENT §3.4 sends nothing to
    // `GET /api/v1/search`, so a fallback firing during this test would mean the percentiles above
    // were measured over a network round trip and the local ≤ 16 ms row would not have been tested
    // at all. The fallback is not unasserted because of this line: it has its own test below, which
    // takes the index away and proves the rows then come from the plant.
    expect(searches.length, `server fallbacks: ${JSON.stringify(searches)}`).toBe(0);
    console.log(
      `autocomplete: ${String(result.keystrokes)} keystrokes, ` +
        `${String(result.samples.length)} measured, ${String(result.unresolved)} changed no row\n` +
        `  keystroke → rows   ${distribution(toRows)}\n` +
        `  keystroke → frame  ${distribution(toFrame)}`,
    );
  });

  test('with no local index, the ranking comes from the plant (CLIENT §3.4 fallback)', async ({
    page,
  }) => {
    // The door nothing in this suite opened. §3.4 sends the client to `GET /api/v1/search` on two
    // conditions, and the first — `!ready`, the local index still building — is the path EVERY cold
    // session takes for its first second. The budget test above proves the local path and asserts
    // that the fallback did NOT fire; `openTerminalWithIndex` admits the warm-up falls back and
    // then throws those samples away. So until this test, a regression that broke the server
    // fallback outright would have been invisible to all eight spec files.
    //
    // The index is taken away rather than raced: `command/localIndex.ts` builds from
    // `GET /api/v1/universe/snapshot`, so aborting that request holds the client in `!ready` for
    // the whole test. Typing then goes to the plant on every keystroke, deterministically, instead
    // of the test trying to outrun a worker that builds 41,455 instruments in under a second.
    const searches: string[] = [];
    await page.route('**/api/v1/universe/snapshot*', (route) => route.abort());
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/search')) searches.push(request.url());
    });

    await page.goto('/');
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
    const input = page.locator(COMMAND_LINE).first();
    await input.focus();

    const answered = page.waitForResponse(
      (res) =>
        res.url().includes('/api/v1/search') &&
        new URL(res.url()).searchParams.get('q') === 'AAPL' &&
        res.status() === 200,
      { timeout: 30_000 },
    );
    await input.pressSequentially('AAPL', { delay: KEYSTROKE_GAP_MS });
    const wire = (await (await answered).json()) as {
      hits: { primary: string; secondary: string; score: number; matchedOn: string }[];
    };

    // 1 — it fired at all, and it fired at the documented route with the documented query.
    expect(searches.length, 'the client never asked the plant for a ranking').toBeGreaterThan(0);

    // 2 — the PLANT's ranking is right. The exact ticker leads the four leveraged ETFs whose NAMES
    // carry "AAPL", and it leads them on a different signal: `matchedOn: 'ticker'` at 114 against
    // `matchedOn: 'name'` at 52.5. A route that returned every match in instrument-id order would
    // satisfy "AAPL is in the list" and fail here.
    expect(wire.hits.length, 'the plant returned no hits for AAPL').toBeGreaterThan(1);
    expect(wire.hits[0]?.primary).toBe('AAPL US Equity');
    expect(wire.hits[0]?.secondary).toContain('Apple Inc');
    expect(wire.hits[0]?.matchedOn).toBe('ticker');
    expect(
      wire.hits[0]?.score ?? 0,
      `AAPL ${String(wire.hits[0]?.score)} vs ${String(wire.hits[1]?.primary)} ${String(
        wire.hits[1]?.score,
      )}`,
    ).toBeGreaterThan(wire.hits[1]?.score ?? 0);

    // 3 — and those hits are what the user is looking at. The DOM is compared with the WIRE, in
    // order, which is the assertion that ties the two halves together: a popup that fell back to an
    // empty local index would draw nothing while the plant answered perfectly, and a popup that
    // reordered the plant's answer would put the wrong row under `<GO>`.
    const painted = await rows(page);
    expect(painted.length, 'the fallback answered but nothing was drawn').toBeGreaterThan(1);
    expect(painted.length, `FUNCTIONS §3.3 caps the list at ${String(MAX_ROWS)} rows`).toBeLessThanOrEqual(
      MAX_ROWS,
    );
    expect(painted.map((r) => r.primary)).toEqual(
      wire.hits.slice(0, painted.length).map((h) => h.primary),
    );
    expect(painted[0]?.kind).toBe('instrument');

    // No timing assertion here, and the reason is not shyness. CLIENT §16.1 budgets the fallback at
    // ≤ 80 ms p95 INCLUDING a 60 ms debounce, which leaves 20 ms for a round trip; on a loopback
    // dev stack that is a measurement of the machine, not of the product, and an 80 ms p95 asserted
    // over four keystrokes is not a p95. The budget that IS measurable here — the local path — is
    // asserted by the test above.
    console.log(
      `autocomplete fallback: ${String(searches.length)} request(s), ` +
        `top hit ${String(wire.hits[0]?.primary)} score ${String(wire.hits[0]?.score)} ` +
        `(${String(wire.hits[0]?.matchedOn)})`,
    );
  });

  // ── A FINDING, recorded where the plan expected to read the numbers ──────────────────────────
  //
  // `test.fail()` and not a comment: WP-15's acceptance row says the budget is proved "via
  // `/api/v1/status` timings", and the day somebody wires the client's `launch`/`ac` measures back
  // into that route, Playwright reports "expected to fail but passed" and this file gets deleted or
  // rewritten deliberately. Until then the assertion above is the measurement, and this records
  // that the documented channel carries nothing.
  test('the status route publishes an autocomplete p95 (CLIENT §16.2)', async ({ request }) => {
    test.fail(
      true,
      'FINDING: `timings.autocompleteP95Ms` is a hard-coded 0 (routes/status.ts L460, declared in ' +
        'that file’s header as "Not measured"), and `window.__terminalPerf` / perf/marks.ts do not ' +
        'exist in packages/web. The budget is measured by this spec instead.',
    );

    const res = await request.get('/api/v1/status');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { timings: { autocompleteP95Ms: number } };
    // A real p95 over a suite that has just typed a hundred keystrokes is a positive number of
    // milliseconds. Zero is the documented placeholder, not a fast terminal.
    expect(body.timings.autocompleteP95Ms).toBeGreaterThan(0);
    expect(body.timings.autocompleteP95Ms).toBeLessThanOrEqual(RESULT_SET_BUDGET_MS);
  });
});
