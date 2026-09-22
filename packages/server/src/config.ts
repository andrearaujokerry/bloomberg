/**
 * Environment configuration — ARCHITECTURE §3.3 L252-254, WORKPLAN §1.8 L350-354.
 *
 * **This module is the only place in the server that reads `process.env`.** Everything else takes a
 * `Config` (usually through `AppDeps`). The ESLint zone rule for `packages/server/src` bans
 * `process.env` outside this file; keep it that way — a second reader is how a key ends up
 * documented in one place and undefined in another.
 *
 * The schema is ARCHITECTURE L252-254 verbatim plus the keys other documents require but that list
 * omits (WORKPLAN §1.8):
 *   - `BLS_API_KEY`, `FINRA_API_KEY` — named as `licence_registry.api_key_env` for `bls.timeseries`
 *     and `finra.shortInterest` (PROVIDERS.b §15). Unused in v1 (both tiers are keyless), but they
 *     must *resolve*, or the registry row points at nothing.
 *   - `DATABASE_URL_MAINT` — the `terminal_maint` connection that owns the six partitioned parents
 *     (DATA_MODEL §15.d.1). Optional: a process that never runs partition maintenance does not need
 *     it, and `withMaintTx` fails loudly when it is missing.
 *   - `DATABASE_URL_TEST` — read only by `src/test/db.ts`. `npm test` sets `DATABASE_URL` to
 *     `bloomberg_test` (ARCHITECTURE L1232) and the vitest `server-int` project does exactly that,
 *     so this is a fallback for ad-hoc runs, not the primary channel.
 */

import { z } from 'zod';

/** Provider modes — ARCHITECTURE §8 / L1232-1234. */
export const ProviderMode = z.enum(['live', 'record', 'replay']);
export type ProviderMode = z.infer<typeof ProviderMode>;

/** pino levels (`ops/logger.ts` consumes this). */
export const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
export type LogLevel = z.infer<typeof LogLevel>;

export const ConfigSchema = z.object({
  // ── Required: startup fails fast on any of these (ARCHITECTURE §12.1 step 1) ────────────────
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SEC_USER_AGENT: z
    .string()
    .min(1, 'SEC_USER_AGENT is required (SEC fair-access policy: contact address)'),
  SESSION_SECRET: z
    .string()
    .min(16, 'SESSION_SECRET must be at least 16 characters (session cookie signing key)'),

  // ── Defaulted ───────────────────────────────────────────────────────────────────────────────
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  PROVIDER_MODE: ProviderMode.default('replay'),
  REPLAY_DIR: z.string().min(1).default('../../fixtures/providers'),
  CONFLATION_MS_DEFAULT: z.coerce.number().int().min(0).max(60_000).default(250),
  LOG_LEVEL: LogLevel.default('info'),

  // ── Optional ────────────────────────────────────────────────────────────────────────────────
  /**
   * WebAuthn relying-party id (SEC-02) — the registrable domain the credential is bound to, e.g.
   * `terminal.example.com`. It is a bare host: no scheme, no port, no path.
   *
   * It MUST come from here and never from the request. `clientDataJSON.origin` and
   * `authData.rpIdHash` are the two anti-phishing checks of the ceremony, and deriving the value
   * they are compared against from the caller's own `Host` / `Origin` headers compares an
   * attacker's value with itself. Unset, `http/routes/auth.ts` refuses every WebAuthn ceremony
   * rather than guess (fail closed).
   */
  RP_ID: z
    .string()
    .min(1)
    .refine((v) => !v.includes('/') && !v.includes(':'), 'RP_ID is a bare host: no scheme or port')
    .optional(),
  /**
   * The exact origin the browser will send in `clientDataJSON.origin` —
   * `https://terminal.example.com`, scheme and port included, no trailing slash.
   */
  RP_ORIGIN: z.string().min(1).optional(),
  /**
   * Bearer token for `GET /metrics` (API.md §5.15). The route is public on loopback — a sidecar
   * scraper on the same host needs no credential — and requires `Authorization: Bearer
   * <METRICS_TOKEN>` from anywhere else. Unset, a non-loopback scrape is **refused**: there is no
   * value it could present, and serving the metric page to the internet because nobody set a
   * variable is the wrong default. 16 characters minimum, as for `SESSION_SECRET`.
   */
  METRICS_TOKEN: z
    .string()
    .min(16, 'METRICS_TOKEN must be at least 16 characters (GET /metrics bearer token)')
    .optional(),
  /**
   * `'1'` serves `GET /fields`, `GET /fields/:id` and `GET /fields/changelog` without a session
   * (API.md §5.5 L563 — "any (*public* when `PUBLIC_FIELDS=1`)").
   *
   * The field dictionary is documentation: definitions, units, decimals and the licence terms of
   * each source. It contains no instrument, no price and no firm, so publishing it lets an
   * integrator read the schema before they have credentials. It is off by default all the same —
   * a deployment should have to say so — and it never widens anything else: the values those
   * fields carry still go through `POST /data` and the evaluator.
   */
  PUBLIC_FIELDS: z.enum(['0', '1']).default('0'),
  OPENFIGI_API_KEY: z.string().min(1).optional(),
  FRED_API_KEY: z.string().min(1).optional(),
  BLS_API_KEY: z.string().min(1).optional(),
  FINRA_API_KEY: z.string().min(1).optional(),
  DATABASE_URL_MAINT: z.string().min(1).optional(),
  DATABASE_URL_TEST: z.string().min(1).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Raw environment shape accepted by `loadConfig`. Empty strings are treated as "unset" so that a
 * `.env` line like `FRED_API_KEY=` (as in `.env.example`) does not become an empty API key.
 */
export type RawEnv = Readonly<Record<string, string | undefined>>;

/** Thrown when the environment does not satisfy `ConfigSchema`. `index.ts` prints and exits 1. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Keys the schema knows about; anything else in the environment is ignored. */
const KNOWN_KEYS = Object.keys(ConfigSchema.shape) as readonly (keyof Config)[];

function pick(env: RawEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of KNOWN_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

let dotEnvLoaded = false;

/**
 * Load `.env` from the repository root into `process.env` if it exists, without overwriting values
 * already set by the caller. Node 22 has this built in, so there is no `dotenv` dependency.
 * Missing file is not an error: CI and the test runner supply the environment directly.
 */
function loadDotEnvOnce(): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  const candidate = new URL('../../../.env', import.meta.url);
  try {
    process.loadEnvFile(candidate);
  } catch {
    // No .env (or unreadable) — the real environment is authoritative.
  }
}

/**
 * Parse an environment into a `Config`. Pure with respect to its argument: pass an explicit object
 * in tests instead of mutating `process.env`.
 *
 * @throws ConfigError with every failing key listed, so a misconfigured deployment is fixed in one
 *         pass rather than one variable per restart.
 */
export function loadConfig(env?: RawEnv): Config {
  let source = env;
  if (source === undefined) {
    loadDotEnvOnce();
    source = process.env;
  }
  const parsed = ConfigSchema.safeParse(pick(source));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }
  return parsed.data;
}

let cached: Config | undefined;

/**
 * The process-wide config, parsed on first use and memoised. `index.ts` calls this first (startup
 * step 1) so that a bad environment fails before anything opens a socket.
 */
export function getConfig(): Config {
  return (cached ??= loadConfig());
}

/** Test seam: replace the memoised config (pass `undefined` to force a re-parse on next access). */
export function setConfig(next: Config | undefined): void {
  cached = next;
}
