/**
 * `functions/W/resolve.ts` — watchlists, with CHRT-07's two computed shapes
 * (FUNCTIONS_TIER1.md §W L997-1107).
 *
 * W is QM plus ownership plus arithmetic. The arithmetic is the interesting half, and it comes in
 * two shapes that look alike and are not:
 *
 *  - a **formula column** (`c<n>`) is an expression over *the row's own fields* —
 *    `PX_LAST/PX_CLOSE_1D-1` is the day's return of whatever security the row happens to be;
 *  - a **formula row** is an expression over *other securities* —
 *    `RATIO(AAPL US Equity, SPX Index)` is one number that belongs to no instrument at all. Its
 *    `instrumentId` is `0` and its `subject` is `''`, because it has no plant subject; what it has
 *    is `deps`, the subjects it reads, which is what the screen subscribes to so the cell
 *    recomputes on every input tick.
 *
 * Both go through `core/formula` — the same lexer, parser and evaluator the client runs on every
 * delta. That is the point of evaluating server-side at all: the CSV a user exports and the grid
 * they exported it from have to agree, and they only do if one implementation produced both.
 *
 * A formula that cannot be evaluated is **not** an error: it lands in `formulaErrors[]`, the
 * affected cells go `st:'na'`, and the other forty-nine rows still paint (CHRT-07). A grid that
 * refuses to render because one column has a typo in it is a grid nobody edits.
 *
 * The resolver never writes. Every mutation is an `sdk.watchlists.*` call followed by a re-run,
 * which is what keeps `GET /watchlists/:id/export.csv` and this payload the same thing.
 */

import { sql } from 'drizzle-orm';

import type { FieldId, ValueCell } from '@terminal/core';
import {
  DEFAULT_FORMULA_FIELD,
  evaluateFormula,
  monitorColumn,
  parseFormula,
} from '@terminal/core';
import type { FormulaContext, FormulaSecurity, SortSpec } from '@terminal/core';
import type {
  WActive,
  WFormulaError,
  WListSummary,
  WParams,
  WPayload,
  WRow,
  WSharedScope,
} from '@terminal/core/functions/manifests/W';
import type { MonitorColumn } from '@terminal/core/functions/shared/monitor';

import { AppError } from '../../http/errors.js';
import type { GatedQuoteState, ResolveContext } from '../context.js';
import { cellFromState } from '../shared/cells.js';
import { rowMeta, type RowMeta } from '../QM/resolve.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The stored list (§W resolver steps 1-2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface ListSql extends Record<string, unknown> {
  watchlist_id: string;
  name: string;
  owner_user_id: string;
  owner_display: string;
  shared_scope: string;
  shared_user_ids: number[] | null;
  columns: unknown;
  sort: unknown;
  group_by: string | null;
  item_count: string;
  updated_at: string;
}

interface ItemSql extends Record<string, unknown> {
  position: number;
  instrument_id: string | null;
  formula: string | null;
  label: string | null;
  note: string | null;
  added_at: string;
}

/**
 * Every list the caller may see, newest first.
 *
 * Visibility is RLS's decision (`watchlists_scope`), not this query's: own lists, firm-scoped lists
 * of the caller's firm, and lists that name them in `shared_user_ids`. A `WHERE` clause here that
 * repeated the policy would be a second copy of an access rule, and the two would drift.
 */
async function listsVisible(ctx: ResolveContext): Promise<ListSql[]> {
  const res = await ctx.db.execute<ListSql>(sql`
    SELECT w.watchlist_id::text AS watchlist_id,
           w.name,
           w.owner_user_id::text AS owner_user_id,
           coalesce(u.display_name, u.email, '') AS owner_display,
           w.shared_scope, w.shared_user_ids, w.columns, w.sort, w.group_by,
           (SELECT count(*) FROM watchlist_items i WHERE i.watchlist_id = w.watchlist_id)::text
             AS item_count,
           to_char(w.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
      FROM watchlists w
      LEFT JOIN users u ON u.user_id = w.owner_user_id
     ORDER BY w.updated_at DESC, w.watchlist_id DESC`);
  return [...res.rows];
}

