/**
 * `sec.companyfacts` — QA-02 over the 3.7 MB `sec-companyfacts-AAPL.json` capture.
 *
 * Measured, not assumed: the payload holds **25,135 facts across two taxonomies and 503 `us-gaap`
 * concepts**, of which **25,116 survive** — 19 are skipped because their unit (`Year`, `Store`) is
 * not one we model. `filed` runs **2009-07-22 → 2026-07-31**.
 *
 * Three derived classifications are pinned here because each of them is a way to get fundamentals
 * silently wrong:
 *
 *  1. **duration class.** 9,359 instant facts, 5,306 quarters, 2,222 halves, 2,380 nine-months and
 *     5,849 annuals. The 2026 Q2 10-Q tags `RevenueFromContractWithCustomerExcludingAssessedTax`
 *     twice — once for the 91-day quarter (111,184,000,000) and once for the 182-day half
 *     (254,940,000,000). Summing what the payload calls "revenue" would report 366 bn.
 *  2. **restatement detection.** 449 facts restate an earlier value for the same period. Each is a
 *     **new row** — `xbrl_facts` carries a WORM trigger precisely so it cannot be done as an update.
 *  3. **`filed_at` is the point-in-time key** (STOR-06): the CY2026Q1 revenue fact that
 *     `test/integration/pit.fundamentals.test.ts` reads is `accn 0000320193-26-000013`,
 *     `filed 2026-05-01`, `111184000000` — asserted here at the parse boundary, so a PIT failure
 *     can never be blamed on the parser.
 */

import { describe, expect, it } from 'vitest';

import { companyFactsUrl, secCompanyFactsAdapter } from '../../../src/providers/sec/adapter.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { corruptions, readGolden, replayContext, serialiseGolden, toGolden } from './golden.js';

import type { XbrlFactRow } from '../../../src/providers/sec/parse.js';

const CAPTURE = 'sec-companyfacts-AAPL.json';
const store = openReplayStore();
const url = companyFactsUrl('0000320193');
if (url === null) throw new Error('companyFactsUrl returned null for a valid CIK');
const raw = store.replay({ providerId: 'sec.companyfacts', url });
const normalised = secCompanyFactsAdapter.normalise(raw, replayContext(raw));
const facts: readonly XbrlFactRow[] = normalised.rows.facts;

function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

describe('sec.companyfacts — Apple XBRL company facts', () => {
  it('builds the padded-CIK URL the capture was recorded under', () => {
    expect(url).toBe('https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json');
    expect(requestKey('sec.companyfacts', 'GET', url)).toBe(raw.requestKey);
    expect(raw.body.length).toBe(3_789_099);
  });

  it('keeps 25,116 of 25,135 facts and says exactly what it dropped', () => {
    expect(facts).toHaveLength(25_116);
    expect(normalised.rows.conceptCount).toBe(503);
    expect(normalised.rows.droppedUnits).toEqual({ Year: 13, Store: 6 });
    // Six `field_dropped` problems: one per (concept, unmodelled unit) pair, not one per fact.
    expect(normalised.problems).toHaveLength(6);
    expect(normalised.problems.every((problem) => problem.kind === 'field_dropped')).toBe(true);
    expect(normalised.updates).toEqual([]);
  });

  it('ingests only us-gaap and dei, and only the four modelled units', () => {
    expect(countBy(facts.map((fact) => fact.taxonomy))).toEqual({ 'us-gaap': 25_027, dei: 89 });
    expect(Object.keys(countBy(facts.map((fact) => fact.unit))).sort()).toEqual([
      'USD',
      'USD/shares',
      'pure',
      'shares',
    ]);
  });

  it('derives the duration class the statement builder depends on', () => {
    expect(countBy(facts.map((fact) => fact.durationClass))).toEqual({
      instant: 9_359,
      quarter: 5_306,
      half: 2_222,
      nine_month: 2_380,
      annual: 5_849,
    });
    // An instant fact has no period_start — that is what xbrl_facts_period_chk keys on.
    expect(facts.filter((fact) => fact.periodStart === null)).toHaveLength(9_359);
  });

  it('separates the quarter from the half that the same 10-Q tags (the triple-count trap)', () => {
    const revenue = facts.filter(
      (fact) =>
        fact.concept === 'RevenueFromContractWithCustomerExcludingAssessedTax' &&
        fact.periodEnd === '2026-03-28' &&
        fact.accessionNo === '0000320193-26-000013',
    );
    expect(revenue).toHaveLength(2);
    expect(revenue.map((fact) => [fact.durationClass, fact.value])).toEqual([
      ['half', '254940000000'],
      ['quarter', '111184000000'],
    ]);
  });

  it('carries filed_at as the point-in-time key (STOR-06)', () => {
    // The 10-Q tags the prior-year comparative quarter too, so the period end is part of the key.
    const pit = facts.find(
      (fact) =>
        fact.concept === 'RevenueFromContractWithCustomerExcludingAssessedTax' &&
        fact.accessionNo === '0000320193-26-000013' &&
        fact.periodEnd === '2026-03-28' &&
        fact.durationClass === 'quarter',
    );
    expect(pit?.filedAt).toBe('2026-05-01');
    expect(pit?.frame).toBe('CY2026Q1');
    expect(pit?.fy).toBe(2026);
    expect(pit?.fp).toBe('Q2');
    expect(normalised.rows.filedFrom).toBe('2009-07-22');
    expect(normalised.rows.filedTo).toBe('2026-07-31');
  });

  it('never infers an absent frame', () => {
    // 15,329 of the 25,116 kept facts publish no `frame`; not one of them gains one here.
    expect(facts.filter((fact) => fact.frame === null)).toHaveLength(15_329);
  });

  it('flags 449 restatements without ever replacing the value they restate', () => {
    const restated = facts.filter((fact) => fact.restatement);
    expect(restated).toHaveLength(449);
    for (const fact of restated.slice(0, 20)) {
      const earlier = facts.filter(
        (other) =>
          other.concept === fact.concept &&
          other.unit === fact.unit &&
          other.periodEnd === fact.periodEnd &&
          other.periodStart === fact.periodStart &&
          other.filedAt < fact.filedAt,
      );
      // The row it restates is still present, unchanged — an append, never an update.
      expect(earlier.length).toBeGreaterThan(0);
    }
  });

  it('writes every value as decimal text, never as a float literal', () => {
    expect(facts.every((fact) => /^-?\d+(\.\d{1,6})?$/.test(fact.value))).toBe(true);
    expect(facts.every((fact) => /^\d{10}$/.test(fact.cik))).toBe(true);
  });

  it('never throws on a truncated, reordered or corrupted body (QA-05)', () => {
    for (const body of corruptions(raw.body, 2)) {
      const out = secCompanyFactsAdapter.normalise({ ...raw, body }, replayContext(raw));
      // A parse error is a *result*, never an exception: the fuzzer's whole point.
      expect(Array.isArray(out.problems)).toBe(true);
      expect(out.updates).toEqual([]);
      expect(() => JSON.stringify(out.rows)).not.toThrow();
    }
  });

  it('equals the committed golden', () => {
    const golden = serialiseGolden(
      toGolden(
        CAPTURE,
        secCompanyFactsAdapter.id,
        raw.requestKey,
        secCompanyFactsAdapter.adapterVersion,
        normalised,
      ),
    );
    expect(golden).toBe(readGolden(CAPTURE));
  });
});
