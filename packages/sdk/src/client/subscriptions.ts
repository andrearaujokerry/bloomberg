/**
 * `client/subscriptions.ts` — ref-counted subscription bookkeeping for `LiveClient` (WP-13).
 *
 * Three jobs, each of which exists because of a specific way a terminal goes wrong without it:
 *
 *  1. **Ref counting per `(subject, field)`.** Four panels on `AAPL US Equity` are one `sub` on the
 *     wire and one hold on the server (TERM-04, CLIENT.md L229). Without it the second panel's
 *     `unsub` would blank the first panel's cells, and `maxSubscriptions` would be spent four times
 *     over on one instrument.
 *  2. **Batching per animation frame.** A frame change mounts a screen full of widgets, each
 *     acquiring its own subscription in the same tick; a subject subscribed and released within one
 *     tick never reaches the wire at all. The batch is a reconciliation, not a queue of intentions:
 *     at flush time the registry compares what is held against what the server holds and sends the
 *     difference — at most one `sub` (per requested tier), one `unsub` and one `essential` frame per
 *     boolean.
 *  3. **The `essential` flag.** The viewport drives it (BUS-04): off-viewport rows are what the
 *     server's slow-consumer ladder is allowed to shed (API.md §6.5), so a client that marks
 *     everything essential leaves the server nothing to shed but the socket. A shed subject loses
 *     its server-side hold (`ws/conflator.ts#shedNonEssential` removes it), so
 *     {@link SubscriptionRegistry.markShed} drops it from the wire set and the re-`sub` goes out when
 *     the row scrolls back into view and {@link SubscriptionRegistry.setEssential} makes it
 *     essential again (API.md §10.2).
 *
 * The registry never touches a socket: it is given a `send` and hands it `ClientMsgInput` frames
 * that `wire/ws.ts` validates. `ws.ts` stays a transport.
 */
import { Tier as TierSchema } from '../wire/envelope.js';
import type { FieldId, ReasonCode, Tier } from '../wire/envelope.js';
import type { ClientMsgInput } from '../wire/ws.js';
import type { QuoteView } from './quoteCache.js';

/** API.md §10.2 L1305. */
export interface SubscribeOptions {
  tier?: Tier | undefined;
  essential?: boolean | undefined;
  conflationMs?: number | undefined;
}

/** API.md §10.2 L1306 — what `web/grid/cellRegistry` flashes (ARCHITECTURE §6.6). */
export interface UpdateEvent {
  subject: string;
  seq: number;
  changed: FieldId[];
  state: QuoteView;
  kind: 'snap' | 'delta';
}

/** The `subAck` frame projected onto one subscription (API.md §10.2 L1335). */
export interface SubscriptionAck {
  accepted: { s: string; tier: Tier; reason: ReasonCode }[];
  rejected: { s: string; code: string; reason: string }[];
}

/** API.md §10.2 L1333-1338. */
export interface Subscription {
  readonly id: number;
  readonly subjects: readonly string[];
  readonly fields: readonly FieldId[] | '*';
  readonly ack: Promise<SubscriptionAck>;
  /** Only the subjects and fields of this subscription. Returns an unsubscribe-the-handler fn. */
  on(event: 'update', h: (e: UpdateEvent) => void): () => void;
  /** Ref-count decrement; the `unsub` frame is sent when the count reaches zero. */
  unsubscribe(): void;
}

/** What `resumePlan()` reports: one entry per held subject (API.md §6.3 step 6). */
export interface ResumeEntry {
  subject: string;
  fields: readonly FieldId[] | '*';
  essential: boolean;
  tier: Tier;
  /** `lastSeq[s]` when the cache holds one — the `known` member of the re-`sub` (§6.3 step 6). */
  known?: number;
}

/** Schedules one callback for the next animation frame. */
export type FrameScheduler = (callback: () => void) => void;

/** The fallback period when the host has no `requestAnimationFrame` (a Node consumer of the SDK). */
export const FRAME_MS = 16;

/**
 * The platform's animation frame, or a 16 ms timer where there is none. `requestAnimationFrame` is
 * read off `globalThis` rather than called directly because the SDK also runs in Node, where the
 * global does not exist.
 */
