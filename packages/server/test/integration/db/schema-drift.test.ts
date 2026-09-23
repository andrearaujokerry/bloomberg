/**
 * WORKPLAN §1.11 — parity between the applied database and the hand-written Drizzle mirror
 * (`src/db/schema/*`), read through `getTableConfig()`.
 *
 * **Not `drizzle-kit check`.** That command validates the consistency of a *generated* migration
 * history — the journal and snapshots `drizzle-kit generate` writes — and these sixteen migrations
 * are hand-transcribed SQL with no journal. An exact generate-based mirror is impossible in
 * drizzle-orm 0.45 anyway: it cannot express `PARTITION BY RANGE`, `EXCLUDE USING gist … WHERE
 * (tx_to = 'infinity')`, SQL functions, triggers, the `*_now` views or the RLS policies, so any
 * such diff would be permanently non-empty. This file compares the two representations directly on
 * the axes Drizzle *can* express — table set, column names, types, nullability, primary keys,
 * unique constraints, foreign keys and plain indexes — and carries an explicit allowlist for
 * everything else.
 *
 * The allowlist below is built from the notes the mirror files leave (`schema/index.ts` L9-11,
 * `entitlements.ts` L5-8, `ops.ts` L5-8, `timeseries.ts` L5-7, `messaging.ts` L6, `users.ts` L6,
 * `workspace.ts` L6, `curves.ts` L4, `econ.ts` L5-6, `news.ts` L4, `portfolio.ts` L5) and from the
 * migrations themselves. Its members are not asserted away here: `migrate.test.ts` proves each of
 * them exists, against `pg_proc`, `pg_trigger`, `pg_constraint` and `pg_partitioned_table`.
 *
 * The database under test is `bloomberg_test`, migrated by `test/globalSetup.ts` (TESTING §4.2).
 */

