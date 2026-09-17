### WEI — World Equity Indices

| Attribute | Value |
| --- | --- |
| Code / aliases | `WEI` / `INDICES` |
| Tier / category | 1 / monitor |
| Asset classes → variants | `none → default` (the rows are `index` instruments; the function itself takes no security, FUNC-02) |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/WEI.ts` · `packages/server/src/functions/WEI/resolve.ts` · `packages/web/src/screens/WEI/Screen.tsx` · `fixtures/golden/functions/WEI.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (FEED-03) (FEED-05) (FEED-06) (BUS-02) (BUS-03) (BUS-04) (REF-06) (REF-07) (TERM-06) (TERM-08) (TERM-11) (TERM-12) (ANAL-07) (DATA-10) (ENTL-05) (NFR-02) |

#### Params
```ts
export const WeiRegion = z.enum(['Americas', 'EMEA', 'APAC']);
export const WeiParams = z.object({
  regions: z.array(WeiRegion).min(1).max(3).default(['Americas', 'EMEA', 'APAC']),
  columns: z.array(FieldId).min(1).max(20).default(['PX_LAST', 'CHG_NET_1D', 'CHG_PCT_1D', 'RET_1W', 'RET_1M', 'RET_YTD', 'RET_1Y', 'PX_HIGH_52W', 'PX_LOW_52W', 'SESSION_STATE']),
  view: z.enum(['returns', 'levels']).default('returns'),                 // 'levels' swaps RET_* for PX_OPEN/PX_HIGH/PX_LOW/PX_CLOSE_1D/PX_VOLUME
  sort: SortSpec.optional(),                                              // within a region; default is the seeded display order
  codes: z.array(z.string().max(12)).max(40).optional(),                  // explicit indices.code list; overrides `regions`
});
```
`RET_YTD` is a **new field id** — it is not in the API.md §7 dictionary excerpt nor in §0.3, and is defined here (additions required): label `Year-to-date return`, type `number / pct`, decimals `2`, `fieldClass:'analytic'`, derivation `close(t) / close(lastSessionOfPreviousYear) − 1` from `bars_daily` under `AdjustPolicy 'price'` using `core/analytics/stats` (§0.6 conventions), asset classes `equity, etf, index, fx, crypto`, `sources: { assetClass:'*', sourceId:'internal.derived', endpoint:'bars_daily', providerPath:'core/analytics/stats' }`, `updateFreq:'daily'`, `pit:false`, `since:'2026.09.1'`. Every other id in `columns` is already in the dictionary (API.md §7 excerpt) or in §0.3.

#### Argument grammar
`positional [{ name:'regions', type:'string', optional:true }]` (comma-separated region names, case-insensitive: `AMERICAS,EMEA,APAC`), `keyed { CODES: { name:'codes', type:'string' } /* 'SPX,UKX,NKY' */, COLS: { name:'columns', type:'string' } /* comma-separated field ids */, VIEW: { name:'view', type:'enum', values:['returns','levels'] }, SORT: { name:'sort', type:'string' } /* 'CHG_PCT_1D:desc' */ }`, no `rest`.
Examples: `WEI` → `{ regions:['Americas','EMEA','APAC'], columns:[defaults], view:'returns' }` · `WEI EMEA` → `{ regions:['EMEA'] }` · `WEI CODES=SPX,UKX,NKY VIEW=LEVELS SORT=CHG_PCT_1D:desc` → `{ codes:['SPX','UKX','NKY'], view:'levels', sort:{ col:'CHG_PCT_1D', dir:'desc' } }`.

#### Payload
```ts
/** One index row. Extends the shared MonitorRow (§0.2) so the grid, cell registry and CSV writer are the ones QM and W use. */
export interface WeiRow extends MonitorRow {
  code: string;                                      // indices.code — 'SPX','NDX','RTY','INDU','VIX','UKX','DAX','CAC','SX5E','NKY','HSI','AS51','BUK100P'
  region: z.infer<typeof WeiRegion>;                 // index_terms.region, normalised to the three buckets (Resolver step 2)
  indexProvider: string | null;                      // index_terms.provider — 'S&P Dow Jones','Cboe','FTSE Russell','Nikkei','STOXX'
  methodology: 'cap_weighted' | 'float_cap_weighted' | 'price_weighted' | 'equal_weighted' | 'volatility' | 'other';   // index_terms.methodology
  calcCurrency: string;                              // index_terms.calc_currency — values are LOCAL currency, never USD-converted
  mic: string | null;                                // listings.mic of the primary listing (null for Yahoo-only indices)
  calendarId: string | null;                         // exchanges.calendar_id; null when no calendar is seeded for the venue
  sessionState: SessionState;                        // 'pre'|'open'|'auction'|'halted'|'closed'|'post'|'unknown'
  sessionSource: 'calendar' | 'provider' | 'none';   // FEED-06: derived from calendar_sessions, from the provider payload, or unknown
  localTime: string | null;                          // asOf rendered in exchanges.tz ('16:59:53 BST'); null when calendarId is null
  membershipAvailable: boolean;                      // indices.membership_source_id !== null (true only for SPX in v1) — gates the M key
  historySessions: number;                           // bars_daily rows behind the RET_* cells; 0 → those cells are 'na'
}
export type WeiPayload = {
  variant: 'default';
  regions: Array<{ region: z.infer<typeof WeiRegion>; label: string; rows: WeiRow[] }>;   // in params.regions order; empty regions are omitted
  columns: MonitorColumn[];                          // §0.2, in params.columns order (or the 'levels' set), label/fmt/decimals from the dictionary
  view: 'returns' | 'levels';
  sort: SortSpec | null;
  conventions: Conventions;                          // §0.6, echoed so the RET_* basis is on the screen and in the CSV header
  counts: { rows: number; live: number; pending: number; stale: number; blank: number; na: number };
  skipped: Array<{ code: string; reason: 'INDEX_NOT_SEEDED' | 'NO_MD_LINE' }>;
  asOf: string;                                      // ctx.clock.now() at resolve, ISO
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `indices`, `index_terms` (as-of `ctx.asOf`), `instruments` (current), `listings` (current), `exchanges`, `calendars`, `calendar_sessions`, `calendar_holidays`, `md_lines` (as-of — provider symbol per row), `quote_snapshots` (through the plant), `bars_daily` (RET_* and 52-week cells) |
| Data services (§1.4.2) | `data.snapshot.fields` (plant + reference merge, entitlement-filtered), `data.reference.calendar`, `data.historical.bars`, `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | None (§0.4 rule 2 — WEI is a monitor; cold subjects are pending and the scheduler polls them). |
| Engines (`core/analytics`) | `stats@1.0.0` via `periodReturns` (§0.1, §0.6); one `ctx.engines.add({ name:'stats', version:'1.0.0', inputsHash })` for the whole payload |
| Subjects (live) | `q:<instrumentId>` per row (≤ 40 rows) |
| Field ids (`fieldIds(null)`) | `default`: `[PX_LAST, CHG_NET_1D, CHG_PCT_1D, PX_OPEN, PX_HIGH, PX_LOW, PX_CLOSE_1D, PX_OFFICIAL_CLOSE, PX_VOLUME, LAST_TRADE_TIME, SESSION_STATE, IVOL_30D, RET_1W, RET_1M, RET_YTD, RET_1Y, PX_HIGH_52W, PX_LOW_52W, VOL_30D, NAME, TICKER, EXCH_CODE]` — the entitlement pre-check superset for both views; a `COLS=` id outside this set is still accepted when it is in the dictionary and applies to `index` (the runner re-checks), an id outside the dictionary → `400 VALIDATION_FAILED` `fnParams` |

Providers behind the rows (BRIEF §2), resolved through `md_lines.source_id` / `provider_symbol`, never hard-coded in the resolver:

| Code | Name | Region | Line source | `provider_symbol` | Recorded fixture |
| --- | --- | --- | --- | --- | --- |
| `SPX` | S&P 500 | Americas | `cboe.quotes` (priority 10) + `yahoo.chart` (20) | `_SPX` / `^GSPC` | `cboe-spx`, `yahoo-chart-SPX-5d-5m.json` |
| `VIX` | Cboe Volatility Index | Americas | `cboe.quotes` | `_VIX` | `cboe-vix` |
| `NDX` | Nasdaq 100 | Americas | `yahoo.chart` | `^NDX` | none |
| `INDU` | Dow Jones Industrial Average | Americas | `yahoo.chart` | `^DJI` | none |
| `RTY` | Russell 2000 | Americas | `yahoo.chart` | `^RUT` | none |
| `UKX` | FTSE 100 | EMEA | `yahoo.chart` | `^FTSE` | `yahoo-ftse` |
| `BUK100P` | Cboe UK 100 | EMEA | `cboe.euIndices` | `BUK100P` | `cboe-eu-indices` |
| `DAX` | DAX | EMEA | `yahoo.chart` | `^GDAXI` | none |
| `CAC` | CAC 40 | EMEA | `yahoo.chart` | `^FCHI` | none |
| `SX5E` | EURO STOXX 50 | EMEA | `yahoo.chart` | `^STOXX50E` | none |
| `NKY` | Nikkei 225 | APAC | `yahoo.chart` | `^N225` | none |
| `HSI` | Hang Seng | APAC | `yahoo.chart` | `^HSI` | none |
| `AS51` | S&P/ASX 200 | APAC | `yahoo.chart` | `^AXJO` | none |

