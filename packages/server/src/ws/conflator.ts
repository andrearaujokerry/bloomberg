/**
 * `ws/conflator.ts` — per-session conflation, the latest-value guarantee and the slow-consumer
 * ladder (BUS-03, BUS-04, NFR-02; ARCHITECTURE §6.3 L835-878, API.md §6.4-§6.5 L948-998).
 *
 * One `Conflator` per WebSocket session. The plant fans out `mark(subject, changedMask)`; a timer
 * owned by `ws/session.ts` calls {@link Conflator.flush} every `effectiveMs`. Nothing is queued on
 * the way in: the dirty map holds **which fields changed**, never the values, and the values are
 * read from the plant at flush time. That is the latest-value guarantee — the flushed value of a
 * field is always the last value applied to it, whatever happened inside the window.
 *
 * Insertion order is the flush order. A subject appears at most once per flush (the two carve-outs
 * below excepted), `seq` may skip — that *is* conflation — but the per-subject `prev` chain never
 * does: `prev` is always the previous `seq` this session was sent for that subject, so a client
 * applying frames in receipt order sees a contiguous chain across batch frames and across flushes.
 *
 * **Two carve-outs a dirty mask cannot express** (API.md §6.4):
 *
 * - `n:*` (news) subjects are **queued, not conflated**: {@link Conflator.markQueued} records one
 *   entry per headline and the flush emits one `delta` per entry, in `publishedAt` (call) order.
 *   A latest-value mask would silently drop every headline in a window but the last (NEWS-01).
 * - `eod`-tier subjects flush at most every `eodFloorMs` (60 000 ms), a floor independent of
 *   `effectiveMs`; their deltas are restricted to the six `eod` fields (`plant/eod.ts`).
 *
 * **Frame cap.** A flush whose encoded size would exceed `frameCapBytes` (1 MiB) is split across
 * consecutive `batch` frames *within that one flush*, emitted back-to-back before any later flush,
 * in dirty-map insertion order. The initial snapshot burst is such a flush. Splitting cannot break
 * the chain, because `seq`/`prev` continuity is a property of the subject, not of the frame.
 *
 * **Backpressure.** Every rung of the API.md §6.5 ladder is walked here against
 * `deps.bufferedAmount()`, and every rung is both a wire frame (through `deps.send`) and a
 * {@link ConflatorEvent} (through `deps.onEvent`) so `ws/session.ts` can write the `dq_events` and
 * `usage_events` rows. Nothing is dropped silently, and a skipped flush keeps the dirty set.
 *
 * Timers live in `ws/session.ts`. This class reads time only from the injected `Clock`.
 */

import { maskAnd, maskOr, maskToIds, emptyMask } from '@terminal/core';
import type { Clock, FieldId, ProvRef, QuoteState, ReasonCode, Tier } from '@terminal/core';
import type { Delta, Prov, ServerMsg, Snap, Status } from '@terminal/sdk/wire/ws';

import { isEodField } from '../plant/eod.js';
import type { EodView } from '../plant/eod.js';
import { view } from '../plant/policyTier.js';

import { encode, frameBytes, MAX_BATCH_FRAME_BYTES } from './protocol.js';

// ---------------------------------------------------------------------------
// Thresholds (API.md §6.5 L975-976, §6.7 L1015)
// ---------------------------------------------------------------------------

export interface BackpressureThresholds {
  /** `bufferedAmount` above which `effectiveMs` doubles. */
  softBytes: number;
  /** `bufferedAmount` above which the flush is skipped and the dirty set retained. */
  hardBytes: number;
  /** How long `> hardBytes` must persist before shedding, and again before closing. */
  graceMs: number;
  /** Ceiling `effectiveMs` may be widened to. */
  maxMs: number;
  /** Floor between two flushes of one `eod`-tier subject. */
  eodFloorMs: number;
  /** Encoded `batch` frame cap; a larger flush is split across consecutive frames. */
  frameCapBytes: number;
}

