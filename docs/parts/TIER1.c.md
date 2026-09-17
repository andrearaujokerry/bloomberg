### MSG — Messaging

| Attribute | Value |
| --- | --- |
| Code / aliases | `MSG` / `IB` (`aliasParams` `{ IB: { view: 'rooms' } }`), `CHAT` |
| Tier / category | 1 / messaging |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/MSG.ts` · `packages/server/src/functions/MSG/resolve.ts` · `packages/web/src/screens/MSG/Screen.tsx` · `packages/web/src/screens/MSG/Composer.tsx` · `fixtures/golden/functions/MSG.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (MSG-01) (MSG-02) (MSG-03) (MSG-04) (MSG-06) (SEC-06) (REG-01) (REG-04) (TERM-03) (TERM-06) (TERM-08) (TERM-09) (TERM-12) (BUS-01) (BUS-02) (BUS-06) (DATA-10) (ENTL-04) (ENTL-05) (OPS-07) |

MSG-05 (federation to Symphony / Teams / ICE Chat) is a declared v1 non-goal (BRIEF §1); the screen states
it in the policy strip rather than offering a disabled control.

#### Params
```ts
export const MsgParams = z.object({
  roomId: z.number().int().positive().nullable().default(null),   // the room to open; null → the most recently active room the caller is a member of
  to: z.string().max(80).nullable().default(null),                // directory query: 'MSG jane.doe' opens (or creates on send) the dm with the single best match
  view: z.enum(['split', 'rooms', 'room', 'directory']).default('split'),
  limit: z.number().int().min(20).max(200).default(50),           // messages per page, newest-first window
  filter: z.string().max(80).default(''),                         // room-list substring filter over room name and member display names
  unreadOnly: z.boolean().default(false),
});
```
#### Argument grammar
`positional [{ name:'to', type:'string', optional:true }]`, `keyed { ROOM: { name:'roomId', type:'int' }, VIEW: { name:'view', type:'enum', values:['split','rooms','room','directory'] }, N: { name:'limit', type:'int' }, FILTER: { name:'filter', type:'string' }, UNREAD: { name:'unreadOnly', type:'boolean' } }`, no `rest`.
Examples: `MSG` → `{ roomId:null, to:null, view:'split', limit:50, filter:'', unreadOnly:false }` · `MSG jane.doe` → `{ to:'jane.doe' }` · `MSG ROOM=7 N=200 VIEW=ROOM` → `{ roomId:7, limit:200, view:'room' }`.
`IB` (the alias) launches with `{ view:'rooms' }` merged before the zod parse (runner step 1, FUNCTIONS.md §1.4.3); `IB ROOM=7` → `{ view:'rooms', roomId:7 }`.

