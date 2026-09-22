/**
 * The deterministic simulated feed — PROVIDERS.a §4.3 (L568-614), §4.4 (L615-631).
 *
 * A market that ticks, with no network and no fixtures. It emits the identical `NormalisedUpdate`
 * every real normaliser emits, so the plant, the compositor, the conflator and the wire encoder
 * are all exercised unmodified — and, because every draw comes from a per-subject `xoshiro128**`
 * stream and every instant comes from the injected `Clock`, two runs of one seed produce the same
 * update stream, field for field.
 *
 * ```ts
 * const clock = new VirtualClock(TEST_NOW);
 * const feed  = new SimFeed({ seed: 7, startMs: TEST_NOW, rateHz: 50, subjects }, { clock, plant, provenanceId });
 * feed.start();
 * for (let i = 0; i < 100; i += 1) { clock.advance(20); feed.pump(); }
 * ```
 *
 * **Why `pump()` and not a timer.** The system's `Clock` (`@terminal/core`) is `{ now(): number }`
 * — it has no `setTimeout`, and `VirtualClock` has no timer queue, so a feed that armed its own
 * timers would either read the platform clock (destroying determinism) or invent a scheduler the
 * rest of the system does not have. Instead the feed is a pull: `pump()` emits every tick whose
 * scheduled instant has passed, catching up if the caller jumped an hour. A host that wants it to
 * run by itself — `npm run dev` with `SIM_FEED=1` — injects a {@link SimTimer}, which is the one
 * place the platform timer appears and is supplied by the composition root, never by this module.
 *
 * **Provenance.** `provenanceId` is a single real `provenance` row inserted at start-up with
 * `source_id 'internal.derived'`, `request_key 'sim:<seed>:<startMs>'`, `adapter_version
 * 'sim/1.0.0'`, `http_status 0`, `bytes 0` (§4.3). `internal.derived` is already a registered
 * `licence_registry` source, so `assert_source_known` is satisfied and every simulated number is
 * visibly simulated in the `Ctrl+I` panel. {@link SIM_PROVENANCE} builds the request key.
 *
 * This module never throws: a subject with an unusable price, an unknown calendar or a zero rate
 * is reported through {@link SimFeed.problems} and skipped.
 */

import { dayOfWeek, getCalendar, type Calendar } from '@terminal/core/calendars/calendar';

import { dtYears, quoteAround, quoteSize, roundToTick, stepPrice, tradeSize } from './paths.js';
import { gaussianStream, subjectRng } from './prng.js';

import type { AssetClass, Clock, NormalisedUpdate, SessionState, Tier } from '@terminal/core';
import type { NormaliseProblem } from '../types.js';

// The three US equity calendars register themselves on import. Without this the default session
// resolver cannot answer for `XNYS`, which is the calendar every sim subject uses by default.
import '@terminal/core/calendars/nyse';

/** `licence_registry.source_id` every simulated tick is stamped with (§4.3). */
export const SIM_SOURCE_ID = 'internal.derived';

/** `provenance.adapter_version` for the simulated feed. */
export const SIM_ADAPTER_VERSION = 'sim/1.0.0';

/** `provenance.request_key` for a run — `sim:<seed>:<startMs>` (§4.3). */
export function simRequestKey(seed: number, startMs: number): string {
  return `sim:${String(seed)}:${String(startMs)}`;
}

