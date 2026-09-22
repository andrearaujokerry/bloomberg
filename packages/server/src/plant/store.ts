/**
 * `plant/store.ts` — THE writer of `quote_ticks`, `quote_snapshots` and `eod_snapshots`
 * (WORKPLAN WP-06, STOR-01, STOR-05, BUS-06).
 *
 * WP-04's `data/**` is the reader surface for these tables and `refdata/**` covers the reference
 * tables, so nothing else writes them. The plant hands rows here as it applies updates; nothing
 * touches the database until `flush()`, which writes everything pending in ONE transaction through
 * `db/client.ts` (a `SAVEPOINT` when a transaction is already in scope — the test harness's, or a
 * request's — otherwise `BEGIN` on the injected handle). `flush()` calls are serialised so two
 * overlapping flushes cannot reorder rows.
 *
 * - `writeTick` appends one `quote_ticks` row per observed change of a provider line. The row is
 *   built from the `NormalisedUpdate` the plant applied: `kind` `trade|quote|summary`, `tick_dir`
 *   `u|d|f` from the `TickDirection`, `conditions ['delayed']` for a delayed line, and `capture_ts`
 *   — the partition key — from `ts.cap`. Every numeric column is bound as text so the value does
 *   not round-trip through binary64 (`numeric(18,6)`).
 * - `upsertSnapshot` keeps the last `QuoteState` per subject; one row per instrument
 *   (`instrument_id` PK), `seq` advancing, the full state as jsonb. Two upserts of the same subject
 *   inside one flush collapse to the later one.
 * - `writeEodSnapshot` writes the official close of one session (PK `instrument_id, session_date`).
 *   The builder's `flags` are kept inside the jsonb under `_flags` (only when non-empty) so a
 *   warm-started view can still say the close was substituted; readers that look fields up by id
 *   never see the key.
 * - `readSnapshots` / `readEod` are what `plant/warm.ts` and the plant's eod view consume. This
 *   module reads nothing else.
 */

import { asc, desc, eq, sql } from 'drizzle-orm';

import type {
  Clock,
  FieldId,
  FieldValue,
  NormalisedUpdate,
  QuoteState,
  SessionState,
  TickDirection,
} from '@terminal/core';

import { currentTx, runWithTx, withTx, type Db, type Tx } from '../db/client.js';
import { eodSnapshots, quoteSnapshots, quoteTicks } from '../db/schema/timeseries.js';

import { EOD_FIELD_IDS, type EodFlag, type EodView } from './eod.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The `quote_ticks.kind` CHECK. */
export type TickKind = 'trade' | 'quote' | 'summary';

/** The `quote_ticks.tick_dir` CHECK. */
export type TickDir = 'u' | 'd' | 'f';

/**
 * One `quote_ticks` row, expressed as the update the plant applied plus what the row needs that the
 * update does not carry. `tickDir` defaults to `update.fields.TICK_DIR`; `delayed` defaults to
 * `update.tier === 'delayed'`.
 */
export interface TickWrite {
  update: NormalisedUpdate;
  kind: TickKind;
  tickDir?: TickDirection | null;
  delayed?: boolean;
  /** Extra `conditions` beyond `'delayed'` (e.g. `'late'`, `'odd_lot'`). */
  conditions?: readonly string[];
}

/** The flat row the mapping produces — exported so the plant's tests can assert it. */
export interface TickRow {
  captureTs: string;
  instrumentId: number;
  mdLineId: number;
  kind: TickKind;
  sourceTs: string | null;
  publishTs: string | null;
  srcSeq: number | null;
  price: string | null;
  size: number | null;
  bid: string | null;
  ask: string | null;
  bidSize: number | null;
  askSize: number | null;
  open: string | null;
  high: string | null;
  low: string | null;
  prevClose: string | null;
  volume: number | null;
  iv30: string | null;
  tickDir: TickDir | null;
  conditions: string[];
  sessionState: SessionState | null;
  provenanceId: number;
}

export interface SnapshotRow {
  subject: string;
  seq: number;
  state: QuoteState;
}

export interface PlantStore {
  /** Queue one tick row; written at the next `flush()`. */
  writeTick(row: TickWrite): void;
  /** Queue the latest state of `subject`; a later call for the same subject before a flush wins. */
  upsertSnapshot(subject: string, seq: number, state: QuoteState): void;
  /** Queue the official close of one session for `instrumentId`. */
  writeEodSnapshot(instrumentId: number, view: EodView, provenanceId: number): void;
  /** Write everything pending in one transaction. Resolves when the rows are in. */
  flush(): Promise<void>;
  /** Every `quote_snapshots` row, by instrument id — the warm start's input. */
  readSnapshots(): Promise<SnapshotRow[]>;
  /** The most recent `eod_snapshots` row of `instrumentId`, or `null` when none exists. */
  readEod(instrumentId: number): Promise<EodView | null>;
  /** Rows queued and not yet flushed, and rows written so far. */
  stats(): PlantStoreStats;
}

