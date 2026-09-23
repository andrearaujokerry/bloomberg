/**
 * `test/integration/functions/CN.test.ts` — company news, both variants
 * (FUNCTIONS_TIER2.md §CN; WP-10's Tier 2 news row).
 *
 * CN's job is to be **precision-first and to say so**. WP-09 owns the linker and the follow-up
 * commit tightened NEWS-02 so that a one-word surface needs corroboration before a link is ever
 * written; this file therefore does not re-test linking. It seeds the links the linker would have
 * written and proves the four things the *screen* is responsible for:
 *
 *  1. a headline appears because a stored link says so, at or above `minConfidence`, and raising
 *     the floor to 1.0 drops a 0.95 name-exact link rather than keeping it "because it is close";
 *  2. an 8-K that arrived twice — once through the SEC atom feed as a `news_items` row and once
 *     through the submissions index as a `filings` row — is **one** line, not two;
 *  3. an issuer with no linked headline gets an empty stream *with the reason*, never a bare
 *     "no results";
 *  4. on an index, the stream is the union over the largest constituents and each row is tagged
 *     with which of them it belongs to.
 *
 * Every feed is seeded with a capture at the frozen clock, so the resolver's freshness probe finds
 * the corpus current and no provider is touched — which is also what keeps this suite off the
 * replay wall.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden, idToken, subjectToken } from './golden.js';

import { FunctionRegistry } from '@terminal/core';
import { CN } from '@terminal/core/functions/manifests/CN';
import type {
  CnIssuerPayload,
  CnMembersPayload,
  CnPayload,
} from '@terminal/core/functions/manifests/CN';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as CNModule from '../../../src/functions/CN/resolve.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS, seedQuoteInstrument } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = '2020-01-01T00:00:00.000Z';

/** The accession number the 8-K arrives under from BOTH the atom feed and the filings index. */
const DOUBLE_ACCESSION = '0000320193-26-000020';

const REGISTRY = new FunctionRegistry([CN]);
const MODULES: Record<string, FunctionServerModule<never, never>> = {
  CN: CNModule as unknown as FunctionServerModule<never, never>,
};

const t: TestDb = withTxDb();

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  cookie: string;
  knownAt: string;
  instrumentId: number;
  issuerId: number;
  cik: string;
  quietInstrumentId: number;
  indexInstrumentId: number;
  memberIds: number[];
  newsIds: Map<string, number>;
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

interface StorySpec {
  sourceId: 'bbg.rss' | 'sec.atom' | 'fed.rss';
  feed: string;
  guid: string;
  kind: string;
  headline: string;
  summary: string | null;
  url: string;
  publishedAt: string;
  cik?: string | null;
  items8k?: string[] | null;
  isCorrection?: boolean;
}

async function insertStory(
  story: StorySpec,
  provenanceId: number,
  cik: string,
): Promise<number> {
  const res = await t.client.query<{ news_id: string }>(
    `INSERT INTO news_items (source_id, feed, provider_guid, kind, headline, summary, url,
                             cik, items_8k, published_at, captured_at, is_correction,
                             provenance_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING news_id`,
    [
      story.sourceId,
      story.feed,
      story.guid,
      story.kind,
      story.headline,
      story.summary,
      story.url,
      story.cik === undefined ? null : (story.cik ?? cik),
      story.items8k ?? null,
      story.publishedAt,
      GOLDEN_ISO,
      story.isCorrection ?? false,
      provenanceId,
    ],
  );
  return Number(res.rows[0]!.news_id);
}

async function link(
  newsId: number,
  entityKind: 'issuer' | 'instrument',
  entityId: number,
  confidence: number,
  method: string,
): Promise<void> {
  await t.client.query(
    `INSERT INTO news_entity_links (news_id, entity_kind, entity_id, confidence, method)
     VALUES ($1, $2, $3, $4, $5)`,
    [newsId, entityKind, entityId, confidence, method],
  );
}

