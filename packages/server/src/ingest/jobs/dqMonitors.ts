/**
 * `dqMonitors` — the periodic data-quality checks of PROVIDERS §14, on a one-minute tick.
 *
 * PROVIDERS §13 row: `id 'dqMonitors'`, no `provider`, schedule `{everyMs: 60000}`, target set
 * "every check in §14", `priority 2`, `timeoutMs 30000`. §14 opens with the division of labour
 * this file implements one half of: "`ingest/jobs/dqMonitors.ts` runs the periodic checks;
 * `ingest/jobs/reconcile.ts` runs the cross-source ones after the US close; adapters raise the
 * rest inline."
 *
 * Every rule and every threshold lives in `observability/dq.ts`; this module is the *schedule*
 * around them. It owns three things and nothing else:
 *
 *  1. **Which monitors exist** — {@link MONITORS}, one entry per §14 subsection that is periodic.
 *  2. **How often each one may run.** The job ticks every minute, but sweeping six default
 *     partitions or every unenforced reference every minute is waste: each monitor declares a
 *     `minIntervalMs`, and an optional ET window (`missing_close` is a 18:30 alarm, not a
 *     continuous one). {@link MonitorState} holds the last-run instants, so the spacing is driven
 *     by the injected `Clock` and a test can advance it rather than wait.
 *  3. **That one monitor's failure does not silence the others.** A monitor that throws is
 *     recorded as a `JobError` on the run and the next monitor still runs. A data-quality system
 *     that goes dark because one sweep hit a lock is worse than no data-quality system, because
 *     the screen still shows green.
 *
 * Idempotency belongs to `raiseDq`, not here: every check passes a `key`, and `raiseDq` writes at
 * most one *unresolved* row per `(kind, source_id, subject, key)`. That is what lets a monitor run
 * every minute without producing 1,440 identical rows a day.
 *
 * ## What is NOT here
 *
 *  * `cross_source_divergence` — `reconcile.ts` (§14.2), after the close.
 *  * `parse_error`, `poll_anomaly`, `provider_circuit_open`, `reconcile_mismatch` — raised inline
 *    by the adapter or the HTTP client that saw the problem, with the payload in hand (§14.5).
 *  * `ws_backpressure`, `plant_degraded`, `replay_diff` — plant and harness concerns (WP-06, QA).
 */

import { sql } from 'drizzle-orm';

import { withTx } from '../../db/client.js';
import { defaultPartitionSpecs } from '../../db/partitions.js';
import {
  DEFAULT_ORPHAN_SWEEPS,
  checkDefaultPartitions,
  checkFieldPopulation,
  checkRefOrphans,
  checkStaleTick,
  raiseMissingClose,
} from '../../observability/dq.js';
import { inExtendedSession, zonedParts } from '../scheduler.js';

import type { Tx } from '../../db/client.js';
import type { DqOptions } from '../../observability/dq.js';
import type { IngestLogger, JobError, JobResult } from '../scheduler.js';
import type { Clock } from '@terminal/core';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The §13 row
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const DQ_MONITORS_JOB_ID = 'dqMonitors';

/** PROVIDERS §13: `{everyMs: 60000}` — the tick, not the spacing of any individual monitor. */
export const DQ_MONITORS_SCHEDULE = { everyMs: 60_000 } as const;

export const DQ_MONITORS_TIMEOUT_MS = 30_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The §14.1 sources whose lines are polled and can therefore go quiet. */
export const STALE_TICK_SOURCES: readonly string[] = [
  'cboe.quotes',
  'cboe.options',
  'cboe.euIndices',
  'yahoo.chart',
  'coingecko.simple',
];

/** No more than this many `stale_tick` findings per sweep: an outage is one incident, not 4,000. */
export const STALE_TICK_LIMIT = 250;

