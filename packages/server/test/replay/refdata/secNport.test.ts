/**
 * `sec-nport-SPY-primary_doc.xml` → `index_members` + `etf_holdings`, against the real capture.
 *
 * WORKPLAN WP-04 acceptance row `test/replay/refdata/secNport.test.ts` and QA-02. Six properties
 * of the recorded filing are pinned here, every one of them a number this test measured rather
 * than a number the plan asserted:
 *
 *  1. **504 `<invstOrSec>` blocks, 503 `assetCat EC`, 476 distinct CUSIPs, 29 placeholders.**
 *     The gap between 504 holdings and 476 CUSIPs is the whole defect: 29 foreign-domiciled names
 *     publish `<cusip>000000000</cusip>` and are identified only by ISIN.
 *  2. **The 505th `<isin>`.** A document-wide `getElementsByTagName('isin')` finds 505 tags
 *     against 504 holdings, because holding 220 (`CONTRA HOLOGIC INCORPO`, `assetCat DE`) nests a
 *     *reference* instrument's identifiers inside `derivativeInfo`. The scoped traversal must see
 *     504, and each holding's ISIN must be its own — asserted on the holding either side of the
 *     derivative, which is where a one-off shift would first show.
 *  3. **The 29 placeholders resolve by ISIN and write no `identifiers` row.** After the run there
 *     is not one `identifiers` row whose value is all zeros — which is what keeps the second
 *     write of `(CUSIP, '000000000', '')` from raising `identifiers_bt_excl` (23P01).
 *  4. **An unresolved holding becomes `holding_instrument_id NULL` plus a `data_exceptions` row**
 *     of kind `'unresolved_identifier'`, and is excluded from `index_members`.
 *  5. **503 members whose weights sum to ≈ 1**, read back through `membersAsOf` at the N-PORT
 *     `repPdDate`.
 *  6. **A second run writes nothing** — proved by row counts on all five tables, twice: once
 *     through the `repPdDate` freshness gate, and once with `force: true`, which bypasses the gate
 *     and makes the *writes* prove their own idempotence. A boolean return value can lie about
 *     this; `SELECT count(*)` cannot.
 *
 * TESTS ARE SELF-SUFFICIENT (WORKPLAN §0.2). WP-15 owns the seed and does not exist yet, so
 * {@link buildUniverse} creates the 503 constituents this filing names — through this package's
 * own repositories, inside the test's own transaction, from the fixture's own identifiers. The
 * universe it builds is deliberately *bare*: CUSIP rows for the 474 names that publish one, ISIN
 * rows only for the 29 that do not, no LEI anywhere and no `issues.isin`. That is what a symbology
 * seed built from Cboe + OpenFIGI actually holds, and it leaves the N-PORT job with real work to
 * do rather than a database that already agrees with it.
 */

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import {
  NPORT_ADAPTER_VERSION,
  SEC_ARCHIVES_SOURCE_ID,
  SPY_NPORT_URL,
  isIndexEligible,
  parseNport,
  parseXml,
  percentToFraction,
  runSecNport,
} from '../../../src/ingest/jobs/secNport.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { identifierRepository } from '../../../src/refdata/identifiers.js';
import {
  membersAsOf,
  membershipAsOf,
  upsertIndex,
  weightSumAsOf,
} from '../../../src/refdata/indexMembership.js';
import { MasterRepositories } from '../../../src/refdata/master.js';
import { SystemClock } from '@terminal/core';
import { withTxDb } from '../../../src/test/db.js';

import type { Tx } from '../../../src/db/client.js';
import type {
  NportHolding,
  NportParse,
  SecNportResult,
} from '../../../src/ingest/jobs/secNport.js';
import type { RawRecord } from '../../../src/providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The capture, read once
// ─────────────────────────────────────────────────────────────────────────────────────────────

const store = openReplayStore();
const raw: RawRecord = store.replay({ providerId: SEC_ARCHIVES_SOURCE_ID, url: SPY_NPORT_URL });
const xml = raw.body.toString('utf8');
const parse: NportParse = parseNport(xml);

