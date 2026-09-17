### OVML — Option Valuation

| Attribute | Value |
| --- | --- |
| Code / aliases | `OVML` / `OV`, `OPTVAL` (no `aliasParams`) |
| Tier / category | 3 / derivatives |
| Asset classes → variants | `option → contract`; `equity, etf, index → underlying` (ATM contract picked) |
| requiresSecurity / pageable / screenKind | `true` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/OVML.ts` · `packages/server/src/functions/OVML/resolve.ts` · `packages/web/src/screens/OVML/Screen.tsx` · `fixtures/golden/functions/OVML.contract.{json,csv}` · `fixtures/golden/functions/OVML.underlying.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (ANAL-03) (ANAL-08) (ANAL-09) (REF-04) (DATA-03) (DATA-10) (TERM-08) (TERM-11) (TERM-12) (ENTL-05) (QA-01) (QA-02) |

OVML values **one vanilla listed option** on the conventions fixed in §0 ("Option conventions"): `T` in years ACT/365F from `ctx.asOf.validAt` to `option_terms.expiry` 16:00 ET, `r` = continuously-compounded `SOFR_OIS` zero at `T`, `q` = continuously-compounded trailing-12-month cash dividend yield, premiums per share with `option_terms.multiplier` applied only in the `perContract` block. The two variants differ only in how the contract is obtained: `contract` uses the panel security, `underlying` picks the nearest non-expired expiry and the strike closest to spot (FUNC-02). Exotics and path-dependent payoffs are out of scope in v1 — the PDE branch of (ANAL-03) is not built and the footer carries `VANILLA_ONLY_NO_EXOTICS`. Every number comes from a `core/analytics` engine registered with `ctx.engines.add` (ANAL-08); the resolver performs no arithmetic of its own beyond unit conversion.

#### Params
```ts
export const OvmlParams = z.object({
  model: z.enum(['bsm', 'black76', 'crr', 'trinomial', 'mc']).nullable().default(null),  // null = 'crr' for american, 'bsm' for european
  style: z.enum(['american', 'european']).nullable().default(null),                      // null = option_terms.exercise_style
  expiry: z.iso.date().nullable().default(null),                                         // underlying variant: which expiry to pick from
  strike: z.number().positive().max(1e6).nullable().default(null),                       // underlying variant: null = strike nearest spot
  putCall: z.enum(['C', 'P']).default('C'),                                              // underlying variant only
  solveFor: z.enum(['vol', 'price']).default('vol'),                                     // 'vol' = imply vol from the market mid; 'price' = value at params.vol
  vol: z.number().min(0.01).max(500).nullable().default(null),                           // percent; null = provider iv (solveFor 'price') or solved (solveFor 'vol')
  price: z.number().min(0).max(1e6).nullable().default(null),                            // premium per share to imply from; null = market mid
  spot: z.number().positive().max(1e7).nullable().default(null),                         // null = live underlying PX_LAST
  rate: z.number().min(-5).max(50).nullable().default(null),                             // percent, continuously compounded; null = SOFR_OIS zero at T
  divYield: z.number().min(0).max(50).nullable().default(null),                          // percent, continuous; null = derived from corporate_actions
  forward: z.number().positive().max(1e7).nullable().default(null),                      // black76 only; null = spot × exp((r − q) × T)
  contracts: z.number().int().min(1).max(1_000_000).default(1),
  steps: z.number().int().min(25).max(2000).default(500),                                // crr / trinomial
  paths: z.number().int().min(1000).max(1_000_000).default(100_000),                     // mc
  seed: z.number().int().min(0).max(2 ** 31 - 1).default(42),                            // mc reproducibility (ANAL-08)
  scenarioSpotPct: z.array(z.number().min(-90).max(90)).min(1).max(13).default([-10, -5, -2, 0, 2, 5, 10]),
  scenarioVolPts: z.array(z.number().min(-90).max(90)).min(1).max(7).default([-5, 0, 5]),
  scenarioDays: z.number().int().min(0).max(365).default(0),
  view: z.enum(['valuation', 'scenario', 'greeks']).default('valuation'),
});
```

#### Argument grammar
`positional [{ name:'strike', type:'number', optional:true }]` (ignored in the `contract` variant, where the strike comes from `option_terms`), `keyed { E: { name:'expiry', type:'date' }, K: { name:'strike', type:'number' }, PC: { name:'putCall', type:'enum', values:['C','P'] }, M: { name:'model', type:'enum', values:['bsm','black76','crr','trinomial','mc'] }, V: { name:'vol', type:'number' }, P: { name:'price', type:'number' }, S: { name:'spot', type:'number' }, R: { name:'rate', type:'number' }, Q: { name:'divYield', type:'number' }, N: { name:'contracts', type:'number' }, ST: { name:'steps', type:'number' } }`, no `rest`. `argMap` post-step: `V=` sets `solveFor:'price'`; `P=` sets `solveFor:'vol'` and `price`.
Examples: `AAPL 9/16/26 C245 Equity OVML` → `{ variant contract, model:null→crr, solveFor:'vol', … defaults }` · `AAPL US Equity OVML 245 E=2026-09-16 PC=C` → `{ strike:245, expiry:'2026-09-16', putCall:'C' }` (underlying variant) · `OVML V=28 M=BSM N=10` (panel holds the contract) → `{ vol:28, model:'bsm', solveFor:'price', contracts:10 }`.

