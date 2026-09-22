/**
 * `fed.h15` — constant-maturity Treasury yields, the pure half (PROVIDERS §10.3).
 *
 * The Data Download Program serves a CSV with a **six-line header block** before the first
 * observation:
 *
 * ```
 * "Series Description","Market yield on U.S. Treasury securities at 1-month   constant maturity, …"
 * "Unit:","Percent:_Per_Year", …
 * "Multiplier:","1", …
 * "Currency:","NA", …
 * "Unique Identifier: ","H15/H15/RIFLGFCM01_N.B", …      <- note the trailing space in the key
 * "Time Period","RIFLGFCM01_N.B","RIFLGFCM03_N.B", …
 * 2026-09-08,3.81,3.94,4.00,4.15,4.39,4.44,4.57,4.68,4.80,5.26,5.25
 * ```
 *
 * Three rules come out of that block and all three are enforced here, because each of them is a
 * silent corruption rather than a loud failure when it is not:
 *
 *  1. **columns are bound by series code, never by position** — the `Time Period` row names them;
 *  2. **`Multiplier:` must be `1`** — a multiplier of 100 would scale every yield and still parse;
 *  3. **`Unique Identifier:`'s last segment must equal the column's code** — the two disagreeing
 *     means the file's identity and its data have come apart, and a column whose identity is
 *     ambiguous is dropped rather than attributed to a guess.
 *
 * `Unit:` is asserted `Percent:_Per_Year` and the series description has its runs of multiple
 * spaces collapsed (`"at 1-month   constant maturity"`) before it reaches `econ_series.name`.
 *
 * PURITY (PROVIDERS §1.2, QA-05): no IO, no clock, no randomness, no throw. No `NormalisedUpdate`
 * is emitted — H.15's plant subjects are `e:<seriesCode>` and `c:UST_CMT`, and only the job holds
 * the `provider_code → series_code` mapping and the curve build.
 */

import type { Normalised, NormaliseContext, NormaliseProblem, RawRecord } from '../types.js';
import {
  collapseSpaces,
  field,
  isIsoDateField,
  parseCsv,
  parseCsvTable,
  splitHeaderBlock,
  stripBom,
} from '../csv.js';

/** `provenance.adapter_version` (PROVIDERS §1.4). */
export const FED_H15_ADAPTER_VERSION = 'fedH15/1.0.0';

/** `curves.curve_id` of the constant-maturity curve. */
export const UST_CMT_CURVE_ID = 'UST_CMT';

/** The unit every H.15 CMT column publishes; anything else is schema drift. */
export const EXPECTED_UNIT = 'Percent:_Per_Year';
/** `econ_series.units` for that unit. */
export const UNITS = 'Percent';

/** H.15 writes `ND` for "no data"; the other markers are accepted defensively. */
const MISSING_MARKERS: ReadonlySet<string> = new Set(['nd', '', '.', 'na', 'n/a']);

/** The eleven CMT series, in published column order, with their curve tenors (§10.3). */
export const CMT_SERIES: readonly {
  readonly providerCode: string;
  readonly tenor: string;
  readonly tenorDays: number;
}[] = [
  { providerCode: 'RIFLGFCM01_N.B', tenor: '1M', tenorDays: 30 },
  { providerCode: 'RIFLGFCM03_N.B', tenor: '3M', tenorDays: 91 },
  { providerCode: 'RIFLGFCM06_N.B', tenor: '6M', tenorDays: 182 },
  { providerCode: 'RIFLGFCY01_N.B', tenor: '1Y', tenorDays: 365 },
  { providerCode: 'RIFLGFCY02_N.B', tenor: '2Y', tenorDays: 730 },
  { providerCode: 'RIFLGFCY03_N.B', tenor: '3Y', tenorDays: 1095 },
  { providerCode: 'RIFLGFCY05_N.B', tenor: '5Y', tenorDays: 1826 },
  { providerCode: 'RIFLGFCY07_N.B', tenor: '7Y', tenorDays: 2556 },
  { providerCode: 'RIFLGFCY10_N.B', tenor: '10Y', tenorDays: 3653 },
  { providerCode: 'RIFLGFCY20_N.B', tenor: '20Y', tenorDays: 7305 },
  { providerCode: 'RIFLGFCY30_N.B', tenor: '30Y', tenorDays: 10958 },
];

