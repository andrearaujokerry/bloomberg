/**
 * `search/rank.ts` — the server-side ranking fallback behind `GET /api/v1/search`
 * (API.md §5.2 L438-488, TERM-02, WORKPLAN WP-08 L1077-1078).
 *
 * The client ranks locally over the universe snapshot it downloaded, and consults this endpoint
 * only for a name query of three characters or more that its local index could not answer
 * (ARCHITECTURE §5, debounced 60 ms). When the server's rows arrive they are merged into a list the
 * user is already looking at — so if the two sides scored differently, the list would visibly
 * reorder under the cursor between keystrokes, and row 0 (what `GO` executes) could change after
 * the user has already committed to it.
 *
 * **That is why this file contains no scoring.** It delegates, verbatim, to
 * `core/command/rank.ts#rank()` over a `core/command/index.ts#UniverseIndex` built from the very
 * snapshot the client downloaded. Identical function, identical index, identical order. Anything
 * here that looked like a score — an extra boost because the server "knows more", a different tie
 * break, a wider result cut — would be the bug this design exists to make impossible, and
 * `test/integration/search/fallback.test.ts` asserts the equality element by element.
 *
 * Three consequences worth being explicit about:
 *
 *  - **`limit` can only narrow.** `rank()` applies FUNCTIONS.md §3.3's per-kind cap and twelve-row
 *    cut internally, so the server never returns more than {@link MAX_RESULTS} rows even though
 *    `SearchQuery.limit` accepts up to 25. Serving a thirteenth row would mean the server had
 *    applied a different cut from the client.
 *  - **No MRU, no watchlist.** Both live in the browser (`terminal.mru` in `localStorage`, the
 *    focused panel's rows). The server scores with them empty, which is exactly what the client
 *    does for a candidate it has never seen; the client re-applies its own recency term when it
 *    merges. Inventing a server-side MRU would make the two orders disagree.
 *  - **No server-only enrichment.** `core/command/rank.ts#isSameIssuer` notes that the ETF ↔ index
 *    proxy pairing "is applied server-side, where `issuer_aliases` is available". It is
 *    deliberately NOT applied here: that boost would move rows the client cannot move, which is
 *    precisely the divergence §5.2 forbids. If it is ever wanted, it belongs in `core` so both
 *    sides get it.
 *
 * ## The three-character rule
 *
 * §5.2: "the server is consulted only for name queries ≥ 3 characters". {@link NAME_FALLBACK_MIN_CHARS}
 * is that threshold, and below it this module contributes no `name`- or `trigram`-matched row — a
 * one- or two-letter fragment of a company name matches thousands of instruments and the client
 * already holds every code and ticker locally, so there is nothing a short name query could tell it
 * that it does not know. Code, ticker and alias hits are still returned at any length, because
 * those are exact-ish matches and an API client (`clientKind: 'api'`) that calls `/search` directly
 * has no local index at all. The filter only ever REMOVES rows; the relative order of what survives
 * is `rank()`'s, unchanged.
 */

import type {
  Candidate,
  CandidateKind,
  Clock,
  FunctionRegistry,
  MruRank,
  RankContext,
  RankPanelContext,
  UniverseEntry,
} from '@terminal/core';
import { MAX_RESULTS, UniverseIndex, rank as coreRank } from '@terminal/core';

import type { SearchHit } from '@terminal/sdk/wire/rest/search';

import { wireSnapshot, type UniverseSnapshotCache } from './snapshot.js';

export { MAX_RESULTS };

/**
 * A name query shorter than this is answered locally (API.md §5.2). See the module docstring for
 * what the server still answers below it.
 */
export const NAME_FALLBACK_MIN_CHARS = 3;

/** The `matchedOn` values that are a *name* match, and so subject to the three-character rule. */
const NAME_MATCHES: ReadonlySet<Candidate['matchedOn']> = new Set(['name', 'trigram']);

/**
 * The server has no MRU and no watchlist (see the module docstring). A fresh empty collection per
 * call rather than a shared one: `RankContext` declares them mutable, and one shared `Set` that
 * some future caller adds to would silently leak a boost into every other request.
 */
