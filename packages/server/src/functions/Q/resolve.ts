/**
 * `functions/Q/resolve.ts` — the composite quote, its lines, its book, its session and its tape
 * (FUNCTIONS_TIER1.md §Q L771-889).
 *
 * Q exists to be distrusted. Every other pricing screen shows a number; this one shows the number
 * **and the arithmetic that produced it** — each market-data line with its own values, its provider
 * sequence number and the three FEED-05 timestamps, next to the composite the plant merged from
 * them. That redundancy is the feature: "which source won PX_LAST" is the question a trader asks
 * when two screens disagree, and a payload that cannot answer it is a payload that has to be
 * believed rather than checked.
 *
 * Three decisions worth stating, because each one had an easier wrong answer:
 *
 *  - **The per-line view comes from `QuoteState.lines`, not from `plant.snapshot('l:<id>')`.**
 *    §Q step 4 writes the latter, and the landed plant has no `l:` subjects at all: `subjects.ts`
 *    parses the family and `LineState` is carried *inside* the composite (`types/quote.ts`), which
 *    is where the plant keeps it (BUS-05). The subject string is still `l:<mdLineId>`, because that
 *    is what the screen registers cells against and what the WS gateway serves.
 *  - **A line is gated by the composite's decision.** `plant.snapshot` runs the composite through
 *    `policyTier.view`, and `lines` rides along untouched. Copying a line's `PX_LAST` into the
 *    payload after the gate blanked the composite's would hand the caller the exact number the
 *    entitlement decision refused — one field, one screen, one leak. Every line cell is therefore
 *    re-gated against the composite's `r` before it is written.
 *  - **`session` is nullable.** §Q types it as always present with a `calendarId: string`. An
 *    instrument whose venue has no seeded calendar has no session window, and §0.6's rule for that
 *    case is a null and a reason, never an invented one.
 */

import type { FieldId, LineState, QuoteFieldId, ValueCell } from '@terminal/core';
import { getField, tickDirCode } from '@terminal/core';
import type {
  QBook,
  QBookLevel,
  QCells,
  QDataQualityFlag,
  QLine,
  QParams,
  QPayload,
  QSession,
  QTapeRow,
  QTimestamps,
} from '@terminal/core/functions/manifests/Q';
import { qFieldIds } from '@terminal/core/functions/manifests/Q';
import { lineTime } from '@terminal/core/quote/merge';
import {
  localClock,
  localTimeToUtc,
  sessionCalendar,
  sessionState as sessionStateAt,
} from '@terminal/core/quote/session';

import type { InstrumentDetail } from '../../data/reference.js';
import type { GatedQuoteState, ReadThroughKind, ResolveContext } from '../context.js';
import { cellFromState, pendingCell } from '../shared/cells.js';
import { toSummary } from '../shared/instrumentSummary.js';
import { venueCalendar } from '../shared/returns.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Read-through (§Q "Data dependencies")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The provider a cold single-security quote may be fetched from, and how stale it may be.
 *
 * §0.4 rule 2 allows a single-security screen one `ensure`; a monitor gets none. `null` means the
 * class has no read-through route, and the screen shows the plant's honest state instead.
 */
