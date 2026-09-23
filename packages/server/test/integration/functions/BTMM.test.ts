/**
 * `test/integration/functions/BTMM.test.ts` — WP-10's acceptance row for `BTMM`
 * ("policy range, SOFR/EFFR with percentiles, bills, CMT and spreads on one payload from the
 * seeded fixings").
 *
 * The whole page comes off one run, because that is what the acceptance row is: a rates desk opens
 * BTMM once in the morning and every block has to be there. So this file seeds one morning —
 * Monday 2026-09-14's NY Fed fixings, Friday 2026-09-11's Treasury par and bill curves with
 * Thursday 2026-09-10 behind them for the change column, the H.15 constant-maturity 10Y, the FOMC
 * calendar and six delayed context quotes — and asserts the single payload that comes back.
 *
 * Three things are asserted *because they are the ways this screen goes quietly wrong*:
 *
 *  1. **SOFRAI is not a rate.** The SOFR averages index has no daily rate and no percentiles
 *     (PROVIDERS §10.4). Its `rate`, `p*` and `volumeBn` cells must be `na` with a
 *     `NOT_APPLICABLE` note and its averages must still be there. A zero would print a 0.00 %
 *     overnight rate.
 *  2. **A spread is never computed from a partial pair.** Deleting the 2Y par point must make
 *     `2s10s` `na` with a `NO_SOURCE` note and leave `3m10y` computed — not `2s10s = 4.07`.
 *  3. **Every finite number cites a provenance row** and every null has a reason (DATA-10,
 *     FUNCTIONS.md §1.3 rule 6). The runner enforces this, so a payload that broke it would 500;
 *     the explicit assertion is here so the failure names the cell instead of the request.
 *
 * No seed is assumed and nothing asserts on a literal instrument id: WP-15 owns the seed and it is
 * not written, so every row lives inside `withTxDb()`'s transaction.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NormalisedUpdate, PayloadMeta, QuoteFields } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { USGOVT } from '@terminal/core/calendars/usgovt';
import { BTMM } from '@terminal/core/functions/manifests/BTMM';
import type {
  BtmmPayload,
  CurvePointRow,
  RateFixingRow,
  SpreadRow,
} from '@terminal/core/functions/manifests/BTMM';

import * as BTMMModule from '../../../src/functions/BTMM/resolve.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import { materialiseCalendar } from '../../../src/refdata/calendars.js';
import { masterRepositories } from '../../../src/refdata/master.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, createWebSession, GOLDEN_CAPTURE_MS } from '../ws/helpers.js';
import { expectGolden, idToken, subjectToken } from './golden.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = new Date('2020-01-01T00:00:00Z');
const GOLDEN_NAME = 'BTMM.default.json';

/** `md_lines_symbol_excl` is a global namespace; a per-run suffix keeps two files off one key. */
const SYMBOL_TAG = `.t${randomUUID().slice(0, 8)}`;

const REGISTRY = new FunctionRegistry([BTMM]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { BTMM: BTMMModule };

const t: TestDb = withTxDb();

/** The morning this file seeds. 2026-09-14 is a Monday; the curves are Friday's close. */
const FIXING_DATE = '2026-09-14';
const PRIOR_FIXING_DATE = '2026-09-11';
/** The SOFR averages index is published the morning after the rates it averages. */
const SOFRAI_DATE = '2026-09-15';
const CURVE_DATE = '2026-09-11';
const COMPARE_CURVE_DATE = '2026-09-10';
const VINTAGE = '2026-09-15T10:00:00.000Z';

interface SeededInstrument {
  instrumentId: number;
  mdLineId: number;
}

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  billId: number;
  context: Record<string, SeededInstrument>;
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

async function seedInstrument(spec: {
  ticker: string;
  name: string;
  assetClass: 'fx' | 'index' | 'govt';
  marketSector: 'Curncy' | 'Index' | 'Govt';
  exchCode: string;
  securityType: string;
  sourceId: string;
  providerSymbol: string;
}): Promise<SeededInstrument> {
  const repos = masterRepositories(t.db);
  const provenanceId = await bootstrapProvenance(t, 'internal.user', `btmm-${spec.ticker}`);
  await bootstrapProvenance(t, spec.sourceId, `btmm-src-${spec.ticker}`);
  const o = { validFrom: VALID_FROM, provenanceId };

  const issuerId = await repos.issuers.insert({ name: `${spec.name} issuer` }, o);
  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass: spec.assetClass,
      securityType: spec.securityType,
      name: spec.name,
      currency: 'USD',
    },
    o,
  );
  const instrumentId = await repos.instruments.insert(
    {
      issueId,
      assetClass: spec.assetClass,
      marketSector: spec.marketSector,
      ticker: spec.ticker,
      exchCode: spec.exchCode,
      name: spec.name,
      currency: 'USD',
      searchWeight: 50,
    },
    o,
  );
  const { mdLineId } = await repos.mdLines.upsertBySymbol(
    {
      instrumentId,
      sourceId: spec.sourceId,
      providerSymbol: `${spec.providerSymbol}${SYMBOL_TAG}`,
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 10_000,
      priority: 10,
    },
    o,
  );
  return { instrumentId, mdLineId };
}

