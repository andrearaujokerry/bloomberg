/**
 * Index membership — `indices` and `index_members`, REF-07 (DATA_MODEL §5 L860-955, WORKPLAN
 * §WP-04 L700-702).
 *
 * `indices` is a plain lookup table (one row per index whose membership we track: code, the
 * `SPX Index` instrument, the proxy fund that files the holdings, and which source supplies the
 * membership). `index_members` is bitemporal on the composite key `(index_id, instrument_id)`,
 * so every question about membership is asked as of a **pair** of instants: what the roster was
 * on a date, as far as we knew on another (REF-03).
 *
 * ## The snapshot model (DATA_MODEL L947-951)
 *
 * Membership arrives as whole snapshots — monthly from the SPY N-PORT filing (`sec.archives`,
 * `repPdDate`), daily from the SSGA holdings file (`ssga.holdings`, the file date) — never as a
 * stream of adds and drops. `recordSnapshot()` turns one such snapshot into bitemporal versions:
 *
 *   * every constituent is written with `valid_from = as_of_date`, through `upsertMember()`,
 *     which writes **nothing** when the weight, share count, market value and source are
 *     unchanged. That is what keeps a daily SSGA file from adding 503 rows a day that answer no
 *     question differently, and what makes a re-run of the job a no-op (QA-02);
 *   * a constituent that is **absent** from the snapshot has its current version narrowed to
 *     `valid_to = as_of_date` by `retireMember()`. It was a member until that date and is not one
 *     from it, which is precisely what a past-dated read must keep reporting.
 *
 * Adds and drops (the MEMB screen, and REF-07's "historical membership") are therefore *derived*
 * by `changesBetween()` from two as-of reads rather than stored: there is no adds/drops table to
 * fall out of step with the rosters.
 *
 * ## Why `upsertMember` and `retireMember` are not `upsertVersion` / `writeVersion`
 *
 * `as_of_date` is a data column that changes with **every** snapshot even when the weight does
 * not (it is `valid_from::date` by construction). A plain `upsertVersion` compares every field it
 * is given, so it would see a change on every file and write a version a day per constituent.
 * `upsertMember` therefore compares the four columns that carry information — `weight`, `shares`,
 * `market_value`, `source_id` — in Postgres, at the column's own precision (a `weight` of
 * `0.00083321585405` is `numeric(12,10) 0.0008332159` once stored, and comparing it in JavaScript
 * would report a change forever), and delegates to `writeVersion` only when one of them moved.
 *
 * Narrowing needs its own operation for a sharper reason: `writeVersion` with an explicit
 * `validTo` closes the old version and then **re-inserts its tail** `[validTo, infinity)`, i.e.
 * resurrects the membership after the drop (measured on PG 14). Retirement must close a valid
 * range and keep only the head, which is `db/bitemporal.ts#retireVersion` — `retireMember` is that
 * function with `as_of_date` parsed into an instant.
 *
 * Every write takes the knowledge instant explicitly (`txFrom`), because ingest replays and seeds
 * write several snapshots inside one transaction and `now()` is transaction start (WORKPLAN
 * L663-680). Callers must pass strictly increasing instants for one key.
 */

import { and, eq, sql } from 'drizzle-orm';

import {
  asOf,
  bitemporal,
  knowledgeInstant as btKnowledgeInstant,
  retireVersion,
  writeVersion,
} from '../db/bitemporal.js';
import { indexMembers, indices } from '../db/schema/index.js';

import type { AsOf, BitemporalTable, VersionWrite } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';

