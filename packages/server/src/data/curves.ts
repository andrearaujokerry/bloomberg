/**
 * `data/curves.ts` — the curve reader surface (WORKPLAN §WP-04 L706-709, FUNCTIONS.md §1.4.2 L303,
 * FUNCTIONS_TIER3 §0.1).
 *
 * Two methods, both as-of `(validAt, knownAt)`:
 *
 *  - `points(curveId, date?)` — the published inputs of one curve date, one row per
 *    `(tenor, quote_type)`, each the newest **vintage** whose `vintage_at ≤ knownAt`. A revision
 *    published after `knownAt` is invisible, so a past-dated read returns the numbers as they stood
 *    (DATA-10, REF-03). `is_latest` is not used for the point-in-time read — it is the
 *    "now" shortcut and would leak a later vintage into an earlier `knownAt`.
 *  - `build(curveId, date, interpolation?)` — a bootstrapped curve, **cached in `curve_builds`
 *    keyed on `inputs_hash`** (ANAL-08). The hash is computed from the engine input object before
 *    the engine runs (`inputsHashOf` is the same pure function `defineEngine` applies), so a
 *    repeat build with identical inputs is answered from the stored row and the bootstrap is never
 *    entered a second time. The cached row's `nodes` are re-hydrated into a live `Curve` with
 *    `makeCurve`, which needs only `(t, df)` — so the cache is a genuine store of the result, not
 *    a hint.
 *
 * ### Units
 *
 * `curve_points.value` is **percent**, exactly as Treasury and the Fed publish it, and is handed to
 * the engines in percent (they convert once, internally). `CurveBuild.nodes` is
 * `Curve.snapshot()` **verbatim** — `zero` and `fwd` are **decimal fractions per annum**, not
 * percent. That is the unit `core/analytics/curve/curve.ts` documents for `curve_builds.nodes`
 * ("Exactly what `curve_builds.nodes` stores") and the only one that round-trips through
 * `makeCurve`/`rateFromDf`. FUNCTIONS_TIER3 §0.1's inline comment says "zero/fwd in percent"; that
 * comment is inconsistent with the core declaration and is not what this module writes. A consumer
 * that wants percent multiplies by 100 at the render boundary. Flagged for §18.
 *
 * Provenance: every point carries its own `provenanceId` + `capturedAt` + `sourceTs`, and every
 * build carries the sorted distinct `provenanceIds` of the points it consumed, so the runner can
 * build `PayloadMeta.provenance[]` without a second query.
 */

import { inputsHashOf } from '@terminal/core/analytics/engine';
import {
  bootstrapOisCurve,
  bootstrapParCurve,
  oisCurveBootstrapEngine,
  parCurveBootstrapEngine,
} from '@terminal/core/analytics/curve/bootstrap';
import { isCompoundingName, makeCurve } from '@terminal/core/analytics/curve/curve';
import { isDayCountId } from '@terminal/core/daycount/conventions';
import { sql } from 'drizzle-orm';

