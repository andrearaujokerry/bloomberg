/**
 * `test/integration/seed/idempotent.test.ts` — WP-15's first acceptance row (WORKPLAN L1552):
 * "`db:seed` twice writes zero rows the second time; every seeded value has a `provenance_id`
 * resolving to a fixture".
 *
 * Two halves, and they test different things, so they are separate `describe` blocks.
 *
 * ## Half 1 — idempotence
 *
 * The seed modules are run **twice inside one transaction that rolls back**, and every row count in
 * the database is snapshotted before and after the second run. Anything that moved is a failure,
 * and the failure message names the table and the delta rather than saying a number changed.
 *
 * Running both passes here rather than leaning on `globalSetup.ts` (which seeds `bloomberg_test`
 * once per vitest invocation) is deliberate: `src/test/db.ts#withCleanDb` truncates the tables a
 * suite names and lets the writes commit, so by the time this file runs, an arbitrary subset of the
 * seeded tables may be empty again depending on which files ran first. A test whose first pass is
 * somebody else's leaves the property under test at the mercy of file ordering. Two passes of our
 * own means pass 1 converges whatever state it finds, and pass 2 is the assertion.
 *
 * The counts include **every** base table, not a list — `provenance`, `ingest_runs`, `dq_events` and
 * `data_exceptions` included. Those are the interesting ones: the value tables are all upserts on a
 * natural key and were never going to move, but `insertProvenance` has no natural key, so a module
 * that re-fetched a capture would add a `provenance` row on every run claiming an exchange that, in
 * `PROVIDER_MODE=replay`, did not happen. Excluding them would have hidden exactly the bug the
 * capture gates in `seed/fundamentals.ts` and `seed/news.ts` exist to prevent, and which the first
 * implementation of this seed had.
 *
 * ## Half 2 — DATA-10
 *
 * For every base table in the schema that carries a `provenance_id` or `provenance_ids` column —
 * discovered from `information_schema`, never from a list, so a table added later cannot opt out —
 * every id actually referenced is followed to its `provenance` row and that row is then resolved
 * against the replay manifest: its `request_key` must be a key the manifest holds, its
 * `response_sha256` must equal one of that key's recorded captures, and **that capture's file must
 * exist on disk**. That is what "resolving to a fixture" has to mean; checking the column is
 * non-null proves only that a bigint is there.
 *
 * The one admitted second class is a curated-fixture pseudo-capture: `source_id` `internal.user` or
 * `internal.derived` with a `seed://…` `request_url`, which is how a module records a value that came
 * from `fixtures/seed/*` rather than from a recorded provider exchange (there is no request to have
 * a key for). Those are counted and listed rather than waved through, and the tables WP-15's own
 * modules 10-13 write are asserted to contain **none** of them — every value those four modules
 * write comes from a recorded capture, and the curated fixtures they read land in tables that have
 * no `provenance_id` column at all (`xbrl_concept_map`, `fomc_meetings`, `issuer_aliases`, and
 * everything in modules 12 and 13).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getConfig } from '../../../src/config.js';
import { seedBars } from '../../../src/seed/bars.js';
import { seedCurves } from '../../../src/seed/curves.js';
import { seedFundamentals } from '../../../src/seed/fundamentals.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { seedNews } from '../../../src/seed/news.js';
import { seedFixtureDir, seedRates } from '../../../src/seed/rates.js';
import { seedUniverse } from '../../../src/seed/universe.js';
import { seedUsers } from '../../../src/seed/users.js';
import { seedWorkspaces } from '../../../src/seed/workspaces.js';
import { openReplayStore } from '../../../src/providers/replayStore.js';
import { withTxDb } from '../../../src/test/db.js';
import { testClock } from '../../../src/test/clock.js';

import { SEED_ORDER } from '../../../src/seed/index.js';

import type { SeedContext } from '../../../src/seed/index.js';

const t = withTxDb();

/** A `SeedContext` over the test transaction — the shape `seed/index.ts` hands a module. */
function seedContext(log: string[]): SeedContext {
  return {
    query: (text: string, values?: unknown[]) => t.client.query(text, values),
    // The runner passes `drizzle(client)`; the harness passes the same client's `Tx`. Both are the
    // one open transaction, and `seed/fundamentals.ts#seedTx` narrows back in the same direction —
    // `Tx` is assignable to `Db` here, so no assertion is needed in this direction.
    db: t.db,
    config: getConfig(),
    clock: testClock(),
    log: (message: string) => void log.push(message),
  };
}

