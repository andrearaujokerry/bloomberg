/**
 * `partitionMaintenance` — the nightly partition horizon and the licence-driven drop.
 *
 * PROVIDERS §13 row: `id 'partitionMaintenance'`, no `provider`, schedule `'0 1 * * *'`,
 * target set "next month's partitions for `bars_daily`, `bars_intraday`, `quote_ticks`,
 * `option_quotes`, `access_log`, `usage_events`; drops beyond `retention_days` (STOR-07)",
 * `priority 3`, `timeoutMs 300000`. WORKPLAN WP-05 L816-825.
 *
 * ## What it does
 *
 * Two passes over the six partitioned parents of `db/partitions.ts#partitionPlans`:
 *
 *  1. `ensurePartitions(table)` — create every partition from the current unit to the plan's
 *     horizon (`aheadUnits`: 7 days for the two tick tables, 2 months for the monthly ones, 1 year
 *     for `bars_daily`), draining any row already parked in `<table>_default` into the new
 *     partition before it is attached. A non-empty default partition that cannot be drained — the
 *     two WORM tables, whose 15.d trigger blocks the `DELETE` for every role including the owner —
 *     is reported in `blocked` and raises `dq_events.kind = 'default_partition_nonempty'`
 *     (PROVIDERS §14.5).
 *  2. `dropExpired(table)` — drop every partition whose upper bound is at or before
 *     `now − retention`, where **retention comes only from `licence_registry.retention_days`**
 *     (STOR-07), raised to the table's regulatory floor where it has one. An open `legal_holds`
 *     row covering the partition's range keeps it alive (MSG-02) and the partition is reported in
 *     `heldBack` rather than dropped.
 *
 * ## Retention inputs (STOR-07) — there is no number in this file
 *
 * Exactly three licence rows carry a `retention_days`, one per licensed market-data table:
 * `cboe.quotes` **30** → `quote_ticks`, `cboe.options` **10** → `option_quotes`, `yahoo.chart`
 * **400** → `bars_intraday` (PROVIDERS §15). `access_log` and `usage_events` carry no licence
 * source at all and are governed by their own regulatory floors (2557 and 730 days, ENTL-04 /
 * REG-01) which a licence may raise but never lower. `bars_daily` is unlimited: the daily history
 * is the long series. All of that lives in `partitionPlans` and `resolveRetention`; this job
 * states none of it, which is what makes the licence row the single source of truth.
 *
 * ## Connections
 *
 * The DDL runs on `db/client.ts#withMaintTx` — the `terminal_maint` role, which owns the six
 * parents. `terminal_app` can neither `CREATE` a partition (no CREATE on schema `public`) nor
 * `DROP` one (not the owner), so the job cannot be run on the application pool by accident
 * (DATA_MODEL §15.d.1). `db/partitions.ts` switches connections internally: the licence read, the
 * legal-hold check, the `dq_events` row and the `ingest_runs` audit rows run on the application
 * pool, because `terminal_maint` has no privileges on those tables.
 *
 * That is why `IngestJob.transactional` is **false** here. The scheduler must not open an
 * application-pool transaction around a job whose real work is DDL on another connection: the
 * `DROP TABLE` would commit outside it and the two would disagree about what happened.
 */

import {
  PARTITIONED_TABLES,
  dropExpired,
  ensurePartitions,
  partitionPlans,
} from '../../db/partitions.js';

import type {
  DropExpiredResult,
  EnsurePartitionsResult,
  PartitionTable,
} from '../../db/partitions.js';
import type { IngestLogger, JobError, JobResult } from '../scheduler.js';
import type { Clock } from '@terminal/core';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The §13 row
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `IngestJob.id` and `ingest_runs.job_id` — the module basename (PROVIDERS §13). */
export const PARTITION_MAINTENANCE_JOB_ID = 'partitionMaintenance';

/** 01:00 America/New_York, every day. */
export const PARTITION_MAINTENANCE_SCHEDULE = '0 1 * * *';

export const PARTITION_MAINTENANCE_TIMEOUT_MS = 300_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Context and result
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The slice of `JobContext` a maintenance job uses. There is deliberately **no `tx`**: every
 * statement this job issues is opened by `db/partitions.ts` on the connection that is allowed to
 * issue it, and a transaction handed down from the scheduler could only be the wrong one.
 */
