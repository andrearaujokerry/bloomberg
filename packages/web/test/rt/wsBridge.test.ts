/**
 * packages/web/test/rt/wsBridge.test.ts — the realtime bridge (CLIENT.md §9 L621-660, the web test
 * list at CLIENT.md L160).
 *
 * The bridge is where a protocol event becomes something a person sees, so every assertion here is
 * about what the user is told, not about which method was called:
 *
 *   * a gap in the `prev` chain greys every live cell AND says so in words;
 *   * a subject the plant sheds is marked, remembered, and **re-subscribed when its row scrolls
 *     back into view** — the failure this guards against is a row that is blank for the rest of the
 *     session because nothing ever asked for it again;
 *   * the 1 s sweep restyles exactly the subjects whose `valueState` changed, computed by
 *     `core/quote/staleness.ts` through the real `QuoteCache` (TERM-12) — there is no second
 *     staleness rule in this repository and this test would fail if one appeared here.
 *
 * The `QuoteCache` is the REAL one from `@terminal/sdk`, fed real `snap` frames, so the staleness
 * assertion runs the shipped function over the shipped decode rather than a mock that agrees with
 * the test by construction. Only the socket is faked, because a socket is the one thing jsdom has
 * no honest version of.
 *
 * The grey itself is asserted on a REAL `CellRegistry` over real elements, not on a recorded call.
 * The earlier version of this file asserted `{ subject, st: 'stale' }` against a fake registry and
 * passed while the rendered cell kept `data-st='live'`, the live colour, the live glyph and the
 * accessible name "…, live" — for numbers the client had just refused to update. A test that asserts
 * the call cannot see that, which is the shape of every defect WP-12's audit found: it proves the
 * capability and never touches the product path. `RecordingRegistry` survives only for the
 * assertions that really are about routing (which subjects, in which order).
 */

import { QuoteCache } from '@terminal/sdk';
import type {
  DowngradeEvent,
  LiveCloseEvent,
  LiveErrorEvent,
  LiveState,
  Notice,
  Snap,
  StatusEvent,
  SubscribeOptions,
  Subscription,
  UpdateEvent,
} from '@terminal/sdk';
import type { FieldId, LiveSpec } from '@terminal/core';
import { afterEach, describe, expect, it } from 'vitest';

import { CellRegistry } from '../../src/grid/cellRegistry.js';
import type { CellRef } from '../../src/grid/types.js';
import { useSubscriptionsStore } from '../../src/state/subscriptions.js';
import { flushFrames } from '../setup.js';
import { createWsBridge, disposeWsBridge, getWsBridge, WsBridge } from '../../src/rt/wsBridge.js';
import type { BridgeNotice, CellRegistryPort, ChangeBatch, LiveClientPort, SubjectStatus } from '../../src/rt/wsBridge.js';

/* -------------------------------------------------------------------------------------------- */
/* The fake socket                                                                                */
/* -------------------------------------------------------------------------------------------- */

interface Handlers {
  update: ((e: UpdateEvent) => void)[];
  status: ((e: StatusEvent) => void)[];
  downgrade: ((e: DowngradeEvent) => void)[];
  notice: ((e: Notice) => void)[];
  state: ((s: LiveState) => void)[];
  error: ((e: LiveErrorEvent) => void)[];
  close: ((e: LiveCloseEvent) => void)[];
}

/** Every `setEssential` the bridge made, in order — the wire, as the registry would have seen it. */
interface EssentialCall {
  subjects: string[];
  essential: boolean;
}

class FakeClient implements LiveClientPort {
  state: LiveState = 'open';
  sessionId: string | null = 'session-1';
  conflationMs = 250;
  stats = { resyncs: 0 };
  readonly quoteCache = new QuoteCache({ clock: { now: () => this.now } });
  readonly essentialCalls: EssentialCall[] = [];
  readonly shedSubjects = new Set<string>();
  now = 1_700_000_000_000;
  connected = false;
  closedWith: number | null = null;

  readonly handlers: Handlers = {
    update: [],
    status: [],
    downgrade: [],
    notice: [],
    state: [],
    error: [],
    close: [],
  };

