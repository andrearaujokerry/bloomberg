/**
 * The ticker plant (BUS-01, BUS-02, BUS-05, FEED-02/05/06) — ARCHITECTURE §6.2, WORKPLAN WP-06.
 *
 * `Map<subject, QuoteState>` and the eight steps of `apply(update)`. The composite is the truth:
 * there is no delta log, so recovery is always a fresh snapshot (BUS-07), and everything a
 * subscriber ever sees is a projection of the state this module holds.
 *
 * `apply`, step by step (ARCHITECTURE §6.2):
 *
 *  1. create-or-get the subject's state and its line.
 *  2. **Stale sequence.** `update.prov.srcSeq <= line.srcSeq` means the poll returned data the
 *     plant already has: touch `line.ts.cap` and `state.ts.cap` — the capture is real and feeds
 *     staleness — count it, and return. No `seq`, no fan-out, and nothing invented (FEED-02).
 *  3. Write the line: its previous fields merged with the update's, the update's timestamps, its
 *     `srcSeq` and `provenanceId`. Per-field provenance lives here (BUS-05).
 *  4. Recompose through `plant/composite.ts` (`core/quote/merge.ts` + `core/quote/derive.ts`).
 *  5. `changed` = fields whose composite value differs, NaN-safe, with `null` a value. Empty →
 *     touch `ts.cap` only: a poll that returned the same numbers is not a new version.
 *  6. `seq += 1`; `fieldTs` for the changed fields; `ts = { src, cap, pub: clock.now() }`; `prov`;
 *     `session` (the feed's when the normaliser supplied one, else the instrument calendar's);
 *     `state` via the one `valueState`.
 *  7. Fan out to every listener with the changed-field mask — `Uint32Array` bitsets over the
 *     dictionary index, so a session subscribed to `PX_LAST` never wakes for `PX_BID` (BUS-02).
 *  8. Observe the publish latency (`pub − cap`), budget < 1 ms p99 in process.
 *
 * **Non-quote subjects.** `publish()` is the door for `n:`, `c:`, `e:` and `sys:status`: they have
 * no provider line and no merge, but they carry the same per-subject `seq` and the same fan-out.
 * News is **queued, not conflated** (NEWS-01): every `publish` to an `n:` subject is kept, in
 * order, so the conflator can emit one delta per headline instead of the last one in the window.
 *
 * **Persistence.** With a store wired (`plant/store.ts`, the only writer of the three tables) every
 * applied update becomes a `quote_ticks` row and every version bump a `quote_snapshots` upsert;
 * rows are batched and land on `flushStore()` or `stop()`. Only the composite `q:` subject is
 * upserted — `quote_snapshots` is keyed by `instrument_id`, so an `r:`/`l:` view of the same
 * instrument would otherwise collapse onto its row.
 *
 * **Time.** Every instant comes from the injected `Clock`; this module has no timers. The 1 s
 * staleness sweep is `plant/staleness.ts` and is driven by the caller (`sweep()`), which is what
 * lets a test run ten virtual seconds in a millisecond.
 */

import {
  emptyMask,
  lineTime,
  localClock,
  localTimeToUtc,
  maskOf,
  sessionCalendar,
  sessionState,
  valueState,
} from '@terminal/core';
import type {
  AssetClass,
  Clock,
  FieldId,
  FieldValue,
  LineState,
  NormalisedUpdate,
  ProvRef,
  QuoteFieldId,
  QuoteFields,
  QuoteState,
  SessionCalendar,
  SessionState,
  Tier,
  Timestamps3,
} from '@terminal/core';
import { fromEpochDay, toEpochDay } from '@terminal/core/calendars/calendar';
import { FX_USD } from '@terminal/core/calendars/fx';
import { XNYS } from '@terminal/core/calendars/nyse';
import { SIFMA } from '@terminal/core/calendars/sifma';

import type { Config } from '../config.js';
import type { Db, Tx } from '../db/client.js';

import {
  dbDivergenceSink,
  delayMinFor,
  recompose,
  resolveLineMeta,
  DIVERGENCE_TOLERANCE_PCT,
  NOOP_DQ_SINK,
  type CompositeDqSink,
  type LineMeta,
  type LineMetaSource,
} from './composite.js';
import { buildEodSnapshot, type EodView } from './eod.js';
import { stalenessSweeper, type StalenessSweeper, type StalenessTransition } from './staleness.js';
import { plantStore, type PlantStore, type TickKind } from './store.js';
import { familyOf, instrumentIdOf, parseSubject } from './subjects.js';
import { warmPlant, type WarmSkip } from './warm.js';

