/**
 * `test/client/subscriptions.test.ts` — WORKPLAN WP-13 acceptance row:
 * *"ref counting, per-frame batching, `essential` toggling on viewport change"*.
 *
 * Every frame the registry sends is decoded through `ClientMsg` before it is asserted on, so a test
 * here cannot pass on a frame the server would close the socket over (`4002 PROTOCOL_ERROR`).
 *
 * The scheduler is a manual frame pump with the same shape as `packages/web/test/setup.tsx`'s:
 * `requestAnimationFrame` QUEUES, and `flushFrames(n)` runs n frames. Nothing here waits on a timer,
 * so the batching assertions are about frames, which is what the batching is about.
 */
import { describe, expect, it } from 'vitest';

import { SubscriptionManager, SubscriptionRegistry } from '../../src/client/subscriptions.js';
import type { FrameScheduler, SubscriptionAck } from '../../src/client/subscriptions.js';
import type { FieldId } from '../../src/wire/envelope.js';
import { ClientMsg } from '../../src/wire/ws.js';
import type { ClientMsgInput, ClientMsgOf } from '../../src/wire/ws.js';

/** The manual frame pump: callbacks queue, `flushFrames(n)` runs n frames. */
class FramePump {
  #queue: (() => void)[] = [];
  /** How many frames have been run. */
  frames = 0;

  readonly schedule: FrameScheduler = (callback) => {
    this.#queue.push(callback);
  };

  flushFrames(n = 1): void {
    for (let i = 0; i < n; i += 1) {
      const due = this.#queue;
      this.#queue = [];
      this.frames += 1;
      for (const callback of due) callback();
    }
  }

  get queued(): number {
    return this.#queue.length;
  }
}

interface Harness {
  registry: SubscriptionRegistry;
  pump: FramePump;
  /** Every frame sent, decoded through `ClientMsg` (so defaults are applied and junk cannot pass). */
  sent: ClientMsg[];
  /** The frames sent since the marker, then move the marker. */
  since: () => ClientMsg[];
  unsubscribed: string[][];
  known: Map<string, number>;
}

function harness(): Harness {
  const pump = new FramePump();
  const sent: ClientMsg[] = [];
  const unsubscribed: string[][] = [];
  const known = new Map<string, number>();
  let marker = 0;
  const registry = new SubscriptionRegistry({
    send: (msg: ClientMsgInput) => {
      sent.push(ClientMsg.parse(msg));
    },
    scheduleFrame: pump.schedule,
    knownSeq: (subject) => known.get(subject),
    onUnsubscribed: (subjects) => unsubscribed.push(subjects),
  });
  return {
    registry,
    pump,
    sent,
    since: () => {
      const slice = sent.slice(marker);
      marker = sent.length;
      return slice;
    },
    unsubscribed,
    known,
  };
}

function subFrame(msg: ClientMsg): ClientMsgOf<'sub'> {
  if (msg.t !== 'sub') throw new Error(`expected a sub frame, got '${msg.t}'`);
  return msg;
}

const PX: FieldId[] = ['PX_LAST', 'PX_BID'];

