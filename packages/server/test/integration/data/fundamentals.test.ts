/**
 * `data/fundamentals.ts` — STOR-06, the point-in-time read (WORKPLAN §WP-04 acceptance row 7:
 * "the same `period_end` returns the originally filed value at `knownAt` = filing date and the
 * restated value later").
 *
 * The story this file tells is one quarter of one filer, told twice:
 *
 *   * 2025-10-30 — the 10-Q reports revenue 94,930,000,000 for the quarter ended 2025-09-30;
 *   * 2026-02-27 — the 10-K restates that same quarter to 93,180,000,000.
 *
 * Both numbers are true; they differ in *when they were true of our knowledge*. A screen re-run
 * as of November 2025 must show the first, and one re-run in March 2026 must show the second.
 * A reader that ignores `filed_at` returns the restatement for both and every backtest built on
 * it is quietly wrong — the shape of the answer is right, so nothing ever fails loudly. That is
 * the failure these assertions exist to make impossible, and it is asserted on both
 * point-in-time surfaces: `xbrl_facts` (`facts`) and `fin_statements` (`statements`).
 *
 * **Self-sufficient by construction** (TESTING §4.3): WP-15 owns the seed modules, so every row
 * read here is written by this file, through this package's own code where it exists
 * (`refdata/master.ts` for the issuer) and through the drizzle mirror for the two derived tables
 * whose writers belong to WP-05's ingest jobs. Everything happens inside the harness's single
 * transaction and is rolled back; no assertion depends on a seeded row or on a literal sequence
 * value.
 */

import { describe, expect, it } from 'vitest';

import {
  FundamentalsService,
  knownAtDay,
  parseConceptRef,
  parseFrameConcept,
} from '../../../src/data/fundamentals.js';
import { finStatements, xbrlFacts, xbrlFrames } from '../../../src/db/schema/fundamentals.js';
import { MasterRepositories } from '../../../src/refdata/master.js';
import { withTxDb } from '../../../src/test/db.js';

import type { TestDb } from '../../../src/test/db.js';

// ── the quarter, and the two filings that describe it ────────────────────────────────────────

const PERIOD_START = '2025-07-01';
const PERIOD_END = '2025-09-30';

/** The 10-Q. */
const FILED_ORIGINAL = '2025-10-30';
const ACCN_ORIGINAL = '0009000000-25-000031';
const REVENUE_ORIGINAL = '94930000000.00';
const NET_INC_ORIGINAL = '23430000000.00';
const EPS_DIL_ORIGINAL = '1.5300';

/** The 10-K four months later, restating the same `period_end`. */
const FILED_RESTATED = '2026-02-27';
const ACCN_RESTATED = '0009000000-26-000009';
const REVENUE_RESTATED = '93180000000.00';
const NET_INC_RESTATED = '22110000000.00';
const EPS_DIL_RESTATED = '1.4400';

/** The three vantage points. */
const BEFORE_ANYTHING = new Date('2025-10-29T12:00:00Z');
const AT_FILING = new Date('2025-10-30T00:00:00Z');
const AFTER_RESTATEMENT = new Date('2026-03-15T00:00:00Z');
/** The SEC frames API is captured in the evening of the filing day, not at midnight. */
const AFTER_FIRST_FRAME_CAPTURE = new Date('2025-10-31T00:00:00Z');

/**
 * Valid-time / knowledge instants for the issuer's master row. The issuer has to be *known*
 * before the filing is, or a read as of the filing date resolves no issuer at all — which is
 * correct bitemporal behaviour and exactly what `statementsForCik` asserts below.
 */
const V_2000 = new Date('2000-01-01T00:00:00Z');
const K1 = new Date('2010-01-04T00:00:00Z');

/**
 * A CIK no real filer holds (EDGAR has never allocated a 9-prefixed one) and no fixture uses, so
 * the fixture cannot collide with a seeded issuer. The fixture asserts that before it writes.
 */
const CIK = '9000000001';

const CONCEPT = 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax';
const MAPPING_VERSION = 'std-map/2026.09';
const HASH = 'a'.repeat(64);