/** No more than this many `missing_close` findings per sweep, for the same reason. */
export const MISSING_CLOSE_LIMIT = 250;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Context, state and the monitor contract
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a monitor sweep needs: a clock, and a transaction to read and write in. The scheduler
 * supplies both; a test supplies its own rolled-back `Tx` so nothing it raises survives.
 */
export interface DqMonitorContext {
  clock: Clock;
  /** Join this transaction; omitted, every check opens its own on the application pool. */
  tx?: Tx;
  log?: IngestLogger;
  traceId?: string;
  runId?: number;
}

/** Last-run bookkeeping. The scheduler keeps one instance per job; tests make their own. */
export class MonitorState {
  readonly #lastRunMs = new Map<string, number>();

  lastRun(id: string): number | undefined {
    return this.#lastRunMs.get(id);
  }

  markRun(id: string, atMs: number): void {
    this.#lastRunMs.set(id, atMs);
  }

  clear(): void {
    this.#lastRunMs.clear();
  }
}

/** The ET window a monitor may run in, as minutes from local midnight. */
export interface EtWindow {
  readonly fromMin: number;
  readonly toMin: number;
  /** Weekdays only (0 = Sunday). Default `[1,2,3,4,5]`. */
  readonly weekdays?: readonly number[];
}

export interface Monitor {
  /** Stable id: the `MonitorState` key and the `details.monitor` of everything it raises. */
  readonly id: string;
  /** The §14 subsection it implements. */
  readonly section: string;
  /** Minimum spacing between two runs of this monitor. */
  readonly minIntervalMs: number;
  /** Run only inside the extended US session (04:00-20:00 ET, weekdays). */
  readonly sessionOnly?: boolean;
  /** Run only inside this ET window. */
  readonly window?: EtWindow;
  run(ctx: DqMonitorContext, nowMs: number): Promise<MonitorOutcome>;
}

export interface MonitorOutcome {
  /** Rows examined — lines swept, partitions checked, instruments considered. */
  readonly examined: number;
  /** `dq_events` rows actually opened (a suppressed duplicate does not count). */
  readonly raised: number;
  /** Findings the monitor saw, whether or not `raiseDq` opened a row for each. */
  readonly findings: number;
}

const NOTHING: MonitorOutcome = { examined: 0, raised: 0, findings: 0 };

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Gating
// ─────────────────────────────────────────────────────────────────────────────────────────────

function inWindow(nowMs: number, window: EtWindow): boolean {
  const parts = zonedParts(nowMs);
  const weekdays = window.weekdays ?? [1, 2, 3, 4, 5];
  if (!weekdays.includes(parts.weekday)) return false;
  const minuteOfDay = parts.hour * 60 + parts.minute;
  return minuteOfDay >= window.fromMin && minuteOfDay < window.toMin;
}

/** True when `monitor` is allowed to run at `nowMs` given what `state` remembers. */
export function shouldRun(monitor: Monitor, state: MonitorState, nowMs: number): boolean {
  if (monitor.sessionOnly === true && !inExtendedSession(nowMs)) return false;
  if (monitor.window !== undefined && !inWindow(nowMs, monitor.window)) return false;
  const last = state.lastRun(monitor.id);
  if (last === undefined) return true;
  return nowMs - last >= monitor.minIntervalMs;
}

function dqOptions(ctx: DqMonitorContext): DqOptions | undefined {
  return ctx.tx === undefined ? undefined : { tx: ctx.tx };
}

function onTx<T>(ctx: DqMonitorContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return ctx.tx === undefined ? withTx(null, fn) : fn(ctx.tx);
}

/** The UTC session date of an instant, as `bars_daily.session_date` stores it. */
function utcSessionDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §14.1 — stale ticks
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface StaleRow {
  [column: string]: unknown;
  md_line_id: string;
  instrument_id: string;
  source_id: string;
  provider_symbol: string;
  expected_interval_ms: number;
  last_capture_ms: string | null;
}

