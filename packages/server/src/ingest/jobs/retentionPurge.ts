/**
 * `retentionPurge` — row-level retention for the tables a partition drop cannot reach.
 *
 * PROVIDERS §13 row: `id 'retentionPurge'`, no `provider`, schedule `'30 1 * * *'`, target set
 * "non-partitioned tables with a `retention_days` ceiling", `priority 3`, `timeoutMs 300000`.
 * ARCHITECTURE L1040, WORKPLAN WP-05 L816-825, STOR-07.
 *
 * `partitionMaintenance` runs half an hour earlier and drops whole partitions; this job deletes
 * rows, one bounded batch at a time, from the tables that are not partitioned and therefore have
 * no partition to drop.
 *
 * ## Where a number may come from (STOR-07) — and where it may not
 *
 * There are exactly two lawful sources of a retention period in this system and this file states
 * neither of them as a literal:
 *
 *  1. **`licence_registry.retention_days`** — the only input to a *data* retention decision. A
 *     rule that names a `retentionSourceId` reads its number from the current version of that
 *     licence row and cannot be run if the row is missing. Exactly three licence rows carry a
 *     number in v1 (`cboe.quotes` 30, `cboe.options` 10, `yahoo.chart` 400, PROVIDERS §15) and all
 *     three govern a **partitioned** table, so the licence-driven rule set here is legitimately
 *     empty — a fact {@link auditLicenceCoverage} *checks* on every run rather than assuming, so
 *     that the day a fourth number appears on a licence row and governs nothing, the run says so
 *     instead of silently keeping the data forever.
 *  2. **A REG-04 §19 retention**, which is a legal obligation about *personal* data rather than a
 *     licence ceiling on *market* data. DATA_MODEL §19 names two, and names this job as the thing
 *     that enforces them: `sessions.ip`/`user_agent`/`device_id` — connection metadata kept 90
 *     days after `revoked_at` — and `help_tickets` support content kept two years. They are
 *     declared as `retentionFloorDays` on the rule, exactly as `access_log` (2557) and
 *     `usage_events` (730) declare theirs in `db/partitions.ts#partitionPlans`, and a licence may
 *     raise such a floor but never lower it.
 *
 * Anything else — a hard-coded "keep 90 days of X" anywhere in the codebase — is a STOR-07
 * violation. There is no `retentionDays` parameter on this job's API for the same reason
 * `db/partitions.ts#dropExpired` does not have one.
 *
 * ## Legal holds beat retention (MSG-02)
 *
 * An unreleased `legal_holds` row whose scope overlaps the window a rule would delete stops that
 * rule for the night. The hold is evidence preservation; retention is a ceiling, not an
 * obligation to destroy, so holding data longer is always the safe failure.
 *
 * ## Connections
 *
 * `terminal_app` is granted SELECT/INSERT by default plus the explicit UPDATE and DELETE lists of
 * migration 0015 §15.b, and `sessions`/`help_tickets` are on the UPDATE list but **not** on the
 * DELETE one. So the deletes run on `db/client.ts#withMaintTx` — WORKPLAN L361 names
 * `db/partitions.ts` and this job as the only two callers of it — while the licence read, the
 * legal-hold check and the `ingest_runs` audit row run on the application pool, which is the only
 * connection with privileges on `licence_registry`, `legal_holds` and `ingest_runs`.
 *
 * A `permission denied` from the maintenance role is recorded as a `JobError` on the run rather
 * than thrown: it is an operations problem (a missing GRANT) and must be visible on the ops screen
 * next to every other rule's result, not a stack trace that hides the rules after it.
 */

import { sql } from 'drizzle-orm';

import { withMaintTx, withTx } from '../../db/client.js';
import {
  PARTITIONED_TABLES,
  holdCoversRange,
  openLegalHolds,
  partitionPlans,
} from '../../db/partitions.js';

import type { Tx } from '../../db/client.js';
import type { OpenLegalHold } from '../../db/partitions.js';
import type { JobError, JobResult } from '../scheduler.js';
import type { MaintenanceJobContext } from './partitionMaintenance.js';

export type { MaintenanceJobContext } from './partitionMaintenance.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The §13 row
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const RETENTION_PURGE_JOB_ID = 'retentionPurge';

/** 01:30 America/New_York, every day — half an hour after `partitionMaintenance`. */
export const RETENTION_PURGE_SCHEDULE = '30 1 * * *';

export const RETENTION_PURGE_TIMEOUT_MS = 300_000;

/** Rows deleted per statement, so one night's backlog cannot hold a lock for the whole timeout. */
export const PURGE_BATCH_SIZE = 5_000;

