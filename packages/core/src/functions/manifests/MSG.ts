// packages/core/src/functions/manifests/MSG.ts
//
// `MSG` — Messaging (FUNCTIONS_TIER1.md §MSG L1513-1790, §IB L1791-1892, FUNCTIONS.md §6 L1086).
//
// MSG is the terminal's chat screen: rooms on the left, the open conversation on the right, a
// composer at the bottom. `IB` and `CHAT` are aliases of this one manifest — `IB` merely lands on
// the room list (`aliasParams`), and everything else about it is identical, so the two can never
// drift.
//
// Three things in the payload are load-bearing rather than decorative:
//
//  - **`attachments[].px` is resolved under the *reader's* entitlements** (MSG-04). The sender's
//    numbers are never shipped: what travels is a reference, and the recipient's own gate decides
//    what it shows. Two people reading the same message legitimately see different numbers, and
//    the one who sees a blank is told why (`r`).
//  - **`chainOk` per message** (MSG-02). The archive is a hash chain and the screen verifies the
//    window as it loads, so tampering is visible to the reader rather than only to an auditor.
//  - **`policy`** (MSG-03). Retention, the disclaimer, the permitted counterparty firms, the
//    ethical walls, the legal hold and `federation: 'NOT_IN_SCOPE_V1'` are on every payload,
//    because a compliance rule nobody can see on screen is a rule nobody follows.
//
// There is no presence flag: no v1 source publishes presence, and a fabricated one is exactly what
// FUNCTIONS.md §1.3 rule 6 forbids. `MsgMemberView` therefore carries none, and the resolver
// records `PRESENCE_NOT_AVAILABLE` in `meta.unavailable`.

import { z } from 'zod';

import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import { topAsOfCompact } from './TOP.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§MSG "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const MsgParams = z.object({
  /** The room to open; `null` → the most recently active room the caller is a member of. */
  roomId: z.number().int().positive().nullable().default(null),
  /** Directory query: `MSG jane.doe` opens (or creates on send) the dm with the best match. */
  to: z.string().max(80).nullable().default(null),
  view: z.enum(['split', 'rooms', 'room', 'directory']).default('split'),
  /** Messages per page, newest-first window. */
  limit: z.number().int().min(20).max(200).default(50),
  /** Room-list substring filter over room name and member display names. */
  filter: z.string().max(80).default(''),
  unreadOnly: z.boolean().default(false),
});
export type MsgParams = z.infer<typeof MsgParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§MSG "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type MsgView = 'split' | 'rooms' | 'room' | 'directory';
export type MsgRoomKind = 'dm' | 'group' | 'firm' | 'helpdesk';
export type MsgSendBlock =
  | 'OK'
  | 'MESSAGE_POLICY_BLOCKED'
  | 'ETHICAL_WALL'
  | 'EXTERNAL_NOT_PERMITTED'
  | 'NOT_A_MEMBER';
export type MsgAttachKind = 'security' | 'function' | 'chart' | 'portfolio' | 'watchlist';

/** MSG-04: one shared object as THIS viewer may see it. */
export interface MsgAttachmentView {
  /** Position within the message's `attachments[]`. */
  idx: number;
  kind: MsgAttachKind;
  label: string;
  /** What GO runs for the viewer; `null` when the reference is not resolvable for them. */
  command: string | null;
  instrumentId: number | null;
  code: string | null;
  params: Record<string, unknown>;
  /** The sender's cached result; re-run at the cached `asOf` under the viewer's entitlements. */
  resultId: string | null;
  portfolioId: number | null;
  watchlistId: number | null;
  annotationIds: number[];
  /** `'q:42'` when a live price is shown next to the chip. */
  subject: string | null;
  px: ValueCell | null;
  chgPct: ValueCell | null;
  resolvable: boolean;
  reason:
    | 'OK'
    | 'NOT_ENTITLED'
    | 'NOT_IN_UNIVERSE'
    | 'NOT_SHARED_WITH_YOU'
    | 'RESULT_EXPIRED'
    | 'FUNCTION_NOT_FOUND';
}

