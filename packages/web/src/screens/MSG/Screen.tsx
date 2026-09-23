// packages/web/src/screens/MSG/Screen.tsx — Messaging (FUNCTIONS_TIER1 §MSG "Screen").
//
// Four views over one payload: the `split` a trader lives in, the `rooms` landing (the `IB` alias),
// a single `room`, and the counterparty `directory`.
//
// Two things this screen must never soften:
//   * **Policy.** `canSend === false` carries a reason (`ETHICAL_WALL`, `EXTERNAL_NOT_PERMITTED`,
//     `NOT_A_MEMBER`, `MESSAGE_POLICY_BLOCKED`) and the composer is disabled *with* that reason.
//   * **The archive.** Every message carries its hash and whether the chain verified. A message
//     whose `chainOk` is false is flagged, never quietly rendered like the others (MSG-02).
//
// Attachment chips keep their label and command even when the price inside them is denied, so the
// recipient can open the function and meet the same denial with the same reason (ENTL-05).

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type {
  Badge,
  FunctionScreen,
  GridColumn,
  GridRow,
  Node,
  ScreenSpec,
} from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import {
  cell,
  countCell,
  kvRow,
  entitlementBadges,
  footer,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'MSG'>;
type Payload = PayloadOf<'MSG'>;
type Message = NonNullable<Payload['active']>['messages'][number];

const ROOM_COLUMNS: GridColumn[] = [
  { id: 'room', label: 'Room', align: 'left', sortable: true },
  { id: 'kind', label: 'Kind', align: 'left', sortable: true },
  { id: 'scope', label: 'Scope', align: 'left' },
  { id: 'members', label: 'Members', fmt: 'int', align: 'right' },
  { id: 'lastMessage', label: 'Last message', align: 'left' },
  { id: 'last', label: 'Last', fmt: 'datetime', align: 'left', sortable: true },
  { id: 'unread', label: 'Unread', fmt: 'int', align: 'right', sortable: true },
];

function roomRows(p: Payload): GridRow[] {
  return p.rooms.map((r) => ({
    id: `room:${String(r.roomId)}`,
    subject: r.subject,
    cells: {
      room: textCell(r.name),
      kind: textCell(r.kind),
      scope: textCell(r.scope),
      members: countCell(r.members.length),
      lastMessage: textCell(r.lastMessagePreview),
      last: textCell(r.lastMessageAt, { fmt: 'datetime' }),
      unread: countCell(r.unread),
    },
    command: `MSG ROOM=${String(r.roomId)}`,
    tone: r.unread > 0 ? ('highlight' as const) : ('normal' as const),
  }));
}

/** The chips under a message: its attachments, its structured order, and its archive position. */
function messageBadges(m: Message): Badge[] {
  const badges: Badge[] = [];
  for (const a of m.attachments) {
    // The chip keeps its label and its command whatever the entitlement says; the number itself
    // lives in `kv#attachments` as a real cell, so it carries its field id and provenance index.
    const denied = a.px !== null && a.px.v === null && a.px.r !== undefined;
    badges.push({
      text: denied ? `${a.label} —` : a.label,
      tone: !a.resolvable ? ('blocked' as const) : denied ? ('stale' as const) : ('ok' as const),
      title: !a.resolvable ? a.reason : denied ? String(a.px?.r) : (a.command ?? a.kind),
    });
  }
  if (m.structured !== null) {
    badges.push({
      text: `${m.structured.type.toUpperCase()} ${m.structured.side} ${m.structured.display} ${String(m.structured.qty)}`,
      tone: 'info',
      title: m.structured.price === null ? 'no limit' : `@ ${String(m.structured.price)}`,
    });
  }
  badges.push({
    text: `#${String(m.seq)} ${m.hash.slice(0, 12)}`,
    tone: m.chainOk ? ('info' as const) : ('error' as const),
    title: m.chainOk
      ? `WORM archive · prev ${m.prevHash?.slice(0, 12) ?? 'genesis'}`
      : 'ARCHIVE_CHAIN_BROKEN — this message does not hash onto its predecessor (MSG-02)',
  });
  if (m.unread) badges.push({ text: 'unread', tone: 'warn' });
  return badges;
}

function messagesList(p: Payload): Node {
  const active = p.active;
  if (active === null) {
    return { kind: 'text', id: 'messages', text: 'No room selected.', tone: 'muted' };
  }
  return {
    kind: 'list',
    id: 'messages',
    live: { subject: active.room.subject },
    items: active.messages.map((m) => ({
      id: `msg:${String(m.messageId)}`,
      primary: m.body,
      secondary: `${m.senderDisplay} (${m.senderFirmName}${m.senderDesk === null ? '' : ` · ${m.senderDesk}`})${m.isOwn ? ' · you' : ''}`,
      ts: m.sentAt,
      badges: messageBadges(m),
    })),
  };
}

/**
 * `kv#attachments` — the prices inside the active room's attachment chips, as cells. A chip is a
 * label; a number needs a field id and a provenance index, which is what makes `Ctrl+I` work on it.
 */
function attachmentsBlock(p: Payload): Node | null {
  const active = p.active;
  if (active === null) return null;
  const rows: Extract<Node, { kind: 'kv' }>['rows'] = [];
  for (const m of active.messages) {
    for (const a of m.attachments) {
      if (a.px !== null) rows.push(kvRow(`${a.label} last`, cell('PX_LAST', a.px)));
      if (a.chgPct !== null) {
        rows.push(kvRow(`${a.label} chg %`, cell('CHG_PCT_1D', a.chgPct, { signed: true })));
      }
    }
    if (m.structured?.px != null) {
      rows.push(kvRow(`${m.structured.display} last`, cell('PX_LAST', m.structured.px)));
    }
  }
  if (rows.length === 0) return null;
  return { kind: 'kv', id: 'attachments', title: 'Attachment prices', columns: 2, rows };
}

function policyBadges(p: Payload): Badge[] {
  const items: Badge[] = [
    { text: `${p.policy.firmName}`, tone: 'info' },
    { text: p.active?.room.scope ?? 'internal', tone: 'info' },
    { text: 'archived', tone: 'ok', title: 'WORM archive, MSG-02' },
    { text: 'surveillance on', tone: 'ok', title: 'Lexicon surveillance, MSG-05' },
    {
      text: `retention ${String(p.policy.retentionDays)} d`,
      tone: 'info',
      title: 'Floor of seven years; it cannot be set lower (MSG-03).',
    },
  ];
  if (p.policy.legalHoldActive) {
    items.push({ text: 'LEGAL HOLD', tone: 'error', title: 'Nothing in scope may be deleted.' });
  }
  if (p.active !== null && !p.active.canSend) {
    items.push({
      text: p.active.sendBlockedReason,
      tone: 'blocked',
      title: 'Sending into this room is blocked by policy (MSG-03).',
    });
  }
  const disclaimer = p.active?.room.disclaimer ?? p.policy.disclaimer;
  if (disclaimer !== null) items.push({ text: disclaimer, tone: 'warn' });
  return items;
}

function composer(p: Payload, panelId: string): Node {
  const active = p.active;
  return {
    kind: 'custom',
    id: 'composer',
    component: 'Composer',
    props: {
      roomId: active?.room.roomId ?? null,
      canSend: active?.canSend ?? false,
      sendBlockedReason: active?.sendBlockedReason ?? 'NOT_A_MEMBER',
      disclaimer: active?.room.disclaimer ?? p.policy.disclaimer,
      draftKey: `msg:${panelId}:${String(active?.room.roomId ?? 0)}`,
      maxLength: 8000,
      attachments: [],
    },
  };
}

function directoryGrid(p: Payload): Node {
  return {
    kind: 'grid',
    id: 'directory',
    columns: [
      { id: 'name', label: 'Name', align: 'left', sortable: true },
      { id: 'firm', label: 'Firm', align: 'left', sortable: true },
      { id: 'desk', label: 'Desk', align: 'left' },
      { id: 'role', label: 'Role', align: 'left' },
      { id: 'verified', label: 'Verified', align: 'left' },
      { id: 'canMessage', label: 'Can message', align: 'left' },
    ],
    rows: p.directory.map((d) => ({
      id: `user:${String(d.userId)}`,
      cells: {
        name: textCell(d.displayName),
        firm: textCell(d.firmName),
        desk: textCell(d.desk),
        role: textCell(d.role),
        verified: textCell(d.verified ? 'yes' : 'no'),
        canMessage: textCell(d.canMessage ? 'yes' : d.blockedReason),
      },
      tone: d.canMessage ? ('normal' as const) : ('muted' as const),
    })),
    selectable: true,
    emptyText: 'No verified user matches the filter',
  };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta, ctx }) => {
  if (payload === undefined) {
    return {
      title: 'MSG · Messaging',
      subtitle: 'loading…',
      body: stack(
        'row',
        [
          {
            kind: 'grid',
            id: 'rooms',
            columns: ROOM_COLUMNS,
            rows: Array.from({ length: 3 }, (_v, i) => ({
              id: `skeleton:${String(i)}`,
              cells: { room: textCell(null) },
              tone: 'muted' as const,
            })),
            emptyText: 'loading…',
          },
          stack('col', [
            {
              kind: 'list',
              id: 'messages',
              items: Array.from({ length: 5 }, (_v, i) => ({
                id: `skeleton:${String(i)}`,
                primary: '…',
              })),
            },
            {
              kind: 'custom',
              id: 'composer',
              component: 'Composer',
              props: {
                roomId: null,
                canSend: false,
                sendBlockedReason: 'NOT_A_MEMBER',
                disclaimer: null,
                draftKey: `msg:${ctx.panelId}:0`,
                maxLength: 8000,
                attachments: [],
                placeholder: 'loading…',
              },
            },
          ]),
        ],
        [0.28, 0.72],
      ),
      footer: footer(undefined),
      initialFocus: 'rooms',
    } satisfies ScreenSpec;
  }

  const view = payload.view;
  const roomsGrid: Node = {
    kind: 'grid',
    id: 'rooms',
    columns: ROOM_COLUMNS,
    rows: roomRows(payload),
    selectable: true,
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    emptyText: 'No rooms — Alt+N to start one',
    sort: { col: 'last', dir: 'desc' },
  };

  const policy: Node = {
    kind: 'badges',
    id: 'policy',
    items: [
      ...policyBadges(payload),
      ...entitlementBadges(meta),
      ...unavailableBadges(meta),
      ...stalenessBadges(meta),
    ],
  };

  const hint: Node = {
    kind: 'text',
    id: 'directory-hint',
    tone: 'muted',
    text: 'Alt+D directory · Alt+N new room',
  };

  const attachments = attachmentsBlock(payload);
  const rightPane = stack(
    'col',
    attachments === null
      ? [policy, messagesList(payload), composer(payload, ctx.panelId)]
      : [policy, messagesList(payload), attachments, composer(payload, ctx.panelId)],
    attachments === null ? [0.08, 0.77, 0.15] : [0.08, 0.62, 0.15, 0.15],
  );

  let body: Node;
  let initialFocus: string;
  switch (view) {
    case 'rooms':
      body = stack('col', [roomsGrid, messagesList(payload), hint], [0.6, 0.32, 0.08]);
      initialFocus = 'rooms';
      break;
    case 'room':
      body = rightPane;
      initialFocus = 'composer';
      break;
    case 'directory':
      body = stack('row', [stack('col', [roomsGrid, hint], [0.9, 0.1]), directoryGrid(payload)], [0.28, 0.72]);
      initialFocus = 'directory';
      break;
    case 'split':
      body = stack('row', [stack('col', [roomsGrid, hint], [0.9, 0.1]), rightPane], [0.28, 0.72]);
      initialFocus = 'composer';
      break;
  }

  const room = payload.active?.room;
  const retention = room?.retentionDays ?? payload.policy.retentionDays;

  return {
    title: `MSG · Messaging · ${payload.me.displayName} @ ${payload.me.firmName}`,
    subtitle: `${String(payload.totals.rooms)} rooms · ${String(payload.totals.unread)} unread · archived · retention ${String(retention)} d${payload.policy.legalHoldActive ? ' · LEGAL HOLD' : ''}`,
    body,
    footer: footer(meta, [
      `view ${view} · limit ${String(params.limit)}`,
      `federation ${payload.policy.federation}`,
    ]),
    initialFocus,
  } satisfies ScreenSpec;
};

export default Screen;
