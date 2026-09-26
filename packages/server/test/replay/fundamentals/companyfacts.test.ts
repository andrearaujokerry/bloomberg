/**
 * `sec-companyfacts-AAPL.json` → `xbrl_facts` → `fin_statements`, against the real 3.7 MB capture.
 *
 * WORKPLAN WP-10's acceptance row `test/replay/fundamentals/companyfacts.test.ts` and QA-02:
 * *deterministic and idempotent; `mapping_version` recorded*. Five properties, every number in
 * them measured from the capture rather than asserted from the plan:
 *
 *  1. **25,116 facts land, and the second run lands none.** Proved by `count(*)` **and**
 *     `max(fact_id)` on both runs — not by a boolean return value, and not by `max(captured_at)`,
 *     which cannot see the difference: `captured_at` defaults to `now()`, and `now()` is the
 *     transaction start instant, so it is *identical* for every row this file writes whether the
 *     second run inserted 25,116 rows or none. `fact_id` comes from an identity sequence that
 *     moves the moment anything is inserted, so it is the column that can tell the two apart.
 *  2. **617 `fin_statements` rows, one per (period, filing).** 628 `(period, filing)` pairs exist —
 *     363 reported (73 FY, 290 Q, six of which collide) plus 265 four-trailing-quarters roll-ups —
 *     and eleven of them collide on the primary key: two filings of the same date reporting the
 *     same period, which the key `(issuer_id, period_end, period_type, filed_at, mapping_version)`
 *     cannot hold twice. The first in accession order wins, deterministically; the second is a
 *     conflict, not an error. The second run inserts nothing at all, proved by `count(*)` and by
 *     an md5 digest of every row's content in a fixed order.
 *  2a. **The TTM third is a row, not a claim.** DATA_MODEL §18 row 10 asks this job for
 *     `Q/FY/TTM`, and `DES/resolve.ts` reads `{ periodType: 'TTM', periods: 1 }` to fill
 *     `epsTtmDil`, `revenueTtm`, `netIncomeTtm` and `peTtm`. The table held zero TTM rows through
 *     WP-10 to WP-14 and nothing noticed, because no test asserted `fin_statements` by
 *     `period_type` at all — DES blanked the four cells and reported `NO_SOURCE / no XBRL facts
 *     ingested` for a CIK with 25,116 facts stored. The count, the four-quarter sum identity and
 *     the absence of a summed share count are all asserted below.
 *  3. **`mapping_version` is `'std-map/2026.09'` on every row**, and it is in the primary key: a
 *     re-standardisation under a new mapping adds rows beside these rather than overwriting them.
 *  4. **Point-in-time correctness.** Apple restated the June 2009 quarter under ASU 2009-13. The
 *     capture carries both versions and the test reads the same period twice through the same
 *     `FundamentalsService.statements` the screens use: `knownAt` 2009-07-22 must return the
 *     1,229 m the market saw that day, and `knownAt` 2010-07-21 the restated 1,828 m. A builder
 *     that wrote "the latest view of each period" would pass properties 1–3 and fail this one,
 *     which is the whole reason `fin_statements` is keyed on `filed_at`.
 *  5. **Nothing is invented.** The 2026 Q2 10-Q reports no quarterly cash-flow duration — a 10-Q
 *     files cash flow year-to-date — so `cfo`, `capex` and `fcf` on that row are NULL, not zero
 *     and not the nine-month figure. `SHARES_DIL` is NULL on every derived Q4 row, because the
 *     difference of two weighted-average share counts is not a share count.
 *
 * TESTS ARE SELF-SUFFICIENT (WORKPLAN §0.2). WP-15 owns the seed and does not exist yet, so the
 * test creates its own issuer inside its own transaction and never names a literal id.
 *
 * This file lives under `test/replay/`, which is the single-worker `server-replay` project.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { VirtualClock } from '@terminal/core';

import { FundamentalsService } from '../../../src/data/fundamentals.js';
import {
  FIN_STATEMENTS_ENGINE,
  FIN_STATEMENTS_ENGINE_VERSION,
  FIN_STATEMENTS_MAPPING_VERSION,
  MAPPED_CONCEPTS,
  buildStatements,
  runSecCompanyFacts,
} from '../../../src/ingest/jobs/secCompanyFacts.js';
import { companyFactsUrl, secCompanyFactsAdapter } from '../../../src/providers/sec/adapter.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { withTxDb } from '../../../src/test/db.js';

import type { Tx } from '../../../src/db/client.js';
import type { StatementRow, StoredFact } from '../../../src/ingest/jobs/secCompanyFacts.js';
import type { RawRecord } from '../../../src/providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The capture, read once
// ─────────────────────────────────────────────────────────────────────────────────────────────

const AAPL_CIK = '0000320193';
/** The frozen clock every WP-10 fixture is dated at. */
const AS_OF = Date.parse('2026-09-15T18:41:28Z');