/** ARCHITECTURE §11 / `StatusResponse.plant.state`. */
export type PlantState = 'ok' | 'degraded';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Calendars
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** How a subject's session is decided (FEED-06). */
export interface SessionCalendars {
  /**
   * The calendar for an asset class, and whether it trades an extended session. `null` means the
   * class has no calendar here — `sessionOf` then answers from {@link constantSession}.
   */
  for(assetClass: AssetClass): { calendar: SessionCalendar; hasPrePost: boolean } | null;
}

const NYSE_SESSION = sessionCalendar(XNYS);
const SIFMA_SESSION = sessionCalendar(SIFMA);

/**
 * The default mapping: US equities and ETFs on the NYSE calendar with pre/post, indices, options
 * and futures on the same calendar without one, government bonds and rates on SIFMA.
 *
 * `fx` and `crypto` have no exchange session: crypto is always `open`, and FX is `open` on a USD
 * settlement business day and `closed` at the weekend (the honest answer for a 24×5 market —
 * inventing an opening auction for it would be a guess).
 */
export const DEFAULT_SESSION_CALENDARS: SessionCalendars = {
  for(assetClass: AssetClass): { calendar: SessionCalendar; hasPrePost: boolean } | null {
    switch (assetClass) {
      case 'equity':
      case 'etf':
        return { calendar: NYSE_SESSION, hasPrePost: true };
      case 'index':
      case 'option':
      case 'future':
        return { calendar: NYSE_SESSION, hasPrePost: false };
      case 'govt':
      case 'rate':
        return { calendar: SIFMA_SESSION, hasPrePost: false };
      default:
        return null;
    }
  },
};

