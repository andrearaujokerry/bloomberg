/**
 * Transactional test harness — TESTING.md §4.3/§4.4, ARCHITECTURE §3.3 L352-353.
 *
 * `withTxDb()` is the default: one checked-out `pg` client per test, `BEGIN` before the test body,
 * `ROLLBACK` after it, with drizzle bound to that single client so every repository, service and
 * route handler in the test sees the same open transaction. The transaction is also published as
 * the ambient transaction (`db/client.ts#setAmbientTx`), so a handler's own `withTx(ctx, …)` opens
 * a `SAVEPOINT` inside it instead of a second connection that cannot see the test's writes.
 *
 * `withCleanDb(tables)` is for the three things that cross the test transaction (TESTING §4.4):
 * the batched `access_log` writer, partition DDL, and session-scoped advisory locks. It truncates
 * the named tables before each test and lets writes commit.
 *
 * Both refuse to run against a database whose name does not contain `test`. Truncating
 * `bloomberg_dev` by a mistyped `DATABASE_URL` is a five-minute mistake and an hour of reseeding.
 *
 * Sequences are not rolled back: never assert a literal `bigserial` value, always read the id back
 * from the insert (TESTING §4.3).
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

import { getConfig } from '../config.js';
import { setAmbientTx, type Tx } from '../db/client.js';

const { Pool } = pg;

/** Roles a test may adopt — the `users.role` CHECK of DATA_MODEL §15.1. */
export type TestRole = 'user' | 'admin' | 'compliance' | 'dataops' | 'helpdesk' | 'newsroom';

export interface TestDb {
  /** The open transaction: hand this to repositories and services under test. */
  readonly db: Tx;
  /** The connection the transaction runs on — for raw SQL and `SET LOCAL`. */
  readonly client: pg.PoolClient;
  /** Run `fn` inside a savepoint; a throw rolls back to it and leaves the test transaction usable. */
  savepoint<T>(fn: () => Promise<T>): Promise<T>;
}

/** Resolve the test database URL and refuse anything that is not obviously a test database. */
export function testDatabaseUrl(): string {
  const config = getConfig();
  const url = config.DATABASE_URL_TEST ?? config.DATABASE_URL;
  const dbName = url.split('/').pop()?.split('?')[0] ?? '';
  if (!dbName.toLowerCase().includes('test')) {
    throw new Error(
      `refusing to run the test harness against "${dbName}": set DATABASE_URL (or ` +
        'DATABASE_URL_TEST) to bloomberg_test — the harness truncates and rolls back.',
    );
  }
  return url;
}

function newPool(): pg.Pool {
  const pool = new Pool({
    connectionString: testDatabaseUrl(),
    max: 4,
    options: '-c timezone=UTC',
    application_name: 'terminal-test',
  });
  pool.on('error', () => undefined);
  return pool;
}

/** Thrown to force the held-open transaction to roll back; swallowed by the harness. */
class RollbackSignal extends Error {
  constructor() {
    super('test harness rollback');
    this.name = 'RollbackSignal';
  }
}