export interface PlantStoreStats {
  pendingTicks: number;
  pendingSnapshots: number;
  pendingEod: number;
  ticksWritten: number;
  snapshotsWritten: number;
  eodWritten: number;
  flushes: number;
}

export interface PlantStoreDeps {
  db: Db | Tx;
  clock: Clock;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Mapping
// ─────────────────────────────────────────────────────────────────────────────────────────────

const TICK_DIR_CODE: Record<TickDirection, TickDir> = { up: 'u', down: 'd', flat: 'f' };

/** `numeric` columns take text: a float literal would round-trip through binary64. */
function numericIn(value: number | undefined, scale = 6): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(scale) : null;
}

/** `bigint`/`integer` columns in `mode: 'number'`; a non-integral count is truncated. */
function intIn(value: number | undefined | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function isoIn(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Map a `TickWrite` to the `quote_ticks` row it becomes. Pure; exported for the plant's tests. */
export function tickRow(w: TickWrite): TickRow {
  const u = w.update;
  const f = u.fields;
  const dir = w.tickDir === undefined ? (f.TICK_DIR ?? null) : w.tickDir;
  const delayed = w.delayed ?? u.tier === 'delayed';
  const conditions = new Set<string>(w.conditions ?? []);
  if (delayed) conditions.add('delayed');
  return {
    captureTs: new Date(u.ts.cap).toISOString(),
    instrumentId: u.instrumentId,
    mdLineId: u.mdLineId,
    kind: w.kind,
    sourceTs: isoIn(u.ts.src),
    publishTs: isoIn(u.ts.pub),
    srcSeq: intIn(u.prov.srcSeq),
    price: numericIn(f.PX_LAST),
    size: intIn(f.LAST_SIZE),
    bid: numericIn(f.PX_BID),
    ask: numericIn(f.PX_ASK),
    bidSize: intIn(f.BID_SIZE),
    askSize: intIn(f.ASK_SIZE),
    open: numericIn(f.PX_OPEN),
    high: numericIn(f.PX_HIGH),
    low: numericIn(f.PX_LOW),
    prevClose: numericIn(f.PX_CLOSE_1D),
    volume: intIn(f.PX_VOLUME),
    iv30: numericIn(f.IVOL_30D),
    tickDir: dir === null ? null : TICK_DIR_CODE[dir],
    conditions: [...conditions],
    sessionState: u.session ?? f.SESSION_STATE ?? null,
    provenanceId: u.prov.provenanceId,
  };
}

/** The jsonb key the eod flags travel under; never a dictionary field id. */
const EOD_FLAGS_KEY = '_flags';

function eodJson(view: EodView): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of EOD_FIELD_IDS) {
    const v = view.fields[id];
    if (v !== undefined && v !== null) out[id] = v;
  }
  if (view.flags.length > 0) out[EOD_FLAGS_KEY] = [...view.flags];
  return out;
}

