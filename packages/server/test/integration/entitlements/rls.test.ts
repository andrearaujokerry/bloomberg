/**
 * WORKPLAN WP-07 acceptance row — `test/integration/entitlements/rls.test.ts`: "PORT-07: a user of
 * `Other Desk` cannot read `Demo Capital` portfolios, positions, watchlists or rooms, even with a
 * direct query under the app role" (PORT-07, SEC-05, SEC-06).
 *
 * Nothing here goes through a repository, a service or a route. Every statement is raw SQL on the
 * test's own connection, because the claim is about migration 0015 §15.f and not about any code
 * that happens to add a `WHERE firm_id = …`: the outer wall, tested from the outside.
 *
 * Two things make the test real:
 *
 *  - `asAppRole(t)` switches the session to `terminal_app`, the role the server actually connects
 *    as. The local owner is a superuser (DATA_MODEL §15.1 L2438) and bypasses RLS entirely, so a
 *    test that forgot this line would pass while proving nothing.
 *  - The fixture is seeded *before* the switch, as the owner, which is the only way two firms'
 *    rows can exist side by side in one transaction — under the policies, no single session can
 *    write both.
 *
 * What a policy does when it refuses a read is return **zero rows**, not an error: a tenant learns
 * nothing about the existence of another tenant's data. What it does when it refuses a write is
 * raise `42501 new row violates row-level security policy`. Both shapes are asserted.
 *
 * Self-sufficient (TESTING §4.3): both firms, their users, portfolios, positions, lots,
 * workspaces, watchlists, watchlist items, rooms, memberships and messages are created inside this
 * file's own `withTxDb()` transaction and roll back with it. Emails carry a random suffix so a
 * parallel file cannot collide on `users_email_uniq`.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it, beforeEach } from 'vitest';

import { asAppRole, asUser, withTxDb, type TestDb } from '../../../src/test/db.js';

const t: TestDb = withTxDb();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Tenant {
  firmId: number;
  /** Owner of everything below unless stated otherwise. */
  ownerId: number;
  /** A second colleague at the same firm — the audience for firm-scoped sharing. */
  peerId: number;
  /** A third colleague, in no share list — the audience for nothing. */
  strangerId: number;
  /** Same firm, `role = 'compliance'` — the MSG-02 supervisory reader. */
  complianceId: number;
  portfolioId: number;
  positionId: number;
  lotId: number;
  workspaceId: number;
  /** `shared_scope = 'private'`. */
  privateListId: number;
  /** `shared_scope = 'firm'`. */
  firmListId: number;
  /** `shared_scope = 'users'`, shared with `peerId` only. */
  usersListId: number;
  roomId: number;
  messageId: number;
}

interface World {
  demo: Tenant;
  other: Tenant;
  /** A `newsroom` user with a `users.firm_id` of Demo Capital but never a firm *context* (SEC-06). */
  newsroomUserId: number;
}

let world: World;

async function one<R extends Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<R> {
  const res = await t.client.query<R>(text, params as unknown[]);
  const row = res.rows[0];
  if (row === undefined) throw new Error(`expected one row from: ${text}`);
  return row;
}

async function count(text: string, params: readonly unknown[] = []): Promise<number> {
  const row = await one<{ n: string }>(text, params);
  return Number(row.n);
}