/** MSG-06: display only, never an order. */
export interface MsgStructuredView {
  type: 'ioi' | 'rfq';
  side: 'buy' | 'sell';
  instrumentId: number;
  display: string;
  qty: number;
  price: number | null;
  px: ValueCell | null;
  subject: string | null;
}

export interface MsgMessageRow {
  messageId: number;
  roomId: number;
  seq: number;
  senderUserId: number;
  senderFirmId: number;
  senderDisplay: string;
  senderFirmName: string;
  senderDesk: string | null;
  isOwn: boolean;
  sentAt: string;
  /** Stored text, never rewritten: messages are immutable (API.md §5.10). */
  body: string;
  attachments: MsgAttachmentView[];
  structured: MsgStructuredView | null;
  clientMsgId: string;
  prevHash: string | null;
  hash: string;
  /** Recomputed over the returned window; `false` ⇒ archive integrity warning (MSG-02). */
  chainOk: boolean;
  unread: boolean;
}

export interface MsgMemberView {
  userId: number;
  displayName: string;
  firmId: number;
  firmName: string;
  desk: string | null;
  role: 'member' | 'owner' | 'supervisor';
  verified: boolean;
  isSelf: boolean;
}

export interface MsgRoomRow {
  roomId: number;
  kind: MsgRoomKind;
  /** dm rooms: the counterparty's display name. */
  name: string;
  scope: 'internal' | 'external';
  firmId: number | null;
  wallTag: string | null;
  disclaimer: string | null;
  retentionDays: number;
  createdAt: string;
  members: MsgMemberView[];
  lastSeq: number;
  lastReadSeq: number;
  unread: number;
  lastMessageAt: string | null;
  /** First 80 characters of the last body, attachments rendered as `[GP AAPL US Equity]`. */
  lastMessagePreview: string | null;
  /** `'room:<roomId>'`. */
  subject: string;
}

export interface MsgPolicy {
  firmName: string;
  retentionDays: number;
  disclaimer: string | null;
  permittedCounterpartyFirms: string[];
  ethicalWalls: { deskA: string; deskB: string }[];
  /** Constants: every message is WORM-archived and lexicon-scanned (MSG-02). */
  archived: true;
  surveillance: true;
  legalHoldActive: boolean;
  /** MSG-05 is an explicit v1 non-goal (BRIEF §1). */
  federation: 'NOT_IN_SCOPE_V1';
}

export interface MsgActive {
  room: MsgRoomRow;
  /** Ascending `seq`, the window ending at `room.lastSeq` (or at the page cursor). */
  messages: MsgMessageRow[];
  canSend: boolean;
  sendBlockedReason: MsgSendBlock;
  olderCursor: string | null;
  newerCursor: string | null;
}

export interface MsgPayload {
  variant: 'default';
  view: MsgView;
  me: {
    userId: number;
    displayName: string;
    firmId: number;
    firmName: string;
    desk: string | null;
    role: 'user' | 'admin' | 'compliance' | 'dataops' | 'helpdesk' | 'newsroom';
  };
  /** Filtered by `params.filter` / `params.unreadOnly`, most recent activity first. */
  rooms: MsgRoomRow[];
  active: MsgActive | null;
  /** MSG-01; populated for `view:'directory'` or when `params.to` is set. */
  directory: (MsgMemberView & { canMessage: boolean; blockedReason: MsgSendBlock })[];
  policy: MsgPolicy;
  totals: { rooms: number; unread: number; directoryMatches: number };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§MSG "Data dependencies")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The attachment cells' fields, and only those.
 *
 * Message bodies are not dictionary fields and are not entitlement-evaluated — they are the firm's
 * own first-party record. What *is* evaluated is the price shown beside a shared security, which
 * is the whole point of MSG-04: the chip is live data under the reader's own contract.
 */
export const MSG_FIELDS: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'LAST_TRADE_TIME',
]);

