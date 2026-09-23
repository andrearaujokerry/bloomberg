/**
 * `test/integration/functions/DES.test.ts` — WP-09's acceptance row for `DES`
 * (WORKPLAN §WP-09: "all eight variants resolve for seeded securities; every displayed value
 * carries a provenance index; unavailable fields carry a reason").
 *
 * DES is the reason `FunctionManifest.variants` exists: nine asset classes, eight entirely
 * different screens, one code (FUNC-02). So this file seeds one security per variant and runs the
 * real HTTP route against each, which is the only way to prove the runner's step-7 assertion —
 * `payload.variant === manifest.variants[assetClass]` — for every branch of the map at once.
 *
 * ## The two properties, asserted over the whole payload rather than sampled
 *
 * `provenanceCoverage()` walks every node of every payload and applies DATA-10 and §1.3 rule 6 to
 * each `ValueCell` it finds:
 *
 *  - **a number is attributable** — a cell holding a finite number must carry a `provIdx` that
 *    indexes a real `meta.provenance` entry. Spot-checking four cells would pass on a screen whose
 *    fifth cell was invented, which is exactly the failure DATA-10 exists to prevent;
 *  - **a null is explained** — a cell holding `null` must carry either an entitlement reason `r`
 *    (the field was refused) or a `meta.unavailable` entry (the value is not there, and why), and
 *    its state must be `'na'` or `'blank'` rather than a state that claims a value.
 *
 * Every block-level `provIdx` — the issuer, the terms, a filing row, a headline — is checked the
 * same way: a citation is either a real index or the documented `-1` ("no provenance yet", §0.4
 * rule 1), never a plausible-looking number.
 *
 * ## The goldens
 *
 * `fixtures/golden/functions/DES.<variant>.json` is the payload at the frozen clock
 * `2026-09-15T18:41:28Z`, with the database's own sequence values replaced by stable tokens. The
 * golden lives beside the fixtures, not in the test: a golden a test writes proves nothing.
 *
 * ## No seed
 *
 * WP-15 owns the seed and it does not exist. Every calendar, exchange, issuer, instrument,
 * listing, line, bar, filing, fact, fixing, observation, curve point and headline here is created
 * inside this file's own `withTxDb()` transaction, and nothing depends on a literal instrument id.
 * Provider symbols carry a per-run tag because `md_lines_symbol_excl` makes `(source_id,
 * provider_symbol)` a global namespace and four integration forks share one database; `normalise`
 * strips the tag again, so the golden still reads `AAPL`.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden } from './golden.js';

import type { NormalisedUpdate } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { FX_USD } from '@terminal/core/calendars/fx';
import { XNAS } from '@terminal/core/calendars/nyse';
import { SIFMA } from '@terminal/core/calendars/sifma';
import { USGOVT } from '@terminal/core/calendars/usgovt';
import { WEEKEND } from '@terminal/core/calendars/weekend';
import { DES } from '@terminal/core/functions/manifests/DES';
import type { DesPayload } from '@terminal/core/functions/manifests/DES';

import { getConfig } from '../../../src/config.js';
import * as DesModule from '../../../src/functions/DES/resolve.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import { materialiseCalendar } from '../../../src/refdata/calendars.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { ensureShared, withTxDb, type TestDb } from '../../../src/test/db.js';
import { readNormalised } from '../../../src/test/fixtures.js';
import { GOLDEN_CAPTURE_MS } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const AS_OF_DATE = GOLDEN_ISO.slice(0, 10);
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = '2020-01-01T00:00:00.000Z';

/** `md_lines_symbol_excl` is a global namespace; `normalise` strips this again. */
const TAG = `.t${randomUUID().slice(0, 8)}`;


const REGISTRY = new FunctionRegistry([DES]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { DES: DesModule };

const t: TestDb = withTxDb();

interface Seeded {
  instrumentId: number;
  issueId: number;
  listingId: number | null;
  mdLineId: number | null;
}

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  issuerId: number;
  by: Map<string, Seeded>;
  prov: Map<string, number>;
  seriesId: number;
  releaseId: number;
  indexId: number;
  /** `fixtures/providers/normalised/coingecko-simple.json`, the crypto variant's own capture. */
  btcQuote: CoingeckoQuote;
}

/** One `coingecko.simple` quote as WP-05's normaliser hands it on. */
interface CoingeckoQuote {
  id: string;
  usd: number;
  change24hPct: number;
  /** `usd / (1 + change24hPct/100)` — the rolling 24-hour reference the API implies. */
  impliedPrevClose: number;
  impliedPrevCloseIsRolling: boolean;
}

