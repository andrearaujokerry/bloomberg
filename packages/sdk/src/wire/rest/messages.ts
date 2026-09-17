/**
 * `wire/rest/messages.ts` — `Rest.Messages.*`: the 9 messaging and directory routes.
 *
 * Schemas and routes transcribed from API.md §5.10 L697-730
 * (MSG-01, MSG-02, MSG-03, MSG-04, MSG-06).
 * Owned by WP-01 now, by WP-09 (`server/src/http/routes/messages.ts`) afterwards.
 *
 * Messages are immutable: no PUT/DELETE exists; corrections are new messages. Live delivery is
 * the WS `room:<roomId>` subject (API.md §6.9).
 *
 * Route descriptor shape used by every `wire/rest/*` group (consumed by `client/rest.ts`):
 *   { method, path, params?, query?, body?, response, status, format? }
 */
import { z } from 'zod';

import { Role } from './auth.js';

/* ------------------------------------------------------------------ schemas */

/**
 * MSG-04: rendered live in the recipient's client within THEIR entitlements.
 * API.md §5.10 L700-706, verbatim.
 */
export const Attachment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('security'), instrumentId: z.number().int() }),
  z.object({
    kind: z.literal('function'),
    code: z.string(),
    instrumentId: z.number().int().nullable(),
    params: z.record(z.string(), z.unknown()),
    resultId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('chart'),
    instrumentId: z.number().int(),
    params: z.record(z.string(), z.unknown()),
    annotationIds: z.array(z.number().int()).default([]),
  }),
  z.object({ kind: z.literal('portfolio'), portfolioId: z.number().int() }),
  z.object({ kind: z.literal('watchlist'), watchlistId: z.number().int() }),
]);
export type Attachment = z.infer<typeof Attachment>;

/** MSG-06, display only. */
export const StructuredMsg = z.object({
  type: z.enum(['ioi', 'rfq']),
  side: z.enum(['buy', 'sell']),
  instrumentId: z.number().int(),
  qty: z.number(),
  price: z.number().nullable(),
});
export type StructuredMsg = z.infer<typeof StructuredMsg>;

export const Message = z.object({
  messageId: z.number().int(),
  roomId: z.number().int(),
  seq: z.number().int(),
  senderUserId: z.number().int(),
  senderFirmId: z.number().int(),
  senderDisplay: z.string(),
  sentAt: z.iso.datetime(),
  body: z.string(),
  attachments: z.array(Attachment),
  structured: StructuredMsg.nullable(),
  clientMsgId: z.uuid(),
  prevHash: z.string().nullable(),
  /** sha256 hex, assigned by the DB trigger (MSG-02 hash chain) */
  hash: z.string(),
  traceId: z.uuid().nullable(),
});
export type Message = z.infer<typeof Message>;

export const RoomKind = z.enum(['dm', 'group', 'firm', 'helpdesk']);
export type RoomKind = z.infer<typeof RoomKind>;

export const RoomMemberRole = z.enum(['member', 'owner', 'supervisor']);
export type RoomMemberRole = z.infer<typeof RoomMemberRole>;

export const RoomMember = z.object({
  userId: z.number().int(),
  displayName: z.string(),
  firmName: z.string(),
  desk: z.string().nullable(),
  role: RoomMemberRole,
});
export type RoomMember = z.infer<typeof RoomMember>;

export const Room = z.object({
  roomId: z.number().int(),
  kind: RoomKind,
  name: z.string().nullable(),
  scope: z.enum(['internal', 'external']),
  disclaimer: z.string().nullable(),
  wallTag: z.string().nullable(),
  createdAt: z.iso.datetime(),
  members: z.array(RoomMember),
  lastSeq: z.number().int(),
  lastReadSeq: z.number().int(),
  lastMessageAt: z.iso.datetime().nullable(),
});
export type Room = z.infer<typeof Room>;

export const DirectoryEntry = z.object({
  userId: z.number().int(),
  displayName: z.string(),
  firmId: z.number().int(),
  firmName: z.string(),
  desk: z.string().nullable(),
  role: Role,
  verified: z.boolean(),
});
export type DirectoryEntry = z.infer<typeof DirectoryEntry>;

/** Shared by every `/rooms/:roomId/...` route. */
export const RoomParams = z.object({ roomId: z.number().int().positive() });
export type RoomParams = z.infer<typeof RoomParams>;

