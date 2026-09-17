// packages/core/test/analytics/swap/ois.test.ts — WP-02 (WORKPLAN L507-508, acceptance row L542):
// "par rate makes PV zero; DV01 vs finite difference; schedule honours SIFMA + modified following".
//
// Every pinned number comes from `fixtures/golden/analytics/swap/ois.json`, whose two cases were
// derived from the closed-form single-curve OIS identities on a curve whose discount factors are
// written out in the file — never from this engine's own output. The two structural assertions the
// acceptance row asks for (par rate → zero PV, DV01 → finite difference) are properties rather than
// pins, and are checked against a reprice, not against a stored number.
//
// The SIFMA roll the row demands is pinned twice over, in both directions of modified following:
//   • forward — 2027-12-24 is Christmas Day observed, a full SIFMA closure, so the first annual
//     roll of a swap starting 2026-12-24 pays on Monday 2027-12-27;
//   • backward — 2027-10-30 is a Saturday, and rolling forward would land on 2027-11-01, a new
//     month, so modified following rolls back to Friday 2027-10-29 instead.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { businessDaysInRange, daysBetween } from '../../../src/calendars/calendar.js';
import { SIFMA } from '../../../src/calendars/sifma.js';
import type { OisQuote } from '../../../src/analytics/curve/bootstrap.js';
import { bootstrapOisCurve } from '../../../src/analytics/curve/bootstrap.js';
import { makeCurve } from '../../../src/analytics/curve/curve.js';
import type { DfPoint } from '../../../src/analytics/curve/interp.js';
import type { OisSwapInputs, OisSwapOutputs } from '../../../src/analytics/swap/ois.js';
import {
  OIS_DEFAULT_NOTIONAL,
  compoundedOvernightRate,
  oisSwapAnnuity,
  oisSwapConventionsOf,
  oisSwapEngine,
  oisSwapParRate,
  oisSwapSchedule,
  valueOisSwap,
} from '../../../src/analytics/swap/ois.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The golden file (TESTING §7.1 record shape)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface GoldenCase {
  readonly id: string;
  readonly engine: string;
  readonly engineVersion: string;
  readonly inputs: Record<string, unknown>;
  readonly valuationTs: string;
  readonly expected: Record<string, number | string | boolean>;
  readonly tol: Record<string, number>;
  readonly source: string;
}

const GOLDEN = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../fixtures/golden/analytics/swap/ois.json', import.meta.url)),
    'utf8',
  ),
) as GoldenCase[];

function goldenCase(id: string): GoldenCase {
  const found = GOLDEN.find((c) => c.id === id);
  if (found === undefined) throw new Error(`golden case ${id} is missing from swap/ois.json`);
  return found;
}

const FLAT = goldenCase('swap.ois.5y.flat');
const SLOPED = goldenCase('swap.ois.3y.sloped.receiver');

function inputsOf(kase: GoldenCase): OisSwapInputs {
  return kase.inputs as unknown as OisSwapInputs;
}

function run(kase: GoldenCase): OisSwapOutputs {
  return oisSwapEngine(inputsOf(kase), kase.valuationTs).outputs;
}

/** The value of one `expected` key on the engine's output. */
function actualOf(out: OisSwapOutputs, key: string): number | string {
  const at = /^(\w+)@(\d+)$/.exec(key);
  if (at !== null) {
    const index = Number(at[2]) - 1;
    const period = out.schedule.periods[index];
    const float = out.floatLeg[index];
    if (period === undefined || float === undefined) {
      throw new Error(`${key}: the schedule has no period ${at[2]}`);
    }
    switch (at[1]) {
      case 'unadjustedEnd':
        return period.unadjustedEnd;
      case 'paymentDate':
        return period.paymentDate;
      case 'days':
        return period.days;
      case 'floatRate':
        return float.rate;
      case 'floatAmount':
        return float.amount;
      default:
        throw new Error(`${key}: unknown golden key`);
    }
  }
  switch (key) {
    case 'effectiveDate':
      return out.effectiveDate;
    case 'maturityDate':
      return out.maturityDate;
    case 'periodCount':
      return out.schedule.periods.length;
    case 'annuity':
      return out.annuity;
    case 'parRate':
      return out.parRate;
    case 'pv':
      return out.pv;
    case 'fixedLegPv':
      return out.fixedLegPv;
    case 'floatLegPv':
      return out.floatLegPv;
    case 'dv01':
      return out.dv01;
    case 'curveDv01':
      return out.curveDv01;
    default:
      throw new Error(`${key}: unknown golden key`);
  }
}

