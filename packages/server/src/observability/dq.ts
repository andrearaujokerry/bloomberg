/**
 * `observability/dq.ts` — the data-quality monitors (PROVIDERS §14 L2780-2856, OPS-03, QA-03).
 *
 * Everything a job, an adapter or the plant notices about the *quality* of what a source published
 * lands in one table, `dq_events(ts, kind, severity, instrument_id, md_line_id, source_id, subject,
 * details, resolved_at)`. `kind` is a CHECK list of exactly thirteen values (DATA_MODEL L2121 /
 * migration 0014); `DqKind` below is that list verbatim, so a typo is a type error rather than a
 * constraint violation discovered in production.
 *
 * Three groups of entry points:
 *
 *  1. `raiseDq` — the writer. Every other function funnels through it. When a `key` is supplied it
 *     is *idempotent*: at most one unresolved row per `(kind, source_id, subject, key)`, so a
 *     monitor that runs every minute does not produce 1 440 identical rows a day. The key is also
 *     stored in `details.key`, which is the shape `ingest/jobs/secNport.ts#recordDqEvent` already
 *     writes, so the two agree on the wire.
 *  2. `check*` — a monitor: it evaluates a rule and raises only when the rule is broken. The
 *     decision half of each one is a pure exported function (`isStale`, `divergencePct`,
 *     `populationRate`) so it can be asserted without a database.
 *  3. `raise*` — a named shorthand for a kind an adapter raises inline (parse errors, poll
 *     anomalies, an opened circuit breaker), with the details PROVIDERS §14.5 names for it.
 *
 * Connection discipline: every statement here runs on the **application** pool through
 * `db/client.ts#withTx(null, …)` (or a caller-supplied `Tx`). `terminal_app` holds INSERT, UPDATE
 * and DELETE on `dq_events` (migration 0015 §15.b) and SELECT on everything a sweep reads;
 * `terminal_maint` holds none of that — it owns the six partitioned parents and nothing else. That
 * is why `db/partitions.ts` does its DDL on the maintenance connection but calls back into this
 * module, on the application connection, to record what the DDL found.
 */

import { sql } from 'drizzle-orm';

import { withTx } from '../db/client.js';

import type { Tx } from '../db/client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The kind and severity vocabularies
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `dq_events.kind` — the CHECK list of migration 0014 verbatim, in its order. Nothing else may be
 * written to the column.
 */
export const DQ_KINDS = [
  'stale_tick',
  'cross_source_divergence',
  'missing_close',
  'field_population',
  'poll_anomaly',
  'provider_circuit_open',
  'reconcile_mismatch',
  'parse_error',
  'default_partition_nonempty',
  'ref_orphans',
  'ws_backpressure',
  'plant_degraded',
  'replay_diff',
] as const;

export type DqKind = (typeof DQ_KINDS)[number];

/** `dq_events.severity` — `severity = 'error'` also opens a `status_incidents` row (OPS-04). */
export const DQ_SEVERITIES = ['info', 'warn', 'error'] as const;
export type DqSeverity = (typeof DQ_SEVERITIES)[number];

