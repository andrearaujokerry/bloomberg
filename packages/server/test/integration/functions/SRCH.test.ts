/**
 * `test/integration/functions/SRCH.test.ts` — WP-11's `SRCH`, the Treasury terms screen.
 *
 * SRCH's risk is not arithmetic; YAS already owns that. It is that a *screen* quietly answers a
 * different question from the one asked — so this file asserts the five places that happens:
 *
 *  1. **The columns are curve-derived and say so.** `pricing.basis` is
 *     `curve_derived_no_market_quotes` and the notes carry `NO_BOND_PRICE_SOURCE` and
 *     `SEED_UNIVERSE_ONLY` on every payload, not only when something fails.
 *  2. **A row equals YAS.** The 10Y note's `YLD_YTM_MID`, `PX_CLEAN_MID`, `ACCRUED`,
 *     `DUR_ADJ_MID` and `DV01` are compared with the YAS payload for the same security, settlement
 *     and curve, to 1e-9 (ANAL-09). Both screens are run through the same app in the same
 *     transaction, so the only way this passes is if both call the same engines.
 *  3. **A filter selects what it says it selects.** `yearsFrom/yearsTo` and `maturityFrom/To`
 *     choose the same rows for equivalent windows; a coupon window excludes bills, which have no
 *     coupon; `onTheRun:'only'` and a CUSIP prefix return the sets they name; and every
 *     `filters[].matched` equals a hand count over the seeded universe.
 *  4. **A missing curve is still a screen.** With the `UST_PAR` points deleted the terms columns,
 *     the filters, the counts and the facets are unchanged, the analytic cells are `blank` with
 *     `PROVIDER_DOWN`, one `meta.unavailable` entry explains them, and the status is 200.
 *  5. **TIPS keep their terms and refuse their analytics**, with `TIPS_FRN_NOT_PRICED` and a
 *     `NOT_APPLICABLE` entry — never a nominal price for an inflation-linked bond.
 *
 * No seed is assumed and nothing asserts on a literal instrument id (WP-15 owns the seed): every
 * row lives inside `withTxDb()`'s transaction.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PayloadMeta } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { SIFMA } from '@terminal/core/calendars/sifma';
import { SRCH, SrchParams, parseSrchCriteria } from '@terminal/core/functions/manifests/SRCH';
import type { SrchPayload } from '@terminal/core/functions/manifests/SRCH';
import { YAS } from '@terminal/core/functions/manifests/YAS';
import type { YasCouponResults, YasPayload } from '@terminal/core/functions/manifests/YAS';

import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as SRCHModule from '../../../src/functions/SRCH/resolve.js';
import * as YASModule from '../../../src/functions/YAS/resolve.js';
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

const SYMBOL_TAG = `.t${randomUUID().slice(0, 8)}`;
const REGISTRY = new FunctionRegistry([SRCH, YAS]);
const MODULES: Record<string, FunctionServerModule<any, any>> = {
  SRCH: SRCHModule,
  YAS: YASModule,
};

const t: TestDb = withTxDb();

/** The curve this file screens against: Monday 2026-09-14, the session before the frozen clock. */
const CURVE_DATE = '2026-09-14';
const VINTAGE = '2026-09-15T10:00:00.000Z';
/** T+1 SIFMA from the valuation date 2026-09-15. */
const SETTLEMENT = '2026-09-16';

/**
 * `[tenor, tenorDays, par yield %]` — the nine tenors at or beyond six months.
 *
 * WP-02's `curve.bootstrap` treats every `par_yield` point as a par coupon bond and raises on a
 * tenor shorter than one semiannual coupon period, so the 1M/2M/3M par points are not seeded here
 * (the same boundary `YAS.test.ts` records).
 */
const PAR_POINTS: readonly [string, number, number][] = [
  ['6M', 182, 3.95],
  ['1Y', 365, 3.9],
  ['2Y', 730, 3.76],
  ['3Y', 1096, 3.78],
  ['5Y', 1826, 3.81],
  ['7Y', 2557, 3.95],
  ['10Y', 3653, 4.07],
  ['20Y', 7305, 4.55],
  ['30Y', 10958, 4.66],
];

/** `[tenor, tenorDays, discount rate %, investment yield %]`. */
const BILL_POINTS: readonly [string, number, number, number][] = [
  ['4WK', 28, 3.69, 3.76],
  ['8WK', 56, 3.72, 3.8],
  ['13WK', 91, 3.9, 4.0],
  ['17WK', 119, 3.89, 4.0],
  ['26WK', 182, 3.88, 4.01],
  ['52WK', 364, 3.7, 3.85],
];

interface BondSpec {
  label: string;
  ticker: string;
  name: string;
  securityType: 'bill' | 'note' | 'bond' | 'tips';
  couponType: 'fixed' | 'zero' | 'inflation_linked';
  cusip: string;
  termLabel: string | null;
  couponRate: number | null;
  couponFreq: number;
  dayCount: string;
  datedDate: string;
  maturityDate: string;
  onTheRun: boolean;
  amountOutstanding: number | null;
  /** The `UST_BILL` tenor this bill is the on-the-run issue for, when it is one. */
  billTenor?: string;
}

/**
 * The seeded universe: seven bills from the bill file plus seven curated notes/bonds — the shape
 * §SRCH describes, with two deliberate awkward cases.
 *
 *  - `912797CM0` is a 42-day cash-management bill that is on **no** bill-curve tenor, so its
 *    discount rate has to be interpolated and said to be interpolated.
 *  - the TIPS is the row that must keep its terms and refuse its analytics.
 */