#### Resolver
1. **Universe.** One query over `indices` joined to current `instruments`, as-of `index_terms`, current `listings` (`is_primary`) and `exchanges`: `codes` when given, else every seeded index. Rows whose `code` is not in `indices` → `skipped[] { code, reason:'INDEX_NOT_SEEDED' }`; rows with no as-of `md_lines` row → `skipped[] { code, reason:'NO_MD_LINE' }` (the row cannot be a plant subject).
2. **Region bucket.** `region = bucket(index_terms.region)` — `'North America' | 'Americas' | 'US'` → `Americas`; `'Europe' | 'UK' | 'EMEA'` → `EMEA`; `'Asia' | 'Pacific' | 'APAC'` → `APAC`. A region string outside those three → `APAC` is **not** assumed: the row is dropped into the region whose name it equals case-insensitively, and if none matches the row is omitted with `ctx.unavailable.add({ field:'rows.' + code, reason:'NOT_APPLICABLE', detail:'index_terms.region "' + r + '" is not one of Americas/EMEA/APAC' })`. Filter to `params.regions`.
3. **Columns.** `columns = (params.view === 'levels' ? LEVEL_COLUMNS : params.columns).map(monitorColumn)` where `LEVEL_COLUMNS = ['PX_LAST','CHG_NET_1D','CHG_PCT_1D','PX_OPEN','PX_HIGH','PX_LOW','PX_CLOSE_1D','PX_VOLUME','LAST_TRADE_TIME','SESSION_STATE']` (§0.2 `monitorColumn` takes label/fmt/decimals from the dictionary).
4. **Live cells.** `subjects = ids.map(plant.subjectFor)`; `plant.ensureHot(subjects)`; `snap = await data.snapshot.fields(ids, columns.filter(c => isPlantField(c.fieldId)).map(c => c.fieldId!))`. Cells per §0.4 rule 1: a state that exists → `cellFromState(...)`; a subject never polled → `pendingCell(subject, field)` (`st:'blank'`, `provIdx:-1`, rendered `…`). No `providers.ensure` (§0.4 rule 2) — in `PROVIDER_MODE=replay` the nine indices without a recorded fixture are simply pending, which is the honest state and keeps the golden deterministic.
5. **Derived cells.** For each row, `bars = await data.historical.bars(id, { start: asOfDate − 380 calendar days, end: asOfDate, periodicity:'D', adjust:'price' })` (one batched call per row, issued together); `periodReturns(bars, calendar, asOfDate)` (§0.1) fills `RET_1W`, `RET_1M`, `RET_1Y`, `PX_HIGH_52W`, `PX_LOW_52W`, `VOL_30D`; `RET_YTD` = `close(asOfDate) / close(last session of the previous calendar year) − 1`, both from the same `bars` block. These are stored-value/derived cells: `st:'closed'`, `ts` = the last bar's `source_ts`, `provIdx` = the `provIdx` of the bar block's provenance (§0.4 rules 3 and 4). `historySessions = bars.length`; when `historySessions < 2` every `RET_*`/52-week/`VOL_30D` cell is `{ v:null, st:'na', provIdx:-1 }` and one `ctx.unavailable.add({ field:'rows.' + code + '.returns', reason:'NO_SOURCE', detail:'no daily history recorded for ' + code })` is emitted (footer code `NO_DAILY_HISTORY`). `VOL_30D` additionally falls back to `null` with `st:'na'` when fewer than 30 sessions exist, per §0.6.
6. **Session.** When `exchanges.calendar_id` is set: `cal = await data.reference.calendar(calendarId)`, `sessionState = sessionState(cal, now)` (`core/quote/session.ts`, honouring `calendar_holidays.kind='early_close'`), `sessionSource:'calendar'`, `localTime` = `asOf` formatted in `exchanges.tz` (REF-06). When no calendar is seeded for the venue (v1 seeds `XNYS`, `XNAS`, `XCBO`, `XLON` only — `XETR`, `XPAR`, `XTKS`, `XHKG`, `XASX` are not): the plant's `SESSION_STATE` field is used when the adapter derived one from the provider payload (Cboe European indices publish `status` — `"C"` → `closed`, `"T"` → `open`; Yahoo chart publishes `currentTradingPeriod` + `regularMarketTime`), `sessionSource:'provider'`, `calendarId:null`, `localTime:null`; when neither exists, `sessionState:'unknown'`, `sessionSource:'none'` and `ctx.unavailable.add({ field:'rows.' + code + '.session', reason:'NO_SOURCE', detail:'no calendar seeded for ' + (mic ?? 'this venue') + ' and the provider publishes no session state' })` (footer code `NO_CALENDAR_FOR_VENUE`).
7. **Assemble.** `rows` in seeded display order within each region (`instruments.search_weight` desc, then `code`); `sort` is carried in the payload and applied by the screen (client-side, free). `counts` from the cells' `st`. `conventions` = `Conventions` from `core/analytics/stats` (§0.6). Return `{ variant:'default', regions, columns, view, sort, conventions, counts, skipped, asOf }`.
Budget: 2 DB round-trips (universe + calendars are one join; the bar blocks are one batched range query over the `bars_daily` partitions) + one `plant.snapshotMany` over ≤ 40 subjects; first paint < 300 ms p95, well inside the Tier 1 500 ms budget. WEI is the workspace's default first frame, so the resolver never blocks on a provider.

#### Live
`{ subjects: rows.map(r => r.subject), fields: columns.filter(c => c.fieldId && isPlantField(c.fieldId)).map(c => c.fieldId!), conflationMs: 500 }` — half a second is enough for an index monitor and leaves the session's minimum conflation to Q/QM when they are open (BUS-03). `grid.live.subjectOf = row => row.subject`; the `RET_*`, 52-week and `VOL_30D` cells carry no `live` (they are daily, §0.4 rule 3) and never flash. All rows are `essential` (≤ 40 subjects fit the budget, so WEI never marks rows non-essential; BUS-04 shedding still shows a grey `shed` glyph if the server sheds under global overload).

#### Screen
Title `WEI · World Equity Indices`; subtitle `<rows> rows · live <live> · pending <pending> · <view> · returns: simple, close, adjust price, 252d (ANAL-07)`; `initialFocus:'americas'`.
```
┌ WEI · World Equity Indices                    13 rows · live 4 · pending 9 · returns · simple/close/price/252 ┐
│ text#region-americas  AMERICAS                                                                                │
│ grid#americas   code | name          | ccy | last     | chg     | chg%   | 1w%  | 1m%  | ytd% | 1y%  | 52w hi  │
│                 SPX  | S&P 500       | USD | 7,585.75 | −34.23  | −0.45% | …    | …    | …    | …    | 7,816.70│
│                 VIX  | Cboe VIX      | USD |    17.50 | +0.40   | +2.34% | na   | na   | na   | na   | na     │
│                 NDX  | Nasdaq 100    | USD |    …     | …       | …      | …    | …    | …    | …    | …       │
│ text#region-emea      EMEA                                                                                    │
│ grid#emea       UKX  | FTSE 100      | GBP |10,658.13 | −39.44  | −0.37% | …    | …    | …    | …    |10,989.50│
│                 BUK100P | Cboe UK 100| GBP | 1,059.46 | −3.66   | −0.34% | na   | na   | na   | na   | na      │
│ text#region-apac      APAC                                                                                    │
│ grid#apac       NKY  | Nikkei 225    | JPY |    …     | …       | …      | …    | …    | …    | …    | …       │
│ badges#notes  [9 indices pending — no recorded quote] [5 venues without a seeded calendar]                     │
│ footer sources: Cboe delayed quotes (exchange-published, 15-min delayed); Cboe European indices (delayed);      │
│                 Yahoo Finance chart v8 (unofficial; 15-min delayed); derived: terminal analytics (stats 1.0.0)  │
└ asOf 2026-09-15T18:41:28Z                                                                                      ┘
```
Body is `split col [0.06 | 0.31 | 0.31 | 0.32]` over `badges#notes` and one `text#region-<r>` + `grid#<r>` pair per region in `params.regions` order; `frozenColumns: 3` (`code`, `name`, `ccy`). Each grid's extra columns after `columns[]` are `session` (the `sessionState` badge — `open` green, `pre`/`post` blue, `closed` muted, `unknown` grey with the `NO_CALENDAR_FOR_VENUE` tooltip) and `local` (`localTime`, muted, `—` when null). `VIX`'s row shows `methodology: volatility` as a muted suffix on the name. `view:'levels'` replaces the `RET_*` columns with the OHLC/volume set and the subtitle's convention clause with `levels · local currency`. Cells format from the dictionary via `monitorColumn` (`px` with `instruments.price_decimals` as the hint, `pct` 2 dp with sign and up/down colour — TERM-11).
Skeleton (`payload === undefined`): the three region headers and one muted row per seeded code from the frame's previous payload when any (stale-while-revalidate), else 13 muted rows with `…` cells.
`meta.entitlement`: a denied cell renders `—` with the reason tooltip (`TIER_EOD` for `eod@demo` on `PX_LAST`/`CHG_*`, `NO_FIRM_ENTITLEMENT` when the firm has no `cboe.quotes` grant); a column denied for every row collapses to a muted header carrying the reason. `meta.unavailable` entries render as the `badges#notes` chips and, on `Enter` over a chip, as a `text` node listing `field` + `detail`. `meta.staleness:'stale'` adds the amber footer strip `feed stale since <ts>` (TERM-12) — WEI never silently freezes.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid | `open-des` | `ctx.navigate(row.key + ' DES')` (index DES variant) |
| `Shift+Enter` | grid | `open-des-next` | `ctx.navigateNext(row.key + ' DES')` |
| `Q` | grid | `open-q` | `ctx.navigate(row.key + ' Q')` |
| `P` | grid | `open-gp` | `ctx.navigate(row.key + ' GP')` |
| `I` | grid | `open-gip` | `ctx.navigate(row.key + ' GIP')` |
| `M` | grid | `open-memb` | `ctx.navigate(row.key + ' MEMB')` when `row.membershipAvailable`, else a toast `MEMBERSHIP_NOT_AVAILABLE: <code> has no membership source` (no navigation) |
| `Ctrl+I` | grid | `cell-provenance` | `ctx.provenance(cell.provIdx)` — source, captured-at, request key → raw fixture (DATA-10) |
| `V` | always | `cycle-view` | `ctx.setParams({ view: view === 'returns' ? 'levels' : 'returns' })` (usage `fn.param`) |
| `R` | always | `cycle-regions` | cycles `['Americas','EMEA','APAC'] → ['Americas'] → ['EMEA'] → ['APAC'] → all`; `setParams({ regions })` |
| `S` | grid | `sort-column` | sorts the focused column within every region (toggles asc/desc on repeat); `setParams({ sort })` |
| `Shift+S` | grid | `clear-sort` | `setParams({ sort: undefined })` |
| `C` | always | `add-column` | `ctx.prompt('field')` → `setParams({ columns: [...columns, id] })` (max 20) |
| `Shift+C` | grid | `remove-column` | removes the focused column (min 1) |
| `W` | grid | `save-as-watchlist` | `ctx.prompt('text', { label:'Watchlist name' })` → `sdk.watchlists.create({ name, columns: params.columns.map(id => ({ id })), items: visibleRows.map(r => ({ security:{ id:r.instrumentId } })) })` then `ctx.navigate('W ' + name)` |
| `Ctrl+E` | always | reserved | PRINT → `ctx.export()` (`/functions/WEI/csv?resultId=…`) |

