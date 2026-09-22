/**
 * `functions/resultCache.ts` — `resultId → CachedResult` (FUNCTIONS.md §1.4.4 L351-356,
 * WORKPLAN WP-08).
 *
 * Step 9 of the runner puts every payload here under a fresh ULID, and three things read it back:
 *
 *  - `POST /functions/:code/page` — re-runs steps 6-11 with the *cached* `params`, `security` and
 *    `asOf`, so a page turn cannot silently drift onto a different instant than the launch;
 *  - `GET /results/:resultId` — hands the producer its own payload back, and re-runs for anyone
 *    else (MSG-04 share links);
 *  - `GET /functions/:code/csv?resultId=…` — exports exactly what is on the screen, so the file
 *    and the screen cannot disagree.
 *
 * Three properties, and the reason each one is not negotiable:
 *
 *  1. **`get()` is scoped to the producer.** `get(resultId, userId)` returns `undefined` for
 *     anybody else — not the row, and not a *different* answer than a resultId that never existed.
 *     A share link carries a resultId across firms; if a miss and a foreign hit were
 *     distinguishable, the resultId space would be an oracle for "did user X run a function"
 *     (and, by probing, for which securities their firm follows). The caller therefore cannot
 *     tell the two apart, and `GET /results/:resultId` re-runs under the *viewer's* entitlements
 *     rather than serving the producer's entitled values.
 *  2. **Ten minutes on the injected clock.** Age is measured from `storedAt` — when the payload
 *     was produced — never from the last read: a screen left open for an hour must not keep an
 *     hour-old entitlement decision alive, and `RESULT_EXPIRED` is a documented 404 the client
 *     handles by re-launching. Reading an entry does not extend its life; it only makes it the
 *     most recently used.
 *  3. **LRU 500 per user, per user.** One user filling their 500 slots evicts only their own
 *     oldest result. A shared bound would make one user's paging loop a denial of service on
 *     everyone else's share links.
 *
 * In-process and deliberately so (ARCHITECTURE §5.3): a result is a per-node convenience, not
 * state. A miss is always recoverable — every reader above can re-run at the cached `asOf`, which
 * is what makes an expiry a re-run rather than an error the user has to understand.
 */

import type { Clock, PayloadMeta } from '@terminal/core';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** FUNCTIONS.md §1.4.4 L352, verbatim. */
export interface CachedResult {
  resultId: string;
  /** The producer. `get()` answers `undefined` for every other user. */
  userId: number;
  /**
   * The producer's firm. `peek()` answers `undefined` for every other firm.
   *
   * A share link (MSG-04) travels inside a firm — `messages` is firm-scoped — so a resultId
   * presented by another tenant is a probe, not a link. Without this field the share-link path
   * would confirm that a given id exists, and re-run somebody else's function at somebody else's
   * `asOf` on somebody else's instrument, which tells the prober which security another desk was
   * looking at and when.
   */
  firmId: number;
  /** The manifest's canonical code — never the alias it was launched by. */
  code: string;
  /** The alias typed, when it differed from `code` (`'IB'` → MSG). */
  alias?: string;
  /** The **parsed** params (post-zod, post-`aliasParams`), so a re-run parses the same object. */
  params: unknown;
  security: number | null;
  data: unknown;
  meta: PayloadMeta;
  /** `clock.now()` at step 9. The TTL is measured from here. */
  storedAt: number;
}

