/**
 * `http/routes/watchlists.ts` — API.md §5.8 L643-668 (W, CHRT-07) and the §9 CSV export L1189,
 * WP-09.
 *
 *   GET    /watchlists                        own + firm-shared + shared-with-me, items omitted
 *   POST   /watchlists                        create, with an optional first membership
 *   GET    /watchlists/:id                    with items (any reader)
 *   PUT    /watchlists/:id                    owner — everything but the membership
 *   DELETE /watchlists/:id                    owner
 *   PUT    /watchlists/:id/items              owner — full replace, ≤ 2 000 rows
 *   GET    /watchlists/:id/export.csv         the W grid as a file (§9)
 *
 * Four rules hold throughout:
 *
 *  1. **Reading is wider than writing, and both are in the SQL.** Migration 0015's
 *     `watchlists_scope` lets a colleague read a firm-shared list and lets only the owner write
 *     one. Every statement here restates that predicate itself ({@link visibleTo}, {@link ownedBy})
 *     beside the policy, because RLS is not applied to the role that owns the tables: a local
 *     superuser `DATABASE_URL` or a future `BYPASSRLS` role would otherwise see every desk's
 *     lists. Zero rows is `404 NOT_FOUND`, never `403` — a 403 would confirm the id exists
 *     (API.md L186).
 *  2. **A member is resolved once, when it is written.** `watchlist_items.instrument_id` is an
 *     id, so `SecurityRefInput` is resolved on the way in and an unresolvable reference is
 *     refused there rather than rendering as a blank row every morning afterwards. The
 *     CHECK constraint `(instrument_id IS NULL) <> (formula IS NULL)` is the shape of
 *     `WatchlistItemInput`'s own union, so the two cannot drift.
 *  3. **The export resolves values through the dispatcher, with `usage:'export'`.** Not through
 *     `data/snapshot.ts` directly: §9 says the evaluator re-runs for an export and that *any*
 *     denied field fails the whole file. A watchlist CSV built off an ungated read would be the
 *     one screen in the terminal that hands a firm numbers its licence refuses to export.
 *  4. **Computed columns are `core/formula`, never a second expression language.** A `c<n>`
 *     column and a formula *row* (CHRT-07's `RATIO(AAPL US Equity, SPX Index)`) are the same
 *     evaluator with a different default field: a formula row under the `PX_LAST` column is the
 *     ratio of last prices, under `PX_VOLUME` the ratio of volumes. That is what
 *     `FormulaContext.defaultField` is for.
 *
 * Watchlist members of connected users join the plant hot set (ARCHITECTURE §6.2); that is
 * `plant/hotset.ts`'s query over `watchlist_items`, not this file's business.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import {
  DEFAULT_FORMULA_FIELD,
  evaluateFormula,
  type FieldId,
  type FormulaContext,
  type FormulaSecurity,
} from '@terminal/core';
import { writeCsv, standardHeaderLines } from '@terminal/core/functions/csv';
import type { CsvColumn, CsvDocument } from '@terminal/core/functions/manifest';
import type { DataRequestInput, DataResponse } from '@terminal/sdk/wire/dataRequest';
import type { InstrumentSummary, SecurityRefInput } from '@terminal/sdk/wire/common';
import {
  CreateWatchlistRequest,
  ReplaceWatchlistItemsRequest,
  UpdateWatchlistRequest,
  WatchlistParams,
  type Watchlist,
  type WatchlistColumn,
  type WatchlistItem,
  type WatchlistItemInput,
  type WatchlistListResponse,
} from '@terminal/sdk/wire/rest/watchlists';

import { toInstrumentSummary } from '../../data/request.js';
import type { AsOf } from '../../db/bitemporal.js';
import { withTx, type Tx } from '../../db/client.js';
import { SecurityResolver } from '../../refdata/resolve.js';
import { requireSession, type Principal } from '../auth/session.js';
import { AppError, ConflictError, NotFoundError, ValidationFailedError } from '../errors.js';
import { EXPORT_LIMIT, rateLimit, REST_LIMIT } from '../rateLimit.js';
import { asOfOfRequest, dispatcherFor, quotasOf } from './data.js';
import { ctxOf, hostDepsOf, parse, principalOf } from './functions.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `to_char` mask rendering a timestamptz as the `z.iso.datetime()` the wire expects. */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** `kind:'realtime'` takes at most 100 fields (wire `DataRequest`). */
const MAX_EXPORT_FIELDS = 100;

