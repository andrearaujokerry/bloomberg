/**
 * `functions/shared/returns.ts` — the period statistics DES, WEI and the HP summary all show
 * (FUNCTIONS_TIER1.md §0.6, ANAL-07).
 *
 * Three decisions are worth stating up front, because every screen that calls this inherits them.
 *
 * **1. Units are percent.** `RET_1D`, `RET_1W`, `RET_1M`, `RET_YTD`, `RET_1Y` and `VOL_30D` are
 * `unit: 'pct'` in `core/fields/dictionary.ts`, whose derivations spell out `× 100`
 * (`CHG_PCT_1D = (PX_LAST − PX_CLOSE_1D) / PX_CLOSE_1D × 100`), and `core/fields/format.ts`
 * renders a `pct` cell by appending `%` to the number as given. A fraction in a `pct` cell prints
 * a 41 % year as `0.41%`. So a return leaves this module as `(close(t)/close(t₋) − 1) × 100`.
 * `BETA_1Y` is `unit: 'ratio'` and leaves as a plain multiple.
 *
 * **2. A session is a calendar day the venue was open.** §0.6 fixes the join
 * `instruments.primary_listing_id → listings.mic → exchanges.calendar_id`, with `'FX_USD'` for fx
 * and `'WEEKEND'` for crypto, and it fixes what happens when that join produces nothing: the
 * figure is `null` with an `unavailable` entry and the `NO_CALENDAR_FOR_VENUE` footer code. It is
 * **never** computed on raw calendar days instead. That rule is why {@link periodReturns} takes a
 * `Calendar | null` rather than deriving sessions from whichever days happen to carry a bar: "the
 * last session ≤ t − 7 days" is a statement about the venue's trading calendar, and a bar file
 * with a gap in it cannot answer it. Given `null`, every figure here degrades — not just the five
 * returns — because `high52w` over "the 252 sessions ending at the last completed session" and
 * `avgVolume30d` over "the last 30 sessions" are the same claim about the same calendar.
 *
 * **3. The conventions travel with the numbers.** `Conventions` is echoed on the result and the
 * `stats` engine entry (name, version, `inputsHash`) is there to be pushed into `meta.engines`
 * (ANAL-08), so a number on a screen today can be recomputed from its inputs years from now.
 *
 * Nothing here fabricates: a window the loaded history does not cover yields `null` plus the
 * reason, which is what the runner's payload-honesty check wants to find in `meta`.
 */

import {
  addDays,
  addMonths,
  addYears,
  compareDates,
  type Calendar,
  type IsoDate,
} from '@terminal/core/calendars/calendar';
import { inputsHashOf, type Conventions } from '@terminal/core/analytics/engine';
import { simpleReturns, volatility, beta as betaOf } from '@terminal/core/analytics/stats/index';
import type { AssetClass, PayloadEngine, PayloadUnavailable } from '@terminal/core';
import { eq } from 'drizzle-orm';

import { exchanges } from '../../db/schema/calendars.js';
import type { InstrumentDetail } from '../../data/reference.js';
import type { ResolveContext } from '../context.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Conventions (ANAL-07, §0.6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * §0.6 verbatim. `core/analytics/stats` carries a richer `StatsConventions`; this is the smaller
 * set §0.6 names and the one a screen footer prints.
 */
export interface PeriodReturnsConventions extends Conventions {
  readonly returns: 'simple';
  readonly priceBasis: 'close';
  readonly adjust: 'price';
  readonly annualisation: 252;
  readonly volWindow: 30;
  readonly betaBenchmark: 'SPX Index';
  readonly betaWindow: 252;
}

export const PERIOD_RETURNS_CONVENTIONS: PeriodReturnsConventions = Object.freeze({
  returns: 'simple',
  priceBasis: 'close',
  adjust: 'price',
  annualisation: 252,
  volWindow: 30,
  betaBenchmark: 'SPX Index',
  betaWindow: 252,
} as const);