const CAPTURE_URL = companyFactsUrl(AAPL_CIK);
if (CAPTURE_URL === null) throw new Error('companyFactsUrl returned null for a valid CIK');

const store = openReplayStore();
const raw: RawRecord = store.replay({ providerId: 'sec.companyfacts', url: CAPTURE_URL });
const normalised = secCompanyFactsAdapter.normalise(raw, {
  provenanceId: 0,
  capturedAt: raw.capturedAt,
  lines: new Map(),
});

/**
 * The parsed facts as the builder reads them back, with `fact_id` standing in for the identity
 * column. The ordering is the payload's own document order, which is the order the job inserts in
 * and therefore the order `fact_id` ascends in — so these ids agree with the stored ones.
 */
const storedFacts: StoredFact[] = (() => {
  const mapped = new Set(MAPPED_CONCEPTS);
  const out: StoredFact[] = [];
  let factId = 0;
  for (const fact of normalised.rows.facts) {
    factId += 1;
    if (fact.taxonomy !== 'us-gaap' || !mapped.has(fact.concept)) continue;
    out.push({
      factId,
      concept: fact.concept,
      unit: fact.unit,
      periodStart: fact.periodStart,
      periodEnd: fact.periodEnd,
      fy: fact.fy,
      fp: fact.fp,
      form: fact.form,
      accessionNo: fact.accessionNo,
      filedAt: fact.filedAt,
      value: Number(fact.value),
      provenanceId: 1,
    });
  }
  return out;
})();

const built: StatementRow[] = buildStatements(storedFacts, 42);

const FACT_COUNT = 25_116;
/** The `(period, filing)` pairs the 73 annual and 290 quarterly REPORTED periods make. */
const REPORTED_PAIRS = 363;
/** The four-trailing-quarters roll-ups `deriveTtm` adds on top of them — one per quarter anchor. */
const TTM_PAIRS = 265;
const STATEMENT_PAIRS = REPORTED_PAIRS + TTM_PAIRS;
/** …of which eleven are a second view of a `(period, type, filing-date)` another row already holds. */
const STATEMENT_ROWS = 617;

/**
 * The rows that actually reach the table: the first of each primary key, in build order.
 *
 * `insertStatements` inserts in array order with `ON CONFLICT DO NOTHING`, and `buildStatements`
 * sorts on `(period_end, period_type, filed_at)` over an array built in accession order, so the
 * first of two rows sharing a key is the one from the earlier accession and it is the one that
 * lands. Deriving the landed set here rather than asserting a bare count is what lets the file say
 * things about the rows in the table without a database in the way.
 */
