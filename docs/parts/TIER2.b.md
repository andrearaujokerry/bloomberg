### EQS — Equity Screening

| Attribute | Value |
| --- | --- |
| Code / aliases | `EQS` / `SCREEN` |
| Tier / category | 2 / screening |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/EQS.ts` · `packages/core/src/functions/shared/screen.ts` · `packages/server/src/functions/EQS/resolve.ts` · `packages/web/src/screens/EQS/Screen.tsx` · `fixtures/golden/functions/EQS.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (TERM-02) (TERM-06) (TERM-08) (TERM-12) (DATA-06) (DATA-10) (REF-03) (REF-07) (REF-08) (STOR-06) (ENTL-01) (ENTL-05) (API-02) (API-05) (NEWS-07) |

#### Params
```ts
/** packages/core/src/functions/shared/screen.ts — shared with the /saved-searches route (kind 'eqs'), DATA_MODEL saved_searches.query */
export const EqsFactor = z.enum([
  // quote / bars (source class 'quote' | 'bars')
  'PX_LAST', 'CHG_PCT_1D', 'PX_VOLUME', 'VOLUME_AVG_30D', 'PX_HIGH_52W', 'PX_LOW_52W',
  'RET_1D', 'RET_1W', 'RET_1M', 'RET_3M', 'RET_YTD', 'RET_1Y', 'VOL_30D', 'BETA_1Y',
  // reference / corporate actions (source class 'reference' | 'actions')
  'CUR_MKT_CAP', 'EQY_SH_OUT', 'PUBLIC_FLOAT', 'EQY_FLOAT_PCT', 'SHORT_INT_RATIO', 'IDX_MEMBER_WEIGHT', 'DVD_YIELD',
  // fundamentals from fin_statements (source class 'statements')
  'SALES_REV_TURN', 'GROSS_PROFIT', 'IS_OPER_INC', 'NET_INCOME', 'IS_EPS_DIL', 'FREE_CASH_FLOW',
  'NET_MARGIN', 'SALES_GROWTH_YOY', 'RETURN_COM_EQY', 'PE_RATIO', 'PX_TO_BOOK_RATIO', 'PX_TO_SALES_RATIO', 'EV_TO_EBITDA',
  // fundamentals from the xbrl_frames cross-section (source class 'frames')
  'BS_TOT_ASSET', 'BS_TOT_LIAB2', 'TOTAL_EQUITY', 'CF_CASH_FROM_OPER',
]);
export const EqsOp = z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'between', 'top', 'bottom']);
export const EqsCriterion = z.object({
  factor: EqsFactor,
  op: EqsOp,
  value: z.number().nullable().default(null),      // gt/gte/lt/lte/eq/ne: the threshold; between: lower bound; top/bottom: the count n
  value2: z.number().nullable().default(null),     // between: upper bound; null otherwise
});
export const ScreenCriteria = z.object({           // persisted shape of saved_searches.query when kind = 'eqs'
  universe: z.enum(['INDEX', 'EQUITY', 'ETF', 'WATCHLIST']).default('INDEX'),
  index: z.string().max(12).default('SPX'),
  watchlistId: z.number().int().nullable().default(null),
  sector: z.string().max(64).nullable().default(null),        // GICS sector name, e.g. 'Information Technology'
  exchange: z.string().max(4).nullable().default(null),       // instruments.exch_code / listings.mic
  country: z.string().length(2).nullable().default(null),     // issues.country_of_issue
  criteria: z.array(EqsCriterion).max(8).default([]),
  columns: z.array(EqsFactor).min(1).max(12).default(['CUR_MKT_CAP', 'PX_LAST', 'CHG_PCT_1D', 'RET_1Y', 'BS_TOT_ASSET']),
  sort: SortSpec.default({ col: 'CUR_MKT_CAP', dir: 'desc' }),               // SortSpec from core/functions/schemas.ts (TIER1 §0.1)
});

// packages/core/src/functions/manifests/EQS.ts
export const EqsParams = ScreenCriteria.extend({
  pageSize: z.number().int().min(20).max(200).default(50),
  knownAt: z.iso.datetime().optional(),            // PIT override for the fundamental factors (STOR-06); undefined = ctx.asOf.knownAt
  savedSearchId: z.number().int().optional(),      // load saved_searches.query and merge it UNDER the explicit params
});
```

#### Argument grammar
`positional [{ name:'universe', type:'enum', values:['INDEX','EQUITY','ETF','WATCHLIST'], optional:true }]`, `keyed { IDX: { name:'index', type:'index' }, WL: { name:'watchlistId', type:'watchlist' }, SEC: { name:'sector', type:'string' }, EXCH: { name:'exchange', type:'string' }, CTRY: { name:'country', type:'currency' }, SORT: { name:'sort', type:'string' }, COLS: { name:'columns', type:'string' }, N: { name:'pageSize', type:'int' }, KNOWN: { name:'knownAt', type:'datetime' }, SAVED: { name:'savedSearchId', type:'int' } }`, `rest { name:'criteria', type:'text' }`.
`rest` is parsed by `parseCriteria(text)` in `core/functions/shared/screen.ts`: whitespace-separated terms `FACTOR<op>NUMBER` with `op ∈ > >= < <= = <>`, `FACTOR=A..B` → `between`, `FACTOR#TOPn` / `FACTOR#BOTn` → `top` / `bottom` with `value = n`. Numbers accept `1e11`, `12.5`, `25%` (→ 0.25) and `1.2B`/`350M`/`40K`. `SORT=RET_1Y:desc` → `{ col:'RET_1Y', dir:'desc' }`; `COLS=PE_RATIO,RET_1Y` replaces `columns`. An unparseable term yields `CommandProblem { code:'ARG_PARSE' }` and the term is dropped (§2.4).
Examples: `EQS` → `{ universe:'INDEX', index:'SPX', criteria:[], columns:[CUR_MKT_CAP,PX_LAST,CHG_PCT_1D,RET_1Y,BS_TOT_ASSET], sort:{col:'CUR_MKT_CAP',dir:'desc'}, pageSize:50 }` · `EQS SPX BS_TOT_ASSET>5e10 NET_MARGIN>20% SORT=BS_TOT_ASSET:desc` → `{ universe:'INDEX', index:'SPX', criteria:[{factor:'BS_TOT_ASSET',op:'gt',value:5e10,value2:null},{factor:'NET_MARGIN',op:'gt',value:0.2,value2:null}], sort:{col:'BS_TOT_ASSET',dir:'desc'} }` · `EQS EQUITY RET_1Y#TOP50 EXCH=US COLS=RET_1Y,VOL_30D N=100` → `{ universe:'EQUITY', criteria:[{factor:'RET_1Y',op:'top',value:50,value2:null}], exchange:'US', columns:['RET_1Y','VOL_30D'], pageSize:100 }`.