describe('SubscriptionRegistry — ref counting (TERM-04, CLIENT.md L229)', () => {
  it('two subscribers on one subject are one sub on the wire', () => {
    const h = harness();
    const first = h.registry.add(['q:42'], PX);
    const second = h.registry.add(['q:42'], PX);
    expect(h.registry.refCount('q:42')).toBe(2);
    expect(h.registry.refCount('q:42', 'PX_LAST')).toBe(2);

    h.pump.flushFrames();
    const frames = h.since();
    expect(frames).toHaveLength(1);
    const frame = subFrame(frames[0]!);
    expect(frame.subjects).toEqual([{ s: 'q:42', f: ['PX_BID', 'PX_LAST'], essential: true }]);
    expect(frame.tier).toBe('delayed');
    expect(first.id).not.toBe(second.id);
  });

  it('stays subscribed when one of the two unsubscribes, and unsubs once when both do', () => {
    const h = harness();
    const first = h.registry.add(['q:42'], PX);
    const second = h.registry.add(['q:42'], PX);
    h.pump.flushFrames();
    h.since();

    first.unsubscribe();
    h.pump.flushFrames();
    expect(h.since()).toEqual([]);
    expect(h.registry.refCount('q:42')).toBe(1);
    expect(h.registry.wireFields('q:42')).toEqual(['PX_BID', 'PX_LAST']);

    second.unsubscribe();
    h.pump.flushFrames();
    const frames = h.since();
    expect(frames).toEqual([{ t: 'unsub', subjects: ['q:42'] }]);
    expect(h.registry.refCount('q:42')).toBe(0);
    expect(h.registry.subjects()).toEqual([]);
    // The cache is told, so the view goes with the subscription.
    expect(h.unsubscribed).toEqual([['q:42']]);
  });

  it('counts per field: a widening re-subs, a narrowing does not', () => {
    const h = harness();
    const narrow = h.registry.add(['q:42'], ['PX_LAST']);
    h.pump.flushFrames();
    expect(subFrame(h.since()[0]!).subjects[0]!.f).toEqual(['PX_LAST']);

    // A second widget wants the bid too: the server's field set must grow, so the sub goes again.
    h.registry.add(['q:42'], ['PX_BID']);
    h.pump.flushFrames();
    expect(subFrame(h.since()[0]!).subjects[0]!.f).toEqual(['PX_BID', 'PX_LAST']);

    // Releasing the narrow one leaves the wire set wider than it needs to be, which costs bytes and
    // never a wrong number. Re-subbing to narrow it would re-snapshot a subject nothing asked to.
    narrow.unsubscribe();
    h.pump.flushFrames();
    expect(h.since()).toEqual([]);
    expect(h.registry.wireFields('q:42')).toEqual(['PX_BID', 'PX_LAST']);
  });

  it("sends the family's whole field set as the wire's empty list for '*'", () => {
    const h = harness();
    h.registry.add(['n:AAPL'], '*');
    h.pump.flushFrames();
    expect(subFrame(h.since()[0]!).subjects).toEqual([{ s: 'n:AAPL', f: [], essential: true }]);
    expect(h.registry.wireFields('n:AAPL')).toBe('*');
  });

  it('requests the highest tier any holder asked for', () => {
    const h = harness();
    h.registry.add(['q:42'], PX, { tier: 'eod' });
    h.registry.add(['q:42'], PX, { tier: 'delayed' });
    h.pump.flushFrames();
    expect(subFrame(h.since()[0]!).tier).toBe('delayed');
    expect(h.registry.tierOf('q:42')).toBe('delayed');
  });

  it('puts subjects of different requested tiers in different frames', () => {
    const h = harness();
    h.registry.add(['q:42'], PX, { tier: 'delayed' });
    h.registry.add(['q:7'], PX, { tier: 'eod' });
    h.pump.flushFrames();
    const frames = h.since();
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => subFrame(f).tier).sort()).toEqual(['delayed', 'eod']);
  });
});

describe('SubscriptionRegistry — per-frame batching', () => {
  it('coalesces a whole screen of widgets into one frame', () => {
    const h = harness();
    // Twelve widgets over three subjects, all mounting in the same tick.
    for (let i = 0; i < 4; i += 1) {
      h.registry.add(['q:42', 'q:43', 'q:44'], PX);
    }
    expect(h.sent).toHaveLength(0); // nothing goes out before the frame
    expect(h.registry.batchPending).toBe(true);

    h.pump.flushFrames();
    expect(h.registry.frameCount).toBe(1);
    const frame = subFrame(h.since()[0]!);
    expect(frame.subjects.map((s) => s.s)).toEqual(['q:42', 'q:43', 'q:44']);
    expect(h.registry.batchPending).toBe(false);

    // A later frame is a second wire frame, not a second copy of the first.
    h.registry.add(['q:45'], PX);
    h.pump.flushFrames();
    expect(h.registry.frameCount).toBe(2);
    expect(subFrame(h.since()[0]!).subjects.map((s) => s.s)).toEqual(['q:45']);
    expect(h.pump.frames).toBe(2);
  });

  it('sends nothing at all for a subject acquired and released inside one frame', () => {
    const h = harness();
    const sub = h.registry.add(['q:42'], PX);
    sub.unsubscribe();
    h.pump.flushFrames();
    expect(h.sent).toEqual([]);
    expect(h.registry.frameCount).toBe(0);
    expect(h.registry.subjects()).toEqual([]);
  });

  it('sends one sub, one unsub and one essential frame at most per flush', () => {
    const h = harness();
    const going = h.registry.add(['q:1'], PX);
    const staying = h.registry.add(['q:2'], PX);
    h.registry.add(['q:3'], PX);
    h.pump.flushFrames();
    h.since();
    expect(staying.id).toBeGreaterThan(0);

    going.unsubscribe();
    h.registry.setEssential(['q:2'], false);
    h.registry.setEssential(['q:3'], false);
    h.registry.add(['q:4'], PX);
    h.pump.flushFrames();

    const frames = h.since();
    expect(frames.map((f) => f.t)).toEqual(['sub', 'unsub', 'essential']);
    expect(frames[2]).toEqual({ t: 'essential', subjects: ['q:2', 'q:3'], essential: false });
  });

  it('only one flush runs however many changes queue inside one tick', () => {
    const h = harness();
    h.registry.add(['q:42'], ['PX_LAST']);
    h.registry.add(['q:42'], ['PX_BID']);
    h.registry.add(['q:42'], ['PX_ASK']);
    expect(h.pump.queued).toBe(1);
    h.pump.flushFrames();
    expect(h.registry.frameCount).toBe(1);
    expect(subFrame(h.since()[0]!).subjects[0]!.f).toEqual(['PX_ASK', 'PX_BID', 'PX_LAST']);
  });
});

