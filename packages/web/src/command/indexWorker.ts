// packages/web/src/command/indexWorker.ts — the Worker half of the local universe index
// (FUNCTIONS.md §3.1 L875-877, CLIENT.md §1 L77, §16.1 "Universe index build").
//
// The snapshot is ≈ 36 k instruments plus functions, people and topics: decoding it, checking every
// tuple and building the index are all main-thread-blocking if they happen on the main thread, and
// the keystroke path has 16 ms in total. So this module runs in a dedicated Worker and does
// everything that can legally cross a `postMessage` boundary:
//
//   1. `normaliseSnapshot` — shape-checks every tuple and drops the malformed ones. The main thread
//      asks `RestClient` to skip response validation for this one route (`skipResponseValidation`,
//      which exists for exactly this case), so this is where the payload is actually validated.
//   2. a real `UniverseIndex.build` — off the main thread, timed, and counted. Its purpose is not to
//      produce the index the shell uses (see the note below) but to answer, before anything is
//      swapped in, "does this snapshot build, how long does it take, and how many entries does it
//      yield?". A cached snapshot that has rotted to zero entries is rejected here, and the
//      §16.1 budget (< 300 ms for 45 k rows) is measured here.
//
// ── Why the built index does not come back over the wire ──────────────────────────────────────
// `UniverseIndex` (WP-03, `packages/core/src/command/index.ts`) has a private constructor, `#`
// private fields and `static build(snapshot)` as its only entry point. A class instance with
// private fields is not structured-cloneable, and core exposes no `toTransfer()`/`fromTransfer()`
// pair, so the *object* cannot be posted back — only the snapshot it was built from can. The main
// thread therefore repeats `UniverseIndex.build` on the normalised snapshot in `localIndex.ts`.
// That build is the one main-thread cost that remains, and `localIndex.ts` measures it and reports
// it as `swapMs`. Closing that gap means adding a transferable representation to `packages/core`,
// which is WP-03's module and not WP-12's to edit — it is reported, not patched.
//
// The module is imported by `localIndex.ts` (for `normaliseSnapshot`, the message types and the
// main-thread fallback) and is *also* the Worker entry point. It installs its message listener only
// when it finds itself in a worker scope, so importing it on the main thread is inert.
import { UniverseIndex } from '@terminal/core';
import type {
  AssetClass,
  MarketSector,
  UniverseFunctionTuple,
  UniverseInstrumentTuple,
  UniversePersonTuple,
  UniverseSnapshot,
  UniverseTopicTuple,
} from '@terminal/core';

/* ---------------------------------------------------------------------------------------------- */
/* The message protocol                                                                             */
/* ---------------------------------------------------------------------------------------------- */

/** What the worker did with one snapshot payload. Times are milliseconds, measured in the worker. */
export interface DecodeStats {
  instruments: number;
  functions: number;
  people: number;
  topics: number;
  /** Tuples whose shape did not match and were dropped rather than thrown on. */
  dropped: number;
  /** `normaliseSnapshot` only. */
  decodeMs: number;
  /** `UniverseIndex.build` in the worker — the FUNCTIONS §3.5 / CLIENT §16.1 budget, < 300 ms. */
  buildMs: number;
  /** Entries the build yielded. Zero means the snapshot is unusable. */
  size: number;
}

export interface IndexWorkerRequest {
  type: 'decode';
  /** Echoed back; `localIndex.ts` ignores responses to superseded requests. */
  requestId: number;
  /** The raw body from `GET /universe/snapshot`, or a snapshot read back from IndexedDB. */
  payload: unknown;
}

export type IndexWorkerResponse =
  | { type: 'decoded'; requestId: number; snapshot: UniverseSnapshot; stats: DecodeStats }
  | { type: 'failed'; requestId: number; message: string };

/** The part of `DedicatedWorkerGlobalScope` this module uses (the web tsconfig has no WebWorker lib). */
export interface IndexWorkerScope {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: IndexWorkerResponse): void;
}

/* ---------------------------------------------------------------------------------------------- */
/* Normalisation                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

const isString = (v: unknown): v is string => typeof v === 'string';
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Milliseconds. `performance` exists on the main thread, in a worker and in jsdom; the fallback
 * keeps the module total in a host that has none rather than making the timing a hard dependency.
 */
function nowMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === 'function' ? perf.now() : 0;
}

function instrumentTuple(row: unknown): UniverseInstrumentTuple | null {
  if (!Array.isArray(row) || row.length < 8) return null;
  const [id, ticker, sector, exch, name, assetClass, weight, status] = row as unknown[];
  if (!isFiniteNumber(id) || !isString(ticker) || ticker === '') return null;
  if (!isString(sector) || !isString(exch) || !isString(name)) return null;
  if (!isString(assetClass) || assetClass === '') return null;
  // `marketSector` and `assetClass` are enums on the wire (`wire/rest/search.ts`). They are
  // accepted here as non-empty strings and narrowed by assertion: the server's schema is
  // authoritative, and `UniverseIndex.build` itself drops a row it cannot classify. Re-deriving the
  // enum membership in the web package would be a second copy of a core/wire fact.
  return [
    id,
    ticker,
    sector as MarketSector,
    exch,
    name,
    assetClass as AssetClass,
    isFiniteNumber(weight) ? weight : 1,
    isFiniteNumber(status) ? status : 1,
  ];
}

