/**
 * `db/partitions.ts` — partition maintenance and retention (DATA_MODEL §7.1/§7.3 L1197-1225,
 * §15.d.1 L2275-2315, §16 L2508-2513; STOR-05, STOR-07, WORKPLAN WP-05).
 *
 * Six tables are `PARTITION BY RANGE` on plain Postgres 14 (no TimescaleDB). Two jobs keep them
 * healthy: `ingest/jobs/partitionMaintenance.ts` calls `ensurePartitions` to keep the horizon ahead
 * of the data, and `ingest/jobs/retentionPurge.ts` calls `dropExpired` to take the oldest ones away
 * once the licence that governs them says the data may no longer be kept.
 *
 * ## The role split is the point (DATA_MODEL §15.d.1)
 *
 * **Every statement that changes the shape of a partitioned table runs on `withMaintTx`**, the
 * single-connection `terminal_maint` pool of `db/client.ts`:
 *
 *  - `CREATE TABLE … PARTITION OF` needs `CREATE` on schema `public`; `terminal_app` holds `USAGE`
 *    only (migration 0015 L10 vs L67).
 *  - `ALTER TABLE … ATTACH PARTITION` and `DROP TABLE <partition>` need **ownership** of the table;
 *    `terminal_maint` owns the six parents and every partition it creates, `terminal_app` owns
 *    nothing.
 *
 * On PG 14 the *legacy* `PUBLIC CREATE` grant on schema `public` would let `terminal_app` create a
 * table in development and fail only in a hardened deployment, which is exactly the class of bug
 * that reaches production. `test/integration/ingest/partitions.test.ts` therefore asserts the
 * failure against the role itself, connected as `terminal_app`, rather than assuming it.
 *
 * The converse is just as sharp and is the reason this module uses *two* connections:
 * `terminal_maint` has no privileges on anything but those six parents — it cannot read
 * `licence_registry` or `legal_holds` and cannot write `ingest_runs` or `dq_events`. So the
 * retention *decision*, the legal-hold check, the audit row and the data-quality event all run on
 * the application connection (`withTx(null, …)`), and only the DDL runs as `terminal_maint`.
 *
 * ## Retention has exactly one input (STOR-07)
 *
 * `licence_registry.retention_days` of the source that governs the table, raised to the table's
 * `retentionFloorDays` when a regulation demands more (`access_log` 2557 = 7 y for ENTL-04/REG-01,
 * `usage_events` 730). There is deliberately **no `retentionDays` parameter**: a literal at a call
 * site is how a licence term and the code that enforces it drift apart. A partition covered by an
 * open `legal_holds` row is never dropped, whatever the licence says (MSG-02).
 */

import { sql } from 'drizzle-orm';

import { checkDefaultPartitions, raiseDq } from '../observability/dq.js';
import { withMaintTx, withTx } from './client.js';

import type { DefaultPartitionSpec } from '../observability/dq.js';
import type { Tx } from './client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The plans (DATA_MODEL §7.3 L1199-1208 verbatim, plus two mechanical facts)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type PartitionUnit = 'day' | 'month' | 'year';

export interface PartitionPlan {
  /** The partition key column. */
  readonly column: string;
  readonly unit: PartitionUnit;
  /** How many whole units beyond `now` the horizon is kept. */
  readonly aheadUnits: number;
  /** `licence_registry.source_id` whose `retention_days` governs the table; `null` = unlimited. */
  readonly retentionSourceId: string | null;
  /** A regulatory floor in days that the licence can only be raised to, never lowered below. */
  readonly retentionFloorDays: number | null;
  /**
   * ADDITION to §7.3's interface: the SQL type of `column`, because a range bound is parsed as the
   * column's type and a `date` column must not be handed a timestamp with an offset.
   */
  readonly columnType: 'date' | 'timestamptz';
  /**
   * ADDITION: the 15.d WORM tables. Their `BEFORE UPDATE OR DELETE` trigger fires for every role
   * including the owner, so rows in their default partition cannot be moved into a new partition —
   * `ensurePartitions` reports them instead of failing (see `EnsurePartitionsResult.blocked`).
   */
  readonly worm: boolean;
}

