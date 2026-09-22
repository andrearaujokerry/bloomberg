/**
 * `observability/usageEvents.ts` — THE batched writer of `usage_events` (FUNC-04,
 * ARCHITECTURE §11 L1213-1217).
 *
 * One row per product action: a function launch, a parameter change, a page, an export, a HELP
 * press, a search selection, a command parse error, a panel switch and the four WS events. The
 * runner and the gateway call `enqueue()` from the request path, so — exactly like WP-07's
 * `entitlements/accessLog.ts`, whose shape this deliberately mirrors — **`enqueue()` is
 * synchronous and never awaits**: it pushes onto an in-memory buffer and returns. Rows reach
 * Postgres on the 1 s timer, at `maxRows` buffered rows, or at `stop()`.
 *
 * `usage_events` is WORM (migration 0015): `terminal_app` holds SELECT and INSERT and nothing
 * else, and the `usage_events_worm` trigger blocks UPDATE and DELETE even for the owner. So this
 * module only ever inserts. A failed flush puts its batch back in front of whatever arrived while
 * it was in flight and the next flush retries it in order.
 *
 * **`kind` is validated here, not by Postgres.** `usage_events_kind_check` (migration 0014) lists
 * exactly twelve values, and the table is written in multi-row batches: one bad `kind` would make
 * Postgres reject the whole INSERT, and the retry would reject it again — one careless caller
 * would stop the product analytics of every other caller. {@link enqueue} therefore throws on an
 * unknown kind at the call site, where the stack points at the culprit, and the buffer stays
 * clean. The two uuid columns are validated for the same reason (a malformed value is preserved
 * under `details._sessionId` / `details._traceId` rather than dropped).
 *
 * The table is range-partitioned by month, so `ts` decides the partition.
 */

import { canonicalJson, sha256Hex, type Clock } from '@terminal/core';

import { currentTx, runWithTx, withTx, type Db, type Tx } from '../db/client.js';
import { usageEvents as usageEventsTable } from '../db/schema/ops.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The twelve values of `usage_events_kind_check` (migration 0014), in the order ARCHITECTURE §11
 * L1213 lists them. This array IS the check constraint: `test/integration/observability/usage.test.ts`
 * reads the constraint out of `pg_constraint` and asserts the two agree.
 */
export const USAGE_EVENT_KINDS = [
  'fn.launch',
  'fn.param',
  'fn.page',
  'fn.export',
  'fn.help',
  'search.select',
  'cmd.parse_error',
  'panel.switch',
  'ws.subscribe',
  'ws.slow',
  'ws.resync',
  'ticket.open',
] as const;

