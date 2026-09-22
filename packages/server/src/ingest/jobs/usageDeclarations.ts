/**
 * `usageDeclarations` — the monthly ENTL-06 declaration run.
 *
 * PROVIDERS §13 shape: `id 'usageDeclarations'` (the module basename, which is what lands in
 * `ingest_runs.job_id`), no `provider` — it reads `access_log`, not a vendor — schedule `'20 3 2 * *'`
 * (03:20 America/New_York on the 2nd of the month, after `partitionMaintenance` at 01:00 and
 * `retentionPurge` at 01:30 have settled the partitions the aggregate reads), `priority 3`,
 * `timeoutMs 120000`.
 *
 * All the thinking lives in `entitlements/declarations.ts`; this module is the *schedule* around
 * it and owns exactly three decisions:
 *
 *  1. **Which month.** By default the calendar month before the run, in UTC — on the 2nd of
 *     October the job declares September. `ctx.month` overrides it for a backfill or a re-run.
 *  2. **One `ingest_runs` row per execution.** When the scheduler drives the job it has already
 *     opened the row and passes its `run_id`, and the job writes none; every other caller — a
 *     re-run from `POST /admin/declarations/generate`, a test — gets the row from here, on the
 *     job's own transaction, the same division `cboeQuotes#withIngestRun` uses.
 *  3. **Idempotency is real, not hoped for.** `generateDeclarations` upserts on the documented
 *     unique key `(month, source_id, firm_id, field_class, tier)`, so a retried or re-run month
 *     updates its rows instead of duplicating them; the run reports `inserted` and `updated`
 *     separately so a second run of a settled month is visibly a no-op.
 *
 * A firm whose declaration does not reconcile with `firms.seat_count` is **not** an error — the
 * declaration is still correct and still owed to the vendor. It is recorded as a `JobError` entry
 * on an otherwise successful run (`code: 'SEAT_EXCESS'`) so it is visible on the ops screen, which
 * is where an under-licensed firm has to be seen before the invoice arrives.
 */

import { sql } from 'drizzle-orm';

import { ingestRuns } from '../../db/schema/ops.js';
import {
  generateDeclarations,
  previousMonthOf,
  type DeclarationResult,
} from '../../entitlements/declarations.js';

import type { Tx } from '../../db/client.js';
import type { IngestLogger, JobError, JobResult } from '../scheduler.js';
import type { Clock } from '@terminal/core';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The §13 row
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const USAGE_DECLARATIONS_JOB_ID = 'usageDeclarations';

/** 03:20 America/New_York on the 2nd of every month — a full day after the month closed. */
export const USAGE_DECLARATIONS_SCHEDULE = '20 3 2 * *';

export const USAGE_DECLARATIONS_TIMEOUT_MS = 120_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Context and result
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What this job needs. A superset of `scheduler.ts`'s `JobContext` in the optional properties
 * only, so the scheduler's context is assignable to it and `collectJobs` accepts the descriptor.
 */
export interface DeclarationJobContext {
  clock: Clock;
  /** The transaction the run reads `access_log` and writes `usage_declarations` in. */
  tx: Tx;
  /** The month to declare, `YYYY-MM` or `YYYY-MM-DD`. Default: the previous UTC month. */
  month?: string;
  log?: IngestLogger;
  traceId?: string;
  /** `ingest_runs.run_id` when the scheduler opened the row; the job then writes none itself. */
  runId?: number;
  /** `false` suppresses the job's own `ingest_runs` row. Default: write one unless `runId` is set. */
  recordRun?: boolean;
}

export interface UsageDeclarationsResult extends JobResult {
  /** The declared month, `YYYY-MM-DD`. */
  readonly month: string;
  readonly declaration: DeclarationResult;
  /** `ingest_runs.run_id` of this execution, whoever opened it. */
  readonly runId: number | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Generate one month.
 *
 * Counters as `ingest_runs` reads them: `fetched` = declaration rows the aggregate produced,
 * `inserted` / `updated` = rows created / refreshed by the upsert, `skipped` = 0 (nothing is
 * declined; a month with no access is simply a month with no rows).
 */
export async function runUsageDeclarations(
  ctx: DeclarationJobContext,
): Promise<UsageDeclarationsResult> {
  const month = ctx.month ?? previousMonthOf(ctx.clock.now());
  const own = ctx.recordRun ?? ctx.runId === undefined;
  const startedAt = new Date(ctx.clock.now());

  let runId = ctx.runId;
  if (own) {
    const started = await ctx.tx
      .insert(ingestRuns)
      .values({
        jobId: USAGE_DECLARATIONS_JOB_ID,
        sourceId: null,
        startedAt,
        status: 'running',
        traceId: ctx.traceId ?? null,
      })
      .returning({ runId: ingestRuns.runId });
    runId = started[0]?.runId;
    if (runId === undefined) {
      throw new Error(`ingest_runs insert returned no run_id for ${USAGE_DECLARATIONS_JOB_ID}`);
    }
  }

  // No try/catch: a statement that raises aborts this transaction, so the UPDATE below would fail
  // with 25P02 and mask the real error. The `running` row was opened inside the same transaction
  // and rolls back with it — a run that wrote nothing leaves no record, which is honest. When the
  // scheduler owns the row it records the failure from its own transaction.
  const declaration = await generateDeclarations({ db: ctx.tx, clock: ctx.clock }, month);

  const errors: JobError[] = declaration.seatExcess.map((excess) => ({
    code: 'SEAT_EXCESS',
    message:
      `firm ${String(excess.firmId)} declared ${String(excess.maxDistinctUsers)} distinct user(s) ` +
      `against ${String(excess.seatCount)} seat(s) in ${declaration.month} ` +
      `(${excess.sources.join(', ')}) — ENTL-06 reconciliation`,
  }));

  const result: UsageDeclarationsResult = {
    fetched: declaration.rows.length,
    inserted: declaration.inserted,
    updated: declaration.updated,
    skipped: 0,
    errors,
    provenanceIds: [],
    month: declaration.month,
    declaration,
    runId,
  };

  if (own && runId !== undefined) {
    await ctx.tx
      .update(ingestRuns)
      .set({
        // A seat excess is a finding about a customer's licensing, not a failure of the run: the
        // declaration was produced and stored. `ok` with the finding in `errors` is what the ops
        // screen needs to show both facts at once.
        status: 'ok',
        finishedAt: new Date(ctx.clock.now()),
        fetched: result.fetched,
        inserted: result.inserted,
        updated: result.updated,
        skipped: result.skipped,
        errors: result.errors,
      })
      .where(sql`${ingestRuns.runId} = ${runId}`);
  }

  ctx.log?.info?.('declarations.generated', {
    job: USAGE_DECLARATIONS_JOB_ID,
    month: declaration.month,
    rows: declaration.rows.length,
    inserted: declaration.inserted,
    updated: declaration.updated,
    querySqlHash: declaration.querySqlHash,
    seatExcess: declaration.seatExcess.length,
    ...(ctx.traceId === undefined ? {} : { traceId: ctx.traceId }),
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job table row (PROVIDERS §13)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const job = {
  id: USAGE_DECLARATIONS_JOB_ID,
  schedule: USAGE_DECLARATIONS_SCHEDULE,
  priority: 3 as const,
  timeoutMs: USAGE_DECLARATIONS_TIMEOUT_MS,
  run: (ctx: DeclarationJobContext): Promise<UsageDeclarationsResult> => runUsageDeclarations(ctx),
};