export const partitionPlans = {
  bars_daily: {
    column: 'session_date',
    unit: 'year',
    aheadUnits: 1,
    retentionSourceId: null,
    retentionFloorDays: null,
    columnType: 'date',
    worm: false,
  },
  bars_intraday: {
    column: 'bar_ts',
    unit: 'month',
    aheadUnits: 2,
    retentionSourceId: 'yahoo.chart',
    retentionFloorDays: null,
    columnType: 'timestamptz',
    worm: false,
  },
  quote_ticks: {
    column: 'capture_ts',
    unit: 'day',
    aheadUnits: 7,
    retentionSourceId: 'cboe.quotes',
    retentionFloorDays: null,
    columnType: 'timestamptz',
    worm: false,
  },
  option_quotes: {
    column: 'capture_ts',
    unit: 'day',
    aheadUnits: 7,
    retentionSourceId: 'cboe.options',
    retentionFloorDays: null,
    columnType: 'timestamptz',
    worm: false,
  },
  access_log: {
    column: 'ts',
    unit: 'month',
    aheadUnits: 2,
    retentionSourceId: null,
    retentionFloorDays: 2557, // 7 y (ENTL-04, REG-01)
    columnType: 'timestamptz',
    worm: true,
  },
  usage_events: {
    column: 'ts',
    unit: 'month',
    aheadUnits: 2,
    retentionSourceId: null,
    retentionFloorDays: 730,
    columnType: 'timestamptz',
    worm: true,
  },
} as const satisfies Record<string, PartitionPlan>;

export type PartitionTable = keyof typeof partitionPlans;

/** The six partitioned parents, in migration order. */
export const PARTITIONED_TABLES = Object.keys(partitionPlans) as readonly PartitionTable[];

/** `partitionPlans` as the sweep list `observability/dq.ts#checkDefaultPartitions` takes. */
export function defaultPartitionSpecs(): DefaultPartitionSpec[] {
  return PARTITIONED_TABLES.map((table) => {
    const plan = partitionPlans[table];
    return { table, column: plan.column, worm: plan.worm };
  });
}

function planFor(table: PartitionTable): PartitionPlan {
  const plan: PartitionPlan | undefined = partitionPlans[table];
  if (plan === undefined) throw new Error(`partitions: no plan for table ${String(table)}`);
  return plan;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// UTC unit arithmetic and names
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * All bounds are UTC. `timestamptz` range bounds are interpreted in the *session* time zone, and
 * every connection in `db/client.ts` runs with `-c timezone=UTC` precisely so that a daily
 * partition is a UTC day (DATA_MODEL §16 L2508-2510).
 */
export function startOfUnit(unit: PartitionUnit, at: Date): Date {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const d = at.getUTCDate();
  switch (unit) {
    case 'day':
      return new Date(Date.UTC(y, m, d));
    case 'month':
      return new Date(Date.UTC(y, m, 1));
    case 'year':
      return new Date(Date.UTC(y, 0, 1));
  }
}

/** `start` advanced by `n` whole units (negative `n` goes back). */
export function addUnits(unit: PartitionUnit, start: Date, n: number): Date {
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  const d = start.getUTCDate();
  switch (unit) {
    case 'day':
      return new Date(Date.UTC(y, m, d + n));
    case 'month':
      return new Date(Date.UTC(y, m + n, 1));
    case 'year':
      return new Date(Date.UTC(y + n, 0, 1));
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n);
}

/** `quote_ticks_d2026_09_15`, `bars_intraday_m2026_09`, `bars_daily_y2026` (DATA_MODEL §7.3). */
export function partitionName(table: string, unit: PartitionUnit, start: Date): string {
  const y = String(start.getUTCFullYear());
  switch (unit) {
    case 'day':
      return `${table}_d${y}_${pad2(start.getUTCMonth() + 1)}_${pad2(start.getUTCDate())}`;
    case 'month':
      return `${table}_m${y}_${pad2(start.getUTCMonth() + 1)}`;
    case 'year':
      return `${table}_y${y}`;
  }
}

/** The literal a `FOR VALUES` bound is written as, for this plan's column type. */
function boundLiteral(plan: PartitionPlan, at: Date): string {
  const iso = at.toISOString();
  return plan.columnType === 'date'
    ? iso.slice(0, 10)
    : `${iso.slice(0, 10)} ${iso.slice(11, 19)}+00`;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name))
    throw new Error(`partitions: unsafe SQL identifier ${JSON.stringify(name)}`);
  return name;
}

