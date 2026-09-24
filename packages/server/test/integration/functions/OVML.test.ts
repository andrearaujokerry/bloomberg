/**
 * `test/integration/functions/OVML.test.ts` — WP-11's acceptance rows for `OVML`
 * (golden payloads for both variants; `meta.engines[]` present with a stable `inputsHash` across
 * two runs — ANAL-08).
 *
 * ## Both variants, one chain
 *
 * `runCboeOptions` ingests the recorded AAPL capture exactly as production would: 3,510 contracts,
 * one quote each, at the capture's own instant. The `contract` variant is then launched on the
 * minted `AAPL260916C00245000`, and the `underlying` variant on AAPL itself, so the two payloads
 * are two readings of the same stored chain rather than two fixtures that happen to agree.
 *
 * ## What the four assertions are for
 *
 *  1. **The terms and the market block are the capture's.** Every number in `market` is compared
 *     with the row in `fixtures/providers/raw/cboe-options` it came from. A resolver that silently
 *     re-derived a provider greek would pass every other test in this file.
 *  2. **The published inputs reproduce the published price.** The test re-runs `option.tree` with
 *     the `(S, K, r, q, σ, T)` the payload *printed* and expects the payload's own `results.price`.
 *     That is not a second model — it is the check that the screen's inputs are the inputs the
 *     screen was priced on, which is what makes `meta.engines[].inputsHash` worth anything.
 *  3. **ANAL-08 determinism.** Two runs at the same explicit `asOf` are compared byte for byte,
 *     payload and `meta.engines` alike. A resolver that reached for the wall clock, iterated a map
 *     in insertion order that depends on a sequence, or seeded a simulation from anything but
 *     `params.seed` fails here and nowhere else.
 *  4. **The underlying variant's pick is the documented rule** — nearest unexpired expiry, then the
 *     strike closest to spot — with the available expiries and strikes recorded for the screen's
 *     pickers.
 *
 * No seed is assumed (WP-15 owns it), and no assertion depends on a literal instrument id: the
 * contract is found through its OCC identifier, which is what the chain is keyed by.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PayloadMeta } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { treeEngine } from '@terminal/core/analytics/options/tree';
import { XCBO } from '@terminal/core/calendars/nyse';
import { OVML } from '@terminal/core/functions/manifests/OVML';
import type { OvmlPayload } from '@terminal/core/functions/manifests/OVML';

import { PARTITIONED_TABLES } from '../../../src/db/partitions.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as OVMLModule from '../../../src/functions/OVML/resolve.js';
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
const VINTAGE = '2026-09-15T10:00:00.000Z';
const CURVE_DATE = '2026-09-14';

/** The pinned contract of FUNCTIONS_TIER3 §0: spot 330.30, strike 245, a day to expiry. */
const OCC = 'AAPL260916C00245000';
const FRONT_EXPIRY = '2026-09-16';
const SPOT = 330.3;

/** Whole-year tenors only: `curve.ois.bootstrap` schedules each quote as an annual-pay swap. */
const OIS_QUOTES: readonly [string, number, number][] = [
  ['1Y', 365, 3.42],
  ['2Y', 730, 3.38],
  ['3Y', 1096, 3.4],
  ['5Y', 1826, 3.45],
  ['10Y', 3653, 3.7],
  ['30Y', 10958, 4.05],
];
const ON_FIXING_PCT = 3.62;

