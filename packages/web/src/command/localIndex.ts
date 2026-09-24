// packages/web/src/command/localIndex.ts — the local universe index: load, cache, build, swap
// (FUNCTIONS.md §3.1 L865-880, CLIENT.md §1 L76 and §2 L199-200, WORKPLAN L1352-1354).
//
// FUNCTIONS §3.1, verbatim: "fetches with `If-None-Match`, stores the snapshot in IndexedDB
// (`terminal.universe`, key = `version`), builds the index in a Worker (< 300 ms for 45 k rows) and
// swaps it in atomically; until then the shell uses the server `/search` for every keystroke. MRU
// (`terminal.mru`, ≤ 50 `{ kind, id, lastUsed, count }`) lives in `localStorage` and is rebuilt from
// `panels[].history` of the workspace on a fresh machine."
//
// Four things this file owns, in the order `load()` does them:
//
//   1. **IndexedDB first.** A cached snapshot is decoded and swapped in before the network is
//      touched, so a returning desk has a working command line immediately (CLIENT §2 L199).
//   2. **ETag revalidation.** The cached record keeps the `ETag` header verbatim and the next load
//      sends it as `If-None-Match`. A `304` means the body is *not* re-fetched, not re-decoded and
//      not re-built: the cached index stands. This is the whole point of caching against the ETag —
//      the snapshot is megabytes and changes about once a day.
//   3. **The Worker.** Decoding and validating ≈ 36 k tuples never runs on the keystroke path.
//      `indexWorker.ts` explains what crosses the boundary and what cannot.
//   4. **The swap.** `#index` is replaced by one assignment; nothing observes a half-built index.
//      `lookupTicker` is bound to the loader, not to an index instance, so the parser, the ranker
//      and the command line keep working across a swap without re-subscribing.
//
// IO: every network call goes through the injected `@terminal/sdk` client (API-05). IndexedDB is a
// browser storage API, not IO over the wire, and is reached through the `SnapshotStore` port so
// that a test — jsdom ships no IndexedDB — can supply an in-memory one.
//
// Arithmetic: none. Entry construction, ranking, the MRU recency curve and the 50-row cap all live
// in `packages/core` and are called, never re-implemented.
import {
  DEFAULT_FUNCTION,
  UniverseIndex,
  mruKey,
  parse,
  type CandidateKind,
  type FunctionRegistry,
  type MarketSector,
  type MruRecord,
  type PanelContext,
  type TickerHit,
  type UniverseSnapshot,
} from '@terminal/core';
import { TerminalApiError, type RequestOptions } from '@terminal/sdk';

import {
  handleDecode,
  type DecodeStats,
  type IndexWorkerRequest,
  type IndexWorkerResponse,
} from './indexWorker.js';

/* ---------------------------------------------------------------------------------------------- */
/* Constants                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** FUNCTIONS §3.1 L876: the IndexedDB database the snapshot is cached in. */
export const UNIVERSE_DB_NAME = 'terminal.universe';
/** The one object store in it; `keyPath: 'version'` is §3.1's "key = `version`". */
export const UNIVERSE_STORE_NAME = 'snapshots';
export const UNIVERSE_DB_VERSION = 1;

/**
 * FUNCTIONS §3.1 L878: at most 50 MRU rows. `packages/core` has the same number as `MRU_MAX` in
 * `command/index.ts` and enforces it inside `UniverseIndex.setMru`, but does not re-export it from
 * the package barrel, so the rebuild below caps its own output with a named constant rather than
 * reaching into a deep path the ESLint boundary rules forbid.
 */
export const MRU_LIMIT = 50;

/** Milliseconds between consecutive history entries when the rebuild synthesises `lastUsed`. */
export const MRU_HISTORY_STEP_MS = 1_000;

/* ---------------------------------------------------------------------------------------------- */
/* The IndexedDB cache                                                                              */
/* ---------------------------------------------------------------------------------------------- */

