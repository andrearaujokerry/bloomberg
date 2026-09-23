/**
 * `test/integration/functions/QM.test.ts` — WP-09's acceptance row for `QM`
 * (WORKPLAN §WP-09: "live grid payload over a watchlist and over index members; `LiveSpec.subjects`
 * are valid `q:` subjects").
 *
 * The fixture is deliberately **half polled**: one of the three securities has a quote in the plant
 * and two do not. That is the state a monitor is in for most of its life, and the two rows it
 * produces have to be told apart by a reader:
 *
 *  - a **pending** cell is `{ st:'blank', provIdx:-1 }` with **no reason code**, because nothing was
 *    denied and nothing is missing upstream — the scheduler has simply not polled that subject yet,
 *    and the WebSocket `snap` fills it (§0.4 rule 1);
 *  - a **denied** cell is `{ st:'blank', r:'…' }`, which says the caller's entitlements are short.
 *
 * Rendering the first as the second tells a user to call support about a contract that is fine.
 * This file asserts the distinction by value, on both the cells and `counts.pending`.
 *
 * `LiveSpec.subjects` is validated with `plant/subjects.ts#parseSubject` rather than a regular
 * expression written here: a regex in a test is a second opinion about the wire format, and the
 * gateway will not accept a subject this file's regex happens to like.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden, idToken, subjectToken } from './golden.js';

import type { NormalisedUpdate } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { QM } from '@terminal/core/functions/manifests/QM';
import type { QmPayload } from '@terminal/core/functions/manifests/QM';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import * as QMModule from '../../../src/functions/QM/resolve.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import { parseSubject } from '../../../src/plant/subjects.js';
import { upsertIndex, upsertMember } from '../../../src/refdata/indexMembership.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS, seedQuoteInstrument } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const MEMBERSHIP_DATE = '2026-09-14';

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

const GOLDEN_NAME = 'QM.default.json';

const REGISTRY = new FunctionRegistry([QM]);

const MODULES: Record<string, FunctionServerModule<any, any>> = { QM: QMModule };

const t: TestDb = withTxDb();

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  userId: number;
  watchlistId: number;
  indexInstrumentId: number;
  indexCode: string;
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

function quote(instrumentId: number, mdLineId: number, provenanceId: number): NormalisedUpdate {
  return {
    subject: `q:${String(instrumentId)}`,
    instrumentId,
    mdLineId,
    assetClass: 'equity',
    tier: 'delayed',
    fields: {
      PX_LAST: 330.27,
      PX_BID: 330.25,
      PX_ASK: 330.28,
      BID_SIZE: 40,
      ASK_SIZE: 120,
      PX_HIGH: 331.59,
      PX_LOW: 328.35,
      PX_CLOSE_1D: 333.08,
      PX_VOLUME: 16_591_786,
    },
    ts: { src: GOLDEN_CAPTURE_MS - 900_000, cap: GOLDEN_CAPTURE_MS, pub: 0 },
    prov: { sourceId: 'cboe.quotes', provenanceId, srcSeq: 15_972_883_317 },
  };
}

beforeEach(async () => {
  await ensureLicences();

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`QM Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'QM User', 'user') RETURNING user_id`,
    [firmId, `qm-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  await grantEverySource(firmId, userId);

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
  const spx = await seedQuoteInstrument(t, {
    ticker: 'SPX',
    name: 'S&P 500',
    assetClass: 'index',
    providerSymbol: sym('_SPX'),
  });

  // AAPL carries a GICS classification; the other two do not, so `gicsSector` is a real null
  // rather than a column that happens to be filled everywhere.
  const gicsProv = await bootstrapProvenance(t, 'wiki.sp500', 'qm-gics');
  // `classification_schemes` and `classification_codes` are shared tables and `server-int` runs
  // four forks against one database: a read first means the common case takes no lock at all,
  // while a database without the scheme still gets one (the pattern `ensureLicences` uses).
  const scheme = await t.client.query(`SELECT 1 FROM classification_schemes WHERE scheme = 'GICS'`);
  if (scheme.rowCount === 0) {
    await t.client.query(
      `INSERT INTO classification_schemes (scheme, name, source_id, levels)
       VALUES ('GICS', 'GICS', 'wiki.sp500', 4) ON CONFLICT (scheme) DO NOTHING`,
    );
  }
  // Real Estate rather than Information Technology, for a reason that has nothing to do with the
  // assertion: `functions/reference-routes.test.ts` seeds the `45` subtree, and two forks writing
  // the same `classification_codes` key block each other for the length of a test.
  const codes = await t.client.query(
    `SELECT 1 FROM classification_codes WHERE scheme = 'GICS' AND code = '60102010'`,
  );
  if (codes.rowCount === 0) {
    await t.client.query(
      `INSERT INTO classification_codes (scheme, code, name, parent_code, level)
       VALUES ('GICS', '60', 'Real Estate', NULL, 1),
              ('GICS', '60102010', 'Diversified REITs', '60', 4)
         ON CONFLICT (scheme, code) DO NOTHING`,
    );
  }
  await t.client.query(
    `INSERT INTO entity_classifications
       (entity_kind, entity_id, scheme, code, valid_from, provenance_id)
     VALUES ('instrument', $1, 'GICS', '60102010', timestamptz '2020-01-01', $2)`,
    [aapl.instrumentId, gicsProv],
  );

  // The watchlist: three securities in position order plus one CHRT-07 formula row, which QM
  // reports as skipped rather than rendering — a formula row is a W concept (§QM step 1).
  const list = await t.client.query<{ watchlist_id: string }>(
    `INSERT INTO watchlists (owner_user_id, firm_id, name, columns, sort, group_by)
     VALUES ($1, $2, 'MAG3', $3::jsonb, '[]'::jsonb, NULL) RETURNING watchlist_id`,
    [userId, firmId, JSON.stringify([{ id: 'PX_LAST' }, { id: 'CHG_PCT_1D' }])],
  );
  const watchlistId = Number(list.rows[0]!.watchlist_id);
  for (const [position, instrumentId] of [aapl, msft, nvda].entries()) {
    await t.client.query(
      `INSERT INTO watchlist_items (watchlist_id, position, instrument_id) VALUES ($1, $2, $3)`,
      [watchlistId, position, instrumentId.instrumentId],
    );
  }
  await t.client.query(
    `INSERT INTO watchlist_items (watchlist_id, position, formula, label)
     VALUES ($1, 3, 'RATIO(AAPL US Equity, SPX Index)', 'AAPL/SPX')`,
    [watchlistId],
  );

  // The index: SPX with two constituents, weighted, from a real membership source.
  const memberProv = await bootstrapProvenance(t, 'ssga.holdings', 'qm-members');
  // `indices.code` is UNIQUE and every integration file runs in its own transaction against one
  // database: a fixed code would collide with `functions/WEI.test.ts`, which owns the real index
  // codes. The code is generated and carried in `env`, so the assertions read it rather than
  // repeat it (the same rule `refdata/indexMembership.test.ts` follows).
  const indexCode = `QMX${randomUUID().slice(0, 4).toUpperCase()}`;
  const index = await upsertIndex(t.db, {
    code: indexCode,
    instrumentId: spx.instrumentId,
    proxyFundInstrumentId: null,
    membershipSourceId: 'ssga.holdings',
    provider: 'S&P Dow Jones',
  });
  for (const [instrumentId, weight] of [
    [aapl.instrumentId, '0.0721000000'],
    [msft.instrumentId, '0.0630000000'],
  ] as const) {
    await upsertMember(t.db, {
      indexId: index.indexId,
      instrumentId,
      weight,
      asOfDate: MEMBERSHIP_DATE,
      sourceId: 'ssga.holdings',
      provenanceId: memberProv,
    });
  }

  const quoteProv = await bootstrapProvenance(t, 'cboe.quotes', 'qm-quote');
  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };
  // Only AAPL has been polled. MSFT and NVDA are pending, which is the point.
  harness.deps.plant.apply(quote(aapl.instrumentId, aapl.mdLineId, quoteProv));

  env = {
    harness,
    app: harness.app,
    clock,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    knownAt,
    userId,
    watchlistId,
    indexInstrumentId: spx.instrumentId,
    indexCode,
    aapl: aapl.instrumentId,
    msft: msft.instrumentId,
    nvda: nvda.instrumentId,
  };
});

afterEach(async () => {
  await env.harness.close();
});

async function runQM(params: Record<string, unknown> = {}): Promise<QmPayload> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/QM/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<{ data: QmPayload }>().data;
}

/**
 * The keys of a QM payload that hold a sequence-allocated id: each row's `instrumentId`, and the
 * source block's bare `id` — the watchlist's (§QM `QmSource`). A column's `id` is a field name
 * (`'PX_LAST'`) and a string, so the key alone is not the test: `idToken` rewrites numbers only.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['id', 'instrumentId']);

function normalise(payload: QmPayload): unknown {
  const tokens = new Map<number, string>([
    [env.aapl, '<AAPL>'],
    [env.msft, '<MSFT>'],
    [env.nvda, '<NVDA>'],
    [env.indexInstrumentId, '<SPX>'],
    [env.watchlistId, '<WATCHLIST>'],
  ]);
  const json = JSON.stringify(payload, (key, value: unknown) => {
    if (typeof value === 'string') {
      // Only a subject string carries an id (`subjectToken`); substituting anywhere in any string
      // made the golden a function of the sequence values this run drew.
      return subjectToken(value, tokens);
    }
    // And a number is an id only under a key that names one. The grid is bids, asks, sizes,
    // volumes and highs; `BID_SIZE: 400` and a watchlist id of 400 are the same number and not
    // the same thing.
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

describe('QM — the live grid', () => {
  it('renders a watchlist in position order, polled and pending rows side by side', async () => {
    const payload = await runQM({ source: { kind: 'watchlist', name: 'MAG3' } });

    expect(payload.variant).toBe('default');
    expect(payload.source.kind).toBe('watchlist');
    expect(payload.title).toBe('MAG3');
    expect(payload.rows.map((r) => r.key)).toEqual([
      'AAPL US Equity',
      'MSFT US Equity',
      'NVDA US Equity',
    ]);
    expect(payload.rows[0]?.gicsSector).toBe('Real Estate');
    expect(payload.rows[1]?.gicsSector).toBeNull();

    // The polled row.
    const aapl = payload.rows[0]!;
    expect(aapl.cells.PX_LAST?.v).toBe(330.27);
    expect(aapl.cells.PX_LAST?.st).toBe('live');
    expect(aapl.cells.PX_LAST?.provIdx).toBeGreaterThanOrEqual(0);

    // The pending rows: no value, no reason, no provenance — and still a live registration, which
    // is what lets the first `snap` fill them without re-running the function.
    for (const row of payload.rows.slice(1)) {
      const cell = row.cells.PX_LAST!;
      expect(cell.v).toBeNull();
      expect(cell.st).toBe('blank');
      expect(cell.provIdx).toBe(-1);
      expect(cell.r).toBeUndefined();
      expect(cell.live).toEqual({ subject: row.subject, field: 'PX_LAST' });
    }
    expect(payload.counts).toEqual({ rows: 3, live: 12, pending: 2, stale: 0, blank: 0 });

    // The formula row is reported, not silently dropped.
    expect(payload.skipped).toEqual([
      { ref: 'RATIO(AAPL US Equity, SPX Index)', reason: 'FORMULA_ROW' },
    ]);
  });

  it('renders index members in weight order with the membership date and source', async () => {
    const payload = await runQM({ source: { kind: 'index', id: env.indexInstrumentId } });

    expect(payload.source.kind).toBe('index');
    expect(payload.source.asOfDate).toBe(MEMBERSHIP_DATE);
    expect(payload.source.sourceId).toBe('ssga.holdings');
    expect(payload.title).toBe(
      `${env.indexCode} Index members (${MEMBERSHIP_DATE}, ssga.holdings)`,
    );
    expect(payload.rows.map((r) => r.instrumentId)).toEqual([env.aapl, env.msft]);
    expect(payload.rows[0]?.cells.PX_LAST?.v).toBe(330.27);
  });

  it('resolves a bare name that is an index code rather than a watchlist', async () => {
    const payload = await runQM({ source: { kind: 'watchlist', name: env.indexCode } });
    expect(payload.source.kind).toBe('index');
    expect(payload.rows).toHaveLength(2);
  });

  it('answers 404 for a name that is neither a watchlist nor an index', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/QM/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { source: { kind: 'watchlist', name: 'NOPE' } },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('declares a LiveSpec whose every subject parses as a q: subject', async () => {
    for (const source of [
      { kind: 'watchlist', name: 'MAG3' },
      { kind: 'index', id: env.indexInstrumentId },
    ]) {
      const payload = await runQM({ source });
      const params = {
        source,
        columns: [...QM.params.shape.columns.parse(undefined)],
        groupBy: 'none' as const,
      };
      const live = QM.live!(params as never, payload)!;

      expect(live.subjects.length).toBe(payload.rows.length);
      for (const subject of live.subjects) {
        const parsed = parseSubject(subject);
        expect(parsed, subject).not.toBeNull();
        expect(parsed!.family).toBe('q');
      }
      expect(new Set(live.subjects).size).toBe(live.subjects.length);
      expect(live.conflationMs).toBe(250);
      // Every live field is a column of the grid — a subscription never asks for a field the
      // screen has nowhere to put.
      for (const field of live.fields as string[]) {
        expect(payload.columns.map((c) => c.id)).toContain(field);
      }
    }
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    const payload = await runQM({ source: { kind: 'watchlist', name: 'MAG3' } });
    expectGolden(GOLDEN_NAME, normalise(payload));
  });
});
