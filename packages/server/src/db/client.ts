/**
 * Postgres access — DATA_MODEL §15.1 (L2412-2433), §15.d.1 (L2275-2315), ARCHITECTURE §3.3 L256.
 *
 * Two pools, deliberately:
 *
 *  1. the **application** pool on `DATABASE_URL`, which connects as `terminal_app` in a hardened
 *     deployment. Every request handler, every function resolver and every ingest job runs here,
 *     inside `withTx`, which is the only place `app.user_id` / `app.firm_id` / `app.role` are set —
 *     the settings the RLS policies of DATA_MODEL §15 read.
 *  2. the **maintenance** pool on `DATABASE_URL_MAINT`, `max: 1`, connecting as `terminal_maint`,
 *     the role that owns the six partitioned parents. Only `db/partitions.ts#ensurePartitions` /
 *     `#dropExpired` and `retentionPurge` may use `withMaintTx`; `terminal_app` has SELECT/INSERT
 *     only, so it can neither CREATE nor DROP a partition, nor disable the WORM triggers on
 *     `access_log` / `usage_events`. No `RequestCtx` is ever applied on this pool, so every tenant
 *     policy yields zero rows there.
 *
 * Every connection in both pools runs `SET TIME ZONE 'UTC'`: the `timestamptz` partition bounds of
 * migration 0016 are interpreted in the session time zone (DATA_MODEL §16), so a non-UTC session
 * would route rows into the wrong daily partition.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { getConfig, type Config } from '../config.js';

const { Pool } = pg;

/** The drizzle handle. No schema is bound here: `db/schema/*` is loaded by the repositories. */
export type Db = NodePgDatabase<Record<string, never>>;

/**
 * The transaction handle handed to every callback. Derived from `Db['transaction']` so it tracks
 * the driver's own type without importing drizzle internals.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** DATA_MODEL §15.1 L2415 — the per-request identity the RLS policies read. */
