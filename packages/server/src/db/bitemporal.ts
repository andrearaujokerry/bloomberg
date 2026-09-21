/**
 * The normative bitemporal write layer — ARCHITECTURE §4.3 (L571-622), DATA_MODEL §1.2/§1.3
 * (L149-247), REF-03 / STOR-03 / STOR-06.
 *
 * Every table carrying the `-- [BT]` column block is written through `writeVersion()` /
 * `upsertVersion()` and through nothing else: the 16 reference tables CONTRACTS §1.2 lists from
 * `issuers` to `corporate_actions`, plus `licence_registry`, `people` and `entity_relations`
 * (nineteen `*_bt_guard` triggers in the applied schema). Direct INSERTs elsewhere would have to
 * re-derive the closing rules below, and the ones that got them wrong would be invisible until a
 * past-dated read returned something we did not know at the time.
 *
 * One stated exception: `seed/licences.ts` writes the 33-row `licence_registry` with a raw INSERT
 * of the whole table in one shot (WP-01). That table has exactly one version per key, no history
 * to close and no ingest job behind it, so it never exercises the rules below; every *other*
 * writer of a `*_bt_guard` table goes through this module.
 *
 * Two axes, never mixed:
 *
 *   * **valid time** `[valid_from, valid_to)` — when the fact was true in the world. A *change*
 *     (a coupon that takes effect on D) narrows the old version's valid range and opens a new one
 *     at D.
 *   * **transaction time** `[tx_from, tx_to)` — when we believed it. A *correction* ("we were
 *     wrong all along") keeps the valid range and opens a new version with a later `tx_from`.
 *
 * Rows are immutable except for closing `tx_to` once (`bt_guard_update`), DELETE is revoked from
 * `terminal_app`, and `<table>_bt_excl` proves that at most one *current* version per key covers
 * any valid instant.
 *
 * ## Why `txFrom` exists (WORKPLAN §WP-04 L663-680, an addition to ARCHITECTURE L602)
 *
 * The `tx_from` column default is `now()`, which is **transaction start** and therefore constant
 * for the life of a transaction. Two versions of one key written in one transaction — an initial
 * value and its correction, exactly the TESTING §7.10 `bt.correction` case, and exactly what the
 * per-test transaction of the harness (TESTING §4.3) forces every integration test into — would
 * then both take the same `tx_from`, and closing the first would set `tx_to = tx_from`, which
 * `bt_guard_update` ("tx_to must be after tx_from") and the `<table>_tx_range` CHECK both reject.
 *
 * So the knowledge instant is resolved **once per call, in JavaScript**, and used for all four
 * steps: `tx_from` of the new row, `p_now` of `bt_close_tx`, and `tx_from` of any re-inserted
 * remainder. `w.txFrom` supplies it when the real knowledge instant is historical (a filing's SEC
 * `acceptanceDateTime`, a corporate action's announcement date, any seeded history); otherwise it
 * is `clock_timestamp()` — read once, not per statement, because `clock_timestamp()` advances
 * inside a transaction and two reads would leave a gap on the transaction-time axis.
 *
 * A caller closing a version must pass an instant **strictly later** than the `tx_from` of the
 * version it is closing; `bt_guard_update` rejects anything else, loudly, by design. The other
 * half of that precondition — *not in the future* — has no database backstop (a
 * `CHECK (tx_from <= now())` would reject the two-versions-in-one-transaction case above, since
 * `now()` is transaction start), so {@link knowledgeInstant} enforces it in JavaScript against
 * `clock_timestamp()` and throws {@link BitemporalWriteError}. A future `tx_from` is not a loud
 * failure otherwise: the row is invisible to every read at the present instant, and a re-run of
 * the same ingest cannot repair it, because `upsertVersion`'s no-op test matches on
 * `tx_to = 'infinity'` and the invisible row satisfies it.
 *
 * Postgres errors are never wrapped here: `23P01` (an overlapping current version) is part of this
 * module's contract and the ingest jobs of WP-04/WP-05 branch on the SQLSTATE. An unusable valid
 * range is the exception — Postgres reports it as `23514` (`<table>_valid_range`) when
 * `validFrom = validTo` but as `22000` from `tstzrange()` when `validFrom > validTo`, which is one
 * mistake wearing two SQLSTATEs, so both are rejected here as a {@link BitemporalWriteError}
 * before any statement runs.
 */

