/**
 * `client/quoteCache.ts` — the SDK's projection of live quote state (WP-13).
 *
 * `Map<subject, QuoteView>` plus two rules and nothing else:
 *
 *  1. **The prev-chain rule** (API.md §6.3 step 3, verbatim): apply iff `prev === lastSeq`, drop iff
 *     `seq <= lastSeq`, otherwise ask for a `resync` and ignore every further `delta` for that
 *     subject until a `snap` arrives. A gapped delta is never silently applied — silently applying
 *     one puts a wrong number on a screen with nothing to say anything went wrong — and never
 *     merely skipped either, because the chain cannot heal itself: only a fresh `snap` can.
 *  2. **The 1 s staleness ticker** (TERM-12): {@link QuoteCache.sweep} calls
 *     `core/quote/staleness.ts#valueState`, the SAME function the server's sweep
 *     (`plant/staleness.ts`) calls. There is no second staleness rule in this file, which is the
 *     whole point: a cell and a `status` frame can never disagree about what 'stale' means.
 *
 * Deltas are field-wise merges (§6.3 step 4): a field absent from `f` is unchanged, `null` means the
 * composite value became unknown and renders blank, and an entitlement denial is never introduced
 * (nor removed) by a delta — a grant change arrives as `downgrade`, then `resync`, then a fresh
 * `snap`.
 *
 * **The equality that defines this file:** a `snap` followed by its chain of `delta`s leaves exactly
 * the state a fresh `snap` at the same `seq` would, **for every member the wire restates**. Every
 * merge decision below (in particular how `fts` and `r` are carried) exists to hold that equality
 * against the server's own projection (`server/src/plant/policyTier.ts#view`, encoded by
 * `server/src/ws/conflator.ts`), and `test/client/quoteCache.test.ts` asserts it field by field.
 *
 * **The snap-only members, which the equality therefore excludes.** `Delta` and `Status`
 * (`wire/ws.ts`) have no member for `session`, `tier`, `reason`, `ac` or `id`: only a `snap` states
 * them, so a delta-fed view carries what its last `snap` said. Four of the five cannot move without
 * a `downgrade` + `resync` → fresh `snap`, so only `session` can actually diverge: with the session
 * moving `open`→`post` mid-chain, this cache reports `session:'open'` where a fresh `snap` at the
 * same `seq` reports `'post'`. **Read `session` as "the session as of the last snapshot", never as
 * the live session.**
 *
 * The implied close is deliberately NOT written back into `session` from a verdict, even though
 * `st:'closed'` does imply the session closed or is post. A verdict does not name which of the two it
 * is, and — the reason that matters — a stored `closed` could not be undone: `valueState` returns
 * `closed` for a closed session before it looks at anything else, so a session that reopens (a
 * pre-market `snap` is not guaranteed; deltas with `st:'live'` are what arrive) would keep greying
 * every live number until some later snapshot. So the closed session is derived at the point of use
 * instead, per call and per frame, in {@link stalenessInput} — where the next frame's `st` un-derives
 * it. That keeps the client's verdict equal to the server's (TERM-12) without storing a guess.
 */
import { valueState } from '@terminal/core';
import type { Clock, QuoteFields, StalenessInput } from '@terminal/core';
import { SystemClock } from '@terminal/core';

import type {
  AssetClass,
  FieldId,
  FieldValue,
  ReasonCode,
  SessionState,
  Tier,
  ValueState,
} from '../wire/envelope.js';
import type { Delta, Prov, Snap, Status, Ts } from '../wire/ws.js';

/** API.md §10.2 L1307-1312 — one subject's view; `f` holds only the subscribed fields. */
export interface QuoteView {
  subject: string;
  instrumentId: number | null;
  assetClass: AssetClass | null;
  seq: number;
  tier: Tier;
  reason: ReasonCode;
  /** field values */
  f: Record<FieldId, FieldValue>;
  /** per-field timestamps (epoch ms) */
  fts: Record<FieldId, number>;
  /** per-field entitlement reason */
  r: Record<FieldId, ReasonCode>;
  /** FEED-05 three timestamps */
  ts: Ts;
  st: ValueState;
  /**
   * The session as of the last `snap` — **snap-only**, like `tier`, `reason`, `assetClass` and
   * `instrumentId`: no `delta` or `status` frame carries a session, so this member can lag the market
   * (`open` while the session is really `post`). The staleness verdict does not depend on it lagging:
   * `st` plus {@link stalenessInput}'s derivation is what says a value is closed. See the file header.
   */
  session: SessionState;
  prov: Prov;
  /** the last `status` frame for this subject, or `null` before one arrives */
  status: 'live' | 'pending' | 'shed' | 'gone' | null;
}

