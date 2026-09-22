/**
 * The ingest runtime — WORKPLAN §WP-05 acceptance row 6: "leader lock prevents a double run;
 * failure backoff sequence; one `ingest_runs` row per execution with the basename `job_id`".
 *
 * What this file proves, in order:
 *
 *  1. **the naming convention is mechanical** (PROVIDERS §13) — every module in the generated
 *     `ingest/jobs/index.ts` declares `job.id` equal to its own file name, `collectJobs` is the
 *     check, and it refuses a module that does not;
 *  2. **one `ingest_runs` row per execution**, `job_id` = that basename, `status` walking
 *     `running → ok`, the four counters and a uuid `trace_id` on the row — and one row, not two,
 *     when a tick lands on a job that is still running (ARCHITECTURE L1005);
 *  3. **the backoff sequence** `5, 10, 20, 40, 80, 160, 320, 600, 600 s` on a `VirtualClock`,
 *     asserted by the scheduler *not* starting the job one millisecond early and starting it on
 *     the millisecond — never by reading a constant back out of the module;
 *  4. **the leader lock prevents a double run**: while another session holds
 *     `pg_try_advisory_lock(hashtext('ingest-leader'))`, a scheduler's tick evaluates nothing,
 *     writes nothing and starts nothing; when the lock goes, the next tick runs the job.
 *
 * …and the hot set, which is the other half of the runtime: the union of subscribers, connected
 * users' watchlists and the always-on seed, the 300 s decay, and the poll order.
 *
 * **Self-sufficient by construction.** WP-15 owns the seed and does not exist yet, so every row
 * read here is one this file wrote. The harness is `withCleanDb([])` — *no* truncation, because
 * `provenance.run_id` references `ingest_runs` and a `TRUNCATE … CASCADE` would take the whole
 * reference graph (and every other integration fork's rows) with it. Instead the scheduler's runs
 * commit, as they must (a failed job has to leave a committed `failed` row behind it), and this
 * file deletes exactly the `job_id`s it created. Those ids carry a per-run unique suffix, so two
 * forks could not collide even if they ran this file at once.
 *
 * Nothing here reads the platform clock: the scheduler is driven by `tick()` on a `VirtualClock`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';

import { closeDb, getDb, getPool } from '../../../src/db/client.js';
import {
  ALWAYS_ON_SEED_KEYS,
  HotSet,
  loadConnectedUsers,
  loadWatchlistSubjects,
  quoteSubject,
  refreshWatchlistSubjects,
} from '../../../src/ingest/hotset.js';
import { ingestJobModules } from '../../../src/ingest/jobs/index.js';
import { LEADER_LOCK_KEY, tryAcquireLeaderLock } from '../../../src/ingest/lock.js';
import {
  BACKOFF_CAP_MS,
  JobIdMismatchError,
  Scheduler,
  backoffDelayMs,
  collectJobs,
  cronMatches,
  parseCron,
  zonedParts,
} from '../../../src/ingest/scheduler.js';
import { TEST_NOW, testClock } from '../../../src/test/clock.js';
import { withCleanDb } from '../../../src/test/db.js';

import type { LeaderLock } from '../../../src/ingest/lock.js';
import type { IngestJob, JobContext, JobResult } from '../../../src/ingest/scheduler.js';
import type { Tx } from '../../../src/db/client.js';

const t = withCleanDb([]);

/** Job ids created by this file. Unique per process, so parallel forks cannot collide. */
const SUFFIX = randomUUID().slice(0, 8);
const createdJobIds: string[] = [];

function jobId(name: string): string {
  const id = `${name}_${SUFFIX}`;
  createdJobIds.push(id);
  return id;
}

/** An empty, successful result. */
function ok(overrides: Partial<JobResult> = {}): JobResult {
  return {
    fetched: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    provenanceIds: [],
    ...overrides,
  };
}

/** The context factory the scheduler is built with — the transaction it opened, and nothing else. */
function contextFactory(clock: { now(): number }) {
  return (_job: IngestJob, run: { runId: number; traceId: string }, tx: Tx): JobContext => ({
    clock,
    db: getDb(),
    tx,
    traceId: run.traceId,
    runId: run.runId,
  });
}

interface RunRow {
  job_id: string;
  source_id: string | null;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: { code: string; message: string }[];
  trace_id: string | null;
}