#### Payload
```ts
import type { MonitorRow, MonitorColumn } from '../shared/monitor';   // TIER1 §0.2 — reused verbatim

export type EqsFactorSource = 'quote' | 'bars' | 'reference' | 'actions' | 'statements' | 'frames';
export type EqsPayload = {
  variant: 'default';
  universe: { kind: 'INDEX' | 'EQUITY' | 'ETF' | 'WATCHLIST'; label: string /* 'SPX Index members (2026-09-14)' */;
              indexInstrumentId: number | null; watchlistId: number | null; asOfDate: string | null; size: number; provIdx: number };
  filters: { sector: string | null; exchange: string | null; country: string | null };
  criteria: Array<{ factor: EqsFactor; op: EqsOp; value: number | null; value2: number | null; label: string /* 'Total assets > 50.00B' */;
                    source: EqsFactorSource; passed: number; noData: number; unavailableReason: string | null }>;   // evaluation order = array order
  columns: MonitorColumn[];                                            // monitorColumn(factor) for every params.columns entry, in order
  rows: Array<MonitorRow & { rank: number; gicsSubIndustry: string | null; issuerId: number | null; cik: string | null }>;
  counts: { universe: number; afterFilters: number; afterCriteria: number; returned: number; excludedNoData: number };
  knownAt: string; frame: string | null;                               // 'CY2024Q4I' — the xbrl_frames period the 'frames' factors were read at
  savedSearch: { searchId: number; name: string } | null;
  notes: string[];                                                     // 'FRAMES_NOT_POINT_IN_TIME', 'FUNDAMENTALS_NOT_INGESTED', 'NO_HISTORY' …
};
```
`MonitorRow.cells` is keyed by the `MonitorColumn.id` (= the `EqsFactor` id); every cell is a `ValueCell` built by the rules of TIER1 §0.4 (plant cells via `cellFromState`, stored/derived cells with `st:'closed'`, absent values `{ v:null, st:'na', provIdx:-1 }`). `MonitorRow.subject` is `q:<instrumentId>` for every row.

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `instruments` (current, `asset_class`, `status`, `exch_code`), `issues` (`country_of_issue`), `issuers` (`cik`), `identifiers` (CIK), `indices`, `index_members` (current, `weight`), `entity_classifications` + `classification_codes` (scheme `GICS`, via `entity_classifications_lookup_idx`), `watchlists`, `watchlist_items`, `bars_daily` (cross-section via `bars_daily_date_idx`), `quote_snapshots`, `fin_statements` (PIT on `filed_at ≤ knownAt`), `xbrl_frames` (PK `(taxonomy, concept, unit, frame, cik)`), `short_interest`, `corporate_actions` (cash dividends for `DVD_YIELD`) |
| Data services (§1.4.2) | `data.reference.members`, `data.workspace.watchlist`, `data.fundamentals.frames`, `data.fundamentals.statements`, `data.snapshot.fields`, `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | None. EQS is a cross-section screen: per TIER1 §0.4 rule 2 it never calls `ctx.providers.ensure` (503 names × a 3.7 MB companyfacts fetch is not a request-path operation). `xbrl_frames` is filled by the weekly `secFrames.ts` job (`sec.frames`, ARCHITECTURE §7.1); `fin_statements` by whatever FA/EE have already ingested. Missing data is reported, never fetched inline. |
| Engines (`core/analytics`) | `core/analytics/stats` for `RET_1W`/`RET_1M`/`RET_3M`/`RET_1Y`/`RET_YTD`/`VOL_30D`/`BETA_1Y`/`PX_HIGH_52W`/`PX_LOW_52W`/`VOLUME_AVG_30D` through `server/src/functions/shared/returns.ts#periodReturns` (TIER1 §0.6 conventions); `meta.engines` carries `{ name:'stats', version:'1.0.0', inputsHash }` |
| Subjects (live) | `q:<instrumentId>` for every row on the current page, only when `params.columns` contains a `quote`-source factor |
| Field ids (`fieldIds(assetClass)`) | `null → EqsFactor.options` (the whole whitelist above — the entitlement pre-check set, so a firm without `sec.companyfacts` is told once rather than per column) |

Field ids used here that are not in the API.md §7 excerpt and not defined by TIER1 §0.3 are introduced by this entry (FUNCTIONS.md §1.8 step 6 — add to `core/fields/dictionary.ts` and `providers/licences.ts`; `since:'2026.09.1'`):

| id | label | type / unit | decimals | fieldClass | derivation | sources | pit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `RET_3M` | 3-month return | number / pct | 2 | analytic | `close(t)/close(t₋) − 1`, `t₋` = last session ≤ `t − 3 months` (TIER1 §0.6 calendar rule) | `{ assetClass:'*', sourceId:'internal.derived', endpoint:'bars_daily', providerPath:'core/analytics/stats' }` | no |
| `NET_MARGIN` | Net margin | number / pct | 2 | derived | `fin_statements.net_inc / fin_statements.revenue` for the same row | `{ assetClass:'equity', sourceId:'internal.derived', endpoint:'fin_statements', providerPath:'server/src/data/fundamentals.ts' }` | yes |
| `SALES_GROWTH_YOY` | Revenue growth (YoY) | number / pct | 2 | derived | `revenue(FY or TTM) / revenue(same period, one year earlier) − 1`; `null` when either side is null or ≤ 0 | same as `NET_MARGIN` | yes |
| `PX_TO_SALES_RATIO` | Price / sales | number / ratio | 2 | derived | `CUR_MKT_CAP / revenue(TTM)` | same as `NET_MARGIN` | yes |
| `EQY_FLOAT_PCT` | Free float | number / pct | 2 | derived | `PUBLIC_FLOAT / EQY_SH_OUT` | `{ assetClass:'equity', sourceId:'internal.derived', endpoint:'xbrl_facts', providerPath:'core/fields/derive.ts' }` | yes |

