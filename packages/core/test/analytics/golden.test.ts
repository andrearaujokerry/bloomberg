/**
 * QA-01 — the single golden driver (WORKPLAN L535, TESTING §7.1 L387-390).
 *
 * TESTING §7.1 names this file as "the single driver: it loads every file, dispatches on `engine`,
 * runs the named engine through `defineEngine` and asserts each `expected` key within `tol`. It
 * additionally asserts `EngineResult.inputsHash` is stable across two runs and that `engine.version`
 * matches `engineVersion`."
 *
 * The per-engine tests (`bsm.test.ts`, `bond.price.test.ts`, `curve.bootstrap.test.ts`, …) each open
 * their own fixture directory and assert far more than the pins — branch coverage, cross-checks,
 * finite-difference agreement. This file is deliberately the *other* thing: it walks
 * `fixtures/golden/analytics/**` from the root, so a fixture added under a directory no test happens
 * to open cannot be silently unexercised. Three guards make that bite:
 *
 *   1. every case's `engine` must be in {@link ENGINES}; an unregistered engine fails the run;
 *   2. every case's record must have the §7.1 shape, with a `tol` for every numeric `expected` key;
 *   3. every `expected` key must resolve to an actual. A key the driver cannot resolve is a
 *      failure, never a skip — that is the whole point of the orphan guard.
 *
 * Two of the sixteen engine names in the fixture tree are not `defineEngine` wrappers but the pure
 * functions `curve/interp.ts` and `adjust/corporateActions.ts` expose; {@link ENGINES} carries the
 * declared identity for those and the driver hashes their inputs with `inputsHashOf`, which is the
 * same hash `defineEngine` computes, so assertion (1) of §7.1 still holds for them.
 *
 * Nothing here loosens a pinned value: the tolerances, relations and expectations all come out of
 * the fixture records themselves.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  adjustmentFactors,
  applyAdjustment,
  cumulativeFactors,
  totalReturnIndex,
  type CaForAdjust,
} from '../../src/adjust/corporateActions.js';
import { billEngine } from '../../src/analytics/bill.js';
import { bondPriceEngine, bondYieldEngine } from '../../src/analytics/bond/price.js';
import { bondRiskEngine } from '../../src/analytics/bond/risk.js';
import {
  bootstrapOisCurve,
  bootstrapParCurve,
  impliedParRate,
  oisParRate,
  oisPv,
  oisScheduleOf,
  parBondPrice,
  parScheduleOf,
  type OisBootstrapInputs,
  type OisScheduleConventions,
  type ParBootstrapInputs,
} from '../../src/analytics/curve/bootstrap.js';
import {
  INTERPOLATION_NAMES,
  makeInterpolator,
  type DfPoint,
  type Interpolator,
} from '../../src/analytics/curve/interp.js';
import { inputsHashOf, type Engine, type EngineInputs } from '../../src/analytics/engine.js';
import { bsmEngine } from '../../src/analytics/options/bsm.js';
import { attributionEngine } from '../../src/analytics/portfolio/attribution.js';
import { exposureEngine } from '../../src/analytics/portfolio/exposure.js';
import { portfolioRiskEngine } from '../../src/analytics/portfolio/risk.js';
import { statsEngine } from '../../src/analytics/stats/index.js';
import { oisSwapEngine } from '../../src/analytics/swap/ois.js';
import { volSurfaceEngine } from '../../src/analytics/vol/surface.js';
import { policyPathEngine } from '../../src/analytics/wirp/policyPath.js';
import { SIFMA } from '../../src/calendars/sifma.js';
import type { Bar } from '../../src/types/bars.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The §7.1 record
// ─────────────────────────────────────────────────────────────────────────────────────────────

type Scalar = number | string | boolean;

interface GoldenCase {
  readonly id: string;
  readonly engine: string;
  readonly engineVersion: string;
  readonly inputs: Record<string, unknown>;
  readonly valuationTs: string;
  readonly expected: Record<string, Scalar>;
  readonly tol: Record<string, number>;
  readonly relTol?: Record<string, number>;
  readonly source: string;
}

/** A case plus the fixture file it came from, for diagnosable failures. */
interface LoadedCase {
  readonly file: string;
  readonly kase: GoldenCase;
}

const GOLDEN_ROOT = fileURLToPath(
  new URL('../../../../fixtures/golden/analytics/', import.meta.url),
);