/**
 * Run **all nine** modules, in `SEED_ORDER`.
 *
 * It used to run five — module 1 and modules 10-13 — on the reasoning that modules 2-9 belong to
 * other files. That reasoning was wrong in the one way that mattered: the bug this file exists to
 * catch (its own header names it) was live in modules 3 and 5 the whole time, and this file could not
 * see it because it never called them. Two consecutive runs of the committed `npm run db:seed` took
 * `provenance` from 56 rows to 76, `ingest_runs` from 17 to 26, and rewrote all four
 * `quote_snapshots.state` blobs to cite the newer ids — while this file passed. A test that omits the
 * modules that have the bug it was written for is not a weaker test, it is a different one.
 *
 * `SEED_ORDER` is a dependency order and it is reproduced here rather than imported because
 * `runSeed()` opens its own connection and its own transaction per module, which would commit to the
 * database this test is supposed to leave untouched. The order is asserted against `SEED_ORDER` in
 * the test below, so the two cannot drift.
 */
async function runSeedModules(): Promise<string[]> {
  const log: string[] = [];
  const ctx = seedContext(log);
  await seedLicences(ctx);
  await seedUniverse(ctx);
  await seedRates(ctx);
  await seedCurves(ctx);
  await seedBars(ctx);
  await seedFundamentals(ctx);
  await seedNews(ctx);
  await seedUsers(ctx);
  await seedWorkspaces(ctx);
  return log;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row counting
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every ordinary table in `public`: no partitions (a partition's rows are already counted through
 * its parent, and counting both would double every delta), no views, no `_now` helpers.
 */
async function baseTables(): Promise<string[]> {
  const res = await t.client.query<{ relname: string }>(`
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND NOT c.relispartition
     ORDER BY c.relname`);
  return res.rows.map((r) => r.relname);
}

/** `table → row count`, in one round trip. */
async function rowCounts(tables: readonly string[]): Promise<Map<string, number>> {
  if (tables.length === 0) return new Map();
  // Every identifier here comes from `pg_class`, so it is a real relation name and quoting it is
  // enough; there is no user input anywhere in this statement.
  const parts = tables.map((name) => `SELECT '${name}' AS t, count(*)::bigint AS n FROM "${name}"`);
  const res = await t.client.query<{ t: string; n: string }>(parts.join(' UNION ALL '));
  return new Map(res.rows.map((r) => [r.t, Number(r.n)]));
}

/**
 * `table → md5 of its whole content`, with the wall-clock columns left out.
 *
 * A row COUNT is the wrong instrument on its own, and the seed proved it: `quote_snapshots` is keyed
 * on `instrument_id` and holds a fixed four rows, so a second pass that REWROTE all four states —
 * new `provenance` ids embedded in `state.prov` — moved no count at all, and the module's own summary
 * printed `quote_snapshots=0`. A content digest sees it. The same instrument catches an UPDATE
 * anywhere else in the seed, which is the other half of "writes zero rows the second time": a row
 * rewritten in place is a write.
 *
 * Wall-clock columns are excluded by their DEFAULT rather than by name — any column defaulting to
 * `now()` / `CURRENT_TIMESTAMP` / `transaction_timestamp()`. Naming them would be a list to forget to
 * update; the default is the property that makes a column non-deterministic across two passes, and it
 * is exactly the property `captured_at` has (`now()` at transaction start) that made it useless as
 * evidence in `test/replay/fundamentals/companyfacts.test.ts`. A column a module SETS explicitly
 * from the clock is not excluded, because the seed's clock is frozen and such a value must not move.
 */
async function tableDigests(tables: readonly string[]): Promise<Map<string, string>> {
  const columns = await t.client.query<{ table_name: string; column_name: string }>(`
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN pg_class pc ON pc.relname = c.table_name
      JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = c.table_schema
     WHERE c.table_schema = 'public'
       AND pc.relkind IN ('r', 'p')
       AND NOT pc.relispartition
       AND coalesce(c.column_default, '') !~* '(now\\(\\)|current_timestamp|transaction_timestamp)'
     ORDER BY c.table_name, c.ordinal_position`);

  const byTable = new Map<string, string[]>();
  for (const row of columns.rows) {
    const list = byTable.get(row.table_name);
    if (list === undefined) byTable.set(row.table_name, [`"${row.column_name}"`]);
    else list.push(`"${row.column_name}"`);
  }

  const digests = new Map<string, string>();
  for (const table of tables) {
    const cols = byTable.get(table);
    if (cols === undefined || cols.length === 0) continue;
    // Every identifier comes from the catalogue, and the ORDER BY is on the rendered row so the
    // digest does not depend on physical order (a HOT update or a partition scan can change it).
    const res = await t.client.query<{ d: string }>(
      `SELECT coalesce(md5(string_agg(r, '|' ORDER BY r)), 'empty') AS d
         FROM (SELECT (ROW(${cols.join(', ')}))::text AS r FROM "${table}") s`,
    );
    digests.set(table, res.rows[0]?.d ?? 'error');
  }
  return digests;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The replay manifest, as a digest → file map
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface ManifestCaptureView {
  file: string;
  sha256: string;
}

interface ManifestEntryView {
  providerId: string;
  url: string;
  captures: ManifestCaptureView[];
}

/** `request_key → the recorded captures under it`, straight from `fixtures/providers/manifest.json`. */
function manifestByKey(): Map<string, ManifestEntryView> {
  const store = openReplayStore();
  return new Map(
    Object.entries(store.manifest).map(([key, entry]) => [
      key,
      {
        providerId: entry.providerId,
        url: entry.url,
        captures: entry.captures.map((capture) => ({ file: capture.file, sha256: capture.sha256 })),
      },
    ]),
  );
}

/** `true` when the fixture file the manifest names is actually on disk. */
function fixtureFileExists(relativePath: string): boolean {
  try {
    readFileSync(join(openReplayStore().dir, relativePath));
    return true;
  } catch {
    return false;
  }
}

/** Tables written by WP-15 modules 10 and 11 that carry a provenance reference. */
const WP15_VALUE_TABLES: readonly string[] = [
  'filings',
  'xbrl_facts',
  'xbrl_frames',
  'fin_statements',
  'short_interest',
  'news_items',
  'econ_observations',
  'econ_release_events',
  'people',
];

/**
 * Columns whose `provenance_id` is documented as nullable, with why.
 *
 * `licence_registry` — 0002: "NULL only for rows written by seed/licences.ts (bootstrap)"; the
 * registry has to exist before anything can have provenance, including provenance itself.
 * `fomc_meetings` — no `fed.fomc` capture exists (PROVIDERS §16.9), so the curated 2026 calendar has
 * nothing to point at and `fixtures/seed/fomc-2026.json` is the source of record.
 * `portfolio_imports` — 0012: an import may predate its `internal.user` provenance row.
 *
 * Any *other* NULL is a defect, which is why the set is closed here rather than tolerated by a
 * `WHERE provenance_id IS NOT NULL` in the walk.
 */
const NULL_PROVENANCE_ALLOWED: ReadonlySet<string> = new Set([
  'licence_registry',
  'fomc_meetings',
  'portfolio_imports',
]);

interface ProvenanceColumn {
  table: string;
  column: 'provenance_id' | 'provenance_ids';
  nullable: boolean;
}

/** Every base table carrying a provenance reference — discovered, not listed. */
async function provenanceColumns(): Promise<ProvenanceColumn[]> {
  const res = await t.client.query<{
    table_name: string;
    column_name: string;
    is_nullable: string;
  }>(`
    SELECT c.table_name, c.column_name, c.is_nullable
      FROM information_schema.columns c
      JOIN pg_class pc ON pc.relname = c.table_name
      JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = c.table_schema
     WHERE c.table_schema = 'public'
       AND c.column_name IN ('provenance_id', 'provenance_ids')
       AND c.table_name <> 'provenance'
       AND pc.relkind IN ('r', 'p')
       AND NOT pc.relispartition
     ORDER BY c.table_name`);
  return res.rows.map((row) => ({
    table: row.table_name,
    column: row.column_name as 'provenance_id' | 'provenance_ids',
    nullable: row.is_nullable === 'YES',
  }));
}

/** One provenance row as the DATA-10 walk sees it. */
interface ReferencedProvenance {
  provenanceId: number;
  sourceId: string;
  requestKey: string;
  requestUrl: string;
  digest: string;
  tables: Set<string>;
}

/** Follow every referenced id to its `provenance` row, remembering which tables referenced it. */
async function referencedProvenance(
  columns: readonly ProvenanceColumn[],
): Promise<{ rows: Map<number, ReferencedProvenance>; nulls: Map<string, number> }> {
  const rows = new Map<number, ReferencedProvenance>();
  const nulls = new Map<string, number>();

  for (const column of columns) {
    const source =
      column.column === 'provenance_ids'
        ? `SELECT DISTINCT unnest(provenance_ids) AS id FROM "${column.table}"`
        : `SELECT DISTINCT provenance_id AS id FROM "${column.table}"`;

    const res = await t.client.query<{
      id: string | null;
      source_id: string | null;
      request_key: string | null;
      request_url: string | null;
      digest: string | null;
    }>(`
      WITH ids AS (${source})
      SELECT ids.id, p.source_id, p.request_key, p.request_url,
             encode(p.response_sha256, 'hex') AS digest
        FROM ids LEFT JOIN provenance p ON p.provenance_id = ids.id`);

    for (const row of res.rows) {
      if (row.id === null) {
        nulls.set(column.table, (nulls.get(column.table) ?? 0) + 1);
        continue;
      }
      const id = Number(row.id);
      expect(
        row.digest,
        `${column.table}.${column.column} references provenance_id ${String(id)}, which does not ` +
          'exist — DATA-10 is a join, not a convention',
      ).not.toBeNull();

      const existing = rows.get(id);
      if (existing !== undefined) {
        existing.tables.add(column.table);
        continue;
      }
      rows.set(id, {
        provenanceId: id,
        sourceId: row.source_id ?? '',
        requestKey: row.request_key ?? '',
        requestUrl: row.request_url ?? '',
        digest: row.digest ?? '',
        tables: new Set([column.table]),
      });
    }
  }

  return { rows, nulls };
}

/**
 * Tables whose rows are, by definition, computed from other provenanced rows rather than read from a
 * capture: a bootstrapped curve, a standardised statement, a fitted surface (ANAL-08).
 *
 * The set is closed on purpose. A `derived://` provenance row is admitted only when *every* table
 * referencing it is in here, so a quote or a bar that acquired derived provenance fails this file —
 * which is the failure worth catching, because a derived price looks exactly like a real one.
 */
const DERIVED_TABLES: ReadonlySet<string> = new Set([
  'curve_builds',
  'curve_points',
  'fin_statements',
  'vol_surfaces',
]);

/**
 * How a provenance row that is not a recorded capture is classified.
 *
 * Two conventions are in use across the seed modules, and both are legitimate — a curated fixture and
 * a derived artefact have no provider request, so they have no request key for the manifest to hold:
 *
 *   `seed://universe/reference`, `seed://treasuries.json`  — a curated `fixtures/seed/*` payload
 *   `derived://derive:SOFR_OIS:2026-09-14`                 — a bootstrapped curve build
 *
 * They are classified rather than excused: `curated` must name a file under `fixtures/seed` that
 * exists (which is what "resolves to a fixture" means for the curated half), and `derived` is
 * confined to {@link DERIVED_TABLES}.
 *
 * **There was a third convention and it is gone on purpose.** `seed/rates.ts` used to record
 * `file:///Users/<someone>/…/fixtures/seed/treasuries.json`, and this function used to accept it by
 * resolving the absolute path with `existsSync`. That passed only because every machine seeds its own
 * database: restore a dump taken anywhere else and the row classifies `unknown` and this file fails
 * for a reason that has nothing to do with data quality. `provenance.request_url` is also what the
 * Ctrl+I popover shows, so the path was on screen. No `file:` branch is left, which means a module
 * that reaches for `pathToFileURL` again lands in `unknown` and fails here — see the companion test
 * that rejects an absolute path outright.
 */
type ProvenanceClass = 'curated' | 'derived' | 'unknown';

function classifyNonRecorded(row: ReferencedProvenance): ProvenanceClass {
  if (row.sourceId === 'internal.derived' && row.requestUrl.startsWith('derived:')) {
    return [...row.tables].every((table) => DERIVED_TABLES.has(table)) ? 'derived' : 'unknown';
  }
  if (row.sourceId === 'internal.user' || row.sourceId === 'internal.derived') {
    // `seed://<name>` and `seed://universe/<table>` both name a path under `fixtures/seed`, and the
    // claim is checkable: the file the URL names must be on disk. Bare `seed://universe/reference`
    // names a synthesised payload rather than a file, so a missing file is only a failure when the
    // last segment looks like one.
    if (row.requestUrl.startsWith('seed:')) {
      const name = row.requestUrl.replace(/^seed:\/*/, '');
      if (!/\.[a-z0-9]+$/i.test(name)) return 'curated';
      return existsSync(join(seedFixtureDir(), name)) ? 'curated' : 'unknown';
    }
  }
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every test seeds inside its own transaction.
 *
 * `src/test/db.ts#withTxDb` opens the transaction in a `beforeEach` and rolls it back in `afterEach`,
 * so a suite-level `beforeAll` runs *before* any transaction exists and its writes would belong to no
 * test. Sharing one seeded state across several `it` blocks is therefore not available here, and the
 * alternative — a `beforeAll` that reaches for `t.client` anyway — reads a handle from the previous
 * test's released connection, which is how the first draft of this file passed four assertions
 * against an empty database. So each test pays for its own pass. In a normal `npm test` run that is
 * nearly free: `globalSetup.ts` has already committed a seed, so every capture gate fires and a pass
 * is a few hundred milliseconds of `SELECT`s.
 */
describe('seed idempotence (DATA_MODEL §18)', () => {
  it('runs every module in SEED_ORDER, so no module can escape this file', () => {
    // The one assertion that keeps the omission this file was rewritten to fix from coming back.
    // `runSeedModules` calls the nine exports by hand (see its comment); this pins that list to the
    // runner's own order, so a tenth module added to `SEED_ORDER` fails here until it is called.
    expect(SEED_ORDER.map((step) => step.name)).toEqual([
      'licences',
      'universe',
      'rates',
      'curves',
      'bars',
      'fundamentals',
      'news',
      'users',
      'workspaces',
    ]);
  });

  it('runs twice, and the second pass writes nothing and rewrites nothing', async () => {
    await runSeedModules();

    const tables = await baseTables();
    const before = await rowCounts(tables);
    const digestsBefore = await tableDigests(tables);
    const secondRunLog = await runSeedModules();
    const after = await rowCounts(tables);
    const digestsAfter = await tableDigests(tables);

    const moved: string[] = [];
    for (const table of tables) {
      const from = before.get(table) ?? 0;
      const to = after.get(table) ?? 0;
      if (from !== to) moved.push(`${table}: ${String(from)} \u2192 ${String(to)}`);
    }

    expect(
      moved,
      'the second seed pass changed row counts. Every module is meant to converge: a value table ' +
        'upserts on its natural key, and an ingest leg is skipped outright when its own output ' +
        'already cites every capture behind it ' +
        `(seed/fundamentals.ts#recordedLegs). Moved:\n  ${moved.join('\n  ')}`,
    ).toEqual([]);

    // The count-blind half: a row REWRITTEN in place moves no count. This is the instrument that
    // found `quote_snapshots`, whose four states were re-cited to new `provenance` ids on every run
    // while the count sat at four and the summary line said `quote_snapshots=0`.
    const rewritten: string[] = [];
    for (const table of tables) {
      const from = digestsBefore.get(table);
      const to = digestsAfter.get(table);
      if (from !== undefined && to !== undefined && from !== to) rewritten.push(table);
    }
    expect(
      rewritten,
      'the second seed pass rewrote rows without changing any row count. The content digest ' +
        'excludes only the columns that default to a wall clock, so what moved is a value some ' +
        `module wrote again: ${rewritten.join(', ')}`,
    ).toEqual([]);

    // Zero deltas would also be produced by a second pass that did nothing at all, so the log is
    // the other half of the claim: each capture-backed leg was reached, looked, and declined. With
    // all nine modules running there are 20 such legs (2 in rates, 11 in bars, 4 in fundamentals,
    // 5 in news, less the ones a module folds into one line); 18 is the floor that still proves the
    // gates of modules 3 and 5 fired, which the five-module version of this test could not see.
    const skips = secondRunLog.filter((line) => line.includes('already in provenance'));
    expect(skips.length, `second-pass log:\n  ${secondRunLog.join('\n  ')}`).toBeGreaterThanOrEqual(
      18,
    );
  });

  it('writes the volumes DATA_MODEL §18 states exactly', async () => {
    await runSeedModules();

    // **Every count is scoped to the seed's own rows, never to the whole table.** `bloomberg_test` is
    // shared: `src/test/db.ts#withCleanDb` lets writes commit, and several function suites create
    // their own firms, users and rooms (`MSG.test.ts` makes a `Demo Capital <uuid>` per run). An
    // absolute `SELECT count(*) FROM firms` is therefore a count of everything that happened to have
    // run first — measured on the real harness, it was 4 rather than 2 — and asserting it would make
    // this file fail for a reason that has nothing to do with the seed. Scoping by the fixture's own
    // keys asks the question the acceptance row actually asks.
    //
    // Only the exact figures are here. `filings` 1,275 and `xbrl_frames` 6,264 are the sizes of the
    // recorded captures, not approximations; the "≈" rows of §18 belong to volumes.test.ts, which
    // owns the tolerances. Asserting them also guards the test above against the degenerate pass,
    // where "the second pass wrote nothing" is true because the first wrote nothing either.
    const one = async (label: string, sql: string, values: unknown[] = []): Promise<number> => {
      const res = await t.client.query<{ n: string }>(sql, values);
      const n = Number(res.rows[0]?.n ?? -1);
      expect(n, `${label}: ${sql.replace(/\s+/g, ' ').trim()}`).toBeGreaterThanOrEqual(0);
      return n;
    };

    const emails = [
      'pm@demo.terminal',
      'analyst@demo.terminal',
      'rates@demo.terminal',
      'compliance@demo.terminal',
      'dataops@demo.terminal',
      'eod@demo.terminal',
      'reporter@newsco.terminal',
    ];
    const firmNames = ['Demo Capital', 'Other Desk'];

    // Module 10 — the two recorded filers, the one recorded frame, the one mapping version.
    expect(
      await one(
        'filings for the two seeded CIKs',
        `SELECT count(*) AS n FROM filings WHERE cik IN ('0000320193', '0000884394')`,
      ),
    ).toBe(1275);
    expect(
      await one(
        'xbrl_frames for Assets CY2024Q4I',
        `SELECT count(*) AS n FROM xbrl_frames
          WHERE taxonomy = 'us-gaap' AND concept = 'Assets' AND unit = 'USD' AND frame = 'CY2024Q4I'`,
      ),
    ).toBe(6264);
    expect(
      await one(
        'xbrl_concept_map for std-map/2026.09',
        `SELECT count(*) AS n FROM xbrl_concept_map WHERE mapping_version = 'std-map/2026.09'`,
      ),
    ).toBe(40);
    expect(
      await one(
        'short_interest for the one recorded settlement date',
        `SELECT count(*) AS n FROM short_interest WHERE settlement_date = '2020-04-15'`,
      ),
    ).toBe(1);

    // Module 11 — the thirteen v1 topic codes, the three recorded news sources, the 2026 FOMC year.
    expect(
      await one(
        'topics for the thirteen v1 codes',
        `SELECT count(*) AS n FROM topics
          WHERE code = ANY($1::text[])`,
        [
          [
            'MARKETS',
            'ECO',
            'POLITICS',
            'TECH',
            'WEALTH',
            'INDUSTRIES',
            'FED',
            'FILINGS',
            'EARNINGS',
            'CA',
            'RATES',
            'FX',
            'AI',
          ],
        ],
      ),
    ).toBe(13);
    expect(
      await one(
        'news_items from the three recorded feeds',
        `SELECT count(*) AS n FROM news_items WHERE source_id IN ('bbg.rss', 'sec.atom', 'fed.rss')`,
      ),
    ).toBe(160);
    expect(
      await one(
        'fomc_meetings in 2026',
        `SELECT count(*) AS n FROM fomc_meetings WHERE meeting_date >= '2026-01-01' AND meeting_date < '2027-01-01'`,
      ),
    ).toBe(8);

    // Module 12 — the seeded desk, by name and by email.
    expect(
      await one('seeded firms', `SELECT count(*) AS n FROM firms WHERE name = ANY($1::text[])`, [
        firmNames,
      ]),
    ).toBe(2);
    expect(
      await one(
        'seeded users',
        `SELECT count(*) AS n FROM users WHERE lower(email) = ANY($1::text[])`,
        [emails],
      ),
    ).toBe(7);
    expect(
      await one(
        'one live password per seeded user',
        `SELECT count(*) AS n FROM user_credentials c JOIN users u USING (user_id)
          WHERE lower(u.email) = ANY($1::text[]) AND c.kind = 'password' AND c.revoked_at IS NULL`,
        [emails],
      ),
    ).toBe(7);
    expect(
      await one(
        'grants held by the seeded firms and users',
        `SELECT count(*) AS n FROM entitlement_grants g
          WHERE (g.subject_kind = 'firm' AND g.subject_id IN (SELECT firm_id FROM firms WHERE name = ANY($1::text[])))
             OR (g.subject_kind = 'user' AND g.subject_id IN (SELECT user_id FROM users WHERE lower(email) = ANY($2::text[])))`,
        [firmNames, emails],
      ),
    ).toBe(8);
    expect(
      await one(
        'quota_limits for the seeded subjects',
        `SELECT count(*) AS n FROM quota_limits q
          WHERE (q.subject_kind = 'firm' AND q.subject_id IN (SELECT firm_id FROM firms WHERE name = ANY($1::text[])))
             OR (q.subject_kind = 'user' AND q.subject_id IN (SELECT user_id FROM users WHERE lower(email) = ANY($2::text[])))`,
        [firmNames, emails],
      ),
    ).toBe(2);
    expect(
      await one(
        'the global surveillance lexicon',
        `SELECT count(*) AS n FROM surveillance_lexicon WHERE firm_id IS NULL AND active`,
      ),
    ).toBe(12);
    expect(
      await one(
        'rooms created by the seeded PM',
        `SELECT count(*) AS n FROM rooms WHERE created_by = (SELECT user_id FROM users WHERE lower(email) = 'pm@demo.terminal')`,
      ),
    ).toBe(2);
    expect(
      await one(
        'members of those rooms',
        `SELECT count(*) AS n FROM room_members m
          WHERE m.room_id IN (SELECT room_id FROM rooms
                               WHERE created_by = (SELECT user_id FROM users WHERE lower(email) = 'pm@demo.terminal'))`,
      ),
    ).toBe(6);
    expect(
      await one(
        'messages in those rooms',
        `SELECT count(*) AS n FROM messages m
          WHERE m.room_id IN (SELECT room_id FROM rooms
                               WHERE created_by = (SELECT user_id FROM users WHERE lower(email) = 'pm@demo.terminal'))`,
      ),
    ).toBe(6);

    // Module 13 — one default workspace per seeded user (§18: 7 workspaces).
    expect(
      await one(
        "the seeded users' default workspaces",
        `SELECT count(*) AS n FROM workspaces
          WHERE name = 'default' AND user_id IN (SELECT user_id FROM users WHERE lower(email) = ANY($1::text[]))`,
        [emails],
      ),
    ).toBe(7);
  });

  it('leaves no table WP-15 owns empty', async () => {
    await runSeedModules();
    const counts = await rowCounts([
      'filings',
      'xbrl_facts',
      'xbrl_frames',
      'xbrl_concept_map',
      'news_items',
      'news_entity_links',
      'topics',
      'econ_series',
      'econ_observations',
      'econ_releases',
      'econ_release_events',
      'fomc_meetings',
      'people',
      'firms',
      'users',
      'entitlement_grants',
      'surveillance_lexicon',
      'rooms',
      'messages',
      'workspaces',
      'watchlists',
      'portfolios',
      'positions',
    ]);
    const empty = [...counts].filter(([, n]) => n === 0).map(([table]) => table);
    expect(empty, 'a table WP-15 modules 10-13 own is empty after a seed').toEqual([]);
  });
});

describe('DATA-10: every seeded value resolves to a fixture', () => {
  it('follows every provenance reference in the schema to a fixture file on disk', async () => {
    await runSeedModules();

    const columns = await provenanceColumns();
    const { rows: referenced, nulls } = await referencedProvenance(columns);

    // The walk is only as good as the set of columns it found: if the catalogue query ever comes
    // back short, everything below is checking less than it claims to.
    const names = new Set(columns.map((c) => c.table));
    for (const table of WP15_VALUE_TABLES) {
      expect(names, `${table} should carry a provenance reference`).toContain(table);
    }
    expect(columns.length).toBeGreaterThanOrEqual(30);
    expect(referenced.size).toBeGreaterThan(0);

    const manifest = manifestByKey();
    const unresolved: string[] = [];
    const curated: string[] = [];
    let recorded = 0;

    for (const row of referenced.values()) {
      expect(row.digest, `provenance ${String(row.provenanceId)} has no response digest`).toMatch(
        /^[0-9a-f]{64}$/,
      );

      const entry = manifest.get(row.requestKey);
      if (entry === undefined) {
        const bucket = classifyNonRecorded(row);
        if (bucket !== 'unknown') {
          curated.push(
            `${bucket}: ${row.sourceId} ${row.requestUrl} (${[...row.tables].sort().join(', ')})`,
          );
          continue;
        }
        unresolved.push(
          `provenance ${String(row.provenanceId)} (${row.sourceId} ${row.requestUrl}) has ` +
            `request_key ${row.requestKey}, which the replay manifest does not hold, and is ` +
            'neither a curated fixture nor a derived artefact — referenced by ' +
            `${[...row.tables].sort().join(', ')}`,
        );
        continue;
      }

      const capture = entry.captures.find((c) => c.sha256 === row.digest);
      if (capture === undefined) {
        unresolved.push(
          `provenance ${String(row.provenanceId)} (${row.sourceId} ${row.requestUrl}) carries ` +
            `response_sha256 ${row.digest}, which is not the digest of any capture recorded under ` +
            `its request key — referenced by ${[...row.tables].sort().join(', ')}`,
        );
        continue;
      }
      if (!fixtureFileExists(capture.file)) {
        unresolved.push(
          `provenance ${String(row.provenanceId)} resolves to ${capture.file}, which is not on ` +
            'disk — the manifest names a fixture the repository does not contain',
        );
        continue;
      }
      recorded += 1;
    }

    expect(unresolved, `unresolved provenance:\n  ${unresolved.join('\n  ')}`).toEqual([]);
    expect(recorded, 'no provenance row resolved to a recorded capture at all').toBeGreaterThan(0);
    // Curated and derived rows are legitimate but listed rather than waved through: the classifier
    // above has already required a curated `file:` URL to name a fixture that exists and a derived
    // row to be referenced only by a derived table, so what is left here is the visible inventory.
    expect(curated.every((line) => /^(curated|derived): internal\./.test(line))).toBe(true);

    // A NULL provenance is allowed only where it is documented; anything else is a seeded value
    // with no source, which is a defect however plausible the value is.
    const undocumented = [...nulls]
      .filter(([table]) => !NULL_PROVENANCE_ALLOWED.has(table))
      .map(([table, n]) => `${table}: ${String(n)} row(s) with no provenance`);
    expect(undocumented, `undocumented NULL provenance:\n  ${undocumented.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('records no absolute filesystem path in provenance.request_url', async () => {
    await runSeedModules();

    // `provenance.request_url` is a user-visible value — it is what the Ctrl+I provenance popover
    // shows — and it is part of the bytes of a seeded database. An absolute path puts the seeding
    // machine's directory layout on the screen and makes two checkouts at different paths produce
    // different `provenance` content for identical fixtures, which is the one thing that stops the
    // determinism property WP-15 claims from being assertable at all.
    //
    // A recorded capture's URL is the provider's `https://…`; a curated fixture's is
    // `seed://<file>`; a derived artefact's is `derived://…`. None of those can start with `/` or
    // `file:` or contain a home directory, so the check is a pattern rather than a list of the
    // modules that get it right today.
    const res = await t.client.query<{
      provenance_id: string;
      source_id: string;
      request_url: string;
    }>(`
      SELECT provenance_id::text, source_id, request_url
        FROM provenance
       WHERE request_url LIKE '/%'
          OR request_url LIKE 'file:%'
          OR request_url LIKE '%/Users/%'
          OR request_url LIKE '%/home/%'
          OR request_url LIKE '%:\\%'
       ORDER BY provenance_id`);
    expect(
      res.rows.map((r) => `${r.provenance_id} ${r.source_id} ${r.request_url}`),
      'a provenance row names an absolute filesystem path. Use the repository-relative ' +
        '`seed://<file>` convention (seed/rates.ts#seedFileProvenance, ' +
        'seed/universe.ts#curatedProvenance): `response_sha256` is what pins the content, so ' +
        'nothing is lost by dropping the path.',
    ).toEqual([]);
  });

  it('gives every value modules 10-13 write a recorded capture, never a curated one', async () => {
    await runSeedModules();

    const columns = await provenanceColumns();
    const { rows: referenced } = await referencedProvenance(columns);
    const manifest = manifestByKey();
    const offenders: string[] = [];

    for (const table of WP15_VALUE_TABLES) {
      if (!columns.some((c) => c.table === table)) continue;
      for (const row of referenced.values()) {
        if (!row.tables.has(table)) continue;
        if (manifest.has(row.requestKey)) continue;
        offenders.push(`${table} → provenance ${String(row.provenanceId)} (${row.requestUrl})`);
      }
    }
    expect(
      offenders,
      'a table written by WP-15 modules 10-13 points at provenance that is not a recorded ' +
        `capture:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);

    // The complement: the curated fixtures those modules read land in tables that carry no
    // provenance column at all, so there is nothing for the walk above to resolve. Asserting the
    // count means a migration that *added* such a column would fail this file rather than quietly
    // start accepting NULLs.
    const withoutProvenance = await t.client.query<{ relname: string }>(`
      SELECT c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relispartition
         AND c.relname IN ('xbrl_concept_map', 'issuer_aliases', 'topics', 'firms', 'users',
                           'entitlement_grants', 'quota_limits', 'surveillance_lexicon', 'rooms',
                           'room_members', 'messages', 'workspaces', 'watchlists',
                           'watchlist_items', 'portfolios', 'positions', 'lots')
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.columns ic
            WHERE ic.table_schema = 'public' AND ic.table_name = c.relname
              AND ic.column_name IN ('provenance_id', 'provenance_ids'))
       ORDER BY c.relname`);
    expect(withoutProvenance.rows.map((r) => r.relname)).toHaveLength(17);
  });
});
