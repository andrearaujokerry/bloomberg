### BTMM — Treasury & Money Markets

| Attribute | Value |
| --- | --- |
| Code / aliases | `BTMM` / `MMKT` (no `aliasParams`) |
| Tier / category | 2 / monitor |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/BTMM.ts` · `packages/server/src/functions/BTMM/resolve.ts` · `packages/web/src/screens/BTMM/Screen.tsx` · `fixtures/golden/functions/BTMM.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (DATA-07) (DATA-10) (ANAL-02) (STOR-06) (TERM-08) (TERM-12) (ENTL-05) (API-05) |

#### Params
```ts
export const BtmmParams = z.object({
  section: z.enum(['ALL', 'POLICY', 'OVERNIGHT', 'BILLS', 'CURVE', 'SPREADS', 'CONTEXT']).default('ALL'),
  compareDate: z.iso.date().optional(),                 // curve_points.curve_date for the bp-change column; undefined = the previous curve_date in the store
  spreadUnits: z.enum(['bp', 'pct']).default('bp'),
  percentiles: z.boolean().default(true),               // show RATE_P1/P25/P75/P99 columns on the overnight block
  curveId: z.enum(['UST_PAR', 'UST_CMT']).default('UST_PAR'),
});
```
#### Argument grammar
`positional [{ name:'section', type:'enum', values:['ALL','POLICY','OVERNIGHT','BILLS','CURVE','SPREADS','CONTEXT'], optional:true }]`, `keyed { CMP: { name:'compareDate', type:'date' }, U: { name:'spreadUnits', type:'enum', values:['bp','pct'] }, PCT: { name:'percentiles', type:'boolean' }, CRV: { name:'curveId', type:'enum', values:['UST_PAR','UST_CMT'] } }`, no `rest`.
Examples: `BTMM` → `{ section:'ALL', spreadUnits:'bp', percentiles:true, curveId:'UST_PAR' }` · `BTMM CURVE CMP=2026-09-08 CRV=UST_CMT` → `{ section:'CURVE', compareDate:'2026-09-08', curveId:'UST_CMT' }` · `MMKT OVERNIGHT PCT=0` → `{ section:'OVERNIGHT', percentiles:false }`.

#### Payload
```ts
// packages/core/src/functions/shared/rates.ts — NEW shared file (see "Unavailable and reason codes" → additions)
/** One NY Fed reference-rate fixing as BTMM, FED and WIRP render it. `subject` is 'r:<rateCode>'. */
export interface RateFixingRow {
  rateCode: 'SOFR' | 'EFFR' | 'OBFR' | 'TGCR' | 'BGCR' | 'SOFRAI';
  label: string; publisher: 'NY Fed'; effectiveDate: string; vintageAt: string; isLatest: boolean;
  subject: string;                                                   // 'r:SOFR'
  rate: ValueCell; p1: ValueCell; p25: ValueCell; p75: ValueCell; p99: ValueCell; volumeBn: ValueCell;
  avg30d: ValueCell; avg90d: ValueCell; avg180d: ValueCell; indexValue: ValueCell;   // SOFRAI only; blank ValueCell elsewhere
  chg1dBp: ValueCell;                                                // rate(t) − rate(t₋1), ×100, resolver arithmetic
  revisionIndicator: string; provIdx: number;
}
/** One point of a stored curve (UST_PAR, UST_CMT, UST_BILL, SOFR_FIX). */
export interface CurvePointRow {
  curveId: 'UST_PAR' | 'UST_CMT' | 'UST_BILL' | 'SOFR_FIX';
  tenor: string;                                                     // '1M','3M','2Y','10Y','30Y' | '4WK','13WK','52WK' | 'ON'
  tenorDays: number; quoteType: 'par_yield' | 'discount_rate' | 'investment_yield' | 'cmt_yield' | 'fixing';
  value: ValueCell; compareValue: ValueCell; chgBp: ValueCell;
  instrumentId: number | null; cusip: string | null; maturityDate: string | null;    // bills only (treasury.bills mints these)
  fieldId: FieldId | null;                                           // 'CRV_10Y' … ; null for bill tenors with no dictionary id
  provIdx: number;
}
/** One derived spread. Derived cells cite the provIdx of their primary input (Tier 1 §0.4 rule 4). */
export interface SpreadRow {
  id: string; label: string; definition: string;                     // '10Y par yield − 2Y par yield'
  value: ValueCell; compareValue: ValueCell; chgBp: ValueCell;
  unit: 'bp' | 'pct'; fieldId: null; provIdx: number;
}

// packages/core/src/functions/manifests/BTMM.ts
export type BtmmPayload = {
  variant: 'default';
  section: 'ALL' | 'POLICY' | 'OVERNIGHT' | 'BILLS' | 'CURVE' | 'SPREADS' | 'CONTEXT';
  policy: {
    targetFrom: ValueCell; targetTo: ValueCell;                      // TARGET_FROM / TARGET_TO, EFFR fixing only (nyfed.rates)
    targetMid: ValueCell;                                            // derived (from+to)/2
    effectiveDate: string;
    lastMeeting: { meetingDate: string; statementAt: string | null; hasSep: boolean; decisionBp: number | null; provIdx: number } | null;
    nextMeeting: { meetingDate: string; statementAt: string | null; hasSep: boolean; daysAway: number; provIdx: number } | null;
    iorb: { v: null; r: 'NO_IORB_SOURCE' };                          // structurally null: no reachable IORB source (BRIEF §2)
    discountWindow: { v: null; r: 'NO_DISCOUNT_WINDOW_SOURCE' };
  };
  overnight: RateFixingRow[];                                        // SOFR, EFFR, OBFR, TGCR, BGCR, SOFRAI in that order
  bills: { curveDate: string; compareDate: string | null; points: CurvePointRow[] };        // UST_BILL, 7 tenors × 2 quote types
  curve: { curveId: 'UST_PAR' | 'UST_CMT'; curveDate: string; compareDate: string | null;
           points: CurvePointRow[]; stale: boolean };                // stale = curveDate > 3 USGOVT business days behind ctx.asOf.validAt
  spreads: SpreadRow[];
  context: { fx: MonitorRow[]; indices: MonitorRow[] };              // shared MonitorRow (Tier 1 §0.2)
  notes: string[];                                                   // 'CURVE_STALE', 'NO_IORB_SOURCE', 'NO_FED_FUNDS_FUTURES'
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `rate_fixings` (latest vintage per `(rate_code, effective_date)` with `vintage_at ≤ ctx.asOf.knownAt`, STOR-06), `rate_terms`, `curves`, `curve_points` (`UST_PAR`, `UST_CMT`, `UST_BILL`, `SOFR_FIX`; `is_latest` vintage ≤ `knownAt`), `govt_terms` (bill CUSIP, maturity, `on_the_run`), `instruments` (asset_class `rate`, `govt`, `fx`, `index`), `md_lines`, `fomc_meetings`, `calendars` / `calendar_holidays` (`USGOVT`), `quote_snapshots` (plant warm start), `provenance` |
| Data services (§1.4.2) | `data.rates.latest`, `data.rates.history`, `data.curves.points`, `data.econ.fomc`, `data.reference.calendar`, `data.reference.instrument`, `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | `('nyfed.rates', 'all', { maxAgeMs: 3_600_000 })` when the newest `rate_fixings.effective_date` is more than one `USGOVT` business day behind `ctx.asOf.validAt`. **No read-through for the curves**: `ReadThroughKind` has no `treasury.yieldcurve` / `treasury.bills` / `fed.h15` member (§1.4.2), so the curve blocks are only as fresh as `ingest/jobs/treasuryCurves.ts` (18:00 ET) and `fedRates.ts` (08:30 ET) — a curve date more than three `USGOVT` business days old sets `curve.stale = true`, adds the note `CURVE_STALE` and cites its provenance with `ctx.prov.add({ …, st:'stale' })` (TERM-12) |
| Engines (`core/analytics`) | None. Spreads, `targetMid` and `chg1dBp` are resolver arithmetic; `meta.engines` is empty. A bootstrapped zero/forward curve is CRVF's job (ANAL-02), not BTMM's |
| Subjects (live) | `r:SOFR`, `r:EFFR`, `r:OBFR`, `r:TGCR`, `r:BGCR`, `r:SOFRAI`; `c:UST_PAR`, `c:UST_CMT`, `c:UST_BILL`, `c:SOFR_FIX`; `q:<instrumentId>` for each `context.fx` row (`EURUSD`, `USDJPY`, `GBPUSD` Curncy) and each `context.indices` row (`SPX Index`, `VIX Index`, `TNX Index`) |
| Field ids (`fieldIds(assetClass)`) | `default: [RATE, RATE_P1, RATE_P25, RATE_P75, RATE_P99, RATE_VOLUME_BN, TARGET_FROM, TARGET_TO, RATE_AVG_30D, RATE_AVG_90D, RATE_AVG_180D, RATE_INDEX, CRV_1M, CRV_3M, CRV_6M, CRV_1Y, CRV_2Y, CRV_3Y, CRV_5Y, CRV_7Y, CRV_10Y, CRV_20Y, CRV_30Y, DISC_RATE, BEY, PX_LAST, CHG_NET_1D, CHG_PCT_1D]` |