interface CoingeckoFixture {
  quotes: CoingeckoQuote[];
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
  const key = `des-${sourceId}-${randomUUID()}`;
  const res = await t.client.query<{ provenance_id: string }>(
    `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                             http_status, bytes, captured_at, source_ts, adapter_version)
     VALUES ($1,$2,'test://des/' || $2, digest($2,'sha256'), digest($2,'sha256'), 200, 0, $3, $3,
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
  key: string;
  ticker: string;
  name: string;
  assetClass: string;
  marketSector: string;
  exchCode: string;
  securityType: string;
  issuerId?: number;
  priceDecimals?: number;
  searchWeight?: number;
  firstTradeDate?: string;
  listing?: { mic: string; exchCode: string };
  line?: { sourceId: string; providerSymbol: string; lineKind?: string; delayMin?: number };
}

async function seedSecurity(spec: SecuritySpec): Promise<Seeded> {
  const p = await provenanceFor('openfigi.mapping');
  const issueId = await nextId('issue_id_seq');
  const instrumentId = await nextId('instrument_id_seq');
  // `bt_guard_update` makes a written row immutable, so the primary listing id is reserved first.
  const listingId = spec.listing === undefined ? null : await nextId('listing_id_seq');

  await t.client.query(
    `INSERT INTO issues (issue_id, issuer_id, asset_class, security_type, name, currency,
                         country_of_issue, valid_from, tx_from, provenance_id)
     VALUES ($1,$2,$3::asset_class,$4,$5,'USD','US',$6::timestamptz,$6::timestamptz,$7)`,
    [
      issueId,
      spec.issuerId ?? env.issuerId,
      spec.assetClass,
      spec.securityType,
      spec.name,
      VALID_FROM,
      p,
    ],
  );
  await t.client.query(
    `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                              exch_code, name, currency, status, search_weight, price_decimals,
                              primary_listing_id, first_trade_date, valid_from, tx_from,
                              provenance_id)
     VALUES ($1,$2,$3::asset_class,$4::market_sector,$5,$6,$7,'USD','active',$8,$9,$10,$11,
             $12::timestamptz,$12::timestamptz,$13)`,
    [
      instrumentId,
      issueId,
      spec.assetClass,
      spec.marketSector,
      spec.ticker,
      spec.exchCode,
      spec.name,
      spec.searchWeight ?? 1,
      spec.priceDecimals ?? 2,
      listingId,
      spec.firstTradeDate ?? null,
      VALID_FROM,
      p,
    ],
  );
  if (spec.listing !== undefined && listingId !== null) {
    await t.client.query(
      `INSERT INTO listings (listing_id, instrument_id, mic, exch_code, local_ticker, is_primary,
                             valid_from, tx_from, provenance_id)
       VALUES ($1,$2,$3,$4,$5,true,$6::timestamptz,$6::timestamptz,$7)`,
      [
        listingId,
        instrumentId,
        spec.listing.mic,
        spec.listing.exchCode,
        spec.ticker,
        VALID_FROM,
        p,
      ],
    );
  }

  let mdLineId: number | null = null;
  if (spec.line !== undefined) {
    const lineProv = await provenanceFor(spec.line.sourceId);
    mdLineId = await nextId('md_line_id_seq');
    await t.client.query(
      `INSERT INTO md_lines (md_line_id, instrument_id, listing_id, source_id, provider_symbol,
                             line_kind, intrinsic_delay_min, expected_interval_ms, priority,
                             valid_from, tx_from, provenance_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,10000,10,$8::timestamptz,$8::timestamptz,$9)`,
      [
        mdLineId,
        instrumentId,
        listingId,
        spec.line.sourceId,
        `${spec.line.providerSymbol}${TAG}`,
        spec.line.lineKind ?? 'composite',
        spec.line.delayMin ?? 15,
        VALID_FROM,
        lineProv,
      ],
    );
  }

  const seeded: Seeded = { instrumentId, issueId, listingId, mdLineId };
  env.by.set(spec.key, seeded);
  return seeded;
}

/** `n` weekdays ending at `AS_OF_DATE`, oldest first — the session dates the bars are stamped on. */
function sessionDates(n: number): string[] {
  const out: string[] = [];
  let ms = Date.parse(`${AS_OF_DATE}T00:00:00.000Z`);
  while (out.length < n) {
    const day = new Date(ms);
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.unshift(day.toISOString().slice(0, 10));
    ms -= 86_400_000;
  }
  return out;
}

const BAR_DATES = sessionDates(60);

async function seedBars(
  instrumentId: number,
  mdLineId: number,
  base: number,
  step: number,
): Promise<void> {
  const p = await provenanceFor('yahoo.chart');
  const values = BAR_DATES.map((date, i) => {
    const close = base + i * step;
    return `(${String(instrumentId)}, '${date}', ${String(mdLineId)}, ${(close - step / 2).toFixed(6)},
             ${(close + step).toFixed(6)}, ${(close - step).toFixed(6)}, ${close.toFixed(6)},
             ${String(1_000_000 + i * 1_000)}, '${date}T20:00:00Z', '${date}T20:05:00Z', ${String(p)})`;
  }).join(',');
  await t.client.query(
    `INSERT INTO bars_daily (instrument_id, session_date, md_line_id, open, high, low, close,
                             volume, source_ts, capture_ts, provenance_id)
     VALUES ${values}`,
  );
}

function update(spec: {
  instrumentId: number;
  mdLineId: number;
  sourceId: string;
  provenanceId: number;
  assetClass: NormalisedUpdate['assetClass'];
  fields: NormalisedUpdate['fields'];
  subject?: string;
}): NormalisedUpdate {
  return {
    subject: spec.subject ?? `q:${String(spec.instrumentId)}`,
    instrumentId: spec.instrumentId,
    mdLineId: spec.mdLineId,
    assetClass: spec.assetClass,
    tier: 'delayed',
    fields: spec.fields,
    ts: { src: GOLDEN_CAPTURE_MS - 60_000, cap: GOLDEN_CAPTURE_MS, pub: 0 },
    prov: { sourceId: spec.sourceId, provenanceId: spec.provenanceId },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The universe
// ─────────────────────────────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await ensureLicences();

  // The five calendars the eight variants are described on (§0.6, §DES L246). One year each: the
  // calendar tables are shared and a wide range holds locks for the length of the file.
  for (const calendar of [XNAS, SIFMA, FX_USD, WEEKEND, USGOVT]) {
    await materialiseCalendar(t.db, calendar, { fromYear: 2026, toYear: 2026 });
  }
  await t.client.query(
    `INSERT INTO exchanges (mic, operating_mic, name, country, tz, calendar_id, bbg_exch_code,
                            composite_code)
     VALUES ('XNAS','XNAS','Nasdaq','US','America/New_York','XNAS','UW','US')
     ON CONFLICT (mic) DO NOTHING`,
  );

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`DES Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1,$2,'DES User','user') RETURNING user_id`,
    [firmId, `des-${randomUUID()}@demo.invalid`],
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
    by: new Map(),
    prov: new Map(),
    seriesId: 0,
    releaseId: 0,
    indexId: 0,
    btcQuote: { id: '', usd: 0, change24hPct: 0, impliedPrevClose: 0, impliedPrevCloseIsRolling: true },
  };

  const figiProv = await provenanceFor('openfigi.mapping');
  const secProv = await provenanceFor('sec.submissions');

  // ── the issuer, its classification and its aliases ────────────────────────────────────────
  env.issuerId = await nextId('issuer_id_seq');
  await t.client.query(
    `INSERT INTO issuers (issuer_id, name, legal_name, lei, cik, country, state_of_inc, sic,
                          sic_description, entity_type, fiscal_year_end, filer_category, website,
                          former_names, valid_from, tx_from, provenance_id)
     VALUES ($1,'Apple Inc','Apple Inc.','HWUPKR0MPOU8FGXBT394','0000320193','US','CA','3571',
             'Electronic Computers','operating','0926','Large accelerated filer',
             'https://www.apple.com',
             '[{"name":"Apple Computer Inc","from":"1977-01-03","to":"2007-01-09"}]'::jsonb,
             $2::timestamptz,$2::timestamptz,$3)`,
    [env.issuerId, VALID_FROM, secProv],
  );
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
            ('GICS','45202030','Technology Hardware, Storage & Peripherals','4520',4)
     ON CONFLICT (scheme, code) DO NOTHING`,
  );
  await t.client.query(
    `INSERT INTO entity_classifications (entity_kind, entity_id, scheme, code, valid_from, tx_from,
                                         provenance_id)
     VALUES ('issuer',$1,'GICS','45',$2::timestamptz,$2::timestamptz,$3)`,
    [env.issuerId, VALID_FROM, await provenanceFor('wiki.sp500')],
  );

  // ── equity: AAPL ──────────────────────────────────────────────────────────────────────────
  const aapl = await seedSecurity({
    key: 'AAPL',
    ticker: 'AAPL',
    name: 'Apple Inc',
    assetClass: 'equity',
    marketSector: 'Equity',
    exchCode: 'US',
    securityType: 'Common Stock',
    searchWeight: 5,
    firstTradeDate: '1980-12-12',
    listing: { mic: 'XNAS', exchCode: 'UW' },
    line: { sourceId: 'cboe.quotes', providerSymbol: 'AAPL' },
  });
  await t.client.query(
    `INSERT INTO identifiers (entity_kind, entity_id, scheme, value, is_primary, valid_from,
                              tx_from, provenance_id)
     VALUES ('instrument',$1,'FIGI','BBG000B9XRY4',true,$2::timestamptz,$2::timestamptz,$3),
            ('instrument',$1,'ISIN','US0378331005',true,$2::timestamptz,$2::timestamptz,$3),
            ('instrument',$1,'CUSIP','037833100',true,$2::timestamptz,$2::timestamptz,$3)`,
    [aapl.instrumentId, VALID_FROM, figiProv],
  );
  await seedBars(aapl.instrumentId, aapl.mdLineId!, 300, 0.5);

  // Filings: three quarters, a year and an 8-K, so the cadence projection has something to work on.
  const filingRows = [
    ['0000320193-25-000101', '10-K', '2025-11-01', '2025-09-27', '{}'],
    ['0000320193-26-000010', '10-Q', '2026-02-01', '2025-12-27', '{}'],
    ['0000320193-26-000031', '10-Q', '2026-05-02', '2026-03-28', '{}'],
    ['0000320193-26-000055', '10-Q', '2026-08-01', '2026-06-27', '{}'],
    ['0000320193-26-000061', '8-K', '2026-09-01', null, '{2.02,9.01}'],
  ] as const;
  for (const [accession, form, filed, report, items] of filingRows) {
    const url =
      `https://www.sec.gov/Archives/edgar/data/320193/${accession.replace(/-/g, '')}/` +
      `${accession}-index.htm`;
    await t.client.query(
      `INSERT INTO filings (accession_no, cik, issuer_id, form, filed_date, accepted_at,
                            report_date, items, primary_doc, primary_doc_desc, is_xbrl, url,
                            captured_at, provenance_id)
       VALUES ($1::char(20),'0000320193',$2::bigint,$3::text,$4::date,$5::timestamptz,$6::date,
               $7::text[],'primary.htm',$8::text,true,$9::text,$10::timestamptz,$11::bigint)`,
      [
        accession,
        env.issuerId,
        form,
        filed,
        `${filed}T21:00:00Z`,
        report,
        items,
        `${form} filing`,
        url,
        GOLDEN_ISO,
        secProv,
      ],
    );
  }

  const factsProv = await provenanceFor('sec.companyfacts');
  await t.client.query(
    `INSERT INTO xbrl_facts (cik, issuer_id, taxonomy, concept, unit, period_end, form,
                             accession_no, filed_at, value, captured_at, provenance_id)
     VALUES ('0000320193',$1,'dei','EntityCommonStockSharesOutstanding','shares','2026-06-27',
             '10-Q','0000320193-26-000055','2026-08-01',14900000000,$2::timestamptz,$3),
            ('0000320193',$1,'dei','EntityPublicFloat','USD','2026-03-28','10-Q',
             '0000320193-26-000031','2026-05-02',4700000000000,$2::timestamptz,$3)`,
    [env.issuerId, GOLDEN_ISO, factsProv],
  );
  await t.client.query(
    `INSERT INTO fin_statements (issuer_id, period_end, period_type, filed_at, mapping_version,
                                 fiscal_year, fiscal_period, accession_no, currency, revenue,
                                 net_inc, eps_dil, shares_dil, as_reported, engine_name,
                                 engine_version, inputs_hash, provenance_ids)
     VALUES ($1,'2026-06-27','TTM','2026-08-01','std-map/2026.09',2026,'TTM',
             '0000320193-26-000055','USD',416000000000,101000000000,6.55,15200000000,
             '{}'::jsonb,'statements','1.0.0',repeat('a',64),ARRAY[$2::bigint])`,
    [env.issuerId, factsProv],
  );

  const caProv = await provenanceFor('sec.archives');
  await t.client.query(
    `INSERT INTO corporate_actions (instrument_id, ca_type, status, ex_date, record_date, pay_date,
                                    amount, currency, source_id, valid_from, tx_from, provenance_id)
     VALUES ($1,'cash_dividend','paid','2026-02-06','2026-02-09','2026-02-12',0.26,'USD',
             'sec.archives',$2::timestamptz,$2::timestamptz,$3),
            ($1,'cash_dividend','paid','2026-05-08','2026-05-11','2026-05-14',0.27,'USD',
             'sec.archives',$2::timestamptz,$2::timestamptz,$3)`,
    [aapl.instrumentId, VALID_FROM, caProv],
  );
  await t.client.query(
    `INSERT INTO short_interest (instrument_id, settlement_date, short_qty, prev_short_qty,
                                 avg_daily_volume, days_to_cover, change_pct, provenance_id)
     VALUES ($1,'2026-08-31',101000000,98000000,55000000,1.84,3.06,$2)`,
    [aapl.instrumentId, await provenanceFor('finra.shortInterest')],
  );

  const newsProv = await provenanceFor('bbg.rss');
  const news = await t.client.query<{ news_id: string }>(
    `INSERT INTO news_items (source_id, feed, provider_guid, kind, headline, summary, url, author,
                             category, published_at, captured_at, provenance_id)
     VALUES ('bbg.rss','markets',$1,'story','Apple lifts services guidance','Summary text',
             'https://example.test/a','Wire','Markets',$2::timestamptz,$2::timestamptz,$3)
     RETURNING news_id`,
    [`des-news-${randomUUID()}`, GOLDEN_ISO, newsProv],
  );
  await t.client.query(
    `INSERT INTO news_entity_links (news_id, entity_kind, entity_id, confidence, method)
     VALUES ($1,'instrument',$2,1.0,'ticker_exact')`,
    [Number(news.rows[0]!.news_id), aapl.instrumentId],
  );

  // ── index: SPX, with AAPL as its one constituent ──────────────────────────────────────────
  const spx = await seedSecurity({
    key: 'SPX',
    ticker: 'SPX',
    name: 'S&P 500 Index',
    assetClass: 'index',
    marketSector: 'Index',
    exchCode: 'INDEX',
    securityType: 'Index',
    listing: { mic: 'XNAS', exchCode: 'UW' },
    line: { sourceId: 'cboe.quotes', providerSymbol: '_SPX' },
  });
  await seedBars(spx.instrumentId, spx.mdLineId!, 5000, 3);

  // ── etf: SPY, the proxy fund, so the index can name it and the fund block is non-null ─────
  const spy = await seedSecurity({
    key: 'SPY',
    ticker: 'SPY',
    name: 'SPDR S&P 500 ETF Trust',
    assetClass: 'etf',
    marketSector: 'Equity',
    exchCode: 'US',
    securityType: 'ETP',
    listing: { mic: 'XNAS', exchCode: 'UP' },
    line: { sourceId: 'cboe.quotes', providerSymbol: 'SPY' },
  });
  await seedBars(spy.instrumentId, spy.mdLineId!, 500, 0.4);
  await t.client.query(
    `INSERT INTO fund_terms (instrument_id, fund_type, tracked_index_instrument_id, sponsor, cik,
                             expense_ratio, inception_date, valid_from, tx_from, provenance_id)
     VALUES ($1,'etf',$2,'State Street Global Advisors','0000884394',0.000945,'1993-01-22',
             $3::timestamptz,$3::timestamptz,$4)`,
    [spy.instrumentId, spx.instrumentId, VALID_FROM, await provenanceFor('ssga.holdings')],
  );
  await t.client.query(
    `INSERT INTO etf_holdings (etf_instrument_id, as_of_date, source_id, line_no,
                               holding_instrument_id, name, shares, market_value, weight,
                               provenance_id)
     VALUES ($1,'2026-08-31','ssga.holdings',1,$2,'Apple Inc',180000000,59000000000,0.0712,$3)`,
    [spy.instrumentId, aapl.instrumentId, await provenanceFor('ssga.holdings')],
  );

  await t.client.query(
    `INSERT INTO index_terms (instrument_id, provider, methodology, calc_currency, region,
                              base_date, base_value, constituent_count, proxy_fund_instrument_id,
                              valid_from, tx_from, provenance_id)
     VALUES ($1,'S&P Dow Jones','float_cap_weighted','USD','Americas','1957-03-04',10,500,$2,
             $3::timestamptz,$3::timestamptz,$4)`,
    [spx.instrumentId, spy.instrumentId, VALID_FROM, figiProv],
  );
  const index = await t.client.query<{ index_id: string }>(
    `INSERT INTO indices (code, instrument_id, proxy_fund_instrument_id, membership_source_id,
                          provider)
     VALUES ('SPX',$1,$2,'ssga.holdings','S&P Dow Jones') RETURNING index_id`,
    [spx.instrumentId, spy.instrumentId],
  );
  env.indexId = Number(index.rows[0]!.index_id);
  await t.client.query(
    `INSERT INTO index_members (index_id, instrument_id, weight, shares, market_value, as_of_date,
                                source_id, valid_from, tx_from, provenance_id)
     VALUES ($1,$2,0.0712,180000000,59000000000,'2026-06-30','ssga.holdings',
             $3::timestamptz,$3::timestamptz,$4)`,
    [env.indexId, aapl.instrumentId, VALID_FROM, await provenanceFor('ssga.holdings')],
  );

  // ── fx: EURUSD ────────────────────────────────────────────────────────────────────────────
  const eur = await seedSecurity({
    key: 'EURUSD',
    ticker: 'EURUSD',
    name: 'Euro-US Dollar',
    assetClass: 'fx',
    marketSector: 'Curncy',
    exchCode: 'FX',
    securityType: 'Spot',
    priceDecimals: 4,
    line: { sourceId: 'yahoo.chart', providerSymbol: 'EURUSD=X' },
  });
  await seedBars(eur.instrumentId, eur.mdLineId!, 1.1, 0.0005);
  await t.client.query(
    `INSERT INTO fx_terms (instrument_id, base_ccy, quote_ccy, spot_lag, calendar_id, pip_size,
                           quote_convention, valid_from, tx_from, provenance_id)
     VALUES ($1,'EUR','USD',2,'FX_USD',0.0001,'quote_per_base',$2::timestamptz,$2::timestamptz,$3)`,
    [eur.instrumentId, VALID_FROM, figiProv],
  );
  const ecbProv = await provenanceFor('frankfurter');
  await t.client.query(
    `INSERT INTO fx_rates (base_ccy, quote_ccy, rate_date, rate, source_id, provenance_id)
     VALUES ('USD','EUR','2026-09-14',0.86663,'frankfurter',$1),
            ('USD','GBP','2026-09-14',0.73500,'frankfurter',$1)`,
    [ecbProv],
  );

  // ── govt: a four-week bill and a thirty-year note ─────────────────────────────────────────
  const treasuryIssuer = await nextId('issuer_id_seq');
  await t.client.query(
    `INSERT INTO issuers (issuer_id, name, country, entity_type, valid_from, tx_from, provenance_id)
     VALUES ($1,'United States Department of the Treasury','US','sovereign',
             $2::timestamptz,$2::timestamptz,$3)`,
    [treasuryIssuer, VALID_FROM, figiProv],
  );
  const bill = await seedSecurity({
    key: 'BILL',
    ticker: '912797VE4',
    name: 'United States Treasury Bill 4WK 09/29/26',
    assetClass: 'govt',
    marketSector: 'Govt',
    exchCode: 'GOVT',
    securityType: 'US GOVERNMENT',
    issuerId: treasuryIssuer,
    priceDecimals: 4,
  });
  await t.client.query(
    `INSERT INTO govt_terms (instrument_id, security_type, cusip, term_label, issue_date,
                             dated_date, maturity_date, coupon_type, coupon_rate, coupon_freq,
                             day_count, business_day_conv, calendar_id, settlement_days,
                             min_denomination, amount_outstanding, on_the_run, valid_from, tx_from,
                             provenance_id)
     VALUES ($1,'bill','912797VE4','4WK','2026-09-01','2026-09-01','2026-09-29','zero',NULL,0,
             'ACT/360','following','SIFMA',1,100,90000000000,true,
             $2::timestamptz,$2::timestamptz,$3)`,
    [bill.instrumentId, VALID_FROM, await provenanceFor('treasury.bills')],
  );
  const note = await seedSecurity({
    key: 'NOTE',
    ticker: 'T 4.25 08/15/36',
    name: 'United States Treasury Note 4.25% 08/15/36',
    assetClass: 'govt',
    marketSector: 'Govt',
    exchCode: 'GOVT',
    securityType: 'US GOVERNMENT',
    issuerId: treasuryIssuer,
    priceDecimals: 6,
  });
  await t.client.query(
    `INSERT INTO govt_terms (instrument_id, security_type, cusip, term_label, issue_date,
                             dated_date, maturity_date, coupon_type, coupon_rate, coupon_freq,
                             day_count, business_day_conv, calendar_id, settlement_days,
                             min_denomination, amount_outstanding, on_the_run, valid_from, tx_from,
                             provenance_id)
     VALUES ($1,'note','912810UE4','30Y','2026-08-15','2026-08-15','2036-08-15','fixed',4.25,2,
             'ACT/ACT','following','SIFMA',1,100,45000000000,true,
             $2::timestamptz,$2::timestamptz,$3)`,
    [note.instrumentId, VALID_FROM, await provenanceFor('treasury.yieldcurve')],
  );

  const curveProv = await provenanceFor('treasury.bills');
  await t.client.query(
    `INSERT INTO curves (curve_id, name, currency, kind, day_count, compounding, source_id)
     VALUES ('UST_BILL','US Treasury bills','USD','bill','ACT/360','simple','treasury.bills'),
            ('UST_PAR','US Treasury par yields','USD','par','ACT/ACT','semiannual',
             'treasury.yieldcurve')
     ON CONFLICT (curve_id) DO NOTHING`,
  );
  await t.client.query(
    `INSERT INTO curve_points (curve_id, curve_date, tenor, quote_type, vintage_at, tenor_days,
                               value, instrument_id, maturity_date, provenance_id)
     VALUES ('UST_BILL','2026-09-14','4W','discount_rate',$1::timestamptz,28,3.69,$2,'2026-09-29',$3),
            ('UST_BILL','2026-09-14','8W','discount_rate',$1::timestamptz,56,3.72,NULL,NULL,$3),
            ('UST_BILL','2026-09-14','4W','investment_yield',$1::timestamptz,28,3.75,$2,'2026-09-29',$3)`,
    ['2026-09-14T22:00:00Z', bill.instrumentId, curveProv],
  );
  await t.client.query(
    `INSERT INTO curve_points (curve_id, curve_date, tenor, quote_type, vintage_at, tenor_days,
                               value, provenance_id)
     VALUES ('UST_PAR','2026-09-14','5Y','par_yield',$1::timestamptz,1826,3.95,$2),
            ('UST_PAR','2026-09-14','10Y','par_yield',$1::timestamptz,3653,4.15,$2),
            ('UST_PAR','2026-09-14','20Y','par_yield',$1::timestamptz,7305,4.45,$2)`,
    ['2026-09-14T22:00:00Z', await provenanceFor('treasury.yieldcurve')],
  );

  // ── option: one AAPL call ─────────────────────────────────────────────────────────────────
  const option = await seedSecurity({
    key: 'OPT',
    ticker: 'AAPL260916C00245000',
    name: 'AAPL 9/16/26 C245',
    assetClass: 'option',
    marketSector: 'Equity',
    exchCode: 'US',
    securityType: 'Equity Option',
    line: { sourceId: 'cboe.options', providerSymbol: 'AAPL260916C00245000' },
  });
  await t.client.query(
    `INSERT INTO option_terms (instrument_id, occ_symbol, root, underlying_instrument_id, expiry,
                               strike, put_call, exercise_style, settlement, am_pm_settlement,
                               multiplier, is_weekly, last_trade_date, valid_from, tx_from,
                               provenance_id)
     VALUES ($1,'AAPL260916C00245000','AAPL',$2,'2026-09-16',245,'C','american','physical','pm',
             100,false,'2026-09-16',$3::timestamptz,$3::timestamptz,$4)`,
    [option.instrumentId, aapl.instrumentId, VALID_FROM, await provenanceFor('cboe.options')],
  );

  // ── crypto: BTC ───────────────────────────────────────────────────────────────────────────
  const btcQuote = (await readNormalised<CoingeckoFixture>('coingecko-simple')).quotes.find(
    (q) => q.id === 'bitcoin',
  )!;
  env.btcQuote = btcQuote;
  const btc = await seedSecurity({
    key: 'BTC',
    ticker: 'BTC',
    name: 'Bitcoin',
    assetClass: 'crypto',
    marketSector: 'Crypto',
    exchCode: 'CRYPTO',
    securityType: 'Spot',
    line: { sourceId: 'coingecko.simple', providerSymbol: 'bitcoin', delayMin: 0 },
  });

  // ── rate: SOFR ────────────────────────────────────────────────────────────────────────────
  const sofr = await seedSecurity({
    key: 'SOFR',
    ticker: 'SOFR',
    name: 'Secured Overnight Financing Rate',
    assetClass: 'rate',
    marketSector: 'Index',
    exchCode: 'RATE',
    securityType: 'Rate',
    priceDecimals: 4,
    line: { sourceId: 'nyfed.rates', providerSymbol: 'SOFR', delayMin: 0 },
  });
  await t.client.query(
    `INSERT INTO rate_terms (instrument_id, rate_code, publisher, day_count, publication_time_et,
                             tenor_days, compounding, valid_from, tx_from, provenance_id)
     VALUES ($1,'SOFR','Federal Reserve Bank of New York','ACT/360','08:00',1,'simple',
             $2::timestamptz,$2::timestamptz,$3)`,
    [sofr.instrumentId, VALID_FROM, await provenanceFor('nyfed.rates')],
  );
  const fixingProv = await provenanceFor('nyfed.rates');
  const fixingDates = ['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14'];
  await t.client.query(
    `INSERT INTO rate_fixings (rate_code, effective_date, vintage_at, rate, pct_1, pct_25, pct_75,
                               pct_99, volume_bn, is_latest, provenance_id)
     VALUES ${fixingDates
       .map(
         (d, i) =>
           `('SOFR','${d}','${d}T12:00:00Z',${(4.3 + i * 0.01).toFixed(2)},4.25,4.28,4.33,4.40,${String(
             2400 + i,
           )},true,$1)`,
       )
       .join(',')}`,
    [fixingProv],
  );
  await t.client.query(
    `INSERT INTO rate_fixings (rate_code, effective_date, vintage_at, avg_30d, avg_90d, avg_180d,
                               index_value, is_latest, provenance_id)
     VALUES ('SOFRAI','2026-09-14','2026-09-14T12:00:00Z',4.31,4.29,4.27,1.1345678900,true,$1)`,
    [fixingProv],
  );

  // ── econ: the BLS CPI-U series ────────────────────────────────────────────────────────────
  const cpi = await seedSecurity({
    key: 'CPI',
    ticker: 'CUUR0000SA0',
    name: 'CPI-U All items, NSA',
    assetClass: 'econ',
    marketSector: 'Index',
    exchCode: 'ECON',
    securityType: 'Economic series',
    priceDecimals: 3,
  });
  const release = await t.client.query<{ release_id: string }>(
    `INSERT INTO econ_releases (source_id, provider_release_id, name, country, url, importance)
     VALUES ('bls.timeseries','CPI','Consumer Price Index','US','https://www.bls.gov/cpi/',1)
     RETURNING release_id`,
  );
  env.releaseId = Number(release.rows[0]!.release_id);
  const series = await t.client.query<{ series_id: string }>(
    `INSERT INTO econ_series (series_code, source_id, provider_code, name, units, frequency,
                              seasonal_adj, country, release_id, instrument_id, decimals,
                              first_obs_date, last_obs_date)
     VALUES ('CUUR0000SA0','bls.timeseries','CUUR0000SA0','CPI-U All items, NSA','Index 1982-84=100',
             'M','NSA','US',$1,$2,3,'2024-01-01','2026-08-01')
     RETURNING series_id`,
    [env.releaseId, cpi.instrumentId],
  );
  env.seriesId = Number(series.rows[0]!.series_id);
  const obsProv = await provenanceFor('bls.timeseries');
  const months: string[] = [];
  for (let i = 25; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(2026, 7 - i, 1));
    months.push(d.toISOString().slice(0, 10));
  }
  await t.client.query(
    `INSERT INTO econ_observations (series_id, obs_date, vintage_at, value, status, is_latest,
                                    provenance_id)
     VALUES ${months
       .map((m, i) => `($1,'${m}','${m}T13:30:00Z',${(315 + i * 0.4).toFixed(3)},'final',true,$2)`)
       .join(',')}`,
    [env.seriesId, obsProv],
  );
  await t.client.query(
    `INSERT INTO econ_release_events (release_id, scheduled_at, time_known, period_label,
                                      series_id, status, provenance_id)
     VALUES ($1,'2026-10-13T12:30:00Z',true,'September 2026',$2,'scheduled',$3)`,
    [env.releaseId, env.seriesId, obsProv],
  );

  // ── the plant ─────────────────────────────────────────────────────────────────────────────
  const cboeProv = await provenanceFor('cboe.quotes');
  harness.deps.plant.apply(
    update({
      instrumentId: aapl.instrumentId,
      mdLineId: aapl.mdLineId!,
      sourceId: 'cboe.quotes',
      provenanceId: cboeProv,
      assetClass: 'equity',
      fields: {
        PX_LAST: 330.27,
        CHG_NET_1D: -2.81,
        CHG_PCT_1D: -0.84,
        PX_OPEN: 330.24,
        PX_HIGH: 331.59,
        PX_LOW: 328.35,
        PX_CLOSE_1D: 333.08,
        PX_VOLUME: 16_591_786,
        PX_BID: 330.25,
        PX_ASK: 330.28,
        BID_SIZE: 40,
        ASK_SIZE: 120,
        IVOL_30D: 24.43,
      },
    }),
  );
  harness.deps.plant.apply(
    update({
      instrumentId: spy.instrumentId,
      mdLineId: spy.mdLineId!,
      sourceId: 'cboe.quotes',
      provenanceId: cboeProv,
      assetClass: 'etf',
      fields: { PX_LAST: 601.4, CHG_NET_1D: -1.2, CHG_PCT_1D: -0.2, PX_CLOSE_1D: 602.6 },
    }),
  );
  harness.deps.plant.apply(
    update({
      instrumentId: spx.instrumentId,
      mdLineId: spx.mdLineId!,
      sourceId: 'cboe.quotes',
      provenanceId: cboeProv,
      assetClass: 'index',
      fields: {
        PX_LAST: 6014.2,
        CHG_NET_1D: -12.4,
        CHG_PCT_1D: -0.21,
        PX_OPEN: 6026.1,
        PX_HIGH: 6031.8,
        PX_LOW: 6009.4,
        PX_CLOSE_1D: 6026.6,
        IVOL_30D: 15.12,
      },
    }),
  );
  harness.deps.plant.apply(
    update({
      instrumentId: eur.instrumentId,
      mdLineId: eur.mdLineId!,
      sourceId: 'yahoo.chart',
      provenanceId: await provenanceFor('yahoo.chart'),
      assetClass: 'fx',
      fields: {
        PX_LAST: 1.1539,
        CHG_NET_1D: 0.0012,
        CHG_PCT_1D: 0.1,
        PX_OPEN: 1.1527,
        PX_HIGH: 1.1544,
        PX_LOW: 1.1521,
        PX_CLOSE_1D: 1.1527,
      },
    }),
  );
  harness.deps.plant.apply(
    update({
      instrumentId: option.instrumentId,
      mdLineId: option.mdLineId!,
      sourceId: 'cboe.options',
      provenanceId: await provenanceFor('cboe.options'),
      assetClass: 'option',
      fields: {
        PX_BID: 92.1,
        PX_ASK: 92.6,
        PX_LAST: 92.35,
        PX_VOLUME: 412,
        OPT_OI: 5_120,
        PX_CLOSE_1D: 94.8,
        CHG_NET_1D: -2.45,
        CHG_PCT_1D: -2.58,
        OPT_IV: 28.4,
        OPT_DELTA: 0.92,
        OPT_GAMMA: 0.0021,
        OPT_VEGA: 0.11,
        OPT_THETA: -0.08,
        OPT_RHO: 0.04,
      },
    }),
  );
  harness.deps.plant.apply(
    update({
      instrumentId: btc.instrumentId,
      mdLineId: btc.mdLineId!,
      sourceId: 'coingecko.simple',
      provenanceId: await provenanceFor('coingecko.simple'),
      assetClass: 'crypto',
      // From the recorded capture FUNCTIONS_TIER1 §0.7 names behind this variant, not retyped: the
      // golden used to ship px 108412.5 and a +1.37 % 24-hour change under a payload naming
      // `coingecko.simple` as its source, while `coingecko-simple.json` says 75828 and −4.22 %. A
      // golden that does not descend from its capture proves self-consistency and nothing about
      // provider → payload fidelity.
      //
      // The plant derives `CHG_NET_1D`/`CHG_PCT_1D` from the composite (BUS-05), so the prior
      // close is what makes the 24-hour change a number rather than a gap — and it is the
      // *implied* one the normaliser computes from the published rolling change, not a second
      // opinion about it.
      fields: { PX_LAST: btcQuote.usd, PX_CLOSE_1D: btcQuote.impliedPrevClose },
    }),
  );
  harness.deps.plant.apply(
    update({
      instrumentId: sofr.instrumentId,
      mdLineId: sofr.mdLineId!,
      sourceId: 'nyfed.rates',
      provenanceId: fixingProv,
      assetClass: 'rate',
      fields: { RATE: 4.33, RATE_P1: 4.25, RATE_P25: 4.28, RATE_P75: 4.33, RATE_P99: 4.4 },
    }),
  );

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  env.knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();
});