/** What `QuoteCache.apply()` reports back to `LiveClient`. */
export interface ApplyResult {
  changed: FieldId[];
  resyncNeeded: boolean;
}

/** ARCHITECTURE §6.6 / CLIENT.md §9: the terminal re-evaluates staleness once a second. */
export const STALENESS_TICK_MS = 1_000;

/**
 * The staleness basis the client uses per granted tier, in milliseconds.
 *
 * `expectedIntervalMs` is a property of the winning md line (`md_lines.expected_interval_ms`) and the
 * wire carries no member for it, so the cache needs a default. These are the cadences the plant
 * actually runs at:
 *
 * - `delayed` → 10 000 ms, the Cboe quote cadence (`jobs/cboeQuotes.ts`, and the plant's own
 *   `DEFAULT_EXPECTED_INTERVAL_MS`), so the client's limit equals the server's for the normal case;
 * - `eod` → 60 000 ms, the eod flush ceiling (API.md §6.4). An eod subject is `closed` long before
 *   age matters, so this only bounds the pathological case;
 * - `realtime` → 1 000 ms. Not attainable from any v1 source (§6.6 downgrades every request to
 *   `delayed`), and present so the record is total rather than as a claim about a real feed.
 *
 * A host that knows better overrides it: `MdLine` (`wire/rest/reference.ts`) carries the winning
 * line's real `expectedIntervalMs`, and {@link QuoteCacheOptions.expectedIntervalMs} takes a function.
 */
export const CLIENT_EXPECTED_INTERVAL_MS: Readonly<Record<Tier, number>> = {
  realtime: 1_000,
  delayed: 10_000,
  eod: 60_000,
};

/**
 * The intrinsic source delay the client assumes per granted tier, in MINUTES.
 *
 * `valueState`'s last rung compares `now` against the source timestamp, and a delayed line's `src` is
 * a quarter of an hour behind the capture by definition (§6.6: "already >= 15 min delayed at
 * source"). Passing 0 there would make every delayed quote stale one tick after its snapshot — the
 * whole screen greys out with nothing wrong — so the client assumes what the server assumes for the
 * same unknown: `plant/composite.ts#delayMinFor`, which is 15 for `delayed` and 0 otherwise. Both
 * sides then reach the same verdict, which is the point of sharing the function (TERM-12).
 *
 * `MdLine.intrinsicDelayMin` (`wire/rest/reference.ts`) is the real figure; a host that has fetched
 * it passes {@link QuoteCacheOptions.delayMin}.
 */
export const CLIENT_DELAY_MIN: Readonly<Record<Tier, number>> = {
  realtime: 0,
  delayed: 15,
  eod: 0,
};

/** The reason codes that mean "this subscriber may not see a value at all" (API.md §6.6). */
const DENIAL_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'NO_FIRM_ENTITLEMENT',
  'NO_USER_ENTITLEMENT',
  'LICENCE_FORBIDS_USAGE',
]);

/** A per-subject staleness parameter: one constant for every subject, or a lookup. */
export type SubjectNumber = number | ((subject: string, view: QuoteView) => number);

