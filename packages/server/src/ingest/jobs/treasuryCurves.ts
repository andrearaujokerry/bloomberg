/**
 * `ingest/jobs/treasuryCurves.ts` — the daily US Treasury curve run (PROVIDERS §9.1, §9.2, §13).
 *
 * §13 row `treasuryCurves`: providers `treasury.yieldcurve` + `treasury.bills`, schedule
 * `'0 18 * * 1-5'` in America/New_York, target "the current month's XML for both datasets",
 * priority 2, `timeoutMs` 120 000.
 *
 * **Why off-peak and why two minutes.** The Treasury OData service answers a yield-curve request
 * in about 18 seconds, the bills request in about the same, and the per-provider bucket is one
 * request a minute (PROVIDERS §2.2). Two requests through that bucket is ≈ 80 s of wall clock, so
 * the job is scheduled at 18:00 ET — after the 17:00 publication and outside any session — and the
 * adapters carry a six-hour cache TTL (`TREASURY_CACHE_TTL_MS`) so that an accidental second call
 * inside the same evening is served from the store rather than paying 18 s again. The TTL can
 * never suppress the scheduled run: 6 h < 24 h.
 *
 * **One request covers a month.** `field_tdr_date_value_month=YYYYMM` returns every business day
 * of the month in one feed, so "today's curve" and "the month so far" cost the same and a re-run
 * after a mid-month outage back-fills by itself. {@link TreasuryCurvesContext.months} names other
 * months for a back-fill; the default is the month of `ctx.clock.now()`.
 *
 * ## What it writes
 *
 *  1. **`curve_points`** on `UST_PAR` (14 par tenors) and `UST_BILL` (7 tenors × discount rate and
 *     investment yield). Both are *vintaged*: the primary key carries `vintage_at`, so a Treasury
 *     correction to a published day adds a row and clears `is_latest` on the one it replaces —
 *     {@link upsertCurvePoints}. Replaying the same capture writes nothing, because `vintage_at`
 *     is the capture instant and a recorded capture carries the same one for ever.
 *  2. **The security master for bills** (§9.2 — this is the adapter that mints government
 *     instruments): the `US Treasury` issuer, one `issues` + `instruments` row per CUSIP with
 *     `ticker = CUSIP`, `identifiers(scheme 'CUSIP')`, and one `md_lines` row per *term label*
 *     (`'13WK'`), re-pointed at the new CUSIP when the on-the-run bill rolls.
 *  3. **`govt_terms`** through `upsertVersion`: `security_type 'bill'`, `coupon_type 'zero'`,
 *     `day_count 'ACT/360'`, `calendar_id 'USGOVT'`, `on_the_run true` — and a `writeVersion` with
 *     `on_the_run false` for the CUSIP a roll displaced, which is the transition SRCH and YAS key
 *     on. The roll set is seeded from `govt_terms` as well as from the capture
 *     ({@link heldOnTheRunByLabel}), because a month's feed does not contain the bill the *previous*
 *     month's on-the-run rolled off from, and a demotion derived from one capture alone left a
 *     rolled-off bill claiming the label for ever.
 *
 * ## Determinism (ANAL-08, QA-02)
 *
 * Nothing here reads a wall clock except the *choice of month*. `vintage_at` is `raw.capturedAt`;
 * the bitemporal `valid_from` of a bill is midnight UTC of the first curve date the CUSIP was
 * published on, and its `tx_from` is the capture instant — both functions of the bytes. So two
 * runs over the same captures produce byte-identical rows, and the second writes none.
 *
 * **Replay is a wall.** With no `HttpClient` wired, {@link fetchThrough} reads the recorded
 * capture; a key the store does not hold throws `ReplayMissError`, which is recorded as a fetch
 * error on the run and never becomes a socket.
 */

import { sql } from 'drizzle-orm';

import {
  BILL_RATES_DATASET,
  YIELD_CURVE_DATASET,
  monthOfIsoDate,
  treasuryBillsAdapter,
  treasuryUrl,
  treasuryYieldCurveAdapter,
} from '../../providers/treasury/adapter.js';
import {
  TREASURY_ADAPTER_VERSION,
  UST_BILL_CURVE_ID,
  UST_PAR_CURVE_ID,
  parseBillRates,
  parseYieldCurve,
} from '../../providers/treasury/parse.js';
import { insertProvenance } from '../../providers/provenance.js';
import { identifierRepository } from '../../refdata/identifiers.js';
import { masterRepositories } from '../../refdata/master.js';
import { TermsRepository } from '../../refdata/terms.js';
import {
  emptyResult,
  fetchError,
  fetchThrough,
  linesOf,
  noCounts,
  numericIn,
  provenanceMeta,
  publish,
  requestEnvelope,
  resolveTargets,
  tally,
  withIngestRun,
} from './cboeQuotes.js';
import { recordDqEvent } from './secNport.js';

