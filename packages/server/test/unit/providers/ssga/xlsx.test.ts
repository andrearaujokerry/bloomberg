/**
 * `providers/ssga/xlsx.ts` against the recorded workbook — WP-05, QA-05, PROVIDERS §8.1.
 *
 * `ssga-spy-holdings.xlsx` (53 KB) reached through the replay store: a ZIP of fourteen members, a
 * 2 040-entry shared-string table and one sheet whose 505 holdings sit under a four-row metadata
 * block. Pure: `node:zlib` inflate and string work, no IO of any kind.
 */

import { describe, expect, it } from 'vitest';

import { openReplayStore, readManifest } from '../../../../src/providers/replayStore.js';
import {
  cellAt,
  columnName,
  headerIndex,
  numberAt,
  parseCellRef,
  readSharedStrings,
  readSheetXml,
  readXlsx,
  readXlsxSheet1,
  readZipDirectory,
  readZipEntry,
  sheetValues,
  textAt,
  type XlsxSheet,
} from '../../../../src/providers/ssga/xlsx.js';

const store = openReplayStore();
const manifest = readManifest('../../fixtures/providers');

function captureBytes(file: string): Buffer {
  const wanted = `raw/${file}`;
  for (const [key, entry] of Object.entries(manifest)) {
    if (!entry.captures.some((c) => c.file === wanted)) continue;
    const record = store.lookup(key);
    if (record !== null) return record.body;
  }
  throw new Error(`no manifest entry for ${wanted}`);
}

const workbook = captureBytes('ssga-spy-holdings.xlsx');

describe('cell references', () => {
  it('maps a reference to a 1-based row and column, and back', () => {
    expect(parseCellRef('A1')).toEqual({ column: 1, row: 1 });
    expect(parseCellRef('C7')).toEqual({ column: 3, row: 7 });
    expect(parseCellRef('AA12')).toEqual({ column: 27, row: 12 });
    expect(parseCellRef('ZZ1')).toEqual({ column: 702, row: 1 });
    expect(parseCellRef('$A$1')).toBeNull();
    expect(parseCellRef('')).toBeNull();
    expect(parseCellRef('1A')).toBeNull();
    expect(columnName(1)).toBe('A');
    expect(columnName(3)).toBe('C');
    expect(columnName(27)).toBe('AA');
    expect(columnName(702)).toBe('ZZ');
    expect(columnName(0)).toBe('');
  });
});

describe('the ZIP container', () => {
  it('walks the central directory of the recorded workbook', () => {
    const directory = readZipDirectory(workbook);
    expect(directory.ok).toBe(true);
    if (!directory.ok) return;

    expect(directory.entries.size).toBe(14);
    expect([...directory.entries.keys()]).toContain('xl/worksheets/sheet1.xml');
    expect([...directory.entries.keys()]).toContain('xl/sharedStrings.xml');
    expect([...directory.entries.keys()]).toContain('xl/workbook.xml');

    const sheet = directory.entries.get('xl/worksheets/sheet1.xml');
    expect(sheet?.method).toBe(8); // deflate
    expect(sheet?.compressedSize).toBe(27_399);
    expect(sheet?.uncompressedSize).toBe(201_913);

    const bytes = sheet === undefined ? null : readZipEntry(workbook, sheet);
    expect(bytes?.ok).toBe(true);
    if (bytes?.ok === true) {
      expect(bytes.bytes.length).toBe(201_913);
      expect(bytes.bytes.toString('utf8', 0, 5)).toBe('<?xml');
    }
  });

  it('refuses a body that is not a ZIP, with the reason the CDN gives it', () => {
    const html = Buffer.from('<!DOCTYPE html><html><body>Access denied</body></html>', 'utf8');
    const result = readXlsxSheet1(html);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.kind).toBe('parse_error');
      expect(result.problem.detail).toContain('does not begin with "PK"');
    }
  });
});

describe('the shared-string table', () => {
  it('reads 2 040 entries and concatenates rich-text runs', () => {
    const result = readXlsx(workbook);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sharedStrings.length).toBe(2_040);
    expect(result.sharedStrings[0]).toBe('Fund Name:');
    expect(result.sharedStrings[1]).toBe('Ticker Symbol:');
    // A rich-text entry: several <r><t> runs concatenated into one string.
    const rich = result.sharedStrings[3] ?? '';
    expect(rich).toContain('DoubleLine');
    expect(rich).toContain('Investing involves risk');
  });

  it('reads inline and rich text from a hand-written part', () => {
    const shared = readSharedStrings(
      '<sst><si><t>plain</t></si><si><r><t xml:space="preserve">a </t></r><r><t>b</t></r></si></sst>',
    );
    expect(shared.strings).toEqual(['plain', 'a b']);
    expect(shared.problems).toEqual([]);
  });
});

