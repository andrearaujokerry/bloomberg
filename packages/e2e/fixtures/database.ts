// WP-15 part 2 — the e2e database, TESTING §4.2 and the second DEVIATION in
// `packages/server/test/globalSetup.ts`.
//
// The Playwright suite is the only harness in this repo that needs a database which is BOTH
// migrated AND seeded, and neither of the two vitest databases will do:
//
//   * `bloomberg_test` is deliberately migrations-only. WP-15 wrote the twelve seed modules and the
//     ~145 ingest and function suites that assert "my job inserted N rows" only mean something
//     against empty tables, so `SEED_TEST_DB` gates the seed and `bloomberg_test` stays bare. A
//     terminal pointed at it has no instruments, no users and no workspaces: every spec would be
//     asserting against a blank screen, which is exactly the shape of test this build has shipped
//     nine of already.
//   * `bloomberg_seed_test` IS the seeded universe — and it belongs to the `server-seed` vitest
//     project, which asserts DATA_MODEL §18's row counts against it. A Playwright run that wrote to
//     it (a workspace autosave is enough: `panels.spec.ts` drags panels around and the shell
//     flushes the layout) would corrupt somebody else's acceptance test.
//
// So the suite gets its own database, and the fast way to make one is `CREATE DATABASE … TEMPLATE
// bloomberg_seed_test`: postgres copies the directory, which takes about a second for the 41,455
// instruments the seed writes, against ~170 s for a cold `db:migrate` + `db:seed`. The cold path is
// still here and still tested, because CI has no template to copy — nothing there has ever run the
// `server-seed` project when the e2e job starts.
//
// ## Why this runs as a preamble to the server's own `webServer` command
//
// Playwright starts `webServer` BEFORE `globalSetup` (`runner/index.js#createGlobalSetupTasks`
// puts the plugin tasks first), and the plant opens its pool during startup step 2. Provisioning
// from `globalSetup` would therefore be provisioning a database the server had already failed to
// connect to. `playwright.config.ts` prefixes this module onto the server command instead, so the
// shell runs it to completion first; `globalSetup` then only VERIFIES the volumes, which is cheap
// and catches the `reuseExistingServer` case where the command never ran at all.
//
// Nothing here imports package source (WORKPLAN §1.2). The provisioning talks to postgres through
// `psql` and to the repo's own migrate/seed entry points through `npm run`, the same way a person
// would.