export interface MaintenanceJobContext {
  clock: Clock;
  log?: IngestLogger;
  /** OPS-07 — carried into the log lines so a nightly run is greppable by trace. */
  traceId?: string;
  /** `ingest_runs.run_id` when the scheduler is the caller. */
  runId?: number;
}

export interface PartitionMaintenanceOptions {
  /** Restrict the run to these parents. Default: all six. */
  readonly tables?: readonly PartitionTable[];
  /** Override every plan's horizon — WORKPLAN's `ensurePartitions(table, horizonMonths)`. */
  readonly aheadUnits?: number;
  /** Skip the drop pass (the horizon alone — what the startup step wants). */
  readonly purge?: boolean;
  /** Report what the drop pass would remove without removing it. */
  readonly dryRun?: boolean;
}

export interface PartitionMaintenanceResult extends JobResult {
  /** One entry per parent, in `PARTITIONED_TABLES` order. */
  readonly ensured: readonly EnsurePartitionsResult[];
  /** One entry per parent when the drop pass ran; empty when `purge` was false. */
  readonly purged: readonly DropExpiredResult[];
  /** Every partition created, across all parents. */
  readonly created: readonly string[];
  /** Every partition dropped, across all parents. */
  readonly dropped: readonly string[];
  /** Expired partitions an open `legal_holds` row protected (MSG-02). */
  readonly heldBack: readonly string[];
  /** `dq_events.dq_id` raised for a non-empty default partition. */
  readonly dqIds: readonly number[];
}

function emptyResult(): {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: JobError[];
  provenanceIds: number[];
} {
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0, errors: [], provenanceIds: [] };
}

/**
 * The `JobError` written into `ingest_runs.errors` for a failed pass.
 *
 * Drizzle wraps every pg error: the thrown `DrizzleQueryError` has `message` = `'Failed query:
 * CREATE TABLE …'` and no `code`, and the SQLSTATE that tells an operator whether this was `42501`
 * (wrong role) or `42P17` (bound overlap) sits on `.cause`. Reading `err.code` directly produced
 * run rows whose code was the literal string `'Error'`, which is the one thing a run row must not
 * be — so the chain is walked for the first SQLSTATE, and every distinct message in it is kept.
 */
