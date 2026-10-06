/**
 * `test/integration/startup.test.ts` — startup steps 3, 4, 5 and 9 (ARCHITECTURE §12.1
 * L1247-1249, L1254) and what `GET /health` says about the one that is still deferred.
 *
 * Why this file exists at all is worth recording. For fourteen work packages `src/index.ts` skipped
 * five of its nine startup steps behind a `log.warn` naming the work package it was waiting for, and
 * nothing could see it: `index.ts` executes on import, so no test could call it, and 262 green test
 * files had never booted the process. The steps now live in `src/startup.ts` so they can be called,
 * and the last block of this file boots the real entry point as a child process and reads
 * `/api/v1/health` over HTTP — which is the only assertion here that covers the wiring inside
 * `index.ts` itself rather than the functions it calls.
 *
 * Step 9 is covered differently from 3, 4 and 5, because it is a *member on `AppDeps`* rather than a
 * call: the test runs `HELP` through the shipped `POST /functions/:code/run` route over the
 * production catalogue, once with the usage-event writer on `deps.functions` and once without, and
 * counts `usage_events` rows. The second half is the defect this step closes, kept as an assertion:
 * with no writer, `functions/runner.ts#logUsage` returns on its first line and FUNC-04's row is
 * never written. Neither half asserts anything about the writer itself — `usage_events`'s columns,
 * partitioning and `params_hash` are `test/integration/observability/usage.test.ts`'s subject.
 *
 * The verdict assertions are on the **fields**, never on the string alone. `status` is a conjunction
 * of four of them, so `expect(status).toBe('degraded')` is satisfied by any one being false and
 * would keep passing if a second step regressed; and a test that recomputes the conjunction from the
 * body it was handed asserts the route's arithmetic against itself, which is what the `/health` case
 * in `observability/status.test.ts` used to do. Here every field is asserted against what it is
 * supposed to be and the verdict against a literal.
 *
 * Self-sufficient (TESTING §4.3): every firm, user, session and calendar row is written inside this
 * file's rolled-back transaction, which is also the handle the app is given.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import cookie from '@fastify/cookie';
import { FunctionRegistry, registry as productionRegistry } from '@terminal/core';
import { fieldDefs } from '@terminal/core/fields/dictionary';
import { XNYS } from '@terminal/core/calendars/nyse';
import { HealthResponse } from '@terminal/sdk/wire/rest/status';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, type AppDeps, type ServerState } from '../../src/app.js';
import { getConfig } from '../../src/config.js';
import { evaluator } from '../../src/entitlements/evaluator.js';
import { licenceRegistry } from '../../src/entitlements/licenceRegistry.js';
import { quotas } from '../../src/entitlements/quotas.js';
import { functionModules } from '../../src/functions/index.js';
import { paramsHash, usageEvents } from '../../src/observability/usageEvents.js';
import { buildPlant, type Plant } from '../../src/plant/tickerPlant.js';
import { materialiseCalendar } from '../../src/refdata/calendars.js';
import { seedLicences } from '../../src/seed/licences.js';
import {
  buildStartupUniverseSnapshot,
  CAPTURED_COLLATION,
  checkCollation,
  checkFunctionRegistry,
  DEFERRED_STARTUP_STEPS,
  FieldLicenceUnknownFieldError,
  FunctionRegistryMismatchError,
  loadCalendars,
  runStartupSteps,
  validateFieldLicences,
} from '../../src/startup.js';
import { testClock } from '../../src/test/clock.js';
import { testDatabaseUrl, withTxDb, type TestDb } from '../../src/test/db.js';

const t: TestDb = withTxDb();
const clock = testClock();

/** The year the calendar window is centred on, pinned so the materialisation matches the diff. */
const CALENDAR_YEAR = 2026;