import type { CompoundingName, InterpolationName } from '@terminal/core/analytics/engine';
import type {
  BillQuote,
  OisBootstrapInputs,
  OisFixing,
  OisQuote,
  ParBootstrapInputs,
  ParQuote,
} from '@terminal/core/analytics/curve/bootstrap';
import type { Curve, CurveNode } from '@terminal/core/analytics/curve/curve';
import type { DayCountId } from '@terminal/core/daycount/conventions';
import type { AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes (FUNCTIONS_TIER3 §0.1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `curves.kind`. */
export type CurveKind = 'par' | 'bill' | 'cmt' | 'fixing' | 'ois' | 'zero';

/** `curve_points.quote_type`. */
export type QuoteType =
  | 'par_yield'
  | 'discount_rate'
  | 'investment_yield'
  | 'cmt_yield'
  | 'ois_rate'
  | 'zero_rate'
  | 'fixing';

/** `curve_builds.method`. */
export type CurveMethod = 'bills+par_bootstrap' | 'ois_bootstrap';

/** One published curve input, with its own provenance. */
export interface CurvePoint {
  tenor: string;
  tenorDays: number;
  quoteType: QuoteType;
  /** Percent, as published. */
  value: number;
  /** On-the-run bill/note for the tenor when known. */
  instrumentId: number | null;
  maturityDate: string | null;
  vintageAt: string;
  provenanceId: number;
  capturedAt: string;
  sourceTs: string | null;
}

/** `DataServices.curves.points` result. */
export interface CurvePoints {
  curveId: string;
  name: string;
  currency: string;
  kind: CurveKind;
  dayCount: string;
  compounding: CompoundingName;
  sourceId: string;
  defaultInterpolation: string;
  /** The date actually served: ≤ the requested date, the latest stored when none was asked for. */
  curveDate: string;
  points: CurvePoint[];
  /** Curve dates stored for this curve, descending, ≤ 400. */
  availableDates: string[];
}

/** One input as `curve_builds.inputs` records it. */
export interface CurveBuildInput {
  tenor: string;
  tenorDays: number;
  quoteType: QuoteType;
  /** Percent. */
  value: number;
  /** True when the point's own source is `internal.derived` (the SOFR_OIS proxies). */
  proxy: boolean;
  sourceId: string;
  provenanceId: number;
}

/** `DataServices.curves.build` result. */
export interface CurveBuild {
  buildId: number;
  curveId: string;
  curveDate: string;
  valuationTs: string;
  method: CurveMethod;
  interpolation: string;
  engine: { name: string; version: string; inputsHash: string };
  inputs: CurveBuildInput[];
  /** `[{t, df, zero, fwd}]` — `t` in years on the curve's day count; `zero`/`fwd` **decimal**. */
  nodes: CurveNode[];
  provenanceIds: number[];
  /** The live curve: `df(t)`, `zero(t)`, `fwd(t1,t2)`, `snapshot()`. */
  curve: Curve;
  /**
   * **Addition to FUNCTIONS_TIER3 §0.1 (§18).** `true` when this result came out of `curve_builds`
   * rather than out of the bootstrap. Optional, so a consumer typed to the published `CurveBuild`
   * is unaffected; the cache test asserts on it, and a resolver may surface it as a `CACHED` badge.
   */
  cached?: boolean;
}

/** Raised instead of returning a half-built curve. */
export class CurveDataError extends Error {
  readonly code: 'curve_not_found' | 'no_points' | 'bad_definition' | 'hash_mismatch';
  constructor(code: CurveDataError['code'], message: string) {
    super(message);
    this.name = 'CurveDataError';
    this.code = code;
  }
}

/** The service as `DataServices.curves` declares it. */
export interface CurvesService {
  points(curveId: string, date?: string): Promise<CurvePoints>;
  build(curveId: string, date: string, interpolation?: string): Promise<CurveBuild>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small conversions
// ─────────────────────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, what: string): string {
  if (!DATE_RE.test(value)) {
    throw new RangeError(`data/curves: ${what} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** `numeric`/`bigint` arrive as strings over the wire; `null` stays `null`. */
function num(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

function reqNum(value: string | number | null, what: string): number {
  const n = num(value);
  if (n === null || !Number.isFinite(n)) {
    throw new CurveDataError('bad_definition', `data/curves: ${what} is not a finite number`);
  }
  return n;
}

/** A `timestamptz` as pg returns it (Date) or as jsonb holds it (string) → ISO 8601. */
function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function reqIso(value: Date | string | null, what: string): string {
  const s = iso(value);
  if (s === null) throw new CurveDataError('bad_definition', `data/curves: ${what} is null`);
  return s;
}

/** The UTC calendar date of an instant — the default curve date of an as-of read. */
function dateOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

const INTERPOLATIONS: readonly InterpolationName[] = [
  'linear_zero',
  'log_linear_df',
  'monotone_convex',
];

function interpolationOf(value: string, what: string): InterpolationName {
  const hit = INTERPOLATIONS.find((name) => name === value);
  if (hit === undefined) {
    throw new CurveDataError(
      'bad_definition',
      `data/curves: ${what} must be one of ${INTERPOLATIONS.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return hit;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Curve definition
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A `curves` row. */
export interface CurveDefinition {
  curveId: string;
  name: string;
  currency: string;
  kind: CurveKind;
  dayCount: DayCountId;
  compounding: CompoundingName;
  sourceId: string;
  defaultInterpolation: InterpolationName;
}

type CurveRow = {
  curve_id: string;
  name: string;
  currency: string;
  kind: string;
  day_count: string;
  compounding: string;
  source_id: string;
  default_interpolation: string;
};

const CURVE_KINDS: readonly CurveKind[] = ['par', 'bill', 'cmt', 'fixing', 'ois', 'zero'];

/** The `curves` row for `curveId`. @throws CurveDataError when there is none. */
export async function curveDefinition(tx: Tx, curveId: string): Promise<CurveDefinition> {
  const res = await tx.execute<CurveRow>(sql`
    SELECT curve_id, name, currency, kind, day_count, compounding, source_id, default_interpolation
      FROM curves
     WHERE curve_id = ${curveId}`);
  const row = res.rows[0];
  if (row === undefined) {
    throw new CurveDataError('curve_not_found', `data/curves: no curve '${curveId}'`);
  }
  const kind = CURVE_KINDS.find((k) => k === row.kind);
  if (kind === undefined) {
    throw new CurveDataError('bad_definition', `data/curves: unknown kind '${row.kind}'`);
  }
  if (!isDayCountId(row.day_count)) {
    throw new CurveDataError(
      'bad_definition',
      `data/curves: '${curveId}' day_count '${row.day_count}' is not a core DayCountId`,
    );
  }
  if (!isCompoundingName(row.compounding)) {
    throw new CurveDataError(
      'bad_definition',
      `data/curves: '${curveId}' compounding '${row.compounding}' is not a core CompoundingName`,
    );
  }
  return {
    curveId: row.curve_id,
    name: row.name,
    currency: row.currency,
    kind,
    dayCount: row.day_count,
    compounding: row.compounding,
    sourceId: row.source_id,
    defaultInterpolation: interpolationOf(row.default_interpolation, 'default_interpolation'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Points
// ─────────────────────────────────────────────────────────────────────────────────────────────

type PointRow = {
  tenor: string;
  tenor_days: number;
  quote_type: string;
  value: string;
  instrument_id: string | null;
  maturity_date: string | null;
  vintage_at: Date;
  provenance_id: string;
  captured_at: Date;
  source_ts: Date | null;
  source_id: string;
};

const QUOTE_TYPES: readonly QuoteType[] = [
  'par_yield',
  'discount_rate',
  'investment_yield',
  'cmt_yield',
  'ois_rate',
  'zero_rate',
  'fixing',
];

function quoteTypeOf(value: string): QuoteType {
  const hit = QUOTE_TYPES.find((q) => q === value);
  if (hit === undefined) {
    throw new CurveDataError('bad_definition', `data/curves: unknown quote_type '${value}'`);
  }
  return hit;
}

/**
 * The greatest `curve_date ≤ onOrBefore` that has at least one point known at `knownAt`.
 * `null` when the curve has never published anything by then.
 */
export async function latestCurveDate(
  tx: Tx,
  curveId: string,
  onOrBefore: string,
  knownAt: Date,
): Promise<string | null> {
  const res = await tx.execute<{ d: string | null }>(sql`
    SELECT max(curve_date)::text AS d
      FROM curve_points
     WHERE curve_id = ${curveId}
       AND curve_date <= ${assertDate(onOrBefore, 'date')}::date
       AND vintage_at <= ${knownAt}::timestamptz`);
  return res.rows[0]?.d ?? null;
}

/**
 * One row per `(tenor, quote_type)` for `curveDate`: the newest vintage known at `knownAt`,
 * ascending in `tenor_days`.
 */
export async function pointsOn(
  tx: Tx,
  curveId: string,
  curveDate: string,
  knownAt: Date,
): Promise<CurvePoint[]> {
  const rows = await pointsWithSource(tx, curveId, curveDate, knownAt);
  return rows.map((row) => {
    const point: CurvePoint = {
      tenor: row.tenor,
      tenorDays: row.tenorDays,
      quoteType: row.quoteType,
      value: row.value,
      instrumentId: row.instrumentId,
      maturityDate: row.maturityDate,
      vintageAt: row.vintageAt,
      provenanceId: row.provenanceId,
      capturedAt: row.capturedAt,
      sourceTs: row.sourceTs,
    };
    return point;
  });
}

/** The same read, keeping `source_id` (needed for `CurveBuildInput.proxy`). */
async function pointsWithSource(
  tx: Tx,
  curveId: string,
  curveDate: string,
  knownAt: Date,
): Promise<(CurvePoint & { sourceId: string })[]> {
  const res = await tx.execute<PointRow>(sql`
    SELECT DISTINCT ON (cp.tenor, cp.quote_type)
           cp.tenor, cp.tenor_days, cp.quote_type, cp.value::text AS value,
           cp.instrument_id::text AS instrument_id, cp.maturity_date::text AS maturity_date,
           cp.vintage_at, cp.provenance_id::text AS provenance_id,
           p.captured_at, p.source_ts, p.source_id
      FROM curve_points cp
      JOIN provenance p ON p.provenance_id = cp.provenance_id
     WHERE cp.curve_id = ${curveId}
       AND cp.curve_date = ${assertDate(curveDate, 'curveDate')}::date
       AND cp.vintage_at <= ${knownAt}::timestamptz
     ORDER BY cp.tenor, cp.quote_type, cp.vintage_at DESC`);
  return res.rows
    .map((row) => ({
      tenor: row.tenor,
      tenorDays: Number(row.tenor_days),
      quoteType: quoteTypeOf(row.quote_type),
      value: reqNum(row.value, `point ${row.tenor} value`),
      instrumentId: row.instrument_id === null ? null : Number(row.instrument_id),
      maturityDate: row.maturity_date,
      vintageAt: reqIso(row.vintage_at, 'vintage_at'),
      provenanceId: Number(row.provenance_id),
      capturedAt: reqIso(row.captured_at, 'captured_at'),
      sourceTs: iso(row.source_ts),
      sourceId: row.source_id,
    }))
    .sort((a, b) => a.tenorDays - b.tenorDays || a.tenor.localeCompare(b.tenor));
}

/** The curve dates this curve has published as of `knownAt`, newest first, capped at 400. */
export async function availableDates(tx: Tx, curveId: string, knownAt: Date): Promise<string[]> {
  const res = await tx.execute<{ d: string }>(sql`
    SELECT DISTINCT curve_date::text AS d
      FROM curve_points
     WHERE curve_id = ${curveId}
       AND vintage_at <= ${knownAt}::timestamptz
     ORDER BY 1 DESC
     LIMIT 400`);
  return res.rows.map((row) => row.d);
}

/** `DataServices.curves.points`. */
export async function readPoints(
  tx: Tx,
  at: AsOf,
  curveId: string,
  date?: string,
): Promise<CurvePoints> {
  const definition = await curveDefinition(tx, curveId);
  const wanted = date === undefined ? dateOf(at.validAt) : assertDate(date, 'date');
  const curveDate = await latestCurveDate(tx, curveId, wanted, at.knownAt);
  if (curveDate === null) {
    throw new CurveDataError(
      'no_points',
      `data/curves: '${curveId}' has no points on or before ${wanted} known at ` +
        `${at.knownAt.toISOString()}`,
    );
  }
  return {
    curveId: definition.curveId,
    name: definition.name,
    currency: definition.currency,
    kind: definition.kind,
    dayCount: definition.dayCount,
    compounding: definition.compounding,
    sourceId: definition.sourceId,
    defaultInterpolation: definition.defaultInterpolation,
    curveDate,
    points: await pointsOn(tx, curveId, curveDate, at.knownAt),
    availableDates: await availableDates(tx, curveId, at.knownAt),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Build (ANAL-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Bill quote types: their `value` is a bank-discount rate. */
const BILL_QUOTES: ReadonlySet<QuoteType> = new Set<QuoteType>(['discount_rate']);
/** Par coupon quote types. `cmt_yield` is the constant-maturity par yield. */
const PAR_QUOTES: ReadonlySet<QuoteType> = new Set<QuoteType>(['par_yield', 'cmt_yield']);

/** `curves.kind` → the bootstrap that builds it. */
export function methodFor(kind: CurveKind): CurveMethod {
  return kind === 'ois' ? 'ois_bootstrap' : 'bills+par_bootstrap';
}

/** The provenance `source_id` that marks a derived (proxy) input — FUNCTIONS_TIER3 `PROXY_CURVE`. */
const DERIVED_SOURCE = 'internal.derived';

type BuildRow = {
  build_id: string;
  curve_id: string;
  curve_date: string;
  valuation_ts: Date;
  method: string;
  interpolation: string;
  engine_name: string;
  engine_version: string;
  inputs_hash: string;
  inputs: unknown;
  nodes: unknown;
  provenance_ids: string[] | null;
};

/** What this module stores in `curve_builds.inputs`: the served inputs *and* the hashed object. */
interface StoredInputs {
  points: CurveBuildInput[];
  engine: Record<string, unknown>;
}

function nodesOf(value: unknown, curveId: string): CurveNode[] {
  if (!Array.isArray(value)) {
    throw new CurveDataError(
      'bad_definition',
      `data/curves: '${curveId}' build nodes are not an array`,
    );
  }
  return value.map((node, i) => {
    if (node === null || typeof node !== 'object') {
      throw new CurveDataError(
        'bad_definition',
        `data/curves: '${curveId}' node ${i} is not an object`,
      );
    }
    const n = node as Record<string, unknown>;
    const pick = (key: string): number => {
      const v = n[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new CurveDataError(
          'bad_definition',
          `data/curves: '${curveId}' node ${i}.${key} is not a finite number`,
        );
      }
      return v;
    };
    return { t: pick('t'), df: pick('df'), zero: pick('zero'), fwd: pick('fwd') };
  });
}

function storedInputsOf(value: unknown, curveId: string): StoredInputs {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CurveDataError(
      'bad_definition',
      `data/curves: '${curveId}' build inputs are malformed`,
    );
  }
  const v = value as { points?: unknown; engine?: unknown };
  if (!Array.isArray(v.points)) {
    throw new CurveDataError(
      'bad_definition',
      `data/curves: '${curveId}' build inputs.points missing`,
    );
  }
  return {
    points: v.points as CurveBuildInput[],
    engine: (v.engine ?? {}) as Record<string, unknown>,
  };
}

function hydrate(row: BuildRow, definition: CurveDefinition): CurveBuild {
  const nodes = nodesOf(row.nodes, definition.curveId);
  const interpolation = interpolationOf(row.interpolation, 'curve_builds.interpolation');
  const stored = storedInputsOf(row.inputs, definition.curveId);
  const curve = makeCurve({
    curveId: definition.curveId,
    curveDate: row.curve_date,
    dayCount: definition.dayCount,
    compounding: definition.compounding,
    interpolation,
    points: nodes.map((n) => ({ t: n.t, df: n.df })),
  });
  const method: CurveMethod =
    row.method === 'ois_bootstrap' ? 'ois_bootstrap' : 'bills+par_bootstrap';
  return {
    buildId: Number(row.build_id),
    curveId: row.curve_id,
    curveDate: row.curve_date,
    valuationTs: reqIso(row.valuation_ts, 'valuation_ts'),
    method,
    interpolation,
    engine: {
      name: row.engine_name,
      version: row.engine_version,
      inputsHash: row.inputs_hash,
    },
    inputs: stored.points,
    nodes,
    provenanceIds: (row.provenance_ids ?? []).map(Number),
    curve,
    cached: true,
  };
}

/** The cached build for this exact key, or `null`. */
async function findBuild(
  tx: Tx,
  key: {
    curveId: string;
    curveDate: string;
    method: CurveMethod;
    interpolation: InterpolationName;
    engineVersion: string;
    inputsHash: string;
  },
): Promise<BuildRow | null> {
  const res = await tx.execute<BuildRow>(sql`
    SELECT build_id::text AS build_id, curve_id, curve_date::text AS curve_date, valuation_ts,
           method, interpolation, engine_name, engine_version, inputs_hash, inputs, nodes,
           provenance_ids::text[] AS provenance_ids
      FROM curve_builds
     WHERE curve_id = ${key.curveId}
       AND curve_date = ${key.curveDate}::date
       AND method = ${key.method}
       AND interpolation = ${key.interpolation}
       AND engine_version = ${key.engineVersion}
       AND inputs_hash = ${key.inputsHash}
     LIMIT 1`);
  return res.rows[0] ?? null;
}

/**
 * Build (or fetch the cached build of) `curveId` on `date`.
 *
 * The cache lookup happens **before** the bootstrap: `inputsHashOf(engineInputs)` is the same pure
 * function `defineEngine` applies to the same object, so the key is known without running the
 * engine. A hit returns the stored nodes re-hydrated through `makeCurve`; a miss bootstraps, stores
 * and returns. The `ON CONFLICT DO NOTHING` + re-select makes two concurrent builders converge on
 * one row rather than raising `23505` on the unique key.
 */
export async function buildCurve(
  tx: Tx,
  at: AsOf,
  curveId: string,
  date: string,
  interpolation?: string,
): Promise<CurveBuild> {
  const definition = await curveDefinition(tx, curveId);
  const wanted = assertDate(date, 'date');
  const curveDate = await latestCurveDate(tx, curveId, wanted, at.knownAt);
  if (curveDate === null) {
    throw new CurveDataError(
      'no_points',
      `data/curves: '${curveId}' has no points on or before ${wanted} known at ` +
        `${at.knownAt.toISOString()}`,
    );
  }
  const interp =
    interpolation === undefined
      ? definition.defaultInterpolation
      : interpolationOf(interpolation, 'interpolation');
  const method = methodFor(definition.kind);
  const points = await pointsWithSource(tx, curveId, curveDate, at.knownAt);
  if (points.length === 0) {
    throw new CurveDataError(
      'no_points',
      `data/curves: '${curveId}' has no points on ${curveDate}`,
    );
  }

  const inputRows: CurveBuildInput[] = [];
  const engineInputs =
    method === 'ois_bootstrap'
      ? oisInputsOf(definition, curveDate, interp, points, inputRows)
      : parInputsOf(definition, curveDate, interp, points, inputRows);
  if (inputRows.length === 0) {
    throw new CurveDataError(
      'no_points',
      `data/curves: '${curveId}' on ${curveDate} has no point of a quote_type the ${method} ` +
        'engine consumes',
    );
  }

  const inputsHash = inputsHashOf(engineInputs);
  const engineVersion =
    method === 'ois_bootstrap' ? oisCurveBootstrapEngine.version : parCurveBootstrapEngine.version;

  const cached = await findBuild(tx, {
    curveId,
    curveDate,
    method,
    interpolation: interp,
    engineVersion,
    inputsHash,
  });
  if (cached !== null) return hydrate(cached, definition);

  // Miss: run the bootstrap. `valuationTs` is the curve date at UTC midnight so that two runs at
  // different wall clocks produce the same row (ANAL-08 reproducibility); `built_at` records when.
  const valuationTs = `${curveDate}T00:00:00.000Z`;
  const result =
    method === 'ois_bootstrap'
      ? bootstrapOisCurve(engineInputs as OisBootstrapInputs, valuationTs)
      : bootstrapParCurve(engineInputs as ParBootstrapInputs, valuationTs);
  if (result.inputsHash !== inputsHash) {
    throw new CurveDataError(
      'hash_mismatch',
      `data/curves: the cache key ${inputsHash} does not match the engine's ${result.inputsHash}; ` +
        'the build would be stored under a key it can never be found by',
    );
  }
  const nodes = result.outputs.curve.snapshot();
  const provenanceIds = [...new Set(inputRows.map((row) => row.provenanceId))].sort(
    (a, b) => a - b,
  );
  const stored: StoredInputs = { points: inputRows, engine: engineInputs };

  await tx.execute(sql`
    INSERT INTO curve_builds (curve_id, curve_date, valuation_ts, method, interpolation,
                              engine_name, engine_version, inputs_hash, inputs, nodes,
                              provenance_ids)
    VALUES (${curveId}, ${curveDate}::date, ${valuationTs}::timestamptz, ${method}, ${interp},
            ${result.engine.name}, ${result.engine.version}, ${inputsHash},
            ${JSON.stringify(stored)}::jsonb, ${JSON.stringify(nodes)}::jsonb,
            ${sql.raw(`ARRAY[${provenanceIds.join(',')}]::bigint[]`)})
    ON CONFLICT (curve_id, curve_date, method, interpolation, engine_version, inputs_hash)
    DO NOTHING`);

  const written = await findBuild(tx, {
    curveId,
    curveDate,
    method,
    interpolation: interp,
    engineVersion: result.engine.version,
    inputsHash,
  });
  if (written === null) {
    throw new CurveDataError(
      'bad_definition',
      `data/curves: the build of '${curveId}' ${curveDate} was inserted but cannot be read back`,
    );
  }
  return { ...hydrate(written, definition), curve: result.outputs.curve, cached: false };
}

/** Points → `ParBootstrapInputs`, recording what was actually consumed. */
function parInputsOf(
  definition: CurveDefinition,
  curveDate: string,
  interpolation: InterpolationName,
  points: readonly (CurvePoint & { sourceId: string })[],
  consumed: CurveBuildInput[],
): ParBootstrapInputs {
  const bills: BillQuote[] = [];
  const parQuotes: ParQuote[] = [];
  for (const point of points) {
    if (BILL_QUOTES.has(point.quoteType)) {
      bills.push({ tenor: point.tenor, days: point.tenorDays, discountRate: point.value });
    } else if (PAR_QUOTES.has(point.quoteType)) {
      parQuotes.push({ tenor: point.tenor, parRate: point.value });
    } else {
      continue;
    }
    consumed.push(toBuildInput(point));
  }
  const inputs: ParBootstrapInputs = {
    curveId: definition.curveId,
    curveDate,
    parQuotes,
    ...(bills.length > 0 ? { bills } : {}),
    dayCount: definition.dayCount,
    compounding: definition.compounding,
    interpolation,
  };
  return inputs;
}

/** Points → `OisBootstrapInputs`, recording what was actually consumed. */
function oisInputsOf(
  definition: CurveDefinition,
  curveDate: string,
  interpolation: InterpolationName,
  points: readonly (CurvePoint & { sourceId: string })[],
  consumed: CurveBuildInput[],
): OisBootstrapInputs {
  const fixings: OisFixing[] = [];
  const quotes: OisQuote[] = [];
  for (const point of points) {
    if (point.quoteType === 'fixing') {
      // The overnight fixing anchors the short end; its "tenor date" is the curve date itself.
      fixings.push({ date: curveDate, rate: point.value });
    } else if (point.quoteType === 'ois_rate') {
      quotes.push({ tenor: point.tenor, parRate: point.value });
    } else {
      continue;
    }
    consumed.push(toBuildInput(point));
  }
  return {
    curveId: definition.curveId,
    curveDate,
    fixings,
    quotes,
    interpolation,
  };
}

function toBuildInput(point: CurvePoint & { sourceId: string }): CurveBuildInput {
  return {
    tenor: point.tenor,
    tenorDays: point.tenorDays,
    quoteType: point.quoteType,
    value: point.value,
    proxy: point.sourceId === DERIVED_SOURCE,
    sourceId: point.sourceId,
    provenanceId: point.provenanceId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `DataServices.curves`, bound to one transaction and one `(validAt, knownAt)` pair. */
export function curvesService(tx: Tx, at: AsOf): CurvesService {
  return {
    points: (curveId, date) => readPoints(tx, at, curveId, date),
    build: (curveId, date, interpolation) => buildCurve(tx, at, curveId, date, interpolation),
  };
}
