/**
 * `test/integration/functions/EE.test.ts` — WP-10's acceptance row for `EE`
 * ("actuals history + next expected date; estimate columns carry `NO_SOURCE` with a reason
 * string").
 *
 * The second half is the one this file exists for. Every other earnings screen in the world is
 * mostly estimates; this wedge has no estimates provider, so `estimate` and `surprisePct` are
 * `null` on every row and `meta.unavailable` carries `NO_ESTIMATES_SOURCE` with a sentence a user
 * can read. The assertions below check all three parts of that — the null, the entry, and the
 * *detail* — because a column that is blank without a reason is the failure NEWS-08 and
 * FUNCTIONS.md §1.3 rule 6 exist to prevent, and a blank column looks identical either way.
 *
 * The first half is measured, not guessed: quarters come from `fin_statements` point-in-time on
 * `filed_at`, the pre/post-market flag from the 8-K item 2.02 acceptance instant in Eastern Time,
 * and the next expected date from the median gap between the issuer's own periodic filings. The
 * projection's `method`, `basis` and `confidence` are asserted, so the payload says what kind of
 * number it is.
 *
 * ## No seed
 *
 * WP-15 owns the seed and it does not exist: every row here is created inside this file's own
 * `withTxDb()` transaction, and no assertion depends on a literal instrument id.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden, idToken } from './golden.js';

import { FunctionRegistry } from '@terminal/core';
import { EE } from '@terminal/core/functions/manifests/EE';
import type { EePayload } from '@terminal/core/functions/manifests/EE';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import * as EeModule from '../../../src/functions/EE/resolve.js';
import { projectNextReport, reportTimingOf } from '../../../src/functions/EE/resolve.js';
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

const REGISTRY = new FunctionRegistry([EE]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { EE: EeModule };

const t: TestDb = withTxDb();

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  issuerId: number;
  aaplId: number;
  prov: Map<string, number>;
}

let env: Env;

/** One quarter: the statement, its 10-Q and — when the issuer filed one — the 8-K that released it. */
interface QuarterSpec {
  periodEnd: string;
  filedAt: string;
  fiscalYear: number;
  fiscalPeriod: string;
  accessionNo: string;
  revenue: number;
  netInc: number;
  epsDil: number;
  /** `accepted_at` of the 8-K carrying item 2.02, or `null` when none was filed. */
  release: { filedDate: string; acceptedAt: string; accessionNo: string } | null;
}

/**
 * Eight quarters, filed roughly ninety-one days apart — enough gaps for the cadence projection to
 * be a median rather than a fallback, which is the distinction `next.method` reports.
 */