#### Payload
```ts
export interface OvmlBody {
  contract: { instrumentId: number; key: string /* 'AAPL 9/16/26 C245 Equity' */; occSymbol: string; root: string; underlyingInstrumentId: number;
              expiry: string; expiryTs: string /* 2026-09-16T20:00:00Z, 16:00 ET pm settlement */; strike: number; putCall: 'C' | 'P';
              exerciseStyle: 'american' | 'european'; settlement: 'physical' | 'cash'; amPm: 'am' | 'pm'; multiplier: number;
              tickSize: number | null; isWeekly: boolean; lastTradeDate: string | null; provIdx: number };            // REF-04 terms as believed at ctx.asOf.knownAt
  underlying: { instrumentId: number; key: string /* 'AAPL US Equity' */; name: string; px: ValueCell; chgPct: ValueCell; iv30: ValueCell; provIdx: number };
  market: { bid: ValueCell; ask: ValueCell; mid: ValueCell; last: ValueCell; lastTs: string | null; prevClose: ValueCell; volume: ValueCell; openInterest: ValueCell;
            providerIvPct: ValueCell; providerDelta: ValueCell; providerGamma: ValueCell; providerVega: ValueCell; providerTheta: ValueCell; providerRho: ValueCell;
            providerTheo: ValueCell; captureTs: string; provIdx: number };                                            // Cboe delayed chain (DATA-03), 15-minute tier 'delayed'
  inputs: { model: 'bsm' | 'black76' | 'crr' | 'trinomial' | 'mc'; style: 'american' | 'european';
            spot: ValueCell; spotSource: 'market' | 'user';
            volPct: ValueCell; volSource: 'solved' | 'provider' | 'user';
            ratePct: ValueCell; rateSource: 'SOFR_OIS' | 'SOFR_FIX_FLAT' | 'user'; rateCurveDate: string | null; rateProvIdx: number | null;
            divYieldPct: ValueCell; divSource: 'trailing_12m' | 'user' | 'none'; divProvIdx: number | null;
            forward: ValueCell | null; carryB: number; years: number; days: number; valuationTs: string;
            steps: number | null; paths: number | null; seed: number | null };
  results: { price: ValueCell; intrinsic: ValueCell; timeValue: ValueCell; breakeven: ValueCell; moneynessPct: ValueCell;
             delta: ValueCell; gamma: ValueCell; vega: ValueCell; theta: ValueCell; rho: ValueCell; lambda: ValueCell;
             vanna: ValueCell; volga: ValueCell; charm: ValueCell;
             impliedVolPct: ValueCell;                                                                                 // solved from params.price ?? market.mid
             mcStdErr: number | null;                                                                                  // mc only
             perContract: { multiplier: number; contracts: number; premium: ValueCell; deltaShares: ValueCell; gammaShares: ValueCell;
                            vegaCcy: ValueCell; thetaCcy: ValueCell; rhoCcy: ValueCell } };
  scenario: { spotPct: number[]; volPts: number[]; days: number;
              cells: Array<{ spotPct: number; volPts: number; spot: number; volPct: number; price: number; pnl: number; delta: number }> };
  greeksProfile: Array<{ spot: number; price: number; delta: number; gamma: number; vega: number; theta: number }>;     // 21 points, spot ±20 %, for the greeks chart
  engines: Array<{ name: string; version: string }>;                                                                    // echo of meta.engines for the footer
  caveats: Array<'DEEP_ITM_IV_UNRELIABLE' | 'IV_NO_CONVERGENCE' | 'RATE_FLAT_SOFR' | 'PROXY_CURVE' | 'NO_FUTURES_SOURCE'
                 | 'VANILLA_ONLY_NO_EXOTICS' | 'NO_DIVIDEND_HISTORY' | 'EXPIRED_CONTRACT'>;
}
export type OvmlPayload =
  | ({ variant: 'contract' } & OvmlBody)
  | ({ variant: 'underlying'; picked: { rule: 'nearest_expiry_then_strike_nearest_spot'; expiry: string; strike: number; putCall: 'C' | 'P';
                                        expiriesAvailable: Array<{ expiry: string; contractCount: number }>; strikesAvailable: number[] } } & OvmlBody);
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `instruments`, `issues`, `issuers`, `listings` (as-of `ctx.asOf`), `option_terms` (bitemporal, read at `validAt/knownAt` — REF-04), `identifiers` (`OCC`), `option_quotes` (latest `capture_ts` for the contract and its chain), `quote_snapshots` (plant warm start for `q:` subjects), `md_lines` (`cboe.options`, `cboe.quotes`), `curve_points` + `curve_builds` (`SOFR_OIS`), `rate_fixings` (`SOFR`, flat fallback), `corporate_actions` (`ca_type='cash_dividend'`, `status IN ('confirmed','paid')`, trailing 12 months), `calendars` + `calendar_holidays` (`XCBO`) |
| Data services (§1.4.2) | `data.reference.instrument`, `data.reference.calendar('XCBO')`, `data.options.terms(contractId)`, `data.options.chain(underlyingId, expiry?)` (underlying variant and the market block), `data.curves.build('SOFR_OIS', date, 'monotone_convex')`, `data.rates.latest('SOFR')`, `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | `('cboe.options', root, { maxAgeMs: 60_000 })` when the contract has no `option_quotes` row younger than 60 s; `('cboe.quote', underlyingTicker, { maxAgeMs: 30_000 })` when the underlying `q:` state is `blank`. Circuit open with stored data → `{ fresh:false }`, cells rendered `stale` (TERM-12); circuit open with nothing stored → cells `{ v:null, st:'blank', r:'PROVIDER_DOWN' }`, never a throw |
| Engines (`core/analytics`) | `options/bsm@1.0.0` (BSM, Black-76, analytic greeks, Newton/Brent implied vol), `options/tree@1.0.0` (CRR binomial and trinomial, American exercise, greeks by finite difference on the tree), `options/mc@1.0.0` (GBM, antithetic + control-variate variance reduction, seeded), `curve/interp@1.0.0` and `curve/bootstrap@1.0.0` (the `SOFR_OIS` zero at `T`) |
| Subjects (live) | `q:<contract.instrumentId>`, `q:<underlying.instrumentId>` |
| Field ids (`fieldIds(assetClass)`) | `option (contract): [OPT_STRIKE_PX, OPT_EXPIRE_DT, OPT_PUT_CALL, OPT_CONT_SIZE, OPT_UNDL_TICKER, OPT_UNDL_PX, PX_BID, PX_ASK, BID_SIZE, ASK_SIZE, PX_LAST, PX_CLOSE_1D, PX_VOLUME, LAST_TRADE_TIME, OPT_OI, OPT_IV, OPT_DELTA, OPT_GAMMA, OPT_VEGA, OPT_THETA, OPT_RHO, OPT_THEO, OPT_MODEL_PX, OPT_IMPL_VOL_MID, OPT_TIME_VALUE, OPT_INTRINSIC, OPT_BREAKEVEN, OPT_VANNA, OPT_VOLGA, OPT_CHARM, OPT_RATE_USED, OPT_DVD_YIELD_USED]`; `equity, etf, index (underlying): the same set plus [PX_LAST, CHG_PCT_1D, VOL_30D]` |

`OPT_MODEL_PX`, `OPT_IMPL_VOL_MID`, `OPT_TIME_VALUE`, `OPT_INTRINSIC`, `OPT_BREAKEVEN`, `OPT_VANNA`, `OPT_VOLGA`, `OPT_CHARM`, `OPT_RATE_USED` and `OPT_DVD_YIELD_USED` are **new** field ids introduced by this entry (field class `analytic`, source `internal.derived`); see "Additions required" in the cover note for this part.

#### Resolver
Both variants share steps 3–10; only 1–2 differ.

1. **`contract` variant.** `terms = await ctx.data.options.terms(ctx.instrument.instrumentId)` (bitemporal `option_terms` at `ctx.asOf`, REF-04). `provIdx_terms = ctx.prov.add({ sourceId:'cboe.options', provenanceId: terms.provenanceId, capturedAt, sourceTs:null, st:'closed', tier:'delayed' })`. `terms.expiry < valuationDate` → `caveats.push('EXPIRED_CONTRACT')`, `ctx.unavailable.add({ field:'results', reason:'NOT_APPLICABLE', detail:'contract expired on <expiry>; OVML values live contracts only' })` and every `results` cell `{ v:null, st:'na', r:'NOT_IN_UNIVERSE' }` (the terms and market blocks are still returned).
2. **`underlying` variant.** `chain = await ctx.data.options.chain(ctx.instrument.instrumentId, params.expiry ?? undefined)`; `expiry = params.expiry ?? first of chain.expiries with expiry ≥ valuationDate` (nearest); `spot0 = chain.underlying.px`; `strike = params.strike ?? argmin |strike − spot0|` over the contracts of that expiry with `putCall === params.putCall`; that contract's `OptionTerms` becomes `terms`. No expiry at or after the valuation date → `ctx.unavailable.add({ field:'contract', reason:'NO_SOURCE', detail:'no unexpired expiry in the stored Cboe chain for <root>' })` and a payload whose `results` cells are `{ v:null, st:'blank', r:'PROVIDER_DOWN' }`. `picked` records the rule and the available expiries/strikes for the screen's pickers.
3. **Market block.** `row = chain.contracts.find(c => c.instrumentId === terms.instrumentId)?.q` (the `contract` variant fetches `chain(terms.underlyingInstrumentId, terms.expiry)` for this, one call). Missing or older than 60 s → `providers.ensure('cboe.options', terms.root, { maxAgeMs: 60_000 })`, then re-read. `mid = (bid + ask) / 2` when both sides are present and `ask ≥ bid`, else `null` with `ctx.unavailable.add({ field:'market.mid', reason:'NO_SOURCE', detail:'one-sided or crossed Cboe quote' })`. `providerIvPct = row.iv × 100` (the `cboe.options` adapter normalises the fractional contract `iv` — fixture `2.3515` → `235.15` percent — while the underlying `iv30` is already percent, §0 "Percent vs decimal on the wire"). `provIdx_mkt = ctx.prov.add({ sourceId:'cboe.options', provenanceId: row.provenanceId, capturedAt: row.captureTs, sourceTs: chain.captureTs, st: <plant state>, tier:'delayed' })`.
4. **Underlying block.** `subjU = plant.subjectFor(terms.underlyingInstrumentId)`; `plant.ensureHot([subjU, subjC])`; `stateU = plant.snapshot(subjU)`; `px/chgPct/iv30` from `PX_LAST`/`CHG_PCT_1D`/`VOL_30D` with `ctx.prov.addQuote(stateU)`; `blank` → `providers.ensure('cboe.quote', …)` once, then re-snapshot; still blank → `spot` falls back to `chain.underlying.px` and cites `provIdx_mkt`.
5. **Inputs.** `spot = params.spot ?? stateU.PX_LAST ?? chain.underlying.px` (`spotSource`). `years = ACT/365F(ctx.asOf.validAt → expiryTs)` where `expiryTs = expiry 16:00 America/New_York` (`am_pm_settlement='pm'`); `years ≤ 0` → the `EXPIRED_CONTRACT` branch of step 1. `rate`: `params.rate ?? build.curve.zero(years)` from `data.curves.build('SOFR_OIS', latest curve date ≤ valuationDate, 'monotone_convex')` (`rateSource:'SOFR_OIS'`, `caveats.push('PROXY_CURVE','NO_FUTURES_SOURCE')` — §0 CRVF table); build unavailable → `data.rates.latest('SOFR').rate` flat with `rateSource:'SOFR_FIX_FLAT'` and `caveats.push('RATE_FLAT_SOFR')`. `divYield`: `params.divYield ?? 100 × ln(1 + D12 / spot)` where `D12` = sum of `corporate_actions.amount` for `ca_type='cash_dividend'` with `ex_date` in the trailing 365 days (`divSource:'trailing_12m'`); no dividend rows → `0` with `divSource:'none'` and `caveats.push('NO_DIVIDEND_HISTORY')` (indices and non-payers are the normal case, not an error). `carryB = rate − divYield`; `forward = params.forward ?? spot × exp(carryB/100 × years)`. `model = params.model ?? (style === 'american' ? 'crr' : 'bsm')`; `style = params.style ?? terms.exerciseStyle`; `model === 'bsm'` with `style === 'american'` → the European value is returned and `ctx.unavailable.add({ field:'inputs.style', reason:'NOT_APPLICABLE', detail:'BSM prices European exercise; the contract is American — use CRR or trinomial' })`.
6. **Implied vol.** `impliedVolPct = bsm.impliedVol({ price: params.price ?? market.mid, spot, strike, years, r, q, putCall, style, model })` (Newton from a Brenner-Subrahmanyam seed, Brent bracket `[0.01 %, 500 %]`, tolerance 1e-8 on price; American → the `options/tree` pricer inside the same solver). `vega < 1e-4`, price outside the no-arbitrage bounds, or no bracket → `impliedVolPct = { v:null, st:'na', r:'NO_DATA' }`, `caveats.push('IV_NO_CONVERGENCE')` and `ctx.unavailable.add({ field:'results.impliedVolPct', reason:'NO_SOURCE', detail:'implied vol does not converge: vega ≈ 0 (deep in-the-money, <days>d to expiry)' })`. `|moneynessPct| > 25` or `|delta| > 0.99` → `caveats.push('DEEP_ITM_IV_UNRELIABLE')` (the fixture contract `AAPL260916C00245000` is exactly this case: spot 330.30, strike 245, provider delta 0.9999, provider IV 235.15 %).
7. **Valuation vol.** `volPct = params.vol ?? (params.solveFor === 'vol' ? impliedVolPct : providerIvPct)`; still null → `providerIvPct`; still null → `underlying.iv30` with `ctx.unavailable.add({ field:'inputs.volPct', reason:'NO_SOURCE', detail:'no contract IV from Cboe; 30-day underlying IV used' })`.
8. **Price and greeks.** One engine call per `inputs.model`: `bsm.price` (analytic greeks: delta, gamma, vega, theta, rho, lambda, vanna, volga, charm), `bsm.black76` (on `inputs.forward`; requires a forward — with no futures source it is always the derived `spot × exp(bT)`, so `caveats.push('NO_FUTURES_SOURCE')`), `tree.crr` / `tree.trinomial` (`steps`, greeks by central differences on the lattice; American early exercise), `mc.price` (`paths`, `seed`, antithetic + BSM control variate; returns `mcStdErr`). `intrinsic = max(φ(spot − strike), 0)` with `φ = +1` for calls, `−1` for puts; `timeValue = price − intrinsic`; `breakeven = strike + φ × price`; `moneynessPct = 100 × (spot / strike − 1)`. `perContract` multiplies by `terms.multiplier × params.contracts` (`vegaCcy` per 1 vol point, `thetaCcy` per calendar day, `rhoCcy` per 1 % rate). `ctx.engines.add(engine)` for every call (ANAL-08).
9. **Scenario and profile.** `scenario.cells` = the cross product of `scenarioSpotPct` × `scenarioVolPts` repriced with the same engine at `spot × (1 + s/100)`, `volPct + v`, `years − scenarioDays/365` (floored at 1/365); `pnl = (price_scenario − price_base) × multiplier × contracts`. `greeksProfile` = 21 evenly spaced spots over `[0.8 × spot, 1.2 × spot]` at the base vol. Both blocks are pure compute; no extra IO.
10. Return `{ variant, … }`. Every `results` cell carries `{ v, st: worst of (market.st, underlying.st), provIdx: provIdx_mkt, ts: market.captureTs }` — a model number is no fresher than its worst input (TERM-12).
Budget: 2 DB round-trips warm (instrument+terms+identifiers in one; chain+quotes in one), +1 for the `SOFR_OIS` `curve_builds` probe, +1 for the dividend sum; 0 provider calls when the chain is younger than 60 s. Engine compute: BSM < 1 ms, CRR 500 steps < 8 ms, MC 100k paths < 40 ms. p95 < 200 ms warm (`mc` < 260 ms).

