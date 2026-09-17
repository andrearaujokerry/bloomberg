/**
 * `wire/ws.ts` — the WebSocket protocol vocabulary.
 *
 * `ClientMsg` and `ServerMsg` are transcribed **verbatim** from API.md §6.2 L868-915 (itself verbatim
 * from ARCHITECTURE §6.4). Every frame in either direction is encoded and decoded strictly through
 * these schemas: `server/src/ws/protocol.ts` (WP-06) and `sdk/src/client/ws.ts` (WP-13).
 *
 * `ClientMsg` has exactly seven members: hello, sub, unsub, resync, conflation, essential, ping.
 * `ServerMsg` has exactly fourteen: welcome, subAck, snap, delta, status, batch, downgrade, resync,
 * notice, alert, msg, err, pong, bye.
 *
 * `z.record(FieldId, …)` is a partial record (zod 4 treats a pattern-string key as non-exhaustive).
 * The `alert` and `msg` payloads are validated by the SDK with `Rest.Alerts.AlertEvent` and
 * `Rest.Messages.Message` respectively (API.md L913-915) — hence `z.unknown()` here, which keeps this
 * module free of any dependency on `wire/rest/*`.
 */
import { z } from 'zod';

import {
  AssetClass,
  FieldId,
  FieldValue,
  SessionState,
  SubjectId,
  Tier,
  ValueState,
} from './envelope.js';
import { ReasonCode } from './reasonCodes.js';

/**
 * Subject identifier — `^(q|l|b1m|oc|c|r|e|n|alerts|room|sys):[A-Za-z0-9_.:-]+$` (ARCHITECTURE §6.1).
 * Families: `q` quote, `l` level-2 line, `b1m` one-minute bar, `oc` option chain, `c` chart,
 * `r` reference, `e` econ, `n` news, `alerts` alert fan-out, `room` chat room, `sys` server notices.
 * Defined in `wire/envelope.ts` (the common vocabulary) and re-exported here because every frame
 * below is keyed on it.
 */
export { SubjectId, SUBJECT_ID_PATTERN } from './envelope.js';

/** The only protocol version served by v1 (API.md §11). */
export const WS_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// API.md §6.2 L872-910 — verbatim
// ---------------------------------------------------------------------------

export const ClientMsg = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    protocol: z.literal(1),
    client: z.string(),
    token: z.string().optional(),
    conflationMs: z.number().int().min(50).max(5000).default(250),
    resume: z.boolean().default(false),
    traceId: z.string().optional(),
  }),
  z.object({
    t: z.literal('sub'),
    id: z.number().int(),
    subjects: z
      .array(
        z.object({
          s: SubjectId,
          f: z.array(FieldId).max(100),
          essential: z.boolean().default(true),
          known: z.number().int().optional(),
        }),
      )
      .max(10000),
    tier: Tier.optional(),
  }),
  z.object({ t: z.literal('unsub'), subjects: z.array(SubjectId) }),
  z.object({ t: z.literal('resync'), subjects: z.array(SubjectId) }),
  z.object({ t: z.literal('conflation'), ms: z.number().int().min(50).max(5000) }),
  z.object({ t: z.literal('essential'), subjects: z.array(SubjectId), essential: z.boolean() }), // viewport changes
  z.object({ t: z.literal('ping'), n: z.number().int() }),
]);

