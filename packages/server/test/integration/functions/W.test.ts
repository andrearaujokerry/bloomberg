/**
 * `test/integration/functions/W.test.ts` — the watchlist screen, and CHRT-07's two computed shapes.
 *
 * W has no acceptance row of its own in WORKPLAN §WP-09's table; what it has is the requirement
 * the table's other rows do not cover — CHRT-07 — and that is what this file is about. The fixture
 * carries both computed shapes at once, because they are the two things people confuse:
 *
 *  - a **formula column** (`c1 = PX_LAST/PX_CLOSE_1D-1`) is evaluated once per row, over *that
 *    row's own* cells. It is a different number on every line of the grid.
 *  - a **formula row** (`RATIO(AAPL US Equity, MSFT US Equity)`) is one expression over *other
 *    securities*. It belongs to no instrument: `instrumentId` is `0`, `subject` is `''`, and what
 *    it carries instead is `deps` — the subjects it reads, which is what the screen subscribes to
 *    so the cell recomputes on every input tick rather than on a re-run.
 *
 * And a third thing, which is the one that decides whether anybody edits a formula twice: a
 * **broken formula is not an error**. `c2 = PX_LAST/` lands in `formulaErrors[]`, its own cells go
 * `na`, and every other cell on the grid still paints.
 *
 * Visibility is asserted from the other side as well: a second list, owned by a colleague and
 * shared firm-wide, is visible with `isOwner: false` — which is what disables every mutation on it
 * (SEC-05).
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden, subjectToken } from './golden.js';

import type { NormalisedUpdate, QuoteFields } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { W } from '@terminal/core/functions/manifests/W';
import type { WPayload } from '@terminal/core/functions/manifests/W';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as WModule from '../../../src/functions/W/resolve.js';
import { parseSubject } from '../../../src/plant/subjects.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS, seedQuoteInstrument } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';

/**
 * `md_lines_symbol_excl` makes `(source_id, provider_symbol)` a GLOBAL namespace — "a provider
 * symbol feeds at most one line at a time" — and `server-int` runs four forks against one
 * database. Two open transactions inserting the same symbol therefore wait on each other's
 * exclusion check, and two such waits in opposite order are a deadlock. Every symbol this file
 * seeds carries a per-run suffix so no other suite can ever be on the other side of that wait.
 * The suffix is invisible to the payload: no monitor row carries a provider symbol.
 */
const SYMBOL_TAG = `.t${randomUUID().slice(0, 8)}`;
const sym = (base: string): string => `${base}${SYMBOL_TAG}`;

const GOLDEN_NAME = 'W.default.json';

const REGISTRY = new FunctionRegistry([W]);

const MODULES: Record<string, FunctionServerModule<any, any>> = { W: WModule };

/** The two prices the formula column is arithmetic over. */
const AAPL_LAST = 330.27;
const AAPL_CLOSE = 333.08;
const MSFT_LAST = 505.5;
const MSFT_CLOSE = 500;

const t: TestDb = withTxDb();

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  userId: number;
  mineId: number;
  sharedId: number;
  aapl: number;
  msft: number;
  nvda: number;
}

let env: Env;

