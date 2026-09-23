/**
 * `test/integration/functions/FA.test.ts` — WP-10's acceptance row for `FA`
 * ("AAPL IS/BS/CF for FY and Q from the seeded facts; `knownAt` before and after a restatement
 * returns different numbers; as-reported toggle cites `fact_id`").
 *
 * The middle claim is the one the whole point-in-time design exists for, and it is the only one a
 * single-version fixture cannot make. `fin_statements` is versioned on `filed_at`: the restated
 * CY2026Q2 revenue below is a *second row* for the same `period_end`, filed 2026-07-31, not an
 * update of the first. A reader that ignores `filed_at` answers a June question with a July number
 * and nothing about the shape of the answer says so. Both assertions are therefore made against the
 * same request with two `KNOWN=` values, and both numbers are asserted — a test that only checked
 * "the new number" would pass against a resolver with no point-in-time logic at all.
 *
 * ## No seed
 *
 * WP-15 owns the seed and it does not exist. Every firm, user, grant, issuer, instrument, filing,
 * fact and statement here is created inside this file's own `withTxDb()` transaction, and nothing
 * depends on a literal instrument id: the goldens are compared after the sequence values are
 * replaced by stable tokens.
 *
 * ## The clock
 *
 * `GOLDEN_CAPTURE_MS` (2026-09-15T18:41:28Z) is `asOf.validAt`. `asOf.knownAt` is the *wall clock*
 * of the write that seeded the run, because a bitemporal read at a `knownAt` earlier than `tx_from`
 * sees none of the rows (TESTING §4.3); the payload's echo of it is normalised to `<KNOWN_AT>`.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden, idToken, subjectToken } from './golden.js';

import type { NormalisedUpdate } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { FA } from '@terminal/core/functions/manifests/FA';
import type {
  FaEquityPayload,
  FaFundPayload,
  FaPayload,
} from '@terminal/core/functions/manifests/FA';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import * as FaModule from '../../../src/functions/FA/resolve.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { GOLDEN_CAPTURE_MS } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = '2020-01-01T00:00:00.000Z';
const CIK = '0000320193';
const SPY_CIK = '0000884394';

/** `md_lines_symbol_excl` is a global namespace; `normalise` strips this again. */
const TAG = `.t${randomUUID().slice(0, 8)}`;

const REGISTRY = new FunctionRegistry([FA]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { FA: FaModule };

const t: TestDb = withTxDb();

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  issuerId: number;
  aaplId: number;
  spyId: number;
  spyLineId: number;
  msftId: number;
  prov: Map<string, number>;
  factIds: Record<string, number>;
}

let env: Env;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function nextId(seq: string): Promise<number> {
  const res = await t.client.query<{ id: string }>(`SELECT nextval($1)::bigint AS id`, [seq]);
  return Number(res.rows[0]!.id);
}

