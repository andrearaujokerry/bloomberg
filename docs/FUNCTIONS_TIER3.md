# FUNCTIONS_TIER3 — asset-class depth: Treasuries, curves, policy path, options, swaps, Fed, crypto
Per-function manifests for the ten Tier 3 codes of [FUNCTIONS.md](./FUNCTIONS.md) §6, written to the template of FUNCTIONS.md §7 and binding on `packages/core/src/functions/manifests/<CODE>.ts`, `packages/server/src/functions/<CODE>/resolve.ts` and `packages/web/src/screens/<CODE>/Screen.tsx`.

## 0. Shared conventions for this file

Everything below is fixed here once and cited by the entries; an entry never restates it differently.

| Item | Value |
| --- | --- |
| Frozen clock for goldens | `2026-09-15T18:41:28Z` (FUNCTIONS.md §1.8, `PROVIDER_MODE=replay`); valuation date **2026-09-15**; NY time 14:41 ET, NYSE `open`, SIFMA `open` |
| Latest stored curve dates in the offline seed (DATA_MODEL §18 rows 6–7) | `UST_PAR` and `UST_BILL`: `2026-09-14` (fixtures `treasury-xml2`, `treasury-bills.xml`, nine dates 2026-09-01 … 2026-09-14); `UST_CMT`: `2026-09-11` (`fed-h15.csv`, 2026-09-08 … 09-11; 09-07 is `ND`); `SOFR_FIX`: `2026-09-14` (`nyfed-sofr`, five fixings 09-08 … 09-14); `SOFR_OIS`: built for `2026-09-14` (`curve_builds`) |
| Latest rate fixings (`rate_fixings`, `nyfed-all`/`nyfed-effr.json`/`nyfed-sofr`) | SOFR 2026-09-14 = 3.62 (p1 3.57, p25 3.60, p75 3.67, p99 3.70, vol 2861 bn); EFFR 2026-09-14 = 3.63, target 3.50–3.75, vol 91 bn; OBFR 3.63; TGCR 3.60; BGCR 3.60; SOFRAI 2026-09-15 avg30 3.6485, avg90 3.64603, avg180 3.65767, index 1.25884091 |
| Seed Treasuries (`govt_terms`, 14 rows) | bills (from `treasury-bills.xml` 2026-09-14 row): `912797VE4` 4WK mat 2026-09-29 · `912797UK1` 6WK · `912797VN4` 8WK · `912797VA2` 13WK · `912797WH6` 17WK · `912797WD5` 26WK · `912797WA1` 52WK; notes/bonds from `fixtures/seed/treasuries.json` (curated, DATA_MODEL §21.1 q2): 2Y, 3Y, 5Y, 7Y, 10Y `T 4.25 08/15/36`, 20Y, 30Y, each `on_the_run=true`, `term_label` = tenor, `coupon_freq=2`, `day_count='ACT/ACT'`, `business_day_conv='following'`, `calendar_id='SIFMA'`, `settlement_days=1` |
| Golden securities | YAS/DES govt: `T 4.25 08/15/36 Govt` (10Y note) and `912797VE4 Govt` (4WK bill); OVML/OMON: `AAPL US Equity` (3,510 contracts in `cboe-options`, underlying `current_price` 330.3, `iv30` 24.427) and contract `AAPL 9/16/26 C245 Equity` (`AAPL260916C00245000`); WIRP/FED: `fomc_meetings` from `fixtures/seed/fomc-2026.json` |
| `fixtures/seed/fomc-2026.json` (curated from `fed.fomc`, 8 rows) | decision dates `2026-01-28`, `2026-03-18` (SEP), `2026-04-29`, `2026-06-17` (SEP), `2026-07-29`, `2026-09-16` (SEP), `2026-10-28`, `2026-12-09` (SEP); `statement_at` = 14:00 ET on the decision day; `decision_bp` filled for the five past meetings, `NULL` for 09-16, 10-28, 12-09. At the frozen clock the next decision is **tomorrow, 2026-09-16** |
| Engines (`core/analytics`, ARCHITECTURE §3.1) and their `meta.engines[].name@version` | `bill@1.0.0` (`bill.ts`), `bond/price@1.0.0`, `bond/risk@1.0.0`, `bond/cashflows@1.0.0`, `curve/bootstrap@1.0.0`, `curve/interp@1.0.0`, `swap/ois@1.0.0`, `options/bsm@1.0.0`, `options/tree@1.0.0`, `options/mc@1.0.0`, `vol/surface@1.0.0`, `wirp/policyPath@1.0.0`. Every call goes through `defineEngine` so `inputsHash = sha256(canonicalJson(inputs))` (ANAL-08); the resolver registers each with `ctx.engines.add` |
| Treasury coupon conventions ("street") | price per 100 face, clean; yield in percent, **semiannual compounding**, day count **ACT/ACT (ICMA)** per `govt_terms.day_count='ACT/ACT'`; settlement **T+1** on the `SIFMA` calendar (`govt_terms.settlement_days`), business-day convention `following`; accrued = `coupon/2 × (days from previous coupon to settlement) / (days in coupon period)`; odd first/last periods handled by `bond/cashflows` (`first_coupon_date`, `last_regular_coupon`); last period discounted with simple interest when settlement is in the final coupon period (Treasury rule) |
| Treasury bill conventions | discount rate `d` on **ACT/360**: `price = 100 × (1 − d × t/360)`; investment yield (BEY): `t ≤ 182`: `365 × d / (360 − d × t)`; `t > 182`: the Treasury quadratic `(−2t/365 + 2 × sqrt((t/365)² − (2t/365 − 1) × (1 − 1/P)) ) / (2t/365 − 1)` with `P = price/100`; `t` = days settlement → maturity; settlement T+1 SIFMA |
| Duration / convexity / DV01 | Macaulay in years; modified = Macaulay / (1 + y/200); convexity = `(1/P) × d²P/dy²` in years² (yield in decimal); `DV01` = `modDur × dirtyPrice × face / 100 × 0.0001` in currency for `face`, and `dv01Per100` in price points; `yieldValueOf32nd` = yield change (bp) for a 1/32 price change |
| Key-rate durations | tenors `2Y 5Y 10Y 30Y`; bump the **zero** curve of the bond's pricing curve by ±1 bp with a triangular kernel (peak at the key tenor, zero at the neighbouring key tenors, flat beyond the ends), reprice with the bond's z-spread held fixed, `KRD_t = −(P⁺ − P⁻) / (2 × P × 0.0001)`; `Σ KRD ≈ modified duration` (asserted in tests within 2 %) |
| Curve build (`curve/bootstrap`) | `UST_PAR`: bills 1M–1Y as simple-interest ACT/360 discount factors, then par coupons 2Y–30Y bootstrapped semiannually (ACT/ACT) — method `bills+par_bootstrap`; `SOFR_OIS`: method `ois_bootstrap` over **proxy** inputs (see CRVF); node `t` in years ACT/365F from the curve date; `df(t)`, continuously-compounded `zero(t)` in percent, `fwd(t1,t2)` simple ACT/360 in percent; interpolation `linear_zero | log_linear_df | monotone_convex` (default `curves.default_interpolation = monotone_convex`) on `zero(t)`; every build is cached in `curve_builds` keyed by `inputs_hash` and returned by `ctx.data.curves.build(curveId, date, interpolation)` as `CurveBuild` (§0.1) |
| Option conventions | time to expiry `T` in years **ACT/365F** from `valuationTs` to `expiry` 16:00 ET (`option_terms.expiry`, `am_pm_settlement='pm'`); rate `r` = continuously-compounded `SOFR_OIS` zero at `T` (fallback: latest SOFR fixing flat, caveat `RATE_FLAT_SOFR`); dividend yield `q` = continuously-compounded trailing-12-month cash dividends ÷ spot; vols in percent on the wire (`24.427`), decimals inside engines; premiums per share, multiplier applied only in the `perContract` block |
| OIS swap conventions (`swap/ois`) | effective **T+2** SIFMA business days from the trade date; fixed leg **annual, ACT/360**; float leg **annual, daily-compounded SOFR, ACT/360** with observation shift 0 and **payment lag 2** business days; `modified_following`; calendar `SIFMA`; stub `short_front`; realised SOFR for elapsed accrual from `rate_fixings`; discounting and forwards from the same `SOFR_OIS` build (single-curve OIS) |
| Percent vs decimal on the wire | every rate, yield, spread-in-percent and vol in a payload is in **percent** (`4.9700`), spreads labelled `Bp` are in **basis points**, discount factors are unitless; `Cell.fmt` `'pct'` renders percent values, `'bp'` renders bp values (FUNCTIONS.md §1.3 rule 4) |
| Optional params | the manifest rule "every optional key has `.default()`" (FUNCTIONS.md §1.2 invariant 2) is met with `.nullable().default(null)`; `null` means "not supplied, derive it" |
| Curve arg type | `curve` (`ParamGrammar` type) coerces to `curves.curve_id ∈ { UST_PAR, UST_BILL, UST_CMT, SOFR_FIX, SOFR_OIS }` (FUNCTIONS.md §2.4) |
| Common footer badges | `PROXY_CURVE` (amber, SOFR_OIS built from proxies), `NO_FUTURES_SOURCE` (amber, WIRP/FED probabilities), `CONTEXT_ONLY_NOT_EXCHANGE_DATA` (amber, CRYP), `CURVE_UPDATED` (blue, a `c:` delta arrived after the payload; press `Enter` to reprice), `STALE` (TERM-12 glyph on the cell) |

### 0.1 Data-service shapes the entries rely on (`packages/server/src/data/{curves,rates,options,econ}.ts`)

`DataServices` in FUNCTIONS.md §1.4.2 names these types without spelling them; this is their spelling (WP-04 implements, WP-10 consumes).

```ts
// data/curves.ts
export interface CurvePoints {
  curveId: string; name: string; currency: string; kind: 'par'|'bill'|'cmt'|'fixing'|'ois'|'zero';
  dayCount: string; compounding: 'semiannual'|'annual'|'simple'|'continuous'; sourceId: string; defaultInterpolation: string;
  curveDate: string;                                                   // the date actually served (≤ requested date; latest when omitted)
  points: Array<{ tenor: string; tenorDays: number; quoteType: 'par_yield'|'discount_rate'|'investment_yield'|'cmt_yield'|'ois_rate'|'zero_rate'|'fixing';
                  value: number; instrumentId: number | null; maturityDate: string | null; vintageAt: string; provenanceId: number; capturedAt: string; sourceTs: string | null }>;
  availableDates: string[];                                            // curve_dates stored for this curve, descending, ≤ 400
}
export interface CurveBuild {
  buildId: number; curveId: string; curveDate: string; valuationTs: string; method: 'bills+par_bootstrap'|'ois_bootstrap'; interpolation: string;
  engine: { name: string; version: string; inputsHash: string };
  inputs: Array<{ tenor: string; tenorDays: number; quoteType: string; value: number; proxy: boolean; sourceId: string; provenanceId: number }>;
  nodes: Array<{ t: number; df: number; zero: number; fwd: number }>;   // t years ACT/365F; zero/fwd in percent
  provenanceIds: number[];
  curve: import('@terminal/core').Curve;                               // core/analytics/curve/curve.ts: df(t), zero(t), fwd(t1,t2), bump(tenorYears, bp), snapshot()
}
// data/rates.ts
export interface RateFixing { rateCode: string; effectiveDate: string; vintageAt: string; rate: number | null; pct1: number | null; pct25: number | null; pct75: number | null; pct99: number | null;
  volumeBn: number | null; targetFrom: number | null; targetTo: number | null; avg30d: number | null; avg90d: number | null; avg180d: number | null; indexValue: number | null;
  revisionIndicator: string | null; isLatest: boolean; provenanceId: number; capturedAt: string; sourceTs: string | null }
// data/options.ts
export interface OptionTerms { instrumentId: number; occSymbol: string; root: string; underlyingInstrumentId: number; expiry: string; strike: number; putCall: 'C'|'P';
  exerciseStyle: 'american'|'european'; settlement: 'physical'|'cash'; amPm: 'am'|'pm'; multiplier: number; tickSize: number | null; isWeekly: boolean; lastTradeDate: string | null; provenanceId: number }
export interface ChainSnapshot {
  underlying: { instrumentId: number; display: string; px: number | null; chgPct: number | null; iv30: number | null; provenanceId: number; capturedAt: string; sourceTs: string | null };
  captureTs: string; expiries: Array<{ expiry: string; contractCount: number }>;
  contracts: Array<OptionTerms & { q: { bid: number | null; ask: number | null; bidSize: number | null; askSize: number | null; last: number | null; lastTs: string | null; prevClose: number | null;
                                        volume: number | null; openInterest: number | null; iv: number | null; delta: number | null; gamma: number | null; vega: number | null; theta: number | null; rho: number | null; theo: number | null;
                                        underlyingPx: number | null; provenanceId: number; captureTs: string } | null }>;   // filtered to `expiry` when given
}
// data/econ.ts
export interface FomcMeeting { meetingDate: string; statementAt: string | null; hasSep: boolean; decisionBp: number | null; provenanceId: number | null }
```

### 0.2 Golden analytics datasets these entries pin (QA-01, ANAL-09)

`fixtures/golden/analytics/<engine>/<case>.json = { inputs, valuationTs, expected }` (ARCHITECTURE §2): `bond/T_4.25_08-15-36.json` (price↔yield at 4.97 % settlement 2026-09-16, accrued 31 days), `bill/912797VE4.json` (d = 3.69, t = 13 days), `bond/krd-sum.json`, `curve/UST_PAR-2026-09-14.json` (df/zero at every input tenor, three interpolations), `curve/SOFR_OIS-2026-09-14.json`, `swap/ois-5Y-par.json` (par rate, NPV = 0, DV01), `options/bsm-hull-17.1.json` (Hull example: S 42, K 40, r 10 %, σ 20 %, T 0.5 → call 4.76, put 0.81), `options/crr-american-put.json`, `options/mc-seed42.json`, `wirp/2026-09-15.json`, `vol/svi-AAPL-2026-10-16.json`. Every resolver test in this file re-uses them so the screen number equals the benchmark number (API-05, ANAL-09).

---

### YAS — Yield & Spread Analysis

| Attribute | Value |
| --- | --- |
| Code / aliases | `YAS` / `YA` |
| Tier / category | 3 / rates |
| Asset classes → variants | `govt → govt` |
| requiresSecurity / pageable / screenKind | `true` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/YAS.ts` · `packages/server/src/functions/YAS/resolve.ts` · `packages/web/src/screens/YAS/Screen.tsx` · `fixtures/golden/functions/YAS.govt.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (ANAL-01) (ANAL-02) (ANAL-08) (ANAL-09) (REF-03) (REF-04) (REF-06) (DATA-10) (TERM-06) (TERM-11) (TERM-12) (ENTL-05) (QA-01) |

YAS is polymorphic inside the `govt` variant on `govt_terms.security_type` (FUNC-02): a **coupon** security (`note`, `bond`) prices on the street convention; a **bill** prices on the discount basis. `tips`/`frn` are refused with `NOT_APPLICABLE` (below). Every analytic is a `core/analytics` engine call; the resolver never does arithmetic of its own (ANAL-08).

#### Params
```ts
export const YasParams = z.object({
  input: z.enum(['curve', 'yield', 'price', 'discount']).default('curve'),   // 'curve' = derive yield from the pricing curve; 'discount' is bills only
  yield: z.number().min(-5).max(50).nullable().default(null),               // percent, street convention (coupon securities)
  price: z.number().min(1).max(300).nullable().default(null),               // clean price per 100
  discount: z.number().min(-5).max(50).nullable().default(null),            // percent, bills only
  settlement: z.iso.date().nullable().default(null),                        // null = T+1 SIFMA from the valuation date
  face: z.number().positive().max(1e12).default(1_000_000),                 // currency face for DV01 / cashflow amounts
  curveId: z.enum(['UST_PAR', 'UST_CMT', 'SOFR_OIS']).default('UST_PAR'),  // spread and z-spread reference curve
  interpolation: z.enum(['linear_zero', 'log_linear_df', 'monotone_convex']).default('monotone_convex'),
  krdTenors: z.array(z.enum(['2Y', '5Y', '10Y', '30Y'])).min(1).max(4).default(['2Y', '5Y', '10Y', '30Y']),
  view: z.enum(['analysis', 'cashflows']).default('analysis'),
});
```
#### Argument grammar
`positional [{ name:'quote', type:'number', optional:true }]` — a single number is interpreted by shape and mapped by the manifest's `argMap`: `< 30` → `{ input:'yield', yield:n }` for coupon securities and `{ input:'discount', discount:n }` for bills; `≥ 30` → `{ input:'price', price:n }`. `keyed { S: { name:'settlement', type:'date' }, FACE: { name:'face', type:'number' }, CRV: { name:'curveId', type:'curve', values:['UST_PAR','UST_CMT','SOFR_OIS'] }, Y: { name:'yield', type:'number' }, P: { name:'price', type:'number' }, D: { name:'discount', type:'number' } }`, no `rest`. Keyed `Y=`/`P=`/`D=` also set `input` accordingly (the `argMap` post-step documented in the manifest).
Examples: `T 4.25 08/15/36 Govt YAS` → `{ input:'curve', … defaults }` · `YAS 4.95` (panel: the 10Y note) → `{ input:'yield', yield:4.95 }` · `YAS 99.5 S=2026-09-17 FACE=5000000` → `{ input:'price', price:99.5, settlement:'2026-09-17', face:5000000 }`.

#### Payload
```ts
export type YasPayload = {
  variant: 'govt';
  instrument: { instrumentId: number; key: string /* 'T 4.25 08/15/36 Govt' */; name: string; cusip: string; securityType: 'bill'|'note'|'bond'; termLabel: string | null; onTheRun: boolean };
  terms: { provIdx: number; couponRate: number | null; couponFreq: number; dayCount: string; issueDate: string | null; datedDate: string | null; maturityDate: string; firstCouponDate: string | null;
           businessDayConv: string; calendarId: string; settlementDays: number; minDenomination: number; amountOutstanding: number | null; knownAt: string };   // REF-03: terms as believed at ctx.asOf.knownAt
  settlement: { date: string; valuationDate: string; daysToMaturity: number; yearsToMaturity: number; rule: 'T+1 SIFMA' };
  inputs: { mode: 'curve'|'yield'|'price'|'discount'; source: 'user'|'curve'; curveId: string; curveDate: string; curveProvIdx: number; face: number };
  results:
    | { kind: 'coupon';
        yieldPct: ValueCell; cleanPrice: ValueCell; dirtyPrice: ValueCell; accrued: ValueCell; accruedDays: number; daysInPeriod: number;
        macaulayDuration: ValueCell; modifiedDuration: ValueCell; convexity: ValueCell; dv01: ValueCell; dv01Per100: ValueCell; yieldValueOf32nd: ValueCell;
        keyRateDurations: Array<{ tenor: '2Y'|'5Y'|'10Y'|'30Y'; krd: number }>;
        spreads: { interpolatedCurveYieldPct: ValueCell; toCurveBp: ValueCell; zSpreadBp: ValueCell; benchmark: { key: string; tenor: string; yieldPct: number; spreadBp: number; provIdx: number } | null };
        conventions: { dayCount: 'ACT/ACT'; compounding: 'semiannual'; couponFreq: 2; settlement: 'T+1'; calendar: 'SIFMA'; priceBasis: 'clean per 100' } }
    | { kind: 'bill';
        discountRatePct: ValueCell; investmentYieldPct: ValueCell; price: ValueCell; moneyMarketYieldPct: ValueCell; daysToMaturity: number;
        dollarDiscount: ValueCell; dv01: ValueCell; modifiedDuration: ValueCell;
        spreads: { interpolatedCurveYieldPct: ValueCell; toCurveBp: ValueCell; zSpreadBp: null; benchmark: null };
        conventions: { dayCount: 'ACT/360'; basis: 'discount'; settlement: 'T+1'; calendar: 'SIFMA'; beyFormula: 'le182'|'gt182' } };
  cashflows: Array<{ date: string; kind: 'coupon'|'principal'|'maturity'; days: number; coupon: number; principal: number; total: number; df: number | null; pv: number | null; fromCurve: boolean }>;   // amounts on `face`; df/pv from the pricing curve + z-spread
  curve: { id: string; date: string; interpolation: string; buildId: number; provIdx: number };
  engines: Array<{ name: string; version: string }>;   // echo of meta.engines names for the footer
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `instruments`, `issues`, `issuers` (as-of `ctx.asOf`), `govt_terms` (bitemporal, read at `validAt/knownAt`), `curve_points` (`is_latest`, `curve_date ≤ validAt`), `curve_builds` (cache), `calendars`, `calendar_holidays` (`SIFMA`), `identifiers` (CUSIP) |
| Data services (§1.4.2) | `data.reference.instrument`, `data.reference.calendar('SIFMA')`, `data.curves.points(curveId, date)`, `data.curves.build(curveId, date, interpolation)` |
| Read-through (`providers.ensure`) | `('treasury.yieldcurve' via kind 'fred.series'? — no: curves are scheduler-fed)` → **None.** The resolver reads stored curve points only; a missing curve for the valuation date falls back to the latest earlier date and cites it (never a live fetch: the Treasury endpoint takes ≈ 18 s, BRIEF §2). |
| Engines (`core/analytics`) | `bond/cashflows@1.0.0`, `bond/price@1.0.0`, `bond/risk@1.0.0`, `bill@1.0.0`, `curve/bootstrap@1.0.0`, `curve/interp@1.0.0` |
| Subjects (live) | `c:UST_PAR` (or `c:SOFR_OIS` when `curveId='SOFR_OIS'`) — notification only (§0 `CURVE_UPDATED`) |
| Field ids (`fieldIds(assetClass)`) | `govt: [CPN, CPN_FREQ, DAY_CNT_DES, MATURITY, ISSUE_DT, SECURITY_TYP, MTY_YEARS, YLD_YTM_MID, PX_DIRTY_MID, ACCRUED, DUR_MID, DUR_ADJ_MID, CONVEXITY_MID, DV01, KRD_2Y, KRD_5Y, KRD_10Y, KRD_30Y, DISC_RATE, BEY, CURVE_PAR, CURVE_ZERO, CURVE_DF]` |

#### Resolver
1. `inst = await ctx.data.reference.instrument(ctx.instrument.instrumentId)`; `terms = inst.terms` (kind `govt`, read as-of `ctx.asOf` — REF-03, ANAL-08). `terms.security_type ∈ {tips, frn}` → `ctx.unavailable.add({ field:'results', reason:'NOT_APPLICABLE', detail:'YAS v1 prices fixed-coupon notes/bonds and bills; TIPS/FRN pricing needs an inflation/reference-rate engine' })` and return a payload with `results` of kind `coupon` whose cells are `{ v:null, st:'na', r:'NOT_IN_UNIVERSE' }`. `provIdx_terms = ctx.prov.add({ sourceId: terms.sourceId, provenanceId: terms.provenanceId, capturedAt, sourceTs:null, st:'closed', tier:'eod' })`.
2. `cal = await ctx.data.reference.calendar('SIFMA')`; `valuationDate = ISO date of ctx.asOf.validAt in America/New_York`; `settlement = params.settlement ?? addBusinessDays(valuationDate, terms.settlementDays, cal)` (REF-06). Settlement after maturity → `400 VALIDATION_FAILED { location:'fnParams', field:'settlement' }`.
3. Pricing curve: `pts = await ctx.data.curves.points(params.curveId, valuationDate)` (served date ≤ valuationDate; when `pts.curveDate < valuationDate` the cells cite it and `st` becomes `'stale'` only if older than 5 business days), `build = await ctx.data.curves.build(params.curveId, pts.curveDate, params.interpolation)` (one `curve_builds` probe; a miss bootstraps and inserts). `provIdx_curve = ctx.prov.add({ sourceId: pts.sourceId, provenanceId: pts.points[0].provenanceId, capturedAt, sourceTs, st:'closed', tier:'eod' })`; `ctx.engines.add(build.engine)`.
4. **Coupon securities** (`note`/`bond`): `schedule = bondCashflows({ datedDate, firstCouponDate, maturityDate, couponRate, freq:2, dayCount:'ACT/ACT', bdc:'following', calendar: cal, settlement })`. Input yield: `input='curve'` → `yieldPct = curveInterp.parYield(pts, daysToMaturity)` (linear in `tenorDays` on `par_yield`/`cmt_yield` points; `SOFR_OIS` → `build.curve.parRate(T)` semiannual-equivalent) with `source:'curve'`; `input='yield'` → `params.yield`; `input='price'` → `yieldPct = bondPrice.yieldFromPrice(...)` (Newton from the curve yield, tolerance 1e-10 on price). Then `bondPrice.priceFromYield` (clean, dirty, accrued, accruedDays, daysInPeriod), `bondRisk.duration/convexity/dv01` on `face`, `bondRisk.yieldValueOf32nd`. Spread: `toCurveBp = (yieldPct − interpolatedCurveYieldPct) × 100`; `zSpreadBp = bondRisk.zSpread(schedule, dirtyPrice, build.curve)` (Brent on ±2000 bp, tolerance 1e-9); `keyRateDurations = bondRisk.keyRateDurations(schedule, build.curve, zSpreadBp, params.krdTenors)` (§0 kernel). Benchmark: the `govt_terms` row with `on_the_run=true` whose `term_label` is the nearest tenor ≥ years to maturity (2Y…30Y); its yield is the curve par yield at that tenor (no bond price source), `spreadBp = (yieldPct − benchmarkYieldPct) × 100`; benchmark = `null` for bills and when the security *is* the benchmark. Cashflows: each `df = build.curve.dfAtSpread(t, zSpreadBp)`, `pv = total × df`.
5. **Bills**: `t = days(settlement, maturityDate)`; input: `'curve'` → `discountRatePct` = the `UST_BILL` `discount_rate` point whose `instrumentId` equals this bill, else linear interpolation in `tenorDays` (`ctx.unavailable.add({ field:'inputs.discount', reason:'NO_SOURCE', detail:'bill not on the Treasury bill curve for <date>; discount rate interpolated' })`); `'discount'` → `params.discount`; `'price'` → `bill.discountFromPrice`; `'yield'` → `bill.discountFromBey`. Then `bill.priceFromDiscount`, `bill.beyFromDiscount` (§0 formula, `beyFormula` set by `t`), `bill.moneyMarketYield = 360 × d / (360 − d × t)`, `dollarDiscount = face × d × t / 360`, `modifiedDuration = t/365 / (1 + bey/100 × t/365)`, `dv01 = modDur × price/100 × face × 0.0001`. Spread `toCurveBp` = BEY − interpolated `UST_PAR` par yield at `t`. Cashflows = one `maturity` row (`principal = face`).
6. Every `results` cell: `{ v, st: pts.st /* 'closed' */, provIdx: provIdx_curve for curve-derived, provIdx_terms for terms-derived, ts: null }`; user-supplied inputs cite `provIdx_terms` (they are not provider values) and carry `st:'closed'`.
7. Return `{ variant:'govt', … }`; `meta.engines` holds the engine notes registered in 3–5 (`bond/price`, `bond/risk`, `bond/cashflows` or `bill`, plus `curve/bootstrap`).
Budget: 3 DB round-trips (instrument+terms, curve points, calendar; `curve_builds` hit is the 4th only on a cache miss); pure compute < 5 ms; p95 < 120 ms warm.

#### Live
`{ subjects: ['c:' + params.curveId], fields: '*', conflationMs: 1000 }`. No cell has `Cell.live`; the shell shows the `CURVE_UPDATED` badge when a `c:` delta's `BUILD_ID` differs from `payload.curve.buildId`; `Enter` re-runs with `launchKind:'param'` (`details.changed:['curve']`).

#### Screen
```
┌ YAS · T 4.25 08/15/36 Govt · US Treasury Note 4.25% 15-Aug-2036 ───────────────────────────────┐
│ split(row, [0.34, 0.66])                                                                        │
│ ┌ form#inputs ──────────────┐ ┌ kv#results (columns 2) ───────────────────────────────────────┐ │
│ │ Mode      [curve|yield|   │ │ Yield (street)  4.9700 %   Clean price     94.4123           │ │
│ │            price|discount]│ │ Dirty price     94.7681    Accrued (31d)   0.3559            │ │
│ │ Yield %   4.9700          │ │ Mod duration    7.812      Macaulay        8.006             │ │
│ │ Price     94.4123         │ │ Convexity       74.31      DV01 (1mm)      740.35            │ │
│ │ Settlement 2026-09-16 (T+1│ │ DV01 /100       0.07404    Yld val 1/32    0.42 bp           │ │
│ │ Face      1,000,000       │ │ Spread to UST_PAR  +0.0 bp  Z-spread   +1.3 bp              │ │
│ │ Curve     UST_PAR 09-14   │ │ Benchmark 10Y 4.97 %   +0.0 bp                              │ │
│ └───────────────────────────┘ │ KRD  2Y 0.02 | 5Y 0.41 | 10Y 7.35 | 30Y 0.00  (table#krd)   │ │
│ kv#terms  CUSIP · type · coupon · freq · day count · dated · maturity · first cpn · settle days │
│ tabs#view  [1 Analysis] [2 Cashflows → grid#cashflows date|kind|days|coupon|principal|total|df|pv]│
│ footer: sources ['U.S. Treasury par yield curve (public domain)', 'fixtures/seed/treasuries.json (curated)'] asOf │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```
Title `YAS · <key> · <name>`; subtitle `settlement 2026-09-16 · curve UST_PAR 2026-09-14 · monotone_convex`. Bill layout replaces `kv#results` rows with `Discount %`, `Investment yield (BEY) %`, `Price`, `Money-market yield %`, `Dollar discount`, `Days to maturity`, `Mod duration`, `DV01` and hides `table#krd`. `initialFocus:'inputs'`. Skeleton: the form with the security's terms filled and results rendered as muted `—`. `meta.unavailable` rows render the affected cell as `—` with the `detail` as tooltip and an amber badge in `badges#notes`; `meta.entitlement` denials (`NO_FIRM_ENTITLEMENT` on `treasury.yieldcurve`) blank the curve-derived cells with the reason (ENTL-05). TIPS/FRN: the results block is replaced by `text#na` "YAS does not price TIPS/FRNs in v1" (tone `warn`).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | form | `reprice` | submit the form → `ctx.setParams({ input, yield, price, discount, settlement, face })` |
| `ArrowUp` / `ArrowDown` | form (yield field) | `bump-yield` | ±1 bp on `yield`; on the price field ±1/32; on the discount field ±1 bp — form-local until `Enter` |
| `Shift+ArrowUp` / `Shift+ArrowDown` | form | `bump-yield-10` | ×10 of the above |
| `M` | always | `cycle-mode` | `input` → next of `curve, yield, price` (`curve, discount, price` for bills) |
| `S` | always | `settlement-prompt` | `ctx.prompt('date', { label:'Settlement', initial })` → `setParams({ settlement })` |
| `C` | always | `cycle-curve` | `curveId` → next of `UST_PAR, UST_CMT, SOFR_OIS` |
| `I` | always | `cycle-interp` | `interpolation` cycle |
| `1` / `2` | always | `tab-analysis` / `tab-cashflows` | `setParams({ view })` (tabs; §2.6 rule 5) |
| `D` | always | `open-des` | `ctx.navigate('DES')` |
| `G` | always | `open-gc` | `ctx.navigate('GC ' + params.curveId)` |
| `Shift+Enter` | grid (cashflows) | `open-crvf-next` | `ctx.navigateNext('CRVF ' + params.curveId + ' ' + payload.curve.date)` |

#### CSV
`filename = 'YAS_' + key.replace(/[^A-Za-z0-9]+/g,'_') + '_' + asOf.replace(/[-:]/g,'') + '.csv'`. Long format (FUNCTIONS.md §1.6 rule 3, results dominate): columns `section,key,value,unit,asOf,source`; rows: one per `results` field (`section='results'`, unit `pct | px | years | ccy | bp`), one per KRD (`section='krd'`, key = tenor), one per terms field (`section='terms'`), one per input (`section='inputs'`), then one per cashflow (`section='cashflow'`, `key = date`, `value = total`, `unit = 'ccy'`, and three further rows `df`, `pv`, `coupon` keyed `date/df` …). Example row: `results,modifiedDuration,7.812,years,2026-09-15T18:41:28Z,internal.derived`.

#### Help
summary `Price/yield, accrued, duration, DV01, KRDs and spreads for a Treasury`; description `YAS prices a US Treasury bill, note or bond on the street convention (ACT/ACT, semiannual, T+1 SIFMA settlement) or the bill discount basis (ACT/360). With no input the yield is taken from the Treasury par curve at the security's maturity; type a yield, a price or a discount rate to override it. Spread and Z-spread are measured against the selected curve; key-rate durations bump the zero curve at 2, 5, 10 and 30 years. Every number is produced by a versioned engine listed in the footer, and the same engine serves the API and the CSV export.`; params `input` ("curve, yield, price or discount", `yield`), `yield` ("street yield, percent", `4.95`), `price` ("clean price per 100", `99.5`), `discount` ("bill discount rate, percent", `3.69`), `settlement` ("settlement date; default T+1 SIFMA", `2026-09-17`), `face` ("face amount for DV01 and cashflows", `5000000`), `curveId` ("UST_PAR, UST_CMT or SOFR_OIS"), `interpolation` ("zero-curve interpolation"), `krdTenors` ("key-rate tenors"), `view` ("analysis or cashflows"); sources `['treasury.yieldcurve', 'treasury.bills', 'internal.derived', 'internal.user']`; related `['DES', 'GC', 'CRVF', 'SRCH', 'SWPM']`.

#### Unavailable and reason codes
| Case | `meta.unavailable` / footer |
| --- | --- |
| TIPS or FRN | `{ field:'results', reason:'NOT_APPLICABLE', detail:'YAS v1 prices fixed-coupon notes/bonds and bills; TIPS/FRN pricing needs an inflation/reference-rate engine' }`; results block replaced by `text#na` |
| Bill not on the bill curve | `{ field:'inputs.discount', reason:'NO_SOURCE', detail:'bill not on the Treasury bill curve for <date>; discount rate interpolated' }` |
| No curve stored on or before the valuation date | `503 PROVIDER_UNAVAILABLE` is **not** raised; `{ field:'curve', reason:'NO_SOURCE', detail:'no UST_PAR curve on or before 2026-09-15' }` and every curve-derived cell `{ v:null, st:'blank', r:'PROVIDER_DOWN' }`; user-input mode still prices (yield/price/accrued/duration) |
| Curve older than 5 business days | cells `st:'stale'`, `meta.staleness:'stale'`, footer `CURVE_DATE <date>` (TERM-12) |
| No benchmark on-the-run row | `spreads.benchmark = null`, footer note `NO_BENCHMARK_ROW` |
| Entitlement | `meta.entitlement[]` per denied field (`NO_FIRM_ENTITLEMENT`, `TIER_EOD` never applies — every source here is `eod`) |
| Analytics engine failure (no convergence) | `500 INTERNAL` with `details.engine`; never a partial number |

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared) |
| golden payload | `packages/server/test/integration/functions/YAS.golden.test.ts` | `T 4.25 08/15/36 Govt` at the frozen clock equals `YAS.govt.json`; `912797VE4 Govt` equals the `results.kind:'bill'` case embedded in the same golden file's `bill` sibling `YAS.govt.bill.json`; `meta.engines` names and `inputsHash` stable across two runs |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `YAS.govt.csv`; every numeric cell equals the payload value |
| parity | `packages/server/test/parity/fn-parity.test.ts` | shared (API-05) |
| screen | `packages/web/test/screens/YAS.test.tsx` | coupon and bill layouts; `ArrowUp` bumps 1 bp locally; `Enter` calls `setParams`; `1`/`2` switch tabs; skeleton; `NOT_APPLICABLE` text branch |
| price↔yield round trip | `packages/core/test/analytics/bond.price.test.ts` | `yieldFromPrice(priceFromYield(y)) = y` within 1e-9 for 200 random (coupon, maturity, settlement) triples; Hull/Fabozzi worked examples in `fixtures/golden/analytics/bond/*.json` (ANAL-09) |
| bill formulas | `packages/core/test/analytics/bill.test.ts` | `912797VE4` d 3.69 / t 13 → price 99.866750, BEY per the ≤ 182-day formula; a 52-week bill uses the quadratic branch |
| KRD sum | `packages/core/test/analytics/bond.risk.test.ts` | `Σ KRD` within 2 % of modified duration for every seed note/bond; z-spread of a bond priced off the curve is 0 ± 0.01 bp |
| PIT terms | `packages/server/test/integration/functions/YAS.pit.test.ts` | after `upsertVersion` changes the 10Y coupon, `knownAt` before the change reprices with the old coupon (REF-03) |
| not applicable | `packages/server/test/unit/functions/runner.test.ts` (shared case) | `YAS` on `AAPL US Equity` → `422 FUNCTION_NOT_APPLICABLE` |
| e2e | `packages/e2e/tests/rates.spec.ts` | `T 4.25 08/15/36 Govt YAS <GO>`, `4.95 <Enter>` re-prices, PRINT yields a CSV whose `modifiedDuration` equals the screen value |

---

### CRVF — Curve Construction

| Attribute | Value |
| --- | --- |
| Code / aliases | `CRVF` / `ICVS` (`aliasParams { ICVS: { curveId:'SOFR_OIS' } }`), `CURVE`, `OIS` (`aliasParams { OIS: { curveId:'SOFR_OIS' } }`) |
| Tier / category | 3 / rates |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `custom` (`CurveChart`) |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/CRVF.ts` · `packages/server/src/functions/CRVF/resolve.ts` · `packages/web/src/screens/CRVF/Screen.tsx` · `fixtures/golden/functions/CRVF.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-03) (FUNC-04) (ANAL-02) (ANAL-08) (ANAL-09) (DATA-07) (DATA-10) (REF-06) (TERM-06) (TERM-12) (ENTL-05) (QA-01) (CHRT-01) |

