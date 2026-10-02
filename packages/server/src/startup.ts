/**
 * The checks and loads of startup steps 3, 4 and 5 — ARCHITECTURE §12.1 L1247-1249 — and the record
 * of what is still deferred ({@link DEFERRED_STARTUP_STEPS}).
 *
 * ```
 * 3  load the field dictionary; validate every `field_licence.field_id` exists in it (exit 1 otherwise)
 * 4  load calendars (`refdata/calendars.ts`) and the function registry; `gen-function-index`
 *    consistency check (every manifest has a server module)
 * 5  build the universe search snapshot (`search/snapshot.ts`) and its ETag
 * ```
 *
 * They live here rather than inline in `index.ts` for one reason: `index.ts` executes on import, so
 * nothing in a test can call it, and for fourteen work packages these three steps were skipped with
 * a log line that no test could see. Each function below is a pure-ish call over an injected handle,
 * so `test/integration/startup.test.ts` runs the steps the shipped process runs and asserts what
 * each one produced — including the two failure paths, by writing a bad row and by handing the
 * check a catalogue whose manifest has no module.
 *
 * Two of the three refuse to boot when they fail, and the third does not. The distinction is
 * deliberate and is the same one ARCHITECTURE draws:
 *
 *  * A `field_licence.field_id` the dictionary does not know, and a manifest with no resolver
 *    module, are **build artefacts disagreeing with each other**. Nothing a running process can do
 *    repairs either, and both fail silently in production — the first as an entitlement decision
 *    about a field nobody can request, the second as a `500` the first time a user types `GO`. Both
 *    throw here, and `index.ts` exits 1 with the list, as step 3 says in so many words.
 *  * A materialised calendar that disagrees with its rule generator is **data**. An ad-hoc closure
 *    that data ops added before the generator was updated is a legitimate difference, and
 *    `materialiseCalendar` is explicitly documented never to delete a holiday the rules did not
 *    produce. So a disagreement is reported — loudly, per day, on the startup report and at `error`
 *    level — and the process keeps serving. Refusing every screen in the terminal over one holiday
 *    would be the wrong trade.
 *
 * The calendars are the half of step 4 with no in-memory consumer: the plant decides sessions from
 * the *code* calendars (`plant/tickerPlant.ts#DEFAULT_SESSION_CALENDARS`) while `data/reference.ts`
 * answers settlement and holiday questions from the *rows*, through a `CalendarRepository` it builds
 * per transaction. Loading them at startup is therefore a check, not a cache: it is where the two
 * halves are compared, once, instead of at the first `WIRP` of the day.
 */

import { registry as productionRegistry, type FunctionRegistry } from '@terminal/core';
import {
  FIELD_DICTIONARY_GENERATED_AT,
  FIELD_DICTIONARY_VERSION,
  fieldDefs,
  hasField,
} from '@terminal/core/fields/dictionary';
import { registeredCalendars } from '@terminal/core/calendars/calendar';
import { sql } from 'drizzle-orm';

// The nine rule calendars register themselves as a side effect of being imported, and
// `registeredCalendars()` is empty until they are. `seed/universe.ts#SEEDED_CALENDARS` is the same
// nine; these imports are what make them the list this file checks.
import { FX_USD } from '@terminal/core/calendars/fx';
import { XCBO, XNAS, XNYS } from '@terminal/core/calendars/nyse';
import { SIFMA } from '@terminal/core/calendars/sifma';
import { TARGET2, XLON } from '@terminal/core/calendars/target2';
import { USGOVT } from '@terminal/core/calendars/usgovt';
import { WEEKEND } from '@terminal/core/calendars/weekend';

import { functionModules } from './functions/index.js';
import { CalendarRepository, diffCalendars } from './refdata/calendars.js';
import { universeSnapshot, type UniverseSnapshotCache } from './search/snapshot.js';

import type { Clock } from '@terminal/core';
import type { Db, Tx } from './db/client.js';

/**
 * Referenced so the nine imports above cannot be dropped as unused: the registration they perform
 * is a module side effect, and a tidy-up that removed the import would empty
 * {@link registeredCalendars} and make step 4 check nothing at all.
 */