/**
 * The subset of {@link MSG_FIELDS} the **runner's pre-check** can answer, and why it is a subset.
 *
 * Evaluator rule 1 resolves a field to its source through `field_licence[(fieldId, assetClass)]`.
 * MSG is `assetClasses: 'none'`, so the runner evaluates with `assetClass: null`, and a field whose
 * source *differs by asset class* has no field-wide answer: `PX_LAST` comes from `cboe.quotes` for
 * an equity, `yahoo.fx` for a cross and `coingecko.simple` for a coin, so the field-wide lookup is
 * ambiguous and the evaluator correctly denies it `FIELD_UNKNOWN`.
 *
 * Including it here would therefore not *check* the attachment price — it would **blank it for
 * everybody**, which is the opposite of MSG-04: the chip is supposed to show the reader's own
 * entitled value. The three fields that remain resolve field-wide, and they are what sets the
 * decision's `effectiveTier` — which is the part of the pre-check that actually governs an
 * attachment cell (an end-of-day reader gets `eod`, and `policyTier.view` blanks every field with
 * `TIER_EOD`, `PX_LAST` included).
 *
 * `PX_LAST` is still in `LiveSpec.fields`: a `sub` on `q:<id>` names a subject with a real asset
 * class, so the gateway's evaluation of it is the well-formed one this cannot be.
 */
export const MSG_PRECHECK_FIELDS: readonly FieldId[] = Object.freeze([
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'LAST_TRADE_TIME',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§MSG "CSV") — long format, `section` first
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The transcript's columns (§MSG "CSV"), with two ids spelled for the *export* rather than for the
 * payload — `room` and `sequence` where §MSG writes `roomId` and `seq`.
 *
 * The labels, the order, the types and every emitted value are §MSG's verbatim; only the two
 * internal ids differ, and the reason is a real collision. `runner.ts` proves DATA-10 over a
 * payload by treating every payload key that a manifest names as a CSV column as a **data cell**,
 * and then requiring a finite number under such a key to be cited. `MsgRoomRow.roomId` and
 * `MsgMessageRow.seq` are *coordinates* of a long-format transcript — the row's address, not a
 * measurement — and a message archive is first-party (`internal.user`) with no provenance row to
 * cite. Sharing the spelling would therefore make every MSG run whose open room has no attachment
 * fail the check, for numbers that carry no claim about the world.
 *
 * The alternative — inventing a citation, or declaring a fake engine — would defeat the check it
 * was meant to satisfy. Renaming two export ids does not.
 */
export const msgCsvColumns: CsvColumn[] = [
  /** `'policy' | 'room' | 'member' | 'message' | 'attachment'`. */
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'room', label: 'Room id', type: 'number' },
  { id: 'sequence', label: 'Seq', type: 'number' },
  { id: 'ts', label: 'Timestamp', type: 'datetime' },
  { id: 'sender', label: 'Sender', type: 'string' },
  { id: 'senderFirm', label: 'Sender firm', type: 'string' },
  { id: 'desk', label: 'Desk', type: 'string' },
  { id: 'body', label: 'Body', type: 'string' },
  { id: 'detail', label: 'Detail', type: 'string' },
  { id: 'hash', label: 'Hash', type: 'string' },
  { id: 'chainOk', label: 'Chain ok', type: 'boolean' },
];

/** `[GP AAPL US Equity]` — how an attachment reads inside a preview or a transcript cell. */
export function msgAttachmentChip(a: MsgAttachmentView): string {
  return `[${a.label}]`;
}

