// packages/core/test/functions/csv.test.ts — WP-01 acceptance test (WORKPLAN §1.11).
//
// Proves the three things FUNCTIONS.md §1.6 (L480-506) and API.md §9 fix about every export the
// terminal produces:
//
//   * RFC 4180 quoting — a field containing `,`, `"`, CR or LF is quoted and every `"` inside is
//     doubled, so the file survives a round trip through any conforming reader;
//   * the `#` attribution header — the five mandatory comment lines in the order rule 5 fixes,
//     with `# source:` never absent (DATA-01: the licence footer is not optional);
//   * CRLF line endings — every record, including the last, ends `\r\n`, and no bare LF appears.
//
// `toCsv` is the only serialiser in the system (rule 1), so these assertions are the contract the
// server export route, the golden-payload tests and the web client all inherit.

import { describe, expect, it } from 'vitest';

import {
  CSV_LINE_ENDING,
  escapeCsvField,
  numberToCsv,
  serialiseCell,
  standardHeaderLines,
  toCsv,
  writeCsv,
} from '../../src/functions/csv.js';
import type { CsvHeaderInput } from '../../src/functions/csv.js';
import type {
  AnyFunctionManifest,
  CsvColumn,
  CsvDocument,
  CsvSpec,
} from '../../src/functions/manifest.js';

// ---------------------------------------------------------------------------------------------
// A minimal RFC 4180 reader, so "quoted correctly" is proved by reading the bytes back rather
// than by matching a string the same code produced.
// ---------------------------------------------------------------------------------------------

/** Parses RFC 4180 text into records. Comment (`#`) lines are returned separately. */
function readRfc4180(text: string): { comments: string[]; records: string[][] } {
  const comments: string[] = [];
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let atFieldStart = true;
  let atRecordStart = true;
  let inComment = false;

  const endField = (): void => {
    record.push(field);
    field = '';
    atFieldStart = true;
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
    atRecordStart = true;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inComment) {
      if (ch === '\r' && text[i + 1] === '\n') {
        comments.push(field);
        field = '';
        inComment = false;
        atRecordStart = true;
        atFieldStart = true;
        i++;
      } else {
        field += ch;
      }
      continue;
    }

    if (atRecordStart && atFieldStart && !quoted && ch === '#') {
      inComment = true;
      field = ch;
      atRecordStart = false;
      continue;
    }
    atRecordStart = false;

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (atFieldStart && ch === '"') {
      quoted = true;
      atFieldStart = false;
      continue;
    }
    atFieldStart = false;

    if (ch === ',') {
      endField();
    } else if (ch === '\r' && text[i + 1] === '\n') {
      endRecord();
      i++;
    } else {
      field += ch;
    }
  }

  // A conforming file ends with CRLF, so nothing may be left over.
  if (field !== '' || record.length > 0) {
    records.push([...record, field]);
  }
  return { comments, records };
}

// ---------------------------------------------------------------------------------------------
// A stand-in manifest. `toCsv` reads exactly two things off it: `code` (for the error message)
// and `csv` (the spec). Building a whole `FunctionManifest` here would test the fixture, not the
// serialiser.
// ---------------------------------------------------------------------------------------------

interface TestParams {
  readonly range: string;
}
interface TestPayload {
  readonly variant: string;
  readonly rows: readonly (readonly (string | number | boolean | null)[])[];
}

const COLUMNS: CsvColumn[] = [
  { id: 'date', label: 'Date', type: 'date' },
  { id: 'note', label: 'Note', type: 'string' },
  { id: 'PX_LAST', label: 'Last price', type: 'number', decimals: 2 },
];

function manifestWith(spec: Partial<CsvSpec<TestParams, TestPayload>> = {}): AnyFunctionManifest {
  const csv: CsvSpec<TestParams, TestPayload> = {
    filename: (params, ctx) =>
      `HP_${(ctx.display ?? 'NONE').replace(/[^A-Za-z0-9]+/g, '_')}_${params.range}.csv`,
    columns: COLUMNS,
    rows: (payload) => payload.rows.map((row) => [...row]),
    ...spec,
  };
  return { code: 'HP', csv } as unknown as AnyFunctionManifest;
}

