// packages/server/src/seed/curves.ts
//
// Seed module 7 of DATA_MODEL §18 (L2566): the five `curves` definitions, the ≈300 published
// `curve_points` they hang off, and the one `curve_builds` row §18 asks for — `SOFR_OIS` on the
// latest date.
//
// Four of the five curves and every *published* point are written by module 6: `UST_PAR` and
// `UST_BILL` by `jobs/treasuryCurves.ts` (9 curve dates × 14 par tenors, and 9 × 7 bill tenors ×
// two quote types), `UST_CMT` and `SOFR_FIX` by `jobs/fedRates.ts` (H.15's 4 published days × 11
// constant maturities, and the five SOFR fixings). Re-fetching those captures here would write the
// same rows a second time for no new information, so this module does the two things module 6
// cannot:
//
//   1. **`SOFR_OIS`** — the fifth curve. It is the only curve in the system with no published
//      inputs at all: no OIS swap quote and no futures price exists in any recorded capture
//      (BRIEF §2), which is why FUNCTIONS_TIER3 §0 brands every screen that uses it `PROXY_CURVE`
//      and `NO_OIS_SWAP_QUOTES_SOURCE`. FUNCTIONS_TIER3 §CRVF L288 is the normative construction
//      and {@link SOFR_OIS_PROXIES} transcribes it: `ON` is the SOFR fixing, `1M/3M/6M` are the
//      realised SOFRAI averages, `1Y` is the 52-week bill's investment yield on an ACT/360 basis,
//      and `2Y…30Y` are the Treasury par yields less a Treasury–OIS basis assumption of
//      {@link TREASURY_OIS_BASIS_BP} basis points. Every one of those rows is written with
//      `source_id 'internal.derived'`, which is what makes `CurveBuildInput.proxy` true and the
//      amber badge appear — a proxy that looked like a published quote would be the worst outcome
//      here, so the derivation is visible in the data and not only in a comment.
//   2. **the build** — `data/curves.ts#buildCurve`, which bootstraps and caches in `curve_builds`
//      keyed by `inputs_hash`. WP-11 owns that engine and the cache; this module calls it and
//      asserts nothing about the numbers it produces.
//
// ## Offline, deterministic, idempotent
//
// Nothing here fetches: the proxy inputs are read back out of `curve_points` and `rate_fixings`,
// which module 6 wrote from the captures, so the only files this module depends on are the ones
// already on disk. The derived points' `vintage_at` and their provenance row's `captured_at` are
// the **latest capture instant among the inputs**, never a wall clock, so the whole module is a
// function of the fixtures: `upsertCurvePoints` finds an identical value at an identical vintage on
// the second run and writes nothing, `buildCurve` finds its `inputs_hash` in `curve_builds` and
// re-hydrates rather than bootstrapping, and {@link derivedProvenance} re-uses the row it wrote
// last time unless an input actually changed (a changed input changes the hash, which is the point).
//
// A derived value with no provenance row would be a DATA-10 violation however obviously it was
// computed, so the derivation gets a real `provenance` row: `source_id 'internal.derived'`,
// `request_key 'derive:SOFR_OIS:<curveDate>'`, `http_status 0`, and `response_sha256` over the
// canonical JSON of the inputs it consumed — the same shape `providers/sim/feed.ts` uses for the
// simulated feed (PROVIDERS §4.3).
//
// ## Measured
//
// Against the committed fixtures this module writes the `SOFR_OIS` definition, its **twelve** points
// on 2026-09-14 (the date FUNCTIONS_TIER3 §0 L11 pins) and **one** `curve_builds` row of nine nodes;
// module 6's two jobs have already written the other four definitions and 301 published points, so
// `curve_points` holds 313 in total against §18's ≈300. Nine of the twelve points reach the
// bootstrap: the three realised SOFR averages are stored as curve inputs but cannot be bootstrapped,
// because `core/analytics/curve/bootstrap.ts`'s OIS engine has an annual fixed leg and rejects a
// sub-annual tenor outright (`oisScheduleOf: 1M is not a whole number of 1/yr fixed periods`). That
// is a gap in the engine, recorded at {@link SOFR_OIS_PROXIES} and worth a TRACEABILITY.md line, not
// something to work around by mislabelling a quote type.

