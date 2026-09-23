/**
 * `http/routes/help.ts` — API.md §5.12 L758-764 (TERM-09), WP-09.
 *
 *   GET  /help/:code      HELP ×1 — the same body as `GET /functions/:code/help`
 *   POST /help/tickets    HELP ×2 — a `help_tickets` row, a `helpdesk` room, and a usage event
 *   GET  /help/tickets    own tickets; the `helpdesk` and `admin` roles see the firm's
 *
 * Three decisions:
 *
 *  1. **`GET /help/:code` is `functions.ts#helpFor`, not a second help document.** The panel's
 *     first HELP press and the SDK's `/functions/:code/help` must answer the same bytes for the
 *     same manifest, field dictionary and licence registry; two builders would drift on the first
 *     field whose attribution changed. This route exists because the terminal presses HELP
 *     without knowing which function is in the panel's frame stack — it is the same document at
 *     a shorter URL.
 *  2. **A ticket is one transaction: the row, the room and the event.** TERM-09's second press
 *     promises the user someone can answer; a ticket whose room failed to open is a question
 *     nobody will ever see. The room is created through `messaging/service.ts` — the same
 *     `createRoom` a person uses — so a helpdesk room is WORM, hash-chained and retained like
 *     every other conversation. The `usage_events kind='ticket.open'` row is written inline in
 *     the same transaction rather than through the buffered writer, because it is a rare,
 *     deliberate act whose value is being *there* next to the ticket, not being cheap.
 *  3. **Who staffs the room is `users.role`.** The `helpdesk` role of the opener's own firm is
 *     invited; API.md L763 says "a `helpdesk` room with the `helpdesk` role users". A firm with
 *     none gets a room containing only the opener — the ticket is still recorded and still
 *     visible to `GET /help/tickets` for an admin, which is better than refusing to accept the
 *     question.
 *
 * `screenState` is stored as sent: it is the visible fields and their provenance indexes, and its
 * whole purpose is to be the evidence of what the user was looking at when they asked.
 */

import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

import { registry as generatedRegistry, type AnyFunctionManifest } from '@terminal/core';
import type { HelpResponse } from '@terminal/sdk/wire/rest/functions';
import {
  HelpCodeParams,
  HelpQuery,
  TicketListQuery,
  TicketRequest,
  type Ticket,
  type TicketCreatedResponse,
  type TicketListResponse,
} from '@terminal/sdk/wire/rest/help';

import { withTx, type Tx } from '../../db/client.js';
import { messagingService } from '../../messaging/service.js';
import { SecurityResolver } from '../../refdata/resolve.js';
import { requireSession, type Principal } from '../auth/session.js';
import { AppError, NotFoundError } from '../errors.js';
import { rateLimit, REST_LIMIT } from '../rateLimit.js';
import { asOfOfRequest } from './data.js';
import { ctxOf, helpFor, hostDepsOf, licencesFor, parse, principalOf } from './functions.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** The roles that answer tickets, and therefore the roles that see a firm's whole queue. */
const DESK_ROLES: readonly string[] = ['helpdesk', 'admin'];

type TicketSqlRow = {
  ticket_id: string;
  opened_at: string;
  function_code: string | null;
  question: string;
  status: Ticket['status'];
  room_id: string | null;
  answer: string | null;
  answered_at: string | null;
};

const TICKET_COLUMNS = sql`
  ticket_id::text AS ticket_id,
  to_char(opened_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS opened_at,
  function_code, question, status, room_id::text AS room_id, answer,
  to_char(answered_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS answered_at`;

function toTicket(row: TicketSqlRow): Ticket {
  return {
    ticketId: Number(row.ticket_id),
    openedAt: row.opened_at,
    functionCode: row.function_code,
    question: row.question,
    status: row.status,
    roomId: row.room_id === null ? null : Number(row.room_id),
    answer: row.answer,
    answeredAt: row.answered_at,
  };
}

/** The manifest, or the documented `404 FUNCTION_NOT_FOUND`. */
function manifestOr404(code: string): AnyFunctionManifest {
  const manifest = generatedRegistry.get(code);
  if (manifest === undefined) {
    throw new AppError('FUNCTION_NOT_FOUND', `No function or alias '${code}'.`);
  }
  return manifest;
}

