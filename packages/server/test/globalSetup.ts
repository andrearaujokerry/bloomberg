/**
 * `packages/server/test/globalSetup.ts` — migrations and seed, once per vitest invocation
 * (TESTING.md §4.2 L194-216). Runs before any `server-int` file, in the vitest main process.
 *
 * The steps are §4.2's, with one documented deviation:
 *
 *   1. connect as the owner and assert `current_database()` looks like a test database;
 *   2. read `schema_meta` where `key = 'migration'`; when the stored value equals the sha256 of
 *      every `drizzle/migrations/*.sql` concatenated in name order, skip to step 5;
 *   3. otherwise `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` and re-apply every migration
 *      through `scripts/migrate.ts#runMigrations()` — the exact code path `npm run db:migrate`
 *      uses, so CI never has a second migration mechanism. (`0001` recreates the four extensions,
 *      which the drop took with it.)
 *   4. write the new hash into `schema_meta`;
 *   5. run the seed (`server/src/seed/index.ts`) with `PROVIDER_MODE=replay`;
 *   6. snapshot the seeded row counts into `globalThis.__SEED_COUNTS__`, and — because a
 *      `globalSetup` module runs in a different process from the test files — also into the
 *      `provide`/`inject` channel under the same name, which is how a forked test reads them.
 *
 * DEVIATION (recorded here rather than in the design): §4.2 step 4 also calls `ensurePartitions()`
 * from `server/src/db/partitions.ts`. That module is a later work package's and does not exist yet;
 * `0016_partitions_initial.sql` creates the partitions the fixture date range needs, so the step is
 * a no-op today. When `partitions.ts` lands, call it here between steps 3 and 4.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import type { TestProject } from 'vitest/node';

import { runMigrations } from '../../../scripts/migrate.js';

const { Client } = pg;

const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle/migrations/', import.meta.url));

/** `schema_meta` key holding the hash of the whole migration set (TESTING §4.2 step 2). */
const SCHEMA_HASH_KEY = 'migration';

/** Tables whose seeded volumes `test/integration/seed/*.test.ts` asserts (TESTING §4.2 step 6). */
const COUNTED_TABLES: readonly string[] = [
  'licence_registry',
  'field_licence',
  'source_registry',
  'instruments',
  'listings',
  'issuers',
  'index_members',
  'users',
  'firms',
];

export type SeedCounts = Readonly<Record<string, number>>;

function defaultEnv(key: string, value: string): void {
  if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
}

/** sha256 of every migration file, concatenated in name order. */
function migrationSetHash(): string {
  const hash = createHash('sha256');
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of files) {
    hash.update(name, 'utf8');
    hash.update(readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8'), 'utf8');
  }
  return hash.digest('hex');
}

async function storedHash(client: pg.Client): Promise<string | null> {
  const present = await client.query<{ present: boolean }>(
    "SELECT to_regclass('public.schema_meta') IS NOT NULL AS present",
  );
  if (present.rows[0]?.present !== true) return null;
  const row = await client.query<{ value: string }>(
    'SELECT value FROM schema_meta WHERE key = $1',
    [SCHEMA_HASH_KEY],
  );
  return row.rows[0]?.value ?? null;
}

async function countRows(client: pg.Client): Promise<SeedCounts> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const exists = await client.query<{ present: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      [`public.${table}`],
    );
    if (exists.rows[0]?.present !== true) continue;
    const res = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    counts[table] = Number(res.rows[0]?.n ?? '0');
  }
  return counts;
}

export default async function setup(project: TestProject): Promise<void> {
  const startedAt = Date.now();

  defaultEnv('PROVIDER_MODE', 'replay');
  defaultEnv('DATABASE_URL_TEST', 'postgres://localhost:5432/bloomberg_test');
  defaultEnv('SEC_USER_AGENT', 'Terminal Clone test (tests@example.invalid)');
  defaultEnv('SESSION_SECRET', 'test-only-session-secret-0123456789');
  defaultEnv('LOG_LEVEL', 'silent');

  const databaseUrl =
    process.env.DATABASE_URL_TEST ??
    process.env.DATABASE_URL ??
    'postgres://localhost:5432/bloomberg_test';
  process.env.DATABASE_URL = databaseUrl;

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // 1. the interlock: this script drops a schema, so it never runs anywhere but a test database.
    const current = await client.query<{ name: string }>('SELECT current_database() AS name');
    const name = current.rows[0]?.name ?? '';
    if (!name.toLowerCase().includes('test')) {
      throw new Error(
        `refusing to prepare "${name}": globalSetup drops and recreates the public schema — ` +
          'point DATABASE_URL_TEST at bloomberg_test',
      );
    }

    // 2-4. migrate when the migration set changed.
    const wanted = migrationSetHash();
    if ((await storedHash(client)) !== wanted) {
      await client.query('DROP SCHEMA IF EXISTS public CASCADE');
      await client.query('CREATE SCHEMA public');
      await runMigrations({ databaseUrl, log: () => undefined });
      await client.query(
        `INSERT INTO schema_meta (key, value, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [SCHEMA_HASH_KEY, wanted],
      );
    }
  } finally {
    await client.end();
  }

  // 5. the seed. Imported lazily: it reads its connection from `server/src/config.ts`, which
  // validates the environment the moment the module is first imported.
  // `runSeed()` opens the application pool through `db/client.ts` and only drains it when
  // `seed/index.ts` was invoked as a script, so the caller closes it — an idle pg pool keeps the
  // event loop alive and vitest would wait ten seconds for the runner to exit.
  const { runSeed } = await import('../src/seed/index.js');
  const { closeDb } = await import('../src/db/client.js');
  try {
    await runSeed({ log: () => undefined });
  } finally {
    await closeDb();
  }

  // 6. publish the volumes the seed produced.
  const counter = new Client({ connectionString: databaseUrl });
  await counter.connect();
  let counts: SeedCounts;
  try {
    counts = await countRows(counter);
  } finally {
    await counter.end();
  }
  (globalThis as unknown as Record<string, unknown>).__SEED_COUNTS__ = counts;
  project.provide('__SEED_COUNTS__', counts);

  // TESTING §7 budget: "Seed + migrate (CI cost) < 120 s cold … globalSetup logs the duration".
  process.stdout.write(`  globalSetup: migrate + seed in ${Date.now() - startedAt} ms\n`);
}

declare module 'vitest' {
  interface ProvidedContext {
    __SEED_COUNTS__: SeedCounts;
  }
}
