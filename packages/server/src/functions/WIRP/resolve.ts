/**
 * `functions/WIRP/resolve.ts` — the implied policy path (FUNCTIONS_TIER3.md §WIRP).
 *
 * Everything on this page comes out of two places: the NY Fed's published fixings and one
 * bootstrapped money-market curve. The resolver does **no rate arithmetic of its own** — the path,
 * the per-meeting moves and the 25 bp allocation all come back inside one `EngineResult` from
 * `wirp.policypath@1.0.0`, so `meta.engines[]` carries the `inputsHash` of the whole model and two
 * runs at the same `asOf` produce byte-identical numbers (ANAL-08). The only subtraction done here
 * is `cumChangeBp − previous cumChangeBp`, which §WIRP step 6 defines as a difference of two engine
 * outputs rather than as a model quantity.
 *
 * Four rules shape the file:
 *
 *  1. **There is no probability distribution here, and the payload says so in three places.**
 *     `model.caveats` always contains `NO_FUTURES_SOURCE` and `POINT_MASS_PROBABILITY_MODEL`, the
 *     CSV carries them as `#` header lines, and the screen renders the disclaimer above the grid.
 *     BRIEF §2 is binding: no fed-funds futures or options source is reachable, so what the
 *     probabilities tab shows is an *allocation of a rate*, not a traded distribution.
 *  2. **A past meeting is history, never a forecast.** Its implied cells are
 *     `{ v: null, st: 'na', r: 'NOT_IN_UNIVERSE' }` and its `decisionBp` is the published number.
 *     Nothing back-fills a model rate onto a decision that has already happened.
 *  3. **Nothing is invented at the horizon.** When `fomc_meetings` holds fewer undecided meetings
 *     than the caller asked to project, the grid shows the meetings that exist, `meta.unavailable`
 *     says how many there are, and `FOMC_CALENDAR_HORIZON` goes on the badge row. No synthetic
 *     meeting date is ever produced.
 *  4. **Without a target range there is no path against it.** `cumChangeBp`, `stepChangeBp`,
 *     `impliedMoves` and the whole outcome ladder are anchored on the EFFR target midpoint. With no
 *     EFFR fixing stored they are blank with `PROVIDER_DOWN`; `impliedOvernightPct` still renders,
 *     because the curve is a separate source and it is still there.
 *
 * Deviations from §WIRP, each recorded in `WIRP.ts`'s header too:
 *
 *  * the engine is `wirp.policypath@1.0.0` (the landed `defineEngine` name);
 *  * a typed `date` with no stored curve is `400 VALIDATION_FAILED`, not 422 — `ERROR_CODE_STATUS`
 *    in `sdk/wire/envelope.ts` maps `VALIDATION_FAILED` to 400 and a code may not disagree with its
 *    status (`http/errors.ts`);
 *  * `WirpCurveBlock` allows a **missing** curve (`date: null`). `data.curves.points` throws when
 *    nothing is stored on or before the as-of date, and a policy page that 500s because last
 *    night's ingest has not run is worse than one that says the curve is missing. BTMM's
 *    `BtmmCurveBlock.curveDate` records the same widening for the same reason;
 *  * with no target range the outcome ladder is **empty** rather than a list of blank rows: an
 *    outcome row is `{ moves, bp, rangeFrom, rangeTo }` and every one of those four numbers is a
 *    function of the target range. A row of nulls would be a row about nothing.
 */

import type { ReasonCode, Tier, ValueCell, ValueState } from '@terminal/core';
import { engineMeta } from '@terminal/core/analytics/engine';
import type { PolicyPathInputs, PolicyPathOutputs } from '@terminal/core/analytics/wirp/policyPath';
import { interpolationName } from '@terminal/core/analytics/curve/interp';
import { policyPathEngine } from '@terminal/core/analytics/wirp/policyPath';
import type { Calendar, IsoDate } from '@terminal/core/calendars/calendar';
import { addDays, daysBetween } from '@terminal/core/calendars/calendar';
import type {
  WirpBasis,
  WirpCurrent,
  WirpCurveBlock,
  WirpCurveCaveat,
  WirpMeeting,
  WirpModelCaveat,
  WirpOutcome,
  WirpParams,
  WirpPayload,
  WirpReference,
  WirpTerminal,
  WirpVsCompare,
} from '@terminal/core/functions/manifests/WIRP';
import {
  WIRP_CALENDAR_HORIZON,
  WIRP_NO_FUTURES_SOURCE,
  WIRP_NO_OIS_QUOTES,
  WIRP_POINT_MASS_MODEL,
  WIRP_PROXY_CURVE,
} from '@terminal/core/functions/manifests/WIRP';
import { localClock } from '@terminal/core/quote/session';

