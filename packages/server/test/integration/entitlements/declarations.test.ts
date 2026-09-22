/**
 * WORKPLAN WP-07 acceptance row — `test/integration/entitlements/declarations.test.ts`: "ENTL-06:
 * the generated `usage_declarations` row reconciles with `firms.seat_count` and records
 * `query_sql_hash`".
 *
 * The declaration is a bill. Every number in it is a number a vendor may audit, so this file does
 * not check that the generator agrees with itself: it seeds twenty `access_log` rows whose contents
 * are written out one line at a time below, counts the five expected declaration rows **by hand**
 * in the comments next to the fixture, and asserts those literals. If the aggregate changes shape,
 * the hand count is what disagrees with it.
 *
 * The fixture is built to exercise every way a row can fail to be counted, not just the happy path:
 *
 *  * a `deny` (tier NULL) — nothing was served, so nothing may be declared;
 *  * a row one millisecond before the month and one exactly at the start of the next month — the
 *    window is half-open `[first, next)`, and an inclusive upper bound would double-count a
 *    month's first instant in two declarations;
 *  * a `downgrade` — counted, at the tier that was **served**, not the tier that was asked for;
 *  * a NULL `instrument_id` (a non-instrument read) — a data point, but not an instrument;
 *  * a second `field_class` and a second `tier` on the same source and firm — the declaration key
 *    is `(source, firm, field class, tier)`, and a generator that dropped either would fold four
 *    rows into two.
 *
 * Self-sufficient: the two firms, the four users and every log row are created inside this file's
 * own `withTxDb()` transaction, which is also the handle the generator writes through, so the whole
 * fixture — and the `usage_declarations` and `ingest_runs` rows it produces — rolls back. Instrument
 * ids are plain integers: `access_log.instrument_id` carries no foreign key, because it records what
 * a user looked at rather than what still exists.
 */

import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  declarationQuerySql,
  generateDeclarations,
  listDeclarations,
  reconcileDeclaration,
  verifyDeclarationHash,
} from '../../../src/entitlements/declarations.js';
import {
  USAGE_DECLARATIONS_JOB_ID,
  runUsageDeclarations,
} from '../../../src/ingest/jobs/usageDeclarations.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

const t: TestDb = withTxDb();

/** The declared month. August 2026 has no shipped partition, so the fixture lands in the default. */
const MONTH = '2026-08';
const MONTH_FIRST = '2026-08-01';

interface Fixture {
  firmA: number;
  firmB: number;
  u1: number;
  u2: number;
  u3: number;
  u4: number;
  u5: number;
}

async function firm(name: string, seatCount: number): Promise<number> {
  const row = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name, seat_count) VALUES ($1, $2) RETURNING firm_id`,
    [`${name} ${randomUUID().slice(0, 8)}`, seatCount],
  );
  return Number(row.rows[0]!.firm_id);
}

async function user(firmId: number, label: string): Promise<number> {
  const row = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, $3, 'user') RETURNING user_id`,
    [firmId, `decl-${randomUUID()}@demo.invalid`, label],
  );
  return Number(row.rows[0]!.user_id);
}

interface LogRow {
  ts: string;
  userId: number;
  firmId: number;
  sourceId: string;
  fieldClass: 'price' | 'reference';
  requestedTier: 'eod' | 'delayed' | 'realtime';
  tier: 'eod' | 'delayed' | 'realtime' | null;
  usage: 'display' | 'export' | 'api';
  decision: 'allow' | 'downgrade' | 'deny';
  instrumentId: number | null;
}

