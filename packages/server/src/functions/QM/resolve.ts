/**
 * `functions/QM/resolve.ts` — the live quote grid (FUNCTIONS_TIER1.md §QM L890-996).
 *
 * QM is three sources of rows behind one grid: a watchlist, an index's current constituents, or a
 * typed list of keys. Whichever it is, the rest is the same — one `plant.snapshotMany` over the
 * subjects, one `ValueCell` per (row, column), and `counts` taken from the cells' own `st` so the
 * subtitle cannot disagree with the grid.
 *
 * **No `ctx.providers.ensure`, ever** (§0.4 rule 2). A monitor that fetched its cold subjects would
 * fan five hundred rows out to five hundred provider calls on first paint. `plant.ensureHot` puts
 * them in the scheduler's hot set instead and the screen shows what is true right now: a row that
 * has never been polled is **pending** — `st:'blank'`, `provIdx:-1`, and deliberately **no reason
 * code**, because nothing was denied. A pending cell that carried a reason would tell a user their
 * entitlements are short when they are not (§0.4 rule 1, ENTL-05).
 *
 * `rows` stay in source order — watchlist position, index weight, keys as typed. `params.sort` is
 * carried in the payload and applied by the screen, so a re-sort costs a repaint rather than a
 * round-trip, and the CSV always matches the order the payload was resolved in.
 */

import { sql } from 'drizzle-orm';

import type { AssetClass, FieldId, MarketSector, ValueCell } from '@terminal/core';
import { monitorColumn } from '@terminal/core';
import type {
  MonitorCounts,
  QmParams,
  QmPayload,
  QmSkipReason,
  QmSourceInfo,
} from '@terminal/core/functions/manifests/QM';
import type { MonitorColumn, MonitorRow } from '@terminal/core/functions/shared/monitor';

import { AppError } from '../../http/errors.js';
import type { SecurityResolverInput } from '../../refdata/resolve.js';
import type { GatedQuoteState, ResolveContext } from '../context.js';
import { cellFromState } from '../shared/cells.js';
import { displayOf } from '../shared/instrumentSummary.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row metadata (§QM resolver step 2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface RowMetaSql extends Record<string, unknown> {
  instrument_id: string;
  ticker: string;
  name: string;
  exch_code: string;
  asset_class: string;
  market_sector: string;
  gics_sector: string | null;
}

export interface RowMeta {
  instrumentId: number;
  key: string;
  name: string;
  assetClass: AssetClass;
  marketSector: MarketSector;
  exchCode: string;
  gicsSector: string | null;
}

/**
 * One query for every row's reference columns, including the GICS sector.
 *
 * The sector is a lateral rather than a join because a classification may be filed against the
 * instrument or against its issuer (the `wiki.sp500` capture assigns by issuer), and a plain join
 * over both would multiply rows whenever both exist. `left(code, 2)` is the level-1 ancestor of
 * the stored sub-industry code, which is how `classification_codes` encodes the GICS tree.
 */