async function itemsOf(ctx: ResolveContext, watchlistId: number): Promise<ItemSql[]> {
  const res = await ctx.db.execute<ItemSql>(sql`
    SELECT position, instrument_id::text AS instrument_id, formula, label, note,
           to_char(added_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS added_at
      FROM watchlist_items
     WHERE watchlist_id = ${watchlistId}
     ORDER BY position`);
  return [...res.rows];
}

interface StoredColumn {
  id: string;
  label?: string;
  formula?: string;
  decimals?: number;
}

function storedColumns(raw: unknown): StoredColumn[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredColumn[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const column = entry as Record<string, unknown>;
    if (typeof column.id !== 'string') continue;
    const next: StoredColumn = { id: column.id };
    if (typeof column.label === 'string') next.label = column.label;
    if (typeof column.formula === 'string') next.formula = column.formula;
    if (typeof column.decimals === 'number') next.decimals = column.decimals;
    out.push(next);
  }
  return out;
}

function storedSort(raw: unknown): SortSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: SortSpec[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const spec = entry as Record<string, unknown>;
    if (typeof spec.col !== 'string') continue;
    if (spec.dir !== 'asc' && spec.dir !== 'desc') continue;
    out.push({ col: spec.col, dir: spec.dir });
  }
  return out;
}

