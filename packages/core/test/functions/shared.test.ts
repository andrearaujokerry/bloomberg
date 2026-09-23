// packages/core/test/functions/shared.test.ts — WP-09 acceptance for the shared Tier 1 pieces
// (FUNCTIONS_TIER1 §0.1, §0.2, §0.5).
//
// Three things are proved here, and the first one is the reason this file exists at all:
//
//  1. `core/functions/schemas.ts` is BYTE-IDENTICAL to `sdk/wire/common.ts`. Core cannot import the
//     SDK (the SDK depends on core), so the two copies are kept honest by reading both files off
//     disk and comparing the declaration text character for character. Comparing the parsed zod
//     objects would not do: two enums can list the same members in a different order, or differ in
//     a regex or a `.max()`, and still look equal to a shape assertion.
//  2. `monitorColumn` reads its label, rendering and decimals out of the field dictionary, so a
//     monitor column can never disagree with how the same field renders on DES or in a CSV.
//  3. `newsCsvRow` emits its cells in `newsCsvColumns` order — the contract that makes the export
//     of TOP, N and NI equal to what the screen showed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as schemas from '../../src/functions/schemas.js';
import { newsCsvColumns, newsCsvRow } from '../../src/functions/shared/news.js';
import type { NewsRow } from '../../src/functions/shared/news.js';
import { monitorColumn } from '../../src/functions/shared/monitor.js';
import { requireField } from '../../src/fields/dictionary.js';

// ---------------------------------------------------------------------------------------------
// 1. Byte-identical with the SDK
// ---------------------------------------------------------------------------------------------

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const CORE_SOURCE = read('../../src/functions/schemas.ts');
const SDK_SOURCE = read('../../../sdk/src/wire/common.ts');

/**
 * The text of one `export const <name> = … ; export type <name> = z.infer<typeof <name>>;` pair,
 * exactly as it appears in the file — interior comments included, because a comment that explains
 * what a `.max(120)` means is part of what the two copies have to agree on.
 */
function declaration(source: string, name: string): string {
  const start = source.indexOf(`export const ${name} = `);
  if (start === -1) throw new Error(`no 'export const ${name}' in the source`);
  const tail = `export type ${name} = z.infer<typeof ${name}>;`;
  const end = source.indexOf(tail, start);
  if (end === -1) throw new Error(`no '${tail}' after 'export const ${name}'`);
  return source.slice(start, end + tail.length);
}

/** FUNCTIONS_TIER1 §0.1: the enums every Tier 1 manifest shares with the wire. */
const SHARED_WITH_SDK = [
  'AssetClass',
  'MarketSector',
  'Tier',
  'ValueState',
  'AdjustPolicy',
  'Periodicity',
  'FieldId',
  'SecurityRefInput',
] as const;

/**
 * §0.1 names `SortSpec` among the schemas `core/functions/schemas.ts` holds, but
 * `sdk/wire/common.ts` has no such declaration today. Recorded here rather than papered over: when
 * the SDK gains it, this list empties and `SortSpec` joins `SHARED_WITH_SDK` above.
 */
const SDK_MISSING = ['SortSpec'] as const;

