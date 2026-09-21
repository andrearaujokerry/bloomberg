/**
 * `data/portfolio.ts` — tenant isolation (PORT-07, WORKPLAN §WP-04 L706-709, API.md §5.9).
 *
 * The claim under test: **a portfolio read cannot see another firm's rows.** Two firms are built
 * side by side, each with its own user, portfolio, positions, lots and import, and every read of
 * the service scoped to firm A is required to be blind to firm B — not "filtered later", not
 * "404 at the route", but empty or refused at the reader itself.
 *
 * The fourth case is the one that matters most and the one a `JOIN`-only guard fails: a `positions`
 * row **mis-parented** — pointing at firm A's portfolio while carrying firm B's `firm_id`. That is
 * exactly the shape a bug in an importer would produce, and the denormalised `firm_id` filter in
 * `readPositions` is what makes it invisible to both firms rather than to neither.
 *
 * This runs as the database owner, which bypasses RLS (DATA_MODEL §15.1 L2438) — deliberately, so
 * that what passes is this module's own scoping and not migration 0015's policies. The policies are
 * the outer wall and have their own test; this is the inner one.
 *
 * Self-sufficient (TESTING §4.3): no seed is assumed. The fixture creates both firms, both users
 * and every row inside the test's own transaction, which is rolled back afterwards.
 */

import { describe, expect, it } from 'vitest';

import {
  PortfolioAccessError,
  portfolioService,
  readPositions,
} from '../../../src/data/portfolio.js';
import { withTxDb } from '../../../src/test/db.js';

import type { PortfolioScope } from '../../../src/data/portfolio.js';
import type { TestDb } from '../../../src/test/db.js';

const AT = { validAt: new Date('2026-09-15T12:00:00Z'), knownAt: new Date('2026-09-15T12:00:00Z') };
const AS_OF = '2026-09-15';

interface Tenant {
  firmId: number;
  userId: number;
  portfolioId: number;
  importId: number;
  provenanceId: number;
}

interface Fixture {
  a: Tenant;
  b: Tenant;
}

async function licence(t: TestDb): Promise<void> {
  await t.client.query(
    `INSERT INTO licence_registry (source_id, source_name, publisher, licence_kind, attribution,
                                   rate_limit, valid_from)
     SELECT 'internal.user', 'User upload', 'Terminal', 'internal', 'User upload', 'n/a',
            timestamptz '2000-01-01'
      WHERE NOT EXISTS (SELECT 1 FROM licence_registry
                         WHERE source_id = 'internal.user' AND tx_to = 'infinity')`,
  );
}

async function tenant(t: TestDb, label: string): Promise<Tenant> {
  const suffix = String(Math.random()).slice(2, 12);
  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`${label} Capital ${suffix}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);

  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name) VALUES ($1, $2, $3) RETURNING user_id`,
    [firmId, `pm-${suffix}@${label.toLowerCase()}.test`, `${label} PM`],
  );
  const userId = Number(user.rows[0]!.user_id);

  const portfolio = await t.client.query<{ portfolio_id: string }>(
    `INSERT INTO portfolios (firm_id, owner_user_id, name, base_currency)
     VALUES ($1, $2, $3, 'USD') RETURNING portfolio_id`,
    [firmId, userId, `${label} Core`],
  );
  const portfolioId = Number(portfolio.rows[0]!.portfolio_id);

  const provenance = await t.client.query<{ provenance_id: string }>(
    `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                             http_status, bytes, captured_at, adapter_version)
     VALUES ('internal.user', $1, 'test://upload/' || $1, digest($1, 'sha256'),
             digest($1, 'sha256'), 200, 0, $2, 'test/1.0.0')
     RETURNING provenance_id`,
    [`upload-${suffix}`, AT.knownAt.toISOString()],
  );
  const provenanceId = Number(provenance.rows[0]!.provenance_id);

  const imported = await t.client.query<{ import_id: string }>(
    `INSERT INTO portfolio_imports (portfolio_id, firm_id, uploaded_by, channel, filename,
                                    as_of_date, rows_total, rows_ok, rows_error, errors,
                                    reconciliation, status, provenance_id)
     VALUES ($1, $2, $3, 'upload', $4, $5::date, 2, 2, 0, '[]'::jsonb,
             '{"matched":2,"added":0,"removed":0,"quantityDiffs":[]}'::jsonb, 'accepted', $6)
     RETURNING import_id`,
    [portfolioId, firmId, userId, `${label}.csv`, AS_OF, provenanceId],
  );
  const importId = Number(imported.rows[0]!.import_id);

  for (const position of [
    { identifier: `${label}-AAPL US`, quantity: '1000', cost: '150.25' },
    { identifier: `${label}-USD`, quantity: '25000', cost: null },
  ]) {
    await t.client.query(
      `INSERT INTO positions (portfolio_id, firm_id, as_of_date, raw_identifier, is_cash, lot_id,
                              quantity, cost_price, cost_currency, import_id)
       VALUES ($1, $2, $3::date, $4, $5, 'default', $6, $7, 'USD', $8)`,
      [
        portfolioId,
        firmId,
        AS_OF,
        position.identifier,
        position.cost === null,
        position.quantity,
        position.cost,
        importId,
      ],
    );
  }

  const instrument = await t.client.query<{ id: string }>(
    `SELECT nextval('instrument_id_seq')::bigint AS id`,
  );
  await t.client.query(
    `INSERT INTO lots (portfolio_id, firm_id, instrument_id, open_date, quantity, unit_cost,
                       currency, external_ref)
     VALUES ($1, $2, $3, $4::date, 1000, 150.25, 'USD', $5)`,
    [portfolioId, firmId, Number(instrument.rows[0]!.id), AS_OF, `${label}-lot-1`],
  );

  return { firmId, userId, portfolioId, importId, provenanceId };
}