function errorOf(err: unknown): { code: string; message: string } {
  const messages: string[] = [];
  let code: string | undefined;
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < 16; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) break;
    seen.add(current);
    const link = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (code === undefined && typeof link.code === 'string' && link.code !== '') code = link.code;
    if (typeof link.message === 'string' && link.message !== '' && !messages.includes(link.message))
      messages.push(link.message);
    current = link.cause;
  }
  if (messages.length === 0) return { code: code ?? 'UNKNOWN', message: String(err) };
  return {
    code: code ?? (err instanceof Error ? err.name : 'UNKNOWN'),
    message: messages.join(': '),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Extend the horizon and drop what the licence says may go.
 *
 * One parent's failure does not abort the run: a locked table, a WORM default partition or a
 * missing maintenance connection is recorded as a `JobError` and the remaining parents are still
 * maintained, because a run that stops at `bars_daily` leaves `quote_ticks` without tomorrow's
 * partition and the next insert fails into the default.
 *
 * The counters are the ones `ingest_runs` stores, read for this job as:
 * `fetched` = parents visited, `inserted` = partitions created, `updated` = rows relocated out of
 * a default partition, `skipped` = partitions dropped (objects removed).
 */
export async function runPartitionMaintenance(
  ctx: MaintenanceJobContext,
  options: PartitionMaintenanceOptions = {},
): Promise<PartitionMaintenanceResult> {
  const now = new Date(ctx.clock.now());
  const tables = options.tables ?? PARTITIONED_TABLES;
  const base = emptyResult();

  const ensured: EnsurePartitionsResult[] = [];
  const purged: DropExpiredResult[] = [];
  const created: string[] = [];
  const dropped: string[] = [];
  const heldBack: string[] = [];
  const dqIds: number[] = [];

  for (const table of tables) {
    base.fetched += 1;
    try {
      const ensure = await ensurePartitions(table, {
        now,
        ...(options.aheadUnits === undefined ? {} : { aheadUnits: options.aheadUnits }),
      });
      ensured.push(ensure);
      created.push(...ensure.created);
      base.inserted += ensure.created.length;
      base.updated += ensure.movedRows;
      if (ensure.dqId !== null) dqIds.push(ensure.dqId);
      for (const block of ensure.blocked) {
        base.errors.push({
          code: 'DEFAULT_PARTITION_BLOCKED',
          message:
            `${table}: ${String(block.rowsInDefault)} row(s) in ${table}_default fall inside ` +
            `${block.partition} [${block.lo}, ${block.hi}) and cannot be relocated ` +
            `(${block.reason}) — an operator must move them`,
        });
      }
      ctx.log?.info?.('partition.ensured', {
        job: PARTITION_MAINTENANCE_JOB_ID,
        table,
        created: ensure.created,
        movedRows: ensure.movedRows,
        defaultRowsRemaining: ensure.defaultRowsRemaining,
        ...(ctx.traceId === undefined ? {} : { traceId: ctx.traceId }),
      });
    } catch (err) {
      const { code, message } = errorOf(err);
      base.errors.push({ code, message: `ensurePartitions(${table}): ${message}` });
      ctx.log?.error?.('partition.ensure_failed', {
        job: PARTITION_MAINTENANCE_JOB_ID,
        table,
        code,
        message,
      });
      // The horizon failed, so the drop pass for this parent is skipped too: dropping data on a
      // table we could not extend is the wrong order to fail in.
      continue;
    }

    if (options.purge === false) continue;

    try {
      const drop = await dropExpired(table, {
        now,
        jobId: PARTITION_MAINTENANCE_JOB_ID,
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      });
      purged.push(drop);
      // `drop.dropped` is empty by construction on a dry run, so no guard is needed to keep this
      // job from reporting a destruction that did not happen.
      dropped.push(...drop.dropped);
      base.skipped += drop.dropped.length;
      for (const held of drop.heldBack) heldBack.push(held.partition);
      ctx.log?.info?.('partition.purged', {
        job: PARTITION_MAINTENANCE_JOB_ID,
        table,
        sourceId: drop.retention.sourceId,
        licenceDays: drop.retention.licenceDays,
        floorDays: drop.retention.floorDays,
        retentionDays: drop.retention.retentionDays,
        cutoff: drop.retention.cutoff?.toISOString() ?? null,
        dropped: drop.dropped,
        wouldDrop: drop.wouldDrop,
        heldBack: drop.heldBack.map((h) => h.partition),
        dryRun: drop.dryRun,
        ...(ctx.traceId === undefined ? {} : { traceId: ctx.traceId }),
      });
    } catch (err) {
      const { code, message } = errorOf(err);
      base.errors.push({ code, message: `dropExpired(${table}): ${message}` });
      ctx.log?.error?.('partition.purge_failed', {
        job: PARTITION_MAINTENANCE_JOB_ID,
        table,
        code,
        message,
      });
    }
  }

  return { ...base, ensured, purged, created, dropped, heldBack, dqIds };
}

/**
 * Every parent whose retention is decided by a licence row, with the source that decides it.
 * Exported so an operator screen — and `retentionPurge`'s consistency guard — can show the mapping
 * without restating the three numbers (STOR-07).
 */
export function licenceGovernedTables(): { table: PartitionTable; sourceId: string }[] {
  const out: { table: PartitionTable; sourceId: string }[] = [];
  for (const table of PARTITIONED_TABLES) {
    const sourceId = partitionPlans[table].retentionSourceId;
    if (sourceId !== null) out.push({ table, sourceId });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job table row (PROVIDERS §13)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const job = {
  id: PARTITION_MAINTENANCE_JOB_ID,
  schedule: PARTITION_MAINTENANCE_SCHEDULE,
  priority: 3 as const,
  timeoutMs: PARTITION_MAINTENANCE_TIMEOUT_MS,
  /** The work is DDL on `withMaintTx`; an application-pool transaction around it is meaningless. */
  transactional: false,
  run: (ctx: MaintenanceJobContext): Promise<PartitionMaintenanceResult> =>
    runPartitionMaintenance(ctx),
};