async function ensureLicences(): Promise<void> {
  const present = await t.client.query(
    `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
  );
  if (present.rowCount === 0) await seedLicences(t.client);
}

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

function quote(
  instrumentId: number,
  mdLineId: number,
  provenanceId: number,
  fields: Partial<QuoteFields>,
): NormalisedUpdate {
  return {
    subject: `q:${String(instrumentId)}`,
    instrumentId,
    mdLineId,
    assetClass: 'equity',
    tier: 'delayed',
    fields,
    ts: { src: GOLDEN_CAPTURE_MS - 900_000, cap: GOLDEN_CAPTURE_MS, pub: 0 },
    prov: { sourceId: 'cboe.quotes', provenanceId },
  };
}

beforeEach(async () => {
  await ensureLicences();

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`W Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const [userId, colleagueId] = await Promise.all(
    ['W User', 'W Colleague'].map(async (name) => {
      const res = await t.client.query<{ user_id: string }>(
        `INSERT INTO users (firm_id, email, display_name, role)
         VALUES ($1, $2, $3, 'user') RETURNING user_id`,
        [firmId, `w-${randomUUID()}@demo.invalid`, name],
      );
      return Number(res.rows[0]!.user_id);
    }),
  );
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId!, createHash('sha256').update(token, 'utf8').digest()],
  );
  await grantEverySource(firmId, userId!);

  const aapl = await seedQuoteInstrument(t, {
    ticker: 'AAPL',
    name: 'Apple Inc',
    providerSymbol: sym('AAPL'),
  });
  const msft = await seedQuoteInstrument(t, {
    ticker: 'MSFT',
    name: 'Microsoft Corp',
    providerSymbol: sym('MSFT'),
  });
  const nvda = await seedQuoteInstrument(t, {
    ticker: 'NVDA',
    name: 'NVIDIA Corp',
    providerSymbol: sym('NVDA'),
  });

  // `c1` is the day's return over the row's own cells; `c2` does not parse, which is the case the
  // grid has to survive rather than refuse.
  const columns = [
    { id: 'PX_LAST' },
    { id: 'PX_CLOSE_1D' },
    { id: 'c1', formula: 'PX_LAST/PX_CLOSE_1D-1', label: 'Chg', decimals: 6 },
    { id: 'c2', formula: 'PX_LAST/', label: 'Broken' },
  ];
  const mine = await t.client.query<{ watchlist_id: string }>(
    `INSERT INTO watchlists (owner_user_id, firm_id, name, columns, sort, group_by, shared_scope)
     VALUES ($1, $2, 'MAG3', $3::jsonb, $4::jsonb, NULL, 'private') RETURNING watchlist_id`,
    [userId!, firmId, JSON.stringify(columns), JSON.stringify([{ col: 'PX_LAST', dir: 'desc' }])],
  );
  const mineId = Number(mine.rows[0]!.watchlist_id);
  for (const [position, seeded] of [aapl, msft, nvda].entries()) {
    await t.client.query(
      `INSERT INTO watchlist_items (watchlist_id, position, instrument_id, note)
       VALUES ($1, $2, $3, $4)`,
      [mineId, position, seeded.instrumentId, position === 0 ? 'core holding' : null],
    );
  }
  await t.client.query(
    `INSERT INTO watchlist_items (watchlist_id, position, formula, label)
     VALUES ($1, 3, 'RATIO(AAPL US Equity, MSFT US Equity)', 'AAPL/MSFT')`,
    [mineId],
  );

  const shared = await t.client.query<{ watchlist_id: string }>(
    `INSERT INTO watchlists (owner_user_id, firm_id, name, columns, sort, group_by, shared_scope)
     VALUES ($1, $2, 'Desk core', $3::jsonb, '[]'::jsonb, NULL, 'firm') RETURNING watchlist_id`,
    [colleagueId!, firmId, JSON.stringify([{ id: 'PX_LAST' }])],
  );
  const sharedId = Number(shared.rows[0]!.watchlist_id);
  await t.client.query(
    `INSERT INTO watchlist_items (watchlist_id, position, instrument_id) VALUES ($1, 0, $2)`,
    [sharedId, aapl.instrumentId],
  );

  const quoteProv = await bootstrapProvenance(t, 'cboe.quotes', 'w-quote');
  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };
  harness.deps.plant.apply(
    quote(aapl.instrumentId, aapl.mdLineId, quoteProv, {
      PX_LAST: AAPL_LAST,
      PX_CLOSE_1D: AAPL_CLOSE,
    }),
  );
  harness.deps.plant.apply(
    quote(msft.instrumentId, msft.mdLineId, quoteProv, {
      PX_LAST: MSFT_LAST,
      PX_CLOSE_1D: MSFT_CLOSE,
    }),
  );
  // NVDA is never polled: its formula cells must be `na`, not zero.

  env = {
    harness,
    app: harness.app,
    clock,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    knownAt,
    userId: userId!,
    mineId,
    sharedId,
    aapl: aapl.instrumentId,
    msft: msft.instrumentId,
    nvda: nvda.instrumentId,
  };
});

afterEach(async () => {
  await env.harness.close();
});

async function runW(params: Record<string, unknown> = {}): Promise<WPayload> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/W/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<{ data: WPayload }>().data;
}

function normalise(payload: WPayload): unknown {
  const tokens = new Map<number, string>([
    [env.aapl, '<AAPL>'],
    [env.msft, '<MSFT>'],
    [env.nvda, '<NVDA>'],
    [env.mineId, '<MINE>'],
    [env.sharedId, '<SHARED>'],
    [env.userId, '<ME>'],
  ]);
  const json = JSON.stringify(payload, (key, value: unknown) => {
    // The firm id, the colleague's user id and `updatedAt` are the row's own sequence values and
    // wall-clock instants: normalised to a token rather than asserted, because a golden that
    // pinned them would be a golden of one run.
    if (key === 'firmId' || key === 'ownerUserId' || key === 'updatedAt' || key === 'addedAt') {
      return typeof value === 'number' && tokens.has(value) ? tokens.get(value) : '<VOLATILE>';
    }
    if (typeof value === 'number' && tokens.has(value)) return tokens.get(value);
    // Only a subject string carries an id (`subjectToken`); substituting anywhere in any string
    // made the golden a function of the sequence values this run drew.
    if (typeof value === 'string') return subjectToken(value, tokens);
    return value;
  });
  return JSON.parse(json);
}

