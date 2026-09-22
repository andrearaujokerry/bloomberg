/**
 * `http/routes/workspaces.ts` — API.md §5.7 L597-642 (TERM-04, TERM-05, TERM-10, CHRT-05), WP-08.
 *
 * Twelve routes: the active workspace and its autosave, the named-workspace CRUD and the activate
 * flip, and the CHRT-05 chart annotations.
 *
 * Three rules hold throughout:
 *
 *  1. **Optimistic concurrency, enforced in SQL.** A `PUT` carries the `version` the client read;
 *     the `UPDATE` predicates on it and bumps it. Zero rows updated is not "nothing changed" — it
 *     is either a row that is not there (`404`) or a version that moved under the client
 *     (`409 WORKSPACE_VERSION_CONFLICT` with `details.current` holding the server's whole copy, so
 *     the client can merge last-writer-wins per panel and retry without a second round trip). The
 *     autosave is debounced 2 s client-side and two panels of the same desk race constantly; a
 *     read-modify-write here would lose a panel every time.
 *  2. **Ownership is in the SQL as well as in the policy, and a miss is a 404.** Migration 0015's
 *     `workspaces_owner` is `user_id = app_user_id()` and `annotations_scope` is own +
 *     firm-shared + shared-with-me. Every statement here *also* carries that predicate itself
 *     ({@link ownedBy}, {@link visibleAnnotation}), because RLS is not applied to the role that
 *     owns the tables — a local superuser `DATABASE_URL`, a migration console or a future
 *     `BYPASSRLS` role would otherwise see `WHERE is_active` match every desk in the database.
 *     Zero rows is reported as `404 NOT_FOUND`, never `403`: a 403 would confirm the id exists
 *     (API.md L186).
 *  3. **The wire schemas are normative.** Bodies are parsed with `@terminal/sdk/wire/rest/workspaces`
 *     and nothing is restated here.
 *
 * **Layouts are stored as written and returned as stored.** API.md L601 says the layout schema is
 * "migrated client-side on load", so a row written by an older client is handed back verbatim
 * rather than re-parsed and silently defaulted by this server.
 *
 * **First login has no seed.** API.md L633 says the active workspace is "created from
 * `fixtures/seed/workspaces.json` on first login". That fixture is WP-15's and does not exist, so
 * `GET /workspace` creates {@link DEFAULT_WORKSPACE_LAYOUT} instead — one panel, single-pane mode,
 * every other field the wire schema's own default. It is parsed by `WorkspaceLayout` at module
 * load, so it cannot drift from the schema without failing at startup.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import {
  ChartAnnotationInput,
  CreateWorkspaceRequest,
  PutWorkspaceRequest,
  UpdateWorkspaceRequest,
  WorkspaceLayout,
  type ChartAnnotation,
  type Workspace,
  type WorkspaceSummary,
} from '@terminal/sdk/wire/rest/workspaces';

import { withTx, type RequestCtx, type Tx } from '../../db/client.js';
import { requireSession, type Principal } from '../auth/session.js';
import { ForbiddenError } from '../errors.js';
import { rateLimit, REST_LIMIT } from '../rateLimit.js';
import { AuthRequiredError, ConflictError, NotFoundError, ValidationFailedError } from '../errors.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `to_char` mask rendering a timestamptz as the `z.iso.datetime()` the wire expects. */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * The layout a desk gets on first login until WP-15 ships `fixtures/seed/workspaces.json`.
 * Parsed by the wire schema here, at module load: a field the schema gains and this object lacks
 * is a startup failure, not a 500 on somebody's first morning.
 */
export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = WorkspaceLayout.parse({
  schema: 1,
  mode: '1',
  panels: [{ id: 'p1', frameStack: [], index: 0, history: [] }],
  focus: 'p1',
});

/** The name of the workspace `GET /workspace` creates when a user has none. */
const DEFAULT_WORKSPACE_NAME = 'default';

function principalOf(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (principal === undefined) throw new AuthRequiredError();
  return principal;
}

function ctxOf(principal: Principal): RequestCtx {
  return {
    userId: principal.userId,
    firmId: principal.firmId,
    role: principal.role,
    sessionId: principal.sessionId,
  };
}

/** Parse with a normative wire schema; a failure is the documented `400 VALIDATION_FAILED`. */
function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  location: 'body' | 'query' | 'params',
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationFailedError(location, result.error.issues);
  return result.data;
}