async function runsFor(id: string): Promise<RunRow[]> {
  const res = await t.client.query<RunRow>(
    'SELECT job_id, source_id, status, started_at, finished_at, fetched, inserted, updated, skipped, errors, trace_id FROM ingest_runs WHERE job_id = $1 ORDER BY run_id',
    [id],
  );
  return res.rows;
}

/**
 * Wait for a condition that a real (not virtual) round trip to Postgres has to complete first —
 * the `ingest_runs` insert that precedes every `run`. The scheduler's own timing is virtual; this
 * only yields the event loop.
 */
async function until(condition: () => boolean, tries = 500): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('until(): condition never became true');
}

/** Schedulers a test started, stopped (and unlocked) whatever the test did. */
const openSchedulers: Scheduler[] = [];
const openLocks: LeaderLock[] = [];

function scheduler(deps: ConstructorParameters<typeof Scheduler>[0]): Scheduler {
  const s = new Scheduler(deps);
  openSchedulers.push(s);
  return s;
}

beforeEach(() => {
  openSchedulers.length = 0;
  openLocks.length = 0;
});

afterEach(async () => {
  for (const s of openSchedulers.splice(0)) await s.stop();
  for (const lock of openLocks.splice(0)) await lock.release();
  if (createdJobIds.length > 0) {
    await t.client.query('DELETE FROM ingest_runs WHERE job_id = ANY($1::text[])', [createdJobIds]);
  }
});

