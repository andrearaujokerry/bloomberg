// packages/e2e/tests/smoke.spec.ts — WP-01 acceptance test (WORKPLAN §1.11).
//
// "Playwright starts the replay-mode server, loads `/`, sees the command line."
//
// The two `webServer` entries in `playwright.config.ts` bring up the plant
// (`PROVIDER_MODE=replay`, `DATABASE_URL=…bloomberg_test`, `fixtures/serverProcess.ts`) and the vite
// dev server whose proxy forwards `/api` and `/ws` to it. This spec is the proof that the whole
// chain — plant, proxy, bundle, React root, command line — is wired end to end. Everything below is
// driven over the wire: `packages/e2e` never imports package source (WORKPLAN §1.2), which is why
// the only local import is this package's own server fixture.
//
// It deliberately asserts nothing about market data: WP-01 ships a scaffold shell whose command
// line echoes what was typed. Function execution arrives with the shell work package.

import { expect, test } from '@playwright/test';

import { HEALTH_URL, SERVER_URL, WEB_URL } from '../fixtures/serverProcess.js';

/** `data-testid="command-line"` on the `<input>` of `packages/web/src/App.tsx`. */
const COMMAND_LINE = '[data-testid="command-line"]';

test.describe('WP-01 smoke', () => {
  test('the replay-mode plant is up and healthy', async ({ request }) => {
    // API.md §5.15: `503 STARTING` until startup step 8, `200` afterwards. `playwright.config.ts`
    // already waited on this URL, so by now it must be the `200`.
    const res = await request.get(HEALTH_URL);
    expect(res.status(), `GET ${HEALTH_URL}`).toBe(200);

    const body = (await res.json()) as {
      status: string;
      db: boolean;
      plant: boolean;
      migrationsPending: number;
    };
    expect(['ok', 'degraded']).toContain(body.status);
    expect(body.db, 'the plant has no database connection').toBe(true);
    expect(body.migrationsPending, 'the test database is behind the migrations').toBe(0);
  });

  test('the web app loads at /', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status(), `GET ${WEB_URL}/`).toBeLessThan(400);

    // index.html: <title>TERMINAL</title>, and <html data-theme="dark" data-density="normal">.
    await expect(page).toHaveTitle('TERMINAL');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-density', 'normal');

    // main.tsx mounts the React root into #root; an empty #root means the bundle threw.
    await expect(page.locator('#root')).not.toBeEmpty();
  });

  test('the command line is present, focused and accepts input', async ({ page }) => {
    await page.goto('/');

    const commandLine = page.locator(COMMAND_LINE);
    await expect(commandLine).toBeVisible();
    // The terminal is keyboard-first: App.tsx focuses the command line on mount, so a user can
    // type a function code without touching the pointer.
    await expect(commandLine).toBeFocused();
    await expect(commandLine).toHaveAttribute('aria-label', 'Command line');
    await expect(commandLine).toHaveAttribute('placeholder', /GO/);

    // Found by role too, not only by test id — the accessible name is part of the contract.
    await expect(page.getByRole('textbox', { name: 'Command line' })).toBeVisible();

    await page.keyboard.type('AAPL US Equity DES');
    await expect(commandLine).toHaveValue('AAPL US Equity DES');

    // <GO> is Enter. The scaffold shell echoes the entry uppercased and clears the line; the
    // function registry arrives with WP-12.
    await page.keyboard.press('Enter');
    await expect(commandLine).toHaveValue('');
    await expect(page.getByTestId('panel-frame')).toContainText('AAPL US EQUITY DES');

    // Escape clears the line without submitting (CLIENT.md §5).
    await page.keyboard.type('GP');
    await page.keyboard.press('Escape');
    await expect(commandLine).toHaveValue('');
  });

  test('the shell surfaces the session state the plant reported', async ({ page }) => {
    // App.tsx asks `GET /auth/session` through the SDK before anything else runs, and the status
    // bar always shows the outcome — authenticated, signed out, or plant unavailable. Whichever it
    // is, it must not still say "checking…": that would mean the request never resolved, i.e. the
    // vite `/api` proxy is not reaching the plant.
    await page.goto('/');
    const statusBar = page.getByTestId('status-bar');
    await expect(statusBar).toBeVisible();
    await expect(statusBar).not.toContainText('checking…', { timeout: 15_000 });
    await expect(statusBar).toContainText('HELP for assistance');
  });

  test('the page reaches the plant only through the SDK origin', async ({ page }) => {
    // API-05 at runtime, complementing the static check in packages/web/test/no-direct-io.test.ts:
    // every request the page makes goes to its own origin, and the API ones are the proxied
    // `/api/v1/*` paths — never a direct cross-origin call to the plant.
    const offOrigin: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url.startsWith('blob:')) return;
      if (!url.startsWith(WEB_URL)) offOrigin.push(`${req.method()} ${url}`);
    });

    await page.goto('/');
    await expect(page.locator(COMMAND_LINE)).toBeVisible();
    await page.waitForLoadState('networkidle');

    expect(offOrigin, `the page talked to an origin other than ${WEB_URL}`).toEqual([]);
    // Sanity: the plant's own origin is a different one, so the assertion above has teeth.
    expect(SERVER_URL).not.toBe(WEB_URL);
  });
});
