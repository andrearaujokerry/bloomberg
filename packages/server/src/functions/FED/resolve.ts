/**
 * `functions/FED/resolve.ts` — the Federal Reserve monitor (FUNCTIONS_TIER3.md §FED).
 *
 * Five blocks off six reads: the NY Fed overnight complex with its percentiles and volumes, the
 * H.15 constant-maturity grid, the FOMC calendar with the overnight rate the `SOFR_OIS` curve
 * implies at each meeting, the SOFR averages, and the Federal Reserve press feed.
 *
 * **The rule this file exists to keep is §1.3 rule 6: what has no source is blank with a reason,
 * never derived.** Four things Bloomberg's FED shows are not reachable in this build, and each of
 * them is a gap the resolver is forbidden to close:
 *
 *  * `policy.iorb` — IORB lives in the H.15 *selected daily rates* release, and the slice fetched
 *    here is the constant-maturity Treasury block. It is **not** EFFR, and it is not EFFR plus a
 *    spread: a plausible number here would be indistinguishable from a published one on screen.
 *  * `policy.discountPrimary` — no reachable keyless source.
 *  * `balanceSheet` — H.4.1 is not among the verified endpoints, so the field is `null` and the
 *    block is not rendered at all.
 *  * `meetings[].hikeProbPct` / `cutProbPct` — these need fed-funds futures (BRIEF §2). The
 *    calendar shows an implied *rate path*; a rate path is not a probability distribution, and the
 *    payload, the screen note and the export all say so.
 *
 * Everything else is a published number with its provenance, or one subtraction away from one:
 * `chg1dBp` differences two stored fixings, `spreadToMidBp` differences a fixing and the published
 * target midpoint. The implied path comes back inside an `EngineResult` from
 * `wirp.policypath@1.0.0`, so `meta.engines[]` carries its `inputsHash` (ANAL-08).
 *
 * Deviations from §FED are listed in `FED.ts`'s header. The two visible here: a null-by-design cell
 * carries its reason in `meta.unavailable` rather than in `ValueCell.r` (`NO_SOURCE_FIELD` is not a
 * member of the closed `ReasonCode` union), and `data.news.search` takes one `feed` rather than a
 * `feeds` array — that is WP-04's landed `NewsQuery`.
 */

import type { FieldId, ReasonCode, Tier, ValueCell, ValueState } from '@terminal/core';
import { engineMeta } from '@terminal/core/analytics/engine';
import type { PolicyPathInputs } from '@terminal/core/analytics/wirp/policyPath';
import { interpolationName } from '@terminal/core/analytics/curve/interp';
import { policyPathEngine } from '@terminal/core/analytics/wirp/policyPath';
import type { Calendar, IsoDate } from '@terminal/core/calendars/calendar';
import { addDays } from '@terminal/core/calendars/calendar';
import type {
  FedH15Block,
  FedH15Row,
  FedHistoryRow,
  FedMeetingRow,
  FedParams,
  FedPathBlock,
  FedPayload,
  FedPolicy,
  FedPressItem,
  FedRateCode,
  FedRateRow,
  FedSofrAverages,
} from '@terminal/core/functions/manifests/FED';
import {
  FED_BALANCE_SHEET_DETAIL,
  FED_DISCOUNT_DETAIL,
  FED_IORB_DETAIL,
  FED_NO_FUTURES_SOURCE,
  FED_PROBABILITY_DETAIL,
  FED_PROXY_CURVE,
  FED_RATE_CODES,
  FED_RATE_LABELS,
  fedCategoryMatches,
} from '@terminal/core/functions/manifests/FED';
import { localClock } from '@terminal/core/quote/session';

import type { CurveBuild, CurvePoints } from '../../data/curves.js';
import { CurveDataError } from '../../data/curves.js';
import type { FomcMeeting } from '../../data/econ.js';
import type { NewsItem } from '../../data/news.js';
import type { RateFixing } from '../../data/rates.js';
import { RateDataError } from '../../data/rates.js';
import type { ResolveContext } from '../context.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