#### CSV
`filename = 'WEI_' + params.view + '_' + asOfCompact + '.csv'` (`asOfCompact` = `asOf.replace(/[-:]/g,'').slice(0,15)`, e.g. `20260915T184128`). Columns are payload-dependent (the `columns[]` list varies with `view`/`COLS=`): `region,code,key,name,indexProvider,methodology,calcCurrency,mic,` + `columns[].id` + `,sessionState,sessionSource,localTime,historySessions,state`. One row per `WeiRow` in payload order (regions in `params.regions` order, rows in the payload's display order — the screen sort is a screen concern); values are `cells[col].v` and `state` is the row's worst cell `st`. `# asOf`, `# regenerated` and the attribution lines from `licence_registry.attribution` are written as `#` comment lines first (API.md §9); the `conventions` block is written as one further comment line `# returns: simple, close, adjust=price, annualisation=252, volWindow=30`.
Example: `Americas,SPX,SPX Index,S&P 500,S&P Dow Jones,float_cap_weighted,USD,XCBO,7585.75,-34.23,-0.4492,,,,,7816.70,6316.91,closed,calendar,2026-09-15T14:41:28-04:00,0,closed`.

#### Help
summary `Global index monitor by region with local-currency levels, returns and session state`; description `WEI is the morning screen: every seeded equity index on one page, grouped Americas / EMEA / APAC, with the last level, the change on the day, period returns and the 52-week range. Values are in each index's own calculation currency and are never converted to USD — compare currency-adjusted performance in GP with a currency overlay. S&P 500 and VIX come from Cboe's delayed exchange feed, the Cboe UK 100 from Cboe Europe, the rest from the Yahoo chart endpoint; an index with no recorded quote shows a dotted pending cell until the scheduler polls it, never a stale number presented as live. Returns are simple close-to-close on price-adjusted history; an index without seeded daily history shows na with the reason. Session state comes from the venue calendar where one is seeded and from the provider's own status field otherwise. Enter opens DES, M the members of the index when a membership source exists (S&P 500 only in v1).`; params `regions` ("Americas, EMEA, APAC — comma separated", `WEI EMEA`), `codes` ("explicit index codes", `CODES=SPX,UKX,NKY`), `columns` ("field ids", `COLS=PX_LAST,CHG_PCT_1D,RET_YTD`), `view` ("returns or levels", `VIEW=LEVELS`), `sort` ("column:dir", `SORT=CHG_PCT_1D:desc`); sources `['cboe.quotes','cboe.euIndices','yahoo.chart','sec.archives','ssga.holdings','internal.derived']`; related `['QM','MEMB','GP','GIP','DES','FXC']`.

#### Unavailable and reason codes
| Entry | When | Footer code |
| --- | --- | --- |
| `{ field:'rows.<code>.returns', reason:'NO_SOURCE', detail:'no daily history recorded for <code>' }` | `historySessions < 2` — every `RET_*`, `PX_HIGH_52W`, `PX_LOW_52W`, `VOL_30D` cell is `st:'na'` | `NO_DAILY_HISTORY` |
| `{ field:'rows.<code>.session', reason:'NO_SOURCE', detail:'no calendar seeded for <mic> and the provider publishes no session state' }` | venue calendar absent (`XETR`, `XPAR`, `XTKS`, `XHKG`, `XASX`) and no provider status | `NO_CALENDAR_FOR_VENUE` |
| `{ field:'rows.<code>', reason:'NOT_APPLICABLE', detail:'index_terms.region "<r>" is not one of Americas/EMEA/APAC' }` | an index whose `index_terms.region` maps to no bucket | `REGION_UNMAPPED` |
| `{ field:'usdReturns', reason:'NOT_APPLICABLE', detail:'WEI shows local-currency index levels; no FX conversion is applied' }` | always | `LOCAL_CURRENCY_ONLY` |
| `{ field:'rows.<code>.PX_VOLUME', reason:'NOT_APPLICABLE', detail:'the index source publishes no volume' }` | Cboe index lines (`volume: 0`) and `^FTSE` (`regularMarketVolume: 0`) — the cell is `st:'na'`, never `0` | — |
`skipped[]` (`INDEX_NOT_SEEDED`, `NO_MD_LINE`) renders as a muted footer line `2 codes skipped (Enter for detail)`. Per-cell entitlement: `TIER_EOD` (eod grant sees `PX_CLOSE_1D`/`PX_OFFICIAL_CLOSE`/`PX_OPEN`/`PX_HIGH`/`PX_LOW` and `—` elsewhere), `NO_FIRM_ENTITLEMENT`, `SOURCE_TIER_CAP` in `meta.entitlement` when `realtime` was requested (`cboe.quotes` / `yahoo.chart` cap at `delayed`, `licence_registry.max_tier`). Pending cells render `…` until the first `snap` (§0.4 rule 1). `PROVIDER_DOWN` → cells keep their last values at `st:'stale'` with the amber strip (TERM-12, ENTL-05).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared) |
| golden payload | `packages/server/test/integration/functions/WEI.golden.test.ts` | `WEI` at the frozen clock `2026-09-15T18:41:28Z` deep-equals `WEI.default.json`: 13 rows in 3 regions; `SPX` `PX_LAST.v === 7585.75`, `CHG_NET_1D.v === -34.23`, `CHG_PCT_1D.v === -0.4492`, `provIdx` cites `cboe-spx`; `VIX` `PX_LAST.v === 17.5`, `CHG_PCT_1D.v === 2.3392`; `UKX` `PX_LAST.v === 10658.13`, `CHG_NET_1D.v === -39.44` from `yahoo-ftse`; `BUK100P` `PX_LAST.v === 1059.4557`, `sessionSource === 'provider'`, `sessionState === 'closed'` (Cboe `status:'C'`); the nine indices without a fixture have every plant cell `{ st:'blank', provIdx:-1 }` and no `r`; `counts.pending === 9` |
| resolver unit | `packages/server/test/unit/functions/WEI.resolve.test.ts` | against the seeded fixtures: `bucket()` region mapping; `codes:['SPX','ZZZ']` → one row + `skipped[{ code:'ZZZ', reason:'INDEX_NOT_SEEDED' }]`; `regions:['EMEA']` returns only the EMEA block; `view:'levels'` swaps the column set; no `providers.ensure` call is made (spy on `ctx.providers`, §0.4 rule 2) |
| returns / na | `packages/server/test/integration/functions/WEI.returns.test.ts` | `SPX` with 380 seeded `bars_daily` rows: `RET_YTD` equals `close(2026-09-15)/close(2025-12-31) − 1` to 1e-10 and `meta.engines` contains `stats@1.0.0`; `VIX` with 0 bars: every `RET_*` cell `{ v:null, st:'na' }` and one `NO_DAILY_HISTORY` unavailable entry |
| calendar degradation | `packages/server/test/integration/functions/WEI.calendar.test.ts` | `UKX` uses `XLON` (`sessionSource:'calendar'`, `localTime` in `Europe/London`); `NKY` has `calendarId === null`, `sessionState === 'unknown'`, `sessionSource === 'none'` and the `NO_CALENDAR_FOR_VENUE` unavailable entry — no invented session |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `WEI.default.csv`; every numeric cell equals the payload `ValueCell.v`; `na` cells are empty, not `0` |
| parity | `packages/server/test/parity/fn-parity.test.ts` | `SPX` row cells equal the WS `snap.f` for `q:<SPX>` at the frozen clock (API-05) |
| entitlement | `packages/server/test/integration/functions/WEI.entitlement.test.ts` | `eod@demo`: every `PX_LAST` cell `null` with `TIER_EOD`, `PX_CLOSE_1D` populated (ENTL-05) |
| screen | `packages/web/test/screens/WEI.test.tsx` | renders the golden payload with three region grids; live cells registered for every `q:` subject and flashing on a `q:<SPX>` delta; `V` and `R` call `setParams`; `M` on `VIX` shows the toast and does not navigate, `M` on `SPX` navigates to `SPX Index MEMB`; `unknown` session badge carries the `NO_CALENDAR_FOR_VENUE` tooltip; `payload undefined` renders the skeleton |
| e2e | `packages/e2e/tests/morning-monitor.spec.ts` | logging in as `pm@demo` opens the default workspace with `WEI` in panel 1 painting `7,585.75` for SPX; replayed deltas flash the SPX cells; stopping the replay feed shows the stale strip within 30 s (TERM-12); `Enter` on `UKX` opens `UKX Index DES`; PRINT downloads `WEI_returns_20260915T184128.csv` whose SPX row matches the screen |

---

### HELP — Help

| Attribute | Value |
| --- | --- |
| Code / aliases | `HELP` / — (the `F1` key and the shell word `HELP` both dispatch this manifest, FUNCTIONS.md §2.6) |
| Tier / category | 1 / system |
| Asset classes → variants | `none → default` (one variant; `view` selects the payload branch, and `assetClass` selects which variant of the *documented* function is described, FUNC-02) |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/HELP.ts` · `packages/server/src/functions/HELP/resolve.ts` · `packages/web/src/screens/HELP/Screen.tsx` · `packages/web/src/screens/HELP/HelpOverlay.tsx` · `packages/web/src/screens/HELP/TicketDialog.tsx` · `fixtures/golden/functions/HELP.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-03) (FUNC-04) (TERM-06) (TERM-07) (TERM-09) (TERM-11) (API-07) (DATA-09) (DATA-10) (ENTL-05) (MSG-01) (OPS-07) |

