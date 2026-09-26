// WP-01 scaffold, completed by WP-15 part 2 — ARCHITECTURE §3.5 L398, WORKPLAN §1.9.
//
// One browser (Google Chrome, the desk's browser), one origin (the vite dev server whose proxy
// forwards `/api` and `/ws` to the plant), and two web servers: the replay-mode plant and the app.
// Specs drive the app over the wire and never import package source.
//
// ## The four things WP-15 had to add before a spec could assert anything
//
//  1. **A session.** The terminal has no sign-in screen (`App.tsx`'s `Gate` says so), so without a
//     cookie the page is a paragraph reading `NO SESSION`. `globalSetup` mints one per seeded user
//     against `POST /api/v1/auth/login` and `use.storageState` hands the default one to every spec —
//     see `fixtures/auth.ts`, which also documents the two constraints a spec author must respect
//     (one active web session per person; five logins a minute per IP).
//  2. **Seeded data.** The scaffold pointed at `bloomberg_test`, which part 1 left migrations-only
//     on purpose. The suite now provisions its own seeded copy — `fixtures/database.ts`.
//  3. **An environment for the web server.** The scaffold's vite entry had none, so the dev server
//     proxied `/api` to its own default :8080 whatever port the plant was on. `webEnv()` fixes it.
//  4. **Ports that cannot be somebody else's.** `reuseExistingServer` is on outside CI, so two runs
//     sharing a port do not fail — they silently drive each other's plant. `TERMINAL_E2E_SLOT`
//     moves ports and database together.
//
// The ORDER of the two additions matters and is not adjustable: Playwright runs `webServer` before
// `globalSetup` (`playwright/lib/runner/index.js#createGlobalSetupTasks`), so the database is
// provisioned by the plant's own command — `globalSetup` only verifies it — while the logins, which
// need a running plant, are `globalSetup`'s.

import { defineConfig, devices } from '@playwright/test';

import { storageStatePath } from './fixtures/auth.js';
import {
  HEALTH_URL,
  IS_CI,
  REPO_ROOT,
  SERVER_WITH_DATABASE_COMMAND,
  WEB_COMMAND,
  WEB_DIR,
  WEB_URL,
  serverEnv,
  webEnv,
} from './fixtures/serverProcess.js';

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: false, // one plant, one replay clock, one workspace per user
  workers: 1,
  forbidOnly: IS_CI,
  retries: IS_CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: IS_CI
    ? [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]]
    : [['list']],

  // Verifies the seeded database and mints one `storageState` per seeded user (`fixtures/auth.ts`).
  globalSetup: './fixtures/auth.ts',

  use: {
    baseURL: WEB_URL,
    channel: 'chrome',
    viewport: { width: 1600, height: 1000 },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    // The terminal is keyboard-first; nothing in the suite should depend on a pointer.
    testIdAttribute: 'data-testid',
    // Signed in as `pm@demo.terminal` — the default of `fixtures/auth.ts`. A spec that needs another
    // person writes `test.use({ storageState: storageStatePath('compliance') })`; a spec that needs
    // NO session (the gate itself) writes `test.use({ storageState: { cookies: [], origins: [] } })`.
    storageState: storageStatePath(),
  },

  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],

  webServer: [
    {
      // `npx tsx packages/e2e/fixtures/database.ts && npx tsx packages/server/src/index.ts`:
      // provision, then start. Playwright launches this with `shell: true`, and the `&&` is what
      // guarantees the plant never opens its pool against a database that does not exist yet.
      command: SERVER_WITH_DATABASE_COMMAND,
      cwd: REPO_ROOT,
      env: serverEnv(),
      url: HEALTH_URL, // `503 STARTING` until startup completes (API.md §5.15)
      reuseExistingServer: !IS_CI,
      // A cold `db:migrate` + `db:seed` (CI, where there is no `bloomberg_seed_test` to copy) is
      // ~170 s before the plant even starts; copying the template is ~1 s.
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: WEB_COMMAND,
      cwd: WEB_DIR,
      // Without this the dev server proxies `/api` to :8080 — see point 3 above.
      env: webEnv(),
      url: WEB_URL,
      reuseExistingServer: !IS_CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
