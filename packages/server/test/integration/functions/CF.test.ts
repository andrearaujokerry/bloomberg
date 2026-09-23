/**
 * `test/integration/functions/CF.test.ts` — WP-10's `CF` (Company Filings).
 *
 * Four properties, each of which has a way of looking right while being wrong:
 *
 *  1. **The filter.** `group:'CURRENT'` must return 8-K-family forms and nothing else; `items`
 *     must superset-match; `xbrlOnly` must drop a Form 4. Each is asserted against a fixture that
 *     contains rows the filter is supposed to remove — a filter tested only on rows it keeps is
 *     not tested.
 *  2. **`formCounts` is the whole window, not the page.** With `limit: 3` the page holds three
 *     filings and the counts still describe every form the window holds; that is the block the
 *     screen uses to make a filer's form mix visible.
 *  3. **Point-in-time.** `KNOWN=` bounds `accepted_at`, the instant the document became public, so
 *     CF and FA agree about what was knowable on a date (STOR-06).
 *  4. **The three standing gaps** — no full-text search, no stored documents, a recent-only
 *     history — are in `meta.unavailable` on every run with their detail text, because a screen
 *     that silently cannot search is worse than one that says so.
 *
 * ## No seed
 *
 * Every row here is created inside this file's own `withTxDb()` transaction; no assertion depends
 * on a literal instrument id.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden, idToken } from './golden.js';

import { FunctionRegistry } from '@terminal/core';
import { CF } from '@terminal/core/functions/manifests/CF';
import type { CfPayload } from '@terminal/core/functions/manifests/CF';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import * as CfModule from '../../../src/functions/CF/resolve.js';
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

const REGISTRY = new FunctionRegistry([CF]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { CF: CfModule };

const t: TestDb = withTxDb();

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  issuerId: number;
  aaplId: number;
  noCikId: number;
  spyId: number;
  spyCik: string;
  prov: Map<string, number>;
}

let env: Env;

interface FilingSpec {
  accessionNo: string;
  form: string;
  filedDate: string;
  acceptedAt: string;
  reportDate: string | null;
  items: string;
  isXbrl: boolean;
  sizeBytes: number;
}

/**
 * Eleven filings across five form groups, including a Form 4 with no XBRL and an 8-K/A that amends
 * an 8-K with the same report date — the rows the filters are supposed to remove and the pair
 * `amends` is supposed to link.
 */
