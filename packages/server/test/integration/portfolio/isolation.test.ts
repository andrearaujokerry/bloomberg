/**
 * `test/integration/portfolio/isolation.test.ts` — PORT-07 (WORKPLAN WP-10 acceptance row:
 * "another firm's user gets 404, not 403-with-data").
 *
 * **Every assertion here runs under `SET LOCAL ROLE terminal_app` (`asAppRole`).** The migration
 * owner is a superuser on the local database and bypasses row-level security entirely
 * (DATA_MODEL §15.1 L2438), so an isolation test that ran as the owner would pass whether or not
 * migration 0015's policies existed — it would prove that `data/portfolio.ts` filters on `firm_id`
 * and nothing about the wall behind it. Running as the application role is what makes this a test
 * of the isolation rather than of one module's `WHERE` clause.
 *
 * Three properties, in the order a breach would matter:
 *
 *  1. **Every route answers `404`, on the same body, for another firm's portfolio and for one that
 *     does not exist.** Not `403`: a `403` confirms the id is real, which is the oracle PORT-07
 *     exists to close. The bodies are compared to each other, not merely to a status code.
 *  2. **A refused write writes nothing.** The `PUT` and the multipart `POST` are checked against
 *     `count(*)` on the victim's `positions` and `portfolio_imports`, because a route that answers
 *     `404` after inserting is worse than one that answers `403`.
 *  3. **The legitimate path still works as `terminal_app`.** The same import that the other firm
 *     is refused succeeds for the owner under the same role, so the policies are proved to be
 *     tenant-scoped rather than simply closed. A test that only showed refusals would pass against
 *     a `REVOKE ALL`.
 *
 * The last case is not an assertion about this route file: it records that migration 0015 grants
 * `terminal_app` no `DELETE` on `portfolios`, so `DELETE /portfolios/:portfolioId` — which API.md
 * L688 documents as `204` — cannot succeed as the application role in production. It will fail
 * when somebody fixes the grant, which is exactly when it should be read again. (The same note
 * stands over `workspaces`, in `test/integration/workspaces/workspaces.test.ts`.)
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ImportReport } from '@terminal/sdk/wire/rest/portfolios';

import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { asAppRole, withTxDb, type TestDb } from '../../../src/test/db.js';
import { call, countOf, newActor, newEquity, newFirm, upload, type Actor } from './helpers.js';

const t: TestDb = withTxDb();
const clock = testClock();

let harness: TestApp;
let app: FastifyInstance;

/** Demo Capital: owns the portfolio. */
let owner: Actor;
/** Demo Capital, same firm, not the owner. */
let colleague: Actor;
/** Other Desk: a different tenant entirely. */
let outsider: Actor;

let portfolioId: number;
let key: string;

const AS_OF = '2026-09-15';
const HEADER = 'identifier,quantity,cost_price,cost_currency,lot_id,trade_date';

/** An id that cannot exist, for the "indistinguishable from absent" comparison. */
const ABSENT_ID = 999_999_999;

/** The one part of an error body that legitimately differs between two requests. */
function withoutTraceId(payload: string): string {
  return payload.replace(/"traceId":"[^"]*"/, '"traceId":"<trace>"');
}

const positionCount = (): Promise<number> =>
  countOf(t, 'positions', 'portfolio_id = $1', [portfolioId]);
const importCount = (): Promise<number> =>
  countOf(t, 'portfolio_imports', 'portfolio_id = $1', [portfolioId]);

beforeEach(async () => {
  harness = await createTestApp({ db: t.db, clock });
  app = harness.app;

  const demoCapital = await newFirm(t, 'Demo Capital');
  const otherDesk = await newFirm(t, 'Other Desk');
  owner = await newActor(t, demoCapital, 'PM');
  colleague = await newActor(t, demoCapital, 'Analyst');
  outsider = await newActor(t, otherDesk, 'Rival PM');
  key = (await newEquity(t)).key;

  const created = await call(app, owner, 'POST', '/portfolios', {
    name: `Demo Long ${randomUUID().slice(0, 8)}`,
    baseCurrency: 'USD',
  });
  expect(created.statusCode, created.payload).toBe(201);
  portfolioId = created.json<{ portfolioId: number }>().portfolioId;

  const seeded = await upload(
    app,
    owner,
    portfolioId,
    `${HEADER}\n${key},1200,187.42,USD,default,2024-03-11\n`,
    AS_OF,
  );
  expect(seeded.statusCode, seeded.payload).toBe(200);
  expect(ImportReport.parse(seeded.json()).status).toBe('accepted');
});

afterEach(async () => {
  await harness.close();
});

