/**
 * WORKPLAN WP-08 acceptance row — `test/integration/observability/usage.test.ts`: "one row per
 * launch/param/page/export, `params_hash` stability, the client batch route (FUNCTIONS §8 row)".
 *
 * Covered here:
 *  - one `usage_events` row per launch, param change, page and export, with the columns
 *    ARCHITECTURE §11 L1215 names, landing in the month partition `ts` selects;
 *  - `params_hash` is `sha256Hex(canonicalJson(params))` — asserted against a sha256 this file
 *    computes itself with `node:crypto` over a hand-written canonical string, so the test does not
 *    simply agree with the implementation it is testing; stable across runs and across key order,
 *    different when a parameter changes;
 *  - the twelve-value `usage_events_kind_check`: the constraint in Postgres and the
 *    `USAGE_EVENT_KINDS` array are the same twelve, a thirteenth kind is rejected by `enqueue()`
 *    *before* it can reach the database, and Postgres rejects it too if it ever did;
 *  - the batch reaches Postgres on the 1 s timer tick and at `maxRows`, measured by counting rows
 *    in the table, never by trusting a boolean the writer reports.
 *
 * Everything is self-sufficient: the firm and the user are created inside this file's own
 * `withTxDb()` transaction, which is also the writer's database handle, so its flushes are
 * savepoints inside the test transaction and the rollback takes them with it. Time is the virtual
 * clock's: `TEST_NOW` (2026-09-17T13:30Z) lands in `usage_events_m2026_09`, one of the three
 * monthly partitions migration 0016 ships.
 *
 * The client batch route (`POST /usage/events`) is WP-07's `http/routes/usage.ts` and is proved by
 * `test/integration/entitlements/routes.test.ts`; this file owns the server-side writer.
 */

import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  isUsageEventKind,
  insertRow,
  paramsHash,
  usageEvents,
  USAGE_EVENT_KINDS,
  type UsageEventRow,
  type UsageEventTimers,
} from '../../../src/observability/usageEvents.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { testClock, TEST_NOW } from '../../../src/test/clock.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Principal {
  userId: number;
  firmId: number;
  sessionId: string;
  traceId: string;
}

async function seedPrincipal(t: TestDb): Promise<Principal> {
  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Usage Events Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'Usage Events User', 'user') RETURNING user_id`,
    [firmId, `usage-${randomUUID()}@demo.invalid`],
  );
  return {
    userId: Number(user.rows[0]!.user_id),
    firmId,
    sessionId: randomUUID(),
    traceId: randomUUID(),
  };
}

/** A manual timers port: the test decides when the flush tick fires. */
interface ManualTimers extends UsageEventTimers {
  fire(): void;
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

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function countFor(t: TestDb, userId: number): Promise<number> {
  const res = await t.client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM usage_events WHERE user_id = $1`,
    [userId],
  );
  return Number(res.rows[0]!.n);
}

/** Re-run `count()` until it reports `want`, on a bounded loop (100 × 20 ms ≈ 2 s). */
async function awaitRows(count: () => Promise<number>, want: number, what: string): Promise<void> {
  let last = -1;
  for (let i = 0; i < 100; i++) {
    last = await count();
    if (last === want) return;
    await sleep(20);
  }
  throw new Error(`${what}: usage_events holds ${String(last)} rows, expected ${String(want)}`);
}

function row(
  p: Principal,
  over: Partial<UsageEventRow> & Pick<UsageEventRow, 'kind'>,
): UsageEventRow {
  return {
    ts: TEST_NOW,
    userId: p.userId,
    firmId: p.firmId,
    sessionId: p.sessionId,
    traceId: p.traceId,
    ...over,
  };
}

/**
 * sha256 of a string, computed with `node:crypto` — a completely different implementation from
 * `@terminal/core`'s pure-TypeScript `sha256Hex`, which is the point.
 */