#### Resolver
`default` (`resolve`; no variants — `assetClasses:'none'`):
1. `knownAt = params.knownAt ? min(new Date(params.knownAt), ctx.asOf.knownAt) : ctx.asOf.knownAt` (never forward of the request, STOR-06). When `params.savedSearchId` is set, load `saved_searches` (`kind='eqs'`, owner = `ctx.user`) and re-parse its `query` through `ScreenCriteria`; explicit params win over the saved ones; unknown id → `ctx.unavailable.add({ field:'savedSearch', reason:'NO_SOURCE', detail:'saved screen not found or not owned by this user' })` and continue with the params as given.
2. **Universe** (1 DB round-trip). `INDEX` → `data.reference.members(indices.instrument_id for params.index, ctx.asOf.validAt)` — current `index_members` rows with `weight` (REF-07); `asOfDate` = the members' `as_of_date`; one `ctx.prov.add` for the membership file (`sec.archives` or `ssga.holdings`, `tier:'eod'`, `st:'closed'`) stored as `universe.provIdx`. `EQUITY`/`ETF` → current `instruments` with `asset_class = 'equity' | 'etf'` and `status = 'active'`. `WATCHLIST` → `data.workspace.watchlist(params.watchlistId)` items with `instrument_id IS NOT NULL` (formula rows are skipped and counted in `counts.excludedNoData`). Unknown index code → `unavailable.add({ field:'universe', reason:'NO_SOURCE', detail:'no membership source for <code> (indices.membership_source_id is null)' })`, `rows: []`.
3. **Reference filters** (same round-trip, joined): `sector` against `entity_classifications` (`scheme='GICS'`, `level=1`) joined to `classification_codes.name`, `exchange` against `instruments.exch_code`, `country` against `issues.country_of_issue`, all read as-of `ctx.asOf` (REF-03). `counts.afterFilters` recorded.
4. **Factor loading**, one query per source class over the surviving instrument ids (at most 4 more round-trips, none per row):
   - `quote` (`PX_LAST`, `CHG_PCT_1D`, `PX_VOLUME`): `plant.ensureHot(subjects)` then `plant.snapshotMany(subjects)`; cells via `cellFromState(ctx, state, field, subject)`; a name never polled is `pendingCell` and the WS `snap` fills it (TIER1 §0.4 rule 1).
   - `bars`: one cross-section read of `bars_daily` over the last 260 sessions for the whole id set (`bars_daily_date_idx`), then `periodReturns(bars, calendar, asOfDate)` per instrument. Fewer than 2 sessions → every `bars` factor is `{ v:null, st:'na', provIdx:-1 }` and the row is counted in `counts.excludedNoData` for any criterion on a `bars` factor; note `NO_HISTORY`.
   - `reference`/`actions`: `EQY_SH_OUT`/`PUBLIC_FLOAT` from the latest `xbrl_facts` `dei` values already stored for the issuer; `EQY_FLOAT_PCT = PUBLIC_FLOAT / EQY_SH_OUT`; `CUR_MKT_CAP = PX_LAST × EQY_SH_OUT` (`st` = the weaker of the quote cell's state and `'closed'`); `SHORT_INT_RATIO` from the latest `short_interest.days_to_cover`; `IDX_MEMBER_WEIGHT` from step 2; `DVD_YIELD` per TIER1 §0.3.
   - `statements`: `data.fundamentals.statements` batched by issuer for the issuers that already have `fin_statements` rows with `filed_at ≤ knownAt`; `periodType` `TTM` with `FY` fallback. `PE_RATIO = PX_LAST / eps_dil`, `PX_TO_BOOK_RATIO = CUR_MKT_CAP / equity`, `PX_TO_SALES_RATIO = CUR_MKT_CAP / revenue`, `EV_TO_EBITDA = (CUR_MKT_CAP + lt_debt − cash) / (oper_inc + dda)`, `NET_MARGIN = net_inc / revenue`, `SALES_GROWTH_YOY` per the table above, `RETURN_COM_EQY = net_inc / equity`; any null or non-positive denominator → `{ v:null, st:'na' }`. Issuers with no stored statements → note `FUNDAMENTALS_NOT_INGESTED` and `ctx.unavailable.add({ field:<factor>, reason:'NO_SOURCE', detail:'FUNDAMENTALS_NOT_INGESTED: SEC companyfacts have not been ingested for <n> of <m> issuers in this universe; open FA on a name to ingest it' })` once per factor.
   - `frames`: `data.fundamentals.frames(concept, frame)` → `Map<cik, number>`, one call per distinct concept. Factor → concept/unit: `BS_TOT_ASSET → us-gaap:Assets/USD` (instant, `frame = 'CY<y>Q<q>I'`), `BS_TOT_LIAB2 → us-gaap:Liabilities/USD` (instant), `TOTAL_EQUITY → us-gaap:StockholdersEquity/USD` (instant), `CF_CASH_FROM_OPER → us-gaap:NetCashProvidedByUsedInOperatingActivities/USD` (duration, `frame = 'CY<y>Q<q>'`). `payload.frame` = the newest frame present in `xbrl_frames` for that concept with `captured_at ≤ knownAt`. A concept with no ingested frame → the column renders `—` and `ctx.unavailable.add({ field:<factor>, reason:'NO_SOURCE', detail:'FRAME_NOT_INGESTED: the weekly sec.frames job has not fetched <concept> <frame>' })`; the criterion on it is marked `unavailableReason` and is **not** applied (it would silently empty the screen). One `ctx.prov.add` per frame capture (`sec.frames`, `tier:'eod'`, `st:'closed'`). When any contributing `xbrl_frames` row has `filed_at IS NULL`, add note `FRAMES_NOT_POINT_IN_TIME` (DATA_MODEL §20 decision 4).
5. **Criteria** are applied in array order over the loaded cells. `gt/gte/lt/lte/eq/ne` compare `cell.v`; `between` is inclusive on both bounds; `top`/`bottom` keep the `value` best/worst rows by that factor after the earlier criteria. A row whose cell for the criterion's factor is `null` is **excluded and counted** in `criteria[i].noData` — it is never treated as passing and never given a substitute value. `criteria[i].passed` is the surviving count. `counts.afterCriteria` = survivors; `counts.excludedNoData` = the sum of `noData`.
6. **Sort and page.** Order by `params.sort.col` (`nulls last` in both directions) then `instrument_id` asc as the tiebreak. `ctx.page`: cursor = `base64url(JSON.stringify({ v: <sort value of the last row on the page, or null>, id: <its instrumentId> }))`; PAGE FWD = the next `pageSize` rows further down the sort order, PAGE BACK = the previous page (the cursor is re-encoded from the first row and the comparison is inverted); `ctx.page.info = { cursor, hasMore, index, count }`. `rank` is the 1-based position in the full sorted result, not in the page.
7. `ctx.engines.add({ name:'stats', version:'1.0.0', inputsHash: sha256(canonicalJson({ instrumentIds, asOfDate, conventions })) })` when any `bars` factor is present; return the payload.
Budget: 5 DB round-trips (universe+filters, bars cross-section, statements, frames, reference facts) plus one in-process `plant.snapshotMany`; zero provider calls. p95 < 900 ms for the 503-name SPX universe, < 2.5 s for the 35.6k `EQUITY` universe (the `bars_daily` cross-section dominates); first paint is the grid skeleton.

#### Live
```ts
live: (params, payload) => payload.columns.some(c => c.id === 'PX_LAST' || c.id === 'CHG_PCT_1D' || c.id === 'PX_VOLUME')
  ? { subjects: payload.rows.map(r => r.subject), fields: ['PX_LAST', 'CHG_PCT_1D', 'PX_VOLUME'], conflationMs: 1000 }
  : null
```
The grid's `live.subjectOf = row => row.subject`; only the page's rows are subscribed, so PAGE FWD resubscribes. `CUR_MKT_CAP` and the price multiples are **not** live: they are resolver values at `ctx.asOf` with `st:'closed'`, so the screen, the CSV and the WS snapshot agree (API-05).

#### Screen
```
┌ EQS · Equity Screening · SPX Index members ─────────────────────────────────────────────┐
│ form#criteria   universe [INDEX ▾] index [SPX] sector [—] exch [—] ctry [—]              │
│                 1 BS_TOT_ASSET  [>]  [50.00B]    (passed 71 · no data 0)                 │
│                 2 NET_MARGIN    [>]  [20.00%]    (passed 38 · no data 465  FUND_NOT_ING) │
│ badges#state    [503 universe → 503 filtered → 38 screened · page 1/1]                   │
│                 [FRAMES_NOT_POINT_IN_TIME] [FUNDAMENTALS_NOT_INGESTED 465/503]           │
│ grid#results    # | key | name | sector | mkt cap (ccy 0dp) | last (live px) |            │
│                 chg% (live pct 2dp) | 1y (pct 2dp) | assets (ccy 0dp) | …                 │
│                 frozenColumns 3 · sortable · groupBy gicsSector when G pressed            │
│ text#counts     38 of 503 match · 465 excluded for missing data (see badges)              │
│ footer: sources ['SEC EDGAR N-PORT (SPY holdings)', 'SEC EDGAR XBRL frames',              │
│                  'Cboe delayed quotes', 'Yahoo Finance daily bars'] asOf · knownAt        │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```
Title `EQS · Equity Screening`; subtitle `<universe.label> · <counts.afterCriteria> of <counts.universe>`; `initialFocus:'results'` when `rows.length > 0`, `'criteria'` otherwise. Skeleton while `payload === undefined`: the `form` with the params already typed plus a `grid` of `params.pageSize` muted rows and the column headers derived from `params.columns` (so the layout does not jump). `meta.unavailable` entries render as `badges#state` items with `tone:'warn'` and the `detail` as the badge `title`; a column whose factor is wholly unavailable keeps its header, renders every cell as `—` with the reason as tooltip, and its header carries a `blocked` badge — the column is never dropped, so the screen cannot be mistaken for a complete one. `meta.entitlement` downgrades (ENTL-05) render the same way with the `ReasonCode` as tooltip; `meta.staleness:'stale'` puts the stale glyph on `badges#state` (TERM-12). `emptyText` when `rows.length === 0`: `No securities match — <counts.excludedNoData> were excluded for missing data; press C to relax the screen.`

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `C` | always | `focus-criteria` | `ctx.focus('criteria')` — edit the criteria form in place; submit re-runs with `launchKind:'param'` |
| `A` | form | `add-criterion` | appends an empty `EqsCriterion` row; the factor cell is a `ctx.prompt('field')` typeahead over `EqsFactor.options` |
| `Delete` | form | `remove-criterion` | removes the focused criterion row and re-runs |
| `U` | always | `cycle-universe` | `INDEX → EQUITY → ETF → WATCHLIST → INDEX` via `setParams({ universe })`; `WATCHLIST` first opens `ctx.prompt('watchlist')` |
| `X` | always | `set-index` | `ctx.prompt('text', { label:'Index code', initial: params.index })` → `setParams({ index })` |
| `F` | grid | `add-column` | `ctx.prompt('field')` over `EqsFactor.options` → `setParams({ columns: [...columns, factor] })` |
| `Delete` | grid | `remove-column` | removes the focused grid column from `params.columns` |
| `S` | grid | `sort-by-column` | `setParams({ sort: { col: focusedColumnId, dir: sort.col === focusedColumnId && sort.dir === 'desc' ? 'asc' : 'desc' } })` |
| `G` | grid | `toggle-group` | toggles `groupBy:'gicsSector'` on the grid (client-only, no re-run) |
| `Ctrl+S` | always | `save-screen` | `ctx.prompt('text', { label:'Screen name' })` → `POST /saved-searches { kind:'eqs', name, query: ScreenCriteria.parse(params) }` (NEWS-07) |
| `O` | always | `open-saved` | `ctx.prompt('text', { label:'Saved screen' })` → `setParams({ savedSearchId })` |
| `Enter` | grid | `open-des` | `ctx.navigate(row.key + ' DES')` |
| `Shift+Enter` | grid | `open-des-next` | `ctx.navigateNext(row.key + ' DES')` |
| `V` | grid | `open-rv` | `ctx.navigate(row.key + ' RV')` — the screened name against its peers |
| `Alt+F` | grid | `open-fa` | `ctx.navigate(row.key + ' FA')` |
| `Ctrl+W` | grid | `add-watchlist` | `ctx.prompt('watchlist')` then `sdk.watchlists.setItems` with the whole current page |

#### CSV
`filename = 'EQS_' + (params.universe === 'INDEX' ? params.index : params.universe) + '_' + asOf.replace(/[-:]/g,'') + '.csv'`.
`csv.columns` is a function of the payload (`(params, payload) => [...]`): the static prefix `rank,key,name,assetClass,exchange,gicsSector,gicsSubIndustry,cik` (types `number,string,string,string,string,string,string,string`) followed by one `{ id: col.id, label: col.label, type:'number', decimals: col.decimals }` per `payload.columns[i]`.
`rows`: one row per `payload.rows[]` in payload order (the current page only — PAGE FWD then PRINT exports that page; `Ctrl+E` on the grid exports the same rows through `/data/csv`), values are `cells[col.id].v` at full precision, `null` for an absent or denied value. The screen definition travels in the `#` comment header written by `writeCsv`: `# screen: universe=SPX sector=- criteria=BS_TOT_ASSET>50000000000;NET_MARGIN>0.2 sort=CUR_MKT_CAP:desc knownAt=2026-09-15T18:41:28Z frame=CY2024Q4I` and one `# unavailable: <field> <reason> <detail>` line per `meta.unavailable` entry.
Example row: `1,MSFT US Equity,Microsoft Corporation,equity,US,Information Technology,Systems Software,0000789019,3612480000000,486.12,0.0071,0.2184,562624000000`.

#### Help
summary `Multi-factor equity screens over the index, listed or watchlist universe`; description `EQS screens a universe by any combination of up to eight factors. Choose the universe (an index's members, all US listed equities or ETFs, or a watchlist), add criteria as FACTOR>VALUE terms on the command line or in the criteria form, pick the columns you want and sort on any of them. Price and volume factors come from the exchange quote and the daily bars; balance-sheet factors come from the SEC XBRL frames cross-section; income-statement factors and the valuation multiples come from standardised SEC filings and are therefore only available for issuers whose filings have already been ingested — press F on a name in FA to ingest it. A security whose value for a criterion is missing is excluded from the result and counted under "no data": EQS never guesses a number to keep a row in. Press Ctrl+S to save a screen and reuse it, V on a row for its peer comparison, Enter for the security description.`; params: `universe` ("INDEX, EQUITY, ETF or WATCHLIST", example `EQS EQUITY`), `index` ("index code when universe is INDEX", `IDX=SPX`), `watchlistId` ("watchlist when universe is WATCHLIST", `WL=Core`), `sector` ("GICS sector name", `SEC=Energy`), `exchange` ("composite exchange code", `EXCH=US`), `country` ("ISO country of issue", `CTRY=US`), `criteria` ("FACTOR>VALUE terms, A..B for a range, #TOP50 for a rank cut", `RET_1Y#TOP50`), `columns` ("factor ids to show", `COLS=PE_RATIO,RET_1Y`), `sort` ("column and direction", `SORT=RET_1Y:desc`), `pageSize` ("20–200 rows per page", `N=100`), `knownAt` ("point-in-time date for the fundamental factors", `KNOWN=2026-06-01`), `savedSearchId` ("load a saved screen", `SAVED=3`); sources `['sec.frames', 'sec.companyfacts', 'sec.archives', 'ssga.holdings', 'wiki.sp500', 'cboe.quotes', 'yahoo.chart', 'finra.shortInterest', 'internal.derived']`; related `['RV', 'FA', 'SECF', 'MEMB', 'QM', 'W']`.

#### Unavailable and reason codes
`{ field:<factor>, reason:'NO_SOURCE', detail:'FRAME_NOT_INGESTED: the weekly sec.frames job has not fetched <taxonomy>:<concept> <frame>' }` — offline the only ingested frame is `us-gaap:Assets` `CY2024Q4I` (6,264 CIKs, `sec-frames-assets.json`), so `BS_TOT_LIAB2`, `TOTAL_EQUITY` and `CF_CASH_FROM_OPER` emit this until the job has run · `{ field:<factor>, reason:'NO_SOURCE', detail:'FUNDAMENTALS_NOT_INGESTED: SEC companyfacts have not been ingested for <n> of <m> issuers in this universe; open FA on a name to ingest it' }` for every `statements`-source factor · `{ field:<factor>, reason:'NO_SOURCE', detail:'NO_HISTORY: fewer than 2 daily bars for <n> instruments' }` for every `bars`-source factor · `{ field:'universe', reason:'NO_SOURCE', detail:'no membership source for <code> (indices.membership_source_id is null)' }` · `{ field:'savedSearch', reason:'NO_SOURCE', detail:'saved screen not found or not owned by this user' }` · `{ field:'PUBLIC_FLOAT', reason:'NO_SOURCE', detail:'no free-float source in the wedge; dei:EntityPublicFloat is filed annually and only by some registrants' }` (so `EQY_FLOAT_PCT` is mostly `—`). Screen badges: `FRAMES_NOT_POINT_IN_TIME` (an `xbrl_frames` row with `filed_at IS NULL` contributed, so `knownAt` was not enforceable for it), `FUNDAMENTALS_NOT_INGESTED <n>/<m>`, `NO_HISTORY <n>`, `CRITERION_NOT_APPLIED` (a criterion whose factor is wholly unavailable). Entitlement: `NO_FIRM_ENTITLEMENT`/`NO_USER_ENTITLEMENT` on `sec.companyfacts` or `sec.frames` blanks those columns with the `ReasonCode` in `cell.r` (ENTL-05); a denial on `cboe.quotes` blanks `PX_LAST`/`CHG_PCT_1D` and therefore `CUR_MKT_CAP` and the price multiples. `PROVIDER_DOWN` (circuit open on `cboe.quotes`) → quote cells `st:'stale'` with last values, `meta.staleness:'stale'` (TERM-12).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared); `EqsParams.parse({})` succeeds, every `paramGrammar` name is a params key, `fieldIds(null)` ⊆ `core/fields/dictionary.ts` |
| golden payload | `packages/server/test/integration/functions/EQS.golden.test.ts` | resolver at the frozen clock `2026-09-15T18:41:28Z` over the seeded SPX universe (`sec-nport-SPY-primary_doc.xml`, `ssga-spy-holdings.xlsx`, `wiki-sp500.html`, `sec-frames-assets.json`) with `criteria:[{factor:'BS_TOT_ASSET',op:'gt',value:5e10}]` deep-equals `fixtures/golden/functions/EQS.default.json`; `payload.frame === 'CY2024Q4I'`; `counts.universe === 503` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `fixtures/golden/functions/EQS.default.csv`; every numeric cell equals `rows[i].cells[col.id].v`; the `# screen:` header round-trips through `parseCriteria` |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at a frozen clock (API-05); only `traceId`, `resultId`, `servedAt`, `staleness` differ between two runs |
| screen | `packages/web/test/screens/EQS.test.tsx` | renders the golden; `C`/`A`/`U`/`F`/`S`/`G`/`O`/`Ctrl+S` reachable by keyboard and each calls the documented `ctx` method; live cells registered for `q:` only when a quote column is present; a wholly unavailable column keeps its header and renders `—` with the `detail` as tooltip; `payload undefined` renders the skeleton with `pageSize` muted rows |
| criteria parser | `packages/core/test/functions/EQS.criteria.test.ts` | `parseCriteria` on `BS_TOT_ASSET>5e10`, `NET_MARGIN>20%`, `PE_RATIO=10..25`, `RET_1Y#TOP50`, `CUR_MKT_CAP>1.2B`; an unknown factor and a malformed term produce `ARG_PARSE` problems and are dropped; round-trip `formatCriteria(parseCriteria(s)) === s` |
| no-data exclusion | `packages/server/test/integration/functions/EQS.nodata.test.ts` | a criterion on `NET_MARGIN` over the seeded universe returns only issuers with `fin_statements`, `criteria[0].noData === counts.universe − criteria[0].passed`, `meta.unavailable` has the `FUNDAMENTALS_NOT_INGESTED` entry, and no row carries a fabricated value; a criterion on `TOTAL_EQUITY` (no ingested frame) is reported `unavailableReason:'FRAME_NOT_INGESTED'` and is not applied |
| paging | `packages/server/test/integration/functions/EQS.page.test.ts` | `pageSize:20` over 503 names: page 1 ranks 1–20, PAGE FWD ranks 21–40 with a new `resultId`, PAGE BACK returns page 1 byte-identical; cursor decodes to `{ v, id }`; `nulls last` holds in both sort directions |
| e2e | `packages/e2e/tests/eqs-screen.spec.ts` | `EQS SPX BS_TOT_ASSET>5e10 <GO>` renders a populated grid; `S` on a column re-sorts; `PageDown` pages; `Ctrl+S` saves and `O` reloads the same screen; `V` on a row opens `RV` for that name; `Ctrl+P` downloads a CSV whose first data row matches the first grid row |