export const DEFAULT_THRESHOLDS: BackpressureThresholds = Object.freeze({
  softBytes: 262_144,
  hardBytes: 2_097_152,
  graceMs: 10_000,
  maxMs: 5_000,
  eodFloorMs: 60_000,
  frameCapBytes: MAX_BATCH_FRAME_BYTES,
});

/**
 * Fields that overload shedding may never take away (API.md §6.5, last row). The slow-consumer
 * ladder is *not* covered by this: API.md §6.8 sheds a `q:` subject carrying `PX_LAST` once the
 * client itself marked the row `essential:false`, so the protection is opt-in per shed call.
 */
export const PROTECTED_FIELD_IDS: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
] as FieldId[]);

const PROTECTED_SET: ReadonlySet<string> = new Set<string>(PROTECTED_FIELD_IDS);

/** Number of consecutive flushes below `softBytes / 4` that restore `effectiveMs` (API.md §6.5). */
export const RESTORE_STREAK = 3;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The slice of `plant/tickerPlant.ts#Plant` the conflator uses — structurally
 * `Pick<Plant, 'get' | 'eodView'>`. It is spelled out here so this module compiles and is testable
 * against a hand-built plant while the real one is being written (and so a test needs a Map, not a
 * plant).
 */
export interface PlantReader {
  /** The raw composite, read at flush time — the latest-value guarantee. */
  get(subject: string): QuoteState | undefined;
  /** The frozen official close an `eod`-tier view is projected onto, or `null`. */
  eodView(subject: string): EodView | null;
}

/** One live subscription on this session (ARCHITECTURE §6.3). */
export interface Subscription {
  subject: string;
  /** BUS-02 bitset over the dictionary index; empty for the all-fields families (`c: e: n: sys:`). */
  fieldMask: Uint32Array;
  /** The subscribed ids, in request order. Empty means "every field the subject carries". */
  fieldIds: FieldId[];
  /** `seq` of the last frame sent for this subject on this session — the next frame's `prev`. */
  lastSentSeq: number;
  tier: Tier;
  /** `false` once the row leaves the viewport; the first thing shed under backpressure. */
  essential: boolean;
  /** Entitlement denials (ENTL-05): the field is `null` with this reason and never a number. */
  denied: Map<FieldId, ReasonCode>;
  /** `subAck.accepted[].reason`, echoed in every `snap`. */
  reason: ReasonCode;
  /** Clock time of the last frame sent for this subject; drives the `eod` 60 s floor. */
  lastFlushMs: number;
}

export type ConflatorEvent =
  | {
      kind: 'conflation-widened';
      cause: 'slow-consumer' | 'overload';
      conflationMs: number;
      bufferedBytes: number;
    }
  | { kind: 'conflation-restored'; conflationMs: number; bufferedBytes: number }
  | { kind: 'flush-skipped'; bufferedBytes: number; dirtySubjects: number; overMs: number }
  | { kind: 'shed'; cause: 'slow-consumer' | 'overload'; subjects: string[]; bufferedBytes: number }
  | { kind: 'disconnect-soon'; bufferedBytes: number }
  | { kind: 'close'; code: 4008; reason: 'SLOW_CONSUMER'; bufferedBytes: number }
  | { kind: 'flushed'; frames: number; subjects: number; bytes: number; conflationMs: number }
  | { kind: 'frame-oversize'; subject: string; bytes: number };

export interface ConflatorDeps {
  plant: PlantReader;
  clock: Clock;
  /** `hello.conflationMs` — the value `effectiveMs` is never narrowed below. */
  requestedMs: number;
  /** Hand one frame to the socket. The session encodes; this class only measures. */
  send(frame: ServerMsg): void;
  /** `socket.bufferedAmount`, read once per flush. */
  bufferedAmount(): number;
  thresholds?: Partial<BackpressureThresholds>;
  onEvent?(ev: ConflatorEvent): void;
}

