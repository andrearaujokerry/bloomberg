// packages/core/test/adjust/corporateActions.test.ts — WP-02 acceptance test for REF-09,
// TESTING §7.9 (`adjust.split.dividend`, `adjust.aapl.fixture`).
//
// Driven by the checked-in goldens, which are self-contained by construction: the case's actions,
// bars and policy are literals in the file, and no `fixtures/providers/raw/` capture or replay
// store is opened (WORKPLAN L471-482). `node:fs` is legal here — `packages/*/test/**` is outside
// every core boundary zone (eslint.config.js L13-14).
//
// What is asserted:
//   1. every `expected` key of every golden case, to that case's `tol`;
//   2. that `price`, `total_return` and `unadjusted` are NOT interchangeable (the window returns
//      +10.000000 % / +11.111111 % / −45.000000 %);
//   3. that the dividend factor really is `1 − amount / closeBeforeEx` on the UNADJUSTED close of
//      the last session before the ex-date — the reason `adjustmentFactors` takes `closes`;
//   4. the "strictly before the ex-date, cumulative latest → earliest" rule (DATA_MODEL §6.1);
//   5. status gating (`cancelled` / `estimated` never apply; `announced` / `confirmed` / `paid` do);
//   6. `totalReturnIndex()` = the `total_return` series rebased to the first close, within 1e-9.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  adjustmentFactors,
  applyAdjustment,
  cumulativeFactors,
  totalReturnIndex,
} from '../../src/adjust/corporateActions.js';
import type { CaForAdjust, CaStatus, CaType } from '../../src/adjust/corporateActions.js';
import type { AdjustPolicy, Bar } from '../../src/types/bars.js';

/** The `{inputs, valuationTs, expected, tol, source}` record of TESTING §7.1. */
interface GoldenCase {
  id: string;
  engine: string;
  engineVersion: string;
  inputs: {
    policy: AdjustPolicy;
    actions: {
      caType: CaType;
      status: CaStatus;
      exDate: string;
      amount?: number;
      ratioNew?: number;
      ratioOld?: number;
    }[];
    bars: {
      date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number | null;
    }[];
  };
  valuationTs: string;
  expected: Record<string, number | string | boolean>;
  tol: Record<string, number>;
  source: string;
}