---

### RV — Relative Valuation

| Attribute | Value |
| --- | --- |
| Code / aliases | `RV` / `COMP`, `PEERS` |
| Tier / category | 2 / fundamentals |
| Asset classes → variants | `equity → equity` |
| requiresSecurity / pageable / screenKind | `true` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/RV.ts` · `packages/server/src/functions/RV/resolve.ts` · `packages/web/src/screens/RV/Screen.tsx` · `fixtures/golden/functions/RV.equity.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (DATA-06) (REF-03) (REF-07) (REF-08) (STOR-06) (DATA-10) (TERM-06) (TERM-08) (TERM-12) (ENTL-05) (API-05) (ANAL-07) |

#### Params
```ts
export const RvMetric = z.enum([
  'CUR_MKT_CAP', 'PX_LAST', 'CHG_PCT_1D', 'RET_1Y',
  'PE_RATIO', 'PX_TO_BOOK_RATIO', 'PX_TO_SALES_RATIO', 'EV_TO_EBITDA', 'DVD_YIELD',
  'SALES_REV_TURN', 'NET_INCOME', 'IS_EPS_DIL', 'NET_MARGIN', 'SALES_GROWTH_YOY', 'RETURN_COM_EQY',
  'BS_TOT_ASSET', 'TOTAL_EQUITY', 'FREE_CASH_FLOW',
]);
export const RvParams = z.object({
  peerBasis: z.enum(['SUB_INDUSTRY', 'INDUSTRY', 'INDUSTRY_GROUP', 'SECTOR', 'INDEX', 'CUSTOM']).default('SUB_INDUSTRY'),
  peers: z.array(z.string().max(32)).max(30).default([]),     // CUSTOM only: command-line security refs ('MSFT US Equity')
  index: z.string().max(12).default('SPX'),                   // INDEX basis, and the membership restriction for the GICS bases
  restrictToIndex: z.boolean().default(true),                 // GICS bases: keep only peers that are current members of `index`
  maxPeers: z.number().int().min(3).max(30).default(12),
  metrics: z.array(RvMetric).min(1).max(10)
    .default(['CUR_MKT_CAP', 'PE_RATIO', 'PX_TO_BOOK_RATIO', 'PX_TO_SALES_RATIO', 'EV_TO_EBITDA', 'NET_MARGIN', 'RETURN_COM_EQY', 'SALES_GROWTH_YOY', 'DVD_YIELD']),
  periodType: z.enum(['FY', 'TTM']).default('TTM'),
  rank: z.enum(['CUR_MKT_CAP', 'name', 'metric']).default('CUR_MKT_CAP'),   // 'metric' = the first entry of `metrics`
  knownAt: z.iso.datetime().optional(),
});
```