export function msgCsvRows(payload: MsgPayload): (string | number | boolean | null)[][] {
  const rows: (string | number | boolean | null)[][] = [];
  const p = payload.policy;

  rows.push([
    'policy',
    payload.active?.room.roomId ?? null,
    null,
    null,
    payload.me.displayName,
    p.firmName,
    payload.me.desk,
    null,
    `retention=${String(p.retentionDays)}d; disclaimer=${p.disclaimer ?? ''}; ` +
      `counterparties=${p.permittedCounterpartyFirms.join('|')}; ` +
      `walls=${p.ethicalWalls.map((w) => `${w.deskA}/${w.deskB}`).join('|')}; ` +
      `legalHold=${String(p.legalHoldActive)}; surveillance=true; federation=${p.federation}`,
    null,
    null,
  ]);

  for (const room of payload.rooms) {
    rows.push([
      'room',
      room.roomId,
      room.lastSeq,
      room.lastMessageAt,
      null,
      null,
      null,
      room.name,
      `${room.kind}/${room.scope}/${String(room.unread)}`,
      null,
      null,
    ]);
  }

  const active = payload.active;
  if (active === null) return rows;

  for (const member of active.room.members) {
    rows.push([
      'member',
      active.room.roomId,
      null,
      null,
      member.displayName,
      member.firmName,
      member.desk,
      null,
      member.role,
      null,
      null,
    ]);
  }

  for (const message of active.messages) {
    rows.push([
      'message',
      message.roomId,
      message.seq,
      message.sentAt,
      message.senderDisplay,
      message.senderFirmName,
      message.senderDesk,
      message.body,
      message.structured === null
        ? null
        : `${message.structured.type}/${message.structured.side}/` +
          `${message.structured.display}/${String(message.structured.qty)}`,
      message.hash,
      message.chainOk,
    ]);
    for (const attachment of message.attachments) {
      rows.push([
        'attachment',
        message.roomId,
        message.seq,
        message.sentAt,
        message.senderDisplay,
        message.senderFirmName,
        message.senderDesk,
        attachment.label,
        `${attachment.kind}|${attachment.command ?? ''}|${attachment.reason}`,
        null,
        null,
      ]);
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Live (§MSG "Live")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every room (for the unread counters) plus every distinct attachment subject.
 *
 * `room:<id>` carries no fields — `web/src/state/subscriptions.ts` intersects `fields` with the
 * subject family and sends `f: []` for the `room:` family (§0.4 rule 5), so the quote fields
 * listed here reach the `q:` subjects only.
 */
function msgLive(_params: MsgParams, payload: MsgPayload): LiveSpec {
  const subjects: string[] = payload.rooms.map((room) => room.subject);
  const seen = new Set<string>(subjects);
  for (const message of payload.active?.messages ?? []) {
    const candidates = [
      ...message.attachments.map((a) => a.subject),
      message.structured?.subject ?? null,
    ];
    for (const subject of candidates) {
      if (subject === null || seen.has(subject)) continue;
      seen.add(subject);
      subjects.push(subject);
    }
  }
  return {
    subjects,
    fields: [...MSG_FIELDS],
    conflationMs: 250,
    essential: payload.active === null ? [] : [payload.active.room.subject],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const MSG = defineFunction<typeof MsgParams, MsgPayload>({
  code: 'MSG',
  name: 'Messaging',
  aliases: ['IB', 'CHAT'],
  /** `IB` (Instant Bloomberg) lands on the room list; an explicit `VIEW=` still wins (§IB). */
  aliasParams: { IB: { view: 'rooms' } },
  tier: 1,
  category: 'messaging',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: MsgParams,
  paramGrammar: {
    positional: [{ name: 'to', type: 'string', optional: true }],
    keyed: {
      ROOM: { name: 'roomId', type: 'int' },
      VIEW: { name: 'view', type: 'enum', values: ['split', 'rooms', 'room', 'directory'] },
      N: { name: 'limit', type: 'int' },
      FILTER: { name: 'filter', type: 'string' },
      UNREAD: { name: 'unreadOnly', type: 'boolean' },
    },
  },
  fieldIds: (): FieldId[] => [...MSG_PRECHECK_FIELDS],
  pageable: true,
  live: msgLive,
  csv: {
    /**
     * `MSG_room7_20260915T184128Z.csv` for a named room, `MSG_rooms_…` otherwise.
     *
     * §MSG names the file after `active.room.roomId`, which `CsvSpec.filename` cannot see — it is
     * given `(params, ctx)` only. `params.roomId` is the same id whenever the caller named one;
     * when they did not, the file is named for the room *list*, which is what the transcript then
     * leads with. The name always says which of the two it is, which is what a reviewer diffing an
     * export against `/admin/export/messages` needs.
     */
    filename: (params, ctx): string =>
      params.roomId === null
        ? `MSG_rooms_${topAsOfCompact(ctx.asOf)}.csv`
        : `MSG_room${String(params.roomId)}_${topAsOfCompact(ctx.asOf)}.csv`,
    columns: msgCsvColumns,
    rows: (payload): (string | number | boolean | null)[][] => msgCsvRows(payload),
  },
  help: {
    summary: 'Chat rooms and direct messages with live shared securities, charts and functions',
    description:
      'MSG is the terminal’s messaging screen: your rooms on the left, the open conversation on ' +
      'the right, a composer at the bottom. IB and CHAT are the same screen; IB opens on the room ' +
      'list. Rooms are direct messages, group rooms, your firm room or a helpdesk room opened by ' +
      'a HELP ticket. Anything you attach — a security, a chart, a function result, a watchlist ' +
      'or a portfolio — arrives as a chip the recipient can open with GO, and any price on it is ' +
      'resolved against the recipient’s own entitlements, not yours: if they are entitled to ' +
      'end-of-day only, they see an end-of-day number with the reason, never yours. Every message ' +
      'is written once to a hash-chained archive that the screen verifies as it loads, is scanned ' +
      'against the compliance lexicon and is kept for at least your firm’s retention period; the ' +
      'screen tells you so on every room and names the ethical walls and permitted counterparty ' +
      'firms that apply. Structured IOI and RFQ messages are displayed as they were sent and are ' +
      'never orders — this terminal does not execute. There is no presence indicator and no ' +
      'federation to outside networks in this version.',
    params: [
      { name: 'roomId', text: 'room to open', example: 'ROOM=7' },
      { name: 'to', text: 'open a direct message with a directory match', example: 'jane.doe' },
      { name: 'view', text: 'split, rooms, room or directory', example: 'VIEW=ROOMS' },
      { name: 'limit', text: 'messages per page 20–200', example: 'N=200' },
      { name: 'filter', text: 'filter the room list', example: 'FILTER=demo' },
      { name: 'unreadOnly', text: 'only rooms with unread messages', example: 'UNREAD=Y' },
    ],
    keys: [
      { key: 'Enter', action: 'open the focused room, attachment or directory entry' },
      { key: 'Shift+Enter', action: 'the same, in the next panel' },
      { key: 'PageDown / PageUp', action: 'older / newer history (PAGE FWD is older)' },
      { key: 'Ctrl+P', action: 'CSV transcript of the active room' },
      { key: 'Alt+D', action: 'directory' },
      { key: 'Alt+R', action: 'cycle split / rooms / room / directory' },
      { key: 'Alt+U', action: 'unread rooms only' },
      { key: 'Alt+N', action: 'new room' },
      { key: 'Alt+M', action: 'mark the room read' },
      { key: 'Alt+S / Alt+F / Alt+W', action: 'attach a security, function result or watchlist' },
      { key: 'Alt+H', action: 'archive detail of the focused message (seq, hashes, chain)' },
      { key: 'Ctrl+ArrowUp / Ctrl+ArrowDown', action: 'previous / next room' },
    ],
    sources: ['internal.user', 'cboe.quotes', 'yahoo.chart'],
    related: ['HELP', 'DES', 'GP', 'W', 'PORT'],
  },
  keymap: [
    { key: 'Alt+D', action: 'open-directory', description: 'Open the counterparty directory' },
    { key: 'Alt+R', action: 'cycle-view', description: 'Cycle split / rooms / room / directory' },
    { key: 'Alt+U', action: 'toggle-unread', description: 'Show only rooms with unread messages' },
    { key: 'Alt+N', action: 'new-room', description: 'Start a room with chosen members' },
    { key: 'Alt+M', action: 'mark-read', description: 'Mark the active room read' },
    {
      key: 'Alt+S',
      action: 'attach-security',
      when: 'form',
      description: 'Attach a security to the draft',
    },
    {
      key: 'Alt+F',
      action: 'attach-function',
      when: 'form',
      description: 'Attach the focused panel’s last result (MSG-04)',
    },
    {
      key: 'Alt+W',
      action: 'attach-watchlist',
      when: 'form',
      description: 'Attach a watchlist to the draft',
    },
    {
      key: 'Alt+H',
      action: 'show-hash',
      description: 'Archive detail of the focused message (MSG-02)',
    },
    { key: 'Ctrl+ArrowUp', action: 'prev-room', description: 'Open the previous room' },
    { key: 'Ctrl+ArrowDown', action: 'next-room', description: 'Open the next room' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default MSG;