/** The provenance row a host inserts before starting the feed. */
export const SIM_PROVENANCE = {
  sourceId: SIM_SOURCE_ID,
  adapterVersion: SIM_ADAPTER_VERSION,
  httpStatus: 0,
  bytes: 0,
  requestKey: simRequestKey,
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SimSubject {
  /** `'q:42'` — the plant's subject key. */
  subject: string;
  instrumentId: number;
  mdLineId: number;
  assetClass: AssetClass;
  /** Tier stamped on every update from this subject. `'delayed'` in §4.3's example. */
  tier: Tier;
  /** Price at `startMs`. */
  px0: number;
  /** Annualised volatility in **percent** — `22` is 22 %. */
  annualVolPct: number;
  /** Quoted spread in basis points of the mid. */
  spreadBp: number;
  /** Mean trade size; each print is `avgTradeSize · (0.25 + 1.5 · u)` (§4.3 step 3). */
  avgTradeSize: number;
  /** `calendars.calendar_id` — `'XNYS'` for a US listing. Drives `session`. */
  calendarId: string;
  /** Minimum price increment. Default `0.01`. */
  tickSize?: number;
}

/** Resolves the session of a calendar at an instant. Injected so a test can pin it. */
export type SessionResolver = (atMs: number, calendarId: string) => SessionState;

export interface SimFeedConfig {
  /** The whole run's identity. Two runs of one seed are identical. */
  seed: number;
  /** Virtual wall time at t0 — normally `clock.now()` at construction. */
  startMs: number;
  /** Updates per second per subject. Default `1`; the WS tests use `50`. */
  rateHz?: number;
  subjects: readonly SimSubject[];
  /** Default {@link calendarSessionResolver}. */
  sessionOf?: SessionResolver;
}

/** What the feed needs from the plant: exactly `plant.apply` (ARCHITECTURE §6). */
export interface SimPlant {
  apply(update: NormalisedUpdate): void;
}

/**
 * A repeating timer, for a host that wants the feed to run on its own. The composition root owns
 * the platform timer; this module only calls what it is handed.
 */
export interface SimTimer {
  schedule(fn: () => void, everyMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface SimFeedDeps {
  clock: Clock;
  plant: SimPlant;
  /** The `provenance.provenance_id` of the run's single row. */
  provenanceId: number;
  timer?: SimTimer;
}

/** One subject's live state — what the next tick is computed from. */
export interface SimSubjectState {
  readonly subject: string;
  readonly px: number;
  readonly bid: number;
  readonly ask: number;
  readonly cumulativeVolume: number;
  readonly ticks: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────────────────────

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(tz: string): Intl.DateTimeFormat | null {
  const cached = zoneFormatters.get(tz);
  if (cached !== undefined) return cached;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    zoneFormatters.set(tz, formatter);
    return formatter;
  } catch {
    return null;
  }
}

/** `HH:MM` → minutes after local midnight, or `null`. */
function minutesOf(time: string | null | undefined): number | null {
  if (typeof time !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(time);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  return hours * 60 + minutes;
}

/**
 * The session a calendar is in at an instant, from its `calendar_sessions` template, its holidays
 * and its early closes — so a sim run crossing 16:00 ET really does transition `open → closed` and
 * exercises the `closed` branch of `valueState` (§4.3 step 4).
 *
 * @param lookup how a `calendar_id` becomes a `Calendar`; the default is the process-wide registry
 * of `@terminal/core`, which the rule calendars populate on import.
 */
export function calendarSessionResolver(
  lookup: (calendarId: string) => Calendar | null = defaultCalendarLookup,
): SessionResolver {
  const cache = new Map<string, Calendar | null>();
  return (atMs: number, calendarId: string): SessionState => {
    if (!Number.isFinite(atMs)) return 'unknown';
    let calendar = cache.get(calendarId);
    if (calendar === undefined) {
      calendar = lookup(calendarId);
      cache.set(calendarId, calendar);
    }
    if (calendar === null) return 'unknown';

    const formatter = zoneFormatter(calendar.tz);
    if (formatter === null) return 'unknown';

    let parts: Intl.DateTimeFormatPart[];
    try {
      parts = formatter.formatToParts(new Date(atMs));
    } catch {
      return 'unknown';
    }
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    const day = `${get('year')}-${get('month')}-${get('day')}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'unknown';
    const minute = Number(get('hour')) * 60 + Number(get('minute'));
    if (!Number.isFinite(minute)) return 'unknown';

    if (!calendar.isBusinessDay(day)) return 'closed';

    const weekday = dayOfWeek(day);
    const template = calendar.sessions().find((s) => s.weekday === weekday);
    if (template === undefined) return 'closed';

    const open = minutesOf(template.openTime);
    if (open === null) return 'closed';
    const early = calendar.earlyClose(day);
    const close = minutesOf(early?.closeTime ?? template.closeTime) ?? open;
    const preOpen = minutesOf(template.preOpen) ?? open;
    const postClose = minutesOf(template.postClose) ?? close;

    if (minute < preOpen) return 'closed';
    if (minute < open) return 'pre';
    if (minute < close) return 'open';
    if (minute < postClose) return 'post';
    return 'closed';
  };
}

function defaultCalendarLookup(calendarId: string): Calendar | null {
  try {
    return getCalendar(calendarId);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The feed
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface SubjectStream {
  config: SimSubject;
  tickSize: number;
  annualVol: number;
  rng: () => number;
  normal: () => number;
  px: number;
  bid: number;
  ask: number;
  cumulativeVolume: number;
  ticks: number;
}

/** Most ticks one `pump()` will emit per subject, however far the clock jumped. */
export const MAX_CATCH_UP_TICKS = 10_000;

export class SimFeed {
  readonly #config: SimFeedConfig;
  readonly #deps: SimFeedDeps;
  readonly #sessionOf: SessionResolver;
  readonly #streams: SubjectStream[] = [];
  readonly #problems: NormaliseProblem[] = [];
  readonly #intervalMs: number;

  #running = false;
  #handle: unknown = null;
  #emitted = 0;
  /** Ticks already emitted, counted from `startMs`. The next one is due at `startMs + n·interval`. */
  #tickIndex = 0;
  #seq = 0;

  constructor(config: SimFeedConfig, deps: SimFeedDeps) {
    this.#config = config;
    this.#deps = deps;
    this.#sessionOf = config.sessionOf ?? calendarSessionResolver();

    const rateHz = config.rateHz ?? 1;
    this.#intervalMs = Number.isFinite(rateHz) && rateHz > 0 ? 1000 / rateHz : 0;
    if (this.#intervalMs <= 0) {
      this.#problems.push({
        kind: 'out_of_range',
        detail: `rateHz must be a positive number, got ${String(config.rateHz)}`,
      });
    }

    const seen = new Set<string>();
    for (const subject of config.subjects) {
      if (seen.has(subject.subject)) {
        this.#problems.push({
          kind: 'schema_drift',
          detail: `subject ${subject.subject} is declared twice; the second is ignored`,
          path: `/${subject.subject}`,
        });
        continue;
      }
      if (!Number.isFinite(subject.px0) || subject.px0 <= 0) {
        this.#problems.push({
          kind: 'out_of_range',
          detail: `subject ${subject.subject} has px0 ${String(subject.px0)}; it is skipped`,
          path: `/${subject.subject}`,
        });
        continue;
      }
      seen.add(subject.subject);
      // One stream per subject, seeded from the subject's own name: adding a subject to a scenario
      // cannot shift any other subject's path (§4.1).
      const rng = subjectRng(config.seed, subject.subject);
      const tickSize =
        Number.isFinite(subject.tickSize) && (subject.tickSize ?? 0) > 0
          ? (subject.tickSize ?? 0.01)
          : 0.01;
      const px = roundToTick(subject.px0, tickSize);
      const { bid, ask } = quoteAround(px, subject.spreadBp, tickSize);
      this.#streams.push({
        config: subject,
        tickSize,
        annualVol: (Number.isFinite(subject.annualVolPct) ? subject.annualVolPct : 0) / 100,
        rng,
        normal: gaussianStream(rng),
        px,
        bid,
        ask,
        cumulativeVolume: 0,
        ticks: 0,
      });
    }
  }

  /** Updates emitted so far — §4.3's `ticks`. */
  get ticks(): number {
    return this.#emitted;
  }

  /** Configuration defects found at construction; the feed runs on whatever was usable. */
  get problems(): readonly NormaliseProblem[] {
    return this.#problems;
  }

  get running(): boolean {
    return this.#running;
  }

  /** The milliseconds between two ticks of one subject. */
  get intervalMs(): number {
    return this.#intervalMs;
  }

  /**
   * Arm the feed. With a {@link SimTimer} injected it also starts pumping itself; without one the
   * caller drives it with {@link pump}, which is what every test does.
   */
  start(): void {
    if (this.#running || this.#intervalMs <= 0) return;
    this.#running = true;
    const timer = this.#deps.timer;
    if (timer !== undefined) {
      this.#handle = timer.schedule(() => {
        this.pump();
      }, this.#intervalMs);
    }
  }

  /** Stop emitting. Safe to call when never started; the subject paths are left where they are. */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    const timer = this.#deps.timer;
    if (timer !== undefined && this.#handle !== null) {
      timer.cancel(this.#handle);
      this.#handle = null;
    }
  }

  /**
   * Emit every tick whose scheduled instant is at or before `clock.now()`.
   *
   * Catch-up is deliberate: a test that advances the clock by a minute and pumps once gets the
   * whole minute's updates, in tick order, with `ts.src` at each tick's own scheduled instant —
   * so the update stream depends on the seed and the elapsed virtual time, never on how the caller
   * chose to chop that time up.
   *
   * @returns the number of updates applied.
   */
  pump(): number {
    if (!this.#running || this.#intervalMs <= 0) return 0;
    const now = this.#deps.clock.now();
    if (!Number.isFinite(now)) return 0;

    let applied = 0;
    let guard = 0;
    while (guard < MAX_CATCH_UP_TICKS) {
      const dueAt = this.#config.startMs + this.#tickIndex * this.#intervalMs;
      if (dueAt > now) break;
      this.#tickIndex += 1;
      guard += 1;
      applied += this.#emitTick(dueAt, now);
    }
    return applied;
  }

  /** The live state of one subject, or `null` when it is not in the run. */
  state(subject: string): SimSubjectState | null {
    const stream = this.#streams.find((s) => s.config.subject === subject);
    if (stream === undefined) return null;
    return {
      subject,
      px: stream.px,
      bid: stream.bid,
      ask: stream.ask,
      cumulativeVolume: stream.cumulativeVolume,
      ticks: stream.ticks,
    };
  }

  /** Every subject's live state, in the order the subjects were declared. */
  states(): SimSubjectState[] {
    return this.#streams.map((s) => ({
      subject: s.config.subject,
      px: s.px,
      bid: s.bid,
      ask: s.ask,
      cumulativeVolume: s.cumulativeVolume,
      ticks: s.ticks,
    }));
  }

  /**
   * One tick for every subject, in the subjects' declared order (§4.3) — the order is part of the
   * contract, because it fixes the `srcSeq` each update carries.
   */
  #emitTick(dueAt: number, capturedAt: number): number {
    const dt = dtYears(this.#config.rateHz ?? 1);
    let applied = 0;

    for (const stream of this.#streams) {
      // 1. diffuse the mid
      const px = roundToTick(
        stepPrice(stream.px, stream.annualVol, dt, stream.normal()),
        stream.tickSize,
      );
      // 2. the book straddles it
      const { bid, ask } = quoteAround(px, stream.config.spreadBp, stream.tickSize);
      // 3. sizes
      const bidSize = quoteSize(stream.config.avgTradeSize, stream.rng());
      const askSize = quoteSize(stream.config.avgTradeSize, stream.rng());
      const lastSize = tradeSize(stream.config.avgTradeSize, stream.rng());

      stream.px = px;
      stream.bid = bid;
      stream.ask = ask;
      stream.cumulativeVolume += lastSize;
      stream.ticks += 1;

      // 4. the session comes from the calendar at the tick's own instant
      const session = this.#sessionOf(dueAt, stream.config.calendarId);

      // 5. the identical type every real normaliser emits
      this.#seq += 1;
      const update: NormalisedUpdate = {
        subject: stream.config.subject,
        instrumentId: stream.config.instrumentId,
        mdLineId: stream.config.mdLineId,
        assetClass: stream.config.assetClass,
        tier: stream.config.tier,
        fields: {
          PX_LAST: px,
          PX_BID: bid,
          PX_ASK: ask,
          BID_SIZE: bidSize,
          ASK_SIZE: askSize,
          LAST_SIZE: lastSize,
          LAST_TRADE_TIME: dueAt,
          PX_VOLUME: stream.cumulativeVolume,
        },
        // `pub` is set by the plant (FEED-05).
        ts: { src: dueAt, cap: capturedAt, pub: 0 },
        prov: {
          sourceId: SIM_SOURCE_ID,
          provenanceId: this.#deps.provenanceId,
          srcSeq: this.#seq,
        },
        session,
      };

      try {
        this.#deps.plant.apply(update);
      } catch (err) {
        // A plant that rejects one update must not stop the feed: the run would then depend on the
        // plant's failure mode, which is precisely what determinism forbids.
        if (this.#problems.length < 64) {
          this.#problems.push({
            kind: 'parse_error',
            detail: `plant.apply threw for ${stream.config.subject}: ${err instanceof Error ? err.message : String(err)}`,
            path: `/${stream.config.subject}`,
          });
        }
        continue;
      }
      applied += 1;
      this.#emitted += 1;
    }
    return applied;
  }
}

/** A plant sink that only records — what a determinism test compares two runs of. */
export function recordingPlant(): SimPlant & { readonly updates: NormalisedUpdate[] } {
  const updates: NormalisedUpdate[] = [];
  return {
    updates,
    apply(update: NormalisedUpdate): void {
      updates.push(update);
    },
  };
}