#### Argument grammar
`positional [{ name:'peerBasis', type:'enum', values:['SUB_INDUSTRY','INDUSTRY','INDUSTRY_GROUP','SECTOR','INDEX','CUSTOM'], optional:true }]`, `keyed { IDX: { name:'index', type:'index' }, N: { name:'maxPeers', type:'int' }, PT: { name:'periodType', type:'enum', values:['FY','TTM'] }, RANK: { name:'rank', type:'enum', values:['CUR_MKT_CAP','name','metric'] }, COLS: { name:'metrics', type:'string' }, RESTRICT: { name:'restrictToIndex', type:'boolean' }, KNOWN: { name:'knownAt', type:'datetime' } }`, `rest { name:'peers', type:'text' }` (comma- or space-separated security refs; setting it implies `peerBasis:'CUSTOM'` unless `peerBasis` was given explicitly).
Examples: `RV` → `{ peerBasis:'SUB_INDUSTRY', index:'SPX', restrictToIndex:true, maxPeers:12, metrics:[the nine defaults], periodType:'TTM', rank:'CUR_MKT_CAP' }` · `RV SECTOR N=20 PT=FY COLS=PE_RATIO,EV_TO_EBITDA,NET_MARGIN` → `{ peerBasis:'SECTOR', maxPeers:20, periodType:'FY', metrics:['PE_RATIO','EV_TO_EBITDA','NET_MARGIN'] }` · `RV MSFT US Equity, GOOGL US Equity, AMZN US Equity` → `{ peerBasis:'CUSTOM', peers:['MSFT US Equity','GOOGL US Equity','AMZN US Equity'] }`.

#### Payload
```ts
export type RvPeerBasis = 'SUB_INDUSTRY' | 'INDUSTRY' | 'INDUSTRY_GROUP' | 'SECTOR' | 'INDEX' | 'CUSTOM' | 'SIC';
export type RvRow = {
  instrumentId: number; key: string /* 'MSFT US Equity' */; name: string; subject: string /* 'q:117' */;
  issuerId: number | null; cik: string | null; exchCode: string;
  gicsSector: string | null; gicsSubIndustry: string | null;
  isTarget: boolean;
  cells: Record<string, ValueCell>;                                    // keyed by RvMetric id
  fundamentals: { periodEnd: string | null; periodType: 'FY' | 'TTM'; filedAt: string | null; accessionNo: string | null; provIdx: number } | null;
  dataState: 'full' | 'partial' | 'none';                              // none = no fin_statements row at knownAt
  unavailableReason: 'FUNDAMENTALS_NOT_INGESTED' | 'NO_CIK' | null;
};
export type RvStat = {
  metric: RvMetric; n: number;                                          // peers with a non-null value (the target excluded)
  min: number | null; p25: number | null; median: number | null; p75: number | null; max: number | null; mean: number | null;
  target: number | null; targetPercentile: number | null;               // fraction 0..1 of peers at or below the target, null when n < 3
  premiumToMedianPct: number | null;                                    // target / median − 1
  reason: 'INSUFFICIENT_PEERS' | null;                                  // set when n < 3
};
export type RvPayload = {
  variant: 'equity';
  target: RvRow;
  peerSet: { basis: RvPeerBasis; requestedBasis: RvPeerBasis; scheme: 'GICS' | 'SIC' | 'INDEX' | 'CUSTOM';
             code: string | null; label: string /* 'Systems Software (GICS 45103010)' */;
             restrictedToIndex: string | null; candidates: number; returned: number; provIdx: number };
  metrics: MonitorColumn[];                                             // monitorColumn(metric) per params.metrics, in order (TIER1 §0.2)
  peers: RvRow[];                                                       // ranked, target excluded
  stats: RvStat[];                                                      // one per metric, same order as `metrics`
  periodType: 'FY' | 'TTM'; knownAt: string;
  notes: string[];                                                      // 'PEER_BASIS_FALLBACK_SIC', 'FUNDAMENTALS_NOT_INGESTED', 'PEERS_TRUNCATED' …
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `instruments`, `issues`, `issuers` (as-of, `cik`), `identifiers` (CIK), `entity_classifications` + `classification_codes` (scheme `GICS` levels 1–4, scheme `SIC`; `entity_classifications_lookup_idx`), `indices`, `index_members` (current), `fin_statements` (PIT on `filed_at ≤ knownAt`), `xbrl_facts` (`dei:EntityCommonStockSharesOutstanding` for `EQY_SH_OUT`), `corporate_actions` (cash dividends for `DVD_YIELD`), `quote_snapshots`, `bars_daily` (`RET_1Y`) |
| Data services (§1.4.2) | `data.reference.instrument`, `data.reference.resolve` (CUSTOM peers), `data.reference.members`, `data.fundamentals.statements`, `data.snapshot.fields`, `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | `('sec.companyfacts', targetCik, { maxAgeMs: 86_400_000 })` — the **target only**, and only when `fin_statements` has no row for it (same first-probe rule as FA step 2). Peers are read from the store: fetching up to 30 × ≈ 3.7 MB of companyfacts on a request path is not done, and a peer without stored statements is reported, not fetched. |
| Engines (`core/analytics`) | `core/analytics/stats` via `server/src/functions/shared/returns.ts#periodReturns` for `RET_1Y` (TIER1 §0.6); percentiles and the peer statistics are plain arithmetic in the resolver (`meta.engines` carries only the `stats` entry, and nothing when `RET_1Y` is not a requested metric) |
| Subjects (live) | `q:<instrumentId>` for the target and every peer row |
| Field ids (`fieldIds(assetClass)`) | `equity: ['PX_LAST','CHG_PCT_1D','RET_1Y','CUR_MKT_CAP','EQY_SH_OUT','PE_RATIO','PX_TO_BOOK_RATIO','PX_TO_SALES_RATIO','EV_TO_EBITDA','DVD_YIELD','SALES_REV_TURN','NET_INCOME','IS_EPS_DIL','NET_MARGIN','SALES_GROWTH_YOY','RETURN_COM_EQY','BS_TOT_ASSET','TOTAL_EQUITY','FREE_CASH_FLOW','GICS_SECTOR_NAME','SIC_CODE','FA_FILED_AT']` |

