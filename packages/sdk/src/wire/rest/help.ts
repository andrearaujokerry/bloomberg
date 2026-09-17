/**
 * `wire/rest/help.ts` — `Rest.Help.*`: the 3 help and helpdesk-ticket routes.
 *
 * Schemas and routes transcribed from API.md §5.12 L758-764 (TERM-09).
 * Owned by WP-01 now, by WP-09 (`server/src/http/routes/help.ts`) afterwards.
 *
 * Route descriptor shape used by every `wire/rest/*` group (consumed by `client/rest.ts`):
 *   { method, path, params?, query?, body?, response, status, format? }
 */
import { z } from 'zod';

import { AssetClass, SecurityRefInput } from '../common.js';
import { HelpResponse } from './functions.js';

/* ------------------------------------------------------------------ schemas */

export const TicketStatus = z.enum(['open', 'answered', 'closed']);
export type TicketStatus = z.infer<typeof TicketStatus>;

/** A `help_tickets` row as the client sees it (API.md §5.12 L764). */
export const Ticket = z.object({
  ticketId: z.number().int(),
  openedAt: z.iso.datetime(),
  functionCode: z.string().nullable(),
  question: z.string(),
  status: TicketStatus,
  roomId: z.number().int().nullable(),
  answer: z.string().nullable(),
  answeredAt: z.iso.datetime().nullable(),
});
export type Ticket = z.infer<typeof Ticket>;

export const HelpCodeParams = z.object({ code: z.string().min(1).max(20) });
export type HelpCodeParams = z.infer<typeof HelpCodeParams>;

export const HelpQuery = z.object({ assetClass: AssetClass.optional() });
export type HelpQuery = z.infer<typeof HelpQuery>;

/**
 * HELP ×2. Creates a `help_tickets` row and a `helpdesk` room with the `helpdesk` role users,
 * and writes `usage_events kind='ticket.open'`.
 */
export const TicketRequest = z.object({
  panelId: z.string().optional(),
  functionCode: z.string().max(20).optional(),
  security: SecurityRefInput.optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  /** visible fields + their provenance indexes, captured from the screen */
  screenState: z.record(z.string(), z.unknown()),
  traceId: z.uuid().optional(),
  question: z.string().min(1).max(4000),
});
export type TicketRequest = z.infer<typeof TicketRequest>;

export const TicketCreatedResponse = z.object({
  ticketId: z.number().int(),
  roomId: z.number().int(),
});
export type TicketCreatedResponse = z.infer<typeof TicketCreatedResponse>;

/** Own tickets; the `helpdesk` role sees all. */
export const TicketListQuery = z.object({ status: TicketStatus.optional() });
export type TicketListQuery = z.infer<typeof TicketListQuery>;

export const TicketListResponse = z.object({ items: z.array(Ticket) });
export type TicketListResponse = z.infer<typeof TicketListResponse>;

/* ------------------------------------------------------------------- routes */

/** The 3 routes of API.md §5.12 (`http/routes/help.ts`). */
export const Help = {
  /** HELP ×1 — the same body as `GET /functions/:code/help`. */
  Get: {
    method: 'GET',
    path: '/help/:code',
    params: HelpCodeParams,
    query: HelpQuery,
    response: HelpResponse,
    status: 200,
  },
  /** HELP ×2 — opens a helpdesk ticket and its room. */
  OpenTicket: {
    method: 'POST',
    path: '/help/tickets',
    body: TicketRequest,
    response: TicketCreatedResponse,
    status: 201,
  },
  Tickets: {
    method: 'GET',
    path: '/help/tickets',
    query: TicketListQuery,
    response: TicketListResponse,
    status: 200,
  },
} as const;