async function insertUser(
  firmId: number,
  name: string,
  role: 'user' | 'compliance' | 'newsroom',
): Promise<number> {
  const row = await one<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING user_id::text AS user_id`,
    [firmId, `${name}.${randomUUID()}@rls.test`, name, role],
  );
  return Number(row.user_id);
}

/** Everything one firm owns. Written as the owner, before the role switch. */
async function seedTenant(firmName: string, prefix: string): Promise<Tenant> {
  const firm = await one<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id::text AS firm_id`,
    [firmName],
  );
  const firmId = Number(firm.firm_id);

  const ownerId = await insertUser(firmId, `${prefix}-owner`, 'user');
  const peerId = await insertUser(firmId, `${prefix}-peer`, 'user');
  const strangerId = await insertUser(firmId, `${prefix}-stranger`, 'user');
  const complianceId = await insertUser(firmId, `${prefix}-compliance`, 'compliance');

  const portfolio = await one<{ portfolio_id: string }>(
    `INSERT INTO portfolios (firm_id, owner_user_id, name)
     VALUES ($1, $2, $3) RETURNING portfolio_id::text AS portfolio_id`,
    [firmId, ownerId, `${firmName} book`],
  );
  const portfolioId = Number(portfolio.portfolio_id);

  const position = await one<{ position_id: string }>(
    `INSERT INTO positions (portfolio_id, firm_id, as_of_date, raw_identifier, quantity)
     VALUES ($1, $2, DATE '2026-09-15', $3, 100) RETURNING position_id::text AS position_id`,
    [portfolioId, firmId, `${prefix.toUpperCase()} US`],
  );

  const lot = await one<{ lot_id: string }>(
    `INSERT INTO lots (portfolio_id, firm_id, instrument_id, open_date, quantity, unit_cost, currency)
     VALUES ($1, $2, 9001, DATE '2026-01-02', 100, 12.5, 'USD') RETURNING lot_id::text AS lot_id`,
    [portfolioId, firmId],
  );

  const workspace = await one<{ workspace_id: string }>(
    `INSERT INTO workspaces (user_id, firm_id, name, layout)
     VALUES ($1, $2, 'default', '{"panels":[]}'::jsonb) RETURNING workspace_id::text AS workspace_id`,
    [ownerId, firmId],
  );

  const lists: number[] = [];
  for (const [name, scope, shared] of [
    ['private', 'private', []],
    ['desk', 'firm', []],
    ['pair', 'users', [peerId]],
  ] as const) {
    const list = await one<{ watchlist_id: string }>(
      `INSERT INTO watchlists (owner_user_id, firm_id, name, columns, shared_scope, shared_user_ids)
       VALUES ($1, $2, $3, '[]'::jsonb, $4, $5::bigint[]) RETURNING watchlist_id::text AS watchlist_id`,
      [ownerId, firmId, `${prefix}-${name}`, scope, shared],
    );
    const listId = Number(list.watchlist_id);
    await t.client.query(
      `INSERT INTO watchlist_items (watchlist_id, position, instrument_id) VALUES ($1, 1, 9001)`,
      [listId],
    );
    lists.push(listId);
  }
  const [privateListId, firmListId, usersListId] = lists as [number, number, number];

  const room = await one<{ room_id: string }>(
    `INSERT INTO rooms (kind, name, firm_id, created_by)
     VALUES ('group', $1, $2, $3) RETURNING room_id::text AS room_id`,
    [`${prefix}-desk`, firmId, ownerId],
  );
  const roomId = Number(room.room_id);
  for (const member of [ownerId, peerId]) {
    await t.client.query(`INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)`, [
      roomId,
      member,
    ]);
  }

  const message = await one<{ message_id: string }>(
    `INSERT INTO messages (room_id, sender_user_id, sender_firm_id, body, client_msg_id)
     VALUES ($1, $2, $3, $4, gen_random_uuid()) RETURNING message_id::text AS message_id`,
    [roomId, ownerId, firmId, `${firmName} says hello`],
  );

  return {
    firmId,
    ownerId,
    peerId,
    strangerId,
    complianceId,
    portfolioId,
    positionId: Number(position.position_id),
    lotId: Number(lot.lot_id),
    workspaceId: Number(workspace.workspace_id),
    privateListId,
    firmListId,
    usersListId,
    roomId,
    messageId: Number(message.message_id),
  };
}