#### Resolver
`default` (`resolve`; no `variants`):
1. `knownAt = ctx.asOf.knownAt`; `cal = await ctx.data.reference.calendar('USGOVT')`; `today = ctx.asOf.validAt` in `America/New_York`.
2. **Overnight.** `fixings = await ctx.data.rates.history(code, 2)` for the six codes in one batched call per code (six rows from one `rate_fixings` query, `DISTINCT ON (rate_code) … WHERE vintage_at ≤ knownAt AND is_latest ORDER BY effective_date DESC`). When `max(effective_date)` is more than one `USGOVT` business day behind `today`, `await ctx.providers.ensure('nyfed.rates', 'all', { maxAgeMs: 3_600_000 })` once and re-read. Each row → `RateFixingRow`: `rate`, `p1/p25/p75/p99`, `volumeBn` are **stored-value cells** (Tier 1 §0.4 rule 3) — `{ v, st:'closed', ts: effectiveDate at 08:00 ET, provIdx: ctx.prov.add(fixing.provenanceId) }` — plus `live: { subject:'r:'+rateCode, field:'RATE' }` on `rate` so the plant can overwrite it intraday. `chg1dBp = round((rate(t) − rate(t₋1)) × 100, 1)` with `provIdx` of `rate(t)`. `SOFRAI` has no `percentRate` and no percentiles (PROVIDERS §10.4): its `rate`, `p*` and `volumeBn` are `{ v: null, st:'na', r:'NO_SOURCE' }` and only `avg30d/avg90d/avg180d/indexValue` carry values — the screen prints `—`, never a fabricated zero.
3. **Policy.** `targetFrom`/`targetTo` from the latest `EFFR` fixing (the only type carrying `target_from`/`target_to`); `targetMid` derived, citing the EFFR `provIdx`. `meetings = await ctx.data.econ.fomc()` → `lastMeeting` = newest `meeting_date ≤ today` (with `decision_bp`), `nextMeeting` = oldest `meeting_date > today`, `daysAway` in calendar days. `iorb` and `discountWindow` are structurally null with their reason codes and one `ctx.unavailable.add` each (step 8).
4. **Curve.** `pts = await ctx.data.curves.points(params.curveId)` → latest `curve_date` with `is_latest` vintages ≤ `knownAt`; `cmp = await ctx.data.curves.points(params.curveId, params.compareDate ?? previousCurveDate)` where `previousCurveDate` is the next-lower `curve_date` in `curve_points` for that curve. One `CurvePointRow` per tenor in ascending `tenor_days`, `chgBp = (value − compareValue) × 100` rounded to 1 dp, `fieldId = 'CRV_' + tenor` when the tenor is one of the dictionary ids (`1M 3M 6M 1Y 2Y 3Y 5Y 7Y 10Y 20Y 30Y`; `1.5M`, `2M` and `4M` exist on `UST_PAR` and carry `fieldId: null`). `curve.stale` per the read-through row above.
5. **Bills.** `data.curves.points('UST_BILL')` returns both `quote_type`s for the seven tenors; each row joins `govt_terms` on `curve_points.instrument_id` for `cusip`, `maturity_date` and `on_the_run`. `value` uses `DISC_RATE` for `discount_rate` and `BEY` for `investment_yield` as the display `fieldId`.
6. **Spreads** (all `unit: params.spreadUnits`, `bp` = the `pct` difference × 100): `2s10s` = `CRV_10Y − CRV_2Y`; `3m10y` = `CRV_10Y − CRV_3M`; `5s30s` = `CRV_30Y − CRV_5Y`; `SOFR−EFFR`; `BGCR−SOFR`; `TGCR−BGCR`; `EFFR−target mid`; `13WK bill investment yield − SOFR`; `10Y par − 10Y CMT` (the cross-source check of PROVIDERS §10.3, shown so a divergence is visible rather than silent). Any input cell that is null yields `{ v: null, st:'na', r:'NO_SOURCE' }` for the spread — a spread is never computed from a partially missing pair.
7. **Context.** `subjects = fx.concat(indices).map(plant.subjectFor)`; `plant.ensureHot(subjects)`; `states = plant.snapshotMany(subjects)`; cells via `cellFromState(ctx, state, field, subject)` (Tier 1 §0.4 rules 1–2 — a monitor resolver never calls `providers.ensure` for quotes). Columns are `monitorColumn('PX_LAST')`, `monitorColumn('CHG_NET_1D')`, `monitorColumn('CHG_PCT_1D')`.
8. `ctx.unavailable.add({ field:'policy.iorb', reason:'NO_SOURCE', detail:'NO_IORB_SOURCE: …' })`, the same for `policy.discountWindow`, and — when `params.section` is `ALL` or `POLICY` — `{ field:'policy.impliedPath', reason:'NO_SOURCE', detail:'NO_FED_FUNDS_FUTURES: …' }` with the footer note pointing at WIRP. Sections other than `ALL` still return every block (the payload shape is stable, §1.3); `section` only drives which nodes the screen renders, so PRINT is identical whatever tab is open.
Budget: 4 DB round-trips (fixings, curve + compare in one query, bills, FOMC) + 1 plant snapshot; zero provider calls when the morning jobs have run; < 120 ms p95.

#### Live
```ts
{ subjects: ['r:SOFR','r:EFFR','r:OBFR','r:TGCR','r:BGCR','r:SOFRAI',
             'c:UST_PAR','c:UST_CMT','c:UST_BILL','c:SOFR_FIX',
             ...payload.context.fx.map(r => r.subject), ...payload.context.indices.map(r => r.subject)],
  fields: ['RATE','RATE_P1','RATE_P25','RATE_P75','RATE_P99','RATE_VOLUME_BN','TARGET_FROM','TARGET_TO',
           'RATE_AVG_30D','RATE_AVG_90D','RATE_AVG_180D','RATE_INDEX','PX_LAST','CHG_NET_1D','CHG_PCT_1D'],
  conflationMs: 1000 }
```
`packages/web/src/state/subscriptions.ts` intersects this union per subject family (Tier 1 §0.4 rule 5), so `c:` subjects go out with `f: []` (all of `TENORS RATES BUILD_ID BUILD_TS CURVE_DATE`, API.md §6.1) and `r:` subjects with the rate fields only. `grid#overnight.live.subjectOf = row => row.subject`; each `CurvePointRow` maps to the `c:<curveId>` subject and the screen rebuilds the block from the `RATES`/`TENORS` comma strings on each curve delta (one delta per rebuild, never conflated).

