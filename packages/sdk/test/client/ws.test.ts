/**
 * `LiveClient` against the recorded exchange of API.md §6.8 (L1031-1057).
 *
 * Every server frame below is transcribed from that exchange — the `cboe-quote-AAPL` poll's own
 * `seq` values, prices, timestamps and provenance — so this file and
 * `packages/server/test/integration/ws/{handshake,resync}.test.ts` are the two halves of one
 * protocol: the server suite drives a real socket against the real gateway and asserts what goes out;
 * this one asserts that the client agrees with it frame for frame, without a socket and without
 * waiting.
 *
 * Determinism (TESTING.md §1): a `VirtualClock` and an injected timer queue, so the 250 ms → 8 s
 * backoff ladder is asserted by reading what was *scheduled* rather than by sleeping through it; a
 * manual frame pump, so the per-animation-frame `sub`/`unsub`/`resync` batch is driven; the
 * `FakeWebSocket` of `test/setup.ts`, so no real socket is ever opened. Nothing here waits on
 * `setTimeout`.
 *
 * The centre of gravity is the prev-chain check (§6.3 step 3). The assertions that matter are not
 * that a `resync` frame appears — it is that the gapped delta's value is **not on the screen**
 * afterwards, that the subject then stays quiet until its `snap`, and that a duplicate is dropped
 * without asking for anything. A test that only counted `resync` frames would pass over an
 * implementation that sent one and applied the delta anyway, which is the bug the rule exists to
 * prevent.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { VirtualClock } from '@terminal/core';

import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  backoffDelayMs,
  LiveClient,
  liveUrl,
  QuoteCache,
  type DowngradeEvent,
  type LiveCloseEvent,
  type LiveErrorEvent,
  type LiveState,
  type LiveTimers,
  type Notice,
  type StatusEvent,
} from '../../src/client/ws.js';
import type { UpdateEvent } from '../../src/client/subscriptions.js';
import type { ClientOptions } from '../../src/client/rest.js';
import { ClientMsg } from '../../src/wire/ws.js';
import { FakeWebSocket } from '../setup.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The recorded exchange (API.md §6.8), verbatim
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SUBJECT = 'q:42';
const QUOTE_FIELDS = ['PX_LAST', 'PX_BID', 'PX_ASK', 'PX_VOLUME', 'CHG_PCT_1D'];
const SERVER_TIME = 1_789_497_943_123;

const WELCOME = {
  t: 'welcome',
  sessionId: '7f3c9a1e4b6d4f2a8c5e0b17d9f3a642',
  serverTime: SERVER_TIME,
  protocol: 1,
  conflationMs: 250,
  heartbeatMs: 15_000,
  limits: { maxSubscriptions: 10_000, maxFields: 100 },
} as const;

const SUB_ACK_1 = {
  t: 'subAck',
  id: 1,
  accepted: [{ s: SUBJECT, tier: 'delayed', reason: 'SOURCE_TIER_CAP' }],
  rejected: [],
  traceId: '00000000-0000-4000-8000-000000000001',
} as const;

/** The recorded snapshot: `seq` 4182, the Cboe poll's own five fields. */
const SNAP_4182 = {
  t: 'snap',
  s: SUBJECT,
  seq: 4182,
  tier: 'delayed',
  reason: 'SOURCE_TIER_CAP',
  f: {
    PX_LAST: 330.27,
    PX_BID: 330.25,
    PX_ASK: 330.28,
    PX_VOLUME: 16_591_786,
    CHG_PCT_1D: -0.8436,
  },
  fts: {
    PX_LAST: 1_789_489_586_000,
    PX_BID: 1_789_489_586_000,
    PX_ASK: 1_789_489_586_000,
    PX_VOLUME: 1_789_489_586_000,
    CHG_PCT_1D: 1_789_489_586_000,
  },
  ts: { src: 1_789_489_586_000, cap: 1_789_497_688_412, pub: 1_789_497_688_413 },
  st: 'live',
  session: 'open',
  prov: { p: 'cboe.quotes', id: 88_213, seq: 15_972_883_317 },
  ac: 'equity',
  id: 42,
} as const;

/** The recorded delta: `seq` 4185 chained to `prev` 4182. */
const DELTA_4185 = {
  t: 'delta',
  s: SUBJECT,
  seq: 4185,
  prev: 4182,
  f: { PX_LAST: 330.31, PX_VOLUME: 16_601_102 },
  ts: { src: 1_789_489_601_000, cap: 1_789_497_703_400, pub: 1_789_497_703_401 },
  st: 'live',
} as const;

const NOTICE_WIDENED = {
  t: 'notice',
  kind: 'slow-consumer',
  action: 'conflation-widened',
  conflationMs: 500,
} as const;

const STATUS_SHED = {
  t: 'status',
  s: SUBJECT,
  st: 'shed',
  reason: 'SLOW_CONSUMER',
  ts: 1_789_497_720_000,
} as const;

