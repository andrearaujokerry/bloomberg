/**
 * `treasury.yieldcurve` and `treasury.bills` — the pure half (PROVIDERS §9.1, §9.2).
 *
 * Both endpoints are the same OData-over-Atom feed with a different `data=` parameter, so both
 * parsers share one shape: `<feed><entry><content><m:properties>` with one `<m:properties>` block
 * per published business day and one `d:<COLUMN>` element per value.
 *
 * PURITY (PROVIDERS §1.2, QA-05). Nothing here opens a socket, reads a clock, reads the
 * environment or throws. Every structural surprise becomes a `NormaliseProblem` and an empty row
 * set; every per-value surprise drops that one value and keeps the rest of the day. The only
 * instants these functions read are `raw.capturedAt` (the vintage) and the feed's own `<updated>`
 * (the source instant), which is what makes the committed goldens under
 * `fixtures/providers/normalised/` reproducible on any machine in any year.
 *
 * What is deliberately NOT done here, because it needs state this function cannot see:
 *
 *  - `is_latest` and the vintage flip on a revision — the ingest upsert owns them (DATA_MODEL §5);
 *  - `provenance_id` — `insertProvenance` runs before `normalise` and the job stamps the rows;
 *  - `instrument_id` on a bill curve point — resolved through `ctx.resolveInstrument` when the
 *    caller supplies one, `null` otherwise (the bills job mints the instrument and back-fills it);
 *  - the `field_population` / `missing_close` / `cross_source_divergence` monitors, which compare
 *    across days and across providers. What this file can see, it reports: `absentTenors`,
 *    `unavailable` and `crossChecks` are the evidence those monitors consume (PROVIDERS §14).
 */

import type { NormalisedUpdate } from '@terminal/core';

import type { Normalised, NormaliseContext, NormaliseProblem, RawRecord } from '../types.js';
import { child, childrenNamed, descendants, parseXmlBuffer, textOf } from '../xml.js';
import type { XmlElement } from '../xml.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared row shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `curves.curve_id` of the par yield curve (seeded by WP-15, never written by the adapter). */
export const UST_PAR_CURVE_ID = 'UST_PAR';
/** `curves.curve_id` of the bill curve. */
export const UST_BILL_CURVE_ID = 'UST_BILL';

/** `provenance.adapter_version` for both Treasury adapters (PROVIDERS §1.4). */
export const TREASURY_ADAPTER_VERSION = 'treasury/1.0.0';

/** One `curve_points` row, less the three columns the writer owns (`is_latest`, `provenance_id`). */
export interface CurvePointRow {
  curveId: string;
  /** `YYYY-MM-DD`, the ET business date exactly as published — never timezone-shifted. */
  curveDate: string;
  tenor: string;
  quoteType: 'par_yield' | 'discount_rate' | 'investment_yield';
  /** ISO instant — `raw.capturedAt`, the poll that first showed this value. */
  vintageAt: string;
  tenorDays: number;
  /** Percent, as published. */
  value: number;
  instrumentId: number | null;
  maturityDate: string | null;
}

/**
 * A published value the payload contradicts elsewhere: `BC_30YEARDISPLAY` against `BC_30YEAR`,
 * `QUOTE_DATE` against `INDEX_DATE`, `CS_*_AVG` against `ROUND_B1_*`. The published
 * (`ROUND_B1_*` / `BC_*`) value is what is stored; the job raises
 * `dq_events kind 'reconcile_mismatch'` for each of these (PROVIDERS §9.1, §9.2).
 *
 * Both values are the element's **raw text, verbatim** — never a number round-tripped back to a
 * string. `3.90` round-tripped reads `'3.9'` and `4.00` reads `'4'`, and a data-ops operator
 * comparing a `source_conflict` row against the Treasury page would be looking for a value that
 * is not on it.
 */
export interface CrossCheckMismatch {
  check: string;
  curveDate: string;
  published: string;
  crossCheck: string;
}

/** A tenor whose element is absent from a day that publishes others — the `field_population` input. */
export interface AbsentTenor {
  curveDate: string;
  tenor: string;
  element: string;
}

export interface TreasuryYieldCurveRows {
  curvePoints: CurvePointRow[];
  absentTenors: AbsentTenor[];
  crossChecks: CrossCheckMismatch[];
}

