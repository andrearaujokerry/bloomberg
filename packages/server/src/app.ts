/**
 * `buildApp(deps): FastifyInstance` — ARCHITECTURE §3.3 L251, WORKPLAN §1.8 L362-365.
 *
 * **Frozen after WP-01.** Routes and WS handlers are added by dropping files into the globbed
 * directories, not by editing this file: `http/routes/index.ts` is *generated* from
 * `http/routes/**.ts` and registered here under `/api/v1`; the gateway entry point is
 * `ws/gateway.ts`. If a work package needs a change here, it needs a design change first.
 *
 * Registration order matters:
 *  1. `http/trace.ts` — mints `traceId` before anything can log or fail;
 *  2. `http/errors.ts` — the error handler that renders `AppError` → `ErrorEnvelope` with that id;
 *  3. `@fastify/cookie` — session cookies (`tsid`), signed with `SESSION_SECRET`;
 *  4. `/health` at the root, as a liveness alias for probes that cannot know the API prefix;
 *  5. the generated route barrel under `/api/v1` (which contains its own `/api/v1/health`);
 *  6. the WS gateway.
 *
 * Steps 1 and 2 are plain function calls on the root instance rather than `app.register(...)`:
 * Fastify encapsulates plugins, and a hook registered inside a plugin would not apply to sibling
 * plugins. `fastify-plugin` would be the other way to say this, and it is not a dependency of this
 * package.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Clock } from '@terminal/core';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';

import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { registerErrorHandling } from './http/errors.js';
import { registerTrace } from './http/trace.js';
import { healthRoutes } from './http/routes/health.js';
import { metricsPlugin } from './observability/metrics.js';
import type { Plant } from './plant/tickerPlant.js';
import { registerWsGateway, type WsGateway } from './ws/gateway.js';

/** The API prefix every documented route lives under, except `/metrics` (API.md §5.15). */
export const API_PREFIX = '/api/v1';

/**
 * Process-wide liveness state, owned by `index.ts` and read by `GET /health`. It is mutable on
 * purpose: the startup sequence flips fields as it advances through ARCHITECTURE §12.1.
 */
export interface ServerState {
  /** `starting` until startup step 8 completes; `degraded` when a dependency is down. */
  phase: 'starting' | 'ok' | 'degraded';
  /** `clock.now()` at process start, for `uptimeS`. */
  startedAtMs: number;
  /** Migrations on disk that the database has not applied (startup step 2). */
  migrationsPending: number;
  /** True once this process holds the ingest leader lock and the scheduler runs (step 8). */
  scheduler: boolean;
}

/**
 * Everything the HTTP layer needs, injected. Tests build these by hand (`src/test/app.ts`), which
 * is the whole reason `buildApp` takes them rather than reaching for module singletons.
 *
 * Later work packages widen this interface (entitlements, data services, provider registry,
 * result cache). Adding an optional field is not a change to `buildApp`'s contract; removing or
 * renaming one is.
 */
export interface AppDeps {
  config: Config;
  clock: Clock;
  db: Db;
  plant: Plant;
  state: ServerState;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Injected dependencies — the only way a route reaches the database, plant or clock. */
    deps: AppDeps;
    /** The WS gateway handle, so `index.ts` can say `bye 1001` on SIGTERM. */
    wsGateway: WsGateway;
  }
}

/** Module specifier of the generated barrel, kept non-literal: the file may not exist yet. */
const GENERATED_ROUTES_SPECIFIER = './http/routes/index.js';

/**
 * The generated barrel (`scripts/gen-function-index.ts`) exports one namespace per route module
 * plus a `routeModules` map keyed by file name. A route module contributes its Fastify plugin as
 * `default`, as `routes`, or as an export whose name ends in `Routes` (`healthRoutes`).
 */
type RouteModule = Record<string, unknown> & { default?: unknown; routes?: unknown };

type RouteBarrel = {
  /** A barrel that is itself a plugin — accepted, but not what the generator emits today. */
  default?: unknown;
  routes?: unknown;
  registerRoutes?: unknown;
  routeModules?: Record<string, RouteModule>;
};