/** The timer pair the 1 s ticker installs. Injectable so a test never waits on a real timer. */
export interface TickerTimers {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const platformTimers: TickerTimers = {
  setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
  clearInterval: (handle) => {
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
  },
};

export interface QuoteCacheOptions {
  /** Where "now" comes from for {@link QuoteCache.tick}. Default {@link SystemClock}. */
  clock?: Clock | undefined;
  /** Staleness basis per subject. Default {@link CLIENT_EXPECTED_INTERVAL_MS} by granted tier. */
  expectedIntervalMs?: SubjectNumber | undefined;
  /** Intrinsic source delay in minutes. Default {@link CLIENT_DELAY_MIN} by granted tier. */
  delayMin?: SubjectNumber | undefined;
  /** Timer source for {@link QuoteCache.startTicker}. Default the platform's. */
  timers?: TickerTimers | undefined;
  /** Tick period in ms. Default {@link STALENESS_TICK_MS}; only a test has a reason to change it. */
  tickMs?: number | undefined;
}

/** True when the subject as a whole may show no value (ENTL-05). */
function subjectDenied(view: QuoteView): boolean {
  if (DENIAL_REASONS.has(view.reason)) return true;
  const ids = Object.keys(view.f);
  if (ids.length === 0) return false;
  return ids.every((id) => view.f[id] === null && DENIAL_REASONS.has(view.r[id] ?? 'OK'));
}

/**
 * The `QuoteFields` `valueState` reads, out of the wire's `f`.
 *
 * A `null` on the wire means "the composite has no value for this field" (§6.3 step 4), which in a
 * `QuoteState` is an ABSENT member — so a null is dropped here rather than carried as a key. That
 * single translation is what makes `valueState`'s `na` rung mean the same thing on both sides;
 * carrying nulls through would make an all-blank subject look like one with values.
 */
function stalenessFields(f: Record<FieldId, FieldValue>): QuoteFields {
  const out: Record<string, FieldValue> = {};
  for (const [id, value] of Object.entries(f)) {
    if (value !== null && value !== undefined) out[id] = value;
  }
  return out;
}

/**
 * The `valueState` input for one view.
 *
 * Three members the wire does not repeat on every frame are taken from the server's own last
 * verdict, because that verdict is the only place they survive:
 *
 * - `session`: a `delta` carries no `session`, and a `status { st:'closed' }` says the session closed
 *   without naming it. So a server verdict of `closed` IS the statement that the session is closed
 *   or post, and it is fed back in as such. Without this the client would recompute a closed
 *   official print as `stale` one second later and contradict the `status` frame it had just applied.
 * - `denied`: from the reason codes (§6.6), not from a guess about the values.
 * - `dq: ['PROVIDER_DOWN']`: the reason code of the same name means "source circuit open: last
 *   values with `st:'stale'`", which is `valueState`'s `circuitOpen` rung.
 *
 * `delayMin` comes from {@link CLIENT_DELAY_MIN} for the same reason.
 */
function resolveNumber(
  source: SubjectNumber | undefined,
  fallback: Readonly<Record<Tier, number>>,
  subject: string,
  view: QuoteView,
): number {
  if (typeof source === 'number') return source;
  if (source === undefined) return fallback[view.tier];
  return source(subject, view);
}

function stalenessInput(
  subject: string,
  view: QuoteView,
  expected: SubjectNumber | undefined,
  delay: SubjectNumber | undefined,
): StalenessInput {
  const serverSaysClosed =
    view.st === 'closed' && view.session !== 'closed' && view.session !== 'post';
  const input: StalenessInput = {
    ts: view.ts,
    session: serverSaysClosed ? 'closed' : view.session,
    expectedIntervalMs: resolveNumber(expected, CLIENT_EXPECTED_INTERVAL_MS, subject, view),
    delayMin: resolveNumber(delay, CLIENT_DELAY_MIN, subject, view),
    fields: stalenessFields(view.f),
    denied: subjectDenied(view),
  };
  return view.reason === 'PROVIDER_DOWN' ? { ...input, dq: ['PROVIDER_DOWN'] } : input;
}

/** `status.st` values that are lifecycle, not verdict — the four `QuoteView.status` can hold. */
function lifecycleStatus(st: Status['st']): QuoteView['status'] | null {
  return st === 'pending' || st === 'shed' || st === 'gone' ? st : null;
}

/** `status.st` values that are a `ValueState` — the server's verdict about the value itself. */
function verdictStatus(st: Status['st']): ValueState | null {
  return st === 'stale' || st === 'closed' || st === 'blank' ? st : null;
}

/**
 * API.md §10.2 L1339-1342 — `Map<subject, QuoteView>`; applies `snap`/`delta` with the prev-chain
 * rule (§6.3) and exposes the 1 s staleness ticker (TERM-12).
 */
export class QuoteCache {
  readonly #views = new Map<string, QuoteView>();
  /** Subjects whose chain broke: every `delta` is ignored until a `snap` arrives (§6.3 step 3). */
  readonly #awaitingSnap = new Set<string>();
  readonly #clock: Clock;
  readonly #timers: TickerTimers;
  readonly #tickMs: number;
  readonly #expected: SubjectNumber | undefined;
  readonly #delayMin: SubjectNumber | undefined;
  #tickerHandle: unknown = null;
  #onSweep: ((subjects: string[]) => void) | null = null;

  constructor(options: QuoteCacheOptions = {}) {
    this.#clock = options.clock ?? new SystemClock();
    this.#timers = options.timers ?? platformTimers;
    this.#tickMs = options.tickMs ?? STALENESS_TICK_MS;
    this.#expected = options.expectedIntervalMs;
    this.#delayMin = options.delayMin;
  }