import { canonicalJson } from '@terminal/core/hash/canonicalJson';
import { sha256Hex } from '@terminal/core/hash/sha256';

import { sql } from 'drizzle-orm';

import { buildCurve } from '../data/curves.js';
import { countTables, tableDeltas } from './rates.js';
import { insertProvenance } from '../providers/provenance.js';
import { ensureCurves, upsertCurvePoints } from '../ingest/jobs/treasuryCurves.js';
import { UST_BILL_CURVE_ID, UST_PAR_CURVE_ID } from '../providers/treasury/parse.js';

import type { Tx } from '../db/client.js';
import type { CurveDefinition, CurvePointWrite } from '../ingest/jobs/treasuryCurves.js';
import type { RawRecord } from '../providers/types.js';
import type { SeedContext } from './index.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The curve
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `curves.curve_id` of the derived OIS curve (DATA_MODEL L1477, CONTRACTS §1.2 L217). */
export const SOFR_OIS_CURVE_ID = 'SOFR_OIS';

/** `licence_registry.source_id` every derived value carries (PROVIDERS §15, §4.3). */
export const DERIVED_SOURCE_ID = 'internal.derived';

/** `provenance.adapter_version` of this module's derivation. */
export const CURVE_DERIVATION_VERSION = 'seed.curves/1.0.0';

/**
 * The Treasury–OIS basis assumed for the `2Y…30Y` proxy points, in basis points.
 *
 * Zero, and named rather than omitted: FUNCTIONS_TIER3 §CRVF L288 fixes the assumption at 0 bp, and
 * a magic `- 0` in the expression would hide the fact that an assumption is being made at all. The
 * real basis is not zero, which is exactly why the `PROXY_CURVE` badge is permanent.
 */
export const TREASURY_OIS_BASIS_BP = 0;

/**
 * `SOFR_OIS` as a `curves` row.
 *
 * `kind 'ois'` is what `data/curves.ts#methodFor` reads to pick `ois_bootstrap`; `day_count`
 * `ACT/360` and `compounding 'annual'` are the OIS conventions of FUNCTIONS_TIER3 §0 L23 (fixed
 * leg annual, ACT/360). `source_id` is `internal.derived` because that is the truth about where the
 * inputs come from, and `ensureCurves` inserts a definition once and never restates it — a change
 * to a curve's day count would silently re-price every stored build, so it is a migration.
 */
