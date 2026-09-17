/**
 * `scripts/migrate.ts` — the migration runner (`npm run db:migrate`, WORKPLAN §1.4, §1.10).
 *
 * Applies every unapplied file in `packages/server/drizzle/migrations` in lexical order, each in
 * its own transaction, records it in `schema_meta`, and is idempotent: a second run applies
 * nothing. A single session-level advisory lock serialises concurrent runners.
 *
 * Bookkeeping lives in `schema_meta` (key `migration:<filename>`, value the file's sha256) because
 * that is the only table the data model gives for it — and `schema_meta` is itself created by
 * `0014_ops.sql`. The runner therefore buffers the filenames it has applied until the table
 * exists, and flushes the buffer inside the transaction that creates it. The consequence worth
 * knowing: a run that fails *before* 0014 leaves no record, so recovery is `npm run db:reset`
 * rather than a re-run.
 *
 * Usage:
 *   tsx scripts/migrate.ts                 # DATABASE_URL
 *   tsx scripts/migrate.ts --test          # DATABASE_URL_TEST
 *   tsx scripts/migrate.ts --url postgres://…
 *   tsx scripts/migrate.ts --dry-run       # list what would be applied
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg from 'pg';

const { Client } = pg;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'packages/server/drizzle/migrations');

/** `schema_meta` key prefix for the migration ledger. */
const KEY_PREFIX = 'migration:';
/** `pg_advisory_lock` key: one migrator at a time per database. */
const LOCK_SQL = "SELECT pg_advisory_lock(hashtext('terminal-migrate'))";

export interface MigrateOptions {
  databaseUrl: string;
  dryRun?: boolean;
  /** Defaults to `console.log`. */
  log?: (line: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/** Reads `.env` into `process.env` when present; explicit environment wins. */
export function loadDotEnv(): void {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const host = process as NodeJS.Process & { loadEnvFile?: (path: string) => void };
  if (typeof host.loadEnvFile !== 'function') return;
  try {
    host.loadEnvFile(envPath);
  } catch {
    /* a malformed .env is not this script's problem: the explicit variables still apply */
  }
}

/** `--url <u>` beats `--test` (DATABASE_URL_TEST) beats DATABASE_URL. */
export function databaseUrlFromArgv(argv: readonly string[]): string {
  const at = argv.indexOf('--url');
  const explicit = at === -1 ? undefined : argv[at + 1];
  if (at !== -1 && (explicit === undefined || explicit.startsWith('--'))) {
    throw new Error('--url needs a connection string');
  }
  const envVar = argv.includes('--test') ? 'DATABASE_URL_TEST' : 'DATABASE_URL';
  const url = explicit ?? process.env[envVar];
  if (url === undefined || url === '') {
    throw new Error(`${envVar} is not set (copy .env.example to .env, or pass --url)`);
  }
  return url;
}

export function migrationFiles(): string[] {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(`missing ${MIGRATIONS_DIR} — the migrations are packages/server's`);
  }
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function schemaMetaExists(client: pg.Client): Promise<boolean> {
  const res = await client.query<{ present: boolean }>(
    "SELECT to_regclass('public.schema_meta') IS NOT NULL AS present",
  );
  return res.rows[0]?.present === true;
}

async function appliedLedger(client: pg.Client): Promise<Map<string, string>> {
  if (!(await schemaMetaExists(client))) return new Map();
  const res = await client.query<{ key: string; value: string }>(
    'SELECT key, value FROM schema_meta WHERE key LIKE $1',
    [`${KEY_PREFIX}%`],
  );
  return new Map(res.rows.map((r) => [r.key.slice(KEY_PREFIX.length), r.value]));
}

async function record(client: pg.Client, file: string, checksum: string): Promise<void> {
  await client.query(
    `INSERT INTO schema_meta (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [`${KEY_PREFIX}${file}`, checksum],
  );
}

export async function runMigrations(opts: MigrateOptions): Promise<MigrateResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const files = migrationFiles();
  const client = new Client({ connectionString: opts.databaseUrl });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  /** Applied while `schema_meta` did not exist yet; flushed the moment it does. */
  const pending: { file: string; checksum: string }[] = [];

  try {
    await client.query(LOCK_SQL);
    const ledger = await appliedLedger(client);

    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = sha256Hex(sql);
      const recorded = ledger.get(file);
      if (recorded !== undefined) {
        if (recorded !== checksum) {
          log(
            `  DRIFT   ${file} — applied content differs from the file on disk (db:reset to fix)`,
          );
        } else {
          log(`  skip    ${file}`);
        }
        skipped.push(file);
        continue;
      }
      if (opts.dryRun === true) {
        log(`  would   ${file}`);
        applied.push(file);
        continue;
      }
      const started = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(sql);
        if (await schemaMetaExists(client)) {
          for (const p of pending) await record(client, p.file, p.checksum);
          pending.length = 0;
          await record(client, file, checksum);
        } else {
          pending.push({ file, checksum });
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
      log(`  applied ${file}  (${Date.now() - started} ms)`);
      applied.push(file);
    }

    if (pending.length > 0) {
      log(
        `  note    ${pending.length} migration(s) applied before schema_meta existed and are unrecorded`,
      );
    }
    return { applied, skipped };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const databaseUrl = databaseUrlFromArgv(process.argv.slice(2));
  const dryRun = process.argv.includes('--dry-run');
  const redacted = databaseUrl.replace(/\/\/[^@/]*@/, '//***@');
  console.log(`migrate → ${redacted}${dryRun ? ' (dry run)' : ''}`);
  const { applied, skipped } = await runMigrations({ databaseUrl, dryRun });
  console.log(
    `  ${applied.length} ${dryRun ? 'pending' : 'applied'}, ${skipped.length} already applied`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`migration failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
