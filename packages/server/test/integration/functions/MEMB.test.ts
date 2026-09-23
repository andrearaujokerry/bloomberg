/**
 * `test/integration/functions/MEMB.test.ts` — WP-10's acceptance row for `MEMB`
 * (WORKPLAN §WP-10: "503 members with weights; **sector subtotals joined from
 * `entity_classifications` (scheme `GICS`, source `wiki.sp500`)** — neither membership source
 * carries a sector … adds/drops between the N-PORT and SSGA dates (REF-07)").
 *
 * The claim under test is about **where each column came from**, which is why the fixture has
 * three sources and not one:
 *
 *  - the N-PORT roster (`sec.archives`) at 2026-03-31 and the SSGA roster (`ssga.holdings`) at
 *    2026-06-30, each 503 constituents with weights;
 *  - `etf_holdings` lines for the SSGA date carrying CUSIP, ISIN, country and `assetCat` — the
 *    regulatory category the filing really publishes, **not** a GICS sector;
 *  - `entity_classifications` rows from `wiki.sp500` for 500 of the 503, so that three members
 *    reach the screen with no sector at all.
 *
 * Those three members are the point. A screen that grouped them under "Financials" because their
 * neighbours are financials, or under a sector inferred from the SIC code, would be inventing the
 * one number a PM reads the subtotal table for. They are grouped under `Unclassified` (the em dash
 * on screen) and the payload carries a `meta.unavailable` entry naming the gap — and the same run
 * carries **two** attributions in `meta.provenance`, the membership file's and Wikipedia's
 * CC BY-SA line, because two licensed sources contributed to one grid (DATA-09).
 *
 * Membership is written as raw bitemporal versions rather than through `recordSnapshot`: 1 006
 * constituent versions through the upsert path is ~1 500 round-trips for a fixture whose shape is
 * already decided, and `refdata/indexMembership.test.ts` is where the write path is proved. What
 * this file exercises is the READ — `bt_as_of` at two dates, the diff between them, and the joins
 * hanging off it.
 *
 * WP-15 owns the seed, so every firm, user, grant, instrument and membership row is created here
 * inside this file's own transaction and nothing depends on a literal instrument id.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden, idToken, subjectToken } from './golden.js';

import { FunctionRegistry } from '@terminal/core';
import { MEMB, MEMB_UNCLASSIFIED } from '@terminal/core/functions/manifests/MEMB';
import type { MembPayload } from '@terminal/core/functions/manifests/MEMB';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as MEMBModule from '../../../src/functions/MEMB/resolve.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS, seedQuoteInstrument } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = '2020-01-01T00:00:00.000Z';

/** The N-PORT report period and the SSGA file date the fixture is built around. */
const NPORT_DATE = '2026-03-31';
const SSGA_DATE = '2026-06-30';

/** 503 constituents on both dates; the last two of the N-PORT roster are dropped and two added. */
const MEMBER_COUNT = 503;
const TOTAL_INSTRUMENTS = 505;

const REGISTRY = new FunctionRegistry([MEMB]);
const MODULES: Record<string, FunctionServerModule<never, never>> = {
  MEMB: MEMBModule as unknown as FunctionServerModule<never, never>,
};

const t: TestDb = withTxDb();

/** `wiki.sp500`'s three GICS level-1 sectors, and the 8-digit sub-industry under each. */
const SECTORS: readonly { code: string; name: string; sub: string }[] = [
  { code: '45', name: 'Information Technology', sub: '45103010' },
  { code: '35', name: 'Health Care', sub: '35102010' },
  { code: '40', name: 'Financials', sub: '40101010' },
];

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  cookie: string;
  knownAt: string;
  indexInstrumentId: number;
  indexCode: string;
  spyInstrumentId: number;
  spyKey: string;
  memberIds: number[];
  /** The two constituents present only in the N-PORT roster. */
  droppedIds: number[];
  /** The two constituents present only in the SSGA roster. */
  addedIds: number[];
  /** The three constituents deliberately left without a GICS classification. */
  unclassifiedIds: number[];
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

/**
 * 505 equities in one statement per table.
 *
 * The bitemporal columns are written directly: every row is `[2020-01-01, ∞) × [now, ∞)`, which is
 * what the repositories would have produced for a first version and what `bt_as_of` reads back.
 */