#### Screen
```
┌ BTMM · Treasury & Money Markets · 2026-09-15 ──────────────────────────────────────┐
│ tabs#section  [1 ALL] [2 POLICY] [3 O/N] [4 BILLS] [5 CURVE] [6 SPREADS] [7 CONTEXT]│
│ kv#policy   target range 3.50 – 3.75 (pct 2dp) · mid 3.625 · eff 2026-09-14         │
│             last FOMC 2026-07-29 (−25 bp) · next 2026-09-16 (1 d) · SEP yes         │
│             IORB — NO_IORB_SOURCE   discount window — NO_DISCOUNT_WINDOW_SOURCE     │
│ grid#overnight  rate | label | fix (pct 3dp, live) | chg bp (bp 1dp) | p1 | p25 |   │
│                 p75 | p99 (pct 3dp) | vol $bn (int) | eff date (date) | state glyph │
│ grid#bills   tenor | cusip | maturity (date) | discount (pct 3dp) | inv yld (pct    │
│              3dp) | chg bp | OTR badge                                              │
│ grid#curve   tenor | yield (pct 2dp) | 2026-09-11 (pct 2dp) | chg bp (bp 1dp, ± tone)│
│ grid#spreads label | definition | value (bp 1dp / pct 3dp) | chg bp                  │
│ grid#context key | last (live px) | chg (live px) | chg% (live pct)                  │
│ footer: sources ['NY Fed reference rates','US Treasury par yields','US Treasury bill │
│         rates','Federal Reserve H.15','Cboe delayed quotes','Yahoo Finance chart']   │
│         asOf=<ctx.asOf.validAt>  notes: CURVE_STALE? NO_FED_FUNDS_FUTURES            │
└────────────────────────────────────────────────────────────────────────────────────┘
```
Title `BTMM · Treasury & Money Markets`; subtitle `<curveId> <curveDate> · compare <compareDate>`. `initialFocus:'overnight'`. Skeleton (`payload === undefined`): the seven tabs plus a `kv` of 6 muted rows, a 6-row muted `overnight` grid, a 14-row muted `bills` grid and an 11-row muted `curve` grid — the row counts are fixed by the seeded universe so the layout does not jump. `meta.unavailable` renders as a `badges#gaps` row under the tabs (`NO_IORB_SOURCE`, `NO_DISCOUNT_WINDOW_SOURCE`, `NO_FED_FUNDS_FUTURES`), and each null-by-design cell shows `—` with the reason as its title. A denied field from `meta.entitlement` blanks its column with `—` and the `ReasonCode` tooltip (ENTL-05); `meta.staleness:'stale'` (a stale curve or an open `nyfed.rates` circuit) puts the stale glyph on the affected block's header and the `CURVE_STALE` note in the footer (TERM-12).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `1`…`7` | always | `tab-section` | `ctx.setParams({ section })` in tab order (usage `fn.param`) |
| `U` | always | `cycle-spread-units` | `bp → pct → bp` via `setParams({ spreadUnits })` |
| `C` | always | `cycle-curve` | `UST_PAR → UST_CMT → UST_PAR` via `setParams({ curveId })` |
| `D` | always | `set-compare-date` | `ctx.prompt('date', { label:'Compare to curve date' })` → `setParams({ compareDate })` |
| `P` | always | `toggle-percentiles` | `setParams({ percentiles: !percentiles })` |
| `Enter` | grid `bills` | `open-yas` | `ctx.navigate(row.cusip + ' Govt YAS')` (rows with `instrumentId === null` do nothing) |
| `Shift+Enter` | grid `bills` | `open-yas-next` | `ctx.navigateNext(row.cusip + ' Govt YAS')` |
| `Enter` | grid `overnight` | `open-des` | `ctx.navigate(row.rateCode + ' Index DES')` (rate DES variant) |
| `Enter` | grid `context` | `open-des-ctx` | `ctx.navigate(row.key + ' DES')` |
| `G` | grid `overnight` / `context` | `open-gp` | `ctx.navigate(row.rateCode + ' Index GP')` / `ctx.navigate(row.key + ' GP')` |
| `V` | always | `open-crvf` | `ctx.navigate('CRVF')` (curve construction, ANAL-02) |
| `W` | always | `open-wirp` | `ctx.navigate('WIRP')` — where the implied policy path lives, since BTMM has no futures source |
| `F` | always | `open-fed` | `ctx.navigate('FED')` |
| `X` | always | `open-fxc` | `ctx.navigate('FXC')` |
| `B` | always | `open-wb` | `ctx.navigate('WB')` |

#### CSV
`filename = 'BTMM_' + (payload.curve.curveDate).replace(/-/g,'') + '_' + asOf.replace(/[-:]/g,'') + '.csv'`. Long format (§1.6 rule 3), static `columns`: `section,key,label,value,unit,compareValue,chgBp,asOfDate,sourceId` — `section` ∈ `policy | overnight | bills | curve | spreads | context`, one row per item of every block regardless of `params.section` (PRINT exports the whole screen, not the visible tab). Numeric cells are `cell.v` at full stored precision; a null-by-design cell writes an empty value and puts its reason code in `label` suffixed `' (—)'`.
Example row: `overnight,SOFR,Secured Overnight Financing Rate,3.62,pct,3.64,-2.0,2026-09-14,nyfed.rates`.

#### Help
summary `Policy range, overnight rates, bills, the Treasury curve and spreads on one page`; description `BTMM is the rates desk's morning page. The policy block shows the FOMC target range as the New York Fed publishes it with the EFFR fixing, the last and next meeting dates. The overnight block shows SOFR, EFFR, OBFR, TGCR and BGCR with their 1st, 25th, 75th and 99th percentiles and traded volume, plus the SOFR averages and index. Bills come from the Treasury daily bill rates file with the on-the-run CUSIP for each tenor; the curve block is the Treasury par yield curve or the Federal Reserve H.15 constant-maturity curve, with a basis-point change column against any earlier curve date (press D). Spreads are computed from those same published values, never from a second source. There is no interest on reserve balances, no discount-window rate and no fed funds futures in the reachable source set: those cells show a reason code, and the implied policy path is derived from the money-market curve in WIRP instead.`; params: `section` ("ALL, POLICY, OVERNIGHT, BILLS, CURVE, SPREADS or CONTEXT", example `BTMM CURVE`), `compareDate` ("curve date for the change column", `CMP=2026-09-08`), `spreadUnits` ("bp or pct", `U=pct`), `percentiles` ("show the percentile columns", `PCT=0`), `curveId` ("UST_PAR or UST_CMT", `CRV=UST_CMT`); sources `['nyfed.rates','treasury.yieldcurve','treasury.bills','fed.h15','fed.fomc','cboe.quotes','yahoo.chart']`; related `['WIRP','CRVF','FED','YAS','SRCH','FXC','WB']`.

#### Unavailable and reason codes
`{ field:'policy.iorb', reason:'NO_SOURCE', detail:'NO_IORB_SOURCE: interest on reserve balances is not published by any keyless source in the reachable set (BRIEF §2); the target range and EFFR are shown instead' }` ·
`{ field:'policy.discountWindow', reason:'NO_SOURCE', detail:'NO_DISCOUNT_WINDOW_SOURCE: the primary-credit rate has no machine-readable keyless feed' }` ·
`{ field:'policy.impliedPath', reason:'NO_SOURCE', detail:'NO_FED_FUNDS_FUTURES: CME FedWatch and fed funds futures are not reachable; WIRP derives the implied path from the SOFR fixing and the bill curve' }` ·
`{ field:'overnight.SOFRAI.rate', reason:'NOT_APPLICABLE', detail:'SOFRAI publishes averages and an index level, not a daily rate (PROVIDERS §10.4)' }` ·
`{ field:'curve.<tenor>', reason:'NO_SOURCE', detail:'tenor absent from the Treasury publication for this curve date' }` (Treasury genuinely suspends tenors; this is a `field_population` warning, never a rejection) ·
`{ field:'spreads.<id>', reason:'NO_SOURCE', detail:'one leg of the spread is unavailable for this date' }`.
Footer notes: `CURVE_STALE` (curve date > 3 `USGOVT` business days old), `RATE_REVISED` (a fixing whose `revision_indicator` is non-empty), `NO_FED_FUNDS_FUTURES`. Entitlement: `NO_FIRM_ENTITLEMENT` / `NO_USER_ENTITLEMENT` on `nyfed.rates` blanks the overnight block with reasons; `SOURCE_TIER_CAP` never applies to `nyfed.rates` (`max_tier 'realtime'`, `intrinsic_delay_min 0`) but does cap `cboe.quotes` context rows at `delayed`. `PROVIDER_DOWN` (circuit open with stored rows) → cells `st:'stale'`, `meta.staleness:'stale'`, no throw.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared) |
| golden payload | `packages/server/test/integration/functions/BTMM.golden.test.ts` | resolver at the frozen clock `2026-09-15T18:41:28Z` deep-equals `BTMM.default.json`: EFFR target 3.50–3.75 and SOFR 3.62 for `effectiveDate 2026-09-14` from `nyfed-all`; the `UST_PAR` block from `treasury-xml2`; 7 bill tenors × 2 quote types with CUSIPs from `treasury-bills.xml`; `UST_CMT` from `fed-h15.csv`; `2s10s` equals `CRV_10Y − CRV_2Y` of the same curve date |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `BTMM.default.csv`; every numeric cell equals the payload `cell.v` |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at a frozen clock (API-05) |
| screen | `packages/web/test/screens/BTMM.test.tsx` | renders the golden; seven tabs reachable by `1`–`7`; `U`/`C`/`D`/`P` call `setParams`; live cells registered for `r:*`, `c:*` and `q:*`; `payload undefined` renders the skeleton; `SOFRAI.rate` renders `—` with the reason title |
| SOFRAI / missing legs | `packages/server/test/integration/functions/BTMM.unavailable.test.ts` | SOFRAI produces `st:'na'` rate and percentile cells; deleting the 2Y par point makes `2s10s` `st:'na'` with `NO_SOURCE` and leaves `3m10y` computed |
| stale curve | `packages/server/test/integration/functions/BTMM.stale.test.ts` | advancing the clock four `USGOVT` business days past the newest `curve_date` sets `curve.stale`, adds `CURVE_STALE` and `meta.staleness:'stale'` without throwing (TERM-12) |
| e2e | `packages/e2e/tests/rates-morning.spec.ts` | `BTMM <GO>` on the replay-mode server: overnight grid shows six rows, `D` prompts for a compare date and the bp column changes, `Ctrl+P` yields a CSV whose `curve` rows equal the on-screen yields, `X` navigates to FXC and `B` to WB |