/** The session of a class with no exchange calendar. */
function constantSession(assetClass: AssetClass, nowMs: number): SessionState {
  if (assetClass === 'crypto') return 'open';
  if (assetClass === 'fx') {
    const local = localClock('UTC', nowMs);
    if (local === undefined) return 'unknown';
    return FX_USD.isBusinessDay(local.date) ? 'open' : 'closed';
  }
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PlantDeps {
  config: Config;
  clock: Clock;
  /** Wires the store (when none is passed) and the DQ writer. Optional: a unit plant has neither. */
  db?: Db | Tx;
  /** An explicit store — a test passes one over its own transaction. */
  store?: PlantStore;
  calendars?: SessionCalendars;
  /** `md_lines` metadata by id; without it {@link resolveLineMeta}'s source defaults apply. */
  lineMeta?: LineMetaSource;
  /** Where a plant problem is reported. Default: silent (the caller's logger is not in scope). */
  onError?: (err: unknown, detail: string) => void;
}

/** What a listener is told: which subject moved to which version, and which fields changed. */
export interface PlantEvent {
  subject: string;
  seq: number;
  /** Dictionary-index bitset of the changed fields (`core/quote/mask.ts`). */
  changed: Uint32Array;
  /** `true` for a queued (news) publication: the conflator must not collapse it (NEWS-01). */
  queued: boolean;
  /** `true` when the plant is asking the session to re-snapshot the subject (BUS-07). */
  resync?: boolean;
}

export type PlantListener = (ev: PlantEvent) => void;

export interface PlantStats {
  updatesApplied: number;
  updatesDroppedStaleSeq: number;
  publishLatencyP99Ms: number;
  subjects: number;
}

export interface Plant {
  /** `ok` once the warm start loaded rows or the first update has been applied. */
  readonly state: PlantState;
  /** `true` when the plant can serve snapshots — the `plant` field of `GET /health`. */
  ready(): boolean;
  /** Number of live subjects (`StatusResponse.plant.subjects`). */
  subjectCount(): number;
  /** Warm from `quote_snapshots` and arm the sweep (startup step 6). */
  start(): Promise<void>;
  /** Flush the store and stop; safe to call when never started (SIGTERM). */
  stop(): Promise<void>;
  /** The ingest path (`jobs/cboeQuotes.ts#MarketPlant`, `providers/sim/feed.ts#SimPlant`). */
  apply(update: NormalisedUpdate): void;
  /** Non-quote subjects: news (queued), curves, econ series, `sys:status`. */
  publish(
    subject: string,
    fields: Record<FieldId, FieldValue>,
    meta: PublishMeta,
  ): void;
  /** The live composite — read at flush time, which is the conflator's latest-value guarantee. */
  get(subject: string): QuoteState | undefined;
  has(subject: string): boolean;
  subjects(): Iterable<string>;
  /** A detached copy of one subject's state. */
  snapshot(subject: string): QuoteState | undefined;
  snapshotMany(subjects: readonly string[]): Map<string, QuoteState>;
  /** Fan-out registration; the returned function unsubscribes. */
  subscribe(listener: PlantListener): () => void;
  /** The official close an `eod`-tier subscriber is frozen on, or `null`. */
  eodView(subject: string): EodView | null;
  stats(): PlantStats;
  /** Ask every session to re-snapshot (plant restart, entitlement reload). */
  forceResync(subjects?: string[]): void;

  // ── Beyond the WP-06 shared contract, for the gateway and the ingest runtime ───────────────
  /** One 1 s staleness sweep (TERM-12); returns only the subjects whose verdict changed. */
  sweep(nowMs?: number): StalenessTransition[];
  /** Milliseconds until the earliest pending staleness transition. */
  nextStalenessMs(nowMs?: number): number;
  /** Write the queued tick / snapshot rows. A no-op with no store wired. */
  flushStore(): Promise<void>;
  /** Queued publications of a news subject after `afterSeq`, oldest first (NEWS-01). */
  queuedAfter(subject: string, afterSeq: number): QuoteState[];
  /** Freeze the current composite as the official close of `sessionDate` and persist it. */
  captureEod(subject: string, sessionDate: string, closeTsMs: number): EodView | null;
  /** Hydrate the eod view of a subject from `eod_snapshots` (the warm path for an eod subscriber). */
  loadEod(subject: string): Promise<EodView | null>;
  /** Rows the warm start could not load, with why. */
  warmSkipped(): readonly WarmSkip[];
}

export interface PublishMeta {
  ts: Timestamps3;
  prov?: ProvRef;
  /** Default: `true` for `n:` subjects (queued, never conflated), `false` for everything else. */
  queued?: boolean;
  /** The class stamped on the state; defaults per family (`c:` rates, everything else `econ`). */
  assetClass?: AssetClass;
  session?: SessionState;
  state?: QuoteState['state'];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Per-subject bookkeeping the wire shape does not carry. */
interface Entry {
  state: QuoteState;
  /** Tier last reported per line, so the composite can take the winner's. */
  tiers: Map<number, Tier>;
  /** Queued publications (news), oldest first; capped. */
  queue: QuoteState[];
  eod?: EodView;
}

/** Headlines kept per `n:` subject; a client further behind than this resyncs. */
export const QUEUE_CAPACITY = 512;

/** Publish latencies kept for the p99 (ARCHITECTURE §6.2 step 8). */
const LATENCY_WINDOW = 1_024;

/** NaN-safe equality where `null` and `undefined` are distinct values. */
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b || (Number.isNaN(a) && Number.isNaN(b));
  }
  return a === b;
}

/** Field ids whose composite value differs between two field sets. */
export function changedFieldIds(prev: QuoteFields, next: QuoteFields): QuoteFieldId[] {
  const ids = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
  const out: QuoteFieldId[] = [];
  for (const id of ids) {
    const a = (prev as Record<string, unknown>)[id];
    const b = (next as Record<string, unknown>)[id];
    if (a === undefined && b === undefined) continue;
    if (!sameValue(a, b)) out.push(id as QuoteFieldId);
  }
  return out;
}

/**
 * `quote_ticks.kind` for an update: a poll that carries session aggregates is a `summary` (what
 * the Cboe delayed line publishes), one that carries a print is a `trade`, one that carries only a
 * book is a `quote`.
 */
export function tickKindOf(fields: Partial<QuoteFields>): TickKind {
  if (
    fields.PX_OPEN !== undefined ||
    fields.PX_HIGH !== undefined ||
    fields.PX_LOW !== undefined ||
    fields.PX_CLOSE_1D !== undefined ||
    fields.PX_OFFICIAL_CLOSE !== undefined
  ) {
    return 'summary';
  }
  return fields.PX_LAST !== undefined ? 'trade' : 'quote';
}

/** A detached copy, so a caller cannot mutate the plant's truth through a snapshot. */
function cloneState(state: QuoteState): QuoteState {
  return structuredClone(state);
}