#### Live
`{ subjects: ['q:' + contract.instrumentId, 'q:' + underlying.instrumentId], fields: ['PX_BID','PX_ASK','PX_LAST','PX_VOLUME','LAST_TRADE_TIME','OPT_IV','OPT_DELTA','OPT_GAMMA','OPT_VEGA','OPT_THETA','OPT_RHO','OPT_THEO','OPT_OI','OPT_UNDL_PX','CHG_PCT_1D','VOL_30D'], conflationMs: 1000 }`.
Only the `market` and `underlying` cells carry `Cell.live = { subject, field }` and flash (TERM-08). `results` cells are **never** mutated client-side: the model lives on the server, so when the streamed `OPT_UNDL_PX`/`PX_LAST` moves the spot more than 0.25 % away from `inputs.spot.v`, the screen raises the amber badge `INPUTS_MOVED` (defined by this entry) reading `spot 331.20 vs priced 330.30 · Enter to reprice`; `Enter` re-runs with `launchKind:'param'` and `details.changed:['spot']`. `grid.live.subjectOf` is unused (no live grid on this screen).

#### Screen
```
┌ OVML · AAPL 9/16/26 C245 Equity · Apple Inc · CRR 500 · 1d ────────────────────────────────────────┐
│ badges#caveats [DEEP_ITM_IV_UNRELIABLE] [PROXY_CURVE] [VANILLA_ONLY_NO_EXOTICS] [INPUTS_MOVED]      │
│ split(row, [0.32, 0.68])                                                                            │
│ ┌ form#inputs ───────────────┐ ┌ kv#results (columns 2) ─────────────────────────────────────────┐ │
│ │ Model   [bsm|black76|crr|  │ │ Model value   85.3410   Intrinsic      85.3000                  │ │
│ │          trinomial|mc]     │ │ Time value     0.0410   Breakeven     330.3410                 │ │
│ │ Style   [american|european]│ │ Implied vol   —  (no convergence)  Provider IV  235.15 %        │ │
│ │ Spot     330.30  (live)    │ │ Delta        0.99988    Gamma        0.000041                  │ │
│ │ Vol %    235.1500          │ │ Vega         0.00009    Theta        -0.0374 /day              │ │
│ │ Rate %     3.6132 SOFR_OIS │ │ Rho          0.00671    Lambda      3868.4                     │ │
│ │ Div yld %  0.3900 12m      │ │ Vanna       -0.000012   Volga        0.000003  Charm -0.00021  │ │
│ │ Strike   245.00 (terms)    │ │ ── per contract × 1 (multiplier 100) ────────────────────────── │ │
│ │ Expiry   2026-09-16 16:00ET│ │ Premium   8,534.10   Δ shares  99.99   Vega $ 0.01  Θ $ -3.74  │ │
│ │ Contracts 1   Steps 500    │ │ Market: bid 84.15 / ask 86.70 · mid 85.4250 · last 84.84 (10:40)│ │
│ └────────────────────────────┘ │        OI 1 · vol 4 · prev close 89.8250 · cap 18:40:39Z        │ │
│ kv#terms  OCC · root · put/call · exercise · settlement · AM/PM · multiplier · last trade · weekly  │
│ tabs#view [1 Valuation] [2 Scenario → grid#scenario] [3 Greeks → custom#profile GreeksChart]        │
│ footer: sources ['Cboe delayed option chain (15-min)', 'Cboe delayed quotes', 'SOFR OIS (proxy)']   │
│         engines: options/tree@1.0.0 · curve/bootstrap@1.0.0 · asOf 2026-09-15T18:41:28Z             │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
`grid#scenario` (tab 2) is a matrix: rows = `scenarioSpotPct` (label `spot −10 % → 297.27`), columns = `scenarioVolPts` (label `vol −5`), each cell `price` over `pnl` (`fmt:'px'` / `fmt:'ccy'`, `dir` from the sign of `pnl`); the `0/0` cell is `tone:'highlight'`. `custom#profile` (tab 3) builds `ChartSpec` `{ kind:'line', xAxis:{ type:'value', fmt:'px', label:'Spot' }, yAxes:[{ id:'y', side:'left', scale:'linear', fmt:'px', decimals:4 }, { id:'g', side:'right', scale:'linear', fmt:'px', decimals:5 }], panes:[{ id:'main', height:1 }], series:[ price (line, y), delta (line, g), gamma (line, g, dashed), vega (line, g, hidden by default), theta (line, g, hidden by default) ], crosshair:true, reference:[{ kind:'vline', x: inputs.spot.v, label:'spot' }, { kind:'vline', x: contract.strike, label:'strike', style:'dashed' }] }` (CHRT-01).
Title `OVML · <contract.key> · <underlying.name> · <model upper> <steps|paths> · <days>d`; subtitle `valued 2026-09-15 18:41:28Z · r 3.6132 % SOFR_OIS 2026-09-14 · q 0.3900 % · T 0.002889y`. In the `underlying` variant the title reads `OVML · AAPL US Equity · picked C245 09/16/26 (ATM)` and `form#inputs` gains two pickers (`Expiry`, `Strike`) fed from `picked.expiriesAvailable` / `picked.strikesAvailable`. `initialFocus:'inputs'`. Skeleton while `payload === undefined`: the form with the security key filled and every `kv#results` value rendered as a muted `—`. `meta.unavailable` rows render their cell as `—` with `detail` as the tooltip and add an amber badge to `badges#caveats`; `meta.entitlement` downgrades (`NO_FIRM_ENTITLEMENT` on `cboe.options`) blank the whole `market` block and every `results` cell with the reason code, leaving user-supplied inputs priceable (ENTL-05). `EXPIRED_CONTRACT` replaces `kv#results` with `text#na` "OVML values live contracts; this contract expired on 2026-09-16" (tone `warn`).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | form | `revalue` | submit the form → `ctx.setParams({ model, style, spot, vol, price, rate, divYield, contracts, steps, paths })` (usage `fn.param`) |
| `ArrowUp` / `ArrowDown` | form | `bump-field` | ±1 step on the focused numeric field (vol ±0.25 pt, spot ±0.01, rate ±1 bp, contracts ±1) — form-local until `Enter` |
| `Shift+ArrowUp` / `Shift+ArrowDown` | form | `bump-field-10` | ×10 of the above (`FormField.bigStep`) |
| `M` | always | `cycle-model` | `bsm → black76 → crr → trinomial → mc` → `setParams({ model })` |
| `X` | always | `cycle-style` | `american ⇄ european` |
| `I` | always | `solve-iv` | `setParams({ solveFor:'vol', vol:null, price:null })` — reprice at the vol implied by the market mid |
| `V` | always | `vol-prompt` | `ctx.prompt('number', { label:'Volatility %', initial: inputs.volPct.v })` → `setParams({ vol, solveFor:'price' })` |
| `K` | always | `strike-prompt` | `underlying` variant only: `ctx.prompt('number', { label:'Strike' })` → `setParams({ strike })` |
| `E` | always | `expiry-prompt` | `underlying` variant only: `ctx.prompt('date', { label:'Expiry' })` → `setParams({ expiry })` |
| `P` | always | `toggle-put-call` | `underlying` variant only: `putCall` `C ⇄ P` |
| `1` / `2` / `3` | always | `tab-valuation` / `tab-scenario` / `tab-greeks` | `setParams({ view })` (tabs; §2.6 rule 5) |
| `O` | always | `open-omon` | `ctx.navigate(underlying.key + ' OMON ' + contract.expiry)` |
| `D` | always | `open-des` | `ctx.navigate('DES')` (the contract's option DES variant) |
| `G` | always | `open-gp` | `ctx.navigate('GP')` |
| `Shift+Enter` | grid (scenario) | `open-omon-next` | `ctx.navigateNext(underlying.key + ' OMON ' + contract.expiry)` |
| `Ctrl+I` | always | `provenance` | `ctx.provenance(focusedCell.provIdx)` (DATA-10, shared shell binding) |

#### CSV
`filename = 'OVML_' + contract.occSymbol + '_' + asOf.replace(/[-:]/g,'') + '.csv'`. Long format (FUNCTIONS.md §1.6 rule 3 — a single valued object plus two matrices): columns `section,key,value,unit,asOf,source`. Rows in this order: one per `contract` field (`section='contract'`, `unit` `text|date|px|int`), one per `underlying` field (`section='underlying'`), one per `market` field (`section='market'`, `unit` `px|int|pct`), one per `inputs` field (`section='inputs'`, `unit` `px|pct|years|text`), one per `results` scalar (`section='results'`), one per `perContract` field (`section='perContract'`, `unit='ccy'`), one per scenario cell (`section='scenario'`, `key = spotPct + '/' + volPts`, `value = price`, plus a second row keyed `spotPct + '/' + volPts + '/pnl'` with `unit='ccy'`), one per profile point (`section='profile'`, `key = spot`, `value = price`, plus `key = spot + '/delta'`). `source` = `internal.derived` for engine output, `cboe.options` / `cboe.quotes` for provider values, `internal.user` for user-supplied inputs. Example row: `results,timeValue,0.0410,px,2026-09-15T18:41:28Z,internal.derived`.

#### Help
summary `Vanilla option valuation: BSM/Black-76/binomial/trinomial/MC with full greeks`; description `OVML values one listed option and shows its full greek set. Launched on a contract it values that contract; launched on an equity, ETF or index it picks the nearest expiry and the strike closest to spot. With no inputs it implies volatility from the Cboe mid and reprices at that vol; type a volatility to value at your own number, or a premium to imply a vol from it. The rate is the SOFR OIS zero at the option's maturity (a proxy curve in this build) and the dividend yield is the trailing twelve months of cash dividends. American contracts default to a 500-step CRR tree; Monte Carlo is seeded and reproducible. The scenario tab reprices a spot × volatility matrix with an optional time decay. Only vanilla payoffs are supported — there is no exotic or path-dependent pricer in v1.`; params `model` ("bsm, black76, crr, trinomial or mc", `crr`), `style` ("american or european; default from the contract terms"), `expiry` ("expiry to pick when launched on the underlying", `2026-10-16`), `strike` ("strike to pick when launched on the underlying", `245`), `putCall` ("C or P when launched on the underlying"), `solveFor` ("vol implies from the market price, price values at your vol"), `vol` ("volatility, percent", `28`), `price` ("premium per share to imply a vol from", `85.42`), `spot` ("override the underlying price"), `rate` ("continuously-compounded rate, percent"), `divYield` ("continuous dividend yield, percent"), `forward` ("forward price for Black-76"), `contracts` ("number of contracts for the per-contract block", `10`), `steps` ("tree steps", `500`), `paths` ("Monte Carlo paths", `100000`), `seed` ("Monte Carlo seed"), `scenarioSpotPct` ("spot shocks, percent"), `scenarioVolPts` ("vol shocks, points"), `scenarioDays` ("days of decay in the scenario"), `view` ("valuation, scenario or greeks"); sources `['cboe.options', 'cboe.quotes', 'nyfed.rates', 'treasury.yieldcurve', 'internal.derived', 'internal.user']`; related `['OMON', 'DES', 'GP', 'CRVF', 'Q']`.

#### Unavailable and reason codes
| Case | `meta.unavailable` / footer |
| --- | --- |
| Contract already expired at the valuation timestamp | `{ field:'results', reason:'NOT_APPLICABLE', detail:'contract expired on <expiry>; OVML values live contracts only' }`; caveat `EXPIRED_CONTRACT`; `kv#results` replaced by `text#na` |
| Implied vol does not converge (vega ≈ 0, deep ITM, ≤ 1 day) | `{ field:'results.impliedVolPct', reason:'NO_SOURCE', detail:'implied vol does not converge: vega ≈ 0 (deep in-the-money, <days>d to expiry)' }`; caveat `IV_NO_CONVERGENCE`; the cell renders `—`, the model still prices at the provider IV |
| Deep ITM/OTM provider IV (`|moneyness| > 25 %` or `|delta| > 0.99`) | caveat `DEEP_ITM_IV_UNRELIABLE` (amber badge, no unavailable row — the number exists, its meaning is the caveat) |
| One-sided or crossed Cboe quote | `{ field:'market.mid', reason:'NO_SOURCE', detail:'one-sided or crossed Cboe quote' }`; `mid` renders `—`; `solveFor:'vol'` falls back to `last`, then to the provider IV |
| No `SOFR_OIS` build on or before the valuation date | `{ field:'inputs.ratePct', reason:'NO_SOURCE', detail:'no SOFR_OIS build on or before <date>; latest SOFR fixing used flat' }`; caveat `RATE_FLAT_SOFR` |
| `SOFR_OIS` used at all | caveats `PROXY_CURVE` + `NO_FUTURES_SOURCE` (§0 CRVF table: no OIS swap or futures source exists — BRIEF §2) |
| No cash dividends in the trailing 12 months | `divYieldPct = 0`, `divSource:'none'`, caveat `NO_DIVIDEND_HISTORY` (no unavailable row: zero is the correct yield for a non-payer) |
| Black-76 selected | caveat `NO_FUTURES_SOURCE` and `{ field:'inputs.forward', reason:'NO_SOURCE', detail:'no futures or forward source; forward derived as spot × exp((r − q)T)' }` |
| BSM selected on an American contract | `{ field:'inputs.style', reason:'NOT_APPLICABLE', detail:'BSM prices European exercise; the contract is American — use CRR or trinomial' }` |
| Exotic / path-dependent request (any payload of this kind) | not representable in `OvmlParams`; the constant caveat `VANILLA_ONLY_NO_EXOTICS` states the boundary (ANAL-03 partially met, recorded in TRACEABILITY.md) |
| Cboe chain circuit open, stored data present | cells `st:'stale'`, `meta.staleness:'stale'`, footer `CHAIN CAPTURED <ts>` (TERM-12); no throw |
| Cboe chain circuit open, nothing stored | every market/results cell `{ v:null, st:'blank', r:'PROVIDER_DOWN' }`; user-supplied `spot` + `vol` still price |
| Entitlement | `meta.entitlement[]` per denied field; `NO_FIRM_ENTITLEMENT` on `cboe.options` blanks `market` and `results`; `TIER_EOD` downgrade (`ENTL-05`) serves `PX_CLOSE_1D` in place of `PX_LAST` and stamps `meta.tier:'eod'` |
| Engine failure (tree/MC non-finite, solver exception) | `500 INTERNAL` with `details.engine = '<name>@<version>'`; never a partial number |

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared): every optional param has `.default()`, both variants declared, field ids exist in the dictionary |
| golden payload (contract) | `packages/server/test/integration/functions/OVML.golden.test.ts` | resolver on `AAPL 9/16/26 C245 Equity` at the frozen clock deep-equals `fixtures/golden/functions/OVML.contract.json` (seeded from `cboe-options`); `meta.engines` = `[options/tree@1.0.0, curve/bootstrap@1.0.0]` with a stable `inputsHash` across two runs (ANAL-08) |
| golden payload (underlying) | `packages/server/test/integration/functions/OVML.golden.test.ts` | resolver on `AAPL US Equity` picks `expiry 2026-09-16`, `strike 330` (nearest to 330.30) and equals `OVML.underlying.json`; `picked.rule = 'nearest_expiry_then_strike_nearest_spot'` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `OVML.contract.csv` and `OVML.underlying.csv`; every numeric cell equals the payload value (FUNC-03) |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at a frozen clock (API-05); shared |
| screen | `packages/web/test/screens/OVML.test.tsx` | both golden variants render; `1`/`2`/`3` switch tabs; `M` cycles the model through `setParams`; `ArrowUp` bumps vol 0.25 pt form-locally without a request; live cells registered for both `q:` subjects; `payload undefined` renders the skeleton; the `IV_NO_CONVERGENCE` cell renders `—` with the detail as tooltip |
| BSM benchmark | `packages/core/test/analytics/options.bsm.test.ts` | `fixtures/golden/analytics/options/bsm-hull-17.1.json` (S 42, K 40, r 10 %, σ 20 %, T 0.5 → call 4.76, put 0.81) to 1e-4; put-call parity `C − P = S·e^(−qT) − K·e^(−rT)` to 1e-10 over 500 random parameter sets (ANAL-09) |
| tree convergence | `packages/core/test/analytics/options.tree.test.ts` | CRR European at 2000 steps equals BSM within 1e-3; trinomial within 5e-4; American put ≥ European put and equals `fixtures/golden/analytics/options/crr-american-put.json`; American call on a zero-dividend underlying equals the European call to 1e-8 |
| Monte Carlo | `packages/core/test/analytics/options.mc.test.ts` | seed 42, 100k paths reproduces `fixtures/golden/analytics/options/mc-seed42.json` byte-for-byte; `|mc − bsm| < 3 × mcStdErr`; the control variate reduces `mcStdErr` by ≥ 5× versus plain GBM |
| implied vol solver | `packages/core/test/analytics/options.iv.test.ts` | `impliedVol(price(σ)) = σ` within 1e-8 for σ ∈ [1 %, 300 %] × T ∈ [1/365, 2]; vega < 1e-4 returns `null` rather than a wild root |
| degraded inputs | `packages/server/test/integration/functions/OVML.degraded.test.ts` | with `curve_builds`/`curve_points` for `SOFR_OIS` deleted: `rateSource:'SOFR_FIX_FLAT'`, caveat `RATE_FLAT_SOFR`, one `meta.unavailable` row, HTTP 200; with the `cboe.options` circuit forced open and no stored chain: every market cell `st:'blank'`, `r:'PROVIDER_DOWN'`, no throw |
| not applicable | `packages/server/test/unit/functions/runner.test.ts` (shared case) | `OVML` on `T 4.25 08/15/36 Govt` → `422 FUNCTION_NOT_APPLICABLE { assetClass:'govt', applicable:['option','equity','etf','index'] }` |
| e2e | `packages/e2e/tests/options.spec.ts` | `AAPL US Equity OMON <GO>` → `Enter` on the 245 call row opens `OVML` in the panel → `V` sets vol 28 → the model value changes → `PRINT` exports a CSV whose `results,price` equals the screen value (FUNC-03, API-05) |