describe('W — watchlists, formula columns and formula rows', () => {
  it('lists every visible watchlist and opens the caller’s own by default', async () => {
    const payload = await runW();

    expect(payload.me.userId).toBe(env.userId);
    expect(payload.watchlists.map((w) => w.name).sort()).toEqual(['Desk core', 'MAG3']);

    const shared = payload.watchlists.find((w) => w.name === 'Desk core')!;
    expect(shared.isOwner).toBe(false);
    expect(shared.sharedScope).toBe('firm');
    expect(shared.itemCount).toBe(1);
    expect(shared.ownerDisplay).toBe('W Colleague');

    // No `watchlist` param: the caller's own most recently updated list, never a colleague's.
    expect(payload.active?.watchlistId).toBe(env.mineId);
    expect(payload.active?.isOwner).toBe(true);
    expect(payload.active?.sort).toEqual([{ col: 'PX_LAST', dir: 'desc' }]);
  });

  it('opens a colleague’s shared list read-only', async () => {
    const payload = await runW({ watchlist: { name: 'Desk core' } });
    expect(payload.active?.watchlistId).toBe(env.sharedId);
    expect(payload.active?.isOwner).toBe(false);
  });

  it('evaluates a formula column over each row’s own cells (CHRT-07)', async () => {
    const payload = await runW();
    const rows = payload.active!.rows;

    const aapl = rows.find((r) => r.instrumentId === env.aapl)!;
    const msft = rows.find((r) => r.instrumentId === env.msft)!;
    const nvda = rows.find((r) => r.instrumentId === env.nvda)!;

    expect(aapl.cells.PX_LAST?.v).toBe(AAPL_LAST);
    expect(aapl.cells.c1?.v).toBeCloseTo(AAPL_LAST / AAPL_CLOSE - 1, 12);
    expect(msft.cells.c1?.v).toBeCloseTo(MSFT_LAST / MSFT_CLOSE - 1, 12);

    // A row with no quote has no inputs, so the computed cell is `na` — never 0, which would read
    // as "unchanged on the day".
    expect(nvda.cells.PX_LAST?.st).toBe('blank');
    expect(nvda.cells.c1?.v).toBeNull();
    expect(nvda.cells.c1?.st).toBe('na');
  });

  it('evaluates a formula row over other securities and records its deps', async () => {
    const payload = await runW();
    const formulaRow = payload.active!.rows.find((r) => r.formula !== null)!;

    expect(formulaRow.formula).toBe('RATIO(AAPL US Equity, MSFT US Equity)');
    // No instrument of its own: it is an expression, not a security.
    expect(formulaRow.instrumentId).toBe(0);
    expect(formulaRow.subject).toBe('');
    expect(formulaRow.cells.PX_LAST?.v).toBeCloseTo(AAPL_LAST / MSFT_LAST, 12);
    expect(formulaRow.cells.PX_CLOSE_1D?.v).toBeCloseTo(AAPL_CLOSE / MSFT_CLOSE, 12);

    // The subjects the screen has to follow for the cell to recompute.
    expect(formulaRow.deps.sort()).toEqual(
      [`q:${String(env.aapl)}`, `q:${String(env.msft)}`].sort(),
    );
    for (const subject of formulaRow.deps) {
      expect(parseSubject(subject)?.family, subject).toBe('q');
    }
  });

  it('reports a broken formula once and keeps the grid', async () => {
    const payload = await runW();
    const errors = payload.active!.formulaErrors;

    expect(errors.filter((e) => e.where === 'c2')).toHaveLength(1);
    expect(errors.find((e) => e.where === 'c2')?.message).toMatch(/./);
    expect(errors.some((e) => e.where === 'c1')).toBe(false);

    for (const row of payload.active!.rows) {
      expect(row.cells.c2?.v).toBeNull();
      expect(row.cells.c2?.st).toBe('na');
    }
    // The rest of the grid is unaffected — which is the whole claim.
    const aapl = payload.active!.rows.find((r) => r.instrumentId === env.aapl)!;
    expect(aapl.cells.PX_LAST?.v).toBe(AAPL_LAST);
  });

  it('answers 404 for a list that does not exist or is not visible', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/W/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { watchlist: { name: 'Nobody else' } },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('subscribes to every plain row and to every formula dependency', async () => {
    const payload = await runW();
    const live = W.live!({ view: 'grid' }, payload)!;

    // Three securities; the formula row adds no subject of its own, only its two dependencies —
    // which are already in the list, so the set is exactly the three plain subjects.
    expect(live.subjects.sort()).toEqual(
      [`q:${String(env.aapl)}`, `q:${String(env.msft)}`, `q:${String(env.nvda)}`].sort(),
    );
    expect(live.subjects).not.toContain('');
    for (const subject of live.subjects) {
      expect(parseSubject(subject)?.family, subject).toBe('q');
    }
    expect(live.fields).toContain('PX_LAST');
    expect(live.fields).toContain('PX_CLOSE_1D');
    expect(live.conflationMs).toBe(250);
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    const payload = await runW();
    expectGolden(GOLDEN_NAME, normalise(payload));
  });
});
