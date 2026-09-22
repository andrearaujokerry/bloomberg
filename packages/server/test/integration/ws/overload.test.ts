/**
 * The overload floor (TESTING.md §10 row 13; API.md §6.5 last row; NFR-02).
 *
 * The slow-consumer ladder of §6.5 is a *per-session* condition read off one socket's
 * `bufferedAmount`. Overload is the other kind: the **process** is behind — event-loop lag over
 * 200 ms — and the answer is global. Every live session's `effectiveMs` is floored at 1 000 ms, the
 * non-essential subjects are shed, and the one thing that may never be taken away is the core of a
 * quote: `PX_LAST`, `CHG_NET_1D`, `CHG_PCT_1D`. A terminal under load shows fewer rows, more
 * slowly; it does not show a blank price.
 *
 * The lag is injected rather than simulated by burning CPU: `ws/gateway.ts` reads it through
 * `lagProbe()` once per sweep, which is the same hook a production host wires to
 * `perf_hooks.monitorEventLoopDelay`. Blocking the event loop for 200 ms to prove the branch would
 * make the suite slower *and* less deterministic, and would test Node rather than the gateway.
 *
 * Two sessions are held open, because "every session" is the assertion: the floor is decided once
 * and applied to both.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { FieldId, NormalisedUpdate } from '@terminal/core';
import type { Delta, ServerMsg } from '@terminal/sdk/wire/ws';

import { getConfig } from '../../../src/config.js';
import { buildPlant, type Plant } from '../../../src/plant/tickerPlant.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';
import { OVERLOAD_FLOOR_MS } from '../../../src/ws/gateway.js';
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

const CONFLATION_MS = 50;
const SWEEP_MS = 1_000;

/** Fields §6.5 protects: a subscription carrying any of them is never shed for overload. */
const CORE: FieldId[] = ['PX_LAST', 'CHG_NET_1D', 'CHG_PCT_1D'];
/** A depth-only subscription: nothing protected, so the first thing to go. */
const DEPTH: FieldId[] = ['PX_BID', 'PX_ASK', 'PX_VOLUME'];

interface Harness {
  clock: VirtualClock;
  plant: Plant;
  timers: ManualTimers;
  app: StartedWsApp;
  clients: WsClient[];
  golden: NormalisedUpdate;
  core: SeededInstrument;
  depth: SeededInstrument;
  pinned: SeededInstrument;
  setLagMs(ms: number): void;
}

let live: Harness | null = null;

afterEach(async () => {
  if (live === null) return;
  for (const client of live.clients) await client.close();
  await live.app.close();
  live = null;
});