import type { Tx } from '../../db/client.js';
import type { MarketJobContext, MarketJobResult, WriteCounts } from './cboeQuotes.js';
import type { NormaliseContext, NormaliseLine, ProviderId, RawRecord } from '../../providers/types.js';
import type { BillRow } from '../../providers/treasury/parse.js';
import type { GovtTermsRow, TermsData } from '../../refdata/terms.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The scheduler row (PROVIDERS §13)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** §13: 18:00 ET on weekdays — after the ≈17:00 ET publication, outside every session. */
export const TREASURY_CURVES_SCHEDULE = '0 18 * * 1-5';
/** Two requests through a one-a-minute bucket, each ≈18 s of Treasury OData. */
export const TREASURY_CURVES_TIMEOUT_MS = 120_000;

export const YIELD_CURVE_SOURCE_ID = 'treasury.yieldcurve' satisfies ProviderId;
export const BILLS_SOURCE_ID = 'treasury.bills' satisfies ProviderId;

/** §9.2: the bill md line is keyed by the *term label*, one day apart, `priority 30`. */
export const BILL_LINE_INTERVAL_MS = 86_400_000;
export const BILL_LINE_PRIORITY = 30;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `curves` — the definitions this job's points hang off
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `curves` row. `curve_points.curve_id` is a foreign key, so the definition comes first. */
export interface CurveDefinition {
  curveId: string;
  name: string;
  currency: string;
  kind: 'par' | 'bill' | 'cmt' | 'fixing' | 'ois' | 'zero';
  dayCount: string;
  compounding: 'semiannual' | 'annual' | 'simple' | 'continuous';
  sourceId: string;
  defaultInterpolation?: 'linear_zero' | 'log_linear_df' | 'monotone_convex';
}

/** The two curves this job publishes (DATA_MODEL L1466, PROVIDERS §9.1/§9.2). */
export const TREASURY_CURVE_DEFINITIONS: readonly CurveDefinition[] = Object.freeze([
  {
    curveId: UST_PAR_CURVE_ID,
    name: 'US Treasury par yields',
    currency: 'USD',
    kind: 'par',
    dayCount: 'ACT/ACT',
    compounding: 'semiannual',
    sourceId: YIELD_CURVE_SOURCE_ID,
  },
  {
    curveId: UST_BILL_CURVE_ID,
    name: 'US Treasury bills',
    currency: 'USD',
    kind: 'bill',
    dayCount: 'ACT/360',
    compounding: 'simple',
    sourceId: BILLS_SOURCE_ID,
  },
]);

/**
 * Insert the `curves` rows that are missing, leaving any that exist exactly as they are.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert on purpose: the definition carries the day count
 * and compounding every bootstrap reads, and a job quietly re-stating them would silently
 * re-price every historical build. A genuine change to a curve definition is a migration.
 *
 * @returns the number of definitions actually inserted.
 */
