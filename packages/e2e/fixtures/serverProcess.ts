// WP-01 scaffold, repointed by WP-15 part 2 — ARCHITECTURE §3.5 L398-400.
//
// One place that knows how to start the plant in replay mode against the SEEDED e2e database, and
// how to wait for it to be healthy. `playwright.config.ts` uses the constants for its `webServer`
// block; specs that need a plant of their own (a restart, a frozen feed) use `startServer()`.
//
// This package drives the built app over the wire and never imports package source (WORKPLAN §1.2),
// so the server is a child process, not an import.
//
// ## What WP-15 changed here, and why each change was forced
//
//  1. **The database.** The scaffold pointed at `bloomberg_test`, which WP-15 part 1 deliberately
//     left migrations-only (the second DEVIATION in `packages/server/test/globalSetup.ts`). A
//     terminal with no instruments, no users and no workspaces cannot be driven by a spec that
//     asserts anything, so the suite gets its own seeded copy — see `fixtures/database.ts`.
//  2. **The ports.** 8080 and 5173 are the ports `npm run dev` uses, and `reuseExistingServer` is
//     on outside CI: an e2e run started while a developer's plant was up would silently drive THAT
//     plant, against `bloomberg_dev`. The defaults moved to 8090/5183, one slot apart per
//     `TERMINAL_E2E_SLOT`, so parallel runs cannot meet.
//  3. **The web server's environment.** The scaffold gave the vite `webServer` entry no `env` at
//     all, so the dev server read its own defaults and proxied `/api` to :8080 — i.e. moving the
//     plant's port would have pointed the browser at nothing. {@link webEnv} is the missing half:
//     `vite.config.ts` reads `TERMINAL_API_TARGET`, `TERMINAL_WS_TARGET` and `TERMINAL_WEB_PORT`,
//     and all three now come from the same place as `SERVER_PORT`.

import { spawn } from 'node:child_process';
// `node:process`'s named exports rather than the `process` global: the repo reads the environment
// in exactly two zones (`server/src/config.ts`, `scripts/**`) and the lint rule that enforces it
// keys off `process.env` — an e2e harness legitimately needs the ambient ports and database URL.
import { env as processEnv, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import { E2E_DATABASE_URL, E2E_SLOT, PROVISION_COMMAND } from './database.js';

/** `packages/e2e/fixtures/` → the monorepo root. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url));

/**
 * Deliberately NOT 8080/5173 — those belong to `npm run dev`. `TERMINAL_E2E_SLOT` moves the whole
 * stack (both ports and the database, see `database.ts`) so two runs on one machine cannot meet;
 * the two explicit variables still win when a shard needs an exact pair.
 */
export const SERVER_PORT = Number(processEnv.TERMINAL_E2E_SERVER_PORT ?? String(8090 + E2E_SLOT));
export const WEB_PORT = Number(processEnv.TERMINAL_E2E_WEB_PORT ?? String(5183 + E2E_SLOT));

export const SERVER_URL = `http://localhost:${String(SERVER_PORT)}`;
export const WEB_URL = `http://localhost:${String(WEB_PORT)}`;
/** API.md §5.15 — `503 STARTING` until startup step 8, `200` once the plant is up. */
export const HEALTH_URL = `${SERVER_URL}/api/v1/health`;

/**
 * The seeded database this suite owns. `fixtures/database.ts` provisions it; nothing here may point
 * at `bloomberg_test` (bare) or `bloomberg_seed_test` (the `server-seed` project's, and a workspace
 * autosave would corrupt its row counts).
 */
export const E2E_DATABASE = E2E_DATABASE_URL;

export const IS_CI = processEnv.CI === '1' || processEnv.CI === 'true';

/** `tsx` runs the TypeScript entry point directly — no build step in front of the suite. */
export const SERVER_COMMAND = 'npx tsx packages/server/src/index.ts';

/**
 * What `playwright.config.ts` actually runs for the plant: provision the database, THEN start.
 *
 * The ordering is not a preference. Playwright runs `webServer` before `globalSetup`
 * (`playwright/lib/runner/index.js#createGlobalSetupTasks` puts the plugin tasks first) and the
 * plant opens its pool during startup step 2, so there is no hook that fires early enough except
 * the command itself. `shell: true` is how Playwright launches it, so `&&` is available and a
 * provisioning failure stops the stack instead of booting a plant onto a missing database.
 */
export const SERVER_WITH_DATABASE_COMMAND = `${PROVISION_COMMAND} && ${SERVER_COMMAND}`;

/** The app is served by vite so the `/api` and `/ws` proxies of `vite.config.ts` are in play. */
export const WEB_COMMAND = 'npx vite --host localhost';

/**
 * The environment every e2e plant runs with: replayed provider payloads (no network, QA-02) and
 * this suite's own seeded database, never `bloomberg_dev` and never the `server-seed` template.
 */
export function serverEnv(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PROVIDER_MODE: 'replay',
    DATABASE_URL: E2E_DATABASE,
    DATABASE_URL_TEST: E2E_DATABASE,
    REPLAY_DIR: processEnv.REPLAY_DIR ?? './fixtures/providers',
    PORT: String(SERVER_PORT),
    LOG_LEVEL: processEnv.E2E_LOG_LEVEL ?? 'warn',
    SESSION_SECRET: processEnv.SESSION_SECRET ?? 'e2e-only-secret-not-for-production',
    ...overrides,
  };
}

