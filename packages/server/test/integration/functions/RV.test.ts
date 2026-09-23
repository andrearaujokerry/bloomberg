/**
 * `test/integration/functions/RV.test.ts` — WP-10's `RV` (Relative Valuation).
 *
 * The screen's whole claim is comparative, so the fixture is built to make each half of the claim
 * falsifiable on its own:
 *
 *  - **the peer set** — six equities in one GICS sub-industry, one of them outside the index and
 *    one in a different sub-industry of the same sector, so `restrictToIndex` and the `B` widening
 *    each have a row they must add and a row they must not;
 *  - **the multiples** — every one is recomputed in the assertion from the seeded price, share
 *    count and statement columns, so a resolver that divided by the wrong column fails rather than
 *    agreeing with itself;
 *  - **the gaps** — one peer has no ingested filings, one has negative equity and one has negative
 *    EBITDA. Each produces a null with a reason and is excluded from the statistics. That is the
 *    rule this screen exists to keep: RV never fills a hole with a peer-group average, and a peer
 *    with nothing to show stays on the screen so the user can see who is missing;
 *  - **`n < 3`** — `PX_TO_BOOK_RATIO` has exactly two usable peers, so every one of its statistics
 *    is null with `INSUFFICIENT_PEERS`, beside a metric that has three and is fully computed.
 *
 * ## No seed
 *
 * Every instrument, issuer, classification, membership, quote, statement, fact and dividend here is
 * created inside this file's own `withTxDb()` transaction; nothing depends on a literal id.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden, idToken, subjectToken } from './golden.js';

import type { NormalisedUpdate } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { RV } from '@terminal/core/functions/manifests/RV';
import type { RvPayload } from '@terminal/core/functions/manifests/RV';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import * as RvModule from '../../../src/functions/RV/resolve.js';
import { quantile, statFor } from '../../../src/functions/RV/resolve.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { ensureShared, withTxDb, type TestDb } from '../../../src/test/db.js';
import { GOLDEN_CAPTURE_MS } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = '2020-01-01T00:00:00.000Z';

/** `md_lines_symbol_excl` is a global namespace; `normalise` strips this again. */
const TAG = `.t${randomUUID().slice(0, 8)}`;

