/**
 * `test/integration/ingest/partitions.test.ts` — WORKPLAN WP-05 acceptance row:
 *
 *   "`ensurePartitions` creates next month for all six partitioned tables and `dropExpired` drops an
 *    expired one **while connected as `terminal_maint`**, and both fail with `permission denied` /
 *    `must be owner of table` as `terminal_app` (so the role split is asserted, not assumed);
 *    `dropExpired` reads the retention it enforces **from `licence_registry`**, never from a literal
 *    in the test, and honours the `retentionFloorDays` of `access_log`/`usage_events` and any open
 *    `legal_holds` row; a non-empty default partition raises `dq_events.kind =
 *    'default_partition_nonempty'`."
 *
 * ## Why this file builds its own connections
 *
 * The shared integration harness connects as the database owner, which is a superuser locally. A
 * superuser passes every privilege check, so a test that only ran `ensurePartitions` through it
 * would prove nothing about DATA_MODEL §15.d.1 — it would pass just as happily if the maintenance
 * pool were pointed at `terminal_app`. So this file:
 *
 *  1. makes sure `terminal_app` and `terminal_maint` exist and can log in (migration 0015 creates
 *     them; a database migrated before that, or a developer's hand-made one, may not have them);
 *  2. **revokes the PG 14 legacy `CREATE ON SCHEMA public FROM PUBLIC` grant**, which is the exact
 *     thing DATA_MODEL §15.d.1 warns "hides half of this in development": with it in place
 *     `terminal_app` can create a table in `public` and the negative assertion below would be
 *     vacuous;
 *  3. asserts the preconditions (who owns the six parents, who holds CREATE) as facts rather than
 *     assuming them, so a drifted database fails here with a readable message instead of failing
 *     mysteriously three tests later;
 *  4. drives `db/partitions.ts` with `DATABASE_URL_MAINT` pointed, per test, at `terminal_maint`
 *     (the positive cases) and at `terminal_app` (the negative ones). The production code path is
 *     identical in both; only the role changes, which is precisely the thing under test.
 *
 * DDL commits, so nothing here can hide inside the harness's rolled-back transaction: every
 * partition this file creates is tracked and dropped in `afterAll`.
 */

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, setConfig } from '../../../src/config.js';
import { closeDb } from '../../../src/db/client.js';
import {
  PARTITIONED_TABLES,
  defaultPartitionSpecs,
  dropExpired,
  ensurePartitions,
  partitionName,
} from '../../../src/db/partitions.js';
import { checkDefaultPartitions } from '../../../src/observability/dq.js';
import { TEST_NOW } from '../../../src/test/clock.js';

import type { PartitionTable } from '../../../src/db/partitions.js';

const { Client } = pg;

const BASE_URL =
  process.env.DATABASE_URL_TEST ??
  process.env.DATABASE_URL ??
  'postgres://localhost:5432/bloomberg_test';

const APP_ROLE = 'terminal_app';
const MAINT_ROLE = 'terminal_maint';

const DAY_MS = 86_400_000;

/** The same connection string, as another role. */
function urlAs(role: string): string {
  const url = new URL(BASE_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}

/** Point `withMaintTx` at `role` for the next call and rebuild both pools. */
async function useMaintRole(role: string): Promise<void> {
  await closeDb();
  setConfig({ ...loadConfig(), DATABASE_URL_MAINT: urlAs(role) });
}

/** Every partition this file created, dropped in `afterAll` whatever the outcome. */
const createdHere = new Set<string>();

function track(names: readonly string[]): readonly string[] {
  for (const name of names) createdHere.add(name);
  return names;
}

let owner: pg.Client;

async function ownerRows<T extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await owner.query<T>(text, [...values]);
  return result.rows;
}

async function scalar<T>(text: string, values: readonly unknown[] = []): Promise<T | undefined> {
  const rows = await ownerRows<Record<string, unknown>>(text, values);
  const row = rows[0];
  if (row === undefined) return undefined;
  return Object.values(row)[0] as T;
}

