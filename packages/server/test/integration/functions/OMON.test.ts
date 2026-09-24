/**
 * `test/integration/functions/OMON.test.ts` — WP-11's acceptance row for `OMON`
 * ("chain from `cboe-options` (3,510 contracts) grouped by expiry with ATM identified; put-call
 * ratio matches a hand count").
 *
 * ## The chain is the recorded capture, ingested by the real job
 *
 * Nothing here hand-writes an `option_terms` row. `runCboeOptions` reads
 * `fixtures/providers/raw/cboe-options` through the replay store and mints the same 3,510
 * instruments, identifiers, terms and quotes it would mint in production, at the capture's own
 * `capturedAt` (2026-09-15T18:40:39Z, from `fixtures/providers/manifest.json`). A chain assembled
 * by the test instead would prove that the resolver agrees with the test's idea of a chain, which
 * is the one thing nobody needs to know.
 *
 * ## The hand count is the point of the file
 *
 * `putCallVolumeRatio` is asserted against a count this file performs **on the raw capture**:
 * parse every OCC symbol, keep the front expiry, sum `volume` by side, divide. That count shares
 * no code with the resolver — not the parser, not the normaliser, not the data service, not the
 * summing — so an agreement is evidence about the number rather than about a shared helper. The
 * same count is repeated for open interest and for the contract totals, because a ratio can be
 * right while both of its inputs are wrong.
 *
 * ## What the golden pins
 *
 * `fixtures/golden/functions/OMON.underlying.json`, at the frozen clock, with the sequence-
 * allocated instrument ids tokenised **by key** (`idToken`) and inside subjects (`subjectToken`) —
 * never by value, which is the defect WP-10 closed across 25 files.
 *
 * No seed is assumed (WP-15 owns it): every firm, user, grant, instrument and md line lives inside
 * this file's own `withTxDb()` transaction, and no assertion depends on a literal instrument id.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PayloadMeta } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { XCBO } from '@terminal/core/calendars/nyse';
import { OMON } from '@terminal/core/functions/manifests/OMON';
import type { OmonLeg, OmonPayload } from '@terminal/core/functions/manifests/OMON';

import { PARTITIONED_TABLES } from '../../../src/db/partitions.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as OMONModule from '../../../src/functions/OMON/resolve.js';
import { runCboeOptions } from '../../../src/ingest/jobs/cboeOptions.js';
import { openReplayStore } from '../../../src/providers/replayStore.js';
import { materialiseCalendar } from '../../../src/refdata/calendars.js';
import { masterRepositories } from '../../../src/refdata/master.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { readRawJson } from '../../../src/test/fixtures.js';
import { bootstrapProvenance, createWebSession, GOLDEN_CAPTURE_MS } from '../ws/helpers.js';
import { expectGolden, idToken, subjectToken } from './golden.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = new Date('2020-01-01T00:00:00Z');
const GOLDEN_NAME = 'OMON.underlying.json';

/** The front expiry of the recorded AAPL chain, and the underlying print it was quoted against. */
const FRONT_EXPIRY = '2026-09-16';
const CAPTURE_TS = '2026-09-15T18:40:39.000Z';
const SPOT = 330.3;

