/**
 * `entitlements/declarations.ts` — the monthly usage declaration (ENTL-06, DATA-02,
 * ARCHITECTURE §10 rule 11, WORKPLAN WP-07).
 *
 * Once a month every licensed source wants the same answer: *how many of your natural persons
 * touched my data, at which latency tier, for which usage, and how does that reconcile with the
 * seats you pay for?* Rule 11 fixes both the shape of the answer and where it comes from —
 * "distinct users per `source_id × field_class × tier × usage` from `access_log`, reconciled
 * against `firms.seat_count`, stored in `usage_declarations`".
 *
 * ## The number is a query, not a counter
 *
 * Nothing in this module increments anything. A declaration row is derived, on demand, from the
 * `access_log` rows that ENTL-04 already wrote — the same rows a regulator or an exchange auditor
 * would be handed. There is no second bookkeeping path that could disagree with the audit log, and
 * a declaration can be regenerated years later from the partitions that survive.
 *
 * ## Provenance of the number (DATA-02): `query_sql_hash`
 *
 * `usage_declarations.query_sql_hash` is the sha256 of **the SQL text that produced the row**, so
 * that the row can be re-derived and checked. That claim is only worth something if the text that
 * was hashed and the text that ran are provably the same string, and the only way to be sure of
 * that is to never write the statement twice:
 *
 *  1. {@link declarationQuerySql} is the single place the aggregate exists. It takes the month and
 *     returns one canonical string — every literal inlined, no bind parameters, so the text is
 *     complete and self-contained and re-running it needs nothing but the text.
 *  2. {@link generateDeclarations} calls it **once** into a local `const`. The hash is taken of
 *     that variable and {@link declarationUpsertSql} embeds *that same variable* verbatim as the
 *     `FROM ( … ) q` subquery of the upsert. Neither the hash nor the executed statement re-derives
 *     the text, so there is no second expression that could drift from the first.
 *  3. The upsert is then checked, at run time, to contain the hashed text verbatim
 *     (`upsert.includes(select)`); a future refactor that reformats the subquery on its way into
 *     the statement throws instead of storing a hash of something that did not run.
 *
 * The month is part of the hashed text, so two months never share a hash;
 * `generated_at` is not, because it belongs to the writing of the row, not to the deriving of the
 * number. {@link verifyDeclarationHash} is the other end of the loop: hand it a month and a stored
 * hash and it recomputes the canonical text and says whether that hash could have come from it.
 *
 * ## What is counted
 *
 * A declaration reports data that was *served*. A denied read delivered nothing to the user and
 * has no tier to declare, so rows with `decision = 'deny'` are excluded, as are rows with a NULL
 * `tier` (the two are the same set, and both predicates are written out rather than assumed). A
 * `downgrade` **is** counted, at the tier that was actually served — that is the point of the
 * column, and declaring a downgraded read at the requested tier would over-report to the vendor.
 *
 * `seat_count` is captured from `firms` **at generation time** and stored on the row, because it is
 * the reconciliation input: the declaration is a statement about a month, and a seat count read a
 * year later is a statement about today.
 */

import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Clock, FieldClass, Tier } from '@terminal/core';

import type { Db, Tx } from '../db/client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Month handling
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM` or `YYYY-MM-DD`; anything else is rejected before it can reach the SQL text. */
const MONTH_INPUT = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;

/**
 * Normalise a month to the first day of that month, `YYYY-MM-01` — the form
 * `usage_declarations.month` stores and the form the canonical SQL embeds.
 *
 * @throws when the input is not a calendar month. The value is inlined into SQL text, so it is
 *         validated here rather than escaped later.
 */
export function normaliseMonth(month: string): string {
  const match = MONTH_INPUT.exec(month.trim());
  if (match === null) {
    throw new Error(`declarations: '${month}' is not a month — expected YYYY-MM or YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const mon = Number(match[2]);
  if (mon < 1 || mon > 12) {
    throw new Error(`declarations: '${month}' has no month ${String(mon)}`);
  }
  return `${String(year).padStart(4, '0')}-${String(mon).padStart(2, '0')}-01`;
}