const SUB_ACK_2 = { ...SUB_ACK_1, id: 2 } as const;

/** The fresh snapshot the server always answers a resync with — never replayed deltas (§6.3 step 6). */
const SNAP_4190 = {
  ...SNAP_4182,
  seq: 4190,
  f: { ...SNAP_4182.f, PX_LAST: 330.44, PX_VOLUME: 16_640_915 },
} as const;

/** One subject entry out of a `sub` frame. */
function subEntry(frame: Record<string, unknown>): {
  s: string;
  f: string[];
  known?: number;
  essential?: boolean;
} {
  const subjects = frame.subjects as {
    s: string;
    f: string[];
    known?: number;
    essential?: boolean;
  }[];
  const first = subjects[0];
  if (first === undefined) throw new Error('sub frame carried no subjects');
  return first;
}

/**
 * A field set is a set: `SubscriptionRegistry` canonicalises it (its `fieldsKey` compares held
 * against wire state by joining the ids), so these assertions compare membership, not order.
 */
function asSet(fields: readonly string[]): string[] {
  return [...fields].sort();
}

/** A batch frame around one or more of the above, which is how snaps and deltas actually travel. */
function batch(...m: readonly unknown[]): unknown {
  return { t: 'batch', m };
}

/** A delta for `subject` at `seq`, chained to `prev`. */
function delta(subject: string, seq: number, prev: number, f: Record<string, number>): unknown {
  return {
    t: 'delta',
    s: subject,
    seq,
    prev,
    f,
    ts: { src: 1_789_489_601_000, cap: 1_789_497_703_400, pub: 1_789_497_703_401 },
    st: 'live',
  };
}