/** The knowledge instant the job is given: SEC's acceptance of this accession. */
const ACCEPTED_AT = new Date('2026-08-28T16:31:00.000Z');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The capture and the parse — no database
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('sec.archives N-PORT replay', () => {
  it('reads the recorded capture, never a socket', () => {
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.providerId).toBe(SEC_ARCHIVES_SOURCE_ID);
    expect(raw.requestKey).toBe(requestKey(SEC_ARCHIVES_SOURCE_ID, 'GET', SPY_NPORT_URL));
    expect(raw.body.byteLength).toBe(454_892);
  });

  it('reads the header that decides both as-of dates', () => {
    expect(parse.header.submissionType).toBe('NPORT-P');
    expect(parse.header.regCik).toBe('0000884394');
    expect(parse.header.regLei).toBe('549300NZAMSJ8FXPQQ63');
    // The entity is decoded, not carried through as `S&amp;P`.
    expect(parse.header.regName).toBe('State Street(R) SPDR(R) S&P 500(R) ETF Trust');
    // `repPdDate` is the portfolio date and the only as-of date; `repPdEnd` is the reporting
    // period end and must never be mistaken for it.
    expect(parse.header.repPdDate).toBe('2026-06-30');
    expect(parse.header.repPdEnd).toBe('2026-09-30');
    expect(parse.header.netAssets).toBeCloseTo(781_188_872_106.76, 2);
    expect(parse.sourceTs?.toISOString()).toBe('2026-07-30T00:00:00.000Z');
    expect(parse.problems).toEqual([]);
  });

  it('counts 504 holdings, 503 EC members, 476 distinct CUSIPs and 29 placeholders', () => {
    expect(parse.holdings).toHaveLength(504);
    expect(parse.holdings.filter((h) => h.assetCat === 'EC')).toHaveLength(503);
    expect(parse.holdings.filter(isIndexEligible)).toHaveLength(503);

    const published = parse.holdings.map((h) => h.cusip).filter((c): c is string => c !== null);
    expect(published).toHaveLength(504);
    expect(new Set(published).size).toBe(476);

    const placeholders = parse.holdings.filter((h) => h.cusipIsPlaceholder);
    expect(placeholders).toHaveLength(29);
    expect(new Set(placeholders.map((h) => h.cusip))).toEqual(new Set(['000000000']));
    // 476 distinct strings, of which one is the placeholder: 475 real CUSIPs + 29 names without
    // one = 504 holdings. The arithmetic only closes because every placeholder is the same string.
    expect(new Set(published).size - 1 + placeholders.length).toBe(504);
    expect(placeholders.every((h) => h.isin !== null)).toBe(true);
  });

  it('never lets the 505th <isin> shift a holding (the nested derivative reference)', () => {
    // Document-wide, the tag appears 505 times; scoped to the holdings, 504.
    expect(xml.match(/<isin\b/g)).toHaveLength(505);
    expect(parse.holdings.filter((h) => h.isin !== null)).toHaveLength(504);

    // Holding 220 is the derivative that carries the extra pair. Its own identifiers are its own,
    // and — the part a one-off shift would break — so are its neighbours'.
    const derivative = parse.holdings[219]!;
    expect(derivative.name).toBe('CONTRA HOLOGIC INCORPO');
    expect(derivative.assetCat).toBe('DE');
    expect(derivative.cusip).toBe('436CVR021');
    expect(derivative.isin).toBe('US436CVR0216');
    // NOT 'US4364401012' — that is the reference instrument nested under `derivativeInfo`.
    expect(derivative.isin).not.toBe('US4364401012');

    const after = parse.holdings[220]!;
    expect(after.isin?.slice(0, 2)).toBe('US');
    expect(after.cusip).not.toBe('436CVR021');
    for (const holding of parse.holdings) {
      expect(holding.isin).not.toBe('US4364401012');
    }
  });

  it('reads named children only — a nested <identifiers> is invisible', () => {
    const root = parseXml(xml);
    const doc = root.children.find((c) => c.name === 'edgarSubmission');
    // `invstOrSecs` is a sibling of `fundInfo` under `formData` in the real capture, not a child
    // of it as PROVIDERS §7.6 writes the path.
    const holdings = doc?.children
      .find((c) => c.name === 'formData')
      ?.children.find((c) => c.name === 'invstOrSecs')
      ?.children.filter((c) => c.name === 'invstOrSec');
    expect(holdings).toHaveLength(504);
    const derivative = holdings?.[219];
    // The derivative's own `identifiers` is a direct child; the reference instrument's is four
    // levels deeper and is never a candidate.
    expect(derivative?.children.filter((c) => c.name === 'identifiers')).toHaveLength(1);
    expect(derivative?.children.some((c) => c.name === 'derivativeInfo')).toBe(true);
  });

  it('turns pctVal (a percent) into a weight (a fraction) without a float round-trip', () => {
    const aflac = parse.holdings[0]!;
    expect(aflac.name).toBe('Aflac Inc');
    expect(aflac.pctVal).toBe('0.083321585405');
    expect(percentToFraction(aflac.pctVal)).toBe('0.00083321585405');
    expect(percentToFraction('7.4123')).toBe('0.074123');
    expect(percentToFraction(null)).toBeNull();
  });

  it('sums to a portfolio: Σ pctVal ≈ 100 and Σ valUSD ≈ netAssets', () => {
    const pct = parse.holdings.reduce((sum, h) => sum + Number(h.pctVal), 0);
    expect(pct).toBeGreaterThan(99);
    expect(pct).toBeLessThan(100.5);
    const value = parse.holdings.reduce((sum, h) => sum + Number(h.valUsd), 0);
    const net = parse.header.netAssets!;
    expect(Math.abs(value - net) / net).toBeLessThan(0.01);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The job, against a universe the test builds for itself
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What {@link buildUniverse} put in the database, so the assertions can name it. */
interface Universe {
  provenanceId: number;
  indexId: number;
  spxInstrumentId: number;
  spyInstrumentId: number;
  /** `instrument_id` by the holding's published ISIN. */
  byIsin: Map<string, number>;
}

const SEED_AT = new Date('2020-01-02T00:00:00.000Z');

async function seedProvenance(tx: Tx): Promise<number> {
  const rows = await tx.execute<{ provenance_id: string }>(sql`
    INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                            http_status, bytes, captured_at, adapter_version)
    VALUES ('internal.derived', 'test:secNport:universe', 'test://secNport/universe',
            sha256('test:secNport:universe'::bytea), sha256('test:secNport:universe'::bytea),
            200, 0, timestamptz '2020-01-02 00:00:00+00', 'test/1.0.0')
    RETURNING provenance_id`);
  return Number(rows.rows[0]!.provenance_id);
}

/** `pctVal` as `index_members.weight` holds it: a fraction at `numeric(12,10)`. */
function roundedWeight(pctVal: string): number {
  return Number(Number(percentToFraction(pctVal)).toFixed(10));
}

/** A stable, obviously synthetic ticker: N-PORT publishes none. */
function syntheticTicker(holding: NportHolding): string {
  return `N${String(holding.lineNo).padStart(4, '0')}`;
}

/**
 * The 503 equity constituents this filing names, plus SPY and SPX.
 *
 * Deliberately incomplete, in the way a real symbology seed is incomplete: a CUSIP identifier for
 * each of the 474 names that publish one, an ISIN identifier only for the 29 that publish
 * `000000000`, and no LEI at all. Share classes of one issuer (Alphabet A/C, Fox A/B, News A/B)
 * share an issuer row, keyed by the filing's LEI — three pairs, so 500 issuers for 503 issues.
 *
 * The 504th holding — the `assetCat DE` contra-rights line — is deliberately **not** built. It is
 * the filing's own unresolvable row, and property 4 above is measured on it.
 */
async function buildUniverse(
  tx: Tx,
  opts: {
    /**
     * One issuer row per holding instead of one per LEI. That is the *other* plausible shape of a
     * half-built universe — a seed keyed on the issue rather than on the issuer — and it is what
     * puts the filing's three share-class pairs (Alphabet A/C, Fox A/B, News A/B) on two issuer
     * rows each while the filing gives both lines the same LEI. The job then has a key that is
     * already claimed by somebody else, which is the REF-10 branch.
     */
    issuerPerHolding?: boolean;
  } = {},
): Promise<Universe> {
  const provenanceId = await seedProvenance(tx);
  const repos = new MasterRepositories(tx);
  const identifiers = identifierRepository(tx);
  const options = { validFrom: SEED_AT, provenanceId, knownAt: SEED_AT };

  const issuerByKey = new Map<string, number>();
  const byIsin = new Map<string, number>();

  for (const holding of parse.holdings) {
    if (holding.assetCat !== 'EC') continue;
    const lei = holding.lei !== null && /^[A-Z0-9]{20}$/.test(holding.lei) ? holding.lei : null;
    const issuerKey =
      opts.issuerPerHolding === true
        ? `line:${String(holding.lineNo)}`
        : (lei ?? `name:${holding.name}:${String(holding.lineNo)}`);
    let issuerId = issuerByKey.get(issuerKey);
    if (issuerId === undefined) {
      issuerId = await repos.issuers.insert({ name: holding.name }, options);
      issuerByKey.set(issuerKey, issuerId);
    }

    const issueId = await repos.issues.insert(
      {
        issuerId,
        assetClass: 'equity',
        securityType: 'Common Stock',
        name: holding.name,
        currency: 'USD',
        // `issues.cusip` only for the names that publish one; `issues.isin` is left for the job.
        ...(holding.cusipIsPlaceholder || holding.cusip === null ? {} : { cusip: holding.cusip }),
      },
      options,
    );

    const instrumentId = await repos.instruments.insert(
      {
        issueId,
        assetClass: 'equity',
        marketSector: 'Equity',
        ticker: syntheticTicker(holding),
        exchCode: 'US',
        name: holding.name,
        currency: 'USD',
      },
      options,
    );
    if (holding.isin !== null) byIsin.set(holding.isin, instrumentId);

    if (holding.cusipIsPlaceholder) {
      // No CUSIP exists for this name — the only key a seed could have written is the ISIN.
      await identifiers.upsert(
        { entityKind: 'issue', entityId: issueId, scheme: 'ISIN', value: holding.isin! },
        options,
      );
    } else {
      await identifiers.upsert(
        { entityKind: 'issue', entityId: issueId, scheme: 'CUSIP', value: holding.cusip! },
        options,
      );
    }
    await identifiers.upsert(
      {
        entityKind: 'instrument',
        entityId: instrumentId,
        scheme: 'TICKER_EXCH',
        value: syntheticTicker(holding),
        qualifier: 'US',
        isPrimary: true,
      },
      options,
    );
  }

  // SPY (the fund whose portfolio this is) and SPX (the index it tracks).
  const trustId = await repos.issuers.insert(
    { name: 'State Street SPDR S&P 500 ETF Trust', cik: '0000884394' },
    options,
  );
  const spyIssue = await repos.issues.insert(
    {
      issuerId: trustId,
      assetClass: 'etf',
      securityType: 'ETP',
      name: 'SPDR S&P 500 ETF Trust',
      currency: 'USD',
    },
    options,
  );
  const spyInstrumentId = await repos.instruments.insert(
    {
      issueId: spyIssue,
      assetClass: 'etf',
      marketSector: 'Equity',
      ticker: 'SPY',
      exchCode: 'US',
      name: 'SPDR S&P 500 ETF Trust',
      currency: 'USD',
    },
    options,
  );

  const spIssuer = await repos.issuers.insert({ name: 'S&P Dow Jones Indices' }, options);
  const spxIssue = await repos.issues.insert(
    {
      issuerId: spIssuer,
      assetClass: 'index',
      securityType: 'Index',
      name: 'S&P 500 Index',
      currency: 'USD',
    },
    options,
  );
  const spxInstrumentId = await repos.instruments.insert(
    {
      issueId: spxIssue,
      assetClass: 'index',
      marketSector: 'Index',
      ticker: 'SPX',
      exchCode: 'INDEX',
      name: 'S&P 500 Index',
      currency: 'USD',
    },
    options,
  );

  const index = await upsertIndex(tx, {
    code: 'SPX',
    instrumentId: spxInstrumentId,
    proxyFundInstrumentId: spyInstrumentId,
    membershipSourceId: SEC_ARCHIVES_SOURCE_ID,
    provider: 'sec.archives',
  });

  return { provenanceId, indexId: index.indexId, spxInstrumentId, spyInstrumentId, byIsin };
}

/** Row counts on every table the job touches — the only honest measure of "wrote nothing". */
interface TableCounts {
  etfHoldings: number;
  indexMembers: number;
  identifiers: number;
  dataExceptions: number;
  dqEvents: number;
  provenance: number;
  issues: number;
}

async function tableCounts(tx: Tx): Promise<TableCounts> {
  const rows = await tx.execute<Record<string, string>>(sql`
    SELECT (SELECT count(*) FROM etf_holdings)    AS etf_holdings,
           (SELECT count(*) FROM index_members)   AS index_members,
           (SELECT count(*) FROM identifiers)     AS identifiers,
           (SELECT count(*) FROM data_exceptions) AS data_exceptions,
           (SELECT count(*) FROM dq_events)       AS dq_events,
           (SELECT count(*) FROM provenance)      AS provenance,
           (SELECT count(*) FROM issues)          AS issues`);
  const row = rows.rows[0]!;
  return {
    etfHoldings: Number(row.etf_holdings),
    indexMembers: Number(row.index_members),
    identifiers: Number(row.identifiers),
    dataExceptions: Number(row.data_exceptions),
    dqEvents: Number(row.dq_events),
    provenance: Number(row.provenance),
    issues: Number(row.issues),
  };
}

describe('runSecNport against the recorded filing', () => {
  const t = withTxDb();
  const clock = new SystemClock();

  // The 503-constituent universe costs one round trip per repository write, so it is built once,
  // inside the single transaction the harness rolls back — not once per assertion.
  let universe: Universe;
  let first: SecNportResult;
  let afterFirst: TableCounts;

  it('writes the filing, and a second run writes nothing', async () => {
    const tx = t.db;
    universe = await buildUniverse(tx);
    const ctx = { tx, clock };

    // ── run 1 ────────────────────────────────────────────────────────────────────────────
    first = await runSecNport(ctx, { acceptedAt: ACCEPTED_AT });
    expect(first.status).toBe('ok');
    expect(first.errors).toEqual([]);
    expect(first.asOfDate).toBe('2026-06-30');
    expect(first.holdings).toBe(504);
    expect(first.indexEligible).toBe(503);
    expect(first.distinctCusips).toBe(476);
    expect(first.placeholderCusips).toBe(29);

    // The defect, measured: every one of the 29 names whose CUSIP is `000000000` was found by
    // its ISIN instead — not by a CUSIP that would have collapsed all 29 onto one entity.
    expect(first.placeholderResolvedByIsin).toBe(29);
    expect(first.resolved).toBe(503);
    expect(first.unresolved).toBe(1);

    // ── etf_holdings: every line of the file, resolved or not ─────────────────────────────
    expect(first.etfHoldings).toEqual({ inserted: 504, updated: 0, unchanged: 0 });
    const holdingRows = await tx.execute<{
      total: string;
      resolved: string;
      unresolved: string;
      zero_cusip: string;
    }>(sql`
        SELECT count(*)                                              AS total,
               count(*) FILTER (WHERE holding_instrument_id IS NOT NULL) AS resolved,
               count(*) FILTER (WHERE holding_instrument_id IS NULL)     AS unresolved,
               count(*) FILTER (WHERE cusip = '000000000')               AS zero_cusip
          FROM etf_holdings
         WHERE etf_instrument_id = ${universe.spyInstrumentId}
           AND as_of_date = '2026-06-30'
           AND source_id = ${SEC_ARCHIVES_SOURCE_ID}`);
    expect(holdingRows.rows[0]).toEqual({
      total: '504',
      resolved: '503',
      unresolved: '1',
      zero_cusip: '0',
    });

    // ── the unresolved line: NULL holding + one data_exceptions row ───────────────────────
    const unresolved = await tx.execute<{ line_no: number; name: string }>(sql`
        SELECT line_no, name FROM etf_holdings
         WHERE etf_instrument_id = ${universe.spyInstrumentId}
           AND as_of_date = '2026-06-30'
           AND source_id = ${SEC_ARCHIVES_SOURCE_ID}
           AND holding_instrument_id IS NULL`);
    expect(unresolved.rows).toHaveLength(1);
    expect(unresolved.rows[0]?.name).toBe('CONTRA HOLOGIC INCORPO');
    expect(unresolved.rows[0]?.line_no).toBe(220);

    const exceptions = await tx.execute<{ kind: string; field: string; key: string }>(sql`
        SELECT kind, field, candidates -> 0 -> 'value' ->> 'key' AS key
          FROM data_exceptions
         WHERE kind = 'unresolved_identifier'`);
    expect(exceptions.rows).toHaveLength(1);
    expect(exceptions.rows[0]?.field).toBe('holding_instrument_id');
    expect(exceptions.rows[0]?.key).toBe('sec.archives:2026-06-30:220');
    expect(first.exceptionsWritten).toBe(1);
    expect(first.conflictsWritten).toBe(0);

    // ── NO identifiers row for a placeholder, ever ────────────────────────────────────────
    const placeholderIdentifiers = await tx.execute<{ count: string }>(sql`
        SELECT count(*) AS count FROM identifiers
         WHERE value ~ '^[0\\s\\-_.*#]*$' OR value = '000000000'`);
    expect(placeholderIdentifiers.rows[0]?.count).toBe('0');

    // …while the names that *do* publish an ISIN got one. The seeded universe held CUSIPs only
    // for the 474 non-placeholder names, so the job's ISIN writes are real work.
    const isinCount = await tx.execute<{ count: string }>(sql`
        SELECT count(*) AS count FROM identifiers WHERE scheme = 'ISIN'`);
    expect(Number(isinCount.rows[0]?.count)).toBe(503);
    expect(first.identifiersWritten).toBeGreaterThan(0);

    // 474 CUSIP rows and not one more: the 29 placeholder names contributed none, so the count is
    // exactly what the seed wrote.
    const seededCusips = parse.holdings.filter(
      (h) => h.assetCat === 'EC' && !h.cusipIsPlaceholder,
    ).length;
    expect(seededCusips).toBe(474);
    const cusipCount = await tx.execute<{ count: string }>(sql`
        SELECT count(*) AS count FROM identifiers WHERE scheme = 'CUSIP'`);
    expect(Number(cusipCount.rows[0]?.count)).toBe(seededCusips);

    // And nothing was silently re-pointed. `upsertVersion` would happily close the version that
    // says a CUSIP belongs to issue A and open one saying issue B; the job refuses and files a
    // `source_conflict` instead, so zero of those rows is zero re-points.
    const conflicts = await tx.execute<{ count: string }>(sql`
        SELECT count(*) AS count FROM data_exceptions WHERE kind = 'source_conflict'`);
    expect(conflicts.rows[0]?.count).toBe('0');

    // ── index_members: 503 constituents whose weights sum to ≈ 1 ──────────────────────────
    expect(first.members.written).toBe(503);
    expect(first.members.unchanged).toBe(0);
    expect(first.members.retired).toBe(0);

    const at = membershipAsOf('2026-06-30', ACCEPTED_AT);
    const members = await membersAsOf(tx, universe.indexId, at);
    expect(members).toHaveLength(503);
    expect(new Set(members.map((m) => m.instrumentId)).size).toBe(503);
    expect(members.every((m) => m.sourceId === SEC_ARCHIVES_SOURCE_ID)).toBe(true);
    expect(members.every((m) => m.asOfDate === '2026-06-30')).toBe(true);

    const weightSum = await weightSumAsOf(tx, universe.indexId, at);
    expect(weightSum).toBeGreaterThan(0.99);
    expect(weightSum).toBeLessThan(1.005);

    // The heaviest constituent carries the filing's own numbers, unrounded.
    const heaviest = members[0]!;
    const heaviestHolding = parse.holdings
      .filter(isIndexEligible)
      .sort((a, b) => Number(b.pctVal) - Number(a.pctVal))[0]!;
    expect(heaviest.instrumentId).toBe(universe.byIsin.get(heaviestHolding.isin!));
    // `index_members.weight` is `numeric(12,10)`: the filing publishes 12 decimals of `pctVal`,
    // the column keeps 10 of the fraction. Asserting the column's own precision, not a float.
    expect(heaviest.weight).toBe(roundedWeight(heaviestHolding.pctVal!));
    expect(heaviest.shares).toBeCloseTo(Number(heaviestHolding.balance), 4);
    expect(heaviest.marketValue).toBeCloseTo(Number(heaviestHolding.valUsd), 2);

    // A placeholder name is a full member, with the filing's weight, found by its ISIN alone.
    const allegion = parse.holdings.find((h) => h.name === 'Allegion plc')!;
    expect(allegion.cusip).toBe('000000000');
    expect(allegion.isin).toBe('IE00BFRT3W74');
    const allegionId = universe.byIsin.get('IE00BFRT3W74')!;
    const allegionMember = members.find((m) => m.instrumentId === allegionId);
    expect(allegionMember).toBeDefined();
    expect(allegionMember?.weight).toBe(roundedWeight(allegion.pctVal!));

    // ── provenance is cited by every row the run wrote ────────────────────────────────────
    expect(first.provenanceId).not.toBeNull();
    const provenanceRow = await tx.execute<{
      source_id: string;
      adapter_version: string;
      source_ts: Date | null;
      http_status: number;
    }>(sql`SELECT source_id, adapter_version, source_ts, http_status
               FROM provenance WHERE provenance_id = ${first.provenanceId}`);
    expect(provenanceRow.rows[0]?.source_id).toBe(SEC_ARCHIVES_SOURCE_ID);
    expect(provenanceRow.rows[0]?.adapter_version).toBe(NPORT_ADAPTER_VERSION);
    expect(provenanceRow.rows[0]?.http_status).toBe(200);
    const orphans = await tx.execute<{ count: string }>(sql`
        SELECT count(*) AS count FROM etf_holdings
         WHERE as_of_date = '2026-06-30' AND provenance_id <> ${first.provenanceId}`);
    expect(orphans.rows[0]?.count).toBe('0');

    afterFirst = await tableCounts(tx);

    // ── run 2: the freshness gate. `repPdDate` is not newer, so nothing happens at all. ────
    const second = await runSecNport(ctx, { acceptedAt: ACCEPTED_AT });
    expect(second.status).toBe('skipped');
    expect(second.provenanceId).toBeNull();
    expect(await tableCounts(tx)).toEqual(afterFirst);

    // ── run 3: `force` bypasses the gate, so the WRITES have to prove their own idempotence.
    //    A new provenance row is written (a fetch happened); not one data row is.
    const third = await runSecNport(ctx, { acceptedAt: ACCEPTED_AT, force: true });
    expect(third.status).toBe('ok');
    expect(third.errors).toEqual([]);
    expect(third.etfHoldings).toEqual({ inserted: 0, updated: 0, unchanged: 504 });
    expect(third.members).toEqual({ written: 0, unchanged: 503, retired: 0 });
    expect(third.identifiersWritten).toBe(0);
    expect(third.exceptionsWritten).toBe(0);
    expect(third.dqEventsWritten).toBe(0);

    const afterThird = await tableCounts(tx);
    expect(afterThird).toEqual({
      ...afterFirst,
      // The only row a forced re-run adds anywhere: the provenance of the second fetch.
      provenance: afterFirst.provenance + 1,
    });

    // …and the membership read is byte-identical, versions included.
    const membersAgain = await membersAsOf(tx, universe.indexId, at);
    expect(membersAgain.map((m) => m.versionId)).toEqual(members.map((m) => m.versionId));
  }, 180_000);
});

/**
 * Property 7: **the conflict branch runs, and every row it writes is counted.**
 *
 * Guard 3 of `writeHoldingIdentifiers` refuses to re-point an identifier that already belongs to
 * another entity and files a `data_exceptions` row of kind `'source_conflict'` instead (REF-10).
 * The universe above never reaches that branch — it keys issuers by LEI, so the filing's three
 * share-class pairs are pre-collapsed and the key the job wants is already its own. Built the
 * other way, with one issuer per holding, the same filing hands the job three LEIs that belong to
 * somebody else, and the run must: refuse all three, write no `identifiers` row for them, leave
 * the first claimant in place, and report four `data_exceptions` rows rather than one.
 */
describe('runSecNport against a universe with one issuer per holding', () => {
  const t = withTxDb();
  const clock = new SystemClock();

  it('refuses to re-point a shared LEI, and counts the conflicts it files', async () => {
    const tx = t.db;
    const universe = await buildUniverse(tx, { issuerPerHolding: true });
    const result = await runSecNport({ tx, clock }, { acceptedAt: ACCEPTED_AT });

    expect(result.status).toBe('ok');
    expect(result.errors).toEqual([]);
    // The filing is written exactly as before — the conflicts cost three identifier rows, not a
    // constituent: 503 members in the index this universe configured.
    expect(result.members.written).toBe(503);
    expect(
      await membersAsOf(tx, universe.indexId, membershipAsOf('2026-06-30', ACCEPTED_AT)),
    ).toHaveLength(503);

    // The three pairs the filing publishes under one LEI each, derived from the capture rather
    // than hard-coded: an LEI that appears on more than one `assetCat EC` holding.
    const leiLines = new Map<string, number[]>();
    for (const holding of parse.holdings) {
      if (holding.assetCat !== 'EC' || holding.lei === null) continue;
      if (!/^[A-Z0-9]{20}$/.test(holding.lei)) continue;
      leiLines.set(holding.lei, [...(leiLines.get(holding.lei) ?? []), holding.lineNo]);
    }
    const shared = [...leiLines.entries()].filter(([, lines]) => lines.length > 1);
    expect(shared).toHaveLength(3);

    const conflicts = await tx.execute<{ field: string; entity_kind: string; value: string }>(sql`
        SELECT field, entity_kind, candidates -> 0 -> 'value' ->> 'value' AS value
          FROM data_exceptions
         WHERE kind = 'source_conflict'
         ORDER BY value`);
    expect(conflicts.rows.map((r) => r.value)).toEqual(shared.map(([lei]) => lei).sort());
    expect(conflicts.rows.every((r) => r.field === 'LEI')).toBe(true);
    expect(conflicts.rows.every((r) => r.entity_kind === 'issuer')).toBe(true);

    // The counter is the whole point of this test: 3 conflicts + the one unresolved holding.
    expect(result.conflictsWritten).toBe(3);
    expect(result.exceptionsWritten).toBe(4);
    const total = await tx.execute<{ count: string }>(sql`
        SELECT count(*) AS count FROM data_exceptions`);
    expect(Number(total.rows[0]?.count)).toBe(result.exceptionsWritten);

    // Refused means refused: one LEI identifier per distinct LEI, each still pointing at the
    // issuer that claimed it first, and no version of it was ever closed.
    const leiRows = await tx.execute<{ count: string; versions: string }>(sql`
        SELECT count(*) FILTER (WHERE tx_to = 'infinity') AS count,
               count(*)                                   AS versions
          FROM identifiers WHERE scheme = 'LEI'`);
    expect(Number(leiRows.rows[0]?.count)).toBe(leiLines.size);
    expect(Number(leiRows.rows[0]?.versions)).toBe(leiLines.size);

    for (const [lei, lines] of shared) {
      const owner = await tx.execute<{ entity_id: string; name: string }>(sql`
          SELECT i.entity_id, iss.name
            FROM identifiers i
            JOIN issuers iss ON iss.issuer_id = i.entity_id AND iss.tx_to = 'infinity'
           WHERE i.scheme = 'LEI' AND i.value = ${lei} AND i.tx_to = 'infinity'`);
      expect(owner.rows).toHaveLength(1);
      // The first line of the pair is the one that got there first; the second was refused.
      const firstName = parse.holdings.find((h) => h.lineNo === lines[0])?.name;
      expect(owner.rows[0]?.name).toBe(firstName);
    }

    // A second forced run files nothing new: the conflict queue is deduped on the key.
    const again = await runSecNport({ tx, clock }, { acceptedAt: ACCEPTED_AT, force: true });
    expect(again.status).toBe('ok');
    expect(again.conflictsWritten).toBe(0);
    expect(again.exceptionsWritten).toBe(0);
    const totalAgain = await tx.execute<{ count: string }>(sql`
        SELECT count(*) AS count FROM data_exceptions`);
    expect(Number(totalAgain.rows[0]?.count)).toBe(4);
  }, 180_000);
});
