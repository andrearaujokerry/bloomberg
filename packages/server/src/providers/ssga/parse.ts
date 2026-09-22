/**
 * `providers/ssga/parse.ts` — the SPDR S&P 500 daily holdings file, PROVIDERS §8.1 (L1734-1816).
 *
 * **Pure.** `providers/ssga/xlsx.ts` turns the ZIP-of-XML into a grid of cells; this module turns
 * that grid into `etf_holdings` rows and the `index_members` candidates behind them. No IO, no
 * clock, no locale, no `Date.parse` — the golden in `fixtures/providers/normalised/` and the QA-05
 * fuzzer both depend on this function being a total function of its bytes.
 *
 * ## The four things this file gets wrong if you write it casually
 *
 * **Columns are found by header text, never by position.** SSGA adding a column would otherwise
 * silently re-map Weight onto Sector, and every index weight in the system would be a sector name's
 * worth of nonsense. {@link findHeader} locates the row whose first non-empty cell is exactly
 * `Name` and indexes the rest by their own labels.
 *
 * **Cells are addressed by their `r` reference.** An empty cell is simply absent from the sheet
 * XML, so a reader that counted `<c>` siblings shifts every later column on exactly the rows that
 * omit one. `xlsx.ts` keys cells by column index; nothing here counts siblings.
 *
 * **`-` is how this file spells "none".** The recorded capture writes `-` for a missing ticker
 * (`US DOLLAR`), a missing SEDOL and — on every single row — the Sector. Treating `-` as a value
 * would put the string `-` into `etf_holdings.ticker` and make the GICS join miss on all 505 rows.
 *
 * **Weight is a percent and `index_members.weight` is a fraction.** The conversion is a decimal
 * point shift in the *string* ({@link percentToFraction}): `7.777528` → `0.07777528`, exactly.
 * `x / 100` on a float rewrites the tail of a `numeric(12,10)` and the weights stop summing to 1.
 *
 * The date is parsed with an explicit month table. `Date.parse("Sep 15, 2026")` is locale- and
 * engine-dependent and is banned in a normaliser (§1.2); the recorded file writes `As of
 * 14-Sep-2026`, and {@link parseSsgaDate} accepts that, `Sep 14, 2026` and `2026-09-14`.
 */

import { headerIndex, readXlsxSheet1 } from './xlsx.js';

import type { XlsxSheet } from './xlsx.js';
import type {
  NormaliseContext,
  NormaliseProblem,
  NormaliseProblemKind,
  Normalised,
  RawRecord,
} from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `provenance.adapter_version` (§1.4). */
export const SSGA_ADAPTER_VERSION = 'ssga/1.0.0';

/** §8.1: outside this row band the file is not believed and nothing is written. */
export const SSGA_MIN_ROWS = 495;
export const SSGA_MAX_ROWS = 515;

/** §8.1: Σ Weight outside this band is a `poll_anomaly`. */
export const SSGA_MIN_WEIGHT_SUM = '99.0';
export const SSGA_MAX_WEIGHT_SUM = '100.5';

/** The close the file describes: 16:00 America/New_York on its as-of date (§8.1). */
export const SSGA_CLOSE_HOUR = 16;

/** How this publication spells "no value". */
const NONE = '-';

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Pure helpers — total, like everything else in a normaliser
// ─────────────────────────────────────────────────────────────────────────────────────────────

function problem(kind: NormaliseProblemKind, detail: string, path?: string): NormaliseProblem {
  return path === undefined ? { kind, detail } : { kind, detail, path };
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}

function epochDay(date: string): number {
  return Math.floor(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) /
      86_400_000,
  );
}

function easternOffsetMinutes(date: string): number {
  const year = Number(date.slice(0, 4));
  const marchFirstDow = new Date(Date.UTC(year, 2, 1)).getUTCDay();
  const secondSundayMarch = 1 + ((7 - marchFirstDow) % 7) + 7;
  const novemberFirstDow = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstSundayNovember = 1 + ((7 - novemberFirstDow) % 7);
  const key = Number(date.slice(5, 7)) * 100 + Number(date.slice(8, 10));
  return key >= 300 + secondSundayMarch && key < 1100 + firstSundayNovember ? -240 : -300;
}

/**
 * The as-of date in any of the three spellings SSGA has used, as `YYYY-MM-DD`, or `null`.
 *
 * An explicit month table, deliberately: `Date.parse('Sep 14, 2026')` is implementation-defined and
 * a normaliser whose output depends on the engine cannot have a golden file (§1.2).
 */
