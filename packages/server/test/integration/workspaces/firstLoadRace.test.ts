/**
 * `test/integration/workspaces/firstLoadRace.test.ts` — a person's very first `GET /workspace`,
 * arriving twice at once.
 *
 * `GET /workspace` creates the built-in default the first time a person has none
 * (`routes/workspaces.ts#activeWorkspace`). Every seeded user already has one, so the path only
 * runs for a NEW account — which, since `scripts/create-user.ts`, is every real one. Found by
 * `e2e/tests/login.spec.ts`: the shell's first load and a second request raced, both read "no
 * workspace", both inserted, and the loser failed on `workspaces_user_id_name_key` — SQLSTATE 23505,
 * answered as `500 INTERNAL`. Two tabs opened at once, or a reload during the first load, is the
 * same race.
 *
 * `workspaces.test.ts` runs inside one rolled-back transaction, which cannot see it. So this file
 * commits: a second connection holds an uncommitted default for the person while the route runs on
 * the application's pool, then commits — the interleaving the race needs, made deterministic.
 *
 * Everything this file creates is deleted in `afterEach`: it commits into the shared test database
 * and must leave nothing behind for the files running beside it.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Workspace } from '@terminal/sdk/wire/rest/workspaces';

import { getConfig } from '../../../src/config.js';
import { DEFAULT_WORKSPACE_LAYOUT } from '../../../src/http/routes/workspaces.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { testDatabaseUrl, withCleanDb, type TestDb } from '../../../src/test/db.js';

const { Pool } = pg;

/** Nothing is truncated — this harness is here only for a connection whose writes commit. */
const t: TestDb = withCleanDb([]);

let pool: pg.Pool;
let harness: TestApp | undefined;
let firmId: number;
let userId: number;
let sessionCookie: string;

beforeAll(() => {
  pool = new Pool({ connectionString: testDatabaseUrl(), max: 2 });
  pool.on('error', () => undefined);
});

beforeEach(async () => {
  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`First Load Firm ${randomUUID().slice(0, 8)}`],
  );
  firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'First Load', 'user') RETURNING user_id`,
    [firmId, `first-load-${randomUUID()}@demo.invalid`],
  );
  userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  sessionCookie = `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`;
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  // This file commits, so it cleans up after itself: nothing it created may outlive it.
  await t.client.query(`DELETE FROM workspaces WHERE user_id = $1`, [userId]);
  await t.client.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  await t.client.query(`DELETE FROM users WHERE user_id = $1`, [userId]);
  await t.client.query(`DELETE FROM firms WHERE firm_id = $1`, [firmId]);
});

afterAll(async () => {
  await pool.end();
});

describe('the first GET /workspace, twice at once', () => {
  it('answers the loser with the winner’s workspace, not a 500', async () => {
    // No `db`: the routes run on the application's pool, so their writes commit like production's.
    harness = await createTestApp({ clock: testClock() });
    const app = harness.app;

    // The "other request" got there first: its default is inserted and not yet committed.
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      const theirs = await other.query<{ workspace_id: string }>(
        `INSERT INTO workspaces (user_id, firm_id, name, is_active, layout, version)
         VALUES ($1, $2, 'default', true, $3::jsonb, 1) RETURNING workspace_id`,
        [userId, firmId, JSON.stringify(DEFAULT_WORKSPACE_LAYOUT)],
      );

      // This one reads "no workspace" (the other row is invisible to it) and tries to insert.
      let settled = false;
      const mine = app
        .inject({ method: 'GET', url: '/api/v1/workspace', headers: { cookie: sessionCookie } })
        .finally(() => {
          settled = true;
        });
      // It must be WAITING on the other insert — the interleaving the race needs. Without this
      // pause it could take its snapshot after the commit and never meet the other row at all.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const settledWhileOpen = settled;
      await other.query('COMMIT');
      const res = await mine;

      expect(settledWhileOpen, 'the request did not meet the uncommitted default').toBe(false);
      expect(res.statusCode, res.body).toBe(200);
      const got = Workspace.parse(JSON.parse(res.body));
      expect(got.workspaceId).toBe(Number(theirs.rows[0]!.workspace_id));

      const rows = await t.client.query(`SELECT 1 FROM workspaces WHERE user_id = $1`, [userId]);
      expect(rows.rows, 'one desk for the person, not two').toHaveLength(1);
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      other.release();
    }
  }, 30_000);
});
