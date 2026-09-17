/**
 * `packages/sdk/test/setup.ts` — the `sdk` vitest project's setup file (TESTING.md §2.1 L98).
 *
 * Two jobs, both of them about making a `node` environment look enough like a browser for the
 * client code under test:
 *
 *   1. a fake `WebSocket`, because `sdk/src/client/ws.ts` constructs `new WebSocket(url)` and Node's
 *      own global would try to open a real socket. The fake records every frame it was sent and
 *      lets a test push a `ServerMsg` back in, which is all `LiveClient`'s decode path needs.
 *   2. a deterministic `crypto.randomUUID`, so trace ids in assertions are stable. The counter is
 *      reset before each test.
 *
 * Nothing here mocks the SDK itself: the wire schemas and the REST client are exercised for real.
 */
import { beforeEach } from 'vitest';

/** The frames a test pushed into a socket, in order. */
export interface FakeSocketFrame {
  readonly data: string;
}

type Listener = (event: unknown) => void;

/**
 * A `WebSocket` that never touches the network. It opens on the next microtask, records what is
 * sent, and exposes `receive()` / `fail()` so a test drives the other end.
 */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every socket constructed since the last `beforeEach`, in construction order. */
  static instances: FakeWebSocket[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readonly protocol: string;
  readyState = 0;
  binaryType = 'blob';
  /** Everything `send()` was given, in order. */
  readonly sent: FakeSocketFrame[] = [];

  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onclose: Listener | null = null;
  onerror: Listener | null = null;

  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(url: string | URL, protocols?: string | readonly string[]) {
    this.url = String(url);
    this.protocol = typeof protocols === 'string' ? protocols : (protocols?.[0] ?? '');
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== this.CONNECTING) return;
      this.readyState = this.OPEN;
      this.#emit('open', { type: 'open' });
    });
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.#listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push({ data: typeof data === 'string' ? data : String(data) });
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.#emit('close', { type: 'close', code, reason, wasClean: code === 1000 });
  }

  /** Deliver a frame from the server side. Objects are JSON-encoded first. */
  receive(payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.#emit('message', { type: 'message', data });
  }

  /** Fail the socket the way a transport error does: `error`, then a non-clean `close`. */
  fail(code = 1006, reason = 'abnormal closure'): void {
    this.#emit('error', { type: 'error' });
    this.readyState = this.CLOSED;
    this.#emit('close', { type: 'close', code, reason, wasClean: false });
  }

  #emit(type: string, event: unknown): void {
    const handler = (this as unknown as Record<string, Listener | null | undefined>)[`on${type}`];
    if (typeof handler === 'function') handler.call(this, event);
    for (const listener of this.#listeners.get(type) ?? []) listener.call(this, event);
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.WebSocket = FakeWebSocket;

// ── Deterministic uuids ───────────────────────────────────────────────────────────────────────
let uuidCounter = 0;

/** `'00000000-0000-4000-8000-00000000000n'` — a valid v4 shape, so `z.uuid()` still accepts it. */
export function nextTestUuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, '0')}`;
}

const cryptoObject = globalThis.crypto as unknown as { randomUUID?: () => string };
cryptoObject.randomUUID = nextTestUuid;

beforeEach(() => {
  FakeWebSocket.instances = [];
  uuidCounter = 0;
});