const CTX = {
  display: 'AAPL US Equity',
  asOf: '2026-09-15T18:41:30.002Z',
  attribution: ['Yahoo Finance chart v8 (unofficial; 15-min delayed)', 'Cboe One delayed'],
};

const HEADER: CsvHeaderInput = {
  code: 'HP',
  alias: null,
  display: 'AAPL US Equity',
  params: { range: '1M', periodicity: 'D', adjust: 'price' },
  validAt: '2026-09-15T18:41:30.002Z',
  knownAt: '2026-09-15T00:00:00Z',
  tier: 'delayed',
  staleness: 'closed',
  attribution: CTX.attribution,
  provenance: [91177, 88213],
  engines: ['adjust/1.0.0'],
  traceId: '5c0e9d2b-6d6f-4f4a-9a1a-0b5a6c7d8e9f',
  regenerated: false,
};

// ---------------------------------------------------------------------------------------------
// 1. RFC 4180 quoting
// ---------------------------------------------------------------------------------------------

describe('escapeCsvField — RFC 4180 quoting', () => {
  it.each([
    ['leaves a plain field bare', 'PX_LAST', 'PX_LAST'],
    ['leaves an empty field bare', '', ''],
    ['quotes a field containing a comma', 'Apple, Inc.', '"Apple, Inc."'],
    ['quotes and doubles an embedded quote', 'the "good" one', '"the ""good"" one"'],
    ['quotes a field that is only a quote', '"', '""""'],
    ['doubles consecutive quotes', 'a""b', '"a""""b"'],
    ['quotes a field containing LF', 'line1\nline2', '"line1\nline2"'],
    ['quotes a field containing CR', 'line1\rline2', '"line1\rline2"'],
    ['quotes a field containing CRLF', 'line1\r\nline2', '"line1\r\nline2"'],
    ['quotes leading whitespace', ' lead', '" lead"'],
    ['quotes trailing whitespace', 'trail ', '"trail "'],
    ['does not quote interior whitespace', 'AAPL US Equity', 'AAPL US Equity'],
  ])('%s', (_name, input, expected) => {
    expect(escapeCsvField(input)).toBe(expected);
  });

  it('quotes every field that RFC 4180 §2.6/§2.7 requires quoting and no others', () => {
    for (const ch of [',', '"', '\r', '\n']) {
      expect(escapeCsvField(`a${ch}b`).startsWith('"')).toBe(true);
    }
    for (const ch of [';', '|', '\t', ':', '.', '-']) {
      expect(escapeCsvField(`a${ch}b`)).toBe(`a${ch}b`);
    }
  });
});