export async function rowMeta(
  ctx: ResolveContext,
  ids: readonly number[],
): Promise<Map<number, RowMeta>> {
  const out = new Map<number, RowMeta>();
  if (ids.length === 0) return out;
  const validAt = ctx.asOf.validAt;
  const knownAt = ctx.asOf.knownAt;

  const res = await ctx.db.execute<RowMetaSql>(sql`
    SELECT ins.instrument_id::text AS instrument_id,
           ins.ticker, ins.name, ins.exch_code,
           ins.asset_class::text   AS asset_class,
           ins.market_sector::text AS market_sector,
           gics.name               AS gics_sector
      FROM instruments ins
      LEFT JOIN issues iss
        ON iss.issue_id = ins.issue_id
       AND bt_as_of(iss.valid_from, iss.valid_to, iss.tx_from, iss.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
      LEFT JOIN LATERAL (
        SELECT c.name
          FROM entity_classifications ec
          JOIN classification_codes c ON c.scheme = 'GICS' AND c.code = left(ec.code, 2)
         WHERE ec.scheme = 'GICS'
           AND ((ec.entity_kind = 'instrument' AND ec.entity_id = ins.instrument_id)
             OR (ec.entity_kind = 'issuer' AND ec.entity_id = iss.issuer_id))
           AND bt_as_of(ec.valid_from, ec.valid_to, ec.tx_from, ec.tx_to,
                        ${validAt}::timestamptz, ${knownAt}::timestamptz)
         ORDER BY (ec.entity_kind = 'instrument') DESC
         LIMIT 1
      ) gics ON true
     WHERE ins.instrument_id = ANY(${sql.param(ids.map((id) => String(id)))}::bigint[])
       AND bt_as_of(ins.valid_from, ins.valid_to, ins.tx_from, ins.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)`);

  for (const row of res.rows) {
    const instrumentId = Number(row.instrument_id);
    out.set(instrumentId, {
      instrumentId,
      key: displayOf(row.ticker, row.exch_code, row.market_sector as MarketSector),
      name: row.name,
      assetClass: row.asset_class as AssetClass,
      marketSector: row.market_sector as MarketSector,
      exchCode: row.exch_code,
      gicsSector: row.gics_sector,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Sources (§QM resolver step 1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface WatchlistSql extends Record<string, unknown> {
  watchlist_id: string;
  name: string;
}

interface IndexSql extends Record<string, unknown> {
  instrument_id: string;
  code: string;
}

/** Visible watchlists (RLS decides), most recently updated first. */
async function visibleWatchlists(ctx: ResolveContext): Promise<WatchlistSql[]> {
  const res = await ctx.db.execute<WatchlistSql>(sql`
    SELECT watchlist_id::text AS watchlist_id, name
      FROM watchlists
     ORDER BY updated_at DESC, watchlist_id DESC`);
  return [...res.rows];
}

/** The caller's own lists, most recently updated first — what "default" means (§QM step 1). */
async function ownWatchlists(ctx: ResolveContext): Promise<WatchlistSql[]> {
  const res = await ctx.db.execute<WatchlistSql>(sql`
    SELECT watchlist_id::text AS watchlist_id, name
      FROM watchlists
     WHERE owner_user_id = ${ctx.user.userId}
     ORDER BY updated_at DESC, watchlist_id DESC`);
  return [...res.rows];
}

/** Instrument ids of a watchlist in `position` order, and the formula rows that are not rows here. */
async function watchlistItems(
  ctx: ResolveContext,
  watchlistId: number,
): Promise<{ ids: number[]; formulas: string[] }> {
  const res = await ctx.db.execute<{ instrument_id: string | null; formula: string | null }>(sql`
    SELECT instrument_id::text AS instrument_id, formula
      FROM watchlist_items
     WHERE watchlist_id = ${watchlistId}
     ORDER BY position`);
  const ids: number[] = [];
  const formulas: string[] = [];
  for (const row of res.rows) {
    if (row.instrument_id !== null) ids.push(Number(row.instrument_id));
    else if (row.formula !== null) formulas.push(row.formula);
  }
  return { ids, formulas };
}

async function indexByCode(ctx: ResolveContext, code: string): Promise<IndexSql | null> {
  const res = await ctx.db.execute<IndexSql>(sql`
    SELECT instrument_id::text AS instrument_id, code
      FROM indices
     WHERE upper(code) = upper(${code})
     LIMIT 1`);
  return res.rows[0] ?? null;
}

async function indexByInstrument(
  ctx: ResolveContext,
  instrumentId: number,
): Promise<IndexSql | null> {
  const res = await ctx.db.execute<IndexSql>(sql`
    SELECT instrument_id::text AS instrument_id, code
      FROM indices
     WHERE instrument_id = ${instrumentId}
     LIMIT 1`);
  return res.rows[0] ?? null;
}

/**
 * `404 NOT_FOUND` for a named list that does not exist (§QM step 1).
 *
 * An `AppError` rather than a bare throw: the runner re-raises an `AppError` untouched and turns
 * anything else into a 500 with the message stripped, so a plain `Error` here would reach the
 * caller as "internal error" for a typo in a watchlist name.
 */
const notFound = (message: string): AppError => new AppError('NOT_FOUND', message);

interface SourceResult {
  info: QmSourceInfo;
  title: string;
  ids: number[];
  skipped: { ref: string; reason: QmSkipReason }[];
}

async function resolveSource(ctx: ResolveContext, params: QmParams): Promise<SourceResult> {
  const source = params.source;
  const skipped: { ref: string; reason: QmSkipReason }[] = [];

  if (source.kind === 'keys') {
    const ids: number[] = [];
    for (const ref of source.refs) {
      if ('formula' in ref) {
        skipped.push({ ref: ref.formula, reason: 'FORMULA_ROW' });
        continue;
      }
      const input: SecurityResolverInput = 'id' in ref ? { id: ref.id } : ref.ref;
      const label = 'id' in ref ? String(ref.id) : ref.ref;
      const item = await ctx.data.reference.resolve(input);
      if (item.instrument === null) {
        skipped.push({ ref: label, reason: item.error?.code ?? 'SECURITY_NOT_FOUND' });
        continue;
      }
      ids.push(item.instrument.instrumentId);
    }
    return {
      info: {
        kind: 'keys',
        id: null,
        name: `Keys (${String(ids.length)})`,
        asOfDate: null,
        sourceId: null,
      },
      title: `Keys (${String(ids.length)})`,
      ids,
      skipped,
    };
  }

  if (source.kind === 'index') {
    const index =
      source.id !== undefined
        ? await indexByInstrument(ctx, source.id)
        : source.code === undefined
          ? null
          : await indexByCode(ctx, source.code);
    if (index === null) {
      throw notFound(`index ${source.code ?? String(source.id ?? '')} not found`);
    }
    return indexSource(ctx, Number(index.instrument_id), index.code, skipped);
  }

  // kind === 'watchlist'
  if (source.id !== undefined) {
    const res = await ctx.db.execute<WatchlistSql>(sql`
      SELECT watchlist_id::text AS watchlist_id, name
        FROM watchlists WHERE watchlist_id = ${source.id} LIMIT 1`);
    const row = res.rows[0];
    if (row === undefined) throw notFound(`watchlist ${String(source.id)} not found`);
    return watchlistSource(ctx, Number(row.watchlist_id), row.name, skipped);
  }

  if (source.name !== undefined) {
    const name = source.name;
    const match = (await visibleWatchlists(ctx)).find(
      (w) => w.name.toLowerCase() === name.toLowerCase(),
    );
    if (match !== undefined) {
      return watchlistSource(ctx, Number(match.watchlist_id), match.name, skipped);
    }
    // `QM SPX` with no watchlist of that name is the index — the command line should not need
    // `IDX=` to say something the catalogue can decide on its own (§QM step 1).
    const index = await indexByCode(ctx, name);
    if (index !== null) return indexSource(ctx, Number(index.instrument_id), index.code, skipped);
    throw notFound(`watchlist or index ${name} not found`);
  }

  const own = await ownWatchlists(ctx);
  const first = own[0];
  if (first === undefined) {
    ctx.unavailable.add({
      field: 'source',
      reason: 'NOT_APPLICABLE',
      detail: 'no watchlists — press W to create one',
    });
    return {
      info: { kind: 'watchlist', id: null, name: '', asOfDate: null, sourceId: null },
      title: 'Watchlist',
      ids: [],
      skipped,
    };
  }
  return watchlistSource(ctx, Number(first.watchlist_id), first.name, skipped);
}

async function watchlistSource(
  ctx: ResolveContext,
  watchlistId: number,
  name: string,
  skipped: { ref: string; reason: QmSkipReason }[],
): Promise<SourceResult> {
  const { ids, formulas } = await watchlistItems(ctx, watchlistId);
  // A formula row is a W concept: QM shows securities, so it says what it left out rather than
  // dropping it silently (§QM `skipped[]`).
  for (const formula of formulas) skipped.push({ ref: formula, reason: 'FORMULA_ROW' });
  return {
    info: { kind: 'watchlist', id: watchlistId, name, asOfDate: null, sourceId: null },
    title: name,
    ids,
    skipped,
  };
}

async function indexSource(
  ctx: ResolveContext,
  indexInstrumentId: number,
  code: string,
  skipped: { ref: string; reason: QmSkipReason }[],
): Promise<SourceResult> {
  const members = await ctx.data.reference.members(indexInstrumentId);
  if (members.members.length === 0) {
    ctx.unavailable.add({
      field: 'source',
      reason: 'NO_SOURCE',
      detail: `index ${code} has no membership source`,
    });
  }
  // Index weight desc, then key, so two runs of the same roster produce the same order.
  const ordered = [...members.members].sort(
    (a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.instrumentId - b.instrumentId,
  );
  const sourceId = ordered[0]?.sourceId ?? null;
  // The roster's OWN date, not the instant it was read at. `MembersResponse.asOfDate` echoes the
  // requested date (today, for an interactive run); `MemberView.asOfDate` is the `index_members`
  // row's `as_of_date` — the day the constituents were published. §QM's payload says "index
  // membership date", and a screen that printed today's date next to a fortnight-old roster would
  // claim a freshness the filing does not have.
  const asOfDate = ordered[0]?.asOfDate ?? members.asOfDate;
  return {
    info: {
      kind: 'index',
      id: indexInstrumentId,
      name: code,
      asOfDate,
      sourceId,
    },
    title: `${code} Index members (${asOfDate}${sourceId === null ? '' : `, ${sourceId}`})`,
    ids: ordered.map((m) => m.instrumentId),
    skipped,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: QmParams): Promise<QmPayload> {
  // 1
  const source = await resolveSource(ctx, params);

  // 2
  const columns: MonitorColumn[] = params.columns.map((id) => monitorColumn(id));
  const meta = await rowMeta(ctx, source.ids);

  // 3 — `ensureHot` asks the scheduler to keep these subjects warm; it never fetches (§0.4 rule 2).
  const subjects = source.ids.map((id) => ctx.plant.subjectFor(id));
  ctx.plant.ensureHot(subjects);
  const snapshots: Map<string, GatedQuoteState> = ctx.plant.snapshotMany(subjects);

  // 4 — rows in source order.
  const rows: MonitorRow[] = [];
  for (const id of source.ids) {
    const row = meta.get(id);
    if (row === undefined) {
      // The id resolved but has no instrument version at this as-of: a genuine gap, named.
      source.skipped.push({ ref: String(id), reason: 'NOT_IN_UNIVERSE' });
      continue;
    }
    const subject = ctx.plant.subjectFor(id);
    const state = snapshots.get(subject);
    const cells: Record<string, ValueCell> = {};
    for (const column of columns) {
      const field: FieldId = column.fieldId ?? column.id;
      cells[column.id] = cellFromState(ctx, state, field, subject);
    }
    rows.push({ ...row, subject, cells });
  }

  const counts: MonitorCounts = { rows: rows.length, live: 0, pending: 0, stale: 0, blank: 0 };
  for (const row of rows) {
    const pending = Object.values(row.cells).every(
      (cell) => cell.st === 'blank' && cell.provIdx === -1 && cell.r === undefined,
    );
    if (pending && columns.length > 0) counts.pending += 1;
    for (const cell of Object.values(row.cells)) {
      if (cell.st === 'live') counts.live += 1;
      else if (cell.st === 'stale') counts.stale += 1;
      else if (cell.st === 'blank' && !pending) counts.blank += 1;
    }
  }

  return {
    variant: 'default',
    source: source.info,
    title: source.title,
    columns,
    rows,
    skipped: source.skipped,
    groupBy: params.groupBy,
    sort: params.sort ?? null,
    counts,
    asOf: ctx.asOf.validAt.toISOString(),
  };
}
