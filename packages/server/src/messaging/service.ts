/**
 * `messaging/service.ts` — rooms, the WORM message log and MSG-03 policy (WORKPLAN WP-09 L1160).
 *
 * Three things live here and nowhere else.
 *
 * **The append-only log (MSG-02).** `messages` is WORM: migration 0015 gives `terminal_app` no
 * `UPDATE`/`DELETE` grant and installs `messages_worm` as defence in depth against the owner role,
 * so this module only ever `INSERT`s. `seq`, `prev_hash` and `hash` are assigned by the
 * `messages_chain` trigger under a per-room advisory lock — the chain is the database's job, not
 * the application's, because two sends racing into one room must not both believe they are seq 5.
 * {@link MessagingService.verifyChain} recomputes the digest **in SQL**, with the same
 * `convert_to(... ,'UTF8')` and `attachments::text` rendering the trigger uses; recomputing it in
 * JavaScript would mean re-implementing Postgres' jsonb text output and would drift the first time
 * a key order changed. Verification checks three independent things: `seq` is contiguous from 1,
 * each row's `prev_hash` is the previous row's `hash`, and each `hash` is the digest of its own
 * content. A tampered row therefore cannot hide behind a recomputed chain.
 *
 * **Idempotent send.** `client_msg_id` is unique per room. A retry after a lost response returns
 * the stored row rather than a second message; a concurrent duplicate loses the unique-violation
 * race and re-reads the winner. Either way exactly one message exists and the chain has one link.
 *
 * **Policy (MSG-03), enforced on join and on send.** {@link canMessage} and {@link canJoin} are
 * pure functions over already-loaded parties, so the rules can be read and tested without a
 * database: (a) an external room, or a counterparty in another firm, requires that firm's name in
 * `firms.policy.permittedCounterpartyFirms`; (b) a room's `wall_tag` requires **every** member's
 * `users.desk` to carry it, `firms.policy.ethicalWalls` blocks listed desk pairs, and the
 * `newsroom` role is walled from every non-newsroom desk unconditionally (SEC-06); (c) a
 * non-member may not send. Retention has a floor of seven years (REG-01) that neither a room nor
 * an administrator can lower — `setRetentionDays` refuses, it does not clamp silently.
 *
 * **Attachments are references (MSG-04).** What is stored is `{kind, ids, params}` and nothing
 * else: every attachment is parsed with the wire schema before it is written, which strips any
 * value the sender's client may have attached to it. A shared position or price is rendered by the
 * *recipient's* client under the *recipient's* entitlements — a snapshot of the sender's numbers
 * would leak entitled data to someone who is not entitled to it (ENTL-05).
 *
 * The service takes the caller's transaction, so every read and write runs under that request's
 * `app.user_id` / `app.firm_id` and the RLS policies of migration 0015 apply. `messages` is
 * `FORCE ROW LEVEL SECURITY`: without a user context the insert is rejected by the database even
 * for the owner role, which is the behaviour the policy tests rely on.
 */

import { sql } from 'drizzle-orm';

import type { Clock } from '@terminal/core';
import {
  Attachment as AttachmentSchema,
  StructuredMsg as StructuredMsgSchema,
  type Attachment,
  type Message,
  type Room,
  type RoomMember,
  type StructuredMsg,
} from '@terminal/sdk/wire/rest/messages';

import type { Db, Tx } from '../db/client.js';
import { AppError, BadRequestError, NotFoundError } from '../http/errors.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type RoomKind = 'dm' | 'group' | 'firm' | 'helpdesk';
export type RoomScope = 'internal' | 'external';
export type MemberRole = 'member' | 'owner' | 'supervisor';
export type UserRole = 'user' | 'admin' | 'compliance' | 'dataops' | 'helpdesk' | 'newsroom';

/** FUNCTIONS_TIER1 §MSG L1548. `OK` is the only value that permits a send. */
export type MsgSendBlock =
  'OK' | 'MESSAGE_POLICY_BLOCKED' | 'ETHICAL_WALL' | 'EXTERNAL_NOT_PERMITTED' | 'NOT_A_MEMBER';

/** `details.rule` of the `MESSAGE_POLICY_BLOCKED` envelope (API.md §2 L150). */
export type PolicyRule = 'counterparty' | 'ethical_wall' | 'external' | 'legal_hold';

/** One person as the policy rules see them. */
export interface PartyView {
  userId: number;
  firmId: number;
  firmName: string;
  displayName: string;
  /** The ethical-wall unit (MSG-03). */
  desk: string | null;
  role: UserRole;
  /** Their seat in the room, when they hold one. */
  memberRole?: MemberRole;
}

/** `firms.policy` (MSG-03). Anything malformed degrades to "no permission granted". */
export interface FirmPolicy {
  permittedCounterpartyFirms: string[];
  disclaimer: string | null;
  ethicalWalls: { deskA: string; deskB: string }[];
}

/** The caller, with their firm's policy attached. */
export interface MeView extends PartyView {
  firmPolicy: FirmPolicy;
  /** `firms.retention_days` — the floor a room may raise but never lower. */
  firmRetentionDays: number;
}

/** A room and its live membership, as the pure policy functions need it. */
export interface RoomContext {
  roomId: number;
  kind: RoomKind;
  name: string | null;
  scope: RoomScope;
  firmId: number | null;
  wallTag: string | null;
  disclaimer: string | null;
  retentionDays: number;
  /** `rooms.policy.permittedFirms` — a per-room narrowing of the firm list. */
  permittedFirms: string[];
  /** `rooms.policy.allowExternal`. */
  allowExternal: boolean;
  createdBy: number;
  createdAt: string;
  members: PartyView[];
}

export interface SendInput {
  roomId: number;
  senderUserId: number;
  body: string;
  /** MSG-04 references. Parsed with the wire schema: values a client attached are stripped. */
  attachments?: readonly unknown[];
  /** MSG-06, display only. */
  structured?: unknown;
  clientMsgId: string;
  traceId?: string;
}

