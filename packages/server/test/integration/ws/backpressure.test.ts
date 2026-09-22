/**
 * The slow-consumer ladder, rung by rung (TESTING.md §10 rows 11-12; API.md §6.5 L975-998; BUS-04).
 *
 * A *stalled reader* is not a dead one: the client's TCP socket is paused, so the connection stays
 * healthy while the peer stops draining it. The server's kernel send buffer fills, and from then on
 * every frame it writes accumulates in `socket.bufferedAmount` — which is exactly the quantity
 * API.md §6.5 makes every decision on. Nothing here is faked: the thresholds are lowered, the
 * consumer really stops reading, and the gateway walks its own ladder.
 *
 * The walk is deterministic because three things are injected:
 *
 *  - the **timers** are `manualTimers()`, so one `advance()` is exactly one flush and the test owns
 *    the flush schedule the way a real event loop would not let it;
 *  - the **clock** is a `VirtualClock`, and `GRACE_MS` is measured on it, so the two ten-second
 *    grace windows of §6.5 cost two `clock.advance()` calls rather than twenty real seconds;
 *  - the **plant** is fed by hand from the recorded `cboe-quote-AAPL` observation, so the frames
 *    that fill the socket carry real quote payloads at a real size.
 *
 * While the reader is stalled nothing can be asserted on the wire — that is the point of the
 * stall — so the ladder is *followed* through the rows it writes (`usage_events kind='ws.slow'`,
 * one per rung, in the test's own transaction) and then *verified* on the wire once the reader
 * resumes and the whole backlog, ending in `bye`, is delivered in order.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { FieldId, NormalisedUpdate } from '@terminal/core';
import type { ServerMsg } from '@terminal/sdk/wire/ws';

import { getConfig } from '../../../src/config.js';
import { buildPlant, type Plant } from '../../../src/plant/tickerPlant.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';
import {
  createWebSession,
  delayedEntitlements,
  goldenUpdate,
  GOLDEN_CAPTURE_MS,
  manualTimers,
  seedQuoteInstrument,
  sleep,
  startWsApp,
  WsClient,
  type ManualTimers,
  type SeededInstrument,
  type StartedWsApp,
} from './helpers.js';

const t = withTxDb();

/** `hello.conflationMs`; the schema's floor is 50 ms, and `effectiveMs` never goes below it. */
const CONFLATION_MS = 50;

/**
 * The §6.5 thresholds, scaled down so a test can cross them.
 *
 * `hardBytes` is 64 KiB rather than the 32 KiB a first reading suggests, for one reason: the
 * widening rung fires once per flush *while `soft < buffered ≤ hard`*, and the ladder has to have
 * room for the seven doublings that take 50 ms to the 5 000 ms cap. At ~2 KiB of quote payload per
 * flush a 24 KiB band gives twelve flushes; a 56 KiB band gives thirty, which is margin rather than
 * luck. The ratios that matter — widen at `soft`, skip at `hard`, restore under `soft/4` — are
 * unchanged.
 */
const THRESHOLDS = { softBytes: 8_192, hardBytes: 65_536, graceMs: 400, maxMs: 5_000 };

/** The doublings a 50 ms client sees before `effectiveMs` hits `maxMs`. */
const WIDEN_LADDER = [100, 200, 400, 800, 1_600, 3_200, 5_000];

/** The fields every subscription names — the payload that fills the socket. */
const FIELDS: FieldId[] = [
  'PX_LAST',
  'PX_BID',
  'PX_ASK',
  'PX_VOLUME',
  'PX_HIGH',
  'PX_LOW',
  'CHG_NET_1D',
  'CHG_PCT_1D',
];

/** Timers below this fire a flush and nothing else (`sweepMs` is 10 000). */
const FLUSH_ONLY_MS = 6_000;
/** Timers below this also fire the housekeeping tick that writes the queued `usage_events`. */
const HOUSEKEEPING_MS = 20_000;

