/**
 * `test/integration/portfolio/concurrency.test.ts` — PORT-01's "replace, never append" under two
 * uploads at once.
 *
 * Every other portfolio suite runs inside one rolled-back transaction, which is exactly the
 * arrangement that cannot see this bug: two imports that share a transaction are serial by
 * construction. So this file commits, on two real connections, and interleaves them the way a desk
 * that double-clicks Upload does.
 *
 * What was measured before `importPositions` took its lock:
 *
 *   T1 BEGIN; … DELETE positions(portfolio, as-of); INSERT A
 *   T2 BEGIN; … DELETE positions(portfolio, as-of)   ← blocks on T1's row locks
 *   T1 COMMIT
 *   T2 unblocks, re-evaluates against a snapshot taken *before* T1 committed:
 *      "T2 DELETE removed rows = 0" — it deletes what T1 had already deleted and never sees
 *      what T1 inserted — then INSERT B and COMMIT.
 *   FINAL BOOK = A ∪ B: a portfolio neither upload asserted, valued by every analytic downstream,
 *   with a `portfolio_imports` row whose reconciliation was computed against a baseline that no
 *   longer existed.
 *
 * The fix is one statement — `SELECT 1 FROM portfolios … FOR UPDATE` before the baseline read — so
 * the assertion here is deliberately *equality*, not a superset: the last writer's book is the
 * book, and the report it hands back describes the replace it actually performed.
 *
 * The rows are cash lines so the test needs no instrument master, and everything it creates is
 * deleted in `afterEach`: it commits into the shared test database and must leave nothing behind
 * for the files running beside it.
 */

import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { nowAsOf } from '../../../src/db/bitemporal.js';
import type { Tx } from '../../../src/db/client.js';
import type { PortfolioScope } from '../../../src/data/portfolio.js';
import {
  importPositions,
  type ImportReport,
  type ImportRowInput,
} from '../../../src/portfolio/service.js';
import { testClock } from '../../../src/test/clock.js';
import { testDatabaseUrl, withCleanDb, type TestDb } from '../../../src/test/db.js';

const { Pool } = pg;

/** Nothing is truncated — this harness is here only for a connection whose writes commit. */
const t: TestDb = withCleanDb([]);
const clock = testClock();

const AS_OF = '2026-09-15';

let pool: pg.Pool;
let firmId: number;
let userId: number;
let portfolioId: number;
let scope: PortfolioScope;

function cashRow(identifier: string, quantity: number, lotId: string): ImportRowInput {
  return {
    row: 1,
    identifier,
    quantity,
    costPrice: null,
    costCurrency: null,
    lotId,
    tradeDate: null,
    settleDate: null,
    isCash: true,
    cashCurrency: identifier,
  };
}

/** One import on its own connection, left uncommitted so the test can interleave the two. */
async function beginImport(
  client: pg.PoolClient,
  rows: readonly ImportRowInput[],
): Promise<ImportReport> {
  await client.query('BEGIN');
  const tx = drizzle(client) as unknown as Tx;
  return importPositions(tx, nowAsOf(clock), scope, clock, {
    portfolioId,
    asOfDate: AS_OF,
    channel: 'api',
    filename: null,
    rows,
    rowsTotal: rows.length,
    payload: JSON.stringify(rows),
  });
}

async function book(): Promise<{ identifier: string; quantity: number }[]> {
  const res = await t.client.query<{ raw_identifier: string; quantity: string }>(
    `SELECT raw_identifier, quantity::text AS quantity
       FROM positions WHERE portfolio_id = $1 AND as_of_date = $2::date
      ORDER BY raw_identifier`,
    [portfolioId, AS_OF],
  );
  return res.rows.map((r) => ({ identifier: r.raw_identifier, quantity: Number(r.quantity) }));
}

beforeAll(() => {
  pool = new Pool({ connectionString: testDatabaseUrl(), max: 4 });
  pool.on('error', () => undefined);
});