---

### OMON — Option Monitor

| Attribute | Value |
| --- | --- |
| Code / aliases | `OMON` / `CHAIN` (no `aliasParams`) |
| Tier / category | 3 / derivatives |
| Asset classes → variants | `equity, etf, index → underlying` |
| requiresSecurity / pageable / screenKind | `true` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/OMON.ts` · `packages/server/src/functions/OMON/resolve.ts` · `packages/web/src/screens/OMON/Screen.tsx` · `fixtures/golden/functions/OMON.underlying.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (ANAL-04) (ANAL-08) (DATA-03) (DATA-10) (TERM-08) (TERM-11) (TERM-12) (ENTL-05) (BUS-02) (BUS-03) (QA-01) (QA-02) |

OMON shows the **listed chain as Cboe publishes it** for one expiry: one row per strike, calls on the left, puts on the right, with the exchange's own IV and greeks (`cboe.options` `iv, delta, gamma, vega, theta, rho, theo`) rather than re-derived numbers — the screen is a monitor of the market's marks, and OVML is where a number gets re-derived. The only OMON-computed values are `mid`, the put/call ratios, the ATM strike and the optional SVI smile fit (ANAL-04). Quotes are exchange-published and 15 minutes delayed (BRIEF §2, DATA-03): tier is `delayed` and the delay is stated in the footer, never hidden (TERM-12).