`NET_MARGIN`, `SALES_GROWTH_YOY` and `PX_TO_SALES_RATIO` are the ids introduced by the EQS entry above (same definitions, same `internal.derived` sources); `DVD_YIELD` is TIER1 §0.3. RV introduces no further field ids.

#### Resolver
`equity` (`resolve`, also `variants.equity`):
1. `knownAt = params.knownAt ? min(new Date(params.knownAt), ctx.asOf.knownAt) : ctx.asOf.knownAt` (STOR-06). `inst = await ctx.data.reference.instrument(ctx.instrument.instrumentId)`; `targetCik = inst.issuer.cik`. No CIK → the target row is built with `dataState:'none'`, `unavailableReason:'NO_CIK'` and `ctx.unavailable.add({ field:'target', reason:'NO_SOURCE', detail:'issuer has no SEC CIK (not an SEC filer); multiples cannot be computed' })`; the peer set is still built so the screen is useful.
2. **Peer set** (1 DB round-trip).
   - `CUSTOM`: `data.reference.resolve` each entry of `params.peers`; an unresolved ref → `ctx.unavailable.add({ field:'peers', reason:'NO_SOURCE', detail:'<ref> did not resolve to an instrument' })`.
   - `INDEX`: current `index_members` of `indices` where `code = params.index`, target excluded.
   - GICS bases: read the target issuer's current `entity_classifications` row for `scheme='GICS'` at the level of `peerBasis` (`SUB_INDUSTRY` = 8-digit code, `INDUSTRY` = 6, `INDUSTRY_GROUP` = 4, `SECTOR` = 2 — `classification_codes.level` 4/3/2/1) as-of `ctx.asOf` (REF-03); peers = every other `equity` instrument whose issuer carries the same code, intersected with the current members of `params.index` when `restrictToIndex`. `peerSet.label` = `classification_codes.name` plus the code.
   - **Fallback**: the target has no GICS row (offline only the 503 S&P names carry GICS, from `wiki.sp500`) → retry with `scheme='SIC'` on `issuers.sic` (`sec.submissions`), `basis:'SIC'`, note `PEER_BASIS_FALLBACK_SIC`, and `ctx.unavailable.add({ field:'peerSet', reason:'NO_SOURCE', detail:'NO_GICS_CLASSIFICATION: no GICS row for this issuer (GICS is seeded for S&P 500 members only); peers taken from SIC <code>' })`. Neither GICS nor SIC → `peers: []`, `peerSet.candidates = 0`, `unavailable.add({ field:'peerSet', reason:'NO_SOURCE', detail:'NO_PEER_BASIS: issuer has neither a GICS nor a SIC classification; pass peers explicitly (RV CUSTOM …)' })`.
   One `ctx.prov.add` for the classification capture (`wiki.sp500` or `sec.submissions`, `tier:'eod'`, `st:'closed'`) as `peerSet.provIdx`.
3. **Rank and truncate.** Order candidates by `params.rank` (`CUR_MKT_CAP` desc, `name` asc, or `metrics[0]` desc with nulls last), keep `maxPeers`; `candidates` > `maxPeers` → note `PEERS_TRUNCATED`. The target is always kept and is never counted as a peer.
4. **Quotes** (no DB round-trip). `subjects = [target, ...peers].map(plant.subjectFor)`; `plant.ensureHot(subjects)`; `states = plant.snapshotMany(subjects)`; `PX_LAST`, `CHG_PCT_1D` cells via `cellFromState` (TIER1 §0.4 rules 1–2 — no `providers.ensure` for the monitor part).
5. **Fundamentals** (2 DB round-trips). `data.fundamentals.statements(cik, { statement:'IS', periodType: params.periodType, periods: 5, knownAt })` batched over every row's CIK; the service takes the latest `fin_statements` version per `period_end` with `filed_at ≤ knownAt`. `fundamentals` = `{ periodEnd, periodType, filedAt, accessionNo, provIdx }` from the newest qualifying row, with one `ctx.prov.add` per distinct companyfacts capture. `EQY_SH_OUT` from the latest stored `dei:EntityCommonStockSharesOutstanding` fact with `filed_at ≤ knownAt`.
6. **Multiples**, computed identically for the target and every peer, each as a `ValueCell` with `st:'closed'`, `ts` = `filedAt`, and `provIdx` = the row's fundamentals `provIdx` (FUNCTIONS.md §1.3 rule 4 — a derived cell cites its primary input):
   `CUR_MKT_CAP = PX_LAST × EQY_SH_OUT` · `PE_RATIO = PX_LAST / eps_dil` · `PX_TO_BOOK_RATIO = CUR_MKT_CAP / equity` · `PX_TO_SALES_RATIO = CUR_MKT_CAP / revenue` · `EV_TO_EBITDA = (CUR_MKT_CAP + lt_debt − cash) / (oper_inc + dda)` · `NET_MARGIN = net_inc / revenue` · `RETURN_COM_EQY = net_inc / equity` · `SALES_GROWTH_YOY = revenue / revenue(same period, prior year) − 1` · `DVD_YIELD` per TIER1 §0.3 · `SALES_REV_TURN`, `NET_INCOME`, `IS_EPS_DIL`, `BS_TOT_ASSET`, `TOTAL_EQUITY`, `FREE_CASH_FLOW` straight from the `fin_statements` columns `revenue`, `net_inc`, `eps_dil`, `tot_assets`, `equity`, `fcf` · `RET_1Y` from `periodReturns`.
   A null, zero or negative denominator, or a missing input, yields `{ v: null, st:'na', provIdx: -1 }` — never an extrapolated or peer-substituted number. `dataState` = `'full'` when every requested metric resolved, `'partial'` when some did, `'none'` when there is no `fin_statements` row at `knownAt` (then `unavailableReason:'FUNDAMENTALS_NOT_INGESTED'`).
