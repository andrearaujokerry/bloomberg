/**
 * The analytics engine harness — WORKPLAN §WP-02 L489-492, ARCHITECTURE L157-158, ANAL-07/ANAL-08.
 *
 * Every analytics module in `core/analytics/**` is wrapped in `defineEngine`, so that a result is
 * never a bare number: it carries the inputs it was computed from, the engine that computed it, the
 * valuation instant, and `inputsHash` — the `char(64)` written to `vol_surfaces.inputs_hash`,
 * `fin_statements.inputs_hash` and `curve_builds.inputs_hash`.
 *
 * `inputsHash = sha256Hex(canonicalJson(inputs))` (ANAL-08). Both halves are hand-written, pure and
 * dependency-free (`core/src/hash/*`), so the 64 characters are identical in every process, on every
 * machine and in every release: that is what makes the `curve_builds` uniqueness key
 * `(curve_id, curve_date, method, interpolation, engine_version, inputs_hash)` de-duplicate an
 * identical rebuild instead of piling up near-duplicate rows (TESTING §7.11).
 *
 * Deliberate design points:
 *
 *  - **`valuationTs` is not part of the hash.** The tables that store `inputs_hash` all carry the
 *    valuation date in their own column (`curve_builds.curve_date`, `vol_surfaces.surface_date`),
 *    and the uniqueness key is the pair. An engine whose *result* genuinely depends on the instant
 *    (rather than on the dated inputs it was handed) puts that instant into `inputs` explicitly.
 *  - **Inputs are snapshotted, shallowly.** `run` copies the caller's own enumerable keys into a
 *    frozen object and hands that to the engine function, so an engine cannot mutate the record it
 *    is about to be identified by. The copy is shallow on purpose: deep-freezing would freeze the
 *    caller's own arrays and objects, which `run` has no business doing.
 *  - **`recordReads`** wraps that snapshot in a recording `Proxy` and reports the keys the engine
 *    function actually read as `EngineResult.inputsRead`. TESTING §7.11 asserts "the declared input
 *    set in `EngineResult.inputs` is exactly the set the function read (asserted with a recording
 *    Proxy over the input object)"; the harness owns the Proxy so that the canonicalisation pass —
 *    which by construction reads every key — cannot pollute the recording.
 *  - **No clock.** The valuation instant is a parameter, never `Date.now()`; nothing in this file
 *    reads ambient time (ARCHITECTURE L49).
 */

import { canonicalJson } from '../hash/canonicalJson.js';
import { sha256Hex } from '../hash/sha256.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Conventions (ANAL-07)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Return basis: arithmetic (`simple`) or continuously compounded (`log`). */
export type ReturnBasis = 'simple' | 'log';

/** Adjustment policy an analytic was computed on (mirrors `core/types/bars.ts`, REF-09). */
export type ConventionAdjust = 'unadjusted' | 'price' | 'total_return';

/** The exact six strings of the `govt_terms.day_count` CHECK, plus ICMA's parameterised form. */
export type DayCountName =
  'ACT/ACT' | 'ACT/360' | 'ACT/365F' | '30/360' | '30E/360' | 'ACT/ACT-ISDA' | 'ACT/ACT-ICMA';

/** The four `govt_terms.business_day_conv` values. */
export type BusinessDayConventionName = 'following' | 'modified_following' | 'preceding' | 'none';

/** The three `curves.default_interpolation` values. */
export type InterpolationName = 'linear_zero' | 'log_linear_df' | 'monotone_convex';

/** Rate compounding basis. */
export type CompoundingName = 'simple' | 'annual' | 'semiannual' | 'quarterly' | 'continuous';

/** Anything a convention may be: a scalar, so `Conventions` is always canonical-JSON safe. */
export type ConventionValue = string | number | boolean | null;

/**
 * The convention set that produced an output, echoed *inside* the output (ANAL-07: "explicit and
 * consistent conventions" is enforced structurally, not by documentation — TRACEABILITY ANAL-07).
 *
 * The well-known keys are typed; the index signature lets each engine family carry its own
 * (a bond echoes `dayCount`/`frequency`, a curve echoes `interpolation`, statistics echo the
 * FUNCTIONS_TIER1 L86 set `{ returns, priceBasis, adjust, annualisation, volWindow, betaBenchmark,
 * betaWindow }` plus `ddof`). Values stay scalar so a `Conventions` object round-trips through
 * `canonicalJson`, the payload and the CSV header unchanged.
 *
 * This module defines the *type*; each engine module exports its own frozen instance.
 */
export interface Conventions {
  readonly [key: string]: ConventionValue | undefined;

  /** Statistics (FUNCTIONS_TIER1 §0.6 L86, TESTING §7.8). */
  readonly returns?: ReturnBasis;
  readonly priceBasis?: string;
  readonly adjust?: ConventionAdjust;
  /** Periods per year used to annualise (252 trading days, 12 months, …). */
  readonly annualisation?: number;
  /** Degrees of freedom subtracted in a variance: 1 = sample, 0 = population (TESTING §17.17). */
  readonly ddof?: 0 | 1;
  readonly volWindow?: number;
  readonly betaBenchmark?: string;
  readonly betaWindow?: number;
  /** Annual simple risk-free rate used for excess return (TESTING §7.8 pins 0.02). */
  readonly riskFree?: number;