/**
 * §14.1 — a polled line that has published nothing for `3 × expected_interval_ms` during an open
 * session. The multiplier is `checkStaleTick`'s default, which is also what `plant/valueState`
 * uses, so the screen and the alert can never disagree about what "stale" means.
 *
 * Only lines that captured *something* in the last 24 hours are swept. A line with no tick at all
 * is not stale — it is dormant, or never started, and that is `missing_close`'s and
 * `poll_anomaly`'s business. Sweeping it here would raise one row a minute for every line in a
 * database that has just been migrated.
 */
async function sweepStaleTicks(ctx: DqMonitorContext, nowMs: number): Promise<MonitorOutcome> {
  const nowIso = new Date(nowMs).toISOString();
  const sinceIso = new Date(nowMs - DAY_MS).toISOString();

  const rows = await onTx(ctx, async (tx) => {
    const result = await tx.execute<StaleRow>(sql`
      SELECT l.md_line_id, l.instrument_id, l.source_id, l.provider_symbol,
             l.expected_interval_ms,
             (extract(epoch FROM t.capture_ts) * 1000)::bigint::text AS last_capture_ms
        FROM md_lines l
        JOIN LATERAL (
              SELECT q.capture_ts
                FROM quote_ticks q
               WHERE q.md_line_id = l.md_line_id
                 AND q.capture_ts >= ${sinceIso}::timestamptz
               ORDER BY q.capture_ts DESC
               LIMIT 1) t ON true
       WHERE l.tx_to = 'infinity'
         AND l.valid_from <= ${nowIso}::timestamptz
         AND l.valid_to  >  ${nowIso}::timestamptz
         AND l.source_id = ANY(string_to_array(${STALE_TICK_SOURCES.join(',')}, ',')::text[])
         AND l.expected_interval_ms > 0
         AND t.capture_ts < ${nowIso}::timestamptz - (l.expected_interval_ms * 3) * interval '1 millisecond'
       ORDER BY t.capture_ts
       LIMIT ${STALE_TICK_LIMIT}`);
    return result.rows;
  });

  let raised = 0;
  for (const row of rows) {
    const dqId = await checkStaleTick(
      {
        sourceId: row.source_id,
        subject: `q:${row.instrument_id}`,
        lastCaptureMs: row.last_capture_ms === null ? null : Number(row.last_capture_ms),
        expectedIntervalMs: Number(row.expected_interval_ms),
        nowMs,
        instrumentId: Number(row.instrument_id),
        mdLineId: Number(row.md_line_id),
        severity: row.source_id === 'coingecko.simple' ? 'info' : 'warn',
      },
      dqOptions(ctx),
    );
    if (dqId !== null) raised += 1;
  }
  return { examined: rows.length, raised, findings: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §14.3 — missing closes
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface MissingCloseRow {
  [column: string]: unknown;
  instrument_id: string;
  source_id: string;
  provider_symbol: string;
}

/**
 * §14.3 — by 18:30 ET a hot instrument owes us a close.
 *
 * Two rules, both restricted to instruments that *were* publishing: an instrument with a
 * `yahoo.chart` line and a `bars_daily` row in the previous ten days but none today, and an
 * instrument with a `cboe.quotes` line that ticked today but whose `bars_daily.official_close` is
 * still NULL. Restricting to recent publishers is what keeps a newly seeded universe from opening
 * thousands of alarms on its first evening.
 */
async function sweepMissingCloses(ctx: DqMonitorContext, nowMs: number): Promise<MonitorOutcome> {
  const sessionDate = utcSessionDate(nowMs);
  const nowIso = new Date(nowMs).toISOString();

  const yahoo = await onTx(ctx, async (tx) => {
    const result = await tx.execute<MissingCloseRow>(sql`
      SELECT DISTINCT l.instrument_id, l.source_id, l.provider_symbol
        FROM md_lines l
       WHERE l.tx_to = 'infinity'
         AND l.valid_from <= ${nowIso}::timestamptz
         AND l.valid_to  >  ${nowIso}::timestamptz
         AND l.source_id = 'yahoo.chart'
         AND EXISTS (SELECT 1 FROM bars_daily b
                      WHERE b.instrument_id = l.instrument_id
                        AND b.session_date >= ${sessionDate}::date - 10
                        AND b.session_date <  ${sessionDate}::date)
         AND NOT EXISTS (SELECT 1 FROM bars_daily b
                          WHERE b.instrument_id = l.instrument_id
                            AND b.session_date = ${sessionDate}::date)
       ORDER BY l.instrument_id
       LIMIT ${MISSING_CLOSE_LIMIT}`);
    return result.rows;
  });

  const cboe = await onTx(ctx, async (tx) => {
    const result = await tx.execute<MissingCloseRow>(sql`
      SELECT DISTINCT l.instrument_id, l.source_id, l.provider_symbol
        FROM md_lines l
       WHERE l.tx_to = 'infinity'
         AND l.valid_from <= ${nowIso}::timestamptz
         AND l.valid_to  >  ${nowIso}::timestamptz
         AND l.source_id = 'cboe.quotes'
         AND EXISTS (SELECT 1 FROM quote_ticks q
                      WHERE q.md_line_id = l.md_line_id
                        AND q.capture_ts >= ${sessionDate}::date
                        AND q.capture_ts <  ${sessionDate}::date + 1)
         AND NOT EXISTS (SELECT 1 FROM bars_daily b
                          WHERE b.instrument_id = l.instrument_id
                            AND b.session_date = ${sessionDate}::date
                            AND b.official_close IS NOT NULL)
       ORDER BY l.instrument_id
       LIMIT ${MISSING_CLOSE_LIMIT}`);
    return result.rows;
  });

  let raised = 0;
  for (const row of [...yahoo, ...cboe]) {
    const dqId = await raiseMissingClose(
      {
        sourceId: row.source_id,
        subject: `q:${row.instrument_id}`,
        sessionDate,
        instrumentId: Number(row.instrument_id),
        details: { providerSymbol: row.provider_symbol, monitor: 'missingCloses' },
      },
      dqOptions(ctx),
    );
    if (dqId !== null) raised += 1;
  }
  const findings = yahoo.length + cboe.length;
  return { examined: findings, raised, findings };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §14.4 — field population
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One §14.4 row: a source, a field, the column that carries it and the floor it must clear. */
interface PopulationSpec {
  readonly sourceId: string;
  readonly fieldId: string;
  /** The SQL expression that is true when the field is populated on the capture row. */
  readonly populatedWhen: string;
  readonly floor: number;
}

/**
 * §14.4's table, restricted to the pairs a capture table can actually answer. The `sec.*` and
 * `news` rows of §14.4 are computed by their own jobs, which hold the eligibility rule (an index
 * member with a complete quarter, a story with an entity link) that no generic sweep can express.
 */
const QUOTE_TICK_POPULATION: readonly PopulationSpec[] = [
  { sourceId: 'cboe.quotes', fieldId: 'PX_BID', populatedWhen: 'bid IS NOT NULL', floor: 0.95 },
  { sourceId: 'cboe.quotes', fieldId: 'PX_ASK', populatedWhen: 'ask IS NOT NULL', floor: 0.95 },
  {
    sourceId: 'cboe.quotes',
    fieldId: 'PX_VOLUME',
    populatedWhen: 'volume IS NOT NULL',
    floor: 0.99,
  },
];

const OPTION_QUOTE_POPULATION: readonly PopulationSpec[] = [
  { sourceId: 'cboe.options', fieldId: 'OPT_IV', populatedWhen: 'iv IS NOT NULL', floor: 0.9 },
  {
    sourceId: 'cboe.options',
    fieldId: 'OPT_DELTA',
    populatedWhen: 'delta IS NOT NULL',
    floor: 0.9,
  },
];

/**
 * §14.4 — populated ÷ eligible per `(source_id, field_id)` over the session that just closed.
 *
 * "Eligible" is every capture the source wrote in the session on a line that normally publishes
 * the field. `cboe.options` narrows that to contracts with a two-sided market, which is the
 * §14.4 wording and is expressed as the `eligibleWhen` predicate below; for `cboe.quotes` every
 * capture on an equity line is eligible.
 */
async function sweepFieldPopulation(ctx: DqMonitorContext, nowMs: number): Promise<MonitorOutcome> {
  // The session that closed: the monitor runs in the evening, so "today" in UTC is the session.
  const sessionDate = utcSessionDate(nowMs);
  let examined = 0;
  let raised = 0;
  let findings = 0;

  const measure = async (
    table: string,
    timeColumn: string,
    spec: PopulationSpec,
    eligibleWhen: string,
  ): Promise<void> => {
    const counts = await onTx(ctx, async (tx) =>
      tx.execute<{ eligible: string; populated: string }>(
        sql.raw(
          `SELECT count(*)::text AS eligible,
                  count(*) FILTER (WHERE ${spec.populatedWhen})::text AS populated
             FROM ${table} c
             JOIN md_lines l ON l.md_line_id = c.md_line_id AND l.tx_to = 'infinity'
            WHERE l.source_id = '${spec.sourceId}'
              AND c.${timeColumn} >= DATE '${sessionDate}'
              AND c.${timeColumn} <  DATE '${sessionDate}' + 1
              AND (${eligibleWhen})`,
        ),
      ),
    );
    const row = counts.rows[0];
    const eligible = Number(row?.eligible ?? '0');
    const populated = Number(row?.populated ?? '0');
    examined += eligible;
    if (eligible === 0) return;
    const dqId = await checkFieldPopulation(
      {
        sourceId: spec.sourceId,
        fieldId: spec.fieldId,
        populated,
        eligible,
        floor: spec.floor,
        sessionDate,
      },
      dqOptions(ctx),
    );
    if (populated / eligible < spec.floor) findings += 1;
    if (dqId !== null) raised += 1;
  };

  for (const spec of QUOTE_TICK_POPULATION) {
    await measure('quote_ticks', 'capture_ts', spec, 'TRUE');
  }
  for (const spec of OPTION_QUOTE_POPULATION) {
    // §14.4: "on contracts with a two-sided market".
    await measure('option_quotes', 'capture_ts', spec, 'c.bid IS NOT NULL AND c.ask IS NOT NULL');
  }

  // §14.4 `yahoo.chart`: non-null OHLCV bars per session, floor 97 %.
  const bars = await onTx(ctx, async (tx) =>
    tx.execute<{ eligible: string; populated: string }>(sql`
      SELECT count(*)::text AS eligible,
             count(*) FILTER (WHERE b.open IS NOT NULL AND b.high IS NOT NULL
                                AND b.low  IS NOT NULL AND b.close IS NOT NULL
                                AND b.volume IS NOT NULL)::text AS populated
        FROM bars_intraday b
        JOIN md_lines l ON l.md_line_id = b.md_line_id AND l.tx_to = 'infinity'
       WHERE l.source_id = 'yahoo.chart'
         AND b.bar_ts >= ${sessionDate}::date
         AND b.bar_ts <  ${sessionDate}::date + 1`),
  );
  const barRow = bars.rows[0];
  const barEligible = Number(barRow?.eligible ?? '0');
  const barPopulated = Number(barRow?.populated ?? '0');
  examined += barEligible;
  if (barEligible > 0) {
    const dqId = await checkFieldPopulation(
      {
        sourceId: 'yahoo.chart',
        fieldId: 'PX_LAST',
        populated: barPopulated,
        eligible: barEligible,
        floor: 0.97,
        sessionDate,
      },
      dqOptions(ctx),
    );
    if (barPopulated / barEligible < 0.97) findings += 1;
    if (dqId !== null) raised += 1;
  }

  return { examined, raised, findings };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §14.5 — default partitions and the referential sweep
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function sweepDefaultPartitions(
  ctx: DqMonitorContext,
  nowMs: number,
): Promise<MonitorOutcome> {
  const specs = defaultPartitionSpecs();
  const findings = await checkDefaultPartitions(specs, {
    ...(ctx.tx === undefined ? {} : { tx: ctx.tx }),
    now: new Date(nowMs),
  });
  return {
    examined: specs.length,
    raised: findings.filter((f) => f.dqId !== null).length,
    findings: findings.length,
  };
}

async function sweepRefOrphans(ctx: DqMonitorContext, nowMs: number): Promise<MonitorOutcome> {
  const findings = await checkRefOrphans(DEFAULT_ORPHAN_SWEEPS, {
    ...(ctx.tx === undefined ? {} : { tx: ctx.tx }),
    now: new Date(nowMs),
  });
  return {
    examined: DEFAULT_ORPHAN_SWEEPS.length,
    raised: findings.filter((f) => f.dqId !== null).length,
    findings: findings.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The monitor table
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every periodic §14 check, with the spacing it runs at.
 *
 * The spacings are the cheapest that still meet the rule. `stale_tick` is a real-time alarm and
 * runs on the tick; the two §14.5 sweeps are structural and run hourly and nightly; `missing_close`
 * and `field_population` are session alarms and run once in their ET window — 18:30-19:00 for the
 * close alarm, as §14.3 states, and after 20:00 for the population rates, once the extended
 * session's captures are all in.
 */
export const MONITORS: readonly Monitor[] = [
  {
    id: 'staleTicks',
    section: '§14.1',
    minIntervalMs: MINUTE_MS,
    sessionOnly: true,
    run: (ctx, nowMs) => sweepStaleTicks(ctx, nowMs),
  },
  {
    id: 'missingCloses',
    section: '§14.3',
    minIntervalMs: 12 * HOUR_MS,
    window: { fromMin: 18 * 60 + 30, toMin: 19 * 60 },
    run: (ctx, nowMs) => sweepMissingCloses(ctx, nowMs),
  },
  {
    id: 'fieldPopulation',
    section: '§14.4',
    minIntervalMs: 12 * HOUR_MS,
    window: { fromMin: 20 * 60, toMin: 21 * 60 },
    run: (ctx, nowMs) => sweepFieldPopulation(ctx, nowMs),
  },
  {
    id: 'defaultPartitions',
    section: '§14.5',
    minIntervalMs: HOUR_MS,
    run: (ctx, nowMs) => sweepDefaultPartitions(ctx, nowMs),
  },
  {
    id: 'refOrphans',
    section: '§14.5',
    minIntervalMs: DAY_MS,
    window: { fromMin: 2 * 60, toMin: 4 * 60, weekdays: [0, 1, 2, 3, 4, 5, 6] },
    run: (ctx, nowMs) => sweepRefOrphans(ctx, nowMs),
  },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface DqMonitorsOptions {
  readonly monitors?: readonly Monitor[];
  readonly state?: MonitorState;
  /** Run every monitor whatever its window or spacing — the ops screen's "run now" button. */
  readonly force?: boolean;
}

export interface MonitorRunReport extends MonitorOutcome {
  readonly id: string;
  readonly section: string;
  readonly skipped: boolean;
  readonly durationMs: number;
  readonly error?: JobError;
}

export interface DqMonitorsResult extends JobResult {
  readonly monitors: readonly MonitorRunReport[];
  /** `dq_events` rows opened by this tick, across every monitor. */
  readonly raised: number;
}

/**
 * Run one monitor so that its failure cannot poison the others.
 *
 * A failed statement aborts the whole Postgres transaction, so when the caller supplied one — the
 * scheduler does, and so does a test — each monitor runs inside its own `SAVEPOINT` (which is what
 * drizzle's nested `transaction()` issues). A sweep that hits a lock or a missing table then rolls
 * back to its savepoint and the remaining monitors still see a usable transaction. Without a
 * caller transaction each check opens its own on the application pool and the isolation is free.
 */
async function runIsolated(
  ctx: DqMonitorContext,
  monitor: Monitor,
  nowMs: number,
): Promise<MonitorOutcome> {
  const tx = ctx.tx;
  if (tx === undefined) return monitor.run(ctx, nowMs);
  return tx.transaction(async (inner) => monitor.run({ ...ctx, tx: inner }, nowMs));
}

/** The scheduler runs one instance of this job, so one module-level state is the right scope. */
const defaultState = new MonitorState();

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
 * One tick: run every monitor whose window and spacing allow it.
 *
 * Counters as `ingest_runs` reads them for this job: `fetched` = rows examined across every
 * monitor, `inserted` = `dq_events` rows opened, `updated` = findings seen (opened or suppressed
 * as a duplicate of an unresolved row), `skipped` = monitors the gate held back this tick.
 */
export async function runDqMonitors(
  ctx: DqMonitorContext,
  options: DqMonitorsOptions = {},
): Promise<DqMonitorsResult> {
  const nowMs = ctx.clock.now();
  const monitors = options.monitors ?? MONITORS;
  const state = options.state ?? defaultState;
  const base = emptyResult();
  const reports: MonitorRunReport[] = [];
  let raised = 0;

  for (const monitor of monitors) {
    if (options.force !== true && !shouldRun(monitor, state, nowMs)) {
      base.skipped += 1;
      reports.push({
        id: monitor.id,
        section: monitor.section,
        skipped: true,
        durationMs: 0,
        ...NOTHING,
      });
      continue;
    }

    const startedMs = Date.now();
    try {
      const outcome = await runIsolated(ctx, monitor, nowMs);
      // Marked only on success: a sweep that threw must be retried on the next tick, not held off
      // for its whole interval by a failure.
      state.markRun(monitor.id, nowMs);
      base.fetched += outcome.examined;
      base.inserted += outcome.raised;
      base.updated += outcome.findings;
      raised += outcome.raised;
      reports.push({
        id: monitor.id,
        section: monitor.section,
        skipped: false,
        durationMs: Date.now() - startedMs,
        ...outcome,
      });
      if (outcome.findings > 0) {
        ctx.log?.warn?.('dq.monitor', {
          job: DQ_MONITORS_JOB_ID,
          monitor: monitor.id,
          section: monitor.section,
          examined: outcome.examined,
          findings: outcome.findings,
          raised: outcome.raised,
          ...(ctx.traceId === undefined ? {} : { traceId: ctx.traceId }),
        });
      }
    } catch (err) {
      const code = err instanceof Error ? err.name : 'UNKNOWN';
      const message = err instanceof Error ? err.message : String(err);
      const error: JobError = { code, message: `${monitor.id}: ${message}` };
      base.errors.push(error);
      reports.push({
        id: monitor.id,
        section: monitor.section,
        skipped: false,
        durationMs: Date.now() - startedMs,
        ...NOTHING,
        error,
      });
      ctx.log?.error?.('dq.monitor_failed', {
        job: DQ_MONITORS_JOB_ID,
        monitor: monitor.id,
        code,
        message,
      });
    }
  }

  return { ...base, monitors: reports, raised };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job table row (PROVIDERS §13)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const job = {
  id: DQ_MONITORS_JOB_ID,
  schedule: DQ_MONITORS_SCHEDULE,
  priority: 2 as const,
  timeoutMs: DQ_MONITORS_TIMEOUT_MS,
  run: (ctx: DqMonitorContext): Promise<DqMonitorsResult> => runDqMonitors(ctx),
};