function landed(rows: readonly StatementRow[]): StatementRow[] {
  const seen = new Set<string>();
  const out: StatementRow[] = [];
  for (const row of rows) {
    const key = `${row.periodEnd}|${row.periodType}|${row.filedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The standardisation, with no database in the way
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('secCompanyFacts — the standardisation (PROVIDERS §7.3.1)', () => {
  it('reads the recorded capture, never a socket', () => {
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.requestKey).toBe(requestKey('sec.companyfacts', 'GET', CAPTURE_URL));
    expect(normalised.rows.facts).toHaveLength(FACT_COUNT);
    // 5,631 of the 25,116 are reachable from a concept chain; the rest are stored and unused.
    expect(storedFacts).toHaveLength(5_631);
  });

  it('builds one row per (period, filing), never one per period', () => {
    expect(built).toHaveLength(STATEMENT_PAIRS);
    expect(built.filter((r) => r.periodType === 'FY')).toHaveLength(73);
    expect(built.filter((r) => r.periodType === 'Q')).toHaveLength(290);
    expect(built.filter((r) => r.periodType === 'TTM')).toHaveLength(TTM_PAIRS);
    expect(landed(built)).toHaveLength(STATEMENT_ROWS);
    // The whole point: a period reported by several filings exists several times over.
    const june2009 = built.filter((r) => r.periodEnd === '2009-06-27' && r.periodType === 'Q');
    expect(june2009.map((r) => [r.filedAt, r.values.get('NET_INC')])).toEqual([
      ['2009-07-22', 1_229_000_000],
      ['2010-07-21', 1_828_000_000],
      ['2010-10-27', 1_828_000_000],
    ]);
  });

  it('stamps every row with the mapping version, the engine and an inputs hash', () => {
    expect(new Set(built.map((r) => r.mappingVersion))).toEqual(
      new Set([FIN_STATEMENTS_MAPPING_VERSION]),
    );
    expect(FIN_STATEMENTS_MAPPING_VERSION).toBe('std-map/2026.09');
    expect(FIN_STATEMENTS_ENGINE).toBe('secCompanyFacts');
    expect(FIN_STATEMENTS_ENGINE_VERSION).toBe('fin-statements/1.0.0');
    expect(built.every((r) => /^[0-9a-f]{64}$/.test(r.inputsHash))).toBe(true);
    // The hash is a function of the inputs, so two rows built from different facts differ — and the
    // property that matters is about the rows that LAND. Of the eleven pairs that share a primary
    // key, ten differ in `as_reported` and therefore in hash; one pair (the TTM ending 2014-06-28,
    // filed 2015-01-28 by two accessions of the same day) read identical facts through identical
    // windows, so it hashes identically as well. That is the hash doing its job — same inputs, same
    // digest — and it costs nothing, because the primary key admits one of the two. So the
    // assertion is on the landed set, where a duplicate hash WOULD mean two rows in the table
    // claiming to have been built from the same inputs.
    expect(new Set(landed(built).map((r) => r.inputsHash)).size).toBe(STATEMENT_ROWS);
  });

  it('is deterministic: the same facts build byte-identical rows', () => {
    const again = buildStatements(storedFacts, 42);
    expect(again.map(digestRow)).toEqual(built.map(digestRow));
  });

  it("records a computed item as 'computed:…' with no fact_id", () => {
    const fy2025 = built.find((r) => r.periodEnd === '2025-09-27' && r.periodType === 'FY');
    expect(fy2025).toBeDefined();
    // Apple tags GrossProfit, so it is as reported and carries a fact id.
    expect(fy2025?.asReported.GROSS_PROFIT?.concept).toBe('GrossProfit');
    expect(fy2025?.asReported.GROSS_PROFIT?.fact_id).toEqual(expect.any(Number));
    // FCF is never tagged by anyone: CFO − |CAPEX|, and it says so.
    expect(fy2025?.asReported.FCF).toEqual({
      concept: 'computed:CFO-ABS(CAPEX)',
      value: 98_767_000_000,
      fact_id: null,
    });
    expect(fy2025?.values.get('CFO')).toBe(111_482_000_000);
    expect(fy2025?.values.get('CAPEX')).toBe(-12_715_000_000);
  });

  it('derives Q4 from the year minus the three quarters, and never a share count', () => {
    const q4 = built.find((r) => r.derivedQ4 && r.periodEnd === '2025-09-27');
    expect(q4).toBeDefined();
    expect(q4?.periodType).toBe('Q');
    expect(q4?.fiscalPeriod).toBe('Q4');
    // FY revenue 416,161 m less Q1+Q2+Q3 = 102,466 m.
    expect(q4?.values.get('REVENUE')).toBe(102_466_000_000);
    expect(q4?.values.get('NET_INC')).toBe(27_466_000_000);
    expect(q4?.asReported.REVENUE?.fact_id).toBeNull();
    expect(q4?.asReported.REVENUE?.concept).toMatch(/^computed:FY-\(Q1\+Q2\+Q3\)/);
    // A weighted-average share count is not additive, so it is absent rather than wrong.
    expect(q4?.values.has('SHARES_DIL')).toBe(false);
    // The balance sheet at the fiscal-year end *is* the Q4 balance sheet, carried across as
    // reported rather than differenced.
    expect(q4?.values.get('TOT_ASSETS')).toBe(359_241_000_000);
    expect(q4?.asReported.TOT_ASSETS?.concept).toBe('Assets');
    expect(q4?.asReported.TOT_ASSETS?.fact_id).toEqual(expect.any(Number));
  });

  it('rolls the four trailing quarters into a TTM row (DATA_MODEL §18 row 10)', () => {
    // Before this existed the table held 0 TTM rows, and DES — which asks for exactly
    // `{ periodType: 'TTM', periods: 1 }` — answered `NO_SOURCE / no XBRL facts ingested for CIK
    // 0000320193` on an issuer with 25,116 facts in `xbrl_facts`. The count is the first assertion
    // because a blank screen is what zero looks like from the outside.
    const ttm = built.filter((r) => r.periodType === 'TTM');
    expect(ttm).toHaveLength(TTM_PAIRS);

    const newest = ttm.filter((r) => r.periodEnd === '2026-06-27').at(-1);
    expect(newest?.filedAt).toBe('2026-07-31');
    expect(newest?.fiscalPeriod).toBe('Q3');
    expect(newest?.derivedQ4).toBe(false);

    // The four quarters it was built from, taken the way `deriveTtm` takes them: newest version of
    // each period end that was already public when the anchor was filed. The first of them is the
    // DERIVED Q4 of fiscal 2025, which is why the roll-up has to run after `deriveQ4` — a TTM
    // window that ends one quarter after a fiscal year end reaches back across it.
    const window = ['2025-09-27', '2025-12-27', '2026-03-28', '2026-06-27'].map((end) =>
      built
        .filter((r) => r.periodType === 'Q' && r.periodEnd === end && r.filedAt <= '2026-07-31')
        .reduce((a, b) => (b.filedAt > a.filedAt ? b : a)),
    );
    expect(window.map((q) => q.derivedQ4)).toEqual([true, false, false, false]);

    // The identity, not just the number: a flow column is the sum of the four, computed here from
    // the same rows the builder read rather than restated as a literal.
    const sum = (item: string): number =>
      window.reduce((total, q) => total + (q.values.get(item) ?? Number.NaN), 0);
    expect(newest?.values.get('REVENUE')).toBe(sum('REVENUE'));
    expect(newest?.values.get('NET_INC')).toBe(sum('NET_INC'));
    expect(newest?.values.get('REVENUE')).toBe(466_823_000_000);
    expect(newest?.values.get('NET_INC')).toBe(128_930_000_000);
    // Per-share flows are additive over sub-periods, which is what makes DES's `peTtm` answerable.
    expect(newest?.values.get('EPS_DIL')).toBeCloseTo(8.71, 10);
    expect(newest?.values.get('DPS')).toBeCloseTo(1.05, 10);
    expect(newest?.asReported.REVENUE?.concept).toMatch(/^computed:TTM\(4Q\):/);
    expect(newest?.asReported.REVENUE?.fact_id).toBeNull();

    // The balance sheet at the anchor quarter's end IS the TTM balance sheet: one instant, carried
    // across as reported with its real `fact_id`, never summed over four dates.
    expect(newest?.values.get('TOT_ASSETS')).toBe(383_266_000_000);
    expect(newest?.asReported.TOT_ASSETS?.concept).toBe('Assets');
    expect(newest?.asReported.TOT_ASSETS?.fact_id).toEqual(expect.any(Number));

    // Nothing invented, twice over. A weighted-average share count does not add up over four
    // quarters, so it is absent; and NO TTM row anywhere carries a cash flow, because a 10-Q files
    // cash flow year-to-date and so no window of four quarters has four quarterly CFO durations in
    // it. A three-quarter total under a twelve-month label is the number this guard refuses.
    expect(newest?.values.has('SHARES_DIL')).toBe(false);
    expect(newest?.values.has('CFO')).toBe(false);
    expect(ttm.filter((r) => r.values.has('CFO'))).toHaveLength(0);
    expect(ttm.filter((r) => r.values.has('SHARES_DIL'))).toHaveLength(0);

    // Every quarter that went in is cited (DATA-10). One capture supplied all four here, so the
    // union is one id — the assertion is that it is the union, not the anchor's alone.
    const expectedProv = [...new Set(window.flatMap((q) => q.provenanceIds))].sort((a, b) => a - b);
    expect(newest?.provenanceIds).toEqual(expectedProv);
  });

  it('leaves a line with no fact absent, never zero', () => {
    // A 10-Q files cash flow year to date, so the quarter has no CFO duration at all.
    const q2 = built.find((r) => r.periodEnd === '2026-06-27' && r.periodType === 'Q');
    expect(q2).toBeDefined();
    expect(q2?.values.get('REVENUE')).toBe(109_417_000_000);
    expect(q2?.values.has('CFO')).toBe(false);
    expect(q2?.values.has('CAPEX')).toBe(false);
    expect(q2?.values.has('FCF')).toBe(false);
    expect(q2?.asReported.CFO).toBeUndefined();
  });
});

