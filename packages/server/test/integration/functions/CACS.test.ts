/**
 * `test/integration/functions/CACS.test.ts` — WP-10's acceptance row for `CACS`
 * (WORKPLAN §WP-10: "dividend/split timeline with `estimated → announced → confirmed → paid`
 * states (DATA-08)").
 *
 * DATA-08's ladder is a claim about **what was publicly known, and when**, so the fixture puts one
 * row on each rung and the assertions are about telling them apart:
 *
 *  - `paid` and `confirmed` rows behind the as-of date — history, and the only rows that compose
 *    into `cumulativeAdjFactor`;
 *  - an `announced` row with a future ex-date — a published announcement, above the rule;
 *  - an `estimated` row entered by data operations (`internal.user`), which the default `status`
 *    filter excludes and `ST=ESTIMATED` reveals, because the reachable event feed never publishes
 *    one;
 *  - a `cancelled` row, likewise excluded by default;
 *  - and, distinct from all five, the resolver's **projected** row: `caId: null`, `projected: true`,
 *    `sourceId: 'internal.derived'`, carrying the cadence it was derived from. The test asserts it
 *    is never written back to `corporate_actions`, because a screen that persisted its own guess
 *    would turn an estimate into a record.
 *
 * The other two claims are REF-09 and STOR-06: every `adjFactor` comes from
 * `core/adjust/corporateActions.ts` — the same implementation HP adjusts bars with — and a
 * dividend corrected from 0.25 to 0.26 by a later version reads 0.25 at the earlier `knownAt`.
 *
 * WP-15 owns the seed; every row here is created inside this file's own transaction.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden, idToken, subjectToken } from './golden.js';

import { FunctionRegistry } from '@terminal/core';
import { CACS } from '@terminal/core/functions/manifests/CACS';
import type { CacsIssuerPayload, CacsPayload } from '@terminal/core/functions/manifests/CACS';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as CACSModule from '../../../src/functions/CACS/resolve.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = '2020-01-01T00:00:00.000Z';

/** The as-of date every window in this file is quoted against. */
const TODAY = '2026-09-15';

const REGISTRY = new FunctionRegistry([CACS]);
const MODULES: Record<string, FunctionServerModule<never, never>> = {
  CACS: CACSModule as unknown as FunctionServerModule<never, never>,
};

const t: TestDb = withTxDb();

/**
 * Eight quarterly cash dividends, newest first, each with the unadjusted close of the session
 * before its ex-date so that the engine can produce a factor for it.
 *
 * The gaps are 91 days throughout, which is what the projection's median has to find.
 */
interface DividendSpec {
  exDate: string;
  priorClose: number;
  amount: number;
  status: 'paid' | 'confirmed' | 'announced' | 'estimated' | 'cancelled';
  declaredDate: string;
  recordDate: string;
  payDate: string;
}

const DIVIDENDS: readonly DividendSpec[] = [
  { exDate: '2026-08-07', priorClose: 331.59, amount: 0.26, status: 'confirmed', declaredDate: '2026-07-31', recordDate: '2026-08-10', payDate: '2026-08-13' },
  { exDate: '2026-05-08', priorClose: 312.04, amount: 0.26, status: 'paid', declaredDate: '2026-05-01', recordDate: '2026-05-11', payDate: '2026-05-14' },
  { exDate: '2026-02-06', priorClose: 291.77, amount: 0.25, status: 'paid', declaredDate: '2026-01-30', recordDate: '2026-02-09', payDate: '2026-02-12' },
  { exDate: '2025-11-07', priorClose: 268.31, amount: 0.25, status: 'paid', declaredDate: '2025-10-31', recordDate: '2025-11-10', payDate: '2025-11-13' },
  { exDate: '2025-08-08', priorClose: 245.12, amount: 0.25, status: 'paid', declaredDate: '2025-08-01', recordDate: '2025-08-11', payDate: '2025-08-14' },
  { exDate: '2025-05-09', priorClose: 226.44, amount: 0.24, status: 'paid', declaredDate: '2025-05-02', recordDate: '2025-05-12', payDate: '2025-05-15' },
  { exDate: '2025-02-07', priorClose: 233.28, amount: 0.24, status: 'paid', declaredDate: '2025-01-31', recordDate: '2025-02-10', payDate: '2025-02-13' },
  { exDate: '2024-11-08', priorClose: 226.96, amount: 0.24, status: 'paid', declaredDate: '2024-11-01', recordDate: '2024-11-11', payDate: '2024-11-14' },
];

