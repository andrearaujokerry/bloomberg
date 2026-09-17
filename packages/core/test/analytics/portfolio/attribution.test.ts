// packages/core/test/analytics/portfolio/attribution.test.ts — WP-02 (WORKPLAN L516, L549):
// "Brinson-Fachler allocation + selection + interaction = total active return" (PORT-03).
//
// The acceptance criterion is an *identity*, not an approximation, so this file asserts it with
// `toBe` — bit-for-bit equality — on a hand-computed two-sector example whose every weight and
// return is a dyadic rational (3/4, 1/4, 1/2, 1/8, 1/16, 1/32). Products and sums of small dyadic
// rationals are exact in IEEE-754 double precision, so there is no rounding to hide behind: if the
// decomposition were wrong by a single ulp the test would fail.
//
// The two-sector arithmetic, in full (it is also the `source` line of the golden file):
//
//   sector                 wP     rP       wB     rB
//   Information Technology 0.75   0.125    0.50   0.0625
//   Utilities              0.25  -0.0625   0.50  -0.03125
//
//   R_P = 0.75x0.125 + 0.25x(-0.0625) =  0.09375 - 0.015625 = 0.078125
//   R_B = 0.50x0.0625 + 0.50x(-0.03125) = 0.03125 - 0.015625 = 0.015625
//   active = 0.078125 - 0.015625 = 0.0625
//
//   allocation  = (0.25)(0.0625-0.015625) + (-0.25)(-0.03125-0.015625) = 0.01171875 + 0.01171875
//               = 0.0234375
//   selection   = 0.50(0.125-0.0625) + 0.50(-0.0625+0.03125) = 0.03125 - 0.015625 = 0.015625
//   interaction = 0.25(0.0625) + (-0.25)(-0.03125) = 0.015625 + 0.0078125 = 0.0234375
//   sum         = 0.0234375 + 0.015625 + 0.0234375 = 0.0625 = active

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ATTRIBUTION_CONVENTIONS,
  attributionEngine,
  brinsonFachler,
  resolveAttributionConventions,
  segmentsFromHoldings,
} from '../../../src/analytics/portfolio/attribution.js';
import type {
  AttributionConventionOverrides,
  AttributionSegment,
} from '../../../src/analytics/portfolio/attribution.js';

// ---------------------------------------------------------------------------------------------
// The hand-computed example
// ---------------------------------------------------------------------------------------------

const TWO_SECTOR: readonly AttributionSegment[] = [
  {
    segment: 'Information Technology',
    portfolioWeight: 0.75,
    portfolioReturn: 0.125,
    benchmarkWeight: 0.5,
    benchmarkReturn: 0.0625,
  },
  {
    segment: 'Utilities',
    portfolioWeight: 0.25,
    portfolioReturn: -0.0625,
    benchmarkWeight: 0.5,
    benchmarkReturn: -0.03125,
  },
];

/** Every number the comment block above derives, as a literal. */
const PIN = {
  portfolioReturn: 0.078125,
  benchmarkReturn: 0.015625,
  activeReturn: 0.0625,
  allocation: 0.0234375,
  selection: 0.015625,
  interaction: 0.0234375,
  techAllocation: 0.01171875,
  utilAllocation: 0.01171875,
  techSelection: 0.03125,
  utilSelection: -0.015625,
  techInteraction: 0.015625,
  utilInteraction: 0.0078125,
} as const;

const VALUATION_TS = '2026-06-30T20:00:00Z';