/** A row reduced to the tuple a re-run has to reproduce exactly. */
function digestRow(row: StatementRow): unknown {
  return [
    row.periodEnd,
    row.periodType,
    row.filedAt,
    row.accessionNo,
    row.derivedQ4,
    row.inputsHash,
    [...row.values.entries()].sort(),
    row.provenanceIds,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The job, against a database it seeds for itself
// ─────────────────────────────────────────────────────────────────────────────────────────────

const t = withTxDb();

/** The provenance row the test's own issuer hangs off. */
async function seedProvenance(tx: Tx): Promise<number> {
  const rows = await tx.execute<{ provenance_id: string }>(sql`
    INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                            http_status, bytes, captured_at, adapter_version)
    VALUES ('internal.derived', 'test:companyfacts:issuer', 'test://companyfacts/issuer',
            sha256('test:companyfacts:issuer'::bytea), sha256('test:companyfacts:issuer'::bytea),
            200, 0, timestamptz '2020-01-02 00:00:00+00', 'test/1.0.0')
    RETURNING provenance_id`);
  const row = rows.rows[0];
  if (row === undefined) throw new Error('provenance insert returned no row');
  return Number(row.provenance_id);
}

/** Apple, as a bare security master knows it: a name and a CIK, and no literal id anywhere. */
async function seedIssuer(tx: Tx): Promise<number> {
  const provenanceId = await seedProvenance(tx);
  const rows = await tx.execute<{ issuer_id: string }>(sql`
    INSERT INTO issuers (issuer_id, name, cik, entity_type, valid_from, provenance_id)
    VALUES (nextval('issuer_id_seq'), 'Apple Inc.', ${AAPL_CIK}, 'operating',
            timestamptz '2000-01-01 00:00:00+00', ${provenanceId}::bigint)
    RETURNING issuer_id`);
  const row = rows.rows[0];
  if (row === undefined) throw new Error('issuers insert returned no row');
  return Number(row.issuer_id);
}

function jobContext(tx: Tx): Parameters<typeof runSecCompanyFacts>[0] {
  return {
    tx,
    clock: new VirtualClock(AS_OF),
    ciks: [AAPL_CIK],
    replay: store,
  };
}

interface FactShape {
  rows: number;
  maxFactId: number | null;
}

async function factShape(tx: Tx): Promise<FactShape> {
  const out = await tx.execute<{ n: string; max_id: string | null }>(sql`
    SELECT count(*)::text AS n, max(fact_id)::text AS max_id
      FROM xbrl_facts WHERE cik = ${AAPL_CIK}`);
  const row = out.rows[0];
  return {
    rows: Number(row?.n ?? '0'),
    maxFactId: row?.max_id == null ? null : Number(row.max_id),
  };
}

interface StatementShape {
  rows: number;
  digest: string | null;
}

/**
 * The content of every `fin_statements` row for the issuer, in a fixed order, as one md5.
 *
 * `built_at` is deliberately not in it: it defaults to `now()`, which inside one transaction is
 * the same instant for every row, so it can neither prove nor disprove a re-insert. The columns
 * that *are* in it are the ones a second run would have to change to be doing anything at all.
 */
async function statementShape(tx: Tx, issuerId: number): Promise<StatementShape> {
  const out = await tx.execute<{ n: string; digest: string | null }>(sql`
    SELECT count(*)::text AS n,
           md5(string_agg(line, E'\n' ORDER BY line)) AS digest
      FROM (
        SELECT concat_ws('|', period_end::text, period_type, filed_at::text, mapping_version,
                         accession_no, derived_q4::text, revenue::text, net_inc::text,
                         tot_assets::text, fcf::text, eps_dil::text, inputs_hash,
                         as_reported::text, provenance_ids::text) AS line
          FROM fin_statements WHERE issuer_id = ${issuerId}::bigint) s`);
  const row = out.rows[0];
  return { rows: Number(row?.n ?? '0'), digest: row?.digest ?? null };
}

describe('secCompanyFacts — the job, twice over the same capture (QA-02)', () => {
  let issuerId: number;

  beforeEach(async () => {
    issuerId = await seedIssuer(t.db);
  });

  it('ingests the capture and a second run writes nothing', async () => {
    const first = await runSecCompanyFacts(jobContext(t.db));
    expect(first.errors).toEqual([]);
    expect(first.ciks).toBe(1);
    expect(first.factsInserted).toBe(FACT_COUNT);
    expect(first.factsUnchanged).toBe(0);
    expect(first.statementsInserted).toBe(STATEMENT_ROWS);
    // The six (period, filing) pairs two same-day filings put on one primary key.
    expect(first.statementsUnchanged).toBe(STATEMENT_PAIRS - STATEMENT_ROWS);

    const factsAfterFirst = await factShape(t.db);
    const statementsAfterFirst = await statementShape(t.db, issuerId);
    expect(factsAfterFirst.rows).toBe(FACT_COUNT);
    expect(statementsAfterFirst.rows).toBe(STATEMENT_ROWS);
    expect(statementsAfterFirst.digest).not.toBeNull();

    const second = await runSecCompanyFacts(jobContext(t.db));
    expect(second.errors).toEqual([]);
    expect(second.factsInserted).toBe(0);
    expect(second.factsUnchanged).toBe(FACT_COUNT);
    expect(second.statementsInserted).toBe(0);
    expect(second.statementsUnchanged).toBe(STATEMENT_PAIRS);

    // Row counts AND the identity high-water mark AND the content digest, not a boolean.
    const factsAfterSecond = await factShape(t.db);
    const statementsAfterSecond = await statementShape(t.db, issuerId);
    expect(factsAfterSecond).toEqual(factsAfterFirst);
    expect(statementsAfterSecond).toEqual(statementsAfterFirst);

    // Two executions, two `ingest_runs` rows — one per execution, never one per fetch.
    const runs = await t.db.execute<{ n: string; statuses: string }>(sql`
      SELECT count(*)::text AS n, string_agg(DISTINCT status, ',') AS statuses
        FROM ingest_runs WHERE job_id = 'secCompanyFacts'`);
    expect(runs.rows[0]?.n).toBe('2');
    expect(runs.rows[0]?.statuses).toBe('ok');
  });

  it('records the mapping version on every row, and keys the table on it', async () => {
    await runSecCompanyFacts(jobContext(t.db));

    const versions = await t.db.execute<{ mapping_version: string; n: string }>(sql`
      SELECT mapping_version, count(*)::text AS n
        FROM fin_statements WHERE issuer_id = ${issuerId}::bigint
       GROUP BY mapping_version`);
    expect(versions.rows).toEqual([
      { mapping_version: FIN_STATEMENTS_MAPPING_VERSION, n: String(STATEMENT_ROWS) },
    ]);

    const engines = await t.db.execute<{ engine_name: string; engine_version: string }>(sql`
      SELECT DISTINCT engine_name, engine_version
        FROM fin_statements WHERE issuer_id = ${issuerId}::bigint`);
    expect(engines.rows).toEqual([
      { engine_name: FIN_STATEMENTS_ENGINE, engine_version: FIN_STATEMENTS_ENGINE_VERSION },
    ]);

    // `mapping_version` is in the primary key, so the same period standardised under a second
    // mapping lands beside the first rather than replacing it.
    const key = await t.db.execute<{ column_name: string }>(sql`
      SELECT a.attname AS column_name
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'fin_statements'::regclass AND i.indisprimary
       ORDER BY a.attname`);
    expect(key.rows.map((r) => r.column_name)).toEqual([
      'filed_at',
      'issuer_id',
      'mapping_version',
      'period_end',
      'period_type',
    ]);
  });

  it('answers a restatement differently before and after it was filed (STOR-06)', async () => {
    await runSecCompanyFacts(jobContext(t.db));
    const fundamentals = new FundamentalsService(t.db);

    // Apple restated the June 2009 quarter under ASU 2009-13, filed 2010-07-21.
    const asOf2009 = await fundamentals.statements(
      issuerId,
      'Q',
      new Date('2009-07-22T23:59:59Z'),
      1,
      { to: '2009-06-27' },
    );
    expect(asOf2009).toHaveLength(1);
    expect(asOf2009[0]?.periodEnd).toBe('2009-06-27');
    expect(asOf2009[0]?.filedAt).toBe('2009-07-22');
    expect(asOf2009[0]?.netInc).toBe(1_229_000_000);
    expect(asOf2009[0]?.revenue).toBe(8_337_000_000);
    expect(asOf2009[0]?.restated).toBe(false);
    expect(asOf2009[0]?.mappingVersion).toBe(FIN_STATEMENTS_MAPPING_VERSION);

    const asOf2010 = await fundamentals.statements(
      issuerId,
      'Q',
      new Date('2010-07-21T23:59:59Z'),
      1,
      { to: '2009-06-27' },
    );
    expect(asOf2010).toHaveLength(1);
    expect(asOf2010[0]?.periodEnd).toBe('2009-06-27');
    expect(asOf2010[0]?.filedAt).toBe('2010-07-21');
    expect(asOf2010[0]?.netInc).toBe(1_828_000_000);
    expect(asOf2010[0]?.revenue).toBe(9_734_000_000);
    // Two versions of the period were public by then, and the read says so.
    expect(asOf2010[0]?.restated).toBe(true);
    expect(asOf2010[0]?.versions).toBe(2);

    // The two answers are genuinely different numbers, which is the property under test.
    expect(asOf2010[0]?.netInc).not.toBe(asOf2009[0]?.netInc);

    // The day before the original filing, the period was not public at all.
    const before = await fundamentals.statements(
      issuerId,
      'Q',
      new Date('2009-07-21T23:59:59Z'),
      1,
      { to: '2009-06-27' },
    );
    expect(before).toEqual([]);
  });

  it('carries the SEC provenance ids onto the derived rows (DATA-09)', async () => {
    const result = await runSecCompanyFacts(jobContext(t.db));
    expect(result.provenanceIds).toHaveLength(1);
    const provenanceId = result.provenanceIds[0];
    expect(provenanceId).toEqual(expect.any(Number));

    const rows = await t.db.execute<{ n: string; bad: string }>(sql`
      SELECT count(*)::text AS n,
             count(*) FILTER (WHERE NOT (${provenanceId}::bigint = ANY(provenance_ids)))::text
               AS bad
        FROM fin_statements WHERE issuer_id = ${issuerId}::bigint`);
    expect(rows.rows[0]?.n).toBe(String(STATEMENT_ROWS));
    expect(rows.rows[0]?.bad).toBe('0');

    const source = await t.db.execute<{ source_id: string; adapter_version: string }>(sql`
      SELECT source_id, adapter_version FROM provenance
       WHERE provenance_id = ${provenanceId}::bigint`);
    expect(source.rows[0]?.source_id).toBe('sec.companyfacts');
  });
});