const REGISTRY = new FunctionRegistry([RV]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { RV: RvModule };

const t: TestDb = withTxDb();

/** One seeded name: its market data, its classification and — sometimes — its filings. */
interface NameSpec {
  ticker: string;
  name: string;
  cik: string | null;
  gics: string | null;
  sic: string;
  inIndex: boolean;
  px: number;
  chgPct: number;
  sharesOut: number | null;
  /** `null` = SEC companyfacts are not ingested for this issuer. */
  statement: {
    revenue: number;
    netInc: number;
    epsDil: number;
    equity: number;
    totAssets: number;
    ltDebt: number;
    cash: number;
    operInc: number;
    dda: number;
    fcf: number;
    priorRevenue: number;
  } | null;
}

const NAMES: NameSpec[] = [
  {
    ticker: 'AAPL',
    name: 'Apple Inc',
    cik: '0000320193',
    gics: '45202030',
    sic: '3571',
    inIndex: true,
    px: 330.27,
    chgPct: 0.41,
    sharesOut: 14_900_000_000,
    statement: {
      revenue: 416_161_000_000,
      netInc: 101_240_000_000,
      epsDil: 6.72,
      equity: 56_950_000_000,
      totAssets: 364_980_000_000,
      ltDebt: 61_800_000_000,
      cash: 86_200_000_000,
      operInc: 124_300_000_000,
      dda: 12_900_000_000,
      fcf: 98_400_000_000,
      priorRevenue: 391_035_000_000,
    },
  },
  {
    ticker: 'DELL',
    name: 'Dell Technologies Inc',
    cik: '0001571996',
    gics: '45202030',
    sic: '3571',
    inIndex: true,
    px: 120.5,
    chgPct: -0.22,
    sharesOut: 700_000_000,
    statement: {
      revenue: 95_600_000_000,
      netInc: 4_500_000_000,
      epsDil: 6.4,
      equity: 2_100_000_000,
      totAssets: 82_000_000_000,
      ltDebt: 24_000_000_000,
      cash: 5_200_000_000,
      operInc: 6_100_000_000,
      dda: 2_200_000_000,
      fcf: 5_100_000_000,
      priorRevenue: 88_400_000_000,
    },
  },
  {
    // Negative book value: `PX_TO_BOOK_RATIO` is null with `st:'na'`, never a negative multiple.
    ticker: 'HPQ',
    name: 'HP Inc',
    cik: '0000047217',
    gics: '45202030',
    sic: '3571',
    inIndex: true,
    px: 33.2,
    chgPct: 0.15,
    sharesOut: 950_000_000,
    statement: {
      revenue: 53_700_000_000,
      netInc: 3_200_000_000,
      epsDil: 3.3,
      equity: -1_200_000_000,
      totAssets: 40_000_000_000,
      ltDebt: 9_500_000_000,
      cash: 3_200_000_000,
      operInc: 4_100_000_000,
      dda: 1_100_000_000,
      fcf: 3_300_000_000,
      priorRevenue: 52_100_000_000,
    },
  },
  {
    // Negative EBITDA: `EV_TO_EBITDA` is NOT_APPLICABLE and names the company.
    ticker: 'STX',
    name: 'Seagate Technology Holdings',
    cik: '0001137789',
    gics: '45202030',
    sic: '3572',
    inIndex: true,
    px: 98.4,
    chgPct: -1.05,
    sharesOut: 210_000_000,
    statement: {
      revenue: 8_900_000_000,
      netInc: 640_000_000,
      epsDil: 2.1,
      equity: 1_500_000_000,
      totAssets: 12_400_000_000,
      ltDebt: 5_600_000_000,
      cash: 900_000_000,
      operInc: -400_000_000,
      dda: 300_000_000,
      fcf: 410_000_000,
      priorRevenue: 9_600_000_000,
    },
  },
  {
    // No companyfacts: on the screen, blank, and out of every statistic.
    ticker: 'WDC',
    name: 'Western Digital Corp',
    cik: '0000106040',
    gics: '45202030',
    sic: '3572',
    inIndex: true,
    px: 74.1,
    chgPct: 0.62,
    sharesOut: null,
    statement: null,
  },
  {
    // Same sub-industry, not an index member: only appears when the restriction is dropped.
    ticker: 'SMCI',
    name: 'Super Micro Computer Inc',
    cik: '0001375365',
    gics: '45202030',
    sic: '3571',
    inIndex: false,
    px: 41.8,
    chgPct: 2.1,
    sharesOut: 600_000_000,
    statement: null,
  },
  {
    // Same GICS sector, different sub-industry: appears when the basis widens to SECTOR.
    ticker: 'MSFT',
    name: 'Microsoft Corp',
    cik: '0000789019',
    gics: '45103010',
    sic: '7372',
    inIndex: true,
    px: 512.9,
    chgPct: 0.08,
    sharesOut: 7_400_000_000,
    statement: null,
  },
  {
    // No GICS row at all: the SIC fallback, which offline is the ordinary case.
    ticker: 'PRVT',
    name: 'Privatco Industries',
    cik: '0001999999',
    gics: null,
    sic: '3571',
    inIndex: false,
    px: 12.4,
    chgPct: 0,
    sharesOut: 100_000_000,
    statement: null,
  },
];

const byTicker = (ticker: string): NameSpec => {
  const spec = NAMES.find((n) => n.ticker === ticker);
  if (spec === undefined) throw new Error(`no fixture for ${ticker}`);
  return spec;
};

/** The restated AAPL revenue: the original was filed 2026-05-02, this one 2026-07-31. */
const AAPL_ORIGINAL_REVENUE = 402_770_000_000;

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  ids: Map<string, number>;
  lineIds: Map<string, number>;
  issuerIds: Map<string, number>;
  prov: Map<string, number>;
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
  const key = `rv-${sourceId}-${randomUUID()}`;
  const res = await t.client.query<{ provenance_id: string }>(
    `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                             http_status, bytes, captured_at, source_ts, adapter_version)
     VALUES ($1,$2,'test://rv/' || $2, digest($2,'sha256'), digest($2,'sha256'), 200, 0, $3, $3,
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
    assetClass: 'equity',
    tier: 'delayed',
    fields: spec.fields,
    ts: { src: GOLDEN_CAPTURE_MS - 60_000, cap: GOLDEN_CAPTURE_MS, pub: 0 },
    prov: { sourceId: 'cboe.quotes', provenanceId: spec.provenanceId },
  };
}

/** The issuer, the issue, the instrument, its listing and its market-data line. */
async function seedName(spec: NameSpec): Promise<void> {
  const figiProv = await provenanceFor('openfigi.mapping');
  const secProv = await provenanceFor('sec.submissions');

  const issuerId = await nextId('issuer_id_seq');
  await t.client.query(
    `INSERT INTO issuers (issuer_id, name, cik, country, sic, sic_description, entity_type,
                          fiscal_year_end, valid_from, tx_from, provenance_id)
     VALUES ($1,$2,$3,'US',$4,'Electronic Computers','operating','0926',
             $5::timestamptz,$5::timestamptz,$6)`,
    [issuerId, spec.name, spec.cik, spec.sic, VALID_FROM, secProv],
  );
  env.issuerIds.set(spec.ticker, issuerId);

  const issueId = await nextId('issue_id_seq');
  const instrumentId = await nextId('instrument_id_seq');
  const listingId = await nextId('listing_id_seq');
  await t.client.query(
    `INSERT INTO issues (issue_id, issuer_id, asset_class, security_type, name, currency,
                         country_of_issue, valid_from, tx_from, provenance_id)
     VALUES ($1,$2,'equity'::asset_class,'Common Stock',$3,'USD','US',
             $4::timestamptz,$4::timestamptz,$5)`,
    [issueId, issuerId, spec.name, VALID_FROM, figiProv],
  );
  await t.client.query(
    `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                              exch_code, name, currency, status, search_weight, price_decimals,
                              primary_listing_id, valid_from, tx_from, provenance_id)
     VALUES ($1,$2,'equity'::asset_class,'Equity'::market_sector,$3,'US',$4,'USD','active',5,2,$5,
             $6::timestamptz,$6::timestamptz,$7)`,
    [instrumentId, issueId, spec.ticker, spec.name, listingId, VALID_FROM, figiProv],
  );
  await t.client.query(
    `INSERT INTO listings (listing_id, instrument_id, mic, exch_code, local_ticker, is_primary,
                           valid_from, tx_from, provenance_id)
     VALUES ($1,$2,'XNAS','UW',$3,true,$4::timestamptz,$4::timestamptz,$5)`,
    [listingId, instrumentId, spec.ticker, VALID_FROM, figiProv],
  );

  const lineProv = await provenanceFor('cboe.quotes');
  const mdLineId = await nextId('md_line_id_seq');
  await t.client.query(
    `INSERT INTO md_lines (md_line_id, instrument_id, listing_id, source_id, provider_symbol,
                           line_kind, intrinsic_delay_min, expected_interval_ms, priority,
                           valid_from, tx_from, provenance_id)
     VALUES ($1,$2,$3,'cboe.quotes',$4,'composite',15,10000,10,$5::timestamptz,$5::timestamptz,$6)`,
    [mdLineId, instrumentId, listingId, `${spec.ticker}${TAG}`, VALID_FROM, lineProv],
  );

  env.ids.set(spec.ticker, instrumentId);
  env.lineIds.set(spec.ticker, mdLineId);

  if (spec.gics !== null) {
    await t.client.query(
      `INSERT INTO entity_classifications (entity_kind, entity_id, scheme, code, valid_from,
                                           tx_from, provenance_id)
       VALUES ('issuer',$1,'GICS',$2,$3::timestamptz,$3::timestamptz,$4)`,
      [issuerId, spec.gics, VALID_FROM, await provenanceFor('wiki.sp500')],
    );
  }

  // Filed 2026-05-02, before the restatement: the share count is knowable at both `knownAt`
  // instants the point-in-time test uses, so that test measures the restated revenue and nothing
  // else. A fact filed later would make the June view blank for a second reason.
  if (spec.sharesOut !== null && spec.cik !== null) {
    await t.client.query(
      `INSERT INTO xbrl_facts (cik, issuer_id, taxonomy, concept, unit, period_start, period_end,
                               form, accession_no, filed_at, value, captured_at, provenance_id)
       VALUES ($1,$2,'dei','EntityCommonStockSharesOutstanding','shares',NULL,'2026-03-28','10-Q',
               $3::char(20),'2026-05-02',$4,$5::timestamptz,$6)`,
      [
        spec.cik,
        issuerId,
        `${spec.cik.slice(0, 10)}-26-000031`,
        spec.sharesOut,
        GOLDEN_ISO,
        await provenanceFor('sec.companyfacts'),
      ],
    );
  }

  if (spec.statement !== null && spec.cik !== null) {
    // The current TTM row, and the same TTM one year earlier for the growth comparison.
    await seedStatement(issuerId, {
      periodEnd: '2026-06-27',
      filedAt: '2026-07-31',
      fiscalYear: 2026,
      accessionNo: `${spec.cik.slice(0, 10)}-26-000055`,
      s: spec.statement,
      revenue: spec.statement.revenue,
    });
    await seedStatement(issuerId, {
      periodEnd: '2025-06-28',
      filedAt: '2025-08-01',
      fiscalYear: 2025,
      accessionNo: `${spec.cik.slice(0, 10)}-25-000071`,
      s: spec.statement,
      revenue: spec.statement.priorRevenue,
    });
  }
}

async function seedStatement(
  issuerId: number,
  spec: {
    periodEnd: string;
    filedAt: string;
    fiscalYear: number;
    accessionNo: string;
    s: NonNullable<NameSpec['statement']>;
    revenue: number;
  },
): Promise<void> {
  const prov = await provenanceFor('sec.companyfacts');
  await t.client.query(
    `INSERT INTO fin_statements
       (issuer_id, period_end, period_type, filed_at, mapping_version, fiscal_year, fiscal_period,
        accession_no, currency, revenue, net_inc, eps_dil, shares_dil, tot_assets, equity, cash,
        lt_debt, oper_inc, dda, fcf, derived_q4, as_reported, engine_name, engine_version,
        inputs_hash, provenance_ids)
     VALUES ($1,$2::date,'TTM',$3::date,'std-map/2026.09',$4,'TTM',$5::char(20),'USD',
             $6,$7,$8,15200000000,$9,$10,$11,$12,$13,$14,$15,false,'{}'::jsonb,
             'fundamentals/std-map','std-map/2026.09',repeat('a',64),ARRAY[$16::bigint])`,
    [
      issuerId,
      spec.periodEnd,
      spec.filedAt,
      spec.fiscalYear,
      spec.accessionNo,
      spec.revenue,
      spec.s.netInc,
      spec.s.epsDil,
      spec.s.totAssets,
      spec.s.equity,
      spec.s.cash,
      spec.s.ltDebt,
      spec.s.operInc,
      spec.s.dda,
      spec.s.fcf,
      prov,
    ],
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The universe
// ─────────────────────────────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await ensureLicences();

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`RV Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1,$2,'RV User','user') RETURNING user_id`,
    [firmId, `rv-${randomUUID()}@demo.invalid`],
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
    ids: new Map(),
    lineIds: new Map(),
    issuerIds: new Map(),
    prov: new Map(),
  };

  // The GICS hierarchy the peer bases walk. Shared tables, so seeded once per database.
  await ensureShared(
    t,
    `SELECT 1 FROM classification_schemes WHERE scheme = 'GICS'`,
    `INSERT INTO classification_schemes (scheme, name, source_id, levels)
     VALUES ('GICS','GICS','wiki.sp500',4) ON CONFLICT (scheme) DO NOTHING`,
  );
  await t.client.query(
    `INSERT INTO classification_codes (scheme, code, name, parent_code, level)
     VALUES ('GICS','45','Information Technology',NULL,1),
            ('GICS','4520','Technology Hardware & Equipment','45',2),
            ('GICS','452020','Technology Hardware, Storage & Peripherals','4520',3),
            ('GICS','45202030','Technology Hardware, Storage & Peripherals','452020',4),
            ('GICS','4510','Software & Services','45',2),
            ('GICS','451030','Software','4510',3),
            ('GICS','45103010','Systems Software','451030',4)
     ON CONFLICT (scheme, code) DO NOTHING`,
  );

  for (const spec of NAMES) await seedName(spec);

  // The index, and the membership the GICS bases are restricted to by default.
  const indexProv = await provenanceFor('sec.archives');
  const figiProv = await provenanceFor('openfigi.mapping');
  const spxIssueId = await nextId('issue_id_seq');
  const spxId = await nextId('instrument_id_seq');
  await t.client.query(
    `INSERT INTO issues (issue_id, issuer_id, asset_class, security_type, name, currency,
                         country_of_issue, valid_from, tx_from, provenance_id)
     VALUES ($1,$2,'index'::asset_class,'Index','S&P 500 Index','USD','US',
             $3::timestamptz,$3::timestamptz,$4)`,
    [spxIssueId, env.issuerIds.get('AAPL'), VALID_FROM, figiProv],
  );
  await t.client.query(
    `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                              exch_code, name, currency, status, search_weight, price_decimals,
                              valid_from, tx_from, provenance_id)
     VALUES ($1,$2,'index'::asset_class,'Index'::market_sector,'SPX','INDEX','S&P 500 Index','USD',
             'active',9,2,$3::timestamptz,$3::timestamptz,$4)`,
    [spxId, spxIssueId, VALID_FROM, figiProv],
  );
  env.ids.set('SPX', spxId);
  const indexRow = await t.client.query<{ index_id: string }>(
    `INSERT INTO indices (code, instrument_id, membership_source_id, provider)
     VALUES ('SPX',$1,'sec.archives','S&P Dow Jones Indices') RETURNING index_id`,
    [spxId],
  );
  const indexId = Number(indexRow.rows[0]!.index_id);
  for (const spec of NAMES.filter((n) => n.inIndex)) {
    await t.client.query(
      `INSERT INTO index_members (index_id, instrument_id, weight, as_of_date, source_id,
                                  valid_from, tx_from, provenance_id)
       VALUES ($1,$2,0.01,'2026-09-14','sec.archives',$3::timestamptz,$3::timestamptz,$4)`,
      [indexId, env.ids.get(spec.ticker), VALID_FROM, indexProv],
    );
  }

  // The dividends behind the target's yield: trailing twelve months of the frozen clock.
  const caProv = await provenanceFor('sec.archives');
  await t.client.query(
    `INSERT INTO corporate_actions (instrument_id, ca_type, status, ex_date, record_date, pay_date,
                                    amount, currency, source_id, valid_from, tx_from, provenance_id)
     VALUES ($1,'cash_dividend','paid','2026-02-06','2026-02-09','2026-02-12',0.26,'USD',
             'sec.archives',$2::timestamptz,$2::timestamptz,$3),
            ($1,'cash_dividend','paid','2026-05-08','2026-05-11','2026-05-14',0.27,'USD',
             'sec.archives',$2::timestamptz,$2::timestamptz,$3),
            ($1,'cash_dividend','paid','2024-05-08','2024-05-11','2024-05-14',0.24,'USD',
             'sec.archives',$2::timestamptz,$2::timestamptz,$3)`,
    [env.ids.get('AAPL'), VALID_FROM, caProv],
  );

  // The pre-restatement AAPL revenue, filed 2026-05-02: a second version of the same period.
  await seedStatement(env.issuerIds.get('AAPL')!, {
    periodEnd: '2026-06-27',
    filedAt: '2026-05-02',
    fiscalYear: 2026,
    accessionNo: '0000320193-26-000031',
    s: byTicker('AAPL').statement!,
    revenue: AAPL_ORIGINAL_REVENUE,
  });

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  env.knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const quoteProv = await provenanceFor('cboe.quotes');
  for (const spec of NAMES) {
    harness.deps.plant.apply(
      update({
        instrumentId: env.ids.get(spec.ticker)!,
        mdLineId: env.lineIds.get(spec.ticker)!,
        provenanceId: quoteProv,
        fields: { PX_LAST: spec.px, CHG_PCT_1D: spec.chgPct },
      }),
    );
  }
});

afterEach(async () => {
  await env.harness.close();
});

interface RvResponse {
  data: RvPayload;
  meta: { unavailable: { field: string; reason: string; detail: string }[] };
}

async function runRV(
  ticker: string,
  params: Record<string, unknown> = {},
): Promise<RvResponse> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/RV/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params,
      security: { id: env.ids.get(ticker) },
      asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json();
}

/**
 * The keys of an RV payload that hold a sequence-allocated id (§RV `RvRow`). A metric's
 * `id`/`fieldId` (`'CUR_MKT_CAP'`) is a field name, not a sequence value.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId', 'issuerId']);

function normalise(payload: RvPayload): unknown {
  const tokens = new Map<number, string>();
  for (const [ticker, id] of env.ids) tokens.set(id, `<${ticker}>`);
  for (const [ticker, id] of env.issuerIds) tokens.set(id, `<${ticker}_ISSUER>`);
  const knownAt = new Date(env.knownAt).toISOString();
  const json = JSON.stringify(payload, (key, value: unknown) => {
    if (typeof value === 'string') {
      if (value === knownAt) return '<KNOWN_AT>';
      return subjectToken(value.split(TAG).join(''), tokens);
    }
    // A relative-value screen is a grid of metric cells — market caps, P/Es, margins, and the
    // median, percentile and z-score computed from them. Under the old value-based rule any of
    // those could be renamed by colliding with one of the ~20 ids this test allocates. A number
    // is an id because of the key it sits under.
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

const cellValue = (payload: RvPayload, ticker: string, metric: string): number | null => {
  const row =
    payload.target.key === `${ticker} US Equity`
      ? payload.target
      : payload.peers.find((p) => p.key === `${ticker} US Equity`);
  if (row === undefined) throw new Error(`no row for ${ticker}`);
  const v = row.cells[metric]?.v;
  return typeof v === 'number' ? v : null;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('RV — the peer set and the multiples', () => {
  it('builds the GICS sub-industry peer set, restricted to the index', async () => {
    const { data } = await runRV('AAPL');

    expect(data.variant).toBe('equity');
    expect(data.peerSet.basis).toBe('SUB_INDUSTRY');
    expect(data.peerSet.scheme).toBe('GICS');
    expect(data.peerSet.code).toBe('45202030');
    expect(data.peerSet.label).toBe('Technology Hardware, Storage & Peripherals (GICS 45202030)');
    expect(data.peerSet.restrictedToIndex).toBe('SPX');
    expect(data.peerSet.provIdx).toBeGreaterThanOrEqual(0);

    // The four index members of the sub-industry, and neither SMCI (not a member) nor MSFT
    // (a different sub-industry) nor the target itself.
    expect(data.peers.map((p) => p.key).sort()).toEqual([
      'DELL US Equity',
      'HPQ US Equity',
      'STX US Equity',
      'WDC US Equity',
    ]);
    expect(data.target.isTarget).toBe(true);
    expect(data.target.key).toBe('AAPL US Equity');
    expect(data.peers.every((p) => !p.isTarget)).toBe(true);
    expect(data.peerSet.candidates).toBe(4);
    expect(data.peerSet.returned).toBe(4);

    // Ranked by market cap, descending, the target excluded from the ranking.
    const caps = data.peers.map((p) => cellValue(data, p.key.split(' ')[0]!, 'CUR_MKT_CAP'));
    const withValues = caps.filter((c): c is number => c !== null);
    expect([...withValues].sort((a, b) => b - a)).toEqual(withValues);

    // Live prices, stored multiples: only the price cells carry `live`.
    expect(data.target.cells.PE_RATIO?.live).toBeUndefined();
  });

  it('computes every multiple from the seeded price, shares and statement columns', async () => {
    const { data } = await runRV('AAPL', {
      metrics: [
        'CUR_MKT_CAP',
        'PE_RATIO',
        'PX_TO_BOOK_RATIO',
        'PX_TO_SALES_RATIO',
        'EV_TO_EBITDA',
        'NET_MARGIN',
        'RETURN_COM_EQY',
        'SALES_GROWTH_YOY',
        'DVD_YIELD',
      ],
    });
    const aapl = byTicker('AAPL');
    const s = aapl.statement!;
    const cap = aapl.px * aapl.sharesOut!;

    expect(cellValue(data, 'AAPL', 'CUR_MKT_CAP')).toBeCloseTo(cap, 0);
    expect(cellValue(data, 'AAPL', 'PE_RATIO')).toBeCloseTo(aapl.px / s.epsDil, 10);
    expect(cellValue(data, 'AAPL', 'PX_TO_BOOK_RATIO')).toBeCloseTo(cap / s.equity, 8);
    expect(cellValue(data, 'AAPL', 'PX_TO_SALES_RATIO')).toBeCloseTo(cap / s.revenue, 10);
    expect(cellValue(data, 'AAPL', 'EV_TO_EBITDA')).toBeCloseTo(
      (cap + s.ltDebt - s.cash) / (s.operInc + s.dda),
      8,
    );
    // Percent units, matching the dictionary's `pct` fields and the shared formatter.
    expect(cellValue(data, 'AAPL', 'NET_MARGIN')).toBeCloseTo((s.netInc / s.revenue) * 100, 10);
    expect(cellValue(data, 'AAPL', 'RETURN_COM_EQY')).toBeCloseTo((s.netInc / s.equity) * 100, 10);
    expect(cellValue(data, 'AAPL', 'SALES_GROWTH_YOY')).toBeCloseTo(
      (s.revenue / s.priorRevenue - 1) * 100,
      10,
    );
    // The trailing-twelve-month dividends only: the 2024 one is outside the window.
    expect(cellValue(data, 'AAPL', 'DVD_YIELD')).toBeCloseTo(((0.26 + 0.27) / aapl.px) * 100, 10);

    // Every number cites something, and the fundamentals block names the filing behind them.
    for (const cell of Object.values(data.target.cells)) {
      if (typeof cell.v === 'number') expect(cell.provIdx).toBeGreaterThanOrEqual(0);
    }
    expect(data.target.fundamentals).toMatchObject({
      periodEnd: '2026-06-27',
      periodType: 'TTM',
      filedAt: '2026-07-31',
      accessionNo: '0000320193-26-000055',
    });
    expect(data.target.dataState).toBe('full');
  });

  it('leaves a degenerate denominator blank and says which company it was', async () => {
    const { data, meta } = await runRV('AAPL');

    // Negative book value: no ratio, and no negative multiple either.
    const hpq = data.peers.find((p) => p.key === 'HPQ US Equity')!;
    expect(hpq.cells.PX_TO_BOOK_RATIO!.v).toBeNull();
    expect(hpq.cells.PX_TO_BOOK_RATIO!.st).toBe('na');
    expect(hpq.dataState).toBe('partial');

    // Negative EBITDA: NOT_APPLICABLE, naming the company rather than the column alone.
    const stx = data.peers.find((p) => p.key === 'STX US Equity')!;
    expect(stx.cells.EV_TO_EBITDA!.v).toBeNull();
    const note = meta.unavailable.find(
      (u) => u.field === 'EV_TO_EBITDA' && u.reason === 'NOT_APPLICABLE',
    )!;
    expect(note.detail).toContain('EBITDA is not positive');
    expect(note.detail).toContain('STX US Equity');
  });

  it('keeps a peer with no ingested filings on the screen, blank and counted', async () => {
    const { data, meta } = await runRV('AAPL');
    const wdc = data.peers.find((p) => p.key === 'WDC US Equity')!;

    expect(wdc.dataState).toBe('none');
    expect(wdc.unavailableReason).toBe('FUNDAMENTALS_NOT_INGESTED');
    expect(wdc.fundamentals).toBeNull();
    for (const metric of ['PE_RATIO', 'PX_TO_SALES_RATIO', 'NET_MARGIN']) {
      expect(wdc.cells[metric]!.v).toBeNull();
    }

    expect(data.notes).toContain('FUNDAMENTALS_NOT_INGESTED');
    const note = meta.unavailable.find(
      (u) => u.field === 'peers' && u.detail.includes('FUNDAMENTALS_NOT_INGESTED'),
    )!;
    expect(note.detail).toContain('1 of 4 peers');
  });

  it('computes the peer statistics, and refuses to compute them on fewer than three peers', async () => {
    const { data, meta } = await runRV('AAPL', {
      metrics: ['PE_RATIO', 'PX_TO_BOOK_RATIO'],
    });

    // Three peers have a P/E: DELL, HPQ and STX. The quartiles are the linear-interpolation
    // values of that three-point sample, computed here from the fixture rather than from the code.
    const pes = ['DELL', 'HPQ', 'STX']
      .map((ticker) => {
        const spec = byTicker(ticker);
        return spec.px / spec.statement!.epsDil;
      })
      .sort((a, b) => a - b);
    const pe = data.stats.find((s) => s.metric === 'PE_RATIO')!;
    expect(pe.n).toBe(3);
    expect(pe.reason).toBeNull();
    expect(pe.min).toBeCloseTo(pes[0]!, 10);
    expect(pe.max).toBeCloseTo(pes[2]!, 10);
    expect(pe.median).toBeCloseTo(pes[1]!, 10);
    expect(pe.p25).toBeCloseTo((pes[0]! + pes[1]!) / 2, 10);
    expect(pe.p75).toBeCloseTo((pes[1]! + pes[2]!) / 2, 10);
    expect(pe.mean).toBeCloseTo((pes[0]! + pes[1]! + pes[2]!) / 3, 10);

    const targetPe = byTicker('AAPL').px / byTicker('AAPL').statement!.epsDil;
    expect(pe.target).toBeCloseTo(targetPe, 10);
    expect(pe.targetPercentile).toBeCloseTo(
      pes.filter((v) => v <= targetPe).length / 3,
      10,
    );
    expect(pe.premiumToMedianPct).toBeCloseTo(targetPe / pes[1]! - 1, 10);

    // Only DELL and STX have a book value: two peers is not a distribution.
    const pb = data.stats.find((s) => s.metric === 'PX_TO_BOOK_RATIO')!;
    expect(pb.n).toBe(2);
    expect(pb.reason).toBe('INSUFFICIENT_PEERS');
    expect([pb.min, pb.p25, pb.median, pb.p75, pb.max, pb.mean, pb.targetPercentile]).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    const note = meta.unavailable.find((u) => u.field === 'PX_TO_BOOK_RATIO')!;
    expect(note.detail).toContain('INSUFFICIENT_PEERS');
    expect(note.detail).toContain('2 peers');
  });

  it('widens the basis and drops the index restriction on request', async () => {
    const sector = await runRV('AAPL', { peerBasis: 'SECTOR' });
    expect(sector.data.peerSet.code).toBe('45');
    // The sector adds MSFT, which the sub-industry excluded.
    expect(sector.data.peers.map((p) => p.key)).toContain('MSFT US Equity');
    expect(sector.data.peers.length).toBeGreaterThan(4);

    const unrestricted = await runRV('AAPL', { restrictToIndex: false });
    expect(unrestricted.data.peerSet.restrictedToIndex).toBeNull();
    // SMCI is in the sub-industry but not in the index.
    expect(unrestricted.data.peers.map((p) => p.key)).toContain('SMCI US Equity');

    const capped = await runRV('AAPL', { restrictToIndex: false, maxPeers: 3 });
    expect(capped.data.peers).toHaveLength(3);
    expect(capped.data.notes).toContain('PEERS_TRUNCATED');
    expect(capped.data.peerSet.candidates).toBe(5);
    expect(capped.data.peerSet.returned).toBe(3);
  });

  it('falls back to SIC when the issuer carries no GICS row, and says so', async () => {
    const { data, meta } = await runRV('PRVT', { restrictToIndex: false });

    expect(data.peerSet.basis).toBe('SIC');
    expect(data.peerSet.scheme).toBe('SIC');
    expect(data.peerSet.code).toBe('3571');
    expect(data.notes).toContain('PEER_BASIS_FALLBACK_SIC');
    const note = meta.unavailable.find((u) => u.field === 'peerSet')!;
    expect(note.detail).toContain('NO_GICS_CLASSIFICATION');
    expect(note.detail).toContain('3571');
    // The SIC 3571 names, and not the SIC 3572 ones.
    expect(data.peers.map((p) => p.key).sort()).toEqual([
      'AAPL US Equity',
      'DELL US Equity',
      'HPQ US Equity',
      'SMCI US Equity',
    ]);
  });

  it('moves the whole comparison when knownAt moves across a restatement (STOR-06)', async () => {
    const before = await runRV('AAPL', {
      metrics: ['PX_TO_SALES_RATIO'],
      knownAt: '2026-06-01T00:00:00Z',
    });
    const after = await runRV('AAPL', { metrics: ['PX_TO_SALES_RATIO'] });

    const cap = byTicker('AAPL').px * byTicker('AAPL').sharesOut!;
    expect(cellValue(before.data, 'AAPL', 'PX_TO_SALES_RATIO')).toBeCloseTo(
      cap / AAPL_ORIGINAL_REVENUE,
      10,
    );
    expect(cellValue(after.data, 'AAPL', 'PX_TO_SALES_RATIO')).toBeCloseTo(
      cap / byTicker('AAPL').statement!.revenue,
      10,
    );
    expect(before.data.target.fundamentals!.filedAt).toBe('2026-05-02');
    expect(after.data.target.fundamentals!.filedAt).toBe('2026-07-31');

    // Every peer moves with it: DELL's 2026 TTM row was filed 2026-07-31, so the June view is
    // computed from the 2025 one — the newest version that was public then, not the newest stored.
    const dell = before.data.peers.find((p) => p.key === 'DELL US Equity')!;
    expect(dell.fundamentals).toMatchObject({ periodEnd: '2025-06-28', filedAt: '2025-08-01' });
    const dellAfter = after.data.peers.find((p) => p.key === 'DELL US Equity')!;
    expect(dellAfter.fundamentals).toMatchObject({ periodEnd: '2026-06-27', filedAt: '2026-07-31' });
    expect(cellValue(before.data, 'DELL', 'PX_TO_SALES_RATIO')).not.toBe(
      cellValue(after.data, 'DELL', 'PX_TO_SALES_RATIO'),
    );
  });

  it('subscribes to the target and every peer, for prices only', async () => {
    const { data } = await runRV('AAPL');
    const live = RV.live!(
      {
        peerBasis: 'SUB_INDUSTRY',
        peers: [],
        index: 'SPX',
        restrictToIndex: true,
        maxPeers: 12,
        metrics: ['CUR_MKT_CAP'],
        periodType: 'TTM',
        rank: 'CUR_MKT_CAP',
      },
      data,
    )!;
    expect(live.subjects[0]).toBe(`q:${String(env.ids.get('AAPL')!)}`);
    expect(live.subjects).toHaveLength(5);
    expect(live.fields).toEqual(['PX_LAST', 'CHG_PCT_1D']);
    expect(live.essential).toEqual([`q:${String(env.ids.get('AAPL')!)}`]);
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    expectGolden('RV.equity.json', normalise((await runRV('AAPL')).data));
  });
});

describe('RV — the statistics, as pure functions', () => {
  it('takes quartiles by linear interpolation', () => {
    const sample = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(quantile(sample, 0)).toBe(1);
    expect(quantile(sample, 1)).toBe(8);
    expect(quantile(sample, 0.5)).toBeCloseTo(4.5, 10);
    // p = (8-1)*0.25 = 1.75 → 2 + 0.75*(3-2) = 2.75
    expect(quantile(sample, 0.25)).toBeCloseTo(2.75, 10);
    expect(quantile(sample, 0.75)).toBeCloseTo(6.25, 10);
    expect(quantile([], 0.5)).toBeNull();
  });

  it('counts ties at or below the target, and refuses a median of two', () => {
    const tied = statFor('PE_RATIO', [10, 20, 20, 30], 20);
    expect(tied.n).toBe(4);
    expect(tied.targetPercentile).toBe(0.75);
    expect(tied.median).toBeCloseTo(20, 10);
    expect(tied.premiumToMedianPct).toBeCloseTo(0, 10);

    const thin = statFor('PE_RATIO', [10, 20], 15);
    expect(thin.reason).toBe('INSUFFICIENT_PEERS');
    expect(thin.median).toBeNull();
    // The target is still reported: it is the one number that does not need peers.
    expect(thin.target).toBe(15);
  });

  it('reports no premium when the median is zero rather than dividing by it', () => {
    const stat = statFor('NET_MARGIN', [-5, 0, 5], 2);
    expect(stat.median).toBe(0);
    expect(stat.premiumToMedianPct).toBeNull();
  });
});
