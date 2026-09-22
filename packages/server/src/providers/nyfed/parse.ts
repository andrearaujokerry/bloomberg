/**
 * `nyfed.rates` — the pure half (PROVIDERS §10.4).
 *
 * One parser for all three endpoints, because all three answer with the same envelope:
 * `{"refRates":[ … ]}`, one element per `(type, effectiveDate)`. `/all/latest.json` carries the
 * six current fixings, `/secured/sofr/last/{n}.json` and `/unsecured/effr/last/{n}.json` carry one
 * type over n days.
 *
 * Six rate types, and `SOFRAI` is the odd one: the SOFR Averages and Index carries **no**
 * `percentRate` and no percentiles, only the three averages and the index level. `rate` stays
 * `NULL` and `r:SOFRAI` publishes no `RATE` field, so the screen shows `—` rather than a
 * fabricated zero.
 *
 * PURITY (PROVIDERS §1.2, QA-05): no IO, no clock, no randomness, and `JSON.parse` is the only
 * thing here that could throw, so it is the only thing wrapped. `sourceTs` is `null` on purpose —
 * the payload publishes no instant of its own, only effective dates, and inventing 08:00 ET from
 * `rate_terms.publication_time_et` would put a guess in `provenance.source_ts`.
 */

import type { NormalisedUpdate, QuoteFields } from '@terminal/core';

import type { Normalised, NormaliseContext, NormaliseProblem, RawRecord } from '../types.js';

/** `provenance.adapter_version` (PROVIDERS §1.4). */
export const NYFED_ADAPTER_VERSION = 'nyfed/1.0.0';

/** `curves.curve_id` of the SOFR fixing curve. */
export const SOFR_FIX_CURVE_ID = 'SOFR_FIX';

/** The six `rate_fixings.rate_code` values the API publishes. */
export const RATE_CODES = ['SOFR', 'EFFR', 'OBFR', 'TGCR', 'BGCR', 'SOFRAI'] as const;

export type RateCode = (typeof RATE_CODES)[number];

const RATE_CODE_SET: ReadonlySet<string> = new Set<string>(RATE_CODES);