/** Shift every knot by a parallel continuous zero move of `s`: `df(t) → df(t)·e^(−s·t)`. */
function shiftedPoints(points: readonly DfPoint[], s: number): DfPoint[] {
  return points.map((p) => ({ t: p.t, df: p.df * Math.exp(-s * p.t) }));
}

function curveOf(kase: GoldenCase, shift = 0): ReturnType<typeof makeCurve> {
  const inputs = inputsOf(kase);
  return makeCurve({
    curveId: 'SOFR_OIS',
    curveDate: inputs.curveDate,
    dayCount: 'ACT/360',
    compounding: 'continuous',
    interpolation: 'log_linear_df',
    points: shift === 0 ? inputs.curve.points : shiftedPoints(inputs.curve.points, shift),
  });
}

function scheduleOf(kase: GoldenCase): ReturnType<typeof oisSwapSchedule> {
  const inputs = inputsOf(kase);
  return oisSwapSchedule(
    inputs.curveDate,
    inputs.tenor === undefined ? {} : { tenor: inputs.tenor },
    oisSwapConventionsOf(inputs),
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The golden cases
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('swap.ois golden cases (QA-01)', () => {
  for (const kase of GOLDEN) {
    it(`${kase.id} matches every pinned value`, () => {
      expect(kase.engine).toBe('swap.ois');
      expect(kase.engineVersion).toBe(oisSwapEngine.version);
      const out = run(kase);
      for (const [key, expected] of Object.entries(kase.expected)) {
        const actual = actualOf(out, key);
        if (typeof expected === 'string') {
          expect(actual, `${kase.id}.${key}`).toBe(expected);
          continue;
        }
        if (typeof expected !== 'number' || typeof actual !== 'number') {
          throw new Error(`${kase.id}.${key}: expected a number, got ${String(expected)}`);
        }
        const tol = kase.tol[key];
        if (typeof tol !== 'number') throw new Error(`${kase.id}.tol.${key} is missing`);
        const error = Math.abs(actual - expected);
        if (!(error <= tol)) {
          throw new Error(
            `${kase.id}.${key}: got ${String(actual)}, pinned ${String(expected)}, ` +
              `|Δ| = ${String(error)} > ${String(tol)}`,
          );
        }
        expect(error).toBeLessThanOrEqual(tol);
      }
    });
  }

  it('echoes its conventions — ACT/360, annual, T+2, modified following, SIFMA (ANAL-07)', () => {
    const out = run(FLAT);
    expect(out.conventions).toMatchObject({
      dayCount: 'ACT/360',
      businessDayConvention: 'modified_following',
      calendar: 'SIFMA',
      frequency: 1,
      settlementDays: 2,
      floatCompounding: 'daily',
      index: 'SOFR',
      currency: 'USD',
    });
  });

  it('carries the ANAL-08 envelope: a stable inputsHash that every input moves', () => {
    const a = oisSwapEngine(inputsOf(FLAT), FLAT.valuationTs);
    const b = oisSwapEngine(inputsOf(FLAT), FLAT.valuationTs);
    expect(a.engine).toEqual({ name: 'swap.ois', version: '1.0.0' });
    expect(a.inputsHash).toBe(b.inputsHash);
    expect(a.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    const bumped = oisSwapEngine(
      { ...inputsOf(FLAT), fixedRate: inputsOf(FLAT).fixedRate + 1e-9 },
      FLAT.valuationTs,
    );
    expect(bumped.inputsHash).not.toBe(a.inputsHash);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The par rate makes PV zero (WORKPLAN L542)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the par rate makes PV zero', () => {
  for (const kase of GOLDEN) {
    it(`${kase.id}: repricing at the engine's own par rate leaves nothing`, () => {
      const out = run(kase);
      const inputs = inputsOf(kase);
      const notional = inputs.notional ?? OIS_DEFAULT_NOTIONAL;
      const atPar = valueOisSwap(curveOf(kase), scheduleOf(kase), {
        fixedRate: out.parRate,
        notional,
        ...(inputs.payReceive === undefined ? {} : { payReceive: inputs.payReceive }),
      });
      // 1e-16 of notional: the par rate is an exact quotient, so all that is left is the rounding
      // of one multiplication per period.
      expect(Math.abs(atPar.pv)).toBeLessThan(notional * 1e-15);
      // And the par rate is genuinely a fixed point of the reprice.
      expect(atPar.parRate).toBeCloseTo(out.parRate, 12);
    });
  }

  it('PV is linear in the fixed rate with slope −annuity·notional (payer)', () => {
    const curve = curveOf(FLAT);
    const schedule = scheduleOf(FLAT);
    const notional = 100_000_000;
    const par = oisSwapParRate(curve, schedule);
    const annuity = oisSwapAnnuity(curve, schedule);
    for (const bump of [-2, -0.5, 0.25, 1.5]) {
      const v = valueOisSwap(curve, schedule, { fixedRate: par + bump, notional });
      // 1e-4 of a dollar on a $100 mm ticket — the same bound the golden file uses, and for the
      // same reason: the float leg is a product of ~1,300 daily factors, not a closed form.
      expect(Math.abs(v.pv - (-bump / 100) * annuity * notional)).toBeLessThan(1e-4);
    }
  });

  it('a receiver is the exact negative of the payer on the same ticket', () => {
    const curve = curveOf(SLOPED);
    const schedule = scheduleOf(SLOPED);
    const ticket = { fixedRate: 3.5, notional: 250_000_000 } as const;
    const payer = valueOisSwap(curve, schedule, { ...ticket, payReceive: 'pay' });
    const receiver = valueOisSwap(curve, schedule, { ...ticket, payReceive: 'receive' });
    expect(receiver.pv).toBe(-payer.pv);
    expect(receiver.curveDv01).toBe(-payer.curveDv01);
    expect(receiver.dv01).toBe(payer.dv01);
    expect(receiver.parRate).toBe(payer.parRate);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. DV01 against a finite-difference reprice (WORKPLAN L542)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('DV01 against a finite-difference reprice', () => {
  for (const kase of GOLDEN) {
    it(`${kase.id}: the fixed-rate DV01 is the reprice at ±1bp`, () => {
      const out = run(kase);
      const inputs = inputsOf(kase);
      const curve = curveOf(kase);
      const schedule = scheduleOf(kase);
      const ticket = {
        notional: inputs.notional ?? OIS_DEFAULT_NOTIONAL,
        ...(inputs.payReceive === undefined ? {} : { payReceive: inputs.payReceive }),
      };
      const up = valueOisSwap(curve, schedule, { ...ticket, fixedRate: inputs.fixedRate + 0.01 });
      const down = valueOisSwap(curve, schedule, { ...ticket, fixedRate: inputs.fixedRate - 0.01 });
      // PV is exactly linear in the fixed rate, so the central difference is the derivative to
      // floating-point rounding: pin it at 1e-9 of the DV01 itself.
      const fd = Math.abs((up.pv - down.pv) / 2);
      expect(Math.abs(fd - out.dv01)).toBeLessThan(out.dv01 * 1e-9);
      // The annuity identity SWPM shows next to it.
      expect(out.dv01).toBeCloseTo(ticket.notional * out.annuity * 1e-4, 9);
    });

    it(`${kase.id}: the curve DV01 is the reprice under a ±0.5bp parallel shift`, () => {
      const out = run(kase);
      const inputs = inputsOf(kase);
      const schedule = scheduleOf(kase);
      const ticket = {
        fixedRate: inputs.fixedRate,
        notional: inputs.notional ?? OIS_DEFAULT_NOTIONAL,
        ...(inputs.payReceive === undefined ? {} : { payReceive: inputs.payReceive }),
      };
      const bp = 1e-4;
      const up = valueOisSwap(curveOf(kase, bp / 2), schedule, ticket);
      const down = valueOisSwap(curveOf(kase, -bp / 2), schedule, ticket);
      const fd = up.pv - down.pv;
      // A central difference of a smooth function over one basis point: the truncation error is
      // O(h²·PV''') ≈ 1e-8 relative, so 1e-6 relative is the honest bound.
      expect(Math.abs(fd - out.curveDv01)).toBeLessThan(Math.abs(out.curveDv01) * 1e-6);
      // A payer gains when the curve sells off; a receiver loses.
      expect(Math.sign(out.curveDv01)).toBe(inputs.payReceive === 'receive' ? -1 : 1);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. The schedule honours SIFMA + modified following (WORKPLAN L542)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the schedule honours SIFMA and modified following', () => {
  it('starts T+2 on SIFMA', () => {
    const out = run(FLAT);
    expect(out.effectiveDate).toBe('2026-12-24');
    // Two SIFMA business days after the curve date, no more and no less.
    expect(businessDaysInRange(SIFMA, '2026-12-23', '2026-12-24')).toEqual([
      '2026-12-23',
      '2026-12-24',
    ]);
    // 2026-12-24 is a SIFMA *early close*, which is still a business day (REF-06).
    expect(SIFMA.isBusinessDay('2026-12-24')).toBe(true);
    expect(SIFMA.earlyClose('2026-12-24')?.name).toBe('Christmas Eve');
  });

  it('rolls the 2027-12-24 anniversary forward off Christmas Day to 2027-12-27', () => {
    // The holiday itself: Christmas Day 2027 is a Saturday, observed on Friday 2027-12-24.
    expect(SIFMA.isBusinessDay('2027-12-24')).toBe(false);
    expect(SIFMA.holidayName('2027-12-24')).toBe('Christmas Day');
    // Modified following stays inside December, so the roll is forward to the Monday.
    const out = run(FLAT);
    const first = out.schedule.periods[0];
    expect(first?.unadjustedEnd).toBe('2027-12-24');
    expect(first?.accrualEnd).toBe('2027-12-27');
    expect(first?.paymentDate).toBe('2027-12-27');
    expect(first?.days).toBe(368);
    expect(first?.accrual).toBe(368 / 360);
    // The second period then accrues *from the adjusted* date, not from the anniversary.
    const second = out.schedule.periods[1];
    expect(second?.accrualStart).toBe('2027-12-27');
    expect(second?.unadjustedEnd).toBe('2028-12-24');
    // 2028-12-24 is a Sunday and 2028-12-25 is Christmas Day, so the roll lands on the Tuesday.
    expect(SIFMA.isWeekend('2028-12-24')).toBe(true);
    expect(SIFMA.holidayName('2028-12-25')).toBe('Christmas Day');
    expect(second?.accrualEnd).toBe('2028-12-26');
  });

  it('rolls backwards when following would leave the month', () => {
    // 2027-10-30 is a Saturday; the next business day is Monday 2027-11-01, a new month, so
    // modified following takes the preceding business day instead.
    const schedule = oisSwapSchedule(
      '2026-10-28',
      { effectiveDate: '2026-10-30', tenor: '2Y' },
      oisSwapConventionsOf({}),
    );
    const first = schedule.periods[0];
    expect(SIFMA.isBusinessDay('2026-10-30')).toBe(true);
    expect(first?.unadjustedEnd).toBe('2027-10-30');
    expect(SIFMA.isWeekend('2027-10-30')).toBe(true);
    expect(first?.accrualEnd).toBe('2027-10-29');
    expect(first?.paymentDate).toBe('2027-10-29');
    // And the following year's anniversary is taken from the unadjusted effective date again,
    // so a single backward roll does not shorten every later period.
    expect(schedule.periods[1]?.unadjustedEnd).toBe('2028-10-30');
    expect(schedule.periods[1]?.accrualEnd).toBe('2028-10-30');
    expect(schedule.maturityDate).toBe('2028-10-30');
  });

  it('every schedule date is a SIFMA business day and the periods tile the swap', () => {
    for (const kase of GOLDEN) {
      const out = run(kase);
      let previousEnd = out.effectiveDate;
      let totalDays = 0;
      for (const period of out.schedule.periods) {
        expect(SIFMA.isBusinessDay(period.accrualEnd)).toBe(true);
        expect(SIFMA.isBusinessDay(period.paymentDate)).toBe(true);
        expect(period.accrualStart).toBe(previousEnd);
        totalDays += period.days;
        previousEnd = period.accrualEnd;
      }
      expect(previousEnd).toBe(out.maturityDate);
      expect(totalDays).toBe(daysBetween(out.effectiveDate, out.maturityDate));
    }
  });

  it('a payment lag discounts past the accrual end', () => {
    const conventions = { ...oisSwapConventionsOf({}), paymentLagDays: 2 };
    const schedule = oisSwapSchedule('2026-12-22', { tenor: '1Y' }, conventions);
    const period = schedule.periods[0];
    expect(period?.accrualEnd).toBe('2027-12-27');
    expect(period?.paymentDate).toBe('2027-12-29');
    const lagged = valueOisSwap(curveOf(FLAT), schedule, { fixedRate: 3.75, notional: 1e8 });
    const unlagged = valueOisSwap(
      curveOf(FLAT),
      oisSwapSchedule('2026-12-22', { tenor: '1Y' }, oisSwapConventionsOf({})),
      { fixedRate: 3.75, notional: 1e8 },
    );
    // Two extra days of discounting on a positive-carry payer: the annuity shrinks.
    expect(lagged.annuity).toBeLessThan(unlagged.annuity);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. The float leg really is compounded daily
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the daily-compounded float leg', () => {
  it('compounds one business-day observation per business day of the period', () => {
    const curve = curveOf(SLOPED);
    const schedule = scheduleOf(SLOPED);
    for (const period of schedule.periods) {
      const compounded = compoundedOvernightRate(
        curve,
        SIFMA,
        schedule.curveDate,
        period.accrualStart,
        period.accrualEnd,
      );
      const businessDays = businessDaysInRange(SIFMA, period.accrualStart, period.accrualEnd).filter(
        (d) => d !== period.accrualEnd,
      );
      expect(compounded.observations).toBe(businessDays.length);
      expect(compounded.observations).toBeGreaterThan(240);
    }
  });

  it('telescopes to df(start)/df(end) — the closed form the golden file uses', () => {
    const curve = curveOf(SLOPED);
    const schedule = scheduleOf(SLOPED);
    const t = (d: string): number => daysBetween(schedule.curveDate, d) / 360;
    for (const period of schedule.periods) {
      const compounded = compoundedOvernightRate(
        curve,
        SIFMA,
        schedule.curveDate,
        period.accrualStart,
        period.accrualEnd,
      );
      const closed = curve.df(t(period.accrualStart)) / curve.df(t(period.accrualEnd));
      // ~250 multiplications of doubles: a few units in the fifteenth digit.
      expect(Math.abs(compounded.factor - closed)).toBeLessThan(closed * 1e-13);
    }
  });

  it('a weekend observation accrues over three days at the overnight forward', () => {
    const curve = curveOf(FLAT);
    const collected: { date: string; days: number; rate: number }[] = [];
    compoundedOvernightRate(curve, SIFMA, '2026-12-22', '2026-12-24', '2027-01-05', collected);
    const friday = collected.find((o) => o.date === '2026-12-31');
    // 2026-12-31 (Thursday) is followed by New Year's Day, a SIFMA closure, then the weekend:
    // the observation runs to Monday 2027-01-04, four calendar days.
    expect(friday?.days).toBe(4);
    for (const o of collected) {
      // A flat 4 % continuous curve implies an ACT/360 simple overnight of 4.00022 %.
      expect(o.rate).toBeGreaterThan(0.04);
      expect(o.rate).toBeLessThan(0.0401);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 6. The engine agrees with the curve it was bootstrapped from
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('a swap priced on a bootstrapped OIS curve reprices its own quote', () => {
  const quotes: OisQuote[] = [
    { tenor: '1Y', parRate: 4.1 },
    { tenor: '2Y', parRate: 4.0 },
    { tenor: '3Y', parRate: 3.9 },
    { tenor: '5Y', parRate: 3.8 },
    { tenor: '10Y', parRate: 3.85 },
  ];

  it('the par rate of each quoted tenor comes back to the quote', () => {
    const built = bootstrapOisCurve(
      {
        curveId: 'SOFR_OIS',
        curveDate: '2026-09-15',
        fixings: [{ date: '2026-09-15', rate: 4.31 }],
        quotes,
        interpolation: 'log_linear_df',
      },
      '2026-09-15T20:00:00Z',
    );
    const curve = built.outputs.curve;
    for (const quote of quotes) {
      const schedule = oisSwapSchedule(
        '2026-09-15',
        { tenor: quote.tenor },
        oisSwapConventionsOf({}),
      );
      const par = oisSwapParRate(curve, schedule);
      expect(Math.abs(par - quote.parRate)).toBeLessThan(1e-9);
      const atQuote = valueOisSwap(curve, schedule, {
        fixedRate: quote.parRate,
        notional: 100_000_000,
      });
      // A swap struck at the quote is worth nothing: well inside a cent on $100 mm.
      expect(Math.abs(atQuote.pv)).toBeLessThan(0.01);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 7. Input validation
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('swap.ois rejects what it cannot value', () => {
  it('refuses a tenor that is not a whole number of fixed periods', () => {
    expect(() =>
      oisSwapSchedule('2026-09-15', { tenor: '18M' }, oisSwapConventionsOf({ fixedFrequency: 1 })),
    ).toThrow(/whole number of 1\/yr fixed periods/);
  });

  it('accepts 18M once the fixed leg is semiannual', () => {
    const schedule = oisSwapSchedule(
      '2026-09-15',
      { tenor: '18M' },
      oisSwapConventionsOf({ fixedFrequency: 2 }),
    );
    expect(schedule.periods).toHaveLength(3);
    expect(schedule.maturityDate).toBe('2028-03-17');
  });

  it('refuses a swap that started before the curve date — it would need its fixings', () => {
    expect(() =>
      oisSwapSchedule(
        '2026-09-15',
        { effectiveDate: '2026-06-15', tenor: '2Y' },
        oisSwapConventionsOf({}),
      ),
    ).toThrow(/before the curve date/);
  });

  it('refuses a ticket with neither tenor nor maturity', () => {
    expect(() => oisSwapSchedule('2026-09-15', {}, oisSwapConventionsOf({}))).toThrow(
      /one of tenor or maturityDate/,
    );
  });

  it('accepts an explicit maturity date', () => {
    const schedule = oisSwapSchedule(
      '2026-09-15',
      { maturityDate: '2029-09-17' },
      oisSwapConventionsOf({}),
    );
    expect(schedule.periods).toHaveLength(3);
    expect(schedule.maturityDate).toBe('2029-09-17');
  });
});