#### Params
```ts
export const HelpParams = z.object({
  code: z.string().max(6).optional(), query: z.string().max(200).optional(),
  assetClass: AssetClass.optional(), view: z.enum(['function', 'search', 'index', 'tickets']).default('index'),
});
```
#### Argument grammar
`positional [{ name:'code', type:'string', optional:true }]`, `rest { name:'query', type:'text' }`, no `keyed`. Mapping rules (`packages/core/src/command/args.ts`, FUNCTIONS.md §4): the first token is taken as `code` when it matches `/^[A-Z]{1,6}$/` **and** resolves in the registry (canonical code or alias) — then `view:'function'`; the literal `TICKETS` → `view:'tickets'` and `code:undefined`; anything else becomes `query` and `view:'search'`; no argument at all → `view:'index'` when the panel has no function loaded, `view:'function'` with `code` = the panel's current function and `assetClass` = the panel security's class otherwise (TERM-03).
Examples: `HELP` (empty panel) → `{ view:'index' }` · `HELP GP` → `{ code:'GP', view:'function' }` · `HELP dividend adjustment` → `{ query:'dividend adjustment', view:'search' }` · `HELP TICKETS` → `{ view:'tickets' }`.

#### Payload
```ts
export type HelpPayload =
  | { variant: 'default'; view: 'function'; function: { code: string; name: string; tier: Tier; variant: string | null; help: HelpSpec; params: Array<{ name: string; schema: unknown; default: unknown }>; csvColumns: CsvColumn[] | null; fields: Array<{ id: FieldId; label: string; definition: string; sourceId: string; attribution: string }>; keys: KeyBinding[] } }
  | { variant: 'default'; view: 'search'; query: string; hits: Array<{ kind: 'function' | 'field' | 'topic' | 'shell'; id: string; title: string; snippet: string; score: number }> }
  | { variant: 'default'; view: 'index'; tiers: Array<{ tier: Tier; functions: Array<{ code: string; name: string; summary: string; aliases: string[] }> }>; shell: Array<{ word: string; text: string }>; keys: Array<{ key: string; action: string }> }
  | { variant: 'default'; view: 'tickets'; tickets: Array<{ ticketId: number; openedAt: string; functionCode: string | null; question: string; status: 'open' | 'answered' | 'closed'; roomId: number | null; answer: string | null; answeredAt: string | null }> };
```
The payload is verbatim FUNCTIONS.md §4 and is the body of `HelpResponse` (API.md §5.3 `GET /functions/:code/help`, §5.12 `GET /help/:code`) for the `function` view, so the overlay, the full screen, the REST route and the SDK all render one object. There is no `ValueCell` in this payload: HELP carries no market data, only documentation and, in `fields[]`, the dictionary entry plus its `licence_registry.attribution` (DATA-09).

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `help_tickets` (own rows; all rows for role `helpdesk`/`admin`), `rooms` + `room_members` (the ticket's `helpdesk` room id), `licence_registry` (as-of — `attribution`, `terms_url`, `max_tier` per `sourceId`), `field_licence` (`field_id` × `asset_class` → `source_id`, `field_class`), `topics` (the `topic` hit kind), `usage_events` (written, not read) |
| Data services (§1.4.2) | `data.help.tickets({ status?, scope:'own'\|'all' })` — **new reader (additions required)** ; `data.reference.licences(): Promise<LicenceSummary[]>` — **new reader (additions required)**, a new member of `DataServices.reference` (FUNCTIONS.md §1.4.2 L279-285, which today declares only `instrument`, `resolve`, `search`, `members`, `calendar`), reading `licence_registry` at `tx_to='infinity'` and returning the `LicenceSummary` shape already declared in API.md §7 L1083 (`sourceId, sourceName, publisher, licenceKind, attribution, display, exportAllowed, apiAllowed, redistribution, maxTier, intrinsicDelayMin, retentionDays, termsUrl`) plus the row's `provenance_id` and `tx_from` for step 5's `ctx.prov.add`. It supplies `attribution`. The registry itself (`core/functions/registry.ts`), the field dictionary (`core/fields/dictionary.ts`), the shell word list and the reserved key map are in-process constants, not database reads |
| Read-through (`providers.ensure`) | None. HELP never touches a provider. |
| Engines (`core/analytics`) | None. |
| Subjects (live) | None — `manifest.live()` returns `null`. |
| Field ids (`fieldIds(null)`) | `default: []` — HELP requests no market-data field, so the runner's entitlement pre-check is empty. The `fields[]` block runs a *secondary* `ctx.entitle(screenFieldIds, 'display')` purely to label each row with its decision (Resolver step 2); no value is ever returned, so nothing is logged as a data read beyond the `access_log` rows that check produces (ENTL-05) |

#### Resolver
1. **`view:'index'`** — `registry.all()` grouped by `tier` (1, 2, 3) with `code`, `name`, `help.summary`, `aliases`; `shell` = the shell word list of FUNCTIONS.md §2.6 (`GO`, `PRINT`, `MENU`, `BACK`, `PANEL n`, `GRAB`, …) each with its one-line text; `keys` = the reserved key map (`F1`..`F12`, `Ctrl+E`, `Ctrl+I`, `Esc`, `PageUp/PageDown`). Pure in-memory, zero DB round-trips.
2. **`view:'function'`** — `m = registry.get(params.code)` (case-insensitive; aliases resolve inside `get`, FUNCTIONS.md §1.7 L509: `IB` → `MSG`, `ICVS` → `CRVF` with its `aliasParams`); unknown code → `404 FUNCTION_NOT_FOUND` `{ message: 'no function <code>' }` (API.md §2 L151 — the same code the runner raises at step 1, FUNCTIONS.md §1.4 L331, so the client error map does not have to distinguish an unknown function from a missing help entry). `variant = m.variants?.[params.assetClass] ?? null`; when `params.assetClass` is given and `m.assetClasses` does not cover it, the entry is still returned with `ctx.unavailable.add({ field:'function', reason:'NOT_APPLICABLE', detail:'<code> does not apply to <assetClass>' })` so the overlay explains *why* the command was rejected rather than 422-ing a help request. `params[]` = each key of the zod object with its JSON-schema projection (`z.toJSONSchema(m.params.shape[k])`) and its `.default()` value. `csvColumns` = `m.csv.columns` when it is a static array, `null` when it is a function of the payload. `fields[]` = `m.fieldIds(params.assetClass ?? null)` joined to `core/fields/dictionary.ts` (`label`, `definition`) and to `field_licence` → `licence_registry.attribution` (as-of `ctx.asOf`); one `ctx.entitle(ids, 'display')` decorates each row with `decision`/`reason` for the screen's badge. `keys` = `m.keymap` ∪ the screen's dynamic `ScreenSpec.keymap` when the caller passed the panel's screen keymap (the overlay does; the REST route does not). 1 DB round-trip (`field_licence` ⋈ `licence_registry`).
3. **`view:'search'`** — `searchHelp(helpIndex, params.query, 25)` over `packages/core/src/functions/helpIndex.ts` (**new file (additions required)**): trigram similarity (`core/search/trigram.ts`, the same scorer `rank()` uses) over, per document, `name` + `help.summary` + `help.description` + `help.params[].text` for functions, `label` + `definition` for dictionary fields, `name` + `keywords` for topics (from `topics`), and `word` + `text` for shell words. `snippet` = the 120-character window around the best match with the matched span marked. Zero hits → `hits: []` and `ctx.unavailable.add({ field:'hits', reason:'NO_SOURCE', detail:'no help text matches "<query>"' })`. 1 DB round-trip (`topics`), and the index is built once per registry version and cached.
4. **`view:'tickets'`** — `data.help.tickets({ scope: ctx.user.role === 'helpdesk' || ctx.user.role === 'admin' ? 'all' : 'own' })` → `help_tickets` ordered `opened_at desc`, limit 200, joined to `rooms` for `roomId`. RLS already restricts to the caller's firm; the `own` scope adds `user_id = ctx.user.userId`. 1 DB round-trip.
5. Every branch sets `variant:'default'` and returns. No `ctx.prov` entries are added except one per distinct `sourceId` cited in `fields[]` (`ctx.prov.add({ sourceId, provenanceId: licenceRow.provenance_id, capturedAt: licenceRow.tx_from, sourceTs: null })`) so the attribution strip and `Ctrl+I` work on the help screen too (DATA-10).
Budget: ≤ 1 DB round-trip per view; < 40 ms p95. The overlay must open within one frame of `F1`, so the client renders from the SDK's cached `/functions` registry first and swaps in the resolved payload when it arrives.

**HELP ×2 — the ticket (TERM-09).** The second `F1` within 10 s (or `F1` while the overlay is open) is a *client* action, not a second resolve: `TicketDialog` posts `POST /api/v1/help/tickets` with `{ panelId, functionCode, security, params, screenState: { fields: visibleFieldIds, provIdx: visibleProvIdxs }, traceId, question }`. The route writes one `help_tickets` row (`status:'open'`), creates a `rooms` row (`kind:'helpdesk'`, `firm_id` = the user's firm, `retention_days` = the firm's floor) with `room_members` = the author plus every `users.role = 'helpdesk'` user of the firm, and emits `usage_events { kind:'ticket.open', code:'HELP', panelId, traceId }` (FUNC-04). The response `201 { ticketId, roomId }` is confirmed on screen and `MSG <roomId>` is opened in the next panel (MSG-01). **There is no 24/7 staffed analyst desk** (BRIEF §1): the ticket is a durable record answered by `helpdesk` users at `HELP TICKETS`, and the dialog says so before submit — code `NO_LIVE_ANALYST_DESK`.

#### Live
`null` — HELP subscribes to nothing. The `tickets` view refreshes on `ctx.setParams({})` (`launchKind:'refresh'`, no `fn.param` usage row) when the shell receives a `notice` frame naming the ticket's room; nothing else on the screen changes after first paint.

#### Screen
Two mounts of one `Screen(payload)`: the **full screen** (command `HELP …`) and the **overlay** (`F1`), which is the same spec rendered into the right third of the focused panel with `title` suppressed and `Esc` bound to close. `initialFocus` per view: `'tiers'` (index), `'params'` (function), `'hits'` (search), `'tickets'` (tickets).

`view:'function'` — title `HELP · <code> · <name>`; subtitle `tier <tier> · <variant ?? 'no asset-class variant'> · trace <traceId>`:
```
┌ HELP · GP · Price Graph                                tier 1 · variant equity · trace 0f2c…9ab ┐
│ text#summary   Daily-to-decade price chart with overlays, normalisation, events and studies      │
│ text#description  (the manifest's full help.description, wrapped, mono:false)                    │
│ table#params   param | what it does | example | current value                                    │
│                range | window        | 5Y      | 1Y                                              │
│ table#keys     key | when | action                                                               │
│ grid#fields    field | label | definition | source | attribution | entitlement                   │
│                PX_LAST | Last price | … | cboe.quotes | Cboe delayed quotes | delayed ✓           │
│ list#related   Q · QM · GIP · HP · DES     (Enter launches)                                      │
│ text#csv       PRINT columns: date,open,high,low,close,volume                                    │
│ badges#notes   [NOT_APPLICABLE: GP does not apply to govt]  [F1 again opens a ticket]            │
│ footer sources: the licence attribution of every source cited above                              │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```
`view:'index'` — `tabs#tiers` with tabs `1` Tier 1, `2` Tier 2, `3` Tier 3 (number keys reserved for tabs, FUNCTIONS.md §7.2 rule 5), each a `grid#tier<n>` of `code | aliases | name | summary`; below, `table#shell` (shell words) and `table#keys` (reserved keys and the yellow key map). `view:'search'` — `form#q` (the query, focused, re-runs 300 ms after typing with `launchKind:'param'`) over `list#hits` (`primary` = title, `secondary` = snippet, badge = `kind`). `view:'tickets'` — `grid#tickets`: `ticketId | openedAt (datetime) | functionCode | question (truncated 80) | status badge | answeredAt`, `emptyText: 'No tickets — press F1 twice on any screen to open one'`.
Skeleton (`payload === undefined`): the index view's tab bar with 14/14/10 muted rows, or, in the overlay, the summary line from the SDK's cached registry entry while the resolve is in flight.
`meta.unavailable` renders as `badges#notes` chips; the `NOT_APPLICABLE` chip is amber. Entitlement is **not** applied to the help text itself (documentation is not licensed data) — the `grid#fields` `entitlement` column shows each field's `FieldDecision`: `delayed ✓`, `eod (TIER_EOD)`, `blocked (NO_FIRM_ENTITLEMENT)` — so a user reading HELP learns exactly why a cell on the previous screen was blank (ENTL-05, TERM-11).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `F1` | always | `open-ticket` | second press within 10 s, or any press while the overlay is open: opens `TicketDialog` → `POST /help/tickets` → `usage_events 'ticket.open'` (TERM-09) |
| `Esc` | always | `close-overlay` | overlay mount only: closes and returns focus to the panel's screen (no-op on the full screen) |
| `Enter` | list (`list#hits`) | `open-hit` | `kind:'function'` → `ctx.setParams({ code: hit.id, view:'function', query: undefined })`; `kind:'field'` → focuses that row of `grid#fields`; `kind:'topic'` → `ctx.navigate('NI ' + hit.id)`; `kind:'shell'` → no navigation, expands the text |
| `Enter` | list (`list#related`) | `open-related` | `ctx.navigate(code)` (launches the related function in this panel) |
| `Enter` | grid (`grid#tier<n>`) | `open-function-help` | `ctx.setParams({ code: row.cells.code.v, view:'function' })` |
| `Shift+Enter` | grid (`grid#tier<n>`) | `launch-next` | `ctx.navigateNext(row.cells.code.v as string)` |
| `Enter` | grid (`grid#tickets`) | `open-room` | `ctx.navigate('MSG ' + row.cells.roomId.v)` when `roomId` is not null |
| `Enter` | grid (`grid#fields`) | `field-definition` | expands the row to the full dictionary entry (`sources[]`, `updateFreq`, `pit`, `since`) — API-07 |
| `1` `2` `3` | tabs (index view) | `tier-tab` | selects the tier tab |
| `I` | always | `go-index` | `ctx.setParams({ view:'index', code: undefined, query: undefined })` |
| `T` | always | `go-tickets` | `ctx.setParams({ view:'tickets' })` |
| `/` | always | `go-search` | focuses `form#q` and sets `view:'search'` |
| `Ctrl+I` | grid (`grid#fields`) | `licence-provenance` | `ctx.provenance(provIdx)` — the `licence_registry` version behind the attribution (DATA-09, DATA-10) |
| `Ctrl+E` | always | reserved | PRINT → `ctx.export()` |

#### CSV
`filename = 'HELP_' + (view === 'function' ? code : view) + '_' + asOfCompact + '.csv'`. Columns are the long format of FUNCTIONS.md §4, static for every view: `section,key,text` (`CsvColumn[] = [{ id:'section', label:'Section', type:'string' }, { id:'key', label:'Key', type:'string' }, { id:'text', label:'Text', type:'string' }]`). Rows per view:
- `function`: `('meta','code',code)`, `('meta','name',name)`, `('meta','tier',String(tier))`, `('meta','variant',variant ?? '')`, `('summary','',summary)`, `('description','',description)`, one `('param',p.name,p.text + (p.example ? ' — e.g. ' + p.example : ''))` per param, one `('key',k.key,k.when + ': ' + k.description)` per key, one `('field',f.id,f.label + ' — ' + f.definition + ' [' + f.sourceId + ']')` per field, one `('related',c,'')` per related code, one `('csvColumn',c.id,c.label)` per CSV column when `csvColumns !== null`.
- `index`: one `('tier<n>',fn.code,fn.name + ' — ' + fn.summary)` per function, one `('shell',w.word,w.text)`, one `('key',k.key,k.action)`.
- `search`: `('query','',query)` then one `('hit',h.id,h.kind + ': ' + h.title + ' — ' + h.snippet)` per hit.
- `tickets`: one `('ticket',String(t.ticketId), t.openedAt + ' | ' + (t.functionCode ?? '') + ' | ' + t.status + ' | ' + t.question)` per ticket, and `('ticket-answer',String(t.ticketId),t.answer)` when answered.
Example: `field,PX_LAST,Last price — the most recent trade price from the composite line [cboe.quotes]`.

#### Help
summary `Explain this screen; press F1 twice to open an analyst ticket`; description `HELP is the terminal's own documentation, served from the same manifests the functions run on, so it cannot drift from behaviour. One press of F1 explains the function in the focused panel: what it does, every parameter with its current value and an example command line, every key it binds, and every field on the screen with its dictionary definition, its source, that source's licence attribution and whether you are entitled to it. A second press of F1 within ten seconds opens a ticket: the function, the security, the parameters, the visible fields with their provenance indexes and the trace id are attached automatically, a helpdesk room is created and the conversation continues in MSG. There is no 24-hour staffed desk in this build — the ticket is a durable record answered by the firm's helpdesk users, and HELP TICKETS lists yours with their answers. HELP with no function loaded lists every function by tier with the shell words and reserved keys; HELP followed by words searches the documentation and the field dictionary.`; params `code` ("a function code, or TICKETS", `HELP GP`), `query` ("words to search help and field definitions", `HELP dividend adjustment`), `assetClass` ("describe the variant for this asset class", `HELP GP` on an index panel), `view` ("function, search, index or tickets", `HELP TICKETS`); sources `['internal.derived']` (the payload is documentation; the `attribution` strings inside it come from `licence_registry` and are listed per row, not as screen sources); related `['MSG','SECF','TOP','DES']`.

#### Unavailable and reason codes
| Entry | When | Footer code |
| --- | --- | --- |
| `{ field:'function', reason:'NOT_APPLICABLE', detail:'<code> does not apply to <assetClass>' }` | `view:'function'` with an asset class the manifest does not cover — help is still shown, the chip explains the rejection | `FUNCTION_NOT_APPLICABLE` |
| `{ field:'hits', reason:'NO_SOURCE', detail:'no help text matches "<query>"' }` | `view:'search'` with zero hits | — |
| `{ field:'tickets', reason:'NOT_APPLICABLE', detail:'no 24/7 staffed desk in this build: tickets are answered by the firm\'s helpdesk users (BRIEF §1)' }` | always, on `view:'tickets'` and in `TicketDialog` before submit (TERM-09 is met as a mechanism, not as staffing) | `NO_LIVE_ANALYST_DESK` |
| `{ field:'function.keys', reason:'NOT_APPLICABLE', detail:'screen keymap unavailable — REST callers see manifest keys only' }` | `GET /functions/:code/help` without a panel context | — |
| `{ field:'fields.<id>.attribution', reason:'NO_SOURCE', detail:'no field_licence row for <id> × <assetClass>' }` | a dictionary id with no `field_licence` mapping — the row still renders, `attribution` is `''` and the gap is visible (DATA-09) | `FIELD_LICENCE_MISSING` |
`404 NOT_FOUND` (not an `unavailable` entry) for an unknown `code`. No entitlement denial can blank this payload; `ENTL-05` appears only as the per-field decision column. A ticket POST that fails validation returns `400 VALIDATION_FAILED` with the offending field and the dialog keeps the typed question.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared); additionally: **every** manifest in the registry has a non-empty `help.summary` ≤ 80 chars, a `help.description`, one `help.params[]` entry per zod key and one `help.keys[]` entry per `keymap` row — HELP is only as good as this invariant |
| golden payload | `packages/server/test/integration/functions/HELP.golden.test.ts` | four goldens at the frozen clock: `HELP` → `HELP.default.json` `view:'index'` with 14 Tier 1, 14 Tier 2, 10 Tier 3 entries; `HELP GP` → `view:'function'`, `function.code === 'GP'`, `fields[]` includes `PX_LAST` with `sourceId:'cboe.quotes'` and the Cboe attribution string; `HELP ICVS` resolves to `CRVF` with the alias params applied; `HELP dividend` → `view:'search'` with the `HP` `adjust` param and the `DVD_YIELD` field among the hits |
| resolver unit | `packages/server/test/unit/functions/HELP.resolve.test.ts` | against the seeded fixtures: `HELP ZZZ` → `404`; `HELP GP` with `assetClass:'govt'` returns the payload plus the `FUNCTION_NOT_APPLICABLE` unavailable entry; `view:'tickets'` as `pm@demo` returns only that user's rows and as a `helpdesk` user returns all of the firm's; the search index is built once per registry version (spy on `buildHelpIndex`) |
| ticket route | `packages/server/test/integration/help.tickets.test.ts` | `POST /help/tickets` writes one `help_tickets` row with `screen_state`, `trace_id` and `params`, creates a `rooms` row `kind:'helpdesk'` with the author and the firm's `helpdesk` users in `room_members`, emits one `usage_events` row `kind:'ticket.open'`, and returns `201 { ticketId, roomId }`; a second identical POST creates a second ticket (tickets are not idempotent); `GET /help/tickets` as the author lists it `status:'open'` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `HELP.default.csv`; the `function` view's row count equals `4 + 2 + params + keys + fields + related + csvColumns` |
| parity | `packages/server/test/parity/fn-parity.test.ts` | `GET /functions/GP/help` body deep-equals the `view:'function'` payload's `function` block projected through `HelpResponse` (API-05) |
| screen | `packages/web/test/screens/HELP.test.tsx` | renders all four views from the goldens; `1`/`2`/`3` switch tier tabs; `Enter` on a related code calls `ctx.navigate`; `Enter` on a hit calls `setParams`; `Esc` closes the overlay mount and restores panel focus; the `entitlement` column shows `blocked (NO_FIRM_ENTITLEMENT)` for a denied field; `payload undefined` renders the skeleton |
| overlay | `packages/web/test/screens/HELP.overlay.test.tsx` | `F1` on a `GP` panel opens the overlay over the right third without unmounting `GP`; a second `F1` within 10 s opens `TicketDialog` pre-filled with `panelId`, `functionCode:'GP'`, the security, the params and the visible field ids with their `provIdx`; after 11 s a second `F1` closes the overlay instead |
| e2e | `packages/e2e/tests/help-ticket.spec.ts` | `AAPL US Equity GP <GO>`, `F1` shows the GP help with `PX_LAST`'s Cboe attribution; `F1` again, type a question, `GO` → confirmation with a ticket id, `MSG` opens the helpdesk room in the next panel and the room shows the attached function context; `HELP TICKETS <GO>` lists the ticket `open`; the `NO_LIVE_ANALYST_DESK` note is visible before submit |