---

### FXC — FX Cross Matrix

| Attribute | Value |
| --- | --- |
| Code / aliases | `FXC` / `FX`, `CROSS` (no `aliasParams`) |
| Tier / category | 2 / monitor |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/FXC.ts` · `packages/server/src/functions/FXC/resolve.ts` · `packages/web/src/screens/FXC/Screen.tsx` · `fixtures/golden/functions/FXC.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (FEED-03) (DATA-10) (TERM-08) (TERM-12) (ENTL-05) (API-05) |

#### Params
```ts
export const FxcParams = z.object({
  ccys: z.array(z.string().regex(/^[A-Z]{3}$/)).min(2).max(10)
        .default(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK']),
  quote: z.enum(['live', 'ecb']).default('live'),        // live = the plant's yahoo.chart lines; ecb = frankfurter fx_rates
  date: z.iso.date().optional(),                          // ecb mode: fx_rates.rate_date; undefined = latest ≤ ctx.asOf.validAt
  decimals: z.enum(['auto', '2', '4', '5']).default('auto'),   // auto = from fx_terms.pip_size
  transpose: z.boolean().default(false),                  // swap the base (rows) and quote (columns) axes
});
```
#### Argument grammar
`positional [{ name:'ccys', type:'string', optional:true }]` (comma-separated ISO 4217 codes), `keyed { SRC: { name:'quote', type:'enum', values:['live','ecb'] }, DT: { name:'date', type:'date' }, DEC: { name:'decimals', type:'enum', values:['auto','2','4','5'] }, T: { name:'transpose', type:'boolean' } }`, no `rest`.
Examples: `FXC` → `{ ccys:[the G10 default], quote:'live', decimals:'auto', transpose:false }` · `FXC EUR,USD,JPY,GBP` → `{ ccys:['EUR','USD','JPY','GBP'] }` · `CROSS SRC=ECB DT=2026-09-15` → `{ quote:'ecb', date:'2026-09-15' }`.

#### Payload
```ts
export type FxcCellKind = 'unity' | 'direct' | 'inverse' | 'cross';
export type FxcPayload = {
  variant: 'default';
  quote: 'live' | 'ecb'; rateDate: string | null;                      // ecb mode: the fx_rates.rate_date used; null in live mode
  ccys: string[];                                                       // axis order after params.transpose
  matrix: Array<Array<{
    base: string; quote: string; kind: FxcCellKind;
    rate: ValueCell;                                                    // units of `quote` per 1 `base`
    chgPct1d: ValueCell;                                                // live mode only; ecb mode = { v:null, st:'na', r:'NOT_APPLICABLE' }
    decimals: number;                                                   // from fx_terms.pip_size, or params.decimals
    instrumentId: number | null; key: string | null;                    // 'EURUSD Curncy' for direct/inverse; null for cross and unity
    subject: string | null;                                             // 'q:<instrumentId>' for direct/inverse
    via: string | null;                                                 // 'USD' for cross cells; null otherwise
    derivation: string | null;                                          // 'EURUSD × USDJPY' | '1 / USDJPY'
    provIdx: number;
  }>>;
  pairs: MonitorRow[];                                                  // the nine seeded direct pairs, shared MonitorRow (Tier 1 §0.2)
  pairColumns: MonitorColumn[];                                         // PX_LAST, CHG_NET_1D, CHG_PCT_1D, PX_OPEN, PX_HIGH, PX_LOW, PX_CLOSE_1D, LAST_TRADE_TIME
  ecbCompare: Array<{ base: string; quote: string; live: number | null; ecb: number | null; diffPct: number | null }> | null;
  missing: string[];                                                    // requested currencies with no seeded USD pair
  notes: string[];                                                      // 'NO_FX_DEPTH_SOURCE', 'CROSSES_DERIVED_VIA_USD', 'INDICATIVE_MID_ONLY'
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `instruments` (asset_class `fx`, market_sector `Curncy`, current versions), `fx_terms` (`base_ccy`, `quote_ccy`, `pip_size`, `quote_convention`, `calendar_id`), `md_lines` (`yahoo.chart` `EURUSD=X`, `frankfurter` `USD`), `fx_rates` (`base_ccy, quote_ccy, rate_date, rate, source_id`), `quote_snapshots` (plant warm start), `bars_daily` (the ECB fixing close, `open/high/low/volume` NULL by design), `calendars` (`FX_USD`), `provenance` |
| Data services (§1.4.2) | `data.reference.instrument`, `data.historical.bars` (ecb mode compare), `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | None in live mode (Tier 1 §0.4 rule 2: a monitor never fetches quotes on the request path; the scheduler polls cold subjects). ecb mode has no read-through either — `ReadThroughKind` has no `frankfurter` member, so `fx_rates` is only as fresh as `ingest/jobs/fxEod.ts` (16:15 CET); a `rate_date` older than two `TARGET2` business days marks the block stale through `ctx.prov.add({ …, st:'stale' })` (TERM-12) |
| Engines (`core/analytics`) | None. The cross arithmetic is resolver arithmetic on two published rates; `meta.engines` is empty |
| Subjects (live) | `q:<instrumentId>` for each of the nine seeded direct pairs (`EURUSD GBPUSD USDJPY USDCHF USDCAD AUDUSD NZDUSD USDSEK USDNOK`); none in `quote:'ecb'` mode |
| Field ids (`fieldIds(assetClass)`) | `default: [PX_LAST, CHG_NET_1D, CHG_PCT_1D, PX_OPEN, PX_HIGH, PX_LOW, PX_CLOSE_1D, PX_OFFICIAL_CLOSE, LAST_TRADE_TIME, SESSION_STATE]` |

#### Resolver
`default` (`resolve`; no `variants`):
1. `ccys = dedupe(params.ccys.map(c => c.toUpperCase()))`. One query over current `instruments` joined to `fx_terms` for every `fx` instrument whose `base_ccy` and `quote_ccy` are both in `ccys ∪ {'USD'}` → the direct-pair map `M[base][quote] = { instrumentId, key, pipSize }`. A currency with no path to `USD` goes into `missing[]` and gets `ctx.unavailable.add({ field: ccy, reason:'NO_SOURCE', detail:'no seeded USD pair for this currency' })`; it is dropped from the axes.
2. **live mode**: `subjects = directPairs.map(p => plant.subjectFor(p.instrumentId))`; `plant.ensureHot(subjects)`; `states = plant.snapshotMany(subjects)`. `pairs` = one `MonitorRow` per direct pair with `cells` built by `cellFromState(ctx, state, field, subject)` for `pairColumns`; a pair never polled is `pendingCell` and renders `…` until the WS `snap` fills it (Tier 1 §0.4 rule 1).
   **ecb mode**: `rateDate` = `params.date ?? max(fx_rates.rate_date) ≤ ctx.asOf.validAt`; one query reads every `(base, quote)` of `ccys` from `fx_rates WHERE source_id='frankfurter' AND rate_date = rateDate` — both directions are stored (PROVIDERS §5.7) so no conditional inversion is needed. Cells are stored-value cells (`st:'closed'`, `ts` = `rateDate` at `14:15:00Z`, `provIdx = ctx.prov.add(row.provenance_id)`), and `chgPct1d` is `{ v:null, st:'na', r:'NOT_APPLICABLE' }` — the ECB publishes one daily fixing, not an intraday series.