import { is } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { PgTable as PgTableClass, getTableConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema/index.js';
import { testDatabaseUrl } from '../../../src/test/db.js';

const { Client } = pg;

/**
 * Objects the mirror deliberately does not carry. Each entry is a *kind*, with the members listed
 * where they are finite and stable. `migrate.test.ts` asserts every one of them against the
 * catalogue; here they only tell the parity checks what to ignore.
 */
const DRIZZLE_CANNOT_MODEL = {
  /** `PARTITION BY RANGE` — mirrored as plain tables (`timeseries.ts`, `entitlements.ts`, `ops.ts`). */
  partitionedParents: [
    'access_log',
    'bars_daily',
    'bars_intraday',
    'option_quotes',
    'quote_ticks',
    'usage_events',
  ] as const,
  /** `EXCLUDE USING gist (… WITH =, tstzrange(…) WITH &&) WHERE (tx_to = 'infinity')`. */
  exclusionConstraints: [
    'corporate_actions_bt_excl',
    'corporate_actions_natural_excl',
    'entity_classifications_bt_excl',
    'entity_relations_bt_excl',
    'fund_terms_bt_excl',
    'future_terms_bt_excl',
    'fx_terms_bt_excl',
    'govt_terms_bt_excl',
    'identifiers_bt_excl',
    'index_members_bt_excl',
    'index_terms_bt_excl',
    'instruments_bt_excl',
    'issuers_bt_excl',
    'issues_bt_excl',
    'licence_registry_bt_excl',
    'listings_bt_excl',
    'md_lines_bt_excl',
    'md_lines_symbol_excl',
    'option_terms_bt_excl',
    'people_bt_excl',
    'rate_terms_bt_excl',
  ] as const,
  /** SQL functions — CONTRACTS §1.3. */
  functions: [
    'tier_rank',
    'bt_as_of',
    'bt_guard_update',
    'bt_close_tx',
    'set_updated_at',
    'app_user_id',
    'app_firm_id',
    'app_role',
    'assert_source_known',
    'bump_config_version',
    'worm_block',
    'messages_chain',
    'is_room_member',
    'room_has_firm',
    'can_seat_room_member',
    'record_surveillance_hit',
    'anchor_room_chain',
    'messages_anchor',
    'armed_alerts',
    'fire_alert',
    'alert_fired_on',
    'saved_search_query',
    'rooms_anchor_guard',
  ] as const,
  /** Views — CONTRACTS §1.3. Drizzle 0.45 has `pgView`, but the mirror models tables only. */
  views: [
    'issuers_now',
    'issues_now',
    'instruments_now',
    'listings_now',
    'md_lines_now',
    'identifiers_now',
  ] as const,
  /**
   * Standalone sequences: the partitioned tables cannot use an identity column, and the bitemporal
   * tables draw their *entity* id (not the `version_id` serial) from a shared sequence.
   */
  sequences: [
    'access_log_id_seq',
    'ca_id_seq',
    'instrument_id_seq',
    'issue_id_seq',
    'issuer_id_seq',
    'listing_id_seq',
    'md_line_id_seq',
    'person_id_seq',
    'quote_ticks_id_seq',
    'usage_events_id_seq',
  ] as const,
  /**
   * Foreign keys added by a later migration than the one that creates the referencing table, so
   * the mirror would have to declare a cycle to carry them (`ops.ts` L5-8).
   */
  foreignKeys: ['provenance(run_id)->ingest_runs'] as const,
  /**
   * Triggers, RLS policies, roles and GRANT/REVOKE have no Drizzle representation at all; they are
   * counted, not enumerated, so that adding one does not have to be mirrored here as well.
   */
  triggerCount: 45,
  policyCount: 19,
} as const;

// ── the mirror ────────────────────────────────────────────────────────────────────────────────

type TableConfig = ReturnType<typeof getTableConfig>;

/**
 * Every `pgTable` the barrel exports. The barrel also exports `pgEnum`s and a `customType`, which
 * `is(value, PgTable)` filters out; the cast is needed because the narrowed union of 94 distinct
 * `PgTableWithColumns<…>` types is not assignable to the single generic `getTableConfig` takes.
 */
const mirror: { export: string; config: TableConfig }[] = [];
for (const [exportName, value] of Object.entries(schema)) {
  if (is(value, PgTableClass)) {
    mirror.push({ export: exportName, config: getTableConfig(value as unknown as PgTable) });
  }
}

const mirrorByTable = new Map(mirror.map((m) => [m.config.name, m.config]));

/**
 * Drizzle's `getSQLType()` spelling → the `format_type(atttypid, atttypmod)` spelling Postgres
 * reports. Only the forms this schema actually uses need a rule; everything else is already equal.
 */
function toPostgresType(drizzleType: string): string {
  const t = drizzleType.trim();
  if (t === 'bigserial') return 'bigint';
  if (t === 'serial') return 'integer';
  if (t === 'smallserial') return 'smallint';
  if (t === 'time') return 'time without time zone';
  const char = /^char\((\d+)\)$/.exec(t);
  if (char) return `character(${char[1]})`;
  const varchar = /^varchar\((\d+)\)$/.exec(t);
  if (varchar) return `character varying(${varchar[1]})`;
  // `numeric(9, 6)` (Drizzle) → `numeric(9,6)` (Postgres).
  return t.replace(/,\s+/g, ',');
}

function columnList(columns: readonly PgColumn[]): string {
  return columns.map((c) => c.name).join(',');
}

// ── the database ──────────────────────────────────────────────────────────────────────────────

interface DbColumn {
  table: string;
  column: string;
  type: string;
  nullable: boolean;
}

let client: pg.Client;
let dbTables: string[] = [];
let dbColumns: DbColumn[] = [];

async function rows<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
  return (await client.query<T>(sql)).rows;
}