afterAll(async () => {
  await closeDb();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('the job table (PROVIDERS §13)', () => {
  it('every generated job module declares its own basename as IngestJob.id', () => {
    const jobs = collectJobs(ingestJobModules);
    // The WP-04 modules that carry a descriptor today. Others are parser libraries until someone
    // adds one, and `collectJobs` skips them rather than inventing an id.
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(Object.keys(ingestJobModules)).toContain(job.id);
    }
    // `collectJobs` hands the table back in priority order, so a tick starts the hot-set jobs
    // before the weekly ones.
    const priorities = jobs.map((j) => j.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });

  it('refuses a module whose job.id is not its file name', () => {
    expect(() =>
      collectJobs({
        cboeQuotes: {
          job: {
            id: 'cboe.quotes.poll',
            schedule: { everyMs: 10_000 },
            priority: 1,
            timeoutMs: 10_000,
            run: () => Promise.resolve(ok()),
          },
        },
      }),
    ).toThrow(JobIdMismatchError);
  });

  it('parses every cron form the job table uses', () => {
    // '30 17 * * 1-5' (yahooDaily), '0 20 10,26 * *' (shortInterest), '0 4 1 * *' (secNport).
    const daily = parseCron('30 17 * * 1-5');
    const twiceMonthly = parseCron('0 20 10,26 * *');
    // 2026-09-17 is a Thursday; 17:30 America/New_York is 21:30Z in EDT.
    expect(cronMatches(daily, zonedParts(Date.parse('2026-09-17T21:30:00Z')))).toBe(true);
    expect(cronMatches(daily, zonedParts(Date.parse('2026-09-17T21:31:00Z')))).toBe(false);
    // 2026-09-19 is a Saturday.
    expect(cronMatches(daily, zonedParts(Date.parse('2026-09-19T21:30:00Z')))).toBe(false);
    // 20:00 America/New_York on the 26th is 00:00Z on the 27th.
    expect(cronMatches(twiceMonthly, zonedParts(Date.parse('2026-09-27T00:00:00Z')))).toBe(true);
    expect(cronMatches(twiceMonthly, zonedParts(Date.parse('2026-09-26T00:00:00Z')))).toBe(false);
    expect(() => parseCron('30 17 * *')).toThrow(/expected 5 fields/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('ingest_runs — one row per execution', () => {
  it('writes exactly one row per execution, with the module basename as job_id', async () => {
    const clock = testClock(TEST_NOW);
    const id = jobId('cboeQuotes');
    let runs = 0;

    const job: IngestJob = {
      id,
      schedule: { everyMs: 10_000 },
      priority: 1,
      timeoutMs: 10_000,
      run: () => {
        runs += 1;
        return Promise.resolve(ok({ fetched: 3, inserted: 2, updated: 1 }));
      },
    };

    const s = scheduler({ clock, jobs: [job], context: contextFactory(clock) });

    const first = await s.tick();
    await s.idle();
    expect(first.leader).toBe(true);
    expect(first.started).toEqual([id]);

    // Not due again for 10 s.
    clock.advance(9_999);
    await s.tick();
    await s.idle();
    expect(runs).toBe(1);

    clock.advance(1);
    await s.tick();
    await s.idle();
    expect(runs).toBe(2);

    const rows = await runsFor(id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.job_id).toBe(id);
      expect(row.status).toBe('ok');
      expect(row.source_id).toBeNull(); // an internal job: `ingest_runs.source_id` is nullable
      expect(row.finished_at).not.toBeNull();
      expect(row.fetched).toBe(3);
      expect(row.inserted).toBe(2);
      expect(row.updated).toBe(1);
      expect(row.errors).toEqual([]);
      expect(row.trace_id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(rows[0]?.trace_id).not.toBe(rows[1]?.trace_id);
    expect(rows[1]?.started_at.getTime()).toBe(rows[0]!.started_at.getTime() + 10_000);
  });

  it('records the provider as ingest_runs.source_id', async () => {
    const clock = testClock(TEST_NOW);
    const id = jobId('ssgaHoldings');
    const job: IngestJob = {
      id,
      schedule: { everyMs: 60_000 },
      provider: 'ssga.holdings',
      priority: 2,
      timeoutMs: 60_000,
      run: () => Promise.resolve(ok({ fetched: 1, inserted: 1 })),
    };
    const s = scheduler({ clock, jobs: [job], context: contextFactory(clock) });
    await s.tick();
    await s.idle();

    const rows = await runsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_id).toBe('ssga.holdings');
  });

  it('never starts a second instance of a job that is still running', async () => {
    const clock = testClock(TEST_NOW);
    const id = jobId('yahooDaily');
    let starts = 0;
    let release: (() => void) | undefined;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const job: IngestJob = {
      id,
      schedule: { everyMs: 1_000 },
      priority: 2,
      timeoutMs: 900_000,
      run: async (): Promise<JobResult> => {
        starts += 1;
        await parked;
        return ok({ fetched: 1 });
      },
    };

    const s = scheduler({ clock, jobs: [job], context: contextFactory(clock) });
    try {
      await s.tick();
      expect(s.state(id)?.running).toBe(true);
      // The `ingest_runs` insert commits before `run` is called, so wait for the body to be in.
      await until(() => starts === 1);

      // Five more ticks, each of them past the 1 s interval: the job is still running, so none of
      // them start anything and none of them write a row.
      for (let i = 0; i < 5; i += 1) {
        clock.advance(1_000);
        const report = await s.tick();
        expect(report.started).toEqual([]);
      }
      expect(starts).toBe(1);
      expect(await runsFor(id)).toHaveLength(1);
    } finally {
      release?.();
    }
    await s.idle();

    const rows = await runsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ok');
    expect(s.state(id)?.running).toBe(false);
  });

  it('closes the row as failed when the job overruns its timeoutMs', async () => {
    const clock = testClock(TEST_NOW);
    const id = jobId('treasuryCurves');
    let bodyDone = false;
    const job: IngestJob = {
      id,
      schedule: { everyMs: 120_000 },
      priority: 2,
      // The one thing the virtual clock cannot drive: a timeout has to fire while the job is
      // parked on IO, so it runs on a real timer (10 ms here, 120 s in the job table).
      timeoutMs: 10,
      run: async (): Promise<JobResult> => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        bodyDone = true;
        return ok({ fetched: 1 });
      },
    };
    const s = scheduler({ clock, jobs: [job], context: contextFactory(clock) });
    await s.tick();

    // The row is closed at the timeout, while the body is still going: a timed-out run is
    // abandoned, not cancelled.
    await until(() => s.state(id)?.lastStatus === 'failed');
    expect(bodyDone).toBe(false);
    expect(s.state(id)?.running).toBe(true);
    // …and the one-instance rule still holds over the abandoned body.
    clock.advance(600_000);
    expect((await s.tick()).started).toEqual([]);

    const rows = await runsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.errors[0]?.code).toBe('JOB_TIMEOUT');
    expect(s.state(id)?.consecutiveFailures).toBe(1);

    await s.idle();
    expect(bodyDone).toBe(true);
    expect(s.state(id)?.running).toBe(false);
    expect(await runsFor(id)).toHaveLength(1);
  });

  it('hands a transactional:false job the pool rather than an application transaction', async () => {
    const clock = testClock(TEST_NOW);
    const id = jobId('partitionMaintenance');
    let sawTx: unknown = null;
    const job: IngestJob = {
      id,
      schedule: '0 1 * * *',
      priority: 3,
      timeoutMs: 300_000,
      // `partitionMaintenance` opens its own `withMaintTx`; wrapping it in an application
      // transaction it cannot use would only invite a deadlock against its own DDL.
      transactional: false,
      run: (ctx: JobContext): Promise<JobResult> => {
        sawTx = ctx.tx;
        return Promise.resolve(ok({ updated: 6 }));
      },
    };
    const s = scheduler({ clock, jobs: [job], context: contextFactory(clock) });
    // 01:00 America/New_York on 2026-09-18 is 05:00Z.
    clock.set(Date.parse('2026-09-18T05:00:00Z'));
    await s.tick();
    await s.idle();

    expect(sawTx).not.toBeNull();
    const rows = await runsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ok');
    expect(rows[0]?.updated).toBe(6);

    // A cron minute fires once, however many ticks land inside it.
    clock.advance(30_000);
    expect((await s.tick()).started).toEqual([]);
    await s.idle();
    expect(await runsFor(id)).toHaveLength(1);
  });

  it('closes the row as failed when the job throws, and records the error', async () => {
    const clock = testClock(TEST_NOW);
    const id = jobId('dqMonitors');
    const job: IngestJob = {
      id,
      schedule: { everyMs: 60_000 },
      priority: 2,
      timeoutMs: 30_000,
      run: () => Promise.reject(new Error('provider circuit open')),
    };
    const s = scheduler({ clock, jobs: [job], context: contextFactory(clock) });
    await s.tick();
    await s.idle();

    const rows = await runsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.errors).toEqual([{ code: 'JOB_THREW', message: 'provider circuit open' }]);
    expect(rows[0]?.finished_at).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('failure backoff — 2^n × 5 s, capped at 10 min', () => {
  /** ARCHITECTURE L1008, as a sequence rather than as a formula. */
  const SEQUENCE = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000];

  it('computes the documented delays', () => {
    expect(SEQUENCE.map((_, i) => backoffDelayMs(i + 1))).toEqual(SEQUENCE);
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(50)).toBe(BACKOFF_CAP_MS);
  });

  it('holds a failing job off for exactly that sequence on a VirtualClock', async () => {
    const clock = testClock(TEST_NOW);
    const id = jobId('fxIntraday');
    let attempts = 0;

    const job: IngestJob = {
      id,
      // A one-second interval: only the backoff gate can keep this job from running.
      schedule: { everyMs: 1_000 },
      priority: 1,
      timeoutMs: 15_000,
      run: () => {
        attempts += 1;
        return Promise.reject(new Error(`attempt ${String(attempts)} failed`));
      },
    };

    const s = scheduler({ clock, jobs: [job], context: contextFactory(clock) });

    await s.tick();
    await s.idle();
    expect(attempts).toBe(1);
    expect(s.state(id)?.consecutiveFailures).toBe(1);

    for (const [i, delay] of SEQUENCE.entries()) {
      const state = s.state(id);
      expect(state?.nextEligibleAt).toBe((state?.lastFinishedAt ?? 0) + delay);

      clock.advance(delay - 1);
      await s.tick();
      await s.idle();
      expect(attempts).toBe(i + 1); // one millisecond early: still held off

      clock.advance(1);
      await s.tick();
      await s.idle();
      expect(attempts).toBe(i + 2);
      expect(s.state(id)?.consecutiveFailures).toBe(i + 2);
    }

    const rows = await runsFor(id);
    expect(rows).toHaveLength(SEQUENCE.length + 1);
    expect(rows.every((r) => r.status === 'failed')).toBe(true);
  });

  it('clears the backoff on the first success', async () => {
    const clock = testClock(TEST_NOW);
    const id = jobId('crypto');
    let failNext = true;
    const job: IngestJob = {
      id,
      schedule: { everyMs: 1_000 },
      priority: 1,
      timeoutMs: 10_000,
      run: () => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('502'));
        }
        return Promise.resolve(ok({ fetched: 1 }));
      },
    };
    const s = scheduler({ clock, jobs: [job], context: contextFactory(clock) });

    await s.tick();
    await s.idle();
    expect(s.state(id)?.consecutiveFailures).toBe(1);

    clock.advance(5_000);
    await s.tick();
    await s.idle();
    expect(s.state(id)?.consecutiveFailures).toBe(0);
    expect(s.state(id)?.nextEligibleAt).toBe(0);

    // Back on the ordinary one-second cadence.
    clock.advance(1_000);
    await s.tick();
    await s.idle();
    expect(await runsFor(id)).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("leader election — pg_try_advisory_lock(hashtext('ingest-leader'))", () => {
  it('a second process does not run the schedule while another holds the lock', async () => {
    const clock = testClock(TEST_NOW);
    const id = jobId('cboeEuIndices');
    let runs = 0;
    const job: IngestJob = {
      id,
      schedule: { everyMs: 1_000 },
      priority: 1,
      timeoutMs: 10_000,
      run: () => {
        runs += 1;
        return Promise.resolve(ok({ fetched: 1 }));
      },
    };

    // Another session — a second server process, as far as Postgres is concerned — is leader.
    const incumbent = await tryAcquireLeaderLock({ pool: getPool() });
    expect(incumbent).not.toBeNull();
    openLocks.push(incumbent!);
    expect(incumbent?.key).toBe(LEADER_LOCK_KEY);

    const s = scheduler({ clock, jobs: [job], context: contextFactory(clock) });

    for (let i = 0; i < 3; i += 1) {
      const report = await s.tick();
      await s.idle();
      expect(report.leader).toBe(false);
      expect(report.started).toEqual([]);
      clock.advance(1_000);
    }
    expect(s.isLeader).toBe(false);
    expect(runs).toBe(0);
    // Not a single row: a follower writes nothing at all.
    expect(await runsFor(id)).toHaveLength(0);

    // The incumbent goes away…
    await incumbent!.release();
    openLocks.length = 0;

    const report = await s.tick();
    await s.idle();
    expect(report.leader).toBe(true);
    expect(report.started).toEqual([id]);
    expect(runs).toBe(1);
    expect(await runsFor(id)).toHaveLength(1);
  });

  it('two schedulers in one fleet: only the first runs the job', async () => {
    const clock = testClock(TEST_NOW);
    const id = jobId('newsRss');
    const runs = { a: 0, b: 0 };
    const make = (counter: 'a' | 'b'): IngestJob => ({
      id,
      schedule: { everyMs: 1_000 },
      priority: 1,
      timeoutMs: 20_000,
      run: () => {
        runs[counter] += 1;
        return Promise.resolve(ok({ fetched: 1 }));
      },
    });

    const a = scheduler({ clock, jobs: [make('a')], context: contextFactory(clock) });
    const b = scheduler({ clock, jobs: [make('b')], context: contextFactory(clock) });

    await a.tick();
    await a.idle();
    const bReport = await b.tick();
    await b.idle();

    expect(a.isLeader).toBe(true);
    expect(b.isLeader).toBe(false);
    expect(bReport.started).toEqual([]);
    expect(runs).toEqual({ a: 1, b: 0 });
    expect(await runsFor(id)).toHaveLength(1);

    // A stands down; B takes over on its next tick.
    await a.stop();
    clock.advance(1_000);
    const second = await b.tick();
    await b.idle();
    expect(second.leader).toBe(true);
    expect(runs).toEqual({ a: 1, b: 1 });
    expect(await runsFor(id)).toHaveLength(2);
  });

  it('runNow is gated by leadership too: a follower declines the on-demand trigger', async () => {
    // `symbologyRefresh` is "daily 06:00 ET + on demand". Two servers behind a load balancer can
    // both receive the on-demand trigger; an ungated `runNow` would start the job on both, which
    // is precisely the double run the advisory lock exists to prevent.
    const clock = testClock(TEST_NOW);
    const id = jobId('symbologyRefresh');
    const runs = { a: 0, b: 0 };
    const make = (counter: 'a' | 'b'): IngestJob => ({
      id,
      schedule: '0 10 * * *',
      priority: 1,
      timeoutMs: 20_000,
      run: () => {
        runs[counter] += 1;
        return Promise.resolve(ok({ fetched: 1 }));
      },
    });

    const a = scheduler({ clock, jobs: [make('a')], context: contextFactory(clock) });
    const b = scheduler({ clock, jobs: [make('b')], context: contextFactory(clock) });

    // A takes the lock on its first tick; B is a follower from then on.
    await a.tick();
    await a.idle();
    await b.tick();
    await b.idle();
    expect(a.isLeader).toBe(true);
    expect(b.isLeader).toBe(false);

    const onA = await a.runNow(id);
    const onB = await b.runNow(id);

    expect(onA).toBe('ok');
    expect(onB).toBeNull();
    expect(b.isLeader).toBe(false);
    expect(runs).toEqual({ a: 1, b: 0 });
    // One execution, one row — not two.
    expect(await runsFor(id)).toHaveLength(1);

    await a.stop();
    await b.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('the hot set', () => {
  it('unions subscribers, watchlists and the always-on seed, and orders the poll', () => {
    const clock = testClock(TEST_NOW);
    const hot = new HotSet({ clock });

    hot.setAlwaysOn(['q:1']);
    hot.setWatchlistSubjects(['q:2', 'q:3']);
    hot.subscribe('q:3');
    hot.subscribe('q:4');
    hot.subscribe('q:4');

    expect(hot.subjects().sort()).toEqual(['q:1', 'q:2', 'q:3', 'q:4']);
    // (subscriber count desc, last poll asc) — ARCHITECTURE L800.
    expect(hot.subjects()).toEqual(['q:4', 'q:3', 'q:1', 'q:2']);

    hot.markPolled('q:1');
    clock.advance(1_000);
    hot.markPolled('q:2');
    // q:2 was polled later than q:1, so q:1 comes first among the unsubscribed.
    expect(hot.subjects()).toEqual(['q:4', 'q:3', 'q:1', 'q:2']);
    hot.markPolled('q:1', clock.now() + 5_000);
    expect(hot.subjects()).toEqual(['q:4', 'q:3', 'q:2', 'q:1']);
  });

  it('decays a subject 300 s after the last subscriber leaves, and never the seed', () => {
    const clock = testClock(TEST_NOW);
    const hot = new HotSet({ clock });
    hot.setAlwaysOn(['q:seed']);
    hot.subscribe('q:9');
    hot.subscribe('q:9');

    hot.unsubscribe('q:9');
    expect(hot.has('q:9')).toBe(true); // one subscriber left

    hot.unsubscribe('q:9');
    clock.advance(299_999);
    expect(hot.has('q:9')).toBe(true);

    clock.advance(1);
    expect(hot.has('q:9')).toBe(false);
    expect(hot.has('q:seed')).toBe(true);

    // Re-subscribing brings it back with no poll history, so it is polled at once.
    hot.subscribe('q:9');
    expect(hot.entries().find((e) => e.subject === 'q:9')?.lastPolledAt).toBeNull();
  });

  it('drops a subject that falls off every connected watchlist', () => {
    const clock = testClock(TEST_NOW);
    const hot = new HotSet({ clock });
    hot.setWatchlistSubjects(['q:10', 'q:11']);
    hot.setWatchlistSubjects(['q:10']);
    expect(hot.has('q:11')).toBe(true);
    clock.advance(300_000);
    expect(hot.subjects()).toEqual(['q:10']);
  });

  it('reads the watchlists of connected users only', async () => {
    const clock = testClock(TEST_NOW);
    const tx: Tx = t.db;

    await t.client.query('BEGIN');
    try {
      const firm = await t.client.query<{ firm_id: string }>(
        `INSERT INTO firms (name) VALUES ('Hot Set Test Firm') RETURNING firm_id`,
      );
      const firmId = Number(firm.rows[0]!.firm_id);

      const mkUser = async (email: string): Promise<number> => {
        const res = await t.client.query<{ user_id: string }>(
          `INSERT INTO users (firm_id, email, display_name) VALUES ($1, $2, $3) RETURNING user_id`,
          [firmId, email, email],
        );
        return Number(res.rows[0]!.user_id);
      };
      const connected = await mkUser(`connected-${SUFFIX}@example.invalid`);
      const idle = await mkUser(`idle-${SUFFIX}@example.invalid`);

      const mkSession = async (userId: number, lastSeen: Date, expires: Date): Promise<void> => {
        await t.client.query(
          `INSERT INTO sessions (user_id, token_hash, client_kind, last_seen_at, expires_at)
           VALUES ($1, $2, 'web', $3, $4)`,
          [userId, Buffer.from(randomUUID()), lastSeen, expires],
        );
      };
      const now = new Date(clock.now());
      await mkSession(connected, now, new Date(clock.now() + 3_600_000));
      // Seen an hour ago: the terminal is closed, and its watchlist is not polled.
      await mkSession(idle, new Date(clock.now() - 3_600_000), new Date(clock.now() + 3_600_000));

      const mkWatchlist = async (userId: number, instrumentIds: number[]): Promise<void> => {
        const wl = await t.client.query<{ watchlist_id: string }>(
          `INSERT INTO watchlists (owner_user_id, firm_id, name, columns)
           VALUES ($1, $2, $3, '[]'::jsonb) RETURNING watchlist_id`,
          [userId, firmId, `wl-${String(userId)}`],
        );
        const watchlistId = Number(wl.rows[0]!.watchlist_id);
        for (const [position, instrumentId] of instrumentIds.entries()) {
          await t.client.query(
            `INSERT INTO watchlist_items (watchlist_id, position, instrument_id) VALUES ($1, $2, $3)`,
            [watchlistId, position, instrumentId],
          );
        }
        // A formula row has no instrument and therefore no subject (CHRT-07).
        await t.client.query(
          `INSERT INTO watchlist_items (watchlist_id, position, formula) VALUES ($1, $2, $3)`,
          [watchlistId, instrumentIds.length, 'RATIO(AAPL US Equity, SPX Index)'],
        );
      };
      await mkWatchlist(connected, [777_001, 777_002]);
      await mkWatchlist(idle, [777_003]);

      const users = await loadConnectedUsers(tx, { clock });
      const ids = users.map((u) => u.userId);
      expect(ids).toContain(connected);
      expect(ids).not.toContain(idle);

      const subjects = await loadWatchlistSubjects(
        users.filter((u) => u.userId === connected),
        { tx },
      );
      expect(subjects).toEqual([quoteSubject(777_001), quoteSubject(777_002)]);

      const hot = new HotSet({ clock });
      hot.setWatchlistSubjects(subjects);
      hot.subscribe('q:777001');
      expect(hot.subjects()).toEqual(['q:777001', 'q:777002']);

      // An always-on seed name resolves through the md_line that quotes it (PROVIDERS §5.4).
      const prov = await t.client.query<{ provenance_id: string }>(
        `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                                 http_status, bytes, captured_at, adapter_version)
         VALUES ('cboe.euIndices', $1, 'https://example.invalid/BUK100P.json',
                 '\\x00'::bytea, '\\x00'::bytea, 200, 1, $2, 'test/1.0.0')
         RETURNING provenance_id`,
        [`hotset-${SUFFIX}`, now],
      );
      await t.client.query(
        `INSERT INTO md_lines (instrument_id, source_id, provider_symbol, line_kind,
                               intrinsic_delay_min, expected_interval_ms, valid_from, provenance_id)
         VALUES (777004, 'cboe.euIndices', 'BUK100P', 'composite', 15, 60000, $1, $2)`,
        [now, Number(prov.rows[0]!.provenance_id)],
      );

      // The same thing end to end, on the harness transaction: sessions → watchlists → hot set,
      // plus the seed. The idle user's `q:777003` is in none of it.
      const fresh = new HotSet({ clock });
      const refreshed = await refreshWatchlistSubjects(fresh, {
        clock,
        tx,
        alwaysOnKeys: ALWAYS_ON_SEED_KEYS,
      });
      expect(refreshed.watchlist).toContain(quoteSubject(777_001));
      expect(refreshed.watchlist).not.toContain(quoteSubject(777_003));
      expect(refreshed.alwaysOn).toEqual([quoteSubject(777_004)]);
      expect(fresh.subjects()).toEqual([...refreshed.watchlist, quoteSubject(777_004)].sort());
    } finally {
      await t.client.query('ROLLBACK');
    }
  });
});