/** The `stats` engine identity §0.6 pins for these figures. */
export const STATS_ENGINE = Object.freeze({ name: 'stats', version: '1.0.0' } as const);

/** Sessions in the 52-week high/low window and the beta window. */
export const WINDOW_52W = 252;
/** Sessions in the average-volume and volatility windows. */
export const WINDOW_30D = 30;
/** §0.6: beta needs this many overlapping sessions or it is `NOT_APPLICABLE`. */
export const BETA_MIN_SESSIONS = 200;

/** The footer code §0.6 requires when the venue's calendar cannot be resolved. */
export const NO_CALENDAR_FOR_VENUE = 'NO_CALENDAR_FOR_VENUE';

/**
 * The footer code for a window with sessions the loaded history has no bar for.
 *
 * It is a statement about the *history*, not about any one figure: the figures a gap actually
 * invalidates say so through their own `unavailable` entries. This is what tells a reader that the
 * 252-session window behind a 52-week high is not 252 observations.
 */
export const HISTORY_GAPS = 'HISTORY_GAPS';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One daily bar, as `ctx.data.historical.bars` returns it under `adjust: 'price'`. `close` is the
 * only required figure; `high`/`low`/`volume` may be absent for a venue that does not publish
 * them, and each absence narrows exactly the figures that need it.
 */
export interface PeriodBar {
  readonly date: IsoDate;
  readonly close: number | null;
  readonly high?: number | null;
  readonly low?: number | null;
  readonly volume?: number | null;
}

/** The nine figures §0.6 names. Percent for the returns and the volatility, price for the highs. */
export interface PeriodReturnValues {
  ret1d: number | null;
  ret1w: number | null;
  ret1m: number | null;
  retYtd: number | null;
  ret1y: number | null;
  high52w: number | null;
  low52w: number | null;
  avgVolume30d: number | null;
  vol30d: number | null;
}

/**
 * The figures plus everything the caller has to put in `meta`: the `unavailable` entries for the
 * nulls (§1.3 rule 6), the footer codes, the echoed conventions and the engine entry (ANAL-08).
 */
export interface PeriodReturnsResult extends PeriodReturnValues {
  /** The last completed session used as `t`, `null` when there is none. */
  readonly asOfSession: IsoDate | null;
  /**
   * Sessions in the analysed window: business days of the venue's calendar from the first usable
   * bar through the last one, *including* those the loaded history has no bar for.
   */
  readonly sessions: number;
  /** Sessions inside that window with no bar — the gaps the `HISTORY_GAPS` footer code names. */
  readonly holes: number;
  readonly conventions: PeriodReturnsConventions;
  readonly engine: PayloadEngine;
  readonly unavailable: readonly PayloadUnavailable[];
  readonly footerCodes: readonly string[];
}

/** The dictionary field each figure is published as, used for its `meta.unavailable` entry. */
const FIELD_OF: Readonly<Record<keyof PeriodReturnValues, string>> = Object.freeze({
  ret1d: 'RET_1D',
  ret1w: 'RET_1W',
  ret1m: 'RET_1M',
  retYtd: 'RET_YTD',
  ret1y: 'RET_1Y',
  high52w: 'PX_HIGH_52W',
  low52w: 'PX_LOW_52W',
  avgVolume30d: 'VOLUME_AVG_30D',
  vol30d: 'VOL_30D',
});