export function parseSsgaDate(raw: string): string | null {
  const text = raw
    .trim()
    .replace(/^as\s+of\s*/i, '')
    .replace(/,/g, ' ')
    .trim();
  if (text === '') return null;

  const build = (year: number, month: number, day: number): string | null => {
    if (!Number.isInteger(year) || year < 1900 || year > 2999) return null;
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > daysInMonth(year, month)) return null;
    return `${String(year)}-${pad2(month)}-${pad2(day)}`;
  };

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso !== null) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // `14-Sep-2026` and `14 Sep 2026`
  const dmy = /^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})$/.exec(text);
  if (dmy !== null) {
    const month = MONTHS[dmy[2]!.slice(0, 3).toLowerCase()];
    return month === undefined ? null : build(Number(dmy[3]), month, Number(dmy[1]));
  }

  // `Sep 14 2026` (the comma was stripped above)
  const mdy = /^([A-Za-z]{3,})\s+(\d{1,2})\s+(\d{4})$/.exec(text);
  if (mdy !== null) {
    const month = MONTHS[mdy[1]!.slice(0, 3).toLowerCase()];
    return month === undefined ? null : build(Number(mdy[3]), month, Number(mdy[2]));
  }

  return null;
}

/** Canonical decimal text for a `numeric` column: no exponent, no trailing zeros. */
export function decimalText(value: unknown, maxScale = 6): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return null;
    return decimalText(Number(trimmed), maxScale);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (Math.abs(value) >= 1e21) return null;
  const normalised = Object.is(value, -0) ? 0 : value;
  let text = String(normalised);
  if (text.includes('e') || text.includes('E')) text = normalised.toFixed(maxScale);
  const dot = text.indexOf('.');
  if (dot === -1) return text;
  const head = text.slice(0, dot);
  const frac = text.slice(dot + 1, dot + 1 + maxScale).replace(/0+$/, '');
  return frac === '' ? head : `${head}.${frac}`;
}

/**
 * Shift a decimal string's point two places to the left, exactly: `'7.777528'` → `'0.07777528'`.
 * String arithmetic, because a float division rewrites the tail of every `numeric(12,10)` weight.
 */
export function percentToFraction(text: string | null, places = 2): string | null {
  if (text === null) return null;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (m === null) return null;
  const sign = m[1] === '-' ? '-' : '';
  const int = m[2] ?? '';
  const frac = m[3] ?? '';
  if (int === '' && frac === '') return null;

  let digits = int + frac;
  let pointAt = int.length - places;
  while (pointAt < 0) {
    digits = `0${digits}`;
    pointAt += 1;
  }
  const head = digits.slice(0, pointAt).replace(/^0+(?=\d)/, '') || '0';
  const tail = digits.slice(pointAt).replace(/0+$/, '');
  if (tail === '') return head === '0' ? '0' : `${sign}${head}`;
  return `${sign}${head}.${tail}`;
}

/** Exact sum of decimal strings to `scale` places — Σ Weight, without float drift. */
export function sumDecimal(values: readonly (string | null)[], scale: number): string {
  let total = 0n;
  const factor = 10n ** BigInt(scale);
  for (const value of values) {
    if (value === null) continue;
    const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value);
    if (m === null) continue;
    const sign = m[1] === '-' ? -1n : 1n;
    const int = BigInt(m[2] === '' || m[2] === undefined ? '0' : m[2]);
    const fracText = (m[3] ?? '').slice(0, scale).padEnd(scale, '0');
    total += sign * (int * factor + BigInt(fracText === '' ? '0' : fracText));
  }
  const negative = total < 0n;
  const abs = negative ? -total : total;
  return `${negative ? '-' : ''}${(abs / factor).toString()}.${(abs % factor).toString().padStart(scale, '0')}`;
}

/** Compare two decimal strings — used for the Σ Weight band, which must not go through a float. */
function decimalLess(a: string, b: string): boolean {
  const scale = 12;
  const normalise = (text: string): bigint => {
    const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
    if (m === null) return 0n;
    const sign = m[1] === '-' ? -1n : 1n;
    const int = BigInt(m[2] === '' || m[2] === undefined ? '0' : m[2]);
    const frac = BigInt((m[3] ?? '').slice(0, scale).padEnd(scale, '0') || '0');
    return sign * (int * 10n ** BigInt(scale) + frac);
  };
  return normalise(a) < normalise(b);
}