async function ensureLicences(): Promise<void> {
  const present = await t.client.query(
    `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
  );
  if (present.rowCount === 0) await seedLicences(t.client);
}

async function provenanceFor(sourceId: string): Promise<number> {
  const held = env.prov.get(sourceId);
  if (held !== undefined) return held;
  const key = `fa-${sourceId}-${randomUUID()}`;
  const res = await t.client.query<{ provenance_id: string }>(
    `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                             http_status, bytes, captured_at, source_ts, adapter_version)
     VALUES ($1,$2,'test://fa/' || $2, digest($2,'sha256'), digest($2,'sha256'), 200, 0, $3, $3,
             'test/1.0.0')
     RETURNING provenance_id`,
    [sourceId, key, GOLDEN_ISO],
  );
  const id = Number(res.rows[0]!.provenance_id);
  env.prov.set(sourceId, id);
  return id;
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

interface SecuritySpec {
  ticker: string;
  name: string;
  assetClass: 'equity' | 'etf';
  issuerId: number;
  line?: boolean;
}

async function seedSecurity(
  spec: SecuritySpec,
): Promise<{ instrumentId: number; listingId: number; mdLineId: number | null }> {
  const p = await provenanceFor('openfigi.mapping');
  const issueId = await nextId('issue_id_seq');
  const instrumentId = await nextId('instrument_id_seq');
  const listingId = await nextId('listing_id_seq');

  await t.client.query(
    `INSERT INTO issues (issue_id, issuer_id, asset_class, security_type, name, currency,
                         country_of_issue, valid_from, tx_from, provenance_id)
     VALUES ($1,$2,$3::asset_class,$4,$5,'USD','US',$6::timestamptz,$6::timestamptz,$7)`,
    [
      issueId,
      spec.issuerId,
      spec.assetClass,
      spec.assetClass === 'etf' ? 'ETP' : 'Common Stock',
      spec.name,
      VALID_FROM,
      p,
    ],
  );
  await t.client.query(
    `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                              exch_code, name, currency, status, search_weight, price_decimals,
                              primary_listing_id, valid_from, tx_from, provenance_id)
     VALUES ($1,$2,$3::asset_class,'Equity'::market_sector,$4,'US',$5,'USD','active',5,2,$6,
             $7::timestamptz,$7::timestamptz,$8)`,
    [instrumentId, issueId, spec.assetClass, spec.ticker, spec.name, listingId, VALID_FROM, p],
  );
  await t.client.query(
    `INSERT INTO listings (listing_id, instrument_id, mic, exch_code, local_ticker, is_primary,
                           valid_from, tx_from, provenance_id)
     VALUES ($1,$2,'XNAS','UW',$3,true,$4::timestamptz,$4::timestamptz,$5)`,
    [listingId, instrumentId, spec.ticker, VALID_FROM, p],
  );

  let mdLineId: number | null = null;
  if (spec.line === true) {
    const lineProv = await provenanceFor('cboe.quotes');
    mdLineId = await nextId('md_line_id_seq');
    await t.client.query(
      `INSERT INTO md_lines (md_line_id, instrument_id, listing_id, source_id, provider_symbol,
                             line_kind, intrinsic_delay_min, expected_interval_ms, priority,
                             valid_from, tx_from, provenance_id)
       VALUES ($1,$2,$3,'cboe.quotes',$4,'composite',15,10000,10,$5::timestamptz,$5::timestamptz,$6)`,
      [mdLineId, instrumentId, listingId, `${spec.ticker}${TAG}`, VALID_FROM, lineProv],
    );
  }
  return { instrumentId, listingId, mdLineId };
}

/** One `fin_statements` version. A restatement is another call with a later `filedAt`. */
async function seedStatement(spec: {
  periodEnd: string;
  periodType: 'Q' | 'FY';
  filedAt: string;
  fiscalYear: number;
  fiscalPeriod: string;
  accessionNo: string;
  revenue: number;
  netInc: number;
  epsDil: number;
  factId: number;
}): Promise<void> {
  const prov = await provenanceFor('sec.companyfacts');
  await t.client.query(
    `INSERT INTO fin_statements
       (issuer_id, period_end, period_type, filed_at, mapping_version, fiscal_year, fiscal_period,
        accession_no, currency, revenue, cogs, gross_profit, opex, rnd, oper_inc, int_exp,
        pretax_inc, tax, net_inc, eps_basic, eps_dil, shares_dil, tot_assets, tot_liab, equity,
        cash, lt_debt, cfo, capex, fcf, div_paid, buyback, dps, dda, derived_q4, as_reported,
        engine_name, engine_version, inputs_hash, provenance_ids)
     VALUES ($1,$2::date,$3,$4::date,'std-map/2026.09',$5,$6,$7::char(20),'USD',
             $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
             $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, false,
             $33::jsonb,'fundamentals/std-map','std-map/2026.09',repeat('a',64),ARRAY[$34::bigint])`,
    [
      env.issuerId,
      spec.periodEnd,
      spec.periodType,
      spec.filedAt,
      spec.fiscalYear,
      spec.fiscalPeriod,
      spec.accessionNo,
      spec.revenue,
      spec.revenue * 0.55,
      spec.revenue * 0.45,
      spec.revenue * 0.13,
      spec.revenue * 0.08,
      spec.revenue * 0.3,
      spec.revenue * 0.002,
      spec.revenue * 0.31,
      spec.revenue * 0.045,
      spec.netInc,
      spec.epsDil + 0.02,
      spec.epsDil,
      15_200_000_000,
      364_980_000_000,
      308_030_000_000,
      56_950_000_000,
      61_800_000_000,
      86_200_000_000,
      spec.netInc * 1.15,
      -spec.revenue * 0.03,
      spec.netInc * 1.15 - spec.revenue * 0.03,
      -15_100_000_000,
      -68_500_000_000,
      0.26,
      spec.revenue * 0.031,
      JSON.stringify({
        REVENUE: {
          concept: 'RevenueFromContractWithCustomerExcludingAssessedTax',
          taxonomy: 'us-gaap',
          value: spec.revenue,
          fact_id: spec.factId,
        },
        NET_INC: {
          concept: 'NetIncomeLoss',
          taxonomy: 'us-gaap',
          value: spec.netInc,
          fact_id: spec.factId,
        },
      }),
      prov,
    ],
  );
}

/** One XBRL fact, so the as-reported drill points at a row that exists. */
async function seedFact(spec: {
  concept: string;
  periodEnd: string;
  filedAt: string;
  accessionNo: string;
  value: number;
  form: string;
}): Promise<number> {
  const prov = await provenanceFor('sec.companyfacts');
  const res = await t.client.query<{ fact_id: string }>(
    `INSERT INTO xbrl_facts (cik, issuer_id, taxonomy, concept, unit, period_start, period_end, fy,
                             fp, form, accession_no, filed_at, value, captured_at, provenance_id)
     VALUES ($1,$2,'us-gaap',$3,'USD',NULL,$4::date,NULL,NULL,$5,$6::char(20),$7::date,$8,
             $9::timestamptz,$10)
     RETURNING fact_id`,
    [
      CIK,
      env.issuerId,
      spec.concept,
      spec.periodEnd,
      spec.form,
      spec.accessionNo,
      spec.filedAt,
      spec.value,
      GOLDEN_ISO,
      prov,
    ],
  );
  return Number(res.rows[0]!.fact_id);
}

async function seedFiling(spec: {
  cik: string;
  accessionNo: string;
  form: string;
  filedDate: string;
  reportDate: string | null;
  items?: string;
}): Promise<void> {
  const prov = await provenanceFor('sec.submissions');
  const url =
    `https://www.sec.gov/Archives/edgar/data/${spec.cik.replace(/^0+/, '')}/` +
    `${spec.accessionNo.replace(/-/g, '')}/${spec.accessionNo}-index.htm`;
  await t.client.query(
    `INSERT INTO filings (accession_no, cik, issuer_id, form, filed_date, accepted_at, report_date,
                          items, primary_doc, primary_doc_desc, is_xbrl, is_inline_xbrl, size_bytes,
                          url, captured_at, provenance_id)
     VALUES ($1::char(20),$2,$3::bigint,$4,$5::date,$6::timestamptz,$7::date,$8::text[],
             'primary.htm',$9,true,true,4821004,$10,$11::timestamptz,$12)`,
    [
      spec.accessionNo,
      spec.cik,
      env.issuerId,
      spec.form,
      spec.filedDate,
      `${spec.filedDate}T20:31:00Z`,
      spec.reportDate,
      spec.items ?? '{}',
      `${spec.form} filing`,
      url,
      GOLDEN_ISO,
      prov,
    ],
  );
}