beforeAll(async () => {
  client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();

  dbTables = (
    await rows<{ name: string }>(`
      SELECT c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`)
  ).map((r) => r.name);

  // `information_schema.columns` reports `USER-DEFINED` for every enum and drops numeric precision
  // from `data_type`; `format_type` over `pg_attribute` gives the exact declared spelling, which is
  // what a type-parity assertion has to compare.
  dbColumns = (
    await rows<{ table: string; column: string; type: string; nullable: boolean }>(`
      SELECT c.relname AS "table", a.attname AS "column",
             pg_catalog.format_type(a.atttypid, a.atttypmod) AS "type",
             NOT a.attnotnull AS "nullable"
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
         AND a.attnum > 0 AND NOT a.attisdropped`)
  ).map((r) => ({ table: r.table, column: r.column, type: r.type, nullable: r.nullable }));
}, 60_000);

afterAll(async () => {
  await client?.end().catch(() => undefined);
});

// ── parity ────────────────────────────────────────────────────────────────────────────────────

describe('table set', () => {
  it('mirrors every applied table and invents none', () => {
    const mirrored = mirror.map((m) => m.config.name).sort();
    expect(mirrored).toEqual([...dbTables].sort());
  });

  it('declares every table in the `public` schema', () => {
    for (const m of mirror) {
      expect(m.config.schema, m.config.name).toBeUndefined();
    }
  });

  it('exports each table under a distinct name', () => {
    const names = mirror.map((m) => m.export);
    expect(new Set(names).size).toBe(names.length);
  });

  it('mirrors the partitioned parents as plain tables', () => {
    for (const parent of DRIZZLE_CANNOT_MODEL.partitionedParents) {
      expect(mirrorByTable.has(parent), parent).toBe(true);
    }
  });
});

