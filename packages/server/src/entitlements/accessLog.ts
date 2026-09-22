/**
 * `entitlements/accessLog.ts` — THE writer of `access_log` (ENTL-04, ARCHITECTURE §10 rule 9,
 * REG-01).
 *
 * One row per `(user, instrument, field, decision)`, carrying the usage, the purpose, the requested
 * and granted tiers, the reason code and the trace id. The evaluator calls `append()` from the
 * request path and the plant calls it from fan-out, so `append()` is **synchronous and never
 * awaits**: it pushes onto an in-memory ring and returns a provisional id. Rows reach Postgres on
 * the 1 s timer, at 5 000 buffered rows, or at `stop()` — never on the response path.
 *
 * `access_log` is WORM (migration 0015): `terminal_app` holds SELECT and INSERT and nothing else,
 * and the `access_log_worm` trigger blocks UPDATE and DELETE even for the owner role. So this
 * module only ever inserts. A failed flush puts its batch back in front of whatever arrived while
 * it was in flight and the next flush retries it in order; a row is counted as `dropped` only when
 * `stop()` cannot write it and the process is going away regardless.
 *
 * The table is range-partitioned by month, so `ts` decides the partition: migration 0016 ships
 * `access_log_m2026_09`, `_m2026_10` and `_m2026_11` plus `access_log_default`, and
 * `db/partitions.ts` creates the rest ahead of time.
 *
 * Both uuid columns are validated here rather than trusted. A `session_id` or `trace_id` that is
 * not a uuid would make Postgres reject the whole multi-row INSERT, and a retry would reject it
 * again: one malformed caller would stop the audit log for everyone. Such a value is stored as
 * `NULL` in the column and preserved verbatim under `details._sessionId` / `details._traceId`, so
 * the row is still written and nothing is lost.
 */

import type { Clock, FieldClass, FieldId, ReasonCode, Tier, UsageType } from '@terminal/core';

import { currentTx, runWithTx, withTx, type Db, type Tx } from '../db/client.js';
import { accessLog as accessLogTable } from '../db/schema/entitlements.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `access_log` row, as the evaluator produces it. `ts` is epoch ms from the injected clock. */
export interface AccessLogRow {
  ts: number;
  userId: number;
  firmId: number;
  sessionId: string;
  /** `null` for a non-instrument read (the econ series id belongs in `details`). */
  instrumentId: number | null;
  fieldId: FieldId;
  fieldClass: FieldClass;
  sourceId: string;
  requestedTier: Tier;
  /** The granted tier; `null` on a deny. */
  tier: Tier | null;
  usage: UsageType;
  /** Function code | route id | `ws.sub`. */
  purpose: string;
  decision: 'allow' | 'downgrade' | 'deny';
  reason: ReasonCode;
  traceId: string;
  details?: Record<string, unknown>;
}

/** An opaque handle from {@link AccessLogTimers.setInterval}. */
export type AccessLogTimerHandle = unknown;

/**
 * The scheduling port. Production passes the platform timers; a test passes a manual queue and
 * decides when the 1 s flush tick has elapsed.
 */
export interface AccessLogTimers {
  setInterval(fn: () => void, ms: number): AccessLogTimerHandle;
  clearInterval(handle: AccessLogTimerHandle): void;
}

