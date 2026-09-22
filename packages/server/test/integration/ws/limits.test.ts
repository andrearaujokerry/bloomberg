/**
 * Subject grammar, field rules, limits and close codes (TESTING.md §10 rows 16-17; API.md §6.1,
 * §6.6, §6.7).
 *
 * Every rejection here is a *reason*, never a silence: a subject the plant does not hold comes back
 * `SUBJECT_UNKNOWN`, a field the dictionary does not know comes back `FIELD_UNKNOWN`, a limit comes
 * back `LIMIT` — and a frame that is not a `ClientMsg` at all is answered with `err { fatal:true }`
 * before the socket is closed `4002`, so a client always learns why it lost its connection.
 *
 * Two notes on what the wire schema decides before the gateway ever sees a frame:
 *
 *  - `sub.subjects[].f` is `z.array(FieldId).max(100)`, so a subscription naming **more than 100**
 *    fields fails `ClientMsg` and is a `4002 PROTOCOL_ERROR`, not a `LIMIT` rejection. The
 *    gateway's own `maxFields` check is what produces `LIMIT`, and it is exercised here with the
 *    limit lowered — the same code path, at a size a test can state in one line.
 *  - `hello.protocol` is `z.literal(1)`, so a `hello` naming another version also fails the schema.
 *    Version negotiation must still answer `4010 PROTOCOL_VERSION` (API.md §6.7), which is why the
 *    gateway discriminates that one decode failure before falling through to `4002`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { ServerMsg } from '@terminal/sdk/wire/ws';

import { fieldIds } from '@terminal/core';

import { getConfig } from '../../../src/config.js';
import { buildPlant, type Plant } from '../../../src/plant/tickerPlant.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { DEFAULT_WS_LIMITS } from '../../../src/ws/session.js';
import { withTxDb } from '../../../src/test/db.js';
import {
  applyAaplGolden,
  createWebSession,
  delayedEntitlements,
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

type SubAck = Extract<ServerMsg, { t: 'subAck' }>;

interface Harness {
  clock: VirtualClock;
  plant: Plant;
  instrument: SeededInstrument;
  subject: string;
  app: StartedWsApp;
  client: WsClient;
  timers: ManualTimers;
}

let live: Harness | null = null;

afterEach(async () => {
  if (live === null) return;
  await live.client.close();
  await live.app.close();
  live = null;
});

/**
 * A clock anchored at the fixture instant that advances with real time. The rate limiter measures a
 * real client's real cadence, and this is the one suite that drives a real socket, so a frozen
 * virtual clock cannot express "more than 20 messages a second". Nothing else here reads it.
 */
function wallClock(): { now(): number } {
  const startedAt = Date.now();
  return { now: (): number => GOLDEN_CAPTURE_MS + (Date.now() - startedAt) };
}

async function harness(
  opts: { limits?: Record<string, number>; manual?: boolean; appClock?: { now(): number } } = {},
): Promise<Harness> {
  const clock = testClock(GOLDEN_CAPTURE_MS);
  const plant = buildPlant({ config: getConfig(), clock });
  const instrument = await seedQuoteInstrument(t, { ticker: 'AAPL', name: 'Apple Inc' });
  await applyAaplGolden(plant, instrument);

  // Two non-quote subjects, so the `f: []` rule has something real to accept.
  const ts = { src: GOLDEN_CAPTURE_MS, cap: GOLDEN_CAPTURE_MS, pub: GOLDEN_CAPTURE_MS };
  plant.publish('sys:status', { PLANT_STATE: 'ok', CONFLATION_FLOOR_MS: 0 }, { ts });
  plant.publish(
    'n:all',
    { NEWS_ID: 'n-1', HEADLINE: 'Apple opens higher', PUBLISHED_AT: GOLDEN_CAPTURE_MS },
    { ts, queued: true },
  );

  const timers = manualTimers();
  const web = await createWebSession(t);
  const app = await startWsApp({
    t,
    clock: opts.appClock ?? clock,
    plant,
    entitlements: delayedEntitlements(),
    ...(opts.manual === true ? { timers } : {}),
    limits: { sweepMs: 250, ...opts.limits },
  });
  const client = new WsClient(app.url, { cookie: web.cookie });
  await client.open();

  const h: Harness = {
    clock,
    plant,
    instrument,
    subject: instrument.subject,
    app,
    client,
    timers,
  };
  live = h;
  return h;
}

