/**
 * `search/snapshot.ts` — the WP-08 acceptance row: "ETag 304 on repeat; snapshot contains
 * instruments + functions + people + topics; size budget" (WORKPLAN L1099, API.md §5.2 L438-488).
 *
 * Self-sufficient (TESTING §4.3): every instrument, person and topic below is written by this file
 * inside its own transaction and rolled back. `tx_from` is passed explicitly on every bitemporal
 * insert, because the column default is the wall clock and a fixture must be visible to the frozen
 * `TEST_NOW` the snapshot reads through its injected clock.
 *
 * ## The size budget, and what was actually measured
 *
 * The shipped universe is ≈36 k instruments. Seeding 36 k rows here would add ~20 s to a suite that
 * runs on every commit for a number that is a straight line in the row count, so this file seeds
 * {@link SEEDED} rows of realistic shape — four-letter tickers, real-length issuer names (Apple
 * Inc, Berkshire Hathaway Holdings Inc), a mix of asset classes and exchange codes — measures the
 * serialized payload, subtracts the fixed non-instrument part, and extrapolates per row. The
 * extrapolation is asserted against {@link BUDGET_BYTES}, and the per-row figure is asserted too,
 * so a regression in either the row width or the fixed overhead fails here rather than in a
 * browser on a slow connection.
 *
 * What the numbers mean: the payload is dominated by the instrument array, and inside it by the
 * `name` and `ticker` strings — the tuple encoding of API.md §5.2 exists precisely so that the
 * field names are not 60 % of the bytes. `BUDGET_BYTES` is the UNCOMPRESSED size; the route serves
 * it gzipped, which takes roughly a quarter of it.
 */

import { gzipSync } from 'node:zlib';

import { z } from 'zod';

import { FunctionRegistry, VirtualClock } from '@terminal/core';
import type { AnyFunctionManifest, AssetClass } from '@terminal/core';
import { UniverseSnapshot as WireUniverseSnapshot } from '@terminal/sdk/wire/rest/search';
import { describe, expect, it } from 'vitest';

import { etagMatches, universeSnapshot, wireSnapshot } from '../../../src/search/snapshot.js';
import { TEST_NOW } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';

import type { TestDb } from '../../../src/test/db.js';

/** Instruments seeded per case: enough to measure a stable bytes-per-row, cheap enough to run. */
const SEEDED = 2_000;

/** The shipped universe (WORKPLAN L1077: "sized for the ≈36 k seeded instruments"). */
const SHIPPED = 36_000;

/**
 * The uncompressed ceiling for the shipped universe. Derived, not guessed: the §5.2 tuple is
 * `[id, ticker, sector, exch, name, class, weight, status]`, whose JSON is ~65-70 bytes for a
 * realistic row, so 36 k rows is ~2.4 MB. 4 MB leaves headroom for longer names (funds and
 * municipal lines run long) without leaving room for a regression that doubles the payload.
 */
const BUDGET_BYTES = 4_000_000;

/** A generous per-row ceiling; the measured figure is reported in the assertion message. */
const BUDGET_BYTES_PER_INSTRUMENT = 110;

/**
 * The gzipped ceiling — what crosses the wire. Loose on purpose: {@link SEEDED} rows draw their
 * names from twenty strings, so they compress far better than 36 k distinct issuer names would,
 * and an extrapolation from them understates the shipped figure. It is asserted anyway because a
 * change that made the payload incompressible (say, interleaving random ids into every string)
 * would blow through even this.
 */
const BUDGET_GZIP_BYTES = 2_000_000;

/** The non-instrument part of the gzipped payload is too small to measure; treat it as zero. */
const GZIP_FIXED_ALLOWANCE = 0;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture manifests — `core/functions/manifests/` is empty until WP-09/10/11, so the catalogue
// this file ranks and serves is built here (WP-08 must not write into that directory).
// ─────────────────────────────────────────────────────────────────────────────────────────────

const PRICED: readonly AssetClass[] = ['equity', 'etf', 'index', 'fx', 'govt'];

