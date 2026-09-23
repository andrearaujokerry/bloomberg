/**
 * `http/routes/messages.ts` — API.md §5.10 L697-730 (MSG-01, MSG-02, MSG-03, MSG-04, MSG-06),
 * WP-09.
 *
 *   GET  /rooms                          rooms the caller is a member of
 *   POST /rooms                          dm / group, subject to MSG-03 policy
 *   GET  /rooms/:roomId                  one room and its membership
 *   POST / DELETE /rooms/:roomId/members owner or supervisor
 *   GET  /rooms/:roomId/messages         `seq`-ordered history
 *   POST /rooms/:roomId/messages         append-only send, idempotent on `clientMsgId`
 *   POST /rooms/:roomId/read             the read cursor
 *   GET  /directory                      MSG-01 counterparty directory
 *   GET  /rooms/:roomId/messages/:seq/attachments/:index   MSG-04 (see below)
 *
 * **All of the policy and all of the chain live in `messaging/service.ts`.** This file opens the
 * caller's transaction, parses with the wire schemas, decides membership, and maps the service's
 * refusals onto HTTP. Nothing here computes a hash, assigns a `seq`, or re-implements an ethical
 * wall — there is exactly one place those are decided, and it is not the HTTP layer.
 *
 * **Messages are immutable.** There is no PUT and no DELETE on a message, because `messages` is
 * WORM (migration 0015 grants `terminal_app` no `UPDATE`/`DELETE` and installs `messages_worm`).
 * A correction is a new message, which is also what a regulator reading the archive needs to see.
 *
 * **Not a member is a 404, not a 403.** `rooms_member` (RLS) hides a room the caller has no seat
 * in; the routes restate that check themselves, because RLS does not apply to the role that owns
 * the tables and a 403 would confirm that the room id exists (API.md L186). A *policy* refusal is
 * different and is a 403 `MESSAGE_POLICY_BLOCKED` with `details.rule`: the caller knows the
 * counterparty exists — they typed their name — and the honest answer is that the firm's policy
 * forbids the conversation.
 *
 * **MSG-04, and why there is a tenth route.** An attachment is stored as a *reference*
 * (`{kind, ids, params}`) and never as a snapshot of the sender's numbers, so that it renders
 * "live in the recipient's client within THEIR entitlements" (API.md L700). Rendering it needs a
 * read that runs as the *reader*, which is what `GET …/attachments/:index` is: the same
 * dispatcher, the same evaluator and the same `usage:'display'` any other screen read uses, run
 * for whoever asked. Two people in one room therefore see two different answers for the same
 * attachment — a delayed desk sees a delayed price, a desk with no grant for the field sees a
 * blank cell with its reason — and that is the correct behaviour, not a bug to be reconciled.
 * API.md §5.10 does not name this route; it names the rule, and a rule that no endpoint
 * implements is a rule the client would have to break by embedding the sender's numbers.
 */

import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import type { FieldId } from '@terminal/core';
import type { DataRequestInput, DataResponse } from '@terminal/sdk/wire/dataRequest';
import {
  CreateRoomRequest,
  DirectoryQuery,
  MessageListQuery,
  RoomMembersRequest,
  MarkReadRequest,
  SendMessageRequest,
  type Attachment,
  type DirectoryEntry,
  type DirectoryResponse,
  type Message,
  type MessageListResponse,
  type Room,
  type RoomListResponse,
} from '@terminal/sdk/wire/rest/messages';

import { withTx, type Tx } from '../../db/client.js';
import {
  MessagePolicyError,
  messagingService,
  type MessagingService,
  type PartyView,
} from '../../messaging/service.js';
import { surveillanceScanner } from '../../messaging/surveillance.js';
import { requireSession, type Principal } from '../auth/session.js';
import { AppError, ForbiddenError, NotFoundError, ValidationFailedError } from '../errors.js';
import { rateLimit, REST_LIMIT } from '../rateLimit.js';
import { asOfOfRequest, dispatcherFor, quotasOf, usageFor } from './data.js';
import { ctxOf, hostDepsOf, parse, principalOf } from './functions.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The header fields a shared security or chart renders with (FUNCTIONS_TIER1 §0.1 `quoteHeader`). */
const ATTACHMENT_FIELDS: readonly FieldId[] = [
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'PX_BID',
  'PX_ASK',
] as FieldId[];