/**
 * A mistyped `from` (1970 against a daily plan) would ask for twenty thousand partitions and take
 * an ACCESS EXCLUSIVE lock on the parent for each one. The horizon is bounded instead.
 */
const MAX_RANGES_PER_CALL = 800;

/** Half-open range `[lo, hi)` and the partition name it would get. */
export interface PartitionRange {
  readonly name: string;
  readonly lo: Date;
  readonly hi: Date;
}

/** The ranges `ensurePartitions` would consider, without touching the database. */
export function plannedRanges(
  table: PartitionTable,
  from: Date,
  now: Date,
  aheadUnits?: number,
): PartitionRange[] {
  const plan = planFor(table);
  const ahead = aheadUnits ?? plan.aheadUnits;
  if (!Number.isInteger(ahead) || ahead < 0) {
    throw new Error(`partitions: aheadUnits must be a non-negative integer, got ${String(ahead)}`);
  }
  const first = startOfUnit(plan.unit, from);
  const last = addUnits(plan.unit, startOfUnit(plan.unit, now), ahead);
  if (last < first) return [];
  const ranges: PartitionRange[] = [];
  for (let lo = first; lo <= last; lo = addUnits(plan.unit, lo, 1)) {
    ranges.push({ name: partitionName(table, plan.unit, lo), lo, hi: addUnits(plan.unit, lo, 1) });
    if (ranges.length > MAX_RANGES_PER_CALL) {
      throw new Error(
        `partitions: ${table} from ${from.toISOString()} to ${now.toISOString()} + ${String(ahead)} ` +
          `${plan.unit}(s) is more than ${String(MAX_RANGES_PER_CALL)} partitions — narrow the window`,
      );
    }
  }
  return ranges;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ensurePartitions
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface EnsurePartitionsOptions {
  /** First unit to cover. Default: the unit containing `now` (the horizon only grows forward). */
  readonly from?: Date;
  /** The clock instant. Default: `new Date()`; every caller in the system injects its `Clock`. */
  readonly now?: Date;
  /** Override the plan's horizon — WORKPLAN's `ensurePartitions(table, horizonMonths)` parameter. */
  readonly aheadUnits?: number;
  /** Set `false` to skip the `default_partition_nonempty` event (the caller raises its own). */
  readonly raiseDqEvents?: boolean;
}

/** A range that could not be created because rows in the default partition overlap it. */
export interface BlockedRange {
  readonly partition: string;
  readonly lo: string;
  readonly hi: string;
  readonly rowsInDefault: number;
  readonly reason: 'worm_default_rows';
}

export interface EnsurePartitionsResult {
  readonly table: PartitionTable;
  /** Partitions created by this call, in ascending order — DATA_MODEL §7.3's return value. */
  readonly created: readonly string[];
  /** Ranges already covered (by name, or by an existing partition with different bounds). */
  readonly existing: readonly string[];
  /** Rows relocated out of `<table>_default` into a newly attached partition. */
  readonly movedRows: number;
  readonly blocked: readonly BlockedRange[];
  /** Rows left in `<table>_default` when the call finished. */
  readonly defaultRowsRemaining: number;
  /** The `dq_events.dq_id` raised for a non-empty default partition, when one was. */
  readonly dqId: number | null;
}

interface PgError {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
}

/**
 * Every error raised inside a `db/client.ts` transaction reaches us wrapped: drizzle throws a
 * `DrizzleQueryError` whose `message` is `'Failed query: CREATE TABLE …'` and whose `code` is
 * `undefined`, and the `pg` error carrying the SQLSTATE sits on `.cause`. Reading `err.code`
 * directly therefore never sees `42P07`, `42P17` or `42501`, and the chain can be more than one
 * link long. Both helpers below walk it.
 *
 * The walk is bounded (a `cause` cycle is possible in principle) and stops at the first link that
 * carries the property.
 */
function* causeChain(err: unknown): Generator<PgError> {
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < 16; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) return;
    seen.add(current);
    const link: PgError = current;
    yield link;
    current = link.cause;
  }
}

