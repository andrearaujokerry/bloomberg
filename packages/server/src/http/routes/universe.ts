/**
 * `http/routes/universe.ts` — `GET /api/v1/universe/snapshot` (API.md §5.2 L438-488, TERM-02),
 * WORKPLAN WP-08 L1076-1078.
 *
 * One route, and it is a *bytes and cache* route. The terminal downloads this payload once, builds
 * a `core/command/index.ts#UniverseIndex` from it in a Worker, and answers every keystroke locally
 * from then on (FUNCTIONS.md §3.1, §3.5). So the handler's job is to hand over the bytes
 * `search/snapshot.ts` already serialized, and to make every repeat request cost nothing:
 *
 *  - **`ETag` is the content hash**, minted by `universeSnapshot()` — not by this route, and not
 *    from `generatedAt`. A client that comes back with `If-None-Match` gets `304` and no body,
 *    across process restarts, because two processes reading the same `instruments` rows produce
 *    the same tag.
 *  - **`Cache-Control: private, max-age=3600`** exactly as §5.2 specifies: private because the
 *    payload is the firm's universe, an hour because `config_versions('universe')` is what really
 *    invalidates it and the ETag revalidation is free.
 *  - **`Content-Encoding: gzip`** when the caller offers it. The payload is multiple megabytes of
 *    highly repetitive JSON tuples; sending it raw to a browser on every universe bump would be
 *    the single largest response the server produces. The compressed buffer is held per snapshot
 *    version alongside the snapshot itself, so the gzip cost is paid once per universe, not once
 *    per client. There is no `@fastify/compress` in this package's dependencies and this route is
 *    the only place that needs it, so it is done here with `node:zlib` rather than by taking a new
 *    dependency for one endpoint.
 *
 * The snapshot cache itself is *shared with `http/routes/search.ts`* through {@link universeCacheFor}:
 * the server-side ranking fallback builds its `UniverseIndex` from the very snapshot this route
 * serves, and two caches would mean two 36 k-row scans and — worse — a window in which the bytes
 * the client indexed and the bytes the server ranked against were different versions.
 */

import { gzipSync } from 'node:zlib';

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { registry as productionRegistry, type FunctionRegistry } from '@terminal/core';

import type { AppDeps } from '../../app.js';
import {
  etagMatches,
  universeSnapshot,
  type UniverseSnapshot,
  type UniverseSnapshotCache,
} from '../../search/snapshot.js';
import { requireSession } from '../auth/session.js';
import { rateLimit, REST_LIMIT } from '../rateLimit.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Optional overrides. Absent, everything is built from `app.deps`. */
export interface UniverseRouteDeps {
  /** The shared snapshot cache. Built from `deps.db`/`deps.clock` when omitted. */
  snapshot?: UniverseSnapshotCache;
  /** The catalogue the `functions` tuples come from; the generated registry when omitted. */
  registry?: FunctionRegistry;
  /** `UniverseSnapshotDeps.freshnessMs` — `0` (probe every request) by default. */
  freshnessMs?: number;
}

declare module '../../app.js' {
  // Optional additions only — `buildApp`'s contract (app.ts L60-64) allows exactly this.
  interface AppDeps {
    /** Overrides for `http/routes/universe.ts` and the snapshot `http/routes/search.ts` shares. */
    universe?: UniverseRouteDeps;
  }
}

/** API.md §5.2: the browser may hold the payload for an hour before it revalidates. */
export const CACHE_CONTROL = 'private, max-age=3600';

/**
 * One snapshot cache per `AppDeps`, so `search.ts` and this module rank and serve the same bytes.
 *
 * Keyed on the deps object rather than on the `FastifyInstance`: a plugin sees an encapsulated
 * child instance, not the root, so instance identity differs between the two route modules while
 * `app.deps` is the same object. A `WeakMap` because a test builds a new app (and new deps) per
 * case and nothing should keep the old universe alive.
 */
const caches = new WeakMap<AppDeps, UniverseSnapshotCache>();

/** The cache this app serves and ranks from, created on first use. */
export function universeCacheFor(app: FastifyInstance): UniverseSnapshotCache {
  const deps = app.deps;
  const override = deps.universe?.snapshot;
  if (override !== undefined) return override;

  const held = caches.get(deps);
  if (held !== undefined) return held;

  const built = universeSnapshot({
    db: deps.db,
    clock: deps.clock,
    registry: deps.universe?.registry ?? productionRegistry,
    ...(deps.universe?.freshnessMs === undefined ? {} : { freshnessMs: deps.universe.freshnessMs }),
  });
  caches.set(deps, built);
  return built;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// gzip, once per universe version
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The compressed body of the snapshot currently held, or `null` before the first gzip. */
let compressed: { version: string; buffer: Buffer } | null = null;

/** True when the caller's `Accept-Encoding` lists gzip (RFC 9110 §12.5.3, `;q=0` excluded). */
export function acceptsGzip(header: string | undefined): boolean {
  if (typeof header !== 'string') return false;
  for (const raw of header.split(',')) {
    const [token, ...params] = raw.trim().split(';');
    const name = (token ?? '').trim().toLowerCase();
    if (name !== 'gzip' && name !== '*') continue;
    const q = params
      .map((p) => p.trim().toLowerCase())
      .find((p) => p.startsWith('q='))
      ?.slice(2);
    if (q !== undefined && Number(q) === 0) continue;
    return true;
  }
  return false;
}

/** `gzipSync(snapshot.body)`, memoised on the snapshot's content hash. */
function gzipFor(snapshot: UniverseSnapshot): Buffer {
  const held = compressed;
  if (held !== null && held.version === snapshot.version) return held.buffer;
  const buffer = gzipSync(Buffer.from(snapshot.body, 'utf8'));
  compressed = { version: snapshot.version, buffer };
  return buffer;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The route
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const universeRoutes: FastifyPluginAsync = async (app) => {
  // `data:read`: the snapshot IS the instrument master in bulk — id, ticker, sector, exchange,
  // name and asset class for every row. An API key minted with an empty scope list reads nothing
  // through `/ref` or `/data`, and must not read the same rows here.
  app.get(
    '/universe/snapshot',
    { preHandler: [requireSession({ scopes: ['data:read'] }), rateLimit(REST_LIMIT)] },
    async (request, reply): Promise<unknown> => {
      const snapshot = await universeCacheFor(app).get();

      void reply
        .header('ETag', snapshot.etag)
        .header('Cache-Control', CACHE_CONTROL)
        .header('Vary', 'Accept-Encoding');

      // RFC 9110 §13.1.2 — the whole point of the content hash. No body, and no gzip cost.
      if (etagMatches(request.headers['if-none-match'], snapshot.etag)) {
        // `reply.send()` (rather than a returned value) so Fastify writes no body at all: a 304
        // with `null` serialised into it is a four-byte body a cache is entitled to be confused by.
        return reply.status(304).send();
      }

      void reply.type('application/json; charset=utf-8');

      if (acceptsGzip(request.headers['accept-encoding'])) {
        const buffer = gzipFor(snapshot);
        void reply.header('Content-Encoding', 'gzip').header('Content-Length', buffer.byteLength);
        return buffer;
      }

      // The string `search/snapshot.ts` serialized at build time — never re-stringified here.
      void reply.header('Content-Length', snapshot.bytes);
      return snapshot.body;
    },
  );

  await Promise.resolve();
};

export default universeRoutes;