async function fixture(t: TestDb): Promise<Fixture> {
  await licence(t);
  return { a: await tenant(t, 'Alpha'), b: await tenant(t, 'Beta') };
}

function scopeOf(tenantRow: Tenant): PortfolioScope {
  return { firmId: tenantRow.firmId, userId: tenantRow.userId };
}

describe('data/portfolio — tenant isolation (PORT-07)', () => {
  const t = withTxDb();

  it("refuses every read of another firm's portfolio with the same not_found error", async () => {
    const { a, b } = await fixture(t);
    const alpha = portfolioService(t.db, AT, scopeOf(a));

    // Alpha's own portfolio reads fine — otherwise the refusals below prove nothing.
    const own = await alpha.get(a.portfolioId);
    expect(own.portfolioId).toBe(a.portfolioId);
    expect(own.firmId).toBe(a.firmId);

    for (const read of [
      (): Promise<unknown> => alpha.get(b.portfolioId),
      (): Promise<unknown> => alpha.positions(b.portfolioId),
      (): Promise<unknown> => alpha.positions(b.portfolioId, AS_OF),
      (): Promise<unknown> => alpha.lots(b.portfolioId),
      (): Promise<unknown> => alpha.imports(b.portfolioId),
      (): Promise<unknown> => alpha.recon(b.portfolioId),
    ]) {
      await expect(read()).rejects.toBeInstanceOf(PortfolioAccessError);
      await expect(read()).rejects.toMatchObject({ code: 'not_found' });
    }

    // A portfolio that simply does not exist fails identically: no existence oracle.
    const missing = 2_147_483_600;
    await expect(alpha.get(missing)).rejects.toMatchObject({ code: 'not_found' });
  });

  it("lists and reads only the caller firm's rows", async () => {
    const { a, b } = await fixture(t);
    const alpha = portfolioService(t.db, AT, scopeOf(a));
    const beta = portfolioService(t.db, AT, scopeOf(b));

    const alphaList = await alpha.list();
    expect(alphaList.map((p) => p.portfolioId)).toEqual([a.portfolioId]);
    expect(alphaList.every((p) => p.firmId === a.firmId)).toBe(true);

    const betaList = await beta.list();
    expect(betaList.map((p) => p.portfolioId)).toEqual([b.portfolioId]);

    const alphaPositions = await alpha.positions(a.portfolioId, AS_OF);
    expect(alphaPositions).toHaveLength(2);
    expect(alphaPositions.every((p) => p.portfolioId === a.portfolioId)).toBe(true);
    expect(alphaPositions.map((p) => p.identifier).sort()).toEqual(['Alpha-AAPL US', 'Alpha-USD']);
    // Provenance: a position cites the import it arrived on (source `internal.user`).
    expect(alphaPositions.every((p) => p.provenanceId === a.provenanceId)).toBe(true);
    expect(alphaPositions.every((p) => p.importId === a.importId)).toBe(true);

    const betaPositions = await beta.positions(b.portfolioId, AS_OF);
    expect(betaPositions.map((p) => p.identifier).sort()).toEqual(['Beta-AAPL US', 'Beta-USD']);

    const alphaLots = await alpha.lots(a.portfolioId);
    expect(alphaLots.map((l) => l.externalRef)).toEqual(['Alpha-lot-1']);

    const alphaRecon = await alpha.recon(a.portfolioId);
    expect(alphaRecon.importId).toBe(a.importId);
    expect(alphaRecon.status).toBe('accepted');
    expect(alphaRecon.reconciliation.matched).toBe(2);
    expect(alphaRecon.provenanceId).toBe(a.provenanceId);
  });

  it('hides a position mis-parented to another firm from both firms', async () => {
    const { a, b } = await fixture(t);

    // The bug this guards against: a row under Alpha's portfolio carrying Beta's firm_id. The
    // FK only constrains `portfolio_id`, so the database itself accepts this.
    await t.client.query(
      `INSERT INTO positions (portfolio_id, firm_id, as_of_date, raw_identifier, is_cash, lot_id,
                              quantity, cost_price, cost_currency)
       VALUES ($1, $2, $3::date, 'LEAK US', false, 'default', 999, 1, 'USD')`,
      [a.portfolioId, b.firmId, AS_OF],
    );
    const planted = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM positions WHERE raw_identifier = 'LEAK US'`,
    );
    expect(Number(planted.rows[0]!.n)).toBe(1);

    // Alpha owns the portfolio but not the row: the denormalised firm_id filter drops it.
    const alphaPositions = await readPositions(t.db, AT, scopeOf(a), a.portfolioId, AS_OF);
    expect(alphaPositions.map((p) => p.identifier)).not.toContain('LEAK US');
    expect(alphaPositions).toHaveLength(2);

    // Beta owns the row's firm_id but not the portfolio: the portfolio check refuses first.
    await expect(readPositions(t.db, AT, scopeOf(b), a.portfolioId, AS_OF)).rejects.toMatchObject({
      code: 'not_found',
    });

    // And Beta's own portfolio is unaffected.
    const betaPositions = await readPositions(t.db, AT, scopeOf(b), b.portfolioId, AS_OF);
    expect(betaPositions.map((p) => p.identifier)).not.toContain('LEAK US');
    expect(betaPositions).toHaveLength(2);
  });

  it('cannot be constructed without a firm', () => {
    expect(() => portfolioService(t.db, AT, { firmId: 0, userId: 1 })).toThrow(RangeError);
    expect(() => portfolioService(t.db, AT, { firmId: Number.NaN, userId: 1 })).toThrow(RangeError);
  });
});
