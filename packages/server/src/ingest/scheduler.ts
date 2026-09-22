/**
 * The ingest scheduler — ARCHITECTURE §7.1 L974-1010, PROVIDERS §13, WORKPLAN §WP-05 L808-812.
 *
 * The contract, verbatim from ARCHITECTURE L1005-1010, and where each clause lives here:
 *
 *  * *one running instance per job* — {@link Scheduler} holds one {@link JobState} per job and a
 *    job that is still running is not started again, however long it takes.
 *  * *the scheduler tick is every second with an injected `Clock`* — {@link Scheduler.tick} is one
 *    tick and reads nothing but `deps.clock`; {@link Scheduler.start} is the only thing in this
 *    file that touches a platform timer, and tests never call it: they advance a `VirtualClock`
 *    and call `tick()` themselves.
 *  * *leader election via `pg_try_advisory_lock(hashtext('ingest-leader'))`* — `ingest/lock.ts`.
 *    A follower's tick does nothing at all; it does not evaluate a schedule, does not write an
 *    `ingest_runs` row and does not spend a token.
 *  * *each run writes `ingest_runs (job_id, started_at, finished_at, status, fetched, inserted,
 *    errors, trace_id)`* — {@link dbRunRecorder}. **Exactly one row per execution**: it is
 *    `INSERT … status 'running'` when the run starts and `UPDATE` of that same row when it ends,
 *    never a second insert, so `count(*) where job_id = …` is the number of executions.
 *  * *failures back off `2^n × 5 s` capped at 10 min* (ARCHITECTURE L1008) — {@link
 *    backoffDelayMs}. `n` is read as the number of failures already suffered, so the literal
 *    series this scheduler produces, and the one the acceptance test measures against, is
 *    **5, 10, 20, 40, 80, 160, 320, 600, 600 … seconds**: the first failure waits 5 s and the
 *    eighth is the first to take the cap.
 *
 * And PROVIDERS §13's naming rule, which the other half of the system depends on: **`IngestJob.id`
 * is the module basename** (`cboeQuotes`, `yahooDaily`, `partitionMaintenance`) and that is what
 * lands in `ingest_runs.job_id`. `jobs/index.ts` is generated from the directory listing, so the
 * rule is checkable mechanically — {@link collectJobs} is the check, and it refuses to build a
 * schedule out of a module whose exported `job.id` is not its own file name.
 *
 * ## Transactions
 *
 * Three per execution, deliberately not one: the `ingest_runs` insert commits on its own, the job
 * body runs in its own `withTx(null, …)`, and the closing `UPDATE` commits on its own. A job that
 * throws therefore leaves a committed `failed` row behind it — which is the entire point of the
 * table — instead of rolling its own obituary back.
 *
 * ## Deviations from the declaration in ARCHITECTURE L994-1002 (all carried under §18)
 *
 *  1. `provider` is **optional**. PROVIDERS §13 lists seven jobs with no provider at all
 *     (`partitionMaintenance`, `retentionPurge`, `dqMonitors`, `reconcile`, `usageDeclarations`…)
 *     and `ingest_runs.source_id` is nullable precisely for them ("NULL for internal jobs").
 *     A job may also name several providers, as `symbologyRefresh` does; the first is the one
 *     written to `ingest_runs.source_id`, since the column holds one.
 *  2. `JobContext` carries `tx` as well as `db`. Every job written so far (`secNport`,
 *     `symbologyRefresh`, `ssgaHoldings`, `shortInterest`, `universeSymbolBook`) takes the
 *     transaction it writes in, and the scheduler is the thing that opens it. `providers`,
 *     `plant` and `hotset` are optional because the reference jobs use none of them and must stay
 *     callable from `db:seed` and from a replay test.
 *  3. `timezone` is a per-job field. §13 gives `fxEod` `'15 16 * * 1-5'` **(Europe/Berlin)** while
 *     every other cron row is America/New_York; a scheduler with one global zone would fire it an
 *     hour early for half the year.
 *  4. `JobError`, `JobResult` and `IngestLogger` are declared here — this is their permanent home
 *     (`jobs/secNport.ts` says so in its own header). The copies in the WP-04 job modules are
 *     structurally identical, so the two describe the same values; the integrator should re-point
 *     those imports at this module when the jobs are next touched.
 */

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { getDb, withTx } from '../db/client.js';
import { ingestRuns } from '../db/schema/index.js';

import { pgLeaderElection } from './lock.js';