/** Statements per rule per run; `PURGE_BATCH_SIZE × this` is the nightly ceiling per rule. */
export const PURGE_MAX_BATCHES = 40;

const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The rule set
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One non-partitioned table this job may delete rows from, and the clock that starts its life. */
export interface PurgeRule {
  /** The table. Must not be one of `partitionPlans`' six parents — those are dropped, not deleted. */
  readonly table: string;
  /**
   * The timestamp column that starts the retention clock. A row is eligible when this column is
   * non-NULL and strictly before the cutoff; a NULL is never eligible, which is what makes
   * "90 days after `revoked_at`" mean "never, while the session is live".
   */
  readonly column: string;
  /** `licence_registry.source_id` whose `retention_days` governs the rule; `null` = not licensed. */
  readonly retentionSourceId: string | null;
  /** A REG-04 / regulatory floor in days. A licence may raise it, never lower it. */
  readonly retentionFloorDays: number | null;
  /** An extra predicate ANDed onto the delete, e.g. only resolved tickets. Identifier-safe SQL. */
  readonly where?: string;
  /** The document line that mandates the rule — printed in the log and the audit row. */
  readonly reference: string;
  /** The unique key column used to batch the delete. */
  readonly keyColumn: string;
}

/**
 * The v1 rules. Both are REG-04 §19 obligations (DATA_MODEL L2591, L2594); neither is licensed,
 * because every licence row that carries a `retention_days` governs a partitioned table and is
 * handled by `partitionMaintenance`. {@link auditLicenceCoverage} enforces that statement on every
 * run, so this list going stale is a reported error rather than silent over-retention.
 */
export const PURGE_RULES: readonly PurgeRule[] = [
  {
    table: 'sessions',
    column: 'revoked_at',
    keyColumn: 'session_id',
    retentionSourceId: null,
    // DATA_MODEL §19: "connection metadata (SEC-03) … 90 days after `revoked_at` (retentionPurge)".
    retentionFloorDays: 90,
    reference: 'REG-04 / DATA_MODEL §19 — sessions.ip, user_agent, device_id',
  },
  {
    table: 'help_tickets',
    column: 'opened_at',
    keyColumn: 'ticket_id',
    retentionSourceId: null,
    // DATA_MODEL §19: "help_tickets.question, screen_state | support content | contract | 2 years".
    retentionFloorDays: 730,
    // An open ticket is not support history yet; only a finished one starts its two years.
    where: `status <> 'open'`,
    reference: 'REG-04 / DATA_MODEL §19 — help_tickets.question, screen_state',
  },
];

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`retentionPurge: unsafe SQL identifier ${JSON.stringify(name)}`);
  }
  return name;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Retention resolution — the licence row is the only number
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RuleRetention {
  readonly table: string;
  readonly sourceId: string | null;
  /** `licence_registry.retention_days` of the governing source; `null` = unlimited or unlicensed. */
  readonly licenceDays: number | null;
  readonly floorDays: number | null;
  /** `max(licenceDays, floorDays)`; `null` when nothing may ever be deleted. */
  readonly retentionDays: number | null;
  /** `now − retentionDays`; rows strictly older than this have expired. */
  readonly cutoff: Date | null;
}

/**
 * Read `retention_days` for one source from the *current* version of its bitemporal
 * `licence_registry` row, the same way `db/partitions.ts#resolveRetention` does.
 *
 * @throws when the source has no current row — a rule whose licence cannot be read must not fall
 *         back to "unlimited" silently, and must certainly not fall back to a default.
 */
export async function licenceRetentionDays(
  sourceId: string,
  now: Date,
  tx?: Tx,
): Promise<number | null> {
  const read = async (handle: Tx): Promise<number | null> => {
    const result = await handle.execute<{ retention_days: number | null }>(sql`
      SELECT retention_days
        FROM licence_registry
       WHERE source_id = ${sourceId}
         AND tx_to = 'infinity'
         AND valid_from <= ${now.toISOString()}::timestamptz
         AND valid_to > ${now.toISOString()}::timestamptz
       ORDER BY version_id DESC
       LIMIT 1`);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `retentionPurge: licence_registry has no current row for source_id '${sourceId}' at ` +
          `${now.toISOString()} — retention cannot be decided (STOR-07)`,
      );
    }
    return row.retention_days === null ? null : Number(row.retention_days);
  };
  return tx === undefined ? withTx(null, read) : read(tx);
}

