/**
 * App factory for tests — ARCHITECTURE §3.3 L352-353, TESTING.md §10 L814.
 *
 * Builds the real `buildApp` with a `VirtualClock`, the stub plant and whatever database handle the
 * test is using — usually the open transaction from `withTxDb()`, so that a route handler's writes
 * are rolled back with everything else. The app is the production one: no route is stubbed, no
 * plugin is skipped. A test that passes here is a statement about the shipped wiring.
 *
 * Logging is off by default; pass `logger: { level: 'debug' }` when a failure needs the trail.
 */

import type { Clock } from '@terminal/core';
import type { FastifyInstance } from 'fastify';

import { buildApp, type AppDeps, type ServerState } from '../app.js';
import { getConfig, type Config } from '../config.js';
import { getDb, type Db, type Tx } from '../db/client.js';
import { evaluator } from '../entitlements/evaluator.js';
import { licenceRegistry } from '../entitlements/licenceRegistry.js';
import { quotas as buildQuotas, type Quotas } from '../entitlements/quotas.js';
import { buildPlant, type Plant } from '../plant/tickerPlant.js';
import type { WsEntitlements } from '../ws/gateway.js';
import { testClock } from './clock.js';

export interface TestAppOptions {
  /** Database handle routes should use — pass `withTxDb()`'s `db` to keep writes rolled back. */
  db?: Db | Tx;
  /** Defaults to a `VirtualClock` at `TEST_NOW`. */
  clock?: Clock;
  /** Config overrides merged over the parsed environment. */
  config?: Partial<Config>;
  /** Plant override — WP-06 tests pass a real plant driven by a `SimFeed`. */
  plant?: Plant;
  /** Startup-state overrides; defaults to a fully started process. */
  state?: Partial<ServerState>;
  /** Fastify logger option; `false` (silent) by default. */
  logger?: boolean | { level: string };
  /**
   * Entitlement evaluator. Defaults to the **real** one (`entitlements/evaluator.ts`) over the
   * same database handle as the routes, which is what `index.ts` wires in production and what
   * retires the WS gateway's `denyAllEntitlements` fallback. Pass a fake to decide by hand.
   */
  entitlements?: WsEntitlements;
  /**
   * Quota source the default evaluator charges (ARCHITECTURE §10 rule 8). Defaults to the real
   * one over the same handle. Ignored when `entitlements` is supplied.
   */
  quotas?: Quotas;
}

export interface TestApp {
  app: FastifyInstance;
  deps: AppDeps;
  clock: Clock;
  /** Whatever ended up on `deps.entitlements` — the real evaluator unless one was injected. */
  entitlements: WsEntitlements;
  /** The quota source the default evaluator charges; the real one unless one was injected. */
  quotas: Quotas;
  /** Close the app (and its WS gateway). Does not close the database pool. */
  close(): Promise<void>;
}

/**
 * Build an app instance ready for `app.inject(...)`. Call `close()` in `afterEach`/`afterAll`;
 * `await app.ready()` has already been awaited here, so routes and plugins are registered.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const config: Config = { ...getConfig(), ...options.config };
  const clock = options.clock ?? testClock();
  const db = (options.db ?? getDb()) as Db;
  const plant = options.plant ?? buildPlant({ config, clock });

  const state: ServerState = {
    phase: 'ok',
    startedAtMs: clock.now(),
    migrationsPending: 0,
    scheduler: true,
    ...options.state,
  };

  // The real evaluator over the test's own handle: the registry starts empty and loads itself on
  // the first `evaluate()` (`refreshIfStale()` — the `config_versions` version a licence, field
  // licence or grant write bumps is always above the empty snapshot's zero), so building it costs
  // no query here and a test that seeds grants inside its transaction is seen.
  //
  // No `AccessLog` is attached: its buffer is drained by a timer and by `stop()`, neither of which
  // a rolled-back test transaction can honour. A test that asserts on `access_log` builds its own
  // writer (see `test/integration/entitlements/accessLog.test.ts`) and passes the evaluator in.
  const quotaSource = options.quotas ?? buildQuotas({ db, clock });
  const entitlements =
    options.entitlements ??
    evaluator({ db, clock, registry: licenceRegistry({ db, clock }), quotas: quotaSource });

  // The quota source is on `deps` too, so `ws/session.ts` resolves the concurrent-subscription
  // ceiling from `quota_limits` exactly as it does in production (API.md §8).
  const deps: AppDeps = { config, clock, db, plant, state, entitlements, quotas: quotaSource };
  const app = buildApp(deps, { logger: options.logger ?? false });
  await app.ready();

  return {
    app,
    deps,
    clock,
    entitlements,
    quotas: quotaSource,
    close: async (): Promise<void> => {
      await app.wsGateway.close();
      await app.close();
    },
  };
}
