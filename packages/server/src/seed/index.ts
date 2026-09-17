/**
 * Ordered seed runner — DATA_MODEL §18 (L2551-2572), ARCHITECTURE §3.3 L351.
 *
 * `npm run db:seed` runs as the database owner, is deterministic and idempotent (`upsertVersion`
 * no-ops on identical data; time-series upsert on natural keys), and reads only
 * `fixtures/providers/raw/*` through the replay store and `fixtures/seed/*.json`. Every seeded
 * value therefore carries a `provenance` row that points at a fixture — the seed is not allowed to
 * invent data (DATA-10).
 *
 * Order is the module order of DATA_MODEL §18 and it is a dependency order, not a preference:
 * `licences` first because `assert_source_known` gates every other write in the database;
 * `universe` before anything that references an instrument; `rates` before `curves`; `bars` before
 * `fundamentals`; `users` before `workspaces`.
 *
 * Each module is **one transaction**: a module either lands completely or not at all, and a failure
 * in module 8 leaves modules 1-7 committed so the run can be resumed with `only`.
 *
 * Modules that a later work package still owns are skipped with a warning rather than failing the
 * run — WP-01 ships only `seed/licences.ts` (module 1); WP-15 ships the other twelve.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SystemClock, type Clock } from '@terminal/core';

import { drizzle } from 'drizzle-orm/node-postgres';

import { getConfig, type Config } from '../config.js';
import { closeDb, getPool, type Db } from '../db/client.js';

/**
 * What a seed module is handed: its own open transaction, three ways.
 *
 * `query` is first and is the reason this interface is shaped the way it is — the seed writes with
 * hand-written SQL (bitemporal upserts, `ON CONFLICT … WHERE`, `assert_source_known` round-trips)
 * that the drizzle query builder would only obscure, and a module written against a bare
 * `{ query(text, values) }` executor (like `seed/licences.ts`) can take the context directly.
 * `db` is the same connection through drizzle for modules that prefer the builder.
 */
export interface SeedContext {
  /** Parameterised SQL on this module's transaction. */
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  /** The same connection, through drizzle. */
  db: Db;
  config: Config;
  clock: Clock;
  /** Progress line; the runner prefixes it with the module name. */
  log: (message: string) => void;
}

/**
 * Rows written per table (or per counter), for the run summary. Returning nothing is fine; any
 * non-numeric field of a returned object is ignored.
 */
export type SeedResult = Record<string, unknown> | void;

/** The shape a seed module exports (as `seed`, `run` or `default`). */
export type SeedFn = (ctx: SeedContext) => Promise<SeedResult>;

/** A module may also export an object with a `run` method. */
export interface SeedModule {
  name?: string;
  run: SeedFn;
}

interface SeedStep {
  /** Module order of DATA_MODEL §18. */
  order: number;
  name: string;
  specifier: string;
  /** Which §18 rows this module covers, for the log line. */
  covers: string;
}

/** DATA_MODEL §18 L2556-2572 — thirteen numbered rows across nine modules. */
export const SEED_ORDER: readonly SeedStep[] = [
  {
    order: 1,
    name: 'licences',
    specifier: './licences.js',
    covers: '1 — licence_registry, field_licence',
  },
  {
    order: 2,
    name: 'universe',
    specifier: './universe.js',
    covers: '2-5 — calendars, US universe, S&P 500, indices/FX/crypto',
  },
  {
    order: 3,
    name: 'rates',
    specifier: './rates.js',
    covers: '6 — treasuries, rate fixings, H.15 series',
  },
  {
    order: 4,
    name: 'curves',
    specifier: './curves.js',
    covers: '7 — curves, curve_points, curve_builds',
  },
  {
    order: 5,
    name: 'bars',
    specifier: './bars.js',
    covers: '8-9 — daily/intraday bars, corporate actions, options, quotes',
  },
  {
    order: 6,
    name: 'fundamentals',
    specifier: './fundamentals.js',
    covers: '10 — xbrl_facts, filings, frames, fin_statements',
  },
  {
    order: 7,
    name: 'news',
    specifier: './news.js',
    covers: '11 — news, topics, econ series and releases',
  },
  {
    order: 8,
    name: 'users',
    specifier: './users.js',
    covers: '12 — firms, users, entitlements, rooms, messages',
  },
  {
    order: 9,
    name: 'workspaces',
    specifier: './workspaces.js',
    covers: '13 — workspaces, watchlists, portfolios',
  },
];

export interface RunSeedOptions {
  /** Restrict the run to these module names (still in `SEED_ORDER` order). */
  only?: readonly string[];
  /** Progress sink; defaults to stdout. */
  log?: (message: string) => void;
  clock?: Clock;
}

