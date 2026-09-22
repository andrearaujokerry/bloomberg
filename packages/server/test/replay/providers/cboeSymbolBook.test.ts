/**
 * `cboe.symbolBook` over `cboe-symbol-book.json` — QA-02, PROVIDERS.a §5.3.
 *
 * The universe file is the one adapter that writes no master rows: it feeds `refdata/universe.ts`
 * and the client's autocomplete snapshot, so what matters is that every one of the 35,618 entries
 * survives, that the order is the parser's and not the provider's, and that the shape
 * classification puts indices and futures where TERM-02's search weighting expects them.
 */

import { describe, expect, it } from 'vitest';

import {
  cboeSymbolBookAdapter,
  CBOE_SYMBOL_BOOK_URL,
} from '../../../src/providers/cboe/adapter.js';
import {
  classifySymbolBookName,
  normaliseSymbolBook,
  SYMBOL_BOOK_MIN_ENTRIES,
} from '../../../src/providers/cboe/parse.js';
import type { RawRecord } from '../../../src/providers/types.js';
import {
  CAPTURES,
  capture,
  goldenOf,
  keyFor,
  readGolden,
  serialiseGolden,
  symbolBookContext,
} from './cboeFixtures.js';

const spec = CAPTURES.symbolBook;
const raw = capture(spec.providerId, spec.url);
const result = normaliseSymbolBook(raw, symbolBookContext(raw));

describe('cboe.symbolBook — the recorded capture', () => {
  it('reads 2,309,236 bytes through the replay store', () => {
    expect(raw.origin).toBe('replay');
    expect(raw.body.byteLength).toBe(2_309_236);
    expect(raw.requestKey).toBe(keyFor(spec.providerId, spec.url));
    expect(CBOE_SYMBOL_BOOK_URL).toBe(
      'https://cdn.cboe.com/api/global/delayed_quotes/symbol_book/symbol-book.json',
    );
    expect(cboeSymbolBookAdapter.sourceId).toBe('cboe.symbolBook');
  });

  it('parse.ts over the capture equals the committed golden', () => {
    expect(serialiseGolden(result)).toBe(readGolden(spec.golden));
    expect(goldenOf(result)).toEqual(JSON.parse(readGolden(spec.golden)));
  });
});

describe('cboe.symbolBook — §5.3 parse rules', () => {
  it('keeps all 35,618 entries, with no duplicate and no problem', () => {
    expect(result.rows.entries).toHaveLength(35_618);
    expect(result.rows.summary).toEqual({
      entryCount: 35_618,
      duplicateCount: 0,
      byKind: { equity: 32_622, future: 118, index: 1907, other: 971 },
      belowMinimum: false,
    });
    expect(result.problems).toEqual([]);
    expect(result.updates).toEqual([]);
    expect(result.sourceTs?.toISOString()).toBe('2026-09-15T18:00:09.000Z');
  });

  it('sorts by name itself, so the output never depends on the provider’s ordering', () => {
    const names = result.rows.entries.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (let i = 1; i < names.length; i++) expect(names[i - 1]! < names[i]!).toBe(true);
    expect(names[0]).toBe('A');
    expect(names.at(-1)).toBe('^ZTWOIV');
  });

  it('classifies by shape: equity, future, index, or a low-weight leftover', () => {
    const byName = new Map(result.rows.entries.map((e) => [e.name, e]));
    expect(byName.get('A')).toEqual({
      name: 'A',
      companyName: 'Agilent Technologies Inc',
      kind: 'equity',
    });
    expect(byName.get('AAPL')?.kind).toBe('equity');
    expect(byName.get('A2RZ1')).toEqual({
      name: 'A2RZ1',
      companyName: 'Adjusted Interest Rate Russell 2000 Total Return Futures',
      kind: 'future',
    });
    // §5.3 spells the index prefix `_`; the capture publishes `^` (and no `_` at all). Both are
    // accepted, because classifying `^SPX` as a leftover would cost S&P 500 its search weight.
    expect(byName.get('^SPX')).toEqual({
      name: '^SPX',
      companyName: 'S&P 500 INDEX',
      kind: 'index',
    });
    expect(byName.get('^VIX')?.kind).toBe('index');
    expect(result.rows.entries.filter((e) => e.name.startsWith('_'))).toEqual([]);

    expect(classifySymbolBookName('_SPX', 'S&P 500 INDEX')).toBe('index');
    expect(classifySymbolBookName('ESZ6', 'E-mini S&P 500 Futures')).toBe('future');
    // The futures shape without the word: not a future, and not a 1-5 letter equity either.
    expect(classifySymbolBookName('ESZ6', 'Some Company Inc')).toBe('other');
    expect(classifySymbolBookName('BRKB', 'Berkshire Hathaway')).toBe('equity');
    expect(classifySymbolBookName('ABCDEF', 'Six letters')).toBe('other');
  });
});

describe('cboe.symbolBook — failures (§5.3)', () => {
  const mutate = (body: string): RawRecord => ({ ...raw, body: Buffer.from(body, 'utf8') });

  it('flags a truncated universe instead of publishing it', () => {
    const payload = JSON.parse(raw.body.toString('utf8')) as {
      timestamp: string;
      data: unknown[];
    };
    const short = normaliseSymbolBook(
      mutate(JSON.stringify({ ...payload, data: payload.data.slice(0, 1000) })),
      symbolBookContext(raw),
    );
    expect(short.rows.summary.belowMinimum).toBe(true);
    expect(short.problems.map((p) => p.kind)).toEqual(['out_of_range']);
    expect(short.problems[0]!.detail).toContain('1000');
    expect(short.problems[0]!.detail).toContain(String(SYMBOL_BOOK_MIN_ENTRIES));
  });

  it('keeps the first of a duplicated name and reports the drop', () => {
    const body = JSON.stringify({
      timestamp: '2026-09-15 18:00:09',
      data: [
        { name: 'AAPL', company_name: 'Apple Inc' },
        { name: 'AAPL', company_name: 'Apple Inc (duplicate)' },
        { name: 'MSFT', company_name: 'Microsoft' },
      ],
      symbol: 'symbol-book',
    });
    const dup = normaliseSymbolBook(mutate(body), symbolBookContext(raw));
    expect(dup.rows.entries).toHaveLength(2);
    expect(dup.rows.entries[0]!.companyName).toBe('Apple Inc');
    expect(dup.rows.summary.duplicateCount).toBe(1);
    expect(dup.problems.some((p) => p.kind === 'field_dropped')).toBe(true);
  });

  it('never throws on a corrupted payload (QA-05)', () => {
    const text = raw.body.toString('utf8');
    for (const body of [
      '',
      '{',
      text.slice(0, 5000),
      text.slice(0, 2_000_000),
      '{"timestamp":"2026-09-15 18:00:09","data":{},"symbol":"symbol-book"}',
      '{"timestamp":"x","data":[{"name":null},{},"junk",{"name":"OK"}]}',
    ]) {
      const bad = normaliseSymbolBook(mutate(body), symbolBookContext(raw));
      expect(Array.isArray(bad.rows.entries)).toBe(true);
      expect(Array.isArray(bad.problems)).toBe(true);
    }
  });
});
