/**
 * `test/integration/workspaces/workspaces.test.ts` — the twelve routes of API.md §5.7 L597-642
 * (TERM-04, TERM-05, TERM-10, CHRT-05), WP-08.
 *
 * WORKPLAN's WP-08 acceptance table names no file for this route group, and twelve routes that
 * decide what a desk looks like every morning should not ship unexercised. What it proves, in
 * order of what it would cost to get wrong:
 *
 *  1. **Optimistic concurrency.** A `PUT` with the version the client read wins and bumps it; a
 *     `PUT` with a stale version is `409 WORKSPACE_VERSION_CONFLICT` carrying the server's whole
 *     copy in `details.current`, and — the part a naive implementation gets wrong — it does NOT
 *     write. Two panels autosaving the same desk is the normal case, not the edge case.
 *  2. **Tenant isolation is a 404.** Another user's workspace must not be readable, writable or
 *     deletable, and the answer must not distinguish "yours but gone" from "someone else's". The
 *     assertion runs under `SET LOCAL ROLE terminal_app` (`asAppRole`), because the migration
 *     owner is a local superuser and bypasses the very RLS policy under test.
 *  3. **The shapes are the wire's.** Every body is parsed with `@terminal/sdk/wire/rest/workspaces`.
 *
 * The last test is not an assertion about this route file at all: it records that migration 0015
 * grants `terminal_app` no `DELETE` on `workspaces`, so `DELETE /workspaces/:id` — which API.md
 * L638 documents as `204` — cannot succeed as the application role in production. It will fail
 * when somebody fixes the grant, which is exactly when it should be read again.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ChartAnnotation,
  Workspace,
  WorkspaceLayout,
  type WorkspaceSummary,
} from '@terminal/sdk/wire/rest/workspaces';

import { getConfig } from '../../../src/config.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { asAppRole, withTxDb, type TestDb } from '../../../src/test/db.js';
import { seedQuoteInstrument } from '../ws/helpers.js';

const t: TestDb = withTxDb();
const clock = testClock();

let harness: TestApp;
let app: FastifyInstance;

interface Actor {
  userId: number;
  firmId: number;
  cookie: string;
}

let alice: Actor;
let bob: Actor;

async function newActor(firmId: number, label: string): Promise<Actor> {
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, $3, 'user') RETURNING user_id`,
    [firmId, `ws-${randomUUID()}@demo.invalid`, label],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  return {
    userId,
    firmId,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
  };
}

beforeEach(async () => {
  harness = await createTestApp({ db: t.db, clock });
  app = harness.app;

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Workspace Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  alice = await newActor(firmId, 'Alice');
  bob = await newActor(firmId, 'Bob');
});

afterEach(async () => {
  await harness.close();
});

function headers(a: Actor): Record<string, string> {
  return { cookie: a.cookie, 'x-requested-with': 'terminal' };
}

async function call(
  a: Actor,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ statusCode: number; payload: string; json: <T>() => T }> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: headers(a),
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    statusCode: res.statusCode,
    payload: res.payload,
    json: <T,>(): T => JSON.parse(res.payload) as T,
  };
}

/** A layout that differs from the default in a way the assertions can see. */
function layoutWith(draft: string): WorkspaceLayout {
  return WorkspaceLayout.parse({
    schema: 1,
    mode: '2h',
    panels: [
      { id: 'p1', frameStack: [], index: 0, history: ['DES'], commandDraft: draft },
      { id: 'p2', frameStack: [], index: 0, history: [] },
    ],
    focus: 'p2',
    conflationMs: 500,
  });
}