/** A path or query id, as a positive integer, or the documented 400. */
function idParam(raw: unknown, key: string, location: 'params' | 'query'): number {
  const source = (raw ?? {}) as Record<string, unknown>;
  const value = source[key];
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationFailedError(location, [
      { code: 'invalid_type', path: [key], message: `${key} must be a positive integer` },
    ]);
  }
  return n;
}

/**
 * Postgres' unique-violation SQLSTATE — `workspaces (user_id, name)`. drizzle wraps a driver error
 * in its own, so the chain of `cause`s is walked rather than only the outermost object.
 */
function isUniqueViolation(err: unknown): boolean {
  for (let cursor: unknown = err, depth = 0; cursor !== undefined && depth < 5; depth += 1) {
    if (typeof cursor !== 'object' || cursor === null) return false;
    if ((cursor as { code?: unknown }).code === '23505') return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/** The owner predicate every workspace statement carries, beside the RLS policy that says it too. */
function ownedBy(principal: Principal): SQL {
  return sql`user_id = ${String(principal.userId)}::bigint`;
}

/** `annotations_scope` (migration 0015), restated in SQL: own, firm-shared, or shared with me. */
function visibleAnnotation(principal: Principal): SQL {
  const userId = sql`${String(principal.userId)}::bigint`;
  return sql`(owner_user_id = ${userId}
              OR (firm_id = ${String(principal.firmId)}::bigint
                  AND (shared_scope = 'firm'
                       OR (shared_scope = 'users' AND ${userId} = ANY (shared_user_ids)))))`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────────────────────

const WORKSPACE_COLUMNS: SQL = sql`
  workspace_id::text AS workspace_id, name, is_active, version, layout,
  to_char(updated_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS updated_at`;

interface WorkspaceSqlRow {
  workspace_id: string;
  name: string;
  is_active: boolean;
  version: number;
  layout: unknown;
  updated_at: string;
}

function toWorkspace(row: WorkspaceSqlRow): Workspace {
  return {
    workspaceId: Number(row.workspace_id),
    name: row.name,
    isActive: row.is_active,
    version: Number(row.version),
    // Stored as written; the client migrates older layout schemas on load (API.md L601).
    layout: row.layout as WorkspaceLayout,
    updatedAt: row.updated_at,
  };
}

function toSummary(row: WorkspaceSqlRow): WorkspaceSummary {
  const { layout: _layout, ...rest } = toWorkspace(row);
  return rest;
}

const ANNOTATION_COLUMNS: SQL = sql`
  annotation_id::text AS annotation_id, instrument_id::text AS instrument_id,
  owner_user_id::text AS owner_user_id, kind, anchors, style, label,
  shared_scope, shared_user_ids,
  to_char(updated_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS updated_at`;

interface AnnotationSqlRow {
  annotation_id: string;
  instrument_id: string;
  owner_user_id: string;
  kind: ChartAnnotation['kind'];
  anchors: unknown;
  style: unknown;
  label: string | null;
  shared_scope: ChartAnnotation['sharedScope'];
  /** `bigint[]` — node-postgres hands back the elements as strings. */
  shared_user_ids: readonly (string | number)[] | null;
  updated_at: string;
}

function toAnnotation(row: AnnotationSqlRow): ChartAnnotation {
  return {
    annotationId: Number(row.annotation_id),
    instrumentId: Number(row.instrument_id),
    ownerUserId: Number(row.owner_user_id),
    kind: row.kind,
    anchors: (Array.isArray(row.anchors) ? row.anchors : []) as ChartAnnotation['anchors'],
    style: (row.style ?? {}) as ChartAnnotation['style'],
    label: row.label,
    sharedScope: row.shared_scope,
    sharedUserIds: (row.shared_user_ids ?? []).map(Number),
    updatedAt: row.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function selectOne(tx: Tx, where: SQL): Promise<WorkspaceSqlRow | undefined> {
  const result = await tx.execute(sql`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE ${where}`);
  return (result.rows as unknown as WorkspaceSqlRow[])[0];
}

/** The caller's active workspace, created from the built-in default when they have none. */
async function activeWorkspace(tx: Tx, principal: Principal): Promise<WorkspaceSqlRow> {
  const existing = await selectOne(tx, sql`is_active AND ${ownedBy(principal)}`);
  if (existing !== undefined) return existing;

  const created = await tx.execute(sql`
    INSERT INTO workspaces (user_id, firm_id, name, is_active, layout, version)
    VALUES (${String(principal.userId)}::bigint, ${String(principal.firmId)}::bigint,
            ${DEFAULT_WORKSPACE_NAME}, true, ${JSON.stringify(DEFAULT_WORKSPACE_LAYOUT)}::jsonb, 1)
    RETURNING ${WORKSPACE_COLUMNS}`);
  const row = (created.rows as unknown as WorkspaceSqlRow[])[0];
  if (row === undefined) {
    // RLS refused the insert: the only way here is a context that is not this user's.
    throw new NotFoundError('No workspace.');
  }
  return row;
}

/**
 * Apply `set` to one workspace under optimistic concurrency, or say precisely why not.
 *
 * @throws NotFoundError when the row is not the caller's (or does not exist).
 * @throws ConflictError `WORKSPACE_VERSION_CONFLICT` with the server's copy in `details.current`.
 */
async function updateVersioned(
  tx: Tx,
  where: SQL,
  version: number,
  set: SQL,
): Promise<WorkspaceSqlRow> {
  const updated = await tx.execute(sql`
    UPDATE workspaces
       SET ${set}, version = version + 1
     WHERE ${where} AND version = ${version}
    RETURNING ${WORKSPACE_COLUMNS}`);
  const row = (updated.rows as unknown as WorkspaceSqlRow[])[0];
  if (row !== undefined) return row;

  const current = await selectOne(tx, where);
  if (current === undefined) throw new NotFoundError('No such workspace.');
  throw new ConflictError(
    'WORKSPACE_VERSION_CONFLICT',
    `Workspace is at version ${String(current.version)}; the update carried ${String(version)}.`,
    { current: toWorkspace(current) },
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Refuse a mutation from a programmatic session (`clientKind: 'api'`).
 *
 * `403 FORBIDDEN` with `details.requiredScope`, which is the shape API.md §2 gives a scope
 * refusal, and names a scope that deliberately does not exist: there is no key scope that grants
 * write access to a person's terminal layout, so the honest answer is that this session can never
 * do it rather than that it is missing a grant somebody could add.
 */
function refuseProgrammatic(request: FastifyRequest): Promise<void> {
  if (request.principal?.clientKind === 'api') {
    throw new ForbiddenError(
      'A programmatic session may read a workspace but may not change one.',
      { requiredScope: 'workspace:write' },
    );
  }
  return Promise.resolve();
}

export const workspacesRoutes: FastifyPluginAsync = async (app) => {
  // API.md §8's REST bucket on every route, and one more rule on the mutating ones.
  //
  // **A bearer session may read a workspace and may not move it.** An API key is minted with
  // `data:read`, `fn:run` and `ws:subscribe` (WP-07) — there is no scope that means "rearrange a
  // human's panels", and a workspace, its annotations and its monitor specs are the terminal's
  // own state, not data. A key holder who could `PUT /workspace` could silently rewrite what the
  // person in front of the screen sees next time they log in, which is not something any
  // documented scope grants. Reads stay open: the SDK legitimately wants the watchlists and
  // monitors a workspace names.
  const read = { preHandler: [requireSession(), rateLimit(REST_LIMIT)] };
  const write = { preHandler: [requireSession(), rateLimit(REST_LIMIT), refuseProgrammatic] };

  // ── The active workspace (TERM-05) ─────────────────────────────────────────────────────────

  app.get('/workspace', read, async (request): Promise<Workspace> => {
    const principal = principalOf(request);
    return withTx(ctxOf(principal), async (tx) => toWorkspace(await activeWorkspace(tx, principal)));
  });

  app.put('/workspace', write, async (request) => {
    const principal = principalOf(request);
    const body = parse(PutWorkspaceRequest, request.body, 'body');

    return withTx(ctxOf(principal), async (tx) => {
      const row = await updateVersioned(
        tx,
        sql`is_active AND ${ownedBy(principal)}`,
        body.version,
        sql`layout = ${JSON.stringify(body.layout)}::jsonb`,
      );
      return { version: Number(row.version), updatedAt: row.updated_at };
    });
  });

  // ── Named workspaces ───────────────────────────────────────────────────────────────────────

  app.get('/workspaces', read, async (request) => {
    const principal = principalOf(request);
    return withTx(ctxOf(principal), async (tx) => {
      const result = await tx.execute(sql`
        SELECT ${WORKSPACE_COLUMNS} FROM workspaces
         WHERE ${ownedBy(principal)}
         ORDER BY is_active DESC, name`);
      return { items: (result.rows as unknown as WorkspaceSqlRow[]).map(toSummary) };
    });
  });

  app.post('/workspaces', write, async (request, reply) => {
    const principal = principalOf(request);
    const body = parse(CreateWorkspaceRequest, request.body, 'body');

    const created = await withTx(ctxOf(principal), async (tx) => {
      try {
        const result = await tx.execute(sql`
          INSERT INTO workspaces (user_id, firm_id, name, is_active, layout, version)
          VALUES (${String(principal.userId)}::bigint, ${String(principal.firmId)}::bigint,
                  ${body.name}, false, ${JSON.stringify(body.layout)}::jsonb, 1)
          RETURNING ${WORKSPACE_COLUMNS}`);
        return (result.rows as unknown as WorkspaceSqlRow[])[0];
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError('DUPLICATE_NAME', `A workspace named "${body.name}" exists.`);
        }
        throw err;
      }
    });
    if (created === undefined) throw new NotFoundError('No workspace.');

    void reply.status(201);
    return toWorkspace(created);
  });

  app.get('/workspaces/:workspaceId', read, async (request) => {
    const principal = principalOf(request);
    const workspaceId = idParam(request.params, 'workspaceId', 'params');
    return withTx(ctxOf(principal), async (tx) => {
      const row = await selectOne(
        tx,
        sql`workspace_id = ${String(workspaceId)}::bigint AND ${ownedBy(principal)}`,
      );
      if (row === undefined) throw new NotFoundError('No such workspace.');
      return toWorkspace(row);
    });
  });

  app.put('/workspaces/:workspaceId', write, async (request) => {
    const principal = principalOf(request);
    const workspaceId = idParam(request.params, 'workspaceId', 'params');
    const body = parse(UpdateWorkspaceRequest, request.body, 'body');

    const assignments: SQL[] = [];
    if (body.name !== undefined) assignments.push(sql`name = ${body.name}`);
    if (body.layout !== undefined) {
      assignments.push(sql`layout = ${JSON.stringify(body.layout)}::jsonb`);
    }
    // A PUT that changes nothing still takes the version: it is how a client proves it is current.
    if (assignments.length === 0) assignments.push(sql`name = name`);

    return withTx(ctxOf(principal), async (tx) => {
      try {
        const row = await updateVersioned(
          tx,
          sql`workspace_id = ${String(workspaceId)}::bigint AND ${ownedBy(principal)}`,
          body.version,
          sql.join(assignments, sql`, `),
        );
        return toWorkspace(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError('DUPLICATE_NAME', 'A workspace of that name exists.');
        }
        throw err;
      }
    });
  });

  app.delete(
    '/workspaces/:workspaceId',
    write,
    async (request, reply: FastifyReply) => {
      const principal = principalOf(request);
      const workspaceId = idParam(request.params, 'workspaceId', 'params');

      await withTx(ctxOf(principal), async (tx) => {
        const result = await tx.execute(sql`
          DELETE FROM workspaces
           WHERE workspace_id = ${String(workspaceId)}::bigint AND ${ownedBy(principal)}
          RETURNING workspace_id::text AS workspace_id`);
        if ((result.rows as unknown as { workspace_id: string }[]).length === 0) {
          throw new NotFoundError('No such workspace.');
        }
      });

      void reply.status(204);
      return null;
    },
  );

  app.post(
    '/workspaces/:workspaceId/activate',
    write,
    async (request) => {
      const principal = principalOf(request);
      const workspaceId = idParam(request.params, 'workspaceId', 'params');

      return withTx(ctxOf(principal), async (tx) => {
        // `workspaces_active_uniq` is a partial unique index on (user_id) WHERE is_active, so the
        // old active row must be cleared before the new one is set, in this one transaction.
        const target = await selectOne(
          tx,
          sql`workspace_id = ${String(workspaceId)}::bigint AND ${ownedBy(principal)}`,
        );
        if (target === undefined) throw new NotFoundError('No such workspace.');

        await tx.execute(sql`
          UPDATE workspaces SET is_active = false
           WHERE is_active AND ${ownedBy(principal)}
             AND workspace_id <> ${String(workspaceId)}::bigint`);
        const result = await tx.execute(sql`
          UPDATE workspaces SET is_active = true, version = version + 1
           WHERE workspace_id = ${String(workspaceId)}::bigint AND ${ownedBy(principal)}
          RETURNING ${WORKSPACE_COLUMNS}`);
        const row = (result.rows as unknown as WorkspaceSqlRow[])[0];
        if (row === undefined) throw new NotFoundError('No such workspace.');
        return toWorkspace(row);
      });
    },
  );

  // ── Chart annotations (CHRT-05) ────────────────────────────────────────────────────────────

  app.get('/annotations', read, async (request) => {
    const principal = principalOf(request);
    const instrumentId = idParam(request.query, 'instrumentId', 'query');

    return withTx(ctxOf(principal), async (tx) => {
      // `annotations_scope` decides what is visible: own, firm-shared, or shared with this user.
      const result = await tx.execute(sql`
        SELECT ${ANNOTATION_COLUMNS} FROM chart_annotations
         WHERE instrument_id = ${String(instrumentId)}::bigint
           AND ${visibleAnnotation(principal)}
         ORDER BY annotation_id`);
      return { items: (result.rows as unknown as AnnotationSqlRow[]).map(toAnnotation) };
    });
  });

  app.post('/annotations', write, async (request, reply) => {
    const principal = principalOf(request);
    const body = parse(ChartAnnotationInput, request.body, 'body');

    const created = await withTx(ctxOf(principal), async (tx) => {
      const result = await tx.execute(sql`
        INSERT INTO chart_annotations
               (owner_user_id, firm_id, instrument_id, kind, anchors, style, label,
                shared_scope, shared_user_ids)
        VALUES (${String(principal.userId)}::bigint, ${String(principal.firmId)}::bigint,
                ${String(body.instrumentId)}::bigint, ${body.kind},
                ${JSON.stringify(body.anchors)}::jsonb, ${JSON.stringify(body.style)}::jsonb,
                ${body.label}, ${body.sharedScope},
                ${sql`ARRAY[${sql.join(
                  body.sharedUserIds.map((id) => sql`${String(id)}::bigint`),
                  sql`, `,
                )}]::bigint[]`})
        RETURNING ${ANNOTATION_COLUMNS}`);
      return (result.rows as unknown as AnnotationSqlRow[])[0];
    });
    if (created === undefined) throw new NotFoundError('Annotation was not written.');

    void reply.status(201);
    return toAnnotation(created);
  });

  app.put('/annotations/:annotationId', write, async (request) => {
    const principal = principalOf(request);
    const annotationId = idParam(request.params, 'annotationId', 'params');
    const body = parse(ChartAnnotationInput, request.body, 'body');

    return withTx(ctxOf(principal), async (tx) => {
      // The owner predicate is explicit: `annotations_scope` lets a firm-shared annotation be
      // *read* by a colleague, and without this an UPDATE from them would trip the policy's
      // WITH CHECK and surface as a 500 instead of the 404 a non-owner should see.
      const result = await tx.execute(sql`
        UPDATE chart_annotations
           SET instrument_id = ${String(body.instrumentId)}::bigint,
               kind = ${body.kind},
               anchors = ${JSON.stringify(body.anchors)}::jsonb,
               style = ${JSON.stringify(body.style)}::jsonb,
               label = ${body.label},
               shared_scope = ${body.sharedScope},
               shared_user_ids = ${sql`ARRAY[${sql.join(
                 body.sharedUserIds.map((id) => sql`${String(id)}::bigint`),
                 sql`, `,
               )}]::bigint[]`}
         WHERE annotation_id = ${String(annotationId)}::bigint
           AND owner_user_id = ${String(principal.userId)}::bigint
        RETURNING ${ANNOTATION_COLUMNS}`);
      const row = (result.rows as unknown as AnnotationSqlRow[])[0];
      if (row === undefined) throw new NotFoundError('No such annotation.');
      return toAnnotation(row);
    });
  });

  app.delete(
    '/annotations/:annotationId',
    write,
    async (request, reply: FastifyReply) => {
      const principal = principalOf(request);
      const annotationId = idParam(request.params, 'annotationId', 'params');

      await withTx(ctxOf(principal), async (tx) => {
        const result = await tx.execute(sql`
          DELETE FROM chart_annotations
           WHERE annotation_id = ${String(annotationId)}::bigint
             AND owner_user_id = ${String(principal.userId)}::bigint
          RETURNING annotation_id::text AS annotation_id`);
        if ((result.rows as unknown as { annotation_id: string }[]).length === 0) {
          throw new NotFoundError('No such annotation.');
        }
      });

      void reply.status(204);
      return null;
    },
  );

  await Promise.resolve();
};

export default workspacesRoutes;