const SECURITIES: readonly BondSpec[] = [
  {
    label: 'BILL_4WK',
    ticker: 'B 09/29/26',
    name: 'US Treasury Bill 4WK 29-Sep-2026',
    securityType: 'bill',
    couponType: 'zero',
    cusip: '912797VE4',
    termLabel: '4WK',
    couponRate: null,
    couponFreq: 0,
    dayCount: 'ACT/360',
    datedDate: '2026-09-01',
    maturityDate: '2026-09-29',
    onTheRun: true,
    amountOutstanding: 8.5e10,
    billTenor: '4WK',
  },
  {
    label: 'BILL_CMB',
    ticker: 'B 10/27/26',
    name: 'US Treasury Cash Management Bill 27-Oct-2026',
    securityType: 'bill',
    couponType: 'zero',
    cusip: '912797CM0',
    termLabel: '42D',
    couponRate: null,
    couponFreq: 0,
    dayCount: 'ACT/360',
    datedDate: '2026-09-15',
    maturityDate: '2026-10-27',
    onTheRun: false,
    amountOutstanding: null,
  },
  {
    label: 'BILL_8WK',
    ticker: 'B 11/10/26',
    name: 'US Treasury Bill 8WK 10-Nov-2026',
    securityType: 'bill',
    couponType: 'zero',
    cusip: '912797VF1',
    termLabel: '8WK',
    couponRate: null,
    couponFreq: 0,
    dayCount: 'ACT/360',
    datedDate: '2026-09-15',
    maturityDate: '2026-11-10',
    onTheRun: true,
    amountOutstanding: 7.2e10,
    billTenor: '8WK',
  },
  {
    label: 'BILL_13WK',
    ticker: 'B 12/15/26',
    name: 'US Treasury Bill 13WK 15-Dec-2026',
    securityType: 'bill',
    couponType: 'zero',
    cusip: '912797VG9',
    termLabel: '13WK',
    couponRate: null,
    couponFreq: 0,
    dayCount: 'ACT/360',
    datedDate: '2026-09-15',
    maturityDate: '2026-12-15',
    onTheRun: true,
    amountOutstanding: 9.1e10,
    billTenor: '13WK',
  },
  {
    label: 'BILL_17WK',
    ticker: 'B 01/12/27',
    name: 'US Treasury Bill 17WK 12-Jan-2027',
    securityType: 'bill',
    couponType: 'zero',
    cusip: '912797VH7',
    termLabel: '17WK',
    couponRate: null,
    couponFreq: 0,
    dayCount: 'ACT/360',
    datedDate: '2026-09-15',
    maturityDate: '2027-01-12',
    onTheRun: true,
    amountOutstanding: 6.4e10,
    billTenor: '17WK',
  },
  {
    label: 'BILL_26WK',
    ticker: 'B 03/16/27',
    name: 'US Treasury Bill 26WK 16-Mar-2027',
    securityType: 'bill',
    couponType: 'zero',
    cusip: '912797VJ3',
    termLabel: '26WK',
    couponRate: null,
    couponFreq: 0,
    dayCount: 'ACT/360',
    datedDate: '2026-09-15',
    maturityDate: '2027-03-16',
    onTheRun: true,
    amountOutstanding: 8.8e10,
    billTenor: '26WK',
  },
  {
    label: 'BILL_52WK',
    ticker: 'B 09/14/27',
    name: 'US Treasury Bill 52WK 14-Sep-2027',
    securityType: 'bill',
    couponType: 'zero',
    cusip: '912797VK0',
    termLabel: '52WK',
    couponRate: null,
    couponFreq: 0,
    dayCount: 'ACT/360',
    datedDate: '2026-09-15',
    maturityDate: '2027-09-14',
    onTheRun: true,
    amountOutstanding: 5.6e10,
    billTenor: '52WK',
  },
  {
    label: 'NOTE_2Y',
    ticker: 'T 3.75 08/31/28',
    name: 'US Treasury Note 3.75% 31-Aug-2028',
    securityType: 'note',
    couponType: 'fixed',
    cusip: '91282CLV6',
    termLabel: '2Y',
    couponRate: 3.75,
    couponFreq: 2,
    dayCount: 'ACT/ACT',
    // Dated before the settlement date: a security that has not settled yet cannot be priced, and
    // the engines say so rather than pricing it anyway.
    datedDate: '2026-08-31',
    maturityDate: '2028-08-31',
    onTheRun: true,
    amountOutstanding: 6.9e10,
  },
  {
    label: 'NOTE_5Y',
    ticker: 'T 3.875 08/31/31',
    name: 'US Treasury Note 3.875% 31-Aug-2031',
    securityType: 'note',
    couponType: 'fixed',
    cusip: '91282CLW4',
    termLabel: '5Y',
    couponRate: 3.875,
    couponFreq: 2,
    dayCount: 'ACT/ACT',
    datedDate: '2026-08-31',
    maturityDate: '2031-08-31',
    onTheRun: true,
    amountOutstanding: 7.0e10,
  },
  {
    label: 'NOTE_OLD',
    ticker: 'T 4.00 05/15/34',
    name: 'US Treasury Note 4.00% 15-May-2034',
    securityType: 'note',
    couponType: 'fixed',
    cusip: '91282CJK8',
    termLabel: null,
    couponRate: 4.0,
    couponFreq: 2,
    dayCount: 'ACT/ACT',
    datedDate: '2024-05-15',
    maturityDate: '2034-05-15',
    onTheRun: false,
    amountOutstanding: 4.2e10,
  },
  {
    label: 'NOTE_10Y',
    ticker: 'T 4.25 08/15/36',
    name: 'US Treasury Note 4.25% 15-Aug-2036',
    securityType: 'note',
    couponType: 'fixed',
    cusip: '91282CLM6',
    termLabel: '10Y',
    couponRate: 4.25,
    couponFreq: 2,
    dayCount: 'ACT/ACT',
    datedDate: '2026-08-15',
    maturityDate: '2036-08-15',
    onTheRun: true,
    amountOutstanding: 4.2e10,
  },
  {
    label: 'TIPS_10Y',
    ticker: 'TII 1.75 01/15/36',
    name: 'US Treasury Inflation-Indexed Note 1.75% 15-Jan-2036',
    securityType: 'tips',
    couponType: 'inflation_linked',
    cusip: '91282CLT6',
    termLabel: '10Y TIPS',
    couponRate: 1.75,
    couponFreq: 2,
    dayCount: 'ACT/ACT',
    datedDate: '2026-01-15',
    maturityDate: '2036-01-15',
    onTheRun: false,
    amountOutstanding: 1.8e10,
  },
  {
    label: 'BOND_20Y',
    ticker: 'T 4.50 08/15/46',
    name: 'US Treasury Bond 4.50% 15-Aug-2046',
    securityType: 'bond',
    couponType: 'fixed',
    cusip: '912810UE6',
    termLabel: '20Y',
    couponRate: 4.5,
    couponFreq: 2,
    dayCount: 'ACT/ACT',
    datedDate: '2026-08-15',
    maturityDate: '2046-08-15',
    onTheRun: true,
    amountOutstanding: 2.6e10,
  },
  {
    label: 'BOND_30Y',
    ticker: 'T 4.75 08/15/56',
    name: 'US Treasury Bond 4.75% 15-Aug-2056',
    securityType: 'bond',
    couponType: 'fixed',
    cusip: '912810UF3',
    termLabel: '30Y',
    couponRate: 4.75,
    couponFreq: 2,
    dayCount: 'ACT/ACT',
    datedDate: '2026-08-15',
    maturityDate: '2056-08-15',
    onTheRun: true,
    amountOutstanding: 2.4e10,
  },
];

