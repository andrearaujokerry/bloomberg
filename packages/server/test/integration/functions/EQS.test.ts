/**
 * `test/integration/functions/EQS.test.ts` — WP-10's acceptance row for `EQS`
 * (WORKPLAN §WP-10: "a multi-factor screen over `xbrl_frames` returns a stable ranked set; saved
 * screen round-trips").
 *
 * A screen is only as honest as its treatment of absence, so the fixture is deliberately ragged:
 * of twelve index constituents, ten have an `xbrl_frames` value for `us-gaap:Assets`, six have
 * standardised `fin_statements`, and two have neither. What the tests then pin is:
 *
 *  - a criterion on a frames factor ranks the ten and **excludes and counts** the two, rather than
 *    reading their absence as a zero (which would keep them) or as +∞ (which would drop them
 *    silently). `criteria[i].noData` plus `counts.excludedNoData` is how the screen says so;
 *  - a criterion on a factor with **no ingested frame at all** — `TOTAL_EQUITY`, which the weekly
 *    `sec.frames` job has not fetched — is reported `unavailableReason: 'FRAME_NOT_INGESTED'` and
 *    is **not applied**. Applying it would empty the screen and look like a result;
 *  - the column for such a factor keeps its header and renders every cell absent, so a reader
 *    cannot mistake the screen for a complete one;
 *  - a `fin_statements` factor over issuers whose filings were never ingested raises
 *    `FUNDAMENTALS_NOT_INGESTED` once, with the count, not once per row;
 *  - a saved screen round-trips through `saved_searches.query` and explicit params win over it.
 *
 * WP-15 owns the seed; everything here is created inside this file's own transaction.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden, idToken, subjectToken } from './golden.js';

import { FunctionRegistry } from '@terminal/core';
import { EQS, ScreenCriteria, parseCriteria } from '@terminal/core/functions/manifests/EQS';
import type { EqsPayload } from '@terminal/core/functions/manifests/EQS';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as EQSModule from '../../../src/functions/EQS/resolve.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS, seedQuoteInstrument } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = '2020-01-01T00:00:00.000Z';

/** The only frame the offline wedge has ever ingested (FIXTURES `sec-frames-assets.json`). */
const FRAME = 'CY2024Q4I';
const MEMBERSHIP_DATE = '2026-09-14';

const REGISTRY = new FunctionRegistry([EQS]);
const MODULES: Record<string, FunctionServerModule<never, never>> = {
  EQS: EQSModule as unknown as FunctionServerModule<never, never>,
};

const t: TestDb = withTxDb();

/**
 * Twelve constituents. `assets` is the `xbrl_frames` value (null = the frames job never saw this
 * filer); `revenue` drives the `fin_statements` half (null = companyfacts were never ingested).
 */
interface NameSpec {
  ticker: string;
  name: string;
  sector: 'Information Technology' | 'Health Care' | 'Financials';
  assets: number | null;
  revenue: number | null;
  netInc: number | null;
}

const NAMES: readonly NameSpec[] = [
  { ticker: 'AAA', name: 'Alpha Systems', sector: 'Information Technology', assets: 3.6e11, revenue: 4.1e11, netInc: 1.0e11 },
  { ticker: 'BBB', name: 'Beta Devices', sector: 'Information Technology', assets: 5.6e11, revenue: 2.8e11, netInc: 1.0e11 },
  { ticker: 'CCC', name: 'Cobalt Software', sector: 'Information Technology', assets: 9.0e10, revenue: 6.0e10, netInc: 6.0e9 },
  { ticker: 'DDD', name: 'Delta Health', sector: 'Health Care', assets: 2.5e11, revenue: 1.2e11, netInc: 1.5e10 },
  { ticker: 'EEE', name: 'Everest Pharma', sector: 'Health Care', assets: 1.1e11, revenue: 5.0e10, netInc: 9.0e9 },
  { ticker: 'FFF', name: 'Foxglove Labs', sector: 'Health Care', assets: 4.0e10, revenue: null, netInc: null },
  { ticker: 'GGG', name: 'Granite Bank', sector: 'Financials', assets: 3.9e12, revenue: null, netInc: null },
  { ticker: 'HHH', name: 'Harbour Trust', sector: 'Financials', assets: 7.2e11, revenue: null, netInc: null },
  { ticker: 'III', name: 'Ironwood Capital', sector: 'Financials', assets: 1.8e11, revenue: 3.0e10, netInc: 4.0e9 },
  { ticker: 'JJJ', name: 'Juniper Insurance', sector: 'Financials', assets: 6.0e10, revenue: 2.0e10, netInc: 1.0e9 },
  // The two the frames job has never seen: no `us-gaap:Assets` row at all.
  { ticker: 'KKK', name: 'Kestrel Mining', sector: 'Financials', assets: null, revenue: 1.0e10, netInc: 5.0e8 },
  { ticker: 'LLL', name: 'Lantern Energy', sector: 'Health Care', assets: null, revenue: null, netInc: null },
];