const TENOR_BY_CODE: ReadonlyMap<string, { tenor: string; tenorDays: number }> = new Map(
  CMT_SERIES.map((s) => [s.providerCode, { tenor: s.tenor, tenorDays: s.tenorDays }]),
);

/** What the header block says about one column — everything `econ_series` learns from the file. */
export interface H15SeriesRow {
  /** The `Time Period` column name, e.g. `RIFLGFCY10_N.B`. */
  providerCode: string;
  /** `Series Description`, runs of spaces collapsed. */
  name: string;
  units: string;
  /** `H15/H15/RIFLGFCY10_N.B`. */
  uniqueIdentifier: string;
  /** The CMT curve tenor, or `null` for a column outside the eleven-tenor map. */
  tenor: string | null;
  tenorDays: number | null;
}

export interface H15ObservationRow {
  providerCode: string;
  obsDate: string;
  value: number | null;
  status: 'final' | 'missing';
}

/** One `curve_points` row on `UST_CMT`. */
export interface CmtCurvePointRow {
  curveId: string;
  curveDate: string;
  tenor: string;
  quoteType: 'cmt_yield';
  vintageAt: string;
  tenorDays: number;
  value: number;
  instrumentId: null;
  maturityDate: null;
}

export interface FedH15Rows {
  series: H15SeriesRow[];
  observations: H15ObservationRow[];
  curvePoints: CmtCurvePointRow[];
  /** Dates on which every column was `ND` — a Sunday, or a `missing_close` on a business day. */
  allMissingDates: string[];
}

function failure(problem: NormaliseProblem): Normalised<FedH15Rows> {
  return {
    updates: [],
    rows: { series: [], observations: [], curvePoints: [], allMissingDates: [] },
    sourceTs: null,
    problems: [problem],
  };
}

/** `'Unique Identifier: '` → `'unique identifier'`; the trailing space and colon are noise. */
function labelKey(text: string): string {
  return collapseSpaces(text).replace(/:$/, '').trim().toLowerCase();
}

/**
 * `fed-h15.csv` → `econ_observations` + `curve_points(curve_id 'UST_CMT')`.
 *
 * A column is dropped (with a `schema_drift` problem) when its multiplier is not 1 or when its
 * unique identifier and its column name disagree. A dropped column costs its observations; a bad
 * multiplier silently applied would cost the curve.
 */