const REGISTRY = new FunctionRegistry([OVML]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { OVML: OVMLModule };

const t: TestDb = withTxDb();
const replay = openReplayStore();

/** `fixtures/providers/raw/cboe-options`, for the row-by-row comparison. */
interface RawChain {
  data: {
    current_price: number;
    options: {
      option: string;
      bid: number;
      ask: number;
      iv: number;
      delta: number;
      gamma: number;
      vega: number;
      theta: number;
      rho: number;
      theo: number;
      volume: number;
      open_interest: number;
      last_trade_price: number;
      prev_day_close: number;
    }[];
  };
}

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  underlyingId: number;
  contractId: number;
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

async function lockMarketTables(): Promise<void> {
  const tables = PARTITIONED_TABLES.filter(
    (table) => table !== 'access_log' && table !== 'usage_events',
  );
  await t.client.query(`LOCK TABLE ${tables.join(', ')} IN ROW EXCLUSIVE MODE`);
}

/** The `SOFR_OIS` curve OVML takes `r` from — proxied, which is why every payload says so. */
async function seedSofrOis(): Promise<void> {
  await t.client.query(
    `INSERT INTO curves (curve_id, name, currency, kind, day_count, compounding, source_id,
                         default_interpolation)
     VALUES ('SOFR_OIS', 'USD SOFR OIS (proxied)', 'USD', 'ois', 'ACT/360', 'simple',
             'internal.derived', 'monotone_convex')
     ON CONFLICT (curve_id) DO NOTHING`,
  );
  const provenanceId = await bootstrapProvenance(t, 'internal.derived', 'ovml-ois');
  const rows: [string, string, number, number][] = [
    ['ON', 'fixing', 1, ON_FIXING_PCT],
    ...OIS_QUOTES.map(
      ([tenor, days, value]) => [tenor, 'ois_rate', days, value] as [string, string, number, number],
    ),
  ];
  for (const [tenor, quoteType, tenorDays, value] of rows) {
    await t.client.query(
      `INSERT INTO curve_points (curve_id, curve_date, tenor, quote_type, vintage_at, tenor_days,
                                 value, is_latest, provenance_id)
       VALUES ('SOFR_OIS', $1::date, $2, $3, $4::timestamptz, $5, $6, true, $7)`,
      [CURVE_DATE, tenor, quoteType, VINTAGE, tenorDays, value, provenanceId],
    );
  }
}

async function seedUnderlying(): Promise<number> {
  const repos = masterRepositories(t.db);
  const provenanceId = await bootstrapProvenance(t, 'internal.user', 'ovml-master');
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
  await repos.mdLines.upsertBySymbol(
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
  return instrumentId;
}

beforeEach(async () => {
  await ensureLicences();
  await materialiseCalendar(t.db, XCBO, { fromYear: 2026, toYear: 2027 });
  await lockMarketTables();

  const session = await createWebSession(t, { email: `ovml-${randomUUID()}@demo.invalid` });
  await grantEverySource(session.firmId, session.userId);

  const underlyingId = await seedUnderlying();
  await seedSofrOis();

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };

  const result = await runCboeOptions({
    tx: t.db,
    clock,
    replay,
    plant: harness.deps.plant,
    symbols: ['AAPL'],
    log: {},
  });
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);

  // The contract is found through its OCC identifier, which is the key the chain is minted under.
  const minted = await t.client.query<{ entity_id: string }>(
    `SELECT entity_id FROM identifiers
      WHERE scheme = 'OCC' AND entity_kind = 'instrument' AND value = $1 AND tx_to = 'infinity'`,
    [OCC],
  );
  expect(minted.rowCount, `${OCC} was not minted`).toBe(1);

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  env = {
    harness,
    app: harness.app,
    clock,
    cookie: session.cookie,
    knownAt,
    underlyingId,
    contractId: Number(minted.rows[0]!.entity_id),
    raw: await readRawJson<RawChain>('cboe-options'),
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: OvmlPayload;
  meta: PayloadMeta;
}

async function runOVML(
  instrumentId: number,
  params: Record<string, unknown> = {},
): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/OVML/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params,
      security: { id: instrumentId },
      asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

const rawRow = (occ: string): RawChain['data']['options'][number] => {
  const row = env.raw.data.options.find((o) => o.option === occ);
  expect(row, `${occ} is not in the capture`).toBeDefined();
  return row!;
};

const numOf = (cell: { v: unknown }): number => {
  expect(typeof cell.v, JSON.stringify(cell)).toBe('number');
  return cell.v as number;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('OVML — one listed contract, valued through the engines', () => {
  it('returns the capture’s terms and market block unchanged', async () => {
    const { data, meta } = await runOVML(env.contractId);
    expect(data.variant).toBe('contract');

    expect(data.contract.occSymbol).toBe(OCC);
    expect(data.contract.key).toBe('AAPL 9/16/26 C245 Equity');
    expect(data.contract.strike).toBe(245);
    expect(data.contract.putCall).toBe('C');
    expect(data.contract.expiry).toBe(FRONT_EXPIRY);
    expect(data.contract.expiryTs).toBe('2026-09-16T20:00:00.000Z');
    expect(data.contract.multiplier).toBe(100);
    expect(data.contract.exerciseStyle).toBe('american');

    const raw = rawRow(OCC);
    expect(numOf(data.market.bid)).toBe(raw.bid);
    expect(numOf(data.market.ask)).toBe(raw.ask);
    expect(numOf(data.market.mid)).toBeCloseTo((raw.bid + raw.ask) / 2, 12);
    expect(numOf(data.market.volume)).toBe(raw.volume);
    expect(numOf(data.market.openInterest)).toBe(raw.open_interest);
    // The adapter normalises the fractional contract `iv`: 2.3515 → 235.15 percent.
    expect(numOf(data.market.providerIvPct)).toBeCloseTo(raw.iv * 100, 10);
    expect(numOf(data.market.providerDelta)).toBe(raw.delta);
    expect(numOf(data.market.providerTheo)).toBe(raw.theo);
    expect(numOf(data.underlying.px)).toBe(SPOT);

    // A published greek is the provider's and cites the capture; nothing re-derives it.
    expect(meta.provenance[data.market.provIdx]?.sourceId).toBe('cboe.options');
    // `meta.tier` is the LOWEST tier cited, and OVML cites an end-of-day SOFR OIS build alongside
    // the delayed chain. A payload that claimed `delayed` while resting on an eod rate would be
    // overstating how fresh it is; `meta.provenance` still names the chain as the market's source.
    expect(meta.tier).toBe('eod');
    expect(data.caveats).toContain('VANILLA_ONLY_NO_EXOTICS');
    expect(data.caveats).toEqual(expect.arrayContaining(['PROXY_CURVE', 'NO_FUTURES_SOURCE']));
  });

  it('prices the contract on the inputs it publishes (ANAL-08)', async () => {
    const { data, meta } = await runOVML(env.contractId);

    // The default model for an American contract is a 500-step CRR tree.
    expect(data.inputs.model).toBe('crr');
    expect(data.inputs.style).toBe('american');
    expect(data.inputs.steps).toBe(500);
    expect(data.inputs.rateSource).toBe('SOFR_OIS');
    expect(data.inputs.rateCurveDate).toBe(CURVE_DATE);
    expect(data.inputs.divSource).toBe('none');
    expect(data.caveats).toContain('NO_DIVIDEND_HISTORY');

    // ACT/365F from the frozen clock to 16:00 ET on the expiry: about one day.
    expect(data.inputs.years).toBeCloseTo(0.00288914, 8);
    expect(data.inputs.days).toBe(1);

    // Re-run the engine on the inputs the payload PRINTED. This is what ties the screen's
    // numbers to its own stated assumptions: a resolver that priced on a different spot, rate or
    // vol than it displayed would disagree here while looking perfectly consistent elsewhere.
    const reprice = treeEngine(
      {
        S: numOf(data.inputs.spot),
        K: data.contract.strike,
        r: numOf(data.inputs.ratePct) / 100,
        q: numOf(data.inputs.divYieldPct) / 100,
        sigma: numOf(data.inputs.volPct) / 100,
        T: data.inputs.years,
        steps: data.inputs.steps!,
        type: 'call',
        exercise: 'american',
        method: 'crr',
      },
      data.inputs.valuationTs,
    );
    expect(numOf(data.results.price)).toBeCloseTo(reprice.outputs.price, 12);
    expect(numOf(data.results.delta)).toBeCloseTo(reprice.outputs.delta, 12);

    // The engine that produced the headline number is named, versioned and hashed.
    const names = meta.engines.map((e) => e.name);
    expect(names).toContain('option.tree');
    expect(names).toContain('curve.ois.bootstrap');
    const treeEntry = meta.engines.find(
      (e) => e.name === 'option.tree' && e.inputsHash === reprice.inputsHash,
    );
    expect(treeEntry, 'the payload does not cite the run that produced its price').toBeDefined();
    expect(treeEntry!.version).toBe('1.0.0');
    for (const engine of meta.engines) expect(engine.inputsHash).toMatch(/^[0-9a-f]{64}$/);

    // Every finite cell cites a provenance row that exists (DATA-10); the runner asserts it too.
    expect(data.results.price.provIdx).toBeGreaterThanOrEqual(0);
    expect(meta.provenance[data.results.price.provIdx]).toBeDefined();
  });

  it('states intrinsic, time value and breakeven consistently with the price', async () => {
    const { data } = await runOVML(env.contractId);
    const spot = numOf(data.inputs.spot);
    const price = numOf(data.results.price);

    expect(numOf(data.results.intrinsic)).toBeCloseTo(Math.max(spot - 245, 0), 12);
    expect(numOf(data.results.timeValue)).toBeCloseTo(price - numOf(data.results.intrinsic), 12);
    expect(numOf(data.results.breakeven)).toBeCloseTo(245 + price, 12);
    expect(numOf(data.results.moneynessPct)).toBeCloseTo(100 * (spot / 245 - 1), 12);

    // Per contract: per-share numbers × multiplier × contracts, and nothing else.
    const scale = data.contract.multiplier * data.results.perContract.contracts;
    expect(numOf(data.results.perContract.premium)).toBeCloseTo(price * scale, 10);
    expect(numOf(data.results.perContract.deltaShares)).toBeCloseTo(
      numOf(data.results.delta) * scale,
      10,
    );

    // A deep in-the-money contract: the provider's own delta is 0.9999 and the vol is meaningless.
    expect(data.caveats).toContain('DEEP_ITM_IV_UNRELIABLE');

    // The scenario matrix and the greeks profile are the same engine at shocked states.
    expect(data.scenario.cells).toHaveLength(
      data.scenario.spotPct.length * data.scenario.volPts.length,
    );
    const base = data.scenario.cells.find((c) => c.spotPct === 0 && c.volPts === 0);
    expect(base).toBeDefined();
    expect(base!.price).toBeCloseTo(price, 12);
    expect(base!.pnl).toBeCloseTo(0, 10);
    expect(data.greeksProfile).toHaveLength(21);
    expect(data.greeksProfile[0]!.spot).toBeCloseTo(spot * 0.8, 10);
    expect(data.greeksProfile[20]!.spot).toBeCloseTo(spot * 1.2, 10);
  });

  it('quotes a volga the payload’s own scenario grid corroborates', async () => {
    const { data } = await runOVML(env.contractId);

    // The contract is priced on a 500-step CRR lattice, whose price is a sawtooth in sigma: a
    // second difference over ±1 vol point measures the grid rather than the option. It came back
    // at −1.5e-09 per vol point² where the closed form for the same state says +8.6e-05 — wrong
    // sign, five orders of magnitude small. The grid the screen already shows is the check.
    const priceAt = (volPts: number): number => {
      const cell = data.scenario.cells.find((c) => c.spotPct === 0 && c.volPts === volPts);
      expect(cell, `no scenario cell at volPts ${String(volPts)}`).toBeDefined();
      return cell!.price;
    };
    expect(data.scenario.volPts).toEqual([-5, 0, 5]);
    const grid = (priceAt(5) - 2 * priceAt(0) + priceAt(-5)) / 5 ** 2;
    const volga = numOf(data.results.volga);

    expect(Math.sign(volga)).toBe(Math.sign(grid));
    expect(Math.abs(volga)).toBeGreaterThan(1e-6);
    expect(volga / grid).toBeCloseTo(1, 6);
  });

  it('is byte-identical on two runs at the same asOf (ANAL-08)', async () => {
    const first = await runOVML(env.contractId);
    const second = await runOVML(env.contractId);
    expect(JSON.stringify(second.data)).toBe(JSON.stringify(first.data));
    expect(second.meta.engines).toEqual(first.meta.engines);
  });

  it('picks the nearest expiry and the strike closest to spot on the underlying', async () => {
    const { data } = await runOVML(env.underlyingId);
    expect(data.variant).toBe('underlying');
    if (data.variant !== 'underlying') throw new Error('unreachable');

    expect(data.picked.rule).toBe('nearest_expiry_then_strike_nearest_spot');
    expect(data.picked.expiry).toBe(FRONT_EXPIRY);
    expect(data.picked.putCall).toBe('C');

    // The listed call strikes of the front expiry, straight from the capture.
    const strikes = env.raw.data.options
      .filter((o) => o.option.startsWith('AAPL260916C'))
      .map((o) => Number(o.option.slice(-8)) / 1000)
      .sort((a, b) => a - b);
    let nearest = strikes[0]!;
    for (const strike of strikes) {
      if (Math.abs(strike - SPOT) < Math.abs(nearest - SPOT)) nearest = strike;
    }
    expect(data.picked.strike).toBe(nearest);
    expect(data.contract.strike).toBe(nearest);
    expect(data.picked.strikesAvailable).toEqual(strikes);
    expect(data.picked.expiriesAvailable[0]?.expiry).toBe(FRONT_EXPIRY);

    // An at-the-money contract has a usable implied vol, unlike the pinned deep-ITM one.
    expect(data.inputs.volSource).toBe('solved');
    expect(numOf(data.results.impliedVolPct)).toBeGreaterThan(0);
  });

  it('values at a volatility the caller supplies', async () => {
    const { data } = await runOVML(env.underlyingId, { vol: 28, model: 'bsm', style: 'european' });
    expect(data.inputs.volSource).toBe('user');
    expect(numOf(data.inputs.volPct)).toBe(28);
    expect(data.inputs.model).toBe('bsm');
    expect(data.inputs.steps).toBeNull();
    expect(numOf(data.results.vega)).toBeGreaterThan(0);
  });

  it('matches the committed goldens', async () => {
    const contract = await runOVML(env.contractId);
    expectGolden('OVML.contract.json', normalise(contract.data));
    const underlying = await runOVML(env.underlyingId);
    expectGolden('OVML.underlying.json', normalise(underlying.data));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Golden normalisation — by KEY, never by value (WP-10)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The payload keys that hold a sequence-allocated instrument id. */
const ID_KEYS: ReadonlySet<string> = new Set([
  'instrumentId',
  'underlyingInstrumentId',
]);

function normalise(payload: OvmlPayload): unknown {
  const tokens = new Map<number, string>([
    [payload.contract.instrumentId, `<${payload.contract.occSymbol}>`],
    [payload.underlying.instrumentId, '<AAPL>'],
  ]);
  return JSON.parse(
    JSON.stringify(payload, (key, value: unknown) => {
      if (typeof value === 'string') return subjectToken(value, tokens);
      return idToken(key, value, ID_KEYS, tokens);
    }),
  ) as unknown;
}