const REGISTRY = new FunctionRegistry([OMON]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { OMON: OMONModule };

const t: TestDb = withTxDb();
const replay = openReplayStore();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The hand count, straight off the raw capture
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `fixtures/providers/raw/cboe-options` as Cboe published it. */
interface RawChain {
  timestamp: string;
  data: {
    current_price: number;
    iv30: number;
    options: {
      option: string;
      bid: number | null;
      ask: number | null;
      iv: number | null;
      delta: number | null;
      theo: number | null;
      volume: number | null;
      open_interest: number | null;
      last_trade_price: number | null;
      prev_day_close: number | null;
    }[];
  };
}

/**
 * The OCC symbol, split by hand: `AAPL260916C00245000` → root, expiry, side, strike.
 *
 * Deliberately not `providers/cboe/parse.ts`'s parser. The resolver's numbers travel through that
 * module, so a count that reused it would agree with the resolver about the symbols by
 * construction and prove only that the summing matched.
 */
function splitOcc(symbol: string): { expiry: string; side: 'C' | 'P'; strike: number } {
  const tail = symbol.slice(-15);
  const expiry = `20${tail.slice(0, 2)}-${tail.slice(2, 4)}-${tail.slice(4, 6)}`;
  const side = tail.charAt(6) === 'P' ? 'P' : 'C';
  return { expiry, side, strike: Number(tail.slice(7)) / 1000 };
}

interface HandCount {
  callVolume: number;
  putVolume: number;
  callOi: number;
  putOi: number;
  contracts: number;
  strikes: number[];
}

/** Sum the front expiry by side, from the capture, with nothing of the resolver's involved. */
function handCount(raw: RawChain, expiry: string): HandCount {
  const count: HandCount = {
    callVolume: 0,
    putVolume: 0,
    callOi: 0,
    putOi: 0,
    contracts: 0,
    strikes: [],
  };
  const strikes = new Set<number>();
  for (const row of raw.data.options) {
    const occ = splitOcc(row.option);
    if (occ.expiry !== expiry) continue;
    count.contracts += 1;
    strikes.add(occ.strike);
    if (occ.side === 'C') {
      count.callVolume += row.volume ?? 0;
      count.callOi += row.open_interest ?? 0;
    } else {
      count.putVolume += row.volume ?? 0;
      count.putOi += row.open_interest ?? 0;
    }
  }
  count.strikes = [...strikes].sort((a, b) => a - b);
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  instrumentId: number;
  mdLineId: number;
  raw: RawChain;
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

/**
 * Every partitioned parent this file writes, locked in `PARTITIONED_TABLES` order before the
 * ingest job needs any of them — the same cycle-avoidance `marketDataJobs.test.ts` documents.
 */
async function lockMarketTables(): Promise<void> {
  const tables = PARTITIONED_TABLES.filter(
    (table) => table !== 'access_log' && table !== 'usage_events',
  );
  await t.client.query(`LOCK TABLE ${tables.join(', ')} IN ROW EXCLUSIVE MODE`);
}

/** AAPL and its `cboe.options` line, through WP-04's repositories. */
async function seedUnderlying(): Promise<{ instrumentId: number; mdLineId: number }> {
  const repos = masterRepositories(t.db);
  const provenanceId = await bootstrapProvenance(t, 'internal.user', 'omon-master');
  const o = { validFrom: VALID_FROM, provenanceId };

  const issuerId = await repos.issuers.insert({ name: 'Apple Inc' }, o);
  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass: 'equity',
      securityType: 'Common Stock',
      name: 'Apple Inc',
      currency: 'USD',
    },
    o,
  );
  const instrumentId = await repos.instruments.insert(
    {
      issueId,
      assetClass: 'equity',
      marketSector: 'Equity',
      ticker: 'AAPL',
      exchCode: 'US',
      name: 'Apple Inc',
      currency: 'USD',
    },
    o,
  );
  const { mdLineId } = await repos.mdLines.upsertBySymbol(
    {
      instrumentId,
      sourceId: 'cboe.options',
      providerSymbol: 'AAPL',
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 60_000,
      priority: 20,
    },
    o,
  );
  return { instrumentId, mdLineId };
}