function quote(
  seeded: SeededInstrument,
  assetClass: 'fx' | 'index',
  sourceId: string,
  provenanceId: number,
  fields: Partial<QuoteFields>,
): NormalisedUpdate {
  return {
    subject: `q:${String(seeded.instrumentId)}`,
    instrumentId: seeded.instrumentId,
    mdLineId: seeded.mdLineId,
    assetClass,
    tier: 'delayed',
    fields,
    ts: { src: GOLDEN_CAPTURE_MS - 900_000, cap: GOLDEN_CAPTURE_MS, pub: 0 },
    prov: { sourceId, provenanceId },
  };
}

interface FixingSpec {
  code: string;
  effectiveDate: string;
  rate: number | null;
  pct?: [number, number, number, number];
  volumeBn?: number;
  target?: [number, number];
  averages?: [number, number, number, number];
}

async function seedFixing(spec: FixingSpec, provenanceId: number): Promise<void> {
  await t.client.query(
    `INSERT INTO rate_fixings (rate_code, effective_date, vintage_at, rate, pct_1, pct_25, pct_75,
                               pct_99, volume_bn, target_from, target_to, avg_30d, avg_90d,
                               avg_180d, index_value, revision_indicator, is_latest, provenance_id)
     VALUES ($1, $2::date, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             '', true, $16)`,
    [
      spec.code,
      spec.effectiveDate,
      VINTAGE,
      spec.rate,
      spec.pct?.[0] ?? null,
      spec.pct?.[1] ?? null,
      spec.pct?.[2] ?? null,
      spec.pct?.[3] ?? null,
      spec.volumeBn ?? null,
      spec.target?.[0] ?? null,
      spec.target?.[1] ?? null,
      spec.averages?.[0] ?? null,
      spec.averages?.[1] ?? null,
      spec.averages?.[2] ?? null,
      spec.averages?.[3] ?? null,
      provenanceId,
    ],
  );
}

async function seedCurve(spec: {
  curveId: string;
  name: string;
  kind: string;
  dayCount: string;
  compounding: string;
  sourceId: string;
}): Promise<void> {
  await t.client.query(
    `INSERT INTO curves (curve_id, name, currency, kind, day_count, compounding, source_id,
                         default_interpolation)
     VALUES ($1, $2, 'USD', $3, $4, $5, $6, 'monotone_convex')
     ON CONFLICT (curve_id) DO NOTHING`,
    [spec.curveId, spec.name, spec.kind, spec.dayCount, spec.compounding, spec.sourceId],
  );
}

async function seedPoint(spec: {
  curveId: string;
  curveDate: string;
  tenor: string;
  tenorDays: number;
  quoteType: string;
  value: number;
  instrumentId?: number;
  maturityDate?: string;
  provenanceId: number;
}): Promise<void> {
  await t.client.query(
    `INSERT INTO curve_points (curve_id, curve_date, tenor, quote_type, vintage_at, tenor_days,
                               value, instrument_id, maturity_date, is_latest, provenance_id)
     VALUES ($1, $2::date, $3, $4, $5::timestamptz, $6, $7, $8, $9::date, true, $10)`,
    [
      spec.curveId,
      spec.curveDate,
      spec.tenor,
      spec.quoteType,
      VINTAGE,
      spec.tenorDays,
      spec.value,
      spec.instrumentId ?? null,
      spec.maturityDate ?? null,
      spec.provenanceId,
    ],
  );
}

/** `[tenor, tenorDays, value on 2026-09-11, value on 2026-09-10]`. */
const PAR_POINTS: readonly [string, number, number, number][] = [
  ['1M', 30, 4.02, 4.0],
  ['1.5M', 45, 4.01, 3.99],
  ['3M', 91, 3.99, 3.97],
  ['2Y', 730, 3.76, 3.74],
  ['5Y', 1826, 3.81, 3.78],
  ['10Y', 3653, 4.07, 4.03],
  ['30Y', 10958, 4.66, 4.62],
];

/** `[tenor, tenorDays, discount rate, investment yield]`. */
const BILL_POINTS: readonly [string, number, number, number][] = [
  ['4WK', 28, 3.95, 4.02],
  ['13WK', 91, 3.9, 4.0],
  ['52WK', 364, 3.7, 3.85],
];

