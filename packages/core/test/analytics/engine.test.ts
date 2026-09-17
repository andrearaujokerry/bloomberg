// packages/core/test/analytics/engine.test.ts — WP-02 acceptance test (WORKPLAN L534, TESTING §7.11).
//
// What this file defends (ANAL-08):
//
//   "running an engine twice with the same inputs and the same valuationTs yields bit-identical
//    outputs and an identical inputsHash; changing any single input changes inputsHash; the declared
//    input set in EngineResult.inputs is exactly the set the function read (asserted with a recording
//    Proxy over the input object); and engine.version is present and semver-shaped."
//
// `inputsHash` is the `char(64)` in `vol_surfaces.inputs_hash`, `fin_statements.inputs_hash` and
// `curve_builds.inputs_hash`. `curve_builds`' uniqueness key
// `(curve_id, curve_date, method, interpolation, engine_version, inputs_hash)` only de-duplicates an
// identical rebuild if *every* process computes the same 64 characters — so "stable across process
// restarts" is asserted the only way a single-process unit test can assert it: against a checked-in
// literal (`PINNED_HASH`), which a future process that disagrees will fail on. The literal is
// additionally re-derived here from `node:crypto` over the canonical text, so the pin is not merely
// "what the implementation printed the day it was written": `node:crypto` is an independent
// SHA-256, and `PINNED_CANONICAL` is the hand-written canonical JSON text the hash is taken over.
//
// `node:crypto` is legal here: test files are outside the core package's tsconfig (`include:
// ["src/**/*.ts"]`) and outside every ESLint boundary zone.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  defineEngine,
  engineMeta,
  inputsHashOf,
  valuationDateOf,
  type Conventions,
  type EngineContext,
} from '../../src/analytics/engine.js';
import { canonicalJson } from '../../src/hash/canonicalJson.js';

// ---------------------------------------------------------------------------------------------
// The fixed input object the process-stable pins are taken over
// ---------------------------------------------------------------------------------------------

/** The TESTING §7.2 BSM case, used here purely as a stable, realistic input record. */
const FIXED_INPUTS = {
  s: 100,
  k: 100,
  r: 0.05,
  q: 0,
  sigma: 0.2,
  t: 1,
  style: 'european',
  kind: 'call',
} as const;

/** `canonicalJson(FIXED_INPUTS)` — keys sorted, no whitespace, shortest round-trip numbers. */
const PINNED_CANONICAL =
  '{"k":100,"kind":"call","q":0,"r":0.05,"s":100,"sigma":0.2,"style":"european","t":1}';

/**
 * `sha256Hex(canonicalJson(FIXED_INPUTS))`. This literal IS the cross-process assertion: a build
 * that computes anything else has broken `curve_builds`/`vol_surfaces` de-duplication and every
 * golden case pinned through it.
 */
const PINNED_HASH = 'd28af4b3530aa618f235d163f00bcbcac40cbbff848694df65623582976c4835';

const VALUATION_TS = '2026-09-15T20:00:00Z';

const CONVENTIONS: Conventions = Object.freeze({
  returns: 'simple',
  annualisation: 252,
  ddof: 1,
  dayCount: 'ACT/365F',
});

interface BsmInputs {
  readonly s: number;
  readonly k: number;
  readonly r: number;
  readonly q: number;
  readonly sigma: number;
  readonly t: number;
  readonly style: string;
  readonly kind: string;
  readonly [key: string]: unknown;
}

/** A deterministic stand-in engine: real arithmetic, but owned by this test, not by a WP-02 module. */
const moneyness = defineEngine('test.moneyness', '1.2.3', (i: BsmInputs, ctx: EngineContext) => ({
  forward: i.s * Math.exp((i.r - i.q) * i.t),
  logMoneyness: Math.log(i.s / i.k),
  totalVariance: i.sigma * i.sigma * i.t,
  valuationDate: ctx.valuationDate,
  conventions: CONVENTIONS,
}));

// ---------------------------------------------------------------------------------------------
// 1. inputsHash is sha256Hex(canonicalJson(inputs)) — and is pinned across processes
// ---------------------------------------------------------------------------------------------