function readThroughFor(assetClass: string): { kind: ReadThroughKind; maxAgeMs: number } | null {
  switch (assetClass) {
    case 'equity':
    case 'etf':
    case 'index':
      return { kind: 'cboe.quote', maxAgeMs: 10_000 };
    case 'option':
      return { kind: 'cboe.options', maxAgeMs: 60_000 };
    case 'fx':
      return { kind: 'yahoo.fx', maxAgeMs: 60_000 };
    case 'crypto':
      return { kind: 'coingecko.simple', maxAgeMs: 60_000 };
    case 'rate':
      return { kind: 'nyfed.rates', maxAgeMs: 3_600_000 };
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// BUS-05 (§Q step 8)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The composition rules the plant applied, as the short strings the screen prints.
 *
 * `core/quote/merge.ts` documents these as prose and exports no `describeRules()`; restating them
 * here keeps the screen's footer honest without editing a WP-06 module. Each line names a field
 * group and the rule `mergeComposite` actually implements.
 */
export function describeRules(assetClass: string): string[] {
  const rules = [
    'PX_LAST, LAST_SIZE, LAST_TRADE_TIME: taken together from the freshest line that carries a last price — never mixed across lines',
    'PX_BID, PX_ASK, BID_SIZE, ASK_SIZE: one whole book side from the freshest venue or composite line that publishes one',
    'PX_VOLUME: the largest volume among the lines observing the composite\u2019s session date (every source reports consolidated volume)',
    'PX_HIGH, PX_LOW: the highest high and the lowest low among the lines of that same session date',
    'PX_OPEN, PX_CLOSE_1D, PX_OFFICIAL_CLOSE: the primary line (lowest priority number), falling back down the priority order',
    'IVOL_30D: a Cboe line only — no other v1 source publishes implied volatility',
    'every other field: the freshest line that carries it',
    'CHG_NET_1D, CHG_PCT_1D, TICK_DIR: derived by the plant from the composite, never taken from a line',
    'fieldTs[f] is the line time (source ts, or capture when the source publishes none) of the line that supplied f (FEED-05)',
    'two lines disagreeing on PX_LAST by more than 0.5 % within 60 s raise CROSS_SOURCE_DIVERGENCE (OPS-03); a last price with no prior close raises MISSING_CLOSE',
  ];
  if (assetClass === 'option') {
    rules.push('OPT_*: the Cboe options line only — no other v1 source publishes greeks');
  }
  if (assetClass === 'rate') {
    rules.push(
      'RATE and its percentiles: the NY Fed line only — a fixing has exactly one publisher',
    );
  }
  return rules;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function timestampsOf(ts: { src: number | null; cap: number; pub: number }): QTimestamps {
  return { src: ts.src === null ? null : isoOf(ts.src), cap: isoOf(ts.cap), pub: isoOf(ts.pub) };
}

/** `'u' | 'd' | 'f'` for the tape's arrow; `null` when the tick carries no direction. */
function tapeDir(value: unknown): 'u' | 'd' | 'f' | null {
  return value === 'up' || value === 'down' || value === 'flat' ? tickDirCode(value) : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Which line supplied each composite field, decided by the plant's own record rather than guessed.
 *
 * `QuoteState.fieldTs[f]` is documented as "the line time of the line that supplied `f`"
 * (`core/quote/merge.ts`), so a line wins a field when it carries that field, its value is the
 * composite's value, and its line time is the one the composite recorded. Ties are broken by
 * priority — the same tie-break the merge used — so exactly one line wins a field, or none does
 * (which is the honest answer for `CHG_NET_1D` and the other plant-derived fields: no line
 * supplied them).
 */
export function winnersOf(
  state: GatedQuoteState,
  fields: readonly FieldId[],
  priorityOf: (mdLineId: number) => number,
): Map<number, FieldId[]> {
  const out = new Map<number, FieldId[]>();
  const lines = Object.values(state.lines);
  for (const field of fields) {
    const key = field as QuoteFieldId;
    const composite = state.fields[key];
    if (composite === undefined) continue;
    const ts = state.fieldTs[key];
    let winner: LineState | undefined;
    for (const line of lines) {
      if ((line.fields as Record<string, unknown>)[field] !== composite) continue;
      if (ts !== undefined && lineTime(line) !== ts) continue;
      if (winner === undefined || priorityOf(line.mdLineId) < priorityOf(winner.mdLineId)) {
        winner = line;
      }
    }
    if (winner === undefined) continue;
    const held = out.get(winner.mdLineId);
    if (held === undefined) out.set(winner.mdLineId, [field]);
    else held.push(field);
  }
  return out;
}

/**
 * One line's cells, re-gated against the composite's entitlement decision.
 *
 * A field the composite's `r` names is blank here too, with the same reason: the decision was about
 * the *field*, not about which of two sources happens to carry it.
 *
 * `provIdx` is the line's own citation, computed by the caller before this runs. Every cell that
 * shows a value carries it, because that is what makes `Ctrl+I` answer "where did this 330.27 come
 * from" on a per-line row (FUNCTIONS.md §1.5, DATA-10). `-1` is reserved for the two cases §0.4
 * rule 1 reserves it for: the line was never polled (`v` null, `st 'blank'`, nothing denied), and
 * the field was denied (`v` null, `r` set — the null is explained by the reason, not by a source).
 *
 * A field this line simply does not publish is `null` with `st 'na'`, and the caller records one
 * `ctx.unavailable` entry naming `l:<id>.<FIELD>` for it, so no null on this screen is unexplained.
 */
function lineCells(
  state: GatedQuoteState,
  line: LineState | undefined,
  subject: string,
  fields: readonly FieldId[],
  provIdx: number,
): { cells: QCells; absent: FieldId[] } {
  const cells: QCells = {};
  const absent: FieldId[] = [];
  for (const field of fields) {
    if (line === undefined) {
      cells[field] = pendingCell(subject, field);
      continue;
    }
    const reason = state.r[field];
    if (reason !== undefined) {
      cells[field] = { v: null, st: 'blank', r: reason, provIdx: -1, live: { subject, field } };
      continue;
    }
    const value = (line.fields as Record<string, unknown>)[field];
    if (value === undefined) {
      absent.push(field);
      cells[field] = { v: null, st: 'na', ts: null, provIdx: -1, live: { subject, field } };
      continue;
    }
    cells[field] = {
      v: value as ValueCell['v'],
      st: state.state,
      ts: lineTime(line),
      provIdx,
      live: { subject, field },
    };
  }
  return { cells, absent };
}

/**
 * The plant's own flags plus `Q`'s: `LAST_OUTSIDE_BOOK`.
 *
 * BUS-05 takes the trade block and the book from different lines, so a composite can show a last
 * price outside its own bid/ask while every line involved is individually correct and while
 * `CROSS_SOURCE_DIVERGENCE` (which only fires past 0.5 %) stays quiet — seven cents on a $330 name
 * is 0.027 %. The check is gated on both sides being present and on both carrying the composite's
 * session date, because a last from yesterday against a book from this morning is a staleness
 * statement, which `STALE_SOURCE` already makes.
 */
function dqFlags(
  state: GatedQuoteState | undefined,
  composite: QCells,
  bid: number | null,
  ask: number | null,
): QDataQualityFlag[] {
  const flags: QDataQualityFlag[] = state === undefined ? [] : [...state.dq];
  if (state === undefined || bid === null || ask === null) return flags;
  const last = numberOrNull(composite.PX_LAST?.v);
  if (last === null) return flags;
  const lastTs = state.fieldTs.PX_LAST;
  const bidTs = state.fieldTs.PX_BID;
  if (lastTs === undefined || bidTs === undefined) return flags;
  if (utcSessionDate(lastTs) !== utcSessionDate(bidTs)) return flags;
  if (last < bid || last > ask) flags.push('LAST_OUTSIDE_BOOK');
  return flags;
}

/** The UTC session date of a millisecond instant, as the merge itself keys sessions. */
function utcSessionDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The session block, or `null` when the venue has no seeded calendar (§0.6's degradation). */
async function sessionOf(
  ctx: ResolveContext,
  detail: InstrumentDetail,
  nowMs: number,
): Promise<{ session: QSession | null; label: string }> {
  const venue = await venueCalendar(ctx, detail);
  if (venue.calendar === null || venue.calendarId === null) {
    return { session: null, label: venue.label };
  }
  const assetClass = detail.instrument.assetClass;
  // US cash equities and ETFs trade an extended session; indices, options and fixings do not.
  const hasPrePost = assetClass === 'equity' || assetClass === 'etf';
  const cal = sessionCalendar(venue.calendar);
  const local = localClock(cal.tz, nowMs);
  const day = local === undefined ? { kind: 'unknown' as const } : cal.sessionDay(local.date);

  const state = sessionStateAt(cal, nowMs, hasPrePost);
  if (local === undefined || day.kind !== 'trading') {
    return {
      session: {
        state,
        calendarId: venue.calendarId,
        tz: cal.tz,
        openLocal: '',
        closeLocal: '',
        nextChangeAt: null,
        earlyClose: false,
      },
      label: venue.label,
    };
  }

  // The next boundary of the local day, in order; the first one still ahead is the next change.
  const times = day.times;
  const boundaries = [times.preOpen, times.open, times.close, times.postClose].filter(
    (t): t is string => t !== null,
  );
  let nextChangeAt: string | null = null;
  for (const time of boundaries) {
    const at = localTimeToUtc(cal.tz, local.date, time);
    if (at !== undefined && at > nowMs) {
      nextChangeAt = isoOf(at);
      break;
    }
  }

  return {
    session: {
      state,
      calendarId: venue.calendarId,
      tz: cal.tz,
      openLocal: times.open,
      closeLocal: times.close,
      nextChangeAt,
      earlyClose: times.earlyClose,
    },
    label: venue.label,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: QParams): Promise<QPayload> {
  const instrument = ctx.instrument;
  if (instrument === null) {
    throw new Error('Q: requiresSecurity is true, so the runner must supply an instrument');
  }
  const id = instrument.instrumentId;
  const assetClass = instrument.assetClass;
  const nowMs = ctx.asOf.validAt.getTime();

  // 1 — the reference prologue and the lines that may carry a quote.
  const detail = await ctx.data.reference.instrument(id);
  const mdLines = detail.mdLines
    .filter((line) => line.lineKind !== 'reference')
    .sort((a, b) => a.priority - b.priority || a.mdLineId - b.mdLineId);
  const priorityOf = (mdLineId: number): number =>
    mdLines.find((l) => l.mdLineId === mdLineId)?.priority ?? Number.MAX_SAFE_INTEGER;

  const subject = ctx.plant.subjectFor(id);
  ctx.plant.ensureHot([subject]);

  // 6 (early) — the session decides whether a cold subject is worth a provider call at all.
  const { session, label: venueLabel } = await sessionOf(ctx, detail, nowMs);
  if (session === null) {
    ctx.unavailable.add({
      field: 'session',
      reason: 'NO_SOURCE',
      detail: `no calendar seeded for ${venueLabel}`,
    });
  }

  // 2 — one read-through, and only when the screen would otherwise show nothing useful.
  let state = ctx.plant.snapshot(subject);
  const route = readThroughFor(assetClass);
  const primary = mdLines[0];
  const cold = state === undefined || state.state === 'stale' || state.state === 'blank';
  if (
    cold &&
    route !== null &&
    primary !== undefined &&
    ctx.usage !== 'export' &&
    session?.state === 'open'
  ) {
    await ctx.providers.ensure(route.kind, primary.providerSymbol, { maxAgeMs: route.maxAgeMs });
    state = ctx.plant.snapshot(subject);
  }

  // 3 — the composite, one cell per field of the class.
  const fields = qFieldIds(assetClass);
  const composite: QCells = {};
  for (const field of fields) composite[field] = cellFromState(ctx, state, field, subject);

  const compositeTs: QTimestamps =
    state === undefined
      ? { src: null, cap: isoOf(nowMs), pub: isoOf(nowMs) }
      : timestampsOf(state.ts);

  if (state === undefined) {
    ctx.unavailable.add({
      field: 'composite',
      reason: 'NO_SOURCE',
      detail: 'the plant holds no quote for this security yet — the scheduler polls it next',
    });
  }

  // v1 has no intraday VWAP publisher anywhere (§Q "Unavailable"): say so once, always.
  if (fields.includes('VWAP')) {
    ctx.unavailable.add({
      field: 'composite.VWAP',
      reason: 'NO_SOURCE',
      detail: 'no source publishes intraday VWAP',
    });
  }

  // 4 — the per-line view.
  const winners =
    state === undefined ? new Map<number, FieldId[]>() : winnersOf(state, fields, priorityOf);
  const lines: QLine[] = mdLines.map((line) => {
    const lineSubject = `l:${String(line.mdLineId)}`;
    const lstate = state?.lines[line.mdLineId];
    // The line's citation is computed first so its cells can carry it (§0.4 rule 1).
    const provIdx =
      lstate === undefined || state === undefined
        ? -1
        : ctx.prov.add({
            sourceId: lstate.sourceId,
            provenanceId: lstate.provenanceId,
            capturedAt: new Date(lstate.ts.cap),
            sourceTs: lstate.ts.src === null ? null : new Date(lstate.ts.src),
            st: state.state,
            tier: state.tier,
          });
    let cells: QCells = {};
    if (state === undefined) {
      for (const field of fields) cells[field] = pendingCell(lineSubject, field);
    } else {
      const built = lineCells(state, lstate, lineSubject, fields, provIdx);
      cells = built.cells;
      for (const field of built.absent) {
        ctx.unavailable.add({
          field: `${lineSubject}.${field}`,
          reason: 'NO_SOURCE',
          detail: `${line.sourceId} publishes no ${field} on this line`,
        });
      }
    }
    return {
      mdLineId: line.mdLineId,
      sourceId: line.sourceId,
      providerSymbol: line.providerSymbol,
      lineKind: line.lineKind,
      priority: line.priority,
      intrinsicDelayMin: line.intrinsicDelayMin,
      expectedIntervalMs: line.expectedIntervalMs,
      subject: lineSubject,
      cells,
      ts:
        lstate === undefined
          ? { src: null, cap: compositeTs.cap, pub: compositeTs.pub }
          : timestampsOf(lstate.ts),
      srcSeq: lstate?.srcSeq ?? null,
      st: lstate === undefined ? 'blank' : (state?.state ?? 'blank'),
      provIdx,
      wonFields: winners.get(line.mdLineId) ?? [],
    };
  });

  // 5 — top of book. No v1 source publishes depth, so everything past level 1 is blank with why.
  const bidCell = composite.PX_BID;
  const askCell = composite.PX_ASK;
  const bid = numberOrNull(bidCell?.v);
  const ask = numberOrNull(askCell?.v);
  const hasBook = getField('PX_BID')?.assetClasses.includes(assetClass) === true;
  const bookVenue = ((): string | null => {
    const winner = [...winners.entries()].find(([, won]) => won.includes('PX_BID'))?.[0];
    const line = winner === undefined ? undefined : mdLines.find((l) => l.mdLineId === winner);
    const listing =
      line?.listingId === undefined
        ? undefined
        : detail.listings.find((l) => l.listingId === line.listingId);
    return listing?.mic ?? null;
  })();

  const bids: QBookLevel[] =
    bid === null
      ? []
      : [
          {
            px: bid,
            size: numberOrNull(composite.BID_SIZE?.v),
            venue: bookVenue,
            provIdx: bidCell?.provIdx ?? -1,
          },
        ];
  const asks: QBookLevel[] =
    ask === null
      ? []
      : [
          {
            px: ask,
            size: numberOrNull(composite.ASK_SIZE?.v),
            venue: bookVenue,
            provIdx: askCell?.provIdx ?? -1,
          },
        ];
  const depthAvailable = bids.length > 0 && asks.length > 0 ? 1 : 0;
  const book: QBook = {
    bids,
    asks,
    depthRequested: params.depth,
    depthAvailable,
    reason: params.depth > depthAvailable ? 'DEPTH_UNAVAILABLE_SOURCE' : null,
  };
  if (!hasBook) {
    ctx.unavailable.add({
      field: 'book',
      reason: 'NOT_APPLICABLE',
      detail: 'no book for this instrument',
    });
  } else if (params.depth > depthAvailable) {
    ctx.unavailable.add({
      field: 'book',
      reason: 'NO_SOURCE',
      detail: 'DEPTH_UNAVAILABLE_SOURCE: Cboe delayed quotes publish top of book only',
    });
  }

  // 7 — the tape, newest first. `ticks.last` reads ascending (the order a tape prints in) and the
  // payload reverses it, because a screen reads downwards from the most recent print.
  const ticks = await ctx.data.ticks.last(id, params.tapeRows);
  const tape: QTapeRow[] = [...ticks].reverse().map((tick) => ({
    capTs: tick.capTs,
    srcTs: tick.srcTs,
    kind: tick.kind,
    price: numberOrNull(tick.f.PX_LAST),
    size: numberOrNull(tick.f.LAST_SIZE),
    bid: numberOrNull(tick.f.PX_BID),
    ask: numberOrNull(tick.f.PX_ASK),
    tickDir: tapeDir(tick.f.TICK_DIR),
    srcSeq: tick.srcSeq,
    conditions: tick.conditions,
    provIdx: tick.provIdx,
  }));
  if (tape.length === 0) {
    ctx.unavailable.add({
      field: 'tape',
      reason: 'NO_SOURCE',
      detail: 'no ticks captured in the last 30 days',
    });
  }

  return {
    variant: 'quote',
    instrument: toSummary(detail),
    composite,
    compositeTs,
    compositeSeq: state?.seq ?? 0,
    tier: state?.tier ?? 'eod',
    delayMin: state?.delayMin ?? primary?.intrinsicDelayMin ?? 0,
    lines,
    book,
    session,
    tape,
    compositionRules: describeRules(assetClass),
    dq: dqFlags(state, composite, bid, ask),
    asOf: ctx.asOf.validAt.toISOString(),
  };
}