const SYNTHETIC_PROV: ProvRef = { sourceId: 'internal.derived', provenanceId: 0 };

/**
 * The provenance of one md line: the observation that produced the values the composite took from
 * it. `state.prov` is this for the winning line, so Ctrl+I points at the poll that produced the
 * number on screen (DATA-10).
 */
function provOfLine(line: LineState): ProvRef {
  return {
    sourceId: line.sourceId,
    provenanceId: line.provenanceId,
    ...(line.srcSeq === undefined ? {} : { srcSeq: line.srcSeq }),
  };
}

/** The class stamped on a non-quote subject's state; curves are rates, the rest are `econ`. */
function publishAssetClass(subject: string): AssetClass {
  return familyOf(subject) === 'c' ? 'rate' : 'econ';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// buildPlant
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the plant. The signature is WP-01's (`app.ts`, `index.ts` and `src/test/app.ts` call
 * `buildPlant({ config, clock })`); everything beyond `config` and `clock` is optional.
 */
export function buildPlant(deps: PlantDeps): Plant {
  // The plant reads no configuration of its own yet (cadences come from `md_lines`), but it stays
  // in the dependency set: the conflation floor and the overload thresholds are configured, and
  // the gateway reaches them through the same object.
  void deps.config;

  const { clock } = deps;
  const table = new Map<string, Entry>();
  const listeners = new Set<PlantListener>();
  const calendars = deps.calendars ?? DEFAULT_SESSION_CALENDARS;
  const store: PlantStore | undefined =
    deps.store ?? (deps.db === undefined ? undefined : plantStore({ db: deps.db, clock }));
  const onError = deps.onError ?? ((): void => undefined);
  const dqSink: CompositeDqSink =
    deps.db === undefined
      ? NOOP_DQ_SINK
      : dbDivergenceSink(deps.db, (err) => {
          onError(err, 'plant: cross_source_divergence dq row');
        });

  let started = false;
  let plantState: PlantState = 'degraded';
  let skipped: readonly WarmSkip[] = [];
  const stats = { applied: 0, dropped: 0 };
  const latencies: number[] = [];

  const metaCache = new Map<number, LineMeta>();
  function metaFor(mdLineId: number, sourceId: string): LineMeta {
    const cached = metaCache.get(mdLineId);
    if (cached !== undefined) return cached;
    const meta = resolveLineMeta(mdLineId, sourceId, deps.lineMeta);
    metaCache.set(mdLineId, meta);
    return meta;
  }

  function sessionOf(assetClass: AssetClass, nowMs: number): SessionState {
    const entry = calendars.for(assetClass);
    if (entry === null) return constantSession(assetClass, nowMs);
    return sessionState(entry.calendar, nowMs, entry.hasPrePost);
  }

  function tzOf(assetClass: AssetClass): string | undefined {
    return calendars.for(assetClass)?.calendar.tz;
  }

  function notify(ev: PlantEvent): void {
    for (const listener of listeners) {
      try {
        listener(ev);
      } catch (err) {
        // A broken subscriber must not stop the plant: the tick is already the truth.
        onError(err, `plant: listener threw for ${ev.subject}`);
      }
    }
  }

  function observeLatency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    latencies.push(ms);
    if (latencies.length > LATENCY_WINDOW) latencies.shift();
  }

  function p99(): number {
    if (latencies.length === 0) return 0;
    const sorted = [...latencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1);
    return sorted[Math.max(0, idx)] ?? 0;
  }

  const sweeper: StalenessSweeper = stalenessSweeper({
    subjects: () => table.keys(),
    get: (subject) => table.get(subject)?.state,
  });

  // ── apply ──────────────────────────────────────────────────────────────────────────────────

  function createEntry(update: NormalisedUpdate, meta: LineMeta): Entry {
    const state: QuoteState = {
      subject: update.subject,
      instrumentId: update.instrumentId,
      assetClass: update.assetClass,
      seq: 0,
      tier: update.tier,
      delayMin: delayMinFor(meta, update.tier),
      fields: {},
      fieldTs: {},
      ts: { src: null, cap: 0, pub: 0 },
      session: 'unknown',
      // Nothing has been captured yet: `valueState` calls that `blank`, and so does this.
      state: 'blank',
      ageMs: 0,
      expectedIntervalMs: meta.expectedIntervalMs,
      prov: update.prov,
      lines: {},
      dq: [],
    };
    return { state, tiers: new Map(), queue: [] };
  }

  function apply(update: NormalisedUpdate): void {
    const now = clock.now();
    const meta = metaFor(update.mdLineId, update.prov.sourceId);

    // 1. create-or-get
    let entry = table.get(update.subject);
    if (entry === undefined) {
      entry = createEntry(update, meta);
      table.set(update.subject, entry);
    }
    const state = entry.state;
    const previousLine = state.lines[update.mdLineId];

    // 2. a replayed sequence: the capture is real, the data is not new
    const srcSeq = update.prov.srcSeq;
    if (srcSeq !== undefined && previousLine?.srcSeq !== undefined && srcSeq <= previousLine.srcSeq) {
      previousLine.ts = { ...previousLine.ts, cap: Math.max(previousLine.ts.cap, update.ts.cap) };
      state.ts = { ...state.ts, cap: Math.max(state.ts.cap, update.ts.cap) };
      state.ageMs = Math.max(0, now - state.ts.cap);
      stats.dropped += 1;
      return;
    }

    // 3. write the line
    const line: LineState = {
      mdLineId: update.mdLineId,
      sourceId: update.prov.sourceId,
      fields: { ...(previousLine?.fields ?? {}), ...update.fields },
      ts: { src: update.ts.src, cap: update.ts.cap, pub: now },
      ...(srcSeq === undefined ? {} : { srcSeq }),
      provenanceId: update.prov.provenanceId,
    };
    state.lines[update.mdLineId] = line;
    entry.tiers.set(update.mdLineId, update.tier);

    // 4. recompose
    const previousFields = state.fields;
    const composite = recompose({
      lines: state.lines,
      prev: previousFields,
      meta: (id) => metaFor(id, state.lines[id]?.sourceId ?? update.prov.sourceId),
      tz: tzOf(state.assetClass),
    });

    stats.applied += 1;
    if (store !== undefined) {
      // FEED-05: `pub` is the plant's own instant, and the tick row records it.
      store.writeTick({
        update: { ...update, ts: { ...update.ts, pub: now } },
        kind: tickKindOf(update.fields),
        tickDir: composite.fields.TICK_DIR ?? null,
      });
    }

    // 5. what changed
    const changed = changedFieldIds(previousFields, composite.fields);
    const hadDivergence = state.dq.includes('CROSS_SOURCE_DIVERGENCE');
    state.dq = composite.dq;
    if (!hadDivergence && composite.divergence !== null) {
      const pair = composite.divergence;
      dqSink({
        subject: state.subject,
        instrumentId: state.instrumentId,
        sourceId: pair.expected.sourceId,
        expected: pair.expected.fields.PX_LAST!,
        actual: pair.actual.fields.PX_LAST!,
        tolerancePct: DIVERGENCE_TOLERANCE_PCT,
        expectedMdLineId: pair.expected.mdLineId,
        actualMdLineId: pair.actual.mdLineId,
      });
    }

    if (changed.length === 0) {
      state.ts = { ...state.ts, cap: Math.max(state.ts.cap, update.ts.cap) };
      state.ageMs = Math.max(0, now - state.ts.cap);
      return;
    }

    // 6. a new version
    state.seq += 1;
    const fallbackTs = update.ts.src ?? update.ts.cap;
    for (const id of changed) {
      if (composite.fields[id] === undefined) {
        delete state.fieldTs[id];
        continue;
      }
      state.fieldTs[id] = composite.fieldTs[id] ?? fallbackTs;
    }
    state.fields = composite.fields;
    const winner = composite.winner;
    state.ts = {
      // The composite is as of the line that supplied its price, not of whichever line last
      // arrived: a lower-priority line landing with an older `ts.src` must not rewind the
      // composite's clock, which would report `stale` while `fieldTs` still holds newer times.
      // `lineTime` is the same instant `merge.ts` stamps into `fieldTs`, so the two agree.
      src: winner === undefined ? update.ts.src : lineTime(winner),
      // A capture instant never rewinds: staleness is measured from the latest real capture.
      cap: Math.max(state.ts.cap, update.ts.cap),
      pub: now,
    };
    // Provenance names the line that supplied the price (DATA-10, API.md §6.8 pairs the Cboe
    // observation with the Cboe `PX_LAST`), not the line that happened to arrive last.
    state.prov = winner === undefined ? update.prov : provOfLine(winner);
    state.ageMs = Math.max(0, now - state.ts.cap);

    if (winner !== undefined) {
      const winnerMeta = metaFor(winner.mdLineId, winner.sourceId);
      const winnerTier = entry.tiers.get(winner.mdLineId) ?? update.tier;
      state.tier = winnerTier;
      state.delayMin = delayMinFor(winnerMeta, winnerTier);
      state.expectedIntervalMs = winnerMeta.expectedIntervalMs;
    }
    state.session = update.session ?? sessionOf(state.assetClass, now);
    state.state = valueState(state, now);

    if (started && plantState !== 'ok') plantState = 'ok';

    // The store keys `quote_snapshots` by `instrument_id`, so only the composite subject is
    // upserted; an `l:`/`r:` view of the same instrument would otherwise overwrite its row.
    if (store !== undefined && familyOf(state.subject) === 'q') {
      store.upsertSnapshot(state.subject, state.seq, cloneState(state));
    }

    // 7. fan out
    notify({ subject: state.subject, seq: state.seq, changed: maskOf(changed), queued: false });

    // 8. publish latency
    observeLatency(state.ts.pub - state.ts.cap);
  }

  // ── publish (non-quote subjects) ───────────────────────────────────────────────────────────

  function publish(
    subject: string,
    fields: Record<FieldId, FieldValue>,
    meta: PublishMeta,
  ): void {
    const now = clock.now();
    const parsed = parseSubject(subject);
    const family = parsed?.family ?? null;
    let entry = table.get(subject);
    if (entry === undefined) {
      const state: QuoteState = {
        subject,
        instrumentId: (parsed === null ? null : instrumentIdOf(parsed)) ?? 0,
        assetClass: meta.assetClass ?? publishAssetClass(subject),
        seq: 0,
        tier: 'delayed',
        delayMin: 0,
        fields: {},
        fieldTs: {},
        ts: { src: null, cap: 0, pub: 0 },
        session: 'unknown',
        state: 'blank',
        ageMs: 0,
        // A published subject has no poll cadence; a minute is the coarsest thing the terminal
        // treats as live, and the sweep uses it only to decide `stale`.
        expectedIntervalMs: 60_000,
        prov: meta.prov ?? SYNTHETIC_PROV,
        lines: {},
        dq: [],
      };
      entry = { state, tiers: new Map(), queue: [] };
      table.set(subject, entry);
    }

    const state = entry.state;
    const queued = meta.queued ?? family === 'n';
    state.seq += 1;
    const ids = Object.keys(fields);
    const stamp = meta.ts.src ?? meta.ts.cap;
    for (const id of ids) {
      const value = fields[id];
      if (value === undefined) continue;
      (state.fields as Record<string, FieldValue>)[id] = value;
      (state.fieldTs as Record<string, number>)[id] = stamp;
    }
    state.ts = { src: meta.ts.src, cap: Math.max(state.ts.cap, meta.ts.cap), pub: now };
    if (meta.prov !== undefined) state.prov = meta.prov;
    state.session = meta.session ?? 'unknown';
    state.ageMs = Math.max(0, now - state.ts.cap);
    // A published subject is what the publisher says it is: there is no provider cadence to
    // measure it against, so it is live until the publisher says otherwise.
    state.state = meta.state ?? 'live';

    if (queued) {
      entry.queue.push(cloneState(state));
      if (entry.queue.length > QUEUE_CAPACITY) entry.queue.shift();
    }

    if (started && plantState !== 'ok') plantState = 'ok';
    notify({ subject, seq: state.seq, changed: maskOf(ids), queued });
    observeLatency(state.ts.pub - state.ts.cap);
  }

  // ── eod ────────────────────────────────────────────────────────────────────────────────────

  /** The close of the last completed session of `assetClass` at `nowMs`, or `null`. */
  function lastSessionClose(
    assetClass: AssetClass,
    nowMs: number,
  ): { sessionDate: string; closeTs: number } | null {
    const entry = calendars.for(assetClass);
    if (entry === null) return null;
    const { calendar } = entry;
    const local = localClock(calendar.tz, nowMs);
    if (local === undefined) return null;
    let date = local.date;
    for (let i = 0; i < 10; i += 1) {
      const close = calendar.closeTime(date);
      if (close !== undefined) {
        const closeTs = localTimeToUtc(calendar.tz, date, close);
        if (closeTs !== undefined && closeTs <= nowMs) return { sessionDate: date, closeTs };
      }
      date = previousDate(date);
    }
    return null;
  }

  function eodView(subject: string): EodView | null {
    const entry = table.get(subject);
    if (entry === undefined) return null;
    if (entry.eod !== undefined) return entry.eod;
    const session = lastSessionClose(entry.state.assetClass, clock.now());
    if (session === null) return null;
    const view = buildEodSnapshot(entry.state, session.sessionDate, session.closeTs);
    // Nothing is frozen that has no close at all: an `eod` subscriber then sees `blank`, which is
    // what `policyTier.view` reports for a missing view, rather than a fabricated zero.
    if (view.flags.includes('MISSING_CLOSE') && Object.keys(view.fields).length === 0) return null;
    entry.eod = view;
    return view;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    if (store !== undefined) {
      const warm = await warmPlant(store);
      skipped = warm.skipped;
      for (const row of warm.rows) {
        if (table.has(row.subject)) continue;
        table.set(row.subject, { state: row.state, tiers: new Map(), queue: [] });
      }
      if (warm.rows.length > 0) plantState = 'ok';
    }
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    if (store !== undefined) {
      try {
        await store.flush();
      } catch (err) {
        onError(err, 'plant: store flush on stop');
      }
    }
  }

  return {
    get state(): PlantState {
      return plantState;
    },
    ready(): boolean {
      return started;
    },
    subjectCount(): number {
      return table.size;
    },
    start,
    stop,
    apply,
    publish,

    get(subject: string): QuoteState | undefined {
      return table.get(subject)?.state;
    },
    has(subject: string): boolean {
      return table.has(subject);
    },
    subjects(): Iterable<string> {
      return table.keys();
    },
    snapshot(subject: string): QuoteState | undefined {
      const state = table.get(subject)?.state;
      return state === undefined ? undefined : cloneState(state);
    },
    snapshotMany(subjects: readonly string[]): Map<string, QuoteState> {
      const out = new Map<string, QuoteState>();
      for (const subject of subjects) {
        const state = table.get(subject)?.state;
        if (state !== undefined) out.set(subject, cloneState(state));
      }
      return out;
    },
    subscribe(listener: PlantListener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    eodView,
    stats(): PlantStats {
      return {
        updatesApplied: stats.applied,
        updatesDroppedStaleSeq: stats.dropped,
        publishLatencyP99Ms: p99(),
        subjects: table.size,
      };
    },
    forceResync(subjects?: string[]): void {
      const wanted = subjects ?? [...table.keys()];
      for (const subject of wanted) {
        const entry = table.get(subject);
        if (entry === undefined) continue;
        const ids = Object.keys(entry.state.fields);
        notify({
          subject,
          seq: entry.state.seq,
          changed: ids.length === 0 ? emptyMask() : maskOf(ids),
          queued: false,
          resync: true,
        });
      }
    },

    sweep(nowMs?: number): StalenessTransition[] {
      return sweeper.sweep(nowMs ?? clock.now());
    },
    nextStalenessMs(nowMs?: number): number {
      return sweeper.nextDueMs(nowMs ?? clock.now());
    },
    async flushStore(): Promise<void> {
      if (store === undefined) return;
      await store.flush();
    },
    queuedAfter(subject: string, afterSeq: number): QuoteState[] {
      const entry = table.get(subject);
      if (entry === undefined) return [];
      return entry.queue.filter((state) => state.seq > afterSeq);
    },
    captureEod(subject: string, sessionDate: string, closeTsMs: number): EodView | null {
      const entry = table.get(subject);
      if (entry === undefined) return null;
      const view = buildEodSnapshot(entry.state, sessionDate, closeTsMs);
      entry.eod = view;
      if (store !== undefined && entry.state.instrumentId > 0) {
        store.writeEodSnapshot(entry.state.instrumentId, view, entry.state.prov.provenanceId);
      }
      return view;
    },
    async loadEod(subject: string): Promise<EodView | null> {
      const entry = table.get(subject);
      if (entry === undefined || store === undefined) return null;
      if (entry.state.instrumentId <= 0) return null;
      const view = await store.readEod(entry.state.instrumentId);
      if (view !== null) entry.eod = view;
      return view;
    },
    warmSkipped(): readonly WarmSkip[] {
      return skipped;
    },
  };
}

/** The ISO date one day before `date`, through `core/calendars`' own epoch-day arithmetic. */
function previousDate(date: string): string {
  return fromEpochDay(toEpochDay(date) - 1);
}
