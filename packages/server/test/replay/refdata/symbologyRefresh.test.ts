/**
 * QA-02 — `ingest/jobs/symbologyRefresh.ts` against the recorded `openfigi-map` and
 * `sec-company-tickers.json` captures (WORKPLAN §WP-04 acceptance row 9).
 *
 * What this file proves, in order:
 *
 *  1. **The bytes come from the manifest, not from a socket.** Both captures replay by
 *     `requestKey`, and the key the job computes for the OpenFIGI POST is a function of the
 *     request body — so the job's own body-building (PROVIDERS §6.1: sorted jobs, `JSON.stringify`
 *     with no whitespace) is pinned byte for byte by the fact that the capture is found at all.
 *  2. **The parses are golden.** 10,422 SEC entries in numeric key order with `AAPL` padded to
 *     `'0000320193'`; 2 positional elements for 2 jobs; 275 distinct FIGI records across 98
 *     composites, of which exactly one is the `US` composite.
 *  3. **The master rows are the documented ones** — one issuer, one issue, one instrument, twenty
 *     venue listings and forty-four identifiers, with the composite record itself writing no
 *     `listings` row (§6.1) and the SEC `title` winning for the issuer name (§7.1).
 *  4. **A second run writes nothing** — counted by `count(*)` per table before and after, not by a
 *     boolean the job hands us. The only rows that grow are the two `provenance` rows, which is
 *     what PROVIDERS §1.3 requires: one row per non-304 exchange, whatever the payload turns out
 *     to say.
 *
 * **Self-sufficient by construction.** WP-15 owns the seed modules and they do not exist yet, so
 * this file creates the two `licence_registry` rows it needs (`assert_source_known` gates every
 * `provenance` insert) and writes everything else through the job under test, inside the single
 * transaction the harness rolls back (TESTING §4.3). Every assertion is a delta or a lookup by
 * value; nothing depends on a sequence value or on a seeded database.
 */

import { describe, expect, it } from 'vitest';

import { VirtualClock } from '@terminal/core';

import {
  OPENFIGI_MAPPING_URL,
  SEC_TICKERS_URL,
  indexSecTickers,
  openFigiBody,
  openFigiJobsFor,
  parseOpenFigiMapping,
  parseSecTickers,
  runSymbologyRefresh,
  symbologyRefreshJob,
} from '../../../src/ingest/jobs/symbologyRefresh.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { IdentifierRepository } from '../../../src/refdata/identifiers.js';
import { MasterRepositories } from '../../../src/refdata/master.js';
import { withTxDb } from '../../../src/test/db.js';

import type { AsOf } from '../../../src/db/bitemporal.js';
import type { HttpClient, RawRecord } from '../../../src/providers/types.js';
import type { SymbologyRefreshResult } from '../../../src/ingest/jobs/symbologyRefresh.js';
import type { TestDb } from '../../../src/test/db.js';

// ── the captures ─────────────────────────────────────────────────────────────────────────────

const store = openReplayStore();

/** `AAPL` → the two jobs of PROVIDERS §6.1, in the order the sort fixes. */
const JOBS = openFigiJobsFor(['AAPL']);
const BODY = openFigiBody(JOBS);

const OPENFIGI_KEY = requestKey('openfigi.mapping', 'POST', OPENFIGI_MAPPING_URL, BODY);
const SEC_KEY = requestKey('sec.tickers', 'GET', SEC_TICKERS_URL);

const openFigiRaw = store.replay({
  providerId: 'openfigi.mapping',
  method: 'POST',
  url: OPENFIGI_MAPPING_URL,
  body: BODY,
});
const secRaw = store.replay({ providerId: 'sec.tickers', method: 'GET', url: SEC_TICKERS_URL });

// ── goldens, derived from the captures ───────────────────────────────────────────────────────