async function seedMembers(provenanceId: number): Promise<number[]> {
  const suffix = randomUUID().slice(0, 4).toUpperCase();
  await t.client.query(
    `INSERT INTO issuers (name, cik, country, valid_from, provenance_id)
     SELECT 'Member ' || i || ' Holdings',
            lpad((1000000 + i)::text, 10, '0'),
            'US', $1::timestamptz, $2::bigint
       FROM generate_series(1, $3) AS i`,
    [VALID_FROM, provenanceId, TOTAL_INSTRUMENTS],
  );
  await t.client.query(
    `INSERT INTO issues (issuer_id, asset_class, security_type, name, currency,
                         country_of_issue, cusip, isin, valid_from, provenance_id)
     SELECT r.issuer_id, 'equity', 'Common Stock', r.name, 'USD', 'US',
            lpad((100000000 + row_number() OVER (ORDER BY r.issuer_id))::text, 9, '0'),
            'US' || lpad((100000000 + row_number() OVER (ORDER BY r.issuer_id))::text, 10, '0'),
            $1::timestamptz, $2::bigint
       FROM (SELECT issuer_id, name FROM issuers
              WHERE provenance_id = $2::bigint AND tx_to = 'infinity'
              ORDER BY issuer_id) r`,
    [VALID_FROM, provenanceId],
  );
  const res = await t.client.query<{ instrument_id: string }>(
    `INSERT INTO instruments (issue_id, asset_class, market_sector, ticker, exch_code, name,
                              currency, valid_from, provenance_id)
     SELECT r.issue_id, 'equity', 'Equity',
            'M' || $3::text || lpad(r.n::text, 3, '0'), 'US', r.name, 'USD',
            $1::timestamptz, $2::bigint
       FROM (SELECT issue_id, name, row_number() OVER (ORDER BY issue_id) AS n
               FROM issues
              WHERE provenance_id = $2::bigint AND tx_to = 'infinity') r
     ORDER BY r.n
     RETURNING instrument_id`,
    [VALID_FROM, provenanceId, suffix],
  );
  return res.rows.map((r) => Number(r.instrument_id));
}

/**
 * Weight of constituent `i` (1-based), as a fraction summing to 1.
 *
 * The two rosters use deliberately different weighting schemes — rank-linear on the N-PORT date,
 * rank-squared on the SSGA date — so that the heavy names move by tens of basis points and the
 * tail moves by less than one. That is what makes the 1 bp floor of `weightMoves` a real filter
 * rather than a formality.
 */
const LINEAR_TOTAL = (MEMBER_COUNT * (MEMBER_COUNT + 1)) / 2;
const SQUARE_TOTAL = (MEMBER_COUNT * (MEMBER_COUNT + 1) * (2 * MEMBER_COUNT + 1)) / 6;

function weightOf(i: number, scheme: 'linear' | 'square' = 'linear'): string {
  const rank = MEMBER_COUNT + 1 - i;
  const raw = scheme === 'linear' ? rank / LINEAR_TOTAL : (rank * rank) / SQUARE_TOTAL;
  return raw.toFixed(10);
}