/** What one {@link Conflator.flush} did, for the session's timer and metrics. */
export interface FlushOutcome {
  /** `true` when at least one `batch` frame went out. */
  sent: boolean;
  /** Number of `batch` frames emitted (> 1 only when the 1 MiB cap split the flush). */
  frames: number;
  /** Subjects carried by those frames. */
  subjects: number;
  /** Encoded bytes of the emitted batches. */
  bytes: number;
  /** `true` when the flush was skipped for backpressure; the dirty set is retained. */
  skipped: boolean;
  /** Subjects still dirty afterwards (retained by a skip or by the `eod` floor). */
  dirty: number;
  effectiveMs: number;
  /** `true` once the §6.5 ladder is exhausted: the session must close `4008 SLOW_CONSUMER`. */
  closed: boolean;
}

interface QueuedItem {
  seq: number;
  /** The state as published, so a headline is never overwritten by the next one. */
  state: QuoteState | undefined;
}

// ---------------------------------------------------------------------------
// Conflator
// ---------------------------------------------------------------------------

export class Conflator {
  /** Live subscriptions, keyed by subject. */
  readonly subs = new Map<string, Subscription>();

  /** The client's requested interval; `effectiveMs` never goes below it (API.md §6.4). */
  requestedMs: number;

  /** The interval the session's timer uses right now. */
  effectiveMs: number;

  /** Global floor from plant overload (NFR-02); 0 when the plant is healthy. */
  floorMs = 0;

  readonly thresholds: BackpressureThresholds;

  readonly #deps: ConflatorDeps;
  readonly #plant: PlantReader;
  readonly #clock: Clock;

  /** subject → changed-field mask since the last flush, in insertion order. */
  readonly #dirty = new Map<string, Uint32Array>();
  /** subject → one entry per queued publication (`n:*`), in publication order. */
  readonly #queued = new Map<string, QueuedItem[]>();
  /** Subjects owed a `snap` on the next flush. */
  readonly #pendingSnaps = new Set<string>();

  #lowStreak = 0;
  #hardSinceMs: number | null = null;
  #shedAtMs: number | null = null;
  #closeRequested = false;
  #framesSent = 0;
  #bytesSent = 0;

  constructor(deps: ConflatorDeps) {
    this.#deps = deps;
    this.#plant = deps.plant;
    this.#clock = deps.clock;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...deps.thresholds };
    this.requestedMs = deps.requestedMs;
    this.effectiveMs = deps.requestedMs;
  }

  // -- subscriptions --------------------------------------------------------

  /** Register a subscription. By default it is owed a `snap` on the next flush (API.md §6.3). */
  add(sub: Subscription, opts?: { snapshot?: boolean }): void {
    this.subs.set(sub.subject, sub);
    if (opts?.snapshot !== false) this.markSnapshot(sub.subject);
  }

  /** Drop a subscription and everything pending for it (`unsub`, or a shed). */
  remove(subject: string): void {
    this.subs.delete(subject);
    this.#dirty.delete(subject);
    this.#queued.delete(subject);
    this.#pendingSnaps.delete(subject);
  }

  /** Owe `subject` a fresh `snap`; it travels in the next flush's batch stream. */
  markSnapshot(subject: string): void {
    if (!this.subs.has(subject)) return;
    this.#pendingSnaps.add(subject);
    this.#touch(subject);
  }

  // -- marking --------------------------------------------------------------

  /** OR `mask` into the subject's dirty mask. Cheap: no value is copied, nothing is allocated. */
  mark(subject: string, mask: Uint32Array): void {
    if (!this.subs.has(subject)) return;
    const current = this.#dirty.get(subject);
    if (current === undefined) this.#dirty.set(subject, maskOr(emptyMask(), mask));
    else maskOr(current, mask);
  }

