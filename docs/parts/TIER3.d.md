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