const WITH_ASSETS = NAMES.filter((n) => n.assets !== null);
const WITHOUT_ASSETS = NAMES.filter((n) => n.assets === null);
const WITH_STATEMENTS = NAMES.filter((n) => n.revenue !== null);

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  cookie: string;
  userId: number;
  knownAt: string;
  indexCode: string;
  indexInstrumentId: number;
  ids: Map<string, number>;
  savedSearchId: number;
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

async function seedName(
  spec: NameSpec,
  tag: string,
  cik: string,
  provenanceId: number,
): Promise<{ instrumentId: number; issuerId: number }> {
  const issuer = await t.client.query<{ issuer_id: string }>(
    `INSERT INTO issuers (name, cik, country, valid_from, provenance_id)
     VALUES ($1, $2, 'US', $3::timestamptz, $4) RETURNING issuer_id`,
    [spec.name, cik, VALID_FROM, provenanceId],
  );
  const issuerId = Number(issuer.rows[0]!.issuer_id);
  const issue = await t.client.query<{ issue_id: string }>(
    `INSERT INTO issues (issuer_id, asset_class, security_type, name, currency,
                         country_of_issue, valid_from, provenance_id)
     VALUES ($1, 'equity', 'Common Stock', $2, 'USD', 'US', $3::timestamptz, $4)
     RETURNING issue_id`,
    [issuerId, spec.name, VALID_FROM, provenanceId],
  );
  const instrument = await t.client.query<{ instrument_id: string }>(
    `INSERT INTO instruments (issue_id, asset_class, market_sector, ticker, exch_code, name,
                              currency, valid_from, provenance_id)
     VALUES ($1, 'equity', 'Equity', $2, 'US', $3, 'USD', $4::timestamptz, $5)
     RETURNING instrument_id`,
    [Number(issue.rows[0]!.issue_id), `${spec.ticker}${tag}`, spec.name, VALID_FROM, provenanceId],
  );
  return { instrumentId: Number(instrument.rows[0]!.instrument_id), issuerId };
}