describe('inputsHash (ANAL-08)', () => {
  it('is the pinned char(64) for the fixed input object', () => {
    const result = moneyness(FIXED_INPUTS, VALUATION_TS);
    expect(result.inputsHash).toBe(PINNED_HASH);
    expect(result.inputsHash).toHaveLength(64);
    expect(result.inputsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-derives from the canonical text with an independent SHA-256 (node:crypto)', () => {
    expect(canonicalJson(FIXED_INPUTS)).toBe(PINNED_CANONICAL);
    const independent = createHash('sha256').update(PINNED_CANONICAL, 'utf8').digest('hex');
    expect(independent).toBe(PINNED_HASH);
    expect(inputsHashOf(FIXED_INPUTS)).toBe(independent);
  });

  it('is stable across runs: two runs are bit-identical', () => {
    const a = moneyness(FIXED_INPUTS, VALUATION_TS);
    const b = moneyness(FIXED_INPUTS, VALUATION_TS);
    expect(b.inputsHash).toBe(a.inputsHash);
    expect(b.outputs).toStrictEqual(a.outputs);
    expect(canonicalJson(b.outputs)).toBe(canonicalJson(a.outputs));
  });

  it('is stable across engine instances and freshly built input objects', () => {
    const twin = defineEngine('test.moneyness', '1.2.3', (i: BsmInputs) => ({ x: i.s }));
    const rebuilt: BsmInputs = {
      s: 100,
      k: 100,
      r: 0.05,
      q: 0,
      sigma: 0.2,
      t: 1,
      style: 'european',
      kind: 'call',
    };
    expect(twin(rebuilt, '2001-01-01').inputsHash).toBe(PINNED_HASH);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Changing any single input changes the hash
// ---------------------------------------------------------------------------------------------

describe('inputsHash sensitivity', () => {
  const perturb: Record<string, unknown> = {
    s: 100.000000001,
    k: 99,
    r: 0.050000001,
    q: 1e-12,
    sigma: 0.2000001,
    t: 1.0000001,
    style: 'american',
    kind: 'put',
  };

  it('changes when any single input changes', () => {
    const seen = new Map<string, string>([[PINNED_HASH, 'base']]);
    for (const key of Object.keys(FIXED_INPUTS)) {
      const mutated = { ...FIXED_INPUTS, [key]: perturb[key] };
      const hash = inputsHashOf(mutated);
      expect(hash, `${key} did not change inputsHash`).not.toBe(PINNED_HASH);
      expect(seen.has(hash), `${key} collided with ${String(seen.get(hash))}`).toBe(false);
      seen.set(hash, key);
    }
    expect(seen.size).toBe(Object.keys(FIXED_INPUTS).length + 1);
  });

  it('changes when an input is added or removed', () => {
    expect(inputsHashOf({ ...FIXED_INPUTS, div: 0 })).not.toBe(PINNED_HASH);
    const without: Record<string, unknown> = { ...FIXED_INPUTS };
    delete without.kind;
    expect(inputsHashOf(without)).not.toBe(PINNED_HASH);
  });

  it('distinguishes 0 from -0-free numerics but not string/number lookalikes by accident', () => {
    // -0 canonicalises to 0 (a price of -0 is a price of 0); '100' is NOT 100.
    expect(inputsHashOf({ ...FIXED_INPUTS, q: -0 })).toBe(PINNED_HASH);
    expect(inputsHashOf({ ...FIXED_INPUTS, s: '100' })).not.toBe(PINNED_HASH);
  });

  it('treats an explicitly-undefined member as an absent one', () => {
    expect(inputsHashOf({ ...FIXED_INPUTS, extra: undefined })).toBe(PINNED_HASH);
  });

  it('rejects inputs that canonical JSON cannot represent', () => {
    expect(() => moneyness({ ...FIXED_INPUTS, s: Number.NaN }, VALUATION_TS)).toThrow(
      /not canonical-JSON representable/,
    );
    expect(() => moneyness({ ...FIXED_INPUTS, s: Number.POSITIVE_INFINITY }, VALUATION_TS)).toThrow(
      /not canonical-JSON representable/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Key order does not matter (canonicalJson sorts)
// ---------------------------------------------------------------------------------------------

describe('key order independence', () => {
  it('hashes identically whatever order the keys were inserted in', () => {
    const reversed: Record<string, unknown> = {};
    for (const key of [...Object.keys(FIXED_INPUTS)].reverse()) {
      reversed[key] = FIXED_INPUTS[key as keyof typeof FIXED_INPUTS];
    }
    expect(Object.keys(reversed)).not.toStrictEqual(Object.keys(FIXED_INPUTS));
    expect(inputsHashOf(reversed)).toBe(PINNED_HASH);

    const shuffled = {
      sigma: 0.2,
      kind: 'call',
      s: 100,
      t: 1,
      q: 0,
      style: 'european',
      k: 100,
      r: 0.05,
    };
    expect(inputsHashOf(shuffled)).toBe(PINNED_HASH);
    expect(moneyness(shuffled as BsmInputs, VALUATION_TS).inputsHash).toBe(PINNED_HASH);
  });

  it('sorts nested object keys too', () => {
    const a = { node: { t: 1, df: 0.95 }, id: 'USD.OIS' };
    const b = { id: 'USD.OIS', node: { df: 0.95, t: 1 } };
    expect(inputsHashOf(a)).toBe(inputsHashOf(b));
  });

  it('does NOT reorder arrays — a curve node list is ordered data', () => {
    expect(inputsHashOf({ nodes: [1, 2] })).not.toBe(inputsHashOf({ nodes: [2, 1] }));
  });
});

// ---------------------------------------------------------------------------------------------
// 4. valuationTs
// ---------------------------------------------------------------------------------------------

describe('valuationTs', () => {
  it('is echoed verbatim and exposed to the engine as a calendar date', () => {
    const result = moneyness(FIXED_INPUTS, VALUATION_TS);
    expect(result.valuationTs).toBe(VALUATION_TS);
    expect(result.outputs.valuationDate).toBe('2026-09-15');
  });

  it('is deliberately NOT part of inputsHash (the tables carry the date in its own column)', () => {
    const a = moneyness(FIXED_INPUTS, '2026-09-15');
    const b = moneyness(FIXED_INPUTS, '2026-09-16T13:30:00-04:00');
    expect(b.inputsHash).toBe(a.inputsHash);
    expect(b.valuationTs).not.toBe(a.valuationTs);
  });

  it('accepts ISO 8601 dates and datetimes, and rejects impossible ones', () => {
    expect(valuationDateOf('2024-02-29')).toBe('2024-02-29'); // leap year
    expect(valuationDateOf('2026-09-15T20:00:00.123456Z')).toBe('2026-09-15');
    expect(valuationDateOf('2026-09-15T24:00:00Z')).toBe('2026-09-15'); // end of day is legal
    expect(() => valuationDateOf('2026-02-30')).toThrow(/day out of range/);
    expect(() => valuationDateOf('2025-02-29')).toThrow(/day out of range/);
    expect(() => valuationDateOf('2026-13-01')).toThrow(/month out of range/);
    expect(() => valuationDateOf('2026-09-15T25:00:00Z')).toThrow(/time out of range/);
    expect(() => valuationDateOf('15/09/2026')).toThrow(/ISO 8601/);
    expect(() => valuationDateOf('')).toThrow(/ISO 8601/);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. The declared input set is the set the function read (TESTING §7.11's recording Proxy)
// ---------------------------------------------------------------------------------------------

describe('declared inputs vs read inputs', () => {
  it('reports exactly the keys the engine function read', () => {
    const result = moneyness(FIXED_INPUTS, VALUATION_TS, { recordReads: true });
    expect(result.inputsRead).toStrictEqual(['k', 'q', 'r', 's', 'sigma', 't']);
    // The harness owns the Proxy, so canonicalisation — which reads every key — cannot pollute it.
    expect(result.inputsRead).not.toContain('style');
    expect(Object.keys(result.inputs).sort()).toStrictEqual([
      'k',
      'kind',
      'q',
      'r',
      's',
      'sigma',
      'style',
      't',
    ]);
    // The declared set is a superset of the read set, and the hash covers the declared set.
    for (const key of result.inputsRead ?? []) expect(result.inputs).toHaveProperty(key);
    expect(result.inputsHash).toBe(PINNED_HASH);
  });

  it('omits inputsRead entirely unless asked for it', () => {
    expect(moneyness(FIXED_INPUTS, VALUATION_TS).inputsRead).toBeUndefined();
  });

  it('records reads without changing the result', () => {
    const plain = moneyness(FIXED_INPUTS, VALUATION_TS);
    const recorded = moneyness(FIXED_INPUTS, VALUATION_TS, { recordReads: true });
    expect(recorded.outputs).toStrictEqual(plain.outputs);
    expect(recorded.inputsHash).toBe(plain.inputsHash);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. The envelope: identity, immutability, PayloadMeta.engines
// ---------------------------------------------------------------------------------------------

describe('EngineResult envelope', () => {
  it('carries a semver-shaped version and a dotted engine name', () => {
    const result = moneyness(FIXED_INPUTS, VALUATION_TS);
    expect(result.engine.name).toBe('test.moneyness');
    expect(result.engine.version).toBe('1.2.3');
    expect(result.engine.version).toMatch(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    );
    expect(moneyness.name).toBe('test.moneyness');
    expect(moneyness.version).toBe('1.2.3');
  });

  it('exposes the same call as `run`', () => {
    const viaRun = moneyness.run(FIXED_INPUTS, VALUATION_TS);
    expect(viaRun.inputsHash).toBe(PINNED_HASH);
    expect(viaRun.outputs).toStrictEqual(moneyness(FIXED_INPUTS, VALUATION_TS).outputs);
  });

  it('rejects a malformed name or version at definition time', () => {
    expect(() => defineEngine('Bond.Price', '1.0.0', () => 0)).toThrow(/lowercase dotted/);
    expect(() => defineEngine('bond price', '1.0.0', () => 0)).toThrow(/lowercase dotted/);
    expect(() => defineEngine('bond.price', '1.0', () => 0)).toThrow(/semver/);
    expect(() => defineEngine('bond.price', 'v1.0.0', () => 0)).toThrow(/semver/);
    expect(() => defineEngine('bond.price', '1.0.0-rc.1', () => 0)).not.toThrow();
  });

  it('freezes the inputs snapshot, so an engine cannot mutate what identifies it', () => {
    const mutator = defineEngine('test.mutator', '1.0.0', (i: Record<string, unknown>) => {
      expect(() => {
        (i as { s: number }).s = 1;
      }).toThrow(TypeError);
      return { ok: true };
    });
    const live = { s: 100 };
    const result = mutator(live, VALUATION_TS);
    expect(result.outputs.ok).toBe(true);
    expect(live.s).toBe(100);
    expect(Object.isFrozen(result.inputs)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('snapshots the inputs, so a later mutation by the caller cannot re-point the hash', () => {
    const live = { s: 100, k: 100 };
    const result = moneyness(live as BsmInputs, VALUATION_TS);
    const before = result.inputsHash;
    live.s = 1;
    expect(result.inputs.s).toBe(100);
    expect(result.inputsHash).toBe(before);
  });

  it('rejects a non-object input set', () => {
    expect(() => moneyness([1, 2] as unknown as BsmInputs, VALUATION_TS)).toThrow(/plain object/);
    expect(() => moneyness(null as unknown as BsmInputs, VALUATION_TS)).toThrow(/plain object/);
  });

  it('projects to the PayloadMeta.engines entry', () => {
    expect(engineMeta(moneyness(FIXED_INPUTS, VALUATION_TS))).toStrictEqual({
      name: 'test.moneyness',
      version: '1.2.3',
      inputsHash: PINNED_HASH,
    });
  });

  it('echoes the Conventions object in the outputs (ANAL-07)', () => {
    expect(moneyness(FIXED_INPUTS, VALUATION_TS).outputs.conventions).toStrictEqual({
      returns: 'simple',
      annualisation: 252,
      ddof: 1,
      dayCount: 'ACT/365F',
    });
  });
});
