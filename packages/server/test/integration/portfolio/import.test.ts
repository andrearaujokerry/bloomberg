/**
 * `test/integration/portfolio/import.test.ts` — PORT-01 / PORT-02 (WORKPLAN WP-10 acceptance row:
 * "a CSV with a bad identifier yields `status='partial'`, an error row, and a `data_exceptions`
 * entry; re-upload is idempotent").
 *
 * What it proves, in the order the failures would cost:
 *
 *  1. **A bad row does not fail the file, and does not vanish.** An upload naming one identifier
 *     the master does not know comes back `200` with `status: 'partial'`, the failing row in
 *     `errors[]` with the column that failed, a position written with `recon_status 'unresolved'`
 *     and `instrument_id NULL`, and an open `data_exceptions` row of kind `unresolved_identifier`.
 *     The alternative — a `400` — throws away eleven good positions because of one typo.
 *  2. **Re-uploading is idempotent, measured in rows.** The assertion is on `count(*)` of
 *     `positions`, `lots` and `data_exceptions` before and after a second upload of the identical
 *     file, not on a boolean the implementation could return without doing anything. Only
 *     `portfolio_imports` grows, because an import history that forgets an attempt is not a
 *     history, and the second run's `reconciliation` is `matched = n, added = 0, removed = 0`.
 *  3. **Reconciliation is the report, not a side effect.** A later upload that moves one quantity
 *     and drops one name reports exactly that: the `quantityDiffs` entry with `before`/`after`,
 *     one `removed`, the rest `matched`.
 *
 * The harness builds its own firm, user, session and instruments inside the test transaction and
 * depends on no seeded instrument id (there is no seed yet — WP-15 owns it).
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ImportReport } from '@terminal/sdk/wire/rest/portfolios';

import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { call, countOf, newActor, newEquity, newFirm, upload, type Actor } from './helpers.js';

const t: TestDb = withTxDb();
const clock = testClock();

let harness: TestApp;
let app: FastifyInstance;
let pm: Actor;
let portfolioId: number;
/** `'PA1B2 US Equity'`-shaped keys of three instruments seeded for this test. */
let keys: string[];

const AS_OF = '2026-09-15';
const HEADER = 'identifier,quantity,cost_price,cost_currency,lot_id,trade_date';

function csvOf(rows: readonly string[]): string {
  return `${HEADER}\n${rows.join('\n')}\n`;
}

const positionCount = (): Promise<number> =>
  countOf(t, 'positions', 'portfolio_id = $1', [portfolioId]);
const lotCount = (): Promise<number> => countOf(t, 'lots', 'portfolio_id = $1', [portfolioId]);
const importCount = (): Promise<number> =>
  countOf(t, 'portfolio_imports', 'portfolio_id = $1', [portfolioId]);
const exceptionCount = (): Promise<number> =>
  countOf(t, 'data_exceptions', `kind = 'unresolved_identifier' AND reported_by = $1`, [pm.userId]);

beforeEach(async () => {
  harness = await createTestApp({ db: t.db, clock });
  app = harness.app;

  const firmId = await newFirm(t, 'Import Desk');
  pm = await newActor(t, firmId, 'PM');
  keys = [(await newEquity(t)).key, (await newEquity(t)).key, (await newEquity(t)).key];

  const created = await call(app, pm, 'POST', '/portfolios', {
    name: `Demo Long ${randomUUID().slice(0, 8)}`,
    baseCurrency: 'USD',
  });
  expect(created.statusCode, created.payload).toBe(201);
  portfolioId = created.json<{ portfolioId: number }>().portfolioId;
});

afterEach(async () => {
  await harness.close();
});

describe('POST /portfolios/:id/import — a clean file (PORT-01, PORT-02)', () => {
  it('accepts every row, writes positions and lots, and reports them all as added', async () => {
    const csv = csvOf([
      `${keys[0]},1200,187.42,USD,default,2024-03-11`,
      `${keys[1]},-400,91.05,USD,default,2025-01-06`,
      `${keys[2]},650,44.10,USD,lot-b,2025-06-02`,
    ]);

    const res = await upload(app, pm, portfolioId, csv, AS_OF);
    expect(res.statusCode, res.payload).toBe(200);
    const report = ImportReport.parse(res.json());

    expect(report.status).toBe('accepted');
    expect(report.channel).toBe('upload');
    expect(report.asOfDate).toBe(AS_OF);
    expect(report.rowsTotal).toBe(3);
    expect(report.rowsOk).toBe(3);
    expect(report.rowsError).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.reconciliation).toEqual({ matched: 0, added: 3, removed: 0, quantityDiffs: [] });

    expect(await positionCount()).toBe(3);
    // Every row carried a cost price, so every resolved row opened a lot (PORT-02).
    expect(await lotCount()).toBe(3);
    expect(await importCount()).toBe(1);

    const positions = await call(
      app,
      pm,
      'GET',
      `/portfolios/${String(portfolioId)}/positions?asOfDate=${AS_OF}`,
    );
    expect(positions.statusCode, positions.payload).toBe(200);
    const body = positions.json<{
      asOfDate: string;
      positions: { reconStatus: string; instrument: unknown }[];
    }>();
    expect(body.asOfDate).toBe(AS_OF);
    expect(body.positions).toHaveLength(3);
    expect(body.positions.every((p) => p.reconStatus === 'ok')).toBe(true);
    expect(body.positions.every((p) => p.instrument !== null)).toBe(true);
  });

  it('cites the import provenance on every position it wrote', async () => {
    await upload(app, pm, portfolioId, csvOf([`${keys[0]},100,10,USD,default,2025-01-02`]), AS_OF);
    const res = await t.client.query<{ source_id: string; n: string }>(
      `SELECT pr.source_id, count(*)::text AS n
         FROM positions ps
         JOIN portfolio_imports im ON im.import_id = ps.import_id
         JOIN provenance pr ON pr.provenance_id = im.provenance_id
        WHERE ps.portfolio_id = $1
        GROUP BY pr.source_id`,
      [portfolioId],
    );
    expect(res.rows).toEqual([{ source_id: 'internal.user', n: '1' }]);
  });
});

