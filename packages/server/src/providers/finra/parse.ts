/**
 * `finra.shortInterest` — the pure half. PROVIDERS.b §12, WORKPLAN WP-05.
 *
 * The consolidated short-interest file, read with the shared RFC 4180 reader. One published row
 * per `(symbolCode, settlementDate)`; the PK downstream is `(instrument_id, settlement_date)`, so
 * a revision overwrites rather than accumulating — FINRA republishes corrected figures under the
 * same settlement date and that is the intended semantics.
 *
 * Three published numbers are **cross-checks, not just values**, and all three are computed here
 * so the job can raise `reconcile_mismatch` without re-reading the CSV:
 *
 *  - `changePreviousNumber` must equal `current − previous`;
 *  - `daysToCoverQuantity` must equal `short_qty / avg_daily_volume` to within 1 %;
 *  - `daysToCover` above 100 is `out_of_range`: the field is dropped and the quantities kept,
 *    because the quantities are still true and a 4,000-day cover figure on a screen is not.
 *
 * `stockSplitFlag` has no column in `short_interest`, and it is not silently dropped either: a
 * split makes the change figures incomparable, so it is surfaced on the row for
 * `dq_events.details`.
 *
 * The one thing this parser deliberately does not do is resolve `symbolCode` to an
 * `instrument_id`. Resolution needs `identifiers`, which needs a database, which `parse.ts` may
 * not have (§1.2); the job resolves each row and files an unresolved symbol as
 * `data_exceptions(kind 'unresolved_identifier')`.
 */

import { field, numberField, parseCsvTable } from '../csv.js';
import type { NormaliseContext, NormaliseProblem, Normalised, RawRecord } from '../types.js';

/** §12: fewer than this across the whole page walk → `poll_anomaly`, nothing written. */
export const MIN_SHORT_INTEREST_ROWS = 5_000;

/** §12: a cover figure above this is out of range. */
export const MAX_DAYS_TO_COVER = 100;

/** §12: the recomputed cover figure may differ from the published one by at most this fraction. */
export const DAYS_TO_COVER_TOLERANCE = 0.01;

/** §12: `limit=1000`, `offset` walked until a short page, capped at 20 pages. */
export const SHORT_INTEREST_PAGE_LIMIT = 1_000;
export const SHORT_INTEREST_MAX_PAGES = 20;

/** One `short_interest` row plus the fields the writer needs for resolution and cross-checks. */
export interface ShortInterestRow {
  /** Resolves `instrument_id` through `identifiers(TICKER_EXCH, value, qualifier 'US')`. */
  symbolCode: string;
  /** Cross-checked against `issuers.name`; a disagreement is `reconcile_mismatch`. */
  issueName: string | null;
  /** Cross-checked against `listings.mic`. */
  marketClassCode: string | null;
  /** The **settlement** date, not the publication date. PK with the instrument. */
  settlementDate: string;
  shortQty: number | null;
  prevShortQty: number | null;
  avgDailyVolume: number | null;
  /** As published; `null` when it is out of range (the quantities are kept). */
  daysToCover: number | null;
  changePct: number | null;
  revision: boolean;
  /** No column; surfaced in `dq_events.details` because a split makes the changes incomparable. */
  stockSplitFlag: string | null;
  /** `accountingYearMonthNumber`, kept for audit only. */
  accountingYearMonth: string | null;
}

export interface ShortInterestRows {
  rows: ShortInterestRow[];
  /** Highest `settlementDate` in the payload — the job's short-circuit test (§12). */
  maxSettlementDate: string | null;
}

function textOf(body: Buffer | string): string {
  return typeof body === 'string' ? body : body.toString('utf8');
}

function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}

/**
 * `'2020-04-15'`, `'04/15/2020'` or `'20200415'` → `'2020-04-15'`; anything else → `null`.
 *
 * Three spellings because FINRA's CSV and JSON representations disagree and the adapter pins the
 * CSV one; accepting the others costs nothing and refuses to guess between them.
 */

/**
 * Code-unit ordering. `String.prototype.localeCompare` is locale- and ICU-dependent, and a golden
 * file may not depend on which collation the host happens to ship.
 */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function parseSettlementDate(value: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso !== null) return value;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (compact !== null) return `${compact[1] ?? ''}-${compact[2] ?? ''}-${compact[3] ?? ''}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (us !== null) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${us[3] ?? ''}-${pad2(month)}-${pad2(day)}`;
  }
  return null;
}

/** `'Y'`/`'y'`/`'1'`/`'true'` → `true`; empty → `false` (§12). */
export function parseRevisionFlag(value: string | null): boolean {
  if (value === null) return false;
  const folded = value.trim().toLowerCase();
  return folded === 'y' || folded === '1' || folded === 'true' || folded === 'yes';
}

/**
 * The consolidated short-interest CSV → rows. Never throws: a body that is not CSV, a header that
 * lost a column and a row with a non-numeric quantity all come back as problems.
 */