/** The whole world: three quote subjects, `sys:status`, and two sessions holding all four. */
async function harness(): Promise<Harness> {
  const clock = testClock(GOLDEN_CAPTURE_MS);
  const plant = buildPlant({ config: getConfig(), clock });
  const golden = await goldenUpdate();

  const core = await seedQuoteInstrument(t, { ticker: 'AAPL' });
  const depth = await seedQuoteInstrument(t, { ticker: 'MSFT' });
  const pinned = await seedQuoteInstrument(t, { ticker: 'NVDA' });

  let lagMs = 0;
  const timers = manualTimers();
  const app = await startWsApp({
    t,
    clock,
    plant,
    entitlements: delayedEntitlements(),
    timers,
    limits: { sweepMs: SWEEP_MS },
    lagProbe: () => lagMs,
  });

  const h: Harness = {
    clock,
    plant,
    timers,
    app,
    clients: [],
    golden,
    core,
    depth,
    pinned,
    setLagMs: (ms: number): void => {
      lagMs = ms;
    },
  };
  live = h;

  // The server's own subject has to exist before anyone can subscribe to it (API.md §6.1): a
  // healthy plant, published once at startup, is what the overload transition then overwrites.
  const ts = { src: GOLDEN_CAPTURE_MS, cap: GOLDEN_CAPTURE_MS, pub: GOLDEN_CAPTURE_MS };
  plant.publish('sys:status', { PLANT_STATE: 'ok', CONFLATION_FLOOR_MS: 0 }, { ts });
  for (const ins of [core, depth, pinned]) tick(h, ins, 0);

  for (let i = 0; i < 2; i += 1) {
    const web = await createWebSession(t);
    const client = new WsClient(app.url, { cookie: web.cookie });
    await client.open();
    h.clients.push(client);
    client.send({ t: 'hello', protocol: 1, client: 'web/0.1.0', conflationMs: CONFLATION_MS });
    await client.next((f) => f.t === 'welcome');
    client.send({
      t: 'sub',
      id: 1,
      subjects: [
        // Off-viewport, but it carries the three protected fields: it survives.
        { s: core.subject, f: CORE, essential: false },
        // Off-viewport depth: the one thing overload sheds.
        { s: depth.subject, f: DEPTH, essential: false },
        // On-viewport: never a candidate at all.
        { s: pinned.subject, f: [...CORE, ...DEPTH], essential: true },
        { s: 'sys:status', f: [] },
      ],
    });
    const ack = (await client.next((f) => f.t === 'subAck')) as Extract<
      ServerMsg,
      { t: 'subAck' }
    >;
    expect(ack.rejected).toEqual([]);
    expect(ack.accepted).toHaveLength(4);
    await client.next((f) => f.t === 'snap' && f.s === 'sys:status');
  }

  return h;
}

/** One observation of `ins`, applied straight to the plant. */
function tick(h: Harness, ins: SeededInstrument, n: number): void {
  const srcMs = (h.golden.ts.src ?? GOLDEN_CAPTURE_MS) + n * 1_000;
  const px = Math.round((330.27 + n * 0.11) * 100) / 100;
  const update: NormalisedUpdate = {
    ...h.golden,
    subject: ins.subject,
    instrumentId: ins.instrumentId,
    mdLineId: ins.mdLineId,
    fields: {
      ...h.golden.fields,
      PX_LAST: px,
      PX_BID: Math.round((px - 0.02) * 100) / 100,
      PX_ASK: Math.round((px + 0.02) * 100) / 100,
      PX_VOLUME: 16_591_786 + n * 137,
      LAST_TRADE_TIME: srcMs,
    },
    ts: { src: srcMs, cap: h.golden.ts.cap + n * 1_000, pub: 0 },
    prov: { ...h.golden.prov, srcSeq: (h.golden.prov.srcSeq ?? 0) + n },
  };
  h.plant.apply(update);
}

function notices(client: WsClient): Extract<ServerMsg, { t: 'notice' }>[] {
  return client.frames.filter((f): f is Extract<ServerMsg, { t: 'notice' }> => f.t === 'notice');
}

function shedSubjects(client: WsClient): string[] {
  return client.frames
    .filter((f) => f.t === 'status' && f.st === 'shed')
    .map((f) => (f as { s: string }).s);
}

/** The last `sys:status` frame the client holds, whatever kind it arrived as. */
function sysStatus(client: WsClient): Delta | undefined {
  let last: Delta | undefined;
  for (const frame of client.frames) {
    if (frame.t === 'delta' && frame.s === 'sys:status') last = frame;
  }
  return last;
}

