/**
 * `functions/MSG/resolve.ts` — rooms, the archive and MSG-04 attachments
 * (FUNCTIONS_TIER1.md §MSG L1513-1790).
 *
 * MSG is the one Tier 1 screen whose payload is mostly *not* market data, and the three things it
 * does carry about market data are the reason it is a function rather than a chat widget.
 *
 * **Attachments are references, resolved under the reader (MSG-04).** What was stored is
 * `{kind, ids, params}` — never a number. This resolver turns each reference into a chip for
 * *this* viewer: the label and the `command` are the same for everybody, so a recipient can always
 * open what the sender meant, but the price beside it comes from `plant.snapshotMany` through the
 * viewer's own entitlement gate. A reader entitled to end-of-day sees `null` with `r: 'TIER_EOD'`
 * where the sender saw 330.27, with the same label and the same command. Rendering the sender's
 * number instead would leak entitled data to someone who is not entitled to it (ENTL-05), which is
 * the whole point of the requirement.
 *
 * Following §0.4 rule 2, attachment prices never call `ctx.providers.ensure`: a shared name the
 * plant has not polled is *pending* (`st:'blank'`, no reason, `provIdx: -1`), not denied and not
 * fetched inline. A chat screen must not block on a provider to render a message.
 *
 * **The archive verifies itself (MSG-02).** `chainOk` comes from `messagingService.verifyChain`,
 * which recomputes the digest **in SQL** with the trigger's own expression. Recomputing it here
 * would mean re-implementing Postgres' `jsonb` text output, and the two would disagree the first
 * time a key order changed — a false `ARCHIVE_CHAIN_BROKEN` is worse than none, because it is the
 * alarm a compliance desk has to act on. §MSG step 6 asks for verification over the window; this
 * verifies the room and projects the verdict onto the window, which is a larger read and the only
 * one that cannot drift from the trigger.
 *
 * **Absence is stated.** There is no presence service in v1, so `MsgMemberView` carries no online
 * flag and `meta.unavailable` says why; federation (MSG-05) is a declared non-goal and is a
 * constant in the payload rather than a disabled control on the screen.
 */

import { sql } from 'drizzle-orm';

import { registry } from '@terminal/core';
import type { FieldId, ValueCell } from '@terminal/core';
import type {
  MsgAttachmentView,
  MsgMemberView,
  MsgMessageRow,
  MsgParams,
  MsgPayload,
  MsgPolicy,
  MsgRoomRow,
  MsgSendBlock,
  MsgStructuredView,
} from '@terminal/core/functions/manifests/MSG';

import { Attachment, type Message } from '@terminal/sdk/wire/rest/messages';

import { canMessage, messagingService, type MeView, type PartyView } from '../../messaging/service.js';
import { AppError } from '../../http/errors.js';
import type { GatedQuoteState, ResolveContext } from '../context.js';
import { cellFromState } from '../shared/cells.js';
import { rowMeta, type RowMeta } from '../QM/resolve.js';

const PX: FieldId = 'PX_LAST';
const CHG_PCT: FieldId = 'CHG_PCT_1D';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The cursor (§MSG "CSV" — pageable, PAGE FWD is older)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface MsgCursor {
  roomId: number;
  seq: number;
}

