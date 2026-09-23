/**
 * `test/integration/functions/SECF.test.ts` — WP-09's acceptance row for `SECF`
 * (WORKPLAN §WP-09: "filters, facets, paging, Yahoo fallback marking").
 *
 * The four clauses, and the property each one turns on:
 *
 *  1. **Filters.** Asset class, market sector, country, status, index membership and the three
 *     spellings of an exchange (`EXCH=UW`, `EXCH=XNAS`, `EXCH=US`) all narrow the same statement,
 *     and an exact ISIN / CUSIP / FIGI short-circuits ranking with `score: 1` and its own
 *     `matchedOn`. An `IDX=` naming an index with no membership source **drops the filter** and
 *     says so rather than returning an empty grid (REF-07).
 *  2. **Facets.** Computed over the filtered set *before* paging. The property is exactly that:
 *     the same query at `SIZE=1` and at `SIZE=50` returns the same facet counts, so a tab count
 *     never moves as the user pages.
 *  3. **Paging.** Page 1 ∪ page 2 equals the unpaged query with no duplicates and no gaps, PAGE
 *     BACK from page 2 reproduces page 1 exactly, and a tampered cursor is `400 VALIDATION_FAILED`
 *     rather than a silently different page.
 *  4. **Yahoo fallback marking.** Three outcomes, three different truths: no grant →
 *     `NOT_LICENSED` and `source:'master'`; a grant but nothing stored and no route → `NO_SOURCE`
 *     and `source:'master'`, never a throw; a stored response → `source:'master+yahoo'` with every
 *     added row `instrumentId: -1`, every identifier `null` and a `yahoo.search` provenance row.
 *     The third case cannot be reached through the HTTP route, because the read-through table is
 *     wired by the process and not by `FunctionRouteDeps`; it is driven through `buildContext`,
 *     which carries the documented `routes`/`store` test seams, against the same resolver.
 *
 * ## No seed, and a private universe
 *
 * WP-15 owns the seed and it does not exist. Every instrument here is created inside this file's
 * own `withTxDb()` transaction, and every name, ticker and identifier carries a per-run tag so the
 * assertions about `total` and about the facet counts are about *this* file's universe — which is
 * what lets them be exact numbers instead of lower bounds.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden } from './golden.js';

import { FunctionRegistry } from '@terminal/core';
import { SECF } from '@terminal/core/functions/manifests/SECF';
import type { SecfPayload } from '@terminal/core/functions/manifests/SECF';

import { getConfig } from '../../../src/config.js';
import { buildDataServices } from '../../../src/http/routes/functions.js';
import { buildContext, ReadThroughRoutes } from '../../../src/functions/context.js';
import type {
  FunctionServerModule,
  ReadThroughKind,
  ReadThroughStore,
} from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as SecfModule from '../../../src/functions/SECF/resolve.js';
import { evaluator } from '../../../src/entitlements/evaluator.js';
import { licenceRegistry } from '../../../src/entitlements/licenceRegistry.js';
import { ProvenanceIndex } from '../../../src/data/reference.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { ensureShared, withTxDb, type TestDb } from '../../../src/test/db.js';
import { GOLDEN_CAPTURE_MS } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = '2020-01-01T00:00:00.000Z';

/**
 * The committed `yahoo.search` capture (`fixtures/providers/manifest.json`): `q=apple`, eight
 * quotes. The fallback reads the bytes under this key through the capture store, so the Yahoo
 * rows a test sees are the ones a replay run sees.
 */
const YAHOO_SEARCH_KEY = 'cc6b7afebb74bdbcf13ba0da3a9bccea910e7f229f416b627647af3d2c43698e';
const YAHOO_SEARCH_URL =
  'https://query2.finance.yahoo.com/v1/finance/search?newsCount=0&q=apple&quotesCount=8';

const REGISTRY = new FunctionRegistry([SECF]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { SECF: SecfModule };

/**
 * The made-up brand every seeded name shares.
 *
 * `instruments` is global and four integration forks run against one database, so a query for a
 * real word would be a query about whatever else happens to be committed. A nonsense word this
 * run owns makes `total` and the facet counts exact rather than "at least".
 */
const BRAND = `Korvath${randomUUID()
  .slice(0, 6)
  .replace(/[^a-z]/gi, 'x')}`;

/** The filler brand the paging assertions walk, and how many rows it has. */
const FILLER = `Drennik${randomUUID()
  .slice(0, 6)
  .replace(/[^a-z]/gi, 'x')}`;
const FILLER_COUNT = 45;

/** A query no seeded name can match, by ticker prefix, substring or trigram. */
const NO_MATCH_QUERY = `Zyxwqvj${randomUUID()
  .slice(0, 6)
  .replace(/[^a-z]/gi, 'q')}`;

const t: TestDb = withTxDb();

interface Seeded {
  ticker: string;
  instrumentId: number;
  assetClass: string;
}

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  firmId: number;
  userId: number;
  sessionId: string;
  cookie: string;
  knownAt: string;
  provenanceId: number;
  byTicker: Map<string, Seeded>;
  isin: string;
  cusip: string;
  figi: string;
}