export const SOFR_OIS_DEFINITION: CurveDefinition = Object.freeze({
  curveId: SOFR_OIS_CURVE_ID,
  name: 'SOFR OIS (derived from proxies)',
  currency: 'USD',
  kind: 'ois',
  dayCount: 'ACT/360',
  compounding: 'annual',
  sourceId: DERIVED_SOURCE_ID,
  defaultInterpolation: 'monotone_convex',
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The proxy recipe — FUNCTIONS_TIER3 §CRVF L288, transcribed
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Where one `SOFR_OIS` point's value comes from. */
export type ProxyKind =
  /** The overnight SOFR fixing of the curve date (`rate_fixings.rate`). */
  | 'sofr_fixing'
  /** A realised SOFR average (`rate_fixings.avg_30d | avg_90d | avg_180d`). */
  | 'sofrai_average'
  /** The 52-week bill's investment yield, converted to an ACT/360 simple basis. */
  | 'bill_investment_yield'
  /** A Treasury par yield less {@link TREASURY_OIS_BASIS_BP}. */
  | 'par_yield';

export interface ProxyRecipe {
  /** `curve_points.tenor` of the point this produces. */
  readonly tenor: string;
  readonly kind: ProxyKind;
  /** `rate_fixings` column, source tenor, or `null` for the fixing itself. */
  readonly from: string | null;
  /** `curve_points.tenor_days`; the realised averages are 30/90/180 calendar days by definition. */
  readonly tenorDays: number;
  /**
   * `curve_points.quote_type`. The overnight anchor is a `fixing`, the par-swap-equivalent term
   * points are `ois_rate` — and the three realised SOFR averages are `zero_rate`, which is both
   * what they are and the reason the bootstrap does not consume them; see {@link SOFR_OIS_PROXIES}.
   */
  readonly quoteType: 'fixing' | 'ois_rate' | 'zero_rate';
  readonly note: string;
}

/**
 * The twelve points of the derived curve, in ascending tenor.
 *
 * `proxyOf` in FUNCTIONS_TIER3's table is the `note` here: the note documents the recipe, while the
 * *data* records the proxying through `source_id 'internal.derived'`, which is the field
 * `CurveBuild.inputs[].proxy` is computed from and the amber badge is driven by.
 *
 * **Why `1M/3M/6M` are `zero_rate` and not `ois_rate`.** `ois_rate` is the quote type
 * `data/curves.ts#oisInputsOf` hands to `core/analytics/curve/bootstrap.ts` as a *par swap* quote,
 * and that engine's fixed leg is annual (FUNCTIONS_TIER3 §0 L23), so it refuses any tenor that is
 * not a whole number of annual periods — `oisScheduleOf: 1M is not a whole number of 1/yr fixed
 * periods`. A 30-day realised SOFR average is not a par swap rate anyway: it is, in
 * FUNCTIONS_TIER3 L288's own words, "the term rate to that tenor", which is a zero rate. So the
 * three averages are stored as `zero_rate`, CRVF shows them among the curve's inputs where they
 * belong, and the bootstrap builds from the overnight fixing and the `1Y…30Y` points. The
 * consequence is real and is recorded rather than hidden: the built curve's 1M-6M region is
 * interpolated between `ON` and `1Y` instead of being pinned by the realised averages, because no
 * engine in this build can consume a sub-annual OIS point.
 */
export const SOFR_OIS_PROXIES: readonly ProxyRecipe[] = Object.freeze([
  {
    tenor: 'ON',
    kind: 'sofr_fixing',
    from: null,
    tenorDays: 1,
    quoteType: 'fixing',
    note: 'SOFR fixing of the curve date',
  },
  {
    tenor: '1M',
    kind: 'sofrai_average',
    from: 'avg_30d',
    tenorDays: 30,
    quoteType: 'zero_rate',
    note: 'SOFRAI 30-day realised average',
  },
  {
    tenor: '3M',
    kind: 'sofrai_average',
    from: 'avg_90d',
    tenorDays: 90,
    quoteType: 'zero_rate',
    note: 'SOFRAI 90-day realised average',
  },
  {
    tenor: '6M',
    kind: 'sofrai_average',
    from: 'avg_180d',
    tenorDays: 180,
    quoteType: 'zero_rate',
    note: 'SOFRAI 180-day realised average',
  },
  {
    tenor: '1Y',
    kind: 'bill_investment_yield',
    from: '52WK',
    tenorDays: 364,
    quoteType: 'ois_rate',
    note: '52-week bill investment yield on an ACT/360 basis',
  },
  {
    tenor: '2Y',
    kind: 'par_yield',
    from: '2Y',
    tenorDays: 730,
    quoteType: 'ois_rate',
    note: 'UST par yield less the Treasury-OIS basis assumption',
  },
  {
    tenor: '3Y',
    kind: 'par_yield',
    from: '3Y',
    tenorDays: 1095,
    quoteType: 'ois_rate',
    note: 'UST par yield less the Treasury-OIS basis assumption',
  },
  {
    tenor: '5Y',
    kind: 'par_yield',
    from: '5Y',
    tenorDays: 1826,
    quoteType: 'ois_rate',
    note: 'UST par yield less the Treasury-OIS basis assumption',
  },
  {
    tenor: '7Y',
    kind: 'par_yield',
    from: '7Y',
    tenorDays: 2556,
    quoteType: 'ois_rate',
    note: 'UST par yield less the Treasury-OIS basis assumption',
  },
  {
    tenor: '10Y',
    kind: 'par_yield',
    from: '10Y',
    tenorDays: 3653,
    quoteType: 'ois_rate',
    note: 'UST par yield less the Treasury-OIS basis assumption',
  },
  {
    tenor: '20Y',
    kind: 'par_yield',
    from: '20Y',
    tenorDays: 7305,
    quoteType: 'ois_rate',
    note: 'UST par yield less the Treasury-OIS basis assumption',
  },
  {
    tenor: '30Y',
    kind: 'par_yield',
    from: '30Y',
    tenorDays: 10958,
    quoteType: 'ois_rate',
    note: 'UST par yield less the Treasury-OIS basis assumption',
  },
] satisfies readonly ProxyRecipe[]);

/**
 * Days a realised SOFR average may lag the curve date before it is refused.
 *
 * The NY Fed publishes the SOFR Averages and Index on business day D for the compounding period
 * that **ends** on D−1, so the release dated the day after a curve date is that curve date's
 * realised term rate and using it is not a look-ahead. A release much further away is a different
 * period, and pricing a 1M OIS point off it would be an invention — so a gap wider than this is a
 * missing point, not a stale one, and the module says so rather than filling it.
 */
export const MAX_SOFRAI_LAG_DAYS = 5;

/** Investment yield (ACT/365 basis) → the ACT/360 simple basis the OIS curve quotes on. */
export function investmentYieldToAct360(yieldPct: number): number {
  return (yieldPct * 360) / 365;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reading the inputs back
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One input row the derivation consumed, and where it came from. */
export interface ProxyInput {
  tenor: string;
  value: number;
  provenanceId: number;
  /** For the record in `provenance.response_sha256`'s payload and for the log line. */
  source: string;
  note: string;
}

interface CurvePointRead {
  tenor: string;
  value: number;
  provenanceId: number;
  capturedAt: number;
}

/**
 * The latest vintage of one curve's points on one date, by tenor — the same "newest vintage at or
 * before `knownAt`" rule `data/curves.ts` reads with, because a derived point must be a function of
 * what was known, not of what `is_latest` says today.
 */
export async function pointsByTenor(
  tx: Tx,
  curveId: string,
  curveDate: string,
  quoteType: string,
  knownAt: Date,
): Promise<Map<string, CurvePointRead>> {
  const res = await tx.execute<{
    tenor: string;
    value: string;
    provenance_id: string;
    captured_at: string;
  }>(sql`
    SELECT DISTINCT ON (cp.tenor)
           cp.tenor, cp.value::text AS value, cp.provenance_id::text AS provenance_id,
           p.captured_at::text AS captured_at
      FROM curve_points cp
      JOIN provenance p ON p.provenance_id = cp.provenance_id
     WHERE cp.curve_id = ${curveId}
       AND cp.curve_date = ${curveDate}::date
       AND cp.quote_type = ${quoteType}
       AND cp.vintage_at <= ${knownAt}::timestamptz
     ORDER BY cp.tenor, cp.vintage_at DESC`);
  return new Map(
    res.rows.map((row) => [
      row.tenor,
      {
        tenor: row.tenor,
        value: Number(row.value),
        provenanceId: Number(row.provenance_id),
        capturedAt: Date.parse(row.captured_at),
      },
    ]),
  );
}

interface FixingRead {
  effectiveDate: string;
  rate: number | null;
  avg30d: number | null;
  avg90d: number | null;
  avg180d: number | null;
  provenanceId: number;
  capturedAt: number;
}

/** The newest vintage of one rate's fixing on or before `onOrBefore`, known at `knownAt`. */
export async function latestFixing(
  tx: Tx,
  rateCode: string,
  onOrBefore: string,
  knownAt: Date,
): Promise<FixingRead | null> {
  const res = await tx.execute<{
    effective_date: string;
    rate: string | null;
    avg_30d: string | null;
    avg_90d: string | null;
    avg_180d: string | null;
    provenance_id: string;
    captured_at: string;
  }>(sql`
    SELECT f.effective_date::text AS effective_date, f.rate::text AS rate,
           f.avg_30d::text AS avg_30d, f.avg_90d::text AS avg_90d, f.avg_180d::text AS avg_180d,
           f.provenance_id::text AS provenance_id, p.captured_at::text AS captured_at
      FROM rate_fixings f
      JOIN provenance p ON p.provenance_id = f.provenance_id
     WHERE f.rate_code = ${rateCode}
       AND f.effective_date <= ${onOrBefore}::date
       AND f.vintage_at <= ${knownAt}::timestamptz
     ORDER BY f.effective_date DESC, f.vintage_at DESC
     LIMIT 1`);
  const row = res.rows[0];
  if (row === undefined) return null;
  const num = (value: string | null): number | null => (value === null ? null : Number(value));
  return {
    effectiveDate: row.effective_date,
    rate: num(row.rate),
    avg30d: num(row.avg_30d),
    avg90d: num(row.avg_90d),
    avg180d: num(row.avg_180d),
    provenanceId: Number(row.provenance_id),
    capturedAt: Date.parse(row.captured_at),
  };
}

/**
 * The curve date the derived curve is built for: the latest date that carries **both** a par curve
 * and a SOFR fixing.
 *
 * Not a literal (FUNCTIONS_TIER3 §0 L11 says `2026-09-14` for this fixture set, and that is what
 * this query returns) because the date is a property of the captures: a fixture refresh moves it,
 * and a seed that hard-coded it would build a curve out of two different days' numbers. `null` when
 * one of the two sides has published nothing, which is the honest answer before module 6 has run.
 */
export async function derivableCurveDate(tx: Tx, knownAt: Date): Promise<string | null> {
  const res = await tx.execute<{ d: string | null }>(sql`
    SELECT max(cp.curve_date)::text AS d
      FROM curve_points cp
     WHERE cp.curve_id = ${UST_PAR_CURVE_ID}
       AND cp.quote_type = 'par_yield'
       AND cp.vintage_at <= ${knownAt}::timestamptz
       AND EXISTS (
         SELECT 1 FROM rate_fixings f
          WHERE f.rate_code = 'SOFR'
            AND f.effective_date = cp.curve_date
            AND f.rate IS NOT NULL
            AND f.vintage_at <= ${knownAt}::timestamptz)`);
  return res.rows[0]?.d ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The derivation
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface DerivedPoints {
  /** The rows to write, ascending in tenor days. */
  points: CurvePointWrite[];
  /** What each one was computed from, for the provenance payload and the log. */
  inputs: ProxyInput[];
  /** Recipes that produced no point, with the reason. Never filled with a substitute. */
  missing: { tenor: string; reason: string }[];
  /** `max(captured_at)` over the inputs — the instant this derivation knew what it knew. */
  knewAtMs: number;
  /** Distinct provenance ids of the inputs, ascending. */
  inputProvenanceIds: number[];
}

/**
 * Compute the eleven `SOFR_OIS` points for `curveDate` from what module 6 stored.
 *
 * Pure apart from the four reads it is handed: every value is a stored published number put through
 * one stated transformation, and a recipe whose input is absent produces an entry in `missing`
 * rather than an interpolated, carried-forward or zero value. A curve with a hole is a curve the
 * bootstrap can still build from the tenors that are there; a curve with an invented point is one
 * nobody can audit.
 */
export function deriveSofrOisPoints(args: {
  curveDate: string;
  vintageAt: string;
  sofr: FixingRead | null;
  sofrai: FixingRead | null;
  parYields: ReadonlyMap<string, CurvePointRead>;
  billYields: ReadonlyMap<string, CurvePointRead>;
}): DerivedPoints {
  const out: DerivedPoints = {
    points: [],
    inputs: [],
    missing: [],
    knewAtMs: 0,
    inputProvenanceIds: [],
  };
  const provenanceIds = new Set<number>();

  const take = (
    recipe: ProxyRecipe,
    value: number | null,
    input: { provenanceId: number; capturedAt: number; source: string } | null,
    reason: string,
  ): void => {
    if (value === null || !Number.isFinite(value) || input === null) {
      out.missing.push({ tenor: recipe.tenor, reason });
      return;
    }
    out.points.push({
      curveId: SOFR_OIS_CURVE_ID,
      curveDate: args.curveDate,
      tenor: recipe.tenor,
      quoteType: recipe.quoteType,
      vintageAt: args.vintageAt,
      tenorDays: recipe.tenorDays,
      value,
      // A derived point is not a security's quote: no instrument and no maturity are stated,
      // because the curve's 5Y point is not the 5Y note (FUNCTIONS_TIER3 L288 proxies it).
      instrumentId: null,
      maturityDate: null,
    });
    out.inputs.push({
      tenor: recipe.tenor,
      value,
      provenanceId: input.provenanceId,
      source: input.source,
      note: recipe.note,
    });
    provenanceIds.add(input.provenanceId);
    if (input.capturedAt > out.knewAtMs) out.knewAtMs = input.capturedAt;
  };

  for (const recipe of SOFR_OIS_PROXIES) {
    switch (recipe.kind) {
      case 'sofr_fixing': {
        const fixing = args.sofr;
        take(
          recipe,
          fixing?.rate ?? null,
          fixing === null || fixing === undefined
            ? null
            : { ...fixing, source: `rate_fixings SOFR ${fixing.effectiveDate}` },
          'no SOFR fixing on the curve date',
        );
        break;
      }
      case 'sofrai_average': {
        const fixing = args.sofrai;
        if (fixing === null) {
          out.missing.push({ tenor: recipe.tenor, reason: 'no SOFRAI release' });
          break;
        }
        const lagDays = Math.round(
          (Date.parse(`${fixing.effectiveDate}T00:00:00Z`) -
            Date.parse(`${args.curveDate}T00:00:00Z`)) /
            86_400_000,
        );
        if (Math.abs(lagDays) > MAX_SOFRAI_LAG_DAYS) {
          out.missing.push({
            tenor: recipe.tenor,
            reason: `the newest SOFRAI release (${fixing.effectiveDate}) is ${String(lagDays)} days from the curve date`,
          });
          break;
        }
        const value =
          recipe.from === 'avg_30d'
            ? fixing.avg30d
            : recipe.from === 'avg_90d'
              ? fixing.avg90d
              : fixing.avg180d;
        take(
          recipe,
          value,
          { ...fixing, source: `rate_fixings SOFRAI ${fixing.effectiveDate} ${String(recipe.from)}` },
          `SOFRAI ${String(recipe.from)} is NULL in the release`,
        );
        break;
      }
      case 'bill_investment_yield': {
        const bill = recipe.from === null ? undefined : args.billYields.get(recipe.from);
        take(
          recipe,
          bill === undefined ? null : investmentYieldToAct360(bill.value),
          bill === undefined ? null : { ...bill, source: `curve_points UST_BILL ${bill.tenor} investment_yield` },
          `no UST_BILL investment yield at ${String(recipe.from)}`,
        );
        break;
      }
      case 'par_yield': {
        const par = recipe.from === null ? undefined : args.parYields.get(recipe.from);
        take(
          recipe,
          par === undefined ? null : par.value - TREASURY_OIS_BASIS_BP / 100,
          par === undefined ? null : { ...par, source: `curve_points UST_PAR ${par.tenor} par_yield` },
          `no UST_PAR par yield at ${String(recipe.from)}`,
        );
        break;
      }
    }
  }

  out.points.sort((a, b) => a.tenorDays - b.tenorDays);
  out.inputProvenanceIds = [...provenanceIds].sort((a, b) => a - b);
  return out;
}

/**
 * The `provenance` row a derivation cites — DATA-10 for a number this process computed.
 *
 * Shaped like `providers/sim/feed.ts`'s synthetic row (§4.3): a registered `internal.derived`
 * source, a `request_key` that names the derivation rather than a URL, and `http_status 0` because
 * nothing was fetched. `response_sha256` is the hash of the canonical JSON of the inputs, so the
 * row identifies *which* numbers were consumed; `captured_at` is the latest capture instant among
 * them, so the derived value is never recorded as known before its inputs were.
 *
 * Re-used rather than re-inserted when the same derivation has already been recorded: no exchange
 * happened, so a second row would only add an id. An input that changed changes the hash and
 * therefore gets its own row, which is the traceability this table exists for.
 */
export async function derivedProvenance(
  tx: Tx,
  args: { requestKey: string; payload: unknown; capturedAtMs: number },
): Promise<{ provenanceId: number; reused: boolean }> {
  const body = Buffer.from(canonicalJson(args.payload), 'utf8');
  const digest = sha256Hex(body);
  const held = await tx.execute<{ provenance_id: string }>(sql`
    SELECT provenance_id FROM provenance
     WHERE source_id = ${DERIVED_SOURCE_ID}
       AND request_key = ${args.requestKey}
       AND response_sha256 = decode(${digest}, 'hex')
     ORDER BY provenance_id
     LIMIT 1`);
  const row = held.rows[0];
  if (row !== undefined) return { provenanceId: Number(row.provenance_id), reused: true };

  const raw: RawRecord = {
    providerId: DERIVED_SOURCE_ID,
    method: 'GET',
    url: `derived://${args.requestKey}`,
    requestKey: args.requestKey,
    requestHash: sha256Hex(args.requestKey),
    // §4.3: a derivation is not an HTTP exchange. `0` is the status the simulated feed records too.
    status: 0,
    headers: {},
    body,
    capturedAt: args.capturedAtMs,
    sha256: digest,
    sourceTs: null,
    origin: 'replay',
  };
  const provenanceId = await insertProvenance(tx, raw, {
    adapterVersion: CURVE_DERIVATION_VERSION,
    sourceTs: null,
  });
  return { provenanceId, reused: false };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The module
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The tables module 7 writes (§18 row 7). `provenance` is included: the derivation writes one. */
export const CURVES_TABLES: readonly string[] = Object.freeze([
  'curves',
  'curve_points',
  'curve_builds',
  'provenance',
]);

/** Rows written, per table: the delta, so a second run reports zeros (§18). */
export type SeedCurvesResult = Record<string, number>;

/**
 * Module 7 (`seed/index.ts` order 4). One transaction, opened by the runner.
 *
 * Runs after module 6 by construction: its inputs are rows module 6 wrote. With no par curve and no
 * SOFR fixing in the database — a `--only curves` run on an empty schema — it writes the curve
 * definition, reports that there is nothing to derive and returns; that is a precondition that has
 * not been met, not an error, and the next full seed produces the curve.
 */
export async function seedCurves(ctx: SeedContext): Promise<SeedCurvesResult> {
  // The same cast `ingest/scheduler.ts` L982 makes: the runner's handle is a transaction, and the
  // repositories and readers take a `Tx`.
  const tx = ctx.db as unknown as Tx;
  const before = await countTables(tx, CURVES_TABLES);
  const done = async (): Promise<SeedCurvesResult> =>
    tableDeltas(before, await countTables(tx, CURVES_TABLES));

  const definitionsWritten = await ensureCurves(tx, [SOFR_OIS_DEFINITION]);
  if (definitionsWritten > 0) ctx.log(`${SOFR_OIS_CURVE_ID}: curve definition written`);

  // "As known at the end of the recording": every stored vintage is visible, and nothing that was
  // not yet captured can be. `max(captured_at)` over `provenance` is a property of the fixtures,
  // which is what keeps two runs identical (the wall clock would not be).
  const knownAt = await latestCaptureInstant(tx);
  if (knownAt === null) {
    ctx.log('no provenance rows yet — nothing has been captured, so nothing can be derived');
    return done();
  }

  const curveDate = await derivableCurveDate(tx, knownAt);
  if (curveDate === null) {
    ctx.log(
      `no date carries both a ${UST_PAR_CURVE_ID} par curve and a SOFR fixing; ` +
        `${SOFR_OIS_CURVE_ID} has no derivable date (module 6 first)`,
    );
    return done();
  }

  // Sequential, not `Promise.all`: the module's four reads share the runner's single connection, and
  // pg queues a second query on a busy client with a deprecation warning rather than pipelining it.
  const sofr = await latestFixing(tx, 'SOFR', curveDate, knownAt);
  // The averages release is dated the business day *after* the period it reports, so it is looked up
  // over a window that reaches past the curve date; {@link MAX_SOFRAI_LAG_DAYS} bounds it.
  const sofrai = await latestFixing(tx, 'SOFRAI', addDays(curveDate, MAX_SOFRAI_LAG_DAYS), knownAt);
  const parYields = await pointsByTenor(tx, UST_PAR_CURVE_ID, curveDate, 'par_yield', knownAt);
  const billYields = await pointsByTenor(
    tx,
    UST_BILL_CURVE_ID,
    curveDate,
    'investment_yield',
    knownAt,
  );

  const derived = deriveSofrOisPoints({
    curveDate,
    // Filled in below once the derivation has reported the instant its inputs were captured at.
    vintageAt: new Date(0).toISOString(),
    sofr,
    sofrai,
    parYields,
    billYields,
  });
  if (derived.points.length === 0) {
    ctx.log(
      `${SOFR_OIS_CURVE_ID} ${curveDate}: no proxy input resolved; no point written ` +
        `(${String(derived.missing.length)} recipes unmet)`,
    );
    return done();
  }

  // The vintage is the latest instant the *inputs* were captured at, so the derived row is never
  // recorded as known before the numbers it is made of (and a re-run reproduces it exactly).
  const vintageAt = new Date(derived.knewAtMs).toISOString();
  for (const point of derived.points) point.vintageAt = vintageAt;

  const provenance = await derivedProvenance(tx, {
    requestKey: `derive:${SOFR_OIS_CURVE_ID}:${curveDate}`,
    payload: {
      curveId: SOFR_OIS_CURVE_ID,
      curveDate,
      basisBp: TREASURY_OIS_BASIS_BP,
      version: CURVE_DERIVATION_VERSION,
      inputs: derived.inputs,
    },
    capturedAtMs: derived.knewAtMs,
  });

  const counts = await upsertCurvePoints(tx, derived.points, provenance.provenanceId);
  ctx.log(
    `${SOFR_OIS_CURVE_ID} ${curveDate}: ${String(counts.inserted)} points written, ` +
      `${String(counts.unchanged)} unchanged, ${String(derived.missing.length)} not derivable ` +
      `(provenance ${provenance.reused ? 'reused' : 'written'})`,
  );
  for (const gap of derived.missing) ctx.log(`  no ${gap.tenor} point: ${gap.reason}`);

  // ── the build (§18: `curve_builds` for SOFR_OIS on the latest date) ─────────────────────────
  //
  // `buildCurve` is WP-11's: it hashes the engine inputs, looks `curve_builds` up by that hash,
  // bootstraps only on a miss and stores the result. So the seed does not decide whether to build —
  // it asks for the build and the cache answers, which is also what makes the second seed run write
  // no row.
  const build = await buildCurve(tx, { validAt: knownAt, knownAt }, SOFR_OIS_CURVE_ID, curveDate);
  ctx.log(
    `${SOFR_OIS_CURVE_ID} build ${String(build.buildId)} ${build.method} ${build.interpolation}: ` +
      `${String(build.nodes.length)} nodes, ${String(build.inputs.length)} inputs, ` +
      `${build.cached ? 'from curve_builds' : 'bootstrapped'}`,
  );
  return done();
}

/** `max(provenance.captured_at)` — the last instant this database has a recorded capture for. */
async function latestCaptureInstant(tx: Tx): Promise<Date | null> {
  const res = await tx.execute<{ at: string | null }>(sql`
    SELECT max(captured_at)::text AS at FROM provenance`);
  const at = res.rows[0]?.at ?? null;
  return at === null ? null : new Date(Date.parse(at));
}

/** `2026-09-14` + n days, as an ISO date. Calendar days: the SOFRAI window is not a business one. */
function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Module 7 of the ordered seed runner (`seed/index.ts`). */
export const seed = seedCurves;