const AAPL_CIK = '0000320193';
const AAPL_TITLE = 'Apple Inc.';
const COMPOSITE_FIGI = 'BBG000B9XRY4';
const SHARE_CLASS_FIGI = 'BBG001S5N8V8';
/** The Nasdaq (`UW`) venue line — a listing, not the composite. */
const NASDAQ_FIGI = 'BBG000B9Y5X2';
const SEC_ENTRIES = 10_422;
/** Distinct `figi` records the two elements carry between them. */
const DISTINCT_RECORDS = 275;
/** Venue lines under the `US` composite: 21 records, one of which *is* the composite. */
const US_LISTINGS = 20;
/** CIK + SHARE_CLASS_FIGI + COMPOSITE_FIGI + TICKER_EXCH(US) + 20 × (FIGI + TICKER_EXCH). */
const IDENTIFIERS = 44;
/** Composites whose own composite record the payload did not return. */
const DEFERRED_NO_COMPOSITE = 78;
/** Composites on a venue outside `US` — deferred, not invented (see the job's module comment). */
const DEFERRED_NON_US = 19;

/** One version write per entity, plus one per identifier: 1+1+1+1+1+1+1+20+20+20. */
const FIRST_RUN_WRITES = 67;

/** Frozen knowledge instant: `tx_from` for every version this run writes. */
const KNOWN_AT = new Date('2026-09-16T00:00:00Z');
const clock = new VirtualClock(KNOWN_AT.getTime());

/**
 * The run's single valid instant: the SEC capture's published instant, which is what every row of
 * one run is written from (see the job's `execute`). Reads are taken at the same pair.
 */
const at: AsOf = {
  validAt: secRaw.sourceTs ?? new Date(secRaw.capturedAt),
  knownAt: KNOWN_AT,
};

const COUNTED_TABLES = [
  'issuers',
  'issues',
  'instruments',
  'listings',
  'identifiers',
  'md_lines',
  'provenance',
] as const;

type TableCounts = Record<(typeof COUNTED_TABLES)[number], number>;

async function tableCounts(t: TestDb): Promise<TableCounts> {
  const out = {} as TableCounts;
  for (const table of COUNTED_TABLES) {
    const res = await t.client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    out[table] = Number(res.rows[0]?.n ?? '0');
  }
  return out;
}

