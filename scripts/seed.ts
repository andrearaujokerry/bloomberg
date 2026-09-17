/**
 * `scripts/seed.ts` — the `npm run db:seed` entry point (WORKPLAN §1.10, DATA_MODEL §18).
 *
 * The seed itself is `packages/server/src/seed/index.ts`, the ordered runner: thirteen modules in
 * a fixed order, one transaction each, deterministic and idempotent, reading only
 * `fixtures/providers/raw/*` through the replay store and `fixtures/seed/*.json`, so every seeded
 * value carries a `provenance` row pointing at a fixture. This script only resolves configuration
 * and hands over — it contains no seed logic of its own, so a change to the seed never touches it.
 *
 * Usage:
 *   tsx scripts/seed.ts                    # DATABASE_URL
 *   tsx scripts/seed.ts --test             # DATABASE_URL_TEST
 *   tsx scripts/seed.ts --url postgres://…
 *   tsx scripts/seed.ts --only licences,universe
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { databaseUrlFromArgv, loadDotEnv } from './migrate.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_ENTRY = join(ROOT, 'packages/server/src/seed/index.ts');

/** The names the seed runner may export, in the order they are tried. */
const ENTRY_NAMES = ['runSeed', 'seed', 'main', 'default'] as const;

export interface SeedOptions {
  databaseUrl: string;
  /** Module names from DATA_MODEL §18's table; empty = all, in order. */
  only?: readonly string[];
}

function parseOnly(argv: readonly string[]): string[] {
  const at = argv.indexOf('--only');
  if (at === -1) return [];
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--only needs a comma-separated list of seed module names');
  }
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function runSeed(opts: SeedOptions): Promise<void> {
  if (!existsSync(SEED_ENTRY)) {
    throw new Error(
      `the seed runner ${SEED_ENTRY.slice(ROOT.length + 1)} does not exist yet ` +
        '(WORKPLAN §1.8 — `server/src/seed/index.ts` plus `seed/licences.ts` are WP-01, modules 2-13 are WP-15)',
    );
  }
  // The runner reads its connection from `server/src/config.ts`, which validates the environment
  // the moment the module is imported — so the resolved URL is published before the import, not
  // passed as an argument.
  process.env.DATABASE_URL = opts.databaseUrl;
  const mod: unknown = await import(pathToFileURL(SEED_ENTRY).href);
  const bag = mod as Record<string, unknown>;
  const name = ENTRY_NAMES.find((n) => typeof bag[n] === 'function');
  if (name === undefined) {
    throw new Error(
      `packages/server/src/seed/index.ts exports none of ${ENTRY_NAMES.join(', ')} — ` +
        'the ordered seed runner must export one of them',
    );
  }
  const entry = bag[name] as (options: { only?: readonly string[] }) => unknown;
  await entry(opts.only !== undefined && opts.only.length > 0 ? { only: opts.only } : {});
}

async function main(): Promise<void> {
  loadDotEnv();
  const argv = process.argv.slice(2);
  const databaseUrl = databaseUrlFromArgv(argv);
  const only = parseOnly(argv);
  const redacted = databaseUrl.replace(/\/\/[^@/]*@/, '//***@');
  console.log(`seed → ${redacted}${only.length > 0 ? ` (only ${only.join(', ')})` : ''}`);
  await runSeed({ databaseUrl, only });
  console.log('  seed complete');
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