/** Rooms the caller is a member of (RLS via `is_room_member()`). */
export const RoomListResponse = z.object({ items: z.array(Room) });
export type RoomListResponse = z.infer<typeof RoomListResponse>;

export const CreateRoomRequest = z.object({
  kind: z.enum(['dm', 'group']),
  name: z.string().min(1).max(120).optional(),
  memberUserIds: z.array(z.number().int()).min(1),
});
export type CreateRoomRequest = z.infer<typeof CreateRoomRequest>;

export const RoomMembersRequest = z.object({
  userIds: z.array(z.number().int()).min(1),
});
export type RoomMembersRequest = z.infer<typeof RoomMembersRequest>;

export const MessageListQuery = z.object({
  /** `seq` exclusive upper bound (paging backwards) */
  before: z.number().int().optional(),
  /** `seq` exclusive lower bound (catching up) */
  after: z.number().int().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type MessageListQuery = z.infer<typeof MessageListQuery>;

/** In `seq` order. */
export const MessageListResponse = z.object({
  items: z.array(Message),
  nextCursor: z.string().nullable(),
});
export type MessageListResponse = z.infer<typeof MessageListResponse>;

/**
 * Idempotent on `clientMsgId`: a repeat returns the stored row with `200` instead of `201`.
 * The hash chain is assigned by the DB trigger; lexicon surveillance runs async.
 */
export const SendMessageRequest = z.object({
  clientMsgId: z.uuid(),
  body: z.string().max(8000),
  attachments: z.array(Attachment).optional(),
  structured: StructuredMsg.optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const MarkReadRequest = z.object({ lastReadSeq: z.number().int() });
export type MarkReadRequest = z.infer<typeof MarkReadRequest>;

/** Verified users, firms and desks (MSG-01). */
export const DirectoryQuery = z.object({
  q: z.string().min(1).max(120),
  limit: z.number().int().min(1).max(25).default(25),
});
export type DirectoryQuery = z.infer<typeof DirectoryQuery>;

export const DirectoryResponse = z.object({ items: z.array(DirectoryEntry) });
export type DirectoryResponse = z.infer<typeof DirectoryResponse>;

/* ------------------------------------------------------------------- routes */

/** The 9 routes of API.md §5.10 (`http/routes/messages.ts`). */
export const Messages = {
  /** Rooms the caller is a member of. */
  ListRooms: {
    method: 'GET',
    path: '/rooms',
    response: RoomListResponse,
    status: 200,
  },
  /**
   * `403 MESSAGE_POLICY_BLOCKED` when the counterparty firm is not permitted, an ethical wall
   * applies, or the room would be external without permission (MSG-03).
   */
  CreateRoom: {
    method: 'POST',
    path: '/rooms',
    body: CreateRoomRequest,
    response: Room,
    status: 201,
  },
  GetRoom: {
    method: 'GET',
    path: '/rooms/:roomId',
    params: RoomParams,
    response: Room,
    status: 200,
  },
  /** Owner/supervisor only. */
  AddMembers: {
    method: 'POST',
    path: '/rooms/:roomId/members',
    params: RoomParams,
    body: RoomMembersRequest,
    response: Room,
    status: 200,
  },
  /** Owner/supervisor only. */
  RemoveMembers: {
    method: 'DELETE',
    path: '/rooms/:roomId/members',
    params: RoomParams,
    body: RoomMembersRequest,
    response: Room,
    status: 200,
  },
  ListMessages: {
    method: 'GET',
    path: '/rooms/:roomId/messages',
    params: RoomParams,
    query: MessageListQuery,
    response: MessageListResponse,
    status: 200,
  },
  /** Idempotent on `clientMsgId` (a repeat returns the stored row with `200`). */
  Send: {
    method: 'POST',
    path: '/rooms/:roomId/messages',
    params: RoomParams,
    body: SendMessageRequest,
    response: Message,
    status: 201,
  },
  MarkRead: {
    method: 'POST',
    path: '/rooms/:roomId/read',
    params: RoomParams,
    body: MarkReadRequest,
    response: z.void(),
    status: 204,
  },
  /** MSG-01 counterparty directory. */
  Directory: {
    method: 'GET',
    path: '/directory',
    query: DirectoryQuery,
    response: DirectoryResponse,
    status: 200,
  },
} as const;