export function isRateCode(value: string): value is RateCode {
  return RATE_CODE_SET.has(value);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One `rate_fixings` row, less `is_latest` and `provenance_id` (the ingest upsert owns them). */
export interface RateFixingRow {
  rateCode: RateCode;
  effectiveDate: string;
  /** ISO instant — `raw.capturedAt`. A non-empty `revisionIndicator` always opens a new vintage. */
  vintageAt: string;
  /** `percentRate`; `null` for `SOFRAI`, which publishes none. */
  rate: number | null;
  pct1: number | null;
  pct25: number | null;
  pct75: number | null;
  pct99: number | null;
  volumeBn: number | null;
  /** EFFR only in practice; kept for any type that publishes it. */
  targetFrom: number | null;
  targetTo: number | null;
  avg30d: number | null;
  avg90d: number | null;
  avg180d: number | null;
  indexValue: number | null;
  revisionIndicator: string;
}

/** One `curve_points` row on `SOFR_FIX` — the overnight fixing as a curve point. */
export interface FixingCurvePointRow {
  curveId: string;
  curveDate: string;
  tenor: 'ON';
  quoteType: 'fixing';
  vintageAt: string;
  tenorDays: number;
  value: number;
  instrumentId: null;
  maturityDate: null;
}

export interface NyFedRatesRows {
  fixings: RateFixingRow[];
  curvePoints: FixingCurvePointRow[];
}

function failure(detail: string, path: string): Normalised<NyFedRatesRows> {
  return {
    updates: [],
    rows: { fixings: [], curvePoints: [] },
    sourceTs: null,
    problems: [{ kind: 'parse_error', detail, path }],
  };
}

/** A finite number from an unknown JSON value, or `null`. Never `NaN`, never a coerced `''`. */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * `nyfed-all`, `nyfed-sofr`, `nyfed-effr.json` → `rate_fixings` + `curve_points('SOFR_FIX')`,
 * plus one `r:<rateCode>` update per resolved md line.
 *
 * `md_lines` for this source are keyed by the type itself (`provider_symbol 'SOFR'`), so the
 * subject is derivable from the payload and the updates are emitted here rather than by the job —
 * unlike `fred.csv` and `fed.h15`, whose `e:<seriesCode>` subjects only the job can name. A
 * response carrying several days publishes the **latest** day to the plant and every day to the
 * tables: the plant holds a current value, the tables hold the history.
 */
export function parseRefRates(raw: RawRecord, ctx: NormaliseContext): Normalised<NyFedRatesRows> {
  let document: unknown;
  try {
    document = JSON.parse(raw.body.toString('utf8'));
  } catch (error) {
    return failure(
      `the body is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      '/',
    );
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return failure('the payload is not a JSON object', '/');
  }
  const refRates = (document as { refRates?: unknown }).refRates;
  if (!Array.isArray(refRates)) {
    return failure("the payload carries no 'refRates' array", '/refRates');
  }

  const problems: NormaliseProblem[] = [];
  const rows: NyFedRatesRows = { fixings: [], curvePoints: [] };
  const vintageAt = new Date(raw.capturedAt).toISOString();

  refRates.forEach((entry: unknown, index: number) => {
    const path = `/refRates/${String(index)}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push({ kind: 'parse_error', detail: 'refRates element is not an object', path });
      return;
    }
    const record = entry as Record<string, unknown>;
    const type = str(record.type).trim().toUpperCase();
    if (!isRateCode(type)) {
      problems.push({
        kind: 'schema_drift',
        detail: `unknown rate type '${type}' — the six published types are ${RATE_CODES.join(', ')}`,
        path: `${path}/type`,
      });
      return;
    }
    const effectiveDate = str(record.effectiveDate).trim();
    if (!ISO_DATE_RE.test(effectiveDate)) {
      problems.push({
        kind: 'parse_error',
        detail: `effectiveDate '${effectiveDate}' is not an ISO date`,
        path: `${path}/effectiveDate`,
      });
      return;
    }

    const rate = num(record.percentRate);
    let pct1 = num(record.percentPercentile1);
    let pct25 = num(record.percentPercentile25);
    let pct75 = num(record.percentPercentile75);
    let pct99 = num(record.percentPercentile99);

    if (type === 'SOFRAI') {
      // §10.4: SOFRAI carries no rate and no percentiles. Anything else is the API changing shape.
      if (rate !== null || pct1 !== null || pct99 !== null) {
        problems.push({
          kind: 'schema_drift',
          detail: 'SOFRAI published a percentRate or percentiles, which it never has',
          path,
        });
      }
    }

    // §10.4: a percentile band that excludes the rate it describes is a broken payload — the
    // percentiles are dropped and the rate is kept.
    if (rate !== null && ((pct1 !== null && pct1 > rate) || (pct99 !== null && pct99 < rate))) {
      problems.push({
        kind: 'parse_error',
        detail: `${type} ${effectiveDate}: the percentile band [${String(pct1)}, ${String(pct99)}] excludes the rate ${String(rate)}; percentiles dropped, rate kept`,
        path,
      });
      pct1 = null;
      pct25 = null;
      pct75 = null;
      pct99 = null;
    }

    const targetFrom = num(record.targetRateFrom);
    const targetTo = num(record.targetRateTo);
    if (type !== 'EFFR' && (targetFrom !== null || targetTo !== null)) {
      problems.push({
        kind: 'schema_drift',
        detail: `${type} published a target range, which §10.4 records on EFFR alone; the values are stored`,
        path,
      });
    }

    const fixing: RateFixingRow = {
      rateCode: type,
      effectiveDate,
      vintageAt,
      rate: type === 'SOFRAI' ? null : rate,
      pct1,
      pct25,
      pct75,
      pct99,
      volumeBn: num(record.volumeInBillions),
      targetFrom,
      targetTo,
      avg30d: num(record.average30day),
      avg90d: num(record.average90day),
      avg180d: num(record.average180day),
      indexValue: num(record.index),
      revisionIndicator: str(record.revisionIndicator),
    };
    rows.fixings.push(fixing);

    if (type === 'SOFR' && fixing.rate !== null) {
      rows.curvePoints.push({
        curveId: SOFR_FIX_CURVE_ID,
        curveDate: effectiveDate,
        tenor: 'ON',
        quoteType: 'fixing',
        vintageAt,
        tenorDays: 1,
        value: fixing.rate,
        instrumentId: null,
        maturityDate: null,
      });
    }
  });

  // The plant gets one update per type: the latest effective date this body carries.
  const latest = new Map<RateCode, RateFixingRow>();
  for (const fixing of rows.fixings) {
    const held = latest.get(fixing.rateCode);
    if (held === undefined || fixing.effectiveDate >= held.effectiveDate) {
      latest.set(fixing.rateCode, fixing);
    }
  }

  const updates: NormalisedUpdate[] = [];
  for (const [symbol, line] of ctx.lines) {
    const code = symbol.trim().toUpperCase();
    if (!isRateCode(code)) continue;
    const fixing = latest.get(code);
    if (fixing === undefined) continue;
    const fields: QuoteFields = {};
    if (fixing.rate !== null) fields.RATE = fixing.rate;
    if (fixing.pct1 !== null) fields.RATE_P1 = fixing.pct1;
    if (fixing.pct25 !== null) fields.RATE_P25 = fixing.pct25;
    if (fixing.pct75 !== null) fields.RATE_P75 = fixing.pct75;
    if (fixing.pct99 !== null) fields.RATE_P99 = fixing.pct99;
    if (fixing.volumeBn !== null) fields.RATE_VOLUME_BN = fixing.volumeBn;
    if (fixing.targetFrom !== null) fields.TARGET_FROM = fixing.targetFrom;
    if (fixing.targetTo !== null) fields.TARGET_TO = fixing.targetTo;
    if (Object.keys(fields).length === 0) continue;
    updates.push({
      subject: `r:${code}`,
      instrumentId: line.instrumentId,
      mdLineId: line.mdLineId,
      assetClass: line.assetClass,
      tier: line.tier,
      fields,
      // The payload publishes no instant, only an effective date (§10.4) — `src` stays null and
      // FEED-05's `cap` carries the age the screen shows.
      ts: { src: null, cap: raw.capturedAt, pub: 0 },
      prov: { sourceId: 'nyfed.rates', provenanceId: ctx.provenanceId },
      session: 'closed',
    });
  }

  if (refRates.length > 0 && rows.fixings.length === 0) {
    problems.push({
      kind: 'schema_drift',
      detail: `${String(refRates.length)} refRates elements yielded no fixing`,
      path: '/refRates',
    });
  }

  return { updates, rows, sourceTs: null, problems };
}