export const platformFrameScheduler: FrameScheduler = (callback) => {
  const host = globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number };
  if (typeof host.requestAnimationFrame === 'function') {
    host.requestAnimationFrame(() => {
      callback();
    });
    return;
  }
  globalThis.setTimeout(callback, FRAME_MS);
};

export interface SubscriptionRegistryOptions {
  /** Where a batched frame goes. `LiveClient`'s own send, which encodes through `wire/ws.ts`. */
  send: (msg: ClientMsgInput) => void;
  /** Default {@link platformFrameScheduler}; a test injects a manual pump. */
  scheduleFrame?: FrameScheduler | undefined;
  /** `quoteCache.get(s)?.seq` — the `known` of a re-`sub` (§6.3 step 6). */
  knownSeq?: ((subject: string) => number | undefined) | undefined;
  /** The tier a subscription that names none requests. Default `'delayed'` (§6.6: the v1 cap). */
  defaultTier?: Tier | undefined;
  /** Called at flush with the subjects an `unsub` just went out for, so the cache can drop them. */
  onUnsubscribed?: ((subjects: string[]) => void) | undefined;
}

/** `Tier`'s declaration order IS its ranking (`wire/common.ts`: "ordered eod < delayed < realtime"). */
const TIER_ORDER: readonly Tier[] = TierSchema.options;

function higherTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

/** A field set as one comparable string: `'*'`, or the sorted ids. */
function fieldsKey(fields: readonly FieldId[] | '*'): string {
  return fields === '*' ? '*' : fields.join(',');
}

/** True when what the server holds already covers what is now wanted. */
function covers(wire: readonly FieldId[] | '*', wanted: readonly FieldId[] | '*'): boolean {
  if (wire === '*') return true;
  if (wanted === '*') return false;
  const held = new Set(wire);
  return wanted.every((id) => held.has(id));
}

/** One subject's ref counts and wire state. */
interface SubjectEntry {
  /** Per-field ref count; a field drops out at zero. */
  readonly fieldRefs: Map<FieldId, number>;
  /** How many holders asked for `'*'` (the whole family's field set). */
  starRefs: number;
  /** How many holders want this subject essential (BUS-04). */
  essentialRefs: number;
  readonly holders: Set<RegisteredSubscription>;
  /** The viewport's verdict, which outranks the holders' (API.md §10.2 `setEssential`). */
  viewportEssential: boolean | null;
  /** What the server currently holds for this subject, or `null` when it holds nothing. */
  wireFields: readonly FieldId[] | '*' | null;
  wireEssential: boolean;
  /** The highest tier any holder requested. */
  tier: Tier;
  /** The server shed this subject (§6.5): the hold is gone until the row is essential again. */
  shed: boolean;
}

class RegisteredSubscription implements Subscription {
  readonly id: number;
  readonly subjects: readonly string[];
  readonly fields: readonly FieldId[] | '*';
  readonly ack: Promise<SubscriptionAck>;
  readonly fieldSet: ReadonlySet<FieldId>;
  readonly conflationMs: number | undefined;
  /** Whether this holder wants its subjects essential (BUS-04); the wire's own default is true. */
  readonly essential: boolean;

  #settled = false;
  #resolve!: (ack: SubscriptionAck) => void;
  #live = true;
  readonly #handlers = new Set<(e: UpdateEvent) => void>();
  readonly #release: (sub: RegisteredSubscription) => void;

  constructor(
    id: number,
    subjects: readonly string[],
    fields: readonly FieldId[] | '*',
    conflationMs: number | undefined,
    essential: boolean,
    release: (sub: RegisteredSubscription) => void,
  ) {
    this.id = id;
    this.subjects = subjects;
    this.fields = fields;
    this.fieldSet = new Set(fields === '*' ? [] : fields);
    this.conflationMs = conflationMs;
    this.essential = essential;
    this.#release = release;
    this.ack = new Promise<SubscriptionAck>((resolve) => {
      this.#resolve = resolve;
    });
  }

  get live(): boolean {
    return this.#live;
  }

  get settled(): boolean {
    return this.#settled;
  }

  wants(field: FieldId): boolean {
    return this.fields === '*' || this.fieldSet.has(field);
  }

