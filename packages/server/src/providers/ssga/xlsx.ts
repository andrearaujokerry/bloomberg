/**
 * An `.xlsx` reader with no dependency — PROVIDERS.b §8.1 (L1744-1770), WORKPLAN WP-05.
 *
 * The fourth of the four shared parsers. The SPDR daily holdings file
 * (`ssga-spy-holdings.xlsx`, 53 KB) is the only binary payload in the system, and an `.xlsx` is a
 * ZIP of XML parts — both halves are already in Node 22, so a spreadsheet library would be 2 MB of
 * dependency for 250 lines of work:
 *
 * 1. **ZIP directory.** Scan backwards from the tail for `PK\x05\x06`, read the central-directory
 *    offset and entry count, walk the entries. Scanning (rather than assuming the End of Central
 *    Directory sits at `length - 22`) is what makes an archive with a trailing comment readable.
 * 2. **Inflate.** Method `0` (stored) is a byte slice; method `8` (deflate) is
 *    `zlib.inflateRawSync` — **raw**, because a ZIP member carries no zlib header. Nothing else is
 *    accepted.
 * 3. **Sheet XML.** `providers/xml.ts` walks `<row r="n"><c r="A5" t="s"><v>12</v></c>…`. `t="s"`
 *    resolves through `xl/sharedStrings.xml` (concatenating `<r><t>` runs for rich text),
 *    `t="inlineStr"` reads `<is><t>`, no `t` is a number.
 * 4. **Determinism.** Rows come back in ascending `r` regardless of file order, and **cells are
 *    addressed by their `r` reference, never by counting siblings** — an `.xlsx` omits empty cells,
 *    and counting is exactly how a blank SEDOL shifts Weight into the Sector column.
 *
 * **Purity and the QA-05 contract.** No clock, no IO, no network; `inflateRawSync` is a pure
 * function of its bytes. Nothing here throws: a file that is not a ZIP (the SSGA CDN answers an
 * unfamiliar `User-Agent` with an HTML error page carrying status 200), a truncated archive, a
 * member compressed with an unsupported method and a corrupted deflate stream all return
 * `ok: false` with a `parse_error`.
 *
 * `ingest/jobs/ssgaHoldings.ts` carries a provisional copy of this reader (it landed with WP-04,
 * before this file existed). {@link sheetValues} returns exactly the shape that copy exports, so
 * the job can switch to importing this module and delete its own.
 */

import { inflateRawSync } from 'node:zlib';

import { child, childrenNamed, parseXml, type XmlElement } from '../xml.js';

import type { NormaliseProblem } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Limits
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Largest archive accepted. The real file is 53 KB. */
export const MAX_XLSX_BYTES = 64 * 1024 * 1024;
/** Largest single inflated part accepted — the zip-bomb guard. `sheet1.xml` inflates to 197 KB. */
export const MAX_PART_BYTES = 128 * 1024 * 1024;
/** Most central-directory entries walked. */
export const MAX_ZIP_ENTRIES = 4_096;

/** `PK\x05\x06` — End of Central Directory. */
const EOCD_SIGNATURE = 0x0605_4b50;
/** `PK\x01\x02` — one central-directory entry. */
const CENTRAL_SIGNATURE = 0x0201_4b50;
/** `PK\x03\x04` — one local file header. */
const LOCAL_SIGNATURE = 0x0403_4b50;
/** The EOCD is 22 bytes plus a comment of at most 64 KiB. */
const EOCD_MAX_TAIL = 22 + 0xffff;
/** A 32-bit field at its maximum means "see the ZIP64 record", which this reader does not read. */
const ZIP64_SENTINEL = 0xffff_ffff;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface XlsxFailure {
  readonly ok: false;
  readonly problem: NormaliseProblem;
  readonly problems: readonly NormaliseProblem[];
}

function failure(detail: string): XlsxFailure {
  const problem: NormaliseProblem = { kind: 'parse_error', detail };
  return { ok: false, problem, problems: [problem] };
}

/** How a cell's value was stored, in the spreadsheet's own vocabulary. */
export type XlsxCellType = 'number' | 'shared' | 'inline' | 'formulaString' | 'boolean' | 'error';