/** The announced (future), estimated (data-ops) and cancelled rows that complete the ladder. */
const LADDER: readonly DividendSpec[] = [
  { exDate: '2026-10-15', priorClose: 0, amount: 0.27, status: 'announced', declaredDate: '2026-09-11', recordDate: '2026-10-16', payDate: '2026-10-22' },
  // Inside the default forward window (validAt + 90 days = 2026-12-14): a row outside it would
  // be absent for a reason that has nothing to do with its status.
  { exDate: '2026-12-10', priorClose: 0, amount: 0.27, status: 'estimated', declaredDate: '2026-09-01', recordDate: '2026-12-11', payDate: '2026-12-14' },
  { exDate: '2026-06-15', priorClose: 0, amount: 0.26, status: 'cancelled', declaredDate: '2026-06-01', recordDate: '2026-06-16', payDate: '2026-06-19' },
];

const SPLIT = { exDate: '2025-06-09', ratioNew: 4, ratioOld: 1 };

/** The corrected dividend of the point-in-time test: 0.25 until 2026-08-20, 0.26 after it. */
const CORRECTION = {
  exDate: '2026-03-12',
  priorClose: 300.0,
  before: 0.25,
  after: 0.26,
  correctedAt: '2026-08-20T00:00:00.000Z',
};

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  cookie: string;
  knownAt: string;
  instrumentId: number;
  issuerId: number;
  cik: string;
  key: string;
  correctionCaId: number;
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

/** An issuer with a CIK, its issue, the instrument, a primary listing and a yahoo.chart line. */
async function seedSecurity(
  ticker: string,
  cik: string,
  provenanceId: number,
): Promise<{ instrumentId: number; issuerId: number }> {
  const issuer = await t.client.query<{ issuer_id: string }>(
    `INSERT INTO issuers (name, cik, country, valid_from, provenance_id)
     VALUES ('Apple Inc', $1, 'US', $2::timestamptz, $3) RETURNING issuer_id`,
    [cik, VALID_FROM, provenanceId],
  );
  const issuerId = Number(issuer.rows[0]!.issuer_id);
  const issue = await t.client.query<{ issue_id: string }>(
    `INSERT INTO issues (issuer_id, asset_class, security_type, name, currency,
                         country_of_issue, valid_from, provenance_id)
     VALUES ($1, 'equity', 'Common Stock', 'Apple Inc', 'USD', 'US', $2::timestamptz, $3)
     RETURNING issue_id`,
    [issuerId, VALID_FROM, provenanceId],
  );
  const issueId = Number(issue.rows[0]!.issue_id);
  const instrument = await t.client.query<{ instrument_id: string }>(
    `INSERT INTO instruments (issue_id, asset_class, market_sector, ticker, exch_code, name,
                              currency, valid_from, provenance_id)
     VALUES ($1, 'equity', 'Equity', $2, 'US', 'Apple Inc', 'USD', $3::timestamptz, $4)
     RETURNING instrument_id`,
    [issueId, ticker, VALID_FROM, provenanceId],
  );
  const instrumentId = Number(instrument.rows[0]!.instrument_id);
  // `primary_listing_id` is deliberately left unset: `bt_guard_update` makes a bitemporal row
  // immutable, so it would have to be pre-allocated from the sequence — and nothing CACS reads
  // needs it.
  const listing = await t.client.query<{ listing_id: string }>(
    `INSERT INTO listings (instrument_id, mic, exch_code, local_ticker, is_primary,
                           valid_from, provenance_id)
     VALUES ($1, 'XNAS', 'UW', $2, true, $3::timestamptz, $4) RETURNING listing_id`,
    [instrumentId, ticker, VALID_FROM, provenanceId],
  );
  await t.client.query(
    `INSERT INTO md_lines (instrument_id, listing_id, source_id, provider_symbol, line_kind,
                           intrinsic_delay_min, expected_interval_ms, priority,
                           valid_from, provenance_id)
     VALUES ($1, $2, 'yahoo.chart', $3, 'composite', 15, 86400000, 20, $4::timestamptz, $5)`,
    [instrumentId, Number(listing.rows[0]!.listing_id), `${ticker}.chart`, VALID_FROM, provenanceId],
  );
  return { instrumentId, issuerId };
}