import type { CurveBuild, CurvePoints } from '../../data/curves.js';
import { CurveDataError } from '../../data/curves.js';
import type { FomcMeeting } from '../../data/econ.js';
import type { RateFixing } from '../../data/rates.js';
import { RateDataError } from '../../data/rates.js';
import { AppError } from '../../http/errors.js';
import type { ResolveContext } from '../context.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Every stored number on this page is a published daily figure (§0.4 rule 3). */
const STORED_TIER: Tier = 'eod';

/** A curve served more than this many SIFMA business days behind the valuation date is stale. */
const CURVE_STALE_BUSINESS_DAYS = 5;

/** The derived basis needs at least this many paired EFFR/SOFR fixings to mean anything. */
const MIN_BASIS_PAIRS = 3;

/** How many stored fixings the derived basis looks back over (§WIRP step 3). */
const BASIS_HISTORY_DAYS = 30;

/**
 * The basis the implied overnight rate is read on: the §0 money-market convention, **fixed here
 * rather than read off the build**.
 *
 * `data/curves.ts` builds a fresh OIS bootstrap with `compounding: 'continuous'` (the bootstrap
 * hard-codes it) but re-hydrates a *cached* build with `curves.compounding` from the database. A
 * resolver that took `build.curve.compounding` would therefore read a different forward on a cache
 * miss than on a cache hit — the same request answered two ways, which ANAL-08 exists to forbid.
 * The money-market forward is ACT/360 simple by definition (§0, §WIRP step 6), so this file says
 * so and depends on the discount factors alone.
 */
const MONEY_MARKET_DAY_COUNT = 'ACT/360' as const;
const MONEY_MARKET_COMPOUNDING = 'simple' as const;

/** A cell holding a stored or engine-derived number. */
function numCell(v: number, st: ValueState, provIdx: number): ValueCell {
  return { v, st, provIdx };
}

/** A cell that has no number, and the reason it has none. */
function blankCell(st: ValueState, r: ReasonCode): ValueCell {
  return { v: null, st, r, provIdx: -1 };
}

/** `ctx.asOf.validAt` as the New York calendar day — the day this page is "today". */
function nyDate(ms: number): IsoDate {
  return (localClock('America/New_York', ms)?.date ?? new Date(ms).toISOString().slice(0, 10));
}