export interface XlsxCell {
  /** `'C7'`, exactly as written. */
  readonly ref: string;
  /** 1-based row. */
  readonly row: number;
  /** 1-based column: `A` = 1, `AA` = 27. */
  readonly column: number;
  readonly type: XlsxCellType;
  /**
   * The cell as text: a resolved shared string, or the number's stored literal (`'2.95150616E8'`,
   * never a locale-formatted rendering). Empty when the cell holds no value.
   */
  readonly text: string;
  /** The finite number the cell holds, or `null` — never `NaN`. */
  readonly value: number | null;
}

export interface XlsxRow {
  /** 1-based row number from `r`. */
  readonly row: number;
  /** Cells by 1-based column index. Empty cells are absent, as they are in the file. */
  readonly cells: ReadonlyMap<number, XlsxCell>;
}

export interface XlsxSheet {
  /** The sheet's name from `xl/workbook.xml`, e.g. `'holdings-daily-us-en-spy'`. */
  readonly name: string;
  /** The part that was read, e.g. `'xl/worksheets/sheet1.xml'`. */
  readonly part: string;
  /** Rows in ascending `r`, whatever order the file stored them in. */
  readonly rows: readonly XlsxRow[];
  readonly byRow: ReadonlyMap<number, XlsxRow>;
  readonly maxRow: number;
  readonly maxColumn: number;
}

export interface XlsxOk {
  readonly ok: true;
  readonly sheet: XlsxSheet;
  /** The shared-string table, in index order. */
  readonly sharedStrings: readonly string[];
  readonly problems: readonly NormaliseProblem[];
}

export type XlsxResult = XlsxOk | XlsxFailure;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ZIP
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

export type ZipDirectoryResult =
  | {
      readonly ok: true;
      readonly entries: ReadonlyMap<string, ZipEntry>;
      readonly problems: readonly NormaliseProblem[];
    }
  | XlsxFailure;

/** Walk the central directory. Never throws: every read is bounds-checked first. */
export function readZipDirectory(buffer: Buffer): ZipDirectoryResult {
  if (!Buffer.isBuffer(buffer)) return failure('readZipDirectory: input is not a Buffer');
  if (buffer.length < 22) return failure('readZipDirectory: too short to be a ZIP archive');
  if (buffer.length > MAX_XLSX_BYTES)
    return failure(
      `readZipDirectory: ${String(buffer.length)} bytes, over the ${String(MAX_XLSX_BYTES)} limit`,
    );
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    // The SSGA CDN answers an unfamiliar agent with an HTML error page carrying status 200.
    return failure('readZipDirectory: body does not begin with "PK" — this is not a workbook');
  }

  const from = Math.max(0, buffer.length - EOCD_MAX_TAIL);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= from; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return failure('readZipDirectory: no End of Central Directory record');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === ZIP64_SENTINEL || count === 0xffff)
    return failure('readZipDirectory: ZIP64 archive; this reader handles the 32-bit format only');
  if (count > MAX_ZIP_ENTRIES)
    return failure(
      `readZipDirectory: ${String(count)} entries, over the ${String(MAX_ZIP_ENTRIES)} limit`,
    );

  const problems: NormaliseProblem[] = [];
  const entries = new Map<string, ZipEntry>();

  for (let i = 0; i < count; i += 1) {
    if (offset < 0 || offset + 46 > buffer.length)
      return failure(
        `readZipDirectory: central directory entry ${String(i)} runs past the end of the file`,
      );
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE)
      return failure(`readZipDirectory: central directory entry ${String(i)} has a bad signature`);

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > buffer.length)
      return failure(`readZipDirectory: entry ${String(i)} has a truncated name`);
    const name = buffer.toString('utf8', offset + 46, nameEnd);

    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localHeaderOffset === ZIP64_SENTINEL
    ) {
      problems.push({
        kind: 'parse_error',
        detail: `entry ${name} uses ZIP64 sizes; skipped`,
        path: `/${name}`,
      });
    } else if (!entries.has(name)) {
      entries.set(name, { name, method, compressedSize, uncompressedSize, localHeaderOffset });
    }
    offset = nameEnd + extraLength + commentLength;
  }

  return { ok: true, entries, problems };
}