  readonly subscriptions = {
    isShed: (subject: string): boolean => this.shedSubjects.has(subject),
  };

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000;
    this.connected = false;
  }

  readonly subCalls: { subjects: string[]; fields: FieldId[] | '*'; opts?: SubscribeOptions }[] = [];

  subscribe(subjects: string[], fields: FieldId[] | '*', opts?: SubscribeOptions): Subscription {
    this.subCalls.push({ subjects: [...subjects], fields, ...(opts === undefined ? {} : { opts }) });
    return {
      id: this.subCalls.length,
      subjects,
      fields,
      ack: Promise.resolve({ accepted: [], rejected: [] }),
      on: () => () => undefined,
      unsubscribe: () => undefined,
    };
  }

  setEssential(subjects: string[], essential: boolean): void {
    this.essentialCalls.push({ subjects: [...subjects], essential });
  }

  setConflation(ms: number): void {
    this.conflationMs = ms;
  }

  on(event: string, h: (e: never) => void): () => void {
    const list = this.handlers[event as keyof Handlers] as unknown[];
    list.push(h);
    return () => {
      const at = list.indexOf(h);
      if (at >= 0) list.splice(at, 1);
    };
  }

  // ── What a server would do ──────────────────────────────────────────────────────────────────

  /** Apply a real `snap` through the real cache and emit the `update` the client would emit. */
  snap(subject: string, fields: Record<string, number>, seq = 1): void {
    const frame: Snap = {
      t: 'snap',
      s: subject,
      seq,
      tier: 'delayed',
      reason: 'SOURCE_TIER_CAP',
      f: fields,
      ts: { src: this.now, cap: this.now, pub: this.now },
      st: 'live',
      session: 'open',
      prov: { p: 'cboe.quotes', id: 1 },
      ac: 'equity',
      id: 42,
    };
    const result = this.quoteCache.apply(frame);
    const view = this.quoteCache.get(subject);
    if (view === undefined) throw new Error('the cache refused the snapshot');
    this.emit('update', { subject, seq, changed: result.changed, state: view, kind: 'snap' });
  }

  emit<E extends keyof Handlers>(event: E, payload: Parameters<Handlers[E][number]>[0]): void {
    for (const h of [...this.handlers[event]] as ((e: unknown) => void)[]) h(payload);
  }

  setState(next: LiveState): void {
    this.state = next;
    this.emit('state', next);
  }
}

/** Records what the cell registry was asked to do. */
class RecordingRegistry implements CellRegistryPort {
  readonly batches: ChangeBatch[] = [];
  readonly statuses: { subject: string; st: SubjectStatus }[] = [];
  readonly cleared: string[] = [];
  readonly restyled: string[][] = [];
  flashSweeps = 0;

  apply(batch: ChangeBatch): void {
    this.batches.push(batch);
  }

  setSubjectStatus(subject: string, st: SubjectStatus): void {
    this.statuses.push({ subject, st });
  }

  clearSubjectStatus(subject: string): void {
    this.cleared.push(subject);
  }

  restyle(subjects: string[]): void {
    this.restyled.push([...subjects]);
  }