#### Params
```ts
export const CrvfParams = z.object({
  curveId: z.enum(['UST_PAR', 'UST_BILL', 'UST_CMT', 'SOFR_FIX', 'SOFR_OIS']).default('UST_PAR'),
  date: z.iso.date().nullable().default(null),                       // null = latest stored curve_date ≤ validAt
  compare: z.array(z.iso.date()).max(3).default([]),                 // dashed comparison curves
  interpolation: z.enum(['linear_zero', 'log_linear_df', 'monotone_convex']).nullable().default(null),   // null = curves.default_interpolation
  outputs: z.array(z.enum(['input', 'par', 'zero', 'df', 'fwd3m', 'fwd1y'])).min(1).default(['input', 'par', 'zero', 'df', 'fwd3m']),
  grid: z.enum(['inputs', 'monthly', 'quarterly']).default('inputs'),   // node grid of the table: input tenors, or a regular grid to 30Y
  view: z.enum(['both', 'chart', 'table']).default('both'),
});
```
#### Argument grammar
`positional [{ name:'curveId', type:'curve', optional:true }, { name:'date', type:'date', optional:true }]`, `keyed { CMP: { name:'compare', type:'date' } /* repeatable: CMP=… CMP=… appends */, INTERP: { name:'interpolation', type:'enum', values:[…] }, GRID: { name:'grid', type:'enum', values:['inputs','monthly','quarterly'] } }`, no `rest`.
Examples: `CRVF` → `{ curveId:'UST_PAR', date:null, … }` · `ICVS` → alias params `{ curveId:'SOFR_OIS' }` · `CRVF UST_PAR 2026-09-08 CMP=2026-09-01 INTERP=LOG` → `{ curveId:'UST_PAR', date:'2026-09-08', compare:['2026-09-01'], interpolation:'log_linear_df' }`.