interface SeededBond {
  instrumentId: number;
  key: string;
  cusip: string;
}

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  userId: number;
  firmId: number;
  bonds: Record<string, SeededBond>;
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

async function seedBond(spec: BondSpec, provenanceId: number): Promise<SeededBond> {
  const repos = masterRepositories(t.db);
  const o = { validFrom: VALID_FROM, provenanceId };
  const issuerId = await repos.issuers.insert({ name: 'United States Treasury' }, o);
  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass: 'govt',
      securityType: 'US GOVERNMENT',
      name: spec.name,
      currency: 'USD',
      countryOfIssue: 'US',
    },
    o,
  );
  const instrumentId = await repos.instruments.insert(
    {
      issueId,
      assetClass: 'govt',
      marketSector: 'Govt',
      ticker: spec.ticker,
      exchCode: 'GOVT',
      name: spec.name,
      currency: 'USD',
      searchWeight: 60,
    },
    o,
  );
  await repos.mdLines.upsertBySymbol(
    {
      instrumentId,
      sourceId: 'treasury.bills',
      providerSymbol: `${spec.cusip}${SYMBOL_TAG}`,
      lineKind: 'reference',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 86_400_000,
      priority: 10,
    },
    o,
  );
  await t.client.query(
    `INSERT INTO govt_terms (instrument_id, security_type, cusip, term_label, issue_date,
                             dated_date, maturity_date, coupon_type, coupon_rate, coupon_freq,
                             day_count, business_day_conv, calendar_id, settlement_days,
                             min_denomination, amount_outstanding, on_the_run, valid_from,
                             provenance_id)
     VALUES ($1, $2, $3, $4, $5::date, $5::date, $6::date, $7, $8, $9, $10, 'following', 'SIFMA',
             1, 100, $11, $12, $13::timestamptz, $14)`,
    [
      instrumentId,
      spec.securityType,
      spec.cusip,
      spec.termLabel,
      spec.datedDate,
      spec.maturityDate,
      spec.couponType,
      spec.couponRate,
      spec.couponFreq,
      spec.dayCount,
      spec.amountOutstanding,
      spec.onTheRun,
      VALID_FROM.toISOString(),
      provenanceId,
    ],
  );
  return { instrumentId, key: `${spec.ticker} Govt`, cusip: spec.cusip };
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
      CURVE_DATE,
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

