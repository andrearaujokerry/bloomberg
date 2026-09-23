/**
 * `test/integration/functions/HDS.test.ts` — WP-10's acceptance rows for `HDS`
 * (WORKPLAN §WP-10: "`HDS` serves ETF holders/holdings from `etf_holdings`; 13F is reserved and
 * returns `13F_NOT_AVAILABLE` as an `unavailable` entry, not an error").
 *
 * The claim this file exists to pin is the one that is easy to get wrong in the *other* direction:
 * a block with no source must not take the run down with it. Every equity run here asserts three
 * things at once — the fund ownership is real and cited, `institutional.holders` is `null` with
 * `13F_NOT_AVAILABLE`, and the response is a `200`. A resolver that threw because 13F is missing
 * would pass none of them; one that invented an institutional line would pass the wrong one.
 *
 * The fixture is two ownership files over one equity (an SEC N-PORT roster and an SSGA daily
 * sheet), a fund whose own file carries twelve lines including one that never resolved, an issuer
 * with SEC filings and a second issuer with no CIK at all.
 *
 * WP-15 owns the seed, so every firm, user, grant, instrument, file and filing is created here
 * inside this file's own transaction and nothing depends on a literal instrument id.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden, idToken, subjectToken } from './golden.js';

import { FunctionRegistry } from '@terminal/core';
import type { AssetClass, MarketSector, NormalisedUpdate } from '@terminal/core';
import { HDS } from '@terminal/core/functions/manifests/HDS';
import type { HdsEquityPayload, HdsFundPayload, HdsPayload } from '@terminal/core/functions/manifests/HDS';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as HDSModule from '../../../src/functions/HDS/resolve.js';
import { masterRepositories } from '../../../src/refdata/master.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = new Date('2020-01-01T00:00:00Z');

/** Both ownership files report the same date, so `source: 'any'` has to break the tie. */
const FILE_DATE = '2026-06-30';
/** Shares outstanding of the subject equity, from its own `dei:` fact. */
const SHARES_OUT = 15_000_000_000;
/** Lines in the fund's own holdings file, one of which never resolved. */
const FUND_LINES = 12;

/**
 * A **fixed** ticker tag. The whole fixture lives inside a rolled-back transaction, so a constant
 * ticker collides with nothing, and a constant ticker is what lets the goldens pin the payload's
 * keys instead of tokenising them away.
 */
const TAG = 'ZQTH';
const SUBJECT_CIK = '0009900001';
const NO_CIK_TICKER = `HN${TAG}`;

const REGISTRY = new FunctionRegistry([HDS]);
const MODULES: Record<string, FunctionServerModule<never, never>> = {
  HDS: HDSModule as unknown as FunctionServerModule<never, never>,
};

const t: TestDb = withTxDb();

interface Seeded {
  instrumentId: number;
  mdLineId: number;
  issuerId: number;
  key: string;
  ticker: string;
}

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  cookie: string;
  knownAt: string;
  subject: Seeded;
  noCik: Seeded;
  fundA: Seeded;
  fundB: Seeded;
  index: Seeded;
  /** The instruments the fund's own file resolves to, in line order (one hole). */
  constituents: Seeded[];
}