/** Every `.json` under `fixtures/golden/analytics/`, at any depth, sorted. */
function walkFixtures(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFixtures(full, `${prefix}${entry}/`));
    else if (entry.endsWith('.json')) out.push(`${prefix}${entry}`);
  }
  return out;
}

const ALL_FIXTURE_FILES = walkFixtures(GOLDEN_ROOT);

/**
 * `studies/` holds the chart engine's study goldens, not §7.1 engine cases. CLIENT.md §11.6 L887
 * names `fixtures/golden/analytics/studies/<id>.json` as their home, so they land inside this
 * driver's root while belonging to a different record shape entirely: one object per study, with
 * `lines` and `params`, read by `packages/web/test/chart/studies*.test.ts`.
 *
 * They are partitioned out rather than filtered away, because the docblock above promises that a
 * fixture under a directory no test opens cannot go unexercised, and a silent skip would be exactly
 * the hole it promises not to have. {@link CHART_STUDY_FILES} is therefore asserted below: the
 * directory must be populated and every file in it must actually have the chart-study shape, so a
 * §7.1 case array misfiled here still fails this suite instead of disappearing from both.
 */
const CHART_STUDY_DIR = 'studies/';
const CHART_STUDY_FILES = ALL_FIXTURE_FILES.filter((f) => f.startsWith(CHART_STUDY_DIR));
const FIXTURE_FILES = ALL_FIXTURE_FILES.filter((f) => !f.startsWith(CHART_STUDY_DIR));

