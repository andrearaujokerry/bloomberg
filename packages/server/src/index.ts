/**
 * Process entry — the startup order of ARCHITECTURE §12.1 (L1241-1255).
 *
 * ```
 * 1  config.ts parses env (fail fast on DATABASE_URL, SEC_USER_AGENT, SESSION_SECRET)
 * 2  db/client.ts connects; pending migrations → exit 1 with the list
 * 3  load licence_registry + field_licence; load the field dictionary; validate every field id
 * 4  load calendars and the function registry; gen-function-index consistency check
 * 5  build the universe search snapshot and its ETag
 * 6  warm the plant from the latest quote_snapshots, every subject `stale` until a poll succeeds
 * 7  start the WS gateway and the HTTP listener; /api/v1/health returns `starting`
 * 8  acquire the ingest leader lock, start the scheduler; then /health returns `ok`
 * 9  start the access-log, usage-event and DQ writers and the 1 s staleness sweep
 * ```
 *
 * Steps 3, 4 and 5 are performed here, through `startup.ts` — which is a separate module for one
 * reason worth stating: this file executes on import, so nothing in a test can call it, and for
 * fourteen work packages those three steps were skipped behind a log line no test could see.
 *
 * Step 9 is performed here too, in two places: `log.start()` and `usage.start()` after the listener
 * (its two buffered writers), and `ws/gateway.ts`'s `sweepMs` timer, which has armed the 1 s
 * staleness sweep since WP-06 and is the sweep TERM-12 asks for. The skip line that used to claim
 * step 9 was waiting for WP-08/WP-13 was wrong about the sweep and right about the writers: the
 * access-log writer was started and the usage-event writer was not, so every `fn.launch`,
 * `fn.param`, `fn.page`, `fn.export` and `fn.help` row FUNC-04 specifies was dropped on the floor
 * by `functions/runner.ts#logUsage`, which returns on its first line when no writer is wired.
 *
 * Step 8 is still **deferred**, and no longer for lack of code: the lock, the scheduler and all 26
 * jobs are merged and compose. `startup.ts#DEFERRED_STARTUP_STEPS` carries the three measured
 * reasons, each of which is a decision reaching outside this file, and `/health` reports the
 * consequence truthfully — `scheduler: false`, hence `degraded`. The old version of this list named
 * a work package per step; all five of those packages are merged, so it had stopped saying anything.
 *
 * Shutdown (SIGTERM, ARCHITECTURE L1253): stop the scheduler, release the leader lock, `bye 1001`
 * to every WS session, flush the access-log and usage buffers, drain the pool, exit. Both buffers
 * are flushed after the sockets close and before `closeDb()`, which is the only window in which a
 * buffered row can still reach Postgres.
 */

import { SystemClock } from '@terminal/core';

import { attachAlertEngine } from './alerts/engine.js';
import { buildApp, type AppDeps, type ServerState } from './app.js';
import { ConfigError, getConfig } from './config.js';
import { closeDb, connectDb, pendingMigrations, withTx } from './db/client.js';
import { accessLog } from './entitlements/accessLog.js';
import { evaluator } from './entitlements/evaluator.js';
import { licenceRegistry } from './entitlements/licenceRegistry.js';
import { quotas } from './entitlements/quotas.js';
import { usageEvents } from './observability/usageEvents.js';
import { buildPlant } from './plant/tickerPlant.js';
import {
  buildStartupUniverseSnapshot,
  checkFunctionRegistry,
  DEFERRED_STARTUP_STEPS,
  loadCalendars,
  validateFieldLicences,
} from './startup.js';