describe('SubscriptionRegistry — essential and the viewport (BUS-04, API.md §6.5)', () => {
  it('rides on the sub frame, then changes by its own frame', () => {
    const h = harness();
    h.registry.add(['q:42'], PX, { essential: false });
    h.pump.flushFrames();
    expect(subFrame(h.since()[0]!).subjects[0]!.essential).toBe(false);
    expect(h.registry.isEssential('q:42')).toBe(false);

    // The row scrolls into view.
    h.registry.setEssential(['q:42'], true);
    h.pump.flushFrames();
    expect(h.since()).toEqual([{ t: 'essential', subjects: ['q:42'], essential: true }]);
    expect(h.registry.isEssential('q:42')).toBe(true);

    // ...and out again.
    h.registry.setEssential(['q:42'], false);
    h.pump.flushFrames();
    expect(h.since()).toEqual([{ t: 'essential', subjects: ['q:42'], essential: false }]);

    // Setting what is already in force costs no frame.
    h.registry.setEssential(['q:42'], false);
    h.pump.flushFrames();
    expect(h.since()).toEqual([]);
  });

  it('is essential when any holder wants it, until the viewport says otherwise', () => {
    const h = harness();
    h.registry.add(['q:42'], PX, { essential: false });
    h.registry.add(['q:42'], PX, { essential: true });
    h.pump.flushFrames();
    expect(subFrame(h.since()[0]!).subjects[0]!.essential).toBe(true);

    // The viewport outranks the holders: this row is off screen whatever its widgets think.
    h.registry.setEssential(['q:42'], false);
    h.pump.flushFrames();
    expect(h.since()).toEqual([{ t: 'essential', subjects: ['q:42'], essential: false }]);
  });

  it('re-subs a shed subject when the row scrolls back into view', () => {
    const h = harness();
    h.registry.add(['q:42'], PX, { essential: false });
    h.pump.flushFrames();
    h.since();

    // The server shed it: `ws/conflator.ts#shedNonEssential` removed the hold, so re-flagging it
    // would flag a subscription that no longer exists.
    h.known.set('q:42', 4182);
    h.registry.markShed('q:42');
    expect(h.registry.isShed('q:42')).toBe(true);
    expect(h.registry.wireFields('q:42')).toBeNull();

    h.registry.setEssential(['q:42'], true);
    h.pump.flushFrames();
    const frame = subFrame(h.since()[0]!);
    expect(frame.subjects).toEqual([
      { s: 'q:42', f: ['PX_BID', 'PX_LAST'], essential: true, known: 4182 },
    ]);
    expect(h.registry.isShed('q:42')).toBe(false);
  });

  it('re-subs a shed subject that is already viewport-essential, with no flag transition to help', () => {
    const h = harness();
    h.registry.add(['q:42'], PX, { essential: false });
    h.registry.setEssential(['q:42'], true);
    h.pump.flushFrames();
    h.since();
    h.known.set('q:42', 991);

    // The server's shed decision raced ahead of the `essential` frame: it shed a subject this client
    // already believes is on screen. Scrolling the row back produces no false→true transition, so
    // `setEssential` returns early and only `markShed` can re-subscribe it (§6.5).
    h.registry.markShed('q:42');
    h.pump.flushFrames();
    const frame = subFrame(h.since()[0]!);
    expect(frame.subjects).toEqual([
      { s: 'q:42', f: ['PX_BID', 'PX_LAST'], essential: true, known: 991 },
    ]);
    expect(h.registry.isShed('q:42')).toBe(false);

    // And the redundant re-flag still costs nothing, so the re-sub is the only frame.
    h.registry.setEssential(['q:42'], true);
    h.pump.flushFrames();
    expect(h.since()).toEqual([]);
  });

  it('leaves a shed subject the viewport does not want shed, rather than fighting backpressure', () => {
    const h = harness();
    h.registry.add(['q:42'], PX, { essential: false });
    h.registry.setEssential(['q:42'], false);
    h.pump.flushFrames();
    h.since();

    // The server sheds only `essential:false` subjects when it is over HARD_BYTES. Answering that
    // with a fresh `sub` would loop against a socket already in trouble.
    h.registry.markShed('q:42');
    h.pump.flushFrames();
    expect(h.since()).toEqual([]);
    expect(h.registry.isShed('q:42')).toBe(true);
  });
});