async function log(row: LogRow): Promise<void> {
  await t.client.query(
    `INSERT INTO access_log (ts, user_id, firm_id, session_id, instrument_id, field_id,
                             field_class, source_id, requested_tier, tier, usage, purpose,
                             decision, reason, trace_id)
     VALUES ($1::timestamptz, $2, $3, $4::uuid, $5, 'PX_LAST', $6::field_class, $7,
             $8::tier, $9::tier, $10::usage_type, 'test.declarations', $11::entl_decision,
             $12, $13::uuid)`,
    [
      row.ts,
      row.userId,
      row.firmId,
      randomUUID(),
      row.instrumentId,
      row.fieldClass,
      row.sourceId,
      row.requestedTier,
      row.tier,
      row.usage,
      row.decision,
      row.decision === 'deny' ? 'NO_USER_ENTITLEMENT' : 'OK',
      randomUUID(),
    ],
  );
}

/**
 * The fixture, written out row by row. The expectation block under each group is the hand count
 * this file asserts; nothing here is derived from the query under test.
 */
async function seed(): Promise<Fixture> {
  const firmA = await firm('Demo Capital', 3);
  const firmB = await firm('Other Desk', 1);
  const u1 = await user(firmA, 'Alice');
  const u2 = await user(firmA, 'Bob');
  const u3 = await user(firmB, 'Carol');
  const u4 = await user(firmB, 'Dan');
  const u5 = await user(firmA, 'Erin');

  const q = 'cboe.quotes';
  const y = 'yahoo.chart';
  const aug = (day: number, hour = 12): string =>
    `2026-08-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

  // ── Group A — (cboe.quotes, firmA, price, delayed) ────────────────────────────────────────
  // display users {u1, u2} = 2 · export {u1, u5} = 2 · api {u2} = 1 · distinct {u1, u2, u5} = 3
  // instruments {101, 102, 103} = 3 · data points = 9
  //
  // u5 only ever exports, so `display_users` (2) is strictly less than `distinct_users` (3) — a
  // generator that dropped the `FILTER (WHERE usage = …)` and counted every user on every column
  // would over-declare display use to the exchange, and this is the row that catches it.
  await log({
    ts: aug(1),
    userId: u1,
    firmId: firmA,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'display',
    decision: 'allow',
    instrumentId: 101,
  });
  await log({
    ts: aug(2),
    userId: u1,
    firmId: firmA,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'display',
    decision: 'allow',
    instrumentId: 101,
  });
  await log({
    ts: aug(3),
    userId: u1,
    firmId: firmA,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'display',
    decision: 'allow',
    instrumentId: 101,
  });
  await log({
    ts: aug(4),
    userId: u1,
    firmId: firmA,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'export',
    decision: 'allow',
    instrumentId: 102,
  });
  await log({
    ts: aug(5),
    userId: u2,
    firmId: firmA,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'display',
    decision: 'allow',
    instrumentId: 101,
  });
  await log({
    ts: aug(6),
    userId: u2,
    firmId: firmA,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'display',
    decision: 'allow',
    instrumentId: 101,
  });
  // A downgrade: asked for realtime, was served delayed. Declared against `delayed`.
  await log({
    ts: aug(7),
    userId: u2,
    firmId: firmA,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'realtime',
    tier: 'delayed',
    usage: 'display',
    decision: 'downgrade',
    instrumentId: 103,
  });
  await log({
    ts: aug(8),
    userId: u2,
    firmId: firmA,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'api',
    decision: 'allow',
    instrumentId: 103,
  });

  await log({
    ts: aug(19),
    userId: u5,
    firmId: firmA,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'export',
    decision: 'allow',
    instrumentId: 102,
  });

  // ── Group B — (cboe.quotes, firmA, price, realtime) ───────────────────────────────────────
  // display {u1} = 1 · export 0 · api 0 · distinct 1 · instruments {101} = 1 · data points = 1
  await log({
    ts: aug(9),
    userId: u1,
    firmId: firmA,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'realtime',
    tier: 'realtime',
    usage: 'display',
    decision: 'allow',
    instrumentId: 101,
  });

  // ── Group C — (yahoo.chart, firmA, price, eod) ────────────────────────────────────────────
  // display {u2} = 1 · distinct 1 · instruments {104} = 1 (the NULL is a data point, not an
  // instrument) · data points = 3
  await log({
    ts: aug(10),
    userId: u2,
    firmId: firmA,
    sourceId: y,
    fieldClass: 'price',
    requestedTier: 'eod',
    tier: 'eod',
    usage: 'display',
    decision: 'allow',
    instrumentId: 104,
  });
  await log({
    ts: aug(11),
    userId: u2,
    firmId: firmA,
    sourceId: y,
    fieldClass: 'price',
    requestedTier: 'eod',
    tier: 'eod',
    usage: 'display',
    decision: 'allow',
    instrumentId: 104,
  });
  await log({
    ts: aug(12),
    userId: u2,
    firmId: firmA,
    sourceId: y,
    fieldClass: 'price',
    requestedTier: 'eod',
    tier: 'eod',
    usage: 'display',
    decision: 'allow',
    instrumentId: null,
  });

  // ── Group D — (cboe.quotes, firmB, price, delayed) ────────────────────────────────────────
  // display {u3, u4} = 2 · export 0 · api {u3} = 1 · distinct {u3, u4} = 2
  // instruments {101, 105} = 2 · data points = 4 · firmB has ONE seat: this row does not reconcile.
  await log({
    ts: aug(13),
    userId: u3,
    firmId: firmB,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'display',
    decision: 'allow',
    instrumentId: 101,
  });
  await log({
    ts: aug(14),
    userId: u3,
    firmId: firmB,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'api',
    decision: 'allow',
    instrumentId: 105,
  });
  await log({
    ts: aug(15),
    userId: u3,
    firmId: firmB,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'api',
    decision: 'allow',
    instrumentId: 105,
  });
  await log({
    ts: aug(16),
    userId: u4,
    firmId: firmB,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'display',
    decision: 'allow',
    instrumentId: 105,
  });

  // ── Group E — (cboe.quotes, firmA, reference, delayed) ────────────────────────────────────
  // A second field class on a key that otherwise matches group A.
  // display {u1} = 1 · distinct 1 · instruments {106} = 1 · data points = 1
  await log({
    ts: aug(17),
    userId: u1,
    firmId: firmA,
    sourceId: q,
    fieldClass: 'reference',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'display',
    decision: 'allow',
    instrumentId: 106,
  });

  // ── Not counted ──────────────────────────────────────────────────────────────────────────
  // A deny served nothing and has no tier to declare.
  await log({
    ts: aug(18),
    userId: u1,
    firmId: firmA,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'realtime',
    tier: null,
    usage: 'display',
    decision: 'deny',
    instrumentId: 101,
  });
  // A deny whose `tier` column disagrees with its decision — a malformed writer. Both predicates
  // of the aggregate are written out rather than assumed, and this row proves the `decision` one
  // carries its own weight: counted, it would add a fourth distinct user and a second api user to
  // group A.
  await log({
    ts: aug(20),
    userId: u5,
    firmId: firmA,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'api',
    decision: 'deny',
    instrumentId: 107,
  });
  // One millisecond before the month, and the first instant of the next one.
  await log({
    ts: '2026-07-31T23:59:59.999Z',
    userId: u1,
    firmId: firmA,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'display',
    decision: 'allow',
    instrumentId: 101,
  });
  await log({
    ts: '2026-09-01T00:00:00.000Z',
    userId: u1,
    firmId: firmA,
    sourceId: q,
    fieldClass: 'price',
    requestedTier: 'delayed',
    tier: 'delayed',
    usage: 'display',
    decision: 'allow',
    instrumentId: 101,
  });

  return { firmA, firmB, u1, u2, u3, u4, u5 };
}

function clockAt(iso = '2026-09-02T07:20:00.000Z'): VirtualClock {
  return testClock(iso);
}

interface Counts {
  displayUsers: number;
  exportUsers: number;
  apiUsers: number;
  distinctUsers: number;
  instrumentCount: number;
  dataPoints: number;
  seatCount: number;
}

/** The hand count of each group, keyed `source|firm|fieldClass|tier`. */
function expected(f: Fixture): Record<string, Counts> {
  return {
    [`cboe.quotes|${String(f.firmA)}|price|delayed`]: {
      displayUsers: 2,
      exportUsers: 2,
      apiUsers: 1,
      distinctUsers: 3,
      instrumentCount: 3,
      dataPoints: 9,
      seatCount: 3,
    },
    [`cboe.quotes|${String(f.firmA)}|price|realtime`]: {
      displayUsers: 1,
      exportUsers: 0,
      apiUsers: 0,
      distinctUsers: 1,
      instrumentCount: 1,
      dataPoints: 1,
      seatCount: 3,
    },
    [`yahoo.chart|${String(f.firmA)}|price|eod`]: {
      displayUsers: 1,
      exportUsers: 0,
      apiUsers: 0,
      distinctUsers: 1,
      instrumentCount: 1,
      dataPoints: 3,
      seatCount: 3,
    },
    [`cboe.quotes|${String(f.firmB)}|price|delayed`]: {
      displayUsers: 2,
      exportUsers: 0,
      apiUsers: 1,
      distinctUsers: 2,
      instrumentCount: 2,
      dataPoints: 4,
      seatCount: 1,
    },
    [`cboe.quotes|${String(f.firmA)}|reference|delayed`]: {
      displayUsers: 1,
      exportUsers: 0,
      apiUsers: 0,
      distinctUsers: 1,
      instrumentCount: 1,
      dataPoints: 1,
      seatCount: 3,
    },
  };
}

function key(row: { sourceId: string; firmId: number; fieldClass: string; tier: string }): string {
  return `${row.sourceId}|${String(row.firmId)}|${row.fieldClass}|${row.tier}`;
}

/** The declarations this test's own fixture produced — other tests' firms are not ours to count. */
function mine(rows: readonly { firmId: number }[], f: Fixture): readonly { firmId: number }[] {
  return rows.filter((r) => r.firmId === f.firmA || r.firmId === f.firmB);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The counted columns
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('generateDeclarations — every counted column', () => {
  it('produces one row per (source, firm, field class, tier) with the hand-counted values', async () => {
    const f = await seed();
    const result = await generateDeclarations({ db: t.db, clock: clockAt() }, MONTH);

    const ours = result.rows.filter((r) => r.firmId === f.firmA || r.firmId === f.firmB);
    const want = expected(f);
    expect(ours.map(key).sort()).toEqual(Object.keys(want).sort());

    for (const row of ours) {
      const counts = want[key(row)];
      expect(counts, `unexpected declaration group ${key(row)}`).toBeDefined();
      expect(
        {
          displayUsers: row.displayUsers,
          exportUsers: row.exportUsers,
          apiUsers: row.apiUsers,
          distinctUsers: row.distinctUsers,
          instrumentCount: row.instrumentCount,
          dataPoints: row.dataPoints,
          seatCount: row.seatCount,
        },
        `declaration ${key(row)}`,
      ).toEqual(counts);
      expect(row.month).toBe(MONTH_FIRST);
      expect(row.wasInserted).toBe(true);
    }
  });

  it('excludes a deny, and declares the downgrade at the tier that was served', async () => {
    const f = await seed();
    const result = await generateDeclarations({ db: t.db, clock: clockAt() }, MONTH);

    // The only realtime row of firmA is the allowed one; the deny (requested realtime, tier NULL)
    // produced no group of its own and did not inflate the delayed group either.
    const realtime = result.rows.find(
      (r) => key(r) === `cboe.quotes|${String(f.firmA)}|price|realtime`,
    );
    expect(realtime?.dataPoints).toBe(1);

    // The downgrade is one of the delayed group's nine data points and u2's second display use;
    // the malformed deny (decision 'deny' with a tier) is none of them.
    const delayed = result.rows.find(
      (r) => key(r) === `cboe.quotes|${String(f.firmA)}|price|delayed`,
    );
    expect(delayed?.dataPoints).toBe(9);
    expect(delayed?.displayUsers).toBe(2);
    expect(delayed?.distinctUsers).toBe(3);
    expect(delayed?.apiUsers).toBe(1);
  });

  it('counts the month half-open: the row before it and the first instant of the next are out', async () => {
    const f = await seed();
    const august = await generateDeclarations({ db: t.db, clock: clockAt() }, MONTH);
    const delayed = august.rows.find(
      (r) => key(r) === `cboe.quotes|${String(f.firmA)}|price|delayed`,
    );
    expect(delayed?.dataPoints).toBe(9); // not 10, not 11

    // Each neighbouring month sees exactly the one row that August refused.
    const july = await generateDeclarations({ db: t.db, clock: clockAt() }, '2026-07');
    expect(july.rows.filter((r) => r.firmId === f.firmA)).toHaveLength(1);
    expect(july.rows.find((r) => r.firmId === f.firmA)?.dataPoints).toBe(1);

    const september = await generateDeclarations({ db: t.db, clock: clockAt() }, '2026-09');
    expect(september.rows.find((r) => r.firmId === f.firmA)?.dataPoints).toBe(1);
  });

  it('declares a month with no access as no rows at all', async () => {
    await seed();
    const result = await generateDeclarations({ db: t.db, clock: clockAt() }, '2026-06');
    expect(result.rows).toHaveLength(0);
    expect(result.inserted).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ENTL-06 reconciliation against firms.seat_count
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('reconciliation against firms.seat_count', () => {
  it('stores the seat count as it stood at generation and flags the firm that outran it', async () => {
    const f = await seed();
    const result = await generateDeclarations({ db: t.db, clock: clockAt() }, MONTH);

    for (const row of result.rows.filter((r) => r.firmId === f.firmA)) {
      expect(row.seatCount).toBe(3);
      expect(row.withinSeats).toBe(true); // at most 3 distinct users against 3 seats
    }
    const other = result.rows.find((r) => r.firmId === f.firmB);
    expect(other?.seatCount).toBe(1);
    expect(other?.distinctUsers).toBe(2);
    expect(other?.withinSeats).toBe(false);

    expect(result.seatExcess.filter((e) => e.firmId === f.firmA)).toHaveLength(0);
    expect(result.seatExcess.find((e) => e.firmId === f.firmB)).toEqual({
      firmId: f.firmB,
      seatCount: 1,
      maxDistinctUsers: 2,
      sources: ['cboe.quotes'],
    });
  });

  it('captures the seat count of the generation, not of a later change', async () => {
    const f = await seed();
    const first = await generateDeclarations({ db: t.db, clock: clockAt() }, MONTH);
    expect(first.rows.find((r) => r.firmId === f.firmB)?.seatCount).toBe(1);

    await t.client.query('UPDATE firms SET seat_count = 9 WHERE firm_id = $1', [f.firmB]);

    // The stored row still says 1 until the month is regenerated.
    const stored = await listDeclarations(t.db, { month: MONTH, firmId: f.firmB });
    expect(stored.map((r) => r.seatCount)).toEqual([1]);

    const second = await generateDeclarations({ db: t.db, clock: clockAt() }, MONTH);
    expect(second.rows.find((r) => r.firmId === f.firmB)?.seatCount).toBe(9);
    expect(second.rows.find((r) => r.firmId === f.firmB)?.withinSeats).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// DATA-02 — query_sql_hash is the sha256 of the SQL that produced the row
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('query_sql_hash (DATA-02)', () => {
  it('equals the sha256 of the canonical SQL text, in the row and in the database', async () => {
    const f = await seed();
    const result = await generateDeclarations({ db: t.db, clock: clockAt() }, MONTH);

    const text = declarationQuerySql(MONTH);
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');

    expect(result.sql).toBe(text);
    expect(result.querySqlHash).toBe(digest);

    const stored = await t.client.query<{ query_sql_hash: string }>(
      `SELECT query_sql_hash FROM usage_declarations
        WHERE month = $1::date AND firm_id = ANY($2::bigint[])`,
      [MONTH_FIRST, [f.firmA, f.firmB]],
    );
    expect(stored.rows).toHaveLength(5);
    for (const row of stored.rows) {
      expect(row.query_sql_hash).toBe(digest);
      expect(row.query_sql_hash).toHaveLength(64);
    }
    expect(verifyDeclarationHash(MONTH, digest).ok).toBe(true);
    expect(verifyDeclarationHash(MONTH, 'f'.repeat(64)).ok).toBe(false);
  });

  it('re-running the stored SQL text by itself reproduces the stored numbers', async () => {
    const f = await seed();
    const result = await generateDeclarations({ db: t.db, clock: clockAt() }, MONTH);

    // The audit: take the text the hash describes, run it on its own, and compare it to what the
    // table holds. This is the whole point of storing the hash.
    const replayed = await t.client.query<{
      source_id: string;
      firm_id: string;
      field_class: string;
      tier: string;
      display_users: number;
      export_users: number;
      api_users: number;
      distinct_users: number;
      instrument_count: number;
      data_points: string;
      seat_count: number;
    }>(result.sql);

    const ours = replayed.rows.filter(
      (r) => Number(r.firm_id) === f.firmA || Number(r.firm_id) === f.firmB,
    );
    const want = expected(f);
    expect(ours).toHaveLength(5);
    for (const row of ours) {
      const k = `${row.source_id}|${String(Number(row.firm_id))}|${row.field_class}|${row.tier}`;
      expect({
        displayUsers: row.display_users,
        exportUsers: row.export_users,
        apiUsers: row.api_users,
        distinctUsers: row.distinct_users,
        instrumentCount: row.instrument_count,
        dataPoints: Number(row.data_points),
        seatCount: row.seat_count,
      }).toEqual(want[k]);
    }
  });

  it('hashes a different month to a different value', () => {
    expect(declarationQuerySql('2026-08')).not.toBe(declarationQuerySql('2026-09'));
    expect(verifyDeclarationHash('2026-09', verifyDeclarationHash('2026-08', '').expected).ok).toBe(
      false,
    );
  });

  it('refuses a month it cannot validate rather than inlining it into SQL', () => {
    expect(() => declarationQuerySql("2026-08'; DROP TABLE users; --")).toThrow(/not a month/);
    expect(() => declarationQuerySql('2026-13')).toThrow(/month 13/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Idempotency — a regeneration upserts
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('regeneration', () => {
  it('upserts the same month instead of duplicating it', async () => {
    const f = await seed();
    const first = await generateDeclarations({ db: t.db, clock: clockAt() }, MONTH);
    expect(mine(first.rows, f)).toHaveLength(5);
    expect(
      first.rows.filter((r) => r.wasInserted && (r.firmId === f.firmA || r.firmId === f.firmB)),
    ).toHaveLength(5);

    const second = await generateDeclarations(
      { db: t.db, clock: clockAt('2026-09-03T07:20:00.000Z') },
      MONTH,
    );
    const ours = second.rows.filter((r) => r.firmId === f.firmA || r.firmId === f.firmB);
    expect(ours).toHaveLength(5);
    expect(ours.every((r) => !r.wasInserted)).toBe(true);

    // The row identities survived: an upsert, not a delete-and-insert.
    expect(ours.map((r) => r.declarationId).sort((a, b) => a - b)).toEqual(
      first.rows
        .filter((r) => r.firmId === f.firmA || r.firmId === f.firmB)
        .map((r) => r.declarationId)
        .sort((a, b) => a - b),
    );

    const count = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM usage_declarations
        WHERE month = $1::date AND firm_id = ANY($2::bigint[])`,
      [MONTH_FIRST, [f.firmA, f.firmB]],
    );
    expect(count.rows[0]!.n).toBe('5');

    // `generated_at` moved with the clock; the numbers did not.
    expect(ours.find((r) => r.firmId === f.firmB)?.generatedAt).toBe('2026-09-03T07:20:00.000Z');
  });

  it('picks up access_log rows that arrived after the first generation', async () => {
    const f = await seed();
    await generateDeclarations({ db: t.db, clock: clockAt() }, MONTH);

    await log({
      ts: '2026-08-20T12:00:00.000Z',
      userId: f.u1,
      firmId: f.firmA,
      sourceId: 'cboe.quotes',
      fieldClass: 'price',
      requestedTier: 'delayed',
      tier: 'delayed',
      usage: 'api',
      decision: 'allow',
      instrumentId: 999,
    });

    const second = await generateDeclarations({ db: t.db, clock: clockAt() }, MONTH);
    const delayed = second.rows.find(
      (r) => key(r) === `cboe.quotes|${String(f.firmA)}|price|delayed`,
    );
    expect(delayed?.dataPoints).toBe(10); // 9 + 1
    expect(delayed?.apiUsers).toBe(2); // u2 and now u1
    expect(delayed?.instrumentCount).toBe(4); // 101, 102, 103, 999
  });

  it('keeps a reconciliation whose numbers did not move and clears one whose numbers did', async () => {
    const f = await seed();
    const first = await generateDeclarations({ db: t.db, clock: clockAt() }, MONTH);
    const target = first.rows.find(
      (r) => key(r) === `cboe.quotes|${String(f.firmA)}|price|delayed`,
    )!;

    expect(
      await reconcileDeclaration(
        { db: t.db, clock: clockAt() },
        target.declarationId,
        'INV-2026-08-001',
      ),
    ).toBe(true);

    // Unchanged numbers: the reconciliation and the billing reference stand.
    const unchanged = await generateDeclarations({ db: t.db, clock: clockAt() }, MONTH);
    const still = unchanged.rows.find((r) => r.declarationId === target.declarationId);
    expect(still?.reconciledAt).not.toBeNull();
    expect(still?.billingRef).toBe('INV-2026-08-001');

    // A new access_log row moves the numbers, so the reconciliation no longer describes them.
    await log({
      ts: '2026-08-21T12:00:00.000Z',
      userId: f.u1,
      firmId: f.firmA,
      sourceId: 'cboe.quotes',
      fieldClass: 'price',
      requestedTier: 'delayed',
      tier: 'delayed',
      usage: 'display',
      decision: 'allow',
      instrumentId: 101,
    });
    const moved = await generateDeclarations({ db: t.db, clock: clockAt() }, MONTH);
    const cleared = moved.rows.find((r) => r.declarationId === target.declarationId);
    expect(cleared?.dataPoints).toBe(10);
    expect(cleared?.reconciledAt).toBeNull();
    expect(cleared?.billingRef).toBe('INV-2026-08-001');
  });

  it('reads back exactly what it wrote, filtered by source and firm', async () => {
    const f = await seed();
    await generateDeclarations({ db: t.db, clock: clockAt() }, MONTH);

    const byFirm = await listDeclarations(t.db, { month: MONTH, firmId: f.firmB });
    expect(byFirm).toHaveLength(1);
    expect(byFirm[0]!.sourceId).toBe('cboe.quotes');
    expect(byFirm[0]!.distinctUsers).toBe(2);

    const byBoth = await listDeclarations(t.db, {
      month: MONTH,
      firmId: f.firmA,
      sourceId: 'yahoo.chart',
    });
    expect(byBoth).toHaveLength(1);
    expect(byBoth[0]!.tier).toBe('eod');
    expect(byBoth[0]!.dataPoints).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The ingest job
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ingest/jobs/usageDeclarations', () => {
  it('writes one ingest_runs row per execution under the module basename', async () => {
    const f = await seed();
    const clock = clockAt();
    const result = await runUsageDeclarations({ tx: t.db, clock, month: MONTH });

    expect(result.month).toBe(MONTH_FIRST);
    expect(result.fetched).toBeGreaterThanOrEqual(5);
    expect(result.inserted).toBeGreaterThanOrEqual(5);
    expect(result.updated).toBe(0);
    expect(result.runId).toBeGreaterThan(0);

    const runs = await t.client.query<{
      job_id: string;
      source_id: string | null;
      status: string;
      fetched: number;
      inserted: number;
      errors: { code: string; message: string }[];
    }>(
      `SELECT job_id, source_id, status, fetched, inserted, errors
         FROM ingest_runs WHERE run_id = $1`,
      [result.runId],
    );
    expect(runs.rows).toHaveLength(1);
    const run = runs.rows[0]!;
    expect(run.job_id).toBe(USAGE_DECLARATIONS_JOB_ID);
    expect(run.source_id).toBeNull(); // an internal job declares no vendor
    expect(run.status).toBe('ok');
    expect(run.fetched).toBe(result.fetched);
    expect(run.inserted).toBe(result.inserted);

    // The under-licensed firm is a finding on a successful run, not a failure of it.
    const excess = run.errors.filter((e) => e.code === 'SEAT_EXCESS');
    expect(excess).toHaveLength(1);
    expect(excess[0]!.message).toContain(String(f.firmB));
  });

  it('regenerating a month upserts rather than duplicating', async () => {
    const f = await seed();
    const clock = clockAt();
    const first = await runUsageDeclarations({ tx: t.db, clock, month: MONTH });
    const second = await runUsageDeclarations({ tx: t.db, clock, month: MONTH });

    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(first.fetched);
    expect(second.runId).not.toBe(first.runId);

    const count = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM usage_declarations
        WHERE month = $1::date AND firm_id = ANY($2::bigint[])`,
      [MONTH_FIRST, [f.firmA, f.firmB]],
    );
    expect(count.rows[0]!.n).toBe('5');

    const runs = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ingest_runs WHERE run_id = ANY($1::bigint[])`,
      [[first.runId, second.runId]],
    );
    expect(runs.rows[0]!.n).toBe('2');
  });

  it('declares the previous UTC month when no month is given', async () => {
    await seed();
    // 2026-09-02 → August.
    const result = await runUsageDeclarations({ tx: t.db, clock: clockAt() });
    expect(result.month).toBe(MONTH_FIRST);

    // And the first of January declares the December before it.
    const january = await runUsageDeclarations({
      tx: t.db,
      clock: clockAt('2027-01-02T03:20:00.000Z'),
    });
    expect(january.month).toBe('2026-12-01');
  });

  it('writes no ingest_runs row of its own when the scheduler already opened one', async () => {
    await seed();
    const opened = await t.client.query<{ run_id: string }>(
      `INSERT INTO ingest_runs (job_id, source_id, started_at, status)
       VALUES ($1, NULL, now(), 'running') RETURNING run_id`,
      [USAGE_DECLARATIONS_JOB_ID],
    );
    const runId = Number(opened.rows[0]!.run_id);

    const result = await runUsageDeclarations({ tx: t.db, clock: clockAt(), month: MONTH, runId });
    expect(result.runId).toBe(runId);

    const runs = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ingest_runs WHERE job_id = $1`,
      [USAGE_DECLARATIONS_JOB_ID],
    );
    expect(runs.rows[0]!.n).toBe('1');

    // The scheduler owns the row, so the job left it `running` for the scheduler to finish.
    const status = await t.client.query<{ status: string }>(
      `SELECT status FROM ingest_runs WHERE run_id = $1`,
      [runId],
    );
    expect(status.rows[0]!.status).toBe('running');
  });
});
