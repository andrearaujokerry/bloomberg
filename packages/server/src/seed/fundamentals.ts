// packages/server/src/seed/fundamentals.ts
//
// Seed module 10 of DATA_MODEL §18 (L2569): the fundamentals half of the offline database.
//
//   fixture                          → table
//   fixtures/seed/concept-map.json   → xbrl_concept_map (40 rows, PROVIDERS §7.3.1)
//   sec-submissions-AAPL.json (1,000 filings) ┐
//   sec-spy-submissions.json  (275 filings)   ┴→ filings 1,275, issuer_aliases (SEC formerNames)
//   sec-companyfacts-AAPL.json                 → xbrl_facts ≈ 40k, fin_statements (AAPL Q/FY/TTM)
//   sec-frames-assets.json                     → xbrl_frames 6,264 (Assets CY2024Q4I)
//   finra-trace                                → short_interest 1
//
// **This module writes almost nothing itself.** Four of the six legs are the WP-10/WP-11 ingest
// jobs, called with the arguments the recorded captures were taken with, because those jobs already
// hold the whole contract a hand-rolled seed would have to restate: `insertProvenance` before
// `normalise` (DATA-10), the WORM insert of `xbrl_facts` keyed on SEC's `filed` (STOR-06), the
// point-in-time grouping of `fin_statements` one row per (period, filing), the `dq_events` a short
// payload earns and the `data_exceptions` an unresolved symbol earns. A second implementation of
// any of that would be a second set of bugs, and the version the seed wrote would be the one nobody
// tested. The seed's own job is the two things the jobs cannot know: which captures exist, and that
// the run must be free the second time.
//
// **Idempotence is a capture gate, not a row-by-row hope** (DATA_MODEL §18: "running twice must
// write ZERO rows the second time"). The underlying upserts are all `ON CONFLICT DO NOTHING` on a
// natural key, so re-parsing a capture writes no *value* row — but `insertProvenance` has no such
// key and would add one `provenance` row per capture per run, and `withIngestRun` one `ingest_runs`
// row per leg. So each leg is skipped outright when {@link sourceFullyIngested} finds that every
// capture the manifest holds for its source is already recorded in `provenance` by response digest.
// That is not merely an optimisation: in `PROVIDER_MODE=replay` a re-fetch is a file read, and a
// `provenance` row claiming a provider exchange that did not happen is a false audit record — the
// one kind of row DATA-10 must not contain.
//
// The caller owns the transaction (`seed/index.ts` opens one per module), so a failure anywhere
// leaves module 10 completely absent rather than half applied — which is also what makes the
// capture gate sound, since a leg is either wholly recorded or wholly not.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runSecCompanyFacts } from '../ingest/jobs/secCompanyFacts.js';
import { runSecFrames } from '../ingest/jobs/secFrames.js';
import { runSecSubmissions } from '../ingest/jobs/secSubmissions.js';
import { runShortInterest } from '../ingest/jobs/shortInterest.js';
import { canonicalUrl, openReplayStore, ReplayMissError } from '../providers/replayStore.js';
import { secSubmissionsAdapter } from '../providers/sec/adapter.js';
import { XBRL_CONCEPT_MAP } from '../providers/sec/parse.js';

import type { Tx } from '../db/client.js';
import type { SeedContext } from './index.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared plumbing for WP-15's ingest-backed modules (10 and 11)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The directory `fixtures/seed/*.json` live in, derived from the replay store's own root rather
 * than from `import.meta.url`.
 *
 * `config.REPLAY_DIR` is what a deployment moves when the fixtures move, and the two trees are
 * siblings (`fixtures/providers`, `fixtures/seed`). Resolving the curated fixtures relative to the
 * recorded ones means one setting moves both, and a seed pointed at a fixture set cannot read the
 * curated half of a different one.
 */
export function seedFixtureDir(): string {
  return join(dirname(openReplayStore().dir), 'seed');
}