export type UsageEventKind = (typeof USAGE_EVENT_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set<string>(USAGE_EVENT_KINDS);

/** True when `value` is one of the twelve. */
export function isUsageEventKind(value: unknown): value is UsageEventKind {
  return typeof value === 'string' && KIND_SET.has(value);
}

/** One `usage_events` row as a caller produces it. `ts` is epoch ms from the injected clock. */
export interface UsageEventRow {
  ts: number;
  userId: number;
  firmId: number;
  /** The session uuid; `null` for a server-originated event outside a session. */
  sessionId?: string | null;
  panelId?: string | null;
  kind: UsageEventKind;
  /** Function code, for the `fn.*` kinds. */
  code?: string | null;
  /** `sha256Hex(canonicalJson(params))` — 64 lower-case hex. Use {@link paramsHash}. */
  paramsHash?: string | null;
  instrumentId?: number | null;
  durationMs?: number | null;
  traceId?: string | null;
  details?: Record<string, unknown>;
}

/** An opaque handle from {@link UsageEventTimers.setInterval}. */
export type UsageEventTimerHandle = unknown;

/** The scheduling port; a test passes a manual queue and decides when the tick elapses. */
export interface UsageEventTimers {
  setInterval(fn: () => void, ms: number): UsageEventTimerHandle;
  clearInterval(handle: UsageEventTimerHandle): void;
}

/** The platform timers, unref'd so a pending flush tick never holds the process open. */
export const systemIntervalTimers: UsageEventTimers = {
  setInterval(fn: () => void, ms: number): UsageEventTimerHandle {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval(handle: UsageEventTimerHandle): void {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface UsageEventsStats {
  buffered: number;
  written: number;
  flushes: number;
  /** Rows abandoned at `stop()` because the final flush could not write them. */
  dropped: number;
}

export interface UsageEvents {
  /**
   * Queue one row. NEVER awaits.
   *
   * Returns a provisional handle: a per-writer sequence starting at 1, NOT the eventual
   * `usage_events.event_id`, which does not exist until the row reaches Postgres.
   *
   * @throws RangeError when `kind` is not one of {@link USAGE_EVENT_KINDS}, or `paramsHash` is not
   *         64 lower-case hex — both before the row can poison a batch.
   */
  enqueue(row: UsageEventRow): number;
  /** Bulk-insert everything buffered. Resolves with the number of rows written. */
  flush(): Promise<number>;
  /** Rows buffered and not yet written. */
  size(): number;
  /** Arm the flush timer. Idempotent. */
  start(): void;
  /** Disarm the timer and flush what is left. */
  stop(): Promise<void>;
  stats(): UsageEventsStats;
}

export interface UsageEventsDeps {
  db: Db | Tx;
  clock: Clock;
  timers?: UsageEventTimers;
  /** Flush cadence in ms (ARCHITECTURE §11: 1 s, as for `access_log`). */
  flushMs?: number;
  /** Buffered rows that trigger an eager flush from `enqueue()`. */
  maxRows?: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_FLUSH_MS = 1_000;
/** The `access_log` figure (ENTL-04); the two writers run side by side and behave the same. */
const DEFAULT_MAX_ROWS = 5_000;

/**
 * Rows per INSERT. The row has 12 written columns, so Postgres' 65 535 bind-parameter cap is
 * reached at 5 461 rows; 500 stays well inside it and keeps each statement short.
 */
const INSERT_CHUNK = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// params_hash
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * FUNC-04's `usage_events.params_hash`: `sha256Hex(canonicalJson(params))`, the same pair ANAL-08
 * uses for `inputs_hash`. Canonical JSON sorts object keys, so `{a:1,b:2}` and `{b:2,a:1}` are one
 * hash and the 30-day roadmap query groups a parameter set rather than a key order.
 */
export function paramsHash(params: unknown): string {
  return sha256Hex(canonicalJson(params));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row mapping
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The insert payload of one row. */
interface InsertRow {
  ts: Date;
  userId: number;
  firmId: number;
  sessionId: string | null;
  panelId: string | null;
  kind: string;
  code: string | null;
  paramsHash: string | null;
  instrumentId: number | null;
  durationMs: number | null;
  traceId: string | null;
  details: Record<string, unknown>;
}

/** Bind `fn` to the transaction in scope (a savepoint) or open one on the injected handle. */
function inTx<T>(db: Db | Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (currentTx() !== undefined) return withTx(null, fn);
  return db.transaction((tx) => runWithTx(tx, () => fn(tx)));
}

/**
 * Map an enqueued row to the `usage_events` row it becomes, rejecting what Postgres would reject.
 * Pure; exported for the tests.
 */
export function insertRow(row: UsageEventRow): InsertRow {
  if (!isUsageEventKind(row.kind)) {
    throw new RangeError(
      `usageEvents: kind ${JSON.stringify(row.kind)} is not one of the twelve values of ` +
        `usage_events_kind_check (${USAGE_EVENT_KINDS.join(', ')})`,
    );
  }
  const hash = row.paramsHash ?? null;
  if (hash !== null && !SHA256_HEX_RE.test(hash)) {
    throw new RangeError(
      `usageEvents: paramsHash must be 64 lower-case hex characters ` +
        `(sha256Hex(canonicalJson(params))), got ${JSON.stringify(hash)}`,
    );
  }
  if (!Number.isFinite(row.ts)) {
    throw new RangeError(`usageEvents: ts must be epoch milliseconds, got ${String(row.ts)}`);
  }

  const sessionId = row.sessionId ?? null;
  const traceId = row.traceId ?? null;
  const sessionOk = sessionId === null || UUID_RE.test(sessionId);
  const traceOk = traceId === null || UUID_RE.test(traceId);
  const details: Record<string, unknown> = { ...row.details };
  if (!sessionOk) details._sessionId = sessionId;
  if (!traceOk) details._traceId = traceId;

  return {
    ts: new Date(row.ts),
    userId: row.userId,
    firmId: row.firmId,
    sessionId: sessionOk ? sessionId : null,
    panelId: row.panelId ?? null,
    kind: row.kind,
    code: row.code ?? null,
    paramsHash: hash,
    instrumentId: row.instrumentId ?? null,
    durationMs: row.durationMs ?? null,
    traceId: traceOk ? traceId : null,
    details,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The writer
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function usageEvents(deps: UsageEventsDeps): UsageEvents {
  const { db } = deps;
  const timers = deps.timers ?? systemIntervalTimers;
  const flushMs = deps.flushMs ?? DEFAULT_FLUSH_MS;
  const maxRows = deps.maxRows ?? DEFAULT_MAX_ROWS;
  if (!Number.isFinite(flushMs) || flushMs <= 0) {
    throw new RangeError(
      `usageEvents: flushMs must be a positive number of ms, got ${String(flushMs)}`,
    );
  }
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new RangeError(`usageEvents: maxRows must be a positive integer, got ${String(maxRows)}`);
  }

  let buffer: InsertRow[] = [];
  let nextHandle = 1;
  let handle: UsageEventTimerHandle = undefined;
  /** Serialises flushes so two overlapping calls cannot reorder or duplicate rows. */
  let chain: Promise<void> = Promise.resolve();
  const counters = { written: 0, flushes: 0, dropped: 0 };

  async function writeBatch(tx: Tx, batch: readonly InsertRow[]): Promise<void> {
    for (let i = 0; i < batch.length; i += INSERT_CHUNK) {
      await tx.insert(usageEventsTable).values(batch.slice(i, i + INSERT_CHUNK));
    }
  }

  async function flushOnce(): Promise<number> {
    if (buffer.length === 0) return 0;
    const batch = buffer;
    buffer = [];
    try {
      await inTx(db, (tx) => writeBatch(tx, batch));
    } catch (err) {
      // Nothing was written (one transaction, all or nothing). Put the batch back in FRONT of
      // whatever arrived while it was in flight so the next flush retries it in order.
      buffer = [...batch, ...buffer];
      throw err;
    }
    counters.written += batch.length;
    counters.flushes += 1;
    return batch.length;
  }

  /** Queue `flushOnce` behind whatever is already running, successful or not. */
  function flush(): Promise<number> {
    const next = chain.then(flushOnce, flushOnce);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** A flush nobody awaits (the timer tick, the `maxRows` trigger). Never throws at the caller. */
  function flushInBackground(why: string): void {
    void flush().catch((err: unknown) => {
      process.emitWarning(
        `usage_events ${why} flush failed, ${String(buffer.length)} rows retained: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  return {
    enqueue(row: UsageEventRow): number {
      // Throws BEFORE the buffer is touched: a rejected row never joins a batch.
      const mapped = insertRow(row);
      const id = nextHandle++;
      buffer.push(mapped);
      if (buffer.length >= maxRows) flushInBackground('threshold');
      return id;
    },

    flush,

    size(): number {
      return buffer.length;
    },

    start(): void {
      if (handle !== undefined) return;
      handle = timers.setInterval(() => {
        if (buffer.length > 0) flushInBackground('timer');
      }, flushMs);
    },

    async stop(): Promise<void> {
      if (handle !== undefined) {
        timers.clearInterval(handle);
        handle = undefined;
      }
      try {
        await flush();
      } catch {
        counters.dropped += buffer.length;
        buffer = [];
      }
    },

    stats(): UsageEventsStats {
      return {
        buffered: buffer.length,
        written: counters.written,
        flushes: counters.flushes,
        dropped: counters.dropped,
      };
    },
  };
}