async function insertClose(
  instrumentId: number,
  date: string,
  close: number,
  provenanceId: number,
): Promise<void> {
  await t.client.query(
    `INSERT INTO bars_daily (instrument_id, session_date, md_line_id, close, capture_ts,
                             provenance_id)
     SELECT $1, $2::date, l.md_line_id, $3::numeric, $4::timestamptz, $5
       FROM md_lines l
      WHERE l.instrument_id = $1 AND l.tx_to = 'infinity'
      LIMIT 1
     ON CONFLICT (instrument_id, session_date) DO NOTHING`,
    [instrumentId, date, close, GOLDEN_ISO, provenanceId],
  );
}

async function insertAction(args: {
  instrumentId: number;
  caType: string;
  status: string;
  exDate: string;
  amount?: number | null;
  currency?: string | null;
  ratioNew?: number | null;
  ratioOld?: number | null;
  declaredDate?: string | null;
  recordDate?: string | null;
  payDate?: string | null;
  frequency?: string | null;
  sourceId: string;
  reviewState?: string;
  provenanceId: number;
  caId?: number;
  txFrom?: string;
  txTo?: string;
}): Promise<number> {
  // `valid_from` is the declaration, not the ex-date: an action announced on 11 September with an
  // ex-date in October is TRUE from the announcement, and a row whose validity started at its
  // ex-date would be invisible to `bt_as_of` at today's `validAt` — the upcoming block would be
  // empty on a screen whose whole point is to show what is coming.
  const caId =
    args.caId ??
    Number(
      (await t.client.query<{ id: string }>(`SELECT nextval('ca_id_seq')::text AS id`)).rows[0]!.id,
    );
  await t.client.query(
    `INSERT INTO corporate_actions
       (ca_id, instrument_id, ca_type, status, declared_date, ex_date, record_date, pay_date,
        amount, currency, ratio_new, ratio_old, frequency, gross_or_net, source_id, review_state,
        valid_from, tx_from, tx_to, provenance_id)
     VALUES ($1, $2, $3::ca_type, $4::ca_status, $5::date, $6::date, $7::date, $8::date,
             $9::numeric, $10, $11::numeric, $12::numeric, $13, 'net', $14, $15,
             COALESCE($5::timestamptz, $6::timestamptz),
             COALESCE($16::timestamptz, clock_timestamp()),
             COALESCE($17::timestamptz, 'infinity'::timestamptz), $18)`,
    [
      caId,
      args.instrumentId,
      args.caType,
      args.status,
      args.declaredDate ?? null,
      args.exDate,
      args.recordDate ?? null,
      args.payDate ?? null,
      args.amount ?? null,
      args.currency ?? (args.amount == null ? null : 'USD'),
      args.ratioNew ?? null,
      args.ratioOld ?? null,
      args.frequency ?? null,
      args.sourceId,
      args.reviewState ?? 'auto',
      args.txFrom ?? null,
      args.txTo ?? null,
      args.provenanceId,
    ],
  );
  return caId;
}