import { getTableColumns, getTableName, sql, type SQL } from 'drizzle-orm';

import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Tx } from './client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The six columns DATA_MODEL §1.2 expands into every bitemporal table. */
export interface BitemporalColumns {
  validFrom: PgColumn;
  validTo: PgColumn;
  txFrom: PgColumn;
  txTo: PgColumn;
  provenanceId: PgColumn;
  versionId: PgColumn;
}

/** The row fields this module owns; a repository never sets them by hand. */
export type BitemporalKeys = 'validFrom' | 'validTo' | 'txFrom' | 'txTo' | 'provenanceId';

/**
 * A Drizzle table plus the name(s) of its **exclusion key** — the `<key>` of
 * `<table>_bt_excl`, not necessarily the entity the row describes. `identifiers` is keyed
 * `(scheme, value, qualifier)`, `index_members` `(index_id, instrument_id)`,
 * `entity_classifications` `(entity_kind, entity_id, scheme)` and `entity_relations`
 * `(from_kind, from_id, to_kind, to_id, relation)`; the other fifteen are keyed on one bigint.
 *
 * ARCHITECTURE L602 writes `$entityKey: string`, which covers only the single-column case;
 * DATA_MODEL §1.3 L243-247 requires the composite ones too and left them to per-table wrappers.
 * Carrying the tuple here instead means `refdata/*` gets one writer rather than five.
 */
export type BitemporalTable<Row = Record<string, unknown>> = PgTable &
  BitemporalColumns & { readonly $entityKey: readonly Extract<keyof Row, string>[] };

/** A `(validAt, knownAt)` pair: what was true then, as far as we knew then. */
export interface AsOf {
  validAt: Date;
  knownAt: Date;
}

/** "Now on both axes" — the default an interactive read uses (DATA_MODEL §1.3). */
export const nowAsOf = (clock: { now(): number }): AsOf => {
  const d = new Date(clock.now());
  return { validAt: d, knownAt: d };
};

/** One version write. `data` carries every non-bitemporal column of the row. */
export interface VersionWrite<Row> {
  /** The `<table>_bt_excl` key columns, by TypeScript field name: `{ instrumentId: 42 }`. */
  entityKey: Partial<Row>;
  validFrom: Date;
  /** Omitted → `'infinity'`: true from `validFrom` until something says otherwise. */
  validTo?: Date;
  data: Omit<Row, BitemporalKeys | 'versionId'>;
  provenanceId: number;
  /**
   * Audit label. `'initial'` opens a key, `'change'` narrows the previous valid range,
   * `'correction'` re-states the same valid range at a later transaction time. The mechanics are
   * identical (DATA_MODEL §1.3); the label is what a `data_exceptions` row records on conflict.
   */
  reason: 'initial' | 'change' | 'correction';
  /**
   * knownAt: the instant this became known to us. Written to `tx_from` of the new row AND passed
   * as `bt_close_tx`'s `p_now`, so the closed version's `tx_to` equals the new version's
   * `tx_from` and the transaction-time axis has no gap and no overlap. Omitted →
   * `clock_timestamp()`, never `now()`. **Required** whenever the knowledge instant is historical
   * (SEC `acceptanceDateTime`, a Yahoo event date, seeded history). Must be strictly greater than
   * the `tx_from` of the version being closed and not in the future.
   */
  txFrom?: Date;
}

/**
 * A write this module refuses before it reaches Postgres: an unusable valid range, or a knowledge
 * instant we have not reached yet. Both are caller mistakes that the database either reports under
 * two different SQLSTATEs or cannot see at all, so they get one named type and one message shape.
 */
export class BitemporalWriteError extends Error {
  constructor(
    /** The table the refused write targeted, as Postgres names it. */
    readonly table: string,
    message: string,
  ) {
    super(`${table}: ${message}`);
    this.name = 'BitemporalWriteError';
  }
}