function cleaned(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === NONE ? null : trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row types
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The metadata block above the table (rows 1-4 of the sheet). */
export interface SsgaHeader {
  fundName: string | null;
  ticker: string | null;
  /** `etf_holdings.as_of_date` / `index_members.as_of_date`. */
  asOfDate: string | null;
  /** The sheet row the `Name` header was found on — 5 in the recorded file. */
  headerRow: number | null;
}

/** One `etf_holdings` row (`source_id 'ssga.holdings'`). */
export interface SsgaHolding {
  /** 1-based position in the table — `etf_holdings.line_no`, part of the PK. */
  lineNo: number;
  name: string;
  /** Resolution key 3. SSGA writes class shares as `BRK.B`; the resolver tries three spellings. */
  ticker: string | null;
  /** Resolution key 1. SSGA publishes the CUSIP here for US names. */
  cusip: string | null;
  /** Resolution key 2. */
  sedol: string | null;
  /** The published percent, verbatim. */
  weightPercent: string | null;
  /** `weightPercent / 100` — what `index_members.weight` takes. */
  weight: string | null;
  /**
   * The sector **name**, not a GICS code — SSGA publishes no codes, and the lookup is seeded from
   * `wiki.sp500`. `null` on every row of the 2026-09-15 capture, which publishes `-` throughout.
   */
  sector: string | null;
  shares: string | null;
  currency: string | null;
  /**
   * `etf_holdings.market_value` is NULL for this source: the file publishes no value, and deriving
   * one from weight × net assets would invent a number (§8.1).
   */
  marketValue: null;
}

export interface SsgaHoldingsRows {
  header: SsgaHeader;
  holdings: SsgaHolding[];
  rowCount: number;
  /**
   * Rows priced in USD that carry a readable weight — the ones the job may resolve into
   * `index_members` (a non-USD row stays in `etf_holdings` and is excluded).
   *
   * Deliberately an aggregate and **not** a per-row `indexEligible` flag. The sheet states no
   * index eligibility: it has no asset category, no payoff profile and no issuer category, so a
   * per-row flag could only ever be `currency === 'USD'`, which is `true` on all 505 rows of the
   * capture — including `CONTRA HOLOGIC INCORPO` (`436CVR021`), the placeholder line that SPY's
   * N-PORT marks ineligible from `assetCat 'DE'`/`payoffProfile 'N/A'`. WORKPLAN L1248 joins the
   * two membership sources in MEMB, and a flag that says `true` here and `false` there would show
   * REF-07 a phantom add/drop. Eligibility is taken from N-PORT, the source that states it.
   */
  usdRowCount: number;
  /** Σ Weight, exactly — 99.951255 in the 2026-09-15 capture. */
  weightSum: string;
  /** §8.1: `true` when the row count or Σ Weight is outside its band and nothing may be written. */
  outsideBands: boolean;
}

const EMPTY: SsgaHoldingsRows = {
  header: { fundName: null, ticker: null, asOfDate: null, headerRow: null },
  holdings: [],
  rowCount: 0,
  usdRowCount: 0,
  weightSum: '0.000000',
  outsideBands: true,
};

function failed(
  detail: string,
  kind: NormaliseProblemKind = 'parse_error',
): Normalised<SsgaHoldingsRows> {
  return { updates: [], rows: EMPTY, sourceTs: null, problems: [problem(kind, detail)] };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The sheet
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Text of a cell, trimmed; `''` when it is empty or absent. */
function textAt(sheet: XlsxSheet, row: number, column: number | undefined): string {
  if (column === undefined) return '';
  return sheet.byRow.get(row)?.cells.get(column)?.text.trim() ?? '';
}

/**
 * The header row and its column map. Located by the label `Name`, never by a row number: the
 * metadata block above the table has grown and shrunk between SSGA's own revisions.
 */
export function findHeader(sheet: XlsxSheet): { row: number; columns: Map<string, number> } | null {
  return headerIndex(sheet, 'Name');
}

/** The value beside a metadata label (`Fund Name:`, `Ticker Symbol:`, `Holdings:`). */
function metadataValue(sheet: XlsxSheet, label: string, limit: number): string | null {
  const wanted = label.toLowerCase();
  for (const row of sheet.rows) {
    if (row.row >= limit) break;
    const columns = [...row.cells.keys()].sort((a, b) => a - b);
    const first = columns[0];
    if (first === undefined) continue;
    const key = (row.cells.get(first)?.text ?? '').trim().toLowerCase().replace(/:$/, '');
    if (key !== wanted) continue;
    for (const column of columns.slice(1)) {
      const value = (row.cells.get(column)?.text ?? '').trim();
      if (value !== '') return value;
    }
  }
  return null;
}

/**
 * `ssga-spy-holdings.xlsx` → `etf_holdings` + the `index_members` candidates (§8.1).
 *
 * `provenance.source_ts` is the as-of date at 16:00 America/New_York — the close the file
 * describes, not the instant we fetched it.
 */
export function normaliseSsgaHoldings(
  raw: RawRecord,
  _ctx: NormaliseContext,
): Normalised<SsgaHoldingsRows> {
  if (!Buffer.isBuffer(raw.body) || raw.body.length === 0) {
    return failed('ssga.holdings: body is empty or not a Buffer');
  }
  // §8.1: the CDN answers an unfamiliar agent with an HTML page and a 200. Two bytes tell them
  // apart, and saying so here is what stops a "zero holdings" day from looking like a real one.
  if (raw.body[0] !== 0x50 || raw.body[1] !== 0x4b) {
    return failed(
      'ssga.holdings: the body does not begin with the ZIP signature `PK` — the CDN served an ' +
        'HTML error page with a 200 status (§8.1)',
    );
  }

  const workbook = readXlsxSheet1(raw.body);
  if (!workbook.ok) return failed(`ssga.holdings: ${workbook.problem.detail}`);

  const problems: NormaliseProblem[] = [...workbook.problems];
  const sheet = workbook.sheet;

  const header = findHeader(sheet);
  if (header === null) {
    return {
      updates: [],
      rows: EMPTY,
      sourceTs: null,
      problems: [
        ...problems,
        problem(
          'schema_drift',
          'ssga.holdings: no row whose first cell is `Name` — the table header is gone',
        ),
      ],
    };
  }

  const columns = header.columns;
  const nameColumn = columns.get('name');
  if (nameColumn === undefined) {
    return {
      updates: [],
      rows: EMPTY,
      sourceTs: null,
      problems: [
        ...problems,
        problem('schema_drift', 'ssga.holdings: the header row has no Name column'),
      ],
    };
  }
  for (const wanted of ['ticker', 'identifier', 'weight', 'shares held', 'local currency']) {
    if (!columns.has(wanted)) {
      problems.push(
        problem('schema_drift', `ssga.holdings: the header row has no '${wanted}' column`),
      );
    }
  }

  const asOfRaw =
    metadataValue(sheet, 'holdings', header.row) ??
    metadataValue(sheet, 'holdings as of', header.row) ??
    metadataValue(sheet, 'as of', header.row);
  const asOfDate = asOfRaw === null ? null : parseSsgaDate(asOfRaw);
  if (asOfDate === null) {
    problems.push(
      problem(
        'parse_error',
        `ssga.holdings: no readable 'Holdings as of' date (found ${asOfRaw === null ? 'no label' : `'${asOfRaw}'`})`,
      ),
    );
  }

  const holdings: SsgaHolding[] = [];
  const weights: (string | null)[] = [];
  let usdRowCount = 0;

  // A row with an empty Name ends the table: the file continues with a disclaimer block.
  for (let row = header.row + 1; row <= sheet.maxRow; row += 1) {
    const name = textAt(sheet, row, nameColumn);
    if (name === '' || name === NONE) break;

    const weightPercent = decimalText(textAt(sheet, row, columns.get('weight')), 8);
    const currency = cleaned(textAt(sheet, row, columns.get('local currency')));
    if (weightPercent === null) {
      problems.push(
        problem(
          'parse_error',
          `row ${String(row)} ('${name}') has no readable Weight`,
          `/sheet/${String(row)}`,
        ),
      );
    }
    if (currency !== null && currency !== 'USD') {
      problems.push(
        problem(
          'field_dropped',
          `row ${String(row)} ('${name}') is priced in ${currency}; kept in etf_holdings, excluded from index_members`,
          `/sheet/${String(row)}`,
        ),
      );
    }

    if (currency === 'USD' && weightPercent !== null) usdRowCount += 1;
    weights.push(weightPercent);

    holdings.push({
      lineNo: holdings.length + 1,
      name,
      ticker: cleaned(textAt(sheet, row, columns.get('ticker'))),
      cusip: cleaned(textAt(sheet, row, columns.get('identifier'))),
      sedol: cleaned(textAt(sheet, row, columns.get('sedol'))),
      weightPercent,
      weight: percentToFraction(weightPercent, 2),
      sector: cleaned(textAt(sheet, row, columns.get('sector'))),
      shares: decimalText(textAt(sheet, row, columns.get('shares held')), 4),
      currency,
      marketValue: null,
    });
  }

  const weightSum = sumDecimal(weights, 6);
  const rowCount = holdings.length;
  const outsideBands =
    rowCount < SSGA_MIN_ROWS ||
    rowCount > SSGA_MAX_ROWS ||
    decimalLess(weightSum, SSGA_MIN_WEIGHT_SUM) ||
    decimalLess(SSGA_MAX_WEIGHT_SUM, weightSum);

  return {
    updates: [],
    rows: {
      header: {
        fundName: metadataValue(sheet, 'fund name', header.row),
        ticker: metadataValue(sheet, 'ticker symbol', header.row),
        asOfDate,
        headerRow: header.row,
      },
      holdings,
      rowCount,
      usdRowCount,
      weightSum,
      outsideBands,
    },
    sourceTs:
      asOfDate === null
        ? null
        : new Date(
            (epochDay(asOfDate) * 1440 + SSGA_CLOSE_HOUR * 60 - easternOffsetMinutes(asOfDate)) *
              60_000,
          ),
    problems,
  };
}