export function parseH15(raw: RawRecord, ctx: NormaliseContext): Normalised<FedH15Rows> {
  const text = stripBom(raw.body.toString('utf8'));
  if (text.trimStart().startsWith('<')) {
    return failure({
      kind: 'parse_error',
      detail:
        'the body is HTML, not CSV — the Data Download Program answers an unknown series with a page, not an error status',
      path: '/',
    });
  }

  const scanned = parseCsv(text, { skipEmptyLines: true });
  if (!scanned.ok) return failure(scanned.problem);

  const split = splitHeaderBlock(scanned.rows, (row) => isIsoDateField(row[0]));
  if (split.headerRowIndex === null || split.dataRows.length === 0) {
    return failure({
      kind: 'schema_drift',
      detail: `no ISO-dated observation row follows the header block (${String(scanned.rows.length)} rows read)`,
      path: '/',
    });
  }

  const headerRowIndex = split.headerRowIndex;

  const labelled = new Map<string, readonly string[]>();
  split.headerRows.forEach((row) => {
    const key = labelKey(row[0] ?? '');
    if (key !== '' && !labelled.has(key)) labelled.set(key, row);
  });

  const codesRow = labelled.get('time period');
  if (codesRow === undefined) {
    return failure({
      kind: 'schema_drift',
      detail: `the header block has no 'Time Period' row, so no column can be bound by series code (labels seen: ${[...labelled.keys()].join(', ')})`,
      path: '/',
    });
  }

  const descriptions = labelled.get('series description') ?? [];
  const units = labelled.get('unit') ?? [];
  const multipliers = labelled.get('multiplier') ?? [];
  const identifiers = labelled.get('unique identifier') ?? [];

  const problems: NormaliseProblem[] = [...scanned.problems];
  const series: H15SeriesRow[] = [];
  const kept: string[] = [];

  for (let column = 1; column < codesRow.length; column += 1) {
    const providerCode = (codesRow[column] ?? '').trim();
    if (providerCode === '') continue;
    const path = `/6/${String(column)}`;

    const multiplier = (multipliers[column] ?? '').trim();
    if (multiplier !== '' && multiplier !== '1') {
      problems.push({
        kind: 'schema_drift',
        detail: `${providerCode} publishes Multiplier ${multiplier}, not 1 — the column is dropped rather than scaled`,
        path,
      });
      continue;
    }

    const uniqueIdentifier = (identifiers[column] ?? '').trim();
    if (uniqueIdentifier !== '') {
      const tail = uniqueIdentifier.split('/').pop() ?? '';
      if (tail !== providerCode) {
        problems.push({
          kind: 'schema_drift',
          detail: `column '${providerCode}' carries Unique Identifier '${uniqueIdentifier}', whose last segment is '${tail}' — the column is dropped rather than attributed to a guess`,
          path,
        });
        continue;
      }
    }

    const unit = (units[column] ?? '').trim();
    if (unit !== '' && unit !== EXPECTED_UNIT) {
      problems.push({
        kind: 'schema_drift',
        detail: `${providerCode} publishes Unit '${unit}', expected '${EXPECTED_UNIT}'`,
        path,
      });
    }

    const tenor = TENOR_BY_CODE.get(providerCode);
    series.push({
      providerCode,
      name: collapseSpaces(descriptions[column] ?? ''),
      units: unit === EXPECTED_UNIT || unit === '' ? UNITS : unit,
      uniqueIdentifier,
      tenor: tenor?.tenor ?? null,
      tenorDays: tenor?.tenorDays ?? null,
    });
    kept.push(providerCode);
  }

  if (kept.length === 0) {
    return failure({
      kind: 'schema_drift',
      detail: 'no column survived the header-block checks, so the file names no series',
      path: '/6',
    });
  }

  // Re-parse bound by header text: `parseCsvTable` with the block's last row as the header is
  // exactly the "bind by series code, never by position" rule, and it is `csv.ts`'s documented
  // use for this file.
  const bound = parseCsvTable(text, {
    headerRow: headerRowIndex,
    skipEmptyLines: true,
    checkWidth: false,
  });
  if (!bound.ok) return failure(bound.problem);
  const table = bound.table;

  const observations: H15ObservationRow[] = [];
  const curvePoints: CmtCurvePointRow[] = [];
  const allMissingDates: string[] = [];
  const vintageAt = new Date(raw.capturedAt).toISOString();

  table.rows.forEach((row, index) => {
    const obsDate = (row[0] ?? '').trim();
    if (!isIsoDateField(obsDate)) {
      if (obsDate !== '')
        problems.push({
          kind: 'parse_error',
          detail: `observation row starts with '${obsDate}', not an ISO date`,
          path: `/${String(index + headerRowIndex + 2)}/0`,
        });
      return;
    }
    let present = 0;
    for (const providerCode of kept) {
      const cell = field(table, row, providerCode);
      const cellValue = cell ?? '';
      if (MISSING_MARKERS.has(cellValue.toLowerCase())) {
        observations.push({ providerCode, obsDate, value: null, status: 'missing' });
        continue;
      }
      const value = Number(cellValue.replace(/,/g, ''));
      if (!Number.isFinite(value)) {
        problems.push({
          kind: 'field_dropped',
          detail: `${providerCode} on ${obsDate} is '${cellValue}', not a number; stored as missing`,
          path: `/${String(index + headerRowIndex + 2)}`,
        });
        observations.push({ providerCode, obsDate, value: null, status: 'missing' });
        continue;
      }
      present += 1;
      observations.push({ providerCode, obsDate, value, status: 'final' });
      const tenor = TENOR_BY_CODE.get(providerCode);
      if (tenor !== undefined) {
        curvePoints.push({
          curveId: UST_CMT_CURVE_ID,
          curveDate: obsDate,
          tenor: tenor.tenor,
          quoteType: 'cmt_yield',
          vintageAt,
          tenorDays: tenor.tenorDays,
          value,
          instrumentId: null,
          maturityDate: null,
        });
      }
    }
    if (present === 0) allMissingDates.push(obsDate);
  });

  void ctx;
  return {
    updates: [],
    rows: { series, observations, curvePoints, allMissingDates },
    sourceTs: null,
    problems,
  };
}