  sweepFlashes(): void {
    this.flashSweeps += 1;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* A real registry over real cells — what a reader would actually see                              */
/* -------------------------------------------------------------------------------------------- */

interface Screen {
  client: FakeClient;
  registry: CellRegistry;
  bridge: WsBridge;
  notices: BridgeNotice[];
  /** The element showing one (subject, field), as the grid would have registered it. */
  cell(subject: string, field: FieldId): HTMLElement;
}

/**
 * A bridge wired to a real {@link CellRegistry} with real elements in the document.
 *
 * The cells are registered exactly as `LiveGrid`'s `GridCell` registers them — same `CellRef`, same
 * registry, same clock as the client — so what these tests read off the DOM is what the grid draws.
 */
async function screenRig(subjects: readonly { subject: string; fields: FieldId[] }[]): Promise<Screen> {
  const client = new FakeClient();
  const registry = new CellRegistry({ now: () => client.now });
  const bridge = new WsBridge({ client, registry, ticker: false, now: () => client.now });
  const notices: BridgeNotice[] = [];
  bridge.onNotice((n) => notices.push(n));
  await bridge.start();

  const host = document.createElement('div');
  document.body.appendChild(host);
  const elements = new Map<string, HTMLElement>();
  for (const { subject, fields } of subjects) {
    for (const field of fields) {
      const el = document.createElement('div');
      el.setAttribute('role', 'gridcell');
      host.appendChild(el);
      elements.set(`${subject}/${field}`, el);
      const ref: CellRef = {
        el,
        subject,
        fieldId: field,
        label: field,
        fmt: 'px',
        signed: false,
        last: null,
        lastTs: null,
        st: 'blank',
        reason: undefined,
      };
      registry.register(ref);
    }
  }

  return {
    client,
    registry,
    bridge,
    notices,
    cell(subject, field) {
      const el = elements.get(`${subject}/${field}`);
      if (el === undefined) throw new Error(`no cell for ${subject} ${field}`);
      return el;
    },
  };
}

interface Rig {
  client: FakeClient;
  registry: RecordingRegistry;
  bridge: WsBridge;
  notices: BridgeNotice[];
}

async function rig(): Promise<Rig> {
  const client = new FakeClient();
  const registry = new RecordingRegistry();
  const bridge = new WsBridge({ client, registry, ticker: false, now: () => client.now });
  const notices: BridgeNotice[] = [];
  bridge.onNotice((n) => notices.push(n));
  await bridge.start();
  return { client, registry, bridge, notices };
}

afterEach(() => {
  disposeWsBridge();
  useSubscriptionsStore.getState().reset();
});

/* -------------------------------------------------------------------------------------------- */

describe('wsBridge fan-out', () => {
  it('hands every update to the cell registry unfiltered', async () => {
    const { client, registry, bridge } = await rig();
    client.snap('q:42', { PX_LAST: 330.27, PX_VOLUME: 16_591_786 });

    expect(registry.batches).toHaveLength(1);
    expect(registry.batches[0]?.subject).toBe('q:42');
    expect(registry.batches[0]?.changed.sort()).toEqual(['PX_LAST', 'PX_VOLUME']);
    // The view handed on is the cache's own, not a copy the bridge assembled.
    expect(registry.batches[0]?.state).toBe(client.quoteCache.get('q:42'));
    bridge.stop();
  });

  it('attaches itself to the subscriptions store, so a panel that paints reaches the socket', async () => {
    const { client, bridge } = await rig();
    expect(client.connected).toBe(true);

    // What a `ScreenHost` does when a screen returns a `LiveSpec` (CLIENT.md §9). Nothing reaches
    // the wire unless the bridge attached itself: `state/subscriptions.ts` holds no client of its
    // own, by design.
    const spec: LiveSpec = { subjects: ['q:42'], fields: ['PX_LAST'], essential: ['q:42'] };
    useSubscriptionsStore.getState().acquire('p1', spec);

    expect(client.subCalls).toEqual([
      { subjects: ['q:42'], fields: ['PX_LAST'], opts: { essential: true } },
    ]);

    // …and it detaches on stop, so a disposed bridge cannot be subscribed through.
    bridge.stop();
    expect(client.closedWith).not.toBeNull();
    useSubscriptionsStore.getState().acquire('p2', spec);
    expect(client.subCalls).toHaveLength(1);
  });
});

describe('wsBridge gap and resync UI', () => {
  it('greys the CELLS a reader is looking at, and says what happened', async () => {
    const rigged = await screenRig([
      { subject: 'q:1', fields: ['PX_LAST'] },
      { subject: 'q:2', fields: ['PX_LAST'] },
    ]);
    const { client, bridge, notices } = rigged;
    client.snap('q:1', { PX_LAST: 10 });
    client.snap('q:2', { PX_LAST: 20 });
    flushFrames(1);

    const one = rigged.cell('q:1', 'PX_LAST');
    expect(one.getAttribute('data-st')).toBe('live');
    expect(one.getAttribute('aria-label')).toBe('PX_LAST: 10.00, live');
    const value = one.textContent;

    client.stats.resyncs = 2;
    client.setState('resyncing');

    // Every assertion is on the cell, because the gap is the one failure this protocol can detect
    // and cannot repair silently: the numbers on screen are the last good ones and nothing about them
    // says so. `data-st` is what `tokens.css` colours and what adds the `·`; the accessible name is
    // what the state is SAID in, since a grey and a dot reach nobody who is not looking at them.
    for (const subject of ['q:1', 'q:2']) {
      const cell = rigged.cell(subject, 'PX_LAST');
      expect(cell.getAttribute('data-st')).toBe('stale');
      expect(cell.getAttribute('aria-label')).toContain('stale, no fresh update');
      expect(cell.title).toContain('stale');
    }
    // The value is kept: throwing away the last good number would lose information the client still
    // has. What changes is the claim made about it.
    expect(one.textContent).toBe(value);

    expect(notices.at(-1)?.kind).toBe('resync');
    expect(notices.at(-1)?.text).toContain('lost updates on 2 subjects');
    expect(bridge.status.resyncing).toBe(true);

    client.setState('open');
    expect(notices.at(-1)?.text).toBe('prices resynchronised');
    expect(bridge.status.resyncing).toBe(false);
    expect(bridge.status.resyncs).toBe(2);
    bridge.stop();
  });

  it('takes the grey off when the healing snapshot lands, even if it changes nothing', async () => {
    const rigged = await screenRig([{ subject: 'q:1', fields: ['PX_LAST'] }]);
    const { client, bridge } = rigged;
    client.snap('q:1', { PX_LAST: 10 });
    flushFrames(1);
    client.stats.resyncs = 1;
    client.setState('resyncing');

    const cell = rigged.cell('q:1', 'PX_LAST');
    expect(cell.getAttribute('data-st')).toBe('stale');

    // The snapshot that ends the resync, restating the same price. `QuoteCache` reports NO changed
    // fields for it, so nothing the values drive would ever repaint this cell: a grey that only a new
    // number could lift would stay on the screen for the rest of the session, and "you cannot trade
    // on this" would be as false as "you can" was before.
    client.snap('q:1', { PX_LAST: 10 }, 2);
    client.setState('open');
    flushFrames(1);

    expect(cell.getAttribute('data-st')).toBe('live');
    expect(cell.getAttribute('data-status')).toBeNull();
    expect(cell.getAttribute('aria-label')).toBe('PX_LAST: 10.00, live');
    expect(cell.title).not.toContain('stale');
    bridge.stop();
  });

  it('announces a single lost frame in the singular', async () => {
    const { client, bridge, notices } = await rig();
    client.stats.resyncs = 1;
    client.setState('resyncing');
    expect(notices.at(-1)?.text).toBe('lost an update — refetching the affected prices');
    bridge.stop();
  });
});

describe('wsBridge shed handling', () => {
  it('marks a shed subject, tells the user, and records it for the viewport', async () => {
    const { client, registry, bridge, notices } = await rig();
    client.snap('q:7', { PX_LAST: 1 });

    client.shedSubjects.add('q:7');
    client.emit('status', { subject: 'q:7', st: 'shed', reason: 'SLOW_CONSUMER' });

    expect(registry.statuses.at(-1)).toEqual({ subject: 'q:7', st: 'shed' });
    expect(bridge.shed).toEqual(['q:7']);
    expect(useSubscriptionsStore.getState().shed.has('q:7')).toBe(true);
    expect(notices.at(-1)?.kind).toBe('shed');
    bridge.stop();
  });

  it('re-subscribes a shed subject when its row scrolls back into view', async () => {
    const { client, bridge } = await rig();
    client.shedSubjects.add('q:7');
    client.emit('status', { subject: 'q:7', st: 'shed', reason: 'SLOW_CONSUMER' });

    bridge.setVisible(['q:7', 'q:8']);

    // The pair is what forces the registry to re-derive a `sub` for a subject the viewport already
    // considered essential; without it the row stays blank for the rest of the session.
    expect(client.essentialCalls).toEqual([
      { subjects: ['q:7'], essential: false },
      { subjects: ['q:7', 'q:8'], essential: true },
    ]);
    bridge.stop();
  });

  it('sends only the difference when the viewport scrolls', async () => {
    const { client, bridge } = await rig();
    bridge.setVisible(['q:1', 'q:2', 'q:3']);
    client.essentialCalls.length = 0;

    bridge.setVisible(['q:2', 'q:3', 'q:4']);

    expect(client.essentialCalls).toEqual([
      { subjects: ['q:4'], essential: true },
      { subjects: ['q:1'], essential: false },
    ]);
    bridge.stop();
  });

  it('clears the shed mark when the fresh snapshot arrives', async () => {
    const { client, registry, bridge } = await rig();
    client.emit('status', { subject: 'q:9', st: 'shed' });
    expect(bridge.shed).toEqual(['q:9']);

    client.snap('q:9', { PX_LAST: 5 });

    expect(bridge.shed).toEqual([]);
    expect(useSubscriptionsStore.getState().shed.has('q:9')).toBe(false);
    // The cells are told too, and before the snapshot's values are written.
    expect(registry.cleared).toEqual(['q:9']);
    bridge.stop();
  });

  it('a shed subject that comes back stops reading stale, on the cell', async () => {
    const rigged = await screenRig([{ subject: 'q:7', fields: ['PX_LAST'] }]);
    const { client, bridge } = rigged;
    client.snap('q:7', { PX_LAST: 1 });
    flushFrames(1);
    const cell = rigged.cell('q:7', 'PX_LAST');

    client.emit('status', { subject: 'q:7', st: 'shed', reason: 'SLOW_CONSUMER' });
    expect(cell.getAttribute('data-st')).toBe('stale');
    expect(cell.getAttribute('aria-label')).toContain('shed');

    client.snap('q:7', { PX_LAST: 1 }, 2);
    flushFrames(1);
    expect(cell.getAttribute('data-st')).toBe('live');
    expect(cell.getAttribute('aria-label')).not.toContain('shed');
    bridge.stop();
  });
});

describe('wsBridge staleness sweep (TERM-12)', () => {
  it('restyles exactly the subjects whose valueState changed, per the core function', async () => {
    const { client, registry, bridge } = await rig();
    client.snap('q:1', { PX_LAST: 10 });
    client.snap('q:2', { PX_LAST: 20 });

    // Nothing has aged: the sweep returns nothing and no cell is touched.
    expect(bridge.sweep(client.now)).toEqual([]);
    expect(registry.restyled).toEqual([]);

    // A delayed line is expected every 10 s and `valueState` calls it stale at 3 x that. The
    // threshold is the shipped function's, not this test's: the assertion is that the bridge
    // forwards what the sweep returned, whatever the function decides.
    client.now += 60_000;
    const changed = bridge.sweep(client.now);
    expect(changed.sort()).toEqual(['q:1', 'q:2']);
    expect(registry.restyled.at(-1)?.sort()).toEqual(['q:1', 'q:2']);
    expect(client.quoteCache.get('q:1')?.st).toBe('stale');
    bridge.stop();
  });

  it('sweeps the flashes every second, even on a second when nothing changed state', async () => {
    const { registry, bridge } = await rig();
    expect(registry.flashSweeps).toBe(0);
    // No subject aged, so `restyle` is not called — and that is exactly the second on which a flash
    // left lit by an `animationend` that never fired has to come off. A backstop that only runs when
    // something else happened is not a backstop.
    expect(bridge.sweep()).toEqual([]);
    expect(registry.restyled).toEqual([]);
    expect(registry.flashSweeps).toBe(1);
    bridge.stop();
  });

  it('clears a real lit flash a second after the feed stops', async () => {
    const rigged = await screenRig([{ subject: 'q:1', fields: ['PX_LAST'] }]);
    const { client, bridge } = rigged;
    client.snap('q:1', { PX_LAST: 10 });
    flushFrames(1);
    client.snap('q:1', { PX_LAST: 11 }, 2);
    flushFrames(1);

    const cell = rigged.cell('q:1', 'PX_LAST');
    expect(cell.classList.contains('flash-up')).toBe(true);

    // The market closed: no further frame will ever be scheduled, so the per-frame sweep cannot run.
    // The staleness second runs regardless, which is the property that makes it a backstop.
    client.now += 3 * 700 + 1;
    bridge.sweep();
    expect(cell.classList.contains('flash-up')).toBe(false);
    bridge.stop();
  });
});

describe('wsBridge notices', () => {
  it('names the subject, both tiers and the reason in a downgrade', async () => {
    const { client, bridge, notices } = await rig();
    client.emit('downgrade', {
      subject: 'q:42',
      from: 'delayed',
      to: 'eod',
      reason: 'NOT_ENTITLED_TIER',
    });
    expect(notices.at(-1)?.text).toBe('q:42 downgraded delayed → eod (NOT_ENTITLED_TIER)');
    expect(notices.at(-1)?.subject).toBe('q:42');
    bridge.stop();
  });

  it('reports conflation widening and restoration with the interval in force', async () => {
    const { client, bridge, notices } = await rig();
    client.emit('notice', {
      t: 'notice',
      kind: 'slow-consumer',
      action: 'conflation-widened',
      conflationMs: 1_000,
    });
    expect(notices.at(-1)?.text).toContain('1000 ms');
    expect(notices.at(-1)?.tone).toBe('warn');

    client.emit('notice', {
      t: 'notice',
      kind: 'slow-consumer',
      action: 'conflation-restored',
      conflationMs: 250,
    });
    expect(notices.at(-1)?.text).toContain('250 ms');
    expect(notices.at(-1)?.tone).toBe('info');
    bridge.stop();
  });

  it('raises the disconnect warning as an error', async () => {
    const { client, bridge, notices } = await rig();
    client.emit('notice', { t: 'notice', kind: 'slow-consumer', action: 'disconnect-soon' });
    expect(notices.at(-1)?.tone).toBe('error');
    bridge.stop();
  });
});

describe('one socket for the whole application (TERM-04)', () => {
  it('refuses to build a second bridge and hands the first one back instead', () => {
    const first = createWsBridge({ client: new FakeClient(), ticker: false, attachStore: false });
    expect(getWsBridge()).toBe(first);
    expect(() => createWsBridge({ client: new FakeClient(), ticker: false })).toThrow(
      /one socket/,
    );
    disposeWsBridge();
    expect(getWsBridge()).toBeNull();
  });
});