#### Params
```ts
export const OmonParams = z.object({
  expiry: z.iso.date().nullable().default(null),                 // null = nearest expiry ≥ the valuation date
  strikes: z.number().int().min(1).max(40).default(10),          // strikes each side of the centre
  center: z.union([z.literal('atm'), z.number().positive().max(1e6)]).default('atm'),
  moneyness: z.number().min(1).max(100).nullable().default(null),// percent band around the centre; overrides `strikes` when set
  columns: z.array(z.enum(['bid', 'ask', 'mid', 'last', 'chg', 'volume', 'oi', 'iv', 'delta', 'gamma', 'vega', 'theta', 'rho', 'theo']))
            .min(1).max(14).default(['theo', 'delta', 'iv', 'oi', 'volume', 'chg', 'last', 'bid', 'ask']),
  view: z.enum(['chain', 'smile', 'summary']).default('chain'),
  sort: z.enum(['strike_asc', 'strike_desc']).default('strike_asc'),
});
```

#### Argument grammar
`positional [{ name:'expiry', type:'date', optional:true }]`, `keyed { E: { name:'expiry', type:'date' }, N: { name:'strikes', type:'number' }, C: { name:'center', type:'number' }, MNY: { name:'moneyness', type:'number' }, V: { name:'view', type:'enum', values:['chain','smile','summary'] } }`, no `rest`.
Examples: `AAPL US Equity OMON` → `{ expiry:null → 2026-09-16, strikes:10, center:'atm', view:'chain' }` · `AAPL US Equity OMON 2026-10-16` → `{ expiry:'2026-10-16' }` · `OMON N=20 MNY=15 V=SMILE` (panel holds `AAPL US Equity`) → `{ strikes:20, moneyness:15, view:'smile' }`.