describe('core/functions/schemas.ts is byte-identical to sdk/wire/common.ts', () => {
  it.each(SHARED_WITH_SDK)('%s declares the same characters in both files', (name) => {
    expect(declaration(CORE_SOURCE, name)).toBe(declaration(SDK_SOURCE, name));
  });

  it('shares the FieldId pattern character for character', () => {
    const line = 'export const FIELD_ID_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;';
    expect(CORE_SOURCE).toContain(line);
    expect(SDK_SOURCE).toContain(line);
    expect(schemas.FIELD_ID_PATTERN.source).toBe('^[A-Z][A-Z0-9_]{1,39}$');
  });

  it.each(SDK_MISSING)(
    '%s is declared in core and absent from the SDK (recorded divergence)',
    (name) => {
      expect(() => declaration(CORE_SOURCE, name)).not.toThrow();
      expect(SDK_SOURCE).not.toContain(`export const ${name} = `);
    },
  );

  it('parses and rejects the way the wire does', () => {
    expect(schemas.AssetClass.options).toEqual([
      'equity',
      'etf',
      'index',
      'fx',
      'govt',
      'option',
      'future',
      'crypto',
      'rate',
      'econ',
    ]);
    expect(schemas.Tier.options).toEqual(['eod', 'delayed', 'realtime']);
    expect(schemas.ValueState.options).toEqual(['live', 'stale', 'closed', 'blank', 'na']);
    expect(schemas.AdjustPolicy.options).toEqual(['unadjusted', 'price', 'total_return']);
    expect(schemas.Periodicity.options).toEqual(['D', 'W', 'M', 'Q', 'Y']);
    expect(schemas.MarketSector.options).toHaveLength(11);

    expect(schemas.FieldId.safeParse('PX_LAST').success).toBe(true);
    expect(schemas.FieldId.safeParse('px_last').success).toBe(false);

    expect(schemas.SecurityRefInput.safeParse({ ref: 'AAPL US Equity' }).success).toBe(true);
    expect(schemas.SecurityRefInput.safeParse({ id: 42 }).success).toBe(true);
    expect(schemas.SecurityRefInput.safeParse({ id: 0 }).success).toBe(false);
    expect(schemas.SecurityRefInput.safeParse({ formula: 'ab' }).success).toBe(false);

    expect(schemas.SortSpec.parse({ col: 'PX_LAST', dir: 'desc' })).toEqual({
      col: 'PX_LAST',
      dir: 'desc',
    });
    expect(schemas.SortSpec.safeParse({ col: 'PX_LAST', dir: 'sideways' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. monitorColumn derives from the dictionary
// ---------------------------------------------------------------------------------------------

describe('monitorColumn', () => {
  it('derives a price column: px, no decimals (the instrument decides)', () => {
    const col = monitorColumn('PX_LAST');
    expect(col).toEqual({
      id: 'PX_LAST',
      label: requireField('PX_LAST').label,
      fieldId: 'PX_LAST',
      fmt: 'px',
    });
    // `decimals` is omitted, not null: a dictionary null means "instrument price_decimals".
    expect('decimals' in col).toBe(false);
    expect(requireField('PX_LAST').decimals).toBeNull();
  });

  it('derives a percentage column: pct with two decimals', () => {
    expect(monitorColumn('CHG_PCT_1D')).toEqual({
      id: 'CHG_PCT_1D',
      label: requireField('CHG_PCT_1D').label,
      fieldId: 'CHG_PCT_1D',
      fmt: 'pct',
      decimals: 2,
    });
  });

  it('derives a share-count column: shares with zero decimals', () => {
    expect(monitorColumn('VOLUME_AVG_30D')).toEqual({
      id: 'VOLUME_AVG_30D',
      label: requireField('VOLUME_AVG_30D').label,
      fieldId: 'VOLUME_AVG_30D',
      fmt: 'shares',
      decimals: 0,
    });
    expect(requireField('VOLUME_AVG_30D').unit).toBe('shares');
  });

  it('derives a date column: date, no decimals', () => {
    const col = monitorColumn('CURVE_DATE');
    expect(col.fmt).toBe('date');
    expect(col.label).toBe(requireField('CURVE_DATE').label);
    expect('decimals' in col).toBe(false);
  });

  it('takes the label from the dictionary rather than from the id', () => {
    expect(monitorColumn('PX_LAST').label).not.toBe('PX_LAST');
  });

  it('throws on a field the dictionary does not have', () => {
    expect(() => monitorColumn('PX_LSAT')).toThrow(/PX_LSAT/);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. newsCsvRow follows newsCsvColumns
// ---------------------------------------------------------------------------------------------

const row: NewsRow = {
  newsId: 8812,
  headline: 'Apple sets September event',
  summary: 'The company said it would hold an event.',
  sourceId: 'bbg.rss',
  feed: 'markets',
  kind: 'story',
  author: null,
  category: 'Technology',
  cik: null,
  items8k: null,
  publishedAt: '2026-09-15T12:04:00.000Z',
  capturedAt: '2026-09-15T12:04:31.000Z',
  url: 'https://example.invalid/story/8812',
  isCorrection: false,
  machineGenerated: false,
  links: [
    {
      entityKind: 'instrument',
      entityId: 42,
      display: 'AAPL US Equity',
      confidence: 1,
      method: 'ticker_exact',
    },
    {
      entityKind: 'instrument',
      entityId: 77,
      display: 'SPX Index',
      confidence: 0.95,
      method: 'name_exact',
    },
  ],
  provIdx: 0,
};

describe('newsCsvColumns / newsCsvRow', () => {
  it('declares the §0.5 columns in the documented order', () => {
    expect(newsCsvColumns.map((c) => c.id)).toEqual([
      'publishedAt',
      'sourceId',
      'feed',
      'kind',
      'headline',
      'url',
      'linkedKeys',
      'isCorrection',
      'newsId',
    ]);
    expect(newsCsvColumns.map((c) => c.label)).toEqual([
      'Published',
      'Source',
      'Feed',
      'Kind',
      'Headline',
      'URL',
      'Linked',
      'Correction',
      'News id',
    ]);
    expect(newsCsvColumns.map((c) => c.type)).toEqual([
      'datetime',
      'string',
      'string',
      'string',
      'string',
      'string',
      'string',
      'boolean',
      'number',
    ]);
  });

  it('emits one cell per column, positionally aligned', () => {
    const cells = newsCsvRow(row);
    expect(cells).toHaveLength(newsCsvColumns.length);
    expect(cells).toEqual([
      '2026-09-15T12:04:00.000Z',
      'bbg.rss',
      'markets',
      'story',
      'Apple sets September event',
      'https://example.invalid/story/8812',
      'AAPL US Equity|SPX Index',
      false,
      8812,
    ]);
  });

  it('joins linked entities with a pipe and emits an empty cell when there are none', () => {
    expect(newsCsvRow({ ...row, links: [] })[6]).toBe('');
  });
});