function pluginOf(mod: RouteModule): FastifyPluginAsync | undefined {
  const direct = mod.default ?? mod.routes;
  if (typeof direct === 'function') return direct as FastifyPluginAsync;
  for (const [name, value] of Object.entries(mod)) {
    if (name.endsWith('Routes') && typeof value === 'function') return value as FastifyPluginAsync;
  }
  return undefined;
}

function generatedBarrelExists(): boolean {
  // Under `tsx` the sibling is `index.ts`; after `tsc -b` it is `index.js`. Check both so the
  // barrel is picked up in dev and in production without a second code path.
  for (const name of ['index.js', 'index.ts']) {
    if (existsSync(fileURLToPath(new URL(`./http/routes/${name}`, import.meta.url)))) return true;
  }
  return false;
}

/**
 * Register `http/routes/index.ts` when `gen-function-index` has produced it. Until WP-08 generates
 * it, the only route is the root `/health` registered below — the server still starts, which is
 * what lets every other work package develop against a running process.
 */
const generatedRoutes: FastifyPluginAsync = async (app) => {
  if (!generatedBarrelExists()) {
    app.log.warn(
      { specifier: GENERATED_ROUTES_SPECIFIER },
      'generated route barrel not present yet — only /health is served (WP-08 generates it)',
    );
    return;
  }
  const specifier: string = GENERATED_ROUTES_SPECIFIER;
  const barrel = (await import(specifier)) as RouteBarrel;

  // Shape 1: the barrel is itself a plugin.
  const whole = barrel.default ?? barrel.routes ?? barrel.registerRoutes;
  if (typeof whole === 'function') {
    await app.register(whole as FastifyPluginAsync);
    return;
  }

  // Shape 2 (what the generator emits): a `routeModules` map of namespaces, one per file.
  const modules = barrel.routeModules;
  if (modules === undefined) {
    throw new TypeError(
      `${GENERATED_ROUTES_SPECIFIER} must export \`routeModules\` (or a Fastify plugin as \`default\`)`,
    );
  }
  for (const [name, mod] of Object.entries(modules)) {
    const plugin = pluginOf(mod);
    if (plugin === undefined) {
      throw new TypeError(
        `http/routes/${name}.ts must export a Fastify plugin as \`default\`, \`routes\` or \`<name>Routes\``,
      );
    }
    await app.register(plugin);
  }
};

export interface BuildAppOptions {
  /** Override the logger (tests pass `false` to silence it). */
  logger?: boolean | { level: string };
}

/**
 * Build the HTTP application. Does not listen: `index.ts` calls `.listen()`, tests call
 * `.inject()` or `.listen(0)`.
 */
export function buildApp(deps: AppDeps, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? { level: deps.config.LOG_LEVEL },
    // The reverse proxy in front of the terminal terminates TLS and sets X-Forwarded-*; the
    // access log and the rate limiter need the real client address.
    trustProxy: true,
    // Uploads (portfolio imports) go through their own multipart route; JSON bodies stay small.
    bodyLimit: 2 * 1024 * 1024,
  });

  app.decorate('deps', deps);

  registerTrace(app);
  registerErrorHandling(app);

  void app.register(cookie, {
    secret: deps.config.SESSION_SECRET,
    parseOptions: { httpOnly: true, sameSite: 'lax', path: '/' },
  });

  // Liveness alias at the root for probes and for `curl localhost:8080/health`; the canonical
  // documented path is `/api/v1/health`, served by the generated barrel.
  void app.register(healthRoutes);
  // `/metrics` at the root: API.md §5.15 puts it outside `/api/v1`, so it cannot come from the
  // generated barrel (which is registered under the prefix). Same special case as `/health` above.
  void app.register(metricsPlugin);
  void app.register(generatedRoutes, { prefix: API_PREFIX });

  const gateway = registerWsGateway(app, {
    config: deps.config,
    clock: deps.clock,
    plant: deps.plant,
  });
  app.decorate('wsGateway', gateway);

  return app;
}
