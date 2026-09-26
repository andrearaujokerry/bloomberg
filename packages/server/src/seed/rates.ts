// packages/server/src/seed/rates.ts
//
// Seed module 6 of DATA_MODEL §18 (L2564): the Treasury and reference-rate master, the published
// fixings and the rate/CMT econ series. It is the first module that has to *mint* securities rather
// than only distribute a capture over lines that already exist, and it is the one place in the
// system where a curated file is a legitimate source (DATA_MODEL §21.1 question 2).
//
// What it writes, and where each number comes from:
//
//   | rows                                   | source                                            |
//   | -------------------------------------- | ------------------------------------------------- |
//   | bill instruments + `govt_terms`         | `treasury-bills.xml`, through WP-05's             |
//   |                                        | `ingest/jobs/treasuryCurves.ts#mintBillSecurities` |
//   | 7 note/bond instruments + `govt_terms`  | `fixtures/seed/treasuries.json` (curated)          |
//   | 6 rate instruments + `rate_terms`       | `nyfed-all` — the capture names the six types      |
//   | `rate_fixings`, `curve_points(SOFR_FIX,  | `nyfed-all`, `nyfed-sofr`, `nyfed-effr.json`,     |
//   | UST_CMT)`, 11 H.15 `econ_series`        | `fed-h15.csv`, through `jobs/fedRates.ts`          |
//   | 6 rate `econ_series` + `econ_observations`| the `rate_fixings` headline (DATA_MODEL §20)      |
//
// ## Measured, against §18's figures
//
// | rows written                            | §18  | why they differ                             |
// | --------------------------------------- | ---- | ------------------------------------------- |
// | 25 govt instruments + 25 `govt_terms`    | 14   | the capture names **eighteen** bill CUSIPs  |
// |                                         |      | across its nine curve dates, because four   |
// |                                         |      | tenors roll inside the month (the 4-week    |
// |                                         |      | bill three times); §18 counted the seven    |
// |                                         |      | on the run on one day. An off-the-run bill  |
// |                                         |      | still needs a security master row, and      |
// |                                         |      | `mintBillSecurities` writes one.            |
// | 6 rate instruments + 6 `rate_terms`      | 6    | —                                           |
// | 13 `md_lines`                            | —    | six `nyfed.rates` (one per rate code) and   |
// |                                         |      | seven `treasury.bills` (one per term label) |
// | 19 `rate_fixings`                        | ≈30  | EFFR's ten days, SOFR's five and one each   |
// |                                         |      | for OBFR/TGCR/BGCR/SOFRAI is all the three  |
// |                                         |      | recorded NY Fed captures publish            |
// | 17 `econ_series`                         | 17   | 6 rates + 11 H.15 constant maturities       |
// | 73 `econ_observations`                   | ≈100 | 55 H.15 (5 published days × 11, of which 11 |
// |                                         |      | are `ND` on 2026-09-07) + 18 rate headlines |
// |                                         |      | (SOFRAI publishes no `percentRate`)         |
// | 301 `curve_points`                       | ≈300 | 126 par + 126 bill + 44 CMT + 5 SOFR_FIX    |
//
// One documentation error found on the way and **not** reproduced: FUNCTIONS_TIER3 §0 L13 and §18
// row 6 both name `912797VE4 912797UK1 912797VN4 912797VA2 912797WH6 912797WD5 912797WA1` as the
// on-the-run bills of "the `treasury-bills.xml` 2026-09-14 row". That is the 2026-09-01 row; on
// 09-14 the file says `912797VL8 912797UL9 912797VW4 912797VH7 912797WP8 912797UD7 912797WA1`, and
// the seed writes what the capture says.
//
// ## Why this module calls the ingest jobs instead of parsing the captures itself
//
// `treasuryCurves` and `fedRates` already are the offline path: both read through the replay store
// when no `HttpClient` is wired, both mint their own master rows, and both are idempotent by row
// count (`test/integration/ingest/marketDataJobs.test.ts` proves it). A seed that re-parsed
// `treasury-bills.xml` would be a second implementation of the bill roll, the `is_latest` vintage
// rule and the `on_the_run` demotion — three rules whose second copy would be wrong in a way
// nothing would notice until SRCH showed two on-the-run 13-week bills. So the seed's own code here
// is exactly the part no job owns: the curated notes and bonds, the rate instrument master that
// §10.4 explicitly leaves to WP-15 ("`rate_terms` is seeded … this job writes the fixings, not the
// instrument master"), and the headline econ series for the six rates.
//
// ## Determinism (§18: "deterministic and idempotent")
//
// Two wall-clock reads are removed on purpose. The **month** the Treasury feed is asked for is
// {@link SEED_TREASURY_MONTHS}, not the month of `clock.now()`, because the seed replays a recorded
// September 2026 and asking for the current month would be a `ReplayMissError` on the first day of
// October. The **clock** the jobs see is {@link pinnedClock} at the last capture instant the module
// reads, so `ingest_runs` and every as-of read inside `resolveTargets` land inside the recorded
// window and two runs a week apart produce identical rows. `ctx.clock` is still the clock the
// *runner* reports timings with; nothing here reads it for a value.
//
// Idempotency is by natural key everywhere: `upsertVersion` for every bitemporal row (a version
// that already says exactly this writes nothing), `ON CONFLICT (source_id, provider_code)` for
// `econ_series`, and the vintage rules of `upsertRateFixings` / `upsertCurvePoints` /
// `upsertEconObservations` for the value rows. One thing deliberately *does* grow on a second run:
// `provenance` and `ingest_runs`. PROVIDERS.a §1.3 wants one `provenance` row per exchange, and a
// replayed capture read again is an exchange that happened again — "where did this number come
// from" and "how often did we ask" are different questions, and `marketDataJobs.test.ts` asserts
// both halves. The curated file is the exception: {@link seedFileProvenance} re-uses the row it
// already wrote, because that file was never fetched and re-reading it is not an exchange.

import { sha256Hex } from '@terminal/core/hash/sha256';