  /** Apply one server frame. Returns the changed field ids and whether a `resync` must be sent. */
  apply(msg: Snap | Delta | Status): ApplyResult {
    if (msg.t === 'snap') return this.#applySnap(msg);
    if (msg.t === 'delta') return this.#applyDelta(msg);
    return this.#applyStatus(msg);
  }

  /**
   * A `snap` replaces the whole view and ends any resync wait for the subject.
   *
   * `changed` is what actually moved against the previous view — the fields whose value differs, the
   * ones the snap adds, and the ones it no longer carries (a cell whose field vanished has to be
   * repainted blank). On a first snap there is no previous view, so every field is reported: the
   * grid paints them all, and `kind:'snap'` is how the cell registry knows not to flash a first
   * paint. A resync snap that changes nothing therefore flashes nothing.
   */
  #applySnap(msg: Snap): ApplyResult {
    const previous = this.#views.get(msg.s);
    const view: QuoteView = {
      subject: msg.s,
      instrumentId: msg.id,
      assetClass: msg.ac,
      seq: msg.seq,
      tier: msg.tier,
      reason: msg.reason,
      f: { ...msg.f },
      fts: { ...(msg.fts ?? {}) },
      r: { ...(msg.r ?? {}) },
      ts: { ...msg.ts },
      st: msg.st,
      session: msg.session,
      prov: { ...msg.prov },
      // No wire frame carries `status:'live'`; a `snap` is what produces it. The snapshot is the
      // subject flowing again, which is exactly what ends a 'pending' or a 'shed' (§6.5: the client
      // re-`sub`s a shed row when it scrolls back into view, and the answer is a fresh snap).
      status: 'live',
    };
    this.#views.set(msg.s, view);
    this.#awaitingSnap.delete(msg.s);

    if (previous === undefined) return { changed: Object.keys(view.f), resyncNeeded: false };
    const changed: FieldId[] = [];
    for (const id of Object.keys(view.f)) {
      if (!Object.prototype.hasOwnProperty.call(previous.f, id) || previous.f[id] !== view.f[id]) {
        changed.push(id);
      }
    }
    for (const id of Object.keys(previous.f)) {
      if (!Object.prototype.hasOwnProperty.call(view.f, id)) changed.push(id);
    }
    return { changed, resyncNeeded: false };
  }

  /**
   * The prev-chain rule, in the order `server/test/integration/ws/resync.test.ts` states it: a
   * subject already waiting for a snap ignores deltas (and does NOT ask twice), then `seq <= lastSeq`
   * is a duplicate and dropped, then `prev !== lastSeq` is a gap and asks for a resync, and only
   * then is the merge applied.
   *
   * `lastSeq` is the view's own `seq` — there is no second copy of it to drift — and -1 when the
   * cache has never seen the subject, which makes an unheralded delta a gap rather than a silent
   * first value.
   */
  #applyDelta(msg: Delta): ApplyResult {
    const view = this.#views.get(msg.s);
    if (this.#awaitingSnap.has(msg.s)) return { changed: [], resyncNeeded: false };
    const lastSeq = view?.seq ?? -1;
    if (msg.seq <= lastSeq) return { changed: [], resyncNeeded: false };
    if (msg.prev !== lastSeq || view === undefined) {
      this.#awaitingSnap.add(msg.s);
      return { changed: [], resyncNeeded: true };
    }

    const changed: FieldId[] = [];
    for (const [id, value] of Object.entries(msg.f)) {
      if (!Object.prototype.hasOwnProperty.call(view.f, id) || view.f[id] !== value) {
        changed.push(id);
      }
      view.f[id] = value;
      // `fts` is authoritative for the fields the delta reports: the server sends a timestamp for
      // every reported field that carries a value and none for a field that does not
      // (`policyTier.ts#view`), so a field that just went `null` must LOSE its timestamp. Keeping
      // the old one would leave a stamp on a blank cell and break the snap/delta equality.
      const stamp = msg.fts?.[id];
      if (stamp === undefined) delete view.fts[id];
      else view.fts[id] = stamp;
      // A served value cannot carry a reason for not being served. A `null` keeps whatever reason
      // was there: a denial is never introduced by a delta, and never removed by one either — a
      // grant change arrives as `downgrade` + `resync` → fresh `snap` (§6.3 step 4).
      if (value !== null) delete view.r[id];
    }
    view.seq = msg.seq;
    view.ts = { ...msg.ts };
    view.st = msg.st;
    if (msg.prov !== undefined) view.prov = { ...msg.prov };
    return { changed, resyncNeeded: false };
  }