import type { Clock } from '@terminal/core';
import type { Db, Tx } from '../db/client.js';
import type { HotSet } from './hotset.js';
import type { LeaderElection, LeaderLock } from './lock.js';
import type { Plant } from '../plant/tickerPlant.js';
import type { ProviderId } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job contract (ARCHITECTURE §7.1 L994-1002)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `ingest_runs.errors` — one entry per thing that went wrong inside an otherwise finished run. */
export interface JobError {
  code: string;
  message: string;
  url?: string;
  requestKey?: string;
}

/** What every `run` returns. The four counters are what `ingest_runs` stores. */
export interface JobResult {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: JobError[];
  provenanceIds: number[];
}

/** Structured job logging; every method is optional so a caller may pass `{}`. */
export interface IngestLogger {
  info?(event: string, detail: Record<string, unknown>): void;
  warn?(event: string, detail: Record<string, unknown>): void;
  error?(event: string, detail: Record<string, unknown>): void;
}

/** An interval schedule — PROVIDERS §13's `{everyMs, jitterMs?, marketHoursOnly?, offHoursEveryMs?}`. */
export interface IntervalSchedule {
  /** The in-session period. */
  everyMs: number;
  /** ± this much, drawn per interval, so a fleet of pollers does not align on the second. */
  jitterMs?: number;
  /** When true the job does not run at all outside the extended session unless `offHoursEveryMs` is set. */
  marketHoursOnly?: boolean;
  /** The out-of-session period. Absent with `marketHoursOnly` means "do not run out of session". */
  offHoursEveryMs?: number;
}

/** A 5-field cron expression in the job's timezone, or an interval. */
export type IngestSchedule = string | IntervalSchedule;

/**
 * What a job needs to do its work. `db` is the pool handle (ARCHITECTURE L1002); `tx` is the
 * transaction the scheduler opened for this execution and the one every write must go through.
 */
export interface JobContext {
  clock: Clock;
  db: Db;
  tx: Tx;
  /** OPS-07 — copied onto every `provenance` row the run writes. */
  traceId: string;
  /** `ingest_runs.run_id` of this execution. */
  runId: number;
  providers?: ProviderRegistry;
  plant?: Plant;
  hotset?: HotSet;
  log?: IngestLogger;
}

/** ARCHITECTURE L994-1001. */
export interface IngestJob {
  /** The module basename (PROVIDERS §13) and `ingest_runs.job_id`. */
  id: string;
  schedule: IngestSchedule;
  /** For the circuit breaker and the rate budget. Absent for an internal job. */
  provider?: ProviderId | readonly ProviderId[];
  /** 1 = hot-set real-time, 2 = daily, 3 = weekly/reference. */
  priority: 1 | 2 | 3;
  timeoutMs: number;
  /** IANA zone for a cron `schedule`. Default {@link DEFAULT_TIMEZONE}. */
  timezone?: string;
  /**
   * False when the job opens its own transactions — `partitionMaintenance` and `retentionPurge`
   * run on `withMaintTx` and must not be wrapped in an application-pool transaction they cannot
   * use. The context they receive then carries the pool handle in `tx` as well as in `db`.
   */
  transactional?: boolean;
  run(ctx: JobContext): Promise<JobResult>;
}

/** `ingest_runs.status`. */
export type RunStatus = 'running' | 'ok' | 'failed' | 'skipped';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Backoff
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `2^n × 5 s` — the first failure waits 5 s. */
export const BACKOFF_BASE_MS = 5_000;
/** "capped at 10 min" (ARCHITECTURE L1008). */
export const BACKOFF_CAP_MS = 600_000;

/**
 * The delay after `consecutiveFailures` failures: `2^(n-1) × 5 s`, capped at ten minutes.
 *
 * `5 s, 10 s, 20 s, 40 s, 80 s, 160 s, 320 s, 600 s, 600 s …` — the eighth failure would ask for
 * 640 s and gets the cap. `consecutiveFailures` of 0 means "no failure", which is no delay.
 */
export function backoffDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  // 2^30 × 5 s already overflows past the cap; clamping the exponent keeps `2 ** n` finite for a
  // job that has been failing since the last deploy.
  const exponent = Math.min(consecutiveFailures - 1, 30);
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_CAP_MS);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Wall-clock arithmetic (cron and market hours)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Every cron row of PROVIDERS §13 but `fxEod` is in this zone. */
export const DEFAULT_TIMEZONE = 'America/New_York';

/** A local wall-clock instant in some IANA zone. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday, as cron counts. */
  weekday: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  formatters.set(timeZone, fmt);
  return fmt;
}