const FILINGS: FilingSpec[] = [
  {
    accessionNo: '0000320193-26-000061',
    form: '8-K',
    filedDate: '2026-09-01',
    acceptedAt: '2026-09-01T20:31:00Z',
    reportDate: '2026-09-01',
    items: '{8.01}',
    isXbrl: true,
    sizeBytes: 251_004,
  },
  {
    accessionNo: '0000320193-26-000055',
    form: '10-Q',
    filedDate: '2026-08-01',
    acceptedAt: '2026-08-01T20:31:00Z',
    reportDate: '2026-06-27',
    items: '{}',
    isXbrl: true,
    sizeBytes: 4_821_004,
  },
  {
    accessionNo: '0000320193-26-000053',
    form: '8-K/A',
    filedDate: '2026-07-31',
    acceptedAt: '2026-07-31T20:05:00Z',
    reportDate: '2026-07-30',
    items: '{2.02,9.01}',
    isXbrl: true,
    sizeBytes: 190_221,
  },
  {
    accessionNo: '0000320193-26-000052',
    form: '8-K',
    filedDate: '2026-07-30',
    acceptedAt: '2026-07-30T20:31:00Z',
    reportDate: '2026-07-30',
    items: '{2.02,9.01}',
    isXbrl: true,
    sizeBytes: 188_004,
  },
  {
    accessionNo: '0000320193-26-000044',
    form: '4',
    filedDate: '2026-06-03',
    acceptedAt: '2026-06-03T22:10:00Z',
    reportDate: null,
    items: '{}',
    isXbrl: false,
    sizeBytes: 6_112,
  },
  {
    accessionNo: '0000320193-26-000031',
    form: '10-Q',
    filedDate: '2026-05-02',
    acceptedAt: '2026-05-02T20:31:00Z',
    reportDate: '2026-03-28',
    items: '{}',
    isXbrl: true,
    sizeBytes: 4_612_990,
  },
  {
    accessionNo: '0000320193-26-000021',
    form: 'DEF 14A',
    filedDate: '2026-03-09',
    acceptedAt: '2026-03-09T16:02:00Z',
    reportDate: null,
    items: '{}',
    isXbrl: false,
    sizeBytes: 2_002_114,
  },
  {
    accessionNo: '0000320193-26-000010',
    form: '10-Q',
    filedDate: '2026-02-01',
    acceptedAt: '2026-02-01T21:00:00Z',
    reportDate: '2025-12-27',
    items: '{}',
    isXbrl: true,
    sizeBytes: 4_521_331,
  },
  {
    accessionNo: '0000320193-25-000101',
    form: '10-K',
    filedDate: '2025-10-31',
    acceptedAt: '2025-10-31T20:31:00Z',
    reportDate: '2025-09-27',
    items: '{}',
    isXbrl: true,
    sizeBytes: 9_820_441,
  },
  {
    accessionNo: '0000320193-25-000071',
    form: '8-K',
    filedDate: '2025-08-01',
    acceptedAt: '2025-08-01T20:31:00Z',
    reportDate: '2025-07-31',
    items: '{2.02,9.01}',
    isXbrl: true,
    sizeBytes: 181_204,
  },
  {
    accessionNo: '0000320193-25-000008',
    form: '6-K',
    filedDate: '2025-01-31',
    acceptedAt: '2025-01-31T21:15:00Z',
    reportDate: null,
    // An item code EDGAR does not document: `ITEM_LABEL_UNKNOWN`, labelled `Item 9.99`.
    items: '{9.99}',
    isXbrl: false,
    sizeBytes: 44_010,
  },
];

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
  const key = `cf-${sourceId}-${randomUUID()}`;
  const res = await t.client.query<{ provenance_id: string }>(
    `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                             http_status, bytes, captured_at, source_ts, adapter_version)
     VALUES ($1,$2,'test://cf/' || $2, digest($2,'sha256'), digest($2,'sha256'), 200, 0, $3, $3,
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

async function seedEquity(spec: {
  ticker: string;
  name: string;
  issuerId: number;
  assetClass?: 'equity' | 'etf';
}): Promise<number> {
  const p = await provenanceFor('openfigi.mapping');
  const issueId = await nextId('issue_id_seq');
  const instrumentId = await nextId('instrument_id_seq');
  await t.client.query(
    `INSERT INTO issues (issue_id, issuer_id, asset_class, security_type, name, currency,
                         country_of_issue, valid_from, tx_from, provenance_id)
     VALUES ($1,$2,$3::asset_class,$4,$5,'USD','US',
             $6::timestamptz,$6::timestamptz,$7)`,
    [
      issueId,
      spec.issuerId,
      spec.assetClass ?? 'equity',
      spec.assetClass === 'etf' ? 'ETP' : 'Common Stock',
      spec.name,
      VALID_FROM,
      p,
    ],
  );
  await t.client.query(
    `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                              exch_code, name, currency, status, search_weight, price_decimals,
                              valid_from, tx_from, provenance_id)
     VALUES ($1,$2,$3::asset_class,'Equity'::market_sector,$4,'US',$5,'USD','active',5,2,
             $6::timestamptz,$6::timestamptz,$7)`,
    [
      instrumentId,
      issueId,
      spec.assetClass ?? 'equity',
      spec.ticker,
      spec.name,
      VALID_FROM,
      p,
    ],
  );
  return instrumentId;
}

async function seedFiling(spec: FilingSpec & { cik?: string; issuerId?: number }): Promise<void> {
  const prov = await provenanceFor('sec.submissions');
  const url =
    `https://www.sec.gov/Archives/edgar/data/320193/${spec.accessionNo.replace(/-/g, '')}/` +
    `${spec.accessionNo}-index.htm`;
  await t.client.query(
    `INSERT INTO filings (accession_no, cik, issuer_id, form, filed_date, accepted_at, report_date,
                          items, primary_doc, primary_doc_desc, is_xbrl, is_inline_xbrl, size_bytes,
                          url, captured_at, provenance_id)
     VALUES ($1::char(20),$2,$3::bigint,$4,$5::date,$6::timestamptz,$7::date,$8::text[],
             'primary.htm',$9,$10,$10,$11,$12,$13::timestamptz,$14)`,
    [
      spec.accessionNo,
      spec.cik ?? CIK,
      spec.issuerId ?? env.issuerId,
      spec.form,
      spec.filedDate,
      spec.acceptedAt,
      spec.reportDate,
      spec.items,
      `${spec.form} filing`,
      spec.isXbrl,
      spec.sizeBytes,
      url,
      GOLDEN_ISO,
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
    [`CF Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1,$2,'CF User','user') RETURNING user_id`,
    [firmId, `cf-${randomUUID()}@demo.invalid`],
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
    noCikId: 0,
    spyId: 0,
    spyCik: '0000884394',
    prov: new Map(),
  };

  const secProv = await provenanceFor('sec.submissions');
  env.issuerId = await nextId('issuer_id_seq');
  await t.client.query(
    `INSERT INTO issuers (issuer_id, name, legal_name, cik, country, sic, sic_description,
                          entity_type, fiscal_year_end, filer_category, website, former_names,
                          valid_from, tx_from, provenance_id)
     VALUES ($1,'Apple Inc','Apple Inc.',$2,'US','3571','Electronic Computers','operating','0926',
             'Large accelerated filer','https://www.apple.com',
             '[{"name":"Apple Computer Inc","from":"1977-01-03","to":"2007-01-09"}]'::jsonb,
             $3::timestamptz,$3::timestamptz,$4)`,
    [env.issuerId, CIK, VALID_FROM, secProv],
  );
  env.aaplId = await seedEquity({ ticker: 'AAPL', name: 'Apple Inc', issuerId: env.issuerId });

  // A filer-less issuer: the screen must say why rather than render an empty grid.
  const privateIssuerId = await nextId('issuer_id_seq');
  await t.client.query(
    `INSERT INTO issuers (issuer_id, name, country, entity_type, valid_from, tx_from, provenance_id)
     VALUES ($1,'Privatco Holdings','US','operating',$2::timestamptz,$2::timestamptz,$3)`,
    [privateIssuerId, VALID_FROM, secProv],
  );
  env.noCikId = await seedEquity({
    ticker: 'PRVT',
    name: 'Privatco Holdings',
    issuerId: privateIssuerId,
  });

  for (const filing of FILINGS) await seedFiling(filing);

  // A fund: the trust files N-PORT and N-CEN and no periodic report, and its CIK lives on
  // `fund_terms` because the trust has no issuer row of its own with one.
  const trustIssuerId = await nextId('issuer_id_seq');
  await t.client.query(
    `INSERT INTO issuers (issuer_id, name, country, entity_type, valid_from, tx_from, provenance_id)
     VALUES ($1,'SPDR S&P 500 ETF Trust','US','fund',$2::timestamptz,$2::timestamptz,$3)`,
    [trustIssuerId, VALID_FROM, secProv],
  );
  env.spyId = await seedEquity({
    ticker: 'SPY',
    name: 'SPDR S&P 500 ETF Trust',
    issuerId: trustIssuerId,
    assetClass: 'etf',
  });
  await t.client.query(
    `INSERT INTO fund_terms (instrument_id, fund_type, sponsor, cik, expense_ratio, inception_date,
                             distribution_freq, valid_from, tx_from, provenance_id)
     VALUES ($1,'etf','State Street Global Advisors',$2,0.000945,'1993-01-22','quarterly',
             $3::timestamptz,$3::timestamptz,$4)`,
    [env.spyId, env.spyCik, VALID_FROM, secProv],
  );
  for (const filing of [
    {
      accessionNo: '0000884394-26-000012',
      form: 'NPORT-P',
      filedDate: '2026-08-28',
      acceptedAt: '2026-08-28T16:12:00Z',
      reportDate: '2026-06-30',
      items: '{}',
      isXbrl: true,
      sizeBytes: 1_204_551,
    },
    {
      accessionNo: '0000884394-26-000004',
      form: 'N-CEN',
      filedDate: '2026-03-12',
      acceptedAt: '2026-03-12T15:04:00Z',
      reportDate: '2025-12-31',
      items: '{}',
      isXbrl: false,
      sizeBytes: 302_118,
    },
  ]) {
    await seedFiling({ ...filing, cik: env.spyCik, issuerId: trustIssuerId });
  }

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  env.knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();
});