/** The platform timers, unref'd so a pending flush tick never holds the process open. */
export const systemIntervalTimers: AccessLogTimers = {
  setInterval(fn: () => void, ms: number): AccessLogTimerHandle {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval(handle: AccessLogTimerHandle): void {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface AccessLogStats {
  buffered: number;
  written: number;
  flushes: number;
  /** Rows abandoned at `stop()` because the final flush could not write them. */
  dropped: number;
}

export interface AccessLog {
  /**
   * Queue one row. NEVER awaits.
   *
   * Returns a provisional handle: a per-writer sequence starting at 1, NOT the eventual
   * `access_log.log_id`. The row has not reached Postgres yet, so its real id does not exist; a
   * caller that needs it must read the table back by `(ts, user_id, trace_id)`.
   */
  append(row: AccessLogRow): number;
  /** Bulk-insert everything buffered. Resolves with the number of rows written. */
  flush(): Promise<number>;
  /** Rows buffered and not yet written. */
  size(): number;
  /** Arm the flush timer. Idempotent. */
  start(): void;
  /** Disarm the timer and flush what is left. */
  stop(): Promise<void>;
  stats(): AccessLogStats;
}

export interface AccessLogDeps {
  db: Db | Tx;
  clock: Clock;
  timers?: AccessLogTimers;
  /** Flush cadence in ms (ENTL-04: 1 s). */
  flushMs?: number;
  /** Buffered rows that trigger an eager flush from `append()` (ENTL-04: 5 000). */
  maxRows?: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** ENTL-04. */
const DEFAULT_FLUSH_MS = 1_000;
/** ENTL-04. */
const DEFAULT_MAX_ROWS = 5_000;

/**
 * Rows per INSERT. The row has 16 columns, so Postgres' 65 535 bind-parameter cap is reached at
 * 4 095 rows; 500 stays an order of magnitude inside it and keeps each statement short.
 */
const INSERT_CHUNK = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What `source_id` holds when rule 1 resolved no source at all (a `FIELD_UNKNOWN` deny carries
 * `sourceId: ''`, because `FieldDecision.sourceId` is a plain `string` in the core type).
 *
 * `access_log.source_id` is `text NOT NULL` (migration 0011), so `NULL` is not available and the
 * empty string would be both meaningless and indistinguishable from a source whose id was lost.
 * This value cannot collide with a real source: every `licence_registry.source_id` is a dotted
 * `publisher.endpoint` token, and the parentheses are not legal in one. The ENTL-06 declarations
 * never see it — they exclude `decision = 'deny'`, and a field with no source is always a deny —
 * so it can never become a phantom source bucket in a monthly declaration.
 */
export const NO_SOURCE = '(unresolved)';

/** The insert payload of one row — `typeof accessLogTable.$inferInsert` without the defaults. */
interface InsertRow {
  ts: Date;
  userId: number;
  firmId: number;
  sessionId: string | null;
  instrumentId: number | null;
  fieldId: string;
  fieldClass: FieldClass;
  sourceId: string;
  requestedTier: Tier;
  tier: Tier | null;
  usage: UsageType;
  purpose: string;
  decision: 'allow' | 'downgrade' | 'deny';
  reason: string;
  traceId: string | null;
  details: Record<string, unknown> | null;
}

/** Bind `fn` to the transaction in scope (a savepoint) or open one on the injected handle. */
function inTx<T>(db: Db | Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (currentTx() !== undefined) return withTx(null, fn);
  return db.transaction((tx) => runWithTx(tx, () => fn(tx)));
}

/** Map an appended row to the `access_log` row it becomes. Pure; exported for the tests. */
export function insertRow(row: AccessLogRow): InsertRow {
  const sessionOk = UUID_RE.test(row.sessionId);
  const traceOk = UUID_RE.test(row.traceId);
  let details: Record<string, unknown> | null =
    row.details === undefined ? null : { ...row.details };
  if (!sessionOk || !traceOk) {
    details ??= {};
    if (!sessionOk) details._sessionId = row.sessionId;
    if (!traceOk) details._traceId = row.traceId;
  }
  return {
    ts: new Date(row.ts),
    userId: row.userId,
    firmId: row.firmId,
    sessionId: sessionOk ? row.sessionId : null,
    instrumentId: row.instrumentId,
    fieldId: row.fieldId,
    fieldClass: row.fieldClass,
    sourceId: row.sourceId === '' ? NO_SOURCE : row.sourceId,
    requestedTier: row.requestedTier,
    tier: row.tier,
    usage: row.usage,
    purpose: row.purpose,
    decision: row.decision,
    reason: row.reason,
    traceId: traceOk ? row.traceId : null,
    details,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The writer
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function accessLog(deps: AccessLogDeps): AccessLog {
  const { db } = deps;
  const timers = deps.timers ?? systemIntervalTimers;
  const flushMs = deps.flushMs ?? DEFAULT_FLUSH_MS;
  const maxRows = deps.maxRows ?? DEFAULT_MAX_ROWS;
  if (!Number.isFinite(flushMs) || flushMs <= 0) {
    throw new RangeError(
      `accessLog: flushMs must be a positive number of ms, got ${String(flushMs)}`,
    );
  }
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new RangeError(`accessLog: maxRows must be a positive integer, got ${String(maxRows)}`);
  }

  let buffer: InsertRow[] = [];
  let nextLogId = 1;
  /** The armed interval, or `undefined` when the timer is not running. */
  let handle: AccessLogTimerHandle = undefined;
  /** Serialises flushes so two overlapping calls cannot reorder or duplicate rows. */
  let chain: Promise<void> = Promise.resolve();
  const counters = { written: 0, flushes: 0, dropped: 0 };

  async function writeBatch(tx: Tx, batch: readonly InsertRow[]): Promise<void> {
    for (let i = 0; i < batch.length; i += INSERT_CHUNK) {
      await tx.insert(accessLogTable).values(batch.slice(i, i + INSERT_CHUNK));
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

  /** A flush nobody awaits (the timer tick, the 5 000-row trigger). Never throws at the caller. */
  function flushInBackground(why: string): void {
    void flush().catch((err: unknown) => {
      // The batch is still buffered and the next tick retries it; say so once, loudly enough to
      // show up in the logs without taking the process down.
      process.emitWarning(
        `access_log ${why} flush failed, ${String(buffer.length)} rows retained: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  return {
    append(row: AccessLogRow): number {
      const logId = nextLogId++;
      buffer.push(insertRow(row));
      if (buffer.length >= maxRows) flushInBackground('threshold');
      return logId;
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
        // Last chance gone: the rows are abandoned with the process, and the count says how many.
        counters.dropped += buffer.length;
        buffer = [];
      }
    },

    stats(): AccessLogStats {
      return {
        buffered: buffer.length,
        written: counters.written,
        flushes: counters.flushes,
        dropped: counters.dropped,
      };
    },
  };
}