export const Ts = z.object({ src: z.number().nullable(), cap: z.number(), pub: z.number() }); // FEED-05 three timestamps, epoch ms
export const Prov = z.object({ p: z.string(), id: z.number(), seq: z.number().optional() }); // sourceId, provenanceId, provider seq (Cboe seqno)
export const Snap = z.object({
  t: z.literal('snap'),
  s: SubjectId,
  seq: z.number().int(),
  tier: Tier,
  reason: ReasonCode,
  f: z.record(FieldId, FieldValue),
  fts: z.record(FieldId, z.number()).optional(),
  r: z.record(FieldId, ReasonCode).optional(), // per-field denials → field is null and blank (ENTL-05)
  ts: Ts,
  st: ValueState,
  session: SessionState,
  prov: Prov,
  ac: AssetClass,
  id: z.number().nullable(),
});
export const Delta = z.object({
  t: z.literal('delta'),
  s: SubjectId,
  seq: z.number().int(),
  prev: z.number().int(),
  f: z.record(FieldId, FieldValue),
  fts: z.record(FieldId, z.number()).optional(),
  ts: Ts,
  st: ValueState,
  prov: Prov.optional(),
});
export const Status = z.object({
  t: z.literal('status'),
  s: SubjectId,
  st: z.enum(['pending', 'stale', 'halted', 'closed', 'blank', 'shed', 'gone']),
  reason: z.string().optional(),
  ts: z.number(),
});
export const ServerMsg = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('welcome'),
    sessionId: z.string(),
    serverTime: z.number(),
    protocol: z.literal(1),
    conflationMs: z.number(),
    heartbeatMs: z.number(),
    limits: z.object({ maxSubscriptions: z.number(), maxFields: z.number() }),
  }),
  z.object({
    t: z.literal('subAck'),
    id: z.number().int(),
    accepted: z.array(z.object({ s: SubjectId, tier: Tier, reason: ReasonCode })),
    rejected: z.array(
      z.object({
        s: SubjectId,
        code: z.enum([
          'SUBJECT_UNKNOWN',
          'NOT_ENTITLED',
          'QUOTA_EXCEEDED',
          'FIELD_UNKNOWN',
          'LIMIT',
        ]),
        reason: z.string(),
      }),
    ),
    traceId: z.string(),
  }),
  Snap,
  Delta,
  Status,
  z.object({ t: z.literal('batch'), m: z.array(z.union([Snap, Delta, Status])) }),
  z.object({
    t: z.literal('downgrade'),
    s: SubjectId.optional(),
    from: Tier,
    to: Tier.nullable(),
    reason: ReasonCode,
  }),
  z.object({ t: z.literal('resync'), subjects: z.array(SubjectId).optional() }), // server asks client to re-sub (plant restart)
  z.object({
    t: z.literal('notice'),
    kind: z.enum(['slow-consumer', 'overload', 'maintenance']),
    action: z.enum(['conflation-widened', 'conflation-restored', 'shed', 'disconnect-soon']),
    conflationMs: z.number().optional(),
    detail: z.string().optional(),
  }),
  z.object({
    t: z.literal('alert'),
    alertId: z.string(),
    firedAt: z.number(),
    payload: z.unknown(),
  }), // payload = Rest AlertEvent (§5.11)
  z.object({ t: z.literal('msg'), room: z.string(), message: z.unknown() }), // message = Rest Message (§5.10)
  z.object({
    t: z.literal('err'),
    code: z.string(),
    message: z.string(),
    traceId: z.string(),
    fatal: z.boolean(),
  }),
  z.object({ t: z.literal('pong'), n: z.number().int(), serverTime: z.number() }),
  z.object({ t: z.literal('bye'), code: z.number().int(), reason: z.string() }),
]);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

/** Decoded (post-default) client frame — what the server sees after `ClientMsg.parse()`. */
export type ClientMsg = z.infer<typeof ClientMsg>;
/** Encodable client frame — defaults may be omitted by the caller. */
export type ClientMsgInput = z.input<typeof ClientMsg>;
export type ServerMsg = z.infer<typeof ServerMsg>;
export type ServerMsgInput = z.input<typeof ServerMsg>;

export type Ts = z.infer<typeof Ts>;
export type Prov = z.infer<typeof Prov>;
export type Snap = z.infer<typeof Snap>;
export type Delta = z.infer<typeof Delta>;
export type Status = z.infer<typeof Status>;

/** `t` discriminator values, for exhaustive switches and for tests. */
export type ClientMsgType = ClientMsg['t'];
export type ServerMsgType = ServerMsg['t'];

export const CLIENT_MSG_TYPES = [
  'hello',
  'sub',
  'unsub',
  'resync',
  'conflation',
  'essential',
  'ping',
] as const satisfies readonly ClientMsgType[];

export const SERVER_MSG_TYPES = [
  'welcome',
  'subAck',
  'snap',
  'delta',
  'status',
  'batch',
  'downgrade',
  'resync',
  'notice',
  'alert',
  'msg',
  'err',
  'pong',
  'bye',
] as const satisfies readonly ServerMsgType[];

/** Narrow a decoded frame by its `t` discriminator. */
export type ClientMsgOf<T extends ClientMsgType> = Extract<ClientMsg, { t: T }>;
export type ServerMsgOf<T extends ServerMsgType> = Extract<ServerMsg, { t: T }>;