describe('ws overload — the global conflation floor (NFR-02, TESTING row 13)', () => {
  it('floors every session at 1 000 ms, sheds only the unprotected rows, and says so on sys:status', async () => {
    const h = await harness();

    // Lag crosses the 200 ms line. The gateway reads the probe on its next sweep.
    h.setLagMs(250);
    h.timers.advance(SWEEP_MS + 1);
    // …and the flush after it carries the `sys:status` publication out to every session.
    h.timers.advance(2_000);
    for (const client of h.clients) {
      await client.next((f) => f.t === 'delta' && f.s === 'sys:status', 3_000);
    }

    for (const client of h.clients) {
      // The floor is announced as an `overload` notice carrying the new window: 1 000 ms, not the
      // 50 ms this client asked for. That number *is* `effectiveMs`.
      const widened = notices(client).filter(
        (n) => n.kind === 'overload' && n.action === 'conflation-widened',
      );
      expect(widened).toHaveLength(1);
      expect(widened[0]!.conflationMs).toBe(OVERLOAD_FLOOR_MS);
      expect(OVERLOAD_FLOOR_MS).toBe(1_000);

      // Non-essential first — and only the subscription with no protected field.
      expect(shedSubjects(client)).toEqual([h.depth.subject]);
      expect(shedSubjects(client)).not.toContain(h.core.subject);
      expect(shedSubjects(client)).not.toContain(h.pinned.subject);
      expect(notices(client).some((n) => n.kind === 'overload' && n.action === 'shed')).toBe(true);

      // `sys:status` says what happened, in fields rather than in prose.
      const status = sysStatus(client);
      expect(status).toBeDefined();
      expect(status!.f.PLANT_STATE).toBe('degraded');
      expect(status!.f.CONFLATION_FLOOR_MS).toBe(OVERLOAD_FLOOR_MS);
    }

    // A client that asks for 50 ms again while the plant is degraded still gets the floor: it is
    // the server's floor, not a suggestion.
    h.clients[0]!.send({ t: 'conflation', ms: CONFLATION_MS });
    await sleep(20);

    const before = h.plant.get(h.core.subject)?.fields.PX_LAST;
    tick(h, h.core, 5);
    tick(h, h.depth, 5);
    // Half a second is not a flush any more: the session's window is 1 000 ms.
    h.timers.advance(500);
    await sleep(30);
    expect(h.clients[0]!.frames.some((f) => f.t === 'delta' && f.s === h.core.subject)).toBe(false);

    // A full window later the protected subscription ticks again — degraded is slower, never blank.
    h.timers.advance(2_000);
    const delta = (await h.clients[0]!.next(
      (f) => f.t === 'delta' && f.s === h.core.subject,
      3_000,
    )) as Delta;
    expect(delta.f.PX_LAST).toBe(h.plant.get(h.core.subject)?.fields.PX_LAST);
    expect(delta.f.PX_LAST).not.toBe(before);
    // …while the shed subject stays gone until the client re-`sub`s: no frame for it, ever.
    h.timers.advance(2_000);
    await sleep(20);
    expect(h.clients[0]!.frames.some((f) => f.t === 'delta' && f.s === h.depth.subject)).toBe(
      false,
    );

    // A `dq_events kind='plant_degraded'` row: the overload is a finding, not just a frame.
    let dqRows: { details: { lagMs: number; floorMs: number } }[] = [];
    for (let i = 0; i < 30 && dqRows.length === 0; i += 1) {
      const res = await t.client.query<{ details: { lagMs: number; floorMs: number } }>(
        `SELECT details FROM dq_events WHERE kind = 'plant_degraded' AND subject = 'sys:status'
          ORDER BY dq_id`,
      );
      dqRows = res.rows;
      if (dqRows.length === 0) await sleep(10);
    }
    expect(dqRows.length).toBeGreaterThanOrEqual(1);
    expect(dqRows[0]!.details.floorMs).toBe(OVERLOAD_FLOOR_MS);
    expect(dqRows[0]!.details.lagMs).toBe(250);

    // Recovery: the lag falls away, the floor is lifted, and `sys:status` says so.
    h.setLagMs(0);
    h.timers.advance(SWEEP_MS + 1);
    for (const client of h.clients) {
      for (let i = 0; i < 40; i += 1) {
        h.timers.advance(2_000);
        await sleep(5);
        const status = sysStatus(client);
        if (status?.f.PLANT_STATE === 'ok') break;
      }
      const status = sysStatus(client);
      expect(status!.f.PLANT_STATE).toBe('ok');
      expect(status!.f.CONFLATION_FLOOR_MS).toBe(0);
    }
  }, 60_000);
});