describe('POST /portfolios/:id/import — a bad identifier (PORT-01)', () => {
  it('is partial: an error row, an unresolved position and an open data_exceptions entry', async () => {
    const csv = csvOf([
      `${keys[0]},1200,187.42,USD,default,2024-03-11`,
      `NOSUCHTICKER US Equity,500,12.00,USD,default,2025-02-03`,
      `${keys[1]},300,55.25,USD,default,2025-04-09`,
    ]);

    const res = await upload(app, pm, portfolioId, csv, AS_OF);
    expect(res.statusCode, res.payload).toBe(200);
    const report = ImportReport.parse(res.json());

    expect(report.status).toBe('partial');
    expect(report.rowsTotal).toBe(3);
    expect(report.rowsOk).toBe(2);
    expect(report.rowsError).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]!.row).toBe(2);
    expect(report.errors[0]!.identifier).toBe('NOSUCHTICKER US Equity');
    expect(report.errors[0]!.column).toBe('identifier');
    expect(report.errors[0]!.reason).toMatch(/SECURITY_NOT_FOUND|NOT_IN_UNIVERSE|BAD_IDENTIFIER/);

    // The row is still on the book, flagged — not dropped, and not guessed at.
    const unresolved = await t.client.query<{
      raw_identifier: string;
      instrument_id: string | null;
      recon_status: string;
    }>(
      `SELECT raw_identifier, instrument_id::text AS instrument_id, recon_status
         FROM positions WHERE portfolio_id = $1 AND recon_status <> 'ok'`,
      [portfolioId],
    );
    expect(unresolved.rows).toEqual([
      { raw_identifier: 'NOSUCHTICKER US Equity', instrument_id: null, recon_status: 'unresolved' },
    ]);
    expect(await positionCount()).toBe(3);
    // No instrument, no cost basis to book: two lots, not three.
    expect(await lotCount()).toBe(2);

    const exceptions = await t.client.query<{ kind: string; status: string; field: string }>(
      `SELECT kind, status, field FROM data_exceptions WHERE reported_by = $1`,
      [pm.userId],
    );
    expect(exceptions.rows).toEqual([
      { kind: 'unresolved_identifier', status: 'open', field: 'positions.raw_identifier' },
    ]);
  });

  it('rejects the whole file only when nothing in it can be read', async () => {
    const res = await upload(app, pm, portfolioId, 'ticker;size\nAAPL;100\n', AS_OF);
    expect(res.statusCode, res.payload).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');
    expect(await positionCount()).toBe(0);
    expect(await importCount()).toBe(0);
  });

  it('reports a file whose every row failed as rejected, not accepted', async () => {
    const res = await upload(
      app,
      pm,
      portfolioId,
      csvOf(['NOSUCH1 US Equity,10,1,USD,default,2025-01-02', ',20,1,USD,default,2025-01-02']),
      AS_OF,
    );
    expect(res.statusCode, res.payload).toBe(200);
    const report = ImportReport.parse(res.json());
    expect(report.status).toBe('rejected');
    expect(report.rowsOk).toBe(0);
    expect(report.rowsError).toBe(2);
  });
});

