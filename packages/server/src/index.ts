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
 * Steps 3, 4, 5, 8 and 9 belong to work packages that have not landed (their modules do not exist
 * yet). They are *not* faked here: each logs that it was skipped and which WP owns it, the numbered
 * order is already in place, and `/health` reports the truth (`scheduler: false`, plant not ready,
 * hence `degraded`). When a WP lands, it fills its step in and deletes the skip line.
 *
 * Shutdown (SIGTERM, ARCHITECTURE L1253): stop the scheduler, release the leader lock, `bye 1001`
 * to every WS session, flush the access-log and usage buffers, drain the pool, exit.
 */

import { SystemClock } from '@terminal/core';

import { buildApp, type AppDeps, type ServerState } from './app.js';
import { ConfigError, getConfig } from './config.js';
import { closeDb, connectDb, pendingMigrations } from './db/client.js';
import { buildPlant } from './plant/tickerPlant.js';

/** Steps whose owning work package has not landed; logged once each, in order. */
const PENDING_STEPS: readonly { step: number; what: string; wp: string }[] = [
  { step: 3, what: 'licence registry, field_licence and the field dictionary', wp: 'WP-03/WP-11' },
  { step: 4, what: 'calendars and the function registry consistency check', wp: 'WP-08' },
  { step: 5, what: 'universe search snapshot and ETag', wp: 'WP-09' },
  { step: 8, what: 'ingest leader lock and scheduler', wp: 'WP-07' },
  {
    step: 9,
    what: 'access-log, usage-event and DQ writers, 1 s staleness sweep',
    wp: 'WP-08/WP-13',
  },
];

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

  // ── 6. Plant warm start (3, 4 and 5 are logged as pending below) ────────────────────────────
  const plant = buildPlant({ config, clock });
  await plant.start();

  const deps: AppDeps = { config, clock, db, plant, state };
  const app = buildApp(deps);

  for (const { step, what, wp } of PENDING_STEPS) {
    app.log.warn({ step, wp }, `startup step ${step} skipped — ${what} (${wp})`);
  }

  // ── 7. Listen ──────────────────────────────────────────────────────────────────────────────
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  // ── 8. Scheduler (WP-07). Until it exists the process is up but degraded, which is the truth. ─
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
        await app.wsGateway.close();
        await plant.stop();
        await app.close();
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