function manifest(spec: {
  code: string;
  name: string;
  aliases?: readonly string[];
  tier: 1 | 2 | 3;
  assetClasses?: readonly AssetClass[] | 'any' | 'none';
  requiresSecurity?: boolean;
}): AnyFunctionManifest {
  return {
    code: spec.code,
    name: spec.name,
    aliases: spec.aliases ?? [],
    tier: spec.tier,
    category: 'reference',
    assetClasses: spec.assetClasses ?? PRICED,
    requiresSecurity: spec.requiresSecurity ?? false,
    variants: {},
    params: z.object({}),
    paramGrammar: { positional: [] },
    fieldIds: () => [],
    pageable: false,
    live: null,
    csv: { filename: () => 'fixture.csv', columns: [], rows: () => [] },
    help: { summary: '', description: '', params: [], keys: [], sources: [], related: [] },
    keymap: [],
    screenKind: 'declarative',
    payloadVersion: 1,
  };
}

function fixtureRegistry(): FunctionRegistry {
  return new FunctionRegistry([
    manifest({ code: 'DES', name: 'Security Description', tier: 1, requiresSecurity: true }),
    manifest({ code: 'GP', name: 'Price Graph', tier: 1, requiresSecurity: true }),
    manifest({ code: 'MSG', name: 'Messages', tier: 2, aliases: ['IB'], assetClasses: 'none' }),
    manifest({ code: 'TOP', name: 'Top News', tier: 3, assetClasses: 'none' }),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Seeding
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function prov(t: TestDb): Promise<number> {
  const key = `universe-snapshot-${String(Math.random()).slice(2)}`;
  const res = await t.client.query<{ provenance_id: string }>(
    `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                             http_status, bytes, captured_at, source_ts, adapter_version)
     VALUES ('openfigi.mapping', $1, 'test://' || $1, digest($1,'sha256'), digest($1,'sha256'),
             200, 0, $2, $2, 'test/1.0.0')
     RETURNING provenance_id`,
    [key, new Date(TEST_NOW).toISOString()],
  );
  return Number(res.rows[0]!.provenance_id);
}

/**
 * `n` instruments of realistic shape in one statement.
 *
 * Four-letter tickers (`AAAA`…) from a base-26 encoding of the row number, so every ticker is
 * unique and four characters like a real one; names from twenty real issuer names crossed with
 * seven real suffixes, which puts the mean name length at ~19 characters against the ~20 of the
 * shipped master; and a ten-way asset-class mix so `market_sector` and `exch_code` are not all the
 * same short string. One row in ten is delisted, which is what exercises `status: 0`.
 */
async function seedInstruments(t: TestDb, p: number, issueId: number, n: number): Promise<void> {
  await t.client.query(
    `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                              exch_code, name, currency, status, search_weight,
                              valid_from, tx_from, provenance_id)
     SELECT nextval('instrument_id_seq'),
            $2,
            (CASE WHEN g % 10 = 3 THEN 'index'
                  WHEN g % 10 = 5 THEN 'fx'
                  WHEN g % 10 = 7 THEN 'govt'
                  ELSE 'equity' END)::asset_class,
            (CASE WHEN g % 10 = 3 THEN 'Index'
                  WHEN g % 10 = 5 THEN 'Curncy'
                  WHEN g % 10 = 7 THEN 'Govt'
                  ELSE 'Equity' END)::market_sector,
            chr(65 + (g / 17576) % 26) || chr(65 + (g / 676) % 26)
              || chr(65 + (g / 26) % 26) || chr(65 + g % 26),
            (CASE WHEN g % 10 = 3 THEN 'INDEX'
                  WHEN g % 10 = 5 THEN 'FX'
                  WHEN g % 10 = 7 THEN 'GOVT'
                  ELSE 'US' END),
            (ARRAY['Apple','Microsoft','NVIDIA','Amazon','Alphabet','Meta Platforms','Tesla',
                   'Berkshire Hathaway','JPMorgan Chase','Exxon Mobil','Johnson & Johnson',
                   'Procter & Gamble','UnitedHealth','Home Depot','Walt Disney','Coca-Cola',
                   'Verizon','Intel','Cisco Systems','Pfizer'])[1 + (g % 20)]
              || ' '
              || (ARRAY['Inc','Corporation','Co','plc','Holdings Inc','Group Inc',
                        'Ltd'])[1 + (g % 7)],
            'USD',
            (CASE WHEN g % 10 = 9 THEN 'delisted' ELSE 'active' END),
            (CASE WHEN g % 10 = 3 THEN 2.0 ELSE 1.0 END),
            '2020-01-01', '2020-01-01', $3
       FROM generate_series(0, $1::int - 1) g`,
    [n, issueId, p],
  );
}

/** One option contract: §5.2 excludes options from the snapshot, and this proves it. */
async function seedOption(t: TestDb, p: number, issueId: number): Promise<void> {
  await t.client.query(
    `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                              exch_code, name, currency, valid_from, tx_from, provenance_id)
     VALUES (nextval('instrument_id_seq'), $1, 'option', 'Equity', 'AAPL260916C00245000',
             'US', 'AAPL 9/16/26 C245', 'USD', '2020-01-01', '2020-01-01', $2)`,
    [issueId, p],
  );
}

/** A superseded instrument version: the snapshot must carry the current row, once. */
async function seedSupersededVersion(t: TestDb, p: number, issueId: number): Promise<number> {
  const res = await t.client.query<{ instrument_id: string }>(
    `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                              exch_code, name, currency, valid_from, valid_to, tx_from, tx_to,
                              provenance_id)
     VALUES (nextval('instrument_id_seq'), $1, 'equity', 'Equity', 'OLDN', 'US',
             'Old Name Inc', 'USD', '2020-01-01', 'infinity', '2020-01-01',
             '2021-01-01', $2)
     RETURNING instrument_id`,
    [issueId, p],
  );
  const id = Number(res.rows[0]!.instrument_id);
  await t.client.query(
    `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                              exch_code, name, currency, valid_from, tx_from, provenance_id)
     VALUES ($1, $2, 'equity', 'Equity', 'NEWN', 'US', 'New Name Inc', 'USD',
             '2020-01-01', '2021-01-01', $3)`,
    [id, issueId, p],
  );
  return id;
}

async function seedPeopleAndTopics(
  t: TestDb,
  p: number,
  issuerId: number,
): Promise<{ topicCodes: string[] }> {
  await t.client.query(
    `INSERT INTO people (person_id, name, role, issuer_id, source_id, valid_from, tx_from,
                         provenance_id)
     VALUES (nextval('person_id_seq'), 'Jane Doe', 'CFO', $1, 'sec.atom', '2020-01-01',
             '2020-01-01', $2),
            (nextval('person_id_seq'), 'John Roe', 'Fed Chair', NULL, 'sec.atom', '2020-01-01',
             '2020-01-01', $2),
            (nextval('person_id_seq'), 'Anon Reporter', NULL, NULL, 'bbg.rss', '2020-01-01',
             '2020-01-01', $2)`,
    [issuerId, p],
  );
  const suffix = String(Math.random()).slice(2, 8);
  const topicCodes = [`MKT${suffix}`, `FED${suffix}`];
  await t.client.query(
    `INSERT INTO topics (code, name, kind) VALUES ($1,'Markets','feed'), ($2,'Federal Reserve','theme')`,
    topicCodes,
  );
  return { topicCodes };
}

async function seedIssuer(t: TestDb, p: number): Promise<{ issuerId: number; name: string }> {
  const name = 'Demo Capital Inc';
  const res = await t.client.query<{ issuer_id: string }>(
    `INSERT INTO issuers (issuer_id, name, valid_from, tx_from, provenance_id)
     VALUES (nextval('issuer_id_seq'), $1, '2020-01-01', '2020-01-01', $2)
     RETURNING issuer_id`,
    [name, p],
  );
  return { issuerId: Number(res.rows[0]!.issuer_id), name };
}

async function nextId(t: TestDb, seq: string): Promise<number> {
  const res = await t.client.query<{ id: string }>(`SELECT nextval($1)::bigint AS id`, [seq]);
  return Number(res.rows[0]!.id);
}

async function bumpUniverseVersion(t: TestDb): Promise<void> {
  await t.client.query(
    `UPDATE config_versions SET version = version + 1, updated_at = now() WHERE name = 'universe'`,
  );
}

/**
 * What the snapshot already holds before this test seeds anything.
 *
 * `universeSnapshot()` scans every instrument, person and topic the transaction can see, and a
 * `withTxDb()` transaction can see every row an earlier suite COMMITTED. So an absolute count is
 * an assertion about the whole database, which fails on any machine whose `bloomberg_test` is not
 * pristine — and passes or fails depending on what ran first. Every count below is therefore
 * relative to this baseline, taken with the same query and the same filters the assertion uses.
 */
async function baselineOf(t: TestDb): Promise<{
  instruments: number;
  people: number;
  topics: number;
}> {
  const snap = await universeSnapshot({
    db: t.db,
    clock: new VirtualClock(TEST_NOW),
    registry: fixtureRegistry(),
  }).get();
  return {
    instruments: snap.instruments.length,
    people: snap.people.length,
    topics: snap.topics.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('universe snapshot', () => {
  const t = withTxDb();

  it('carries all four entity kinds, excludes options, and re-parses under the wire schema', async () => {
    const base = await baselineOf(t);
    const p = await prov(t);
    const issueId = await nextId(t, 'issue_id_seq');
    const issuer = await seedIssuer(t, p);
    await seedInstruments(t, p, issueId, 40);
    await seedOption(t, p, issueId);
    const superseded = await seedSupersededVersion(t, p, issueId);
    const { topicCodes } = await seedPeopleAndTopics(t, p, issuer.issuerId);

    const cache = universeSnapshot({
      db: t.db,
      clock: new VirtualClock(TEST_NOW),
      registry: fixtureRegistry(),
    });
    const snap = await cache.get();

    // ── all four kinds are present ──────────────────────────────────────────────────────────
    // 40 seeded + the superseded row's current version, on top of whatever the database already
    // held: this suite shares `instruments` with every other committed row in `bloomberg_test`.
    expect(snap.instruments.length).toBe(base.instruments + 41);
    expect(snap.functions.length).toBe(4); // the fixture registry, not a table
    expect(snap.people.length).toBe(base.people + 3);
    expect(snap.topics.length).toBe(base.topics + 2);

    // ── instruments: the §5.2 tuple, positionally ───────────────────────────────────────────
    // Looked up by ticker, not by position: the snapshot orders by `instrument_id`, and which id
    // `nextval()` handed to which `generate_series` row is not something a test should assert.
    const first = snap.instruments.find((row) => row[1] === 'AAAA');
    expect(first).toBeDefined();
    expect(first).toHaveLength(8);
    const [id, ticker, sector, exch, name, assetClass, weight, status] = first!;
    expect(typeof id).toBe('number');
    expect(ticker).toBe('AAAA');
    expect(sector).toBe('Equity');
    expect(exch).toBe('US');
    expect(name).toBe('Apple Inc');
    expect(assetClass).toBe('equity');
    expect(weight).toBe(1);
    expect(status).toBe(1);

    // `status: 0` for anything not active — the ranker's −30 penalty, not a hidden row.
    const delisted = snap.instruments.filter((row) => row[7] === 0);
    expect(delisted.length).toBe(4); // g % 10 === 9 over g ∈ [0, 40)

    // Options are reached through OMON / the OCC form, never the snapshot (§3.1 L871-873).
    expect(snap.instruments.some((row) => row[5] === 'option')).toBe(false);

    // One row per instrument_id, and it is the CURRENT version.
    const ids = snap.instruments.map((row) => row[0]);
    expect(new Set(ids).size).toBe(ids.length);
    const supersededRow = snap.instruments.find((row) => row[0] === superseded);
    expect(supersededRow?.[1]).toBe('NEWN');
    expect(supersededRow?.[4]).toBe('New Name Inc');

    // ── functions: the injected registry, sorted by code, with aliases and tier ─────────────
    expect(snap.functions).toEqual([
      ['DES', 'Security Description', [], 1],
      ['GP', 'Price Graph', [], 1],
      ['MSG', 'Messages', ['IB'], 2],
      ['TOP', 'Top News', [], 3],
    ]);

    // ── people: `role · firm`, and the two degenerate halves ────────────────────────────────
    const roleFirms = snap.people.map((row) => row[2]);
    expect(roleFirms).toEqual(['CFO · Demo Capital Inc', 'Fed Chair', '']);
    expect(snap.people.map((row) => row[1])).toEqual(['Jane Doe', 'John Roe', 'Anon Reporter']);

    // ── topics ──────────────────────────────────────────────────────────────────────────────
    expect(snap.topics.map((row) => row[0]).sort()).toEqual([...topicCodes].sort());

    // ── the bytes the route writes are the wire schema, exactly ─────────────────────────────
    const parsed = WireUniverseSnapshot.parse(JSON.parse(snap.body));
    expect(parsed.version).toBe(snap.version);
    expect(parsed.generatedAt).toBe(snap.generatedAt);
    expect(parsed.instruments).toEqual(snap.instruments);
    expect(parsed.functions).toEqual(snap.functions);
    expect(parsed.people).toEqual(snap.people);
    expect(parsed.topics).toEqual(snap.topics);
    expect(wireSnapshot(snap)).toEqual(parsed);
  });

  it('serves a repeat request from cache and answers If-None-Match with 304', async () => {
    const p = await prov(t);
    const issueId = await nextId(t, 'issue_id_seq');
    await seedInstruments(t, p, issueId, 25);

    const clock = new VirtualClock(TEST_NOW);
    const cache = universeSnapshot({ db: t.db, clock, registry: fixtureRegistry() });

    const first = await cache.get();
    expect(cache.stats().builds).toBe(1);
    expect(first.etag).toBe(`"${first.version}"`);

    // The repeat: the universe version has not moved, so nothing is rebuilt and the client's
    // `If-None-Match` matches — which is the 304, decided here rather than in the route.
    clock.advance(60_000);
    const second = await cache.get();
    expect(second).toBe(first); // the same object: no re-read, no re-serialize
    expect(cache.stats().builds).toBe(1);
    expect(cache.stats().freshChecks).toBe(1);
    expect(etagMatches(first.etag, second.etag)).toBe(true);
    expect(etagMatches(`W/${first.etag}`, second.etag)).toBe(true);
    expect(etagMatches(`"deadbeef", ${first.etag}`, second.etag)).toBe(true);
    expect(etagMatches('*', second.etag)).toBe(true);
    expect(etagMatches('"deadbeef"', second.etag)).toBe(false);
    expect(etagMatches(undefined, second.etag)).toBe(false);
  });

  it('is content-addressed: a rebuild of an unchanged universe keeps the ETag', async () => {
    const p = await prov(t);
    const issueId = await nextId(t, 'issue_id_seq');
    await seedInstruments(t, p, issueId, 25);
    const registry = fixtureRegistry();

    const early = universeSnapshot({ db: t.db, clock: new VirtualClock(TEST_NOW), registry });
    const a = await early.get();

    // A second process, an hour later, over the same rows: `generatedAt` differs, the ETag must
    // not — otherwise a restart invalidates every client's cached snapshot for nothing.
    const later = universeSnapshot({
      db: t.db,
      clock: new VirtualClock(TEST_NOW + 3_600_000),
      registry,
    });
    const b = await later.get();
    expect(b.generatedAt).not.toBe(a.generatedAt);
    expect(b.version).toBe(a.version);
    expect(etagMatches(a.etag, b.etag)).toBe(true);

    // `invalidate()` forces the work again, and still lands on the same ETag.
    early.invalidate();
    const c = await early.get();
    expect(early.stats().builds).toBe(2);
    expect(c.version).toBe(a.version);
  });

  it('rebuilds on a config_versions(universe) bump and mints a new ETag when the content moved', async () => {
    const p = await prov(t);
    const issueId = await nextId(t, 'issue_id_seq');
    await seedInstruments(t, p, issueId, 25);

    const cache = universeSnapshot({
      db: t.db,
      clock: new VirtualClock(TEST_NOW),
      registry: fixtureRegistry(),
    });
    const before = await cache.get();

    // A bump with no content change: the build runs again, the ETag does not move, and a client
    // holding the old tag still gets its 304.
    await bumpUniverseVersion(t);
    const unchanged = await cache.get();
    expect(cache.stats().builds).toBe(2);
    expect(unchanged.version).toBe(before.version);
    expect(etagMatches(before.etag, unchanged.etag)).toBe(true);

    // A real write, and the bump the ingest job pairs with it.
    await t.client.query(
      `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                                exch_code, name, currency, valid_from, tx_from, provenance_id)
       VALUES (nextval('instrument_id_seq'), $1, 'equity', 'Equity', 'ZZZZ', 'US',
               'Late Arrival Inc', 'USD', '2020-01-01', '2020-01-01', $2)`,
      [issueId, p],
    );
    await bumpUniverseVersion(t);

    const after = await cache.get();
    expect(cache.stats().builds).toBe(3);
    expect(after.instruments.length).toBe(before.instruments.length + 1);
    expect(after.version).not.toBe(before.version);
    expect(etagMatches(before.etag, after.etag)).toBe(false);
    expect(after.configVersion).toBe(before.configVersion + 2);

    // Without a bump, a write is NOT picked up: `config_versions` is the contract, and a read
    // path that re-scanned 36 k rows on every request would be the thing this design avoids.
    await t.client.query(
      `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                                exch_code, name, currency, valid_from, tx_from, provenance_id)
       VALUES (nextval('instrument_id_seq'), $1, 'equity', 'Equity', 'YYYY', 'US',
               'Unbumped Inc', 'USD', '2020-01-01', '2020-01-01', $2)`,
      [issueId, p],
    );
    const stale = await cache.get();
    expect(stale).toBe(after);
    expect(cache.stats().builds).toBe(3);
  });

  it(`fits the size budget: ${SEEDED} rows measured, extrapolated to ${SHIPPED}`, async () => {
    const base = await baselineOf(t);
    const p = await prov(t);
    const issueId = await nextId(t, 'issue_id_seq');
    const issuer = await seedIssuer(t, p);
    await seedPeopleAndTopics(t, p, issuer.issuerId);
    await seedInstruments(t, p, issueId, SEEDED);

    const cache = universeSnapshot({
      db: t.db,
      clock: new VirtualClock(TEST_NOW),
      registry: fixtureRegistry(),
    });
    const snap = await cache.get();
    expect(snap.instruments.length).toBe(base.instruments + SEEDED);
    expect(snap.bytes).toBe(Buffer.byteLength(snap.body, 'utf8'));

    // Bytes per row are divided by the rows actually IN the payload, not by the number this test
    // inserted: the measurement is an average cost per instrument, and a row an earlier suite
    // committed costs bytes too. Dividing by `SEEDED` on a shared database would overstate the
    // per-row figure by exactly the leftovers, and the budget below would be measuring the state
    // of the machine rather than the shape of the payload.
    const measuredRows = snap.instruments.length;

    // The fixed part: everything that is not the instrument array. Measured by serializing the
    // same payload with an empty instrument array, so the figure includes the JSON scaffolding.
    const fixedBytes = Buffer.byteLength(
      JSON.stringify({
        version: snap.version,
        generatedAt: snap.generatedAt,
        instruments: [],
        functions: snap.functions,
        people: snap.people,
        topics: snap.topics,
      }),
      'utf8',
    );
    const instrumentBytes = snap.bytes - fixedBytes;
    const perInstrument = instrumentBytes / measuredRows;
    const extrapolated = Math.round(fixedBytes + perInstrument * SHIPPED);

    // What the client actually downloads: the route serves this gzipped (API.md §5.2).
    const gzipBytes = gzipSync(Buffer.from(snap.body, 'utf8'), { level: 6 }).byteLength;
    const gzipPerInstrument = (gzipBytes - GZIP_FIXED_ALLOWANCE) / measuredRows;
    const gzipExtrapolated = Math.round(GZIP_FIXED_ALLOWANCE + gzipPerInstrument * SHIPPED);

    const report =
      `measured ${String(snap.bytes)} B for ${String(measuredRows)} instruments ` +
      `(${perInstrument.toFixed(1)} B/row, ${String(fixedBytes)} B fixed); ` +
      `extrapolated ${String(extrapolated)} B for ${String(SHIPPED)}; ` +
      `gzip ${String(gzipBytes)} B measured, ${String(gzipExtrapolated)} B extrapolated`;

    expect(perInstrument, report).toBeLessThan(BUDGET_BYTES_PER_INSTRUMENT);
    expect(extrapolated, report).toBeLessThan(BUDGET_BYTES);

    // The instrument array dominates: if the fixed part ever became a material share of the
    // payload, the extrapolation above would stop being the right model.
    expect(instrumentBytes / snap.bytes).toBeGreaterThan(0.9);

    // And the lower bound, so a payload that silently stopped carrying names or tickers — which
    // would sail under every ceiling above — fails too.
    expect(perInstrument).toBeGreaterThan(40);

    // The wire cost. Seeded names repeat far more than real ones do, so this compresses better
    // than the shipped master will; the ceiling is deliberately loose because of that, and it is
    // still the number that decides whether a cold terminal loads in a second or in ten.
    expect(gzipExtrapolated, report).toBeLessThan(BUDGET_GZIP_BYTES);
  });
});