  /**
   * A `status` frame carries no values, so nothing is `changed`; it moves the lifecycle
   * (`pending`/`shed`/`gone`), the verdict (`stale`/`closed`/`blank` — all three are `ValueState`s,
   * which is why they land on `st`) or the session (`halted` — the ONLY session transition the wire
   * names; a close arrives as the verdict `st:'closed'`, which the file header explains is derived
   * per call rather than written into `session`). A frame for a subject the cache has
   * never seen is ignored: there is no view to qualify, and inventing one would put a row on screen
   * that no `snap` ever described.
   */
  #applyStatus(msg: Status): ApplyResult {
    const view = this.#views.get(msg.s);
    if (view === undefined) return { changed: [], resyncNeeded: false };
    const lifecycle = lifecycleStatus(msg.st);
    if (lifecycle !== null) view.status = lifecycle;
    const verdict = verdictStatus(msg.st);
    if (verdict !== null) view.st = verdict;
    if (msg.st === 'halted') view.session = 'halted';
    return { changed: [], resyncNeeded: false };
  }

  /**
   * Re-evaluate `valueState` at `now` (epoch ms); returns the subjects whose state changed.
   *
   * The verdict comes from `core/quote/staleness.ts#valueState` — the server's function, called with
   * the client's own clock, which is the whole of TERM-12: a socket that died between two deltas
   * leaves no "live" number on the screen, because this is what says so.
   */
  sweep(now: number): string[] {
    const moved: string[] = [];
    for (const [subject, view] of this.#views) {
      const next = valueState(stalenessInput(subject, view, this.#expected, this.#delayMin), now);
      if (next === view.st) continue;
      view.st = next;
      moved.push(subject);
    }
    return moved;
  }

  /** `sweep(clock.now())` — what the 1 s ticker calls, and what a test calls on a `VirtualClock`. */
  tick(): string[] {
    return this.sweep(this.#clock.now());
  }

  /**
   * Start the 1 s staleness ticker (TERM-12). Returns the stop function; starting twice is a no-op
   * (the running ticker and its handler stay), so the host app cannot end up with two tickers over
   * one cache.
   *
   * The web app drives the sweep itself from `rt/stalenessTicker.ts` (CLIENT.md §9) so that one
   * timer per document also restyles the chart legend; this exists for every other host — a Node
   * consumer of the SDK — and for the test that pins the period at 1 000 ms.
   */
  startTicker(onSweep?: (subjects: string[]) => void): () => void {
    const stop = (): void => {
      this.stopTicker();
    };
    // A no-op means a no-op: a second call does not replace the running ticker's handler either,
    // because the first caller is the one holding the stop function.
    if (this.#tickerHandle !== null) return stop;
    this.#onSweep = onSweep ?? null;
    this.#tickerHandle = this.#timers.setInterval(() => {
      const moved = this.tick();
      if (moved.length > 0) this.#onSweep?.(moved);
    }, this.#tickMs);
    return stop;
  }

  /** Stop the ticker. Idempotent. */
  stopTicker(): void {
    if (this.#tickerHandle === null) return;
    this.#timers.clearInterval(this.#tickerHandle);
    this.#tickerHandle = null;
    this.#onSweep = null;
  }

  /** True while the 1 s ticker is installed. */
  get ticking(): boolean {
    return this.#tickerHandle !== null;
  }

  /** The current view for one subject, or `undefined` when the cache has never seen it. */
  get(subject: string): QuoteView | undefined {
    return this.#views.get(subject);
  }

  /** One field's current value, or `undefined` when the subject or the field is not held. */
  value(subject: string, field: FieldId): FieldValue | undefined {
    return this.#views.get(subject)?.f[field];
  }

  /** Every subject currently held. */
  subjects(): string[] {
    return [...this.#views.keys()];
  }

  /** How many subjects are held. */
  get size(): number {
    return this.#views.size;
  }

  /** True while the subject's chain is broken and its deltas are being ignored (§6.3 step 3). */
  isAwaitingSnap(subject: string): boolean {
    return this.#awaitingSnap.has(subject);
  }

  /** Drop one subject (on `unsub`) or, with no argument, everything (on a failed resume). */
  delete(subject?: string): void {
    if (subject === undefined) {
      this.#views.clear();
      this.#awaitingSnap.clear();
      return;
    }
    this.#views.delete(subject);
    this.#awaitingSnap.delete(subject);
  }

  /** The `known` map (`subject → seq`) sent with `hello`/`resync` after a reconnect. */
  known(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [subject, view] of this.#views) out[subject] = view.seq;
    return out;
  }
}
