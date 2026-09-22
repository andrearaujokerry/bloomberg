/**
 * `reconcile` — the cross-source checks of PROVIDERS §14.2, after the US close (QA-03).
 *
 * PROVIDERS §13 row: `id 'reconcile'`, no `provider`, schedule `'45 18 * * 1-5'`, target set
 * "Cboe vs Yahoo closes on the hot set; Treasury vs H.15 vs `^TNX`; N-PORT vs SSGA; BLS vs FRED",
 * `priority 2`, `timeoutMs 300000`. §14 opens: "`ingest/jobs/dqMonitors.ts` runs the periodic
 * checks; `ingest/jobs/reconcile.ts` runs the cross-source ones after the US close".
 *
 * QA-03's requirement is a sentence: *reconcile continuously against at least one independent
 * source*. The value of a terminal is that a number on the screen is right, and the only way to
 * know a number is right is to have obtained it twice, independently. When the two disagree by
 * more than the tolerance the pair is allowed, a `dq_events` row of kind
 * `'cross_source_divergence'` is opened — the published number is **not** changed. A reconcile
 * job that silently picked a winner would destroy the evidence that something is wrong, which is
 * the only thing it is here to produce.
 *
 * ## The checks
 *
 * §14.2's table assigns each pair to the job that owns both sides of it. The pairs whose two sides
 * arrive in the same ingest run are checked by that run's own job, with the payload in hand:
 * frankfurter vs Yahoo by `fxEod.ts`, BLS vs FRED by `blsSeries.ts`, World Bank vs FRED by
 * `worldMacro.ts`, FINRA vs `dei` by `shortInterest.ts`, N-PORT vs SPDR by `ssgaHoldings.ts`.
 * What is left for this job is the pairs whose two sides arrive from *different* jobs and can only
 * be compared once both have landed — and the first of those, the one §14.2 puts at the top of its
 * table, is implemented here:
 *
 * | Pair | Tolerance | Severity |
 * | --- | --- | --- |
 * | **Cboe close vs Yahoo close**, per hot instrument, same `session_date` | > 0.5 % | `warn` |
 *
 * {@link CHECKS} is the registry the run iterates, so the §14.2 rows whose reference data this
 * work package does not yet write (the Treasury / H.15 / `^TNX` 5 bp triple needs
 * `curve_points`' tenor and `quote_type` conventions from the treasury and Fed adapters; the Cboe
 * `iv30` vs `vol_surfaces.atm_iv` 5-vol-point pair needs WP-07's surface) are added by pushing a
 * `ReconcileCheck` onto it, with no change to the run, the counters or the audit row.
 *
 * ## Where the two closes come from
 *
 * `bars_daily` is keyed `(instrument_id, session_date)`, so an instrument has exactly **one** bar
 * row per session and the two sources cannot each own a row. They own different columns of it:
 *
 *  * **Yahoo** supplies the bar. `md_line_id` names the line it came from, and `close` is Yahoo's
 *    close (PROVIDERS §5.5).
 *  * **Cboe** supplies `official_close`, and only after the session has closed: intra-session Cboe
 *    sets `close = current_price`, so writing it would publish a fake official close
 *    (PROVIDERS §5.1 L672, gated on `session ∈ {closed, post}`).
 *
 * When `official_close` has not been written — the Cboe post-close job has not run, or the line
 * published no close — the Cboe side falls back to the **last `quote_ticks.price` of the session**
 * on a `cboe.quotes` line, which is the same number the screen was showing at the bell. And when
 * the bar itself came from a Cboe line, `close` is Cboe's, there is no Yahoo close to compare it
 * with, and the instrument is skipped rather than reconciled against itself. Which source each
 * side of a comparison came from is recorded in the `dq_events.details`, because "these two
 * numbers disagree" is only actionable next to "and here is where each came from".
 *
 * ## Purity
 *
 * {@link closeDivergence} is a pure function of two numbers and a tolerance — no clock, no IO — so
 * the threshold can be asserted directly, and the database half of the job is only responsible for
 * finding the pairs to hand it.
 */

import { sql } from 'drizzle-orm';

import { withTx } from '../../db/client.js';
import { checkCrossSourceDivergence, divergencePct } from '../../observability/dq.js';
import { zonedParts } from '../scheduler.js';

import type { Tx } from '../../db/client.js';
import type { DqOptions, DqSeverity } from '../../observability/dq.js';
import type { IngestLogger, JobError, JobResult } from '../scheduler.js';
import type { Clock } from '@terminal/core';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The §13 row
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const RECONCILE_JOB_ID = 'reconcile';

