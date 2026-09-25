// packages/web/src/rt/wsBridge.ts — `LiveClient` → `QuoteCache` → the cell registry (CLIENT.md §9
// L621-660, ARCHITECTURE §6.6 L950-968, TERM-04, TERM-08, TERM-12, ENTL-05).
//
// ONE SOCKET FOR THE WHOLE APPLICATION. Four panels, forty widgets and every chart share a single
// `LiveClient`, and this module is the only thing that holds it (TERM-04). That is not an
// optimisation: API.md §6.3 step 1 says a second socket for the same session REPLACES the first,
// which is then closed `4003 SESSION_SUPERSEDED`. Two owners would not mean two streams; it would
// mean two halves of the terminal taking the socket from each other, each seeing its own prices go
// dead for a second at a time, with no error anywhere to explain it. {@link getWsBridge} is the
// accessor and {@link createWsBridge} refuses to build a second live bridge.
//
// ## What this file owns
//
//   * **Fan-out.** `update` → `cellRegistry.apply()`, which writes cells imperatively outside React
//     (ARCHITECTURE §6.6). This module never re-renders anything: it hands a batch to the registry
//     and returns.
//   * **The gap and resync UI.** When the client resyncs, the user is TOLD. See below.
//   * **Shed and re-subscribe.** A subject the plant shed keeps its last value, gets the shed
//     state, and is re-subscribed when its row scrolls back into view (§6.5, API.md §10.2).
//   * **The 1 s staleness sweep** across every subject on the socket (TERM-12) — driven by
//     `QuoteCache.sweep()`, which calls `core/quote/staleness.ts#valueState`, which is the same
//     function the server's sweep calls. There is exactly one staleness implementation in this
//     system and this file does not contain a second one; it does not contain a comparison against
//     a timestamp either, because that is how the second one would start.
//   * **Downgrades, notices, connection state** → a notice stream the status bar and the toaster
//     read.
//
// ## Why a resync is announced
//
// A gap in the `prev` chain is the one failure this protocol can detect and cannot repair silently.
// `QuoteCache` refuses the gapped delta, `LiveClient` asks for a fresh `snap`, and for the interval
// between the two the numbers on the screen are the last good ones — correct as of some moment in
// the past, with no way for a reader to know which. When the snap lands, several cells may change
// at once for no reason the user did anything to cause.
//
// A screen that quietly reloads its numbers is indistinguishable from one that is lying. So the
// resync is stated twice, in the two places that answer different questions: every live cell drops
// to `stale` for the duration, which answers "can I trade on this number right now" at the point of
// use, and a notice says the terminal lost frames and is refetching, which answers "what just
// happened to my screen". Both clear when the fresh snapshot arrives. The cost is a second of grey;
// the alternative is a trader acting on a price whose provenance has a hole in it.
//
// "Both clear when the fresh snapshot arrives" is a promise, and it is kept by
// `clearSubjectStatus(subject)` on every `snap` — not by the snapshot's values. A resync snap that
// changes nothing reports no changed fields at all (`QuoteCache.#applySnap`), so a grey that only
// values could lift would never lift on exactly the subjects whose prices were right all along.

import type { FieldId } from '@terminal/core';
import { LiveClient } from '@terminal/sdk';
import type {
  ClientOptions,
  DowngradeEvent,
  LiveCloseEvent,
  LiveErrorEvent,
  LiveState,
  Notice,
  QuoteCache,
  QuoteView,
  StatusEvent,
  SubscribeOptions,
  Subscription,
  UpdateEvent,
} from '@terminal/sdk';

import { useSubscriptionsStore } from '../state/subscriptions.js';

/* -------------------------------------------------------------------------------------------- */
/* Ports                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** The `status` frame's verdict about a subject (`wire/ws.ts`). */
export type SubjectStatus = StatusEvent['st'];

/** One subject's changed fields and the view they changed to — `cellRegistry.apply()`'s argument. */
export interface ChangeBatch {
  subject: string;
  changed: FieldId[];
  state: QuoteView;
}