7. **Statistics.** For each metric, over the peers only (target excluded) and over non-null values sorted ascending: `min`, `max`, `mean`, `median`, `p25`, `p75` by the nearest-rank method with linear interpolation (`p = (n−1)·q`, `v = v[⌊p⌋] + (p−⌊p⌋)·(v[⌈p⌉] − v[⌊p⌋])`), `targetPercentile = |{peer : v ≤ target}| / n`, `premiumToMedianPct = target / median − 1` (null when `median` is null or zero). `n < 3` → every statistic `null` and `reason:'INSUFFICIENT_PEERS'`, and `ctx.unavailable.add({ field: metric, reason:'NO_SOURCE', detail:'INSUFFICIENT_PEERS: <n> peers have a value for <metric>; at least 3 are needed for a median' })`.
8. Count the rows with `unavailableReason === 'FUNDAMENTALS_NOT_INGESTED'`; when > 0 add the note and `ctx.unavailable.add({ field:'peers', reason:'NO_SOURCE', detail:'FUNDAMENTALS_NOT_INGESTED: SEC companyfacts are not ingested for <n> of <m> peers; their multiple cells are blank and they are excluded from the statistics' })`. Return the payload.
Budget: 4 DB round-trips (instrument, peer set, statements batch, dei facts) plus one in-process `plant.snapshotMany`; < 350 ms p95 warm, < 20 s when the target's companyfacts must be fetched cold (one 3.7 MB document).

#### Live
```ts
live: (params, payload) => ({
  subjects: [payload.target.subject, ...payload.peers.map(p => p.subject)],
  fields: ['PX_LAST', 'CHG_PCT_1D'],
  conflationMs: 1000,
  essential: [payload.target.subject],
})
```
The grid's `live.subjectOf = row => row.subject`; only the `PX_LAST` and `CHG_PCT_1D` cells carry `Cell.live`. The multiples and the statistics are **not** recomputed client-side from a delta: they are resolver values at `ctx.asOf`, so the grid, the statistics table and the CSV never disagree (API-05). A price move therefore flashes the price cell and leaves `PE_RATIO` unchanged until the next run; `badges#state` shows `MULTIPLES AS OF <asOf>` so this is visible rather than surprising.

#### Screen
```
┌ RV · AAPL US Equity · Apple Inc · vs Technology Hardware, Storage & Peripherals ─────────┐
│ kv#basis    basis SUB_INDUSTRY (GICS 45202030) · restricted to SPX · 8 of 11 peers shown  │
│             period TTM · knownAt 2026-09-15 · MULTIPLES AS OF 2026-09-15T18:41:28Z        │
│ badges#state [PEERS_TRUNCATED 11→8] [FUNDAMENTALS_NOT_INGESTED 7/8] [TTM]                 │
│ grid#peers  key | name | mkt cap (ccy 0dp) | last (live px) | chg% (live pct 2dp)         │
│             | P/E (ratio 1dp) | P/B (ratio 2dp) | P/S (ratio 2dp) | EV/EBITDA (ratio 1dp) │
│             | net margin (pct 1dp) | ROE (pct 1dp) | rev growth (pct 1dp) | yield (pct 2dp)│
│             frozenColumns 2 · target row tone 'highlight', always first, never sorted away │
│ table#stats  stat | one column per metric                                                  │
│              min · p25 · median · p75 · max · mean · n · target · %ile · prem/disc vs med  │
│              cells above the peer median tone 'up', below tone 'down' (sign only, no scale)│
│ footer: sources ['SEC EDGAR XBRL companyfacts (public domain)', 'Cboe delayed quotes',     │
│                  'Wikipedia S&P 500 GICS (CC BY-SA 4.0)'] asOf · knownAt                   │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```
Title `RV · <display> · <name>`; subtitle `<peerSet.label> · <peers.length> peers · <periodType>`; `initialFocus:'peers'`. Skeleton while `payload === undefined`: `kv#basis` with 3 muted rows, a grid of `params.maxPeers` muted rows × `params.metrics.length` columns, and a stats table with 10 muted rows. A peer with `dataState:'none'` renders `tone:'muted'` with every multiple `—` and the `unavailableReason` as the row tooltip — it stays on the screen so the user can see who is missing rather than seeing a silently shorter peer list. `meta.unavailable` renders as `badges#state` warn badges with `detail` as the badge title; a metric whose `stats[i].reason === 'INSUFFICIENT_PEERS'` shows `—` in every statistics row of that column with the reason as tooltip. `meta.entitlement` denials blank the affected cells with the `ReasonCode` (ENTL-05); `meta.staleness:'stale'` puts the stale glyph on `badges#state` (TERM-12).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `B` | always | `cycle-basis` | `SUB_INDUSTRY → INDUSTRY → INDUSTRY_GROUP → SECTOR → INDEX → SUB_INDUSTRY` via `setParams({ peerBasis })` (usage `fn.param`) |
| `P` | always | `cycle-period-type` | `TTM ⇄ FY` via `setParams({ periodType })` |
| `R` | always | `toggle-restrict` | `setParams({ restrictToIndex: !restrictToIndex })` |
| `X` | always | `set-index` | `ctx.prompt('text', { label:'Index code', initial: params.index })` → `setParams({ index })` |
| `+` / `-` | grid | `more-peers` / `fewer-peers` | `setParams({ maxPeers: clamp(maxPeers ± 4, 3, 30) })` |
| `M` | grid | `add-metric` | `ctx.prompt('field')` over `RvMetric.options` → `setParams({ metrics: [...metrics, metric] })` |
| `Delete` | grid | `remove-metric` | removes the focused grid column from `params.metrics` (never below one) |
| `A` | always | `add-peer` | `ctx.prompt('security')` → `setParams({ peerBasis:'CUSTOM', peers: [...peers, ref] })` |
| `K` | always | `set-known-at` | `ctx.prompt('date', { label:'Known at' })` → `setParams({ knownAt })` (STOR-06) |
| `Enter` | grid | `open-des` | `ctx.navigate(row.key + ' DES')` |
| `Shift+Enter` | grid | `open-des-next` | `ctx.navigateNext(row.key + ' DES')` |
| `Alt+F` | grid | `open-fa` | `ctx.navigate(row.key + ' FA IS ' + (periodType === 'TTM' ? 'TTM' : 'FY'))` |
| `E` | grid | `open-ee` | `ctx.navigate(row.key + ' EE')` |
| `G` | grid | `open-gp` | `ctx.navigate(row.key + ' GP 1Y')` |
| `Q` | always | `open-eqs` | `ctx.navigate('EQS SEC=' + (target.gicsSector ?? ''))` — the peer group as a screen |
| `Ctrl+W` | grid | `add-watchlist` | `ctx.prompt('watchlist')` then `sdk.watchlists.setItems` with the target plus every peer |

#### CSV
`filename = 'RV_' + display.replace(/ /g,'_') + '_' + periodType + '_' + asOf.replace(/[-:]/g,'') + '.csv'`.
Multi-block payload, so long format with a leading `section` column (§1.6 rule 3). `csv.columns` is a function of the payload: the static prefix `section,key,name,cik,gicsSector,gicsSubIndustry,periodEnd,filedAt,dataState` (types `string × 9`) followed by one `{ id: m.id, label: m.label, type:'number', decimals: m.decimals }` per `payload.metrics[i]`.
`rows` in this order: one `target` row; one `peer` row per `payload.peers[]` in payload order (values `cells[m.id].v` at full precision, empty for `null`); then ten `stat` rows whose `key` is `min`, `p25`, `median`, `p75`, `max`, `mean`, `n`, `target`, `percentile`, `premiumToMedianPct` and whose metric columns carry the corresponding `RvStat` field (empty when the stat is `null`, with the `INSUFFICIENT_PEERS` reason carried in the `# unavailable:` header line rather than in a cell). `name`, `cik`, `gicsSector`, `gicsSubIndustry`, `periodEnd`, `filedAt` and `dataState` are empty on `stat` rows. The `#` comment header adds `# peerSet: basis=SUB_INDUSTRY scheme=GICS code=45202030 label=Technology Hardware, Storage & Peripherals restrictedToIndex=SPX candidates=11 returned=8`.
Example rows: `target,AAPL US Equity,Apple Inc,0000320193,Information Technology,Technology Hardware Storage & Peripherals,2026-06-27,2026-07-31,full,3542100000000,31.4,52.18,8.94,23.7,0.2436,1.5312,0.0812,0.0044` · `stat,median,,,,,,,,3612480000000,28.9,11.20,7.41,19.8,0.2184,0.4310,0.1120,0.0071`.