const QUARTERS: QuarterSpec[] = [
  {
    periodEnd: '2024-09-28',
    filedAt: '2024-11-01',
    fiscalYear: 2024,
    fiscalPeriod: 'Q4',
    accessionNo: '0000320193-24-000123',
    revenue: 94_930_000_000,
    netInc: 14_736_000_000,
    epsDil: 0.97,
    release: null,
  },
  {
    periodEnd: '2024-12-28',
    filedAt: '2025-01-31',
    fiscalYear: 2025,
    fiscalPeriod: 'Q1',
    accessionNo: '0000320193-25-000008',
    revenue: 124_300_000_000,
    netInc: 36_330_000_000,
    epsDil: 2.4,
    release: null,
  },
  {
    periodEnd: '2025-03-29',
    filedAt: '2025-05-02',
    fiscalYear: 2025,
    fiscalPeriod: 'Q2',
    accessionNo: '0000320193-25-000042',
    revenue: 95_359_000_000,
    netInc: 24_780_000_000,
    epsDil: 1.65,
    release: null,
  },
  {
    periodEnd: '2025-06-28',
    filedAt: '2025-08-01',
    fiscalYear: 2025,
    fiscalPeriod: 'Q3',
    accessionNo: '0000320193-25-000071',
    revenue: 85_777_000_000,
    netInc: 21_448_000_000,
    epsDil: 1.42,
    release: null,
  },
  {
    periodEnd: '2025-09-27',
    filedAt: '2025-10-31',
    fiscalYear: 2025,
    fiscalPeriod: 'Q4',
    accessionNo: '0000320193-25-000101',
    revenue: 100_095_000_000,
    netInc: 18_682_000_000,
    epsDil: 1.24,
    release: null,
  },
  {
    // No 8-K item 2.02 is stored for this quarter: `TIMING_UNKNOWN`, never a guessed session.
    periodEnd: '2025-12-27',
    filedAt: '2026-02-01',
    fiscalYear: 2026,
    fiscalPeriod: 'Q1',
    accessionNo: '0000320193-26-000010',
    revenue: 128_411_000_000,
    netInc: 37_180_000_000,
    epsDil: 2.44,
    release: null,
  },
  {
    // Accepted 12:05Z = 08:05 ET, before the open.
    periodEnd: '2026-03-28',
    filedAt: '2026-05-02',
    fiscalYear: 2026,
    fiscalPeriod: 'Q2',
    accessionNo: '0000320193-26-000031',
    revenue: 95_359_000_000,
    netInc: 24_780_000_000,
    epsDil: 1.63,
    release: {
      filedDate: '2026-04-30',
      acceptedAt: '2026-04-30T12:05:00Z',
      accessionNo: '0000320193-26-000029',
    },
  },
  {
    // Accepted 20:31Z = 16:31 ET, after the close.
    periodEnd: '2026-06-27',
    filedAt: '2026-08-01',
    fiscalYear: 2026,
    fiscalPeriod: 'Q3',
    accessionNo: '0000320193-26-000055',
    revenue: 89_204_000_000,
    netInc: 22_960_000_000,
    epsDil: 1.51,
    release: {
      filedDate: '2026-07-30',
      acceptedAt: '2026-07-30T20:31:00Z',
      accessionNo: '0000320193-26-000053',
    },
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
  const key = `ee-${sourceId}-${randomUUID()}`;
  const res = await t.client.query<{ provenance_id: string }>(
    `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                             http_status, bytes, captured_at, source_ts, adapter_version)
     VALUES ($1,$2,'test://ee/' || $2, digest($2,'sha256'), digest($2,'sha256'), 200, 0, $3, $3,
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

async function seedStatement(q: QuarterSpec): Promise<void> {
  const prov = await provenanceFor('sec.companyfacts');
  await t.client.query(
    `INSERT INTO fin_statements
       (issuer_id, period_end, period_type, filed_at, mapping_version, fiscal_year, fiscal_period,
        accession_no, currency, revenue, net_inc, eps_basic, eps_dil, shares_dil, derived_q4,
        as_reported, engine_name, engine_version, inputs_hash, provenance_ids)
     VALUES ($1,$2::date,'Q',$3::date,'std-map/2026.09',$4,$5,$6::char(20),'USD',$7,$8,$9,$10,
             15200000000,false,'{}'::jsonb,'fundamentals/std-map','std-map/2026.09',
             repeat('a',64),ARRAY[$11::bigint])`,
    [
      env.issuerId,
      q.periodEnd,
      q.filedAt,
      q.fiscalYear,
      q.fiscalPeriod,
      q.accessionNo,
      q.revenue,
      q.netInc,
      q.epsDil + 0.02,
      q.epsDil,
      prov,
    ],
  );
}

async function seedFiling(spec: {
  accessionNo: string;
  form: string;
  filedDate: string;
  acceptedAt: string;
  reportDate: string | null;
  items: string;
}): Promise<void> {
  const prov = await provenanceFor('sec.submissions');
  const url =
    `https://www.sec.gov/Archives/edgar/data/320193/${spec.accessionNo.replace(/-/g, '')}/` +
    `${spec.accessionNo}-index.htm`;
  await t.client.query(
    `INSERT INTO filings (accession_no, cik, issuer_id, form, filed_date, accepted_at, report_date,
                          items, primary_doc, primary_doc_desc, is_xbrl, is_inline_xbrl, size_bytes,
                          url, captured_at, provenance_id)
     VALUES ($1::char(20),$2,$3::bigint,$4,$5::date,$6::timestamptz,$7::date,$8::text[],
             'primary.htm',$9,true,true,4821004,$10,$11::timestamptz,$12)`,
    [
      spec.accessionNo,
      CIK,
      env.issuerId,
      spec.form,
      spec.filedDate,
      spec.acceptedAt,
      spec.reportDate,
      spec.items,
      `${spec.form} filing`,
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
    [`EE Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1,$2,'EE User','user') RETURNING user_id`,
    [firmId, `ee-${randomUUID()}@demo.invalid`],
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
    prov: new Map(),
  };

  const secProv = await provenanceFor('sec.submissions');
  env.issuerId = await nextId('issuer_id_seq');
  await t.client.query(
    `INSERT INTO issuers (issuer_id, name, cik, country, sic, entity_type, fiscal_year_end,
                          valid_from, tx_from, provenance_id)
     VALUES ($1,'Apple Inc',$2,'US','3571','operating','0926',$3::timestamptz,$3::timestamptz,$4)`,
    [env.issuerId, CIK, VALID_FROM, secProv],
  );

  const figiProv = await provenanceFor('openfigi.mapping');
  const issueId = await nextId('issue_id_seq');
  env.aaplId = await nextId('instrument_id_seq');
  await t.client.query(
    `INSERT INTO issues (issue_id, issuer_id, asset_class, security_type, name, currency,
                         country_of_issue, valid_from, tx_from, provenance_id)
     VALUES ($1,$2,'equity'::asset_class,'Common Stock','Apple Inc','USD','US',
             $3::timestamptz,$3::timestamptz,$4)`,
    [issueId, env.issuerId, VALID_FROM, figiProv],
  );
  await t.client.query(
    `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                              exch_code, name, currency, status, search_weight, price_decimals,
                              valid_from, tx_from, provenance_id)
     VALUES ($1,$2,'equity'::asset_class,'Equity'::market_sector,'AAPL','US','Apple Inc','USD',
             'active',5,2,$3::timestamptz,$3::timestamptz,$4)`,
    [env.aaplId, issueId, VALID_FROM, figiProv],
  );

  for (const q of QUARTERS) {
    await seedStatement(q);
    await seedFiling({
      accessionNo: q.accessionNo,
      form: q.fiscalPeriod === 'Q4' ? '10-K' : '10-Q',
      filedDate: q.filedAt,
      acceptedAt: `${q.filedAt}T21:00:00Z`,
      reportDate: q.periodEnd,
      items: '{}',
    });
    if (q.release !== null) {
      await seedFiling({
        accessionNo: q.release.accessionNo,
        form: '8-K',
        filedDate: q.release.filedDate,
        acceptedAt: q.release.acceptedAt,
        reportDate: null,
        items: '{2.02,9.01}',
      });
    }
  }

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  env.knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();
});

afterEach(async () => {
  await env.harness.close();
});

async function runEE(params: Record<string, unknown> = {}): Promise<{
  data: EePayload;
  meta: { unavailable: { field: string; reason: string; detail: string }[] };
}> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/EE/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params,
      security: { id: env.aaplId },
      asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json();
}

/** The one key in an EE payload that holds a sequence-allocated id: the issuer block's (§EE). */
const ID_KEYS: ReadonlySet<string> = new Set(['issuerId']);

function normalise(payload: EePayload): unknown {
  const knownAt = new Date(env.knownAt).toISOString();
  const tokens = new Map<number, string>([[env.issuerId, '<ISSUER>']]);
  const json = JSON.stringify(payload, (key, value: unknown) => {
    // Matched by key *and* value, where it used to be matched by value alone: a reporting date
    // that happened to equal the read instant is the payload's claim, not this echo of it.
    if (key === 'knownAt' && value === knownAt) return '<KNOWN_AT>';
    // EE is a table of reported actuals — EPS, revenue, the year-over-year and sequential changes
    // computed from them. Under the old value-based rule any of them that collided with
    // `env.issuerId` became `<ISSUER>`, which is the one thing an actuals golden must not allow.
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('EE — reported actuals, and the estimates that do not exist', () => {
  it('lists quarterly actuals newest first with year-over-year and sequential change', async () => {
    const { data } = await runEE();

    expect(data.variant).toBe('equity');
    expect(data.issuer.cik).toBe(CIK);
    expect(data.metric).toBe('EPS_DIL');
    expect(data.unit).toBe('per_share');
    expect(data.history).toHaveLength(QUARTERS.length);

    const newest = data.history[0]!;
    expect(newest.periodEnd).toBe('2026-06-27');
    expect(newest.fiscalYear).toBe(2026);
    expect(newest.fiscalPeriod).toBe('Q3');
    expect(newest.actual).toBe(1.51);
    expect(newest.form).toBe('10-Q');
    expect(newest.accessionNo).toBe('0000320193-26-000055');
    expect(newest.url).toContain('sec.gov');
    expect(newest.provIdx).toBeGreaterThanOrEqual(0);

    // 1.51 against the same fiscal quarter a year earlier (1.42) and against the previous one.
    expect(newest.yoyPct).toBeCloseTo(1.51 / 1.42 - 1, 10);
    expect(newest.qoqPct).toBeCloseTo(1.51 / 1.63 - 1, 10);

    // The oldest row has neither comparison, and says so with a null rather than a zero.
    const oldest = data.history[data.history.length - 1]!;
    expect(oldest.yoyPct).toBeNull();
    expect(oldest.qoqPct).toBeNull();

    // TTM is the sum of the last four quarters, and the sparkline runs oldest → newest.
    expect(data.ttm.value).toBeCloseTo(1.51 + 1.63 + 2.44 + 1.24, 10);
    expect(data.ttm.periodEnd).toBe('2026-06-27');
    expect(data.sparkline).toHaveLength(QUARTERS.length);
    expect(data.sparkline[0]!.v).toBe(0.97);
    expect(data.sparkline[data.sparkline.length - 1]!.v).toBe(1.51);
  });

  it('reads the pre/post-market flag off the 8-K item 2.02 acceptance instant', async () => {
    const { data, meta } = await runEE();
    const byPeriod = new Map(data.history.map((r) => [r.periodEnd, r]));

    // 20:31Z is 16:31 ET — after the close.
    expect(byPeriod.get('2026-06-27')!.reportTiming).toBe('post');
    expect(byPeriod.get('2026-06-27')!.reportedAt).toBe('2026-07-30T20:31:00.000Z');
    // 12:05Z is 08:05 ET — before the open.
    expect(byPeriod.get('2026-03-28')!.reportTiming).toBe('pre');
    // No 8-K stored: unknown, with the reason in meta rather than a guessed session.
    expect(byPeriod.get('2025-12-27')!.reportTiming).toBe('unknown');
    expect(byPeriod.get('2025-12-27')!.reportedAt).toBeNull();
    expect(meta.unavailable.find((u) => u.field === 'reportedAt')!.detail).toContain(
      'TIMING_UNKNOWN',
    );
  });

  it('projects the next report from the filing cadence and says what kind of number it is', async () => {
    const { data } = await runEE();
    const next = data.next!;

    // Seven gaps of 90-93 days: the median is 91, so the projection is 91 days after 2026-08-01.
    expect(next.method).toBe('cadence');
    expect(next.expectedDate).toBe('2026-10-31');
    expect(next.window).toEqual(['2026-10-24', '2026-11-07']);
    expect(next.confidence).toBe(0.6);
    expect(next.basis).toContain('median gap');
    expect(next.basis).toContain('91 d');
  });

  /** The acceptance row: the estimate columns exist, are empty, and say why. */
  it('carries NO_ESTIMATES_SOURCE on every estimate column, with a reason string', async () => {
    const { data, meta } = await runEE();

    for (const row of data.history) {
      expect(row.estimate).toBeNull();
      expect(row.surprisePct).toBeNull();
    }
    expect(data.consensus).toEqual({ value: null, reason: 'NO_ESTIMATES_SOURCE' });

    for (const field of ['EE_EPS_ESTIMATE', 'EE_SURPRISE_PCT']) {
      const note = meta.unavailable.find((u) => u.field === field);
      expect(note, `${field} must be explained`).toBeDefined();
      expect(note!.reason).toBe('NO_SOURCE');
      // Never blank: the detail is what the screen shows in the column's tooltip.
      expect(note!.detail).toContain('NO_ESTIMATES_SOURCE');
      expect(note!.detail).toContain('no consensus-estimates provider');
      expect(note!.detail.length).toBeGreaterThan(20);
    }
    // And nothing anywhere in the payload quietly fills the gap with a zero.
    expect(JSON.stringify(data)).not.toContain('"estimate":0');
  });

  it('switches the metric without changing the shape of the answer', async () => {
    const { data } = await runEE({ metric: 'REVENUE' });
    expect(data.metric).toBe('REVENUE');
    expect(data.unit).toBe('ccy');
    expect(data.history[0]!.actual).toBe(89_204_000_000);
    expect(data.history[0]!.yoyPct).toBeCloseTo(89_204_000_000 / 85_777_000_000 - 1, 10);
    expect(data.history[0]!.estimate).toBeNull();
  });

  it('honours knownAt: a quarter filed after it is not in the history (STOR-06)', async () => {
    const { data } = await runEE({ knownAt: '2026-06-01T00:00:00Z' });
    expect(data.knownAt).toBe('2026-06-01T00:00:00.000Z');
    expect(data.history.map((r) => r.periodEnd)).not.toContain('2026-06-27');
    expect(data.history[0]!.periodEnd).toBe('2026-03-28');
  });

  it('honours the period count', async () => {
    const { data } = await runEE({ periods: 4 });
    expect(data.history).toHaveLength(4);
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    expectGolden('EE.equity.json', normalise((await runEE()).data));
  });
});

describe('EE — the projection and the timing rule, as pure functions', () => {
  it('falls back to the prior year when there are too few gaps to take a median', () => {
    const next = projectNextReport(['2026-05-02', '2025-05-02', '2025-01-31'])!;
    expect(next.method).toBe('prior_year');
    expect(next.confidence).toBe(0.4);
    expect(next.expectedDate).toBe('2026-05-02');
  });

  it('returns null when one filing is all there is: a date is not a cadence', () => {
    expect(projectNextReport(['2026-05-02'])).toBeNull();
    expect(projectNextReport([])).toBeNull();
  });

  it('maps the acceptance instant onto the session in Eastern Time', () => {
    expect(reportTimingOf('2026-07-30T20:31:00Z')).toBe('post'); // 16:31 ET
    expect(reportTimingOf('2026-07-30T12:05:00Z')).toBe('pre'); // 08:05 ET
    expect(reportTimingOf('2026-07-30T17:00:00Z')).toBe('intraday'); // 13:00 ET
    expect(reportTimingOf(null)).toBe('unknown');
    // A January instant is EST, not EDT: 14:00Z is 09:00 ET, still before the open.
    expect(reportTimingOf('2026-01-15T14:00:00Z')).toBe('pre');
  });
});