beforeEach(async () => {
  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Race Desk ${randomUUID().slice(0, 8)}`],
  );
  firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'Race PM', 'user') RETURNING user_id`,
    [firmId, `race-${randomUUID()}@demo.invalid`],
  );
  userId = Number(user.rows[0]!.user_id);
  const pf = await t.client.query<{ portfolio_id: string }>(
    `INSERT INTO portfolios (firm_id, owner_user_id, name, base_currency)
     VALUES ($1, $2, $3, 'USD') RETURNING portfolio_id`,
    [firmId, userId, `Race Book ${randomUUID().slice(0, 8)}`],
  );
  portfolioId = Number(pf.rows[0]!.portfolio_id);
  scope = { firmId, userId };
});

afterEach(async () => {
  // This file commits, so it cleans up after itself: nothing it created may outlive it.
  await t.client.query(`DELETE FROM lots WHERE portfolio_id = $1`, [portfolioId]);
  await t.client.query(`DELETE FROM positions WHERE portfolio_id = $1`, [portfolioId]);
  await t.client.query(`DELETE FROM portfolio_imports WHERE portfolio_id = $1`, [portfolioId]);
  await t.client.query(`DELETE FROM portfolios WHERE portfolio_id = $1`, [portfolioId]);
  await t.client.query(`DELETE FROM data_exceptions WHERE firm_id = $1`, [firmId]);
  // The `provenance` rows each import wrote stay: migration 0015 makes the table append-only
  // (WORM), and a test that could delete provenance would be a test that could delete an audit
  // trail. They carry no firm and name nothing but this file's own portfolio id.
  await t.client.query(`DELETE FROM users WHERE user_id = $1`, [userId]);
  await t.client.query(`DELETE FROM firms WHERE firm_id = $1`, [firmId]);
});

afterAll(async () => {
  await pool.end();
});

describe('two concurrent imports of the same (portfolio, as-of)', () => {
  it('serialises: the second upload replaces the first, and never unions with it', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      // T1 does its whole replace and is left uncommitted, holding the portfolio's lock.
      const first = await beginImport(a, [cashRow('USD', 1111, 'a')]);
      expect(first.status).toBe('accepted');

      // T2 starts while T1 is still open. It must block on the portfolio row, so the promise
      // cannot settle before T1 commits — which is the whole property under test.
      let settled = false;
      const second = beginImport(b, [cashRow('EUR', 2222, 'b')]).then((r) => {
        settled = true;
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(settled, 'the second import ran without waiting for the first').toBe(false);

      await a.query('COMMIT');
      const report = await second;
      await b.query('COMMIT');

      // The book is the second upload's, exactly — not the union of the two.
      expect(await book()).toEqual([{ identifier: 'EUR', quantity: 2222 }]);

      // And the report is truthful: it reconciled against the book T1 really left behind.
      expect(report.status).toBe('accepted');
      expect(report.reconciliation.added).toBe(1);
      expect(report.reconciliation.removed).toBe(1);
      expect(report.reconciliation.matched).toBe(0);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  }, 30_000);

  it('answers a doubled upload of the identical file with one book, not a unique violation', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      const rows = [cashRow('USD', 1111, 'a')];
      await beginImport(a, rows);
      let settled = false;
      const second = beginImport(b, rows).then((r) => {
        settled = true;
        return r;
      });
      // The wait matters: T2 has to be inside the replace, blocked, before T1 commits. Without it
      // T2's first statement takes its snapshot after the commit and the race never happens.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(settled, 'the second import ran without waiting for the first').toBe(false);
      await a.query('COMMIT');
      // Before the lock this raised 23505 on
      // `positions_portfolio_id_as_of_date_raw_identifier_lot_id_key`, which no handler caught and
      // the caller saw as `500 INTERNAL`.
      const report = await second;
      await b.query('COMMIT');

      expect(report.status).toBe('accepted');
      expect(report.reconciliation.matched).toBe(1);
      expect(report.reconciliation.added).toBe(0);
      expect(report.reconciliation.removed).toBe(0);
      expect(await book()).toEqual([{ identifier: 'USD', quantity: 1111 }]);

      // Both attempts are in the history; only the positions were replaced.
      const imports = await t.client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM portfolio_imports WHERE portfolio_id = $1`,
        [portfolioId],
      );
      expect(Number(imports.rows[0]!.n)).toBe(2);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  }, 30_000);
});