afterEach(async () => {
  await env.harness.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Running, and the two payload properties
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Meta {
  provenance: { idx: number; sourceId: string; provenanceId: number }[];
  unavailable: { field: string; reason: string; detail: string }[];
  entitlement: { fieldId: string; decision: string; reason: string }[];
  engines: { name: string; version: string; inputsHash: string }[];
}

async function runDes(
  key: string,
  params: Record<string, unknown> = {},
): Promise<{ data: DesPayload; meta: Meta }> {
  const seeded = env.by.get(key);
  if (seeded === undefined) throw new Error(`DES test: nothing seeded under '${key}'`);
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/DES/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params,
      security: { id: seeded.instrumentId },
      asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<{ data: DesPayload; meta: Meta }>();
}

interface CellLike {
  v: unknown;
  st: string;
  r?: string;
  provIdx: number;
}

function isCell(node: unknown): node is CellLike {
  return (
    typeof node === 'object' &&
    node !== null &&
    'v' in node &&
    'st' in node &&
    'provIdx' in node &&
    typeof (node as { provIdx: unknown }).provIdx === 'number'
  );
}

/**
 * DATA-10 and §1.3 rule 6 over the whole payload.
 *
 * Returns the violations rather than asserting, so a failure names every offending path at once
 * instead of the first one — a resolver with three uncited numbers should be fixed in one pass.
 */
function payloadViolations(data: unknown, meta: Meta): string[] {
  const problems: string[] = [];
  const indexes = new Set(meta.provenance.map((row) => row.idx));
  const explained =
    meta.unavailable.length > 0 || meta.entitlement.some((e) => e.decision === 'deny');

  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        walk(item, `${path}[${String(i)}]`);
      });
      return;
    }
    if (isCell(node)) {
      if (typeof node.v === 'number' && Number.isFinite(node.v)) {
        if (!indexes.has(node.provIdx)) {
          problems.push(
            `${path}: ${String(node.v)} cites provIdx ${String(node.provIdx)}, which is not in meta.provenance`,
          );
        }
      } else if (node.v === null) {
        if (node.r === undefined && !explained) {
          problems.push(`${path}: null with no reason code and nothing in meta to explain it`);
        }
        // `st` is the *subject's* state, not the value's (§0.4 rule 1: `cellFromState` copies
        // `state.state` onto every field of the composite), so a live subject that carries no
        // `LAST_TRADE_TIME` yields a `live` cell holding `null`. The claim that is checkable — and
        // the one §1.3 rule 6 makes — is that the gap is explained, which is asserted above.
      }
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // A block-level citation is either a real index or the documented "no provenance yet".
      if (key === 'provIdx' && typeof value === 'number') {
        if (value !== -1 && !indexes.has(value)) {
          problems.push(`${path}.provIdx: ${String(value)} is not in meta.provenance`);
        }
        continue;
      }
      walk(value, path === '' ? key : `${path}.${key}`);
    }
  };
  walk(data, '');
  return problems;
}