function functionTuple(row: unknown): UniverseFunctionTuple | null {
  if (!Array.isArray(row) || row.length < 4) return null;
  const [code, name, aliases, tier] = row as unknown[];
  if (!isString(code) || code === '' || !isString(name)) return null;
  const list = Array.isArray(aliases) ? (aliases as unknown[]).filter(isString) : [];
  return [code, name, list, isFiniteNumber(tier) ? tier : 3];
}

function personTuple(row: unknown): UniversePersonTuple | null {
  if (!Array.isArray(row) || row.length < 3) return null;
  const [id, name, roleFirm] = row as unknown[];
  if (!isFiniteNumber(id) || !isString(name) || name === '') return null;
  return [id, name, isString(roleFirm) ? roleFirm : ''];
}

function topicTuple(row: unknown): UniverseTopicTuple | null {
  if (!Array.isArray(row) || row.length < 2) return null;
  const [code, name] = row as unknown[];
  if (!isString(code) || code === '') return null;
  return [code, isString(name) ? name : code];
}

function collect<T>(rows: unknown, map: (row: unknown) => T | null): { kept: T[]; dropped: number } {
  if (!Array.isArray(rows)) return { kept: [], dropped: 0 };
  const kept: T[] = [];
  let dropped = 0;
  for (const row of rows as unknown[]) {
    const value = map(row);
    if (value === null) dropped += 1;
    else kept.push(value);
  }
  return { kept, dropped };
}

export interface NormaliseResult {
  snapshot: UniverseSnapshot;
  dropped: number;
}

/**
 * Shape-check a `/universe/snapshot` body and drop what does not fit. Never throws: a truncated or
 * rotted payload degrades to a smaller index, and `localIndex.ts` refuses a zero-entry one.
 */
export function normaliseSnapshot(payload: unknown): NormaliseResult {
  const body = (payload ?? {}) as Partial<UniverseSnapshot>;
  const instruments = collect(body.instruments, instrumentTuple);
  const functions = collect(body.functions, functionTuple);
  const people = collect(body.people, personTuple);
  const topics = collect(body.topics, topicTuple);

  return {
    snapshot: {
      version: isString(body.version) ? body.version : '',
      generatedAt: isString(body.generatedAt) ? body.generatedAt : '',
      instruments: instruments.kept,
      functions: functions.kept,
      people: people.kept,
      topics: topics.kept,
    },
    dropped: instruments.dropped + functions.dropped + people.dropped + topics.dropped,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* The worker's one job                                                                             */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Normalise, build once to validate and time it. Pure and synchronous, so the test drives the real
 * worker code without a real `Worker` (jsdom has none).
 */
export function handleDecode(request: IndexWorkerRequest): IndexWorkerResponse {
  try {
    const decodeStart = nowMs();
    const { snapshot, dropped } = normaliseSnapshot(request.payload);
    const decodeMs = nowMs() - decodeStart;

    const buildStart = nowMs();
    const index = UniverseIndex.build(snapshot);
    const buildMs = nowMs() - buildStart;

    return {
      type: 'decoded',
      requestId: request.requestId,
      snapshot,
      stats: {
        instruments: snapshot.instruments.length,
        functions: snapshot.functions.length,
        people: snapshot.people.length,
        topics: snapshot.topics.length,
        dropped,
        decodeMs,
        buildMs,
        size: index.size,
      },
    };
  } catch (err) {
    return {
      type: 'failed',
      requestId: request.requestId,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function isDecodeRequest(value: unknown): value is IndexWorkerRequest {
  if (value === null || typeof value !== 'object') return false;
  const msg = value as Partial<IndexWorkerRequest>;
  return msg.type === 'decode' && isFiniteNumber(msg.requestId);
}

/** Wire `scope` up to `handleDecode`. Returns the uninstaller. */
export function installIndexWorker(scope: IndexWorkerScope): () => void {
  const listener = (event: { data: unknown }): void => {
    if (!isDecodeRequest(event.data)) return;
    scope.postMessage(handleDecode(event.data));
  };
  scope.addEventListener('message', listener);
  return () => {
    scope.removeEventListener('message', listener);
  };
}

/**
 * True in a dedicated worker and false on the main thread, in jsdom and in Node. `WorkerGlobalScope`
 * is not in the web package's `lib` (`DOM`, not `WebWorker`), so the check is structural: a scope
 * with `postMessage` and no `document`.
 */
function inWorkerScope(): boolean {
  const g = globalThis as { document?: unknown; postMessage?: unknown };
  return g.document === undefined && typeof g.postMessage === 'function';
}

if (inWorkerScope()) {
  installIndexWorker(globalThis);
}