3. Build `matrix[i][j]` for `base = ccys[i]`, `quote = ccys[j]`:
   - `i === j` → `kind:'unity'`, `rate = { v: 1, st:'closed', provIdx: -1 }`, `derivation: null`.
   - a seeded pair `base/quote` exists → `kind:'direct'`, `rate` = that pair's `PX_LAST` cell, `decimals = decimalsOf(pipSize)` (`pip_size 0.01` → 2 for JPY pairs, `0.0001` → 4 otherwise) unless `params.decimals !== 'auto'`.
   - a seeded pair `quote/base` exists → `kind:'inverse'`, `rate.v = 1 / px`, `derivation = '1 / ' + key`, same `provIdx` as the direct cell, `live` omitted (the screen recomputes the inverse from the direct cell's live value so the flash stays in sync).
   - neither, and both legs reach `USD` → `kind:'cross'`, `rate.v = rate(base,'USD') × rate('USD',quote)`, `via:'USD'`, `derivation = 'EURUSD × USDJPY'` (the two leg keys in the order used), `provIdx` = the provIdx of the **base** leg, `st` = the worse of the two legs' states (`blank` ≻ `na` ≻ `stale` ≻ `closed` ≻ `live`), and any null leg yields `{ v: null, st:'na', r:'NO_SOURCE' }`.
   Rounding happens once, at display time, from `decimals`; the payload carries full precision (API-05 value identity).
4. `ecbCompare` is populated only in live mode and only when `fx_rates` has a row for `max(rate_date) ≤ ctx.asOf.validAt`: for each direct pair, `live` = `PX_LAST`, `ecb` = the stored fixing, `diffPct = (live/ecb − 1) × 100`. It is the screen's honest statement of how far an indicative delayed mid is from the reference fixing; `null` when no fixing is stored.
5. `notes` always contains `INDICATIVE_MID_ONLY` and `NO_FX_DEPTH_SOURCE`, and `CROSSES_DERIVED_VIA_USD` when any `cross` cell exists. `ctx.unavailable.add({ field:'bidAsk', reason:'NO_SOURCE', detail:'NO_FX_DEPTH_SOURCE: …' })` and `{ field:'forwardPoints', reason:'NOT_APPLICABLE', detail:'NO_FORWARD_POINTS_SOURCE: …' }` (DATA-05 interbank FX and swap curves are out of scope, BRIEF §1).
6. `params.transpose` swaps the axis order after the matrix is built, so the payload is identical up to transposition and PRINT is unaffected.
Budget: 1 DB query (instruments + fx_terms) + 1 plant snapshot in live mode; 2 DB queries in ecb mode; zero provider calls; < 60 ms p95.

#### Live
live mode: `{ subjects: payload.pairs.map(r => r.subject), fields: ['PX_LAST','CHG_NET_1D','CHG_PCT_1D','PX_OPEN','PX_HIGH','PX_LOW','PX_CLOSE_1D','LAST_TRADE_TIME','SESSION_STATE'], conflationMs: 500 }`. ecb mode: `null` (a stored daily fixing has nothing to stream).
The matrix is not a grid of subjects: `grid#pairs.live.subjectOf = row => row.subject`, and `custom#matrix` registers each `direct` cell against `cell.live = { subject, field:'PX_LAST' }`; `inverse` and `cross` cells subscribe to nothing and are recomputed in the client from their legs on every update, so a cross flashes exactly once per leg change (TERM-08).

#### Screen
```
┌ FXC · FX Cross Matrix · live (indicative mid, 15-min delayed) ─────────────────────┐
│ badges#caveat  [INDICATIVE_MID_ONLY] [NO_FX_DEPTH_SOURCE] [CROSSES_DERIVED_VIA_USD] │
│ tabs#quote  [1 LIVE] [2 ECB 2026-09-15]                                             │
│ custom#matrix  ChartSpec-free grid node (§1.5 'matrix'): 10 × 10                    │
│      base\quote  USD      EUR      GBP      JPY      CHF …                          │
│      USD         —        0.8666   0.7417   155.00   0.8182                         │
│      EUR         1.1543   —        1.1682   178.93   0.9441                         │
│      …  direct cells live+flash; inverse italic; cross muted with a 'via USD' title  │
│ grid#pairs  key | last (live px) | chg (live px) | chg% (live pct) | open | high |   │
│             low | prev close (px) | last trade (datetime) | state glyph              │
│ table#ecbCompare  pair | live | ECB fixing | diff % (pct 3dp)                        │
│ footer: sources ['Yahoo Finance chart (unofficial, 15-min delayed)','European        │
│         Central Bank reference rates via frankfurter.dev'] asOf                      │
└────────────────────────────────────────────────────────────────────────────────────┘
```
`custom#matrix` is a matrix node, not a `ChartSpec` (§7.2 rule 8 does not apply — it builds no chart). Title `FXC · FX Cross Matrix`; subtitle `live · 10 currencies` or `ECB reference · <rateDate>`. `initialFocus:'matrix'`; arrow keys walk cells and the focused cell's derivation is shown in the key bar. Skeleton = the caveat badges plus a 10 × 10 muted matrix and a 9-row muted `pairs` grid. Denied fields (`meta.entitlement`) blank the whole `pairs` column with `—` and the reason tooltip; an eod-only user (`eod@demo`) sees `PX_CLOSE_1D` values and `—` for `PX_LAST` with `NOT_ENTITLED_TIER` (ENTL-05). `meta.staleness:'stale'` (Yahoo circuit open, or an ECB fixing older than two `TARGET2` business days) puts the stale glyph on the subtitle (TERM-12).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `1` / `2` | always | `tab-quote` | `ctx.setParams({ quote: 'live' \| 'ecb' })` (usage `fn.param`) |
| `T` | always | `toggle-transpose` | `setParams({ transpose: !transpose })` |
| `+` / `-` | always | `more-decimals` / `fewer-decimals` | `setParams({ decimals })` over `auto → 2 → 4 → 5 → auto` |
| `D` | tab ECB | `set-date` | `ctx.prompt('date', { label:'ECB fixing date' })` → `setParams({ date })` |
| `Enter` | matrix (direct/inverse cell) | `open-des` | `ctx.navigate(cell.key + ' DES')` |
| `Enter` | matrix (cross cell) | `show-derivation` | opens a `kv` overlay with `derivation`, `via`, both leg values, both leg `provIdx` and `Ctrl+I` provenance |
| `Shift+Enter` | matrix | `open-des-next` | `ctx.navigateNext(cell.key + ' DES')` (direct/inverse only) |
| `G` | matrix / grid `pairs` | `open-gp` | `ctx.navigate(cell.key + ' GP')` |
| `H` | matrix / grid `pairs` | `open-hp` | `ctx.navigate(cell.key + ' HP')` |
| `Ctrl+W` | grid `pairs` | `add-watchlist` | `ctx.prompt('watchlist')` then `sdk.watchlists.setItems` with the nine pair instrument ids |
| `B` | always | `open-btmm` | `ctx.navigate('BTMM')` |

#### CSV
`filename = 'FXC_' + quote.toUpperCase() + '_' + asOf.replace(/[-:]/g,'') + '.csv'`. Static `columns`: `base,quote,rate,kind,via,derivation,chgPct1d,decimals,asOf,sourceId` — one row per matrix cell excluding `unity` (`ccys.length × (ccys.length − 1)` = 90 rows for the default axes), ordered row-major in the payload's axis order, followed by the `pairs` rows re-expressed as `kind='direct'` (already present, so no duplication: the `pairs` grid is a projection of the direct cells, not extra data). `rate` is `cell.v` at full precision; `sourceId` is `yahoo.chart` for live cells and `frankfurter` for ecb cells, and for a `cross` cell it is the comma-joined source ids of its two legs.
Example row: `EUR,JPY,178.93125,cross,USD,EURUSD × USDJPY,-0.0846,2,2026-09-15T18:41:28Z,yahoo.chart`.

#### Help
summary `G10 cross-rate matrix: direct pairs live, crosses derived via USD, ECB reference toggle`; description `FXC shows every cross between the selected currencies in one matrix. Nine pairs are real instruments quoted against the US dollar and update live from the ticker plant; every other cell is derived — an inverse of a quoted pair, or a cross computed through the dollar — and says so, with the exact derivation available on Enter. Press 2 for the ECB reference fixing instead of the live mid, and D to pick a fixing date. The comparison table shows how far the delayed indicative mid sits from the ECB fixing for the same day. There are no bid/ask spreads and no forward points: the reachable sources publish an indicative mid only, and interbank FX is out of scope for this build.`; params: `ccys` ("ISO currency codes, comma-separated", example `FXC EUR,USD,JPY`), `quote` ("live or ecb", `SRC=ECB`), `date` ("ECB fixing date", `DT=2026-09-15`), `decimals` ("auto, 2, 4 or 5", `DEC=5`), `transpose` ("swap the axes", `T=1`); sources `['yahoo.chart','frankfurter']`; related `['BTMM','WB','GP','HP','DES','PORT']`.

#### Unavailable and reason codes
`{ field:'bidAsk', reason:'NO_SOURCE', detail:'NO_FX_DEPTH_SOURCE: no reachable source publishes an FX bid/ask; PX_BID and PX_ASK are absent for fx instruments' }` ·
`{ field:'forwardPoints', reason:'NOT_APPLICABLE', detail:'NO_FORWARD_POINTS_SOURCE: FX forwards and the swap curve are out of scope (DATA-05, BRIEF §1)' }` ·
`{ field:'<CCY>', reason:'NO_SOURCE', detail:'no seeded USD pair for this currency' }` per entry of `missing[]` ·
`{ field:'matrix.<base><quote>', reason:'NO_SOURCE', detail:'one leg of the cross is unavailable' }` ·
ecb mode `{ field:'chgPct1d', reason:'NOT_APPLICABLE', detail:'the ECB publishes one daily fixing; there is no intraday change' }`.
Footer notes: `INDICATIVE_MID_ONLY`, `NO_FX_DEPTH_SOURCE`, `CROSSES_DERIVED_VIA_USD`, `ECB_FIXING_STALE`. Entitlement: `SOURCE_TIER_CAP` on `yahoo.chart` (`max_tier 'delayed'`) downgrades every live cell with reason `SOURCE_TIER_CAP`; `frankfurter` is `redistribution true` / `non_display true`, so the ECB tab is the one FX view an export- or API-only grant can always serve (PROVIDERS §5.7).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared) |
| golden payload | `packages/server/test/integration/functions/FXC.golden.test.ts` | live mode at the frozen clock deep-equals `FXC.default.json` from `yahoo-fx` (EURUSD 1.1543); ecb mode from `frankfurter` (`date 2026-09-15`, `EUR 0.86663` → `EURUSD 1.153895…`, `USDJPY 155`); every `cross` cell equals the product of its legs to 1e-12; every `inverse` cell equals `1 / direct` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `FXC.default.csv`; 90 data rows; numeric cells equal payload values |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at a frozen clock (API-05) |
| screen | `packages/web/test/screens/FXC.test.tsx` | renders both goldens; `1`/`2` switch mode; `T` transposes; `+`/`-` change decimals; direct cells register `Cell.live`, cross cells register none; Enter on a cross opens the derivation overlay; skeleton |
| cross arithmetic | `packages/core/test/functions/fxcCross.test.ts` | property test: for every triple of the ten currencies, `rate(a,b) × rate(b,c) × rate(c,a) === 1` within 1e-9 on the golden matrix; a null leg propagates `st:'na'` and never a `NaN` |
| entitlement | `packages/server/test/integration/functions/FXC.entitlement.test.ts` | `eod@demo` gets `PX_LAST` denied with `NOT_ENTITLED_TIER` and `PX_CLOSE_1D` allowed; the ecb tab is fully populated for the same user (ENTL-05) |
| e2e | `packages/e2e/tests/rates-morning.spec.ts` (shared with BTMM) | `FXC <GO>`, matrix renders 10 × 10, a replayed EURUSD tick flashes the EUR row and the EURJPY cross in the same frame (TERM-08) |