function hello(client: WsClient, conflationMs = 50): void {
  client.send({ t: 'hello', protocol: 1, client: 'web/0.1.0', conflationMs });
}

async function ackFor(client: WsClient, id: number): Promise<SubAck> {
  const frame = await client.next((f) => f.t === 'subAck' && (f).id === id);
  return frame as SubAck;
}

describe('ws sub — the f: [] rule per family (BUS-02, API.md §6.1)', () => {
  it('accepts "all fields" for c/e/n/sys/alerts/room and rejects it for the quote families', async () => {
    const h = await harness();
    hello(h.client);
    await h.client.next((f) => f.t === 'welcome');

    h.client.send({
      t: 'sub',
      id: 1,
      subjects: [
        { s: 'sys:status', f: [] },
        { s: 'n:all', f: [] },
        { s: h.subject, f: [] },
      ],
    });

    const ack = await ackFor(h.client, 1);
    expect(ack.accepted.map((a) => a.s).sort()).toEqual(['n:all', 'sys:status']);
    expect(ack.rejected).toEqual([
      { s: h.subject, code: 'FIELD_UNKNOWN', reason: 'family q must name its fields' },
    ]);
  });
});

describe('ws sub — unknown subjects and unknown fields (API.md §6.6)', () => {
  it('rejects a subject the plant does not hold and one the grammar does not parse', async () => {
    const h = await harness();
    hello(h.client);
    await h.client.next((f) => f.t === 'welcome');

    h.client.send({
      t: 'sub',
      id: 7,
      subjects: [
        { s: 'q:999999999', f: ['PX_LAST'] },
        { s: 'q:not-a-number', f: ['PX_LAST'] },
      ],
    });

    const ack = await ackFor(h.client, 7);
    expect(ack.accepted).toEqual([]);
    expect(ack.rejected.map((r) => [r.s, r.code])).toEqual([
      ['q:999999999', 'SUBJECT_UNKNOWN'],
      ['q:not-a-number', 'SUBJECT_UNKNOWN'],
    ]);
  });

  it('rejects a field the dictionary does not know', async () => {
    const h = await harness();
    hello(h.client);
    await h.client.next((f) => f.t === 'welcome');

    h.client.send({
      t: 'sub',
      id: 2,
      subjects: [{ s: h.subject, f: ['PX_LAST', 'PX_NOT_A_FIELD'] }],
    });

    const ack = await ackFor(h.client, 2);
    expect(ack.accepted).toEqual([]);
    expect(ack.rejected[0]).toMatchObject({ s: h.subject, code: 'FIELD_UNKNOWN' });
    expect(ack.rejected[0]!.reason).toContain('PX_NOT_A_FIELD');
  });
});

describe('ws sub — limits (BUS-08, API.md §6.7)', () => {
  it('rejects a subscription over maxFields with LIMIT', async () => {
    const h = await harness({ limits: { maxFields: 3 } });
    hello(h.client);
    const welcome = await h.client.next((f) => f.t === 'welcome');
    expect((welcome as { limits: { maxFields: number } }).limits.maxFields).toBe(3);

    h.client.send({
      t: 'sub',
      id: 3,
      subjects: [{ s: h.subject, f: ['PX_LAST', 'PX_BID', 'PX_ASK', 'PX_VOLUME'] }],
    });

    const ack = await ackFor(h.client, 3);
    expect(ack.accepted).toEqual([]);
    expect(ack.rejected[0]).toMatchObject({ s: h.subject, code: 'LIMIT' });
  });

  it('closes 4011 after repeated subs beyond maxSubscriptions', async () => {
    const h = await harness({ limits: { maxSubscriptionsWeb: 1 } });
    hello(h.client);
    await h.client.next((f) => f.t === 'welcome');

    h.client.send({ t: 'sub', id: 1, subjects: [{ s: h.subject, f: ['PX_LAST'] }] });
    expect((await ackFor(h.client, 1)).accepted).toHaveLength(1);

    h.client.send({ t: 'sub', id: 2, subjects: [{ s: 'sys:status', f: [] }] });
    expect((await ackFor(h.client, 2)).rejected[0]).toMatchObject({ code: 'LIMIT' });

    h.client.send({ t: 'sub', id: 3, subjects: [{ s: 'n:all', f: [] }] });
    expect(await h.client.closeCode()).toBe(4011);
  });
});

