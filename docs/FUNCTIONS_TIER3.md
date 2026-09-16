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