/**
 * How far ahead of the database's `clock_timestamp()` a caller-supplied `txFrom` may sit.
 *
 * Not zero: the instant usually comes from the Node process's own clock (`Clock#now()`), and node
 * and Postgres need not run on the same host. A minute absorbs every realistic skew while still
 * catching what this guard exists for — a timezone mis-parse (≥ 1 h: a SEC `acceptanceDateTime`
 * read as UTC when it is US/Eastern) and a genuinely wrong date (days).
 */
const TX_FROM_FUTURE_TOLERANCE_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Read predicates
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * WHERE fragment: the version valid at `validAt` as known at `knownAt` (REF-03). The only
 * as-of read predicate `refdata/*` offers, so that every reader goes through the same
 * half-open `[from, to)` semantics on both axes.
 */
export function asOf(t: BitemporalColumns, at: AsOf): SQL {
  return sql`bt_as_of(${t.validFrom}, ${t.validTo}, ${t.txFrom}, ${t.txTo}, ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)`;
}

/** Current, currently-believed rows; hits the `<table>_current_idx` partial index. */
export function current(t: BitemporalColumns): SQL {
  return sql`${t.txTo} = 'infinity' AND ${t.validTo} = 'infinity'`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Table wrapper
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Tag a Drizzle table from `db/schema/*` with its `<table>_bt_excl` key columns.
 *
 * The returned value delegates to the schema object through the prototype chain, so every
 * Drizzle symbol (`Table.Symbol.Columns`, `Table.Symbol.Name`) still resolves and the shared
 * mirror object is not mutated.
 *
 * @example const btGovtTerms = bitemporal(govtTerms, 'instrumentId');
 * @example const btIdentifiers = bitemporal(identifiers, 'scheme', 'value', 'qualifier');
 */
export function bitemporal<T extends PgTable & BitemporalColumns>(
  table: T,
  ...entityKey: [
    Extract<keyof T['_']['columns'], string>,
    ...Extract<keyof T['_']['columns'], string>[],
  ]
): BitemporalTable<T['$inferSelect']> {
  const columns = columnsOf(table);
  for (const field of entityKey) {
    if (columns[field] === undefined) {
      throw new Error(`bitemporal(${getTableName(table)}): no column named ${field}`);
    }
  }
  const tagged: { $entityKey: readonly string[] } = Object.create(table) as {
    $entityKey: readonly string[];
  };
  tagged.$entityKey = Object.freeze([...entityKey]);
  return tagged as unknown as BitemporalTable<T['$inferSelect']>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────────────────────

function columnsOf(table: PgTable): Record<string, PgColumn | undefined> {
  return getTableColumns(table);
}

function columnOrThrow(
  table: PgTable,
  columns: Record<string, PgColumn | undefined>,
  field: string,
): PgColumn {
  const column = columns[field];
  if (column === undefined) {
    throw new Error(`${getTableName(table)}: no column named ${field}`);
  }
  return column;
}

/** `column.mapToDriverValue` is what Drizzle's own INSERT uses: jsonb → text, numeric → text, … */
function driverValue(column: PgColumn, value: unknown): unknown {
  return value === null || value === undefined ? null : column.mapToDriverValue(value);
}

const asRecord = (value: unknown): Record<string, unknown> =>
  (value ?? {}) as Record<string, unknown>;

/** `tbl` as an escaped identifier, usable in FROM, INSERT and a `NULL::tbl` row-type cast. */
function tableRef(table: PgTable): SQL {
  return sql`${sql.identifier(getTableName(table))}`;
}

function qualified(alias: string, column: PgColumn): SQL {
  return sql`${sql.identifier(alias)}.${sql.identifier(column.name)}`;
}

/** `cur.instrument_id = $1 AND cur.scheme = $2 …` over the `<table>_bt_excl` key columns. */
function keyPredicate<Row>(
  table: BitemporalTable<Row>,
  entityKey: Partial<Row>,
  alias: string,
): SQL {
  const columns = columnsOf(table);
  const key = asRecord(entityKey);
  const parts = table.$entityKey.map((field) => {
    const column = columnOrThrow(table, columns, field);
    const value = key[field];
    if (value === undefined || value === null) {
      throw new Error(
        `${getTableName(table)}: entityKey.${field} is part of ${getTableName(table)}_bt_excl and must be supplied`,
      );
    }
    return sql`${qualified(alias, column)} = ${driverValue(column, value)}`;
  });
  return sql.join(parts, sql` AND `);
}

/** `validTo` as SQL: a bound, or `'infinity'` when the caller gave none. */
function validToSql<Row>(w: VersionWrite<Row>): SQL {
  return w.validTo === undefined ? sql`'infinity'::timestamptz` : sql`${w.validTo}::timestamptz`;
}

/**
 * The INSERT column list and value list for the new version: the key columns, the caller's data,
 * and the four bitemporal columns this module owns. `tx_to` is left to its `'infinity'` default.
 *
 * Fields in `data` that name a bitemporal column or the version id are ignored rather than
 * rejected, so a repository may pass `{ ...existingRow, status: 'delisted' }` without stripping
 * them first. An unknown field name is a programming error and throws.
 */
function newRowColumns<Row>(
  table: BitemporalTable<Row>,
  w: VersionWrite<Row>,
  txFrom: Date,
): { names: SQL[]; values: SQL[] } {
  const columns = columnsOf(table);
  const managed = new Set([
    table.validFrom.name,
    table.validTo.name,
    table.txFrom.name,
    table.txTo.name,
    table.provenanceId.name,
    table.versionId.name,
  ]);
  const names: SQL[] = [];
  const values: SQL[] = [];
  const seen = new Set<string>();

  const push = (column: PgColumn, value: SQL): void => {
    if (seen.has(column.name)) return;
    seen.add(column.name);
    names.push(sql`${sql.identifier(column.name)}`);
    values.push(value);
  };

  const key = asRecord(w.entityKey);
  for (const field of table.$entityKey) {
    const column = columnOrThrow(table, columns, field);
    push(column, sql`${driverValue(column, key[field])}`);
  }
  for (const [field, value] of Object.entries(asRecord(w.data))) {
    const column = columnOrThrow(table, columns, field);
    if (managed.has(column.name) || value === undefined) continue;
    push(column, sql`${driverValue(column, value)}`);
  }

  // The four columns this module owns. `data` can never have supplied them: the loop above skips
  // every managed column name, so `push` is never a no-op here.
  push(table.validFrom, sql`${w.validFrom}::timestamptz`);
  push(table.validTo, validToSql(w));
  push(table.txFrom, sql`${txFrom}::timestamptz`);
  push(table.provenanceId, sql`${w.provenanceId}::bigint`);

  return { names, values };
}

/** The current versions whose valid range overlaps `[validFrom, validTo)`, and how they stick out. */
interface OverlappingVersion extends Record<string, unknown> {
  version_id: string;
  head: boolean;
  tail: boolean;
}

/**
 * Copy one existing version into a new row, overriding the columns named in `overrides` and
 * leaving `version_id` to the sequence. The copy keeps the old data **and the old provenance**:
 * every row this produces re-asserts a fact we already held, at a new knowledge instant.
 */
async function copyVersion<Row>(
  tx: Tx,
  table: BitemporalTable<Row>,
  versionId: string,
  overrides: ReadonlyMap<string, SQL>,
): Promise<void> {
  const copied = Object.values(columnsOf(table)).filter(
    (column): column is PgColumn => column !== undefined && column.name !== table.versionId.name,
  );
  const names = copied.map((column) => sql`${sql.identifier(column.name)}`);
  const exprs = copied.map((column) => overrides.get(column.name) ?? qualified('src', column));
  await tx.execute(sql`INSERT INTO ${tableRef(table)} (${sql.join(names, sql`, `)})
    SELECT ${sql.join(exprs, sql`, `)} FROM ${tableRef(table)} src
     WHERE ${qualified('src', table.versionId)} = ${versionId}::bigint`);
}

/**
 * Re-insert the part of a closed version that lies outside the new valid range, with the OLD data
 * and the OLD provenance and the NEW `tx_from` (DATA_MODEL §1.3 step 2). `head` is
 * `[old.valid_from, w.validFrom)`, `tail` is `[w.validTo, old.valid_to)`.
 */
async function insertRemainder<Row>(
  tx: Tx,
  table: BitemporalTable<Row>,
  w: VersionWrite<Row>,
  versionId: string,
  side: 'head' | 'tail',
  txFrom: Date,
): Promise<void> {
  const overrides = new Map<string, SQL>([
    [table.txFrom.name, sql`${txFrom}::timestamptz`],
    [table.txTo.name, sql`'infinity'::timestamptz`],
  ]);
  if (side === 'head') {
    overrides.set(table.validTo.name, sql`${w.validFrom}::timestamptz`);
  } else {
    // the tail starts where the new version ends
    overrides.set(table.validFrom.name, validToSql(w));
  }
  await copyVersion(tx, table, versionId, overrides);
}

/**
 * The knowledge instant of one write: `txFrom` when the caller has one, else `clock_timestamp()`.
 *
 * Read once per call, never per statement — `clock_timestamp()` advances inside a transaction, so
 * two reads would leave a gap between a closed version's `tx_to` and its successor's `tx_from`.
 *
 * The round trip happens even when the caller supplied `txFrom`, because that is what the "not in
 * the future" half of the `txFrom` precondition is checked against. A future `tx_from` writes a
 * row no present-instant read can see and that no re-run can repair (module header), and nothing
 * in the schema can reject it (a `CHECK (tx_from <= now())` would break the
 * two-versions-in-one-transaction case, `now()` being transaction start), so it is rejected here.
 *
 * Exported because `refdata/indexMembership.ts` hand-rolls the one write this module cannot
 * express — narrowing a valid range *without* re-inserting the tail — and must take its knowledge
 * instant under the same rule.
 *
 * @param table the table being written, for the error message.
 * @throws {BitemporalWriteError} when `txFrom` is more than {@link TX_FROM_FUTURE_TOLERANCE_MS}
 *         ahead of the database clock.
 */
export async function knowledgeInstant(
  tx: Tx,
  table: string,
  txFrom: Date | undefined,
): Promise<Date> {
  // `now` is typed loosely on purpose: node-postgres hands back a `Date` for OID 1184, but a
  // driver-level type parser (or a pooled client configured elsewhere) can hand back the text,
  // and this function is on the write path of every bitemporal table.
  const res = await tx.execute<{ now: Date | string }>(sql`SELECT clock_timestamp() AS now`);
  const row = res.rows[0];
  if (row === undefined) throw new Error('clock_timestamp() returned no row');
  const dbNow = row.now instanceof Date ? row.now : new Date(row.now);
  if (txFrom === undefined) return dbNow;
  if (txFrom.getTime() > dbNow.getTime() + TX_FROM_FUTURE_TOLERANCE_MS) {
    throw new BitemporalWriteError(
      table,
      `txFrom ${txFrom.toISOString()} is in the future (database clock ${dbNow.toISOString()}); ` +
        'a knowledge instant must be an instant we already reached',
    );
  }
  return txFrom;
}

/**
 * `[validFrom, validTo)` must be a range that can contain an instant.
 *
 * Postgres reports the two ways of getting this wrong under two different SQLSTATEs — `23514` from
 * `<table>_valid_range` when the bounds are equal, `22000` from the `tstzrange()` in step 1a when
 * they are inverted — and the inverted case is raised by a SELECT before any table constraint is
 * reached. One typed error for both is what a caller can actually branch on.
 */
function assertValidRange<Row>(table: BitemporalTable<Row>, w: VersionWrite<Row>): void {
  if (w.validTo !== undefined && w.validFrom.getTime() >= w.validTo.getTime()) {
    throw new BitemporalWriteError(
      getTableName(table),
      `validFrom ${w.validFrom.toISOString()} must be strictly before validTo ${w.validTo.toISOString()}; ` +
        'a valid range is half-open [from, to) and must contain at least one instant',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Write one version, in the caller's transaction (DATA_MODEL §1.3 L221-240):
 *
 *  1. close `tx_to` on every current version of the key whose valid range overlaps
 *     `[validFrom, validTo)` — through `bt_close_tx(…, p_now)` for a single bigint key, through
 *     the equivalent UPDATE for the four composite keys, which `bt_close_tx` cannot express;
 *  2. re-insert the parts of those versions that stick out of the new valid range, with their old
 *     data and provenance and the new `tx_from`;
 *  3. insert the new row with `tx_from = w.txFrom ?? clock_timestamp()`.
 *
 * All three steps share one instant, so two versions of one key may be written in ONE transaction
 * and the first version's `tx_to` is exactly the second's `tx_from`.
 *
 * Never issues an UPDATE against a data column — `bt_guard_update` would reject it anyway.
 *
 * **Concurrent writers of one key do not serialise here.** Step 1a reads the overlapping current
 * versions in the caller's snapshot; a writer that commits between that read and step 1b's close
 * is invisible to it, and the close then re-evaluates against the newer snapshot and may close the
 * *other* writer's new version while step 2 still holds the version ids the stale SELECT returned.
 * The exclusion constraint is what makes that safe: the loser aborts with `23P01` on
 * `<table>_bt_excl` rather than committing a second current version, and no wrong row survives
 * (measured: three rows, zero overlapping current versions, zero inverted tx ranges). So a job
 * that writes one key from two transactions at once must be prepared to **retry** — `secNport.ts`
 * does — or must keep one writer per key, which is how the ingest jobs are scheduled. A
 * `pg_advisory_xact_lock` on the key would turn the abort into a wait, but these writers take
 * hundreds of keys per transaction in no fixed order, and that trades a rare `23P01` for a
 * deadlock (`40P01`) between two jobs holding each other's keys.
 *
 * @returns the new `version_id`.
 * @throws {BitemporalWriteError} when `validFrom >= validTo`, or when `txFrom` is in the future.
 *         Both are refused before any statement runs.
 * @throws a `pg` error with `code = '23P01'` when the new row would overlap a current version of
 *         the same key. Not wrapped.
 */
export async function writeVersion<Row>(
  tx: Tx,
  table: BitemporalTable<Row>,
  w: VersionWrite<Row>,
): Promise<number> {
  assertValidRange(table, w);
  const txFrom = await knowledgeInstant(tx, getTableName(table), w.txFrom);
  const keyMatch = keyPredicate(table, w.entityKey, 'cur');
  const vt = validToSql(w);

  // 1a. Which current versions does the new range touch, and how do they stick out? Read before
  //     the close, while `tx_to = 'infinity'` still identifies them.
  const overlapping = await tx.execute<OverlappingVersion>(sql`
    SELECT ${qualified('cur', table.versionId)} AS version_id,
           (${qualified('cur', table.validFrom)} < ${w.validFrom}::timestamptz) AS head,
           (${qualified('cur', table.validTo)} > ${vt}) AS tail
      FROM ${tableRef(table)} cur
     WHERE ${keyMatch}
       AND ${qualified('cur', table.txTo)} = 'infinity'
       AND tstzrange(${qualified('cur', table.validFrom)}, ${qualified('cur', table.validTo)}, '[)')
        && tstzrange(${w.validFrom}::timestamptz, ${vt}, '[)')`);

  // 1b. Close them. One bigint key is exactly what bt_close_tx takes; the composite keys of
  //     `identifiers`, `entity_classifications`, `index_members` and `entity_relations` get the
  //     equivalent UPDATE (DATA_MODEL §1.3 L243-247). Both set tx_to to the same instant.
  if (overlapping.rows.length > 0) {
    const keyField = table.$entityKey[0];
    const keyValue = keyField === undefined ? undefined : asRecord(w.entityKey)[keyField];
    if (table.$entityKey.length === 1 && keyField !== undefined && typeof keyValue === 'number') {
      const keyColumn = columnOrThrow(table, columnsOf(table), keyField);
      await tx.execute(sql`SELECT bt_close_tx(${getTableName(table)}::regclass,
                                              ${keyColumn.name},
                                              ${keyValue}::bigint,
                                              ${w.validFrom}::timestamptz,
                                              ${vt},
                                              ${txFrom}::timestamptz)`);
    } else {
      await tx.execute(sql`
        UPDATE ${tableRef(table)} cur SET ${sql.identifier(table.txTo.name)} = ${txFrom}::timestamptz
         WHERE ${keyMatch}
           AND ${qualified('cur', table.txTo)} = 'infinity'
           AND tstzrange(${qualified('cur', table.validFrom)}, ${qualified('cur', table.validTo)}, '[)')
            && tstzrange(${w.validFrom}::timestamptz, ${vt}, '[)')`);
    }
  }

  // 2. The remainders of the versions the close truncated.
  for (const row of overlapping.rows) {
    if (row.head) await insertRemainder(tx, table, w, row.version_id, 'head', txFrom);
    if (row.tail) await insertRemainder(tx, table, w, row.version_id, 'tail', txFrom);
  }

  // 3. The new version.
  const { names, values } = newRowColumns(table, w, txFrom);
  const inserted = await tx.execute<{ version_id: string }>(
    sql`INSERT INTO ${tableRef(table)} (${sql.join(names, sql`, `)})
        VALUES (${sql.join(values, sql`, `)})
        RETURNING ${sql.identifier(table.versionId.name)} AS version_id`,
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error(`${getTableName(table)}: INSERT … RETURNING version_id returned no row`);
  }
  return Number(row.version_id);
}

/**
 * `writeVersion`, except that it does nothing when the database already says exactly this.
 *
 * The no-op condition: a single current (`tx_to = 'infinity'`) version of the key whose valid
 * range **covers** `[validFrom, validTo)` and whose data columns are identical to `w.data`.
 * Then the write would add a version that asserts nothing new, and re-running an ingest job or
 * `db:seed` would grow the table without changing a single answer.
 *
 * Containment, in both directions, is the right test because it is exactly what `writeVersion`
 * would have produced. An audit round asked whether a *narrower* `validTo` on otherwise identical
 * data ought to write — the reading being that `validTo` claims the fact stops being true there,
 * and that a stored version running on to `'infinity'` loses that claim. It does not: a
 * `writeVersion` over `[2020, 2024)` against a stored `[2020, infinity)` closes the stored
 * version, re-inserts its **tail** `[2024, infinity)` with the old data, and inserts the new row —
 * three rows that answer every `bt_as_of` read exactly as the one row did (measured on PG 14: a
 * read at `validAt` 2025 still returns the fact). An explicit `validTo` asserts a fact **over a
 * window**; it never ends one. So the no-op loses no information, and making it write would only
 * split rows and churn provenance.
 *
 * Ending a fact is a different operation, and it has its own function: {@link retireVersion},
 * which keeps the head and drops the tail. A caller that means "not true from D" must call that.
 *
 * Comparison happens in Postgres, on the table's own row type: `w.data` is populated into a
 * `NULL::<table>` record via `jsonb_populate_record`, so `4.5`, `'4.5'` and `'4.500000'` all
 * become `numeric(9,6) 4.500000` before the two `jsonb` objects are compared, and a `jsonb`
 * column compares as a document rather than as a string. Only the fields present in `w.data`
 * take part, so a partial update is compared on what it actually claims (an empty
 * `data` therefore always writes). `provenanceId` is
 * deliberately excluded: a fresh fetch of unchanged data is still unchanged data.
 *
 * @returns the new `version_id`, or `null` when nothing was written.
 */
export async function upsertVersion<Row>(
  tx: Tx,
  table: BitemporalTable<Row>,
  w: VersionWrite<Row>,
): Promise<number | null> {
  assertValidRange(table, w);
  const columns = columnsOf(table);
  const managed = new Set([
    table.validFrom.name,
    table.validTo.name,
    table.txFrom.name,
    table.txTo.name,
    table.provenanceId.name,
    table.versionId.name,
  ]);

  const candidate: Record<string, unknown> = {};
  const compared: string[] = [];
  for (const [field, value] of Object.entries(asRecord(w.data))) {
    const column = columnOrThrow(table, columns, field);
    if (managed.has(column.name) || value === undefined) continue;
    candidate[column.name] = value;
    compared.push(column.name);
  }

  if (compared.length > 0) {
    const vt = validToSql(w);
    // `sql.param` keeps the array ONE parameter: a bare array inside a template is expanded to
    // `(a, b, c)` by drizzle, which is not a `text[]`.
    const keys = sql`${sql.param(compared)}::text[]`;
    const same = await tx.execute<{ same: boolean }>(sql`
      WITH cand AS (
        SELECT jsonb_populate_record(NULL::${sql.identifier(getTableName(table))},
                                     ${JSON.stringify(candidate)}::jsonb) AS r
      )
      SELECT (
               (SELECT jsonb_object_agg(k, v) FROM jsonb_each(to_jsonb(cur)) AS e(k, v) WHERE k = ANY(${keys}))
               IS NOT DISTINCT FROM
               (SELECT jsonb_object_agg(k, v) FROM jsonb_each(to_jsonb(cand.r)) AS e(k, v) WHERE k = ANY(${keys}))
             ) AS same
        FROM ${tableRef(table)} cur, cand
       WHERE ${keyPredicate(table, w.entityKey, 'cur')}
         AND ${qualified('cur', table.txTo)} = 'infinity'
         AND ${qualified('cur', table.validFrom)} <= ${w.validFrom}::timestamptz
         AND ${qualified('cur', table.validTo)} >= ${vt}`);
    if (same.rows.length === 1 && same.rows[0]?.same === true) return null;
  }

  return writeVersion(tx, table, w);
}

/** One retirement: the key, and the instant its fact stops being true. */
export interface VersionRetire<Row> {
  /** The `<table>_bt_excl` key columns, by TypeScript field name — as in {@link VersionWrite}. */
  entityKey: Partial<Row>;
  /** Becomes `valid_to`: true up to here, not true from here on. */
  validTo: Date;
  /** knownAt, under the same rule as {@link VersionWrite.txFrom}. */
  txFrom?: Date;
}

/**
 * **End** a fact: narrow every current version of the key that runs past `validTo` so that it
 * stops there, and re-open nothing after it.
 *
 * This is the one shape `writeVersion` cannot express. `writeVersion` asserts a fact over a
 * window and preserves whatever lay outside it — given `[2020, infinity)` and a write over
 * `[2020, 2024)` it re-inserts the tail `[2024, infinity)`, so the fact survives the "narrowing".
 * That is right for a correction and wrong for a delisting, an index drop or a ticker that stopped
 * being used, where the tail is exactly what must go.
 *
 * Mechanically: close the matching current versions on the transaction-time axis at the knowledge
 * instant, then re-insert the **head** `[old.valid_from, validTo)` of each — old data, old
 * provenance, new `tx_from`. A version that already starts at or after `validTo` covers nothing
 * once narrowed and is retracted outright (closed, with no head). A key that is already retired by
 * that date is left alone, so re-running the job that retires it writes nothing.
 *
 * Reads are unaffected before `validTo` and as of any earlier `knownAt`: retirement is a new
 * belief about the future, never an erasure.
 *
 * @returns the number of versions narrowed — 0 when there was nothing left to retire.
 * @throws {BitemporalWriteError} when `txFrom` is in the future.
 */
export async function retireVersion<Row>(
  tx: Tx,
  table: BitemporalTable<Row>,
  r: VersionRetire<Row>,
): Promise<number> {
  const txFrom = await knowledgeInstant(tx, getTableName(table), r.txFrom);
  const keyMatch = keyPredicate(table, r.entityKey, 'cur');

  const open = await tx.execute<{ version_id: string; keeps_head: boolean }>(sql`
    SELECT ${qualified('cur', table.versionId)} AS version_id,
           (${qualified('cur', table.validFrom)} < ${r.validTo}::timestamptz) AS keeps_head
      FROM ${tableRef(table)} cur
     WHERE ${keyMatch}
       AND ${qualified('cur', table.txTo)} = 'infinity'
       AND ${qualified('cur', table.validTo)} > ${r.validTo}::timestamptz`);
  if (open.rows.length === 0) return 0;

  await tx.execute(sql`
    UPDATE ${tableRef(table)} cur SET ${sql.identifier(table.txTo.name)} = ${txFrom}::timestamptz
     WHERE ${keyMatch}
       AND ${qualified('cur', table.txTo)} = 'infinity'
       AND ${qualified('cur', table.validTo)} > ${r.validTo}::timestamptz`);

  for (const row of open.rows) {
    if (!row.keeps_head) continue;
    await copyVersion(
      tx,
      table,
      row.version_id,
      new Map<string, SQL>([
        [table.validTo.name, sql`${r.validTo}::timestamptz`],
        [table.txFrom.name, sql`${txFrom}::timestamptz`],
        [table.txTo.name, sql`'infinity'::timestamptz`],
      ]),
    );
  }
  return open.rows.length;
}