describe('Brinson-Fachler on the hand-computed two-sector example (PORT-03)', () => {
  const result = brinsonFachler(TWO_SECTOR);

  it('reproduces the portfolio, benchmark and active returns exactly', () => {
    expect(result.portfolioReturn).toBe(PIN.portfolioReturn);
    expect(result.benchmarkReturn).toBe(PIN.benchmarkReturn);
    expect(result.activeReturn).toBe(PIN.activeReturn);
    expect(result.portfolioWeightSum).toBe(1);
    expect(result.benchmarkWeightSum).toBe(1);
  });

  it('reproduces each segment effect exactly', () => {
    const [tech, util] = result.segments;
    expect(tech?.segment).toBe('Information Technology');
    expect(util?.segment).toBe('Utilities');

    expect(tech?.activeWeight).toBe(0.25);
    expect(util?.activeWeight).toBe(-0.25);
    expect(tech?.activeReturn).toBe(0.0625);
    expect(util?.activeReturn).toBe(-0.03125);

    expect(tech?.allocation).toBe(PIN.techAllocation);
    expect(util?.allocation).toBe(PIN.utilAllocation);
    expect(tech?.selection).toBe(PIN.techSelection);
    expect(util?.selection).toBe(PIN.utilSelection);
    expect(tech?.interaction).toBe(PIN.techInteraction);
    expect(util?.interaction).toBe(PIN.utilInteraction);
  });

  it('totals the three effects exactly', () => {
    expect(result.allocation).toBe(PIN.allocation);
    expect(result.selection).toBe(PIN.selection);
    expect(result.interaction).toBe(PIN.interaction);
  });

  // The acceptance criterion, WORKPLAN L549.
  it('allocation + selection + interaction equals the total active return exactly', () => {
    expect(result.allocation + result.selection + result.interaction).toBe(result.activeReturn);
    expect(result.total).toBe(result.activeReturn);
    expect(result.residual).toBe(0);
    expect(result.total).toBe(PIN.activeReturn);
  });

  it('the identity also holds segment by segment: total = wP rP - wB rB - activeWeight x R_B', () => {
    for (const s of result.segments) {
      expect(s.allocation + s.selection + s.interaction).toBe(s.total);
      expect(s.total).toBe(
        s.portfolioContribution - s.benchmarkContribution - s.activeWeight * result.benchmarkReturn,
      );
    }
    const summed = result.segments.reduce((acc, s) => acc + s.total, 0);
    expect(summed).toBe(result.activeReturn);
  });
});

// ---------------------------------------------------------------------------------------------
// The identity is not an accident of this one example
// ---------------------------------------------------------------------------------------------