function sha256OfString(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('observability/usageEvents — FUNC-04 batched writer', () => {
  const t = withTxDb();

  it('writes one row per launch, param change, page and export', async () => {
    const clock = testClock();
    const p = await seedPrincipal(t);
    const writer = usageEvents({ db: t.db, clock });

    const params = { range: '1Y', ticker: 'AAPL' };
    const changed = { range: '5Y', ticker: 'AAPL' };
    const hash = paramsHash(params);
    const changedHash = paramsHash(changed);

    const handles = [
      writer.enqueue(
        row(p, {
          kind: 'fn.launch',
          code: 'DES',
          paramsHash: hash,
          instrumentId: 4242,
          panelId: 'p1',
          durationMs: 37,
        }),
      ),
      writer.enqueue(
        row(p, {
          kind: 'fn.param',
          code: 'DES',
          paramsHash: changedHash,
          instrumentId: 4242,
          panelId: 'p1',
          durationMs: 11,
        }),
      ),
      writer.enqueue(
        row(p, {
          kind: 'fn.page',
          code: 'DES',
          paramsHash: changedHash,
          instrumentId: 4242,
          panelId: 'p1',
          details: { direction: 'next' },
        }),
      ),
      writer.enqueue(
        row(p, {
          kind: 'fn.export',
          code: 'DES',
          paramsHash: changedHash,
          instrumentId: 4242,
          panelId: 'p1',
          details: { rows: 120 },
        }),
      ),
    ];

    // `enqueue` is synchronous and writes nothing: the request path never waits on analytics.
    expect(handles).toEqual([1, 2, 3, 4]);
    expect(writer.size()).toBe(4);
    expect(await countFor(t, p.userId)).toBe(0);

    expect(await writer.flush()).toBe(4);
    expect(writer.size()).toBe(0);
    expect(writer.stats()).toEqual({ buffered: 0, written: 4, flushes: 1, dropped: 0 });

    const written = await t.client.query<{
      kind: string;
      code: string | null;
      params_hash: string | null;
      panel_id: string | null;
      instrument_id: string | null;
      duration_ms: number | null;
      session_id: string | null;
      trace_id: string | null;
      firm_id: string;
      ts: Date;
      details: Record<string, unknown>;
      partition: string;
    }>(
      `SELECT kind, code, params_hash, panel_id, instrument_id::text AS instrument_id, duration_ms,
              session_id::text AS session_id, trace_id::text AS trace_id, firm_id::text AS firm_id,
              ts, details, tableoid::regclass::text AS partition
         FROM usage_events WHERE user_id = $1 ORDER BY kind`,
      [p.userId],
    );

    expect(written.rows.map((r) => r.kind)).toEqual([
      'fn.export',
      'fn.launch',
      'fn.page',
      'fn.param',
    ]);

    const byKind = new Map(written.rows.map((r) => [r.kind, r]));
    expect(byKind.get('fn.launch')!.params_hash).toBe(hash);
    expect(byKind.get('fn.param')!.params_hash).toBe(changedHash);
    expect(byKind.get('fn.launch')!.duration_ms).toBe(37);
    expect(byKind.get('fn.page')!.details).toEqual({ direction: 'next' });
    expect(byKind.get('fn.export')!.details).toEqual({ rows: 120 });

    for (const r of written.rows) {
      expect(r.code).toBe('DES');
      expect(r.panel_id).toBe('p1');
      expect(r.instrument_id).toBe('4242');
      expect(r.firm_id).toBe(String(p.firmId));
      expect(r.session_id).toBe(p.sessionId);
      expect(r.trace_id).toBe(p.traceId);
      expect(r.ts.toISOString()).toBe(new Date(TEST_NOW).toISOString());
      // The month partition of migration 0016, not `usage_events_default`.
      expect(r.partition).toBe('usage_events_m2026_09');
    }

    // The ARCHITECTURE §11 roadmap query sees exactly the one launch.
    const roadmap = await t.client.query<{ code: string; n: string }>(
      `SELECT code, count(*)::text AS n FROM usage_events
        WHERE kind = 'fn.launch' AND user_id = $1 GROUP BY 1`,
      [p.userId],
    );
    expect(roadmap.rows).toEqual([{ code: 'DES', n: '1' }]);
  });

  it('hashes params as sha256(canonicalJson(params)): stable, order-free and change-sensitive', () => {
    const params = { range: '1Y', ticker: 'AAPL' };

    // Canonical JSON sorts keys and emits no whitespace — written out by hand here, hashed with
    // node:crypto, and compared with what the writer produces.
    const canonical = '{"range":"1Y","ticker":"AAPL"}';
    const expected = sha256OfString(canonical);
    expect(expected).toBe('ac0393117417412b5a1e926659d12edfb46e3b9783b543013ade9316fc5c399a');
    expect(paramsHash(params)).toBe(expected);

    // Stable across runs: the same input, twice, is the same 64 hex characters.
    expect(paramsHash(params)).toBe(paramsHash({ range: '1Y', ticker: 'AAPL' }));
    // Key order is not part of the identity of a parameter set.
    expect(paramsHash({ ticker: 'AAPL', range: '1Y' })).toBe(expected);
    // A changed parameter is a different hash.
    expect(paramsHash({ range: '5Y', ticker: 'AAPL' })).not.toBe(expected);
    expect(paramsHash({ range: '1Y', ticker: 'MSFT' })).not.toBe(expected);
  });

  it('enforces the twelve-value kind CHECK before a row can reach Postgres', async () => {
    const clock = testClock();
    const p = await seedPrincipal(t);

    // The constraint in the database and the array in the module are the same twelve values.
    const constraint = await t.client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'usage_events'::regclass AND conname = 'usage_events_kind_check'`,
    );
    const def = constraint.rows[0]!.def;
    const inConstraint = [...def.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(new Set(inConstraint)).toEqual(new Set(USAGE_EVENT_KINDS));
    expect(USAGE_EVENT_KINDS).toHaveLength(12);
    expect(inConstraint).toHaveLength(12);

    const writer = usageEvents({ db: t.db, clock });
    writer.enqueue(row(p, { kind: 'fn.launch', code: 'DES' }));

    // A thirteenth kind is refused at the call site, and the buffer is untouched — one careless
    // caller cannot poison the batch that carries everybody else's rows.
    const bad = {
      ...row(p, { kind: 'fn.launch' }),
      kind: 'fn.explode',
    } as unknown as UsageEventRow;
    expect(() => writer.enqueue(bad)).toThrow(/not one of the twelve values/);
    expect(() => insertRow(bad)).toThrow(RangeError);
    expect(writer.size()).toBe(1);
    expect(isUsageEventKind('fn.explode')).toBe(false);
    for (const kind of USAGE_EVENT_KINDS) expect(isUsageEventKind(kind)).toBe(true);

    // The surviving row still writes.
    expect(await writer.flush()).toBe(1);
    expect(await countFor(t, p.userId)).toBe(1);

    // And Postgres would have rejected it too, which is why it is caught above.
    await expect(
      t.savepoint(async () => {
        await t.client.query(
          `INSERT INTO usage_events (ts, user_id, firm_id, kind)
           VALUES (to_timestamp($1 / 1000.0), $2, $3, 'fn.explode')`,
          [TEST_NOW, p.userId, p.firmId],
        );
      }),
    ).rejects.toThrow(/usage_events_kind_check/);

    // A malformed paramsHash is refused for the same reason (the column is the join key of the
    // roadmap query; a 10-character "hash" is worse than no row).
    expect(() =>
      writer.enqueue(row(p, { kind: 'fn.launch', code: 'DES', paramsHash: 'not-a-hash' })),
    ).toThrow(/64 lower-case hex/);
  });

  it('flushes on the 1 s timer tick and at maxRows, counted in the table', async () => {
    const clock = testClock();
    const p = await seedPrincipal(t);
    const timers = manualTimers();
    const writer = usageEvents({ db: t.db, clock, timers, maxRows: 50 });

    writer.start();
    expect(timers.armed).toBe(true);
    expect(timers.armedMs).toBe(1_000);

    // ── the timer ───────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < 7; i++) {
      writer.enqueue(row(p, { kind: 'search.select', details: { i } }));
    }
    expect(writer.size()).toBe(7);
    expect(await countFor(t, p.userId)).toBe(0);

    // Nothing but the tick writes these rows: `flush()` is never called by this test.
    timers.fire();
    await awaitRows(() => countFor(t, p.userId), 7, 'after the first tick');

    // An empty buffer does not produce an empty flush.
    const afterFirst = writer.stats().flushes;
    timers.fire();
    await sleep(20);
    expect(writer.stats().flushes).toBe(afterFirst);

    // ── maxRows ─────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < 50; i++) {
      writer.enqueue(row(p, { kind: 'panel.switch', panelId: `p${String(i)}` }));
    }
    // The 50th `enqueue` crossed the threshold and started a flush nobody awaited.
    await awaitRows(() => countFor(t, p.userId), 57, 'after the maxRows trigger');
    expect(writer.size()).toBe(0);

    await writer.stop();
    expect(timers.armed).toBe(false);
    expect(writer.stats()).toMatchObject({ buffered: 0, written: 57, dropped: 0 });

    const kinds = await t.client.query<{ kind: string; n: string }>(
      `SELECT kind, count(*)::text AS n FROM usage_events WHERE user_id = $1 GROUP BY 1 ORDER BY 1`,
      [p.userId],
    );
    expect(kinds.rows).toEqual([
      { kind: 'panel.switch', n: '50' },
      { kind: 'search.select', n: '7' },
    ]);
  });

  it('keeps a malformed uuid out of the columns and preserves it in details', async () => {
    const clock = testClock();
    const p = await seedPrincipal(t);
    const writer = usageEvents({ db: t.db, clock });

    writer.enqueue({
      ts: TEST_NOW,
      userId: p.userId,
      firmId: p.firmId,
      sessionId: 'not-a-uuid',
      traceId: 'also-not-a-uuid',
      kind: 'ticket.open',
    });
    expect(await writer.flush()).toBe(1);

    const res = await t.client.query<{
      session_id: string | null;
      trace_id: string | null;
      details: Record<string, unknown>;
    }>(
      `SELECT session_id::text AS session_id, trace_id::text AS trace_id, details
         FROM usage_events WHERE user_id = $1`,
      [p.userId],
    );
    expect(res.rows[0]!.session_id).toBeNull();
    expect(res.rows[0]!.trace_id).toBeNull();
    expect(res.rows[0]!.details).toEqual({
      _sessionId: 'not-a-uuid',
      _traceId: 'also-not-a-uuid',
    });
  });
});
