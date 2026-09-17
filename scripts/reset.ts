/**
 * `scripts/reset.ts` — `npm run db:reset` (WORKPLAN §1.10): drop the schema, re-apply every
 * migration, optionally re-seed.
 *
 * This is the recovery path the migration runner points at: it is the only way back from a failed
 * migration that ran before `schema_meta` existed, and it is how the test database is rebuilt when
 * a migration changes. `DROP SCHEMA public CASCADE` takes the extensions with it — `0001` recreates
 * them — but it deliberately does **not** touch the cluster-level `terminal_app` role, which
 * `0015` creates only when absent and which `bloomberg_dev` and `bloomberg_test` share.
 *
 * It refuses to run against a database whose name does not look disposable (`*_dev`, `*_test`,
 * `*_scratch`, `*_local`) unless `--force` is given: this command destroys everything.
 *
 * Usage:
 *   tsx scripts/reset.ts                   # DATABASE_URL, migrate only
 *   tsx scripts/reset.ts --test            # DATABASE_URL_TEST
 *   tsx scripts/reset.ts --seed            # migrate, then run the seed
 *   tsx scripts/reset.ts --url postgres://… --force
 */

import { pathToFileURL } from 'node:url';

import pg from 'pg';

import { databaseUrlFromArgv, loadDotEnv, runMigrations } from './migrate.js';
import { runSeed } from './seed.js';

const { Client } = pg;

const DISPOSABLE = /(^|[_-])(dev|test|scratch|local)$/;

export function databaseNameOf(url: string): string {
  const path = new URL(url).pathname;
  return path.startsWith('/') ? path.slice(1) : path;
}

export interface ResetOptions {
  databaseUrl: string;
  force?: boolean;
  log?: (line: string) => void;
}

/** Drops and recreates `public`, leaving an empty database ready for the migrations. */
export async function dropSchema(opts: ResetOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const name = databaseNameOf(opts.databaseUrl);
  if (!DISPOSABLE.test(name) && opts.force !== true) {
    throw new Error(
      `refusing to reset database '${name}': the name does not end in _dev, _test, _scratch or _local. ` +
        'Pass --force if you really mean it.',
    );
  }
  const client = new Client({ connectionString: opts.databaseUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public AUTHORIZATION CURRENT_USER');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
    log(`  dropped schema public in ${name}`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const argv = process.argv.slice(2);
  const databaseUrl = databaseUrlFromArgv(argv);
  const force = argv.includes('--force');
  const withSeed = argv.includes('--seed');
  const redacted = databaseUrl.replace(/\/\/[^@/]*@/, '//***@');
  console.log(`reset → ${redacted}`);

  await dropSchema({ databaseUrl, force });
  const { applied } = await runMigrations({ databaseUrl });
  console.log(`  ${applied.length} migrations applied`);

  if (withSeed) {
    await runSeed({ databaseUrl });
    console.log('  seed complete');
  } else {
    console.log('  skipped seed (pass --seed to run it)');
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`reset failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