const FIGURES = Object.keys(FIELD_OF) as (keyof PeriodReturnValues)[];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// periodReturns
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The §0.6 period statistics over a daily bar series.
 *
 * `bars` need not be sorted and may run past `asOfDate`; what is kept is every bar on or before
 * `asOfDate` that falls on a **business day of `calendar`** and carries a usable close. That
 * filter is the calendar doing its job: a bar stamped on Thanksgiving is not a session, and
 * counting it would shift every session-indexed window by one.
 *
 * Window definitions, from §0.3 and §0.6:
 *
 *  - `ret1d` — `t` against the previous session.
 *  - `ret1w` / `ret1m` / `ret1y` — `t` against the last session on or before `t − 7 calendar days`
 *    / `t − 1 month` (day-of-month clamped) / `t − 1 year`.
 *  - `retYtd` — `t` against the last session of the previous calendar year.
 *  - `high52w` / `low52w` — max `high` / min `low` over the 252 sessions ending at `t`.
 *  - `avgVolume30d` — mean `volume` over the last 30 sessions **that traded** (volume > 0);
 *    a session with no trading is excluded, not counted as a zero.
 *  - `vol30d` — stdev of the last 30 daily simple returns × √252 × 100, so 31 sessions are needed.
 *
 * @param calendar the venue's calendar, or `null` when the §0.6 join produced none — in which case
 *   every figure is `null` with `NO_SOURCE` and the `NO_CALENDAR_FOR_VENUE` footer code.
 * @param venueLabel what to name in the `no calendar seeded for <mic>` detail; the mic when there
 *   is one, else a description of why there is no mic.
 */