  settle(ack: SubscriptionAck): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve(ack);
  }

  on(event: 'update', h: (e: UpdateEvent) => void): () => void {
    if (event !== 'update') throw new TypeError("Subscription.on: the only event is 'update'");
    this.#handlers.add(h);
    return () => {
      this.#handlers.delete(h);
    };
  }

  emit(e: UpdateEvent): unknown {
    let failure: unknown = null;
    for (const handler of this.#handlers) {
      try {
        handler(e);
      } catch (error: unknown) {
        // One panel's throwing handler must not stop the tick reaching the other three; the first
        // failure is re-thrown by the caller once every handler has run.
        failure ??= error;
      }
    }
    return failure;
  }

  unsubscribe(): void {
    if (!this.#live) return;
    this.#live = false;
    this.#handlers.clear();
    this.#release(this);
  }
}

/**
 * The ref-count table behind `LiveClient.subscribe()`. Not part of the public API.md surface; it is
 * declared here so WP-13 has a single owner for the bookkeeping and `ws.ts` stays a transport.
 */
export class SubscriptionRegistry {
  readonly #send: (msg: ClientMsgInput) => void;
  readonly #scheduleFrame: FrameScheduler;
  readonly #knownSeq: ((subject: string) => number | undefined) | undefined;
  readonly #defaultTier: Tier;
  readonly #onUnsubscribed: ((subjects: string[]) => void) | undefined;

  readonly #subjects = new Map<string, SubjectEntry>();
  readonly #pending = new Set<RegisteredSubscription>();
  /** Subjects whose desired state may differ from the wire state; cleared by `flush()`. */
  readonly #dirty = new Set<string>();
  /** The last `subAck` verdict per subject, so a later subscriber's `ack` resolves without a frame. */
  readonly #accepted = new Map<string, { s: string; tier: Tier; reason: ReasonCode }>();
  readonly #rejected = new Map<string, { s: string; code: string; reason: string }>();

  #nextSubscriptionId = 1;
  #nextWireId = 1;
  #scheduled = false;
  /** Wire frames sent, for the batching assertions of `test/client/subscriptions.test.ts`. */
  #frameCount = 0;

  constructor(options: SubscriptionRegistryOptions) {
    this.#send = options.send;
    this.#scheduleFrame = options.scheduleFrame ?? platformFrameScheduler;
    this.#knownSeq = options.knownSeq;
    this.#defaultTier = options.defaultTier ?? 'delayed';
    this.#onUnsubscribed = options.onUnsubscribed;
  }

  /** Register a new subscription and return it; batches the `sub` frame for the next frame tick. */
  add(
    subjects: readonly string[],
    fields: readonly FieldId[] | '*',
    opts?: SubscribeOptions,
  ): Subscription {
    const unique = [...new Set(subjects)];
    const wanted: readonly FieldId[] | '*' = fields === '*' ? '*' : [...new Set(fields)];
    // The wire's own default (`wire/ws.ts`: `essential: z.boolean().default(true)`).
    const essential = opts?.essential ?? true;
    const tier = opts?.tier ?? this.#defaultTier;
    const sub = new RegisteredSubscription(
      this.#nextSubscriptionId++,
      unique,
      wanted,
      opts?.conflationMs,
      essential,
      (released) => {
        this.#remove(released);
      },
    );

    for (const subject of unique) {
      const entry = this.#entry(subject, tier);
      entry.holders.add(sub);
      if (wanted === '*') entry.starRefs += 1;
      else for (const id of wanted) entry.fieldRefs.set(id, (entry.fieldRefs.get(id) ?? 0) + 1);
      if (essential) entry.essentialRefs += 1;
      entry.tier = higherTier(entry.tier, tier);
      this.#markDirty(subject);
    }
    this.#pending.add(sub);
    this.#schedule();
    return sub;
  }