/** Resolve what one rule is subject to tonight. */
export async function resolveRuleRetention(
  rule: PurgeRule,
  now: Date,
  tx?: Tx,
): Promise<RuleRetention> {
  const licenceDays =
    rule.retentionSourceId === null
      ? null
      : await licenceRetentionDays(rule.retentionSourceId, now, tx);
  const candidates = [licenceDays, rule.retentionFloorDays].filter((d): d is number => d !== null);
  const retentionDays = candidates.length === 0 ? null : Math.max(...candidates);
  return {
    table: rule.table,
    sourceId: rule.retentionSourceId,
    licenceDays,
    floorDays: rule.retentionFloorDays,
    retentionDays,
    cutoff: retentionDays === null ? null : new Date(now.getTime() - retentionDays * DAY_MS),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// STOR-07 coverage audit
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface LicenceCoverage {
  readonly sourceId: string;
  readonly retentionDays: number;
  /** The partitioned parents `partitionMaintenance` drops under this licence. */
  readonly partitionedTables: readonly string[];
  /** The rules in this file that delete rows under this licence. */
  readonly ruleTables: readonly string[];
  /** True when the number governs nothing at all — a configuration defect. */
  readonly ungoverned: boolean;
}

/**
 * Every licence row carrying a `retention_days`, and what that number actually governs.
 *
 * STOR-07 makes the licence row the only retention input; the mirror obligation is that a number
 * put on a licence row must reach some data. A number that governs nothing is inert, and inert
 * retention reads as "we keep it 30 days" on the licence screen while the rows live forever.
 */
export async function auditLicenceCoverage(
  now: Date,
  rules: readonly PurgeRule[] = PURGE_RULES,
  tx?: Tx,
): Promise<LicenceCoverage[]> {
  const read = async (handle: Tx): Promise<{ source_id: string; retention_days: number }[]> => {
    const result = await handle.execute<{ source_id: string; retention_days: number }>(sql`
      SELECT source_id, retention_days
        FROM licence_registry
       WHERE retention_days IS NOT NULL
         AND tx_to = 'infinity'
         AND valid_from <= ${now.toISOString()}::timestamptz
         AND valid_to > ${now.toISOString()}::timestamptz
       ORDER BY source_id`);
    return result.rows.map((row) => ({
      source_id: row.source_id,
      retention_days: Number(row.retention_days),
    }));
  };
  const rows = tx === undefined ? await withTx(null, read) : await read(tx);

  return rows.map(({ source_id: sourceId, retention_days: retentionDays }) => {
    const partitionedTables = PARTITIONED_TABLES.filter(
      (table) => partitionPlans[table].retentionSourceId === sourceId,
    );
    const ruleTables = rules.filter((r) => r.retentionSourceId === sourceId).map((r) => r.table);
    return {
      sourceId,
      retentionDays,
      partitionedTables,
      ruleTables,
      ungoverned: partitionedTables.length === 0 && ruleTables.length === 0,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The purge
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RulePurgeResult {
  readonly rule: PurgeRule;
  readonly retention: RuleRetention;
  /** Rows eligible at the cutoff before anything was deleted. */
  readonly eligible: number;
  readonly deleted: number;
  /** `true` when an open `legal_holds` row covered the window and nothing was deleted (MSG-02). */
  readonly heldBack: boolean;
  readonly holdIds: readonly number[];
  /** `true` when the batch ceiling was reached and rows remain for tomorrow. */
  readonly truncated: boolean;
  readonly error?: JobError;
}

export interface RetentionPurgeOptions {
  readonly rules?: readonly PurgeRule[];
  /** Count what would go without deleting it. */
  readonly dryRun?: boolean;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  /** Skip the STOR-07 coverage audit (it costs one query; the scheduler always wants it). */
  readonly audit?: boolean;
}

export interface RetentionPurgeResult extends JobResult {
  readonly rules: readonly RulePurgeResult[];
  readonly coverage: readonly LicenceCoverage[];
  /** `ingest_runs.run_id` of the audit rows written, one per rule that deleted something. */
  readonly runIds: readonly number[];
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

function errorOf(err: unknown, prefix: string): JobError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      code: typeof code === 'string' ? code : err.name,
      message: `${prefix}: ${err.message}`,
    };
  }
  return { code: 'UNKNOWN', message: `${prefix}: ${String(err)}` };
}

/** How many rows the rule would delete at `cutoff`. Application pool: SELECT is granted there. */
async function countEligible(rule: PurgeRule, cutoff: Date, tx?: Tx): Promise<number> {
  const table = assertIdentifier(rule.table);
  const column = assertIdentifier(rule.column);
  const extra = rule.where === undefined ? '' : ` AND (${rule.where})`;
  const read = async (handle: Tx): Promise<number> => {
    const result = await handle.execute<{ n: string }>(
      sql.raw(
        `SELECT count(*)::text AS n FROM ${table}
          WHERE ${column} IS NOT NULL AND ${column} < '${cutoff.toISOString()}'::timestamptz${extra}`,
      ),
    );
    return Number(result.rows[0]?.n ?? '0');
  };
  return tx === undefined ? withTx(null, read) : read(tx);
}

/**
 * Delete in bounded batches on the maintenance connection. Each batch is its own transaction, so a
 * long backlog never holds one lock for the whole run and a failure keeps the batches before it.
 */
async function deleteBatched(
  rule: PurgeRule,
  cutoff: Date,
  batchSize: number,
  maxBatches: number,
): Promise<{ deleted: number; truncated: boolean }> {
  const table = assertIdentifier(rule.table);
  const column = assertIdentifier(rule.column);
  const key = assertIdentifier(rule.keyColumn);
  const extra = rule.where === undefined ? '' : ` AND (${rule.where})`;
  let deleted = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const removed = await withMaintTx(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '15s'`));
      const result = await tx.execute<{ n: string }>(
        sql.raw(
          `WITH doomed AS (
             SELECT ${key} FROM ${table}
              WHERE ${column} IS NOT NULL
                AND ${column} < '${cutoff.toISOString()}'::timestamptz${extra}
              ORDER BY ${column}
              LIMIT ${String(batchSize)}
              FOR UPDATE SKIP LOCKED),
           gone AS (
             DELETE FROM ${table} t USING doomed d WHERE t.${key} = d.${key} RETURNING 1)
           SELECT count(*)::text AS n FROM gone`,
        ),
      );
      return Number(result.rows[0]?.n ?? '0');
    });
    deleted += removed;
    if (removed < batchSize) return { deleted, truncated: false };
  }
  return { deleted, truncated: true };
}

/** The `legal_holds` rows covering `[−∞, cutoff)` — the window a rule would delete (MSG-02). */
function holdsCovering(holds: readonly OpenLegalHold[], cutoff: Date): OpenLegalHold[] {
  return holds.filter((hold) => holdCoversRange(hold, null, cutoff));
}

/**
 * Run every rule.
 *
 * Counters as `ingest_runs` reads them for this job: `fetched` = rules evaluated,
 * `skipped` = rows deleted (objects removed, the same convention `dropExpired` uses for a dropped
 * partition), `updated` = rules held back by a legal hold.
 */
export async function runRetentionPurge(
  ctx: MaintenanceJobContext,
  options: RetentionPurgeOptions = {},
): Promise<RetentionPurgeResult> {
  const now = new Date(ctx.clock.now());
  const rules = options.rules ?? PURGE_RULES;
  const batchSize = options.batchSize ?? PURGE_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? PURGE_MAX_BATCHES;
  const base = emptyResult();

  for (const rule of rules) {
    if ((PARTITIONED_TABLES as readonly string[]).includes(rule.table)) {
      throw new Error(
        `retentionPurge: ${rule.table} is a partitioned parent — its retention is enforced by ` +
          `partitionMaintenance dropping partitions, not by deleting rows (DATA_MODEL §7.3)`,
      );
    }
  }

  let coverage: LicenceCoverage[] = [];
  if (options.audit !== false) {
    try {
      coverage = await auditLicenceCoverage(now, rules);
      for (const entry of coverage) {
        if (!entry.ungoverned) continue;
        base.errors.push({
          code: 'RETENTION_UNGOVERNED',
          message:
            `licence_registry.retention_days = ${String(entry.retentionDays)} on source_id ` +
            `'${entry.sourceId}' governs no table: no partitioned parent names it in ` +
            `partitionPlans and no retentionPurge rule names it, so the number is inert (STOR-07)`,
        });
      }
    } catch (err) {
      base.errors.push(errorOf(err, 'auditLicenceCoverage'));
    }
  }

  const holds = await openLegalHolds();
  const results: RulePurgeResult[] = [];
  const runIds: number[] = [];

  for (const rule of rules) {
    base.fetched += 1;
    let retention: RuleRetention;
    try {
      retention = await resolveRuleRetention(rule, now);
    } catch (err) {
      const error = errorOf(err, `resolveRuleRetention(${rule.table})`);
      base.errors.push(error);
      continue;
    }

    if (retention.cutoff === null) {
      results.push({
        rule,
        retention,
        eligible: 0,
        deleted: 0,
        heldBack: false,
        holdIds: [],
        truncated: false,
      });
      continue;
    }

    const covering = holdsCovering(holds, retention.cutoff);
    if (covering.length > 0) {
      base.updated += 1;
      results.push({
        rule,
        retention,
        eligible: await countEligible(rule, retention.cutoff).catch(() => 0),
        deleted: 0,
        heldBack: true,
        holdIds: covering.map((h) => h.holdId),
        truncated: false,
      });
      ctx.log?.warn?.('retention.held_back', {
        job: RETENTION_PURGE_JOB_ID,
        table: rule.table,
        holdIds: covering.map((h) => h.holdId),
        cutoff: retention.cutoff.toISOString(),
      });
      continue;
    }

    let eligible = 0;
    try {
      eligible = await countEligible(rule, retention.cutoff);
    } catch (err) {
      const error = errorOf(err, `countEligible(${rule.table})`);
      base.errors.push(error);
      results.push({
        rule,
        retention,
        eligible: 0,
        deleted: 0,
        heldBack: false,
        holdIds: [],
        truncated: false,
        error,
      });
      continue;
    }

    if (eligible === 0 || options.dryRun === true) {
      results.push({
        rule,
        retention,
        eligible,
        deleted: 0,
        heldBack: false,
        holdIds: [],
        truncated: false,
      });
      continue;
    }

    try {
      const { deleted, truncated } = await deleteBatched(
        rule,
        retention.cutoff,
        batchSize,
        maxBatches,
      );
      base.skipped += deleted;
      results.push({
        rule,
        retention,
        eligible,
        deleted,
        heldBack: false,
        holdIds: [],
        truncated,
      });
      if (deleted > 0) {
        runIds.push(...(await auditRow(rule, retention, deleted, now)));
      }
      ctx.log?.info?.('retention.purged', {
        job: RETENTION_PURGE_JOB_ID,
        table: rule.table,
        reference: rule.reference,
        sourceId: retention.sourceId,
        licenceDays: retention.licenceDays,
        floorDays: retention.floorDays,
        retentionDays: retention.retentionDays,
        cutoff: retention.cutoff.toISOString(),
        eligible,
        deleted,
        truncated,
        ...(ctx.traceId === undefined ? {} : { traceId: ctx.traceId }),
      });
    } catch (err) {
      const error = errorOf(err, `deleteBatched(${rule.table})`);
      base.errors.push(error);
      results.push({
        rule,
        retention,
        eligible,
        deleted: 0,
        heldBack: false,
        holdIds: [],
        truncated: false,
        error,
      });
      ctx.log?.error?.('retention.purge_failed', {
        job: RETENTION_PURGE_JOB_ID,
        table: rule.table,
        code: error.code,
        message: error.message,
      });
    }
  }

  return { ...base, rules: results, coverage, runIds };
}

/**
 * One `ingest_runs` row per rule that deleted something, in the shape `dropExpired` writes for a
 * dropped partition: `ingest_runs` has no free-form detail column, so the table name and the
 * retention that authorised the delete go into the single `errors` entry of an otherwise
 * `status = 'ok'` row. Deleting data leaves an audit trail naming what went and under what rule.
 */
async function auditRow(
  rule: PurgeRule,
  retention: RuleRetention,
  deleted: number,
  startedAt: Date,
): Promise<number[]> {
  const note = JSON.stringify([
    {
      code: 'ROWS_PURGED',
      message:
        `${rule.table}: ${String(deleted)} row(s) older than ` +
        `${String(retention.retentionDays)}d (${rule.reference})`,
    },
  ]);
  return withTx(null, async (tx) => {
    const result = await tx.execute<{ run_id: string }>(sql`
      INSERT INTO ingest_runs (job_id, source_id, started_at, finished_at, status,
                               fetched, inserted, updated, skipped, errors)
      VALUES (${RETENTION_PURGE_JOB_ID}, ${retention.sourceId}, ${startedAt.toISOString()},
              ${new Date().toISOString()}, 'ok', 0, 0, 0, ${deleted}, ${note}::jsonb)
      RETURNING run_id`);
    const row = result.rows[0];
    return row === undefined ? [] : [Number(row.run_id)];
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job table row (PROVIDERS §13)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const job = {
  id: RETENTION_PURGE_JOB_ID,
  schedule: RETENTION_PURGE_SCHEDULE,
  priority: 3 as const,
  timeoutMs: RETENTION_PURGE_TIMEOUT_MS,
  /** Deletes run on `withMaintTx`; an application-pool transaction around them is meaningless. */
  transactional: false,
  run: (ctx: MaintenanceJobContext): Promise<RetentionPurgeResult> => runRetentionPurge(ctx),
};