function eodFromJson(sessionDate: string, closeTs: string, blob: unknown): EodView {
  const fields: Record<FieldId, FieldValue> = {};
  const flags: EodFlag[] = [];
  if (typeof blob === 'object' && blob !== null) {
    const rec = blob as Record<string, unknown>;
    for (const id of EOD_FIELD_IDS) {
      const v = rec[id];
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') fields[id] = v;
    }
    const rawFlags: unknown = rec[EOD_FLAGS_KEY];
    if (Array.isArray(rawFlags)) {
      for (const fl of rawFlags as unknown[]) {
        if (fl === 'OFFICIAL_CLOSE_FROM_LAST' || fl === 'MISSING_CLOSE') flags.push(fl);
      }
    }
  }
  return { sessionDate, closeTs: Date.parse(closeTs), fields, flags };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface PendingEod {
  instrumentId: number;
  view: EodView;
  provenanceId: number;
}

/** Bind `fn` to the transaction in scope (savepoint) or open one on the injected handle. */
function inTx<T>(db: Db | Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (currentTx() !== undefined) return withTx(null, fn);
  return db.transaction((tx) => runWithTx(tx, () => fn(tx)));
}

/** Postgres caps a statement at 65 535 bind parameters; 200 rows × 22 columns stays far inside. */
const TICK_CHUNK = 200;

export function plantStore(deps: PlantStoreDeps): PlantStore {
  const { db, clock } = deps;

  let ticks: TickRow[] = [];
  let snapshots = new Map<number, SnapshotRow & { instrumentId: number }>();
  let eod = new Map<string, PendingEod>();
  const written = { ticks: 0, snapshots: 0, eod: 0, flushes: 0 };
  let chain: Promise<void> = Promise.resolve();

  async function writeBatch(
    tx: Tx,
    batch: { ticks: TickRow[]; snapshots: SnapshotRow[]; eod: PendingEod[] },
  ): Promise<void> {
    for (let i = 0; i < batch.ticks.length; i += TICK_CHUNK) {
      await tx.insert(quoteTicks).values(batch.ticks.slice(i, i + TICK_CHUNK));
    }
    const updatedAt = new Date(clock.now()).toISOString();
    for (const s of batch.snapshots) {
      await tx
        .insert(quoteSnapshots)
        .values({
          instrumentId: s.state.instrumentId,
          subject: s.subject,
          seq: s.seq,
          state: s.state,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: quoteSnapshots.instrumentId,
          set: {
            subject: sql`excluded.subject`,
            seq: sql`excluded.seq`,
            state: sql`excluded.state`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
    for (const e of batch.eod) {
      await tx
        .insert(eodSnapshots)
        .values({
          instrumentId: e.instrumentId,
          sessionDate: e.view.sessionDate,
          fields: eodJson(e.view),
          closeTs: new Date(e.view.closeTs).toISOString(),
          provenanceId: e.provenanceId,
        })
        .onConflictDoUpdate({
          target: [eodSnapshots.instrumentId, eodSnapshots.sessionDate],
          set: {
            fields: sql`excluded.fields`,
            closeTs: sql`excluded.close_ts`,
            provenanceId: sql`excluded.provenance_id`,
          },
        });
    }
  }

  async function flushNow(): Promise<void> {
    if (ticks.length === 0 && snapshots.size === 0 && eod.size === 0) return;
    const batch = { ticks, snapshots: [...snapshots.values()], eod: [...eod.values()] };
    ticks = [];
    snapshots = new Map();
    eod = new Map();
    try {
      await inTx(db, (tx) => writeBatch(tx, batch));
    } catch (err) {
      // Nothing was written: put the batch back in front of whatever arrived meanwhile so the
      // next flush retries it in order, and let the caller see the failure.
      ticks = [...batch.ticks, ...ticks];
      const merged = new Map<number, SnapshotRow & { instrumentId: number }>();
      for (const s of batch.snapshots) merged.set(s.state.instrumentId, { ...s, instrumentId: s.state.instrumentId });
      for (const [k, v] of snapshots) merged.set(k, v);
      snapshots = merged;
      const mergedEod = new Map<string, PendingEod>();
      for (const e of batch.eod) mergedEod.set(`${String(e.instrumentId)}|${e.view.sessionDate}`, e);
      for (const [k, v] of eod) mergedEod.set(k, v);
      eod = mergedEod;
      throw err;
    }
    written.ticks += batch.ticks.length;
    written.snapshots += batch.snapshots.length;
    written.eod += batch.eod.length;
    written.flushes += 1;
  }

  return {
    writeTick(row: TickWrite): void {
      ticks.push(tickRow(row));
    },

    upsertSnapshot(subject: string, seq: number, state: QuoteState): void {
      snapshots.set(state.instrumentId, { instrumentId: state.instrumentId, subject, seq, state });
    },

    writeEodSnapshot(instrumentId: number, view: EodView, provenanceId: number): void {
      eod.set(`${String(instrumentId)}|${view.sessionDate}`, { instrumentId, view, provenanceId });
    },

    flush(): Promise<void> {
      // Serialise: a flush that starts while one is in flight waits for it, so rows land in the
      // order they were queued. A failed flush does not poison the chain.
      const next = chain.then(flushNow, flushNow);
      chain = next.catch(() => undefined);
      return next;
    },

    async readSnapshots(): Promise<SnapshotRow[]> {
      const rows = await db
        .select({
          subject: quoteSnapshots.subject,
          seq: quoteSnapshots.seq,
          state: quoteSnapshots.state,
        })
        .from(quoteSnapshots)
        .orderBy(asc(quoteSnapshots.instrumentId));
      return rows.map((r) => ({ subject: r.subject, seq: r.seq, state: r.state as QuoteState }));
    },

    async readEod(instrumentId: number): Promise<EodView | null> {
      const rows = await db
        .select({
          sessionDate: eodSnapshots.sessionDate,
          closeTs: eodSnapshots.closeTs,
          fields: eodSnapshots.fields,
        })
        .from(eodSnapshots)
        .where(eq(eodSnapshots.instrumentId, instrumentId))
        .orderBy(desc(eodSnapshots.sessionDate))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : eodFromJson(row.sessionDate, row.closeTs, row.fields);
    },

    stats(): PlantStoreStats {
      return {
        pendingTicks: ticks.length,
        pendingSnapshots: snapshots.size,
        pendingEod: eod.size,
        ticksWritten: written.ticks,
        snapshotsWritten: written.snapshots,
        eodWritten: written.eod,
        flushes: written.flushes,
      };
    },
  };
}