const CASES: LoadedCase[] = FIXTURE_FILES.flatMap((file) => {
  const parsed: unknown = JSON.parse(readFileSync(join(GOLDEN_ROOT, file), 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${file}: a golden file must be an array of cases`);
  return (parsed as GoldenCase[]).map((kase) => ({ file, kase }));
});

describe('the chart study goldens partitioned out of this driver (CLIENT.md §11.6)', () => {
  it('is a populated directory', () => {
    // An empty or vanished `studies/` would mean the partition above is silently excluding nothing
    // while the web suite reads nothing either, which is the failure mode this guard exists for.
    expect(CHART_STUDY_FILES.length).toBeGreaterThan(0);
  });

  it.each(CHART_STUDY_FILES)('%s has the chart-study record shape, not a §7.1 case array', (file) => {
    const parsed: unknown = JSON.parse(readFileSync(join(GOLDEN_ROOT, file), 'utf8'));
    expect(Array.isArray(parsed), `${file}: a §7.1 case array does not belong under studies/`).toBe(
      false,
    );
    const record = parsed as Record<string, unknown>;
    for (const key of ['id', 'fixture', 'bars', 'params', 'lines', 'tol']) {
      expect(record, `${file}: missing chart-study key ${key}`).toHaveProperty(key);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The engine registry — dispatch on `engine`
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What the driver needs of an engine: its declared identity and a run that yields outputs + hash. */
interface Registered {
  readonly version: string;
  /** `true` when the identity comes from a real `defineEngine` wrapper (§7.1's version assertion). */
  readonly wrapped: boolean;
  run(inputs: Record<string, unknown>, valuationTs: string): RunResult;
}

interface RunResult {
  readonly outputs: unknown;
  readonly inputsHash: string;
  /** Present only for `defineEngine`-wrapped engines. */
  readonly identity?: { readonly name: string; readonly version: string };
}

function wrap(engine: Engine<never, unknown>): Registered {
  const callable = engine as unknown as Engine<EngineInputs, unknown>;
  return {
    version: engine.version,
    wrapped: true,
    run(inputs, valuationTs) {
      const result = callable(inputs, valuationTs);
      return { outputs: result.outputs, inputsHash: result.inputsHash, identity: result.engine };
    },
  };
}

/**
 * `bootstrapParCurve` / `bootstrapOisCurve` are `defineEngine` wrappers that hand back the whole
 * `EngineResult` rather than a callable `Engine`; unwrap it to the same shape {@link wrap} gives.
 */
function fromResult(
  version: string,
  run: (
    inputs: Record<string, unknown>,
    ts: string,
  ) => { outputs: unknown; inputsHash: string; engine: { name: string; version: string } },
): Registered {
  return {
    version,
    wrapped: true,
    run(inputs, valuationTs) {
      const result = run(inputs, valuationTs);
      return { outputs: result.outputs, inputsHash: result.inputsHash, identity: result.engine };
    },
  };
}

/** A pure-function engine: the declared identity plus `inputsHashOf`, the hash `defineEngine` uses. */
function pure(version: string, run: (inputs: Record<string, unknown>, ts: string) => unknown): Registered {
  return {
    version,
    wrapped: false,
    run(inputs, valuationTs) {
      return { outputs: run(inputs, valuationTs), inputsHash: inputsHashOf(inputs) };
    },
  };
}

const ENGINES: Record<string, Registered> = {
  bill: wrap(billEngine as unknown as Engine<never, unknown>),
  bsm: wrap(bsmEngine as unknown as Engine<never, unknown>),
  'bond.price': wrap(bondPriceEngine as unknown as Engine<never, unknown>),
  'bond.yield': wrap(bondYieldEngine as unknown as Engine<never, unknown>),
  'bond.risk': wrap(bondRiskEngine as unknown as Engine<never, unknown>),
  'curve.bootstrap': fromResult('1.0.0', (inputs, ts) =>
    bootstrapParCurve(inputs as unknown as ParBootstrapInputs, ts),
  ),
  'curve.ois.bootstrap': fromResult('1.0.0', (inputs, ts) =>
    bootstrapOisCurve(inputs as unknown as OisBootstrapInputs, ts),
  ),
  'curve.interp': pure('1.0.0', (inputs) => interpOutputs(inputs)),
  'swap.ois': wrap(oisSwapEngine as unknown as Engine<never, unknown>),
  'vol.surface': wrap(volSurfaceEngine as unknown as Engine<never, unknown>),
  'wirp.policypath': wrap(policyPathEngine as unknown as Engine<never, unknown>),
  stats: wrap(statsEngine as unknown as Engine<never, unknown>),
  'portfolio/exposure': wrap(exposureEngine as unknown as Engine<never, unknown>),
  'portfolio/attribution': wrap(attributionEngine as unknown as Engine<never, unknown>),
  'portfolio/risk': wrap(portfolioRiskEngine as unknown as Engine<never, unknown>),
  adjust: pure('1.0.0', (inputs) => adjustOutputs(inputs)),
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `curve.interp` and `adjust`: the two pure-function engines, flattened to golden keys
// ─────────────────────────────────────────────────────────────────────────────────────────────

function numbersOf(source: unknown, what: string): number[] {
  if (!Array.isArray(source)) throw new Error(`${what} must be an array`);
  return source.map((v) => {
    if (typeof v !== 'number') throw new Error(`${what} must hold numbers`);
    return v;
  });
}

/** `[{t, df}]` from `times` + piecewise-constant continuous `forwards` (the §7.1 input shape). */
function interpPoints(inputs: Record<string, unknown>): DfPoint[] {
  const times = numbersOf(inputs.times, 'times');
  const forwards = numbersOf(inputs.forwards, 'forwards');
  if (times.length !== forwards.length) throw new Error('times and forwards must be the same length');
  const points: DfPoint[] = [];
  let y = 0;
  let previous = 0;
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i] ?? 0;
    y += (forwards[i] ?? 0) * (t - previous);
    previous = t;
    points.push({ t, df: Math.exp(-y) });
  }
  return points;
}

/** Sample an interpolator from 0 to its last node on `step`. */
function forwardGrid(interpolator: Interpolator, step: number): number[] {
  const last = interpolator.times[interpolator.times.length - 1] ?? 0;
  const out: number[] = [];
  for (let t = 0; t <= last + 1e-12; t += step) out.push(interpolator.forward(Math.min(t, last)));
  return out;
}

interface InterpOutputs {
  /** One discount factor per named interpolation, at each sampled time. */
  readonly df: Record<string, readonly number[]>;
  readonly minForward: number;
  readonly maxForward: number;
  readonly forwardsNonNegative: boolean;
  readonly dfStrictlyDecreasing: boolean;
  readonly forwardMonotoneNonDecreasing: boolean;
  readonly nodeDiscreteForwardsReproduced: boolean;
  readonly forwardSpread: number;
  readonly forwardMean: number;
}

/**
 * The `curve.interp` case run. `interpolations` (plural) means "every named interpolation must give
 * the same answer" — the flat case — so the sampled `df` is the worst of the three; `interpolation`
 * (singular) names the one under test.
 */
function interpOutputs(inputs: Record<string, unknown>): InterpOutputs {
  const points = interpPoints(inputs);
  const names =
    Array.isArray(inputs.interpolations) && inputs.interpolations.length > 0
      ? (inputs.interpolations as string[])
      : [(inputs.interpolation as string | undefined) ?? 'monotone_convex'];
  const step = typeof inputs.gridStep === 'number' ? inputs.gridStep : 0.05;
  const sampleTimes = Array.isArray(inputs.sampleTimes)
    ? numbersOf(inputs.sampleTimes, 'sampleTimes')
    : points.map((p) => p.t);

  const df: Record<string, number[]> = {};
  let minForward = Number.POSITIVE_INFINITY;
  let maxForward = Number.NEGATIVE_INFINITY;
  let forwardsNonNegative = true;
  let dfStrictlyDecreasing = true;
  let forwardMonotoneNonDecreasing = true;
  let nodeDiscreteForwardsReproduced = true;
  let forwardSum = 0;
  let forwardCount = 0;

  for (const name of names) {
    if (!INTERPOLATION_NAMES.includes(name as (typeof INTERPOLATION_NAMES)[number])) {
      throw new Error(`curve.interp: unknown interpolation '${name}'`);
    }
    const interpolator = makeInterpolator(name as (typeof INTERPOLATION_NAMES)[number], points);
    for (const t of sampleTimes) {
      // Every named interpolation is kept: the resolver checks the one furthest from the pin, so
      // the case fails if ANY of them misses.
      const key = String(t);
      (df[key] ??= []).push(interpolator.df(t));
    }
    const grid = forwardGrid(interpolator, step);
    let previousForward = Number.NEGATIVE_INFINITY;
    for (const f of grid) {
      minForward = Math.min(minForward, f);
      maxForward = Math.max(maxForward, f);
      forwardSum += f;
      forwardCount += 1;
      if (f < 0) forwardsNonNegative = false;
      if (f + 1e-12 < previousForward) forwardMonotoneNonDecreasing = false;
      previousForward = f;
    }
    let previousDf = Number.POSITIVE_INFINITY;
    const last = interpolator.times[interpolator.times.length - 1] ?? 0;
    for (let t = 0; t <= last + 1e-12; t += step) {
      const d = interpolator.df(Math.min(t, last));
      if (d >= previousDf) dfStrictlyDecreasing = false;
      previousDf = d;
    }
    // Every node's discrete forward must come back unchanged: −ln(df(tᵢ)/df(tᵢ₋₁))/Δt.
    const times = numbersOf(inputs.times, 'times');
    const declared = numbersOf(inputs.forwards, 'forwards');
    let previousT = 0;
    let previousNodeDf = 1;
    for (let i = 0; i < times.length; i += 1) {
      const t = times[i] ?? 0;
      const d = interpolator.df(t);
      const discrete = -Math.log(d / previousNodeDf) / (t - previousT);
      if (Math.abs(discrete - (declared[i] ?? 0)) > 1e-12) nodeDiscreteForwardsReproduced = false;
      previousT = t;
      previousNodeDf = d;
    }
  }

  const forwardMean = forwardCount === 0 ? 0 : forwardSum / forwardCount;
  return {
    df,
    minForward,
    maxForward,
    forwardsNonNegative,
    dfStrictlyDecreasing,
    forwardMonotoneNonDecreasing,
    nodeDiscreteForwardsReproduced,
    forwardSpread: maxForward - minForward,
    forwardMean,
  };
}

/** The element of `values` furthest from `target` — the worst case a pin has to survive. */
function furthestFrom(values: readonly number[], target: number): number {
  let worst = target;
  for (const value of values) {
    if (Math.abs(value - target) >= Math.abs(worst - target)) worst = value;
  }
  return worst;
}

function toBar(row: Record<string, unknown>): Bar {
  return {
    date: row.date as string,
    open: row.open as number,
    high: row.high as number,
    low: row.low as number,
    close: row.close as number,
    volume: (row.volume as number | null | undefined) ?? null,
  };
}

function toAction(row: Record<string, unknown>): CaForAdjust {
  const out: Record<string, unknown> = {
    caType: row.caType,
    status: row.status,
    exDate: row.exDate,
  };
  if (row.ratioNew !== undefined) out.ratioNew = row.ratioNew;
  if (row.ratioOld !== undefined) out.ratioOld = row.ratioOld;
  if (row.amount !== undefined) out.amount = row.amount;
  if (row.currency !== undefined) out.currency = row.currency;
  return out as unknown as CaForAdjust;
}

/** The `adjust` case run, flattened to the dotted keys TESTING §7.9's goldens pin. */
function adjustOutputs(inputs: Record<string, unknown>): Record<string, Scalar> {
  const bars = (inputs.bars as Record<string, unknown>[]).map(toBar);
  const actions = (inputs.actions as Record<string, unknown>[]).map(toAction);
  const closes = bars.map((bar) => ({ date: bar.date, close: bar.close }));
  const policy = inputs.policy as 'unadjusted' | 'price' | 'total_return';

  const steps = adjustmentFactors(actions, closes, policy);
  const adjusted = applyAdjustment(bars, steps);
  const factors = cumulativeFactors(
    bars.map((bar) => bar.date),
    steps,
  );

  const out: Record<string, Scalar> = { 'steps.length': steps.length };
  steps.forEach((step, i) => {
    out[`steps.${String(i)}.beforeDate`] = step.beforeDate;
    out[`steps.${String(i)}.priceFactor`] = step.priceFactor;
    out[`steps.${String(i)}.volumeFactor`] = step.volumeFactor;
    out[`steps.${String(i)}.kind`] = step.kind;
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
  for (const point of totalReturnIndex(bars, actions)) out[`tri.${point.date}`] = point.value;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolving an `expected` key to an actual
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Not a value any engine returns — the sentinel for "this key did not resolve". */
const UNRESOLVED = Symbol('unresolved');
type Resolved = Scalar | typeof UNRESOLVED;

/**
 * How an `expected` value is compared with the actual. `eq` is the §7.1 default (`|Δ| ≤ tol`, or
 * exact for a string/boolean); the others are for the handful of keys whose pinned number is a
 * documented *bound* rather than a value — `tol: 0` in the fixture is the giveaway.
 */
const RELATIONS: Record<string, 'gte' | 'lte' | 'gt'> = {
  forwardLowerBound: 'gte',
  forwardUpperBound: 'lte',
  minimumSeparationAtT4: 'gt',
  nodeDiscountFactorsAgreeWithin: 'lte',
};

/** Walk a dotted path (`schedule.periods.0.days`) through plain objects and arrays. */
function walkPath(root: unknown, key: string): Resolved {
  let node: unknown = root;
  for (const segment of key.split('.')) {
    if (node === null || typeof node !== 'object') return UNRESOLVED;
    node = (node as Record<string, unknown>)[segment];
    if (node === undefined) return UNRESOLVED;
  }
  return typeof node === 'number' || typeof node === 'string' || typeof node === 'boolean'
    ? node
    : UNRESOLVED;
}

function generic(outputs: unknown, key: string): Resolved {
  if (outputs !== null && typeof outputs === 'object' && key in (outputs)) {
    const direct = (outputs as Record<string, unknown>)[key];
    if (typeof direct === 'number' || typeof direct === 'string' || typeof direct === 'boolean') {
      return direct;
    }
  }
  return walkPath(outputs, key);
}

/** `name@suffix` → `[name, suffix]`, else `undefined`. */
function splitAt(key: string): readonly [string, string] | undefined {
  const at = key.indexOf('@');
  return at === -1 ? undefined : ([key.slice(0, at), key.slice(at + 1)] as const);
}

type Resolver = (outputs: unknown, key: string, kase: GoldenCase) => Resolved;

const RESOLVERS: Record<string, Resolver> = {
  'swap.ois': (outputs, key) => {
    const o = outputs as {
      schedule: { periods: Record<string, unknown>[] };
      floatLeg: Record<string, unknown>[];
    };
    if (key === 'periodCount') return o.schedule.periods.length;
    const parts = splitAt(key);
    if (parts === undefined) return UNRESOLVED;
    const [field, indexText] = parts;
    const index = Number(indexText) - 1;
    if (!Number.isInteger(index) || index < 0) return UNRESOLVED;
    if (field === 'floatRate') return walkPath(o.floatLeg[index], 'rate');
    if (field === 'floatAmount') return walkPath(o.floatLeg[index], 'amount');
    return walkPath(o.schedule.periods[index], field);
  },

  'wirp.policypath': (outputs, key) => {
    const o = outputs as {
      meetings: Record<string, unknown>[];
      segments: readonly unknown[];
    };
    if (key === 'meetingCount') return o.meetings.length;
    if (key === 'segmentCount') return o.segments.length;
    const meeting = /^m(\d+)\.(.+)$/.exec(key);
    if (meeting === null) return UNRESOLVED;
    const row = o.meetings[Number(meeting[1]) - 1];
    if (row === undefined) return UNRESOLVED;
    const field = meeting[2] ?? '';
    const probabilities = row.probabilities as { probability: number }[] | undefined;
    if (field === 'probabilitySum') {
      return (probabilities ?? []).reduce((sum, p) => sum + p.probability, 0);
    }
    if (field === 'outcomeCount') return (probabilities ?? []).length;
    // `m2.prob@-1` / `m2.prob@0`: the probability mass on that many 25bp steps.
    const probAt = splitAt(field);
    if (probAt?.[0] === 'prob') {
      const steps = Number(probAt[1]);
      const outcome = (probabilities as { steps: number; probability: number }[] | undefined)?.find(
        (p) => p.steps === steps,
      );
      return outcome?.probability ?? UNRESOLVED;
    }
    return walkPath(row, field);
  },

  'curve.interp': (outputs, key, kase) => {
    const o = outputs as InterpOutputs;
    const parts = splitAt(key);
    if (parts?.[0] === 'df') {
      const values = o.df[parts[1]];
      if (values === undefined || values.length === 0) return UNRESOLVED;
      const pinned = kase.expected[key];
      return typeof pinned === 'number' ? furthestFrom(values, pinned) : values[0] ?? UNRESOLVED;
    }
    if (key === 'forwardEverywhere') {
      // Pinned as "the forward is this everywhere": assert the whole grid, then hand back the pin's
      // own neighbourhood so the tolerance check below is the one that decides.
      const pinned = kase.expected.forwardEverywhere;
      if (typeof pinned !== 'number') return UNRESOLVED;
      return Math.abs(o.maxForward - pinned) >= Math.abs(o.minForward - pinned)
        ? o.maxForward
        : o.minForward;
    }
    if (key === 'forwardLowerBound') return o.minForward;
    if (key === 'forwardUpperBound') return o.maxForward;
    return generic(o, key);
  },

  'curve.bootstrap': curveBootstrapResolver,
  'curve.ois.bootstrap': curveBootstrapResolver,
};

const OIS_SCHEDULE_CONVENTIONS: OisScheduleConventions = {
  fixedFrequency: 1,
  settlementDays: 2,
  businessDayConvention: 'modified_following',
  calendar: SIFMA,
};

function curveBootstrapResolver(outputs: unknown, key: string, kase: GoldenCase): Resolved {
  const o = outputs as {
    nodes: readonly { t: number; df: number; zero: number; fwd: number }[];
    curve: { df(t: number): number; zero(t: number): number };
    maxResidual: number;
  };
  const inputs = kase.inputs;

  if (key === 'nodeCount') return o.nodes.length;
  if (key === 'dfAtZero') return o.curve.df(0);
  if (key === 'overnightTau') return o.nodes[0]?.t ?? Number.NaN;
  if (key === 'overnightDf') return o.nodes[0]?.df ?? Number.NaN;
  if (key === 'zeroPercent') {
    // Pinned as "every node's zero is this"; return the node furthest from the pin.
    const pinned = kase.expected.zeroPercent;
    if (typeof pinned !== 'number') return UNRESOLVED;
    let worst = pinned;
    for (const node of o.nodes) {
      if (Math.abs(node.zero * 100 - pinned) > Math.abs(worst - pinned)) worst = node.zero * 100;
    }
    return worst;
  }
  if (key === 'fwdPercent') {
    const pinned = kase.expected.fwdPercent;
    if (typeof pinned !== 'number') return UNRESOLVED;
    let worst = pinned;
    for (const node of o.nodes) {
      if (Math.abs(node.fwd * 100 - pinned) > Math.abs(worst - pinned)) worst = node.fwd * 100;
    }
    return worst;
  }
  if (key === 'repricesUnderEveryInterpolation') {
    return INTERPOLATION_NAMES.every((interpolation) => {
      const built = bootstrapParCurve(
        { ...(inputs as unknown as ParBootstrapInputs), interpolation },
        kase.valuationTs,
      ).outputs;
      return built.maxResidual <= 1e-10;
    });
  }
  if (key === 'minimumSeparationAtT4') {
    const dfs = INTERPOLATION_NAMES.map(
      (interpolation) =>
        bootstrapParCurve(
          { ...(inputs as unknown as ParBootstrapInputs), interpolation },
          kase.valuationTs,
        ).outputs.curve.df(4),
    );
    let worst = Number.POSITIVE_INFINITY;
    for (let i = 0; i < dfs.length; i += 1) {
      for (let j = i + 1; j < dfs.length; j += 1) {
        worst = Math.min(worst, Math.abs((dfs[i] ?? 0) - (dfs[j] ?? 0)));
      }
    }
    return worst;
  }
  if (key === 'nodeDiscountFactorsAgreeWithin') {
    const builds = INTERPOLATION_NAMES.map(
      (interpolation) =>
        bootstrapParCurve(
          { ...(inputs as unknown as ParBootstrapInputs), interpolation },
          kase.valuationTs,
        ).outputs.nodes,
    );
    const reference = builds[0] ?? [];
    let worst = 0;
    for (const nodes of builds) {
      nodes.forEach((node, i) => {
        worst = Math.max(worst, Math.abs(node.df - (reference[i]?.df ?? node.df)));
      });
    }
    return worst;
  }

  const parts = splitAt(key);
  if (parts === undefined) return UNRESOLVED;
  const [field, suffix] = parts;

  if (field === 'df') {
    // `df@0.5` is a time in years; `df@4W` / `df@13W` is a bill tenor, whose node carries the df.
    const asTime = Number(suffix.endsWith('.printed') ? suffix.slice(0, -'.printed'.length) : suffix);
    if (Number.isFinite(asTime)) return o.curve.df(asTime);
    const bills = (inputs.bills as { tenor: string }[] | undefined) ?? [];
    const position = bills.findIndex((b) => b.tenor === suffix);
    if (position === -1) return UNRESOLVED;
    return o.nodes[position]?.df ?? Number.NaN;
  }

  const frequency = (inputs.frequency as number | undefined) ?? 2;
  const curveDate = inputs.curveDate as string;

  if (field === 'price' || field === 'parRate') {
    const parQuotes = (inputs.parQuotes as { tenor: string; parRate: number }[] | undefined) ?? [];
    const oisQuotes = (inputs.quotes as { tenor: string; parRate: number }[] | undefined) ?? [];
    const par = parQuotes.find((q) => q.tenor === suffix);
    if (par !== undefined) {
      const schedule = parScheduleOf(curveDate, par.tenor, frequency);
      return field === 'price'
        ? parBondPrice(o.curve as never, schedule, par.parRate / 100)
        : impliedParRate(o.curve as never, schedule) * 100;
    }
    const ois = oisQuotes.find((q) => q.tenor === suffix);
    if (ois !== undefined && field === 'parRate') {
      const schedule = oisScheduleOf(curveDate, ois.tenor, OIS_SCHEDULE_CONVENTIONS);
      return oisParRate(o.curve as never, schedule) * 100;
    }
    return UNRESOLVED;
  }

  if (field === 'pv') {
    const oisQuotes = (inputs.quotes as { tenor: string; parRate: number }[] | undefined) ?? [];
    const ois = oisQuotes.find((q) => q.tenor === suffix);
    if (ois === undefined) return UNRESOLVED;
    const schedule = oisScheduleOf(curveDate, ois.tenor, OIS_SCHEDULE_CONVENTIONS);
    return oisPv(o.curve as never, schedule, ois.parRate / 100);
  }

  return UNRESOLVED;
}

function resolve(engine: string, outputs: unknown, key: string, kase: GoldenCase): Resolved {
  const specific = RESOLVERS[engine];
  if (specific !== undefined) {
    const value = specific(outputs, key, kase);
    if (value !== UNRESOLVED) return value;
  }
  return generic(outputs, key);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The fixture tree itself
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('fixtures/golden/analytics/** — the QA-01 fixture tree', () => {
  it('is non-empty and every file parses to an array of cases', () => {
    expect(FIXTURE_FILES.length).toBeGreaterThan(0);
    expect(CASES.length).toBeGreaterThan(0);
    // Each of the ten §7.1 directories that WP-02 owns is represented.
    const directories = new Set(FIXTURE_FILES.map((f) => f.split('/')[0]));
    expect([...directories].sort()).toEqual([
      'adjust',
      'bill',
      'bond',
      'bsm',
      'curve',
      'portfolio',
      'stats',
      'swap',
      'vol',
      'wirp',
    ]);
  });

  it('gives every case a unique id', () => {
    const ids = CASES.map((c) => c.kase.id);
    const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicated).toEqual([]);
  });

  it('names only registered engines — an orphan fixture cannot hide here', () => {
    const unregistered = [
      ...new Set(CASES.filter((c) => ENGINES[c.kase.engine] === undefined).map((c) => c.kase.engine)),
    ];
    expect(unregistered).toEqual([]);
  });

  it('has the TESTING §7.1 record shape, with a tolerance for every numeric pin', () => {
    const problems: string[] = [];
    for (const { file, kase } of CASES) {
      const at = (msg: string): void => void problems.push(`${file}#${kase.id}: ${msg}`);
      if (typeof kase.id !== 'string' || kase.id === '') at('id is missing');
      if (typeof kase.engine !== 'string' || kase.engine === '') at('engine is missing');
      if (!/^\d+\.\d+\.\d+$/.test(kase.engineVersion)) at('engineVersion is not semver');
      if (kase.inputs === null || typeof kase.inputs !== 'object') at('inputs is not an object');
      if (!/^\d{4}-\d{2}-\d{2}/.test(kase.valuationTs)) at('valuationTs is not ISO 8601');
      if (typeof kase.source !== 'string' || kase.source.trim() === '') at('source is empty');
      if (Object.keys(kase.expected).length === 0) at('expected is empty');
      for (const [key, value] of Object.entries(kase.expected)) {
        if (typeof value === 'number' && typeof kase.tol[key] !== 'number') {
          at(`expected.${key} is numeric but tol.${key} is missing`);
        }
      }
      for (const key of Object.keys(kase.tol)) {
        if (!(key in kase.expected)) at(`tol.${key} has no matching expected key`);
      }
    }
    expect(problems).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The driver: dispatch, run, diff to tolerance
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('fixtures/golden/analytics/** — every case, through its engine', () => {
  for (const { file, kase } of CASES) {
    const registered = ENGINES[kase.engine];

    it(`${file}#${kase.id} (${kase.engine}@${kase.engineVersion})`, () => {
      expect(registered, `${kase.id}: engine '${kase.engine}' is not registered`).toBeDefined();
      if (registered === undefined) return;

      // §7.1: `engine.version` matches `engineVersion`.
      expect(registered.version, `${kase.id}: engine version`).toBe(kase.engineVersion);

      const first = registered.run(kase.inputs, kase.valuationTs);
      const second = registered.run(kase.inputs, kase.valuationTs);

      if (registered.wrapped) {
        expect(first.identity?.name, `${kase.id}: engine name`).toBe(kase.engine);
        expect(first.identity?.version, `${kase.id}: engine version`).toBe(kase.engineVersion);
      }

      // §7.1: `inputsHash` is stable across two runs (ANAL-08).
      expect(first.inputsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(second.inputsHash, `${kase.id}: inputsHash is not stable`).toBe(first.inputsHash);

      const unresolved: string[] = [];
      for (const [key, expectedValue] of Object.entries(kase.expected)) {
        const actual = resolve(kase.engine, first.outputs, key, kase);
        if (actual === UNRESOLVED) {
          unresolved.push(key);
          continue;
        }
        if (typeof expectedValue !== 'number') {
          expect(actual, `${kase.id}.${key}`).toBe(expectedValue);
          continue;
        }
        expect(typeof actual, `${kase.id}.${key} should be numeric`).toBe('number');
        const got = actual as number;
        const relation = RELATIONS[key];
        if (relation === 'gte') {
          expect(got, `${kase.id}.${key} (documented lower bound)`).toBeGreaterThanOrEqual(
            expectedValue,
          );
          continue;
        }
        if (relation === 'gt') {
          expect(got, `${kase.id}.${key} (documented lower bound)`).toBeGreaterThan(expectedValue);
          continue;
        }
        if (relation === 'lte') {
          expect(got, `${kase.id}.${key} (documented upper bound)`).toBeLessThanOrEqual(
            expectedValue,
          );
          continue;
        }
        const relTol = kase.relTol?.[key];
        const tol =
          relTol === undefined
            ? (kase.tol[key] ?? 0)
            : Math.max(kase.tol[key] ?? 0, relTol * Math.abs(expectedValue));
        const diff = Math.abs(got - expectedValue);
        expect(
          diff <= tol,
          `${kase.id}.${key}: got ${String(got)}, pinned ${String(expectedValue)} — ` +
            `|Δ| ${diff.toExponential(3)} > tol ${String(tol)}`,
        ).toBe(true);
      }

      // A key the driver cannot resolve is a failure, not a skip: that is the orphan guard.
      expect(unresolved, `${kase.id}: unresolved expected keys`).toEqual([]);
    });
  }
});