/** The `helpdesk`-role users of the opener's firm, excluding the opener. */
async function deskStaff(tx: Tx, principal: Principal): Promise<number[]> {
  const res = await tx.execute<{ user_id: string }>(sql`
    SELECT user_id::text AS user_id FROM users
     WHERE firm_id = ${String(principal.firmId)}::bigint
       AND role = 'helpdesk' AND status = 'active'
       AND user_id <> ${String(principal.userId)}::bigint
     ORDER BY user_id`);
  return res.rows.map((row) => Number(row.user_id));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const helpRoutes: FastifyPluginAsync = async (app) => {
  // API.md §5.12's Role column is "any" on all three rows. No scope either: help text is the
  // product's own documentation, not licensed data — and a key holder who may run a function
  // ought to be able to read what its parameters mean.
  const guard = { preHandler: [requireSession(), rateLimit(REST_LIMIT)] };

  // ── GET /help/tickets ──────────────────────────────────────────────────────────────────────
  //
  // Declared before `/help/:code` for readability; Fastify's radix router prefers the static
  // segment regardless, so `tickets` is never read as a function code.
  app.get('/help/tickets', guard, async (request): Promise<TicketListResponse> => {
    const principal = principalOf(request);
    const query = parse(TicketListQuery, request.query ?? {}, 'query');

    return withTx(ctxOf(principal), async (tx) => {
      // `help_tickets_scope` (migration 0015): own, or the firm's when the caller staffs the
      // desk. Restated here because RLS is not applied to the role that owns the tables.
      const scope = DESK_ROLES.includes(principal.role)
        ? sql`(user_id = ${String(principal.userId)}::bigint
               OR firm_id = ${String(principal.firmId)}::bigint)`
        : sql`user_id = ${String(principal.userId)}::bigint`;
      const status = query.status === undefined ? sql`` : sql` AND status = ${query.status}`;

      const res = await tx.execute<TicketSqlRow>(sql`
        SELECT ${TICKET_COLUMNS} FROM help_tickets
         WHERE ${scope}${status}
         ORDER BY opened_at DESC, ticket_id DESC`);
      return { items: res.rows.map(toTicket) };
    });
  });

  // ── POST /help/tickets (HELP ×2) ───────────────────────────────────────────────────────────
  app.post('/help/tickets', guard, async (request, reply): Promise<TicketCreatedResponse> => {
    const principal = principalOf(request);
    const body = parse(TicketRequest, request.body, 'body');
    const at = asOfOfRequest({}, app.deps.clock);
    const now = new Date(app.deps.clock.now()).toISOString();

    const created = await withTx(ctxOf(principal), async (tx) => {
      // The security the panel was showing, when it was showing one. An unresolvable reference
      // does not refuse the ticket: the user's question is still a question, and the reference
      // they typed is part of what the desk needs to see.
      let instrumentId: number | null = null;
      if (body.security !== undefined && !('formula' in body.security)) {
        const ref = body.security;
        const outcome = await new SecurityResolver(tx).resolve(
          'id' in ref ? { id: ref.id } : ref.ref,
          at,
        );
        if (outcome.ok) instrumentId = outcome.instrument.instrumentId;
      }

      const code = body.functionCode ?? null;
      const room = await messagingService({ db: tx, clock: app.deps.clock }).createRoom({
        kind: 'helpdesk',
        name: code === null ? 'Help' : `Help — ${code}`,
        createdBy: principal.userId,
        memberUserIds: await deskStaff(tx, principal),
        firmId: principal.firmId,
      });

      const inserted = await tx.execute<{ ticket_id: string }>(sql`
        INSERT INTO help_tickets (user_id, firm_id, opened_at, panel_id, function_code,
                                  instrument_id, params, screen_state, trace_id, question, room_id)
        VALUES (${String(principal.userId)}::bigint, ${String(principal.firmId)}::bigint,
                ${now}::timestamptz, ${body.panelId ?? null}, ${code},
                ${instrumentId === null ? sql`NULL::bigint` : sql`${String(instrumentId)}::bigint`},
                ${body.params === undefined ? null : JSON.stringify(body.params)}::jsonb,
                ${JSON.stringify(body.screenState)}::jsonb,
                ${body.traceId ?? request.traceId}::uuid, ${body.question},
                ${String(room.roomId)}::bigint)
        RETURNING ticket_id::text AS ticket_id`);
      const row = inserted.rows[0];
      if (row === undefined) throw new NotFoundError('The ticket was not written.');

      // FUNC-04's roadmap query counts `ticket.open` beside `fn.launch`: which screens people ask
      // about is the other half of which screens people use.
      await tx.execute(sql`
        INSERT INTO usage_events (ts, user_id, firm_id, session_id, panel_id, kind, code,
                                  instrument_id, trace_id, details)
        VALUES (${now}::timestamptz, ${String(principal.userId)}::bigint,
                ${String(principal.firmId)}::bigint, ${principal.sessionId}::uuid,
                ${body.panelId ?? null}, 'ticket.open', ${code},
                ${instrumentId === null ? sql`NULL::bigint` : sql`${String(instrumentId)}::bigint`},
                ${body.traceId ?? request.traceId}::uuid,
                ${JSON.stringify({ ticketId: Number(row.ticket_id), roomId: room.roomId })}::jsonb)`);

      return { ticketId: Number(row.ticket_id), roomId: room.roomId };
    });

    void reply.status(201);
    return created;
  });

  // ── GET /help/:code (HELP ×1) ──────────────────────────────────────────────────────────────
  app.get('/help/:code', guard, async (request): Promise<HelpResponse> => {
    const { code } = parse(HelpCodeParams, request.params, 'params');
    const query = parse(HelpQuery, request.query ?? {}, 'query');
    const manifest = manifestOr404(code);
    return helpFor(manifest, query.assetClass ?? null, await licencesFor(hostDepsOf(request)));
  });

  await Promise.resolve();
};

export default helpRoutes;