const noMru = (): Map<string, MruRank> => new Map<string, MruRank>();
const noWatchlist = (): Set<number> => new Set<number>();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `SearchQuery` (API.md §5.2) as the ranker consumes it; `traceId` and `tookMs` are the route's. */
export interface ServerSearchInput {
  q: string;
  /** Narrows `rank()`'s twelve-row cut. Never widens it. */
  limit?: number;
  /** R2 of FUNCTIONS.md §3.3 — `SECF` passes `['instrument']`. */
  kinds?: readonly CandidateKind[];
  /** TERM-03 context boost: the instrument loaded in the calling panel. */
  panelSecurityId?: number;
  /** TERM-03 context boost: the function code the calling panel is showing. */
  panelFunction?: string;
}

export interface ServerSearchResult {
  hits: SearchHit[];
  /** Wall-clock milliseconds by the injected clock; `0` under a `VirtualClock`. */
  tookMs: number;
  /** The universe version the hits were ranked against — the snapshot's ETag content hash. */
  version: string;
}

export interface SearchRankerDeps {
  snapshot: UniverseSnapshotCache;
  registry: FunctionRegistry;
  clock: Clock;
}

export interface SearchRankerStats {
  /** `UniverseIndex` builds — one per distinct snapshot version this process has seen. */
  indexBuilds: number;
  /** The version the held index was built from, or `null` before the first search. */
  version: string | null;
  /** Entries in the held index. */
  size: number;
  searches: number;
}

export interface SearchRanker {
  search(input: ServerSearchInput): Promise<ServerSearchResult>;
  /** The index the next `search()` would use — the same object the client would build. */
  index(): Promise<UniverseIndex>;
  stats(): SearchRankerStats;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Pure ranking — no IO, no cache, exported so a test can compare it against `coreRank` directly
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `RankContext` the server scores in: the caller's panel context, and nothing else.
 *
 * `hasPanelSecurity` is `true` only when the id actually resolves in the index — a stale panel
 * pointing at an instrument this snapshot no longer carries must score as "no panel security", not
 * as a half-filled context, or `panelAssetClassOf()` reads an asset class that is not there.
 */
export function rankContextFor(index: UniverseIndex, input: ServerSearchInput): RankContext {
  const security = panelSecurity(index, input.panelSecurityId);
  const ctx: RankContext = {
    panel: { security, fn: normalizeFn(input.panelFunction), params: {} },
    hasPanelSecurity: security !== null,
    watchlistIds: noWatchlist(),
    mru: noMru(),
  };
  if (input.kinds !== undefined) ctx.kinds = [...input.kinds];
  return ctx;
}

/** The panel's instrument as `RankPanelContext.security`, or `null` when it is not usable. */
function panelSecurity(
  index: UniverseIndex,
  panelSecurityId: number | undefined,
): RankPanelContext['security'] {
  if (typeof panelSecurityId !== 'number' || !Number.isFinite(panelSecurityId)) return null;
  const at = index.entryOfInstrument(panelSecurityId);
  if (at < 0) return null;
  const entry: UniverseEntry | undefined = index.entryAt(at);
  if (entry === undefined) return null;
  // `RankPanelContext.security` has no optional members: an entry missing either classification
  // cannot fill it, so it is no panel security at all rather than a half-filled one.
  const { instrumentId, assetClass, marketSector } = entry;
  if (instrumentId === null || assetClass === null || marketSector === null) return null;
  return { instrumentId, assetClass, marketSector, display: entry.primary };
}

function normalizeFn(panelFunction: string | undefined): string | null {
  if (typeof panelFunction !== 'string') return null;
  const trimmed = panelFunction.trim().toUpperCase();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * `rank()` verbatim, then the three-character name rule, then `limit`.
 *
 * This is the whole of the server's ranking. Nothing is added to a score and nothing is reordered:
 * for a query of {@link NAME_FALLBACK_MIN_CHARS} characters or more with a `limit` at or above
 * {@link MAX_RESULTS}, the array returned here is `coreRank(...)` itself.
 */
export function rankCandidates(
  index: UniverseIndex,
  registry: FunctionRegistry,
  input: ServerSearchInput,
): Candidate[] {
  const q = typeof input.q === 'string' ? input.q : '';
  const rows = coreRank(q, index, rankContextFor(index, input), registry);
  const gated =
    q.trim().length >= NAME_FALLBACK_MIN_CHARS
      ? rows
      : rows.filter((r) => !NAME_MATCHES.has(r.matchedOn));
  const limit = limitOf(input.limit);
  return gated.length > limit ? gated.slice(0, limit) : gated;
}

/** `SearchQuery.limit` clamped to the §5.2 range; absent or unusable means the full twelve. */
function limitOf(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return MAX_RESULTS;
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(limit)));
}