---

### SECF — Security Finder

| Attribute | Value |
| --- | --- |
| Code / aliases | `SECF` / `SF`, `FIND` |
| Tier / category | 1 / reference |
| Asset classes → variants | `none → default` (the `AC=` parameter filters the *results* by asset class; the function itself takes no security, FUNC-02) |
| requiresSecurity / pageable / screenKind | `false` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/SECF.ts` · `packages/server/src/functions/SECF/resolve.ts` · `packages/web/src/screens/SECF/Screen.tsx` · `fixtures/golden/functions/SECF.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-03) (FUNC-04) (REF-01) (REF-02) (REF-03) (REF-07) (REF-08) (TERM-02) (TERM-03) (TERM-06) (TERM-11) (DATA-10) (ENTL-05) (NFR: search p95 < 80 ms local, < 250 ms server) |

#### Params
```ts
export const SecfParams = z.object({
  query: z.string().max(80).default(''),
  assetClass: AssetClass.optional(), sector: MarketSector.optional(),
  exchange: z.string().max(4).optional(), country: z.string().length(2).optional(),
  status: z.enum(['active', 'all']).default('active'),
  indexMember: z.string().optional(),                    // 'SPX' → only members
  sort: z.enum(['rank', 'ticker', 'name']).default('rank'),
  pageSize: z.number().int().min(20).max(200).default(50),
});
```
#### Argument grammar
`rest { name:'query', type:'text' }`, `keyed { AC: { name:'assetClass', type:'enum', values:['equity','etf','index','fx','govt','option','future','crypto','rate','econ'] }, SEC: { name:'sector', type:'enum', values:['Equity','Index','Curncy','Govt','Corp','Comdty','Mtge','Muni','Pfd','M-Mkt','Crypto'] }, EXCH: { name:'exchange', type:'string' }, CTRY: { name:'country', type:'string' }, STATUS: { name:'status', type:'enum', values:['active','all'] }, IDX: { name:'indexMember', type:'index' }, SORT: { name:'sort', type:'enum', values:['rank','ticker','name'] }, SIZE: { name:'pageSize', type:'int' } }`, no `positional`.
Examples: `SECF` → `{ query:'', status:'active', sort:'rank', pageSize:50 }` · `SECF apple` → `{ query:'apple' }` · `SECF semiconductor AC=EQUITY EXCH=UW IDX=SPX STATUS=ALL` → `{ query:'semiconductor', assetClass:'equity', exchange:'UW', indexMember:'SPX', status:'all' }`.