/**
 * The slice of `grid/cellRegistry.ts` this bridge calls (CLIENT.md §10.4).
 *
 * Declared structurally, and injected, for two reasons that both outlive the build order. The
 * registry is a DOM-owning singleton; a bridge that imported it could not be tested without a
 * document, and the thing most worth testing here — that a gapped stream greys the cells and says
 * so — is about which calls are made, not about what they draw. And more than one consumer wants
 * the same fan-out: the chart's streaming layer and the news list's prepend are the same shape
 * (CLIENT.md §9), so the port is what lets them be added without this file learning about them.
 */
export interface CellRegistryPort {
  /** Write the changed fields of one subject into their cells, coalesced to one animation frame. */
  apply(batch: ChangeBatch): void;
  /** The subject-level state: `shed` keeps the last value and marks it, `gone` blanks it. */
  setSubjectStatus(subject: string, st: SubjectStatus): void;
  /** Take a subject's status back off — what a `snap` does to a gap grey or a shed mark. */
  clearSubjectStatus(subject: string): void;
  /** The staleness sweep's restyle — `data-st` only, no value writes (TERM-12). */
  restyle(subjects: string[]): void;
  /**
   * Clear any flash whose animation never ended. Driven from the 1 s ticker as well as from the
   * frame, because the case a backstop exists for — the feed falling quiet — is the case where no
   * further frame is ever scheduled (`grid/flash.ts`).
   */
  sweepFlashes(now: number): void;
}

/**
 * The slice of `LiveClient` the bridge drives. `LiveClient` satisfies it; a test passes a fake.
 *
 * This is deliberately NOT a re-declaration of the client's surface: it is the subset this file is
 * allowed to use. Anything missing here — `subscribe` options, the registry's internals — is
 * something the bridge has no business reaching for.
 */
export interface LiveClientPort {
  readonly state: LiveState;
  readonly sessionId: string | null;
  readonly conflationMs: number;
  readonly quoteCache: QuoteCache;
  readonly stats: { readonly resyncs: number };
  readonly subscriptions: { isShed(subject: string): boolean };
  connect(): Promise<void>;
  close(code?: number): void;
  subscribe(subjects: string[], fields: FieldId[] | '*', opts?: SubscribeOptions): Subscription;
  setEssential(subjects: string[], essential: boolean): void;
  setConflation(ms: number): void;
  on(event: 'update', h: (e: UpdateEvent) => void): () => void;
  on(event: 'status', h: (e: StatusEvent) => void): () => void;
  on(event: 'downgrade', h: (e: DowngradeEvent) => void): () => void;
  on(event: 'notice', h: (e: Notice) => void): () => void;
  on(event: 'state', h: (s: LiveState) => void): () => void;
  on(event: 'error', h: (e: LiveErrorEvent) => void): () => void;
  on(event: 'close', h: (e: LiveCloseEvent) => void): () => void;
}

/* -------------------------------------------------------------------------------------------- */
/* What the shell reads                                                                           */
/* -------------------------------------------------------------------------------------------- */

export type BridgeNoticeKind =
  | 'resync'
  | 'resynced'
  | 'shed'
  | 'downgrade'
  | 'conflation'
  | 'overload'
  | 'maintenance'
  | 'disconnect'
  | 'error';

export type BridgeTone = 'info' | 'warn' | 'error';

/** One thing the user is told. The status bar shows the latest; the toaster shows the `warn`s up. */
export interface BridgeNotice {
  /** Monotonic within one bridge — a React key, and what makes two identical texts two notices. */
  id: number;
  kind: BridgeNoticeKind;
  tone: BridgeTone;
  /** Already written for a human: this is what appears in the toast. */
  text: string;
  at: number;
  subject?: string;
}

/** The status bar's whole view of the socket (CLIENT.md §9, §3.2). */
export interface BridgeStatus {
  state: LiveState;
  sessionId: string | null;
  /** The interval in force — widened by a `notice` under backpressure (§6.5). */
  conflationMs: number;
  /** Subjects the plant is currently shedding. */
  shed: readonly string[];
  /** Broken `prev` chains since the socket opened. Zero is the number this should be. */
  resyncs: number;
  /** True between the gap and the fresh snapshot: every live cell is grey. */
  resyncing: boolean;
  lastNotice: BridgeNotice | null;
}

/** How many notices are kept for the status bar's history popover. */
const NOTICE_HISTORY = 50;