describe('POST /portfolios/:id/import — re-upload (PORT-01 idempotency)', () => {
  it('leaves every row count where it was and reports the second run as fully matched', async () => {
    const csv = csvOf([
      `${keys[0]},1200,187.42,USD,default,2024-03-11`,
      `NOSUCHTICKER US Equity,500,12.00,USD,default,2025-02-03`,
      `${keys[1]},300,55.25,USD,default,2025-04-09`,
    ]);

    const first = ImportReport.parse((await upload(app, pm, portfolioId, csv, AS_OF)).json());
    expect(first.status).toBe('partial');
    expect({
      positions: await positionCount(),
      lots: await lotCount(),
      exceptions: await exceptionCount(),
      imports: await importCount(),
    }).toEqual({ positions: 3, lots: 2, exceptions: 1, imports: 1 });

    const second = ImportReport.parse((await upload(app, pm, portfolioId, csv, AS_OF)).json());

    expect({
      positions: await positionCount(),
      lots: await lotCount(),
      exceptions: await exceptionCount(),
    }).toEqual({ positions: 3, lots: 2, exceptions: 1 });
    // The attempt itself is recorded — an import history that forgets a run is not a history.
    expect(await importCount()).toBe(2);
    expect(second.importId).not.toBe(first.importId);

    expect(second.status).toBe('partial');
    expect(second.rowsOk).toBe(2);
    expect(second.rowsError).toBe(1);
    expect(second.reconciliation).toEqual({
      matched: 3,
      added: 0,
      removed: 0,
      quantityDiffs: [],
    });

    // Both attempts are readable back, newest first, and `limit` is honoured off a query string.
    const history = await call(app, pm, 'GET', `/portfolios/${String(portfolioId)}/imports`);
    expect(history.statusCode, history.payload).toBe(200);
    expect(history.json<{ items: { importId: number }[] }>().items.map((i) => i.importId)).toEqual([
      second.importId,
      first.importId,
    ]);
    const capped = await call(app, pm, 'GET', `/portfolios/${String(portfolioId)}/imports?limit=1`);
    expect(capped.statusCode, capped.payload).toBe(200);
    expect(capped.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('reports a moved quantity and a dropped name against the same as-of date', async () => {
    await upload(
      app,
      pm,
      portfolioId,
      csvOf([
        `${keys[0]},1200,187.42,USD,default,2024-03-11`,
        `${keys[1]},300,55.25,USD,default,2025-04-09`,
      ]),
      AS_OF,
    );

    const second = ImportReport.parse(
      (
        await upload(
          app,
          pm,
          portfolioId,
          csvOf([`${keys[0]},1500,187.42,USD,default,2024-03-11`]),
          AS_OF,
        )
      ).json(),
    );

    expect(second.reconciliation.matched).toBe(1);
    expect(second.reconciliation.added).toBe(0);
    expect(second.reconciliation.removed).toBe(1);
    expect(second.reconciliation.quantityDiffs).toHaveLength(1);
    expect(second.reconciliation.quantityDiffs[0]!.before).toBe(1200);
    expect(second.reconciliation.quantityDiffs[0]!.after).toBe(1500);
    expect(await positionCount()).toBe(1);
  });

  it('flags a repeated (identifier, lot) as a duplicate rather than summing it', async () => {
    const res = await upload(
      app,
      pm,
      portfolioId,
      csvOf([
        `${keys[0]},1200,187.42,USD,default,2024-03-11`,
        `${keys[0]},50,190.00,USD,default,2025-08-01`,
      ]),
      AS_OF,
    );
    const report = ImportReport.parse(res.json());
    expect(report.status).toBe('partial');
    expect(report.rowsError).toBe(1);
    expect(report.errors[0]!.column).toBe('lot_id');
    expect(report.errors[0]!.reason).toContain('DUPLICATE_LOT');

    const rows = await t.client.query<{ quantity: string; recon_status: string }>(
      `SELECT quantity::text AS quantity, recon_status FROM positions WHERE portfolio_id = $1`,
      [portfolioId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(Number(rows.rows[0]!.quantity)).toBe(1200);
    expect(rows.rows[0]!.recon_status).toBe('duplicate');
  });
});

describe('PUT /portfolios/:id/positions — the API channel (API.md §5.9)', () => {
  it('replaces the date wholesale and reports the same reconciliation shape', async () => {
    await upload(
      app,
      pm,
      portfolioId,
      csvOf([`${keys[0]},1200,187.42,USD,default,2024-03-11`]),
      AS_OF,
    );

    const res = await call(app, pm, 'PUT', `/portfolios/${String(portfolioId)}/positions`, {
      asOfDate: AS_OF,
      positions: [
        { identifier: keys[0], quantity: 900, costPrice: 187.42, costCurrency: 'USD' },
        { identifier: 'USD', quantity: 250_000, isCash: true, cashCurrency: 'USD' },
      ],
    });
    expect(res.statusCode, res.payload).toBe(200);
    const report = ImportReport.parse(res.json());
    expect(report.channel).toBe('api');
    expect(report.status).toBe('accepted');
    expect(report.reconciliation.matched).toBe(1);
    expect(report.reconciliation.added).toBe(1);
    expect(report.reconciliation.quantityDiffs[0]!.after).toBe(900);
    expect(await positionCount()).toBe(2);

    const lots = await call(app, pm, 'GET', `/portfolios/${String(portfolioId)}/lots?open=true`);
    expect(lots.statusCode, lots.payload).toBe(200);
    // The cash line carries no instrument and no cost basis, so it opens no lot.
    expect(lots.json<{ items: unknown[] }>().items).toHaveLength(1);
  });
});
