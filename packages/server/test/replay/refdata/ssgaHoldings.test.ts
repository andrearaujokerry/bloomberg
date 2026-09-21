/**
 * `ssga-spy-holdings.xlsx` → `etf_holdings` + `index_members`, against the real capture
 * (PROVIDERS §8, WORKPLAN §WP-04 L727-729, QA-02/QA-03).
 *
 * The riskiest parser in this package is here: a hand-rolled zip/xlsx reader, the SSGA date
 * formats, and the percent→fraction conversion that decides every index weight. None of it had a
 * test of its own — `indexMembership.test.ts` proves the membership arithmetic on a synthetic
 * seven-instrument fixture and never opens the workbook. Six properties of the recorded file are
 * pinned here, every one of them measured from the capture rather than assumed:
 *
 *  1. **505 published rows**, `Holdings as of` **2026-09-14**, and Σ Weight **99.951255** — the
 *     file's own arithmetic, which the job refuses to write when it falls outside 495-515 rows or
 *     99.0-100.5 percent.
 *  2. **Weight is a percent and `index_members.weight` is a fraction**: 99.951255 → 0.99951255,
 *     carried as decimal text end to end. A float round-trip loses the last digits of a
 *     `numeric(12,10)` weight, and the sum stops landing on ≈ 1.
 *  3. **Cells are addressed by their `r` reference.** Two rows publish no SEDOL and one no
 *     ticker; in an `.xlsx` an empty cell is simply absent from the XML, so a reader that counted
 *     `<c>` siblings would shift Weight into Sector on exactly those rows. Their weights are
 *     asserted.
 *  4. **No placeholder identifier ever reaches `identifiers`** — the shared screen of
 *     WORKPLAN L730-741.
 *  5. **A second run writes nothing**, proved by row counts on every table the job touches, twice:
 *     once through the as-of-date freshness gate and once with `force: true`, which bypasses the
 *     gate and makes the *writes* prove their own idempotence.
 *  6. **§8.2 reconciliation against N-PORT happens at the N-PORT as-of date or not at all**, and
 *     its findings become `dq_events` once, not once per run.
 *
 * TESTS ARE SELF-SUFFICIENT (WORKPLAN §0.2). WP-15 owns the seed, so {@link buildUniverse} builds
 * the constituents this file names through this package's own repositories, inside the test's own
 * transaction. It is deliberately incomplete in the way a real symbology load is: the last line —
 * the `CONTRA HOLOGIC INCORPO` contra-rights row, whose "CUSIP" `436CVR021` is not a CUSIP — is
 * not built at all, so the unresolved-holding path is exercised by the file's own unresolvable
 * row rather than by a contrivance.
 */

import { SystemClock } from '@terminal/core';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  SEC_ARCHIVES_SOURCE_ID,
  presentIdentifier,
  upsertEtfHoldings,
} from '../../../src/ingest/jobs/secNport.js';
import {
  RECONCILE_NAME_BP,
  SSGA_ADAPTER_VERSION,
  SSGA_SOURCE_ID,
  SSGA_SPY_URL,
  parseSsgaDate,
  parseSsgaHoldings,
  publishReconcileFindings,
  readXlsxSheet1,
  reconcileAgainstNport,
  runSsgaHoldings,
  weightToFraction,
} from '../../../src/ingest/jobs/ssgaHoldings.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { identifierRepository } from '../../../src/refdata/identifiers.js';
import {
  membersAsOf,
  membershipAsOf,
  upsertIndex,
  weightSumAsOf,
} from '../../../src/refdata/indexMembership.js';
import { MasterRepositories } from '../../../src/refdata/master.js';
import { withTxDb } from '../../../src/test/db.js';

import type { Tx } from '../../../src/db/client.js';
import type { EtfHoldingRow } from '../../../src/ingest/jobs/secNport.js';
import type { SsgaHolding, SsgaParse } from '../../../src/ingest/jobs/ssgaHoldings.js';
import type { RawRecord } from '../../../src/providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The capture, read once
// ─────────────────────────────────────────────────────────────────────────────────────────────

const store = openReplayStore();
const raw: RawRecord = store.replay({ providerId: SSGA_SOURCE_ID, url: SSGA_SPY_URL });
const parse: SsgaParse = parseSsgaHoldings(readXlsxSheet1(raw.body));