/**
 * The environment the vite dev server runs with, so that the ONE origin the browser talks to
 * proxies `/api` and `/ws` to THIS run's plant (`vite.config.ts` L17-19, API-05).
 *
 * The scaffold left this out, and it only worked because the scaffold's ports were vite's own
 * defaults. The moment the plant moved off 8080 the browser would have been proxied to whatever
 * else was listening there — a developer's `npm run dev` plant on `bloomberg_dev`, most likely,
 * which is the failure mode that looks like a passing suite.
 */
export function webEnv(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    TERMINAL_API_TARGET: SERVER_URL,
    TERMINAL_WS_TARGET: `ws://localhost:${String(SERVER_PORT)}`,
    TERMINAL_WEB_PORT: String(WEB_PORT),
    ...overrides,
  };
}

export interface StartServerOptions {
  /** Extra environment on top of {@link serverEnv}. */
  readonly env?: Readonly<Record<string, string>>;
  /** How long to wait for `/api/v1/health` to answer `200`; default 120 s. */
  readonly timeoutMs?: number;
  /** Mirror the child's stdout/stderr onto this process's; default `false`. */
  readonly echo?: boolean;
}

export interface ServerProcess {
  readonly url: string;
  readonly port: number;
  readonly pid: number | undefined;
  /** Everything the child wrote, for failure messages. */
  output(): string;
  /** SIGTERM, then SIGKILL after 5 s; resolves when the child has exited. */
  stop(): Promise<void>;
}

/** `200`-`399` from `/api/v1/health` means the plant finished startup (API.md §5.15). */
export async function pingHealth(url: string = HEALTH_URL): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `/api/v1/health` until it answers or `timeoutMs` elapses.
 * @throws when the deadline passes; `describe()` is appended to the message.
 */
export async function waitForHealth(
  timeoutMs = 120_000,
  describe: () => string = () => '',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pingHealth()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `the replay-mode server did not become healthy at ${HEALTH_URL} within ${String(
          timeoutMs,
        )} ms\n${describe()}`,
      );
    }
    await sleep(250);
  }
}

/**
 * Starts a replay-mode plant as a child process and resolves once `/api/v1/health` answers.
 * The caller owns the handle and must `stop()` it (Playwright's `webServer` does this for the
 * suite-wide instance; only specs that start their own need to).
 */
export async function startServer(options: StartServerOptions = {}): Promise<ServerProcess> {
  const [command, ...args] = SERVER_COMMAND.split(' ');
  if (command === undefined) throw new Error('SERVER_COMMAND is empty');

  // stdio `['ignore', 'pipe', 'pipe']` → `ChildProcessByStdio<null, Readable, Readable>`.
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: { ...processEnv, ...serverEnv(options.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  const capture = (chunk: Buffer | string): void => {
    log += String(chunk);
    if (log.length > 64_000) log = log.slice(-64_000);
    if (options.echo === true) stdout.write(chunk);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exited = new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });

  const handle: ServerProcess = {
    url: SERVER_URL,
    port: SERVER_PORT,
    pid: child.pid,
    output: () => log,
    async stop() {
      if (exit !== undefined || child.killed) {
        await exited;
        return;
      }
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try {
        await exited;
      } finally {
        clearTimeout(killer);
      }
    },
  };

  const earlyExit = exited.then(() => {
    throw new Error(
      `the replay-mode server exited before becoming healthy (code ${String(
        exit?.code,
      )}, signal ${String(exit?.signal)})\n${log}`,
    );
  });
  // The race below consumes the real rejection; this keeps node from reporting it twice when the
  // health check wins and the child is stopped afterwards.
  void earlyExit.catch(() => undefined);

  try {
    await Promise.race([waitForHealth(options.timeoutMs ?? 120_000, () => log), earlyExit]);
  } catch (err) {
    await handle.stop();
    throw err;
  }

  return handle;
}