export interface WsBridgeOptions {
  /** Built when absent, from {@link WsBridgeOptions.clientOptions}. */
  client?: LiveClientPort | undefined;
  clientOptions?: ClientOptions | undefined;
  registry?: CellRegistryPort | undefined;
  /** Default `Date.now`. */
  now?: (() => number) | undefined;
  /**
   * Drive the 1 s staleness sweep off `QuoteCache`'s own ticker. Default `true`; a test that owns
   * its clock passes `false` and calls {@link WsBridge.sweep} instead of waiting a second.
   */
  ticker?: boolean | undefined;
  /** Attach to `state/subscriptions.ts` so panels' `acquire()` reaches the socket. Default `true`. */
  attachStore?: boolean | undefined;
}

/* -------------------------------------------------------------------------------------------- */
/* The bridge                                                                                     */
/* -------------------------------------------------------------------------------------------- */

export class WsBridge {
  readonly #client: LiveClientPort;
  readonly #now: () => number;
  readonly #attachStore: boolean;
  readonly #useTicker: boolean;

  #registry: CellRegistryPort | null = null;
  #unsubscribers: (() => void)[] = [];
  #stopTicker: (() => void) | null = null;
  #started = false;
  #disposed = false;

  #noticeId = 0;
  #notices: BridgeNotice[] = [];
  readonly #noticeHandlers = new Set<(n: BridgeNotice) => void>();
  readonly #statusHandlers = new Set<(s: BridgeStatus) => void>();

  /** Subjects the plant shed, kept so the virtualiser can re-subscribe them on scroll-in. */
  readonly #shed = new Set<string>();
  /** What the viewport last reported as visible, so a scroll sends only the difference. */
  #visible: ReadonlySet<string> = new Set<string>();
  /** True between a gap and the snapshot that heals it. */
  #resyncing = false;
  #resyncs = 0;

  constructor(options: WsBridgeOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#attachStore = options.attachStore ?? true;
    this.#useTicker = options.ticker ?? true;
    if (options.client !== undefined) {
      this.#client = options.client;
    } else {
      const clientOptions = options.clientOptions;
      if (clientOptions === undefined) {
        throw new TypeError('WsBridge: pass either `client` or `clientOptions`');
      }
      this.#client = new LiveClient(clientOptions);
    }
    if (options.registry !== undefined) this.#registry = options.registry;
  }

  /** The one `LiveClient` — what `rt/conflation.ts` and the SDK-facing hooks read. */
  get client(): LiveClientPort {
    return this.#client;
  }

  /** `LiveClient`'s own cache, never a copy: the ticker sweeps what the grid renders (CLIENT §9). */
  get quoteCache(): QuoteCache {
    return this.#client.quoteCache;
  }

