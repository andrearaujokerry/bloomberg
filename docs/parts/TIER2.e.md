### HDS — Holders

| Attribute | Value |
| --- | --- |
| Code / aliases | `HDS` / `HOLD`, `HOLDERS` (no `aliasParams`) |
| Tier / category | 2 / fundamentals |
| Asset classes → variants | `equity → equity` (funds that hold the name, plus the insider-filing record); `etf → fund` (the fund's own holdings, full paged file) |
| requiresSecurity / pageable / screenKind | `true` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/HDS.ts` · `packages/server/src/functions/HDS/resolve.ts` · `packages/web/src/screens/HDS/Screen.tsx` · `fixtures/golden/functions/HDS.equity.{json,csv}`, `fixtures/golden/functions/HDS.fund.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (REF-07) (REF-03) (DATA-06) (DATA-10) (TERM-06) (TERM-08) (TERM-12) (ENTL-05) (API-05) (STOR-06) |

#### Params
```ts
export const HdsParams = z.object({
  view: z.enum(['HOLDERS', 'INSIDERS']).default('HOLDERS'),        // equity variant tabs; ignored by the fund variant
  asOfDate: z.iso.date().optional(),                               // holdings file date; undefined = latest as_of_date ≤ ctx.asOf.validAt
  source: z.enum(['any', 'sec.archives', 'ssga.holdings']).default('any'),
  minWeight: z.number().min(0).max(1).default(0),                  // fraction, matches etf_holdings.weight units
  sort: z.enum(['weight', 'shares', 'marketValue', 'name']).default('weight'),
  limit: z.number().int().min(10).max(500).default(100),           // rows per page (ctx.page)
});
```
#### Argument grammar
`positional [{ name:'view', type:'enum', values:['HOLDERS','INSIDERS'], optional:true }]`, `keyed { DT: { name:'asOfDate', type:'date' }, SRC: { name:'source', type:'enum', values:['any','sec.archives','ssga.holdings'] }, MIN: { name:'minWeight', type:'number' }, SORT: { name:'sort', type:'enum', values:['weight','shares','marketValue','name'] }, N: { name:'limit', type:'int' } }`, no `rest`.
Examples: `AAPL US Equity HDS` → `{ view:'HOLDERS', source:'any', minWeight:0, sort:'weight', limit:100 }` · `AAPL US Equity HDS INSIDERS` → `{ view:'INSIDERS' }` · `SPY US Equity HDS SRC=SEC.ARCHIVES N=250 MIN=0.001` → `{ source:'sec.archives', limit:250, minWeight:0.001 }`.

#### Payload
```ts
export type HdsPayload =
  | { variant: 'equity';
      security: { instrumentId: number; key: string /* 'AAPL US Equity' */; name: string; issuerId: number; cik: string | null };
      view: 'HOLDERS' | 'INSIDERS';
      shareBase: { sharesOut: ValueCell; floatPct: ValueCell; marketCap: ValueCell; px: ValueCell };   // EQY_SH_OUT, EQY_FLOAT_PCT, CUR_MKT_CAP, PX_LAST
      summary: { holderCount: number; sharesHeld: number | null; marketValueHeld: number | null;
                 pctSharesOutHeld: number | null;                                   // sharesHeld / sharesOut.v; null when sharesOut is blank
                 asOfDate: string | null; sources: Array<'sec.archives' | 'ssga.holdings'>; provIdx: number };
      holders: Array<{ holderName: string; holderKind: 'etf' | '13f';               // '13f' never produced in v1 (13F_NOT_AVAILABLE)
                       holderInstrumentId: number | null; holderKey: string | null; // 'SPY US Equity' when the fund is in the universe
                       shares: number | null; marketValue: number | null;
                       weightInHolder: number | null;                               // fraction of the holder's portfolio (etf_holdings.weight)
                       pctSharesOut: number | null;                                 // shares / sharesOut.v, fraction
                       asOfDate: string; sourceId: 'sec.archives' | 'ssga.holdings'; provIdx: number }>;
      insiders: { filings: Array<{ accessionNo: string; form: '3' | '4' | '5' | '4/A'; filedDate: string; acceptedAt: string | null;
                                   reportDate: string | null; primaryDocDesc: string | null; url: string; provIdx: number }>;
                  shares: null; transactions: null;                                 // always null: INSIDER_HOLDINGS_NOT_PARSED
                  reason: 'INSIDER_HOLDINGS_NOT_PARSED' };
      institutional: { holders: null; reason: '13F_NOT_AVAILABLE' };                // no 13F source in the wedge (BRIEF §2)
      notes: string[] }                                                             // '13F_NOT_AVAILABLE', 'HOLDERS_LIMITED_TO_SEEDED_FUNDS', 'INSIDER_HOLDINGS_NOT_PARSED'
  | { variant: 'fund';
      fund: { instrumentId: number; key: string /* 'SPY US Equity' */; name: string; fundType: string; sponsor: string | null; cik: string | null;
              expenseRatio: number | null; trackedIndex: { instrumentId: number; key: string } | null };
      nav: { px: ValueCell; chgPct: ValueCell };
      file: { asOfDate: string; sourceId: 'sec.archives' | 'ssga.holdings'; count: number; netAssets: number | null; provIdx: number };
      holdings: Array<{ lineNo: number; holdingInstrumentId: number | null; key: string | null; name: string;
                        cusip: string | null; isin: string | null; ticker: string | null;
                        shares: number | null; marketValue: number | null; weight: number | null;   // fraction
                        assetCat: string | null /* 'EC','DBT','STIV' */; issuerCat: string | null; country: string | null;
                        px: ValueCell; chgPct: ValueCell }>;                          // blank/pending when the row is unresolved
      byAssetCat: Array<{ assetCat: string; weight: number; count: number }>;
      unresolved: { count: number; reason: 'UNRESOLVED_IDENTIFIER' | null };
      notes: string[] };                                                              // 'PROXY_FILE_LAGS_SESSION', 'UNRESOLVED_CONSTITUENTS'
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `etf_holdings` (both directions: by `etf_instrument_id` for `fund`, by `holding_instrument_id` for `equity`), `instruments` (as-of), `issues`, `issuers` (as-of, for `cik`), `fund_terms` (as-of), `index_terms`, `filings` (forms `3`,`4`,`5`,`4/A`), `identifiers` (CUSIP/ISIN resolution already applied by ingest), `quote_snapshots`, `data_exceptions` (`kind='unresolved_identifier'`, counted only), `provenance`, `licence_registry` |
| Data services (§1.4.2) | `data.reference.instrument`, `data.holdings.holders`, `data.holdings.etfHoldings`, `data.snapshot.fields`, `data.filings.list`, `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | `('sec.nport', cik, { maxAgeMs: 86_400_000 })` when `etf_holdings` has no row for the fund (`fund` variant, or for a seeded holder fund on the `equity` variant); `('sec.submissions', cik, { maxAgeMs: 21_600_000 })` for the insider filing list; `('sec.companyfacts', cik, { maxAgeMs: 86_400_000 })` when `EQY_SH_OUT` is blank. Never for `13f` — no such `ReadThroughKind` exists (BRIEF §2). |
| Engines (`core/analytics`) | None. (`pctSharesOut`, `pctSharesOutHeld` and `byAssetCat` are resolver arithmetic; `meta.engines` empty) |
| Subjects (live) | `equity`: `q:<security.instrumentId>` · `fund`: `q:<fund.instrumentId>` plus `q:<holdingInstrumentId>` for the rows of the current page only |
| Field ids (`fieldIds(assetClass)`) | `equity: [EQY_SH_OUT, EQY_FLOAT_PCT, CUR_MKT_CAP, PX_LAST, IDX_MEMBER_SHARES, IDX_MEMBER_WEIGHT]` · `etf: [PX_LAST, CHG_PCT_1D, NAME, IDX_MEMBER_WEIGHT, IDX_MEMBER_SHARES]` |

#### Resolver
`equity` (default `resolve`, also `variants.equity`):
1. `inst = await ctx.data.reference.instrument(ctx.instrument.instrumentId)`; `security = { instrumentId, key: inst.display, name: inst.name, issuerId: inst.issuer.issuerId, cik: inst.issuer.cik }`.
2. `f = await ctx.data.snapshot.fields([instrumentId], ['EQY_SH_OUT', 'EQY_FLOAT_PCT', 'CUR_MKT_CAP', 'PX_LAST'])` → `shareBase`; `PX_LAST`/`CUR_MKT_CAP` come back with `live: { subject:'q:<id>', field }` (cell rule 1, FUNCTIONS_TIER1 §0.4). `EQY_SH_OUT` blank and a CIK present → `ensure('sec.companyfacts', cik, 24 h)` once, re-read; still blank → `pctSharesOut`/`pctSharesOutHeld` stay `null` with `ctx.unavailable.add({ field:'EQY_SH_OUT', reason:'NO_SOURCE', detail:'no dei:EntityCommonStockSharesOutstanding fact for this issuer; percent-of-shares-outstanding cannot be computed' })`.
3. `view === 'HOLDERS'`: `h = await ctx.data.holdings.holders(instrumentId, params.asOfDate)` — one query over `etf_holdings` where `holding_instrument_id = $1`, `as_of_date` = the greatest date ≤ `ctx.asOf.validAt` per `(etf_instrument_id, source_id)`, filtered by `params.source` when not `'any'` and by `weight ≥ params.minWeight`. Sort by `params.sort` (`weight`/`shares`/`marketValue` desc, `name` asc), then `holderName` asc as tiebreak; slice `params.limit` per `ctx.page` (below). `pctSharesOut = shares / shareBase.sharesOut.v` when both non-null. One `ctx.prov.add({ sourceId: row.sourceId, provenanceId, capturedAt, sourceTs, st:'closed', tier:'eod' })` per distinct holdings-file provenance; rows carry that `provIdx` (payload rule 2: bare numbers inside a block citing a `provIdx`).
4. `summary` aggregates the **unpaged** result set: `holderCount`, `sharesHeld = Σ shares`, `marketValueHeld = Σ marketValue`, `pctSharesOutHeld = sharesHeld / sharesOut.v`, `asOfDate = max(row.asOfDate)`, `sources` = distinct `sourceId`s. Zero rows → `holders: []`, `summary.holderCount = 0`, `ctx.unavailable.add({ field:'holders', reason:'NO_SOURCE', detail:'HOLDERS_LIMITED_TO_SEEDED_FUNDS: no seeded fund files (SEC N-PORT / SSGA) list this instrument; only funds whose holdings are ingested can appear' })` and `notes: ['HOLDERS_LIMITED_TO_SEEDED_FUNDS']`.
5. `institutional = { holders: null, reason: '13F_NOT_AVAILABLE' }` on every run, with `ctx.unavailable.add({ field:'institutional', reason:'NO_SOURCE', detail:'13F_NOT_AVAILABLE: no 13F-HR source in the wedge — SEC full-text search is blocked and no 13F fixture is recorded (BRIEF §2, API.md §14.3). Fund ownership below is from N-PORT/SSGA holdings files only.' })`. Never a fabricated institutional line (payload rule 6).
6. `view === 'INSIDERS'`: `ensure('sec.submissions', cik, 6 h)` then `ctx.data.filings.list(cik, { forms:['3','4','5','4/A'], limit: params.limit, cursor: ctx.page?.cursor })` → `insiders.filings` (one `prov.add` for the submissions capture, cited by every row). `insiders.shares = null`, `insiders.transactions = null`, `reason:'INSIDER_HOLDINGS_NOT_PARSED'`, plus `ctx.unavailable.add({ field:'insiders', reason:'NO_SOURCE', detail:'INSIDER_HOLDINGS_NOT_PARSED: Form 3/4/5 ownership documents are not parsed in v1; the filing record and its link are shown instead of share counts' })`. No CIK → `insiders.filings: []` and `{ field:'insiders', reason:'NO_SOURCE', detail:'issuer has no SEC CIK (not an SEC filer)' }`.
7. `ctx.page`: cursor is `base64url(JSON.stringify(k))` where `k` is the last emitted sort key — `{ w: weightInHolder, n: holderName }` for `HOLDERS`, `{ d: filedDate, a: accessionNo }` for `INSIDERS`. PAGE FWD = the next `limit` rows in the current sort order (smaller weight / older filing); PAGE BACK reverses the comparison and re-sorts. `ctx.page.set({ index, count, cursor })` with `count` = the unpaged row count (already known from step 4).
Budget: 3 DB round-trips (instrument, snapshot fields, holders or filings), zero provider calls when warm; < 200 ms p95.

`fund` (`variants.etf`):
1. `inst = data.reference.instrument(id)` (terms kind `fund`); `fund.trackedIndex` from `fund_terms.tracked_index_instrument_id`.
2. `subject = plant.subjectFor(id)`; `plant.ensureHot([subject])`; `state = plant.snapshot(subject)`; `nav.px`/`nav.chgPct` = `cellFromState(ctx, state, 'PX_LAST' | 'CHG_PCT_1D', subject)`.
3. `rows = await data.holdings.etfHoldings(id, params.asOfDate)` — latest `as_of_date` across sources unless `params.source` pins one; when both exist and are equal-dated, `ssga.holdings` wins (its file is daily, N-PORT is quarterly), and the loser is not merged. Empty → `ensure('sec.nport', fund_terms.cik, 24 h)`, retry once; still empty → `file: { …, count: 0 }`, `holdings: []`, `ctx.unavailable.add({ field:'holdings', reason:'NO_SOURCE', detail:'no N-PORT filing or issuer holdings file for this fund' })`.
4. Filter `weight ≥ params.minWeight`, sort by `params.sort` then `lineNo` asc, page as in equity step 7 with cursor key `{ w: weight, l: lineNo }`. `file.netAssets` = the N-PORT `netAssets` header value when `sourceId === 'sec.archives'`, else `null`; `file.provIdx` = one `ctx.prov.add` for the file capture.
5. Live cells for the page: `subjects = rows.filter(r => r.holdingInstrumentId).map(r => plant.subjectFor(r.holdingInstrumentId))`; `plant.ensureHot(subjects)`; `states = plant.snapshotMany(subjects)`; `px`/`chgPct` = `cellFromState(...)`, which yields `pendingCell` for a never-polled subject (cell rule 1). The resolver does **not** call `providers.ensure` for row quotes (cell rule 2) — a cold row renders `…` and fills from the WS `snap`. Unresolved rows (`holdingInstrumentId === null`) get `{ v: null, st: 'na', provIdx: file.provIdx }` and no `live`.
6. `byAssetCat` groups the **unpaged** set by `asset_cat` (`Σ weight`, `count`); `unresolved = { count: rows.filter(r => !r.holdingInstrumentId).length, reason: count > 0 ? 'UNRESOLVED_IDENTIFIER' : null }`, and when `count > 0` push `notes: ['UNRESOLVED_CONSTITUENTS']` plus `ctx.unavailable.add({ field:'holdings.key', reason:'NO_SOURCE', detail:'UNRESOLVED_CONSTITUENTS: <n> line(s) could not be resolved to an instrument by CUSIP/ISIN; a data_exceptions row exists for each' })` (`<n>` interpolated).
7. `file.asOfDate < last completed session` → `notes: ['PROXY_FILE_LAGS_SESSION']` (the N-PORT report period can be ten weeks behind; weights are as of the file, not today).
Budget: 3 DB round-trips (instrument, holdings, snapshotMany is in-memory); < 250 ms p95 for a 500-line file.

#### Live
`equity`: `{ subjects: ['q:' + payload.security.instrumentId], fields: ['PX_LAST', 'CUR_MKT_CAP'], conflationMs: 1000, essential: ['q:' + payload.security.instrumentId] }` — the `kv#shareBase` cells carry `Cell.live`; the holders grid is static (file data).
`fund`: `{ subjects: ['q:' + payload.fund.instrumentId, ...payload.holdings.filter(h => h.holdingInstrumentId).map(h => 'q:' + h.holdingInstrumentId)], fields: ['PX_LAST', 'CHG_PCT_1D'], conflationMs: 1000, essential: ['q:' + payload.fund.instrumentId] }`; `grid#holdings` sets `live.subjectOf = row => row.subject` where `GridRow.subject = 'q:' + holdingInstrumentId` (null for unresolved rows, which are never registered).

#### Screen
```
equity (view = HOLDERS)
┌ HDS · AAPL US Equity · Apple Inc · Holders ────────────────────────────────────┐
│ tabs#view  [1 HOLDERS] [2 INSIDERS]                                             │
│ kv#shareBase  shares out (int, live) · float % (pct 2dp) · mkt cap (ccy, live)   │
│               · last (px, live)                                                  │
│ badges#reason [INSTITUTIONAL 13F_NOT_AVAILABLE · warn] [ETF/FUND HOLDERS ONLY]   │
│ kv#summary  holders 3 · shares held 91,240,118 (int) · value (ccy)               │
│             · % shares out 0.61 (pct 2dp) · as of 2026-06-30 (date)              │
│ grid#holders  holder (text) | kind (text) | shares (int) | market value (ccy)     │
│               | wt in holder (pct 2dp) | % sh out (pct 2dp) | as of (date)        │
│               | source (text)            sort ▼ weight   page 1/1                │
│ footer: sources ['SEC EDGAR N-PORT', 'State Street SPDR holdings file'] asOf      │
└─────────────────────────────────────────────────────────────────────────────────┘
equity (view = INSIDERS)
┌ HDS · AAPL US Equity · Apple Inc · Insider filings ────────────────────────────┐
│ tabs#view  [1 HOLDERS] [2 INSIDERS]                                             │
│ badges#reason [INSIDER_HOLDINGS_NOT_PARSED · warn]                              │
│ text#note  Form 3/4/5 documents are not parsed in v1 — filings listed, no share │
│            counts. Press Enter to open the filing on sec.gov.                    │
│ grid#insiders  filed (date) | form (text) | accepted (datetime) | report (date)  │
│                | description (text) | accession (text)                           │
│ footer: sources ['SEC EDGAR submissions'] asOf                                   │
└─────────────────────────────────────────────────────────────────────────────────┘
fund
┌ HDS · SPY US Equity · SPDR S&P 500 ETF Trust · Holdings ───────────────────────┐
│ kv#fund  sponsor · fund type · expense ratio (pct 2dp) · tracks SPX Index        │
│ kv#nav   last (px, live) · chg% (pct 2dp, live)                                  │
│ badges#file [FILE 2026-06-30 · sec.archives · 504 lines] [PROXY_FILE_LAGS_SESSION]│
│ grid#holdings  key | name | shares (int) | market value (ccy) | weight (pct 4dp)  │
│                | px (live, px) | chg% (live, pct) | cat (text) | country (text)   │
│                frozenColumns 2 · sort ▼ weight · page 1/6                         │
│ table#assetCat  assetCat | weight (pct 2dp) | count                              │
│ footer: sources ['SEC EDGAR N-PORT'] asOf notes ['504 lines, 0 unresolved']       │
└─────────────────────────────────────────────────────────────────────────────────┘
```
Title `HDS · <display> · <name>`; subtitle `equity`: `Holders · as of <summary.asOfDate>` / `Insider filings`, `fund`: `Holdings · <file.sourceId> <file.asOfDate>`. `initialFocus:'holders'` / `'insiders'` / `'holdings'`. Skeleton (`payload === undefined`): the tabs (equity) or `kv#fund` plus a grid with `params.limit` muted rows and the real column headers. `meta.unavailable` renders as `badges#reason` items with `tone:'warn'` and the `detail` string as the badge `title` — `13F_NOT_AVAILABLE` and `INSIDER_HOLDINGS_NOT_PARSED` are always present on the equity variant, never hidden. `meta.entitlement` denials blank the affected cell to `—` with the `ReasonCode` as tooltip (ENTL-05); a denial on `EQY_SH_OUT` also blanks the `% sh out` column (its input is denied) and adds a `blocked` badge. `meta.staleness:'stale'` puts the stale glyph on `badges#file` / `kv#shareBase` (TERM-12); a pending row price renders `…` until the `snap` frame arrives.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `1` / `2` | always (equity) | `tab-view` | `ctx.setParams({ view:'HOLDERS' \| 'INSIDERS' })` (usage `fn.param`) |
| `Enter` | grid (`holders`) | `open-holder` | `ctx.navigate(row.holderKey + ' HDS')` when `holderKey`, else nothing (a holder outside the universe has no screen) |
| `Enter` | grid (`holdings`) | `open-des` | `ctx.navigate(row.key + ' DES')` |
| `Enter` | grid (`insiders`) | `open-filing` | `ctx.openUrl(row.url)` |
| `Shift+Enter` | grid | `open-des-next` | `ctx.navigateNext((row.holderKey ?? row.key) + ' DES')` |
| `G` | grid | `open-gp` | `ctx.navigate((row.holderKey ?? row.key) + ' GP 1Y')` |
| `S` | always | `cycle-sort` | `weight → shares → marketValue → name → weight` via `setParams({ sort })` |
| `D` | always | `set-as-of-date` | `ctx.prompt('date', { label:'Holdings as of' })` → `setParams({ asOfDate })` |
| `X` | always | `cycle-source` | `any → sec.archives → ssga.holdings → any` via `setParams({ source })` |
| `M` | always (fund) | `open-memb` | `ctx.navigate(payload.fund.trackedIndex.key + ' MEMB')`; no tracked index → footer note `NO_TRACKED_INDEX` |
| `F` | always (equity) | `open-fa` | `ctx.navigate('FA')` |
| `C` | always (equity) | `open-cf` | `ctx.navigate('CF')` (full filing list, including the Form 4s) |
| `Ctrl+W` | grid (`holdings`) | `add-watchlist` | `ctx.prompt('watchlist')` then `sdk.watchlists.setItems` with the page's resolved rows |

`PageDown`/`PageUp` are the reserved global PAGE FWD/BACK keys (§2.6) and drive `ctx.page('fwd'\|'back')`; the manifest does not rebind them.

#### CSV
`filename = 'HDS_' + variant.toUpperCase() + '_' + display.replace(/ /g,'_') + '_' + asOf.replace(/[-:]/g,'') + '.csv'`.
`equity`, `view='HOLDERS'` — wide over the dominant block plus appended summary rows (§1.6 rule 3): columns `holderName,holderKind,holderKey,shares,marketValue,weightInHolder,pctSharesOut,asOfDate,sourceId`; one row per `holders[]`, then four appended rows whose `holderName` is `_SUMMARY_HOLDER_COUNT`, `_SUMMARY_SHARES_HELD`, `_SUMMARY_MV_HELD`, `_SUMMARY_PCT_SH_OUT` carrying the value in `shares` and the date in `asOfDate`, then one row `_INSTITUTIONAL_13F` with `holderKind='13f'` and every numeric column empty (the reason is on the header `# unavailable:` line). Example: `SPDR S&P 500 ETF Trust,etf,SPY US Equity,183546100,42233481900,0.0712,0.0123,2026-06-30,sec.archives`.
`equity`, `view='INSIDERS'` — columns `filedDate,form,acceptedAt,reportDate,accessionNo,primaryDocDesc,url,shares,reason`; `shares` is always empty and `reason` always `INSIDER_HOLDINGS_NOT_PARSED`. Example: `2026-08-04,4,2026-08-04T20:14:22Z,2026-08-01,0000320193-26-000082,,https://www.sec.gov/Archives/edgar/data/320193/000032019326000082/xslF345X05/wf-form4.xml,,INSIDER_HOLDINGS_NOT_PARSED`.
`fund` — columns `lineNo,key,name,cusip,isin,ticker,shares,marketValue,weight,assetCat,issuerCat,country,asOfDate,sourceId`; one row per `holdings[]` (payload values, unformatted fractions for `weight`), then one appended row per `byAssetCat[]` with `lineNo` empty and `key = '_ASSETCAT_' + assetCat`, `weight` = the subtotal, `shares` = the member `count`. `px`/`chgPct` are **not** exported (live cells of a different asOf than the file — API-05 value identity). Example: `1,AAPL US Equity,APPLE INC,037833100,US0378331005,AAPL,183546100,42233481900,0.0712,EC,CORP,US,2026-06-30,sec.archives`.
`csvColumns` is a function of `(params, payload)` because the equity column set depends on `view`; `FunctionManifestPublic.csvColumns` is therefore `null` (§1.6 rule 4).

#### Help
summary `Fund and insider ownership from N-PORT/SSGA filings; 13F is not available`; description `HDS shows who owns a security and what a fund owns. On an equity it lists every ingested fund whose holdings file reports the name, with shares, market value, the weight the position has inside that fund and the percentage of shares outstanding it represents. Institutional 13F ownership is not available: there is no 13F source in this build, so that block shows 13F_NOT_AVAILABLE rather than a number. Press 2 for the issuer's insider filings (Forms 3, 4 and 5); the filings and their links are listed, but the ownership documents are not parsed, so share counts show INSIDER_HOLDINGS_NOT_PARSED. On an ETF the screen shows the fund's own holdings file — every line with shares, market value and weight, live prices for the lines that resolve to instruments, and subtotals by asset category. Coverage is limited to funds whose files are ingested: an owner that files neither N-PORT nor a public holdings file cannot appear.`; params: `view` ("HOLDERS or INSIDERS", example `HDS INSIDERS`), `asOfDate` ("holdings file date", `DT=2026-03-31`), `source` ("any, sec.archives or ssga.holdings", `SRC=SSGA.HOLDINGS`), `minWeight` ("minimum weight as a fraction", `MIN=0.001`), `sort` ("weight, shares, marketValue or name", `SORT=NAME`), `limit` ("rows per page, 10–500", `N=250`); keys: `1`/`2` ("holders / insider filings"), `D` ("set the holdings date"), `X` ("cycle source"), `S` ("cycle sort"), `M` ("index members of the tracked index"); sources `['sec.archives', 'ssga.holdings', 'sec.submissions', 'sec.companyfacts']`; related `['MEMB', 'FA', 'CF', 'DES', 'PORT']`.

#### Unavailable and reason codes
- `{ field:'institutional', reason:'NO_SOURCE', detail:'13F_NOT_AVAILABLE: no 13F-HR source in the wedge — SEC full-text search is blocked and no 13F fixture is recorded (BRIEF §2, API.md §14.3). Fund ownership below is from N-PORT/SSGA holdings files only.' }` — emitted on **every** equity run; `holderKind:'13f'` is reserved in the wire shape and never produced.
- `{ field:'insiders', reason:'NO_SOURCE', detail:'INSIDER_HOLDINGS_NOT_PARSED: Form 3/4/5 ownership documents are not parsed in v1; the filing record and its link are shown instead of share counts' }` — every `view='INSIDERS'` run.
- `{ field:'holders', reason:'NO_SOURCE', detail:'HOLDERS_LIMITED_TO_SEEDED_FUNDS: …' }` — zero holder rows.
- `{ field:'EQY_SH_OUT', reason:'NO_SOURCE', detail:'no dei:EntityCommonStockSharesOutstanding fact …' }` — `pctSharesOut` columns render `—`.
- `{ field:'insiders', reason:'NO_SOURCE', detail:'issuer has no SEC CIK (not an SEC filer)' }`.
- `{ field:'holdings', reason:'NO_SOURCE', detail:'no N-PORT filing or issuer holdings file for this fund' }` (fund).
- `{ field:'holdings.key', reason:'NO_SOURCE', detail:'UNRESOLVED_CONSTITUENTS: n line(s) …' }` (fund).
- Footer/badge messages: `13F_NOT_AVAILABLE`, `INSIDER_HOLDINGS_NOT_PARSED`, `HOLDERS_LIMITED_TO_SEEDED_FUNDS`, `UNRESOLVED_CONSTITUENTS`, `PROXY_FILE_LAGS_SESSION`, `NO_TRACKED_INDEX`.
- Entitlement (ENTL-05): `NO_FIRM_ENTITLEMENT`/`NO_USER_ENTITLEMENT` on `sec.archives` or `ssga.holdings` blanks the whole holders/holdings grid with the reason badge; `NOT_ENTITLED_TIER` on `PX_LAST` downgrades the fund grid's price column to the eod value with the downgrade listed in `meta.entitlement`. `PROVIDER_DOWN` (circuit open, stored file) → `meta.staleness:'stale'`, cells keep their stored values with the stale glyph (TERM-12) — never dropped silently.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 rules (shared) |
| golden payload | `packages/server/test/integration/functions/HDS.golden.test.ts` | at the frozen clock `2026-09-15T18:41:28Z`: AAPL (id 42) equals `HDS.equity.json` — holders derived from `sec-nport-SPY-primary_doc.xml` and `ssga-spy-holdings.xlsx`; SPY equals `HDS.fund.json` with `file.count = 504` and `byAssetCat` summing to 1 ± 1e-9 |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `HDS.equity.csv` / `HDS.fund.csv`; every numeric cell equals the payload value |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at a frozen clock (API-05) |
| screen | `packages/web/test/screens/HDS.test.tsx` | both goldens render; `1`/`2` switch view via `setParams`; `S`/`D`/`X` reachable by keyboard; fund rows register `Cell.live` for `q:*` and unresolved rows register none; `payload undefined` renders the skeleton |
| 13F reason | `packages/server/test/integration/functions/HDS.no13f.test.ts` | every equity run emits the `13F_NOT_AVAILABLE` unavailable entry; `institutional.holders === null`; no row has `holderKind === '13f'`; the badge text is present in the screen spec |
| insiders degraded | `packages/server/test/integration/functions/HDS.insiders.test.ts` | `view='INSIDERS'` on AAPL (`sec-submissions-AAPL.json`) lists Form 4 filings with `shares === null` and `reason === 'INSIDER_HOLDINGS_NOT_PARSED'`; an issuer without a CIK returns `filings: []` plus the CIK reason |
| paging | `packages/server/test/integration/functions/HDS.page.test.ts` | SPY with `limit: 100`: page 1 `meta.page = { index: 0, count: 504, cursor }`; PAGE FWD returns lines 101–200 with strictly decreasing weight; PAGE BACK returns page 1 byte-identically; a tampered cursor → `400 VALIDATION_FAILED` |
| source preference | `packages/server/test/integration/functions/HDS.source.test.ts` | with both files seeded at the same `as_of_date`, `source:'any'` picks `ssga.holdings`; `SRC=sec.archives` pins N-PORT and changes `file.netAssets` from `null` to the header value |
| e2e | `packages/e2e/tests/index-members.spec.ts` | step 3 of the flow: `SPY US Equity HDS <GO>` → holdings grid; `M` → `SPX Index MEMB`; `Ctrl+P` yields a CSV whose weights equal the screen values |

---

### MEMB — Index Members

| Attribute | Value |
| --- | --- |
| Code / aliases | `MEMB` / `MEMBERS` (no `aliasParams`) |
| Tier / category | 2 / reference |
| Asset classes → variants | `index → index`; launched with no panel security and an `index` argument (`MEMB SPX`) the payload variant is `default` with the identical body (runner §1.4.3 step 7) |
| requiresSecurity / pageable / screenKind | `false` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/MEMB.ts` · `packages/server/src/functions/MEMB/resolve.ts` · `packages/web/src/screens/MEMB/Screen.tsx` · `fixtures/golden/functions/MEMB.index.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (REF-07) (REF-03) (REF-08) (DATA-10) (TERM-06) (TERM-08) (TERM-12) (ENTL-05) (API-05) (STOR-06) |

#### Params
```ts
export const MembParams = z.object({
  index: SecurityRefInput.optional(),                              // 'MEMB SPX' when the panel has no index loaded
  asOfDate: z.iso.date().optional(),                               // membership snapshot date; undefined = latest as_of_date ≤ ctx.asOf.validAt
  compareDate: z.iso.date().optional(),                            // adds/drops/weight moves between compareDate and asOfDate (REF-07)
  source: z.enum(['any', 'sec.archives', 'ssga.holdings']).default('any'),
  groupBy: z.enum(['none', 'gics_sector', 'country', 'asset_cat']).default('none'),
  sort: z.enum(['weight', 'name', 'key', 'shares']).default('weight'),
  limit: z.number().int().min(10).max(500).default(100),           // rows per page (ctx.page)
});
```
#### Argument grammar
`positional [{ name:'index', type:'index', optional:true }]`, `keyed { DT: { name:'asOfDate', type:'date' }, VS: { name:'compareDate', type:'date' }, SRC: { name:'source', type:'enum', values:['any','sec.archives','ssga.holdings'] }, BY: { name:'groupBy', type:'enum', values:['none','gics_sector','country','asset_cat'] }, SORT: { name:'sort', type:'enum', values:['weight','name','key','shares'] }, N: { name:'limit', type:'int' } }`, no `rest`.
Examples: `MEMB SPX` → `{ index: { id: <SPX instrumentId> }, source:'any', groupBy:'none', sort:'weight', limit:100 }` (§2.7) · `SPX Index MEMB BY=GICS_SECTOR` → `{ groupBy:'gics_sector' }` (enum values are matched case-insensitively, FUNCTIONS.md §2.4; MEMB's `groupBy` values are **grouping keys**, not column or field ids — unlike QM's `GROUP=`, which takes a `GridColumn.id` that must be a real dictionary field id such as `GICS_SECTOR_NAME`) with the index taken from the panel · `SPX Index MEMB DT=2026-06-30 VS=2026-03-31` → `{ asOfDate:'2026-06-30', compareDate:'2026-03-31' }`.

#### Payload
```ts
export type MembPayload = {
  variant: 'index' | 'default';                        // 'index' when launched on an index security; 'default' when launched with the `index` argument and no panel security
  index: { instrumentId: number; key: string /* 'SPX Index' */; name: string; code: string /* indices.code 'SPX' */;
           provider: string | null; methodology: string | null; calcCurrency: string | null; constituentCount: number | null };
  membership: { asOfDate: string; sourceId: 'sec.archives' | 'ssga.holdings';
                via: { kind: 'proxy_fund'; instrumentId: number; key: string /* 'SPY US Equity' */ } | { kind: 'direct' };
                count: number; weightSum: number;                               // Σ weight over the unpaged set, fraction (≈ 1)
                availableDates: string[];                                        // every captured as_of_date for this index, newest first (REF-03 history extent)
                provIdx: number };
  members: Array<{ instrumentId: number | null; key: string | null; name: string;
                   cusip: string | null; isin: string | null; ticker: string | null;
                   gicsSector: string | null; country: string | null; assetCat: string | null;
                   weight: number | null;                                        // fraction (index_members.weight)
                   shares: number | null; marketValue: number | null;
                   px: ValueCell; chgPct: ValueCell;
                   contribPct: number | null;                                    // weight × chgPct.v; null when either is null
                   subject: string | null /* 'q:42' */ }>;
  groups: Array<{ key: string /* 'Information Technology' | 'US' | 'EC' | 'ALL' */; label: string;
                  weight: number; count: number; chgPctWeighted: number | null }>;   // [] when groupBy = 'none'
  changes: { compareDate: string; compareSourceId: 'sec.archives' | 'ssga.holdings';
             adds: Array<{ instrumentId: number | null; key: string | null; name: string; weight: number | null }>;
             drops: Array<{ instrumentId: number | null; key: string | null; name: string; weight: number | null }>;
             weightMoves: Array<{ instrumentId: number | null; key: string | null; name: string; weightFrom: number; weightTo: number; deltaBp: number }>;
             provIdx: number } | null;                                            // null when params.compareDate is absent
  unresolved: { count: number; reason: 'UNRESOLVED_IDENTIFIER' | null };
  notes: string[];                                                                // 'MEMBERSHIP_VIA_PROXY_FUND', 'HISTORY_LIMITED_TO_CAPTURED_FILINGS', 'UNRESOLVED_CONSTITUENTS'
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `indices`, `index_members` (bitemporal, read with `bt_as_of(valid_from, valid_to, tx_from, tx_to, ctx.asOf.validAt, ctx.asOf.knownAt)`), `index_terms` (as-of), `instruments` (as-of), `issues`, `issuers`, `entity_classifications` + `classification_codes` (scheme `GICS`, level 1 for `gics_sector`), `etf_holdings` (the proxy-fund file behind `index_members`, for `cusip`/`isin`/`assetCat`/`country`), `fund_terms` (proxy fund `cik`), `quote_snapshots`, `provenance`, `licence_registry` |
| Data services (§1.4.2) | `data.reference.resolve` (when `params.index` is supplied), `data.reference.instrument`, `data.reference.members`, `data.holdings.etfHoldings`, `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | `('sec.nport', <proxy fund cik>, { maxAgeMs: 86_400_000 })` when `index_members` has no row for the index at any date. No read-through exists for an index whose `indices.membership_source_id IS NULL` — that case is reported, never fetched. |
| Engines (`core/analytics`) | None. (`weightSum`, `contribPct`, `chgPctWeighted` and `deltaBp` are resolver arithmetic; `meta.engines` empty) |
| Subjects (live) | `q:<member.instrumentId>` for the resolved rows of the current page, plus `q:<index.instrumentId>` |
| Field ids (`fieldIds(assetClass)`) | `index: [IDX_MEMBER_WEIGHT, IDX_MEMBER_SHARES, IDX_MEMBER_SINCE, PX_LAST, CHG_PCT_1D, NAME, GICS_SECTOR_NAME]` (same list for the `null` asset class of the `MEMB SPX` launch form) |

#### Resolver
1. Resolve the index: `inst = ctx.instrument ?? await ctx.data.reference.resolve(params.index)` — neither present → `422 NO_SECURITY_CONTEXT` is not raised (`requiresSecurity:false`), so the resolver returns `members: []` with `ctx.unavailable.add({ field:'index', reason:'NOT_APPLICABLE', detail:'MEMB needs an index: type MEMB SPX or load an index in the panel' })`. A resolved instrument whose `assetClass !== 'index'` is rejected by the runner (step 4, `422 FUNCTION_NOT_APPLICABLE`); a `params.index` that resolves to a non-index adds `{ field:'index', reason:'NOT_APPLICABLE', detail:'<key> is not an index' }`. `variant` is `'index'` when `ctx.instrument` is non-null, `'default'` otherwise.
2. `idx = indices` row by `instrument_id`; `index` block from `indices` + `index_terms` (`provider`, `methodology`, `calc_currency`, `constituent_count`). `indices.membership_source_id IS NULL` → `members: []`, `membership.count = 0`, `ctx.unavailable.add({ field:'members', reason:'NO_SOURCE', detail:'NO_MEMBERSHIP_SOURCE: this index has no reachable constituent source — no N-PORT proxy fund and no issuer holdings file are published for it (BRIEF §2); the index level and history are still available on GP and WEI' })` and return. This is the documented outcome for the WEI-only indices (`UKX`, `DAX`, `NKY`, `HSI`, …) — no list is invented.
3. `m = await ctx.data.reference.members(inst.instrumentId, params.asOfDate)` — `index_members` joined to `instruments` as-of, choosing per `index_id` the greatest `as_of_date ≤ (params.asOfDate ?? ctx.asOf.validAt)` for the requested `source_id` (`params.source !== 'any'` pins it; otherwise `ssga.holdings` wins a tie on date because its file is daily). Zero rows and a proxy fund present → `ensure('sec.nport', fund_terms.cik of indices.proxy_fund_instrument_id, 24 h)`, retry once; still zero → `{ field:'members', reason:'NO_SOURCE', detail:'no membership snapshot on or before <date>; earliest captured snapshot is <availableDates.at(-1)>' }`.
4. `membership.via` = `{ kind:'proxy_fund', instrumentId: indices.proxy_fund_instrument_id, key }` when `indices.proxy_fund_instrument_id` is set (SPX → SPY), else `{ kind:'direct' }`; the proxy case pushes `notes: ['MEMBERSHIP_VIA_PROXY_FUND']` — membership and weights are the tracking fund's holdings, not the index provider's published list. `availableDates` = `SELECT DISTINCT as_of_date FROM index_members WHERE index_id = $1 ORDER BY as_of_date DESC` (same as-of predicate), capped at 24. `membership.provIdx` = one `ctx.prov.add({ sourceId, provenanceId, capturedAt, sourceTs, st:'closed', tier:'eod' })` for the snapshot capture; member rows are bare numbers under it (payload rule 2).
5. Enrich: `gicsSector` from `entity_classifications` (scheme `GICS`, `level 1`) joined to `classification_codes.name` at `ctx.asOf`; `cusip`/`isin`/`assetCat`/`country` from the matching `etf_holdings` line of the same `(as_of_date, source_id)`. Missing GICS → `null`, rendered `—` (no `unavailable` entry: it is a per-row gap, not a missing source).
6. Sort by `params.sort` (`weight`/`shares` desc, `name`/`key` asc) with `name` asc as tiebreak; filter nothing; page with `ctx.page` — cursor `base64url(JSON.stringify({ w: weight, n: name }))` (or `{ k: key, n: name }` for the name/key sorts). PAGE FWD = the next `limit` rows down the sort order. `ctx.page.set({ index, count: membership.count, cursor })`.
7. Live cells for the page: `subjects = members.filter(r => r.instrumentId).map(plant.subjectFor)`; `plant.ensureHot([...subjects, 'q:' + index.instrumentId])`; `states = plant.snapshotMany(subjects)`; `px`/`chgPct` = `cellFromState(ctx, state, 'PX_LAST' | 'CHG_PCT_1D', subject)` (FUNCTIONS_TIER1 §0.4 rule 1 — pending cells for cold subjects, no `providers.ensure`, rule 2). `contribPct = weight * chgPct.v` when both are non-null, else `null`.
8. `groups`: `params.groupBy === 'none'` → `[]`. Otherwise group the **unpaged** set by `gicsSector` / `country` / `assetCat` (a null key groups under label `Unclassified`), with `weight = Σ weight`, `count`, and `chgPctWeighted = Σ(weight × chgPct.v) / Σ(weight where chgPct.v ≠ null)` — `null` when no row in the group has a price.
9. `changes` when `params.compareDate`: a second `data.reference.members(inst.instrumentId, params.compareDate)` read. `adds` = keys in the new set only, `drops` = keys in the old set only, `weightMoves` = keys in both with `|Δweight| ≥ 0.0001` (1 bp), `deltaBp = (weightTo − weightFrom) × 10_000`, sorted by `|deltaBp|` desc and capped at 100 rows. `compareDate` earlier than `availableDates.at(-1)` → `changes: null` plus `ctx.unavailable.add({ field:'changes', reason:'NO_SOURCE', detail:'HISTORY_LIMITED_TO_CAPTURED_FILINGS: the earliest captured membership snapshot is <date>; adds and drops before it cannot be computed' })` and `notes: ['HISTORY_LIMITED_TO_CAPTURED_FILINGS']`. A second `ctx.prov.add` for the compare snapshot supplies `changes.provIdx`.
10. `unresolved = { count: members.filter(r => !r.instrumentId).length, reason: count > 0 ? 'UNRESOLVED_IDENTIFIER' : null }`; `count > 0` → `notes: ['UNRESOLVED_CONSTITUENTS']` and `ctx.unavailable.add({ field:'members.key', reason:'NO_SOURCE', detail:'UNRESOLVED_CONSTITUENTS: n line(s) of the membership file did not resolve to an instrument by CUSIP/ISIN; each has a data_exceptions row' })`.
Budget: 3 DB round-trips without `compareDate` (index + members+classifications in one join, availableDates), 4 with it; `snapshotMany` is in-memory; < 250 ms p95 for 504 members.

#### Live
`{ subjects: ['q:' + payload.index.instrumentId, ...payload.members.filter(m => m.instrumentId).map(m => m.subject!)], fields: ['PX_LAST', 'CHG_PCT_1D'], conflationMs: 1000, essential: ['q:' + payload.index.instrumentId] }`; `grid#members` sets `live.subjectOf = row => row.subject ?? null`, so unresolved rows are never registered and never asked for. `contribPct` and `groups[].chgPctWeighted` are recomputed client-side from the live `chgPct` cells in `web/screens/MEMB/derive.ts` (they are derived from a live cell, so the payload value is the value at `servedAt`).

#### Screen
```
index (groupBy = none)
┌ MEMB · SPX Index · S&P 500 · Members ──────────────────────────────────────────┐
│ kv#index  provider S&P Dow Jones · methodology float_cap_weighted · ccy USD      │
│           · members 504 · Σ weight 100.00% (pct 2dp) · as of 2026-06-30 (date)   │
│ badges#basis [VIA SPY US Equity N-PORT · MEMBERSHIP_VIA_PROXY_FUND · info]       │
│              [SOURCE sec.archives] [0 unresolved]                                │
│ grid#members  key | name | GICS sector | weight (pct 4dp) | shares (int)          │
│               | market value (ccy) | px (live, px) | chg% (live, pct 2dp)         │
│               | contrib bp (bp 1dp) | country                                     │
│               frozenColumns 2 · sort ▼ weight · page 1/6                          │
│ footer: sources ['SEC EDGAR N-PORT'] asOf notes ['Weights are the tracking       │
│         fund's holdings as of the file date, not the index provider's list']     │
└─────────────────────────────────────────────────────────────────────────────────┘
index (groupBy = gics_sector; the grid gains groupBy and a subtotal table)
│ table#groups  sector | weight (pct 2dp) | members (int) | wtd chg% (pct 2dp)      │
│ grid#members  groupBy 'gicsSector' — rows grouped, group header shows the subtotal │
index (compareDate set; two extra grids under the members grid)
│ grid#adds   key | name | weight (pct 4dp)        tone 'highlight'                 │
│ grid#drops  key | name | weight at compareDate (pct 4dp)                          │
│ grid#moves  key | name | from (pct 4dp) | to (pct 4dp) | Δ bp (bp 1dp)            │
│ badges#compare [VS 2026-03-31 · 4 adds · 4 drops]                                 │
no membership source
┌ MEMB · NKY Index · Nikkei 225 · Members ───────────────────────────────────────┐
│ badges#reason [NO_MEMBERSHIP_SOURCE · error]                                     │
│ text#note  No constituent source is reachable for this index: it has no N-PORT   │
│            proxy fund and no published holdings file. The index level and its    │
│            history are available — press G for GP, W for WEI.                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```
Title `MEMB · <index.key> · <index.name>`; subtitle `Members · <membership.sourceId> <membership.asOfDate>` (plus ` · vs <compareDate>` when comparing). `initialFocus:'members'` (`'note'` in the no-source layout). Skeleton (`payload === undefined`) = `kv#index` with 5 muted rows and `grid#members` with `params.limit` muted rows and the real headers. `meta.unavailable` entries render as `badges#reason` (`NO_MEMBERSHIP_SOURCE` → `tone:'error'`, `HISTORY_LIMITED_TO_CAPTURED_FILINGS` and `UNRESOLVED_CONSTITUENTS` → `tone:'warn'`) with the `detail` as the badge `title`; a denied field (`meta.entitlement`) renders `—` with the `ReasonCode` tooltip and, for `PX_LAST`, also blanks `contrib bp` because its input is denied (ENTL-05). `meta.staleness:'stale'` puts the stale glyph on `badges#basis`; a cold member price renders `…` until the WS `snap` arrives (TERM-12).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid (`members`, `adds`, `drops`, `moves`) | `open-des` | `ctx.navigate(row.key + ' DES')`; unresolved row (no key) → no-op with the footer note `UNRESOLVED_IDENTIFIER` |
| `Shift+Enter` | grid | `open-des-next` | `ctx.navigateNext(row.key + ' DES')` |
| `G` | always | `open-gp` | focused member row → `ctx.navigate(row.key + ' GP 1Y')`; no row focused → `ctx.navigate(index.key + ' GP 1Y')` |
| `Q` | always | `open-qm` | `ctx.navigate(index.key + ' QM')` — the live monitor over this member list (TERM-08) |
| `H` | always | `open-hds` | `ctx.navigate(membership.via.key + ' HDS')` when `via.kind === 'proxy_fund'` (the fund file behind the membership) |
| `S` | always | `cycle-sort` | `weight → name → key → shares → weight` via `setParams({ sort })` |
| `B` | always | `cycle-group-by` | `none → gics_sector → country → asset_cat → none` via `setParams({ groupBy })` |
| `D` | always | `set-as-of-date` | `ctx.prompt('date', { label:'Membership as of' })` → `setParams({ asOfDate })` |
| `C` | always | `set-compare-date` | `ctx.prompt('date', { label:'Compare with' })` → `setParams({ compareDate })`; empty answer clears it (REF-07 adds/drops) |
| `X` | always | `cycle-source` | `any → sec.archives → ssga.holdings → any` via `setParams({ source })` |
| `Ctrl+W` | grid (`members`) | `add-watchlist` | `ctx.prompt('watchlist')` then `sdk.watchlists.setItems` with the page's resolved rows |

`PageDown`/`PageUp` are the reserved global PAGE FWD/BACK keys (§2.6) and drive `ctx.page('fwd'\|'back')`; the manifest does not rebind them.

#### CSV
`filename = 'MEMB_' + index.code + '_' + membership.asOfDate.replace(/-/g,'') + '_' + asOf.replace(/[-:]/g,'') + '.csv'`.
One dominant block wide plus `section`-prefixed appended rows (§1.6 rule 3). Columns (static, `csvColumns` non-null): `section,key,name,ticker,cusip,isin,gicsSector,country,assetCat,weight,shares,marketValue,asOfDate,sourceId`.
Rows: one `section='member'` row per `members[]` at full precision (`weight` as a fraction, never a percentage — the screen multiplies); then one `section='group'` row per `groups[]` (`key` = the group key, `weight` = the subtotal, `shares` = the member count, other columns empty); then, when `changes !== null`, one `section='add'` row per `changes.adds[]`, one `section='drop'` per `changes.drops[]` (`asOfDate` = `changes.compareDate`) and one `section='move'` per `changes.weightMoves[]` (`weight` = `weightTo`, `marketValue` = `deltaBp`); finally one `section='index'` row carrying `key = index.key`, `name = index.name`, `weight = membership.weightSum`, `shares = membership.count`, `asOfDate = membership.asOfDate`, `sourceId = membership.sourceId`. `px`/`chgPct`/`contribPct` are **not** exported: they are live values of a different `asOf` than the membership file (API-05 value identity).
Example: `member,AAPL US Equity,APPLE INC,AAPL,037833100,US0378331005,Information Technology,US,EC,0.0712,183546100,42233481900,2026-06-30,sec.archives`.

#### Help
summary `Index constituents with weights, sector subtotals and adds/drops between dates`; description `MEMB lists the members of an index with their weights, shares and market values, and marks each row with its GICS sector and country. Type MEMB SPX to load an index directly, or run MEMB with an index in the panel. Press B to subtotal by sector, country or asset category, Q to open the same list as a live quote monitor, and C to pick a comparison date: the screen then shows what was added, what was dropped and which weights moved, in basis points. Membership comes from the regulatory filings of the fund that tracks the index (SEC N-PORT) or from the issuer's published holdings file, so weights are as of the file date and the screen says which file it used. Indices with no tracking-fund filing and no published holdings file show NO_MEMBERSHIP_SOURCE instead of a constituent list; history goes back only as far as the captured filings, which the screen also states.`; params: `index` ("index to load when the panel has none", example `MEMB SPX`), `asOfDate` ("membership snapshot date", `DT=2026-06-30`), `compareDate` ("compare with this date for adds/drops", `VS=2026-03-31`), `source` ("any, sec.archives or ssga.holdings", `SRC=SSGA.HOLDINGS`), `groupBy` ("none, gics_sector, country or asset_cat", `BY=GICS_SECTOR`), `sort` ("weight, name, key or shares", `SORT=NAME`), `limit` ("rows per page, 10–500", `N=250`); keys: `B` ("cycle grouping"), `C` ("set the comparison date"), `Q` ("live monitor over the members"), `H` ("the fund file behind the membership"); sources `['sec.archives', 'ssga.holdings']`; related `['QM', 'HDS', 'DES', 'WEI', 'EQS']`.

#### Unavailable and reason codes
- `{ field:'members', reason:'NO_SOURCE', detail:'NO_MEMBERSHIP_SOURCE: this index has no reachable constituent source — no N-PORT proxy fund and no issuer holdings file are published for it (BRIEF §2); the index level and history are still available on GP and WEI' }` — every index with `indices.membership_source_id IS NULL`. The screen shows the reason, never a partial or guessed list.
- `{ field:'members', reason:'NO_SOURCE', detail:'no membership snapshot on or before <date>; earliest captured snapshot is <date>' }` — `asOfDate` before the first capture.
- `{ field:'changes', reason:'NO_SOURCE', detail:'HISTORY_LIMITED_TO_CAPTURED_FILINGS: …' }` — `compareDate` before the first capture; `changes` stays `null`.
- `{ field:'members.key', reason:'NO_SOURCE', detail:'UNRESOLVED_CONSTITUENTS: n line(s) …' }` — unresolved CUSIP/ISIN lines.
- `{ field:'index', reason:'NOT_APPLICABLE', detail:'MEMB needs an index: type MEMB SPX or load an index in the panel' }` · `{ field:'index', reason:'NOT_APPLICABLE', detail:'<key> is not an index' }`.
- Footer/badge messages: `NO_MEMBERSHIP_SOURCE`, `MEMBERSHIP_VIA_PROXY_FUND`, `HISTORY_LIMITED_TO_CAPTURED_FILINGS`, `UNRESOLVED_CONSTITUENTS`, `UNRESOLVED_IDENTIFIER` (per-row).
- Entitlement (ENTL-05): `NO_FIRM_ENTITLEMENT`/`NO_USER_ENTITLEMENT` on `sec.archives`/`ssga.holdings` blanks `weight`, `shares` and `marketValue` with the reason badge and leaves `key`/`name` (reference class) visible; `NOT_ENTITLED_TIER` on `PX_LAST` downgrades the price and change columns to the eod view with the downgrade in `meta.entitlement`; an `eod`-only user sees `st:'closed'` cells, never a stale live number. `PROVIDER_DOWN` on the plant → member prices go `stale` with their last values and `meta.staleness:'stale'`; the membership block is stored data and is unaffected (TERM-12).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 rules (shared) |
| golden payload | `packages/server/test/integration/functions/MEMB.golden.test.ts` | at the frozen clock `2026-09-15T18:41:28Z`, `SPX Index MEMB` equals `MEMB.index.json`: `membership.count === 504` and `membership.via = { kind:'proxy_fund', key:'SPY US Equity' }` from `sec-nport-SPY-primary_doc.xml`, `weightSum` within 1e-6 of 1, `notes` contains `MEMBERSHIP_VIA_PROXY_FUND`; the same run with `SRC=SSGA.HOLDINGS` reads `ssga-spy-holdings.xlsx` and changes `sourceId` and `asOfDate` only |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `MEMB.index.csv`; every numeric cell equals the payload value; no `px`/`chgPct` column exists |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at a frozen clock (API-05) |
| screen | `packages/web/test/screens/MEMB.test.tsx` | the golden renders; `B` cycles `groupBy` and the `table#groups` node appears; `S`/`D`/`C`/`X`/`Q` all reachable by keyboard and call `setParams`/`navigate`; resolved rows register `Cell.live` for `q:*` and unresolved rows register none; `payload undefined` renders the skeleton |
| no membership source | `packages/server/test/integration/functions/MEMB.nosource.test.ts` | `NKY Index MEMB` (seeded with `indices.membership_source_id IS NULL`) returns `members: []` and exactly one `meta.unavailable` entry with detail starting `NO_MEMBERSHIP_SOURCE`; no provider call is made (replay store records zero requests) |
| adds / drops | `packages/server/test/integration/functions/MEMB.changes.test.ts` | two seeded snapshots (2026-03-31 and 2026-06-30) give the expected `adds`/`drops` key sets and `weightMoves` with `deltaBp` rounded to 1 dp; `VS=2024-01-01` (before the first capture) → `changes: null` + `HISTORY_LIMITED_TO_CAPTURED_FILINGS` |
| bitemporal as-of | `packages/server/test/integration/functions/MEMB.asof.test.ts` | a corrected `index_members` version written later changes the answer at `knownAt=now` but not at the earlier `knownAt` (REF-03, STOR-06), and `availableDates` is unaffected |
| paging | `packages/server/test/integration/functions/MEMB.page.test.ts` | `limit: 100` → `meta.page = { index: 0, count: 504, cursor }`; PAGE FWD gives rows 101–200 with non-increasing weight; PAGE BACK reproduces page 1 byte-identically; a tampered cursor → `400 VALIDATION_FAILED` |
| launch form | `packages/server/test/unit/functions/MEMB.launch.test.ts` | `MEMB SPX` with an empty panel yields `variant:'default'` and the same body as `SPX Index MEMB` (`variant:'index'`); `MEMB AAPL` adds the `<key> is not an index` unavailable entry |
| e2e | `packages/e2e/tests/index-members.spec.ts` | `SPX Index MEMB <GO>` → 100 rows with live price flashes on the replayed session; `B` → sector subtotals; `Enter` on the first row → `DES` on that member, `Escape` returns; `Q` → `QM` over the same list; `Ctrl+P` yields a CSV whose weights equal the screen values |
