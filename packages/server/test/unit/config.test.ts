/**
 * `src/config.ts` — WORKPLAN §1.11: "rejects a missing `DATABASE_URL` and defaults `PORT`,
 * `PROVIDER_MODE`, `CONFLATION_MS_DEFAULT`".
 *
 * Every case calls `loadConfig(env)` with an explicit object. That overload never touches
 * `process.env` and never loads `.env`, so this file is pure: it cannot be turned green or red by
 * the developer's shell (ARCHITECTURE §3.3 — config is the one module that reads the environment,
 * and it takes the environment as an argument so that it can be tested without one).
 */

import { describe, expect, it } from 'vitest';

import type { Config, RawEnv } from '../../src/config.js';
import { ConfigError, ConfigSchema, getConfig, loadConfig, setConfig } from '../../src/config.js';

/** The three required keys of `ConfigSchema`, with values that satisfy every constraint. */
const REQUIRED: RawEnv = {
  DATABASE_URL: 'postgres://localhost:5432/bloomberg_dev',
  SEC_USER_AGENT: 'Terminal/0.1 (ops@example.com)',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef',
};

function env(overrides: Readonly<Record<string, string | undefined>> = {}): RawEnv {
  return { ...REQUIRED, ...overrides };
}

/** `loadConfig` throws `ConfigError`; return it so the issue list can be asserted. */
function expectConfigError(source: RawEnv): ConfigError {
  let thrown: unknown;
  try {
    loadConfig(source);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ConfigError);
  return thrown as ConfigError;
}

describe('loadConfig — required keys', () => {
  it('rejects a missing DATABASE_URL', () => {
    const err = expectConfigError({
      SEC_USER_AGENT: REQUIRED.SEC_USER_AGENT,
      SESSION_SECRET: REQUIRED.SESSION_SECRET,
    });
    expect(err.issues.some((i) => i.startsWith('DATABASE_URL:'))).toBe(true);
    expect(err.message).toContain('Invalid environment');
  });

  it('treats an empty DATABASE_URL as missing rather than as an empty connection string', () => {
    // `.env.example` ships `FRED_API_KEY=` and friends; an empty value must never become a value.
    const err = expectConfigError(env({ DATABASE_URL: '' }));
    expect(err.issues.some((i) => i.startsWith('DATABASE_URL:'))).toBe(true);
  });

  it('rejects a missing SEC_USER_AGENT and a too-short SESSION_SECRET', () => {
    const err = expectConfigError({
      DATABASE_URL: REQUIRED.DATABASE_URL,
      SESSION_SECRET: 'short',
    });
    expect(err.issues.some((i) => i.startsWith('SEC_USER_AGENT:'))).toBe(true);
    expect(err.issues.some((i) => i.startsWith('SESSION_SECRET:'))).toBe(true);
  });

  it('reports every failing key in one pass', () => {
    // A misconfigured deployment is fixed in one edit, not one restart per variable.
    const err = expectConfigError({ PORT: 'not-a-number' });
    const keys = err.issues.map((i) => i.split(':')[0]);
    expect(keys).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'SEC_USER_AGENT', 'SESSION_SECRET', 'PORT']),
    );
    expect(err.issues.length).toBeGreaterThanOrEqual(4);
  });
});

describe('loadConfig — defaults', () => {
  const config: Config = loadConfig(REQUIRED);

  it('defaults PORT to 8080', () => {
    expect(config.PORT).toBe(8080);
  });

  it('defaults PROVIDER_MODE to replay', () => {
    // Nothing in the repository reaches the network unless it is asked to (ARCHITECTURE §8).
    expect(config.PROVIDER_MODE).toBe('replay');
  });

  it('defaults CONFLATION_MS_DEFAULT to 250', () => {
    expect(config.CONFLATION_MS_DEFAULT).toBe(250);
  });

  it('defaults REPLAY_DIR and LOG_LEVEL', () => {
    expect(config.REPLAY_DIR).toBe('../../fixtures/providers');
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('leaves every optional key undefined when it is unset', () => {
    expect(config.OPENFIGI_API_KEY).toBeUndefined();
    expect(config.FRED_API_KEY).toBeUndefined();
    expect(config.BLS_API_KEY).toBeUndefined();
    expect(config.FINRA_API_KEY).toBeUndefined();
    expect(config.DATABASE_URL_MAINT).toBeUndefined();
    expect(config.DATABASE_URL_TEST).toBeUndefined();
  });

  it('leaves an optional key undefined when it is present but empty', () => {
    const parsed = loadConfig(env({ FRED_API_KEY: '', OPENFIGI_API_KEY: '  ' }));
    expect(parsed.FRED_API_KEY).toBeUndefined();
    expect(parsed.OPENFIGI_API_KEY).toBe('  ');
  });
});

describe('loadConfig — coercion and validation', () => {
  it('coerces PORT from a string and rejects one outside 1..65535', () => {
    expect(loadConfig(env({ PORT: '3000' })).PORT).toBe(3000);
    expect(expectConfigError(env({ PORT: '0' })).issues.join()).toContain('PORT');
    expect(expectConfigError(env({ PORT: '70000' })).issues.join()).toContain('PORT');
  });

  it('coerces CONFLATION_MS_DEFAULT and rejects a negative value', () => {
    expect(loadConfig(env({ CONFLATION_MS_DEFAULT: '0' })).CONFLATION_MS_DEFAULT).toBe(0);
    expect(loadConfig(env({ CONFLATION_MS_DEFAULT: '1000' })).CONFLATION_MS_DEFAULT).toBe(1000);
    expect(expectConfigError(env({ CONFLATION_MS_DEFAULT: '-1' })).issues.join()).toContain(
      'CONFLATION_MS_DEFAULT',
    );
  });

  it('accepts every PROVIDER_MODE and rejects anything else', () => {
    for (const mode of ['live', 'record', 'replay'] as const) {
      expect(loadConfig(env({ PROVIDER_MODE: mode })).PROVIDER_MODE).toBe(mode);
    }
    expect(expectConfigError(env({ PROVIDER_MODE: 'offline' })).issues.join()).toContain(
      'PROVIDER_MODE',
    );
  });

  it('accepts every pino level and rejects anything else', () => {
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const) {
      expect(loadConfig(env({ LOG_LEVEL: level })).LOG_LEVEL).toBe(level);
    }
    expect(expectConfigError(env({ LOG_LEVEL: 'verbose' })).issues.join()).toContain('LOG_LEVEL');
  });

  it('ignores keys the schema does not declare', () => {
    const parsed = loadConfig(env({ AWS_SECRET_ACCESS_KEY: 'nope', PATH: '/usr/bin' }));
    const known = new Set(Object.keys(ConfigSchema.shape));
    expect(Object.keys(parsed).filter((k) => !known.has(k))).toEqual([]);
    expect(Object.keys(parsed)).toContain('DATABASE_URL');
  });
});

describe('getConfig / setConfig', () => {
  it('memoises the config and lets a test replace it', () => {
    const fixture = loadConfig(env({ PORT: '9999' }));
    setConfig(fixture);
    try {
      expect(getConfig()).toBe(fixture);
      expect(getConfig().PORT).toBe(9999);
    } finally {
      // Leave the module as found: the next reader re-parses the real environment.
      setConfig(undefined);
    }
  });
});