/** True when `value` is one of the thirteen CHECK-listed kinds. */
export function isDqKind(value: string): value is DqKind {
  return (DQ_KINDS as readonly string[]).includes(value);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The writer
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `dq_events` row. Optional columns are `| null`-able because they are written as SQL NULLs. */
export interface DqEventInput {
  readonly kind: DqKind;
  readonly severity: DqSeverity;
  /** The instrument the finding is about, when it is about one. */
  readonly instrumentId?: number | null;
  /** The provider line (`md_lines.md_line_id`) the finding is about. */
  readonly mdLineId?: number | null;
  /** `licence_registry.source_id`. NULL for findings that are not a source's fault. */
  readonly sourceId?: string | null;
  /** Plant subject (`q:42`, `n:feed:markets`) or table name. */
  readonly subject?: string | null;
  /** `{expected, actual, diffPct, …}` — whatever the rule compared. */
  readonly details?: Readonly<Record<string, unknown>>;
  /**
   * Idempotency key. With it, the row is written only when no *unresolved* row already exists for
   * the same `(kind, source_id, subject, key)`; it is also stored in `details.key`.
   */
  readonly key?: string;
  /** Overrides `now()` — tests and replayed runs supply the virtual clock's instant. */
  readonly ts?: Date;
}

/** Where a monitor runs: inside a caller's transaction, or on its own. */
export interface DqOptions {
  /** Join this transaction instead of opening one (an ingest job passes its own `tx`). */
  readonly tx?: Tx;
}

async function onTx<T>(options: DqOptions | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = options?.tx;
  if (tx !== undefined) return fn(tx);
  return withTx(null, fn);
}

function detailsWithKey(input: DqEventInput): string {
  const details: Record<string, unknown> =
    input.key === undefined
      ? { ...(input.details ?? {}) }
      : { ...(input.details ?? {}), key: input.key };
  return JSON.stringify(details);
}

/**
 * Write one `dq_events` row.
 *
 * @returns the new `dq_id`, or `null` when an unresolved row with the same `key` already exists
 *          (so a caller can count what it actually opened).
 */
export async function raiseDq(input: DqEventInput, options?: DqOptions): Promise<number | null> {
  const details = detailsWithKey(input);
  const instrumentId = input.instrumentId ?? null;
  const mdLineId = input.mdLineId ?? null;
  const sourceId = input.sourceId ?? null;
  const subject = input.subject ?? null;
  const ts = input.ts ?? null;

  return onTx(options, async (tx) => {
    const result =
      input.key === undefined
        ? await tx.execute<{ dq_id: string }>(sql`
            INSERT INTO dq_events (ts, kind, severity, instrument_id, md_line_id, source_id, subject, details)
            VALUES (coalesce(${ts?.toISOString() ?? null}::timestamptz, now()), ${input.kind}, ${input.severity},
                    ${instrumentId}::bigint, ${mdLineId}::bigint, ${sourceId}, ${subject}, ${details}::jsonb)
            RETURNING dq_id`)
        : await tx.execute<{ dq_id: string }>(sql`
            INSERT INTO dq_events (ts, kind, severity, instrument_id, md_line_id, source_id, subject, details)
            SELECT coalesce(${ts?.toISOString() ?? null}::timestamptz, now()), ${input.kind}, ${input.severity},
                   ${instrumentId}::bigint, ${mdLineId}::bigint, ${sourceId}, ${subject}, ${details}::jsonb
             WHERE NOT EXISTS (
               SELECT 1 FROM dq_events
                WHERE kind = ${input.kind}
                  AND source_id IS NOT DISTINCT FROM ${sourceId}
                  AND subject IS NOT DISTINCT FROM ${subject}
                  AND details ->> 'key' = ${input.key}
                  AND resolved_at IS NULL)
            RETURNING dq_id`);
    const row = result.rows[0];
    return row === undefined ? null : Number(row.dq_id);
  });
}

/**
 * Close every unresolved event matching the selector — the counterpart of a keyed `raiseDq`, used
 * when the condition clears (a breaker half-opens, a close finally arrives).
 *
 * @returns how many rows were closed.
 */
export async function resolveDq(
  selector: {
    readonly kind: DqKind;
    readonly sourceId?: string | null;
    readonly subject?: string | null;
    readonly key?: string;
  },
  options?: DqOptions,
): Promise<number> {
  return onTx(options, async (tx) => {
    const result = await tx.execute<{ dq_id: string }>(sql`
      UPDATE dq_events SET resolved_at = now()
       WHERE kind = ${selector.kind}
         AND resolved_at IS NULL
         AND (${selector.sourceId ?? null}::text IS NULL OR source_id = ${selector.sourceId ?? null})
         AND (${selector.subject ?? null}::text IS NULL OR subject = ${selector.subject ?? null})
         AND (${selector.key ?? null}::text IS NULL OR details ->> 'key' = ${selector.key ?? null})
       RETURNING dq_id`);
    return result.rows.length;
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Pure decision helpers (asserted without a database)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * PROVIDERS §14.1: a line is stale when nothing has been captured for `multiplier ×` its expected
 * poll interval. The default multiplier is 3 — the same threshold `plant/valueState` uses, so the
 * screen and the alert can never disagree.
 */
export function isStale(
  lastCaptureMs: number | null,
  expectedIntervalMs: number,
  nowMs: number,
  multiplier = 3,
): boolean {
  if (lastCaptureMs === null) return true;
  return nowMs - lastCaptureMs > expectedIntervalMs * multiplier;
}

/**
 * Signed percentage difference of `actual` from `expected`, as a percentage of `expected`.
 * `NaN` when `expected` is zero — a divergence check against a zero reference is not a comparison.
 */
export function divergencePct(expected: number, actual: number): number {
  if (expected === 0) return Number.NaN;
  return ((actual - expected) / Math.abs(expected)) * 100;
}

/** Populated ÷ eligible as a fraction in [0, 1]; `1` when nothing was eligible (§14.4). */
export function populationRate(populated: number, eligible: number): number {
  if (eligible <= 0) return 1;
  return populated / eligible;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §14.1 stale ticks · §14.2 divergence · §14.3 missing closes · §14.4 field population
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface StaleTickCheck {
  readonly sourceId: string;
  readonly subject: string;
  readonly lastCaptureMs: number | null;
  readonly expectedIntervalMs: number;
  readonly nowMs: number;
  readonly multiplier?: number;
  readonly severity?: DqSeverity;
  readonly instrumentId?: number | null;
  readonly mdLineId?: number | null;
}

/** §14.1 — raises `stale_tick` when the line has gone quiet. Returns the `dq_id`, or `null`. */
export async function checkStaleTick(
  check: StaleTickCheck,
  options?: DqOptions,
): Promise<number | null> {
  const multiplier = check.multiplier ?? 3;
  if (!isStale(check.lastCaptureMs, check.expectedIntervalMs, check.nowMs, multiplier)) {
    return null;
  }
  const ageMs = check.lastCaptureMs === null ? null : check.nowMs - check.lastCaptureMs;
  return raiseDq(
    {
      kind: 'stale_tick',
      severity: check.severity ?? 'warn',
      sourceId: check.sourceId,
      subject: check.subject,
      instrumentId: check.instrumentId ?? null,
      mdLineId: check.mdLineId ?? null,
      key: `${check.subject}:${Math.floor(check.nowMs / 60_000)}`,
      details: {
        expectedIntervalMs: check.expectedIntervalMs,
        multiplier,
        ageMs,
        lastCaptureAt:
          check.lastCaptureMs === null ? null : new Date(check.lastCaptureMs).toISOString(),
      },
      ts: new Date(check.nowMs),
    },
    options,
  );
}

export interface DivergenceCheck {
  readonly sourceId: string;
  readonly subject: string;
  /** The value we trust more (the left-hand side of the §14.2 pair). */
  readonly expected: number;
  readonly actual: number;
  /** Absolute tolerance in percent: `0.5` for a Cboe/Yahoo close pair. */
  readonly tolerancePct: number;
  readonly severity?: DqSeverity;
  readonly instrumentId?: number | null;
  readonly key?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** §14.2 — raises `cross_source_divergence` when |diff| exceeds the tolerance. */
export async function checkCrossSourceDivergence(
  check: DivergenceCheck,
  options?: DqOptions,
): Promise<number | null> {
  const diffPct = divergencePct(check.expected, check.actual);
  if (Number.isNaN(diffPct) || Math.abs(diffPct) <= check.tolerancePct) return null;
  return raiseDq(
    {
      kind: 'cross_source_divergence',
      severity: check.severity ?? 'warn',
      sourceId: check.sourceId,
      subject: check.subject,
      instrumentId: check.instrumentId ?? null,
      ...(check.key === undefined ? {} : { key: check.key }),
      details: {
        ...(check.details ?? {}),
        expected: check.expected,
        actual: check.actual,
        diffPct,
        tolerancePct: check.tolerancePct,
      },
    },
    options,
  );
}

export interface MissingCloseInput {
  readonly sourceId: string;
  readonly subject: string;
  readonly sessionDate: string;
  readonly severity?: DqSeverity;
  readonly instrumentId?: number | null;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** §14.3 — the close (or fixing, or curve point) that a session owed us never arrived. */
export async function raiseMissingClose(
  input: MissingCloseInput,
  options?: DqOptions,
): Promise<number | null> {
  return raiseDq(
    {
      kind: 'missing_close',
      severity: input.severity ?? 'error',
      sourceId: input.sourceId,
      subject: input.subject,
      instrumentId: input.instrumentId ?? null,
      key: `${input.subject}:${input.sessionDate}`,
      details: { ...(input.details ?? {}), sessionDate: input.sessionDate },
    },
    options,
  );
}

export interface FieldPopulationCheck {
  readonly sourceId: string;
  /** `fields.field_id` — `PX_BID`, `OPT_IV`, … */
  readonly fieldId: string;
  readonly populated: number;
  readonly eligible: number;
  /** The §14.4 floor as a fraction: `0.95` for Cboe `PX_BID`. */
  readonly floor: number;
  readonly sessionDate: string;
  readonly severity?: DqSeverity;
  /** §11.3.5: the news floor is reported, not gated — an `info` row and nothing else. */
  readonly gated?: boolean;
}

/** §14.4 — raises `field_population` when the day's populated rate falls under the floor. */
export async function checkFieldPopulation(
  check: FieldPopulationCheck,
  options?: DqOptions,
): Promise<number | null> {
  const rate = populationRate(check.populated, check.eligible);
  if (rate >= check.floor) return null;
  return raiseDq(
    {
      kind: 'field_population',
      severity: check.severity ?? (check.gated === false ? 'info' : 'warn'),
      sourceId: check.sourceId,
      subject: check.fieldId,
      key: `${check.sourceId}:${check.fieldId}:${check.sessionDate}`,
      details: {
        fieldId: check.fieldId,
        populated: check.populated,
        eligible: check.eligible,
        rate,
        floor: check.floor,
        sessionDate: check.sessionDate,
      },
    },
    options,
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §14.5 the remaining kinds, raised inline by adapters, jobs, the plant and the harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PollAnomalyInput {
  readonly sourceId: string;
  readonly subject: string;
  /** What the guard expected — a row count, a byte count, a range. */
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly detail: string;
  readonly severity?: DqSeverity;
  readonly key?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** §14.5 — a payload-size or row-count guard tripped; the previous snapshot stands. */
export async function raisePollAnomaly(
  input: PollAnomalyInput,
  options?: DqOptions,
): Promise<number | null> {
  return raiseDq(
    {
      kind: 'poll_anomaly',
      severity: input.severity ?? 'error',
      sourceId: input.sourceId,
      subject: input.subject,
      key: input.key ?? `${input.sourceId}:${input.subject}:${input.detail}`,
      details: {
        ...(input.details ?? {}),
        detail: input.detail,
        ...(input.expected === undefined ? {} : { expected: input.expected }),
        ...(input.actual === undefined ? {} : { actual: input.actual }),
      },
    },
    options,
  );
}

export interface CircuitOpenInput {
  readonly sourceId: string;
  readonly consecutiveFailures: number;
  readonly lastStatus: number | null;
  readonly lastUrl: string;
  readonly openedAt: Date;
}

/**
 * §2.5 / §14.5 — one row per *opening* of a provider's breaker, carrying exactly the four details
 * the design names. Keyed on the opening instant so a breaker that stays open does not repeat.
 */
export async function raiseProviderCircuitOpen(
  input: CircuitOpenInput,
  options?: DqOptions,
): Promise<number | null> {
  return raiseDq(
    {
      kind: 'provider_circuit_open',
      severity: 'error',
      sourceId: input.sourceId,
      subject: input.sourceId,
      key: `${input.sourceId}:${input.openedAt.toISOString()}`,
      details: {
        consecutiveFailures: input.consecutiveFailures,
        lastStatus: input.lastStatus,
        lastUrl: input.lastUrl,
        openedAt: input.openedAt.toISOString(),
      },
      ts: input.openedAt,
    },
    options,
  );
}

export interface ReconcileMismatchInput {
  readonly sourceId: string;
  readonly subject: string;
  /** The provider-published number. */
  readonly published: number | string | null;
  /** What we recomputed from the same payload. */
  readonly recomputed: number | string | null;
  readonly field: string;
  readonly severity?: DqSeverity;
  readonly instrumentId?: number | null;
  readonly key?: string;
}

/** §14.5 — a provider-computed value we recompute disagreed. Never blocking (`warn`). */
export async function raiseReconcileMismatch(
  input: ReconcileMismatchInput,
  options?: DqOptions,
): Promise<number | null> {
  return raiseDq(
    {
      kind: 'reconcile_mismatch',
      severity: input.severity ?? 'warn',
      sourceId: input.sourceId,
      subject: input.subject,
      instrumentId: input.instrumentId ?? null,
      key: input.key ?? `${input.sourceId}:${input.subject}:${input.field}`,
      details: { field: input.field, expected: input.published, actual: input.recomputed },
    },
    options,
  );
}

export interface ParseErrorInput {
  readonly sourceId: string;
  readonly subject: string;
  readonly message: string;
  readonly requestKey?: string;
  readonly path?: string;
  readonly severity?: DqSeverity;
  readonly instrumentId?: number | null;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * §14.5 — a `NormaliseProblem` of kind `parse_error`, or a range violation that dropped a value.
 * `parse.ts` never throws; it returns the problem and this is where the problem is recorded.
 */
export async function raiseParseError(
  input: ParseErrorInput,
  options?: DqOptions,
): Promise<number | null> {
  return raiseDq(
    {
      kind: 'parse_error',
      severity: input.severity ?? 'error',
      sourceId: input.sourceId,
      subject: input.subject,
      instrumentId: input.instrumentId ?? null,
      key: `${input.sourceId}:${input.subject}:${input.requestKey ?? input.message}`,
      details: {
        ...(input.details ?? {}),
        message: input.message,
        ...(input.requestKey === undefined ? {} : { requestKey: input.requestKey }),
        ...(input.path === undefined ? {} : { path: input.path }),
      },
    },
    options,
  );
}

/** §14.5 — the WebSocket gateway shed or slowed a client (WP-06 raises it). */
export async function raiseWsBackpressure(
  input: {
    readonly subject: string;
    readonly sessionId: string;
    readonly queued: number;
    readonly droppedFrames: number;
    readonly severity?: DqSeverity;
  },
  options?: DqOptions,
): Promise<number | null> {
  return raiseDq(
    {
      kind: 'ws_backpressure',
      severity: input.severity ?? 'warn',
      subject: input.subject,
      key: `${input.sessionId}:${input.subject}`,
      details: {
        sessionId: input.sessionId,
        queued: input.queued,
        droppedFrames: input.droppedFrames,
      },
    },
    options,
  );
}

/** §14.5 — the ticker plant is running degraded (conflation widened, a feed shed). */
export async function raisePlantDegraded(
  input: {
    readonly subject: string;
    readonly reason: string;
    readonly severity?: DqSeverity;
    readonly details?: Readonly<Record<string, unknown>>;
  },
  options?: DqOptions,
): Promise<number | null> {
  return raiseDq(
    {
      kind: 'plant_degraded',
      severity: input.severity ?? 'warn',
      subject: input.subject,
      key: `${input.subject}:${input.reason}`,
      details: { ...(input.details ?? {}), reason: input.reason },
    },
    options,
  );
}

/** §14.5 — a replayed run produced output the golden does not contain (QA harness). */
export async function raiseReplayDiff(
  input: {
    readonly sourceId: string;
    readonly subject: string;
    readonly requestKey: string;
    readonly diff: string;
    readonly severity?: DqSeverity;
  },
  options?: DqOptions,
): Promise<number | null> {
  return raiseDq(
    {
      kind: 'replay_diff',
      severity: input.severity ?? 'error',
      sourceId: input.sourceId,
      subject: input.subject,
      key: input.requestKey,
      details: { requestKey: input.requestKey, diff: input.diff },
    },
    options,
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §14.5 `default_partition_nonempty` — the monitor `partitionMaintenance` and `dqMonitors` share
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A safe SQL identifier: the monitors interpolate table names, so they are validated first. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(name: string, what: string): string {
  if (!IDENTIFIER.test(name))
    throw new Error(`${what}: unsafe SQL identifier ${JSON.stringify(name)}`);
  return name;
}

/** One partitioned table to sweep. `db/partitions.ts` derives these from `partitionPlans`. */
export interface DefaultPartitionSpec {
  /** The partitioned parent, e.g. `quote_ticks`. The default partition is `<table>_default`. */
  readonly table: string;
  /** The partition key column, e.g. `capture_ts`. */
  readonly column: string;
  /**
   * WORM tables (`access_log`, `usage_events`) cannot have their default partition drained: the
   * 15.d trigger blocks the DELETE for every role, including the owner. Rows there need an
   * operator, so the finding is an `error` rather than a `warn`.
   */
  readonly worm?: boolean;
}

export interface DefaultPartitionFinding {
  readonly table: string;
  readonly partition: string;
  readonly rows: number;
  readonly oldest: string | null;
  readonly newest: string | null;
  readonly dqId: number | null;
}

/**
 * DATA_MODEL §7.1 rule 4 — every partitioned table keeps a `<table>_default` partition so an
 * out-of-window row never fails an insert, and a non-empty one is a defect: it means a row arrived
 * outside the horizon `ensurePartitions` maintains. Raises `default_partition_nonempty` per table.
 *
 * @param specs the partitioned parents to sweep.
 * @returns one finding per table whose default partition holds rows (empty ones are not reported).
 */
export async function checkDefaultPartitions(
  specs: readonly DefaultPartitionSpec[],
  options?: DqOptions & { readonly severity?: DqSeverity; readonly now?: Date },
): Promise<DefaultPartitionFinding[]> {
  const findings: DefaultPartitionFinding[] = [];
  for (const spec of specs) {
    const table = assertIdentifier(spec.table, 'checkDefaultPartitions');
    const column = assertIdentifier(spec.column, 'checkDefaultPartitions');
    const partition = `${table}_default`;
    const counted = await onTx(options, async (tx) =>
      tx.execute<{ n: string; oldest: string | null; newest: string | null }>(
        sql.raw(
          `SELECT count(*)::text AS n, min(${column})::text AS oldest, max(${column})::text AS newest
             FROM ${partition}`,
        ),
      ),
    );
    const row = counted.rows[0];
    const rows = Number(row?.n ?? '0');
    if (rows === 0) continue;
    const severity = options?.severity ?? (spec.worm === true ? 'error' : 'warn');
    const dqId = await raiseDq(
      {
        kind: 'default_partition_nonempty',
        severity,
        subject: table,
        // One open row per (table, sweep day): a default partition that stays non-empty is one
        // incident, not one per monitor tick.
        key: `${partition}:${(options?.now ?? new Date()).toISOString().slice(0, 10)}`,
        details: {
          table,
          partition,
          column,
          rows,
          oldest: row?.oldest ?? null,
          newest: row?.newest ?? null,
          worm: spec.worm === true,
        },
        ...(options?.now === undefined ? {} : { ts: options.now }),
      },
      options,
    );
    findings.push({
      table,
      partition,
      rows,
      oldest: row?.oldest ?? null,
      newest: row?.newest ?? null,
      dqId,
    });
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §14.5 `ref_orphans` — the nightly referential sweep
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One child → parent reference that Postgres does not enforce. `index_members.instrument_id` and
 * `filings.issuer_id` carry no FK on purpose: a membership file names a constituent before the
 * security master has it, and a filing is ingested before its issuer is resolved. That is legal
 * *in flight* and a defect once it persists, which is what this sweep measures.
 */
export interface OrphanSweep {
  readonly child: string;
  readonly childColumn: string;
  readonly parent: string;
  readonly parentColumn: string;
  /** Restrict the child side to current rows (`tx_to = 'infinity'`) — bitemporal tables only. */
  readonly childCurrent?: boolean;
  /** Restrict the parent side the same way. */
  readonly parentCurrent?: boolean;
  readonly severity?: DqSeverity;
}

/** The two sweeps PROVIDERS §14.5 names. */
export const DEFAULT_ORPHAN_SWEEPS: readonly OrphanSweep[] = [
  {
    child: 'index_members',
    childColumn: 'instrument_id',
    parent: 'instruments',
    parentColumn: 'instrument_id',
    childCurrent: true,
    parentCurrent: true,
    severity: 'error',
  },
  {
    child: 'filings',
    childColumn: 'issuer_id',
    parent: 'issuers',
    parentColumn: 'issuer_id',
    parentCurrent: true,
    severity: 'warn',
  },
];

export interface OrphanFinding {
  readonly child: string;
  readonly childColumn: string;
  readonly orphans: number;
  readonly sample: readonly string[];
  readonly dqId: number | null;
}

/**
 * §14.5 — counts rows whose non-NULL reference has no live parent and raises `ref_orphans` with a
 * sample of the offending keys. Clean sweeps produce no row and no finding.
 */
export async function checkRefOrphans(
  sweeps: readonly OrphanSweep[] = DEFAULT_ORPHAN_SWEEPS,
  options?: DqOptions & { readonly now?: Date; readonly sampleSize?: number },
): Promise<OrphanFinding[]> {
  const sampleSize = options?.sampleSize ?? 10;
  const findings: OrphanFinding[] = [];
  for (const sweep of sweeps) {
    const child = assertIdentifier(sweep.child, 'checkRefOrphans');
    const childColumn = assertIdentifier(sweep.childColumn, 'checkRefOrphans');
    const parent = assertIdentifier(sweep.parent, 'checkRefOrphans');
    const parentColumn = assertIdentifier(sweep.parentColumn, 'checkRefOrphans');
    const childFilter = sweep.childCurrent === true ? `AND c.tx_to = 'infinity'` : '';
    const parentFilter = sweep.parentCurrent === true ? `AND p.tx_to = 'infinity'` : '';
    const result = await onTx(options, async (tx) =>
      tx.execute<{ n: string; sample: string[] | null }>(
        sql.raw(
          `WITH orphan AS (
             SELECT DISTINCT c.${childColumn} AS ref
               FROM ${child} c
              WHERE c.${childColumn} IS NOT NULL ${childFilter}
                AND NOT EXISTS (SELECT 1 FROM ${parent} p
                                 WHERE p.${parentColumn} = c.${childColumn} ${parentFilter}))
           SELECT count(*)::text AS n,
                  (SELECT array_agg(ref::text ORDER BY ref) FROM (
                     SELECT ref FROM orphan ORDER BY ref LIMIT ${String(Math.max(1, Math.trunc(sampleSize)))}) s
                  ) AS sample
             FROM orphan`,
        ),
      ),
    );
    const row = result.rows[0];
    const orphans = Number(row?.n ?? '0');
    if (orphans === 0) continue;
    const sample = row?.sample ?? [];
    const dqId = await raiseDq(
      {
        kind: 'ref_orphans',
        severity: sweep.severity ?? 'warn',
        subject: child,
        key: `${child}.${childColumn}:${(options?.now ?? new Date()).toISOString().slice(0, 10)}`,
        details: {
          child,
          childColumn,
          parent,
          parentColumn,
          orphans,
          sample,
        },
        ...(options?.now === undefined ? {} : { ts: options.now }),
      },
      options,
    );
    findings.push({ child, childColumn, orphans, sample, dqId });
  }
  return findings;
}