beforeEach(async () => {
  await ensureLicences();

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`CACS Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'CACS User', 'user') RETURNING user_id`,
    [firmId, `cacs-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  await grantEverySource(firmId, userId);

  const masterProv = await bootstrapProvenance(t, 'internal.user', 'cacs-master');
  const yahooProv = await bootstrapProvenance(t, 'yahoo.chart', 'cacs-events');
  const secProv = await bootstrapProvenance(t, 'sec.submissions', 'cacs-filings');

  const tag = randomUUID().slice(0, 4).toUpperCase();
  const ticker = `AAPL${tag}`;
  const cik = `000032${tag.replace(/[^0-9]/g, '0').padEnd(4, '0')}`.slice(0, 10).padStart(10, '0');
  const { instrumentId, issuerId } = await seedSecurity(ticker, cik, masterProv);

  // Closes on the session before each cash ex-date, so the engine has its denominator.
  for (const dividend of [...DIVIDENDS]) {
    const prior = new Date(Date.parse(`${dividend.exDate}T00:00:00Z`) - 86_400_000);
    await insertClose(instrumentId, prior.toISOString().slice(0, 10), dividend.priorClose, yahooProv);
  }
  const correctionPrior = new Date(Date.parse(`${CORRECTION.exDate}T00:00:00Z`) - 86_400_000);
  await insertClose(
    instrumentId,
    correctionPrior.toISOString().slice(0, 10),
    CORRECTION.priorClose,
    yahooProv,
  );

  for (const dividend of DIVIDENDS) {
    await insertAction({
      instrumentId,
      caType: 'cash_dividend',
      status: dividend.status,
      exDate: dividend.exDate,
      amount: dividend.amount,
      declaredDate: dividend.declaredDate,
      recordDate: dividend.recordDate,
      payDate: dividend.payDate,
      frequency: 'quarterly',
      sourceId: 'yahoo.chart',
      provenanceId: yahooProv,
    });
  }
  for (const rung of LADDER) {
    await insertAction({
      instrumentId,
      caType: 'cash_dividend',
      status: rung.status,
      exDate: rung.exDate,
      amount: rung.amount,
      declaredDate: rung.declaredDate,
      recordDate: rung.recordDate,
      payDate: rung.payDate,
      frequency: 'quarterly',
      // Only data operations can enter a row before its ex-date: the event feed never publishes
      // one, which is what ESTIMATED_CA_UNAVAILABLE says.
      sourceId: rung.status === 'estimated' ? 'internal.user' : 'yahoo.chart',
      reviewState: rung.status === 'estimated' ? 'queued' : 'auto',
      provenanceId: rung.status === 'estimated' ? masterProv : yahooProv,
    });
  }
  await insertAction({
    instrumentId,
    caType: 'split',
    status: 'paid',
    exDate: SPLIT.exDate,
    ratioNew: SPLIT.ratioNew,
    ratioOld: SPLIT.ratioOld,
    sourceId: 'yahoo.chart',
    provenanceId: yahooProv,
  });

  // The correction: two versions of one action, the first closed on the transaction-time axis.
  const correctionCaId = await insertAction({
    instrumentId,
    caType: 'cash_dividend',
    status: 'paid',
    exDate: CORRECTION.exDate,
    amount: CORRECTION.before,
    declaredDate: '2026-03-05',
    recordDate: '2026-03-13',
    payDate: '2026-03-16',
    frequency: 'quarterly',
    sourceId: 'yahoo.chart',
    provenanceId: yahooProv,
    txFrom: '2026-03-12T00:00:00.000Z',
    txTo: CORRECTION.correctedAt,
  });
  await insertAction({
    instrumentId,
    caId: correctionCaId,
    caType: 'cash_dividend',
    status: 'paid',
    exDate: CORRECTION.exDate,
    amount: CORRECTION.after,
    declaredDate: '2026-03-05',
    recordDate: '2026-03-13',
    payDate: '2026-03-16',
    frequency: 'quarterly',
    sourceId: 'yahoo.chart',
    provenanceId: yahooProv,
    txFrom: CORRECTION.correctedAt,
  });

  // One 8-K item 2.02 — the earnings block.
  await t.client.query(
    `INSERT INTO filings (accession_no, cik, issuer_id, form, filed_date, accepted_at,
                          report_date, items, primary_doc, primary_doc_desc, url,
                          captured_at, provenance_id)
     VALUES ($1, $2, $3, '8-K', '2026-07-31', '2026-07-31T20:31:00Z', '2026-06-27',
             ARRAY['2.02','9.01'], 'aapl-20260627.htm',
             'Results of Operations and Financial Condition',
             'https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/aapl-20260627.htm',
             $4::timestamptz, $5)`,
    [`0000320193-26-0000${tag.slice(0, 2)}`.slice(0, 20), cik, issuerId, GOLDEN_ISO, secProv],
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
    knownAt,
    instrumentId,
    issuerId,
    cik,
    key: `${ticker} US Equity`,
    correctionCaId,
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface RunResult {
  data: CacsPayload;
  meta: {
    engines: { name: string; version: string; inputsHash: string }[];
    unavailable: { field: string; reason: string; detail: string }[];
  };
}

async function runCACS(params: Record<string, unknown> = {}): Promise<RunResult> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/CACS/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params,
      security: { id: env.instrumentId },
      asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<RunResult>();
}

function issuerPayload(data: CacsPayload): CacsIssuerPayload {
  expect(data.variant).toBe('issuer');
  return data as CacsIssuerPayload;
}

/**
 * The keys of a CACS payload that hold a sequence-allocated id (§CACS `CacsAction`,
 * `CacsIssuerPayload`). `caId` is one too, but it is tokenised by its position on the timeline a
 * few lines above; `sourceId` (`'yahoo.chart'`) and `cik` are names, not sequence values.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId', 'issuerId', 'newInstrumentId']);

describe('CACS — the corporate-action timeline', () => {
  it('puts a row on each rung of the estimated → announced → confirmed → paid ladder (DATA-08)', async () => {
    const all = issuerPayload(
      (await runCACS({ status: ['estimated', 'announced', 'confirmed', 'paid', 'cancelled'] })).data,
    );
    const real = all.actions.filter((a) => !a.projected);
    const byStatus = new Map(real.map((a) => [a.status, a]));

    expect(byStatus.get('paid')).toBeDefined();
    expect(byStatus.get('confirmed')!.exDate).toBe('2026-08-07');
    expect(byStatus.get('announced')!.exDate).toBe('2026-10-15');
    expect(byStatus.get('cancelled')!.exDate).toBe('2026-06-15');

    // The only `estimated` row a source published came from data operations, not the feed.
    const estimated = byStatus.get('estimated')!;
    expect(estimated.exDate).toBe('2026-12-10');
    expect(estimated.sourceId).toBe('internal.user');
    expect(estimated.reviewState).toBe('queued');
    expect(all.notes).toContain('CA_REVIEW_PENDING');

    // The default filter shows the three published rungs and neither of the other two: a
    // data-ops estimate and a cancelled action are both statements a screen must opt into.
    const byDefault = issuerPayload((await runCACS()).data);
    const statuses = new Set(byDefault.actions.filter((a) => !a.projected).map((a) => a.status));
    expect([...statuses].sort()).toEqual(['announced', 'confirmed', 'paid']);
    expect(byDefault.actions.some((a) => a.status === 'cancelled')).toBe(false);
    expect(byDefault.actions.some((a) => !a.projected && a.status === 'estimated')).toBe(false);
  });

  it('states that the pre-announcement rungs have no source, every run', async () => {
    const { data, meta } = await runCACS();
    const payload = issuerPayload(data);
    expect(payload.notes).toContain('ESTIMATED_CA_UNAVAILABLE');
    const entry = meta.unavailable.find((u) => u.field === 'status.estimated')!;
    expect(entry.reason).toBe('NO_SOURCE');
    expect(entry.detail).toContain('ESTIMATED_CA_UNAVAILABLE');
    expect(entry.detail).toContain('internal.user');
  });

  it('reports every requested-but-unsourced action type with a reason, not an empty section', async () => {
    const { data, meta } = await runCACS({
      types: ['cash_dividend', 'merger', 'tender', 'rights', 'spinoff'],
    });
    const payload = issuerPayload(data);
    expect(payload.notes).toContain('CA_TYPES_NO_SOURCE');
    for (const caType of ['merger', 'tender', 'rights', 'spinoff']) {
      const entry = meta.unavailable.find((u) => u.field === caType)!;
      expect(entry, caType).toBeDefined();
      expect(entry.reason).toBe('NO_SOURCE');
      expect(entry.detail).toContain('CA_TYPES_NO_SOURCE');
    }
    // …and no fabricated row of those types appears.
    expect(payload.actions.every((a) => a.caType === 'cash_dividend')).toBe(true);
  });

  it('orders the future block first, ascending, then history descending', async () => {
    const payload = issuerPayload(
      (await runCACS({ status: ['announced', 'confirmed', 'paid'] })).data,
    );
    const future = payload.actions.filter((a) => a.exDate > TODAY);
    const past = payload.actions.filter((a) => a.exDate <= TODAY);
    expect(payload.actions.slice(0, future.length)).toEqual(future);
    for (let i = 1; i < future.length; i += 1) {
      expect(future[i]!.exDate >= future[i - 1]!.exDate).toBe(true);
    }
    for (let i = 1; i < past.length; i += 1) {
      expect(past[i]!.exDate <= past[i - 1]!.exDate).toBe(true);
    }
  });

  it('takes every adjustment factor from the one REF-09 implementation', async () => {
    const { data, meta } = await runCACS({ types: ['cash_dividend', 'split'] });
    const payload = issuerPayload(data);

    const split = payload.actions.find((a) => a.caType === 'split')!;
    expect(split.adjFactor).toBeCloseTo(SPLIT.ratioOld / SPLIT.ratioNew, 10);

    const dividend = payload.actions.find((a) => a.exDate === '2026-08-07')!;
    expect(dividend.adjFactor).toBeCloseTo(1 - 0.26 / 331.59, 10);
    expect(Number(dividend.adjFactor!.toFixed(5))).toBe(0.99922);

    // The cumulative factor is the product over the rows behind the as-of date, and nothing else.
    const expected = payload.actions
      .filter((a) => a.exDate <= TODAY && a.adjFactor !== null)
      .reduce((product, a) => product * a.adjFactor!, 1);
    expect(payload.summary.cumulativeAdjFactor).toBeCloseTo(expected, 12);
    expect(payload.summary.cumulativeAdjFactor).toBeLessThan(SPLIT.ratioOld / SPLIT.ratioNew);

    expect(meta.engines).toContainEqual(
      expect.objectContaining({ name: 'adjust/corporateActions', version: '1.0.0' }),
    );
  });

  it('projects the next ex-date from the cadence, badged, and never writes it back', async () => {
    const payload = issuerPayload((await runCACS()).data);

    const projection = payload.summary.nextProjected!;
    expect(projection).not.toBeNull();
    expect(projection.basis).toMatch(/median gap of last \d+ cash dividends = 91 d/);
    expect(projection.confidence).toBe(0.6);

    const row = payload.actions.find((a) => a.projected)!;
    expect(row.caId).toBeNull();
    expect(row.status).toBe('estimated');
    expect(row.sourceId).toBe('internal.derived');
    expect(row.projectionBasis).toBe(projection.basis);
    expect(row.exDate).toBe(projection.exDate);
    expect(row.adjFactor).toBeNull();
    expect(payload.notes).toContain('PROJECTED_ROW');

    // The estimate stays an estimate: nothing was written to the record.
    const stored = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM corporate_actions
        WHERE instrument_id = $1 AND ex_date = $2::date`,
      [env.instrumentId, projection.exDate],
    );
    expect(stored.rows[0]!.n).toBe('0');
  });

  it('declines to project from fewer than four payments, and says why', async () => {
    const payload = issuerPayload((await runCACS({ from: '2026-04-01' })).data);
    expect(payload.summary.nextProjected).toBeNull();
    expect(payload.notes).toContain('PROJECTION_INSUFFICIENT_HISTORY');
    expect(payload.actions.some((a) => a.projected)).toBe(false);
  });

  it('summarises the trailing-twelve-month dividend and leaves the yield stated-absent', async () => {
    const { data, meta } = await runCACS();
    const payload = issuerPayload(data);

    // 2026-08-07, 2026-05-08, 2026-03-12 (corrected to 0.26), 2026-02-06 and 2025-11-07 are the
    // five ex-dates inside the trailing 365 days at the frozen clock.
    expect(payload.summary.ttmCount).toBe(5);
    expect(payload.summary.ttmCashDividend).toBeCloseTo(0.26 + 0.26 + 0.26 + 0.25 + 0.25, 10);
    expect(payload.summary.frequency).toBe('quarterly');

    // The plant was never polled, so there is no price — and therefore no yield, with a reason
    // rather than a zero.
    expect(payload.summary.pxLast.v).toBeNull();
    expect(payload.summary.pxLast.st).toBe('blank');
    expect(payload.summary.pxLast.provIdx).toBe(-1);
    expect(payload.summary.dvdYield.v).toBeNull();
    expect(payload.summary.dvdYield.st).toBe('na');
    expect(meta.unavailable.some((u) => u.field === 'DVD_YIELD')).toBe(true);
  });

  it('folds the 8-K item 2.02 acceptance time in as an earnings date', async () => {
    const payload = issuerPayload((await runCACS()).data);
    expect(payload.earnings).toHaveLength(1);
    const earnings = payload.earnings[0]!;
    expect(earnings.items8k).toContain('2.02');
    expect(earnings.form).toBe('8-K');
    // 20:31 UTC is 16:31 New York — after the close.
    expect(earnings.reportTiming).toBe('post');
    expect(earnings.provIdx).toBeGreaterThanOrEqual(0);
    expect(earnings.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('reads the corrected dividend as it was known, not as it is now (STOR-06)', async () => {
    const now = issuerPayload((await runCACS()).data);
    const corrected = now.actions.find((a) => a.exDate === CORRECTION.exDate)!;
    expect(corrected.amount).toBeCloseTo(CORRECTION.after, 10);
    expect(corrected.caId).toBe(env.correctionCaId);

    const before = issuerPayload(
      (await runCACS({ knownAt: '2026-08-15T00:00:00.000Z' })).data,
    );
    const asKnown = before.actions.find((a) => a.exDate === CORRECTION.exDate)!;
    expect(asKnown.amount).toBeCloseTo(CORRECTION.before, 10);
    expect(asKnown.caId).toBe(env.correctionCaId);
    expect(before.knownAt).toBe('2026-08-15T00:00:00.000Z');
  });

  it('never accepts a knownAt forward of the request', async () => {
    const payload = issuerPayload(
      (await runCACS({ knownAt: '2030-01-01T00:00:00.000Z' })).data,
    );
    expect(Date.parse(payload.knownAt)).toBeLessThanOrEqual(Date.parse(env.knownAt));
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    const { data } = await runCACS();
    const tokens = new Map<number, string>([
      [env.instrumentId, '<AAPL>'],
      [env.issuerId, '<ISSUER>'],
    ]);
    const payload = issuerPayload(data);
    // `caId` values come from a sequence and are not reproducible between runs; they are replaced
    // by their position on the timeline, which is.
    const caIds = new Map<number, string>();
    for (const action of payload.actions) {
      if (action.caId !== null) caIds.set(action.caId, `<CA:${action.exDate}>`);
    }
    const normalised: unknown = JSON.parse(
      JSON.stringify(payload, (key, value: unknown) => {
        // `knownAt` is the request's own transaction instant, which moves with the wall clock;
        // STOR-06 is proved by the point-in-time test above, not by pinning a timestamp here.
        if (key === 'knownAt' && typeof value === 'string') return '<KNOWN_AT>';
        if (key === 'caId' && typeof value === 'number') return caIds.get(value) ?? '<CA>';
        if (key === 'accessionNo' && typeof value === 'string') return '<ACCESSION>';
        if (key === 'cik' && typeof value === 'string') return '<CIK>';
        if (key === 'key' && typeof value === 'string') return '<KEY>';
        if (key === 'url' && typeof value === 'string') return '<URL>';
        if (typeof value === 'string') return subjectToken(value, tokens);
        // Ids are tokenised by the key they sit under, not by what they equal: a corporate action
        // carries `rate`, `ratio`, `grossAmount` and `taxRate`, and a value-based rule renames any
        // of them that collides with `env.instrumentId` or `env.issuerId`.
        return idToken(key, value, ID_KEYS, tokens);
      }),
    );
    expectGolden('CACS.issuer.json', normalised);
  });
});