describe('the active workspace (TERM-05)', () => {
  it('creates a default on first read and returns the same one after', async () => {
    const first = await call(alice, 'GET', '/workspace');
    expect(first.statusCode, first.payload).toBe(200);
    const created = Workspace.parse(first.json());
    expect(created.isActive).toBe(true);
    expect(created.version).toBe(1);
    expect(created.name).toBe('default');
    expect(created.layout.panels).toHaveLength(1);
    expect(created.layout.mode).toBe('1');

    const second = Workspace.parse((await call(alice, 'GET', '/workspace')).json());
    expect(second.workspaceId).toBe(created.workspaceId);
    expect(second.version).toBe(1);

    // One desk per user: Bob's first read makes his own, not Alice's.
    const bobs = Workspace.parse((await call(bob, 'GET', '/workspace')).json());
    expect(bobs.workspaceId).not.toBe(created.workspaceId);
  });

  it('autosaves under optimistic concurrency and refuses a stale version', async () => {
    const start = Workspace.parse((await call(alice, 'GET', '/workspace')).json());

    const ok = await call(alice, 'PUT', '/workspace', {
      version: start.version,
      layout: layoutWith('first'),
    });
    expect(ok.statusCode, ok.payload).toBe(200);
    const saved = ok.json<{ version: number; updatedAt: string }>();
    expect(saved.version).toBe(start.version + 1);

    // The second panel still holds the version it read before the first one saved.
    const stale = await call(alice, 'PUT', '/workspace', {
      version: start.version,
      layout: layoutWith('second'),
    });
    expect(stale.statusCode).toBe(409);
    const envelope = stale.json<{
      error: { code: string; details: { current: unknown } };
    }>();
    expect(envelope.error.code).toBe('WORKSPACE_VERSION_CONFLICT');

    // `details.current` is the server's whole copy, so the client can merge without a round trip.
    const current = Workspace.parse(envelope.error.details.current);
    expect(current.version).toBe(saved.version);
    expect(current.layout.panels[0]?.commandDraft).toBe('first');

    // And the refused write did not land.
    const after = Workspace.parse((await call(alice, 'GET', '/workspace')).json());
    expect(after.version).toBe(saved.version);
    expect(after.layout.panels[0]?.commandDraft).toBe('first');
  });
});