/** `index_members`, tagged with the `index_members_bt_excl` key columns. */
export const btIndexMembers: BitemporalTable<typeof indexMembers.$inferSelect> = bitemporal(
  indexMembers,
  'indexId',
  'instrumentId',
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `indices` row. */
export interface IndexRecord {
  indexId: number;
  /** `'SPX'`, `'NDX'`, … — unique. */
  code: string;
  /** The index instrument itself (`SPX Index`) — unique. */
  instrumentId: number;
  /** SPY for SPX: the fund whose filings supply the membership. */
  proxyFundInstrumentId: number | null;
  /** `'sec.archives'` | `'ssga.holdings'`; `null` for a WEI-only index with no membership feed. */
  membershipSourceId: string | null;
  provider: string;
}

/** One constituent, as of the `(validAt, knownAt)` pair the read was made with. */
export interface IndexMemberRecord {
  versionId: number;
  indexId: number;
  instrumentId: number;
  /** Fraction of the index, not a percentage: N-PORT `pctVal / 100`, SSGA `Weight / 100`. */
  weight: number | null;
  shares: number | null;
  marketValue: number | null;
  /** The snapshot this version came from — `valid_from::date`. */
  asOfDate: string;
  sourceId: string;
  provenanceId: number;
  /** The valid range, as text, so the `'infinity'` sentinel survives (`new Date` cannot hold it). */
  validFrom: string;
  validTo: string;
}

/** One constituent of an incoming snapshot. */
export interface SnapshotMember {
  instrumentId: number;
  /** Fraction, not percent. A string is passed through to `numeric` untouched. */
  weight?: number | string | null;
  shares?: number | string | null;
  marketValue?: number | string | null;
}

/** One weights snapshot: an N-PORT report period, or one SSGA holdings file. */
export interface MembershipSnapshot {
  indexId: number;
  /** `YYYY-MM-DD` — N-PORT `repPdDate` or the SSGA file date. Becomes `valid_from`. */
  asOfDate: string;
  /** `'sec.archives'` | `'ssga.holdings'`. */
  sourceId: string;
  provenanceId: number;
  members: readonly SnapshotMember[];
  /**
   * The knowledge instant (`tx_from`): the filing's `acceptanceDateTime`, the file's fetch time.
   * Omitted → `clock_timestamp()`. Must be strictly later than the `tx_from` of any version it
   * supersedes (`bt_guard_update`).
   */
  txFrom?: Date;
}

/** What one snapshot did to the table. Row counts, not booleans: a boolean can lie (QA-02). */
export interface SnapshotResult {
  /** Constituents whose weight/shares/value/source moved, so a new version was written. */
  written: number;
  /** Constituents the snapshot repeated verbatim — no row written. */
  unchanged: number;
  /** Constituents absent from the snapshot, narrowed to `valid_to = as_of_date`. */
  retired: number;
}

/** The difference between two rosters (REF-07 "adds and drops between two dates"). */
export interface MembershipChanges {
  /** In the later roster and not the earlier one. */
  adds: IndexMemberRecord[];
  /** In the earlier roster and not the later one. */
  drops: IndexMemberRecord[];
  /** In both, with a different weight. */
  reweights: {
    instrumentId: number;
    from: number | null;
    to: number | null;
    /** `to − from`, in weight fractions; `null` when either side has no weight. */
    delta: number | null;
  }[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Dates
// ─────────────────────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `'2026-06-30'` → the UTC midnight that `valid_from` holds for that snapshot. */
export function instantOfDate(date: string): Date {
  if (!DATE_RE.test(date)) {
    throw new RangeError(
      `indexMembership: expected a YYYY-MM-DD date, got ${JSON.stringify(date)}`,
    );
  }
  return new Date(`${date}T00:00:00.000Z`);
}

/**
 * "The roster on `date`, as far as we knew at `knownAt`" — the `(validAt, knownAt)` pair of
 * DATA_MODEL L950. `valid_from` is the snapshot date at UTC midnight and `bt_as_of` is half-open,
 * so the snapshot taken on `date` is itself included.
 */
export function membershipAsOf(date: string, knownAt: Date): AsOf {
  return { validAt: instantOfDate(date), knownAt };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `numeric` arrives as a string; `null` stays `null`. */
function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/** A `numeric` bind value. Numbers are stringified so the driver never sends a float8. */
function numericIn(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) {
    throw new RangeError(`indexMembership: ${String(value)} is not a finite numeric value`);
  }
  return String(value);
}

const MEMBER_FIELDS = {
  versionId: indexMembers.versionId,
  indexId: indexMembers.indexId,
  instrumentId: indexMembers.instrumentId,
  weight: indexMembers.weight,
  shares: indexMembers.shares,
  marketValue: indexMembers.marketValue,
  asOfDate: indexMembers.asOfDate,
  sourceId: indexMembers.sourceId,
  provenanceId: indexMembers.provenanceId,
  validFrom: indexMembers.validFrom,
  validTo: indexMembers.validTo,
} as const;

/** Exactly what `select(MEMBER_FIELDS)` yields: every `numeric` as a string, every date as text. */
interface MemberRow {
  versionId: number;
  indexId: number;
  instrumentId: number;
  weight: string | null;
  shares: string | null;
  marketValue: string | null;
  asOfDate: string;
  sourceId: string;
  provenanceId: number;
  validFrom: string;
  validTo: string;
}

function toRecord(row: MemberRow): IndexMemberRecord {
  return {
    versionId: row.versionId,
    indexId: row.indexId,
    instrumentId: row.instrumentId,
    weight: num(row.weight),
    shares: num(row.shares),
    marketValue: num(row.marketValue),
    asOfDate: row.asOfDate,
    sourceId: row.sourceId,
    provenanceId: row.provenanceId,
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}

/**
 * One `clock_timestamp()` per write, so a close and its remainder share an instant.
 *
 * Delegates to `db/bitemporal.ts` rather than repeating the read, so the hand-rolled writes below
 * are held to the same rule as `writeVersion`: a `txFrom` in the future is refused
 * (`BitemporalWriteError`) instead of writing a row no present-instant read can see.
 */
const knowledgeInstant = (tx: Tx, txFrom: Date | undefined): Promise<Date> =>
  btKnowledgeInstant(tx, 'index_members', txFrom);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `indices`
// ─────────────────────────────────────────────────────────────────────────────────────────────

const INDEX_FIELDS = {
  indexId: indices.indexId,
  code: indices.code,
  instrumentId: indices.instrumentId,
  proxyFundInstrumentId: indices.proxyFundInstrumentId,
  membershipSourceId: indices.membershipSourceId,
  provider: indices.provider,
} as const;

/** The index with this code (`'SPX'`), or `null`. */
export async function findIndexByCode(tx: Tx, code: string): Promise<IndexRecord | null> {
  const rows = await tx.select(INDEX_FIELDS).from(indices).where(eq(indices.code, code)).limit(1);
  return rows[0] ?? null;
}

/** The index whose own instrument is `instrumentId` (`SPX Index` → the SPX row), or `null`. */
export async function findIndexByInstrumentId(
  tx: Tx,
  instrumentId: number,
): Promise<IndexRecord | null> {
  const rows = await tx
    .select(INDEX_FIELDS)
    .from(indices)
    .where(eq(indices.instrumentId, instrumentId))
    .limit(1);
  return rows[0] ?? null;
}

/** By primary key, or `null`. */
export async function getIndex(tx: Tx, indexId: number): Promise<IndexRecord | null> {
  const rows = await tx
    .select(INDEX_FIELDS)
    .from(indices)
    .where(eq(indices.indexId, indexId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Insert or update the `indices` row for `code` (the table is not bitemporal: an index's proxy
 * fund or membership source is configuration, not a fact with a valid time). Idempotent.
 */
export async function upsertIndex(
  tx: Tx,
  record: Omit<IndexRecord, 'indexId'>,
): Promise<IndexRecord> {
  const rows = await tx
    .insert(indices)
    .values({
      code: record.code,
      instrumentId: record.instrumentId,
      proxyFundInstrumentId: record.proxyFundInstrumentId,
      membershipSourceId: record.membershipSourceId,
      provider: record.provider,
    })
    .onConflictDoUpdate({
      target: indices.code,
      set: {
        instrumentId: record.instrumentId,
        proxyFundInstrumentId: record.proxyFundInstrumentId,
        membershipSourceId: record.membershipSourceId,
        provider: record.provider,
      },
    })
    .returning(INDEX_FIELDS);
  const row = rows[0];
  if (row === undefined) throw new Error(`upsertIndex(${record.code}): INSERT returned no row`);
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reads (REF-07)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The constituents of `indexId` valid at `at.validAt` as known at `at.knownAt`, heaviest first.
 *
 * "Members of SPX on 2024-03-15 as known on 2024-04-01" is
 * `membersAsOf(tx, spx, membershipAsOf('2024-03-15', new Date('2024-04-01')))` — the
 * `bt_as_of(...)` predicate of DATA_MODEL L950 verbatim, over `index_members_asof_idx`.
 */
export async function membersAsOf(tx: Tx, indexId: number, at: AsOf): Promise<IndexMemberRecord[]> {
  const rows = await tx
    .select(MEMBER_FIELDS)
    .from(indexMembers)
    .where(and(eq(indexMembers.indexId, indexId), asOf(btIndexMembers, at)))
    .orderBy(sql`${indexMembers.weight} DESC NULLS LAST`, indexMembers.instrumentId);
  return rows.map(toRecord);
}

/** One constituent, or `null` when the instrument was not in the index at that pair of instants. */
export async function memberAsOf(
  tx: Tx,
  indexId: number,
  instrumentId: number,
  at: AsOf,
): Promise<IndexMemberRecord | null> {
  const rows = await tx
    .select(MEMBER_FIELDS)
    .from(indexMembers)
    .where(
      and(
        eq(indexMembers.indexId, indexId),
        eq(indexMembers.instrumentId, instrumentId),
        asOf(btIndexMembers, at),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

/**
 * Σ weight over the roster, summed in Postgres at `numeric` precision and only then converted —
 * 503 doubles added in JavaScript drift in the last places, and this number is asserted against 1.
 *
 * A complete N-PORT or SSGA snapshot sums to ≈ 1 (not exactly: the filing rounds each `pctVal`,
 * and the fund holds a little cash). `0` when the index has no members at that pair of instants.
 */
export async function weightSumAsOf(tx: Tx, indexId: number, at: AsOf): Promise<number> {
  const res = await tx.execute<{ total: string | null }>(sql`
    SELECT coalesce(sum(${indexMembers.weight}), 0)::text AS total
      FROM ${indexMembers}
     WHERE ${indexMembers.indexId} = ${indexId}::bigint
       AND ${asOf(btIndexMembers, at)}`);
  return Number(res.rows[0]?.total ?? '0');
}

/** The indices that held `instrumentId` at that pair of instants (`index_members_inst_idx`). */
export async function indicesForInstrument(
  tx: Tx,
  instrumentId: number,
  at: AsOf,
): Promise<(IndexRecord & { weight: number | null })[]> {
  const rows = await tx
    .select({ ...INDEX_FIELDS, weight: indexMembers.weight })
    .from(indexMembers)
    .innerJoin(indices, eq(indices.indexId, indexMembers.indexId))
    .where(and(eq(indexMembers.instrumentId, instrumentId), asOf(btIndexMembers, at)))
    .orderBy(indices.code);
  return rows.map((row) => ({ ...row, weight: num(row.weight) }));
}

/**
 * Adds, drops and reweights between two as-of reads (REF-07; the MEMB screen's change block).
 *
 * Both ends carry their own `knownAt`, so "what changed between the N-PORT date and the SSGA
 * date" and "what we *now* think changed between them" are the same call with different pairs.
 * `adds` carry the later roster's row, `drops` the earlier one's.
 */
export async function changesBetween(
  tx: Tx,
  indexId: number,
  from: AsOf,
  to: AsOf,
): Promise<MembershipChanges> {
  const [before, after] = await Promise.all([
    membersAsOf(tx, indexId, from),
    membersAsOf(tx, indexId, to),
  ]);
  const beforeById = new Map(before.map((m) => [m.instrumentId, m]));
  const afterById = new Map(after.map((m) => [m.instrumentId, m]));

  const adds = after.filter((m) => !beforeById.has(m.instrumentId));
  const drops = before.filter((m) => !afterById.has(m.instrumentId));
  const reweights: MembershipChanges['reweights'] = [];
  for (const member of after) {
    const previous = beforeById.get(member.instrumentId);
    if (previous === undefined || previous.weight === member.weight) continue;
    reweights.push({
      instrumentId: member.instrumentId,
      from: previous.weight,
      to: member.weight,
      delta:
        previous.weight === null || member.weight === null ? null : member.weight - previous.weight,
    });
  }
  return { adds, drops, reweights };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One constituent of one snapshot. */
export interface MemberWrite extends SnapshotMember {
  indexId: number;
  asOfDate: string;
  sourceId: string;
  provenanceId: number;
  txFrom?: Date;
}

/**
 * Write one constituent's version — unless the database already says exactly this.
 *
 * "Exactly this" is: a current version whose valid range already covers `[as_of_date, infinity)`
 * and whose `weight`, `shares`, `market_value` and `source_id` are equal **at the column's own
 * precision**, which is why the comparison is a `numeric` comparison in Postgres and not a
 * float comparison here. `as_of_date` is deliberately not compared: it is the date the current
 * version started, and a snapshot that repeats a weight has not made the fact any newer.
 *
 * @returns the new `version_id`, or `null` when nothing was written.
 */
export async function upsertMember(tx: Tx, w: MemberWrite): Promise<number | null> {
  const validFrom = instantOfDate(w.asOfDate);
  const weight = numericIn(w.weight);
  const shares = numericIn(w.shares);
  const marketValue = numericIn(w.marketValue);

  const same = await tx.execute<{ version_id: string }>(sql`
    SELECT version_id
      FROM ${indexMembers}
     WHERE ${indexMembers.indexId} = ${w.indexId}::bigint
       AND ${indexMembers.instrumentId} = ${w.instrumentId}::bigint
       AND ${indexMembers.txTo} = 'infinity'
       AND ${indexMembers.validFrom} <= ${validFrom}::timestamptz
       AND ${indexMembers.validTo} = 'infinity'
       AND ${indexMembers.weight} IS NOT DISTINCT FROM ${weight}::numeric(12,10)
       AND ${indexMembers.shares} IS NOT DISTINCT FROM ${shares}::numeric(20,4)
       AND ${indexMembers.marketValue} IS NOT DISTINCT FROM ${marketValue}::numeric(20,2)
       AND ${indexMembers.sourceId} = ${w.sourceId}
     LIMIT 1`);
  if (same.rows.length > 0) return null;

  const write: VersionWrite<typeof indexMembers.$inferSelect> = {
    entityKey: { indexId: w.indexId, instrumentId: w.instrumentId },
    validFrom,
    data: {
      indexId: w.indexId,
      instrumentId: w.instrumentId,
      weight,
      shares,
      marketValue,
      asOfDate: w.asOfDate,
      sourceId: w.sourceId,
    },
    provenanceId: w.provenanceId,
    reason: 'change',
  };
  if (w.txFrom !== undefined) write.txFrom = w.txFrom;
  return writeVersion(tx, btIndexMembers, write);
}

/** A constituent leaving the index on `asOfDate`. */
export interface MemberRetire {
  indexId: number;
  instrumentId: number;
  /** `YYYY-MM-DD`: the snapshot the constituent is missing from. Becomes `valid_to`. */
  asOfDate: string;
  txFrom?: Date;
}

/**
 * Narrow the current version of one constituent to `valid_to = as_of_date` (DATA_MODEL L949) —
 * `db/bitemporal.ts#retireVersion` applied to `index_members`.
 *
 * The version being narrowed is closed on the transaction-time axis and its **head**
 * `[old.valid_from, as_of_date)` is re-inserted with the old data and the old provenance — the
 * membership stays true for every date it really covered, and a read as of any earlier date is
 * unchanged. No tail is re-inserted: that is the whole difference from `writeVersion`, which
 * would resurrect the membership after the drop.
 *
 * A version that starts on or after `as_of_date` is retracted outright (it covers nothing once
 * narrowed). A constituent that is already retired by that date is left alone, so re-running the
 * same snapshot writes nothing.
 *
 * @returns the number of versions narrowed (0 or 1 in practice).
 */
export async function retireMember(tx: Tx, w: MemberRetire): Promise<number> {
  return retireVersion(tx, btIndexMembers, {
    entityKey: { indexId: w.indexId, instrumentId: w.instrumentId },
    validTo: instantOfDate(w.asOfDate),
    ...(w.txFrom === undefined ? {} : { txFrom: w.txFrom }),
  });
}

/**
 * Apply one whole weights snapshot (REF-07): upsert every constituent it names and retire every
 * constituent it does not.
 *
 * The pre-snapshot roster is read **before** anything is written, at `(as_of_date, txFrom)`, so
 * the diff is taken against what we believed just before this file arrived. Re-running the same
 * snapshot writes nothing at all: every `upsertMember` no-ops and every `retireMember` finds the
 * membership already narrowed — the property `test/replay/refdata/secNport.test.ts` counts rows
 * to prove.
 *
 * @throws a `pg` error with `code = '23P01'` when two constituents of the snapshot name the same
 *         instrument (the placeholder-identifier trap of WORKPLAN L730-741 — the jobs must treat
 *         `000000000` CUSIPs as absent *before* calling this).
 */
export async function recordSnapshot(tx: Tx, snap: MembershipSnapshot): Promise<SnapshotResult> {
  const txFrom = await knowledgeInstant(tx, snap.txFrom);
  const validFrom = instantOfDate(snap.asOfDate);

  const incoming = new Set<number>();
  for (const member of snap.members) {
    if (incoming.has(member.instrumentId)) {
      throw new Error(
        `recordSnapshot(${snap.sourceId} ${snap.asOfDate}): instrument ${member.instrumentId} ` +
          'appears twice in one snapshot; resolve placeholder identifiers before writing ' +
          '(WORKPLAN §WP-04 L730-741)',
      );
    }
    incoming.add(member.instrumentId);
  }

  const before = await membersAsOf(tx, snap.indexId, { validAt: validFrom, knownAt: txFrom });

  const result: SnapshotResult = { written: 0, unchanged: 0, retired: 0 };
  for (const member of snap.members) {
    const write: MemberWrite = {
      indexId: snap.indexId,
      instrumentId: member.instrumentId,
      asOfDate: snap.asOfDate,
      sourceId: snap.sourceId,
      provenanceId: snap.provenanceId,
      txFrom,
    };
    if (member.weight !== undefined) write.weight = member.weight;
    if (member.shares !== undefined) write.shares = member.shares;
    if (member.marketValue !== undefined) write.marketValue = member.marketValue;
    const versionId = await upsertMember(tx, write);
    if (versionId === null) result.unchanged += 1;
    else result.written += 1;
  }

  for (const member of before) {
    if (incoming.has(member.instrumentId)) continue;
    result.retired += await retireMember(tx, {
      indexId: snap.indexId,
      instrumentId: member.instrumentId,
      asOfDate: snap.asOfDate,
      txFrom,
    });
  }
  return result;
}
