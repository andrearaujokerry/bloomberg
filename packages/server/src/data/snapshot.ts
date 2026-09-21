/**
 * `data/snapshot.ts` — the warm tier: `quote_snapshots` and `eod_snapshots` merged into
 * `ValueCell`s (FUNCTIONS.md §1.4.2 `DataServices.snapshot`, STOR-05, BUS-01, BUS-06).
 *
 * Three layers answer a field request, in this order:
 *
 *  1. **`quote_snapshots`** — the last composite `QuoteState` the plant wrote for the subject. It
 *     carries its own tier, staleness verdict, session and per-field source timestamps, so a cell
 *     built from it needs no guessing: `st` is the state's verdict and `live` points the shell at
 *     the WS subject so the value can be overwritten in place (TERM-12).
 *  2. **`eod_snapshots`** — the official close of the last session on or before `validAt`. This is
 *     what serves the `eod` tier and what fills `PX_CLOSE_1D` when the plant is cold; its cells are
 *     `'closed'`, because an official close does not change.
 *  3. **the master row** — the handful of reference fields a grid asks for alongside prices
 *     (`NAME`, `CRNCY`, `EXCH_CODE`, …), read from `instruments` as of the request's pair.
 *
 * A field no layer can supply is **not** an error and not a zero: it is `v: null` with
 * `st: 'na'`. A field the entitlement pre-check denied is `v: null`, `st: 'blank'` and the reason
 * it was denied (ENTL-05) — the decision is made by the runner before this service is built, and
 * handed here as `denied`.
 */

import { hasField } from '@terminal/core/fields/dictionary';
import { and, asc, inArray, sql } from 'drizzle-orm';

import { asOf } from '../db/bitemporal.js';
import { instruments } from '../db/schema/reference.js';
import { MissingProvenanceError, citeProvenance, utcDate } from './reference.js';

