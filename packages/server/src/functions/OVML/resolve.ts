/**
 * `functions/OVML/resolve.ts` — vanilla option valuation (FUNCTIONS_TIER3.md §OVML).
 *
 * **Every number in `results` is an engine output.** The resolver picks the contract, assembles
 * `(S, K, r, q, σ, T)` from stored data, calls one of `core/analytics/options/*`, and converts
 * units. It contains no pricing formula, no greek formula and no volatility model; where the
 * chosen engine does not return a greek, the number is a central difference **over further runs of
 * the same engine**, each registered in `meta.engines[]` so a reader can reproduce the bump as
 * easily as the price (ANAL-08). A number on this screen that cannot be traced to an engine and
 * its `inputsHash` would be a defect, not a rounding detail.
 *
 * ## The two variants are one code path
 *
 * `contract` takes the panel security's `option_terms`; `underlying` picks the nearest unexpired
 * expiry and the strike closest to spot and records the choice in `picked` (FUNC-02). After that
 * both run `valueContract`, which is why the `OvmlBody` half of the payload is literally the same
 * object shape in both.
 *
 * ## Desk units, stated once
 *
 * The greeks are published as a desk quotes them, and every derivative is taken in the unit its
 * label implies:
 *
 *  | cell    | unit                                   |
 *  | ------- | -------------------------------------- |
 *  | `delta` | per 1.00 of spot                       |
 *  | `gamma` | per 1.00 of spot, twice                |
 *  | `vega`  | per **1 volatility point**             |
 *  | `theta` | per **calendar day** of time passing   |
 *  | `rho`   | per **1 % of rate**                    |
 *  | `vanna` | ∂delta / 1 vol point                   |
 *  | `volga` | ∂vega / 1 vol point                    |
 *  | `charm` | ∂delta / calendar day                  |
 *
 * The finite differences use exactly those step sizes, so an analytic greek and a bumped one are
 * the same quantity in the same unit and can be compared without a scale factor. The one exception
 * is `volga`, which is bumped five vol points wide and scaled back — see {@link VOLGA_BUMP}.
 *
 * ## Deviations from §OVML
 *
 * Listed in `core/functions/manifests/OVML.ts`'s header. The three that matter while reading this
 * file: implied volatility is inverted on the European closed form even for American exercise
 * (`options/bsm` is the only landed solver); greeks the chosen engine does not return are
 * difference quotients through the same engine; and the engine names in `meta.engines[]` are the
 * landed `bsm` / `black76` / `option.tree` / `option.mc`, not §0's `options/*` spelling.
 */

import { sql } from 'drizzle-orm';

import type { ReasonCode, Tier, ValueCell, ValueState } from '@terminal/core';
import { engineMeta } from '@terminal/core/analytics/engine';
import type { BsmInputs, Black76Inputs, OptionType } from '@terminal/core/analytics/options/bsm';
import { black76Engine, bsmEngine, impliedVol } from '@terminal/core/analytics/options/bsm';
import type { McInputs } from '@terminal/core/analytics/options/mc';
import { mcEngine } from '@terminal/core/analytics/options/mc';
import type { TreeEngineInputs } from '@terminal/core/analytics/options/tree';
import { treeEngine } from '@terminal/core/analytics/options/tree';
import type { IsoDate } from '@terminal/core/calendars/calendar';
import type {
  OvmlCaveat,
  OvmlContract,
  OvmlInputs,
  OvmlMarket,
  OvmlModel,
  OvmlParams,
  OvmlPayload,
  OvmlPicked,
  OvmlProfilePoint,
  OvmlResults,
  OvmlScenario,
  OvmlStyle,
  OvmlUnderlying,
} from '@terminal/core/functions/manifests/OVML';
import {
  OVML_PROFILE_POINTS,
  OVML_PROXY_CURVE_CAVEATS,
  OVML_VANILLA_ONLY,
} from '@terminal/core/functions/manifests/OVML';
import { localClock } from '@terminal/core/quote/session';

import { cellFromState } from '../shared/cells.js';
import { contractKey, pmSettlementTs } from '../OMON/resolve.js';
import { AppError } from '../../http/errors.js';

import type { ChainSnapshot, OptionQuote, OptionTerms } from '../../data/options.js';
import type { ResolveContext } from '../context.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SOURCE_ID = 'cboe.options';
const CHAIN_TIER: Tier = 'delayed';
const CHAIN_MAX_AGE_MS = 60_000;
const CURVE_ID = 'SOFR_OIS';
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365;
/** One volatility point, in sigma decimals — the bump unit every vol derivative is quoted in. */
const VOL_POINT = 0.01;
/** One percent of rate, in decimals. */
const RATE_POINT = 0.01;
/** One calendar day, in years. */
const DAY = 1 / DAYS_PER_YEAR;
/** Relative spot bump for a model with no analytic delta. */
const SPOT_BUMP = 1e-3;
/**
 * The sigma bump for a **second** difference in volatility, where the engine has no analytic volga.
 *
 * Five vol points, not the one `VOL_POINT` every other vol derivative uses, and the result is
 * scaled back to the per-vol-point² unit `volga` is quoted in. A lattice or Monte Carlo price is a
 * sawtooth in sigma — CRR's error oscillates with the parity of the step count, which is the whole
 * reason `crrAveraged` exists — and inside ±1 vol point that oscillation is larger than the
 * curvature underneath it. A first difference survives this (the sawtooth is nearly common to both
 * legs and cancels); a second difference does not, because it subtracts two nearly equal first
 * differences and what is left is the grid.
 *
 * The default contract in the OVML suite is exactly that case. At ±1 vol point the second
 * difference comes out at −1.53e-09 per vol point², and at ±2 it is −1.51e-09; at ±5 it is
 * +7.29e-05, at ±10 +8.41e-05, and the Black-Scholes closed form for the same state says
 * +8.59e-05. So the narrow bump had the wrong sign and was five orders of magnitude too small,
 * while the wide one lands within ~15 % of the closed form. Averaging adjacent step counts does
 * not rescue the narrow bump — it gives +1.36e-09 — so the bump width is the fix, not the smoother.
 *
 * Five points is also the shock the screen's own scenario grid uses
 * (`OVML_DEFAULT_VOL_SHOCKS = [-5, 0, 5]`), so the published volga is the curvature of the grid the
 * reader is looking at rather than of a bump nothing else on the screen shows. `OVML.test.ts`
 * asserts that identity.
 */