/** The file's own as-of date, and the line the universe deliberately cannot resolve. */
const AS_OF_DATE = '2026-09-14';
const CONTRA_LINE = 505;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The capture and the parse — no database
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ssga.holdings replay', () => {
  it('reads the recorded workbook, never a socket', () => {
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.providerId).toBe(SSGA_SOURCE_ID);
    expect(raw.requestKey).toBe(requestKey(SSGA_SOURCE_ID, 'GET', SSGA_SPY_URL));
    expect(raw.body.byteLength).toBe(54_431);
    // A real `.xlsx`: a zip local file header, not an HTML error page with a 200.
    expect(raw.body.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('reads the header block: the fund, its ticker and the as-of date', () => {
    expect(parse.fundName).toBe('State Street® SPDR® S&P 500® ETF Trust');
    expect(parse.fundTicker).toBe('SPY');
    expect(parse.asOfDate).toBe(AS_OF_DATE);
    expect(parse.problems).toEqual([]);
  });

  it('counts 505 rows whose Weight sums to 99.951255 percent', () => {
    expect(parse.holdings).toHaveLength(505);
    const sum = parse.holdings.reduce((acc, h) => acc + Number(h.weight), 0);
    expect(sum).toBeCloseTo(99.951255, 6);
    // Every line is priced in USD and carries a published identifier, so the placeholder screen
    // has nothing to drop in THIS file — which is why the unresolved path below is driven by the
    // contra-rights row instead.
    expect(parse.holdings.every((h) => h.currency === 'USD')).toBe(true);
    expect(parse.holdings.filter((h) => presentIdentifier('CUSIP', h.identifier) === null)).toEqual(
      [],
    );
    expect(new Set(parse.holdings.map((h) => h.identifier)).size).toBe(505);
    // Line 1 is the whole row read correctly, column by column.
    expect(parse.holdings[0]).toEqual({
      lineNo: 1,
      name: 'NVIDIA CORP',
      ticker: 'NVDA',
      identifier: '67066G104',
      sedol: '2379504',
      weight: '7.777528',
      sector: null,
      shares: '2.95150616E8',
      currency: 'USD',
    });
  });

  it('keeps the columns aligned on the rows that omit a cell (the `r`-reference rule)', () => {
    // An `.xlsx` omits empty cells from the XML entirely. These are the rows where counting
    // siblings instead of reading `r="D7"` would slide Weight one column to the left.
    const noSedol = parse.holdings.filter((h) => h.sedol === null);
    expect(noSedol).toHaveLength(2);
    const noTicker = parse.holdings.filter((h) => h.ticker === null);
    expect(noTicker).toHaveLength(1);
    for (const holding of [...noSedol, ...noTicker]) {
      // The cell after the gap is still a number, and the one after that is still the currency.
      expect(holding.weight, holding.name).toMatch(/^\d+(\.\d+)?(E-?\d+)?$/);
      expect(holding.currency, holding.name).toBe('USD');
    }
  });

  it('turns Weight (a percent) into a fraction without a float round-trip', () => {
    expect(weightToFraction('7.777528')).toBe('0.07777528');
    // Scientific notation, as the workbook stores the smallest line: 3.0E-6 percent.
    expect(weightToFraction('3.0E-6')).toBe('0.0000000300');
    expect(weightToFraction(null)).toBeNull();
    // The sum of the fractions is the sum of the percents / 100, to the last published digit.
    const fractionSum = parse.holdings.reduce(
      (acc, h) => acc + Number(weightToFraction(h.weight)),
      0,
    );
    expect(fractionSum).toBeCloseTo(0.99951255, 10);
  });

  it('reads the SSGA date spellings and refuses to guess at an ambiguous one', () => {
    // The two spellings the file has used, with and without the `As of` prefix, plus ISO.
    expect(parseSsgaDate('As of 14-Sep-2026')).toBe('2026-09-14');
    expect(parseSsgaDate('14-Sep-2026')).toBe('2026-09-14');
    expect(parseSsgaDate('Sep 14, 2026')).toBe('2026-09-14');
    expect(parseSsgaDate('2026-09-14')).toBe('2026-09-14');
    // A purely numeric date is NOT accepted: `09/14/2026` and `14/09/2026` are the same string
    // to two different readers, and a month/day guess here would silently mis-date a whole
    // holdings slice. The job then fails with NO_AS_OF_DATE rather than writing to the wrong day.
    expect(parseSsgaDate('09/14/2026')).toBeNull();
    expect(parseSsgaDate('as of')).toBeNull();
    expect(parseSsgaDate('13/45/2026')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The universe the job writes into
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Universe {
  provenanceId: number;
  indexId: number;
  spxInstrumentId: number;
  spyInstrumentId: number;
  /** `instrument_id` by the holding's published CUSIP. */
  byCusip: Map<string, number>;
}

const SEED_AT = new Date('2020-01-02T00:00:00.000Z');

async function seedProvenance(tx: Tx): Promise<number> {
  const rows = await tx.execute<{ provenance_id: string }>(sql`
    INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                            http_status, bytes, captured_at, adapter_version)
    VALUES ('internal.derived', 'test:ssga:universe', 'test://ssga/universe',
            sha256('test:ssga:universe'::bytea), sha256('test:ssga:universe'::bytea),
            200, 0, timestamptz '2020-01-02 00:00:00+00', 'test/1.0.0')
    RETURNING provenance_id`);
  return Number(rows.rows[0]!.provenance_id);
}

/**
 * The 504 constituents this file names, plus SPY and SPX.
 *
 * One issuer, issue and instrument per line, with the CUSIP the file publishes (written through
 * `upsertIfValid`, so a value that fails its check digit is left out exactly as an ingest job
 * would leave it out) and always a `TICKER_EXCH` row. The 505th line is not built: `436CVR021` is
 * not a CUSIP and `2602335D` is not a ticker, so nothing in the database can resolve it — which
 * is the point.
 */
async function buildUniverse(tx: Tx): Promise<Universe> {
  const provenanceId = await seedProvenance(tx);
  const repos = new MasterRepositories(tx);
  const identifiers = identifierRepository(tx);
  const options = { validFrom: SEED_AT, provenanceId, knownAt: SEED_AT };
  const byCusip = new Map<string, number>();

  for (const holding of parse.holdings) {
    if (holding.lineNo === CONTRA_LINE) continue;
    const issuerId = await repos.issuers.insert({ name: holding.name }, options);
    const issueId = await repos.issues.insert(
      {
        issuerId,
        assetClass: 'equity',
        securityType: 'Common Stock',
        name: holding.name,
        currency: 'USD',
      },
      options,
    );
    const instrumentId = await repos.instruments.insert(
      {
        issueId,
        assetClass: 'equity',
        marketSector: 'Equity',
        ticker: holding.ticker ?? `S${String(holding.lineNo).padStart(4, '0')}`,
        exchCode: 'US',
        name: holding.name,
        currency: 'USD',
      },
      options,
    );
    if (holding.identifier !== null) byCusip.set(holding.identifier, instrumentId);

    if (holding.identifier !== null) {
      await identifiers.upsertIfValid(
        { entityKind: 'issue', entityId: issueId, scheme: 'CUSIP', value: holding.identifier },
        options,
      );
    }
    await identifiers.upsert(
      {
        entityKind: 'instrument',
        entityId: instrumentId,
        scheme: 'TICKER_EXCH',
        value: holding.ticker ?? `S${String(holding.lineNo).padStart(4, '0')}`,
        qualifier: 'US',
        isPrimary: true,
      },
      options,
    );
  }

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
    membershipSourceId: SSGA_SOURCE_ID,
    provider: 'ssga.holdings',
  });

  return { provenanceId, indexId: index.indexId, spxInstrumentId, spyInstrumentId, byCusip };
}

/** Row counts on every table the job touches — the only honest measure of "wrote nothing". */
interface TableCounts {
  etfHoldings: number;
  indexMembers: number;
  identifiers: number;
  dataExceptions: number;
  dqEvents: number;
  provenance: number;
}

async function tableCounts(tx: Tx): Promise<TableCounts> {
  const rows = await tx.execute<Record<string, string>>(sql`
    SELECT (SELECT count(*) FROM etf_holdings)    AS etf_holdings,
           (SELECT count(*) FROM index_members)   AS index_members,
           (SELECT count(*) FROM identifiers)     AS identifiers,
           (SELECT count(*) FROM data_exceptions) AS data_exceptions,
           (SELECT count(*) FROM dq_events)       AS dq_events,
           (SELECT count(*) FROM provenance)      AS provenance`);
  const row = rows.rows[0]!;
  return {
    etfHoldings: Number(row.etf_holdings),
    indexMembers: Number(row.index_members),
    identifiers: Number(row.identifiers),
    dataExceptions: Number(row.data_exceptions),
    dqEvents: Number(row.dq_events),
    provenance: Number(row.provenance),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. The job
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('runSsgaHoldings against the recorded file', () => {
  const t = withTxDb();
  const clock = new SystemClock();

  it('writes the file once, and a second run writes nothing', async () => {
    const tx = t.db;
    const universe = await buildUniverse(tx);
    const ctx = { tx, clock };

    // ── run 1 ─────────────────────────────────────────────────────────────────────────────
    const first = await runSsgaHoldings(ctx, { reconcile: true });
    expect(first.status).toBe('ok');
    expect(first.errors).toEqual([]);
    expect(first.asOfDate).toBe(AS_OF_DATE);
    expect(first.holdings).toBe(505);
    expect(first.weightSum).toBeCloseTo(99.951255, 6);
    expect(first.distinctIdentifiers).toBe(505);
    expect(first.placeholderIdentifiers).toBe(0);

    // 504 of the 505 resolve; the contra-rights line is the file's own unresolvable row.
    expect(first.resolved).toBe(504);
    expect(first.unresolved).toBe(1);
    expect(first.etfHoldings).toEqual({ inserted: 505, updated: 0, unchanged: 0 });

    // ── etf_holdings: 505 rows, one NULL holding, every row citing this run's provenance ───
    const stored = await tx.execute<{ count: string; nulls: string; mismatched: string }>(sql`
        SELECT count(*)                                             AS count,
               count(*) FILTER (WHERE holding_instrument_id IS NULL) AS nulls,
               count(*) FILTER (WHERE provenance_id <> ${first.provenanceId}) AS mismatched
          FROM etf_holdings
         WHERE etf_instrument_id = ${universe.spyInstrumentId}::bigint
           AND as_of_date = ${AS_OF_DATE}::date
           AND source_id = ${SSGA_SOURCE_ID}`);
    expect(Number(stored.rows[0]?.count)).toBe(505);
    expect(Number(stored.rows[0]?.nulls)).toBe(1);
    expect(Number(stored.rows[0]?.mismatched)).toBe(0);

    const unresolved = await tx.execute<{ line_no: number; name: string }>(sql`
        SELECT line_no, name FROM etf_holdings
         WHERE etf_instrument_id = ${universe.spyInstrumentId}::bigint
           AND as_of_date = ${AS_OF_DATE}::date
           AND source_id = ${SSGA_SOURCE_ID}
           AND holding_instrument_id IS NULL`);
    expect(unresolved.rows).toHaveLength(1);
    expect(unresolved.rows[0]?.line_no).toBe(CONTRA_LINE);

    const exceptions = await tx.execute<{ kind: string; field: string }>(sql`
        SELECT kind, field FROM data_exceptions`);
    expect(exceptions.rows).toHaveLength(1);
    expect(exceptions.rows[0]?.kind).toBe('unresolved_identifier');
    expect(exceptions.rows[0]?.field).toBe('holding_instrument_id');
    expect(first.exceptionsWritten).toBe(1);
    expect(first.conflictsWritten).toBe(0);

    // ── the percent → fraction conversion, end to end ─────────────────────────────────────
    const nvidia = universe.byCusip.get('67066G104');
    expect(nvidia).toBeDefined();
    const topRow = await tx.execute<{ weight: string; shares: string; ticker: string }>(sql`
        SELECT weight::text, shares::text, ticker FROM etf_holdings
         WHERE etf_instrument_id = ${universe.spyInstrumentId}::bigint
           AND as_of_date = ${AS_OF_DATE}::date
           AND source_id = ${SSGA_SOURCE_ID}
           AND line_no = 1`);
    expect(topRow.rows[0]?.weight).toBe('0.0777752800');
    expect(topRow.rows[0]?.ticker).toBe('NVDA');

    // ── index_members: the resolved lines, weights summing to ≈ 1 ─────────────────────────
    expect(first.members.retired).toBe(0);
    const at = membershipAsOf(AS_OF_DATE, new Date(raw.capturedAt));
    const members = await membersAsOf(tx, universe.indexId, at);
    expect(members).toHaveLength(first.members.written);
    expect(new Set(members.map((m) => m.instrumentId)).size).toBe(members.length);
    expect(members.every((m) => m.sourceId === SSGA_SOURCE_ID)).toBe(true);
    expect(members.every((m) => m.asOfDate === AS_OF_DATE)).toBe(true);

    const weightSum = await weightSumAsOf(tx, universe.indexId, at);
    expect(weightSum).toBeGreaterThan(0.999);
    expect(weightSum).toBeLessThan(1.0005);

    // ── no placeholder identifier, ever ───────────────────────────────────────────────────
    const placeholders = await tx.execute<{ count: string }>(sql`
        SELECT count(*) AS count FROM identifiers
         WHERE value ~ '^[0\\s\\-_.*#]*$' OR value = '000000000'`);
    expect(placeholders.rows[0]?.count).toBe('0');

    // ── §8.2: no N-PORT slice for this date, so nothing is compared ───────────────────────
    expect(first.reconcile).not.toBeNull();
    expect(first.reconcile?.asOfDate).toBeNull();
    expect(first.reconcile?.nameDivergences).toBe(0);

    // ── provenance ────────────────────────────────────────────────────────────────────────
    const provenanceRow = await tx.execute<{
      source_id: string;
      adapter_version: string;
      source_ts: string;
    }>(sql`
        SELECT source_id, adapter_version, source_ts::text
          FROM provenance WHERE provenance_id = ${first.provenanceId}`);
    expect(provenanceRow.rows[0]?.source_id).toBe(SSGA_SOURCE_ID);
    expect(provenanceRow.rows[0]?.adapter_version).toBe(SSGA_ADAPTER_VERSION);
    // 16:00 America/New_York on the file's own date — September is EDT, UTC−4.
    expect(provenanceRow.rows[0]?.source_ts).toContain('2026-09-14 20:00:00');

    const afterFirst = await tableCounts(tx);

    // ── run 2: the freshness gate. The stored as-of date is not older, so nothing happens. ─
    const second = await runSsgaHoldings(ctx, { reconcile: true });
    expect(second.status).toBe('skipped');
    expect(second.provenanceId).toBeNull();
    expect(await tableCounts(tx)).toEqual(afterFirst);

    // ── run 3: `force` bypasses the gate, so the WRITES prove their own idempotence. ──────
    const third = await runSsgaHoldings(ctx, { force: true, reconcile: true });
    expect(third.status).toBe('ok');
    expect(third.errors).toEqual([]);
    expect(third.etfHoldings).toEqual({ inserted: 0, updated: 0, unchanged: 505 });
    expect(third.members).toEqual({ written: 0, unchanged: first.members.written, retired: 0 });
    expect(third.identifiersWritten).toBe(0);
    expect(third.exceptionsWritten).toBe(0);
    expect(third.dqEventsWritten).toBe(0);

    expect(await tableCounts(tx)).toEqual({
      ...afterFirst,
      // The only row a forced re-run adds anywhere: the provenance of the second fetch.
      provenance: afterFirst.provenance + 1,
    });

    // …and the membership read is byte-identical, versions included.
    const membersAgain = await membersAsOf(tx, universe.indexId, at);
    expect(membersAgain.map((m) => m.versionId)).toEqual(members.map((m) => m.versionId));
  }, 180_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. §8.2 — reconciling against N-PORT (QA-03)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('reconcileAgainstNport (§8.2)', () => {
  const t = withTxDb();
  const clock = new SystemClock();

  /**
   * The N-PORT counterpart of the SSGA slice, at the SSGA date so the two have a partner: the
   * same holdings and the same weights, with three deliberate differences — one name only N-PORT
   * has, one name only SSGA has, and one weight 10 bp apart.
   */
  async function seedNportSlice(
    tx: Tx,
    universe: Universe,
    provenanceId: number,
  ): Promise<{ divergedCusip: string; droppedCusip: string }> {
    const resolved = parse.holdings.filter(
      (h: SsgaHolding) => h.lineNo !== CONTRA_LINE && h.identifier !== null,
    );
    const diverged = resolved[1]!;
    const dropped = resolved[2]!;

    const rows: EtfHoldingRow[] = [];
    for (const holding of resolved) {
      if (holding.lineNo === dropped.lineNo) continue; // only SSGA carries this one
      const instrumentId = universe.byCusip.get(holding.identifier!);
      if (instrumentId === undefined) continue;
      const weight =
        holding.lineNo === diverged.lineNo
          ? String(Number(weightToFraction(holding.weight)) + 0.001) // +10 bp
          : weightToFraction(holding.weight);
      rows.push({
        etfInstrumentId: universe.spyInstrumentId,
        asOfDate: AS_OF_DATE,
        sourceId: SEC_ARCHIVES_SOURCE_ID,
        lineNo: holding.lineNo,
        holdingInstrumentId: instrumentId,
        name: holding.name,
        cusip: holding.identifier,
        isin: null,
        lei: null,
        sedol: holding.sedol,
        ticker: holding.ticker,
        shares: null,
        marketValue: null,
        weight,
        assetCat: 'EC',
        issuerCat: null,
        country: 'US',
        provenanceId,
      });
    }
    // …and one line only the filing has: the index instrument itself stands in for it.
    rows.push({
      etfInstrumentId: universe.spyInstrumentId,
      asOfDate: AS_OF_DATE,
      sourceId: SEC_ARCHIVES_SOURCE_ID,
      lineNo: 9_001,
      holdingInstrumentId: universe.spxInstrumentId,
      name: 'ONLY IN THE FILING',
      cusip: null,
      isin: null,
      lei: null,
      sedol: null,
      ticker: null,
      shares: null,
      marketValue: null,
      weight: '0.0010000000',
      assetCat: 'EC',
      issuerCat: null,
      country: 'US',
      provenanceId,
    });
    await upsertEtfHoldings(tx, rows);
    return { divergedCusip: diverged.identifier!, droppedCusip: dropped.identifier! };
  }

  it('compares the two publications at the shared date and files each finding once', async () => {
    const tx = t.db;
    const universe = await buildUniverse(tx);

    const first = await runSsgaHoldings({ tx, clock }, { reconcile: false });
    expect(first.status).toBe('ok');
    expect(first.reconcile).toBeNull();
    const { divergedCusip, droppedCusip } = await seedNportSlice(
      tx,
      universe,
      universe.provenanceId,
    );
    expect(universe.byCusip.get(divergedCusip)).toBeDefined();
    expect(universe.byCusip.get(droppedCusip)).toBeDefined();

    const report = await reconcileAgainstNport(tx, {
      etfInstrumentId: universe.spyInstrumentId,
      ssgaAsOfDate: AS_OF_DATE,
    });
    expect(report.asOfDate).toBe(AS_OF_DATE);
    expect(report.onlyInNport).toBe(1); // the filing-only line
    expect(report.onlyInSsga).toBe(1); // the line the filing omits
    expect(report.nameDivergences).toBe(1); // 10 bp > the 5 bp threshold
    expect(RECONCILE_NAME_BP).toBe(5);
    // Drift: 10 bp on the diverged name, plus the whole weight of each unmatched line.
    expect(report.totalDriftBp).toBeGreaterThan(10);

    // The findings become `dq_events` — once, however often the job runs.
    const written = await publishReconcileFindings(tx, report);
    expect(written).toBeGreaterThan(0);
    const after = await tx.execute<{ count: string }>(sql`
        SELECT count(*) AS count FROM dq_events WHERE kind = 'cross_source_divergence'`);
    expect(Number(after.rows[0]?.count)).toBe(written);
    expect(await publishReconcileFindings(tx, report)).toBe(0);
    const againAfter = await tx.execute<{ count: string }>(sql`
        SELECT count(*) AS count FROM dq_events WHERE kind = 'cross_source_divergence'`);
    expect(Number(againAfter.rows[0]?.count)).toBe(written);
  }, 180_000);

  it('reports nothing to compare when the two publications share no date', async () => {
    const tx = t.db;
    const universe = await buildUniverse(tx);
    await runSsgaHoldings({ tx, clock }, { reconcile: false });

    // An N-PORT slice at the quarter end — the real case, two months before this file. Comparing
    // it against a September file would report the whole index as a membership difference.
    await upsertEtfHoldings(tx, [
      {
        etfInstrumentId: universe.spyInstrumentId,
        asOfDate: '2026-06-30',
        sourceId: SEC_ARCHIVES_SOURCE_ID,
        lineNo: 1,
        holdingInstrumentId: universe.byCusip.get('67066G104') ?? null,
        name: 'NVIDIA CORP',
        cusip: '67066G104',
        isin: null,
        lei: null,
        sedol: null,
        ticker: 'NVDA',
        shares: null,
        marketValue: null,
        weight: '0.0700000000',
        assetCat: 'EC',
        issuerCat: null,
        country: 'US',
        provenanceId: universe.provenanceId,
      },
    ]);

    const report = await reconcileAgainstNport(tx, {
      etfInstrumentId: universe.spyInstrumentId,
      ssgaAsOfDate: AS_OF_DATE,
    });
    expect(report.asOfDate).toBeNull();
    expect(report).toEqual({
      asOfDate: null,
      onlyInNport: 0,
      onlyInSsga: 0,
      nameDivergences: 0,
      totalDriftBp: 0,
    });
    expect(await publishReconcileFindings(tx, report)).toBe(0);
  }, 180_000);
});