function delta(before: TableCounts, after: TableCounts): TableCounts {
  const out = {} as TableCounts;
  for (const table of COUNTED_TABLES) out[table] = after[table] - before[table];
  return out;
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

// ── a stub transport, for the two paths the captures cannot produce ─────────────────────────

const HEX64 = 'a'.repeat(64);

function stubRecord(status: number, body: string): RawRecord {
  return {
    providerId: 'sec.tickers',
    method: 'GET',
    url: SEC_TICKERS_URL,
    requestKey: SEC_KEY,
    requestHash: HEX64,
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(body, 'utf8'),
    capturedAt: KNOWN_AT.getTime(),
    sha256: HEX64,
    sourceTs: null,
    origin: 'live',
  };
}

/** An `HttpClient` that answers every request with one record — WP-05 implements the real one. */
function stubClient(record: RawRecord): HttpClient {
  return {
    mode: 'live',
    get: () => Promise.resolve(record),
    post: () => Promise.resolve(record),
    breaker: () => ({ state: 'closed', consecutiveFailures: 0, openedAt: null }),
    tokens: () => ({ capacity: 10, available: 10, refillPerSec: 1 }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('symbologyRefresh — the recorded captures', () => {
  it('replays both requests from the manifest, never a socket', () => {
    expect(BODY).toBe(
      '[{"idType":"TICKER","idValue":"AAPL","exchCode":"US"},{"idType":"TICKER","idValue":"AAPL"}]',
    );
    expect(OPENFIGI_KEY).toBe('d03312d2e621ebfeec800f7758e93276893e6288ffc6e276dcde2250a3b207e6');
    expect(SEC_KEY).toBe('093164db7b6ddc51d4162dd2e3e6e72d0eb11e2b297b4d983a7557f26d59ff50');

    expect(openFigiRaw.origin).toBe('replay');
    expect(openFigiRaw.status).toBe(200);
    expect(openFigiRaw.requestKey).toBe(OPENFIGI_KEY);
    expect(openFigiRaw.sha256).toBe(
      '0b2956ba1687b061de7386356ec0704c304e519ae93812b9fc71143daab0e91c',
    );
    expect(openFigiRaw.body.byteLength).toBe(70_534);

    expect(secRaw.origin).toBe('replay');
    expect(secRaw.requestKey).toBe(SEC_KEY);
    expect(secRaw.sha256).toBe('82cd5fd9ccffda811b93ba76070460dd41429c02c00e726f83deb71f553c6cff');
    expect(secRaw.body.byteLength).toBe(797_759);
  });

  it('sorts the OpenFIGI jobs so the key is stable (PROVIDERS §6.1 step 1)', () => {
    expect(JOBS).toEqual([
      { idType: 'TICKER', idValue: 'AAPL', exchCode: 'US' },
      { idType: 'TICKER', idValue: 'AAPL' },
    ]);
    // Same tickers in any order produce the same bytes, hence the same capture.
    expect(openFigiBody(openFigiJobsFor(['aapl']))).toBe(BODY);
  });
});

describe('parseSecTickers', () => {
  const parsed = parseSecTickers(secRaw.body);

  it('parses 10,422 entries in numeric key order with padded CIKs', () => {
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries).toHaveLength(SEC_ENTRIES);
    expect(parsed.entries[0]).toEqual({ cik: '0001045810', ticker: 'NVDA', title: 'NVIDIA CORP' });
    expect(parsed.entries[1]).toEqual({ cik: AAPL_CIK, ticker: 'AAPL', title: AAPL_TITLE });
  });

  it('groups by CIK and finds no ticker claimed by two CIKs', () => {
    const index = indexSecTickers(parsed.entries);
    expect(index.conflicts).toEqual([]);
    expect(index.byTicker.get('AAPL')?.cik).toBe(AAPL_CIK);
    // A multi-class issuer is one issuer with several tickers (PROVIDERS §7.1).
    const alphabet = index.byCik.get('0001652044') ?? [];
    expect(alphabet.map((entry) => entry.ticker).sort()).toEqual([
      'GOOG',
      'GOOGL',
      'GOOGM',
      'GOOGN',
    ]);
  });

  it('never throws on a malformed payload', () => {
    expect(parseSecTickers('not json').problems[0]?.kind).toBe('parse_error');
    expect(parseSecTickers('[]').problems[0]?.kind).toBe('schema_drift');
  });
});

describe('parseOpenFigiMapping', () => {
  const parsed = parseOpenFigiMapping(openFigiRaw.body, JOBS);

  it('is positionally parallel to the jobs and carries 275 distinct records', () => {
    expect(parsed.problems).toEqual([]);
    expect(parsed.elements).toHaveLength(2);
    const figis = new Set<string>();
    for (const element of parsed.elements) {
      expect(element.kind).toBe('data');
      if (element.kind !== 'data') continue;
      for (const record of element.records) figis.add(record.figi);
    }
    expect(figis.size).toBe(DISTINCT_RECORDS);
    expect(figis.has(COMPOSITE_FIGI)).toBe(true);
    expect(figis.has(NASDAQ_FIGI)).toBe(true);
  });

  it('drops the whole payload when the element count does not match the job count', () => {
    const dropped = parseOpenFigiMapping(openFigiRaw.body, [
      ...JOBS,
      { idType: 'TICKER', idValue: 'MSFT' },
    ]);
    expect(dropped.elements).toEqual([]);
    expect(dropped.problems[0]?.kind).toBe('schema_drift');
  });
});

describe('the job table row (PROVIDERS §13)', () => {
  it('matches the normative row', () => {
    expect(symbologyRefreshJob.id).toBe('symbologyRefresh');
    expect(symbologyRefreshJob.schedule).toBe('0 6 * * 1-5');
    expect(symbologyRefreshJob.providers).toEqual(['openfigi.mapping', 'sec.tickers']);
    expect(symbologyRefreshJob.priority).toBe(3);
    expect(symbologyRefreshJob.timeoutMs).toBe(600_000);
  });
});

describe('runSymbologyRefresh against the captures', () => {
  const t = withTxDb();

  // Both runs happen inside one test case: the harness opens a transaction per test and rolls it
  // back afterwards, so "run it twice" has to mean twice in the same transaction.

  it('writes the documented master rows on the first run', async () => {
    await ensureLicence(t, 'sec.tickers', 'public_domain');
    await ensureLicence(t, 'openfigi.mapping', 'vendor_terms');

    const before: TableCounts = await tableCounts(t);
    const first: SymbologyRefreshResult = await runSymbologyRefresh(
      { tx: t.db, clock, store },
      { tickers: ['AAPL'] },
    );
    const afterFirst: TableCounts = await tableCounts(t);

    expect(first.status).toBe('ok');
    expect(first.errors).toEqual([]);
    expect(first.problems).toEqual([]);
    expect(first.tickers).toEqual(['AAPL']);
    expect(first.fetched).toBe(2);
    expect(first.provenanceIds).toHaveLength(2);

    expect(first.counts).toEqual({
      secEntries: SEC_ENTRIES,
      requests: 1,
      records: DISTINCT_RECORDS,
      issuers: 1,
      issues: 1,
      instruments: 1,
      listings: US_LISTINGS,
      identifiers: IDENTIFIERS,
      deferredNonUs: DEFERRED_NON_US,
      deferredNoComposite: DEFERRED_NO_COMPOSITE,
      unresolved: 0,
    });
    expect(first.inserted).toBe(FIRST_RUN_WRITES);
    expect(first.updated).toBe(0);
    expect(first.skipped).toBe(0);

    // Counted by rows, not by the job's own arithmetic.
    expect(delta(before, afterFirst)).toEqual({
      issuers: 1,
      issues: 1,
      instruments: 1,
      listings: US_LISTINGS,
      identifiers: IDENTIFIERS,
      // The quote lines belong to WP-15's seed: one writer per (source_id, provider_symbol).
      md_lines: 0,
      provenance: 2,
    });

    // ── the rows themselves ──────────────────────────────────────────────────────────────────
    const master = new MasterRepositories(t.db);
    const ids = new IdentifierRepository(t.db);

    const instrumentRef = await ids.entityOf(
      { scheme: 'COMPOSITE_FIGI', value: COMPOSITE_FIGI },
      at,
    );
    expect(instrumentRef?.entityKind).toBe('instrument');
    const instrument = await master.instruments.get(instrumentRef?.entityId ?? -1, at);
    expect(instrument).not.toBeNull();
    expect(instrument?.ticker).toBe('AAPL');
    expect(instrument?.exchCode).toBe('US');
    expect(instrument?.compositeFigi).toBe(COMPOSITE_FIGI);
    expect(instrument?.assetClass).toBe('equity');
    expect(instrument?.marketSector).toBe('Equity');
    expect(instrument?.currency).toBe('USD');
    expect(instrument?.name).toBe('APPLE INC');
    // OpenFIGI publishes no primary-venue flag, so the job claims none.
    expect(instrument?.primaryListingId).toBeUndefined();

    const issue = await master.issues.get(instrument?.issueId ?? -1, at);
    expect(issue?.shareClassFigi).toBe(SHARE_CLASS_FIGI);
    expect(issue?.securityType).toBe('Common Stock');
    expect(issue?.name).toBe('APPLE INC');

    const issuer = await master.issuers.get(issue?.issuerId ?? -1, at);
    // SEC `title` wins for the issuer name; OpenFIGI's ALL-CAPS name stays on the issue.
    expect(issuer?.name).toBe(AAPL_TITLE);
    expect(issuer?.cik).toBe(AAPL_CIK);

    const cikRef = await ids.entityOf({ scheme: 'CIK', value: AAPL_CIK }, at);
    expect(cikRef).toEqual({ entityKind: 'issuer', entityId: issuer?.issuerId });

    // `AAPL/US` is the composite → the instrument; `AAPL/UW` is a venue → the listing (REF-01).
    const compositeTicker = await ids.entityOf(
      { scheme: 'TICKER_EXCH', value: 'AAPL', qualifier: 'US' },
      at,
    );
    expect(compositeTicker).toEqual({
      entityKind: 'instrument',
      entityId: instrumentRef?.entityId,
    });
    const nasdaqTicker = await ids.entityOf(
      { scheme: 'TICKER_EXCH', value: 'AAPL', qualifier: 'UW' },
      at,
    );
    expect(nasdaqTicker?.entityKind).toBe('listing');
    const nasdaq = await master.listings.get(nasdaqTicker?.entityId ?? -1, at);
    expect(nasdaq?.figi).toBe(NASDAQ_FIGI);
    expect(nasdaq?.instrumentId).toBe(instrumentRef?.entityId);
    expect(nasdaq?.localTicker).toBe('AAPL');
    expect(nasdaq?.isPrimary).toBe(false);

    // The composite record writes no `listings` row of its own (PROVIDERS §6.1).
    expect(await master.listings.byFigi(COMPOSITE_FIGI, at)).toEqual([]);
    const listings = await master.listings.byInstrument(instrumentRef?.entityId ?? -1, at);
    expect(listings).toHaveLength(US_LISTINGS);
    expect(new Set(listings.map((listing) => listing.exchCode)).size).toBe(US_LISTINGS);

    // One ticker, twenty-one places it means something: the composite and its twenty venues.
    const tickerRows = await ids.lookup('TICKER_EXCH', 'AAPL', at);
    expect(tickerRows).toHaveLength(US_LISTINGS + 1);

    // ── the second run writes nothing (QA-02) ────────────────────────────────────────────────
    const second: SymbologyRefreshResult = await runSymbologyRefresh(
      { tx: t.db, clock, store },
      { tickers: ['AAPL'] },
    );
    const afterSecond: TableCounts = await tableCounts(t);

    expect(second.status).toBe('ok');
    expect(second.errors).toEqual([]);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(FIRST_RUN_WRITES);
    expect(second.counts).toEqual({
      ...first.counts,
      issuers: 0,
      issues: 0,
      instruments: 0,
      listings: 0,
      identifiers: 0,
    });

    expect(delta(afterFirst, afterSecond)).toEqual({
      issuers: 0,
      issues: 0,
      instruments: 0,
      listings: 0,
      identifiers: 0,
      md_lines: 0,
      // PROVIDERS §1.3: one provenance row per non-304 exchange, whatever the payload says.
      provenance: 2,
    });
  });

  it('does no work on a 304 (PROVIDERS §1.3)', async () => {
    const before = await tableCounts(t);
    const result = await runSymbologyRefresh(
      { tx: t.db, clock, http: stubClient(stubRecord(304, '')) },
      { tickers: ['AAPL'] },
    );
    expect(result.status).toBe('skipped');
    expect(result.fetched).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.provenanceIds).toEqual([]);
    // A revalidation writes no provenance row, so nothing at all moves.
    expect(delta(before, await tableCounts(t))).toEqual({
      issuers: 0,
      issues: 0,
      instruments: 0,
      listings: 0,
      identifiers: 0,
      md_lines: 0,
      provenance: 0,
    });
  });

  it('rejects a truncated company_tickers.json and keeps the previous master (PROVIDERS §7.1)', async () => {
    const truncated = JSON.stringify({
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
    });
    const dqBefore = await t.client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM dq_events WHERE kind = 'poll_anomaly'",
    );
    const before = await tableCounts(t);

    const result = await runSymbologyRefresh(
      { tx: t.db, clock, http: stubClient(stubRecord(200, truncated)) },
      { tickers: ['AAPL'] },
    );
    expect(result.status).toBe('skipped');
    expect(result.counts.secEntries).toBe(1);
    expect(result.errors.map((error) => error.code)).toEqual(['POLL_ANOMALY']);
    expect(result.provenanceIds).toEqual([]);

    const dqAfter = await t.client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM dq_events WHERE kind = 'poll_anomaly'",
    );
    expect(Number(dqAfter.rows[0]?.n) - Number(dqBefore.rows[0]?.n)).toBe(1);
    expect(delta(before, await tableCounts(t))).toEqual({
      issuers: 0,
      issues: 0,
      instruments: 0,
      listings: 0,
      identifiers: 0,
      md_lines: 0,
      provenance: 0,
    });
  });

  it('derives its own target set when the caller names none', async () => {
    await ensureLicence(t, 'sec.tickers', 'public_domain');
    await ensureLicence(t, 'openfigi.mapping', 'vendor_terms');

    // Nothing is in the master, so every SEC ticker is unresolved; the cap bounds the run, and
    // the alphabetical head of the file has no recorded OpenFIGI capture — which is exactly what
    // a replay miss is for (PROVIDERS §3.6), so the run is expected to fail loudly, not silently.
    await expect(
      runSymbologyRefresh({ tx: t.db, clock, store }, { maxTickers: 1 }),
    ).rejects.toThrow(/no capture for openfigi.mapping/);
  });
});
