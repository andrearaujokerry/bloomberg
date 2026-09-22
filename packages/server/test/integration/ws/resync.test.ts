/**
 * Resync: the three ways a subscription is re-based (TESTING.md §10 rows 9-10, BUS-07).
 *
 * API.md §6.3 steps 3, 6 and 7 describe one invariant from three directions, and this file drives
 * all three over a **real** socket, against the production `buildApp`, with the recorded
 * `cboe-quote-AAPL` poll as the snapshot and WP-05's seeded `SimFeed` as the follow-on ticks:
 *
 *  1. **A forced gap** (step 6). The socket is killed mid-burst while the feed keeps running, so
 *     the plant genuinely moves on without the client. The client reconnects with
 *     `hello { resume:true }` and re-`sub`s with `known: lastSeq[s]`. The server answers with a
 *     fresh `snap` and **never replays a delta** — asserted by a frame-type census, not by
 *     inspecting the implementation — so applying the reconnect stream to the *pre-disconnect*
 *     cache is idempotent, gap-free and duplicate-free, and lands on exactly the state a cold
 *     subscriber gets. `known` is bookkeeping only: it feeds the `usage_events kind='ws.resync'`
 *     row and nothing on the wire.
 *  2. **A client-detected gap** (step 3). One frame is dropped on the way into the client cache —
 *     the loss a lossy transport actually produces — so the next delta's `prev` no longer matches
 *     `lastSeq`. The cache implements the client rule verbatim (apply iff `prev === lastSeq`, drop
 *     iff `seq <= lastSeq`, otherwise `resync` and ignore deltas until a `snap`), and the property
 *     under test is the server's half of it: a `resync { subjects }` yields a fresh `snap`, and the
 *     chain is contiguous from that `snap` onwards.
 *  3. **A server-initiated resync** (step 7). `wsGateway.forceResync([subject])` emits
 *     `resync { subjects }`, and until the client re-`sub`s **not one frame** for that subject is
 *     sent — asserted by counting frames across five virtual seconds of feed, while the plant's own
 *     `seq` runs away underneath.
 *
 * The clock is virtual and the feed is seeded, so the only real time here is the socket's latency.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Delta, ServerMsg, Snap } from '@terminal/sdk/wire/ws';

import { getConfig } from '../../../src/config.js';
import { buildPlant, type Plant } from '../../../src/plant/tickerPlant.js';
import { SimFeed } from '../../../src/providers/sim/feed.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';
import {
  applyAaplGolden,
  createWebSession,
  delayedEntitlements,
  GOLDEN_CAPTURE_MS,
  seedQuoteInstrument,
  sleep,
  startWsApp,
  WsClient,
  type SeededInstrument,
  type StartedWsApp,
} from './helpers.js';

const t = withTxDb();

const CONFLATION_MS = 50;
/** Staleness sweep *and* the `usage_events` housekeeping flush (`session.ts#onSweepTick`). */
const SWEEP_MS = 150;
const RATE_HZ = 20;
const QUOTE_FIELDS = ['PX_LAST', 'PX_BID', 'PX_ASK', 'PX_VOLUME', 'CHG_PCT_1D'];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Harness {
  clock: VirtualClock;
  plant: Plant;
  instrument: SeededInstrument;
  subject: string;
  app: StartedWsApp;
  feed: SimFeed;
  web: { sessionId: string; cookie: string };
  clients: WsClient[];
  /** How many explicit prints {@link burst} has applied — the Cboe line's `src_seq` offset. */
  prints: number;
}

let live: Harness | null = null;

afterEach(async () => {
  if (live === null) return;
  const h = live;
  live = null;
  for (const client of h.clients) await client.close();
  await h.app.close();
});

