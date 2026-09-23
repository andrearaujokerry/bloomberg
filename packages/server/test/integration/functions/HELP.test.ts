/**
 * `test/integration/functions/HELP.test.ts` — WP-09's acceptance row for `HELP`
 * (WORKPLAN §WP-09: "help per variant, search ranking, ticket creation and room").
 *
 * HELP is the one screen that must never be able to drift from behaviour, so everything asserted
 * here is asserted *against the thing that runs*: the payload's function entry is compared to the
 * manifest the runner dispatches through, the `fields[]` rows are compared to the field dictionary
 * the entitlement evaluator resolves against, and the attribution is compared to the
 * `licence_registry` row DATA-09 makes the footer out of. A test that restated the documentation
 * would pass on a HELP that lied.
 *
 * The four things this file proves, one per acceptance clause:
 *
 *  1. **Help per variant.** `view:'function'` with an `assetClass` returns that class's *variant*
 *     name from the manifest's own map (FUNC-02), and an asset class the manifest does not cover
 *     is still answered — with the `NOT_APPLICABLE` note that explains why the command line
 *     rejected it, rather than a 422 that explains nothing (§HELP L2113).
 *  2. **Search ranking.** An exact code outranks a substring hit, which outranks a trigram hit,
 *     and the hit list is sorted by score descending. Zero hits is a `NO_SOURCE` entry, not an
 *     empty screen with nothing to say.
 *  3. **Ticket creation.** `POST /help/tickets` writes one `help_tickets` row carrying the screen
 *     state, the params and the trace id, and returns `201 { ticketId, roomId }`.
 *  4. **The helpdesk room.** That `roomId` is a real `rooms` row of kind `helpdesk` whose members
 *     are the author *and* the firm's `helpdesk`-role users, and `usage_events` carries one
 *     `ticket.open` row beside it (FUNC-04).
 *
 * ## No seed
 *
 * WP-15 owns the seed and it does not exist: every firm, user, session and grant here is created
 * inside this file's own `withTxDb()` transaction and rolled back afterwards. Nothing depends on
 * a literal id.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden } from './golden.js';

import { FunctionRegistry, registry as coreRegistry } from '@terminal/core';
import { getField } from '@terminal/core/fields/dictionary';
import { HELP } from '@terminal/core/functions/manifests/HELP';
import type { HelpPayload } from '@terminal/core/functions/manifests/HELP';
import { SECF } from '@terminal/core/functions/manifests/SECF';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import * as HelpModule from '../../../src/functions/HELP/resolve.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { GOLDEN_CAPTURE_MS } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';

const REGISTRY = new FunctionRegistry([HELP]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { HELP: HelpModule };

const t: TestDb = withTxDb();

interface Principal {
  userId: number;
  cookie: string;
}

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  firmId: number;
  pm: Principal;
  desk: Principal;
  knownAt: string;
}

let env: Env;

async function ensureLicences(): Promise<void> {
  const present = await t.client.query(
    `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
  );
  if (present.rowCount === 0) await seedLicences(t.client);
}

/** A firm-wide and user-wide grant per source, so the `fields[]` decisions are about HELP. */
async function grantEverySource(firmId: number, userId: number): Promise<void> {
  await t.client.query(
    `INSERT INTO entitlement_grants
       (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
        usage_display, usage_export, usage_api, valid_from, valid_to)
     SELECT k.kind, k.id, l.source_id, NULL, NULL, 'realtime'::tier, true, true, true,
            $3::timestamptz, 'infinity'::timestamptz
       FROM (SELECT DISTINCT source_id FROM licence_registry WHERE tx_to = 'infinity') l
       CROSS JOIN (VALUES ('firm', $1::bigint), ('user', $2::bigint)) AS k(kind, id)`,
    [firmId, userId, GRANT_FROM],
  );
}

async function createUser(firmId: number, role: string): Promise<Principal> {
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING user_id`,
    [firmId, `help-${randomUUID()}@demo.invalid`, `HELP ${role}`, role],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  await grantEverySource(firmId, userId);
  return {
    userId,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
  };
}

beforeEach(async () => {
  await ensureLicences();

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`HELP Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const pm = await createUser(firmId, 'user');
  const desk = await createUser(firmId, 'helpdesk');

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };

  env = { harness, app: harness.app, clock, firmId, pm, desk, knownAt };
});

afterEach(async () => {
  await env.harness.close();
});

