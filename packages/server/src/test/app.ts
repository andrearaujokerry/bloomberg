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
import { buildPlant, type Plant } from '../plant/tickerPlant.js';
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
}

export interface TestApp {
  app: FastifyInstance;
  deps: AppDeps;
  clock: Clock;
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

  const deps: AppDeps = { config, clock, db, plant, state };
  const app = buildApp(deps, { logger: options.logger ?? false });
  await app.ready();

  return {
    app,
    deps,
    clock,
    close: async (): Promise<void> => {
      await app.wsGateway.close();
      await app.close();
    },
  };
}