---

### WB — World Bond Markets

| Attribute | Value |
| --- | --- |
| Code / aliases | `WB` / `BONDS` (no `aliasParams`) |
| Tier / category | 2 / monitor |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/WB.ts` · `packages/server/src/functions/WB/resolve.ts` · `packages/web/src/screens/WB/Screen.tsx` · `fixtures/golden/functions/WB.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (DATA-07) (DATA-10) (STOR-06) (TERM-08) (TERM-12) (ENTL-05) (API-05) |

#### Params
```ts
export const WbParams = z.object({
  region: z.enum(['ALL', 'AMERICAS', 'EMEA', 'APAC']).default('ALL'),
  tenor: z.enum(['2Y', '10Y', '30Y']).default('10Y'),
  spreadTo: z.enum(['US', 'NONE']).default('US'),
  chgWindow: z.enum(['1D', '1W', '1M', '1Y']).default('1D'),
  sort: z.enum(['region', 'yield', 'spread', 'chg']).default('region'),
});
```
#### Argument grammar
`positional [{ name:'region', type:'enum', values:['ALL','AMERICAS','EMEA','APAC'], optional:true }, { name:'tenor', type:'enum', values:['2Y','10Y','30Y'], optional:true }]`, `keyed { SPR: { name:'spreadTo', type:'enum', values:['US','NONE'] }, CHG: { name:'chgWindow', type:'enum', values:['1D','1W','1M','1Y'] }, SORT: { name:'sort', type:'enum', values:['region','yield','spread','chg'] } }`, no `rest`.
Examples: `WB` → `{ region:'ALL', tenor:'10Y', spreadTo:'US', chgWindow:'1D', sort:'region' }` · `WB EMEA` → `{ region:'EMEA' }` · `BONDS APAC 10Y CHG=1M SORT=spread` → `{ region:'APAC', tenor:'10Y', chgWindow:'1M', sort:'spread' }`.