export interface HistoryQuery {
  /** `seq` exclusive upper bound — paging backwards. */
  before?: number;
  /** `seq` exclusive lower bound — catching up. */
  after?: number;
  limit?: number;
}

export interface HistoryPage {
  items: Message[];
  /** The `before` value for the next (older) page, or `null` at the start of the room. */
  nextCursor: string | null;
}

export interface ChainVerdict {
  ok: boolean;
  /** The first `seq` whose linkage or digest does not hold. Absent when `ok`. */
  firstBadSeq?: number;
  /** Why that seq failed — for the compliance export, not for the wire. */
  detail?: string;
  /** How many messages were verified. */
  checked: number;
}

export interface CreateRoomInput {
  kind: RoomKind;
  name?: string | null;
  createdBy: number;
  memberUserIds: readonly number[];
  scope?: RoomScope;
  firmId?: number | null;
  wallTag?: string | null;
  disclaimer?: string | null;
  retentionDays?: number;
  permittedFirms?: readonly string[];
  allowExternal?: boolean;
}

/** The shared WP-09 contract, plus the room lifecycle the routes need. */
export interface MessagingService {
  rooms(userId: number): Promise<Room[]>;
  send(input: SendInput): Promise<Message>;
  history(roomId: number, q: HistoryQuery): Promise<HistoryPage>;
  join(roomId: number, userId: number): Promise<Room>;
  verifyChain(roomId: number): Promise<ChainVerdict>;

  // ── Beyond the shared contract, for `http/routes/messages.ts` ──────────────────────────────
  createRoom(input: CreateRoomInput): Promise<Room>;
  room(roomId: number, viewerUserId: number): Promise<Room | null>;
  /** MSG-03 evaluated for one room, as the MSG screen's `sendBlockedReason`. */
  sendBlockedReason(roomId: number, userId: number): Promise<MsgSendBlock>;
  /** The disclaimer a joiner is shown (MSG-03); `null` when neither room nor firm sets one. */
  disclaimerFor(roomId: number, userId: number): Promise<string | null>;
  /** REG-01: refuses anything below `max(7 years, firms.retention_days)`. */
  setRetentionDays(roomId: number, days: number, byUserId: number): Promise<Room>;
  markRead(roomId: number, userId: number, lastReadSeq: number): Promise<void>;
  /** The loaded room and its members — what the MSG resolver and the routes evaluate policy on. */
  context(roomId: number): Promise<RoomContext | null>;
  party(userId: number): Promise<MeView | null>;
}

/** 403 `MESSAGE_POLICY_BLOCKED` / `FORBIDDEN`, carrying the rule that refused (API.md §2 L150). */
export class MessagePolicyError extends AppError {
  readonly reason: Exclude<MsgSendBlock, 'OK'>;

