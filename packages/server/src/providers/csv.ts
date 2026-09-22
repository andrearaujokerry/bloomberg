/**
 * RFC 4180 CSV, plus the quirks the real files have — PROVIDERS.b §16.5 (§18.5), WORKPLAN WP-05.
 *
 * The third of the four shared parsers. Three captured files exercise every branch:
 *
 * | File | Quirk |
 * | --- | --- |
 * | `fred-DGS10.csv` (262 KB, 16 879 observations) | an **empty field** is the missing observation, not a zero — 720 of them; the header is `observation_date,DGS10` and the series code is column 2's *header*, not a constant (PROVIDERS §10.1) |
 * | `fed-h15.csv` | a **six-line header block** before the data: `Series Description`, `Unit:`, `Multiplier:`, `Currency:`, `Unique Identifier: ` (with its trailing space), `Time Period`. Every field is quoted, and a description contains commas *and* runs of spaces that carry meaning (PROVIDERS §10.3) |
 * | `finra-trace` (consolidated short interest) | 14 columns, one data row, and a trailing blank line (PROVIDERS §12) |
 *
 * A fourth shape is supported without a capture: a **Stooq-style** daily bar file
 * (`Date,Open,High,Low,Close,Volume`, sometimes semicolon-delimited, always CRLF). Stooq itself is
 * a rejected provider (BRIEF §2 L51 — it serves a JavaScript challenge page), but the shape is the
 * lingua franca of exported bar data and {@link detectDelimiter} plus {@link parseCsvTable} read it
 * unchanged, so an operator-supplied file lands without a second parser.
 *
 * **Purity and the QA-05 contract.** No clock, no IO, and nothing throws. `ok: false` means the
 * input was not usable at all; otherwise `problems` names every recovered defect — an unterminated
 * quoted field (the signature of a truncated download), a row whose field count disagrees with the
 * header, a field over the size limit.
 */

import type { NormaliseProblem } from './types.js';

/** Largest document accepted, in UTF-16 code units. `fred-DGS10.csv` is 262 KB. */
export const MAX_CSV_LENGTH = 64 * 1024 * 1024;
/** Most rows accepted. The longest real file has 16 880. */
export const MAX_CSV_ROWS = 5_000_000;
/** Most fields accepted in one row. */
export const MAX_CSV_COLUMNS = 4_096;

export interface CsvOptions {
  /** Field separator. Default `','`; `detectDelimiter` picks it for a file of unknown shape. */
  delimiter?: string;
  /** Quote character. Default `'"'`. */
  quote?: string;
  /** Trim leading/trailing whitespace of **unquoted** fields. Default `false` (RFC 4180). */
  trim?: boolean;
  /** Drop rows that are entirely empty. Default `true` — `finra-trace` ends with one. */
  skipEmptyLines?: boolean;
  /** Stop after this many rows. Default {@link MAX_CSV_ROWS}. */
  maxRows?: number;
}

export interface CsvOk {
  readonly ok: true;
  /** Rows of raw field strings, in file order. Quotes removed, doubled quotes collapsed. */
  readonly rows: readonly (readonly string[])[];
  readonly problems: readonly NormaliseProblem[];
  /** The delimiter actually used. */
  readonly delimiter: string;
}

export interface CsvFailure {
  readonly ok: false;
  readonly problem: NormaliseProblem;
  readonly problems: readonly NormaliseProblem[];
}

export type CsvResult = CsvOk | CsvFailure;

function failure(detail: string): CsvFailure {
  const problem: NormaliseProblem = { kind: 'parse_error', detail };
  return { ok: false, problem, problems: [problem] };
}

/** Strip a UTF-8 BOM. A `record`-mode capture keeps whatever the server sent. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Guess the delimiter of `text` from its first non-empty line: the candidate that splits it into
 * the most fields wins, `,` on a tie. Only used for files of unknown shape (a Stooq export); every
 * captured file pins its delimiter explicitly.
 */