describe('writeCsv — quoting survives a round trip', () => {
  const nasty: readonly (readonly (string | number | boolean | null)[])[] = [
    ['2026-09-15', 'plain', 1],
    ['2026-09-15', 'has, comma', 2],
    ['2026-09-15', 'has "quotes"', 3],
    ['2026-09-15', 'has\r\nCRLF', 4],
    ['2026-09-15', 'has\nLF only', 5],
    ['2026-09-15', 'has\rCR only', 6],
    ['2026-09-15', ' padded ', 7],
    ['2026-09-15', '', null],
    ['2026-09-15', '"leading quote', 8],
    ['2026-09-15', 'comma,and "quote"', 9],
  ];

  it('reads back byte-for-byte through a conforming reader', () => {
    const doc = toCsv<TestParams, TestPayload>(
      manifestWith({ columns: [...COLUMNS] }),
      { variant: 'equity', rows: nasty },
      { range: '1M' },
      CTX,
    );
    // The date column is already a string here, so no epoch conversion is in play.
    const text = writeCsv(doc, standardHeaderLines(HEADER));
    const { records } = readRfc4180(text);

    expect(records[0]).toEqual(['date', 'note', 'PX_LAST']);
    expect(records.slice(1)).toEqual(
      nasty.map((row) => row.map((cell) => (cell === null ? '' : String(cell)))),
    );
  });

  it('never emits a bare LF or a bare CR outside a quoted field', () => {
    const doc = toCsv<TestParams, TestPayload>(
      manifestWith(),
      { variant: 'equity', rows: nasty },
      { range: '1M' },
      CTX,
    );
    const text = writeCsv(doc, standardHeaderLines(HEADER));
    // Strip quoted fields, then no lone CR/LF may remain.
    const unquoted = text.replace(/"(?:[^"]|"")*"/g, '§');
    expect(/(?<!\r)\n/.test(unquoted)).toBe(false);
    expect(/\r(?!\n)/.test(unquoted)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. CRLF line endings (API.md §9, FUNCTIONS.md §1.6)
// ---------------------------------------------------------------------------------------------

describe('writeCsv — CRLF line endings', () => {
  const doc = (): CsvDocument =>
    toCsv<TestParams, TestPayload>(
      manifestWith(),
      {
        variant: 'equity',
        rows: [
          ['2026-09-14', 'a', 330.27],
          ['2026-09-15', 'b', 330.31],
        ],
      },
      { range: '1M' },
      CTX,
    );

  it('exports CSV_LINE_ENDING as CRLF', () => {
    expect(CSV_LINE_ENDING).toBe('\r\n');
  });

  it('terminates every record, including the last', () => {
    const text = writeCsv(doc(), standardHeaderLines(HEADER));
    expect(text.endsWith('\r\n')).toBe(true);
    const lines = text.split('\r\n');
    // 5 header comments + 1 column row + 2 data rows, then the trailing empty string.
    expect(lines.at(-1)).toBe('');
    expect(lines).toHaveLength(5 + 1 + 2 + 1);
  });

  it('emits no BOM (the file is UTF-8 with no byte-order mark)', () => {
    expect(writeCsv(doc(), standardHeaderLines(HEADER)).charCodeAt(0)).not.toBe(0xfeff);
  });

  it('folds a comment line that contains a line break, so a comment can never split the file', () => {
    const text = writeCsv(doc(), ['# one\ntwo', 'no marker\r\nhere']);
    const [first, second] = text.split('\r\n');
    expect(first).toBe('# one two');
    expect(second).toBe('# no marker here');
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The `#` attribution header (FUNCTIONS.md §1.6 rule 5)
// ---------------------------------------------------------------------------------------------

describe('standardHeaderLines — the # header block', () => {
  it('emits the five mandatory lines in the fixed order', () => {
    const lines = standardHeaderLines(HEADER);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('# terminal-export v1');
    expect(lines[1]).toBe(
      '# function: HP  security: AAPL US Equity  ' +
        'params: {"adjust":"price","periodicity":"D","range":"1M"}',
    );
    expect(lines[2]).toBe(
      '# asOf: validAt=2026-09-15T18:41:30.002Z knownAt=2026-09-15T00:00:00Z  ' +
        'tier: delayed  staleness: closed',
    );
    expect(lines[3]).toBe(
      '# source: Yahoo Finance chart v8 (unofficial; 15-min delayed); Cboe One delayed',
    );
    expect(lines[4]).toBe(
      '# provenance: 91177,88213  engines: adjust/1.0.0  ' +
        'trace: 5c0e9d2b-6d6f-4f4a-9a1a-0b5a6c7d8e9f  regenerated: false',
    );
    for (const line of lines) expect(line.startsWith('# ')).toBe(true);
  });

  it('renders params with canonicalJson, so the same params give the same bytes', () => {
    const a = standardHeaderLines({ ...HEADER, params: { b: 2, a: 1 } })[1];
    const b = standardHeaderLines({ ...HEADER, params: { a: 1, b: 2 } })[1];
    expect(a).toBe(b);
    expect(a).toContain('params: {"a":1,"b":2}');
  });

  it('shows the alias only when the launch code differs from the canonical code', () => {
    expect(standardHeaderLines({ ...HEADER, alias: 'IB' })[1]).toContain(
      '# function: HP [alias: IB]',
    );
    expect(standardHeaderLines({ ...HEADER, alias: 'HP' })[1]).toContain(
      '# function: HP  security:',
    );
    expect(standardHeaderLines({ ...HEADER, alias: null })[1]).toContain(
      '# function: HP  security:',
    );
  });

  it("writes '-' for a function that takes no security", () => {
    expect(standardHeaderLines({ ...HEADER, display: null })[1]).toContain('security: -');
  });

  it('appends the optional entitlement and unavailable lines only when non-empty', () => {
    expect(standardHeaderLines({ ...HEADER, entitlement: [], unavailable: [] })).toHaveLength(5);

    const lines = standardHeaderLines({
      ...HEADER,
      entitlement: [
        { fieldId: 'PX_LAST', reason: 'TIER_EOD' },
        { fieldId: 'PX_BID', reason: 'TIER_EOD' },
      ],
      unavailable: [{ field: 'EE_EPS', reason: 'NO_SOURCE' }],
    });
    expect(lines).toHaveLength(7);
    expect(lines[5]).toBe('# entitlement: PX_LAST=TIER_EOD,PX_BID=TIER_EOD');
    expect(lines[6]).toBe('# unavailable: EE_EPS=NO_SOURCE');
  });
});

describe('writeCsv — the attribution line is not optional (DATA-01)', () => {
  const doc = (): CsvDocument =>
    toCsv<TestParams, TestPayload>(
      manifestWith(),
      { variant: 'equity', rows: [['2026-09-15', 'a', 1]] },
      { range: '1M' },
      CTX,
    );

  it('derives "# source:" from the document when the caller supplied none', () => {
    const text = writeCsv(doc(), ['# terminal-export v1']);
    const { comments } = readRfc4180(text);
    expect(comments).toEqual([
      '# terminal-export v1',
      '# source: Yahoo Finance chart v8 (unofficial; 15-min delayed); Cboe One delayed',
    ]);
  });

  it('does not duplicate "# source:" when the header block already carries one', () => {
    const text = writeCsv(doc(), standardHeaderLines(HEADER));
    const { comments } = readRfc4180(text);
    expect(comments.filter((c) => c.startsWith('# source:'))).toHaveLength(1);
  });

  it('puts every comment line before the column header row', () => {
    const text = writeCsv(doc(), standardHeaderLines(HEADER));
    const lines = text.split('\r\n');
    const firstData = lines.findIndex((l) => !l.startsWith('#'));
    expect(firstData).toBe(5);
    expect(lines[firstData]).toBe('date,note,PX_LAST');
    expect(lines.slice(0, firstData).every((l) => l.startsWith('#'))).toBe(true);
  });

  it('quotes a column id that needs quoting', () => {
    const doc2 = toCsv<TestParams, TestPayload>(
      manifestWith({
        columns: [
          { id: 'a,b', label: 'A', type: 'string' },
          { id: 'c"d', label: 'C', type: 'string' },
        ],
      }),
      { variant: 'equity', rows: [['x', 'y']] },
      { range: '1M' },
      CTX,
    );
    const lines = writeCsv(doc2, []).split('\r\n');
    expect(lines[1]).toBe('"a,b","c""d"');
  });
});

// ---------------------------------------------------------------------------------------------
// 4. toCsv — document assembly and the one-table rule
// ---------------------------------------------------------------------------------------------

describe('toCsv', () => {
  it('builds the document the manifest describes', () => {
    const doc = toCsv<TestParams, TestPayload>(
      manifestWith(),
      { variant: 'equity', rows: [['2026-09-15', 'a', 1]] },
      { range: '1M' },
      CTX,
    );
    expect(doc.filename).toBe('HP_AAPL_US_Equity_1M.csv');
    expect(doc.asOf).toBe(CTX.asOf);
    expect(doc.attribution).toEqual(CTX.attribution);
    expect(doc.columns.map((c) => c.id)).toEqual(['date', 'note', 'PX_LAST']);
    expect(doc.rows).toEqual([['2026-09-15', 'a', 1]]);
  });

  it('copies columns and rows, so the caller cannot mutate the payload through the document', () => {
    const payload: TestPayload = { variant: 'equity', rows: [['2026-09-15', 'a', 1]] };
    const doc = toCsv<TestParams, TestPayload>(manifestWith(), payload, { range: '1M' }, CTX);
    doc.rows[0]![0] = 'mutated';
    doc.columns[0]!.id = 'mutated';
    expect(payload.rows[0]![0]).toBe('2026-09-15');
    expect(COLUMNS[0]!.id).toBe('date');
  });

  it('supports payload-dependent columns (rule 4: QM, W, HP)', () => {
    const doc = toCsv<TestParams, TestPayload>(
      manifestWith({
        columns: (_params, payload) =>
          payload.rows[0]!.map((_cell, i) => ({
            id: `c${String(i)}`,
            label: `C${String(i)}`,
            type: 'string' as const,
          })),
      }),
      { variant: 'equity', rows: [['a', 'b']] },
      { range: '1M' },
      CTX,
    );
    expect(doc.columns.map((c) => c.id)).toEqual(['c0', 'c1']);
  });

  it('refuses a ragged table (rule 3: one table per document)', () => {
    expect(() =>
      toCsv<TestParams, TestPayload>(
        manifestWith(),
        {
          variant: 'equity',
          rows: [
            ['2026-09-15', 'a', 1],
            ['2026-09-15', 'a'],
          ],
        },
        { range: '1M' },
        CTX,
      ),
    ).toThrow(RangeError);
    expect(() =>
      toCsv<TestParams, TestPayload>(
        manifestWith(),
        { variant: 'equity', rows: [['2026-09-15', 'a', 1, 'extra']] },
        { range: '1M' },
        CTX,
      ),
    ).toThrow(/csv row 0 has 4 cells but 3 columns/);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Cell serialisation at full stored precision (rule 2)
// ---------------------------------------------------------------------------------------------

describe('serialiseCell', () => {
  it.each([
    ['null', null, ''],
    ['undefined', undefined, ''],
    ['true', true, 'true'],
    ['false', false, 'false'],
    ['a string', 'AAPL', 'AAPL'],
    ['an integer', 16591786, '16591786'],
    ['a negative', -0.8436, '-0.8436'],
    ['full precision', 124.8075, '124.8075'],
  ])('serialises %s', (_name, cell, expected) => {
    expect(serialiseCell(cell)).toBe(expected);
  });

  it('renders a date column from epoch ms', () => {
    expect(serialiseCell(1600128000000, { id: 'd', label: 'D', type: 'date' })).toBe('2020-09-15');
  });

  it('renders a datetime column from epoch ms as ISO UTC', () => {
    expect(serialiseCell(1789497688412, { id: 't', label: 'T', type: 'datetime' })).toBe(
      '2026-09-15T18:41:28.412Z',
    );
  });
});

describe('numberToCsv', () => {
  it('never uses exponent notation for |x| >= 1e-6', () => {
    expect(numberToCsv(1e21)).toBe('1000000000000000000000');
    expect(numberToCsv(1.5e-7 * 10)).toBe('0.0000015');
    expect(numberToCsv(-1e21)).toBe('-1000000000000000000000');
    expect(numberToCsv(1.2345e7)).toBe('12345000');
  });

  it('keeps exponent notation below 1e-6, where expanding would be absurd', () => {
    expect(numberToCsv(1e-21)).toBe('1e-21');
  });

  it('emits the shortest round-trip decimal', () => {
    for (const n of [0.1, 330.27, 124.8075, -0.8436, 1 / 3]) {
      expect(Number(numberToCsv(n))).toBe(n);
    }
  });

  it('renders -0 as 0 and non-finite values as empty', () => {
    expect(numberToCsv(-0)).toBe('0');
    expect(numberToCsv(Number.NaN)).toBe('');
    expect(numberToCsv(Number.POSITIVE_INFINITY)).toBe('');
  });
});