describe('ssga-spy-holdings.xlsx sheet 1', () => {
  const result = readXlsxSheet1(workbook);
  const sheet: XlsxSheet = result.ok ? result.sheet : ({} as XlsxSheet);

  it('reads the sheet named in the workbook, with rows ascending by r', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problems).toEqual([]);
    expect(sheet.part).toBe('xl/worksheets/sheet1.xml');
    expect(sheet.name.length).toBeGreaterThan(0);
    expect(sheet.maxRow).toBe(608);

    const numbers = sheet.rows.map((r) => r.row);
    expect(numbers.every((r, i) => i === 0 || r > (numbers[i - 1] ?? 0))).toBe(true);
    // Row 4 is absent from the file entirely — an .xlsx omits empty rows, and the reader must not
    // invent one to keep its indices tidy.
    expect(sheet.byRow.has(3)).toBe(true);
    expect(sheet.byRow.has(4)).toBe(false);
    expect(sheet.byRow.has(5)).toBe(true);
  });

  it('reads the metadata block by cell reference', () => {
    if (!result.ok) throw new Error('read failed');
    expect(textAt(sheet, 1, 1)).toBe('Fund Name:');
    expect(textAt(sheet, 1, 2)).toContain('SPDR');
    expect(textAt(sheet, 1, 2)).toContain('S&P 500'); // the entity really is decoded
    expect(textAt(sheet, 2, 1)).toBe('Ticker Symbol:');
    expect(textAt(sheet, 2, 2)).toBe('SPY');
    // NOTE: PROVIDERS §8.1 writes the as-of key as `Holdings as of`; the recorded file spells it
    // `Holdings:` with the date in the value. The date is read from the value either way.
    expect(textAt(sheet, 3, 1)).toBe('Holdings:');
    expect(textAt(sheet, 3, 2)).toBe('As of 14-Sep-2026');
  });

  it('binds the eight columns by header text at row 5', () => {
    if (!result.ok) throw new Error('read failed');
    const header = headerIndex(sheet, 'Name');
    expect(header).not.toBeNull();
    if (header === null) return;
    expect(header.row).toBe(5);
    expect([...header.columns.entries()]).toEqual([
      ['name', 1],
      ['ticker', 2],
      ['identifier', 3],
      ['sedol', 4],
      ['weight', 5],
      ['sector', 6],
      ['shares held', 7],
      ['local currency', 8],
    ]);
  });

  it('reads 505 holdings, ending where the disclaimer block begins', () => {
    if (!result.ok) throw new Error('read failed');
    const header = headerIndex(sheet, 'Name');
    if (header === null) throw new Error('no header row');
    const column = (name: string): number => header.columns.get(name) ?? 0;

    const holdings: {
      name: string;
      ticker: string;
      cusip: string;
      weight: number | null;
      shares: number | null;
    }[] = [];
    for (let row = header.row + 1; row <= sheet.maxRow; row += 1) {
      const name = textAt(sheet, row, column('name'));
      const ticker = textAt(sheet, row, column('ticker'));
      // "a row with an empty Name ends the table: the file ends with a disclaimer block" (§8.1).
      // The disclaimer's first line sits in column A with every other column empty, so the end of
      // the table is the first row with no ticker.
      if (name === '' || ticker === '') break;
      holdings.push({
        name,
        ticker,
        cusip: textAt(sheet, row, column('identifier')),
        weight: numberAt(sheet, row, column('weight')),
        shares: numberAt(sheet, row, column('shares held')),
      });
    }

    expect(holdings.length).toBe(505);
    expect(holdings[0]).toEqual({
      name: 'NVIDIA CORP',
      ticker: 'NVDA',
      cusip: '67066G104',
      weight: 7.777528,
      shares: 295_150_616,
    });
    expect(holdings[1]?.name).toBe('APPLE INC');
    expect(holdings[1]?.cusip).toBe('037833100');
    expect(holdings[504]?.name).toBe('CONTRA HOLOGIC INCORPO');

    // Weights are percents that sum to ~100, and every shares count is a positive number — the
    // "2.95150616E8" scientific literal included, read without a locale.
    const total = holdings.reduce((sum, h) => sum + (h.weight ?? 0), 0);
    expect(total).toBeGreaterThan(99);
    expect(total).toBeLessThan(101);
    expect(holdings.every((h) => (h.shares ?? 0) > 0)).toBe(true);
    expect(holdings.filter((h) => h.cusip.length === 9).length).toBe(505);

    // A class share arrives exactly as SSGA writes it (`BF.B`), for the resolver to normalise.
    expect(holdings.some((h) => h.ticker === 'BF.B')).toBe(true);
  });

  it('never shifts a column when a cell is empty', () => {
    if (!result.ok) throw new Error('read failed');
    // Row 510 has `-` in SEDOL and Sector; the weight is a tiny scientific literal. Reading by
    // reference keeps Weight in column 5 — counting siblings is what would move it into Sector.
    expect(textAt(sheet, 510, 1)).toBe('CONTRA HOLOGIC INCORPO');
    expect(textAt(sheet, 510, 4)).toBe('-');
    expect(numberAt(sheet, 510, 5)).toBe(3e-6);
    expect(textAt(sheet, 510, 6)).toBe('-');
    expect(numberAt(sheet, 510, 7)).toBe(2_578_626);
    expect(textAt(sheet, 510, 8)).toBe('USD');

    // The table ends at 510. Row 511 is `<row r="511"/>` — present in the file and completely
    // empty — and the disclaimer block starts at 513, in column A only.
    expect(sheet.byRow.get(511)?.cells.size).toBe(0);
    expect(cellAt(sheet, 511, 1)).toBeNull();
    expect(textAt(sheet, 513, 1)).toContain('State Street Global Advisors');
    expect(cellAt(sheet, 513, 2)).toBeNull();
  });

  it('exposes the row to column to text view the ingest job reads today', () => {
    if (!result.ok) throw new Error('read failed');
    const values = sheetValues(sheet);
    expect(values.get(5)?.get(1)).toBe('Name');
    expect(values.get(6)?.get(2)).toBe('NVDA');
    expect(values.get(4)).toBeUndefined();
    expect([...values.keys()].every((r, i, all) => i === 0 || r > (all[i - 1] ?? 0))).toBe(true);
  });
});