interface Fixture {
  svc: FundamentalsService;
  issuerId: number;
  provenanceOriginal: number;
  provenanceRestated: number;
}

/** `assert_source_known` gates `provenance`: the licence row has to exist first (DATA-09). */
async function ensureLicence(t: TestDb, sourceId: string, kind: string): Promise<void> {
  await t.client.query(
    `INSERT INTO licence_registry (source_id, source_name, publisher, licence_kind, attribution,
                                   rate_limit, valid_from)
     SELECT $1, $1, 'Test', $2, 'Test fixture', 'n/a', timestamptz '2000-01-01'
      WHERE NOT EXISTS (SELECT 1 FROM licence_registry WHERE source_id = $1 AND tx_to = 'infinity')`,
    [sourceId, kind],
  );
}

async function provenanceRow(t: TestDb, label: string, capturedAt: string): Promise<number> {
  const key = `${label}-${capturedAt}`;
  const res = await t.client.query<{ provenance_id: string }>(
    `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                             http_status, bytes, captured_at, adapter_version)
     VALUES ('sec.companyfacts', $1, 'test://fundamentals/' || $1, digest($1, 'sha256'),
             digest($1, 'sha256'), 200, 0, $2, 'test/1.0.0')
     RETURNING provenance_id`,
    [key, capturedAt],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error('provenance insert returned no row');
  return Number(row.provenance_id);
}

/**
 * One issuer, one XBRL fact filed twice and one standardised statement filed twice — the same
 * `period_end` in every case.
 */
async function fixture(t: TestDb): Promise<Fixture> {
  await ensureLicence(t, 'internal.user', 'internal');
  await ensureLicence(t, 'sec.companyfacts', 'public_domain');

  const clash = await t.client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM issuers WHERE cik = $1 AND tx_to = 'infinity'`,
    [CIK],
  );
  expect(clash.rows[0]?.n, `CIK ${CIK} is reserved for this fixture`).toBe('0');

  const pIssuer = await provenanceRow(t, 'issuer', K1.toISOString());
  const provenanceOriginal = await provenanceRow(
    t,
    'companyfacts-q3',
    `${FILED_ORIGINAL}T21:04:00Z`,
  );
  const provenanceRestated = await provenanceRow(
    t,
    'companyfacts-fy',
    `${FILED_RESTATED}T21:11:00Z`,
  );

  const master = new MasterRepositories(t.db);
  const issuerId = await master.issuers.insert(
    {
      name: 'Pitco Inc.',
      legalName: 'Point In Time Company Incorporated',
      cik: CIK,
      country: 'US',
      sic: '3571',
      entityType: 'operating',
      fiscalYearEnd: '0930',
    },
    { validFrom: V_2000, provenanceId: pIssuer, knownAt: K1 },
  );

  // Two XBRL vintages of one quarter: different accession numbers, the same period.
  await t.db.insert(xbrlFacts).values([
    {
      cik: CIK,
      issuerId,
      taxonomy: 'us-gaap',
      concept: 'RevenueFromContractWithCustomerExcludingAssessedTax',
      unit: 'USD',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      fy: 2025,
      fp: 'Q3',
      form: '10-Q',
      accessionNo: ACCN_ORIGINAL,
      filedAt: FILED_ORIGINAL,
      frame: 'CY2025Q3',
      value: REVENUE_ORIGINAL,
      capturedAt: `${FILED_ORIGINAL}T21:04:00Z`,
      provenanceId: provenanceOriginal,
    },
    {
      cik: CIK,
      issuerId,
      taxonomy: 'us-gaap',
      concept: 'RevenueFromContractWithCustomerExcludingAssessedTax',
      unit: 'USD',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      fy: 2025,
      fp: 'Q3',
      form: '10-K',
      accessionNo: ACCN_RESTATED,
      filedAt: FILED_RESTATED,
      frame: 'CY2025Q3',
      value: REVENUE_RESTATED,
      capturedAt: `${FILED_RESTATED}T21:11:00Z`,
      provenanceId: provenanceRestated,
    },
  ]);

  // The same two vintages, standardised. `filed_at` is part of the primary key, which is what
  // lets a restatement be a row rather than an UPDATE.
  await t.db.insert(finStatements).values([
    {
      issuerId,
      periodEnd: PERIOD_END,
      periodType: 'Q',
      filedAt: FILED_ORIGINAL,
      mappingVersion: MAPPING_VERSION,
      fiscalYear: 2025,
      fiscalPeriod: 'Q3',
      accessionNo: ACCN_ORIGINAL,
      currency: 'USD',
      revenue: REVENUE_ORIGINAL,
      netInc: NET_INC_ORIGINAL,
      epsDil: EPS_DIL_ORIGINAL,
      asReported: {
        REVENUE: {
          concept: 'RevenueFromContractWithCustomerExcludingAssessedTax',
          value: REVENUE_ORIGINAL,
        },
      },
      builtAt: `${FILED_ORIGINAL}T22:00:00Z`,
      engineName: 'fundamentals/std-map',
      engineVersion: MAPPING_VERSION,
      inputsHash: HASH,
      provenanceIds: [provenanceOriginal],
    },
    {
      issuerId,
      periodEnd: PERIOD_END,
      periodType: 'Q',
      filedAt: FILED_RESTATED,
      mappingVersion: MAPPING_VERSION,
      fiscalYear: 2025,
      fiscalPeriod: 'Q3',
      accessionNo: ACCN_RESTATED,
      currency: 'USD',
      revenue: REVENUE_RESTATED,
      netInc: NET_INC_RESTATED,
      epsDil: EPS_DIL_RESTATED,
      asReported: {
        REVENUE: {
          concept: 'RevenueFromContractWithCustomerExcludingAssessedTax',
          value: REVENUE_RESTATED,
        },
      },
      builtAt: `${FILED_RESTATED}T22:00:00Z`,
      engineName: 'fundamentals/std-map',
      engineVersion: MAPPING_VERSION,
      inputsHash: HASH,
      provenanceIds: [provenanceRestated],
    },
  ]);

  return {
    svc: new FundamentalsService(t.db),
    issuerId,
    provenanceOriginal,
    provenanceRestated,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('data/fundamentals point-in-time (STOR-06)', () => {
  const t = withTxDb();

  it('facts: the same period_end returns the originally filed value at the filing date and the restatement later', async () => {
    const f = await fixture(t);
    const q = { cik: CIK, concepts: [CONCEPT], unit: 'USD', periods: 'Q' as const };

    const asKnownThen = await f.svc.facts(q, AT_FILING);
    expect(asKnownThen).toHaveLength(1);
    expect(asKnownThen[0]?.periodEnd).toBe(PERIOD_END);
    expect(asKnownThen[0]?.value).toBe(94_930_000_000);
    expect(asKnownThen[0]?.filedAt).toBe(FILED_ORIGINAL);
    expect(asKnownThen[0]?.accessionNo).toBe(ACCN_ORIGINAL);
    expect(asKnownThen[0]?.form).toBe('10-Q');

    const asKnownNow = await f.svc.facts(q, AFTER_RESTATEMENT);
    expect(asKnownNow).toHaveLength(1);
    // The same quarter — this is the whole point: one period_end, two answers.
    expect(asKnownNow[0]?.periodEnd).toBe(PERIOD_END);
    expect(asKnownNow[0]?.value).toBe(93_180_000_000);
    expect(asKnownNow[0]?.filedAt).toBe(FILED_RESTATED);
    expect(asKnownNow[0]?.accessionNo).toBe(ACCN_RESTATED);

    // Before either filing there is nothing to know — not a zero, not the restatement.
    expect(await f.svc.facts(q, BEFORE_ANYTHING)).toEqual([]);
  });

  it('facts: every returned value is stamped with the provenance of the filing it came from', async () => {
    const f = await fixture(t);
    const q = { cik: CIK, concepts: [CONCEPT], periods: 'Q' as const };

    expect((await f.svc.facts(q, AT_FILING))[0]?.provenanceId).toBe(f.provenanceOriginal);
    expect((await f.svc.facts(q, AFTER_RESTATEMENT))[0]?.provenanceId).toBe(f.provenanceRestated);
  });

  it('factVintages: the restatement history is visible, and is itself bounded by knownAt', async () => {
    const f = await fixture(t);
    const q = { cik: CIK, concept: CONCEPT, unit: 'USD', periodEnd: PERIOD_END };

    const atFiling = await f.svc.factVintages(q, AT_FILING);
    expect(atFiling.map((v) => v.filedAt)).toEqual([FILED_ORIGINAL]);

    const later = await f.svc.factVintages(q, AFTER_RESTATEMENT);
    expect(later.map((v) => v.filedAt)).toEqual([FILED_ORIGINAL, FILED_RESTATED]);
    expect(later.map((v) => v.value)).toEqual([94_930_000_000, 93_180_000_000]);
  });

  it('statements: the same period_end is the originally filed row at the filing date and the restatement later', async () => {
    const f = await fixture(t);

    const then = await f.svc.statements(f.issuerId, 'Q', AT_FILING);
    expect(then).toHaveLength(1);
    expect(then[0]?.periodEnd).toBe(PERIOD_END);
    expect(then[0]?.revenue).toBe(94_930_000_000);
    expect(then[0]?.netInc).toBe(23_430_000_000);
    expect(then[0]?.epsDil).toBe(1.53);
    expect(then[0]?.filedAt).toBe(FILED_ORIGINAL);
    expect(then[0]?.accessionNo).toBe(ACCN_ORIGINAL);
    // Only one version was public then, so nothing is marked as restated.
    expect(then[0]?.restated).toBe(false);
    expect(then[0]?.versions).toBe(1);
    expect(then[0]?.provenanceIds).toEqual([f.provenanceOriginal]);

    const now = await f.svc.statements(f.issuerId, 'Q', AFTER_RESTATEMENT);
    expect(now).toHaveLength(1);
    expect(now[0]?.periodEnd).toBe(PERIOD_END);
    expect(now[0]?.revenue).toBe(93_180_000_000);
    expect(now[0]?.netInc).toBe(22_110_000_000);
    expect(now[0]?.epsDil).toBe(1.44);
    expect(now[0]?.filedAt).toBe(FILED_RESTATED);
    expect(now[0]?.accessionNo).toBe(ACCN_RESTATED);
    // …and now FA can tell the user the number moved.
    expect(now[0]?.restated).toBe(true);
    expect(now[0]?.versions).toBe(2);
    expect(now[0]?.provenanceIds).toEqual([f.provenanceRestated]);

    expect(await f.svc.statements(f.issuerId, 'Q', BEFORE_ANYTHING)).toEqual([]);
  });

  it('makes a filing knowable from 00:00 UTC of its filing day — up to ~24 h of look-ahead', async () => {
    // `filed_at` is a DATE (the SEC publishes a filing *date*, not an instant) and `knownAtDay`
    // reduces `knownAt` to its UTC calendar day, so a 10-K filed on D is returned by a read at
    // D 00:00:00Z — hours before it was actually accepted. That is a deliberate contract choice
    // (file header), not an accident, and it is the widest look-ahead any point-in-time read in
    // this package has: a caller that cannot afford it reads `filings.accepted_at` through
    // `data/filings.ts`, which carries the true instant. Pinned here so that a later change to
    // `knownAtDay` — a local-time slice, or `filed_at < day` — cannot widen or narrow the window
    // in silence and invalidate every backtest built on it.
    const f = await fixture(t);
    const midnightOfFiling = new Date(`${FILED_RESTATED}T00:00:00Z`);
    const earlyOnFilingDay = new Date(`${FILED_RESTATED}T02:00:00Z`);
    const lastSecondBefore = new Date('2026-02-26T23:59:59.999Z');

    // Present from the first instant of the filing day…
    for (const knownAt of [midnightOfFiling, earlyOnFilingDay]) {
      const rows = await f.svc.statements(f.issuerId, 'Q', knownAt);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.filedAt).toBe(FILED_RESTATED);
      expect(rows[0]?.revenue).toBe(93_180_000_000);
      expect(rows[0]?.restated).toBe(true);
    }

    // …and absent one millisecond earlier, where the read still answers with the 10-Q.
    const before = await f.svc.statements(f.issuerId, 'Q', lastSecondBefore);
    expect(before).toHaveLength(1);
    expect(before[0]?.filedAt).toBe(FILED_ORIGINAL);
    expect(before[0]?.revenue).toBe(94_930_000_000);
    expect(before[0]?.restated).toBe(false);

    // The same boundary on the `xbrl_facts` surface.
    const q = { cik: CIK, concepts: [CONCEPT], unit: 'USD', periods: 'Q' as const };
    expect((await f.svc.facts(q, midnightOfFiling))[0]?.filedAt).toBe(FILED_RESTATED);
    expect((await f.svc.facts(q, lastSecondBefore))[0]?.filedAt).toBe(FILED_ORIGINAL);
  });

  it('statements: one row per period, never one per vintage', async () => {
    const f = await fixture(t);
    const rows = await f.svc.statements(f.issuerId, 'Q', AFTER_RESTATEMENT, 50);
    expect(rows).toHaveLength(1);
    expect(rows.map((r) => r.periodEnd)).toEqual([PERIOD_END]);
  });

  it('statementsForCik: the CIK-keyed read resolves the issuer and answers identically', async () => {
    const f = await fixture(t);

    const then = await f.svc.statementsForCik(CIK, {
      statement: 'IS',
      periodType: 'Q',
      periods: 4,
      knownAt: AT_FILING,
    });
    expect(then.map((r) => r.revenue)).toEqual([94_930_000_000]);

    const now = await f.svc.statementsForCik(CIK, {
      statement: 'IS',
      periodType: 'Q',
      periods: 4,
      knownAt: AFTER_RESTATEMENT,
    });
    expect(now.map((r) => r.revenue)).toEqual([93_180_000_000]);

    // An unknown CIK is empty, and `resolveIssuerId` is how a caller tells that apart from
    // "issuer known, nothing ingested".
    expect(
      await f.svc.statementsForCik('9000000999', {
        periodType: 'Q',
        periods: 4,
        knownAt: AFTER_RESTATEMENT,
      }),
    ).toEqual([]);
    const at = { validAt: AFTER_RESTATEMENT, knownAt: AFTER_RESTATEMENT };
    expect(await f.svc.resolveIssuerId('9000000999', at)).toBeNull();
    expect(await f.svc.resolveIssuerId(CIK, at)).toBe(f.issuerId);
  });

  it('there is no read that omits knownAt', async () => {
    const f = await fixture(t);
    // Arity is the mechanical form of the rule: `Function.length` counts the parameters before
    // the first one with a default, so a `knownAt = new Date()` added to any of these — the one
    // change that would make every historical read silently wrong — drops the count and fails
    // here (ARCHITECTURE §13, DATA_MODEL §8.1).
    expect(FundamentalsService.prototype.facts.length).toBe(2);
    expect(FundamentalsService.prototype.factVintages.length).toBe(2);
    expect(FundamentalsService.prototype.statements.length).toBe(3);
    expect(FundamentalsService.prototype.crossSection.length).toBe(3);
    expect(FundamentalsService.prototype.frames.length).toBe(3);
    // …and an unusable instant is refused rather than turned into a wide-open read.
    await expect(
      f.svc.facts({ cik: CIK, concepts: [CONCEPT], periods: 'Q' }, new Date(Number.NaN)),
    ).rejects.toThrow(/knownAt must be a valid Date/);
  });

  it('frames: the EQS cross-section is bounded by knownAt too', async () => {
    const f = await fixture(t);
    await t.db.insert(xbrlFrames).values([
      {
        taxonomy: 'us-gaap',
        concept: 'Assets',
        unit: 'USD',
        frame: 'CY2025Q3I',
        cik: CIK,
        issuerId: f.issuerId,
        accessionNo: ACCN_ORIGINAL,
        periodEnd: PERIOD_END,
        value: '364980000000.000000',
        filedAt: FILED_ORIGINAL,
        capturedAt: `${FILED_ORIGINAL}T23:00:00Z`,
        provenanceId: f.provenanceOriginal,
      },
      {
        taxonomy: 'us-gaap',
        concept: 'Assets',
        unit: 'USD',
        frame: 'CY2025Q3I',
        cik: '9000000002',
        issuerId: null,
        accessionNo: ACCN_RESTATED,
        periodEnd: PERIOD_END,
        value: '211000000000.000000',
        filedAt: FILED_RESTATED,
        capturedAt: `${FILED_RESTATED}T23:00:00Z`,
        provenanceId: f.provenanceRestated,
      },
    ]);

    // `xbrl_frames` carries no filing vintage of its own, so its point-in-time bound is the
    // capture instant: at midnight on the filing day the frame had not been fetched yet.
    expect([...(await f.svc.frames('us-gaap:Assets/USD', 'CY2025Q3I', AT_FILING)).keys()]).toEqual(
      [],
    );

    const early = await f.svc.frames('us-gaap:Assets/USD', 'CY2025Q3I', AFTER_FIRST_FRAME_CAPTURE);
    expect([...early.keys()]).toEqual([CIK]);
    expect(early.get(CIK)).toBe(364_980_000_000);

    const late = await f.svc.frames('us-gaap:Assets/USD', 'CY2025Q3I', AFTER_RESTATEMENT);
    expect([...late.keys()].sort()).toEqual([CIK, '9000000002'].sort());

    const rows = await f.svc.crossSection('us-gaap:Assets', 'CY2025Q3I', AFTER_RESTATEMENT);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.provenanceId > 0)).toBe(true);
  });

  it('facts: the period selector separates duration facts from instant ones', async () => {
    const f = await fixture(t);
    await t.db.insert(xbrlFacts).values({
      cik: CIK,
      issuerId: f.issuerId,
      taxonomy: 'dei',
      concept: 'EntityCommonStockSharesOutstanding',
      unit: 'shares',
      periodStart: null,
      periodEnd: PERIOD_END,
      fy: 2025,
      fp: 'Q3',
      form: '10-Q',
      accessionNo: ACCN_ORIGINAL,
      filedAt: FILED_ORIGINAL,
      frame: null,
      value: '14840000000.000000',
      capturedAt: `${FILED_ORIGINAL}T21:04:00Z`,
      provenanceId: f.provenanceOriginal,
    });

    const instant = await f.svc.facts(
      {
        cik: CIK,
        concepts: ['dei:EntityCommonStockSharesOutstanding', CONCEPT],
        periods: 'instant',
      },
      AFTER_RESTATEMENT,
    );
    expect(instant.map((r) => r.concept)).toEqual(['EntityCommonStockSharesOutstanding']);
    expect(instant[0]?.value).toBe(14_840_000_000);

    const quarterly = await f.svc.facts(
      {
        cik: CIK,
        concepts: ['dei:EntityCommonStockSharesOutstanding', CONCEPT],
        periods: 'Q',
      },
      AFTER_RESTATEMENT,
    );
    expect(quarterly.map((r) => r.concept)).toEqual([
      'RevenueFromContractWithCustomerExcludingAssessedTax',
    ]);
  });
});

describe('data/fundamentals helpers', () => {
  it('knownAtDay is the UTC calendar day a filing becomes knowable', () => {
    expect(knownAtDay(new Date('2025-10-30T23:59:59.999Z'))).toBe('2025-10-30');
    expect(knownAtDay(new Date('2025-10-31T00:00:00.000Z'))).toBe('2025-10-31');
    expect(() => knownAtDay(new Date(Number.NaN))).toThrow(/knownAt must be a valid Date/);
  });

  it('concept references parse with and without a taxonomy and a unit', () => {
    expect(parseConceptRef('us-gaap:Revenues')).toEqual({
      taxonomy: 'us-gaap',
      concept: 'Revenues',
    });
    expect(parseConceptRef('Revenues')).toEqual({ taxonomy: null, concept: 'Revenues' });
    expect(parseFrameConcept('us-gaap:Assets/USD')).toEqual({
      taxonomy: 'us-gaap',
      concept: 'Assets',
      unit: 'USD',
    });
    expect(() => parseConceptRef('  ')).toThrow(/not an XBRL concept/);
  });
});