/** 18:45 America/New_York, Monday to Friday — after the US close (PROVIDERS §13, §14.2). */
export const RECONCILE_SCHEDULE = '45 18 * * 1-5';

export const RECONCILE_TIMEOUT_MS = 300_000;

/** `licence_registry.source_id` of the two sides of the close pair. */
export const CBOE_QUOTES_SOURCE_ID = 'cboe.quotes';
export const YAHOO_CHART_SOURCE_ID = 'yahoo.chart';

/**
 * PROVIDERS §14.2: "**Cboe close vs Yahoo close**, per hot instrument, same `session_date` —
 * **> 0.5 %**". The comparison is `> tolerance`, so a pair exactly on 0.5 % does **not** raise.
 */
export const CLOSE_DIVERGENCE_TOLERANCE_PCT = 0.5;

/** §14.2 divergences are `warn`: the number stays published and an operator looks at it. */
export const CLOSE_DIVERGENCE_SEVERITY: DqSeverity = 'warn';

/** No more than this many pairs per run — a whole-market outage is not 10,000 incidents. */
export const RECONCILE_LIMIT = 2_000;

/** {@link ReconcileCheck.id} of the §14.2 close pair — also its `dq_events.details.check`. */
export const CLOSE_CHECK_ID = 'cboeVsYahooClose';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The pure half
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface CloseDivergence {
  /** Signed percentage difference of the Yahoo close from the Cboe close. */
  readonly diffPct: number;
  /** True when the pair must raise `cross_source_divergence`. */
  readonly exceeds: boolean;
  /** True when no comparison is possible — a zero or non-finite reference. */
  readonly incomparable: boolean;
}

/**
 * Compare two independently obtained closes for the same instrument and session.
 *
 * `expected` is the value §14.2 puts on the left of the pair and the one we trust more: the Cboe
 * close, which is an exchange-sourced official close, against Yahoo's, which comes from an
 * undocumented endpoint with no contract (PROVIDERS §5.5). The *sign* of `diffPct` therefore says
 * which way Yahoo is off, which is the first thing an operator wants to know.
 *
 * A zero or non-finite reference is `incomparable`, not `0 %`: a divergence measured against zero
 * is not a comparison, and reporting one would be worse than reporting nothing.
 */