/** Business days from `from` to `to` on `cal`, counting the later day. Bounded. */
function businessDaysBetween(cal: Calendar, from: IsoDate, to: IsoDate): number {
  if (from >= to) return 0;
  let count = 0;
  let cursor = from;
  for (let i = 0; i < 400 && cursor < to; i += 1) {
    cursor = addDays(cursor, 1);
    if (cal.isBusinessDay(cursor)) count += 1;
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `rates.latest`, or `null` when nothing is stored — a missing fixing degrades, it does not 500. */
async function latestFixing(ctx: ResolveContext, code: string): Promise<RateFixing | null> {
  try {
    return await ctx.data.rates.latest(code);
  } catch (err) {
    if (err instanceof RateDataError) return null;
    throw err;
  }
}

async function fixingHistory(ctx: ResolveContext, code: string): Promise<RateFixing[]> {
  try {
    return await ctx.data.rates.history(code, BASIS_HISTORY_DAYS);
  } catch (err) {
    if (err instanceof RateDataError) return [];
    throw err;
  }
}

interface CurveSnapshot {
  points: CurvePoints;
  build: CurveBuild;
}

/**
 * The stored curve and its build, or `null` when nothing is stored on or before `date`.
 *
 * `CurveDataError` is the only failure absorbed here; anything else is a defect and propagates.
 */
async function curveOn(
  ctx: ResolveContext,
  curveId: string,
  date: string,
): Promise<CurveSnapshot | null> {
  let points: CurvePoints;
  try {
    points = await ctx.data.curves.points(curveId, date);
  } catch (err) {
    if (err instanceof CurveDataError) return null;
    throw err;
  }
  try {
    const build = await ctx.data.curves.build(curveId, points.curveDate, points.defaultInterpolation);
    return { points, build };
  } catch (err) {
    if (err instanceof CurveDataError) return null;
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The engine call (ANAL-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface PathRun {
  outputs: PolicyPathOutputs;
  engine: { name: string; version: string; inputsHash: string };
}

/**
 * Run `wirp.policypath` over one curve build and one list of decision dates.
 *
 * `currentRate` is the **target midpoint less the applied basis**, in decimal. That is the anchor
 * that makes the engine's `moveBp` equal §WIRP's `cumChangeBp` exactly:
 *
 *   moveBp = (impliedOvernight − (targetMid − basis)) × 10 000
 *          = (impliedOvernight + basis − targetMid) × 100  (percent → bp)
 *          = (impliedReference − targetMid) × 100 = cumChangeBp
 *
 * so the number the screen shows and the number the probabilities split are the same number, from
 * one hash-covered engine run, rather than two subtractions that can drift apart.
 */
function runPath(
  snapshot: CurveSnapshot,
  meetings: readonly string[],
  opts: { anchorDecimal: number | null; stepBp: number; valuationTs: string },
): PathRun {
  const inputs: PolicyPathInputs = {
    curveId: snapshot.build.curveId,
    curveDate: snapshot.build.curveDate,
    points: snapshot.build.nodes.map((n) => ({ t: n.t, df: n.df })),
    meetings: meetings,
    ...(opts.anchorDecimal === null ? {} : { currentRate: opts.anchorDecimal }),
    stepSize: opts.stepBp / 10_000,
    dayCount: MONEY_MARKET_DAY_COUNT,
    compounding: MONEY_MARKET_COMPOUNDING,
    interpolation: interpolationName(snapshot.build.interpolation),
  };
  const result = policyPathEngine(inputs, opts.valuationTs);
  return { outputs: result.outputs, engine: engineMeta(result) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: WirpParams): Promise<WirpPayload> {
  const valuationDate = nyDate(ctx.asOf.validAt.getTime());
  const valuationTs = ctx.asOf.validAt.toISOString();
  const cal = await ctx.data.reference.calendar('SIFMA'); // REF-06

  // ── 2. the current fixing and the target range ────────────────────────────────────────────
  const effr = await latestFixing(ctx, 'EFFR');
  const sofr = await latestFixing(ctx, 'SOFR');
  const reference: WirpReference = params.reference;
  const referenceFixing = reference === 'EFFR' ? effr : sofr;

  const cite = (fixing: RateFixing): number =>
    ctx.prov.add({
      sourceId: 'nyfed.rates',
      provenanceId: fixing.provenanceId,
      capturedAt: new Date(fixing.capturedAt),
      sourceTs: fixing.sourceTs === null ? null : new Date(fixing.sourceTs),
      st: 'closed',
      tier: STORED_TIER,
    });

  const referenceProvIdx = referenceFixing === null ? -1 : cite(referenceFixing);
  const targetProvIdx = effr === null ? -1 : cite(effr);

  const targetFrom = effr?.targetFrom ?? null;
  const targetTo = effr?.targetTo ?? null;
  const targetMid =
    targetFrom === null || targetTo === null ? null : (targetFrom + targetTo) / 2;

  if (targetMid === null) {
    ctx.unavailable.add({
      field: 'current.targetMid',
      reason: 'NO_SOURCE',
      detail: `no EFFR target range stored on or before ${valuationDate}`,
    });
    ctx.unavailable.add({
      field: 'current.targetFrom',
      reason: 'NO_SOURCE',
      detail: `no EFFR target range stored on or before ${valuationDate}`,
    });
    ctx.unavailable.add({
      field: 'current.targetTo',
      reason: 'NO_SOURCE',
      detail: `no EFFR target range stored on or before ${valuationDate}`,
    });
  }
  const referenceRate = referenceFixing?.rate ?? null;
  if (referenceRate === null) {
    ctx.unavailable.add({
      field: 'current.rate',
      reason: 'NO_SOURCE',
      detail: `no ${reference} fixing stored on or before ${valuationDate}`,
    });
  }

  const liveSubject = `r:${reference}`;
  const current: WirpCurrent = {
    rateCode: reference,
    effectiveDate: referenceFixing?.effectiveDate ?? valuationDate,
    rate:
      referenceRate === null
        ? blankCell('blank', 'PROVIDER_DOWN')
        : { ...numCell(referenceRate, 'closed', referenceProvIdx), live: { subject: liveSubject, field: 'RATE' } },
    targetFrom:
      targetFrom === null
        ? blankCell('blank', 'PROVIDER_DOWN')
        : { ...numCell(targetFrom, 'closed', targetProvIdx), live: { subject: 'r:EFFR', field: 'TARGET_FROM' } },
    targetTo:
      targetTo === null
        ? blankCell('blank', 'PROVIDER_DOWN')
        : { ...numCell(targetTo, 'closed', targetProvIdx), live: { subject: 'r:EFFR', field: 'TARGET_TO' } },
    targetMid:
      targetMid === null
        ? blankCell('blank', 'PROVIDER_DOWN')
        : numCell(targetMid, 'closed', targetProvIdx),
    provIdx: referenceProvIdx,
  };

  // ── 3. the EFFR − SOFR basis ──────────────────────────────────────────────────────────────
  const basis = await resolveBasis(ctx, params, {
    reference,
    valuationDate,
    citeProvIdx: referenceProvIdx === -1 ? targetProvIdx : referenceProvIdx,
  });
  const appliedBp = basis.appliedValueBp;

  // ── 4. the curve ──────────────────────────────────────────────────────────────────────────
  const requestedDate = params.date;
  const snapshot = await curveOn(ctx, params.curveId, requestedDate ?? valuationDate);
  if (snapshot === null && requestedDate !== null) {
    throw new AppError(
      'VALIDATION_FAILED',
      `no ${params.curveId} curve on or before ${requestedDate}.`,
      { details: { location: 'fnParams', field: 'date', detail: `no ${params.curveId} curve on or before ${requestedDate}` } },
    );
  }

  const curveCaveats: WirpCurveCaveat[] =
    params.curveId === 'SOFR_OIS' ? [WIRP_PROXY_CURVE, WIRP_NO_OIS_QUOTES] : [];

  let curveProvIdx = -1;
  let curveState: ValueState = 'closed';
  let curveBlock: WirpCurveBlock;
  if (snapshot === null) {
    ctx.unavailable.add({
      field: 'curve',
      reason: 'NO_SOURCE',
      detail: `no ${params.curveId} curve on or before ${valuationDate}`,
    });
    curveBlock = {
      id: params.curveId,
      date: null,
      requestedDate,
      buildId: null,
      method: null,
      interpolation: null,
      sourceId: null,
      provIdx: -1,
      caveats: curveCaveats,
    };
  } else {
    const anchor = snapshot.points.points[0];
    const behind = businessDaysBetween(cal, snapshot.points.curveDate, valuationDate);
    curveState = behind > CURVE_STALE_BUSINESS_DAYS ? 'stale' : 'closed';
    curveProvIdx =
      anchor === undefined
        ? -1
        : ctx.prov.add({
            sourceId: snapshot.points.sourceId,
            provenanceId: anchor.provenanceId,
            capturedAt: new Date(anchor.capturedAt),
            sourceTs: anchor.sourceTs === null ? null : new Date(anchor.sourceTs),
            st: curveState,
            tier: STORED_TIER,
          });
    ctx.engines.add(snapshot.build.engine);
    curveBlock = {
      id: params.curveId,
      date: snapshot.points.curveDate,
      requestedDate,
      buildId: snapshot.build.buildId,
      method: snapshot.build.method,
      interpolation: snapshot.build.interpolation,
      sourceId: snapshot.points.sourceId,
      provIdx: curveProvIdx,
      caveats: curveCaveats,
    };
  }

  // ── 5. the FOMC calendar ──────────────────────────────────────────────────────────────────
  const allMeetings = await ctx.data.econ.fomc();
  const past = allMeetings.filter((m) => m.meetingDate < valuationDate);
  const futureAll = allMeetings.filter((m) => m.meetingDate >= valuationDate);
  const future = futureAll.slice(0, params.meetings);

  const modelCaveats: WirpModelCaveat[] = [
    WIRP_NO_FUTURES_SOURCE,
    WIRP_POINT_MASS_MODEL,
    ...curveCaveats,
  ];
  if (future.length < params.meetings) {
    ctx.unavailable.add({
      field: 'meetings',
      reason: 'NO_SOURCE',
      detail:
        `fomc_meetings holds ${String(future.length)} undecided meetings; the FOMC has not ` +
        `published the ${String(Number(valuationDate.slice(0, 4)) + 1)} calendar`,
    });
    modelCaveats.push(WIRP_CALENDAR_HORIZON);
  }

  // ── 6-7. the path and the allocation ──────────────────────────────────────────────────────
  const anchorDecimal = targetMid === null ? null : (targetMid - appliedBp / 100) / 100;
  const path =
    snapshot === null || future.length === 0
      ? null
      : runPath(
          snapshot,
          future.map((m) => m.meetingDate),
          { anchorDecimal, stepBp: params.stepBp, valuationTs },
        );
  if (path !== null) ctx.engines.add(path.engine);

  // ── 8. the comparison curve ───────────────────────────────────────────────────────────────
  let comparePath: PathRun | null = null;
  if (params.compare !== null) {
    const compareSnapshot = await curveOn(ctx, params.curveId, params.compare);
    if (compareSnapshot === null || future.length === 0) {
      ctx.unavailable.add({
        field: 'compare',
        reason: 'NO_SOURCE',
        detail: `no ${params.curveId} curve on or before ${params.compare}`,
      });
    } else {
      ctx.engines.add(compareSnapshot.build.engine);
      comparePath = runPath(
        compareSnapshot,
        future.map((m) => m.meetingDate),
        { anchorDecimal, stepBp: params.stepBp, valuationTs },
      );
      ctx.engines.add(comparePath.engine);
    }
  }

  // ── the rows ──────────────────────────────────────────────────────────────────────────────
  const citeMeeting = (m: FomcMeeting, fallback: number): number => {
    if (m.provenanceId === null) return fallback;
    return ctx.prov.add({
      sourceId: 'fed.fomc',
      provenanceId: m.provenanceId,
      capturedAt: ctx.asOf.knownAt,
      sourceTs: null,
      st: 'closed',
      tier: STORED_TIER,
    });
  };

  const rows: WirpMeeting[] = [];
  for (const m of past) {
    rows.push({
      meetingDate: m.meetingDate,
      statementAt: m.statementAt,
      hasSep: m.hasSep,
      isPast: true,
      daysAhead: daysBetween(valuationDate, m.meetingDate),
      t: daysBetween(valuationDate, m.meetingDate) / 365,
      impliedOvernightPct: blankCell('na', 'NOT_IN_UNIVERSE'),
      impliedReferencePct: blankCell('na', 'NOT_IN_UNIVERSE'),
      cumChangeBp: blankCell('na', 'NOT_IN_UNIVERSE'),
      stepChangeBp: blankCell('na', 'NOT_IN_UNIVERSE'),
      impliedMoves: blankCell('na', 'NOT_IN_UNIVERSE'),
      outcomes: [],
      vsCompare: null,
      decisionBp: m.decisionBp,
      provIdx: citeMeeting(m, -1),
    });
  }
  if (past.length > 0) {
    for (const field of [
      'meetings.impliedOvernightPct',
      'meetings.impliedReferencePct',
      'meetings.cumChangeBp',
      'meetings.stepChangeBp',
      'meetings.impliedMoves',
    ]) {
      ctx.unavailable.add({
        field,
        reason: 'NOT_APPLICABLE',
        detail:
          'a meeting that has already taken place carries its published decision, never a ' +
          'model rate back-filled onto it',
      });
    }
  }

  let previousCum: number | null = 0;
  const outputs = path?.outputs ?? null;
  for (let i = 0; i < future.length; i += 1) {
    const m = future[i]!;
    const leg = outputs?.meetings[i];
    const days = daysBetween(valuationDate, m.meetingDate);

    const impliedOvernightPct = leg === undefined ? null : leg.impliedRate * 100;
    const impliedReferencePct =
      impliedOvernightPct === null ? null : impliedOvernightPct + appliedBp / 100;
    const cumChangeBp = leg === undefined || targetMid === null ? null : leg.moveBp;
    const stepChangeBp =
      cumChangeBp === null || previousCum === null ? null : cumChangeBp - previousCum;
    const impliedMoves = leg === undefined || targetMid === null ? null : leg.steps;

    const outcomes: WirpOutcome[] =
      leg === undefined || targetMid === null || targetFrom === null || targetTo === null
        ? []
        : leg.probabilities
            .filter((o) => Math.round(o.probability * 100 * 100) / 100 !== 0)
            .map((o) => ({
              moves: o.steps,
              bp: o.bp,
              rangeFrom: targetFrom + (o.steps * params.stepBp) / 100,
              rangeTo: targetTo + (o.steps * params.stepBp) / 100,
              probPct: numCell(o.probability * 100, curveState, curveProvIdx),
            }))
            .sort((a, b) => b.moves - a.moves);

    const compareLeg = comparePath?.outputs.meetings[i];
    const vsCompare: WirpVsCompare | null =
      params.compare === null || comparePath === null || compareLeg === undefined
        ? null
        : {
            date: params.compare,
            cumChangeBp: targetMid === null ? null : compareLeg.moveBp,
            deltaBp: targetMid === null || cumChangeBp === null ? null : cumChangeBp - compareLeg.moveBp,
          };

    rows.push({
      meetingDate: m.meetingDate,
      statementAt: m.statementAt,
      hasSep: m.hasSep,
      isPast: false,
      daysAhead: days,
      t: days / 365,
      impliedOvernightPct:
        impliedOvernightPct === null
          ? blankCell('blank', 'PROVIDER_DOWN')
          : numCell(impliedOvernightPct, curveState, curveProvIdx),
      impliedReferencePct:
        impliedReferencePct === null
          ? blankCell('blank', 'PROVIDER_DOWN')
          : numCell(impliedReferencePct, curveState, curveProvIdx),
      cumChangeBp:
        cumChangeBp === null
          ? blankCell('blank', 'PROVIDER_DOWN')
          : numCell(cumChangeBp, curveState, curveProvIdx),
      stepChangeBp:
        stepChangeBp === null
          ? blankCell('blank', 'PROVIDER_DOWN')
          : numCell(stepChangeBp, curveState, curveProvIdx),
      impliedMoves:
        impliedMoves === null
          ? blankCell('blank', 'PROVIDER_DOWN')
          : numCell(impliedMoves, curveState, curveProvIdx),
      outcomes,
      vsCompare,
      decisionBp: m.decisionBp,
      provIdx: curveProvIdx === -1 ? citeMeeting(m, -1) : curveProvIdx,
    });
    previousCum = cumChangeBp;
  }

  if (future.length > 0) {
    ctx.unavailable.add({
      field: 'meetings.decisionBp',
      reason: 'NOT_APPLICABLE',
      detail: 'a decision is published when the meeting ends; a scheduled meeting has none',
    });
    if (snapshot === null) {
      for (const field of [
        'meetings.impliedOvernightPct',
        'meetings.impliedReferencePct',
        'meetings.cumChangeBp',
        'meetings.stepChangeBp',
        'meetings.impliedMoves',
      ]) {
        ctx.unavailable.add({
          field,
          reason: 'NO_SOURCE',
          detail: `no ${params.curveId} curve on or before ${valuationDate}; the path is not computed`,
        });
      }
    } else if (targetMid === null) {
      for (const field of ['meetings.cumChangeBp', 'meetings.stepChangeBp', 'meetings.impliedMoves']) {
        ctx.unavailable.add({
          field,
          reason: 'NO_SOURCE',
          detail: 'the path is measured from the EFFR target midpoint, which is not stored',
        });
      }
    }
  }

  // ── 9. terminal ───────────────────────────────────────────────────────────────────────────
  const lastFuture = rows[rows.length - 1];
  const hasTerminal = future.length > 0 && lastFuture !== undefined && !lastFuture.isPast;
  const terminal: WirpTerminal = {
    meetingDate: hasTerminal ? lastFuture.meetingDate : null,
    ratePct: hasTerminal ? lastFuture.impliedReferencePct : blankCell('na', 'NOT_IN_UNIVERSE'),
    cumChangeBp: hasTerminal ? lastFuture.cumChangeBp : blankCell('na', 'NOT_IN_UNIVERSE'),
  };
  if (!hasTerminal) {
    ctx.unavailable.add({
      field: 'terminal',
      reason: 'NO_SOURCE',
      detail: 'no undecided FOMC meeting is stored, so there is no terminal level to report',
    });
  }

  return {
    variant: 'default',
    asOfDate: valuationDate,
    current,
    basis: basis.block,
    curve: curveBlock,
    meetings: rows,
    terminal,
    model: {
      engine: path?.engine ?? null,
      stepBp: params.stepBp,
      probabilityModel: 'two_point_interpolation',
      caveats: modelCaveats,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Basis (§WIRP step 3)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface BasisResult {
  block: WirpBasis;
  /** The number actually added to every implied overnight rate, in bp. */
  appliedValueBp: number;
}

/**
 * The EFFR − SOFR basis.
 *
 * A `user` or `zero` basis is not a measurement, but it is still a finite number in a `ValueCell`,
 * and DATA-10 says such a cell cites a provenance row. It cites the fixing it is applied to —
 * which is the only row the number has anything to do with — and `basis.source` says in the payload
 * which of the three it is, so nothing is passed off as an observation. When there is no fixing at
 * all to cite, the cell is blank and `meta.unavailable` says why: a number with no citation is not
 * served (`provIdx: -1` is legal only on a null).
 */
async function resolveBasis(
  ctx: ResolveContext,
  params: WirpParams,
  env: { reference: WirpReference; valuationDate: string; citeProvIdx: number },
): Promise<BasisResult> {
  const formula = 'mean(EFFR − SOFR) over stored fixings' as const;
  const cite = env.citeProvIdx;

  const fixed = (valueBp: number, source: 'user' | 'zero', detail: string | null): BasisResult => {
    if (detail !== null) {
      ctx.unavailable.add({ field: 'basis.appliedBp', reason: 'NO_SOURCE', detail });
    }
    if (cite < 0) {
      ctx.unavailable.add({
        field: 'basis.appliedBp',
        reason: 'NO_SOURCE',
        detail: 'no NY Fed fixing is stored, so the applied basis has no provenance to cite',
      });
      return {
        block: {
          appliedBp: blankCell('blank', 'PROVIDER_DOWN'),
          source,
          observations: 0,
          window: null,
          formula,
        },
        appliedValueBp: valueBp,
      };
    }
    return {
      block: {
        appliedBp: numCell(valueBp, 'na', cite),
        source,
        observations: 0,
        window: null,
        formula,
      },
      appliedValueBp: valueBp,
    };
  };

  if (params.basisBp !== null) return fixed(params.basisBp, 'user', null);
  // The curve is already a SOFR curve, so expressing the path in SOFR needs no basis and no note.
  if (env.reference === 'SOFR') return fixed(0, 'zero', null);

  // Sequential: one request transaction, one pg connection (see FED/resolve.ts).
  const effrHistory = await fixingHistory(ctx, 'EFFR');
  const sofrHistory = await fixingHistory(ctx, 'SOFR');
  const sofrByDate = new Map<string, number>();
  for (const row of sofrHistory) {
    if (row.rate !== null) sofrByDate.set(row.effectiveDate, row.rate);
  }
  const pairs: { date: string; diff: number }[] = [];
  for (const row of effrHistory) {
    if (row.rate === null) continue;
    const other = sofrByDate.get(row.effectiveDate);
    if (other === undefined) continue;
    pairs.push({ date: row.effectiveDate, diff: row.rate - other });
  }
  pairs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (pairs.length < MIN_BASIS_PAIRS) {
    return fixed(
      0,
      'zero',
      `fewer than ${String(MIN_BASIS_PAIRS)} paired EFFR/SOFR fixings stored; basis set to 0 bp`,
    );
  }

  const mean = pairs.reduce((sum, p) => sum + p.diff, 0) / pairs.length;
  const appliedValueBp = mean * 100;
  if (cite < 0) {
    ctx.unavailable.add({
      field: 'basis.appliedBp',
      reason: 'NO_SOURCE',
      detail: 'no NY Fed fixing is stored, so the derived basis has no provenance to cite',
    });
    return {
      block: {
        appliedBp: blankCell('blank', 'PROVIDER_DOWN'),
        source: 'derived',
        observations: pairs.length,
        window: { from: pairs[0]!.date, to: pairs[pairs.length - 1]!.date },
        formula,
      },
      appliedValueBp,
    };
  }
  return {
    block: {
      appliedBp: numCell(appliedValueBp, 'closed', cite),
      source: 'derived',
      observations: pairs.length,
      window: { from: pairs[0]!.date, to: pairs[pairs.length - 1]!.date },
      formula,
    },
    appliedValueBp,
  };
}