/** A path id, as a positive integer, or the documented 400. */
function idParam(raw: unknown, key: string): number {
  const source = (raw ?? {}) as Record<string, unknown>;
  const value = source[key];
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationFailedError('params', [
      { code: 'invalid_type', path: [key], message: `${key} must be a positive integer` },
    ]);
  }
  return WatchlistParams.parse({ watchlistId: n }).watchlistId;
}

/** Postgres' unique-violation SQLSTATE — `watchlists (owner_user_id, name)`. */
function isUniqueViolation(err: unknown): boolean {
  for (let cursor: unknown = err, depth = 0; cursor !== undefined && depth < 5; depth += 1) {
    if (typeof cursor !== 'object' || cursor === null) return false;
    if ((cursor as { code?: unknown }).code === '23505') return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/** `watchlists_scope` (migration 0015) restated: own, firm-shared, or shared with me. */
function visibleTo(principal: Principal): SQL {
  const userId = sql`${String(principal.userId)}::bigint`;
  return sql`(owner_user_id = ${userId}
              OR (firm_id = ${String(principal.firmId)}::bigint
                  AND (shared_scope = 'firm'
                       OR (shared_scope = 'users' AND ${userId} = ANY (shared_user_ids)))))`;
}

/** The owner predicate every mutation carries, beside the policy's `WITH CHECK`. */
function ownedBy(principal: Principal): SQL {
  return sql`owner_user_id = ${String(principal.userId)}::bigint`;
}

function bigintArray(ids: readonly number[]): SQL {
  if (ids.length === 0) return sql`'{}'::bigint[]`;
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${String(id)}::bigint`),
    sql`, `,
  )}]::bigint[]`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────────────────────

const WATCHLIST_COLUMNS: SQL = sql`
  watchlist_id::text AS watchlist_id, owner_user_id::text AS owner_user_id, name,
  columns, sort, group_by, shared_scope, shared_user_ids,
  to_char(updated_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS updated_at`;

type WatchlistSqlRow = {
  watchlist_id: string;
  owner_user_id: string;
  name: string;
  columns: unknown;
  sort: unknown;
  group_by: string | null;
  shared_scope: Watchlist['sharedScope'];
  shared_user_ids: readonly (string | number)[] | null;
  updated_at: string;
};

type ItemSqlRow = {
  position: number;
  instrument_id: string | null;
  formula: string | null;
  label: string | null;
  note: string | null;
  added_at: string;
};

/**
 * The stored row as the wire declares it.
 *
 * `columns` and `sort` are handed back as stored rather than re-parsed: a list written by an
 * older client keeps the column set its owner chose, exactly as `workspaces.ts` returns layouts
 * verbatim. Both were validated by the wire schema on the way in.
 */
function toWatchlist(row: WatchlistSqlRow, items?: WatchlistItem[]): Watchlist {
  return {
    watchlistId: Number(row.watchlist_id),
    ownerUserId: Number(row.owner_user_id),
    name: row.name,
    columns: (Array.isArray(row.columns) ? row.columns : []) as WatchlistColumn[],
    sort: (Array.isArray(row.sort) ? row.sort : []) as Watchlist['sort'],
    groupBy: row.group_by,
    sharedScope: row.shared_scope,
    sharedUserIds: (row.shared_user_ids ?? []).map(Number),
    updatedAt: row.updated_at,
    ...(items === undefined ? {} : { items }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function selectOne(tx: Tx, where: SQL): Promise<WatchlistSqlRow | undefined> {
  const res = await tx.execute<WatchlistSqlRow>(
    sql`SELECT ${WATCHLIST_COLUMNS} FROM watchlists WHERE ${where}`,
  );
  return res.rows[0];
}

/** The list a reader may see, or the documented 404. */
async function readable(
  tx: Tx,
  principal: Principal,
  watchlistId: number,
): Promise<WatchlistSqlRow> {
  const row = await selectOne(
    tx,
    sql`watchlist_id = ${String(watchlistId)}::bigint AND ${visibleTo(principal)}`,
  );
  if (row === undefined) throw new NotFoundError('No such watchlist.');
  return row;
}

/** The list the caller owns, or the documented 404 — a non-owner is not told it exists. */
async function writable(
  tx: Tx,
  principal: Principal,
  watchlistId: number,
): Promise<WatchlistSqlRow> {
  const row = await selectOne(
    tx,
    sql`watchlist_id = ${String(watchlistId)}::bigint AND ${ownedBy(principal)}`,
  );
  if (row === undefined) throw new NotFoundError('No such watchlist.');
  return row;
}

async function itemsOf(tx: Tx, at: AsOf, watchlistId: number): Promise<WatchlistItem[]> {
  const res = await tx.execute<ItemSqlRow>(sql`
    SELECT position, instrument_id::text AS instrument_id, formula, label, note,
           to_char(added_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS added_at
      FROM watchlist_items
     WHERE watchlist_id = ${String(watchlistId)}::bigint
     ORDER BY position`);

  const instrumentIds = res.rows
    .map((row) => (row.instrument_id === null ? null : Number(row.instrument_id)))
    .filter((id): id is number => id !== null);
  const summaries = await summariesFor(tx, at, instrumentIds);

  return res.rows.map((row) => {
    const instrumentId = row.instrument_id === null ? null : Number(row.instrument_id);
    return {
      position: row.position,
      // A member whose instrument has no version at this pair renders as `null` rather than
      // dropping the row: the position is the user's, and a gap would silently renumber the grid.
      instrument: instrumentId === null ? null : (summaries.get(instrumentId) ?? null),
      formula: row.formula,
      label: row.label,
      note: row.note,
      addedAt: row.added_at,
    };
  });
}

/** One batched resolve for a whole membership — never one query per row. */
async function summariesFor(
  tx: Tx,
  at: AsOf,
  instrumentIds: readonly number[],
): Promise<Map<number, InstrumentSummary>> {
  const out = new Map<number, InstrumentSummary>();
  if (instrumentIds.length === 0) return out;
  const unique = [...new Set(instrumentIds)];
  const resolver = new SecurityResolver(tx);
  const results = await resolver.resolveMany(
    unique.map((id) => ({ id })),
    at,
  );
  for (const result of results) {
    if (!result.ok) continue;
    out.set(result.instrument.instrumentId, toInstrumentSummary(result.instrument));
  }
  return out;
}

/**
 * `WatchlistItemInput[]` → the rows `watchlist_items` stores.
 *
 * Security references are resolved here, against the request's own `asOf`. A reference that names
 * nothing is the resolver's own error code — `SECURITY_NOT_FOUND`, or `409 AMBIGUOUS_SECURITY`
 * with the candidates — because "which AAPL?" is a question the caller can answer and a blank row
 * is not.
 */
async function toRows(
  tx: Tx,
  at: AsOf,
  items: readonly WatchlistItemInput[],
): Promise<{ instrumentId: number | null; formula: string | null; label: string | null; note: string | null }[]> {
  const resolver = new SecurityResolver(tx);
  const rows: {
    instrumentId: number | null;
    formula: string | null;
    label: string | null;
    note: string | null;
  }[] = [];

  for (const item of items) {
    if ('formula' in item) {
      rows.push({
        instrumentId: null,
        formula: item.formula,
        label: item.label,
        note: item.note ?? null,
      });
      continue;
    }
    const ref: SecurityRefInput = item.security;
    if ('formula' in ref) {
      // `SecurityRefInput`'s formula arm is a chart input, not a member: a watchlist row that is
      // a computed series is the `{ formula, label }` arm of `WatchlistItemInput`, which stores
      // the expression instead of pretending it resolved to an instrument.
      throw new ValidationFailedError('body', [
        {
          code: 'custom',
          path: ['items'],
          message: 'a computed series is a { formula, label } item, not a { security } one',
        },
      ]);
    }
    const outcome = await resolver.resolve('id' in ref ? { id: ref.id } : ref.ref, at);
    if (!outcome.ok) {
      const code = outcome.code === 'AMBIGUOUS_SECURITY' ? 'AMBIGUOUS_SECURITY' : 'SECURITY_NOT_FOUND';
      throw new AppError(code, outcome.message, {
        details: { candidates: outcome.candidates.map(toInstrumentSummary) },
      });
    }
    rows.push({
      instrumentId: outcome.instrument.instrumentId,
      formula: null,
      label: item.label ?? null,
      note: item.note ?? null,
    });
  }
  return rows;
}

/** Replace a membership wholesale, in the caller's transaction. */
async function replaceItems(
  tx: Tx,
  watchlistId: number,
  rows: readonly {
    instrumentId: number | null;
    formula: string | null;
    label: string | null;
    note: string | null;
  }[],
): Promise<void> {
  await tx.execute(
    sql`DELETE FROM watchlist_items WHERE watchlist_id = ${String(watchlistId)}::bigint`,
  );
  if (rows.length === 0) return;
  const values = rows.map(
    (row, index) => sql`(${String(watchlistId)}::bigint, ${index},
       ${row.instrumentId === null ? sql`NULL::bigint` : sql`${String(row.instrumentId)}::bigint`},
       ${row.formula}, ${row.label}, ${row.note})`,
  );
  await tx.execute(sql`
    INSERT INTO watchlist_items (watchlist_id, position, instrument_id, formula, label, note)
    VALUES ${sql.join(values, sql`, `)}`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The CSV export (§9 L1189, CHRT-07)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A column the grid shows: a dictionary field, or a `c<n>` formula over the row's fields. */
interface ResolvedColumn {
  id: string;
  label: string;
  fieldId: FieldId | null;
  formula: string | null;
  decimals: number | undefined;
}

function resolveColumns(columns: readonly WatchlistColumn[]): ResolvedColumn[] {
  return columns.map((column) => {
    if ('formula' in column) {
      return {
        id: column.id,
        label: column.label,
        fieldId: null,
        formula: column.formula,
        decimals: column.decimals,
      };
    }
    return {
      id: column.id,
      label: column.label ?? column.id,
      fieldId: column.id,
      formula: null,
      decimals: column.decimals,
    };
  });
}

/**
 * Which `(security, field)` pairs a formula reads, without any data.
 *
 * Every accessor answers `1`, so nothing short-circuits and `FormulaEvaluation.inputs` comes back
 * complete. It is the evaluator's own record of what it asked for — the alternative, walking the
 * AST here, would be a second implementation of the formula language's scoping rules.
 */
function probeInputs(
  formula: string,
  defaultField: FieldId,
): { securities: Set<string>; fields: Set<FieldId> } {
  const securities = new Set<string>();
  const fields = new Set<FieldId>();
  const ctx: FormulaContext = {
    field: () => 1,
    series: (_security, _field, length) => Array.from({ length: Math.max(length, 1) }, () => 1),
    defaultField,
  };
  const evaluation = evaluateFormula(formula, ctx);
  for (const input of evaluation.inputs) {
    fields.add(input.field);
    if (input.security !== null) securities.add(input.security);
  }
  return { securities, fields };
}

/** The values one export read, keyed by security (instrument id, or a named ref) and field. */
interface ValueBook {
  byInstrument: Map<number, Record<string, number | null>>;
  byRef: Map<string, Record<string, number | null>>;
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bookOf(response: DataResponse, refOrder: readonly string[]): ValueBook {
  const byInstrument = new Map<number, Record<string, number | null>>();
  const byRef = new Map<string, Record<string, number | null>>();
  for (const result of response.results) {
    const fields: Record<string, number | null> = {};
    for (const [fieldId, value] of Object.entries(result.fields ?? {})) {
      fields[fieldId] = numberOf(value);
    }
    if (result.instrument !== null) byInstrument.set(result.instrument.instrumentId, fields);
    const security = result.security as { ref?: string };
    if (typeof security.ref === 'string' && refOrder.includes(security.ref)) {
      byRef.set(security.ref, fields);
    }
  }
  return { byInstrument, byRef };
}

/**
 * The evaluation context for one grid row.
 *
 * `field(null, f)` is the row's own value: a member's field, or — for a CHRT-07 formula *row* —
 * that row's expression evaluated with `f` as the default field, which is what makes
 * `RATIO(AAPL US Equity, SPX Index)` a price ratio under `PX_LAST` and a volume ratio under
 * `PX_VOLUME`. `field(security, f)` is a named security's value from the same read.
 */
function contextFor(
  row: { instrumentId: number | null; formula: string | null },
  book: ValueBook,
  defaultField: FieldId,
  depth = 0,
): FormulaContext {
  const named = (security: FormulaSecurity | null): Record<string, number | null> | undefined => {
    if (security === null) {
      return row.instrumentId === null ? undefined : book.byInstrument.get(row.instrumentId);
    }
    return book.byRef.get(security.canonical) ?? book.byRef.get(security.text);
  };

  return {
    field: (security, field): number | null => {
      if (security === null && row.instrumentId === null && row.formula !== null) {
        // A formula row under a field column. `depth` stops a row whose expression somehow names
        // itself from recursing; the parser cannot produce one today, and a guard is cheaper than
        // trusting that it never will.
        if (depth > 0) return null;
        return evaluateFormula(row.formula, contextFor(row, book, field, depth + 1)).value;
      }
      return named(security)?.[field] ?? null;
    },
    defaultField,
  };
}

/** §9: any denied field fails the whole export — a subset is never silently written. */
function denialsOf(response: DataResponse): { fieldId: string; reason: string }[] {
  const out: { fieldId: string; reason: string }[] = [];
  for (const result of response.results) {
    for (const [fieldId, reason] of Object.entries(result.r ?? {})) {
      out.push({ fieldId, reason });
    }
  }
  return out;
}

/** `'W_Core_20260915T184128Z.csv'` — the §9 shape, with the list's name in place of a security. */
function filenameOf(name: string, validAt: string): string {
  const slug = name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const stamp = validAt.replace(/[-:]/g, '').replace(/\.\d+/, '');
  return `W_${slug === '' ? 'watchlist' : slug}_${stamp}.csv`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const watchlistsRoutes: FastifyPluginAsync = async (app) => {
  // API.md §5.8's Role column is "any" on every route; ownership, not role, decides what a
  // request may touch, and the export carries `data:read` because it serves field values.
  const read = { preHandler: [requireSession(), rateLimit(REST_LIMIT)] };
  const write = { preHandler: [requireSession(), rateLimit(REST_LIMIT)] };
  const exportGuard = {
    preHandler: [requireSession({ scopes: ['data:read'] }), rateLimit(EXPORT_LIMIT)],
  };

  const asOfOf = (request: FastifyRequest): AsOf =>
    asOfOfRequest(
      request.query ?? {},
      app.deps.clock,
    );

  // ── GET /watchlists ────────────────────────────────────────────────────────────────────────
  app.get('/watchlists', read, async (request): Promise<WatchlistListResponse> => {
    const principal = principalOf(request);
    return withTx(ctxOf(principal), async (tx) => {
      const res = await tx.execute<WatchlistSqlRow>(sql`
        SELECT ${WATCHLIST_COLUMNS} FROM watchlists
         WHERE ${visibleTo(principal)}
         ORDER BY name`);
      // `items` omitted on the list route (API.md L661): a desk with thirty lists of two hundred
      // names each would otherwise resolve six thousand instruments to draw a sidebar.
      return { items: res.rows.map((row) => toWatchlist(row)) };
    });
  });

  // ── POST /watchlists ───────────────────────────────────────────────────────────────────────
  app.post('/watchlists', write, async (request, reply): Promise<Watchlist> => {
    const principal = principalOf(request);
    const body = parse(CreateWatchlistRequest, request.body, 'body');
    const at = asOfOf(request);

    const created = await withTx(ctxOf(principal), async (tx) => {
      const rows = await toRows(tx, at, body.items ?? []);
      let row: WatchlistSqlRow | undefined;
      try {
        const res = await tx.execute<WatchlistSqlRow>(sql`
          INSERT INTO watchlists (owner_user_id, firm_id, name, columns, sort, group_by,
                                  shared_scope, shared_user_ids)
          VALUES (${String(principal.userId)}::bigint, ${String(principal.firmId)}::bigint,
                  ${body.name}, ${JSON.stringify(body.columns)}::jsonb,
                  ${JSON.stringify(body.sort ?? [])}::jsonb, ${body.groupBy ?? null},
                  ${body.sharedScope ?? 'private'}, ${bigintArray(body.sharedUserIds ?? [])})
          RETURNING ${WATCHLIST_COLUMNS}`);
        row = res.rows[0];
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError('DUPLICATE_NAME', `A watchlist named "${body.name}" exists.`);
        }
        throw err;
      }
      if (row === undefined) throw new NotFoundError('The watchlist was not written.');

      await replaceItems(tx, Number(row.watchlist_id), rows);
      return toWatchlist(row, await itemsOf(tx, at, Number(row.watchlist_id)));
    });

    void reply.status(201);
    return created;
  });

  // ── GET /watchlists/:watchlistId ───────────────────────────────────────────────────────────
  app.get('/watchlists/:watchlistId', read, async (request): Promise<Watchlist> => {
    const principal = principalOf(request);
    const watchlistId = idParam(request.params, 'watchlistId');
    const at = asOfOf(request);
    return withTx(ctxOf(principal), async (tx) => {
      const row = await readable(tx, principal, watchlistId);
      return toWatchlist(row, await itemsOf(tx, at, watchlistId));
    });
  });

  // ── PUT /watchlists/:watchlistId ───────────────────────────────────────────────────────────
  app.put('/watchlists/:watchlistId', write, async (request): Promise<Watchlist> => {
    const principal = principalOf(request);
    const watchlistId = idParam(request.params, 'watchlistId');
    const body = parse(UpdateWatchlistRequest, request.body, 'body');
    const at = asOfOf(request);

    return withTx(ctxOf(principal), async (tx) => {
      await writable(tx, principal, watchlistId);
      let row: WatchlistSqlRow | undefined;
      try {
        const res = await tx.execute<WatchlistSqlRow>(sql`
          UPDATE watchlists
             SET name = ${body.name},
                 columns = ${JSON.stringify(body.columns)}::jsonb,
                 sort = ${JSON.stringify(body.sort ?? [])}::jsonb,
                 group_by = ${body.groupBy ?? null},
                 shared_scope = ${body.sharedScope ?? 'private'},
                 shared_user_ids = ${bigintArray(body.sharedUserIds ?? [])}
           WHERE watchlist_id = ${String(watchlistId)}::bigint AND ${ownedBy(principal)}
          RETURNING ${WATCHLIST_COLUMNS}`);
        row = res.rows[0];
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError('DUPLICATE_NAME', 'A watchlist of that name exists.');
        }
        throw err;
      }
      if (row === undefined) throw new NotFoundError('No such watchlist.');
      return toWatchlist(row, await itemsOf(tx, at, watchlistId));
    });
  });

  // ── DELETE /watchlists/:watchlistId ────────────────────────────────────────────────────────
  app.delete('/watchlists/:watchlistId', write, async (request, reply: FastifyReply) => {
    const principal = principalOf(request);
    const watchlistId = idParam(request.params, 'watchlistId');

    await withTx(ctxOf(principal), async (tx) => {
      // The membership goes first: `watchlist_items` cascades on the FK, but the cascade runs as
      // the table owner's rule rather than under the caller's policy, and deleting the rows this
      // session can see keeps the two in step.
      await tx.execute(
        sql`DELETE FROM watchlist_items WHERE watchlist_id = ${String(watchlistId)}::bigint`,
      );
      const res = await tx.execute<{ watchlist_id: string }>(sql`
        DELETE FROM watchlists
         WHERE watchlist_id = ${String(watchlistId)}::bigint AND ${ownedBy(principal)}
        RETURNING watchlist_id::text AS watchlist_id`);
      if (res.rows.length === 0) throw new NotFoundError('No such watchlist.');
    });

    void reply.status(204);
    return null;
  });

  // ── PUT /watchlists/:watchlistId/items ─────────────────────────────────────────────────────
  app.put('/watchlists/:watchlistId/items', write, async (request): Promise<Watchlist> => {
    const principal = principalOf(request);
    const watchlistId = idParam(request.params, 'watchlistId');
    const body = parse(ReplaceWatchlistItemsRequest, request.body, 'body');
    const at = asOfOf(request);

    return withTx(ctxOf(principal), async (tx) => {
      const row = await writable(tx, principal, watchlistId);
      await replaceItems(tx, watchlistId, await toRows(tx, at, body.items));
      // `watchlists.updated_at` is the list's own clock and a membership change moves it; the
      // `watchlists_updated` trigger fires on UPDATE, so the touch is explicit here.
      const touched = await tx.execute<WatchlistSqlRow>(sql`
        UPDATE watchlists SET name = name
         WHERE watchlist_id = ${String(watchlistId)}::bigint AND ${ownedBy(principal)}
        RETURNING ${WATCHLIST_COLUMNS}`);
      return toWatchlist(touched.rows[0] ?? row, await itemsOf(tx, at, watchlistId));
    });
  });

  // ── GET /watchlists/:watchlistId/export.csv (§9) ───────────────────────────────────────────
  app.get('/watchlists/:watchlistId/export.csv', exportGuard, async (request, reply) => {
    const principal = principalOf(request);
    const deps = hostDepsOf(request);
    const watchlistId = idParam(request.params, 'watchlistId');
    const at = asOfOf(request);

    const entitlements = deps.entitlements;
    if (entitlements === undefined) {
      throw new AppError('ENTITLEMENT_DENIED', 'No entitlement evaluator is wired.', {
        details: { reasons: [] },
      });
    }

    const out = await withTx(ctxOf(principal), async (tx) => {
      const listRow = await readable(tx, principal, watchlistId);
      const columns = resolveColumns(toWatchlist(listRow).columns);
      const items = await itemsOf(tx, at, watchlistId);

      // What the grid needs: the dictionary fields its columns name, plus every field any
      // formula — a `c<n>` column or a CHRT-07 formula row — turns out to read.
      const fields = new Set<FieldId>();
      const refs = new Set<string>();
      for (const column of columns) {
        if (column.fieldId !== null) fields.add(column.fieldId);
      }
      const defaults = [...fields];
      for (const column of columns) {
        if (column.formula === null) continue;
        const probe = probeInputs(column.formula, DEFAULT_FORMULA_FIELD);
        for (const field of probe.fields) fields.add(field);
        for (const ref of probe.securities) refs.add(ref);
      }
      for (const item of items) {
        if (item.formula === null) continue;
        // A formula row is read once per field column, so probe it under each of them.
        for (const field of defaults.length === 0 ? [DEFAULT_FORMULA_FIELD] : defaults) {
          const probe = probeInputs(item.formula, field);
          for (const read of probe.fields) fields.add(read);
          for (const ref of probe.securities) refs.add(ref);
        }
      }
      if (fields.size === 0) fields.add(DEFAULT_FORMULA_FIELD);
      if (fields.size > MAX_EXPORT_FIELDS) {
        throw new ValidationFailedError('params', [
          {
            code: 'too_big',
            path: ['columns'],
            message: `this watchlist reads ${String(fields.size)} fields; the realtime read takes ${String(MAX_EXPORT_FIELDS)}`,
          },
        ]);
      }

      const securities: SecurityRefInput[] = [
        ...items
          .map((item) => item.instrument?.instrumentId)
          .filter((id): id is number => typeof id === 'number')
          .map((id) => ({ id })),
        ...[...refs].map((ref) => ({ ref })),
      ];

      if (securities.length === 0) {
        // Nothing to price. The file is still produced — a header block, the column row and no
        // data rows — because an empty watchlist is an empty grid, not an error.
        const document: CsvDocument = {
          filename: filenameOf(listRow.name, at.validAt.toISOString()),
          attribution: [],
          asOf: at.validAt.toISOString(),
          columns: csvColumnsOf(columns),
          rows: [],
        };
        return {
          document,
          text: writeCsv(
            document,
            standardHeaderLines({
              code: 'W',
              display: listRow.name,
              params: { watchlistId },
              validAt: at.validAt.toISOString(),
              knownAt: at.knownAt.toISOString(),
              tier: 'eod',
              staleness: 'blank',
              attribution: [],
              provenance: [],
              engines: [],
              traceId: request.traceId,
              regenerated: false,
            }),
          ),
        };
      }

      const dispatcher = dispatcherFor({
        tx,
        clock: deps.clock,
        traceId: request.traceId,
        principal,
        entitlements,
        quotas: quotasOf(deps),
        usage: 'export',
        at,
      });
      const dataRequest: DataRequestInput = {
        kind: 'realtime',
        securities,
        fields: [...fields],
        asOf: { validAt: at.validAt.toISOString(), knownAt: at.knownAt.toISOString() },
        usage: 'export',
      };
      const response = await dispatcher.dispatch(dataRequest);

      const denials = denialsOf(response);
      if (denials.length > 0) {
        throw new AppError(
          'ENTITLEMENT_DENIED',
          `Export refused: ${String(denials.length)} field(s) are not licensed for export.`,
          { details: { reasons: denials } },
        );
      }

      const book = bookOf(response, [...refs]);
      const attribution: string[] = [];
      for (const row of response.meta.provenance) {
        if (row.attribution !== '' && !attribution.includes(row.attribution)) {
          attribution.push(row.attribution);
        }
      }

      const rows = items.map((item) => {
        const rowRef = {
          instrumentId: item.instrument?.instrumentId ?? null,
          formula: item.formula,
        };
        const cells: (string | number | boolean | null)[] = [
          item.instrument?.display ?? item.label ?? item.formula ?? '',
        ];
        for (const column of columns) {
          if (column.formula !== null) {
            cells.push(
              evaluateFormula(column.formula, contextFor(rowRef, book, DEFAULT_FORMULA_FIELD))
                .value,
            );
            continue;
          }
          const field = column.fieldId ?? DEFAULT_FORMULA_FIELD;
          cells.push(contextFor(rowRef, book, field).field(null, field) ?? null);
        }
        return cells;
      });

      const document: CsvDocument = {
        filename: filenameOf(listRow.name, response.meta.asOf.validAt),
        attribution,
        asOf: response.meta.asOf.validAt,
        columns: csvColumnsOf(columns),
        rows,
      };
      return {
        document,
        text: writeCsv(
          document,
          standardHeaderLines({
            code: 'W',
            display: listRow.name,
            params: { watchlistId },
            validAt: response.meta.asOf.validAt,
            knownAt: response.meta.asOf.knownAt,
            tier: response.meta.tier,
            staleness: response.meta.staleness,
            attribution,
            provenance: response.meta.provenance.map((row) => row.provenanceId),
            engines: response.meta.engines.map((e) => `${e.name}/${e.version}`),
            traceId: request.traceId,
            regenerated: false,
            unavailable: response.meta.unavailable.map((u) => ({
              field: u.field,
              reason: u.reason,
            })),
          }),
        ),
      };
    });

    void reply
      .header('x-as-of-valid', out.document.asOf)
      .header('cache-control', 'no-store')
      .header(
        'content-disposition',
        `attachment; filename="${out.document.filename.replace(/["\\]/g, '')}"`,
      )
      .type('text/csv; charset=utf-8');
    return out.text;
  });

  await Promise.resolve();
};

/** `security` first, then one column per grid column — the order the screen shows. */
function csvColumnsOf(columns: readonly ResolvedColumn[]): CsvColumn[] {
  return [
    { id: 'security', label: 'Security', type: 'string' },
    ...columns.map(
      (column): CsvColumn => ({
        id: column.id,
        label: column.label,
        type: 'number',
        ...(column.decimals === undefined ? {} : { decimals: column.decimals }),
      }),
    ),
  ];
}

export default watchlistsRoutes;