async function partitionExists(name: string): Promise<boolean> {
  return (await scalar<boolean>(`SELECT to_regclass($1) IS NOT NULL AS present`, [
    `public.${name}`,
  ]))!;
}

async function partitionOwner(name: string): Promise<string | undefined> {
  return scalar<string>(
    `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = to_regclass($1)`,
    [`public.${name}`],
  );
}

async function partitionBound(name: string): Promise<string | undefined> {
  return scalar<string>(
    `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_class c WHERE c.oid = to_regclass($1)`,
    [`public.${name}`],
  );
}

/** Create exactly one partition covering the unit that contains `at`. */
async function createOnePartition(table: PartitionTable, at: Date): Promise<string> {
  const result = await ensurePartitions(table, { from: at, now: at, aheadUnits: 0 });
  track(result.created);
  const name = result.created[0] ?? result.existing[0];
  expect(name, `expected ${table} to have a partition for ${at.toISOString()}`).toBeDefined();
  return name!;
}

async function dropTracked(name: string): Promise<void> {
  await owner.query(`DROP TABLE IF EXISTS ${name}`);
  createdHere.delete(name);
}

/**
 * drizzle wraps a driver failure in a `DrizzleQueryError` whose own message is only
 * `Failed query: …`; the privilege error is the `cause`. These two walk the chain so the role
 * assertions can name the SQLSTATE *and* the wording Postgres used.
 */
function causeChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (!(current instanceof Error)) {
      parts.push(typeof current === 'string' ? current : JSON.stringify(current));
      break;
    }
    parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