import { execFile as execFileCb } from 'node:child_process';
// `node:process`'s named exports rather than the `process` global, for the reason
// `serverProcess.ts` gives: the lint rule that keeps environment reads in two zones keys off
// `process.env`, and an e2e harness legitimately needs the ambient database URLs.
import { argv, env as processEnv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/** `packages/e2e/fixtures/` → the monorepo root (duplicated from `serverProcess.ts`: see below). */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Which parallel e2e stack this process is. Several agents and several CI shards run this suite at
 * once, and `reuseExistingServer` is on outside CI — two runs that share a port do not collide
 * loudly, they SILENTLY reuse each other's plant, against each other's database. One variable moves
 * the ports and the database together so that cannot happen: `TERMINAL_E2E_SLOT=3 npx playwright
 * test`. `serverProcess.ts` reads the same value for its ports.
 */
export const E2E_SLOT = Number.parseInt(processEnv.TERMINAL_E2E_SLOT ?? '0', 10) || 0;

/**
 * The seeded database the e2e one is copied from — `server-seed`'s, read-only from here.
 * Same default and same variable as `vitest.config.ts` L19-20.
 */
export const SEED_TEMPLATE_URL =
  processEnv.DATABASE_URL_SEED_TEST ?? 'postgres://localhost:5432/bloomberg_seed_test';

/** `bloomberg_e2e` for slot 0, `bloomberg_e2e_<slot>` above it. */
export const E2E_DATABASE_NAME =
  processEnv.TERMINAL_E2E_DATABASE ??
  (E2E_SLOT === 0 ? 'bloomberg_e2e' : `bloomberg_e2e_${String(E2E_SLOT)}`);

/** The e2e database's connection string: the template's host and port, this suite's database. */
export const E2E_DATABASE_URL =
  processEnv.TERMINAL_E2E_DATABASE_URL ?? withDatabase(SEED_TEMPLATE_URL, E2E_DATABASE_NAME);

/** `postgres`, on the same server — where `CREATE`/`DROP DATABASE` has to be issued from. */
const ADMIN_URL = withDatabase(SEED_TEMPLATE_URL, 'postgres');

/** Set to `1` to keep whatever is in the e2e database — the loop when a spec is being written. */
const SKIP_PROVISION = processEnv.TERMINAL_E2E_SKIP_DB_PROVISION === '1';

/** Replaces the database name in a postgres URL, keeping user, host, port and query intact. */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** `postgres://user:pw@host/db` → `postgres://***@host/db`, for anything that gets printed. */
export function redact(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***@');
}

/** The name at the end of a postgres URL. */
function databaseOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

/* ---------------------------------------------------------------------------------------------- */
/* psql                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One row, one column, as text — `psql -At`. `''` when the query selected nothing.
 * @throws when `psql` is not on PATH, or the query failed; the message carries psql's stderr.
 */
async function scalar(url: string, sql: string): Promise<string> {
  try {
    const { stdout: out } = await execFile('psql', [url, '-Atqc', sql], {
      env: { ...processEnv, PGCONNECT_TIMEOUT: '5' },
    });
    return out.trim();
  } catch (err: unknown) {
    const detail = err as { code?: string; stderr?: string; message?: string };
    if (detail.code === 'ENOENT') {
      throw new Error(
        'psql is not on PATH. The e2e suite provisions its database with the postgres client ' +
          'tools (brew install libpq / postgresql@14).',
      );
    }
    throw new Error(
      `psql failed against ${redact(url)}\n  ${sql}\n${detail.stderr ?? detail.message ?? ''}`,
    );
  }
}

/** A statement whose output does not matter. */
async function statement(url: string, sql: string): Promise<void> {
  await scalar(url, sql);
}

/* ---------------------------------------------------------------------------------------------- */
/* Volumes — the check that makes "the database is ready" mean something                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What a seeded database has that a migrated one does not. The four smallest numbers that cannot
 * all be true of an empty schema, and the four every spec in the suite leans on: an instrument to
 * resolve, a user to log in as, a workspace to restore into four panels, and a market-data line
 * behind the values on screen.
 */
export interface SeededVolumes {
  readonly instruments: number;
  readonly users: number;
  readonly workspaces: number;
  readonly mdLines: number;
}

/** Floors, not the §18 counts: `volumes.test.ts` owns those, and it owns the template. */
const MINIMUM: SeededVolumes = { instruments: 30_000, users: 7, workspaces: 7, mdLines: 30_000 };

/** Counts the four tables of {@link SeededVolumes}; `null` when the database does not exist. */
export async function volumes(url: string = E2E_DATABASE_URL): Promise<SeededVolumes | null> {
  if (!(await databaseExists(databaseOf(url)))) return null;
  const row = await scalar(
    url,
    `select (select count(*) from instruments) || ' ' ||
            (select count(*) from users) || ' ' ||
            (select count(*) from workspaces) || ' ' ||
            (select count(*) from md_lines)`,
  );
  const [instruments = '0', users = '0', workspaces = '0', mdLines = '0'] = row.split(' ');
  return {
    instruments: Number(instruments),
    users: Number(users),
    workspaces: Number(workspaces),
    mdLines: Number(mdLines),
  };
}

/**
 * Asserts the e2e database holds a seeded universe, and returns what it counted.
 *
 * This is the assertion that stops the whole suite from becoming the tenth test that cannot fail.
 * Every spec after it asserts against seeded values; if the database were empty, the shell would
 * render four empty panels and a spec looking only for "four panels" would still pass. So the
 * numbers are checked once, loudly, before any spec runs.
 *
 * @throws with the counts and the remedy when the database is missing or bare.
 */
export async function assertSeeded(url: string = E2E_DATABASE_URL): Promise<SeededVolumes> {
  const found = await volumes(url);
  if (found === null) {
    throw new Error(
      `the e2e database ${redact(url)} does not exist — run ` +
        `\`npx tsx packages/e2e/fixtures/database.ts\` or let playwright.config.ts's webServer do it`,
    );
  }
  const short = (Object.keys(MINIMUM) as (keyof SeededVolumes)[]).filter(
    (key) => found[key] < MINIMUM[key],
  );
  if (short.length > 0) {
    throw new Error(
      `the e2e database ${redact(url)} is not seeded: ` +
        short.map((k) => `${k}=${String(found[k])} (want ≥ ${String(MINIMUM[k])})`).join(', ') +
        '\nEvery spec in this suite asserts against seeded values, so an empty database would ' +
        'turn the whole suite into tests that cannot fail. Re-provision with ' +
        'TERMINAL_E2E_SKIP_DB_PROVISION unset.',
    );
  }
  return found;
}

/* ---------------------------------------------------------------------------------------------- */
/* Provisioning                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

async function databaseExists(name: string): Promise<boolean> {
  const out = await scalar(
    ADMIN_URL,
    `select 1 from pg_database where datname = ${quoteLiteral(name)}`,
  );
  return out === '1';
}

/** Backends connected to `name`, excluding this one. */
async function backendCount(name: string): Promise<number> {
  const out = await scalar(
    ADMIN_URL,
    `select count(*) from pg_stat_activity
      where datname = ${quoteLiteral(name)} and pid <> pg_backend_pid()`,
  );
  return Number(out);
}

/** A single-quoted SQL literal. Database names here come from the environment, not from a user. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A double-quoted SQL identifier. */
function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export interface ProvisionResult {
  readonly database: string;
  readonly url: string;
  /** `template` copied the seeded database, `cold` migrated and seeded, `reused` did neither. */
  readonly mode: 'template' | 'cold' | 'reused';
  readonly volumes: SeededVolumes;
  readonly ms: number;
}

export interface ProvisionOptions {
  /** Where progress goes; `stdout.write` by default. */
  readonly log?: (line: string) => void;
}

/**
 * Makes `E2E_DATABASE_URL` exist and hold the seeded universe, and returns what it did.
 *
 * Two paths, and the choice is made by whether the template is there:
 *
 *  1. **template** — `DROP DATABASE`, then `CREATE DATABASE … TEMPLATE bloomberg_seed_test`. About
 *     a second. Postgres refuses to copy a database that has an open backend, so a `server-seed`
 *     vitest run in progress makes this fail: the error says so by name rather than being reported
 *     as a create failure, because "stop the vitest run" is not something an error code says.
 *  2. **cold** — `CREATE DATABASE`, `scripts/migrate.ts`, `scripts/seed.ts`. ~170 s, and the only
 *     path CI can take. Run through `npx tsx` as a child process for the boundary's sake: this
 *     package drives the repo, it does not import it.
 *
 * Either way the result is verified with {@link assertSeeded} before it is returned — a create that
 * "succeeded" against an empty template is the failure this harness most needs to catch.
 */
export async function provisionE2eDatabase(
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const log = options.log ?? ((line: string) => void stdout.write(`${line}\n`));
  const started = Date.now();
  const name = E2E_DATABASE_NAME;

  if (SKIP_PROVISION) {
    const found = await assertSeeded();
    // `if not exists`, so a database that was provisioned properly keeps ITS pristine copy rather
    // than promoting whatever the last run left behind.
    await capturePristineWorkspaces();
    log(`e2e db ${name}: reused (TERMINAL_E2E_SKIP_DB_PROVISION=1)`);
    return { database: name, url: E2E_DATABASE_URL, mode: 'reused', volumes: found, ms: 0 };
  }

  const templateName = databaseOf(SEED_TEMPLATE_URL);
  const haveTemplate = await databaseExists(templateName);

  // The e2e database is ours to destroy; the template is not. Terminate our own backends (a plant
  // left running by a previous `reuseExistingServer` holds a pool open) and drop.
  if (await databaseExists(name)) {
    await statement(
      ADMIN_URL,
      `select pg_terminate_backend(pid) from pg_stat_activity
        where datname = ${quoteLiteral(name)} and pid <> pg_backend_pid()`,
    );
    await statement(ADMIN_URL, `drop database if exists ${quoteIdent(name)}`);
  }

  let mode: ProvisionResult['mode'];
  if (haveTemplate) {
    const busy = await backendCount(templateName);
    if (busy > 0) {
      throw new Error(
        `cannot copy ${templateName}: ${String(busy)} open connection(s). Postgres refuses ` +
          'CREATE DATABASE … TEMPLATE while the source is in use — stop the `server-seed` vitest ' +
          'run (or any psql session on it) and try again.',
      );
    }
    log(`e2e db ${name}: copying ${templateName}…`);
    await statement(
      ADMIN_URL,
      `create database ${quoteIdent(name)} template ${quoteIdent(templateName)}`,
    );
    mode = 'template';
  } else {
    // CI, and any machine that has never run the `server-seed` project.
    log(`e2e db ${name}: no ${templateName} template — cold migrate + seed (~190 s)…`);
    await statement(ADMIN_URL, `create database ${quoteIdent(name)}`);
    await repoScript('db:migrate', log);
    await repoScript('db:seed', log);
    mode = 'cold';
  }

  const found = await assertSeeded();
  // Taken before any spec has loaded the terminal, which is the only moment the layouts are still
  // the seed's own — see PRISTINE_TABLE.
  await capturePristineWorkspaces();
  const ms = Date.now() - started;
  log(
    `e2e db ${name}: ${mode} in ${String(ms)} ms — ${String(found.instruments)} instruments, ` +
      `${String(found.users)} users, ${String(found.workspaces)} workspaces, ` +
      `${String(found.mdLines)} md_lines`,
  );
  return { database: name, url: E2E_DATABASE_URL, mode, volumes: found, ms };
}

/**
 * Runs one of the repo's own db npm scripts against the e2e database.
 *
 * Through `npm run`, NOT `npx tsx scripts/seed.ts` directly, and the difference is a CI failure:
 * the root `package.json` declares `predb:seed` → `build:core`, and `scripts/seed.ts` imports the
 * seed runner, which imports `@terminal/core`'s BUILT output. On a developer's machine
 * `packages/core/dist` is already there and calling the script directly works by luck; on a fresh
 * CI checkout — which is the only place the cold path ever runs — it would fail on the first
 * unresolved import. The npm indirection is what makes the pre-hook fire.
 */
async function repoScript(script: string, log: (line: string) => void): Promise<void> {
  log(`  npm run ${script} -- --url ${redact(E2E_DATABASE_URL)}`);
  try {
    const { stdout: out } = await execFile(
      'npm',
      ['run', script, '--', '--url', E2E_DATABASE_URL],
      // A cold seed is ~190 s; `maxBuffer` because the seed is chatty per module.
      { cwd: REPO_ROOT, env: { ...processEnv }, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
    );
    for (const line of out.trimEnd().split('\n')) log(`  │ ${line}`);
  } catch (err: unknown) {
    const detail = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `npm run ${script} failed against the e2e database\n${detail.stdout ?? ''}\n${
        detail.stderr ?? detail.message ?? ''
      }`,
    );
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Per-spec isolation: the pristine workspace                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A copy of every seeded `workspaces.layout`, taken at provisioning time.
 *
 * The database is provisioned once per RUN, and the shell autosaves the workspace: `Shell.tsx`
 * debounces a `PUT /api/v1/workspace` and flushes one on `pagehide`, so simply LOADING the terminal
 * rewrites the layout the next spec will restore. Without a pristine copy to go back to, spec order
 * becomes part of every assertion — and it is not hypothetical: see {@link resetWorkspace}.
 *
 * A table inside the e2e database rather than a re-read of the template, because the cold CI path
 * has no template to re-read and a harness that only isolates on a developer's machine is a harness
 * that isolates nowhere that matters.
 */
const PRISTINE_TABLE = 'e2e_pristine_workspaces';

async function capturePristineWorkspaces(): Promise<void> {
  await statement(
    E2E_DATABASE_URL,
    `create table if not exists ${PRISTINE_TABLE} as
       select workspace_id, user_id, layout from workspaces`,
  );
}

/**
 * Puts one person's workspace back to the layout the seed wrote, and returns how many rows moved.
 *
 * **Every spec that loads the terminal should call this in a `beforeEach`.** Two reasons, and the
 * second is a live defect rather than a precaution:
 *
 *  1. A spec that rearranges panels (TERM-04/05) must not hand its layout to the next spec.
 *  2. Merely RESTORING a workspace currently corrupts it. `App.tsx#onRestored` (L1135) re-runs each
 *     restored frame as the command `"<security display> <fn>"`; the dispatcher resolves that
 *     display as a REF, whose `security.id` is null, so the adapter at `App.tsx` L664 pushes a new
 *     frame with `security: null` — deliberately, and its comment says so. That frame becomes the
 *     active one and is persisted, so the SECOND load of the terminal restores a GP panel with no
 *     instrument and renders `NO_SECURITY_LOADED: GP needs a security`. Measured on
 *     `pm@demo.terminal`'s `p3`; reported as a finding rather than worked around, and this reset is
 *     what keeps it from silently deciding whether a sibling's spec passes.
 *
 * `version` is bumped so that a client holding the old one is told to re-read rather than being
 * allowed to PUT over the reset (API.md §5.7's optimistic concurrency).
 */
export async function resetWorkspace(email: string): Promise<number> {
  const out = await scalar(
    E2E_DATABASE_URL,
    `with reset as (
       update workspaces w
          set layout = p.layout, version = w.version + 1
         from ${PRISTINE_TABLE} p, users u
        where w.workspace_id = p.workspace_id
          and w.user_id = u.user_id
          and lower(u.email) = lower(${quoteLiteral(email)})
        returning 1)
     select count(*) from reset`,
  );
  const rows = Number(out);
  if (rows === 0) {
    throw new Error(
      `resetWorkspace("${email}") matched no workspace. Either the address is not a seeded one, ` +
        `or ${PRISTINE_TABLE} was never captured — re-provision the e2e database.`,
    );
  }
  return rows;
}

/**
 * Forget that this person has ever looked at `ticker`, and return how many days were forgotten.
 *
 * The daily unique-instrument quota (API-06) is counted in `quota_instruments_seen`, one row per
 * `(user, day, instrument)`, inserted if absent by `entitlements/quotas.ts#record`. Nothing in this
 * harness reset it, and the database is provisioned once per RUN — so a spec that asserted an
 * ABSOLUTE numerator passed alone and failed in the suite (that was the `0/500` in `smoke.spec.ts`,
 * which cost 11.1 s of expect-timeout and a red run every time), and a spec that asserts a DELTA is
 * right once and then wrong, because the second run finds the instrument already counted.
 *
 * So the counter gets the same treatment as the workspace: put back what the spec is about to
 * change, and only that. Deliberately narrow — one instrument, not the whole counter — because a
 * spec that wiped the table would be hiding the very charges the other specs make.
 *
 * @throws when the address or the ticker is not a seeded one, which would otherwise look like a
 * quota that failed to move.
 */
export async function forgetInstrumentSeen(email: string, ticker: string): Promise<number> {
  const out = await scalar(
    E2E_DATABASE_URL,
    `with target as (
       select u.user_id, i.instrument_id
         from users u, instruments i
        where lower(u.email) = lower(${quoteLiteral(email)})
          and i.ticker = ${quoteLiteral(ticker)}
        limit 1),
     gone as (
       delete from quota_instruments_seen q
        using target t
        where q.user_id = t.user_id and q.instrument_id = t.instrument_id
       returning 1)
     select (select count(*) from target) || ' ' || (select count(*) from gone)`,
  );
  const [found = '0', deleted = '0'] = out.split(' ');
  if (Number(found) === 0) {
    throw new Error(
      `forgetInstrumentSeen("${email}", "${ticker}") matched no seeded user/instrument pair`,
    );
  }
  return Number(deleted);
}

/* ---------------------------------------------------------------------------------------------- */
/* CLI — `npx tsx packages/e2e/fixtures/database.ts`                                               */
/* ---------------------------------------------------------------------------------------------- */

/**
 * `playwright.config.ts` prefixes exactly this onto the plant's `webServer` command, and a person
 * debugging a spec can run it by hand. It is also the whole of `scripts/e2e-db.ts`'s job, which is
 * why that script was not written: the provisioning and the connection string the suite runs
 * against have to agree, and one module holding both cannot disagree with itself.
 */
export const PROVISION_COMMAND = 'npx tsx packages/e2e/fixtures/database.ts';

const invokedDirectly =
  argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;

if (invokedDirectly) {
  provisionE2eDatabase().catch((err: unknown) => {
    stderr.write(
      `e2e database provisioning failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    exit(1);
  });
}