function update(spec: {
  instrumentId: number;
  mdLineId: number;
  provenanceId: number;
  fields: NormalisedUpdate['fields'];
}): NormalisedUpdate {
  return {
    subject: `q:${String(spec.instrumentId)}`,
    instrumentId: spec.instrumentId,
    mdLineId: spec.mdLineId,
    assetClass: 'etf',
    tier: 'delayed',
    fields: spec.fields,
    ts: { src: GOLDEN_CAPTURE_MS - 60_000, cap: GOLDEN_CAPTURE_MS, pub: 0 },
    prov: { sourceId: 'cboe.quotes', provenanceId: spec.provenanceId },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The universe
// ─────────────────────────────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await ensureLicences();

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`FA Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1,$2,'FA User','user') RETURNING user_id`,
    [firmId, `fa-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1,$2,'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  await grantEverySource(firmId, userId);

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
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    knownAt: '',
    issuerId: 0,
    aaplId: 0,
    spyId: 0,
    spyLineId: 0,
    msftId: 0,
    prov: new Map(),
    factIds: {},
  };

  const secProv = await provenanceFor('sec.submissions');

  // ── the issuer ────────────────────────────────────────────────────────────────────────────
  env.issuerId = await nextId('issuer_id_seq');
  await t.client.query(
    `INSERT INTO issuers (issuer_id, name, legal_name, cik, country, sic, sic_description,
                          entity_type, fiscal_year_end, filer_category, website, valid_from,
                          tx_from, provenance_id)
     VALUES ($1,'Apple Inc','Apple Inc.',$2,'US','3571','Electronic Computers','operating','0926',
             'Large accelerated filer','https://www.apple.com',$3::timestamptz,$3::timestamptz,$4)`,
    [env.issuerId, CIK, VALID_FROM, secProv],
  );

  const aapl = await seedSecurity({
    ticker: 'AAPL',
    name: 'Apple Inc',
    assetClass: 'equity',
    issuerId: env.issuerId,
  });
  env.aaplId = aapl.instrumentId;

  // ── statements: three fiscal years, three quarters, and one restatement ───────────────────
  env.factIds.fy2025 = await seedFact({
    concept: 'RevenueFromContractWithCustomerExcludingAssessedTax',
    periodEnd: '2025-09-27',
    filedAt: '2025-10-31',
    accessionNo: '0000320193-25-000101',
    value: 416_161_000_000,
    form: '10-K',
  });
  env.factIds.q2Original = await seedFact({
    concept: 'RevenueFromContractWithCustomerExcludingAssessedTax',
    periodEnd: '2026-03-28',
    filedAt: '2026-05-02',
    accessionNo: '0000320193-26-000031',
    value: 95_359_000_000,
    form: '10-Q',
  });
  env.factIds.q2Restated = await seedFact({
    concept: 'RevenueFromContractWithCustomerExcludingAssessedTax',
    periodEnd: '2026-03-28',
    filedAt: '2026-07-31',
    accessionNo: '0000320193-26-000055',
    value: 94_836_000_000,
    form: '10-Q/A',
  });

  await seedStatement({
    periodEnd: '2023-09-30',
    periodType: 'FY',
    filedAt: '2023-11-03',
    fiscalYear: 2023,
    fiscalPeriod: 'FY',
    accessionNo: '0000320193-23-000106',
    revenue: 383_285_000_000,
    netInc: 96_995_000_000,
    epsDil: 6.13,
    factId: env.factIds.fy2025,
  });
  await seedStatement({
    periodEnd: '2024-09-28',
    periodType: 'FY',
    filedAt: '2024-11-01',
    fiscalYear: 2024,
    fiscalPeriod: 'FY',
    accessionNo: '0000320193-24-000123',
    revenue: 391_035_000_000,
    netInc: 93_736_000_000,
    epsDil: 6.08,
    factId: env.factIds.fy2025,
  });
  await seedStatement({
    periodEnd: '2025-09-27',
    periodType: 'FY',
    filedAt: '2025-10-31',
    fiscalYear: 2025,
    fiscalPeriod: 'FY',
    accessionNo: '0000320193-25-000101',
    revenue: 416_161_000_000,
    netInc: 101_240_000_000,
    epsDil: 6.72,
    factId: env.factIds.fy2025,
  });

  await seedStatement({
    periodEnd: '2025-12-27',
    periodType: 'Q',
    filedAt: '2026-02-01',
    fiscalYear: 2026,
    fiscalPeriod: 'Q1',
    accessionNo: '0000320193-26-000010',
    revenue: 128_411_000_000,
    netInc: 37_180_000_000,
    epsDil: 2.44,
    factId: env.factIds.q2Original,
  });
  // The original CY2026Q2 version, filed 2026-05-02…
  await seedStatement({
    periodEnd: '2026-03-28',
    periodType: 'Q',
    filedAt: '2026-05-02',
    fiscalYear: 2026,
    fiscalPeriod: 'Q2',
    accessionNo: '0000320193-26-000031',
    revenue: 95_359_000_000,
    netInc: 24_780_000_000,
    epsDil: 1.63,
    factId: env.factIds.q2Original,
  });
  // …and the restatement of the same period, filed 2026-07-31. Two rows, not an update.
  await seedStatement({
    periodEnd: '2026-03-28',
    periodType: 'Q',
    filedAt: '2026-07-31',
    fiscalYear: 2026,
    fiscalPeriod: 'Q2',
    accessionNo: '0000320193-26-000055',
    revenue: 94_836_000_000,
    netInc: 24_402_000_000,
    epsDil: 1.6,
    factId: env.factIds.q2Restated,
  });
  await seedStatement({
    periodEnd: '2026-06-27',
    periodType: 'Q',
    filedAt: '2026-08-01',
    fiscalYear: 2026,
    fiscalPeriod: 'Q3',
    accessionNo: '0000320193-26-000061',
    revenue: 89_204_000_000,
    netInc: 22_960_000_000,
    epsDil: 1.51,
    factId: env.factIds.q2Restated,
  });

  // ── the fund: SPY, its terms, its holdings and its filings ────────────────────────────────
  const spyIssuerId = await nextId('issuer_id_seq');
  await t.client.query(
    `INSERT INTO issuers (issuer_id, name, cik, country, entity_type, valid_from, tx_from,
                          provenance_id)
     VALUES ($1,'SPDR S&P 500 ETF Trust',$2,'US','fund',$3::timestamptz,$3::timestamptz,$4)`,
    [spyIssuerId, SPY_CIK, VALID_FROM, secProv],
  );
  const spy = await seedSecurity({
    ticker: 'SPY',
    name: 'SPDR S&P 500 ETF Trust',
    assetClass: 'etf',
    issuerId: spyIssuerId,
    line: true,
  });
  env.spyId = spy.instrumentId;
  env.spyLineId = spy.mdLineId!;

  const msft = await seedSecurity({
    ticker: 'MSFT',
    name: 'Microsoft Corp',
    assetClass: 'equity',
    issuerId: env.issuerId,
  });
  env.msftId = msft.instrumentId;

  await t.client.query(
    `INSERT INTO fund_terms (instrument_id, fund_type, sponsor, cik, expense_ratio, inception_date,
                             distribution_freq, valid_from, tx_from, provenance_id)
     VALUES ($1,'etf','State Street Global Advisors',$2,0.000945,'1993-01-22','quarterly',
             $3::timestamptz,$3::timestamptz,$4)`,
    [env.spyId, SPY_CIK, VALID_FROM, secProv],
  );

  const nportProv = await provenanceFor('sec.archives');
  const holdings: [number, string, number | null, number, number, string][] = [
    [1, 'APPLE INC', env.aaplId, 0.0712, 41_200_000_000, 'EC'],
    [2, 'MICROSOFT CORP', env.msftId, 0.0651, 37_650_000_000, 'EC'],
    [3, 'NVIDIA CORP', null, 0.0604, 34_940_000_000, 'EC'],
    [4, 'US DOLLARS', null, 0.0021, 1_210_000_000, 'STIV'],
  ];
  for (const [lineNo, name, id, weight, mv, cat] of holdings) {
    await t.client.query(
      `INSERT INTO etf_holdings (etf_instrument_id, as_of_date, source_id, line_no,
                                 holding_instrument_id, name, shares, market_value, weight,
                                 asset_cat, country, provenance_id)
       VALUES ($1,'2026-09-14','sec.archives',$2,$3,$4,1000000,$5,$6,$7,'US',$8)`,
      [env.spyId, lineNo, id, name, mv, weight, cat, nportProv],
    );
  }

  await seedFiling({
    cik: SPY_CIK,
    accessionNo: '0000884394-26-000012',
    form: 'NPORT-P',
    filedDate: '2026-08-28',
    reportDate: '2026-06-30',
  });
  await seedFiling({
    cik: SPY_CIK,
    accessionNo: '0000884394-26-000004',
    form: 'N-CEN',
    filedDate: '2026-03-12',
    reportDate: '2025-12-31',
  });

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  env.knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  harness.deps.plant.apply(
    update({
      instrumentId: env.spyId,
      mdLineId: env.spyLineId,
      provenanceId: await provenanceFor('cboe.quotes'),
      fields: { PX_LAST: 662.41, CHG_PCT_1D: 0.37 },
    }),
  );
});

afterEach(async () => {
  await env.harness.close();
});

async function runFA(
  instrumentId: number,
  params: Record<string, unknown> = {},
): Promise<{ data: FaPayload; meta: { unavailable: { field: string; reason: string; detail: string }[] } }> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/FA/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params,
      security: { id: instrumentId },
      asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json();
}

const equityOf = (data: FaPayload): FaEquityPayload => {
  expect(data.variant).toBe('equity');
  return data as FaEquityPayload;
};

/**
 * The keys of an FA payload that hold a sequence-allocated id: the issuer block's `issuerId`, and
 * the `instrumentId` of the fund, of a top-10 holding and of a tracked index (§FA). `fieldId`
 * (`'SALES_REV_TURN'`) and `sourceId` (`'sec.archives'`) are names, not sequence values.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId', 'issuerId']);

function normalise(payload: FaPayload): unknown {
  const tokens = new Map<number, string>([
    [env.aaplId, '<AAPL>'],
    [env.spyId, '<SPY>'],
    [env.msftId, '<MSFT>'],
    [env.issuerId, '<ISSUER>'],
    [env.spyLineId, '<SPY_LINE>'],
  ]);
  const knownAt = new Date(env.knownAt).toISOString();
  const json = JSON.stringify(payload, (key, value: unknown) => {
    if (typeof value === 'string') {
      if (value === knownAt) return '<KNOWN_AT>';
      return subjectToken(value.split(TAG).join(''), tokens);
    }
    // A statement is a wall of magnitudes — revenue, assets, NAV, market value, share counts —
    // reported at full precision. Under the old rule any of them that happened to equal a live
    // instrument id became `<AAPL>`, which is how a fundamentals golden stops pinning
    // fundamentals. A number is an id only under a key that names one.
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('FA — point-in-time statements', () => {
  it('shows the income statement for fiscal years, from the seeded statements', async () => {
    const { data } = await runFA(env.aaplId);
    const fa = equityOf(data);

    expect(fa.issuer.cik).toBe(CIK);
    expect(fa.statement).toBe('IS');
    expect(fa.periodType).toBe('FY');
    expect(fa.mappingVersion).toBe('std-map/2026.09');
    expect(fa.engine).toEqual({ name: 'fundamentals/std-map', version: 'std-map/2026.09' });

    // Newest period first, each column naming the filing behind it.
    expect(fa.columns.map((c) => c.periodEnd)).toEqual(['2025-09-27', '2024-09-28', '2023-09-30']);
    expect(fa.columns[0]!.filedAt).toBe('2025-10-31');
    expect(fa.columns[0]!.accessionNo).toBe('0000320193-25-000101');
    expect(fa.columns[0]!.form).toBe('10-K');
    expect(fa.columns.every((c) => c.restated === false)).toBe(true);

    const revenue = fa.rows.find((r) => r.item === 'REVENUE')!;
    expect(revenue.values).toEqual([416_161_000_000, 391_035_000_000, 383_285_000_000]);
    expect(revenue.fieldId).toBe('SALES_REV_TURN');
    expect(revenue.asReported).toEqual([null, null, null]);

    const eps = fa.rows.find((r) => r.item === 'EPS_DIL')!;
    expect(eps.values[0]).toBe(6.72);

    // DATA-10: every column cites a real provenance row.
    for (const column of fa.columns) expect(column.provIdx).toBeGreaterThanOrEqual(0);
  });

  it('shows the balance sheet and the cash flow statement from the same rows', async () => {
    const bs = equityOf((await runFA(env.aaplId, { statement: 'BS' })).data);
    expect(bs.rows.map((r) => r.item)).toEqual([
      'CASH',
      'TOT_ASSETS',
      'TOT_LIAB',
      'LT_DEBT',
      'EQUITY',
    ]);
    expect(bs.rows.find((r) => r.item === 'TOT_ASSETS')!.values[0]).toBe(364_980_000_000);

    const cf = equityOf((await runFA(env.aaplId, { statement: 'CF' })).data);
    expect(cf.rows.map((r) => r.item)).toEqual([
      'CFO',
      'CAPEX',
      'FCF',
      'DIV_PAID',
      'BUYBACK',
      'DDA',
    ]);
    expect(cf.rows.find((r) => r.item === 'CFO')!.values[0]).toBeCloseTo(101_240_000_000 * 1.15, 0);
  });

  it('shows quarters when periodType is Q', async () => {
    const q = equityOf((await runFA(env.aaplId, { periodType: 'Q', periods: 4 })).data);
    expect(q.periodType).toBe('Q');
    expect(q.columns.map((c) => c.periodEnd)).toEqual([
      '2026-06-27',
      '2026-03-28',
      '2025-12-27',
    ]);
    expect(q.columns[0]!.form).toBe('10-Q');
    expect(q.columns[0]!.fiscalPeriod).toBe('Q3');
  });

  it('derives the ratio and per-share rows from the same statement row', async () => {
    const ratios = equityOf((await runFA(env.aaplId, { statement: 'RATIOS' })).data);
    const netMargin = ratios.rows.find((r) => r.item === 'NET_MARGIN')!;
    expect(netMargin.unit).toBe('pct');
    expect(netMargin.values[0]).toBeCloseTo((101_240_000_000 / 416_161_000_000) * 100, 6);

    const perShare = equityOf((await runFA(env.aaplId, { statement: 'PER_SHARE' })).data);
    const bvps = perShare.rows.find((r) => r.item === 'BVPS')!;
    expect(bvps.values[0]).toBeCloseTo(56_950_000_000 / 15_200_000_000, 6);
  });

  /**
   * The acceptance row's middle claim, and the reason `fin_statements` is keyed on `filed_at`.
   */
  it('returns different numbers before and after a restatement (STOR-06)', async () => {
    const before = equityOf(
      (await runFA(env.aaplId, { periodType: 'Q', knownAt: '2026-06-01T00:00:00Z' })).data,
    );
    const after = equityOf((await runFA(env.aaplId, { periodType: 'Q' })).data);

    const q2Before = before.columns.findIndex((c) => c.periodEnd === '2026-03-28');
    const q2After = after.columns.findIndex((c) => c.periodEnd === '2026-03-28');
    expect(q2Before).toBeGreaterThanOrEqual(0);
    expect(q2After).toBeGreaterThanOrEqual(0);

    const revenueBefore = before.rows.find((r) => r.item === 'REVENUE')!.values[q2Before];
    const revenueAfter = after.rows.find((r) => r.item === 'REVENUE')!.values[q2After];

    // Both numbers, not just the newer one: a resolver with no point-in-time logic returns the
    // same value twice and only the pair of assertions catches it.
    expect(revenueBefore).toBe(95_359_000_000);
    expect(revenueAfter).toBe(94_836_000_000);
    expect(revenueBefore).not.toBe(revenueAfter);

    // The column says which it is, and the filing it came from.
    expect(before.columns[q2Before]!.restated).toBe(false);
    expect(before.columns[q2Before]!.filedAt).toBe('2026-05-02');
    expect(after.columns[q2After]!.restated).toBe(true);
    expect(after.columns[q2After]!.filedAt).toBe('2026-07-31');
    expect(after.notes).toContain('RESTATED');

    // The June view cannot see the July filing at all: the newest quarter is CY2026Q2.
    expect(before.columns[0]!.periodEnd).toBe('2026-03-28');
    expect(before.knownAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('cites the XBRL fact behind each cell when as-reported is on', async () => {
    const fa = equityOf((await runFA(env.aaplId, { periodType: 'Q', asReported: true })).data);
    const q2 = fa.columns.findIndex((c) => c.periodEnd === '2026-03-28');
    const revenue = fa.rows.find((r) => r.item === 'REVENUE')!;
    const cited = revenue.asReported[q2]!;

    expect(cited.concept).toBe('RevenueFromContractWithCustomerExcludingAssessedTax');
    expect(cited.taxonomy).toBe('us-gaap');
    expect(cited.value).toBe(94_836_000_000);
    // The fact id is a real `xbrl_facts` row, not a label: the drill-down opens it.
    expect(cited.factId).toBe(env.factIds.q2Restated);

    const row = await t.client.query<{ concept: string; value: string }>(
      `SELECT concept, value::text AS value FROM xbrl_facts WHERE fact_id = $1`,
      [cited.factId],
    );
    expect(row.rows[0]!.concept).toBe(cited.concept);

    // A derived row has no concept of its own, and says so with a null rather than a borrowed one.
    const ratios = equityOf(
      (await runFA(env.aaplId, { statement: 'RATIOS', asReported: true })).data,
    );
    expect(ratios.rows.find((r) => r.item === 'GROSS_MARGIN')!.asReported[0]).toBeNull();
  });

  it('reports SEGMENTS as unavailable rather than showing an empty grid', async () => {
    const { data, meta } = await runFA(env.aaplId, { statement: 'SEGMENTS' });
    const fa = equityOf(data);
    expect(fa.rows).toEqual([]);
    expect(fa.columns.length).toBeGreaterThan(0);
    expect(fa.notes).toContain('SEGMENTS_UNAVAILABLE');
    const note = meta.unavailable.find((u) => u.field === 'segments')!;
    expect(note.reason).toBe('NO_SOURCE');
    expect(note.detail).toContain('no dimensional (segment) facts');
  });

  it('serves the fund variant for an ETF: terms, NAV, holdings and filings', async () => {
    const { data, meta } = await runFA(env.spyId);
    expect(data.variant).toBe('fund');
    const fund = data as FaFundPayload;

    expect(fund.fund.key).toBe('SPY US Equity');
    expect(fund.fund.sponsor).toBe('State Street Global Advisors');
    expect(fund.fund.expenseRatio).toBeCloseTo(0.000945, 9);
    expect(fund.notes).toContain('STATEMENTS_NOT_APPLICABLE_FUND');
    expect(
      meta.unavailable.find((u) => u.field === 'statement')!.detail,
    ).toContain('STATEMENTS_NOT_APPLICABLE_FUND');

    // The NAV cells are plant cells and carry `live`, so the shell can update them off the wire.
    expect(fund.nav.px.v).toBe(662.41);
    expect(fund.nav.px.live).toEqual({ subject: `q:${String(env.spyId)}`, field: 'PX_LAST' });
    expect(fund.nav.px.provIdx).toBeGreaterThanOrEqual(0);

    expect(fund.holdings).not.toBeNull();
    expect(fund.holdings!.count).toBe(4);
    expect(fund.holdings!.asOfDate).toBe('2026-09-14');
    expect(fund.holdings!.top10[0]).toMatchObject({ key: 'AAPL US Equity', weight: 0.0712 });
    expect(fund.holdings!.byAssetCat.map((c) => c.assetCat)).toEqual(['EC', 'STIV']);
    // Nothing reconstructs the N-PORT net-assets header from the lines.
    expect(fund.holdings!.netAssets).toBeNull();
    expect(meta.unavailable.some((u) => u.field === 'netAssets')).toBe(true);

    expect(fund.filings.map((f) => f.form)).toEqual(['NPORT-P', 'N-CEN']);
    expect(fund.filings[0]!.url).toContain('sec.gov');
  });

  it('declares a live spec for the fund and none for the equity', async () => {
    const equity = (await runFA(env.aaplId)).data;
    const fund = (await runFA(env.spyId)).data;
    const params = {
      statement: 'IS' as const,
      periodType: 'FY' as const,
      periods: 8,
      asReported: false,
      scale: '1e6' as const,
    };
    expect(FA.live!(params, equity)).toBeNull();
    expect(FA.live!(params, fund)).toEqual({
      subjects: [`q:${String(env.spyId)}`],
      fields: ['PX_LAST', 'CHG_PCT_1D'],
      conflationMs: 1000,
    });
  });

  it('deep-equals the committed goldens at the frozen clock', async () => {
    expectGolden('FA.equity.json', normalise((await runFA(env.aaplId)).data));
    expectGolden('FA.fund.json', normalise((await runFA(env.spyId)).data));
  });
});