  constructor(reason: Exclude<MsgSendBlock, 'OK'>, message: string, rule?: PolicyRule) {
    super(
      reason === 'NOT_A_MEMBER' ? 'FORBIDDEN' : 'MESSAGE_POLICY_BLOCKED',
      message,
      rule === undefined ? {} : { details: { rule } },
    );
    this.name = 'MessagePolicyError';
    this.reason = reason;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** REG-01 / MSG-03: seven years of messages, and the `rooms.retention_days` default. */
export const RETENTION_FLOOR_DAYS = 2557;

/** API.md §5.10: `body` is `string.max(8000)`. */
export const MAX_BODY_CHARS = 8_000;

/** API.md §5.10: `limit ≤ 200`. */
const MAX_HISTORY_LIMIT = 200;
const DEFAULT_HISTORY_LIMIT = 50;

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * The digest of the `messages_chain` trigger, recomputed over the stored row, **by version**.
 *
 * Version 1 is migration 0015's expression. It covered prev_hash, room_id, seq, sender, sent_at,
 * body and attachments — and nothing else, so an MSG-06 IOI could be rewritten from
 * `{side:'buy', qty:10000, price:42.5}` to `{side:'sell', qty:1, price:9999}`, or the sending firm
 * changed, and the chain still verified. The tradable content of an indication of interest was
 * outside the record that attests to it.
 *
 * Version 2 (migration 0017) adds `structured`, `sender_firm_id` and `client_msg_id`. Widening the
 * expression invalidates every hash already written, so `messages.digest_version` records which
 * expression produced a row's hash and the verification picks by version — an archived room keeps
 * verifying under the rule it was written with, which is the whole point of a WORM log.
 *
 * Kept as SQL text so the trigger and the verifier cannot drift apart silently.
 */
const chainDigestV1 = (prev: string): string => `digest(coalesce(${prev}, '\\x'::bytea)
        || convert_to(room_id::text || '|' || seq::text || '|' || sender_user_id::text || '|'
                      || to_char(sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|'
                      || body || '|' || attachments::text, 'UTF8'),
        'sha256')`;

const chainDigestV2 = (prev: string): string => `digest(coalesce(${prev}, '\\x'::bytea)
        || convert_to(room_id::text || '|' || seq::text || '|' || sender_user_id::text || '|'
                      || to_char(sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|'
                      || body || '|' || attachments::text || '|'
                      || coalesce(structured::text, '') || '|'
                      || sender_firm_id::text || '|'
                      || client_msg_id::text, 'UTF8'),
        'sha256')`;

/**
 * The digest expression that applies to a row, chosen by the row's own `digest_version`.
 *
 * @param prevHashExpr the SQL for the previous row's hash. `verifyChain` passes the stored
 *   `prev_hash`, because it checks the linkage separately; `GET /admin/export/messages` passes
 *   `lag(hash) OVER (PARTITION BY room_id ORDER BY seq)`, which checks the digest **and** the
 *   linkage in one pass. Both are legitimate readings and neither may keep its own copy of the
 *   expression — that is how the 0017 widening left the export verifying against the 0015 digest
 *   and reporting every room as broken.
 */
export function chainDigestSql(prevHashExpr = 'prev_hash'): string {
  return (
    `CASE WHEN digest_version >= 2 THEN ${chainDigestV2(prevHashExpr)} ` +
    `ELSE ${chainDigestV1(prevHashExpr)} END`
  );
}

const CHAIN_DIGEST = chainDigestSql();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Policy — pure functions over loaded parties (MSG-03, SEC-06)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `firms.policy` as stored, defensively. An unreadable policy grants nothing. */
export function readFirmPolicy(raw: unknown): FirmPolicy {
  const empty: FirmPolicy = { permittedCounterpartyFirms: [], disclaimer: null, ethicalWalls: [] };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const record = raw as Record<string, unknown>;

  const firms = record.permittedCounterpartyFirms;
  const permitted = Array.isArray(firms)
    ? firms.filter((f): f is string => typeof f === 'string')
    : [];

  const walls = record.ethicalWalls;
  const pairs: { deskA: string; deskB: string }[] = [];
  if (Array.isArray(walls)) {
    for (const wall of walls) {
      if (wall === null || typeof wall !== 'object') continue;
      const { deskA, deskB } = wall as { deskA?: unknown; deskB?: unknown };
      if (typeof deskA === 'string' && typeof deskB === 'string') pairs.push({ deskA, deskB });
    }
  }

  const disclaimer = typeof record.disclaimer === 'string' ? record.disclaimer : null;
  return { permittedCounterpartyFirms: permitted, disclaimer, ethicalWalls: pairs };
}

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Does a desk carry a wall tag? A desk is matched whole (`'ECM' ↔ 'ECM'`) or by token
 * (`'ECM Syndicate'` carries `'ECM'`), never by substring — `'Research'` must not be let through
 * a wall tagged `'Sear'`.
 */
export function deskCarriesTag(desk: string | null, tag: string): boolean {
  if (desk === null) return false;
  const wanted = norm(tag);
  if (wanted === '') return false;
  if (norm(desk) === wanted) return true;
  return norm(desk)
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '')
    .includes(wanted);
}

function walledPair(policy: FirmPolicy, a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const x = norm(a);
  const y = norm(b);
  if (x === y) return false;
  return policy.ethicalWalls.some(
    (wall) =>
      (norm(wall.deskA) === x && norm(wall.deskB) === y) ||
      (norm(wall.deskA) === y && norm(wall.deskB) === x),
  );
}

/** SEC-06: the newsroom is walled from every non-newsroom desk, with no policy row needed. */
function newsroomWall(a: PartyView, b: PartyView): boolean {
  return (a.role === 'newsroom') !== (b.role === 'newsroom');
}

function firmPermits(me: MeView, room: RoomContext | null, counterpartyFirm: string): boolean {
  const permittedByFirm = me.firmPolicy.permittedCounterpartyFirms.some(
    (name) => norm(name) === norm(counterpartyFirm),
  );
  if (!permittedByFirm) return false;
  if (room === null || room.permittedFirms.length === 0) return true;
  return room.permittedFirms.some((name) => norm(name) === norm(counterpartyFirm));
}

/**
 * MSG-03, in the order of FUNCTIONS_TIER1 §MSG step 8: external / counterparty first, then the
 * ethical walls, then membership. `counterparty` is the other side of a directory entry or of a
 * dm; for a group room it is `null` and every other member is checked instead.
 */
export function canMessage(
  me: MeView,
  counterparty: PartyView | null,
  room: RoomContext | null,
): MsgSendBlock {
  const others =
    counterparty !== null
      ? [counterparty]
      : (room?.members.filter((m) => m.userId !== me.userId) ?? []);

  // (a) external rooms and cross-firm counterparties
  if (room !== null && room.scope === 'external' && !room.allowExternal) {
    return 'EXTERNAL_NOT_PERMITTED';
  }
  for (const other of others) {
    if (other.firmId === me.firmId) continue;
    if (!firmPermits(me, room, other.firmName)) {
      return room !== null && room.scope === 'external'
        ? 'EXTERNAL_NOT_PERMITTED'
        : 'MESSAGE_POLICY_BLOCKED';
    }
  }

  // (b) ethical walls — the room's tag over every member, the firm's pairs over every pair
  if (room !== null && room.wallTag !== null) {
    const tagged = [me, ...room.members.filter((m) => m.userId !== me.userId)];
    if (!tagged.every((member) => deskCarriesTag(member.desk, room.wallTag ?? ''))) {
      return 'ETHICAL_WALL';
    }
  }
  for (const other of others) {
    if (newsroomWall(me, other)) return 'ETHICAL_WALL';
    if (walledPair(me.firmPolicy, me.desk, other.desk)) return 'ETHICAL_WALL';
  }

  // (c) membership
  if (room !== null && !room.members.some((m) => m.userId === me.userId)) return 'NOT_A_MEMBER';
  return 'OK';
}

/**
 * MSG-03 on join: the joiner is checked against the room and against every **existing** member,
 * before any row is written. Membership is not required (that is what is being asked for), so the
 * `NOT_A_MEMBER` clause of {@link canMessage} never applies here.
 */
export function canJoin(joiner: MeView, room: RoomContext): MsgSendBlock {
  if (room.scope === 'external' && !room.allowExternal) return 'EXTERNAL_NOT_PERMITTED';

  for (const member of room.members) {
    if (member.userId === joiner.userId) continue;
    if (member.firmId !== joiner.firmId && !firmPermits(joiner, room, member.firmName)) {
      return room.scope === 'external' ? 'EXTERNAL_NOT_PERMITTED' : 'MESSAGE_POLICY_BLOCKED';
    }
  }

  if (room.wallTag !== null) {
    const tagged = [joiner, ...room.members.filter((m) => m.userId !== joiner.userId)];
    if (!tagged.every((member) => deskCarriesTag(member.desk, room.wallTag ?? ''))) {
      return 'ETHICAL_WALL';
    }
  }
  for (const member of room.members) {
    if (member.userId === joiner.userId) continue;
    if (newsroomWall(joiner, member)) return 'ETHICAL_WALL';
    if (walledPair(joiner.firmPolicy, joiner.desk, member.desk)) return 'ETHICAL_WALL';
  }
  return 'OK';
}

/**
 * MSG-03 for the *creator*, evaluated against the room they are asking for.
 *
 * `canJoin` gates everybody who is added after the room exists, but the creator is seated before
 * any check runs, so a room could be created carrying a `wallTag` its creator's own desk does not
 * carry, or an external scope their firm policy forbids — and the creator would then be the one
 * member of a walled room they may not be in. The hole is not reachable through `POST /rooms`
 * today (the wire schema carries no `wallTag` or `scope`), but `help.ts` already calls
 * `createRoom` directly and every future caller would inherit it.
 *
 * The membership test of `canJoin` has no analogue here: a room with no members yet cannot
 * contradict its creator, and the members named in the same call are each checked by `canJoin`
 * against the membership as it stands when they are added.
 */
export function canCreate(
  creator: MeView,
  spec: { scope: RoomScope; wallTag: string | null; allowExternal: boolean },
): MsgSendBlock {
  if (spec.scope === 'external' && !spec.allowExternal) return 'EXTERNAL_NOT_PERMITTED';
  if (spec.wallTag !== null && !deskCarriesTag(creator.desk, spec.wallTag)) return 'ETHICAL_WALL';
  return 'OK';
}

/** The sentence a refusal is reported with. */
export function policyMessage(reason: Exclude<MsgSendBlock, 'OK'>): string {
  switch (reason) {
    case 'EXTERNAL_NOT_PERMITTED':
      return 'this room is external and your firm policy does not allow it';
    case 'ETHICAL_WALL':
      return 'an ethical wall separates the desks in this room';
    case 'MESSAGE_POLICY_BLOCKED':
      return 'that firm is not a permitted counterparty';
    case 'NOT_A_MEMBER':
      return 'you are not a member of this room';
  }
}

const RULE_OF: Record<Exclude<MsgSendBlock, 'OK'>, PolicyRule | undefined> = {
  EXTERNAL_NOT_PERMITTED: 'external',
  ETHICAL_WALL: 'ethical_wall',
  MESSAGE_POLICY_BLOCKED: 'counterparty',
  NOT_A_MEMBER: undefined,
};

function refuse(reason: Exclude<MsgSendBlock, 'OK'>): never {
  throw new MessagePolicyError(reason, policyMessage(reason), RULE_OF[reason]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface PartyRow {
  user_id: string;
  firm_id: string;
  display_name: string;
  desk: string | null;
  role: string;
  firm_name: string;
  firm_policy: unknown;
  firm_retention_days: number;
}

interface MemberRow {
  user_id: string;
  member_role: string;
  display_name: string;
  desk: string | null;
  user_role: string;
  firm_id: string;
  firm_name: string;
}

interface RoomRow {
  room_id: string;
  kind: string;
  name: string | null;
  scope: string;
  firm_id: string | null;
  wall_tag: string | null;
  disclaimer: string | null;
  retention_days: number;
  policy: unknown;
  created_by: string;
  created_at: string;
}

interface RoomStatsRow extends RoomRow {
  last_seq: string;
  last_read_seq: string;
  last_message_at: string | null;
}

interface MessageRow {
  message_id: string;
  room_id: string;
  seq: string;
  sender_user_id: string;
  sender_firm_id: string;
  sender_display: string;
  sent_at: string;
  body: string;
  attachments: unknown;
  structured: unknown;
  client_msg_id: string;
  prev_hash: string | null;
  hash: string;
  trace_id: string | null;
}

interface ChainRow {
  seq: string;
  hash: string;
  prev_hash: string | null;
  expected: string;
}

const asRows = <T>(result: { rows: unknown[] }): T[] => result.rows as T[];

function toRoomContext(room: RoomRow, members: MemberRow[]): RoomContext {
  const policy =
    room.policy !== null && typeof room.policy === 'object' && !Array.isArray(room.policy)
      ? (room.policy as Record<string, unknown>)
      : {};
  const permitted = policy.permittedFirms;
  return {
    roomId: Number(room.room_id),
    kind: room.kind as RoomKind,
    name: room.name,
    scope: room.scope as RoomScope,
    firmId: room.firm_id === null ? null : Number(room.firm_id),
    wallTag: room.wall_tag,
    disclaimer: room.disclaimer,
    retentionDays: room.retention_days,
    permittedFirms: Array.isArray(permitted)
      ? permitted.filter((f): f is string => typeof f === 'string')
      : [],
    allowExternal: policy.allowExternal === true,
    createdBy: Number(room.created_by),
    createdAt: room.created_at,
    members: members.map((m) => ({
      userId: Number(m.user_id),
      firmId: Number(m.firm_id),
      firmName: m.firm_name,
      displayName: m.display_name,
      desk: m.desk,
      role: m.user_role as UserRole,
      memberRole: m.member_role as MemberRole,
    })),
  };
}

function toRoom(row: RoomStatsRow, members: MemberRow[]): Room {
  const ctx = toRoomContext(row, members);
  return {
    roomId: ctx.roomId,
    kind: ctx.kind,
    name: ctx.name,
    scope: ctx.scope,
    disclaimer: ctx.disclaimer,
    wallTag: ctx.wallTag,
    createdAt: ctx.createdAt,
    members: ctx.members.map((m): RoomMember => ({
      userId: m.userId,
      displayName: m.displayName,
      firmName: m.firmName,
      desk: m.desk,
      role: m.memberRole ?? 'member',
    })),
    lastSeq: Number(row.last_seq),
    lastReadSeq: Number(row.last_read_seq),
    lastMessageAt: row.last_message_at,
  };
}

function toMessage(row: MessageRow): Message {
  const attachments = Array.isArray(row.attachments)
    ? row.attachments.map((a) => AttachmentSchema.parse(a))
    : [];
  const structured =
    row.structured === null || row.structured === undefined
      ? null
      : StructuredMsgSchema.parse(row.structured);
  return {
    messageId: Number(row.message_id),
    roomId: Number(row.room_id),
    seq: Number(row.seq),
    senderUserId: Number(row.sender_user_id),
    senderFirmId: Number(row.sender_firm_id),
    senderDisplay: row.sender_display,
    sentAt: row.sent_at,
    body: row.body,
    attachments,
    structured,
    clientMsgId: row.client_msg_id,
    prevHash: row.prev_hash,
    hash: row.hash,
    traceId: row.trace_id,
  };
}

/**
 * MSG-04: only the reference survives. The wire schema is a `z.object` union, so any extra key a
 * client hung on the attachment — a price, a P&L, a holdings snapshot — is stripped here, before
 * it can be stored and re-read by someone who is not entitled to it.
 */
function parseAttachments(input: readonly unknown[] | undefined): Attachment[] {
  if (input === undefined) return [];
  return input.map((raw, index) => {
    const parsed = AttachmentSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestError(`attachment ${String(index)} is not a valid reference`, {
        index,
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  });
}

function parseStructured(input: unknown): StructuredMsg | null {
  if (input === undefined || input === null) return null;
  const parsed = StructuredMsgSchema.safeParse(input);
  if (!parsed.success) {
    throw new BadRequestError('structured payload is not a valid IOI/RFQ', {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface MessagingDeps {
  /** The caller's transaction: RLS and the `app.*` context come with it. */
  db: Db | Tx;
  clock: Clock;
  /** Live fan-out — the gateway's `sendToRoom` (MSG-01, API.md §6.9). */
  deliver?: (roomId: number, message: Message) => void;
  /**
   * MSG-02 lexicon scan. It runs after the row is durable and never fails a send: a message that
   * reached the WORM log is archived whether or not supervision could be written.
   */
  surveillance?: {
    scanMessage(input: { messageId: number; firmId: number; body: string }): Promise<unknown>;
  };
  onError?: (err: unknown, detail: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function messagingService(deps: MessagingDeps): MessagingService {
  const db = deps.db;
  const report = deps.onError ?? ((): void => undefined);

  /**
   * Run a side effect that is allowed to fail, inside a `SAVEPOINT`, so that a failure cannot take
   * the caller's transaction with it.
   *
   * This is not defensive decoration. A statement that raises inside a Postgres transaction puts
   * it in state 25P02: every later statement fails, including the `COMMIT`. Without the savepoint,
   * a surveillance insert refused by RLS would silently discard the message that had already been
   * written — the send would be lost to a failure in the thing that only watches it. The savepoint
   * turns that into what it should be: the message stands, the supervision gap is reported.
   *
   * When `db` is not inside a transaction the `SAVEPOINT` itself fails; the effect then runs
   * unframed, which is the best that can be offered and is still correct for a pooled handle.
   */
  async function inSavepoint(
    name: string,
    effect: () => Promise<unknown>,
    detail: string,
  ): Promise<void> {
    let framed = true;
    try {
      await db.execute(sql.raw(`SAVEPOINT ${name}`));
    } catch {
      framed = false;
    }
    try {
      await effect();
      if (framed) await db.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
    } catch (err) {
      if (framed) {
        try {
          await db.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
        } catch (rollbackErr) {
          report(rollbackErr, `${detail} (the savepoint could not be rolled back)`);
        }
      }
      report(err, detail);
    }
  }

  async function party(userId: number): Promise<MeView | null> {
    const result = await db.execute(sql`
      SELECT u.user_id::text AS user_id, u.firm_id::text AS firm_id, u.display_name, u.desk,
             u.role, f.name AS firm_name, f.policy AS firm_policy,
             f.retention_days AS firm_retention_days
        FROM users u JOIN firms f ON f.firm_id = u.firm_id
       WHERE u.user_id = ${userId}`);
    const row = asRows<PartyRow>(result)[0];
    if (row === undefined) return null;
    return {
      userId: Number(row.user_id),
      firmId: Number(row.firm_id),
      firmName: row.firm_name,
      displayName: row.display_name,
      desk: row.desk,
      role: row.role as UserRole,
      firmPolicy: readFirmPolicy(row.firm_policy),
      firmRetentionDays: row.firm_retention_days,
    };
  }

  async function membersOf(roomId: number): Promise<MemberRow[]> {
    const result = await db.execute(sql`
      SELECT m.user_id::text AS user_id, m.role AS member_role, u.display_name, u.desk,
             u.role AS user_role, u.firm_id::text AS firm_id, f.name AS firm_name
        FROM room_members m
        JOIN users u ON u.user_id = m.user_id
        JOIN firms f ON f.firm_id = u.firm_id
       WHERE m.room_id = ${roomId} AND m.left_at IS NULL
       ORDER BY m.user_id`);
    return asRows<MemberRow>(result);
  }

  async function context(roomId: number): Promise<RoomContext | null> {
    const result = await db.execute(sql`
      SELECT room_id::text AS room_id, kind, name, scope, firm_id::text AS firm_id, wall_tag,
             disclaimer, retention_days, policy, created_by::text AS created_by,
             to_char(created_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS created_at
        FROM rooms WHERE room_id = ${roomId}`);
    const row = asRows<RoomRow>(result)[0];
    if (row === undefined) return null;
    return toRoomContext(row, await membersOf(roomId));
  }

  /** One room as the wire renders it, for `viewerUserId`'s read cursor. */
  async function roomFor(roomId: number, viewerUserId: number): Promise<Room | null> {
    const result = await db.execute(sql`
      SELECT r.room_id::text AS room_id, r.kind, r.name, r.scope, r.firm_id::text AS firm_id,
             r.wall_tag, r.disclaimer, r.retention_days, r.policy,
             r.created_by::text AS created_by,
             to_char(r.created_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS created_at,
             coalesce((SELECT max(m.seq) FROM messages m WHERE m.room_id = r.room_id), 0)::text
               AS last_seq,
             coalesce((SELECT mr.last_read_seq FROM message_reads mr
                        WHERE mr.room_id = r.room_id AND mr.user_id = ${viewerUserId}), 0)::text
               AS last_read_seq,
             (SELECT to_char(max(m.sent_at) AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)})
                FROM messages m WHERE m.room_id = r.room_id) AS last_message_at
        FROM rooms r
       WHERE r.room_id = ${roomId}`);
    const row = asRows<RoomStatsRow>(result)[0];
    if (row === undefined) return null;
    return toRoom(row, await membersOf(roomId));
  }

  async function loadForPolicy(
    roomId: number,
    userId: number,
  ): Promise<{ me: MeView; room: RoomContext }> {
    const [me, room] = await Promise.all([party(userId), context(roomId)]);
    if (me === null) throw new NotFoundError(`no such user ${String(userId)}`);
    if (room === null) throw new NotFoundError(`no such room ${String(roomId)}`);
    return { me, room };
  }

  async function storedMessage(roomId: number, clientMsgId: string): Promise<Message | null> {
    const result = await db.execute(sql`
      SELECT m.message_id::text AS message_id, m.room_id::text AS room_id, m.seq::text AS seq,
             m.sender_user_id::text AS sender_user_id, m.sender_firm_id::text AS sender_firm_id,
             u.display_name AS sender_display,
             to_char(m.sent_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS sent_at,
             m.body, m.attachments, m.structured, m.client_msg_id::text AS client_msg_id,
             encode(m.prev_hash, 'hex') AS prev_hash, encode(m.hash, 'hex') AS hash,
             m.trace_id::text AS trace_id
        FROM messages m JOIN users u ON u.user_id = m.sender_user_id
       WHERE m.room_id = ${roomId} AND m.client_msg_id = ${clientMsgId}::uuid`);
    const row = asRows<MessageRow>(result)[0];
    return row === undefined ? null : toMessage(row);
  }

  return {
    party,
    context,

    async rooms(userId: number): Promise<Room[]> {
      const result = await db.execute(sql`
        SELECT r.room_id::text AS room_id, r.kind, r.name, r.scope, r.firm_id::text AS firm_id,
               r.wall_tag, r.disclaimer, r.retention_days, r.policy,
               r.created_by::text AS created_by,
               to_char(r.created_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS created_at,
               coalesce((SELECT max(m.seq) FROM messages m WHERE m.room_id = r.room_id), 0)::text
                 AS last_seq,
               coalesce(mr.last_read_seq, 0)::text AS last_read_seq,
               (SELECT to_char(max(m.sent_at) AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)})
                  FROM messages m WHERE m.room_id = r.room_id) AS last_message_at
          FROM rooms r
          JOIN room_members me ON me.room_id = r.room_id
                              AND me.user_id = ${userId} AND me.left_at IS NULL
          LEFT JOIN message_reads mr ON mr.room_id = r.room_id AND mr.user_id = ${userId}
         ORDER BY last_message_at DESC NULLS LAST, r.room_id DESC`);
      const rows = asRows<RoomStatsRow>(result);
      const out: Room[] = [];
      for (const row of rows) out.push(toRoom(row, await membersOf(Number(row.room_id))));
      return out;
    },

    async room(roomId: number, viewerUserId: number): Promise<Room | null> {
      return roomFor(roomId, viewerUserId);
    },

    async sendBlockedReason(roomId: number, userId: number): Promise<MsgSendBlock> {
      const { me, room } = await loadForPolicy(roomId, userId);
      return canMessage(me, null, room);
    },

    async disclaimerFor(roomId: number, userId: number): Promise<string | null> {
      const { me, room } = await loadForPolicy(roomId, userId);
      return room.disclaimer ?? me.firmPolicy.disclaimer;
    },

    async createRoom(input: CreateRoomInput): Promise<Room> {
      const creator = await party(input.createdBy);
      if (creator === null) throw new NotFoundError(`no such user ${String(input.createdBy)}`);

      const floor = Math.max(RETENTION_FLOOR_DAYS, creator.firmRetentionDays);
      const retention = input.retentionDays ?? floor;
      if (retention < floor) {
        throw new BadRequestError(
          `retention_days ${String(retention)} is below the ${String(floor)}-day floor (REG-01)`,
          { field: 'retentionDays', requested: retention, floorDays: floor },
        );
      }

      const memberIds = [...new Set([input.createdBy, ...input.memberUserIds])];
      const scope = input.scope ?? 'internal';
      const policy = {
        permittedFirms: [...(input.permittedFirms ?? [])],
        allowExternal: input.allowExternal ?? false,
      };

      // The creator passes the same gate every joiner does, before any row is written.
      const creatorVerdict = canCreate(creator, {
        scope,
        wallTag: input.wallTag ?? null,
        allowExternal: policy.allowExternal,
      });
      if (creatorVerdict !== 'OK') refuse(creatorVerdict);

      const inserted = await db.execute(sql`
        INSERT INTO rooms (kind, name, firm_id, scope, created_by, retention_days, disclaimer,
                           wall_tag, policy)
        VALUES (${input.kind}, ${input.name ?? null}, ${input.firmId ?? null}, ${scope},
                ${input.createdBy}, ${retention}, ${input.disclaimer ?? null},
                ${input.wallTag ?? null}, ${JSON.stringify(policy)}::jsonb)
        RETURNING room_id::text AS room_id`);
      const created = asRows<{ room_id: string }>(inserted)[0];
      if (created === undefined) throw new Error('messaging: room insert returned no row');
      const roomId = Number(created.room_id);

      // The creator owns the room; the rest join through the same policy gate as any later join.
      await db.execute(sql`
        INSERT INTO room_members (room_id, user_id, role)
        VALUES (${roomId}, ${input.createdBy}, 'owner')
        ON CONFLICT (room_id, user_id) DO NOTHING`);

      for (const userId of memberIds) {
        if (userId === input.createdBy) continue;
        const joiner = await party(userId);
        if (joiner === null) throw new NotFoundError(`no such user ${String(userId)}`);
        const room = await context(roomId);
        if (room === null) throw new NotFoundError(`no such room ${String(roomId)}`);
        const verdict = canJoin(joiner, room);
        if (verdict !== 'OK') refuse(verdict);
        await db.execute(sql`
          INSERT INTO room_members (room_id, user_id, role)
          VALUES (${roomId}, ${userId}, 'member')
          ON CONFLICT (room_id, user_id) DO NOTHING`);
      }

      const room = await roomFor(roomId, input.createdBy);
      if (room === null) throw new Error('messaging: created room is not readable');
      return room;
    },

    /**
     * MSG-03 on join. The policy is evaluated against the membership as it stands *before* the
     * row is written, so a wall cannot be defeated by joining first and being checked after.
     */
    async join(roomId: number, userId: number): Promise<Room> {
      const { me, room } = await loadForPolicy(roomId, userId);
      const already = room.members.some((m) => m.userId === userId);
      if (!already) {
        const verdict = canJoin(me, room);
        if (verdict !== 'OK') refuse(verdict);
        await db.execute(sql`
          INSERT INTO room_members (room_id, user_id, role)
          VALUES (${roomId}, ${userId}, 'member')
          ON CONFLICT (room_id, user_id) DO UPDATE SET left_at = NULL`);
      }
      const joined = await roomFor(roomId, userId);
      if (joined === null) throw new NotFoundError(`no such room ${String(roomId)}`);
      return joined;
    },

    /**
     * One `INSERT`, idempotent on `client_msg_id`. `seq`, `prev_hash` and `hash` come back from
     * the chain trigger; nothing here computes them.
     */
    async send(input: SendInput): Promise<Message> {
      if (input.body.length > MAX_BODY_CHARS) {
        throw new BadRequestError(`body exceeds ${String(MAX_BODY_CHARS)} characters`, {
          field: 'body',
          length: input.body.length,
        });
      }
      const attachments = parseAttachments(input.attachments);
      const structured = parseStructured(input.structured);

      const { me, room } = await loadForPolicy(input.roomId, input.senderUserId);
      const verdict = canMessage(me, null, room);
      if (verdict !== 'OK') refuse(verdict);

      const existing = await storedMessage(input.roomId, input.clientMsgId);
      if (existing !== null) return existing;

      const sentAt = new Date(deps.clock.now()).toISOString();
      // `ON CONFLICT DO NOTHING` rather than catching 23505: a unique violation would abort the
      // caller's transaction, and every read after it — including the one that would fetch the
      // winning row — would fail with 25P02. The conflict is expected here (it IS the retry), so
      // it is handled where it happens instead of being raised and recovered from.
      const inserted = await db.execute(sql`
        INSERT INTO messages (room_id, seq, sender_user_id, sender_firm_id, sent_at, body,
                              attachments, structured, client_msg_id, hash, trace_id)
        VALUES (${input.roomId}, 0, ${input.senderUserId}, ${me.firmId}, ${sentAt}::timestamptz,
                ${input.body}, ${JSON.stringify(attachments)}::jsonb,
                ${structured === null ? null : JSON.stringify(structured)}::jsonb,
                ${input.clientMsgId}::uuid, '\\x'::bytea,
                ${input.traceId ?? null}::uuid)
        ON CONFLICT (room_id, client_msg_id) DO NOTHING
        RETURNING message_id::text AS message_id`);
      const row = asRows<{ message_id: string }>(inserted)[0];

      const message = await storedMessage(input.roomId, input.clientMsgId);
      if (message === null) throw new Error('messaging: stored message is not readable');
      // The concurrent retry lost the race; the winner's row is the answer for both callers, and
      // it is not this call's message to announce or to scan a second time.
      if (row === undefined) return message;
      const messageId = Number(row.message_id);

      if (deps.surveillance !== undefined) {
        await inSavepoint(
          `sp_surveillance_${String(messageId)}`,
          () =>
            deps.surveillance?.scanMessage({
              messageId,
              firmId: me.firmId,
              body: input.body,
            }) ?? Promise.resolve(),
          `messaging: surveillance scan of message ${String(messageId)}`,
        );
      }
      try {
        deps.deliver?.(input.roomId, message);
      } catch (err) {
        report(err, `messaging: live delivery of message ${String(messageId)}`);
      }
      return message;
    },

    async history(roomId: number, q: HistoryQuery): Promise<HistoryPage> {
      const limit = Math.min(Math.max(q.limit ?? DEFAULT_HISTORY_LIMIT, 1), MAX_HISTORY_LIMIT);
      const before = q.before ?? null;
      const after = q.after ?? null;

      // `after` reads forward from a cursor (catching up); everything else reads the newest
      // window at or below `before`. Both are keyset reads on the unique (room_id, seq) index.
      const result = await db.execute(sql`
        SELECT * FROM (
          SELECT m.message_id::text AS message_id, m.room_id::text AS room_id, m.seq::text AS seq,
                 m.sender_user_id::text AS sender_user_id,
                 m.sender_firm_id::text AS sender_firm_id, u.display_name AS sender_display,
                 to_char(m.sent_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS sent_at,
                 m.body, m.attachments, m.structured, m.client_msg_id::text AS client_msg_id,
                 encode(m.prev_hash, 'hex') AS prev_hash, encode(m.hash, 'hex') AS hash,
                 m.trace_id::text AS trace_id
            FROM messages m JOIN users u ON u.user_id = m.sender_user_id
           WHERE m.room_id = ${roomId}
             AND (${before}::bigint IS NULL OR m.seq < ${before}::bigint)
             AND (${after}::bigint IS NULL OR m.seq > ${after}::bigint)
           ORDER BY CASE WHEN ${after}::bigint IS NULL THEN -m.seq ELSE m.seq END
           LIMIT ${limit}
        ) page ORDER BY (page.seq)::bigint`);
      const items = asRows<MessageRow>(result).map(toMessage);

      const oldest = items[0];
      if (oldest === undefined) return { items, nextCursor: null };
      const more = await db.execute(sql`
        SELECT 1 AS present FROM messages
         WHERE room_id = ${roomId} AND seq < ${oldest.seq} LIMIT 1`);
      return {
        items,
        nextCursor: asRows<{ present: number }>(more).length > 0 ? String(oldest.seq) : null,
      };
    },

    /**
     * MSG-02. Three independent checks over the room, in `seq` order: contiguity, linkage, and
     * the digest itself — recomputed by Postgres with the trigger's own expression, so a
     * difference means the stored bytes changed, not that two implementations disagree.
     */
    async verifyChain(roomId: number): Promise<ChainVerdict> {
      const result = await db.execute(sql`
        SELECT seq::text AS seq, encode(hash, 'hex') AS hash,
               encode(prev_hash, 'hex') AS prev_hash,
               encode(${sql.raw(CHAIN_DIGEST)}, 'hex') AS expected
          FROM messages WHERE room_id = ${roomId} ORDER BY seq`);
      const rows = asRows<ChainRow>(result);

      // The anchor, read before the rows are walked. `rooms.last_seq` / `rooms.last_hash` are
      // maintained by the chain trigger and never decrease, so they are the one statement about
      // this room that a rewrite of `messages` cannot restate.
      const anchorResult = await db.execute(sql`
        SELECT last_seq::text AS last_seq, encode(last_hash, 'hex') AS last_hash
          FROM rooms WHERE room_id = ${roomId}`);
      const anchorRow = asRows<{ last_seq: string; last_hash: string | null }>(anchorResult)[0];
      if (anchorRow === undefined) throw new NotFoundError(`no such room ${String(roomId)}`);
      const anchorSeq = Number(anchorRow.last_seq);
      const anchorHash = anchorRow.last_hash;

      let previousHash: string | null = null;
      let expectedSeq = 1;
      for (const row of rows) {
        const seq = Number(row.seq);
        if (seq !== expectedSeq) {
          return {
            ok: false,
            firstBadSeq: seq,
            detail: `seq ${String(seq)} follows ${String(expectedSeq - 1)}: the chain skips ${String(expectedSeq)}`,
            checked: expectedSeq - 1,
          };
        }
        if ((row.prev_hash ?? null) !== previousHash) {
          return {
            ok: false,
            firstBadSeq: seq,
            detail: `seq ${String(seq)} does not link to seq ${String(seq - 1)}`,
            checked: expectedSeq - 1,
          };
        }
        if (row.hash !== row.expected) {
          return {
            ok: false,
            firstBadSeq: seq,
            detail: `seq ${String(seq)} carries a hash that is not the digest of its own content`,
            checked: expectedSeq - 1,
          };
        }
        previousHash = row.hash;
        expectedSeq += 1;
      }

      // Internal consistency is now established. It proves nothing on its own: a suffix re-hashed
      // with the trigger's own expression is internally consistent, a room rewritten from seq 1 is
      // internally consistent, and a room with its last message deleted is internally consistent —
      // and that last one needs no forgery at all. Only the anchor can tell.
      const head = rows.length === 0 ? 0 : rows.length;
      if (anchorSeq > head) {
        return {
          ok: false,
          firstBadSeq: head + 1,
          detail:
            `the room is anchored at seq ${String(anchorSeq)} but holds ${String(head)} ` +
            `message${head === 1 ? '' : 's'}: seq ${String(head + 1)} onwards has been removed`,
          checked: head,
        };
      }
      if (anchorSeq > 0 && anchorHash !== null && anchorHash !== previousHash) {
        return {
          ok: false,
          firstBadSeq: anchorSeq,
          detail:
            `seq ${String(anchorSeq)} hashes to ${previousHash ?? 'nothing'} but the room is ` +
            `anchored to ${anchorHash}: the chain has been rewritten`,
          checked: rows.length,
        };
      }
      return { ok: true, checked: rows.length };
    },

    /** REG-01: the floor is refused, never clamped — a silent raise would hide a policy error. */
    async setRetentionDays(roomId: number, days: number, byUserId: number): Promise<Room> {
      const { me, room } = await loadForPolicy(roomId, byUserId);
      if (!room.members.some((m) => m.userId === byUserId)) refuse('NOT_A_MEMBER');
      const floor = Math.max(RETENTION_FLOOR_DAYS, me.firmRetentionDays);
      if (!Number.isInteger(days) || days < floor) {
        throw new BadRequestError(
          `retention_days ${String(days)} is below the ${String(floor)}-day floor (REG-01): ` +
            'message retention is never lowered below seven years',
          { field: 'retentionDays', requested: days, floorDays: floor },
        );
      }
      await db.execute(sql`
        UPDATE rooms SET retention_days = ${days} WHERE room_id = ${roomId}`);
      const updated = await roomFor(roomId, byUserId);
      if (updated === null) throw new NotFoundError(`no such room ${String(roomId)}`);
      return updated;
    },

    async markRead(roomId: number, userId: number, lastReadSeq: number): Promise<void> {
      await db.execute(sql`
        INSERT INTO message_reads (room_id, user_id, last_read_seq, updated_at)
        VALUES (${roomId}, ${userId}, ${lastReadSeq},
                ${new Date(deps.clock.now()).toISOString()}::timestamptz)
        ON CONFLICT (room_id, user_id)
        DO UPDATE SET last_read_seq = GREATEST(message_reads.last_read_seq, EXCLUDED.last_read_seq),
                      updated_at = EXCLUDED.updated_at`);
    },
  };
}