describe('ws sub — the 1 MiB ceiling of a sub frame (API.md §6.4, §6.7)', () => {
  it('answers a 280 KB well-formed sub instead of disconnecting the client', async () => {
    // §6.4 reasons that "a single `sub` may carry up to 10 000 subjects with up to 100 fields
    // each (§6.7)", which is impossible under the general 64 KiB client-frame rule; §6.7 gives
    // `sub` its own 1 MiB ceiling and §6.6 maps frame size to `LIMIT`, not to a fatal close.
    const h = await harness();
    hello(h.client);
    await h.client.next((f) => f.t === 'welcome');

    const fields = fieldIds().slice(0, 73);
    const frame = {
      t: 'sub' as const,
      id: 11,
      subjects: [
        { s: h.subject, f: ['PX_LAST'] },
        ...Array.from({ length: 300 }, (_, i) => ({ s: `q:${String(900_000 + i)}`, f: fields })),
      ],
    };
    const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8');
    expect(bytes).toBeGreaterThan(200_000);
    expect(bytes).toBeLessThan(1024 * 1024);
    h.client.send(frame);

    const ack = await ackFor(h.client, 11);
    expect(ack.accepted.map((a) => a.s)).toEqual([h.subject]);
    // The 300 made-up subjects are answered one by one; nothing about the frame's size is fatal.
    expect(ack.rejected).toHaveLength(300);
    expect(new Set(ack.rejected.map((r) => r.code))).toEqual(new Set(['SUBJECT_UNKNOWN']));
    expect(h.client.frames.some((f) => f.t === 'err')).toBe(false);

    // The socket is still there and still serving.
    h.client.send({ t: 'ping', n: 9 });
    expect(await h.client.next((f) => f.t === 'pong')).toMatchObject({ t: 'pong', n: 9 });
    expect(h.client.closed).toBe(false);
  });

  it('rejects a sub over its own ceiling with LIMIT and keeps the socket open', async () => {
    const h = await harness();
    hello(h.client);
    await h.client.next((f) => f.t === 'welcome');

    // Just over 1 MiB: still a valid `ClientMsg`, so still not a `4002`.
    const filler = 'F'.repeat(3_000);
    const frame = {
      t: 'sub' as const,
      id: 12,
      subjects: Array.from({ length: 360 }, (_, i) => ({
        s: `q:${String(910_000 + i)}`,
        f: ['PX_LAST'],
        // A long-but-legal subject list is the only way to pass 1 MiB without breaking the schema.
        known: i,
        essential: true,
        pad: filler,
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeGreaterThan(1024 * 1024);
    h.client.send(frame);

    const ack = await ackFor(h.client, 12);
    expect(ack.accepted).toEqual([]);
    expect(ack.rejected[0]).toMatchObject({ code: 'LIMIT' });
    expect(ack.rejected[0]!.reason).toContain('limit is 1048576');
    expect(h.client.closed).toBe(false);
  });

  it('still closes 4002 for a non-subject frame over the 64 KiB client-frame ceiling', async () => {
    const h = await harness();
    h.client.send({ t: 'hello', protocol: 1, client: 'w'.repeat(70_000) });

    const err = (await h.client.next((f) => f.t === 'err')) as Extract<ServerMsg, { t: 'err' }>;
    expect(err.code).toBe('FRAME_TOO_LARGE');
    expect(err.fatal).toBe(true);
    expect(await h.client.closeCode()).toBe(4002);
  });
});

describe('ws rate limit — 20 client messages a second (API.md §6.7, TESTING.md §10 row 17)', () => {
  it('closes 4029 once the rate has stayed over the limit for the grace window', async () => {
    // The overage has to accumulate *across* second boundaries: a counter that resets with each
    // new second can never reach the grace window at all, and `4029` becomes unreachable.
    expect(DEFAULT_WS_LIMITS.maxClientMsgsPerSec).toBe(20);
    expect(DEFAULT_WS_LIMITS.rateGraceMs).toBe(3_000);
    // Both limits are the shipped ones: this probe really does spend its three seconds over the
    // limit, which is the only way to prove the grace window is reachable at all.
    const h = await harness({ appClock: wallClock() });
    hello(h.client);
    await h.client.next((f) => f.t === 'welcome');

    // 25 messages a second, continuously over the limit, for as long as it takes.
    const deadline = Date.now() + 6_000;
    let n = 0;
    while (!h.client.closed && Date.now() < deadline) {
      n += 1;
      try {
        h.client.send({ t: 'ping', n });
      } catch {
        break;
      }
      await sleep(40);
    }

    expect(await h.client.closeCode()).toBe(4029);
    // Never silent: the client was told it was over the limit before it was cut off.
    const errs = h.client.frames.filter(
      (f): f is Extract<ServerMsg, { t: 'err' }> => f.t === 'err',
    );
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]!.code).toBe('RATE_LIMITED');
    expect(errs[0]!.fatal).toBe(false);
    const bye = h.client.frames.find((f) => f.t === 'bye');
    expect(bye).toMatchObject({ t: 'bye', code: 4029, reason: 'RATE_LIMITED' });
  }, 20_000);

  it('does not close a client that stays at the limit', async () => {
    const h = await harness({ appClock: wallClock(), limits: { rateGraceMs: 1_000 } });
    // A grace shorter than the run: if 10 msg/s were ever counted as an overage, this would close.
    hello(h.client);
    await h.client.next((f) => f.t === 'welcome');

    // 10 messages a second for 2.5 s: half the limit, twice the grace window.
    for (let i = 1; i <= 25; i += 1) {
      h.client.send({ t: 'ping', n: i });
      await sleep(100);
    }
    await sleep(100);
    expect(h.client.closed).toBe(false);
    expect(h.client.frames.filter((f) => f.t === 'pong')).toHaveLength(25);
    expect(h.client.frames.some((f) => f.t === 'err')).toBe(false);
  }, 20_000);
});

describe('ws frames — protocol errors and version negotiation (API.md §6.7)', () => {
  it('answers a frame that is not a ClientMsg with err { fatal: true } then closes 4002', async () => {
    const h = await harness();
    h.client.send('this is not json');

    const err = (await h.client.next((f) => f.t === 'err')) as Extract<ServerMsg, { t: 'err' }>;
    expect(err.fatal).toBe(true);
    expect(err.code).toBe('BAD_JSON');
    expect(await h.client.closeCode()).toBe(4002);
  });

  it('closes 4010 when hello names a protocol version the server does not serve', async () => {
    const h = await harness();
    h.client.send({ t: 'hello', protocol: 2, client: 'web/0.1.0' });

    const err = (await h.client.next((f) => f.t === 'err')) as Extract<ServerMsg, { t: 'err' }>;
    expect(err.code).toBe('PROTOCOL_VERSION');
    expect(err.fatal).toBe(true);
    expect(await h.client.closeCode()).toBe(4010);
  });
});

describe('ws session binding — a second socket supersedes the first (API.md §6.3 step 1)', () => {
  it('closes the older socket 4003 with reason ws-replaced', async () => {
    const h = await harness();
    const web = await createWebSession(t);

    const first = new WsClient(h.app.url, { cookie: web.cookie });
    await first.open();
    first.send({ t: 'hello', protocol: 1, client: 'web/0.1.0', conflationMs: 50 });
    await first.next((f) => f.t === 'welcome');

    const second = new WsClient(h.app.url, { cookie: web.cookie });
    await second.open();
    second.send({ t: 'hello', protocol: 1, client: 'web/0.1.0', conflationMs: 50 });
    await second.next((f) => f.t === 'welcome');

    expect(await first.closeCode()).toBe(4003);
    expect(first.closeReason()).toBe('ws-replaced');
    await second.close();
  });
});

describe('ws handshake deadline (API.md §6.3 step 1, §6.7)', () => {
  it('closes 4001 AUTH_REQUIRED when hello never arrives', async () => {
    const h = await harness({ manual: true });
    // Nothing is sent: five seconds of patience elapse on the injected timer port.
    expect(h.timers.pending()).toBeGreaterThan(0);
    h.timers.advance(5_000);

    const bye = (await h.client.next((f) => f.t === 'bye')) as Extract<ServerMsg, { t: 'bye' }>;
    expect(bye.code).toBe(4001);
    expect(await h.client.closeCode()).toBe(4001);
  });
});