const RULE_CALENDARS = [FX_USD, SIFMA, TARGET2, USGOVT, WEEKEND, XCBO, XLON, XNAS, XNYS] as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 3 — the field dictionary and its field-id validation
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Startup step 3 found `field_licence` rows naming fields the dictionary does not have. */
export class FieldLicenceUnknownFieldError extends Error {
  readonly unknown: readonly string[];

  constructor(unknown: readonly string[]) {
    super(
      `${String(unknown.length)} field_licence row(s) name a field id the dictionary ` +
        `(version ${FIELD_DICTIONARY_VERSION}) does not have: ${unknown.join(', ')} — ` +
        'ARCHITECTURE §12.1 step 3. Either the row is stale or the dictionary entry was renamed; ' +
        'a licence for a field nobody can request decides entitlements about nothing.',
    );
    this.name = 'FieldLicenceUnknownFieldError';
    this.unknown = unknown;
  }
}

/** What step 3 loaded and checked. */
export interface FieldDictionaryReport {
  /** `fieldDefs.length` — the dictionary is code, so this is the build's own number. */
  readonly fields: number;
  readonly dictionaryVersion: string;
  readonly dictionaryGeneratedAt: string;
  /** `field_licence` rows read. */
  readonly fieldLicences: number;
  /** Distinct `field_id` values among them. */
  readonly fieldIds: number;
  /**
   * Dictionary fields with no `field_licence` row at all. **Not** an error, and deliberately not:
   * ARCHITECTURE step 3 validates one direction only, and a field with no licence row is a field
   * the evaluator refuses on every path that names it, rather than fixed by a startup guard.
   *
   * **Thirty-two on the database this build seeds** — the booted process's own step-3 report reads
   * `fields: 311, fieldIds: 279, fieldsWithoutLicence: 32`, and the 32 are the dictionary's
   * sourceless and class-less entries: the formula-language and prefix placeholders (`SPREAD`,
   * `CHG_`, `CPNTO`, `ECO_`, `OPT_`, `SPREADS`), the `SYS`/status fields (`BUILD_ID`, `SERVER_TIME`,
   * `PLANT_STATE`, …) and the news and option-chain fields that declare no asset class (`HEADLINE`,
   * `NEWS_ID`, `ATM_IV`, `EXPIRIES`, …). `field_licence.asset_class` is `NOT NULL` (migration
   * `0002`), so a field declaring no class cannot have a row — which is why this is a count and not
   * a defect list.
   *
   * It is **not** the census in `test/parity/fn-parity.test.ts`, and an earlier version of this
   * comment said "twenty fields, recorded in" that census, conflating two different quantities and
   * getting both numbers wrong. That census counts *refused exports* — eighteen of them — over 71
   * `(field, asset class)` PAIRS, naming 38 distinct field ids in `CSV_DENIALS`; a pair is denied
   * there because a manifest pre-checks a field under a class the dictionary never declared for it,
   * which is a manifest defect and not a missing licence row. Neither 32 nor 38 nor 18 is twenty,
   * and the assertion beside this field is derived from the database, so no test would have noticed.
   */
  readonly fieldsWithoutLicence: number;
}

/**
 * Startup step 3. `licence_registry` and `field_licence` are loaded by
 * `entitlements/licenceRegistry.ts#reload()`, which `index.ts` awaits before this; the dictionary is
 * code and is loaded by importing it. What is left is the agreement between the two.
 *
 * @throws FieldLicenceUnknownFieldError — `index.ts` exits 1 with the list.
 */