#### Payload
```ts
export type MsgView = 'split' | 'rooms' | 'room' | 'directory';
export type MsgRoomKind = 'dm' | 'group' | 'firm' | 'helpdesk';
export type MsgSendBlock = 'OK' | 'MESSAGE_POLICY_BLOCKED' | 'ETHICAL_WALL' | 'EXTERNAL_NOT_PERMITTED' | 'NOT_A_MEMBER';
export type MsgAttachKind = 'security' | 'function' | 'chart' | 'portfolio' | 'watchlist';

/** MSG-04: one shared object as THIS viewer may see it. Live numbers are ValueCells under the viewer's own entitlements. */
export interface MsgAttachmentView {
  idx: number;                                   // position within the message's attachments[]
  kind: MsgAttachKind;
  label: string;                                 // 'AAPL US Equity' | 'GP · AAPL US Equity · 1Y' | 'Core' | 'Demo Fund I'
  command: string | null;                        // what GO runs for the viewer ('AAPL US Equity GP 1Y'); null when not resolvable
  instrumentId: number | null;                   // security / chart / structured
  code: string | null;                           // function / chart attachments: 'GP'
  params: Record<string, unknown>;               // function / chart attachments, verbatim from the sender
  resultId: string | null;                       // sender's cached result; re-run at the cached asOf under the viewer's entitlements
  portfolioId: number | null; watchlistId: number | null; annotationIds: number[];
  subject: string | null;                        // 'q:42' when a live price is shown next to the chip
  px: ValueCell | null; chgPct: ValueCell | null;
  resolvable: boolean;
  reason: 'OK' | 'NOT_ENTITLED' | 'NOT_IN_UNIVERSE' | 'NOT_SHARED_WITH_YOU' | 'RESULT_EXPIRED' | 'FUNCTION_NOT_FOUND';
}

export interface MsgStructuredView {              // MSG-06: display only, never an order (BRIEF §1 EXEC-* out of scope)
  type: 'ioi' | 'rfq'; side: 'buy' | 'sell';
  instrumentId: number; display: string;          // 'AAPL US Equity'
  qty: number; price: number | null;
  px: ValueCell | null;                           // live PX_LAST for context, viewer's entitlements
  subject: string | null;
}

export interface MsgMessageRow {
  messageId: number; roomId: number; seq: number;
  senderUserId: number; senderFirmId: number; senderDisplay: string; senderFirmName: string; senderDesk: string | null;
  isOwn: boolean; sentAt: string;                 // ISO-8601 UTC
  body: string;                                   // stored text, never rewritten (messages are immutable, API.md §5.10)
  attachments: MsgAttachmentView[];
  structured: MsgStructuredView | null;
  clientMsgId: string; prevHash: string | null; hash: string;     // sha256 hex, messages_chain trigger (MSG-02)
  chainOk: boolean;                               // recomputed over the returned window; false ⇒ archive integrity warning
  unread: boolean;                                // seq > message_reads.last_read_seq for the caller
}

export interface MsgMemberView {
  userId: number; displayName: string; firmId: number; firmName: string; desk: string | null;
  role: 'member' | 'owner' | 'supervisor'; verified: boolean; isSelf: boolean;
}

export interface MsgRoomRow {
  roomId: number; kind: MsgRoomKind; name: string;                // dm rooms: the counterparty display name
  scope: 'internal' | 'external'; firmId: number | null;
  wallTag: string | null; disclaimer: string | null; retentionDays: number; createdAt: string;
  members: MsgMemberView[];
  lastSeq: number; lastReadSeq: number; unread: number;
  lastMessageAt: string | null; lastMessagePreview: string | null;  // first 80 chars of the last body, attachments rendered as '[GP AAPL US Equity]'
  subject: string;                                 // 'room:<roomId>'
}

export type MsgPayload = {
  variant: 'default';
  view: MsgView;
  me: { userId: number; displayName: string; firmId: number; firmName: string; desk: string | null;
        role: 'user' | 'admin' | 'compliance' | 'dataops' | 'helpdesk' | 'newsroom' };
  rooms: MsgRoomRow[];                             // filtered by params.filter / params.unreadOnly, most recent activity first
  active: {
    room: MsgRoomRow;
    messages: MsgMessageRow[];                     // ascending seq, the window ending at room.lastSeq (or at the page cursor)
    canSend: boolean; sendBlockedReason: MsgSendBlock;
    olderCursor: string | null; newerCursor: string | null;
  } | null;
  directory: Array<MsgMemberView & { canMessage: boolean; blockedReason: MsgSendBlock }>;   // MSG-01, populated for view 'directory' or when params.to is set
  policy: {                                        // MSG-03, from firms.policy and rooms.*
    firmName: string; retentionDays: number; disclaimer: string | null;
    permittedCounterpartyFirms: string[]; ethicalWalls: Array<{ deskA: string; deskB: string }>;
    archived: true; surveillance: true;            // constants: every message is WORM-archived and lexicon-scanned (MSG-02)
    legalHoldActive: boolean;                      // any open legal_holds row whose scope covers the caller or the active room
    federation: 'NOT_IN_SCOPE_V1';                 // MSG-05
  };
  totals: { rooms: number; unread: number; directoryMatches: number };
};
```
Presence is absent by design: no v1 source publishes it (see "Unavailable and reason codes"), so
`MsgMemberView` carries no online flag rather than a fabricated one (FUNCTIONS.md §1.3 rule 6).

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md §13) | `rooms`, `room_members`, `messages`, `message_reads`, `legal_holds`, `firms` (`policy`, `retention_days`, `name`), `users` (`display_name`, `desk`, `role`, `status`, `person_verified_at`, `anonymised_at`), `instruments` (attachment display keys), `watchlists`, `portfolios`, `chart_annotations`; read through RLS with `app_user_id()`/`app_firm_id()` and `is_room_member()` (SEC-05, PORT-07) |
| Data services | `data.messaging.rooms()`, `data.messaging.messages(roomId, { cursor, limit })`, `data.messaging.directory(q)`, `data.reference.instrument(id)` (attachment display keys), `data.workspace.watchlist(id)`, `data.portfolio.get(id)`, `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through | None. Messaging content is first-party (`internal.user`); attachment prices follow §0.4 rule 2 — the resolver never calls `providers.ensure`, it calls `plant.ensureHot` and lets the scheduler poll. |
| Engines | None. |
| Subjects (live) | `room:<roomId>` for the active room **and** every room in `rooms[]` (unread counters); `q:<instrumentId>` for each distinct attachment/structured instrument |
| Field ids | `default: [PX_LAST, CHG_NET_1D, CHG_PCT_1D, LAST_TRADE_TIME]` — the entitlement pre-check set for attachment cells only; message bodies are not dictionary fields and are not entitlement-evaluated |

#### Resolver
1. `me` from `ctx.user` joined to `users`/`firms` (`display_name`, `desk`, `role`, `firms.name`, `firms.retention_days`, `firms.policy`). A caller whose `users.status ≠ 'active'` never reaches here (the session is revoked); a caller with `anonymised_at` set renders as `user-<id>` everywhere (REG-04).
2. `rooms = await data.messaging.rooms()` — rooms where `room_members.user_id = ctx.user.userId AND left_at IS NULL`, RLS-scoped. Map each to `MsgRoomRow`: `name` = `rooms.name`, or for `kind:'dm'` the other member's `display_name`; `unread = lastSeq − lastReadSeq` (clamped at 0); `subject = 'room:' + roomId`. Apply `params.filter` (case-insensitive substring over `name` and member display names) and `params.unreadOnly`; sort by `lastMessageAt` desc, `roomId` desc; `totals.rooms` is the count **before** filtering.
3. Active room selection: `params.roomId` when the caller is a member (else `422 NOT_A_MEMBER` is not raised — the payload sets `active = null` and `ctx.unavailable.add({ field:'active', reason:'NOT_APPLICABLE', detail:'ROOM_NOT_A_MEMBER: you are not a member of room <id>' })`, because MSG has no security context to fail on); otherwise `params.to` resolves through step 4; otherwise `rooms[0]`; otherwise `null`.
4. `params.to` (MSG-01): `dir = await data.messaging.directory(params.to)` (verified, non-deprovisioned users, ranked by exact email → display-name prefix → desk). `directory[]` is populated with `canMessage` per step 8. When exactly one match exists and a `dm` room with exactly `{me, match}` already exists, that room becomes active; when none exists the room is **not** created by the resolver (`POST /rooms` happens on first send from the composer) and `active = null` with `view` forced to `'directory'`.
5. Messages: `data.messaging.messages(roomId, { cursor: ctx.page?.cursor ?? null, limit: params.limit })` → `messages` table window, ascending `seq`. Without a cursor the window is the newest `limit` rows (`seq > lastSeq − limit`). `ctx.page.set({ index, count: Math.ceil(room.lastSeq / params.limit), cursor: olderCursor })`.
6. Chain verification (MSG-02): for each returned row recompute `sha256(prev_hash || room_id || seq || sender || sent_at || body || attachments)` and compare with `hash`; the first mismatch sets `chainOk:false` on that row and every later row of the window and raises `ctx.unavailable.add({ field:'active.messages', reason:'NOT_APPLICABLE', detail:'ARCHIVE_CHAIN_BROKEN: hash chain breaks at seq <n>; produce the room through /admin/export/messages' })`. Verification is O(window), never O(room).
7. Attachments (MSG-04), per message, per attachment, in order:
   - `security` → `data.reference.instrument(instrumentId)`; `label` = `display` (`'AAPL US Equity'`), `command` = `label + ' DES'`, `subject = plant.subjectFor(instrumentId)`.
   - `chart` → same instrument lookup; `label = 'GP · ' + display + (params.range ? ' · ' + params.range : '')`, `command = display + ' GP' + argString(params)`, `annotationIds` kept (the screen resolves the shared annotations through `/annotations`; ids the viewer may not read are dropped by RLS and the chip shows `(n shared annotations)`).
   - `function` → `registry.canonical(code)`; `label = code + (instrumentId ? ' · ' + display : '')`, `command = (display ? display + ' ' : '') + code + argString(params)`; unknown code → `resolvable:false`, `reason:'FUNCTION_NOT_FOUND'`.
   - `portfolio` / `watchlist` → `data.portfolio.get` / `data.workspace.watchlist`; RLS returning nothing → `resolvable:false`, `reason:'NOT_SHARED_WITH_YOU'`, `label = kind + ' #' + id` and `command = null`.
   - `resultId` present → kept verbatim; the **screen** (not the resolver) calls `GET /results/:resultId`, which re-runs at the cached `asOf` under the viewer's entitlements (FUNCTIONS.md §1.4.3); an expired result renders `reason:'RESULT_EXPIRED'` and falls back to `command`.
8. Policy (MSG-03), evaluated once for the active room and once per directory entry by `packages/server/src/messaging/service.ts#canMessage(me, counterparty, room)`: (a) `rooms.scope='external'` or a counterparty in another firm requires that firm's name to be in `firms.policy.permittedCounterpartyFirms` → else `EXTERNAL_NOT_PERMITTED`/`MESSAGE_POLICY_BLOCKED`; (b) `rooms.wall_tag` non-null requires every member's `users.desk` to carry that tag, and `firms.policy.ethicalWalls[{deskA,deskB}]` blocks any pair of desks listed → `ETHICAL_WALL`; the `newsroom` role is walled from every non-`newsroom` desk unconditionally (SEC-06); (c) non-membership → `NOT_A_MEMBER`. `canSend = sendBlockedReason === 'OK'`.
9. `policy.legalHoldActive` = `EXISTS (SELECT 1 FROM legal_holds WHERE firm_id = me.firmId AND released_at IS NULL AND (scope->'userIds' @> me.userId OR scope->'roomIds' @> activeRoomId))`. `policy.retentionDays = max(firms.retention_days, rooms.retention_days)` for the active room, `firms.retention_days` otherwise (REG-01 floor: 7 years, never lowered by the room).
10. Live cells: `subjects = distinct attachment/structured instrument subjects`; `plant.ensureHot(subjects)`; `states = plant.snapshotMany(subjects)`; `px = cellFromState(ctx, states.get(subject), 'PX_LAST', subject)` and `chgPct = cellFromState(ctx, …, 'CHG_PCT_1D', subject)` (§0.4 rules 1 and 2 — never `providers.ensure`, so a shared name with no recorded quote is simply pending). A field the viewer is not entitled to arrives already nulled with `r` set (ENTL-05).
11. Return `{ variant:'default', view: params.view, me, rooms, active, directory, policy, totals }`.
Budget: 3 DB round-trips (rooms+members+reads in one query, the message window in one, the attachment reference/watchlist/portfolio lookups batched in one) plus plant reads; zero provider calls; first paint < 500 ms p95, < 120 ms p95 hot with the seeded two rooms.

