/**
 * `GET /health` — API.md §5.15 L820, OPS-03. Public: no session, no entitlement, no logging of the
 * caller. Created by WP-01, owned by WP-08 afterwards (WORKPLAN §1.8 L367-369).
 *
 * ```
 * 200 { status: 'starting'|'ok'|'degraded', db, plant, scheduler, migrationsPending, uptimeS }
 * 503 while the process has not reached startup step 8 (ARCHITECTURE §12.1)
 * ```
 *
 * The 503 carries the same body rather than an error envelope: a load balancer needs the *reason*
 * it is being told to wait, and `STARTING` alone does not say whether the database answered or how
 * many migrations are outstanding. Every other error path in the process is an `ErrorEnvelope`.
 *
 * `db` is probed per request (a pool that cannot answer `SELECT 1` is the failure this endpoint
 * exists to catch); `migrationsPending` is the count taken at startup step 2, because migrations
 * cannot appear while the process runs.
 */

import type { FastifyPluginAsync } from 'fastify';

import { pingDb } from '../../db/client.js';

/** The response body of `GET /health` (API.md §5.15). */
export interface HealthResponse {
  status: 'starting' | 'ok' | 'degraded';
  db: boolean;
  plant: boolean;
  scheduler: boolean;
  migrationsPending: number;
  uptimeS: number;
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async (_request, reply): Promise<HealthResponse> => {
    const { state, plant, clock } = app.deps;
    const db = await pingDb();
    const plantReady = plant.ready();

    const status: HealthResponse['status'] =
      state.phase === 'starting'
        ? 'starting'
        : db && plantReady && state.scheduler && state.migrationsPending === 0
          ? 'ok'
          : 'degraded';

    if (status === 'starting') {
      void reply.status(503).header('Retry-After', '2');
    }

    return {
      status,
      db,
      plant: plantReady,
      scheduler: state.scheduler,
      migrationsPending: state.migrationsPending,
      uptimeS: Math.max(0, Math.floor((clock.now() - state.startedAtMs) / 1_000)),
    };
  });

  await Promise.resolve();
};

export default healthRoutes;