describe('SubscriptionRegistry — the ack promise (API.md §10.2 L1335)', () => {
  it('resolves with the subAck rows for its own subjects only', async () => {
    const h = harness();
    const mine = h.registry.add(['q:42'], PX);
    const theirs = h.registry.add(['q:7'], PX);
    h.pump.flushFrames();

    const ack: SubscriptionAck = {
      accepted: [{ s: 'q:42', tier: 'delayed', reason: 'SOURCE_TIER_CAP' }],
      rejected: [{ s: 'q:7', code: 'SUBJECT_UNKNOWN', reason: 'no such subject' }],
    };
    h.registry.settle(ack);

    await expect(mine.ack).resolves.toEqual({
      accepted: [{ s: 'q:42', tier: 'delayed', reason: 'SOURCE_TIER_CAP' }],
      rejected: [],
    });
    await expect(theirs.ack).resolves.toEqual({
      accepted: [],
      rejected: [{ s: 'q:7', code: 'SUBJECT_UNKNOWN', reason: 'no such subject' }],
    });
  });

  it('resolves a later subscriber that needed no frame of its own', async () => {
    const h = harness();
    h.registry.add(['q:42'], PX);
    h.pump.flushFrames();
    h.registry.settle({
      accepted: [{ s: 'q:42', tier: 'delayed', reason: 'SOURCE_TIER_CAP' }],
      rejected: [],
    });

    const late = h.registry.add(['q:42'], PX);
    h.pump.flushFrames();
    expect(h.since().filter((f) => f.t === 'sub')).toHaveLength(1);
    await expect(late.ack).resolves.toEqual({
      accepted: [{ s: 'q:42', tier: 'delayed', reason: 'SOURCE_TIER_CAP' }],
      rejected: [],
    });
  });

  it('resolves empty rather than hanging when the subscription is released first', async () => {
    const h = harness();
    const sub = h.registry.add(['q:42'], PX);
    sub.unsubscribe();
    h.pump.flushFrames();
    await expect(sub.ack).resolves.toEqual({ accepted: [], rejected: [] });
  });
});