/** The SQLSTATE of the first link in the cause chain that carries one. */
function pgErrorCode(err: unknown): string | undefined {
  for (const link of causeChain(err)) {
    if (typeof link.code === 'string' && link.code !== '') return link.code;
  }
  return undefined;
}

/** Every message in the cause chain, joined — the wrapper's text hides the database's own. */
function pgErrorMessage(err: unknown): string {
  const parts: string[] = [];
  for (const link of causeChain(err)) {
    if (typeof link.message === 'string' && link.message !== '' && !parts.includes(link.message)) {
      parts.push(link.message);
    }
  }
  if (parts.length === 0) return String(err);
  return parts.join(': ');
}

/**
 * True when a `CREATE TABLE … PARTITION OF` failed because the range is already covered: the name
 * is taken (`42P07`), or another partition overlaps it (`42P17`, which is what the pre-existing
 * `0016_partitions_initial.sql` bounds produce — they were written in the migrator's local time
 * zone, so a UTC-day candidate overlaps them by four hours rather than matching them).
 */
function meansAlreadyCovered(err: unknown): boolean {
  const code = pgErrorCode(err);
  if (code === '42P07') return true;
  const message = pgErrorMessage(err);
  return code === '42P17' || /would overlap partition|already exists/i.test(message);
}

async function regclassExists(tx: Tx, name: string): Promise<boolean> {
  const result = await tx.execute<{ present: boolean }>(
    sql`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS present`,
  );
  return result.rows[0]?.present === true;
}