#### Payload
```ts
export interface OmonLeg {
  instrumentId: number; key: string /* 'AAPL 9/16/26 C245 Equity' */; occSymbol: string; subject: string /* 'q:80421' */;
  bid: ValueCell; ask: ValueCell; bidSize: ValueCell; askSize: ValueCell; mid: ValueCell; last: ValueCell; lastTs: string | null;
  chg: ValueCell; chgPct: ValueCell; prevClose: ValueCell; volume: ValueCell; openInterest: ValueCell;
  ivPct: ValueCell; delta: ValueCell; gamma: ValueCell; vega: ValueCell; theta: ValueCell; rho: ValueCell; theo: ValueCell;
  ivSuspect: boolean;                                            // |delta| > 0.99 or |moneyness| > 25 % — the DEEP_ITM_IV_UNRELIABLE rule
  provIdx: number;
}
export type OmonPayload = {
  variant: 'underlying';
  underlying: { instrumentId: number; key: string; name: string; px: ValueCell; chg: ValueCell; chgPct: ValueCell;
                iv30Pct: ValueCell; volume: ValueCell; subject: string; provIdx: number; captureTs: string };
  expiries: Array<{ expiry: string; days: number; contractCount: number; isSelected: boolean; isWeekly: boolean }>;
  selected: { expiry: string; expiryTs: string; days: number; years: number; contractCount: number;
              atmStrike: number | null; atmIvPct: ValueCell; forward: ValueCell | null;
              putCallVolumeRatio: ValueCell; putCallOiRatio: ValueCell;
              totals: { callVolume: ValueCell; putVolume: ValueCell; callOi: ValueCell; putOi: ValueCell } };
  rows: Array<{ strike: number; isAtm: boolean; moneynessPct: number; call: OmonLeg | null; put: OmonLeg | null }>;
  smile: { points: Array<{ strike: number; moneynessPct: number; callIvPct: number | null; putIvPct: number | null; oiTotal: number | null }>;
           svi: { a: number; b: number; rho: number; m: number; sigma: number; rmse: number; n: number } | null;
           sviSource: 'fit' | 'stored' | null;
           sviUnavailableReason: 'SURFACE_STORE_NOT_IMPLEMENTED' | 'TOO_FEW_USABLE_QUOTES' | null };
  captureTs: string; delayMin: 15;
  caveats: Array<'DELAYED_15MIN' | 'PROVIDER_GREEKS_CBOE' | 'DEEP_ITM_IV_UNRELIABLE' | 'NO_OPRA_DEPTH' | 'SURFACE_NOT_STORED'>;
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `instruments` (underlying and every contract, current versions), `issues`, `issuers`, `option_terms` (bitemporal at `ctx.asOf`), `option_quotes` (latest `capture_ts` partition for `underlying_instrument_id`), `quote_snapshots` (plant warm start), `md_lines` (`cboe.options`, `cboe.quotes`), `vol_surfaces` (read only: a stored SVI fit for `(underlying_instrument_id, as_of, expiry)`), `calendars` + `calendar_holidays` (`XCBO`, for `days`) |
| Data services (§1.4.2) | `data.reference.instrument`, `data.reference.calendar('XCBO')`, `data.options.chain(underlyingId, expiry?)`, `plant.subjectFor`, `plant.snapshot`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | `('cboe.options', root, { maxAgeMs: 60_000 })` when the newest `option_quotes.capture_ts` for the underlying is older than 60 s; `('cboe.quote', ticker, { maxAgeMs: 30_000 })` when the underlying `q:` state is `blank`. The Cboe chain file is ~1.5 MB (`cboe-options`, 3,510 contracts for AAPL), so the TTL is never lowered below 60 s and the fetch is per **root**, never per contract |
| Engines (`core/analytics`) | `vol/surface@1.0.0` (SVI fit for the smile tab, ANAL-04). No pricing engine: the greeks on this screen are the exchange's |
| Subjects (live) | `oc:<underlyingInstrumentId>` (chain summary: `EXPIRIES, ATM_IV, PUT_CALL_RATIO, CONTRACT_COUNT`), `q:<underlyingInstrumentId>`, and `q:<contractInstrumentId>` for every leg in `rows` (at most `2 × strikes + 2 = 82` subjects) |
| Field ids (`fieldIds(assetClass)`) | `equity, etf, index: [PX_LAST, CHG_NET_1D, CHG_PCT_1D, PX_VOLUME, VOL_30D, OPT_STRIKE_PX, OPT_EXPIRE_DT, OPT_PUT_CALL, OPT_CONT_SIZE, OPT_UNDL_TICKER, OPT_UNDL_PX, PX_BID, PX_ASK, BID_SIZE, ASK_SIZE, PX_CLOSE_1D, LAST_TRADE_TIME, OPT_OI, OPT_IV, OPT_DELTA, OPT_GAMMA, OPT_VEGA, OPT_THETA, OPT_RHO, OPT_THEO]` — all existing ids; OMON introduces none |

#### Resolver
1. `inst = await ctx.data.reference.instrument(ctx.instrument.instrumentId)`; `subjU = plant.subjectFor(inst.instrumentId)`; `plant.ensureHot([subjU, plant.subjectFor(inst.instrumentId, 'oc')])`.
2. `chain = await ctx.data.options.chain(inst.instrumentId, params.expiry ?? undefined)` (one query over `option_terms ⋈ option_quotes` at the newest `capture_ts`, plus `chain.expiries` from a grouped count). Newest `capture_ts` older than 60 s → `providers.ensure('cboe.options', inst.ticker, { maxAgeMs: 60_000 })`, then re-read once. `chain.contracts.length === 0` after that → `ctx.unavailable.add({ field:'rows', reason:'NO_SOURCE', detail:'no listed options for <ticker> in the Cboe chain' })` and return a payload with `rows: []`, `expiries: []` (the correct answer for an underlying with no listed options — no invented rows).
3. `provIdx_chain = ctx.prov.add({ sourceId:'cboe.options', provenanceId: chain.contracts[0].q.provenanceId, capturedAt: chain.captureTs, sourceTs: chain.captureTs, st: 'live'|'stale' per §0, tier:'delayed' })`; `provIdx_undl = ctx.prov.addQuote(plant.snapshot(subjU))` (falling back to `ctx.prov.add` on `chain.underlying` when the plant state is missing).
4. **Expiry selection and paging.** `expiries = chain.expiries` annotated with `days = businessDays(valuationDate, expiry, XCBO calendar)` and `isWeekly` from `option_terms.is_weekly`. `expiry = params.expiry ?? ctx.page?.cursor ?? the nearest expiry ≥ valuationDate`. `ctx.page.set({ index: expiries.findIndex(e => e.expiry === expiry), count: expiries.length, cursor: base64url(JSON.stringify({ expiry })) })` — **PAGE FWD is the next expiry, PAGE BACK the previous** (template §7.2 rule 7); the cursor is `base64url(JSON)` of the last sort key `{ expiry }`. A cursor naming an expiry that is no longer listed → `422 VALIDATION_FAILED { location:'page', field:'cursor', detail:'expiry <e> is no longer listed' }`.
5. **Strike window.** `spot = plant PX_LAST ?? chain.underlying.px`; `centre = params.center === 'atm' ? the listed strike nearest spot : params.center`; `atmStrike = the listed strike nearest spot` (independent of `centre`). `params.moneyness` set → keep strikes within `±moneyness %` of `centre`; else keep the `params.strikes` listed strikes on each side of `centre` inclusive. Sort per `params.sort`.
6. **Legs.** For each kept strike, the `C` and `P` contract of the selected expiry; a missing side is `null` (a real gap in the listing, not a blank row). Per leg every cell is `{ v, st: <plant state or 'stale' when chain.captureTs is older than 3 × 10 s>, provIdx: provIdx_chain, ts: chain.captureTs, live: { subject, field } }`. `mid = (bid + ask) / 2` when both sides exist and `ask ≥ bid`, else `{ v:null, st:'na', r:'NO_DATA' }`. `ivPct = q.iv × 100` (the `cboe.options` adapter's fractional `iv`, e.g. `2.3515 → 235.15`; the underlying `iv30` is already percent). `chg = q.last − q.prevClose` and `chgPct` from the provider's `percent_change`. `ivSuspect = |delta| > 0.99 || |100 × (spot/strike − 1)| > 25`; any suspect leg → `caveats.push('DEEP_ITM_IV_UNRELIABLE')`.
7. **Summary.** `totals` sum `volume`/`openInterest` over **all** contracts of the selected expiry (not only the windowed strikes); `putCallVolumeRatio = putVolume / callVolume`, `putCallOiRatio = putOi / callOi` (`null` when the denominator is 0). `atmIvPct` = the average of the ATM call and put `ivPct` when both are usable, else whichever is usable, else `underlying.iv30Pct` with `ctx.unavailable.add({ field:'selected.atmIvPct', reason:'NO_SOURCE', detail:'no usable ATM contract IV; 30-day underlying IV shown' })`. `forward = spot` marked `{ st:'na', r:'NO_DATA' }` unless an OVML-style carry is available — OMON does **not** build a forward (no dividend/rate call on this screen); the cell is `null` and the smile is plotted against strike and moneyness, not log-forward-moneyness.
8. **Smile (`view:'smile'`, and always populated when `rows.length ≥ 5`).** `points` = every windowed strike with at least one usable IV (`ivSuspect` legs are plotted with `tone:'muted'` and excluded from the fit). A stored fit is read from `vol_surfaces` for `(underlying_instrument_id, as_of = date(chain.captureTs), expiry)` → `sviSource:'stored'`; on a miss the resolver fits in-process with `vol/surface@1.0.0` (`ctx.engines.add`) → `sviSource:'fit'` and `caveats.push('SURFACE_NOT_STORED')` with `sviUnavailableReason:'SURFACE_STORE_NOT_IMPLEMENTED'` because **no data service writes `vol_surfaces` in v1** (the table exists; the writer is listed under "Additions required"). Fewer than 5 usable IVs → `svi: null`, `sviUnavailableReason:'TOO_FEW_USABLE_QUOTES'`.
9. Constant caveats: `DELAYED_15MIN` (always — `md_lines.intrinsic_delay_min = 15`), `PROVIDER_GREEKS_CBOE` (always — the greeks are Cboe's, not ours), `NO_OPRA_DEPTH` (always — there is no OPRA feed: size is the Cboe top-of-book `bid_size`/`ask_size` only, DATA-03 partially met).
Budget: 2 DB round-trips warm (instrument; chain + expiry counts in one query with a `GROUP BY` CTE), 0 provider calls when the stored chain is younger than 60 s, 1 fetch of ~1.5 MB otherwise. SVI fit over ≤ 40 points < 6 ms. p95 < 250 ms warm, < 1.2 s on a cold chain fetch.

#### Live
`{ subjects: ['oc:' + underlying.instrumentId, 'q:' + underlying.instrumentId, ...rows.flatMap(r => [r.call?.subject, r.put?.subject]).filter(Boolean)], fields: ['PX_BID','PX_ASK','BID_SIZE','ASK_SIZE','PX_LAST','PX_CLOSE_1D','PX_VOLUME','LAST_TRADE_TIME','OPT_OI','OPT_IV','OPT_DELTA','OPT_GAMMA','OPT_VEGA','OPT_THETA','OPT_RHO','OPT_THEO','CHG_PCT_1D','VOL_30D'], conflationMs: 1000 }` — at most 82 subjects (BUS-03 conflation, BUS-02 subject grammar).
A chain row carries two subjects, so `grid.live.subjectOf` returns `null` and every cell instead carries its own `Cell.live = { subject: leg.subject, field }`; the grid flashes per cell on change (TERM-08). The `oc:` subject drives the header only: an `ATM_IV`/`PUT_CALL_RATIO` delta updates `kv#summary` in place, and a `CONTRACT_COUNT` change on the selected expiry raises the badge `CHAIN_CHANGED` (`Enter` re-runs with `launchKind:'param'`, `details.changed:['chain']`).