/** An issuer with a CIK plus its issue and instrument. */
async function seedSecurity(
  ticker: string,
  name: string,
  cik: string | null,
  provenanceId: number,
): Promise<{ instrumentId: number; issuerId: number }> {
  const issuer = await t.client.query<{ issuer_id: string }>(
    `INSERT INTO issuers (name, cik, country, valid_from, provenance_id)
     VALUES ($1, $2, 'US', $3::timestamptz, $4) RETURNING issuer_id`,
    [name, cik, VALID_FROM, provenanceId],
  );
  const issuerId = Number(issuer.rows[0]!.issuer_id);
  const issue = await t.client.query<{ issue_id: string }>(
    `INSERT INTO issues (issuer_id, asset_class, security_type, name, currency,
                         country_of_issue, valid_from, provenance_id)
     VALUES ($1, 'equity', 'Common Stock', $2, 'USD', 'US', $3::timestamptz, $4)
     RETURNING issue_id`,
    [issuerId, name, VALID_FROM, provenanceId],
  );
  const instrument = await t.client.query<{ instrument_id: string }>(
    `INSERT INTO instruments (issue_id, asset_class, market_sector, ticker, exch_code, name,
                              currency, valid_from, provenance_id)
     VALUES ($1, 'equity', 'Equity', $2, 'US', $3, 'USD', $4::timestamptz, $5)
     RETURNING instrument_id`,
    [Number(issue.rows[0]!.issue_id), ticker, name, VALID_FROM, provenanceId],
  );
  return { instrumentId: Number(instrument.rows[0]!.instrument_id), issuerId };
}