  /** Fixed income. */
  readonly dayCount?: DayCountName;
  readonly businessDayConvention?: BusinessDayConventionName;
  readonly calendar?: string;
  readonly compounding?: CompoundingName;
  /** Coupon frequency, payments per year. */
  readonly frequency?: number;
  readonly settlementDays?: number;
  readonly currency?: string;

  /** Curves and surfaces. */
  readonly interpolation?: InterpolationName;
  readonly extrapolation?: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Engine types
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** An engine's declared input set: a plain record, canonical-JSON representable (ANAL-08). */
export type EngineInputs = Readonly<Record<string, unknown>>;

/** The `{name, version}` pair echoed in `PayloadMeta.engines` (`core/types/function.ts`). */
export interface EngineIdentity {
  readonly name: string;
  readonly version: string;
}

/** What an engine function is handed besides its inputs. Deterministic: no clock, no IO. */
export interface EngineContext {
  /** The engine being run. */
  readonly engine: EngineIdentity;
  /** ISO 8601 valuation instant, exactly as the caller passed it. */
  readonly valuationTs: string;
  /** `valuationTs`'s calendar date, `YYYY-MM-DD` — the usual day-count anchor. */
  readonly valuationDate: string;
  /** `sha256Hex(canonicalJson(inputs))`, already computed when the function runs. */
  readonly inputsHash: string;
}

/** The body of an engine: pure, synchronous, total over its declared inputs. */
export type EngineFn<I extends EngineInputs, O> = (inputs: I, ctx: EngineContext) => O;

/** The result every analytics call returns (WORKPLAN L489-490). */
export interface EngineResult<I extends EngineInputs = EngineInputs, O = unknown> {
  /** The frozen snapshot of the declared input set that was hashed. */
  readonly inputs: I;
  /** Whatever the engine computed; echoes its `Conventions` (ANAL-07). */
  readonly outputs: O;
  readonly engine: EngineIdentity;
  readonly valuationTs: string;
  /** `char(64)` lowercase hex — `vol_surfaces`/`fin_statements`/`curve_builds`.`inputs_hash`. */
  readonly inputsHash: string;
  /**
   * Present only when `run` was given `{ recordReads: true }`: the sorted input keys the engine
   * function actually read, for the TESTING §7.11 "declared set === read set" assertion.
   */
  readonly inputsRead?: readonly string[];
}

/** Per-call options. */
export interface EngineRunOptions {
  /** Record which input keys the engine function reads; see `EngineResult.inputsRead`. */
  readonly recordReads?: boolean;
}

/**
 * A defined engine. Callable for ergonomics (`bsmEngine(inputs, ts)`) and carrying an explicit
 * `run` for call sites that prefer the method form; both are the same function.
 */
export interface Engine<I extends EngineInputs = EngineInputs, O = unknown> {
  (inputs: I, valuationTs: string, options?: EngineRunOptions): EngineResult<I, O>;
  readonly name: string;
  readonly version: string;
  readonly run: (inputs: I, valuationTs: string, options?: EngineRunOptions) => EngineResult<I, O>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `bsm`, `bond.price`, `curve.bootstrap`, `wirp.policyPath` — lowercase, dotted segments. */
const ENGINE_NAME_RE = /^[a-z][a-z0-9]*(?:[.\-/][a-z0-9]+)*$/;

/** semver 2.0.0 (the official recommended regex, anchored). `engine.version` must match it. */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * ISO 8601: a calendar date, optionally with a time and a `Z`/`±HH:MM` offset. Parsed by hand —
 * `Date` is banned in this package, and a lenient `new Date(s)` would happily accept `'2026-02-30'`.
 */
const ISO_TS_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Validate an ISO 8601 valuation instant and return its `YYYY-MM-DD` date part.
 * Exported because every engine that takes a date string wants the same gate.
 */
export function valuationDateOf(valuationTs: string): string {
  const m = ISO_TS_RE.exec(valuationTs);
  const yyyy = m?.[1];
  const mm = m?.[2];
  const dd = m?.[3];
  if (m === null || yyyy === undefined || mm === undefined || dd === undefined) {
    throw new RangeError(
      `engine: valuationTs must be ISO 8601 ('2026-09-15' or '2026-09-15T20:00:00Z'), got '${valuationTs}'`,
    );
  }
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12) {
    throw new RangeError(`engine: valuationTs month out of range in '${valuationTs}'`);
  }
  const monthLength = DAYS_IN_MONTH[month - 1] ?? 31;
  const maxDay = month === 2 && isLeap(year) ? 29 : monthLength;
  if (day < 1 || day > maxDay) {
    throw new RangeError(`engine: valuationTs day out of range in '${valuationTs}'`);
  }
  const hh = m[4];
  if (hh !== undefined) {
    const hour = Number(hh);
    const minute = Number(m[5] ?? '0');
    const second = Number(m[6] ?? '0');
    // 24:00:00 is legal ISO 8601 (end of day); 23:59:60 is a leap second.
    const hourOk = hour < 24 || (hour === 24 && minute === 0 && second === 0);
    if (!hourOk || minute > 59 || second > 60) {
      throw new RangeError(`engine: valuationTs time out of range in '${valuationTs}'`);
    }
  }
  return `${yyyy}-${mm}-${dd}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// inputsHash (ANAL-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `sha256Hex(canonicalJson(inputs))` — the 64 lowercase hex characters stored in
 * `vol_surfaces.inputs_hash`, `fin_statements.inputs_hash` and `curve_builds.inputs_hash`.
 *
 * Key order in `inputs` is irrelevant (`canonicalJson` sorts); `undefined` members are dropped, so
 * `{a:1}` and `{a:1, b:undefined}` hash identically — an omitted optional is the same input as an
 * absent one. `NaN`, `±Infinity` and `bigint` throw rather than collapse onto each other.
 */
export function inputsHashOf(inputs: unknown): string {
  return sha256Hex(canonicalJson(inputs));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// defineEngine
// ─────────────────────────────────────────────────────────────────────────────────────────────

function recordingProxy<I extends EngineInputs>(inputs: I, read: Set<string>): I {
  return new Proxy(inputs, {
    get(target, key, receiver): unknown {
      if (typeof key === 'string') read.add(key);
      return Reflect.get(target, key, receiver);
    },
    has(target, key): boolean {
      if (typeof key === 'string') read.add(key);
      return Reflect.has(target, key);
    },
  });
}

/**
 * Wrap a pure analytic in the ANAL-08 envelope.
 *
 * @param name    engine id as it appears in `PayloadMeta.engines[].name` and in a golden case's
 *                `engine` field: lowercase, dotted (`'bsm'`, `'bond.price'`, `'curve.bootstrap'`).
 * @param version semver; a bump must re-bless every golden case pinned to the old one (§7.1).
 * @param fn      the analytic itself — pure, synchronous, no clock, no IO.
 *
 * @example
 * const bill = defineEngine('bill', '1.0.0', (i: { days: number; rate: number }) => ({
 *   price: 100 * (1 - (i.rate * i.days) / 360),
 *   conventions: { dayCount: 'ACT/360' } satisfies Conventions,
 * }));
 * const r = bill({ days: 28, rate: 0.0425 }, '2026-09-15');
 * r.inputsHash; // char(64), identical in every process
 */
export function defineEngine<I extends EngineInputs, O>(
  name: string,
  version: string,
  fn: EngineFn<I, O>,
): Engine<I, O> {
  if (!ENGINE_NAME_RE.test(name)) {
    throw new RangeError(
      `defineEngine: engine name must be lowercase dotted (e.g. 'bond.price'), got '${name}'`,
    );
  }
  if (!SEMVER_RE.test(version)) {
    throw new RangeError(`defineEngine: engine version must be semver, got '${version}'`);
  }
  if (typeof fn !== 'function') {
    throw new TypeError(`defineEngine: ${name} was given no engine function`);
  }

  const identity: EngineIdentity = Object.freeze({ name, version });

  const invoke = (
    inputs: I,
    valuationTs: string,
    options?: EngineRunOptions,
  ): EngineResult<I, O> => {
    if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
      throw new TypeError(`engine ${name}: inputs must be a plain object`);
    }
    const valuationDate = valuationDateOf(valuationTs);

    // Shallow snapshot: the engine is identified by exactly these own enumerable keys, and cannot
    // mutate them. Nested values are left alone — they belong to the caller.
    const snapshot = Object.freeze({ ...inputs }) as I;

    let inputsHash: string;
    try {
      inputsHash = inputsHashOf(snapshot);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new TypeError(
        `engine ${name}: inputs are not canonical-JSON representable — ${detail}`,
      );
    }

    const ctx: EngineContext = Object.freeze({
      engine: identity,
      valuationTs,
      valuationDate,
      inputsHash,
    });

    const read = options?.recordReads === true ? new Set<string>() : undefined;
    const seen = read === undefined ? snapshot : recordingProxy(snapshot, read);
    const outputs = fn(seen, ctx);

    if (outputs !== null && typeof outputs === 'object') Object.freeze(outputs);

    const result: EngineResult<I, O> = {
      inputs: snapshot,
      outputs,
      engine: identity,
      valuationTs,
      inputsHash,
      ...(read === undefined ? {} : { inputsRead: Object.freeze([...read].sort()) }),
    };
    return Object.freeze(result);
  };

  const engine = invoke as unknown as Engine<I, O>;
  Object.defineProperty(engine, 'name', { value: name, enumerable: false, configurable: true });
  Object.defineProperty(engine, 'version', {
    value: version,
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(engine, 'run', { value: invoke, enumerable: true, configurable: true });
  return Object.freeze(engine);
}

/** The `PayloadMeta.engines[]` entry for a result (`core/types/function.ts` `PayloadEngine`). */
export function engineMeta(result: EngineResult<EngineInputs, unknown>): {
  name: string;
  version: string;
  inputsHash: string;
} {
  return {
    name: result.engine.name,
    version: result.engine.version,
    inputsHash: result.inputsHash,
  };
}