/** One cached snapshot. The record key is `version`, which is also the ETag's payload. */
export interface CachedSnapshot {
  /** `snapshot.version` — the IndexedDB key and the sha1 the server puts in the ETag. */
  version: string;
  /** The `ETag` response header **verbatim**, quotes and any `W/` prefix included. */
  etag: string;
  /** Epoch ms; the newest record wins when more than one survives. */
  storedAt: number;
  snapshot: UniverseSnapshot;
}

/**
 * The storage port. The production implementation is IndexedDB; a test supplies
 * `memorySnapshotStore()`, and a host with neither gets `nullSnapshotStore()` and simply never
 * caches.
 */
export interface SnapshotStore {
  read(): Promise<CachedSnapshot | undefined>;
  write(record: CachedSnapshot): Promise<void>;
  clear(): Promise<void>;
}

/** A store that forgets everything: the graceful degradation when there is no IndexedDB. */
export function nullSnapshotStore(): SnapshotStore {
  return {
    read: () => Promise.resolve(undefined),
    write: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  };
}

/** An in-memory store with the same semantics, for tests and for private-mode browsers. */
export function memorySnapshotStore(initial?: CachedSnapshot): SnapshotStore {
  let held: CachedSnapshot | undefined = initial;
  return {
    read: () => Promise.resolve(held),
    write: (record) => {
      held = record;
      return Promise.resolve();
    },
    clear: () => {
      held = undefined;
      return Promise.resolve();
    },
  };
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = (): void => {
      resolve(request.result);
    };
    request.onerror = (): void => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(UNIVERSE_DB_NAME, UNIVERSE_DB_VERSION);
    request.onupgradeneeded = (): void => {
      const db = request.result;
      if (!db.objectStoreNames.contains(UNIVERSE_STORE_NAME)) {
        db.createObjectStore(UNIVERSE_STORE_NAME, { keyPath: 'version' });
      }
    };
    request.onsuccess = (): void => {
      resolve(request.result);
    };
    request.onerror = (): void => {
      reject(request.error ?? new Error('IndexedDB could not be opened'));
    };
    request.onblocked = (): void => {
      reject(new Error('IndexedDB open was blocked by another tab'));
    };
  });
}

/**
 * The real cache: `terminal.universe` → `snapshots`, keyed by `version` (FUNCTIONS §3.1 L876).
 *
 * A write keeps exactly one record — the snapshot is megabytes and an old version is never wanted
 * again once a newer one has been validated. Every operation is total: a quota error, a private
 * window or a browser without IndexedDB degrades to "no cache", never to a broken command line.
 */