/**
 * Epoch ms → the wall clock in `timeZone`. `Intl` owns the tz database, so DST — including the
 * 01:00-02:00 America/New_York fold in November — is the platform's problem and not ours.
 */
export function zonedParts(epochMs: number, timeZone: string = DEFAULT_TIMEZONE): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/** The extended US session the hot-set jobs poll in: 04:00-20:00 ET, Monday to Friday. */
export const EXTENDED_SESSION_START_MIN = 4 * 60;
export const EXTENDED_SESSION_END_MIN = 20 * 60;

/**
 * The default `marketHoursOnly` / `offHoursEveryMs` predicate: PROVIDERS §5.1's polling window,
 * 04:00-20:00 ET on a weekday.
 *
 * Exchange holidays are **not** consulted: `calendar_sessions` (WP-02) is the authority on whether
 * a session exists, and wiring that wants holiday accuracy injects `SchedulerDeps.marketHours`.
 * Polling a closed market costs one request that returns yesterday's close; missing an open one
 * costs a blank screen, so the default errs towards polling.
 */
export function inExtendedSession(epochMs: number, timeZone: string = DEFAULT_TIMEZONE): boolean {
  const p = zonedParts(epochMs, timeZone);
  if (p.weekday === 0 || p.weekday === 6) return false;
  const minuteOfDay = p.hour * 60 + p.minute;
  return minuteOfDay >= EXTENDED_SESSION_START_MIN && minuteOfDay < EXTENDED_SESSION_END_MIN;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cron
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Raised for an unparseable cron expression — a startup failure, never a runtime one. */
export class CronParseError extends Error {
  constructor(expr: string, detail: string) {
    super(`invalid cron expression ${JSON.stringify(expr)}: ${detail}`);
    this.name = 'CronParseError';
  }
}

/** A parsed 5-field cron expression. A `null` field is `*`. */
export interface CronSpec {
  readonly expr: string;
  readonly minute: ReadonlySet<number> | null;
  readonly hour: ReadonlySet<number> | null;
  readonly dayOfMonth: ReadonlySet<number> | null;
  readonly month: ReadonlySet<number> | null;
  readonly dayOfWeek: ReadonlySet<number> | null;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  expr: string,
  name: string,
): Set<number> | null {
  if (raw === '*') return null;
  const values = new Set<number>();
  for (const term of raw.split(',')) {
    if (term === '') throw new CronParseError(expr, `empty ${name} term`);
    const [rangePart = '', stepPart, ...rest] = term.split('/');
    if (rest.length > 0) throw new CronParseError(expr, `${name} has more than one step`);
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) {
        throw new CronParseError(
          expr,
          `${name} step ${JSON.stringify(stepPart)} is not a positive integer`,
        );
      }
    }
    let from: number;
    let to: number;
    if (rangePart === '*') {
      from = min;
      to = max;
    } else if (rangePart.includes('-')) {
      const [a = '', b = ''] = rangePart.split('-');
      from = Number(a);
      to = Number(b);
    } else {
      from = Number(rangePart);
      to = stepPart === undefined ? from : max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new CronParseError(expr, `${name} term ${JSON.stringify(term)} is not numeric`);
    }
    if (from < min || to > max || from > to) {
      throw new CronParseError(
        expr,
        `${name} term ${JSON.stringify(term)} is outside ${min}-${max}`,
      );
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  if (values.size === 0) throw new CronParseError(expr, `${name} matches nothing`);
  return values;
}

/**
 * Parse `'30 17 * * 1-5'`. Five fields: minute, hour, day-of-month, month, day-of-week. `*`,
 * lists, ranges and steps are supported; names (`MON`, `JAN`) and the non-standard `?`, `L`, `#`
 * are not — no row of PROVIDERS §13 uses them, and silently accepting a form we do not implement
 * is how a daily job quietly stops running.
 */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(expr, `expected 5 fields, got ${String(fields.length)}`);
  }
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = fields;
  const dayOfWeek = parseField(dow, 0, 7, expr, 'day-of-week');
  // Cron's Sunday is both 0 and 7.
  if (dayOfWeek?.delete(7) === true) dayOfWeek.add(0);
  return {
    expr,
    minute: parseField(minute, 0, 59, expr, 'minute'),
    hour: parseField(hour, 0, 23, expr, 'hour'),
    dayOfMonth: parseField(dom, 1, 31, expr, 'day-of-month'),
    month: parseField(month, 1, 12, expr, 'month'),
    dayOfWeek,
  };
}