export function closeDivergence(
  cboeClose: number,
  yahooClose: number,
  tolerancePct: number = CLOSE_DIVERGENCE_TOLERANCE_PCT,
): CloseDivergence {
  if (!Number.isFinite(cboeClose) || !Number.isFinite(yahooClose) || cboeClose === 0) {
    return { diffPct: Number.NaN, exceeds: false, incomparable: true };
  }
  const diffPct = divergencePct(cboeClose, yahooClose);
  return { diffPct, exceeds: Math.abs(diffPct) > tolerancePct, incomparable: false };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Context and the check registry
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ReconcileContext {
  clock: Clock;
  /** Join this transaction; omitted, every statement opens its own on the application pool. */
  tx?: Tx;
  log?: IngestLogger;
  traceId?: string;
  runId?: number;
}

export interface ReconcileOptions {
  /**
   * The session to reconcile, `YYYY-MM-DD`. Default: the America/New_York calendar date of
   * `clock.now()`, which at the job's 18:45 ET slot is the session that just closed.
   */
  readonly sessionDate?: string;
  /**
   * Restrict to these instruments — the hot set (subscribers ∪ connected watchlists ∪ always-on),
   * which is what §14.2 means by "per hot instrument". Default: every instrument with a bar for
   * the session, which is what a backfill or an operator re-run wants.
   */
  readonly instrumentIds?: readonly number[];
  /** Override the §14.2 tolerance — an operator widening it for one noisy evening. */
  readonly tolerancePct?: number;
  /** Compare and report without writing `dq_events`. */
  readonly dryRun?: boolean;
  /** Restrict the run to these check ids. */
  readonly checks?: readonly string[];
  readonly limit?: number;
}

/** One §14.2 row, as the run iterates it. */
export interface ReconcileCheck {
  /** Stable id — the `details.check` of everything it raises and the `checks` filter's key. */
  readonly id: string;
  /** The §14.2 line it implements. */
  readonly description: string;
  run(ctx: ReconcileContext, options: ReconcileOptions): Promise<CheckOutcome>;
}

export interface CheckOutcome {
  /** Candidate rows the check looked at. */
  readonly examined: number;
  /** Pairs where both sides were present and comparable. */
  readonly compared: number;
  /** Pairs that exceeded the tolerance. */
  readonly diverged: number;
  /** `dq_events` rows actually opened (a duplicate of an unresolved row does not count). */
  readonly raised: number;
  /** Every divergence, for the caller's report and the test's assertions. */
  readonly findings: readonly DivergenceFinding[];
}

export interface DivergenceFinding {
  readonly check: string;
  readonly instrumentId: number;
  readonly sessionDate: string;
  readonly subject: string;
  readonly expected: number;
  readonly actual: number;
  readonly diffPct: number;
  readonly tolerancePct: number;
  /** Where the left-hand value came from. */
  readonly expectedFrom: string;
  /** Where the right-hand value came from. */
  readonly actualFrom: string;
  /** `dq_events.dq_id`, or `null` on a dry run or a suppressed duplicate. */
  readonly dqId: number | null;
}

const EMPTY_OUTCOME: CheckOutcome = {
  examined: 0,
  compared: 0,
  diverged: 0,
  raised: 0,
  findings: [],
};

function onTx<T>(ctx: ReconcileContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return ctx.tx === undefined ? withTx(null, fn) : fn(ctx.tx);
}

function dqOptions(ctx: ReconcileContext): DqOptions | undefined {
  return ctx.tx === undefined ? undefined : { tx: ctx.tx };
}

/** The America/New_York calendar date of an instant — `bars_daily.session_date` for a US session. */
export function sessionDateOf(nowMs: number): string {
  const p = zonedParts(nowMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(p.year)}-${pad(p.month)}-${pad(p.day)}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cboe close vs Yahoo close (§14.2 row 1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One instrument's two closes for a session, before either is known to exist. */
export interface ClosePair {
  readonly instrumentId: number;
  readonly sessionDate: string;
  readonly cboeClose: number | null;
  /** `bars_daily.official_close`, `bars_daily.close` or `quote_ticks.price`. */
  readonly cboeFrom: string | null;
  readonly yahooClose: number | null;
  readonly yahooFrom: string | null;
}

interface ClosePairRow {
  [column: string]: unknown;
  instrument_id: string;
  bar_source: string | null;
  bar_close: string | null;
  official_close: string | null;
  tick_close: string | null;
  tick_ts: string | null;
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every instrument with a bar for `sessionDate`, with each source's close resolved to the column
 * that actually carries it.
 *
 * The Cboe side prefers `official_close` — the exchange's own post-session print — and falls back
 * to the last `quote_ticks.price` captured on a `cboe.quotes` line during the session. The Yahoo
 * side is `close`, and only when the bar's `md_line_id` belongs to a *current* `yahoo.chart` line:
 * a bar written by any other source is not a Yahoo close and must not be reported as one.
 */
export async function loadClosePairs(
  ctx: ReconcileContext,
  sessionDate: string,
  options: { instrumentIds?: readonly number[]; limit?: number } = {},
): Promise<ClosePair[]> {
  const nowIso = new Date(ctx.clock.now()).toISOString();
  const limit = options.limit ?? RECONCILE_LIMIT;
  const ids = options.instrumentIds;
  // A conditional fragment rather than a `NOT $n OR …` predicate: an untyped boolean parameter
  // inside a `NOT` is one of the few places Postgres cannot infer a type on its own.
  //
  // The id list is bound as one comma-separated string and split by Postgres rather than as a JS
  // array: drizzle passes an array parameter through to `pg` unwrapped, which arrives as the bare
  // element text and fails `array_in` with `malformed array literal`.
  const idFilter =
    ids === undefined || ids.length === 0
      ? sql``
      : sql`AND b.instrument_id = ANY(string_to_array(${ids.map((id) => String(id)).join(',')}, ',')::bigint[])`;

  const rows = await onTx(ctx, async (tx) => {
    const result = await tx.execute<ClosePairRow>(sql`
      WITH cur AS (
        SELECT md_line_id, instrument_id, source_id
          FROM md_lines
         WHERE tx_to = 'infinity'
           AND valid_from <= ${nowIso}::timestamptz
           AND valid_to  >  ${nowIso}::timestamptz
           AND source_id IN (${CBOE_QUOTES_SOURCE_ID}, ${YAHOO_CHART_SOURCE_ID})
      ),
      bar AS (
        SELECT b.instrument_id,
               b.close::text          AS bar_close,
               b.official_close::text AS official_close,
               c.source_id            AS bar_source
          FROM bars_daily b
          LEFT JOIN cur c ON c.md_line_id = b.md_line_id
         WHERE b.session_date = ${sessionDate}::date
           ${idFilter}
      ),
      tick AS (
        SELECT DISTINCT ON (q.instrument_id)
               q.instrument_id, q.price::text AS tick_close, q.capture_ts::text AS tick_ts
          FROM quote_ticks q
          JOIN cur c ON c.md_line_id = q.md_line_id AND c.source_id = ${CBOE_QUOTES_SOURCE_ID}
         WHERE q.capture_ts >= ${sessionDate}::date
           AND q.capture_ts <  ${sessionDate}::date + 1
           AND q.price IS NOT NULL
         ORDER BY q.instrument_id, q.capture_ts DESC
      )
      SELECT b.instrument_id, b.bar_source, b.bar_close, b.official_close,
             t.tick_close, t.tick_ts
        FROM bar b
        LEFT JOIN tick t ON t.instrument_id = b.instrument_id
       ORDER BY b.instrument_id
       LIMIT ${limit}`);
    return result.rows;
  });

  return rows.map((row) => {
    const barClose = numberOrNull(row.bar_close);
    const official = numberOrNull(row.official_close);
    const tick = numberOrNull(row.tick_close);

    let cboeClose: number | null = null;
    let cboeFrom: string | null = null;
    if (official !== null) {
      cboeClose = official;
      cboeFrom = 'bars_daily.official_close';
    } else if (row.bar_source === CBOE_QUOTES_SOURCE_ID && barClose !== null) {
      cboeClose = barClose;
      cboeFrom = 'bars_daily.close';
    } else if (tick !== null) {
      cboeClose = tick;
      cboeFrom = `quote_ticks.price@${row.tick_ts ?? '?'}`;
    }

    const yahooClose = row.bar_source === YAHOO_CHART_SOURCE_ID ? barClose : null;

    return {
      instrumentId: Number(row.instrument_id),
      sessionDate,
      cboeClose,
      cboeFrom,
      yahooClose,
      yahooFrom: yahooClose === null ? null : 'bars_daily.close',
    };
  });
}

/**
 * §14.2 row 1 — Cboe close vs Yahoo close, same `session_date`, tolerance 0.5 %.
 *
 * The `dq_events` key is `(source pair, session, instrument)`, so a re-run of the evening — or an
 * operator pressing "reconcile now" — updates nothing and opens nothing: `raiseDq` finds the
 * unresolved row from the first run and suppresses the duplicate. That is what makes this job
 * safe to re-run, which PROVIDERS §13 requires of every job in the table.
 */
export async function reconcileCloses(
  ctx: ReconcileContext,
  options: ReconcileOptions = {},
): Promise<CheckOutcome> {
  const sessionDate = options.sessionDate ?? sessionDateOf(ctx.clock.now());
  const tolerancePct = options.tolerancePct ?? CLOSE_DIVERGENCE_TOLERANCE_PCT;
  const pairs = await loadClosePairs(ctx, sessionDate, {
    ...(options.instrumentIds === undefined ? {} : { instrumentIds: options.instrumentIds }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });

  const findings: DivergenceFinding[] = [];
  let compared = 0;
  let raised = 0;

  for (const pair of pairs) {
    if (pair.cboeClose === null || pair.yahooClose === null) continue;
    const verdict = closeDivergence(pair.cboeClose, pair.yahooClose, tolerancePct);
    if (verdict.incomparable) continue;
    compared += 1;
    if (!verdict.exceeds) continue;

    const subject = `q:${String(pair.instrumentId)}`;
    const key = `${CBOE_QUOTES_SOURCE_ID}|${YAHOO_CHART_SOURCE_ID}:${sessionDate}:${String(pair.instrumentId)}`;
    let dqId: number | null = null;
    if (options.dryRun !== true) {
      dqId = await checkCrossSourceDivergence(
        {
          sourceId: CBOE_QUOTES_SOURCE_ID,
          subject,
          expected: pair.cboeClose,
          actual: pair.yahooClose,
          tolerancePct,
          severity: CLOSE_DIVERGENCE_SEVERITY,
          instrumentId: pair.instrumentId,
          key,
          details: {
            check: CLOSE_CHECK_ID,
            sessionDate,
            expectedSourceId: CBOE_QUOTES_SOURCE_ID,
            actualSourceId: YAHOO_CHART_SOURCE_ID,
            expectedFrom: pair.cboeFrom,
            actualFrom: pair.yahooFrom,
          },
        },
        dqOptions(ctx),
      );
      if (dqId !== null) raised += 1;
    }

    findings.push({
      check: CLOSE_CHECK_ID,
      instrumentId: pair.instrumentId,
      sessionDate,
      subject,
      expected: pair.cboeClose,
      actual: pair.yahooClose,
      diffPct: verdict.diffPct,
      tolerancePct,
      expectedFrom: pair.cboeFrom ?? 'unknown',
      actualFrom: pair.yahooFrom ?? 'unknown',
      dqId,
    });
  }

  return { examined: pairs.length, compared, diverged: findings.length, raised, findings };
}

/** The §14.2 rows this job owns. */
export const CHECKS: readonly ReconcileCheck[] = [
  {
    id: CLOSE_CHECK_ID,
    description: 'PROVIDERS §14.2 — Cboe close vs Yahoo close, same session_date, > 0.5 %',
    run: (ctx, options) => reconcileCloses(ctx, options),
  },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface CheckReport extends CheckOutcome {
  readonly id: string;
  readonly description: string;
  readonly error?: JobError;
}

export interface ReconcileResult extends JobResult {
  readonly sessionDate: string;
  readonly checks: readonly CheckReport[];
  /** Every divergence across every check. */
  readonly findings: readonly DivergenceFinding[];
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
 * Run one check so that its failure cannot poison the others.
 *
 * A failed statement aborts the whole Postgres transaction, so when the caller supplied one — the
 * scheduler does, and so does a test — each check runs inside its own `SAVEPOINT` (which is what
 * drizzle's nested `transaction()` issues) and a broken pair rolls back only itself.
 */
async function runIsolated(
  ctx: ReconcileContext,
  check: ReconcileCheck,
  options: ReconcileOptions,
): Promise<CheckOutcome> {
  const tx = ctx.tx;
  if (tx === undefined) return check.run(ctx, options);
  return tx.transaction(async (inner) => check.run({ ...ctx, tx: inner }, options));
}

/**
 * Run every §14.2 check this job owns.
 *
 * Counters as `ingest_runs` reads them for this job: `fetched` = candidate rows examined,
 * `inserted` = `dq_events` rows opened, `updated` = divergences found (opened or suppressed as a
 * duplicate), `skipped` = candidates that could not be compared because one side was missing.
 *
 * One check's failure is a `JobError`, not the end of the run: a broken query on one pair must not
 * stop the pair after it from being checked.
 */
export async function runReconcile(
  ctx: ReconcileContext,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const sessionDate = options.sessionDate ?? sessionDateOf(ctx.clock.now());
  const wanted = options.checks;
  const checks =
    wanted === undefined ? CHECKS : CHECKS.filter((check) => wanted.includes(check.id));
  const base = emptyResult();
  const reports: CheckReport[] = [];
  const findings: DivergenceFinding[] = [];

  for (const check of checks) {
    try {
      const outcome = await runIsolated(ctx, check, { ...options, sessionDate });
      base.fetched += outcome.examined;
      base.inserted += outcome.raised;
      base.updated += outcome.diverged;
      base.skipped += outcome.examined - outcome.compared;
      findings.push(...outcome.findings);
      reports.push({ id: check.id, description: check.description, ...outcome });
      ctx.log?.info?.('reconcile.check', {
        job: RECONCILE_JOB_ID,
        check: check.id,
        sessionDate,
        examined: outcome.examined,
        compared: outcome.compared,
        diverged: outcome.diverged,
        raised: outcome.raised,
        ...(ctx.traceId === undefined ? {} : { traceId: ctx.traceId }),
      });
      for (const finding of outcome.findings) {
        ctx.log?.warn?.('reconcile.divergence', {
          job: RECONCILE_JOB_ID,
          check: finding.check,
          subject: finding.subject,
          sessionDate: finding.sessionDate,
          expected: finding.expected,
          actual: finding.actual,
          diffPct: finding.diffPct,
          tolerancePct: finding.tolerancePct,
        });
      }
    } catch (err) {
      const code = err instanceof Error ? err.name : 'UNKNOWN';
      const message = err instanceof Error ? err.message : String(err);
      const error: JobError = { code, message: `${check.id}: ${message}` };
      base.errors.push(error);
      reports.push({ id: check.id, description: check.description, ...EMPTY_OUTCOME, error });
      ctx.log?.error?.('reconcile.check_failed', {
        job: RECONCILE_JOB_ID,
        check: check.id,
        code,
        message,
      });
    }
  }

  return { ...base, sessionDate, checks: reports, findings };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job table row (PROVIDERS §13)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const job = {
  id: RECONCILE_JOB_ID,
  schedule: RECONCILE_SCHEDULE,
  priority: 2 as const,
  timeoutMs: RECONCILE_TIMEOUT_MS,
  run: (ctx: ReconcileContext): Promise<ReconcileResult> => runReconcile(ctx),
};