#### Payload
```ts
export type WbRegion = 'AMERICAS' | 'EMEA' | 'APAC';
export interface WbCountryRow {
  iso: string;                    // 'US','DE','JP' — ISO 3166-1 alpha-2, = econ_series.country
  country: string; region: WbRegion; ccy: string;
  tenor: '2Y' | '10Y' | '30Y';
  seriesCode: string | null;      // econ_series.series_code ('DGS10', 'IRLTLT01DEM156N'); null when no series is seeded
  sourceId: 'treasury.yieldcurve' | 'fed.h15' | 'fred.csv' | null;
  frequency: 'D' | 'M' | null;    // OECD long-term rates are MONTHLY; the US curve is daily
  yield: ValueCell;               // percent
  asOfDate: string | null;        // obs_date / curve_date of the value in `yield`
  chgBp: ValueCell;               // yield(asOfDate) − yield(asOfDate − chgWindow), ×100
  spreadBp: ValueCell;            // yield − US yield of the same tenor, ×100; { v:null, st:'na' } when spreadTo='NONE'
  curve: { t2y: ValueCell; t10y: ValueCell; t30y: ValueCell };   // populated for the US only; NO_SOURCE elsewhere
  subject: string | null;         // 'e:<seriesCode>'; 'q:<instrumentId>' for the US intraday proxy row
  lagDays: number | null;         // ctx.asOf.validAt − asOfDate, in calendar days — the honest freshness number
  provIdx: number;
  unavailableReason: 'NO_RECORDED_FIXTURE' | 'NO_OECD_SERIES_FOR_TENOR' | 'NO_SERIES_SEEDED' | null;
}
export type WbPayload = {
  variant: 'default';
  tenor: '2Y' | '10Y' | '30Y'; chgWindow: '1D' | '1W' | '1M' | '1Y'; spreadTo: 'US' | 'NONE';
  us: { curveDate: string; points: CurvePointRow[];                       // UST_PAR, all tenors (shared CurvePointRow, BTMM entry)
        intraday: MonitorRow | null };                                    // 'TNX Index' (Cboe 10-year yield index, yahoo.chart ^TNX)
  rows: WbCountryRow[];
  regions: Array<{ region: WbRegion; count: number; withData: number }>;
  notes: string[];                // 'OECD_MONTHLY_LAG', 'NO_NON_US_INTRADAY', 'NO_RECORDED_FIXTURE'
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `econ_series` (`series_code`, `source_id 'fred.csv'`, `provider_code`, `country`, `frequency`, `units`, `decimals`, `instrument_id`, `last_obs_date`), `econ_observations` (`is_latest` vintage with `vintage_at ≤ ctx.asOf.knownAt`, STOR-06), `curve_points` (`UST_PAR` for the US row and the `us.points` block), `curves`, `instruments` (asset_class `econ` for the `e:` subjects, asset_class `index` for `TNX Index`), `md_lines`, `quote_snapshots`, `calendars` (`USGOVT`), `provenance` |
| Data services (§1.4.2) | `data.econ.series`, `data.econ.observations`, `data.curves.points`, `data.reference.instrument`, `data.reference.calendar`, `plant.subjectFor`, `plant.snapshot`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | `('fred.series', seriesCode, { maxAgeMs: 21_600_000 })` per row whose `econ_series.last_updated_at` is older than six hours **and** whose provider code has a recorded fixture; in `PROVIDER_MODE=replay` (goldens and `npm test`) only `DGS10` is recorded, so every other call returns the replay-store miss and the row is marked `NO_RECORDED_FIXTURE` rather than fetched. No read-through for `treasury.yieldcurve` (not a `ReadThroughKind` member) |
| Engines (`core/analytics`) | None. `chgBp` and `spreadBp` are resolver arithmetic on two published observations; `meta.engines` is empty |
| Subjects (live) | `e:<seriesCode>` for every row with a seeded series (one delta per release/vintage); `q:<instrumentId>` for `us.intraday` (`TNX Index`) |
| Field ids (`fieldIds(assetClass)`) | `default: [ECO_VALUE, ECO_PERIOD, ECO_PRIOR, ECO_VINTAGE, ECO_RELEASE_DT, CRV_2Y, CRV_10Y, CRV_30Y, PX_LAST, CHG_NET_1D, CHG_PCT_1D]` |

#### Resolver
`default` (`resolve`; no `variants`):
1. The country table is a constant of the manifest (`packages/core/src/functions/manifests/WB.ts`), sixteen rows: **AMERICAS** `US` (USD), `CA` (CAD), `MX` (MXN), `BR` (BRL); **EMEA** `DE` (EUR), `FR` (EUR), `IT` (EUR), `ES` (EUR), `GB` (GBP), `CH` (CHF), `SE` (SEK), `NO` (NOK); **APAC** `JP` (JPY), `AU` (AUD), `NZ` (NZD), `KR` (KRW). Each carries its FRED OECD long-term-rate provider code `IRLTLT01<ISO3>M156N` (`IRLTLT01DEM156N`, `IRLTLT01JPM156N`, …). `params.region !== 'ALL'` filters the list before any query.
2. **US row and `us` block.** `pts = await ctx.data.curves.points('UST_PAR')` → `us.curveDate`, `us.points` as `CurvePointRow`s (the same shared type BTMM builds, ascending `tenor_days`, `fieldId = 'CRV_' + tenor` where the id exists). The US `WbCountryRow.yield` is the `params.tenor` point of that curve (`sourceId:'treasury.yieldcurve'`, `frequency:'D'`), `chgBp` against the curve date `chgWindow` back (`1D` = the previous stored `curve_date`; `1W`/`1M`/`1Y` = the newest `curve_date ≤ asOfDate − window`). `us.intraday` = a `MonitorRow` over `q:<TNX Index>` with `PX_LAST`, `CHG_NET_1D`, `CHG_PCT_1D` built by `cellFromState` after `plant.ensureHot` — the Cboe ten-year yield index is the only intraday yield in the reachable source set, and its `PX_LAST` is the index level (yield × 10 as Yahoo publishes `^TNX`; the adapter divides by 10, PROVIDERS §5.5).
3. **Non-US rows.** For `params.tenor === '10Y'`: `series = await ctx.data.econ.series(seriesCode)` then `obs = await ctx.data.econ.observations(seriesCode, { from: asOfDate − 18 months, knownAt })` in one batched call per country. `yield` is a stored-value cell from the newest `is_latest` observation (`st:'closed'`, `ts` = `obs_date`, `provIdx = ctx.prov.add(obs.provenance_id)`), `asOfDate = obs_date`, `frequency:'M'`, `sourceId:'fred.csv'`, `lagDays = daysBetween(obs_date, ctx.asOf.validAt)`. `chgBp` uses the observation `chgWindow` back (`1D` on a monthly series is `NOT_APPLICABLE` → `{ v:null, st:'na', r:'NOT_APPLICABLE' }` with the note `OECD_MONTHLY_LAG`).
   For `params.tenor` of `2Y` or `30Y` on a non-US country: `yield` is `{ v:null, st:'na', r:'NO_SOURCE' }`, `unavailableReason:'NO_OECD_SERIES_FOR_TENOR'` and `ctx.unavailable.add({ field:'yield.'+iso, reason:'NO_SOURCE', detail:'NO_OECD_SERIES_FOR_TENOR: the OECD long-term interest-rate series is a ten-year benchmark only' })` — the 2Y and 30Y tabs are a US-only view, stated on screen rather than filled with a substitute tenor.
4. **Replay honesty.** When `data.econ.observations` returns nothing for a seeded series because the replay store has no recorded response for its provider code, the row keeps `yield` null with `unavailableReason:'NO_RECORDED_FIXTURE'` and `ctx.unavailable.add({ field:'yield.'+iso, reason:'NO_SOURCE', detail:'NO_RECORDED_FIXTURE: no recorded fred.csv response for ' + providerCode + '; run npm run test:live or record the fixture' })`. When the series itself is not in `econ_series`, `unavailableReason:'NO_SERIES_SEEDED'` with the same reason and a different detail. No value is ever interpolated, carried forward from another country, or substituted from a different tenor.
5. **Spreads.** `spreadTo === 'US'` → `spreadBp = (row.yield.v − usRow.yield.v) × 100` rounded to 1 dp, `provIdx` of `row.yield`, `st` the worse of the two states; a null on either side gives `{ v:null, st:'na', r:'NO_SOURCE' }`. The spread mixes a daily US par yield with a monthly OECD observation, so every spread cell carries the note `OECD_MONTHLY_LAG` in its title and the row shows both `asOfDate` values — the screen never implies the two numbers are the same day.
6. `regions` counts rows and rows with a non-null `yield` per region. Sorting is applied per `params.sort` (`region` = the table order above; `yield`/`spread`/`chg` descending with null cells last, so a missing source sinks rather than sorting as zero).
7. `notes` = `['OECD_MONTHLY_LAG', 'NO_NON_US_INTRADAY']` plus `'NO_RECORDED_FIXTURE'` when any row carries that reason.
Budget: 2 DB round-trips (curve + compare dates; one batched `econ_observations` query across all requested series) + 1 plant snapshot; zero provider calls in replay mode; < 150 ms p95.

#### Live
`{ subjects: [...payload.rows.filter(r => r.subject?.startsWith('e:')).map(r => r.subject!), ...(payload.us.intraday ? [payload.us.intraday.subject] : [])], fields: ['ECO_VALUE','ECO_PERIOD','ECO_RELEASE_DT','ECO_VINTAGE','PX_LAST','CHG_NET_1D','CHG_PCT_1D'], conflationMs: 2000 }`.
`e:` subjects are subscribed with `f: []` (API.md §6.1 allows the empty set only for `c:`/`e:`/`n:`/`sys:`/`alerts:`/`room:`), so the client intersection rule (Tier 1 §0.4 rule 5) sends the econ family unfiltered and the `q:` family with the three quote fields. `grid#rows.live.subjectOf = row => row.subject`; a monthly series fires at most one delta per release, so the flash on a WB row means a new print, not a tick.