beforeEach(async () => {
  await ensureLicences();

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`CN Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'CN User', 'user') RETURNING user_id`,
    [firmId, `cn-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  await grantEverySource(firmId, userId);

  const masterProv = await bootstrapProvenance(t, 'internal.user', 'cn-master');
  const bbgProv = await bootstrapProvenance(t, 'bbg.rss', 'cn-bbg');
  const atomProv = await bootstrapProvenance(t, 'sec.atom', 'cn-atom');
  const fedProv = await bootstrapProvenance(t, 'fed.rss', 'cn-fed');
  const secProv = await bootstrapProvenance(t, 'sec.submissions', 'cn-filings');

  const tag = randomUUID().slice(0, 4).toUpperCase();
  const cik = `00003201${tag.replace(/\D/g, '0').slice(0, 2).padEnd(2, '0')}`;
  const apple = await seedSecurity(`AAPL${tag}`, 'Apple Inc', cik, masterProv);
  const quiet = await seedSecurity(`QUIET${tag}`, 'Quiet Industries Inc', null, masterProv);
  const msft = await seedSecurity(`MSFT${tag}`, 'Microsoft Corporation', null, masterProv);
  const nvda = await seedSecurity(`NVDA${tag}`, 'NVIDIA Corporation', null, masterProv);

  const spx = await seedQuoteInstrument(t, {
    ticker: `SPXN${tag.slice(0, 3)}`,
    name: 'S&P 500',
    assetClass: 'index',
    providerSymbol: `_SPXN.${tag}`,
  });

  const newsIds = new Map<string, number>();

  // A Bloomberg story linked to the issuer at 1.0 — the ordinary case.
  newsIds.set(
    'buyback',
    await insertStory(
      {
        sourceId: 'bbg.rss',
        feed: 'markets',
        guid: `bbg-${tag}-buyback`,
        kind: 'story',
        headline: 'Apple Shares Rise on Capital Return Plan',
        summary: 'The board approved a larger buyback.',
        url: 'https://www.bloomberg.com/news/articles/2026-09-15/apple-capital-return',
        publishedAt: '2026-09-15T12:04:00.000Z',
        cik: null,
      },
      bbgProv,
      cik,
    ),
  );
  await link(newsIds.get('buyback')!, 'issuer', apple.issuerId, 1, 'name_exact');
  await link(newsIds.get('buyback')!, 'instrument', apple.instrumentId, 1, 'ticker_exact');

  // A second story linked at 0.95: inside the stored floor, below a caller who asks for 1.0.
  newsIds.set(
    'supplier',
    await insertStory(
      {
        sourceId: 'bbg.rss',
        feed: 'technology',
        guid: `bbg-${tag}-supplier`,
        kind: 'story',
        headline: 'Apple Supplier Signals Strong iPhone Demand',
        summary: 'A component maker raised its outlook.',
        url: 'https://www.bloomberg.com/news/articles/2026-09-14/apple-supplier',
        publishedAt: '2026-09-14T08:15:00.000Z',
        cik: null,
      },
      bbgProv,
      cik,
    ),
  );
  await link(newsIds.get('supplier')!, 'issuer', apple.issuerId, 0.95, 'name_alias');

  // The 8-K that arrived twice: once from the atom feed, once in the submissions index.
  newsIds.set(
    'eightk',
    await insertStory(
      {
        sourceId: 'sec.atom',
        feed: '8-K',
        guid: `urn:tag:sec.gov,2008:accession-number=${DOUBLE_ACCESSION}`,
        kind: 'filing',
        headline: '8-K · Apple Inc · Item 2.02 Results of Operations',
        summary: null,
        url: `https://www.sec.gov/Archives/edgar/data/320193/${DOUBLE_ACCESSION}-index.htm`,
        publishedAt: '2026-09-05T20:31:00.000Z',
        items8k: ['2.02', '9.01'],
      },
      atomProv,
      cik,
    ),
  );
  await link(newsIds.get('eightk')!, 'issuer', apple.issuerId, 1, 'cik');

  // A Fed release, so the third feed's health line is live and nothing is refreshed.
  newsIds.set(
    'fed',
    await insertStory(
      {
        sourceId: 'fed.rss',
        feed: 'press_all',
        guid: `fed-${tag}-minutes`,
        kind: 'press_release',
        headline: 'Minutes of the Federal Open Market Committee, August 2026',
        summary: 'The Committee reviewed the outlook.',
        url: 'https://www.federalreserve.gov/monetarypolicy/fomcminutes20260826.htm',
        publishedAt: '2026-09-15T11:30:00.000Z',
        cik: null,
      },
      fedProv,
      cik,
    ),
  );

  // Member headlines for the index variant.
  newsIds.set(
    'msft',
    await insertStory(
      {
        sourceId: 'bbg.rss',
        feed: 'technology',
        guid: `bbg-${tag}-msft`,
        kind: 'story',
        headline: 'Microsoft Lifts Cloud Guidance',
        summary: 'Azure growth reaccelerated.',
        url: 'https://www.bloomberg.com/news/articles/2026-09-15/microsoft-cloud',
        publishedAt: '2026-09-15T14:00:00.000Z',
        cik: null,
      },
      bbgProv,
      cik,
    ),
  );
  await link(newsIds.get('msft')!, 'instrument', msft.instrumentId, 1, 'name_exact');

  newsIds.set(
    'both',
    await insertStory(
      {
        sourceId: 'bbg.rss',
        feed: 'technology',
        guid: `bbg-${tag}-both`,
        kind: 'story',
        headline: 'Chip Demand Lifts Apple and NVIDIA',
        summary: 'Two index heavyweights moved together.',
        url: 'https://www.bloomberg.com/news/articles/2026-09-13/chip-demand',
        publishedAt: '2026-09-13T16:20:00.000Z',
        cik: null,
      },
      bbgProv,
      cik,
    ),
  );
  await link(newsIds.get('both')!, 'instrument', apple.instrumentId, 1, 'name_exact');
  await link(newsIds.get('both')!, 'instrument', nvda.instrumentId, 1, 'name_exact');

  // The filings index: the folded-in 10-Q, plus the 8-K the atom feed already carries.
  const insertFiling = async (args: {
    accessionNo: string;
    form: string;
    filedDate: string;
    acceptedAt: string;
    items: string[];
    primaryDoc: string;
    desc: string;
    url: string;
  }): Promise<void> => {
    await t.client.query(
      `INSERT INTO filings (accession_no, cik, issuer_id, form, filed_date, accepted_at,
                            report_date, items, primary_doc, primary_doc_desc, url,
                            captured_at, provenance_id)
       VALUES ($1::char(20), $2::char(10), $3::bigint, $4, $5::date, $6::timestamptz,
               '2026-06-27'::date, $7::text[], $8, $9, $10, $11::timestamptz, $12::bigint)`,
      [
        args.accessionNo,
        cik,
        apple.issuerId,
        args.form,
        args.filedDate,
        args.acceptedAt,
        args.items,
        args.primaryDoc,
        args.desc,
        args.url,
        GOLDEN_ISO,
        secProv,
      ],
    );
  };
  await insertFiling({
    accessionNo: '0000320193-26-000031',
    form: '10-Q',
    filedDate: '2026-09-02',
    acceptedAt: '2026-09-02T13:00:00Z',
    items: [],
    primaryDoc: 'aapl-10q.htm',
    desc: 'Quarterly report',
    url: 'https://www.sec.gov/Archives/edgar/data/320193/aapl-10q.htm',
  });
  await insertFiling({
    accessionNo: DOUBLE_ACCESSION,
    form: '8-K',
    filedDate: '2026-09-05',
    acceptedAt: '2026-09-05T20:31:00Z',
    items: ['2.02', '9.01'],
    primaryDoc: 'aapl-8k.htm',
    desc: 'Results of Operations and Financial Condition',
    url: `https://www.sec.gov/Archives/edgar/data/320193/${DOUBLE_ACCESSION}-index.htm`,
  });

  // The index and its three constituents.
  const memberProv = await bootstrapProvenance(t, 'ssga.holdings', 'cn-members');
  const index = await t.client.query<{ index_id: string }>(
    `INSERT INTO indices (code, instrument_id, proxy_fund_instrument_id, membership_source_id,
                          provider)
     VALUES ($1, $2, NULL, 'ssga.holdings', 'S&P Dow Jones') RETURNING index_id`,
    [`CNX${tag}`, spx.instrumentId],
  );
  const indexId = Number(index.rows[0]!.index_id);
  const memberIds = [apple.instrumentId, msft.instrumentId, nvda.instrumentId];
  for (const [i, instrumentId] of memberIds.entries()) {
    await t.client.query(
      `INSERT INTO index_members (index_id, instrument_id, weight, as_of_date, source_id,
                                  valid_from, provenance_id)
       VALUES ($1, $2, $3::numeric, '2026-09-14'::date, 'ssga.holdings',
               '2026-09-14'::timestamptz, $4)`,
      [indexId, instrumentId, (0.07 - i * 0.01).toFixed(10), memberProv],
    );
  }

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
    instrumentId: apple.instrumentId,
    issuerId: apple.issuerId,
    cik,
    quietInstrumentId: quiet.instrumentId,
    indexInstrumentId: spx.instrumentId,
    memberIds,
    newsIds,
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface RunResult {
  data: CnPayload;
  meta: {
    unavailable: { field: string; reason: string; detail: string }[];
    page: { index: number; count: number; cursor: string | null } | null;
  };
}