function sqlState(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    if (!(current instanceof Error)) return undefined;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Assert that `run()` was refused by Postgres with this SQLSTATE and this wording. */
async function expectRefused(
  run: () => Promise<unknown>,
  expected: { code: string; message: RegExp },
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the statement to be refused, but it succeeded').toBeDefined();
  expect(sqlState(caught), `SQLSTATE of: ${causeChain(caught)}`).toBe(expected.code);
  expect(causeChain(caught)).toMatch(expected.message);
}

/** The highest `dq_id` at this instant — later assertions only look past it. */
async function dqWatermark(): Promise<number> {
  return Number(
    (await scalar<string>(`SELECT coalesce(max(dq_id), 0)::text AS n FROM dq_events`))!,
  );
}

interface DqRow {
  dq_id: string;
  kind: string;
  severity: string;
  subject: string | null;
  details: Record<string, unknown>;
}

async function dqSince(watermark: number, kind: string, subject: string): Promise<DqRow[]> {
  return ownerRows<DqRow>(
    `SELECT dq_id, kind, severity, subject, details
       FROM dq_events WHERE dq_id > $1 AND kind = $2 AND subject = $3 ORDER BY dq_id`,
    [String(watermark), kind, subject],
  );
}

beforeAll(async () => {
  owner = new Client({ connectionString: BASE_URL });
  await owner.connect();
  // Partition bounds are rendered in the *reading* session's time zone; the assertions below
  // compare them against UTC literals, which is what `db/client.ts` writes them as.
  await owner.query(`SET TIME ZONE 'UTC'`);

  const dbName = await scalar<string>('SELECT current_database() AS name');
  expect(dbName ?? '').toContain('test');

  // 1. the two roles. Migration 0015 creates them; a database that predates it would silently make
  //    every assertion in this file vacuous, so create them rather than skip.
  await owner.query(`DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'terminal_app') THEN
        CREATE ROLE terminal_app LOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'terminal_maint') THEN
        CREATE ROLE terminal_maint LOGIN;
      END IF;
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO terminal_app, terminal_maint', current_database());
    END $$`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO terminal_app`);
  await owner.query(`GRANT USAGE, CREATE ON SCHEMA public TO terminal_maint`);

  // 2. close the PG 14 legacy hole (DATA_MODEL §15.d.1 L2313-2315).
  await owner.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);

  // 3. the preconditions, asserted.
  expect(
    await scalar<boolean>(
      `SELECT has_schema_privilege('terminal_maint', 'public', 'CREATE') AS ok`,
    ),
  ).toBe(true);
  expect(
    await scalar<boolean>(`SELECT has_schema_privilege('terminal_app', 'public', 'CREATE') AS ok`),
  ).toBe(false);
  expect(
    await scalar<boolean>(`SELECT pg_has_role('terminal_app', 'terminal_maint', 'USAGE') AS ok`),
  ).toBe(false);
  const owners = await ownerRows<{ relname: string; owner: string }>(
    `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c
      WHERE c.relname IN ('bars_daily','bars_intraday','quote_ticks','option_quotes','access_log','usage_events')
        AND c.relkind = 'p'
      ORDER BY c.relname`,
  );
  expect(owners.map((r) => r.owner)).toEqual(Array.from({ length: 6 }, () => MAINT_ROLE));

  // 4. both roles must actually be able to log in, or the negative assertions never run.
  for (const role of [APP_ROLE, MAINT_ROLE]) {
    const probe = new Client({ connectionString: urlAs(role) });
    try {
      await probe.connect();
      const who = await probe.query<{ me: string }>('SELECT current_user AS me');
      expect(who.rows[0]?.me).toBe(role);
    } finally {
      await probe.end();
    }
  }
}, 60_000);

afterAll(async () => {
  await closeDb();
  for (const name of [...createdHere]) {
    await owner.query(`DROP TABLE IF EXISTS ${name}`);
  }
  createdHere.clear();
  setConfig(undefined);
  await owner.end();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ensurePartitions as terminal_maint', () => {
  // A date beyond every partition migration 0016 created, so each of the six plans really has to
  // build something.
  const NOW = new Date('2027-02-10T00:00:00.000Z');

  const EXPECTED: Record<PartitionTable, readonly string[]> = {
    bars_daily: ['bars_daily_y2028'], // yearly, aheadUnits 1 (y2027 already exists)
    bars_intraday: ['bars_intraday_m2027_02', 'bars_intraday_m2027_03', 'bars_intraday_m2027_04'],
    quote_ticks: [
      'quote_ticks_d2027_02_10',
      'quote_ticks_d2027_02_11',
      'quote_ticks_d2027_02_12',
      'quote_ticks_d2027_02_13',
      'quote_ticks_d2027_02_14',
      'quote_ticks_d2027_02_15',
      'quote_ticks_d2027_02_16',
      'quote_ticks_d2027_02_17',
    ],
    option_quotes: [
      'option_quotes_d2027_02_10',
      'option_quotes_d2027_02_11',
      'option_quotes_d2027_02_12',
      'option_quotes_d2027_02_13',
      'option_quotes_d2027_02_14',
      'option_quotes_d2027_02_15',
      'option_quotes_d2027_02_16',
      'option_quotes_d2027_02_17',
    ],
    access_log: ['access_log_m2027_02', 'access_log_m2027_03', 'access_log_m2027_04'],
    usage_events: ['usage_events_m2027_02', 'usage_events_m2027_03', 'usage_events_m2027_04'],
  };

  it('creates the next unit for all six partitioned tables, owned by terminal_maint', async () => {
    await useMaintRole(MAINT_ROLE);

    for (const table of PARTITIONED_TABLES) {
      const expected = EXPECTED[table];
      const result = await ensurePartitions(table, { now: NOW });
      track(result.created);
      expect(result.created, `created for ${table}`).toEqual([...expected]);
      expect(result.blocked).toEqual([]);

      for (const name of expected) {
        expect(await partitionExists(name), `${name} exists`).toBe(true);
        expect(await partitionOwner(name), `${name} owner`).toBe(MAINT_ROLE);
      }
    }

    // Bounds are UTC days/months/years, not the migrator's local time zone (DATA_MODEL §16).
    expect(await partitionBound('quote_ticks_d2027_02_10')).toBe(
      "FOR VALUES FROM ('2027-02-10 00:00:00+00') TO ('2027-02-11 00:00:00+00')",
    );
    expect(await partitionBound('bars_daily_y2028')).toBe(
      "FOR VALUES FROM ('2028-01-01') TO ('2029-01-01')",
    );
  });

  it('is idempotent: a second run creates nothing and reports them as existing', async () => {
    await useMaintRole(MAINT_ROLE);
    const result = await ensurePartitions('quote_ticks', { now: NOW });
    expect(result.created).toEqual([]);
    expect(result.existing).toEqual([...EXPECTED.quote_ticks]);
  });

  it('skips a range an existing partition already covers instead of failing the run', async () => {
    // Migration 0016's daily bounds now carry an explicit `+00`, so a UTC-day candidate matches
    // one by name (42P07 `already exists`) rather than overlapping it. Either way the run absorbs
    // it and reports the range as `existing`.
    await useMaintRole(MAINT_ROLE);
    const result = await ensurePartitions('quote_ticks', {
      from: new Date('2026-09-15T00:00:00.000Z'),
      now: new Date('2026-09-15T00:00:00.000Z'),
      aheadUnits: 2,
    });
    track(result.created);
    expect(result.created).toEqual([]);
    expect(result.existing).toContain('quote_ticks_d2026_09_15');
  });

  it('absorbs a partition whose bounds are NOT on a UTC boundary (42P17 would overlap)', async () => {
    // The regression this file exists for. Before `meansAlreadyCovered` walked drizzle's `cause`
    // chain, `err.code` was `undefined` (the wrapper carries no SQLSTATE) and `err.message` was
    // `'Failed query: CREATE TABLE …'` (the wrapper's own text), so neither the `42P17` branch nor
    // the wording branch ever fired and the error escaped the whole range loop: a single
    // misaligned partition meant *no* partitions were created for that parent and the day's rows
    // fell into the default. Any bound written without an explicit offset — which is what every
    // hand-rolled `'2027-05-10'` literal is — produces exactly this shape on a non-UTC server.
    const shifted = 'quote_ticks_d2027_05_10_shifted';
    await owner.query(`DROP TABLE IF EXISTS ${shifted}`);
    await owner.query(
      `CREATE TABLE ${shifted} PARTITION OF quote_ticks
         FOR VALUES FROM ('2027-05-10 04:00:00+00') TO ('2027-05-11 04:00:00+00')`,
    );
    createdHere.add(shifted);

    await useMaintRole(MAINT_ROLE);
    const at = new Date('2027-05-10T00:00:00.000Z');
    // Two days: 05-10 overlaps the shifted partition by twenty hours, 05-11 by four.
    const result = await ensurePartitions('quote_ticks', { from: at, now: at, aheadUnits: 1 });
    track(result.created);

    expect(result.created).toEqual([]);
    expect(result.existing).toEqual([
      'quote_ticks_d2027_05_10',
      'quote_ticks_d2027_05_11',
    ]);
    expect(result.blocked).toEqual([]);
    // And the day after the overlap is still created: one absorbed range must not stop the loop.
    const after = new Date('2027-05-12T00:00:00.000Z');
    const next = await ensurePartitions('quote_ticks', { from: after, now: after, aheadUnits: 0 });
    track(next.created);
    expect(next.created).toEqual(['quote_ticks_d2027_05_12']);

    await dropTracked(shifted);
  });
});

describe('migration 0016 hands its partitions to terminal_maint', () => {
  it('owns every child of the six parents, not only the ones this file created', async () => {
    // `CREATE TABLE … PARTITION OF` gives the child to its CREATOR. 0015's re-owning loop runs
    // before 0016 creates them, so without 0016's own loop the 54 initial partitions belong to the
    // migrating superuser and `dropExpired` fails as terminal_maint with 42501 `must be owner of
    // table <partition>` — STOR-07's licence-mandated deletion silently never happening.
    const rows = await ownerRows<{ relname: string; owner: string }>(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class parent ON parent.oid = i.inhparent
        WHERE parent.relname IN ('bars_daily','bars_intraday','quote_ticks','option_quotes','access_log','usage_events')
        ORDER BY c.relname`,
    );
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.filter((r) => r.owner !== MAINT_ROLE).map((r) => r.relname)).toEqual([]);
  });
});

describe('the role split, asserted rather than assumed', () => {
  it('refuses to create a partition as terminal_app: permission denied for schema public', async () => {
    await useMaintRole(APP_ROLE);
    const now = new Date('2027-06-10T00:00:00.000Z');
    await expectRefused(() => ensurePartitions('quote_ticks', { from: now, now, aheadUnits: 0 }), {
      code: '42501', // insufficient_privilege
      message: /permission denied for schema public/i,
    });
    expect(await partitionExists('quote_ticks_d2027_06_10')).toBe(false);
  });

  it('refuses to drop a partition as terminal_app: must be owner of table', async () => {
    await useMaintRole(MAINT_ROLE);
    // 400 days back is past every plan's retention for quote_ticks, whatever the licence says.
    const old = new Date(TEST_NOW - 400 * DAY_MS);
    const name = await createOnePartition('quote_ticks', old);

    await useMaintRole(APP_ROLE);
    await expectRefused(() => dropExpired('quote_ticks', { now: new Date(TEST_NOW) }), {
      code: '42501', // insufficient_privilege
      message: new RegExp(`must be owner of table ${name}`, 'i'),
    });
    expect(await partitionExists(name)).toBe(true);

    // …and the very same call succeeds as terminal_maint.
    await useMaintRole(MAINT_ROLE);
    const dropped = await dropExpired('quote_ticks', { now: new Date(TEST_NOW) });
    expect(dropped.dropped).toContain(name);
    expect(await partitionExists(name)).toBe(false);
    createdHere.delete(name);
  });
});

describe('dropExpired reads its retention from licence_registry (STOR-07)', () => {
  it('drops past the licence horizon and keeps everything inside it', async () => {
    // The number is READ, never written here: whatever `licence_registry` says for the source that
    // governs `quote_ticks` is what the test builds its two partitions around.
    const licenceDays = Number(
      (await scalar<string>(
        `SELECT retention_days::text FROM licence_registry
          WHERE source_id = 'cboe.quotes' AND tx_to = 'infinity' AND valid_to = 'infinity'
          ORDER BY version_id DESC LIMIT 1`,
      ))!,
    );
    expect(Number.isFinite(licenceDays)).toBe(true);
    expect(licenceDays).toBeGreaterThan(0);

    const now = new Date(TEST_NOW);
    const expiredAt = new Date(TEST_NOW - (licenceDays + 5) * DAY_MS);
    const freshAt = new Date(TEST_NOW - (licenceDays - 3) * DAY_MS);

    await useMaintRole(MAINT_ROLE);
    const expiredName = await createOnePartition('quote_ticks', expiredAt);
    const freshName = await createOnePartition('quote_ticks', freshAt);
    expect(expiredName).toBe(partitionName('quote_ticks', 'day', expiredAt));

    const result = await dropExpired('quote_ticks', { now });

    // The enforced number is the registry's, and the cutoff follows from it.
    expect(result.retention.sourceId).toBe('cboe.quotes');
    expect(result.retention.licenceDays).toBe(licenceDays);
    expect(result.retention.retentionDays).toBe(licenceDays);
    expect(result.retention.cutoff?.getTime()).toBe(TEST_NOW - licenceDays * DAY_MS);

    expect(result.dropped).toContain(expiredName);
    expect(result.dropped).not.toContain(freshName);
    expect(await partitionExists(expiredName)).toBe(false);
    expect(await partitionExists(freshName)).toBe(true);
    createdHere.delete(expiredName);

    // One `ingest_runs` row per drop (DATA_MODEL §7.3 L1237).
    expect(result.runIds).toHaveLength(result.dropped.length);
    const runs = await ownerRows<{
      job_id: string;
      source_id: string;
      status: string;
      errors: unknown;
    }>(
      `SELECT job_id, source_id, status, errors FROM ingest_runs WHERE run_id = ANY($1::bigint[])`,
      [result.runIds.map((id) => String(id))],
    );
    expect(runs).toHaveLength(result.runIds.length);
    for (const run of runs) {
      expect(run.job_id).toBe('retentionPurge');
      expect(run.source_id).toBe('cboe.quotes');
      expect(run.status).toBe('ok');
    }
    expect(JSON.stringify(runs.map((r) => r.errors))).toContain(expiredName);

    await dropTracked(freshName);
  });

  it('a dry run destroys nothing and never reports that it did', async () => {
    // `dropped` is what an operator's log line and an incident report quote. A dry run that filled
    // it with candidate names would state that data was destroyed when none was, so the candidates
    // go in `wouldDrop` and `dropped` stays empty by construction.
    const now = new Date(TEST_NOW);
    const expiredAt = new Date(TEST_NOW - 400 * DAY_MS);

    await useMaintRole(MAINT_ROLE);
    const name = await createOnePartition('quote_ticks', expiredAt);

    const dry = await dropExpired('quote_ticks', { now, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.dropped).toEqual([]);
    expect(dry.wouldDrop).toContain(name);
    expect(dry.runIds).toEqual([]);
    expect(await partitionExists(name)).toBe(true);

    // …and the real run does what the dry run promised, reporting it in the other field.
    const real = await dropExpired('quote_ticks', { now });
    expect(real.dryRun).toBe(false);
    expect(real.wouldDrop).toEqual([]);
    expect(real.dropped).toEqual([...dry.wouldDrop]);
    expect(await partitionExists(name)).toBe(false);
    createdHere.delete(name);
  });

  it('honours the access_log / usage_events retention floors', async () => {
    const now = new Date(TEST_NOW);
    // 1 095 days: past `usage_events`' 730-day floor, far inside `access_log`'s 2 557-day one.
    const at = new Date(TEST_NOW - 1_095 * DAY_MS);

    await useMaintRole(MAINT_ROLE);
    const usageName = await createOnePartition('usage_events', at);
    const accessName = await createOnePartition('access_log', at);

    const usage = await dropExpired('usage_events', { now });
    expect(usage.retention.sourceId).toBeNull(); // no licence governs it …
    expect(usage.retention.licenceDays).toBeNull();
    expect(usage.retention.retentionDays).toBe(730); // … the regulatory floor does
    expect(usage.dropped).toContain(usageName);
    expect(await partitionExists(usageName)).toBe(false);
    createdHere.delete(usageName);

    const access = await dropExpired('access_log', { now });
    expect(access.retention.retentionDays).toBe(2557); // 7 y — ENTL-04 / REG-01
    expect(access.dropped).not.toContain(accessName);
    expect(await partitionExists(accessName)).toBe(true);

    await dropTracked(accessName);
  });

  it('never drops a partition an open legal_holds row covers (MSG-02)', async () => {
    const licenceDays = Number(
      (await scalar<string>(
        `SELECT retention_days::text FROM licence_registry
          WHERE source_id = 'cboe.quotes' AND tx_to = 'infinity' AND valid_to = 'infinity'
          ORDER BY version_id DESC LIMIT 1`,
      ))!,
    );
    const now = new Date(TEST_NOW);
    const at = new Date(TEST_NOW - (licenceDays + 9) * DAY_MS);

    await useMaintRole(MAINT_ROLE);
    const name = await createOnePartition('quote_ticks', at);

    // WP-15 owns the seed and it does not exist yet, so the test makes the firm the hold needs
    // and takes it away again in `finally`.
    const firmId = (await scalar<string>(
      `INSERT INTO firms (name, seat_count, retention_days, data_residency, status)
       VALUES ('partitions.test.ts', 1, 2557, 'us', 'active') RETURNING firm_id::text`,
    ))!;
    const holdId = (await scalar<string>(
      `INSERT INTO legal_holds (firm_id, scope, reason, created_by)
       VALUES ($1::bigint, $2::jsonb, 'partitions.test.ts', 1) RETURNING hold_id::text`,
      [
        firmId,
        JSON.stringify({
          userIds: [],
          roomIds: [],
          from: new Date(at.getTime() - DAY_MS).toISOString(),
          to: new Date(at.getTime() + 2 * DAY_MS).toISOString(),
        }),
      ],
    ))!;

    try {
      const held = await dropExpired('quote_ticks', { now });
      expect(held.dropped).not.toContain(name);
      expect(held.heldBack.map((h) => h.partition)).toContain(name);
      expect(held.heldBack.find((h) => h.partition === name)?.holdIds).toEqual([Number(holdId)]);
      expect(await partitionExists(name)).toBe(true);

      // Release the hold and the same call takes it.
      await owner.query(`UPDATE legal_holds SET released_at = now() WHERE hold_id = $1::bigint`, [
        holdId,
      ]);
      const released = await dropExpired('quote_ticks', { now });
      expect(released.heldBack).toEqual([]);
      expect(released.dropped).toContain(name);
      expect(await partitionExists(name)).toBe(false);
      createdHere.delete(name);
    } finally {
      await owner.query(`DELETE FROM legal_holds WHERE hold_id = $1::bigint`, [holdId]);
      await owner.query(`DELETE FROM firms WHERE firm_id = $1::bigint`, [firmId]);
    }
  });
});

describe('a non-empty default partition', () => {
  /**
   * The monitor is deliberately idempotent — one *open* row per `(table, day)`, so a job that ticks
   * every minute does not write a wall of identical events — and DDL commits, so an event this file
   * opened on an earlier run would suppress the one it is about to assert. Clear this file's own
   * previous rows first: that is setup, not a weakened assertion.
   */
  beforeEach(async () => {
    await owner.query(
      `DELETE FROM dq_events
        WHERE kind = 'default_partition_nonempty' AND subject IN ('quote_ticks', 'usage_events')`,
    );
  });

  async function insertOutOfRangeTick(captureTs: string): Promise<{ tickId: string }> {
    const provenanceId = (await scalar<string>(
      `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                               http_status, bytes, captured_at, adapter_version)
       VALUES ('cboe.quotes', $1, 'https://example.invalid/partitions-test',
               decode('00','hex'), decode('00','hex'), 200, 0, now(), 'partitions.test/1.0.0')
       RETURNING provenance_id::text`,
      [`partitions-test:${captureTs}:${String(Math.random())}`],
    ))!;
    const tickId = (await scalar<string>(
      `INSERT INTO quote_ticks (capture_ts, instrument_id, md_line_id, kind, provenance_id)
       VALUES ($1::timestamptz, 9000000001, 9000000001, 'quote', $2::bigint)
       RETURNING tick_id::text`,
      [captureTs, provenanceId],
    ))!;
    return { tickId };
  }

  it('is moved into the new partition and flagged as default_partition_nonempty', async () => {
    const watermark = await dqWatermark();
    const { tickId } = await insertOutOfRangeTick('1999-03-04T10:00:00.000Z');
    expect(
      await scalar<string>(
        `SELECT tableoid::regclass::text AS t FROM quote_ticks WHERE tick_id = $1`,
        [tickId],
      ),
    ).toBe('quote_ticks_default');

    await useMaintRole(MAINT_ROLE);
    const at = new Date('1999-03-04T00:00:00.000Z');
    const result = await ensurePartitions('quote_ticks', { from: at, now: at, aheadUnits: 0 });
    track(result.created);

    expect(result.created).toEqual(['quote_ticks_d1999_03_04']);
    expect(result.movedRows).toBe(1);
    expect(
      await scalar<string>(
        `SELECT tableoid::regclass::text AS t FROM quote_ticks WHERE tick_id = $1`,
        [tickId],
      ),
    ).toBe('quote_ticks_d1999_03_04');

    const events = await dqSince(watermark, 'default_partition_nonempty', 'quote_ticks');
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1]!;
    const details = last.details as { table?: string; moved?: number; rows?: number };
    expect(details.table).toBe('quote_ticks');
    expect(Number(details.moved ?? details.rows)).toBeGreaterThanOrEqual(1);

    await dropTracked('quote_ticks_d1999_03_04');
  });

  it('is reported by the standalone monitor while rows remain', async () => {
    const watermark = await dqWatermark();
    const { tickId } = await insertOutOfRangeTick('1998-02-02T09:00:00.000Z');
    try {
      const findings = await checkDefaultPartitions(defaultPartitionSpecs(), {
        now: new Date(TEST_NOW),
      });
      const quotes = findings.find((f) => f.table === 'quote_ticks');
      expect(quotes, 'quote_ticks_default should be reported non-empty').toBeDefined();
      expect(quotes!.partition).toBe('quote_ticks_default');
      expect(quotes!.rows).toBeGreaterThanOrEqual(1);

      const events = await dqSince(watermark, 'default_partition_nonempty', 'quote_ticks');
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[events.length - 1]!.severity).toBe('warn');
    } finally {
      await owner.query(`DELETE FROM quote_ticks WHERE tick_id = $1::bigint`, [tickId]);
    }
  });

  it('cannot be drained on a WORM table, so the range is reported instead of failing', async () => {
    // `usage_events` and `access_log` carry the 15.d `BEFORE UPDATE OR DELETE` trigger, which
    // fires for *every* role including the owner. Their default-partition rows therefore cannot be
    // moved into a new partition, and `ATTACH` would be refused outright while they overlap it.
    // The run must report the range and raise an `error`-severity event rather than throw.
    const before = Number(
      (await scalar<string>('SELECT count(*)::text AS n FROM usage_events_default'))!,
    );
    expect(before, 'usage_events_default should start empty').toBe(0);

    const watermark = await dqWatermark();
    await owner.query(
      `INSERT INTO usage_events (ts, user_id, firm_id, kind)
       VALUES ('1997-05-05T12:00:00Z'::timestamptz, 9000000001, 9000000001, 'fn.launch')`,
    );
    try {
      await useMaintRole(MAINT_ROLE);
      const at = new Date('1997-05-05T00:00:00.000Z');
      const result = await ensurePartitions('usage_events', { from: at, now: at, aheadUnits: 0 });
      track(result.created);

      expect(result.created).toEqual([]);
      expect(result.movedRows).toBe(0);
      expect(result.blocked).toEqual([
        {
          partition: 'usage_events_m1997_05',
          lo: '1997-05-01 00:00:00+00',
          hi: '1997-06-01 00:00:00+00',
          rowsInDefault: 1,
          reason: 'worm_default_rows',
        },
      ]);
      expect(await partitionExists('usage_events_m1997_05')).toBe(false);

      const events = await dqSince(watermark, 'default_partition_nonempty', 'usage_events');
      expect(events.length).toBeGreaterThanOrEqual(1);
      const last = events[events.length - 1]!;
      expect(last.severity).toBe('error'); // an operator has to move these by hand
      expect((last.details as { worm?: boolean }).worm).toBe(true);
    } finally {
      // WORM forbids DELETE for every role; truncating the one partition is the only way back, and
      // it is safe precisely because a non-empty default partition is itself the defect.
      await owner.query('TRUNCATE ONLY usage_events_default');
    }
  });
});
