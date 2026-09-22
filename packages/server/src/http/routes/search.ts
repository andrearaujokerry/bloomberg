/**
 * `http/routes/search.ts` — `GET /api/v1/search` (API.md §5.2 L438-488, TERM-02), WORKPLAN WP-08
 * L1077-1078.
 *
 * The command line ranks **locally**: the browser holds the universe snapshot and answers every
 * keystroke in ≤ 4 ms without a round trip. This route is the fallback the client reaches for when
 * a name query of three characters or more found nothing locally (ARCHITECTURE §5, debounced
 * 60 ms) — and, for an API client (`clientKind: 'api'`) with no local index at all, the only
 * search there is.
 *
 * **The handler contains no ranking.** `search/rank.ts` delegates verbatim to
 * `core/command/rank.ts` over a `UniverseIndex` built from the very bytes
 * `GET /universe/snapshot` serves, which is what makes the server's order and the client's order
 * the same order — asserted element by element in `test/integration/search/fallback.test.ts`. All
 * this file does is parse the query with the normative wire schema, hand it over, and stamp the
 * trace id on the way out.
 *
 * Two things worth being explicit about:
 *
 *  - **The snapshot cache is shared with `universe.ts`** (`universeCacheFor`). Ranking against a
 *    different build from the one the client downloaded is precisely the divergence §5.2 forbids,
 *    and a second cache would also mean a second 36 k-row scan.
 *  - **The ranker is held per app**, because `UniverseIndex.build()` is the O(n) pass FUNCTIONS.md
 *    §3.5 moves off the keystroke path. `searchRanker` rebuilds it only when the snapshot version
 *    moves.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { registry as productionRegistry, type FunctionRegistry } from '@terminal/core';
import { SearchQuery, type SearchResponse } from '@terminal/sdk/wire/rest/search';

import type { AppDeps } from '../../app.js';
import { searchRanker, type SearchRanker, type ServerSearchInput } from '../../search/rank.js';
import { requireSession } from '../auth/session.js';
import { rateLimit, SEARCH_LIMIT } from '../rateLimit.js';
import { ValidationFailedError } from '../errors.js';
import { universeCacheFor } from './universe.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Optional overrides. Absent, the ranker is built over the shared universe snapshot. */
export interface SearchRouteDeps {
  ranker?: SearchRanker;
}

declare module '../../app.js' {
  // Optional additions only — `buildApp`'s contract (app.ts L60-64) allows exactly this.
  interface AppDeps {
    /** Overrides for `http/routes/search.ts`; the default is built from `app.deps`. */
    search?: SearchRouteDeps;
  }
}

/** One ranker (and so one `UniverseIndex`) per `AppDeps` — see the module docstring. */
const rankers = new WeakMap<AppDeps, SearchRanker>();

/** The catalogue both this route and the snapshot's `functions` tuples come from. */
function registryFor(deps: AppDeps): FunctionRegistry {
  return deps.universe?.registry ?? productionRegistry;
}

function rankerFor(app: FastifyInstance): SearchRanker {
  const deps = app.deps;
  const override = deps.search?.ranker;
  if (override !== undefined) return override;

  const held = rankers.get(deps);
  if (held !== undefined) return held;

  const built = searchRanker({
    snapshot: universeCacheFor(app),
    registry: registryFor(deps),
    clock: deps.clock,
  });
  rankers.set(deps, built);
  return built;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The route
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const searchRoutes: FastifyPluginAsync = async (app) => {
  // `data:read`, because a hit *is* an instrument master row — id, ticker, name, asset class. The
  // scope is enforced on `/ref` and `/data`; a search that served the same rows without it would
  // make an API key's scope list depend on which URL the holder asked.
  //
  // 30 req/s, burst 60 (API.md §8): the command line debounces at 60 ms and only reaches the
  // server when the local index missed, so the honest ceiling is well above a human typing.
  const guard = {
    preHandler: [requireSession({ scopes: ['data:read'] }), rateLimit(SEARCH_LIMIT)],
  };

  app.get('/search', guard, async (request): Promise<SearchResponse> => {
    // `SearchQuery` coerces its numbers and splits its list, because the same schema validates
    // this URL query — where every value arrives as a string — and the SDK's typed call.
    const parsed = SearchQuery.safeParse(request.query);
    if (!parsed.success) throw new ValidationFailedError('query', parsed.error.issues);
    const query = parsed.data;

    const input: ServerSearchInput = { q: query.q, limit: query.limit };
    if (query.kinds !== undefined) input.kinds = query.kinds;
    if (query.panelSecurityId !== undefined) input.panelSecurityId = query.panelSecurityId;
    if (query.panelFunction !== undefined) input.panelFunction = query.panelFunction;

    const result = await rankerFor(app).search(input);
    return { hits: result.hits, tookMs: result.tookMs, traceId: request.traceId };
  });

  await Promise.resolve();
};

export default searchRoutes;
