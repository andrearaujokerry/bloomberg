/**
 * `packages/server/test/setup.int.ts` — the `server-int` vitest project's setup file
 * (TESTING.md §2.1 L100). Runs once per fork, before any integration file in that fork.
 *
 * It does three things, in this order:
 *
 *   1. guarantees an environment `config.ts` can parse, and forces `DATABASE_URL` to the *test*
 *      database. `src/test/db.ts#testDatabaseUrl()` refuses any database whose name does not
 *      contain `test`, so this is also the safety interlock that keeps a mistyped `DATABASE_URL`
 *      from truncating `bloomberg_dev`.
 *   2. freezes the clock at `TEST_NOW` (`src/test/clock.ts`) and publishes it as
 *      `globalThis.__TEST_CLOCK__`, so a test that wants to advance time takes the same instance
 *      the code under test reads.
 *   3. clears the memoised config before each test, so one file's `setConfig()` cannot leak.
 *
 * Migrations and the seed are NOT here: they run once per vitest invocation in `globalSetup.ts`
 * (TESTING §4.2). This file must stay cheap — it runs in every fork.
 */
import { beforeEach } from 'vitest';

import { setConfig } from '../src/config.js';
import { TEST_NOW, testClock } from '../src/test/clock.js';

import type { VirtualClock } from '../src/test/clock.js';

function defaultEnv(key: string, value: string): void {
  if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
}

defaultEnv('PROVIDER_MODE', 'replay');
defaultEnv('DATABASE_URL_TEST', 'postgres://localhost:5432/bloomberg_test');
defaultEnv('SEC_USER_AGENT', 'Terminal Clone test (tests@example.invalid)');
defaultEnv('SESSION_SECRET', 'test-only-session-secret-0123456789');
defaultEnv('LOG_LEVEL', 'silent');

// The integration project always runs against the test database, whatever `.env` says. The
// vitest project config sets this too; doing it here as well keeps a directly-invoked file honest.
const testUrl = process.env.DATABASE_URL_TEST;
if (testUrl !== undefined && testUrl !== '') process.env.DATABASE_URL = testUrl;
defaultEnv('DATABASE_URL', 'postgres://localhost:5432/bloomberg_test');

/** The shared frozen clock. `advanceSeconds(clock, n)` moves it; nothing else does. */
export const clock: VirtualClock = testClock(TEST_NOW);
(globalThis as unknown as Record<string, unknown>).__TEST_CLOCK__ = clock;

beforeEach(() => {
  setConfig(undefined);
});