export interface SeedStepReport {
  name: string;
  status: 'ok' | 'skipped';
  ms: number;
  rows: Record<string, number>;
}

export interface SeedSummary {
  steps: SeedStepReport[];
  totalMs: number;
}

/** True when the module exists next to this file (`.ts` under tsx, `.js` after a build). */
function moduleExists(specifier: string): boolean {
  const base = specifier.replace(/^\.\//, '').replace(/\.js$/, '');
  for (const ext of ['.js', '.ts']) {
    if (existsSync(fileURLToPath(new URL(`./${base}${ext}`, import.meta.url)))) return true;
  }
  return false;
}

function asSeedModule(value: unknown): SeedFn | undefined {
  if (typeof value === 'function') return value as SeedFn;
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as SeedModule).run === 'function'
  ) {
    return (value as SeedModule).run;
  }
  return undefined;
}

/**
 * Find the entry point of a seed module. Accepted, in order: `seed`, `run`, `default`, then any
 * export named `<something>SeedModule` (the shape `seed/licences.ts` exports) — either a function
 * or an object with a `run` method.
 */
function resolveSeedFn(mod: Record<string, unknown>): SeedFn | undefined {
  for (const key of ['seed', 'run', 'default']) {
    const fn = asSeedModule(mod[key]);
    if (fn !== undefined) return fn;
  }
  for (const [key, value] of Object.entries(mod)) {
    if (!key.endsWith('SeedModule')) continue;
    const fn = asSeedModule(value);
    if (fn !== undefined) return fn;
  }
  return undefined;
}

/** Keep only the numeric fields of a module's result, for the summary line. */
function numericRows(result: SeedResult): Record<string, number> {
  const out: Record<string, number> = {};
  if (result === undefined || result === null) return out;
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * Run the seed modules in order. Safe to re-run: every module is idempotent by contract, so a
 * partial run is resumed by running the whole thing again.
 */
export async function runSeed(options: RunSeedOptions = {}): Promise<SeedSummary> {
  const config = getConfig();
  const clock = options.clock ?? new SystemClock();
  const log = options.log ?? ((message: string): void => void process.stdout.write(`${message}\n`));
  const only = options.only === undefined ? undefined : new Set(options.only);

  const startedAt = clock.now();
  const steps: SeedStepReport[] = [];

  for (const step of SEED_ORDER) {
    if (only !== undefined && !only.has(step.name)) continue;

    if (!moduleExists(step.specifier)) {
      log(
        `seed ${step.order}/${SEED_ORDER.length} ${step.name}: skipped — not implemented yet (${step.covers})`,
      );
      steps.push({ name: step.name, status: 'skipped', ms: 0, rows: {} });
      continue;
    }

    const mod = (await import(step.specifier)) as Record<string, unknown>;
    const fn = resolveSeedFn(mod);
    if (fn === undefined) {
      throw new TypeError(
        `seed/${step.name}.ts must export a seed function as \`seed\`, \`run\` or \`default\``,
      );
    }

    const t0 = clock.now();
    log(`seed ${step.order}/${SEED_ORDER.length} ${step.name}: ${step.covers}`);

    // One transaction per module (DATA_MODEL §18), on one checked-out connection so that `query`
    // and `db` are the same session. No `app.*` settings are set: the seed runs as the database
    // owner and the tenant policies do not apply to it.
    const client = await getPool().connect();
    let rows: Record<string, number>;
    try {
      await client.query('BEGIN');
      const ctx: SeedContext = {
        query: (text, values) => client.query(text, values),
        db: drizzle(client),
        config,
        clock,
        log: (message) => log(`  ${step.name}: ${message}`),
      };
      rows = numericRows(await fn(ctx));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    const ms = clock.now() - t0;
    steps.push({ name: step.name, status: 'ok', ms, rows });
    const counts = Object.entries(rows)
      .map(([table, n]) => `${table}=${n}`)
      .join(' ');
    log(
      `seed ${step.order}/${SEED_ORDER.length} ${step.name}: ok in ${ms} ms${counts === '' ? '' : ` (${counts})`}`,
    );
  }

  return { steps, totalMs: clock.now() - startedAt };
}

/** `tsx packages/server/src/seed/index.ts [moduleName …]` — `scripts/seed.ts` is the usual entry. */
const entry = process.argv[1];
const invokedDirectly = entry !== undefined && pathToFileURL(entry).href === import.meta.url;

if (invokedDirectly) {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  try {
    const summary = await runSeed(only.length > 0 ? { only } : {});
    process.stdout.write(`seed complete in ${summary.totalMs} ms\n`);
  } catch (err) {
    process.stderr.write(
      `seed failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
