/**
 * scripts/prepare-database.ts — make a production database ready for the server, in one run that is
 * safe to repeat (docs/DEPLOYMENT.md §7.1). The GitHub job `.github/workflows/prepare-database.yml`
 * runs it from GitHub's network; a person can run it from any network that reaches the database:
 *
 *   read -rs OWNER_URL      # the OWNER's DIRECT (unpooled) connection string; nothing is echoed
 *   npx tsx scripts/prepare-database.ts --url "$OWNER_URL"
 *
 * The URL is never read from `DATABASE_URL` or `.env`: on a development machine those name the local
 * database, and step 5 switches off the accounts that development signs in with. It comes only from
 * `--url` or `PREPARE_DATABASE_URL`.
 *
 * ## The five steps, each idempotent
 *
 *  1. **Roles.** `terminal_app` and `terminal_maint` are created if missing, and the connecting owner
 *     is made a member of `terminal_maint`. Migration 0015 hands the six partitioned tables to
 *     `terminal_maint`, and on Postgres 16+ an owner that is not a superuser — Neon's `neondb_owner`
 *     — may only do that as a member: without this step 0015 stops with `must be able to SET ROLE
 *     "terminal_maint"` (BUILD_STATUS.md, "Deploying on Render").
 *  2. **Passwords**, only when `TERMINAL_APP_PASSWORD` / `TERMINAL_MAINT_PASSWORD` are set. Never
 *     printed. Migration 0015 creates both roles without one, so neither can log in until this or
 *     an `ALTER ROLE` in the provider's console gives it one.
 *  3. **Migrations** — `scripts/migrate.ts#runMigrations`, the one migration path there is.
 *  4. **The seed** — `npm run db:seed`, child process, with the URL in its environment rather than
 *     on its command line.
 *  5. **The demo accounts off.** The seven seeded accounts share a password that is published in
 *     this repository (docs/DEPLOYMENT.md §5), and the seed's upsert writes `status` back — so every
 *     seed re-activates them, and this step has to follow every seed. Their sessions and API keys are
 *     revoked with them.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg from 'pg';

import { runMigrations } from './migrate.js';

const { Client } = pg;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The seeded accounts: `fixtures/seed/users.json`, all on these two domains. */
const DEMO_ACCOUNT_DOMAINS = ['%@demo.terminal', '%@newsco.terminal'] as const;

/** Neon wants 60 bits of entropy; `openssl rand -hex 24` gives 192. Refuse anything obviously short. */
const MIN_PASSWORD = 16;

export interface PrepareOptions {
  databaseUrl: string;
  appPassword?: string | undefined;
  maintPassword?: string | undefined;
  /** For a test: skip the seed (and so the demo-account step's precondition). */
  skipSeed?: boolean;
  log?: (line: string) => void;
}

export interface PrepareResult {
  database: string;
  rolesCreated: string[];
  ownerGrantedMaint: boolean;
  passwordsSet: string[];
  migrationsApplied: number;
  demoAccountsSwitchedOff: string[];
}

/** `--url <value>`, else `PREPARE_DATABASE_URL`. Never `DATABASE_URL` — see the header. */
export function targetUrl(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  const at = argv.indexOf('--url');
  const fromArg = at === -1 ? undefined : argv[at + 1];
  if (at !== -1 && (fromArg === undefined || fromArg.startsWith('--'))) {
    throw new Error('--url needs a value');
  }
  const url = fromArg ?? env.PREPARE_DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'no target database: pass --url "<owner connection string>" or set PREPARE_DATABASE_URL ' +
        '(DATABASE_URL is deliberately not read — it names the local database on a development machine)',
    );
  }
  return url;
}

function checkPassword(name: string, value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (value.length < MIN_PASSWORD) {
    throw new Error(
      `${name} is shorter than ${String(MIN_PASSWORD)} characters — make one with: openssl rand -hex 24`,
    );
  }
  return value;
}

function runSeed(databaseUrl: string, log: (line: string) => void): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // `npm run db:seed` and not the module: its `predb:seed` hook builds @terminal/core first, which
    // the seed imports as built output (packages/e2e/fixtures/database.ts explains the CI failure
    // calling the script directly would be).
    const child = spawn('npm', ['run', 'db:seed'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const relay = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n'))
        if (line.trim() !== '') log(`    ${line}`);
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`the seed exited with code ${String(code)}`));
    });
  });
}