beforeEach(async () => {
  await ensureLicences();
  await materialiseCalendar(t.db, SIFMA, { fromYear: 2026, toYear: 2027 });

  const session = await createWebSession(t, { email: `srch-${randomUUID()}@demo.invalid` });
  await grantEverySource(session.firmId, session.userId);

  const parProv = await bootstrapProvenance(t, 'treasury.yieldcurve', 'srch-par');
  const billProv = await bootstrapProvenance(t, 'treasury.bills', 'srch-bill');
  const refProv = await bootstrapProvenance(t, 'internal.user', 'srch-ref');

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
  for (const [tenor, tenorDays, value] of PAR_POINTS) {
    await seedPoint({
      curveId: 'UST_PAR',
      tenor,
      tenorDays,
      quoteType: 'par_yield',
      value,
      provenanceId: parProv,
    });
  }

  const bonds: Record<string, SeededBond> = {};
  for (const spec of SECURITIES) {
    bonds[spec.label] = await seedBond(spec, refProv);
  }

  for (const [tenor, tenorDays, discount, investment] of BILL_POINTS) {
    const owner = SECURITIES.find((spec) => spec.billTenor === tenor);
    const seeded = owner === undefined ? undefined : bonds[owner.label];
    for (const [quoteType, value] of [
      ['discount_rate', discount],
      ['investment_yield', investment],
    ] as const) {
      await seedPoint({
        curveId: 'UST_BILL',
        tenor,
        tenorDays,
        quoteType,
        value,
        ...(seeded === undefined
          ? {}
          : { instrumentId: seeded.instrumentId, maturityDate: owner!.maturityDate }),
        provenanceId: billProv,
      });
    }
  }

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };

  env = {
    harness,
    app: harness.app,
    clock,
    cookie: session.cookie,
    knownAt,
    userId: session.userId,
    firmId: session.firmId,
    bonds,
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: SrchPayload;
  meta: PayloadMeta;
}

async function runSRCH(params: Record<string, unknown> = {}): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/SRCH/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

async function pageSRCH(resultId: string, direction: 'fwd' | 'back'): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/SRCH/page`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { resultId, direction },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

async function runYAS(label: string, params: Record<string, unknown> = {}): Promise<YasPayload> {
  const seeded = env.bonds[label];
  if (seeded === undefined) throw new Error(`SRCH test: nothing seeded under '${label}'`);
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/YAS/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params,
      security: { id: seeded.instrumentId },
      asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<{ data: YasPayload }>().data;
}

/** Every column of the whitelist, so the goldens pin the analytics as well as the defaults. */
const ALL_COLUMNS = [
  'CUSIP',
  'SECURITY_TYP',
  'TERM_LABEL',
  'CPN',
  'MATURITY',
  'MTY_YEARS',
  'YLD_YTM_MID',
  'DISC_RATE',
  'BEY',
  'PX_CLEAN_MID',
  'DUR_ADJ_MID',
  'DV01',
] as const;

/**
 * The keys of a SRCH payload that hold a sequence-allocated id: the instrument and the
 * `curve_builds.build_id`.
 *
 * Every other number here is a measurement — a price, a yield, a duration, a count, an amount
 * outstanding — and a value-based rule would rename whichever of them the sequence happens to
 * reach (the defect WP-10 closed across 25 files). `subjectToken` covers the `q:<id>` in
 * `rows[].subject`.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId', 'buildId']);

function normalise(payload: SrchPayload): unknown {
  const tokens = new Map<number, string>(
    Object.entries(env.bonds).map(([label, seeded]) => [seeded.instrumentId, `<${label}>`]),
  );
  const json = JSON.stringify(payload, (key, value: unknown) => {
    // `buildId` is a bigserial the bootstrap allocates on first use; it is an id, not a number.
    if (key === 'buildId' && typeof value === 'number') return '<BUILD>';
    if (typeof value === 'string') return subjectToken(value, tokens);
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

function coupon(payload: YasPayload): YasCouponResults {
  expect(payload.results.kind).toBe('coupon');
  return payload.results as YasCouponResults;
}

describe('SRCH — the Treasury terms screen', () => {
  it('screens the seeded universe and says its prices are curve-derived', async () => {
    const { data, meta } = await runSRCH();

    expect(data.variant).toBe('default');
    expect(data.notes).toContain('NO_BOND_PRICE_SOURCE');
    expect(data.notes).toContain('SEED_UNIVERSE_ONLY');
    expect(data.universe.coverage).toBe('SEED_UNIVERSE_ONLY');
    expect(data.universe.size).toBe(SECURITIES.length);
    expect(data.pricing.basis).toBe('curve_derived_no_market_quotes');
    expect(data.pricing.curveId).toBe('UST_PAR');
    expect(data.pricing.curveDate).toBe(CURVE_DATE);
    expect(data.pricing.settlement).toBe(SETTLEMENT);
    expect(data.pricing.settlementRule).toBe('T+1 SIFMA');
    expect(data.pricing.engine?.inputsHash).toMatch(/^[0-9a-f]{64}$/);

    // The default criteria are bill/note/bond and fixed/zero coupons, so the TIPS is out.
    expect(data.counts.universe).toBe(SECURITIES.length);
    expect(data.counts.afterFilters).toBe(SECURITIES.length - 1);
    expect(data.counts.returned).toBe(SECURITIES.length - 1);
    expect(data.rows.some((row) => row.securityType === 'tips')).toBe(false);

    // Default sort is maturity ascending, and `rank` is the position in the whole result.
    const maturities = data.rows.map((row) => row.maturityDate);
    expect([...maturities].sort()).toEqual(maturities);
    expect(data.rows.map((row) => row.rank)).toEqual(data.rows.map((_, i) => i + 1));

    // There is no Treasury quote line, so nothing is live and the payload says why once.
    expect(SRCH.live).toBeNull();
    expect(meta.unavailable.find((row) => row.field === 'rows.live')?.reason).toBe('NO_SOURCE');
    expect(data.rows.every((row) => row.subject === `q:${String(row.instrumentId)}`)).toBe(true);
    for (const row of data.rows) {
      for (const cell of Object.values(row.cells)) expect(cell.live).toBeUndefined();
    }

    // ANAL-08: every analytic came out of an engine, and each engine note is complete.
    const names = meta.engines.map((engine) => engine.name).sort();
    expect(names).toContain('curve.interp');
    expect(names).toContain('bond.price');
    expect(names).toContain('bond.risk');
    expect(names).toContain('bill');
    expect(names).toContain('curve.bootstrap');
    for (const engine of meta.engines) {
      expect(engine.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(engine.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('gives a note the same numbers YAS gives it (ANAL-09)', async () => {
    const { data } = await runSRCH({ columns: [...ALL_COLUMNS], securityTypes: ['note', 'bond'] });
    const row = data.rows.find((r) => r.cusip === '91282CLM6');
    expect(row).toBeDefined();

    const yasPayload = await runYAS('NOTE_10Y');
    const yas = coupon(yasPayload);

    // MTY_YEARS is part of the parity, not decoration beside it: it is measured from the same
    // settlement date the priced columns are, so the row recomputes internally and the two screens
    // agree about the security's remaining life rather than differing by the T+1 day.
    expect(data.pricing.settlement).toBe(yasPayload.settlement.date);
    expect(row!.cells.MTY_YEARS!.v as number).toBeCloseTo(
      yasPayload.settlement.yearsToMaturity,
      12,
    );

    expect(row!.cells.YLD_YTM_MID!.v as number).toBeCloseTo(yas.yieldPct.v as number, 9);
    expect(row!.cells.PX_CLEAN_MID!.v as number).toBeCloseTo(yas.cleanPrice.v as number, 9);
    expect(row!.cells.DUR_ADJ_MID!.v as number).toBeCloseTo(yas.modifiedDuration.v as number, 9);
    expect(row!.cells.DV01!.v as number).toBeCloseTo(yas.dv01.v as number, 9);

    // Accrued is the column a convention error moves by a fraction of a coupon, so it is compared
    // through its own column rather than inferred from the two prices.
    const withAccrued = await runSRCH({
      columns: ['CUSIP', 'ACCRUED', 'PX_DIRTY_MID'],
      securityTypes: ['note', 'bond'],
    });
    const accruedRow = withAccrued.data.rows.find((r) => r.cusip === '91282CLM6')!;
    expect(accruedRow.cells.ACCRUED!.v as number).toBeCloseTo(yas.accrued.v as number, 9);
    expect(accruedRow.cells.PX_DIRTY_MID!.v as number).toBeCloseTo(yas.dirtyPrice.v as number, 9);
  });

  it('prices a bill on the bill curve and says when a rate was interpolated', async () => {
    const { data, meta } = await runSRCH({
      securityTypes: ['bill'],
      columns: [...ALL_COLUMNS],
    });
    expect(data.rows).toHaveLength(7);

    // The on-the-run 4WK sits on the curve: its discount rate is the published one, to the digit.
    const onCurve = data.rows.find((row) => row.cusip === '912797VE4')!;
    expect(onCurve.cells.DISC_RATE!.v).toBeCloseTo(3.69, 12);
    expect(onCurve.cells.BEY!.v as number).toBeGreaterThan(3.69);
    expect(onCurve.cells.YLD_YTM_MID!.v).toBe(onCurve.cells.BEY!.v);

    // The row recomputes from its own columns, which is only true while MTY_YEARS is measured from
    // settlement: `BEY = 365·d / (360 − d·t)` with `t = MTY_YEARS × 365`. Measured from the
    // valuation date instead, `t` is a day longer than the one the analytics used and this fails.
    const settleMs = Date.parse(`${data.pricing.settlement}T00:00:00.000Z`);
    const maturityMs = Date.parse(`${onCurve.cells.MATURITY!.v as string}T00:00:00.000Z`);
    const days = (maturityMs - settleMs) / 86_400_000;
    expect(onCurve.cells.MTY_YEARS!.v as number).toBeCloseTo(days / 365, 12);
    const discount = (onCurve.cells.DISC_RATE!.v as number) / 100;
    expect(onCurve.cells.BEY!.v as number).toBeCloseTo(
      (100 * 365 * discount) / (360 - discount * (onCurve.cells.MTY_YEARS!.v as number) * 365),
      9,
    );
    expect(onCurve.cells.PX_CLEAN_MID!.v as number).toBeLessThan(100);
    expect(onCurve.cells.DUR_ADJ_MID!.v as number).toBeGreaterThan(0);
    expect(onCurve.cells.DISC_RATE!.provIdx).toBeGreaterThanOrEqual(0);

    // The 42-day cash-management bill is on no tenor, so its rate is interpolated and says so.
    const interpolated = data.rows.find((row) => row.cusip === '912797CM0')!;
    expect(interpolated.cells.DISC_RATE!.v).not.toBeNull();
    const note = meta.unavailable.find((row) => row.field === 'rows.912797CM0.DISC_RATE');
    expect(note?.reason).toBe('NO_SOURCE');
    expect(note?.detail).toContain('discount rate interpolated');

    // A bill has no coupon, and the payload says so rather than leaving a bare null unexplained.
    expect(data.rows.every((row) => row.couponRate === null)).toBe(true);
    expect(meta.unavailable.find((row) => row.field === 'rows.couponRate')?.reason).toBe(
      'NOT_APPLICABLE',
    );
  });

  it('keeps a TIPS row’s terms and refuses its analytics', async () => {
    const { data, meta } = await runSRCH({
      securityTypes: ['tips'],
      couponTypes: ['inflation_linked'],
      columns: [...ALL_COLUMNS],
    });

    expect(data.rows).toHaveLength(1);
    const row = data.rows[0]!;
    expect(row.cusip).toBe('91282CLT6');
    // Terms are real…
    expect(row.cells.CUSIP!.v).toBe('91282CLT6');
    expect(row.cells.CPN!.v).toBe(1.75);
    expect(row.cells.MATURITY!.v).toBe('2036-01-15');
    // …and every analytic is `na` with a reason, not a nominal price.
    for (const id of ['YLD_YTM_MID', 'PX_CLEAN_MID', 'DUR_ADJ_MID', 'DV01'] as const) {
      expect(row.cells[id]!.v).toBeNull();
      expect(row.cells[id]!.st).toBe('na');
      expect(row.cells[id]!.r).toBe('NOT_IN_UNIVERSE');
    }
    expect(data.notes).toContain('TIPS_FRN_NOT_PRICED');
    expect(data.counts.excludedNotPriced).toBe(1);
    const entry = meta.unavailable.find((u) => u.field === 'rows.91282CLT6.analytics');
    expect(entry?.reason).toBe('NOT_APPLICABLE');
    expect(entry?.detail).toContain('inflation/reference-rate engine');
  });

  it('filters by the criteria it reports, and the counts are the row counts', async () => {
    // Equivalent windows: years from the valuation date, and the dates those years fall on.
    const byYears = await runSRCH({ yearsFrom: 5, yearsTo: 30, securityTypes: ['note', 'bond'] });
    const byDates = await runSRCH({
      maturityFrom: '2031-09-15',
      maturityTo: '2056-09-15',
      securityTypes: ['note', 'bond'],
    });
    expect(byYears.data.rows.map((row) => row.cusip)).toEqual(
      byDates.data.rows.map((row) => row.cusip),
    );
    // The 5Y matures 2031-08-31, a fortnight before the five-year mark, so it is out of both
    // windows — which is the point of running the two forms against each other.
    expect(byYears.data.rows.map((row) => row.cusip)).toEqual([
      '91282CJK8',
      '91282CLM6',
      '912810UE6',
      '912810UF3',
    ]);

    // A coupon window excludes every bill: a bill has no coupon to be inside it.
    const withCoupon = await runSRCH({ couponFrom: 4 });
    expect(withCoupon.data.rows.every((row) => (row.couponRate ?? 0) >= 4)).toBe(true);
    expect(withCoupon.data.rows.some((row) => row.securityType === 'bill')).toBe(false);
    const couponFilter = withCoupon.data.filters.find((f) => f.field === 'coupon')!;
    expect(couponFilter.matched).toBe(
      SECURITIES.filter((s) => (s.couponRate ?? -1) >= 4).length,
    );

    // On-the-run only, and the CUSIP prefix that names the bill file.
    const otr = await runSRCH({ onTheRun: 'only' });
    expect(otr.data.rows.every((row) => row.onTheRun)).toBe(true);
    expect(otr.data.filters.find((f) => f.field === 'onTheRun')!.matched).toBe(
      SECURITIES.filter((s) => s.onTheRun).length,
    );

    const bills = await runSRCH({ cusip: '912797', securityTypes: ['bill'] });
    expect(bills.data.rows).toHaveLength(SECURITIES.filter((s) => s.cusip.startsWith('912797')).length);
    expect(bills.data.filters.find((f) => f.field === 'cusip')!.matched).toBe(
      SECURITIES.filter((s) => s.cusip.startsWith('912797')).length,
    );

    // An amount floor keeps only the large issues and flags that the column is not always published.
    const large = await runSRCH({ minAmountOutstanding: 7e10 });
    expect(large.data.rows.every((row) => (row.amountOutstanding ?? 0) >= 7e10)).toBe(true);
    expect(large.data.filters.find((f) => f.field === 'minAmountOutstanding')!.unavailableReason)
      .toBe('AMOUNT_OUTSTANDING_NOT_PUBLISHED_FOR_EVERY_SECURITY');

    // Facets count the filtered set, not the page.
    const { data } = await runSRCH();
    const facetTotal = data.facets.securityType.reduce((sum, f) => sum + f.count, 0);
    expect(facetTotal).toBe(data.counts.afterFilters);
    expect(data.facets.onTheRun.reduce((sum, f) => sum + f.count, 0)).toBe(
      data.counts.afterFilters,
    );
    expect(data.facets.maturityBucket.reduce((sum, f) => sum + f.count, 0)).toBe(
      data.counts.afterFilters,
    );
  });

  it('sorts on an analytic column with nulls last in both directions', async () => {
    const desc = await runSRCH({
      columns: [...ALL_COLUMNS],
      securityTypes: ['bill', 'note', 'bond', 'tips'],
      couponTypes: ['fixed', 'zero', 'inflation_linked'],
      sort: { col: 'YLD_YTM_MID', dir: 'desc' },
    });
    const values = desc.data.rows.map((row) => row.cells.YLD_YTM_MID!.v as number | null);
    const present = values.filter((v): v is number => v !== null);
    expect(present.length).toBe(values.length - 1); // the TIPS has no yield
    expect(values.at(-1)).toBeNull();
    for (let i = 1; i < present.length; i += 1) expect(present[i]! <= present[i - 1]!).toBe(true);

    const asc = await runSRCH({
      columns: [...ALL_COLUMNS],
      securityTypes: ['bill', 'note', 'bond', 'tips'],
      couponTypes: ['fixed', 'zero', 'inflation_linked'],
      sort: { col: 'YLD_YTM_MID', dir: 'asc' },
    });
    const ascValues = asc.data.rows.map((row) => row.cells.YLD_YTM_MID!.v as number | null);
    expect(ascValues.at(-1)).toBeNull();
  });

  it('pages forward and back over one sorted result', async () => {
    const first = await runSRCH({ pageSize: 10 });
    expect(first.data.rows).toHaveLength(10);
    expect(first.meta.page?.index).toBe(0);
    expect(first.meta.page?.count).toBe(SECURITIES.length - 1);
    expect(first.meta.page?.cursor).not.toBeNull();

    const cursor = JSON.parse(
      Buffer.from(first.meta.page!.cursor!, 'base64url').toString('utf8'),
    ) as { v: unknown; id: number };
    const last = first.data.rows.at(-1)!;
    expect(cursor.id).toBe(last.instrumentId);
    expect(cursor.v).toBe(last.maturityDate);

    const second = await pageSRCH(first.meta.resultId, 'fwd');
    expect(second.data.rows).toHaveLength(SECURITIES.length - 1 - 10);
    // `rank` is global, not per page, and no security appears twice.
    expect(second.data.rows[0]!.rank).toBe(11);
    const seen = new Set([...first.data.rows, ...second.data.rows].map((row) => row.cusip));
    expect(seen.size).toBe(SECURITIES.length - 1);
    expect(second.meta.page?.cursor).toBeNull();

    const back = await pageSRCH(second.meta.resultId, 'back');
    expect(back.data.rows.map((row) => row.cusip)).toEqual(
      first.data.rows.map((row) => row.cusip),
    );
  });

  it('is still a terms screen when no curve is stored', async () => {
    await t.client.query(`DELETE FROM curve_points WHERE curve_id = 'UST_PAR'`);

    const { data, meta } = await runSRCH({ columns: [...ALL_COLUMNS] });
    expect(data.counts.afterFilters).toBe(SECURITIES.length - 1);
    expect(data.pricing.curveDate).toBeNull();
    expect(data.pricing.buildId).toBeNull();
    expect(data.pricing.basis).toBe('curve_derived_no_market_quotes');

    const note = data.rows.find((row) => row.cusip === '91282CLM6')!;
    // Terms survive…
    expect(note.cells.CUSIP!.v).toBe('91282CLM6');
    expect(note.cells.MATURITY!.v).toBe('2036-08-15');
    expect(note.cells.MTY_YEARS!.v as number).toBeGreaterThan(9);
    // …and every analytic is blank with a reason rather than a number from nowhere.
    for (const id of ['YLD_YTM_MID', 'PX_CLEAN_MID', 'DUR_ADJ_MID', 'DV01'] as const) {
      expect(note.cells[id]!.v).toBeNull();
      expect(note.cells[id]!.st).toBe('blank');
      expect(note.cells[id]!.r).toBe('PROVIDER_DOWN');
    }
    expect(meta.unavailable.find((row) => row.field === 'pricing')?.reason).toBe('NO_SOURCE');
    // Facets and counts are unaffected: they are terms facts.
    expect(data.facets.securityType.reduce((sum, f) => sum + f.count, 0)).toBe(
      data.counts.afterFilters,
    );
  });

  it('round-trips a saved search, and explicit params win over it', async () => {
    const saved = await t.client.query<{ search_id: string }>(
      `INSERT INTO saved_searches (owner_user_id, firm_id, kind, name, query)
       VALUES ($1, $2, 'srch', 'Long benchmarks', $3::jsonb) RETURNING search_id`,
      [
        env.userId,
        env.firmId,
        JSON.stringify({ securityTypes: ['bond'], onTheRun: 'only' }),
      ],
    );
    const searchId = Number(saved.rows[0]!.search_id);

    const loaded = await runSRCH({ savedSearchId: searchId });
    expect(loaded.data.savedSearch).toEqual({ searchId, name: 'Long benchmarks' });
    expect(loaded.data.rows.map((row) => row.cusip)).toEqual(['912810UE6', '912810UF3']);

    // An explicitly typed criterion beats the stored one.
    const overridden = await runSRCH({ savedSearchId: searchId, securityTypes: ['bill'] });
    expect(overridden.data.rows.every((row) => row.securityType === 'bill')).toBe(true);

    // An id that is not this user's is a reason, not an error, and the typed params still run.
    const other = await runSRCH({ savedSearchId: searchId + 10_000, securityTypes: ['bond'] });
    expect(other.data.savedSearch).toBeNull();
    expect(
      other.meta.unavailable.find((row) => row.field === 'savedSearch')?.detail,
    ).toContain('not found or not owned');
    expect(other.data.rows.every((row) => row.securityType === 'bond')).toBe(true);
  });

  it('reads the terms as they were believed, not as they are now (REF-03)', async () => {
    const before = await runSRCH({ onTheRun: 'only', securityTypes: ['note', 'bond'] });
    expect(before.data.rows.map((row) => row.cusip)).toContain('91282CLM6');


    // The 10Y stops being the benchmark, as a correction believed from one instant on. The cut is
    // `clock_timestamp()` rather than `now()`: inside one transaction `now()` is the transaction's
    // own start, and closing a version at its own `tx_from` is not a correction, it is a
    // zero-width row the table refuses.
    // The driver hands a `timestamptz` back as a `Date`, and `Date.parse` on a `Date` goes through
    // its locale string and loses the milliseconds — which is a whole tenth of a second of
    // versions here. The instant is normalised once, and every use below is of the ISO string.
    const cut = await t.client.query<{ at: Date }>(`SELECT clock_timestamp() AS at`);
    const cutAt = new Date(cut.rows[0]!.at).toISOString();
    await t.client.query(
      `UPDATE govt_terms SET tx_to = $1::timestamptz
        WHERE cusip = '91282CLM6' AND tx_to = 'infinity'`,
      [cutAt],
    );
    await t.client.query(
      `INSERT INTO govt_terms (instrument_id, security_type, cusip, term_label, issue_date,
                               dated_date, maturity_date, coupon_type, coupon_rate, coupon_freq,
                               day_count, business_day_conv, calendar_id, settlement_days,
                               min_denomination, amount_outstanding, on_the_run, valid_from,
                               tx_from, provenance_id)
       SELECT instrument_id, security_type, cusip, term_label, issue_date, dated_date,
              maturity_date, coupon_type, coupon_rate, coupon_freq, day_count, business_day_conv,
              calendar_id, settlement_days, min_denomination, amount_outstanding, false,
              valid_from, $1::timestamptz, provenance_id
         FROM govt_terms WHERE cusip = '91282CLM6' AND tx_to <> 'infinity'
        ORDER BY version_id DESC LIMIT 1`,
      [cutAt],
    );

    const later = new Date(Date.parse(cutAt) + 1_000).toISOString();
    // One millisecond before the correction — which is as fine a grain as the driver reports, and
    // `env.knownAt` is a second past the seed, so the correction lands inside it and re-reading
    // there would see the new version and prove nothing.
    const earlierAt = new Date(Date.parse(cutAt) - 1).toISOString();
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/SRCH/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { onTheRun: 'only', securityTypes: ['note', 'bond'] },
        asOf: { validAt: GOLDEN_ISO, knownAt: later },
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const after = res.json<Run>();
    expect(after.data.rows.map((row) => row.cusip)).not.toContain('91282CLM6');

    // …and the earlier belief is unchanged.
    const againRes = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/SRCH/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { onTheRun: 'only', securityTypes: ['note', 'bond'] },
        asOf: { validAt: GOLDEN_ISO, knownAt: earlierAt },
      },
    });
    expect(againRes.statusCode, againRes.payload).toBe(200);
    const again = againRes.json<Run>();
    expect(again.data.rows.map((row) => row.cusip)).toContain('91282CLM6');
  });

  it('parses the SRCH criteria language and drops what it cannot read', () => {
    expect(parseSrchCriteria('MTY_YEARS=2..10 CPN>4 AMT>50B').patch).toEqual({
      yearsFrom: 2,
      yearsTo: 10,
      couponFrom: 4,
      minAmountOutstanding: 5e10,
    });
    expect(parseSrchCriteria('CPN=3..5').patch).toEqual({ couponFrom: 3, couponTo: 5 });
    const bad = parseSrchCriteria('NOT_A_FACTOR>1 CPN>>2 MTY_YEARS<7');
    expect(bad.patch).toEqual({ yearsTo: 7 });
    expect(bad.problems.map((problem) => problem.code)).toEqual(['ARG_PARSE', 'ARG_PARSE']);

    // The manifest's own defaults, since the grammar is what fills them.
    const defaults = SrchParams.parse({});
    expect(defaults.market).toBe('UST');
    expect(defaults.securityTypes).toEqual(['bill', 'note', 'bond']);
    expect(defaults.sort).toEqual({ col: 'MATURITY', dir: 'asc' });
    expect(defaults.pageSize).toBe(50);
    expect(defaults.curveId).toBe('UST_PAR');
  });

  it('exports the page it is showing, with the pricing basis in the columns', async () => {
    const { data } = await runSRCH({ columns: [...ALL_COLUMNS] });
    const params = SrchParams.parse({ columns: [...ALL_COLUMNS] });
    const columns = (SRCH.csv.columns as (p: unknown, d: unknown) => { id: string }[])(
      params,
      data,
    );
    const ids = columns.map((column) => column.id);
    // The fixed prefix, then the analytic columns the payload carries, then the pricing trailer.
    expect(ids.slice(0, 3)).toEqual(['rank', 'key', 'cusip']);
    expect(ids).toContain('YLD_YTM_MID');
    expect(ids.slice(-5)).toEqual([
      'curveId',
      'curveDate',
      'settlement',
      'pricingBasis',
      'source',
    ]);
    // A column the prefix already reports is not repeated under its screen spelling.
    expect(ids).not.toContain('CUSIP');
    expect(ids).not.toContain('MATURITY');

    const rows = SRCH.csv.rows(data, params);
    expect(rows).toHaveLength(data.rows.length);
    const first = rows[0]!;
    expect(first[0]).toBe(1);
    expect(first[1]).toBe(data.rows[0]!.key);
    expect(first.at(-2)).toBe('curve_derived_no_market_quotes');
    expect(first.at(-3)).toBe(SETTLEMENT);
    expect(SRCH.csv.filename(params, { display: null, asOf: GOLDEN_ISO })).toBe(
      `SRCH_UST_${GOLDEN_ISO.replace(/[-:]/g, '')}.csv`,
    );
  });

  it('matches the committed goldens', async () => {
    const all = await runSRCH({
      columns: [...ALL_COLUMNS],
      securityTypes: ['bill', 'note', 'bond', 'tips'],
      couponTypes: ['fixed', 'zero', 'inflation_linked'],
      pageSize: 20,
    });
    expectGolden('SRCH.default.json', normalise(all.data));

    const bills = await runSRCH({
      securityTypes: ['bill'],
      onTheRun: 'only',
      columns: ['CUSIP', 'MATURITY', 'DISC_RATE', 'BEY'],
    });
    expectGolden('SRCH.default.bills.json', normalise(bills.data));
  });
});