describe('named workspaces', () => {
  it('lists without layouts, creates, renames, activates and deletes', async () => {
    await call(alice, 'GET', '/workspace');

    const created = await call(alice, 'POST', '/workspaces', {
      name: 'Rates',
      layout: layoutWith('rates'),
    });
    expect(created.statusCode, created.payload).toBe(201);
    const rates = Workspace.parse(created.json());
    expect(rates.isActive).toBe(false);

    const list = (await call(alice, 'GET', '/workspaces')).json<{ items: WorkspaceSummary[] }>();
    expect(list.items).toHaveLength(2);
    for (const item of list.items) expect(item).not.toHaveProperty('layout');
    expect(list.items[0]?.isActive).toBe(true);

    // Duplicate name.
    const dup = await call(alice, 'POST', '/workspaces', {
      name: 'Rates',
      layout: layoutWith('again'),
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json<{ error: { code: string } }>().error.code).toBe('DUPLICATE_NAME');

    // Rename, under the same optimistic concurrency.
    const renamed = await call(alice, 'PUT', `/workspaces/${String(rates.workspaceId)}`, {
      version: rates.version,
      name: 'Rates EU',
    });
    expect(renamed.statusCode, renamed.payload).toBe(200);
    expect(Workspace.parse(renamed.json()).name).toBe('Rates EU');

    const staleRename = await call(alice, 'PUT', `/workspaces/${String(rates.workspaceId)}`, {
      version: rates.version,
      name: 'Rates US',
    });
    expect(staleRename.statusCode).toBe(409);

    // Activate flips exactly one row.
    const activated = await call(
      alice,
      'POST',
      `/workspaces/${String(rates.workspaceId)}/activate`,
    );
    expect(activated.statusCode, activated.payload).toBe(200);
    expect(Workspace.parse(activated.json()).isActive).toBe(true);
    const afterActivate = (await call(alice, 'GET', '/workspaces')).json<{
      items: WorkspaceSummary[];
    }>();
    expect(afterActivate.items.filter((w) => w.isActive)).toHaveLength(1);
    expect(
      Workspace.parse((await call(alice, 'GET', '/workspace')).json()).workspaceId,
    ).toBe(rates.workspaceId);

    const deleted = await call(alice, 'DELETE', `/workspaces/${String(rates.workspaceId)}`);
    expect(deleted.statusCode, deleted.payload).toBe(204);
    expect((await call(alice, 'GET', `/workspaces/${String(rates.workspaceId)}`)).statusCode).toBe(
      404,
    );
  });

  it("answers 404, never 403, for another user's workspace", async () => {
    const mine = Workspace.parse((await call(bob, 'GET', '/workspace')).json());

    // The owner role bypasses RLS locally; the application role is the one under test.
    await asAppRole(t);

    const read = await call(alice, 'GET', `/workspaces/${String(mine.workspaceId)}`);
    expect(read.statusCode).toBe(404);
    expect(read.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');

    const write = await call(alice, 'PUT', `/workspaces/${String(mine.workspaceId)}`, {
      version: mine.version,
      layout: layoutWith('theirs'),
    });
    expect(write.statusCode).toBe(404);

    // Indistinguishable from an id that does not exist at all.
    const absent = await call(alice, 'GET', '/workspaces/999999999');
    expect(absent.statusCode).toBe(404);
    expect(absent.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('rejects a workspaceId that is not a positive integer', async () => {
    const res = await call(alice, 'GET', '/workspaces/not-a-number');
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('chart annotations (CHRT-05)', () => {
  /** An instrument to anchor annotations to; `chart_annotations.instrument_id` has no FK, but a
   * real id keeps the row honest. */
  async function instrument(): Promise<number> {
    const { instrumentId } = await seedQuoteInstrument(t, {
      ticker: `AN${randomUUID().slice(0, 4).toUpperCase()}`,
    });
    return instrumentId;
  }

  it('creates, lists, updates and deletes an annotation, and hides another owner from writes', async () => {
    const instrumentId = await instrument();

    const created = await call(alice, 'POST', '/annotations', {
      instrumentId,
      kind: 'hline',
      anchors: [{ t: 1_760_000_000_000, v: 101.5 }],
      style: { colour: 'amber' },
      label: 'resistance',
      sharedScope: 'firm',
      sharedUserIds: [],
    });
    expect(created.statusCode, created.payload).toBe(201);
    const annotation = ChartAnnotation.parse(created.json());
    expect(annotation.ownerUserId).toBe(alice.userId);
    expect(annotation.sharedScope).toBe('firm');

    const listed = (
      await call(alice, 'GET', `/annotations?instrumentId=${String(instrumentId)}`)
    ).json<{ items: unknown[] }>();
    expect(listed.items).toHaveLength(1);
    expect(ChartAnnotation.parse(listed.items[0]).annotationId).toBe(annotation.annotationId);

    const updated = await call(
      alice,
      'PUT',
      `/annotations/${String(annotation.annotationId)}`,
      {
        instrumentId,
        kind: 'hline',
        anchors: [{ t: 1_760_000_000_000, v: 99 }],
        style: { colour: 'amber' },
        label: 'support',
        sharedScope: 'private',
        sharedUserIds: [],
      },
    );
    expect(updated.statusCode, updated.payload).toBe(200);
    expect(ChartAnnotation.parse(updated.json()).label).toBe('support');

    // Bob may see a firm-shared annotation but never write one he does not own.
    const bobWrite = await call(bob, 'PUT', `/annotations/${String(annotation.annotationId)}`, {
      instrumentId,
      kind: 'hline',
      anchors: [{ t: 1, v: 1 }],
      style: {},
      label: 'mine now',
      sharedScope: 'private',
      sharedUserIds: [],
    });
    expect(bobWrite.statusCode).toBe(404);
    const bobDelete = await call(
      bob,
      'DELETE',
      `/annotations/${String(annotation.annotationId)}`,
    );
    expect(bobDelete.statusCode).toBe(404);

    const deleted = await call(
      alice,
      'DELETE',
      `/annotations/${String(annotation.annotationId)}`,
    );
    expect(deleted.statusCode, deleted.payload).toBe(204);
    expect(
      (await call(alice, 'GET', `/annotations?instrumentId=${String(instrumentId)}`)).json<{
        items: unknown[];
      }>().items,
    ).toHaveLength(0);
  });
});

describe('the schema grant DELETE /workspaces/:id depends on', () => {
  it('is missing: migration 0015 grants terminal_app no DELETE on workspaces', async () => {
    const res = await t.client.query<{ workspaces: boolean; annotations: boolean }>(
      `SELECT has_table_privilege('terminal_app', 'workspaces', 'DELETE')       AS workspaces,
              has_table_privilege('terminal_app', 'chart_annotations', 'DELETE') AS annotations`,
    );
    // `chart_annotations` is in the 15.b DELETE list and `workspaces` is not, so the documented
    // `204` of API.md L638 becomes "permission denied for table workspaces" under the application
    // role. The route is written as documented; the grant is a migration's to fix.
    expect(res.rows[0]!.annotations).toBe(true);
    expect(res.rows[0]!.workspaces).toBe(false);
  });
});