/**
 * `Candidate` → `SearchHit` (API.md §5.2 L456-467).
 *
 * The wire shape is the candidate minus `applicable`: the dimming flag is a client rendering
 * concern over the client's own panel context, and the wire schema in `sdk/wire/rest/search.ts` is
 * normative — a field it does not declare is not served.
 */
export function toSearchHit(c: Candidate): SearchHit {
  const hit: SearchHit = {
    kind: c.kind,
    id: c.id,
    primary: c.primary,
    secondary: c.secondary,
    score: c.score,
    matchedOn: c.matchedOn,
    matched: c.matched.map(([from, to]) => [from, to] as [number, number]),
    insertText: c.insertText,
    source: c.source,
  };
  if (c.assetClass !== undefined) hit.assetClass = c.assetClass;
  if (c.marketSector !== undefined) hit.marketSector = c.marketSector;
  return hit;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Factory — the cached index over the cached snapshot
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The ranker `http/routes/search.ts` calls.
 *
 * The `UniverseIndex` is built once per snapshot *version* and held: building it is the O(n) pass
 * over ≈36 k entries that FUNCTIONS.md §3.5 explicitly moves off the keystroke path, and doing it
 * per request would put it right back on. The snapshot cache decides when the universe moved
 * (`config_versions('universe')`); this one just notices that `version` changed.
 */
export function searchRanker(deps: SearchRankerDeps): SearchRanker {
  const { snapshot, registry, clock } = deps;

  let held: { version: string; index: UniverseIndex } | null = null;
  let building: { version: string; promise: Promise<UniverseIndex> } | undefined;
  let indexBuilds = 0;
  let searches = 0;

  async function currentIndex(): Promise<UniverseIndex> {
    const snap = await snapshot.get();
    const have = held;
    if (have !== null && have.version === snap.version) return have.index;

    // The in-flight build is keyed by the version it is building, not merely by "a build is
    // running": a `config_versions` bump between two concurrent requests would otherwise hand the
    // second caller the FIRST one's index, and it would rank against a universe it can see is out
    // of date. Two different versions build concurrently; two callers on the same version share.
    const inflight = building;
    if (inflight?.version === snap.version) return inflight.promise;

    const promise = Promise.resolve()
      .then(() => {
        const index = UniverseIndex.build(wireSnapshot(snap));
        indexBuilds += 1;
        held = { version: snap.version, index };
        return index;
      })
      .finally(() => {
        if (building?.promise === promise) building = undefined;
      });
    building = { version: snap.version, promise };
    return promise;
  }

  return {
    index: currentIndex,

    async search(input: ServerSearchInput): Promise<ServerSearchResult> {
      const startedMs = clock.now();
      const index = await currentIndex();
      searches += 1;
      const hits = rankCandidates(index, registry, input).map(toSearchHit);
      return {
        hits,
        tookMs: Math.max(0, clock.now() - startedMs),
        version: index.version,
      };
    },

    stats(): SearchRankerStats {
      return {
        indexBuilds,
        version: held?.version ?? null,
        size: held?.index.size ?? 0,
        searches,
      };
    },
  };
}
