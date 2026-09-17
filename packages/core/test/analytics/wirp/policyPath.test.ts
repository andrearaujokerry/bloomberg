// packages/core/test/analytics/wirp/policyPath.test.ts — WP-02 (WORKPLAN L513-514, L547):
// "probabilities per FOMC date sum to 1; a flat curve yields a zero-move path".
//
// The engine derives the implied overnight path from the **money-market curve**, not from fed funds
// futures, because BRIEF §2 L54-55 records that no keyless source on this network publishes them
// (CME FedWatch is on the "not reachable / not usable" list). The chain is:
//
//   inter-meeting forward  →  implied overnight rate after the meeting   (WIRP_IMPL_RATE)
//   rate − target midpoint →  cumulative implied move in bp              (WIRP_MOVE_BP)
//   move ÷ 25 bp           →  probability split over whole 25 bp steps   (WIRP_PROB_*)
//
// What this file guards:
//
//   1. **The probability ladder is a distribution.** Every FOMC date's outcomes sum to 1, no
//      outcome is negative or above 1, hold + hike + cut = 1, and the ladder is contiguous and
//      always contains the "no change" row so the screen can render it.
//   2. **A flat curve is a zero-move path.** On a curve that is flat at the current target every
//      forward is the target, so every move is 0 bp and every meeting is a 100 % hold — which is
//      exactly what `fields/defs/analytic.ts` WIRP_PROB_HOLD claims ("A flat curve gives 100").
//      The stronger form is also asserted: with `currentRate` omitted the path is zero for *any*
//      flat level, because the anchor then falls back to the curve's own front forward.
//   3. **One 25 bp cut is a 100 % probability at that step.** A curve whose inter-meeting forwards
//      step down by exactly one increment at one meeting puts the entire mass on the −1 outcome.
//   4. **The split rule reproduces the worked example pinned in the field definitions**: a −12.9 bp
//      implied move is −0.516 steps, i.e. WIRP_PROB_CUT = 51.6, WIRP_PROB_HOLD = 48.4,
//      WIRP_PROB_HIKE = 0 (`fields/defs/analytic.ts`, the `FOMC 2026-10-28` examples).
//
// Every expected number in `fixtures/golden/analytics/wirp/policyPath.json` is a closed form: the
// discount factors are built by `df(b(i+1)) = df(b(i)) / (1 + r(i)·Δt(i))` from a stated ladder of
// inter-meeting rates, under which the ACT/360 simple forward over each segment *is* `r(i)` by
// construction. The test re-derives those discount factors here from the stated rates, so the
// fixture's inputs are auditable rather than magic. None of them came out of the engine.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { daysBetween } from '../../../src/calendars/calendar.js';
import type {
  PolicyMeeting,
  PolicyPathInputs,
  PolicyPathOutputs,
  PolicyStepProbability,
} from '../../../src/analytics/wirp/policyPath.js';
import {
  DEFAULT_EFFECTIVE_LAG_DAYS,
  DEFAULT_STEP_BP,
  DEFAULT_STEP_SIZE,
  impliedMove,
  policyPath,
  policyPathEngine,
  stepProbabilities,
} from '../../../src/analytics/wirp/policyPath.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The golden file
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface GoldenCase {
  readonly id: string;
  readonly engine: string;
  readonly engineVersion: string;
  readonly inputs: PolicyPathInputs;
  readonly valuationTs: string;
  readonly expected: Record<string, number | string | boolean>;
  readonly tol: Record<string, number>;
  readonly source: string;
}

const GOLDEN: readonly GoldenCase[] = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../../fixtures/golden/analytics/wirp/policyPath.json', import.meta.url),
    ),
    'utf8',
  ),
) as GoldenCase[];

function goldenCase(id: string): GoldenCase {
  const found = GOLDEN.find((c) => c.id === id);
  if (found === undefined) throw new Error(`golden case '${id}' is missing from the fixture`);
  return found;
}

/**
 * Flatten an engine result into the flat `{key: value}` space the golden `expected` block uses:
 * `m2.impliedRate`, `m4.prob@-2`, `m1.probabilitySum`, and the handful of path-level keys.
 */