const STORED_TIER: Tier = 'eod';
const SOFR_AVERAGES_CODE = 'SOFRAI';
const PATH_CURVE_ID = 'SOFR_OIS';
const CMT_CURVE_ID = 'UST_CMT';
const PRESS_FEED = 'press_all';
/** §FED step 2 / step 9: fifteen minutes is "fresh enough" for both read-throughs. */
const READ_THROUGH_MAX_AGE_MS = 900_000;
/** The press query reads at least this many items so the category filter has something to cut. */
const PRESS_MIN_FETCH = 50;

function numCell(v: number, st: ValueState, provIdx: number): ValueCell {
  return { v, st, provIdx };
}

function blankCell(st: ValueState, r?: ReasonCode): ValueCell {
  return r === undefined ? { v: null, st, provIdx: -1 } : { v: null, st, r, provIdx: -1 };
}

function nyDate(ms: number): IsoDate {
  return (localClock('America/New_York', ms)?.date ??
    new Date(ms).toISOString().slice(0, 10));
}

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
// Resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: FedParams): Promise<FedPayload> {
  const asOfDate = nyDate(ctx.asOf.validAt.getTime());
  const valuationTs = ctx.asOf.validAt.toISOString();
  const cal = await ctx.data.reference.calendar('USGOVT'); // REF-06

  // ── 2. the overnight complex ──────────────────────────────────────────────────────────────
  // Sequential, not `Promise.all`: a resolver runs inside ONE request transaction on ONE pg
  // connection, and concurrent `query()` calls on a single client are serialised by the driver
  // anyway (and deprecated in pg 9). The round trips are cheap; the illusion of parallelism is not.
  const codes = [...FED_RATE_CODES, SOFR_AVERAGES_CODE] as const;
  const readAll = async (): Promise<(RateFixing | null)[]> => {
    const rows: (RateFixing | null)[] = [];
    for (const code of codes) rows.push(await latestOrNull(ctx, code));
    return rows;
  };
  let fixings = await readAll();

  const effrIndex = codes.indexOf('EFFR');
  const stale = await refreshIfBehind(ctx, cal, asOfDate, fixings[effrIndex] ?? null);
  if (stale.refetched) fixings = await readAll();
  const rateState: ValueState = stale.stale ? 'stale' : 'closed';

  const byCode = new Map<string, RateFixing>();
  fixings.forEach((f, i) => {
    if (f !== null) byCode.set(codes[i]!, f);
  });

  const citeFixing = (fixing: RateFixing): number =>
    ctx.prov.add({
      sourceId: 'nyfed.rates',
      provenanceId: fixing.provenanceId,
      capturedAt: new Date(fixing.capturedAt),
      sourceTs: fixing.sourceTs === null ? null : new Date(fixing.sourceTs),
      st: rateState,
      tier: STORED_TIER,
    });

  const effr = byCode.get('EFFR') ?? null;
  const sofr = byCode.get('SOFR') ?? null;
  const effrProvIdx = effr === null ? -1 : citeFixing(effr);

  // ── 3. the policy block ───────────────────────────────────────────────────────────────────
  const targetFrom = effr?.targetFrom ?? null;
  const targetTo = effr?.targetTo ?? null;
  const targetMid = targetFrom === null || targetTo === null ? null : (targetFrom + targetTo) / 2;
  if (targetMid === null) {
    ctx.unavailable.add({
      field: 'policy.targetFrom',
      reason: 'NO_SOURCE',
      detail: `no EFFR target range stored on or before ${asOfDate}`,
    });
    ctx.unavailable.add({
      field: 'policy.targetTo',
      reason: 'NO_SOURCE',
      detail: `no EFFR target range stored on or before ${asOfDate}`,
    });
  }

  // The four structural gaps, declared before anything else can be tempted to fill them.
  ctx.unavailable.add({ field: 'policy.iorb', reason: 'NO_SOURCE', detail: FED_IORB_DETAIL });
  ctx.unavailable.add({
    field: 'policy.discountPrimary',
    reason: 'NO_SOURCE',
    detail: FED_DISCOUNT_DETAIL,
  });
  ctx.unavailable.add({
    field: 'balanceSheet',
    reason: 'NO_SOURCE',
    detail: FED_BALANCE_SHEET_DETAIL,
  });
  ctx.unavailable.add({
    field: 'meetings.hikeProbPct',
    reason: 'NO_SOURCE',
    detail: FED_PROBABILITY_DETAIL,
  });
  ctx.unavailable.add({
    field: 'meetings.cutProbPct',
    reason: 'NO_SOURCE',
    detail: FED_PROBABILITY_DETAIL,
  });

  // ── 7. the FOMC calendar ──────────────────────────────────────────────────────────────────
  const allMeetings = await ctx.data.econ.fomc();
  const window = allMeetings.slice(Math.max(0, allMeetings.length - params.meetings));
  const nextMeetingRow = window.find((m) => m.meetingDate >= asOfDate) ?? null;
  const lastChangeRow =
    [...allMeetings]
      .reverse()
      .find((m) => m.meetingDate < asOfDate && m.decisionBp !== null) ?? null;

  const policy: FedPolicy = {
    targetFrom:
      targetFrom === null
        ? blankCell('blank', 'PROVIDER_DOWN')
        : { ...numCell(targetFrom, rateState, effrProvIdx), live: { subject: 'r:EFFR', field: 'TARGET_FROM' } },
    targetTo:
      targetTo === null
        ? blankCell('blank', 'PROVIDER_DOWN')
        : { ...numCell(targetTo, rateState, effrProvIdx), live: { subject: 'r:EFFR', field: 'TARGET_TO' } },
    effectiveDate: effr?.effectiveDate ?? null,
    lastChange:
      lastChangeRow?.decisionBp == null
        ? null
        : { meetingDate: lastChangeRow.meetingDate, decisionBp: lastChangeRow.decisionBp },
    nextMeeting:
      nextMeetingRow === null
        ? null
        : {
            meetingDate: nextMeetingRow.meetingDate,
            statementAt: nextMeetingRow.statementAt,
            hasSep: nextMeetingRow.hasSep,
            businessDaysAway: businessDaysBetween(cal, asOfDate, nextMeetingRow.meetingDate),
          },
    // Structurally absent — see the header. `na`, no reason code, the detail in meta.unavailable.
    iorb: blankCell('na'),
    discountPrimary: blankCell('na'),
    provIdx: effrProvIdx,
  };

  // ── 4. the rate rows ──────────────────────────────────────────────────────────────────────
  const previous = new Map<string, RateFixing | undefined>();
  for (const code of FED_RATE_CODES) {
    previous.set(code, (await historyOrEmpty(ctx, code, 2))[1]);
  }

  const rates: FedRateRow[] = [];
  const subjects: string[] = [];
  for (const code of FED_RATE_CODES) {
    const fixing = byCode.get(code) ?? null;
    const subject = `r:${code}`;
    subjects.push(subject);
    if (fixing === null) {
      ctx.unavailable.add({
        field: `rates.${code}`,
        reason: 'NO_SOURCE',
        detail: `no ${code} fixing stored on or before ${asOfDate}`,
      });
      rates.push(emptyRateRow(code, asOfDate, subject));
      continue;
    }
    const provIdx = citeFixing(fixing);
    const prior = previous.get(code);
    const chg1d =
      fixing.rate === null || prior?.rate === undefined || prior.rate === null
        ? null
        : (fixing.rate - prior.rate) * 100;
    const spread = fixing.rate === null || targetMid === null ? null : (fixing.rate - targetMid) * 100;
    const cell = (v: number | null, field: FieldId): ValueCell =>
      v === null ? blankCell('na') : { ...numCell(v, rateState, provIdx), live: { subject, field } };
    if (fixing.rate === null) {
      ctx.unavailable.add({
        field: `rates.${code}.rate`,
        reason: 'NO_SOURCE',
        detail: `the stored ${code} fixing for ${fixing.effectiveDate} publishes no rate`,
      });
    }
    if (chg1d === null) {
      ctx.unavailable.add({
        field: 'rates.chg1dBp',
        reason: 'NO_SOURCE',
        detail: 'no prior stored fixing to difference against',
      });
    }
    if (spread === null) {
      ctx.unavailable.add({
        field: 'rates.spreadToMidBp',
        reason: 'NO_SOURCE',
        detail: 'no EFFR target range stored, so there is no midpoint to spread against',
      });
    }
    rates.push({
      rateCode: code,
      name: FED_RATE_LABELS[code],
      // `rate_fixings` carries no instrument link; the plant publishes a reference rate under the
      // `r:` family, so the subject is the rate code and the instrument id is honestly null.
      instrumentId: null,
      subject,
      effectiveDate: fixing.effectiveDate,
      rate: cell(fixing.rate, 'RATE'),
      p1: cell(fixing.pct1, 'RATE_P1'),
      p25: cell(fixing.pct25, 'RATE_P25'),
      p75: cell(fixing.pct75, 'RATE_P75'),
      p99: cell(fixing.pct99, 'RATE_P99'),
      volumeBn: cell(fixing.volumeBn, 'RATE_VOLUME_BN'),
      chg1dBp: chg1d === null ? blankCell('na') : numCell(chg1d, rateState, provIdx),
      spreadToMidBp: spread === null ? blankCell('na') : numCell(spread, rateState, provIdx),
      provIdx,
    });
  }
  ctx.plant.ensureHot(subjects);

  // ── SOFR averages ─────────────────────────────────────────────────────────────────────────
  const sofrai = byCode.get(SOFR_AVERAGES_CODE) ?? null;
  const sofraiProvIdx = sofrai === null ? -1 : citeFixing(sofrai);
  if (sofrai === null) {
    ctx.unavailable.add({
      field: 'sofrAverages',
      reason: 'NO_SOURCE',
      detail: `no ${SOFR_AVERAGES_CODE} row stored on or before ${asOfDate}`,
    });
  }
  const avgCell = (v: number | null | undefined): ValueCell =>
    v === null || v === undefined ? blankCell('na') : numCell(v, rateState, sofraiProvIdx);
  const sofrAverages: FedSofrAverages = {
    effectiveDate: sofrai?.effectiveDate ?? null,
    avg30d: avgCell(sofrai?.avg30d),
    avg90d: avgCell(sofrai?.avg90d),
    avg180d: avgCell(sofrai?.avg180d),
    indexValue: avgCell(sofrai?.indexValue),
    provIdx: sofraiProvIdx,
  };

  // ── 5. the history grid ───────────────────────────────────────────────────────────────────
  const history = await buildHistory(ctx, params.histDays);

  // ── 6. the H.15 block ─────────────────────────────────────────────────────────────────────
  const h15 = await buildH15(ctx, asOfDate);

  // ── 8. the implied path ───────────────────────────────────────────────────────────────────
  const futureDates = window.filter((m) => m.meetingDate >= asOfDate).map((m) => m.meetingDate);
  const pathRun =
    params.path && futureDates.length > 0 && sofr?.rate != null
      ? await buildPath(ctx, asOfDate, futureDates, sofr.rate, valuationTs)
      : null;
  if (pathRun === null) {
    ctx.unavailable.add({
      field: 'meetings.impliedRatePct',
      reason: params.path ? 'NO_SOURCE' : 'NOT_APPLICABLE',
      detail: params.path
        ? `no ${PATH_CURVE_ID} build, SOFR fixing or scheduled meeting to project from`
        : 'the implied path was not requested (path=false)',
    });
    ctx.unavailable.add({
      field: 'meetings.impliedMoveBp',
      reason: params.path ? 'NO_SOURCE' : 'NOT_APPLICABLE',
      detail: params.path
        ? `no ${PATH_CURVE_ID} build, SOFR fixing or scheduled meeting to project from`
        : 'the implied path was not requested (path=false)',
    });
    ctx.unavailable.add({
      field: 'meetings.cumulativeMoveBp',
      reason: params.path ? 'NO_SOURCE' : 'NOT_APPLICABLE',
      detail: params.path
        ? `no ${PATH_CURVE_ID} build, SOFR fixing or scheduled meeting to project from`
        : 'the implied path was not requested (path=false)',
    });
  }

  const pathProvIdx = pathRun?.provIdx ?? -1;
  const meetings: FedMeetingRow[] = window.map((m) => {
    const isPast = m.meetingDate < asOfDate;
    const leg = pathRun?.byDate.get(m.meetingDate);
    const empty = leg === undefined;
    return {
      meetingDate: m.meetingDate,
      statementAt: m.statementAt,
      hasSep: m.hasSep,
      isPast,
      isNext: nextMeetingRow !== null && m.meetingDate === nextMeetingRow.meetingDate,
      decisionBp: m.decisionBp,
      impliedRatePct: empty
        ? blankCell(isPast ? 'na' : 'blank', isPast ? 'NOT_IN_UNIVERSE' : 'PROVIDER_DOWN')
        : numCell(leg.impliedRate * 100, 'closed', pathProvIdx),
      impliedMoveBp: empty
        ? blankCell(isPast ? 'na' : 'blank', isPast ? 'NOT_IN_UNIVERSE' : 'PROVIDER_DOWN')
        : numCell(leg.stepBp, 'closed', pathProvIdx),
      cumulativeMoveBp: empty
        ? blankCell(isPast ? 'na' : 'blank', isPast ? 'NOT_IN_UNIVERSE' : 'PROVIDER_DOWN')
        : numCell(leg.moveBp, 'closed', pathProvIdx),
      hikeProbPct: null,
      cutProbPct: null,
      provIdx: citeMeeting(ctx, m, pathProvIdx),
    };
  });
  if (window.some((m) => m.meetingDate < asOfDate)) {
    for (const field of [
      'meetings.impliedRatePct',
      'meetings.impliedMoveBp',
      'meetings.cumulativeMoveBp',
    ]) {
      ctx.unavailable.add({
        field,
        reason: 'NOT_APPLICABLE',
        detail: 'a meeting that has already taken place carries its published decision, not a model rate',
      });
    }
  }
  if (window.some((m) => m.meetingDate >= asOfDate && m.decisionBp === null)) {
    ctx.unavailable.add({
      field: 'meetings.decisionBp',
      reason: 'NOT_APPLICABLE',
      detail: 'a decision is published when the meeting ends; a scheduled meeting has none',
    });
  }

  const path: FedPathBlock | null =
    pathRun === null
      ? null
      : {
          engine: pathRun.engine,
          curveId: PATH_CURVE_ID,
          curveDate: pathRun.curveDate,
          buildId: pathRun.buildId,
          spotRatePct: numCell(pathRun.spotPct, 'closed', pathRun.spotProvIdx),
          caveats: [FED_PROXY_CURVE, FED_NO_FUTURES_SOURCE],
        };

  // ── 9. the press feed ─────────────────────────────────────────────────────────────────────
  const press = await buildPress(ctx, params);

  return {
    variant: 'default',
    asOfDate,
    policy,
    rates,
    sofrAverages,
    history,
    h15,
    meetings,
    path,
    balanceSheet: null,
    press,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function latestOrNull(ctx: ResolveContext, code: string): Promise<RateFixing | null> {
  try {
    return await ctx.data.rates.latest(code);
  } catch (err) {
    if (err instanceof RateDataError) return null;
    throw err;
  }
}

async function historyOrEmpty(
  ctx: ResolveContext,
  code: string,
  days: number,
): Promise<RateFixing[]> {
  try {
    return await ctx.data.rates.history(code, days);
  } catch (err) {
    if (err instanceof RateDataError) return [];
    throw err;
  }
}

/**
 * Refresh the NY Fed fixings when the newest stored one is more than one `USGOVT` business day
 * behind (§FED step 2).
 *
 * A read-through that cannot fetch is a **staleness** signal, never a 503, because the fixings are
 * already stored: §FED reserves the 503 for "nothing stored at all", and that case never reaches
 * here — with no EFFR row the page degrades through `policy.targetFrom`'s own `NO_SOURCE` entry.
 */
async function refreshIfBehind(
  ctx: ResolveContext,
  cal: Calendar,
  asOfDate: IsoDate,
  effr: RateFixing | null,
): Promise<{ stale: boolean; refetched: boolean }> {
  if (effr === null) return { stale: false, refetched: false };
  if (businessDaysBetween(cal, effr.effectiveDate, asOfDate) <= 1) {
    return { stale: false, refetched: false };
  }
  try {
    const result = await ctx.providers.ensure('nyfed.rates', 'all/latest', {
      maxAgeMs: READ_THROUGH_MAX_AGE_MS,
    });
    return { stale: !result.fresh, refetched: result.fresh };
  } catch {
    // The circuit is open, or nothing is wired in this build. The stored rows are what is served,
    // and they are marked stale so the screen says so (TERM-12).
    return { stale: true, refetched: false };
  }
}

function citeMeeting(ctx: ResolveContext, m: FomcMeeting, fallback: number): number {
  if (m.provenanceId === null) return fallback;
  return ctx.prov.add({
    sourceId: 'fed.fomc',
    provenanceId: m.provenanceId,
    capturedAt: ctx.asOf.knownAt,
    sourceTs: null,
    st: 'closed',
    tier: STORED_TIER,
  });
}

function emptyRateRow(code: FedRateCode, asOfDate: string, subject: string): FedRateRow {
  const blank = (): ValueCell => blankCell('blank', 'PROVIDER_DOWN');
  return {
    rateCode: code,
    name: FED_RATE_LABELS[code],
    instrumentId: null,
    subject,
    effectiveDate: asOfDate,
    rate: blank(),
    p1: blank(),
    p25: blank(),
    p75: blank(),
    p99: blank(),
    volumeBn: blank(),
    chg1dBp: blank(),
    spreadToMidBp: blank(),
    provIdx: -1,
  };
}

/** One row per stored effective date, newest first; a code missing that date stays `null`. */
async function buildHistory(ctx: ResolveContext, days: number): Promise<FedHistoryRow[]> {
  const perCode = new Map<FedRateCode, RateFixing[]>();
  for (const code of FED_RATE_CODES) {
    perCode.set(code, await historyOrEmpty(ctx, code, days));
  }
  const dates = new Set<string>();
  for (const rows of perCode.values()) for (const row of rows) dates.add(row.effectiveDate);
  const ordered = [...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, days);

  const at = (code: FedRateCode, date: string): RateFixing | undefined =>
    perCode.get(code)?.find((r) => r.effectiveDate === date);

  return ordered.map((date): FedHistoryRow => {
    const effrRow = at('EFFR', date);
    return {
      date,
      effr: effrRow?.rate ?? null,
      sofr: at('SOFR', date)?.rate ?? null,
      obfr: at('OBFR', date)?.rate ?? null,
      tgcr: at('TGCR', date)?.rate ?? null,
      bgcr: at('BGCR', date)?.rate ?? null,
      targetFrom: effrRow?.targetFrom ?? null,
      targetTo: effrRow?.targetTo ?? null,
    };
  });
}

/** The H.15 constant-maturity grid with a one-day change column. */
async function buildH15(ctx: ResolveContext, asOfDate: string): Promise<FedH15Block> {
  let points: CurvePoints | null = null;
  try {
    points = await ctx.data.curves.points(CMT_CURVE_ID, asOfDate);
  } catch (err) {
    if (!(err instanceof CurveDataError)) throw err;
  }
  if (points === null) {
    ctx.unavailable.add({
      field: 'h15',
      reason: 'NO_SOURCE',
      detail: `no ${CMT_CURVE_ID} curve stored on or before ${asOfDate}`,
    });
    return { curveDate: null, priorDate: null, provIdx: -1, rows: [] };
  }

  const priorDate = points.availableDates.find((d) => d < points.curveDate) ?? null;
  let prior: CurvePoints | null = null;
  if (priorDate !== null) {
    try {
      prior = await ctx.data.curves.points(CMT_CURVE_ID, priorDate);
    } catch (err) {
      if (!(err instanceof CurveDataError)) throw err;
    }
  }
  const priorByTenor = new Map<string, number>();
  for (const p of prior?.points ?? []) priorByTenor.set(p.tenor, p.value);

  const anchor = points.points[0];
  const provIdx =
    anchor === undefined
      ? -1
      : ctx.prov.add({
          sourceId: points.sourceId,
          provenanceId: anchor.provenanceId,
          capturedAt: new Date(anchor.capturedAt),
          sourceTs: anchor.sourceTs === null ? null : new Date(anchor.sourceTs),
          st: 'closed',
          tier: STORED_TIER,
        });

  let missingPrior = false;
  const rows: FedH15Row[] = [...points.points]
    .sort((a, b) => a.tenorDays - b.tenorDays)
    .map((p): FedH15Row => {
      const before = priorByTenor.get(p.tenor);
      if (before === undefined) missingPrior = true;
      return {
        tenor: p.tenor,
        tenorDays: p.tenorDays,
        yieldPct: numCell(p.value, 'closed', provIdx),
        chg1dBp:
          before === undefined ? blankCell('na') : numCell((p.value - before) * 100, 'closed', provIdx),
      };
    });
  if (missingPrior) {
    ctx.unavailable.add({
      field: 'h15.chg1dBp',
      reason: 'NO_SOURCE',
      detail:
        priorDate === null
          ? `no ${CMT_CURVE_ID} curve stored before ${points.curveDate}`
          : `the ${priorDate} ${CMT_CURVE_ID} curve does not publish every tenor of ${points.curveDate}`,
    });
  }

  return { curveDate: points.curveDate, priorDate, provIdx, rows };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The implied path (ANAL-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface PathRun {
  engine: { name: string; version: string; inputsHash: string };
  curveDate: string;
  buildId: number;
  provIdx: number;
  spotPct: number;
  spotProvIdx: number;
  byDate: Map<string, { impliedRate: number; moveBp: number; stepBp: number }>;
}

/**
 * The piecewise-constant overnight rate between FOMC dates that reprices the `SOFR_OIS` build's
 * forward discount factors, anchored on today's SOFR fixing.
 *
 * `currentRate` is the SOFR spot, so the engine's `moveBp` is §FED's `cumulativeMoveBp`:
 * `(implied[i] − spot) × 100`.
 *
 * **`stepBp` is the successive difference of that cumulative, not the engine's `incrementalBp`.**
 * §FED step 8 defines `impliedMoveBp = (implied[i] − implied[i−1]) × 100`, and for `i ≥ 1` the
 * engine's `incrementalBp` is exactly that. For `i = 0` it is not: `incrementalBp` measures from
 * `rateBefore`, the curve's own forward from the curve date to the first effective date (3.6172 %
 * on the golden's data), while `moveBp` measures from the SOFR fixing the path is anchored on
 * (3.62 %). Publishing both gave the first meeting a "move" of −7.417 bp and a "cumulative move"
 * of −7.694 bp — two names for the same quantity disagreeing by the 0.278 bp of spot basis — and
 * left the column footing 0.278 bp short of its own total. One anchor governs the row: the step is
 * `cum[i] − cum[i−1]` with `cum[−1] = 0`, so `impliedMoveBp[0] === cumulativeMoveBp[0]` and
 * `Σ impliedMoveBp === cumulativeMoveBp[last]` exactly, which is what WIRP's `stepChangeBp` does
 * on the identical engine run. The engine's own `spotBasisBp` remains the place that basis is
 * reported; it is not smuggled into a meeting's move.
 */
async function buildPath(
  ctx: ResolveContext,
  asOfDate: string,
  meetingDates: readonly string[],
  spotRatePct: number,
  valuationTs: string,
): Promise<PathRun | null> {
  let points: CurvePoints | null = null;
  try {
    points = await ctx.data.curves.points(PATH_CURVE_ID, asOfDate);
  } catch (err) {
    if (!(err instanceof CurveDataError)) throw err;
    return null;
  }
  if (points === null) return null;

  let build: CurveBuild;
  try {
    build = await ctx.data.curves.build(PATH_CURVE_ID, points.curveDate, 'monotone_convex');
  } catch (err) {
    if (!(err instanceof CurveDataError)) throw err;
    return null;
  }
  ctx.engines.add(build.engine);

  const anchor = points.points[0];
  const provIdx =
    anchor === undefined
      ? -1
      : ctx.prov.add({
          sourceId: points.sourceId,
          provenanceId: anchor.provenanceId,
          capturedAt: new Date(anchor.capturedAt),
          sourceTs: anchor.sourceTs === null ? null : new Date(anchor.sourceTs),
          st: 'closed',
          tier: STORED_TIER,
        });

  const inputs: PolicyPathInputs = {
    curveId: build.curveId,
    curveDate: build.curveDate,
    points: build.nodes.map((n) => ({ t: n.t, df: n.df })),
    meetings: meetingDates,
    currentRate: spotRatePct / 100,
    // Fixed here, not read off the build: `data/curves.ts` bootstraps a fresh OIS curve as
    // `continuous` and re-hydrates a cached one as `curves.compounding`, so reading the basis off
    // the build would answer the same request differently on a cache miss and a cache hit. The
    // money-market forward is ACT/360 simple by definition (§0).
    dayCount: 'ACT/360',
    compounding: 'simple',
    interpolation: interpolationName(build.interpolation),
  };
  const result = policyPathEngine(inputs, valuationTs);
  ctx.engines.add(engineMeta(result));

  const byDate = new Map<string, { impliedRate: number; moveBp: number; stepBp: number }>();
  let previousCum = 0;
  for (const m of result.outputs.meetings) {
    byDate.set(m.meetingDate, {
      impliedRate: m.impliedRate,
      moveBp: m.moveBp,
      stepBp: m.moveBp - previousCum,
    });
    previousCum = m.moveBp;
  }
  return {
    engine: engineMeta(result),
    curveDate: build.curveDate,
    buildId: build.buildId,
    provIdx,
    spotPct: result.outputs.currentRate * 100,
    spotProvIdx: provIdx,
    byDate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Press (§FED step 9)
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function buildPress(ctx: ResolveContext, params: FedParams): Promise<FedPressItem[]> {
  if (params.view === 'press') {
    try {
      await ctx.providers.ensure('fed.rss', PRESS_FEED, { maxAgeMs: READ_THROUGH_MAX_AGE_MS });
    } catch {
      // Nothing to fetch, or the circuit is open: the stored items are what the page serves.
    }
  }
  const found = await ctx.data.news.search({
    feed: PRESS_FEED,
    limit: Math.max(params.pressLimit, PRESS_MIN_FETCH),
  });
  const filtered = found.items
    .filter((item) => fedCategoryMatches(item.category, params.category))
    .slice(0, params.pressLimit);
  if (filtered.length === 0) {
    ctx.unavailable.add({
      field: 'press',
      reason: 'NO_SOURCE',
      detail: `no fed.rss items for category ${params.category}`,
    });
    return [];
  }
  return filtered.map((item: NewsItem): FedPressItem => {
    const provIdx = ctx.prov.add({
      sourceId: item.sourceId,
      provenanceId: item.provenanceId,
      capturedAt: new Date(item.capturedAt),
      sourceTs: item.sourceTs === null ? null : new Date(item.sourceTs),
      st: 'closed',
      tier: STORED_TIER,
    });
    return {
      newsId: item.newsId,
      headline: item.headline,
      summary: item.summary,
      category: item.category,
      publishedAt: item.publishedAt,
      url: item.url,
      kind: item.kind === 'fed_release' ? 'fed_release' : 'press_release',
      isCorrection: item.isCorrection,
      provIdx,
    };
  });
}
