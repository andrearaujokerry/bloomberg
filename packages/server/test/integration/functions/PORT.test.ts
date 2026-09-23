/**
 * `test/integration/functions/PORT.test.ts` — WP-10's acceptance rows for `PORT`
 * (WORKPLAN §WP-10: PORT-01/02 import and reconciliation, PORT-03..06 attribution, VaR and
 * tracking error, PORT-07 "another firm's user gets 404, not 403-with-data").
 *
 * The fixture is a seven-line book built through the **real** import path
 * (`portfolio/service.ts#importPositions`), not by inserting `positions` rows, because the claims
 * under test are about what an import produces: a provenance row every quantity cites, a
 * reconciliation report, lot-level cost, a `data_exceptions` row for the identifier that did not
 * resolve, and `status: 'partial'` — accepted work plus a named failure.
 *
 * Seven lines, each one a case the resolver has to get right:
 *
 *  | line        | what it proves                                                             |
 *  | ----------- | -------------------------------------------------------------------------- |
 *  | the equity  | priced from the **plant** (a live composite), day P&L from `CHG_NET_1D`      |
 *  | a second    | priced from the last stored **daily close** — a different source, cited      |
 *  | a EUR name  | multi-currency: `fxRate` from `fx_rates`, market value in the base currency  |
 *  | a govt line | fixed income lands in `attribution.unattributed`, never in a sector          |
 *  | a stale name| no quote and no recent close → `price_missing`, and `pricedWeight` drops     |
 *  | cash        | valued at quantity × FX, and weighted against the same gross as every row    |
 *  | a bad id    | `unresolved`, one `errors[]` entry, `UNRESOLVED_IDENTIFIER` in `meta`        |
 *
 * WP-15 owns the seed, so every firm, user, grant, instrument, bar and position is created here
 * inside this file's own transaction and nothing depends on a literal instrument id.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden, idToken, subjectToken } from './golden.js';

import { FunctionRegistry } from '@terminal/core';
import type { AssetClass, MarketSector, NormalisedUpdate } from '@terminal/core';
import { PORT } from '@terminal/core/functions/manifests/PORT';
import type { PortPayload } from '@terminal/core/functions/manifests/PORT';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as PORTModule from '../../../src/functions/PORT/resolve.js';
import { importPositions, parseImportCsv } from '../../../src/portfolio/service.js';
import { masterRepositories } from '../../../src/refdata/master.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
/** The positions' as-of date, and the last session of every bar series. */
const AS_OF_DATE = '2026-09-15';
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = new Date('2020-01-01T00:00:00Z');

/** Sessions of daily history behind every priced name. */
const SESSIONS = 320;

const REGISTRY = new FunctionRegistry([PORT]);
const MODULES: Record<string, FunctionServerModule<never, never>> = {
  PORT: PORTModule as unknown as FunctionServerModule<never, never>,
};

const t: TestDb = withTxDb();

interface Seeded {
  instrumentId: number;
  mdLineId: number;
  /** The command-line form the import file names (`'PGABCD Govt'`). */
  ref: string;
  /** The key `data/portfolio.ts#toSummary` builds, which is what the payload carries. */
  key: string;
  ticker: string;
}

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  cookie: string;
  knownAt: string;
  tag: string;
  firmId: number;
  portfolioId: number;
  importId: number;
  otherPortfolioId: number;
  alpha: Seeded;
  beta: Seeded;
  euro: Seeded;
  govt: Seeded;
  stale: Seeded;
  extra: Seeded;
  index: Seeded;
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

/**
 * One instrument with its issuer, issue, primary listing and md line — the `ws/helpers` seeder with
 * the two columns this fixture varies: the quote currency (for the multi-currency case) and the
 * market sector (so a `govt` line is not labelled `Index`).
 */