function sharedScopeOf(raw: string): WSharedScope {
  return raw === 'firm' || raw === 'users' ? raw : 'private';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Formula plumbing (§W resolver steps 3-4)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One security a formula names, and the instrument it resolved to (or did not). */
interface Leaf {
  canonical: string;
  text: string;
  instrumentId: number | null;
  subject: string;
}

/**
 * The `(security, field)` pairs a formula reads, taken from the evaluator's own record.
 *
 * Every accessor answers `1` so nothing short-circuits and `inputs` comes back complete. Walking
 * the AST here instead would be a second implementation of the language's scoping rules, and the
 * two would disagree the first time a function was added.
 */
function probe(formula: string): { securities: string[]; fields: FieldId[] } {
  const securities: string[] = [];
  const fields: FieldId[] = [];
  const probeCtx: FormulaContext = {
    field: () => 1,
    series: (_s, _f, length) => Array.from({ length: Math.max(length, 1) }, () => 1),
    defaultField: DEFAULT_FORMULA_FIELD,
  };
  const evaluation = evaluateFormula(formula, probeCtx);
  for (const input of evaluation.inputs) {
    if (!fields.includes(input.field)) fields.push(input.field);
    if (input.security !== null && !securities.includes(input.security)) {
      securities.push(input.security);
    }
  }
  return { securities, fields };
}

/** A human message for a formula that would not evaluate — what the amber badge prints. */
function formulaMessage(formula: string): string | null {
  const parsed = parseFormula(formula);
  if (!parsed.ok) {
    const problem = parsed.problems[0];
    return problem === undefined
      ? 'parse error'
      : `${problem.message} (at ${String(problem.span[0])})`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: WParams): Promise<WPayload> {
  const me = { userId: ctx.user.userId, firmId: ctx.user.firmId };
  const asOf = ctx.asOf.validAt.toISOString();

  // 1 — every visible list, and which one is active.
  const lists = await listsVisible(ctx);
  const watchlists: WListSummary[] = lists.map((row) => ({
    watchlistId: Number(row.watchlist_id),
    name: row.name,
    ownerUserId: Number(row.owner_user_id),
    ownerDisplay: row.owner_display,
    isOwner: Number(row.owner_user_id) === ctx.user.userId,
    sharedScope: sharedScopeOf(row.shared_scope),
    itemCount: Number(row.item_count),
    updatedAt: row.updated_at,
  }));

  const wanted = params.watchlist;
  let active: ListSql | undefined;
  if (wanted === undefined) {
    active = lists.find((row) => Number(row.owner_user_id) === ctx.user.userId);
  } else if ('id' in wanted) {
    active = lists.find((row) => Number(row.watchlist_id) === wanted.id);
    // RLS already hid a list of another firm, so "not in the visible set" IS "not found" — the
    // same answer for a list that does not exist and one the caller may not see (SEC-05).
    if (active === undefined)
      throw new AppError('NOT_FOUND', `watchlist ${String(wanted.id)} not found`);
  } else {
    const name = wanted.name.toLowerCase();
    active = lists.find((row) => row.name.toLowerCase() === name);
    if (active === undefined) throw new AppError('NOT_FOUND', `watchlist ${wanted.name} not found`);
  }

  if (active === undefined) {
    ctx.unavailable.add({
      field: 'active',
      reason: 'NOT_APPLICABLE',
      detail: 'no watchlists — Ctrl+N creates one',
    });
    return { variant: 'default', me, watchlists, active: null, asOf };
  }

  // 2 — the list definition and its items.
  const watchlistId = Number(active.watchlist_id);
  const items = await itemsOf(ctx, watchlistId);
  const defined = storedColumns(active.columns);
  const formulaErrors: WFormulaError[] = [];

  const columns: MonitorColumn[] = defined.map((column) => {
    if (column.formula === undefined) return monitorColumn(column.id);
    const base: MonitorColumn = {
      id: column.id,
      label: column.label ?? column.id,
      fmt: 'px',
      formula: column.formula,
    };
    return column.decimals === undefined ? base : { ...base, decimals: column.decimals };
  });
  const fieldColumns = columns.filter((c) => c.fieldId !== undefined);
  const formulaColumns = columns.filter((c) => c.formula !== undefined);

  // 3a — plain rows: metadata and plant cells.
  const plainIds = items
    .filter((item) => item.instrument_id !== null)
    .map((item) => Number(item.instrument_id));
  const meta: Map<number, RowMeta> = await rowMeta(ctx, plainIds);

  // 3b — formula leaves: every security a formula row or column names, resolved once.
  const leafRefs = new Set<string>();
  for (const item of items) {
    if (item.formula === null) continue;
    for (const security of probe(item.formula).securities) leafRefs.add(security);
  }
  for (const column of formulaColumns) {
    for (const security of probe(column.formula!).securities) leafRefs.add(security);
  }

  const leaves = new Map<string, Leaf>();
  for (const ref of leafRefs) {
    const item = await ctx.data.reference.resolve(ref);
    const instrumentId = item.instrument?.instrumentId ?? null;
    leaves.set(ref, {
      canonical: ref,
      text: ref,
      instrumentId,
      subject: instrumentId === null ? '' : ctx.plant.subjectFor(instrumentId),
    });
  }

  // One snapshot read for the plain rows and the formula leaves together.
  const subjects = [
    ...plainIds.map((id) => ctx.plant.subjectFor(id)),
    ...[...leaves.values()].map((l) => l.subject).filter((s) => s !== ''),
  ];
  ctx.plant.ensureHot(subjects);
  const snapshots: Map<string, GatedQuoteState> = ctx.plant.snapshotMany(subjects);

  /** A leaf's current value of `field`, or `null` when it was never polled or is denied. */
  const leafValue = (security: FormulaSecurity | null, field: FieldId): number | null => {
    if (security === null) return null;
    const leaf = leaves.get(security.canonical) ?? leaves.get(security.text);
    if (leaf === undefined || leaf.subject === '') return null;
    const state = snapshots.get(leaf.subject);
    const value = state?.fields[field as keyof typeof state.fields];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };

  // 4 — the rows.
  const rows: WRow[] = [];
  for (const item of items) {
    const plainId = item.instrument_id === null ? null : Number(item.instrument_id);
    const info = plainId === null ? undefined : meta.get(plainId);
    const subject = plainId === null ? '' : ctx.plant.subjectFor(plainId);
    const state = subject === '' ? undefined : snapshots.get(subject);
    const cells: Record<string, ValueCell> = {};
    const deps: string[] = [];

    if (plainId !== null) {
      for (const column of fieldColumns) {
        cells[column.id] = cellFromState(ctx, state, column.fieldId!, subject);
      }
    } else {
      // A formula row's own cells: the expression under each field column, so `PX_LAST` is the
      // ratio of prices and `PX_VOLUME` the ratio of volumes (the default field is the column).
      const formula = item.formula!;
      const message = formulaMessage(formula);
      if (message !== null) formulaErrors.push({ where: `row:${String(item.position)}`, message });
      for (const column of fieldColumns) {
        const field = column.fieldId!;
        const evaluation = evaluateFormula(formula, {
          field: leafValue,
          defaultField: field,
        });
        cells[column.id] =
          evaluation.value === null
            ? { v: null, st: 'na', provIdx: -1 }
            : {
                v: evaluation.value,
                st: 'live',
                provIdx: firstLeafProvIdx(ctx, formula, leaves, snapshots),
              };
      }
      for (const security of probe(formula).securities) {
        const leaf = leaves.get(security);
        if (leaf !== undefined && leaf.subject !== '' && !deps.includes(leaf.subject)) {
          deps.push(leaf.subject);
        }
      }
    }

    // 4b — formula columns, over this row's own cells.
    for (const column of formulaColumns) {
      const formula = column.formula!;
      const evaluation = evaluateFormula(formula, {
        field: (security, field): number | null => {
          if (security !== null) return leafValue(security, field);
          const cell = cells[field];
          const value = cell?.v;
          return typeof value === 'number' && Number.isFinite(value) ? value : null;
        },
        defaultField: DEFAULT_FORMULA_FIELD,
      });
      cells[column.id] =
        evaluation.value === null
          ? { v: null, st: 'na', provIdx: -1 }
          : { v: evaluation.value, st: state?.state ?? 'live', provIdx: cellProvIdx(cells) };
      for (const security of probe(formula).securities) {
        const leaf = leaves.get(security);
        if (leaf !== undefined && leaf.subject !== '' && !deps.includes(leaf.subject)) {
          deps.push(leaf.subject);
        }
      }
    }

    rows.push({
      instrumentId: info?.instrumentId ?? 0,
      key: info?.key ?? item.formula ?? '',
      name: info?.name ?? item.label ?? item.formula ?? '',
      assetClass: info?.assetClass ?? 'equity',
      marketSector: info?.marketSector ?? 'Equity',
      exchCode: info?.exchCode ?? '',
      gicsSector: info?.gicsSector ?? null,
      subject,
      cells,
      position: item.position,
      label: item.label,
      note: item.note,
      addedAt: item.added_at,
      formula: item.formula,
      deps,
    });
  }

  // One error per column, not one per row: a typo in `c1` is one mistake, however many rows it
  // touches (§W "Unavailable").
  for (const column of formulaColumns) {
    const message = formulaMessage(column.formula!);
    if (message !== null) formulaErrors.push({ where: column.id, message });
  }

  if (formulaErrors.length > 0) {
    ctx.unavailable.add({
      field: 'formulaErrors',
      reason: 'NOT_APPLICABLE',
      detail: formulaErrors.map((e) => `${e.where}: ${e.message}`).join('; '),
    });
  }

  const activeBlock: WActive = {
    watchlistId,
    name: active.name,
    isOwner: Number(active.owner_user_id) === ctx.user.userId,
    sharedScope: sharedScopeOf(active.shared_scope),
    sharedUserIds: active.shared_user_ids ?? [],
    updatedAt: active.updated_at,
    columns,
    sort: storedSort(active.sort),
    groupBy: active.group_by,
    rows,
    formulaErrors,
  };

  return { variant: 'default', me, watchlists, active: activeBlock, asOf };
}

/**
 * The provenance a computed cell cites: its first leaf's snapshot (§0.4 rule 4).
 *
 * A derived value cites the provenance of its primary input rather than none at all — `Ctrl+I` on
 * a ratio should reach the quote it was computed from, which is the only source that exists.
 */
function firstLeafProvIdx(
  ctx: ResolveContext,
  formula: string,
  leaves: ReadonlyMap<string, Leaf>,
  snapshots: ReadonlyMap<string, GatedQuoteState>,
): number {
  for (const security of probe(formula).securities) {
    const leaf = leaves.get(security);
    if (leaf === undefined || leaf.subject === '') continue;
    const state = snapshots.get(leaf.subject);
    if (state === undefined) continue;
    return ctx.prov.addQuote(state);
  }
  return -1;
}

/** The provenance a formula COLUMN cites: the first cited cell of the row it was computed over. */
function cellProvIdx(cells: Readonly<Record<string, ValueCell>>): number {
  for (const cell of Object.values(cells)) {
    if (cell.provIdx >= 0) return cell.provIdx;
  }
  return -1;
}