#### Screen
```
┌ OMON · AAPL US Equity · Apple Inc · 330.30 −2.78 (−0.83 %) · IV30 24.43 ────────────────────────────────┐
│ badges#caveats [DELAYED_15MIN] [PROVIDER_GREEKS_CBOE] [NO_OPRA_DEPTH] [DEEP_ITM_IV_UNRELIABLE] [CHAIN_CHANGED] │
│ tabs#expiry  [1 09/16/26 (1d) 214] [2 09/18/26 (3d) 186] [3 09/25/26 … ]   ◄ PAGE BACK · PAGE FWD ►     │
│ split(col, [0.74, 0.26])   (view 'chain' → [1,0], 'smile' → [0,1], 'summary' → [0.55,0.45])             │
│ ┌ grid#chain ──────────────────────────────────────────────────────────────────────────────────────┐   │
│ │ ── CALLS ──────────────────────────────┬ STRIKE ┬ ── PUTS ───────────────────────────────────── │   │
│ │ theo  delta  iv%   oi   vol  chg  last │        │ last  chg  vol   oi   iv%   delta  theo       │   │
│ │ 85.31 0.9999 235.15  1    4  -4.99 84.84│ 245.00*│  0.01 0.00   12  840  86.42 -0.0021  0.0043   │   │
│ │ …                                       │ 330.00◄│ …                                             │   │
│ └──────────────────────────────────────────────────────────────────────────────────────────────────┘   │
│ custom#smile  SmileChart — ChartSpec below                                                              │
│ kv#summary  expiry · days · contracts · ATM strike / ATM IV · call vol/OI · put vol/OI · P/C vol · P/C OI│
│ footer: sources ['Cboe delayed option chain (15-min, exchange-published)', 'Cboe delayed quotes']        │
│         captured 2026-09-15T18:40:39Z · greeks and IV as published by Cboe · asOf 2026-09-15T18:41:28Z   │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
Column set and order come from `params.columns`; calls render them mirrored (right-to-left) so the strike column is the axis (TERM-11). Formats: `bid/ask/mid/last/theo/chg` `fmt:'px'` `decimals:2` (`decimals:4` under 1.00), `iv` `fmt:'pct'` `decimals:2`, `delta/gamma` `fmt:'px'` `decimals:4`, `vega/theta/rho` `fmt:'px'` `decimals:4`, `volume/oi` `fmt:'int'`, `chgPct` `fmt:'pct'` `decimals:2` with `dir` driving the colour. The ATM row is `tone:'highlight'` (`◄` marker); in-the-money legs are `tone:'muted'`; `ivSuspect` cells render the value with an amber dot and `DEEP_ITM_IV_UNRELIABLE` as tooltip. `custom#smile` builds `ChartSpec` `{ kind:'line', xAxis:{ type:'value', fmt:'px', label:'Strike' }, yAxes:[{ id:'y', side:'left', scale:'linear', fmt:'pct', decimals:2 }], panes:[{ id:'main', height:1 }], series:[ callIv (scatter, y), putIv (scatter, y), svi (line, y, hidden when smile.svi === null) ], crosshair:true, reference:[{ kind:'vline', x: spot, label:'spot' }, { kind:'vline', x: selected.atmStrike, label:'ATM', style:'dashed' }] }` (CHRT-01, ANAL-04).
Title `OMON · <underlying.key> · <underlying.name>`; subtitle `<expiry> · <days>d · <contractCount> contracts · ATM <strike> IV <atmIv> % · P/C vol <ratio>`. `initialFocus:'chain'` (the ATM row). Skeleton while `payload === undefined`: the expiry tab bar as three muted chips and 21 muted grid rows. `meta.unavailable` rows render the affected cell as `—` with `detail` as tooltip plus an amber badge; `meta.entitlement` denials (`NO_FIRM_ENTITLEMENT` on `cboe.options`) blank every leg cell with the reason code while leaving strikes, expiries and the underlying header visible (ENTL-05). An underlying with no listed options renders `text#na` "No listed options for AAPL US Equity in the Cboe chain" (tone `warn`) in place of the grid.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid | `open-ovml` | `ctx.navigate(leg.key + ' OVML')` for the focused leg (call or put, from the focused column group) |
| `Shift+Enter` | grid | `open-ovml-next` | `ctx.navigateNext(leg.key + ' OVML')` |
| `ArrowLeft` / `ArrowRight` | always | `prev-expiry` / `next-expiry` | step through `expiries` → `setParams({ expiry })` (same effect as PAGE BACK / PAGE FWD) |
| `1` … `9` | always | `tab-expiry-<n>` | select the n-th listed expiry → `setParams({ expiry })` (tabs; §2.6 rule 5) |
| `N` | always | `strikes-prompt` | `ctx.prompt('number', { label:'Strikes each side', initial: params.strikes })` → `setParams({ strikes, moneyness:null })` |
| `C` | always | `center-prompt` | `ctx.prompt('number', { label:'Centre strike (blank = ATM)' })` → `setParams({ center })` |
| `Y` | always | `moneyness-prompt` | `ctx.prompt('number', { label:'Moneyness band %' })` → `setParams({ moneyness })` |
| `V` | always | `cycle-view` | `chain → smile → summary` → `setParams({ view })` |
| `O` | always | `cycle-columns` | toggles the focused column on/off in `params.columns` (minimum one) |
| `S` | always | `toggle-sort` | `strike_asc ⇄ strike_desc` |
| `D` | grid | `open-des` | `ctx.navigate(leg.key + ' DES')` (option DES variant) |
| `U` | always | `open-underlying-des` | `ctx.navigate(underlying.key + ' DES')` |
| `Q` | grid | `open-q` | `ctx.navigate(leg.key + ' Q')` |
| `Ctrl+I` | grid | `provenance` | `ctx.provenance(cell.provIdx)` (DATA-10, shared shell binding) |
| `Ctrl+W` | grid | `add-watchlist` | `ctx.prompt('watchlist')` then `sdk.watchlists.setItems` with the focused leg |