#### Screen
```
┌ WB · World Bond Markets · 10Y benchmark ───────────────────────────────────────────┐
│ tabs#tenor  [1 2Y] [2 10Y] [3 30Y]     badges  [OECD_MONTHLY_LAG] [NO_NON_US_INTRADAY]│
│ kv#us    US par curve 2026-09-11 · 2Y 4.63 · 10Y 4.96 · 30Y 5.35 (pct 2dp)          │
│          TNX Index 4.99 (live px) · chg +0.039 (live px) · +0.79% (live pct)        │
│ grid#rows  group by region (AMERICAS / EMEA / APAC)                                 │
│   country (text) | ccy (text) | yield (pct 2dp, live) | as of (date) | freq (text)  │
│   | chg 1D bp (bp 1dp, ± tone) | spread vs US bp (bp 1dp) | lag d (int) | src (text)│
│   rows with no source render yield '—' with the reason code as the cell title and   │
│   tone 'muted'; region sub-headers show 'withData / count'                          │
│ footer: sources ['US Treasury par yields','FRED (OECD long-term interest rates)',    │
│         'Cboe delayed quotes'] asOf  notes: OECD_MONTHLY_LAG, NO_RECORDED_FIXTURE?   │
└────────────────────────────────────────────────────────────────────────────────────┘
```
Title `WB · World Bond Markets`; subtitle `<tenor> benchmark · chg <chgWindow> · spread vs <spreadTo>`. `initialFocus:'rows'`. Skeleton = three tabs, a 4-line muted `kv#us` and a 16-row muted grid grouped into three regions. `meta.unavailable` renders as the `badges` row plus the per-cell `—` with reason; `meta.entitlement` denials blank the `yield` column with `—` and the `ReasonCode` tooltip (ENTL-05); `meta.staleness:'stale'` (`fred.csv` circuit open, or a US curve date more than three `USGOVT` business days old) shows the stale glyph on the subtitle and on the affected rows (TERM-12). `lagDays` is always visible: it is the screen's statement that a monthly OECD print is not today's market.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `1`…`3` | always | `tab-tenor` | `ctx.setParams({ tenor: '2Y' \| '10Y' \| '30Y' })` (usage `fn.param`) |
| `R` | always | `cycle-region` | `ALL → AMERICAS → EMEA → APAC → ALL` via `setParams({ region })` |
| `C` | always | `cycle-chg-window` | `1D → 1W → 1M → 1Y → 1D` via `setParams({ chgWindow })` |
| `S` | always | `cycle-sort` | `region → yield → spread → chg → region` via `setParams({ sort })` |
| `P` | always | `toggle-spread` | `setParams({ spreadTo: spreadTo === 'US' ? 'NONE' : 'US' })` |
| `Enter` | grid `rows` | `open-gp` | `ctx.navigate(row.seriesCode + ' Index GP')` (the econ `series` variant of GP); rows with `seriesCode === null` do nothing |
| `Shift+Enter` | grid `rows` | `open-gp-next` | `ctx.navigateNext(row.seriesCode + ' Index GP')` |
| `H` | grid `rows` | `open-hp` | `ctx.navigate(row.seriesCode + ' Index HP')` (the `series` variant, full observation history) |
| `D` | grid `rows` | `open-des` | `ctx.navigate(row.seriesCode + ' Index DES')` (econ DES variant: units, frequency, release, vintages) |
| `V` | always | `open-crvf` | `ctx.navigate('CRVF')` |
| `B` | always | `open-btmm` | `ctx.navigate('BTMM')` |
| `X` | always | `open-fxc` | `ctx.navigate('FXC')` |

#### CSV
`filename = 'WB_' + tenor + '_' + asOf.replace(/[-:]/g,'') + '.csv'`. Long format (§1.6 rule 3), static `columns`: `section,iso,country,region,ccy,tenor,seriesCode,yield,asOfDate,frequency,chgBp,spreadBp,lagDays,sourceId,reason` — `section` ∈ `us_curve | country`. The `us_curve` rows are one per `us.points[]` entry (`iso='US'`, `tenor` = the point's tenor, `yield` = the par yield, `seriesCode` empty, `sourceId='treasury.yieldcurve'`); the `country` rows are one per `rows[]` entry in payload order. A row with no value writes an empty `yield` and its `unavailableReason` in `reason`, so the export states the gap instead of hiding it (FUNC-03).
Example rows: `us_curve,US,United States,AMERICAS,USD,10Y,,4.96,2026-09-11,D,,,0,treasury.yieldcurve,` · `country,DE,Germany,EMEA,EUR,10Y,IRLTLT01DEM156N,,,M,,,,fred.csv,NO_RECORDED_FIXTURE`.

#### Help
summary `Benchmark government yields by country with spreads to the US Treasury curve`; description `WB lists the benchmark government bond yield for each covered country beside the US Treasury par curve. The United States is daily and comes from the Treasury's own par yield curve, with the Cboe ten-year yield index as the only intraday line. Every other country is the OECD long-term interest rate published monthly through FRED, so each row shows the observation date, the frequency and how many days old the number is, and the spread column mixes a daily US yield with a monthly foreign print — the screen says so rather than pretending they are the same day. The OECD series is a ten-year benchmark only, so the 2Y and 30Y tabs are a US curve view. A country whose series has no recorded provider response shows a reason code instead of a number.`; params: `region` ("ALL, AMERICAS, EMEA or APAC", example `WB EMEA`), `tenor` ("2Y, 10Y or 30Y", `WB ALL 30Y`), `spreadTo` ("US or NONE", `SPR=NONE`), `chgWindow` ("1D, 1W, 1M or 1Y", `CHG=1M`), `sort` ("region, yield, spread or chg", `SORT=spread`); sources `['treasury.yieldcurve','fred.csv','yahoo.chart','cboe.quotes']`; related `['BTMM','CRVF','GC','GP','HP','ECO','FXC']`.

#### Unavailable and reason codes
`{ field:'yield.<ISO>', reason:'NO_SOURCE', detail:'NO_RECORDED_FIXTURE: no recorded fred.csv response for <providerCode>; only DGS10 is in fixtures/providers/raw/ (BRIEF §2)' }` ·
`{ field:'yield.<ISO>', reason:'NO_SOURCE', detail:'NO_SERIES_SEEDED: econ_series has no row for <providerCode>' }` ·
`{ field:'yield.<ISO>', reason:'NO_SOURCE', detail:'NO_OECD_SERIES_FOR_TENOR: the OECD long-term interest-rate series is a ten-year benchmark only' }` ·
`{ field:'chgBp.<ISO>', reason:'NOT_APPLICABLE', detail:'OECD_MONTHLY_LAG: a monthly series has no one-day change' }` ·
`{ field:'intraday.<ISO>', reason:'NOT_APPLICABLE', detail:'NO_NON_US_INTRADAY: no reachable source publishes intraday non-US government yields' }` ·
`{ field:'spreadBp.<ISO>', reason:'NO_SOURCE', detail:'one leg of the spread is unavailable' }`.
Footer notes: `OECD_MONTHLY_LAG`, `NO_NON_US_INTRADAY`, `NO_RECORDED_FIXTURE`, `CURVE_STALE` (the shared US-curve note of the BTMM entry). Entitlement: `fred.csv` is `redistribution false`, so an API-usage grant without the `fred.csv` source yields `NO_FIRM_ENTITLEMENT` on the non-US `yield` cells while the US curve (`treasury.yieldcurve`, public domain) still resolves; `PROVIDER_DOWN` on `fred.csv` with stored observations → `st:'stale'`, `meta.staleness:'stale'`, no throw.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared) |
| golden payload | `packages/server/test/integration/functions/WB.golden.test.ts` | resolver at the frozen clock deep-equals `WB.default.json`: `us.points` from `treasury-xml2`, the US 10Y row from the same curve date, the `TNX Index` row from `yahoo-bond`, and fifteen non-US rows each with `yield.v === null` and `unavailableReason === 'NO_RECORDED_FIXTURE'`; `regions` counts `withData` 1 of 16 |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `WB.default.csv`; the `reason` column is populated on exactly the rows whose `yield` is empty |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at a frozen clock (API-05) |
| screen | `packages/web/test/screens/WB.test.tsx` | renders the golden; three tenor tabs by `1`–`3`; `R`/`C`/`S`/`P` call `setParams`; missing rows render `—` with the reason title and tone `muted`; the `TNX Index` cell registers `Cell.live`; skeleton |
| degraded sources | `packages/server/test/integration/functions/WB.unavailable.test.ts` | inserting a synthetic `IRLTLT01DEM156N` observation (2026-07-01, 2.71) makes the DE row resolve with `frequency:'M'`, `lagDays 76`, `chgBp` `NOT_APPLICABLE` at `chgWindow='1D'` and a computed value at `chgWindow='1Y'`; `tenor='30Y'` returns `NO_OECD_SERIES_FOR_TENOR` for DE and a value for US |
| spread arithmetic | `packages/server/test/integration/functions/WB.spread.test.ts` | with the synthetic DE observation, `spreadBp` equals `(2.71 − usYield) × 100` to 1 dp and carries the worse of the two cell states; `spreadTo='NONE'` blanks the column with `st:'na'` |
| e2e | `packages/e2e/tests/rates-morning.spec.ts` (shared with BTMM and FXC) | `WB <GO>` after BTMM: the US row shows a value and the non-US rows show reason codes, `Ctrl+P` exports a CSV whose `reason` column matches the screen |