beforeEach(async () => {
  const demo = await seedTenant('Demo Capital', 'demo');
  const other = await seedTenant('Other Desk', 'other');
  const newsroomUserId = await insertUser(demo.firmId, 'demo-wire', 'newsroom');
  world = { demo, other, newsroomUserId };
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Identity helpers — every one of them runs under `terminal_app`, never the owner
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function actAs(
  userId: number,
  firmId: number,
  role: 'user' | 'compliance' = 'user',
): Promise<void> {
  await asAppRole(t);
  await asUser(t, userId, firmId, role);
}

/**
 * The SEC-06 shape: a user id, `app.role = 'newsroom'` and **no** firm. `asUser(…, 'newsroom')`
 * does not write `app.firm_id`, and `set_config(…, true)` is transaction-scoped rather than
 * statement-scoped, so a firm id set earlier in this transaction would still be readable. It is
 * cleared explicitly; `app_firm_id()` is `NULLIF(current_setting(…), '')::bigint`, so `''` is the
 * absence of a context and not the firm whose id is zero.
 */
async function actAsNewsroom(userId: number): Promise<void> {
  await asAppRole(t);
  await t.client.query(`SELECT set_config('app.firm_id', '', true)`);
  await asUser(t, userId, 0, 'newsroom');
}

interface Refusal {
  code: string;
  message: string;
}

/** Run `text` in a savepoint and require the policy to refuse it; the transaction stays usable. */
async function refused(text: string, params: readonly unknown[] = []): Promise<Refusal> {
  let outcome: Refusal | undefined;
  try {
    await t.savepoint(async () => {
      await t.client.query(text, params as unknown[]);
    });
  } catch (err) {
    outcome = {
      code: (err as { code?: string }).code ?? '',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (outcome === undefined) throw new Error(`expected a policy refusal from: ${text}`);
  return outcome;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('PORT-07 / SEC-05 — the other firm is invisible, table by table', () => {
  it('control: both firms are present, and it is the role switch that hides one of them', async () => {
    const { demo, other } = world;

    // As the owner — a superuser locally, which bypasses RLS including FORCE — every row is here.
    // Without this control, a fixture that silently failed to write Demo Capital's rows would make
    // every "zero" below pass for the wrong reason.
    const firms = [demo.firmId, other.firmId];
    expect(
      await count('SELECT count(*)::text AS n FROM portfolios WHERE firm_id = ANY($1::bigint[])', [
        firms,
      ]),
    ).toBe(2);
    expect(
      await count(
        'SELECT count(*)::text AS n FROM messages WHERE sender_firm_id = ANY($1::bigint[])',
        [firms],
      ),
    ).toBe(2);
    expect(
      await count('SELECT count(*)::text AS n FROM watchlists WHERE firm_id = ANY($1::bigint[])', [
        firms,
      ]),
    ).toBe(6);

    const role = await one<{ role: string; rls: boolean }>(
      `SELECT current_user AS role,
              (SELECT relrowsecurity FROM pg_class WHERE relname = 'portfolios') AS rls`,
    );
    expect(role.rls).toBe(true);

    // The switch itself is what applies the policies: same transaction, same rows, one role apart.
    await actAs(other.ownerId, other.firmId);
    const under = await one<{ role: string }>('SELECT current_user AS role');
    expect(under.role).toBe('terminal_app');
    expect(under.role).not.toBe(role.role);
    expect(await count('SELECT count(*)::text AS n FROM portfolios')).toBe(1);
    expect(
      await count('SELECT count(*)::text AS n FROM portfolios WHERE portfolio_id = $1', [
        demo.portfolioId,
      ]),
    ).toBe(0);
  });

  it('returns zero rows of Demo Capital data for every tenant table, and never an error', async () => {
    const { demo, other } = world;
    await actAs(other.ownerId, other.firmId);

    // Each pair is (what Demo Capital owns, what Other Desk owns). The first must read as zero
    // rows; the second proves the query itself works, so "zero" is a policy and not a typo.
    const probes: readonly { table: string; sql: string; mine: number; theirs: number }[] = [
      {
        table: 'portfolios',
        sql: 'SELECT count(*)::text AS n FROM portfolios WHERE portfolio_id = $1',
        theirs: demo.portfolioId,
        mine: other.portfolioId,
      },
      {
        table: 'positions',
        sql: 'SELECT count(*)::text AS n FROM positions WHERE position_id = $1',
        theirs: demo.positionId,
        mine: other.positionId,
      },
      {
        table: 'lots',
        sql: 'SELECT count(*)::text AS n FROM lots WHERE lot_id = $1',
        theirs: demo.lotId,
        mine: other.lotId,
      },
      {
        table: 'workspaces',
        sql: 'SELECT count(*)::text AS n FROM workspaces WHERE workspace_id = $1',
        theirs: demo.workspaceId,
        mine: other.workspaceId,
      },
      {
        table: 'watchlists',
        sql: 'SELECT count(*)::text AS n FROM watchlists WHERE watchlist_id = $1',
        theirs: demo.firmListId,
        mine: other.firmListId,
      },
      {
        table: 'watchlist_items',
        sql: 'SELECT count(*)::text AS n FROM watchlist_items WHERE watchlist_id = $1',
        theirs: demo.firmListId,
        mine: other.firmListId,
      },
      {
        table: 'rooms',
        sql: 'SELECT count(*)::text AS n FROM rooms WHERE room_id = $1',
        theirs: demo.roomId,
        mine: other.roomId,
      },
      {
        table: 'room_members',
        sql: 'SELECT count(*)::text AS n FROM room_members WHERE room_id = $1',
        theirs: demo.roomId,
        mine: other.roomId,
      },
      {
        table: 'messages',
        sql: 'SELECT count(*)::text AS n FROM messages WHERE message_id = $1',
        theirs: demo.messageId,
        mine: other.messageId,
      },
    ];

    for (const probe of probes) {
      expect(`${probe.table}: ${String(await count(probe.sql, [probe.theirs]))}`).toBe(
        `${probe.table}: 0`,
      );
      expect(await count(probe.sql, [probe.mine])).toBeGreaterThan(0);
    }
  });

  it('hides the rows from an unqualified scan too — the count is the tenant’s own', async () => {
    const { demo, other } = world;
    await actAs(other.ownerId, other.firmId);

    // No WHERE clause at all: what a leaky `SELECT *` in a future repository would return.
    expect(await count('SELECT count(*)::text AS n FROM portfolios')).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM positions')).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM lots')).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM messages')).toBe(1);

    const firmIds = await t.client.query<{ firm_id: string }>(
      'SELECT DISTINCT firm_id::text AS firm_id FROM portfolios',
    );
    expect(firmIds.rows.map((r) => Number(r.firm_id))).toEqual([other.firmId]);
    expect(firmIds.rows.map((r) => Number(r.firm_id))).not.toContain(demo.firmId);
  });

  it('is symmetric: Demo Capital is equally blind to Other Desk', async () => {
    const { demo, other } = world;
    await actAs(demo.ownerId, demo.firmId);

    expect(
      await count('SELECT count(*)::text AS n FROM portfolios WHERE portfolio_id = $1', [
        other.portfolioId,
      ]),
    ).toBe(0);
    expect(
      await count('SELECT count(*)::text AS n FROM positions WHERE position_id = $1', [
        other.positionId,
      ]),
    ).toBe(0);
    expect(
      await count('SELECT count(*)::text AS n FROM messages WHERE message_id = $1', [
        other.messageId,
      ]),
    ).toBe(0);
    expect(
      await count('SELECT count(*)::text AS n FROM portfolios WHERE portfolio_id = $1', [
        demo.portfolioId,
      ]),
    ).toBe(1);
  });

  it('a JOIN cannot walk from an own row into the other firm', async () => {
    const { demo, other } = world;
    await actAs(other.ownerId, other.firmId);

    // The join is written so that it *would* return Demo Capital's positions if `positions` were
    // readable: the predicate names their portfolio id directly.
    const joined = await count(
      `SELECT count(*)::text AS n
         FROM positions p LEFT JOIN portfolios f ON f.portfolio_id = p.portfolio_id
        WHERE p.portfolio_id = $1`,
      [demo.portfolioId],
    );
    expect(joined).toBe(0);

    // And a sub-select against the other tenant's table is empty rather than an error.
    const subselect = await count(
      `SELECT count(*)::text AS n FROM lots
        WHERE portfolio_id IN (SELECT portfolio_id FROM portfolios WHERE firm_id = $1)`,
      [demo.firmId],
    );
    expect(subselect).toBe(0);
    expect(other.firmId).not.toBe(demo.firmId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('PORT-07 / SEC-05 — the WITH CHECK clause refuses a cross-tenant write', () => {
  it('refuses an INSERT that would land a row in the other firm', async () => {
    const { demo, other } = world;
    await actAs(other.ownerId, other.firmId);

    const portfolio = await refused(
      `INSERT INTO portfolios (firm_id, owner_user_id, name) VALUES ($1, $2, 'smuggled')`,
      [demo.firmId, other.ownerId],
    );
    expect(portfolio.code).toBe('42501');
    expect(portfolio.message).toContain(
      'new row violates row-level security policy for table "portfolios"',
    );

    const position = await refused(
      `INSERT INTO positions (portfolio_id, firm_id, as_of_date, raw_identifier, quantity)
       VALUES ($1, $2, DATE '2026-09-15', 'SMUGGLED', 1)`,
      [other.portfolioId, demo.firmId],
    );
    expect(position.code).toBe('42501');
    expect(position.message).toContain('row-level security policy for table "positions"');

    const lot = await refused(
      `INSERT INTO lots (portfolio_id, firm_id, instrument_id, open_date, quantity, unit_cost, currency)
       VALUES ($1, $2, 9001, DATE '2026-01-02', 1, 1, 'USD')`,
      [other.portfolioId, demo.firmId],
    );
    expect(lot.code).toBe('42501');
    expect(lot.message).toContain('row-level security policy for table "lots"');

    const workspace = await refused(
      `INSERT INTO workspaces (user_id, firm_id, name, layout)
       VALUES ($1, $2, 'stolen', '{}'::jsonb)`,
      [demo.ownerId, demo.firmId],
    );
    expect(workspace.code).toBe('42501');
    expect(workspace.message).toContain('row-level security policy for table "workspaces"');

    const watchlist = await refused(
      `INSERT INTO watchlists (owner_user_id, firm_id, name, columns)
       VALUES ($1, $2, 'stolen', '[]'::jsonb)`,
      [other.ownerId, demo.firmId],
    );
    expect(watchlist.code).toBe('42501');
    expect(watchlist.message).toContain('row-level security policy for table "watchlists"');

    // Nothing landed.
    await actAs(demo.ownerId, demo.firmId);
    expect(await count(`SELECT count(*)::text AS n FROM portfolios WHERE name = 'smuggled'`)).toBe(
      0,
    );
    expect(
      await count(`SELECT count(*)::text AS n FROM watchlists WHERE name = 'stolen'`),
    ).toBe(0);
  });

  it('refuses an UPDATE that would move an own row into the other firm', async () => {
    const { demo, other } = world;
    await actAs(other.ownerId, other.firmId);

    const moved = await refused(`UPDATE portfolios SET firm_id = $1 WHERE portfolio_id = $2`, [
      demo.firmId,
      other.portfolioId,
    ]);
    expect(moved.code).toBe('42501');
    expect(moved.message).toContain(
      'new row violates row-level security policy for table "portfolios"',
    );

    const movedPosition = await refused(`UPDATE positions SET firm_id = $1 WHERE position_id = $2`, [
      demo.firmId,
      other.positionId,
    ]);
    expect(movedPosition.code).toBe('42501');

    // The row is unchanged and still the tenant's own.
    const firmOf = await one<{ firm_id: string }>(
      'SELECT firm_id::text AS firm_id FROM portfolios WHERE portfolio_id = $1',
      [other.portfolioId],
    );
    expect(Number(firmOf.firm_id)).toBe(other.firmId);
  });

  it('an UPDATE or DELETE of an invisible row changes nothing and raises nothing', async () => {
    const { demo, other } = world;
    await actAs(other.ownerId, other.firmId);

    // A policy does not error here: the row is simply not in the tenant's view of the table, so
    // the statement matches zero rows. That is the difference between RLS and a CHECK constraint.
    const renamed = await t.client.query(`UPDATE portfolios SET name = 'owned' WHERE portfolio_id = $1`, [
      demo.portfolioId,
    ]);
    expect(renamed.rowCount).toBe(0);

    const deleted = await t.client.query('DELETE FROM positions WHERE position_id = $1', [
      demo.positionId,
    ]);
    expect(deleted.rowCount).toBe(0);

    // Verified from the other side: Demo Capital's rows are untouched.
    await actAs(demo.ownerId, demo.firmId);
    const name = await one<{ name: string }>(
      'SELECT name FROM portfolios WHERE portfolio_id = $1',
      [demo.portfolioId],
    );
    expect(name.name).toBe('Demo Capital book');
    expect(
      await count('SELECT count(*)::text AS n FROM positions WHERE position_id = $1', [
        demo.positionId,
      ]),
    ).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Watchlist sharing (the one policy with three audiences)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('SEC-05 — watchlist sharing shows each row to exactly the right subject', () => {
  /** Ids of the Demo Capital watchlists visible to the identity currently in force. */
  async function visibleLists(): Promise<number[]> {
    const res = await t.client.query<{ watchlist_id: string }>(
      `SELECT watchlist_id::text AS watchlist_id FROM watchlists WHERE firm_id = $1
        ORDER BY watchlist_id`,
      [world.demo.firmId],
    );
    return res.rows.map((r) => Number(r.watchlist_id));
  }

  it('gives the owner all three, the shared colleague two, a colleague one and the other firm none', async () => {
    const { demo, other } = world;
    const all = [demo.privateListId, demo.firmListId, demo.usersListId].sort((a, b) => a - b);

    await actAs(demo.ownerId, demo.firmId);
    expect(await visibleLists()).toEqual(all);

    // `peer` is in `shared_user_ids` of the 'users' list and is at the firm, so it sees that one
    // and the firm-wide one — and not the private one.
    await actAs(demo.peerId, demo.firmId);
    expect(await visibleLists()).toEqual([demo.firmListId, demo.usersListId].sort((a, b) => a - b));

    // `stranger` is at the firm but in no share list: the firm-wide one only.
    await actAs(demo.strangerId, demo.firmId);
    expect(await visibleLists()).toEqual([demo.firmListId]);

    // Another firm sees none of them, whatever the scope says.
    await actAs(other.ownerId, other.firmId);
    expect(await visibleLists()).toEqual([]);
  });

  it('carries the same scope down to watchlist_items through the delegating policy', async () => {
    const { demo, other } = world;

    async function itemsOf(listId: number): Promise<number> {
      return count('SELECT count(*)::text AS n FROM watchlist_items WHERE watchlist_id = $1', [
        listId,
      ]);
    }

    await actAs(demo.ownerId, demo.firmId);
    expect(await itemsOf(demo.privateListId)).toBe(1);
    expect(await itemsOf(demo.firmListId)).toBe(1);

    await actAs(demo.strangerId, demo.firmId);
    expect(await itemsOf(demo.privateListId)).toBe(0); // the parent list is invisible
    expect(await itemsOf(demo.firmListId)).toBe(1);

    await actAs(other.ownerId, other.firmId);
    expect(await itemsOf(demo.firmListId)).toBe(0);
    expect(await itemsOf(demo.usersListId)).toBe(0);
  });

  it('sharing grants reading and not writing — the WITH CHECK still names the owner', async () => {
    const { demo } = world;
    await actAs(demo.peerId, demo.firmId);

    // The peer can read the firm-shared list…
    expect(
      await count('SELECT count(*)::text AS n FROM watchlists WHERE watchlist_id = $1', [
        demo.firmListId,
      ]),
    ).toBe(1);

    // …and cannot rewrite it, because `WITH CHECK (owner_user_id = app_user_id())` fails for a row
    // whose owner is somebody else.
    const rename = await refused(`UPDATE watchlists SET name = 'mine now' WHERE watchlist_id = $1`, [
      demo.firmListId,
    ]);
    expect(rename.code).toBe('42501');
    expect(rename.message).toContain('row-level security policy for table "watchlists"');

    // Nor add an item to it: `watchlist_items`' WITH CHECK names the owner explicitly.
    const item = await refused(
      `INSERT INTO watchlist_items (watchlist_id, position, instrument_id) VALUES ($1, 2, 9002)`,
      [demo.firmListId],
    );
    expect(item.code).toBe('42501');
    expect(item.message).toContain('row-level security policy for table "watchlist_items"');

    // Nor create one owned by the colleague.
    const forged = await refused(
      `INSERT INTO watchlists (owner_user_id, firm_id, name, columns)
       VALUES ($1, $2, 'forged', '[]'::jsonb)`,
      [demo.ownerId, demo.firmId],
    );
    expect(forged.code).toBe('42501');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Messaging (MSG-02): membership reads, compliance reads, nobody else
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('SEC-05 — rooms, memberships and messages follow membership, not the firm alone', () => {
  it('shows a room and its messages to its members only', async () => {
    const { demo, other } = world;

    await actAs(demo.ownerId, demo.firmId);
    expect(
      await count('SELECT count(*)::text AS n FROM rooms WHERE room_id = $1', [demo.roomId]),
    ).toBe(1);
    expect(
      await count('SELECT count(*)::text AS n FROM messages WHERE room_id = $1', [demo.roomId]),
    ).toBe(1);
    expect(
      await count('SELECT count(*)::text AS n FROM room_members WHERE room_id = $1', [demo.roomId]),
    ).toBe(2);

    // Same firm, not a member: the room does not exist as far as this session is concerned.
    await actAs(demo.strangerId, demo.firmId);
    expect(
      await count('SELECT count(*)::text AS n FROM rooms WHERE room_id = $1', [demo.roomId]),
    ).toBe(0);
    expect(
      await count('SELECT count(*)::text AS n FROM messages WHERE room_id = $1', [demo.roomId]),
    ).toBe(0);
    expect(
      await count('SELECT count(*)::text AS n FROM room_members WHERE room_id = $1', [demo.roomId]),
    ).toBe(0);

    // Another firm entirely: the same nothing.
    await actAs(other.ownerId, other.firmId);
    expect(
      await count('SELECT count(*)::text AS n FROM messages WHERE room_id = $1', [demo.roomId]),
    ).toBe(0);
  });

  it('lets compliance of the members’ firm read the room, and no other firm’s compliance', async () => {
    const { demo, other } = world;

    await actAs(demo.complianceId, demo.firmId, 'compliance');
    expect(
      await count('SELECT count(*)::text AS n FROM rooms WHERE room_id = $1', [demo.roomId]),
    ).toBe(1);
    expect(
      await count('SELECT count(*)::text AS n FROM messages WHERE room_id = $1', [demo.roomId]),
    ).toBe(1);

    // Compliance is a supervisory power over one's own firm, not a master key.
    await actAs(other.complianceId, other.firmId, 'compliance');
    expect(
      await count('SELECT count(*)::text AS n FROM rooms WHERE room_id = $1', [demo.roomId]),
    ).toBe(0);
    expect(
      await count('SELECT count(*)::text AS n FROM messages WHERE room_id = $1', [demo.roomId]),
    ).toBe(0);
  });

  it('refuses a message sent into a room one does not belong to, or sent under another name', async () => {
    const { demo, other } = world;
    await actAs(other.ownerId, other.firmId);

    const intoTheirRoom = await refused(
      `INSERT INTO messages (room_id, sender_user_id, sender_firm_id, body, client_msg_id)
       VALUES ($1, $2, $3, 'listening', gen_random_uuid())`,
      [demo.roomId, other.ownerId, other.firmId],
    );
    expect(intoTheirRoom.code).toBe('42501');
    expect(intoTheirRoom.message).toContain('row-level security policy for table "messages"');

    const spoofed = await refused(
      `INSERT INTO messages (room_id, sender_user_id, sender_firm_id, body, client_msg_id)
       VALUES ($1, $2, $3, 'not me', gen_random_uuid())`,
      [other.roomId, demo.ownerId, demo.firmId],
    );
    expect(spoofed.code).toBe('42501');

    // A member sending as themselves into their own room is accepted — the policy is a wall, not
    // a brick.
    await actAs(demo.ownerId, demo.firmId);
    const sent = await t.client.query(
      `INSERT INTO messages (room_id, sender_user_id, sender_firm_id, body, client_msg_id)
       VALUES ($1, $2, $3, 'morning', gen_random_uuid())`,
      [demo.roomId, demo.ownerId, demo.firmId],
    );
    expect(sent.rowCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SEC-06 — the newsroom wall
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('SEC-06 — a session with a user id and no firm context reads nothing tenant-scoped', () => {
  it('sees zero rows in every firm-keyed table, including its own employer’s', async () => {
    const { demo, newsroomUserId } = world;
    await actAsNewsroom(newsroomUserId);

    // The user row says Demo Capital; the *session* says nothing, and `firm_id = NULL` is never
    // true, so the tables are empty rather than filtered.
    const context = await one<{ uid: string | null; fid: string | null; role: string }>(
      `SELECT app_user_id()::text AS uid, app_firm_id()::text AS fid, app_role() AS role`,
    );
    expect(Number(context.uid)).toBe(newsroomUserId);
    expect(context.fid).toBeNull();
    expect(context.role).toBe('newsroom');

    expect(await count('SELECT count(*)::text AS n FROM portfolios')).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM positions')).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM lots')).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM watchlists')).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM watchlist_items')).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM messages')).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM rooms')).toBe(0);
    expect(
      await count('SELECT count(*)::text AS n FROM portfolios WHERE firm_id = $1', [demo.firmId]),
    ).toBe(0);
  });

  it('cannot write into any firm either', async () => {
    const { demo, newsroomUserId } = world;
    await actAsNewsroom(newsroomUserId);

    const portfolio = await refused(
      `INSERT INTO portfolios (firm_id, owner_user_id, name) VALUES ($1, $2, 'wire desk')`,
      [demo.firmId, newsroomUserId],
    );
    expect(portfolio.code).toBe('42501');

    // `workspaces` is keyed on the user and would otherwise accept the row; its WITH CHECK also
    // names the firm, so a context-less session cannot create one.
    const workspace = await refused(
      `INSERT INTO workspaces (user_id, firm_id, name, layout)
       VALUES ($1, $2, 'wire', '{}'::jsonb)`,
      [newsroomUserId, demo.firmId],
    );
    expect(workspace.code).toBe('42501');
    expect(workspace.message).toContain('row-level security policy for table "workspaces"');

    const watchlist = await refused(
      `INSERT INTO watchlists (owner_user_id, firm_id, name, columns)
       VALUES ($1, $2, 'wire', '[]'::jsonb)`,
      [newsroomUserId, demo.firmId],
    );
    expect(watchlist.code).toBe('42501');
  });

  it('the wall is the context and not the role name: the same user with a firm context reads that firm', async () => {
    const { demo, newsroomUserId } = world;

    // Proof that the previous test measured the missing firm context rather than a quirk of the
    // seeded data: give the same user a firm context and the firm's rows appear.
    await actAs(newsroomUserId, demo.firmId);
    expect(
      await count('SELECT count(*)::text AS n FROM portfolios WHERE firm_id = $1', [demo.firmId]),
    ).toBe(1);

    // And taking it away again makes them disappear inside the same transaction.
    await actAsNewsroom(newsroomUserId);
    expect(await count('SELECT count(*)::text AS n FROM portfolios')).toBe(0);
  });
});
