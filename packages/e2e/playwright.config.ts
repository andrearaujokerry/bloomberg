// WP-01 scaffold — ARCHITECTURE §3.5 L398, WORKPLAN §1.9.
//
// One browser (Google Chrome, the desk's browser), one origin (the vite dev server on :5173 whose
// proxy forwards `/api` and `/ws` to the plant on :8080), and two web servers: the replay-mode
// plant and the app. Specs drive the app over the wire and never import package source.

import { defineConfig, devices } from '@playwright/test';

import {
  HEALTH_URL,
  IS_CI,
  REPO_ROOT,
  SERVER_COMMAND,
  WEB_COMMAND,
  WEB_DIR,
  WEB_URL,
  serverEnv,
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
  },

  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],

  webServer: [
    {
      // PROVIDER_MODE=replay, DATABASE_URL=…bloomberg_test (fixtures/serverProcess.ts).
      command: SERVER_COMMAND,
      cwd: REPO_ROOT,
      env: serverEnv(),
      url: HEALTH_URL, // `503 STARTING` until startup completes (API.md §5.15)
      reuseExistingServer: !IS_CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: WEB_COMMAND,
      cwd: WEB_DIR,
      url: WEB_URL,
      reuseExistingServer: !IS_CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
