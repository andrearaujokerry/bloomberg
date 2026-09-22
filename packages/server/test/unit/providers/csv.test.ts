/**
 * `providers/csv.ts` against the recorded captures — WP-05, QA-05.
 *
 * `fred-DGS10.csv` (16 879 observations, 720 of them missing), `fed-h15.csv` (the six-line header
 * block) and `finra-trace` (14 columns, one row, a trailing blank line), all reached through the
 * replay store. The Stooq-shaped case has no capture — Stooq is a rejected provider (BRIEF §2) —
 * so it is asserted against a hand-written file of the documented shape.
 */

import { describe, expect, it } from 'vitest';

import { openReplayStore, readManifest } from '../../../src/providers/replayStore.js';
import {
  collapseSpaces,
  detectDelimiter,
  field,
  isIsoDateField,
  numberField,
  parseCsv,
  parseCsvTable,
  splitHeaderBlock,
  stripBom,
  toRecords,
} from '../../../src/providers/csv.js';

const store = openReplayStore();
const manifest = readManifest('../../fixtures/providers');

function captureText(file: string): string {
  const wanted = `raw/${file}`;
  for (const [key, entry] of Object.entries(manifest)) {
    if (!entry.captures.some((c) => c.file === wanted)) continue;
    const record = store.lookup(key);
    if (record !== null) return record.body.toString('utf8');
  }
  throw new Error(`no manifest entry for ${wanted}`);
}

describe('RFC 4180 mechanics', () => {
  it('reads quoted fields containing the delimiter, a newline and a doubled quote', () => {
    const result = parseCsv('a,"b,c","d\ne","f""g"\n1,2,3,4\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([
      ['a', 'b,c', 'd\ne', 'f"g'],
      ['1', '2', '3', '4'],
    ]);
    expect(result.problems).toEqual([]);
  });

  it('accepts CRLF, CR and LF, a BOM and a missing final newline', () => {
    const crlf = parseCsv('﻿a,b\r\n1,2\r\n3,4');
    expect(crlf.ok).toBe(true);
    if (crlf.ok)
      expect(crlf.rows).toEqual([
        ['a', 'b'],
        ['1', '2'],
        ['3', '4'],
      ]);
    const cr = parseCsv('a,b\r1,2');
    if (cr.ok)
      expect(cr.rows).toEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    expect(stripBom('﻿x')).toBe('x');
  });

  it('keeps an empty field empty and never turns it into a zero', () => {
    const result = parseCsv('1962-02-12,\n1962-02-13,4.03\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toEqual(['1962-02-12', '']);
  });

  it('refuses nonsense options instead of guessing', () => {
    expect(parseCsv('a,b', { delimiter: ',,' }).ok).toBe(false);
    expect(parseCsv('a,b', { delimiter: '"', quote: '"' }).ok).toBe(false);
  });
});