beforeEach(async () => {
  await ensureLicences();
  await materialiseCalendar(t.db, USGOVT, { fromYear: 2026, toYear: 2026 });

  const session = await createWebSession(t, { email: `btmm-${randomUUID()}@demo.invalid` });
  await grantEverySource(session.firmId, session.userId);

  // ── the NY Fed morning ────────────────────────────────────────────────────────────────────
  //
  // Every number below is transcribed from `fixtures/providers/raw/nyfed-all`, the repository's
  // recorded NY Fed capture, so the golden can be diffed against the source it claims to come
  // from. It used to be hand-typed: EFFR read 3.58 against the capture's 3.63, SOFR's volume 2 412
  // against 2 861, OBFR/TGCR/BGCR showed no percentiles at all although the capture publishes
  // every one of them, and the SOFR averages index level was `1.12345678` — a keyboard walk, not a
  // rate. The only rows not in the capture are the prior-session fixings, which exist so that
  // `chg1dBp` has something to difference against; the capture covers one date.
  const nyfedProv = await bootstrapProvenance(t, 'nyfed.rates', 'btmm-nyfed');
  await seedFixing(
    {
      code: 'SOFR',
      effectiveDate: FIXING_DATE,
      rate: 3.62,
      pct: [3.57, 3.6, 3.67, 3.7],
      volumeBn: 2861,
    },
    nyfedProv,
  );
  await seedFixing({ code: 'SOFR', effectiveDate: PRIOR_FIXING_DATE, rate: 3.64 }, nyfedProv);
  await seedFixing(
    {
      code: 'EFFR',
      effectiveDate: FIXING_DATE,
      rate: 3.63,
      pct: [3.6, 3.62, 3.63, 3.64],
      volumeBn: 91,
      target: [3.5, 3.75],
    },
    nyfedProv,
  );
  await seedFixing(
    { code: 'EFFR', effectiveDate: PRIOR_FIXING_DATE, rate: 3.57, target: [3.5, 3.75] },
    nyfedProv,
  );
  await seedFixing(
    {
      code: 'OBFR',
      effectiveDate: FIXING_DATE,
      rate: 3.63,
      pct: [3.53, 3.62, 3.63, 3.7],
      volumeBn: 226,
    },
    nyfedProv,
  );
  await seedFixing(
    {
      code: 'TGCR',
      effectiveDate: FIXING_DATE,
      rate: 3.6,
      pct: [3.53, 3.6, 3.6, 3.63],
      volumeBn: 1155,
    },
    nyfedProv,
  );
  await seedFixing(
    {
      code: 'BGCR',
      effectiveDate: FIXING_DATE,
      rate: 3.6,
      pct: [3.53, 3.6, 3.61, 3.66],
      volumeBn: 1183,
    },
    nyfedProv,
  );
  // SOFRAI: averages and an index level, no rate and no percentiles (PROVIDERS §10.4). The capture
  // dates it a session later than the overnight rates, because the averages index for a day is
  // published the following morning — so the row carries its own effective date, as it does live.
  await seedFixing(
    {
      code: 'SOFRAI',
      effectiveDate: SOFRAI_DATE,
      rate: null,
      averages: [3.6485, 3.64603, 3.65767, 1.25884091],
    },
    nyfedProv,
  );

  // ── the curves ────────────────────────────────────────────────────────────────────────────
  const parProv = await bootstrapProvenance(t, 'treasury.yieldcurve', 'btmm-par');
  const billProv = await bootstrapProvenance(t, 'treasury.bills', 'btmm-bill');
  const h15Prov = await bootstrapProvenance(t, 'fed.h15', 'btmm-h15');

  await seedCurve({
    curveId: 'UST_PAR',
    name: 'US Treasury par yield curve',
    kind: 'par',
    dayCount: 'ACT/ACT',
    compounding: 'semiannual',
    sourceId: 'treasury.yieldcurve',
  });
  await seedCurve({
    curveId: 'UST_BILL',
    name: 'US Treasury bill rates',
    kind: 'bill',
    dayCount: 'ACT/360',
    compounding: 'simple',
    sourceId: 'treasury.bills',
  });
  await seedCurve({
    curveId: 'UST_CMT',
    name: 'H.15 constant maturity',
    kind: 'cmt',
    dayCount: 'ACT/ACT',
    compounding: 'semiannual',
    sourceId: 'fed.h15',
  });

  for (const [tenor, tenorDays, value, compare] of PAR_POINTS) {
    await seedPoint({
      curveId: 'UST_PAR',
      curveDate: CURVE_DATE,
      tenor,
      tenorDays,
      quoteType: 'par_yield',
      value,
      provenanceId: parProv,
    });
    await seedPoint({
      curveId: 'UST_PAR',
      curveDate: COMPARE_CURVE_DATE,
      tenor,
      tenorDays,
      quoteType: 'par_yield',
      value: compare,
      provenanceId: parProv,
    });
  }
  await seedPoint({
    curveId: 'UST_CMT',
    curveDate: CURVE_DATE,
    tenor: '10Y',
    tenorDays: 3653,
    quoteType: 'cmt_yield',
    value: 4.06,
    provenanceId: h15Prov,
  });

  // The on-the-run four-week bill is a real instrument with a CUSIP; the other two tenors are
  // curve points with no instrument behind them, which is the honest shape of the Treasury file.
  const bill = await seedInstrument({
    ticker: '912797VE4',
    name: 'United States Treasury Bill 4WK 09/29/26',
    assetClass: 'govt',
    marketSector: 'Govt',
    exchCode: 'GOVT',
    securityType: 'US GOVERNMENT',
    sourceId: 'treasury.bills',
    providerSymbol: '912797VE4',
  });
  await t.client.query(
    `INSERT INTO govt_terms (instrument_id, security_type, cusip, term_label, issue_date,
                             dated_date, maturity_date, coupon_type, coupon_rate, coupon_freq,
                             day_count, business_day_conv, calendar_id, settlement_days,
                             min_denomination, on_the_run, valid_from, provenance_id)
     VALUES ($1,'bill','912797VE4','4WK','2026-09-01','2026-09-01','2026-09-29','zero',NULL,0,
             'ACT/360','following','SIFMA',1,100,true,$2::timestamptz,$3)`,
    [bill.instrumentId, VALID_FROM.toISOString(), billProv],
  );

  for (const [tenor, tenorDays, discount, investment] of BILL_POINTS) {
    for (const [quoteType, value] of [
      ['discount_rate', discount],
      ['investment_yield', investment],
    ] as const) {
      await seedPoint({
        curveId: 'UST_BILL',
        curveDate: CURVE_DATE,
        tenor,
        tenorDays,
        quoteType,
        value,
        ...(tenor === '4WK'
          ? { instrumentId: bill.instrumentId, maturityDate: '2026-09-29' }
          : {}),
        provenanceId: billProv,
      });
    }
  }

  // ── the FOMC calendar ─────────────────────────────────────────────────────────────────────
  const fomcProv = await bootstrapProvenance(t, 'fed.fomc', 'btmm-fomc');
  await t.client.query(
    `INSERT INTO fomc_meetings (meeting_date, statement_at, has_sep, decision_bp, provenance_id)
     VALUES (date '2026-07-29', timestamptz '2026-07-29T18:00:00Z', false, -25, $1),
            (date '2026-09-16', timestamptz '2026-09-16T18:00:00Z', true, NULL, $1)
     ON CONFLICT (meeting_date) DO NOTHING`,
    [fomcProv],
  );

  // ── the context grid ──────────────────────────────────────────────────────────────────────
  const eurusd = await seedInstrument({
    ticker: 'EURUSD',
    name: 'Euro-US Dollar',
    assetClass: 'fx',
    marketSector: 'Curncy',
    exchCode: 'FX',
    securityType: 'Spot',
    sourceId: 'yahoo.chart',
    providerSymbol: 'EURUSD=X',
  });
  const usdjpy = await seedInstrument({
    ticker: 'USDJPY',
    name: 'US Dollar-Japanese Yen',
    assetClass: 'fx',
    marketSector: 'Curncy',
    exchCode: 'FX',
    securityType: 'Spot',
    sourceId: 'yahoo.chart',
    providerSymbol: 'USDJPY=X',
  });
  const gbpusd = await seedInstrument({
    ticker: 'GBPUSD',
    name: 'British Pound-US Dollar',
    assetClass: 'fx',
    marketSector: 'Curncy',
    exchCode: 'FX',
    securityType: 'Spot',
    sourceId: 'yahoo.chart',
    providerSymbol: 'GBPUSD=X',
  });
  const spx = await seedInstrument({
    ticker: 'SPX',
    name: 'S&P 500',
    assetClass: 'index',
    marketSector: 'Index',
    exchCode: 'INDEX',
    securityType: 'Index',
    sourceId: 'cboe.quotes',
    providerSymbol: '_SPX',
  });
  const vix = await seedInstrument({
    ticker: 'VIX',
    name: 'Cboe Volatility Index',
    assetClass: 'index',
    marketSector: 'Index',
    exchCode: 'INDEX',
    securityType: 'Index',
    sourceId: 'cboe.quotes',
    providerSymbol: '_VIX',
  });
  const tnx = await seedInstrument({
    ticker: 'TNX',
    name: 'Cboe 10-Year Treasury Note Yield Index',
    assetClass: 'index',
    marketSector: 'Index',
    exchCode: 'INDEX',
    securityType: 'Index',
    sourceId: 'yahoo.chart',
    providerSymbol: '^TNX',
  });

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };

  const yahooProv = await bootstrapProvenance(t, 'yahoo.chart', 'btmm-yahoo');
  const cboeProv = await bootstrapProvenance(t, 'cboe.quotes', 'btmm-cboe');
  harness.deps.plant.apply(
    quote(eurusd, 'fx', 'yahoo.chart', yahooProv, {
      PX_LAST: 1.1543,
      CHG_NET_1D: 0.0021,
      CHG_PCT_1D: 0.1822,
    }),
  );
  harness.deps.plant.apply(
    quote(usdjpy, 'fx', 'yahoo.chart', yahooProv, {
      PX_LAST: 155.0,
      CHG_NET_1D: -0.34,
      CHG_PCT_1D: -0.2188,
    }),
  );
  // GBPUSD is deliberately never polled: a monitor never fetches (§0.4 rule 2), so its cells are
  // pending — `blank`, `provIdx: -1`, no reason code — and the WebSocket fills them.
  harness.deps.plant.apply(
    quote(spx, 'index', 'cboe.quotes', cboeProv, {
      PX_LAST: 7585.75,
      CHG_NET_1D: -34.23,
      CHG_PCT_1D: -0.4492,
    }),
  );
  harness.deps.plant.apply(
    quote(vix, 'index', 'cboe.quotes', cboeProv, {
      PX_LAST: 17.5,
      CHG_NET_1D: 0.4,
      CHG_PCT_1D: 2.3392,
    }),
  );
  harness.deps.plant.apply(
    quote(tnx, 'index', 'yahoo.chart', yahooProv, {
      PX_LAST: 4.99,
      CHG_NET_1D: 0.039,
      CHG_PCT_1D: 0.7876,
    }),
  );

  env = {
    harness,
    app: harness.app,
    clock,
    cookie: session.cookie,
    knownAt,
    billId: bill.instrumentId,
    context: { EURUSD: eurusd, USDJPY: usdjpy, GBPUSD: gbpusd, SPX: spx, VIX: vix, TNX: tnx },
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: BtmmPayload;
  meta: PayloadMeta;
}

async function runBTMM(params: Record<string, unknown> = {}): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/BTMM/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

function fixing(payload: BtmmPayload, code: string): RateFixingRow {
  const row = payload.overnight.find((r) => r.rateCode === code);
  expect(row, `${code} is missing from the overnight block`).toBeDefined();
  return row!;
}

function curvePoint(payload: BtmmPayload, tenor: string): CurvePointRow {
  const row = payload.curve.points.find((p) => p.tenor === tenor);
  expect(row, `${tenor} is missing from the curve block`).toBeDefined();
  return row!;
}

function spread(payload: BtmmPayload, id: string): SpreadRow {
  const row = payload.spreads.find((s) => s.id === id);
  expect(row, `${id} is missing from the spreads block`).toBeDefined();
  return row!;
}

/**
 * The one key in a BTMM payload that holds a sequence-allocated id: a bill point's `instrumentId`
 * and a context row's. `curveId` (`'UST_BILL'`), `fieldId` (`'CRV_1M'`) and a spread's `id`
 * (`'2s10s'`) are names, not sequence values, and never numbers.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId']);

function normalise(payload: BtmmPayload): unknown {
  const tokens = new Map<number, string>([
    [env.billId, '<BILL>'],
    ...Object.entries(env.context).map(
      ([key, seeded]) => [seeded.instrumentId, `<${key}>`] as [number, string],
    ),
  ]);
  const json = JSON.stringify(payload, (key, value: unknown) => {
    if (typeof value === 'string') return subjectToken(value, tokens);
    // A number is an id because of the key it sits under, never because it equals one. BTMM is
    // almost nothing *but* numbers — yields, basis-point spreads, target rates, discount margins,
    // epoch `ts` — so a value-based rule renames whichever of them the instrument sequence
    // happens to reach on the run that draws the ids.
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

describe('BTMM — one payload, every block', () => {
  it('serves policy, overnight, bills, curve, spreads and context from one run', async () => {
    const { data } = await runBTMM();
    expect(data.variant).toBe('default');
    expect(data.section).toBe('ALL');

    // policy
    expect(data.policy.targetFrom.v).toBe(3.5);
    expect(data.policy.targetTo.v).toBe(3.75);
    expect(data.policy.targetMid.v).toBe(3.625);
    expect(data.policy.effectiveDate).toBe(FIXING_DATE);
    expect(data.policy.lastMeeting).toMatchObject({
      meetingDate: '2026-07-29',
      decisionBp: -25,
    });
    expect(data.policy.nextMeeting).toMatchObject({
      meetingDate: '2026-09-16',
      hasSep: true,
      daysAway: 1,
      // A decision is never estimated before the meeting.
      decisionBp: null,
    });

    // overnight — six rows, in the order the screen prints them
    expect(data.overnight.map((r) => r.rateCode)).toEqual([
      'SOFR',
      'EFFR',
      'OBFR',
      'TGCR',
      'BGCR',
      'SOFRAI',
    ]);

    // bills — three tenors × two quote types
    expect(data.bills.curveDate).toBe(CURVE_DATE);
    expect(data.bills.points).toHaveLength(6);

    // curve — seven tenors, ascending by tenor days
    expect(data.curve.curveId).toBe('UST_PAR');
    expect(data.curve.curveDate).toBe(CURVE_DATE);
    expect(data.curve.compareDate).toBe(COMPARE_CURVE_DATE);
    expect(data.curve.stale).toBe(false);
    expect(data.curve.points.map((p) => p.tenor)).toEqual([
      '1M',
      '1.5M',
      '3M',
      '2Y',
      '5Y',
      '10Y',
      '30Y',
    ]);

    // spreads and context
    expect(data.spreads).toHaveLength(9);
    expect(data.context.fx.map((r) => r.key)).toEqual([
      'EURUSD Curncy',
      'USDJPY Curncy',
      'GBPUSD Curncy',
    ]);
    expect(data.context.indices.map((r) => r.key)).toEqual(['SPX Index', 'VIX Index', 'TNX Index']);
  });

  it('carries SOFR and EFFR with their percentiles, volume and one-day change', async () => {
    const { data } = await runBTMM();
    const sofr = fixing(data, 'SOFR');
    expect(sofr.effectiveDate).toBe(FIXING_DATE);
    expect(sofr.subject).toBe('r:SOFR');
    // The capture's own numbers for 2026-09-14 (fixtures/providers/raw/nyfed-all).
    expect(sofr.rate.v).toBe(3.62);
    expect(sofr.rate.live).toEqual({ subject: 'r:SOFR', field: 'RATE' });
    expect([sofr.p1.v, sofr.p25.v, sofr.p75.v, sofr.p99.v]).toEqual([3.57, 3.6, 3.67, 3.7]);
    expect(sofr.volumeBn.v).toBe(2861);
    // 3.62 − 3.64 = −2.0 bp, computed from the stored prior fixing.
    expect(sofr.chg1dBp.v).toBe(-2);

    const effr = fixing(data, 'EFFR');
    expect(effr.rate.v).toBe(3.63);
    expect([effr.p1.v, effr.p25.v, effr.p75.v, effr.p99.v]).toEqual([3.6, 3.62, 3.63, 3.64]);
    expect(effr.volumeBn.v).toBe(91);
    // 3.63 − 3.57 = +6.0 bp.
    expect(effr.chg1dBp.v).toBe(6);
    expect(effr.rate.provIdx).toBeGreaterThanOrEqual(0);
  });

  it('carries the three secured and unsecured benchmarks the capture publishes in full', async () => {
    const { data } = await runBTMM();
    // The acceptance row asks for "SOFR/EFFR with percentiles from the seeded fixings"; these three
    // used to show a dash in all five columns although the same capture publishes every one of
    // them, with nothing in `meta.unavailable` to explain the blanks.
    const expected: Record<string, { rate: number; pct: number[]; volumeBn: number }> = {
      OBFR: { rate: 3.63, pct: [3.53, 3.62, 3.63, 3.7], volumeBn: 226 },
      TGCR: { rate: 3.6, pct: [3.53, 3.6, 3.6, 3.63], volumeBn: 1155 },
      BGCR: { rate: 3.6, pct: [3.53, 3.6, 3.61, 3.66], volumeBn: 1183 },
    };
    for (const [code, want] of Object.entries(expected)) {
      const row = fixing(data, code);
      expect(row.rate.v, code).toBe(want.rate);
      expect([row.p1.v, row.p25.v, row.p75.v, row.p99.v], code).toEqual(want.pct);
      expect(row.volumeBn.v, code).toBe(want.volumeBn);
      expect(row.rate.provIdx, code).toBeGreaterThanOrEqual(0);
    }
  });

  it('prints SOFRAI as averages and an index, never as a rate', async () => {
    const { data, meta } = await runBTMM();
    const sofrai = fixing(data, 'SOFRAI');
    for (const cell of [sofrai.rate, sofrai.p1, sofrai.p25, sofrai.p75, sofrai.p99, sofrai.volumeBn]) {
      expect(cell.v).toBeNull();
      expect(cell.st).toBe('na');
    }
    expect(sofrai.chg1dBp.v).toBeNull();
    // The values it does publish are there, as the capture publishes them.
    expect(sofrai.effectiveDate).toBe(SOFRAI_DATE);
    expect(sofrai.avg30d.v).toBe(3.6485);
    expect(sofrai.avg90d.v).toBe(3.64603);
    expect(sofrai.avg180d.v).toBe(3.65767);
    expect(sofrai.indexValue.v).toBe(1.25884091);

    const note = meta.unavailable.find((u) => u.field === 'overnight.SOFRAI.rate');
    expect(note).toMatchObject({ reason: 'NOT_APPLICABLE' });
    expect(note!.detail).toContain('PROVIDERS §10.4');
  });

  it('joins the bill curve to govt_terms for the on-the-run CUSIP', async () => {
    const { data } = await runBTMM();
    const fourWeek = data.bills.points.filter((p) => p.tenor === '4WK');
    expect(fourWeek).toHaveLength(2);
    for (const point of fourWeek) {
      expect(point.cusip).toBe('912797VE4');
      expect(point.maturityDate).toBe('2026-09-29');
      expect(point.onTheRun).toBe(true);
      expect(point.instrumentId).toBe(env.billId);
    }
    expect(fourWeek.find((p) => p.quoteType === 'discount_rate')!.value.v).toBe(3.95);
    expect(fourWeek.find((p) => p.quoteType === 'investment_yield')!.value.v).toBe(4.02);

    // A tenor the Treasury file publishes without an on-the-run instrument keeps its rate and
    // reports no CUSIP, rather than borrowing the four-week bill's.
    const yearly = data.bills.points.filter((p) => p.tenor === '52WK');
    expect(yearly.every((p) => p.cusip === null && p.instrumentId === null)).toBe(true);
  });

  it('computes the change column against the previous stored curve date', async () => {
    const { data } = await runBTMM();
    const tenY = curvePoint(data, '10Y');
    expect(tenY.value.v).toBe(4.07);
    expect(tenY.compareValue.v).toBe(4.03);
    expect(tenY.chgBp.v).toBe(4);
    expect(tenY.fieldId).toBe('CRV_10Y');
    // A tenor with no dictionary id says so instead of inventing `CRV_1.5M`.
    expect(curvePoint(data, '1.5M').fieldId).toBeNull();
  });

  it('serves the H.15 constant-maturity curve on CRV=UST_CMT', async () => {
    const { data } = await runBTMM({ curveId: 'UST_CMT' });
    expect(data.curve.curveId).toBe('UST_CMT');
    expect(data.curve.points.map((p) => p.tenor)).toEqual(['10Y']);
    expect(curvePoint(data, '10Y').value.v).toBe(4.06);
    expect(curvePoint(data, '10Y').quoteType).toBe('cmt_yield');
  });

  it('derives every spread from the published values on the same payload', async () => {
    const { data } = await runBTMM();
    expect(spread(data, '2s10s').value.v).toBe(31);
    expect(spread(data, '2s10s').definition).toBe('10Y par yield − 2Y par yield');
    expect(spread(data, '3m10y').value.v).toBe(8);
    expect(spread(data, '5s30s').value.v).toBe(85);
    // The overnight legs are the capture's: SOFR 3.62, EFFR 3.63, TGCR 3.60, BGCR 3.60.
    expect(spread(data, 'sofr_effr').value.v).toBe(-1);
    expect(spread(data, 'bgcr_sofr').value.v).toBe(-2);
    expect(spread(data, 'tgcr_bgcr').value.v).toBe(0);
    expect(spread(data, 'effr_target_mid').value.v).toBe(0.5);
    expect(spread(data, 'bill13wk_sofr').value.v).toBe(38);
    // The cross-source check of PROVIDERS §10.3: the par 10Y against the H.15 10Y, so a divergence
    // between two publishers is visible rather than silent.
    expect(spread(data, 'par10y_cmt10y').value.v).toBe(1);

    // `2s10s` is exactly `CRV_10Y − CRV_2Y` of the same curve date.
    const ten = curvePoint(data, '10Y').value.v as number;
    const two = curvePoint(data, '2Y').value.v as number;
    expect(spread(data, '2s10s').value.v).toBe(Math.round((ten - two) * 1000) / 10);
    // A curve-only spread also carries the change against the compare date.
    expect(spread(data, '2s10s').compareValue.v).toBe(29);
    expect(spread(data, '2s10s').chgBp.v).toBe(2);

    const pct = await runBTMM({ spreadUnits: 'pct' });
    expect(spread(pct.data, '2s10s').unit).toBe('pct');
    expect(spread(pct.data, '2s10s').value.v).toBeCloseTo(0.31, 10);
  });

  it('never computes a spread from a partial pair', async () => {
    await t.client.query(
      `DELETE FROM curve_points WHERE curve_id = 'UST_PAR' AND tenor = '2Y'`,
    );
    const { data, meta } = await runBTMM();
    expect(data.curve.points.map((p) => p.tenor)).not.toContain('2Y');

    const twos = spread(data, '2s10s');
    expect(twos.value.v).toBeNull();
    expect(twos.value.st).toBe('na');
    expect(twos.provIdx).toBe(-1);
    const note = meta.unavailable.find((u) => u.field === 'spreads.2s10s');
    expect(note).toMatchObject({
      reason: 'NO_SOURCE',
      detail: 'one leg of the spread is unavailable for this date',
    });

    // The other spreads are unaffected: one missing leg is one missing spread.
    expect(spread(data, '3m10y').value.v).toBe(8);
    expect(spread(data, '5s30s').value.v).toBe(85);
  });

  it('reads the context grid from the plant and leaves an unpolled name pending', async () => {
    const { data } = await runBTMM();
    const eur = data.context.fx.find((r) => r.key === 'EURUSD Curncy')!;
    expect(eur.cells.PX_LAST!.v).toBe(1.1543);
    expect(eur.cells.PX_LAST!.live).toEqual({ subject: eur.subject, field: 'PX_LAST' });
    expect(eur.cells.PX_LAST!.provIdx).toBeGreaterThanOrEqual(0);

    // §0.4 rules 1 and 2: never polled ⇒ pending, not a reason code and not a provider call.
    const gbp = data.context.fx.find((r) => r.key === 'GBPUSD Curncy')!;
    expect(gbp.cells.PX_LAST!.v).toBeNull();
    expect(gbp.cells.PX_LAST!.st).toBe('blank');
    expect(gbp.cells.PX_LAST!.provIdx).toBe(-1);
    expect(gbp.cells.PX_LAST!.r).toBeUndefined();

    const tnx = data.context.indices.find((r) => r.key === 'TNX Index')!;
    expect(tnx.cells.PX_LAST!.v).toBe(4.99);
  });

  it('states the three cells no reachable source publishes', async () => {
    const { data, meta } = await runBTMM();
    expect(data.policy.iorb).toEqual({ v: null, r: 'NO_IORB_SOURCE' });
    expect(data.policy.discountWindow).toEqual({ v: null, r: 'NO_DISCOUNT_WINDOW_SOURCE' });
    expect(data.notes).toContain('NO_IORB_SOURCE');
    expect(data.notes).toContain('NO_DISCOUNT_WINDOW_SOURCE');
    expect(data.notes).toContain('NO_FED_FUNDS_FUTURES');

    for (const field of ['policy.iorb', 'policy.discountWindow', 'policy.impliedPath']) {
      const note = meta.unavailable.find((u) => u.field === field);
      expect(note, `${field} has no meta.unavailable entry`).toBeDefined();
      expect(note!.reason).toBe('NO_SOURCE');
      expect(note!.detail.length).toBeGreaterThan(20);
    }
    // The implied path points at WIRP rather than being estimated here.
    const path = meta.unavailable.find((u) => u.field === 'policy.impliedPath')!;
    expect(path.detail).toContain('WIRP');
  });

  it('returns every block whatever section is asked for, so PRINT is section-independent', async () => {
    const all = await runBTMM();
    const curveOnly = await runBTMM({ section: 'CURVE' });
    expect(curveOnly.data.section).toBe('CURVE');
    expect(curveOnly.data.overnight).toHaveLength(all.data.overnight.length);
    expect(curveOnly.data.bills.points).toHaveLength(all.data.bills.points.length);
    expect(curveOnly.data.spreads).toHaveLength(all.data.spreads.length);
  });

  it('cites a provenance row for every finite number it prints', async () => {
    const { data, meta } = await runBTMM();
    expect(meta.provenance.length).toBeGreaterThan(0);
    const seen = new Set(meta.provenance.map((p) => p.idx));

    const cells = [
      ...data.overnight.flatMap((r) => [r.rate, r.p1, r.volumeBn, r.chg1dBp, r.avg30d]),
      ...data.curve.points.flatMap((p) => [p.value, p.compareValue, p.chgBp]),
      ...data.bills.points.map((p) => p.value),
      ...data.spreads.map((s) => s.value),
      data.policy.targetFrom,
      data.policy.targetTo,
      data.policy.targetMid,
    ];
    for (const cell of cells) {
      if (typeof cell.v === 'number') {
        expect(cell.provIdx, `${String(cell.v)} cites nothing`).toBeGreaterThanOrEqual(0);
        expect(seen.has(cell.provIdx)).toBe(true);
      }
    }
    // Every source behind the page is attributed (DATA-09).
    const sources = new Set(meta.provenance.map((p) => p.sourceId));
    expect(sources.has('nyfed.rates')).toBe(true);
    expect(sources.has('treasury.yieldcurve')).toBe(true);
    expect(sources.has('treasury.bills')).toBe(true);
    expect(sources.has('fed.h15')).toBe(true);
  });

  it('matches the committed golden', async () => {
    const { data } = await runBTMM();
    expectGolden(GOLDEN_NAME, normalise(data));
  });
});