// ---------------------------------------------------------------------------
// Close codes — API.md §6.7 L1018-1029
// ---------------------------------------------------------------------------

/**
 * The close codes this protocol uses. `bye.code` carries the same number in-band immediately before
 * the socket closes, so a client that loses the close frame still learns why.
 */
export const WS_CLOSE = {
  /** client close / logout */
  NORMAL: 1000,
  /** SIGTERM; clients reconnect with backoff and resync (OPS-02) */
  SERVER_SHUTDOWN: 1001,
  /** no `ping` for 45 s */
  IDLE: 4000,
  /** no/invalid session, `hello` missing within 5 s, token revoked */
  AUTH_REQUIRED: 4001,
  /** frame fails `ClientMsg` (an `err { fatal:true }` precedes it) */
  PROTOCOL_ERROR: 4002,
  /** another web login for this user, or a newer socket on this session */
  SESSION_SUPERSEDED: 4003,
  /** §6.5 ladder exhausted */
  SLOW_CONSUMER: 4008,
  /** `hello.protocol` not in the served set (§11) */
  PROTOCOL_VERSION: 4010,
  /** repeated `sub` beyond `maxSubscriptions` after `LIMIT` rejections */
  SUBSCRIPTION_LIMIT: 4011,
  /** client message rate (20 client messages per second, `4029` after 3 s over the limit) */
  RATE_LIMITED: 4029,
} as const satisfies Record<string, number>;

export type WsCloseName = keyof typeof WS_CLOSE;
export type WsCloseCode = (typeof WS_CLOSE)[WsCloseName];

/** The table of API.md §6.7, in code order: code → name and the condition that produces it. */
export const WS_CLOSE_TABLE: readonly {
  readonly code: WsCloseCode;
  readonly name: WsCloseName;
  readonly when: string;
}[] = [
  { code: WS_CLOSE.NORMAL, name: 'NORMAL', when: 'client close / logout' },
  {
    code: WS_CLOSE.SERVER_SHUTDOWN,
    name: 'SERVER_SHUTDOWN',
    when: 'SIGTERM; clients reconnect with backoff and resync (OPS-02)',
  },
  { code: WS_CLOSE.IDLE, name: 'IDLE', when: 'no ping for 45 s' },
  {
    code: WS_CLOSE.AUTH_REQUIRED,
    name: 'AUTH_REQUIRED',
    when: 'no/invalid session, hello missing within 5 s, token revoked',
  },
  {
    code: WS_CLOSE.PROTOCOL_ERROR,
    name: 'PROTOCOL_ERROR',
    when: 'frame fails ClientMsg (an err { fatal:true } precedes it)',
  },
  {
    code: WS_CLOSE.SESSION_SUPERSEDED,
    name: 'SESSION_SUPERSEDED',
    when: 'another web login for this user, or a newer socket on this session',
  },
  { code: WS_CLOSE.SLOW_CONSUMER, name: 'SLOW_CONSUMER', when: '§6.5 ladder exhausted' },
  {
    code: WS_CLOSE.PROTOCOL_VERSION,
    name: 'PROTOCOL_VERSION',
    when: 'hello.protocol not in the served set (§11)',
  },
  {
    code: WS_CLOSE.SUBSCRIPTION_LIMIT,
    name: 'SUBSCRIPTION_LIMIT',
    when: 'repeated sub beyond maxSubscriptions after LIMIT rejections',
  },
  { code: WS_CLOSE.RATE_LIMITED, name: 'RATE_LIMITED', when: 'client message rate' },
];

/** Name for a close code, or `undefined` if it is not one of ours. */
export function wsCloseName(code: number): WsCloseName | undefined {
  return WS_CLOSE_TABLE.find((row) => row.code === code)?.name;
}

/**
 * True for the close codes a client should reconnect after (with backoff). `AUTH_REQUIRED`,
 * `PROTOCOL_ERROR`, `PROTOCOL_VERSION` and `SESSION_SUPERSEDED` are terminal: reconnecting without
 * new credentials or a new build would loop.
 */
export function wsCloseIsRetryable(code: number): boolean {
  return (
    code === WS_CLOSE.SERVER_SHUTDOWN ||
    code === WS_CLOSE.IDLE ||
    code === WS_CLOSE.SLOW_CONSUMER ||
    code === WS_CLOSE.SUBSCRIPTION_LIMIT ||
    code === WS_CLOSE.RATE_LIMITED
  );
}