  /**
   * Queue one publication of `subject` (the `n:*` carve-out, NEWS-01): it is emitted as its own
   * `delta`, in call order, and is never overwritten by a later one.
   *
   * @param state the state as published. Omitting it falls back to the plant's *current* state at
   * flush time, which keeps the frame count and the `prev` chain right but not the payload of an
   * overwritten headline — publishers of queued subjects pass the state.
   */
  markQueued(subject: string, seq: number, state?: QuoteState): void {
    if (!this.subs.has(subject)) return;
    const queue = this.#queued.get(subject);
    if (queue === undefined) this.#queued.set(subject, [{ seq, state }]);
    else queue.push({ seq, state });
    this.#touch(subject);
  }

  // -- intervals ------------------------------------------------------------

  /** `conflation { ms }` from the client. Never narrows below the overload floor. */
  setRequestedMs(ms: number): void {
    const widened = this.effectiveMs > Math.max(this.requestedMs, this.floorMs);
    this.requestedMs = ms;
    this.effectiveMs = widened
      ? Math.max(this.effectiveMs, ms, this.floorMs)
      : Math.max(ms, this.floorMs);
  }

  /** Plant overload (NFR-02): a global floor every session obeys until the plant recovers. */
  setFloor(ms: number): void {
    this.floorMs = ms;
    if (this.effectiveMs >= ms) return;
    this.effectiveMs = ms;
    this.#deps.send({
      t: 'notice',
      kind: 'overload',
      action: 'conflation-widened',
      conflationMs: this.effectiveMs,
    });
    this.#emit({
      kind: 'conflation-widened',
      cause: 'overload',
      conflationMs: this.effectiveMs,
      bufferedBytes: this.#deps.bufferedAmount(),
    });
  }

  // -- shedding -------------------------------------------------------------

  /**
   * Drop every `essential:false` subscription, one `status { st:'shed' }` per subject.
   *
   * @param opts.protectCoreFields overload shedding (API.md §6.5 last row) keeps any subscription
   * carrying `PX_LAST`, `CHG_NET_1D` or `CHG_PCT_1D`: those are never shed.
   */
  shedNonEssential(reason: string, opts?: { protectCoreFields?: boolean }): string[] {
    const now = this.#clock.now();
    const victims: string[] = [];
    for (const [subject, sub] of this.subs) {
      if (sub.essential) continue;
      if (opts?.protectCoreFields === true && sub.fieldIds.some((id) => PROTECTED_SET.has(id))) {
        continue;
      }
      victims.push(subject);
    }
    for (const subject of victims) {
      const frame: Status = { t: 'status', s: subject, st: 'shed', reason, ts: now };
      this.#deps.send(frame);
      this.remove(subject);
    }
    return victims;
  }

  // -- flush ----------------------------------------------------------------

  flush(): FlushOutcome {
    const now = this.#clock.now();
    const buffered = this.#deps.bufferedAmount();

    this.#rateLadder(buffered);

    if (buffered > this.thresholds.hardBytes) return this.#skipFlush(buffered, now);
    this.#hardSinceMs = null;
    this.#shedAtMs = null;

    const retained: [string, Uint32Array][] = [];
    const before = { frames: this.#framesSent, bytes: this.#bytesSent };
    const out = new BatchWriter(this.thresholds.frameCapBytes, (frame, bytes) => {
      this.#deps.send(frame);
      this.#framesSent += 1;
      this.#bytesSent += bytes;
    });
    let subjects = 0;

    for (const [subject, mask] of this.#dirty) {
      const sub = this.subs.get(subject);
      if (sub === undefined) {
        this.#queued.delete(subject);
        this.#pendingSnaps.delete(subject);
        continue;
      }

      let touched = false;

      if (this.#pendingSnaps.has(subject)) {
        const state = this.#plant.get(subject);
        if (state === undefined) {
          // Accepted but not yet in the plant: keep the debt, retain the mask, send nothing.
          retained.push([subject, mask]);
          continue;
        }
        this.#pendingSnaps.delete(subject);
        out.push(this.#snapFrame(sub, state), subject, this.#emitOversize);
        sub.lastSentSeq = state.seq;
        sub.lastFlushMs = now;
        touched = true;
      }

      const queue = this.#queued.get(subject);
      if (queue !== undefined && queue.length > 0) {
        this.#queued.delete(subject);
        for (const item of queue) {
          const state = item.state ?? this.#plant.get(subject);
          if (state === undefined || item.seq <= sub.lastSentSeq) continue;
          const frame = this.#deltaFrame(sub, state, item.seq, this.#allIds(sub, state));
          if (frame === null) continue;
          out.push(frame, subject, this.#emitOversize);
          sub.lastSentSeq = item.seq;
          sub.lastFlushMs = now;
          touched = true;
        }
        if (touched) subjects += 1;
        continue;
      }

      if (touched) {
        // The `snap` was read at flush time, so it already carries every marked field.
        subjects += 1;
        continue;
      }

      if (sub.tier === 'eod' && now - sub.lastFlushMs < this.thresholds.eodFloorMs) {
        retained.push([subject, mask]); // the 60 s floor, independent of effectiveMs
        continue;
      }

      const state = this.#plant.get(subject);
      if (state === undefined) continue; // marked for a subject the plant no longer holds
      const ids = this.#changedIds(sub, state, mask);
      if (ids.length === 0) continue;
      const frame = this.#deltaFrame(sub, state, state.seq, ids);
      if (frame === null) continue;
      out.push(frame, subject, this.#emitOversize);
      sub.lastSentSeq = state.seq;
      sub.lastFlushMs = now;
      subjects += 1;
    }

    out.end();
    const frames = this.#framesSent - before.frames;
    const bytes = this.#bytesSent - before.bytes;

    this.#dirty.clear();
    for (const [subject, mask] of retained) this.#dirty.set(subject, mask);

    if (frames > 0) {
      this.#emit({ kind: 'flushed', frames, subjects, bytes, conflationMs: this.effectiveMs });
    }

    return {
      sent: frames > 0,
      frames,
      subjects,
      bytes,
      skipped: false,
      dirty: this.#dirty.size,
      effectiveMs: this.effectiveMs,
      closed: this.#closeRequested,
    };
  }

  // -- introspection --------------------------------------------------------

  /** Subjects waiting for the next flush. */
  dirtySize(): number {
    return this.#dirty.size;
  }

  /** Queued (`n:*`) publications waiting for the next flush. */
  queuedSize(): number {
    let n = 0;
    for (const queue of this.#queued.values()) n += queue.length;
    return n;
  }

  stats(): {
    subscriptions: number;
    dirty: number;
    queued: number;
    framesSent: number;
    bytesSent: number;
    effectiveMs: number;
    requestedMs: number;
    floorMs: number;
  } {
    return {
      subscriptions: this.subs.size,
      dirty: this.#dirty.size,
      queued: this.queuedSize(),
      framesSent: this.#framesSent,
      bytesSent: this.#bytesSent,
      effectiveMs: this.effectiveMs,
      requestedMs: this.requestedMs,
      floorMs: this.floorMs,
    };
  }

  // -- internals ------------------------------------------------------------

  /** Make sure `subject` has a place in the dirty map's insertion order. */
  #touch(subject: string): void {
    if (!this.#dirty.has(subject)) this.#dirty.set(subject, emptyMask());
  }

  /** Rungs 1 and 2 of the ladder: widen above `softBytes`, restore below `softBytes / 4`. */
  #rateLadder(buffered: number): void {
    if (buffered > this.thresholds.softBytes) {
      this.#lowStreak = 0;
      const widened = Math.min(this.effectiveMs * 2, this.thresholds.maxMs);
      if (widened <= this.effectiveMs) return; // already at MAX_MS: no new information to send
      this.effectiveMs = widened;
      this.#deps.send({
        t: 'notice',
        kind: 'slow-consumer',
        action: 'conflation-widened',
        conflationMs: this.effectiveMs,
      });
      this.#emit({
        kind: 'conflation-widened',
        cause: 'slow-consumer',
        conflationMs: this.effectiveMs,
        bufferedBytes: buffered,
      });
      return;
    }

    if (buffered >= this.thresholds.softBytes / 4) {
      this.#lowStreak = 0;
      return;
    }

    this.#lowStreak += 1;
    if (this.#lowStreak < RESTORE_STREAK) return;
    this.#lowStreak = 0;
    const floor = Math.max(this.requestedMs, this.floorMs);
    const restored = Math.max(Math.floor(this.effectiveMs / 2), floor);
    if (restored >= this.effectiveMs) return;
    this.effectiveMs = restored;
    this.#deps.send({
      t: 'notice',
      kind: 'slow-consumer',
      action: 'conflation-restored',
      conflationMs: this.effectiveMs,
    });
    this.#emit({
      kind: 'conflation-restored',
      conflationMs: this.effectiveMs,
      bufferedBytes: buffered,
    });
  }

  /** Rungs 3-5: skip the flush, then shed, then ask for the close. The dirty set is kept. */
  #skipFlush(buffered: number, now: number): FlushOutcome {
    if (this.#hardSinceMs === null) this.#hardSinceMs = now;
    const overMs = now - this.#hardSinceMs;

    if (this.#shedAtMs === null) {
      if (overMs >= this.thresholds.graceMs) {
        const victims = this.shedNonEssential('SLOW_CONSUMER');
        this.#deps.send({ t: 'notice', kind: 'slow-consumer', action: 'shed' });
        this.#emit({
          kind: 'shed',
          cause: 'slow-consumer',
          subjects: victims,
          bufferedBytes: buffered,
        });
        this.#shedAtMs = now;
      }
    } else if (!this.#closeRequested && now - this.#shedAtMs >= this.thresholds.graceMs) {
      this.#deps.send({ t: 'notice', kind: 'slow-consumer', action: 'disconnect-soon' });
      this.#emit({ kind: 'disconnect-soon', bufferedBytes: buffered });
      this.#emit({ kind: 'close', code: 4008, reason: 'SLOW_CONSUMER', bufferedBytes: buffered });
      this.#closeRequested = true;
    }

    this.#emit({
      kind: 'flush-skipped',
      bufferedBytes: buffered,
      dirtySubjects: this.#dirty.size,
      overMs,
    });

    return {
      sent: false,
      frames: 0,
      subjects: 0,
      bytes: 0,
      skipped: true,
      dirty: this.#dirty.size,
      effectiveMs: this.effectiveMs,
      closed: this.#closeRequested,
    };
  }

  /** Every field the subject carries — the all-fields families (`c: e: n: sys: alerts: room:`). */
  #allIds(sub: Subscription, state: QuoteState): FieldId[] {
    const ids = sub.fieldIds.length > 0 ? sub.fieldIds : Object.keys(state.fields);
    return ids.filter((id) => !sub.denied.has(id));
  }

  /**
   * The ids this delta may carry: `changed & fieldMask`, minus denials (a delta never introduces an
   * entitlement denial — that is what the `snap`'s `r` map is for), restricted to the six `eod`
   * fields for an `eod`-tier subscriber.
   */
  #changedIds(sub: Subscription, state: QuoteState, mask: Uint32Array): FieldId[] {
    const ids =
      sub.fieldIds.length === 0
        ? Object.keys(state.fields)
        : maskToIds(maskAnd(mask, sub.fieldMask));
    const visible = ids.filter((id) => !sub.denied.has(id));
    return sub.tier === 'eod' ? visible.filter((id) => isEodField(id)) : visible;
  }

  #snapFrame(sub: Subscription, state: QuoteState): Snap {
    const ids = sub.fieldIds.length > 0 ? sub.fieldIds : Object.keys(state.fields);
    const v = view(state, sub.tier, {
      fieldIds: ids,
      eod: sub.tier === 'eod' ? this.#plant.eodView(sub.subject) : null,
      denied: sub.denied,
    });
    // `r` lists only the fields that are not served (ENTL-05); it stays off the frame entirely when
    // nothing is denied, rather than carrying a per-field 'OK' across every subject of a batch.
    const r = Object.keys(v.r).length > 0 ? { r: v.r } : {};
    return {
      t: 'snap',
      s: sub.subject,
      seq: v.seq,
      tier: v.tier,
      reason: sub.reason,
      f: v.fields,
      fts: v.fieldTs,
      ...r,
      ts: v.ts,
      st: v.state,
      session: v.session,
      prov: provOf(v.prov),
      ac: state.assetClass,
      id: state.instrumentId,
    };
  }

  /** `null` when `seq` would not advance the chain (nothing new to say for this subject). */
  #deltaFrame(sub: Subscription, state: QuoteState, seq: number, ids: FieldId[]): Delta | null {
    if (seq <= sub.lastSentSeq) return null;
    const v = view(state, sub.tier, {
      fieldIds: ids,
      eod: sub.tier === 'eod' ? this.#plant.eodView(sub.subject) : null,
      denied: sub.denied,
    });
    const fts = Object.keys(v.fieldTs).length > 0 ? { fts: v.fieldTs } : {};
    return {
      t: 'delta',
      s: sub.subject,
      seq,
      prev: sub.lastSentSeq,
      f: v.fields,
      ...fts,
      ts: v.ts,
      st: v.state,
      prov: provOf(v.prov),
    };
  }

  readonly #emitOversize = (subject: string, bytes: number): void => {
    this.#emit({ kind: 'frame-oversize', subject, bytes });
  };

  #emit(ev: ConflatorEvent): void {
    this.#deps.onEvent?.(ev);
  }
}