export type ZipEntryResult = { readonly ok: true; readonly bytes: Buffer } | XlsxFailure;

/**
 * One member's bytes. Method `0` is a slice, method `8` is raw inflate. A corrupted deflate stream
 * is the commonest fuzz mutation, and `inflateRawSync` throws on it — which is why it is wrapped.
 */
export function readZipEntry(buffer: Buffer, entry: ZipEntry): ZipEntryResult {
  const header = entry.localHeaderOffset;
  if (header < 0 || header + 30 > buffer.length)
    return failure(`readZipEntry: local header for ${entry.name} is outside the file`);
  if (buffer.readUInt32LE(header) !== LOCAL_SIGNATURE)
    return failure(`readZipEntry: local header for ${entry.name} has a bad signature`);

  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (start > buffer.length || end > buffer.length)
    return failure(
      `readZipEntry: ${entry.name} is truncated (${String(entry.compressedSize)} compressed bytes do not fit)`,
    );
  if (entry.uncompressedSize > MAX_PART_BYTES)
    return failure(
      `readZipEntry: ${entry.name} inflates to ${String(entry.uncompressedSize)} bytes, over the limit`,
    );

  const body = buffer.subarray(start, end);
  if (entry.method === 0) return { ok: true, bytes: Buffer.from(body) };
  if (entry.method !== 8)
    return failure(
      `readZipEntry: ${entry.name} uses compression method ${String(entry.method)}; only stored (0) and deflate (8) are read`,
    );
  try {
    const bytes = inflateRawSync(body, { maxOutputLength: MAX_PART_BYTES });
    return { ok: true, bytes };
  } catch (err) {
    return failure(
      `readZipEntry: ${entry.name} is not a valid deflate stream (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cell references
// ─────────────────────────────────────────────────────────────────────────────────────────────

const CELL_REF = /^([A-Za-z]{1,3})(\d{1,7})$/;

/** `'C7'` → `{ column: 3, row: 7 }`; `'AA12'` → `{ column: 27, row: 12 }`; anything else `null`. */
export function parseCellRef(ref: string): { column: number; row: number } | null {
  const match = CELL_REF.exec(ref);
  if (match === null) return null;
  const letters = match[1];
  const digits = match[2];
  if (letters === undefined || digits === undefined) return null;
  let column = 0;
  for (let i = 0; i < letters.length; i += 1) {
    column = column * 26 + (letters.toUpperCase().charCodeAt(i) - 64);
  }
  const row = Number.parseInt(digits, 10);
  if (!Number.isInteger(row) || row < 1) return null;
  return { column, row };
}

/** `3` → `'C'`; `27` → `'AA'`. The inverse of {@link parseCellRef}'s column. */
export function columnName(column: number): string {
  if (!Number.isInteger(column) || column < 1) return '';
  let out = '';
  let n = column;
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - rem) / 26);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Parts
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Concatenate every `<t>` under `element`, skipping phonetic runs (`<rPh>`), in document order. */
function textRuns(element: XmlElement): string {
  let out = '';
  const walk = (node: XmlElement): void => {
    if (node.local === 'rPh' || node.local === 'phoneticPr') return;
    if (node.local === 't') out += node.text;
    for (const kid of node.children) walk(kid);
  };
  for (const kid of element.children) walk(kid);
  if (out === '' && element.local === 't') out = element.text;
  return out;
}

/** `<sst><si>…` in index order. Rich text (`<si><r><t>`) is concatenated into one string. */
export function readSharedStrings(xml: string): {
  strings: string[];
  problems: NormaliseProblem[];
} {
  const parsed = parseXml(xml);
  if (!parsed.ok) return { strings: [], problems: [parsed.problem] };
  const strings: string[] = [];
  for (const si of childrenNamed(parsed.root, 'si')) strings.push(textRuns(si));
  return { strings, problems: [...parsed.problems] };
}

function cellOf(
  cellEl: XmlElement,
  sharedStrings: readonly string[],
  fallbackRow: number,
  fallbackColumn: number,
  problems: NormaliseProblem[],
): XlsxCell | null {
  const ref = cellEl.attrs.r ?? '';
  const parsedRef = ref === '' ? null : parseCellRef(ref);
  let row: number;
  let column: number;
  if (parsedRef === null) {
    // A cell may legally omit `r`, in which case it is the next column of the current row. This is
    // the ONLY place position is used, and it is recorded, because §8.1 forbids counting siblings.
    if (problems.length < 64) {
      problems.push({
        kind: 'schema_drift',
        detail:
          ref === ''
            ? 'cell has no r reference; position assumed'
            : `cell reference ${ref} is unreadable`,
        path: `/${String(fallbackRow)}/${String(fallbackColumn)}`,
      });
    }
    row = fallbackRow;
    column = fallbackColumn;
  } else {
    row = parsedRef.row;
    column = parsedRef.column;
  }

  const type = cellEl.attrs.t ?? 'n';
  const literal = child(cellEl, 'v')?.text.trim() ?? '';

  if (type === 'inlineStr') {
    const is = child(cellEl, 'is');
    const text = is === null ? '' : textRuns(is);
    return { ref, row, column, type: 'inline', text, value: null };
  }
  if (type === 's') {
    if (literal === '') return null;
    const index = Number(literal);
    if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) {
      if (problems.length < 64) {
        problems.push({
          kind: 'schema_drift',
          detail: `shared-string index ${literal} is outside the table of ${String(sharedStrings.length)}`,
          path: `/${ref}`,
        });
      }
      return { ref, row, column, type: 'shared', text: '', value: null };
    }
    return { ref, row, column, type: 'shared', text: sharedStrings[index] ?? '', value: null };
  }
  if (type === 'str') {
    return { ref, row, column, type: 'formulaString', text: literal, value: null };
  }
  if (type === 'b') {
    if (literal === '') return null;
    return {
      ref,
      row,
      column,
      type: 'boolean',
      text: literal === '1' ? 'TRUE' : 'FALSE',
      value: literal === '1' ? 1 : 0,
    };
  }
  if (type === 'e') {
    if (literal === '') return null;
    return { ref, row, column, type: 'error', text: literal, value: null };
  }
  if (literal === '') return null;
  const value = Number(literal);
  return {
    ref,
    row,
    column,
    type: 'number',
    text: literal,
    value: Number.isFinite(value) ? value : null,
  };
}

/**
 * Parse one worksheet part. Rows come back ascending by `r`; cells are keyed by their column from
 * the `r` reference.
 */
export function readSheetXml(
  xml: string,
  sharedStrings: readonly string[],
  name = '',
  part = '',
): XlsxResult {
  const parsed = parseXml(xml);
  if (!parsed.ok) return { ok: false, problem: parsed.problem, problems: parsed.problems };

  const problems: NormaliseProblem[] = [...parsed.problems];
  const sheetData = child(parsed.root, 'sheetData');
  if (sheetData === null) return failure('readSheetXml: the worksheet has no <sheetData>');

  const byRow = new Map<number, XlsxRow>();
  let maxRow = 0;
  let maxColumn = 0;

  for (const rowEl of childrenNamed(sheetData, 'row')) {
    const rowRef = rowEl.attrs.r;
    const declared = rowRef === undefined ? Number.NaN : Number.parseInt(rowRef, 10);
    // A row may legally omit `r`; it then follows the highest row seen so far, which cannot
    // collide with a row the file numbered explicitly however the file ordered its rows.
    const rowNumber = Number.isInteger(declared) && declared > 0 ? declared : maxRow + 1;
    if (!Number.isInteger(declared) && problems.length < 64) {
      problems.push({
        kind: 'schema_drift',
        detail: 'row has no r reference; position assumed',
        path: `/${String(rowNumber)}`,
      });
    }

    const cells = new Map<number, XlsxCell>();
    let fallbackColumn = 0;
    for (const cellEl of childrenNamed(rowEl, 'c')) {
      const cell = cellOf(cellEl, sharedStrings, rowNumber, fallbackColumn + 1, problems);
      if (cell === null) {
        fallbackColumn += 1;
        continue;
      }
      fallbackColumn = cell.column;
      if (cell.text === '') continue; // an empty cell carries formatting only
      cells.set(cell.column, cell);
      if (cell.column > maxColumn) maxColumn = cell.column;
    }

    const existing = byRow.get(rowNumber);
    if (existing !== undefined) {
      // A duplicate row number: merge rather than drop, and say so.
      if (problems.length < 64)
        problems.push({
          kind: 'schema_drift',
          detail: `row ${String(rowNumber)} appears more than once`,
          path: `/${String(rowNumber)}`,
        });
      for (const [column, cell] of existing.cells) if (!cells.has(column)) cells.set(column, cell);
    }
    byRow.set(rowNumber, { row: rowNumber, cells });
    if (rowNumber > maxRow) maxRow = rowNumber;
  }

  const rows = [...byRow.values()].sort((a, b) => a.row - b.row);
  return {
    ok: true,
    sheet: { name, part, rows, byRow, maxRow, maxColumn },
    sharedStrings,
    problems,
  };
}

/** Resolve a relationship target against the part that declared it (`xl/workbook.xml`). */
function resolveTarget(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const baseDir = base.slice(0, base.lastIndexOf('/') + 1);
  const parts: string[] = [];
  for (const segment of (baseDir + target).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

interface SheetRef {
  name: string;
  part: string;
}

/** `xl/workbook.xml` + `xl/_rels/workbook.xml.rels` → the sheets, in workbook order. */
function readWorkbookSheets(workbookXml: string, relsXml: string | null): SheetRef[] {
  const workbook = parseXml(workbookXml);
  if (!workbook.ok) return [];

  const targets = new Map<string, string>();
  if (relsXml !== null) {
    const rels = parseXml(relsXml);
    if (rels.ok) {
      for (const rel of childrenNamed(rels.root, 'Relationship')) {
        const id = rel.attrs.Id;
        const target = rel.attrs.Target;
        if (id !== undefined && target !== undefined)
          targets.set(id, resolveTarget('xl/workbook.xml', target));
      }
    }
  }

  const sheetsEl = child(workbook.root, 'sheets');
  if (sheetsEl === null) return [];
  const out: SheetRef[] = [];
  for (const sheet of childrenNamed(sheetsEl, 'sheet')) {
    const name = sheet.attrs.name ?? '';
    const relId = sheet.attrs['r:id'] ?? sheet.attrList.find((a) => a.local === 'id')?.value;
    const part = relId === undefined ? undefined : targets.get(relId);
    out.push({ name, part: part ?? '' });
  }
  return out;
}

export interface ReadXlsxOptions {
  /** 0-based sheet index in workbook order. Default `0` — sheet 1, which is all §8.1 needs. */
  sheetIndex?: number;
}

/**
 * Read one sheet of an `.xlsx`.
 *
 * The sheet part is resolved through `xl/workbook.xml` and its relationships, falling back to
 * `xl/worksheets/sheet{n}.xml` when a workbook omits them — the name in the file is not assumed.
 */
export function readXlsx(buffer: Buffer, options: ReadXlsxOptions = {}): XlsxResult {
  const directory = readZipDirectory(buffer);
  if (!directory.ok) return directory;

  const problems: NormaliseProblem[] = [...directory.problems];
  const index = options.sheetIndex ?? 0;
  if (!Number.isInteger(index) || index < 0)
    return failure(`readXlsx: sheetIndex ${String(index)} is not a non-negative integer`);

  const part = (name: string): string | null => {
    const entry = directory.entries.get(name);
    if (entry === undefined) return null;
    const bytes = readZipEntry(buffer, entry);
    if (!bytes.ok) {
      problems.push(bytes.problem);
      return null;
    }
    return bytes.bytes.toString('utf8');
  };

  const workbookXml = part('xl/workbook.xml');
  const sheets =
    workbookXml === null ? [] : readWorkbookSheets(workbookXml, part('xl/_rels/workbook.xml.rels'));
  const chosen = sheets[index];
  const sheetPart =
    chosen !== undefined && chosen.part !== '' && directory.entries.has(chosen.part)
      ? chosen.part
      : `xl/worksheets/sheet${String(index + 1)}.xml`;

  const sheetXml = part(sheetPart);
  if (sheetXml === null) return failure(`readXlsx: no readable ${sheetPart} in the workbook`);

  const sharedXml = part('xl/sharedStrings.xml');
  let sharedStrings: readonly string[] = [];
  if (sharedXml !== null) {
    const shared = readSharedStrings(sharedXml);
    sharedStrings = shared.strings;
    problems.push(...shared.problems);
  }

  const sheet = readSheetXml(sheetXml, sharedStrings, chosen?.name ?? '', sheetPart);
  if (!sheet.ok)
    return { ok: false, problem: sheet.problem, problems: [...problems, ...sheet.problems] };
  return {
    ok: true,
    sheet: sheet.sheet,
    sharedStrings,
    problems: [...problems, ...sheet.problems],
  };
}

/** {@link readXlsx} of sheet 1 — what `providers/ssga/parse.ts` calls (§8.1). */
export function readXlsxSheet1(buffer: Buffer): XlsxResult {
  return readXlsx(buffer, { sheetIndex: 0 });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reading a sheet
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The cell at 1-based `row`/`column`, or `null`. */
export function cellAt(sheet: XlsxSheet, row: number, column: number): XlsxCell | null {
  return sheet.byRow.get(row)?.cells.get(column) ?? null;
}

/** The text at 1-based `row`/`column`, trimmed; `''` when the cell is empty or absent. */
export function textAt(sheet: XlsxSheet, row: number, column: number): string {
  return cellAt(sheet, row, column)?.text.trim() ?? '';
}

/** The number at 1-based `row`/`column`, or `null` — never `NaN`. */
export function numberAt(sheet: XlsxSheet, row: number, column: number): number | null {
  const cell = cellAt(sheet, row, column);
  if (cell === null) return null;
  if (cell.value !== null) return cell.value;
  const parsed = Number(cell.text.trim());
  return cell.text.trim() !== '' && Number.isFinite(parsed) ? parsed : null;
}

/** One row's text by column, ascending. Absent columns are simply absent. */
export function rowText(sheet: XlsxSheet, row: number): Map<number, string> {
  const out = new Map<number, string>();
  const found = sheet.byRow.get(row);
  if (found === undefined) return out;
  for (const column of [...found.cells.keys()].sort((a, b) => a - b)) {
    out.set(column, found.cells.get(column)?.text ?? '');
  }
  return out;
}

/**
 * The whole sheet as `row → (column → text)`, ascending by row — the shape
 * `ingest/jobs/ssgaHoldings.ts` reads today, so switching it to this module is an import change
 * and a deletion, not a rewrite.
 */
export function sheetValues(sheet: XlsxSheet): Map<number, ReadonlyMap<number, string>> {
  const out = new Map<number, ReadonlyMap<number, string>>();
  for (const row of sheet.rows) {
    const cells = new Map<number, string>();
    for (const [column, cell] of row.cells) cells.set(column, cell.text);
    out.set(row.row, cells);
  }
  return out;
}

/**
 * `header text (trimmed, lower-cased) → column index` for the row whose first non-empty cell is
 * `firstHeader`. Columns are found **by header text, never by position**, so SSGA adding a column
 * cannot silently re-map Weight (§8.1).
 *
 * @returns `null` when no row starts with `firstHeader`.
 */
export function headerIndex(
  sheet: XlsxSheet,
  firstHeader: string,
  searchLimit = 64,
): { row: number; columns: Map<string, number> } | null {
  const wanted = firstHeader.trim().toLowerCase();
  for (const row of sheet.rows) {
    if (row.row > searchLimit) break;
    const columns = [...row.cells.keys()].sort((a, b) => a - b);
    const first = columns[0];
    if (first === undefined) continue;
    if ((row.cells.get(first)?.text ?? '').trim().toLowerCase() !== wanted) continue;
    const map = new Map<string, number>();
    for (const column of columns) {
      const key = (row.cells.get(column)?.text ?? '').trim().toLowerCase();
      if (key !== '' && !map.has(key)) map.set(key, column);
    }
    return { row: row.row, columns: map };
  }
  return null;
}