  #entry(subject: string, tier: Tier): SubjectEntry {
    const found = this.#subjects.get(subject);
    if (found !== undefined) return found;
    const created: SubjectEntry = {
      fieldRefs: new Map<FieldId, number>(),
      starRefs: 0,
      essentialRefs: 0,
      holders: new Set<RegisteredSubscription>(),
      viewportEssential: null,
      wireFields: null,
      wireEssential: true,
      tier,
      shed: false,
    };
    this.#subjects.set(subject, created);
    return created;
  }

  /** Ref-count decrement for every `(subject, field)` one subscription held. */
  #remove(sub: RegisteredSubscription): void {
    for (const subject of sub.subjects) {
      const entry = this.#subjects.get(subject);
      if (entry?.holders.delete(sub) !== true) continue;
      if (sub.fields === '*') entry.starRefs = Math.max(0, entry.starRefs - 1);
      else {
        for (const id of sub.fields) {
          const count = (entry.fieldRefs.get(id) ?? 0) - 1;
          if (count > 0) entry.fieldRefs.set(id, count);
          else entry.fieldRefs.delete(id);
        }
      }
      if (sub.essential) entry.essentialRefs = Math.max(0, entry.essentialRefs - 1);
      this.#markDirty(subject);
    }
    // An `ack` nobody will ever answer would leave an awaiting caller hanging for the session's
    // lifetime, so a subscription released before its `subAck` resolves empty.
    this.#pending.delete(sub);
    sub.settle({ accepted: [], rejected: [] });
    this.#schedule();
  }

  #markDirty(subject: string): void {
    this.#dirty.add(subject);
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#scheduleFrame(() => {
      this.#scheduled = false;
      this.flush();
    });
  }

  /** The field set the holders of `subject` want, together. */
  #desiredFields(entry: SubjectEntry): readonly FieldId[] | '*' {
    if (entry.starRefs > 0) return '*';
    return [...entry.fieldRefs.keys()].sort();
  }

  /** The viewport's verdict if it gave one, else "any holder wants it essential". */
  #desiredEssential(entry: SubjectEntry): boolean {
    return entry.viewportEssential ?? entry.essentialRefs > 0;
  }

  /**
   * Reconcile the wire state with the held state and send the difference. Called by the frame
   * scheduler; a caller may call it directly to flush the batch now (a reconnect does).
   *
   * At most one `sub` frame per requested tier (the frame carries one `tier` for all its subjects),
   * one `unsub` frame, and one `essential` frame per boolean — so a screen that mounts twelve
   * widgets over one instrument costs one frame, which is the whole point of the batch.
   */
  flush(): void {
    if (this.#dirty.size === 0) {
      this.#resolvePending();
      return;
    }
    const dirty = [...this.#dirty];
    this.#dirty.clear();

    const subsByTier = new Map<
      Tier,
      { s: string; f: FieldId[]; essential: boolean; known?: number }[]
    >();
    const unsub: string[] = [];
    const essentialOn: string[] = [];
    const essentialOff: string[] = [];

    for (const subject of dirty) {
      const entry = this.#subjects.get(subject);
      if (entry === undefined) continue;
      const held = entry.starRefs > 0 || entry.fieldRefs.size > 0;

      if (!held) {
        // A subject acquired and released inside one frame never reaches the wire at all.
        if (entry.wireFields !== null) unsub.push(subject);
        this.#subjects.delete(subject);
        continue;
      }

      const desired = this.#desiredFields(entry);
      const essential = this.#desiredEssential(entry);
      // A narrowing is deliberately NOT re-sent: a `sub` replaces the server's field set
      // (`ws/session.ts#onSub` builds a fresh `fieldMask`) and answers with a fresh `snap`, so
      // narrowing would re-snapshot a subject nothing asked to re-snapshot. The widened set costs
      // bandwidth until the next real change; it can never produce a wrong number.
      if (entry.wireFields === null || !covers(entry.wireFields, desired)) {
        const known = this.#knownSeq?.(subject);
        const item: { s: string; f: FieldId[]; essential: boolean; known?: number } = {
          s: subject,
          // `f: []` is the wire's "every field of this family" (`ws/session.ts` accepts an empty
          // field list for the families that allow it); `'*'` is the SDK's name for the same thing.
          f: desired === '*' ? [] : [...desired],
          essential,
          ...(known === undefined ? {} : { known }),
        };
        const group = subsByTier.get(entry.tier) ?? [];
        group.push(item);
        subsByTier.set(entry.tier, group);
        entry.wireFields = desired;
        entry.wireEssential = essential;
        entry.shed = false;
        continue;
      }
      if (essential !== entry.wireEssential) {
        entry.wireEssential = essential;
        (essential ? essentialOn : essentialOff).push(subject);
      }
    }

    for (const [tier, items] of subsByTier) {
      this.#sendFrame({ t: 'sub', id: this.#nextWireId++, subjects: items, tier });
    }
    if (unsub.length > 0) {
      this.#sendFrame({ t: 'unsub', subjects: unsub });
      this.#onUnsubscribed?.(unsub);
    }
    if (essentialOn.length > 0) {
      this.#sendFrame({ t: 'essential', subjects: essentialOn, essential: true });
    }
    if (essentialOff.length > 0) {
      this.#sendFrame({ t: 'essential', subjects: essentialOff, essential: false });
    }
    this.#resolvePending();
  }

  #sendFrame(msg: ClientMsgInput): void {
    this.#frameCount += 1;
    this.#send(msg);
  }

  /** Resolve the pending `ack` promises for one `subAck` frame. */
  settle(ack: SubscriptionAck): void {
    for (const row of ack.accepted) {
      this.#accepted.set(row.s, row);
      this.#rejected.delete(row.s);
    }
    for (const row of ack.rejected) {
      this.#rejected.set(row.s, row);
      this.#accepted.delete(row.s);
    }
    this.#resolvePending();
  }

  /**
   * Resolve every pending subscription whose subjects the server has now answered for.
   *
   * A subscription whose subjects were already on the wire gets no frame of its own, so its `ack`
   * resolves from the remembered verdicts rather than waiting for a `subAck` that will never come.
   */
  #resolvePending(): void {
    for (const sub of [...this.#pending]) {
      const accepted: { s: string; tier: Tier; reason: ReasonCode }[] = [];
      const rejected: { s: string; code: string; reason: string }[] = [];
      let complete = true;
      for (const subject of sub.subjects) {
        const yes = this.#accepted.get(subject);
        const no = this.#rejected.get(subject);
        if (yes !== undefined) accepted.push(yes);
        else if (no !== undefined) rejected.push(no);
        else complete = false;
      }
      if (!complete) continue;
      this.#pending.delete(sub);
      sub.settle({ accepted, rejected });
    }
  }

  /** Fan one `UpdateEvent` out to the subscriptions that asked for that subject/field. */
  dispatch(event: UpdateEvent): void {
    const entry = this.#subjects.get(event.subject);
    if (entry === undefined) return;
    let failure: unknown = null;
    for (const sub of entry.holders) {
      if (!sub.live) continue;
      const changed = event.changed.filter((id) => sub.wants(id));
      if (changed.length === 0) continue;
      const scoped: UpdateEvent =
        changed.length === event.changed.length ? event : { ...event, changed };
      failure ??= sub.emit(scoped);
    }
    if (failure !== null) {
      throw failure instanceof Error
        ? failure
        : new Error('an update handler threw a non-Error value', { cause: failure });
    }
  }

  /**
   * Viewport → the `essential` frame (API.md §10.2). A subject the server shed has no hold left, so
   * making it essential again re-`sub`s it with `known: lastSeq` rather than merely re-flagging it —
   * which is what the grid's virtualiser relies on when a shed row scrolls back into view (§6.5).
   */
  setEssential(subjects: readonly string[], essential: boolean): void {
    for (const subject of subjects) {
      const entry = this.#subjects.get(subject);
      if (entry === undefined) continue;
      if (entry.viewportEssential === essential) continue;
      entry.viewportEssential = essential;
      this.#markDirty(subject);
    }
    this.#schedule();
  }

  /**
   * The server shed this subject (`status { st:'shed' }`, §6.5). The hold is gone — the conflator
   * removed it — so the wire state says so; a subject the viewport does not want is not re-sent
   * until it becomes essential again (re-subscribing it here would fight the backpressure that shed
   * it: the server sheds only `essential:false` subjects, and a client that answered every shed with
   * a fresh `sub` would loop against a socket already over `HARD_BYTES`).
   *
   * **But a subject this client already wants essential is re-subscribed at once**, because the two
   * decisions race: `setEssential` marks the entry essential synchronously and batches its frame to
   * the next animation frame, so a shed decision the server took before that frame landed arrives
   * for a subject the client believes is on screen. `setEssential` cannot rescue it — it returns
   * early when the flag already holds the requested value, and scrolling the row back produces no
   * `false`→`true` transition — so without this the row would keep a frozen value marked stale for
   * the rest of the session. Marking it dirty re-`sub`s it with `known: lastSeq` on the next flush,
   * which is the same path a scroll-back takes (§6.5: "client must re-`sub` when the row scrolls
   * into view").
   */
  markShed(subject: string): void {
    const entry = this.#subjects.get(subject);
    if (entry === undefined) return;
    entry.shed = true;
    entry.wireFields = null;
    this.#accepted.delete(subject);
    const held = entry.starRefs > 0 || entry.fieldRefs.size > 0;
    if (!held || !this.#desiredEssential(entry)) return;
    this.#markDirty(subject);
    this.#schedule();
  }

  /** True while the server holds nothing for this subject because it shed it. */
  isShed(subject: string): boolean {
    return this.#subjects.get(subject)?.shed ?? false;
  }

  /** `(subject, fields)` pairs to re-`sub` after a reconnect. */
  resumePlan(): ResumeEntry[] {
    const plan: ResumeEntry[] = [];
    for (const [subject, entry] of this.#subjects) {
      if (entry.starRefs === 0 && entry.fieldRefs.size === 0) continue;
      const known = this.#knownSeq?.(subject);
      plan.push({
        subject,
        fields: this.#desiredFields(entry),
        essential: this.#desiredEssential(entry),
        tier: entry.tier,
        ...(known === undefined ? {} : { known }),
      });
    }
    return plan;
  }

  /**
   * Re-subscribe everything after a reconnect (§6.3 step 6). The new socket holds nothing, so the
   * wire state is cleared and the frames go out at once rather than on the next animation frame:
   * the screen is already stale by the time a reconnect lands.
   */
  resume(): void {
    for (const [subject, entry] of this.#subjects) {
      entry.wireFields = null;
      entry.shed = false;
      this.#accepted.delete(subject);
      this.#rejected.delete(subject);
      this.#markDirty(subject);
    }
    this.flush();
  }

  /** Drop everything (client close). */
  clear(): void {
    for (const sub of this.#pending) sub.settle({ accepted: [], rejected: [] });
    this.#pending.clear();
    this.#subjects.clear();
    this.#dirty.clear();
    this.#accepted.clear();
    this.#rejected.clear();
  }

  // ── Inspection: what the tests and the status bar read ──────────────────────────────────────

  /** Every subject with at least one holder. */
  subjects(): string[] {
    return [...this.#subjects.keys()];
  }

  /** Holders of `subject`, or of `(subject, field)` when a field is named. */
  refCount(subject: string, field?: FieldId): number {
    const entry = this.#subjects.get(subject);
    if (entry === undefined) return 0;
    if (field === undefined) return entry.holders.size;
    return (entry.fieldRefs.get(field) ?? 0) + entry.starRefs;
  }

  /** The field set the server currently holds for `subject`, or `null` when it holds nothing. */
  wireFields(subject: string): readonly FieldId[] | '*' | null {
    return this.#subjects.get(subject)?.wireFields ?? null;
  }

  /** The `essential` flag currently in force for `subject`. */
  isEssential(subject: string): boolean {
    const entry = this.#subjects.get(subject);
    return entry === undefined ? false : this.#desiredEssential(entry);
  }

  /** The tier the registry requests for `subject`. */
  tierOf(subject: string): Tier | undefined {
    return this.#subjects.get(subject)?.tier;
  }

  /** The smallest `conflationMs` any live subscription asked for (`rt/conflation.ts` reads it). */
  requestedConflationMs(): number | undefined {
    let smallest: number | undefined;
    for (const entry of this.#subjects.values()) {
      for (const sub of entry.holders) {
        const ms = sub.conflationMs;
        if (ms !== undefined && (smallest === undefined || ms < smallest)) smallest = ms;
      }
    }
    return smallest;
  }

  /** True while a batch is waiting for its animation frame. */
  get batchPending(): boolean {
    return this.#scheduled;
  }

  /** How many wire frames the registry has sent. */
  get frameCount(): number {
    return this.#frameCount;
  }

  /** A field set as one comparable string — `'*'` or the sorted ids. */
  static fieldsKey(fields: readonly FieldId[] | '*'): string {
    return fieldsKey(fields);
  }
}

/**
 * WORKPLAN WP-13 names this class `SubscriptionManager`; `wire`-level call sites and
 * `sdk/src/index.ts` already export it as `SubscriptionRegistry`. One class, both names.
 */
export { SubscriptionRegistry as SubscriptionManager };