/** A snapshot for `subject` at `seq` with one price, for the multi-subject cases. */
function snap(subject: string, seq: number, pxLast: number, id: number): unknown {
  return { ...SNAP_4182, s: subject, seq, id, f: { ...SNAP_4182.f, PX_LAST: pxLast } };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness: a virtual clock, a timer queue, a frame pump, a fake socket
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `LiveTimers` over a `VirtualClock`: nothing fires until a test advances time. */
class TestTimers implements LiveTimers {
  readonly #clock: VirtualClock;
  readonly #entries = new Map<number, { due: number; ms: number; fn: () => void }>();
  #nextHandle = 1;

  constructor(clock: VirtualClock) {
    this.#clock = clock;
  }

  setTimeout(handler: () => void, ms: number): unknown {
    const handle = this.#nextHandle++;
    this.#entries.set(handle, { due: this.#clock.now() + ms, ms, fn: handler });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.#entries.delete(handle);
  }

  /** The delays of every timer still waiting, in the order they were scheduled. */
  pendingMs(): number[] {
    return [...this.#entries.values()].map((entry) => entry.ms);
  }

  /** Advance the clock, running each timer at its own due instant. */
  advance(ms: number): void {
    const target = this.#clock.now() + ms;
    for (;;) {
      const due = [...this.#entries.entries()]
        .filter(([, entry]) => entry.due <= target)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (due === undefined) break;
      this.#entries.delete(due[0]);
      this.#clock.advanceTo(due[1].due);
      due[1].fn();
    }
    if (this.#clock.now() < target) this.#clock.advanceTo(target);
  }
}

/** TESTING.md's manual frame pump, in the SDK's node environment: nothing runs until `flush()`. */
class FramePump {
  readonly #queue: (() => void)[] = [];

  readonly schedule = (callback: () => void): void => {
    this.#queue.push(callback);
  };

  /** Run every callback queued so far; returns how many ran. */
  flush(): number {
    const run = this.#queue.splice(0, this.#queue.length);
    for (const callback of run) callback();
    return run.length;
  }

  get pending(): number {
    return this.#queue.length;
  }
}

interface Recorder {
  readonly states: LiveState[];
  readonly updates: UpdateEvent[];
  readonly statuses: StatusEvent[];
  readonly notices: Notice[];
  readonly downgrades: DowngradeEvent[];
  readonly errors: LiveErrorEvent[];
  readonly closes: LiveCloseEvent[];
}

interface Harness {
  readonly clock: VirtualClock;
  readonly timers: TestTimers;
  readonly pump: FramePump;
  readonly client: LiveClient;
  readonly rec: Recorder;
  /** The newest socket the client opened. */
  socket(): FakeWebSocket;
  /** Every frame that socket was sent, decoded — and proved to satisfy `ClientMsg` on the way. */
  sent(): Record<string, unknown>[];
  /** Those frames whose `t` is `type`. */
  sentOf(type: string): Record<string, unknown>[];
}

const OPTIONS: ClientOptions = {
  baseUrl: 'http://localhost:8080',
  clientVersion: 'web/0.1.0',
  conflationMs: 250,
};

/** One microtask turn — long enough for `FakeWebSocket` to report `open`. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function build(options: Partial<ClientOptions> = {}, random: () => number = () => 0.5): Harness {
  const clock = new VirtualClock(SERVER_TIME);
  const timers = new TestTimers(clock);
  const pump = new FramePump();
  const client = new LiveClient(
    { ...OPTIONS, ...options },
    { clock, timers, scheduleFrame: pump.schedule, random },
  );
  const rec: Recorder = {
    states: [],
    updates: [],
    statuses: [],
    notices: [],
    downgrades: [],
    errors: [],
    closes: [],
  };
  client.on('state', (s) => rec.states.push(s));
  client.on('update', (e) => rec.updates.push(e));
  client.on('status', (e) => rec.statuses.push(e));
  client.on('notice', (e) => rec.notices.push(e));
  client.on('downgrade', (e) => rec.downgrades.push(e));
  client.on('error', (e) => rec.errors.push(e));
  client.on('close', (e) => rec.closes.push(e));

  const socket = (): FakeWebSocket => {
    const found = FakeWebSocket.instances.at(-1);
    if (found === undefined) throw new Error('no socket was opened');
    return found;
  };
  const sent = (): Record<string, unknown>[] =>
    socket().sent.map((frame) => {
      const json = JSON.parse(frame.data) as Record<string, unknown>;
      // Every frame this client puts on the wire must satisfy the schema the server parses with.
      ClientMsg.parse(json);
      return json;
    });
  return {
    clock,
    timers,
    pump,
    client,
    rec,
    socket,
    sent,
    sentOf: (type) => sent().filter((frame) => frame.t === type),
  };
}

/** Connect and take the recorded `welcome`, leaving the client `open` with no subscriptions. */
async function opened(random: () => number = () => 0.5): Promise<Harness> {
  const h = build({}, random);
  const connected = h.client.connect();
  await settle();
  h.socket().receive(WELCOME);
  await connected;
  return h;
}

/** Connect, subscribe to the recorded subject, take `subAck` and the recorded `snap`. */
async function subscribed(): Promise<{ h: Harness; sub: ReturnType<LiveClient['subscribe']> }> {
  const h = await opened();
  const sub = h.client.subscribe([SUBJECT], [...QUOTE_FIELDS]);
  h.pump.flush();
  h.socket().receive(SUB_ACK_1);
  h.socket().receive(batch(SNAP_4182));
  return { h, sub };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. Handshake (API.md §6.3 step 1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('LiveClient — hello / welcome (API.md §6.3 step 1, §6.8)', () => {
  it('opens ws://host/ws/v1 and sends the recorded hello', async () => {
    const h = build();
    expect(h.client.state).toBe('idle');
    const connected = h.client.connect();
    expect(h.client.state).toBe('connecting');
    await settle();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(h.socket().url).toBe('ws://localhost:8080/ws/v1');
    expect(h.sent()[0]).toEqual({
      t: 'hello',
      protocol: 1,
      client: 'web/0.1.0',
      conflationMs: 250,
      resume: false,
    });

    h.socket().receive(WELCOME);
    await connected;

    expect(h.client.state).toBe('open');
    expect(h.client.sessionId).toBe(WELCOME.sessionId);
    expect(h.client.conflationMs).toBe(250);
    expect(h.client.limits).toEqual({ maxSubscriptions: 10_000, maxFields: 100 });
    expect(h.rec.states).toEqual(['connecting', 'open']);
  });

  it('carries the bearer token in hello when one is configured (cookie mode omits it)', async () => {
    const h = build({ token: 'sk-live-abc' });
    void h.client.connect();
    await settle();
    expect(h.sent()[0]).toMatchObject({ token: 'sk-live-abc' });
  });

  it('derives wss:// from an https baseUrl', () => {
    expect(liveUrl('https://terminal.example.com')).toBe('wss://terminal.example.com/ws/v1');
    expect(liveUrl('http://localhost:8080/')).toBe('ws://localhost:8080/ws/v1');
  });

  it('pings every heartbeatMs once open, and never before', async () => {
    const h = await opened();
    expect(h.sentOf('ping')).toHaveLength(0);
    h.timers.advance(15_000);
    expect(h.sentOf('ping')).toEqual([{ t: 'ping', n: 1 }]);
    h.timers.advance(15_000);
    expect(h.sentOf('ping')).toHaveLength(2);
  });

  it('closes on the caller’s word: one close event, cache dropped, no reconnect scheduled', async () => {
    const { h } = await subscribed();
    expect(h.client.get(SUBJECT)).toBeDefined();

    h.client.close();

    expect(h.client.state).toBe('closed');
    expect(h.rec.closes).toEqual([{ code: 1000, reason: 'client-close' }]);
    expect(h.client.get(SUBJECT)).toBeUndefined();
    expect(h.timers.pendingMs()).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. sub / subAck / snap, and unsub (API.md §6.3 step 2, §6.8)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('LiveClient — sub, subAck and exactly one snap (§6.3 step 2)', () => {
  it('sends the recorded sub frame, batched onto one animation frame', async () => {
    const h = await opened();
    h.client.subscribe([SUBJECT], [...QUOTE_FIELDS]);
    expect(h.sentOf('sub')).toHaveLength(0); // nothing goes out before the frame

    expect(h.pump.flush()).toBe(1);
    const subs = h.sentOf('sub');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ t: 'sub', id: 1 });
    const entry = subEntry(subs[0]!);
    expect(entry.s).toBe(SUBJECT);
    expect(asSet(entry.f)).toEqual(asSet(QUOTE_FIELDS));
    // A first subscribe has nothing to resume from, so no `known` is claimed.
    expect(entry).not.toHaveProperty('known');
  });

  it('resolves the ack from subAck and applies the recorded snapshot', async () => {
    const h = await opened();
    const sub = h.client.subscribe([SUBJECT], [...QUOTE_FIELDS]);
    h.pump.flush();
    h.socket().receive(SUB_ACK_1);

    await expect(sub.ack).resolves.toEqual({
      accepted: [{ s: SUBJECT, tier: 'delayed', reason: 'SOURCE_TIER_CAP' }],
      rejected: [],
    });

    h.socket().receive(batch(SNAP_4182));

    expect(h.rec.updates).toHaveLength(1);
    const update = h.rec.updates[0]!;
    expect(update.kind).toBe('snap');
    expect(update.subject).toBe(SUBJECT);
    expect(update.seq).toBe(4182);
    expect([...update.changed].sort()).toEqual([...QUOTE_FIELDS].sort());

    const view = h.client.get(SUBJECT)!;
    expect(view.f).toEqual(SNAP_4182.f);
    expect(view.tier).toBe('delayed');
    expect(view.reason).toBe('SOURCE_TIER_CAP');
    expect(view.st).toBe('live');
    expect(view.session).toBe('open');
    expect(view.prov).toEqual(SNAP_4182.prov);
    expect(view.instrumentId).toBe(42);
    expect(view.assetClass).toBe('equity');
  });

  it('get(subject) reads the client’s own quoteCache — the same instance, never a copy', async () => {
    const { h } = await subscribed();
    expect(h.client.quoteCache).toBeInstanceOf(QuoteCache);
    expect(h.client.get(SUBJECT)).toBe(h.client.quoteCache.get(SUBJECT));

    // And an injected cache is the one applied into, so a host that owns a cache sees the writes.
    const shared = new QuoteCache();
    const other = new LiveClient(OPTIONS, { quoteCache: shared });
    expect(other.quoteCache).toBe(shared);
  });

  it('applies the recorded delta onto the snapshot and leaves untouched fields alone', async () => {
    const { h } = await subscribed();
    h.socket().receive(batch(DELTA_4185));

    expect(h.rec.updates).toHaveLength(2);
    const update = h.rec.updates[1]!;
    expect(update.kind).toBe('delta');
    expect(update.seq).toBe(4185);
    expect([...update.changed].sort()).toEqual(['PX_LAST', 'PX_VOLUME']);

    const view = h.client.get(SUBJECT)!;
    expect(view.f.PX_LAST).toBe(330.31);
    expect(view.f.PX_VOLUME).toBe(16_601_102);
    expect(view.f.PX_BID).toBe(330.25); // absent from `f` means unchanged (§6.3 step 4)
    expect(view.seq).toBe(4185);
  });

  it('fans updates out to the subscription that asked for the field, and to no other', async () => {
    const h = await opened();
    const prices = h.client.subscribe([SUBJECT], ['PX_LAST']);
    const volume = h.client.subscribe([SUBJECT], ['PX_VOLUME']);
    h.pump.flush();
    h.socket().receive(SUB_ACK_1);
    h.socket().receive(batch(SNAP_4182));

    const toPrices: UpdateEvent[] = [];
    const toVolume: UpdateEvent[] = [];
    prices.on('update', (e) => toPrices.push(e));
    volume.on('update', (e) => toVolume.push(e));

    h.socket().receive(batch(delta(SUBJECT, 4185, 4182, { PX_LAST: 330.31 })));
    expect(toPrices).toHaveLength(1);
    expect(toPrices[0]!.changed).toEqual(['PX_LAST']);
    expect(toVolume).toHaveLength(0);
  });

  it('ref-counts: two holders, one unsub frame, and only when the last one lets go', async () => {
    const h = await opened();
    const first = h.client.subscribe([SUBJECT], [...QUOTE_FIELDS]);
    const second = h.client.subscribe([SUBJECT], [...QUOTE_FIELDS]);
    h.pump.flush();
    h.socket().receive(SUB_ACK_1);
    h.socket().receive(batch(SNAP_4182));
    expect(h.sentOf('sub')).toHaveLength(1); // two holders, one frame (TERM-04)

    first.unsubscribe();
    h.pump.flush();
    expect(h.sentOf('unsub')).toHaveLength(0);

    second.unsubscribe();
    h.pump.flush();
    expect(h.sentOf('unsub')).toEqual([{ t: 'unsub', subjects: [SUBJECT] }]);
    // The hold is gone, so the view goes with it: a cell cannot show a value nobody subscribes to.
    expect(h.client.get(SUBJECT)).toBeUndefined();
  });

  it('refuses a subject that is not a subject id, and a field that is not a field id', async () => {
    const h = await opened();
    expect(() => h.client.subscribe(['AAPL US Equity'], ['PX_LAST'])).toThrow(/not a subject id/);
    expect(() => h.client.subscribe([SUBJECT], ['px last'])).toThrow(/not a field id/);
    expect(h.sentOf('sub')).toHaveLength(0);
  });

  it('reports a rejected subject rather than letting it vanish', async () => {
    const h = await opened();
    const sub = h.client.subscribe(['q:99'], [...QUOTE_FIELDS]);
    h.pump.flush();
    h.socket().receive({
      t: 'subAck',
      id: 1,
      accepted: [],
      rejected: [{ s: 'q:99', code: 'SUBJECT_UNKNOWN', reason: 'instrument not found' }],
      traceId: 'trace-1',
    });

    await expect(sub.ack).resolves.toMatchObject({
      rejected: [{ s: 'q:99', code: 'SUBJECT_UNKNOWN' }],
    });
    expect(h.rec.errors).toEqual([
      {
        code: 'SUBJECT_UNKNOWN',
        message: 'sub rejected for q:99: instrument not found',
        traceId: 'trace-1',
        fatal: false,
      },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. The prev-chain check (API.md §6.3 step 3) — the heart of the file
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('LiveClient — the prev-chain check (§6.3 step 3)', () => {
  it('a gapped delta is never applied: it asks for a resync and the old value stays on screen', async () => {
    const { h } = await subscribed();
    expect(h.client.get(SUBJECT)!.f.PX_LAST).toBe(330.27);

    // The delta at 4185 is lost in transit; the next one chains to it, not to what we hold.
    h.socket().receive(batch(delta(SUBJECT, 4188, 4185, { PX_LAST: 999.99 })));

    // The point of the rule: the number that arrived out of chain is not on the screen.
    expect(h.client.get(SUBJECT)!.f.PX_LAST).toBe(330.27);
    expect(h.client.get(SUBJECT)!.seq).toBe(4182);
    expect(h.rec.updates).toHaveLength(1); // the snap, and nothing since
    expect(h.client.stats.resyncs).toBe(1);

    // And it is loud: the state says so before any frame goes out.
    expect(h.client.state).toBe('resyncing');
    expect(h.rec.states).toEqual(['connecting', 'open', 'resyncing']);

    expect(h.pump.flush()).toBe(1);
    expect(h.sentOf('resync')).toEqual([{ t: 'resync', subjects: [SUBJECT] }]);
  });

  it('after the gap the subject stays quiet until its snap, and asks only once', async () => {
    const { h } = await subscribed();
    h.socket().receive(batch(delta(SUBJECT, 4188, 4185, { PX_LAST: 999.99 })));
    h.pump.flush();
    expect(h.sentOf('resync')).toHaveLength(1);

    // A perfectly chained delta *after* the gap is still ignored: the chain cannot heal itself.
    h.socket().receive(batch(delta(SUBJECT, 4189, 4188, { PX_LAST: 888.88 })));
    h.pump.flush();
    expect(h.client.get(SUBJECT)!.f.PX_LAST).toBe(330.27);
    expect(h.rec.updates).toHaveLength(1);
    expect(h.sentOf('resync')).toHaveLength(1); // asked once, not once per delta

    // Only a snap re-bases it — and the server always answers with one, never replayed deltas.
    h.socket().receive(batch(SNAP_4190));
    expect(h.rec.updates).toHaveLength(2);
    expect(h.rec.updates[1]!.kind).toBe('snap');
    expect(h.client.get(SUBJECT)!.f.PX_LAST).toBe(330.44);
    expect(h.client.get(SUBJECT)!.seq).toBe(4190);
    expect(h.client.state).toBe('open');

    // …and the chain runs on from the snapshot.
    h.socket().receive(batch(delta(SUBJECT, 4193, 4190, { PX_LAST: 330.5 })));
    expect(h.client.get(SUBJECT)!.f.PX_LAST).toBe(330.5);
    expect(h.client.stats.resyncs).toBe(1);
  });

  it('a duplicate delta is dropped in silence — no update, no resync', async () => {
    const { h } = await subscribed();
    h.socket().receive(batch(DELTA_4185));
    expect(h.rec.updates).toHaveLength(2);

    h.socket().receive(batch(DELTA_4185)); // seq <= lastSeq
    h.socket().receive(batch(delta(SUBJECT, 4183, 4182, { PX_LAST: 1 })));

    expect(h.rec.updates).toHaveLength(2);
    expect(h.client.get(SUBJECT)!.f.PX_LAST).toBe(330.31);
    expect(h.client.get(SUBJECT)!.seq).toBe(4185);
    expect(h.client.stats.resyncs).toBe(0);
    expect(h.client.stats.skipped).toBe(2);
    h.pump.flush();
    expect(h.sentOf('resync')).toHaveLength(0);
    expect(h.client.state).toBe('open');
  });

  it('a delta for a subject no snap ever described is a gap, not a first value', async () => {
    const h = await opened();
    h.client.subscribe(['q:77'], [...QUOTE_FIELDS]);
    h.pump.flush();
    h.socket().receive({
      t: 'subAck',
      id: 1,
      accepted: [{ s: 'q:77', tier: 'delayed', reason: 'SOURCE_TIER_CAP' }],
      rejected: [],
      traceId: 'trace-1',
    });
    h.socket().receive(batch(delta('q:77', 900, 899, { PX_LAST: 12.5 })));

    expect(h.client.get('q:77')).toBeUndefined();
    expect(h.rec.updates).toHaveLength(0);
    h.pump.flush();
    expect(h.sentOf('resync')).toEqual([{ t: 'resync', subjects: ['q:77'] }]);
  });

  it('a socket-wide gap costs one resync frame, not one per subject (§6.7 rate limit)', async () => {
    const h = await opened();
    const subjects = ['q:42', 'q:43', 'q:44'];
    h.client.subscribe(subjects, [...QUOTE_FIELDS]);
    h.pump.flush();
    h.socket().receive({
      t: 'subAck',
      id: 1,
      accepted: subjects.map((s) => ({ s, tier: 'delayed', reason: 'SOURCE_TIER_CAP' })),
      rejected: [],
      traceId: 'trace-1',
    });
    h.socket().receive(
      batch(snap('q:42', 4182, 330.27, 42), snap('q:43', 500, 10, 43), snap('q:44', 700, 20, 44)),
    );
    expect(h.rec.updates).toHaveLength(3);

    // One batch, three broken chains.
    h.socket().receive(
      batch(
        delta('q:42', 4188, 4185, { PX_LAST: 1 }),
        delta('q:43', 510, 505, { PX_LAST: 2 }),
        delta('q:44', 710, 705, { PX_LAST: 3 }),
      ),
    );
    expect(h.rec.updates).toHaveLength(3);
    expect(h.client.stats.resyncs).toBe(3);

    expect(h.pump.flush()).toBe(1);
    const resyncs = h.sentOf('resync');
    expect(resyncs).toHaveLength(1);
    expect(resyncs[0]).toEqual({ t: 'resync', subjects });
  });

  it('a server-initiated resync re-subs with known and sends nothing until it does (§6.3 step 7)', async () => {
    const { h } = await subscribed();
    h.socket().receive(batch(DELTA_4185));
    expect(h.client.get(SUBJECT)!.seq).toBe(4185);
    const before = h.sentOf('sub').length;

    h.socket().receive({ t: 'resync', subjects: [SUBJECT] });

    expect(h.client.state).toBe('resyncing');
    const resubs = h.sentOf('sub').slice(before);
    expect(resubs).toHaveLength(1);
    expect(subEntry(resubs[0]!)).toMatchObject({ s: SUBJECT, known: 4185 });
    expect(asSet(subEntry(resubs[0]!).f)).toEqual(asSet(QUOTE_FIELDS));
    // The client asked to be re-based; it does not ask the server for a resync as well.
    h.pump.flush();
    expect(h.sentOf('resync')).toHaveLength(0);

    h.socket().receive(SUB_ACK_2);
    h.socket().receive(batch(SNAP_4190));
    expect(h.client.state).toBe('open');
    expect(h.client.get(SUBJECT)!.seq).toBe(4190);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. Reconnect (API.md §6.3 step 6, BUS-07)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('LiveClient — reconnect backoff 250 ms → 8 s, jittered (BUS-07)', () => {
  it('climbs 250, 500, 1 000, 2 000, 4 000, 8 000 and stays at the ceiling', async () => {
    const { h } = await subscribed();
    const ladder: number[] = [];

    for (let attempt = 0; attempt < 7; attempt += 1) {
      h.socket().fail();
      // The heartbeat is cancelled by the close, so the only timer left is the backoff.
      const pending = h.timers.pendingMs();
      expect(pending).toHaveLength(1);
      ladder.push(pending[0]!);
      expect(h.client.state).toBe('resyncing');
      h.timers.advance(pending[0]!);
      await settle();
    }

    expect(ladder).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 8_000]);
    expect(h.client.stats.reconnects).toBe(7);
    expect(FakeWebSocket.instances).toHaveLength(8);
  });

  it('keeps every jittered delay inside the documented bounds, and actually varies it', () => {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const low = backoffDelayMs(attempt, () => 0);
      const high = backoffDelayMs(attempt, () => 1);
      const mid = backoffDelayMs(attempt, () => 0.5);
      expect(low).toBeGreaterThanOrEqual(BACKOFF_MIN_MS);
      expect(high).toBeLessThanOrEqual(BACKOFF_MAX_MS);
      expect(low).toBeLessThanOrEqual(mid);
      expect(mid).toBeLessThanOrEqual(high);
    }
    // Jitter is what breaks the thundering herd, so it must not be a no-op in the middle of the
    // ladder (at the ends the clamp is allowed to flatten it).
    expect(backoffDelayMs(3, () => 0)).toBeLessThan(backoffDelayMs(3, () => 1));
  });

  it('resumes with resume:true and re-subs every live subscription with known (§6.3 step 6)', async () => {
    const { h } = await subscribed();
    h.socket().receive(batch(DELTA_4185));
    expect(h.client.get(SUBJECT)!.seq).toBe(4185);

    h.socket().fail();
    expect(h.rec.closes).toEqual([{ code: 1006, reason: 'abnormal closure' }]);
    h.timers.advance(250);
    await settle();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(h.sent()[0]).toMatchObject({ t: 'hello', resume: true });

    h.socket().receive(WELCOME);
    expect(h.client.state).toBe('open');

    const resubs = h.sentOf('sub');
    expect(resubs).toHaveLength(1);
    expect(subEntry(resubs[0]!)).toMatchObject({ s: SUBJECT, known: 4185 });
    expect(asSet(subEntry(resubs[0]!).f)).toEqual(asSet(QUOTE_FIELDS));

    // The server answers with a fresh snap and never replays deltas, so application is idempotent.
    h.socket().receive(SUB_ACK_2);
    h.socket().receive(batch(SNAP_4190));
    h.socket().receive(batch(SNAP_4190)); // a duplicate snapshot lands on the same state
    const view = h.client.get(SUBJECT)!;
    expect(view.seq).toBe(4190);
    expect(view.f).toEqual(SNAP_4190.f);
    expect(h.client.stats.resyncs).toBe(0);
    expect(h.rec.states).toEqual(['connecting', 'open', 'resyncing', 'open']);
  });

  it('the Subscription object survives the reconnect: the same handle keeps ticking', async () => {
    const { h, sub } = await subscribed();
    const seen: UpdateEvent[] = [];
    sub.on('update', (e) => seen.push(e));

    h.socket().fail();
    h.timers.advance(250);
    await settle();
    h.socket().receive(WELCOME);
    h.socket().receive(SUB_ACK_2);
    h.socket().receive(batch(SNAP_4190));
    h.socket().receive(batch(delta(SUBJECT, 4193, 4190, { PX_LAST: 331.02 })));

    expect(seen.map((e) => e.seq)).toEqual([4190, 4193]);
    expect(h.client.get(SUBJECT)!.f.PX_LAST).toBe(331.02);
  });

  it('does not reconnect after a terminal close code, and rejects the pending connect', async () => {
    const h = build();
    const connected = h.client.connect();
    await settle();
    h.socket().close(4001, 'AUTH_REQUIRED');

    await expect(connected).rejects.toThrow(/4001/);
    expect(h.client.state).toBe('closed');
    expect(h.timers.pendingMs()).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('takes the close code from bye when the close frame carries none (§6.7)', async () => {
    const h = await opened();
    h.socket().receive({ t: 'bye', code: 4008, reason: 'SLOW_CONSUMER' });
    h.socket().fail(1006, 'abnormal closure');
    expect(h.rec.closes).toEqual([{ code: 4008, reason: 'SLOW_CONSUMER' }]);
    // 4008 is retryable, so the ladder still starts.
    expect(h.timers.pendingMs()).toEqual([250]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. notice, downgrade, status and conflation (API.md §6.5, §6.6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('LiveClient — notice, downgrade and shed (§6.5, §6.6)', () => {
  it('surfaces the recorded slow-consumer notice and adopts the widened interval', async () => {
    const { h } = await subscribed();
    expect(h.client.conflationMs).toBe(250);

    h.socket().receive(NOTICE_WIDENED);

    expect(h.rec.notices).toEqual([
      { t: 'notice', kind: 'slow-consumer', action: 'conflation-widened', conflationMs: 500 },
    ]);
    expect(h.client.conflationMs).toBe(500);
    expect(h.client.requestedConflationMs).toBe(250); // what we asked for is unchanged
  });

  it('surfaces a downgrade frame with its reason (ENTL-04)', async () => {
    const { h } = await subscribed();
    h.socket().receive({
      t: 'downgrade',
      s: SUBJECT,
      from: 'delayed',
      to: 'eod',
      reason: 'NOT_ENTITLED_TIER',
    });
    expect(h.rec.downgrades).toEqual([
      { subject: SUBJECT, from: 'delayed', to: 'eod', reason: 'NOT_ENTITLED_TIER' },
    ]);
  });

  it('plays the recorded shed-then-visible exchange: essential false, shed, re-sub with known', async () => {
    const { h } = await subscribed();
    h.socket().receive(batch(DELTA_4185));

    // The row scrolled out of the viewport.
    h.client.setEssential([SUBJECT], false);
    h.pump.flush();
    expect(h.sentOf('essential')).toEqual([
      { t: 'essential', subjects: [SUBJECT], essential: false },
    ]);

    h.socket().receive(NOTICE_WIDENED);
    h.socket().receive(STATUS_SHED);
    expect(h.rec.statuses).toEqual([{ subject: SUBJECT, st: 'shed', reason: 'SLOW_CONSUMER' }]);
    expect(h.client.subscriptions.isShed(SUBJECT)).toBe(true);
    expect(h.client.get(SUBJECT)!.status).toBe('shed');

    // The row is visible again: the shed hold is gone, so this is a re-`sub`, not a flag.
    const before = h.sentOf('sub').length;
    h.client.setEssential([SUBJECT], true);
    h.pump.flush();
    const resubs = h.sentOf('sub').slice(before);
    expect(resubs).toHaveLength(1);
    expect(subEntry(resubs[0]!)).toMatchObject({ s: SUBJECT, known: 4185, essential: true });
    expect(asSet(subEntry(resubs[0]!).f)).toEqual(asSet(QUOTE_FIELDS));

    h.socket().receive(SUB_ACK_2);
    h.socket().receive(batch(SNAP_4190));
    expect(h.client.get(SUBJECT)!.seq).toBe(4190);
  });

  it('requests a conflation interval and refuses one outside 50–5 000 ms', async () => {
    const h = await opened();
    h.client.setConflation(1_000);
    expect(h.sentOf('conflation')).toEqual([{ t: 'conflation', ms: 1_000 }]);
    expect(h.client.requestedConflationMs).toBe(1_000);
    expect(() => h.client.setConflation(10)).toThrow(/50–5000/);
    expect(() => h.client.setConflation(9_000)).toThrow(/50–5000/);
  });

  it('surfaces a server err frame with its trace id', async () => {
    const h = await opened();
    h.socket().receive({
      t: 'err',
      code: 'QUOTA_EXCEEDED',
      message: 'daily request quota spent',
      traceId: 'trace-9',
      fatal: false,
    });
    expect(h.rec.errors).toEqual([
      {
        code: 'QUOTA_EXCEEDED',
        message: 'daily request quota spent',
        traceId: 'trace-9',
        fatal: false,
      },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 6. A frame that fails the schema is a protocol error, not something to coerce
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('LiveClient — decode is strict (§6.7, 4002)', () => {
  it('treats a frame that fails ServerMsg as fatal and stops, rather than guessing', async () => {
    const { h } = await subscribed();
    // A `delta` with no `prev`: exactly the frame whose meaning cannot be guessed.
    h.socket().receive({ t: 'delta', s: SUBJECT, seq: 4185, f: { PX_LAST: 1 }, st: 'live' });

    expect(h.rec.errors).toHaveLength(1);
    expect(h.rec.errors[0]).toMatchObject({ code: 'PROTOCOL_ERROR', fatal: true });
    expect(h.client.state).toBe('closed');
    expect(h.client.stats.protocolErrors).toBe(1);
    expect(h.timers.pendingMs()).toEqual([]); // terminal: no ladder
    expect(h.client.get(SUBJECT)).toBeUndefined();
  });

  it('rejects malformed JSON the same way', async () => {
    const h = await opened();
    h.socket().receive('{not json');
    expect(h.rec.errors[0]).toMatchObject({ code: 'PROTOCOL_ERROR', fatal: true });
    expect(h.client.state).toBe('closed');
  });

  it('counts every frame it did receive', async () => {
    const { h } = await subscribed();
    h.socket().receive(batch(DELTA_4185));
    // welcome, subAck, batch(snap), batch(delta)
    expect(h.client.stats.framesReceived).toBe(4);
    expect(h.client.stats.applied).toBe(2);
    expect(h.client.stats.framesSent).toBeGreaterThanOrEqual(2); // hello + sub
  });

  it('a throwing listener does not stop the other listeners', async () => {
    const { h } = await subscribed();
    const seen: number[] = [];
    h.client.on('update', () => {
      throw new Error('widget exploded');
    });
    h.client.on('update', (e) => seen.push(e.seq));

    h.socket().receive(batch(DELTA_4185));

    expect(seen).toEqual([4185]);
    expect(h.rec.errors.map((e) => e.code)).toContain('LISTENER_FAILED');
    expect(h.client.get(SUBJECT)!.seq).toBe(4185);
  });
});