async function countDefaultRowsInRange(
  tx: Tx,
  table: string,
  column: string,
  loLiteral: string,
  hiLiteral: string,
): Promise<number> {
  const result = await tx.execute<{ n: string }>(
    sql.raw(
      `SELECT count(*)::text AS n FROM ${table}_default
      WHERE ${column} >= '${loLiteral}' AND ${column} < '${hiLiteral}'`,
    ),
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function countDefaultRows(tx: Tx, table: string): Promise<number> {
  const result = await tx.execute<{ n: string }>(
    sql.raw(`SELECT count(*)::text AS n FROM ${table}_default`),
  );
  return Number(result.rows[0]?.n ?? '0');
}

/**
 * Create every missing partition from `from` to `now + aheadUnits`, moving any row already parked
 * in `<table>_default` that falls inside a new range into it before the partition is attached
 * (DATA_MODEL §7.1 rule 4, §7.3). Runs entirely on the `terminal_maint` connection.
 *
 * The move is `CREATE TABLE … (LIKE parent INCLUDING ALL)` → `INSERT … SELECT FROM <default>` →
 * `DELETE FROM <default>` → `ATTACH PARTITION`, all inside one transaction, because `ATTACH` is
 * refused outright while the default partition holds a row that would belong to the new one.
 *
 * On the two WORM tables the move is impossible by design — the 15.d trigger blocks the `DELETE`
 * for every role — so the range is reported in `blocked` and a `default_partition_nonempty` event
 * is raised for an operator instead of failing the whole run.
 *
 * @throws when the maintenance connection is not configured (`DATABASE_URL_MAINT`), when the role
 *         it connects as is not `terminal_maint` (`permission denied for schema public`,
 *         `must be owner of table …`), or when the requested window exceeds
 *         `MAX_RANGES_PER_CALL` partitions.
 */
export async function ensurePartitions(
  table: PartitionTable,
  options: EnsurePartitionsOptions = {},
): Promise<EnsurePartitionsResult> {
  const plan = planFor(table);
  const parent = assertIdentifier(table);
  const column = assertIdentifier(plan.column);
  const now = options.now ?? new Date();
  const from = options.from ?? now;
  const ranges = plannedRanges(table, from, now, options.aheadUnits);

  const created: string[] = [];
  const existing: string[] = [];
  const blocked: BlockedRange[] = [];
  let movedRows = 0;

  const defaultRowsRemaining = await withMaintTx(async (tx) => {
    // A wedged reader must not hold the parent's ACCESS EXCLUSIVE lock for the life of the job.
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '15s'`));

    for (const range of ranges) {
      const name = assertIdentifier(range.name);
      const lo = boundLiteral(plan, range.lo);
      const hi = boundLiteral(plan, range.hi);
      if (await regclassExists(tx, name)) {
        existing.push(name);
        continue;
      }
      const overlapping = await countDefaultRowsInRange(tx, parent, column, lo, hi);
      if (overlapping > 0 && plan.worm) {
        blocked.push({
          partition: name,
          lo,
          hi,
          rowsInDefault: overlapping,
          reason: 'worm_default_rows',
        });
        continue;
      }
      try {
        // Nested `transaction()` is a SAVEPOINT: a range that is already covered by a partition
        // under another name rolls back on its own and the rest of the horizon still lands.
        await tx.transaction(async (sp) => {
          if (overlapping === 0) {
            await sp.execute(
              sql.raw(
                `CREATE TABLE ${name} PARTITION OF ${parent} FOR VALUES FROM ('${lo}') TO ('${hi}')`,
              ),
            );
            return;
          }
          await sp.execute(sql.raw(`CREATE TABLE ${name} (LIKE ${parent} INCLUDING ALL)`));
          await sp.execute(
            sql.raw(
              `INSERT INTO ${name} SELECT * FROM ${parent}_default
                WHERE ${column} >= '${lo}' AND ${column} < '${hi}'`,
            ),
          );
          await sp.execute(
            sql.raw(
              `DELETE FROM ${parent}_default WHERE ${column} >= '${lo}' AND ${column} < '${hi}'`,
            ),
          );
          await sp.execute(
            sql.raw(
              `ALTER TABLE ${parent} ATTACH PARTITION ${name} FOR VALUES FROM ('${lo}') TO ('${hi}')`,
            ),
          );
        });
      } catch (err) {
        if (meansAlreadyCovered(err)) {
          existing.push(name);
          continue;
        }
        throw err;
      }
      created.push(name);
      movedRows += overlapping;
    }

    return countDefaultRows(tx, parent);
  });

  // The decision above ran as `terminal_maint`, which cannot write `dq_events`. The finding is
  // recorded on the application connection.
  let dqId: number | null = null;
  if (options.raiseDqEvents !== false && (defaultRowsRemaining > 0 || movedRows > 0)) {
    const findings =
      defaultRowsRemaining > 0
        ? await checkDefaultPartitions([{ table: parent, column, worm: plan.worm }], { now })
        : [];
    dqId = findings[0]?.dqId ?? null;
    if (movedRows > 0 && defaultRowsRemaining === 0) {
      // The default partition was drained by this very call. It still happened, and §16's test
      // asserts it was flagged, so the event records the drain rather than a live backlog.
      dqId = await raiseDq({
        kind: 'default_partition_nonempty',
        severity: 'warn',
        subject: parent,
        key: `${parent}_default:${now.toISOString()}`,
        details: {
          table: parent,
          partition: `${parent}_default`,
          column,
          rows: movedRows,
          moved: movedRows,
          remaining: 0,
          movedInto: created,
        },
        ts: now,
      });
    }
  }

  return {
    table,
    created,
    existing,
    movedRows,
    blocked,
    defaultRowsRemaining,
    dqId,
  };
}

/** `ensurePartitions` for every plan — startup step and `partitionMaintenance.ts` (DATA_MODEL §16). */
export async function ensureAllPartitions(
  options: EnsurePartitionsOptions = {},
): Promise<EnsurePartitionsResult[]> {
  const results: EnsurePartitionsResult[] = [];
  for (const table of PARTITIONED_TABLES) {
    results.push(await ensurePartitions(table, options));
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Retention: the licence is the only input (STOR-07)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RetentionDecision {
  readonly table: PartitionTable;
  /** `licence_registry.retention_days` of the governing source; `null` = unlimited. */
  readonly licenceDays: number | null;
  readonly sourceId: string | null;
  readonly floorDays: number | null;
  /** `max(licenceDays, floorDays)`; `null` when neither applies and nothing may ever be dropped. */
  readonly retentionDays: number | null;
  /** `now − retentionDays`; partitions whose upper bound is at or before it have expired. */
  readonly cutoff: Date | null;
}

/**
 * Resolve the retention a table is subject to, reading `licence_registry` as the only source of the
 * number (STOR-07). The registry is bitemporal, so the *current* version is
 * `tx_to = 'infinity'` and `valid_from <= now < valid_to`.
 *
 * Runs on the application connection: `terminal_maint` has no SELECT on `licence_registry`.
 */
export async function resolveRetention(
  table: PartitionTable,
  now: Date,
  tx?: Tx,
): Promise<RetentionDecision> {
  const plan = planFor(table);
  const sourceId = plan.retentionSourceId;
  let licenceDays: number | null = null;

  if (sourceId !== null) {
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
          `partitions: ${table} is governed by licence_registry source_id '${sourceId}', which has ` +
            `no current row at ${now.toISOString()} — retention cannot be decided (STOR-07)`,
        );
      }
      return row.retention_days === null ? null : Number(row.retention_days);
    };
    licenceDays = tx === undefined ? await withTx(null, read) : await read(tx);
  }

  const floorDays = plan.retentionFloorDays;
  const candidates = [licenceDays, floorDays].filter((d): d is number => d !== null);
  const retentionDays = candidates.length === 0 ? null : Math.max(...candidates);
  const cutoff =
    retentionDays === null ? null : new Date(now.getTime() - retentionDays * 86_400_000);
  return { table, licenceDays, sourceId, floorDays, retentionDays, cutoff };
}

/** One existing partition of a parent, with its parsed bounds (`null` = MINVALUE / MAXVALUE). */
export interface ExistingPartition {
  readonly name: string;
  readonly bound: string;
  readonly lo: Date | null;
  readonly hi: Date | null;
  readonly isDefault: boolean;
}

/**
 * Every partition attached to `table`, with bounds parsed by Postgres itself rather than by a
 * regular expression in TypeScript — the bound literal is rendered in the session time zone and
 * `::timestamptz` is the only thing that reads it back correctly.
 */
export async function listPartitions(table: PartitionTable, tx?: Tx): Promise<ExistingPartition[]> {
  const parent = assertIdentifier(table);
  const read = async (handle: Tx): Promise<ExistingPartition[]> => {
    const result = await handle.execute<{
      name: string;
      bound: string;
      lo: string | null;
      hi: string | null;
    }>(sql`
      WITH parts AS (
        SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          JOIN pg_class p ON p.oid = i.inhparent
         WHERE p.oid = ${`public.${parent}`}::regclass)
      SELECT name, bound,
             (regexp_match(bound, 'FROM \\(''([^'']*)''\\)'))[1]::timestamptz::text AS lo,
             (regexp_match(bound, 'TO \\(''([^'']*)''\\)'))[1]::timestamptz::text   AS hi
        FROM parts
       ORDER BY name`);
    return result.rows.map((row) => ({
      name: row.name,
      bound: row.bound,
      lo: row.lo === null ? null : new Date(row.lo),
      hi: row.hi === null ? null : new Date(row.hi),
      isDefault: row.bound.trim().toUpperCase() === 'DEFAULT',
    }));
  };
  return tx === undefined ? withTx(null, read) : read(tx);
}

/** An open `legal_holds` row, reduced to the window it protects. */
export interface OpenLegalHold {
  readonly holdId: number;
  readonly firmId: number;
  /** `scope.from` — `null` means "from the beginning of time". */
  readonly from: Date | null;
  /** `scope.to` — `null` means "until further notice". */
  readonly to: Date | null;
}

/** Every unreleased `legal_holds` row (MSG-02). Application connection: RLS-free ingest context. */
export async function openLegalHolds(tx?: Tx): Promise<OpenLegalHold[]> {
  const read = async (handle: Tx): Promise<OpenLegalHold[]> => {
    const result = await handle.execute<{
      hold_id: string;
      firm_id: string;
      hold_from: string | null;
      hold_to: string | null;
    }>(sql`
      SELECT hold_id, firm_id,
             (scope ->> 'from') AS hold_from,
             (scope ->> 'to')   AS hold_to
        FROM legal_holds
       WHERE released_at IS NULL
       ORDER BY hold_id`);
    return result.rows.map((row) => {
      const from = row.hold_from === null ? Number.NaN : Date.parse(row.hold_from);
      const to = row.hold_to === null ? Number.NaN : Date.parse(row.hold_to);
      return {
        holdId: Number(row.hold_id),
        firmId: Number(row.firm_id),
        from: Number.isNaN(from) ? null : new Date(from),
        to: Number.isNaN(to) ? null : new Date(to),
      };
    });
  };
  return tx === undefined ? withTx(null, read) : read(tx);
}

/**
 * A hold protects a partition when the window it names overlaps the partition's range. An
 * unparseable or absent bound is treated as unbounded: a hold whose scope cannot be narrowed
 * protects everything, because the failure mode of a wrong answer here is destroyed evidence.
 */
export function holdCoversRange(hold: OpenLegalHold, lo: Date | null, hi: Date | null): boolean {
  const holdFrom = hold.from?.getTime() ?? Number.NEGATIVE_INFINITY;
  const holdTo = hold.to?.getTime() ?? Number.POSITIVE_INFINITY;
  const rangeLo = lo?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rangeHi = hi?.getTime() ?? Number.POSITIVE_INFINITY;
  return holdFrom < rangeHi && holdTo > rangeLo;
}

export interface DropExpiredOptions {
  readonly now?: Date;
  /** `ingest_runs.job_id` for the audit row written per drop. Default `'retentionPurge'`. */
  readonly jobId?: string;
  /** Report what would be dropped without dropping it. */
  readonly dryRun?: boolean;
}

export interface HeldBackPartition {
  readonly partition: string;
  readonly holdIds: readonly number[];
}

export interface DropExpiredResult {
  readonly table: PartitionTable;
  readonly retention: RetentionDecision;
  /** True when `dryRun` was set: nothing was destroyed and `dropped` is empty by construction. */
  readonly dryRun: boolean;
  /**
   * Partitions actually dropped, oldest first. **Always empty on a dry run** — a caller that logs
   * or reports this field must never be able to state that data was destroyed when none was.
   */
  readonly dropped: readonly string[];
  /**
   * On a dry run, the partitions a real run would have dropped, oldest first. Empty otherwise.
   */
  readonly wouldDrop: readonly string[];
  /** Expired partitions kept alive by an open `legal_holds` row (MSG-02). */
  readonly heldBack: readonly HeldBackPartition[];
  /** `ingest_runs.run_id` of the audit row written per drop. */
  readonly runIds: readonly number[];
}

/**
 * Drop every partition of `table` whose upper bound is at or before
 * `now − max(licence_registry.retention_days, retentionFloorDays)` (DATA_MODEL §7.3 L1236-1237,
 * STOR-07), skipping any partition an open `legal_holds` row covers, and writing one `ingest_runs`
 * row per drop.
 *
 * There is no `retentionDays` parameter on purpose — see the module header.
 *
 * The `DROP TABLE` runs on `withMaintTx`: dropping a partition needs ownership of it, which only
 * `terminal_maint` has. The retention read, the hold check and the audit row run on the application
 * connection, which is the only one with privileges on `licence_registry`, `legal_holds` and
 * `ingest_runs`.
 *
 * @throws `must be owner of table …` when the maintenance connection is not `terminal_maint`.
 */
export async function dropExpired(
  table: PartitionTable,
  options: DropExpiredOptions = {},
): Promise<DropExpiredResult> {
  assertIdentifier(table);
  const now = options.now ?? new Date();
  const jobId = options.jobId ?? 'retentionPurge';
  const retention = await resolveRetention(table, now);
  const dryRun = options.dryRun === true;
  const empty: DropExpiredResult = {
    table,
    retention,
    dryRun,
    dropped: [],
    wouldDrop: [],
    heldBack: [],
    runIds: [],
  };
  if (retention.cutoff === null) return empty;

  const [partitions, holds] = await Promise.all([listPartitions(table), openLegalHolds()]);
  const cutoffMs = retention.cutoff.getTime();

  const candidates: ExistingPartition[] = [];
  const heldBack: HeldBackPartition[] = [];
  for (const part of partitions) {
    if (part.isDefault) continue;
    // MAXVALUE upper bound: the partition reaches into the future and can never expire.
    if (part.hi === null) continue;
    if (part.hi.getTime() > cutoffMs) continue;
    const holdIds = holds
      .filter((hold) => holdCoversRange(hold, part.lo, part.hi))
      .map((hold) => hold.holdId);
    if (holdIds.length > 0) {
      heldBack.push({ partition: part.name, holdIds });
      continue;
    }
    candidates.push(part);
  }
  candidates.sort((a, b) => (a.hi?.getTime() ?? 0) - (b.hi?.getTime() ?? 0));

  if (candidates.length === 0 || dryRun) {
    return {
      table,
      retention,
      dryRun,
      dropped: [],
      wouldDrop: dryRun ? candidates.map((c) => c.name) : [],
      heldBack,
      runIds: [],
    };
  }

  const startedAt = now;
  const dropped: string[] = [];
  await withMaintTx(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '15s'`));
    for (const part of candidates) {
      await tx.execute(sql.raw(`DROP TABLE ${assertIdentifier(part.name)}`));
      dropped.push(part.name);
    }
  });

  // One `ingest_runs` row per drop (DATA_MODEL §7.3 L1237): dropping a partition destroys data, so
  // it leaves an audit row naming what went and under which licence. `updated = 1` is the object
  // removed. `ingest_runs` has no free-form details column — the closest structured one is
  // `errors JobError[] = {code, message, …}` — so the partition name is written there as a single
  // `PARTITION_DROPPED` entry on an otherwise `status = 'ok'` row. It is the only place the name
  // fits; `ops/status` readers filter on `status`, not on an empty `errors` array.
  const runIds: number[] = [];
  await withTx(null, async (tx) => {
    for (const name of dropped) {
      const result = await tx.execute<{ run_id: string }>(sql`
        INSERT INTO ingest_runs (job_id, source_id, started_at, finished_at, status,
                                 fetched, inserted, updated, skipped, errors)
        VALUES (${jobId}, ${retention.sourceId}, ${startedAt.toISOString()},
                ${new Date().toISOString()}, 'ok', 0, 0, 1, 0,
                ${JSON.stringify([{ code: 'PARTITION_DROPPED', message: name }])}::jsonb)
        RETURNING run_id`);
      const row = result.rows[0];
      if (row !== undefined) runIds.push(Number(row.run_id));
    }
  });

  return { table, retention, dryRun, dropped, wouldDrop: [], heldBack, runIds };
}

/** `dropExpired` for every plan — `ingest/jobs/retentionPurge.ts`. */
export async function dropExpiredAll(
  options: DropExpiredOptions = {},
): Promise<DropExpiredResult[]> {
  const results: DropExpiredResult[] = [];
  for (const table of PARTITIONED_TABLES) {
    results.push(await dropExpired(table, options));
  }
  return results;
}