#### Live
```ts
live: (params, payload) => ({
  subjects: [...payload.rooms.map(r => r.subject),
             ...distinct(payload.active?.messages.flatMap(m =>
                 [...m.attachments.map(a => a.subject), m.structured?.subject ?? null]).filter(Boolean) ?? [])],
  fields: ['PX_LAST', 'CHG_NET_1D', 'CHG_PCT_1D', 'LAST_TRADE_TIME'],
  conflationMs: 250,
  essential: payload.active ? [payload.active.room.subject] : [],
})
```
`room:<id>` carries no fields: `packages/web/src/state/subscriptions.ts` intersects `LiveSpec.fields` with the subject family and sends `f: []` for the `room:` family (§0.4 rule 5, API.md §6.1). A `msg { room, message }` frame for the **active** room appends a `MsgMessageRow` to `active.messages` (validated with `Rest.Messages.Message`, attachments resolved client-side exactly as resolver step 7, then `POST /rooms/:roomId/read` when the list is scrolled to the bottom); a frame for any other room increments that room's `unread` and re-sorts `grid#rooms`. Attachment chips register `Cell.live = { subject:'q:<id>', field:'PX_LAST' }` so they flash like any monitor cell (TERM-08) and go stale on the same 1 s ticker (TERM-12). `subAck` rejecting `room:<id>` with `NOT_ENTITLED` (membership revoked mid-session) turns that row muted with the badge `NOT_A_MEMBER` and drops it on the next run.