async function seedInstrument(spec: {
  ticker: string;
  name: string;
  assetClass: AssetClass;
  marketSector: MarketSector;
  currency: string;
  /** `'US'`, or the synthetic code a non-listed wedge carries (`'GOVT'`). */
  exchCode?: string;
}): Promise<Seeded> {
  const repos = masterRepositories(t.db);
  const provenanceId = await bootstrapProvenance(t, 'internal.user', `port-${spec.ticker}`);
  await bootstrapProvenance(t, 'cboe.quotes', `port-src-${spec.ticker}`);
  const o = { validFrom: VALID_FROM, provenanceId };

  const issuerId = await repos.issuers.insert({ name: `${spec.name} issuer` }, o);
  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass: spec.assetClass,
      securityType: spec.assetClass === 'equity' ? 'Common Stock' : 'Index',
      name: spec.name,
      currency: spec.currency,
    },
    o,
  );
  const instrumentId = await repos.instruments.insert(
    {
      issueId,
      assetClass: spec.assetClass,
      marketSector: spec.marketSector,
      ticker: spec.ticker,
      exchCode: spec.exchCode ?? 'US',
      name: spec.name,
      currency: spec.currency,
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
  const exchCode = spec.exchCode ?? 'US';
  return {
    instrumentId,
    mdLineId,
    ticker: spec.ticker,
    // `parseSecurityRef` only consumes an exchange token before an `Equity` sector, so a `Govt`
    // line is named by its synthetic two-token form. `data/portfolio.ts#toSummary` does not strip
    // the synthetic code, so the payload's `key` keeps it — the reader's spelling, not ours.
    ref: exchCode === 'GOVT' ? `${spec.ticker} ${spec.marketSector}` : `${spec.ticker} ${exchCode} ${spec.marketSector}`,
    key: `${spec.ticker} ${exchCode} ${spec.marketSector}`,
  };
}

/** `n` week-day sessions ending on `end`, oldest first. */
function sessionsEndingAt(end: string, n: number): string[] {
  const out: string[] = [];
  const at = new Date(`${end}T00:00:00.000Z`);
  while (out.length < n) {
    const day = at.getUTCDay();
    if (day !== 0 && day !== 6) out.push(at.toISOString().slice(0, 10));
    at.setUTCDate(at.getUTCDate() - 1);
  }
  return out.reverse();
}

/**
 * A deterministic close series: one **common market factor** plus a small idiosyncratic wave.
 *
 * The common term is what makes beta meaningful — a book of independent sine waves has betas
 * scattered around zero, and an equity shock over it would produce a P&L of either sign, which
 * tests nothing. Every equity here therefore moves mostly with the index, as a real one does.
 */
function common(i: number): number {
  return 0.0004 * i + 0.03 * Math.sin(i / 12);
}

function closesFor(base: number, idioAmp: number, phase: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) =>
    Number((base * (1 + common(i) + idioAmp * Math.sin(i / 5 + phase))).toFixed(6)),
  );
}

/** A bond series: slow drift, small amplitude and no equity factor at all. */
function bondCloses(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) =>
    Number((base * (1 + 0.00002 * i + 0.004 * Math.sin(i / 17))).toFixed(6)),
  );
}

async function insertBars(
  seeded: Seeded,
  provenanceId: number,
  dates: readonly string[],
  closes: readonly number[],
): Promise<void> {
  await t.client.query(
    `INSERT INTO bars_daily (instrument_id, session_date, md_line_id, open, high, low, close,
                             volume, capture_ts, provenance_id)
     SELECT $1, d.session_date::date, $2, (d.close)::numeric, (d.close * 1.01)::numeric,
            (d.close * 0.99)::numeric, d.close::numeric, 4000000, $3::timestamptz, $4
       FROM unnest($5::text[], $6::numeric[]) AS d(session_date, close)`,
    [seeded.instrumentId, seeded.mdLineId, GOLDEN_ISO, provenanceId, [...dates], [...closes]],
  );
}

/** The live composite for the one name the plant has been polled for. */
function quote(seeded: Seeded, provenanceId: number): NormalisedUpdate {
  return {
    subject: `q:${String(seeded.instrumentId)}`,
    instrumentId: seeded.instrumentId,
    mdLineId: seeded.mdLineId,
    assetClass: 'equity',
    tier: 'delayed',
    fields: {
      PX_LAST: 245.31,
      PX_CLOSE_1D: 243.45,
      PX_BID: 245.29,
      PX_ASK: 245.33,
      PX_VOLUME: 18_204_100,
    },
    ts: { src: GOLDEN_CAPTURE_MS - 900_000, cap: GOLDEN_CAPTURE_MS, pub: 0 },
    prov: { sourceId: 'cboe.quotes', provenanceId, srcSeq: 42 },
  };
}

async function classify(instrumentId: number, code: string, provenanceId: number): Promise<void> {
  await t.client.query(
    `INSERT INTO entity_classifications
       (entity_kind, entity_id, scheme, code, valid_from, provenance_id)
     VALUES ('instrument', $1::bigint, 'GICS', $2, $3::timestamptz, $4::bigint)`,
    [instrumentId, code, VALID_FROM.toISOString(), provenanceId],
  );
}