export interface RequestCtx {
  userId: number;
  firmId: number;
  role: 'user' | 'admin' | 'compliance' | 'dataops' | 'helpdesk' | 'newsroom';
  sessionId: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Pools
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface PoolBundle {
  pool: pg.Pool;
  db: Db;
}

let appBundle: PoolBundle | undefined;
let maintBundle: PoolBundle | undefined;

function createBundle(connectionString: string, max: number, label: string): PoolBundle {
  const pool = new Pool({
    connectionString,
    max,
    // Every session is UTC (DATA_MODEL §16) and every statement is bounded so a wedged query
    // cannot hold a partition lock for the life of the process.
    options: '-c timezone=UTC',
    application_name: `terminal-${label}`,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => {
    // An idle client died (server restart, network). pg removes it from the pool; without a
    // listener the error would be an unhandled 'error' event and take the process down.
    process.emitWarning(`pg pool ${label}: idle client error: ${err.message}`);
  });
  return { pool, db: drizzle(pool) };
}

function app(config?: Config): PoolBundle {
  return (appBundle ??= createBundle((config ?? getConfig()).DATABASE_URL, 10, 'app'));
}

/** The application pool's drizzle handle. Prefer `withTx`; direct use bypasses `app.*` settings. */
export function getDb(): Db {
  return app().db;
}

/** The application `pg.Pool` itself — for `LISTEN`, advisory locks and the batched writers. */
export function getPool(): pg.Pool {
  return app().pool;
}

/**
 * Open the pools eagerly and prove the database answers (ARCHITECTURE §12.1 step 2).
 * @throws the underlying pg error when the database is unreachable.
 */
export async function connectDb(config?: Config): Promise<Db> {
  const bundle = app(config);
  const client = await bundle.pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
  return bundle.db;
}

/** Drain both pools (SIGTERM, and `afterAll` in tests). Safe to call twice. */
export async function closeDb(): Promise<void> {
  const open = [appBundle, maintBundle].filter((b): b is PoolBundle => b !== undefined);
  appBundle = undefined;
  maintBundle = undefined;
  await Promise.all(open.map((b) => b.pool.end()));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Transactions
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The transaction in scope for the current async context. Set by `withTx` itself so that a nested
 * `withTx` issues `SAVEPOINT`/`RELEASE` instead of a second `BEGIN`, and by the test harness
 * (`src/test/db.ts`) so that handlers join the harness's rolled-back transaction (TESTING §4.3).
 */
const txStorage = new AsyncLocalStorage<Tx>();

/** Test-only fallback for code paths that lose the async context (see `src/test/db.ts`). */
let ambientTx: Tx | undefined;

/** The transaction in scope, if any. */
export function currentTx(): Tx | undefined {
  return txStorage.getStore() ?? ambientTx;
}

/** Run `fn` with `tx` as the ambient transaction — used by the test harness and by `withTx`. */
export function runWithTx<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  return txStorage.run(tx, fn);
}

/**
 * Test-only: bind a transaction for the whole file/test (`src/test/db.ts` `beforeEach`). Pass
 * `undefined` to clear. Never call this from production code — `runWithTx` is the scoped version.
 */
export function setAmbientTx(tx: Tx | undefined): void {
  ambientTx = tx;
}

/** DATA_MODEL §15.1 L2419-2425 — the only place `app.*` is set. */
async function applyCtx(tx: Tx, ctx: RequestCtx | null): Promise<void> {
  if (ctx === null) return;
  if (ctx.role !== 'newsroom') {
    await tx.execute(sql`SELECT set_config('app.user_id', ${String(ctx.userId)}, true),
                                set_config('app.firm_id', ${String(ctx.firmId)}, true),
                                set_config('app.role', ${ctx.role}, true)`);
  } else {
    // SEC-06: the newsroom role never receives a firm context, so every tenant policy that keys on
    // app.firm_id yields zero rows for it.
    await tx.execute(
      sql`SELECT set_config('app.user_id', ${String(ctx.userId)}, true), set_config('app.role', 'newsroom', true)`,
    );
  }
}

/**
 * Every request handler and every function resolver runs inside `withTx` (DATA_MODEL §15.1 L2416).
 * Ingest jobs call `withTx(null, fn)`: no `app.*` settings, so the tenant policies yield zero rows.
 *
 * Nesting is a `SAVEPOINT`, not a second `BEGIN` (TESTING §4.3): an inner `withTx` that throws
 * rolls back to its savepoint and leaves the outer transaction — including a test harness's — usable.
 */
export async function withTx<T>(ctx: RequestCtx | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const body = async (tx: Tx): Promise<T> => {
    await applyCtx(tx, ctx);
    return runWithTx(tx, () => fn(tx));
  };
  const outer = currentTx();
  // drizzle implements a nested `transaction()` as SAVEPOINT / RELEASE SAVEPOINT.
  if (outer !== undefined) return outer.transaction(body);
  return app().db.transaction(body);
}

/**
 * Partition maintenance only (DATA_MODEL §15.d.1 L2312-2314): a second, single-connection pool on
 * `DATABASE_URL_MAINT` as `terminal_maint`, which owns the six partitioned parents. Nothing else in
 * the process may use it, and no `RequestCtx` is ever set on it.
 *
 * @throws Error when `DATABASE_URL_MAINT` is unset — partition maintenance must fail loudly rather
 *         than silently fall back to `terminal_app`, which cannot CREATE or DROP a partition.
 */
export async function withMaintTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (maintBundle === undefined) {
    const url = getConfig().DATABASE_URL_MAINT;
    if (url === undefined) {
      throw new Error(
        'DATABASE_URL_MAINT is not set: partition maintenance needs the terminal_maint role ' +
          'that owns bars_daily, bars_intraday, quote_ticks, option_quotes, access_log and ' +
          'usage_events (DATA_MODEL §15.d.1).',
      );
    }
    maintBundle = createBundle(url, 1, 'maint');
  }
  // Deliberately not joined to `currentTx()`: the maintenance connection is a different session
  // and a different role, and its DDL must not be nested inside an application transaction.
  return maintBundle.db.transaction(fn);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Migration bookkeeping (ARCHITECTURE §12.1 step 2, GET /health `migrationsPending`)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `packages/server/drizzle/migrations` — the same path from `src/` and from `dist/`. */
const MIGRATIONS_DIR = new URL('../../drizzle/migrations/', import.meta.url);

/** Committed migration filenames, in apply order. */
export async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(fileURLToPath(MIGRATIONS_DIR));
  return entries.filter((name) => name.endsWith('.sql')).sort((a, b) => a.localeCompare(b));
}

/**
 * Migrations present on disk but not recorded as applied.
 *
 * Bookkeeping is drizzle's own `drizzle.__drizzle_migrations` table (created by
 * `drizzle-orm/node-postgres/migrator`, which `scripts/migrate.ts` must use). That table records a
 * hash and a timestamp but not a filename, so the comparison is positional: the first N files are
 * the N applied ones. A missing table means nothing has been applied yet.
 */
export async function pendingMigrations(): Promise<string[]> {
  const files = await migrationFiles();
  const rows = await app()
    .pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM information_schema.tables
        WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'`,
    )
    .then((r) => Number(r.rows[0]?.n ?? '0'));
  if (rows === 0) return files;
  const applied = await app()
    .pool.query<{ n: string }>('SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations')
    .then((r) => Number(r.rows[0]?.n ?? '0'));
  return files.slice(applied);
}

/** `SELECT 1` against the application pool — the `db` field of `GET /health`. */
export async function pingDb(): Promise<boolean> {
  try {
    await app().pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