/**
 * The ids a run hands out are sequence values; the golden compares what is stable.
 *
 * The substitution is **keyed**, not textual. A blind pass over every number would rewrite
 * `constituentCount: 500` the day a sequence handed out 500, and a blind pass over every string
 * would rewrite `ACT/360` the same way — both of which happened before this was tightened. Only
 * the keys that carry an id are replaced, and inside a string only a plant subject is.
 */
const ID_KEYS: ReadonlySet<string> = new Set([
  'instrumentId',
  'issuerId',
  'listingId',
  'primaryListingId',
  'mdLineId',
  'mdLineIds',
  'indexInstrumentId',
  'seriesId',
  'releaseId',
  'entityId',
]);

function normalise(payload: DesPayload): unknown {
  const tokens = new Map<number, string>();
  for (const [key, seeded] of env.by) {
    tokens.set(seeded.instrumentId, `<${key}>`);
    if (seeded.listingId !== null) tokens.set(seeded.listingId, `<${key}_LISTING>`);
    if (seeded.mdLineId !== null) tokens.set(seeded.mdLineId, `<${key}_LINE>`);
  }
  tokens.set(env.issuerId, '<ISSUER>');
  tokens.set(env.seriesId, '<SERIES>');
  tokens.set(env.releaseId, '<RELEASE>');

  // `asOf.knownAt` is the wall-clock instant the fixture rows were written at (a bitemporal read
  // at an earlier `knownAt` sees none of them), so the econ payload's echo of it is normalised
  // like an id rather than frozen to a value no run could reproduce.
  const knownAt = new Date(env.knownAt).toISOString();
  const SUBJECT = /^([a-z0-9]+):(\d+)$/;

  const walk = (node: unknown, key: string | null): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, key));
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v, k);
      return out;
    }
    if (typeof node === 'number') {
      if (key === 'newsId') return '<NEWS>';
      if (key !== null && ID_KEYS.has(key)) return tokens.get(node) ?? node;
      return node;
    }
    if (typeof node === 'string') {
      if (node === knownAt) return '<KNOWN_AT>';
      const stripped = node.split(TAG).join('');
      const subject = SUBJECT.exec(stripped);
      if (subject !== null) {
        const token = tokens.get(Number(subject[2]));
        if (token !== undefined) return `${subject[1]!}:${token}`;
      }
      return stripped;
    }
    return node;
  };

  return walk(JSON.parse(JSON.stringify(payload)), null);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