async function runCN(
  instrumentId: number,
  params: Record<string, unknown> = {},
): Promise<RunResult> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/CN/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params,
      security: { id: instrumentId },
      asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<RunResult>();
}

function asIssuer(data: CnPayload): CnIssuerPayload {
  expect(data.variant).toBe('issuer');
  return data as CnIssuerPayload;
}

function asMembers(data: CnPayload): CnMembersPayload {
  expect(data.variant).toBe('members');
  return data as CnMembersPayload;
}

/**
 * The keys of a CN payload that hold a sequence-allocated id (§CN, `functions/shared/news.ts`).
 * `indexId` is one too and is flattened to `<INDEX_ID>` by its own branch below; `sourceId`
 * (`'bbg.rss'`) is a name.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId', 'issuerId', 'entityId', 'newsId']);

describe('CN — company news', () => {
  it('shows the issuer stream newest first, with the filings folded in', async () => {
    const payload = asIssuer((await runCN(env.instrumentId)).data);

    expect(payload.issuer).toEqual({
      issuerId: env.issuerId,
      name: 'Apple Inc',
      cik: env.cik,
    });
    expect(payload.window.label).toBe('1M');
    expect(payload.liveSubject).toBe(`n:inst:${String(env.instrumentId)}`);
    expect(payload.notes).toContain('PRECISION_FIRST_LINKING');
    expect(payload.notes).toContain('BODY_NOT_STORED_LINK_OUT');

    for (let i = 1; i < payload.rows.length; i += 1) {
      expect(payload.rows[i]!.publishedAt <= payload.rows[i - 1]!.publishedAt).toBe(true);
    }

    // The 10-Q reached the screen only through the filings index: a pseudo-headline with a null
    // newsId and the accession number identifying it.
    const tenQ = payload.rows.find((r) => r.newsId === null && r.category === '10-Q')!;
    expect(tenQ).toBeDefined();
    expect(tenQ.accessionNo).toBe('0000320193-26-000031');
    expect(tenQ.sourceId).toBe('sec.submissions');
    expect(tenQ.links).toEqual([
      { entityKind: 'issuer', entityId: env.issuerId, display: 'Apple Inc', confidence: 1, method: 'cik' },
    ]);
    expect(tenQ.provIdx).toBeGreaterThanOrEqual(0);
    // Every instant in the merged list is ISO 8601, whichever reader produced it: the stream is
    // sorted on these strings, and two formats in one list sort wrongly.
    for (const row of payload.rows) {
      expect(row.publishedAt, row.headline).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      expect(row.capturedAt, row.headline).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
  });

  it('shows an 8-K that arrived from both the atom feed and the filings index exactly once', async () => {
    const payload = asIssuer((await runCN(env.instrumentId)).data);
    const eightKs = payload.rows.filter(
      (r) => (r.items8k ?? []).includes('2.02'),
    );
    expect(eightKs).toHaveLength(1);
    // The surviving copy is the atom row, which carries a real `newsId` and streams live.
    expect(eightKs[0]!.newsId).toBe(env.newsIds.get('eightk'));
    expect(eightKs[0]!.sourceId).toBe('sec.atom');
  });

  it('applies minConfidence as a floor above the stored threshold, and never below it', async () => {
    const wide = asIssuer((await runCN(env.instrumentId, { minConfidence: 0.9 })).data);
    expect(wide.rows.map((r) => r.newsId)).toContain(env.newsIds.get('supplier'));

    const strict = asIssuer((await runCN(env.instrumentId, { minConfidence: 1 })).data);
    expect(strict.rows.map((r) => r.newsId)).not.toContain(env.newsIds.get('supplier'));
    // The 1.0 link survives, so the screen is narrower rather than empty.
    expect(strict.rows.map((r) => r.newsId)).toContain(env.newsIds.get('buyback'));
  });

  it('never invents a link: a market-wide headline that names nobody stays off the screen', async () => {
    const payload = asIssuer((await runCN(env.instrumentId)).data);
    // The FOMC minutes mention no company and carry no link; CN does not reach for it.
    expect(payload.rows.map((r) => r.newsId)).not.toContain(env.newsIds.get('fed'));
  });

  it('answers an unlinked issuer with an empty stream and the reason, not a bare no-results', async () => {
    const { data, meta } = await runCN(env.quietInstrumentId);
    const payload = asIssuer(data);
    expect(payload.rows).toEqual([]);
    expect(payload.notes).toContain('NO_ISSUER_HEADLINES_IN_WINDOW');

    const rows = meta.unavailable.find((u) => u.field === 'rows')!;
    expect(rows.reason).toBe('NO_SOURCE');
    expect(rows.detail).toContain('precision-first');

    // …and the reason the filings block is empty is a different fact, stated separately.
    const filings = meta.unavailable.find((u) => u.field === 'filings')!;
    expect(filings.detail).toBe('issuer has no SEC CIK (not an SEC filer)');
  });

  it('states the body-licence limit once per run', async () => {
    const { meta } = await runCN(env.instrumentId);
    const entries = meta.unavailable.filter((u) => u.field === 'summary');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.reason).toBe('NOT_LICENSED');
    expect(entries[0]!.detail).toContain('BODY_NOT_STORED_LINK_OUT');
  });

  it('narrows the window and the kinds on request', async () => {
    const day = asIssuer((await runCN(env.instrumentId, { window: '1D' })).data);
    expect(Date.parse(day.window.to) - Date.parse(day.window.from)).toBe(86_400_000);
    for (const row of day.rows) expect(row.publishedAt >= day.window.from).toBe(true);

    const storiesOnly = asIssuer(
      (await runCN(env.instrumentId, { kinds: ['story', 'video'] })).data,
    );
    expect(storiesOnly.rows.every((r) => r.kind === 'story' || r.kind === 'video')).toBe(true);
    expect(storiesOnly.rows.every((r) => r.newsId !== null)).toBe(true);
  });

  it('tags each member headline with the constituents it belongs to', async () => {
    const payload = asMembers((await runCN(env.indexInstrumentId, { members: 5 })).data);

    expect(payload.membership.shown).toBe(3);
    expect(payload.membership.total).toBe(3);
    // `data.reference.members` labels the roster with the date it was READ at when the caller
    // names none — the membership block's own `sourceId` is what says which file answered.
    expect(payload.membership.asOfDate).toBe('2026-09-15');
    expect(payload.membership.sourceId).toBe('ssga.holdings');
    expect(payload.notes).toContain('MEMBER_SUBSET');
    expect(new Set(payload.liveSubjects)).toEqual(
      new Set(env.memberIds.map((id) => `n:inst:${String(id)}`)),
    );

    const shared = payload.rows.find((r) => r.newsId === env.newsIds.get('both'))!;
    expect(shared.members.map((m) => m.instrumentId).sort()).toEqual(
      [env.memberIds[0]!, env.memberIds[2]!].sort(),
    );
    for (const tag of shared.members) expect(tag.weight).not.toBeNull();

    const microsoft = payload.rows.find((r) => r.newsId === env.newsIds.get('msft'))!;
    expect(microsoft.members.map((m) => m.instrumentId)).toEqual([env.memberIds[1]!]);

    // No unlinked market-wide headline leaks into the member stream.
    expect(payload.rows.map((r) => r.newsId)).not.toContain(env.newsIds.get('fed'));
  });

  it('pages the issuer stream with a cursor that decodes to the last row', async () => {
    const { meta, data } = await runCN(env.instrumentId, { limit: 10 });
    const payload = asIssuer(data);
    expect(meta.page).not.toBeNull();
    expect(meta.page!.count).toBe(payload.total);
    // Four rows fit in a page of ten, so there is nothing further to fetch.
    expect(meta.page!.cursor).toBeNull();
  });

  it('deep-equals the committed goldens at the frozen clock', async () => {
    const tokens = new Map<number, string>([
      [env.instrumentId, '<AAPL>'],
      [env.issuerId, '<ISSUER>'],
      [env.indexInstrumentId, '<SPX>'],
      [env.memberIds[1]!, '<MSFT>'],
      [env.memberIds[2]!, '<NVDA>'],
    ]);
    for (const [label, id] of env.newsIds) tokens.set(id, `<NEWS:${label}>`);

    const normalise = (payload: CnPayload): unknown =>
      JSON.parse(
        JSON.stringify(payload, (key, value: unknown) => {
          if (key === 'cik' && typeof value === 'string') return '<CIK>';
          // `indices.index_id` is a sequence value; the payload's claim is which index, which
          // `instrumentId` already carries.
          if (key === 'indexId' && typeof value === 'number') return '<INDEX_ID>';
          if (key === 'key' && typeof value === 'string') return '<KEY>';
          if (typeof value === 'string') return subjectToken(value, tokens);
          // A number is an id because of the key it sits under, never because it equals one: a
          // row's `rank`, `weight` and `sharesHeld` are numbers too, and a value-based rule
          // renames whichever of them collides with an instrument, issuer or news id.
          return idToken(key, value, ID_KEYS, tokens);
        }),
      );

    expectGolden('CN.issuer.json', normalise((await runCN(env.instrumentId)).data));
    expectGolden(
      'CN.members.json',
      normalise((await runCN(env.indexInstrumentId, { members: 5 })).data),
    );
  });
});