/** The first day of the month after `month` (`YYYY-MM-01`) — the exclusive end of the window. */
export function nextMonth(month: string): string {
  const first = normaliseMonth(month);
  const year = Number(first.slice(0, 4));
  const mon = Number(first.slice(5, 7));
  return mon === 12
    ? `${String(year + 1).padStart(4, '0')}-01-01`
    : `${String(year).padStart(4, '0')}-${String(mon + 1).padStart(2, '0')}-01`;
}

/** The UTC calendar month containing `epochMs`, as `YYYY-MM-01`. */
export function monthOf(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** The UTC calendar month before the one containing `epochMs` — what the monthly job declares. */
export function previousMonthOf(epochMs: number): string {
  const first = monthOf(epochMs);
  const year = Number(first.slice(0, 4));
  const mon = Number(first.slice(5, 7));
  return mon === 1
    ? `${String(year - 1).padStart(4, '0')}-12-01`
    : `${String(year).padStart(4, '0')}-${String(mon - 1).padStart(2, '0')}-01`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The canonical query — the text that is hashed and the text that runs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The aggregate of rule 11, as one self-contained statement.
 *
 * Every literal is inlined (the month is validated by {@link normaliseMonth} first) precisely so
 * that the returned string is the *whole* recipe: paste it into `psql` against the same
 * `access_log` partitions and the declaration rows come back, which is what makes the stored hash
 * an auditable claim rather than a decoration.
 *
 * The text is deliberately stable — fixed column order, fixed whitespace, a trailing `ORDER BY`
 * that makes two runs byte-identical in their output as well as in their text. Any edit to this
 * function changes every future hash, which is correct: it is a different derivation.
 */
export function declarationQuerySql(month: string): string {
  const from = normaliseMonth(month);
  const to = nextMonth(from);
  return [
    `-- usage_declarations ${from} (ENTL-06, DATA-02, ARCHITECTURE §10 rule 11)`,
    `SELECT a.source_id AS source_id,`,
    `       a.firm_id AS firm_id,`,
    `       a.field_class AS field_class,`,
    `       a.tier AS tier,`,
    `       count(DISTINCT a.user_id) FILTER (WHERE a.usage = 'display')::int AS display_users,`,
    `       count(DISTINCT a.user_id) FILTER (WHERE a.usage = 'export')::int AS export_users,`,
    `       count(DISTINCT a.user_id) FILTER (WHERE a.usage = 'api')::int AS api_users,`,
    `       count(DISTINCT a.user_id)::int AS distinct_users,`,
    `       count(DISTINCT a.instrument_id)::int AS instrument_count,`,
    `       count(*)::bigint AS data_points,`,
    `       f.seat_count::int AS seat_count`,
    `  FROM access_log a`,
    `  JOIN firms f ON f.firm_id = a.firm_id`,
    ` WHERE a.ts >= TIMESTAMPTZ '${from} 00:00:00+00'`,
    `   AND a.ts < TIMESTAMPTZ '${to} 00:00:00+00'`,
    `   AND a.decision <> 'deny'`,
    `   AND a.tier IS NOT NULL`,
    ` GROUP BY a.source_id, a.firm_id, a.field_class, a.tier, f.seat_count`,
    ` ORDER BY a.source_id, a.firm_id, a.field_class, a.tier`,
  ].join('\n');
}

/** sha256, lower-case hex — what `usage_declarations.query_sql_hash` (char(64)) holds. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The hash a declaration of `month` carries: sha256 of {@link declarationQuerySql}'s text. */
export function declarationQueryHash(month: string): string {
  return sha256Hex(declarationQuerySql(month));
}

/**
 * Re-derive the canonical text for `month` and say whether `storedHash` could have come from it.
 *
 * The audit question ENTL-06 exists to answer — "is this number still the number that query
 * produces?" — starts here: a `false` means the derivation changed since the row was written, and
 * the row must be regenerated before it is believed.
 */
export function verifyDeclarationHash(
  month: string,
  storedHash: string,
): { ok: boolean; expected: string; sql: string } {
  const text = declarationQuerySql(month);
  const expected = sha256Hex(text);
  return { ok: expected === storedHash.trim().toLowerCase(), expected, sql: text };
}

/** A SQL string literal — used only for values this module generated (hashes, ISO instants). */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The upsert, built **around** the already-hashed select text.
 *
 * `selectSql` is embedded verbatim: the caller passes the same string it hashed, and this function
 * never regenerates it. `ON CONFLICT` on the documented unique key `(month, source_id, firm_id,
 * field_class, tier)` is what makes a regeneration an update rather than a duplicate.
 *
 * `reconciled_at` survives a regeneration that changed nothing and is cleared by one that changed a
 * counted column: a reconciliation is a statement about particular numbers, so numbers that moved
 * un-reconcile the row. `billing_ref` is never touched — it is the vendor's reference for the
 * month, not for a generation of it.
 */
export function declarationUpsertSql(input: {
  month: string;
  selectSql: string;
  querySqlHash: string;
  generatedAt: string;
}): string {
  const month = normaliseMonth(input.month);
  const counted = [
    'display_users',
    'export_users',
    'api_users',
    'distinct_users',
    'instrument_count',
    'data_points',
    'seat_count',
  ];
  return [
    `INSERT INTO usage_declarations (`,
    `  month, source_id, firm_id, field_class, tier,`,
    `  display_users, export_users, api_users, distinct_users,`,
    `  instrument_count, data_points, seat_count, query_sql_hash, generated_at)`,
    `SELECT DATE ${literal(month)}, q.source_id, q.firm_id, q.field_class, q.tier,`,
    `       q.display_users, q.export_users, q.api_users, q.distinct_users,`,
    `       q.instrument_count, q.data_points, q.seat_count,`,
    `       ${literal(input.querySqlHash)}, TIMESTAMPTZ ${literal(input.generatedAt)}`,
    `  FROM (`,
    input.selectSql,
    `  ) q`,
    `ON CONFLICT (month, source_id, firm_id, field_class, tier) DO UPDATE SET`,
    ...counted.map((c) => `  ${c} = EXCLUDED.${c},`),
    `  query_sql_hash = EXCLUDED.query_sql_hash,`,
    `  generated_at = EXCLUDED.generated_at,`,
    `  reconciled_at = CASE WHEN (${counted.map((c) => `usage_declarations.${c}`).join(', ')})`,
    `                       IS DISTINCT FROM (${counted.map((c) => `EXCLUDED.${c}`).join(', ')})`,
    `                  THEN NULL ELSE usage_declarations.reconciled_at END`,
    `RETURNING declaration_id, (xmax = 0) AS was_inserted, month::text AS month, source_id,`,
    `          firm_id, field_class, tier, display_users, export_users, api_users, distinct_users,`,
    `          instrument_count, data_points, seat_count, query_sql_hash,`,
    `          generated_at, reconciled_at, billing_ref`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `usage_declarations` row as generated, plus its reconciliation against `firms.seat_count`. */
export interface DeclarationRow {
  declarationId: number;
  /** First day of the month, `YYYY-MM-DD`. */
  month: string;
  sourceId: string;
  firmId: number;
  fieldClass: FieldClass;
  tier: Tier;
  displayUsers: number;
  exportUsers: number;
  apiUsers: number;
  distinctUsers: number;
  instrumentCount: number;
  dataPoints: number;
  /** `firms.seat_count` as it stood at generation. */
  seatCount: number;
  querySqlHash: string;
  generatedAt: string;
  reconciledAt: string | null;
  billingRef: string | null;
  /** `true` when this generation created the row, `false` when it updated an existing one. */
  wasInserted: boolean;
  /** ENTL-06 reconciliation: `distinctUsers <= seatCount`. */
  withinSeats: boolean;
}

/** A firm whose declared users outran the seats it pays for, in one month. */
export interface SeatExcess {
  firmId: number;
  seatCount: number;
  /** The largest `distinct_users` any single declaration row reported for the firm. */
  maxDistinctUsers: number;
  /** Distinct users across every source and tier of the month. */
  sources: readonly string[];
}

export interface DeclarationResult {
  /** `YYYY-MM-DD`, the first of the declared month. */
  month: string;
  rows: readonly DeclarationRow[];
  inserted: number;
  updated: number;
  /** sha256 of {@link sql}; what every row in {@link rows} carries. */
  querySqlHash: string;
  /** The canonical text that was hashed and that ran. */
  sql: string;
  /** Firms whose declaration does not reconcile with `firms.seat_count`. */
  seatExcess: readonly SeatExcess[];
}

interface UpsertRow extends Record<string, unknown> {
  declaration_id: string | number;
  was_inserted: boolean;
  month: string;
  source_id: string;
  firm_id: string | number;
  field_class: FieldClass;
  tier: Tier;
  display_users: number;
  export_users: number;
  api_users: number;
  distinct_users: number;
  instrument_count: number;
  data_points: string | number;
  seat_count: number;
  query_sql_hash: string;
  generated_at: Date | string;
  reconciled_at: Date | string | null;
  billing_ref: string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Generation
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface DeclarationDeps {
  db: Db | Tx;
  clock: Clock;
}

/**
 * Generate — or regenerate — the declarations of one month.
 *
 * Idempotent by the documented unique key: running it twice on the same month updates the same
 * rows and returns `inserted: 0` the second time. That is what lets the monthly job be retried, and
 * what lets an operator re-run a month after a late `access_log` partition was attached.
 *
 * The statement is one round trip: the aggregate, the upsert and the read-back are a single
 * `INSERT … SELECT … RETURNING`, so no other transaction can slip between counting and storing.
 */
export async function generateDeclarations(
  deps: DeclarationDeps,
  month: string,
): Promise<DeclarationResult> {
  const first = normaliseMonth(month);

  // ── DATA-02: one string, hashed and executed. Neither line re-derives the other. ──────────
  const selectSql = declarationQuerySql(first);
  const querySqlHash = sha256Hex(selectSql);
  const generatedAt = new Date(deps.clock.now()).toISOString();
  const upsertSql = declarationUpsertSql({
    month: first,
    selectSql,
    querySqlHash,
    generatedAt,
  });
  if (!upsertSql.includes(selectSql)) {
    // Unreachable while `declarationUpsertSql` embeds the argument verbatim — which is exactly why
    // it is asserted: the day it stops doing so, the hash stops describing what ran.
    throw new Error(
      'declarations: the executed statement does not contain the hashed query text verbatim — ' +
        'query_sql_hash would not describe the SQL that produced the row (DATA-02)',
    );
  }

  const result = await deps.db.execute<UpsertRow>(sql.raw(upsertSql));

  const rows: DeclarationRow[] = result.rows.map((r) => {
    const distinctUsers = Number(r.distinct_users);
    const seatCount = Number(r.seat_count);
    return {
      declarationId: Number(r.declaration_id),
      month: r.month,
      sourceId: r.source_id,
      firmId: Number(r.firm_id),
      fieldClass: r.field_class,
      tier: r.tier,
      displayUsers: Number(r.display_users),
      exportUsers: Number(r.export_users),
      apiUsers: Number(r.api_users),
      distinctUsers,
      instrumentCount: Number(r.instrument_count),
      dataPoints: Number(r.data_points),
      seatCount,
      querySqlHash: r.query_sql_hash,
      generatedAt: iso(r.generated_at),
      reconciledAt: r.reconciled_at === null ? null : iso(r.reconciled_at),
      billingRef: r.billing_ref,
      wasInserted: r.was_inserted === true,
      withinSeats: distinctUsers <= seatCount,
    };
  });

  return {
    month: first,
    rows,
    inserted: rows.filter((r) => r.wasInserted).length,
    updated: rows.filter((r) => !r.wasInserted).length,
    querySqlHash,
    sql: selectSql,
    seatExcess: seatExcessOf(rows),
  };
}

/**
 * The firms whose month does not reconcile.
 *
 * Grants are on natural persons (ENTL-03), so the honest comparison is "how many distinct people
 * used this source" against "how many seats the firm pays for". A firm is flagged when any single
 * `source × field class × tier` row named more distinct users than the firm has seats — that is an
 * under-licensed firm on that one source, and averaging it away across sources would hide it.
 */
export function seatExcessOf(rows: readonly DeclarationRow[]): SeatExcess[] {
  const byFirm = new Map<number, { seatCount: number; max: number; sources: Set<string> }>();
  for (const row of rows) {
    if (row.withinSeats) continue;
    const entry = byFirm.get(row.firmId) ?? {
      seatCount: row.seatCount,
      max: 0,
      sources: new Set<string>(),
    };
    entry.seatCount = row.seatCount;
    entry.max = Math.max(entry.max, row.distinctUsers);
    entry.sources.add(row.sourceId);
    byFirm.set(row.firmId, entry);
  }
  return [...byFirm.entries()]
    .map(([firmId, e]) => ({
      firmId,
      seatCount: e.seatCount,
      maxDistinctUsers: e.max,
      sources: [...e.sources].sort(),
    }))
    .sort((a, b) => a.firmId - b.firmId);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reading back — what `GET /admin/declarations` and the reconcile route serve (API.md §5.14)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface DeclarationFilter {
  month: string;
  sourceId?: string;
  firmId?: number;
}

/** The stored declarations of a month, newest generation first within the documented ordering. */
export async function listDeclarations(
  db: Db | Tx,
  filter: DeclarationFilter,
): Promise<DeclarationRow[]> {
  const first = normaliseMonth(filter.month);
  const result = await db.execute<UpsertRow>(sql`
    SELECT declaration_id, false AS was_inserted, month::text AS month, source_id, firm_id,
           field_class, tier, display_users, export_users, api_users, distinct_users,
           instrument_count, data_points, seat_count, query_sql_hash, generated_at,
           reconciled_at, billing_ref
      FROM usage_declarations
     WHERE month = ${first}::date
       AND (${filter.sourceId ?? null}::text IS NULL OR source_id = ${filter.sourceId ?? null})
       AND (${filter.firmId ?? null}::bigint IS NULL OR firm_id = ${filter.firmId ?? null})
     ORDER BY source_id, firm_id, field_class, tier`);
  return result.rows.map((r) => {
    const distinctUsers = Number(r.distinct_users);
    const seatCount = Number(r.seat_count);
    return {
      declarationId: Number(r.declaration_id),
      month: r.month,
      sourceId: r.source_id,
      firmId: Number(r.firm_id),
      fieldClass: r.field_class,
      tier: r.tier,
      displayUsers: Number(r.display_users),
      exportUsers: Number(r.export_users),
      apiUsers: Number(r.api_users),
      distinctUsers,
      instrumentCount: Number(r.instrument_count),
      dataPoints: Number(r.data_points),
      seatCount,
      querySqlHash: r.query_sql_hash,
      generatedAt: iso(r.generated_at),
      reconciledAt: r.reconciled_at === null ? null : iso(r.reconciled_at),
      billingRef: r.billing_ref,
      wasInserted: false,
      withinSeats: distinctUsers <= seatCount,
    };
  });
}

/**
 * Mark one declaration reconciled against the vendor's invoice
 * (`POST /admin/declarations/:declarationId/reconcile`).
 *
 * @returns `false` when no such declaration exists, so the route can answer 404 rather than 200.
 */
export async function reconcileDeclaration(
  deps: DeclarationDeps,
  declarationId: number,
  billingRef: string,
): Promise<boolean> {
  const at = new Date(deps.clock.now()).toISOString();
  const result = await deps.db.execute<{ declaration_id: string }>(sql`
    UPDATE usage_declarations
       SET reconciled_at = ${at}::timestamptz,
           billing_ref = ${billingRef}
     WHERE declaration_id = ${declarationId}
    RETURNING declaration_id`);
  return result.rows.length > 0;
}