export function encodeMsgCursor(cursor: MsgCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeMsgCursor(raw: string | null): MsgCursor | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const c = parsed as { roomId?: unknown; seq?: unknown };
    if (typeof c.roomId !== 'number' || typeof c.seq !== 'number') return null;
    return { roomId: c.roomId, seq: c.seq };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The room list (§MSG resolver step 2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface MemberSql {
  userId: number;
  displayName: string;
  firmId: number;
  firmName: string;
  desk: string | null;
  role: string;
  userRole: string;
  verified: boolean;
}

interface RoomSql extends Record<string, unknown> {
  room_id: string;
  kind: string;
  name: string | null;
  scope: string;
  firm_id: string | null;
  wall_tag: string | null;
  disclaimer: string | null;
  retention_days: number;
  created_at: string;
  last_seq: string;
  last_read_seq: string;
  last_message_at: string | null;
  last_body: string | null;
  last_attachments: unknown;
  members: MemberSql[] | null;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * Every room the caller is a member of, with its membership, its counters and enough of the last
 * message to preview it — one round trip.
 *
 * RLS (`is_room_member()`) already limits `rooms` and `messages` to the caller's rooms; the join to
 * `room_members` is here for `left_at IS NULL`, which RLS does not express: a member who left keeps
 * their archived messages and loses the room from their list.
 */
async function roomRows(ctx: ResolveContext): Promise<RoomSql[]> {
  const me = ctx.user.userId;
  const res = await ctx.db.execute<RoomSql>(sql`
    SELECT r.room_id::text AS room_id, r.kind, r.name, r.scope, r.firm_id::text AS firm_id,
           r.wall_tag, r.disclaimer, r.retention_days,
           to_char(r.created_at AT TIME ZONE 'UTC', ${sql.raw(ISO)}) AS created_at,
           coalesce(last.seq, 0)::text AS last_seq,
           coalesce(mr.last_read_seq, 0)::text AS last_read_seq,
           to_char(last.sent_at AT TIME ZONE 'UTC', ${sql.raw(ISO)}) AS last_message_at,
           last.body AS last_body,
           last.attachments AS last_attachments,
           (SELECT jsonb_agg(jsonb_build_object(
                     'userId', u.user_id, 'displayName', u.display_name,
                     'firmId', u.firm_id, 'firmName', f.name, 'desk', u.desk,
                     'role', rm.role, 'userRole', u.role,
                     'verified', (u.person_verified_at IS NOT NULL))
                   ORDER BY u.display_name, u.user_id)
              FROM room_members rm
              JOIN users u ON u.user_id = rm.user_id
              JOIN firms f ON f.firm_id = u.firm_id
             WHERE rm.room_id = r.room_id AND rm.left_at IS NULL) AS members
      FROM rooms r
      JOIN room_members mine
        ON mine.room_id = r.room_id AND mine.user_id = ${me} AND mine.left_at IS NULL
      LEFT JOIN message_reads mr ON mr.room_id = r.room_id AND mr.user_id = ${me}
      LEFT JOIN LATERAL (
        SELECT m.seq, m.sent_at, m.body, m.attachments
          FROM messages m
         WHERE m.room_id = r.room_id
         ORDER BY m.seq DESC
         LIMIT 1) last ON true
     ORDER BY last.sent_at DESC NULLS LAST, r.room_id DESC`);
  return [...res.rows];
}

const ROOM_KINDS = ['dm', 'group', 'firm', 'helpdesk'] as const;
const MEMBER_ROLES = ['member', 'owner', 'supervisor'] as const;

function roomKindOf(raw: string): MsgRoomRow['kind'] {
  const hit = ROOM_KINDS.find((k) => k === raw);
  if (hit === undefined) throw new TypeError(`MSG: unknown room kind '${raw}'`);
  return hit;
}

function memberRoleOf(raw: string): MsgMemberView['role'] {
  return MEMBER_ROLES.find((r) => r === raw) ?? 'member';
}

function memberViews(rows: readonly MemberSql[], meUserId: number): MsgMemberView[] {
  return rows.map((row) => ({
    userId: row.userId,
    displayName: row.displayName,
    firmId: row.firmId,
    firmName: row.firmName,
    desk: row.desk,
    role: memberRoleOf(row.role),
    verified: row.verified,
    isSelf: row.userId === meUserId,
  }));
}

/** `Attachment[]` as the last-message preview renders them: `'[GP AAPL US Equity]'`. */
function previewChips(raw: unknown, display: ReadonlyMap<number, RowMeta>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const parsed = Attachment.safeParse(entry);
    if (!parsed.success) continue;
    out.push(`[${chipLabel(parsed.data, display)}]`);
  }
  return out;
}

const PREVIEW_CHARS = 80;

function previewOf(body: string | null, chips: readonly string[]): string | null {
  const text = [body ?? '', ...chips].filter((part) => part !== '').join(' ').trim();
  return text === '' ? null : text.slice(0, PREVIEW_CHARS);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Attachments (§MSG resolver step 7, MSG-04)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `argString({ range: '1Y' })` → `' 1Y'`: the command line the chip's GO runs. */
function argString(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'boolean') {
      if (value) parts.push(`${key.toUpperCase()}=Y`);
      continue;
    }
    if (typeof value === 'number') {
      parts.push(`${key.toUpperCase()}=${String(value)}`);
      continue;
    }
    if (typeof value !== 'string') continue;
    parts.push(`${key.toUpperCase()}=${value}`);
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

function chipLabel(attachment: Attachment, display: ReadonlyMap<number, RowMeta>): string {
  switch (attachment.kind) {
    case 'security':
      return display.get(attachment.instrumentId)?.key ?? `security #${String(attachment.instrumentId)}`;
    case 'chart': {
      const key = display.get(attachment.instrumentId)?.key ?? `security #${String(attachment.instrumentId)}`;
      const range = attachment.params.range;
      return `GP · ${key}${typeof range === 'string' && range !== '' ? ` · ${range}` : ''}`;
    }
    case 'function': {
      const code = registry.canonical(attachment.code) ?? attachment.code;
      const key = attachment.instrumentId === null ? null : display.get(attachment.instrumentId)?.key;
      return key === undefined || key === null ? code : `${code} · ${key}`;
    }
    case 'portfolio':
      return `portfolio #${String(attachment.portfolioId)}`;
    case 'watchlist':
      return `watchlist #${String(attachment.watchlistId)}`;
  }
}

interface AttachmentSources {
  instruments: ReadonlyMap<number, RowMeta>;
  watchlists: ReadonlyMap<number, string>;
  portfolios: ReadonlyMap<number, string>;
  snapshots: ReadonlyMap<string, GatedQuoteState>;
}

/**
 * One stored reference as this viewer may see it.
 *
 * `label` and `command` are viewer-independent by design (§MSG "Screen"): a recipient who is not
 * entitled to the price still gets a chip that opens the function, and hits the same denial with
 * the same reason there. Only the *numbers* are gated.
 */
function attachmentView(
  ctx: ResolveContext,
  attachment: Attachment,
  idx: number,
  sources: AttachmentSources,
): MsgAttachmentView {
  const base = {
    idx,
    kind: attachment.kind,
    instrumentId: null as number | null,
    code: null as string | null,
    params: {} as Record<string, unknown>,
    resultId: null as string | null,
    portfolioId: null as number | null,
    watchlistId: null as number | null,
    annotationIds: [] as number[],
    subject: null as string | null,
    px: null as ValueCell | null,
    chgPct: null as ValueCell | null,
  };

  const withPrice = (instrumentId: number): Pick<MsgAttachmentView, 'subject' | 'px' | 'chgPct'> => {
    const subject = ctx.plant.subjectFor(instrumentId);
    const state = sources.snapshots.get(subject);
    return {
      subject,
      px: cellFromState(ctx, state, PX, subject),
      chgPct: cellFromState(ctx, state, CHG_PCT, subject),
    };
  };

  switch (attachment.kind) {
    case 'security': {
      const meta = sources.instruments.get(attachment.instrumentId);
      if (meta === undefined) {
        return {
          ...base,
          instrumentId: attachment.instrumentId,
          label: `security #${String(attachment.instrumentId)}`,
          command: null,
          resolvable: false,
          reason: 'NOT_IN_UNIVERSE',
        };
      }
      return {
        ...base,
        ...withPrice(attachment.instrumentId),
        instrumentId: attachment.instrumentId,
        label: meta.key,
        command: `${meta.key} DES`,
        resolvable: true,
        reason: 'OK',
      };
    }
    case 'chart': {
      const meta = sources.instruments.get(attachment.instrumentId);
      if (meta === undefined) {
        return {
          ...base,
          instrumentId: attachment.instrumentId,
          params: attachment.params,
          annotationIds: [...attachment.annotationIds],
          label: `GP · security #${String(attachment.instrumentId)}`,
          command: null,
          resolvable: false,
          reason: 'NOT_IN_UNIVERSE',
        };
      }
      return {
        ...base,
        ...withPrice(attachment.instrumentId),
        instrumentId: attachment.instrumentId,
        code: 'GP',
        params: attachment.params,
        annotationIds: [...attachment.annotationIds],
        label: chipLabel(attachment, sources.instruments),
        command: `${meta.key} GP${argString(attachment.params)}`,
        resolvable: true,
        reason: 'OK',
      };
    }
    case 'function': {
      const code = registry.canonical(attachment.code);
      const meta =
        attachment.instrumentId === null ? undefined : sources.instruments.get(attachment.instrumentId);
      if (code === undefined) {
        return {
          ...base,
          instrumentId: attachment.instrumentId,
          code: attachment.code,
          params: attachment.params,
          resultId: attachment.resultId ?? null,
          label: attachment.code,
          command: null,
          resolvable: false,
          reason: 'FUNCTION_NOT_FOUND',
        };
      }
      const prefix = meta === undefined ? '' : `${meta.key} `;
      return {
        ...base,
        ...(meta === undefined ? {} : withPrice(meta.instrumentId)),
        instrumentId: attachment.instrumentId,
        code,
        params: attachment.params,
        resultId: attachment.resultId ?? null,
        label: meta === undefined ? code : `${code} · ${meta.key}`,
        command: `${prefix}${code}${argString(attachment.params)}`,
        resolvable: true,
        reason: 'OK',
      };
    }
    case 'portfolio': {
      const name = sources.portfolios.get(attachment.portfolioId);
      if (name === undefined) {
        return {
          ...base,
          portfolioId: attachment.portfolioId,
          label: `portfolio #${String(attachment.portfolioId)}`,
          command: null,
          resolvable: false,
          reason: 'NOT_SHARED_WITH_YOU',
        };
      }
      return {
        ...base,
        portfolioId: attachment.portfolioId,
        label: name,
        command: `PORT ${String(attachment.portfolioId)}`,
        resolvable: true,
        reason: 'OK',
      };
    }
    case 'watchlist': {
      const name = sources.watchlists.get(attachment.watchlistId);
      if (name === undefined) {
        return {
          ...base,
          watchlistId: attachment.watchlistId,
          label: `watchlist #${String(attachment.watchlistId)}`,
          command: null,
          resolvable: false,
          reason: 'NOT_SHARED_WITH_YOU',
        };
      }
      return {
        ...base,
        watchlistId: attachment.watchlistId,
        label: name,
        command: `W ${String(attachment.watchlistId)}`,
        resolvable: true,
        reason: 'OK',
      };
    }
  }
}

function structuredView(
  ctx: ResolveContext,
  raw: Message['structured'],
  sources: AttachmentSources,
): MsgStructuredView | null {
  if (raw === null) return null;
  const meta = sources.instruments.get(raw.instrumentId);
  const subject = meta === undefined ? null : ctx.plant.subjectFor(raw.instrumentId);
  return {
    type: raw.type,
    side: raw.side,
    instrumentId: raw.instrumentId,
    display: meta?.key ?? `security #${String(raw.instrumentId)}`,
    qty: raw.qty,
    price: raw.price,
    px: subject === null ? null : cellFromState(ctx, sources.snapshots.get(subject), PX, subject),
    subject,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reference lookups
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface NamedSql extends Record<string, unknown> {
  id: string;
  name: string;
}

/** RLS decides visibility; a row that does not come back is one this viewer may not read. */
async function watchlistNames(
  ctx: ResolveContext,
  ids: readonly number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const res = await ctx.db.execute<NamedSql>(sql`
    SELECT watchlist_id::text AS id, name FROM watchlists
     WHERE watchlist_id = ANY(${sql.param(ids.map((id) => String(id)))}::bigint[])`);
  for (const row of res.rows) out.set(Number(row.id), row.name);
  return out;
}

async function portfolioNames(
  ctx: ResolveContext,
  ids: readonly number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const res = await ctx.db.execute<NamedSql>(sql`
    SELECT portfolio_id::text AS id, name FROM portfolios
     WHERE portfolio_id = ANY(${sql.param(ids.map((id) => String(id)))}::bigint[])`);
  for (const row of res.rows) out.set(Number(row.id), row.name);
  return out;
}

interface DirectorySql extends Record<string, unknown> {
  user_id: string;
  display_name: string;
  firm_id: string;
  firm_name: string;
  desk: string | null;
  role: string;
  verified: boolean;
}

const DIRECTORY_LIMIT = 25;

/**
 * MSG-01's counterparty directory: verified, active users, ranked exact email → display-name
 * prefix → desk, own firm first. Cross-firm by design — a name that cannot be found cannot be
 * messaged, and MSG-03 decides separately whether they may be.
 */
async function directoryMatches(ctx: ResolveContext, q: string): Promise<DirectorySql[]> {
  const like = `%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
  const prefix = `${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
  const res = await ctx.db.execute<DirectorySql>(sql`
    SELECT u.user_id::text AS user_id, u.display_name, u.firm_id::text AS firm_id,
           f.name AS firm_name, u.desk, u.role,
           (u.person_verified_at IS NOT NULL) AS verified
      FROM users u JOIN firms f ON f.firm_id = u.firm_id
     WHERE u.status = 'active'
       AND u.anonymised_at IS NULL
       AND (lower(u.email) = lower(${q})
            OR u.display_name ILIKE ${prefix} ESCAPE '\\'
            OR u.display_name ILIKE ${like} ESCAPE '\\'
            OR u.desk ILIKE ${like} ESCAPE '\\')
     ORDER BY (lower(u.email) = lower(${q})) DESC,
              (u.display_name ILIKE ${prefix} ESCAPE '\\') DESC,
              (u.firm_id = ${ctx.user.firmId}::bigint) DESC,
              u.display_name, u.user_id
     LIMIT ${DIRECTORY_LIMIT}`);
  return [...res.rows];
}

interface HoldSql extends Record<string, unknown> {
  present: number;
}

async function legalHoldActive(ctx: ResolveContext, roomId: number | null): Promise<boolean> {
  const res = await ctx.db.execute<HoldSql>(sql`
    SELECT 1 AS present
      FROM legal_holds
     WHERE firm_id = ${ctx.user.firmId}
       AND released_at IS NULL
       AND (scope->'userIds' @> ${JSON.stringify([ctx.user.userId])}::jsonb
            OR (${roomId}::bigint IS NOT NULL
                AND scope->'roomIds' @> ${JSON.stringify(roomId === null ? [] : [roomId])}::jsonb))
     LIMIT 1`);
  return res.rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: MsgParams): Promise<MsgPayload> {
  const service = messagingService({ db: ctx.db, clock: ctx.clock });

  // 1 — the caller, with their firm's policy and retention floor.
  const me: MeView | null = await service.party(ctx.user.userId);
  if (me === null) {
    throw new AppError('NOT_FOUND', `MSG: user ${String(ctx.user.userId)} has no directory record`);
  }

  // 2 — the rooms, before any filter (`totals.rooms` counts membership, not the filtered view).
  const rows = await roomRows(ctx);
  const totalRooms = rows.length;

  // 3-4 — which room is open, and the directory when one was asked for by name.
  const wantedId = params.roomId;
  let activeRow = wantedId === null ? undefined : rows.find((r) => Number(r.room_id) === wantedId);
  if (wantedId !== null && activeRow === undefined) {
    ctx.unavailable.add({
      field: 'active',
      reason: 'NOT_APPLICABLE',
      detail: `ROOM_NOT_A_MEMBER: you are not a member of room ${String(wantedId)}`,
    });
  }

  let view = params.view;
  const directoryRows =
    params.to !== null && params.to.trim() !== ''
      ? await directoryMatches(ctx, params.to.trim())
      : view === 'directory'
        ? await directoryMatches(ctx, params.filter)
        : [];

  if (activeRow === undefined && params.to !== null && params.to.trim() !== '') {
    const match = directoryRows[0];
    const only = directoryRows.length === 1 && match !== undefined;
    const dm = !only
      ? undefined
      : rows.find((row) => {
          if (roomKindOf(row.kind) !== 'dm') return false;
          const ids = (row.members ?? []).map((m) => m.userId).sort((a, b) => a - b);
          const want = [ctx.user.userId, Number(match.user_id)].sort((a, b) => a - b);
          return ids.length === want.length && ids.every((id, i) => id === want[i]);
        });
    if (dm !== undefined) activeRow = dm;
    // No existing dm: the room is created on first send from the composer, never by a read.
    else view = 'directory';
  }
  if (activeRow === undefined && wantedId === null && params.to === null) activeRow = rows[0];

  // The attachment references of the whole payload, resolved once.
  const activeRoomId = activeRow === undefined ? null : Number(activeRow.room_id);
  const cursor = decodeMsgCursor(ctx.page?.cursor ?? null);
  const history =
    activeRoomId === null
      ? { items: [] as Message[], nextCursor: null }
      : await service.history(activeRoomId, {
          limit: params.limit,
          ...(cursor !== null && cursor.roomId === activeRoomId ? { before: cursor.seq } : {}),
        });

  const attachments: Attachment[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.last_attachments)) continue;
    for (const entry of row.last_attachments) {
      const parsed = Attachment.safeParse(entry);
      if (parsed.success) attachments.push(parsed.data);
    }
  }
  for (const message of history.items) attachments.push(...message.attachments);

  const instrumentIds = new Set<number>();
  const watchlistIds = new Set<number>();
  const portfolioIds = new Set<number>();
  for (const attachment of attachments) {
    if (attachment.kind === 'security' || attachment.kind === 'chart') {
      instrumentIds.add(attachment.instrumentId);
    } else if (attachment.kind === 'function' && attachment.instrumentId !== null) {
      instrumentIds.add(attachment.instrumentId);
    } else if (attachment.kind === 'watchlist') watchlistIds.add(attachment.watchlistId);
    else if (attachment.kind === 'portfolio') portfolioIds.add(attachment.portfolioId);
  }
  for (const message of history.items) {
    if (message.structured !== null) instrumentIds.add(message.structured.instrumentId);
  }

  const instruments = await rowMeta(ctx, [...instrumentIds]);
  const subjects = [...instruments.keys()].map((id) => ctx.plant.subjectFor(id));
  // §0.4 rule 2: the scheduler polls, the resolver does not fetch. A shared name with no recorded
  // quote renders pending, which is the truth, rather than blocking a chat screen on a provider.
  ctx.plant.ensureHot(subjects);
  const sources: AttachmentSources = {
    instruments,
    watchlists: await watchlistNames(ctx, [...watchlistIds]),
    portfolios: await portfolioNames(ctx, [...portfolioIds]),
    snapshots: ctx.plant.snapshotMany(subjects),
  };

  // 2 (continued) — project, filter and sort the room list.
  const filter = params.filter.trim().toLowerCase();
  const roomViews: MsgRoomRow[] = [];
  let unreadTotal = 0;
  for (const row of rows) {
    const members = memberViews(row.members ?? [], ctx.user.userId);
    const kind = roomKindOf(row.kind);
    const other = members.find((m) => !m.isSelf);
    const name = row.name ?? (kind === 'dm' ? (other?.displayName ?? 'Direct message') : `Room ${row.room_id}`);
    const lastSeq = Number(row.last_seq);
    const lastReadSeq = Number(row.last_read_seq);
    const unread = Math.max(0, lastSeq - lastReadSeq);
    unreadTotal += unread;

    if (params.unreadOnly && unread === 0) continue;
    if (
      filter !== '' &&
      !name.toLowerCase().includes(filter) &&
      !members.some((m) => m.displayName.toLowerCase().includes(filter))
    ) {
      continue;
    }

    roomViews.push({
      roomId: Number(row.room_id),
      kind,
      name,
      scope: row.scope === 'external' ? 'external' : 'internal',
      firmId: row.firm_id === null ? null : Number(row.firm_id),
      wallTag: row.wall_tag,
      disclaimer: row.disclaimer,
      retentionDays: row.retention_days,
      createdAt: row.created_at,
      members,
      lastSeq,
      lastReadSeq,
      unread,
      lastMessageAt: row.last_message_at,
      lastMessagePreview: previewOf(row.last_body, previewChips(row.last_attachments, instruments)),
      subject: `room:${row.room_id}`,
    });
  }

  if (rows.length === 0) {
    ctx.unavailable.add({
      field: 'active',
      reason: 'NOT_APPLICABLE',
      detail: 'NO_ROOMS: you are not a member of any room — Alt+N to start one',
    });
  }

  // 5-8 — the open room: its window, its chain verdict and its send policy.
  let active: MsgPayload['active'] = null;
  if (activeRow !== undefined && activeRoomId !== null) {
    const roomView =
      roomViews.find((r) => r.roomId === activeRoomId) ??
      ({
        roomId: activeRoomId,
        kind: roomKindOf(activeRow.kind),
        name: activeRow.name ?? `Room ${activeRow.room_id}`,
        scope: activeRow.scope === 'external' ? 'external' : 'internal',
        firmId: activeRow.firm_id === null ? null : Number(activeRow.firm_id),
        wallTag: activeRow.wall_tag,
        disclaimer: activeRow.disclaimer,
        retentionDays: activeRow.retention_days,
        createdAt: activeRow.created_at,
        members: memberViews(activeRow.members ?? [], ctx.user.userId),
        lastSeq: Number(activeRow.last_seq),
        lastReadSeq: Number(activeRow.last_read_seq),
        unread: Math.max(0, Number(activeRow.last_seq) - Number(activeRow.last_read_seq)),
        lastMessageAt: activeRow.last_message_at,
        lastMessagePreview: previewOf(
          activeRow.last_body,
          previewChips(activeRow.last_attachments, instruments),
        ),
        subject: `room:${activeRow.room_id}`,
      } satisfies MsgRoomRow);

    const chain = await service.verifyChain(activeRoomId);
    if (!chain.ok) {
      ctx.unavailable.add({
        field: 'active.messages',
        reason: 'NOT_APPLICABLE',
        detail:
          `ARCHIVE_CHAIN_BROKEN: hash chain breaks at seq ${String(chain.firstBadSeq ?? 0)}; ` +
          'produce the room through /admin/export/messages',
      });
    }

    const messages: MsgMessageRow[] = history.items.map((message) => {
      const sender = roomView.members.find((m) => m.userId === message.senderUserId);
      return {
        messageId: message.messageId,
        roomId: message.roomId,
        seq: message.seq,
        senderUserId: message.senderUserId,
        senderFirmId: message.senderFirmId,
        senderDisplay: message.senderDisplay,
        senderFirmName: sender?.firmName ?? '',
        senderDesk: sender?.desk ?? null,
        isOwn: message.senderUserId === ctx.user.userId,
        sentAt: message.sentAt,
        body: message.body,
        attachments: message.attachments.map((attachment, idx) =>
          attachmentView(ctx, attachment, idx, sources),
        ),
        structured: structuredView(ctx, message.structured, sources),
        clientMsgId: message.clientMsgId,
        prevHash: message.prevHash,
        hash: message.hash,
        chainOk: chain.ok || message.seq < (chain.firstBadSeq ?? 0),
        unread: message.seq > roomView.lastReadSeq,
      };
    });

    const blocked: MsgSendBlock = await service.sendBlockedReason(activeRoomId, ctx.user.userId);
    if (blocked !== 'OK') {
      ctx.unavailable.add({
        field: 'active.canSend',
        reason: 'NOT_APPLICABLE',
        detail: `${blocked}: ${policyDetail(blocked)}`,
      });
    }
    for (const message of messages) {
      for (const attachment of message.attachments) {
        if (attachment.reason === 'OK') continue;
        ctx.unavailable.add({
          field: `attachments[${String(attachment.idx)}]`,
          reason: attachment.reason === 'NOT_ENTITLED' ? 'NOT_LICENSED' : 'NOT_APPLICABLE',
          detail: `${attachment.reason}: ${attachment.label}`,
        });
      }
      if (message.structured !== null) {
        ctx.unavailable.add({
          field: 'structured',
          reason: 'NOT_APPLICABLE',
          detail:
            'IOI_DISPLAY_ONLY: structured messages are displayed, never routed — execution is out ' +
            'of scope (MSG-06, BRIEF §1)',
        });
      }
    }

    const newest = messages[messages.length - 1];
    const oldest = messages[0];
    active = {
      room: roomView,
      messages,
      canSend: blocked === 'OK',
      sendBlockedReason: blocked,
      olderCursor:
        history.nextCursor === null || oldest === undefined
          ? null
          : encodeMsgCursor({ roomId: activeRoomId, seq: oldest.seq }),
      newerCursor:
        newest === undefined || newest.seq >= roomView.lastSeq
          ? null
          : encodeMsgCursor({ roomId: activeRoomId, seq: newest.seq }),
    };

    const newestSeq = newest?.seq ?? roomView.lastSeq;
    ctx.page?.set({
      index: Math.max(0, Math.ceil((roomView.lastSeq - newestSeq) / params.limit)),
      count: Math.max(1, Math.ceil(roomView.lastSeq / params.limit)),
      cursor: active.olderCursor,
    });
  }

  // MSG-01: every directory entry carries the policy verdict for messaging that person.
  const directory = directoryRows.map((row) => {
    const party: PartyView = {
      userId: Number(row.user_id),
      firmId: Number(row.firm_id),
      firmName: row.firm_name,
      displayName: row.display_name,
      desk: row.desk,
      role: row.role as PartyView['role'],
    };
    const verdict = canMessage(me, party, null);
    return {
      userId: party.userId,
      displayName: party.displayName,
      firmId: party.firmId,
      firmName: party.firmName,
      desk: party.desk,
      role: 'member' as const,
      verified: row.verified,
      isSelf: party.userId === ctx.user.userId,
      canMessage: verdict === 'OK',
      blockedReason: verdict,
    };
  });

  // 9 — policy. REG-01's floor is the firm's; a room may raise it and never lower it.
  const policy: MsgPolicy = {
    firmName: me.firmName,
    retentionDays:
      active === null
        ? me.firmRetentionDays
        : Math.max(me.firmRetentionDays, active.room.retentionDays),
    disclaimer: active?.room.disclaimer ?? me.firmPolicy.disclaimer,
    permittedCounterpartyFirms: [...me.firmPolicy.permittedCounterpartyFirms],
    ethicalWalls: me.firmPolicy.ethicalWalls.map((wall) => ({ ...wall })),
    archived: true,
    surveillance: true,
    legalHoldActive: await legalHoldActive(ctx, activeRoomId),
    federation: 'NOT_IN_SCOPE_V1',
  };

  // Absence, stated once per run rather than per member (§MSG "Unavailable and reason codes").
  ctx.unavailable.add({
    field: 'members[].presence',
    reason: 'NO_SOURCE',
    detail:
      'PRESENCE_NOT_AVAILABLE: no presence service in v1; the room list shows last message time ' +
      'instead of who is online',
  });
  ctx.unavailable.add({
    field: 'federation',
    reason: 'NOT_APPLICABLE',
    detail:
      'FEDERATION_NOT_IN_SCOPE_V1: MSG-05 (Symphony, Teams, ICE Chat) is an explicit v1 non-goal ' +
      '(BRIEF §1)',
  });

  return {
    variant: 'default',
    view,
    me: {
      userId: me.userId,
      displayName: me.displayName,
      firmId: me.firmId,
      firmName: me.firmName,
      desk: me.desk,
      role: me.role,
    },
    rooms: roomViews,
    active,
    directory,
    policy,
    totals: { rooms: totalRooms, unread: unreadTotal, directoryMatches: directory.length },
  };
}

/** The sentence §MSG's reason table pairs with each block code. */
function policyDetail(reason: Exclude<MsgSendBlock, 'OK'>): string {
  switch (reason) {
    case 'MESSAGE_POLICY_BLOCKED':
      return 'that firm is not a permitted counterparty';
    case 'ETHICAL_WALL':
      return 'the desks in this room are walled';
    case 'EXTERNAL_NOT_PERMITTED':
      return 'this room is external and your firm policy does not allow it';
    case 'NOT_A_MEMBER':
      return 'you are not a member of this room';
  }
}