async function runHelp(
  params: Record<string, unknown>,
  who: Principal = env.pm,
): Promise<HelpPayload> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/HELP/run`,
    headers: { cookie: who.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<{ data: HelpPayload }>().data;
}

describe('HELP — the terminal documenting itself', () => {
  it('indexes every function by tier, with the shell words and the reserved keys', async () => {
    const payload = await runHelp({});
    if (payload.view !== 'index') throw new Error(`expected the index view, got ${payload.view}`);

    expect(payload.variant).toBe('default');
    expect(payload.tiers.map((t2) => t2.tier)).toEqual([1, 2, 3]);

    // The index is the registry, not a copy of it: every Tier 1 manifest the runner can dispatch
    // is listed, with its own summary and aliases.
    const tier1 = payload.tiers.find((t2) => t2.tier === 1)!;
    const expected = coreRegistry.byTier(1);
    expect(tier1.functions.map((f) => f.code).sort()).toEqual(expected.map((m) => m.code).sort());
    const des = tier1.functions.find((f) => f.code === 'DES')!;
    expect(des.summary).toBe(coreRegistry.get('DES')!.help.summary);
    expect(des.aliases).toContain('DESC');

    expect(payload.shell.length).toBeGreaterThan(0);
    expect(payload.keys.some((k) => k.key === 'F1')).toBe(true);
    expect(payload.keys.some((k) => k.key === 'Ctrl+I')).toBe(true);
  });

  it('describes one function per asset-class variant, with each field’s licence and decision', async () => {
    const payload = await runHelp({ view: 'function', code: 'DES', assetClass: 'equity' });
    if (payload.view !== 'function')
      throw new Error(`expected the function view, got ${payload.view}`);

    const manifest = coreRegistry.get('DES')!;
    expect(payload.function.code).toBe('DES');
    expect(payload.function.name).toBe(manifest.name);
    expect(payload.function.tier).toBe(1);
    // FUNC-02: the variant the *manifest* maps this class to, never a second opinion.
    expect(payload.function.variant).toBe(manifest.variants.equity);
    expect(payload.function.help.summary).toBe(manifest.help.summary);
    expect(payload.function.keys.map((k) => k.key)).toEqual(manifest.keymap.map((k) => k.key));
    const shape = (manifest.params as { shape: Record<string, unknown> }).shape;
    expect(payload.function.params.map((p) => p.name)).toEqual(Object.keys(shape));
    // `tab` defaults to 'profile' and the projection says so, so the overlay can show the
    // parameter's current value beside its documentation.
    expect(payload.function.params.find((p) => p.name === 'tab')?.default).toBe('profile');

    // Every field row is the dictionary entry plus its licence attribution (DATA-09) and the
    // caller's own decision (ENTL-05).
    const ids = manifest.fieldIds('equity');
    expect(payload.function.fields.map((f) => f.id)).toEqual(ids);
    const last = payload.function.fields.find((f) => f.id === 'PX_LAST')!;
    expect(last.label).toBe(getField('PX_LAST')!.label);
    expect(last.definition).toBe(getField('PX_LAST')!.definition);
    expect(last.sourceId).not.toBe('');
    expect(last.attribution).not.toBe('');

    const licence = await t.client.query<{ attribution: string }>(
      `SELECT attribution FROM licence_registry WHERE source_id = $1 AND tx_to = 'infinity'`,
      [last.sourceId],
    );
    expect(last.attribution).toBe(licence.rows[0]!.attribution);

    // The decision column is the evaluator's, not a label HELP made up: a field whose licence is
    // the same for every asset class resolves without a panel security, and this firm holds a
    // grant for its source, so it is allowed.
    const session = payload.function.fields.find((f) => f.id === 'SESSION_STATE')!;
    expect(session.decision).toBe('allow');
    expect(session.reason).toBe('OK');
  });

  it('says why a class-specific field decision cannot be made from a help request (ENTL-05)', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/HELP/run`,
      headers: { cookie: env.pm.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { view: 'function', code: 'DES', assetClass: 'equity' },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json<{
      data: HelpPayload;
      meta: { unavailable: { field: string; reason: string; detail: string }[] };
    }>();
    if (body.data.view !== 'function') throw new Error('expected the function view');

    // `PX_LAST` is Cboe on an equity and CoinGecko on a coin, so rule 1 cannot key on a class
    // the request never supplied. The row renders with its licence and the gap is explained,
    // which is the difference between "we do not know" and "you are blocked".
    const last = body.data.function.fields.find((f) => f.id === 'PX_LAST')!;
    expect(last.reason).toBe('FIELD_UNKNOWN');
    const note = body.meta.unavailable.find((u) => u.field === 'fields.decision');
    expect(note?.reason).toBe('NOT_APPLICABLE');
    expect(note?.detail).toContain('asset class');
  });

  it('describes a variant the manifest does not cover, and says why it was rejected', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/HELP/run`,
      headers: { cookie: env.pm.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { view: 'function', code: 'SECF', assetClass: 'equity' },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json<{
      data: HelpPayload;
      meta: { unavailable: { field: string; reason: string; detail: string }[] };
    }>();

    // SECF takes no security at all, so an asset class does not apply to it — and HELP still
    // answers, because "why was my command rejected" is exactly what the user pressed F1 to ask.
    expect(body.data.view).toBe('function');
    expect(SECF.assetClasses).toBe('none');
    const note = body.meta.unavailable.find((u) => u.field === 'function');
    expect(note?.reason).toBe('NOT_APPLICABLE');
    expect(note?.detail).toContain('SECF does not apply to equity');
    for (const entry of body.meta.unavailable) {
      expect(['NO_SOURCE', 'NOT_LICENSED', 'NOT_APPLICABLE']).toContain(entry.reason);
    }
  });

  it('404s an unknown code, exactly as the runner does for an unknown function', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/HELP/run`,
      headers: { cookie: env.pm.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { view: 'function', code: 'ZZZ' },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('FUNCTION_NOT_FOUND');
  });

  it('ranks search hits: an exact code first, then substrings, then trigrams', async () => {
    const payload = await runHelp({ view: 'search', query: 'DES' });
    if (payload.view !== 'search') throw new Error(`expected the search view, got ${payload.view}`);

    expect(payload.query).toBe('DES');
    expect(payload.hits.length).toBeGreaterThan(0);
    // The exact code is the top hit, and nothing else can reach its score.
    expect(payload.hits[0]!.kind).toBe('function');
    expect(payload.hits[0]!.id).toBe('DES');
    expect(payload.hits[0]!.score).toBe(1);
    for (const hit of payload.hits.slice(1)) expect(hit.score).toBeLessThan(1);
    // Descending, always: the list is what the screen renders top to bottom.
    for (let i = 1; i < payload.hits.length; i += 1) {
      expect(payload.hits[i - 1]!.score).toBeGreaterThanOrEqual(payload.hits[i]!.score);
    }
    expect(payload.hits.length).toBeLessThanOrEqual(25);
  });

  it('searches the field dictionary as well as the manifests', async () => {
    const payload = await runHelp({ view: 'search', query: 'dividend' });
    if (payload.view !== 'search') throw new Error(`expected the search view, got ${payload.view}`);

    const kinds = new Set(payload.hits.map((h) => h.kind));
    expect(kinds.has('field')).toBe(true);
    const yieldHit = payload.hits.find((h) => h.id === 'DVD_YIELD');
    expect(yieldHit).toBeDefined();
    // The snippet marks the matched span, which is what makes a hit explicable in the CSV too.
    expect(yieldHit!.snippet.toLowerCase()).toContain('dividend');
  });

  it('says so when nothing matches, rather than showing an empty list', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/HELP/run`,
      headers: { cookie: env.pm.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { view: 'search', query: 'zzqqxx' },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json<{
      data: HelpPayload;
      meta: { unavailable: { field: string; reason: string; detail: string }[] };
    }>();
    if (body.data.view !== 'search') throw new Error('expected the search view');
    expect(body.data.hits).toEqual([]);
    const note = body.meta.unavailable.find((u) => u.field === 'hits');
    expect(note?.reason).toBe('NO_SOURCE');
    expect(note?.detail).toContain('zzqqxx');
  });

  it('opens a ticket with its helpdesk room, its members and its usage event (TERM-09)', async () => {
    const traceId = randomUUID();
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/help/tickets`,
      headers: { cookie: env.pm.cookie, 'x-requested-with': 'terminal' },
      payload: {
        panelId: 'p1',
        functionCode: 'DES',
        params: { tab: 'filings' },
        screenState: { fields: ['PX_LAST', 'CHG_PCT_1D'], provIdx: [0, 0] },
        traceId,
        question: 'Why is the bid blank on this screen?',
      },
    });
    expect(res.statusCode, res.payload).toBe(201);
    const { ticketId, roomId } = res.json<{ ticketId: number; roomId: number }>();
    expect(ticketId).toBeGreaterThan(0);
    expect(roomId).toBeGreaterThan(0);

    // The row carries the evidence: what the user was looking at when they asked.
    const ticket = await t.client.query<{
      user_id: string;
      firm_id: string;
      function_code: string | null;
      panel_id: string | null;
      screen_state: { fields: string[]; provIdx: number[] };
      params: { tab: string } | null;
      trace_id: string;
      status: string;
      room_id: string | null;
    }>(
      `SELECT user_id, firm_id, function_code, panel_id, screen_state, params, trace_id::text AS trace_id,
              status, room_id
         FROM help_tickets WHERE ticket_id = $1`,
      [ticketId],
    );
    expect(ticket.rowCount).toBe(1);
    const row = ticket.rows[0]!;
    expect(Number(row.user_id)).toBe(env.pm.userId);
    expect(Number(row.firm_id)).toBe(env.firmId);
    expect(row.function_code).toBe('DES');
    expect(row.panel_id).toBe('p1');
    expect(row.screen_state.fields).toEqual(['PX_LAST', 'CHG_PCT_1D']);
    expect(row.params).toEqual({ tab: 'filings' });
    expect(row.trace_id).toBe(traceId);
    expect(row.status).toBe('open');
    expect(Number(row.room_id)).toBe(roomId);

    // The room is a real conversation, not a placeholder: kind `helpdesk`, the author and the
    // firm's desk staff in it.
    const room = await t.client.query<{ kind: string; firm_id: string; name: string }>(
      `SELECT kind, firm_id, name FROM rooms WHERE room_id = $1`,
      [roomId],
    );
    expect(room.rows[0]!.kind).toBe('helpdesk');
    expect(Number(room.rows[0]!.firm_id)).toBe(env.firmId);
    expect(room.rows[0]!.name).toContain('DES');

    const members = await t.client.query<{ user_id: string }>(
      `SELECT user_id FROM room_members WHERE room_id = $1 ORDER BY user_id`,
      [roomId],
    );
    const memberIds = members.rows.map((m) => Number(m.user_id)).sort((a, b) => a - b);
    expect(memberIds).toEqual([env.pm.userId, env.desk.userId].sort((a, b) => a - b));

    // FUNC-04: which screens people ask about is the other half of which screens people use.
    const usage = await t.client.query<{ kind: string; code: string | null; details: unknown }>(
      `SELECT kind, code, details FROM usage_events WHERE trace_id = $1::uuid AND kind = 'ticket.open'`,
      [traceId],
    );
    expect(usage.rowCount).toBe(1);
    expect(usage.rows[0]!.code).toBe('DES');
    expect(usage.rows[0]!.details).toMatchObject({ ticketId, roomId });
  });

  it('lists the caller’s own tickets, and the whole firm’s for the desk', async () => {
    const open = async (who: Principal, question: string): Promise<number> => {
      const res = await env.app.inject({
        method: 'POST',
        url: `${API}/help/tickets`,
        headers: { cookie: who.cookie, 'x-requested-with': 'terminal' },
        payload: { screenState: {}, question },
      });
      expect(res.statusCode, res.payload).toBe(201);
      return res.json<{ ticketId: number }>().ticketId;
    };

    const mine = await open(env.pm, 'Mine');
    const theirs = await open(env.desk, 'Theirs');

    const asPm = await runHelp({ view: 'tickets' }, env.pm);
    if (asPm.view !== 'tickets') throw new Error('expected the tickets view');
    expect(asPm.tickets.map((x) => x.ticketId)).toEqual([mine]);
    expect(asPm.tickets[0]!.status).toBe('open');
    expect(asPm.tickets[0]!.roomId).not.toBeNull();

    const asDesk = await runHelp({ view: 'tickets' }, env.desk);
    if (asDesk.view !== 'tickets') throw new Error('expected the tickets view');
    const deskIds = asDesk.tickets.map((x) => x.ticketId).sort((a, b) => a - b);
    expect(deskIds).toEqual([mine, theirs].sort((a, b) => a - b));
  });

  it('states that there is no staffed desk, every time the queue is shown (BRIEF §1)', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/HELP/run`,
      headers: { cookie: env.pm.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { view: 'tickets' },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const meta = res.json<{ meta: { unavailable: { field: string; reason: string }[] } }>().meta;
    const note = meta.unavailable.find((u) => u.field === 'tickets');
    expect(note?.reason).toBe('NOT_APPLICABLE');
  });

  it('subscribes to nothing: HELP carries no market data', () => {
    expect(HELP.live).toBeNull();
    expect(HELP.fieldIds(null)).toEqual([]);
    expect(HELP.assetClasses).toBe('none');
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    // The `function` view of DES/equity rather than the index: the index is a projection of the
    // registry, so it moves with every manifest WP-10 and WP-11 add, and a golden that has to be
    // regenerated on unrelated work stops being read. The function view is the payload a user
    // actually reads — the parameter table, the field rows with their licence attribution and the
    // caller's own entitlement decision — and it is the one HELP can get quietly wrong.
    const payload = await runHelp({ view: 'function', code: 'DES', assetClass: 'equity' });
    expectGolden('HELP.default.json', payload);
  });
});