/** Read and parse one `fixtures/seed/*.json`. A malformed or missing file fails the seed. */
export function readSeedFixture<T>(name: string): T {
  const path = join(seedFixtureDir(), name);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `seed fixture ${name} is missing at ${path} — WP-15 owns fixtures/seed/* and a module may ` +
        `not fall back to invented data (DATA_MODEL §18): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(
      `seed fixture ${name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * A `Tx` over the seed's connection.
 *
 * The ingest jobs take `{ tx: Tx, clock }` and `SeedContext` carries `db: Db` — the same
 * checked-out client, already inside the runner's `BEGIN`. `Db` and `Tx` differ only by
 * `rollback()`, which no job calls, and the jobs use nothing but `execute`/`insert`/`update` on it.
 * Calling `db.transaction()` to obtain a real `Tx` would be wrong rather than pedantic: drizzle
 * implements it as `BEGIN … COMMIT`, and the `COMMIT` would end the *runner's* transaction half way
 * through the module and destroy the all-or-nothing property §18 requires. `src/test/db.ts` and
 * `ingest/scheduler.ts` take the same narrowing for the same reason.
 */
export function seedTx(ctx: SeedContext): Tx {
  return ctx.db as unknown as Tx;
}

/**
 * True when every capture the replay manifest holds for **all** of `sourceIds` is already recorded
 * in `provenance`, matched on `response_sha256`.
 *
 * The digest is the right key and the request key is not: two captures of one request key are two
 * observations, and a leg is only "already ingested" when the bytes we would parse now are bytes we
 * have parsed before. Matching on `request_key` alone would skip a leg whose fixture had been
 * re-recorded; matching on the digest re-runs it, which is what a changed capture must do.
 *
 * A source the manifest holds no capture for answers `false`: there is nothing recorded, so there
 * is nothing to skip, and the leg will discover the miss itself (FEED-08 — a miss is a wall, never
 * a network call).
 */
export async function sourceFullyIngested(
  ctx: SeedContext,
  ...sourceIds: readonly string[]
): Promise<boolean> {
  const manifest = openReplayStore().manifest;
  const digests: string[] = [];
  for (const sourceId of sourceIds) {
    let seen = 0;
    for (const entry of Object.values(manifest)) {
      if (entry.providerId !== sourceId) continue;
      for (const capture of entry.captures) {
        digests.push(capture.sha256);
        seen += 1;
      }
    }
    if (seen === 0) return false;
  }

  const found = await ctx.query(
    `SELECT count(DISTINCT encode(response_sha256, 'hex')) AS n
       FROM provenance
      WHERE encode(response_sha256, 'hex') = ANY($1::text[])`,
    [digests],
  );
  const n = Number((found.rows[0] as { n: string | number } | undefined)?.n ?? 0);
  return n === new Set(digests).size;
}

/**
 * The same gate as {@link sourceFullyIngested}, narrowed to the exact captures a leg consumes.
 *
 * Needed because a source's recorded captures are not always all reachable by one job.
 * `fixtures/providers/raw` holds two `fred.calendar` pages — `/releases/calendar` and `/releases` —
 * and `ingest/jobs/econCalendar.ts` reads only the first. A source-level gate on `fred.calendar`
 * can therefore never be satisfied, so the leg would re-fetch on every run and write a `provenance`
 * row each time for an exchange that did not happen: exactly the failure mode the gate exists to
 * prevent, arrived at from the other side. Measured: two runs of the seed left
 * `fred.calendar` and `bls.schedule` with two provenance rows each before this helper existed.
 */
/**
 * The manifest entry for one capture, matched on the CANONICAL url.
 *
 * Both sides are canonicalised because a caller builds its url from the same adapter helper the job
 * uses, and those return the query in the order the API wants rather than sorted: `chartUrl(…)`
 * answers `?interval=1d&range=5y&events=div|split` where the manifest records
 * `?events=div%7Csplit&interval=1d&range=5y`. Comparing the two raw strings silently fails to find
 * a capture that is right there, and a gate that cannot find its capture never fires — which is how
 * the two `events=div|split` legs of `seed/bars.ts` kept re-recording themselves after the other
 * nine had stopped.
 */
function findCapture(
  manifest: ReturnType<typeof openReplayStore>['manifest'],
  spec: CaptureRef,
): { captures: readonly { sha256: string }[] } | undefined {
  const wanted = canonicalUrl(spec.url);
  return Object.values(manifest).find(
    (candidate) => candidate.providerId === spec.sourceId && canonicalUrl(candidate.url) === wanted,
  );
}

export async function capturesIngested(
  ctx: SeedContext,
  ...specs: readonly { sourceId: string; url: string }[]
): Promise<boolean> {
  const manifest = openReplayStore().manifest;
  const digests: string[] = [];
  for (const spec of specs) {
    const entry = findCapture(manifest, spec);
    if (entry === undefined) return false;
    for (const capture of entry.captures) digests.push(capture.sha256);
  }
  if (digests.length === 0) return false;

  const found = await ctx.query(
    `SELECT count(DISTINCT encode(response_sha256, 'hex')) AS n
       FROM provenance
      WHERE encode(response_sha256, 'hex') = ANY($1::text[])`,
    [digests],
  );
  const n = Number((found.rows[0] as { n: string | number } | undefined)?.n ?? 0);
  return n === new Set(digests).size;
}

/** One recorded capture, named the way {@link capturesIngested} matches the manifest. */
export interface CaptureRef {
  readonly sourceId: string;
  readonly url: string;
}

/**
 * One leg's captures and the table its own rows land in.
 *
 * The table is what makes the gate decidable, and it took a wrong gate to find that out — see
 * {@link recordedLegs}.
 */
export interface LegOutput {
  /** A table with a `provenance_id` column that only this leg's rows reach. */
  readonly table: string;
  readonly captures: readonly CaptureRef[];
}

/**
 * Which of a module's replay-backed legs have **already run**, decided in one pass before the module
 * writes anything.
 *
 * Why the gate exists: in `PROVIDER_MODE=replay` nothing is fetched, so a `provenance` row written
 * by a second `db:seed` asserts a provider exchange that never happened — the one kind of row
 * DATA-10 must not contain — and each such row moves the ids that `quote_snapshots.state` embeds.
 * Measured before this gate: two consecutive runs of the committed script took `provenance` from 56
 * rows to 76 and `ingest_runs` from 17 to 26, and rewrote all four warm-start snapshots to cite the
 * newer ids. WORKPLAN L1552 asks for the opposite ("`db:seed` twice writes zero rows the second
 * time").
 *
 * Two things about the shape, both learned by getting them wrong first.
 *
 * **1. The gate is on the leg's OUTPUT, not on the capture alone.** {@link capturesIngested} answers
 * "are these bytes recorded in `provenance`", which is the right question for modules 10 and 11
 * because nothing else in the seed reads an SEC or an RSS capture. It is the wrong question here:
 * `seed/universe.ts` (module 2) cites `yahoo-ftse`, `yahoo-fx`, `yahoo-chart-SPX-5d-5m` and
 * `cboe-eu-indices` when it mints the md lines and index instruments of §18 row 5, so those four
 * digests are already in `provenance` before module 8-9 starts. A capture-only gate skipped four
 * legs on a COLD database and left `bars_intraday` with 317 rows instead of 1,033 — a silent
 * three-quarters-empty history, which is worse than the duplicate rows it was fixing. So a leg
 * counts as run only when every one of its captures is cited by a row of the table the leg itself
 * writes: module 2's citation lives in `md_lines`, the intraday leg's in `bars_intraday`, and the
 * two cannot be confused.
 *
 * **2. The decision is taken from the state the module INHERITED**, in one pass at the top, not at
 * each leg as it is reached. `seed/bars.ts` cites the `frankfurter` and `cboe.options` captures
 * (`citeCapture`) to hang md lines on *before* the jobs that read them run, and `seed/rates.ts`
 * reads `nyfed-all` itself before `runFedRates` reads it again; a gate evaluated in place would find
 * the row the module had just written and skip its own job. The module's transaction is the only
 * writer, so a snapshot taken at the top cannot go stale under it.
 *
 * The cost is one indexed-or-seq count per leg over a table the seed keeps in the thousands of rows;
 * a production-sized `quote_ticks` would want the digests narrowed by `captured_at` first.
 */
export async function recordedLegs<K extends string>(
  ctx: SeedContext,
  legs: Readonly<Record<K, readonly LegOutput[]>>,
): Promise<ReadonlySet<K>> {
  const recorded = new Set<K>();
  for (const [name, outputs] of Object.entries(legs) as [K, readonly LegOutput[]][]) {
    let done = outputs.length > 0;
    for (const output of outputs) {
      if (!(await legOutputCitesAll(ctx, output))) {
        done = false;
        break;
      }
    }
    if (done) recorded.add(name);
  }
  return recorded;
}

/** True when every capture of `output` is cited by at least one row of `output.table`. */
async function legOutputCitesAll(ctx: SeedContext, output: LegOutput): Promise<boolean> {
  const manifest = openReplayStore().manifest;
  const digests = new Set<string>();
  for (const capture of output.captures) {
    const entry = findCapture(manifest, capture);
    // No recorded capture means nothing to skip — the leg runs and discovers the miss itself
    // (FEED-08: a miss is a wall, never a network call).
    if (entry === undefined) return false;
    for (const recorded of entry.captures) digests.add(recorded.sha256);
  }
  if (digests.size === 0) return false;

  // The table name is a literal from the module's own leg table, never user input; it cannot be a
  // bound parameter because it is an identifier.
  const found = await ctx.query(
    `SELECT count(DISTINCT encode(p.response_sha256, 'hex')) AS n
       FROM ${output.table} v
       JOIN provenance p ON p.provenance_id = v.provenance_id
      WHERE encode(p.response_sha256, 'hex') = ANY($1::text[])`,
    [[...digests]],
  );
  const n = Number((found.rows[0] as { n: string | number } | undefined)?.n ?? 0);
  return n === digests.size;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The CIKs and the frame this module's captures were taken for
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Apple Inc. — the one issuer whose companyfacts and submissions are both recorded. */
export const AAPL_CIK = '0000320193';
/** SPDR S&P 500 ETF Trust — submissions only (275 filings); §18's second filer. */
export const SPY_CIK = '0000884394';

/**
 * The one recorded frame: `https://data.sec.gov/api/xbrl/frames/us-gaap/Assets/USD/CY2024Q4I.json`,
 * 6,264 CIKs. `runSecFrames` defaults to twenty concepts × eight quarters, of which 159 would be
 * replay misses — counted, harmless, and 159 lines of noise in the seed log. Naming the target
 * keeps the run honest about what exists on disk.
 */
export const SEEDED_FRAME = {
  taxonomy: 'us-gaap',
  concept: 'Assets',
  unit: 'USD',
  frame: 'CY2024Q4I',
} as const;

/** The FINRA page the consolidated short-interest file was recorded from (one page, one row). */
const FINRA_RECORDED_URL =
  'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest?limit=1000&offset=0';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// xbrl_concept_map — the standardisation table
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One row of `fixtures/seed/concept-map.json`. */
interface ConceptMapRow {
  standardItem: string;
  taxonomy: string;
  concept: string;
  priority: number;
  sign: number;
  statement: 'IS' | 'BS' | 'CF';
}

interface ConceptMapFixture {
  mappingVersion: string;
  rows: ConceptMapRow[];
}

/**
 * Write `xbrl_concept_map` from the fixture, after proving it says the same thing as the map the
 * statement builder actually uses.
 *
 * `ingest/jobs/secCompanyFacts.ts` builds `fin_statements` from `XBRL_CONCEPT_MAP` in
 * `providers/sec/parse.ts`, not from this table; the table is what a reader, an export footer and a
 * future re-standardisation consult to find out *how* a statement was built. Two copies of a
 * mapping is the classic way for a system to document a behaviour it does not have, so the fixture
 * is compared row for row — item, taxonomy, concept, priority, sign and statement — and a
 * disagreement fails the seed rather than being written. `mapping_version` must match too: a table
 * claiming `std-map/2026.09` while the builder stamps something else would make
 * `fin_statements.mapping_version` unjoinable.
 *
 * The table carries no `provenance_id` column (0008), and correctly so: no provider publishes this
 * mapping, so there is no capture to point at and the fixture itself is the source of record.
 */
async function seedConceptMap(ctx: SeedContext): Promise<{ inserted: number; updated: number }> {
  const fixture = readSeedFixture<ConceptMapFixture>('concept-map.json');

  const expected = new Map<string, ConceptMapRow>();
  for (const item of XBRL_CONCEPT_MAP) {
    for (const concept of item.concepts) {
      expected.set(`us-gaap|${item.standardItem}|${concept.concept}`, {
        standardItem: item.standardItem,
        taxonomy: 'us-gaap',
        concept: concept.concept,
        priority: concept.priority,
        sign: concept.sign,
        statement: item.statement,
      });
    }
  }

  if (fixture.rows.length !== expected.size) {
    throw new Error(
      `fixtures/seed/concept-map.json holds ${String(fixture.rows.length)} rows but ` +
        `XBRL_CONCEPT_MAP produces ${String(expected.size)} — the seeded standardisation table ` +
        'must describe exactly the standardisation ingest/jobs/secCompanyFacts.ts performs ' +
        '(PROVIDERS §7.3.1)',
    );
  }
  for (const row of fixture.rows) {
    const key = `${row.taxonomy}|${row.standardItem}|${row.concept}`;
    const want = expected.get(key);
    if (want === undefined) {
      throw new Error(
        `fixtures/seed/concept-map.json maps ${key} but XBRL_CONCEPT_MAP does not — the builder ` +
          'would never reach this concept, so seeding it would document a fallback that does not exist',
      );
    }
    if (
      row.priority !== want.priority ||
      row.sign !== want.sign ||
      row.statement !== want.statement
    ) {
      throw new Error(
        `fixtures/seed/concept-map.json disagrees with XBRL_CONCEPT_MAP on ${key}: fixture says ` +
          `priority=${String(row.priority)} sign=${String(row.sign)} statement=${row.statement}, ` +
          `code says priority=${String(want.priority)} sign=${String(want.sign)} statement=${want.statement}`,
      );
    }
  }

  // `xbrl_concept_map` is a plain PK table, so this is an ordinary upsert. `DO UPDATE … WHERE` is
  // what keeps the second run free: Postgres counts a row as affected even when the UPDATE sets a
  // column to the value it already had, so the predicate is what turns "40 updated" into "0".
  const result = await ctx.query(
    `INSERT INTO xbrl_concept_map (mapping_version, standard_item, taxonomy, concept, priority, sign, statement)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::smallint[], $6::smallint[], $7::char(2)[])
     ON CONFLICT (mapping_version, standard_item, taxonomy, concept) DO UPDATE
        SET priority = EXCLUDED.priority, sign = EXCLUDED.sign, statement = EXCLUDED.statement
      WHERE xbrl_concept_map.priority  IS DISTINCT FROM EXCLUDED.priority
         OR xbrl_concept_map.sign      IS DISTINCT FROM EXCLUDED.sign
         OR xbrl_concept_map.statement IS DISTINCT FROM EXCLUDED.statement
     RETURNING (xmax = 0) AS was_insert`,
    [
      fixture.rows.map(() => fixture.mappingVersion),
      fixture.rows.map((r) => r.standardItem),
      fixture.rows.map((r) => r.taxonomy),
      fixture.rows.map((r) => r.concept),
      fixture.rows.map((r) => r.priority),
      fixture.rows.map((r) => r.sign),
      fixture.rows.map((r) => r.statement),
    ],
  );

  const rows = result.rows as { was_insert: boolean }[];
  return {
    inserted: rows.filter((r) => r.was_insert).length,
    updated: rows.filter((r) => !r.was_insert).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// issuer_aliases — SEC formerNames
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Write `issuer_aliases` from the `formerNames` block of each recorded submissions capture.
 *
 * NEWS-02's matcher reads this table through `refdata/newsDict.ts`, and it is the reason a story
 * that says *"Apple Computer"* reaches the same issuer as one that says *"Apple Inc."*. The aliases
 * are read out of the capture rather than curated, because SEC publishes them and a curated list
 * would go stale silently.
 *
 * The capture is read a second time here, through the replay store, and that costs nothing and
 * writes nothing: `issuer_aliases` carries **no** `provenance_id` column (0005), so this leg needs
 * no `provenance` row and cannot create a false one. The alias is a name, not a value — DATA-10
 * constrains values.
 *
 * An unresolved CIK is skipped rather than failing: `issuers` is `seed/universe.ts`'s table
 * (module 3), and a partial world is a normal state for a module that runs after it.
 */
async function seedIssuerAliases(
  ctx: SeedContext,
  ciks: readonly string[],
): Promise<{ inserted: number; unresolved: number }> {
  const store = openReplayStore();
  let inserted = 0;
  let unresolved = 0;

  for (const cik of ciks) {
    const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
    let raw;
    try {
      raw = store.replay({ providerId: 'sec.submissions', url });
    } catch (err) {
      if (!(err instanceof ReplayMissError)) throw err;
      ctx.log(`no submissions capture for CIK ${cik}; no aliases written`);
      continue;
    }

    // The normaliser wants the `provenance_id` of the exchange it is normalising. `issuer_aliases`
    // has no such column, but passing a fabricated id would put a wrong number into
    // `NormaliseContext` and into any row a future version of the normaliser did stamp, so the real
    // one is read back from the row the filings leg wrote for these same bytes.
    const prov = await ctx.query(
      `SELECT provenance_id FROM provenance
        WHERE request_key = $1 AND response_sha256 = decode($2, 'hex')
        ORDER BY provenance_id DESC LIMIT 1`,
      [raw.requestKey, raw.sha256],
    );
    const provenanceId = (prov.rows[0] as { provenance_id: string | number } | undefined)
      ?.provenance_id;
    if (provenanceId === undefined) {
      ctx.log(`no provenance row for the CIK ${cik} submissions capture; no aliases written`);
      continue;
    }

    const parsed = secSubmissionsAdapter.normalise(raw, {
      provenanceId: Number(provenanceId),
      capturedAt: raw.capturedAt,
      lines: new Map(),
    });

    const issuer = await ctx.query(
      `SELECT issuer_id FROM issuers WHERE cik = $1 AND tx_to = 'infinity' AND valid_to = 'infinity' LIMIT 1`,
      [cik],
    );
    const issuerId = (issuer.rows[0] as { issuer_id: string | number } | undefined)?.issuer_id;
    if (issuerId === undefined) {
      unresolved += 1;
      ctx.log(
        `CIK ${cik} has no issuers row yet (seed/universe.ts, module 3); ` +
          `${String(parsed.rows.aliases.length)} former names not linked`,
      );
      continue;
    }

    const aliases = [...new Set(parsed.rows.aliases.map((a) => a.alias))].sort();
    if (aliases.length === 0) continue;
    const written = await ctx.query(
      `INSERT INTO issuer_aliases (issuer_id, alias, kind)
       SELECT $1::bigint, a, 'former_name' FROM unnest($2::text[]) AS a
       ON CONFLICT (issuer_id, alias) DO NOTHING
       RETURNING alias`,
      [issuerId, aliases],
    );
    inserted += written.rows.length;
  }

  return { inserted, unresolved };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The module
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SeedFundamentalsResult {
  conceptMapInserted: number;
  conceptMapUpdated: number;
  filingsInserted: number;
  factsInserted: number;
  statementsInserted: number;
  framesInserted: number;
  aliasesInserted: number;
  shortInterestInserted: number;
  /** Legs skipped because every capture behind them is already in `provenance`. */
  legsAlreadyIngested: number;
}

export async function seedFundamentals(ctx: SeedContext): Promise<SeedFundamentalsResult> {
  const tx = seedTx(ctx);
  const jobCtx = { tx, clock: ctx.clock, log: { info: () => undefined } };

  const result: SeedFundamentalsResult = {
    conceptMapInserted: 0,
    conceptMapUpdated: 0,
    filingsInserted: 0,
    factsInserted: 0,
    statementsInserted: 0,
    framesInserted: 0,
    aliasesInserted: 0,
    shortInterestInserted: 0,
    legsAlreadyIngested: 0,
  };

  // ── 1 · the standardisation table (no captures, pure fixture) ───────────────────────────────
  const conceptMap = await seedConceptMap(ctx);
  result.conceptMapInserted = conceptMap.inserted;
  result.conceptMapUpdated = conceptMap.updated;
  ctx.log(`xbrl_concept_map +${String(conceptMap.inserted)} ~${String(conceptMap.updated)}`);

  // ── 2 · filings (1,275 across two filers) ───────────────────────────────────────────────────
  //
  // `atom: false` because the 8-K atom feed is module 11's leg (§18 lists `sec-8k-atom.xml` under
  // news): the same job serves both, and running the atom half here would write `news_items` before
  // `topics` exist, which would cost every one of those forty stories its `feed_topic` link.
  if (await sourceFullyIngested(ctx, 'sec.submissions')) {
    result.legsAlreadyIngested += 1;
    ctx.log('filings: every sec.submissions capture is already in provenance — nothing to do');
  } else {
    const submissions = await runSecSubmissions({
      ...jobCtx,
      ciks: [AAPL_CIK, SPY_CIK],
      sweep: true,
      atom: false,
    });
    result.filingsInserted = submissions.filingsInserted;
    ctx.log(
      `filings +${String(submissions.filingsInserted)} (${String(submissions.ciks)} filers, ` +
        `${String(submissions.filingsUnchanged)} unchanged)`,
    );
  }

  // ── 3 · issuer_aliases from the same captures ───────────────────────────────────────────────
  const aliases = await seedIssuerAliases(ctx, [AAPL_CIK, SPY_CIK]);
  result.aliasesInserted = aliases.inserted;
  ctx.log(
    `issuer_aliases +${String(aliases.inserted)} (${String(aliases.unresolved)} unresolved CIKs)`,
  );

  // ── 4 · xbrl_facts ≈ 40k and fin_statements (AAPL) ──────────────────────────────────────────
  if (await sourceFullyIngested(ctx, 'sec.companyfacts')) {
    result.legsAlreadyIngested += 1;
    ctx.log('xbrl_facts: the companyfacts capture is already in provenance — nothing to do');
  } else {
    const facts = await runSecCompanyFacts({ ...jobCtx, ciks: [AAPL_CIK] });
    result.factsInserted = facts.factsInserted;
    result.statementsInserted = facts.statementsInserted;
    ctx.log(
      `xbrl_facts +${String(facts.factsInserted)} fin_statements +${String(facts.statementsInserted)}`,
    );
    if (facts.statementsInserted === 0) {
      // `buildStatements` needs an `issuers` row: `fin_statements.issuer_id` is NOT NULL. Saying so
      // is better than a silent zero, because §18 expects ≈ 120 statement rows.
      ctx.log(
        'fin_statements is empty: standardisation needs an issuers row for the CIK, which ' +
          'seed/universe.ts (module 3) writes — re-run the seed once the universe has landed',
      );
    }
  }

  // ── 5 · xbrl_frames 6,264 (the EQS cross-section) ───────────────────────────────────────────
  if (await sourceFullyIngested(ctx, 'sec.frames')) {
    result.legsAlreadyIngested += 1;
    ctx.log('xbrl_frames: the frames capture is already in provenance — nothing to do');
  } else {
    const frames = await runSecFrames({ ...jobCtx, targets: [SEEDED_FRAME] });
    result.framesInserted = frames.rowsInserted;
    ctx.log(`xbrl_frames +${String(frames.rowsInserted)} (${String(frames.frames)} frames parsed)`);
  }

  // ── 6 · short_interest 1 ────────────────────────────────────────────────────────────────────
  //
  // `minRows: 1` lowers PROVIDERS §12's 5,000-row floor, which the one-row recorded page cannot
  // clear; the floor exists to catch a truncated production download, and a fixture is not one.
  // `url` pins the single recorded page so the walk does not ask for a second (`shortInterest.ts`
  // ends the walk on a fixed url by construction).
  if (await sourceFullyIngested(ctx, 'finra.shortInterest')) {
    result.legsAlreadyIngested += 1;
    ctx.log('short_interest: the FINRA capture is already in provenance — nothing to do');
  } else {
    const short = await runShortInterest(
      { tx, clock: ctx.clock, log: { info: () => undefined } },
      { url: FINRA_RECORDED_URL, minRows: 1 },
    );
    result.shortInterestInserted = short.shortInterest.inserted;
    ctx.log(
      `short_interest +${String(short.shortInterest.inserted)} ` +
        `(${String(short.unresolved)} unresolved symbols, status ${short.status})`,
    );
  }

  return result;
}

/** Module 10 of the ordered seed runner (`seed/index.ts`). */
export const fundamentalsSeedModule = {
  order: 10,
  name: 'fundamentals',
  run: seedFundamentals,
} as const;