describe('SubscriptionRegistry — update fan-out (ARCHITECTURE §6.6)', () => {
  const state = { subject: 'q:42' } as never;

  it('narrows `changed` to each subscription and skips the ones nothing changed for', () => {
    const h = harness();
    const last = h.registry.add(['q:42'], ['PX_LAST']);
    const bid = h.registry.add(['q:42'], ['PX_BID']);
    const all = h.registry.add(['q:42'], '*');
    const other = h.registry.add(['q:7'], ['PX_LAST']);
    h.pump.flushFrames();

    const seen: Record<string, FieldId[][]> = { last: [], bid: [], all: [], other: [] };
    last.on('update', (e) => seen.last!.push(e.changed));
    bid.on('update', (e) => seen.bid!.push(e.changed));
    all.on('update', (e) => seen.all!.push(e.changed));
    other.on('update', (e) => seen.other!.push(e.changed));

    h.registry.dispatch({
      subject: 'q:42',
      seq: 4185,
      changed: ['PX_LAST', 'PX_VOLUME'],
      state,
      kind: 'delta',
    });

    expect(seen.last).toEqual([['PX_LAST']]);
    expect(seen.bid).toEqual([]);
    expect(seen.all).toEqual([['PX_LAST', 'PX_VOLUME']]);
    expect(seen.other).toEqual([]);
  });

  it('stops delivering to a handler that was removed, and to a released subscription', () => {
    const h = harness();
    const sub = h.registry.add(['q:42'], ['PX_LAST']);
    const seen: FieldId[][] = [];
    const off = sub.on('update', (e) => seen.push(e.changed));
    h.pump.flushFrames();

    const event = {
      subject: 'q:42',
      seq: 1,
      changed: ['PX_LAST'] as FieldId[],
      state,
      kind: 'delta' as const,
    };
    h.registry.dispatch(event);
    off();
    h.registry.dispatch(event);
    sub.unsubscribe();
    h.registry.dispatch(event);
    expect(seen).toEqual([['PX_LAST']]);
  });

  it('reaches every handler even when one of them throws', () => {
    const h = harness();
    const sub = h.registry.add(['q:42'], ['PX_LAST']);
    let reached = false;
    sub.on('update', () => {
      throw new Error('one panel is broken');
    });
    sub.on('update', () => {
      reached = true;
    });
    h.pump.flushFrames();

    expect(() => {
      h.registry.dispatch({
        subject: 'q:42',
        seq: 1,
        changed: ['PX_LAST'],
        state,
        kind: 'delta',
      });
    }).toThrow('one panel is broken');
    expect(reached).toBe(true);
  });
});

describe('SubscriptionRegistry — reconnect (API.md §6.3 step 6)', () => {
  it('re-subs every held subject with `known`, at once, without waiting for a frame', () => {
    const h = harness();
    h.registry.add(['q:42'], PX);
    h.registry.add(['q:7'], ['PX_LAST'], { essential: false });
    h.pump.flushFrames();
    h.since();

    h.known.set('q:42', 4182);
    h.known.set('q:7', 991);
    expect(h.registry.resumePlan()).toEqual([
      {
        subject: 'q:42',
        fields: ['PX_BID', 'PX_LAST'],
        essential: true,
        tier: 'delayed',
        known: 4182,
      },
      { subject: 'q:7', fields: ['PX_LAST'], essential: false, tier: 'delayed', known: 991 },
    ]);

    h.registry.resume();
    const frames = h.since();
    expect(frames).toHaveLength(1);
    expect(subFrame(frames[0]!).subjects).toEqual([
      { s: 'q:42', f: ['PX_BID', 'PX_LAST'], essential: true, known: 4182 },
      { s: 'q:7', f: ['PX_LAST'], essential: false, known: 991 },
    ]);
  });

  it('clear() drops everything and sends nothing', () => {
    const h = harness();
    const sub = h.registry.add(['q:42'], PX);
    h.pump.flushFrames();
    h.since();

    h.registry.clear();
    h.pump.flushFrames();
    expect(h.since()).toEqual([]);
    expect(h.registry.subjects()).toEqual([]);
    expect(h.registry.resumePlan()).toEqual([]);
    expect(sub.id).toBeGreaterThan(0);
  });
});

describe('SubscriptionRegistry — the conflation request (FUNCTIONS §10 Q6)', () => {
  it('reports the smallest conflationMs any live subscription asked for', () => {
    const h = harness();
    h.registry.add(['q:42'], PX, { conflationMs: 500 });
    const fast = h.registry.add(['q:43'], PX, { conflationMs: 100 });
    h.registry.add(['q:44'], PX);
    expect(h.registry.requestedConflationMs()).toBe(100);
    fast.unsubscribe();
    expect(h.registry.requestedConflationMs()).toBe(500);
  });
});

describe('SubscriptionManager', () => {
  it('is the same class WORKPLAN names', () => {
    expect(SubscriptionManager).toBe(SubscriptionRegistry);
  });
});