afterEach(async () => {
  await env.harness.close();
});

interface CfResponse {
  data: CfPayload;
  meta: {
    resultId: string;
    unavailable: { field: string; reason: string; detail: string }[];
    page?: { index: number; count: number; cursor: string | null } | null;
  };
}

async function runCF(
  instrumentId: number,
  params: Record<string, unknown> = {},
): Promise<CfResponse> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/CF/run`,
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

async function pageCF(resultId: string, direction: 'fwd' | 'back'): Promise<CfResponse> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/CF/page`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { resultId, direction },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json();
}

/**
 * The keys of a CF payload that hold a sequence-allocated id (§CF). `sourceId`
 * (`'sec.submissions'`) is a name, not a sequence value.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId', 'issuerId']);

function normalise(payload: CfPayload): unknown {
  const knownAt = new Date(env.knownAt).toISOString();
  const tokens = new Map<number, string>([
    [env.aaplId, '<AAPL>'],
    [env.issuerId, '<ISSUER>'],
  ]);
  const json = JSON.stringify(payload, (key, value: unknown) => {
    // `knownAt` is the request's own transaction instant. Matched by key *and* value, where it
    // used to be matched by value alone: a filing's `filedAt` or `acceptedAt` that happened to
    // equal the read instant is the payload's claim and stays literal.
    if (key === 'knownAt' && value === knownAt) return '<KNOWN_AT>';
    // And an id is an id because of the key it sits under, never because it equals one. A filing
    // index carries counts per form group, and a count that collided with `env.aaplId` used to
    // come back as `<AAPL>`.
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('CF — the filing index, filtered and point-in-time', () => {
  it('lists the filer newest first with the issuer block and the form groups', async () => {
    const { data } = await runCF(env.aaplId);

    expect(data.variant).toBe('issuer');
    expect(data.security.key).toBe('AAPL US Equity');
    expect(data.issuer.cik).toBe(CIK);
    expect(data.issuer.sic).toBe('3571');
    expect(data.issuer.sicDescription).toBe('Electronic Computers');
    expect(data.issuer.filerCategory).toBe('Large accelerated filer');
    expect(data.issuer.formerNames[0]!.name).toBe('Apple Computer Inc');

    expect(data.filings).toHaveLength(FILINGS.length);
    expect(data.filings[0]!.accessionNo).toBe('0000320193-26-000061');
    expect(data.filings[0]!.acceptedAt).toBe('2026-09-01T20:31:00.000Z');
    expect(data.filings[0]!.formGroup).toBe('CURRENT');
    expect(data.filings[0]!.itemLabels).toEqual(['Other Events']);

    // Accepted-at descending, with no duplicates.
    const accepted = data.filings.map((f) => f.acceptedAt ?? '');
    expect([...accepted].sort().reverse()).toEqual(accepted);
    expect(new Set(data.filings.map((f) => f.accessionNo)).size).toBe(FILINGS.length);

    // Every form group is derived from the form, including the ones this fixture has one of.
    const groupOf = new Map(data.filings.map((f) => [f.form, f.formGroup]));
    expect(groupOf.get('10-K')).toBe('PERIODIC');
    expect(groupOf.get('8-K')).toBe('CURRENT');
    expect(groupOf.get('4')).toBe('OWNERSHIP');
    expect(groupOf.get('DEF 14A')).toBe('PROXY');

    // Every row cites the submissions capture it came from.
    for (const filing of data.filings) expect(filing.provIdx).toBeGreaterThanOrEqual(0);
  });

  it('links an amendment to the filing it amends, and only an amendment', async () => {
    const { data } = await runCF(env.aaplId);
    const amendment = data.filings.find((f) => f.form === '8-K/A')!;
    expect(amendment.isAmendment).toBe(true);
    expect(amendment.amends).toBe('0000320193-26-000052');

    const original = data.filings.find((f) => f.accessionNo === '0000320193-26-000052')!;
    expect(original.isAmendment).toBe(false);
    expect(original.amends).toBeNull();
  });

  it('filters by form group, 8-K item and XBRL', async () => {
    const current = await runCF(env.aaplId, { group: 'CURRENT' });
    expect(current.data.filings.map((f) => f.form).sort()).toEqual([
      '6-K',
      '8-K',
      '8-K',
      '8-K',
      '8-K/A',
    ]);
    expect(current.data.filter.forms).toEqual(['8-K', '8-K/A', '6-K']);

    // Superset match: only the releases carrying item 2.02 survive.
    const earnings = await runCF(env.aaplId, { group: 'CURRENT', items: ['2.02'] });
    expect(earnings.data.filings.map((f) => f.accessionNo)).toEqual([
      '0000320193-26-000053',
      '0000320193-26-000052',
      '0000320193-25-000071',
    ]);

    // The Form 4, the proxy and the 6-K carry no XBRL and are dropped.
    const xbrl = await runCF(env.aaplId, { xbrlOnly: true });
    expect(xbrl.data.filings.map((f) => f.form)).not.toContain('4');
    expect(xbrl.data.filings.map((f) => f.form)).not.toContain('DEF 14A');
    expect(xbrl.data.filings.every((f) => f.isXbrl || f.isInlineXbrl)).toBe(true);

    const ownership = await runCF(env.aaplId, { group: 'OWNERSHIP' });
    expect(ownership.data.filings.map((f) => f.form)).toEqual(['4']);
  });

  it('reports items as NOT_APPLICABLE when the selected forms carry none', async () => {
    const { meta } = await runCF(env.aaplId, { group: 'PERIODIC', items: ['2.02'] });
    const note = meta.unavailable.find((u) => u.field === 'items')!;
    expect(note.reason).toBe('NOT_APPLICABLE');
    expect(note.detail).toContain('ITEMS_ONLY_ON_8K');
  });

  it('counts forms over the whole window and names the latest of each kind', async () => {
    const { data } = await runCF(env.aaplId, { limit: 10 });

    // The page is capped at ten; the counts still describe all eleven filings.
    expect(data.filings).toHaveLength(10);
    const total = data.formCounts.reduce((sum, c) => sum + c.count, 0);
    expect(total).toBe(FILINGS.length);
    const counts = new Map(data.formCounts.map((c) => [c.form, c]));
    expect(counts.get('8-K')!.count).toBe(3);
    expect(counts.get('10-Q')!.count).toBe(3);
    expect(counts.get('8-K')!.newest).toBe('2026-09-01');
    expect(counts.get('4')!.formGroup).toBe('OWNERSHIP');
    // Count descending, then form ascending.
    expect(data.formCounts[0]!.count).toBeGreaterThanOrEqual(data.formCounts[1]!.count);

    expect(data.latest.annual!.form).toBe('10-K');
    expect(data.latest.annual!.accessionNo).toBe('0000320193-25-000101');
    expect(data.latest.quarterly!.accessionNo).toBe('0000320193-26-000055');
    expect(data.latest.current8k!.accessionNo).toBe('0000320193-26-000061');
    // An operating company files no N-PORT: null, not an empty object.
    expect(data.latest.fundHoldings).toBeNull();

    expect(data.coverage.countInStore).toBe(FILINGS.length);
    expect(data.coverage.from).toBe('2025-01-31');
    expect(data.coverage.to).toBe('2026-09-01');
  });

  it('declares the three standing gaps on every run, with their detail text', async () => {
    const { data, meta } = await runCF(env.aaplId);

    expect(data.notes).toContain('FILING_FULLTEXT_UNAVAILABLE');
    expect(data.notes).toContain('DOCUMENT_NOT_STORED_LINK_OUT');
    // The fixture's oldest filing is later than the default three-year window start.
    expect(data.coverage.recentOnly).toBe(true);
    expect(data.notes).toContain('HISTORY_LIMITED_RECENT_FILE');

    const fulltext = meta.unavailable.find((u) => u.field === 'q')!;
    expect(fulltext.reason).toBe('NO_SOURCE');
    expect(fulltext.detail).toContain('efts.sec.gov');

    const document = meta.unavailable.find((u) => u.field === 'document')!;
    expect(document.reason).toBe('NOT_LICENSED');
    expect(document.detail).toContain('never stored');

    const coverage = meta.unavailable.find((u) => u.field === 'coverage')!;
    expect(coverage.detail).toContain('HISTORY_LIMITED_RECENT_FILE');
    expect(coverage.detail).toContain('2025-01-31');

    // An item code EDGAR does not document is labelled, and the note says the label is a fallback.
    expect(data.notes).toContain('ITEM_LABEL_UNKNOWN');
    const sixK = data.filings.find((f) => f.form === '6-K')!;
    expect(sixK.itemLabels).toEqual(['Item 9.99']);
  });

  it('omits every filing accepted after knownAt (STOR-06)', async () => {
    const { data } = await runCF(env.aaplId, { knownAt: '2026-02-15T00:00:00Z' });
    expect(data.knownAt).toBe('2026-02-15T00:00:00.000Z');
    expect(data.filings.map((f) => f.accessionNo)).toEqual([
      '0000320193-26-000010',
      '0000320193-25-000101',
      '0000320193-25-000071',
      '0000320193-25-000008',
    ]);
    // The latest block obeys the same bound: the newest 10-Q known in February is the February one.
    expect(data.latest.quarterly!.accessionNo).toBe('0000320193-26-000010');
    expect(data.latest.current8k!.accessionNo).toBe('0000320193-25-000071');
  });

  it('pages through the filings without repeating or skipping one', async () => {
    const first = await runCF(env.aaplId, { limit: 10 });
    expect(first.meta.page!.count).toBe(FILINGS.length);
    expect(first.meta.page!.cursor).not.toBeNull();

    const second = await pageCF(first.meta.resultId, 'fwd');
    expect(second.data.filings.length).toBeGreaterThan(0);

    const firstKeys = first.data.filings.map((f) => f.accessionNo);
    const secondKeys = second.data.filings.map((f) => f.accessionNo);
    expect(firstKeys.some((k) => secondKeys.includes(k))).toBe(false);
    expect([...firstKeys, ...secondKeys].sort()).toEqual(FILINGS.map((f) => f.accessionNo).sort());

    // PAGE FWD means older: every accession on page two is below every accession on page one.
    const oldestOnPageOne = firstKeys[firstKeys.length - 1]!;
    expect(secondKeys.every((k) => k < oldestOnPageOne)).toBe(true);
    // `count` is the whole filtered set on both pages, so the footer does not jump.
    expect(second.meta.page!.count).toBe(FILINGS.length);
  });

  it('says why an issuer with no CIK has no filings instead of showing an empty grid', async () => {
    const { data, meta } = await runCF(env.noCikId);
    expect(data.filings).toEqual([]);
    expect(data.formCounts).toEqual([]);
    expect(data.total).toBe(0);
    expect(data.issuer.cik).toBeNull();
    const note = meta.unavailable.find((u) => u.field === 'filings')!;
    expect(note.reason).toBe('NO_SOURCE');
    expect(note.detail).toContain('no SEC CIK');
  });

  it('serves a fund from the same variant, with its own form mix', async () => {
    const { data } = await runCF(env.spyId);

    // FUNC-02: one variant for both classes — only the forms differ.
    expect(data.variant).toBe('issuer');
    expect(data.security.assetClass).toBe('etf');
    // The trust's CIK comes from `fund_terms`, not from an issuer row.
    expect(data.issuer.cik).toBe(env.spyCik);

    expect(data.filings.map((f) => f.form)).toEqual(['NPORT-P', 'N-CEN']);
    expect(data.formCounts.map((c) => c.formGroup)).toEqual(['FUND', 'FUND']);
    expect(data.latest.fundHoldings!.form).toBe('NPORT-P');
    expect(data.latest.annual).toBeNull();
    expect(data.latest.quarterly).toBeNull();
    expect(data.notes).toContain('PERIODIC_NOT_FILED_FUND');
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    expectGolden('CF.issuer.json', normalise((await runCF(env.aaplId)).data));
  });
});