async function main(): Promise<void> {
  const clock = new SystemClock();

  // ── 1. Environment ─────────────────────────────────────────────────────────────────────────
  const config = getConfig();

  const state: ServerState = {
    phase: 'starting',
    startedAtMs: clock.now(),
    migrationsPending: 0,
    scheduler: false,
  };

  // ── 2. Database ────────────────────────────────────────────────────────────────────────────
  const db = await connectDb(config);
  const pending = await pendingMigrations();
  state.migrationsPending = pending.length;
  if (pending.length > 0) {
    process.stderr.write(
      `${pending.length} pending migration(s); run \`npm run db:migrate\`:\n` +
        pending.map((name) => `  - ${name}\n`).join(''),
    );
    await closeDb();
    process.exitCode = 1;
    return;
  }

  // ── 3. Entitlements and the field dictionary ────────────────────────────────────────────────
  //
  // The registry is loaded before anything can serve a field: an evaluator over an empty snapshot
  // would answer `FIELD_UNKNOWN` for every request, which is fail-closed but wrong. `reload()` is
  // awaited here so the process refuses to listen rather than serve from an empty registry;
  // afterwards `refreshIfStale()` on each evaluation keeps it current through the
  // `config_versions` bumps (ARCHITECTURE §10 rule 10).
  const registry = licenceRegistry({ db, clock });
  await registry.reload();
  const log = accessLog({ db, clock });
  const quotaService = quotas({ db, clock });
  const entitlements = evaluator({ db, clock, registry, log, quotas: quotaService });

  // Step 9's second buffered writer, constructed here beside the access log because the two have
  // one lifecycle and one shape (`observability/usageEvents.ts` mirrors `entitlements/accessLog.ts`
  // deliberately). It is *started* at step 9, below the listener; building it now is what lets it
  // go onto `AppDeps` at step 6.
  const usage = usageEvents({ db, clock });

  // The other half of step 3: every `field_licence.field_id` must be a field the dictionary has.
  // `validateFieldLicences` throws on the first bad row set and the `catch` at the foot of this
  // file exits 1 with the list, which is what ARCHITECTURE §12.1 step 3 asks for verbatim. Nothing
  // in the schema checks this — `field_licence` has no foreign key to anything field-shaped — so
  // this is the only place it is checked at all.
  const fields = await validateFieldLicences(db);

  // ── 4. Calendars and the function registry ──────────────────────────────────────────────────
  //
  // `loadCalendars` reads the nine materialised rule calendars back and compares each with the
  // generator that wrote it; a disagreement is reported below rather than fatal (see
  // `startup.ts`'s header for why data and build artefacts are treated differently).
  // `checkFunctionRegistry` is the `gen-function-index` consistency check and *is* fatal.
  const calendars = await loadCalendars(db, clock);
  const functions = checkFunctionRegistry();

  // ── 5. The universe search snapshot and its ETag ────────────────────────────────────────────
  //
  // Built and awaited here so the first `GET /universe/snapshot` of the process does not pay the
  // whole-universe scan inside somebody's keystroke. The cache goes onto `AppDeps.universe`, which
  // is where `http/routes/universe.ts` and `http/routes/search.ts` both look for it, so the route,
  // the server-side ranker and this build share one payload and one ETag.
  const universe = await buildStartupUniverseSnapshot({ db, clock });

  // ── 6. Plant warm start ─────────────────────────────────────────────────────────────────────
  const plant = buildPlant({ config, clock, db });
  await plant.start();

  // `entitlements` is what retires the WS gateway's fail-closed default (`denyAllEntitlements`,
  // ws/gateway.ts L164-165): with it on `AppDeps`, a `sub` is decided by the real evaluator.
  // `quotas` is what lets `ws/session.ts` read a session's concurrent-subscription ceiling from
  // `quota_limits` instead of assuming the host default (API.md §8).
  const deps: AppDeps = {
    config,
    clock,
    db,
    plant,
    state,
    entitlements,
    quotas: quotaService,
    universe: { snapshot: universe.cache },
    // FUNC-04. `functions/runner.ts#logUsage` returns on its first line when `usageEvents` is
    // absent, so without this member the function surface of a running server wrote no usage row at
    // all and `GET /usage/functions` counted only what a client had posted about itself — which
    // API.md L783 marks `clientReported` precisely because it is not the server's own account.
    //
    // `licences` hands the function surface the registry startup step 3 already loaded and
    // validated. Without it `http/routes/functions.ts#licencesFor` builds a *second*
    // `licenceRegistry` lazily on the first `GO` of the process: two snapshots of the same three
    // tables, refreshing on two schedules, and the step-3 field-id check applied to only one of
    // them. Nothing else on `FunctionRouteDeps` is set here, and every other member has a working
    // default (`http/routes/functions.ts` L107-110).
    functions: { usageEvents: usage, licences: registry },
  };
  const app = buildApp(deps);

  app.log.info(
    { step: 3, ...registry.stats(), ...fields },
    'licence registry and field dictionary loaded; every field_licence.field_id resolves',
  );
  app.log.info(
    {
      step: 4,
      loaded: calendars.loaded.length,
      absent: calendars.absent,
      window: [calendars.fromYear, calendars.toYear],
      ...functions,
    },
    'calendars loaded; every function manifest has a server module',
  );
  if (calendars.absent.length > 0) {
    // Not an error: a database that has not been seeded yet legitimately has no calendar rows, and
    // `data/reference.ts` answers `no calendar '<id>'` rather than guessing.
    app.log.warn(
      { step: 4, absent: calendars.absent },
      'calendars with no rows — run `npm run db:seed`',
    );
  }
  for (const disagreement of calendars.disagreements) {
    // Loud, per calendar, and not fatal. The plant decides sessions from the code calendars while
    // the screens read the rows, so a disagreement means the two halves of the terminal disagree
    // about whether the exchange was open — which has to be seen, but is a data repair, not a
    // reason to refuse every screen.
    app.log.error(
      { step: 4, calendarId: disagreement.calendarId, days: disagreement.days },
      'materialised calendar disagrees with its rule generator',
    );
  }
  app.log.info(
    {
      step: 5,
      version: universe.version,
      etag: universe.etag,
      bytes: universe.bytes,
      instruments: universe.instruments,
      functions: universe.functions,
      people: universe.people,
      topics: universe.topics,
      // Read back off the **composed** `AppDeps`, not off the local `universe`: the member is what a
      // tidy-up can delete, and without it `http/routes/universe.ts#universeCacheFor` builds its own
      // cache lazily, so the first caller of `GET /universe/snapshot` pays the whole-universe scan
      // this step exists to have already paid. `builds: 1, hits: 0` is the proof that the cache the
      // routes hold is the one awaited above and that nothing has read it yet. `startup.test.ts`
      // asserts this field off the booted process, which is the only thing that can tell a wired
      // member from a deleted one — the step-5 case below it hands the cache in itself.
      snapshot: app.deps.universe?.snapshot?.stats(),
    },
    'universe search snapshot built',
  );

  // ── NEWS-07. The alert engine is a sink on the plant's fan-out plus a calendar tick, and it is
  //    constructed here because nowhere else has both the plant and the gateway. Without this the
  //    engine existed only in tests and no alert ever fired in a running server.
  const alerts = attachAlertEngine({
    plant,
    clock,
    gateway: app.wsGateway,
    withTx: (fn) => withTx(null, fn),
    onError: (err, detail) => {
      app.log.error({ err, detail }, 'alert engine');
    },
  });

  for (const { step, what, blockedBy } of DEFERRED_STARTUP_STEPS) {
    app.log.warn(
      { step, blockedBy },
      `startup step ${String(step)} deferred — ${what}; blocked by: ${blockedBy}`,
    );
  }

  // ── 7. Listen ──────────────────────────────────────────────────────────────────────────────
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  // ── 9. The two buffered writers (ENTL-04's access log, FUNC-04's usage events). Armed after ──
  //      the listener, so a request that arrives during startup is still recorded: both buffer from
  //      the first call and the timer only decides when the buffer is drained. Both timers are
  //      `unref`'d by their writer, so neither holds the process open — which is what lets the
  //      integration suite boot this entry point and still exit on its own.
  //
  //      The third clause of step 9, the 1 s staleness sweep, is not armed here: `ws/gateway.ts`
  //      has armed it since WP-06 (`limits.sweepMs` → `plant.sweep(clock.now())`, one sweep for
  //      the whole plant while any session is connected), which is where TERM-12 puts it. It does
  //      not fight the client sweep that landed with the live grid: ARCHITECTURE §13's TERM-12 row
  //      asks for the verdict to be computed by one function (`core/quote/staleness.ts`) on server
  //      and client, and both callers do exactly that over their own copy of the same three
  //      timestamps, so the two cannot disagree unless the copies do.
  log.start();
  usage.start();
  app.log.info(
    {
      step: 9,
      // Read back off the **composed** `AppDeps` the routes were handed, not off the local
      // variables above: the member is what a tidy-up can delete, and this line is the only thing
      // outside the process that can see whether it is there. `startup.test.ts` boots this entry
      // point and asserts these names, so deleting either one turns that test red rather than
      // silently returning the server to the state where FUNC-04 wrote nothing.
      functionDeps: Object.keys(app.deps.functions ?? {}).sort(),
      staleness: 'ws/gateway.ts',
    },
    'access-log and usage-event writers started; staleness sweep armed by the ws gateway',
  );

  // ── 8. Scheduler. Deferred, so nothing sets `state.scheduler` and `/health` answers `degraded`
  //      — which is the truth, and the field that says which truth is `scheduler`, not the verdict.
  state.phase = state.scheduler ? 'ok' : 'degraded';
  app.log.info(
    { port: config.PORT, providerMode: config.PROVIDER_MODE, phase: state.phase },
    'terminal server listening',
  );

  // ── Shutdown ───────────────────────────────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    void (async (): Promise<void> => {
      try {
        // Scheduler stop and leader-lock release go here (WP-07), before sockets close.
        await alerts.stop();
        await app.wsGateway.close();
        await plant.stop();
        await app.close();
        // Nothing can append after the sockets are shut; the final flush writes what is buffered
        // before the pool goes away, and reports anything it could not (ENTL-04, FUNC-04).
        await log.stop();
        const logStats = log.stats();
        if (logStats.dropped > 0) {
          app.log.error(logStats, 'access-log rows abandoned at shutdown');
        }
        await usage.stop();
        const usageStats = usage.stats();
        if (usageStats.dropped > 0) {
          app.log.error(usageStats, 'usage_events rows abandoned at shutdown');
        }
        await closeDb();
        app.log.info('shutdown complete');
        process.exit(0);
      } catch (err) {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('unhandledRejection', (reason) => {
    app.log.fatal({ err: reason }, 'unhandled rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
}

try {
  await main();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`startup failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  }
  await closeDb().catch(() => undefined);
  process.exit(1);
}