let env: Env;

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

async function insertProvenance(sourceId: string): Promise<number> {
  const key = `secf-${sourceId}-${randomUUID()}`;
  const res = await t.client.query<{ provenance_id: string }>(
    `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                             http_status, bytes, captured_at, adapter_version)
     VALUES ($1, $2, 'test://secf/' || $2, digest($2,'sha256'), digest($2,'sha256'), 200, 0, $3,
             'test/1.0.0')
     RETURNING provenance_id`,
    [sourceId, key, new Date(GOLDEN_CAPTURE_MS).toISOString()],
  );
  return Number(res.rows[0]!.provenance_id);
}

/** A grant per source, firm and user, so the pre-check is not what this file is testing. */
async function grantEverySource(firmId: number, userId: number, except?: string): Promise<void> {
  await t.client.query(
    `INSERT INTO entitlement_grants
       (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
        usage_display, usage_export, usage_api, valid_from, valid_to)
     SELECT k.kind, k.id, l.source_id, NULL, NULL, 'realtime'::tier, true, true, true,
            $3::timestamptz, 'infinity'::timestamptz
       FROM (SELECT DISTINCT source_id FROM licence_registry
              WHERE tx_to = 'infinity' AND ($4::text IS NULL OR source_id <> $4)) l
       CROSS JOIN (VALUES ('firm', $1::bigint), ('user', $2::bigint)) AS k(kind, id)`,
    [firmId, userId, GRANT_FROM, except ?? null],
  );
}

interface InstrumentSpec {
  ticker: string;
  name: string;
  assetClass: string;
  marketSector: string;
  exchCode: string;
  securityType: string;
  country?: string;
  status?: string;
  searchWeight?: number;
  listing?: { mic: string; exchCode: string };
}