/** A seeded instrument, the golden quote in the plant, a listening app and an armed feed. */
async function harness(): Promise<Harness> {
  const clock = testClock(GOLDEN_CAPTURE_MS);
  const plant = buildPlant({ config: getConfig(), clock });
  const instrument = await seedQuoteInstrument(t, { ticker: 'AAPL', name: 'Apple Inc' });
  await applyAaplGolden(plant, instrument);
  const web = await createWebSession(t);
  const app = await startWsApp({
    t,
    clock,
    plant,
    entitlements: delayedEntitlements(),
    limits: { sweepMs: SWEEP_MS },
  });

  const feed = new SimFeed(
    {
      seed: 20260915,
      startMs: GOLDEN_CAPTURE_MS,
      rateHz: RATE_HZ,
      sessionOf: () => 'open',
      subjects: [
        {
          subject: instrument.subject,
          instrumentId: instrument.instrumentId,
          // A second line for the same instrument: the Cboe line keeps supplying `PX_CLOSE_1D`
          // (it is the primary, priority 10) while the sim line supplies the prints.
          mdLineId: instrument.mdLineId + 1,
          assetClass: 'equity',
          tier: 'delayed',
          px0: 330.27,
          annualVolPct: 22,
          spreadBp: 3,
          avgTradeSize: 100,
          calendarId: 'XNYS',
        },
      ],
    },
    { clock, plant, provenanceId: instrument.provenanceId },
  );
  feed.start();

  const h: Harness = {
    clock,
    plant,
    instrument,
    subject: instrument.subject,
    app,
    feed,
    web,
    clients: [],
    prints: 0,
  };
  live = h;
  return h;
}

async function connect(h: Harness, cookie: string): Promise<WsClient> {
  const client = new WsClient(h.app.url, { cookie });
  await client.open();
  h.clients.push(client);
  return client;
}

async function handshake(client: WsClient, opts: { resume?: boolean } = {}): Promise<void> {
  client.send({
    t: 'hello',
    protocol: 1,
    client: 'web/0.1.0',
    conflationMs: CONFLATION_MS,
    ...(opts.resume === undefined ? {} : { resume: opts.resume }),
  });
  await client.next((f) => f.t === 'welcome');
}

function subscribe(client: WsClient, subject: string, id: number, known?: number): void {
  client.send({
    t: 'sub',
    id,
    subjects: [{ s: subject, f: QUOTE_FIELDS, ...(known === undefined ? {} : { known }) }],
  });
}

/** Advance the virtual clock in `chunks` steps, pumping the feed and letting the socket breathe. */
async function pump(h: Harness, chunks: number, msPerChunk = 250): Promise<void> {
  for (let i = 0; i < chunks; i += 1) {
    h.clock.advance(msPerChunk);
    h.feed.pump();
    await sleep(CONFLATION_MS + 15);
  }
}

/**
 * One explicit print on the Cboe line, a quarter of a dollar above the composite's current
 * `PX_LAST`, and the plant version it produced.
 *
 * A burst has to *end* on a tick that certainly moves a subscribed field, because the sim feed does
 * not always move one: a trade at an unchanged price with an unchanged book touches only
 * `LAST_TRADE_TIME`/`LAST_SIZE`, and `PX_VOLUME` never moves at all (the simulated prints never
 * exceed the recorded session total). The conflator is right to send nothing for those — a
 * subscriber to `PX_LAST` never receives a field it did not ask for (BUS-02) — so the plant's `seq`
 * can legitimately sit ahead of the last delta, and "the client has caught up" would be an
 * unreachable assertion. This print makes the plant's last version a deliverable one.
 */
async function print(h: Harness): Promise<number> {
  h.prints += 1;
  const before = h.plant.get(h.subject)!.fields.PX_LAST!;
  const px = Number((before + 0.25).toFixed(2));
  const at = h.clock.now() + 1; // strictly newer than every sim tick applied so far
  await applyAaplGolden(h.plant, h.instrument, {
    fields: { PX_LAST: px },
    srcMs: at,
    capMs: at,
    srcSeqDelta: h.prints,
  });
  const state = h.plant.get(h.subject)!;
  // The merge really took it (priority 10, newest `ts.src`); otherwise the drain below would hang.
  expect(state.fields.PX_LAST).toBe(px);
  return state.seq;
}

/** `chunks` × 250 virtual ms of feed, ended by one print; returns the version to drain to. */
async function burst(h: Harness, chunks: number): Promise<number> {
  await pump(h, chunks);
  return print(h);
}

/** Every `snap`/`delta` this client received for `subject`, in receipt order. */
function quoteFrames(frames: readonly ServerMsg[], subject: string): (Snap | Delta)[] {
  return frames.filter(
    (f): f is Snap | Delta => (f.t === 'snap' || f.t === 'delta') && f.s === subject,
  );
}