describe('PORT-07 — another firm sees nothing, and cannot tell that there is nothing to see', () => {
  it('answers 404 on every read, with the same body an absent id gets', async () => {
    await asAppRole(t);

    const reads: string[] = [
      `/portfolios/${String(portfolioId)}`,
      `/portfolios/${String(portfolioId)}/positions`,
      `/portfolios/${String(portfolioId)}/imports`,
      `/portfolios/${String(portfolioId)}/lots`,
    ];
    for (const url of reads) {
      const theirs = await call(app, outsider, 'GET', url);
      const absent = await call(
        app,
        outsider,
        'GET',
        url.replace(String(portfolioId), String(ABSENT_ID)),
      );

      expect(theirs.statusCode, `${url}: ${theirs.payload}`).toBe(404);
      expect(theirs.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
      // Identical, once the per-request `traceId` is taken out, to the answer for an id that was
      // never allocated: nothing in the response distinguishes "belongs to Demo Capital" from
      // "does not exist".
      expect(withoutTraceId(theirs.payload)).toBe(withoutTraceId(absent.payload));
      // And nothing of the portfolio leaked into it.
      expect(theirs.payload).not.toContain(key);
      expect(theirs.payload).not.toContain('1200');
    }
  });

  it('never lists another firm’s portfolio', async () => {
    await asAppRole(t);
    const listed = await call(app, outsider, 'GET', '/portfolios');
    expect(listed.statusCode, listed.payload).toBe(200);
    expect(listed.json<{ items: { portfolioId: number }[] }>().items).toEqual([]);
  });

  it('refuses a write with 404 and writes nothing', async () => {
    await asAppRole(t);
    const before = { positions: await positionCount(), imports: await importCount() };

    const put = await call(app, outsider, 'PUT', `/portfolios/${String(portfolioId)}/positions`, {
      asOfDate: AS_OF,
      positions: [{ identifier: key, quantity: 999_999 }],
    });
    expect(put.statusCode, put.payload).toBe(404);

    const imported = await upload(
      app,
      outsider,
      portfolioId,
      `${HEADER}\n${key},999999,1.00,USD,default,2024-03-11\n`,
      AS_OF,
    );
    expect(imported.statusCode, imported.payload).toBe(404);

    const renamed = await call(app, outsider, 'PUT', `/portfolios/${String(portfolioId)}`, {
      name: 'Taken Over',
      baseCurrency: 'USD',
    });
    expect(renamed.statusCode, renamed.payload).toBe(404);

    expect({ positions: await positionCount(), imports: await importCount() }).toEqual(before);
    const quantity = await t.client.query<{ quantity: string }>(
      `SELECT quantity::text AS quantity FROM positions WHERE portfolio_id = $1`,
      [portfolioId],
    );
    expect(Number(quantity.rows[0]!.quantity)).toBe(1200);
  });

  it('refuses the analytics route before it reaches the PORT resolver', async () => {
    await asAppRole(t);
    const res = await call(
      app,
      outsider,
      'POST',
      `/portfolios/${String(portfolioId)}/analytics`,
      {},
    );
    expect(res.statusCode, res.payload).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });
});

describe('PORT-07 — the exception queue is not a side channel', () => {
  /**
   * An unresolved identifier files a `data_exceptions` row carrying the raw identifier out of the
   * uploaded file, the portfolio id, the as-of date and the uploader's user id. Before migration
   * 0019 that table had no `firm_id`, no RLS and no firm predicate on `GET /admin/exceptions`, and
   * `admin` is an ordinary *customer* firm admin — so an admin of an unrelated firm read the
   * victim's identifier, portfolio id and as-of date out of a 200. That is the whole oracle the
   * 404-not-403 rule above exists to deny, reached through a different door.
   */
  const BAD_ID = 'NOTAREALTICKERBCE984 XX Equity';

  async function fileException(): Promise<void> {
    const res = await upload(
      app,
      owner,
      portfolioId,
      `${HEADER}\n${key},1200,187.42,USD,default,2024-03-11\n${BAD_ID},50,10,USD,lot2,2024-03-11\n`,
      AS_OF,
    );
    expect(res.statusCode, res.payload).toBe(200);
    expect(ImportReport.parse(res.json()).status).toBe('partial');
  }

  it("keeps another firm's admin out of the queue the import wrote", async () => {
    await fileException();
    const rival = await newActor(t, outsider.firmId, 'Rival Admin', 'admin');

    await asAppRole(t);
    const theirs = await call(app, rival, 'GET', '/admin/exceptions?status=open');
    expect(theirs.statusCode, theirs.payload).toBe(200);
    // Nothing of the victim's file, book or uploader is in the body — not the identifier, not the
    // portfolio id, not the as-of date, not who uploaded it.
    expect(theirs.payload).not.toContain(BAD_ID);
    expect(theirs.payload).not.toContain(`"portfolioId":${String(portfolioId)}`);
    expect(theirs.payload).not.toContain(`"asOfDate":"${AS_OF}"`);
    const items = theirs.json<{ items: { reportedBy: number | null }[] }>().items;
    expect(items.some((i) => i.reportedBy === owner.userId)).toBe(false);
  });

  it("shows the uploading firm's own admin the exception, so the queue still works", async () => {
    await fileException();
    const ours = await newActor(t, owner.firmId, 'Demo Admin', 'admin');

    await asAppRole(t);
    const mine = await call(app, ours, 'GET', '/admin/exceptions?status=open');
    expect(mine.statusCode, mine.payload).toBe(200);
    const items = mine.json<{ items: { kind: string; candidates: unknown }[] }>().items;
    const found = items.find((i) => i.kind === 'unresolved_identifier');
    expect(found, mine.payload).toBeDefined();
    expect(JSON.stringify(found!.candidates)).toContain(BAD_ID);
  });

  it('writes the owning firm onto the row, and leaves reference-data exceptions firm-less', async () => {
    await fileException();
    const raised = await t.client.query<{ firm_id: string | null }>(
      `SELECT firm_id::text AS firm_id FROM data_exceptions
        WHERE kind = 'unresolved_identifier' AND candidates @> $1::jsonb`,
      [JSON.stringify([{ value: BAD_ID }])],
    );
    expect(raised.rowCount).toBe(1);
    expect(Number(raised.rows[0]!.firm_id)).toBe(owner.firmId);

    // The policy migration 0019 installs, read back: a firm's rows and the firm-less reference
    // rows, nothing else. (This transaction is the owner role, which FORCE also binds.)
    const policy = await t.client.query<{ qual: string }>(
      `SELECT qual FROM pg_policies WHERE tablename = 'data_exceptions'`,
    );
    expect(policy.rowCount).toBe(1);
    expect(policy.rows[0]!.qual.replace(/\s+/g, ' ')).toContain('app_firm_id()');
  });
});

describe('PORT-07 — inside the firm', () => {
  it('lets the owner import as terminal_app, so the policies are tenant-scoped and not merely shut', async () => {
    await asAppRole(t);
    const res = await upload(
      app,
      owner,
      portfolioId,
      `${HEADER}\n${key},1500,187.42,USD,default,2024-03-11\n`,
      AS_OF,
    );
    expect(res.statusCode, res.payload).toBe(200);
    const report = ImportReport.parse(res.json());
    expect(report.status).toBe('accepted');
    expect(report.reconciliation.quantityDiffs[0]!.after).toBe(1500);
    expect(await positionCount()).toBe(1);
  });

  it('shows a colleague the positions but refuses them the portfolio itself', async () => {
    await asAppRole(t);

    // `GET /portfolios/:id/positions` is firm-scoped (API.md §5.9 "firm").
    const positions = await call(
      app,
      colleague,
      'GET',
      `/portfolios/${String(portfolioId)}/positions`,
    );
    expect(positions.statusCode, positions.payload).toBe(200);
    expect(positions.json<{ positions: unknown[] }>().positions).toHaveLength(1);

    // `GET/PUT /portfolios/:id` is owner-or-firm-admin, and a non-owner is told 404 rather than
    // 403 for the same reason another firm is.
    const detail = await call(app, colleague, 'GET', `/portfolios/${String(portfolioId)}`);
    expect(detail.statusCode, detail.payload).toBe(404);
    const write = await call(app, colleague, 'PUT', `/portfolios/${String(portfolioId)}`, {
      name: 'Mine now',
    });
    expect(write.statusCode, write.payload).toBe(404);
  });

  it('records that terminal_app holds no DELETE grant on portfolios (migration 0015)', async () => {
    const granted = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM information_schema.role_table_grants
        WHERE grantee = 'terminal_app' AND table_name = 'portfolios' AND privilege_type = 'DELETE'`,
    );
    // API.md L688 documents `DELETE /portfolios/:portfolioId` as 204. It cannot succeed as the
    // application role until this grant exists; the owner role (this test transaction) can.
    expect(granted.rows[0]!.n).toBe('0');

    const deleted = await call(app, owner, 'DELETE', `/portfolios/${String(portfolioId)}`);
    expect(deleted.statusCode, deleted.payload).toBe(204);
    expect((await call(app, owner, 'GET', `/portfolios/${String(portfolioId)}`)).statusCode).toBe(
      404,
    );
  });
});