let env: Env;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────────────────────

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
  assetClass: AssetClass;
  marketSector: MarketSector;
  cik?: string | null;
}): Promise<Seeded> {
  const repos = masterRepositories(t.db);
  const provenanceId = await bootstrapProvenance(t, 'internal.user', `hds-${spec.ticker}`);
  await bootstrapProvenance(t, 'cboe.quotes', `hds-src-${spec.ticker}`);
  const o = { validFrom: VALID_FROM, provenanceId };

  const issuerId = await repos.issuers.insert(
    { name: `${spec.name} issuer`, ...(spec.cik == null ? {} : { cik: spec.cik }) },
    o,
  );
  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass: spec.assetClass,
      securityType: spec.assetClass === 'equity' ? 'Common Stock' : 'ETP',
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
      exchCode: spec.marketSector === 'Index' ? 'INDEX' : 'US',
      name: spec.name,
      currency: 'USD',
    },
    o,
  );
  const listingId = await repos.listings.insert(
    { instrumentId, exchCode: 'UW', localTicker: spec.ticker, isPrimary: true, mic: 'XNAS' },
    o,
  );
  const { mdLineId } = await repos.mdLines.upsertBySymbol(
    {
      instrumentId,
      listingId,
      sourceId: 'cboe.quotes',
      providerSymbol: `${spec.ticker}.${String(instrumentId)}`,
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 60_000,
      priority: 10,
    },
    o,
  );
  return {
    instrumentId,
    mdLineId,
    issuerId,
    ticker: spec.ticker,
    key:
      spec.marketSector === 'Index'
        ? `${spec.ticker} ${spec.marketSector}`
        : `${spec.ticker} US ${spec.marketSector}`,
  };
}

function quote(
  seeded: Seeded,
  provenanceId: number,
  last: number,
  assetClass: AssetClass = 'equity',
): NormalisedUpdate {
  return {
    subject: `q:${String(seeded.instrumentId)}`,
    instrumentId: seeded.instrumentId,
    mdLineId: seeded.mdLineId,
    assetClass,
    tier: 'delayed',
    fields: { PX_LAST: last, PX_CLOSE_1D: Number((last * 0.995).toFixed(4)) },
    ts: { src: GOLDEN_CAPTURE_MS - 900_000, cap: GOLDEN_CAPTURE_MS, pub: 0 },
    prov: { sourceId: 'cboe.quotes', provenanceId, srcSeq: 7 },
  };
}

interface HoldingLine {
  lineNo: number;
  holdingInstrumentId: number | null;
  name: string;
  cusip: string | null;
  isin: string | null;
  ticker: string | null;
  shares: number;
  marketValue: number;
  weight: number;
  assetCat: string;
  issuerCat: string;
  country: string;
}

async function insertHoldings(
  etfInstrumentId: number,
  sourceId: string,
  provenanceId: number,
  lines: readonly HoldingLine[],
): Promise<void> {
  await t.client.query(
    `INSERT INTO etf_holdings (etf_instrument_id, as_of_date, source_id, line_no,
                               holding_instrument_id, name, cusip, isin, ticker, shares,
                               market_value, weight, asset_cat, issuer_cat, country, provenance_id)
     SELECT $1::bigint, $2::date, $3, v.line_no, v.holding_instrument_id::bigint, v.name,
            v.cusip, v.isin, v.ticker, v.shares::numeric(20,4), v.market_value::numeric(20,2),
            v.weight::numeric(12,10), v.asset_cat, v.issuer_cat, v.country, $4::bigint
       FROM jsonb_to_recordset($5::jsonb) AS v(line_no int, holding_instrument_id bigint,
                                               name text, cusip text, isin text, ticker text,
                                               shares numeric, market_value numeric,
                                               weight numeric, asset_cat text, issuer_cat text,
                                               country text)`,
    [
      etfInstrumentId,
      FILE_DATE,
      sourceId,
      provenanceId,
      JSON.stringify(
        lines.map((l) => ({
          line_no: l.lineNo,
          holding_instrument_id: l.holdingInstrumentId,
          name: l.name,
          cusip: l.cusip,
          isin: l.isin,
          ticker: l.ticker,
          shares: l.shares,
          market_value: l.marketValue,
          weight: l.weight,
          asset_cat: l.assetCat,
          issuer_cat: l.issuerCat,
          country: l.country,
        })),
      ),
    ],
  );
}

