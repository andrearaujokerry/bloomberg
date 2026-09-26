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
 * DEVIATION, the second one, and it is a decision rather than a stopgap. §4.2 step 5 seeds the test
 * database unconditionally. That was harmless for thirteen packages because only `seed/licences.ts`
 * existed and the runner skips a module it cannot find — so "run the seed" wrote 33 licence rows and
 * nothing else. WP-15 wrote the other twelve modules, and the step began writing the real universe:
 * 41,455 instruments, 36,188 md lines, 1,264 daily bars, 160 news items.
 *
 * Two contracts then collide, and both are legitimate:
 *
 *   * `test/integration/seed/volumes.test.ts` asserts the seeded volumes of DATA_MODEL §18 and can
 *     only run against a seeded database;
 *   * ~145 ingest and function tests written across WP-05…WP-11 assert what their own job inserted
 *     into an EMPTY table. Against a seeded one they are not merely off by a count — the job
 *     correctly inserts nothing, because the seed already did, which is idempotency working. Worse,
 *     `ingest/marketDataJobs.test.ts` writes an `md_lines` version valid from 2020-01-01 while the
 *     seed holds one from 2026-01-01, and `md_lines_symbol_excl` refuses two open-ended ranges for
 *     one (source, symbol): all 8 of its tests fail with SQLSTATE 23P01, which is the exclusion
 *     constraint doing its job, not a test needing a new number.
 *
 * So the seed is gated on `SEED_TEST_DB` and runs for ONE vitest project, `server-seed`, which owns
 * its own database (`bloomberg_seed_test`). Everything else keeps the empty-database contract it was
 * written against. The alternative — rewriting ~145 committed tests to assert deltas against a
 * shared seeded database — is a much larger change that would also make every one of them depend on
 * a 167 s seed, and it is not obviously more correct.
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

/**
 * The `env` the calling PROJECT declared, which is not the same thing as `process.env`.
 *
 * `globalSetup` runs in the vitest main process, once per project that lists it — three times in a
 * full run today, four with `server-seed` — while a project's `test.env` is applied to its WORKERS.
 * So a project that points `DATABASE_URL` at its own database gets it in the test files and not
 * here, which is exactly the trap this function exists to close: read from `project.config.env`
 * first and fall back to the ambient environment. Before this, `server-seed` migrated
 * `bloomberg_test` (the ambient default) while its tests queried `bloomberg_seed_test`, and two of
 * them PASSED against the empty database they found, because "every seeded value resolves to a
 * fixture" is vacuously true when there are no seeded values.
 */
function projectEnv(project: TestProject): Record<string, string | undefined> {
  const env = (project.config as { env?: Record<string, string | undefined> }).env;
  return env ?? {};
}

/**
 * Does this project want the thirteen-module seed in its database? (`SEED_TEST_DB=1`)
 *
 * Off by default, and the default is the important half. See the second DEVIATION in the header: the
 * seed suites and the ingest-job suites want opposite starting states, and this flag is what lets one
 * `globalSetup` serve both.
 */
function seedRequested(project: TestProject): boolean {
  const flag = projectEnv(project).SEED_TEST_DB ?? process.env.SEED_TEST_DB;
  return flag === '1' || flag === 'true';
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

  // The project's own database first — see `projectEnv`. `server-seed` owns one.
  const databaseUrl =
    projectEnv(project).DATABASE_URL_TEST ??
    projectEnv(project).DATABASE_URL ??
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

  // 5. the seed — only for the project that is testing the seed (`SEED_TEST_DB`, see the DEVIATION
  // in this file's header). Imported lazily: it reads its connection from `server/src/config.ts`,
  // which validates the environment the moment the module is first imported.
  // `runSeed()` opens the application pool through `db/client.ts` and only drains it when
  // `seed/index.ts` was invoked as a script, so the caller closes it — an idle pg pool keeps the
  // event loop alive and vitest would wait ten seconds for the runner to exit.
  //
  // Module 1 (`licences`) runs EITHER WAY and that is not a convenience: it registers the 33 rows of
  // `source_registry`, and `assert_source_known` is a trigger on every table that carries a
  // `source_id`. Without it step 5b's own GICS row is rejected with P0001 `unknown source_id
  // wiki.sp500`, and so is the first write of every suite below. What is gated is modules 2-13 — the
  // ones that put the universe in the database.
  const { runSeed } = await import('../src/seed/index.js');
  const { closeDb } = await import('../src/db/client.js');
  try {
    await runSeed(
      seedRequested(project)
        ? { log: () => undefined }
        : { log: () => undefined, only: ['licences'] },
    );
  } finally {
    await closeDb();
  }

  // 5b. Shared reference rows, committed once.
  //
  // `server-int` runs four forks against one database and every test rolls its transaction back,
  // so a row a test inserts is invisible to its siblings and every fork inserts it again. For the
  // *fixed* reference rows — the GICS scheme, the three exchanges, the three venue calendars —
  // that means four transactions holding speculative-insert locks on the same primary keys at
  // once, in whatever order each file happens to seed them, and Postgres reports 40P01 on
  // whichever pair inverts. The rows are identical in every fork, so the contention buys nothing.
  //
  // Committing them here makes each test's `ON CONFLICT DO NOTHING` a no-op that takes no write
  // lock at all. The tests still seed them — they must stay runnable on their own, and a test that
  // depends on a fixture it does not create is a test that lies about its own inputs — but in a
  // normal run the row is already there and nothing is written.
  await seedSharedReference(databaseUrl);

  // 6. publish the volumes the seed produced. Unseeded, the snapshot is still taken and still
  // published — the numbers are then the migrations' own (zero for every counted table), which is
  // the truth for that database and is what a project asserting "nothing is seeded here" wants.
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

/**
 * The one fixed reference row several integration files share, written once and committed.
 *
 * `classification_schemes` holds a single `GICS` row that four suites seed identically
 * (`DES`, `QM`, `SECF`, `reference-routes`). `server-int` runs four forks against one database and
 * every test rolls back, so each fork finds the table empty and inserts the same primary key: four
 * transactions holding speculative-insert locks on one key, in whatever order each file seeds it,
 * and Postgres reports `40P01 deadlock detected` on whichever pair inverts. The rows are identical,
 * so the contention buys nothing.
 *
 * Committing it here turns each test's seed into a read that finds it (`ensureShared`), so nothing
 * is written and no lock is taken. The tests still carry the seed, because a test must stay
 * runnable on its own.
 *
 * Deliberately *only* this row. `calendars`, `exchanges` and the rest are seeded with a provenance
 * each suite controls, and committing them here would put a row this file chose into payloads whose
 * goldens the suites own — a shared fixture deciding another file's result.
 */
async function seedSharedReference(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO classification_schemes (scheme, name, source_id, levels)
       VALUES ('GICS', 'GICS', 'wiki.sp500', 4) ON CONFLICT (scheme) DO NOTHING`,
    );
  } finally {
    await client.end();
  }
}

declare module 'vitest' {
  interface ProvidedContext {
    __SEED_COUNTS__: SeedCounts;
  }
}