describe('the identity holds for every shape of book', () => {
  /** A sector the portfolio does not hold at all — the case Fachler's `(rB_i - R_B)` prices. */
  const UNHELD: readonly AttributionSegment[] = [
    {
      segment: 'Energy',
      portfolioWeight: 0,
      portfolioReturn: 0,
      benchmarkWeight: 0.25,
      benchmarkReturn: 0.25,
    },
    {
      segment: 'Information Technology',
      portfolioWeight: 0.75,
      portfolioReturn: 0.125,
      benchmarkWeight: 0.5,
      benchmarkReturn: 0.0625,
    },
    {
      segment: 'Utilities',
      portfolioWeight: 0.25,
      portfolioReturn: -0.0625,
      benchmarkWeight: 0.25,
      benchmarkReturn: -0.03125,
    },
  ];

  it('an unheld benchmark sector still balances exactly', () => {
    const r = brinsonFachler(UNHELD);
    expect(r.benchmarkReturn).toBe(0.0859375);
    expect(r.activeReturn).toBe(-0.0078125);
    expect(r.allocation).toBe(-0.046875);
    expect(r.selection).toBe(-0.0390625);
    expect(r.interaction).toBe(0.078125);
    expect(r.total).toBe(r.activeReturn);
    expect(r.residual).toBe(0);
  });

  it('a short (negative-weight) sector still balances', () => {
    const shortBook: readonly AttributionSegment[] = [
      {
        segment: 'Information Technology',
        portfolioWeight: 1.25,
        portfolioReturn: 0.125,
        benchmarkWeight: 0.5,
        benchmarkReturn: 0.0625,
      },
      {
        segment: 'Utilities',
        portfolioWeight: -0.25,
        portfolioReturn: -0.0625,
        benchmarkWeight: 0.5,
        benchmarkReturn: -0.03125,
      },
    ];
    const r = brinsonFachler(shortBook);
    expect(r.portfolioWeightSum).toBe(1);
    expect(r.total).toBe(r.activeReturn);
    expect(r.residual).toBe(0);
  });

  it('a one-segment book puts everything in selection and nothing anywhere else', () => {
    const r = brinsonFachler([
      {
        segment: 'All',
        portfolioWeight: 1,
        portfolioReturn: 0.0625,
        benchmarkWeight: 1,
        benchmarkReturn: 0.03125,
      },
    ]);
    expect(r.allocation).toBe(0);
    expect(r.interaction).toBe(0);
    expect(r.selection).toBe(0.03125);
    expect(r.total).toBe(r.activeReturn);
  });

  it('a portfolio identical to its benchmark has zero of everything', () => {
    const r = brinsonFachler(
      TWO_SECTOR.map((s) => ({
        ...s,
        portfolioWeight: s.benchmarkWeight,
        portfolioReturn: s.benchmarkReturn,
      })),
    );
    expect(r.activeReturn).toBe(0);
    expect(r.allocation).toBe(0);
    expect(r.selection).toBe(0);
    expect(r.interaction).toBe(0);
    expect(r.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Brinson-Hood-Beebower: a different allocation split, the same total
// ---------------------------------------------------------------------------------------------

describe('the model switch changes the split, never the total', () => {
  it('BHB allocation is (wP-wB) x rB and the three terms still sum to active return', () => {
    const bhb = brinsonFachler(TWO_SECTOR, { model: 'brinson-hood-beebower' });
    const [tech, util] = bhb.segments;
    expect(tech?.allocation).toBe(0.25 * 0.0625); // 0.015625
    expect(util?.allocation).toBe(-0.25 * -0.03125); // 0.0078125
    expect(bhb.total).toBe(bhb.activeReturn);
    expect(bhb.residual).toBe(0);
    // Selection and interaction are model-independent; only allocation is re-based.
    const bf = brinsonFachler(TWO_SECTOR);
    expect(bhb.selection).toBe(bf.selection);
    expect(bhb.interaction).toBe(bf.interaction);
    expect(bhb.allocation).toBe(bf.allocation); // equal here only because sum(wP-wB) = 0
    expect(tech?.allocation).not.toBe(bf.segments[0]?.allocation);
  });
});

// ---------------------------------------------------------------------------------------------
// Conventions are echoed (ANAL-07), and bad input is refused
// ---------------------------------------------------------------------------------------------

describe('conventions and validation', () => {
  it('echoes the convention set in the outputs (ANAL-07)', () => {
    const r = brinsonFachler(TWO_SECTOR, { segmentBasis: 'security' });
    expect(r.conventions.model).toBe('brinson-fachler');
    expect(r.conventions.segmentBasis).toBe('security');
    expect(r.conventions.allocationFormula).toBe('allocation_i = (wP_i − wB_i) × (rB_i − R_B)');
    expect(r.conventions.selectionFormula).toBe('selection_i = wB_i × (rP_i − rB_i)');
    expect(r.conventions.interactionFormula).toBe('interaction_i = (wP_i − wB_i) × (rP_i − rB_i)');
    expect(r.conventions.linking).toContain('single-period');
    expect(r.conventions.returns).toBe('simple');
    // The two documented PORT-03 gaps are stated, not silently absent.
    expect(r.conventions.fixedIncomeAttribution).toContain('FI_ATTRIBUTION_UNAVAILABLE');
    expect(r.conventions.currencyAttribution).toContain('CCY_ATTRIBUTION_UNAVAILABLE');
  });

  it('the BHB allocation formula is echoed when that model is chosen', () => {
    expect(
      resolveAttributionConventions({ model: 'brinson-hood-beebower' }).allocationFormula,
    ).toBe('allocation_i = (wP_i − wB_i) × rB_i');
    expect(DEFAULT_ATTRIBUTION_CONVENTIONS.model).toBe('brinson-fachler');
  });

  it('refuses a weight column that does not sum to one, because the identity would break', () => {
    const bad = TWO_SECTOR.map((s, i) => (i === 0 ? { ...s, portfolioWeight: 0.7 } : s));
    expect(() => brinsonFachler(bad)).toThrow(/portfolio weights sum to/);
    // ... and says so, rather than returning a wrong decomposition.
    const r = brinsonFachler(bad, { requireWeightsSumToOne: false });
    expect(r.portfolioWeightSum).toBeCloseTo(0.95, 12);
    expect(Math.abs(r.residual)).toBeGreaterThan(0); // the R_B x (sum wP - sum wB) term survives
  });

  it('rejects an empty book, duplicate segments and non-finite inputs', () => {
    expect(() => brinsonFachler([])).toThrow(/at least one segment/);
    expect(() => brinsonFachler([TWO_SECTOR[0]!, TWO_SECTOR[0]!])).toThrow(/duplicate segment/);
    expect(() => brinsonFachler([{ ...TWO_SECTOR[0]!, portfolioReturn: Number.NaN }])).toThrow(
      /must be a finite number/,
    );
    expect(() => brinsonFachler(TWO_SECTOR, { model: 'bogus' as never })).toThrow(
      /must be 'brinson-fachler' or 'brinson-hood-beebower'/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Rolling holdings up into segments
// ---------------------------------------------------------------------------------------------

describe('segmentsFromHoldings', () => {
  it('weight-weights member returns so the rolled-up book has the same active return', () => {
    const segments = segmentsFromHoldings(
      [
        { segment: 'Information Technology', weight: 0.5, return: 0.125 },
        { segment: 'Information Technology', weight: 0.25, return: 0.125 },
        { segment: 'Utilities', weight: 0.25, return: -0.0625 },
      ],
      [
        { segment: 'Information Technology', weight: 0.5, return: 0.0625 },
        { segment: 'Utilities', weight: 0.5, return: -0.03125 },
      ],
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]?.segment).toBe('Information Technology');
    expect(segments[0]?.portfolioWeight).toBe(0.75);
    expect(segments[0]?.portfolioReturn).toBe(0.125);
    const r = brinsonFachler(segments);
    expect(r.activeReturn).toBe(PIN.activeReturn);
    expect(r.total).toBe(r.activeReturn);
  });

  it('gives a segment held on one side only a zero weight and a zero return on the other', () => {
    const segments = segmentsFromHoldings(
      [{ segment: 'Tech', weight: 1, return: 0.125 }],
      [
        { segment: 'Tech', weight: 0.75, return: 0.0625 },
        { segment: 'Energy', weight: 0.25, return: 0.25 },
      ],
    );
    expect(segments.map((s) => s.segment)).toEqual(['Energy', 'Tech']);
    expect(segments[0]?.portfolioWeight).toBe(0);
    expect(segments[0]?.portfolioReturn).toBe(0);
    expect(brinsonFachler(segments).residual).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The engine and the golden file
// ---------------------------------------------------------------------------------------------

interface GoldenCase {
  id: string;
  engine: string;
  engineVersion: string;
  inputs: {
    segments: AttributionSegment[];
    conventions?: AttributionConventionOverrides;
  };
  valuationTs: string;
  expected: Record<string, number | string | boolean>;
  tol: Record<string, number>;
  source: string;
}

const GOLDEN_PATH = fileURLToPath(
  new URL('../../../../../fixtures/golden/analytics/portfolio/attribution.json', import.meta.url),
);
const GOLDEN = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenCase[];

function within(actual: number, expected: number, tol: number, label: string): void {
  const diff = Math.abs(actual - expected);
  expect(diff <= tol, `${label}: |${actual} − ${expected}| = ${diff} exceeds ${tol}`).toBe(true);
}

describe('portfolio/attribution engine (ANAL-08) and its golden file', () => {
  it('runs through defineEngine with a stable inputsHash', () => {
    const inputs = { segments: TWO_SECTOR } as const;
    const a = attributionEngine(inputs, VALUATION_TS);
    const b = attributionEngine({ segments: [...TWO_SECTOR] }, VALUATION_TS);
    expect(a.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.inputsHash).toBe(a.inputsHash);
    expect(a.engine).toEqual({ name: 'portfolio/attribution', version: '1.0.0' });
    expect(a.valuationTs).toBe(VALUATION_TS);
    expect(a.outputs.total).toBe(a.outputs.activeReturn);
    const changed = attributionEngine(
      { segments: TWO_SECTOR.map((s, i) => (i === 0 ? { ...s, portfolioReturn: 0.25 } : s)) },
      VALUATION_TS,
    );
    expect(changed.inputsHash).not.toBe(a.inputsHash);
  });

  it('covers the golden file', () => {
    expect(GOLDEN.map((c) => c.id)).toEqual([
      'portfolio.attribution.twoSector',
      'portfolio.attribution.unheldSector',
    ]);
    for (const c of GOLDEN) {
      expect(c.engine).toBe('portfolio/attribution');
      expect(c.engineVersion).toBe(attributionEngine.version);
      expect(c.source.length).toBeGreaterThan(0);
      expect(Object.keys(c.tol).sort()).toEqual(Object.keys(c.expected).sort());
    }
    // The golden's first case is the file's own hand-computed example.
    expect(GOLDEN[0]?.inputs.segments).toEqual(TWO_SECTOR);
  });

  it.each(GOLDEN.map((c) => [c.id, c] as const))('golden case %s', (_id, c) => {
    const result = attributionEngine(
      {
        segments: c.inputs.segments,
        ...(c.inputs.conventions === undefined ? {} : { conventions: c.inputs.conventions }),
      },
      c.valuationTs,
    );
    const outputs = result.outputs as unknown as Record<string, unknown>;
    for (const [key, expected] of Object.entries(c.expected)) {
      const actual = outputs[key];
      if (typeof expected === 'number') {
        expect(typeof actual, `${c.id}.${key} should be numeric`).toBe('number');
        within(actual as number, expected, c.tol[key] ?? 0, `${c.id}.${key}`);
      } else {
        expect(actual, `${c.id}.${key}`).toBe(expected);
      }
    }
    // Every golden tolerance here is 0: the arithmetic is exact in binary.
    expect(Object.values(c.tol).every((t) => t === 0)).toBe(true);
    expect(result.outputs.total).toBe(result.outputs.activeReturn);
  });
});