#### Payload
```ts
export interface SecfPayload {
  variant: 'default';
  hits: Array<{ instrument: InstrumentSummary; matchedOn: Candidate['matchedOn']; matched: Array<[number, number]>; score: number;
                identifiers: { figi: string | null; isin: string | null; cusip: string | null }; memberOf: string[]; listings: number; gicsSector: string | null }>;
  total: number;
  facets: { assetClass: Record<string, number>; exchange: Record<string, number>; status: Record<string, number> };
  source: 'master' | 'master+yahoo';
}
```
`InstrumentSummary` is the API.md §3 shape (`ResolvedRef` + `ticker`, `exchCode`, `securityType`, `compositeFigi`, `status`, `priceDecimals`) built by `toSummary` (§0.1). `matchedOn` is `Candidate['matchedOn']` = `'code'|'ticker'|'name'|'isin'|'cusip'|'figi'|'alias'|'trigram'` and `matched` are highlight ranges into `instrument.display`. No `ValueCell` appears: SECF serves reference data only, and every field in it is either present or `null` with a reason listed below.

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `instruments` (current, `instruments_ticker_idx` for `upper(ticker) LIKE q || '%'`, `instruments_name_trgm` for `name % q`), `issues` + `issuers` (as-of — `security_type`, `country_of_issue`, issuer name for alias matching), `listings` (current — `listings` count and `mic`), `exchanges` (`exch_code`/`mic`/`composite_code` for `EXCH=`), `identifiers` (current — exact `ISIN`/`CUSIP`/`FIGI`/`COMPOSITE_FIGI`/`SHARE_CLASS_FIGI` lookups and the payload's `identifiers` block), `issuer_aliases` (`matchedOn:'alias'`), `indices` + `index_members` (current — `memberOf` and the `IDX=` filter), `entity_classifications` + `classification_codes` (scheme `GICS` → `gicsSector`) |
| Data services (§1.4.2) | `data.reference.search(params & { cursor })` — the single reader, returning `{ hits, total, facets, nextCursor }`; `data.reference.resolve(ref)` for the Yahoo-fallback `Enter` path |
| Read-through (`providers.ensure`) | `('yahoo.search', query, { maxAgeMs: 3_600_000 })` — **only** when `hits.length < 3` and `query.length >= 3` and the caller's firm has a `yahoo.search` grant; adds ≤ 8 hits marked `source:'master+yahoo'`. `'yahoo.search'` is a **new `ReadThroughKind`** (additions required). The circuit being open is not an error: the payload stays `source:'master'` and an `unavailable` entry says so. |
| Engines (`core/analytics`) | None. |
| Subjects (live) | None — `manifest.live()` returns `null`. SECF is a reference screen; prices live in `DES`/`Q` one `Enter` away. |
| Field ids (`fieldIds(null)`) | `default: [NAME, TICKER, EXCH_CODE, GICS_SECTOR_NAME]` (`fieldClass:'reference'`, introduced by the QM entry) — the pre-check set. Reference fields are not tier-gated, so the pre-check denies nothing for any seeded grant; it exists so that a firm without a reference grant is refused and logged like any other read (ENTL-01, ENTL-05) |

#### Resolver
1. **Rank.** `data.reference.search(params)` runs `rank(query, universeIndex, ctx, registry)` (`core/command/rank.ts`) over the server's universe snapshot when `query !== ''`, so SECF's ordering is byte-identical to the command line's autocomplete (TERM-02). `query === ''` skips ranking and orders by `instruments.search_weight desc, instrument_id`.
2. **Filter.** One SQL query over current `instruments` (`instruments_now`) joined to as-of `issues`/`issuers`, current `listings`, `exchanges`, current `identifiers` and, when `indexMember` is set, current `index_members` ⋈ `indices` on `indices.code = upper(indexMember)`: `assetClass`, `sector` (`market_sector`), `exchange` (matched against `exchanges.bbg_exch_code`, `exchanges.mic` and `exchanges.composite_code`, so `EXCH=UW`, `EXCH=XNAS` and `EXCH=US` all work), `country` (`issues.country_of_issue`), `status` (`'active'` → `instruments.status = 'active'`; `'all'` → no filter). Exact-identifier queries short-circuit ranking: a `query` matching `^[A-Z]{2}[A-Z0-9]{9}\d$` is looked up as `ISIN`, `^[A-Z0-9]{9}$` as `CUSIP`, `^BBG[A-Z0-9]{8}\d$` as `FIGI`/`COMPOSITE_FIGI`/`SHARE_CLASS_FIGI`, each with `matchedOn` set accordingly and `score: 1`.
3. **Decorate.** `memberOf` = the `indices.code` list for the hit (current `index_members`); `listings` = the count of current `listings`; `gicsSector` = `classification_codes.name` at `level 1` for the issuer's `GICS` classification, `null` when unclassified; `identifiers` = the primary current `FIGI`/`ISIN`/`CUSIP` values (`is_primary` first, else the lowest `version_id`), each `null` when absent.
4. **Facets.** `facets` are computed over the filtered set **before** paging, as three `count(*) … group by` aggregates in the same query (`assetClass` by `instruments.asset_class`, `exchange` by `exchanges.bbg_exch_code`, `status` by `instruments.status`), so the tab counts do not change as the user pages.
5. **Page.** `ctx.page` handling: `cursor = base64url(JSON.stringify(k))` where `k` is the last row's sort key — `{ s: score, i: instrumentId }` for `sort:'rank'`, `{ t: ticker, i: instrumentId }` for `'ticker'`, `{ n: name, i: instrumentId }` for `'name'` — and the SQL applies the matching keyset predicate (`(score, instrument_id) < (k.s, k.i)` for `rank`/desc, `>` for the ascending text sorts). **PAGE FWD means the next `pageSize` hits further down the ranking** (lower score, or later in the alphabet); PAGE BACK re-runs with the inverted predicate and re-reverses. `ctx.page.set({ index, count: Math.ceil(total / pageSize), cursor: nextCursor })`. A cursor that does not decode → `400 VALIDATION_FAILED` `page.cursor`.
6. **Fallback.** When `hits.length < 3 && params.query.length >= 3`: `providers.ensure('yahoo.search', params.query, { maxAgeMs: 3_600_000 })` — **`'yahoo.search'` is a new `ReadThroughKind` member (additions required)**; FUNCTIONS.md §1.4.2 L266-268 declares only the fourteen kinds `'sec.submissions' | 'sec.companyfacts' | 'sec.nport' | 'cboe.quote' | 'cboe.options' | 'yahoo.intraday' | 'yahoo.daily' | 'yahoo.fx' | 'coingecko.simple' | 'fred.series' | 'nyfed.rates' | 'finra.shortInterest' | 'bbg.rss' | 'fed.rss'`, so this call does not type-check until the union gains `'yahoo.search'` (see *Additions required* at the end of this document) — then read the stored response and map `quotes[]` → hits with `instrument` built from `{ symbol, shortname/longname, quoteType, exchDisp }` (`instrumentId: -1` — these rows are **not** in the master), `matchedOn:'trigram'`, `score: quote.score / 1e6` clamped below every master hit, `identifiers` all `null`, `memberOf: []`, `listings: 0`; `source = 'master+yahoo'`. `ctx.prov.add({ sourceId:'yahoo.search', provenanceId, capturedAt, sourceTs: null })` cites the recorded response (DATA-10). A Yahoo hit is never written to the master here: `Enter` on such a row calls `POST /ref/resolve` (API.md §5.1), which may create the master row from OpenFIGI (`source:'openfigi'`).
7. Return `{ variant:'default', hits, total, facets, source }`.
Budget: 1 DB round-trip (filter + facets + page in one statement with CTEs), plus at most one provider call on the fallback path; < 120 ms p95 for a master-only query, < 400 ms with the fallback. The local autocomplete already covers the first keystrokes — SECF exists for filters, facets, paging and the server-only identifier searches.

#### Live
`null`. The results grid registers no live cells and opens no subscription; `ScreenProps.live` is unused. Re-running on typing is a `setParams` (`launchKind:'param'`), debounced 300 ms in the screen, which is the only traffic this function generates after first paint.

#### Screen
Title `SECF · Security Finder`; subtitle `<hits.length> of <total> · page <index+1>/<count> · <source> · sort <sort>`; `initialFocus:'q'`.
```
┌ SECF · Security Finder                          12 of 41 · page 1/1 · master · sort rank ┐
│ form#q       Query [apple                    ]  AC [—]  EXCH [—]  STATUS [active]        │
│ tabs#ac      1 All(41)  2 Equity(28)  3 ETF(6)  4 Index(3)  5 Curncy(0)                  │
│              6 Govt(0)  7 Rate/Econ(2)  8 Crypto(2)                                      │
│ grid#hits    key            | name            | type         | exch | ccy | status | idx │
│              AAPL US Equity | Apple Inc       | Common Stock | UW   | USD | active | SPX │
│              APLE US Equity | Apple Hospit... | REIT         | UN   | USD | active | —   │
│ kv#detail    (focused row) FIGI BBG000B9XRY4 · composite BBG000B9Y5X2 · ISIN US0378331005│
│              · CUSIP 037833100 · listings 4 · GICS Information Technology · member of SPX│
│ badges#notes [MEMBERSHIP_SPX_ONLY]                                                        │
│ footer sources: OpenFIGI (Bloomberg open symbology); SEC EDGAR company tickers;           │
│                 SPDR S&P 500 ETF holdings / SEC N-PORT (membership)      asOf 18:41:28Z   │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```
Body is `split col [0.12 | 0.06 | 0.62 | 0.20]`: `form#q` (fields `query` text, `assetClass` enum, `exchange` text, `status` boolean-ish enum — every change calls `setParams`), `tabs#ac` (asset-class tabs with the facet counts, `1` All, `2` Equity, `3` ETF, `4` Index, `5` Curncy, `6` Govt, `7` Rate/Econ, `8` Crypto — number keys as tabs per §7.2 rule 5; `7` sets `assetClass` to `rate` and re-runs with `econ` merged client-side by showing both, since the tab is a display grouping over two classes), `grid#hits` (`frozenColumns: 1`; columns `key`, `name` with `matched` ranges highlighted, `securityType`, `exchCode`, `currency`, `status`, `memberOf` joined by `,`, `figi`; `page: { index, count }` drives the pager; `emptyText` = the `unavailable` detail), and `kv#detail` for the focused row. A Yahoo-fallback row is rendered `tone:'muted'` with a `[not in master — Enter resolves]` badge.
Skeleton (`payload === undefined`): the form with the current params, the tab bar without counts and 8 muted grid rows.
`meta.unavailable` renders as `badges#notes`. Entitlement: reference data is not tier-gated, so no cell is blanked; a firm whose grant lacks `usage_export` gets `403 ENTITLEMENT_DENIED` on PRINT with `details.reasons[] = ['NO_FIRM_ENTITLEMENT']` and the footer shows the reason instead of downloading (ENTL-05, ENTL-01). `ENTITLEMENT_DENIED` is the `ErrorCode` (API.md §2 L136-172); `NO_FIRM_ENTITLEMENT` is the `ReasonCode` (ARCHITECTURE L1143) carried in `details.reasons[]` per API.md §9 L1176-1178. `LICENCE_FORBIDS_USAGE` is a different reason — it is raised when the *source's* `licence_registry.export_allowed` is false (here: `yahoo.search`, whose x/a is f/f), not when a grant lacks `usage_export`. `meta.staleness` is `closed` for a master-only result (reference data has no session) and takes the Yahoo response's state on the fallback path.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid | `open-des` | master row: `ctx.navigate(row.cells.key.v + ' DES')`; Yahoo-fallback row: `sdk.ref.resolve({ ref: row.cells.key.v })` then `ctx.navigate(resolved.display + ' DES')` |
| `Shift+Enter` | grid | `open-des-next` | same, in the next panel |
| `Enter` | form | `run-search` | `ctx.setParams(values)` (also fired 300 ms after the last keystroke) |
| `Ctrl+W` | grid | `add-watchlist` | `ctx.prompt('watchlist')` → `sdk.watchlists.setItems` appends the focused row |
| `X` | always | `exchange-filter` | `ctx.prompt('text', { label:'Exchange (UW, XNAS, US)' })` → `setParams({ exchange })` |
| `S` | always | `toggle-status` | `setParams({ status: status === 'active' ? 'all' : 'active' })` |
| `O` | always | `cycle-sort` | `setParams({ sort: next of rank → ticker → name })` |
| `1`..`8` | tabs | `ac-tab` | selects the asset-class tab → `setParams({ assetClass })` |
| `PageDown` | grid | `page-fwd` | `ctx.page('fwd')` — the next `pageSize` hits further down the ranking |
| `PageUp` | grid | `page-back` | `ctx.page('back')` |
| `Ctrl+I` | grid | `hit-provenance` | `ctx.provenance(provIdx)` — the OpenFIGI / EDGAR / Yahoo response behind the row (DATA-10) |
| `Ctrl+E` | always | reserved | PRINT → `ctx.export()` (exports the current page; the `#` header records `page` and `total`) |

#### CSV
`filename = 'SECF_' + (query ? querySlug : 'all') + '_' + asOfCompact + '.csv'`. Columns are static (FUNCTIONS.md §5): `key,name,assetClass,securityType,exchange,currency,figi,isin,cusip,status,memberOf` — `CsvColumn[] = [{ id:'key', label:'Security', type:'string' }, { id:'name', label:'Name', type:'string' }, { id:'assetClass', label:'Asset class', type:'string' }, { id:'securityType', label:'Security type', type:'string' }, { id:'exchange', label:'Exchange', type:'string' }, { id:'currency', label:'Currency', type:'string' }, { id:'figi', label:'FIGI', type:'string' }, { id:'isin', label:'ISIN', type:'string' }, { id:'cusip', label:'CUSIP', type:'string' }, { id:'status', label:'Status', type:'string' }, { id:'memberOf', label:'Member of', type:'string' }]`. One row per `hits[]` in payload order (the current page only); `memberOf` is `|`-joined (`'SPX|NDX'`); `figi` is `instrument.compositeFigi` when `identifiers.figi` is null; a Yahoo-fallback row writes `key` = the provider symbol and leaves `figi`/`isin`/`cusip` empty. The `#` comment lines carry `asOf`, `total`, `page`, `source` and the attribution of every source cited.
Example: `AAPL US Equity,Apple Inc,equity,Common Stock,UW,USD,BBG000B9XRY4,US0378331005,037833100,active,SPX`.

#### Help
summary `Filtered, faceted, paged search over the security master`; description `SECF is the answer to NO SECURITY LOADED and to any ticker the command line could not resolve. It searches the master by ticker prefix, name trigram, issuer alias and by exact ISIN, CUSIP or FIGI, using the same ranking the command line's autocomplete uses, then filters by asset class, market sector, exchange, country, status and index membership. The facet counts above the grid are computed over the whole result set, not the visible page, so switching tabs never surprises you. Membership is known only for the S&P 500, whose constituents come from the SPY ETF's N-PORT filing and SSGA's daily holdings file; other indices show no membership rather than a guess. When the master has fewer than three hits the Yahoo search endpoint contributes up to eight extra rows, marked as not in the master — Enter on one resolves it through OpenFIGI and creates the master record. Enter opens DES, Shift+Enter opens it in the next panel, PageDown pages further down the ranking.`; params `query` ("ticker, name, ISIN, CUSIP or FIGI", `SECF apple`), `assetClass` ("equity, etf, index, fx, govt, option, crypto, rate, econ", `AC=ETF`), `sector` ("market sector", `SEC=Equity`), `exchange` ("bbg exchange code, MIC or composite code", `EXCH=UW`), `country` ("ISO 2-letter country of issue", `CTRY=US`), `status` ("active or all", `STATUS=ALL`), `indexMember` ("only members of this index", `IDX=SPX`), `sort` ("rank, ticker or name", `SORT=NAME`), `pageSize` ("20–200 rows per page", `SIZE=100`); sources `['openfigi.mapping','sec.tickers','cboe.symbolBook','yahoo.search','sec.archives','ssga.holdings','wiki.sp500','internal.derived']` — every entry is a `licence_registry.source_id` from the 33-row registry of PROVIDERS.b §15, because HELP resolves the footer attribution by looking each id up in that registry (§HELP resolver step 5) and an unknown id both renders blank and is rejected by the `assert_source_known` trigger on any `provenance` write. `sec.tickers` is the canonical id (PROVIDERS.b §7.1, PROVIDERS.a §1.1 `ProviderId`, DATA_MODEL §2); `sec.companyTickers` is not a source id anywhere. There is no `openfigi.search` source: PROVIDERS.b §6.2 folds `POST /v3/search` under `openfigi.mapping`, which is the single licence row for both OpenFIGI endpoints; related `['DES','QM','MEMB','W','HELP']`.

#### Unavailable and reason codes
| Entry | When | Footer code |
| --- | --- | --- |
| `{ field:'hits', reason:'NO_SOURCE', detail:'no instrument matches "<query>" with these filters' }` | zero hits after filtering; `emptyText` shows the detail | — |
| `{ field:'memberOf', reason:'NO_SOURCE', detail:'membership is sourced only for SPX (SPY N-PORT + SSGA daily holdings); other indices have indices.membership_source_id = null' }` | always — `memberOf` is `[]`, never guessed, for every index but SPX (REF-07) | `MEMBERSHIP_SPX_ONLY` |
| `{ field:'indexMember', reason:'NO_SOURCE', detail:'index <code> has no membership source — the IDX filter was ignored' }` | `IDX=` naming an index with `membership_source_id = null`; the filter is dropped and every hit is returned rather than an empty grid | `MEMBERSHIP_SPX_ONLY` |
| `{ field:'source', reason:'NO_SOURCE', detail:'Yahoo search unavailable (circuit open) — master hits only' }` | the fallback path with an open circuit and nothing stored; `source` stays `'master'` | `YAHOO_FALLBACK_UNAVAILABLE` |
| `{ field:'source', reason:'NOT_LICENSED', detail:'this firm has no yahoo.search grant — master hits only' }` | the fallback path with no entitlement grant for `yahoo.search` | `YAHOO_FALLBACK_NOT_LICENSED` |
| `{ field:'hits[].gicsSector', reason:'NO_SOURCE', detail:'GICS names are seeded from wiki.sp500 for S&P 500 issuers only' }` | any hit outside the S&P 500 — `gicsSector` is `null`, shown as `—` | `GICS_SP500_ONLY` |
| `{ field:'hits[].identifiers.isin', reason:'NO_SOURCE', detail:'OpenFIGI publishes no ISIN for this instrument' }` | per-hit, when the mapping response carried no ISIN — the cell is empty, never derived from the CUSIP | — |
| `{ field:'facets.exchange', reason:'NOT_APPLICABLE', detail:'non-listed instruments (govt, fx, rate, econ, crypto) have no exchange' }` | those classes are counted under their `exch_code` pseudo-venue (`GOVT`, `FX`, `RATE`, `ECON`, `CRYPTO`) and the note explains it | — |
`403 ENTITLEMENT_DENIED` with `details.reasons[] = ['NO_FIRM_ENTITLEMENT']` on PRINT for a firm without `usage_export` (never `403 LICENCE_FORBIDS_USAGE`: that string is a `ReasonCode`, not an `ErrorCode`, and a client switching on `error.code` would never match it); a PRINT of a page that carries `yahoo.search` rows is refused the same way with `details.reasons[] = ['LICENCE_FORBIDS_USAGE']`, because that source's `export_allowed` is false; `400 VALIDATION_FAILED` `page.cursor` for an undecodable cursor; `400 VALIDATION_FAILED` `fnParams` for an `AC=`/`SEC=` value outside the enums. No per-cell entitlement blanking occurs: reference data is served at every tier, and `eod@demo` sees exactly what `pm@demo` sees on this screen (the difference appears on `DES`/`Q`).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared); `pageable:true` ⇒ the manifest declares a cursor encoding and the screen passes `page` to the grid |
| golden payload | `packages/server/test/integration/functions/SECF.golden.test.ts` | `SECF apple` at the frozen clock deep-equals `SECF.default.json`: `hits[0].instrument.display === 'AAPL US Equity'`, `matchedOn === 'name'`, `identifiers.figi === 'BBG000B9XRY4'`, `identifiers.isin === 'US0378331005'`, `identifiers.cusip === '037833100'`, `memberOf === ['SPX']`, `gicsSector === 'Information Technology'`, `source === 'master'`; `facets.assetClass.equity` equals the pre-page count, unchanged by `SIZE=1` |
| resolver unit | `packages/server/test/unit/functions/SECF.resolve.test.ts` | against the seeded master: `SECF US0378331005` → one hit `matchedOn:'isin'`, `score === 1`; `SECF 037833100` → `matchedOn:'cusip'`; `SECF BBG000B9XRY4` → `matchedOn:'figi'`; `EXCH=UW`, `EXCH=XNAS` and `EXCH=US` all match the AAPL listing; `STATUS=active` excludes a seeded delisted instrument that `STATUS=ALL` includes; `IDX=NDX` drops the filter and adds the `MEMBERSHIP_SPX_ONLY` unavailable entry |
| paging | `packages/server/test/integration/functions/SECF.paging.test.ts` | `SECF SIZE=20` over the seeded universe: page 1 ∪ page 2 has no duplicates and no gaps against the unpaged query; the `fwd` cursor decodes to `{ s, i }` and PAGE BACK from page 2 returns page 1 byte-identically; a tampered cursor → `400 VALIDATION_FAILED`; `sort:'name'` pages with the `{ n, i }` key |
| yahoo fallback | `packages/server/test/integration/functions/SECF.fallback.test.ts` | a query with fewer than 3 master hits replays `yahoo-search` and returns `source:'master+yahoo'` with ≤ 8 muted hits, `instrumentId === -1`, every `identifiers.*` null and a `yahoo.search` provenance row; with the circuit forced open the payload is `source:'master'` plus the `YAHOO_FALLBACK_UNAVAILABLE` entry and no throw; for a firm without the grant, `YAHOO_FALLBACK_NOT_LICENSED` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `SECF.default.csv`; `memberOf` is `|`-joined; a null identifier writes an empty field, never `null` |
| parity | `packages/server/test/parity/fn-parity.test.ts` | the `SECF apple` hit list equals `GET /search?q=apple` ordering for the overlapping rows (one `rank()`, API-05, TERM-02) |
| screen | `packages/web/test/screens/SECF.test.tsx` | renders the golden; `matched` ranges are highlighted in the key column; `1`..`8` switch tabs and call `setParams` with the asset class; `X` and `S` prompt and set params; `PageDown` calls `ctx.page('fwd')`; `Enter` on a master row navigates to `DES`, on a Yahoo row calls `sdk.ref.resolve` first; `payload undefined` renders the skeleton |
| e2e | `packages/e2e/tests/security-finder.spec.ts` | typing `ZZZZ US Equity DES <GO>` shows the `NOT_IN_UNIVERSE` problem with `SECF` offered; `<GO>` on it opens SECF pre-filled with `ZZZZ`; retyping `apple`, `Enter` on the first row opens `AAPL US Equity DES` in the same panel and `Shift+Enter` opens it in panel 2; `Ctrl+W` adds it to `MAG7` and `W <GO>` shows it |

---

## Additions required (this document)

Nothing below exists in CONTRACTS.md, FUNCTIONS.md, API.md or DATA_MODEL.md today. Each is declared here
so that WP-01 (framework types), WP-04 (readers) and WP-09 (HELP routes) can land it before the resolvers
above compile.

| # | Addition | Where it must be declared | Used by |
| --- | --- | --- | --- |
| 1 | `ReadThroughKind` gains `'yahoo.search'` — the fifteenth member of the union in FUNCTIONS.md §1.4.2 (L266-268). It mirrors the `ProviderId 'yahoo.search'` that PROVIDERS.a §1.1 already declares and the `yahoo.search` row in the PROVIDERS.b §15 registry, so no licence, adapter or `assert_source_known` change is needed — only the kind union. | `packages/core/src/functions/manifest.ts` (WP-01) | SECF resolver step 6; `SECF.fallback.test.ts` |
| 2 | `DataServices.reference.licences(): Promise<LicenceSummary[]>` — a new member of the `reference` service (FUNCTIONS.md §1.4.2 L279-285), reading `licence_registry` at `tx_to='infinity'`, returning the API.md §7 L1083 `LicenceSummary` shape plus `provenanceId` and `txFrom`. | `packages/core/src/functions/manifest.ts` (declaration, WP-01); `packages/server/src/data/reference.ts` (implementation, WP-04) | HELP resolver steps 2 and 5 (footer attribution, `ctx.prov.add`) |
| 3 | `DataServices.help.tickets({ status?, scope:'own'\|'all' })` — a new `help` service. | as above | HELP resolver step 4 |
| 4 | `packages/core/src/functions/helpIndex.ts` — new file, `searchHelp(index, query, limit)` over the registry, the field dictionary, `topics` and the shell word list. | WP-01 | HELP resolver step 3 |
| 5 | Field id `RET_YTD` (see §W, line 24) — new dictionary entry plus its `field_licence` row (`internal.derived`), without which startup fails the API.md §7 rule-1 check. | `packages/core/src/fields/defs/*.ts` (WP-01) + `seed/licences.ts` | W |

Explicitly **not** additions: `sec.tickers`, `openfigi.mapping` and `yahoo.search` are existing
`licence_registry` rows; there is no `openfigi.search` and no `sec.companyTickers` source id.