interface Harness {
  clock: VirtualClock;
  plant: Plant;
  timers: ManualTimers;
  app: StartedWsApp;
  client: WsClient;
  sessionId: string;
  golden: NormalisedUpdate;
  /** The first two are `essential`, the last two are not — the shed rung's victims. */
  instruments: SeededInstrument[];
  essential: string[];
  disposable: string[];
}

let live: Harness | null = null;

afterEach(async () => {
  if (live === null) return;
  await live.client.close();
  await live.app.close();
  live = null;
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function harness(): Promise<Harness> {
  const clock = testClock(GOLDEN_CAPTURE_MS);
  const plant = buildPlant({ config: getConfig(), clock });
  const golden = await goldenUpdate();

  const instruments: SeededInstrument[] = [];
  for (const ticker of ['AAPL', 'MSFT', 'NVDA', 'AMZN']) {
    instruments.push(await seedQuoteInstrument(t, { ticker }));
  }

  const timers = manualTimers();
  const web = await createWebSession(t);
  const app = await startWsApp({
    t,
    clock,
    plant,
    entitlements: delayedEntitlements(),
    thresholds: THRESHOLDS,
    timers,
    // The housekeeping cadence is pushed out so that `advance(FLUSH_ONLY_MS)` is exactly one
    // flush; the test fires the sweep itself when it wants the queued rows written.
    limits: { sweepMs: 10_000 },
  });
  const client = new WsClient(app.url, { cookie: web.cookie });
  await client.open();

  const h: Harness = {
    clock,
    plant,
    timers,
    app,
    client,
    sessionId: web.sessionId,
    golden,
    instruments,
    essential: instruments.slice(0, 2).map((i) => i.subject),
    disposable: instruments.slice(2).map((i) => i.subject),
  };
  live = h;

  // One observation per subject, so every `sub` has a snapshot to answer with.
  tickAll(h, 0);

  client.send({ t: 'hello', protocol: 1, client: 'web/0.1.0', conflationMs: CONFLATION_MS });
  await client.next((f) => f.t === 'welcome');
  client.send({
    t: 'sub',
    id: 1,
    subjects: instruments.map((ins, i) => ({
      s: ins.subject,
      f: FIELDS,
      // The off-viewport rows: the first thing §6.5 sheds, and the only thing it sheds.
      essential: i < 2,
    })),
  });
  const ack = await client.next((f) => f.t === 'subAck');
  expect((ack as Extract<ServerMsg, { t: 'subAck' }>).accepted).toHaveLength(4);
  for (const ins of instruments) {
    await client.next((f) => f.t === 'snap' && f.s === ins.subject);
  }
  return h;
}

/** One fresh observation of every subject, applied straight to the plant. */
function tickAll(h: Harness, n: number): void {
  const srcMs = (h.golden.ts.src ?? GOLDEN_CAPTURE_MS) + n * 1_000;
  h.instruments.forEach((ins, i) => {
    const px = 330.27 + (((n * 7 + i) % 97) - 48) * 0.01;
    const update: NormalisedUpdate = {
      ...h.golden,
      subject: ins.subject,
      instrumentId: ins.instrumentId,
      mdLineId: ins.mdLineId,
      fields: {
        ...h.golden.fields,
        PX_LAST: round(px),
        PX_BID: round(px - 0.02),
        PX_ASK: round(px + 0.02),
        PX_VOLUME: 16_591_786 + n * 137 + i,
        PX_HIGH: round(px + 1.2),
        PX_LOW: round(px - 1.4),
        LAST_TRADE_TIME: srcMs,
      },
      ts: { src: srcMs, cap: h.golden.ts.cap + n * 1_000, pub: 0 },
      prov: { ...h.golden.prov, srcSeq: (h.golden.prov.srcSeq ?? 0) + n },
    };
    h.plant.apply(update);
  });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The ladder, as the transaction records it
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface RungRow {
  rung: string;
  conflationMs: number | null;
  bufferedBytes: number | null;
}

/** Every `usage_events kind='ws.slow'` row this session has written, oldest first. */
async function rungs(sessionId: string): Promise<RungRow[]> {
  const res = await t.client.query<{ rung: string | null; ms: string | null; buf: string | null }>(
    `SELECT details->>'rung' AS rung,
            details->>'conflationMs' AS ms,
            details->>'bufferedBytes' AS buf
       FROM usage_events
      WHERE kind = 'ws.slow' AND session_id = $1
      ORDER BY ts, event_id`,
    [sessionId],
  );
  return res.rows.map((row) => ({
    rung: row.rung ?? '',
    conflationMs: row.ms === null ? null : Number(row.ms),
    bufferedBytes: row.buf === null ? null : Number(row.buf),
  }));
}

/** `dq_events kind='ws_backpressure'` rows for this session. */
async function backpressureDq(sessionId: string): Promise<{ severity: string }[]> {
  const res = await t.client.query<{ severity: string }>(
    `SELECT severity FROM dq_events
      WHERE kind = 'ws_backpressure' AND details->>'sessionId' = $1
      ORDER BY dq_id`,
    [sessionId],
  );
  return res.rows;
}

/**
 * Feed the plant and flush until `predicate` is satisfied by the rows the session has written.
 *
 * Every twenty-fifth flush also fires the housekeeping tick and yields to the event loop, which is
 * when the queued `usage_events` reach the transaction and when libuv hands the pending frames to
 * the kernel. The reader is paused, so nothing ever drains: `bufferedAmount` only rises.
 */
async function pumpUntil(
  h: Harness,
  label: string,
  predicate: (rows: RungRow[]) => boolean,
  maxFlushes = 8_000,
): Promise<RungRow[]> {
  let rows = await rungs(h.sessionId);
  let flushes = 0;
  for (; flushes < maxFlushes && !predicate(rows); flushes += 1) {
    tickAll(h, flushes + 1);
    h.timers.advance(FLUSH_ONLY_MS);
    if (flushes % 25 === 24) {
      h.timers.advance(HOUSEKEEPING_MS);
      await sleep(0);
      rows = await rungs(h.sessionId);
    }
  }
  if (!predicate(rows)) {
    throw new Error(
      `${label}: not reached after ${String(flushes)} flushes; rungs so far: ${rows
        .map((r) => r.rung)
        .join(',')}`,
    );
  }
  return rows;
}

/**
 * One flush at the current virtual instant, then the housekeeping tick that writes what it queued,
 * then wait for `rung` to appear in the transaction. The two `advance` calls are separate because
 * `manualTimers` fires in registration order: a single call could run the housekeeping tick before
 * the flush that produced the row.
 */
async function flushUntilRung(h: Harness, rung: string): Promise<RungRow[]> {
  h.timers.advance(FLUSH_ONLY_MS);
  h.timers.advance(HOUSEKEEPING_MS);
  let rows: RungRow[] = [];
  for (let i = 0; i < 50; i += 1) {
    await sleep(2);
    rows = await rungs(h.sessionId);
    if (has(rows, rung)) return rows;
  }
  return rows;
}

function has(rows: RungRow[], rung: string): boolean {
  return rows.some((r) => r.rung === rung);
}

function notices(client: WsClient): Extract<ServerMsg, { t: 'notice' }>[] {
  return client.frames.filter(
    (f): f is Extract<ServerMsg, { t: 'notice' }> => f.t === 'notice',
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row 11 — the ladder to 4008
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ws backpressure — the §6.5 slow-consumer ladder (BUS-04, TESTING row 11)', () => {
  it('widens, caps, skips, sheds, warns and closes 4008 — every rung on the wire and in the tx', async () => {
    const h = await harness();

    // The consumer stalls. From here the socket is healthy and nobody is reading it.
    h.client.pauseSocket();

    // Rungs 1-3: widen at SOFT, cap at MAX_MS, then skip the flush at HARD.
    const throughSkip = await pumpUntil(h, 'flush-skipped', (rows) => has(rows, 'flush-skipped'));

    const widened = throughSkip
      .filter((r) => r.rung === 'conflation-widened')
      .map((r) => r.conflationMs);
    expect(widened).toEqual(WIDEN_LADDER);
    // Never wider than MAX_MS, and never widened again once capped.
    expect(Math.max(...widened.map((ms) => ms ?? 0))).toBe(THRESHOLDS.maxMs);

    const firstSkip = throughSkip.find((r) => r.rung === 'flush-skipped');
    expect(firstSkip?.bufferedBytes ?? 0).toBeGreaterThan(THRESHOLDS.hardBytes);

    // Rung 4: still over HARD after a grace window → the non-essential subjects are shed.
    h.clock.advance(THRESHOLDS.graceMs);
    let rows = await flushUntilRung(h, 'shed');
    expect(has(rows, 'shed')).toBe(true);

    // Rung 5: still over HARD after another grace window → disconnect-soon, then 4008.
    h.clock.advance(THRESHOLDS.graceMs);
    rows = await flushUntilRung(h, 'close');
    expect(has(rows, 'disconnect-soon')).toBe(true);
    expect(has(rows, 'close')).toBe(true);

    // Every rung of the ladder, in order, each one a `usage_events kind='ws.slow'` row (§6.5 last
    // paragraph: nothing is dropped silently).
    const order = rows.map((r) => r.rung);
    expect(order.indexOf('conflation-widened')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('flush-skipped')).toBeGreaterThan(order.indexOf('conflation-widened'));
    expect(order.indexOf('shed')).toBeGreaterThan(order.indexOf('flush-skipped'));
    expect(order.indexOf('disconnect-soon')).toBeGreaterThan(order.indexOf('shed'));
    expect(order.indexOf('close')).toBeGreaterThan(order.indexOf('disconnect-soon'));

    // …and a `dq_events kind='ws_backpressure'` row for the session. `raiseDq` keys the row by
    // `(kind, source_id, subject, key)` and leaves an unresolved one alone, so the ladder produces
    // one open finding per session rather than five duplicates of the same one; the closing rung
    // is what escalates it to `error`.
    const dq = await backpressureDq(h.sessionId);
    expect(dq.length).toBeGreaterThanOrEqual(1);
    expect(dq.some((r) => r.severity === 'warn' || r.severity === 'error')).toBe(true);

    // The reader comes back: the whole backlog is delivered, in order, ending in the close.
    h.client.resumeSocket();
    const code = await h.client.closeCode(5_000);
    expect(code).toBe(4008);

    const seen = notices(h.client);
    expect(seen.filter((n) => n.action === 'conflation-widened').map((n) => n.conflationMs)).toEqual(
      WIDEN_LADDER,
    );
    for (const notice of seen) expect(notice.kind).toBe('slow-consumer');

    const actions = seen.map((n) => n.action);
    expect(actions.indexOf('shed')).toBeGreaterThan(actions.lastIndexOf('conflation-widened'));
    expect(actions.indexOf('disconnect-soon')).toBeGreaterThan(actions.indexOf('shed'));

    // One `status {st:'shed'}` per non-essential subject, and not one for an essential subject.
    const shedStatuses = h.client.frames.filter((f) => f.t === 'status' && f.st === 'shed');
    expect(new Set(shedStatuses.map((f) => (f as { s: string }).s))).toEqual(
      new Set(h.disposable),
    );
    for (const frame of shedStatuses) {
      expect((frame as { reason?: string }).reason).toBe('SLOW_CONSUMER');
    }
    for (const subject of h.essential) {
      expect(shedStatuses.some((f) => (f as { s: string }).s === subject)).toBe(false);
    }

    // The consumer is never silently dropped: the close is announced first as a notice and then as
    // a `bye` carrying the code the socket closes with.
    const byeIndex = h.client.frames.findIndex((f) => f.t === 'bye');
    expect(byeIndex).toBeGreaterThanOrEqual(0);
    const bye = h.client.frames[byeIndex] as Extract<ServerMsg, { t: 'bye' }>;
    expect(bye.code).toBe(4008);
    expect(bye.reason).toBe('SLOW_CONSUMER');
    const warning = h.client.frames.findIndex(
      (f) => f.t === 'notice' && f.action === 'disconnect-soon',
    );
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(warning).toBeLessThan(byeIndex);
    // `bye` is the last thing the session says.
    expect(byeIndex).toBe(h.client.frames.length - 1);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row 11's "nothing lost" clause and row 12 — the recovery rung
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ws backpressure — a skipped flush keeps the dirty set (TESTING rows 11-12)', () => {
  it('loses no value across the stall and restores conflation, never below the requested ms', async () => {
    const h = await harness();
    h.client.pauseSocket();

    await pumpUntil(h, 'flush-skipped', (rows) => has(rows, 'flush-skipped'));

    // A last observation nobody can possibly have seen: it arrives while the flush is being
    // skipped, so it exists only in the retained dirty set.
    tickAll(h, 9_999);
    h.timers.advance(FLUSH_ONLY_MS);
    const skipped = await rungs(h.sessionId);
    expect(has(skipped, 'shed')).toBe(false); // still inside the first grace window

    // The reader comes back. The socket drains, `bufferedAmount` falls, and the retained dirty set
    // is flushed against the plant's *current* state — the latest-value guarantee across a stall.
    h.client.resumeSocket();
    for (let i = 0; i < 60; i += 1) {
      await sleep(10);
      h.timers.advance(FLUSH_ONLY_MS);
      if (h.instruments.every((ins) => lastSeqFor(h.client, ins.subject) === seqOf(h, ins.subject)))
        break;
    }

    for (const ins of h.instruments) {
      const state = h.plant.get(ins.subject);
      expect(state).toBeDefined();
      const merged = mergeFor(h.client, ins.subject);
      for (const id of FIELDS) {
        expect([ins.subject, id, merged[id]]).toEqual([
          ins.subject,
          id,
          (state!.fields as Record<string, unknown>)[id],
        ]);
      }
      expect(lastSeqFor(h.client, ins.subject)).toBe(state!.seq);
    }

    // Row 12: three consecutive flushes under SOFT/4 restore the window, halving it each time and
    // never narrowing below what the client asked for.
    for (let i = 0; i < 80; i += 1) {
      h.timers.advance(FLUSH_ONLY_MS);
      await sleep(3);
    }
    const restored = notices(h.client).filter((n) => n.action === 'conflation-restored');
    expect(restored.length).toBeGreaterThan(0);
    for (const notice of restored) {
      expect(notice.conflationMs ?? 0).toBeGreaterThanOrEqual(CONFLATION_MS);
    }
    const values = restored.map((n) => n.conflationMs ?? 0);
    for (let i = 1; i < values.length; i += 1) expect(values[i]!).toBeLessThan(values[i - 1]!);
    expect(values[values.length - 1]).toBe(CONFLATION_MS);
  }, 60_000);
});

/** The plant's current `seq` for a subject. */
function seqOf(h: Harness, subject: string): number {
  return h.plant.get(subject)?.seq ?? -1;
}

/** The `seq` of the last `snap`/`delta` the client received for `subject`. */
function lastSeqFor(client: WsClient, subject: string): number {
  let seq = -1;
  for (const frame of client.frames) {
    if ((frame.t === 'snap' || frame.t === 'delta') && frame.s === subject) seq = frame.seq;
  }
  return seq;
}

/** The client's own view: the `snap` plus every `delta`, applied in receipt order. */
function mergeFor(client: WsClient, subject: string): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const frame of client.frames) {
    if (frame.t !== 'snap' && frame.t !== 'delta') continue;
    if (frame.s !== subject) continue;
    Object.assign(merged, frame.f);
  }
  return merged;
}