describe('columns', () => {
  it('matches the column names of every table', () => {
    const byTable = new Map<string, string[]>();
    for (const c of dbColumns) {
      const list = byTable.get(c.table) ?? [];
      list.push(c.column);
      byTable.set(c.table, list);
    }
    for (const m of mirror) {
      const expected = (byTable.get(m.config.name) ?? []).sort();
      const actual = m.config.columns.map((c) => c.name).sort();
      expect(actual, m.config.name).toEqual(expected);
    }
  });

  it('matches the declared type of every column', () => {
    const byKey = new Map(dbColumns.map((c) => [`${c.table}.${c.column}`, c]));
    const drift: string[] = [];
    for (const m of mirror) {
      for (const col of m.config.columns) {
        const db = byKey.get(`${m.config.name}.${col.name}`);
        if (db === undefined) continue; // the name check above already failed for this table
        const mirrored = toPostgresType(col.getSQLType());
        if (mirrored !== db.type) {
          drift.push(`${m.config.name}.${col.name}: mirror ${mirrored} ≠ database ${db.type}`);
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it('matches the nullability of every column', () => {
    const byKey = new Map(dbColumns.map((c) => [`${c.table}.${c.column}`, c]));
    const drift: string[] = [];
    for (const m of mirror) {
      for (const col of m.config.columns) {
        const db = byKey.get(`${m.config.name}.${col.name}`);
        if (db === undefined) continue;
        if (col.notNull === db.nullable) {
          drift.push(
            `${m.config.name}.${col.name}: mirror notNull=${String(col.notNull)}, ` +
              `database nullable=${String(db.nullable)}`,
          );
        }
      }
    }
    expect(drift).toEqual([]);
  });
});

describe('indexes', () => {
  it('matches every plain index, by table and name', async () => {
    // Constraint-backed indexes (primary keys, unique constraints and the GiST exclusion
    // constraints) are compared as constraints below; Postgres names their indexes itself.
    const db = (
      await rows<{ table: string; index: string }>(`
        SELECT c.relname AS "table", i.relname AS "index"
          FROM pg_index x
          JOIN pg_class c ON c.oid = x.indrelid
          JOIN pg_class i ON i.oid = x.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_constraint k ON k.conindid = i.oid
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
           AND NOT x.indisprimary AND k.oid IS NULL`)
    ).map((r) => `${r.table}.${r.index}`);

    const mirrored = mirror.flatMap((m) =>
      m.config.indexes.map((i) => `${m.config.name}.${i.config.name}`),
    );
    expect(mirrored.sort()).toEqual([...db].sort());
  });

  it('matches the uniqueness flag of every mirrored index', async () => {
    const db = new Map(
      (
        await rows<{ index: string; unique: boolean }>(`
          SELECT i.relname AS "index", x.indisunique AS "unique"
            FROM pg_index x
            JOIN pg_class c ON c.oid = x.indrelid
            JOIN pg_class i ON i.oid = x.indexrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`)
      ).map((r) => [r.index, r.unique]),
    );
    for (const m of mirror) {
      for (const index of m.config.indexes) {
        // `name` is optional on Drizzle's index config (it can be generated); this mirror names
        // every index explicitly, and an unnamed one has no counterpart to look up anyway.
        const name = index.config.name ?? '';
        expect(db.get(name), `${m.config.name}.${name}`).toBe(index.config.unique);
      }
    }
  });
});

describe('constraints', () => {
  it('matches every primary key, by column list', async () => {
    const db = new Map(
      (
        await rows<{ table: string; cols: string }>(`
          SELECT c.relname AS "table",
                 (SELECT string_agg(a.attname, ',' ORDER BY u.ord)
                    FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = u.attnum) AS cols
            FROM pg_constraint k
            JOIN pg_class c ON c.oid = k.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND k.contype = 'p' AND NOT c.relispartition`)
      ).map((r) => [r.table, r.cols]),
    );
    for (const m of mirror) {
      const inline = m.config.columns.filter((c) => c.primary);
      const composite = m.config.primaryKeys.flatMap((p) => p.columns);
      const expected = columnList(inline.length > 0 ? inline : composite);
      expect(db.get(m.config.name), m.config.name).toBe(expected);
    }
  });

  it('matches every unique constraint, by column list', async () => {
    const db = (
      await rows<{ table: string; cols: string }>(`
        SELECT c.relname AS "table",
               (SELECT string_agg(a.attname, ',' ORDER BY u.ord)
                  FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = u.attnum) AS cols
          FROM pg_constraint k
          JOIN pg_class c ON c.oid = k.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND k.contype = 'u' AND NOT c.relispartition`)
    ).map((r) => `${r.table}(${r.cols})`);

    // Table-level `unique(...)` and the column modifier `.unique(name)` land in different places
    // on the config; both are unique constraints in SQL.
    const mirrored = mirror.flatMap((m) => [
      ...m.config.uniqueConstraints.map((u) => `${m.config.name}(${columnList(u.columns)})`),
      ...m.config.columns.filter((c) => c.isUnique).map((c) => `${m.config.name}(${c.name})`),
    ]);
    expect(mirrored.sort()).toEqual([...db].sort());
  });

  it('matches every foreign key, minus the ones a later migration adds', async () => {
    const db = (
      await rows<{ table: string; cols: string; target: string }>(`
        SELECT c.relname AS "table",
               (SELECT string_agg(a.attname, ',' ORDER BY u.ord)
                  FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = u.attnum) AS cols,
               f.relname AS target
          FROM pg_constraint k
          JOIN pg_class c ON c.oid = k.conrelid
          JOIN pg_class f ON f.oid = k.confrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND k.contype = 'f' AND NOT c.relispartition`)
    ).map((r) => `${r.table}(${r.cols})->${r.target}`);

    const allowlisted = new Set<string>(DRIZZLE_CANNOT_MODEL.foreignKeys);
    const mirrored = mirror.flatMap((m) =>
      m.config.foreignKeys.map((fk) => {
        const ref = fk.reference();
        return `${m.config.name}(${columnList(ref.columns)})->${getTableConfig(ref.foreignTable).name}`;
      }),
    );
    expect(mirrored.sort()).toEqual(db.filter((f) => !allowlisted.has(f)).sort());
    // …and the allowlisted ones really are in the database, so the allowlist cannot rot.
    for (const fk of allowlisted) expect(db, fk).toContain(fk);
  });

  it('keeps every CHECK the mirror declares', async () => {
    // The direction that matters: a CHECK the mirror invented but the SQL never applied would make
    // `drizzle-kit push` (or a future generate) silently disagree with production. The reverse —
    // a CHECK only the SQL has — is the normal state of this mirror and is not drift.
    const db = new Set(
      (
        await rows<{ table: string; name: string }>(`
          SELECT c.relname AS "table", k.conname AS name
            FROM pg_constraint k
            JOIN pg_class c ON c.oid = k.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND k.contype = 'c' AND NOT c.relispartition`)
      ).map((r) => `${r.table}.${r.name}`),
    );
    for (const m of mirror) {
      for (const check of m.config.checks) {
        expect(db.has(`${m.config.name}.${check.name}`), `${m.config.name}.${check.name}`).toBe(
          true,
        );
      }
    }
  });
});

describe('the allowlist of objects Drizzle cannot model', () => {
  it('lists every exclusion constraint the database has', async () => {
    const db = (
      await rows<{ name: string }>(`
        SELECT k.conname AS name
          FROM pg_constraint k
          JOIN pg_class c ON c.oid = k.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND k.contype = 'x'`)
    ).map((r) => r.name);
    expect([...DRIZZLE_CANNOT_MODEL.exclusionConstraints].sort()).toEqual([...db].sort());
  });

  it('lists every partitioned parent the database has', async () => {
    const db = (
      await rows<{ name: string }>(`
        SELECT c.relname AS name
          FROM pg_partitioned_table pt
          JOIN pg_class c ON c.oid = pt.partrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'`)
    ).map((r) => r.name);
    expect([...DRIZZLE_CANNOT_MODEL.partitionedParents].sort()).toEqual([...db].sort());
  });

  it('lists every standalone sequence the database has', async () => {
    // Identity/serial sequences are owned by their column (pg_depend deptype 'a'/'i'); the ones
    // listed here are declared by the migrations on their own.
    const db = (
      await rows<{ name: string }>(`
        SELECT c.relname AS name
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'S'
           AND NOT EXISTS (SELECT 1 FROM pg_depend d
                            WHERE d.objid = c.oid AND d.deptype IN ('a', 'i'))`)
    ).map((r) => r.name);
    expect([...DRIZZLE_CANNOT_MODEL.sequences].sort()).toEqual([...db].sort());
  });

  it('lists every view the database has, and the mirror has none of them', async () => {
    const db = (
      await rows<{ name: string }>(
        `SELECT table_name AS name FROM information_schema.views WHERE table_schema = 'public'`,
      )
    ).map((r) => r.name);
    expect([...DRIZZLE_CANNOT_MODEL.views].sort()).toEqual([...db].sort());
    for (const view of db) expect(mirrorByTable.has(view), view).toBe(false);
  });

  it('counts the triggers and RLS policies the mirror cannot carry', async () => {
    const triggers = await rows<{ name: string }>(`
      SELECT DISTINCT t.tgname AS name
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal`);
    expect(triggers).toHaveLength(DRIZZLE_CANNOT_MODEL.triggerCount);

    const policies = await rows<{ name: string }>(
      `SELECT policyname AS name FROM pg_policies WHERE schemaname = 'public'`,
    );
    expect(policies).toHaveLength(DRIZZLE_CANNOT_MODEL.policyCount);
  });

  it('lists every SQL function the migrations define', async () => {
    // Extension-owned functions also live in `public`, so the assertion is containment: every
    // allowlisted function exists, and none of them is mirrored (Drizzle has no representation).
    const db = new Set(
      (
        await rows<{ name: string }>(`
          SELECT DISTINCT p.proname AS name
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'`)
      ).map((r) => r.name),
    );
    for (const fn of DRIZZLE_CANNOT_MODEL.functions) expect(db.has(fn), fn).toBe(true);
  });
});