const VOLGA_BUMP = 5 * VOL_POINT;
/** `|delta|` or `|moneyness %|` beyond which a quoted implied vol means nothing. */
const SUSPECT_DELTA = 0.99;
const SUSPECT_MONEYNESS_PCT = 25;
/** The greeks profile spans ±20 % of spot. */
const PROFILE_SPAN = 0.2;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cells
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * §OMON and §OVML both write `r: 'NO_DATA'`, which is **not** a member of the landed `ReasonCode`
 * union (`core/types/entitlement.ts`: the codes are about entitlement, the plant and the provider).
 * `FIELD_UNKNOWN` is the member that says what is actually true of these cells — the capture
 * carries no such field for this subject — and the *why* travels in `meta.unavailable` with a
 * detail, which is where a reader looks for it. `PROVIDER_DOWN` stays reserved for "no row at all".
 */
const NO_VALUE: ReasonCode = 'FIELD_UNKNOWN';

function numCell(v: number, st: ValueState, provIdx: number): ValueCell {
  return { v, st, provIdx };
}

function naCell(r: ReasonCode): ValueCell {
  return { v: null, st: 'na', r, provIdx: -1 };
}

function blankCell(r: ReasonCode): ValueCell {
  return { v: null, st: 'blank', r, provIdx: -1 };
}

function nyDate(ms: number): IsoDate {
  return localClock('America/New_York', ms)?.date ?? new Date(ms).toISOString().slice(0, 10);
}