beforeEach(async () => {
  await ensureLicences();

  // A **fixed** tag, not a random one. Every ticker this fixture mints ends up inside the
  // `portfolio/risk` engine's `inputsHash` (a risk holding is keyed by its command-line key), so a
  // random tag would move the hash on every run and the golden could never pin it. The whole
  // fixture lives inside a rolled-back transaction, so a constant ticker collides with nothing.
  const tag = 'ZQTA';

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`PORT Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'PORT User', 'user') RETURNING user_id`,
    [firmId, `port-${randomUUID()}@demo.invalid`],
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
  const alpha = await seedInstrument({
    ticker: `PA${tag}`,
    name: `Alpha ${tag} Inc`,
    assetClass: 'equity',
    marketSector: 'Equity',
    currency: 'USD',
  });
  const beta = await seedInstrument({
    ticker: `PB${tag}`,
    name: `Beta ${tag} Inc`,
    assetClass: 'equity',
    marketSector: 'Equity',
    currency: 'USD',
  });
  const euro = await seedInstrument({
    ticker: `PE${tag}`,
    name: `Euro ${tag} SA`,
    assetClass: 'equity',
    marketSector: 'Equity',
    currency: 'EUR',
  });
  const govt = await seedInstrument({
    ticker: `PG${tag}`,
    name: `Treasury ${tag}`,
    assetClass: 'govt',
    marketSector: 'Govt',
    currency: 'USD',
    exchCode: 'GOVT',
  });
  const stale = await seedInstrument({
    ticker: `PS${tag}`,
    name: `Stale ${tag} Inc`,
    assetClass: 'equity',
    marketSector: 'Equity',
    currency: 'USD',
  });
  const extra = await seedInstrument({
    ticker: `PX${tag}`,
    name: `Extra ${tag} Inc`,
    assetClass: 'equity',
    marketSector: 'Equity',
    currency: 'USD',
  });
  const index = await seedInstrument({
    ticker: `PI${tag}`,
    name: `Index ${tag}`,
    assetClass: 'index',
    marketSector: 'Index',
    currency: 'USD',
  });

  // ── GICS, from a third source (neither the import nor the quote carries a sector) ──────────
  const wikiProv = await bootstrapProvenance(t, 'wiki.sp500', 'port-gics');
  const schemePresent = await t.client.query(
    `SELECT 1 FROM classification_schemes WHERE scheme = 'GICS'`,
  );
  if (schemePresent.rowCount === 0) {
    await t.client.query(
      `INSERT INTO classification_schemes (scheme, name, source_id, levels)
       VALUES ('GICS', 'GICS', 'wiki.sp500', 4) ON CONFLICT (scheme) DO NOTHING`,
    );
  }
  await t.client.query(
    `INSERT INTO classification_codes (scheme, code, name, parent_code, level)
     VALUES ('GICS', '45', 'Information Technology', NULL, 1),
            ('GICS', '45103010', 'Information Technology — sub', '45', 4),
            ('GICS', '35', 'Health Care', NULL, 1),
            ('GICS', '35102010', 'Health Care — sub', '35', 4),
            ('GICS', '40', 'Financials', NULL, 1),
            ('GICS', '40101010', 'Financials — sub', '40', 4)
       ON CONFLICT (scheme, code) DO NOTHING`,
  );
  await classify(alpha.instrumentId, '45103010', wikiProv);
  await classify(beta.instrumentId, '45103010', wikiProv);
  await classify(euro.instrumentId, '35102010', wikiProv);
  await classify(extra.instrumentId, '40101010', wikiProv);

  // ── history ───────────────────────────────────────────────────────────────────────────────
  const barProv = await bootstrapProvenance(t, 'yahoo.chart', 'port-bars');
  const dates = sessionsEndingAt(AS_OF_DATE, SESSIONS);
  await insertBars(alpha, barProv, dates, closesFor(230, 0.008, 0, SESSIONS));
  await insertBars(beta, barProv, dates, closesFor(310, 0.01, 1, SESSIONS));
  await insertBars(euro, barProv, dates, closesFor(96, 0.012, 2, SESSIONS));
  await insertBars(govt, barProv, dates, bondCloses(99.2, SESSIONS));
  await insertBars(extra, barProv, dates, closesFor(140, 0.009, 3, SESSIONS));
  await insertBars(index, barProv, dates, closesFor(5400, 0, 0, SESSIONS));
  // The stale name's history stops ten weeks before the as-of date: no quote, no recent close.
  const staleDates = sessionsEndingAt('2026-07-01', 40);
  await insertBars(stale, barProv, staleDates, closesFor(58, 0.011, 4, 40));

  // ── the benchmark roster ──────────────────────────────────────────────────────────────────
  const rosterProv = await bootstrapProvenance(t, 'sec.archives', 'port-roster');
  const indexRow = await t.client.query<{ index_id: string }>(
    `INSERT INTO indices (code, instrument_id, proxy_fund_instrument_id, membership_source_id,
                          provider)
     VALUES ($1, $2, NULL, 'sec.archives', 'Terminal Test') RETURNING index_id`,
    [`PIX${tag}`, index.instrumentId],
  );
  const indexId = Number(indexRow.rows[0]!.index_id);
  await t.client.query(
    `INSERT INTO index_members (index_id, instrument_id, weight, shares, market_value,
                                as_of_date, source_id, valid_from, provenance_id)
     SELECT $1::bigint, v.id::bigint, v.w::numeric(12,10), 1000000::numeric(20,4),
            50000000::numeric(20,2), $2::date, 'sec.archives', $2::timestamptz, $3::bigint
       FROM jsonb_to_recordset($4::jsonb) AS v(id bigint, w text)`,
    [
      indexId,
      '2026-06-30',
      rosterProv,
      JSON.stringify([
        { id: alpha.instrumentId, w: '0.4000000000' },
        { id: beta.instrumentId, w: '0.3500000000' },
        { id: extra.instrumentId, w: '0.2500000000' },
      ]),
    ],
  );

  // ── FX ────────────────────────────────────────────────────────────────────────────────────
  const fxProv = await bootstrapProvenance(t, 'frankfurter', 'port-fx');
  await t.client.query(
    `INSERT INTO fx_rates (base_ccy, quote_ccy, rate_date, rate, source_id, provenance_id)
     VALUES ('EUR', 'USD', $1::date, 1.09250000, 'frankfurter', $2::bigint)`,
    ['2026-09-14', fxProv],
  );

  // ── the portfolio, and another firm's, and the import that fills ours ──────────────────────
  const portfolio = await t.client.query<{ portfolio_id: string }>(
    `INSERT INTO portfolios (firm_id, owner_user_id, name, base_currency, benchmark_instrument_id)
     VALUES ($1, $2, 'Demo Long', 'USD', $3) RETURNING portfolio_id`,
    [firmId, userId, index.instrumentId],
  );
  const portfolioId = Number(portfolio.rows[0]!.portfolio_id);

  const otherFirm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Other Desk ${randomUUID().slice(0, 8)}`],
  );
  const otherFirmId = Number(otherFirm.rows[0]!.firm_id);
  const otherUser = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'Other PM', 'user') RETURNING user_id`,
    [otherFirmId, `other-${randomUUID()}@demo.invalid`],
  );
  const otherPortfolio = await t.client.query<{ portfolio_id: string }>(
    `INSERT INTO portfolios (firm_id, owner_user_id, name, base_currency, benchmark_instrument_id)
     VALUES ($1, $2, 'Other Desk Book', 'USD', NULL) RETURNING portfolio_id`,
    [otherFirmId, Number(otherUser.rows[0]!.user_id)],
  );

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const csv = [
    'identifier,quantity,cost_price,cost_currency,lot_id,trade_date,is_cash,cash_currency',
    `${alpha.ref},1200,187.42,USD,L1,2024-03-11,,`,
    `${beta.ref},800,295.10,USD,L2,2024-05-02,,`,
    `${euro.ref},500,88.40,EUR,L3,2024-06-03,,`,
    `${govt.ref},2000,98.75,USD,L4,2024-07-01,,`,
    `${stale.ref},400,61.20,USD,L5,2024-08-15,,`,
    'USD,50000,,,CASH,,true,USD',
    'NOPE XX Equity,10,1.00,USD,L7,2024-01-02,,',
  ].join('\n');
  const parsed = parseImportCsv(csv);
  const report = await importPositions(
    t.db,
    { validAt: new Date(GOLDEN_ISO), knownAt: new Date(knownAt) },
    { firmId, userId },
    testClock(GOLDEN_CAPTURE_MS),
    {
      portfolioId,
      asOfDate: AS_OF_DATE,
      channel: 'upload',
      filename: 'demo-long.csv',
      rows: parsed.rows,
      parseErrors: parsed.errors,
      rowsTotal: parsed.rowsTotal,
      payload: csv,
    },
  );

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };
  const quoteProv = await bootstrapProvenance(t, 'cboe.quotes', 'port-quote');
  // Only the first name has been polled; everything else prices from its last stored close, which
  // is the whole point of the two-source price path.
  harness.deps.plant.apply(quote(alpha, quoteProv));

  env = {
    harness,
    app: harness.app,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    knownAt,
    tag,
    firmId,
    portfolioId,
    importId: report.importId,
    otherPortfolioId: Number(otherPortfolio.rows[0]!.portfolio_id),
    alpha,
    beta,
    euro,
    govt,
    stale,
    extra,
    index,
  };
});

