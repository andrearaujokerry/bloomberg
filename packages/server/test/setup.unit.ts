/**
 * `packages/server/test/setup.unit.ts` — the `server-unit` vitest project's setup file
 * (TESTING.md §2.1 L99).
 *
 * Unit tests never open a socket or a connection, so all this file does is guarantee an
 * environment `config.ts` can parse: the three required variables (`DATABASE_URL`,
 * `SEC_USER_AGENT`, `SESSION_SECRET`) plus `PROVIDER_MODE=replay`, none of them overwriting a
 * value the runner or a `.env` already supplied. A checkout without a `.env` must still run the
 * unit suite.
 *
 * The memoised config is cleared before each test, so a test that installs its own `setConfig()`
 * cannot leak it into the next file.
 */
import { beforeEach } from 'vitest';

import { setConfig } from '../src/config.js';

/** Set `key` only when the environment does not already carry it. */
function defaultEnv(key: string, value: string): void {
  if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
}

defaultEnv('PROVIDER_MODE', 'replay');
defaultEnv('DATABASE_URL', 'postgres://localhost:5432/bloomberg_test');
defaultEnv('DATABASE_URL_TEST', 'postgres://localhost:5432/bloomberg_test');
defaultEnv('SEC_USER_AGENT', 'Terminal Clone test (tests@example.invalid)');
defaultEnv('SESSION_SECRET', 'test-only-session-secret-0123456789');
defaultEnv('LOG_LEVEL', 'silent');

beforeEach(() => {
  setConfig(undefined);
});