interface MutableTestDb {
  db: Tx;
  client: pg.PoolClient;
  savepoint<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * `beforeEach` BEGIN … `afterEach` ROLLBACK. The default harness (TESTING §4.3).
 *
 * The transaction is opened through drizzle (rather than a bare `BEGIN`) so the handle handed to
 * the test is a real `Tx`: a nested `withTx` then issues `SAVEPOINT`/`RELEASE`, which is what makes
 * `test/integration/txnesting.test.ts` pass.
 */
export function withTxDb(): TestDb {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let finish: (() => void) | undefined;
  let running: Promise<void> | undefined;
  let counter = 0;

  const handle: MutableTestDb = {
    // Replaced in beforeEach; reading it outside a test is a programming error.
    db: undefined as unknown as Tx,
    client: undefined as unknown as pg.PoolClient,
    async savepoint<T>(fn: () => Promise<T>): Promise<T> {
      const name = `sp_${++counter}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        const result = await fn();
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw err;
      }
    },
  };

  beforeAll(() => {
    pool = newPool();
  });

  beforeEach(async () => {
    client = await pool.connect();
    handle.client = client;
    const clientDb = drizzle(client);

    // Hold one transaction open across the test body: the callback parks on `gate` until
    // `afterEach` releases it, then throws so drizzle issues ROLLBACK.
    let ready: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });

    running = clientDb
      .transaction(async (tx) => {
        handle.db = tx;
        setAmbientTx(tx);
        ready?.();
        await gate;
        throw new RollbackSignal();
      })
      .catch((err: unknown) => {
        if (!(err instanceof RollbackSignal)) throw err;
      });

    await started;
  });

  afterEach(async () => {
    setAmbientTx(undefined);
    finish?.();
    finish = undefined;
    await running;
    running = undefined;
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  return handle;
}

/**
 * Truncate `tables` (and their partitions, via the parent) before each test and let writes commit.
 * For the cases rollback cannot serve: the batched `access_log`/`usage_events` writers, partition
 * DDL, and `pg_try_advisory_lock` leader election (TESTING §4.4).
 *
 * Seeded rows in the listed tables are destroyed for the rest of the run, so only name tables the
 * seed does not own, or reseed them in the test.
 */
export function withCleanDb(tables: readonly string[]): TestDb {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let counter = 0;

  for (const table of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
      throw new Error(`withCleanDb: unsafe table name ${JSON.stringify(table)}`);
    }
  }

  const handle: MutableTestDb = {
    db: undefined as unknown as Tx,
    client: undefined as unknown as pg.PoolClient,
    async savepoint<T>(fn: () => Promise<T>): Promise<T> {
      const name = `sp_${++counter}`;
      await client.query('BEGIN');
      await client.query(`SAVEPOINT ${name}`);
      try {
        const result = await fn();
        await client.query(`RELEASE SAVEPOINT ${name}`);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    },
  };

  beforeAll(() => {
    pool = newPool();
  });

  beforeEach(async () => {
    client = await pool.connect();
    handle.client = client;
    // `Tx` and the pooled `Db` share the query surface the repositories use; there is no open
    // transaction here by design, so writes commit and the batched writers can observe them.
    handle.db = drizzle(client) as unknown as Tx;
    if (tables.length > 0) {
      await client.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
    }
  });

  afterEach(() => {
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  return handle;
}

/**
 * Adopt an identity for the rest of the current transaction — the same settings `withTx` sets in
 * production (DATA_MODEL §15.1). Transaction-scoped, so the rollback undoes it.
 *
 * Pass `role: 'newsroom'` to get the SEC-06 shape: a user id and no firm context.
 */
export async function asUser(
  t: TestDb,
  userId: number,
  firmId: number,
  role: TestRole = 'user',
): Promise<void> {
  if (role === 'newsroom') {
    await t.client.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.role', 'newsroom', true)`,
      [String(userId)],
    );
    return;
  }
  await t.client.query(
    `SELECT set_config('app.user_id', $1, true),
            set_config('app.firm_id', $2, true),
            set_config('app.role', $3, true)`,
    [String(userId), String(firmId), role],
  );
}

/**
 * Seed a **shared** reference row only when it is not already there.
 *
 * `server-int` runs four forks against one database and every test rolls back, so a row one test
 * inserts is invisible to its siblings and each of them inserts it again. For a fixed reference row
 * — the GICS scheme, an `exchanges` entry, a venue calendar — that means four transactions holding
 * speculative-insert locks on the same primary key at once, in whatever order each file seeds them,
 * and Postgres reports `40P01 deadlock detected` on whichever pair inverts. `ON CONFLICT DO
 * NOTHING` does not help: the second transaction still waits on the first's uncommitted row.
 *
 * `test/globalSetup.ts` commits those rows once, so in a normal run `probe` finds them and nothing
 * is written. The seed stays in each test because a test must remain runnable on its own against a
 * database that has not been through globalSetup — and a test that silently depends on a fixture it
 * does not create is a test that lies about its own inputs.
 */
export async function ensureShared(
  t: TestDb,
  probe: string,
  seed: string,
  params: readonly unknown[] = [],
): Promise<void> {
  const present = await t.client.query(probe);
  if (present.rowCount !== null && present.rowCount > 0) return;
  await t.client.query(seed, params as unknown[]);
}

/**
 * Additionally switch the session to `terminal_app` so the RLS policies of migration 0015 apply to
 * the test (the owner role is a superuser locally and bypasses RLS — DATA_MODEL §15.1 L2438).
 * Transaction-scoped; reverted by the rollback.
 */
export async function asAppRole(t: TestDb): Promise<void> {
  await t.client.query('SET LOCAL ROLE terminal_app');
}