describe('robustness — QA-05: never throws on truncated, reordered or corrupted input', () => {
  it('never throws on 200 truncations of the real workbook', () => {
    for (let cut = 0; cut <= 200; cut += 1) {
      const result = readXlsxSheet1(
        workbook.subarray(0, Math.floor((workbook.length * cut) / 200)),
      );
      expect(typeof result.ok).toBe('boolean');
      if (!result.ok) expect(result.problem.kind).toBe('parse_error');
    }
  });

  it('never throws on corrupted bytes — a broken deflate stream is a parse error', () => {
    let state = 1_357;
    const next = (): number => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state / 4_294_967_296;
    };
    for (let trial = 0; trial < 200; trial += 1) {
      const bytes = Buffer.from(workbook);
      const edits = 1 + Math.floor(next() * 40);
      for (let e = 0; e < edits; e += 1) {
        bytes[Math.floor(next() * bytes.length)] = Math.floor(next() * 256);
      }
      const result = readXlsxSheet1(bytes);
      expect(typeof result.ok).toBe('boolean');
      if (!result.ok) expect(result.problem.kind).toBe('parse_error');
    }
  });

  it('returns a parse-error result for an empty, tiny or absurd input', () => {
    const tiny = [Buffer.alloc(0), Buffer.from('PK'), Buffer.from([0x50, 0x4b, 0x05, 0x06])];
    for (const input of tiny) {
      const result = readXlsxSheet1(input);
      expect(result.ok).toBe(false);
    }
    expect(readXlsx(workbook, { sheetIndex: -1 }).ok).toBe(false);
    expect(readXlsx(workbook, { sheetIndex: 7 }).ok).toBe(false);
  });

  it('reads a hand-written sheet, including inline strings and a missing r reference', () => {
    const xml =
      '<worksheet><sheetData>' +
      '<row r="2"><c r="B2" t="inlineStr"><is><t>inline</t></is></c></row>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>2.5E2</v></c><c r="D1" t="b"><v>1</v></c></row>' +
      '<row><c><v>7</v></c></row>' +
      '</sheetData></worksheet>';
    const result = readSheetXml(xml, ['shared']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { sheet } = result;

    // Rows come back ascending, whatever order the file stored them in.
    expect(sheet.rows.map((r) => r.row)).toEqual([1, 2, 3]);
    expect(textAt(sheet, 1, 1)).toBe('shared');
    expect(numberAt(sheet, 1, 3)).toBe(250);
    expect(textAt(sheet, 1, 4)).toBe('TRUE');
    expect(textAt(sheet, 2, 2)).toBe('inline');
    // A cell with no `r` is the one place position is used, and it is reported.
    expect(numberAt(sheet, 3, 1)).toBe(7);
    expect(result.problems.some((p) => p.kind === 'schema_drift')).toBe(true);
  });

  it('reports a shared-string index outside the table instead of inventing a value', () => {
    const result = readSheetXml(
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>99</v></c></row></sheetData></worksheet>',
      ['only'],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(textAt(result.sheet, 1, 1)).toBe('');
    expect(result.problems.some((p) => p.detail.includes('outside the table'))).toBe(true);
  });

  it('returns a parse-error result for a worksheet part with no sheetData', () => {
    expect(readSheetXml('<worksheet/>', []).ok).toBe(false);
    expect(readSheetXml('not xml at all', []).ok).toBe(false);
  });
});