async function waitUntil(fn: () => boolean, label: string, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (fn()) return;
    await sleep(CONFLATION_MS);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Wait until the client has been told plant version `target` (the print that ended the burst). */
async function drainTo(h: Harness, client: WsClient, target: number): Promise<void> {
  await waitUntil(() => {
    const frames = quoteFrames(client.frames, h.subject);
    return frames[frames.length - 1]?.seq === target;
  }, `the client to catch up to plant seq ${String(target)}`);
}

interface UsageRow {
  kind: string;
  details: Record<string, unknown>;
}

/** Poll for a queued `usage_events` row; the session writes them on its housekeeping tick. */
async function waitForUsage(
  sessionId: string,
  kind: string,
  match: (row: UsageRow) => boolean = () => true,
): Promise<UsageRow> {
  for (let i = 0; i < 60; i += 1) {
    const res = await t.client.query<UsageRow>(
      `SELECT kind, details FROM usage_events WHERE session_id = $1 AND kind = $2 ORDER BY ts`,
      [sessionId, kind],
    );
    const row = res.rows.find(match);
    if (row !== undefined) return row;
    await sleep(100);
  }
  throw new Error(`no usage_events row kind='${kind}' for session ${sessionId}`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The client cache — API.md §6.3 step 3, verbatim
// ─────────────────────────────────────────────────────────────────────────────────────────────

type ApplyResult = 'applied' | 'dropped' | 'gap' | 'ignored';

/**
 * The apply rule a terminal implements (`sdk/client/quoteCache.ts` in WP-13): apply iff
 * `prev === lastSeq`, drop iff `seq <= lastSeq`, otherwise ask for a `resync` and ignore every
 * further delta for the subject until a `snap` arrives. A field absent from `f` is unchanged;
 * `null` clears it.
 */
class ClientCache {
  readonly fields = new Map<string, Record<string, unknown>>();
  readonly lastSeq = new Map<string, number>();
  readonly resyncRequests: string[] = [];
  readonly counts = { applied: 0, dropped: 0, gap: 0, ignored: 0, snaps: 0 };

  readonly #awaitingSnap = new Set<string>();

  apply(frame: Snap | Delta): ApplyResult {
    const subject = frame.s;
    if (frame.t === 'snap') {
      this.fields.set(subject, { ...frame.f });
      this.lastSeq.set(subject, frame.seq);
      this.#awaitingSnap.delete(subject);
      this.counts.snaps += 1;
      this.counts.applied += 1;
      return 'applied';
    }
    if (this.#awaitingSnap.has(subject)) {
      this.counts.ignored += 1;
      return 'ignored';
    }
    const last = this.lastSeq.get(subject) ?? -1;
    if (frame.seq <= last) {
      this.counts.dropped += 1;
      return 'dropped';
    }
    if (frame.prev !== last) {
      this.#awaitingSnap.add(subject);
      this.resyncRequests.push(subject);
      this.counts.gap += 1;
      return 'gap';
    }
    const merged = this.fields.get(subject) ?? {};
    for (const [id, value] of Object.entries(frame.f)) merged[id] = value;
    this.fields.set(subject, merged);
    this.lastSeq.set(subject, frame.seq);
    this.counts.applied += 1;
    return 'applied';
  }

  view(subject: string): Record<string, unknown> {
    return this.fields.get(subject) ?? {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. A forced disconnect (TESTING row 9)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ws resync — a forced gap is answered with a snapshot, never a replay (BUS-07)', () => {
  it('re-snaps on reconnect, replays nothing, and lands where a cold subscribe lands', async () => {
    const h = await harness();
    const first = await connect(h, h.web.cookie);
    await handshake(first);
    subscribe(first, h.subject, 1);
    await first.next((f) => f.t === 'snap');
    await drainTo(h, first, await burst(h, 8));

    // Everything this client saw before the wire went away.
    const cache = new ClientCache();
    for (const frame of quoteFrames(first.frames, h.subject)) {
      expect(cache.apply(frame)).toBe('applied');
    }
    expect(cache.counts.snaps).toBe(1);
    expect(cache.counts.applied).toBeGreaterThan(3);
    const known = cache.lastSeq.get(h.subject)!;

    // The lid closes: the socket is destroyed without a close frame, and the feed runs on for
    // another two virtual seconds with nobody listening — so the gap below is a real one.
    first.kill();
    const missed = await burst(h, 8);
    expect(missed).toBeGreaterThan(known); // the gap is real, not notional

    // Reconnect on the same session: `hello { resume:true }`, then re-`sub` with what we know.
    const second = await connect(h, h.web.cookie);
    await handshake(second, { resume: true });
    subscribe(second, h.subject, 2, known);
    const snap = (await second.next((f) => f.t === 'snap')) as Snap;
    expect(snap.s).toBe(h.subject);
    expect(snap.seq).toBeGreaterThanOrEqual(missed);

    await drainTo(h, second, await burst(h, 8));

    // The census: one `snap`, first, and not one delta from the gap — nothing is replayed.
    const reconnectStream = quoteFrames(second.frames, h.subject);
    expect(reconnectStream[0]!.t).toBe('snap');
    expect(reconnectStream.filter((f) => f.t === 'snap')).toHaveLength(1);
    expect(reconnectStream.filter((f) => f.t === 'delta' && f.seq <= known)).toHaveLength(0);
    expect(reconnectStream.filter((f) => f.t === 'delta' && f.seq <= snap.seq)).toHaveLength(0);
    expect(reconnectStream.length).toBeGreaterThan(2);

    // Applying it to the *pre-disconnect* cache: gap-free and duplicate-free.
    for (const frame of reconnectStream) expect(cache.apply(frame)).toBe('applied');
    expect(cache.counts.gap).toBe(0);
    expect(cache.counts.dropped).toBe(0);
    expect(cache.resyncRequests).toHaveLength(0);

    // …and idempotent: applying the very same stream again lands on the same state.
    const settled = { ...cache.view(h.subject) };
    const settledSeq = cache.lastSeq.get(h.subject);
    for (const frame of reconnectStream) cache.apply(frame);
    expect(cache.view(h.subject)).toEqual(settled);
    expect(cache.lastSeq.get(h.subject)).toBe(settledSeq);
    expect(cache.counts.gap).toBe(0);

    // A cold subscriber — different user, different socket, no history — sees the same thing.
    const other = await createWebSession(t);
    const cold = await connect(h, other.cookie);
    await handshake(cold);
    subscribe(cold, h.subject, 3);
    const coldSnap = (await cold.next((f) => f.t === 'snap')) as Snap;
    expect(coldSnap.seq).toBe(h.plant.get(h.subject)!.seq);
    expect(cache.lastSeq.get(h.subject)).toBe(coldSnap.seq);
    for (const id of QUOTE_FIELDS) {
      expect(cache.view(h.subject)[id], `${id} after resume`).toBe(
        (coldSnap.f as Record<string, unknown>)[id],
      );
    }

    // `known` is bookkeeping: one `usage_events` row, with the gap it measured.
    const row = await waitForUsage(h.web.sessionId, 'ws.resync');
    expect(row.details).toMatchObject({
      subject: h.subject,
      cause: 'client',
      known,
    });
    expect(row.details.gap).toBe(snap.seq - known);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. A client-detected gap (API.md §6.3 step 3)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ws resync — a client-detected gap (API.md §6.3 step 3)', () => {
  it('ignores deltas until the snap it asked for, then chains again from it', async () => {
    const h = await harness();
    const client = await connect(h, h.web.cookie);
    await handshake(client);
    subscribe(client, h.subject, 1);
    await client.next((f) => f.t === 'snap');
    await drainTo(h, client, await burst(h, 10));

    const stream = quoteFrames(client.frames, h.subject);
    expect(stream.length).toBeGreaterThan(4);

    // The transport loses exactly one delta. Everything before it applies; the delta after it
    // breaks the `prev` chain, which is the only signal the client has.
    const cache = new ClientCache();
    const lost = 2;
    expect(stream[lost]!.t).toBe('delta');
    for (let i = 0; i < stream.length; i += 1) {
      if (i === lost) continue;
      const result = cache.apply(stream[i]!);
      if (i < lost) expect(result, `frame ${String(i)}`).toBe('applied');
      else if (i === lost + 1) expect(result, 'the frame after the loss').toBe('gap');
      else expect(result, `frame ${String(i)} after the gap`).toBe('ignored');
    }
    expect(cache.resyncRequests).toEqual([h.subject]);
    expect(cache.counts.gap).toBe(1);
    const staleSeq = cache.lastSeq.get(h.subject)!;

    // The client asks for exactly what the rule says to ask for.
    const before = stream.length;
    client.send({ t: 'resync', subjects: [h.subject] });
    await waitUntil(
      () => quoteFrames(client.frames, h.subject).slice(before).some((f) => f.t === 'snap'),
      'the server’s fresh snap',
    );

    await drainTo(h, client, await burst(h, 6));

    const tail = quoteFrames(client.frames, h.subject).slice(before);
    const snapAt = tail.findIndex((f) => f.t === 'snap');
    expect(snapAt).toBeGreaterThanOrEqual(0);
    const fresh = tail[snapAt] as Snap;
    expect(fresh.seq).toBeGreaterThanOrEqual(staleSeq);

    // Applying the tail: whatever arrived before the snap is ignored (the rule), the snap
    // re-bases, and every delta after it chains.
    for (let i = 0; i < tail.length; i += 1) {
      const result = cache.apply(tail[i]!);
      if (i < snapAt) expect(result, `pre-snap frame ${String(i)}`).toBe('ignored');
      else expect(result, `post-snap frame ${String(i)}`).toBe('applied');
    }
    expect(cache.counts.gap).toBe(1); // the injected one, and no other
    expect(cache.resyncRequests).toEqual([h.subject]);

    // The chain is intact afterwards, and the cache holds the plant's own composite.
    const applied = h.plant.get(h.subject)!;
    expect(cache.lastSeq.get(h.subject)).toBe(applied.seq);
    expect(cache.view(h.subject).PX_LAST).toBe(applied.fields.PX_LAST);
    expect(cache.view(h.subject).PX_BID).toBe(applied.fields.PX_BID);

    const chained = tail.slice(snapAt);
    let previous = chained[0]!.seq;
    for (const frame of chained.slice(1)) {
      expect(frame.t).toBe('delta');
      expect((frame as Delta).prev).toBe(previous);
      previous = frame.seq;
    }

    const row = await waitForUsage(
      h.web.sessionId,
      'ws.resync',
      (r) => r.details.cause === 'client' && r.details.subject === h.subject,
    );
    expect(row.details).toMatchObject({ subject: h.subject, cause: 'client' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. A server-initiated resync (TESTING row 10, API.md §6.3 step 7)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ws resync — server-initiated: nothing flows until the client re-subs', () => {
  it('sends resync, then no frame at all for 5 virtual seconds, then a snap on re-sub', async () => {
    const h = await harness();
    const client = await connect(h, h.web.cookie);
    await handshake(client);
    subscribe(client, h.subject, 1);
    await client.next((f) => f.t === 'snap');
    await drainTo(h, client, await burst(h, 4));

    const cache = new ClientCache();
    for (const frame of quoteFrames(client.frames, h.subject)) {
      expect(cache.apply(frame)).toBe('applied');
    }
    const heldSeq = cache.lastSeq.get(h.subject)!;
    const before = quoteFrames(client.frames, h.subject).length;

    // A plant restart, an entitlement cache reload: the gateway asks every session to re-`sub`.
    h.app.app.wsGateway.forceResync([h.subject]);
    const resync = (await client.next((f) => f.t === 'resync')) as Extract<
      ServerMsg,
      { t: 'resync' }
    >;
    expect(resync.subjects).toEqual([h.subject]);

    // Five virtual seconds of feed at 20 Hz — a hundred updates — with the client silent.
    await pump(h, 20);
    await print(h);
    await sleep(CONFLATION_MS * 6);

    expect(quoteFrames(client.frames, h.subject)).toHaveLength(before);
    expect(client.frames.filter((f) => f.t === 'status' && f.s === h.subject)).toHaveLength(0);
    const ranAway = h.plant.get(h.subject)!;
    expect(ranAway.seq).toBeGreaterThan(heldSeq); // the plant did keep moving

    // The client obeys: it re-`sub`s, and only then does the subject speak again.
    subscribe(client, h.subject, 2, heldSeq);
    await client.next((f) => f.t === 'subAck' && f.id === 2);
    await waitUntil(
      () => quoteFrames(client.frames, h.subject).length > before,
      'the post-re-sub snapshot',
    );

    const fresh = quoteFrames(client.frames, h.subject)[before]!;
    expect(fresh.t).toBe('snap');
    expect(fresh.seq).toBe(ranAway.seq);
    expect(cache.apply(fresh)).toBe('applied');
    expect(cache.counts.gap).toBe(0); // a snapshot is never a gap
    expect(cache.view(h.subject).PX_LAST).toBe(ranAway.fields.PX_LAST);

    // …and the chain runs on from the snapshot, not from what the session held before it.
    await drainTo(h, client, await burst(h, 6));
    for (const frame of quoteFrames(client.frames, h.subject).slice(before + 1)) {
      expect(cache.apply(frame)).toBe('applied');
    }
    expect(cache.counts.gap).toBe(0);
    expect(cache.lastSeq.get(h.subject)).toBe(h.plant.get(h.subject)!.seq);

    const row = await waitForUsage(h.web.sessionId, 'ws.resync', (r) => r.details.cause === 'server');
    expect(row.details).toMatchObject({ cause: 'server', subjects: 1 });
  });
});