function typeOf(putCall: 'C' | 'P'): OptionType {
  return putCall === 'C' ? 'call' : 'put';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The model call (ANAL-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The six numbers every model is handed; `sigma` and `r` are decimals, `T` years ACT/365F. */
interface ModelState {
  S: number;
  K: number;
  r: number;
  q: number;
  sigma: number;
  T: number;
}

interface ModelConfig {
  model: OvmlModel;
  style: OvmlStyle;
  type: OptionType;
  steps: number;
  paths: number;
  seed: number;
  /** Black-76 only: the forward the user supplied, or `null` to derive it from the carry. */
  forward: number | null;
  valuationTs: string;
}

/** What one engine call returned natively; `null` means "this engine does not produce it". */
interface ModelRun {
  price: number;
  /** Per 1.00 of spot. */
  delta: number | null;
  gamma: number | null;
  /** ∂V/∂t per year (negative for a long option). */
  thetaPerYear: number | null;
  /** ∂V/∂σ per 1.00 of sigma. */
  vegaPerSigma: number | null;
  /** ∂V/∂r per 1.00 of rate. */
  rhoPerRate: number | null;
  /** ∂²V/∂S∂σ per 1.00 of sigma. */
  vannaPerSigma: number | null;
  /** ∂²V/∂σ² per 1.00 of sigma². */
  volgaPerSigma: number | null;
  stdErr: number | null;
}

/**
 * One engine call, registered.
 *
 * Black-76 is priced on the forward: the user's when they gave one, otherwise `S·e^{(r−q)T}`,
 * which is the only forward this build has (there is no futures source — BRIEF §2).
 */
function runModel(ctx: ResolveContext, cfg: ModelConfig, s: ModelState): ModelRun {
  const none: Omit<ModelRun, 'price'> = {
    delta: null,
    gamma: null,
    thetaPerYear: null,
    vegaPerSigma: null,
    rhoPerRate: null,
    vannaPerSigma: null,
    volgaPerSigma: null,
    stdErr: null,
  };

  if (cfg.model === 'bsm') {
    const inputs: BsmInputs = { S: s.S, K: s.K, r: s.r, q: s.q, sigma: s.sigma, T: s.T };
    const run = bsmEngine(inputs, cfg.valuationTs);
    ctx.engines.add(engineMeta(run));
    const o = run.outputs;
    const isCall = cfg.type === 'call';
    return {
      price: isCall ? o.call : o.put,
      delta: isCall ? o.deltaCall : o.deltaPut,
      gamma: o.gamma,
      thetaPerYear: isCall ? o.thetaCall : o.thetaPut,
      vegaPerSigma: o.vega,
      rhoPerRate: isCall ? o.rhoCall : o.rhoPut,
      vannaPerSigma: o.vanna,
      volgaPerSigma: o.volga,
      stdErr: null,
    };
  }

  if (cfg.model === 'black76') {
    const forward = cfg.forward ?? s.S * Math.exp((s.r - s.q) * s.T);
    const inputs: Black76Inputs = { F: forward, K: s.K, r: s.r, sigma: s.sigma, T: s.T };
    const run = black76Engine(inputs, cfg.valuationTs);
    ctx.engines.add(engineMeta(run));
    const o = run.outputs;
    const isCall = cfg.type === 'call';
    // Black-76's delta is ∂V/∂F. The screen's delta is ∂V/∂S, and with a carry forward
    // `F = S·e^{(r−q)T}` the chain rule gives the factor below. With a *user* forward there is no
    // relation between F and S at all, so no spot delta can be claimed and the FD path fills it.
    const dFdS = cfg.forward === null ? Math.exp((s.r - s.q) * s.T) : null;
    return {
      ...none,
      price: isCall ? o.call : o.put,
      delta: dFdS === null ? null : (isCall ? o.deltaCall : o.deltaPut) * dFdS,
      gamma: dFdS === null ? null : o.gamma * dFdS * dFdS,
      thetaPerYear: isCall ? o.thetaCall : o.thetaPut,
      vegaPerSigma: o.vega,
      rhoPerRate: isCall ? o.rhoCall : o.rhoPut,
    };
  }

  if (cfg.model === 'crr' || cfg.model === 'trinomial') {
    const inputs: TreeEngineInputs = {
      S: s.S,
      K: s.K,
      r: s.r,
      q: s.q,
      sigma: s.sigma,
      T: s.T,
      steps: cfg.steps,
      type: cfg.type,
      exercise: cfg.style,
      method: cfg.model,
    };
    const run = treeEngine(inputs, cfg.valuationTs);
    ctx.engines.add(engineMeta(run));
    const o = run.outputs;
    return { ...none, price: o.price, delta: o.delta, gamma: o.gamma, thetaPerYear: o.theta };
  }

  const inputs: McInputs = {
    S: s.S,
    K: s.K,
    r: s.r,
    q: s.q,
    sigma: s.sigma,
    T: s.T,
    type: cfg.type,
    paths: cfg.paths,
    seed: cfg.seed,
  };
  const run = mcEngine(inputs, cfg.valuationTs);
  ctx.engines.add(engineMeta(run));
  return { ...none, price: run.outputs.price, stdErr: run.outputs.stdError };
}

/** Greeks in desk units — native where the engine has them, central differences where it does not. */
interface DeskGreeks {
  price: number;
  delta: number;
  gamma: number;
  /** Per 1 vol point. */
  vega: number;
  /** Per calendar day. */
  theta: number;
  /** Per 1 % of rate. */
  rho: number;
  vanna: number;
  volga: number;
  charm: number;
  stdErr: number | null;
}

function deltaOf(ctx: ResolveContext, cfg: ModelConfig, s: ModelState, run?: ModelRun): number {
  const base = run ?? runModel(ctx, cfg, s);
  if (base.delta !== null) return base.delta;
  const h = Math.max(s.S * SPOT_BUMP, 1e-6);
  const up = runModel(ctx, cfg, { ...s, S: s.S + h }).price;
  const down = runModel(ctx, cfg, { ...s, S: s.S - h }).price;
  return (up - down) / (2 * h);
}

/**
 * ∂²V/∂σ² per vol point², analytically where the engine has it and over {@link VOLGA_BUMP}
 * otherwise.
 *
 * The bump narrows to half of sigma when sigma is small, so the two legs stay symmetric about the
 * base and the down leg never reaches zero volatility; the scale factor follows the bump actually
 * taken. `sigma > 0` is a precondition — nothing is priced at all unless the implied vol is
 * positive (`priceable`).
 */
function volgaOf(ctx: ResolveContext, cfg: ModelConfig, s: ModelState, base: ModelRun): number {
  if (base.volgaPerSigma !== null) return base.volgaPerSigma * VOL_POINT * VOL_POINT;
  const h = Math.min(VOLGA_BUMP, s.sigma / 2);
  const up = runModel(ctx, cfg, { ...s, sigma: s.sigma + h }).price;
  const down = runModel(ctx, cfg, { ...s, sigma: s.sigma - h }).price;
  return ((up - 2 * base.price + down) * VOL_POINT * VOL_POINT) / (h * h);
}

function greeksOf(ctx: ResolveContext, cfg: ModelConfig, s: ModelState): DeskGreeks {
  const base = runModel(ctx, cfg, s);

  // Spot derivatives.
  let delta = base.delta;
  let gamma = base.gamma;
  if (delta === null || gamma === null) {
    const h = Math.max(s.S * SPOT_BUMP, 1e-6);
    const up = runModel(ctx, cfg, { ...s, S: s.S + h }).price;
    const down = runModel(ctx, cfg, { ...s, S: s.S - h }).price;
    delta ??= (up - down) / (2 * h);
    gamma ??= (up - 2 * base.price + down) / (h * h);
  }

  // Volatility derivatives, in vol points.
  const volUp = runModel(ctx, cfg, { ...s, sigma: s.sigma + VOL_POINT });
  const volDown = runModel(ctx, cfg, {
    ...s,
    sigma: Math.max(s.sigma - VOL_POINT, VOL_POINT / 100),
  });
  const vega =
    base.vegaPerSigma === null
      ? (volUp.price - volDown.price) / 2
      : base.vegaPerSigma * VOL_POINT;
  const volga = volgaOf(ctx, cfg, s, base);
  const vanna =
    base.vannaPerSigma === null
      ? (deltaOf(ctx, cfg, { ...s, sigma: s.sigma + VOL_POINT }, volUp) -
          deltaOf(ctx, cfg, { ...s, sigma: Math.max(s.sigma - VOL_POINT, VOL_POINT / 100) }, volDown)) /
        2
      : base.vannaPerSigma * VOL_POINT;

  // Time derivatives, per calendar day of time passing.
  const shorter: ModelState = { ...s, T: Math.max(s.T - DAY, DAY / 24) };
  const decayed = runModel(ctx, cfg, shorter);
  const theta = base.thetaPerYear === null ? decayed.price - base.price : base.thetaPerYear / DAYS_PER_YEAR;
  const charm = deltaOf(ctx, cfg, shorter, decayed) - delta;

  // Rate derivative, per 1 % of rate.
  const rho =
    base.rhoPerRate === null
      ? (runModel(ctx, cfg, { ...s, r: s.r + RATE_POINT }).price -
          runModel(ctx, cfg, { ...s, r: s.r - RATE_POINT }).price) /
        2
      : base.rhoPerRate * RATE_POINT;

  return {
    price: base.price,
    delta,
    gamma,
    vega,
    theta,
    rho,
    vanna,
    volga,
    charm,
    stdErr: base.stdErr,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const code = 'OVML';

export async function resolve(ctx: ResolveContext, params: OvmlParams): Promise<OvmlPayload> {
  const instrument = ctx.instrument;
  if (instrument === null) {
    throw new AppError('NO_SECURITY_CONTEXT', 'OVML needs an option or its underlying.', {
      details: { code: 'OVML' },
    });
  }
  return instrument.assetClass === 'option'
    ? resolveContract(ctx, params)
    : resolveUnderlying(ctx, params);
}

/** §OVML step 1 — the panel security *is* the contract. */
async function resolveContract(ctx: ResolveContext, params: OvmlParams): Promise<OvmlPayload> {
  const instrumentId = ctx.instrument?.instrumentId ?? 0;
  const terms = await ctx.data.options.terms(instrumentId);
  const chain = await loadChain(ctx, terms.underlyingInstrumentId, terms.root, terms.expiry);
  const body = await valueContract(ctx, params, { terms, chain });
  return { variant: 'contract', ...body };
}

/** §OVML step 2 — nearest unexpired expiry, then the strike closest to spot. */
async function resolveUnderlying(ctx: ResolveContext, params: OvmlParams): Promise<OvmlPayload> {
  const underlyingId = ctx.instrument?.instrumentId ?? 0;
  const root = ctx.instrument?.ticker ?? '';
  const chain = await loadChain(ctx, underlyingId, root, params.expiry ?? undefined);
  const valuationDate = nyDate(ctx.asOf.validAt.getTime());

  const ladder = chain.expiries.map((e) => e.expiry);
  if (params.expiry !== null && !ladder.includes(params.expiry)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${params.expiry} is not a listed expiry for ${chain.underlying.display}.`,
      {
        details: {
          location: 'fnParams',
          field: 'expiry',
          detail:
            `${params.expiry} is not a listed expiry for ${chain.underlying.display}; listed: ` +
            ladder.slice(0, 5).join(', '),
        },
      },
    );
  }
  const expiry = params.expiry ?? ladder.find((e) => e >= valuationDate) ?? null;
  const spot0 = chain.underlying.px;
  const candidates = chain.contracts.filter(
    (c) => c.expiry === expiry && c.putCall === params.putCall,
  );

  if (expiry === null || candidates.length === 0) {
    throw new AppError(
      'FUNCTION_NOT_APPLICABLE',
      `no unexpired ${params.putCall === 'C' ? 'call' : 'put'} listed for ` +
        `${chain.underlying.display} in the stored Cboe chain.`,
      { details: { code: 'OVML', instrumentId: underlyingId } },
    );
  }

  const target = params.strike ?? spot0;
  let picked = candidates[0]!;
  if (target !== null) {
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const distance = Math.abs(candidate.strike - target);
      if (distance < best) {
        best = distance;
        picked = candidate;
      }
    }
  }

  const body = await valueContract(ctx, params, { terms: picked, chain });
  const pickedBlock: OvmlPicked = {
    rule: 'nearest_expiry_then_strike_nearest_spot',
    expiry,
    strike: picked.strike,
    putCall: params.putCall,
    expiriesAvailable: chain.expiries.map((e) => ({
      expiry: e.expiry,
      contractCount: e.contractCount,
    })),
    strikesAvailable: [...new Set(candidates.map((c) => c.strike))].sort((a, b) => a - b),
  };
  return { variant: 'underlying', picked: pickedBlock, ...body };
}

/** The chain, refreshed through the provider when the newest capture is over a minute old. */
async function loadChain(
  ctx: ResolveContext,
  underlyingId: number,
  root: string,
  expiry?: string,
): Promise<ChainSnapshot> {
  let chain = await ctx.data.options.chain(underlyingId, expiry);
  const age = ctx.asOf.validAt.getTime() - Date.parse(chain.captureTs);
  if (chain.contracts.length === 0 || age > CHAIN_MAX_AGE_MS) {
    const refreshed = await ctx.providers
      .ensure('cboe.options', root, { maxAgeMs: CHAIN_MAX_AGE_MS })
      .catch(() => null);
    if (refreshed?.fresh === true) {
      chain = await ctx.data.options.chain(underlyingId, expiry);
    }
  }
  return chain;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Valuation (steps 3–10)
// ─────────────────────────────────────────────────────────────────────────────────────────────

type BodyOf = Omit<Extract<OvmlPayload, { variant: 'contract' }>, 'variant'>;

async function valueContract(
  ctx: ResolveContext,
  params: OvmlParams,
  args: { terms: OptionTerms; chain: ChainSnapshot },
): Promise<BodyOf> {
  const { terms, chain } = args;
  const caveats = new Set<OvmlCaveat>([OVML_VANILLA_ONLY]);
  const valuationDate = nyDate(ctx.asOf.validAt.getTime());
  const valuationTs = ctx.asOf.validAt.toISOString();

  // ── 3. market ───────────────────────────────────────────────────────────────────────────────
  const row = chain.contracts.find((c) => c.instrumentId === terms.instrumentId)?.q ?? null;
  const chainStale = ctx.asOf.validAt.getTime() - Date.parse(chain.captureTs) > 3 * CHAIN_MAX_AGE_MS;
  const marketState: ValueState = row === null ? 'blank' : chainStale ? 'stale' : 'live';
  const provIdxMkt = ctx.prov.add({
    sourceId: SOURCE_ID,
    provenanceId: row?.provenanceId ?? chain.underlying.provenanceId,
    capturedAt: new Date(row?.captureTs ?? chain.captureTs),
    sourceTs: new Date(chain.captureTs),
    st: marketState,
    tier: CHAIN_TIER,
  });
  const provIdxTerms = ctx.prov.add({
    sourceId: SOURCE_ID,
    provenanceId: terms.provenanceId,
    capturedAt: new Date(chain.captureTs),
    sourceTs: null,
    st: 'closed',
    tier: CHAIN_TIER,
  });
  const market = marketBlock(ctx, { row, chain, state: marketState, provIdx: provIdxMkt });

  // ── 4. underlying ───────────────────────────────────────────────────────────────────────────
  const subjU = ctx.plant.subjectFor(terms.underlyingInstrumentId, 'q');
  const subjC = ctx.plant.subjectFor(terms.instrumentId, 'q');
  ctx.plant.ensureHot([subjU, subjC]);
  const underlyingDetail = await ctx.data.reference
    .instrument(terms.underlyingInstrumentId)
    .catch(() => null);
  const underlying = underlyingBlock(ctx, {
    chain,
    subject: subjU,
    state: marketState,
    provIdx: provIdxMkt,
    name: underlyingDetail?.instrument.name ?? chain.underlying.display,
  });

  // ── the contract block (REF-04) ─────────────────────────────────────────────────────────────
  const expiryTs = pmSettlementTs(terms.expiry);
  const contract: OvmlContract = {
    instrumentId: terms.instrumentId,
    key: contractKey(terms),
    occSymbol: terms.occSymbol,
    root: terms.root,
    underlyingInstrumentId: terms.underlyingInstrumentId,
    expiry: terms.expiry,
    expiryTs,
    strike: terms.strike,
    putCall: terms.putCall,
    exerciseStyle: terms.exerciseStyle,
    settlement: terms.settlement,
    amPm: terms.amPm,
    multiplier: terms.multiplier,
    tickSize: terms.tickSize,
    isWeekly: terms.isWeekly,
    lastTradeDate: terms.lastTradeDate,
    provIdx: provIdxTerms,
  };

  // ── 5. inputs ───────────────────────────────────────────────────────────────────────────────
  const years = (Date.parse(expiryTs) - ctx.asOf.validAt.getTime()) / MS_PER_YEAR;
  const days = Math.round(years * DAYS_PER_YEAR);
  const expired = years <= 0;
  if (expired) caveats.add('EXPIRED_CONTRACT');

  const spotValue =
    params.spot ??
    (typeof underlying.px.v === 'number' ? underlying.px.v : null) ??
    chain.underlying.px;
  const spotSource: 'market' | 'user' = params.spot === null ? 'market' : 'user';

  const rate = await rateInput(ctx, { params, valuationDate, years, caveats, fallbackProvIdx: provIdxMkt });
  const dividend = await dividendInput(ctx, {
    params,
    underlyingId: terms.underlyingInstrumentId,
    valuationDate,
    spot: spotValue,
    caveats,
    fallbackProvIdx: provIdxMkt,
  });

  const style: OvmlStyle = params.style ?? terms.exerciseStyle;
  const model: OvmlModel = params.model ?? (style === 'american' ? 'crr' : 'bsm');
  if (model === 'bsm' && style === 'american') {
    ctx.unavailable.add({
      field: 'inputs.style',
      reason: 'NOT_APPLICABLE',
      detail: 'BSM prices European exercise; the contract is American — use CRR or trinomial',
    });
  }
  if (model === 'black76') {
    caveats.add('NO_FUTURES_SOURCE');
    if (params.forward === null) {
      ctx.unavailable.add({
        field: 'inputs.forward',
        reason: 'NO_SOURCE',
        detail: 'no futures or forward source; forward derived as spot × exp((r − q)T)',
      });
    }
  }

  const cfg: ModelConfig = {
    model,
    style,
    type: typeOf(terms.putCall),
    steps: params.steps,
    paths: params.paths,
    seed: params.seed,
    forward: params.forward,
    valuationTs,
  };

  const moneynessPct = spotValue === null ? null : 100 * (spotValue / terms.strike - 1);
  const providerDelta = row?.delta ?? null;
  if (
    (providerDelta !== null && Math.abs(providerDelta) > SUSPECT_DELTA) ||
    (moneynessPct !== null && Math.abs(moneynessPct) > SUSPECT_MONEYNESS_PCT)
  ) {
    caveats.add('DEEP_ITM_IV_UNRELIABLE');
  }

  // ── 6. implied volatility ───────────────────────────────────────────────────────────────────
  const priceToInvert =
    params.price ??
    (typeof market.mid.v === 'number' ? market.mid.v : null) ??
    (typeof market.last.v === 'number' ? market.last.v : null);
  let impliedVolPct: number | null = null;
  if (!expired && spotValue !== null && priceToInvert !== null) {
    const solved = impliedVol(
      priceToInvert,
      { S: spotValue, K: terms.strike, r: rate.decimal, q: dividend.decimal, T: years },
      cfg.type,
    );
    impliedVolPct = solved.sigma === null ? null : solved.sigma * 100;
  }
  if (impliedVolPct === null && !expired) {
    caveats.add('IV_NO_CONVERGENCE');
    ctx.unavailable.add({
      field: 'results.impliedVolPct',
      reason: 'NO_SOURCE',
      detail:
        'implied vol does not converge: vega ≈ 0 (deep in-the-money, ' +
        `${String(days)}d to expiry)`,
    });
  }

  // ── 7. the valuation volatility ─────────────────────────────────────────────────────────────
  const providerIvPct = typeof market.providerIvPct.v === 'number' ? market.providerIvPct.v : null;
  const underlyingIv30 = typeof underlying.iv30.v === 'number' ? underlying.iv30.v : null;
  let volPct: number | null;
  let volSource: 'solved' | 'provider' | 'user';
  if (params.vol !== null) {
    volPct = params.vol;
    volSource = 'user';
  } else if (params.solveFor === 'vol' && impliedVolPct !== null) {
    volPct = impliedVolPct;
    volSource = 'solved';
  } else {
    volPct = providerIvPct;
    volSource = 'provider';
  }
  if (volPct === null) {
    volPct = underlyingIv30;
    volSource = 'provider';
    ctx.unavailable.add({
      field: 'inputs.volPct',
      reason: 'NO_SOURCE',
      detail: 'no contract IV from Cboe; 30-day underlying IV used',
    });
  }

  // A `const` alias so the guard below narrows it: `volPct` is reassigned above, and TypeScript
  // only carries an aliased condition's narrowing through a `const`.
  const volPctValue = volPct;
  const priceable = !expired && spotValue !== null && volPctValue !== null && volPctValue > 0;
  const state: ValueState = marketState === 'blank' ? 'blank' : marketState;

  const inputs: OvmlInputs = {
    model,
    style,
    spot:
      spotValue === null
        ? blankCell('PROVIDER_DOWN')
        : numCell(spotValue, spotSource === 'user' ? 'closed' : state, provIdxMkt),
    spotSource,
    volPct: volPct === null ? naCell(NO_VALUE) : numCell(volPct, state, provIdxMkt),
    volSource,
    ratePct: rate.cell,
    rateSource: rate.source,
    rateCurveDate: rate.curveDate,
    rateProvIdx: rate.provIdx,
    divYieldPct: dividend.cell,
    divSource: dividend.source,
    divProvIdx: dividend.provIdx,
    forward: null,
    carryB: rate.pct - dividend.pct,
    years,
    days,
    valuationTs,
    steps: model === 'crr' || model === 'trinomial' ? params.steps : null,
    paths: model === 'mc' ? params.paths : null,
    seed: model === 'mc' ? params.seed : null,
  };
  if (spotValue === null) {
    ctx.unavailable.add({
      field: 'inputs.spot',
      reason: 'NO_SOURCE',
      detail: 'no stored underlying price for the chain capture and none supplied',
    });
  }
  if (volPct === null) {
    // Already reported above, but the cell is null and the runner matches on the field path.
    ctx.unavailable.add({
      field: 'inputs.volPct',
      reason: 'NO_SOURCE',
      detail: 'no contract IV, no user volatility and no 30-day underlying IV',
    });
  }

  // ── 8–9. price, greeks, scenario, profile ───────────────────────────────────────────────────
  const emptyScenario: OvmlScenario = {
    spotPct: [...params.scenarioSpotPct],
    volPts: [...params.scenarioVolPts],
    days: params.scenarioDays,
    cells: [],
  };

  if (!priceable) {
    if (expired) {
      ctx.unavailable.add({
        field: 'results',
        reason: 'NOT_APPLICABLE',
        detail: `contract expired on ${terms.expiry}; OVML values live contracts only`,
      });
    } else {
      ctx.unavailable.add({
        field: 'results',
        reason: 'NO_SOURCE',
        detail: 'no spot or no volatility: the model has nothing to price with',
      });
    }
    const blank = expired ? naCell('NOT_IN_UNIVERSE') : blankCell('PROVIDER_DOWN');
    return {
      contract,
      underlying,
      market,
      inputs: { ...inputs, forward: null },
      results: blankResults(blank, terms.multiplier, params.contracts),
      scenario: emptyScenario,
      greeksProfile: [],
      engines: enginesOf(ctx),
      caveats: [...caveats],
    };
  }

  const s: ModelState = {
    S: spotValue,
    K: terms.strike,
    r: rate.decimal,
    q: dividend.decimal,
    sigma: volPctValue / 100,
    T: years,
  };
  const forwardValue = params.forward ?? s.S * Math.exp((s.r - s.q) * s.T);
  inputs.forward = numCell(forwardValue, state, provIdxMkt);

  const greeks = greeksOf(ctx, cfg, s);
  const phi = terms.putCall === 'C' ? 1 : -1;
  const intrinsic = Math.max(phi * (s.S - s.K), 0);
  const scale = terms.multiplier * params.contracts;

  const results: OvmlResults = {
    price: numCell(greeks.price, state, provIdxMkt),
    intrinsic: numCell(intrinsic, state, provIdxMkt),
    timeValue: numCell(greeks.price - intrinsic, state, provIdxMkt),
    breakeven: numCell(s.K + phi * greeks.price, state, provIdxMkt),
    moneynessPct: numCell(100 * (s.S / s.K - 1), state, provIdxMkt),
    delta: numCell(greeks.delta, state, provIdxMkt),
    gamma: numCell(greeks.gamma, state, provIdxMkt),
    vega: numCell(greeks.vega, state, provIdxMkt),
    theta: numCell(greeks.theta, state, provIdxMkt),
    rho: numCell(greeks.rho, state, provIdxMkt),
    lambda:
      greeks.price === 0
        ? naCell(NO_VALUE)
        : numCell((greeks.delta * s.S) / greeks.price, state, provIdxMkt),
    vanna: numCell(greeks.vanna, state, provIdxMkt),
    volga: numCell(greeks.volga, state, provIdxMkt),
    charm: numCell(greeks.charm, state, provIdxMkt),
    impliedVolPct:
      impliedVolPct === null ? naCell(NO_VALUE) : numCell(impliedVolPct, state, provIdxMkt),
    mcStdErr: greeks.stdErr,
    perContract: {
      multiplier: terms.multiplier,
      contracts: params.contracts,
      premium: numCell(greeks.price * scale, state, provIdxMkt),
      deltaShares: numCell(greeks.delta * scale, state, provIdxMkt),
      gammaShares: numCell(greeks.gamma * scale, state, provIdxMkt),
      vegaCcy: numCell(greeks.vega * scale, state, provIdxMkt),
      thetaCcy: numCell(greeks.theta * scale, state, provIdxMkt),
      rhoCcy: numCell(greeks.rho * scale, state, provIdxMkt),
    },
  };
  if (greeks.price === 0) {
    ctx.unavailable.add({
      field: 'results.lambda',
      reason: 'NOT_APPLICABLE',
      detail: 'the model value is zero, so elasticity has no denominator',
    });
  }

  // Scenario: the same engine at every shocked state (§OVML step 9).
  const scenarioT = Math.max(s.T - params.scenarioDays / DAYS_PER_YEAR, DAY);
  const cells = params.scenarioSpotPct.flatMap((spotPct) =>
    params.scenarioVolPts.map((volPts) => {
      const shocked: ModelState = {
        ...s,
        S: s.S * (1 + spotPct / 100),
        sigma: Math.max((volPctValue + volPts) / 100, VOL_POINT / 100),
        T: scenarioT,
      };
      const run = runModel(ctx, cfg, shocked);
      return {
        spotPct,
        volPts,
        spot: shocked.S,
        volPct: shocked.sigma * 100,
        price: run.price,
        pnl: (run.price - greeks.price) * scale,
        delta: deltaOf(ctx, cfg, shocked, run),
      };
    }),
  );

  // Profile: 21 evenly spaced spots over ±20 %, at the base vol.
  const greeksProfile: OvmlProfilePoint[] = [];
  for (let i = 0; i < OVML_PROFILE_POINTS; i += 1) {
    const factor = 1 - PROFILE_SPAN + (2 * PROFILE_SPAN * i) / (OVML_PROFILE_POINTS - 1);
    const at: ModelState = { ...s, S: s.S * factor };
    const run = runModel(ctx, cfg, at);
    const volUp = runModel(ctx, cfg, { ...at, sigma: at.sigma + VOL_POINT });
    const volDown = runModel(ctx, cfg, {
      ...at,
      sigma: Math.max(at.sigma - VOL_POINT, VOL_POINT / 100),
    });
    const shorter = runModel(ctx, cfg, { ...at, T: Math.max(at.T - DAY, DAY / 24) });
    greeksProfile.push({
      spot: at.S,
      price: run.price,
      delta: deltaOf(ctx, cfg, at, run),
      gamma: run.gamma ?? gammaFd(ctx, cfg, at, run.price),
      vega: run.vegaPerSigma === null ? (volUp.price - volDown.price) / 2 : run.vegaPerSigma * VOL_POINT,
      theta:
        run.thetaPerYear === null ? shorter.price - run.price : run.thetaPerYear / DAYS_PER_YEAR,
    });
  }

  return {
    contract,
    underlying,
    market,
    inputs,
    results,
    scenario: { ...emptyScenario, cells },
    greeksProfile,
    engines: enginesOf(ctx),
    caveats: [...caveats],
  };
}

function gammaFd(ctx: ResolveContext, cfg: ModelConfig, s: ModelState, price: number): number {
  const h = Math.max(s.S * SPOT_BUMP, 1e-6);
  const up = runModel(ctx, cfg, { ...s, S: s.S + h }).price;
  const down = runModel(ctx, cfg, { ...s, S: s.S - h }).price;
  return (up - 2 * price + down) / (h * h);
}

/** `meta.engines` collapsed to the footer's `name@version` list, in first-seen order. */
function enginesOf(ctx: ResolveContext): { name: string; version: string }[] {
  const seen = new Set<string>();
  const out: { name: string; version: string }[] = [];
  for (const engine of ctx.engines.list()) {
    const key = `${engine.name}@${engine.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: engine.name, version: engine.version });
  }
  return out;
}

function blankResults(blank: ValueCell, multiplier: number, contracts: number): OvmlResults {
  const cell = (): ValueCell => ({ ...blank });
  return {
    price: cell(),
    intrinsic: cell(),
    timeValue: cell(),
    breakeven: cell(),
    moneynessPct: cell(),
    delta: cell(),
    gamma: cell(),
    vega: cell(),
    theta: cell(),
    rho: cell(),
    lambda: cell(),
    vanna: cell(),
    volga: cell(),
    charm: cell(),
    impliedVolPct: cell(),
    mcStdErr: null,
    perContract: {
      multiplier,
      contracts,
      premium: cell(),
      deltaShares: cell(),
      gammaShares: cell(),
      vegaCcy: cell(),
      thetaCcy: cell(),
      rhoCcy: cell(),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Blocks
// ─────────────────────────────────────────────────────────────────────────────────────────────

function marketBlock(
  ctx: ResolveContext,
  args: { row: OptionQuote | null; chain: ChainSnapshot; state: ValueState; provIdx: number },
): OvmlMarket {
  const { row, state, provIdx } = args;
  const reason: ReasonCode = row === null ? 'PROVIDER_DOWN' : NO_VALUE;
  const cell = (value: number | null | undefined, field: string): ValueCell => {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      ctx.unavailable.add({
        field: `market.${field}`,
        reason: 'NO_SOURCE',
        detail:
          row === null
            ? 'no Cboe chain row stored for this contract'
            : `the Cboe capture carries no ${field} for this contract`,
      });
      return { v: null, st: row === null ? 'blank' : 'na', r: reason, provIdx: -1 };
    }
    return { v: value, st: state, provIdx };
  };

  const bid = row?.bid ?? null;
  const ask = row?.ask ?? null;
  const mid = bid !== null && ask !== null && ask >= bid ? (bid + ask) / 2 : null;
  if (mid === null && row !== null) {
    ctx.unavailable.add({
      field: 'market.mid',
      reason: 'NO_SOURCE',
      detail: 'one-sided or crossed Cboe quote',
    });
  }

  return {
    bid: cell(bid, 'bid'),
    ask: cell(ask, 'ask'),
    mid:
      mid === null
        ? { v: null, st: row === null ? 'blank' : 'na', r: reason, provIdx: -1 }
        : { v: mid, st: state, provIdx },
    last: cell(row?.last, 'last'),
    lastTs: row?.lastTs ?? null,
    prevClose: cell(row?.prevClose, 'prevClose'),
    volume: cell(row?.volume, 'volume'),
    openInterest: cell(row?.openInterest, 'openInterest'),
    providerIvPct: cell(row?.iv === null || row?.iv === undefined ? null : row.iv * 100, 'providerIvPct'),
    providerDelta: cell(row?.delta, 'providerDelta'),
    providerGamma: cell(row?.gamma, 'providerGamma'),
    providerVega: cell(row?.vega, 'providerVega'),
    providerTheta: cell(row?.theta, 'providerTheta'),
    providerRho: cell(row?.rho, 'providerRho'),
    providerTheo: cell(row?.theo, 'providerTheo'),
    captureTs: row?.captureTs ?? args.chain.captureTs,
    provIdx,
  };
}

function underlyingBlock(
  ctx: ResolveContext,
  args: {
    chain: ChainSnapshot;
    subject: string;
    state: ValueState;
    provIdx: number;
    name: string;
  },
): OvmlUnderlying {
  const { chain, subject, state, provIdx } = args;
  const snapshot = ctx.plant.snapshot(subject);
  const has = (field: 'PX_LAST' | 'CHG_PCT_1D' | 'IVOL_30D'): boolean =>
    snapshot !== undefined && typeof snapshot.fields[field] === 'number';

  const px = has('PX_LAST')
    ? cellFromState(ctx, snapshot, 'PX_LAST', subject)
    : chain.underlying.px === null
      ? naCell(NO_VALUE)
      : numCell(chain.underlying.px, state, provIdx);
  const chgPct = has('CHG_PCT_1D')
    ? cellFromState(ctx, snapshot, 'CHG_PCT_1D', subject)
    : chain.underlying.chgPct === null
      ? naCell(NO_VALUE)
      : numCell(100 * chain.underlying.chgPct, state, provIdx);
  const iv30 = has('IVOL_30D')
    ? cellFromState(ctx, snapshot, 'IVOL_30D', subject)
    : chain.underlying.iv30 === null
      ? naCell(NO_VALUE)
      : numCell(chain.underlying.iv30, state, provIdx);

  for (const [field, cell, what] of [
    ['underlying.px', px, 'underlying price'],
    ['underlying.chgPct', chgPct, 'percent change on the day'],
    ['underlying.iv30', iv30, '30-day implied volatility'],
  ] as const) {
    if (cell.v === null) {
      ctx.unavailable.add({
        field,
        reason: 'NO_SOURCE',
        detail: `no ${what} for ${chain.underlying.display} in the plant or the Cboe capture`,
      });
    }
  }

  return {
    instrumentId: chain.underlying.instrumentId,
    key: chain.underlying.display,
    name: args.name,
    px,
    chgPct,
    iv30,
    provIdx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rate and dividend yield (§OVML step 5)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface RateInput {
  pct: number;
  decimal: number;
  cell: ValueCell;
  source: 'SOFR_OIS' | 'SOFR_FIX_FLAT' | 'user';
  curveDate: string | null;
  provIdx: number | null;
}

/**
 * `r`, continuously compounded, at the option's maturity.
 *
 * The `SOFR_OIS` build first — and with it the two caveats that are true of every build in this
 * one, because its term points are proxies (§0 CRVF table, BRIEF §2). With no build at all, the
 * latest SOFR fixing is used flat, which is a materially different statement and says so.
 */
async function rateInput(
  ctx: ResolveContext,
  args: {
    params: OvmlParams;
    valuationDate: string;
    years: number;
    caveats: Set<OvmlCaveat>;
    /**
     * What a number the user typed cites. A user input has no `provenance` row of its own — the
     * runner refuses a cited id that the table does not contain — so it cites the capture the rest
     * of the valuation rests on, exactly as SWPM's user-supplied fixed rate does, and
     * `rateSource: 'user'` is what says where the number came from (TIER1 §0.4 rule 4).
     */
    fallbackProvIdx: number;
  },
): Promise<RateInput> {
  const { params, caveats } = args;
  if (params.rate !== null) {
    return {
      pct: params.rate,
      decimal: params.rate / 100,
      cell: numCell(params.rate, 'closed', args.fallbackProvIdx),
      source: 'user',
      curveDate: null,
      provIdx: null,
    };
  }

  const build = await ctx.data.curves
    .build(CURVE_ID, args.valuationDate, 'monotone_convex')
    .catch(() => null);
  if (build !== null) {
    for (const caveat of OVML_PROXY_CURVE_CAVEATS) caveats.add(caveat);
    ctx.engines.add(build.engine);
    const curveProvenanceId = build.provenanceIds[0];
    const provIdx =
      curveProvenanceId === undefined
        ? args.fallbackProvIdx
        : ctx.prov.add({
            sourceId: 'internal.derived',
            provenanceId: curveProvenanceId,
            capturedAt: new Date(`${build.curveDate}T00:00:00.000Z`),
            sourceTs: null,
            st: 'closed',
            tier: 'eod',
          });
    const decimal = build.curve.zero(Math.max(args.years, 1 / 365), 'continuous');
    const pct = decimal * 100;
    return {
      pct,
      decimal,
      cell: numCell(pct, 'closed', provIdx),
      source: 'SOFR_OIS',
      curveDate: build.curveDate,
      provIdx,
    };
  }

  caveats.add('RATE_FLAT_SOFR');
  ctx.unavailable.add({
    field: 'inputs.ratePct',
    reason: 'NO_SOURCE',
    detail:
      `no SOFR_OIS build on or before ${args.valuationDate}; latest SOFR fixing used flat`,
  });
  const fixing = await ctx.data.rates.latest('SOFR').catch(() => null);
  if (fixing?.rate === undefined || fixing.rate === null) {
    return {
      pct: 0,
      decimal: 0,
      cell: naCell(NO_VALUE),
      source: 'SOFR_FIX_FLAT',
      curveDate: null,
      provIdx: null,
    };
  }
  const provIdx = ctx.prov.add({
    sourceId: 'nyfed.rates',
    provenanceId: fixing.provenanceId,
    capturedAt: new Date(fixing.capturedAt),
    sourceTs: fixing.sourceTs === null ? null : new Date(fixing.sourceTs),
    st: 'closed',
    tier: 'eod',
  });
  return {
    pct: fixing.rate,
    decimal: fixing.rate / 100,
    cell: numCell(fixing.rate, 'closed', provIdx),
    source: 'SOFR_FIX_FLAT',
    curveDate: fixing.effectiveDate,
    provIdx,
  };
}

interface DividendInput {
  pct: number;
  decimal: number;
  cell: ValueCell;
  source: 'trailing_12m' | 'user' | 'none';
  provIdx: number | null;
}

/**
 * `q = ln(1 + D₁₂ / spot)`, continuously compounded, from the trailing twelve months of confirmed
 * or paid cash dividends.
 *
 * No dividend rows is **not** an error: an index and a non-payer both have a yield of zero, and
 * `NO_DIVIDEND_HISTORY` states which of the two the reader is looking at without blanking a cell
 * that has a correct value.
 */
async function dividendInput(
  ctx: ResolveContext,
  args: {
    params: OvmlParams;
    underlyingId: number;
    valuationDate: string;
    spot: number | null;
    caveats: Set<OvmlCaveat>;
    /** See `rateInput`: what a user input, or a derived zero, cites. */
    fallbackProvIdx: number;
  },
): Promise<DividendInput> {
  const { params } = args;
  if (params.divYield !== null) {
    return {
      pct: params.divYield,
      decimal: params.divYield / 100,
      cell: numCell(params.divYield, 'closed', args.fallbackProvIdx),
      source: 'user',
      provIdx: null,
    };
  }

  const res = await ctx.db.execute<{ total: string | null; provenance_id: string | null }>(sql`
    SELECT sum(amount)::text AS total, min(provenance_id)::text AS provenance_id
      FROM corporate_actions
     WHERE instrument_id = ${args.underlyingId}::bigint
       AND ca_type = 'cash_dividend'
       AND status IN ('confirmed', 'paid')
       AND ex_date >  (${args.valuationDate}::date - INTERVAL '365 days')
       AND ex_date <= ${args.valuationDate}::date
       AND bt_as_of(valid_from, valid_to, tx_from, tx_to,
                    ${ctx.asOf.validAt}::timestamptz, ${ctx.asOf.knownAt}::timestamptz)`);
  const row = res.rows[0];
  const total = row?.total === null || row?.total === undefined ? null : Number(row.total);

  if (total === null || !Number.isFinite(total) || total <= 0 || args.spot === null) {
    args.caveats.add('NO_DIVIDEND_HISTORY');
    return {
      pct: 0,
      decimal: 0,
      cell: numCell(0, 'closed', args.fallbackProvIdx),
      source: 'none',
      provIdx: null,
    };
  }

  const provenanceId = row?.provenance_id === null || row?.provenance_id === undefined
    ? null
    : Number(row.provenance_id);
  const provIdx =
    provenanceId === null
      ? args.fallbackProvIdx
      : ctx.prov.add({
          sourceId: 'internal.derived',
          provenanceId,
          capturedAt: ctx.asOf.validAt,
          sourceTs: null,
          st: 'closed',
          tier: 'eod',
        });
  const decimal = Math.log(1 + total / args.spot);
  const pct = decimal * 100;
  return {
    pct,
    decimal,
    cell: numCell(pct, 'closed', provIdx),
    source: 'trailing_12m',
    provIdx,
  };
}
