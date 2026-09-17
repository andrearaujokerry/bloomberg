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