export function parseShortInterest(body: Buffer | string): {
  rows: ShortInterestRows;
  problems: NormaliseProblem[];
} {
  const parsed = parseCsvTable(textOf(body), { trim: true });
  if (!parsed.ok) {
    return { rows: { rows: [], maxSettlementDate: null }, problems: [...parsed.problems] };
  }
  const table = parsed.table;
  const problems: NormaliseProblem[] = [...table.problems];

  for (const required of ['symbolcode', 'settlementdate', 'currentshortpositionquantity']) {
    if (!table.columns.has(required)) {
      problems.push({
        kind: 'schema_drift',
        detail: `finra short interest CSV has no '${required}' column`,
      });
      return { rows: { rows: [], maxSettlementDate: null }, problems };
    }
  }

  const rows: ShortInterestRow[] = [];
  let maxSettlementDate: string | null = null;

  table.rows.forEach((row, index) => {
    const path = `/${String(index + 2)}`;
    const symbolCode = field(table, row, 'symbolCode');
    if (symbolCode === null) {
      problems.push({ kind: 'schema_drift', detail: 'finra row carries no symbolCode', path });
      return;
    }
    const settlementRaw = field(table, row, 'settlementDate');
    const settlementDate = settlementRaw === null ? null : parseSettlementDate(settlementRaw);
    if (settlementDate === null) {
      problems.push({
        kind: 'schema_drift',
        detail: `finra row for ${symbolCode} has no usable settlementDate ('${settlementRaw ?? ''}')`,
        path,
      });
      return;
    }

    const shortQty = numberField(table, row, 'currentShortPositionQuantity');
    const prevShortQty = numberField(table, row, 'previousShortPositionQuantity');
    const avgDailyVolume = numberField(table, row, 'averageDailyVolumeQuantity');
    const publishedCover = numberField(table, row, 'daysToCoverQuantity');
    const changePct = numberField(table, row, 'changePercent');
    const changePrevious = numberField(table, row, 'changePreviousNumber');

    let daysToCover = publishedCover;
    if (publishedCover !== null && publishedCover > MAX_DAYS_TO_COVER) {
      daysToCover = null;
      problems.push({
        kind: 'out_of_range',
        detail:
          `finra daysToCover ${String(publishedCover)} for ${symbolCode} exceeds ` +
          `${String(MAX_DAYS_TO_COVER)}; the field is dropped and the quantities kept`,
        path: `${path}/daysToCoverQuantity`,
      });
    } else if (
      publishedCover !== null &&
      shortQty !== null &&
      avgDailyVolume !== null &&
      avgDailyVolume > 0
    ) {
      const recomputed = shortQty / avgDailyVolume;
      const divergence = Math.abs(recomputed - publishedCover) / Math.max(publishedCover, 1e-9);
      if (divergence > DAYS_TO_COVER_TOLERANCE) {
        problems.push({
          kind: 'out_of_range',
          detail:
            `finra daysToCover for ${symbolCode} is ${String(publishedCover)} but ` +
            `short_qty / avg_daily_volume is ${recomputed.toFixed(4)} ` +
            `(${(divergence * 100).toFixed(2)} % apart)`,
          path: `${path}/daysToCoverQuantity`,
        });
      }
    }

    if (changePrevious !== null && shortQty !== null && prevShortQty !== null) {
      const expected = shortQty - prevShortQty;
      if (expected !== changePrevious) {
        problems.push({
          kind: 'out_of_range',
          detail:
            `finra changePreviousNumber for ${symbolCode} is ${String(changePrevious)} but ` +
            `current − previous is ${String(expected)}`,
          path: `${path}/changePreviousNumber`,
        });
      }
    }

    rows.push({
      symbolCode,
      issueName: field(table, row, 'issueName'),
      marketClassCode: field(table, row, 'marketClassCode'),
      settlementDate,
      shortQty,
      prevShortQty,
      avgDailyVolume,
      daysToCover,
      changePct,
      revision: parseRevisionFlag(field(table, row, 'revisionFlag')),
      stockSplitFlag: field(table, row, 'stockSplitFlag'),
      accountingYearMonth: field(table, row, 'accountingYearMonthNumber'),
    });

    if (maxSettlementDate === null || settlementDate > maxSettlementDate) {
      maxSettlementDate = settlementDate;
    }
  });

  rows.sort(
    (a, b) =>
      (a.settlementDate < b.settlementDate ? -1 : a.settlementDate > b.settlementDate ? 1 : 0) ||
      cmp(a.symbolCode, b.symbolCode),
  );

  return { rows: { rows, maxSettlementDate }, problems };
}

/**
 * `finra.shortInterest` → rows. No plant subject and no `md_lines` row (§12): short interest is
 * structurally two weeks old, and the DES/QM block shows its `settlement_date` and age rather than
 * letting the staleness renderer call it stale.
 *
 * `sourceTs` is the newest settlement date at midnight UTC — the instant the figures describe.
 */
export function normaliseShortInterest(
  raw: RawRecord,
  _ctx: NormaliseContext,
): Normalised<ShortInterestRows> {
  const { rows, problems } = parseShortInterest(raw.body);
  const sourceTs =
    rows.maxSettlementDate === null
      ? raw.sourceTs
      : new Date(`${rows.maxSettlementDate}T00:00:00Z`);
  return { updates: [], rows, sourceTs, problems };
}