import { sql } from 'drizzle-orm';

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { insertProvenance } from '../providers/provenance.js';
import { h15Url } from '../providers/fedH15/adapter.js';
import { latestAllUrl, lastNUrl, nyFedRatesAdapter } from '../providers/nyfed/adapter.js';
import { NYFED_ADAPTER_VERSION, RATE_CODES } from '../providers/nyfed/parse.js';
import { openReplayStore, requestHash, resolveReplayDir } from '../providers/replayStore.js';
import { identifierRepository } from '../refdata/identifiers.js';
import { masterRepositories } from '../refdata/master.js';
import { TermsRepository } from '../refdata/terms.js';
import { FED_H15_SOURCE_ID, NYFED_BACKFILL, NYFED_SOURCE_ID, runFedRates } from '../ingest/jobs/fedRates.js';
import {
  ensureEconSeries,
  recordSeriesFacts,
  upsertEconObservations,
} from '../ingest/jobs/fredSeries.js';
import { TREASURY_ISSUER_NAME, runTreasuryCurves } from '../ingest/jobs/treasuryCurves.js';
import {
  BILL_RATES_DATASET,
  YIELD_CURVE_DATASET,
  treasuryBillsAdapter,
  treasuryUrl,
  treasuryYieldCurveAdapter,
} from '../providers/treasury/adapter.js';
import { recordedLegs } from './fundamentals.js';
import { getConfig } from '../config.js';

import type { Clock, IssuerEntityType } from '@terminal/core';
import type { Tx } from '../db/client.js';
import type { RateCode } from '../providers/nyfed/parse.js';
import type { RawRecord } from '../providers/types.js';
import type { TermsData } from '../refdata/terms.js';
import type { SeedContext } from './index.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The months the recorded Treasury captures cover — `fixtures/providers/manifest.json` holds one
 * capture each of `field_tdr_date_value_month=202609` for the yield curve and the bill rates.
 *
 * A literal rather than `currentMonth(ctx)`: the seed is a replay of a recording, and "the month it
 * happens to be today" is a live-mode question. FEED-08/QA-02 make a miss throw, so deriving the
 * month from the wall clock would make `npm run db:seed` fail on 1 October 2026 for no reason.
 */
export const SEED_TREASURY_MONTHS: readonly string[] = Object.freeze(['202609']);

/** The curated file this module reads — `fixtures/seed/treasuries.json` (DATA_MODEL §21.1 q2). */
export const TREASURY_SEED_FILE = 'treasuries.json';

/**
 * `fixtures/seed/`, absolute — the sibling of `REPLAY_DIR` (`src/test/fixtures.ts` documents the
 * layout).
 *
 * Deliberately **not** `src/test/fixtures.ts#seedDir()`: that resolves a relative `REPLAY_DIR`
 * against the server package only, and the committed `.env` ships `./fixtures/providers`, which is
 * relative to the repository root — so under the checked-in environment it names
 * `packages/server/fixtures/seed`, which does not exist. `resolveReplayDir` is the resolver that
 * already knows both bases are in use, and going through it makes the seed work from either
 * working directory.
 */
export function seedFixtureDir(): string {
  return resolve(resolveReplayDir(getConfig().REPLAY_DIR), '..', 'seed');
}