#### Screen
Title `MSG · Messaging · <me.displayName> @ <me.firmName>` (alias launch: `IB · Instant Bloomberg · …`); subtitle `<totals.rooms> rooms · <totals.unread> unread · archived · retention <policy.retentionDays> d<legal hold ? ' · LEGAL HOLD' : ''>`; `initialFocus:'composer'` for `view` `split`/`room`, `'rooms'` for `rooms`, `'directory'` for `directory`.
Body for `view:'split'` — `split row [0.28 | 0.72]`:
```
┌ MSG · Messaging · Alex Pardo @ Demo Capital            2 rooms · 3 unread · archived · retention 2555 d ┐
│ grid#rooms                        │ badges#policy [firm room · internal · surveillance on] [disclaimer]  │
│ room | kind | last | unread       │ list#messages (live room:1)                                          │
│ Demo Capital  firm  18:39  2      │ 18:31:02 Jane Ruiz (Demo Capital · Equities PM)                      │
│ Jane Ruiz     dm    18:41  1      │   morning — flagging the print on the open                           │
│ ────────────────────────────────  │ 18:39:44 Alex Pardo (you)                                            │
│ text#directory-hint               │   [AAPL US Equity  330.27 ▾ −0.84%]  [GP · AAPL US Equity · 1Y]      │
│  Alt+D directory · Alt+N new room │ 18:41:10 Jane Ruiz  [IOI buy AAPL US Equity 25,000 @ 330.00]         │
│                                   │ ──────────────────────────────────────────────────────────────────── │
│                                   │ custom#composer (Composer)  ▸ type · Alt+S security · Alt+F function │
│                                   │   Messages are archived and monitored. Sending to Demo Capital only. │
└ footer sources: Terminal messaging (internal, WORM-archived); Cboe delayed quotes (attachment prices)    ┘
```
`view:'rooms'` (the `IB` landing) drops the split and renders `grid#rooms` full width with the columns
`room | kind | scope | members | last message | last | unread`, `rows[].command = 'MSG ROOM=' + roomId`,
`emptyText: 'No rooms — Alt+N to start one'`, plus `list#messages` collapsed to a 3-line preview of the
selected row. `view:'room'` drops `grid#rooms`. `view:'directory'` replaces the right pane with
`grid#directory` (`name | firm | desk | role | verified | can message`), `emptyText: 'No verified user matches "<filter>"'`.
Formats: `sentAt` `datetime` in the viewer's browser tz with the UTC ISO in the title attribute; `unread`
`int`; attachment `px` `fmt:'px'` with `decimals` from `instruments.price_decimals` via `core/fields/format.ts`;
`chgPct` `fmt:'pct'` `decimals:2` with `dir` from its sign; `retentionDays` `int`; `hash` `text`, truncated
to the first 12 hex characters in the list and shown in full in the provenance panel.
Skeleton (`payload === undefined`): `grid#rooms` with 3 muted rows, `list#messages` with 5 muted lines,
`custom#composer` disabled with the placeholder `loading…`.
`meta.entitlement` renders inside attachment chips only: a denied `PX_LAST` is `—` with the reason
(`TIER_EOD`, `NO_FIRM_ENTITLEMENT`) in the tooltip; the chip's label and `command` stay live, so the
recipient can still open the function and hit the same denial with the same reason (ENTL-05).
`meta.unavailable` entries render as `badges#policy` items with tone `warn` (`ARCHIVE_CHAIN_BROKEN` is
tone `error`), and `PRESENCE_NOT_AVAILABLE` as a muted `text` line under `grid#rooms`.
The `custom#composer` node is `{ kind:'custom', id:'composer', component:'Composer', props: { roomId, canSend, sendBlockedReason, disclaimer, draftKey: 'msg:<panelId>:<roomId>', maxLength: 8000, attachments: PendingAttachment[] } }`; it owns printable keys while focused (§2.6 `Ctrl+L` note) and posts `POST /rooms/:roomId/messages { clientMsgId: uuid(), body, attachments, structured }`, retrying the same `clientMsgId` on network failure (idempotent, API.md §5.10).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid (`grid#rooms`) | `open-room` | `ctx.setParams({ roomId: row.instrumentId === undefined ? Number(row.id) : Number(row.id), view: 'split' })` (`row.id` is the `roomId`) |
| `Shift+Enter` | grid (`grid#rooms`) | `open-room-next` | `ctx.navigateNext('MSG ROOM=' + row.id)` |
| `Enter` | list (`list#messages`) | `open-attachment` | runs the focused message's first `resolvable` attachment `command`; no attachment → no-op |
| `Shift+Enter` | list (`list#messages`) | `open-attachment-next` | same command in the next panel |
| `Enter` | grid (`grid#directory`) | `open-dm` | `ctx.setParams({ to: row.id, view: 'split' })` |
| `Enter` | form (`custom#composer`) | `send` | sends the draft (the composer owns `Enter` while focused; `Shift+Enter` inserts a newline) |
| `Alt+D` | always | `open-directory` | `ctx.setParams({ view: 'directory' })` (usage `fn.param`) |
| `Alt+R` | always | `cycle-view` | `ctx.setParams({ view: next of split→rooms→room→directory })` |
| `Alt+U` | always | `toggle-unread` | `ctx.setParams({ unreadOnly: !unreadOnly })` |
| `Alt+N` | always | `new-room` | `ctx.prompt('text', { label: 'Members (comma-separated)' })` → `POST /rooms { kind, memberUserIds }` → `setParams({ roomId })`; `403 MESSAGE_POLICY_BLOCKED` renders the reason in the footer |
| `Alt+M` | always | `mark-read` | `POST /rooms/:roomId/read { lastReadSeq: active.room.lastSeq }`, then clears `unread` |
| `Alt+S` | form (`custom#composer`) | `attach-security` | `ctx.prompt('security')` → pending `{ kind:'security', instrumentId }` |
| `Alt+F` | form (`custom#composer`) | `attach-function` | attaches the focused panel's last result: `{ kind:'function', code, instrumentId, params, resultId }` (MSG-04) |
| `Alt+W` | form (`custom#composer`) | `attach-watchlist` | `ctx.prompt('watchlist')` → pending `{ kind:'watchlist', watchlistId }` |
| `Alt+H` | list (`list#messages`) | `show-hash` | opens the archive detail for the focused message: `seq`, `sentAt`, `prevHash`, `hash`, `chainOk` (MSG-02; `Ctrl+I` stays the reserved provenance key and applies to attachment cells) |
| `Ctrl+ArrowUp` / `Ctrl+ArrowDown` | always | `prev-room` / `next-room` | move one row in `grid#rooms` and open it |
| `PageDown` / `PageUp` | list (`list#messages`) | reserved (PAGE FWD / BACK) | older / newer history page (`pageable`, below) |
| `Ctrl+P` | always | reserved (PRINT) | CSV transcript of the active room (below) |