beforeEach(async () => {
  await ensureLicences();
  // The ladder reaches 2029-01-19, and `days` counts XCBO business days to each listed expiry.
  await materialiseCalendar(t.db, XCBO, { fromYear: 2026, toYear: 2029 });
  await lockMarketTables();

  const session = await createWebSession(t, { email: `omon-${randomUUID()}@demo.invalid` });
  await grantEverySource(session.firmId, session.userId);

  const seeded = await seedUnderlying();
  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };

  // The real job, over the recorded capture: 3,510 contracts, one quote each, and the underlying
  // block published to the same plant the resolver reads.
  const result = await runCboeOptions({
    tx: t.db,
    clock,
    replay,
    plant: harness.deps.plant,
    symbols: ['AAPL'],
    log: {},
  });
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  env = {
    harness,
    app: harness.app,
    clock,
    cookie: session.cookie,
    knownAt,
    instrumentId: seeded.instrumentId,
    mdLineId: seeded.mdLineId,
    raw: await readRawJson<RawChain>('cboe-options'),
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: OmonPayload;
  meta: PayloadMeta;
}

async function runOMON(params: Record<string, unknown> = {}): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/OMON/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params,
      security: { id: env.instrumentId },
      asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

const legOf = (payload: OmonPayload, strike: number, side: 'call' | 'put'): OmonLeg => {
  const row = payload.rows.find((r) => r.strike === strike);
  expect(row, `strike ${String(strike)} is not in the window`).toBeDefined();
  const leg = row![side];
  expect(leg, `strike ${String(strike)} has no ${side}`).not.toBeNull();
  return leg!;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('OMON — the recorded Cboe chain, grouped by expiry', () => {
  it('ingests all 3,510 contracts and groups them into the listed expiry ladder', async () => {
    const stored = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM option_terms WHERE underlying_instrument_id = $1`,
      [env.instrumentId],
    );
    expect(Number(stored.rows[0]!.n)).toBe(3510);

    const { data } = await runOMON();

    // The ladder the capture carries, in order, with the front expiry selected by default.
    const ladder = new Map<string, number>();
    for (const row of env.raw.data.options) {
      const occ = splitOcc(row.option);
      ladder.set(occ.expiry, (ladder.get(occ.expiry) ?? 0) + 1);
    }
    expect(data.expiries.map((e) => e.expiry)).toEqual([...ladder.keys()].sort());
    expect(data.expiries.map((e) => e.contractCount)).toEqual(
      [...ladder.keys()].sort().map((e) => ladder.get(e)),
    );
    expect(data.expiries.reduce((n, e) => n + e.contractCount, 0)).toBe(3510);
    expect(data.selected.expiry).toBe(FRONT_EXPIRY);
    expect(data.expiries.filter((e) => e.isSelected).map((e) => e.expiry)).toEqual([FRONT_EXPIRY]);
    expect(data.captureTs).toBe(CAPTURE_TS);
  });

  it('identifies the ATM row and windows 21 strikes around it', async () => {
    const { data } = await runOMON();
    const count = handCount(env.raw, FRONT_EXPIRY);

    // The ATM strike is the listed strike nearest the capture's own underlying print.
    let expectedAtm = count.strikes[0]!;
    for (const strike of count.strikes) {
      if (Math.abs(strike - SPOT) < Math.abs(expectedAtm - SPOT)) expectedAtm = strike;
    }
    expect(data.selected.atmStrike).toBe(expectedAtm);
    expect(data.rows).toHaveLength(21);
    expect(data.rows.filter((r) => r.isAtm).map((r) => r.strike)).toEqual([expectedAtm]);

    const index = count.strikes.indexOf(expectedAtm);
    expect(data.rows.map((r) => r.strike)).toEqual(count.strikes.slice(index - 10, index + 11));
    expect(data.selected.contractCount).toBe(count.contracts);
  });

  it('reports a put-call ratio that matches a hand count of the capture', async () => {
    const { data } = await runOMON();
    const count = handCount(env.raw, FRONT_EXPIRY);

    // Both inputs first: a ratio can be right while its numerator and denominator are both wrong.
    expect(data.selected.totals.callVolume.v).toBe(count.callVolume);
    expect(data.selected.totals.putVolume.v).toBe(count.putVolume);
    expect(data.selected.totals.callOi.v).toBe(count.callOi);
    expect(data.selected.totals.putOi.v).toBe(count.putOi);

    expect(data.selected.putCallVolumeRatio.v).toBeCloseTo(
      count.putVolume / count.callVolume,
      12,
    );
    expect(data.selected.putCallOiRatio.v as number).toBeCloseTo(count.putOi / count.callOi, 12);

    // The totals are the WHOLE expiry, not the 21 strikes on screen.
    const windowedVolume = data.rows.reduce(
      (sum, row) => sum + ((row.call?.volume.v as number | null) ?? 0),
      0,
    );
    expect(windowedVolume).toBeLessThan(count.callVolume);
  });

  it('publishes Cboe’s greeks as Cboe’s, and derives only mid', async () => {
    const { data, meta } = await runOMON();
    const atm = data.selected.atmStrike!;
    const call = legOf(data, atm, 'call');
    const put = legOf(data, atm, 'put');

    const rawCall = env.raw.data.options.find((o) => {
      const occ = splitOcc(o.option);
      return occ.expiry === FRONT_EXPIRY && occ.side === 'C' && occ.strike === atm;
    })!;

    expect(call.bid.v).toBe(rawCall.bid);
    expect(call.ask.v).toBe(rawCall.ask);
    expect(call.delta.v).toBe(rawCall.delta);
    expect(call.theo.v).toBe(rawCall.theo);
    expect(call.openInterest.v).toBe(rawCall.open_interest);
    expect(call.volume.v).toBe(rawCall.volume);
    // The adapter normalises the fractional contract `iv` to percent; the ATM pair averages.
    expect(call.ivPct.v as number).toBeCloseTo((rawCall.iv ?? 0) * 100, 10);
    expect(data.selected.atmIvPct.v as number).toBeCloseTo(
      ((call.ivPct.v as number) + (put.ivPct.v as number)) / 2,
      10,
    );

    // `mid` is the only derived price on a leg, and it cites the capture both its sides came from.
    expect(call.mid.v as number).toBeCloseTo(((rawCall.bid ?? 0) + (rawCall.ask ?? 0)) / 2, 12);
    expect(call.mid.provIdx).toBe(call.bid.provIdx);
    const cited = meta.provenance[call.provIdx];
    expect(cited?.sourceId).toBe('cboe.options');
    expect(meta.tier).toBe('delayed');
    expect(data.delayMin).toBe(15);

    // No pricing engine ran: the only engine on this screen is the smile fit.
    expect(meta.engines.map((e) => e.name)).toEqual(['vol.surface']);
  });

  it('marks deep in-the-money implied vols and keeps them out of the fit', async () => {
    const { data } = await runOMON();
    const suspect = data.rows.flatMap((row) =>
      [row.call, row.put].flatMap((leg) => (leg?.ivSuspect === true ? [leg.key] : [])),
    );
    expect(suspect.length).toBeGreaterThan(0);
    expect(data.caveats).toContain('DEEP_ITM_IV_UNRELIABLE');
    expect(data.caveats).toEqual(
      expect.arrayContaining(['DELAYED_15MIN', 'PROVIDER_GREEKS_CBOE', 'NO_OPRA_DEPTH']),
    );

    // A suspect leg keeps its published number and is excluded from the plotted smile.
    for (const row of data.rows) {
      const point = data.smile.points.find((p) => p.strike === row.strike);
      if (row.call?.ivSuspect === true) expect(point?.callIvPct ?? null).toBeNull();
      if (row.put?.ivSuspect === true) expect(point?.putIvPct ?? null).toBeNull();
    }
    expect(data.smile.svi).not.toBeNull();
    expect(data.smile.sviSource).toBe('fit');
    expect(data.smile.sviUnavailableReason).toBe('SURFACE_STORE_NOT_IMPLEMENTED');
    expect(data.caveats).toContain('SURFACE_NOT_STORED');
  });

  it('pages forward to the next listed expiry and refuses a delisted cursor', async () => {
    const first = await runOMON();
    expect(first.meta.page?.index).toBe(0);
    const cursor = first.meta.page?.cursor ?? null;
    expect(cursor).not.toBeNull();
    expect(JSON.parse(Buffer.from(cursor!, 'base64url').toString('utf8'))).toEqual({
      expiry: FRONT_EXPIRY,
    });

    const second = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/OMON/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { expiry: first.data.expiries[1]!.expiry },
        security: { id: env.instrumentId },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(second.statusCode, second.payload).toBe(200);
    const next = second.json<Run>();
    expect(next.data.selected.expiry).toBe(first.data.expiries[1]!.expiry);
    expect(next.meta.page?.index).toBe(1);

    const bad = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/OMON/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { expiry: '2030-01-18' },
        security: { id: env.instrumentId },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    // §OMON writes "422 VALIDATION_FAILED"; the landed wire contract maps `VALIDATION_FAILED`
    // to 400 (`sdk/wire/envelope.ts` `ERROR_CODE_STATUS`), and the code is what a client switches
    // on. The status follows the code, so the code is what this asserts.
    expect(bad.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
    expect(bad.statusCode).toBe(400);
  });

  it('matches the committed golden', async () => {
    const { data } = await runOMON();
    expectGolden(GOLDEN_NAME, normalise(data));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Golden normalisation — by KEY, never by value (WP-10)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The payload keys that hold a sequence-allocated instrument id. */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId']);

function normalise(payload: OmonPayload): unknown {
  const tokens = new Map<number, string>();
  tokens.set(payload.underlying.instrumentId, '<AAPL>');
  for (const row of payload.rows) {
    for (const leg of [row.call, row.put]) {
      if (leg !== null) tokens.set(leg.instrumentId, `<${leg.occSymbol}>`);
    }
  }
  return JSON.parse(
    JSON.stringify(payload, (key, value: unknown) => {
      if (typeof value === 'string') return subjectToken(value, tokens);
      return idToken(key, value, ID_KEYS, tokens);
    }),
  ) as unknown;
}