export function indexedDbSnapshotStore(factory?: IDBFactory): SnapshotStore {
  const idb = factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (idb === undefined) return nullSnapshotStore();

  const withStore = async <T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> => {
    const db = await openDb(idb);
    try {
      const tx = db.transaction(UNIVERSE_STORE_NAME, mode);
      const result = await body(tx.objectStore(UNIVERSE_STORE_NAME));
      return result;
    } finally {
      db.close();
    }
  };

  return {
    async read() {
      try {
        const rows = await withStore('readonly', (store) =>
          promisify<unknown[]>(store.getAll() as IDBRequest<unknown[]>),
        );
        let best: CachedSnapshot | undefined;
        for (const row of rows) {
          const record = row as CachedSnapshot | null;
          if (record === null || typeof record !== 'object') continue;
          if (typeof record.version !== 'string' || record.version === '') continue;
          if (best === undefined || record.storedAt > best.storedAt) best = record;
        }
        return best;
      } catch {
        return undefined;
      }
    },
    async write(record) {
      try {
        await withStore('readwrite', async (store) => {
          await promisify(store.clear());
          await promisify(store.put(record));
        });
      } catch {
        // A full or unavailable quota costs the next boot its head start, nothing more.
      }
    },
    async clear() {
      try {
        await withStore('readwrite', (store) => promisify(store.clear()));
      } catch {
        // as above
      }
    },
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* The Worker port                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What the loader needs from a `Worker`. A real `Worker` satisfies it; a test supplies
 * `inlineWorkerPort()`, which runs the same `indexWorker.ts` code synchronously.
 */
export interface IndexWorkerPort {
  postMessage(message: IndexWorkerRequest): void;
  onmessage: ((event: { data: IndexWorkerResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate(): void;
}

/**
 * The production factory: a module Worker running `indexWorker.ts`.
 *
 * `new Worker(new URL(...), { type: 'module' })` is the form the bundler understands, so the worker
 * becomes its own chunk and is never pulled into the initial route chunk's budget (CLIENT §16.1).
 */
export function createIndexWorker(): IndexWorkerPort {
  const worker = new Worker(new URL('./indexWorker.js', import.meta.url), { type: 'module' });
  return worker as unknown as IndexWorkerPort;
}

/**
 * A port that decodes on the calling thread. Used when the host has no `Worker` (jsdom, a
 * server-rendered smoke test) so that the command line still comes up — slower, never broken.
 */
export function inlineWorkerPort(): IndexWorkerPort {
  const port: IndexWorkerPort = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      const response = handleDecode(message);
      port.onmessage?.({ data: response });
    },
    terminate() {
      port.onmessage = null;
      port.onerror = null;
    },
  };
  return port;
}

/* ---------------------------------------------------------------------------------------------- */
/* MRU rebuild from the workspace history (FUNCTIONS §3.1 L878-880, TERM-05)                        */
/* ---------------------------------------------------------------------------------------------- */

/** The one field of `PanelState` the rebuild reads (API.md §5.7). */
export interface PanelHistory {
  /** Raw command text, oldest first, ≤ 100 entries (FUNCTIONS §2.5 L783). */
  history: readonly string[];
}

export interface RebuildMruOptions {
  index: UniverseIndex;
  registry: FunctionRegistry;
  /** Epoch ms for the most recent history entry. */
  now: number;
  limit?: number;
  stepMs?: number;
}

/** A panel context with nothing loaded: the rebuild reads history, it does not replay a session. */
const EMPTY_PANEL: PanelContext = { security: null, fn: null, params: {} };

/**
 * Rebuild the MRU from `panels[].history` — what a fresh machine does when `localStorage` has no
 * `terminal.mru` but the workspace came back from the server (FUNCTIONS §3.1 L879-880, TERM-05).
 *
 * Each raw line is re-read with the real parser against the real index, so `AAPL US Equity GP`
 * contributes both the instrument and `GP`, `IB` contributes `MSG` (its canonical code, not the
 * alias typed) and a line that no longer parses contributes nothing. `lastUsed` is synthesised from
 * each entry's distance from the end of its own panel's history — history carries order, not
 * timestamps — and `count` is how often the row appears across every panel. Ties across panels take
 * the later `lastUsed` and the summed `count`, which is what `UniverseIndex.setMru` then ranks.
 */
export function rebuildMruFromHistory(
  panels: readonly PanelHistory[],
  options: RebuildMruOptions,
): MruRecord[] {
  const { index, registry, now } = options;
  const limit = options.limit ?? MRU_LIMIT;
  const stepMs = options.stepMs ?? MRU_HISTORY_STEP_MS;
  const rows = new Map<string, MruRecord>();

  const note = (kind: CandidateKind, id: string, lastUsed: number): void => {
    const key = mruKey(kind, id);
    const existing = rows.get(key);
    if (existing === undefined) rows.set(key, { kind, id, lastUsed, count: 1 });
    else {
      existing.count += 1;
      if (lastUsed > existing.lastUsed) existing.lastUsed = lastUsed;
    }
  };

  const lookupTicker = (
    tokens: readonly string[],
    opts?: { exchCode?: string; sector?: MarketSector },
  ): TickerHit[] => index.lookupTicker(tokens, opts);

  for (const panel of panels) {
    const history = panel.history ?? [];
    for (let i = 0; i < history.length; i += 1) {
      const raw = history[i];
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      const lastUsed = now - (history.length - 1 - i) * stepMs;
      const reading = parse(raw, { registry, panel: EMPTY_PANEL, lookupTicker })[0];
      if (reading === undefined) continue;
      if (reading.shape === 'shell' || reading.shape === 'invalid') continue;

      const instrumentId = reading.security?.instrumentId;
      if (instrumentId !== undefined) note('instrument', String(instrumentId), lastUsed);

      const code = reading.fn?.code ?? (reading.shape === 'security' ? DEFAULT_FUNCTION : undefined);
      if (code !== undefined) note('function', code, lastUsed);
    }
  }

  return [...rows.values()]
    .sort((a, b) => (a.lastUsed === b.lastUsed ? b.count - a.count : b.lastUsed - a.lastUsed))
    .slice(0, limit);
}

/* ---------------------------------------------------------------------------------------------- */
/* The loader                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * `'empty'` — nothing loaded, the shell must use `sdk.search.query` for every keystroke (§3.4);
 * `'cached'` — an index built from the IndexedDB copy, not yet revalidated;
 * `'fresh'` — the ETag was confirmed (304) or a new snapshot was fetched and built.
 */
export type UniverseIndexState = 'empty' | 'cached' | 'fresh';

export interface UniverseLoadResult {
  state: UniverseIndexState;
  version: string;
  /** Entries in the live index. */
  size: number;
  /** Where the bytes the index was built from came from. */
  source: 'none' | 'cache' | 'network';
  /** True only when the server sent a snapshot **body** on this load. A 304 is `false`. */
  fetched: boolean;
  /** True when `If-None-Match` was sent and the server answered `304 Not Modified`. */
  notModified: boolean;
  /** What the worker reported, or `null` when nothing was decoded on this load. */
  stats: DecodeStats | null;
  /** Main-thread milliseconds spent in `UniverseIndex.build` plus the swap (CLIENT §16.1). */
  swapMs: number;
}

/** The slice of the SDK client the loader uses. Nothing else in `@terminal/sdk` is touched. */
export interface UniverseSdk {
  search: {
    universeSnapshot(args?: Record<string, never>, init?: RequestOptions): Promise<unknown>;
  };
}

export interface UniverseLoaderOptions {
  sdk: UniverseSdk;
  /** Defaults to `indexedDbSnapshotStore()`. */
  store?: SnapshotStore;
  /**
   * Defaults to `createIndexWorker` where `Worker` exists and `inlineWorkerPort` where it does not.
   * One worker is created per loader and terminated by `dispose()`.
   */
  createWorker?: () => IndexWorkerPort;
  /** Epoch milliseconds; injected so a test controls `storedAt`. */
  now?: () => number;
  /** Monotonic milliseconds for the budget measurements. */
  clock?: () => number;
  /** MRU applied to every index this loader builds. */
  mru?: readonly MruRecord[];
  /** Called after each atomic swap, with the index the shell should now rank against. */
  onSwap?: (index: UniverseIndex, result: UniverseLoadResult) => void;
  /** Non-fatal failures: a broken cache, an unreachable snapshot route. */
  onError?: (error: unknown) => void;
}

const EMPTY_RESULT: UniverseLoadResult = {
  state: 'empty',
  version: '',
  size: 0,
  source: 'none',
  fetched: false,
  notModified: false,
  stats: null,
  swapMs: 0,
};

function defaultNow(): number {
  return Date.now();
}

function defaultClock(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

function defaultWorkerFactory(): () => IndexWorkerPort {
  return typeof (globalThis as { Worker?: unknown }).Worker === 'function'
    ? createIndexWorker
    : inlineWorkerPort;
}

/** `TerminalApiError` for a `304` — the SDK raises one when it has no cached body of its own. */
function isNotModified(error: unknown): boolean {
  return error instanceof TerminalApiError && error.status === 304;
}

/**
 * Owns the one `UniverseIndex` the shell ranks against, and everything that replaces it.
 *
 * The index is never handed out by value to be held: callers read `loader.index` (or call the bound
 * `lookupTicker`) at the moment they need it, which is what makes the swap atomic from their side.
 */
export class LocalUniverseIndex {
  #index: UniverseIndex = UniverseIndex.empty();
  #state: UniverseIndexState = 'empty';
  #mru: readonly MruRecord[];
  #worker: IndexWorkerPort | null = null;
  #requestId = 0;
  #disposed = false;
  /** The `ETag` header of the last response, captured by `onResponseHeaders`. */
  #lastEtag = '';

  readonly #options: UniverseLoaderOptions;
  readonly #store: SnapshotStore;
  readonly #createWorker: () => IndexWorkerPort;
  readonly #now: () => number;
  readonly #clock: () => number;

  constructor(options: UniverseLoaderOptions) {
    this.#options = options;
    this.#store = options.store ?? indexedDbSnapshotStore();
    this.#createWorker = options.createWorker ?? defaultWorkerFactory();
    this.#now = options.now ?? defaultNow;
    this.#clock = options.clock ?? defaultClock;
    this.#mru = options.mru ?? [];
  }

  /** The live index. Read it per use; it is replaced wholesale by a swap. */
  get index(): UniverseIndex {
    return this.#index;
  }

  get state(): UniverseIndexState {
    return this.#state;
  }

  get version(): string {
    return this.#index.version;
  }

  /** True once a snapshot has been indexed — until then the shell falls back to `/search` (§3.4). */
  get ready(): boolean {
    return this.#state !== 'empty';
  }

  /**
   * `ParseEnv.lookupTicker`, bound to the loader rather than to an index. The command line builds
   * its `ParseEnv` once and keeps parsing correctly across a swap.
   */
  readonly lookupTicker = (
    tokens: readonly string[],
    opts?: { exchCode?: string; sector?: MarketSector },
  ): TickerHit[] => this.#index.lookupTicker(tokens, opts);

  /** Replace the MRU on the live index and on every index built afterwards. */
  setMru(records: readonly MruRecord[]): void {
    this.#mru = records.slice();
    this.#index.setMru(this.#mru);
  }

  /** Record a use (a GO, an accepted autocomplete row) — `UniverseIndex.noteUse` does the ranking. */
  noteUse(kind: CandidateKind, id: string): void {
    this.#index.noteUse(kind, id, this.#now());
  }

  /**
   * IndexedDB first, then ETag revalidation.
   *
   * Returns the state of the index when it is done. A cached hit whose ETag the server confirms
   * costs one conditional request and **no** snapshot body, no decode and no build.
   */
  async load(): Promise<UniverseLoadResult> {
    if (this.#disposed) return EMPTY_RESULT;

    const cached = await this.#readCache();
    let result = EMPTY_RESULT;

    if (cached !== undefined) {
      const built = await this.#buildAndSwap(cached.snapshot, 'cache', {
        fetched: false,
        notModified: false,
        state: 'cached',
      });
      if (built !== null) result = built.result;
      else await this.#store.clear();
    }

    const usableCache = result.state === 'cached' ? cached : undefined;

    try {
      const init: RequestOptions = {
        // The snapshot is the one payload where zod validation of every tuple would cost more main
        // -thread time than the request: `indexWorker.ts` validates it off-thread instead. This is
        // what `skipResponseValidation` exists for (`client/rest.ts`, "streaming/large payloads").
        skipResponseValidation: true,
        ...(usableCache === undefined ? {} : { headers: { 'if-none-match': usableCache.etag } }),
        onResponseHeaders: (headers) => {
          this.#lastEtag = headers.etag ?? '';
        },
      };
      this.#lastEtag = '';
      const payload = await this.#options.sdk.search.universeSnapshot({}, init);
      if (this.#disposed) return result;

      // Two ways to arrive here with nothing to rebuild: the SDK's own in-process ETag cache
      // answered a repeat call inside one session, or the server ignored `If-None-Match` and sent
      // the version already indexed. `#lastEtag` is set by `onResponseHeaders`, which the SDK calls
      // only when a body came back — so it distinguishes the two honestly.
      if (usableCache !== undefined && this.#isSameVersion(payload, usableCache.version)) {
        const servedBody = this.#lastEtag !== '';
        return this.#markFresh(result, { notModified: !servedBody, fetched: servedBody });
      }

      const etag = this.#lastEtag;
      const built = await this.#buildAndSwap(payload, 'network', {
        fetched: true,
        notModified: false,
        state: 'fresh',
      });
      if (built === null) return result;

      await this.#store.write({
        version: built.result.version,
        etag: etag === '' ? `"${built.result.version}"` : etag,
        storedAt: this.#now(),
        snapshot: built.snapshot,
      });
      return built.result;
    } catch (error) {
      if (isNotModified(error) && usableCache !== undefined) {
        return this.#markFresh(result, { notModified: true, fetched: false });
      }
      this.#options.onError?.(error);
      return result;
    }
  }

  /** Terminate the worker. The last built index stays readable. */
  dispose(): void {
    this.#disposed = true;
    this.#worker?.terminate();
    this.#worker = null;
  }

  /* -- internals ------------------------------------------------------------------------------ */

  async #readCache(): Promise<CachedSnapshot | undefined> {
    try {
      const record = await this.#store.read();
      if (record === undefined) return undefined;
      if (typeof record.version !== 'string' || record.version === '') return undefined;
      if (typeof record.etag !== 'string' || record.etag === '') return undefined;
      return record;
    } catch (error) {
      this.#options.onError?.(error);
      return undefined;
    }
  }

  /** `true` when a payload the SDK handed back is the version already indexed. */
  #isSameVersion(payload: unknown, version: string): boolean {
    const body = payload as { version?: unknown } | null;
    return body !== null && typeof body === 'object' && body.version === version;
  }

  #markFresh(
    result: UniverseLoadResult,
    patch: { notModified: boolean; fetched: boolean },
  ): UniverseLoadResult {
    this.#state = 'fresh';
    const next: UniverseLoadResult = { ...result, state: 'fresh', ...patch };
    this.#options.onSwap?.(this.#index, next);
    return next;
  }

  /**
   * Decode in the worker, build on the main thread, swap by assignment.
   *
   * Returns `null` when the payload yields no entries at all — a rotted cache or a truncated
   * response must not replace a working index with an empty one.
   */
  async #buildAndSwap(
    payload: unknown,
    source: 'cache' | 'network',
    flags: { fetched: boolean; notModified: boolean; state: UniverseIndexState },
  ): Promise<{ result: UniverseLoadResult; snapshot: UniverseSnapshot } | null> {
    const decoded = await this.#decode(payload);
    if (decoded === null) return null;
    if (decoded.stats.size === 0) return null;

    // The swap: one build, one assignment. Measured because CLIENT §16.1 budgets it.
    const started = this.#clock();
    const index = UniverseIndex.build(decoded.snapshot, { mru: this.#mru });
    this.#index = index;
    this.#state = flags.state;
    const swapMs = this.#clock() - started;

    const result: UniverseLoadResult = {
      state: flags.state,
      version: index.version,
      size: index.size,
      source,
      fetched: flags.fetched,
      notModified: flags.notModified,
      stats: decoded.stats,
      swapMs,
    };
    this.#options.onSwap?.(index, result);
    return { result, snapshot: decoded.snapshot };
  }

  /** One worker round trip. `null` when the worker failed; the caller keeps the current index. */
  #decode(payload: unknown): Promise<{ snapshot: UniverseSnapshot; stats: DecodeStats } | null> {
    const worker = this.#ensureWorker();
    if (worker === null) return Promise.resolve(null);

    this.#requestId += 1;
    const requestId = this.#requestId;

    return new Promise((resolve) => {
      const settle = (value: { snapshot: UniverseSnapshot; stats: DecodeStats } | null): void => {
        worker.onmessage = null;
        worker.onerror = null;
        resolve(value);
      };
      worker.onmessage = (event): void => {
        const response = event.data;
        if (response.requestId !== requestId) return;
        if (response.type === 'failed') {
          this.#options.onError?.(new Error(`universe index worker: ${response.message}`));
          settle(null);
          return;
        }
        settle({ snapshot: response.snapshot, stats: response.stats });
      };
      worker.onerror = (event): void => {
        this.#options.onError?.(event);
        settle(null);
      };
      worker.postMessage({ type: 'decode', requestId, payload });
    });
  }

  #ensureWorker(): IndexWorkerPort | null {
    if (this.#disposed) return null;
    if (this.#worker === null) {
      try {
        this.#worker = this.#createWorker();
      } catch (error) {
        this.#options.onError?.(error);
        this.#worker = inlineWorkerPort();
      }
    }
    return this.#worker;
  }
}