async function seedInstrument(spec: InstrumentSpec, issuerId: number): Promise<Seeded> {
  const p = env.provenanceId;
  const issueId = await nextId('issue_id_seq');
  const instrumentId = await nextId('instrument_id_seq');

  await t.client.query(
    `INSERT INTO issues (issue_id, issuer_id, asset_class, security_type, name, currency,
                         country_of_issue, valid_from, tx_from, provenance_id)
     VALUES ($1,$2,$3::asset_class,$4,$5,'USD',$6,$7::timestamptz,$7::timestamptz,$8)`,
    [
      issueId,
      issuerId,
      spec.assetClass,
      spec.securityType,
      spec.name,
      spec.country ?? 'US',
      VALID_FROM,
      p,
    ],
  );
  // `bt_guard_update` makes every bitemporal row immutable, so `primary_listing_id` has to be
  // known before the instrument row exists: the listing id is reserved first, the instrument is
  // written with it, and the listing follows.
  const listingId = spec.listing === undefined ? null : await nextId('listing_id_seq');
  await t.client.query(
    `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                              exch_code, name, currency, status, search_weight, primary_listing_id,
                              valid_from, tx_from, provenance_id)
     VALUES ($1,$2,$3::asset_class,$4::market_sector,$5,$6,$7,'USD',$8,$9,$10,$11::timestamptz,
             $11::timestamptz,$12)`,
    [
      instrumentId,
      issueId,
      spec.assetClass,
      spec.marketSector,
      spec.ticker,
      spec.exchCode,
      spec.name,
      spec.status ?? 'active',
      spec.searchWeight ?? 1,
      listingId,
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
  return { ticker: spec.ticker, instrumentId, assetClass: spec.assetClass };
}

/** `FILLER_COUNT` rows under their own brand, in one statement per table. */
async function seedFillers(issuerId: number): Promise<void> {
  const ids = await t.client.query<{ issue_id: string; instrument_id: string }>(
    `SELECT nextval('issue_id_seq')::bigint AS issue_id,
            nextval('instrument_id_seq')::bigint AS instrument_id
       FROM generate_series(1, $1)`,
    [FILLER_COUNT],
  );
  const rows = ids.rows.map((row, i) => ({
    issueId: Number(row.issue_id),
    instrumentId: Number(row.instrument_id),
    ticker: `${FILLER}${String(i).padStart(2, '0')}`,
    name: `${FILLER} Holding ${String(i).padStart(2, '0')}`,
  }));

  const issueValues = rows
    .map(
      (r) => `(${String(r.issueId)}, ${String(issuerId)}, 'equity', 'Common Stock',
                  '${r.name}', 'USD', 'US', $1::timestamptz, $1::timestamptz, $2)`,
    )
    .join(',');
  await t.client.query(
    `INSERT INTO issues (issue_id, issuer_id, asset_class, security_type, name, currency,
                         country_of_issue, valid_from, tx_from, provenance_id)
     VALUES ${issueValues}`,
    [VALID_FROM, env.provenanceId],
  );

  const instrumentValues = rows
    .map(
      (r) => `(${String(r.instrumentId)}, ${String(r.issueId)}, 'equity', 'Equity', '${r.ticker}',
               'US', '${r.name}', 'USD', 'active', 1, $1::timestamptz, $1::timestamptz, $2)`,
    )
    .join(',');
  await t.client.query(
    `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                              exch_code, name, currency, status, search_weight, valid_from,
                              tx_from, provenance_id)
     VALUES ${instrumentValues}`,
    [VALID_FROM, env.provenanceId],
  );
}

beforeEach(async () => {
  await ensureLicences();

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`SECF Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1,$2,'SECF User','user') RETURNING user_id`,
    [firmId, `secf-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  const session = await t.client.query<{ session_id: string }>(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1,$2,'web', now() + interval '1 day', true) RETURNING session_id`,
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

  const provenanceId = await insertProvenance('openfigi.mapping');
  const tag = randomUUID()
    .slice(0, 4)
    .toUpperCase()
    .replace(/[^A-Z]/g, 'X');
  env = {
    harness,
    app: harness.app,
    clock,
    firmId,
    userId,
    sessionId: session.rows[0]!.session_id,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    knownAt: '',
    provenanceId,
    byTicker: new Map(),
    // Exactly the shapes §SECF step 2 short-circuits on: ISIN 12, CUSIP 9, FIGI `BBG`+8+digit.
    isin: `US03783${tag}1`,
    cusip: `0378${tag}0`,
    figi: `BBG0${tag}0XR1`,
  };

  // ── the universe ──────────────────────────────────────────────────────────────────────────
  const issuerId = await nextId('issuer_id_seq');
  await t.client.query(
    `INSERT INTO issuers (issuer_id, name, cik, country, valid_from, tx_from, provenance_id)
     VALUES ($1,$2,'0000320193','US',$3::timestamptz,$3::timestamptz,$4)`,
    [issuerId, `${BRAND} Inc issuer`, VALID_FROM, provenanceId],
  );

  // GICS is seeded from `wiki.sp500` for S&P 500 issuers only, which is exactly the gap SECF
  // reports per hit — one classified issuer proves both halves of that rule.
  await ensureShared(
    t,
    `SELECT 1 FROM classification_schemes WHERE scheme = 'GICS'`,
    `INSERT INTO classification_schemes (scheme, name, source_id, levels)
     VALUES ('GICS','GICS','wiki.sp500',4) ON CONFLICT (scheme) DO NOTHING`,
  );
  await t.client.query(
    `INSERT INTO classification_codes (scheme, code, name, level)
     VALUES ('GICS','45','Information Technology',1) ON CONFLICT (scheme, code) DO NOTHING`,
  );
  await t.client.query(
    `INSERT INTO entity_classifications (entity_kind, entity_id, scheme, code, valid_from, tx_from,
                                         provenance_id)
     VALUES ('issuer',$1,'GICS','45',$2::timestamptz,$2::timestamptz,$3)`,
    [issuerId, VALID_FROM, provenanceId],
  );

  const otherIssuer = await nextId('issuer_id_seq');
  await t.client.query(
    `INSERT INTO issuers (issuer_id, name, country, valid_from, tx_from, provenance_id)
     VALUES ($1,$2,'GB',$3::timestamptz,$3::timestamptz,$4)`,
    [otherIssuer, `${BRAND} Hospitality issuer`, VALID_FROM, provenanceId],
  );

  const specs: { spec: InstrumentSpec; issuer: number }[] = [
    {
      spec: {
        ticker: `${tag}AA`,
        name: `${BRAND} Inc`,
        assetClass: 'equity',
        marketSector: 'Equity',
        exchCode: 'US',
        securityType: 'Common Stock',
        searchWeight: 5,
        listing: { mic: 'XNAS', exchCode: 'UW' },
      },
      issuer: issuerId,
    },
    {
      spec: {
        ticker: `${tag}AB`,
        name: `${BRAND} Hospitality REIT`,
        assetClass: 'equity',
        marketSector: 'Equity',
        exchCode: 'US',
        securityType: 'REIT',
        country: 'GB',
        searchWeight: 4,
        listing: { mic: 'XNYS', exchCode: 'UN' },
      },
      issuer: otherIssuer,
    },
    {
      spec: {
        ticker: `${tag}AC`,
        name: `${BRAND} 500 ETF`,
        assetClass: 'etf',
        marketSector: 'Equity',
        exchCode: 'US',
        securityType: 'ETP',
        searchWeight: 3,
        listing: { mic: 'ARCX', exchCode: 'UP' },
      },
      issuer: issuerId,
    },
    {
      spec: {
        ticker: `${tag}AD`,
        name: `${BRAND} Composite Index`,
        assetClass: 'index',
        marketSector: 'Index',
        exchCode: 'INDEX',
        securityType: 'Index',
        searchWeight: 2,
      },
      issuer: issuerId,
    },
    {
      spec: {
        ticker: `${tag}AE`,
        name: `${BRAND} Delisted Holdings`,
        assetClass: 'equity',
        marketSector: 'Equity',
        exchCode: 'US',
        securityType: 'Common Stock',
        status: 'delisted',
        searchWeight: 1,
      },
      issuer: issuerId,
    },
  ];
  for (const { spec, issuer } of specs) {
    env.byTicker.set(spec.ticker, await seedInstrument(spec, issuer));
  }

  const aapl = env.byTicker.get(`${tag}AA`)!;
  await t.client.query(
    `INSERT INTO identifiers (entity_kind, entity_id, scheme, value, is_primary, valid_from,
                              tx_from, provenance_id)
     VALUES ('instrument',$1,'FIGI',$2,true,$5::timestamptz,$5::timestamptz,$6),
            ('instrument',$1,'ISIN',$3,true,$5::timestamptz,$5::timestamptz,$6),
            ('instrument',$1,'CUSIP',$4,true,$5::timestamptz,$5::timestamptz,$6)`,
    [aapl.instrumentId, env.figi, env.isin, env.cusip, VALID_FROM, provenanceId],
  );

  // Two indices: one with a membership source, one without. The second is what `IDX=` drops.
  const spxInstrument = env.byTicker.get(`${tag}AD`)!;
  const idx = await t.client.query<{ index_id: string }>(
    `INSERT INTO indices (code, instrument_id, membership_source_id, provider)
     VALUES ($1,$2,'ssga.holdings','Test') RETURNING index_id`,
    [`${tag}SPX`, spxInstrument.instrumentId],
  );
  await t.client.query(
    `INSERT INTO index_members (index_id, instrument_id, weight, as_of_date, source_id,
                                valid_from, tx_from, provenance_id)
     VALUES ($1,$2,0.07,'2026-06-30','ssga.holdings',$3::timestamptz,$3::timestamptz,$4)`,
    [Number(idx.rows[0]!.index_id), aapl.instrumentId, VALID_FROM, provenanceId],
  );
  const unsourcedInstrument = await seedInstrument(
    {
      ticker: `${tag}AF`,
      name: `${BRAND} Unsourced Index`,
      assetClass: 'index',
      marketSector: 'Index',
      exchCode: 'INDEX',
      securityType: 'Index',
      searchWeight: 1,
    },
    issuerId,
  );
  env.byTicker.set(`${tag}AF`, unsourcedInstrument);
  await t.client.query(
    `INSERT INTO indices (code, instrument_id, membership_source_id, provider)
     VALUES ($1,$2,NULL,'Test')`,
    [`${tag}NDX`, unsourcedInstrument.instrumentId],
  );

  // `pageSize` has a floor of 20 (§SECF params), so paging needs a universe bigger than a page.
  // The fillers carry their own brand, so the filter and facet assertions above stay exact.
  await seedFillers(issuerId);

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  env.knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();
  env.byTicker.set('__tag__', { ticker: tag, instrumentId: -1, assetClass: '' });
});

afterEach(async () => {
  await env.harness.close();
});

function tag(): string {
  return env.byTicker.get('__tag__')!.ticker;
}

interface RunResult {
  data: SecfPayload;
  meta: {
    unavailable: { field: string; reason: string; detail: string }[];
    page?: { index: number; count: number; cursor: string | null };
    resultId: string;
  };
}

async function run(params: Record<string, unknown>): Promise<RunResult> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/SECF/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<RunResult>();
}

async function page(resultId: string, direction: 'fwd' | 'back'): Promise<RunResult> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/SECF/page`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { resultId, direction },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<RunResult>();
}

const keysOf = (p: SecfPayload): string[] => p.hits.map((h) => h.instrument.display);

describe('SECF — filters, facets, paging and the Yahoo fallback', () => {
  it('finds the private universe by name and orders it the way the command line would', async () => {
    const { data, meta } = await run({ query: BRAND });

    expect(data.variant).toBe('default');
    expect(data.source).toBe('master');
    // `status: 'active'` is the default, so the delisted row is out; every other seeded row is in.
    expect(data.total).toBe(5);
    expect(data.hits).toHaveLength(5);
    for (const hit of data.hits) {
      expect(hit.instrument.name).toContain(BRAND);
      expect(hit.matchedOn).toBe('name');
      // `matched` are ranges into `instrument.display`, which carries the ticker and not the
      // name — a name hit therefore highlights nothing, and the ticker query below does.
      expect(Array.isArray(hit.matched)).toBe(true);
      expect(hit.provIdx).toBeGreaterThanOrEqual(0);
    }
    // The decorated row: identifiers, membership, GICS and the listing count, all from the
    // master rather than from the ranking.
    const apple = data.hits.find((h) => h.instrument.ticker === `${tag()}AA`)!;
    expect(apple.gicsSector).toBe('Information Technology');
    expect(apple.memberOf).toEqual([`${tag()}SPX`]);
    expect(apple.identifiers).toEqual({ figi: env.figi, isin: env.isin, cusip: env.cusip });
    expect(apple.listings).toBe(1);
    // A ticker query highlights the range it matched in `display`, and leads with that row.
    const byTicker = await run({ query: `${tag()}AA` });
    expect(byTicker.data.hits[0]!.instrument.ticker).toBe(`${tag()}AA`);
    expect(byTicker.data.hits[0]!.matchedOn).toBe('ticker');
    expect(byTicker.data.hits[0]!.matched[0]).toEqual([0, `${tag()}AA`.length]);

    // REF-07's standing note, and the GICS gap, both stated rather than implied.
    expect(meta.unavailable.map((u) => u.field)).toContain('memberOf');
    expect(meta.unavailable.map((u) => u.field)).toContain('hits[].gicsSector');
    for (const note of meta.unavailable) {
      expect(['NO_SOURCE', 'NOT_LICENSED', 'NOT_APPLICABLE']).toContain(note.reason);
    }
  });

  it('short-circuits ranking on an exact ISIN, CUSIP or FIGI', async () => {
    for (const [query, matchedOn] of [
      [env.isin, 'isin'],
      [env.cusip, 'cusip'],
      [env.figi, 'figi'],
    ] as const) {
      const { data } = await run({ query });
      expect(data.hits, query).toHaveLength(1);
      expect(data.hits[0]!.matchedOn).toBe(matchedOn);
      expect(data.hits[0]!.score).toBe(1);
      expect(data.hits[0]!.instrument.ticker).toBe(`${tag()}AA`);
    }
  });

  it('filters by asset class, sector, country, status and the three exchange spellings', async () => {
    const etf = await run({ query: BRAND, assetClass: 'etf' });
    expect(etf.data.hits.map((h) => h.instrument.ticker)).toEqual([`${tag()}AC`]);

    const indices = await run({ query: BRAND, sector: 'Index' });
    expect(indices.data.hits.map((h) => h.instrument.ticker).sort()).toEqual([
      `${tag()}AD`,
      `${tag()}AF`,
    ]);

    const gb = await run({ query: BRAND, country: 'GB' });
    expect(gb.data.hits.map((h) => h.instrument.ticker)).toEqual([`${tag()}AB`]);

    // `STATUS=ALL` is the only way to see the delisted row.
    const active = await run({ query: BRAND, status: 'active' });
    const all = await run({ query: BRAND, status: 'all' });
    expect(active.data.total).toBe(5);
    expect(all.data.total).toBe(6);
    expect(all.data.hits.map((h) => h.instrument.ticker)).toContain(`${tag()}AE`);

    // EXCH=UW (the OpenFIGI venue code), EXCH=XNAS (the MIC) and EXCH=US (the composite) all
    // name the same listing — §SECF step 2.
    for (const exchange of ['UW', 'XNAS']) {
      const hit = await run({ query: BRAND, exchange });
      expect(
        hit.data.hits.map((h) => h.instrument.ticker),
        exchange,
      ).toEqual([`${tag()}AA`]);
    }
    const composite = await run({ query: BRAND, exchange: 'US' });
    // Every listed row carries the `US` composite `exch_code`; the two indices do not.
    expect(composite.data.hits.map((h) => h.instrument.ticker).sort()).toEqual([
      `${tag()}AA`,
      `${tag()}AB`,
      `${tag()}AC`,
    ]);
  });

  it('keeps the IDX filter when the index has a membership source, and drops it when it has none', async () => {
    const member = await run({ query: BRAND, indexMember: `${tag()}SPX` });
    expect(member.data.hits.map((h) => h.instrument.ticker)).toEqual([`${tag()}AA`]);

    // REF-07: an index with no membership source has no roster to filter by, so the filter is
    // dropped and the note explains the count — never an empty grid the user cannot account for.
    const dropped = await run({ query: BRAND, indexMember: `${tag()}NDX` });
    expect(dropped.data.total).toBe(5);
    const note = dropped.meta.unavailable.find((u) => u.field === 'indexMember');
    expect(note?.reason).toBe('NO_SOURCE');
    expect(note?.detail).toContain(`${tag()}NDX`);
  });

  it('computes facets over the filtered set, so a tab count never moves as the user pages', async () => {
    const wide = await run({ query: BRAND, pageSize: 50 });
    const narrow = await run({ query: BRAND, pageSize: 20 });

    // The page changes; the facets do not.
    expect(wide.data.hits.length).toBe(5);
    expect(narrow.data.facets).toEqual(wide.data.facets);
    expect(narrow.data.total).toBe(wide.data.total);

    expect(wide.data.facets.assetClass).toEqual({ equity: 2, etf: 1, index: 2 });
    expect(wide.data.facets.status).toEqual({ active: 5 });
    // A class that is not listed anywhere is counted under its pseudo-venue, and the note says so.
    expect(wide.data.facets.exchange.INDEX).toBe(2);
    expect(wide.meta.unavailable.map((u) => u.field)).toContain('facets.exchange');

    const all = await run({ query: BRAND, status: 'all' });
    expect(all.data.facets.status).toEqual({ active: 5, delisted: 1 });
  });

  it('pages forward and back over the same ordering, with no gaps and no duplicates', async () => {
    const unpaged = await run({ query: FILLER, pageSize: 200, sort: 'ticker' });
    expect(unpaged.data.hits).toHaveLength(FILLER_COUNT);
    const everything = keysOf(unpaged.data);

    const first = await run({ query: FILLER, pageSize: 20, sort: 'ticker' });
    expect(keysOf(first.data)).toEqual(everything.slice(0, 20));
    expect(first.meta.page?.index).toBe(0);
    expect(first.meta.page?.count).toBe(3);
    expect(first.meta.page?.cursor).not.toBeNull();

    const second = await page(first.meta.resultId, 'fwd');
    expect(keysOf(second.data)).toEqual(everything.slice(20, 40));
    expect(second.meta.page?.index).toBe(1);

    const third = await page(second.meta.resultId, 'fwd');
    expect(keysOf(third.data)).toEqual(everything.slice(40));
    expect(third.meta.page?.cursor).toBeNull();

    // No duplicates, no gaps: the three pages are the unpaged query, exactly.
    const walked = [...keysOf(first.data), ...keysOf(second.data), ...keysOf(third.data)];
    expect(walked).toEqual(everything);
    expect(new Set(walked).size).toBe(walked.length);

    // PAGE BACK from page 2 reproduces page 1 byte for byte.
    const back = await page(second.meta.resultId, 'back');
    expect(keysOf(back.data)).toEqual(keysOf(first.data));
    expect(back.meta.page?.index).toBe(0);
  });

  it('pages by the `{ n, i }` key when the sort is by name', async () => {
    const unpaged = await run({ query: FILLER, pageSize: 200, sort: 'name' });
    const names = unpaged.data.hits.map((h) => h.instrument.name);
    expect([...names].sort()).toEqual(names);

    const first = await run({ query: FILLER, pageSize: 20, sort: 'name' });
    const second = await page(first.meta.resultId, 'fwd');
    const third = await page(second.meta.resultId, 'fwd');
    expect([...keysOf(first.data), ...keysOf(second.data), ...keysOf(third.data)]).toEqual(
      keysOf(unpaged.data),
    );

    // The cursor is the key of the last row of the page, base64url of `{ n, i }`.
    const cursor = SecfModule.decodeCursor(first.meta.page!.cursor!);
    expect(cursor).toHaveProperty('n');
    expect(cursor).toHaveProperty('i');
  });

  it('refuses a cursor it did not issue', () => {
    // `/functions/:code/page` re-supplies the cursor from the cached result, so a tampered one
    // cannot arrive over the wire — the refusal is asserted where it is decided.
    for (const raw of ['not-a-cursor', Buffer.from('{"z":1}').toString('base64url')]) {
      try {
        SecfModule.decodeCursor(raw);
        expect.unreachable(`a tampered cursor must be refused: ${raw}`);
      } catch (err) {
        expect((err as { code?: string }).code).toBe('VALIDATION_FAILED');
        // `ValidationFailedError.location` is one of the four request locations; the field is
        // named in the issue path, which is what `page.cursor` means on the wire.
        const details = (
          err as { details?: { location?: string; issues?: { path?: unknown[] }[] } }
        ).details;
        expect(details?.location).toBe('body');
        expect(details?.issues?.[0]?.path).toEqual(['page', 'cursor']);
      }
    }
  });

  it('marks a master-only result when the firm has no yahoo.search grant', async () => {
    // A second firm, granted everything *except* the fallback source.
    const firm = await t.client.query<{ firm_id: string }>(
      `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
      [`SECF Ungranted ${randomUUID().slice(0, 8)}`],
    );
    const firmId = Number(firm.rows[0]!.firm_id);
    const user = await t.client.query<{ user_id: string }>(
      `INSERT INTO users (firm_id, email, display_name, role)
       VALUES ($1,$2,'SECF Ungranted','user') RETURNING user_id`,
      [firmId, `secf-ungranted-${randomUUID()}@demo.invalid`],
    );
    const userId = Number(user.rows[0]!.user_id);
    const token = `sess-${randomUUID()}`;
    await t.client.query(
      `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
       VALUES ($1,$2,'web', now() + interval '1 day', true)`,
      [userId, createHash('sha256').update(token, 'utf8').digest()],
    );
    await grantEverySource(firmId, userId, 'yahoo.search');

    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/SECF/run`,
      headers: {
        cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
        'x-requested-with': 'terminal',
      },
      payload: {
        params: { query: NO_MATCH_QUERY },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json<RunResult>();
    expect(body.data.source).toBe('master');
    const note = body.meta.unavailable.find(
      (u) => u.field === 'source' && u.reason === 'NOT_LICENSED',
    );
    expect(note?.detail).toContain('yahoo.search grant');
  });

  it('stays master-only, without throwing, when the fallback cannot be fetched', async () => {
    const { data, meta } = await run({ query: NO_MATCH_QUERY });
    expect(data.source).toBe('master');
    expect(data.hits).toEqual([]);
    const note = meta.unavailable.find((u) => u.field === 'source');
    expect(note?.reason).toBe('NO_SOURCE');
    expect(note?.detail).toContain('circuit open');
    // And the empty grid says why it is empty.
    expect(meta.unavailable.find((u) => u.field === 'hits')?.detail).toContain(NO_MATCH_QUERY);
  });

  it('marks Yahoo rows from the recorded capture, and never writes one to the master', async () => {
    // The read-through table is wired by the process, not by `FunctionRouteDeps`, so this is the
    // one case that is driven through `buildContext`'s documented `routes`/`store` seams. The
    // bytes are the committed `yahoo.search` capture — the same ones a replay run serves — so the
    // rows below are a real Yahoo response, not a fixture written by this test.
    const stored = await t.client.query<{ provenance_id: string }>(
      `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                               http_status, bytes, captured_at, adapter_version)
       VALUES ('yahoo.search', $1, $2, digest($1,'sha256'), digest($1,'sha256'), 200, 2551, $3,
               'yahoo/1.0.0')
       RETURNING provenance_id`,
      [YAHOO_SEARCH_KEY, YAHOO_SEARCH_URL, new Date(GOLDEN_CAPTURE_MS).toISOString()],
    );
    const provenanceId = Number(stored.rows[0]!.provenance_id);

    const routes = new ReadThroughRoutes();
    routes.register('yahoo.search' as ReadThroughKind, {
      providerId: 'yahoo.search',
      request: (key: string) => ({ key }),
      url: (key: string) => YAHOO_SEARCH_URL.replace('q=apple', `q=${key}`),
    });
    const store: ReadThroughStore = {
      latest: () => Promise.resolve({ provenanceId, capturedAt: new Date(GOLDEN_CAPTURE_MS) }),
      record: () => Promise.reject(new Error('the fallback must not fetch when a row is stored')),
    };

    const asOf = { validAt: new Date(GOLDEN_CAPTURE_MS), knownAt: new Date(env.knownAt) };
    const registry = licenceRegistry({ db: t.db, clock: env.clock });
    const ctx = buildContext(
      {
        clock: env.clock,
        db: t.db,
        data: buildDataServices(t.db, asOf, new ProvenanceIndex(), {
          userId: env.userId,
          firmId: env.firmId,
        }),
        plant: env.harness.deps.plant,
        registry,
        entitlements: evaluator({ db: t.db, clock: env.clock, registry }),
        routes,
        store,
      },
      {
        user: { userId: env.userId, firmId: env.firmId, sessionId: env.sessionId, role: 'user' },
        traceId: randomUUID(),
        instrument: null,
        asOf,
        usage: 'display',
      },
    );

    const payload = await SecfModule.resolve(ctx, SECF.params.parse({ query: NO_MATCH_QUERY }));

    expect(payload.source).toBe('master+yahoo');
    expect(payload.hits.length).toBeGreaterThan(0);
    expect(payload.hits.length).toBeLessThanOrEqual(8);
    expect(payload.hits[0]!.instrument.display).toBe('AAPL');
    expect(payload.hits.map((h) => h.instrument.display)).toContain('APLE');
    expect(payload.hits.find((h) => h.instrument.display === 'AAPX')!.instrument.assetClass).toBe(
      'etf',
    );

    for (const hit of payload.hits) {
      // Not in the master: `Enter` on such a row goes through `POST /ref/resolve`, and nothing
      // here may create a master record.
      expect(hit.instrument.instrumentId).toBe(-1);
      expect(hit.instrument.status).toBe('pending');
      expect(hit.matchedOn).toBe('trigram');
      expect(hit.identifiers).toEqual({ figi: null, isin: null, cusip: null });
      expect(hit.memberOf).toEqual([]);
      expect(hit.listings).toBe(0);
      // Clamped below every master hit: a row that is not in the master may never outrank one.
      expect(hit.score).toBeLessThanOrEqual(0.5);
      expect(hit.provIdx).toBeGreaterThanOrEqual(0);
    }

    // DATA-10: the added rows cite the recorded response.
    expect(
      ctx.prov
        .list()
        .some((row) => row.sourceId === 'yahoo.search' && row.provenanceId === provenanceId),
    ).toBe(true);

    // Nothing was written to the master.
    const masterRows = await t.client.query(
      `SELECT 1 FROM instruments WHERE ticker IN ('AAPL','APLE','AAPX') AND tx_to = 'infinity'`,
    );
    expect(masterRows.rowCount).toBe(0);
  });

  it('declares no live spec: prices live in DES and Q, one Enter away', () => {
    expect(SECF.live).toBeNull();
    expect(SECF.pageable).toBe(true);
    expect(SECF.assetClasses).toBe('none');
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    const { data } = await run({ query: BRAND });
    expectGolden('SECF.default.json', normalise(data));
  });
});

/**
 * Everything this run owns becomes a token: the sequence-allocated instrument ids, the nonsense
 * brand and ticker prefix the fixture generates per run (so four integration forks sharing one
 * `instruments` table cannot see each other's rows), and the identifiers minted with them. What
 * is left is the shape, the ordering, the scores, the facet counts and the provenance indices —
 * which is what the golden is for.
 */
function normalise(payload: SecfPayload): unknown {
  const ids = new Map<number, string>();
  for (const seeded of env.byTicker.values()) {
    ids.set(seeded.instrumentId, `<${seeded.ticker.replace(tag(), 'T:')}>`);
  }
  // `primaryListingId` is a bare sequence value with no fixture control over it, so the golden
  // records *that there is one*, not which number this run drew.
  const listingIds = new Set<number>();
  for (const hit of payload.hits) {
    const id = hit.instrument.primaryListingId;
    if (typeof id === 'number') listingIds.add(id);
  }
  const strings: [string, string][] = [
    [BRAND, '<BRAND>'],
    [tag(), '<T>'],
    [env.isin, '<ISIN>'],
    [env.cusip, '<CUSIP>'],
    [env.figi, '<FIGI>'],
  ];
  return JSON.parse(
    JSON.stringify(payload, (_key: string, value: unknown) => {
      if (typeof value === 'number') {
        if (ids.has(value)) return ids.get(value);
        if (listingIds.has(value)) return '<listing>';
        return value;
      }
      if (typeof value === 'string') {
        let out = value;
        for (const [from, to] of strings) out = out.split(from).join(to);
        for (const [id, token] of ids) out = out.split(String(id)).join(token);
        return out;
      }
      return value;
    }),
  );
}