export function periodReturns(
  bars: readonly PeriodBar[],
  calendar: Calendar | null,
  asOfDate: IsoDate,
  venueLabel = 'this venue',
): PeriodReturnsResult {
  const unavailable: PayloadUnavailable[] = [];
  const footerCodes: string[] = [];

  const engine: PayloadEngine = {
    ...STATS_ENGINE,
    inputsHash: inputsHashOf({
      asOfDate,
      calendarId: calendar?.id ?? null,
      conventions: PERIOD_RETURNS_CONVENTIONS,
      bars: bars.map((b) => [b.date, b.close, b.high ?? null, b.low ?? null, b.volume ?? null]),
    }),
  };

  if (calendar === null) {
    const detail = `no calendar seeded for ${venueLabel}`;
    for (const figure of FIGURES) {
      unavailable.push({ field: FIELD_OF[figure], reason: 'NO_SOURCE', detail });
    }
    footerCodes.push(NO_CALENDAR_FOR_VENUE);
    return {
      ...blankValues(),
      asOfSession: null,
      sessions: 0,
      holes: 0,
      conventions: PERIOD_RETURNS_CONVENTIONS,
      engine,
      unavailable,
      footerCodes,
    };
  }

  const slots = toSlots(bars, calendar, asOfDate);
  const values = blankValues();
  const note = (figure: keyof PeriodReturnValues, detail: string): void => {
    unavailable.push({ field: FIELD_OF[figure], reason: 'NO_SOURCE', detail });
  };

  const lastIdx = slots.length - 1;
  const last = slots[lastIdx]?.bar ?? null;
  if (last === null) {
    for (const figure of FIGURES) {
      note(figure, `no session on or before ${asOfDate} in the loaded history`);
    }
    return {
      ...values,
      asOfSession: null,
      sessions: 0,
      holes: 0,
      conventions: PERIOD_RETURNS_CONVENTIONS,
      engine,
      unavailable,
      footerCodes,
    };
  }

  const t = last.date;
  const holes = slots.reduce((n, slot) => (slot.bar === null ? n + 1 : n), 0);
  if (holes > 0) footerCodes.push(HISTORY_GAPS);

  // ── the five period returns ────────────────────────────────────────────────────────────────
  // `ret1d` is `t` against **the previous session**, not against the previous bar. When that
  // session carries no bar the one-day return does not exist, and saying so is the difference
  // between "no figure" and a figure silently measured over two days or five.
  const priorSlot = slots[lastIdx - 1];
  if (priorSlot === undefined) {
    note('ret1d', `only one session on or before ${t} in the loaded history`);
  } else if (priorSlot.bar === null) {
    note('ret1d', `the session before ${t} (${priorSlot.date}) carries no bar`);
  } else {
    values.ret1d = pctChange(priorSlot.bar.close, last.close);
  }

  const windows: readonly [keyof PeriodReturnValues, IsoDate, string][] = [
    ['ret1w', addDays(t, -7), '7 calendar days'],
    ['ret1m', addMonths(t, -1), '1 month'],
    ['ret1y', addYears(t, -1), '1 year'],
    ['retYtd', `${String(Number(t.slice(0, 4)) - 1)}-12-31`, 'the previous calendar year'],
  ];
  for (const [figure, target, label] of windows) {
    const base = lastOnOrBefore(slots, target);
    if (base === undefined) {
      note(figure, `no session on or before ${target} (${label} before ${t}) in the loaded history`);
      continue;
    }
    values[figure] = pctChange(base.close, last.close);
  }

  // ── 52-week high and low, over the 252 SESSIONS ending at t ────────────────────────────────
  const window52w = slots.slice(Math.max(0, slots.length - WINDOW_52W));
  const highs = window52w.map((s) => s.bar?.high ?? null).filter(isNum);
  const lows = window52w.map((s) => s.bar?.low ?? null).filter(isNum);
  if (highs.length === 0) {
    note('high52w', `no daily high in the ${String(window52w.length)} sessions ending ${t}`);
  } else {
    values.high52w = Math.max(...highs);
  }
  if (lows.length === 0) {
    note('low52w', `no daily low in the ${String(window52w.length)} sessions ending ${t}`);
  } else {
    values.low52w = Math.min(...lows);
  }

  // ── average volume over the last 30 SESSIONS that traded ───────────────────────────────────
  // The window is thirty slots; a slot whose bar is missing is a session whose volume is unknown,
  // and a slot whose volume is zero is a session that did not trade. Neither is averaged in, and
  // neither reaches further back to find a thirtieth number.
  const window30d = slots.slice(Math.max(0, slots.length - WINDOW_30D));
  const traded = window30d
    .map((s) => s.bar?.volume ?? null)
    .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
  if (traded.length === 0) {
    note(
      'avgVolume30d',
      `no session with traded volume in the ${String(window30d.length)} sessions ending ${t}`,
    );
  } else {
    values.avgVolume30d = traded.reduce((a, b) => a + b, 0) / traded.length;
  }

  // ── 30-day realised volatility, over 31 CONSECUTIVE sessions ───────────────────────────────
  // Thirty daily returns need thirty-one consecutive sessions, all with a close. A hole makes one
  // of those "daily" returns span two sessions or more, which is a different statistic wearing the
  // same label, so the window is refused rather than quietly stretched.
  const volStart = slots.length - (WINDOW_30D + 1);
  if (volStart < 0) {
    note(
      'vol30d',
      `${String(slots.length)} sessions on or before ${t}; ${String(WINDOW_30D + 1)} are needed ` +
        `for ${String(WINDOW_30D)} daily returns`,
    );
  } else {
    const window = slots.slice(volStart);
    const gaps = window.filter((s) => s.bar === null);
    if (gaps.length > 0) {
      note(
        'vol30d',
        `${String(gaps.length)} of the ${String(WINDOW_30D + 1)} sessions ending ${t} carry no ` +
          `bar (first ${gaps[0]!.date}); ${String(WINDOW_30D)} consecutive daily returns are needed`,
      );
    } else {
      const closes = window.map((s) => s.bar!.close);
      const rets = simpleReturns(closes, PERIOD_RETURNS_CONVENTIONS);
      values.vol30d = volatility(rets.values, PERIOD_RETURNS_CONVENTIONS).volAnnualised * 100;
    }
  }

  return {
    ...values,
    asOfSession: t,
    sessions: slots.length,
    holes,
    conventions: PERIOD_RETURNS_CONVENTIONS,
    engine,
    unavailable,
    footerCodes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// beta1y
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface Beta1yResult {
  /** The OLS slope, or `null` when §0.6's 200-session floor is not met. */
  readonly beta1y: number | null;
  /** Overlapping daily returns the regression saw. */
  readonly overlap: number;
  readonly conventions: PeriodReturnsConventions;
  readonly engine: PayloadEngine;
  readonly unavailable: readonly PayloadUnavailable[];
}

/**
 * §0.6's `beta1y`: the OLS slope of the instrument's 252 daily returns on the benchmark's, over
 * the sessions **both** series cover.
 *
 * The 200-session floor is a statement about honesty, not about numerics: `cov/var` over thirty
 * overlapping days is arithmetically fine and financially meaningless, and a screen that prints it
 * next to a 252-session beta invites the comparison. Below the floor the answer is `null` with
 * `NOT_APPLICABLE` and the count, so the user can see *why* rather than see nothing.
 *
 * A benchmark with zero variance over the window (a constant series) is also `NOT_APPLICABLE`:
 * beta against something that never moves is undefined, not zero.
 */
export function beta1y(
  bars: readonly PeriodBar[],
  benchmarkBars: readonly PeriodBar[],
  calendar: Calendar | null,
  asOfDate: IsoDate,
  venueLabel = 'this venue',
): Beta1yResult {
  const unavailable: PayloadUnavailable[] = [];
  const engine: PayloadEngine = {
    ...STATS_ENGINE,
    inputsHash: inputsHashOf({
      asOfDate,
      calendarId: calendar?.id ?? null,
      conventions: PERIOD_RETURNS_CONVENTIONS,
      asset: bars.map((b) => [b.date, b.close]),
      benchmark: benchmarkBars.map((b) => [b.date, b.close]),
    }),
  };
  const blank = (reason: PayloadUnavailable['reason'], detail: string): Beta1yResult => {
    unavailable.push({ field: 'BETA_1Y', reason, detail });
    return { beta1y: null, overlap: 0, conventions: PERIOD_RETURNS_CONVENTIONS, engine, unavailable };
  };

  if (calendar === null) return blank('NO_SOURCE', `no calendar seeded for ${venueLabel}`);

  const asset = toSlots(bars, calendar, asOfDate);
  const bench = new Map<IsoDate, number>();
  for (const slot of toSlots(benchmarkBars, calendar, asOfDate)) {
    if (slot.bar !== null) bench.set(slot.date, slot.bar.close);
  }

  // Pairs on the sessions both series carry a bar for, so a benchmark holiday — or a hole in
  // either file — does not shift the asset's returns by one session, a misalignment that quietly
  // biases a beta towards zero.
  const paired: { date: IsoDate; a: number; b: number }[] = [];
  for (const slot of asset) {
    if (slot.bar === null) continue;
    const b = bench.get(slot.date);
    if (b !== undefined) paired.push({ date: slot.date, a: slot.bar.close, b });
  }
  const window = paired.slice(Math.max(0, paired.length - (WINDOW_52W + 1)));
  const overlap = Math.max(0, window.length - 1);

  if (overlap < BETA_MIN_SESSIONS) {
    unavailable.push({
      field: 'BETA_1Y',
      reason: 'NOT_APPLICABLE',
      detail: 'fewer than 200 overlapping sessions',
    });
    return { beta1y: null, overlap, conventions: PERIOD_RETURNS_CONVENTIONS, engine, unavailable };
  }

  const assetRets = simpleReturns(
    window.map((p) => p.a),
    PERIOD_RETURNS_CONVENTIONS,
  ).values;
  const benchRets = simpleReturns(
    window.map((p) => p.b),
    PERIOD_RETURNS_CONVENTIONS,
  ).values;
  let result: number;
  try {
    result = betaOf(assetRets, benchRets, PERIOD_RETURNS_CONVENTIONS).beta;
  } catch {
    unavailable.push({
      field: 'BETA_1Y',
      reason: 'NOT_APPLICABLE',
      detail: `${PERIOD_RETURNS_CONVENTIONS.betaBenchmark} did not move over the ${String(overlap)} overlapping sessions`,
    });
    return { beta1y: null, overlap, conventions: PERIOD_RETURNS_CONVENTIONS, engine, unavailable };
  }
  return { beta1y: result, overlap, conventions: PERIOD_RETURNS_CONVENTIONS, engine, unavailable };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Pushing the result into meta
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Copy a result's `unavailable` entries and engine into `ctx` — the `meta` half of §1.3 rule 6 and
 * of ANAL-08. Every caller does the same three lines, and one that forgets serves a null the
 * runner's payload-honesty check will reject.
 *
 * @returns the footer codes to merge into `footer.codes`.
 */
export function recordPeriodMeta(
  ctx: Pick<ResolveContext, 'unavailable' | 'engines'>,
  result: { unavailable: readonly PayloadUnavailable[]; engine: PayloadEngine; footerCodes?: readonly string[] },
): readonly string[] {
  for (const note of result.unavailable) ctx.unavailable.add(note);
  ctx.engines.add(result.engine);
  return result.footerCodes ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The venue's calendar (§0.6's join)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What {@link venueCalendar} resolved, and what to say when it resolved nothing. */
export interface VenueCalendar {
  /** `listings.mic` of the primary listing, `null` for a wedge with no listing. */
  readonly mic: string | null;
  /** `exchanges.calendar_id`, `'FX_USD'`, `'WEEKEND'`, or `null` when there is none. */
  readonly calendarId: string | null;
  readonly calendar: Calendar | null;
  /** What to name in `no calendar seeded for <label>`. */
  readonly label: string;
}

/**
 * `instruments.primary_listing_id → listings.mic` — the first leg of §0.6's join, pure.
 *
 * Falls back to the listing flagged `isPrimary` when the instrument carries no
 * `primary_listing_id`, which is the same venue by a different route and is what a partially
 * loaded master looks like.
 */
export function primaryMic(detail: InstrumentDetail): string | null {
  const id = detail.instrument.primaryListingId;
  const byId = id === undefined ? undefined : detail.listings.find((l) => l.listingId === id);
  const listing = byId ?? detail.listings.find((l) => l.isPrimary);
  return listing?.mic ?? null;
}

/**
 * The calendar id §0.6 assigns an asset class, before any database is consulted.
 *
 * `fx` and `crypto` are fixed by the spec — a currency pair trades on `FX_USD`'s business days and
 * a coin trades every day, and neither has a listing to join through. Everything else has to go
 * through the venue, and `null` here means "ask the database".
 */
export function fixedCalendarId(assetClass: AssetClass): string | null {
  if (assetClass === 'fx') return 'FX_USD';
  if (assetClass === 'crypto') return 'WEEKEND';
  return null;
}

/**
 * §0.6's join, end to end: asset class → mic → `exchanges.calendar_id` → the materialised
 * `Calendar`.
 *
 * Every leg may come up empty and each one degrades the same way — `calendar: null`, and a label
 * that says which leg failed, so the `unavailable` detail names the venue rather than repeating
 * "no calendar". The read is one indexed `SELECT` on `exchanges` through `ctx.db` (the request
 * transaction); the materialisation goes through `ctx.data.reference.calendar`, whose repository
 * caches per request, so ten instruments on one exchange read the holiday table once.
 */
export async function venueCalendar(
  ctx: Pick<ResolveContext, 'db' | 'data'>,
  detail: InstrumentDetail,
): Promise<VenueCalendar> {
  const assetClass = detail.instrument.assetClass;
  const mic = primaryMic(detail);

  const fixed = fixedCalendarId(assetClass);
  if (fixed !== null) return load(ctx, mic, fixed, fixed);

  if (mic === null) {
    return { mic: null, calendarId: null, calendar: null, label: `${assetClass} with no primary listing` };
  }

  const rows = await ctx.db
    .select({ calendarId: exchanges.calendarId })
    .from(exchanges)
    .where(eq(exchanges.mic, mic))
    .limit(1);
  const calendarId = rows[0]?.calendarId ?? null;
  if (calendarId === null || calendarId.trim() === '') {
    return { mic, calendarId: null, calendar: null, label: mic };
  }
  return load(ctx, mic, calendarId, mic);
}

async function load(
  ctx: Pick<ResolveContext, 'data'>,
  mic: string | null,
  calendarId: string,
  label: string,
): Promise<VenueCalendar> {
  try {
    return { mic, calendarId, calendar: await ctx.data.reference.calendar(calendarId), label };
  } catch {
    // `reference.calendar` throws when the calendar was never materialised. That is a seed gap,
    // not a request failure: §0.6 says degrade, so the screen loses its returns and keeps the rest.
    return { mic, calendarId, calendar: null, label };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Session {
  readonly date: IsoDate;
  readonly close: number;
  readonly high: number | null;
  readonly low: number | null;
  readonly volume: number | null;
}

function blankValues(): PeriodReturnValues {
  return {
    ret1d: null,
    ret1w: null,
    ret1m: null,
    retYtd: null,
    ret1y: null,
    high52w: null,
    low52w: null,
    avgVolume30d: null,
    vol30d: null,
  };
}

/**
 * One slot of the analysed window: a session the venue's calendar says happened, and the bar that
 * covers it — or `null` when the loaded history has none.
 *
 * The distinction is the whole point of {@link toSlots}. A window of "the last 30 sessions" that
 * is built out of bars is really "the last 30 bars that landed on a business day", and a gap in
 * the bar file then *widens* the window backwards in time instead of shortening it: thirty bars
 * with five missing reach back thirty-five sessions and the volatility is computed over a longer
 * span than the one the field claims. Enumerating from the calendar makes a missing bar a hole in
 * a fixed-length window, which is what it is.
 */
interface Slot {
  readonly date: IsoDate;
  readonly bar: Session | null;
}

/**
 * The analysed window: every business day of `calendar` from the first usable bar through
 * `asOfDate`, each paired with its bar, truncated at the last session that has one.
 *
 * A bar is usable when it carries a strictly positive finite close (a return needs one, and a zero
 * or negative "price" is bad data, not a data point) and falls on a business day — a bar stamped
 * on Thanksgiving is not a session, and counting it would shift every session-indexed window by
 * one. The last bar for a date wins, which is how a corrected close arrives.
 *
 * Trailing holes are dropped rather than analysed: `t` is "the last completed session" the data
 * reaches, and a venue that has traded since the last capture is a staleness statement the caller
 * already makes from the quote. Holes *inside* the window are kept and counted.
 */
function toSlots(
  bars: readonly PeriodBar[],
  calendar: Calendar,
  asOfDate: IsoDate,
): readonly Slot[] {
  const byDate = new Map<IsoDate, Session>();
  for (const bar of bars) {
    if (compareDates(bar.date, asOfDate) > 0) continue;
    if (!calendar.isBusinessDay(bar.date)) continue;
    const close = bar.close;
    if (close === null || !Number.isFinite(close) || close <= 0) continue;
    byDate.set(bar.date, {
      date: bar.date,
      close,
      high: finiteOrNull(bar.high),
      low: finiteOrNull(bar.low),
      volume: finiteOrNull(bar.volume),
    });
  }
  if (byDate.size === 0) return [];

  const dates = [...byDate.keys()].sort(compareDates);
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;

  const slots: Slot[] = [];
  for (let d = first; compareDates(d, last) <= 0; d = addDays(d, 1)) {
    if (!calendar.isBusinessDay(d)) continue;
    slots.push({ date: d, bar: byDate.get(d) ?? null });
  }
  return slots;
}

/** The last slot carrying a bar on or before `date`, by binary search over the ascending list. */
function lastOnOrBefore(slots: readonly Slot[], date: IsoDate): Session | undefined {
  let lo = 0;
  let hi = slots.length - 1;
  let found: Session | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = slots[mid];
    if (s === undefined) break;
    if (compareDates(s.date, date) <= 0) {
      if (s.bar !== null) found = s.bar;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // The search keeps the latest slot ≤ `date` that actually carries a bar, so a hole at the end of
  // the range resolves to the nearest earlier session with data rather than to nothing.
  return found;
}



/** `(to/from − 1) × 100` — percent, per the dictionary's `pct` unit. */
function pctChange(from: number, to: number): number {
  return (to / from - 1) * 100;
}

function finiteOrNull(v: number | null | undefined): number | null {
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

function isNum(v: number | null): v is number {
  return v !== null && Number.isFinite(v);
}