// ---------------------------------------------------------------------------
// Batch writer — the 1 MiB split (API.md §6.4)
// ---------------------------------------------------------------------------

/** `{"t":"batch","m":[]}` — the wrapper every split has to leave room for. */
const BATCH_ENVELOPE_BYTES = frameBytes('{"t":"batch","m":[]}');

/**
 * Accumulates `snap`/`delta`/`status` frames into `batch` frames, emitting one as soon as the next
 * frame would push the encoded size past the cap. Sizes are the encoded sizes: each member is run
 * through `protocol.encode` (which validates it against `ServerMsg`), so a frame that would fail on
 * the wire fails here, at the source, and the measurement is the truth rather than an estimate.
 */
class BatchWriter {
  readonly #cap: number;
  readonly #emit: (frame: ServerMsg, bytes: number) => void;
  #members: (Snap | Delta | Status)[] = [];
  #bytes = BATCH_ENVELOPE_BYTES;

  constructor(cap: number, emit: (frame: ServerMsg, bytes: number) => void) {
    this.#cap = cap;
    this.#emit = emit;
  }

  push(
    frame: Snap | Delta | Status,
    subject: string,
    onOversize: (subject: string, bytes: number) => void,
  ): void {
    const size = frameBytes(encode(frame));
    if (this.#members.length > 0 && this.#bytes + 1 + size > this.#cap) this.end();
    if (this.#members.length === 0 && BATCH_ENVELOPE_BYTES + size > this.#cap) {
      // One frame alone exceeds the cap. It cannot be split further without breaking the
      // one-subject-one-frame rule, so it goes out whole and the session is told (a 1 MiB single
      // subject means a field set no limit should have allowed).
      onOversize(subject, size);
    }
    this.#bytes += (this.#members.length > 0 ? 1 : 0) + size;
    this.#members.push(frame);
  }

  /** Emit whatever has accumulated. Safe to call when empty. */
  end(): void {
    if (this.#members.length === 0) return;
    const frame: ServerMsg = { t: 'batch', m: this.#members };
    this.#emit(frame, this.#bytes);
    this.#members = [];
    this.#bytes = BATCH_ENVELOPE_BYTES;
  }
}

/** `ProvRef` → the wire's `prov`, omitting `seq` when the provider gave none. */
function provOf(prov: ProvRef): Prov {
  return prov.srcSeq === undefined
    ? { p: prov.sourceId, id: prov.provenanceId }
    : { p: prov.sourceId, id: prov.provenanceId, seq: prov.srcSeq };
}