const VARIANTS: { key: string; assetClass: string; variant: string }[] = [
  { key: 'AAPL', assetClass: 'equity', variant: 'equity' },
  { key: 'SPY', assetClass: 'etf', variant: 'equity' },
  { key: 'SPX', assetClass: 'index', variant: 'index' },
  { key: 'EURUSD', assetClass: 'fx', variant: 'fx' },
  { key: 'BILL', assetClass: 'govt', variant: 'govt' },
  { key: 'OPT', assetClass: 'option', variant: 'option' },
  { key: 'BTC', assetClass: 'crypto', variant: 'crypto' },
  { key: 'SOFR', assetClass: 'rate', variant: 'rate' },
  { key: 'CPI', assetClass: 'econ', variant: 'econ' },
];

describe('DES — eight variants, one code (FUNC-02)', () => {
  it('resolves every asset class to the variant the manifest maps it to', async () => {
    for (const { key, assetClass, variant } of VARIANTS) {
      const { data } = await runDes(key);
      expect(data.variant, key).toBe(variant);
      // The runner asserts this too (step 7); asserting it here says which class broke.
      expect(DES.variants[assetClass as keyof typeof DES.variants], key).toBe(variant);
      expect(data.instrument.assetClass, key).toBe(assetClass);
    }
  });

  it('carries a provenance index on every displayed value and a reason on every gap', async () => {
    for (const { key } of VARIANTS) {
      const { data, meta } = await runDes(key);
      const problems = payloadViolations(data, meta);
      expect(problems, `${key}: ${problems.join('; ')}`).toEqual([]);
      // Every gap is one of the three documented reasons — never a free-text excuse.
      for (const note of meta.unavailable) {
        expect(['NO_SOURCE', 'NOT_LICENSED', 'NOT_APPLICABLE'], `${key} ${note.field}`).toContain(
          note.reason,
        );
        expect(note.detail.length, `${key} ${note.field}`).toBeGreaterThan(0);
      }
      // And the screen cites something: a DES payload that cited nothing would be a screen with
      // nothing to hover over.
      expect(meta.provenance.length, key).toBeGreaterThan(0);
    }
  });

  it('shows the equity screen: issuer, quote, statistics, fundamentals, filings and news', async () => {
    const { data, meta } = await runDes('AAPL');
    if (data.variant !== 'equity') throw new Error('expected the equity variant');

    expect(data.instrument.display).toBe('AAPL US Equity');
    expect(data.issuer.cik).toBe('0000320193');
    expect(data.issuer.sicCode).toBe('3571');
    expect(data.issuer.gicsSector).toBe('Information Technology');
    expect(data.issuer.formerNames[0]?.name).toBe('Apple Computer Inc');
    expect(data.calendar).toEqual({ calendarId: 'XNAS', tz: 'America/New_York' });

    // Live cells, each registered against the plant subject the screen subscribes to.
    expect(data.quote.px.v).toBe(330.27);
    expect(data.quote.px.st).toBe('live');
    expect(data.quote.px.live?.subject).toBe(`q:${String(env.by.get('AAPL')!.instrumentId)}`);
    // A field no source published is `na`, not a zero.
    expect(data.quote.lastTradeTime.v).toBeNull();

    // §0.6 statistics over the seeded sessions, on the venue's calendar.
    expect(data.stats.barsAsOf).toBe(BAR_DATES[BAR_DATES.length - 1]);
    expect(data.stats.ret1d.v).not.toBeNull();
    expect(data.stats.high52w.v).not.toBeNull();
    // Sixty sessions is below §0.6's 200-session floor, so beta is absent with its reason.
    expect(data.stats.beta1y.v).toBeNull();
    expect(meta.unavailable.map((u) => u.field)).toContain('BETA_1Y');
    expect(meta.engines.some((e) => e.name === 'stats')).toBe(true);

    // Point-in-time fundamentals (STOR-06) and the derived cells that follow the live price.
    expect(data.fundamentals.sharesOut.v).toBe(14_900_000_000);
    expect(data.fundamentals.statementsAsOf?.accessionNo).toBe('0000320193-26-000055');
    expect(data.fundamentals.revenueTtm.v).toBe(416_000_000_000);
    expect(data.fundamentals.mktCap.v).toBeCloseTo(330.27 * 14_900_000_000, 0);
    expect(data.fundamentals.peTtm.v).toBeCloseTo(330.27 / 6.55, 6);
    expect(data.fundamentals.dvdSh12m.v).toBeCloseTo(0.53, 10);
    expect(data.fundamentals.dvdYield.v).toBeCloseTo((0.53 / 330.27) * 100, 10);
    expect(data.fundamentals.lastDividend?.exDate).toBe('2026-05-08');
    expect(data.fundamentals.shortInterest?.shortQty).toBe(101_000_000);
    // BRIEF §2: no consensus source, so the next report date is projected from filing cadence
    // and labelled as such — never presented as an estimate.
    expect(data.fundamentals.nextEarnings?.method).toBe('cadence');
    expect(data.fundamentals.nextEarnings?.estimated).toBe(true);

    expect(data.filings).toHaveLength(5);
    expect(data.filings[0]!.form).toBe('8-K');
    expect(data.filings[0]!.items).toEqual(['2.02', '9.01']);
    expect(data.filings[0]!.url).toContain('sec.gov');

    expect(data.membership).toHaveLength(1);
    expect(data.membership[0]!.indexCode).toBe('SPX');
    expect(data.membership[0]!.weight).toBeCloseTo(0.0712, 10);

    // Link-out only: NEWS-02 links at or above 0.9, bodies are never stored.
    expect(data.news).toHaveLength(1);
    expect(data.news[0]!.machineGenerated).toBe(false);
    expect(data.news[0]!.links[0]!.confidence).toBeGreaterThanOrEqual(0.9);

    expect(data.identifiers.map((i) => i.scheme).sort()).toEqual(['CUSIP', 'FIGI', 'ISIN']);
    expect(data.listings[0]!.mic).toBe('XNAS');
    expect(data.listings[0]!.mdLines[0]!.sourceId).toBe('cboe.quotes');
    expect(data.fund).toBeNull();
  });

  it('gives an ETF the equity variant with its fund block and tracked index', async () => {
    const { data } = await runDes('SPY');
    if (data.variant !== 'equity') throw new Error('expected the equity variant for an ETF');
    expect(data.fund).not.toBeNull();
    expect(data.fund!.fundType).toBe('etf');
    expect(data.fund!.sponsor).toBe('State Street Global Advisors');
    expect(data.fund!.trackedIndex?.key).toBe('SPX Index');
    expect(data.fund!.holdingsAsOf).toBe('2026-08-31');
    expect(data.fund!.holdingsCount).toBe(1);
  });

  it('shows the index screen: methodology, constituents and the proxy fund', async () => {
    const { data } = await runDes('SPX');
    if (data.variant !== 'index') throw new Error('expected the index variant');

    expect(data.instrument.display).toBe('SPX Index');
    expect(data.terms.provider).toBe('S&P Dow Jones');
    expect(data.terms.methodology).toBe('float_cap_weighted');
    expect(data.terms.membershipSourceId).toBe('ssga.holdings');
    expect(data.terms.proxyFund?.key).toBe('SPY US Equity');
    expect(data.quote.px.v).toBe(6014.2);

    expect(data.membership).not.toBeNull();
    expect(data.membership!.count).toBe(1);
    expect(data.membership!.top10[0]!.key).toBe('AAPL US Equity');
    expect(data.membership!.sectorWeights).toEqual([
      { sector: 'Information Technology', weight: expect.closeTo(0.0712, 10) as number, count: 1 },
    ]);
    expect(data.related.map((r) => r.key)).toEqual(['SPY US Equity', 'VIX Index']);
  });

  it('shows the fx screen: conventions, the inverse and the ECB reference cross', async () => {
    const { data } = await runDes('EURUSD');
    if (data.variant !== 'fx') throw new Error('expected the fx variant');

    expect(data.instrument.display).toBe('EURUSD Curncy');
    expect(data.terms.baseCcy).toBe('EUR');
    expect(data.terms.quoteCcy).toBe('USD');
    expect(data.terms.pipSize).toBeCloseTo(0.0001, 10);
    expect(data.calendar.calendarId).toBe('FX_USD');
    expect(data.quote.px.v).toBe(1.1539);
    expect(data.inverse.v).toBeCloseTo(1 / 1.1539, 10);

    // EUR is quoted 0.86663 per USD, so the ECB cross for EURUSD is 1 / 0.86663.
    expect(data.ecb).not.toBeNull();
    expect(data.ecb!.rateDate).toBe('2026-09-14');
    expect(data.ecb!.baseCcyPerUsd).toBeCloseTo(0.86663, 10);
    expect(data.ecb!.quoteCcyPerUsd).toBe(1);
    expect(data.ecb!.crossRate).toBeCloseTo(1 / 0.86663, 6);
  });

  it('prices a Treasury bill off the bill curve, with the bill engine recorded (ANAL-01/08)', async () => {
    const { data, meta } = await runDes('BILL');
    if (data.variant !== 'govt') throw new Error('expected the govt variant');

    expect(data.instrument.display).toBe('912797VE4 Govt');
    expect(data.terms.securityType).toBe('bill');
    expect(data.terms.maturityDate).toBe('2026-09-29');
    expect(data.terms.calendarId).toBe('SIFMA');
    expect(data.calendar).toEqual({ calendarId: 'SIFMA', tz: 'America/New_York' });

    const pricing = data.pricing!;
    // Settlement is T+1 on SIFMA: 2026-09-15 is a Tuesday, so 2026-09-16.
    expect(pricing.settlementDate).toBe('2026-09-16');
    expect(pricing.daysToMaturity).toBe(13);
    // The curve carries a discount rate for this very instrument, so nothing is interpolated.
    expect(pricing.yieldSource).toBe('bill_quote');
    expect(pricing.curveId).toBe('UST_BILL');
    expect(pricing.curveDate).toBe('2026-09-14');
    // P = 100 × (1 − d × t/360), the ACT/360 bank-discount convention.
    expect(pricing.discountRate.v).toBeCloseTo(3.69, 10);
    expect(pricing.price.v).toBeCloseTo(100 * (1 - (3.69 / 100) * (13 / 360)), 8);
    expect(pricing.accrued.v).toBe(0);
    expect(pricing.dirtyPrice.v).toBe(pricing.price.v);
    expect(pricing.dv01.v).not.toBeNull();
    expect(meta.engines.some((e) => e.name === 'bill' && e.version === '1.0.0')).toBe(true);
  });

  it('prices a Treasury note off the par curve, with both bond engines recorded', async () => {
    const { data, meta } = await runDes('NOTE');
    if (data.variant !== 'govt') throw new Error('expected the govt variant');

    expect(data.terms.securityType).toBe('note');
    expect(data.terms.couponRate).toBeCloseTo(4.25, 10);
    const pricing = data.pricing!;
    expect(pricing.yieldSource).toBe('par_interp');
    expect(pricing.curveId).toBe('UST_PAR');
    // Ten years to maturity sits between the 5Y and 20Y nodes of the seeded curve.
    expect(pricing.yield.v as number).toBeGreaterThan(3.95);
    expect(pricing.yield.v as number).toBeLessThan(4.45);
    expect(pricing.price.v).not.toBeNull();
    expect(pricing.accrued.v as number).toBeGreaterThan(0);
    expect(pricing.dirtyPrice.v).toBeCloseTo(
      (pricing.price.v as number) + (pricing.accrued.v as number),
      8,
    );
    expect(meta.engines.some((e) => e.name === 'bond.price')).toBe(true);
    expect(meta.engines.some((e) => e.name === 'bond.risk')).toBe(true);
    // A bank-discount rate is a bill quote; on a note it is absent with its reason.
    expect(pricing.discountRate.v).toBeNull();
    expect(meta.unavailable.map((u) => u.field)).toContain('pricing.discountRate');
  });

  it('shows the option screen: terms, published greeks and derived moneyness', async () => {
    const { data, meta } = await runDes('OPT');
    if (data.variant !== 'option') throw new Error('expected the option variant');

    expect(data.terms.occSymbol).toBe('AAPL260916C00245000');
    expect(data.terms.strike).toBeCloseTo(245, 10);
    expect(data.terms.putCall).toBe('C');
    expect(data.terms.underlying.key).toBe('AAPL US Equity');
    expect(data.terms.daysToExpiry).toBe(1);

    expect(data.quote.bid.v).toBe(92.1);
    expect(data.quote.delta.v).toBeCloseTo(0.92, 10);
    expect(data.underlying.px.v).toBe(330.27);

    // Derived from the underlying and the two-sided quote, citing the underlying's row.
    expect(data.moneyness.intrinsic.v).toBeCloseTo(330.27 - 245, 8);
    expect(data.moneyness.timeValue.v).toBeCloseTo((92.1 + 92.6) / 2 - (330.27 - 245), 8);
    expect(data.moneyness.pctFromSpot.v).toBeCloseTo((245 / 330.27 - 1) * 100, 8);

    // No chain summary subject is polled in this fixture, and the gap is stated.
    expect(data.chain).toBeNull();
    expect(meta.unavailable.find((u) => u.field === 'chain')?.detail).toBe(
      'no chain summary for underlying',
    );
  });

  it('shows the crypto screen with its context-only caveat', async () => {
    const { data } = await runDes('BTC');
    if (data.variant !== 'crypto') throw new Error('expected the crypto variant');

    expect(data.instrument.display).toBe('BTC Crypto');
    // The provider symbol carries this run's tag (see the header); the golden strips it again.
    expect(data.coingeckoId).toBe(`bitcoin${TAG}`);
    expect(data.px.v).toBe(env.btcQuote.usd);
    // The plant publishes the derived change rounded to the field's own decimals.
    // The plant publishes the change at the field's own precision, so the comparison is at that
    // precision and not at the capture's sixteen digits.
    expect(data.chg24hPct.v).toBeCloseTo(env.btcQuote.change24hPct, 3);
    expect(data.source).toBe('coingecko.simple');
    expect(data.caveat).toBe('CONTEXT_ONLY_NOT_EXCHANGE_DATA');
    expect(data.asOf).toBe(new Date(GOLDEN_CAPTURE_MS - 60_000).toISOString());
  });

  it('shows the rate screen: the latest fixing, its percentiles, SOFR averages and 30 days', async () => {
    const { data, meta } = await runDes('SOFR');
    if (data.variant !== 'rate') throw new Error('expected the rate variant');

    expect(data.instrument.display).toBe('SOFR Index');
    expect(data.terms.rateCode).toBe('SOFR');
    expect(data.terms.publisher).toBe('Federal Reserve Bank of New York');
    expect(data.description).toContain('Secured Overnight Financing Rate');

    expect(data.latest!.effectiveDate).toBe('2026-09-14');
    expect(data.latest!.rate.v).toBeCloseTo(4.33, 10);
    expect(data.latest!.rate.live?.field).toBe('RATE');
    expect(data.latest!.pct99.v).toBeCloseTo(4.4, 10);
    // The FOMC target range is published against EFFR only.
    expect(data.latest!.targetFrom.v).toBeNull();
    expect(meta.unavailable.map((u) => u.field)).toContain('latest.target');

    expect(data.averages).not.toBeNull();
    expect(data.averages!.avg30d).toBeCloseTo(4.31, 10);
    expect(data.averages!.indexValue).toBeCloseTo(1.13456789, 10);

    expect(data.history).toHaveLength(4);
    expect(data.history[0]!.effectiveDate).toBe('2026-09-09');
    expect(data.history[3]!.effectiveDate).toBe('2026-09-14');
  });

  it('shows the econ screen: the point-in-time observation, the change and the next release', async () => {
    const { data } = await runDes('CPI');
    if (data.variant !== 'econ') throw new Error('expected the econ variant');

    expect(data.instrument.display).toBe('CUUR0000SA0 Index');
    expect(data.series.code).toBe('CUUR0000SA0');
    expect(data.series.frequency).toBe('M');
    expect(data.series.releaseName).toBe('Consumer Price Index');
    expect(data.knownAt).toBe(new Date(env.knownAt).toISOString());

    expect(data.latest!.obsDate).toBe('2026-08-01');
    expect(data.latest!.status).toBe('final');
    expect(data.prior!.obsDate).toBe('2026-07-01');
    expect(data.change!.abs).toBeCloseTo(0.4, 6);
    expect(data.change!.pct).toBeCloseTo((0.4 / data.prior!.value!) * 100, 6);

    expect(data.nextRelease).toEqual({
      scheduledAt: '2026-10-13T12:30:00.000Z',
      timeKnown: true,
      periodLabel: 'September 2026',
      releaseId: env.releaseId,
    });
    expect(data.history).toHaveLength(24);
    expect(data.history[data.history.length - 1]!.obsDate).toBe('2026-07-01');
  });

  it('declares the live spec each variant subscribes to', async () => {
    const params = DES.params.parse({});
    for (const { key } of VARIANTS) {
      const { data } = await runDes(key);
      const live = DES.live!(params, data);
      const id = String(env.by.get(key)!.instrumentId);
      if (data.variant === 'govt') {
        expect(live, key).toBeNull();
        continue;
      }
      expect(live, key).not.toBeNull();
      if (data.variant === 'econ') {
        expect(live!.subjects).toEqual([`e:${data.series.code}`]);
        expect(live!.fields).toBe('*');
        continue;
      }
      expect(live!.subjects[0], key).toBe(`q:${id}`);
      if (data.variant === 'option') {
        const underlying = String(env.by.get('AAPL')!.instrumentId);
        expect(live!.subjects).toEqual([`q:${id}`, `q:${underlying}`, `oc:${underlying}`]);
        expect(live!.essential).toEqual([`q:${id}`, `q:${underlying}`]);
      }
    }
  });

  it('ignores the tab parameter: every block is in the payload regardless (FUNC-04)', async () => {
    const profile = await runDes('AAPL', { tab: 'profile' });
    const filings = await runDes('AAPL', { tab: 'filings' });
    expect(normalise(filings.data)).toEqual(normalise(profile.data));
  });

  it('honours filingsLimit and newsLimit', async () => {
    const { data } = await runDes('AAPL', { filingsLimit: 3, newsLimit: 3 });
    if (data.variant !== 'equity') throw new Error('expected the equity variant');
    expect(data.filings).toHaveLength(3);
  });

  it('deep-equals the committed golden for each of the eight variants', async () => {
    for (const { key, variant } of VARIANTS) {
      if (key === 'SPY') continue; // the etf shares the equity variant and is asserted inline
      const { data } = await runDes(key);
      expectGolden(`DES.${variant}.json`, normalise(data));
    }
  });
});