function flatten(out: PolicyPathOutputs): Record<string, number | string | boolean> {
  const flat: Record<string, number | string | boolean> = {
    meetingCount: out.meetings.length,
    segmentCount: out.segments.length,
    terminalDate: out.terminalDate,
    extrapolated: out.extrapolated,
    spotRate: out.spotRate,
    spotBasisBp: out.spotBasisBp,
    terminalRate: out.terminalRate,
  };
  out.meetings.forEach((m, i) => {
    const p = `m${String(i + 1)}`;
    flat[`${p}.effectiveDate`] = m.effectiveDate;
    flat[`${p}.impliedRate`] = m.impliedRate;
    flat[`${p}.moveBp`] = m.moveBp;
    flat[`${p}.incrementalBp`] = m.incrementalBp;
    flat[`${p}.steps`] = m.steps;
    flat[`${p}.hikeProbability`] = m.hikeProbability;
    flat[`${p}.cutProbability`] = m.cutProbability;
    flat[`${p}.holdProbability`] = m.holdProbability;
    flat[`${p}.probabilitySum`] = m.probabilities.reduce((s, o) => s + o.probability, 0);
    // The number of rows the WIRP screen renders for this meeting — the whole contiguous ladder,
    // zero-probability rows included, not just the outcomes that carry mass.
    flat[`${p}.outcomeCount`] = m.probabilities.length;
    for (const o of m.probabilities) flat[`${p}.prob@${String(o.steps)}`] = o.probability;
  });
  return flat;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Re-deriving the fixture's discount factors from the rate ladder it documents
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The boundary dates every case in the fixture shares: curve date, four effectives, terminal. */
const BOUNDARIES = [
  '2026-09-15',
  '2026-10-29',
  '2026-12-10',
  '2027-01-28',
  '2027-03-18',
  '2027-05-06',
] as const;

/** `df(b(i+1)) = df(b(i)) / (1 + r(i)·Δt(i))`, ACT/360 — the construction the `source` states. */
function dfLadder(rates: readonly number[]): { t: number; df: number }[] {
  const times = BOUNDARIES.map((d) => daysBetween(BOUNDARIES[0], d) / 360);
  const points: { t: number; df: number }[] = [];
  let df = 1;
  for (let i = 0; i < rates.length; i += 1) {
    const t0 = times[i]!;
    const t1 = times[i + 1]!;
    df /= 1 + (rates[i]!) * (t1 - t0);
    points.push({ t: t1, df });
  }
  return points;
}

const FLAT_RATES = [0.0425, 0.0425, 0.0425, 0.0425, 0.0425];
const ONECUT_RATES = [0.0425, 0.0425, 0.04, 0.04, 0.04];
const PARTIAL_RATES = [0.0425, 0.0426, 0.04125, 0.04, 0.03875];

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('fixtures/golden/analytics/wirp/policyPath.json', () => {
  it('carries the §7.1 record shape on every case', () => {
    expect(GOLDEN.length).toBe(3);
    for (const c of GOLDEN) {
      expect(c.engine).toBe('wirp.policypath');
      expect(c.engineVersion).toBe(policyPathEngine.version);
      expect(typeof c.id).toBe('string');
      expect(typeof c.valuationTs).toBe('string');
      expect(typeof c.source).toBe('string');
      expect(Object.keys(c.expected).length).toBeGreaterThan(0);
      // Every numeric expectation carries a tolerance; strings and booleans are exact.
      for (const [key, value] of Object.entries(c.expected)) {
        if (typeof value === 'number') expect(c.tol[key], `tol for ${c.id}/${key}`).toBeDefined();
      }
    }
  });

  it('builds its discount factors from the rate ladder its `source` documents', () => {
    const ladders: Record<string, readonly number[]> = {
      'wirp.flat.zeropath': FLAT_RATES,
      'wirp.onecut.25bp': ONECUT_RATES,
      'wirp.partial.split': PARTIAL_RATES,
    };
    for (const [id, rates] of Object.entries(ladders)) {
      const points = goldenCase(id).inputs.points;
      const rebuilt = dfLadder(rates);
      expect(points.length, id).toBe(rebuilt.length);
      points.forEach((p, i) => {
        expect(p.t, `${id} points[${String(i)}].t`).toBeCloseTo((rebuilt[i] as { t: number }).t, 15);
        expect(p.df, `${id} points[${String(i)}].df`).toBeCloseTo(
          (rebuilt[i] as { df: number }).df,
          15,
        );
      });
    }
  });

  it.each(GOLDEN.map((c) => [c.id, c] as const))('reproduces %s to its tolerance', (_id, c) => {
    const result = policyPathEngine(c.inputs, c.valuationTs);
    expect(result.engine.name).toBe(c.engine);
    expect(result.engine.version).toBe(c.engineVersion);
    expect(result.valuationTs).toBe(c.valuationTs);
    expect(result.inputsHash).toMatch(/^[0-9a-f]{64}$/);

    const actual = flatten(result.outputs);
    for (const [key, want] of Object.entries(c.expected)) {
      const got = actual[key];
      expect(got, `${c.id}/${key} is missing from the output`).toBeDefined();
      if (typeof want === 'number') {
        expect(typeof got, `${c.id}/${key}`).toBe('number');
        expect(Math.abs((got as number) - want), `${c.id}/${key}`).toBeLessThanOrEqual(
          c.tol[key]!,
        );
      } else {
        expect(got, `${c.id}/${key}`).toBe(want);
      }
    }
  });

  it('hashes identically on a re-run (ANAL-08)', () => {
    for (const c of GOLDEN) {
      const a = policyPathEngine(c.inputs, c.valuationTs);
      const b = policyPathEngine({ ...c.inputs }, c.valuationTs);
      expect(b.inputsHash).toBe(a.inputsHash);
    }
    const base = goldenCase('wirp.flat.zeropath');
    const moved = policyPathEngine(
      { ...base.inputs, currentRate: 0.05 },
      base.valuationTs,
    );
    expect(moved.inputsHash).not.toBe(policyPathEngine(base.inputs, base.valuationTs).inputsHash);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('wirp.policypath — the probability ladder is a distribution', () => {
  it('sums to 1 at every FOMC date of every golden case', () => {
    for (const c of GOLDEN) {
      const out = policyPath(c.inputs, c.valuationTs);
      expect(out.meetings.length).toBe(c.inputs.meetings.length);
      for (const m of out.meetings) {
        const sum = m.probabilities.reduce((s, o) => s + o.probability, 0);
        expect(Math.abs(sum - 1), `${c.id} ${m.meetingDate} sums to ${String(sum)}`).toBeLessThan(
          1e-12,
        );
        for (const o of m.probabilities) {
          expect(o.probability).toBeGreaterThanOrEqual(0);
          expect(o.probability).toBeLessThanOrEqual(1);
          expect(o.bp).toBeCloseTo(o.steps * DEFAULT_STEP_BP, 12);
          expect(Number.isInteger(o.steps)).toBe(true);
        }
        // hold + hike + cut is the same partition of the same mass.
        expect(
          Math.abs(m.holdProbability + m.hikeProbability + m.cutProbability - 1),
        ).toBeLessThan(1e-12);
        // The ladder is contiguous and always offers a "no change" row for the screen.
        const steps = m.probabilities.map((o) => o.steps);
        expect(steps).toContain(0);
        steps.forEach((s, i) => {
          if (i > 0) expect(s).toBe((steps[i - 1]!) + 1);
        });
      }
    }
  });

  it('reproduces the implied move in expectation', () => {
    // The whole point of splitting across the two bracketing steps: Σ p·bp is the implied move.
    for (const c of GOLDEN) {
      const out = policyPath(c.inputs, c.valuationTs);
      for (const m of out.meetings) {
        const mean = m.probabilities.reduce((s, o) => s + o.probability * o.bp, 0);
        // `steps` is snapped to a whole count within DEFAULT_STEP_EPSILON, so the mean matches the
        // *snapped* move; the residue is bounded by 1e-9 steps × 25 bp = 2.5e-8 bp.
        expect(Math.abs(mean - m.moveBp), `${c.id} ${m.meetingDate}`).toBeLessThan(2.5e-8);
      }
    }
  });
});

describe('wirp.policypath — a flat curve yields a zero-move path', () => {
  const c = goldenCase('wirp.flat.zeropath');

  it('implies the target at every meeting, with a 100 % hold', () => {
    const out = policyPath(c.inputs, c.valuationTs);
    expect(out.spotRate).toBeCloseTo(0.0425, 12);
    expect(out.terminalRate).toBeCloseTo(0.0425, 12);
    expect(out.segments.length).toBe(out.meetings.length + 1);
    for (const s of out.segments) expect(s.rate).toBeCloseTo(0.0425, 12);
    for (const m of out.meetings) {
      expect(m.impliedRate).toBeCloseTo(0.0425, 12);
      expect(Math.abs(m.moveBp)).toBeLessThan(1e-8);
      expect(Math.abs(m.incrementalBp)).toBeLessThan(1e-8);
      expect(m.steps).toBe(0);
      expect(m.holdProbability).toBe(1);
      expect(m.hikeProbability).toBe(0);
      expect(m.cutProbability).toBe(0);
      expect(m.probabilities).toEqual([{ steps: 0, bp: 0, probability: 1 }]);
    }
  });

  it('is a zero path at any flat level once the anchor falls back to the curve', () => {
    // Omitting `currentRate` anchors the path on the curve's own front forward, so *any* flat
    // curve — not only one flat at the target — produces a zero-move path.
    const shifted: PolicyPathInputs = {
      ...c.inputs,
      points: dfLadder([0.019, 0.019, 0.019, 0.019, 0.019]),
    };
    const { currentRate: _dropped, ...noAnchor } = shifted;
    const out = policyPath(noAnchor, c.valuationTs);
    expect(out.currentRate).toBeCloseTo(0.019, 12);
    expect(out.spotBasisBp).toBe(0);
    for (const m of out.meetings) {
      expect(m.steps).toBe(0);
      expect(m.holdProbability).toBe(1);
    }
  });
});

describe('wirp.policypath — one 25 bp cut is a 100 % probability at that step', () => {
  const c = goldenCase('wirp.onecut.25bp');

  it('puts the whole mass on the −1 step from the cutting meeting onwards', () => {
    const out = policyPath(c.inputs, c.valuationTs);
    const cut = out.meetings[1]!;
    expect(cut.meetingDate).toBe('2026-12-09');
    expect(cut.effectiveDate).toBe('2026-12-10');
    expect(cut.impliedRate).toBeCloseTo(0.04, 12);
    expect(cut.moveBp).toBeCloseTo(-25, 8);
    expect(cut.incrementalBp).toBeCloseTo(-25, 8);
    expect(cut.steps).toBe(-1);
    expect(cut.cutProbability).toBe(1);
    expect(cut.hikeProbability).toBe(0);
    expect(cut.holdProbability).toBe(0);
    const at = (m: PolicyMeeting, s: number): PolicyStepProbability =>
      m.probabilities.find((o) => o.steps === s)!;
    expect(at(cut, -1).probability).toBe(1);
    expect(at(cut, -1).bp).toBeCloseTo(-25, 12);
    expect(at(cut, 0).probability).toBe(0);

    // The meeting before it is still a certain hold; the two after it carry the cut cumulatively
    // but move nothing further of their own.
    expect((out.meetings[0]!).holdProbability).toBe(1);
    for (const later of out.meetings.slice(2)) {
      expect(later.cutProbability).toBe(1);
      expect(later.steps).toBe(-1);
      expect(Math.abs(later.incrementalBp)).toBeLessThan(1e-8);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('stepProbabilities — the 25 bp split rule', () => {
  it('reproduces the worked example pinned in fields/defs/analytic.ts', () => {
    // WIRP_MOVE_BP −12.9 → WIRP_PROB_CUT 51.6, WIRP_PROB_HOLD 48.4, WIRP_PROB_HIKE 0.
    const s = stepProbabilities(-12.9);
    expect(s.steps).toBeCloseTo(-0.516, 15);
    expect(s.cutProbability * 100).toBeCloseTo(51.6, 10);
    expect(s.holdProbability * 100).toBeCloseTo(48.4, 10);
    expect(s.hikeProbability).toBe(0);
    expect(s.outcomes.map((o) => o.steps)).toEqual([-1, 0]);
  });

  it('spans zero in both directions and stays a distribution', () => {
    const cases = [-62.5, -37.5, -25, -12.9, -0.4, 0, 0.4, 12.5, 25, 37.5, 62.5];
    for (const bp of cases) {
      const s = stepProbabilities(bp);
      const sum = s.outcomes.reduce((acc, o) => acc + o.probability, 0);
      expect(Math.abs(sum - 1), `move ${String(bp)} bp`).toBeLessThan(1e-12);
      expect(s.outcomes.map((o) => o.steps)).toContain(0);
      expect(s.hikeProbability + s.cutProbability + s.holdProbability).toBeCloseTo(1, 12);
      const mean = s.outcomes.reduce((acc, o) => acc + o.probability * o.bp, 0);
      expect(mean, `move ${String(bp)} bp`).toBeCloseTo(bp, 10);
    }
  });

  it('gives a whole step the whole mass', () => {
    for (const n of [-3, -2, -1, 0, 1, 2]) {
      const s = stepProbabilities(n * DEFAULT_STEP_BP);
      expect(s.steps).toBe(n);
      const hit = s.outcomes.find((o) => o.steps === n)!;
      expect(hit.probability).toBe(1);
      expect(s.outcomes.filter((o) => o.probability > 0).length).toBe(1);
    }
  });

  it('rejects an absurd move rather than building a 10,000-row ladder', () => {
    expect(() => stepProbabilities(1e6)).toThrow(/beyond the ±200-step guard/);
    expect(() => stepProbabilities(Number.NaN)).toThrow(/must be finite/);
    expect(() => stepProbabilities(25, 0)).toThrow(/stepBp must be positive/);
  });

  it('agrees with impliedMove and the declared defaults', () => {
    expect(DEFAULT_STEP_SIZE).toBe(0.0025);
    expect(DEFAULT_STEP_BP).toBe(25);
    expect(DEFAULT_EFFECTIVE_LAG_DAYS).toBe(1);
    expect(impliedMove(0.04, 0.0425)).toBeCloseTo(-25, 9);
    expect(impliedMove(0.0425, 0.0425)).toBe(0);
  });
});

describe('wirp.policypath — structure, conventions and guards', () => {
  const c = goldenCase('wirp.partial.split');

  it('echoes its Conventions and lays the boundaries out end to end (ANAL-07)', () => {
    const out = policyPath(c.inputs, c.valuationTs);
    expect(out.conventions).toEqual({
      dayCount: 'ACT/360',
      compounding: 'simple',
      interpolation: 'log_linear_df',
      extrapolation: 'flat_forward',
      stepBp: 25,
      effectiveLagDays: 1,
    });
    expect(out.curveId).toBe('SOFR_OIS');
    expect(out.curveDate).toBe('2026-09-15');
    expect(out.terminalDate).toBe('2027-05-06');
    expect(out.extrapolated).toBe(false);

    // Segments tile the horizon: each one starts where the previous ended.
    expect(out.segments[0]?.from).toBe('2026-09-15');
    out.segments.forEach((s, i) => {
      if (i > 0) {
        expect(s.from).toBe(out.segments[i - 1]?.to);
        expect(s.t0).toBe(out.segments[i - 1]?.t1);
      }
      expect(s.t1).toBeGreaterThan(s.t0);
    });
    expect(out.segments[out.segments.length - 1]?.to).toBe(out.terminalDate);

    // A meeting's rateBefore is the previous segment's rate and its impliedRate the next one's.
    out.meetings.forEach((m, i) => {
      expect(m.rateBefore).toBe(out.segments[i]?.rate);
      expect(m.impliedRate).toBe(out.segments[i + 1]?.rate);
      expect(m.t).toBe(out.segments[i + 1]?.t0);
    });
  });

  it('defaults the terminal date to the last inter-meeting gap repeated', () => {
    // 2027-01-28 → 2027-03-18 is 49 days, so the last segment runs 49 days past 2027-03-18.
    const { terminalDate: _none, ...noTerminal } = c.inputs;
    const out = policyPath(noTerminal, c.valuationTs);
    expect(daysBetween('2027-01-28', '2027-03-18')).toBe(49);
    expect(out.terminalDate).toBe('2027-05-06');
  });

  it('flags a path that runs past the last curve node', () => {
    const short: PolicyPathInputs = { ...c.inputs, points: c.inputs.points.slice(0, 3) };
    const out = policyPath(short, c.valuationTs);
    expect(out.extrapolated).toBe(true);
    // Flat-forward extrapolation: the two segments past the last node share one rate.
    const beyond = out.segments.slice(3).map((s) => s.rate);
    expect(beyond.length).toBe(2);
    expect(beyond[0]!).toBeCloseTo(beyond[1]!, 6);
  });

  it('rejects meetings that are not strictly ascending after the curve date', () => {
    expect(() =>
      policyPath({ ...c.inputs, meetings: ['2026-12-09', '2026-10-28'] }, c.valuationTs),
    ).toThrow(/strictly ascending/);
    expect(() => policyPath({ ...c.inputs, meetings: ['2026-09-01'] }, c.valuationTs)).toThrow(
      /strictly ascending/,
    );
    expect(() => policyPath({ ...c.inputs, meetings: [] }, c.valuationTs)).toThrow(
      /at least one FOMC date/,
    );
    expect(() =>
      policyPath({ ...c.inputs, terminalDate: '2027-01-01' }, c.valuationTs),
    ).toThrow(/must follow the last effective date/);
  });

  it('honours a non-default effective lag', () => {
    // Zero lag moves every boundary a day earlier, which changes the forwards but not the shape.
    const out = policyPath({ ...c.inputs, effectiveLagDays: 0 }, c.valuationTs);
    expect(out.meetings[0]?.effectiveDate).toBe('2026-10-28');
    expect(out.conventions.effectiveLagDays).toBe(0);
    for (const m of out.meetings) {
      const sum = m.probabilities.reduce((s, o) => s + o.probability, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-12);
    }
  });
});
