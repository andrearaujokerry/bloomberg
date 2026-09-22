/**
 * `ws/protocol.ts` — the WebSocket codec (API.md §6.2 L868-915, §6.7 L1013-1029).
 *
 * Every frame in either direction crosses this module and nothing else on the server calls
 * `JSON.parse` or `JSON.stringify` on a WebSocket frame. The schemas in `@terminal/sdk/wire/ws` are
 * normative, so the codec is deliberately thin:
 *
 * - {@link encode} validates a server frame through `ServerMsg.parse` **before** stringifying. A
 *   frame the server itself built that fails its own schema is a bug in the builder — a client that
 *   silently received an off-schema frame would diverge from the wire contract with no way to tell —
 *   so it throws {@link ProtocolEncodeError} rather than shipping the bytes.
 * - {@link decode} validates a client frame through `ClientMsg.safeParse` and **never throws**: a
 *   client can send anything, so a bad frame is data, not an exception. The caller turns the
 *   returned code into `err { fatal:true }` followed by close `4002 PROTOCOL_ERROR` (API.md §6.7).
 *   The size ceilings are checked here too, before the JSON parser sees the text, and they are
 *   per message type ({@link clientFrameLimit}): API.md §6.7 gives client frames 64 KiB **and**
 *   `sub` its own 1 MiB, which §6.4 relies on — "a single `sub` may carry up to 10 000 subjects
 *   with up to 100 fields each" does not fit in 64 KiB. `unsub` and `resync` carry the same
 *   subject arrays and share the 1 MiB ceiling. Because the type is only known after parsing,
 *   {@link decode} admits text up to {@link MAX_CLIENT_FRAME_HARD_BYTES} (the socket's own
 *   `maxPayload`) and reports the frame's size, and the caller applies the per-type ceiling: a
 *   `sub` over its ceiling is answered with `subAck.rejected[].code = 'LIMIT'` (§6.6), never with
 *   a close, since a schema-valid frame is not "a frame that fails `ClientMsg`" (§6.7's `4002`).
 * - {@link frameBytes} is the one measurement of encoded size, used by `ws/conflator.ts` to split a
 *   flush at the 1 MiB `batch` cap (API.md §6.4 snapshot-burst exception).
 *
 * `ClientMsg.parse` applies the schema defaults (`conflationMs: 250`, `resume: false`,
 * `essential: true`), so the session sees a fully-populated frame and never re-implements a default.
 */

import { ClientMsg, ServerMsg } from '@terminal/sdk/wire/ws';
import type { ZodError } from 'zod';

/** Client frames are capped at 64 KiB (API.md §6.7 L1015). */
export const MAX_CLIENT_FRAME_BYTES = 64 * 1024;

/** `sub` — and `unsub`/`resync`, the other subject-array frames — are capped at 1 MiB (§6.7). */
export const MAX_SUBJECT_FRAME_BYTES = 1024 * 1024;

/**
 * The largest client frame that is ever parsed: the `maxPayload` of the `WebSocketServer` in
 * `ws/gateway.ts`. `ws` drops anything larger before this module sees it.
 */
export const MAX_CLIENT_FRAME_HARD_BYTES = 2 * 1024 * 1024;

/** The subject-array client frames, which carry the 1 MiB ceiling rather than the 64 KiB one. */
const SUBJECT_FRAME_TYPES: ReadonlySet<ClientMsg['t']> = new Set<ClientMsg['t']>([
  'sub',
  'unsub',
  'resync',
]);

/** The size ceiling that applies to a client frame of type `t` (API.md §6.7). */
export function clientFrameLimit(t: ClientMsg['t']): number {
  return SUBJECT_FRAME_TYPES.has(t) ? MAX_SUBJECT_FRAME_BYTES : MAX_CLIENT_FRAME_BYTES;
}

/** `batch` frames are capped at 1 MiB and split when larger (API.md §6.4, §6.7 L1015). */
export const MAX_BATCH_FRAME_BYTES = 1024 * 1024;

/** Why a client frame was refused. All three are answered with `err { fatal:true }` then `4002`. */
export type DecodeFailureCode = 'FRAME_TOO_LARGE' | 'BAD_JSON' | 'BAD_FRAME';

export type DecodeResult =
  | { ok: true; msg: ClientMsg; bytes: number }
  | { ok: false; code: DecodeFailureCode; message: string; bytes: number };

/** Thrown by {@link encode} when the server built a frame that is not a `ServerMsg`. */
export class ProtocolEncodeError extends Error {
  readonly issues: string;

  constructor(issues: string) {
    super(`ws/protocol.ts#encode: frame does not satisfy ServerMsg — ${issues}`);
    this.name = 'ProtocolEncodeError';
    this.issues = issues;
  }
}

/** Encoded size of `text` in bytes (UTF-8), the unit every frame limit is expressed in. */
export function frameBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Validate and serialise one server frame.
 *
 * @throws {ProtocolEncodeError} when `msg` fails `ServerMsg` — a server-side bug, never a client's
 * doing.
 */
export function encode(msg: ServerMsg): string {
  const parsed = ServerMsg.safeParse(msg);
  if (!parsed.success) throw new ProtocolEncodeError(describeIssues(parsed.error));
  return JSON.stringify(parsed.data);
}

/**
 * Validate and parse one client frame. Never throws.
 *
 * The per-type ceiling of {@link clientFrameLimit} is the caller's to apply — it needs the parsed
 * frame to answer a `sub` with `LIMIT` — so `maxBytes` here is only the hard bound past which no
 * text is parsed at all.
 *
 * @param text the raw frame payload
 * @param maxBytes hard size ceiling; defaults to {@link MAX_CLIENT_FRAME_HARD_BYTES}
 */
export function decode(text: string, maxBytes: number = MAX_CLIENT_FRAME_HARD_BYTES): DecodeResult {
  const bytes = frameBytes(text);
  if (bytes > maxBytes) {
    return {
      ok: false,
      code: 'FRAME_TOO_LARGE',
      message: `client frame is ${bytes} bytes, limit is ${maxBytes}`,
      bytes,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      code: 'BAD_JSON',
      message: err instanceof Error ? err.message : 'bad JSON',
      bytes,
    };
  }

  const parsed = ClientMsg.safeParse(json);
  if (!parsed.success) {
    return { ok: false, code: 'BAD_FRAME', message: describeIssues(parsed.error), bytes };
  }
  return { ok: true, msg: parsed.data, bytes };
}

/** A compact, log-safe rendering of a zod failure: `path: message`, at most five issues. */
function describeIssues(error: ZodError): string {
  const shown = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${path}: ${issue.message}`;
  });
  const extra =
    error.issues.length > shown.length ? ` (+${error.issues.length - shown.length})` : '';
  return `${shown.join('; ')}${extra}`;
}