import type {
  FieldId,
  FieldValue,
  QuoteState,
  ReasonCode,
  SessionState,
  Tier,
  ValueCell,
  ValueState,
} from '@terminal/core';
import type { SQL } from 'drizzle-orm';
import type { AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';
import type { DataDeps, ProvenanceSink } from './reference.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `eod_snapshots` row. */
export interface EodSnapshot {
  instrumentId: number;
  sessionDate: string;
  fields: Record<FieldId, FieldValue>;
  /** The session close instant — `ts.src` of an eod-tier cell (FEED-05). */
  closeTs: string;
  provenanceId: number;
}

/** One `quote_snapshots` row: the plant's last composite state for the subject (STOR-05). */
export interface QuoteSnapshot {
  instrumentId: number;
  subject: string;
  seq: number;
  state: QuoteState;
  updatedAt: string;
}

/** Extra inputs the runner supplies after the ENTL-01 pre-check. */
export interface SnapshotDeps extends DataDeps {
  /**
   * Fields the entitlement decision refused, with the reason. A denied field is rendered blank
   * with its reason and is never read from the store (ENTL-05).
   */
  denied?: ReadonlyMap<FieldId, ReasonCode>;
}

/** The reference fields this service can serve straight off the `instruments` row. */
const REFERENCE_FIELDS = [
  'NAME',
  'ID_TICKER',
  'EXCH_CODE',
  'CRNCY',
  'ASSET_CLASS',
  'MARKET_SECTOR_DES',
  'SECURITY_STATUS',
] as const satisfies readonly FieldId[];

/** The quote fields an `eod_snapshots.fields` blob carries (DATA_MODEL §7.2, BUS-06). */
export const EOD_FIELDS: readonly FieldId[] = Object.freeze([
  'PX_OFFICIAL_CLOSE',
  'PX_CLOSE_1D',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_VOLUME',
]);

interface MasterRow {
  instrumentId: number;
  values: Record<FieldId, FieldValue>;
  provenanceId: number;
}

/**
 * `id IN (…)` as a parameter list. A JS array handed to the `sql` template is spliced into one
 * placeholder per element, never into a Postgres array literal, so `= ANY($1::bigint[])` would be
 * built as `= ANY(($1, $2)::bigint[])` and raise `42846`.
 */
function idList(ids: readonly number[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::bigint`),
    sql`, `,
  );
}

function isFieldValue(value: unknown): value is FieldValue {
  return (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  );
}

/** A jsonb blob as a field map, ignoring anything that is not a scalar field value. */
function toFieldMap(blob: unknown): Record<FieldId, FieldValue> {
  const out: Record<FieldId, FieldValue> = {};
  if (typeof blob !== 'object' || blob === null) return out;
  for (const [key, value] of Object.entries(blob as Record<string, unknown>)) {
    if (isFieldValue(value)) out[key] = value;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `DataServices.snapshot` (FUNCTIONS.md §1.4.2 L295). */
export class SnapshotService {
  readonly #tx: Tx;
  readonly #at: AsOf;
  readonly #prov: ProvenanceSink;
  readonly #denied: ReadonlyMap<FieldId, ReasonCode>;

  constructor(deps: SnapshotDeps) {
    this.#tx = deps.tx;
    this.#at = deps.asOf;
    this.#prov = deps.prov;
    this.#denied = deps.denied ?? new Map<FieldId, ReasonCode>();
  }

  /**
   * `ids × fields` as `ValueCell`s, one map entry per instrument.
   *
   * Three queries whatever the size of the grid: the plant snapshots, the eod snapshots and the
   * master rows are each read for the whole id list at once, because a 500-row watchlist must not
   * be 1 500 round trips.
   */
  async fields(ids: number[], fields: FieldId[]): Promise<Map<number, Record<FieldId, ValueCell>>> {
    const out = new Map<number, Record<FieldId, ValueCell>>();
    const wanted = [...new Set(ids)];
    if (wanted.length === 0 || fields.length === 0) {
      for (const id of wanted) out.set(id, {});
      return out;
    }

    const [quotes, eod, master] = await Promise.all([
      this.quotes(wanted),
      this.eod(wanted),
      this.#master(wanted, fields),
    ]);

    // The eod and master rows are looked up in `provenance`; a quote state needs no lookup,
    // because it already carries the source, the capture instant, its own staleness verdict and
    // the tier of the line that won the composite (ARCHITECTURE §4.2).
    const cited: number[] = [];
    for (const snap of eod.values()) cited.push(snap.provenanceId);
    for (const row of master.values()) cited.push(row.provenanceId);
    const citation = await citeProvenance(this.#tx, this.#prov, cited, { st: 'closed' });

    for (const snap of quotes.values()) {
      citation.provIdxOf[snap.state.prov.provenanceId] = this.#prov.add({
        sourceId: snap.state.prov.sourceId,
        provenanceId: snap.state.prov.provenanceId,
        capturedAt: new Date(snap.state.ts.cap),
        sourceTs: snap.state.ts.src === null ? null : new Date(snap.state.ts.src),
        st: sessionState(snap.state.state, snap.state.session),
        tier: snap.state.tier,
      });
    }

    for (const id of wanted) {
      const quote = quotes.get(id);
      const close = eod.get(id);
      const ref = master.get(id);
      const cells: Record<FieldId, ValueCell> = {};

      for (const field of fields) {
        cells[field] = this.#cell(field, quote, close, ref, citation.provIdxOf);
      }
      out.set(id, cells);
    }
    return out;
  }

  /** The stored `QuoteState` of each instrument that has one (STOR-05). */
  async quotes(ids: readonly number[]): Promise<Map<number, QuoteSnapshot>> {
    const out = new Map<number, QuoteSnapshot>();
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return out;
    const res = await this.#tx.execute<{
      instrument_id: string;
      subject: string;
      seq: string;
      state: unknown;
      updated_at: string;
    }>(sql`
        SELECT instrument_id::text AS instrument_id, subject, seq::text AS seq, state,
               to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
          FROM quote_snapshots
         WHERE instrument_id IN (${idList(wanted)})`);
    for (const row of res.rows) {
      const state = row.state as QuoteState;
      out.set(Number(row.instrument_id), {
        instrumentId: Number(row.instrument_id),
        subject: row.subject,
        seq: Number(row.seq),
        state,
        updatedAt: row.updated_at,
      });
    }
    return out;
  }

  /**
   * The `eod_snapshots` row of the last session **on or before** `validAt` for each instrument —
   * one query with a lateral, not one per name.
   */
  async eod(ids: readonly number[], sessionDate?: string): Promise<Map<number, EodSnapshot>> {
    const out = new Map<number, EodSnapshot>();
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return out;
    const through = sessionDate ?? utcDate(this.#at.validAt);
    const res = await this.#tx.execute<{
      instrument_id: string;
      session_date: string;
      fields: unknown;
      close_ts: string;
      provenance_id: string;
    }>(sql`
        SELECT s.instrument_id::text AS instrument_id, s.session_date::text AS session_date,
               s.fields,
               to_char(s.close_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS close_ts,
               s.provenance_id::text AS provenance_id
          FROM (VALUES ${sql.join(
            wanted.map((id) => sql`(${id}::bigint)`),
            sql`, `,
          )}) AS w(instrument_id)
          CROSS JOIN LATERAL (
                SELECT * FROM eod_snapshots e
                 WHERE e.instrument_id = w.instrument_id
                   AND e.session_date <= ${through}::date
                 ORDER BY e.session_date DESC
                 LIMIT 1) AS s`);
    for (const row of res.rows) {
      out.set(Number(row.instrument_id), {
        instrumentId: Number(row.instrument_id),
        sessionDate: row.session_date,
        fields: toFieldMap(row.fields),
        closeTs: row.close_ts,
        provenanceId: Number(row.provenance_id),
      });
    }
    return out;
  }

  /** The reference projection: only the fields of `REFERENCE_FIELDS` that were asked for. */
  async #master(
    ids: readonly number[],
    fields: readonly FieldId[],
  ): Promise<Map<number, MasterRow>> {
    const out = new Map<number, MasterRow>();
    const asked = fields.filter((f) => (REFERENCE_FIELDS as readonly FieldId[]).includes(f));
    if (asked.length === 0) return out;
    const rows = await this.#tx
      .select({
        instrumentId: instruments.instrumentId,
        ticker: instruments.ticker,
        exchCode: instruments.exchCode,
        name: instruments.name,
        currency: instruments.currency,
        assetClass: instruments.assetClass,
        marketSector: instruments.marketSector,
        status: instruments.status,
        provenanceId: instruments.provenanceId,
      })
      .from(instruments)
      .where(and(inArray(instruments.instrumentId, [...new Set(ids)]), asOf(instruments, this.#at)))
      .orderBy(asc(instruments.instrumentId));

    for (const row of rows) {
      out.set(row.instrumentId, {
        instrumentId: row.instrumentId,
        provenanceId: row.provenanceId,
        values: {
          NAME: row.name,
          ID_TICKER: row.ticker,
          EXCH_CODE: row.exchCode,
          CRNCY: row.currency,
          ASSET_CLASS: row.assetClass,
          MARKET_SECTOR_DES: row.marketSector,
          SECURITY_STATUS: row.status,
        },
      });
    }
    return out;
  }

  /**
   * The `meta.provenance` index of a cell that carries a value.
   *
   * Never `?? 0`. Index 0 is a real citation (API.md §4's own example is `"provIdx": [0]`), and it
   * is also the literal this file writes on cells that carry no value at all, so a silent fallback
   * would attribute a number to whatever source happens to be first in the citation list. Every
   * id reaching here was registered by `fields()` before the cells were built — eod and master
   * through `citeProvenance`, each quote state explicitly — so an unregistered one is a
   * programming error and says so.
   */
  #citedIndex(provIdxOf: Record<number, number>, provenanceId: number): number {
    const idx = provIdxOf[provenanceId];
    if (idx === undefined) throw new MissingProvenanceError(provenanceId);
    return idx;
  }

  /**
   * Resolve one field for one instrument across the three layers.
   *
   * `provIdx: 0` appears only on cells whose `v` is `null` (`'blank'`, `'na'`): there is nothing
   * to attribute, and the field is read together with `v`. A value-bearing cell always carries a
   * real citation index — see {@link SnapshotService.#citedIndex}.
   */
  #cell(
    field: FieldId,
    quote: QuoteSnapshot | undefined,
    close: EodSnapshot | undefined,
    ref: MasterRow | undefined,
    provIdxOf: Record<number, number>,
  ): ValueCell {
    const denial = this.#denied.get(field);
    if (denial !== undefined) return { v: null, st: 'blank', r: denial, provIdx: 0 };
    if (!hasField(field)) return { v: null, st: 'blank', r: 'FIELD_UNKNOWN', provIdx: 0 };

    // 1. the plant's composite state
    if (quote !== undefined) {
      const value = (quote.state.fields as Record<string, FieldValue | undefined>)[field];
      if (value !== undefined && value !== null) {
        const ts = (quote.state.fieldTs as Record<string, number | undefined>)[field];
        const cell: ValueCell = {
          v: value,
          st: sessionState(quote.state.state, quote.state.session),
          provIdx: this.#citedIndex(provIdxOf, quote.state.prov.provenanceId),
          live: { subject: quote.subject, field },
        };
        if (ts !== undefined) cell.ts = ts;
        else if (quote.state.ts.src !== null) cell.ts = quote.state.ts.src;
        return cell;
      }
    }

    // 2. the official close of the last session
    if (close !== undefined) {
      const value = close.fields[field];
      if (value !== undefined && value !== null) {
        return {
          v: value,
          st: 'closed',
          ts: Date.parse(close.closeTs),
          provIdx: this.#citedIndex(provIdxOf, close.provenanceId),
        };
      }
    }

    // 3. the master row
    if (ref !== undefined) {
      const value = ref.values[field];
      if (value !== undefined && value !== null) {
        return { v: value, st: 'closed', provIdx: this.#citedIndex(provIdxOf, ref.provenanceId) };
      }
    }

    // Nothing carries it. 'na', not a zero and not an error (TERM-12).
    return { v: null, st: 'na', provIdx: 0 };
  }
}

/**
 * The staleness a cell inherits from the state that produced it. A closed or post session makes
 * every value a last print whatever the plant's own verdict was, which is what stops a watchlist
 * showing Friday's close as `'stale'` all weekend.
 */
function sessionState(state: ValueState, session: SessionState): ValueState {
  if (state === 'blank' || state === 'na') return state;
  return session === 'closed' || session === 'post' ? 'closed' : state;
}

/** The lowest tier of a set of quote snapshots — what `meta.tier` reports for a grid. */
export function lowestSnapshotTier(snapshots: Iterable<QuoteSnapshot>): Tier {
  const rank: Record<Tier, number> = { eod: 0, delayed: 1, realtime: 2 };
  let lowest: Tier | undefined;
  for (const snap of snapshots) {
    if (lowest === undefined || rank[snap.state.tier] < rank[lowest]) lowest = snap.state.tier;
  }
  return lowest ?? 'eod';
}

/** `snapshotService({ tx, asOf, prov }).fields([42], ['PX_LAST'])`. */
export function snapshotService(deps: SnapshotDeps): SnapshotService {
  return new SnapshotService(deps);
}

/** A single instrument's stored quote state, for QM / the DES header. */
export async function quoteSnapshot(
  tx: Tx,
  instrumentId: number,
): Promise<QuoteSnapshot | undefined> {
  const rows = await tx.execute<{
    instrument_id: string;
    subject: string;
    seq: string;
    state: unknown;
    updated_at: string;
  }>(sql`
      SELECT instrument_id::text AS instrument_id, subject, seq::text AS seq, state,
             to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
        FROM quote_snapshots
       WHERE instrument_id = ${instrumentId}`);
  const row = rows.rows[0];
  if (row === undefined) return undefined;
  return {
    instrumentId: Number(row.instrument_id),
    subject: row.subject,
    seq: Number(row.seq),
    state: row.state as QuoteState,
    updatedAt: row.updated_at,
  };
}