#### CSV
`filename = 'OMON_' + underlying.key.replace(/[^A-Za-z0-9]+/g,'_') + '_' + selected.expiry.replace(/-/g,'') + '_' + asOf.replace(/[-:]/g,'') + '.csv'`. Wide format, one row per **leg** (calls and puts are separate rows so the column set is rectangular — FUNCTIONS.md §1.6): columns `expiry,strike,side,occSymbol,key,bid,bidSize,ask,askSize,mid,last,lastTs,chg,chgPct,prevClose,volume,openInterest,ivPct,delta,gamma,vega,theta,rho,theo,ivSuspect,captureTs,source`. Rows ordered by `strike` per `params.sort`, calls before puts within a strike; `null` legs are omitted. The export always carries **every windowed strike**, not only the visible viewport, and `columns` does not narrow it (FUNC-03: the export is the data behind the screen, and entitlement is re-evaluated with `usage:'export'`). Example row: `2026-09-16,245,C,AAPL260916C00245000,AAPL 9/16/26 C245 Equity,84.15,125,86.7,27,85.425,84.84,2026-09-15T14:40:48Z,-4.985,-5.54968,89.825,4,1,235.15,0.9999,0,0.0001,0,0.0067,85.3062,true,2026-09-15T18:40:39Z,cboe.options`.

#### Help
summary `Listed option chain by expiry with Cboe IV and greeks, ATM highlight and smile`; description `OMON shows the listed chain for one expiry as the exchange publishes it: calls on the left, puts on the right, strikes down the middle, with Cboe's own implied volatility and greeks. The expiry tabs and PAGE FWD/PAGE BACK move between expiries; N sets how many strikes either side of the centre are shown and Y switches to a moneyness band. Implied volatilities for deep in- or out-of-the-money contracts are flagged as unreliable because a near-zero vega makes them meaningless. Quotes are exchange-published and fifteen minutes delayed; there is no OPRA feed, so size is Cboe top of book only. Press Enter on any leg to value it in OVML.`; params `expiry` ("expiry to show; default the nearest", `2026-10-16`), `strikes` ("strikes each side of the centre", `20`), `center` ("centre strike; default the ATM strike", `330`), `moneyness` ("percent band around the centre, overrides strikes", `15`), `columns` ("columns to show per leg"), `view` ("chain, smile or summary"), `sort` ("strike_asc or strike_desc"); sources `['cboe.options', 'cboe.quotes', 'internal.derived']`; related `['OVML', 'DES', 'Q', 'GP', 'GIP']`.

#### Unavailable and reason codes
| Case | `meta.unavailable` / footer |
| --- | --- |
| Underlying has no listed options | `{ field:'rows', reason:'NO_SOURCE', detail:'no listed options for <ticker> in the Cboe chain' }`; `rows: []`, `expiries: []`, `text#na` in place of the grid — no synthetic strikes are generated |
| Requested expiry not listed | `422 VALIDATION_FAILED { location:'fnParams', field:'expiry', detail:'<expiry> is not a listed expiry for <ticker>; listed: <first five>' }` |
| Page cursor names a delisted expiry | `422 VALIDATION_FAILED { location:'page', field:'cursor', detail:'expiry <e> is no longer listed' }` |
| One-sided or crossed quote on a leg | that leg's `mid` = `{ v:null, st:'na', r:'NO_DATA' }`; no `meta.unavailable` row (a one-sided market is a fact, not a gap) |
| Deep ITM/OTM IV | `ivSuspect:true` on the leg, caveat `DEEP_ITM_IV_UNRELIABLE`; the value is still shown, marked, and excluded from the SVI fit and from `atmIvPct` |
| No usable ATM contract IV | `{ field:'selected.atmIvPct', reason:'NO_SOURCE', detail:'no usable ATM contract IV; 30-day underlying IV shown' }` |
| Fewer than five usable IVs for the smile | `smile.svi = null`, `sviUnavailableReason:'TOO_FEW_USABLE_QUOTES'`; the chart shows the raw points only |
| SVI fit not persisted | caveat `SURFACE_NOT_STORED`, `sviUnavailableReason:'SURFACE_STORE_NOT_IMPLEMENTED'` — `vol_surfaces` exists but has no writer in v1, so the historical-surface half of (ANAL-04) is recorded as partial in TRACEABILITY.md |
| No forward | `selected.forward = null`; the smile is plotted against strike/moneyness, never against a fabricated log-forward-moneyness |
| Depth beyond top of book | constant caveat `NO_OPRA_DEPTH`, footer `size is Cboe top of book; no OPRA depth source` (DATA-03 partial) |
| Chain older than 3 × the expected interval | every leg cell `st:'stale'`, `meta.staleness:'stale'`, footer `CHAIN CAPTURED <ts>` (TERM-12) |
| Cboe circuit open, nothing stored | every leg cell `{ v:null, st:'blank', r:'PROVIDER_DOWN' }`; strikes, expiries and the underlying header still render |
| Entitlement | `meta.entitlement[]` per denied field; `NO_FIRM_ENTITLEMENT` on `cboe.options` blanks all leg cells with the reason; a `realtime` request downgrades to `delayed` with `SOURCE_TIER_CAP` (`licence_registry.max_tier` for `cboe.options` is `delayed`) and the badge states it (ENTL-05) |

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared); `pageable:true` implies a `page` handler and a documented cursor |
| golden payload | `packages/server/test/integration/functions/OMON.golden.test.ts` | resolver on `AAPL US Equity` at the frozen clock deep-equals `fixtures/golden/functions/OMON.underlying.json` (seeded from `cboe-options`, 3,510 contracts): 21 rows around strike 330, `selected.expiry = '2026-09-16'`, the 245 call leg carries `bid 84.15 / ask 86.70 / mid 85.425 / ivPct 235.15 / delta 0.9999 / theo 85.3062 / openInterest 1 / volume 4`, `ivSuspect:true`, `caveats` contains `DELAYED_15MIN`, `PROVIDER_GREEKS_CBOE`, `NO_OPRA_DEPTH`, `DEEP_ITM_IV_UNRELIABLE` |
| iv normalisation | `packages/server/test/unit/providers/cboeOptions.normalise.test.ts` | contract `iv: 2.3515` normalises to `ivPct 235.15` while underlying `iv30: 24.427` stays `24.427`; a round trip through `option_quotes.iv numeric(10,6)` is lossless |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `OMON.underlying.csv`; row count = number of non-null legs; every numeric cell equals the payload value (FUNC-03) |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at a frozen clock (API-05); shared |
| paging | `packages/server/test/integration/functions/OMON.page.test.ts` | PAGE FWD from `2026-09-16` returns `2026-09-18` with a new `resultId` and `meta.page = { index:1, count:<n>, cursor:base64url({"expiry":"2026-09-18"}) }`; PAGE BACK returns the first page; a cursor for an unlisted expiry → `422` |
| screen | `packages/web/test/screens/OMON.test.tsx` | golden renders 21 strike rows with mirrored call columns; the ATM row is highlighted; `Enter` on the 245 call navigates to `AAPL 9/16/26 C245 Equity OVML`; `ArrowRight` advances the expiry via `setParams`; `V` cycles to the smile and renders the ChartSpec; every leg cell registers a live subject; `payload undefined` renders the skeleton |
| no listed options | `packages/server/test/integration/functions/OMON.empty.test.ts` | on a seeded Cboe-only symbol with no chain: `rows: []`, one `meta.unavailable` row with `reason:'NO_SOURCE'`, HTTP 200, no invented strikes |
| stale / provider down | `packages/server/test/integration/functions/OMON.stale.test.ts` | with the `cboe.options` circuit forced open: stored chain → every cell `st:'stale'` and `meta.staleness:'stale'`; no stored chain → `st:'blank'`, `r:'PROVIDER_DOWN'`, no throw (TERM-12) |
| smile fit | `packages/core/test/analytics/vol.surface.test.ts` | the SVI fit of the golden chain reproduces `fixtures/golden/analytics/vol/svi-AAPL-2026-10-16.json` within 1e-6 and is arbitrage-free (positive density, no butterfly violation) at every node; `ivSuspect` points are excluded; fewer than five points returns `null` (ANAL-04, ANAL-09) |
| entitlement downgrade | `packages/server/test/integration/functions/OMON.entitlement.test.ts` | a firm grant capped at `delayed` requesting `realtime` yields `meta.tier:'delayed'` with `SOURCE_TIER_CAP` in `meta.entitlement`; a firm with no `cboe.options` grant gets blanked leg cells and a populated header (ENTL-05) |
| e2e | `packages/e2e/tests/options.spec.ts` | `AAPL US Equity OMON <GO>` renders the chain, `PAGE FWD` moves to the next expiry, `Enter` on a leg opens OVML in the same panel, `PRINT` exports a CSV whose 245-call `ivPct` equals the screen value |

---