afterEach(async () => {
  await env.harness.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Running
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface RunResult {
  data: PortPayload;
  meta: {
    resultId: string;
    provenance: { sourceId: string; provenanceId: number; attribution: string }[];
    unavailable: { field: string; reason: string; detail: string }[];
    engines: { name: string; version: string; inputsHash: string }[];
  };
}

async function runPORT(params: Record<string, unknown> = {}): Promise<RunResult> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/PORT/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<RunResult>();
}

function rowOf(data: PortPayload, seeded: Seeded): PortPayload['holdings'][number] {
  const row = data.holdings.find((h) => h.instrumentId === seeded.instrumentId);
  expect(row, `holding for ${seeded.key}`).toBeDefined();
  return row!;
}

/**
 * The one key of a PORT payload that carries a seeded instrument id: the benchmark's and each
 * holding's (§PORT). A scenario's `id` (`'UST_PARALLEL_UP_100'`) is a name, and `provIdx` is a
 * position in `meta.provenance` — neither is a sequence value.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId']);

/** Id keys the fixture does not control, recorded as present rather than by value. */
const FLAT_ID_KEYS: ReadonlySet<string> = new Set([
  'positionId',
  'portfolioId',
  'firmId',
  'importId',
]);

/** Written by the database's own touch rather than the injected clock. */
const CLOCK_KEYS: ReadonlySet<string> = new Set(['updatedAt']);

/** Sequence ids and the per-run ticker tag are both unreproducible, so both are tokenised. */
function normalise(payload: PortPayload): unknown {
  const tokens = new Map<number, string>([
    [env.alpha.instrumentId, '<ALPHA>'],
    [env.beta.instrumentId, '<BETA>'],
    [env.euro.instrumentId, '<EURO>'],
    [env.govt.instrumentId, '<GOVT>'],
    [env.stale.instrumentId, '<STALE>'],
    [env.extra.instrumentId, '<EXTRA>'],
    [env.index.instrumentId, '<INDEX>'],
  ]);
  const json = JSON.stringify(payload, (key, value: unknown) => {
    if (typeof value === 'string') {
      // `portfolios.updated_at` is set by the database's own touch, not by the injected clock, so
      // it is as unreproducible as a sequence value and is tokenised for the same reason.
      if (CLOCK_KEYS.has(key)) return `<${key.toUpperCase()}>`;
      const untagged = value.split(env.tag).join('<T>');
      return subjectToken(untagged, tokens);
    }
    if (FLAT_ID_KEYS.has(key) && typeof value === 'number') return `<${key.toUpperCase()}>`;
    // The token map used to be consulted for *every* number, with `provIdx` carved out by hand in
    // two places — the carve-out being the defect admitting itself. A book is quantities, cost
    // prices, accruals, market values, weights, DV01s and attribution effects, and every one of
    // them was a candidate. An id is now an id because of the key it sits under, so `provIdx`
    // needs no exception and neither does a quantity that happens to equal a seeded id.
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('PORT — holdings (PORT-01, PORT-02, DATA-10)', () => {
  it('prices the book from the plant and from stored closes, and says which is which', async () => {
    const { data, meta } = await runPORT();

    expect(data.variant).toBe('default');
    expect(data.view).toBe('holdings');
    expect(data.portfolio.name).toBe('Demo Long');
    expect(data.portfolio.baseCurrency).toBe('USD');
    expect(data.portfolio.asOfDate).toBe(AS_OF_DATE);
    expect(data.holdings).toHaveLength(7);

    // The polled name carries the live composite and a `live` binding for the shell.
    const alpha = rowOf(data, env.alpha);
    expect(alpha.px.v).toBe(245.31);
    expect(alpha.px.live).toEqual({ subject: `q:${String(env.alpha.instrumentId)}`, field: 'PX_LAST' });
    expect(alpha.px.provIdx).toBeGreaterThanOrEqual(0);
    expect(alpha.marketValue.v).toBeCloseTo(1200 * 245.31, 6);
    // Day P&L comes from the composite's derived CHG_NET_1D (245.31 − 243.45).
    expect(alpha.dayPnl.v).toBeCloseTo(1200 * (245.31 - 243.45), 6);
    expect(alpha.unrealisedPnl.v).toBeCloseTo(1200 * (245.31 - 187.42), 6);

    // The unpolled name prices from its last stored close, cited to the bar's own provenance row.
    const beta = rowOf(data, env.beta);
    expect(beta.px.st).toBe('closed');
    expect(beta.px.v).not.toBeNull();
    expect(beta.px.provIdx).toBeGreaterThanOrEqual(0);
    expect(beta.px.provIdx).not.toBe(alpha.px.provIdx);
    expect(beta.reconStatus).toBe('ok');

    // Every derived cell cites the provenance of its primary input (§0.4 rule 4).
    for (const row of data.holdings) {
      for (const cell of [row.marketValue, row.weight, row.dayPnl, row.unrealisedPnl]) {
        if (typeof cell.v === 'number') expect(cell.provIdx).toBeGreaterThanOrEqual(0);
      }
    }

    // Two distinct sources are cited, and both carry an attribution line (DATA-09).
    const sources = meta.provenance.map((p) => p.sourceId);
    expect(sources).toContain('internal.user');
    expect(sources).toContain('cboe.quotes');
    expect(sources).toContain('yahoo.chart');
    for (const row of meta.provenance) expect(row.attribution.length).toBeGreaterThan(0);

    expect(data.confidentiality).toEqual({
      firmOnly: true,
      note: 'PORT-07: firm-isolated; never leaves the tenant',
    });
  });

  it('values a EUR line through fx_rates and reports the rate it used', async () => {
    const { data } = await runPORT();
    const euro = rowOf(data, env.euro);
    expect(euro.currency).toBe('EUR');
    expect(euro.fxRate.v).toBeCloseTo(1.0925, 8);
    expect(euro.fxRate.provIdx).toBeGreaterThanOrEqual(0);
    expect(euro.marketValue.v).toBeCloseTo(500 * (euro.px.v as number) * 1.0925, 4);

    const alpha = rowOf(data, env.alpha);
    expect(alpha.fxRate.v).toBe(1);
  });

  it('marks a name with no quote and no recent close price_missing, and drops pricedWeight', async () => {
    const { data, meta } = await runPORT();
    const stale = rowOf(data, env.stale);
    expect(stale.reconStatus).toBe('price_missing');
    expect(stale.px.v).toBeNull();
    expect(stale.marketValue.v).toBeNull();
    expect(data.notes).toContain('PRICE_MISSING');
    expect(data.totals.pricedWeight).toBeGreaterThan(0);
    expect(data.totals.pricedWeight).toBeLessThan(1);

    const entry = meta.unavailable.find((u) => u.field === 'PX_LAST');
    expect(entry?.detail.startsWith('PRICE_MISSING')).toBe(true);
  });

  it('carries the unresolved identifier as a row, an error and a reason — never a guess', async () => {
    const { data, meta } = await runPORT();
    const bad = data.holdings.find((h) => h.rawIdentifier === 'NOPE XX Equity');
    expect(bad).toBeDefined();
    expect(bad!.instrumentId).toBeNull();
    expect(bad!.reconStatus).toBe('unresolved');
    expect(bad!.marketValue.v).toBeNull();

    expect(data.recon.status).toBe('partial');
    expect(data.recon.rowsTotal).toBe(7);
    expect(data.recon.rowsError).toBe(1);
    expect(data.recon.importId).toBe(env.importId);
    expect(data.recon.errors.map((e) => e.column)).toContain('identifier');
    expect(data.recon.added).toBe(7);

    const entry = meta.unavailable.find((u) => u.field === 'instrumentId');
    expect(entry?.detail.startsWith('UNRESOLVED_IDENTIFIER')).toBe(true);

    const exceptions = await t.client.query(
      `SELECT 1 FROM data_exceptions WHERE kind = 'unresolved_identifier'`,
    );
    expect(exceptions.rowCount).toBeGreaterThan(0);
  });

  it('values a cash line and counts it in the gross every weight is taken against', async () => {
    const { data } = await runPORT();
    const cash = data.holdings.find((h) => h.isCash)!;
    expect(cash.marketValue.v).toBe(50_000);
    expect(cash.subject).toBeNull();
    expect(data.totals.cash).toBe(50_000);

    // §PORT step 5: `grossMv = Σ|marketValue|` over the book, cash included — one base, so that
    // the weight column can foot. Dividing the cash row by a gross that excluded it gave that one
    // row a weight measured against a different book and the column added up to 105.9 %.
    const grossOfEverything = data.holdings
      .filter((h) => typeof h.marketValue.v === 'number')
      .reduce((sum, h) => sum + Math.abs(h.marketValue.v as number), 0);
    expect(data.totals.grossMv).toBeCloseTo(grossOfEverything, 4);
    expect(data.totals.grossMv).toBeCloseTo(data.totals.netMv, 4); // this book is long-only + cash
    expect(cash.weight.v as number).toBeCloseTo(50_000 / data.totals.grossMv, 12);
  });

  it('foots: the weight column sums to exactly 100 % of the priced book', async () => {
    const { data } = await runPORT();
    const weights = data.holdings.flatMap((h) => (typeof h.weight.v === 'number' ? [h.weight.v] : []));
    // Five priced securities and the cash line; only the unresolved and the stale name are absent.
    expect(weights).toHaveLength(data.holdings.length - 2);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('sets benchWeight to 0 (never null) for a held name the benchmark does not carry', async () => {
    const { data } = await runPORT();
    expect(data.portfolio.benchmark).toMatchObject({
      instrumentId: env.index.instrumentId,
      source: 'portfolio',
    });
    expect(rowOf(data, env.alpha).benchWeight).toBeCloseTo(0.4, 10);
    expect(rowOf(data, env.euro).benchWeight).toBe(0);
    const euro = rowOf(data, env.euro);
    expect(euro.activeWeight).toBeCloseTo(euro.weight.v as number, 10);
  });
});

describe('PORT — tenant isolation (PORT-07, SEC-05)', () => {
  it("answers another firm's portfolio id with NO_PORTFOLIO and no rows", async () => {
    const { data, meta } = await runPORT({ portfolioId: env.otherPortfolioId });
    expect(data.holdings).toEqual([]);
    expect(data.portfolio.name).toBe('');
    expect(data.totals.marketValue.v).toBeNull();
    const entry = meta.unavailable.find((u) => u.field === 'portfolio');
    expect(entry?.reason).toBe('NO_SOURCE');
    expect(entry?.detail.startsWith('NO_PORTFOLIO')).toBe(true);
    // The confidentiality statement travels even on the empty answer.
    expect(data.confidentiality.firmOnly).toBe(true);
  });

  it('answers a portfolio id that does not exist at all identically', async () => {
    const { data, meta } = await runPORT({ portfolioId: 2_000_000_000 });
    expect(data.holdings).toEqual([]);
    expect(meta.unavailable.some((u) => u.detail.startsWith('NO_PORTFOLIO'))).toBe(true);
  });
});

describe('PORT — exposure (PORT-03)', () => {
  it('groups by GICS sector, subtotals to the book and lists every currency', async () => {
    const { data } = await runPORT({ view: 'exposure' });
    const exposure = data.exposure!;
    expect(exposure).not.toBeNull();
    expect(exposure.groupBy).toBe('sector');
    expect(exposure.engine.name).toBe('portfolio/exposure');

    const keys = exposure.rows.map((r) => r.key);
    expect(keys).toContain('Information Technology');
    expect(keys).toContain('Health Care');
    expect(keys).toContain('Cash');
    // The govt line has no GICS row and is grouped under Unclassified, never inferred.
    expect(keys).toContain('Unclassified');

    const counted = exposure.rows.reduce((sum, r) => sum + r.count, 0);
    expect(counted).toBe(data.holdings.length);

    const ccy = exposure.currency.map((c) => c.ccy).sort();
    expect(ccy).toEqual(['EUR', 'USD']);
    const eur = exposure.currency.find((c) => c.ccy === 'EUR')!;
    expect(eur.fxRate.v).toBeCloseTo(1.0925, 8);
    expect(eur.fxDate).toBe('2026-09-14');

    expect(data.attribution).toBeNull();
    expect(data.risk).toBeNull();
  });

  it('regroups by currency when asked', async () => {
    const { data } = await runPORT({ view: 'exposure', groupBy: 'currency' });
    expect(data.exposure!.rows.map((r) => r.key).sort()).toEqual(['EUR', 'USD']);
  });
});

describe('PORT — attribution (PORT-03, ANAL-08)', () => {
  it('decomposes active return so the three terms sum to it', async () => {
    const { data, meta } = await runPORT({ view: 'attribution', lookbackDays: 252 });
    const attribution = data.attribution!;
    expect(attribution).not.toBeNull();
    expect(attribution.method).toBe('brinson_fachler');

    const { allocation, selection, interaction, active } = attribution.total;
    expect(allocation + selection + interaction).toBeCloseTo(active, 9);
    for (const row of attribution.rows) {
      expect(row.allocation + row.selection + row.interaction).toBeCloseTo(row.total, 12);
    }
    expect(attribution.rows.map((r) => r.key)).toContain('Information Technology');

    const engine = meta.engines.find((e) => e.name === 'portfolio/attribution')!;
    expect(engine.version).toBe('1.0.0');
    expect(engine.inputsHash).toHaveLength(64);
  });

  it('puts fixed income in one unattributed bucket with its reason', async () => {
    const { data, meta } = await runPORT({ view: 'attribution' });
    const unattributed = data.attribution!.unattributed!;
    expect(unattributed).not.toBeNull();
    expect(unattributed.reason).toBe('FI_ATTRIBUTION_UNAVAILABLE');
    expect(data.notes).toContain('FI_ATTRIBUTION_UNAVAILABLE');
    // The contribution of a sleeve the model could not run on is unknown, not zero — `null` with
    // a reason, and an entry a screen can hover. It used to be the literal 0 beside the very
    // reason that says it cannot be computed.
    expect(unattributed.total).toBeNull();
    expect(unattributed.weight).toBeGreaterThan(0);
    const bucket = meta.unavailable.find(
      (u) => u.field === 'attribution.unattributed.total',
    )!;
    expect(bucket.detail).toContain('not zero');

    // Both sides are renormalised over the attributable subset, so `rows[].portWeight` sums to 1
    // while the sleeve is only part of the book: the payload carries that fraction rather than
    // leaving `total.portReturn` to be read as the portfolio's return.
    const attribution = data.attribution!;
    expect(attribution.attributableWeight).toBeGreaterThan(0);
    expect(attribution.attributableWeight).toBeLessThan(1);
    // The two sleeves are disjoint shares of the same book, so together they can never exceed it
    // (the cash line and the unpriced name make up the rest).
    expect(attribution.attributableWeight + unattributed.weight).toBeLessThanOrEqual(1 + 1e-9);
    expect(
      attribution.rows.reduce((sum, r) => sum + r.portWeight, 0),
    ).toBeCloseTo(1, 9);

    const fi = meta.unavailable.find((u) => u.field === 'attribution.fixedIncome')!;
    expect(fi.detail).toContain('FI_ATTRIBUTION_UNAVAILABLE');
    const ccy = meta.unavailable.find((u) => u.field === 'attribution.currency')!;
    expect(ccy.detail).toContain('CCY_ATTRIBUTION_UNAVAILABLE');
    // A govt line never reaches a sector row.
    const govt = rowOf(data, env.govt);
    expect(govt.gicsSector).toBeNull();
  });
});

describe('PORT — risk and VaR (PORT-04, PORT-05, PORT-06)', () => {
  it('reports vol, tracking error, beta and a one-day VaR with its backtest', async () => {
    const { data, meta } = await runPORT({ view: 'risk', lookbackDays: 252 });
    const risk = data.risk!;
    expect(risk).not.toBeNull();
    expect(risk.conventions).toEqual({
      returns: 'simple',
      priceBasis: 'close',
      adjust: 'price',
      annualisation: 252,
      // The declared window is the series the engine was handed, not a literal: `volPct` is the
      // stdev of the whole series × √252, so a payload that declared 30 labelled a 252-session
      // volatility as a month's.
      volWindow: risk.sessions,
    });
    expect(risk.sessions).toBeGreaterThan(200);
    expect(risk.volPct).toBeGreaterThan(0);
    expect(risk.trackingErrorPct).toBeGreaterThan(0);
    expect(risk.beta).not.toBeNull();
    expect(risk.corr).not.toBeNull();
    expect(risk.r2).not.toBeNull();

    expect(risk.var.method).toBe('historical');
    expect(risk.var.confidence).toBe(95);
    expect(risk.var.horizonDays).toBe(1);
    expect(risk.var.valuePct).not.toBeNull();
    const backtest = risk.var.backtest!;
    expect(backtest).not.toBeNull();
    // `expected = sessions × (1 − confidence)` — the engine's own identity, PORT-06.
    expect(backtest.expected).toBeCloseTo(
      (risk.sessions - backtest.windowSessions) * 0.05,
      9,
    );

    const engine = meta.engines.find((e) => e.name === 'portfolio/risk')!;
    expect(engine.inputsHash).toHaveLength(64);
  });

  it('switches to parametric VaR and to 99 % when asked', async () => {
    const historical = await runPORT({ view: 'risk' });
    const parametric = await runPORT({ view: 'risk', varMethod: 'parametric', varConfidence: '99' });
    expect(parametric.data.risk!.var.method).toBe('parametric');
    expect(parametric.data.risk!.var.confidence).toBe(99);
    expect(parametric.data.risk!.var.valuePct).not.toBe(historical.data.risk!.var.valuePct);
  });

  it('leaves Monte Carlo VaR and factor exposures null, each with a reason', async () => {
    const { data, meta } = await runPORT({ view: 'risk' });
    expect(data.risk!.varMonteCarlo).toBeNull();
    expect(data.risk!.factorExposures).toBeNull();
    expect(
      meta.unavailable.find((u) => u.field === 'risk.varMonteCarlo')?.detail,
    ).toContain('VAR_MC_NOT_IN_V1');
    expect(
      meta.unavailable.find((u) => u.field === 'risk.factorExposures')?.detail,
    ).toContain('NO_FACTOR_MODEL');
  });

  it('prices an equity shock through beta and refuses a curve shock it cannot price', async () => {
    const { data, meta } = await runPORT({
      view: 'risk',
      scenarios: ['EQUITY_DOWN_10', 'UST_PARALLEL_UP_100', 'EPISODE_2020_COVID'],
    });
    const byId = new Map(data.risk!.scenarios.map((s) => [s.id, s]));

    const equity = byId.get('EQUITY_DOWN_10')!;
    expect(equity.method).toBe('shock');
    expect(equity.pnlCcy).toBeLessThan(0);
    expect(equity.unavailableReason).toBeNull();

    // The govt line carries no DV01 in this build: the scenario is unavailable, not zero.
    const curve = byId.get('UST_PARALLEL_UP_100')!;
    expect(curve.pnlCcy).toBeNull();
    expect(curve.unavailableReason).toBe('RATE_SENSITIVITY_UNAVAILABLE');
    expect(
      meta.unavailable.find((u) => u.field === 'risk.scenarios.UST_PARALLEL_UP_100')?.detail,
    ).toContain('RATE_SENSITIVITY_UNAVAILABLE');

    // No bars cover 2020, so the episode is reported as unavailable rather than replayed.
    const episode = byId.get('EPISODE_2020_COVID')!;
    expect(episode.method).toBe('episode');
    expect(episode.pnlCcy).toBeNull();
    expect(episode.unavailableReason).toBe('EPISODE_WINDOW_UNAVAILABLE');
  });
});

describe('PORT — reproducibility (ANAL-08)', () => {
  it('produces identical engine hashes and risk numbers for the same explicit asOf', async () => {
    const first = await runPORT({ view: 'risk', lookbackDays: 252 });
    const second = await runPORT({ view: 'risk', lookbackDays: 252 });
    expect(second.meta.engines).toEqual(first.meta.engines);
    expect(second.data.risk).toEqual(first.data.risk);
    expect(second.data.totals).toEqual(first.data.totals);
  });
});

describe('PORT — goldens', () => {
  it('deep-equals the committed holdings golden at the frozen clock', async () => {
    const { data } = await runPORT();
    expectGolden('PORT.default.json', normalise(data));
  });

  it('deep-equals the committed attribution golden', async () => {
    const { data } = await runPORT({ view: 'attribution', lookbackDays: 252 });
    expectGolden('PORT.default-attribution.json', normalise(data));
  });

  it('deep-equals the committed risk golden', async () => {
    const { data } = await runPORT({ view: 'risk', lookbackDays: 252 });
    expectGolden('PORT.default-risk.json', normalise(data));
  });
});