export interface ResultCacheDeps {
  clock: Clock;
  /** Entries kept per user before the least recently used is evicted. Default 500. */
  perUser?: number;
  /** Life of an entry from `storedAt`, in ms. Default 600 000 (10 minutes). */
  ttlMs?: number;
  /**
   * Interval of the background sweep started by {@link ResultCache.start}, in ms. Default 60 000.
   *
   * The TTL is honoured on *read* by `get`/`peek`, and on *write* for the user being written. That
   * makes an expired payload unreadable, but it does not make it leave memory: a user who runs 500
   * functions and closes the terminal leaves 500 entitlement-filtered payloads resident until the
   * process restarts. A ten-minute TTL that is enforced on retention only by a restart is not a
   * ten-minute retention, so a process that intends to run for weeks calls `start()`.
   */
  sweepMs?: number;
  /** Timer seam, so a test can drive the sweep without a real interval. */
  timers?: {
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
}

export interface ResultCacheStats {
  /** Live entries across every user (expired-but-unswept rows included until they are read). */
  entries: number;
  /** Users holding at least one entry. */
  users: number;
  puts: number;
  hits: number;
  /** Unknown resultId, or one whose TTL had run out. */
  misses: number;
  /** A resultId that exists but belongs to somebody else. Counted, never disclosed. */
  foreign: number;
  /** Dropped because the user was at `perUser`. */
  evictions: number;
  /** Dropped because the TTL had run out. */
  expired: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** FUNCTIONS.md §1.4.4: "LRU 500 per user". */
export const DEFAULT_PER_USER = 500;

/** FUNCTIONS.md §1.4.4 / API.md §5.3: "the cached result (10 min TTL)". */
export const DEFAULT_TTL_MS = 600_000;

/** How often {@link ResultCache.start} walks every user for dead entries. */
export const DEFAULT_SWEEP_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ResultCache
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The per-user LRU.
 *
 * Recency is carried by `Map` insertion order rather than by a timestamp or a linked list: a `Map`
 * iterates in insertion order, so `delete` + `set` moves an entry to the back and the first key of
 * the iterator is always the least recently used. That is O(1) for `get`, `put` and eviction, and
 * it has no second structure that could disagree with the first.
 */
export class ResultCache {
  readonly #clock: Clock;
  readonly #perUser: number;
  readonly #ttlMs: number;
  readonly #sweepMs: number;
  readonly #timers: NonNullable<ResultCacheDeps['timers']>;
  #sweepHandle: unknown;

  /** userId → (resultId → entry), least recently used first. */
  readonly #byUser = new Map<number, Map<string, CachedResult>>();
  /** resultId → owner, so a foreign read is one lookup and never scans another user's map. */
  readonly #owner = new Map<string, number>();

  #puts = 0;
  #hits = 0;
  #misses = 0;
  #foreign = 0;
  #evictions = 0;
  #expired = 0;

  constructor(deps: ResultCacheDeps) {
    const perUser = deps.perUser ?? DEFAULT_PER_USER;
    const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isInteger(perUser) || perUser < 1) {
      throw new RangeError(`ResultCache: perUser must be a positive integer, got ${perUser}`);
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError(`ResultCache: ttlMs must be positive, got ${ttlMs}`);
    }
    const sweepMs = deps.sweepMs ?? DEFAULT_SWEEP_MS;
    if (!Number.isFinite(sweepMs) || sweepMs <= 0) {
      throw new RangeError(`ResultCache: sweepMs must be positive, got ${sweepMs}`);
    }
    this.#clock = deps.clock;
    this.#perUser = perUser;
    this.#ttlMs = ttlMs;
    this.#sweepMs = sweepMs;
    this.#timers = deps.timers ?? {
      setInterval: (fn, ms) => {
        const handle = setInterval(fn, ms);
        // An unref'd interval never keeps the process (or a vitest worker) alive.
        handle.unref?.();
        return handle;
      },
      clearInterval: (handle) => {
        clearInterval(handle as ReturnType<typeof setInterval>);
      },
    };
  }

  /**
   * Begin sweeping expired entries in the background. Idempotent; a second call is a no-op.
   *
   * Same lifecycle as `entitlements/accessLog.ts` and `observability/usageEvents.ts`: the owner
   * that built the cache starts it and stops it, and nothing on a request path touches the timer.
   */
  start(): void {
    if (this.#sweepHandle !== undefined) return;
    this.#sweepHandle = this.#timers.setInterval(() => {
      this.sweepAll();
    }, this.#sweepMs);
  }