/** One curated seed file: the parsed document and the bytes its provenance row is hashed from. */
export async function readSeedFile(name: string): Promise<{ document: unknown; bytes: Buffer }> {
  const path = join(seedFixtureDir(), name);
  const bytes = await readFile(path);
  try {
    return { document: JSON.parse(bytes.toString('utf8')) as unknown, bytes };
  } catch (err) {
    throw new SyntaxError(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `licence_registry.source_id` a curated `fixtures/seed/*.json` is attributed to (§15). */
export const SEED_FILE_SOURCE_ID = 'internal.user';

/** `provenance.adapter_version` for a curated seed file — the reader, not an HTTP adapter. */
export const SEED_FILE_ADAPTER_VERSION = 'seed/1.0.0';

/**
 * The six NY Fed reference rates as instruments (DATA_MODEL §18 row 6, PROVIDERS §10.4).
 *
 * `tenorDays` is 1 for the five overnight rates; `SOFRAI` is the averages/index release and is not
 * a fixing of a term at all, so it keeps `tenor_days = 1` and `compounding = 'index'` — the column
 * that says "this row's value is an index level, not a rate". `publicationTimeEt` is the
 * publication the schedule of §13 is built around (08:00 ET for the secured rates, 09:00 for the
 * unsecured pair), and it is the *published* time, never a guess at when we fetch.
 */
export interface RateSeedRow {
  readonly rateCode: RateCode;
  /** `instruments.ticker` — `'SOFR Index'` on the command line resolves through this. */
  readonly ticker: string;
  readonly name: string;
  readonly seriesName: string;
  readonly units: string;
  readonly compounding: 'simple' | 'compounded' | 'index';
  readonly publicationTimeEt: string;
  readonly decimals: number;
}

export const RATE_SEED: readonly RateSeedRow[] = Object.freeze([
  {
    rateCode: 'SOFR',
    ticker: 'SOFR',
    name: 'Secured Overnight Financing Rate',
    seriesName: 'Secured Overnight Financing Rate',
    units: 'Percent per year',
    compounding: 'simple',
    publicationTimeEt: '08:00',
    decimals: 2,
  },
  {
    rateCode: 'EFFR',
    ticker: 'EFFR',
    name: 'Effective Federal Funds Rate',
    seriesName: 'Effective Federal Funds Rate',
    units: 'Percent per year',
    compounding: 'simple',
    publicationTimeEt: '09:00',
    decimals: 2,
  },
  {
    rateCode: 'OBFR',
    ticker: 'OBFR',
    name: 'Overnight Bank Funding Rate',
    seriesName: 'Overnight Bank Funding Rate',
    units: 'Percent per year',
    compounding: 'simple',
    publicationTimeEt: '09:00',
    decimals: 2,
  },
  {
    rateCode: 'TGCR',
    ticker: 'TGCR',
    name: 'Tri-Party General Collateral Rate',
    seriesName: 'Tri-Party General Collateral Rate',
    units: 'Percent per year',
    compounding: 'simple',
    publicationTimeEt: '08:00',
    decimals: 2,
  },
  {
    rateCode: 'BGCR',
    ticker: 'BGCR',
    name: 'Broad General Collateral Rate',
    seriesName: 'Broad General Collateral Rate',
    units: 'Percent per year',
    compounding: 'simple',
    publicationTimeEt: '08:00',
    decimals: 2,
  },
  {
    rateCode: 'SOFRAI',
    ticker: 'SOFRAI',
    name: 'SOFR Averages and Index',
    seriesName: 'SOFR 30-, 90- and 180-day averages and the SOFR Index',
    units: 'Percent per year',
    compounding: 'index',
    publicationTimeEt: '08:00',
    decimals: 5,
  },
] satisfies readonly RateSeedRow[]);

/** `md_lines` for `nyfed.rates`: one publication a day, and the fixing is never delayed. */
const RATE_LINE_INTERVAL_MS = 86_400_000;
const RATE_LINE_PRIORITY = 30;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The curated file
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One on-the-run note or bond of `fixtures/seed/treasuries.json`. */
export interface TreasurySeedSecurity {
  termLabel: string;
  securityType: 'note' | 'bond';
  cusip: string;
  ticker: string;
  name: string;
  couponRate: number;
  datedDate: string;
  issueDate: string;
  firstCouponDate: string;
  maturityDate: string;
  amountOutstanding: number;
}

export interface TreasurySeedFile {
  asOf: string;
  securities: TreasurySeedSecurity[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read and check `fixtures/seed/treasuries.json`.
 *
 * Every field is validated rather than trusted: this file is hand-curated, it is the only input to
 * `govt_terms` that no parser has already checked, and a typo in a maturity date would become a
 * priced security on YAS. The CUSIP check digit is *not* verified here — `identifiers.upsert`
 * verifies it through `core/ids/cusip.ts` and raising there names the scheme and the value.
 */
export function parseTreasurySeed(document: unknown): TreasurySeedFile {
  if (document === null || typeof document !== 'object') {
    throw new TypeError('fixtures/seed/treasuries.json: expected a JSON object');
  }
  const doc = document as { asOf?: unknown; securities?: unknown };
  if (typeof doc.asOf !== 'string' || !ISO_DATE.test(doc.asOf)) {
    throw new TypeError('fixtures/seed/treasuries.json: `asOf` must be an ISO date');
  }
  if (!Array.isArray(doc.securities) || doc.securities.length === 0) {
    throw new TypeError('fixtures/seed/treasuries.json: `securities` must be a non-empty array');
  }
  const securities = doc.securities.map((raw, i) => {
    const where = `fixtures/seed/treasuries.json securities[${String(i)}]`;
    if (raw === null || typeof raw !== 'object') throw new TypeError(`${where}: not an object`);
    const s = raw as Record<string, unknown>;
    const text = (key: string): string => {
      const value = s[key];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${where}.${key}: expected a non-empty string`);
      }
      return value;
    };
    const date = (key: string): string => {
      const value = text(key);
      if (!ISO_DATE.test(value)) throw new TypeError(`${where}.${key}: expected an ISO date`);
      return value;
    };
    const number = (key: string): number => {
      const value = s[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new TypeError(`${where}.${key}: expected a positive finite number`);
      }
      return value;
    };
    const securityType = text('securityType');
    if (securityType !== 'note' && securityType !== 'bond') {
      throw new TypeError(`${where}.securityType: expected 'note' or 'bond', got '${securityType}'`);
    }
    const security: TreasurySeedSecurity = {
      termLabel: text('termLabel'),
      securityType,
      cusip: text('cusip'),
      ticker: text('ticker'),
      name: text('name'),
      couponRate: number('couponRate'),
      datedDate: date('datedDate'),
      issueDate: date('issueDate'),
      firstCouponDate: date('firstCouponDate'),
      maturityDate: date('maturityDate'),
      amountOutstanding: number('amountOutstanding'),
    };
    if (security.maturityDate <= security.datedDate) {
      throw new TypeError(`${where}: maturityDate must be after datedDate`);
    }
    if (security.firstCouponDate <= security.datedDate) {
      throw new TypeError(`${where}: firstCouponDate must be after datedDate`);
    }
    return security;
  });
  return { asOf: doc.asOf, securities };
}

/**
 * The `provenance` row for a curated seed file — DATA-10 for a number nobody published.
 *
 * The row is a real one: `response_sha256` is the sha256 of the bytes on disk, `bytes` is their
 * length, `request_url` is the repository-relative `seed://<file>` URL, and `source_id` is
 * `internal.user`, the registered source §15 keeps for values a human supplied. `captured_at` and
 * `source_ts` are the file's own `asOf`, never `clock.now()`, so the row is a function of the file
 * and re-seeding does not move it.
 *
 * **`request_url` is `seed://treasuries.json`, not a `file://` path, and that is load-bearing.** It
 * used to be `file://${seedFixtureDir()}/<file>`, which put the seeding developer's home
 * directory into the row — and `provenance.request_url` is user-visible: it is the string the Ctrl+I
 * provenance popover shows, so every seeded Treasury instrument attributed itself to
 * `/Users/<someone>/…`. It also broke determinism, because two checkouts at different paths then
 * produce different `provenance` bytes for identical fixture content, which makes a
 * byte-comparison of two seeded databases impossible to assert. `seed://<file>` matches the
 * `seed://universe/<table>` convention `seed/universe.ts#curatedProvenance` already uses and which
 * `idempotent.test.ts#classifyNonRecorded` already accepts by its `startsWith('seed:')` branch.
 * Nothing is lost: `response_sha256` is what pins the content, and `request_key` was already
 * `seed:<file>`.
 *
 * Unlike a provider exchange this row is **re-used** rather than re-inserted: nothing was fetched,
 * so a second seed run has not observed anything a second time, and a new row per run would leave
 * `govt_terms` versions pointing at a provenance row whose only distinction from the last one is
 * its id. The lookup is on `(source_id, request_key, response_sha256)` — an edited file has a
 * different hash and therefore gets a new row, which is exactly the traceability DATA-10 wants.
 */
export async function seedFileProvenance(
  tx: Tx,
  file: { name: string; bytes: Buffer; asOf: string },
): Promise<{ provenanceId: number; reused: boolean }> {
  const url = `seed://${file.name}`;
  const key = `seed:${file.name}`;
  const digest = sha256Hex(file.bytes);
  const held = await tx.execute<{ provenance_id: string }>(sql`
    SELECT provenance_id FROM provenance
     WHERE source_id = ${SEED_FILE_SOURCE_ID}
       AND request_key = ${key}
       AND response_sha256 = decode(${digest}, 'hex')
     ORDER BY provenance_id
     LIMIT 1`);
  const row = held.rows[0];
  if (row !== undefined) return { provenanceId: Number(row.provenance_id), reused: true };

  const capturedAt = Date.parse(`${file.asOf}T00:00:00.000Z`);
  const raw: RawRecord = {
    providerId: SEED_FILE_SOURCE_ID,
    method: 'GET',
    url,
    requestKey: key,
    requestHash: requestHash('GET', url),
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: file.bytes,
    capturedAt,
    sha256: digest,
    sourceTs: new Date(capturedAt),
    origin: 'replay',
  };
  const provenanceId = await insertProvenance(tx, raw, {
    adapterVersion: SEED_FILE_ADAPTER_VERSION,
    sourceTs: new Date(capturedAt),
  });
  return { provenanceId, reused: false };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Clock
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A clock frozen at `atMs`.
 *
 * Exported because modules 7 (`seed/curves.ts`) and 8-9 (`seed/bars.ts`) need the same thing and
 * the precedent for "the plumbing lives in the module that needs it first" is `jobs/fedRates.ts`
 * importing `ensureCurves` from `jobs/treasuryCurves.ts`. The jobs read a clock for three things —
 * `ingest_runs.started_at`, the `(validAt)` of `resolveTargets`, and the session gate of
 * `cboeQuotes` — and all three must answer inside the recorded window for a replay to mean
 * anything.
 */
export function pinnedClock(atMs: number): Clock {
  return { now: () => atMs };
}

/** The capture instant of one recorded exchange, from the manifest. Throws on a miss (FEED-08). */
export function capturedAtOf(providerId: RawRecord['providerId'], url: string): number {
  return openReplayStore().replay({ providerId, url }).capturedAt;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row counts
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `count(*)` for each named table.
 *
 * Every seed module reports its `rows` as the **delta** these counts moved, not as the number of
 * rows a parser offered: §18's acceptance row is "running twice writes zero rows the second time",
 * and a summary that printed "302 curve points" on both runs would satisfy a reader while failing
 * the requirement. A delta is also the only count that survives a job writing through three
 * different upserts.
 *
 * Table names are a fixed list in the module that calls this, never user input; they are
 * interpolated because a table name cannot be a bind parameter.
 */
export async function countTables(
  tx: Tx,
  tables: readonly string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`countTables: unsafe name '${table}'`);
    const res = await tx.execute<{ n: string }>(sql.raw(`SELECT count(*)::text AS n FROM ${table}`));
    out[table] = Number(res.rows[0]?.n ?? '0');
  }
  return out;
}

/** `after − before` for every key of `after`; never negative in a seed, and reported if it is. */
export function tableDeltas(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [table, n] of Object.entries(after)) out[table] = n - (before[table] ?? 0);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The Treasury issuer
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `United States Department of the Treasury` issuer, found by name and minted once.
 *
 * `jobs/treasuryCurves.ts` has the same function and does not export it; the constant it keys on
 * is exported, which is what makes the two agree. Whichever of the two runs first mints the row and
 * the other finds it, so the seven curated notes hang off the same issuer as the bills.
 */
export async function ensureTreasuryIssuer(
  tx: Tx,
  o: { provenanceId: number; knownAt: Date },
): Promise<number> {
  const found = await tx.execute<{ issuer_id: string }>(sql`
    SELECT issuer_id FROM issuers
     WHERE name = ${TREASURY_ISSUER_NAME} AND tx_to = 'infinity'
     ORDER BY issuer_id LIMIT 1`);
  const row = found.rows[0];
  if (row !== undefined) return Number(row.issuer_id);
  return masterRepositories(tx).issuers.insert(
    { name: TREASURY_ISSUER_NAME, country: 'US', entityType: 'sovereign' },
    { validFrom: o.knownAt, provenanceId: o.provenanceId, knownAt: o.knownAt },
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Notes and bonds
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `govt_terms` for one curated note or bond. Every column is stated, because `TermsData` is a
 * complete statement of the terms at an instant and a partial one would re-open the key with the
 * table's defaults for whatever it left out (`refdata/terms.ts`).
 *
 * The conventions are the ones FUNCTIONS_TIER3 §0 L13 fixes for the seeded notes and bonds —
 * `coupon_freq 2`, `ACT/ACT`, `following`, `SIFMA`, `settlement_days 1`, `on_the_run true` — and
 * they are conventions, not data, which is why they are here and not in the fixture.
 * `last_regular_coupon` is the maturity: a Treasury note's final coupon is a regular one.
 */
export function noteTerms(security: TreasurySeedSecurity): TermsData<'govt'> {
  return {
    securityType: security.securityType,
    cusip: security.cusip,
    termLabel: security.termLabel,
    issueDate: security.issueDate,
    datedDate: security.datedDate,
    maturityDate: security.maturityDate,
    couponType: 'fixed',
    // `numeric(9,6)` is read and written as text: a float literal would round-trip through binary64.
    couponRate: security.couponRate.toFixed(6),
    couponFreq: 2,
    dayCount: 'ACT/ACT',
    firstCouponDate: security.firstCouponDate,
    lastRegularCoupon: security.maturityDate,
    businessDayConv: 'following',
    calendarId: 'SIFMA',
    settlementDays: 1,
    referenceIndex: null,
    spreadBp: null,
    indexRatioBase: null,
    isCallable: false,
    callSchedule: [],
    putSchedule: [],
    sinkSchedule: [],
    amortisation: [],
    makeWhole: null,
    covenants: null,
    guarantors: [],
    seniority: 'sovereign',
    collateral: null,
    minDenomination: '100.00',
    increment: '100.00',
    amountOutstanding: security.amountOutstanding.toFixed(2),
    onTheRun: true,
  };
}

export interface MintResult {
  instrumentsCreated: number;
  termsWritten: number;
  identifiersWritten: number;
  mdLinesWritten: number;
  instrumentByKey: Map<string, number>;
}

function emptyMint(): MintResult {
  return {
    instrumentsCreated: 0,
    termsWritten: 0,
    identifiersWritten: 0,
    mdLinesWritten: 0,
    instrumentByKey: new Map(),
  };
}

/**
 * Mint (or find) the seven curated notes and bonds: `issues`, `instruments`, the CUSIP identifier
 * and one `govt_terms` version each.
 *
 * `valid_from` is midnight UTC of the dated date — when the terms became true in the world — and
 * `tx_from` is the file's `asOf`, so a `knownAt` before the seed ran sees nothing and the history
 * reads as "we learned these terms on the curve date". No `md_lines` row: no recorded source quotes
 * an individual note (the par curve is tenor-keyed), so a line would promise a feed that does not
 * exist. YAS prices these from `curve_points`, which is what FUNCTIONS_TIER3 §YAS step 4 says.
 *
 * Idempotent in both halves: the CUSIP lookup finds an instrument an earlier run minted, and
 * `terms.upsert` returns `null` when the current version already says exactly this.
 */
export async function mintTreasurySecurities(
  tx: Tx,
  securities: readonly TreasurySeedSecurity[],
  o: { provenanceId: number; knownAt: Date; issuerId: number },
): Promise<MintResult> {
  const master = masterRepositories(tx);
  const identifiers = identifierRepository(tx);
  const terms = new TermsRepository(tx);
  const result = emptyMint();

  for (const security of securities) {
    const validFrom = new Date(`${security.datedDate}T00:00:00.000Z`);
    const write = { validFrom, provenanceId: o.provenanceId, knownAt: o.knownAt };

    const held = await identifiers.lookup('CUSIP', security.cusip, {
      validAt: o.knownAt,
      knownAt: o.knownAt,
    }, '');
    let instrumentId = held.find((row) => row.entityKind === 'instrument')?.entityId ?? null;

    if (instrumentId === null) {
      const issueId = await master.issues.insert(
        {
          issuerId: o.issuerId,
          assetClass: 'govt',
          securityType: 'US GOVERNMENT',
          cusip: security.cusip,
          name: security.name,
          currency: 'USD',
          countryOfIssue: 'US',
        },
        write,
      );
      instrumentId = await master.instruments.insert(
        {
          issueId,
          assetClass: 'govt',
          marketSector: 'Govt',
          // The command-line key of a coupon Treasury is its ticker, coupon and maturity —
          // `'T 4.25 08/15/36 Govt'` (FUNCTIONS §6 L622-643). Bills carry their CUSIP as the
          // ticker instead, which `treasuryCurves.ts` writes; only a coupon security has a ticker.
          ticker: security.ticker,
          exchCode: 'GOVT',
          name: security.name,
          currency: 'USD',
          priceDecimals: 6,
          // An on-the-run benchmark outranks an off-the-run issue in search (SRCH-02).
          searchWeight: 5,
        },
        write,
      );
      await identifiers.upsert(
        {
          entityKind: 'instrument',
          entityId: instrumentId,
          scheme: 'CUSIP',
          value: security.cusip,
          isPrimary: true,
        },
        write,
      );
      result.instrumentsCreated += 1;
      result.identifiersWritten += 1;
    }
    result.instrumentByKey.set(security.cusip, instrumentId);

    const versionId = await terms.upsert('govt', {
      instrumentId,
      data: noteTerms(security),
      validFrom,
      provenanceId: o.provenanceId,
      txFrom: o.knownAt,
      reason: 'initial',
    });
    if (versionId !== null) result.termsWritten += 1;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rate instruments
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The publisher of every NY Fed reference rate, as an issuer.
 *
 * A rate has no issuer in the securities sense, but `issues.issuer_id` is `NOT NULL` and the honest
 * answer to "whose number is this" is the publisher. `entity_type 'central_bank'` says it is not an
 * operating company.
 */
export const NYFED_PUBLISHER_NAME = 'Federal Reserve Bank of New York';

/**
 * Mint the six rate instruments, their `rate_terms`, their `md_lines` and their `econ_series`.
 *
 * PROVIDERS §10.4 leaves exactly this to the seed: "`rate_terms` is seeded … and it hangs off an
 * `asset_class 'rate'` instrument WP-15 mints". The md line is what makes `jobs/fedRates.ts`
 * publish anything at all — its parser emits `r:<rateCode>` updates for the lines it is handed,
 * keyed by `provider_symbol` = the rate code itself — so this has to run **before** `runFedRates`.
 *
 * `econ_series.instrument_id` and `rate_terms.series_id` are set in both directions: DATA_MODEL §20
 * puts the headline in `econ_observations` and the full record in `rate_fixings`, and GP, HP and
 * the `e:` subjects reach the headline from the instrument while YAS and BTMM reach the record from
 * the series.
 *
 * The provenance is the `nyfed-all` capture, which is where the six types are named. Nothing here
 * is invented: a type the capture does not carry is not minted, and the result says which.
 */
export async function mintRateInstruments(
  tx: Tx,
  rates: readonly RateSeedRow[],
  o: { provenanceId: number; knownAt: Date },
): Promise<MintResult & { seriesCreated: number }> {
  const master = masterRepositories(tx);
  const identifiers = identifierRepository(tx);
  const terms = new TermsRepository(tx);
  const result = { ...emptyMint(), seriesCreated: 0 };
  if (rates.length === 0) return result;

  const validFrom = o.knownAt;
  const write = { validFrom, provenanceId: o.provenanceId, knownAt: o.knownAt };
  const issuerId = await ensureIssuerByName(tx, NYFED_PUBLISHER_NAME, {
    ...o,
    // The `issuers.entity_type` CHECK of migration 0003. A Reserve Bank publishes the rate; it is
    // not an operating company and not a sovereign, and `central_bank` is the row the enum keeps
    // for exactly this.
    entityType: 'central_bank',
  });

  for (const rate of rates) {
    const held = await identifiers.lookup('PROVIDER_SYMBOL', rate.rateCode, {
      validAt: o.knownAt,
      knownAt: o.knownAt,
    }, NYFED_SOURCE_ID);
    let instrumentId = held.find((row) => row.entityKind === 'instrument')?.entityId ?? null;

    if (instrumentId === null) {
      const issueId = await master.issues.insert(
        {
          issuerId,
          assetClass: 'rate',
          securityType: 'Reference Rate',
          name: rate.name,
          currency: 'USD',
          countryOfIssue: 'US',
        },
        write,
      );
      instrumentId = await master.instruments.insert(
        {
          issueId,
          assetClass: 'rate',
          // `'SOFR Index'` is the command-line key (API.md §3 L222); `exch_code 'RATE'` is the
          // synthetic code that keeps the display from reading `'SOFR RATE Index'`.
          marketSector: 'Index',
          ticker: rate.ticker,
          exchCode: 'RATE',
          name: rate.name,
          currency: 'USD',
          priceDecimals: rate.decimals,
          searchWeight: 5,
        },
        write,
      );
      await identifiers.upsert(
        {
          entityKind: 'instrument',
          entityId: instrumentId,
          scheme: 'PROVIDER_SYMBOL',
          value: rate.rateCode,
          qualifier: NYFED_SOURCE_ID,
          isPrimary: true,
        },
        write,
      );
      await identifiers.upsert(
        {
          entityKind: 'instrument',
          entityId: instrumentId,
          scheme: 'SERIES_CODE',
          value: rate.rateCode,
          qualifier: NYFED_SOURCE_ID,
          isPrimary: false,
        },
        write,
      );
      result.instrumentsCreated += 1;
      result.identifiersWritten += 2;
    }
    result.instrumentByKey.set(rate.rateCode, instrumentId);

    const seriesId = await ensureEconSeries(tx, {
      seriesCode: rate.rateCode,
      sourceId: NYFED_SOURCE_ID,
      providerCode: rate.rateCode,
      name: rate.seriesName,
      units: rate.units,
      frequency: 'D',
      seasonalAdj: 'NSA',
      decimals: rate.decimals,
    });
    result.seriesCreated += 1;
    await tx.execute(sql`
      UPDATE econ_series SET instrument_id = ${instrumentId}::bigint
       WHERE series_id = ${seriesId}::bigint
         AND (instrument_id IS DISTINCT FROM ${instrumentId}::bigint)`);

    const versionId = await terms.upsert('rate', {
      instrumentId,
      data: {
        rateCode: rate.rateCode,
        publisher: NYFED_PUBLISHER_NAME,
        dayCount: 'ACT/360',
        publicationTimeEt: rate.publicationTimeEt,
        tenorDays: 1,
        compounding: rate.compounding,
        seriesId,
      },
      validFrom,
      provenanceId: o.provenanceId,
      txFrom: o.knownAt,
      reason: 'initial',
    });
    if (versionId !== null) result.termsWritten += 1;

    const line = await master.mdLines.upsertBySymbol(
      {
        instrumentId,
        sourceId: NYFED_SOURCE_ID,
        providerSymbol: rate.rateCode,
        lineKind: 'composite',
        // §10.4: the NY Fed publishes a final fixing, not a delayed quote. Zero is the truth.
        intrinsicDelayMin: 0,
        expectedIntervalMs: RATE_LINE_INTERVAL_MS,
        priority: RATE_LINE_PRIORITY,
      },
      write,
    );
    if (line.written) result.mdLinesWritten += 1;
  }
  return result;
}

/** Find-or-mint an issuer by name — the same shape as {@link ensureTreasuryIssuer}. */
async function ensureIssuerByName(
  tx: Tx,
  name: string,
  o: { provenanceId: number; knownAt: Date; entityType: IssuerEntityType },
): Promise<number> {
  const found = await tx.execute<{ issuer_id: string }>(sql`
    SELECT issuer_id FROM issuers
     WHERE name = ${name} AND tx_to = 'infinity'
     ORDER BY issuer_id LIMIT 1`);
  const row = found.rows[0];
  if (row !== undefined) return Number(row.issuer_id);
  return masterRepositories(tx).issuers.insert(
    { name, country: 'US', entityType: o.entityType },
    { validFrom: o.knownAt, provenanceId: o.provenanceId, knownAt: o.knownAt },
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The headline observations
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Copy the headline of every stored fixing into `econ_observations` — DATA_MODEL §20 ("headline in
 * `econ_observations`, full record in `rate_fixings`"), §18 row 6.
 *
 * Read back from `rate_fixings` rather than from the parse, for two reasons. The fixings are
 * written by `jobs/fedRates.ts` and it does not return them; and the *stored* row is what a screen
 * reads, so copying the stored value is what makes `GP SOFR` and `BTMM` agree by construction
 * rather than by coincidence. Each observation carries the `provenance_id` of the fixing it came
 * from — which is the capture that published it — so grouping by provenance keeps DATA-10 exact
 * instead of stamping a whole series with one id.
 *
 * `SOFRAI` publishes no `percentRate` (its record is three averages and an index level), so it has
 * no headline and contributes no observation. That is a `NULL` in the source, not a gap here.
 */
export async function writeRateObservations(
  tx: Tx,
  seriesByCode: ReadonlyMap<string, number>,
  capturedAt: number,
): Promise<{ inserted: number; revised: number; unchanged: number }> {
  const out = { inserted: 0, revised: 0, unchanged: 0 };
  const res = await tx.execute<{
    rate_code: string;
    effective_date: string;
    value: string;
    provenance_id: string;
  }>(sql`
    SELECT rate_code, effective_date::text AS effective_date, rate::text AS value,
           provenance_id::text AS provenance_id
      FROM rate_fixings
     WHERE is_latest AND rate IS NOT NULL
     ORDER BY rate_code, effective_date, provenance_id`);

  // Grouped by (series, provenance): `upsertEconObservations` stamps one provenance id on the whole
  // batch it is given, so the batches are the groups for which that id is the truth.
  const batches = new Map<string, { seriesId: number; provenanceId: number; rows: { obsDate: string; value: number; status: 'final' }[] }>();
  for (const row of res.rows) {
    const seriesId = seriesByCode.get(row.rate_code);
    if (seriesId === undefined) continue;
    const provenanceId = Number(row.provenance_id);
    const key = `${String(seriesId)}|${String(provenanceId)}`;
    const batch = batches.get(key) ?? { seriesId, provenanceId, rows: [] };
    batch.rows.push({ obsDate: row.effective_date, value: Number(row.value), status: 'final' });
    batches.set(key, batch);
  }

  const spans = new Map<number, { first: string; last: string }>();
  for (const batch of [...batches.values()].sort(
    (a, b) => a.seriesId - b.seriesId || a.provenanceId - b.provenanceId,
  )) {
    const counts = await upsertEconObservations(tx, batch.seriesId, batch.rows, {
      provenanceId: batch.provenanceId,
      capturedAt,
    });
    out.inserted += counts.inserted;
    out.revised += counts.revised;
    out.unchanged += counts.unchanged + counts.stale;
    const dates = batch.rows.map((r) => r.obsDate).sort();
    const first = dates[0];
    const last = dates[dates.length - 1];
    if (first === undefined || last === undefined) continue;
    const span = spans.get(batch.seriesId);
    spans.set(batch.seriesId, {
      first: span === undefined || first < span.first ? first : span.first,
      last: span === undefined || last > span.last ? last : span.last,
    });
  }

  for (const [seriesId, span] of [...spans.entries()].sort((a, b) => a[0] - b[0])) {
    await recordSeriesFacts(tx, seriesId, {
      firstObsDate: span.first,
      lastObsDate: span.last,
      capturedAt,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The module
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The tables module 6 writes, in the order §18 row 6 lists them. */
export const RATES_TABLES: readonly string[] = Object.freeze([
  'instruments',
  'issues',
  'issuers',
  'identifiers',
  'md_lines',
  'govt_terms',
  'rate_terms',
  'curve_points',
  'rate_fixings',
  'econ_series',
  'econ_observations',
]);

/** Rows written, per table: the delta, so a second run reports zeros (§18). */
export type SeedRatesResult = Record<string, number>;

/**
 * Module 6 (`seed/index.ts` order 3). One transaction, opened by the runner.
 *
 * The order is a dependency order: the rate instruments and their md lines exist before
 * `runFedRates` polls the NY Fed (a line-less run would write fixings and publish nothing), and
 * `runTreasuryCurves` mints the Treasury issuer before — or is found by — the curated notes.
 *
 * A fetch error inside a job is **not** swallowed: the jobs record one in `ingest_runs.errors` and
 * carry on, so this module counts them and throws if any capture was missing. A seed that silently
 * wrote 3 of 14 securities because a fixture had moved is the failure mode §18's row counts exist
 * to catch, and it is better caught here, by name, than by an acceptance test counting rows.
 */
export async function seedRates(ctx: SeedContext): Promise<SeedRatesResult> {
  // The runner hands out `db` (a drizzle handle on its own transaction's connection); every
  // repository and every ingest job takes a `Tx`. The cast is the same one `ingest/scheduler.ts`
  // L982 and `src/test/db.ts` L210 make, for the same reason: the two types differ only in
  // `rollback()`, which nothing below calls, and the seed's transaction is the runner's to end.
  const tx = ctx.db as unknown as Tx;

  // The recorded market instant, not the wall clock (see the header). `nyfed-all` is the capture
  // that names the six rate types, so its instant is when this module learned everything it mints.
  const nyfedAllUrl = latestAllUrl();
  const knownAtMs = capturedAtOf(nyFedRatesAdapter.id, nyfedAllUrl);
  const knownAt = new Date(knownAtMs);
  const clock = pinnedClock(knownAtMs);
  const jobCtx = { tx, clock, log: { info: () => undefined } };
  const before = await countTables(tx, RATES_TABLES);
  const errors: string[] = [];

  // Which legs this database already holds, decided BEFORE the module writes anything — see
  // `seed/fundamentals.ts#recordedLegs` for why the snapshot has to be taken up front rather than
  // at each leg. Without it a second `db:seed` re-ran both ingest legs, and in replay mode that
  // wrote seven `provenance` rows and three `ingest_runs` rows for exchanges that did not happen.
  const recorded = await recordedLegs(ctx, {
    // Both Treasury captures become `curve_points` — 126 par points from the yield curve and 126
    // bill points from the bill rates (§9.1, §9.2) — so one table decides the whole leg.
    treasury: [
      {
        table: 'curve_points',
        captures: SEED_TREASURY_MONTHS.flatMap((month) => [
          { sourceId: treasuryYieldCurveAdapter.id, url: treasuryUrl(YIELD_CURVE_DATASET, month) },
          { sourceId: treasuryBillsAdapter.id, url: treasuryUrl(BILL_RATES_DATASET, month) },
        ]),
      },
    ],
    // Every capture `runFedRates` reads, each judged by the table it lands in: the NY Fed rates
    // become `rate_fixings` (§10.4) and the H.15 CSV becomes `econ_observations` (§10.3). Naming the
    // captures individually rather than gating on the source is deliberate — a source-level gate on
    // `nyfed.rates` would be satisfied by the `/all/latest.json` row this module cites two
    // statements below, before the job has run at all.
    fed: [
      {
        table: 'rate_fixings',
        captures: [
          { sourceId: nyFedRatesAdapter.id, url: nyfedAllUrl },
          ...NYFED_BACKFILL.map((window) => ({
            sourceId: nyFedRatesAdapter.id,
            url: lastNUrl(window.code, window.days),
          })),
        ],
      },
      { table: 'econ_observations', captures: [{ sourceId: FED_H15_SOURCE_ID, url: h15Url() }] },
    ],
  });
  let legsAlreadyIngested = 0;

  // ── the six rate instruments, from the capture that names them ─────────────────────────────
  //
  // Find-or-insert, not insert: `runFedRates` reads this same capture below, so a bare insert put
  // two `provenance` rows on one digest on the first run and one more on every run after it. The
  // lookup is the one `seedFileProvenance` and `seed/bars.ts#citeCapture` already use — source,
  // request key and response digest — which is the triple that decides whether these are the same
  // bytes arriving again or different bytes at the same URL.
  const nyfedRaw = openReplayStore().replay({ providerId: nyFedRatesAdapter.id, url: nyfedAllUrl });
  const nyfedProvenanceId = await citeRecordedCapture(tx, nyfedRaw, NYFED_ADAPTER_VERSION);
  const published = new Set(publishedRateCodes(nyfedRaw));
  const rates = RATE_SEED.filter((rate) => published.has(rate.rateCode));
  if (rates.length !== RATE_SEED.length) {
    const missing = RATE_SEED.filter((rate) => !published.has(rate.rateCode)).map((r) => r.rateCode);
    ctx.log(`nyfed-all names ${String(rates.length)} of ${String(RATE_SEED.length)} rate types; not minting ${missing.join(', ')}`);
  }
  const minted = await mintRateInstruments(tx, rates, {
    provenanceId: nyfedProvenanceId,
    knownAt,
  });
  ctx.log(
    `rate master: ${String(minted.instrumentsCreated)} instruments, ${String(minted.termsWritten)} rate_terms, ${String(minted.mdLinesWritten)} md_lines`,
  );

  // ── the Treasury bills, their terms and the par/bill curve points (§9.1, §9.2) ─────────────
  if (recorded.has('treasury')) {
    legsAlreadyIngested += 1;
    ctx.log('treasury: both Treasury captures are already in provenance — nothing to do');
  } else {
    const treasury = await runTreasuryCurves({ ...jobCtx, months: SEED_TREASURY_MONTHS });
    for (const error of treasury.errors) {
      errors.push(`treasuryCurves: ${error.code} ${error.message}`);
    }
    ctx.log(
      `treasury: ${String(treasury.billSecurities)} bill CUSIPs, ${String(treasury.instrumentsCreated)} instruments, ${String(treasury.parPoints)} par + ${String(treasury.billPoints)} bill points`,
    );
  }

  // ── the seven curated notes and bonds ──────────────────────────────────────────────────────
  // The bytes as well as the document: `response_sha256` has to be the hash of what is on disk, so
  // that an edit to the file is visibly a different provenance row (DATA-10).
  const treasuryFile = await readSeedFile(TREASURY_SEED_FILE);
  const file = parseTreasurySeed(treasuryFile.document);
  const fileProvenance = await seedFileProvenance(tx, {
    name: TREASURY_SEED_FILE,
    bytes: treasuryFile.bytes,
    asOf: file.asOf,
  });
  const issuerId = await ensureTreasuryIssuer(tx, {
    provenanceId: fileProvenance.provenanceId,
    knownAt,
  });
  const notes = await mintTreasurySecurities(tx, file.securities, {
    provenanceId: fileProvenance.provenanceId,
    knownAt: new Date(`${file.asOf}T00:00:00.000Z`),
    issuerId,
  });
  ctx.log(
    `curated notes/bonds: ${String(notes.instrumentsCreated)} instruments, ${String(notes.termsWritten)} govt_terms, provenance ${fileProvenance.reused ? 'reused' : 'written'}`,
  );

  // ── the fixings, the SOFR_FIX and UST_CMT points, and the 11 H.15 series (§10.3, §10.4) ────
  if (recorded.has('fed')) {
    legsAlreadyIngested += 1;
    ctx.log('fed: every NY Fed and H.15 capture is already in provenance — nothing to do');
  } else {
    const fed = await runFedRates(jobCtx);
    const fixingsWritten = fed.fixingsInserted + fed.fixingVintages;
    for (const error of fed.errors) errors.push(`fedRates: ${error.code} ${error.message}`);
    ctx.log(
      `fed: ${String(fixingsWritten)} fixings, ${String(fed.sofrPoints)} SOFR_FIX + ${String(fed.cmtPoints)} UST_CMT points, ${String(fed.h15Series)} H.15 series, ${String(fed.h15Observations)} observations`,
    );
  }

  // ── the headline observations of the six rates ─────────────────────────────────────────────
  const seriesByCode = await seriesIdsByCode(tx, NYFED_SOURCE_ID);
  const observations = await writeRateObservations(tx, seriesByCode, knownAtMs);
  ctx.log(
    `rate observations: ${String(observations.inserted)} inserted, ${String(observations.revised)} revised, ${String(observations.unchanged)} unchanged`,
  );

  if (errors.length > 0) {
    throw new Error(
      `seed/rates: ${String(errors.length)} capture(s) could not be read, so the module would ` +
        `have written a partial master:\n  ${errors.join('\n  ')}`,
    );
  }
  return { ...tableDeltas(before, await countTables(tx, RATES_TABLES)), legsAlreadyIngested };
}

/**
 * The `provenance_id` for a capture this module cites directly, written once per database.
 *
 * `provenance` has no unique index — it is an append-only log of exchanges, and in live mode two
 * reads of one URL genuinely are two exchanges. Under `PROVIDER_MODE=replay` there is no exchange
 * at all, so the row is a record of which recorded bytes a value came from and a second row for the
 * same bytes is a duplicate rather than a second observation. The triple `(source_id, request_key,
 * response_sha256)` is what decides it: the same bytes at the same request key are the same
 * capture; re-recorded bytes hash differently and correctly get a row of their own.
 */
async function citeRecordedCapture(
  tx: Tx,
  raw: RawRecord,
  adapterVersion: string,
): Promise<number> {
  const held = await tx.execute<{ provenance_id: string }>(sql`
    SELECT provenance_id FROM provenance
     WHERE source_id = ${raw.providerId}
       AND request_key = ${raw.requestKey}
       AND response_sha256 = decode(${raw.sha256}, 'hex')
     ORDER BY provenance_id
     LIMIT 1`);
  const row = held.rows[0];
  if (row !== undefined) return Number(row.provenance_id);
  return insertProvenance(tx, raw, { adapterVersion, sourceTs: null });
}

/** `econ_series.series_id` by `provider_code` for one source. */
async function seriesIdsByCode(tx: Tx, sourceId: string): Promise<Map<string, number>> {
  const res = await tx.execute<{ provider_code: string; series_id: string }>(sql`
    SELECT provider_code, series_id::text AS series_id FROM econ_series
     WHERE source_id = ${sourceId} ORDER BY provider_code`);
  return new Map(res.rows.map((row) => [row.provider_code, Number(row.series_id)]));
}

/** The rate types one NY Fed capture actually publishes. Nothing is minted that it does not name. */
export function publishedRateCodes(raw: RawRecord): RateCode[] {
  const document: unknown = JSON.parse(raw.body.toString('utf8'));
  const refRates = (document as { refRates?: unknown }).refRates;
  if (!Array.isArray(refRates)) return [];
  const codes = new Set<string>();
  for (const entry of refRates as unknown[]) {
    if (entry === null || typeof entry !== 'object') continue;
    const type = (entry as { type?: unknown }).type;
    if (typeof type === 'string') codes.add(type);
  }
  return RATE_CODES.filter((code) => codes.has(code));
}

/** Module 6 of the ordered seed runner (`seed/index.ts`). */
export const seed = seedRates;