/** One on-the-run bill, as the bills feed publishes it. Feeds `govt_terms` + the security master. */
export interface BillRow {
  curveDate: string;
  termLabel: string;
  tenorDays: number;
  cusip: string | null;
  maturityDate: string | null;
  /** `ROUND_B1_CLOSE_{T}_2`, the bank-discount close. `null` when dropped or absent. */
  discountRate: number | null;
  /** `ROUND_B1_YIELD_{T}_2`, the coupon-equivalent yield. */
  investmentYield: number | null;
}

/** A whole entry skipped because `BOND_MKT_UNAVAIL_REASON` was non-empty (→ `missing_close`). */
export interface UnavailableDay {
  curveDate: string;
  reason: string;
}

/**
 * A CUSIP that takes over a `term_label` without the maturity date moving forward — PROVIDERS §9.2
 * calls this `data_exceptions kind 'source_conflict'` and it is usually a Treasury correction.
 * Detectable inside one capture because the feed publishes a whole month in date order.
 */
export interface BillConflict {
  termLabel: string;
  curveDate: string;
  previousCusip: string;
  previousMaturity: string | null;
  cusip: string;
  maturityDate: string | null;
}

export interface TreasuryBillRows {
  curvePoints: CurvePointRow[];
  bills: BillRow[];
  unavailable: UnavailableDay[];
  conflicts: BillConflict[];
  crossChecks: CrossCheckMismatch[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tenor tables — PROVIDERS §9.1 and §9.2, verbatim
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface TenorSpec {
  /** The `d:` element carrying the value, without the prefix. */
  readonly element: string;
  /** `curve_points.tenor` — the DATA_MODEL L1466 enum, exactly. */
  readonly tenor: string;
  readonly tenorDays: number;
}

/** The fourteen par-curve tenors, ascending in `tenorDays` — the order `TENORS` is published in. */
export const PAR_TENORS: readonly TenorSpec[] = [
  { element: 'BC_1MONTH', tenor: '1M', tenorDays: 30 },
  { element: 'BC_1_5MONTH', tenor: '1.5M', tenorDays: 45 },
  { element: 'BC_2MONTH', tenor: '2M', tenorDays: 61 },
  { element: 'BC_3MONTH', tenor: '3M', tenorDays: 91 },
  { element: 'BC_4MONTH', tenor: '4M', tenorDays: 122 },
  { element: 'BC_6MONTH', tenor: '6M', tenorDays: 182 },
  { element: 'BC_1YEAR', tenor: '1Y', tenorDays: 365 },
  { element: 'BC_2YEAR', tenor: '2Y', tenorDays: 730 },
  { element: 'BC_3YEAR', tenor: '3Y', tenorDays: 1095 },
  { element: 'BC_5YEAR', tenor: '5Y', tenorDays: 1826 },
  { element: 'BC_7YEAR', tenor: '7Y', tenorDays: 2556 },
  { element: 'BC_10YEAR', tenor: '10Y', tenorDays: 3653 },
  { element: 'BC_20YEAR', tenor: '20Y', tenorDays: 7305 },
  { element: 'BC_30YEAR', tenor: '30Y', tenorDays: 10958 },
];

/** The seven bill tenors, ascending. `element` is the label spliced into every column name. */
export const BILL_TENORS: readonly TenorSpec[] = [
  { element: '4WK', tenor: '4WK', tenorDays: 28 },
  { element: '6WK', tenor: '6WK', tenorDays: 42 },
  { element: '8WK', tenor: '8WK', tenorDays: 56 },
  { element: '13WK', tenor: '13WK', tenorDays: 91 },
  { element: '17WK', tenor: '17WK', tenorDays: 119 },
  { element: '26WK', tenor: '26WK', tenorDays: 182 },
  { element: '52WK', tenor: '52WK', tenorDays: 364 },
];

/** A yield outside this band is a transposed column or a decimal slip, never a Treasury rate. */
export const MIN_YIELD_PCT = 0;
export const MAX_YIELD_PCT = 25;
/** Percentage points: an inversion deeper than 200 bp between adjacent tenors drops the point. */
export const MAX_INVERSION_PCT = 2;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CUSIP_RE = /^[0-9A-Z]{9}$/;

/** `'2026-09-01T00:00:00'` → `'2026-09-01'`. A naive date: the date part, never shifted. */
function naiveDate(text: string): string | null {
  const head = text.trim().slice(0, 10);
  return ISO_DATE_RE.test(head) ? head : null;
}

/** Finite number, or `null` — an empty element, a blank and `NaN` all become `null`. */
function numberOfText(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** The first descendant with this local name, ignoring the namespace prefix. */
function prop(properties: XmlElement, local: string): XmlElement | null {
  return child(properties, local);
}

function propText(properties: XmlElement, local: string): string | null {
  const element = prop(properties, local);
  return element === null ? null : textOf(element);
}

function parseFailure<Rows>(rows: Rows, detail: string, path?: string): Normalised<Rows> {
  const problem: NormaliseProblem =
    path === undefined ? { kind: 'parse_error', detail } : { kind: 'parse_error', detail, path };
  return { updates: [], rows, sourceTs: null, problems: [problem] };
}

/** `<feed>` with its `<entry>` children, or a problem naming what arrived instead. */
interface Feed {
  entries: readonly XmlElement[];
  sourceTs: Date | null;
  problems: NormaliseProblem[];
}

function readFeed(raw: RawRecord): Feed | NormaliseProblem {
  const parsed = parseXmlBuffer(raw.body);
  if (!parsed.ok) return parsed.problem;
  const root = parsed.root;
  if (root.local !== 'feed') {
    return {
      kind: 'schema_drift',
      detail: `expected an Atom <feed> root, got <${root.name}> — the Treasury XML endpoint serves an HTML error page when its 'data' parameter is unknown`,
      path: '/',
    };
  }
  const problems: NormaliseProblem[] = [];
  let sourceTs: Date | null = null;
  const updated = childrenNamed(root, 'updated')[0];
  if (updated !== undefined) {
    const at = Date.parse(textOf(updated));
    if (Number.isFinite(at)) sourceTs = new Date(at);
    else
      problems.push({
        kind: 'schema_drift',
        detail: `feed <updated> is not an instant: '${textOf(updated)}'`,
        path: '/feed/updated',
      });
  }
  return { entries: childrenNamed(root, 'entry'), sourceTs, problems };
}

/** The `<m:properties>` block of an entry, or `null`. */
function propertiesOf(entry: XmlElement): XmlElement | null {
  return descendants(entry, 'properties')[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §9.1 — the par yield curve
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `treasury-xml2` → `curve_points(curve_id 'UST_PAR', quote_type 'par_yield')`.
 *
 * One entry per business day, fourteen tenors per entry. `d:Id` and `d:BC_30YEARDISPLAY` are
 * dropped by design — the first is not stable across months, the second duplicates `BC_30YEAR` and
 * is kept only as a cross-check.
 *
 * A curve is not an instrument, so this emits no `NormalisedUpdate`: `c:UST_PAR` carries
 * `CURVE_DATE`/`BUILD_TS`, not a `valueState`, and the job publishes it from these rows.
 */
export function parseYieldCurve(
  raw: RawRecord,
  ctx: NormaliseContext,
): Normalised<TreasuryYieldCurveRows> {
  const rows: TreasuryYieldCurveRows = { curvePoints: [], absentTenors: [], crossChecks: [] };
  const feed = readFeed(raw);
  if (!('entries' in feed)) return parseFailure(rows, feed.detail, feed.path);

  const problems: NormaliseProblem[] = [...feed.problems];
  const vintageAt = new Date(raw.capturedAt).toISOString();

  feed.entries.forEach((entry, index) => {
    const properties = propertiesOf(entry);
    if (properties === null) {
      problems.push({
        kind: 'schema_drift',
        detail: 'entry carries no <m:properties> block',
        path: `/feed/entry/${String(index)}`,
      });
      return;
    }
    const dateText = propText(properties, 'NEW_DATE');
    const curveDate = dateText === null ? null : naiveDate(dateText);
    if (curveDate === null) {
      problems.push({
        kind: 'parse_error',
        detail: `d:NEW_DATE is missing or not a date: '${dateText ?? ''}'`,
        path: `/feed/entry/${String(index)}/NEW_DATE`,
      });
      return;
    }

    let lastKept: number | null = null;
    for (const spec of PAR_TENORS) {
      const element = prop(properties, spec.element);
      if (element === null) {
        rows.absentTenors.push({ curveDate, tenor: spec.tenor, element: spec.element });
        continue;
      }
      const text = textOf(element);
      const value = numberOfText(text);
      if (value === null) {
        if (text.trim() === '') {
          rows.absentTenors.push({ curveDate, tenor: spec.tenor, element: spec.element });
        } else {
          problems.push({
            kind: 'field_dropped',
            detail: `d:${spec.element} is not a number: '${text.trim()}'`,
            path: `/feed/entry/${String(index)}/${spec.element}`,
          });
        }
        continue;
      }
      if (value < MIN_YIELD_PCT || value > MAX_YIELD_PCT) {
        problems.push({
          kind: 'out_of_range',
          detail: `${spec.tenor} par yield ${String(value)}% is outside ${String(MIN_YIELD_PCT)}–${String(MAX_YIELD_PCT)}% on ${curveDate}`,
          path: `/feed/entry/${String(index)}/${spec.element}`,
        });
        continue;
      }
      if (lastKept !== null && lastKept - value > MAX_INVERSION_PCT) {
        problems.push({
          kind: 'out_of_range',
          detail: `${spec.tenor} par yield ${String(value)}% inverts the previous tenor (${String(lastKept)}%) by more than ${String(MAX_INVERSION_PCT * 100)} bp on ${curveDate}`,
          path: `/feed/entry/${String(index)}/${spec.element}`,
        });
        continue;
      }
      lastKept = value;
      rows.curvePoints.push({
        curveId: UST_PAR_CURVE_ID,
        curveDate,
        tenor: spec.tenor,
        quoteType: 'par_yield',
        vintageAt,
        tenorDays: spec.tenorDays,
        value,
        instrumentId: null,
        maturityDate: null,
      });
    }

    // `BC_30YEARDISPLAY` duplicates `BC_30YEAR` on every recorded row; a difference is a
    // `reconcile_mismatch`, and `BC_30YEAR` is what gets stored either way.
    const thirty = propText(properties, 'BC_30YEAR');
    const display = propText(properties, 'BC_30YEARDISPLAY');
    if (thirty !== null && display !== null) {
      const a = numberOfText(thirty);
      const b = numberOfText(display);
      if (a !== null && b !== null && a !== b) {
        rows.crossChecks.push({
          check: 'BC_30YEAR vs BC_30YEARDISPLAY',
          curveDate,
          published: thirty,
          crossCheck: display,
        });
      }
    }
  });

  // A dataset URL for a month always publishes entries. "Parsed fine, nothing in it" is never a
  // truthful answer here: with no problem beside it, an empty curve reads downstream as a market
  // that published no yields, raises no `dq_events kind='parse_error'`, and shows an empty CURV
  // screen as real data. Every empty outcome therefore carries a reason (QA-05).
  if (feed.entries.length === 0) {
    problems.push({
      kind: 'schema_drift',
      detail: 'the feed parsed but carries no <entry> — the dataset name or the filter has changed',
      path: '/feed',
    });
  } else if (rows.curvePoints.length === 0) {
    problems.push({
      kind: 'schema_drift',
      detail: `${String(feed.entries.length)} entries carried no usable tenor — the BC_* column names have changed`,
      path: '/feed',
    });
  }

  void ctx;
  return { updates: [], rows, sourceTs: feed.sourceTs, problems };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §9.2 — bill rates, and the on-the-run bill by CUSIP
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `treasury-bills.xml` → `curve_points(curve_id 'UST_BILL')` in both quote types, plus the bill
 * rows behind `govt_terms` and the government security master.
 *
 * `md_lines` for this source are keyed by the **tenor label** (`'13WK'`), because the CUSIP behind
 * a label rolls every week and the staleness line must not roll with it. When the caller resolves
 * those lines, each one gets a `q:<instrumentId>` update carrying the coupon-equivalent yield —
 * the number YAS and SRCH show — so that a bill line goes stale after three missed publications
 * like every other line.
 */
export function parseBillRates(
  raw: RawRecord,
  ctx: NormaliseContext,
): Normalised<TreasuryBillRows> {
  const rows: TreasuryBillRows = {
    curvePoints: [],
    bills: [],
    unavailable: [],
    conflicts: [],
    crossChecks: [],
  };
  const feed = readFeed(raw);
  if (!('entries' in feed)) return parseFailure(rows, feed.detail, feed.path);

  const problems: NormaliseProblem[] = [...feed.problems];
  const updates: NormalisedUpdate[] = [];
  const vintageAt = new Date(raw.capturedAt).toISOString();
  /** The last CUSIP seen for each term label, for the roll cross-check. */
  const previous = new Map<string, { cusip: string; maturityDate: string | null }>();

  feed.entries.forEach((entry, index) => {
    const properties = propertiesOf(entry);
    if (properties === null) {
      problems.push({
        kind: 'schema_drift',
        detail: 'entry carries no <m:properties> block',
        path: `/feed/entry/${String(index)}`,
      });
      return;
    }
    const indexDate = propText(properties, 'INDEX_DATE');
    const curveDate = indexDate === null ? null : naiveDate(indexDate);
    if (curveDate === null) {
      problems.push({
        kind: 'parse_error',
        detail: `d:INDEX_DATE is missing or not a date: '${indexDate ?? ''}'`,
        path: `/feed/entry/${String(index)}/INDEX_DATE`,
      });
      return;
    }

    const unavailable = (propText(properties, 'BOND_MKT_UNAVAIL_REASON') ?? '').trim();
    if (unavailable !== '') {
      rows.unavailable.push({ curveDate, reason: unavailable });
      problems.push({
        kind: 'field_dropped',
        detail: `the whole ${curveDate} entry is skipped: BOND_MKT_UNAVAIL_REASON = '${unavailable}'`,
        path: `/feed/entry/${String(index)}/BOND_MKT_UNAVAIL_REASON`,
      });
      return;
    }

    const quoteDate = propText(properties, 'QUOTE_DATE');
    const quoted = quoteDate === null ? null : naiveDate(quoteDate);
    if (quoted !== null && quoted !== curveDate) {
      rows.crossChecks.push({
        check: 'INDEX_DATE vs QUOTE_DATE',
        curveDate,
        published: curveDate,
        crossCheck: quoted,
      });
    }

    for (const spec of BILL_TENORS) {
      const label = spec.element;
      const closeText = propText(properties, `ROUND_B1_CLOSE_${label}_2`);
      const yieldText = propText(properties, `ROUND_B1_YIELD_${label}_2`);
      if (closeText === null && yieldText === null) continue;

      let discount = closeText === null ? null : numberOfText(closeText);
      let investment = yieldText === null ? null : numberOfText(yieldText);

      // The coupon-equivalent yield is arithmetically above the bank-discount rate for the same
      // bill. The other way round means the two columns were transposed, and publishing either
      // number would be publishing a wrong one.
      if (discount !== null && investment !== null && discount > investment) {
        problems.push({
          kind: 'parse_error',
          detail: `${label} on ${curveDate}: discount rate ${String(discount)}% exceeds investment yield ${String(investment)}% — the CLOSE and YIELD columns are transposed; both values dropped`,
          path: `/feed/entry/${String(index)}/ROUND_B1_CLOSE_${label}_2`,
        });
        discount = null;
        investment = null;
      }
      for (const [value, name] of [
        [discount, `ROUND_B1_CLOSE_${label}_2`],
        [investment, `ROUND_B1_YIELD_${label}_2`],
      ] as const) {
        if (value !== null && (value < MIN_YIELD_PCT || value > MAX_YIELD_PCT)) {
          problems.push({
            kind: 'out_of_range',
            detail: `${name} ${String(value)}% is outside ${String(MIN_YIELD_PCT)}–${String(MAX_YIELD_PCT)}% on ${curveDate}`,
            path: `/feed/entry/${String(index)}/${name}`,
          });
          if (name.includes('CLOSE')) discount = null;
          else investment = null;
        }
      }

      // `CS_*_AVG` is identical to `ROUND_B1_*` on every recorded row. A divergence is published
      // as the `ROUND_B1_*` value with a `reconcile_mismatch` beside it.
      const csCloseText = propText(properties, `CS_${label}_CLOSE_AVG`);
      const csYieldText = propText(properties, `CS_${label}_YIELD_AVG`);
      const csClose = csCloseText === null ? null : numberOfText(csCloseText);
      const csYield = csYieldText === null ? null : numberOfText(csYieldText);
      if (discount !== null && csClose !== null && csCloseText !== null && csClose !== discount) {
        rows.crossChecks.push({
          check: `ROUND_B1_CLOSE_${label}_2 vs CS_${label}_CLOSE_AVG`,
          curveDate,
          // `closeText` is non-null whenever `discount` is: `discount` was parsed out of it.
          published: closeText ?? String(discount),
          crossCheck: csCloseText,
        });
      }
      if (
        investment !== null &&
        csYield !== null &&
        csYieldText !== null &&
        csYield !== investment
      ) {
        rows.crossChecks.push({
          check: `ROUND_B1_YIELD_${label}_2 vs CS_${label}_YIELD_AVG`,
          curveDate,
          published: yieldText ?? String(investment),
          crossCheck: csYieldText,
        });
      }

      const maturityText = propText(properties, `MATURITY_DATE_${label}`);
      const maturityDate = maturityText === null ? null : naiveDate(maturityText);
      if (maturityText !== null && maturityDate === null) {
        problems.push({
          kind: 'field_dropped',
          detail: `MATURITY_DATE_${label} is not a date: '${maturityText.trim()}'`,
          path: `/feed/entry/${String(index)}/MATURITY_DATE_${label}`,
        });
      }

      const cusipText = (propText(properties, `CUSIP_${label}`) ?? '').trim().toUpperCase();
      let cusip: string | null = null;
      if (cusipText !== '') {
        if (CUSIP_RE.test(cusipText)) cusip = cusipText;
        else
          problems.push({
            kind: 'field_dropped',
            detail: `CUSIP_${label} is not a 9-character CUSIP: '${cusipText}'`,
            path: `/feed/entry/${String(index)}/CUSIP_${label}`,
          });
      }

      if (cusip !== null) {
        const held = previous.get(label);
        if (held !== undefined && held.cusip !== cusip) {
          // A roll must move the maturity forward. When it does not, the feed is correcting
          // itself — `data_exceptions kind 'source_conflict'` (PROVIDERS §9.2).
          const forward =
            held.maturityDate !== null && maturityDate !== null && maturityDate > held.maturityDate;
          if (!forward) {
            rows.conflicts.push({
              termLabel: label,
              curveDate,
              previousCusip: held.cusip,
              previousMaturity: held.maturityDate,
              cusip,
              maturityDate,
            });
          }
        }
        previous.set(label, { cusip, maturityDate });
      }

      const instrumentId =
        cusip === null
          ? null
          : (ctx.resolveInstrument?.({ scheme: 'CUSIP', value: cusip, qualifier: '' }) ?? null);

      rows.bills.push({
        curveDate,
        termLabel: label,
        tenorDays: spec.tenorDays,
        cusip,
        maturityDate,
        discountRate: discount,
        investmentYield: investment,
      });

      if (discount !== null) {
        rows.curvePoints.push({
          curveId: UST_BILL_CURVE_ID,
          curveDate,
          tenor: spec.tenor,
          quoteType: 'discount_rate',
          vintageAt,
          tenorDays: spec.tenorDays,
          value: discount,
          instrumentId,
          maturityDate,
        });
      }
      if (investment !== null) {
        rows.curvePoints.push({
          curveId: UST_BILL_CURVE_ID,
          curveDate,
          tenor: spec.tenor,
          quoteType: 'investment_yield',
          vintageAt,
          tenorDays: spec.tenorDays,
          value: investment,
          instrumentId,
          maturityDate,
        });
      }
    }
  });

  // One update per resolved line, carrying the LAST published day for its label: the feed is a
  // whole month in ascending date order, and the plant holds a current value, not a history.
  const latest = new Map<string, BillRow>();
  for (const bill of rows.bills) {
    const held = latest.get(bill.termLabel);
    if (held === undefined || bill.curveDate >= held.curveDate) latest.set(bill.termLabel, bill);
  }
  for (const [label, line] of ctx.lines) {
    const investmentYield = latest.get(label)?.investmentYield;
    if (investmentYield === undefined || investmentYield === null) continue;
    updates.push({
      subject: `q:${String(line.instrumentId)}`,
      instrumentId: line.instrumentId,
      mdLineId: line.mdLineId,
      assetClass: line.assetClass,
      tier: line.tier,
      fields: { PX_LAST: investmentYield },
      ts: { src: null, cap: raw.capturedAt, pub: 0 },
      prov: { sourceId: 'treasury.bills', provenanceId: ctx.provenanceId },
      session: 'closed',
    });
  }

  // As for the par curve: an empty bill month is drift, never data.
  if (feed.entries.length === 0) {
    problems.push({
      kind: 'schema_drift',
      detail: 'the feed parsed but carries no <entry> — the dataset name or the filter has changed',
      path: '/feed',
    });
  } else if (rows.bills.length === 0) {
    problems.push({
      kind: 'schema_drift',
      detail: `${String(feed.entries.length)} entries carried no usable bill — the ROUND_B1_* column names have changed`,
      path: '/feed',
    });
  }

  return { updates, rows, sourceTs: feed.sourceTs, problems };
}