  /** Stop the sweep. Idempotent, and safe to call on a cache that was never started. */
  stop(): void {
    if (this.#sweepHandle === undefined) return;
    this.#timers.clearInterval(this.#sweepHandle);
    this.#sweepHandle = undefined;
  }

  /** Drop every expired entry, for every user. Returns how many went. */
  sweepAll(): number {
    const before = this.#expired;
    for (const [userId, slot] of [...this.#byUser]) this.#sweep(userId, slot);
    return this.#expired - before;
  }

  /**
   * Store one result. A repeat `resultId` replaces the entry and moves it to the back; a resultId
   * already owned by another user is rejected rather than reassigned, because silently changing an
   * entry's owner is exactly the confusion the producer check exists to prevent.
   */
  put(result: CachedResult): void {
    const existingOwner = this.#owner.get(result.resultId);
    if (existingOwner !== undefined && existingOwner !== result.userId) {
      throw new Error(
        `ResultCache: resultId ${result.resultId} already belongs to user ${existingOwner}`,
      );
    }

    let slot = this.#byUser.get(result.userId);
    if (slot === undefined) {
      slot = new Map<string, CachedResult>();
      this.#byUser.set(result.userId, slot);
    }

    // Re-insert at the back even when replacing, so a refreshed entry is the most recently used.
    slot.delete(result.resultId);
    slot.set(result.resultId, result);
    this.#owner.set(result.resultId, result.userId);
    this.#puts += 1;

    // Sweep this user's dead entries before evicting a live one: a user whose slots are full of
    // ten-minute-old results should lose those, not their newest-but-one.
    this.#sweep(result.userId, slot);

    while (slot.size > this.#perUser) {
      const oldest = slot.keys().next();
      if (oldest.done === true) break;
      slot.delete(oldest.value);
      this.#owner.delete(oldest.value);
      this.#evictions += 1;
    }
  }

  /**
   * The producer's own result, or `undefined`.
   *
   * `undefined` covers all three of: no such resultId, expired, and somebody else's — one answer,
   * so a caller cannot tell them apart (see the header). A hit becomes the most recently used.
   */
  get(resultId: string, userId: number): CachedResult | undefined {
    const owner = this.#owner.get(resultId);
    if (owner === undefined) {
      this.#misses += 1;
      return undefined;
    }
    if (owner !== userId) {
      // Counted for the operator, invisible to the caller.
      this.#foreign += 1;
      return undefined;
    }

    const slot = this.#byUser.get(owner);
    const entry = slot?.get(resultId);
    if (slot === undefined || entry === undefined) {
      // The owner index and the per-user map disagreeing is a bug; treat it as a miss and heal.
      this.#owner.delete(resultId);
      this.#misses += 1;
      return undefined;
    }

    if (this.#isExpired(entry)) {
      slot.delete(resultId);
      this.#owner.delete(resultId);
      if (slot.size === 0) this.#byUser.delete(owner);
      this.#expired += 1;
      this.#misses += 1;
      return undefined;
    }

    // Touch: move to the back of the insertion order.
    slot.delete(resultId);
    slot.set(resultId, entry);
    this.#hits += 1;
    return entry;
  }

  /**
   * The owner of a resultId **within the viewer's firm**, for the share-link path only.
   *
   * `GET /results/:resultId` needs to know *that* a result exists so it can re-run it under the
   * viewer's entitlements, which is not the same question as "may I have the producer's values".
   * Route code must answer a non-producer with a re-run or a 404 — never with the cached `data`.
   *
   * `firmId` is required rather than optional because the tenant boundary is not something a
   * caller should be able to leave out. A viewer from another firm gets `undefined` — the same
   * answer a bogus id gets, so the resultId space is not an existence oracle across tenants
   * (API.md §5.3's share links are MSG-04 links, and messages never cross a firm).
   */
  peek(resultId: string, firmId: number): CachedResult | undefined {
    const owner = this.#owner.get(resultId);
    if (owner === undefined) return undefined;
    const entry = this.#byUser.get(owner)?.get(resultId);
    if (entry === undefined) return undefined;
    if (this.#isExpired(entry)) return undefined;
    if (entry.firmId !== firmId) {
      this.#foreign += 1;
      return undefined;
    }
    return entry;
  }

  /** Forget one entry (a producer closing a panel, a test). */
  delete(resultId: string): boolean {
    const owner = this.#owner.get(resultId);
    if (owner === undefined) return false;
    const slot = this.#byUser.get(owner);
    slot?.delete(resultId);
    if (slot?.size === 0) this.#byUser.delete(owner);
    this.#owner.delete(resultId);
    return true;
  }

  /** Live entries across every user. */
  size(): number {
    return this.#owner.size;
  }

  stats(): ResultCacheStats {
    return {
      entries: this.#owner.size,
      users: this.#byUser.size,
      puts: this.#puts,
      hits: this.#hits,
      misses: this.#misses,
      foreign: this.#foreign,
      evictions: this.#evictions,
      expired: this.#expired,
    };
  }

  /** Drop everything. Tests and a graceful shutdown; never a request path. */
  clear(): void {
    this.#byUser.clear();
    this.#owner.clear();
  }

  /** Age is measured from `storedAt`; at exactly `ttlMs` the entry is gone. */
  #isExpired(entry: CachedResult): boolean {
    return this.#clock.now() - entry.storedAt >= this.#ttlMs;
  }

  #sweep(userId: number, slot: Map<string, CachedResult>): void {
    for (const [resultId, entry] of slot) {
      if (!this.#isExpired(entry)) continue;
      slot.delete(resultId);
      this.#owner.delete(resultId);
      this.#expired += 1;
    }
    if (slot.size === 0) this.#byUser.delete(userId);
  }
}