export function detectDelimiter(
  text: string,
  candidates: readonly string[] = [',', ';', '\t', '|'],
): string {
  const line =
    stripBom(text)
      .split(/\r\n|\n|\r/)
      .find((l) => l.trim() !== '') ?? '';
  let best = ',';
  let bestCount = -1;
  for (const candidate of candidates) {
    const parsed = parseCsv(line, { delimiter: candidate });
    const count = parsed.ok ? (parsed.rows[0]?.length ?? 0) : 0;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

/**
 * Parse RFC 4180 CSV.
 *
 * The state machine is deliberately explicit rather than a regex: a quoted field may contain the
 * delimiter, a newline and a doubled quote, and every one of those appears in `fed-h15.csv`.
 *
 * Tolerances beyond the RFC, each one recorded as a problem:
 * - a bare quote inside an unquoted field is kept as a character;
 * - text after a closing quote (`"a"b`) is appended to the field;
 * - an unterminated quoted field at end of input closes at end of input — this is what a truncated
 *   download looks like, and the caller sees `parse_error` in `problems`.
 */
export function parseCsv(text: string, options: CsvOptions = {}): CsvResult {
  if (typeof text !== 'string') return failure('parseCsv: input is not a string');
  if (text.length > MAX_CSV_LENGTH)
    return failure(
      `parseCsv: ${String(text.length)} chars, over the ${String(MAX_CSV_LENGTH)} limit`,
    );

  const delimiter = options.delimiter ?? ',';
  const quote = options.quote ?? '"';
  if (delimiter.length !== 1) return failure('parseCsv: delimiter must be exactly one character');
  if (quote.length !== 1) return failure('parseCsv: quote must be exactly one character');
  if (delimiter === quote) return failure('parseCsv: delimiter and quote must differ');

  const trim = options.trim ?? false;
  const skipEmptyLines = options.skipEmptyLines ?? true;
  const maxRows = Math.min(options.maxRows ?? MAX_CSV_ROWS, MAX_CSV_ROWS);

  const source = stripBom(text);
  const problems: NormaliseProblem[] = [];
  const note = (detail: string, line: number): void => {
    if (problems.length < 64)
      problems.push({ kind: 'parse_error', detail, path: `/${String(line)}` });
  };

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let fieldQuoted = false;
  let inQuotes = false;
  let line = 1;
  let truncated = false;

  const delimiterCode = delimiter.charCodeAt(0);
  const quoteCode = quote.charCodeAt(0);

  const pushField = (): void => {
    if (row.length >= MAX_CSV_COLUMNS) {
      note(`row has more than ${String(MAX_CSV_COLUMNS)} fields; the rest is dropped`, line);
      field = '';
      fieldQuoted = false;
      return;
    }
    row.push(trim && !fieldQuoted ? field.trim() : field);
    field = '';
    fieldQuoted = false;
  };

  const pushRow = (): boolean => {
    pushField();
    const empty = row.length === 1 && (row[0] ?? '') === '';
    if (!(skipEmptyLines && empty)) rows.push(row);
    row = [];
    return rows.length < maxRows;
  };

  const n = source.length;
  let i = 0;
  while (i < n) {
    const code = source.charCodeAt(i);

    if (inQuotes) {
      if (code === quoteCode) {
        if (i + 1 < n && source.charCodeAt(i + 1) === quoteCode) {
          field += quote;
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (code === 0x0a) line += 1;
      field += source[i];
      i += 1;
      continue;
    }

    if (code === quoteCode) {
      if (field === '') {
        inQuotes = true;
        fieldQuoted = true;
      } else {
        // `a"b` — not RFC 4180, but a real export quirk. Keep the character, say so once.
        note('quote inside an unquoted field', line);
        field += quote;
      }
      i += 1;
      continue;
    }
    if (code === delimiterCode) {
      pushField();
      i += 1;
      continue;
    }
    if (code === 0x0d /* CR */) {
      const crlf = i + 1 < n && source.charCodeAt(i + 1) === 0x0a;
      line += 1;
      i += crlf ? 2 : 1;
      if (!pushRow()) {
        truncated = true;
        break;
      }
      continue;
    }
    if (code === 0x0a /* LF */) {
      line += 1;
      i += 1;
      if (!pushRow()) {
        truncated = true;
        break;
      }
      continue;
    }
    field += source[i];
    i += 1;
  }

  if (inQuotes) note('unterminated quoted field at end of input', line);
  if (!truncated && (field !== '' || row.length > 0)) pushRow();
  if (truncated) note(`stopped at the ${String(maxRows)}-row limit`, line);

  return { ok: true, rows, problems, delimiter };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Header-bound access
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface CsvTable {
  /** The header row's fields, exactly as written. */
  readonly header: readonly string[];
  /** Every row after the header. */
  readonly rows: readonly (readonly string[])[];
  /** `trimmed, lower-cased header → column index`, first occurrence wins. */
  readonly columns: ReadonlyMap<string, number>;
  readonly problems: readonly NormaliseProblem[];
  readonly delimiter: string;
}

export type CsvTableResult = { readonly ok: true; readonly table: CsvTable } | CsvFailure;

export interface CsvTableOptions extends CsvOptions {
  /** 0-based index of the header row among the parsed rows. Default `0`; H.15 uses `5`. */
  headerRow?: number;
  /** Report a row whose field count differs from the header's. Default `true`. */
  checkWidth?: boolean;
}

/**
 * Parse and bind columns by header text.
 *
 * `headerRow` is how the H.15 block is handled: its column names are on line 6 (index 5) and the
 * five lines above it are metadata, so `parseCsvTable(text, { headerRow: 5 })` yields exactly the
 * data rows with `RIFLGFCY10_N.B` bound by name. `splitHeaderBlock` below finds that index for a
 * file whose header depth is not known in advance.
 */
export function parseCsvTable(text: string, options: CsvTableOptions = {}): CsvTableResult {
  const parsed = parseCsv(text, options);
  if (!parsed.ok) return parsed;

  const headerRow = options.headerRow ?? 0;
  const header = parsed.rows[headerRow];
  if (header === undefined) {
    return failure(
      `parseCsvTable: no header row at index ${String(headerRow)} (the file has ${String(parsed.rows.length)} rows)`,
    );
  }

  const columns = new Map<string, number>();
  header.forEach((name, index) => {
    const key = name.trim().toLowerCase();
    if (key !== '' && !columns.has(key)) columns.set(key, index);
  });

  const problems: NormaliseProblem[] = [...parsed.problems];
  const rows = parsed.rows.slice(headerRow + 1);
  if (options.checkWidth ?? true) {
    let reported = 0;
    rows.forEach((row, index) => {
      if (row.length !== header.length && reported < 16) {
        reported += 1;
        problems.push({
          kind: 'schema_drift',
          detail: `row has ${String(row.length)} fields, the header has ${String(header.length)}`,
          path: `/${String(index + headerRow + 2)}`,
        });
      }
    });
  }

  return {
    ok: true,
    table: { header, rows, columns, problems, delimiter: parsed.delimiter },
  };
}

/** The field under `column` (by header text, case-insensitive), or `null` when absent or empty. */
export function field(table: CsvTable, row: readonly string[], column: string): string | null {
  const index = table.columns.get(column.trim().toLowerCase());
  if (index === undefined) return null;
  const value = row[index];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A finite number from `column`, or `null`. **Never `NaN`**: an empty FRED observation, an H.15
 * `ND` and a literal `.` all become `null`, which is the missing-observation contract of
 * PROVIDERS §10.1 and §10.3, not a zero.
 */
export function numberField(
  table: CsvTable,
  row: readonly string[],
  column: string,
  missing: readonly string[] = ['', '.', 'nd', 'na', 'n/a', 'null', '-'],
): number | null {
  const raw = field(table, row, column);
  if (raw === null) return null;
  if (missing.includes(raw.toLowerCase())) return null;
  // Thousands separators are removed; a decimal comma is NOT guessed at — that would silently
  // turn 1,5 into 15 for a European export, and no captured file uses one.
  const value = Number(raw.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/** Each row as `{lower-cased header: field}`. Absent fields become `''`. */
export function toRecords(table: CsvTable): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const row of table.rows) {
    const record: Record<string, string> = {};
    for (const [name, index] of table.columns) record[name] = row[index] ?? '';
    out.push(record);
  }
  return out;
}

/**
 * Split parsed rows into a leading metadata block and the data that follows, at the first row
 * `isDataRow` accepts.
 *
 * The H.15 file is the reason this exists: its first six rows are metadata whose first field is a
 * label (`"Unit:"`, `"Time Period"`) and whose remaining fields are per-series, and its data rows
 * begin with an ISO date. `splitHeaderBlock(rows, (r) => /^\d{4}-\d{2}-\d{2}$/.test(r[0] ?? ''))`
 * gives `{ headerRows: 6 rows, dataRows: 5 rows, headerRowIndex: 5 }` — and `headerRowIndex` is
 * the index to hand `parseCsvTable`, because the last metadata row is the column-name row.
 */
export function splitHeaderBlock(
  rows: readonly (readonly string[])[],
  isDataRow: (row: readonly string[], index: number) => boolean,
): {
  headerRows: readonly (readonly string[])[];
  dataRows: readonly (readonly string[])[];
  /** Index of the last metadata row — the one carrying the column names — or `null`. */
  headerRowIndex: number | null;
} {
  let first = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row !== undefined && isDataRow(row, i)) {
      first = i;
      break;
    }
  }
  if (first < 0)
    return {
      headerRows: rows,
      dataRows: [],
      headerRowIndex: rows.length > 0 ? rows.length - 1 : null,
    };
  return {
    headerRows: rows.slice(0, first),
    dataRows: rows.slice(first),
    headerRowIndex: first > 0 ? first - 1 : null,
  };
}

/** `true` for a `YYYY-MM-DD` field — the data-row test for FRED, H.15 and the Stooq shape. */
export function isIsoDateField(value: string | undefined): boolean {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/**
 * Collapse runs of whitespace in a metadata label. The H.15 series description is
 * `"…at 1-month   constant maturity…"` with three spaces, and PROVIDERS §10.3 requires them
 * collapsed before the name reaches `econ_series.name`.
 */
export function collapseSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