function idParam(raw: unknown, key: string): number {
  const source = (raw ?? {}) as Record<string, unknown>;
  const value = source[key];
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationFailedError('params', [
      { code: 'invalid_type', path: [key], message: `${key} must be a positive integer` },
    ]);
  }
  return n;
}

function intParam(raw: unknown, key: string, min: number): number {
  const source = (raw ?? {}) as Record<string, unknown>;
  const value = source[key];
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < min) {
    throw new ValidationFailedError('params', [
      { code: 'invalid_type', path: [key], message: `${key} must be an integer ≥ ${String(min)}` },
    ]);
  }
  return n;
}

function coerceNumbers(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...((raw ?? {}) as Record<string, unknown>) };
  for (const key of keys) {
    const value = out[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Membership
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The caller's seat in a room, or the documented 404.
 *
 * Checked here rather than left to `rooms_member`: RLS is not applied to the role that owns the
 * tables, and "the policy will catch it" is how a route ends up serving every desk's messages
 * against a superuser `DATABASE_URL`.
 */
async function seatOf(
  service: MessagingService,
  roomId: number,
  userId: number,
): Promise<PartyView> {
  const room = await service.context(roomId);
  if (room === null) throw new NotFoundError('No such room.');
  const seat = room.members.find((member) => member.userId === userId);
  if (seat === undefined) throw new NotFoundError('No such room.');
  return seat;
}

/** Adding or removing members is the owner's or a supervisor's (API.md L713). */
function requireSteward(seat: PartyView): void {
  if (seat.memberRole !== 'owner' && seat.memberRole !== 'supervisor') {
    throw new ForbiddenError('Only a room owner or supervisor may change its membership.', {
      requiredRole: ['owner', 'supervisor'],
    });
  }
}

/** The room as the caller sees it, after a mutation. */
async function roomOr404(
  service: MessagingService,
  roomId: number,
  userId: number,
): Promise<Room> {
  const room = await service.room(roomId, userId);
  if (room === null) throw new NotFoundError('No such room.');
  return room;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// MSG-04 attachment rendering
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What `GET …/attachments/:index` answers. One arm per `Attachment.kind`. */
export interface RenderedAttachment {
  kind: Attachment['kind'];
  /** `kind:'security' | 'chart'` — the reader's own entitlement-filtered view. */
  data?: DataResponse;
  /** `kind:'function'` — the reader runs it themselves; these are the arguments. */
  run?: { code: string; instrumentId: number | null; params: Record<string, unknown> };
  /** `kind:'watchlist' | 'portfolio'` — the referenced object, when the reader may see it. */
  ref?: { id: number; name: string };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const messagesRoutes: FastifyPluginAsync = async (app) => {
  // API.md §5.10's Role column is "any" or "member" on every row: membership, not role, decides.
  const guard = { preHandler: [requireSession(), rateLimit(REST_LIMIT)] };

  /**
   * The service over the caller's transaction, with live delivery and surveillance attached.
   *
   * `deliver` is the WS `room:<roomId>` fan-out of API.md §6.9; `surveillance` is MSG-02's
   * lexicon scan, which the service runs after the row is durable and never lets fail a send.
   */
  const serviceFor = (tx: Tx): MessagingService =>
    messagingService({
      db: tx,
      clock: app.deps.clock,
      deliver: (roomId, message) => {
        app.wsGateway.sendToRoom(String(roomId), {
          t: 'msg',
          room: String(roomId),
          message,
        });
      },
      surveillance: surveillanceScanner({ db: tx, clock: app.deps.clock }),
    });

  const inRoom = async <T>(
    request: FastifyRequest,
    fn: (ctx: {
      tx: Tx;
      service: MessagingService;
      principal: Principal;
      roomId: number;
      seat: PartyView;
    }) => Promise<T>,
  ): Promise<T> => {
    const principal = principalOf(request);
    const roomId = idParam(request.params, 'roomId');
    return withTx(ctxOf(principal), async (tx) => {
      const service = serviceFor(tx);
      const seat = await seatOf(service, roomId, principal.userId);
      return fn({ tx, service, principal, roomId, seat });
    });
  };

  // ── GET /rooms ─────────────────────────────────────────────────────────────────────────────
  app.get('/rooms', guard, async (request): Promise<RoomListResponse> => {
    const principal = principalOf(request);
    return withTx(ctxOf(principal), async (tx) => ({
      items: await serviceFor(tx).rooms(principal.userId),
    }));
  });

  // ── POST /rooms ────────────────────────────────────────────────────────────────────────────
  app.post('/rooms', guard, async (request, reply): Promise<Room> => {
    const principal = principalOf(request);
    const body = parse(CreateRoomRequest, request.body, 'body');

    const created = await withTx(ctxOf(principal), async (tx) =>
      serviceFor(tx).createRoom({
        kind: body.kind,
        ...(body.name === undefined ? {} : { name: body.name }),
        createdBy: principal.userId,
        memberUserIds: body.memberUserIds,
      }),
    );

    void reply.status(201);
    return created;
  });

  // ── GET /rooms/:roomId ─────────────────────────────────────────────────────────────────────
  app.get('/rooms/:roomId', guard, async (request): Promise<Room> =>
    inRoom(request, async (ctx) => roomOr404(ctx.service, ctx.roomId, ctx.principal.userId)),
  );

  // ── POST /rooms/:roomId/members ────────────────────────────────────────────────────────────
  app.post('/rooms/:roomId/members', guard, async (request): Promise<Room> => {
    const body = parse(RoomMembersRequest, request.body, 'body');
    return inRoom(request, async (ctx) => {
      requireSteward(ctx.seat);
      // `join` is the same gate a self-join goes through: the ethical wall, the counterparty
      // list and the external rule are evaluated against the membership *before* the row is
      // written, for each person added.
      for (const userId of body.userIds) await ctx.service.join(ctx.roomId, userId);
      return roomOr404(ctx.service, ctx.roomId, ctx.principal.userId);
    });
  });

  // ── DELETE /rooms/:roomId/members ──────────────────────────────────────────────────────────
  app.delete('/rooms/:roomId/members', guard, async (request): Promise<Room> => {
    const body = parse(RoomMembersRequest, request.body, 'body');
    return inRoom(request, async (ctx) => {
      requireSteward(ctx.seat);
      // A seat is closed, never deleted: `room_members.left_at` is what tells a supervisor who
      // could read the room while a conversation was happening (MSG-02), and a removed row would
      // erase that. The messages the person already received are not recalled — they cannot be.
      const ids = [...new Set(body.userIds)];
      await ctx.tx.execute(sql`
        UPDATE room_members
           SET left_at = ${new Date(app.deps.clock.now()).toISOString()}::timestamptz
         WHERE room_id = ${ctx.roomId}
           AND left_at IS NULL
           AND user_id = ANY (ARRAY[${sql.join(
             ids.map((id) => sql`${String(id)}::bigint`),
             sql`, `,
           )}]::bigint[])`);
      return roomOr404(ctx.service, ctx.roomId, ctx.principal.userId);
    });
  });

  // ── GET /rooms/:roomId/messages ────────────────────────────────────────────────────────────
  app.get('/rooms/:roomId/messages', guard, async (request): Promise<MessageListResponse> => {
    const query = parse(
      MessageListQuery,
      coerceNumbers(request.query, ['before', 'after', 'limit']),
      'query',
    );
    return inRoom(request, async (ctx) => {
      const page = await ctx.service.history(ctx.roomId, {
        ...(query.before === undefined ? {} : { before: query.before }),
        ...(query.after === undefined ? {} : { after: query.after }),
        limit: query.limit,
      });
      return { items: page.items, nextCursor: page.nextCursor };
    });
  });

  // ── POST /rooms/:roomId/messages ───────────────────────────────────────────────────────────
  app.post('/rooms/:roomId/messages', guard, async (request, reply): Promise<Message> => {
    const body = parse(SendMessageRequest, request.body, 'body');
    return inRoom(request, async (ctx) => {
      // Idempotency is the service's (unique `(room_id, client_msg_id)`), but the *status code*
      // is this route's: API.md L722 says a repeat returns the stored row with `200`, and only a
      // caller who asks before sending can tell the two apart.
      const existing = await ctx.tx.execute<{ present: number }>(sql`
        SELECT 1 AS present FROM messages
         WHERE room_id = ${ctx.roomId} AND client_msg_id = ${body.clientMsgId}::uuid`);
      const repeat = existing.rows.length > 0;

      const message = await ctx.service.send({
        roomId: ctx.roomId,
        senderUserId: ctx.principal.userId,
        body: body.body,
        ...(body.attachments === undefined ? {} : { attachments: body.attachments }),
        ...(body.structured === undefined ? {} : { structured: body.structured }),
        clientMsgId: body.clientMsgId,
        traceId: request.traceId,
      });

      void reply.status(repeat ? 200 : 201);
      return message;
    });
  });

  // ── POST /rooms/:roomId/read ───────────────────────────────────────────────────────────────
  app.post('/rooms/:roomId/read', guard, async (request, reply: FastifyReply) => {
    const body = parse(MarkReadRequest, request.body, 'body');
    await inRoom(request, async (ctx) => {
      await ctx.service.markRead(ctx.roomId, ctx.principal.userId, body.lastReadSeq);
    });
    void reply.status(204);
    return null;
  });

  // ── GET /rooms/:roomId/messages/:seq/attachments/:index (MSG-04) ───────────────────────────
  app.get(
    '/rooms/:roomId/messages/:seq/attachments/:index',
    guard,
    async (request): Promise<RenderedAttachment> => {
      const seq = intParam(request.params, 'seq', 1);
      const index = intParam(request.params, 'index', 0);
      const deps = hostDepsOf(request);

      return inRoom(request, async (ctx) => {
        const found = await ctx.tx.execute<{ attachments: unknown }>(sql`
          SELECT attachments FROM messages
           WHERE room_id = ${ctx.roomId} AND seq = ${seq}`);
        const row = found.rows[0];
        if (row === undefined) throw new NotFoundError('No such message.');
        const attachments = (Array.isArray(row.attachments) ? row.attachments : []) as Attachment[];
        const attachment = attachments[index];
        if (attachment === undefined) throw new NotFoundError('No such attachment.');

        switch (attachment.kind) {
          case 'function':
            return {
              kind: attachment.kind,
              run: {
                code: attachment.code,
                instrumentId: attachment.instrumentId,
                params: attachment.params,
              },
            };
          case 'watchlist': {
            // The reader's own visibility decides: `watchlists_scope` is own + firm-shared +
            // shared-with-me, restated here for the same reason as everywhere else. A list the
            // reader may not see is a 404 — the attachment stays in the transcript, the numbers
            // do not travel with it.
            const res = await ctx.tx.execute<{ watchlist_id: string; name: string }>(sql`
              SELECT watchlist_id::text AS watchlist_id, name FROM watchlists
               WHERE watchlist_id = ${String(attachment.watchlistId)}::bigint
                 AND (owner_user_id = ${String(ctx.principal.userId)}::bigint
                      OR (firm_id = ${String(ctx.principal.firmId)}::bigint
                          AND (shared_scope = 'firm'
                               OR (shared_scope = 'users'
                                   AND ${String(ctx.principal.userId)}::bigint
                                       = ANY (shared_user_ids)))))`);
            const hit = res.rows[0];
            if (hit === undefined) throw new NotFoundError('No such watchlist.');
            return { kind: attachment.kind, ref: { id: Number(hit.watchlist_id), name: hit.name } };
          }
          case 'portfolio': {
            // `portfolios_tenant` is firm equality and nothing else (PORT-07). A portfolio shared
            // into a cross-firm room is a 404 for the counterparty, by design.
            const res = await ctx.tx.execute<{ portfolio_id: string; name: string }>(sql`
              SELECT portfolio_id::text AS portfolio_id, name FROM portfolios
               WHERE portfolio_id = ${String(attachment.portfolioId)}::bigint
                 AND firm_id = ${String(ctx.principal.firmId)}::bigint`);
            const hit = res.rows[0];
            if (hit === undefined) throw new NotFoundError('No such portfolio.');
            return { kind: attachment.kind, ref: { id: Number(hit.portfolio_id), name: hit.name } };
          }
          case 'security':
          case 'chart': {
            const entitlements = deps.entitlements;
            if (entitlements === undefined) {
              throw new AppError('ENTITLEMENT_DENIED', 'No entitlement evaluator is wired.', {
                details: { reasons: [] },
              });
            }
            const at = asOfOfRequest(
              request.query ?? {},
              deps.clock,
            );
            const dispatcher = dispatcherFor({
              tx: ctx.tx,
              clock: deps.clock,
              traceId: request.traceId,
              principal: ctx.principal,
              entitlements,
              quotas: quotasOf(deps),
              usage: usageFor(ctx.principal),
              at,
            });
            const dataRequest: DataRequestInput = {
              kind: 'realtime',
              securities: [{ id: attachment.instrumentId }],
              fields: [...ATTACHMENT_FIELDS],
              asOf: { validAt: at.validAt.toISOString(), knownAt: at.knownAt.toISOString() },
              usage: usageFor(ctx.principal),
            };
            // What a reader may see of an attachment is decided by the dispatcher, exactly as it
            // is for `POST /data`, and the two answers differ:
            //
            //  - **Some fields denied → `200`** with the value `null` and `r[field]` carrying the
            //    reason (API.md §2 L196). This is the read that is *supposed* to differ between
            //    two readers of the same message, so it is never an error: the attachment renders
            //    with the cells this reader is entitled to and blanks the rest, with a reason to
            //    hover over.
            //  - **Every field denied → `403 ENTITLEMENT_DENIED`**, raised by the dispatcher with
            //    `details.reasons` naming each field. The envelope is not re-dressed as a 200 of
            //    all-blank cells here, and deliberately so: a `DataResponse` carries `meta` —
            //    staleness, tier, provenance, the entitlement decisions — and this route has no
            //    honest values for any of it when nothing was fetched. Inventing a meta block to
            //    make the shape uniform would put a fabricated audit trail on a read that never
            //    happened, which is the one thing DATA-10 does not allow. The 403 already carries
            //    the same per-field reasons a blanked row would have shown.
            //
            // `routes.test.ts` asserts both shapes.
            return { kind: attachment.kind, data: await dispatcher.dispatch(dataRequest) };
          }
        }
      });
    },
  );

  // ── GET /directory (MSG-01) ────────────────────────────────────────────────────────────────
  app.get('/directory', guard, async (request): Promise<DirectoryResponse> => {
    const principal = principalOf(request);
    const query = parse(DirectoryQuery, coerceNumbers(request.query, ['limit']), 'query');

    return withTx(ctxOf(principal), async (tx) => {
      // Cross-firm by design: MSG-01 is a *counterparty* directory, and a name that cannot be
      // found cannot be messaged. What the entry does not carry is anything about the person's
      // data, and `verified` (SEC-01's `person_verified_at`) is what says whether the firm
      // attested to them — a room with an unverified counterparty is still subject to MSG-03.
      const like = `%${query.q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
      const res = await tx.execute<{
        user_id: string;
        display_name: string;
        firm_id: string;
        firm_name: string;
        desk: string | null;
        role: DirectoryEntry['role'];
        verified: boolean;
      }>(sql`
        SELECT u.user_id::text AS user_id, u.display_name, u.firm_id::text AS firm_id,
               f.name AS firm_name, u.desk, u.role,
               (u.person_verified_at IS NOT NULL) AS verified
          FROM users u JOIN firms f ON f.firm_id = u.firm_id
         WHERE u.status = 'active'
           AND (u.display_name ILIKE ${like} ESCAPE '\\'
                OR f.name ILIKE ${like} ESCAPE '\\'
                OR u.desk ILIKE ${like} ESCAPE '\\')
         ORDER BY (u.firm_id = ${String(principal.firmId)}::bigint) DESC, u.display_name
         LIMIT ${query.limit}`);

      return {
        items: res.rows.map(
          (row): DirectoryEntry => ({
            userId: Number(row.user_id),
            displayName: row.display_name,
            firmId: Number(row.firm_id),
            firmName: row.firm_name,
            desk: row.desk,
            role: row.role,
            verified: row.verified,
          }),
        ),
      };
    });
  });

  await Promise.resolve();
};

/** Re-exported so a caller can narrow a refusal without importing the messaging module. */
export { MessagePolicyError };

export default messagesRoutes;