describe('fred-DGS10.csv (fred.csv, 262 KB)', () => {
  const text = captureText('fred-DGS10.csv');

  it('reads 16 879 observations under a two-column header', () => {
    const parsed = parseCsvTable(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { table } = parsed;

    expect(table.header).toEqual(['observation_date', 'DGS10']);
    expect(table.rows.length).toBe(16_879);
    expect(table.problems).toEqual([]);
    // The series code is the second header, not a constant the adapter carries (§10.1).
    expect([...table.columns.keys()]).toEqual(['observation_date', 'dgs10']);

    const first = table.rows[0];
    const last = table.rows[table.rows.length - 1];
    expect(first).toEqual(['1962-01-02', '4.06']);
    expect(last).toEqual(['2026-09-11', '4.96']);
    expect(field(table, first ?? [], 'observation_date')).toBe('1962-01-02');
    expect(numberField(table, first ?? [], 'DGS10')).toBe(4.06);
  });

  it('maps the 720 empty observations to null, never to zero', () => {
    const parsed = parseCsvTable(text);
    if (!parsed.ok) throw new Error('parse failed');
    const { table } = parsed;

    const values = table.rows.map((row) => numberField(table, row, 'dgs10'));
    const missing = values.filter((v) => v === null);
    expect(missing.length).toBe(720);
    expect(values.filter((v) => v === 0).length).toBe(0);
    expect(values.every((v) => v === null || Number.isFinite(v))).toBe(true);

    // 1962-02-12 is one of them, and the day after is not.
    const rowFor = (day: string): readonly string[] | undefined =>
      table.rows.find((r) => r[0] === day);
    expect(numberField(table, rowFor('1962-02-12') ?? [], 'dgs10')).toBeNull();
    expect(numberField(table, rowFor('1962-02-13') ?? [], 'dgs10')).toBe(4.03);

    // Every date is ISO and strictly ascending — the ordering an econ_observations write assumes.
    expect(table.rows.every((r) => isIsoDateField(r[0]))).toBe(true);
    const days = table.rows.map((r) => r[0] ?? '');
    expect(days.every((d, i) => i === 0 || d > (days[i - 1] ?? ''))).toBe(true);
  });
});

describe('fed-h15.csv (fed.h15, the six-line header block)', () => {
  const text = captureText('fed-h15.csv');

  it('splits the metadata block from the data at the first ISO-dated row', () => {
    const parsed = parseCsv(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows.length).toBe(11);

    const split = splitHeaderBlock(parsed.rows, (row) => isIsoDateField(row[0]));
    expect(split.headerRows.length).toBe(6);
    expect(split.dataRows.length).toBe(5);
    // The last metadata row carries the column names — index 5, which is what §10.3 documents.
    expect(split.headerRowIndex).toBe(5);
    expect(split.headerRows.map((r) => r[0])).toEqual([
      'Series Description',
      'Unit:',
      'Multiplier:',
      'Currency:',
      'Unique Identifier: ', // the trailing space is real
      'Time Period',
    ]);
  });

  it('binds the eleven CMT series by code and reads the metadata block', () => {
    const parsed = parseCsvTable(text, { headerRow: 5 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { table } = parsed;

    expect(table.header.length).toBe(12);
    expect(table.rows.length).toBe(5);
    expect(table.problems).toEqual([]);
    expect(table.columns.get('riflgfcy10_n.b')).toBe(9);

    // Columns are bound by SERIES CODE, never by position (§10.3).
    const row = table.rows.find((r) => r[0] === '2026-09-11');
    expect(row).toBeDefined();
    expect(numberField(table, row ?? [], 'RIFLGFCY10_N.B')).toBe(4.96);
    expect(numberField(table, row ?? [], 'RIFLGFCM01_N.B')).toBe(3.93);
    expect(numberField(table, row ?? [], 'RIFLGFCY30_N.B')).toBe(5.35);

    // `ND` is a missing observation, not a number. The 2026-09-07 row is all ND — a Sunday.
    const sunday = table.rows.find((r) => r[0] === '2026-09-07');
    expect(sunday).toBeDefined();
    const sundayValues = table.header
      .slice(1)
      .map((code) => numberField(table, sunday ?? [], code));
    expect(sundayValues).toEqual(Array.from({ length: 11 }, () => null));

    // The metadata rows, read with the same parse.
    const all = parseCsv(text);
    if (!all.ok) throw new Error('parse failed');
    const description = all.rows[0]?.[9] ?? '';
    expect(description).toContain('10-year   constant maturity');
    expect(collapseSpaces(description)).toBe(
      'Market yield on U.S. Treasury securities at 10-year constant maturity, quoted on investment basis',
    );
    expect(all.rows[1]?.slice(1).every((u) => u === 'Percent:_Per_Year')).toBe(true);
    expect(all.rows[2]?.slice(1).every((m) => m === '1')).toBe(true);
    expect(all.rows[4]?.[9]).toBe('H15/H15/RIFLGFCY10_N.B');
    expect((all.rows[4]?.[9] ?? '').split('/').pop()).toBe('RIFLGFCY10_N.B');
  });
});

describe('finra-trace (finra.shortInterest, 14 columns and a trailing blank line)', () => {
  const text = captureText('finra-trace');

  it('reads the single row and drops the trailing blank line', () => {
    const parsed = parseCsvTable(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { table } = parsed;

    expect(table.header.length).toBe(14);
    expect(table.rows.length).toBe(1);
    expect(table.problems).toEqual([]);

    const records = toRecords(table);
    expect(records[0]).toMatchObject({
      accountingyearmonthnumber: '20200415',
      symbolcode: 'A',
      issuename: 'Agilent Technologies Inc.',
      marketclasscode: 'NYSE',
      settlementdate: '2020-04-15',
    });
    const row = table.rows[0] ?? [];
    expect(numberField(table, row, 'currentShortPositionQuantity')).toBe(4_851_353);
    expect(numberField(table, row, 'daysToCoverQuantity')).toBe(2.41);
    // Empty columns stay empty: `stockSplitFlag` and `revisionFlag` are blank in this capture.
    expect(field(table, row, 'stockSplitFlag')).toBeNull();
    expect(field(table, row, 'revisionFlag')).toBeNull();
  });
});

describe('Stooq-shaped daily bars (no capture: BRIEF §2 rejects the provider)', () => {
  const comma =
    'Date,Open,High,Low,Close,Volume\r\n2026-09-10,100.25,101.5,99.75,101.0,1234567\r\n2026-09-11,101.0,102.25,100.5,102.0,987654\r\n';
  const semicolon = comma.replace(/,/g, ';');

  it('detects the delimiter and reads the bars either way', () => {
    expect(detectDelimiter(comma)).toBe(',');
    expect(detectDelimiter(semicolon)).toBe(';');

    for (const text of [comma, semicolon]) {
      const parsed = parseCsvTable(text, { delimiter: detectDelimiter(text) });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const { table } = parsed;
      expect(table.rows.length).toBe(2);
      const last = table.rows[1] ?? [];
      expect(field(table, last, 'Date')).toBe('2026-09-11');
      expect(numberField(table, last, 'Open')).toBe(101);
      expect(numberField(table, last, 'High')).toBe(102.25);
      expect(numberField(table, last, 'Low')).toBe(100.5);
      expect(numberField(table, last, 'Close')).toBe(102);
      expect(numberField(table, last, 'Volume')).toBe(987_654);
    }
  });

  it('strips a thousands separator but never guesses a decimal comma', () => {
    const parsed = parseCsvTable('Date,Volume\n2026-09-11,"1,234,567"\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(numberField(parsed.table, parsed.table.rows[0] ?? [], 'Volume')).toBe(1_234_567);
  });
});

describe('robustness — QA-05: never throws on truncated, reordered or corrupted input', () => {
  const files = [captureText('fed-h15.csv'), captureText('finra-trace')];

  it('never throws on 400 truncations of two real files', () => {
    for (const text of files) {
      for (let cut = 0; cut < 200; cut += 1) {
        const result = parseCsv(text.slice(0, Math.floor((text.length * cut) / 200)));
        expect(result.ok).toBe(true);
      }
    }
  });

  it('reports a truncated quoted field rather than losing the row silently', () => {
    const result = parseCsv(
      '"Series Description","Market yield on U.S. Treasury securities at 1-mon',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problems.some((p) => p.kind === 'parse_error')).toBe(true);
    expect(result.rows[0]?.[0]).toBe('Series Description');
  });

  it('flags a row whose width disagrees with the header', () => {
    const parsed = parseCsvTable('a,b,c\n1,2,3\n4,5\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.table.rows.length).toBe(2);
    expect(parsed.table.problems.some((p) => p.kind === 'schema_drift')).toBe(true);
  });

  it('never throws on deterministically scrambled bytes', () => {
    let state = 24_680;
    const next = (): number => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state / 4_294_967_296;
    };
    const base = files[0] ?? '';
    for (let trial = 0; trial < 400; trial += 1) {
      const chars = [...base];
      const edits = 1 + Math.floor(next() * 20);
      for (let e = 0; e < edits; e += 1) {
        const at = Math.floor(next() * chars.length);
        const mode = Math.floor(next() * 3);
        if (mode === 0) chars.splice(at, 1);
        else if (mode === 1) chars.splice(at, 0, '",\r\n\'\\'[Math.floor(next() * 6)] ?? ',');
        else {
          const other = Math.floor(next() * chars.length);
          const a = chars[at];
          const b = chars[other];
          if (a !== undefined && b !== undefined) {
            chars[at] = b;
            chars[other] = a;
          }
        }
      }
      const result = parseCsv(chars.join(''));
      expect(result.ok).toBe(true);
    }
  });

  it('returns a parse-error result when asked for a header row that is not there', () => {
    const parsed = parseCsvTable('a,b\n', { headerRow: 5 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem.kind).toBe('parse_error');
  });

  it('honours the row limit instead of reading an unbounded file', () => {
    const many = Array.from({ length: 100 }, (_, i) => `${String(i)},x`).join('\n');
    const result = parseCsv(many, { maxRows: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.length).toBe(10);
    expect(result.problems.some((p) => p.detail.includes('row limit'))).toBe(true);
  });
});
