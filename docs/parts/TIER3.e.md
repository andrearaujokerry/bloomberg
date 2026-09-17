
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