export async function validateFieldLicences(db: Db | Tx): Promise<FieldDictionaryReport> {
  const res = await db.execute<{ field_id: string; rows: number }>(sql`
    SELECT field_id, count(*)::int AS rows FROM field_licence GROUP BY field_id ORDER BY field_id`);

  let fieldLicences = 0;
  const unknown: string[] = [];
  const licensed = new Set<string>();
  for (const row of res.rows) {
    fieldLicences += row.rows;
    licensed.add(row.field_id);
    if (!hasField(row.field_id)) unknown.push(row.field_id);
  }
  if (unknown.length > 0) throw new FieldLicenceUnknownFieldError(unknown);

  return {
    fields: fieldDefs.length,
    dictionaryVersion: FIELD_DICTIONARY_VERSION,
    dictionaryGeneratedAt: FIELD_DICTIONARY_GENERATED_AT,
    fieldLicences,
    fieldIds: licensed.size,
    fieldsWithoutLicence: fieldDefs.filter((def) => !licensed.has(def.id)).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 4a — calendars
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One materialised calendar that does not say what its rule generator says. */
export interface CalendarDisagreement {
  readonly calendarId: string;
  /** ISO days on which the rows and the rule differ, ascending. */
  readonly days: readonly string[];
}

/** What step 4 loaded from `calendars` / `calendar_sessions` / `calendar_holidays`. */
export interface CalendarReport {
  /** Calendar ids read back from the database, ascending. */
  readonly loaded: readonly string[];
  /**
   * Rule calendars with no rows. Before `db:seed` has run this is all nine, which is why it is a
   * warning rather than a failure: a fresh database is a legitimate state for a process that is
   * about to be seeded.
   */
  readonly absent: readonly string[];
  /** The window the comparison covers, inclusive. */
  readonly fromYear: number;
  readonly toYear: number;
  readonly disagreements: readonly CalendarDisagreement[];
}

export interface LoadCalendarsOptions {
  /**
   * The middle of the comparison window; the check covers `[year - 1, year + 1]`. Defaults to the
   * injected clock's current year — the only years a running process decides sessions in. The rule
   * generators cover 1990-2040 and the seed materialises all of it, so a full-range diff would be
   * 4,386 days of arithmetic on every boot to answer a question about three of them.
   */
  readonly year?: number;
}

/**
 * Startup step 4, first half. Reads every rule calendar back out of the database and compares it
 * with the generator that produced it (`refdata/calendars.ts#diffCalendars`).
 *
 * Never throws for a disagreement — see this module's header for why. It does propagate a database
 * failure: a startup that cannot read `calendars` at all has a broken connection, not a data
 * problem, and step 2 has already proven the pool works.
 */
export async function loadCalendars(
  db: Db | Tx,
  clock: Clock,
  options: LoadCalendarsOptions = {},
): Promise<CalendarReport> {
  const rules = registeredCalendars();
  const year = options.year ?? new Date(clock.now()).getUTCFullYear();
  const fromYear = year - 1;
  const toYear = year + 1;

  // One `CalendarRepository` for the whole step, so `getMany` reads the nine calendars in one set
  // of queries rather than nine round trips.
  const repo = new CalendarRepository(db as Tx);
  const stored = await repo.getMany(rules.map((cal) => cal.id));

  const loaded: string[] = [];
  const absent: string[] = [];
  const disagreements: CalendarDisagreement[] = [];
  for (const rule of rules) {
    const rows = stored.get(rule.id);
    if (rows === undefined) {
      absent.push(rule.id);
      continue;
    }
    loaded.push(rule.id);
    const diffs = diffCalendars(rows, rule, fromYear, toYear);
    if (diffs.length > 0) {
      disagreements.push({ calendarId: rule.id, days: diffs.map((d) => d.day) });
    }
  }

  return { loaded, absent, fromYear, toYear, disagreements };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 4b — the `gen-function-index` consistency check
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Startup step 4 found the catalogue and the generated resolver barrel disagreeing. */
export class FunctionRegistryMismatchError extends Error {
  readonly manifestsWithoutModule: readonly string[];
  readonly modulesWithoutManifest: readonly string[];

  constructor(manifestsWithoutModule: readonly string[], modulesWithoutManifest: readonly string[]) {
    const parts: string[] = [];
    if (manifestsWithoutModule.length > 0) {
      parts.push(
        `manifest(s) with no server module: ${manifestsWithoutModule.join(', ')} — ` +
          '`GO` on any of them answers 500',
      );
    }
    if (modulesWithoutManifest.length > 0) {
      parts.push(
        `server module(s) with no manifest: ${modulesWithoutManifest.join(', ')} — ` +
          'nothing can ever route to them',
      );
    }
    super(
      `the function catalogue and functions/index.ts disagree (ARCHITECTURE §12.1 step 4): ` +
        `${parts.join('; ')}. Run \`npm run gen:functions\`.`,
    );
    this.name = 'FunctionRegistryMismatchError';
    this.manifestsWithoutModule = manifestsWithoutModule;
    this.modulesWithoutManifest = modulesWithoutManifest;
  }
}

/** What step 4's second half compared. */
export interface FunctionRegistryReport {
  readonly manifests: number;
  readonly modules: number;
  readonly registryVersion: string;
}

export interface FunctionRegistryCheckDeps {
  /** Defaults to the generated production catalogue — the one `http/routes/functions.ts` serves. */
  readonly registry?: FunctionRegistry;
  /** Defaults to `functions/index.ts`'s generated `functionModules`. */
  readonly modules?: Readonly<Record<string, unknown>>;
}

/**
 * Startup step 4, second half: every manifest has a server module, and every server module has a
 * manifest. Both directions, because the failures are different and both are silent — a manifest
 * with no module is a `500` the first time somebody launches it, and a module with no manifest is
 * dead code the router can never reach, which is how `chart/scales.ts` came to be 761 lines nothing
 * drew with.
 *
 * Synchronous and pure: both operands are module-level constants of the running binary, so this is
 * the cheapest check in startup and the one most worth keeping.
 *
 * @throws FunctionRegistryMismatchError — `index.ts` exits 1 with both lists.
 */
export function checkFunctionRegistry(deps: FunctionRegistryCheckDeps = {}): FunctionRegistryReport {
  const registry = deps.registry ?? productionRegistry;
  const modules = deps.modules ?? functionModules;

  const manifestsWithoutModule = registry
    .all()
    .map((manifest) => manifest.code)
    .filter((code) => !Object.hasOwn(modules, code));
  // `registry.get` resolves aliases too, which is the right test: a directory named after an alias
  // would still be reachable, and refusing it would be a naming rule this check does not own.
  const modulesWithoutManifest = Object.keys(modules).filter(
    (name) => registry.get(name) === undefined,
  );
  if (manifestsWithoutModule.length > 0 || modulesWithoutManifest.length > 0) {
    throw new FunctionRegistryMismatchError(manifestsWithoutModule, modulesWithoutManifest);
  }

  return {
    manifests: registry.all().length,
    modules: Object.keys(modules).length,
    registryVersion: registry.version,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 5 — the universe search snapshot and its ETag
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What step 5 built. The cache goes on `AppDeps.universe.snapshot`; the rest is for the log. */
export interface UniverseSnapshotStartup {
  readonly cache: UniverseSnapshotCache;
  readonly version: string;
  readonly etag: string;
  readonly bytes: number;
  readonly instruments: number;
  readonly functions: number;
  readonly people: number;
  readonly topics: number;
}

export interface UniverseSnapshotStartupDeps {
  readonly db: Db | Tx;
  readonly clock: Clock;
  /** Defaults to the generated production catalogue, as `http/routes/universe.ts` does. */
  readonly registry?: FunctionRegistry;
}

/**
 * Startup step 5. Builds the cache and *awaits the first build*, which is the whole point of doing
 * it here: `http/routes/universe.ts#universeCacheFor` would otherwise create the cache lazily and
 * the first caller of `GET /universe/snapshot` would pay the 41 k-row scan and the multi-megabyte
 * serialisation inside their own request. The built cache is handed to `AppDeps.universe.snapshot`,
 * which is also what `http/routes/search.ts` ranks its server fallback over, so the route, the
 * ranker and this step share one build and one ETag.
 */
export async function buildStartupUniverseSnapshot(
  deps: UniverseSnapshotStartupDeps,
): Promise<UniverseSnapshotStartup> {
  const cache = universeSnapshot({
    db: deps.db,
    clock: deps.clock,
    registry: deps.registry ?? productionRegistry,
  });
  const snapshot = await cache.get();
  return {
    cache,
    version: snapshot.version,
    etag: snapshot.etag,
    bytes: snapshot.bytes,
    instruments: snapshot.instruments.length,
    functions: snapshot.functions.length,
    people: snapshot.people.length,
    topics: snapshot.topics.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// What is still deferred
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A startup step this process still does not perform, and why. Not a work-package name: every
 * package named by the previous version of this list is merged, so "waiting for WP-07" had stopped
 * being true and had started being a way of not saying anything.
 */
export interface DeferredStartupStep {
  readonly step: number;
  readonly what: string;
  /** One sentence, in the present tense, naming the decision that has to be taken first. */
  readonly blockedBy: string;
}

/**
 * Step 8, and the reason it is deferred. `test/integration/startup.test.ts` asserts this list is
 * exactly `[8]`, so a step that is wired today cannot quietly become a skip again — and a step that
 * is wired tomorrow has to be deleted from here to make that test pass.
 *
 * Step 8 is deferred rather than skipped for lack of code. The lock (`ingest/lock.ts`), the
 * scheduler (`ingest/scheduler.ts`), the 26-job table, the provider `HttpClient` and the hot set
 * all exist and compose; what is missing is three decisions that reach outside the composition
 * root, and the measurements behind each are in the commit message:
 *
 *  1. In `PROVIDER_MODE=replay` — the mode `npm run dev`, the e2e suite and the offline demo all
 *     run in — one scheduler tick re-inserted **twelve `provenance` rows that duplicate rows the
 *     seed had already written**, `captured_at` and `response_sha256` included, because a replayed
 *     poll is the same recorded exchange counted again. That is the defect `db:seed` was fixed for
 *     one commit ago ("ten runs would leave 200 rows asserting 200 provider round-trips that never
 *     occurred, in the table DATA-10 exists to make trustworthy"), and `providers/provenance.ts`
 *     has no natural-key guard to stop it. Either that guard or a rule about which jobs a replay
 *     process may schedule has to be decided first.
 *
 *     Read this narrowly, because the obvious repair is wrong. A `provenance` row per repeated poll
 *     is **correct in `live` mode and is a merged contract**: PROVIDERS.a §1.3 asks for exactly one
 *     row per non-304 exchange, and
 *     `test/integration/ingest/marketDataJobs.test.ts` asserts that a second run grows `provenance`
 *     by two while `quote_ticks` does not grow at all — "where did this number come from" and "how
 *     often did we ask" are different questions. A natural-key guard added to
 *     `providers/provenance.ts` unconditionally would delete the answer to the second one. What is
 *     false is only the replay case, where no exchange occurred at all, and that is why the decision
 *     is about *which mode* the guard applies in and not about the insert.
 *  2. `JobContext` may not carry the plant: `plant/store.ts#writeTick` inserts `quote_ticks` with
 *     no conflict clause while `jobs/cboeQuotes.ts#insertQuoteTicks` dedups on
 *     `(md_line_id, capture_ts, kind)`, so the first poll that reaches `plant.apply` writes every
 *     tick twice. `BUILD_STATUS.md` records the two ways out and that neither may be taken on
 *     speculation. Without the plant, nothing the scheduler polls reaches a screen at all, so the
 *     wiring would spend provenance rows and deliver no live value.
 *  3. `JobContext` carries no `http`. `jobs/cboeQuotes.ts#MarketJobContext` states that one of
 *     `http` or `replay` must be present for a job to see any bytes, so a scheduler that cannot
 *     pass one drives every provider job through `openReplayStore()` — in `live` mode too, which is
 *     a deployment serving recorded bytes and stamping provenance for them. Widening the contract
 *     is a change to the declaration in ARCHITECTURE L994-1002.
 *
 * **Step 9 is not on this list**, and the skip line that used to put it here was wrong about two of
 * its three clauses. Taking them in the order ARCHITECTURE L1254 writes them:
 *
 *  * *the access-log writer* — started by `index.ts` since WP-07 (`log.start()`), and the one clause
 *    the old skip line contradicted while the code did it anyway.
 *  * *the usage-event writer* — the clause that was genuinely missing, and is now wired:
 *    `index.ts` builds `observability/usageEvents.ts` beside the access log, puts it on
 *    `AppDeps.functions.usageEvents` and starts it after the listener. Until then
 *    `functions/runner.ts#logUsage` returned on its first line (`if (events === undefined) return`)
 *    and the running server wrote no `fn.*` row at all, so `GET /usage/functions` — ARCHITECTURE
 *    §11's roadmap query — counted only rows a client had posted about itself, which API.md L783
 *    marks `clientReported` precisely because they are not the server's own account. Measured on the
 *    seeded `bloomberg_dev`: all 80 `fn.launch` rows carried `details.clientReported = true` before
 *    this wiring, and the first run through the wired process produced the first row that did not.
 *
 *    Wiring it exposed a second defect, in the consumer rather than the writer, and that one is
 *    fixed in `http/routes/usage.ts`: `GET /usage/functions` counted *every* `fn.launch` row, so a
 *    launch from the web shell — which posts its own GO → first paint copy (FUNCTIONS.md §588) —
 *    would have been counted twice the moment the authoritative writer started. Six launches where
 *    three had happened. It was right only for as long as the server wrote nothing.
 *  * *the DQ writers* — there is no DQ writer to start. `observability/dq.ts#raiseDq` is an
 *    unbuffered insert with no timer and no lifecycle, and its callers are already live: the
 *    gateway raises `plant_degraded` from its own sweep and `ws/session.ts` raises
 *    `ws_backpressure`, while the adapters raise `parse_error` and `poll_anomaly` inline. The
 *    *periodic* monitors (`checkStaleTick`, `checkDefaultPartitions`, `checkRefOrphans`) are not a
 *    writer either: they are the body of `ingest/jobs/dqMonitors.ts`, a row of the 26-job table, so
 *    they arrive with the scheduler. That is step 8's deferral, counted once, not twice.
 *  * *the 1 s staleness sweep* — armed since WP-06 by `ws/gateway.ts`, which calls
 *    `plant.sweep(clock.now())` once for the whole plant while any session is connected, which is
 *    where TERM-12 puts it. It does not fight the client sweep that landed with the live grid:
 *    ARCHITECTURE §13's TERM-12 row asks for the verdict to be "computed by one function
 *    (`core/quote/staleness.ts`) on server and client" and "recomputed every second client-side",
 *    and both callers compute it from that one function over their own copy of the same three
 *    timestamps, so the two cannot disagree about a subject unless the copies differ — which is the
 *    gap frame's job to fix, not the sweep's.
 */
export const DEFERRED_STARTUP_STEPS: readonly DeferredStartupStep[] = Object.freeze([
  Object.freeze({
    step: 8,
    what: 'the ingest leader lock and the scheduler',
    blockedBy:
      'a replayed poll re-inserts the provenance rows the seed already wrote (measured: 12 per ' +
      'tick), the plant may not join a JobContext until the two writers of quote_ticks are ' +
      'reconciled, and JobContext carries no HttpClient for a live deployment to use',
  }),
]);

/** Everything steps 3, 4 and 5 produced, for the log line and for the acceptance test. */
export interface StartupReport {
  readonly fields: FieldDictionaryReport;
  readonly calendars: CalendarReport;
  readonly functions: FunctionRegistryReport;
  readonly universe: UniverseSnapshotStartup;
  readonly deferred: readonly DeferredStartupStep[];
}

export interface RunStartupStepsDeps {
  readonly db: Db | Tx;
  readonly clock: Clock;
  /** Test seams; production passes neither and gets the generated catalogue and barrel. */
  readonly registry?: FunctionRegistry;
  readonly modules?: Readonly<Record<string, unknown>>;
  readonly calendarYear?: number;
}

/**
 * Steps 3, 4 and 5 in order, as `index.ts` runs them. Returns everything they produced; throws on
 * the two failures that are exit-1 conditions.
 *
 * In order, and not merely for tidiness: step 3 decides whether the entitlement tables can be
 * trusted at all, and there is no point building a universe snapshot whose `functions` tuples come
 * from a catalogue step 4 has not checked.
 */
export async function runStartupSteps(deps: RunStartupStepsDeps): Promise<StartupReport> {
  void RULE_CALENDARS;

  const fields = await validateFieldLicences(deps.db);
  const calendars = await loadCalendars(
    deps.db,
    deps.clock,
    deps.calendarYear === undefined ? {} : { year: deps.calendarYear },
  );
  const functions = checkFunctionRegistry({
    ...(deps.registry === undefined ? {} : { registry: deps.registry }),
    ...(deps.modules === undefined ? {} : { modules: deps.modules }),
  });
  const universe = await buildStartupUniverseSnapshot({
    db: deps.db,
    clock: deps.clock,
    ...(deps.registry === undefined ? {} : { registry: deps.registry }),
  });

  return { fields, calendars, functions, universe, deferred: DEFERRED_STARTUP_STEPS };
}
