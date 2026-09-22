/**
 * WORKPLAN WP-07 — `entitlements/accessLog.ts`: "one row per field read with the right
 * `decision`/`reason`; batching flushes at 1 s and at 5,000 rows; the WORM trigger rejects
 * `UPDATE`/`DELETE` (REG-01)".
 *
 * Everything is self-sufficient: the firm, the user and the instrument are created inside this
 * file's own `withTxDb()` transaction, which is also the writer's database handle, so its flushes
 * are savepoints inside the test transaction and the rollback takes them with it.
 *
 * Time is the virtual clock's. `TEST_NOW` (2026-09-17T13:30Z) lands in `access_log_m2026_09`, one
 * of the three monthly partitions migration 0016 ships (`_m2026_09`, `_m2026_10`, `_m2026_11`,
 * beside `access_log_default`); the first test asserts the row really landed in that partition
 * rather than in the default one.
 *
 * Nothing here polls on wall-clock time: the two asynchronous flushes (the timer tick and the
 * 5 000-row trigger) are awaited by re-counting rows on a bounded loop of microsleeps, so the
 * assertions are about row counts in Postgres, never about a boolean the writer reports.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  accessLog,
  type AccessLogRow,
  type AccessLogTimers,
} from '../../../src/entitlements/accessLog.js';
import { asAppRole, withTxDb, type TestDb } from '../../../src/test/db.js';
import { testClock, TEST_NOW } from '../../../src/test/clock.js';
import { seedQuoteInstrument } from '../ws/helpers.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A firm and a user of it. `access_log` carries both ids on every row. */
async function seedPrincipal(t: TestDb): Promise<{ userId: number; firmId: number }> {
  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Access Log Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'Access Log User', 'user') RETURNING user_id`,
    [firmId, `accesslog-${randomUUID()}@demo.invalid`],
  );
  return { userId: Number(user.rows[0]!.user_id), firmId };
}

/** A manual timers port: the test decides when the flush tick fires. */
interface ManualTimers extends AccessLogTimers {
  /** Run the armed interval callback once. */
  fire(): void;
  /** The period the writer asked for, or `null` when nothing is armed. */
  readonly armedMs: number | null;
  readonly armed: boolean;
}

function manualTimers(): ManualTimers {
  let tick: (() => void) | undefined;
  let period: number | null = null;
  return {
    get armedMs(): number | null {
      return period;
    },
    get armed(): boolean {
      return tick !== undefined;
    },
    setInterval(fn: () => void, ms: number): unknown {
      tick = fn;
      period = ms;
      return { handle: 'manual' };
    },
    clearInterval(): void {
      tick = undefined;
      period = null;
    },
    fire(): void {
      if (tick === undefined) throw new Error('manualTimers: no interval armed');
      tick();
    },
  };
}

/** Yield to the event loop for `ms` without consulting a clock the tests are not allowed to read. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Re-run `count()` until it reports `want`, on a bounded loop (100 × 20 ms ≈ 2 s). Fails with the
 * last count seen, so a broken flush reports "wrote 0 of 5000" rather than timing out blind.
 */
async function awaitRows(count: () => Promise<number>, want: number, what: string): Promise<void> {
  let last = -1;
  for (let i = 0; i < 100; i++) {
    last = await count();
    if (last === want) return;
    await sleep(20);
  }
  throw new Error(`${what}: access_log holds ${String(last)} rows, expected ${String(want)}`);
}

/** The row the evaluator appends, with the fixed parts filled in. */
function row(
  base: {
    userId: number;
    firmId: number;
    sessionId: string;
    instrumentId: number;
    traceId: string;
  },
  over: Partial<AccessLogRow> & Pick<AccessLogRow, 'fieldId' | 'decision' | 'reason'>,
): AccessLogRow {
  return {
    ts: TEST_NOW,
    userId: base.userId,
    firmId: base.firmId,
    sessionId: base.sessionId,
    instrumentId: base.instrumentId,
    fieldClass: 'price',
    sourceId: 'cboe.quotes',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'display',
    purpose: 'ws.sub',
    traceId: base.traceId,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('entitlements/accessLog — ENTL-04 ring buffer, REG-01 WORM', () => {
  const t = withTxDb();

  it('writes one row per field read, carrying the decision and the reason', async () => {
    const clock = testClock();
    const { userId, firmId } = await seedPrincipal(t);
    const instrument = await seedQuoteInstrument(t, { ticker: `ALG${randomUUID().slice(0, 4)}` });
    const sessionId = randomUUID();
    const traceId = randomUUID();
    const base = { userId, firmId, sessionId, instrumentId: instrument.instrumentId, traceId };

    const log = accessLog({ db: t.db, clock });

    // One evaluation of three fields: an allow, a licence-capped downgrade and a deny.
    const ids = [
      log.append(row(base, { fieldId: 'PX_LAST', decision: 'allow', reason: 'OK' })),
      log.append(
        row(base, {
          fieldId: 'PX_BID',
          decision: 'downgrade',
          reason: 'SOURCE_TIER_CAP',
          requestedTier: 'realtime',
          tier: 'delayed',
        }),
      ),
      log.append(
        row(base, {
          fieldId: 'PX_VOLUME',
          decision: 'deny',
          reason: 'NO_USER_ENTITLEMENT',
          tier: null,
        }),
      ),
    ];

    // `append` is synchronous and writes nothing: the request path never waits on the audit log.
    expect(ids).toEqual([1, 2, 3]);
    expect(log.size()).toBe(3);
    expect(await countFor(t, userId)).toBe(0);

    expect(await log.flush()).toBe(3);
    expect(log.size()).toBe(0);
    expect(log.stats()).toEqual({ buffered: 0, written: 3, flushes: 1, dropped: 0 });

    const written = await t.client.query<{
      field_id: string;
      field_class: string;
      source_id: string;
      requested_tier: string;
      tier: string | null;
      usage: string;
      purpose: string;
      decision: string;
      reason: string;
      session_id: string;
      trace_id: string;
      instrument_id: string;
      firm_id: string;
      ts: Date;
      partition: string;
    }>(
      `SELECT field_id, field_class, source_id, requested_tier, tier, usage, purpose, decision,
              reason, session_id::text AS session_id, trace_id::text AS trace_id,
              instrument_id::text AS instrument_id, firm_id::text AS firm_id, ts,
              tableoid::regclass::text AS partition
         FROM access_log WHERE user_id = $1 ORDER BY field_id`,
      [userId],
    );
    expect(written.rows.map((r) => [r.field_id, r.decision, r.reason])).toEqual([
      ['PX_BID', 'downgrade', 'SOURCE_TIER_CAP'],
      ['PX_LAST', 'allow', 'OK'],
      ['PX_VOLUME', 'deny', 'NO_USER_ENTITLEMENT'],
    ]);

    // Tiers: the downgrade records what was asked for AND what was granted; the deny grants none.
    const byField = new Map(written.rows.map((r) => [r.field_id, r]));
    expect(byField.get('PX_BID')!.requested_tier).toBe('realtime');
    expect(byField.get('PX_BID')!.tier).toBe('delayed');
    expect(byField.get('PX_VOLUME')!.tier).toBeNull();

    // Every column ARCHITECTURE §10 rule 9 names is present on every row.
    for (const r of written.rows) {
      expect(r.firm_id).toBe(String(firmId));
      expect(r.instrument_id).toBe(String(instrument.instrumentId));
      expect(r.session_id).toBe(sessionId);
      expect(r.trace_id).toBe(traceId);
      expect(r.field_class).toBe('price');
      expect(r.source_id).toBe('cboe.quotes');
      expect(r.usage).toBe('display');
      expect(r.purpose).toBe('ws.sub');
      expect(r.ts.toISOString()).toBe(new Date(TEST_NOW).toISOString());
      // The month partition of migration 0016, not `access_log_default`.
      expect(r.partition).toBe('access_log_m2026_09');
    }
  });

  it('flushes on the 1 s timer tick and leaves an empty buffer alone', async () => {
    const clock = testClock();
    const { userId, firmId } = await seedPrincipal(t);
    const base = {
      userId,
      firmId,
      sessionId: randomUUID(),
      instrumentId: 1,
      traceId: randomUUID(),
    };
    const timers = manualTimers();
    const log = accessLog({ db: t.db, clock, timers });

    log.start();
    expect(timers.armed).toBe(true);
    expect(timers.armedMs).toBe(1_000); // ENTL-04

    for (let i = 0; i < 7; i++) {
      log.append(row(base, { fieldId: `PX_T${String(i)}`, decision: 'allow', reason: 'OK' }));
    }
    expect(await countFor(t, userId)).toBe(0);

    // Nothing but the tick writes these rows: `flush()` is never called by this test.
    timers.fire();
    await awaitRows(() => countFor(t, userId), 7, 'after the first tick');
    await sleep(25); // let the writer's own bookkeeping settle behind the rows it wrote
    expect(log.stats()).toEqual({ buffered: 0, written: 7, flushes: 1, dropped: 0 });

    // A tick on an empty buffer is not a flush — it must not cost a transaction per second.
    timers.fire();
    await sleep(20);
    expect(log.stats().flushes).toBe(1);
    expect(await countFor(t, userId)).toBe(7);

    await log.stop();
    expect(timers.armed).toBe(false);
  });

  it('flushes eagerly at 5 000 buffered rows, without a timer', async () => {
    const clock = testClock();
    const { userId, firmId } = await seedPrincipal(t);
    const base = {
      userId,
      firmId,
      sessionId: randomUUID(),
      instrumentId: 2,
      traceId: randomUUID(),
    };
    // No `start()`: the only thing that can write here is the 5 000-row threshold.
    const log = accessLog({ db: t.db, clock });

    for (let i = 0; i < 4_999; i++) {
      log.append(row(base, { fieldId: `PX_B${String(i)}`, decision: 'allow', reason: 'OK' }));
    }
    expect(log.size()).toBe(4_999);
    expect(await countFor(t, userId)).toBe(0);

    log.append(row(base, { fieldId: 'PX_B4999', decision: 'allow', reason: 'OK' }));
    await awaitRows(() => countFor(t, userId), 5_000, 'after the 5 000th append');
    await sleep(25);
    expect(log.stats().written).toBe(5_000);
    expect(log.stats().flushes).toBe(1);

    // The 5 001st row waits: one row over the mark is not another flush.
    log.append(row(base, { fieldId: 'PX_TAIL', decision: 'deny', reason: 'QUOTA_EXCEEDED' }));
    await sleep(20);
    expect(log.size()).toBe(1);
    expect(await countFor(t, userId)).toBe(5_000);

    // `stop()` is the final flush.
    await log.stop();
    expect(await countFor(t, userId)).toBe(5_001);
    expect(log.stats()).toEqual({ buffered: 0, written: 5_001, flushes: 2, dropped: 0 });
  });

  it('is append-only: UPDATE and DELETE are rejected, by the trigger and by the grants (REG-01)', async () => {
    const clock = testClock();
    const { userId, firmId } = await seedPrincipal(t);
    const log = accessLog({ db: t.db, clock });
    log.append(
      row(
        { userId, firmId, sessionId: randomUUID(), instrumentId: 3, traceId: randomUUID() },
        { fieldId: 'PX_LAST', decision: 'allow', reason: 'OK' },
      ),
    );
    expect(await log.flush()).toBe(1);

    // 1. The `access_log_worm` trigger of migration 0015 — defence in depth that even the owning
    //    superuser cannot step around, which is the point of writing it as a trigger. It is a
    //    BEFORE ROW trigger on the partitioned parent, so it fires on the PARTITION the row lives
    //    in and names it: the September 2026 partition, which is where `TEST_NOW` put the row.
    const asOwner = await attempt(
      t,
      `UPDATE access_log SET reason = 'OK' WHERE user_id = ${String(userId)}`,
    );
    expect(asOwner.code).toBe('P0001');
    expect(asOwner.message).toContain('table access_log_m2026_09 is append-only (WORM)');

    const deleteAsOwner = await attempt(
      t,
      `DELETE FROM access_log WHERE user_id = ${String(userId)}`,
    );
    expect(deleteAsOwner.code).toBe('P0001');
    expect(deleteAsOwner.message).toContain('table access_log_m2026_09 is append-only (WORM)');

    // 2. The shipped grants: `terminal_app` — the role the application actually connects as — holds
    //    SELECT and INSERT on `access_log` and nothing else, so it is stopped one layer earlier,
    //    by privilege rather than by trigger (42501). Asserted under the real role, not the
    //    superuser the local owner is.
    await asAppRole(t);
    expect(await countFor(t, userId)).toBe(1); // SELECT is granted; INSERT is what the writer uses

    const update = await attempt(
      t,
      `UPDATE access_log SET reason = 'OK' WHERE user_id = ${String(userId)}`,
    );
    expect(update.code).toBe('42501');
    expect(update.message).toContain('permission denied for table access_log');

    const remove = await attempt(t, `DELETE FROM access_log WHERE user_id = ${String(userId)}`);
    expect(remove.code).toBe('42501');
    expect(remove.message).toContain('permission denied for table access_log');

    // The row is still there, under both roles.
    expect(await countFor(t, userId)).toBe(1);
    await t.client.query('RESET ROLE');
    expect(await countFor(t, userId)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers that need `TestDb`
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function countFor(t: TestDb, userId: number): Promise<number> {
  const res = await t.client.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM access_log WHERE user_id = $1',
    [userId],
  );
  return Number(res.rows[0]!.n);
}

/**
 * Run `statement` inside a savepoint and return the error it raised. A statement that succeeds is
 * itself the failure: it means the WORM guard is gone.
 */
async function attempt(t: TestDb, statement: string): Promise<{ code: string; message: string }> {
  try {
    await t.savepoint(async () => {
      await t.client.query(statement);
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code ?? '', message: e.message ?? '' };
  }
  throw new Error(`access_log accepted "${statement}" — the WORM guard is gone (REG-01)`);
}