beforeEach(async () => {
  await ensureLicences();

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`HDS Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'HDS User', 'user') RETURNING user_id`,
    [firmId, `hds-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  await grantEverySource(firmId, userId);

  // ── the universe ──────────────────────────────────────────────────────────────────────────
  const subject = await seedInstrument({
    ticker: `HS${TAG}`,
    name: `Subject ${TAG} Inc`,
    assetClass: 'equity',
    marketSector: 'Equity',
    cik: SUBJECT_CIK,
  });
  const noCik = await seedInstrument({
    ticker: NO_CIK_TICKER,
    name: `No Filer ${TAG} Inc`,
    assetClass: 'equity',
    marketSector: 'Equity',
  });
  const index = await seedInstrument({
    ticker: `HX${TAG}`,
    name: `Index ${TAG}`,
    assetClass: 'index',
    marketSector: 'Index',
  });
  const fundA = await seedInstrument({
    ticker: `HA${TAG}`,
    name: `Fund A ${TAG} Trust`,
    assetClass: 'etf',
    marketSector: 'Equity',
    cik: '0009900002',
  });
  const fundB = await seedInstrument({
    ticker: `HB${TAG}`,
    name: `Fund B ${TAG} Trust`,
    assetClass: 'etf',
    marketSector: 'Equity',
    cik: '0009900003',
  });

  // Eleven resolvable constituents of the fund's own file; the twelfth line is the hole.
  const constituents: Seeded[] = [];
  for (let i = 1; i < FUND_LINES; i += 1) {
    constituents.push(
      await seedInstrument({
        ticker: `HC${TAG}${String(i).padStart(2, '0')}`,
        name: `Constituent ${TAG} ${String(i).padStart(2, '0')}`,
        assetClass: 'equity',
        marketSector: 'Equity',
      }),
    );
  }

  // ── fund terms: sponsor, expense ratio and the index fund A tracks ─────────────────────────
  const termsProv = await bootstrapProvenance(t, 'sec.archives', 'hds-terms');
  await t.client.query(
    `INSERT INTO fund_terms (instrument_id, fund_type, tracked_index_instrument_id, sponsor, cik,
                             series_id, expense_ratio, inception_date, distribution_freq,
                             valid_from, provenance_id)
     VALUES ($1::bigint, 'etf', $2::bigint, 'Terminal Asset Management', '0009900002', 'S000001',
             0.000945, '1993-01-22'::date, 'quarterly', $3::timestamptz, $4::bigint)`,
    [fundA.instrumentId, index.instrumentId, VALID_FROM.toISOString(), termsProv],
  );

  // ── the two ownership files over the subject equity ────────────────────────────────────────
  const nportProv = await bootstrapProvenance(t, 'sec.archives', 'hds-nport');
  const ssgaProv = await bootstrapProvenance(t, 'ssga.holdings', 'hds-ssga');

  // Fund A's own file (N-PORT and SSGA on the same date, so `any` has to prefer SSGA).
  const fundLines = (source: 'nport' | 'ssga'): HoldingLine[] => {
    const lines: HoldingLine[] = [
      {
        lineNo: 1,
        holdingInstrumentId: subject.instrumentId,
        name: `Subject ${TAG} Inc`,
        cusip: '037833100',
        isin: 'US0378331005',
        ticker: subject.ticker,
        shares: source === 'ssga' ? 183_546_100 : 181_000_000,
        marketValue: source === 'ssga' ? 42_233_481_900 : 41_000_000_000,
        weight: 0.0712,
        assetCat: 'EC',
        issuerCat: 'CORP',
        country: 'US',
      },
    ];
    constituents.forEach((c, i) => {
      lines.push({
        lineNo: i + 2,
        holdingInstrumentId: c.instrumentId,
        name: `Constituent ${TAG} ${String(i + 1).padStart(2, '0')}`,
        cusip: `10000000${String(i)}`.slice(0, 9),
        isin: `US10000000${String(i)}`.slice(0, 12),
        ticker: c.ticker,
        shares: 1_000_000 + i * 13_000,
        marketValue: 500_000_000 - i * 7_000_000,
        weight: Number((0.09 - i * 0.004).toFixed(10)),
        assetCat: i >= 9 ? 'DBT' : 'EC',
        issuerCat: 'CORP',
        country: i % 3 === 0 ? 'US' : 'IE',
      });
    });
    lines.push({
      lineNo: FUND_LINES + 1,
      holdingInstrumentId: null,
      name: `Unresolved ${TAG} Holding`,
      cusip: '999999999',
      isin: null,
      ticker: null,
      shares: 120_000,
      marketValue: 4_000_000,
      weight: 0.0008,
      assetCat: 'STIV',
      issuerCat: 'CORP',
      country: 'US',
    });
    return lines;
  };
  await insertHoldings(fundA.instrumentId, 'sec.archives', nportProv, fundLines('nport'));
  await insertHoldings(fundA.instrumentId, 'ssga.holdings', ssgaProv, fundLines('ssga'));

  // Fund B reports the subject too, from the N-PORT side only — so the equity variant has two
  // holders, from two sources, and the summary has something to aggregate.
  await insertHoldings(fundB.instrumentId, 'sec.archives', nportProv, [
    {
      lineNo: 1,
      holdingInstrumentId: subject.instrumentId,
      name: `Subject ${TAG} Inc`,
      cusip: '037833100',
      isin: 'US0378331005',
      ticker: subject.ticker,
      shares: 24_500_000,
      marketValue: 5_600_000_000,
      weight: 0.0153,
      assetCat: 'EC',
      issuerCat: 'CORP',
      country: 'US',
    },
  ]);

  // ── the subject's own shares-outstanding fact and its insider filings ──────────────────────
  const factsProv = await bootstrapProvenance(t, 'sec.companyfacts', 'hds-facts');
  await t.client.query(
    `INSERT INTO xbrl_facts (cik, issuer_id, taxonomy, concept, unit, period_start, period_end,
                             fy, fp, form, accession_no, filed_at, frame, value, captured_at,
                             provenance_id)
     VALUES ($1, $2::bigint, 'dei', 'EntityCommonStockSharesOutstanding', 'shares', NULL,
             '2026-06-27'::date, 2026, 'Q3', '10-Q', '0000990000-26-000001', '2026-07-31'::date,
             NULL, $3::numeric, $4::timestamptz, $5::bigint)`,
    [SUBJECT_CIK, subject.issuerId, SHARES_OUT, GOLDEN_ISO, factsProv],
  );

  const filingProv = await bootstrapProvenance(t, 'sec.submissions', 'hds-filings');
  await t.client.query(
    `INSERT INTO filings (accession_no, cik, issuer_id, form, filed_date, accepted_at,
                          report_date, items, primary_doc, primary_doc_desc, is_xbrl,
                          is_inline_xbrl, size_bytes, url, captured_at, provenance_id)
     SELECT v.accession_no, $1, $2::bigint, v.form, v.filed_date::date, v.accepted_at::timestamptz,
            v.report_date::date, '{}'::text[], v.primary_doc, v.primary_doc_desc, false, false,
            4096, v.url, $3::timestamptz, $4::bigint
       FROM jsonb_to_recordset($5::jsonb) AS v(accession_no text, form text, filed_date text,
                                               accepted_at text, report_date text,
                                               primary_doc text, primary_doc_desc text, url text)`,
    [
      SUBJECT_CIK,
      subject.issuerId,
      GOLDEN_ISO,
      filingProv,
      JSON.stringify([
        {
          accession_no: '0000990000-26-000082',
          form: '4',
          filed_date: '2026-08-04',
          accepted_at: '2026-08-04T20:14:22.000Z',
          report_date: '2026-08-01',
          primary_doc: 'wf-form4.xml',
          primary_doc_desc: 'FORM 4',
          url: 'https://www.sec.gov/Archives/edgar/data/990000/000099000026000082/wf-form4.xml',
        },
        {
          accession_no: '0000990000-26-000070',
          form: '4',
          filed_date: '2026-06-12',
          accepted_at: '2026-06-12T18:02:11.000Z',
          report_date: '2026-06-10',
          primary_doc: 'wf-form4.xml',
          primary_doc_desc: 'FORM 4',
          url: 'https://www.sec.gov/Archives/edgar/data/990000/000099000026000070/wf-form4.xml',
        },
        {
          accession_no: '0000990000-26-000044',
          form: '3',
          filed_date: '2026-02-03',
          accepted_at: '2026-02-03T14:41:09.000Z',
          report_date: '2026-02-01',
          primary_doc: 'wf-form3.xml',
          primary_doc_desc: 'FORM 3',
          url: 'https://www.sec.gov/Archives/edgar/data/990000/000099000026000044/wf-form3.xml',
        },
        {
          accession_no: '0000990000-26-000011',
          form: '10-K',
          filed_date: '2026-01-29',
          accepted_at: '2026-01-29T21:00:00.000Z',
          report_date: '2025-12-31',
          primary_doc: 'form10k.htm',
          primary_doc_desc: '10-K',
          url: 'https://www.sec.gov/Archives/edgar/data/990000/000099000026000011/form10k.htm',
        },
      ]),
    ],
  );

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };
  const quoteProv = await bootstrapProvenance(t, 'cboe.quotes', 'hds-quote');
  harness.deps.plant.apply(quote(subject, quoteProv, 230.09));
  harness.deps.plant.apply(quote(fundA, quoteProv, 561.44, 'etf'));

  env = {
    harness,
    app: harness.app,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    knownAt,
    subject,
    noCik,
    fundA,
    fundB,
    index,
    constituents,
  };
});

afterEach(async () => {
  await env.harness.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Running
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface RunResult<T extends HdsPayload> {
  data: T;
  meta: {
    resultId: string;
    provenance: { sourceId: string; attribution: string }[];
    unavailable: { field: string; reason: string; detail: string }[];
    page: { index: number; count: number; cursor: string | null } | null;
  };
}

async function runHDS<T extends HdsPayload>(
  instrumentId: number,
  params: Record<string, unknown> = {},
): Promise<RunResult<T>> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/HDS/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params,
      security: { id: instrumentId },
      asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<RunResult<T>>();
}

/**
 * The keys of an HDS payload that carry a seeded instrument id: the subject security's, the fund's,
 * each holder's and each holding's (§HDS). `sourceId` (`'ssga.holdings'`) is a name.
 */
const ID_KEYS: ReadonlySet<string> = new Set([
  'instrumentId',
  'holderInstrumentId',
  'holdingInstrumentId',
]);

/** Id keys the fixture does not control, recorded as present rather than by value. */
const FLAT_ID_KEYS: ReadonlySet<string> = new Set(['issuerId']);

function normalise(payload: HdsPayload): unknown {
  const tokens = new Map<number, string>([
    [env.subject.instrumentId, '<SUBJECT>'],
    [env.noCik.instrumentId, '<NOCIK>'],
    [env.fundA.instrumentId, '<FUNDA>'],
    [env.fundB.instrumentId, '<FUNDB>'],
    [env.index.instrumentId, '<INDEX>'],
  ]);
  for (const [i, c] of env.constituents.entries()) {
    tokens.set(c.instrumentId, `<C${String(i + 1).padStart(2, '0')}>`);
  }
  const json = JSON.stringify(payload, (key, value: unknown) => {
    if (typeof value === 'string') return subjectToken(value, tokens);
    // `issuers.issuer_id` is a sequence value the fixture does not control, so the golden records
    // that there is one rather than which number this run drew.
    if (FLAT_ID_KEYS.has(key) && typeof value === 'number') return `<${key.toUpperCase()}>`;
    // The token map used to be consulted for *every* number, with `provIdx` carved out by hand —
    // the carve-out being the defect admitting itself. A holders table is weights, shares held,
    // percentages of shares outstanding and market caps; an id is now an id because of the key it
    // sits under, so `provIdx` needs no exception and neither does anything else.
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('HDS — equity holders', () => {
  it('lists every ingested fund that reports the name, with its weight and % of shares out', async () => {
    const { data, meta } = await runHDS<HdsEquityPayload>(env.subject.instrumentId);

    expect(data.variant).toBe('equity');
    expect(data.view).toBe('HOLDERS');
    expect(data.security.key).toBe(env.subject.key);
    expect(data.security.cik).toBe(SUBJECT_CIK);

    expect(data.holders).toHaveLength(2);
    // Weight-descending, which is the default sort.
    expect(data.holders[0]!.weightInHolder).toBeGreaterThan(data.holders[1]!.weightInHolder!);
    for (const holder of data.holders) {
      expect(holder.holderKind).toBe('etf');
      expect(holder.provIdx).toBeGreaterThanOrEqual(0);
      expect(holder.asOfDate).toBe(FILE_DATE);
      expect(holder.pctSharesOut).toBeCloseTo(holder.shares! / SHARES_OUT, 12);
    }
    expect(data.holders.map((h) => h.holderKey).sort()).toEqual(
      [env.fundA.key, env.fundB.key].sort(),
    );

    // The summary aggregates the unpaged set.
    expect(data.summary.holderCount).toBe(2);
    expect(data.summary.sharesHeld).toBe(
      data.holders.reduce((sum, h) => sum + (h.shares ?? 0), 0),
    );
    expect(data.summary.pctSharesOutHeld).toBeCloseTo(data.summary.sharesHeld! / SHARES_OUT, 12);
    expect(data.summary.asOfDate).toBe(FILE_DATE);
    expect(data.summary.sources.sort()).toEqual(['sec.archives', 'ssga.holdings']);

    // Share base and the market cap derived from it.
    expect(data.shareBase.sharesOut.v).toBe(SHARES_OUT);
    expect(data.shareBase.px.v).toBe(230.09);
    expect(data.shareBase.marketCap.v).toBeCloseTo(230.09 * SHARES_OUT, 2);
    expect(data.shareBase.marketCap.provIdx).toBe(data.shareBase.px.provIdx);

    const sources = meta.provenance.map((p) => p.sourceId);
    expect(sources).toContain('sec.archives');
    expect(sources).toContain('ssga.holdings');
    expect(sources).toContain('sec.companyfacts');
  });

  it('reserves 13F: null holders, a reason, and a 200 — never an error', async () => {
    const { data, meta } = await runHDS<HdsEquityPayload>(env.subject.instrumentId);
    expect(data.institutional).toEqual({ holders: null, reason: '13F_NOT_AVAILABLE' });
    expect(data.notes).toContain('13F_NOT_AVAILABLE');
    expect(data.holders.some((h) => h.holderKind === '13f')).toBe(false);

    const entry = meta.unavailable.find((u) => u.field === 'institutional')!;
    expect(entry.reason).toBe('NO_SOURCE');
    expect(entry.detail.startsWith('13F_NOT_AVAILABLE')).toBe(true);
    expect(entry.detail).toContain('N-PORT/SSGA');
  });

  it('says so when no ingested fund reports the name, rather than showing an empty grid', async () => {
    const { data, meta } = await runHDS<HdsEquityPayload>(env.noCik.instrumentId);
    expect(data.holders).toEqual([]);
    expect(data.summary.holderCount).toBe(0);
    expect(data.notes).toContain('HOLDERS_LIMITED_TO_SEEDED_FUNDS');
    const entry = meta.unavailable.find((u) => u.field === 'holders')!;
    expect(entry.detail.startsWith('HOLDERS_LIMITED_TO_SEEDED_FUNDS')).toBe(true);
    // Shares outstanding needs a CIK; without one the percent columns stay null.
    expect(data.shareBase.sharesOut.v).toBeNull();
  });

  it('pins the source and filters by weight', async () => {
    const pinned = await runHDS<HdsEquityPayload>(env.subject.instrumentId, {
      source: 'sec.archives',
    });
    expect(pinned.data.holders.map((h) => h.sourceId)).toEqual(['sec.archives', 'sec.archives']);

    const filtered = await runHDS<HdsEquityPayload>(env.subject.instrumentId, {
      minWeight: 0.05,
    });
    expect(filtered.data.holders).toHaveLength(1);
    expect(filtered.data.holders[0]!.weightInHolder).toBeCloseTo(0.0712, 10);
  });

  it('sorts by name when asked', async () => {
    const { data } = await runHDS<HdsEquityPayload>(env.subject.instrumentId, { sort: 'name' });
    const names = data.holders.map((h) => h.holderName);
    expect([...names].sort()).toEqual(names);
  });
});

describe('HDS — insiders (degraded, with the reason)', () => {
  it('lists Forms 3/4/5 with no share counts and the parse reason', async () => {
    const { data, meta } = await runHDS<HdsEquityPayload>(env.subject.instrumentId, {
      view: 'INSIDERS',
    });
    expect(data.view).toBe('INSIDERS');
    expect(data.insiders.shares).toBeNull();
    expect(data.insiders.transactions).toBeNull();
    expect(data.insiders.reason).toBe('INSIDER_HOLDINGS_NOT_PARSED');
    expect(data.notes).toContain('INSIDER_HOLDINGS_NOT_PARSED');

    // The 10-K is not an ownership form and is not listed.
    expect(data.insiders.filings.map((f) => f.form).sort()).toEqual(['3', '4', '4']);
    for (const filing of data.insiders.filings) {
      expect(filing.url.startsWith('https://www.sec.gov/')).toBe(true);
      expect(filing.provIdx).toBeGreaterThanOrEqual(0);
    }

    const entry = meta.unavailable.find(
      (u) => u.field === 'insiders' && u.detail.startsWith('INSIDER_HOLDINGS_NOT_PARSED'),
    );
    expect(entry).toBeDefined();
    // The 13F block is reserved on the insiders tab too.
    expect(data.institutional.reason).toBe('13F_NOT_AVAILABLE');
  });

  it('answers an issuer with no CIK with an empty list and the CIK reason', async () => {
    const { data, meta } = await runHDS<HdsEquityPayload>(env.noCik.instrumentId, {
      view: 'INSIDERS',
    });
    expect(data.insiders.filings).toEqual([]);
    const entry = meta.unavailable.find(
      (u) => u.field === 'insiders' && u.detail.includes('no SEC CIK'),
    );
    expect(entry).toBeDefined();
  });
});

describe('HDS — fund holdings', () => {
  it("serves the fund's own file with subtotals, unresolved lines and live cells", async () => {
    const { data, meta } = await runHDS<HdsFundPayload>(env.fundA.instrumentId);

    expect(data.variant).toBe('fund');
    expect(data.fund.key).toBe(env.fundA.key);
    expect(data.fund.sponsor).toBe('Terminal Asset Management');
    expect(data.fund.expenseRatio).toBeCloseTo(0.000945, 9);
    expect(data.fund.trackedIndex).toEqual({
      instrumentId: env.index.instrumentId,
      key: env.index.key,
    });

    expect(data.nav.px.v).toBe(561.44);
    expect(data.file.count).toBe(FUND_LINES + 1);
    expect(data.file.asOfDate).toBe(FILE_DATE);
    expect(data.file.provIdx).toBeGreaterThanOrEqual(0);

    // The file is ten weeks behind the session, and the screen says so.
    expect(data.notes).toContain('PROXY_FILE_LAGS_SESSION');

    // The unresolved line is present, counted and never guessed at.
    expect(data.unresolved).toEqual({ count: 1, reason: 'UNRESOLVED_IDENTIFIER' });
    expect(data.notes).toContain('UNRESOLVED_CONSTITUENTS');
    const hole = data.holdings.find((h) => h.holdingInstrumentId === null)!;
    expect(hole.key).toBeNull();
    expect(hole.subject).toBeNull();
    expect(hole.px.v).toBeNull();
    const entry = meta.unavailable.find((u) => u.field === 'holdings.key')!;
    expect(entry.detail).toContain('UNRESOLVED_CONSTITUENTS: 1 line(s)');

    // Subtotals are computed over the unpaged set and cover every line exactly once.
    expect(data.byAssetCat.reduce((sum, c) => sum + c.count, 0)).toBe(FUND_LINES + 1);
    expect(data.byAssetCat.map((c) => c.assetCat).sort()).toEqual(['DBT', 'EC', 'STIV']);

    // A resolved row is registered for live updates; the hole is not.
    const resolved = data.holdings.find((h) => h.holdingInstrumentId !== null)!;
    expect(resolved.subject).toBe(`q:${String(resolved.holdingInstrumentId!)}`);
    expect(resolved.px.live).toEqual({ subject: resolved.subject, field: 'PX_LAST' });

    // `netAssets` is not stored anywhere this read can reach, and is not reconstructed.
    expect(data.file.netAssets).toBeNull();
    expect(meta.unavailable.find((u) => u.field === 'file.netAssets')?.detail).toContain(
      'NET_ASSETS_NOT_STORED',
    );
  });

  it('prefers the SSGA file when both sources report the same date, and never merges them', async () => {
    const any = await runHDS<HdsFundPayload>(env.fundA.instrumentId);
    expect(any.data.file.sourceId).toBe('ssga.holdings');
    expect(any.data.file.count).toBe(FUND_LINES + 1);
    const subjectLine = any.data.holdings.find(
      (h) => h.holdingInstrumentId === env.subject.instrumentId,
    )!;
    expect(subjectLine.shares).toBe(183_546_100);

    const pinned = await runHDS<HdsFundPayload>(env.fundA.instrumentId, {
      source: 'sec.archives',
    });
    expect(pinned.data.file.sourceId).toBe('sec.archives');
    expect(pinned.data.file.count).toBe(FUND_LINES + 1);
    const pinnedLine = pinned.data.holdings.find(
      (h) => h.holdingInstrumentId === env.subject.instrumentId,
    )!;
    expect(pinnedLine.shares).toBe(181_000_000);
  });

  it('pages without repeating or skipping a line', async () => {
    const first = await runHDS<HdsFundPayload>(env.fundA.instrumentId, { limit: 10 });
    expect(first.data.holdings).toHaveLength(10);
    expect(first.meta.page).toEqual({
      index: 0,
      count: FUND_LINES + 1,
      cursor: expect.any(String),
    });

    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/HDS/page`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: { resultId: first.meta.resultId, direction: 'fwd' },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const second = res.json<RunResult<HdsFundPayload>>();
    expect(second.meta.page!.index).toBe(10);
    const firstLines = new Set(first.data.holdings.map((h) => h.lineNo));
    for (const row of second.data.holdings) expect(firstLines.has(row.lineNo)).toBe(false);
    // Weight-descending across the page boundary.
    const lastOfFirst = first.data.holdings.at(-1)!.weight!;
    expect(second.data.holdings[0]!.weight!).toBeLessThanOrEqual(lastOfFirst);
  });

  it('refuses a tampered cursor', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/HDS/page`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: { resultId: 'not-a-result-id', direction: 'fwd' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('HDS — goldens', () => {
  it('deep-equals the committed equity golden at the frozen clock', async () => {
    const { data } = await runHDS<HdsEquityPayload>(env.subject.instrumentId);
    expectGolden('HDS.equity.json', normalise(data));
  });

  it('deep-equals the committed fund golden at the frozen clock', async () => {
    const { data } = await runHDS<HdsFundPayload>(env.fundA.instrumentId, { limit: 20 });
    expectGolden('HDS.fund.json', normalise(data));
  });
});