function loadGolden(file: string): GoldenCase[] {
  const url = new URL(`../../../../fixtures/golden/analytics/adjust/${file}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as GoldenCase[];
}

function toAction(row: GoldenCase['inputs']['actions'][number]): CaForAdjust {
  const action: CaForAdjust = { caType: row.caType, status: row.status, exDate: row.exDate };
  if (typeof row.amount === 'number') action.amount = row.amount;
  if (typeof row.ratioNew === 'number') action.ratioNew = row.ratioNew;
  if (typeof row.ratioOld === 'number') action.ratioOld = row.ratioOld;
  return action;
}

function toBar(row: GoldenCase['inputs']['bars'][number]): Bar {
  return {
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  };
}

/**
 * Everything a golden case may pin, as one flat key → scalar map:
 *   `steps.length`, `steps.<i>.{beforeDate,priceFactor,volumeFactor,kind}`,
 *   `{open,high,low,close,volume}.<date>`, `factor.<date>`, `volumeFactor.<date>`,
 *   `returnPct`, `tri.<date>`.
 */
function computeActuals(kase: GoldenCase): Record<string, number | string | boolean> {
  const bars = kase.inputs.bars.map(toBar);
  const actions = kase.inputs.actions.map(toAction);
  const closes = bars.map((bar) => ({ date: bar.date, close: bar.close }));

  const steps = adjustmentFactors(actions, closes, kase.inputs.policy);
  const adjusted = applyAdjustment(bars, steps);
  const factors = cumulativeFactors(
    bars.map((bar) => bar.date),
    steps,
  );

  const out: Record<string, number | string | boolean> = { 'steps.length': steps.length };
  steps.forEach((step, i) => {
    out[`steps.${i}.beforeDate`] = step.beforeDate;
    out[`steps.${i}.priceFactor`] = step.priceFactor;
    out[`steps.${i}.volumeFactor`] = step.volumeFactor;
    out[`steps.${i}.kind`] = step.kind;
  });
  for (const bar of adjusted) {
    out[`open.${bar.date}`] = bar.open;
    out[`high.${bar.date}`] = bar.high;
    out[`low.${bar.date}`] = bar.low;
    out[`close.${bar.date}`] = bar.close;
    if (bar.volume !== null) out[`volume.${bar.date}`] = bar.volume;
  }
  for (const f of factors) {
    out[`factor.${f.date}`] = f.priceFactor;
    out[`volumeFactor.${f.date}`] = f.volumeFactor;
  }
  const first = adjusted[0];
  const last = adjusted[adjusted.length - 1];
  if (first !== undefined && last !== undefined) {
    out.returnPct = (last.close / first.close - 1) * 100;
  }
  for (const point of totalReturnIndex(bars, actions)) {
    out[`tri.${point.date}`] = point.value;
  }
  return out;
}

function assertGolden(kase: GoldenCase): void {
  const actuals = computeActuals(kase);
  for (const [key, expected] of Object.entries(kase.expected)) {
    const actual = actuals[key];
    expect(actual, `${kase.id}: no actual for key '${key}'`).not.toBeUndefined();
    if (typeof expected === 'number') {
      const tol = kase.tol[key] ?? 0;
      expect(typeof actual, `${kase.id}: '${key}' should be numeric`).toBe('number');
      expect(
        Math.abs((actual as number) - expected),
        `${kase.id}: '${key}' = ${String(actual)}, expected ${expected} ± ${tol}`,
      ).toBeLessThanOrEqual(tol);
    } else {
      expect(actual, `${kase.id}: '${key}'`).toBe(expected);
    }
  }
}

const splitDividend = loadGolden('split-dividend.json');
const aapl = loadGolden('aapl.json');

/** The full six-session bar series of TESTING §7.9, from the golden (not re-typed here). */
const seriesCase = splitDividend.find(
  (c) => c.id === 'adjust.split.dividend.series.total_return',
)!;
const BARS: Bar[] = seriesCase.inputs.bars.map(toBar);
const ACTIONS: CaForAdjust[] = seriesCase.inputs.actions.map(toAction);
const CLOSES = BARS.map((bar) => ({ date: bar.date, close: bar.close }));

describe('golden fixtures/golden/analytics/adjust/split-dividend.json (TESTING §7.9 case 1)', () => {
  it('loads eight self-contained cases', () => {
    expect(splitDividend).toHaveLength(8);
    for (const kase of splitDividend) {
      expect(kase.engine).toBe('adjust');
      expect(kase.engineVersion).toBe('1.0.0');
      expect(Object.keys(kase.expected).length).toBeGreaterThan(0);
    }
  });

  for (const kase of splitDividend) {
    it(`${kase.id} matches every pinned value`, () => {
      assertGolden(kase);
    });
  }
});

describe('golden fixtures/golden/analytics/adjust/aapl.json (TESTING §7.9 case 2)', () => {
  it("is marked 'published closes, external' and is not a QA-01 case", () => {
    const kase = aapl[0]!;
    expect(aapl).toHaveLength(1);
    expect(kase.id).toBe('adjust.aapl.fixture');
    expect(kase.source).toBe('published closes, external');
  });

  for (const kase of aapl) {
    it(`${kase.id} matches every pinned value`, () => {
      assertGolden(kase);
    });
  }
});

describe('adjustmentFactors (TESTING §7.9 factor table)', () => {
  it('splits: priceFactor = ratioOld/ratioNew, volumeFactor = 1/priceFactor', () => {
    const steps = adjustmentFactors(ACTIONS, CLOSES, 'price');
    expect(steps).toHaveLength(1);
    const split = steps[0]!;
    expect(split.beforeDate).toBe('2026-03-10');
    expect(split.kind).toBe('split');
    expect(Math.abs(split.priceFactor - 0.5)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(split.volumeFactor - 2)).toBeLessThanOrEqual(1e-12);
  });

  it('cash dividend: priceFactor = 1 − 0.50/50.00 = 0.99 off the UNADJUSTED pre-ex close', () => {
    const steps = adjustmentFactors(ACTIONS, CLOSES, 'total_return');
    expect(steps).toHaveLength(2);
    const dividend = steps[1]!;
    expect(dividend.beforeDate).toBe('2026-06-15');
    expect(dividend.kind).toBe('dividend');
    expect(Math.abs(dividend.priceFactor - 0.99)).toBeLessThanOrEqual(1e-12);
    expect(dividend.volumeFactor).toBe(1);
  });

  it('uses the last session strictly before the ex-date, not the ex-date close itself', () => {
    // 2026-06-12 = 50.00 is the pre-ex close; 2026-06-15 = 49.50 is the ex-date close.
    const [dividend] = adjustmentFactors(
      [ACTIONS[1]!],
      [
        { date: '2026-06-12', close: 40 },
        { date: '2026-06-15', close: 39.5 },
      ],
      'total_return',
    );
    // 1 − 0.50/40 = 0.9875 — the factor moves with the pre-ex close, which is why `closes` is an
    // argument (WORKPLAN L518-528: the three-argument form).
    expect(Math.abs(dividend!.priceFactor - 0.9875)).toBeLessThanOrEqual(1e-12);
  });

  it('throws when no session precedes the ex-date (WP-04 must load start − 1 session)', () => {
    expect(() =>
      adjustmentFactors([ACTIONS[1]!], [{ date: '2026-06-15', close: 49.5 }], 'total_return'),
    ).toThrow(/no close before ex-date 2026-06-15/);
  });

  it("policy 'unadjusted' produces no factors at all", () => {
    expect(adjustmentFactors(ACTIONS, CLOSES, 'unadjusted')).toEqual([]);
  });

  it('gates on status: cancelled and estimated never apply, the other three do', () => {
    const statuses: CaStatus[] = ['estimated', 'announced', 'confirmed', 'paid', 'cancelled'];
    const applied = statuses.map(
      (status) =>
        adjustmentFactors(
          ACTIONS.map((action) => ({ ...action, status })),
          CLOSES,
          'total_return',
        ).length,
    );
    expect(applied).toEqual([0, 2, 2, 2, 0]);
  });

  it('handles a reverse split and a stock dividend from the same ratio columns', () => {
    const [reverse] = adjustmentFactors(
      [{ caType: 'reverse_split', status: 'confirmed', exDate: '2026-04-01', ratioNew: 1, ratioOld: 10 }],
      CLOSES,
      'price',
    );
    expect(reverse!.priceFactor).toBe(10);
    expect(Math.abs(reverse!.volumeFactor - 0.1)).toBeLessThanOrEqual(1e-12);

    const [stock] = adjustmentFactors(
      [
        {
          caType: 'stock_dividend',
          status: 'confirmed',
          exDate: '2026-04-01',
          ratioNew: 105,
          ratioOld: 100,
        },
      ],
      CLOSES,
      'price',
    );
    expect(Math.abs(stock!.priceFactor - 100 / 105)).toBeLessThanOrEqual(1e-12);
  });

  it('ignores ca_types that carry no price factor (spinoff, merger, name_change)', () => {
    const noise: CaForAdjust[] = [
      { caType: 'spinoff', status: 'confirmed', exDate: '2026-04-01' },
      { caType: 'merger', status: 'confirmed', exDate: '2026-04-02' },
      { caType: 'name_change', status: 'confirmed', exDate: '2026-04-03' },
    ];
    expect(adjustmentFactors(noise, CLOSES, 'total_return')).toEqual([]);
  });
});

describe('applyAdjustment (TESTING §7.9 expected close series)', () => {
  const series = (policy: AdjustPolicy): Bar[] =>
    applyAdjustment(BARS, adjustmentFactors(ACTIONS, CLOSES, policy));

  it('applies strictly before the ex-date, cumulatively latest → earliest', () => {
    const tr = series('total_return');
    const closes = tr.map((bar) => bar.close);
    const expected = [49.5, 50.49, 50.49, 49.5, 49.5, 55.0];
    closes.forEach((close, i) => {
      expect(Math.abs(close - expected[i]!)).toBeLessThanOrEqual(1e-9);
    });
    // The ex-date bar itself is never adjusted by its own action.
    expect(Math.abs(series('price')[2]!.close - 51.0)).toBeLessThanOrEqual(1e-9);
  });

  it('scales open/high/low and volume with the same cumulative factors', () => {
    const price = series('price');
    const day1 = price[0]!;
    expect(Math.abs(day1.open - 49.5)).toBeLessThanOrEqual(1e-9); // 99.00 × 0.50
    expect(Math.abs(day1.high - 50.25)).toBeLessThanOrEqual(1e-9); // 100.50 × 0.50
    expect(Math.abs(day1.low - 49.25)).toBeLessThanOrEqual(1e-9); // 98.50 × 0.50
    expect(day1.volume).toBe(2_000_000); // 1,000,000 × 2
    expect(series('total_return')[0]!.volume).toBe(2_000_000);
    expect(series('unadjusted')[0]!.volume).toBe(1_000_000);
  });

  it('scales vwap and officialClose, and leaves a null volume null', () => {
    const [bar] = applyAdjustment(
      [{ date: '2026-03-06', open: 99, high: 100.5, low: 98.5, close: 100, volume: null, vwap: 99.5, officialClose: 100 }],
      adjustmentFactors(ACTIONS, CLOSES, 'price'),
    );
    expect(Math.abs(bar!.vwap! - 49.75)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(bar!.officialClose! - 50)).toBeLessThanOrEqual(1e-9);
    expect(bar!.volume).toBeNull();
  });

  it('never mutates the input bars (stored bars stay unadjusted)', () => {
    const before = JSON.stringify(BARS);
    applyAdjustment(BARS, adjustmentFactors(ACTIONS, CLOSES, 'total_return'));
    expect(JSON.stringify(BARS)).toBe(before);
  });

  it('the three policies are not interchangeable (+11.111111 % / +10 % / −45 %)', () => {
    const pct = (policy: AdjustPolicy): number => {
      const bars = series(policy);
      return (bars[bars.length - 1]!.close / bars[0]!.close - 1) * 100;
    };
    expect(Math.abs(pct('total_return') - 11.111111)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(pct('price') - 10.0)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(pct('unadjusted') - -45.0)).toBeLessThanOrEqual(1e-9);
    expect(new Set([pct('total_return'), pct('price'), pct('unadjusted')]).size).toBe(3);
  });

  it('handles an out-of-order bar series identically to a sorted one', () => {
    const steps = adjustmentFactors(ACTIONS, CLOSES, 'total_return');
    const shuffled = [BARS[3]!, BARS[0]!, BARS[5]!, BARS[2]!, BARS[4]!, BARS[1]!];
    const byDate = new Map(applyAdjustment(shuffled, steps).map((bar) => [bar.date, bar.close]));
    for (const bar of applyAdjustment(BARS, steps)) {
      expect(byDate.get(bar.date)).toBe(bar.close);
    }
  });
});

describe('totalReturnIndex', () => {
  it('equals the total_return series rebased to the first close, within 1e-9', () => {
    const tr = applyAdjustment(BARS, adjustmentFactors(ACTIONS, CLOSES, 'total_return'));
    const base = BARS[0]!.close;
    const rebased = tr.map((bar) => (bar.close / tr[0]!.close) * base);
    const index = totalReturnIndex(BARS, ACTIONS);
    expect(index).toHaveLength(BARS.length);
    index.forEach((point, i) => {
      expect(point.date).toBe(BARS[i]!.date);
      expect(Math.abs(point.value - rebased[i]!)).toBeLessThanOrEqual(1e-9);
    });
    // TESTING §7.9: the window total return is +11.111111 %.
    const last = index[index.length - 1]!.value;
    expect(Math.abs((last / index[0]!.value - 1) * 100 - 11.111111)).toBeLessThanOrEqual(1e-6);
  });

  it('accepts an explicit base (HP rebases to 1 at the first row of the window)', () => {
    const index = totalReturnIndex(BARS, ACTIONS, 1);
    expect(index[0]!.value).toBe(1);
    expect(Math.abs(index[index.length - 1]!.value - 1.1111111111111112)).toBeLessThanOrEqual(1e-9);
  });

  it('ignores cancelled and estimated cash actions', () => {
    const muted = ACTIONS.map((action) =>
      action.caType === 'cash_dividend' ? { ...action, status: 'cancelled' } : action,
    );
    const index = totalReturnIndex(BARS, muted);
    // Without the dividend the index is the split-adjusted price return: 55/50 − 1 = +10 %.
    expect(
      Math.abs((index[index.length - 1]!.value / index[0]!.value - 1) * 100 - 10),
    ).toBeLessThanOrEqual(1e-9);
  });

  it('is empty for an empty series and flat for a single bar', () => {
    expect(totalReturnIndex([], ACTIONS)).toEqual([]);
    expect(totalReturnIndex([BARS[0]!], ACTIONS)).toEqual([{ date: '2026-03-06', value: 100 }]);
  });
});

describe('cumulativeFactors (per-date cumulative price/volume factors)', () => {
  it('matches the cum-factor column of TESTING §7.9', () => {
    const steps = adjustmentFactors(ACTIONS, CLOSES, 'total_return');
    const factors = cumulativeFactors(
      BARS.map((bar) => bar.date),
      steps,
    );
    const expected = [0.495, 0.495, 0.99, 0.99, 1.0, 1.0];
    factors.forEach((f, i) => {
      expect(Math.abs(f.priceFactor - expected[i]!)).toBeLessThanOrEqual(1e-12);
    });
    // Volume carries only the split leg: 2 before the ex-date, 1 after.
    expect(factors.map((f) => f.volumeFactor)).toEqual([2, 2, 1, 1, 1, 1]);
  });
});