export async function prepareDatabase(opts: PrepareOptions): Promise<PrepareResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const appPassword = checkPassword('TERMINAL_APP_PASSWORD', opts.appPassword);
  const maintPassword = checkPassword('TERMINAL_MAINT_PASSWORD', opts.maintPassword);

  const client = new Client({ connectionString: opts.databaseUrl });
  await client.connect();
  let database: string;
  const rolesCreated: string[] = [];
  let ownerGrantedMaint = false;
  const passwordsSet: string[] = [];
  try {
    const who = await client.query<{ db: string; owner: string; superuser: boolean }>(
      `SELECT current_database() AS db, current_user AS owner,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`,
    );
    const me = who.rows[0]!;
    database = me.db;
    log(
      `prepare-database → database "${me.db}" as "${me.owner}"${me.superuser ? ' (superuser)' : ''}`,
    );

    // 1. Roles.
    log('1/5 roles');
    for (const role of ['terminal_app', 'terminal_maint'] as const) {
      const exists = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
      if (exists.rowCount === 0) {
        await client.query(`CREATE ROLE ${role} LOGIN`);
        rolesCreated.push(role);
        log(`    created ${role}`);
      } else {
        log(`    ${role} exists`);
      }
    }
    // On Postgres 16+ the creator of a role is recorded as a member WITH ADMIN OPTION but without
    // SET — so asking for plain membership answers yes, and 0015 still fails. Ask for SET there; 14
    // and 15 have no SET option, and membership is what `ALTER … OWNER TO` checks on them.
    const member = await client.query<{ member: boolean }>(
      `SELECT CASE WHEN current_setting('server_version_num')::int >= 160000
                   THEN pg_has_role(current_user, 'terminal_maint', 'SET')
                   ELSE pg_has_role(current_user, 'terminal_maint', 'MEMBER') END AS member`,
    );
    if (member.rows[0]?.member !== true) {
      try {
        await client.query(`GRANT terminal_maint TO CURRENT_USER`);
      } catch (err) {
        throw new Error(
          `cannot make "${me.owner}" a member of terminal_maint (${err instanceof Error ? err.message : String(err)}). ` +
            'Run GRANT terminal_maint TO <this owner> as the role that created terminal_maint, then run this again.',
          { cause: err },
        );
      }
      ownerGrantedMaint = true;
      log(
        `    granted terminal_maint to ${me.owner} (migration 0015 hands it the partitioned tables)`,
      );
    }

    // 2. Passwords — the value never appears in a log line, an error message or argv.
    log('2/5 passwords');
    for (const [role, password] of [
      ['terminal_app', appPassword],
      ['terminal_maint', maintPassword],
    ] as const) {
      if (password === undefined) {
        log(
          `    ${role}: not set here (no ${role === 'terminal_app' ? 'TERMINAL_APP' : 'TERMINAL_MAINT'}_PASSWORD)`,
        );
        continue;
      }
      try {
        await client.query(`ALTER ROLE ${role} WITH PASSWORD ${client.escapeLiteral(password)}`);
      } catch (err) {
        // The server's message can quote the statement, and the statement holds the password.
        throw new Error(
          `setting the ${role} password failed (${(err as { code?: string }).code ?? 'no SQLSTATE'})`,
        );
      }
      passwordsSet.push(role);
      log(`    ${role}: password set`);
    }
  } finally {
    await client.end();
  }

  // 3. Migrations.
  log('3/5 migrations');
  const migrated = await runMigrations({
    databaseUrl: opts.databaseUrl,
    log: (line) => log(`  ${line}`),
  });
  log(
    `    ${String(migrated.applied.length)} applied, ${String(migrated.skipped.length)} already applied`,
  );

  // 4. The seed.
  if (opts.skipSeed === true) {
    log('4/5 seed — skipped');
  } else {
    log('4/5 seed (idempotent; a first run takes a minute or more)');
    await runSeed(opts.databaseUrl, log);
  }

  // 5. The demo accounts off — after EVERY seed, because the seed switches them back on.
  log('5/5 demo accounts');
  const after = new Client({ connectionString: opts.databaseUrl });
  await after.connect();
  let switchedOff: string[] = [];
  try {
    await after.query('BEGIN');
    const off = await after.query<{ user_id: string; email: string }>(
      `UPDATE users SET status = 'deprovisioned', deprovisioned_at = coalesce(deprovisioned_at, now())
        WHERE (email LIKE $1 OR email LIKE $2) AND status <> 'deprovisioned'
        RETURNING user_id, email`,
      [...DEMO_ACCOUNT_DOMAINS],
    );
    await after.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = 'deprovisioned'
        WHERE revoked_at IS NULL AND user_id IN (SELECT user_id FROM users WHERE email LIKE $1 OR email LIKE $2)`,
      [...DEMO_ACCOUNT_DOMAINS],
    );
    await after.query(
      `UPDATE api_keys SET revoked_at = now()
        WHERE revoked_at IS NULL AND user_id IN (SELECT user_id FROM users WHERE email LIKE $1 OR email LIKE $2)`,
      [...DEMO_ACCOUNT_DOMAINS],
    );
    await after.query('COMMIT');
    switchedOff = off.rows.map((r) => r.email).sort();
  } catch (err) {
    await after.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await after.end();
  }
  log(
    switchedOff.length === 0
      ? '    none to switch off (already off, or not seeded)'
      : `    switched off ${String(switchedOff.length)}: ${switchedOff.join(', ')}`,
  );

  return {
    database,
    rolesCreated,
    ownerGrantedMaint,
    passwordsSet,
    migrationsApplied: migrated.applied.length,
    demoAccountsSwitchedOff: switchedOff,
  };
}

async function main(): Promise<void> {
  const databaseUrl = targetUrl(process.argv.slice(2), process.env);
  const result = await prepareDatabase({
    databaseUrl,
    appPassword: process.env.TERMINAL_APP_PASSWORD,
    maintPassword: process.env.TERMINAL_MAINT_PASSWORD,
  });
  console.log(`\nready: "${result.database}".`);
  if (result.passwordsSet.length < 2) {
    console.log(
      'Before the server can connect as terminal_app / terminal_maint, give each role a password ' +
        '(ALTER ROLE … WITH PASSWORD in the provider console, or TERMINAL_*_PASSWORD here).',
    );
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`prepare-database failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
