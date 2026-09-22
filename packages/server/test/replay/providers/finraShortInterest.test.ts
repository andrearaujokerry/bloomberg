/**
 * QA-02 — `finra.shortInterest` over `finra-trace`. WORKPLAN WP-05, PROVIDERS.b §12.
 *
 * The capture is a single row, which is enough to pin every rule that matters: the settlement date
 * (not the publication date) is the key, the published `daysToCover` is cross-checked against
 * `short_qty / avg_daily_volume`, and `changePreviousNumber` is cross-checked against
 * `current − previous`. The synthetic cases below drive the two cross-checks into failure, because
 * a check that has never failed in a test is a check nobody has tested.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FINRA_ADAPTER_VERSION,
  finraShortInterestAdapter,
  shortInterestUrl,
} from '../../../src/providers/finra/adapter.js';
import {
  normaliseShortInterest,
  parseRevisionFlag,
  parseSettlementDate,
  parseShortInterest,
} from '../../../src/providers/finra/parse.js';
import { createProviderRegistry } from '../../../src/providers/registry.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import type { NormaliseContext, RawRecord } from '../../../src/providers/types.js';

const store = openReplayStore();

function goldenText(name: string): string {
  return readFileSync(join(store.dir, 'normalised', name), 'utf8');
}

function serialise(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ctxOf(raw: RawRecord): NormaliseContext {
  return { provenanceId: 0, capturedAt: raw.capturedAt, lines: new Map() };
}

const HEADER =
  'accountingYearMonthNumber,symbolCode,issueName,issuerServicesGroupExchangeCode,marketClassCode,' +
  'currentShortPositionQuantity,previousShortPositionQuantity,stockSplitFlag,' +
  'averageDailyVolumeQuantity,daysToCoverQuantity,revisionFlag,changePercent,changePreviousNumber,' +
  'settlementDate';

const url = shortInterestUrl();
const raw = store.replay({ providerId: 'finra.shortInterest', url });

describe('finra.shortInterest replay (§12)', () => {
  it('the adapter URL derives the recorded request key', () => {
    expect(url).toBe(
      'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest?limit=1000&offset=0',
    );
    expect(store.has(requestKey('finra.shortInterest', 'GET', url))).toBe(true);
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.headers['content-type']).toBe('text/csv');
    expect(raw.body.length).toBe(376);
  });

  it('parse.ts equals the committed golden, byte for byte', () => {
    expect(serialise(normaliseShortInterest(raw, ctxOf(raw)))).toBe(goldenText('finra-trace.json'));
  });

  it('measures what the capture actually contains', () => {
    const out = normaliseShortInterest(raw, ctxOf(raw));
    expect(out.problems).toHaveLength(0);
    expect(out.rows.rows).toHaveLength(1);
    expect(out.rows.maxSettlementDate).toBe('2020-04-15');
    expect(out.rows.rows[0]).toEqual({
      symbolCode: 'A',
      issueName: 'Agilent Technologies Inc.',
      marketClassCode: 'NYSE',
      settlementDate: '2020-04-15',
      shortQty: 4_851_353,
      prevShortQty: 4_767_556,
      avgDailyVolume: 2_012_318,
      daysToCover: 2.41,
      changePct: 1.76,
      revision: false,
      stockSplitFlag: null,
      accountingYearMonth: '20200415',
    });

    // The published cross-checks hold on this row: 4851353 − 4767556 = 83797, and
    // 4851353 / 2012318 = 2.4108…, which rounds to the published 2.41.
    const row = out.rows.rows[0]!;
    expect(row.shortQty! - row.prevShortQty!).toBe(83_797);
    expect(row.shortQty! / row.avgDailyVolume!).toBeCloseTo(2.4108, 4);

    // `sourceTs` is the settlement date the figures describe, at midnight UTC.
    expect(out.sourceTs?.toISOString()).toBe('2020-04-15T00:00:00.000Z');
  });

  it('flags a days-to-cover that disagrees with the quantities', () => {
    const csv = `${HEADER}\n20200415,B,Test Inc.,B,NYSE,1000000,900000,,100000,25.00,,11.11,100000,2020-04-15\n`;
    const { rows, problems } = parseShortInterest(csv);
    expect(rows.rows[0]?.daysToCover).toBe(25);
    expect(problems.some((p) => p.kind === 'out_of_range' && p.detail.includes('apart'))).toBe(
      true,
    );
  });

  it('drops a days-to-cover above 100 and keeps the quantities', () => {
    const csv = `${HEADER}\n20200415,C,Test Inc.,C,NYSE,1000000,900000,,5000,200.00,,11.11,100000,2020-04-15\n`;
    const { rows, problems } = parseShortInterest(csv);
    expect(rows.rows[0]?.daysToCover).toBeNull();
    expect(rows.rows[0]?.shortQty).toBe(1_000_000);
    expect(problems.some((p) => p.kind === 'out_of_range' && p.detail.includes('exceeds'))).toBe(
      true,
    );
  });

  it('flags a changePreviousNumber that is not current − previous', () => {
    const csv = `${HEADER}\n20200415,D,Test Inc.,D,NYSE,1000000,900000,,500000,2.00,,11.11,999,2020-04-15\n`;
    const { problems } = parseShortInterest(csv);
    expect(
      problems.some(
        (p) => p.detail.includes('changePreviousNumber') && p.detail.includes('100000'),
      ),
    ).toBe(true);
  });

  it('surfaces a stock-split flag and a revision flag rather than dropping them', () => {
    const csv = `${HEADER}\n20200415,E,Test Inc.,E,NYSE,1000000,900000,Y,500000,2.00,Y,11.11,100000,2020-04-15\n`;
    const { rows } = parseShortInterest(csv);
    expect(rows.rows[0]?.stockSplitFlag).toBe('Y');
    expect(rows.rows[0]?.revision).toBe(true);
  });

  it('reads the settlement date and revision flag the ways FINRA writes them', () => {
    expect(parseSettlementDate('2020-04-15')).toBe('2020-04-15');
    expect(parseSettlementDate('20200415')).toBe('2020-04-15');
    expect(parseSettlementDate('4/15/2020')).toBe('2020-04-15');
    expect(parseSettlementDate('15 April 2020')).toBeNull();
    expect([parseRevisionFlag('Y'), parseRevisionFlag('y'), parseRevisionFlag('1')]).toEqual([
      true,
      true,
      true,
    ]);
    expect([parseRevisionFlag(''), parseRevisionFlag(null), parseRevisionFlag('N')]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('refuses a payload whose header lost a keyed column', () => {
    const { rows, problems } = parseShortInterest('a,b,c\n1,2,3\n');
    expect(rows.rows).toHaveLength(0);
    expect(problems.some((p) => p.kind === 'schema_drift')).toBe(true);
  });

  it('registers under its licensed source id', () => {
    const registry = createProviderRegistry([finraShortInterestAdapter]);
    expect(registry.ids()).toEqual(['finra.shortInterest']);
    expect(finraShortInterestAdapter.adapterVersion).toBe(FINRA_ADAPTER_VERSION);
    expect(finraShortInterestAdapter.sourceId).toBe('finra.shortInterest');
  });

  it('never throws on truncated or corrupted input (QA-05 smoke)', () => {
    const text = raw.body.toString('utf8');
    for (const candidate of [
      '',
      '\n',
      HEADER,
      `${HEADER}\n,,,`,
      text.slice(0, 200),
      text.slice(30),
    ]) {
      expect(() => parseShortInterest(candidate)).not.toThrow();
    }
  });
});