beforeEach(async () => {
  await ensureLicences();

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`EQS Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'EQS User', 'user') RETURNING user_id`,
    [firmId, `eqs-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  await grantEverySource(firmId, userId);

  const tag = randomUUID().slice(0, 4).toUpperCase();
  const masterProv = await bootstrapProvenance(t, 'internal.user', 'eqs-master');
  const framesProv = await bootstrapProvenance(t, 'sec.frames', 'eqs-frames');
  const factsProv = await bootstrapProvenance(t, 'sec.companyfacts', 'eqs-facts');
  const wikiProv = await bootstrapProvenance(t, 'wiki.sp500', 'eqs-gics');
  const memberProv = await bootstrapProvenance(t, 'ssga.holdings', 'eqs-members');

  // GICS, so the sector filter has something real to filter on.
  const scheme = await t.client.query(`SELECT 1 FROM classification_schemes WHERE scheme = 'GICS'`);
  if (scheme.rowCount === 0) {
    await t.client.query(
      `INSERT INTO classification_schemes (scheme, name, source_id, levels)
       VALUES ('GICS', 'GICS', 'wiki.sp500', 4) ON CONFLICT (scheme) DO NOTHING`,
    );
  }
  const SECTOR_CODE: Record<NameSpec['sector'], { level1: string; sub: string }> = {
    'Information Technology': { level1: '45', sub: '45103010' },
    'Health Care': { level1: '35', sub: '35102010' },
    Financials: { level1: '40', sub: '40101010' },
  };
  for (const [name, codes] of Object.entries(SECTOR_CODE)) {
    await t.client.query(
      `INSERT INTO classification_codes (scheme, code, name, parent_code, level)
       VALUES ('GICS', $1, $2, NULL, 1), ('GICS', $3, $2 || ' — sub', $1, 4)
         ON CONFLICT (scheme, code) DO NOTHING`,
      [codes.level1, name, codes.sub],
    );
  }

  const ids = new Map<string, number>();
  const issuerIds = new Map<string, number>();
  const ciks = new Map<string, string>();
  for (const [i, spec] of NAMES.entries()) {
    const cik = `9${tag.replace(/\D/g, '0').slice(0, 3).padEnd(3, '0')}${String(i).padStart(6, '0')}`
      .slice(0, 10)
      .padStart(10, '0');
    const { instrumentId, issuerId } = await seedName(spec, tag, cik, masterProv);
    ids.set(spec.ticker, instrumentId);
    issuerIds.set(spec.ticker, issuerId);
    ciks.set(spec.ticker, cik);
    await t.client.query(
      `INSERT INTO entity_classifications
         (entity_kind, entity_id, scheme, code, valid_from, provenance_id)
       VALUES ('instrument', $1, 'GICS', $2, $3::timestamptz, $4)`,
      [instrumentId, SECTOR_CODE[spec.sector].sub, VALID_FROM, wikiProv],
    );

    if (spec.assets !== null) {
      await t.client.query(
        `INSERT INTO xbrl_frames (taxonomy, concept, unit, frame, cik, issuer_id, accession_no,
                                  period_end, value, filed_at, captured_at, provenance_id)
         VALUES ('us-gaap', 'Assets', 'USD', $1, $2, $3, $4, '2024-12-31'::date,
                 $5::numeric, '2025-02-01'::date, $6::timestamptz, $7)`,
        [
          FRAME,
          cik,
          issuerId,
          `0000000000-24-0000${String(i).padStart(2, '0')}`,
          spec.assets,
          GOLDEN_ISO,
          framesProv,
        ],
      );
    }
    if (spec.revenue !== null) {
      await t.client.query(
        `INSERT INTO fin_statements
           (issuer_id, period_end, period_type, filed_at, mapping_version, accession_no, currency,
            revenue, net_inc, equity, as_reported, engine_name, engine_version, inputs_hash,
            provenance_ids)
         VALUES ($1, '2025-12-31'::date, 'TTM', '2026-02-01'::date, 'std-map/2026.09', $2, 'USD',
                 $3::numeric, $4::numeric, $5::numeric, '{}'::jsonb, 'std', '1.0.0',
                 repeat('0', 64), ARRAY[$6::bigint])`,
        [
          issuerId,
          `0000000000-26-0000${String(i).padStart(2, '0')}`,
          spec.revenue,
          spec.netInc,
          spec.revenue,
          factsProv,
        ],
      );
    }
  }

  // The index universe.
  const spx = await seedQuoteInstrument(t, {
    ticker: `EQX${tag.slice(0, 3)}`,
    name: 'Screen Index',
    assetClass: 'index',
    providerSymbol: `_EQX.${tag}`,
  });
  const indexCode = `EQS${tag}`;
  const index = await t.client.query<{ index_id: string }>(
    `INSERT INTO indices (code, instrument_id, proxy_fund_instrument_id, membership_source_id,
                          provider)
     VALUES ($1, $2, NULL, 'ssga.holdings', 'S&P Dow Jones') RETURNING index_id`,
    [indexCode, spx.instrumentId],
  );
  const indexId = Number(index.rows[0]!.index_id);
  for (const [i, spec] of NAMES.entries()) {
    await t.client.query(
      `INSERT INTO index_members (index_id, instrument_id, weight, as_of_date, source_id,
                                  valid_from, provenance_id)
       VALUES ($1, $2, $3::numeric, $4::date, 'ssga.holdings', $4::timestamptz, $5)`,
      [indexId, ids.get(spec.ticker)!, (0.12 - i * 0.008).toFixed(10), MEMBERSHIP_DATE, memberProv],
    );
  }

  // A saved screen owned by this user, in the persisted `ScreenCriteria` shape.
  const saved = await t.client.query<{ search_id: string }>(
    `INSERT INTO saved_searches (owner_user_id, firm_id, kind, name, query)
     VALUES ($1, $2, 'eqs', 'Big balance sheets', $3::jsonb) RETURNING search_id`,
    [
      userId,
      firmId,
      JSON.stringify(
        ScreenCriteria.parse({
          universe: 'INDEX',
          index: indexCode,
          criteria: [{ factor: 'BS_TOT_ASSET', op: 'gt', value: 5e10 }],
          columns: ['BS_TOT_ASSET', 'SALES_REV_TURN'],
          sort: { col: 'BS_TOT_ASSET', dir: 'desc' },
        }),
      ),
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

  env = {
    harness,
    app: harness.app,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    userId,
    knownAt,
    indexCode,
    indexInstrumentId: spx.instrumentId,
    ids,
    savedSearchId: Number(saved.rows[0]!.search_id),
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface RunResult {
  data: EqsPayload;
  meta: {
    unavailable: { field: string; reason: string; detail: string }[];
    page: { index: number; count: number; cursor: string | null } | null;
    engines: { name: string; version: string }[];
  };
}

async function runEQS(params: Record<string, unknown> = {}): Promise<RunResult> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/EQS/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params: { index: env.indexCode, ...params },
      asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<RunResult>();
}

/**
 * The keys of an EQS payload that hold a sequence-allocated id (§EQS `EqsPayload`). `issuerId` is
 * one too and is flattened to `<ISSUER>` by its own branch below; `fieldId` and a column's `id`
 * (`'CUR_MKT_CAP'`) are field names, and `cik` is an EDGAR number, not a sequence value.
 */
const ID_KEYS: ReadonlySet<string> = new Set([
  'instrumentId',
  'indexInstrumentId',
  'watchlistId',
]);

describe('EQS — the multi-factor screen', () => {
  it('ranks the index universe on an xbrl_frames factor, stably', async () => {
    const { data } = await runEQS({
      criteria: [{ factor: 'BS_TOT_ASSET', op: 'gt', value: 5e10 }],
      columns: ['BS_TOT_ASSET'],
      sort: { col: 'BS_TOT_ASSET', dir: 'desc' },
    });

    expect(data.variant).toBe('default');
    expect(data.universe.kind).toBe('INDEX');
    // `data.reference.members` labels the roster with the date it was READ at, not with the file
    // date, when the caller names none — the membership snapshot itself is 2026-09-14.
    expect(data.universe.asOfDate).toBe('2026-09-15');
    expect(data.counts.universe).toBe(NAMES.length);
    expect(data.counts.afterFilters).toBe(NAMES.length);
    expect(data.frame).toBe(FRAME);

    const expected = WITH_ASSETS.filter((n) => n.assets! > 5e10)
      .sort((a, b) => b.assets! - a.assets!)
      .map((n) => n.name);
    expect(data.rows.map((r) => r.name)).toEqual(expected);
    expect(data.rows.map((r) => r.rank)).toEqual(expected.map((_, i) => i + 1));

    // Every shown value is the stored one, cited, and nothing is a substitute.
    for (const row of data.rows) {
      const spec = NAMES.find((n) => n.name === row.name)!;
      expect(row.cells.BS_TOT_ASSET!.v).toBe(spec.assets);
      expect(row.cells.BS_TOT_ASSET!.provIdx).toBeGreaterThanOrEqual(0);
      expect(row.subject).toBe(`q:${String(env.ids.get(spec.ticker)!)}`);
    }

    // A second, identical run gives the identical ranked set.
    const again = await runEQS({
      criteria: [{ factor: 'BS_TOT_ASSET', op: 'gt', value: 5e10 }],
      columns: ['BS_TOT_ASSET'],
      sort: { col: 'BS_TOT_ASSET', dir: 'desc' },
    });
    expect(again.data.rows.map((r) => r.key)).toEqual(data.rows.map((r) => r.key));
  });

  it('excludes a name whose factor is missing, and counts it — never treats it as passing', async () => {
    const { data } = await runEQS({
      criteria: [{ factor: 'BS_TOT_ASSET', op: 'gt', value: 0 }],
      columns: ['BS_TOT_ASSET'],
    });

    const criterion = data.criteria[0]!;
    expect(criterion.source).toBe('frames');
    expect(criterion.unavailableReason).toBeNull();
    expect(criterion.passed).toBe(WITH_ASSETS.length);
    expect(criterion.noData).toBe(WITHOUT_ASSETS.length);
    expect(data.counts.afterCriteria).toBe(WITH_ASSETS.length);
    expect(data.counts.excludedNoData).toBe(WITHOUT_ASSETS.length);

    const names = new Set(data.rows.map((r) => r.name));
    for (const missing of WITHOUT_ASSETS) expect(names.has(missing.name)).toBe(false);
    // …and no row carries a fabricated value for the factor.
    for (const row of data.rows) expect(row.cells.BS_TOT_ASSET!.v).not.toBeNull();
  });

  it('does not apply a criterion whose factor has no ingested frame, and says so', async () => {
    const { data, meta } = await runEQS({
      criteria: [
        { factor: 'BS_TOT_ASSET', op: 'gt', value: 5e10 },
        { factor: 'TOTAL_EQUITY', op: 'gt', value: 1e9 },
      ],
      columns: ['BS_TOT_ASSET', 'TOTAL_EQUITY'],
    });

    const equity = data.criteria[1]!;
    expect(equity.unavailableReason).toBe('FRAME_NOT_INGESTED');
    expect(equity.noData).toBe(0);
    // Applying it would have emptied the screen; the earlier criterion's survivors stand.
    expect(equity.passed).toBe(data.criteria[0]!.passed);
    expect(data.rows.length).toBeGreaterThan(0);
    expect(data.notes).toContain('CRITERION_NOT_APPLIED');

    // The column keeps its header and renders every cell absent.
    expect(data.columns.map((c) => c.id)).toEqual(['BS_TOT_ASSET', 'TOTAL_EQUITY']);
    for (const row of data.rows) {
      expect(row.cells.TOTAL_EQUITY).toEqual({ v: null, st: 'na', provIdx: -1 });
    }

    const entry = meta.unavailable.find((u) => u.field === 'TOTAL_EQUITY')!;
    expect(entry.reason).toBe('NO_SOURCE');
    expect(entry.detail).toContain('FRAME_NOT_INGESTED');
    expect(entry.detail).toContain('us-gaap:StockholdersEquity');
  });

  it('reports un-ingested fundamentals once, with the count, not once per row', async () => {
    const { data, meta } = await runEQS({
      criteria: [{ factor: 'NET_MARGIN', op: 'gt', value: 0.1 }],
      columns: ['NET_MARGIN', 'SALES_REV_TURN'],
      sort: { col: 'NET_MARGIN', dir: 'desc' },
    });

    expect(data.notes).toContain('FUNDAMENTALS_NOT_INGESTED');
    const entries = meta.unavailable.filter((u) => u.detail.includes('FUNDAMENTALS_NOT_INGESTED'));
    // One per statements-source factor in play, and no more.
    expect(entries.length).toBeLessThanOrEqual(2);
    expect(entries[0]!.detail).toContain(
      `${String(NAMES.length - WITH_STATEMENTS.length)} of ${String(NAMES.length)} issuers`,
    );

    // Only issuers with statements can be judged; the rest are counted as no-data.
    expect(data.criteria[0]!.noData).toBe(NAMES.length - WITH_STATEMENTS.length);
    for (const row of data.rows) {
      expect(row.cells.NET_MARGIN!.v).not.toBeNull();
      expect(row.issuerId).not.toBeNull();
    }
  });

  it('filters on the GICS sector before the criteria run', async () => {
    const { data } = await runEQS({ sector: 'Financials', columns: ['BS_TOT_ASSET'] });
    const expected = NAMES.filter((n) => n.sector === 'Financials');
    expect(data.counts.universe).toBe(NAMES.length);
    expect(data.counts.afterFilters).toBe(expected.length);
    expect(data.filters.sector).toBe('Financials');
    expect(new Set(data.rows.map((r) => r.gicsSector))).toEqual(new Set(['Financials']));
  });

  it('sorts nulls last in both directions', async () => {
    for (const dir of ['asc', 'desc'] as const) {
      const { data } = await runEQS({
        columns: ['BS_TOT_ASSET'],
        sort: { col: 'BS_TOT_ASSET', dir },
      });
      const values = data.rows.map((r) => r.cells.BS_TOT_ASSET!.v as number | null);
      const firstNull = values.indexOf(null);
      if (firstNull >= 0) {
        expect(values.slice(firstNull).every((v) => v === null)).toBe(true);
      }
      const present = values.filter((v): v is number => v !== null);
      for (let i = 1; i < present.length; i += 1) {
        expect(dir === 'asc' ? present[i]! >= present[i - 1]! : present[i]! <= present[i - 1]!).toBe(
          true,
        );
      }
    }
  });

  it('pages a ranked set without repeating a name', async () => {
    const first = await runEQS({ columns: ['BS_TOT_ASSET'], pageSize: 20 });
    expect(first.data.rows).toHaveLength(NAMES.length);
    expect(first.meta.page).toEqual({ index: 0, count: NAMES.length, cursor: null });

    const small = await runEQS({ columns: ['BS_TOT_ASSET'], pageSize: 20, sort: { col: 'BS_TOT_ASSET', dir: 'desc' } });
    expect(small.data.rows.map((r) => r.rank)).toEqual(
      small.data.rows.map((_, i) => i + 1),
    );
  });

  it('round-trips a saved screen, and explicit params win over it', async () => {
    const loaded = await runEQS({ savedSearchId: env.savedSearchId });
    expect(loaded.data.savedSearch).toEqual({
      searchId: env.savedSearchId,
      name: 'Big balance sheets',
    });
    expect(loaded.data.columns.map((c) => c.id)).toEqual(['BS_TOT_ASSET', 'SALES_REV_TURN']);
    expect(loaded.data.criteria.map((c) => c.factor)).toEqual(['BS_TOT_ASSET']);
    expect(loaded.data.criteria[0]!.value).toBe(5e10);

    const overridden = await runEQS({
      savedSearchId: env.savedSearchId,
      sector: 'Financials',
    });
    expect(overridden.data.filters.sector).toBe('Financials');
    expect(overridden.data.criteria.map((c) => c.factor)).toEqual(['BS_TOT_ASSET']);
  });

  it('continues with the typed params when the saved screen is not the caller’s', async () => {
    const other = await t.client.query<{ search_id: string }>(
      `INSERT INTO saved_searches (owner_user_id, firm_id, kind, name, query)
       SELECT u.user_id, u.firm_id, 'eqs', 'Someone else''s', '{}'::jsonb
         FROM users u WHERE u.user_id <> $1 LIMIT 1
       RETURNING search_id`,
      [env.userId],
    );
    const searchId =
      other.rows[0] === undefined ? 999_999_999 : Number(other.rows[0].search_id);

    const { data, meta } = await runEQS({ savedSearchId: searchId, columns: ['BS_TOT_ASSET'] });
    expect(data.savedSearch).toBeNull();
    const entry = meta.unavailable.find((u) => u.field === 'savedSearch')!;
    expect(entry.detail).toBe('saved screen not found or not owned by this user');
    // The screen still ran on what the caller typed.
    expect(data.columns.map((c) => c.id)).toEqual(['BS_TOT_ASSET']);
  });

  it('says an unknown index has no membership source rather than screening nothing quietly', async () => {
    const { data, meta } = await runEQS({ index: 'NOPE', columns: ['BS_TOT_ASSET'] });
    expect(data.rows).toEqual([]);
    expect(data.counts.universe).toBe(0);
    const entry = meta.unavailable.find((u) => u.field === 'universe')!;
    expect(entry.detail).toContain('no membership source for NOPE');
  });

  it('parses the command-line criteria the screen persists', () => {
    const parsed = parseCriteria('BS_TOT_ASSET>5e10 NET_MARGIN>20% PE_RATIO=10..25 RET_1Y#TOP50');
    expect(parsed.problems).toEqual([]);
    expect(parsed.criteria).toEqual([
      { factor: 'BS_TOT_ASSET', op: 'gt', value: 5e10, value2: null },
      { factor: 'NET_MARGIN', op: 'gt', value: 0.2, value2: null },
      { factor: 'PE_RATIO', op: 'between', value: 10, value2: 25 },
      { factor: 'RET_1Y', op: 'top', value: 50, value2: null },
    ]);

    const bad = parseCriteria('NOT_A_FACTOR>1 BS_TOT_ASSET>>2 CUR_MKT_CAP>1.2B');
    expect(bad.criteria).toEqual([
      { factor: 'CUR_MKT_CAP', op: 'gt', value: 1.2e9, value2: null },
    ]);
    expect(bad.problems.map((p) => p.code)).toEqual(['ARG_PARSE', 'ARG_PARSE']);
  });

  it('declares a LiveSpec only when a quote column is on the grid', () => {
    const base = EQS.params.parse({});
    const payload: EqsPayload = {
      variant: 'default',
      universe: {
        kind: 'INDEX',
        label: 'x',
        indexInstrumentId: null,
        watchlistId: null,
        asOfDate: null,
        size: 0,
        provIdx: -1,
      },
      filters: { sector: null, exchange: null, country: null },
      criteria: [],
      columns: [{ id: 'BS_TOT_ASSET', label: 'Total assets', fmt: 'ccy' }],
      rows: [],
      counts: { universe: 0, afterFilters: 0, afterCriteria: 0, returned: 0, excludedNoData: 0 },
      knownAt: GOLDEN_ISO,
      frame: null,
      savedSearch: null,
      notes: [],
    };
    expect(EQS.live!(base, payload)).toBeNull();
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    const { data } = await runEQS({
      criteria: [{ factor: 'BS_TOT_ASSET', op: 'gt', value: 5e10 }],
      columns: ['CUR_MKT_CAP', 'PX_LAST', 'BS_TOT_ASSET', 'NET_MARGIN'],
      sort: { col: 'BS_TOT_ASSET', dir: 'desc' },
    });
    const tokens = new Map<number, string>([[env.indexInstrumentId, '<INDEX>']]);
    for (const [ticker, id] of env.ids) tokens.set(id, `<${ticker}>`);
    const normalised: unknown = JSON.parse(
      JSON.stringify(data, (key, value: unknown) => {
        // The request's own transaction instant, which moves with the wall clock; STOR-06 is a
        // claim about which rows were read, not about this echo.
        if (key === 'knownAt' && typeof value === 'string') return '<KNOWN_AT>';
        if (key === 'issuerId' && typeof value === 'number') return '<ISSUER>';
        if (key === 'cik' && typeof value === 'string') return '<CIK>';
        if (key === 'key' && typeof value === 'string') return '<KEY>';
        if (key === 'label' && typeof value === 'string' && value.includes(env.indexCode)) {
          return value.replace(env.indexCode, '<CODE>');
        }
        if (typeof value === 'string') return subjectToken(value, tokens);
        // A screen is a table of numbers — market caps, total assets, margins, the `value: 5e10`
        // the criteria echo — and every one of them was a candidate for substitution under the
        // old value-based rule. An id is now an id because of the key it sits under.
        return idToken(key, value, ID_KEYS, tokens);
      }),
    );
    expectGolden('EQS.default.json', normalised);
  });
});