#### Help
summary `Peer set and comparative multiples for one equity against its GICS group`; description `RV builds a peer set for the loaded equity and compares it on valuation multiples, margins, growth and returns. By default peers are the other S&P 500 members in the same GICS sub-industry; press B to widen to industry, industry group or sector, R to drop the index restriction, or type RV CUSTOM with a list of tickers to compare names of your own choosing. Multiples are computed from the latest SEC filings known at the "known at" date — press K to move it and see the comparison as it stood then, P to switch between trailing twelve months and fiscal year. The statistics block gives the peer minimum, quartiles, median, maximum and mean for each column, where the target sits in that distribution, and its premium or discount to the median. A peer whose SEC filings have not yet been ingested stays on the screen with blank multiples and is excluded from the statistics: RV never fills a gap with a peer-group average. Prices are live; the multiples are as of the run, which the header states.`; params: `peerBasis` ("SUB_INDUSTRY, INDUSTRY, INDUSTRY_GROUP, SECTOR, INDEX or CUSTOM", example `RV SECTOR`), `peers` ("explicit peer list for CUSTOM", `RV MSFT US Equity, DELL US Equity`), `index` ("index code for the INDEX basis and the membership restriction", `IDX=SPX`), `restrictToIndex` ("keep only index members as peers", `RESTRICT=0`), `maxPeers` ("3–30 peers", `N=20`), `metrics` ("metric ids to show", `COLS=PE_RATIO,EV_TO_EBITDA`), `periodType` ("TTM or FY", `PT=FY`), `rank` ("peer ordering: CUR_MKT_CAP, name or metric", `RANK=name`), `knownAt` ("point-in-time date", `KNOWN=2026-06-01`); sources `['sec.companyfacts', 'sec.submissions', 'wiki.sp500', 'sec.archives', 'ssga.holdings', 'cboe.quotes', 'yahoo.chart', 'internal.derived']`; related `['FA', 'EE', 'EQS', 'MEMB', 'DES', 'CF']`.

#### Unavailable and reason codes
`{ field:'peerSet', reason:'NO_SOURCE', detail:'NO_GICS_CLASSIFICATION: no GICS row for this issuer (GICS is seeded for S&P 500 members only); peers taken from SIC <code>' }` with note `PEER_BASIS_FALLBACK_SIC` · `{ field:'peerSet', reason:'NO_SOURCE', detail:'NO_PEER_BASIS: issuer has neither a GICS nor a SIC classification; pass peers explicitly (RV CUSTOM …)' }` → `peers: []` and the grid's `emptyText` repeats it · `{ field:'peers', reason:'NO_SOURCE', detail:'FUNDAMENTALS_NOT_INGESTED: SEC companyfacts are not ingested for <n> of <m> peers; their multiple cells are blank and they are excluded from the statistics' }` (offline this is the normal case: `seed/fundamentals.ts` ingests companyfacts for AAPL only, so an `AAPL US Equity RV` run shows the peer rows with identifiers, GICS and live prices and blank multiples) · `{ field:'target', reason:'NO_SOURCE', detail:'issuer has no SEC CIK (not an SEC filer); multiples cannot be computed' }` · `{ field:<metric>, reason:'NO_SOURCE', detail:'INSUFFICIENT_PEERS: <n> peers have a value for <metric>; at least 3 are needed for a median' }` · `{ field:'peers', reason:'NO_SOURCE', detail:'<ref> did not resolve to an instrument' }` (CUSTOM) · `{ field:'EV_TO_EBITDA', reason:'NOT_APPLICABLE', detail:'EBITDA is not positive for <key>' }` when `oper_inc + dda ≤ 0`. Screen badges: `PEER_BASIS_FALLBACK_SIC`, `PEERS_TRUNCATED <candidates>→<returned>`, `FUNDAMENTALS_NOT_INGESTED <n>/<m>`, `INSUFFICIENT_PEERS`, `MULTIPLES AS OF <asOf>`. Entitlement: `NO_FIRM_ENTITLEMENT`/`NO_USER_ENTITLEMENT` on `sec.companyfacts` blanks every fundamental and multiple column with the `ReasonCode` in `cell.r` and leaves prices; a denial on `cboe.quotes` blanks `PX_LAST`, `CHG_PCT_1D` and therefore `CUR_MKT_CAP` and every price multiple (ENTL-05). `PROVIDER_DOWN` on `cboe.quotes` → price cells `st:'stale'`, `meta.staleness:'stale'` (TERM-12).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 (shared); `RvParams.parse({})` succeeds, `variants.equity === 'equity'`, `fieldIds('equity')` ⊆ `core/fields/dictionary.ts` |
| golden payload | `packages/server/test/integration/functions/RV.golden.test.ts` | `AAPL US Equity` (instrument 42) at the frozen clock `2026-09-15T18:41:28Z` with the default params deep-equals `fixtures/golden/functions/RV.equity.json`: `peerSet.scheme === 'GICS'`, `peerSet.code === '45202030'` from `wiki-sp500.html`, the target's multiples from `sec-companyfacts-AAPL.json`, every peer `dataState:'none'` with `unavailableReason:'FUNDAMENTALS_NOT_INGESTED'`, every `stats[i].reason === 'INSUFFICIENT_PEERS'` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `fixtures/golden/functions/RV.equity.csv`; the `target` row's numeric cells equal `payload.target.cells[m].v`; ten `stat` rows present with empty metric cells when the stat is null |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at a frozen clock (API-05) |
| screen | `packages/web/test/screens/RV.test.tsx` | renders the golden; the target row is first and `tone:'highlight'`; `B`/`P`/`R`/`M`/`A`/`K`/`+`/`-` reachable by keyboard and each calls the documented `ctx` method; `q:` live cells registered for `PX_LAST`/`CHG_PCT_1D` only; a `dataState:'none'` peer renders muted with `—` and a tooltip; `payload undefined` renders the skeleton |
| peer selection | `packages/server/test/unit/functions/RV.peers.test.ts` | GICS levels 4→1 widen the candidate set monotonically; `restrictToIndex:false` adds non-members; an issuer with no GICS row falls back to SIC with note `PEER_BASIS_FALLBACK_SIC`; an issuer with neither returns `peers: []` and `NO_PEER_BASIS`; `maxPeers` truncation sets `PEERS_TRUNCATED` and keeps the largest by `CUR_MKT_CAP` |
| statistics | `packages/server/test/unit/functions/RV.stats.test.ts` | quartiles by linear interpolation on a synthetic 8-peer set (`p25`, `median`, `p75` against hand-computed values); `targetPercentile` on ties; `premiumToMedianPct` null when the median is 0; `n < 3` → every stat null with `INSUFFICIENT_PEERS`; a peer with a null cell is excluded from `n` and from every statistic |
| PIT peers | `packages/server/test/integration/functions/RV.pit.test.ts` | with a restated AAPL CY2026Q1 revenue filed 2026-07-31, `KNOWN=2026-06-01` gives the pre-restatement `PX_TO_SALES_RATIO` and `knownAt=now` the restated one (STOR-06); a peer whose only `fin_statements` row was filed after `knownAt` is `dataState:'none'` |
| degraded multiples | `packages/server/test/integration/functions/RV.unavailable.test.ts` | a peer with `equity ≤ 0` → `PX_TO_BOOK_RATIO` `{v:null, st:'na'}` and no entry in `stats.n`; `oper_inc + dda ≤ 0` → `EV_TO_EBITDA` `NOT_APPLICABLE`; an issuer without a CIK → target `unavailableReason:'NO_CIK'` and the peer set still built |
| e2e | `packages/e2e/tests/eqs-screen.spec.ts` | continues the EQS flow: `V` on a screened row opens `RV` for that name, `B` widens the basis and the peer count grows, `Ctrl+P` downloads a CSV whose `target` row matches the highlighted grid row |