  get status(): BridgeStatus {
    return {
      state: this.#client.state,
      sessionId: this.#client.sessionId,
      conflationMs: this.#client.conflationMs,
      shed: [...this.#shed],
      resyncs: this.#resyncs,
      resyncing: this.#resyncing,
      lastNotice: this.#notices.length === 0 ? null : (this.#notices[this.#notices.length - 1] ?? null),
    };
  }

  /** The notices in arrival order, oldest first (at most {@link NOTICE_HISTORY}). */
  get notices(): readonly BridgeNotice[] {
    return this.#notices;
  }

  // ── Wiring ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Point the fan-out at a cell registry, or at nothing.
   *
   * Frames that arrive with no registry attached are NOT queued. They are already in the
   * `QuoteCache` — that is what makes them safe to skip — so a grid that mounts mid-stream reads
   * the current value out of the cache on its first render rather than replaying a history of
   * changes to cells that did not exist when they happened.
   */
  attach(registry: CellRegistryPort | null): void {
    this.#registry = registry;
  }

  /**
   * Open the socket and wire the events. Idempotent: a second call while the first is live returns
   * the same connection, because there is only one.
   */
  async start(): Promise<void> {
    if (this.#disposed) throw new Error('WsBridge: this bridge has been disposed');
    if (!this.#started) {
      this.#started = true;
      this.#wire();
      if (this.#attachStore) useSubscriptionsStore.getState().attach(this.#client);
      if (this.#useTicker) {
        this.#stopTicker = this.#client.quoteCache.startTicker((subjects) => {
          this.#onSweep(subjects);
        });
      }
    }
    await this.#client.connect();
  }

  /** Close the socket, drop the listeners and stop the ticker. The bridge cannot be restarted. */
  stop(code?: number): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const off of this.#unsubscribers) off();
    this.#unsubscribers = [];
    this.#stopTicker?.();
    this.#stopTicker = null;
    if (this.#attachStore) useSubscriptionsStore.getState().attach(null);
    this.#registry = null;
    if (this.#started) {
      if (code === undefined) this.#client.close();
      else this.#client.close(code);
    }
    this.#started = false;
  }

  /** Status-bar subscription; fires on every change and returns an unsubscribe. */
  onStatus(handler: (s: BridgeStatus) => void): () => void {
    this.#statusHandlers.add(handler);
    return () => {
      this.#statusHandlers.delete(handler);
    };
  }

  /** Toast subscription: one call per notice, in order. */
  onNotice(handler: (n: BridgeNotice) => void): () => void {
    this.#noticeHandlers.add(handler);
    return () => {
      this.#noticeHandlers.delete(handler);
    };
  }

  #wire(): void {
    const c = this.#client;
    this.#unsubscribers.push(
      c.on('update', (e) => {
        this.#onUpdate(e);
      }),
      c.on('status', (e) => {
        this.#onStatusFrame(e);
      }),
      c.on('downgrade', (e) => {
        this.#onDowngrade(e);
      }),
      c.on('notice', (e) => {
        this.#onNoticeFrame(e);
      }),
      c.on('state', (s) => {
        this.#onState(s);
      }),
      c.on('error', (e) => {
        this.#onError(e);
      }),
      c.on('close', (e) => {
        this.#onClose(e);
      }),
    );
  }

  // ── The tick path ─────────────────────────────────────────────────────────────────────────────

  /**
   * One subject's changed fields → the cells that show them.
   *
   * Nothing is filtered here. `UpdateEvent.changed` is already the exact set of fields whose values
   * moved (`QuoteCache.apply` computed it), and the registry already knows which of them have cells
   * — so a second filter in between could only ever be a place for the two to disagree.
   */
  #onUpdate(e: UpdateEvent): void {
    if (e.kind === 'snap') {
      // A snapshot is how a resync ends and how a shed subject comes back: both are "this subject
      // is whole again", and both are said by the same frame. The cells are told the same thing —
      // the gap grey and the shed mark come off here, before the snapshot's values are written, so
      // the values land with the status the frame establishes and not the one it ended.
      this.#registry?.clearSubjectStatus(e.subject);
      if (this.#shed.delete(e.subject)) {
        useSubscriptionsStore.getState().markShed(e.subject, false);
        this.#emitStatus();
      }
    }
    this.#registry?.apply({ subject: e.subject, changed: e.changed, state: e.state });
  }

  #onStatusFrame(e: StatusEvent): void {
    this.#registry?.setSubjectStatus(e.subject, e.st);
    if (e.st === 'shed') {
      if (!this.#shed.has(e.subject)) {
        this.#shed.add(e.subject);
        useSubscriptionsStore.getState().markShed(e.subject, true);
        // Per subject, not per shed event: a slow consumer sheds hundreds at once and one toast per
        // subject would bury the screen. The `notice { action:'shed' }` frame that follows the
        // batch is the one the user is shown; this notice is the per-subject record behind it.
        this.#push('shed', 'warn', `${e.subject} shed by the plant — re-subscribed when visible`, {
          subject: e.subject,
        });
      }
      return;
    }
    if (this.#shed.delete(e.subject)) {
      useSubscriptionsStore.getState().markShed(e.subject, false);
      this.#emitStatus();
    }
    if (e.st === 'gone') {
      this.#push('error', 'warn', `${e.subject} is gone from the plant${reasonSuffix(e.reason)}`, {
        subject: e.subject,
      });
    }
  }

  #onDowngrade(e: DowngradeEvent): void {
    const subject = e.subject ?? 'the session';
    const to = e.to ?? 'no data';
    this.#push('downgrade', 'warn', `${subject} downgraded ${e.from} → ${to} (${e.reason})`, {
      ...(e.subject === undefined ? {} : { subject: e.subject }),
    });
  }

  #onNoticeFrame(n: Notice): void {
    const ms = n.conflationMs;
    switch (n.action) {
      case 'conflation-widened':
        this.#push(
          n.kind === 'overload' ? 'overload' : 'conflation',
          'warn',
          `updates slowed to ${String(ms ?? this.#client.conflationMs)} ms (${n.kind})`,
        );
        break;
      case 'conflation-restored':
        this.#push(
          'conflation',
          'info',
          `updates restored to ${String(ms ?? this.#client.conflationMs)} ms`,
        );
        break;
      case 'shed':
        this.#push('shed', 'warn', 'off-screen subscriptions were shed to keep up');
        break;
      case 'disconnect-soon':
        this.#push('disconnect', 'error', 'the server is about to disconnect this session');
        break;
    }
    if (n.kind === 'maintenance') {
      this.#push('maintenance', 'warn', n.detail ?? 'the server announced maintenance');
    }
  }

  /**
   * `LiveState` changes, and the gap UI.
   *
   * `LiveClient.state` reports `'resyncing'` while any subject is waiting for the snapshot that
   * re-bases its chain (and while a reconnect is in flight, which is the same statement about every
   * subject at once). Both cases mean the same thing to a reader — what is on screen is the last
   * thing we know to be true, and it is being refetched — so both grey the cells.
   *
   * Which subjects gapped is not on the client's surface, so every live cell greys rather than the
   * gapped ones only. That is what CLIENT.md §9 specifies ("'resyncing' greys every live cell's
   * state to 'stale' until its fresh snap arrives"), and it is also the safer error: greying a cell
   * that was fine costs a second of grey, while leaving one live that was not costs a wrong trade.
   */
  #onState(state: LiveState): void {
    const resyncing = state === 'resyncing';
    if (resyncing && !this.#resyncing) {
      this.#resyncing = true;
      const gaps = Math.max(1, this.#client.stats.resyncs - this.#resyncs);
      this.#resyncs = this.#client.stats.resyncs;
      this.#greyEverything();
      this.#push(
        'resync',
        'warn',
        gaps === 1
          ? 'lost an update — refetching the affected prices'
          : `lost updates on ${String(gaps)} subjects — refetching those prices`,
      );
    } else if (!resyncing && this.#resyncing) {
      this.#resyncing = false;
      this.#resyncs = this.#client.stats.resyncs;
      if (state === 'open') this.#push('resynced', 'info', 'prices resynchronised');
    }
    this.#emitStatus();
  }

  /** Every subject on the socket → `stale`, until its own fresh `snap` overwrites the state. */
  #greyEverything(): void {
    const registry = this.#registry;
    if (registry === null) return;
    for (const subject of this.#client.quoteCache.subjects()) {
      registry.setSubjectStatus(subject, 'stale');
    }
  }

  #onError(e: LiveErrorEvent): void {
    this.#push('error', e.fatal ? 'error' : 'warn', e.message);
  }

  #onClose(e: LiveCloseEvent): void {
    this.#push(
      'disconnect',
      'error',
      `live connection closed (${String(e.code)}${e.reason === '' ? '' : ` ${e.reason}`})`,
    );
    this.#emitStatus();
  }

  // ── Staleness (TERM-12) ───────────────────────────────────────────────────────────────────────

  /**
   * One sweep: `QuoteCache.sweep()` recomputes `valueState()` — `core/quote/staleness.ts`, the
   * function the server's own sweep calls — and returns only the subjects whose state CHANGED. A
   * thousand rows therefore cost one comparison each and zero DOM writes on a quiet second.
   *
   * Exposed so a test can drive the second rather than wait for it; production uses the cache's
   * ticker, started in {@link WsBridge.start}.
   */
  sweep(now: number = this.#now()): string[] {
    const subjects = this.#client.quoteCache.sweep(now);
    this.#onSweep(subjects, now);
    return subjects;
  }

  #onSweep(subjects: string[], now: number = this.#now()): void {
    // Unconditional, and before the early return: a second in which no subject changed state is
    // precisely the second in which the feed has gone quiet, which is when a flash left lit by an
    // `animationend` that never fired needs taking off. Gating it on `subjects.length` would make
    // the backstop depend on the thing it backs up.
    this.#registry?.sweepFlashes(now);
    if (subjects.length === 0) return;
    this.#registry?.restyle(subjects);
  }

  // ── Viewport (BUS-04) and shed recovery ───────────────────────────────────────────────────────

  /**
   * What the viewport can see right now — the virtualiser's window plus its overscan, plus the
   * subjects of any always-essential block (CLIENT.md §9).
   *
   * Only the DIFFERENCE is sent: a scroll that moves one row sends one subject on and one off, not
   * two `essential` frames listing a thousand subjects each.
   *
   * A shed subject that re-enters the viewport is RE-SUBSCRIBED, which is the whole point of
   * keeping the shed set. The server dropped its hold when it shed it (§6.5), so nothing would ever
   * arrive again on its own; a row that scrolled away for a second would be blank for the rest of
   * the session. `setEssential(false)` then `setEssential(true)` in the same turn is how that is
   * expressed through the SDK's surface: the pair guarantees the subject is marked dirty even when
   * the viewport already considered it essential, and the registry's reconciliation then emits a
   * fresh `sub` (its wire state was cleared by the shed) rather than an `essential` frame. Both
   * calls land in one batch, so one frame goes out.
   */
  setVisible(subjects: Iterable<string>): void {
    const next = new Set(subjects);
    const on: string[] = [];
    const off: string[] = [];
    for (const subject of next) if (!this.#visible.has(subject)) on.push(subject);
    for (const subject of this.#visible) if (!next.has(subject)) off.push(subject);
    this.#visible = next;

    const reshed = on.filter((s) => this.#shed.has(s) || this.#client.subscriptions.isShed(s));
    if (reshed.length > 0) this.#client.setEssential(reshed, false);
    if (on.length > 0) this.#client.setEssential(on, true);
    if (off.length > 0) this.#client.setEssential(off, false);
  }

  /** The subjects the viewport last reported. */
  get visible(): readonly string[] {
    return [...this.#visible];
  }

  /** Subjects the plant is shedding right now. */
  get shed(): readonly string[] {
    return [...this.#shed];
  }

  // ── Notices ───────────────────────────────────────────────────────────────────────────────────

  #push(
    kind: BridgeNoticeKind,
    tone: BridgeTone,
    text: string,
    extra: { subject?: string } = {},
  ): void {
    this.#noticeId += 1;
    const notice: BridgeNotice = {
      id: this.#noticeId,
      kind,
      tone,
      text,
      at: this.#now(),
      ...extra,
    };
    this.#notices.push(notice);
    if (this.#notices.length > NOTICE_HISTORY) this.#notices = this.#notices.slice(-NOTICE_HISTORY);
    for (const handler of [...this.#noticeHandlers]) handler(notice);
    this.#emitStatus();
  }

  #emitStatus(): void {
    if (this.#statusHandlers.size === 0) return;
    const status = this.status;
    for (const handler of [...this.#statusHandlers]) handler(status);
  }
}

const reasonSuffix = (reason: string | undefined): string =>
  reason === undefined || reason === '' ? '' : ` (${reason})`;

/* -------------------------------------------------------------------------------------------- */
/* The one instance (TERM-04)                                                                     */
/* -------------------------------------------------------------------------------------------- */

let current: WsBridge | null = null;

/**
 * Build THE bridge. Throws when one already exists, because a second `LiveClient` on the same
 * session does not add a stream — it takes the first one's socket away (API.md §6.3 step 1).
 */
export function createWsBridge(options: WsBridgeOptions): WsBridge {
  if (current !== null) {
    throw new Error(
      'createWsBridge: a live bridge already exists — four panels share one socket (TERM-04); ' +
        'call getWsBridge(), or disposeWsBridge() first',
    );
  }
  current = new WsBridge(options);
  return current;
}

/** The bridge, or `null` before the shell has built one. */
export function getWsBridge(): WsBridge | null {
  return current;
}

/** Close and forget the bridge — `App` unmount, and every test's teardown. */
export function disposeWsBridge(code?: number): void {
  if (current === null) return;
  current.stop(code);
  current = null;
}