#### Payload
```ts
export type CrvfPayload = {
  variant: 'default';
  curve: { id: string; name: string; currency: string; kind: CurvePoints['kind']; dayCount: string; compounding: string; sourceId: string; provIdx: number;
           date: string; requestedDate: string | null; availableDates: string[] /* ≤ 400, desc */ };
  build: { buildId: number; method: 'bills+par_bootstrap'|'ois_bootstrap'|'none'; interpolation: string; engine: { name: string; version: string; inputsHash: string } | null;
           caveats: Array<'PROXY_CURVE'|'NO_OIS_SWAP_QUOTES_SOURCE'|'FIXING_ONLY_NO_TERM_STRUCTURE'|'SINGLE_DATE_ONLY'> };
  inputs: Array<{ tenor: string; tenorDays: number; quoteType: string; value: ValueCell; instrument: { instrumentId: number; key: string } | null; maturityDate: string | null; proxy: boolean; proxyOf: string | null; provIdx: number }>;
  nodes: Array<{ tenor: string; t: number /* years */; days: number; par: number | null; zero: number | null; df: number | null; fwd3m: number | null; fwd1y: number | null; isInput: boolean }>;   // percent except df
  compare: Array<{ date: string; buildId: number | null; provIdx: number; nodes: Array<{ tenor: string; t: number; par: number | null; zero: number | null; df: number | null }> }>;
  changes: Array<{ tenor: string; vsCompare: Array<{ date: string; parBp: number | null; zeroBp: number | null }> }>;
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables | `curves`, `curve_points` (`is_latest`, vintages ≤ `knownAt`), `curve_builds`, `rate_fixings` (`SOFR`, `SOFRAI` — SOFR_OIS proxies), `govt_terms` (input instrument keys), `instruments` |
| Data services | `data.curves.points(curveId, date)`, `data.curves.build(curveId, date, interpolation)`, `data.rates.latest('SOFR')`, `data.rates.latest('SOFRAI')`, `data.reference.instrument` (input rows) |
| Read-through | None. (scheduler jobs `treasuryCurves.ts`, `fedRates.ts` — ARCHITECTURE §7.1 — keep the tables fresh; the resolver never waits ≈ 18 s on Treasury) |
| Engines | `curve/bootstrap@1.0.0`, `curve/interp@1.0.0` |
| Subjects (live) | `c:<curveId>` |
| Field ids | `default: [CRV_1M, CRV_2M, CRV_3M, CRV_6M, CRV_1Y, CRV_2Y, CRV_3Y, CRV_5Y, CRV_7Y, CRV_10Y, CRV_20Y, CRV_30Y, CURVE_PAR, CURVE_ZERO, CURVE_DF, CURVE_FWD_3M, RATE, RATE_AVG_30D, RATE_AVG_90D, RATE_AVG_180D]` |

The five stored curves and how each is built (`seed/curves.ts`, `treasuryCurves.ts`, `fedRates.ts`; ANAL-02):

| `curve_id` | Inputs (`curve_points.quote_type`) | Build method | Caveats |
| --- | --- | --- | --- |
| `UST_PAR` | `par_yield` 1M 1.5M 2M 3M 4M 6M 1Y 2Y 3Y 5Y 7Y 10Y 20Y 30Y from `BC_*` (`treasury-xml2`) | `bills+par_bootstrap`: tenors ≤ 1Y as simple ACT/360 money-market rates → `df = 1/(1 + r × days/360)`; 2Y–30Y semiannual par coupons bootstrapped with interpolation on `zero(t)` between nodes | none |
| `UST_BILL` | `discount_rate` and `investment_yield` 4WK 6WK 8WK 13WK 17WK 26WK 52WK (`ROUND_B1_CLOSE_*`, `ROUND_B1_YIELD_*`, with `CUSIP_*` → `instrument_id`, `MATURITY_DATE_*`) | `bills+par_bootstrap` restricted to bills: `df = 1 − d × days/360` | `SINGLE_DATE_ONLY` is not raised (nine dates stored) |
| `UST_CMT` | `cmt_yield` 1M 3M 6M 1Y 2Y 3Y 5Y 7Y 10Y 20Y 30Y (`fed-h15.csv` `RIFLGFC*`; `ND` rows skipped) | same as `UST_PAR` | none |
| `SOFR_FIX` | `fixing` `ON` (`nyfed-sofr` `percentRate`) | `none` (no term structure): nodes = the single point; `par/zero/df` null beyond ON | `FIXING_ONLY_NO_TERM_STRUCTURE` |
| `SOFR_OIS` | `ON` = SOFR fixing; `1M/3M/6M` = SOFRAI `average30day/90day/180day` (`proxy:true`, `proxyOf:'SOFRAI realised average'`); `1Y` = 52WK bill investment yield converted to ACT/360 simple (`proxy`); `2Y…30Y` = `UST_PAR` par yields minus the **Treasury–OIS basis assumption of 0 bp** (`proxy`, `proxyOf:'UST_PAR par yield'`) | `ois_bootstrap`: annual ACT/360 OIS par rates bootstrapped to `df`; realised averages treated as the term rate to that tenor | `PROXY_CURVE`, `NO_OIS_SWAP_QUOTES_SOURCE` (BRIEF §2: no OIS swap quotes or futures source) — rendered as a persistent amber badge on CRVF, SWPM, WIRP, FED |

#### Resolver
1. `pts = await ctx.data.curves.points(params.curveId, params.date ?? valuationDate)`; `params.date` given but no `curve_date ≤ date` → `422 VALIDATION_FAILED { field:'date', detail:'no <curveId> curve on or before <date>' }` (a typed date must exist); `null` → latest. `provIdx_curve = ctx.prov.add({ sourceId: pts.sourceId, provenanceId: pts.points[0].provenanceId, capturedAt, sourceTs, st:'closed', tier:'eod' })`. For `SOFR_OIS` also `ctx.prov.add` for the SOFR fixing, SOFRAI record and the UST_PAR/UST_BILL rows used (one idx per source).
2. `interpolation = params.interpolation ?? pts.defaultInterpolation`; `build = pts.kind === 'fixing' ? null : await ctx.data.curves.build(params.curveId, pts.curveDate, interpolation)`; `ctx.engines.add(build.engine)`.
3. `inputs[]` from `pts.points` (value cells `st:'closed'`, `provIdx`, `instrument` from `instrumentId` → `{ key }` via `data.reference.instrument` batched in one query); `proxy` flags from `build.inputs[].proxy`.
4. `nodes[]`: `grid='inputs'` → one node per input tenor; `'monthly'` → every month to 30Y (360 nodes); `'quarterly'` → 120 nodes. Per node `par = build.curve.parRate(t)` (semiannual for `UST_*`, annual ACT/360 for `SOFR_OIS`), `zero = build.curve.zero(t)`, `df = build.curve.df(t)`, `fwd3m = build.curve.fwd(t, t + 0.25)`, `fwd1y = build.curve.fwd(t, t + 1)` (null when `t + horizon` exceeds the last node).
5. `compare[]`: for each date in `params.compare` steps 1–2 and 4 (nodes restricted to `par, zero, df`); a date with no curve → `ctx.unavailable.add({ field:'compare.' + date, reason:'NO_SOURCE', detail:'no <curveId> curve on or before <date>' })` and the entry is omitted. `changes[]` = per tenor `(current − compare) × 100` bp for `par` and `zero`.
6. `build.caveats` per the table above; `curve.availableDates = pts.availableDates`.
Budget: 2 DB round-trips + 1 per compare date (+1 per `curve_builds` miss); p95 < 150 ms.

#### Live
`{ subjects: ['c:' + params.curveId], fields: '*', conflationMs: 1000 }`. The screen compares the delta's `BUILD_ID` with `payload.build.buildId` and shows `CURVE_UPDATED`; the chart is **not** mutated in place (a curve is a daily object); `Enter` re-runs (`fn.param`, `changed:['curve']`).

#### Screen
```
┌ CRVF · UST_PAR · U.S. Treasury par yield curve · 2026-09-14 ────────────────────────────────────┐
│ badges#caveats  [PROXY_CURVE] [NO_OIS_SWAP_QUOTES_SOURCE]   (SOFR_OIS only)   [CURVE_UPDATED]    │
│ split(col, [0.55, 0.45])                                                                         │
│ custom#chart  CurveChart  — ChartSpec below                                                      │
│ grid#nodes  tenor | days | input (quoteType) | par % | zero % | df | fwd3m % | fwd1y % | proxy   │
│             (+ one column per compare date: 'par 09-01' with bp change)                           │
│ kv#build  method · interpolation · engine name@version · inputsHash[0..8] · buildId · sources     │
│ footer: sources [attribution of curve.sourceId, + 'NY Fed SOFR' for SOFR_OIS] asOf curve.date    │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```
`ChartSpec`: `{ kind:'curve', xAxis:{ type:'tenor' }, yAxes:[{ id:'y', side:'left', scale:'linear', fmt:'pct', decimals:3 }, { id:'df', side:'right', scale:'linear', fmt:'px', decimals:4 }], panes:[{ id:'main', height:1 }], series: [ par (line, yAxis 'y', x = days), zero (line, dashed), fwd3m (step), df (line, yAxis 'df', hidden unless 'df' ∈ outputs) ] + one dashed `par` series per compare date (style `neutral`), scatter series 'inputs' (x = tenorDays, y = input value, provIdx per point), crosshair:true, reference:[] }`. Series present = `params.outputs`. Title `CRVF · <id> · <name> · <date>` (`ICVS` alias shows `ICVS · SOFR_OIS …`); `initialFocus:'nodes'`; `view` controls `sizes` (`chart` → `[1,0]`, `table` → `[0,1]`). Skeleton: empty chart frame + 14 muted rows. Unavailable compare dates render as a `warn` badge with the detail; entitlement denials blank the `input` column and leave the derived columns (they are `internal.derived`) — the footer says so.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `D` | always | `date-prompt` | `ctx.prompt('date', { label:'Curve date' })` → `setParams({ date })` |
| `ArrowLeft` / `ArrowRight` | chart | `prev-date` / `next-date` | step through `curve.availableDates` → `setParams({ date })` |
| `C` | always | `add-compare` | `ctx.prompt('date')` → append to `compare` (max 3; 4th replaces the oldest) |
| `X` | always | `clear-compare` | `setParams({ compare: [] })` |
| `I` | always | `cycle-interp` | `linear_zero → log_linear_df → monotone_convex` |
| `O` | always | `cycle-outputs` | toggles the focused output column on/off (`par, zero, df, fwd3m, fwd1y`) |
| `R` | always | `cycle-grid` | `inputs → monthly → quarterly` |
| `V` | always | `cycle-view` | `both → chart → table` |
| `K` | always | `cycle-curve` | `UST_PAR → UST_BILL → UST_CMT → SOFR_FIX → SOFR_OIS` |
| `Enter` | grid | `row-provenance` | `ctx.provenance(row.provIdx)` for an input row; a derived row opens the build kv |
| `Shift+Enter` | grid | `open-yas-next` | when the row has `instrument`: `ctx.navigateNext(instrument.key + ' YAS')` |
| `G` | always | `open-gc` | `ctx.navigate('GC ' + curveId)` |
| `W` | always | `open-wirp` | `ctx.navigate('WIRP')` |

#### CSV
`filename = 'CRVF_' + curveId + '_' + curve.date.replace(/-/g,'') + '.csv'`; columns `date,tenor,days,t,quoteType,input,par,zero,df,fwd3m,fwd1y,proxy,source`; one row per `nodes[]` of the main date (`input`/`quoteType`/`proxy`/`source` filled for `isInput` rows, else empty), then one row per node of each `compare[]` date (`par, zero, df` only). Example: `2026-09-14,10Y,3652,10.005,par_yield,4.97,4.97,4.9931,0.61218,5.0402,5.1077,false,treasury.yieldcurve`.

#### Help
summary `Treasury par/bill/CMT and SOFR OIS curves: inputs, bootstrap, zero/df/forwards`; description `CRVF shows a stored curve for a date with its published inputs and the bootstrapped zero, discount-factor and forward nodes, and overlays up to three earlier dates with basis-point changes. ICVS opens the SOFR OIS curve, which in this build is constructed from proxies (SOFR fixing, realised SOFR averages, bills and Treasury par yields) because no OIS swap quotes are available; the PROXY_CURVE badge stays on every screen that uses it. Interpolation, the node grid and the output set are parameters; every build is cached by its inputs hash and reproducible.`; params `curveId` ("UST_PAR, UST_BILL, UST_CMT, SOFR_FIX, SOFR_OIS", `SOFR_OIS`), `date` ("curve date; default latest", `2026-09-08`), `compare` ("up to three dates to overlay"), `interpolation` ("linear_zero, log_linear_df, monotone_convex"), `outputs` ("columns/series to show"), `grid` ("inputs, monthly or quarterly nodes"), `view` ("both, chart, table"); sources `['treasury.yieldcurve', 'treasury.bills', 'fed.h15', 'nyfed.rates', 'internal.derived']`; related `['GC', 'YAS', 'SWPM', 'WIRP', 'BTMM']`.

#### Unavailable and reason codes
| Case | Behaviour |
| --- | --- |
| Compare date has no curve | `{ field:'compare.<date>', reason:'NO_SOURCE', detail:'no <curveId> curve on or before <date>' }`, entry omitted, warn badge |
| `SOFR_OIS` | caveats `PROXY_CURVE`, `NO_OIS_SWAP_QUOTES_SOURCE` always; `inputs[].proxy=true` rows shaded; badge text "SOFR OIS term points are proxied (SOFRAI averages, bills, UST par); no OIS swap or futures source (BRIEF §2)" |
| `SOFR_FIX` | caveat `FIXING_ONLY_NO_TERM_STRUCTURE`; `build.method='none'`, nodes beyond ON null |
| `ND` H.15 day requested | served date is the previous available one; `curve.requestedDate` ≠ `curve.date` shows an info badge |
| Latest curve older than 5 business days | input cells `st:'stale'`, `meta.staleness:'stale'` (TERM-12) |
| Entitlement | `NO_FIRM_ENTITLEMENT` on the input source blanks `inputs[].value` (`—`, reason tooltip); derived nodes remain (`internal.derived`), footer notes "inputs hidden" |

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2; `aliasParams.ICVS.curveId === 'SOFR_OIS'` |
| golden payload | `packages/server/test/integration/functions/CRVF.golden.test.ts` | `CRVF` (UST_PAR 2026-09-14) equals `CRVF.default.json`; `ICVS` equals `CRVF.default.sofr_ois.json` (same variant, second golden for the alias) including caveats |
| csv parity | `packages/core/test/functions/csv.test.ts` | equals `CRVF.default.csv` |
| parity | `packages/server/test/parity/fn-parity.test.ts` | shared; `c:UST_PAR` snapshot `RATES` string equals the payload `inputs[].value.v` |
| screen | `packages/web/test/screens/CRVF.test.tsx` | ChartSpec has one series per output; compare adds dashed series; `V` toggles sizes; `K` cycles; skeleton |
| bootstrap benchmark | `packages/core/test/analytics/curve.bootstrap.test.ts` | `fixtures/golden/analytics/curve/UST_PAR-2026-09-14.json`: repricing each input par bond off the built curve returns 100.000 ± 1e-6; `df` monotone decreasing; three interpolations agree at nodes (ANAL-09) |
| build cache | `packages/server/test/integration/curves.build.test.ts` | second `build()` call hits `curve_builds` (no engine call), same `inputsHash`; a changed input creates a new row (ANAL-08) |
| compare missing | `packages/server/test/integration/functions/CRVF.compare.test.ts` | `compare:['2020-01-01']` → `meta.unavailable` entry, payload still 200 |
| e2e | `packages/e2e/tests/rates.spec.ts` | `ICVS <GO>` shows the PROXY_CURVE badge; `CRVF UST_PAR CMP=2026-09-01` shows the change column |

---

### ICVS — Curve Comparison & Spreads

| Attribute | Value |
| --- | --- |
| Code / aliases | `ICVS` / none (`aliasParams` none) |
| Tier / category | 3 / rates |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `custom` (`CurveChart`) |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/ICVS.ts` · `packages/server/src/functions/ICVS/resolve.ts` · `packages/web/src/screens/ICVS/Screen.tsx` · `fixtures/golden/functions/ICVS.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (ANAL-02) (ANAL-08) (ANAL-09) (DATA-07) (DATA-10) (REF-06) (TERM-06) (TERM-11) (TERM-12) (ENTL-05) (QA-01) (CHRT-01) |

**Catalogue note (binding on review).** FUNCTIONS.md §6 (line 1099) currently registers `ICVS` as a *catalogue alias* of `CRVF` with `aliasParams { curveId:'SOFR_OIS' }`, and the `CRVF` entry in this file repeats that. This entry supersedes that: `ICVS` is its own manifest whose subject is the **comparison of two to four curve/date series and the spreads between them**, which `CRVF` cannot express (`CrvfParams.compare` overlays earlier dates of the *same* curve only and produces no spread, slope or butterfly numbers). Removing `ICVS` from `CrvfParams`' alias set and raising the catalogue count from 38 to 39 manifests is listed under "additions required". `CRVF` keeps `CURVE` and `OIS`; `CRVF SOFR_OIS` remains the way to *construct* the OIS curve, `ICVS UST_PAR SOFR_OIS` the way to *compare* it.

ICVS is polymorphic inside the single `default` variant on the **measure** (FUNC-02): `par` and `zero` compare yields and spread them in basis points; `df` compares discount factors and spreads them in unitless points ×10⁴ (the `spreadUnit` is forced to `bp` and labelled `df bp`); `fwd3m` compares the 3-month forward at each node. Every number comes from a `curve/interp@1.0.0` or `curve/bootstrap@1.0.0` engine call on a `CurveBuild` (§0.1); the resolver does no arithmetic of its own beyond the subtraction that defines a spread (ANAL-08).

#### Params
```ts
export const IcvsParams = z.object({
  curves: z.array(z.enum(['UST_PAR', 'UST_BILL', 'UST_CMT', 'SOFR_FIX', 'SOFR_OIS'])).min(1).max(4).default(['UST_PAR', 'SOFR_OIS']),
  dates: z.array(z.iso.date()).max(4).default([]),                    // [] = latest stored curve_date ≤ validAt for each curve
  base: z.number().int().min(0).max(3).default(0),                    // index into series[]; every spread is measured to this leg
  measure: z.enum(['par', 'zero', 'df', 'fwd3m']).default('par'),
  spreadUnit: z.enum(['bp', 'pct']).default('bp'),
  grid: z.enum(['common', 'inputs', 'monthly', 'quarterly']).default('common'),
  tenors: z.array(z.enum(['ON', '1M', '1.5M', '2M', '3M', '4M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '20Y', '30Y'])).max(15).default([]),   // [] = the grid; non-empty overrides `grid`
  currency: z.enum(['USD', 'EUR', 'GBP', 'JPY']).default('USD'),      // only USD curves exist (see Unavailable and reason codes)
  interpolation: z.enum(['linear_zero', 'log_linear_df', 'monotone_convex']).nullable().default(null),   // null = each curve's curves.default_interpolation
  view: z.enum(['both', 'chart', 'table']).default('both'),
});
```
#### Argument grammar
`positional [{ name:'curves', type:'curve', optional:true, repeat:true /* up to 4, comma- or space-separated */ }]`, `keyed { D: { name:'dates', type:'date' } /* repeatable: D=… D=… appends, max 4 */, BASE: { name:'base', type:'number' }, M: { name:'measure', type:'enum', values:['par','zero','df','fwd3m'] }, GRID: { name:'grid', type:'enum', values:['common','inputs','monthly','quarterly'] }, T: { name:'tenors', type:'enum', values:['ON','1M','1.5M','2M','3M','4M','6M','1Y','2Y','3Y','5Y','7Y','10Y','20Y','30Y'] } /* repeatable */, CCY: { name:'currency', type:'enum', values:['USD','EUR','GBP','JPY'] }, INTERP: { name:'interpolation', type:'enum', values:['linear_zero','log_linear_df','monotone_convex'] } }`, no `rest`.
Examples: `ICVS` → `{ curves:['UST_PAR','SOFR_OIS'], dates:[], base:0, measure:'par', grid:'common', … }` · `ICVS UST_PAR D=2026-09-14 D=2026-09-08 M=ZERO` → `{ curves:['UST_PAR'], dates:['2026-09-14','2026-09-08'], measure:'zero' }` (one curve × two dates = two series) · `ICVS UST_PAR,UST_CMT,SOFR_OIS BASE=1 T=2Y T=10Y` → `{ curves:['UST_PAR','UST_CMT','SOFR_OIS'], base:1, tenors:['2Y','10Y'] }`.

**Series construction rule (FUNC-02, deterministic and testable).** `dates` empty → one series per curve at its latest stored `curve_date ≤ validAt`. `dates` non-empty and `curves.length === 1` → one series per date. Both non-empty with more than one curve → the curves-major cross product `curves × dates`, truncated to the first 4 entries, and `ctx.unavailable.add({ field:'series', reason:'NOT_APPLICABLE', detail:'ICVS compares at most 4 curve/date series; <n> were requested and the last <n-4> were dropped' })`.

#### Payload
```ts
export type IcvsPayload = {
  variant: 'default';
  measure: 'par' | 'zero' | 'df' | 'fwd3m';
  spreadUnit: 'bp' | 'pct';
  currency: { requested: 'USD' | 'EUR' | 'GBP' | 'JPY'; served: 'USD'; available: readonly ['USD'] };
  grid: { kind: 'common' | 'inputs' | 'monthly' | 'quarterly' | 'explicit';
          tenors: Array<{ tenor: string; tenorDays: number; t: number /* years ACT/365F */ }> };
  series: Array<{
    idx: number; isBase: boolean;
    curveId: string; curveName: string; currency: string; kind: CurvePoints['kind'];
    dayCount: string; compounding: string; sourceId: string; provIdx: number;
    date: string; requestedDate: string | null; availableDates: string[];      // ≤ 400, desc
    buildId: number | null; method: 'bills+par_bootstrap' | 'ois_bootstrap' | 'none'; interpolation: string;
    engine: { name: string; version: string; inputsHash: string } | null;
    caveats: Array<'PROXY_CURVE' | 'NO_OIS_SWAP_QUOTES_SOURCE' | 'FIXING_ONLY_NO_TERM_STRUCTURE' | 'SINGLE_DATE_ONLY'>;
    values: Array<{ tenor: string; value: ValueCell; isInput: boolean; proxy: boolean; proxyOf: string | null }>;
  }>;
  spreads: Array<{ tenor: string; tenorDays: number; t: number; base: number | null;
                   legs: Array<{ idx: number; value: number | null; spread: ValueCell }> }>;   // spread = leg − base, in `spreadUnit`
  slopes: Array<{ idx: number; s2s10Bp: ValueCell; s5s30Bp: ValueCell; s3m10yBp: ValueCell; fly2s5s10sBp: ValueCell }>;   // fly = 2 × 5Y − 2Y − 10Y
  slopeSpreads: Array<{ idx: number; s2s10Bp: ValueCell; s5s30Bp: ValueCell; s3m10yBp: ValueCell; fly2s5s10sBp: ValueCell }>;   // each slope minus the base series' slope; empty for the base leg's own row
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `curves`, `curve_points` (`is_latest`, `vintage_at ≤ ctx.asOf.knownAt`, `curve_date ≤ validAt`), `curve_builds` (build cache), `rate_fixings` (`SOFR`, `SOFRAI` — the `SOFR_OIS` proxy inputs), `govt_terms` and `instruments` (input-row instrument keys for `Shift+Enter`) |
| Data services (§1.4.2) | `data.curves.points(curveId, date)`, `data.curves.build(curveId, date, interpolation)`, `data.rates.latest('SOFR')`, `data.rates.latest('SOFRAI')`, `data.reference.instrument` (batched for input rows) |
| Read-through (`providers.ensure`) | None. The scheduler jobs `treasuryCurves.ts` and `fedRates.ts` (ARCHITECTURE §7.1) keep `curve_points` fresh; ICVS never waits on the ≈ 18 s Treasury endpoint (BRIEF §2). |
| Engines (`core/analytics`) | `curve/bootstrap@1.0.0`, `curve/interp@1.0.0` |
| Subjects (live) | `c:<curveId>` for each **distinct** `curveId` in `series[]` (notification only, §0 `CURVE_UPDATED`) |
| Field ids (`fieldIds(assetClass)`) | `default: [CRV_1M, CRV_2M, CRV_3M, CRV_6M, CRV_1Y, CRV_2Y, CRV_3Y, CRV_5Y, CRV_7Y, CRV_10Y, CRV_20Y, CRV_30Y, CURVE_PAR, CURVE_ZERO, CURVE_DF, CURVE_FWD_3M]` — the entitlement pre-check set, evaluated once per distinct `sourceId` in `series[]` |

Providers behind the five curve ids are exactly those listed in the `CRVF` entry's build table: `treasury.yieldcurve` (`UST_PAR`), `treasury.bills` (`UST_BILL`), `fed.h15` (`UST_CMT`), `nyfed.rates` (`SOFR_FIX`, and the SOFR/SOFRAI proxy inputs of `SOFR_OIS`), `internal.derived` (every bootstrapped node). ICVS never redefines a build; it consumes `CurveBuild` rows produced by the same `curve/bootstrap@1.0.0` engine, so a node shown here is bit-identical to the same node on `CRVF` (API-05).

#### Resolver
1. `valuationDate` = ISO date of `ctx.asOf.validAt` in `America/New_York` (2026-09-15 at the frozen clock). `params.currency !== 'USD'` → `ctx.unavailable.add({ field:'currency', reason:'NO_SOURCE', detail:'no non-USD curve source is reachable keyless (BRIEF §2); ICVS serves USD curves only' })`, `currency.served = 'USD'`, and the resolve continues on the USD curves (no 4xx: the screen stays usable with an amber `NO_NON_USD_CURVE_SOURCE` badge — TERM-12 style degradation, never fabricated foreign points).
2. Build the series list per the construction rule above. For each series: `pts = await ctx.data.curves.points(curveId, date ?? valuationDate)`. A **typed** date with no `curve_date ≤ date` → the series is dropped with `ctx.unavailable.add({ field:'series.<curveId>.<date>', reason:'NO_SOURCE', detail:'no <curveId> curve on or before <date>' })` (unlike `CRVF`, ICVS does not raise `422`: the remaining legs are still a valid comparison). Every series dropped → `422 VALIDATION_FAILED { location:'fnParams', field:'curves' }`.
3. `provIdx = ctx.prov.add({ sourceId: pts.sourceId, provenanceId: pts.points[0].provenanceId, capturedAt: pts.points[0].capturedAt, sourceTs: pts.points[0].sourceTs, st:'closed', tier:'eod' })` per series; for a `SOFR_OIS` series also one `ctx.prov.add` each for the SOFR fixing, the SOFRAI record and the `UST_PAR`/`UST_BILL` rows it proxies (DATA-10).
4. `interpolation = params.interpolation ?? pts.defaultInterpolation`; `build = pts.kind === 'fixing' ? null : await ctx.data.curves.build(curveId, pts.curveDate, interpolation)` (one `curve_builds` probe per series; a miss bootstraps and inserts). `ctx.engines.add(build.engine)` for each non-null build.
5. Grid: `params.tenors` non-empty → `kind:'explicit'`, those tenors in ladder order. Else `grid='common'` → the standard comparison ladder `ON, 1M, 3M, 6M, 1Y, 2Y, 3Y, 5Y, 7Y, 10Y, 20Y, 30Y`; `'inputs'` → the published input tenors of the **base** series (`pts.points[].tenor`, ascending `tenorDays`); `'monthly'` → every month to 30Y (360 nodes); `'quarterly'` → 120 nodes. `tenorDays` from the ladder table (`ON`=1, `1M`=30, `3M`=91, `6M`=182, `1Y`=365, `2Y`=730, …, `30Y`=10957) and `t = tenorDays / 365`.
6. Per series × tenor, evaluate the measure through `curve/interp@1.0.0` on that series' own build: `par` → `build.curve.parRate(t)` (semiannual for `UST_*`, annual ACT/360 for `SOFR_OIS`), `zero` → `build.curve.zero(t)`, `df` → `build.curve.df(t)`, `fwd3m` → `build.curve.fwd(t, t + 0.25)`. `t` beyond the series' last node, or `build === null` (`SOFR_FIX`) beyond `ON` → `{ v:null, st:'na', r:'NOT_IN_UNIVERSE' }` and the caveat `FIXING_ONLY_NO_TERM_STRUCTURE`. `isInput` is true when the tenor equals a published `pts.points[].tenor`; `proxy`/`proxyOf` are copied from `build.inputs[]`.
7. `spreads[]`: for each grid tenor, `base = series[params.base].values[tenor].v`; for every other leg `spread.v = spreadUnit === 'bp' ? (leg − base) × 100 : leg − base`, except `measure='df'` where it is `(leg − base) × 10_000` and `spreadUnit` is forced to `'bp'`. Either side null → `{ v:null, st:'na', r:'NOT_IN_UNIVERSE' }`. Cells carry `provIdx` of the leg's series and `st` = the worse of the two legs' `st`.
8. `slopes[]` per series from the same evaluations: `s2s10Bp = (v10Y − v2Y) × 100`, `s5s30Bp = (v30Y − v5Y) × 100`, `s3m10yBp = (v10Y − v3M) × 100`, `fly2s5s10sBp = (2 × v5Y − v2Y − v10Y) × 100`; `slopeSpreads[]` = each minus the base series' value (the base row is emitted with all four cells `{ v:0, st:'closed' }` so the CSV is rectangular).
9. `meta.staleness`: the worst of the series. A served `curve_date` more than 5 business days before `valuationDate` (SIFMA) → that series' cells `st:'stale'` and footer `CURVE_DATE <date>` (TERM-12).
Budget: 1 `curves`/`curve_points` round-trip per series (max 4) + 1 `curve_builds` probe per series + 1 batched `data.reference.instrument` call = 9 DB round-trips worst case, 5 typical; pure compute < 8 ms for `grid='common'`, < 60 ms for `'monthly'` × 4 series; p95 < 180 ms warm.

#### Live
`{ subjects: [...new Set(payload.series.map(s => 'c:' + s.curveId))], fields: '*', conflationMs: 1000 }`. No cell has `Cell.live` — a curve is a daily object and is never mutated in place. The shell compares each `c:` delta's `BUILD_ID` with the `buildId` of every series on that curve and shows `CURVE_UPDATED` (blue) naming the affected leg; `Enter` on the badge re-runs with `launchKind:'param'` (`details.changed:['curve']`).

#### Screen
```
┌ ICVS · UST_PAR 2026-09-14 vs SOFR_OIS 2026-09-14 · par · USD ─────────────────────────────────────┐
│ badges#caveats [PROXY_CURVE] [NO_OIS_SWAP_QUOTES_SOURCE] [NO_NON_USD_CURVE_SOURCE] [CURVE_UPDATED] │
│ split(col, [0.52, 0.48])                                                                           │
│ custom#chart   CurveChart — ChartSpec below (upper pane: levels; lower pane: spread to base)        │
│ grid#matrix    tenor | days | [0] UST_PAR 09-14 % | [1] SOFR_OIS 09-14 % | spread 1-0 (bp)          │
│                (one level column + one spread column per non-base leg; base column marked ▸)        │
│ kv#slopes      2s10s · 5s30s · 3m10y · 2s5s10s fly — one column per series, spread row beneath      │
│ kv#builds      per series: curveId · date · method · interpolation · engine@version · hash[0..8]    │
│ footer: sources [attribution of every distinct series.sourceId + 'internal.derived'] asOf           │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
`ChartSpec` (§1.5, CHRT-01): `{ kind:'curve', xAxis:{ type:'tenor' }, yAxes:[{ id:'y', side:'left', scale:'linear', fmt: measure === 'df' ? 'px' : 'pct', decimals: measure === 'df' ? 5 : 3 }, { id:'s', side:'right', scale:'linear', fmt:'bp', decimals:1 }], panes:[{ id:'levels', height:0.68 }, { id:'spread', height:0.32 }], series: [ one 'line' series per `payload.series[]` on pane 'levels' / yAxis 'y' (x = tenorDays, base leg solid and `style:'primary'`, the others dashed with palette index = idx), one 'scatter' series per leg for its `isInput` points (provIdx per point, shaded when `proxy`), one 'step' series per non-base leg on pane 'spread' / yAxis 's' (x = tenorDays, y = `spreads[].legs[].spread.v`) ], crosshair:true, reference:[{ pane:'spread', y:0, style:'zero' }] }`.
Title `ICVS · <base curveId> <base date> vs <other legs> · <measure> · <currency.served>`; subtitle `grid <grid.kind> · interpolation <interpolation of the base series> · spreads in <spreadUnit>`. `initialFocus:'matrix'`. `view` drives `sizes`: `chart` → `[1, 0]`, `table` → `[0, 1]`, `both` → `[0.52, 0.48]`. Skeleton while `payload === undefined`: an empty chart frame plus 12 muted `grid#matrix` rows with the ladder tenors filled in. `meta.unavailable` rows render the affected cell as `—` with `detail` as the tooltip and an amber badge in `badges#caveats`; a dropped series appears in `badges#caveats` as `warn` text rather than a missing column. `meta.entitlement` denials (`NO_FIRM_ENTITLEMENT` on e.g. `treasury.yieldcurve`) blank that series' `isInput` cells and the whole level column when the denial covers `CURVE_PAR`, leaving the spread column `—` with the same reason (ENTL-05); the footer states which source was withheld.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `K` | always | `add-curve` | `ctx.prompt('enum', { label:'Curve', values:['UST_PAR','UST_BILL','UST_CMT','SOFR_FIX','SOFR_OIS'] })` → append to `curves` (max 4; a 5th replaces the last) |
| `X` | always | `drop-curve` | remove the focused column's series → `setParams({ curves, dates })` (never drops the last remaining series) |
| `D` | always | `date-prompt` | `ctx.prompt('date', { label:'Date for focused series' })` → replace that entry of `dates` |
| `ArrowLeft` / `ArrowRight` | chart | `prev-date` / `next-date` | step the focused series through its `availableDates` → `setParams({ dates })` |
| `B` | grid / chart | `set-base` | make the focused column the base → `setParams({ base: idx })`; spreads re-sign |
| `M` | always | `cycle-measure` | `par → zero → df → fwd3m` |
| `U` | always | `cycle-spread-unit` | `bp → pct` (no-op and a `warn` toast when `measure='df'`) |
| `R` | always | `cycle-grid` | `common → inputs → monthly → quarterly` |
| `I` | always | `cycle-interp` | `null → linear_zero → log_linear_df → monotone_convex` (null = each curve's default) |
| `V` | always | `cycle-view` | `both → chart → table` |
| `Enter` | grid | `row-provenance` | `ctx.provenance(cell.provIdx)` for the focused cell (an `isInput` cell cites the publisher; a derived cell cites `internal.derived` and opens `kv#builds`) |
| `Shift+Enter` | grid | `open-yas-next` | when the focused cell's tenor maps to a `curve_points.instrument_id`: `ctx.navigateNext(instrument.key + ' YAS')` |
| `C` | always | `open-crvf` | `ctx.navigate('CRVF ' + focusedSeries.curveId + ' ' + focusedSeries.date)` |
| `G` | always | `open-gc` | `ctx.navigate('GC ' + focusedSeries.curveId)` |
| `W` | always | `open-wirp` | `ctx.navigate('WIRP')` |

#### CSV
`filename = 'ICVS_' + series.map(s => s.curveId).join('-') + '_' + series[0].date.replace(/-/g,'') + '.csv'`. Long format (FUNCTIONS.md §1.6 rule 3: two blocks of different shape), columns `section,tenor,days,t,curveId,curveDate,measure,value,spread,unit,isBase,proxy,isInput,source`; rows: one per (`grid.tenors[]` × `series[]`) with `section='curve'` (`spread` empty on the base leg, otherwise `spreads[].legs[].spread.v`), then four rows per series with `section='slope'` (`tenor` = `2s10s | 5s30s | 3m10y | 2s5s10s`, `value` = the slope in bp, `spread` = the `slopeSpreads` value, `unit='bp'`, `days`/`t` empty). `unit` is `pct` for `par`/`zero`/`fwd3m` values, `df` for discount factors, `bp` for every spread and slope. Example row: `curve,10Y,3652,10.005,SOFR_OIS,2026-09-14,par,4.9100,-6.00,pct,false,true,false,internal.derived`.

#### Help
summary `Compare up to four curve/date series and the spreads, slopes and flies between them`; description `ICVS puts two to four curve/date series side by side on one grid of tenors and measures every leg against a chosen base. Pick the measure (par yield, zero rate, discount factor or 3-month forward), the tenor grid (the standard ladder, the base curve's published input tenors, or a monthly/quarterly grid to 30 years) and the base leg; the table and the lower chart pane show the spread in basis points, and the slope block gives 2s10s, 5s30s, 3m10y and the 2s5s10s butterfly for each leg plus their differences. Only USD curves exist in this build — no non-USD curve source is reachable without a licence — so a currency other than USD is reported unavailable rather than approximated. Curves are never rebuilt here: every node is read from the same cached bootstrap that CRVF and YAS use, so the numbers agree across screens.`; params `curves` ("one to four of UST_PAR, UST_BILL, UST_CMT, SOFR_FIX, SOFR_OIS", `UST_PAR,SOFR_OIS`), `dates` ("up to four curve dates; default latest per curve", `2026-09-08`), `base` ("index of the series spreads are measured to", `0`), `measure` ("par, zero, df or fwd3m"), `spreadUnit` ("bp or pct"), `grid` ("common, inputs, monthly or quarterly"), `tenors` ("explicit tenor list; overrides grid", `2Y,10Y`), `currency` ("USD only in this build"), `interpolation` ("zero-curve interpolation; default each curve's own"), `view` ("both, chart or table"); sources `['treasury.yieldcurve', 'treasury.bills', 'fed.h15', 'nyfed.rates', 'internal.derived']`; related `['CRVF', 'GC', 'YAS', 'SWPM', 'WIRP']`.

#### Unavailable and reason codes
| Case | `meta.unavailable` / footer |
| --- | --- |
| `currency` other than `USD` | `{ field:'currency', reason:'NO_SOURCE', detail:'no non-USD curve source is reachable keyless (BRIEF §2); ICVS serves USD curves only' }`; amber badge `NO_NON_USD_CURVE_SOURCE`; USD legs still render |
| A requested date has no curve for that curve id | `{ field:'series.<curveId>.<date>', reason:'NO_SOURCE', detail:'no <curveId> curve on or before <date>' }`; that series is dropped, warn badge, remaining legs render |
| Every series dropped | `422 VALIDATION_FAILED { location:'fnParams', field:'curves' }` — a comparison with no legs is a bad request, not a degraded screen |
| More than 4 curve/date combinations requested | `{ field:'series', reason:'NOT_APPLICABLE', detail:'ICVS compares at most 4 curve/date series; <n> were requested and the last <n-4> were dropped' }` |
| `SOFR_FIX` in the comparison | series caveat `FIXING_ONLY_NO_TERM_STRUCTURE`; every tenor beyond `ON` is `{ v:null, st:'na', r:'NOT_IN_UNIVERSE' }` and its spread column is `—` |
| `SOFR_OIS` in the comparison | series caveats `PROXY_CURVE` and `NO_OIS_SWAP_QUOTES_SOURCE` (persistent amber badges, wording per the `CRVF` entry); `proxy:true` value cells shaded |
| `grid='inputs'` with a tenor absent from a non-base series | that cell is interpolated by the leg's own `curve/interp`, `isInput:false`; no `meta.unavailable` entry (interpolation is the documented behaviour, flagged by the un-shaded cell) |
| Served `curve_date` > 5 SIFMA business days before the valuation date | that series' cells `st:'stale'`, `meta.staleness:'stale'`, footer `CURVE_DATE <date>` (TERM-12) |
| Entitlement | `meta.entitlement[]` per denied field (`NO_FIRM_ENTITLEMENT` on `treasury.yieldcurve` / `fed.h15` / `nyfed.rates`); denied level column and its spread column render `—` with the reason; `internal.derived` nodes of an entitled leg remain (ENTL-05) |
| `curve/interp` failure (non-monotone df after a bad bootstrap) | `500 INTERNAL` with `details.engine`; never a partial spread |

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared); `ICVS` is a canonical code and no longer appears in `CRVF.aliases`/`aliasParams` |
| resolver unit | `packages/server/test/unit/functions/ICVS.resolve.test.ts` | against the seeded fixtures: series construction rule for the three argument shapes; `base=1` re-signs every spread; `spreads[].legs[].spread.v === (leg − base) × 100` for `par`; `measure='df'` forces `spreadUnit='bp'` and scales ×10⁴ |
| golden payload | `packages/server/test/integration/functions/ICVS.golden.test.ts` | `ICVS` at the frozen clock (UST_PAR 2026-09-14 vs SOFR_OIS 2026-09-14) deep-equals `ICVS.default.json`; `ICVS UST_PAR D=2026-09-14 D=2026-09-08` equals `ICVS.default.dates.json`; `meta.engines` names and `inputsHash` stable across two runs (ANAL-08) |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `ICVS.default.csv`; every numeric cell equals the payload value; the `slope` block has exactly 4 rows per series |
| parity | `packages/server/test/parity/fn-parity.test.ts` | shared (API-05) |
| cross-screen agreement | `packages/server/test/parity/curve-parity.test.ts` | for every shared tenor, `ICVS.series[i].values[tenor].v` equals the `CRVF` payload node for the same `(curveId, date, interpolation)`, and the 10Y `par` equals the `YAS` `interpolatedCurveYieldPct` for `T 4.25 08/15/36 Govt` |
| slopes benchmark | `packages/core/test/analytics/curve.interp.test.ts` | 2s10s/5s30s/3m10y/fly recomputed from `fixtures/golden/analytics/curve/UST_PAR-2026-09-14.json` match the payload to 1e-9 bp (ANAL-09, QA-01) |
| screen | `packages/web/test/screens/ICVS.test.tsx` | renders both goldens; one level series and one spread series per leg in the `ChartSpec`; `B` calls `setParams({ base })`; `M`/`R`/`V` cycle; every keymap action reachable by keyboard; skeleton when `payload === undefined` |
| non-USD degraded | `packages/server/test/integration/functions/ICVS.currency.test.ts` | `CCY=EUR` → 200, `currency.served='USD'`, the `NO_SOURCE` entry above, `NO_NON_USD_CURVE_SOURCE` badge, no fabricated EUR points |
| missing date | `packages/server/test/integration/functions/ICVS.missing.test.ts` | `D=2020-01-01` drops that leg with `meta.unavailable` and still returns 200; all legs missing → `422` |
| e2e | `packages/e2e/tests/rates.spec.ts` | `ICVS UST_PAR SOFR_OIS <GO>` shows the spread column and the `PROXY_CURVE` badge; `B` flips the base and the spread signs invert on screen; PRINT yields a CSV whose 10Y spread equals the screen value |

---

### WIRP — Implied Policy Path

| Attribute | Value |
| --- | --- |
| Code / aliases | `WIRP` / `FFIP`, `PATH` |
| Tier / category | 3 / rates |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/WIRP.ts` · `packages/server/src/functions/WIRP/resolve.ts` · `packages/web/src/screens/WIRP/Screen.tsx` · `fixtures/golden/functions/WIRP.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-03) (FUNC-04) (ANAL-02) (ANAL-08) (ANAL-09) (DATA-07) (DATA-10) (REF-06) (TERM-06) (TERM-11) (TERM-12) (ENTL-05) (QA-01) |

**No futures source (BRIEF §2, binding).** CME FedWatch, fed-funds futures and their options are not reachable, so WIRP does **not** publish a market-implied probability *distribution*. It publishes (a) the FOMC-dated implied overnight path read off the money-market curve, which is a genuine market observable, and (b) a deterministic two-point allocation of each meeting's implied step onto the adjacent 25 bp target ranges — the same arithmetic FedWatch applies to a futures price, applied here to an OIS-implied rate. Both `NO_FUTURES_SOURCE` and `POINT_MASS_PROBABILITY_MODEL` are permanent amber badges, and the probability block is labelled "implied allocation, not an options-implied distribution" on screen and in the CSV header comment (API.md §9 `#` lines).

#### Params
```ts
export const WirpParams = z.object({
  curveId: z.enum(['SOFR_OIS', 'UST_BILL']).default('SOFR_OIS'),
  date: z.iso.date().nullable().default(null),                        // null = latest stored curve_date ≤ validAt
  reference: z.enum(['EFFR', 'SOFR']).default('EFFR'),                // the policy rate the path is expressed in
  basisBp: z.number().min(-100).max(100).nullable().default(null),    // null = derive reference − SOFR from rate_fixings
  meetings: z.number().int().min(1).max(8).default(8),                // how many undecided meetings to project
  stepBp: z.number().int().min(5).max(50).default(25),                // the assumed policy increment
  compare: z.iso.date().nullable().default(null),                     // an earlier curve date to show the path shift against
  view: z.enum(['path', 'probabilities']).default('path'),
});
```
#### Argument grammar
`positional [{ name:'curveId', type:'curve', optional:true, values:['SOFR_OIS','UST_BILL'] }, { name:'date', type:'date', optional:true }]`, `keyed { REF: { name:'reference', type:'enum', values:['EFFR','SOFR'] }, BASIS: { name:'basisBp', type:'number' }, N: { name:'meetings', type:'number' }, STEP: { name:'stepBp', type:'number' }, CMP: { name:'compare', type:'date' }, V: { name:'view', type:'enum', values:['path','probabilities'] } }`, no `rest`.
Examples: `WIRP` → `{ curveId:'SOFR_OIS', date:null, reference:'EFFR', basisBp:null, meetings:8, stepBp:25, compare:null, view:'path' }` · `WIRP UST_BILL REF=SOFR` → `{ curveId:'UST_BILL', reference:'SOFR' }` · `WIRP 2026-09-14 CMP=2026-09-08 V=PROBABILITIES` → `{ date:'2026-09-14', compare:'2026-09-08', view:'probabilities' }`.

#### Payload
```ts
export type WirpPayload = {
  variant: 'default';
  asOfDate: string;                                                   // valuation date, America/New_York
  current: { rateCode: 'EFFR' | 'SOFR'; effectiveDate: string; rate: ValueCell;
             targetFrom: ValueCell; targetTo: ValueCell; targetMid: ValueCell; provIdx: number };
  basis: { appliedBp: ValueCell; source: 'derived' | 'user' | 'zero'; observations: number;
           window: { from: string; to: string } | null; formula: 'mean(EFFR − SOFR) over stored fixings' };
  curve: { id: 'SOFR_OIS' | 'UST_BILL'; date: string; requestedDate: string | null; buildId: number | null;
           method: 'bills+par_bootstrap' | 'ois_bootstrap'; interpolation: string; sourceId: string; provIdx: number;
           caveats: Array<'PROXY_CURVE' | 'NO_OIS_SWAP_QUOTES_SOURCE'> };
  meetings: Array<{
    meetingDate: string; statementAt: string | null; hasSep: boolean; isPast: boolean;
    daysAhead: number; t: number;                                     // years ACT/365F from asOfDate to meetingDate
    impliedOvernightPct: ValueCell;                                   // the curve forward over the inter-meeting period
    impliedReferencePct: ValueCell;                                   // impliedOvernightPct + basis.appliedBp/100
    cumChangeBp: ValueCell;                                           // impliedReferencePct − current.targetMid, in bp
    stepChangeBp: ValueCell;                                          // cumChangeBp − previous meeting's cumChangeBp
    impliedMoves: ValueCell;                                          // cumChangeBp / stepBp
    outcomes: Array<{ moves: number; bp: number; rangeFrom: number; rangeTo: number; probPct: ValueCell }>;
    vsCompare: { date: string; cumChangeBp: number | null; deltaBp: number | null } | null;
    decisionBp: number | null;                                        // fomc_meetings.decision_bp, non-null only when isPast
    provIdx: number;
  }>;
  terminal: { meetingDate: string | null; ratePct: ValueCell; cumChangeBp: ValueCell };
  model: { engine: { name: 'wirp/policyPath'; version: string; inputsHash: string };
           stepBp: number; probabilityModel: 'two_point_interpolation';
           caveats: Array<'NO_FUTURES_SOURCE' | 'POINT_MASS_PROBABILITY_MODEL' | 'PROXY_CURVE' | 'NO_OIS_SWAP_QUOTES_SOURCE' | 'FOMC_CALENDAR_HORIZON'> };
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `fomc_meetings` (`meeting_date`, `statement_at`, `has_sep`, `decision_bp`, `provenance_id`), `rate_fixings` (`EFFR` for `rate`/`target_from`/`target_to`, `SOFR` for the basis and the `SOFR` reference, `is_latest`, vintages ≤ `knownAt`), `curves`, `curve_points` (`is_latest`, `curve_date ≤ validAt`), `curve_builds`, `calendars` + `calendar_holidays` (`SIFMA`, for the business-day count behind the basis window) |
| Data services (§1.4.2) | `data.econ.fomc()`, `data.rates.latest('EFFR')`, `data.rates.latest('SOFR')`, `data.rates.history('EFFR', 30)`, `data.rates.history('SOFR', 30)`, `data.curves.points(curveId, date)`, `data.curves.build(curveId, date, interpolation)`, `data.reference.calendar('SIFMA')` |
| Read-through (`providers.ensure`) | None. `fedRates.ts` and `treasuryCurves.ts` (ARCHITECTURE §7.1) keep `rate_fixings` and `curve_points` fresh; the FOMC calendar is seeded from `fixtures/seed/fomc-2026.json` (§0) and refreshed by the `fed.fomc` scheduler job. |
| Engines (`core/analytics`) | `wirp/policyPath@1.0.0`, `curve/bootstrap@1.0.0`, `curve/interp@1.0.0` |
| Subjects (live) | `c:<curveId>`, `q:<instrumentId of the EFFR rate instrument>` (and `q:<SOFR>` when `reference='SOFR'`) |
| Field ids (`fieldIds(assetClass)`) | `default: [RATE, TARGET_FROM, TARGET_TO, RATE_VOLUME_BN, RATE_AVG_30D, CRV_1M, CRV_3M, CRV_6M, CRV_1Y, CRV_2Y, CURVE_ZERO, CURVE_DF, CURVE_FWD_3M]` |

Providers: `nyfed.rates` (EFFR/SOFR fixings and the target range), `internal.derived` (`SOFR_OIS` build and every implied number), `treasury.bills` (when `curveId='UST_BILL'`), plus the `SOFR_OIS` proxy chain `treasury.yieldcurve`/`treasury.bills`/`nyfed.rates` described in the `CRVF` entry. `fed.fomc` is the `econ_releases.source_id` behind the meeting calendar.

#### Resolver
1. `valuationDate` = ISO date of `ctx.asOf.validAt` in `America/New_York` (2026-09-15). `cal = await ctx.data.reference.calendar('SIFMA')` (REF-06).
2. `effr = await ctx.data.rates.latest('EFFR')`; `sofr = await ctx.data.rates.latest('SOFR')`. `current` = the fixing for `params.reference` (`rate`, `targetFrom = effr.targetFrom`, `targetTo = effr.targetTo`, `targetMid = (targetFrom + targetTo) / 2`; the target range always comes from the EFFR record because `rate_fixings.target_from/to` is EFFR-only). `provIdx_rate = ctx.prov.add({ sourceId:'nyfed.rates', provenanceId: fixing.provenanceId, capturedAt, sourceTs, st:'closed', tier:'eod' })`. No EFFR fixing at all → `{ field:'current.targetMid', reason:'NO_SOURCE', detail:'no EFFR target range stored on or before <date>' }` and every derived cell `{ v:null, st:'blank', r:'PROVIDER_DOWN' }` (TERM-12); the screen still shows the meeting calendar.
3. Basis: `params.basisBp` given → `{ appliedBp: params.basisBp, source:'user', observations:0, window:null }`. Otherwise `hE = await ctx.data.rates.history('EFFR', 30)`, `hS = await ctx.data.rates.history('SOFR', 30)`, paired on `effectiveDate`; `appliedBp = mean(EFFR − SOFR) × 100` over the paired days, `source:'derived'`, `observations = pairs.length`, `window = { from: earliest, to: latest }`. Fewer than 3 pairs → `appliedBp = 0`, `source:'zero'`, `ctx.unavailable.add({ field:'basis.appliedBp', reason:'NO_SOURCE', detail:'fewer than 3 paired EFFR/SOFR fixings stored; basis set to 0 bp' })`. At the frozen clock 5 pairs (2026-09-08 … 2026-09-14) give `appliedBp = 1.00`. `reference='SOFR'` → `appliedBp = 0`, `source:'zero'` (the curve is already a SOFR curve; no note is emitted).
4. Curve: `pts = await ctx.data.curves.points(params.curveId, params.date ?? valuationDate)`; a typed `date` with no curve on or before it → `422 VALIDATION_FAILED { location:'fnParams', field:'date' }`. `build = await ctx.data.curves.build(params.curveId, pts.curveDate, pts.defaultInterpolation)`; `ctx.engines.add(build.engine)`; `provIdx_curve = ctx.prov.add(...)`; `curve.caveats = params.curveId === 'SOFR_OIS' ? ['PROXY_CURVE','NO_OIS_SWAP_QUOTES_SOURCE'] : []`.
5. Meetings: `all = await ctx.data.econ.fomc()`. `future = all.filter(m => m.meetingDate >= valuationDate).slice(0, params.meetings)`; `past = all.filter(m => m.meetingDate < valuationDate)` are carried with `isPast:true`, `decisionBp` filled and every implied cell `{ v:null, st:'na', r:'NOT_IN_UNIVERSE' }` (history, not a forecast). `future.length < params.meetings` → `ctx.unavailable.add({ field:'meetings', reason:'NO_SOURCE', detail:'fomc_meetings holds <n> undecided meetings; the FOMC has not published the <yyyy+1> calendar' })` and `model.caveats` gains `FOMC_CALENDAR_HORIZON`. At the frozen clock `future` = `2026-09-16` (SEP), `2026-10-28`, `2026-12-09` (SEP) — three of the requested eight.
6. Path (`wirp/policyPath@1.0.0`, one `defineEngine` call whose inputs are the meeting dates, the curve snapshot, `targetMid`, `appliedBp` and `stepBp`, so `inputsHash` covers the whole model — ANAL-08). Per future meeting `i`, with `t_i` = ACT/365F years from `valuationDate` to `meetingDate_i` and `t_{i+1}` the next meeting (or `t_i + 0.25` for the last one): `impliedOvernightPct = build.curve.fwd(t_i, t_{i+1})` (simple ACT/360 forward, §0); `impliedReferencePct = impliedOvernightPct + appliedBp / 100`; `cumChangeBp = (impliedReferencePct − targetMid) × 100`; `stepChangeBp = cumChangeBp − cumChangeBp_{i-1}` (0-indexed: the first meeting's previous value is 0); `impliedMoves = cumChangeBp / stepBp`.
7. Outcomes (`probabilityModel:'two_point_interpolation'`): let `x = cumChangeBp / stepBp`, `L = Math.floor(x)`, `U = L + 1`, `pU = x − L`, `pL = 1 − pU`. `outcomes` = the two rows `{ moves: L, bp: L × stepBp, rangeFrom: targetFrom + L × stepBp/100, rangeTo: targetTo + L × stepBp/100, probPct: pL × 100 }` and the same for `U`, ordered by `moves` descending, with a row dropped when its `probPct` rounds to 0.00. `Σ probPct = 100` exactly (asserted in tests). Every cell carries `provIdx_curve` and `st:'closed'`.
8. `compare`: when set, repeat 4 and 6 for that date and fill `vsCompare = { date, cumChangeBp, deltaBp: cumChangeBp_now − cumChangeBp_then }`; no curve on or before it → `ctx.unavailable.add({ field:'compare', reason:'NO_SOURCE', detail:'no <curveId> curve on or before <date>' })` and `vsCompare = null` on every meeting.
9. `terminal` = the last future meeting's `impliedReferencePct` and `cumChangeBp` (both `{ v:null, st:'na' }` when `future` is empty). `model.caveats` always contains `NO_FUTURES_SOURCE` and `POINT_MASS_PROBABILITY_MODEL`, plus the curve caveats and `FOMC_CALENDAR_HORIZON` when raised.
Budget: 5 DB round-trips (fomc, two `rates.latest`, two `rates.history` batched into one query per code, curve points) + 1 `curve_builds` probe (+1 for `compare`); pure compute < 3 ms; p95 < 140 ms warm.

#### Live
`{ subjects: ['c:' + params.curveId, 'q:' + currentRateInstrumentId], fields: ['RATE', 'TARGET_FROM', 'TARGET_TO'], conflationMs: 1000, essential: false }`. `current.rate`, `current.targetFrom` and `current.targetTo` carry `Cell.live = { subject:'q:<id>', field:'RATE' | 'TARGET_FROM' | 'TARGET_TO' }` and flash on a new fixing; the implied path is **not** recomputed in the browser — a `c:` delta whose `BUILD_ID` differs from `payload.curve.buildId`, or a `TARGET_FROM`/`TARGET_TO` change, raises the `CURVE_UPDATED` badge and `Enter` re-runs (`launchKind:'param'`, `details.changed:['curve']`).

#### Screen
```
┌ WIRP · Implied Policy Path · EFFR · SOFR_OIS 2026-09-14 ──────────────────────────────────────────┐
│ badges#caveats [NO_FUTURES_SOURCE] [POINT_MASS_PROBABILITY_MODEL] [PROXY_CURVE]                    │
│                [NO_OIS_SWAP_QUOTES_SOURCE] [FOMC_CALENDAR_HORIZON] [CURVE_UPDATED]                 │
│ kv#current  EFFR 3.6300 % (live) · target 3.5000–3.7500 · mid 3.6250 · basis +1.00 bp (5 obs)      │
│ tabs#view  [1 Path] [2 Probabilities]                                                              │
│ ┌ 1 Path ─────────────────────────────────────────────────────────────────────────────────────┐   │
│ │ grid#path  meeting (date) | SEP | days | implied o/n % | implied EFFR % | cum bp | step bp   │   │
│ │            | moves | vs 09-08 (bp) | decision bp (past rows, muted)                          │   │
│ │ kv#terminal  terminal 3.4990 % at 2026-12-09 · −12.60 bp from the current midpoint            │   │
│ └──────────────────────────────────────────────────────────────────────────────────────────────┘   │
│ ┌ 2 Probabilities ────────────────────────────────────────────────────────────────────────────┐   │
│ │ text#disclaimer  "Implied allocation of the curve-implied step onto adjacent 25 bp ranges —   │   │
│ │                   not an options-implied distribution; no fed-funds futures source"           │   │
│ │ grid#probs  meeting | outcome (−50/−25/hold/+25) | target range | prob % (bar)                 │   │
│ └──────────────────────────────────────────────────────────────────────────────────────────────┘   │
│ kv#model  engine wirp/policyPath@1.0.0 · hash[0..8] · step 25 bp · curve SOFR_OIS 2026-09-14        │
│ footer: sources ['NY Fed reference rates', 'FOMC calendar (federalreserve.gov)', 'internal.derived']│
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
Title `WIRP · Implied Policy Path · <reference> · <curveId> <curve.date>`; subtitle `next decision <meetingDate> · basis <appliedBp> bp (<source>) · step <stepBp> bp`. Formats: dates `date`, `implied o/n %` / `implied EFFR %` `pct` decimals 4, `cum bp` / `step bp` / `vs <date>` `bp` decimals 2 with `dir` up/down colouring, `moves` `px` decimals 3, `prob %` `pct` decimals 2 rendered as a right-aligned number plus an inline bar, `decision bp` `bp` decimals 0. Past meetings render `muted` with only `meeting`, `SEP`, `decision bp` filled. `initialFocus:'path'`. Skeleton while `payload === undefined`: `kv#current` with the four labels and muted `—`, plus 3 muted `grid#path` rows. `meta.unavailable` entries render the affected cell as `—` with `detail` as the tooltip and an amber badge; `FOMC_CALENDAR_HORIZON` adds the footer line "only 3 undecided FOMC meetings are published". `meta.entitlement` denials (`NO_FIRM_ENTITLEMENT` on `nyfed.rates`) blank `kv#current` and, because the whole path is anchored on `targetMid`, blank `cum bp`/`step bp`/`moves`/`probs` with the same reason while leaving `implied o/n %` (`internal.derived`) visible (ENTL-05).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `1` / `2` | always | `tab-path` / `tab-probabilities` | `setParams({ view })` (tabs; §2.6 rule 5) |
| `K` | always | `cycle-curve` | `curveId` → `SOFR_OIS → UST_BILL` |
| `D` | always | `date-prompt` | `ctx.prompt('date', { label:'Curve date' })` → `setParams({ date })` |
| `ArrowLeft` / `ArrowRight` | grid | `prev-date` / `next-date` | step through the curve's `availableDates` → `setParams({ date })` |
| `R` | always | `cycle-reference` | `reference` → `EFFR → SOFR` |
| `B` | always | `basis-prompt` | `ctx.prompt('number', { label:'EFFR−SOFR basis, bp', initial: basis.appliedBp })` → `setParams({ basisBp })`; empty input restores `null` (derived) |
| `S` | always | `step-prompt` | `ctx.prompt('number', { label:'Policy step, bp', initial: model.stepBp })` → `setParams({ stepBp })` |
| `N` | always | `cycle-meetings` | `meetings` → `3 → 4 → 6 → 8` |
| `C` | always | `compare-prompt` | `ctx.prompt('date', { label:'Compare curve date' })` → `setParams({ compare })` |
| `X` | always | `clear-compare` | `setParams({ compare: null })` |
| `Enter` | grid | `row-provenance` | `ctx.provenance(row.provIdx)` — the curve build for a future meeting, the `fed.fomc` record for a past one |
| `Shift+Enter` | grid | `open-fed-next` | `ctx.navigateNext('FED ' + row.meetingDate)` |
| `G` | always | `open-crvf` | `ctx.navigate('CRVF ' + params.curveId + ' ' + payload.curve.date)` |
| `I` | always | `open-icvs` | `ctx.navigate('ICVS ' + params.curveId + ',UST_PAR')` |

#### CSV
`filename = 'WIRP_' + reference + '_' + curve.date.replace(/-/g,'') + '.csv'`; header comment lines (API.md §9) `# implied allocation, not an options-implied distribution` and `# no fed-funds futures or options source (BRIEF §2)`. Columns `meetingDate,hasSep,isPast,daysAhead,impliedOvernightPct,impliedReferencePct,cumChangeBp,stepChangeBp,impliedMoves,outcomeMoves,outcomeBp,rangeFrom,rangeTo,probPct,vsCompareDeltaBp,decisionBp,source`; one row per (`meetings[]` × `outcomes[]`), so a meeting with two outcomes emits two rows with the meeting-level columns repeated; a past meeting emits a single row with the implied and outcome columns empty and `decisionBp` filled. Example row: `2026-10-28,false,false,43,3.5620,3.5720,-5.30,-4.60,-0.212,0,0,3.5000,3.7500,78.80,-1.90,,internal.derived`.

#### Help
summary `FOMC-dated implied policy path from the money-market curve (no futures source)`; description `WIRP reads the overnight rate implied between consecutive FOMC decision dates off the SOFR OIS curve (or the Treasury bill curve) and expresses it as an EFFR path against the current target midpoint: the implied rate at each meeting, the cumulative and per-meeting change in basis points, and the implied number of 25 bp moves. Because no fed-funds futures or options source is reachable, the probability tab is not an options-implied distribution: it allocates each meeting's implied step onto the two adjacent 25 bp target ranges by linear interpolation, and says so on screen and in the export. The EFFR−SOFR basis is derived from the stored fixings and can be overridden. Compare a second curve date to see how the path shifted.`; params `curveId` ("SOFR_OIS or UST_BILL", `SOFR_OIS`), `date` ("curve date; default latest", `2026-09-14`), `reference` ("EFFR or SOFR"), `basisBp` ("EFFR−SOFR basis in bp; default derived from fixings", `1`), `meetings` ("how many undecided meetings to project", `8`), `stepBp` ("assumed policy increment", `25`), `compare` ("earlier curve date to diff the path against", `2026-09-08`), `view` ("path or probabilities"); sources `['nyfed.rates', 'fed.fomc', 'treasury.yieldcurve', 'treasury.bills', 'internal.derived']`; related `['FED', 'CRVF', 'ICVS', 'BTMM', 'ECO']`.

#### Unavailable and reason codes
| Case | `meta.unavailable` / footer |
| --- | --- |
| Always (by design) | footer badges `NO_FUTURES_SOURCE` ("no fed-funds futures or options source is reachable; the path is read off the money-market curve — BRIEF §2") and `POINT_MASS_PROBABILITY_MODEL` ("probabilities are a two-point allocation of the implied step, not an options-implied distribution"); both also appear in `model.caveats` and in the CSV header comments |
| Fewer undecided FOMC meetings than requested | `{ field:'meetings', reason:'NO_SOURCE', detail:'fomc_meetings holds <n> undecided meetings; the FOMC has not published the <yyyy+1> calendar' }`; caveat `FOMC_CALENDAR_HORIZON`; the grid shows the meetings that exist and no synthetic dates are invented |
| Fewer than 3 paired EFFR/SOFR fixings | `{ field:'basis.appliedBp', reason:'NO_SOURCE', detail:'fewer than 3 paired EFFR/SOFR fixings stored; basis set to 0 bp' }`; `basis.source='zero'`; `kv#current` shows `basis 0.00 bp (no data)` in amber |
| No EFFR target range stored | `{ field:'current.targetMid', reason:'NO_SOURCE', detail:'no EFFR target range stored on or before <date>' }`; `cumChangeBp`, `stepChangeBp`, `impliedMoves` and every `outcomes[]` row `{ v:null, st:'blank', r:'PROVIDER_DOWN' }`; `impliedOvernightPct` still renders |
| `curveId='SOFR_OIS'` | `curve.caveats` `PROXY_CURVE`, `NO_OIS_SWAP_QUOTES_SOURCE` (wording per the `CRVF` entry) |
| Typed `date` with no curve on or before it | `422 VALIDATION_FAILED { location:'fnParams', field:'date' }` |
| `compare` date with no curve | `{ field:'compare', reason:'NO_SOURCE', detail:'no <curveId> curve on or before <date>' }`; `vsCompare = null`, column hidden, warn badge |
| Served `curve_date` > 5 SIFMA business days old | implied cells `st:'stale'`, `meta.staleness:'stale'`, footer `CURVE_DATE <date>` (TERM-12) |
| Past meeting rows | implied and outcome cells `{ v:null, st:'na', r:'NOT_IN_UNIVERSE' }`; `decisionBp` filled — never back-filled with a model number |
| Entitlement | `meta.entitlement[]` per denied field; `NO_FIRM_ENTITLEMENT` on `nyfed.rates` blanks `kv#current` and every target-anchored cell (ENTL-05) |
| `wirp/policyPath` failure (non-monotone meeting dates, negative inter-meeting interval) | `500 INTERNAL` with `details.engine`; never a partial path |

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared); aliases `FFIP`, `PATH` resolve to `WIRP` with no `aliasParams` |
| resolver unit | `packages/server/test/unit/functions/WIRP.resolve.test.ts` | against the seeded fixtures: derived basis = `mean(EFFR − SOFR) × 100` over the 5 stored pairs = `1.00` with `observations:5`; `stepChangeBp` telescopes to `cumChangeBp`; `Σ outcomes[].probPct === 100` to 1e-9 for every meeting; `params.basisBp = 5` sets `basis.source:'user'` and shifts every `impliedReferencePct` by exactly 0.05 |
| golden payload | `packages/server/test/integration/functions/WIRP.golden.test.ts` | `WIRP` at the frozen clock deep-equals `WIRP.default.json` (3 future meetings 2026-09-16 / 10-28 / 12-09, 5 past meetings, `FOMC_CALENDAR_HORIZON` raised); `meta.engines` contains `wirp/policyPath@1.0.0` with a stable `inputsHash` across two runs (ANAL-08) |
| golden analytics | `packages/core/test/analytics/wirp.test.ts` | `fixtures/golden/analytics/wirp/2026-09-15.json` `{ inputs, valuationTs, expected }` reproduces every `impliedOvernightPct`, `cumChangeBp` and `probPct` to 1e-9 (QA-01, ANAL-09) |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `WIRP.default.csv`; every numeric cell equals the payload value; the two `#` header comment lines are present and first |
| parity | `packages/server/test/parity/fn-parity.test.ts` | shared (API-05); the `q:<EFFR>` WS snapshot `RATE`/`TARGET_FROM`/`TARGET_TO` equal `payload.current` |
| screen | `packages/web/test/screens/WIRP.test.tsx` | renders the golden; `1`/`2` switch tabs; the probabilities tab always renders `text#disclaimer`; `NO_FUTURES_SOURCE` and `POINT_MASS_PROBABILITY_MODEL` badges always present; live cells registered for `q:*`; `B`/`S`/`N` call `setParams`; past rows muted with no implied numbers; skeleton when `payload === undefined` |
| horizon degraded | `packages/server/test/integration/functions/WIRP.horizon.test.ts` | `N=8` with 3 undecided meetings → 200, the `NO_SOURCE` entry above, `FOMC_CALENDAR_HORIZON` caveat, exactly 3 future rows, no invented dates |
| missing target | `packages/server/test/integration/functions/WIRP.notarget.test.ts` | with EFFR fixings removed → 200, `current.targetMid` blank, every `cumChangeBp` `st:'blank'` / `r:'PROVIDER_DOWN'`, `impliedOvernightPct` still populated, no throw |
| e2e | `packages/e2e/tests/rates.spec.ts` | `WIRP <GO>` shows the next decision 2026-09-16 and both permanent caveat badges; `2` opens the probabilities tab and the disclaimer text is visible; PRINT yields a CSV whose `probPct` for 2026-10-28 equals the screen value |

---

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

---

### SWPM — Swap Manager

| Attribute | Value |
| --- | --- |
| Code / aliases | `SWPM` / `SWAP` (no `aliasParams`) |
| Tier / category | 3 / rates |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/SWPM.ts` · `packages/server/src/functions/SWPM/resolve.ts` · `packages/web/src/screens/SWPM/Screen.tsx` · `fixtures/golden/functions/SWPM.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-03) (FUNC-04) (ANAL-01) (ANAL-02) (ANAL-08) (ANAL-09) (DATA-07) (DATA-10) (REF-06) (TERM-06) (TERM-11) (TERM-12) (ENTL-05) (QA-01) |

SWPM prices one **USD SOFR overnight-index swap** against the `SOFR_OIS` build of §0 (single-curve OIS:
the same build supplies the forwards and the discount factors). It takes no security: the swap is defined
entirely by its parameters, so `assetClasses:'none'` and the runner passes `instrument = null`
(FUNCTIONS.md §1.4.3 step 3). Conventions are the §0 "OIS swap conventions" row, restated by the payload's
`conventions` block so a reviewer can diff screen against contract. Every number comes from
`swap/ois@1.0.0` or `curve/*`; the resolver does no arithmetic of its own (ANAL-08). The `SOFR_OIS` curve is
built from proxies (CRVF table row `SOFR_OIS`), so **every** SWPM payload carries the `PROXY_CURVE` and
`NO_OIS_SWAP_QUOTES_SOURCE` caveats and the screen shows them as persistent amber badges (§0 common footer
badges) — there is no OIS swap-quote or futures source in this build (BRIEF §2).

#### Params
```ts
export const SwpmParams = z.object({
  side: z.enum(['pay', 'receive']).default('pay'),                       // the FIXED side, from the user's perspective
  notional: z.number().positive().max(1e12).default(10_000_000),         // USD, both legs (no amortisation in v1)
  tenor: z.enum(['1Y', '2Y', '3Y', '4Y', '5Y', '7Y', '10Y', '15Y', '20Y', '30Y']).default('5Y'),
  effective: z.iso.date().nullable().default(null),                      // null = T+2 SIFMA from the valuation date
  maturity: z.iso.date().nullable().default(null),                       // null = effective + tenor, modified_following SIFMA
  fixedRate: z.number().min(-5).max(50).nullable().default(null),        // percent; null = solve the par rate (NPV = 0)
  curveDate: z.iso.date().nullable().default(null),                      // null = latest stored SOFR_OIS curve_date ≤ validAt
  interpolation: z.enum(['linear_zero', 'log_linear_df', 'monotone_convex']).default('monotone_convex'),
  krdTenors: z.array(z.enum(['2Y', '5Y', '10Y', '30Y'])).min(1).max(4).default(['2Y', '5Y', '10Y', '30Y']),
  view: z.enum(['summary', 'fixed', 'float', 'risk']).default('summary'),
});
```
`curveId` is **not** a parameter: a USD SOFR OIS is priced on `SOFR_OIS` and nothing else. `UST_PAR` appears
only as the optional swap-spread reference in `results.spreads` (below), which needs no parameter either.

#### Argument grammar
`positional [{ name:'tenor', type:'enum', values:['1Y','2Y','3Y','4Y','5Y','7Y','10Y','15Y','20Y','30Y'], optional:true }, { name:'fixedRate', type:'number', optional:true }]`,
`keyed { N: { name:'notional', type:'number' }, R: { name:'fixedRate', type:'number' }, EFF: { name:'effective', type:'date' }, MAT: { name:'maturity', type:'date' }, SIDE: { name:'side', type:'enum', values:['pay','receive'] }, CRVD: { name:'curveDate', type:'date' }, INTERP: { name:'interpolation', type:'enum', values:['linear_zero','log_linear_df','monotone_convex'] } }`, no `rest`.
A bare positional number after the tenor is the fixed rate in percent (`SWPM 5Y 3.55`); `N=` accepts the
`1.2B`/`350M`/`25M` suffixes of `core/functions/shared/screen.ts#parseNumber` (TIER2 EQS §Argument grammar).
Examples: `SWPM` → `{ side:'pay', notional:10000000, tenor:'5Y', fixedRate:null, … }` · `SWPM 10Y 3.75 N=250M` → `{ tenor:'10Y', fixedRate:3.75, notional:250_000_000 }` · `SWAP 2Y SIDE=RECEIVE EFF=2026-09-21 INTERP=LOG` → `{ tenor:'2Y', side:'receive', effective:'2026-09-21', interpolation:'log_linear_df' }`.

#### Payload
```ts
export type SwpmLegKind = 'fixed' | 'float';
export type SwpmPeriod = {
  n: number; start: string; end: string; paymentDate: string;           // paymentDate = end + 2 business days (SIFMA, modified_following)
  days: number; accrualFactor: number;                                  // ACT/360
  rate: ValueCell;                                                      // fixed: the contract rate; float: compounded SOFR for the period (percent)
  realisedDays: number; projectedDays: number;                          // float only: split of `days` between rate_fixings and curve forwards
  isCurrent: boolean; cashflow: ValueCell; df: number; pv: ValueCell;
};
export type SwpmPayload = {
  variant: 'default';
  trade: { side: 'pay' | 'receive'; notional: number; currency: 'USD'; tenor: string;
           tradeDate: string; effective: string; maturity: string; valuationDate: string;
           fixedRate: ValueCell; fixedRateSource: 'user' | 'par'; stub: 'short_front' | 'none' };
  conventions: { fixedFreq: 'annual'; fixedDayCount: 'ACT/360'; floatIndex: 'SOFR'; floatFreq: 'annual';
                 floatDayCount: 'ACT/360'; compounding: 'daily'; observationShift: 0; paymentLagDays: 2;
                 bdc: 'modified_following'; calendarId: 'SIFMA'; spotLagDays: 2; discounting: 'SOFR_OIS (single curve)' };
  curve: { id: 'SOFR_OIS'; date: string; requestedDate: string | null; buildId: number; method: 'ois_bootstrap';
           interpolation: string; engine: { name: string; version: string; inputsHash: string }; provIdx: number;
           caveats: Array<'PROXY_CURVE' | 'NO_OIS_SWAP_QUOTES_SOURCE'> };
  fixing: { rateCode: 'SOFR'; effectiveDate: string; rate: ValueCell; provIdx: number; usedForRealised: boolean };
  legs: Array<{ kind: SwpmLegKind; payReceive: 'pay' | 'receive'; periods: SwpmPeriod[];
                pv: ValueCell; accrued: ValueCell; dv01: ValueCell; nextPaymentDate: string | null; nextCashflow: ValueCell }>;
  results: {
    parRatePct: ValueCell; fixedRatePct: ValueCell; npv: ValueCell;                 // npv > 0 = in the user's favour
    pvFixed: ValueCell; pvFloat: ValueCell; annuityPv01: ValueCell;                  // PV of 1 bp on the fixed leg, currency
    dv01: ValueCell; dv01Per1mm: ValueCell; marketValuePctNotional: ValueCell;
    accrued: ValueCell; breakEvenRatePct: ValueCell; effectiveDurationYears: ValueCell;
    keyRateDurations: Array<{ tenor: '2Y' | '5Y' | '10Y' | '30Y'; krd: number; dv01: number }>;
    spreads: { treasuryTenor: string; treasuryYieldPct: ValueCell; swapSpreadBp: ValueCell; curveProvIdx: number } | null;
  };
  engines: Array<{ name: string; version: string }>;                                 // echo of meta.engines for the footer
};
```
Every cell above follows §0.4 rule 3 (stored/derived values: `st:'closed'`, `provIdx` from `ctx.prov.add`)
and rule 4 (engine-derived values cite the provenance of their primary input — the curve build — and the
engine is in `meta.engines`). Rates and yields are percent, `swapSpreadBp` is basis points, `df` is unitless
(§0 "Percent vs decimal on the wire").

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `curves` (`SOFR_OIS`, `UST_PAR`), `curve_points` (`is_latest`, `curve_date ≤ validAt`, `quote_type` `ois_rate`/`par_yield`), `curve_builds` (build cache, keyed by `inputs_hash`), `rate_fixings` (`rate_code='SOFR'`, `is_latest`, for the realised part of the current float period), `calendars` + `calendar_holidays` (`calendar_id='SIFMA'`), `rate_terms` (`SOFR` publication time, day count) |
| Data services (§1.4.2) | `data.reference.calendar('SIFMA')`, `data.curves.points('SOFR_OIS', curveDate)`, `data.curves.build('SOFR_OIS', date, interpolation)`, `data.curves.points('UST_PAR', curveDate)` (swap spread only), `data.rates.latest('SOFR')`, `data.rates.history('SOFR', 400)` (realised compounding when `effective < valuationDate`) |
| Read-through (`providers.ensure`) | None. The `SOFR_OIS` inputs are written by the `fedRates.ts` and `treasuryCurves.ts` scheduler jobs (ARCHITECTURE §7.1); a request-path fetch of the Treasury XML takes ≈ 18 s (BRIEF §2) and is never done here. A missing curve degrades per "Unavailable and reason codes". |
| Engines (`core/analytics`) | `swap/ois@1.0.0` (schedule, compounded forwards, NPV, par rate, PV01, KRD), `curve/bootstrap@1.0.0`, `curve/interp@1.0.0` |
| Subjects (live) | `c:SOFR_OIS` (rebuild notification, §0 `CURVE_UPDATED`), `r:SOFR` (today's fixing) |
| Field ids (`fieldIds(assetClass)`) | `default: [SWAP_PAR_RATE, SWAP_FIXED_RATE, SWAP_NPV, SWAP_PV01, SWAP_ACCRUED, DV01, KRD_2Y, KRD_5Y, KRD_10Y, KRD_30Y, RATE, RATE_AVG_30D, CURVE_ZERO, CURVE_DF, CURVE_FWD_3M, CURVE_PAR, YLD_YTM_MID]` |

Field ids introduced by this entry (FUNCTIONS.md §1.8 step 6 — add to `core/fields/dictionary.ts` and
`providers/licences.ts`; `fieldClass:'analytic'`, `updateFreq:'daily'`, `pit:false`, `since:'2026.09.1'`,
`sources = { assetClass:'*', sourceId:'internal.derived', endpoint:'curve_builds', providerPath:'core/analytics/swap/ois.ts' }`,
`assetClasses: []` — SWPM takes no security, so these are function fields like the `c:` family, API.md §6.1):

| id | label | type / unit | decimals | derivation |
| --- | --- | --- | --- | --- |
| `SWAP_PAR_RATE` | Swap par rate | number / pct | 4 | fixed rate that sets `pvFixed + pvFloat = 0` on the `SOFR_OIS` build |
| `SWAP_FIXED_RATE` | Swap fixed rate | number / pct | 4 | `params.fixedRate`, or `SWAP_PAR_RATE` when null |
| `SWAP_NPV` | Swap NPV | number / ccy | 2 | `pvFloat − pvFixed` for `side='pay'`, negated for `receive` |
| `SWAP_PV01` | Fixed-leg annuity PV01 | number / ccy | 2 | `Σ accrualFactor × df × notional × 0.0001` |
| `SWAP_ACCRUED` | Swap accrued | number / ccy | 2 | fixed accrued − float accrued on the current period to the valuation date |

#### Resolver
`default` (`resolve`; no `variants` — `assetClasses:'none'`):
1. `cal = await ctx.data.reference.calendar('SIFMA')` (REF-06); `valuationDate` = the ISO date of `ctx.asOf.validAt` in `America/New_York`; `tradeDate = valuationDate`.
2. Dates: `effective = params.effective ?? addBusinessDays(tradeDate, 2, cal)`; `maturity = params.maturity ?? adjust(addTenor(effective, params.tenor), 'modified_following', cal)`. `maturity ≤ effective` → `400 VALIDATION_FAILED { location:'fnParams', field:'maturity', detail:'maturity must be after the effective date' }`. `effective` more than 30 years before `valuationDate` → same error on `effective`.
3. Curve: `pts = await ctx.data.curves.points('SOFR_OIS', params.curveDate ?? valuationDate)` (served `curveDate ≤ requested`; `params.curveDate` given with no stored curve on or before it → `422 VALIDATION_FAILED { field:'curveDate' }`, as CRVF); `build = await ctx.data.curves.build('SOFR_OIS', pts.curveDate, params.interpolation)`. `provIdx_curve = ctx.prov.add({ sourceId: pts.sourceId, provenanceId: pts.points[0].provenanceId, capturedAt, sourceTs, st: pts.curveDate < valuationDate && olderThan5BusinessDays ? 'stale' : 'closed', tier:'eod' })`; `ctx.engines.add(build.engine)`; `curve.caveats = ['PROXY_CURVE', 'NO_OIS_SWAP_QUOTES_SOURCE']` (always — CRVF table).
4. Fixing: `fx = await ctx.data.rates.latest('SOFR')` → `fixing = { rateCode:'SOFR', effectiveDate: fx.effectiveDate, rate: { v: fx.rate, st:'closed', ts: fx.sourceTs, provIdx: ctx.prov.add({ sourceId:'nyfed.rates', provenanceId: fx.provenanceId, capturedAt: fx.capturedAt, sourceTs: fx.sourceTs, st:'closed', tier:'eod' }) }, usedForRealised: effective < valuationDate }`. When `effective < valuationDate` also `hist = await ctx.data.rates.history('SOFR', daysBetween(effective, valuationDate) + 5)` for the realised daily compounding of the current period.
5. Schedules (`swap/ois@1.0.0#schedule`): both legs **annual ACT/360**, stub `short_front` when `(maturity − effective)` is not a whole number of years, roll on the effective day-of-month, `modified_following` on `SIFMA`, `paymentDate = addBusinessDays(end, 2, cal)` (payment lag 2, §0). One `SwpmPeriod` per accrual period per leg.
6. Float leg (`swap/ois@1.0.0#compoundedRate`): for each period, daily-compounded SOFR with observation shift 0 — business days from `start` to `end` on `SIFMA`; a day **on or before** the last fixing date uses `rate_fixings.rate` from step 4 (`realisedDays++`), a later day uses `build.curve.fwd(t_d, t_{d+1})` simple ACT/360 (`projectedDays++`); `rate = ((Π (1 + r_d × d_d/360)) − 1) × 360 / days × 100`. `cashflow = notional × rate/100 × accrualFactor`, `df = build.curve.df(t(paymentDate))`, `pv = cashflow × df`.
7. Fixed leg: `rate` = `params.fixedRate` when given, else the par rate from step 8; `cashflow = notional × rate/100 × accrualFactor`; same `df`/`pv` rule.
8. Par rate (`swap/ois@1.0.0#parRate`): `parRatePct = (Σ_float pv) / (Σ_fixed accrualFactor × df × notional) × 100`. `fixedRateSource = params.fixedRate === null ? 'par' : 'user'`; when `'par'`, `trade.fixedRate` = `parRatePct` and `results.npv.v = 0` by construction (asserted to `|npv| < 1e-6 × notional` in the golden test).
9. Results: `pvFixed = Σ fixed pv`, `pvFloat = Σ float pv`; `npv = (side === 'pay' ? pvFloat − pvFixed : pvFixed − pvFloat)`; `annuityPv01 = Σ accrualFactor × df × notional × 0.0001`; `dv01 = (npv(curve bumped −1 bp, fixed rate held) − npv(curve bumped +1 bp)) / 2` via `build.curve.bump(null, ±1)` (parallel bump of the zero curve), `dv01Per1mm = dv01 × 1e6 / notional`; `marketValuePctNotional = npv / notional × 100`; `accrued` = fixed accrued (`notional × fixedRate/100 × accrualFactor(periodStart → valuationDate)`) minus float accrued (compounded realised SOFR over the same window), zero when `valuationDate ≤ effective`; `breakEvenRatePct = parRatePct`; `effectiveDurationYears = dv01 / (notional × 0.0001)`.
10. `keyRateDurations`: `swap/ois@1.0.0#keyRateRisk` bumps the **zero** curve with the §0 triangular kernel at each `params.krdTenors` entry by ±1 bp and reprices; `dv01` per tenor in currency, `krd` = `dv01 / (notional × 0.0001)` in years. `Σ dv01 ≈ results.dv01` (asserted within 2 % by the KRD test).
11. Swap spread: `ustPts = await ctx.data.curves.points('UST_PAR', pts.curveDate)`; `treasuryTenor` = the `UST_PAR` tenor equal to `params.tenor` when present, else the nearest longer one; `treasuryYieldPct` = that point's value; `swapSpreadBp = (fixedRatePct − treasuryYieldPct) × 100`; a second `ctx.prov.add` for `treasury.yieldcurve` supplies `curveProvIdx`. No `UST_PAR` curve for the date → `results.spreads = null` and `ctx.unavailable.add({ field:'results.spreads', reason:'NO_SOURCE', detail:'no UST_PAR curve on or before <date>; swap spread not computed' })`.
12. Return `{ variant:'default', … }`; `engines` echoes `meta.engines` (`swap/ois`, `curve/bootstrap`, `curve/interp`).
Budget: 4 DB round-trips (calendar, `SOFR_OIS` points, `UST_PAR` points, `rate_fixings`; `curve_builds` is a 5th on a cache miss, a 6th read for `rates.history` only when the swap is seasoned); pure compute < 8 ms for a 30Y annual schedule (30 periods × ~252 daily forwards); p95 < 150 ms warm.

#### Live
`{ subjects: ['c:SOFR_OIS', 'r:SOFR'], fields: '*', conflationMs: 1000 }`. No cell carries `Cell.live` — a swap
valuation is a build-level object, not a streaming number. The shell compares the `c:SOFR_OIS` delta's
`BUILD_ID` with `payload.curve.buildId` and the `r:SOFR` delta's `RATE` with `payload.fixing.rate.v`; either
difference raises the `CURVE_UPDATED` badge and `Enter` re-runs with `launchKind:'param'`
(`details.changed:['curve']`), exactly as YAS/CRVF (§0).

#### Screen
```
┌ SWPM · USD SOFR OIS · 5Y · pay fixed ───────────────────────────────────────────────────────────┐
│ badges#caveats  [PROXY_CURVE] [NO_OIS_SWAP_QUOTES_SOURCE] [CURVE_UPDATED?] [STALE?]              │
│ split(row, [0.32, 0.68])                                                                         │
│ ┌ form#trade ───────────────┐ ┌ kv#results (columns 2) ────────────────────────────────────────┐ │
│ │ Side      [pay|receive]   │ │ Par rate     3.5412 %    Fixed rate    3.5412 %                │ │
│ │ Notional  10,000,000      │ │ NPV              0.00    MV % notional   0.0000                │ │
│ │ Tenor     [1Y…30Y]        │ │ PV fixed  -1,633,204.11  PV float   1,633,204.11               │ │
│ │ Fixed %   (blank = par)   │ │ PV01 (1bp)   4,612.08    DV01        4,610.77                  │ │
│ │ Effective 2026-09-17      │ │ DV01 /1mm      461.08    Eff duration   4.611 y                │ │
│ │ Maturity  2031-09-17      │ │ Accrued          0.00    Break-even   3.5412 %                 │ │
│ │ Curve     SOFR_OIS 09-14  │ │ Swap spread vs UST 5Y 3.61 %   -6.9 bp                         │ │
│ └───────────────────────────┘ │ table#krd  2Y 0.02 | 5Y 4.57 | 10Y 0.00 | 30Y 0.00  (yrs, DV01)│ │
│ kv#conventions  annual ACT/360 both legs · daily-compounded SOFR · shift 0 · pay lag 2 · T+2 ·   │
│                 modified_following · SIFMA · single-curve OIS discounting                        │
│ tabs#view [1 Summary] [2 Fixed leg] [3 Float leg] [4 Risk]                                        │
│   grid#fixed  n | start | end | pay date | days | acc factor | rate % | cashflow | df | pv       │
│   grid#float  same + realised d | projected d   (current period row tone 'highlight')            │
│   grid#risk   tenor | KRD (yrs) | DV01 (ccy) | share %                                           │
│ footer: sources ['NY Fed SOFR (public domain)', 'U.S. Treasury par yield curve (public domain)', │
│                  'internal.derived'] · curve 2026-09-14 · asOf                                    │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```
Title `SWPM · USD SOFR OIS · <tenor> · <side> fixed`; subtitle
`effective 2026-09-17 · maturity 2031-09-17 · notional 10,000,000 USD · curve SOFR_OIS 2026-09-14 · monotone_convex`.
Formats: rates `fmt:'pct'` decimals 4, currency `fmt:'ccy'` decimals 2, `df` `fmt:'px'` decimals 6, accrual
factors `fmt:'px'` decimals 6, days `fmt:'int'`, KRD `fmt:'px'` decimals 3, `swapSpreadBp` `fmt:'bp'`
decimals 1. Negative currency values render in the down tone with a leading `-`. `initialFocus:'trade'`.
Skeleton while `payload === undefined`: the form with the defaults filled, `kv#results` rows muted `—`, and
ten muted schedule rows. `meta.unavailable` entries render the affected cell as `—` with `detail` as the
tooltip plus an amber badge in `badges#caveats`; `meta.entitlement` denials (`NO_FIRM_ENTITLEMENT` on
`nyfed.rates` or `treasury.yieldcurve`) blank the cells fed by that source and keep the rest, with the reason
in the tooltip (ENTL-05). `meta.staleness:'stale'` puts the `STALE` glyph on every curve-derived cell
(TERM-12).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | form | `reprice` | submit the form → `ctx.setParams({ side, notional, tenor, fixedRate, effective, maturity })` (usage `fn.param`) |
| `ArrowUp` / `ArrowDown` | form (fixed-rate field) | `bump-rate` | ±1 bp on `fixedRate`; on the notional field ±1,000,000 — form-local until `Enter` |
| `Shift+ArrowUp` / `Shift+ArrowDown` | form | `bump-rate-10` | ×10 of the above |
| `P` | always | `set-par` | `ctx.setParams({ fixedRate: null })` — re-solve at par |
| `S` | always | `flip-side` | `side` → the other of `pay, receive` |
| `T` | always | `cycle-tenor` | `tenor` → next of `1Y, 2Y, 3Y, 4Y, 5Y, 7Y, 10Y, 15Y, 20Y, 30Y` |
| `N` | always | `notional-prompt` | `ctx.prompt('number', { label:'Notional', initial: params.notional })` → `setParams({ notional })` |
| `E` | always | `effective-prompt` | `ctx.prompt('date', { label:'Effective', initial: payload.trade.effective })` → `setParams({ effective })` |
| `I` | always | `cycle-interp` | `linear_zero → log_linear_df → monotone_convex` |
| `1` / `2` / `3` / `4` | always | `tab-summary` / `tab-fixed` / `tab-float` / `tab-risk` | `setParams({ view })` (tabs; §7.2 rule 5) |
| `Enter` | grid | `row-provenance` | `ctx.provenance(row.provIdx)` for the period's curve/fixing provenance |
| `C` | always | `open-crvf` | `ctx.navigate('ICVS ' + payload.curve.date)` (the `SOFR_OIS` curve behind the price) |
| `W` | always | `open-wirp` | `ctx.navigate('WIRP')` |
| `Y` | always | `open-yas` | `ctx.navigate('YAS')` on the panel's Treasury, or the on-the-run note of `results.spreads.treasuryTenor` when the panel has none |

#### CSV
`filename = 'SWPM_' + tenor + '_' + trade.effective.replace(/-/g,'') + '_' + asOf.replace(/[-:]/g,'') + '.csv'`.
Long format (FUNCTIONS.md §1.6 rule 3 — the payload is multi-block): columns
`section,leg,n,key,value,unit,asOf,source`. Rows, in order: one per `trade` field (`section='trade'`,
`leg=''`, `n=''`), one per `conventions` field (`section='conventions'`), one per `curve`/`fixing` field
(`section='curve'`, `section='fixing'`), one per `results` scalar (`section='results'`, unit
`pct | ccy | bp | years`), one per `keyRateDurations` entry (`section='krd'`, `key` = tenor, `value` = `krd`,
plus a second row `key = tenor + '/dv01'`), then one row per schedule period per leg
(`section='schedule'`, `leg='fixed'|'float'`, `n` = period number) for each of `start, end, paymentDate,
days, accrualFactor, rate, cashflow, df, pv` as separate `key`s so every number in the grid is exported.
Example row: `results,,,parRatePct,3.5412,pct,2026-09-15T18:41:28Z,internal.derived`.

#### Help
summary `Price a USD SOFR OIS: schedules, par rate, NPV, DV01 and key-rate risk`;
description `SWPM prices a single USD overnight-index swap against SOFR. Both legs are annual ACT/360; the floating leg is daily-compounded SOFR with no observation shift and a two-business-day payment lag, settled T+2 on the SIFMA calendar. Leave the fixed rate blank and SWPM solves the par rate that makes the swap worth zero; type a rate to value an existing trade. Forwards and discount factors come from the same SOFR OIS curve, which in this build is bootstrapped from proxies — the SOFR fixing, realised SOFR averages, bills and Treasury par yields — because no OIS swap quote or futures source is available; the PROXY_CURVE badge stays on the screen. Realised fixings are used for days already published and curve forwards for the rest. Key-rate DV01s bump the zero curve at 2, 5, 10 and 30 years.`;
params `side` ("pay or receive fixed", `pay`), `notional` ("notional in USD", `250M`), `tenor` ("1Y to 30Y", `5Y`), `effective` ("effective date; default T+2 SIFMA", `2026-09-21`), `maturity` ("maturity; default effective + tenor"), `fixedRate` ("fixed rate in percent; blank solves par", `3.55`), `curveDate` ("SOFR OIS curve date; default latest", `2026-09-14`), `interpolation` ("zero-curve interpolation"), `krdTenors` ("key-rate tenors"), `view` ("summary, fixed, float or risk");
sources `['nyfed.rates', 'treasury.yieldcurve', 'treasury.bills', 'internal.derived', 'internal.user']`;
related `['CRVF', 'YAS', 'WIRP', 'GC', 'BTMM']`.

#### Unavailable and reason codes
| Case | Behaviour |
| --- | --- |
| Always (every payload) | `curve.caveats = ['PROXY_CURVE','NO_OIS_SWAP_QUOTES_SOURCE']`; persistent amber badges with the text "SOFR OIS term points are proxied (SOFRAI averages, bills, UST par); no OIS swap or futures source (BRIEF §2)". The payload is still a full valuation — nothing is blanked. |
| No `SOFR_OIS` curve on or before the valuation date | no `503`: `ctx.unavailable.add({ field:'curve', reason:'NO_SOURCE', detail:'no SOFR_OIS curve on or before <date>' })`; `legs[].periods[].rate/df/pv`, `results.*` all `{ v:null, st:'blank', r:'PROVIDER_DOWN' }`; the schedule itself (dates, days, accrual factors) is still returned — it needs only the calendar |
| `params.curveDate` typed with no curve on or before it | `422 VALIDATION_FAILED { location:'fnParams', field:'curveDate', detail:'no SOFR_OIS curve on or before <date>' }` (a typed date must exist; same rule as CRVF) |
| Curve older than 5 business days | curve-derived cells `st:'stale'`, `meta.staleness:'stale'`, footer `CURVE_DATE <date>` (TERM-12) |
| Seasoned swap, SOFR fixings missing for part of the current period | `{ field:'legs.float.accrued', reason:'NO_SOURCE', detail:'SOFR fixings missing for <n> business days since <date>; those days use curve forwards' }`; the missing days are counted in `projectedDays` and the current period row shows an amber dot |
| No `UST_PAR` curve for the swap-spread tenor | `results.spreads = null`, `{ field:'results.spreads', reason:'NO_SOURCE', detail:'no UST_PAR curve on or before <date>; swap spread not computed' }`, footer note `NO_SWAP_SPREAD` |
| Tenor beyond the last curve node (30Y build ends before a 30Y swap's last payment) | `{ field:'legs.float.periods', reason:'NO_SOURCE', detail:'SOFR_OIS build ends at <t>y; periods beyond it are extrapolated flat from the last node' }`; those periods' cells keep `st:'closed'` with the detail as tooltip — the engine extrapolates flat, it never invents a node |
| Entitlement | `meta.entitlement[]` per denied field (`NO_FIRM_ENTITLEMENT` on `nyfed.rates` blanks `fixing` and every float `rate`; the fixed leg and the schedule survive). `TIER_EOD` never applies: every source here is `eod` |
| Engine non-convergence (par-rate annuity ≤ 0) | `500 INTERNAL` with `details.engine = 'swap/ois@1.0.0'`; never a partial number |

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared); `assetClasses === 'none'`, `requiresSecurity === false`, every optional param has `.default()` |
| golden payload | `packages/server/test/integration/functions/SWPM.golden.test.ts` | the 5Y par swap at the frozen clock (effective 2026-09-17, notional 10,000,000) deep-equals `SWPM.default.json`; a second case with `fixedRate:3.75` equals `SWPM.default.offmarket.json`; `meta.engines` names and `inputsHash` identical across two runs (ANAL-08) |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `SWPM.default.csv`; every numeric cell equals the payload value (schedule rows included) |
| parity | `packages/server/test/parity/fn-parity.test.ts` | shared (API-05); the `c:SOFR_OIS` snapshot `BUILD_ID` equals `payload.curve.buildId` |
| screen | `packages/web/test/screens/SWPM.test.tsx` | summary/fixed/float/risk tabs via `1`–`4`; `P` clears `fixedRate`; `S` flips the side; `ArrowUp` bumps 1 bp form-locally; both caveat badges present; skeleton renders with `payload undefined` |
| par-swap benchmark | `packages/core/test/analytics/swap.ois.test.ts` | `fixtures/golden/analytics/swap/ois-5Y-par.json` (§0.2): par rate reproduces the dataset, `NPV = 0 ± 1e-9 × notional`, `DV01` matches the dataset, and repricing at par ± 25 bp is linear within 0.5 % (ANAL-09, QA-01) |
| schedule conventions | `packages/core/test/analytics/swap.schedule.test.ts` | annual ACT/360 periods; `short_front` stub for a 4Y3M swap; `modified_following` never rolls a payment into the next month; `paymentDate = end + 2` SIFMA business days across the 2026 holiday table (REF-06) |
| compounding split | `packages/server/test/integration/functions/SWPM.seasoned.test.ts` | a swap effective 2026-06-17 shows `realisedDays > 0` and `projectedDays > 0` on the current period, realised days use `rate_fixings` values, and `accrued` is non-zero |
| KRD sum | `packages/core/test/analytics/swap.ois.test.ts` | `Σ keyRateDurations[].dv01` within 2 % of `results.dv01` for 1Y/5Y/10Y/30Y swaps |
| no curve | `packages/server/test/integration/functions/SWPM.nocurve.test.ts` | with `curve_points` for `SOFR_OIS` deleted, the payload is 200 with the schedule present, every valuation cell `st:'blank'`, one `meta.unavailable` entry, and no throw |
| e2e | `packages/e2e/tests/rates.spec.ts` | `SWPM 5Y <GO>` shows the par rate and `PROXY_CURVE`; typing `3.75 <Enter>` makes the NPV non-zero; PRINT yields a CSV whose `parRatePct` equals the screen value |

---

### SRCH — Treasury Search

| Attribute | Value |
| --- | --- |
| Code / aliases | `SRCH` / `BSRCH` (no `aliasParams`) |
| Tier / category | 3 / screening |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/SRCH.ts` · `packages/server/src/functions/SRCH/resolve.ts` · `packages/web/src/screens/SRCH/Screen.tsx` · `fixtures/golden/functions/SRCH.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-03) (FUNC-04) (REF-03) (REF-04) (REF-05) (ANAL-01) (ANAL-02) (ANAL-08) (DATA-10) (TERM-06) (TERM-11) (TERM-12) (ENTL-05) (NEWS-07) (QA-01) |

SRCH screens the **fixed-income universe of this build — US Treasuries** (`govt_terms`, 14 seeded securities:
seven bills from `treasury-bills.xml` and seven curated on-the-run notes/bonds, §0) by terms and conditions:
security type, maturity window, coupon window, benchmark (on-the-run) status, callability, day count,
amount outstanding. It is a *terms* screen, not a price screen: there is no evaluated fixed-income pricing
vendor in v1 (BRIEF §1 non-goals, DATA-04), so every yield, price and duration column is **derived from the
Treasury curve by the same engines YAS uses**, and the payload says so in `pricing.basis =
'curve_derived_no_market_quotes'` with the footer reason `NO_BOND_PRICE_SOURCE`. Corporates, munis and
mortgages are out of the wedge; asking for them returns an empty result with `NOT_APPLICABLE`, never
fabricated rows.

#### Params
```ts
export const SrchCriteria = z.object({          // persisted shape of saved_searches.query when kind = 'srch'
  market: z.enum(['UST']).default('UST'),                                    // the only fixed-income market in v1
  securityTypes: z.array(z.enum(['bill', 'note', 'bond', 'tips', 'frn'])).min(1).max(5).default(['bill', 'note', 'bond']),
  maturityFrom: z.iso.date().nullable().default(null),                       // inclusive, on govt_terms.maturity_date
  maturityTo: z.iso.date().nullable().default(null),                         // inclusive
  yearsFrom: z.number().min(0).max(40).nullable().default(null),             // alternative to maturityFrom/To: years from the valuation date
  yearsTo: z.number().min(0).max(40).nullable().default(null),
  couponFrom: z.number().min(0).max(25).nullable().default(null),            // percent; bills (coupon_rate IS NULL) pass only when couponFrom is null
  couponTo: z.number().min(0).max(25).nullable().default(null),
  couponTypes: z.array(z.enum(['fixed', 'zero', 'float', 'step', 'inflation_linked'])).min(1).max(5).default(['fixed', 'zero']),
  onTheRun: z.enum(['any', 'only', 'exclude']).default('any'),
  callable: z.enum(['any', 'only', 'exclude']).default('any'),
  minAmountOutstanding: z.number().min(0).nullable().default(null),          // face currency, govt_terms.amount_outstanding
  cusip: z.string().regex(/^[0-9A-Z]{1,9}$/).nullable().default(null),       // exact or prefix match on govt_terms.cusip
  columns: z.array(z.enum([
    'CUSIP', 'SECURITY_TYP', 'TERM_LABEL', 'CPN', 'CPN_FREQ', 'MATURITY', 'ISSUE_DT', 'MTY_YEARS',
    'YLD_YTM_MID', 'DISC_RATE', 'BEY', 'PX_CLEAN_MID', 'PX_DIRTY_MID', 'ACCRUED',
    'DUR_ADJ_MID', 'DV01', 'AMT_OUTSTANDING', 'ON_THE_RUN', 'DAY_CNT_DES',
  ])).min(1).max(12).default(['CUSIP', 'SECURITY_TYP', 'TERM_LABEL', 'CPN', 'MATURITY', 'MTY_YEARS', 'YLD_YTM_MID', 'DUR_ADJ_MID', 'ON_THE_RUN']),
  sort: SortSpec.default({ col: 'MATURITY', dir: 'asc' }),                   // SortSpec from core/functions/schemas.ts (TIER1 §0.1)
});

// packages/core/src/functions/manifests/SRCH.ts
export const SrchParams = SrchCriteria.extend({
  pageSize: z.number().int().min(10).max(200).default(50),
  settlement: z.iso.date().nullable().default(null),                         // null = T+1 SIFMA from the valuation date (§0)
  curveId: z.enum(['UST_PAR', 'UST_CMT']).default('UST_PAR'),                // curve the derived yields/prices come from
  curveDate: z.iso.date().nullable().default(null),                          // null = latest stored curve_date ≤ validAt
  savedSearchId: z.number().int().nullable().default(null),                  // saved_searches kind='srch'; explicit params win
});
```

#### Argument grammar
`positional [{ name:'securityTypes', type:'string', optional:true }]` (comma-separated types, e.g. `NOTE,BOND`),
`keyed { MAT: { name:'maturityFrom', type:'date' }, MATTO: { name:'maturityTo', type:'date' }, YRS: { name:'yearsFrom', type:'number' }, YRSTO: { name:'yearsTo', type:'number' }, CPN: { name:'couponFrom', type:'number' }, CPNTO: { name:'couponTo', type:'number' }, OTR: { name:'onTheRun', type:'enum', values:['any','only','exclude'] }, CALL: { name:'callable', type:'enum', values:['any','only','exclude'] }, AMT: { name:'minAmountOutstanding', type:'number' }, CUSIP: { name:'cusip', type:'string' }, CRV: { name:'curveId', type:'curve', values:['UST_PAR','UST_CMT'] }, CRVD: { name:'curveDate', type:'date' }, S: { name:'settlement', type:'date' }, COLS: { name:'columns', type:'string' }, SORT: { name:'sort', type:'string' }, N: { name:'pageSize', type:'int' }, SAVED: { name:'savedSearchId', type:'int' } }`,
`rest { name:'criteria', type:'text' }`.
`rest` is parsed by the shared `parseCriteria(text)` of `core/functions/shared/screen.ts` (TIER2 EQS §Argument
grammar) restricted to the SRCH factor names: `MTY_YEARS=2..10` → `{ yearsFrom:2, yearsTo:10 }`,
`CPN>4` → `{ couponFrom:4 }`, `CPN=3..5` → `{ couponFrom:3, couponTo:5 }`, `AMT>50B` →
`{ minAmountOutstanding:5e10 }`. `SORT=YLD_YTM_MID:desc` → `{ col:'YLD_YTM_MID', dir:'desc' }`;
`COLS=CUSIP,MATURITY,YLD_YTM_MID` replaces `columns`. An unparseable term yields
`CommandProblem { code:'ARG_PARSE' }` and the term is dropped (FUNCTIONS.md §2.4).
Examples: `SRCH` → `{ market:'UST', securityTypes:['bill','note','bond'], onTheRun:'any', sort:{col:'MATURITY',dir:'asc'}, pageSize:50, curveId:'UST_PAR' }` ·
`SRCH NOTE,BOND MTY_YEARS=5..30 CPN>4 SORT=YLD_YTM_MID:desc` → `{ securityTypes:['note','bond'], yearsFrom:5, yearsTo:30, couponFrom:4, sort:{col:'YLD_YTM_MID',dir:'desc'} }` ·
`BSRCH BILL OTR=ONLY COLS=CUSIP,MATURITY,DISC_RATE,BEY` → `{ securityTypes:['bill'], onTheRun:'only', columns:['CUSIP','MATURITY','DISC_RATE','BEY'] }`.

#### Payload
```ts
export type SrchColumnId = z.infer<typeof SrchCriteria>['columns'][number];
export type SrchPayload = {
  variant: 'default';
  universe: { market: 'UST'; label: string /* 'US Treasuries (govt_terms, as of 2026-09-15)' */; size: number;
              coverage: 'SEED_UNIVERSE_ONLY'; provIdx: number };
  filters: Array<{ field: string; label: string /* 'Maturity 2028-09-15 … 2036-09-15' */; matched: number; unavailableReason: string | null }>;
  pricing: { basis: 'curve_derived_no_market_quotes'; curveId: 'UST_PAR' | 'UST_CMT'; curveDate: string;
             interpolation: string; buildId: number; settlement: string; settlementRule: 'T+1 SIFMA'; provIdx: number;
             engine: { name: string; version: string; inputsHash: string } };
  columns: Array<{ id: SrchColumnId; label: string; fmt: 'px' | 'pct' | 'bp' | 'int' | 'ccy' | 'date' | 'text'; decimals?: number; sortable: true; fieldId?: FieldId }>;
  rows: Array<{
    instrumentId: number; key: string /* 'T 4.25 08/15/36 Govt' */; name: string; cusip: string;
    securityType: 'bill' | 'note' | 'bond' | 'tips' | 'frn'; termLabel: string | null; onTheRun: boolean;
    maturityDate: string; issueDate: string | null; couponRate: number | null; couponFreq: number;
    dayCount: string; isCallable: boolean; amountOutstanding: number | null; termsProvIdx: number;
    cells: Record<SrchColumnId, ValueCell>; subject: string /* 'q:<instrumentId>' */; rank: number;
  }>;
  counts: { universe: number; afterFilters: number; returned: number; excludedNoTerms: number; excludedNotPriced: number };
  facets: { securityType: Array<{ value: string; count: number }>; maturityBucket: Array<{ value: '0-1Y' | '1-3Y' | '3-7Y' | '7-10Y' | '10-20Y' | '20Y+'; count: number }>;
            onTheRun: Array<{ value: 'true' | 'false'; count: number }> };
  savedSearch: { searchId: number; name: string } | null;
  notes: Array<'NO_BOND_PRICE_SOURCE' | 'SEED_UNIVERSE_ONLY' | 'TIPS_FRN_NOT_PRICED' | 'CURVE_DATE_BEFORE_VALUATION'>;
};
```
`rows[].cells` is keyed by the `columns[].id`; every cell is a `ValueCell` built by §0.4 rule 3 (terms columns:
`st:'closed'`, `provIdx = termsProvIdx`) or rule 4 (analytic columns: `provIdx` = the curve's, engine in
`meta.engines`). `subject` is `q:<instrumentId>` and exists so `Ctrl+W` can push the selection into a
watchlist; **no** SRCH cell is live (there is no Treasury quote source — see below).

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `govt_terms` (bitemporal; read at `ctx.asOf.validAt/knownAt` — REF-03, REF-04), `instruments` (current, `asset_class='govt'`, `market_sector='Govt'`, `status`), `issues` (`currency`, `country_of_issue`), `identifiers` (`scheme='CUSIP'`), `curves`, `curve_points` (`is_latest`, `quote_type` `par_yield`/`cmt_yield`/`discount_rate`/`investment_yield`), `curve_builds`, `calendars` + `calendar_holidays` (`SIFMA`), `saved_searches` (`kind='srch'`, owner `ctx.user`) |
| Data services (§1.4.2) | `data.govt.search(criteria, page)` **(new — see additions below)**, `data.reference.instrument` (batched for the page's rows), `data.reference.calendar('SIFMA')`, `data.curves.points(curveId, date)`, `data.curves.points('UST_BILL', date)`, `data.curves.build(curveId, date, interpolation)` |
| Read-through (`providers.ensure`) | None. SRCH is a cross-section screen: per TIER1 §0.4 rule 2 a screen resolver never calls `ctx.providers.ensure`. `govt_terms` is filled by `seed/treasuries.ts` and the `treasuryCurves.ts` job; curves by the same job. Missing data is reported, never fetched inline. |
| Engines (`core/analytics`) | `bond/cashflows@1.0.0`, `bond/price@1.0.0`, `bond/risk@1.0.0`, `bill@1.0.0`, `curve/interp@1.0.0`, `curve/bootstrap@1.0.0` (the YAS engine set, §0) |
| Subjects (live) | None. There is no Treasury market-data line in this build (`md_lines` has no `govt` row: neither Cboe nor Yahoo publishes Treasury security quotes) — see "Unavailable and reason codes". |
| Field ids (`fieldIds(assetClass)`) | `default: [CUSIP, SECURITY_TYP, TERM_LABEL, CPN, CPN_FREQ, MATURITY, ISSUE_DT, MTY_YEARS, YLD_YTM_MID, DISC_RATE, BEY, PX_CLEAN_MID, PX_DIRTY_MID, ACCRUED, DUR_ADJ_MID, DV01, AMT_OUTSTANDING, ON_THE_RUN, DAY_CNT_DES, CURVE_PAR]` — the whole column whitelist, so a firm without the `treasury.yieldcurve` grant is told once rather than per column (ENTL-05) |

Field ids introduced by this entry (FUNCTIONS.md §1.8 step 6 — add to `core/fields/dictionary.ts` and
`providers/licences.ts`; `assetClasses: ['govt']`, `since:'2026.09.1'`):

| id | label | type / unit | decimals | fieldClass | derivation | sources | pit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `TERM_LABEL` | Term | string / text | — | reference | `govt_terms.term_label` ('4WK','10Y') | `{ assetClass:'govt', sourceId:'treasury.bills', endpoint:'govt_terms', providerPath:'server/src/data/govt.ts' }` | yes |
| `ON_THE_RUN` | On-the-run | boolean / text | — | reference | `govt_terms.on_the_run` | same | yes |
| `AMT_OUTSTANDING` | Amount outstanding | number / ccy | 0 | reference | `govt_terms.amount_outstanding` | same | yes |
| `PX_CLEAN_MID` | Clean price (curve-derived) | number / px | 6 | analytic | `bond/price@1.0.0#priceFromYield` at the curve yield, per 100 face | `{ assetClass:'govt', sourceId:'internal.derived', endpoint:'curve_builds', providerPath:'core/analytics/bond/price.ts' }` | no |

`CUSIP`, `SECURITY_TYP`, `CPN`, `CPN_FREQ`, `MATURITY`, `ISSUE_DT`, `MTY_YEARS`, `DAY_CNT_DES`,
`YLD_YTM_MID`, `DISC_RATE`, `BEY`, `PX_DIRTY_MID`, `ACCRUED`, `DUR_ADJ_MID`, `DV01` and `CURVE_PAR` are the
ids already declared by the YAS entry's `fieldIds` set and are reused unchanged.

#### Resolver
`default` (`resolve`; no `variants` — `assetClasses:'none'`):
1. `knownAt = ctx.asOf.knownAt`, `validAt = ctx.asOf.validAt` (terms are read exactly as believed then — REF-03). When `params.savedSearchId` is set, load `saved_searches` (`kind='srch'`, `owner_user_id = ctx.user.userId`) and re-parse its `query` through `SrchCriteria`; explicit params win over the saved ones; unknown or unowned id → `ctx.unavailable.add({ field:'savedSearch', reason:'NO_SOURCE', detail:'saved search not found or not owned by this user' })` and continue with the params as given. `savedSearch` is set in the payload when it loaded.
2. **Universe and filters** (1 DB round-trip): `data.govt.search(criteria, { cursor: ctx.page?.cursor, direction: ctx.page?.direction, limit: params.pageSize })` runs one statement over `govt_terms` joined to `instruments`/`issues`/`identifiers` with `bt_as_of(valid_from, valid_to, tx_from, tx_to, validAt, knownAt)`, applying: `security_type = ANY(securityTypes)`; `coupon_type = ANY(couponTypes)` (a bill's `coupon_type='zero'`); `maturity_date` between `maturityFrom ?? (validAt + yearsFrom years)` and `maturityTo ?? (validAt + yearsTo years)` when any is set; `coupon_rate` between `couponFrom`/`couponTo` (rows with `coupon_rate IS NULL` — bills — are kept only when both are null); `on_the_run` / `is_callable` per the `any|only|exclude` tri-state; `amount_outstanding >= minAmountOutstanding`; `cusip LIKE params.cusip || '%'`. It returns the page's rows, `counts`, the three `facets` computed over `afterFilters` (not over the page), and the `nextCursor`. `filters[]` records one entry per applied predicate with its `matched` count. `counts.excludedNoTerms` counts `instruments` rows with `asset_class='govt'` that have no current `govt_terms` row.
3. `provIdx` per row: `termsProvIdx = ctx.prov.add({ sourceId: row.sourceId /* 'treasury.bills' for bills, 'internal.user' for the curated notes/bonds seed */, provenanceId: row.provenanceId, capturedAt: row.capturedAt, sourceTs: row.sourceTs, st:'closed', tier:'eod' })`. `universe.provIdx` cites the same collector entry for the seed file.
4. **Pricing inputs** (2 DB round-trips): `cal = await ctx.data.reference.calendar('SIFMA')`; `settlement = params.settlement ?? addBusinessDays(valuationDate, 1, cal)` (§0 T+1); `pts = await ctx.data.curves.points(params.curveId, params.curveDate ?? valuationDate)`; `billPts = await ctx.data.curves.points('UST_BILL', pts.curveDate)` (bill rows price on the discount curve, as YAS does); `build = await ctx.data.curves.build(params.curveId, pts.curveDate, pts.defaultInterpolation)`; `ctx.engines.add(build.engine)`; `pricing.provIdx = ctx.prov.add({ sourceId: pts.sourceId, … st: pts.curveDate < valuationDate && olderThan5BusinessDays ? 'stale' : 'closed', tier:'eod' })`. `pts.curveDate < valuationDate` → note `CURVE_DATE_BEFORE_VALUATION`.
5. **Per-row analytics**, only for the rows on the current page (at most `pageSize` = 200), reusing the YAS engine calls verbatim so a row's number equals the YAS screen's number for the same settlement (ANAL-09, asserted by the cross-check test):
   - `note`/`bond`: `schedule = bondCashflows({ datedDate, firstCouponDate, maturityDate, couponRate, freq: couponFreq, dayCount, bdc: businessDayConv, calendar: cal, settlement })`; `YLD_YTM_MID = curveInterp.parYield(pts, daysToMaturity)`; `bondPrice.priceFromYield` → `PX_CLEAN_MID`, `PX_DIRTY_MID`, `ACCRUED`; `bondRisk.duration` → `DUR_ADJ_MID`; `bondRisk.dv01` on a face of 1,000,000 → `DV01`. `DISC_RATE`/`BEY` cells are `{ v:null, st:'na', provIdx:-1 }` (not applicable to a coupon security).
   - `bill`: `DISC_RATE` = the `UST_BILL` `discount_rate` point whose `instrumentId` equals the row, else linear interpolation in `tenorDays` (then `ctx.unavailable.add({ field:'rows.<cusip>.DISC_RATE', reason:'NO_SOURCE', detail:'bill not on the Treasury bill curve for <date>; discount rate interpolated' })`); `bill.priceFromDiscount` → `PX_CLEAN_MID` (= `PX_DIRTY_MID`, `ACCRUED = 0`), `bill.beyFromDiscount` → `BEY`, `YLD_YTM_MID = BEY` (the comparable measure), `DUR_ADJ_MID = t/365 / (1 + BEY/100 × t/365)`, `DV01` per the §0 bill rule.
   - `tips`/`frn`: terms columns are filled; every analytic column is `{ v:null, st:'na', r:'NOT_IN_UNIVERSE' }`, the row is counted in `counts.excludedNotPriced`, and note `TIPS_FRN_NOT_PRICED` is added once (same boundary as YAS).
6. **Sort and page.** Order by `params.sort.col` (`nulls last` in both directions) then `instrument_id` asc as the tiebreak; terms columns sort in the database (step 2), analytic columns sort in the resolver after step 5 over the filtered set — with 14 seeded securities this is one in-memory sort, and `data.govt.search` is called with `limit: counts.afterFilters` capped at 500 when `params.sort.col` is analytic (documented in the service contract). `ctx.page.set({ index, count: counts.afterFilters, cursor })` with `cursor = base64url(JSON.stringify({ v: <sort value of the last row on the page, or null>, id: <its instrumentId> }))` (§7.2 rule 7); **PAGE FWD** = the next `pageSize` securities further down the sort order (later maturities under the default sort), **PAGE BACK** re-encodes the cursor from the first row and inverts the comparison. `rank` is the 1-based position in the full sorted result, not in the page.
7. `notes` = `['NO_BOND_PRICE_SOURCE', 'SEED_UNIVERSE_ONLY']` always, plus `TIPS_FRN_NOT_PRICED` /
`CURVE_DATE_BEFORE_VALUATION` when triggered; `pricing.basis = 'curve_derived_no_market_quotes'`.
Budget: 4 DB round-trips (search, calendar, two curve reads; `curve_builds` is a 5th on a cache miss); per-row
compute < 0.3 ms; p95 < 200 ms warm for a 50-row page.

#### Live
`live(params, payload)` returns `null`. There is no Treasury security quote source in this build
(`md_lines` carries no `govt` line), so no cell can update; the curve behind the derived columns is a daily
object and is re-read by re-running the screen. The screen therefore registers no subjects and shows no
flash (TERM-08 does not apply). `rows[].subject` is carried only so `Ctrl+W` can add the selection to a
watchlist, where W subscribes it and gets the same honest `pending` state (TIER1 §0.4 rule 1).

#### Screen
```
┌ SRCH · US Treasuries · 14 securities · 9 match ─────────────────────────────────────────────────┐
│ badges#notes  [NO_BOND_PRICE_SOURCE] [SEED_UNIVERSE_ONLY] [TIPS_FRN_NOT_PRICED?] [STALE?]        │
│ split(col, [0.30, 0.70])                                                                         │
│ ┌ form#criteria ──────────────────────┐ ┌ grid#rows (virtualised, sortable) ──────────────────┐ │
│ │ Type    [x]bill [x]note [x]bond     │ │ # | CUSIP | Type | Term | Cpn % | Maturity | Yrs |   │ │
│ │         [ ]tips [ ]frn              │ │     Yld % | Mod dur | OTR                           │ │
│ │ Maturity 2026-09-15 → 2056-09-15    │ │ 1  912797VE4 bill 4WK    —   2026-09-29  0.04 3.74  │ │
│ │ Years    0 → 40                     │ │ 2  91282CLV6 note 2Y   3.750 2028-09-30  2.04 3.86  │ │
│ │ Coupon   0.00 → 25.00 %             │ │ 8  912810UF3 bond 30Y  4.750 2056-08-15 29.92 5.31  │ │
│ │ On-the-run [any|only|exclude]       │ │ (row tone 'highlight' when onTheRun)                 │ │
│ │ Callable   [any|only|exclude]       │ └──────────────────────────────────────────────────────┘ │
│ │ Min amt    —                        │ ┌ kv#pricing ──────────────────────────────────────────┐ │
│ │ CUSIP      —                        │ │ Basis curve-derived (no market quotes) · UST_PAR      │ │
│ └─────────────────────────────────────┘ │ 2026-09-14 · monotone_convex · settle 2026-09-16 T+1  │ │
│ facets#summary  type: bill 7 · note 5 · bond 2   maturity: 0-1Y 7 · 1-3Y 1 · 3-7Y 2 · 7-10Y 1 · │
│                 10-20Y 1 · 20Y+ 2     on-the-run: true 7 · false 7                               │
│ footer: sources ['U.S. Treasury bill auction results (public domain)',                           │
│         'U.S. Treasury par yield curve (public domain)', 'fixtures/seed/treasuries.json (curated)']│
│         · page 1-14 of 14 · asOf                                                                  │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```
Title `SRCH · US Treasuries · <counts.universe> securities · <counts.afterFilters> match`; subtitle
`curve UST_PAR 2026-09-14 · settlement 2026-09-16 · sorted by Maturity asc`. Column formats:
`CUSIP`/`SECURITY_TYP`/`TERM_LABEL`/`DAY_CNT_DES` `fmt:'text'`; `CPN`, `YLD_YTM_MID`, `DISC_RATE`, `BEY`
`fmt:'pct'` decimals 3 (`CPN` 3, yields 3); `MATURITY`/`ISSUE_DT` `fmt:'date'`; `MTY_YEARS` `fmt:'px'`
decimals 2; `PX_CLEAN_MID`/`PX_DIRTY_MID`/`ACCRUED` `fmt:'px'` decimals 6; `DUR_ADJ_MID` `fmt:'px'`
decimals 3; `DV01` `fmt:'ccy'` decimals 2; `AMT_OUTSTANDING` `fmt:'ccy'` decimals 0; `ON_THE_RUN` `fmt:'text'`
rendered as `Y`/`—`; `CPN_FREQ` `fmt:'int'`. `initialFocus:'rows'` (the form is reachable with `Tab`).
Skeleton while `payload === undefined`: the criteria form with the defaults filled and twelve muted grid
rows. `na` cells (a bill's `DUR_ADJ_MID` is real, its `ACCRUED` is `0`; a coupon bond's `DISC_RATE`) render
`—` in the muted tone with "not applicable to this security type" as the tooltip. `meta.unavailable` rows
render the affected cell as `—` with `detail` as the tooltip plus an amber badge in `badges#notes`;
`meta.entitlement` denials (`NO_FIRM_ENTITLEMENT` on `treasury.yieldcurve`) blank every analytic column and
leave the terms columns, with the reason in the tooltip and a footer line saying so (ENTL-05). A curve older
than five business days puts `st:'stale'` on the analytic cells and the `STALE` glyph on the screen
(TERM-12). Empty result: `text#empty` "No Treasury matches these terms" plus the `filters[]` list with each
predicate's `matched` count, so the user sees which criterion emptied the screen.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | form | `run-search` | submit the criteria form → `ctx.setParams({ …criteria })` (usage `fn.param`) |
| `Enter` | grid | `open-yas` | `ctx.navigate(row.key + ' YAS')` — price the selected security |
| `Shift+Enter` | grid | `open-yas-next` | `ctx.navigateNext(row.key + ' YAS')` |
| `D` | grid | `open-des` | `ctx.navigate(row.key + ' DES')` |
| `G` | grid | `open-gp` | `ctx.navigate(row.key + ' GP')` |
| `T` | always | `cycle-types` | cycle the `securityTypes` presets `bill,note,bond → bill → note,bond → all five` |
| `O` | always | `cycle-otr` | `onTheRun` → next of `any, only, exclude` |
| `M` | always | `maturity-prompt` | `ctx.prompt('date', { label:'Maturity from' })` then `('date', { label:'Maturity to' })` → `setParams({ maturityFrom, maturityTo })` |
| `C` | always | `cycle-curve` | `curveId` → the other of `UST_PAR, UST_CMT` |
| `S` | always | `settlement-prompt` | `ctx.prompt('date', { label:'Settlement', initial: payload.pricing.settlement })` → `setParams({ settlement })` |
| `X` | always | `clear-criteria` | reset every criterion to its default (`setParams(SrchCriteria.parse({}))`) |
| `,` / `.` | grid | `sort-prev-col` / `sort-next-col` | sort by the previous/next column, toggling `dir` when already sorted by it |
| `PageDown` / `PageUp` | grid | `page-fwd` / `page-back` | `POST /functions/SRCH/page { resultId, direction }` (FUNCTIONS.md §1.4.3) |
| `Ctrl+S` | always | `save-search` | `ctx.prompt('text', { label:'Search name' })` → `POST /saved-searches { kind:'srch', name, query: SrchCriteria.parse(params) }` (NEWS-07) |
| `Ctrl+W` | grid | `add-watchlist` | `ctx.prompt('watchlist')` then `sdk.watchlists.setItems` with the selected rows' `instrumentId` |

#### CSV
`filename = 'SRCH_' + market + '_' + asOf.replace(/[-:]/g,'') + '.csv'`. Wide format (FUNCTIONS.md §1.6: one
row per result row). `columns` is payload-dependent: the fixed prefix
`rank,key,cusip,securityType,termLabel,maturityDate,issueDate,couponRate,couponFreq,dayCount,onTheRun,isCallable,amountOutstanding`
followed by one column per `payload.columns[]` entry that is not already in the prefix (id as the column id,
`label` as the header, `type`/`decimals` from the column's `fmt`), then the trailing
`curveId,curveDate,settlement,pricingBasis,source`. `rows` = one per `payload.rows[]` of the **current page**
(export of a paged function exports the cached page — API.md §9), cell values taken from `cells[id].v`
(`null` → empty field, never `0`). Two `#` comment header lines precede the data: the attribution lines from
`meta.provenance` and `# pricing basis: curve_derived_no_market_quotes (no evaluated Treasury price source)`.
Example row: `5,T 4.25 08/15/36 Govt,91282CLM6,note,10Y,2036-08-15,2026-08-17,4.250,2,ACT/ACT,true,false,42000000000,4.9700,7.812,UST_PAR,2026-09-14,2026-09-16,curve_derived_no_market_quotes,treasury.yieldcurve`.

#### Help
summary `Search Treasuries by type, maturity, coupon and benchmark status`;
description `SRCH screens the Treasury universe by terms and conditions — security type, maturity window, coupon range, on-the-run status, callability, amount outstanding and CUSIP — and shows the matching securities with yields, prices, accrued and duration derived from the Treasury curve for the selected settlement date. There is no evaluated fixed-income pricing source in this build, so the analytic columns are curve-derived rather than market quotes and are labelled NO_BOND_PRICE_SOURCE; they use exactly the engines YAS uses, so a row equals the YAS screen for the same security and settlement. The universe is the seeded Treasury set (bills from the Treasury bill file and the on-the-run notes and bonds); corporates, munis and mortgages are out of scope in v1. Press Enter on a row for YAS, Ctrl+S to save the search.`;
params `securityTypes` ("bill, note, bond, tips, frn", `NOTE,BOND`), `maturityFrom`/`maturityTo` ("maturity window", `2028-01-01`), `yearsFrom`/`yearsTo` ("years to maturity window", `2..10`), `couponFrom`/`couponTo` ("coupon range in percent", `4`), `couponTypes` ("fixed, zero, float, step, inflation_linked"), `onTheRun` ("any, only or exclude benchmarks"), `callable` ("any, only or exclude callables"), `minAmountOutstanding` ("minimum amount outstanding", `50B`), `cusip` ("CUSIP or prefix", `912797`), `columns` ("columns to show"), `sort` ("column:direction", `YLD_YTM_MID:desc`), `pageSize` ("rows per page", `100`), `settlement` ("settlement date; default T+1 SIFMA"), `curveId` ("UST_PAR or UST_CMT"), `curveDate` ("curve date; default latest"), `savedSearchId` ("load a saved search");
sources `['treasury.bills', 'treasury.yieldcurve', 'fed.h15', 'internal.user', 'internal.derived']`;
related `['YAS', 'DES', 'CRVF', 'GC', 'BTMM']`.

#### Unavailable and reason codes
| Case | Behaviour |
| --- | --- |
| Always (every payload) | `pricing.basis='curve_derived_no_market_quotes'`, note `NO_BOND_PRICE_SOURCE`, amber badge "Yields and prices are derived from the Treasury curve; there is no evaluated bond price source in v1 (BRIEF §1, DATA-04)". No row is ever given a fabricated market price. |
| Always | note `SEED_UNIVERSE_ONLY`, badge "Universe = the seeded Treasury securities (7 bills from the Treasury bill file + 7 curated on-the-run notes/bonds); there is no full Treasury issuance file source in this build". `universe.coverage='SEED_UNIVERSE_ONLY'`. |
| Live data | `live()` returns `null`: `ctx.unavailable.add({ field:'rows.live', reason:'NO_SOURCE', detail:'no Treasury market-data line: neither Cboe nor Yahoo publishes Treasury security quotes (BRIEF §2)' })`; cells carry no `live` and the screen shows no flash |
| `tips`/`frn` rows in the result | analytic cells `{ v:null, st:'na', r:'NOT_IN_UNIVERSE' }`, note `TIPS_FRN_NOT_PRICED`, `{ field:'rows.<cusip>.analytics', reason:'NOT_APPLICABLE', detail:'TIPS/FRN pricing needs an inflation/reference-rate engine (same boundary as YAS)' }` |
| `market` other than `UST` | unreachable through the schema (`z.enum(['UST'])`); a request body carrying another value → `400 VALIDATION_FAILED { location:'fnParams', field:'market' }`, and the help text states corporates/munis/mortgages are out of scope |
| Bill not on the bill curve for the date | `{ field:'rows.<cusip>.DISC_RATE', reason:'NO_SOURCE', detail:'bill not on the Treasury bill curve for <date>; discount rate interpolated' }`; the cell keeps its interpolated value with the detail as tooltip |
| No curve on or before the valuation date | no `503`: `{ field:'pricing', reason:'NO_SOURCE', detail:'no <curveId> curve on or before <date>' }`; every analytic cell `{ v:null, st:'blank', r:'PROVIDER_DOWN' }`; terms columns, filters, counts and facets are still returned — the screen remains a usable terms search |
| Curve older than 5 business days | analytic cells `st:'stale'`, `meta.staleness:'stale'`, footer `CURVE_DATE <date>` (TERM-12) |
| Curve date before the valuation date | note `CURVE_DATE_BEFORE_VALUATION`, info badge with both dates |
| Saved search missing or not owned | `{ field:'savedSearch', reason:'NO_SOURCE', detail:'saved search not found or not owned by this user' }`, the screen runs with the explicit params |
| Empty result | `rows: []`, `counts.afterFilters = 0`, `text#empty` with the `filters[]` breakdown; **not** an error |
| Entitlement | `meta.entitlement[]` per denied field; `NO_FIRM_ENTITLEMENT` on `treasury.yieldcurve` blanks every analytic column (terms columns are `treasury.bills`/`internal.user` and survive); `TIER_EOD` never applies — every source here is `eod` (ENTL-05) |

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared); `pageable === true` with a `page` handler; every optional param has `.default()` |
| golden payload | `packages/server/test/integration/functions/SRCH.golden.test.ts` | the default search at the frozen clock over the 14 seeded Treasuries deep-equals `SRCH.default.json` (rows, counts, facets, notes); a second case `{ securityTypes:['bill'], onTheRun:'only' }` equals `SRCH.default.bills.json` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `SRCH.default.csv`; every numeric cell equals `cells[id].v`; the two `#` header lines are present |
| parity | `packages/server/test/parity/fn-parity.test.ts` | shared (API-05); `live()` is `null` so the WS leg of the parity check is skipped for this code (the test asserts the manifest declares no subjects) |
| screen | `packages/web/test/screens/SRCH.test.tsx` | grid renders every golden row; `Enter` navigates to `YAS`; `T`/`O`/`C` cycle params via `setParams`; `,`/`.` re-sort; `Ctrl+S` posts a `kind:'srch'` saved search; both permanent badges present; skeleton renders with `payload undefined` |
| YAS cross-check | `packages/server/test/integration/functions/SRCH.yasParity.test.ts` | for every seeded note/bond, the row's `YLD_YTM_MID`, `PX_CLEAN_MID`, `ACCRUED`, `DUR_ADJ_MID` and `DV01` equal the YAS payload for the same security, settlement and curve to 1e-9 (ANAL-09, QA-01) |
| filters | `packages/server/test/integration/functions/SRCH.filters.test.ts` | `yearsFrom/yearsTo` and `maturityFrom/maturityTo` select the same rows for equivalent windows; `couponFrom` set excludes bills; `onTheRun:'only'` returns 7 rows; `cusip:'912797'` returns the 7 bills; `filters[].matched` counts match the row counts |
| PIT terms | `packages/server/test/integration/functions/SRCH.pit.test.ts` | after `upsertVersion` flips `on_the_run` on the 10Y note, a `knownAt` before the change still returns the old benchmark set (REF-03, REF-04) |
| paging | `packages/server/test/integration/functions/SRCH.page.test.ts` | `pageSize:5` yields three pages; `PAGE FWD` then `PAGE BACK` returns the first page's rows in the same order; the cursor decodes to `{v,id}` of the boundary row; `rank` is global, not per page |
| no curve | `packages/server/test/integration/functions/SRCH.nocurve.test.ts` | with the `UST_PAR` points deleted, terms columns and facets still return, analytic cells are `st:'blank'`, one `meta.unavailable` entry, status 200 |
| e2e | `packages/e2e/tests/rates.spec.ts` | `SRCH NOTE,BOND MTY_YEARS=5..30 <GO>` lists the matching notes, `Enter` on the 10Y row opens `YAS` with the same yield on screen, `Ctrl+S` saves the search and re-running it from `SAVED=` reproduces the rows |

---

---

### GC — Benchmark Curve Chart

| Attribute | Value |
| --- | --- |
| Code / aliases | `GC` / `GCRV` |
| Tier / category | 3 / charting (custom) |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `custom` (`CurveChart`) |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/GC.ts` · `packages/server/src/functions/GC/resolve.ts` · `packages/web/src/screens/GC/Screen.tsx` · `fixtures/golden/functions/GC.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-03) (FUNC-04) (ANAL-02) (ANAL-08) (ANAL-09) (DATA-07) (DATA-10) (REF-06) (TERM-06) (TERM-12) (ENTL-05) (QA-01) (CHRT-01) (CHRT-03) |

GC is the *time* view of the curves CRVF constructs: `mode:'curve'` draws the benchmark curve on the
valuation date plus up to four earlier dates with a basis-point change table (CHRT-03), `mode:'history'`
draws selected tenors and tenor spreads as daily series over a range (CHRT-01). It never bootstraps a
curve of its own — it reads the same `curve_points` / `curve_builds` rows and the same
`data.curves.build` cache as CRVF (ANAL-08), and for long history it reads stored `econ_observations`
rather than inventing points between stored curve dates. `SOFR_FIX` is **not** offered (it has no term
structure — `FIXING_ONLY_NO_TERM_STRUCTURE`, §0 / CRVF); `SOFR_OIS` carries the `PROXY_CURVE` badge (§0).

#### Params
```ts
export const GcParams = z.object({
  curveId: z.enum(['UST_PAR', 'UST_CMT', 'UST_BILL', 'SOFR_OIS']).default('UST_PAR'),
  mode: z.enum(['curve', 'history']).default('curve'),
  date: z.iso.date().nullable().default(null),                       // null = latest stored curve_date ≤ validAt
  compare: z.array(z.union([z.iso.date(), z.enum(['PREV', '1W', '1M', '3M', 'YTD', '1Y'])])).max(4).default(['PREV', '1W', '1M']),
  tenors: z.array(z.enum(['1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '20Y', '30Y'])).min(1).max(6).default(['2Y', '10Y', '30Y']),
  range: z.enum(['1M', '3M', '6M', '1Y', '5Y', 'MAX']).default('1Y'),   // history mode only
  spreads: z.array(z.enum(['2s10s', '5s30s', '3M10Y'])).max(3).default(['2s10s']),
  view: z.enum(['both', 'chart', 'table']).default('both'),
});
```
#### Argument grammar
`positional [{ name:'curveId', type:'curve', optional:true }, { name:'date', type:'date', optional:true }]`,
`keyed { CMP: { name:'compare', type:'string' } /* repeatable: date or PREV|1W|1M|3M|YTD|1Y, appends */, TNR: { name:'tenors', type:'string' } /* comma-separated, replaces */, R: { name:'range', type:'enum', values:['1M','3M','6M','1Y','5Y','MAX'] }, SPD: { name:'spreads', type:'string' }, MODE: { name:'mode', type:'enum', values:['curve','history'] } }`, no `rest`.
Examples: `GC` → `{ curveId:'UST_PAR', mode:'curve', date:null, compare:['PREV','1W','1M'], … }` · `GC UST_CMT 2026-09-11 CMP=2026-09-08` → `{ curveId:'UST_CMT', date:'2026-09-11', compare:['2026-09-08'] }` · `GC MODE=HISTORY TNR=2Y,10Y R=5Y SPD=2s10s` → `{ mode:'history', tenors:['2Y','10Y'], range:'5Y', spreads:['2s10s'] }`.

#### Payload
```ts
export type GcPayload = {
  variant: 'default';
  mode: 'curve' | 'history';
  curve: { id: 'UST_PAR' | 'UST_CMT' | 'UST_BILL' | 'SOFR_OIS'; name: string; currency: string; kind: CurvePoints['kind'];
           dayCount: string; compounding: string; sourceId: string; provIdx: number;
           date: string; requestedDate: string | null; availableDates: string[] /* ≤ 400, desc */ };
  snapshots: Array<{ id: string /* 'CUR' | 'PREV' | '1W' | … | 'D:2026-09-08' */; label: string /* '09-14' */; requested: string;
                     date: string; buildId: number | null; provIdx: number;
                     points: Array<{ tenor: string; tenorDays: number; quoteType: CurvePoints['points'][number]['quoteType']; value: ValueCell }> }>;
  changes: Array<{ tenor: string; tenorDays: number; current: ValueCell;
                   vs: Array<{ id: string; label: string; date: string; bp: ValueCell }> }>;                 // (current − snapshot) × 100
  spreads: Array<{ id: '2s10s' | '5s30s' | '3M10Y'; label: string; legs: [string, string]; current: ValueCell;
                   vs: Array<{ id: string; label: string; date: string; bp: ValueCell }> }>;
  history: {
    range: '1M' | '3M' | '6M' | '1Y' | '5Y' | 'MAX'; from: string; to: string;
    series: Array<{ tenor: string; source: 'econ_series' | 'curve_points' | 'rate_fixings'; seriesCode: string | null; sourceId: string;
                    provIdx: number; unit: 'pct'; obs: Array<{ d: string; v: number | null }>;
                    coverage: { first: string | null; last: string | null; n: number }; truncated: boolean }>;
    spreadSeries: Array<{ id: string; label: string; legs: [string, string]; unit: 'bp'; obs: Array<{ d: string; v: number | null }> }>;
  } | null;                                                                                                   // null when mode === 'curve'
  caveats: Array<'PROXY_CURVE' | 'CURVE_DATES_ONLY' | 'NO_LONG_HISTORY_FOR_TENOR'>;
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `curves`, `curve_points` (`is_latest`, `vintage_at ≤ ctx.asOf.knownAt`, `curve_date ≤ validAt`), `curve_builds` (cache only), `econ_series`, `econ_observations` (`is_latest`, `vintage_at ≤ knownAt` — DGS10 and the 11 `H15_*` CMT series, DATA_MODEL §18 seed rows 6–7 and 11), `rate_fixings` (`SOFR` for the `SOFR_OIS` ON tenor), `govt_terms` + `instruments` (on-the-run key behind a tenor row, for `Y`) |
| Data services (§1.4.2) | `data.curves.points(curveId, date)`, `data.curves.build(curveId, date, interpolation)`, `data.econ.series(code)`, `data.econ.observations(code, { from, to, knownAt })`, `data.rates.history('SOFR', days)`, `data.reference.instrument` |
| Read-through (`providers.ensure`) | None. The Treasury XML endpoint takes ≈ 18 s (BRIEF §2) and H.15/FRED are daily files; `treasuryCurves.ts`, `fedRates.ts` and `econSeries.ts` (ARCHITECTURE §7.1) keep the tables fresh. A missing date degrades (below), never blocks. |
| Engines (`core/analytics`) | `curve/interp@1.0.0` (tenor points already stored; used only when a compare date's build is read back), `curve/bootstrap@1.0.0` (only when `curve_builds` misses for a compare date) |
| Subjects (live) | `c:<curveId>` — notification only (§0 `CURVE_UPDATED`) |
| Field ids (`fieldIds(assetClass)`) | `default: [CRV_1M, CRV_3M, CRV_6M, CRV_1Y, CRV_2Y, CRV_3Y, CRV_5Y, CRV_7Y, CRV_10Y, CRV_20Y, CRV_30Y, CURVE_PAR, ECO_VALUE, ECO_PERIOD, ECO_VINTAGE, SPREAD]` |

Tenor → history series map (`packages/server/src/functions/GC/seriesMap.ts`, seeded by `seed/rates.ts` and `seed/news.ts`):

| curve | tenor | series (`econ_series.series_code`) | provider code | source_id | seeded coverage |
| --- | --- | --- | --- | --- | --- |
| `UST_PAR`, `UST_CMT` | `10Y` | `DGS10` | `DGS10` | `fred.csv` | 16,881 daily observations (`fred-DGS10.csv`) — the only long history in the offline seed |
| `UST_PAR`, `UST_CMT` | `1M 3M 6M 1Y 2Y 3Y 5Y 7Y 20Y 30Y` | `H15_RIFLGFCM01 / M03 / M06 / Y01 / Y02 / Y03 / Y05 / Y07 / Y20 / Y30` | `RIFLGFC*_N.B` | `fed.h15` | 4 dates (2026-09-08 … 09-11; 09-07 is `ND`) → `truncated:true` |
| `UST_BILL` | every tenor | — | — | `treasury.bills` | `curve_points` only, 9 dates → caveat `CURVE_DATES_ONLY` |
| `SOFR_OIS` | `ON` | `SOFR` (`rate_fixings`) | `SOFR` | `nyfed.rates` | 5 fixings (09-08 … 09-14) |
| `SOFR_OIS` | `1M 3M 6M 1Y 2Y …` | — | — | `internal.derived` | `curve_points` only (proxy inputs, §0/CRVF) → caveats `PROXY_CURVE`, `CURVE_DATES_ONLY` |

#### Resolver
1. `valuationDate` = ISO date of `ctx.asOf.validAt` in `America/New_York` (2026-09-15). `pts = await ctx.data.curves.points(params.curveId, params.date ?? valuationDate)`; an explicit `params.date` with no `curve_date ≤ date` → `422 VALIDATION_FAILED { location:'fnParams', field:'date', detail:'no <curveId> curve on or before <date>' }`; `null` → latest served date (`2026-09-14` for `UST_PAR`/`UST_BILL`, `2026-09-11` for `UST_CMT`, §0). `provIdx_cur = ctx.prov.add({ sourceId: pts.sourceId, provenanceId: pts.points[0].provenanceId, capturedAt, sourceTs, st:'closed', tier:'eod' })` (DATA-10).
2. `curve = { …pts metadata, date: pts.curveDate, requestedDate: params.date, availableDates: pts.availableDates }`. `pts.curveDate` older than 5 business days on the `SIFMA` calendar (`data.reference.calendar('SIFMA')`, REF-06) → every `ValueCell` in the payload gets `st:'stale'` and `meta.staleness:'stale'` (TERM-12).
3. **`mode:'curve'`** — resolve each `params.compare` entry against `curve.availableDates`: a literal date → the latest stored date `≤` it; `PREV` → the next date before `curve.date`; `1W|1M|3M|1Y` → the latest date `≤ curve.date − period`; `YTD` → the latest date `≤ 31 Dec of the previous year`. An entry that resolves to nothing, or to a date already used, is dropped with `ctx.unavailable.add({ field:'compare.<entry>', reason:'NO_SOURCE', detail:'no <curveId> curve on or before <target>; earliest stored <availableDates.at(-1)>' })`; when at least one entry is dropped for that reason the payload gains caveat `CURVE_DATES_ONLY`. One `data.curves.points(curveId, resolvedDate)` per surviving entry, each with its own `ctx.prov.add` idx.
4. `snapshots[0]` is the current date (`id:'CUR'`), then one per surviving compare entry in `params.compare` order. Each point is `{ v: point.value, st: 'closed' (or 'stale' per step 2), provIdx, ts: point.sourceTs ? Date.parse(point.sourceTs) : null }`; `buildId` is `(await ctx.data.curves.build(curveId, date, pts.defaultInterpolation)).buildId` when a build exists in `curve_builds`, else `null` (GC never triggers a bootstrap for a compare date — a miss leaves `buildId:null` and the row is still drawn from the published points).
5. `changes[]`: for every tenor present in `snapshots[0]`, `bp = (current.v − snapshot.v) × 100`, `{ v:null, st:'na', r:'OK' }` when the tenor is absent from that snapshot (H.15 `ND` days, a bill tenor that was not auctioned). `spreads[]`: `2s10s = 10Y − 2Y`, `5s30s = 30Y − 5Y`, `3M10Y = 10Y − 3M`, each in bp, with the same `vs[]` shape; a missing leg → `{ v:null, st:'na', r:'OK' }` and `ctx.unavailable.add({ field:'spreads.<id>', reason:'NO_SOURCE', detail:'<leg> not on the <curveId> curve for <date>' })`.
6. **`mode:'history'`** — `to = curve.date`, `from = to − range` (`MAX` → the series' `first_obs_date`). For each tenor in `params.tenors` take the map above: `econ_series` → `data.econ.series(code)` then `data.econ.observations(code, { from, to, knownAt: ctx.asOf.knownAt })` (STOR-06 vintages); `rate_fixings` → `data.rates.history('SOFR', days)`; otherwise read the tenor's `curve_points` across `curve.availableDates` (one query, `curve_id = … AND tenor = ANY(tenors) AND curve_date BETWEEN from AND to`). `coverage.first > from` → `truncated:true`, `ctx.unavailable.add({ field:'history.<tenor>', reason:'NO_SOURCE', detail:'<seriesCode> stored from <first>; requested from <from>' })` and caveat `NO_LONG_HISTORY_FOR_TENOR`; a tenor with **no** series at all → the series is returned with `obs: []`, `coverage:{ first:null, last:null, n:0 }` and the same unavailable entry — the chart draws nothing for it and the legend shows the reason (never an interpolated or carried-forward value, §1.3 rule 6).
7. `spreadSeries[]` are computed on the **date intersection** of the two legs' observations (`v = (long − short) × 100` bp); a date present in only one leg is skipped, not filled.
8. `caveats`: `PROXY_CURVE` whenever `curveId === 'SOFR_OIS'` (§0), plus whatever steps 3 and 6 added. Return `{ variant:'default', mode, curve, snapshots, changes, spreads, history, caveats }`; `meta.engines` is empty for the common path (no bootstrap runs) and carries `curve/bootstrap@1.0.0` only when step 4 built a missing compare build.
Budget: `mode:'curve'` 2 + n DB round-trips (n = compare dates, ≤ 4); `mode:'history'` 1 + t (t = tenors, ≤ 6) plus one calendar read; no provider calls; p95 < 150 ms warm.

#### Live
`{ subjects: ['c:' + params.curveId], fields: '*', conflationMs: 1000 }`. No cell carries `Cell.live` (a curve is a daily object): the shell compares the `c:` delta's `BUILD_ID`/`CURVE_DATE` with `payload.snapshots[0].buildId`/`payload.curve.date` and raises the `CURVE_UPDATED` badge (§0); `Enter` on the chart re-runs with `launchKind:'param'` (`details.changed:['curve']`).

#### Screen
```
┌ GC · UST_PAR · U.S. Treasury par yield curve · 2026-09-14 ──────────────────────────────────────┐
│ badges#caveats  [CURVE_DATES_ONLY] [PROXY_CURVE (SOFR_OIS)] [CURVE_UPDATED] [STALE]              │
│ split(col, [0.58, 0.42])                                                                          │
│ custom#chart  CurveChart  — ChartSpec below (mode 'curve' or 'history')                           │
│ ┌ mode 'curve' ───────────────────────────────────────────────────────────────────────────────┐  │
│ │ grid#changes  tenor | days | 09-14 (pct 3dp) | 09-11 | Δbp | 09-08 | Δbp | 09-01 | Δbp        │  │
│ │ table#spreads 2s10s  +58.0 bp | Δ vs 09-11 −1.0 | Δ vs 09-08 +2.0                             │  │
│ └───────────────────────────────────────────────────────────────────────────────────────────────┘  │
│ ┌ mode 'history' ─────────────────────────────────────────────────────────────────────────────┐  │
│ │ grid#series   tenor | source | series | first | last | n | last value (pct) | Δ range (bp)    │  │
│ │ text#gaps     "H15_RIFLGFCY02 stored from 2026-09-08; requested from 2025-09-15" (tone warn)  │  │
│ └───────────────────────────────────────────────────────────────────────────────────────────────┘  │
│ footer: sources [attribution of curve.sourceId, 'FRED (public domain)' in history] asOf curve.date │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```
`ChartSpec` (§1.5, CHRT-01/03), built by `packages/web/src/screens/GC/chartSpec.ts`:
- `mode:'curve'` → `{ kind:'curve', xAxis:{ type:'tenor' }, yAxes:[{ id:'y', side:'left', scale:'linear', fmt:'pct', decimals:3 }], panes:[{ id:'main', height:1 }], series: snapshots.map((s,i) => ({ id:s.id, label:s.label, type:'line', pane:'main', yAxis:'y', x: s.points.map(p => p.tenorDays), y: s.points.map(p => p.value.v), provIdx: s.provIdx, style:{ color: i === 0 ? 'auto' : 'neutral', dashed: i > 0 } })) concat one `scatter` series `inputs` over `snapshots[0]` (per-point `provIdx` for `Ctrl+I`), crosshair:true, reference: [] }`.
- `mode:'history'` → `{ kind:'price', xAxis:{ type:'time', tz:'America/New_York', calendarId:'SIFMA' }, yAxes:[{ id:'y', side:'left', scale:'linear', fmt:'pct', decimals:3 }, { id:'bp', side:'right', scale:'linear', fmt:'bp', decimals:1 }], panes:[{ id:'main', height:0.7 }, { id:'spread', height:0.3, title:'Spread (bp)' }], series: one `line` per `history.series[]` (`x` = epoch ms of `obs[].d` at 00:00 ET, `y` = `obs[].v`, `NaN` for gaps — §1.5 "NaN = gap", never interpolated) plus one `line` per `history.spreadSeries[]` on pane `spread`/axis `bp`, crosshair:true }`.
Title `GC · <curveId> · <curve.name> · <curve.date>` (history: `… · <range> to <curve.date>`); subtitle `compare 09-11, 09-08, 09-01 · <kind> · <dayCount> <compounding>`. `initialFocus:'chart'`; `view` drives `split.sizes` (`chart` → `[1,0]`, `table` → `[0,1]`). Skeleton (`payload === undefined`): empty chart frame plus 11 muted tenor rows. `meta.unavailable` rows render the affected cell as `—` with `detail` as the tooltip and add an amber badge; `meta.entitlement` denials on `treasury.yieldcurve`/`fed.h15`/`fred.csv` (`NO_FIRM_ENTITLEMENT`) blank the affected snapshot's cells and drop its chart series, with the reason in the legend (ENTL-05).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `M` | always | `cycle-mode` | `ctx.setParams({ mode: mode === 'curve' ? 'history' : 'curve' })` |
| `K` | always | `cycle-curve` | `curveId` → next of `UST_PAR, UST_CMT, UST_BILL, SOFR_OIS` |
| `D` | always | `date-prompt` | `ctx.prompt('date', { label:'Curve date', initial: curve.date })` → `setParams({ date })` |
| `ArrowLeft` / `ArrowRight` | chart | `prev-date` / `next-date` | step through `curve.availableDates` → `setParams({ date })` |
| `C` | always | `add-compare` | `ctx.prompt('text', { label:'Compare (date or PREV/1W/1M/3M/YTD/1Y)' })` → append (max 4; the 5th replaces the oldest) |
| `X` | always | `clear-compare` | `setParams({ compare: [] })` |
| `R` | always | `cycle-range` | `1M → 3M → 6M → 1Y → 5Y → MAX` (history mode) |
| `T` | always | `tenor-prompt` | `ctx.prompt('text', { label:'Tenors', initial: tenors.join(',') })` → `setParams({ tenors })` |
| `S` | always | `cycle-spreads` | `['2s10s'] → ['5s30s'] → ['3M10Y'] → all three → []` |
| `V` | always | `cycle-view` | `both → chart → table` |
| `Enter` | grid | `row-provenance` | `ctx.provenance(row.provIdx)` for the focused snapshot column |
| `Shift+Enter` | grid | `open-yas-next` | tenor rows with an on-the-run `instrument`: `ctx.navigateNext(instrument.key + ' YAS')` |
| `B` | always | `open-crvf` | `ctx.navigate('CRVF ' + curveId + ' ' + curve.date)` (build detail) |
| `F` | always | `open-fed` | `ctx.navigate('FED')` |

#### CSV
`filename = 'GC_' + curveId + '_' + mode + '_' + curve.date.replace(/-/g,'') + '.csv'`. Long format (§1.6 rule 3 — several blocks): columns `section,label,date,tenor,days,value,unit,source`; rows, in order: one per `snapshots[].points[]` (`section='snapshot'`, `label = snapshot.label`, `unit='pct'`, `source = curve.sourceId`), one per `changes[].vs[]` (`section='change'`, `unit='bp'`, `source='internal.derived'`), one per `spreads[]` current and `vs[]` (`section='spread'`, `tenor = spread.id`, `days` empty), then in history mode one per `history.series[].obs[]` (`section='history'`, `label = tenor`, `date = obs.d`, `unit='pct'`, `source = series.sourceId`) and one per `spreadSeries[].obs[]` (`section='history_spread'`, `unit='bp'`). `null` values are emitted empty (§1.6 rule 2). Example row: `snapshot,09-14,2026-09-14,10Y,3652,4.97,pct,treasury.yieldcurve`.

#### Help
summary `Benchmark Treasury/CMT/SOFR curve across dates, with tenor history`; description `GC plots a stored benchmark curve for one date against up to four earlier dates and tabulates the basis-point change at every tenor, or switches to history mode and plots selected tenors and tenor spreads (2s10s, 5s30s, 3M10Y) as daily series. The offline build stores nine Treasury curve dates, so relative comparisons such as 1M or YTD resolve to the earliest stored date and say so; long tenor history comes from the stored FRED and H.15 series, and any tenor without a stored series is left blank with a reason rather than interpolated. Use CRVF for how a curve is built, YAS to price the on-the-run issue at a tenor, and FED for the policy rates underneath the front end.`; params `curveId` ("UST_PAR, UST_CMT, UST_BILL or SOFR_OIS", `UST_CMT`), `mode` ("curve or history"), `date` ("curve date; default latest", `2026-09-11`), `compare` ("dates or PREV/1W/1M/3M/YTD/1Y", `PREV`), `tenors` ("history tenors", `2Y,10Y,30Y`), `range` ("history range", `5Y`), `spreads` ("2s10s, 5s30s, 3M10Y"), `view` ("both, chart or table"); sources `['treasury.yieldcurve', 'treasury.bills', 'fed.h15', 'nyfed.rates', 'fred.csv', 'internal.derived']`; related `['CRVF', 'YAS', 'FED', 'BTMM', 'WIRP']`.

#### Unavailable and reason codes
| Case | `meta.unavailable` / footer |
| --- | --- |
| Compare entry resolves to no stored curve | `{ field:'compare.<entry>', reason:'NO_SOURCE', detail:'no <curveId> curve on or before <target>; earliest stored <date>' }`; entry dropped; footer badge `CURVE_DATES_ONLY` ("only 9 stored curve dates in this build") |
| Tenor missing from a snapshot (H.15 `ND`, unauctioned bill tenor) | cell `{ v:null, st:'na' }`; no fabricated value; the change column is blank |
| History tenor with no stored series | `{ field:'history.<tenor>', reason:'NO_SOURCE', detail:'no stored series for <curveId> <tenor>' }`, `obs: []`, footer badge `NO_LONG_HISTORY_FOR_TENOR` |
| History series shorter than the range | `{ field:'history.<tenor>', reason:'NO_SOURCE', detail:'<seriesCode> stored from <first>; requested from <from>' }`, `truncated:true`, chart starts at `coverage.first` |
| Spread leg missing | `{ field:'spreads.<id>', reason:'NO_SOURCE', detail:'<leg> not on the <curveId> curve for <date>' }` |
| `SOFR_OIS` selected | caveat `PROXY_CURVE` (§0, CRVF): term points are proxied, no OIS swap or futures source (BRIEF §2) |
| `SOFR_FIX` typed | `400 VALIDATION_FAILED { location:'fnParams', field:'curveId' }` with message `SOFR_FIX has no term structure; use CRVF SOFR_FIX` |
| Curve older than 5 SIFMA business days | all cells `st:'stale'`, `meta.staleness:'stale'`, footer `CURVE_DATE <date>` (TERM-12) |
| Entitlement | `meta.entitlement[]` per denied field (`NO_FIRM_ENTITLEMENT`); the snapshot's cells blank and its chart series is dropped, footer notes "1 series hidden" (ENTL-05) |

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared); `GCRV` alias has no `aliasParams` |
| golden payload | `packages/server/test/integration/functions/GC.golden.test.ts` | `GC` at the frozen clock equals `GC.default.json` (UST_PAR 2026-09-14 vs 09-11/09-08/09-01, 2s10s = 10Y − 2Y); `GC MODE=HISTORY TNR=10Y R=5Y` equals `GC.default.history.json` with `series[0].seriesCode === 'DGS10'` and `n > 1200` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `GC.default.csv`; every numeric cell equals the payload value |
| parity | `packages/server/test/parity/fn-parity.test.ts` | shared (API-05); `c:UST_PAR` snapshot `RATES` equals `snapshots[0].points[].value.v` |
| screen | `packages/web/test/screens/GC.test.tsx` | curve mode builds one series per snapshot (first solid, rest dashed) and a scatter of inputs; history mode builds a time-axis spec with a spread pane; `M`, `K`, `R`, `V` call `setParams`; skeleton renders 11 muted rows |
| degraded compare | `packages/server/test/integration/functions/GC.compare.test.ts` | `compare:['YTD','1Y']` → both dropped, two `meta.unavailable` entries, caveat `CURVE_DATES_ONLY`, HTTP 200 |
| history gaps | `packages/server/test/integration/functions/GC.history.test.ts` | `tenors:['2Y','10Y']`, `range:'1Y'` → `2Y` truncated to the four H.15 dates with an unavailable entry; `10Y` full from `DGS10`; no observation is interpolated (`obs[].d` strictly increasing, gaps absent, not filled) |
| spread arithmetic | `packages/core/test/analytics/curve.spreads.test.ts` | `2s10s` at 2026-09-14 equals `(par10Y − par2Y) × 100` from `fixtures/golden/analytics/curve/UST_PAR-2026-09-14.json` (ANAL-09) |
| e2e | `packages/e2e/tests/rates.spec.ts` | `GC UST_CMT <GO>` draws four dated series; `M` switches to history and the 10Y series covers five years; PRINT yields a CSV whose `snapshot` rows equal the screen values |

---

### FED — Fed Monitor

| Attribute | Value |
| --- | --- |
| Code / aliases | `FED` / `FOMC` (`aliasParams { FOMC: { view:'calendar' } }`) |
| Tier / category | 3 / monitor |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/FED.ts` · `packages/server/src/functions/FED/resolve.ts` · `packages/web/src/screens/FED/Screen.tsx` · `fixtures/golden/functions/FED.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-03) (FUNC-04) (DATA-07) (DATA-10) (NEWS-01) (NEWS-02) (ANAL-02) (ANAL-08) (REF-06) (TERM-06) (TERM-08) (TERM-12) (ENTL-05) (QA-01) |

FED is the policy page: the target range and the overnight complex from the NY Fed, the H.15 constant-maturity
grid, the FOMC calendar with the implied overnight rate at each meeting taken from the `SOFR_OIS` curve, and
the Federal Reserve press feed. Three things Bloomberg's FED shows have **no reachable source** in this build
and are rendered blank with a reason, never derived: IORB and the primary-credit (discount) rate (not in the
NY Fed API and not in the H.15 slice we fetch), the balance sheet (H.4.1 is not among the verified endpoints,
BRIEF §2), and market-implied hike/cut *probabilities* (no fed-funds futures source — §0 `NO_FUTURES_SOURCE`).

#### Params
```ts
export const FedParams = z.object({
  view: z.enum(['rates', 'calendar', 'press']).default('rates'),
  histDays: z.number().int().min(1).max(60).default(10),      // overnight-rate history rows
  meetings: z.number().int().min(1).max(8).default(8),        // FOMC rows (past + scheduled)
  pressLimit: z.number().int().min(1).max(50).default(20),
  category: z.enum(['all', 'monetary', 'banking', 'other']).default('all'),
  path: z.boolean().default(true),                            // compute the implied overnight path
});
```
#### Argument grammar
`positional [{ name:'view', type:'enum', values:['rates','calendar','press'], optional:true }]`, `keyed { N: { name:'histDays', type:'number' }, MTG: { name:'meetings', type:'number' }, CAT: { name:'category', type:'enum', values:['all','monetary','banking','other'] }, PATH: { name:'path', type:'boolean' } }`, no `rest`.
Examples: `FED` → `{ view:'rates', histDays:10, meetings:8, pressLimit:20, category:'all', path:true }` · `FOMC` → alias params `{ view:'calendar' }` · `FED PRESS CAT=MONETARY` → `{ view:'press', category:'monetary' }`.

#### Payload
```ts
export type FedPayload = {
  variant: 'default';
  asOfDate: string;                                            // valuation date, America/New_York
  policy: { targetFrom: ValueCell; targetTo: ValueCell; effectiveDate: string;
            lastChange: { meetingDate: string; decisionBp: number } | null;
            nextMeeting: { meetingDate: string; statementAt: string | null; hasSep: boolean; businessDaysAway: number } | null;
            iorb: ValueCell; discountPrimary: ValueCell;        // always { v:null, st:'na', r:'NO_SOURCE_FIELD' } — see reason codes
            provIdx: number };
  rates: Array<{ rateCode: 'EFFR' | 'SOFR' | 'OBFR' | 'TGCR' | 'BGCR'; name: string; instrumentId: number | null; subject: string | null;
                 effectiveDate: string; rate: ValueCell; p1: ValueCell; p25: ValueCell; p75: ValueCell; p99: ValueCell;
                 volumeBn: ValueCell; chg1dBp: ValueCell; spreadToMidBp: ValueCell; provIdx: number }>;   // spread to the target-range midpoint
  sofrAverages: { effectiveDate: string; avg30d: ValueCell; avg90d: ValueCell; avg180d: ValueCell; indexValue: ValueCell; provIdx: number };
  history: Array<{ date: string; effr: number | null; sofr: number | null; obfr: number | null; tgcr: number | null; bgcr: number | null;
                   targetFrom: number | null; targetTo: number | null }>;                                  // newest first, ≤ histDays
  h15: { curveDate: string; priorDate: string | null; provIdx: number;
         rows: Array<{ tenor: string; tenorDays: number; yieldPct: ValueCell; chg1dBp: ValueCell }> };
  meetings: Array<{ meetingDate: string; statementAt: string | null; hasSep: boolean; isPast: boolean; isNext: boolean;
                    decisionBp: number | null; impliedRatePct: ValueCell; impliedMoveBp: ValueCell; cumulativeMoveBp: ValueCell;
                    hikeProbPct: null; cutProbPct: null; provIdx: number }>;                               // probabilities: NO_FUTURES_SOURCE
  path: { engine: { name: 'wirp/policyPath'; version: string; inputsHash: string }; curveId: 'SOFR_OIS'; curveDate: string;
          buildId: number; spotRatePct: ValueCell; caveats: Array<'PROXY_CURVE' | 'NO_FUTURES_SOURCE'> } | null;
  balanceSheet: null;                                                                                       // H.4.1 not reachable (BRIEF §2)
  press: Array<{ newsId: number; headline: string; summary: string | null; category: string | null; publishedAt: string;
                 url: string; kind: 'press_release' | 'fed_release'; isCorrection: boolean; provIdx: number }>;
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `rate_fixings` (`EFFR, SOFR, OBFR, TGCR, BGCR, SOFRAI`; `is_latest`, `vintage_at ≤ knownAt`), `instruments` + `rate_terms` + `md_lines` (`nyfed.rates` lines for the 6 rate instruments, DATA_MODEL §18 seed row 6), `fomc_meetings`, `curve_points` + `curve_builds` (`SOFR_OIS`), `econ_series` + `econ_observations` (`H15_*` CMT series), `news_items` + `news_entity_links` + `topics` (`FED`), `calendars` + `calendar_holidays` (`USGOVT`, `SIFMA`), `licence_registry` (footer attribution) |
| Data services (§1.4.2) | `data.rates.latest(code)` × 6, `data.rates.history(code, params.histDays)` × 5, `data.econ.fomc()`, `data.curves.points('SOFR_OIS')`, `data.curves.build('SOFR_OIS', date, interpolation)`, `data.news.search({ feeds:['press_all'], limit })`, `data.reference.calendar('USGOVT')` |
| Read-through (`providers.ensure`) | `('nyfed.rates', 'all/latest', { maxAgeMs: 900_000 })` when the latest `rate_fixings` row is older than one `USGOVT` business day; `('fed.rss', 'press_all', { maxAgeMs: 900_000 })` when `view === 'press'` and the newest `news_items` row for feed `press_all` is older than 15 minutes. Both return `{ fresh:false }` with stored provenance when the circuit is open → the affected cells become `st:'stale'` (TERM-12), never an error. |
| Engines (`core/analytics`) | `wirp/policyPath@1.0.0`, `curve/bootstrap@1.0.0`, `curve/interp@1.0.0` |
| Subjects (live) | `r:EFFR`, `r:SOFR`, `r:OBFR`, `r:TGCR`, `r:BGCR`, `c:SOFR_OIS`, `n:topic:FED` |
| Field ids (`fieldIds(assetClass)`) | `default: [RATE, RATE_P1, RATE_P25, RATE_P75, RATE_P99, RATE_VOLUME_BN, TARGET_FROM, TARGET_TO, RATE_AVG_30D, RATE_AVG_90D, RATE_AVG_180D, RATE_INDEX, CRV_1M, CRV_3M, CRV_6M, CRV_1Y, CRV_2Y, CRV_3Y, CRV_5Y, CRV_7Y, CRV_10Y, CRV_20Y, CRV_30Y, HEADLINE, PUBLISHED_AT]` |

#### Resolver
1. `cal = await ctx.data.reference.calendar('USGOVT')` (REF-06); `asOfDate` = ISO date of `ctx.asOf.validAt` in `America/New_York` (2026-09-15).
2. Overnight complex: `Promise.all(['EFFR','SOFR','OBFR','TGCR','BGCR','SOFRAI'].map(c => ctx.data.rates.latest(c)))` (one batched query). When `EFFR.effectiveDate` is more than one `USGOVT` business day before `asOfDate`, `await ctx.providers.ensure('nyfed.rates', 'all/latest', { maxAgeMs: 900_000 })` once and re-read; `{ fresh:false }` → every rate cell gets `st:'stale'`. One `ctx.prov.add({ sourceId:'nyfed.rates', provenanceId: fixing.provenanceId, capturedAt, sourceTs, st, tier:'eod' })` per fixing (DATA-10).
3. `policy.targetFrom/targetTo` from the EFFR fixing (`target_from` 3.50 / `target_to` 3.75 at the frozen clock, §0); `policy.effectiveDate = EFFR.effectiveDate`. `policy.iorb` and `policy.discountPrimary` are `{ v:null, st:'na', r:'NO_SOURCE_FIELD', provIdx }` plus `ctx.unavailable.add({ field:'policy.iorb', reason:'NO_SOURCE', detail:'IORB is published in H.15 selected daily rates; the H.15 slice fetched here is the constant-maturity Treasury block only (BRIEF §2)' })` and the same for `policy.discountPrimary` — no derivation from EFFR (§1.3 rule 6).
4. `rates[]`: `rate/p1/p25/p75/p99/volumeBn` from the fixing; `chg1dBp = (rate − previousFixing.rate) × 100` from the first two rows of `ctx.data.rates.history(code, 2)`; `spreadToMidBp = (rate − (targetFrom + targetTo) / 2) × 100`. `instrumentId`/`subject` from `plant.subjectFor(rateInstrumentId)` (`r:<rateCode>` form, API.md §6.1) when the rate instrument exists, else `null`; `plant.ensureHot(subjects)`. `sofrAverages` from the `SOFRAI` fixing (`avg_30d`, `avg_90d`, `avg_180d`, `index_value`).
5. `history[]`: one `ctx.data.rates.history(code, params.histDays)` per rate code, zipped on `effectiveDate` descending; a date missing for one code leaves that column `null` (no carry-forward).
6. H.15 block: `pts = await ctx.data.curves.points('UST_CMT')` (latest ≤ `asOfDate` → `2026-09-11`, §0) and `prior = await ctx.data.curves.points('UST_CMT', previousStoredDate)`; `rows[]` per stored tenor with `chg1dBp = (value − priorValue) × 100`, blank when the prior day is an `ND` row (`{ v:null, st:'na' }`). `h15.priorDate = null` when no earlier date is stored. One `ctx.prov.add` for `fed.h15`.
7. FOMC calendar: `mtgs = await ctx.data.econ.fomc()` (8 rows from `fixtures/seed/fomc-2026.json`, §0), take the last `params.meetings` around `asOfDate`; `isNext` is the first row with `meetingDate ≥ asOfDate` (**2026-09-16**, tomorrow at the frozen clock); `decisionBp` is echoed for past meetings and `null` for scheduled ones. `provIdx` = the `fed.fomc` provenance of the seed row.
8. Implied path (`params.path === true`): `build = await ctx.data.curves.build('SOFR_OIS', pts.curveDate, 'monotone_convex')` on the `SOFR_OIS` curve date (`2026-09-14`, §0); `impliedRatePct = policyPath(build.curve, meetingDates, { spot: SOFR.rate, calendar: cal })` from `wirp/policyPath@1.0.0` — the piecewise-constant overnight rate between meeting dates that reprices the curve's forward discount factors; `impliedMoveBp = (implied[i] − implied[i−1]) × 100`, `cumulativeMoveBp = (implied[i] − spot) × 100`. `ctx.engines.add(build.engine)` and `ctx.engines.add(pathEngineNote)` (ANAL-08). `hikeProbPct`/`cutProbPct` stay `null` with `ctx.unavailable.add({ field:'meetings[].hikeProbPct', reason:'NO_SOURCE', detail:'no fed-funds futures source (CME FedWatch not reachable); the implied path is a rate path, not a probability distribution' })`. `params.path === false` or no `SOFR_OIS` build → `path = null` and every implied cell `{ v:null, st:'blank', r:'PROVIDER_DOWN' }`.
9. Press: `items = await ctx.data.news.search({ feeds:['press_all'], limit: Math.max(params.pressLimit, 50) })` (source `fed.rss`, 20 seeded items, NEWS-01); `params.category` filters on `news_items.category` — `monetary` = categories containing `Monetary Policy`, `banking` = `Banking and Consumer Regulatory Policy`, `other` = everything else — then truncate to `params.pressLimit`. One `ctx.prov.add` per distinct `provenance_id`. `press[]` is empty with `ctx.unavailable.add({ field:'press', reason:'NO_SOURCE', detail:'no fed.rss items for category <category>' })` when the filter empties the list.
10. Return `{ variant:'default', … }`. `meta.staleness` = the worst cell state; `meta.engines` holds `wirp/policyPath` and `curve/bootstrap` when step 8 ran.
Budget: 5 DB round-trips (fixings batch, history batch, UST_CMT points ×2, FOMC + news), +1 on a `curve_builds` miss; zero provider calls when the scheduler is healthy; p95 < 200 ms warm.

#### Live
`{ subjects: ['r:EFFR', 'r:SOFR', 'r:OBFR', 'r:TGCR', 'r:BGCR', 'c:SOFR_OIS', 'n:topic:FED'], fields: ['RATE','RATE_P1','RATE_P25','RATE_P75','RATE_P99','RATE_VOLUME_BN','TARGET_FROM','TARGET_TO','BUILD_ID','CURVE_DATE','NEWS_ID','HEADLINE','PUBLISHED_AT','LINK','KIND'], conflationMs: 1000 }` — one mask, intersected per subject by the plant (a `r:` subject never publishes `NEWS_ID`, a `n:` subject never publishes `RATE`; quote-family subjects must name their fields, API.md §6.1). `rates[].rate/p*/volumeBn` carry `Cell.live = { subject: 'r:' + rateCode, field: 'RATE' | 'RATE_P1' | … }` so a new 08:00 ET fixing flashes without a re-run (TERM-08); `grid#rates.live.subjectOf = row => row.subject`. A `c:SOFR_OIS` delta whose `BUILD_ID` differs from `path.buildId` raises `CURVE_UPDATED` (§0) — the implied path is **not** recomputed client-side; `Enter` re-runs. A `n:topic:FED` delta prepends to `list#press` (not conflated, one delta per headline).

#### Screen
```
┌ FED · Federal Reserve Monitor · target 3.50–3.75 % · next FOMC 2026-09-16 ──────────────────────┐
│ badges#caveats [NO_FUTURES_SOURCE] [PROXY_CURVE] [NO_IORB_SOURCE] [NO_BALANCE_SHEET_SOURCE]      │
│ kv#policy (columns 3)  Target range 3.50 – 3.75 %   Last change −25 bp (2026-07-29)              │
│                        IORB —  (NO_SOURCE_FIELD)    Discount (primary) —                         │
│                        Next FOMC 2026-09-16 14:00 ET · SEP · 1 business day                      │
│ tabs#view [1 Rates] [2 Calendar] [3 Press]                                                        │
│ ┌ 1 Rates ─────────────────────────────────────────────────────────────────────────────────────┐│
│ │ grid#rates  rate | date | rate % (live, 4dp) | 1st | 25th | 75th | 99th | vol $bn | Δ1d bp |  ││
│ │             | vs mid bp                                    (SOFR 3.6200, EFFR 3.6300 …)      ││
│ │ kv#sofrAvg  30d 3.64850  90d 3.64603  180d 3.65767  Index 1.25884091  (2026-09-15)            ││
│ │ grid#h15    tenor | CMT % (2026-09-11) | Δ1d bp        (1M 3.93 … 10Y 4.96 … 30Y 5.35)        ││
│ │ grid#history date | EFFR | SOFR | OBFR | TGCR | BGCR | target                                 ││
│ └──────────────────────────────────────────────────────────────────────────────────────────────┘│
│ ┌ 2 Calendar ──────────────────────────────────────────────────────────────────────────────────┐│
│ │ grid#meetings  date | statement (ET) | SEP | decision bp | implied O/N % | move bp | cum bp | ││
│ │                hike prob — | cut prob —     (next meeting row tone 'highlight')               ││
│ │ text#pathNote  "Implied path from the SOFR OIS curve 2026-09-14 (proxy inputs); no fed-funds  ││
│ │                 futures source, so no probabilities."  (tone warn)                            ││
│ └──────────────────────────────────────────────────────────────────────────────────────────────┘│
│ ┌ 3 Press ─────────────────────────────────────────────────────────────────────────────────────┐│
│ │ list#press  headline | category badge | published (datetime ET) → openUrl(url)                ││
│ └──────────────────────────────────────────────────────────────────────────────────────────────┘│
│ footer: sources ['NY Fed reference rates', 'Federal Reserve H.15', 'Federal Reserve press        │
│          releases', 'FOMC calendar', 'internal.derived'] asOf 2026-09-15T18:41:28Z               │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```
Title `FED · Federal Reserve Monitor`; subtitle `target <from>–<to> % · EFFR <rate> % (<date>) · next FOMC <date>`. `initialFocus:'rates'`; the active tab follows `params.view` (`FOMC` alias opens tab 2). Formats: rates `fmt:'pct'` `decimals:4`, volumes `fmt:'int'` with a `$bn` unit label, changes `fmt:'bp'` `decimals:1` with `dir` colouring, the SOFR index `fmt:'px'` `decimals:8`, dates `fmt:'date'`, statement times `fmt:'datetime'` rendered in ET. Skeleton (`payload === undefined`): the policy kv with `—` values, five muted rate rows, eight muted meeting rows. `meta.unavailable` fields render `—` with the `detail` as tooltip and an amber badge; `meta.entitlement` denials (`NO_FIRM_ENTITLEMENT` on `nyfed.rates` or `fed.h15`) blank the affected grid columns with the reason and leave the rest of the page (ENTL-05).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `1` / `2` / `3` | always | `tab-rates` / `tab-calendar` / `tab-press` | `ctx.setParams({ view })` (tabs, §7.2 rule 5) |
| `P` | always | `toggle-path` | `setParams({ path: !params.path })` |
| `C` | always | `cycle-category` | `all → monetary → banking → other` (press tab) |
| `N` | always | `hist-days-prompt` | `ctx.prompt('text', { label:'History days', initial: String(histDays) })` → `setParams({ histDays })` |
| `Enter` | grid (rates) | `open-gp` | `ctx.navigate(row.rateCode + ' Index GP')` for the rate instrument; on `grid#h15` `ctx.navigate('GC UST_CMT')` |
| `Shift+Enter` | grid (rates) | `open-gp-next` | `ctx.navigateNext(row.rateCode + ' Index GP')` |
| `Enter` | list (press) | `open-story` | `ctx.openUrl(item.url)` (federalreserve.gov) |
| `Enter` | grid (meetings) | `row-provenance` | `ctx.provenance(row.provIdx)` |
| `W` | always | `open-wirp` | `ctx.navigate('WIRP')` |
| `B` | always | `open-btmm` | `ctx.navigate('BTMM')` |
| `G` | always | `open-gc` | `ctx.navigate('GC UST_CMT')` |
| `K` | always | `open-crvf` | `ctx.navigate('CRVF SOFR_OIS')` |

#### CSV
`filename = 'FED_' + asOf.replace(/[-:]/g,'') + '.csv'`. Long format (§1.6 rule 3 — five blocks): columns `section,key,label,value,unit,asOf,source`; rows, in order: `policy` (`targetFrom`, `targetTo`, `lastChangeBp`, `nextMeeting`, `iorb`, `discountPrimary` — the last two empty), one per `rates[]` field (`section='rate'`, `key = rateCode + '.' + field`, unit `pct | bp | usd_bn`), the four `sofrAverages` rows (`section='sofr_avg'`), one per `h15.rows[]` (`section='h15'`, `key = tenor`, unit `pct`, plus a `.chg` row in `bp`), one per `history[]` cell (`section='history'`, `key = date + '.' + rateCode`), one per `meetings[]` (`section='fomc'`, `key = meetingDate`, `value = impliedRatePct.v`, plus `.decisionBp`, `.moveBp`, `.cumBp` rows), one per `press[]` (`section='press'`, `key = newsId`, `label = headline`, `value = url`, unit `text`). Example row: `rate,SOFR.rate,Secured Overnight Financing Rate,3.62,pct,2026-09-14,nyfed.rates`.

#### Help
summary `Policy rates, H.15 curve, FOMC calendar with implied path, Fed press`; description `FED is the Federal Reserve page: the current target range and the overnight complex (EFFR, SOFR, OBFR, TGCR, BGCR) with their percentiles and volumes from the New York Fed, the SOFR averages and index, the H.15 constant-maturity Treasury grid with one-day changes, the FOMC calendar with the overnight rate implied at each meeting by the SOFR OIS curve, and the Federal Reserve press release feed. Interest on reserve balances, the primary-credit rate and the balance sheet have no reachable public source in this build and are shown blank with a reason; hike and cut probabilities need fed-funds futures, which are not available either, so the calendar shows an implied rate path and no probability distribution.`; params `view` ("rates, calendar or press"), `histDays` ("overnight history rows", `20`), `meetings` ("FOMC rows", `8`), `pressLimit` ("press items", `20`), `category` ("press category filter", `monetary`), `path` ("compute the implied path"); sources `['nyfed.rates', 'fed.h15', 'fed.fomc', 'fed.rss', 'internal.derived']`; related `['WIRP', 'BTMM', 'GC', 'CRVF', 'ECO']`.

#### Unavailable and reason codes
| Case | `meta.unavailable` / footer |
| --- | --- |
| IORB | `{ field:'policy.iorb', reason:'NO_SOURCE', detail:'IORB is published in H.15 selected daily rates; the H.15 slice fetched here is the constant-maturity Treasury block only (BRIEF §2)' }`; cell `—`; footer badge `NO_IORB_SOURCE` |
| Primary-credit (discount) rate | `{ field:'policy.discountPrimary', reason:'NO_SOURCE', detail:'no reachable keyless source for the discount window rate' }`; footer badge `NO_DISCOUNT_RATE_SOURCE` |
| Balance sheet (H.4.1) | `{ field:'balanceSheet', reason:'NO_SOURCE', detail:'H.4.1 is not among the verified keyless endpoints (BRIEF §2)' }`; `balanceSheet: null`; footer badge `NO_BALANCE_SHEET_SOURCE`; no block is rendered |
| Meeting probabilities | `{ field:'meetings[].hikeProbPct', reason:'NO_SOURCE', detail:'no fed-funds futures source (CME FedWatch not reachable); the implied path is a rate path, not a probability distribution' }`; columns `—`; footer badge `NO_FUTURES_SOURCE` (§0) |
| Implied path from proxies | `path.caveats` always contains `PROXY_CURVE` (§0, CRVF: SOFR_OIS term points are proxied) — amber badge, tooltip names the proxy inputs |
| `params.path === false` or no `SOFR_OIS` build | `path = null`; implied cells `{ v:null, st:'blank', r:'PROVIDER_DOWN' }`; `text#pathNote` says the path was not computed |
| NY Fed circuit open, stored fixings exist | `providers.ensure` returns `{ fresh:false }` → every rate cell `st:'stale'`, `meta.staleness:'stale'`, footer `FIXING DATE <date>` (TERM-12); no throw |
| NY Fed circuit open, nothing stored | `503 PROVIDER_UNAVAILABLE` from `providers.ensure` (the page has no values at all) |
| H.15 prior day is `ND` | `chg1dBp` cell `{ v:null, st:'na' }`; footer note `H15_ND <date>` |
| Press filter empties the list | `{ field:'press', reason:'NO_SOURCE', detail:'no fed.rss items for category <category>' }`; `list#press` shows `emptyText` |
| Entitlement | `meta.entitlement[]` per denied field (`NO_FIRM_ENTITLEMENT` on `nyfed.rates` / `fed.h15`); the column blanks with the reason; `TIER_EOD` never applies (every source here is `eod`) |

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared); `aliasParams.FOMC.view === 'calendar'` |
| golden payload | `packages/server/test/integration/functions/FED.golden.test.ts` | at the frozen clock equals `FED.default.json`: target 3.50–3.75, SOFR 3.62 (p1 3.57, p25 3.60, p75 3.67, p99 3.70, vol 2861), EFFR 3.63 (vol 91), SOFRAI index 1.25884091, H.15 date 2026-09-11 with 10Y 4.96, `meetings[5].isNext === true` for 2026-09-16, `balanceSheet === null` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `FED.default.csv`; every numeric cell equals the payload value |
| parity | `packages/server/test/parity/fn-parity.test.ts` | shared (API-05); `r:SOFR` snapshot `RATE` equals `rates[1].rate.v` |
| screen | `packages/web/test/screens/FED.test.tsx` | three tabs reachable with `1`/`2`/`3`; live cells registered for `r:*`; the next-meeting row is highlighted; IORB renders `—` with the reason tooltip; skeleton |
| no-source fields | `packages/server/test/integration/functions/FED.nosource.test.ts` | `policy.iorb`, `policy.discountPrimary`, `balanceSheet`, `meetings[].hikeProbPct` are null **and** have `meta.unavailable` entries; no value is ever derived from EFFR |
| implied path | `packages/server/test/integration/functions/FED.path.test.ts` | `impliedRatePct` for the 2026-09-16 meeting equals `fixtures/golden/analytics/wirp/2026-09-15.json` `expected.meetings[0].impliedRate` (ANAL-09, QA-01); `path:false` blanks the columns without changing the rest of the payload |
| stale fixings | `packages/server/test/integration/functions/FED.stale.test.ts` | circuit open with stored fixings → `st:'stale'`, `meta.staleness:'stale'`, 200; nothing stored → 503 `PROVIDER_UNAVAILABLE` |
| press filter | `packages/server/test/integration/functions/FED.press.test.ts` | `category:'monetary'` over the 20 seeded `fed-press-rss.xml` items returns only `Monetary Policy` categories; an empty result adds the `press` unavailable entry and still returns 200 |
| e2e | `packages/e2e/tests/rates.spec.ts` | `FED <GO>` shows the target range and the `NO_FUTURES_SOURCE` badge; `2` opens the calendar with 2026-09-16 highlighted; `3` lists Fed press headlines and `Enter` opens federalreserve.gov |

---

### CRYP — Crypto Monitor

| Attribute | Value |
| --- | --- |
| Code / aliases | `CRYP` / `CRYPTO` |
| Tier / category | 3 / monitor |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/CRYP.ts` · `packages/server/src/functions/CRYP/resolve.ts` · `packages/web/src/screens/CRYP/Screen.tsx` · `fixtures/golden/functions/CRYP.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-03) (FUNC-04) (TERM-08) (TERM-12) (DATA-10) (ENTL-05) |

#### Params
```ts
export const CrypParams = z.object({
  ids: z.array(z.enum(['bitcoin', 'ethereum', 'solana', 'ripple'])).min(1).max(4).default(['bitcoin', 'ethereum', 'solana', 'ripple']),
  sort: z.enum(['name', 'px', 'chg']).default('name'),
});
```
#### Argument grammar
`positional [{ name:'ids', type:'string', optional:true }]` (comma-separated CoinGecko ids), `keyed { SORT: { name:'sort', type:'enum', values:['name','px','chg'] } }`, no `rest`.
Examples: `CRYP` → `{ ids:[all four], sort:'name' }` · `CRYP bitcoin,ethereum` → `{ ids:['bitcoin','ethereum'] }` · `CRYP SORT=CHG` → `{ sort:'chg' }`.

#### Payload
```ts
export type CrypPayload = {
  variant: 'default';
  rows: Array<{ instrumentId: number; key: string /* 'BTC Crypto' */; name: string; coingeckoId: string; px: ValueCell; chg24hPct: ValueCell; asOf: string }>;
  source: 'coingecko.simple';
  caveat: 'CONTEXT_ONLY_NOT_EXCHANGE_DATA';
};
```
#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables | `instruments` (asset_class `crypto`, current versions), `md_lines` (`coingecko.simple`), `quote_snapshots` (plant warm start) |
| Data services | `data.reference.instrument`, `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through | `providers.ensure('coingecko.simple', 'bitcoin,ethereum,solana,ripple', { maxAgeMs: 60_000 })` when any subject is `blank` |
| Engines | None. |
| Subjects (live) | `q:<instrumentId>` for each row |
| Field ids | `default: [PX_LAST, CHG_PCT_1D, LAST_TRADE_TIME]` |

#### Resolver
1. Map `params.ids` to instruments: one query over current `instruments` joined to `md_lines` where `source_id='coingecko.simple' AND provider_symbol = ANY(ids)`; unknown ids → `ctx.unavailable.add({ field: id, reason:'NO_SOURCE', detail:'not a seeded CoinGecko id' })`.
2. `subjects = ids.map(plant.subjectFor)`; `plant.ensureHot(subjects)`; `states = plant.snapshotMany(subjects)`.
3. If any state is missing or `st === 'blank'`: `providers.ensure(...)` once, then `snapshotMany` again.
4. For each row: `px = { v: state.fields.PX_LAST ?? null, st: state.state, r: state.r?.PX_LAST, ts: state.fieldTs.PX_LAST, provIdx: ctx.prov.addQuote(state), live: { subject, field:'PX_LAST' } }`; `chg24hPct` likewise from `CHG_PCT_1D` (CoinGecko `usd_24h_change`, normalised by the adapter into `CHG_PCT_1D`); `asOf = ISO(state.ts.src ?? state.ts.cap)`.
5. Sort per `params.sort` (name asc, px desc, chg desc); return `{ variant:'default', rows, source:'coingecko.simple', caveat:'CONTEXT_ONLY_NOT_EXCHANGE_DATA' }`.
Budget: one DB query, zero provider calls when hot; < 50 ms p95.

#### Live
`{ subjects: rows.map(r => 'q:' + r.instrumentId), fields: ['PX_LAST', 'CHG_PCT_1D', 'LAST_TRADE_TIME'], conflationMs: 1000 }`; the grid's `live.subjectOf = row => row.subject`.

#### Screen
```
┌ CRYP · Crypto Monitor · context only ─────────────────────────────┐
│ badges#caveat  [CONTEXT_ONLY_NOT_EXCHANGE_DATA · source CoinGecko] │
│ grid#rows  key | name | px (live, fmt px) | chg24h% (live, pct)    │
│            | as-of (datetime) | state glyph                        │
│ footer: sources ['CoinGecko simple price (context only)'] asOf     │
└───────────────────────────────────────────────────────────────────┘
```
Title `CRYP · Crypto Monitor`; `initialFocus:'rows'`; skeleton = grid with 4 muted rows; denied fields render `—` with the reason from `meta.entitlement`.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid | `open-des` | `ctx.navigate(row.key + ' DES')` (crypto DES variant) |
| `Shift+Enter` | grid | `open-des-next` | `ctx.navigateNext(row.key + ' DES')` |
| `G` | grid | `open-gp` | `ctx.navigate(row.key + ' GP')` |
| `S` | always | `cycle-sort` | `ctx.setParams({ sort: next })` (usage `fn.param`) |
| `Ctrl+W` | grid | `add-watchlist` | `ctx.prompt('watchlist')` then `sdk.watchlists.setItems` |

#### CSV
`filename = 'CRYP_' + asOf.replace(/[-:]/g,'') + '.csv'`; columns `key,name,coingeckoId,px,chg24hPct,asOf,source`; one row per `rows[]` (`px.v`, `chg24hPct.v`). Example: `BTC Crypto,Bitcoin,bitcoin,115234.12,-1.83,2026-09-15T18:41:28Z,coingecko.simple`.

#### Help
summary `Context-only crypto prices (CoinGecko), not exchange data`; description `CRYP shows spot prices and 24-hour changes for the seeded crypto assets from CoinGecko's simple-price endpoint. Values are indicative and are not exchange or venue prices; there is no order book, no volume and no session state. Use DES on a row for the instrument record and GP for history.`; params `ids` ("CoinGecko ids, comma-separated", example `bitcoin,ethereum`), `sort` ("name, px or chg"); sources `['coingecko.simple']`; related `['DES', 'GP', 'WEI']`.

#### Unavailable and reason codes
`{ field: <id>, reason:'NO_SOURCE', detail:'not a seeded CoinGecko id' }` for unknown ids; entitlement denials per field via `meta.entitlement` (`NO_FIRM_ENTITLEMENT` for a firm without the `coingecko.simple` grant); `PROVIDER_DOWN` → cells `stale` with last values (TERM-12).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/CRYP.golden.test.ts` | equals `CRYP.default.json` from `coingecko-simple.json` at the frozen clock |
| csv parity | `packages/core/test/functions/csv.test.ts` | equals `CRYP.default.csv` |
| parity | `packages/server/test/parity/fn-parity.test.ts` | shared |
| screen | `packages/web/test/screens/CRYP.test.tsx` | four rows, live cells registered for `q:*`, `S` cycles sort via `setParams`, skeleton |
| provider down | `packages/server/test/integration/functions/CRYP.stale.test.ts` | circuit open → `st:'stale'`, `meta.staleness:'stale'`, no throw |

#### Completions to the worked example
Everything above this section is FUNCTIONS.md §7.3 verbatim (§7.3 is normative and this file reproduces it
unchanged). The example elides five things an implementer needs; they are fixed here and change nothing above.

1. **`aliasParams` and grammar defaults.** `CRYPTO` is a plain alias: `aliasParams` is absent (the attribute
   table's "(`aliasParams` when any)" case does not apply). A bare positional token is split on `,`,
   lower-cased and parsed by `CrypParams.ids`; an unknown token fails `z.enum` and yields
   `400 VALIDATION_FAILED { location:'fnParams', field:'ids', grammar }` — the `NO_SOURCE` path in resolver
   step 1 is reached only for an id that is valid in the enum but has no seeded `md_lines` row (`solana`,
   `ripple` in the offline seed, below).
2. **Seed reality, and what the goldens contain (this is the only place the example's numbers are not
   reproducible).** `fixtures/providers/raw/coingecko-simple.json` holds two ids only —
   `{bitcoin:{usd:75828, usd_24h_change:-4.217368765220806}, ethereum:{usd:2386.91, usd_24h_change:-6.001270999715535}}` —
   while `seed/universe.ts` row 5 (DATA_MODEL §18) creates four crypto instruments `BTC ETH SOL XRP` and
   records quotes for BTC and ETH only. So `fixtures/golden/functions/CRYP.default.json` has four rows:
   `BTC Crypto` `px 75828`, `chg24hPct −4.217368765220806`; `ETH Crypto` `px 2386.91`,
   `chg24hPct −6.001270999715535`; `SOL Crypto` and `XRP Crypto` with
   `px = { v:null, st:'blank', r:'PROVIDER_DOWN', provIdx }`, `chg24hPct` likewise, `asOf` = the instrument's
   `md_line` capture time, plus `meta.unavailable` entries
   `{ field:'solana', reason:'NO_SOURCE', detail:'not a seeded CoinGecko id' }` and the same for `ripple`
   (resolver step 1 — they are in the enum but carry no recorded response, so they are treated as unseeded
   rather than fabricated). The CSV example row in §7.3 (`115234.12`) is illustrative of the wire shape, not
   of the fixture; `CRYP.default.csv` line 1 is
   `BTC Crypto,Bitcoin,bitcoin,75828,-4.217368765220806,2026-09-15T18:41:28Z,coingecko.simple`
   and the `SOL`/`XRP` rows carry empty `px`/`chg24hPct` fields (§1.6 rule 2). The screen test's "four rows"
   therefore means four rows with two of them blank-with-reason.
3. **Cell formats and CSV header.** `grid#rows` columns: `key` (`fmt:'text'`, align left, width 14), `name`
   (`text`), `px` (`fmt:'px'`, `decimals: instruments.price_decimals ?? 2`, `live:true`, `fieldId:'PX_LAST'`),
   `chg24hPct` (`fmt:'pct'`, `decimals:2`, `live:true`, `fieldId:'CHG_PCT_1D'`, `dir` from the sign),
   `asOf` (`fmt:'datetime'`). `CsvColumn` types are
   `[{id:'key',type:'string'},{id:'name',type:'string'},{id:'coingeckoId',type:'string'},{id:'px',type:'number',decimals:8},{id:'chg24hPct',type:'number',decimals:8},{id:'asOf',type:'datetime'},{id:'source',type:'string'}]`;
   the export carries the standard header lines of §1.6 rule 5 with
   `# source: CoinGecko simple price (context only, not exchange data)` from `licence_registry.attribution`.
4. **Staleness thresholds.** `md_lines.expected_interval_ms` for the `coingecko.simple` line is `60_000`, so
   `valueState` turns a row `stale` after 180 s without an update (ARCHITECTURE §4.2, `3 × expectedIntervalMs`)
   and the badge row shows `STALE` (§0). Crypto has no session, so `SESSION_STATE` is `unknown` and no cell is
   ever `closed`.
5. **No e2e.** CRYP is not listed in ARCHITECTURE §3.5 and belongs to no Tier 1 flow, so the Tests table has
   no e2e row (template §7.1, last row: "Tier 1 only, or when listed in ARCHITECTURE §3.5"). Coverage comes
   from the golden, CSV-parity, screen and provider-down tests above.