#### CSV
`pageable:true` — the cursor is `base64url(JSON.stringify({ roomId, seq }))` of the window's edge message.
**PAGE FWD means older** (`seq < cursor.seq`, the natural direction for chat history); PAGE BACK returns
toward `room.lastSeq`. `meta.page = { index, count: ceil(room.lastSeq / limit), cursor: olderCursor }`.

`filename = active ? 'MSG_room' + active.room.roomId + '_' + asOfCompact + '.csv' : 'MSG_rooms_' + asOfCompact + '.csv'`
(`asOfCompact` = `meta.asOf.validAt` without `-`/`:`, e.g. `20260915T184128Z`).
Long-format with a leading `section` column (FUNCTIONS.md §1.6 rule 3); static columns:
```ts
export const msgCsvColumns: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },      // 'policy' | 'room' | 'member' | 'message' | 'attachment'
  { id: 'roomId', label: 'Room id', type: 'number' }, { id: 'seq', label: 'Seq', type: 'number' },
  { id: 'ts', label: 'Timestamp', type: 'datetime' }, { id: 'sender', label: 'Sender', type: 'string' },
  { id: 'senderFirm', label: 'Sender firm', type: 'string' }, { id: 'desk', label: 'Desk', type: 'string' },
  { id: 'body', label: 'Body', type: 'string' }, { id: 'detail', label: 'Detail', type: 'string' },
  { id: 'hash', label: 'Hash', type: 'string' }, { id: 'chainOk', label: 'Chain ok', type: 'boolean' },
];
```
Rows, in this order: one `policy` row (`detail` = `retention=<n>d; disclaimer=<text>; counterparties=<a|b>; walls=<deskA/deskB>; legalHold=<bool>; surveillance=true; federation=NOT_IN_SCOPE_V1`); one `room` row per `rooms[]` (`body` = `name`, `detail` = `kind/scope/unread`); one `member` row per member of the active room (`sender` = display name, `detail` = `role`); one `message` row per `active.messages[]`; one `attachment` row per attachment (`body` = `label`, `detail` = `kind|command|reason`, `seq` = the parent message's seq). When `active === null` only the `policy` and `room` sections are written. Blank cells are `null`, not `''`.
Example: `message,1,6,2026-09-15T18:39:44Z,Alex Pardo,Demo Capital,Equities PM,"flagging the print on the open",,9f2c1b0a…,true`.
`Ctrl+E` on `grid#rooms` exports the room list alone through `/data/csv`. Exporting a transcript writes a
`fn.export` usage event and an `access_log` row with `purpose:'MSG'` and `usage:'export'` (ENTL-04, FUNC-04);
the regulatory production path stays `GET /admin/export/messages` (NDJSON with the chain verdict, REG-01).

#### Help
summary `Chat rooms and direct messages with live shared securities, charts and functions`;
description `MSG is the terminal's messaging screen: your rooms on the left, the open conversation on the right, a composer at the bottom. IB and CHAT are the same screen; IB opens on the room list. Rooms are direct messages, group rooms, your firm room or a helpdesk room opened by a HELP ticket. Anything you attach — a security, a chart, a function result, a watchlist or a portfolio — arrives as a chip the recipient can open with GO, and any price on it is resolved against the recipient's own entitlements, not yours: if they are entitled to end-of-day only, they see an end-of-day number with the reason, never yours. Every message is written once to a hash-chained archive that the screen verifies as it loads, is scanned against the compliance lexicon and is kept for at least your firm's retention period; the screen tells you so on every room and names the ethical walls and permitted counterparty firms that apply. Structured IOI and RFQ messages are displayed as they were sent and are never orders — this terminal does not execute. There is no presence indicator and no federation to outside networks in this version.`;
params `roomId` ("room to open", `ROOM=7`), `to` ("open a direct message with a directory match", `MSG jane.doe`), `view` ("split, rooms, room or directory", `VIEW=ROOMS`), `limit` ("messages per page 20–200", `N=200`), `filter` ("filter the room list", `FILTER=demo`), `unreadOnly` ("only rooms with unread messages", `UNREAD=Y`);
sources `['internal.user', 'cboe.quotes', 'yahoo.chart']`; related `['HELP', 'DES', 'GP', 'W', 'PORT']`.

#### Unavailable and reason codes
| `field` | `reason` | `detail` (footer code first) |
| --- | --- | --- |
| `members[].presence` | `NO_SOURCE` | `PRESENCE_NOT_AVAILABLE: no presence service in v1; the room list shows last message time instead of who is online` |
| `federation` | `NOT_APPLICABLE` | `FEDERATION_NOT_IN_SCOPE_V1: MSG-05 (Symphony, Teams, ICE Chat) is an explicit v1 non-goal (BRIEF §1)` |
| `active` | `NOT_APPLICABLE` | `ROOM_NOT_A_MEMBER: you are not a member of room <id>` (also emitted when `rooms` is empty: `NO_ROOMS: you are not a member of any room — Alt+N to start one`) |
| `active.messages` | `NOT_APPLICABLE` | `ARCHIVE_CHAIN_BROKEN: hash chain breaks at seq <n>; produce the room through /admin/export/messages` |
| `active.canSend` | `NOT_APPLICABLE` | `MESSAGE_POLICY_BLOCKED: <firm> is not a permitted counterparty` / `ETHICAL_WALL: <deskA> and <deskB> are walled` / `EXTERNAL_NOT_PERMITTED: this room is external and your firm policy does not allow it` (MSG-03, SEC-06) |
| `attachments[<i>]` | `NOT_LICENSED` | `ATTACHMENT_NOT_ENTITLED: you are not entitled to <instrument>; the chip opens but the price is blank` |
| `attachments[<i>]` | `NOT_APPLICABLE` | `ATTACHMENT_NOT_SHARED: the sender's portfolio/watchlist is not shared with you` · `RESULT_EXPIRED: the shared result is older than 10 minutes; open the function instead` · `FUNCTION_NOT_FOUND: <code> is not in this registry version` |
| `structured` | `NOT_APPLICABLE` | `IOI_DISPLAY_ONLY: structured messages are displayed, never routed — execution is out of scope (MSG-06, BRIEF §1)` |
Per-cell entitlement denials on `px`/`chgPct` come from `meta.entitlement` with the standard codes
(`TIER_EOD`, `NO_FIRM_ENTITLEMENT`, `NOT_ENTITLED_TIER`, `SOURCE_TIER_CAP`). `PROVIDER_DOWN` leaves
attachment cells `st:'stale'` with their last values and never blanks them (TERM-12). A room whose
retention has elapsed is not purged below `firms.retention_days` (REG-01): the purge job cannot produce a
partial room, so there is no "partially retained" state to render.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2; `aliases` `['IB','CHAT']` unique across the registry, `aliasParams` keys ⊆ `aliases`, `assetClasses:'none'` ⇒ `variants:{}` and `requiresSecurity:false` |
| golden payload | `packages/server/test/integration/functions/MSG.golden.test.ts` | `MSG` as `pm@demo` (userId 2, firmId 1) at the frozen clock `2026-09-15T18:41:28Z` deep-equals `fixtures/golden/functions/MSG.default.json`: `rooms.length === 2` (the `Demo Capital` firm room and the seeded dm), `totals.unread` matches `message_reads`, `active.messages.length === 6`, every `chainOk === true`, the `AAPL US Equity` attachment has `px.v === 330.27` and `px.live.subject === 'q:42'`, `policy.retentionDays === 2555`, `policy.federation === 'NOT_IN_SCOPE_V1'` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `MSG.default.csv`; the `policy`, `room`, `member`, `message` and `attachment` sections each have 11 cells per row; `hash` cells equal the payload `hash` values |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV at the frozen `asOf`; attachment `px.v` equals the WS `snap.f.PX_LAST` for `q:42` (API-05) |
| hash chain | `packages/server/test/integration/messaging/chain.test.ts` | `messages_chain` trigger assigns `seq` and `hash`; an `UPDATE`/`DELETE` is refused by `messages_worm` (MSG-02); flipping one stored `body` byte makes the resolver report `chainOk:false` from that seq onward and emits `ARCHIVE_CHAIN_BROKEN` |
| policy | `packages/server/test/integration/messaging/policy.test.ts` | a counterparty firm absent from `firms.policy.permittedCounterpartyFirms` gives `canSend:false` `MESSAGE_POLICY_BLOCKED` and `POST /rooms` `403`; a `wall_tag` mismatch gives `ETHICAL_WALL`; a `newsroom` user is walled from every other desk (SEC-06); an open `legal_holds` row sets `policy.legalHoldActive` |
| entitlement of attachments | `packages/server/test/integration/functions/MSG.entitlement.test.ts` | the same seeded message read by `pm@demo` and `eod@demo`: the `AAPL US Equity` chip is `330.27` for the first and `—` with `r:'TIER_EOD'` for the second, with identical `label` and `command` (MSG-04, ENTL-05) |
| pagination | `packages/server/test/integration/functions/MSG.page.test.ts` | `N=2` then PAGE FWD twice walks `seq` 5–6, 3–4, 1–2 with `meta.page.cursor` = `base64url({roomId,seq})` and no row repeated |
| screen | `packages/web/test/screens/MSG.test.tsx` | renders the golden for each `view`; a replayed `msg` frame for the active room appends a row and for another room bumps its `unread`; attachment cells register `live` on `q:42` and flash on a delta; every keymap action is reachable by keyboard; the composer owns printable keys and `Enter`; `payload === undefined` renders the skeleton; `PRESENCE_NOT_AVAILABLE` renders as a muted line |
| e2e | `packages/e2e/tests/messaging.spec.ts` | `pm@demo` runs `AAPL US Equity GP <GO>`, `MSG <GO>` in the next panel, `Alt+F` attaches the GP result, sends; a second browser context signed in as the dm counterparty receives the chip within 1 s over `room:<id>`, `Enter` on it opens `GP` in their panel, and as `eod@demo` the same chip shows `—` with `TIER_EOD` (MSG-04, ENTL-05, BUS-01) |

---

### IB — Instant Bloomberg

| Attribute | Value |
| --- | --- |
| Code / aliases | `IB` is **not a manifest**: it is an alias of `MSG` (FUNCTIONS.md §6, 38 manifests) with `aliasParams` `{ IB: { view: 'rooms' } }` |
| Tier / category | 1 / messaging |
| Asset classes → variants | `none → default` (MSG's) |
| requiresSecurity / pageable / screenKind | `false` / `true` / `declarative` |
| payloadVersion | 1 (MSG's; the alias never versions separately) |
| Files | none of its own — `packages/core/src/functions/manifests/MSG.ts` declares `aliases: ['IB','CHAT']`; `fixtures/golden/functions/MSG.rooms.{json,csv}` is the alias-launch golden |
| Requirements | (FUNC-01) (TERM-01) (TERM-03) (MSG-01) (MSG-03) (MSG-04) |

This entry exists because BRIEF §6 lists the Tier 1 catalogue as `MSG`/`IB`. Everything an implementer
needs is in the `MSG` entry above; what follows is the complete list of what the alias changes and the
tests that pin it. `registry.canonical('ib') === 'MSG'` and `registry.canonical('IB')` likewise
(case-insensitive, FUNCTIONS.md §1.7); `IB` may never be registered as a `code`.

#### Params
```ts
// packages/core/src/functions/manifests/MSG.ts
aliasParams: { IB: { view: 'rooms' } },      // merged BEFORE MsgParams.parse (runner step 1, FUNCTIONS.md §1.4.3)
```
No other key differs: the alias produces `MsgParams.parse({ view:'rooms', ...body.params })`, so every
default of `MSG` (`roomId:null`, `to:null`, `limit:50`, `filter:''`, `unreadOnly:false`) applies and an
explicit `VIEW=` on the command line overrides the alias default.

#### Argument grammar
`MSG`'s grammar verbatim (`positional [{ name:'to', type:'string', optional:true }]`, `keyed { ROOM, VIEW, N, FILTER, UNREAD }`, no `rest`) — the parser resolves the alias to the canonical code before `parseArgs` runs, so there is no alias-specific grammar.
Examples: `IB` → `{ view:'rooms', roomId:null, to:null, limit:50, filter:'', unreadOnly:false }` · `IB jane.doe` → `{ view:'rooms', to:'jane.doe' }` · `IB VIEW=SPLIT ROOM=1` → `{ view:'split', roomId:1 }` (the explicit `VIEW=` wins over `aliasParams`).
Autocomplete ranks `IB` as a function row whose `insertText` is `IB` and whose label is `IB — Instant Bloomberg (MSG)`; the ticker prefix `IBM US Equity` must still rank above it for the query `IB` when the panel has no security (FUNCTIONS.md §3.3 / §6 row `IB`).

#### Payload
`MsgPayload` unchanged, with `view: 'rooms'` from the alias default. `meta.resultId` and the cached
result record `alias:'IB'` (`CachedResult.alias`, runner step 9) and `usage_events.details.alias = 'IB'`
(step 10), which is the only trace of the alias in the payload envelope (FUNC-04).

#### Data dependencies
Identical to `MSG` in every row (`rooms`, `room_members`, `messages`, `message_reads`, `legal_holds`,
`firms`, `users`, plus the attachment reference lookups; `data.messaging.*`; `plant.snapshotMany`;
subjects `room:<roomId>` and `q:<instrumentId>`; field ids `[PX_LAST, CHG_NET_1D, CHG_PCT_1D, LAST_TRADE_TIME]`).
The alias adds and removes nothing: it selects a view of an already-resolved payload.

#### Resolver
`packages/server/src/functions/MSG/resolve.ts`, unchanged — steps 1–11 of the `MSG` entry run exactly as
written, with `params.view === 'rooms'`. Step 3's active-room selection still runs (so `IB` lands on the
room list **with** the most recent room loaded behind it and one `GO` away), and step 4 still honours
`params.to`. Same budget: 3 DB round-trips, zero provider calls, first paint < 500 ms p95.

#### Live
Identical `LiveSpec` to `MSG`: every `room:<roomId>` in `rooms[]` plus the active room's attachment
`q:` subjects, `fields ['PX_LAST','CHG_NET_1D','CHG_PCT_1D','LAST_TRADE_TIME']`, `conflationMs: 250`,
`essential: [active.room.subject]`. Because `view:'rooms'` renders `grid#rooms` full width, the unread
counters of every room are the visible live surface: a `msg` frame for a non-active room bumps that row's
`unread` cell and re-sorts the grid on `lastMessageAt` (TERM-08 flash applies to the `unread` cell).

#### Screen
`packages/web/src/screens/MSG/Screen.tsx`, branch `view === 'rooms'` (specified in the `MSG` Screen
section). The alias changes exactly three rendered strings and the initial focus:
title `IB · Instant Bloomberg · <me.displayName> @ <me.firmName>` (the shell substitutes the launched
alias into the title through `ScreenProps.ctx` — `MSG` renders `MSG · Messaging · …`); the footer note
`IB and MSG are the same screen`; `initialFocus:'rooms'` instead of `'composer'`. Layout, formats,
skeleton, badges and the rendering of `meta.entitlement` / `meta.unavailable` are those of the `MSG`
entry's `view:'rooms'` branch.

#### Keyboard
`MSG`'s keymap verbatim (one `keymap` array on one manifest). Only the resting focus differs, so the
first keys a user meets are `Enter` on `grid#rooms` (`open-room`), `Ctrl+ArrowUp`/`Ctrl+ArrowDown`
(`prev-room`/`next-room`), `Alt+U` (`toggle-unread`), `Alt+N` (`new-room`) and `Alt+D` (`open-directory`);
`Alt+S`/`Alt+F`/`Alt+W` remain composer-scoped and are inert until `Alt+R` or `Enter` opens a room.

#### CSV
`MSG`'s `CsvSpec` verbatim, including the long-format `section` column and `pageable` cursor
(`base64url(JSON.stringify({ roomId, seq }))`, PAGE FWD = older). The filename is computed from the
payload, not the alias, so `IB` with no active room exports `MSG_rooms_20260915T184128Z.csv` and `IB ROOM=1`
exports `MSG_room1_20260915T184128Z.csv` — the file names the manifest, which is what a reviewer diffing
an export against `/admin/export/messages` needs.

#### Help
`HELP IB` renders `MSG`'s `HelpSpec` (`registry.canonical` runs first) with the header line
`IB — alias of MSG (Instant Bloomberg opens on the room list)`. summary, description, params, sources
(`['internal.user','cboe.quotes','yahoo.chart']`) and related (`['HELP','DES','GP','W','PORT']`) are
`MSG`'s; no alias-specific help text exists, so the two can never drift.

#### Unavailable and reason codes
`MSG`'s table applies unchanged. Two of its entries are the ones an `IB` launch meets first, because the
room list is the landing view: `{ field:'active', reason:'NOT_APPLICABLE', detail:'NO_ROOMS: you are not a
member of any room — Alt+N to start one' }` renders as the grid's `emptyText`, and
`{ field:'members[].presence', reason:'NO_SOURCE', detail:'PRESENCE_NOT_AVAILABLE: …' }` renders as the
muted line under the grid, since the room list is where a user would look for who is online.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| alias invariants | `packages/core/test/functions/manifests.test.ts` | `registry.canonical('IB') === 'MSG'` and `registry.canonical('ib') === 'MSG'`; `'IB'` is not a key of `manifests`; `aliasParams.IB` parses under `MsgParams`; no other manifest claims `IB` or `CHAT` |
| command parse | `packages/core/test/command/parser.test.ts` | `parse('IB')[0]` → `{ code:'MSG', alias:'IB', params:{ view:'rooms' } }`; `parse('IB VIEW=SPLIT')[0].params.view === 'split'`; `parse('IB jane.doe')[0].params.to === 'jane.doe'`; with no security loaded, `rank('IB')` puts `IBM US Equity` above the `IB` function row |
| golden payload | `packages/server/test/integration/functions/MSG.golden.test.ts` | the `IB` launch at the frozen clock deep-equals `fixtures/golden/functions/MSG.rooms.json`, which differs from `MSG.default.json` in `view` only (asserted field-by-field, not by re-recording) |
| runner alias | `packages/server/test/integration/functions/runner.test.ts` | `POST /api/v1/functions/IB/run` returns `200` with `meta` whose cached result has `code:'MSG'`, `alias:'IB'`; the `usage_events` row is `kind:'fn.launch'`, `code:'MSG'`, `details.alias:'IB'` (FUNC-04) |
| screen | `packages/web/test/screens/MSG.test.tsx` | the `view:'rooms'` branch titles `IB · Instant Bloomberg · …` when launched as `IB`, focuses `grid#rooms`, renders no composer, and bumps a non-active room's `unread` on a replayed `msg` frame |
| e2e | `packages/e2e/tests/messaging.spec.ts` | `IB <GO>` lands on the room list with both seeded rooms; `Enter` on `Demo Capital` opens the transcript; `MSG <GO>` in the same panel returns to the split view with the same room loaded (TERM-03 panel context) |