beforeEach(async () => {
  await ensureLicences();

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`MEMB Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'MEMB User', 'user') RETURNING user_id`,
    [firmId, `memb-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  await grantEverySource(firmId, userId);

  const tag = randomUUID().slice(0, 8);
  const spx = await seedQuoteInstrument(t, {
    ticker: `SPXM${tag.slice(0, 3).toUpperCase()}`,
    name: 'S&P 500',
    assetClass: 'index',
    providerSymbol: `_SPX.${tag}`,
  });
  const spy = await seedQuoteInstrument(t, {
    ticker: `SPYM${tag.slice(0, 3).toUpperCase()}`,
    name: 'SPDR S&P 500 ETF Trust',
    assetClass: 'etf',
    providerSymbol: `SPY.${tag}`,
  });

  const memberProv = await bootstrapProvenance(t, 'internal.user', 'memb-master');
  const memberIds = await seedMembers(memberProv);
  expect(memberIds).toHaveLength(TOTAL_INSTRUMENTS);

  // ── classifications: 500 of 503 get a GICS row from wiki.sp500 ────────────────────────────
  const wikiProv = await bootstrapProvenance(t, 'wiki.sp500', 'memb-gics');
  const scheme = await t.client.query(`SELECT 1 FROM classification_schemes WHERE scheme = 'GICS'`);
  if (scheme.rowCount === 0) {
    await t.client.query(
      `INSERT INTO classification_schemes (scheme, name, source_id, levels)
       VALUES ('GICS', 'GICS', 'wiki.sp500', 4) ON CONFLICT (scheme) DO NOTHING`,
    );
  }
  for (const sector of SECTORS) {
    await t.client.query(
      `INSERT INTO classification_codes (scheme, code, name, parent_code, level)
       VALUES ('GICS', $1, $2, NULL, 1), ('GICS', $3, $2 || ' — sub', $1, 4)
         ON CONFLICT (scheme, code) DO NOTHING`,
      [sector.code, sector.name, sector.sub],
    );
  }

  // The three left unclassified are the last three of the SSGA roster, so they are visible on a
  // sector-sorted screen rather than hidden behind the first page.
  // The three left unclassified sit inside the SSGA roster AND inside its first page, so they
  // really do reach the screen: a member that is dropped, or off the page, would prove nothing.
  const unclassifiedIds = memberIds.slice(100, 103);
  const classified = memberIds.filter((id) => !unclassifiedIds.includes(id));
  await t.client.query(
    `INSERT INTO entity_classifications
       (entity_kind, entity_id, scheme, code, valid_from, provenance_id)
     SELECT 'instrument', v.id::bigint, 'GICS', v.code, $1::timestamptz, $2::bigint
       FROM jsonb_to_recordset($3::jsonb) AS v(id bigint, code text)`,
    [
      VALID_FROM,
      wikiProv,
      JSON.stringify(
        classified.map((id, i) => ({ id, code: SECTORS[i % SECTORS.length]!.sub })),
      ),
    ],
  );

  // ── the index, its proxy fund and the two rosters ─────────────────────────────────────────
  const indexCode = `MBX${tag.slice(0, 4).toUpperCase()}`;
  const index = await t.client.query<{ index_id: string }>(
    `INSERT INTO indices (code, instrument_id, proxy_fund_instrument_id, membership_source_id,
                          provider)
     VALUES ($1, $2, $3, 'sec.archives', 'S&P Dow Jones') RETURNING index_id`,
    [indexCode, spx.instrumentId, spy.instrumentId],
  );
  const indexId = Number(index.rows[0]!.index_id);
  await t.client.query(
    `INSERT INTO index_terms (instrument_id, provider, methodology, calc_currency,
                              constituent_count, valid_from, provenance_id)
     VALUES ($1, 'S&P Dow Jones', 'float_cap_weighted', 'USD', $2, $3::timestamptz, $4)`,
    [spx.instrumentId, MEMBER_COUNT, VALID_FROM, memberProv],
  );

  const nportProv = await bootstrapProvenance(t, 'sec.archives', 'memb-nport');
  const ssgaProv = await bootstrapProvenance(t, 'ssga.holdings', 'memb-ssga');

  // N-PORT roster: members 1..503, valid [2026-03-31, 2026-06-30) for the two that are dropped and
  // for every reweighted line; the SSGA version takes over on 2026-06-30.
  const nportIds = memberIds.slice(0, MEMBER_COUNT);
  const ssgaIds = [...memberIds.slice(0, MEMBER_COUNT - 2), ...memberIds.slice(MEMBER_COUNT)];
  const droppedIds = memberIds.slice(MEMBER_COUNT - 2, MEMBER_COUNT);
  const addedIds = memberIds.slice(MEMBER_COUNT);

  const nportRows = nportIds.map((id, i) => [id, weightOf(i + 1)]);
  await t.client.query(
    `INSERT INTO index_members (index_id, instrument_id, weight, shares, market_value,
                                as_of_date, source_id, valid_from, valid_to, provenance_id)
     SELECT $1::bigint, v.id::bigint, v.w::numeric(12,10),
            (1000000 + v.ord * 13)::numeric(20,4),
            (50000000 + v.ord * 977)::numeric(20,2),
            $2::date, 'sec.archives', $2::timestamptz, $3::timestamptz, $4::bigint
       FROM jsonb_to_recordset($5::jsonb) AS v(id bigint, w text, ord int)`,
    [
      indexId,
      NPORT_DATE,
      SSGA_DATE,
      nportProv,
      JSON.stringify(nportRows.map(([id, w], ord) => ({ id, w, ord: ord + 1 }))),
    ],
  );

  const ssgaRows = ssgaIds.map((id, i) => [id, weightOf(i + 1, 'square')]);
  await t.client.query(
    `INSERT INTO index_members (index_id, instrument_id, weight, shares, market_value,
                                as_of_date, source_id, valid_from, provenance_id)
     SELECT $1::bigint, v.id::bigint, v.w::numeric(12,10),
            (1000000 + v.ord * 17)::numeric(20,4),
            (50000000 + v.ord * 991)::numeric(20,2),
            $2::date, 'ssga.holdings', $2::timestamptz, $3::bigint
       FROM jsonb_to_recordset($4::jsonb) AS v(id bigint, w text, ord int)`,
    [
      indexId,
      SSGA_DATE,
      ssgaProv,
      JSON.stringify(ssgaRows.map(([id, w], ord) => ({ id, w, ord: ord + 1 }))),
    ],
  );

  // ── the proxy fund's holdings file: CUSIP/ISIN/country and the REGULATORY category ─────────
  // `asset_cat` is what the N-PORT XML publishes. There is no GICS sector in this file, which is
  // exactly why the sector column has to come from somewhere else.
  await t.client.query(
    `INSERT INTO etf_holdings (etf_instrument_id, as_of_date, source_id, line_no,
                               holding_instrument_id, name, cusip, isin, ticker, shares,
                               market_value, weight, asset_cat, issuer_cat, country,
                               provenance_id)
     SELECT $1::bigint, $2::date, 'ssga.holdings', v.ord,
            v.id::bigint, i.name, iss.cusip, iss.isin, i.ticker,
            (1000000 + v.ord * 17)::numeric(20,4),
            (50000000 + v.ord * 991)::numeric(20,2),
            v.w::numeric(12,10), 'EC', 'CORP', 'US', $3::bigint
       FROM jsonb_to_recordset($4::jsonb) AS v(id bigint, w text, ord int)
       JOIN instruments i ON i.instrument_id = v.id AND i.tx_to = 'infinity'
       JOIN issues iss ON iss.issue_id = i.issue_id AND iss.tx_to = 'infinity'`,
    [
      spy.instrumentId,
      SSGA_DATE,
      ssgaProv,
      JSON.stringify(ssgaRows.map(([id, w], ord) => ({ id, w, ord: ord + 1 }))),
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
    knownAt,
    indexInstrumentId: spx.instrumentId,
    indexCode,
    spyInstrumentId: spy.instrumentId,
    spyKey: `SPYM${tag.slice(0, 3).toUpperCase()} US Index`,
    memberIds,
    droppedIds,
    addedIds,
    unclassifiedIds,
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface RunResult {
  data: MembPayload;
  meta: {
    provenance: { sourceId: string; attribution: string }[];
    unavailable: { field: string; reason: string; detail: string }[];
    page: { index: number; count: number; cursor: string | null } | null;
  };
}

/**
 * A `knownAt` late enough to include rows this file wrote *after* the setup hook.
 *
 * `env.knownAt` is frozen one second past the end of seeding, which is only late enough for a test
 * that writes nothing of its own. A row inserted in a test body carries the `clock_timestamp()` of
 * that insert, so once the file takes more than that second to reach the test the row is *not yet
 * known* and the run 404s with `SECURITY_NOT_FOUND` on an instrument the test can see in the
 * database. It never happens in isolation, where this file finishes in three seconds, and it
 * happens under the contention of a full-suite run — the flake arrives and leaves with the load.
 * A test that seeds its own instrument reads the clock again instead of borrowing the hook's.
 */
async function knownAfterWrites(): Promise<string> {
  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  return new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();
}

async function runMEMB(
  params: Record<string, unknown> = {},
  security: Record<string, unknown> | null = null,
  knownAt: string = env.knownAt,
): Promise<RunResult> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/MEMB/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params,
      ...(security === null ? {} : { security }),
      asOf: { validAt: GOLDEN_ISO, knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<RunResult>();
}

/**
 * Sequence ids and the per-run ticker suffix are both unreproducible, so both are tokenised: the
 * ids through `subjectToken`, and the ticker/key/code columns by name. What is left is the payload
 * as a function of the fixture, which is what a golden is for.
 */
/**
 * The one key in a MEMB payload that holds a sequence-allocated id: the index's `instrumentId`,
 * the proxy fund's and each member's. `sourceId`/`compareSourceId` (`'ssga.holdings'`) are names.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId']);

function normalise(payload: MembPayload): unknown {
  const tokens = new Map<number, string>([
    [env.indexInstrumentId, '<INDEX>'],
    [env.spyInstrumentId, '<SPY>'],
  ]);
  for (const [i, id] of env.memberIds.entries()) {
    tokens.set(id, `<M${String(i + 1).padStart(3, '0')}>`);
  }
  const untag = (value: string): string =>
    value.replace(/M[0-9A-F]{4}(\d{3})/g, '<M$1>').replace(/(SPXM|SPYM)[0-9A-F]{3}/g, '<$1>');
  const json = JSON.stringify(payload, (key, value: unknown) => {
    if (typeof value !== 'string') {
      // 503 members, each with a `weight` and a `shares` count, against 505 tokenised ids: the
      // old value-based rule made a weight or a share count a candidate for renaming. An id is an
      // id because of the key it sits under.
      return idToken(key, value, ID_KEYS, tokens);
    }
    if (key === 'code') return '<CODE>';
    if (key === 'key' || key === 'ticker' || key === 'cusip' || key === 'isin') {
      return untag(value);
    }
    return subjectToken(value, tokens);
  });
  return JSON.parse(json);
}

describe('MEMB — index constituents', () => {
  it('serves 503 weighted members from the SSGA roster, via the N-PORT proxy fund', async () => {
    const { data, meta } = await runMEMB(
      { limit: 500 },
      { id: env.indexInstrumentId },
    );

    expect(data.variant).toBe('index');
    expect(data.membership.count).toBe(MEMBER_COUNT);
    expect(data.membership.asOfDate).toBe(SSGA_DATE);
    expect(data.membership.sourceId).toBe('ssga.holdings');
    // The proxy fund is named by its own command-line key, whatever the fixture ticker is: the
    // claim is that membership came through SPY's filings, not through the index provider.
    expect(data.membership.via).toEqual({
      kind: 'proxy_fund',
      instrumentId: env.spyInstrumentId,
      key: env.spyKey,
    });
    expect(data.notes).toContain('MEMBERSHIP_VIA_PROXY_FUND');
    expect(data.membership.availableDates).toEqual([SSGA_DATE, NPORT_DATE]);
    expect(data.membership.weightSum).toBeCloseTo(1, 2);

    // Every served row carries a weight, and the page is weight-descending.
    const weights = data.members.map((m) => m.weight);
    expect(weights.every((w) => w !== null)).toBe(true);
    for (let i = 1; i < weights.length; i += 1) {
      expect(weights[i]!).toBeLessThanOrEqual(weights[i - 1]!);
    }

    // 503 constituents against the manifest's 500-row ceiling: the page says how much is left.
    expect(data.members).toHaveLength(500);
    expect(meta.page).toEqual({
      index: 0,
      count: MEMBER_COUNT,
      cursor: expect.any(String),
    });
    expect(data.unresolved).toEqual({ count: 0, reason: null });
  });

  it('joins the sector from wiki.sp500 and renders both attributions (DATA-09)', async () => {
    const { data, meta } = await runMEMB(
      { limit: 500, groupBy: 'gics_sector' },
      { id: env.indexInstrumentId },
    );

    // The membership file carries a regulatory category, never a GICS sector.
    const withLine = data.members.find((m) => m.cusip !== null)!;
    expect(withLine.assetCat).toBe('EC');
    expect(withLine.country).toBe('US');
    expect(withLine.gicsSector).not.toBe('EC');
    expect(SECTORS.map((s) => s.name)).toContain(withLine.gicsSector);

    // Two licensed sources contributed to one grid, and both attributions travel with it.
    const sources = meta.provenance.map((p) => p.sourceId);
    expect(sources).toContain('ssga.holdings');
    expect(sources).toContain('wiki.sp500');
    const wiki = meta.provenance.find((p) => p.sourceId === 'wiki.sp500')!;
    expect(wiki.attribution).toMatch(/CC BY-SA/);
    const membership = meta.provenance.find((p) => p.sourceId === 'ssga.holdings')!;
    expect(membership.attribution.length).toBeGreaterThan(0);
    expect(membership.attribution).not.toEqual(wiki.attribution);
  });

  it('groups a member with no GICS row under Unclassified, with a reason, never a guess', async () => {
    const { data, meta } = await runMEMB(
      { limit: 500, groupBy: 'gics_sector' },
      { id: env.indexInstrumentId },
    );

    const orphans = data.members.filter((m) => env.unclassifiedIds.includes(m.instrumentId!));
    expect(orphans).toHaveLength(env.unclassifiedIds.length);
    for (const orphan of orphans) {
      expect(orphan.gicsSector).toBeNull();
      // The row is still a member: the gap is in one column, not in the roster.
      expect(orphan.weight).not.toBeNull();
    }

    const unclassified = data.groups.find((g) => g.key === MEMB_UNCLASSIFIED)!;
    expect(unclassified).toBeDefined();
    expect(unclassified.count).toBe(env.unclassifiedIds.length);
    // The badge names the bucket the grid actually renders. The detail used to say the rows were
    // "grouped under —" while the group was labelled `Unclassified`, so the hover described a grid
    // the user was not looking at.
    expect(unclassified.label).toBe(MEMB_UNCLASSIFIED);

    // Every sector subtotal accounts for every member exactly once, and the weights add up.
    expect(data.groups.reduce((sum, g) => sum + g.count, 0)).toBe(MEMBER_COUNT);
    expect(data.groups.reduce((sum, g) => sum + g.weight, 0)).toBeCloseTo(
      data.membership.weightSum,
      6,
    );

    const gap = meta.unavailable.find((u) => u.field === 'members.gicsSector')!;
    expect(gap).toBeDefined();
    expect(gap.reason).toBe('NO_SOURCE');
    expect(gap.detail).toContain('GICS_NOT_IN_MEMBERSHIP_SOURCE');
    expect(gap.detail).toContain('3 of 503');
    expect(gap.detail).toContain(`'${MEMB_UNCLASSIFIED}'`);
  });

  it('reports adds, drops and weight moves between the N-PORT and SSGA dates (REF-07)', async () => {
    const { data } = await runMEMB(
      { limit: 500, compareDate: NPORT_DATE },
      { id: env.indexInstrumentId },
    );

    const changes = data.changes!;
    expect(changes).not.toBeNull();
    expect(changes.compareDate).toBe(NPORT_DATE);
    expect(changes.compareSourceId).toBe('sec.archives');

    expect(new Set(changes.adds.map((a) => a.instrumentId))).toEqual(new Set(env.addedIds));
    expect(new Set(changes.drops.map((d) => d.instrumentId))).toEqual(new Set(env.droppedIds));

    // Every surviving constituent moved, because the SSGA weights are shifted; the report is
    // capped at 100 rows and sorted by the size of the move.
    expect(changes.weightMoves.length).toBeGreaterThan(0);
    expect(changes.weightMoves.length).toBeLessThanOrEqual(100);
    for (let i = 1; i < changes.weightMoves.length; i += 1) {
      expect(Math.abs(changes.weightMoves[i]!.deltaBp)).toBeLessThanOrEqual(
        Math.abs(changes.weightMoves[i - 1]!.deltaBp),
      );
    }
    for (const move of changes.weightMoves) {
      expect(move.deltaBp).toBeCloseTo((move.weightTo - move.weightFrom) * 10_000, 1);
    }
  });

  it('leaves changes null, with the reason, for a compare date before the first capture', async () => {
    const { data, meta } = await runMEMB(
      { limit: 20, compareDate: '2024-01-01' },
      { id: env.indexInstrumentId },
    );
    expect(data.changes).toBeNull();
    expect(data.notes).toContain('HISTORY_LIMITED_TO_CAPTURED_FILINGS');
    const entry = meta.unavailable.find((u) => u.field === 'changes')!;
    expect(entry.detail).toContain('HISTORY_LIMITED_TO_CAPTURED_FILINGS');
    expect(entry.detail).toContain(NPORT_DATE);
  });

  it('pins the source with SRC and answers from the N-PORT roster', async () => {
    const { data } = await runMEMB(
      { limit: 20, source: 'sec.archives' },
      { id: env.indexInstrumentId },
    );
    expect(data.membership.sourceId).toBe('sec.archives');
    expect(data.membership.asOfDate).toBe(NPORT_DATE);
    expect(data.membership.availableDates).toEqual([NPORT_DATE]);
  });

  it('pages without repeating or skipping a constituent', async () => {
    const first = await runMEMB({ limit: 100 }, { id: env.indexInstrumentId });
    expect(first.data.members).toHaveLength(100);
    expect(first.meta.page).toEqual({
      index: 0,
      count: MEMBER_COUNT,
      cursor: expect.any(String),
    });

    const cursor = first.meta.page!.cursor!;
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    expect(decoded).toMatchObject({ n: first.data.members.at(-1)!.name });

    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/MEMB/page`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: { resultId: (first as unknown as { meta: { resultId: string } }).meta.resultId, direction: 'fwd' },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const second = res.json<RunResult>();
    expect(second.data.members).toHaveLength(100);
    expect(second.meta.page!.index).toBe(100);
    const firstKeys = new Set(first.data.members.map((m) => m.key));
    for (const member of second.data.members) expect(firstKeys.has(member.key)).toBe(false);
  });

  it('cells are pending, not denied, for a constituent the plant has never polled', async () => {
    const { data } = await runMEMB({ limit: 10 }, { id: env.indexInstrumentId });
    for (const member of data.members) {
      expect(member.px.v).toBeNull();
      expect(member.px.st).toBe('blank');
      expect(member.px.provIdx).toBe(-1);
      expect(member.px.r).toBeUndefined();
      expect(member.px.live).toEqual({ subject: member.subject, field: 'PX_LAST' });
      expect(member.contribPct).toBeNull();
    }
  });

  it('answers the MEMB SPX launch form with variant default and the same body', async () => {
    const withSecurity = await runMEMB({ limit: 10 }, { id: env.indexInstrumentId });
    const launched = await runMEMB({ limit: 10, index: { id: env.indexInstrumentId } });

    expect(launched.data.variant).toBe('default');
    expect(withSecurity.data.variant).toBe('index');
    expect(launched.data.members).toEqual(withSecurity.data.members);
    expect(launched.data.membership).toEqual(withSecurity.data.membership);
  });

  it('says a non-index argument is not an index rather than listing something', async () => {
    const { data, meta } = await runMEMB({ index: { id: env.memberIds[0]! } });
    expect(data.members).toEqual([]);
    const entry = meta.unavailable.find((u) => u.field === 'index')!;
    expect(entry.reason).toBe('NOT_APPLICABLE');
    expect(entry.detail).toMatch(/is not an index$/);
  });

  it('says MEMB needs an index when launched with neither a panel nor an argument', async () => {
    const { data, meta } = await runMEMB({});
    expect(data.members).toEqual([]);
    expect(meta.unavailable.map((u) => u.detail)).toContain(
      'MEMB needs an index: type MEMB SPX or load an index in the panel',
    );
  });

  it('returns no list at all for an index with no membership source', async () => {
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const nky = await seedQuoteInstrument(t, {
      ticker: `NKY${tag.slice(0, 3)}`,
      name: 'Nikkei 225',
      assetClass: 'index',
      providerSymbol: `_NKY.${tag}`,
    });
    await t.client.query(
      `INSERT INTO indices (code, instrument_id, proxy_fund_instrument_id, membership_source_id,
                            provider)
       VALUES ($1, $2, NULL, NULL, 'Nikkei Inc')`,
      [`NKY${tag}`, nky.instrumentId],
    );

    const { data, meta } = await runMEMB({}, { id: nky.instrumentId }, await knownAfterWrites());
    expect(data.members).toEqual([]);
    expect(data.membership.count).toBe(0);
    expect(data.notes).toEqual(['NO_MEMBERSHIP_SOURCE']);
    const entries = meta.unavailable.filter((u) => u.field === 'members');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail.startsWith('NO_MEMBERSHIP_SOURCE')).toBe(true);
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    const { data } = await runMEMB(
      { limit: 10, groupBy: 'gics_sector', compareDate: NPORT_DATE },
      { id: env.indexInstrumentId },
    );
    expectGolden('MEMB.index.json', normalise(data));
  });
});
