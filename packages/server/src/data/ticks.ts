/**
 * `data/ticks.ts` — `quote_ticks` as API.md §4 `TickRow`s (FUNCTIONS.md §1.4.2
 * `DataServices.ticks`, DATA_MODEL §7.2, FEED-05).
 *
 * A "tick" here is one observed change of a provider line, not an exchange print: the sources this
 * terminal is licensed for publish delayed polls, so a row is what the poll said and `src_seq` is
 * the provider's own sequence number where it has one. That is why every row carries the FEED-05
 * triple — `srcTs` (provider-published), `capTs` (fetch completed) and `pubTs` (plant publish) —
 * instead of a single ambiguous timestamp.
 *
 * Rows come back ascending by `capTs` (API.md §4 rule 5) whichever end of the table they were read
 * from, and every one of them carries the `provenance_id` of the exchange that produced it.
 *
 * `conditions` is FEED-07's placeholder: no reachable source publishes sale conditions, so the
 * column carries `'delayed'` / `'synthetic_from_poll'` markers rather than exchange condition
 * codes. It is passed through untouched.
 */

import { sql } from 'drizzle-orm';

import { citeProvenance, citedIndex } from './reference.js';

import type { FieldId, FieldValue, TickDirection } from '@terminal/core';
import type { AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';
import type { DataDeps, ProvenanceCitation, ProvenanceSink } from './reference.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type TickKind = 'trade' | 'quote' | 'summary';

/** API.md §4 L342 `TickRow`. */
export interface TickRow {
  /** FEED-05 capture — the partition key and the sort key. ISO-8601 UTC. */
  capTs: string;
  /** FEED-05 provider-published; `null` when the provider gives none. */
  srcTs: string | null;
  /** FEED-05 plant publish; `null` for a row written by an ingest job rather than the plant. */
  pubTs: string | null;
  kind: TickKind;
  /** Provider sequence number (Cboe `seqno`), when the source has one. */
  srcSeq: number | null;
  mdLineId: number;
  /** The fields present on this tick, keyed by dictionary field id. */
  f: Record<FieldId, FieldValue>;
  conditions: string[];
  /** Index into `meta.provenance`. */
  provIdx: number;
  /** DATA-10: the `provenance` row this tick came from. */
  provenanceId: number;
}

/** A page of ticks (API.md §4 `kind: 'tick'`). */
export interface TickPage extends ProvenanceCitation {
  ticks: TickRow[];
  /** Opaque; pass back as `cursor` for the next page. `null` at the end. */
  nextCursor: string | null;
}

/** The window form behind `DataRequest { kind: 'tick' }` (API.md §4 L325-327). */
export interface TickQuery {
  /** ISO-8601 instants, inclusive. */
  start: string;
  end: string;
  /** Default `['trade','quote']`. */
  kinds?: readonly TickKind[];
  /** 1…100 000; default 10 000. */
  limit?: number;
  cursor?: string;
}

/** The `quote_ticks` columns that carry a value, as dictionary field ids. */
const TICK_FIELDS = [
  ['price', 'PX_LAST'],
  ['size', 'LAST_SIZE'],
  ['bid', 'PX_BID'],
  ['ask', 'PX_ASK'],
  ['bid_size', 'BID_SIZE'],
  ['ask_size', 'ASK_SIZE'],
  ['open', 'PX_OPEN'],
  ['high', 'PX_HIGH'],
  ['low', 'PX_LOW'],
  ['prev_close', 'PX_CLOSE_1D'],
  ['volume', 'PX_VOLUME'],
  ['iv30', 'IVOL_30D'],
] as const satisfies readonly (readonly [string, FieldId])[];

const TICK_DIR: Readonly<Record<string, TickDirection>> = Object.freeze({
  u: 'up',
  d: 'down',
  f: 'flat',
});

const DEFAULT_KINDS: readonly TickKind[] = Object.freeze(['trade', 'quote']);
const DEFAULT_LIMIT = 10_000;
const MAX_LIMIT = 100_000;

interface TickDbRow extends Record<string, unknown> {
  tick_id: string;
  cap_ts: string;
  src_ts: string | null;
  pub_ts: string | null;
  kind: string;
  src_seq: string | null;
  md_line_id: string;
  price: string | null;
  size: string | null;
  bid: string | null;
  ask: string | null;
  bid_size: number | null;
  ask_size: number | null;
  open: string | null;
  high: string | null;
  low: string | null;
  prev_close: string | null;
  volume: string | null;
  iv30: string | null;
  tick_dir: string | null;
  conditions: string[] | null;
  session_state: string | null;
  provenance_id: string;
}

const TICK_COLUMNS = sql`
  tick_id::text AS tick_id,
  to_char(capture_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cap_ts,
  to_char(source_ts  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS src_ts,
  to_char(publish_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS pub_ts,
  kind, src_seq::text AS src_seq, md_line_id::text AS md_line_id,
  price::text, size::text, bid::text, ask::text, bid_size, ask_size,
  open::text, high::text, low::text, prev_close::text, volume::text, iv30::text,
  tick_dir, conditions, session_state, provenance_id::text AS provenance_id`;

function num(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toTickRow(row: TickDbRow, provIdx: number): TickRow {
  const f: Record<FieldId, FieldValue> = {};
  for (const [column, field] of TICK_FIELDS) {
    const raw = row[column];
    const value = num(typeof raw === 'string' || typeof raw === 'number' ? raw : null);
    if (value !== null) f[field] = value;
  }
  if (row.tick_dir !== null) {
    const dir = TICK_DIR[row.tick_dir];
    if (dir !== undefined) f.TICK_DIR = dir;
  }
  if (row.session_state !== null) f.SESSION_STATE = row.session_state;

  return {
    capTs: row.cap_ts,
    srcTs: row.src_ts,
    pubTs: row.pub_ts,
    kind: row.kind === 'trade' || row.kind === 'quote' ? row.kind : 'summary',
    srcSeq: row.src_seq === null ? null : Number(row.src_seq),
    mdLineId: Number(row.md_line_id),
    f,
    conditions: row.conditions ?? [],
    provIdx,
    provenanceId: Number(row.provenance_id),
  };
}

/** `(capTs, tickId)` as an opaque cursor — the table's sort key, base64url-encoded. */
export function encodeTickCursor(capTs: string, tickId: number): string {
  return Buffer.from(`${capTs}|${String(tickId)}`, 'utf8').toString('base64url');
}

/** @throws RangeError when the cursor is not one this service issued. */
export function decodeTickCursor(cursor: string): { capTs: string; tickId: number } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const bar = decoded.lastIndexOf('|');
  const capTs = bar === -1 ? '' : decoded.slice(0, bar);
  const tickId = bar === -1 ? Number.NaN : Number(decoded.slice(bar + 1));
  if (capTs === '' || !Number.isFinite(tickId) || Number.isNaN(Date.parse(capTs))) {
    throw new RangeError(`ticks: malformed cursor ${JSON.stringify(cursor)}`);
  }
  return { capTs, tickId };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `DataServices.ticks` (FUNCTIONS.md §1.4.2 L294). */
export class TicksService {
  readonly #tx: Tx;
  readonly #at: AsOf;
  readonly #prov: ProvenanceSink;

  constructor(deps: DataDeps) {
    this.#tx = deps.tx;
    this.#at = deps.asOf;
    this.#prov = deps.prov;
  }

  /**
   * The last `n` ticks of one instrument at or before `validAt`, **ascending** by `capTs` — the
   * order a tape prints in, even though the read walks backwards from the newest row.
   */
  async last(id: number, n: number): Promise<TickRow[]> {
    const limit = Math.max(1, Math.min(Math.trunc(n), MAX_LIMIT));
    const res = await this.#tx.execute<TickDbRow>(sql`
        SELECT ${TICK_COLUMNS}
          FROM quote_ticks
         WHERE instrument_id = ${id}
           AND capture_ts <= ${this.#at.validAt}::timestamptz
         ORDER BY capture_ts DESC, tick_id DESC
         LIMIT ${limit}`);

    const rows = [...res.rows].reverse();
    const citation = await citeProvenance(
      this.#tx,
      this.#prov,
      rows.map((row) => Number(row.provenance_id)),
    );
    return rows.map((row) =>
      toTickRow(row, citedIndex(citation.provIdxOf, Number(row.provenance_id))),
    );
  }

  /**
   * One page of the tick window behind `DataRequest { kind: 'tick' }`, ascending by `capTs` and
   * paginated with an opaque cursor over the table's own `(capture_ts, tick_id)` sort key.
   *
   * A keyset cursor rather than an offset: `quote_ticks` is partitioned by `capture_ts` and a
   * deep `OFFSET` would read every partition in the window to throw the rows away again.
   */
  async window(id: number, q: TickQuery): Promise<TickPage> {
    const limit = Math.max(1, Math.min(Math.trunc(q.limit ?? DEFAULT_LIMIT), MAX_LIMIT));
    const kinds = [...(q.kinds ?? DEFAULT_KINDS)];
    if (kinds.length === 0) {
      return { ticks: [], nextCursor: null, provIdx: [], provIdxOf: {} };
    }
    const after = q.cursor === undefined ? null : decodeTickCursor(q.cursor);
    const end = new Date(Math.min(Date.parse(q.end), this.#at.validAt.getTime())).toISOString();

    const res = await this.#tx.execute<TickDbRow>(sql`
        SELECT ${TICK_COLUMNS}
          FROM quote_ticks
         WHERE instrument_id = ${id}
           AND capture_ts >= ${q.start}::timestamptz
           AND capture_ts <= ${end}::timestamptz
           AND kind IN (${sql.join(
             kinds.map((kind) => sql`${kind}`),
             sql`, `,
           )})
           ${
             after === null
               ? sql``
               : sql`AND (capture_ts, tick_id) > (${after.capTs}::timestamptz, ${after.tickId}::bigint)`
           }
         ORDER BY capture_ts, tick_id
         LIMIT ${limit + 1}`);

    const page = res.rows.slice(0, limit);
    const citation = await citeProvenance(
      this.#tx,
      this.#prov,
      page.map((row) => Number(row.provenance_id)),
    );
    const ticks = page.map((row) =>
      toTickRow(row, citedIndex(citation.provIdxOf, Number(row.provenance_id))),
    );

    const more = res.rows.length > limit;
    const lastRow = page[page.length - 1];
    return {
      ticks,
      nextCursor:
        more && lastRow !== undefined
          ? encodeTickCursor(lastRow.cap_ts, Number(lastRow.tick_id))
          : null,
      ...citation,
    };
  }
}

/** `ticksService({ tx, asOf, prov }).last(42, 50)`. */
export function ticksService(deps: DataDeps): TicksService {
  return new TicksService(deps);
}