export async function ensureCurves(
  tx: Tx,
  definitions: readonly CurveDefinition[] = TREASURY_CURVE_DEFINITIONS,
): Promise<number> {
  let inserted = 0;
  for (const def of definitions) {
    const rows = await tx.execute<{ curve_id: string }>(sql`
      INSERT INTO curves (curve_id, name, currency, kind, day_count, compounding, source_id,
                          default_interpolation)
      VALUES (${def.curveId}, ${def.name}, ${def.currency}, ${def.kind}, ${def.dayCount},
              ${def.compounding}, ${def.sourceId},
              ${def.defaultInterpolation ?? 'monotone_convex'})
      ON CONFLICT (curve_id) DO NOTHING
      RETURNING curve_id`);
    inserted += rows.rows.length;
  }
  return inserted;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `curve_points` — the vintaged write
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `curve_points.value` is `numeric(12,8)`; every comparison below is made at that scale. */
export const CURVE_VALUE_SCALE = 8;

/** The `curve_points_quote_type_check` enum, verbatim (migration 0009). */
export type CurveQuoteType =
  | 'par_yield'
  | 'discount_rate'
  | 'investment_yield'
  | 'cmt_yield'
  | 'ois_rate'
  | 'zero_rate'
  | 'fixing';

/**
 * One `curve_points` row as any producer hands it over — the Treasury parsers' `CurvePointRow`,
 * the NY Fed's `FixingCurvePointRow` and H.15's `CmtCurvePointRow` are all assignable to it. The
 * writer is shared on purpose: the vintage rule below is the *table's* rule, not the Treasury's,
 * and four copies of it would be four chances to get `is_latest` wrong.
 */
export interface CurvePointWrite {
  curveId: string;
  curveDate: string;
  tenor: string;
  quoteType: CurveQuoteType;
  vintageAt: string;
  tenorDays: number;
  value: number;
  instrumentId: number | null;
  maturityDate: string | null;
}

/**
 * Upsert vintaged curve points.
 *
 * The rule, which is the same one `econ_observations` and `rate_fixings` follow:
 *
 *  - no `is_latest` row for `(curve_id, curve_date, tenor, quote_type)` → **insert** it;
 *  - one exists and carries the same value → **nothing**, however many times it is replayed;
 *  - one exists with a different value and an *earlier* vintage → clear its `is_latest` and
 *    **insert a new vintage**. The old row stays readable: "what did the curve say on the 3rd,
 *    as known on the 3rd?" is a question `curve_points` is keyed to answer.
 *
 * A point whose vintage is not newer than the stored one is **dropped**, not written: that is a
 * cached or out-of-order response, and overwriting a later belief with an earlier one would make
 * the table depend on delivery order. The drop is counted in `unchanged`.
 *
 * Values are compared as `numeric(12,8)` text, never as binary64: `3.9` and `3.90` are the same
 * curve point and `0.1 + 0.2` is not a reason to open a vintage.
 */
export async function upsertCurvePoints(
  tx: Tx,
  rows: readonly CurvePointWrite[],
  provenanceId: number,
): Promise<WriteCounts> {
  const counts = noCounts();
  if (rows.length === 0) return counts;

  const curveIds = [...new Set(rows.map((r) => r.curveId))].sort();
  const dates = [...new Set(rows.map((r) => r.curveDate))].sort();
  const existing = await tx.execute<{
    curve_id: string;
    curve_date: string;
    tenor: string;
    quote_type: string;
    vintage_at: string;
    value: string;
  }>(sql`
    SELECT curve_id, curve_date::text AS curve_date, tenor, quote_type,
           vintage_at::text AS vintage_at, value::text AS value
      FROM curve_points
     WHERE is_latest
       AND curve_id = ANY(${sql.param(curveIds)}::text[])
       AND curve_date = ANY(${sql.param(dates)}::date[])`);

  const held = new Map<string, { vintageAt: number; value: string }>();
  for (const row of existing.rows) {
    held.set(`${row.curve_id}|${row.curve_date}|${row.tenor}|${row.quote_type}`, {
      vintageAt: Date.parse(row.vintage_at),
      value: row.value,
    });
  }

  for (const row of rows) {
    const key = `${row.curveId}|${row.curveDate}|${row.tenor}|${row.quoteType}`;
    const value = numericIn(row.value, CURVE_VALUE_SCALE);
    if (value === null) {
      counts.unchanged += 1;
      continue;
    }
    const current = held.get(key);
    const vintageAt = Date.parse(row.vintageAt);

    if (current !== undefined) {
      if (sameNumeric(current.value, value)) {
        counts.unchanged += 1;
        continue;
      }
      if (vintageAt <= current.vintageAt) {
        // An older belief arriving after a newer one: a cached edge response, not a revision.
        counts.unchanged += 1;
        continue;
      }
      await tx.execute(sql`
        UPDATE curve_points SET is_latest = false
         WHERE curve_id = ${row.curveId} AND curve_date = ${row.curveDate}::date
           AND tenor = ${row.tenor} AND quote_type = ${row.quoteType} AND is_latest`);
      counts.updated += 1;
    }

    await tx.execute(sql`
      INSERT INTO curve_points (curve_id, curve_date, tenor, quote_type, vintage_at, tenor_days,
                                value, instrument_id, maturity_date, is_latest, provenance_id)
      VALUES (${row.curveId}, ${row.curveDate}::date, ${row.tenor}, ${row.quoteType},
              ${row.vintageAt}::timestamptz, ${row.tenorDays}, ${value}::numeric,
              ${row.instrumentId}::bigint, ${row.maturityDate}::date, true,
              ${provenanceId}::bigint)
      ON CONFLICT (curve_id, curve_date, tenor, quote_type, vintage_at) DO NOTHING`);
    counts.inserted += 1;
    held.set(key, { vintageAt, value });
  }
  return counts;
}

/** `'3.9'` and `'3.90000000'` are the same number; `numeric` text comparison alone is not. */
function sameNumeric(a: string, b: string): boolean {
  return Number(a) === Number(b);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The bill security master (PROVIDERS §9.2 write #2 and #3)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The issuer every Treasury bill hangs off. Found by name; minted once. */
export const TREASURY_ISSUER_NAME = 'United States Department of the Treasury';

/** What the job learned about one CUSIP across the whole month in one capture. */
export interface BillSecurity {
  cusip: string;
  /** The label the bill was on the run for — `'13WK'`. */
  termLabel: string;
  maturityDate: string;
  /** The first curve date this CUSIP was published on: the bitemporal `valid_from`. */
  firstCurveDate: string;
  /** The last curve date it was published on — the roll test. */
  lastCurveDate: string;
}

/**
 * Fold the parsed bill rows into one record per CUSIP, in ascending CUSIP order.
 *
 * Ordering is not cosmetic: the instruments are minted in this order, so `instrument_id` is a
 * function of the capture rather than of Postgres' scan order, and the golden of a downstream
 * screen does not move when the planner changes its mind.
 */
export function billSecurities(bills: readonly BillRow[]): BillSecurity[] {
  const byCusip = new Map<string, BillSecurity>();
  for (const bill of bills) {
    if (bill.cusip === null || bill.maturityDate === null) continue;
    const held = byCusip.get(bill.cusip);
    if (held === undefined) {
      byCusip.set(bill.cusip, {
        cusip: bill.cusip,
        termLabel: bill.termLabel,
        maturityDate: bill.maturityDate,
        firstCurveDate: bill.curveDate,
        lastCurveDate: bill.curveDate,
      });
      continue;
    }
    if (bill.curveDate < held.firstCurveDate) held.firstCurveDate = bill.curveDate;
    if (bill.curveDate > held.lastCurveDate) {
      held.lastCurveDate = bill.curveDate;
      held.termLabel = bill.termLabel;
    }
  }
  return [...byCusip.values()].sort((a, b) => (a.cusip < b.cusip ? -1 : 1));
}

/** The CUSIP on the run for each term label — the latest curve date wins. */
export function onTheRunByLabel(securities: readonly BillSecurity[]): Map<string, BillSecurity> {
  const out = new Map<string, BillSecurity>();
  for (const security of securities) {
    const held = out.get(security.termLabel);
    if (held === undefined || security.lastCurveDate > held.lastCurveDate) {
      out.set(security.termLabel, security);
    }
  }
  return out;
}

/** What {@link mintBillSecurities} did, so the job can report it and a test can measure it. */
export interface BillMasterResult {
  instrumentByCusip: Map<string, number>;
  mdLineByLabel: Map<string, number>;
  issuerId: number;
  instrumentsCreated: number;
  termsWritten: number;
  mdLinesWritten: number;
  rolls: { termLabel: string; from: string; to: string }[];
}

/**
 * `govt_terms` for one bill. Every column of the table is stated: `TermsData` is a complete
 * statement of the terms at an instant (a partial one would re-open the key with defaults for
 * whatever it left out), and every value below is either read from the feed or fixed by §9.2.
 */
function billTerms(security: BillSecurity, onTheRun: boolean): TermsData<'govt'> {
  return {
    securityType: 'bill',
    cusip: security.cusip,
    termLabel: security.termLabel,
    // The feed publishes no issue or dated date for a bill; NULL is the truth, not a guess.
    issueDate: null,
    datedDate: null,
    maturityDate: security.maturityDate,
    couponType: 'zero',
    couponRate: null,
    couponFreq: 0,
    dayCount: 'ACT/360',
    firstCouponDate: null,
    lastRegularCoupon: null,
    businessDayConv: 'following',
    calendarId: 'USGOVT',
    settlementDays: 1,
    referenceIndex: null,
    spreadBp: null,
    indexRatioBase: null,
    isCallable: false,
    callSchedule: [],
    putSchedule: [],
    sinkSchedule: [],
    amortisation: [],
    makeWhole: null,
    covenants: null,
    guarantors: [],
    seniority: 'sovereign',
    collateral: null,
    minDenomination: '100.00',
    increment: '100.00',
    amountOutstanding: null,
    onTheRun,
  };
}

/** `912797VE4` → a name a human recognises on DES without inventing anything. */
function billName(security: BillSecurity): string {
  return `United States Treasury Bill ${security.termLabel} ${security.maturityDate}`;
}

/**
 * Mint (or find) the issuer, issue, instrument, CUSIP identifier, `md_lines` row and `govt_terms`
 * version behind every bill in the capture — PROVIDERS §9.2 writes 2 and 3.
 *
 * Idempotent in every part: the identifier lookup finds an instrument minted by an earlier run,
 * and every version write is an `upsertVersion`, which returns `null` when the current version
 * already says exactly this. A second run therefore creates nothing and writes no version.
 *
 * **The demotion spans captures.** `on_the_run` is what SRCH's `onTheRun: 'only'` filter and YAS's
 * label read directly, so at most one CUSIP per term label may hold it. Deriving the demotion from
 * this capture alone was not enough: the feed is asked for `field_tdr_date_value_month=YYYYMM`, so
 * on 1 October the September on-the-run bills are simply not in the file, are never visited by the
 * write loop, and stay `on_the_run = true` for ever — two current 4WK bills, and SRCH showing both.
 * {@link heldOnTheRunByLabel} therefore seeds the roll set from `govt_terms` as well as from
 * `securities`, and a CUSIP the database still calls on-the-run that this capture no longer names
 * as its label's on-the-run bill is demoted from the roll date.
 */
export async function mintBillSecurities(
  tx: Tx,
  securities: readonly BillSecurity[],
  o: { provenanceId: number; knownAt: Date },
): Promise<BillMasterResult> {
  const master = masterRepositories(tx);
  const identifiers = identifierRepository(tx);
  const terms = new TermsRepository(tx);
  const result: BillMasterResult = {
    instrumentByCusip: new Map(),
    mdLineByLabel: new Map(),
    issuerId: 0,
    instrumentsCreated: 0,
    termsWritten: 0,
    mdLinesWritten: 0,
    rolls: [],
  };
  if (securities.length === 0) return result;

  result.issuerId = await ensureTreasuryIssuer(tx, master, o);
  const onTheRun = onTheRunByLabel(securities);
  // Read before the write loop: afterwards every CUSIP in this capture has been restated, and a
  // read then could not tell a bill the capture demoted from one an earlier capture promoted.
  const held = await heldOnTheRunByLabel(tx, o.knownAt);

  for (const security of securities) {
    const validFrom = new Date(`${security.firstCurveDate}T00:00:00.000Z`);
    const write = { validFrom, provenanceId: o.provenanceId, knownAt: o.knownAt };
    const isOnTheRun = onTheRun.get(security.termLabel)?.cusip === security.cusip;

    let instrumentId = await instrumentByCusip(identifiers, security.cusip, o.knownAt);
    if (instrumentId === null) {
      const issueId = await master.issues.insert(
        {
          issuerId: result.issuerId,
          assetClass: 'govt',
          securityType: 'US GOVERNMENT',
          cusip: security.cusip,
          name: billName(security),
          currency: 'USD',
          countryOfIssue: 'US',
        },
        write,
      );
      instrumentId = await master.instruments.insert(
        {
          issueId,
          assetClass: 'govt',
          marketSector: 'Govt',
          // §9.2: `ticker = CUSIP`. A bill has no ticker of its own.
          ticker: security.cusip,
          exchCode: 'GOVT',
          name: billName(security),
          currency: 'USD',
          priceDecimals: 6,
        },
        write,
      );
      await identifiers.upsert(
        {
          entityKind: 'instrument',
          entityId: instrumentId,
          scheme: 'CUSIP',
          value: security.cusip,
          isPrimary: true,
        },
        write,
      );
      result.instrumentsCreated += 1;
    }
    result.instrumentByCusip.set(security.cusip, instrumentId);

    const versionId = await terms.upsert('govt', {
      instrumentId,
      data: billTerms(security, isOnTheRun),
      validFrom,
      provenanceId: o.provenanceId,
      txFrom: o.knownAt,
      reason: 'change',
    });
    if (versionId !== null) result.termsWritten += 1;
  }

  // The md line is keyed by the term label, so a roll re-points the *existing* line rather than
  // opening a second current line for `'13WK'` — which is what `md_lines_symbol_excl` forbids.
  for (const [termLabel, security] of [...onTheRun.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    const instrumentId = result.instrumentByCusip.get(security.cusip);
    if (instrumentId === undefined) continue;
    const line = await master.mdLines.upsertBySymbol(
      {
        instrumentId,
        sourceId: BILLS_SOURCE_ID,
        providerSymbol: termLabel,
        lineKind: 'reference',
        intrinsicDelayMin: 0,
        expectedIntervalMs: BILL_LINE_INTERVAL_MS,
        priority: BILL_LINE_PRIORITY,
      },
      {
        validFrom: new Date(`${security.firstCurveDate}T00:00:00.000Z`),
        provenanceId: o.provenanceId,
        knownAt: o.knownAt,
      },
    );
    result.mdLineByLabel.set(termLabel, line.mdLineId);
    if (line.written) result.mdLinesWritten += 1;
  }

  // A CUSIP that held a label and no longer does has rolled off the run. `on_the_run` is what
  // SRCH and YAS key on, so the displaced bill gets a version saying so rather than being left
  // claiming a status it lost. The capture's own displacements are already written above — every
  // CUSIP in `securities` went through the write loop with its true `isOnTheRun`.
  for (const security of securities) {
    const current = onTheRun.get(security.termLabel);
    if (current === undefined || current.cusip === security.cusip) continue;
    result.rolls.push({
      termLabel: security.termLabel,
      from: security.cusip,
      to: current.cusip,
    });
  }

  // The displacements this capture cannot see: a CUSIP an earlier run wrote as on-the-run whose
  // label has since rolled to a bill the capture *does* name. Nothing above visits it, because it
  // is not in `securities` at all.
  const captured = new Set(securities.map((s) => s.cusip));
  for (const [termLabel, security] of [...onTheRun.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    const rollDate = new Date(`${security.firstCurveDate}T00:00:00.000Z`);
    for (const holder of held.get(termLabel) ?? []) {
      if (holder.cusip === security.cusip || captured.has(holder.cusip)) continue;
      const current = await terms.read('govt', holder.instrumentId, {
        validAt: rollDate,
        knownAt: o.knownAt,
      });
      if (current?.onTheRun !== true) continue;
      // The whole row restated with one column changed: `TermsData` is a complete statement of
      // the terms, so the demotion re-states what the database already believes rather than
      // re-deriving terms from a capture that no longer carries this CUSIP.
      const versionId = await terms.upsert('govt', {
        instrumentId: holder.instrumentId,
        data: { ...termsDataOf(current), onTheRun: false },
        validFrom: rollDate,
        provenanceId: o.provenanceId,
        txFrom: o.knownAt,
        reason: 'change',
      });
      if (versionId !== null) {
        result.termsWritten += 1;
        result.rolls.push({ termLabel, from: holder.cusip, to: security.cusip });
      }
    }
  }
  return result;
}

/** A read-back `govt_terms` row minus its identity and its four bitemporal columns. */
function termsDataOf(row: GovtTermsRow): TermsData<'govt'> {
  const {
    versionId: _versionId,
    instrumentId: _instrumentId,
    validFrom: _validFrom,
    validTo: _validTo,
    txFrom: _txFrom,
    txTo: _txTo,
    provenanceId: _provenanceId,
    ...data
  } = row;
  return data;
}

/**
 * The CUSIPs that `govt_terms` still calls on-the-run, by term label, as known at `knownAt`.
 *
 * Current on both axes — `valid_to = 'infinity'` and the transaction window open at `knownAt` —
 * because that is exactly the set SRCH's `onTheRun: 'only'` filter and its on-the-run summary
 * count read. Restricted to `security_type = 'bill'` with a label, which is this job's own write:
 * notes and bonds are minted elsewhere and their roll is not this capture's business.
 */
async function heldOnTheRunByLabel(
  tx: Tx,
  knownAt: Date,
): Promise<Map<string, { instrumentId: number; cusip: string }[]>> {
  const res = await tx.execute<{ instrument_id: string; cusip: string; term_label: string }>(sql`
    SELECT instrument_id, cusip, term_label
      FROM govt_terms
     WHERE on_the_run
       AND security_type = 'bill'
       AND term_label IS NOT NULL
       AND valid_to = 'infinity'
       AND tx_from <= ${knownAt}::timestamptz
       AND tx_to > ${knownAt}::timestamptz
     ORDER BY term_label, cusip`);
  const out = new Map<string, { instrumentId: number; cusip: string }[]>();
  for (const row of res.rows) {
    const bucket = out.get(row.term_label);
    const entry = { instrumentId: Number(row.instrument_id), cusip: row.cusip };
    if (bucket === undefined) out.set(row.term_label, [entry]);
    else bucket.push(entry);
  }
  return out;
}

/** The `US Treasury` issuer (§9.2), found by name and minted once. */
async function ensureTreasuryIssuer(
  tx: Tx,
  master: ReturnType<typeof masterRepositories>,
  o: { provenanceId: number; knownAt: Date },
): Promise<number> {
  const found = await tx.execute<{ issuer_id: string }>(sql`
    SELECT issuer_id FROM issuers
     WHERE name = ${TREASURY_ISSUER_NAME} AND tx_to = 'infinity'
     ORDER BY issuer_id LIMIT 1`);
  const row = found.rows[0];
  if (row !== undefined) return Number(row.issuer_id);
  return master.issuers.insert(
    {
      name: TREASURY_ISSUER_NAME,
      country: 'US',
      entityType: 'sovereign',
    },
    { validFrom: o.knownAt, provenanceId: o.provenanceId, knownAt: o.knownAt },
  );
}

/** The instrument a CUSIP already resolves to, or `null`. */
async function instrumentByCusip(
  identifiers: ReturnType<typeof identifierRepository>,
  cusip: string,
  knownAt: Date,
): Promise<number | null> {
  const rows = await identifiers.lookup('CUSIP', cusip, { validAt: knownAt, knownAt }, '');
  for (const row of rows) {
    if (row.entityKind === 'instrument') return row.entityId;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface TreasuryCurvesContext extends MarketJobContext {
  /** `['202609']`. Default: the month of `ctx.clock.now()`. Several months back-fill. */
  months?: readonly string[];
}

/** What the run did, beyond the four counters `ingest_runs` stores. */
export interface TreasuryCurvesResult extends MarketJobResult {
  parPoints: number;
  billPoints: number;
  billSecurities: number;
  instrumentsCreated: number;
  termsWritten: number;
}

function emptyTreasuryResult(): TreasuryCurvesResult {
  return {
    ...emptyResult(),
    parPoints: 0,
    billPoints: 0,
    billSecurities: 0,
    instrumentsCreated: 0,
    termsWritten: 0,
  };
}

/** `'202609'` from the job's clock — the month the feed is asked for. */
export function currentMonth(ctx: MarketJobContext): string {
  return monthOfIsoDate(new Date(ctx.clock.now()).toISOString().slice(0, 10));
}

/**
 * Fetch both datasets for every requested month and write the three things §9.2 lists.
 *
 * The par curve is done first (§9.1), then the bills (§9.2) — the order §13's "the same
 * `treasuryCurves` run, immediately after §9.1" prescribes, and the order the 1/min bucket
 * serialises them in anyway.
 */
export async function runTreasuryCurves(
  ctx: TreasuryCurvesContext,
): Promise<TreasuryCurvesResult> {
  const months = ctx.months ?? [currentMonth(ctx)];
  const result = (await withIngestRun(
    ctx,
    { id: 'treasuryCurves', sourceId: YIELD_CURVE_SOURCE_ID },
    async () => {
      const out = emptyTreasuryResult();
      await ensureCurves(ctx.tx, TREASURY_CURVE_DEFINITIONS);
      for (const month of months) {
        await runParCurve(ctx, month, out);
        await runBills(ctx, month, out);
      }
      ctx.log?.info?.('treasuryCurves.done', {
        months,
        parPoints: out.parPoints,
        billPoints: out.billPoints,
        securities: out.billSecurities,
        instrumentsCreated: out.instrumentsCreated,
        inserted: out.inserted,
        updated: out.updated,
        unchanged: out.skipped,
      });
      return out;
    },
  )) as TreasuryCurvesResult;
  return result;
}

/** §9.1 — `treasury.yieldcurve` → `curve_points('UST_PAR')`. */
async function runParCurve(
  ctx: TreasuryCurvesContext,
  month: string,
  out: TreasuryCurvesResult,
): Promise<void> {
  const url = treasuryUrl(YIELD_CURVE_DATASET, month);
  const request = { month, ...requestEnvelope(ctx) };

  let raw: RawRecord;
  try {
    raw = await fetchThrough(ctx, treasuryYieldCurveAdapter, request, url);
  } catch (err) {
    out.errors.push(fetchError(err, url));
    return;
  }
  if (raw.status === 304) {
    out.skipped += 1;
    return;
  }
  out.fetched += 1;

  const nctx: NormaliseContext = {
    provenanceId: 0,
    capturedAt: raw.capturedAt,
    lines: new Map<string, NormaliseLine>(),
  };
  const parsed = parseYieldCurve(raw, nctx);
  out.problems.push(...parsed.problems);

  const provenanceId = await insertProvenance(
    ctx.tx,
    raw,
    provenanceMeta(ctx, TREASURY_ADAPTER_VERSION, parsed.sourceTs ?? raw.sourceTs),
  );
  out.provenanceIds.push(provenanceId);

  tally(out, await upsertCurvePoints(ctx.tx, parsed.rows.curvePoints, provenanceId));
  out.parPoints += parsed.rows.curvePoints.length;

  for (const mismatch of parsed.rows.crossChecks) {
    await recordDqEvent(ctx.tx, {
      kind: 'reconcile_mismatch',
      severity: 'warn',
      sourceId: YIELD_CURVE_SOURCE_ID,
      subject: `c:${UST_PAR_CURVE_ID}`,
      key: `${mismatch.check}|${mismatch.curveDate}`,
      details: { ...mismatch },
    });
  }
  for (const absent of parsed.rows.absentTenors) {
    await recordDqEvent(ctx.tx, {
      kind: 'field_population',
      severity: 'info',
      sourceId: YIELD_CURVE_SOURCE_ID,
      subject: `c:${UST_PAR_CURVE_ID}`,
      key: `${absent.curveDate}|${absent.tenor}`,
      details: { ...absent },
    });
  }
}

/** §9.2 — `treasury.bills` → `curve_points('UST_BILL')`, the bill master and `govt_terms`. */
async function runBills(
  ctx: TreasuryCurvesContext,
  month: string,
  out: TreasuryCurvesResult,
): Promise<void> {
  const url = treasuryUrl(BILL_RATES_DATASET, month);
  const request = { month, ...requestEnvelope(ctx) };

  let raw: RawRecord;
  try {
    raw = await fetchThrough(ctx, treasuryBillsAdapter, request, url);
  } catch (err) {
    out.errors.push(fetchError(err, url));
    return;
  }
  if (raw.status === 304) {
    out.skipped += 1;
    return;
  }
  out.fetched += 1;

  // Pass one: read the CUSIPs with nothing resolved. `NormaliseContext.resolveInstrument` is
  // synchronous, so the instruments have to exist before the parse that fills
  // `curve_points.instrument_id` runs — which is why this capture is parsed twice. The parse is
  // pure and takes about a millisecond; a resolver that could await would be the alternative, and
  // it would put a database round trip inside every normaliser in the system.
  const probeCtx: NormaliseContext = {
    provenanceId: 0,
    capturedAt: raw.capturedAt,
    lines: new Map<string, NormaliseLine>(),
  };
  const probe = parseBillRates(raw, probeCtx);
  const securities = billSecurities(probe.rows.bills);

  const provenanceId = await insertProvenance(
    ctx.tx,
    raw,
    provenanceMeta(ctx, TREASURY_ADAPTER_VERSION, probe.sourceTs ?? raw.sourceTs),
  );
  out.provenanceIds.push(provenanceId);

  const master = await mintBillSecurities(ctx.tx, securities, {
    provenanceId,
    knownAt: new Date(raw.capturedAt),
  });
  out.billSecurities += securities.length;
  out.instrumentsCreated += master.instrumentsCreated;
  out.termsWritten += master.termsWritten;

  // Pass two: the same bytes, now with the CUSIP → instrument map and the md lines the first pass
  // created, so the points carry `instrument_id` and the seven `q:` updates have a line to be on.
  const targets = await resolveTargets(ctx, BILLS_SOURCE_ID, { instrumentIds: null });
  const finalCtx: NormaliseContext = {
    provenanceId,
    capturedAt: raw.capturedAt,
    lines: linesOf(targets),
    resolveInstrument: (key) =>
      key.scheme === 'CUSIP' ? (master.instrumentByCusip.get(key.value) ?? null) : null,
  };
  const parsed = parseBillRates(raw, finalCtx);
  out.problems.push(...parsed.problems);

  tally(out, await upsertCurvePoints(ctx.tx, parsed.rows.curvePoints, provenanceId));
  out.billPoints += parsed.rows.curvePoints.length;
  out.published += publish(ctx, parsed.updates, out.errors);

  for (const day of parsed.rows.unavailable) {
    await recordDqEvent(ctx.tx, {
      kind: 'missing_close',
      severity: 'error',
      sourceId: BILLS_SOURCE_ID,
      subject: `c:${UST_BILL_CURVE_ID}`,
      key: day.curveDate,
      details: { ...day },
    });
  }
  for (const conflict of parsed.rows.conflicts) {
    await recordDqEvent(ctx.tx, {
      kind: 'source_conflict',
      severity: 'error',
      sourceId: BILLS_SOURCE_ID,
      subject: `c:${UST_BILL_CURVE_ID}`,
      key: `${conflict.termLabel}|${conflict.curveDate}`,
      details: { ...conflict },
    });
  }
  for (const mismatch of parsed.rows.crossChecks) {
    await recordDqEvent(ctx.tx, {
      kind: 'reconcile_mismatch',
      severity: 'warn',
      sourceId: BILLS_SOURCE_ID,
      subject: `c:${UST_BILL_CURVE_ID}`,
      key: `${mismatch.check}|${mismatch.curveDate}`,
      details: { ...mismatch },
    });
  }
}

/** The scheduler row (PROVIDERS §13). */
export const job = {
  id: 'treasuryCurves',
  schedule: TREASURY_CURVES_SCHEDULE,
  provider: [YIELD_CURVE_SOURCE_ID, BILLS_SOURCE_ID] as const,
  priority: 2 as const,
  timeoutMs: TREASURY_CURVES_TIMEOUT_MS,
  run: (ctx: TreasuryCurvesContext): Promise<TreasuryCurvesResult> => runTreasuryCurves(ctx),
};