/** The nine rule calendars `core/calendars/*` registers, ascending — `seed/universe.ts`'s list. */
const RULE_CALENDAR_IDS = [
  'FX_USD',
  'SIFMA',
  'TARGET2',
  'USGOVT',
  'WEEKEND',
  'XCBO',
  'XLON',
  'XNAS',
  'XNYS',
];

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app !== undefined) {
    await app.wsGateway.close();
    await app.close();
    app = undefined;
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 3 — the field dictionary and its field-id validation
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The collation check, which exists because the suite had an undocumented dependency on one.
 *
 * Developed entirely against a cluster whose `initdb` chose `datcollate = C`. Run against an
 * `en_US.UTF-8` cluster, exactly one assertion of 6,214 failed — a locale-aware collation weights the
 * underscore differently, so `NGDP_RPCH` sorts after `NGDPDPC` under `C` and before `NGDPD` under
 * `en_US.UTF-8`. One failure was luck: real field ids are underscore-heavy and reorder completely
 * between the two.
 *
 * This asserts the REPORT rather than a particular verdict, because the verdict depends on the
 * cluster the suite is running against and both answers are legitimate. What must hold either way is
 * that the collation is read from the database and that a mismatch carries the remedy.
 */
describe('startup step 3 — the cluster collation', () => {
  it('reads the collation off the connected database and says whether it matches the captures', async () => {
    const report = await checkCollation(t.db);

    // Read a second way, through the raw client, so the report is not merely self-consistent — the
    // same rule this file applies to step 3's field-licence count below.
    const actual = await t.client.query<{ datcollate: string }>(
      `SELECT datcollate FROM pg_database WHERE datname = current_database()`,
    );
    expect(report.collate).toBe(actual.rows[0]?.datcollate);
    expect(report.matchesCapture).toBe(report.collate === CAPTURED_COLLATION);
  });

  it('carries the remedy on a mismatch, and nothing on a match', async () => {
    const report = await checkCollation(t.db);
    if (report.matchesCapture) {
      expect(report.warning).toBeUndefined();
      return;
    }
    // The warning has to be actionable: it names what was found, what was expected, and the one
    // statement that fixes it. A warning that only says "collation differs" would send a reader to
    // the source to find out what to do.
    expect(report.warning).toContain(report.collate);
    expect(report.warning).toContain(CAPTURED_COLLATION);
    expect(report.warning).toContain("LOCALE 'C' TEMPLATE template0");
  });
});

describe('startup step 3 — the field dictionary and its field-id validation', () => {
  it('accepts the database this build ships with, and counts what it read', async () => {
    const report = await validateFieldLicences(t.db);

    // Counted a second way, in SQL, so the report is not merely self-consistent.
    const rows = await t.client.query<{ n: string }>(`SELECT count(*) AS n FROM field_licence`);
    const ids = await t.client.query<{ field_id: string }>(
      `SELECT DISTINCT field_id FROM field_licence`,
    );
    const licensed = new Set(ids.rows.map((row) => row.field_id));

    expect(report.fieldLicences).toBe(Number(rows.rows[0]!.n));
    expect(report.fieldLicences).toBeGreaterThan(0);
    expect(report.fieldIds).toBe(licensed.size);
    expect(report.fields).toBe(fieldDefs.length);

    // The converse is NOT an error and is reported as a number: ARCHITECTURE step 3 validates one
    // direction, and this build genuinely has dictionary fields with no licence row. Counted from the
    // database, like everything above, so the figure is this database's and not a transcription — an
    // earlier version of this comment said the export census in `test/parity/fn-parity.test.ts`
    // "names twenty of them", which was two mistakes in one sentence: that census counts refused
    // EXPORTS (eighteen, over 71 `(field, asset class)` pairs naming 38 field ids), which is a
    // different quantity, and the number here is 32. See `src/startup.ts`'s note on this field.
    expect(report.fieldsWithoutLicence).toBe(
      fieldDefs.filter((def) => !licensed.has(def.id)).length,
    );
    // Pinned as a literal as well as derived, so that a dictionary or seed change which moves it is
    // a failure that names the new number rather than a silent re-derivation. The derivation above is
    // what makes this honest: the two agree or the test is red.
    expect(report.fieldsWithoutLicence).toBe(32);
  });

  it('refuses to boot on a field_licence row naming a field the dictionary does not have', async () => {
    const source = await t.client.query<{ source_id: string }>(
      `SELECT source_id FROM licence_registry ORDER BY source_id LIMIT 1`,
    );
    expect(source.rows.length, 'no licence_registry row to hang the bad row on').toBe(1);

    // `field_licence` has no foreign key to anything field-shaped — only `assert_source_known` on
    // `source_id` — so the database accepts this row happily and startup step 3 is the only thing
    // in the system that does not. That is the whole reason the step exists.
    await t.client.query(
      `INSERT INTO field_licence (field_id, asset_class, source_id, field_class)
       VALUES ($1, 'equity', $2, 'price')`,
      ['PX_NOT_A_FIELD', source.rows[0]!.source_id],
    );

    await expect(validateFieldLicences(t.db)).rejects.toBeInstanceOf(FieldLicenceUnknownFieldError);
    await expect(validateFieldLicences(t.db)).rejects.toThrow('PX_NOT_A_FIELD');
  });

  it('hands the function surface the registry it loaded rather than letting it build a second', async () => {
    const principal = await functionCaller();
    const registry = licenceRegistry({ db: t.db, clock });
    await registry.reload();
    expect(registry.stats().loads).toBe(1);
    expect(registry.stats().freshChecks).toBe(0);

    app = await appWith({ plant: 'started', entitlements: 'real', functions: { licences: registry } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/functions/HELP/run',
      headers: { cookie: principal.cookie, 'x-requested-with': 'terminal' },
      payload: { params: {}, asOf: { validAt: principal.validAt, knownAt: principal.knownAt } },
    });
    expect(res.statusCode, res.payload).toBe(200);

    // `http/routes/functions.ts#licencesFor` calls `refreshIfStale()` on an injected registry and
    // memoises a NEW one per `AppDeps` when none is injected. So a counter that moved is proof the
    // run used *this* snapshot: whether the version had moved (a `load`) or not (a `freshCheck`),
    // one of the two had to tick. Without the member both stay where `reload()` left them, and the
    // process holds two snapshots of `licence_registry`, `field_licence` and `entitlement_grants`
    // refreshing on two schedules — with startup step 3's field-id check applied to one of them.
    const after = registry.stats();
    expect(after.loads + after.freshChecks).toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 4 — calendars, and the gen-function-index consistency check
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('startup step 4 — calendars', () => {
  it('names the calendars the database does not hold rather than failing on them', async () => {
    const report = await loadCalendars(t.db, clock, { year: CALENDAR_YEAR });

    // This database holds no calendar rows until something materialises one, and that is a
    // legitimate state for a process that is about to be seeded.
    expect(report.loaded).toEqual([]);
    expect(report.absent).toEqual(RULE_CALENDAR_IDS);
    expect(report.disagreements).toEqual([]);
    expect([report.fromYear, report.toYear]).toEqual([CALENDAR_YEAR - 1, CALENDAR_YEAR + 1]);
  });

  it('loads a materialised calendar and finds it agreeing with its rule generator', async () => {
    await materialiseCalendar(t.db, XNYS, {
      fromYear: CALENDAR_YEAR - 1,
      toYear: CALENDAR_YEAR + 1,
    });

    const report = await loadCalendars(t.db, clock, { year: CALENDAR_YEAR });
    expect(report.loaded).toEqual(['XNYS']);
    expect(report.absent).toEqual(RULE_CALENDAR_IDS.filter((id) => id !== 'XNYS'));
    expect(report.disagreements).toEqual([]);
  });

  it('reports the exact day on which the rows and the rule disagree', async () => {
    await materialiseCalendar(t.db, XNYS, {
      fromYear: CALENDAR_YEAR - 1,
      toYear: CALENDAR_YEAR + 1,
    });

    // One holiday missing from the rows is the shape of the real failure: the plant decides
    // sessions from the code calendar and would call the exchange open on a day every screen that
    // reads the rows calls it shut.
    const holiday = XNYS.holidays(CALENDAR_YEAR, CALENDAR_YEAR)[0];
    expect(holiday, 'XNYS has no holiday in the window').toBeDefined();
    await t.client.query(`DELETE FROM calendar_holidays WHERE calendar_id = 'XNYS' AND day = $1`, [
      holiday!.day,
    ]);

    const report = await loadCalendars(t.db, clock, { year: CALENDAR_YEAR });
    expect(report.loaded).toEqual(['XNYS']);
    expect(report.disagreements).toHaveLength(1);
    expect(report.disagreements[0]!.calendarId).toBe('XNYS');
    expect(report.disagreements[0]!.days).toContain(holiday!.day);
  });
});

describe('startup step 4 — the gen-function-index consistency check', () => {
  it('passes over the catalogue and the resolver barrel this build actually ships', () => {
    const report = checkFunctionRegistry();
    expect(report.manifests).toBe(productionRegistry.all().length);
    expect(report.modules).toBe(Object.keys(functionModules).length);
    expect(report.manifests).toBeGreaterThan(0);
    expect(report.registryVersion).toBe(productionRegistry.version);
  });

  it('refuses a manifest with no server module', () => {
    // Real manifests out of the shipped catalogue, and a barrel missing one of them.
    const des = productionRegistry.get('DES');
    const gp = productionRegistry.get('GP');
    expect(des, 'DES is not in the catalogue').toBeDefined();
    expect(gp, 'GP is not in the catalogue').toBeDefined();
    const registry = new FunctionRegistry([des!, gp!]);

    let thrown: unknown;
    try {
      checkFunctionRegistry({ registry, modules: { DES: functionModules.DES } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FunctionRegistryMismatchError);
    expect((thrown as FunctionRegistryMismatchError).manifestsWithoutModule).toEqual(['GP']);
    expect((thrown as Error).message).toContain('answers 500');
  });

  it('refuses a server module with no manifest', () => {
    const registry = new FunctionRegistry([productionRegistry.get('DES')!]);

    let thrown: unknown;
    try {
      checkFunctionRegistry({
        registry,
        modules: { DES: functionModules.DES, ZZZ: functionModules.DES },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FunctionRegistryMismatchError);
    expect((thrown as FunctionRegistryMismatchError).modulesWithoutManifest).toEqual(['ZZZ']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 5 — the universe search snapshot and its ETag
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('startup step 5 — the universe search snapshot and its ETag', () => {
  it('builds the payload once at startup and serves those same bytes to the route', async () => {
    const built = await buildStartupUniverseSnapshot({ db: t.db, clock });

    // The build happened here, not on a request: one build, and nothing has read it yet.
    expect(built.cache.stats().builds).toBe(1);
    expect(built.cache.stats().hits).toBe(0);
    expect(built.etag).toBe(`"${built.version}"`);
    expect(built.bytes).toBeGreaterThan(0);
    expect(built.functions).toBe(productionRegistry.all().length);

    // The route reads `AppDeps.universe.snapshot`, which is where `index.ts` puts this build.
    // Serving it must not rebuild: a second build would mean the first caller paid the
    // whole-universe scan, which is exactly what doing this at startup avoids.
    app = await appWith({ universe: { snapshot: built.cache } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/universe/snapshot',
      headers: { cookie: await webSessionCookie() },
    });
    expect(res.statusCode, res.payload).toBe(200);
    expect(res.headers.etag).toBe(built.etag);
    expect(built.cache.stats().builds).toBe(1);
    expect(built.cache.stats().hits).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Steps 3, 4, 5 in order, and what is still deferred
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the startup sequence', () => {
  it('runs steps 3, 4 and 5 and defers exactly step 8', async () => {
    const report = await runStartupSteps({ db: t.db, clock, calendarYear: CALENDAR_YEAR });

    expect(report.fields.fieldLicences).toBeGreaterThan(0);
    expect(report.functions.manifests).toBe(productionRegistry.all().length);
    expect(report.universe.bytes).toBeGreaterThan(0);

    // The instrument that stops a skip coming back: a step wired today cannot become a deferral
    // again without turning this red, and a step wired tomorrow has to be deleted from the list.
    // Step 9 left this list when the usage-event writer was wired — see the block below.
    expect(report.deferred.map((d) => d.step)).toEqual([8]);
    expect(report.deferred).toBe(DEFERRED_STARTUP_STEPS);
    for (const deferred of report.deferred) {
      // A work-package name is not a reason any more: all fifteen are merged, so "waiting for
      // WP-07" would be a way of not saying anything.
      expect(deferred.blockedBy, `step ${String(deferred.step)}`).not.toMatch(/WP-\d\d/);
      expect(deferred.blockedBy.length).toBeGreaterThan(20);
      // Nor is another deferred step a reason: step 9 was once recorded as "blocked by step 8",
      // which read as a dependency and was really an assumption — two of its three clauses were
      // already running and the third needed no scheduler at all.
      expect(deferred.blockedBy, `step ${String(deferred.step)}`).not.toMatch(/startup step \d/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 9 — the usage-event writer on `AppDeps.functions`
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('startup step 9 — the usage-event writer the function surface writes through', () => {
  /**
   * FUNC-04's first row, through the shipped route. `HELP` is the subject because it is the one
   * tier-1 function that needs no instrument and no market data — the launch is what is being
   * asserted, not the payload — and it is read out of the **production** catalogue, not a
   * hand-built one, because the point is what `index.ts` wires rather than what a test can wire.
   */
  it('writes one fn.launch row per run when the writer is on deps.functions, and none without it', async () => {
    const principal = await functionCaller();
    const writer = usageEvents({ db: t.db, clock });

    // Wired exactly as `index.ts` wires it: the writer and the startup licence registry, nothing
    // else. `registry` and `modules` default to the generated catalogue and barrel.
    app = await appWith({
      plant: 'started',
      entitlements: 'real',
      functions: { usageEvents: writer, licences: licenceRegistry({ db: t.db, clock }) },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/functions/HELP/run',
      headers: { cookie: principal.cookie, 'x-requested-with': 'terminal' },
      payload: { params: {}, asOf: { validAt: principal.validAt, knownAt: principal.knownAt } },
    });
    expect(res.statusCode, res.payload).toBe(200);

    // `enqueue` never awaits (that is the whole shape of the writer), so the row is buffered when
    // the response is served and reaches Postgres on the flush. One row, buffered, before any
    // flush: the run produced it, not the flush.
    expect(writer.size()).toBe(1);
    expect(await countLaunches(principal.userId)).toBe(0);
    expect(await writer.flush()).toBe(1);

    const rows = await t.client.query<{
      kind: string;
      code: string | null;
      params_hash: string | null;
      duration_ms: number | null;
      firm_id: string;
    }>(
      `SELECT kind, code, params_hash, duration_ms, firm_id::text AS firm_id
         FROM usage_events WHERE user_id = $1`,
      [principal.userId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.kind).toBe('fn.launch');
    expect(rows.rows[0]!.code).toBe('HELP');
    // The runner hashes the params it *resolved*, not the ones the caller sent: this request sent
    // `{}` and `HELP`'s manifest defaults `view` to `'index'` (core/functions/manifests/HELP.ts
    // L45), so the hash is of `{view:'index'}`. That is what makes ARCHITECTURE §11's roadmap query
    // able to group launches by parameter set at all — a caller who omits a parameter and one who
    // sends its default have asked for the same screen and must land in the same group.
    expect(rows.rows[0]!.params_hash).toBe(paramsHash({ view: 'index' }));
    expect(rows.rows[0]!.params_hash).not.toBe(paramsHash({}));
    expect(rows.rows[0]!.duration_ms).not.toBeNull();
    expect(rows.rows[0]!.firm_id).toBe(String(principal.firmId));

    // ── and the state the process was in before step 9 was wired ───────────────────────────────
    //
    // The same route, the same caller, the same catalogue, with `usageEvents` absent from
    // `deps.functions`: `functions/runner.ts#logUsage` returns on its first line and FUNC-04's
    // accounting is silently lost. Kept as an assertion because it is the defect this step closes,
    // and because it is what makes the half above a test of the wiring rather than of the writer.
    await app.wsGateway.close();
    await app.close();
    app = await appWith({ plant: 'started', entitlements: 'real' });

    const unwired = await app.inject({
      method: 'POST',
      url: '/api/v1/functions/HELP/run',
      headers: { cookie: principal.cookie, 'x-requested-with': 'terminal' },
      payload: { params: {}, asOf: { validAt: principal.validAt, knownAt: principal.knownAt } },
    });
    expect(unwired.statusCode, unwired.payload).toBe(200);
    expect(await countLaunches(principal.userId)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `GET /health` — the fields, not the verdict
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('GET /health reports which step is missing, not just that one is', () => {
  it('is `degraded` because `scheduler` is false and for no other reason', async () => {
    app = await appWith({ state: { phase: 'degraded', scheduler: false }, plant: 'started' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode, res.payload).toBe(200);
    const body = HealthResponse.parse(JSON.parse(res.payload));

    // Every conjunct against what it is supposed to be. `scheduler` is the one that is false, and
    // it is false because startup step 8 is deferred.
    expect(body.db).toBe(true);
    expect(body.plant).toBe(true);
    expect(body.migrationsPending).toBe(0);
    expect(body.scheduler).toBe(false);
    expect(body.status).toBe('degraded');
  });

  it('is `ok` once step 8 sets `scheduler`, with the same plant and database', async () => {
    app = await appWith({ state: { phase: 'ok', scheduler: true }, plant: 'started' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    const body = HealthResponse.parse(JSON.parse(res.payload));
    expect(body.db).toBe(true);
    expect(body.plant).toBe(true);
    expect(body.scheduler).toBe(true);
    expect(body.status).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The shipped entry point, booted
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The only block that covers `src/index.ts` itself. It spawns the real entry point — the same
 * command `packages/e2e/fixtures/serverProcess.ts` uses — reads `/api/v1/health` over HTTP, and
 * checks the startup log for a step that has come back as a skip.
 *
 * Safe beside the rest of the integration suite because step 8 is deferred: with no scheduler and no
 * request that reaches the entitlement evaluator, this process writes no row to the shared test
 * database. Step 9's two writers are armed, and write nothing: both are buffers, and a buffer that
 * nothing enqueued flushes nothing — `/health` is public and reaches neither the evaluator nor the
 * function runner. **If step 8 is ever wired, this block must move to its own database first** — one
 * ingest tick writes `ingest_runs`, `provenance` and `quote_ticks`, and ~145 tests here assert what
 * their own job inserted into an empty table.
 */
describe('the shipped entry point, booted', () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let output = '';

  afterEach(async () => {
    if (child !== undefined) await stopChild(child);
    child = undefined;
    output = '';
  });

  it('answers /health with the specific field that is missing, and exits 0 on SIGTERM', async () => {
    // A scheduler, or a writer whose flush timer is not `unref`'d, is how a suite stops exiting on
    // its own. `stopChild` asserts the exit code below, and the 10 s SIGKILL fallback would turn a
    // held handle into a non-zero code rather than a hang.
    const port = await freePort();
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    child = spawn('npx', ['tsx', 'packages/server/src/index.ts'], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
        // `DATABASE_URL` carries no user (`postgres://localhost:5432/bloomberg_test`), and `pg`
        // falls back to `PGUSER ?? USER` for it exactly as libpq does. A child with neither fails
        // with `no PostgreSQL user name specified in startup packet`, which is a harness fault and
        // nothing to do with the code under test.
        ...(process.env.USER === undefined ? {} : { USER: process.env.USER }),
        ...(process.env.PGUSER === undefined ? {} : { PGUSER: process.env.PGUSER }),
        ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
        NODE_ENV: 'test',
        PROVIDER_MODE: 'replay',
        DATABASE_URL: testDatabaseUrl(),
        DATABASE_URL_TEST: testDatabaseUrl(),
        REPLAY_DIR: './fixtures/providers',
        PORT: String(port),
        LOG_LEVEL: 'info',
        SEC_USER_AGENT: 'terminal-startup-test (test@demo.invalid)',
        SESSION_SECRET: 'startup-test-secret-not-for-production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });

    const body = await awaitHealth(
      `http://127.0.0.1:${String(port)}/api/v1/health`,
      child,
      () => output,
    );

    // The fields, from the real process, each against what it is supposed to be.
    expect(body.db, output).toBe(true);
    expect(body.plant, output).toBe(true);
    expect(body.migrationsPending, output).toBe(0);
    expect(body.scheduler, output).toBe(false);
    expect(body.status, output).toBe('degraded');

    // Steps 3, 4, 5 and 9 ran, and none of them came back as a deferral. The log message is the
    // instrument: a step that regresses to a skip logs `startup step N deferred`.
    expect(output).toContain('every field_licence.field_id resolves');
    expect(output).toContain('every function manifest has a server module');
    expect(output).toContain('universe search snapshot built');

    // Step 5's member, as the *composed* `AppDeps` carries it. The step-5 case above hands the cache
    // to `appWith` itself, so it cannot tell whether `index.ts` wires it — and with the member
    // deleted every other assertion in this file stayed green while the first caller of
    // `GET /universe/snapshot` went back to paying the scan inside their own request. `builds: 1`
    // says the routes hold the build this step awaited; `hits: 0` says nothing has served it yet.
    const step5 = startupRecord(output, 5);
    const snapshot = step5.snapshot as { builds?: number; hits?: number } | undefined;
    expect(snapshot, `index.ts no longer puts the step-5 cache on AppDeps.universe:\n${output}`)
      .toBeDefined();
    expect(snapshot?.builds, output).toBe(1);
    expect(snapshot?.hits, output).toBe(0);
    expect(step5.functions, output).toBe(productionRegistry.all().length);
    expect(step5.etag, output).toBe(`"${String(step5.version)}"`);
    // Step 9's writer, and step 3's registry, as the *composed* `AppDeps` carries them — the two
    // members `index.ts` adds to `deps.functions`, read back off `app.deps` by the log line itself.
    // This is the only assertion in the suite that can tell a deleted member from a kept one, since
    // the half of step 9 that writes rows needs an authenticated run and this child has no session.
    expect(output).toContain('access-log and usage-event writers started');
    expect(output).toContain('"functionDeps":["licences","usageEvents"]');
    for (const step of [3, 4, 5, 6, 7, 9]) {
      expect(output, `step ${String(step)} must not be deferred`).not.toContain(
        `startup step ${String(step)} deferred`,
      );
    }
    expect(output).toContain('startup step 8 deferred');

    const code = await stopChild(child);
    child = undefined;
    expect(code, output).toBe(0);
  }, 90_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface AppWithOptions {
  readonly state?: Partial<ServerState>;
  readonly universe?: AppDeps['universe'];
  /** `'started'` warms the plant against this test's handle so `plant.ready()` is honestly true. */
  readonly plant?: 'started';
  /** `'real'` is `entitlements/evaluator.ts` over this test's handle, as `index.ts` wires it. */
  readonly entitlements?: 'real';
  /** The `FunctionRouteDeps` overrides `index.ts` sets; every other member keeps its default. */
  readonly functions?: AppDeps['functions'];
}

/**
 * The real `buildApp` over this file's transaction. Built here rather than through
 * `src/test/app.ts#createTestApp` because these cases need `AppDeps.universe` — the member startup
 * step 5 populates — and the harness has no seam for it.
 */
async function appWith(options: AppWithOptions = {}): Promise<FastifyInstance> {
  const config = getConfig();
  let plant: Plant = buildPlant({ config, clock, db: t.db });
  if (options.plant === 'started') {
    plant = buildPlant({ config, clock, db: t.db });
    await plant.start();
  }
  const state: ServerState = {
    phase: 'ok',
    startedAtMs: clock.now(),
    migrationsPending: 0,
    scheduler: true,
    ...options.state,
  };
  const deps: AppDeps = {
    config,
    clock,
    db: t.db,
    plant,
    state,
    ...(options.universe === undefined ? {} : { universe: options.universe }),
    ...(options.entitlements === undefined
      ? {}
      : {
          entitlements: evaluator({
            db: t.db,
            clock,
            registry: licenceRegistry({ db: t.db, clock }),
            quotas: quotas({ db: t.db, clock }),
          }),
        }),
    ...(options.functions === undefined ? {} : { functions: options.functions }),
  };
  const built = buildApp(deps, { logger: false });
  await built.ready();
  return built;
}

/** What one `HELP` run needs: a firm, a user, a web session and the two `asOf` instants. */
interface FunctionCaller {
  readonly userId: number;
  readonly firmId: number;
  readonly cookie: string;
  readonly validAt: string;
  readonly knownAt: string;
}

/**
 * A caller the function surface will serve: a firm, a `user`-role user, and a web session.
 *
 * **No `entitlement_grants` row**, deliberately. `HELP` documents the terminal and declares no
 * protected field, so it is served to a user with no grant at all — which is what makes it the
 * cheapest honest subject for this step and keeps this file out of the shared reference tables
 * whose insert *order* is what deadlocks `server-int` files against each other (see
 * `vitest.config.ts`'s note on the `server-serial` project). A function that needed grants would
 * put this file in the wrong project, for a row that is not the subject.
 *
 * `knownAt` is read from the database clock, not from the virtual one: the rows above are stamped
 * `tx_from = now()` by the schema, and a `knownAt` in the virtual clock's past would not see them
 * (DATA_MODEL §3's bitemporal read). `validAt` is the virtual clock's instant, which is what the
 * rest of this file uses.
 */
async function functionCaller(): Promise<FunctionCaller> {
  const present = await t.client.query(
    `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
  );
  if (present.rowCount === 0) await seedLicences(t.client);

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Startup Step 9 Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'Startup Step 9 User', 'user') RETURNING user_id`,
    [firmId, `startup9-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  return {
    userId,
    firmId,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    validAt: new Date(clock.now()).toISOString(),
    knownAt: new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString(),
  };
}

/** `usage_events` rows this user's runs produced. Counted in SQL, never from the writer's stats. */
async function countLaunches(userId: number): Promise<number> {
  const res = await t.client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM usage_events WHERE user_id = $1 AND kind = 'fn.launch'`,
    [userId],
  );
  return Number(res.rows[0]!.n);
}

/** A web session for the routes that require one. */
async function webSessionCookie(): Promise<string> {
  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Startup Firm ${randomUUID().slice(0, 8)}`],
  );
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'Startup User', 'user') RETURNING user_id`,
    [Number(firm.rows[0]!.firm_id), `startup-${randomUUID()}@demo.invalid`],
  );
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [Number(user.rows[0]!.user_id), createHash('sha256').update(token, 'utf8').digest()],
  );
  return `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`;
}

/**
 * One startup log record out of the child's stdout, by its `step` field.
 *
 * Parsed rather than string-matched because the fields are the subject: `toContain` on a serialised
 * fragment would also pass for a number that moved and fail for a key order that did not, and the
 * point of these records is that a deleted `AppDeps` member shows up as a missing field.
 */
function startupRecord(output: string, step: number): Record<string, unknown> {
  const records = output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line): unknown => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(
      (parsed): parsed is Record<string, unknown> =>
        typeof parsed === 'object' && parsed !== null && (parsed as { step?: number }).step === step,
    );
  expect(records, `exactly one step ${String(step)} record:\n${output}`).toHaveLength(1);
  return records[0]!;
}

/** A port nothing is listening on right now; the child is spawned onto it immediately. */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('could not obtain a free port'));
      });
    });
  });
}

/** Poll `/health` until it answers, failing with the child's own output if it dies first. */
async function awaitHealth(
  url: string,
  child: ChildProcessWithoutNullStreams,
  output: () => string,
): Promise<HealthResponse> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the server exited (code ${String(child.exitCode)}):\n${output()}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.status === 200) return HealthResponse.parse(await res.json());
    } catch {
      // Not listening yet.
    }
    await delay(250);
  }
  throw new Error(`the server never answered ${url}:\n${output()}`);
}

/** SIGTERM, then SIGKILL after 10 s; resolves with the exit code. */
async function stopChild(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
  child.kill('SIGTERM');
  const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    return await exited;
  } finally {
    clearTimeout(killer);
  }
}