/**
 * Does `parts` fall in a minute this expression names?
 *
 * Day-of-month and day-of-week follow the standard cron rule: when **both** are restricted the
 * match is their union (`'0 4 1 * 0'` is "the 1st, and every Sunday"), when one is `*` the other
 * decides.
 */
export function cronMatches(spec: CronSpec, parts: ZonedParts): boolean {
  if (spec.minute !== null && !spec.minute.has(parts.minute)) return false;
  if (spec.hour !== null && !spec.hour.has(parts.hour)) return false;
  if (spec.month !== null && !spec.month.has(parts.month)) return false;

  const domRestricted = spec.dayOfMonth !== null;
  const dowRestricted = spec.dayOfWeek !== null;
  if (!domRestricted && !dowRestricted) return true;
  const domHit = domRestricted && spec.dayOfMonth?.has(parts.day) === true;
  const dowHit = dowRestricted && spec.dayOfWeek?.has(parts.weekday) === true;
  if (domRestricted && dowRestricted) return domHit || dowHit;
  return domRestricted ? domHit : dowHit;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `ingest_runs`
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RunStart {
  jobId: string;
  /** `licence_registry.source_id`, or `null` for an internal job. */
  sourceId: string | null;
  startedAt: Date;
  traceId: string;
}

export interface RunFinish {
  runId: number;
  status: Exclude<RunStatus, 'running'>;
  finishedAt: Date;
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: JobError[];
}

/** Where an execution is recorded. One row per execution: `start` inserts it, `finish` updates it. */
export interface RunRecorder {
  start(run: RunStart): Promise<number>;
  finish(run: RunFinish): Promise<void>;
}

/**
 * The real recorder. Both statements run in their own `withTx(null, …)` so the row survives
 * whatever happens to the job's transaction.
 */
export function dbRunRecorder(): RunRecorder {
  return {
    async start(run: RunStart): Promise<number> {
      return withTx(null, async (tx) => {
        const rows = await tx
          .insert(ingestRuns)
          .values({
            jobId: run.jobId,
            sourceId: run.sourceId,
            startedAt: run.startedAt,
            status: 'running' satisfies RunStatus,
            traceId: run.traceId,
          })
          .returning({ runId: ingestRuns.runId });
        const runId = rows[0]?.runId;
        if (runId === undefined) {
          throw new Error(`ingest_runs insert returned no run_id for ${run.jobId}`);
        }
        return runId;
      });
    },

    async finish(run: RunFinish): Promise<void> {
      await withTx(null, async (tx) => {
        await tx
          .update(ingestRuns)
          .set({
            status: run.status,
            finishedAt: run.finishedAt,
            fetched: run.fetched,
            inserted: run.inserted,
            updated: run.updated,
            skipped: run.skipped,
            errors: run.errors,
          })
          .where(eq(ingestRuns.runId, run.runId));
      });
    },
  };
}

/** A recorder that keeps runs in memory — for a unit test of the tick logic, never for the server. */
export function memoryRunRecorder(): RunRecorder & { rows: (RunStart & Partial<RunFinish>)[] } {
  const rows: (RunStart & Partial<RunFinish>)[] = [];
  return {
    rows,
    start: (run: RunStart): Promise<number> => {
      rows.push({ ...run });
      return Promise.resolve(rows.length);
    },
    finish: (run: RunFinish): Promise<void> => {
      const row = rows[run.runId - 1];
      if (row !== undefined) Object.assign(row, run);
      return Promise.resolve();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Timeouts
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A run that exceeded `IngestJob.timeoutMs`. Recorded as `ingest_runs.errors[].code`. */
export class JobTimeoutError extends Error {
  constructor(
    readonly jobId: string,
    readonly timeoutMs: number,
  ) {
    super(`ingest job ${jobId} exceeded its ${String(timeoutMs)} ms timeout`);
    this.name = 'JobTimeoutError';
  }
}

/**
 * A timeout is the one thing here that cannot be driven by the injected clock: it must fire while
 * a job's promise is parked on IO that the `VirtualClock` knows nothing about. The timer is
 * `unref`'d so a pending timeout never keeps the process (or a vitest worker) alive, and it is
 * always cleared.
 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number, jobId: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new JobTimeoutError(jobId, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The scheduler
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One job's standing. Read it with {@link Scheduler.state}; the scheduler owns every field. */
export interface JobState {
  readonly jobId: string;
  /** True between the moment a run starts and the moment its `ingest_runs` row is closed. */
  running: boolean;
  /** Epoch ms of the last start, `null` before the first. */
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastStatus: Exclude<RunStatus, 'running'> | null;
  /** Failures since the last success — the `n` of `2^n × 5 s`. */
  consecutiveFailures: number;
  /** Epoch ms before which the job will not start again (the backoff gate). */
  nextEligibleAt: number;
  /** Executions started in this process. */
  executions: number;
  /** The jitter drawn for the current interval, in ms; 0 for a cron job. */
  jitterMs: number;
  /** `floor(epochMs / 60_000)` of the last cron firing, so one minute fires at most once. */
  lastCronMinute: number | null;
}

/** Where an execution parks its still-running body when the scheduler has stopped waiting for it. */
interface JobBodyHolder {
  body: Promise<void> | null;
}

/** Builds the context handed to `job.run`. The scheduler supplies the transaction it opened. */
export type JobContextFactory = (
  job: IngestJob,
  run: { runId: number; traceId: string },
  tx: Tx,
) => JobContext | Promise<JobContext>;

export interface SchedulerDeps {
  clock: Clock;
  jobs: readonly IngestJob[];
  /** How a `JobContext` is built. Wiring adds `providers`, `plant` and `hotset` here. */
  context: JobContextFactory;
  /** Default: the real `pg_try_advisory_lock` election. */
  election?: LeaderElection;
  /** Default: {@link dbRunRecorder}. */
  runs?: RunRecorder;
  log?: IngestLogger;
  /** Jitter source. Default `Math.random`; a test passes a constant and gets a fixed schedule. */
  random?: () => number;
  /** Wall-clock period of {@link Scheduler.start}'s timer. Default 1 000 ms (ARCHITECTURE L1004). */
  tickMs?: number;
  /** Overrides the default 04:00-20:00 ET session predicate. */
  marketHours?: (epochMs: number) => boolean;
  /** Default `randomUUID` — `ingest_runs.trace_id` is a uuid column. */
  newTraceId?: () => string;
}

/** One tick's decisions, returned so a caller (and a test) can see what happened. */
export interface TickReport {
  /** False when another process holds the leader lock: nothing at all was evaluated. */
  leader: boolean;
  /** Job ids started by this tick. */
  started: string[];
}

/**
 * The scheduler. Construct it with the job table, `start()` it in the server and `stop()` it on
 * SIGTERM; in a test, drive `tick()` by hand against a `VirtualClock`.
 */
export class Scheduler {
  readonly #deps: SchedulerDeps;
  readonly #jobs: readonly IngestJob[];
  readonly #states = new Map<string, JobState>();
  readonly #crons = new Map<string, CronSpec>();
  readonly #inFlight = new Set<Promise<void>>();
  readonly #election: LeaderElection;
  readonly #runs: RunRecorder;
  readonly #random: () => number;
  readonly #newTraceId: () => string;
  readonly #tickMs: number;

  #lock: LeaderLock | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking = false;
  #stopped = false;

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
    this.#jobs = deps.jobs;
    this.#election = deps.election ?? pgLeaderElection();
    this.#runs = deps.runs ?? dbRunRecorder();
    this.#random = deps.random ?? Math.random;
    this.#newTraceId = deps.newTraceId ?? randomUUID;
    this.#tickMs = deps.tickMs ?? 1_000;

    const seen = new Set<string>();
    for (const job of this.#jobs) {
      if (seen.has(job.id)) throw new Error(`duplicate ingest job id ${JSON.stringify(job.id)}`);
      seen.add(job.id);
      // Cron expressions are parsed once, at construction: a typo is a startup failure, not a job
      // that silently never fires.
      if (typeof job.schedule === 'string') {
        this.#crons.set(job.id, parseCron(job.schedule));
      } else if (!(job.schedule.everyMs > 0)) {
        throw new Error(`ingest job ${job.id}: everyMs must be a positive number of milliseconds`);
      }
      this.#states.set(job.id, {
        jobId: job.id,
        running: false,
        lastStartedAt: null,
        lastFinishedAt: null,
        lastStatus: null,
        consecutiveFailures: 0,
        nextEligibleAt: 0,
        executions: 0,
        jitterMs: 0,
        lastCronMinute: null,
      });
    }
  }

  /** True while this process holds `pg_try_advisory_lock(hashtext('ingest-leader'))`. */
  get isLeader(): boolean {
    return this.#lock?.held() === true;
  }

  /** The job table this scheduler was built with. */
  get jobs(): readonly IngestJob[] {
    return this.#jobs;
  }

  /** One job's standing, or `undefined` for an id this scheduler does not carry. */
  state(jobId: string): JobState | undefined {
    const state = this.#states.get(jobId);
    return state === undefined ? undefined : { ...state };
  }

  /** Start the 1-second timer. The timer is the only platform clock in the ingest runtime. */
  start(): void {
    if (this.#timer !== null || this.#stopped) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#tickMs);
    this.#timer.unref?.();
  }

  /**
   * Stop ticking, wait for the runs already in flight, and give up leadership so another process
   * can take over immediately rather than after a connection timeout.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.idle();
    await this.releaseLeadership();
  }

  /** Give up the leader lock without stopping. */
  async releaseLeadership(): Promise<void> {
    const lock = this.#lock;
    this.#lock = null;
    if (lock !== null) await lock.release();
  }

  /** Resolve once every run started so far has finished. */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.all([...this.#inFlight]);
    }
  }

  /**
   * One tick. Acquires leadership if this process does not have it, then starts every job that is
   * due. It does **not** wait for the jobs it starts: a 15-minute `yahooDaily` must not stop
   * `cboeQuotes` from polling. Await {@link idle} when you need the runs to have finished.
   */
  async tick(): Promise<TickReport> {
    if (this.#stopped) return { leader: this.isLeader, started: [] };
    // Ticks never overlap: a slow leader election must not queue up a second pass over the table.
    if (this.#ticking) return { leader: this.isLeader, started: [] };
    this.#ticking = true;
    try {
      if (!(await this.#ensureLeadership())) return { leader: false, started: [] };

      const now = this.#deps.clock.now();
      const started: string[] = [];
      for (const job of this.#jobs) {
        const state = this.#states.get(job.id);
        if (state === undefined || !this.#isDue(job, state, now)) continue;
        this.#begin(job, state, now);
        started.push(job.id);
      }
      return { leader: true, started };
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * Run one job now, ignoring its schedule but **not** the one-instance rule and **not**
   * leadership (`symbologyRefresh` is "daily 06:00 ET + on demand"). Resolves when the run has
   * finished.
   *
   * Leadership is checked here for the same reason {@link tick} checks it: two servers behind a
   * load balancer can both receive the on-demand trigger, and an ungated `runNow` would start the
   * job on both — exactly the double run `pg_try_advisory_lock(hashtext('ingest-leader'))` exists
   * to prevent. A follower does nothing and says so; route the trigger to the leader, or let the
   * caller answer 409.
   *
   * @returns the run's status; `null` when this node did not run it — either because the job was
   *          already running here, or because this node is not the leader ({@link isLeader} tells
   *          the two apart after the call).
   */
  async runNow(jobId: string): Promise<Exclude<RunStatus, 'running'> | null> {
    const job = this.#jobs.find((j) => j.id === jobId);
    const state = this.#states.get(jobId);
    if (job === undefined || state === undefined) throw new Error(`unknown ingest job ${jobId}`);
    if (this.#stopped) return null;
    if (state.running) return null;
    if (!(await this.#ensureLeadership())) {
      this.#deps.log?.info?.('ingest.run_now_declined', { job: jobId, reason: 'follower' });
      return null;
    }
    this.#begin(job, state, this.#deps.clock.now());
    await this.idle();
    return state.lastStatus;
  }

  // ── leadership ────────────────────────────────────────────────────────────────────────────

  async #ensureLeadership(): Promise<boolean> {
    if (this.isLeader) return true;
    this.#lock = null;
    const lock = await this.#election.acquire();
    if (lock === null) {
      this.#deps.log?.info?.('ingest.follower', { key: 'ingest-leader' });
      return false;
    }
    this.#lock = lock;
    this.#deps.log?.info?.('ingest.leader', { key: lock.key });
    return true;
  }

  // ── scheduling ────────────────────────────────────────────────────────────────────────────

  /** The interval in force right now: `everyMs` in session, `offHoursEveryMs` outside it. */
  #effectiveInterval(schedule: IntervalSchedule, now: number): number | null {
    const inSession = (this.#deps.marketHours ?? inExtendedSession)(now);
    if (inSession) return schedule.everyMs;
    if (schedule.offHoursEveryMs !== undefined) return schedule.offHoursEveryMs;
    // `marketHoursOnly` with no off-hours period means the job simply does not run out of session.
    return schedule.marketHoursOnly === true ? null : schedule.everyMs;
  }

  #isDue(job: IngestJob, state: JobState, now: number): boolean {
    if (state.running) return false;
    // The backoff gate. It applies to cron jobs too: a job that failed at 06:00 does not get a
    // second 06:00, it gets its next matching minute once the gate has opened.
    if (now < state.nextEligibleAt) return false;

    if (typeof job.schedule === 'string') {
      const spec = this.#crons.get(job.id);
      if (spec === undefined) return false;
      const minute = Math.floor(now / 60_000);
      if (state.lastCronMinute === minute) return false;
      return cronMatches(spec, zonedParts(now, job.timezone ?? DEFAULT_TIMEZONE));
    }

    const interval = this.#effectiveInterval(job.schedule, now);
    if (interval === null) return false;
    if (state.lastStartedAt === null) return true;
    return now >= state.lastStartedAt + interval + state.jitterMs;
  }

  /** Draw the next interval's jitter: uniform in `[-jitterMs, +jitterMs]`. */
  #drawJitter(schedule: IngestSchedule): number {
    if (typeof schedule === 'string') return 0;
    const jitter = schedule.jitterMs;
    if (jitter === undefined || jitter <= 0) return 0;
    return Math.round((this.#random() * 2 - 1) * jitter);
  }

  // ── execution ─────────────────────────────────────────────────────────────────────────────

  #begin(job: IngestJob, state: JobState, now: number): void {
    state.running = true;
    state.lastStartedAt = now;
    state.executions += 1;
    state.jitterMs = this.#drawJitter(job.schedule);
    if (typeof job.schedule === 'string') state.lastCronMinute = Math.floor(now / 60_000);

    // A timed-out run is **abandoned, not cancelled**: nothing in the job contract takes an
    // `AbortSignal`, so the body keeps going until its own IO returns. `holder.body` is that
    // body, and the job stays `running` — and out of the next tick's reach — until it settles.
    // Closing the `ingest_runs` row does not wait for it; the one-instance rule does.
    const holder: JobBodyHolder = { body: null };
    const promise = this.#execute(job, state, holder)
      .then(() => holder.body ?? Promise.resolve())
      .then(() => undefined)
      .finally(() => {
        state.running = false;
        this.#inFlight.delete(promise);
      });
    this.#inFlight.add(promise);
  }

  async #execute(job: IngestJob, state: JobState, holder: JobBodyHolder): Promise<void> {
    const clock = this.#deps.clock;
    const traceId = this.#newTraceId();
    const sourceId = primarySourceId(job);

    let runId: number;
    try {
      runId = await this.#runs.start({
        jobId: job.id,
        sourceId,
        startedAt: new Date(clock.now()),
        traceId,
      });
    } catch (err) {
      // The run was never recorded, so there is nothing to close. Treat it as a failure of the
      // job for backoff purposes — a database we cannot write to will not serve the job either.
      this.#fail(state, clock.now());
      this.#deps.log?.error?.('ingest.run.unrecorded', {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let result: JobResult | null = null;
    let thrown: Error | null = null;
    try {
      const work =
        job.transactional === false
          ? Promise.resolve(this.#deps.context(job, { runId, traceId }, poolTx())).then((ctx) =>
              job.run(ctx),
            )
          : withTx(null, async (tx) =>
              job.run(await this.#deps.context(job, { runId, traceId }, tx)),
            );
      // Held so a timeout leaves the job `running` until its body actually settles.
      holder.body = work.then(
        () => undefined,
        () => undefined,
      );
      result = await withTimeout(work, job.timeoutMs, job.id);
    } catch (err) {
      thrown = err instanceof Error ? err : new Error(String(err));
    }

    const finishedAt = clock.now();
    const counts = result ?? {
      fetched: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: [],
      provenanceIds: [],
    };
    const errors: JobError[] = [...counts.errors];
    if (thrown !== null) {
      errors.push({
        code: thrown instanceof JobTimeoutError ? 'JOB_TIMEOUT' : 'JOB_THREW',
        message: thrown.message,
      });
    }
    const status = runStatus(thrown, counts, errors);

    try {
      await this.#runs.finish({
        runId,
        status,
        finishedAt: new Date(finishedAt),
        fetched: counts.fetched,
        inserted: counts.inserted,
        updated: counts.updated,
        skipped: counts.skipped,
        errors,
      });
    } catch (err) {
      // The row stays `running`; `dqMonitors` reports it. Losing the close must not lose the
      // backoff, so the state below is updated either way.
      this.#deps.log?.error?.('ingest.run.unclosed', {
        jobId: job.id,
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    state.lastFinishedAt = finishedAt;
    state.lastStatus = status;
    if (failedForBackoff(thrown, counts)) {
      this.#fail(state, finishedAt);
      this.#deps.log?.warn?.('ingest.run.failed', {
        jobId: job.id,
        runId,
        consecutiveFailures: state.consecutiveFailures,
        retryInMs: backoffDelayMs(state.consecutiveFailures),
        error: thrown?.message ?? errors[0]?.message ?? null,
      });
    } else {
      state.consecutiveFailures = 0;
      state.nextEligibleAt = 0;
      this.#deps.log?.info?.('ingest.run.ok', {
        jobId: job.id,
        runId,
        status,
        fetched: counts.fetched,
        inserted: counts.inserted,
        updated: counts.updated,
      });
    }
  }

  #fail(state: JobState, at: number): void {
    state.consecutiveFailures += 1;
    state.nextEligibleAt = at + backoffDelayMs(state.consecutiveFailures);
  }
}

/** `ingest_runs.source_id` holds one id; a multi-provider job records the first (§13). */
export function primarySourceId(job: IngestJob): string | null {
  const provider = job.provider;
  if (provider === undefined) return null;
  return typeof provider === 'string' ? provider : (provider[0] ?? null);
}

/**
 * A run counts as failed **for backoff** when it threw, or when it reported errors and fetched
 * nothing: a poll that came back with 200 symbols and two bad rows is a working job with a data
 * problem (the rows are in `ingest_runs.errors` and `dq_events`), not a reason to stop polling.
 */
function failedForBackoff(thrown: Error | null, result: JobResult): boolean {
  if (thrown !== null) return true;
  return result.errors.length > 0 && result.fetched === 0;
}

/** `ingest_runs.status`: `failed` on errors, `skipped` for a run that had nothing to do. */
function runStatus(
  thrown: Error | null,
  result: JobResult,
  errors: readonly JobError[],
): Exclude<RunStatus, 'running'> {
  if (thrown !== null || errors.length > 0) return 'failed';
  const did = result.fetched + result.inserted + result.updated;
  return did === 0 && result.skipped > 0 ? 'skipped' : 'ok';
}

/**
 * The handle a `transactional: false` job receives in `ctx.tx`. It is the pool, not a transaction:
 * such a job opens its own (`withMaintTx` for partition DDL), and giving it an application
 * transaction it must not use would only invite a deadlock against its own DDL.
 */
function poolTx(): Tx {
  return getDb() as unknown as Tx;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job table (PROVIDERS §13)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Raised when a job module's `job.id` is not its own file name. */
export class JobIdMismatchError extends Error {
  constructor(basename: string, declared: unknown) {
    super(
      `ingest job module ${basename}.ts declares id ${JSON.stringify(declared)}: ` +
        `IngestJob.id is the module basename (PROVIDERS §13), and it is what lands in ingest_runs.job_id`,
    );
    this.name = 'JobIdMismatchError';
  }
}

/**
 * Turn `ingest/jobs/index.ts`'s generated module map into the job table, checking the naming
 * convention on the way: the key of the map is the file name, and the module's `job.id` must equal
 * it. That is the mechanical check PROVIDERS §13 asks for.
 *
 * Modules that export no `job` are skipped — a WP-04 job module that predates this file is a
 * library of parsers until someone adds the descriptor.
 */
export function collectJobs(modules: Record<string, unknown>): IngestJob[] {
  const jobs: IngestJob[] = [];
  for (const [basename, module] of Object.entries(modules)) {
    if (typeof module !== 'object' || module === null) continue;
    const descriptor = (module as { job?: unknown }).job;
    if (descriptor === undefined) continue;
    if (typeof descriptor !== 'object' || descriptor === null) {
      throw new JobIdMismatchError(basename, descriptor);
    }
    const job = descriptor as Partial<IngestJob>;
    if (job.id !== basename) throw new JobIdMismatchError(basename, job.id);
    if (typeof job.run !== 'function') {
      throw new Error(`ingest job module ${basename}.ts exports a job with no run()`);
    }
    if (job.schedule === undefined) {
      throw new Error(`ingest job module ${basename}.ts exports a job with no schedule`);
    }
    if (job.priority !== 1 && job.priority !== 2 && job.priority !== 3) {
      throw new Error(`ingest job module ${basename}.ts: priority must be 1, 2 or 3`);
    }
    if (typeof job.timeoutMs !== 'number' || job.timeoutMs <= 0) {
      throw new Error(`ingest job module ${basename}.ts: timeoutMs must be a positive number`);
    }
    jobs.push(job as IngestJob);
  }
  // Priority order, then id, so the hot-set jobs of a tick are started before the weekly ones.
  return jobs.sort((a, b) =>
    a.priority !== b.priority ? a.priority - b.priority : a.id < b.id ? -1 : 1,
  );
}
