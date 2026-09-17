# FUNCTIONS_TIER2 — Tier 2: analyst and PM workflow functions (FA, EE, EQS, RV, CN, CACS, CF, ECO, PORT, HDS, MEMB, BTMM, FXC, WB)
Every entry below follows the template of [FUNCTIONS.md](./FUNCTIONS.md) §7 exactly and agrees by name with FUNCTIONS.md §1 (manifest, `ResolveContext`, `DataServices`, `ValueCell`, `ScreenSpec`), §6 (asset classes → variants, aliases), API.md (§3 `Meta`, §5.3 run semantics, §6.1 subjects, §7 field dictionary, §9 CSV), DATA_MODEL.md (table names, enums, seed volumes §18) and ARCHITECTURE.md (§3.1 `core/analytics` modules, §7.1 job ids, §9 `licence_registry.source_id`); dictionary ids that do not appear in the API.md §7 excerpt (`RET_1M`, `RET_3M`, `RET_1Y`, `PX_TO_SALES_RATIO`, `NET_MARGIN`, `SALES_GROWTH_YOY`, `DVD_YIELD`, `EQY_FLOAT_PCT`) are introduced by this file per FUNCTIONS.md §1.8 step 6 and must be added to `core/fields/dictionary.ts` and `providers/licences.ts` (`internal.derived`, field class `derived`) by WP-10 before the first EQS/RV golden is recorded.

### FA — Financial Analysis

| Attribute | Value |
| --- | --- |
| Code / aliases | `FA` / `FIN` |
| Tier / category | 2 / fundamentals |
| Asset classes → variants | `equity → equity; etf → fund` |
| requiresSecurity / pageable / screenKind | `true` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/FA.ts` · `packages/server/src/functions/FA/resolve.ts` · `packages/web/src/screens/FA/Screen.tsx` · `fixtures/golden/functions/FA.equity.{json,csv}`, `fixtures/golden/functions/FA.fund.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (DATA-06) (NEWS-04) (STOR-06) (REF-03) (DATA-10) (TERM-06) (TERM-12) (ENTL-05) (API-05) (ANAL-08) |

#### Params
```ts
export const FaParams = z.object({
  statement: z.enum(['IS', 'BS', 'CF', 'RATIOS', 'PER_SHARE', 'SEGMENTS']).default('IS'),
  periodType: z.enum(['Q', 'FY', 'TTM']).default('FY'),
  periods: z.number().int().min(2).max(16).default(8),
  asReported: z.boolean().default(false),          // show the XBRL concept behind every standardised cell
  scale: z.enum(['1', '1e3', '1e6', '1e9']).default('1e6'),
  knownAt: z.iso.datetime().optional(),            // PIT override (STOR-06); undefined = ctx.asOf.knownAt
});
```
#### Argument grammar
`positional [{ name:'statement', type:'enum', values:['IS','BS','CF','RATIOS','PER_SHARE','SEGMENTS'], optional:true }, { name:'periodType', type:'enum', values:['Q','FY','TTM'], optional:true }]`, `keyed { AR: { name:'asReported', type:'boolean' }, N: { name:'periods', type:'int' }, SCALE: { name:'scale', type:'enum', values:['1','1e3','1e6','1e9'] }, KNOWN: { name:'knownAt', type:'datetime' } }`, no `rest`.
Examples: `FA` → `{ statement:'IS', periodType:'FY', periods:8, asReported:false, scale:'1e6' }` · `FA BS Q N=12` → `{ statement:'BS', periodType:'Q', periods:12 }` · `FA CF AR=1 KNOWN=2026-06-01` → `{ statement:'CF', asReported:true, knownAt:'2026-06-01T00:00:00Z' }`.

#### Payload
```ts
export type FaStatement = 'IS' | 'BS' | 'CF' | 'RATIOS' | 'PER_SHARE' | 'SEGMENTS';
export type FaPayload =
  | { variant: 'equity';
      issuer: { issuerId: number; name: string; cik: string; fiscalYearEnd: string | null /* 'MMDD' */; currency: string };
      statement: FaStatement; periodType: 'Q' | 'FY' | 'TTM'; scale: number;                    // scale = Number(params.scale)
      columns: Array<{ periodEnd: string; fiscalYear: number | null; fiscalPeriod: string | null; filedAt: string; accessionNo: string; form: string;
                       restated: boolean /* a later filed_at version exists for this period_end */; derivedQ4: boolean; provIdx: number }>;
      rows: Array<{ item: string /* 'REVENUE' */; label: string; indent: 0 | 1 | 2; unit: 'ccy' | 'shares' | 'per_share' | 'ratio' | 'pct';
                    values: Array<number | null>;                                                  // one per column, UNscaled (screen divides by scale)
                    asReported: Array<{ concept: string; taxonomy: string; factId: number; value: number } | null>;   // one per column; null when params.asReported=false
                    fieldId: FieldId | null }>;                                                    // 'SALES_REV_TURN' for REVENUE …; null for ratio rows without a dictionary id
      knownAt: string; mappingVersion: string /* 'std-map/2026.09' */;
      engine: { name: 'fundamentals/std-map'; version: string };
      notes: string[] }                                                                            // 'SEGMENTS_UNAVAILABLE', 'DERIVED_Q4' …
  | { variant: 'fund';
      fund: { instrumentId: number; key: string /* 'SPY US Equity' */; name: string; fundType: string; sponsor: string | null; cik: string | null;
              expenseRatio: number | null; inceptionDate: string | null; distributionFreq: string | null;
              trackedIndex: { instrumentId: number; key: string } | null };
      nav: { px: ValueCell; chgPct: ValueCell };
      holdings: { asOfDate: string; sourceId: 'sec.archives' | 'ssga.holdings'; count: number; netAssets: number | null;
                  top10: Array<{ instrumentId: number | null; key: string | null; name: string; weight: number; marketValue: number | null }>;
                  byAssetCat: Array<{ assetCat: string /* 'EC','DBT','STIV' */; weight: number; count: number }>; provIdx: number } | null;
      filings: Array<{ accessionNo: string; form: string; filedAt: string; reportDate: string | null; url: string }>;   // last 8 NPORT-P / N-CEN / N-30D
      notes: string[] };                                                                           // 'STATEMENTS_NOT_APPLICABLE_FUND'
```
Standard rows per statement (order is the screen order; `item` is `xbrl_concept_map.standard_item` or a derived id):
`IS`: REVENUE, COGS, GROSS_PROFIT, OPEX, RND, OPER_INC, INT_EXP, PRETAX_INC, TAX, NET_INC, EPS_BASIC, EPS_DIL, SHARES_DIL ·
`BS`: CASH, TOT_ASSETS, TOT_LIAB, LT_DEBT, EQUITY ·
`CF`: CFO, CAPEX, FCF, DIV_PAID, BUYBACK, DDA ·
`RATIOS` (derived by the resolver from the same `fin_statements` row, unit `pct`/`ratio`): GROSS_MARGIN = GROSS_PROFIT/REVENUE, OPER_MARGIN = OPER_INC/REVENUE, NET_MARGIN = NET_INC/REVENUE, FCF_MARGIN = FCF/REVENUE, ROE = NET_INC/EQUITY, ROA = NET_INC/TOT_ASSETS, DEBT_TO_EQUITY = LT_DEBT/EQUITY, PAYOUT = −DIV_PAID/NET_INC ·
`PER_SHARE`: EPS_BASIC, EPS_DIL, DPS, BVPS = EQUITY/SHARES_DIL, FCFPS = FCF/SHARES_DIL, SALES_PS = REVENUE/SHARES_DIL ·
`SEGMENTS`: `rows: []`.

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `fin_statements` (PIT on `filed_at ≤ knownAt`), `xbrl_facts` (as-reported drill), `xbrl_concept_map`, `filings`, `issuers` (as-of), `issues`, `instruments`, `fund_terms`, `etf_holdings`, `index_terms` |
| Data services (§1.4.2) | `data.reference.instrument`, `data.fundamentals.statements`, `data.fundamentals.facts`, `data.filings.list`, `data.holdings.etfHoldings`, `plant.subjectFor`, `plant.snapshot`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | `('sec.companyfacts', cik, { maxAgeMs: 86_400_000 })` when `fin_statements` has no row for the issuer (first FA on a name); `('sec.submissions', cik, { maxAgeMs: 21_600_000 })` for the fund filings list; `('sec.nport', cik, { maxAgeMs: 86_400_000 })` when `etf_holdings` is empty for the fund |
| Engines (`core/analytics`) | None in core; the standardisation engine is `server/src/data/fundamentals.ts` building `fin_statements` (`engine_name='fundamentals/std-map'`, `engine_version = mapping_version`), echoed in `meta.engines` |
| Subjects (live) | `equity`: None. `fund`: `q:<instrumentId>` |
| Field ids (`fieldIds(assetClass)`) | `equity: [SALES_REV_TURN, GROSS_PROFIT, IS_OPER_INC, NET_INCOME, IS_EPS_DIL, BS_TOT_ASSET, BS_TOT_LIAB2, TOTAL_EQUITY, CF_CASH_FROM_OPER, CF_CAP_EXPEND, FREE_CASH_FLOW, DVD_SH_12M, RETURN_COM_EQY, FA_FILED_AT]` · `etf: [PX_LAST, CHG_PCT_1D, NAME, IDX_MEMBER_WEIGHT]` |

#### Resolver
`equity` (default `resolve`, also `variants.equity`):
1. `knownAt = params.knownAt ? min(new Date(params.knownAt), ctx.asOf.knownAt) : ctx.asOf.knownAt` (a user may look further back, never forward of the request's knownAt, STOR-06). `inst = await ctx.data.reference.instrument(ctx.instrument.instrumentId)`; `cik = inst.issuer.cik`; no CIK → `ctx.unavailable.add({ field:'statement', reason:'NO_SOURCE', detail:'issuer has no SEC CIK (not an SEC filer)' })` and return `columns: [], rows: []`.
2. `await ctx.providers.ensure('sec.companyfacts', cik, { maxAgeMs: 86_400_000 })` only when `data.fundamentals.statements` returns zero rows on a first probe (`periods: 1`); a `{ fresh:false }` answer with stored rows marks `meta.staleness` through `ctx.prov.add({ …, st:'stale' })`.
3. `stmts = await ctx.data.fundamentals.statements(cik, { statement: params.statement === 'RATIOS' || params.statement === 'PER_SHARE' ? 'IS' : params.statement, periodType: params.periodType, periods: params.periods, knownAt })` — the service selects, per `period_end`, the latest `fin_statements` version with `filed_at ≤ knownAt` (DISTINCT ON `period_end` ORDER BY `filed_at DESC`); `restated = true` when more than one version qualifies; `RATIOS`/`PER_SHARE` read the full row (all statements are columns of one `fin_statements` row) so no second call is needed.
4. One `ctx.prov.add` per distinct `provenance_ids[0]` of each column (the companyfacts capture that produced it; `tier:'eod'`, `st:'closed'`), stored as `columns[i].provIdx`. Rows are bare numbers because every column cites its `provIdx` (FUNCTIONS.md §1.3 rule 2).
5. `asReported`: when `params.asReported`, take `fin_statements.as_reported[item]` → `{ concept, taxonomy:'us-gaap', factId, value }` per column; otherwise `null`s. `ctx.engines.add({ name:'fundamentals/std-map', version: mappingVersion, inputsHash: sha256(canonicalJson({ cik, periodType, periodEnds, filedAts, mappingVersion })) })`.
6. `SEGMENTS` → `rows: []`, `notes: ['SEGMENTS_UNAVAILABLE']`, `ctx.unavailable.add({ field:'segments', reason:'NO_SOURCE', detail:'SEGMENTS_UNAVAILABLE: SEC companyfacts carries no dimensional (segment) facts' })`. Columns with `derived_q4 = true` add `notes: ['DERIVED_Q4']`.
7. Return `{ variant:'equity', … , knownAt: ISO(knownAt) }`.
Budget: 2 DB round-trips (instrument, statements) + 1 for as-reported facts when requested; < 300 ms p95 warm, < 20 s cold (companyfacts fetch of ≈ 3.7 MB).

`fund` (`variants.etf`):
1. `inst = data.reference.instrument(id)` (terms kind `fund`); `fund.trackedIndex` from `fund_terms.tracked_index_instrument_id`.
2. `subject = plant.subjectFor(id)`; `plant.ensureHot([subject])`; `state = plant.snapshot(subject)`; `nav.px = { v: state?.fields.PX_LAST ?? null, st: state?.state ?? 'blank', ts: state?.fieldTs.PX_LAST ?? null, provIdx: ctx.prov.addQuote(state), live: { subject, field:'PX_LAST' } }`, `nav.chgPct` likewise from `CHG_PCT_1D`.
3. `h = await data.holdings.etfHoldings(id)` (latest `as_of_date` across sources, `ssga.holdings` preferred when its date is newer); empty → `ensure('sec.nport', cik, 24 h)` then retry once; still empty → `holdings: null`, `unavailable.add({ field:'holdings', reason:'NO_SOURCE', detail:'no N-PORT or issuer holdings file for this fund' })`. `top10` = ten largest `weight`; `byAssetCat` groups by `asset_cat`; `netAssets` from the N-PORT `netAssets` header when the source is `sec.archives`, else `null`; one `prov.add` for the holdings file (`tier:'eod'`).
4. `filings = data.filings.list(cik, { forms:['NPORT-P','N-CEN','N-30D','485BPOS'], limit: 8 })` after `ensure('sec.submissions', cik, 6 h)`.
5. `notes: ['STATEMENTS_NOT_APPLICABLE_FUND']`; `unavailable.add({ field:'statement', reason:'NOT_APPLICABLE', detail:'STATEMENTS_NOT_APPLICABLE_FUND: an ETF has no income statement; see holdings' })`.
Budget: 3 DB round-trips; < 200 ms p95.

#### Live
`equity`: `null` (static PIT screen). `fund`: `{ subjects: ['q:' + payload.fund.instrumentId], fields: ['PX_LAST', 'CHG_PCT_1D'], conflationMs: 1000 }`; the header `kv#nav` cells carry `Cell.live`.

#### Screen
```
equity
┌ FA · AAPL US Equity · Apple Inc ───────────────────────────────────────────────┐
│ tabs#statement  [1 IS] [2 BS] [3 CF] [4 RATIOS] [5 PER SHARE] [6 SEGMENTS]      │
│ badges#mode  [FY · 8 periods · USD millions · knownAt 2026-09-15 · std-map/2026.09] [AR when asReported] │
│ grid#statement  label (frozen) | 2026-06-27 | 2025-09-27 R | 2024-09-28 | …      │
│   row cells fmt ccy/shares/px/pct by row.unit, value ÷ scale, negatives in ()   │
│   column header shows periodEnd, form, filedAt on hover; 'R' badge = restated   │
│   asReported=true: a second muted line under each cell shows concept name       │
│ footer: sources ['SEC EDGAR XBRL companyfacts (public domain)'] asOf=knownAt    │
└─────────────────────────────────────────────────────────────────────────────────┘
fund
┌ FA · SPY US Equity · SPDR S&P 500 ETF Trust ────────────────────────────────────┐
│ kv#fund  sponsor · fund type · expense ratio (pct 2dp) · inception · tracks SPX  │
│ kv#nav   last (live px) · chg% (live pct)                                        │
│ text#note  STATEMENTS_NOT_APPLICABLE_FUND — holdings shown instead              │
│ grid#top10  key | name | weight (pct 2dp) | market value (ccy)                   │
│ table#assetCat  assetCat | weight | count      list#filings  form · filedAt · url │
│ footer: sources ['SEC EDGAR N-PORT', 'State Street SPDR holdings file']          │
└─────────────────────────────────────────────────────────────────────────────────┘
```
Title `FA · <display> · <name>`; subtitle `<statement> · <periodType> · scale`; `initialFocus:'statement'` (grid) / `'top10'`; skeleton = tabs plus a grid with 12 muted rows × `periods` columns. `meta.unavailable` entries render as a `badges` row under the tabs (`SEGMENTS_UNAVAILABLE`, `STATEMENTS_NOT_APPLICABLE_FUND`); a denied fundamental field (`meta.entitlement`) blanks its whole row with `—` and the reason tooltip (ENTL-05); `meta.staleness:'stale'` shows the stale glyph on the mode badge (TERM-12).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `1`…`6` | always | `tab-statement` | `ctx.setParams({ statement })` in tab order (usage `fn.param`) |
| `P` | always | `cycle-period-type` | `FY → Q → TTM → FY` via `setParams({ periodType })` |
| `R` | always | `toggle-as-reported` | `setParams({ asReported: !asReported })` |
| `K` | always | `set-known-at` | `ctx.prompt('date', { label:'Known at' })` → `setParams({ knownAt })` (STOR-06) |
| `S` | always | `cycle-scale` | `1e6 → 1e9 → 1e3 → 1 → 1e6` |
| `+` / `-` | grid | `more-periods` / `fewer-periods` | `setParams({ periods: clamp(periods ± 4, 2, 16) })` |
| `Enter` | grid | `show-fact` | opens a `kv` overlay with the XBRL concept, fact id, accession, filedAt and `ctx.openUrl(filing url)` (asReported drill) |
| `Shift+Enter` | grid | `open-filing-next` | `ctx.navigateNext(display + ' CF')` |
| `E` | always | `open-ee` | `ctx.navigate('EE')` |
| `V` | always | `open-rv` | `ctx.navigate('RV')` |
| `G` | always | `open-gp` | `ctx.navigate('GP')` |
| `Enter` | grid (fund `top10`) | `open-des` | `ctx.navigate(row.key + ' DES')` |

#### CSV
`filename = 'FA_' + statement + '_' + display.replace(/ /g,'_') + '_' + asOf.replace(/[-:]/g,'') + '.csv'`. `equity`: columns depend on the payload (`csvColumns` is `null`): `item,label,unit,` + one column per `columns[i].periodEnd` (type `number`), then `filedAt` row and `accessionNo` row appended as two extra rows whose `item` is `_FILED_AT` / `_ACCESSION`; values are UNscaled full precision. Example row: `REVENUE,Revenue,ccy,364357000000,391035000000,…`. `fund`: long format `section,key,value,unit,asOf,source` with sections `fund`, `nav`, `top10` (key = holding key, value = weight), `assetCat`, `filings`. Example: `top10,AAPL US Equity,0.0712,ratio,2026-09-14,ssga.holdings`.

#### Help
summary `Standardised income statement, balance sheet, cash flow and ratios from SEC XBRL`; description `FA shows standardised financial statements built from SEC EDGAR companyfacts through the concept map (std-map). Columns are fiscal periods; every column cites the filing it came from. The screen is point-in-time: press K to set the "known at" date and see the statements as they were filed then, restated columns are marked R. Press R to see the as-reported XBRL concept behind each standardised line. Segments are unavailable because companyfacts carries no dimensional facts. On an ETF the screen shows sponsor terms, NAV and the latest holdings file instead of statements.`; params: `statement` ("IS, BS, CF, RATIOS, PER_SHARE or SEGMENTS", example `FA BS`), `periodType` ("Q, FY or TTM", `FA IS Q`), `periods` ("2–16 columns", `N=12`), `asReported` ("show XBRL concepts", `AR=1`), `scale` ("1, 1e3, 1e6, 1e9"), `knownAt` ("point-in-time date", `KNOWN=2026-06-01`); sources `['sec.companyfacts', 'sec.submissions', 'sec.archives', 'ssga.holdings']`; related `['EE', 'RV', 'CF', 'DES', 'EQS']`.

#### Unavailable and reason codes
`{ field:'segments', reason:'NO_SOURCE', detail:'SEGMENTS_UNAVAILABLE: SEC companyfacts carries no dimensional (segment) facts' }` · `{ field:'statement', reason:'NO_SOURCE', detail:'issuer has no SEC CIK (not an SEC filer)' }` · `{ field:'statement', reason:'NOT_APPLICABLE', detail:'STATEMENTS_NOT_APPLICABLE_FUND: …' }` · `{ field:'holdings', reason:'NO_SOURCE', detail:'no N-PORT or issuer holdings file for this fund' }` · footer notes `DERIVED_Q4` (Q4 = FY − Q1..Q3) and `RESTATED` (per column). Entitlement: `NO_FIRM_ENTITLEMENT`/`NO_USER_ENTITLEMENT` on `sec.companyfacts` blank the fundamental rows; `PROVIDER_DOWN` (circuit open, stored rows) → `meta.staleness:'stale'`.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/FA.golden.test.ts` | AAPL (`sec-companyfacts-AAPL.json`) IS/FY/8 equals `FA.equity.json`; SPY (`sec-nport-SPY-primary_doc.xml`, `ssga-spy-holdings.xlsx`) equals `FA.fund.json` |
| csv parity | `packages/core/test/functions/csv.test.ts` | both goldens |
| parity | `packages/server/test/parity/fn-parity.test.ts` | shared |
| screen | `packages/web/test/screens/FA.test.tsx` | six tabs by number keys, `P`/`R`/`K`/`S` call `setParams`, restated badge, skeleton, fund variant registers `q:` live cells |
| PIT restatement | `packages/server/test/integration/functions/FA.pit.test.ts` | insert a restated CY2026Q1 revenue filed 2026-07-31; `knownAt=2026-06-01` returns the 2026-05-01 value and `restated:false`; `knownAt=now` returns the new value with `restated:true` (STOR-06) |
| segments / fund notes | `packages/server/test/integration/functions/FA.unavailable.test.ts` | `SEGMENTS` → `rows:[]` + `meta.unavailable`; ETF → `variant:'fund'` + `STATEMENTS_NOT_APPLICABLE_FUND` |
| e2e | `packages/e2e/tests/fa-pit.spec.ts` | `AAPL US Equity FA <GO>`, `K` → date prompt → column set changes; PRINT yields the grid numbers |

### EE — Earnings

| Attribute | Value |
| --- | --- |
| Code / aliases | `EE` / `ERN` |
| Tier / category | 2 / fundamentals |
| Asset classes → variants | `equity → equity` |
| requiresSecurity / pageable / screenKind | `true` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/EE.ts` · `packages/server/src/functions/EE/resolve.ts` · `packages/web/src/screens/EE/Screen.tsx` · `fixtures/golden/functions/EE.equity.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (DATA-06) (STOR-06) (DATA-10) (NEWS-08) (TERM-12) (ENTL-05) (API-05) (CHRT-06) |

#### Params
```ts
export const EeParams = z.object({
  metric: z.enum(['EPS_DIL', 'EPS_BASIC', 'REVENUE', 'NET_INC']).default('EPS_DIL'),
  periods: z.number().int().min(4).max(24).default(12),      // quarterly rows shown
  knownAt: z.iso.datetime().optional(),
});
```
#### Argument grammar
`positional [{ name:'metric', type:'enum', values:['EPS_DIL','EPS_BASIC','REVENUE','NET_INC'], optional:true }]`, `keyed { N: { name:'periods', type:'int' }, KNOWN: { name:'knownAt', type:'datetime' } }`, no `rest`.
Examples: `EE` → `{ metric:'EPS_DIL', periods:12 }` · `EE REVENUE` → `{ metric:'REVENUE' }` · `EE N=20 KNOWN=2025-12-31` → `{ periods:20, knownAt:'2025-12-31T00:00:00Z' }`.

#### Payload
```ts
export type EePayload = {
  variant: 'equity';
  issuer: { issuerId: number; name: string; cik: string; fiscalYearEnd: string | null };
  metric: 'EPS_DIL' | 'EPS_BASIC' | 'REVENUE' | 'NET_INC'; unit: 'per_share' | 'ccy';
  history: Array<{ periodEnd: string; fiscalYear: number | null; fiscalPeriod: string | null;
                   actual: number | null; yoyPct: number | null; qoqPct: number | null;
                   filedAt: string; accessionNo: string; form: string; url: string;
                   reportTiming: 'pre' | 'post' | 'intraday' | 'unknown';                       // from 8-K item 2.02 acceptance time (ET)
                   reportedAt: string | null;                                                    // 8-K item 2.02 accepted_at
                   estimate: null; surprisePct: null; provIdx: number }>;                        // always null: NO_ESTIMATES_SOURCE
  ttm: { value: number | null; periodEnd: string | null };
  next: { expectedDate: string; window: [string, string]; method: 'cadence' | 'prior_year'; basis: string; confidence: number } | null;   // basis: 'median gap of last 8 10-Q/10-K filings = 91 d'
  consensus: { value: null; reason: 'NO_ESTIMATES_SOURCE' };
  sparkline: Array<{ t: number; v: number | null }>;                                            // history oldest → newest for a Sparkline custom node
  knownAt: string;
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables | `xbrl_facts` (PIT: `filed_at ≤ knownAt`), `fin_statements`, `filings` (10-Q/10-K/8-K with `items @> '{2.02}'`), `issuers` |
| Data services | `data.reference.instrument`, `data.fundamentals.statements`, `data.filings.list` |
| Read-through | `('sec.companyfacts', cik, { maxAgeMs: 86_400_000 })` when no statements exist; `('sec.submissions', cik, { maxAgeMs: 21_600_000 })` for 8-K timing |
| Engines | None. (yoy/qoq/next-date arithmetic is in the resolver; `meta.engines` empty) |
| Subjects (live) | None. |
| Field ids | `equity: [EE_NEXT_REPORT_DT, EE_EPS_ACTUAL_LAST, EE_EPS_ESTIMATE, EE_SURPRISE_PCT, IS_EPS_DIL, SALES_REV_TURN, NET_INCOME, FA_FILED_AT]` |

#### Resolver
1. `knownAt` as FA step 1; `cik` from `data.reference.instrument`; no CIK → `unavailable.add({ field:'history', reason:'NO_SOURCE', detail:'issuer has no SEC CIK' })`, return empty history.
2. `q = data.fundamentals.statements(cik, { statement:'IS', periodType:'Q', periods: params.periods, knownAt })` (after `ensure('sec.companyfacts', …)` on a first probe); map `metric` → column `eps_dil | eps_basic | revenue | net_inc`; `unit` = `per_share` for EPS metrics else `ccy`. `yoyPct = actual / actual[same fiscalPeriod, fiscalYear−1] − 1`, `qoqPct` vs the previous row; `null` when either side is null/zero. `ttm` = sum of the last four quarters (EPS: sum of quarterly diluted EPS), `null` unless four consecutive quarters exist.
3. `filings = data.filings.list(cik, { forms:['8-K','8-K/A','10-Q','10-K'], from: oldest periodEnd, limit: 200 })` after `ensure('sec.submissions', cik, 6 h)`. For each history row take the first 8-K with `items ∋ '2.02'` filed in `(periodEnd, periodEnd + 60 d]`: `reportedAt = accepted_at`, `reportTiming` by ET hour of `accepted_at`: `< 09:30 → 'pre'`, `≥ 16:00 → 'post'`, otherwise `'intraday'`; no 8-K → `'unknown'`, `reportedAt: null`. `url` = the 10-Q/10-K `filings.url` of `accessionNo`.
4. `next`: `gaps` = differences between consecutive `filedAt` of the last 8 10-Q/10-K rows; `expectedDate = lastFiledAt + median(gaps)`; `window = [expected − 7 d, expected + 7 d]`; `method:'cadence'`, `confidence = 0.6` when ≥ 4 gaps, else `method:'prior_year'` with `expectedDate = filedAt(one year earlier row) + 365 d`, `confidence = 0.4`; fewer than 2 rows → `next: null`. If `expectedDate < ctx.asOf.validAt` and no newer filing exists, the row is kept and the screen badges `OVERDUE`.
5. `estimate: null`, `surprisePct: null` on every row and `consensus: { value:null, reason:'NO_ESTIMATES_SOURCE' }`; `ctx.unavailable.add({ field:'EE_EPS_ESTIMATE', reason:'NO_SOURCE', detail:'NO_ESTIMATES_SOURCE: no consensus-estimates provider in the wedge (BRIEF §2)' })` and the same for `EE_SURPRISE_PCT` — never a fabricated number (NEWS-08).
6. `provIdx` per row = `ctx.prov.add` of the companyfacts capture (`tier:'eod'`, `st:'closed'`); `sparkline` = `history` reversed as `{ t: Date.parse(periodEnd), v: actual }`.
Budget: 3 DB round-trips; < 250 ms p95 warm.

#### Live
`null`.

#### Screen
```
┌ EE · AAPL US Equity · Apple Inc · Earnings (SEC actuals) ──────────────────────┐
│ kv#next  next expected 2026-10-30 (window 10-23..11-06 · cadence 91 d · conf 0.6)│
│          last actual (EPS_DIL) 1.57 · TTM 7.42 · consensus — NO_ESTIMATES_SOURCE  │
│ badges#reason [ESTIMATES UNAVAILABLE · NO_ESTIMATES_SOURCE]                      │
│ custom#spark  Sparkline { points: sparkline }                                    │
│ grid#history  periodEnd | FY/FP | actual | yoy% | qoq% | estimate (— tooltip)    │
│               | surprise% (—) | reported (datetime, pre/post badge) | filed | form│
│ footer: sources ['SEC EDGAR XBRL companyfacts', 'SEC EDGAR submissions'] knownAt  │
└─────────────────────────────────────────────────────────────────────────────────┘
```
Title `EE · <display> · <name>`; `initialFocus:'history'`; skeleton = kv with 4 muted rows and a grid with `periods` muted rows. `estimate`/`surprise` columns are always `—` with tooltip from `meta.unavailable` (ENTL-05 style rendering, reason visible, never blank-without-reason). Custom node: `{ kind:'custom', component:'Sparkline', props: { points: payload.sparkline, fmt: unit === 'per_share' ? 'px' : 'ccy' } }` (no `ChartSpec`; Sparkline takes points directly).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `M` | always | `cycle-metric` | `EPS_DIL → EPS_BASIC → REVENUE → NET_INC` via `setParams({ metric })` |
| `K` | always | `set-known-at` | date prompt → `setParams({ knownAt })` |
| `+` / `-` | grid | `more-periods` / `fewer-periods` | `periods ± 4` within 4..24 |
| `Enter` | grid | `open-filing` | `ctx.openUrl(row.url)` (10-Q/10-K on sec.gov) |
| `Shift+Enter` | grid | `open-fa-next` | `ctx.navigateNext(display + ' FA IS Q')` |
| `F` | always | `open-fa` | `ctx.navigate('FA IS Q')` |
| `C` | always | `open-cacs` | `ctx.navigate('CACS')` (earnings rows on the actions timeline) |
| `G` | always | `open-gp` | `ctx.navigate('GP 2Y')` with earnings event markers on (CHRT-06) |

#### CSV
`filename = 'EE_' + display.replace(/ /g,'_') + '_' + asOf.replace(/[-:]/g,'') + '.csv'`; static columns `periodEnd,fiscalYear,fiscalPeriod,metric,actual,yoyPct,qoqPct,reportedAt,reportTiming,filedAt,accessionNo,form,estimate,surprisePct,estimateReason`; one row per `history[]`, `estimate`/`surprisePct` empty, `estimateReason = 'NO_ESTIMATES_SOURCE'`; a final row `_NEXT,,,,,,,,,,,,,,` is NOT emitted — `next` goes to the header `# unavailable:` line's sibling `# note: next expected <date> (<method>)`. Example: `2026-06-27,2026,Q3,EPS_DIL,1.57,0.121,-0.05,2026-07-30T20:31:00Z,post,2026-07-31,0000320193-26-000020,10-Q,,,NO_ESTIMATES_SOURCE`.

#### Help
summary `Reported earnings history from SEC filings and the next expected report date`; description `EE lists quarterly actuals (diluted EPS by default; press M for basic EPS, revenue or net income) taken from SEC XBRL filings, with year-over-year change, the 8-K report time (pre-market or post-market) and the filing link. The next expected report date is projected from the issuer's own filing cadence. Consensus estimates, dispersion and surprise are unavailable: the wedge has no estimates provider, so those columns show NO_ESTIMATES_SOURCE rather than a number.`; params: `metric` ("EPS_DIL, EPS_BASIC, REVENUE or NET_INC", `EE REVENUE`), `periods` ("4–24 quarters", `N=20`), `knownAt` ("point-in-time date"); sources `['sec.companyfacts', 'sec.submissions']`; related `['FA', 'CACS', 'CN', 'GP', 'CF']`.

#### Unavailable and reason codes
`{ field:'EE_EPS_ESTIMATE', reason:'NO_SOURCE', detail:'NO_ESTIMATES_SOURCE: …' }` and `{ field:'EE_SURPRISE_PCT', reason:'NO_SOURCE', detail:'NO_ESTIMATES_SOURCE: …' }` on every run; `{ field:'history', reason:'NO_SOURCE', detail:'issuer has no SEC CIK' }`; footer badges `OVERDUE` (expected date passed), `TIMING_UNKNOWN` (no 8-K 2.02 found). Entitlement denials on `sec.companyfacts` blank `actual` with the reason.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/EE.golden.test.ts` | AAPL from `sec-companyfacts-AAPL.json` + `sec-submissions-AAPL.json` equals `EE.equity.json`; `meta.unavailable` has both estimate entries |
| csv parity | `packages/core/test/functions/csv.test.ts` | `EE.equity.csv` |
| parity | `packages/server/test/parity/fn-parity.test.ts` | shared |
| screen | `packages/web/test/screens/EE.test.tsx` | estimate column renders `—` with tooltip text `NO_ESTIMATES_SOURCE`; `M` cycles; Enter opens URL; skeleton |
| next-date projection | `packages/server/test/unit/functions/EE.next.test.ts` | cadence median on 8 synthetic filings; `prior_year` fallback with 3 rows; `null` with 1 row; OVERDUE when expected < validAt |
| report timing | `packages/server/test/unit/functions/EE.timing.test.ts` | `accepted_at` 2026-07-30T20:31Z (16:31 ET) → `post`; 12:05Z → `pre`; missing → `unknown` |

---

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

---

### CN — Company News

| Attribute | Value |
| --- | --- |
| Code / aliases | `CN` / `CNEWS` (no `aliasParams`) |
| Tier / category | 2 / news |
| Asset classes → variants | `equity, etf → issuer; index → members` |
| requiresSecurity / pageable / screenKind | `true` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/CN.ts` · `packages/server/src/functions/CN/resolve.ts` · `packages/web/src/screens/CN/Screen.tsx` · `fixtures/golden/functions/CN.issuer.{json,csv}`, `fixtures/golden/functions/CN.members.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (NEWS-01) (NEWS-02) (NEWS-04) (NEWS-08) (STOR-04) (DATA-10) (TERM-08) (TERM-12) (ENTL-05) (API-05) |

**Variants (FUNC-02).** `issuer` (equity, etf) shows every headline and filing linked to the *issuer* of the security on screen — so `AAPL US Equity CN` and a hypothetical second Apple line both show the same stream — ordered newest first, with the filings of that CIK folded in as pseudo-headlines. `members` (index) shows the union stream of the index's largest constituents (`params.members` of them, by `index_members.weight`), each row tagged with which members it is linked to; it is the "what moved my index today" screen and never shows unlinked market-wide headlines.

#### Params
```ts
export const CnParams = z.object({
  window: z.enum(['1D', '3D', '1W', '1M', '3M', '1Y']).default('1M'),
  kinds: z.array(z.enum(['story', 'video', 'filing', 'press_release', 'fed_release'])).default(['story', 'video', 'filing', 'press_release']),
  q: z.string().max(200).optional(),                 // websearch_to_tsquery over news_items.tsv, ANDed with the entity link
  minConfidence: z.number().min(0.9).max(1).default(0.9),   // news_entity_links.confidence floor; < 0.9 is never written (NEWS-02)
  members: z.number().int().min(5).max(50).default(25),     // index variant only: how many constituents by weight
  limit: z.number().int().min(10).max(200).default(50),
});
```
#### Argument grammar
`positional [{ name:'window', type:'enum', values:['1D','3D','1W','1M','3M','1Y'], optional:true }, { name:'q', type:'string', optional:true }]`, `keyed { K: { name:'kinds', type:'enum', values:['story','video','filing','press_release','fed_release'], repeat:true }, CONF: { name:'minConfidence', type:'number' }, M: { name:'members', type:'int' }, N: { name:'limit', type:'int' } }`, `rest { name:'q', type:'string', join:' ' }`.
Examples: `AAPL US Equity CN` → `{ window:'1M', kinds:['story','video','filing','press_release'], minConfidence:0.9, members:25, limit:50 }` · `AAPL US Equity CN 1W buyback` → `{ window:'1W', q:'buyback' }` · `SPX Index CN 1D K=FILING M=50` → `{ window:'1D', kinds:['filing'], members:50 }`.

#### Payload
```ts
import type { NewsRow } from '../shared/news';                 // FUNCTIONS_TIER1.md §0.2 — reused unchanged

/** A filing rendered as a headline (NEWS-04). Not a news_items row: `newsId` is null and `accessionNo` identifies it. */
export interface CnFilingRow {
  newsId: null; accessionNo: string;
  headline: string;                                             // '8-K — Results of Operations and Financial Condition (Item 2.02)'
  summary: string | null;                                       // filings.primary_doc_desc
  sourceId: 'sec.submissions'; feed: 'edgar'; kind: 'filing';
  author: null; category: string /* the form: '8-K' */; cik: string; items8k: string[] | null;
  publishedAt: string /* filings.accepted_at */; capturedAt: string /* filings.captured_at */;
  url: string; isCorrection: boolean /* form ends with '/A' */; machineGenerated: false;
  links: NewsRow['links'];                                      // exactly one issuer link, confidence 1.0, method 'cik'
  provIdx: number;
}
export type CnRow = NewsRow | CnFilingRow;                       // discriminated by `newsId === null`

export type CnPayload =
  | { variant: 'issuer';
      security: { instrumentId: number; key: string /* 'AAPL US Equity' */; name: string };
      issuer: { issuerId: number | null; name: string; cik: string | null };
      window: { from: string; to: string; label: '1D' | '3D' | '1W' | '1M' | '3M' | '1Y' };
      rows: CnRow[];                                             // newest first by publishedAt, tie-broken by newsId/accessionNo desc
      counts: { story: number; video: number; filing: number; press_release: number; fed_release: number };
      total: number; liveSubject: string /* 'n:inst:42' */;
      notes: string[] }                                          // 'PRECISION_FIRST_LINKING', 'BODY_NOT_STORED_LINK_OUT', 'NO_ISSUER_HEADLINES_IN_WINDOW'
  | { variant: 'members';
      index: { instrumentId: number; key: string /* 'SPX Index' */; name: string; indexId: number };
      membership: { asOfDate: string; sourceId: 'sec.archives' | 'ssga.holdings'; shown: number; total: number; provIdx: number };
      window: { from: string; to: string; label: '1D' | '3D' | '1W' | '1M' | '3M' | '1Y' };
      rows: Array<CnRow & { members: Array<{ instrumentId: number; key: string; weight: number | null }> }>;
      counts: { story: number; video: number; filing: number; press_release: number; fed_release: number };
      total: number; liveSubjects: string[] /* ['n:inst:42', …] */;
      notes: string[] };
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `news_items` (`tsv`, `published_at`), `news_entity_links` (`confidence ≥ params.minConfidence`), `topics`, `filings`, `instruments` (as-of), `issues`, `issuers` (as-of), `identifiers` (scheme `CIK`), `index_members` (as-of `ctx.asOf`), `indices`, `provenance` |
| Data services (§1.4.2) | `data.reference.instrument`, `data.reference.members`, `data.news.search`, `data.filings.list` |
| Read-through (`providers.ensure`) | `('bbg.rss', feed, { maxAgeMs: 300_000 })` for each feed in `topics` of kind `feed` when the newest `news_items.captured_at` is older than 5 min; `('sec.submissions', cik, { maxAgeMs: 21_600_000 })` before the filings fold-in |
| Engines (`core/analytics`) | None. |
| Subjects (live) | `issuer`: `n:inst:<instrumentId>` · `members`: `n:inst:<memberInstrumentId>` for each shown member (≤ 50) |
| Field ids (`fieldIds(assetClass)`) | `equity, etf, index: [NEWS_ID, HEADLINE, PUBLISHED_AT, SOURCE_ID, LINK, KIND, IS_CORRECTION]` — the `n:` family of API.md §6.1, `fieldClass:'news'` |

#### Resolver
`issuer` (default `resolve`, also `variants.equity` and `variants.etf`):
1. `inst = await ctx.data.reference.instrument(ctx.instrument.instrumentId)`; `issuerId = inst.issuer.issuerId`, `cik = inst.issuer.cik`. `window.to = ISO(ctx.asOf.validAt)`; `window.from = to − {1D:1, 3D:3, 1W:7, 1M:30, 3M:91, 1Y:365} days`.
2. `await ctx.providers.ensure('bbg.rss', feed, { maxAgeMs: 300_000 })` for every feed of BRIEF §2 (`markets, economics, politics, technology, wealth, industries`) whose newest stored `captured_at` is older than 5 min; a `{ fresh:false }` answer leaves the stored rows and marks the run stale through `ctx.prov.add({ …, st:'stale' })` (TERM-12).
3. `news = await ctx.data.news.search({ issuerId, instrumentId: issuerId === null ? inst.instrumentId : undefined, kinds: params.kinds, q: params.q, from: window.from, to: window.to, cursor: ctx.page?.cursor ?? undefined, limit: params.limit })`. The service joins `news_entity_links` with `confidence ≥ params.minConfidence` and orders `published_at DESC, news_id DESC`. Each item becomes a `NewsRow` unchanged (shared type, §0.2) with `provIdx = ctx.prov.add({ sourceId: item.sourceId, provenanceId: item.provenanceId, capturedAt, sourceTs: publishedAt, st:'closed', tier:'delayed' })`.
4. Filings fold-in (NEWS-04), only when `params.kinds` contains `'filing'` and `cik !== null`: `await ctx.providers.ensure('sec.submissions', cik, { maxAgeMs: 21_600_000 })`, then `f = await ctx.data.filings.list(cik, { from: window.from.slice(0,10), to: window.to.slice(0,10), limit: params.limit })`. Every `Filing` whose `accession_no` is not already the `provider_guid` of a fetched `news_items` row (the 8-K atom feed writes `urn:tag:sec.gov,2008:accession-number=…`) becomes a `CnFilingRow`: `headline = form + ' — ' + (itemLabels.join('; ') || primaryDocDesc || 'filing')` where `itemLabels` comes from `EIGHT_K_ITEMS` (see *Unavailable and reason codes*); `publishedAt = accepted_at`; `links = [{ entityKind:'issuer', entityId: issuerId, display: inst.issuer.name, confidence: 1.0, method:'cik' }]`; `isCorrection = form.endsWith('/A')`; one `ctx.prov.add` per submissions capture.
5. Merge `news` and the filing rows, sort `publishedAt DESC` then `(newsId ?? 0) DESC` then `accessionNo DESC`, truncate to `params.limit`. `counts` = per-`kind` tally of the merged, untruncated set; `total` = `news.total + foldedFilings`.
6. `ctx.page.set({ index: pageIndex, count: total, cursor: rows.length ? base64url(JSON.stringify({ publishedAt: last.publishedAt, newsId: last.newsId, accessionNo: (last as CnFilingRow).accessionNo ?? null })) : null })`. PAGE FWD = older headlines.
7. `notes`: always `'PRECISION_FIRST_LINKING'` and `'BODY_NOT_STORED_LINK_OUT'`; when `rows.length === 0` also `'NO_ISSUER_HEADLINES_IN_WINDOW'` plus `ctx.unavailable.add({ field:'rows', reason:'NO_SOURCE', detail:'NO_ISSUER_HEADLINES_IN_WINDOW: no headline in the Bloomberg RSS feeds was linked to this issuer at confidence ≥ 0.9 in the window (NEWS-02 is precision-first); widen the window or press F for filings only' })`. `cik === null` → `ctx.unavailable.add({ field:'filings', reason:'NO_SOURCE', detail:'issuer has no SEC CIK (not an SEC filer)' })` and no fold-in.
8. Return `{ variant:'issuer', …, liveSubject: 'n:inst:' + inst.instrumentId }`.
Budget: 2 DB round-trips (news page, filings page) + 1 for the instrument; < 200 ms p95 warm.

`members` (`variants.index`):
1. `m = await ctx.data.reference.members(ctx.instrument.instrumentId)` → `membership.asOfDate`, `membership.sourceId`, `membership.total = m.members.length`; take the `params.members` largest by `weight` → `shown`; one `ctx.prov.add` for the membership file (`tier:'eod'`, `st:'closed'`).
2. `news = await ctx.data.news.search({ instrumentIds: shownIds, kinds: params.kinds, q: params.q, from, to, cursor, limit: params.limit })` (`instrumentIds` — see *additions required*). Each row's `members` array is built from the row's own `links` filtered to `entityKind==='instrument'` and `entityId ∈ shownIds`, carrying each member's `weight`.
3. No filings fold-in (an index has no CIK of its own); `params.kinds` containing `'filing'` still matches `news_items` rows of kind `filing` that are linked to a member.
4. `notes`: `'PRECISION_FIRST_LINKING'`, `'BODY_NOT_STORED_LINK_OUT'`, `'MEMBER_SUBSET'` (only `shown` of `total` constituents are searched) and, when `membership.asOfDate` is more than 45 days before `ctx.asOf.validAt`, `'MEMBERSHIP_STALE'`. Empty result → `ctx.unavailable.add({ field:'rows', reason:'NO_SOURCE', detail:'NO_ISSUER_HEADLINES_IN_WINDOW: no headline linked to the top N constituents in the window' })`.
5. `ctx.page.set` as in the `issuer` variant; `liveSubjects = shownIds.map(id => 'n:inst:' + id)`.
Budget: 2 DB round-trips; < 300 ms p95 warm.

#### Live
`issuer`: `{ subjects: [payload.liveSubject], fields: [], conflationMs: 0 }` — `n:` subjects take `f: []` ("all fields of the subject", API.md §6.1) and are **never conflated**: one `delta` per headline in `publishedAt` order (BUS-02). `members`: `{ subjects: payload.liveSubjects, fields: [], conflationMs: 0 }`.
The screen holds no `Cell.live`: the list node carries `live: { subject }` and `packages/web/src/screens/CN/Screen.tsx` prepends an arriving headline to `list#rows` (flash for 400 ms, TERM-08) only when its `KIND` is in `params.kinds` and its `PUBLISHED_AT` is inside the window; the counter badge increments. `packages/web/src/state/subscriptions.ts` maps `n:` to `'*'` before sending `sub` (§0.4 rule 5).

#### Screen
```
issuer
┌ CN · AAPL US Equity · Apple Inc · Company News ────────────────────────────────┐
│ badges#window [1M · 2026-08-16..2026-09-15] [story 12 · filing 7] [LIVE]        │
│ badges#notes  [PRECISION-FIRST LINKING] [LINK-OUT ONLY] [STALE when applicable] │
│ list#rows (newsList shared helper, FUNCTIONS_TIER1.md §0.1)                      │
│   primary   = headline (text)                                                   │
│   secondary = sourceId · feed · linked keys ('AAPL US Equity|Apple Inc')         │
│   ts        = publishedAt (datetime, 'YYYY-MM-DD HH:MM' local exchange tz)       │
│   badges    = [kind] [CORRECTION when isCorrection] [8-K items when items8k]     │
│   url       = url (Enter opens; bodies are never stored)                         │
│ footer: sources ['Bloomberg RSS (headline and link only)', 'SEC EDGAR submissions'] asOf=validAt │
└─────────────────────────────────────────────────────────────────────────────────┘
members
┌ CN · SPX Index · S&P 500 · Member News ────────────────────────────────────────┐
│ badges#window [1D · top 25 of 503 by weight · membership 2026-06-30 sec.archives]│
│ grid#rows  time (datetime) | member (key, frozen) | wt% (pct 2dp) | kind         │
│            | headline (left, elastic) | source                                   │
│            frozenColumns 2; a headline linked to several members repeats per link │
│ footer: sources ['Bloomberg RSS (headline and link only)', 'SEC EDGAR N-PORT']    │
└─────────────────────────────────────────────────────────────────────────────────┘
```
Title `CN · <display> · <name> · Company News` (`members`: `· Member News`); subtitle `<window.label> · <counts.story + counts.filing …> items`. `initialFocus:'rows'`. Skeleton while `payload === undefined`: `badges#window` with one muted badge and 12 muted list rows (`members`: 12 muted grid rows). `meta.unavailable` renders as a `text#empty` node with `tone:'warn'` carrying the `detail` verbatim — an empty stream always states *why* it is empty, never a bare "no results". `meta.entitlement` denials on the `news` field class replace the list with a `badges#blocked` row (`tone:'blocked'`) naming the `ReasonCode` (ENTL-05). `meta.staleness === 'stale'` adds a `stale`-toned badge to `badges#notes` and the header shows the last `capturedAt` (TERM-12). `machineGenerated` is `false` on every row in v1; the screen still renders such rows in a separate, labelled block if one ever appears (NEWS-08).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid / list | `open-story` | `ctx.openUrl(row.url)` (publisher site; bodies are never stored) |
| `Shift+Enter` | grid / list | `open-des-next` | `ctx.navigateNext(row.links[0].display + ' DES')` for an instrument link, else the issuer's primary instrument |
| `W` | always | `cycle-window` | `1D → 3D → 1W → 1M → 3M → 1Y → 1D` via `ctx.setParams({ window })` (usage `fn.param`) |
| `F` | always | `toggle-filings` | `setParams({ kinds: kinds.includes('filing') ? kinds.filter(k => k !== 'filing') : [...kinds, 'filing'] })` |
| `S` | always | `only-stories` | `setParams({ kinds: ['story', 'video'] })` |
| `/` | always | `search-within` | `ctx.prompt('text', { label:'Search headlines' })` → `setParams({ q })` |
| `A` | always | `save-alert` | `ctx.prompt('text', { label:'Alert name' })` → `sdk.alerts.create({ kind:'news', query: { instrumentId, topic: null } })` (NEWS-07) |
| `C` | always | `open-cacs` | `ctx.navigate('CACS')` |
| `Delete` | always | `open-cf` | `ctx.navigate('CF')` — the full filings list |
| `M` | grid (members) | `more-members` | `setParams({ members: clamp(members + 25, 5, 50) })` |
| `Ctrl+I` is the reserved provenance key (§2.6) and shows the row's `provIdx` entry: source, `captured_at`, request URL. |

#### CSV
`filename = 'CN_' + display.replace(/ /g,'_') + '_' + window.label + '_' + asOf.replace(/[-:]/g,'') + '.csv'`.
`issuer`: the shared `newsCsvColumns` of `packages/core/src/functions/shared/news.ts` (§0.5) **unchanged**, so a CN export is byte-comparable with TOP/N/NI; rows are `payload.rows.map(newsCsvRow)` with one adaptation for `CnFilingRow` — `newsId` is empty and the accession number goes in the `sourceId` column's sibling: `newsCsvRow` is called on the row as-is and the exporter appends nothing, because `CnFilingRow.newsId` is `null` (rule 2: `null` → empty) and `url` already contains the accession path. One extra static column is appended after `newsId`: `{ id:'accessionNo', label:'Accession', type:'string' }` (empty for true headlines). Example: `2026-07-31T20:31:00Z,sec.submissions,edgar,filing,"8-K — Results of Operations and Financial Condition (Item 2.02)",https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/aapl-20260627.htm,Apple Inc,false,,0000320193-26-000020`.
`members`: the same columns prefixed by `{ id:'memberKey', label:'Member', type:'string' }` and `{ id:'memberWeight', label:'Weight', type:'number', decimals:6 }`; a headline linked to *k* members emits *k* rows (one table per document, §1.6 rule 1). Example: `AAPL US Equity,0.071200,2026-09-15T12:04:00Z,bbg.rss,markets,story,"Apple Supplier Signals Strong iPhone Demand",https://www.bloomberg.com/news/articles/…,AAPL US Equity,false,88213,`.

#### Help
summary `Headlines and filings linked to this issuer, precision-first` (62 chars); description `CN shows every headline linked to the issuer of the security on the command line, newest first, with that issuer's SEC filings folded in as headlines. Linking is precision-first: a story appears only when it was matched to the company by CIK, exact ticker or exact name at confidence 0.9 or better, so a story that merely mentions the company in its body will not appear. Headlines are from Bloomberg's public RSS feeds and carry a link only — no article body is stored or served. Press W to widen the window, F to show or hide filings, / to search within the result and A to save an alert. On an index, CN shows the union stream of the largest constituents, tagged with which member each story belongs to.`; params: `window` ("1D, 3D, 1W, 1M, 3M or 1Y", example `CN 1W`), `q` ("search within the headlines", `CN 1M buyback`), `kinds` ("story, video, filing, press_release, fed_release", `K=FILING`), `minConfidence` ("link-confidence floor, 0.9–1.0", `CONF=1`), `members` ("index only: constituents to search, 5–50", `M=50`), `limit` ("rows per page, 10–200", `N=100`); sources `['bbg.rss', 'sec.submissions', 'sec.atom', 'sec.archives', 'ssga.holdings']`; related `['N', 'TOP', 'NI', 'CF', 'CACS', 'DES']`.

#### Unavailable and reason codes
`{ field:'rows', reason:'NO_SOURCE', detail:'NO_ISSUER_HEADLINES_IN_WINDOW: no headline in the Bloomberg RSS feeds was linked to this issuer at confidence ≥ 0.9 in the window (NEWS-02 is precision-first); widen the window or press F for filings only' }` — the expected state for most single names, because the reachable feeds are market-wide, not per-issuer wires · `{ field:'filings', reason:'NO_SOURCE', detail:'issuer has no SEC CIK (not an SEC filer)' }` · `{ field:'summary', reason:'NOT_LICENSED', detail:'BODY_NOT_STORED_LINK_OUT: Bloomberg RSS is link-out only; the article body is never stored or served (DATA_MODEL §10)' }` emitted once per run · footer notes `PRECISION_FIRST_LINKING`, `MEMBER_SUBSET` (index: only `shown` of `total` constituents searched), `MEMBERSHIP_STALE` (N-PORT/SSGA membership older than 45 days). Item labels for 8-K pseudo-headlines come from `EIGHT_K_ITEMS` in `packages/core/src/functions/shared/secForms.ts`; an item code absent from that map renders as `'Item <code>'` and adds note `ITEM_LABEL_UNKNOWN`. Entitlement: `NO_FIRM_ENTITLEMENT` / `NO_USER_ENTITLEMENT` on the `news` field class replaces the list with the blocked badge; `SOURCE_TIER_CAP` never applies (news has no tier ladder). `PROVIDER_DOWN` (circuit open, stored rows) → `meta.staleness:'stale'`, rows still served.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/CN.golden.test.ts` | AAPL (id 42) from `bbg-rss-markets`, `bbg-rss-tech`, `sec-submissions-AAPL.json` at the frozen clock deep-equals `CN.issuer.json`; SPX Index from the same feeds + `sec-nport-SPY-primary_doc.xml` equals `CN.members.json`; SPY US Equity asserted inline as `variant:'issuer'` |
| resolver unit | `packages/server/test/unit/functions/CN.merge.test.ts` | seeded `news_items` + `filings`: an 8-K present in both `sec.atom` (`provider_guid` accession) and `filings` appears exactly once; merge order is `publishedAt DESC, newsId DESC`; `minConfidence=1` drops a 0.95 name-exact link |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(CN.issuer.json))` equals `CN.issuer.csv` and likewise `CN.members`; every `publishedAt` cell equals the payload value |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at the frozen clock (API-05) |
| screen | `packages/web/test/screens/CN.test.tsx` | both goldens render; `W`/`F`/`S`/`/` call `setParams`; Enter calls `openUrl`; `list#rows` registers `live: { subject:'n:inst:42' }`; an `n:` delta prepends and flashes; `payload undefined` renders the skeleton |
| empty stream | `packages/server/test/integration/functions/CN.empty.test.ts` | an issuer with no links returns `rows: []`, note `NO_ISSUER_HEADLINES_IN_WINDOW` and a `meta.unavailable` entry; the screen test asserts the warn text is visible, not a bare "no results" |
| paging | `packages/server/test/integration/functions/CN.page.test.ts` | `limit:10` over 25 seeded rows: `meta.page.cursor` round-trips through `POST /functions/CN/page { direction:'fwd' }`, returns strictly older rows, no duplicates, `count` stable |
| e2e | `packages/e2e/tests/command-line.spec.ts` (new step) | `AAPL US Equity CN <GO>` renders the stream; `W` twice changes the window badge and the row count; Enter opens the publisher URL in a new tab |

---

### CACS — Corporate Actions

| Attribute | Value |
| --- | --- |
| Code / aliases | `CACS` / `CA`, `ACTIONS` (no `aliasParams`) |
| Tier / category | 2 / reference |
| Asset classes → variants | `equity, etf → issuer; index → members` |
| requiresSecurity / pageable / screenKind | `true` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/CACS.ts` · `packages/server/src/functions/CACS/resolve.ts` · `packages/web/src/screens/CACS/Screen.tsx` · `fixtures/golden/functions/CACS.issuer.{json,csv}`, `fixtures/golden/functions/CACS.members.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (DATA-08) (REF-03) (REF-09) (REF-10) (DATA-10) (STOR-06) (TERM-12) (ENTL-05) (API-05) |

**Variants (FUNC-02).** `issuer` (equity, etf) is the timeline of every `corporate_actions` row for that instrument inside the window — cash and special dividends, splits and reverse splits, name and ticker changes, plus the earnings dates taken from 8-K item 2.02 filings — each row carrying its `status` on the estimated → announced → confirmed → paid ladder (DATA-08) and the price-adjustment factor it contributes (REF-09). `members` (index) is the forward calendar: every ex-date of the index's constituents inside the window, weighted, so a PM can see the index's dividend drag; it shows no earnings rows and no history before `ctx.asOf.validAt − 7 days`.

#### Params
```ts
export const CacsParams = z.object({
  from: z.iso.date().optional(),                     // default: validAt − 2 years (issuer) / validAt − 7 days (members)
  to: z.iso.date().optional(),                       // default: validAt + 90 days
  types: z.array(z.enum(['cash_dividend', 'special_dividend', 'stock_dividend', 'split', 'reverse_split', 'spinoff', 'merger',
                         'tender', 'rights', 'call', 'conversion', 'name_change', 'ticker_change', 'delisting', 'capital_return']))
          .default(['cash_dividend', 'special_dividend', 'stock_dividend', 'split', 'reverse_split', 'name_change', 'ticker_change']),
  status: z.array(z.enum(['estimated', 'announced', 'confirmed', 'paid', 'cancelled'])).default(['announced', 'confirmed', 'paid']),
  includeEarnings: z.boolean().default(true),        // issuer variant: 8-K item 2.02 dates on the same timeline
  includeProjected: z.boolean().default(true),       // resolver-derived next ex-date, always status 'estimated'
  members: z.number().int().min(5).max(100).default(50),      // index variant only
  knownAt: z.iso.datetime().optional(),              // PIT override (STOR-06, REF-03); undefined = ctx.asOf.knownAt
});
```
#### Argument grammar
`positional [{ name:'from', type:'date', optional:true }, { name:'to', type:'date', optional:true }]`, `keyed { T: { name:'types', type:'enum', values:[…the fifteen ca_type values…], repeat:true }, ST: { name:'status', type:'enum', values:['estimated','announced','confirmed','paid','cancelled'], repeat:true }, E: { name:'includeEarnings', type:'boolean' }, P: { name:'includeProjected', type:'boolean' }, M: { name:'members', type:'int' }, KNOWN: { name:'knownAt', type:'datetime' } }`, no `rest`.
Examples: `AAPL US Equity CACS` → `{ types:[7 defaults], status:['announced','confirmed','paid'], includeEarnings:true, includeProjected:true, members:50 }` · `AAPL US Equity CACS 2020-01-01 T=SPLIT T=REVERSE_SPLIT` → `{ from:'2020-01-01', types:['split','reverse_split'] }` · `SPX Index CACS M=100 E=0` → `{ members:100, includeEarnings:false }`.

#### Payload
```ts
export type CaType = 'cash_dividend' | 'special_dividend' | 'stock_dividend' | 'split' | 'reverse_split' | 'spinoff' | 'merger'
                   | 'tender' | 'rights' | 'call' | 'conversion' | 'name_change' | 'ticker_change' | 'delisting' | 'capital_return';
export type CaStatus = 'estimated' | 'announced' | 'confirmed' | 'paid' | 'cancelled';

/** One row of the timeline. Field names mirror API.md §5.1 `CorporateAction` exactly, plus the four screen-only fields. */
export interface CacsAction {
  caId: number | null;                                          // null on a projected row (never written to corporate_actions)
  instrumentId: number; key: string; caType: CaType; status: CaStatus;
  declaredDate: string | null; exDate: string; recordDate: string | null; payDate: string | null; effectiveDate: string | null;
  amount: number | null; currency: string | null; ratioNew: number | null; ratioOld: number | null;
  newInstrumentId: number | null; newKey: string | null;
  frequency: string | null; grossOrNet: 'gross' | 'net'; details: Record<string, unknown>; note: string | null;
  sourceId: string;                                             // 'yahoo.chart' | 'sec.submissions' | 'internal.user' | 'internal.derived'
  reviewState: 'auto' | 'queued' | 'reviewed' | 'rejected';     // REF-10 dual key
  adjFactor: number | null;                                     // core/adjust/corporateActions.ts price factor this row contributes
  projected: boolean; projectionBasis: string | null;           // 'median gap of last 8 cash dividends = 91 d'
  provIdx: number;
}
export type CacsPayload =
  | { variant: 'issuer';
      security: { instrumentId: number; key: string; name: string; currency: string };
      issuer: { issuerId: number | null; name: string; cik: string | null };
      window: { from: string; to: string }; knownAt: string;
      actions: CacsAction[];                                     // ex-date DESC for past, ASC for future; see resolver step 7
      earnings: Array<{ accessionNo: string; form: string; filedAt: string; acceptedAt: string; reportDate: string | null;
                        items8k: string[]; reportTiming: 'pre' | 'post' | 'intraday' | 'unknown'; url: string; provIdx: number }>;
      summary: { ttmCashDividend: number | null; ttmCount: number; frequency: string | null;
                 dvdYield: ValueCell; pxLast: ValueCell;         // DVD_YIELD = ttmCashDividend / PX_LAST × 100 (TIER1 §0.3)
                 lastSplit: { exDate: string; ratioNew: number; ratioOld: number } | null;
                 nextProjected: { exDate: string; amount: number | null; basis: string; confidence: number } | null;
                 cumulativeAdjFactor: number };                  // product of adjFactor over the window (REF-09 policy 'price')
      counts: Partial<Record<CaType, number>>;
      notes: string[] }                                          // 'ESTIMATED_CA_UNAVAILABLE', 'CA_TYPES_NO_SOURCE', 'PROJECTED_ROW', 'CA_REVIEW_PENDING'
  | { variant: 'members';
      index: { instrumentId: number; key: string; name: string; indexId: number };
      membership: { asOfDate: string; sourceId: 'sec.archives' | 'ssga.holdings'; shown: number; total: number; provIdx: number };
      window: { from: string; to: string }; knownAt: string;
      actions: Array<CacsAction & { weight: number | null; weightedAmount: number | null }>;   // weightedAmount = amount × weight
      summary: { exDateCount: number; weightedCashPerIndexUnit: number | null; coverage: number };  // coverage = members with ≥1 known action ÷ shown
      notes: string[] };
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `corporate_actions` (bitemporal, read `bt_as_of(valid_from, valid_to, tx_from, tx_to, validAt, knownAt)`), `instruments` (as-of), `issues`, `issuers` (as-of; `former_names` for name changes), `identifiers` (scheme `CIK`, `TICKER_EXCH`), `filings` (8-K with `items @> '{2.02}'`), `index_members` (as-of), `indices`, `quote_snapshots` (plant warm start), `bars_daily` (ex-date close for the adjustment factor), `provenance` |
| Data services (§1.4.2) | `data.reference.instrument`, `data.reference.corporateActions` (**addition required**, see below), `data.reference.members`, `data.filings.list`, `plant.subjectFor`, `plant.snapshot`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | `('yahoo.daily', providerSymbol, { maxAgeMs: 86_400_000 })` — the `range=max&interval=1d&events=div%7Csplit` call that populates `corporate_actions` from `yahoo-chart-events`; `('sec.submissions', cik, { maxAgeMs: 21_600_000 })` for earnings dates and `former_names` |
| Engines (`core/analytics`) | `packages/core/src/adjust/corporateActions.ts` (DATA_MODEL §6.1) for `adjFactor` and `cumulativeAdjFactor`; registered in `meta.engines` as `{ name:'adjust/corporateActions', version:'1.0.0', inputsHash }` (ANAL-08) |
| Subjects (live) | `issuer`: `q:<instrumentId>` (for `pxLast`/`dvdYield`) · `members`: None. |
| Field ids (`fieldIds(assetClass)`) | `equity, etf: [CA_TYPE, CA_STATUS, CA_DECLARED_DT, CA_EX_DT, CA_RECORD_DT, CA_PAY_DT, CA_AMOUNT, CA_RATIO, DVD_SH_12M, DVD_YIELD, PX_LAST]` · `index: [CA_TYPE, CA_STATUS, CA_EX_DT, CA_AMOUNT, CA_RATIO, IDX_MEMBER_WEIGHT]` |

#### Resolver
`issuer` (default `resolve`, also `variants.equity` and `variants.etf`):
1. `knownAt = params.knownAt ? min(new Date(params.knownAt), ctx.asOf.knownAt) : ctx.asOf.knownAt` (a user may look back, never forward of the request's `knownAt`, STOR-06). `inst = await ctx.data.reference.instrument(ctx.instrument.instrumentId)`. `window.from = params.from ?? ISO_DATE(validAt − 2 years)`, `window.to = params.to ?? ISO_DATE(validAt + 90 days)`.
2. `await ctx.providers.ensure('yahoo.daily', mdLine.providerSymbol, { maxAgeMs: 86_400_000 })` when `corporate_actions` has no row for the instrument with `valid_from` inside the last 24 h; `{ fresh:false }` with stored rows → `ctx.prov.add({ …, st:'stale' })` and `meta.staleness:'stale'` (TERM-12).
3. `rows = await ctx.data.reference.corporateActions(inst.instrumentId, { from: window.from, to: window.to, types: params.types, status: params.status, validAt: ctx.asOf.validAt, knownAt })`. The reader applies `bt_as_of(...)` and orders `ex_date`. Each row maps 1:1 onto `CacsAction` using the `corporate_actions` column names of DATA_MODEL §6 (`ca_id → caId`, `ca_type → caType`, `ratio_new/ratio_old → ratioNew/ratioOld`, `review_state → reviewState`), `key` from `instruments.ticker` + sector, `newKey` resolved from `new_instrument_id` when present, `provIdx = ctx.prov.add({ sourceId: row.sourceId, provenanceId: row.provenanceId, capturedAt, sourceTs: null, st:'closed', tier:'eod' })`.
4. `adjFactor` per row from `core/adjust/corporateActions.ts` under policy `'price'`: `split`/`reverse_split`/`stock_dividend` → `ratioOld / ratioNew`; `cash_dividend`/`special_dividend` → `1 − amount / close(ex_date − 1 session)` read from `bars_daily`, `null` when that close is missing (note `ADJ_FACTOR_NO_CLOSE`); every other `ca_type` → `null`. `cumulativeAdjFactor` is the product of the non-null factors with `ex_date ≤ validAt`. `ctx.engines.add({ name:'adjust/corporateActions', version:'1.0.0', inputsHash: sha256(canonicalJson({ instrumentId, window, policy:'price', caIds })) })`.
5. Name and ticker changes (no `yahoo.chart` event exists for them): after `ensure('sec.submissions', cik, 6 h)`, each entry of `issuers.former_names` (`[{name, from, to}]`) whose `to` falls inside the window becomes a `CacsAction` with `caType:'name_change'`, `status:'confirmed'`, `exDate = to`, `effectiveDate = to`, `details: { fromName, toName }`, `sourceId:'sec.submissions'`, `caId: null`, `projected:false`; ticker changes come from `identifiers` versions of scheme `TICKER_EXCH` whose `valid_to` is finite inside the window, `caType:'ticker_change'`, `details: { fromTicker, toTicker }`. Both are included only when `params.types` names them.
6. `earnings` (when `params.includeEarnings`): `data.filings.list(cik, { forms:['8-K','8-K/A'], from: window.from, to: window.to, limit: 100 })` filtered to `items ∋ '2.02'`; `reportTiming` from the ET hour of `accepted_at` (`< 09:30 → 'pre'`, `≥ 16:00 → 'post'`, else `'intraday'`), `'unknown'` when `accepted_at` is null — the identical rule EE uses, so EE and CACS never disagree.
7. Ordering: `actions` are returned with the future block first (ex-date ascending, `exDate > validAt`) then the past block (ex-date descending) so the screen's initial viewport is "what is coming".
8. Projection (when `params.includeProjected` and ≥ 4 `cash_dividend` rows exist): `gaps` = differences between consecutive `ex_date`; `nextProjected = { exDate: lastExDate + median(gaps), amount: lastAmount, basis: 'median gap of last ' + n + ' cash dividends = ' + median + ' d', confidence: n >= 8 ? 0.6 : 0.4 }` and, unless a real announced row already covers that date, one extra `CacsAction` with `caId: null`, `status:'estimated'`, `sourceId:'internal.derived'`, `reviewState:'auto'`, `projected: true`, `projectionBasis = basis`. It is **never** written to `corporate_actions` and is always badged on screen. Fewer than 4 rows → `nextProjected: null`, note `PROJECTION_INSUFFICIENT_HISTORY`.
9. `summary.pxLast`: `subject = plant.subjectFor(inst.instrumentId)`; `plant.ensureHot([subject])`; `state = plant.snapshot(subject)`; `pxLast = cellFromState(ctx, state, 'PX_LAST', subject)` (TIER1 §0.4 rule 1). `ttmCashDividend` = sum of `amount` over `cash_dividend`/`special_dividend` rows with `ex_date` in the trailing 365 days and status ∈ {announced, confirmed, paid} (the `DVD_SH_12M` definition of TIER1 §0.3); `dvdYield` is a derived cell (`st:'closed'`, `provIdx` of the newest contributing dividend, `live: { subject, field:'DVD_YIELD' }`) equal to `ttmCashDividend / pxLast.v × 100`, or `{ v: null, st:'na' }` when either input is null.
10. `notes` and `ctx.unavailable.add` for every requested `ca_type` with no reachable source — see *Unavailable and reason codes*. Rows with `reviewState === 'queued'` add note `CA_REVIEW_PENDING` (REF-10).
Budget: 3 DB round-trips (instrument, actions, filings) + 1 for `bars_daily` closes; zero provider calls when warm; < 250 ms p95.

`members` (`variants.index`):
1. `m = await ctx.data.reference.members(ctx.instrument.instrumentId)`; take the `params.members` largest by `weight` → `membership.shown`; one `ctx.prov.add` for the membership file (`tier:'eod'`).
2. `window.from = params.from ?? ISO_DATE(validAt − 7 days)`, `window.to = params.to ?? ISO_DATE(validAt + 90 days)`; one `ctx.data.reference.corporateActions` call per batch of member ids (the reader accepts an id array — see *additions required*), `types` restricted to the cash and split families.
3. `weight` from the member row; `weightedAmount = amount === null ? null : amount × weight`; `summary.weightedCashPerIndexUnit` = sum of `weightedAmount` over rows with `exDate > validAt`, `null` when every member's amount is null; `coverage = members with ≥ 1 row ÷ shown`, rendered as a percentage so the screen states how much of the index it actually knows about.
4. `includeEarnings` is ignored (`notes: ['EARNINGS_NOT_APPLICABLE_INDEX']`); `includeProjected` applies per member exactly as in step 8.
Budget: 2 DB round-trips; < 350 ms p95.

#### Live
`issuer`: `{ subjects: ['q:' + payload.security.instrumentId], fields: ['PX_LAST'], conflationMs: 1000 }` — only `summary.pxLast` and the derived `summary.dvdYield` carry `Cell.live`; the timeline itself is static reference data. `members`: `null`.

#### Screen
```
issuer
┌ CACS · AAPL US Equity · Apple Inc · Corporate Actions ─────────────────────────┐
│ kv#summary  TTM dividend 1.04 USD (4 payments, quarterly) · yield 0.31% (live)  │
│             last split 4:1 2020-08-31 · cumulative adj factor 0.24866           │
│             next (projected) 2026-11-07 est. 0.26 — conf 0.6                    │
│ badges#notes [KNOWN AT 2026-09-15] [ESTIMATED CA UNAVAILABLE] [PROJECTED ROW]    │
│              [MERGER/TENDER/RIGHTS/CALL: NO SOURCE] [REVIEW PENDING when queued] │
│ grid#actions  ex-date (date, frozen) | type | status badge | amount (ccy 4dp)    │
│               | ratio ('4:1') | declared (date) | record (date) | pay (date)     │
│               | adj factor (number 5dp) | source | review                        │
│               future rows above the rule, tone 'highlight'; projected rows tone  │
│               'muted' with a [PROJECTED] badge and the basis in the title attr   │
│ grid#earnings  reported (datetime) | timing badge pre/post | form | items | link │
│ footer: sources ['Yahoo Finance chart events (unofficial)', 'SEC EDGAR submissions'] asOf=validAt knownAt=<knownAt> │
└─────────────────────────────────────────────────────────────────────────────────┘
members
┌ CACS · SPX Index · S&P 500 · Member Corporate Actions ─────────────────────────┐
│ badges#scope [top 50 of 503 by weight · membership 2026-06-30 · coverage 78%]    │
│ grid#actions  ex-date (date, frozen) | member (key) | wt% (pct 2dp) | type       │
│               | status | amount (ccy 4dp) | weighted (ccy 6dp) | ratio | source  │
│               groupBy 'exDate'; group footer shows the day's weighted total      │
│ kv#summary  upcoming ex-dates 31 · weighted cash per index unit 1.84 · coverage 78% │
│ footer: sources ['Yahoo Finance chart events (unofficial)', 'SEC EDGAR N-PORT']   │
└─────────────────────────────────────────────────────────────────────────────────┘
```
Title `CACS · <display> · <name> · Corporate Actions`; subtitle `<window.from> … <window.to> · knownAt <knownAt>`; `initialFocus:'actions'`. Skeleton while `payload === undefined`: `kv#summary` with 4 muted rows and `grid#actions` with 12 muted rows. `status` renders as a `Badge`: `estimated` → `info`, `announced` → `info`, `confirmed` → `ok`, `paid` → `ok` muted, `cancelled` → `error` with the row struck through. Every `meta.unavailable` entry becomes a badge in `badges#notes` whose `title` is the `detail` string, so an absent action type is visibly absent-with-a-reason rather than silently missing. A denied field (`meta.entitlement`) blanks its column with `—` and the `ReasonCode` in the tooltip (ENTL-05). `meta.staleness:'stale'` puts a `stale`-toned badge on `badges#notes` with the last `captured_at` (TERM-12).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid `actions` | `show-provenance` | opens a `kv` overlay with `sourceId`, `reviewState`, `caId`, the raw `details` JSON and the provenance request URL |
| `Shift+Enter` | grid `actions` | `open-target-next` | `ctx.navigateNext(row.newKey + ' DES')` when `newKey !== null` (spinoff child, merger acquirer, new ticker), else no-op |
| `Enter` | grid `earnings` | `open-filing` | `ctx.openUrl(row.url)` (the 8-K on sec.gov) |
| `T` | always | `cycle-types` | all → dividends only → splits only → all, via `setParams({ types })` |
| `U` | always | `toggle-status` | include/exclude `estimated` and `cancelled` in `setParams({ status })` |
| `P` | always | `toggle-projected` | `setParams({ includeProjected: !includeProjected })` |
| `K` | always | `set-known-at` | `ctx.prompt('date', { label:'Known at' })` → `setParams({ knownAt })` (STOR-06, REF-03) |
| `Home` / `End` | grid | `window-back` / `window-fwd` | `setParams({ from: from − 2 y })` / `setParams({ to: to + 1 y })` |
| `M` | grid (members) | `more-members` | `setParams({ members: clamp(members + 25, 5, 100) })` |
| `E` | always | `open-ee` | `ctx.navigate('EE')` |
| `G` | always | `open-gp` | `ctx.navigate('GP 5Y')` with dividend and split markers on (CHRT-06) |
| `Delete` | always | `open-cf` | `ctx.navigate('CF')` |

#### CSV
`filename = 'CACS_' + display.replace(/ /g,'_') + '_' + asOf.replace(/[-:]/g,'') + '.csv'`.
`issuer`: long format (§1.6 rule 3 — the screen has three blocks) with a leading `section` column. Columns: `section,exDate,caType,status,amount,currency,ratioNew,ratioOld,declaredDate,recordDate,payDate,effectiveDate,adjFactor,newKey,frequency,grossOrNet,sourceId,reviewState,projected,projectionBasis,note,caId`. Sections in order: `action` (one row per `actions[]`), `earnings` (one row per `earnings[]`, with `exDate = acceptedAt.slice(0,10)`, `caType = 'earnings_8k'`, `note = items8k.join('|') + ' ' + reportTiming`, `sourceId = 'sec.submissions'`, `caId` = the accession number), `summary` (one row per summary key, `caType` = the key, `amount` = its value). Example: `action,2026-08-08,cash_dividend,paid,0.26,USD,,,2026-07-31,2026-08-11,2026-08-14,,0.99921,,quarterly,net,yahoo.chart,auto,false,,,88421`.
`members`: wide, one row per `actions[]`, columns `exDate,memberKey,weight,caType,status,amount,currency,weightedAmount,ratioNew,ratioOld,payDate,sourceId,reviewState,projected` plus a trailing `section`-prefixed summary block (`summary,exDateCount,…`) per §1.6 rule 3's "one block dominates" form. Example: `2026-09-18,MSFT US Equity,0.068400,cash_dividend,announced,0.91,USD,0.062244,,,2026-10-09,yahoo.chart,auto,false`.

#### Help
summary `Dividend, split, name-change and earnings timeline with status` (60 chars); description `CACS is the corporate-action timeline for the security on the command line. Upcoming actions sit above the rule, history below it, and each row shows where it is on the estimated, announced, confirmed, paid ladder together with the price-adjustment factor it contributes to adjusted history. Cash dividends and splits come from the exchange-event feed; name and ticker changes are derived from the issuer's own SEC record; earnings dates are the 8-K item 2.02 acceptance times. Rows badged PROJECTED are the resolver's own estimate of the next ex-date from the issuer's payment cadence, never a published announcement. Mergers, tenders, rights, calls and conversions have no reachable source in this build and are listed as unavailable with a reason rather than shown empty. Press K to see the timeline as it was known on an earlier date.`; params: `from` ("window start", example `CACS 2020-01-01`), `to` ("window end", `CACS 2020-01-01 2027-01-01`), `types` ("corporate-action types", `T=SPLIT`), `status` ("estimated, announced, confirmed, paid, cancelled", `ST=ANNOUNCED`), `includeEarnings` ("8-K item 2.02 dates", `E=0`), `includeProjected` ("projected next ex-date", `P=0`), `members` ("index only: constituents, 5–100", `M=100`), `knownAt` ("point-in-time date", `KNOWN=2025-01-01`); sources `['yahoo.chart', 'sec.submissions', 'sec.archives', 'ssga.holdings', 'internal.derived']`; related `['DES', 'EE', 'GP', 'HP', 'CF', 'CN']`.

#### Unavailable and reason codes
One `ctx.unavailable.add` per requested-but-unsourced `ca_type`, emitted every run so the gap is visible and machine-readable:
`{ field:'merger', reason:'NO_SOURCE', detail:'CA_TYPES_NO_SOURCE: no reachable source publishes merger terms; the yahoo.chart event feed carries dividends and splits only (BRIEF §2)' }` and the identical entry for `tender`, `rights`, `call`, `conversion`, `spinoff`, `delisting` and `capital_return` ·
`{ field:'status.estimated', reason:'NO_SOURCE', detail:'ESTIMATED_CA_UNAVAILABLE: the event feed publishes an action only after its ex-date, so pre-announcement (declared-but-not-ex) rows exist only for actions entered by data operations (internal.user); the PROJECTED row is the resolver\'s cadence estimate, not an announcement (DATA-08)' }` ·
`{ field:'adjFactor', reason:'NO_SOURCE', detail:'ADJ_FACTOR_NO_CLOSE: no bars_daily close on the session before the ex-date, so the cash-dividend factor cannot be computed' }` (per affected row) ·
`{ field:'actions', reason:'NO_SOURCE', detail:'instrument has no yahoo.chart market-data line, so no event history is reachable' }` ·
`{ field:'earnings', reason:'NOT_APPLICABLE', detail:'EARNINGS_NOT_APPLICABLE_INDEX: an index has no filings; see CACS on a member' }` (members variant).
Footer notes: `PROJECTED_ROW`, `PROJECTION_INSUFFICIENT_HISTORY` (fewer than 4 cash dividends), `CA_REVIEW_PENDING` (≥ 1 row with `review_state='queued'`, REF-10), `MEMBER_SUBSET`, `MEMBERSHIP_STALE`, `COVERAGE_PARTIAL` (members coverage < 100 %). Entitlement: `NO_FIRM_ENTITLEMENT`/`NO_USER_ENTITLEMENT` on the `reference` field class blanks `amount`/`ratio`; `PROVIDER_DOWN` → `meta.staleness:'stale'` with stored rows served.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/CACS.golden.test.ts` | AAPL (id 42) seeded from `yahoo-chart-events` (dividends) + `sec-submissions-AAPL.json` at the frozen clock deep-equals `CACS.issuer.json`, including `cumulativeAdjFactor` and the projected row; SPX Index with `sec-nport-SPY-primary_doc.xml` membership equals `CACS.members.json` |
| resolver unit | `packages/server/test/unit/functions/CACS.adjust.test.ts` | against seeded fixtures: `4:1` split → `adjFactor 0.25`; a 0.26 dividend on a 331.59 prior close → `0.99922`; missing prior close → `null` + `ADJ_FACTOR_NO_CLOSE`; `cumulativeAdjFactor` equals the product used by `HP` under policy `price` (REF-09 single implementation) |
| projection | `packages/server/test/unit/functions/CACS.projection.test.ts` | 8 synthetic quarterly ex-dates → `confidence 0.6` and a median gap of 91 d; 4 rows → `0.4`; 3 rows → `nextProjected: null` + `PROJECTION_INSUFFICIENT_HISTORY`; the projected row never appears in `corporate_actions` after the run |
| point-in-time | `packages/server/test/integration/functions/CACS.pit.test.ts` | a dividend corrected from 0.25 to 0.26 by a second version filed 2026-08-20: `knownAt=2026-08-15` returns 0.25, `knownAt=now` returns 0.26; `GET /ref/:id/versions?table=corporate_actions` shows both (REF-03, STOR-06) |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(CACS.issuer.json))` equals `CACS.issuer.csv` and likewise `CACS.members`; every `amount` and `adjFactor` cell equals the payload value |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at the frozen clock (API-05) |
| screen | `packages/web/test/screens/CACS.test.tsx` | both goldens render; future rows precede past rows; `T`/`U`/`P`/`K` call `setParams`; a `queued` row shows the review badge; `summary.pxLast` registers `live: { subject:'q:42', field:'PX_LAST' }`; a `merger` `meta.unavailable` entry renders as a badge with the detail in its title; skeleton |
| unavailable | `packages/server/test/integration/functions/CACS.unavailable.test.ts` | a run with `types` containing `merger` emits the `CA_TYPES_NO_SOURCE` entry; an instrument with no `yahoo.chart` md_line returns `actions: []` with the reason |
| e2e | `packages/e2e/tests/fa-pit.spec.ts` (new step, continuing the FA/EE flow) | from `AAPL US Equity EE <GO>` press `C` → CACS loads with the same security; `K` set to 2025-01-01 changes the timeline; PRINT yields the long-format CSV whose `action` rows match the grid |

---

### CF — Company Filings

| Attribute | Value |
| --- | --- |
| Code / aliases | `CF` / `FILINGS` (no `aliasParams`) |
| Tier / category | 2 / fundamentals |
| Asset classes → variants | `equity, etf → issuer` |
| requiresSecurity / pageable / screenKind | `true` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/CF.ts` · `packages/server/src/functions/CF/resolve.ts` · `packages/web/src/screens/CF/Screen.tsx` · `fixtures/golden/functions/CF.issuer.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (DATA-06) (NEWS-04) (STOR-06) (REF-03) (DATA-10) (TERM-12) (ENTL-05) (API-05) |

**Variants (FUNC-02).** One variant, `issuer`, for both `equity` and `etf` — an ETF is a filer like any other, only its form mix differs (`NPORT-P`, `N-CEN`, `N-30D`, `485BPOS` instead of `10-K`, `10-Q`, `8-K`), and the `formCounts` block makes that difference visible without a second code path. The `latest` block therefore names an `annual`/`quarterly`/`current8k` filing that is `null` for a fund, and the screen falls back to showing the newest three filings of the issuer's most common form.

#### Params
```ts
export const CfParams = z.object({
  forms: z.array(z.string().max(12)).max(12).default([]),      // [] = every form; matched case-insensitively against filings.form
  group: z.enum(['ALL', 'PERIODIC', 'CURRENT', 'OWNERSHIP', 'FUND', 'PROXY']).default('ALL'),   // form-group preset, expanded to `forms` by the resolver
  from: z.iso.date().optional(),                               // default: validAt − 3 years
  to: z.iso.date().optional(),                                 // default: validAt
  items: z.array(z.string().max(6)).max(12).default([]),       // 8-K item codes: ['2.02','5.02'] — filings.items @> items
  xbrlOnly: z.boolean().default(false),                        // filings.is_xbrl OR is_inline_xbrl
  limit: z.number().int().min(10).max(200).default(50),
  knownAt: z.iso.datetime().optional(),                        // PIT override (STOR-06); undefined = ctx.asOf.knownAt
});
```
#### Argument grammar
`positional [{ name:'group', type:'enum', values:['ALL','PERIODIC','CURRENT','OWNERSHIP','FUND','PROXY'], optional:true }]`, `keyed { F: { name:'forms', type:'string', repeat:true }, I: { name:'items', type:'string', repeat:true }, FROM: { name:'from', type:'date' }, TO: { name:'to', type:'date' }, X: { name:'xbrlOnly', type:'boolean' }, N: { name:'limit', type:'int' }, KNOWN: { name:'knownAt', type:'datetime' } }`, no `rest`.
Examples: `AAPL US Equity CF` → `{ forms:[], group:'ALL', items:[], xbrlOnly:false, limit:50 }` · `AAPL US Equity CF PERIODIC X=1` → `{ group:'PERIODIC', xbrlOnly:true }` · `AAPL US Equity CF F=8-K I=2.02 FROM=2024-01-01` → `{ forms:['8-K'], items:['2.02'], from:'2024-01-01' }`.
Group presets (`packages/core/src/functions/shared/secForms.ts`): `PERIODIC` → `['10-K','10-K/A','10-Q','10-Q/A','20-F','40-F']` · `CURRENT` → `['8-K','8-K/A','6-K']` · `OWNERSHIP` → `['3','4','5','SC 13D','SC 13D/A','SC 13G','SC 13G/A','13F-HR']` · `FUND` → `['NPORT-P','N-CEN','N-30D','485BPOS','497']` · `PROXY` → `['DEF 14A','DEFA14A','PRE 14A']` · `ALL` → `[]`.

#### Payload
```ts
export interface CfFiling {
  accessionNo: string;                                          // '0000320193-26-000020'
  form: string; formGroup: 'PERIODIC' | 'CURRENT' | 'OWNERSHIP' | 'FUND' | 'PROXY' | 'OTHER';
  filedDate: string;                                            // filings.filed_date (YYYY-MM-DD)
  acceptedAt: string | null;                                    // filings.accepted_at — the public-knowledge instant
  reportDate: string | null;                                    // filings.report_date (period of report)
  items: string[] | null;                                       // filings.items — 8-K item codes
  itemLabels: string[] | null;                                  // EIGHT_K_ITEMS lookup; 'Item <code>' when unknown
  primaryDoc: string; primaryDocDesc: string | null;
  isXbrl: boolean; isInlineXbrl: boolean; sizeBytes: number | null;
  url: string;                                                  // filings.url
  isAmendment: boolean;                                         // form ends with '/A'
  amends: string | null;                                        // accessionNo of the newest same-form filing with the same reportDate, when one exists
  provIdx: number;
}
export type CfPayload = {
  variant: 'issuer';
  security: { instrumentId: number; key: string; name: string; assetClass: 'equity' | 'etf' };
  issuer: { issuerId: number | null; name: string; cik: string | null; sic: string | null; sicDescription: string | null;
            filerCategory: string | null; fiscalYearEnd: string | null /* 'MMDD' */; entityType: string | null;
            formerNames: Array<{ name: string; from: string; to: string }>; website: string | null };
  filter: { forms: string[]; group: CfPayload['filter']['group']; items: string[]; xbrlOnly: boolean; from: string; to: string };
  filings: CfFiling[];                                          // accepted_at DESC, then accessionNo DESC
  formCounts: Array<{ form: string; formGroup: CfFiling['formGroup']; count: number; newest: string }>;   // over the whole window, not the page
  latest: { annual: CfFiling | null; quarterly: CfFiling | null; current8k: CfFiling | null; fundHoldings: CfFiling | null };
  coverage: { from: string | null; to: string | null; sourceId: 'sec.submissions'; recentOnly: boolean; countInStore: number };
  total: number; knownAt: string;
  notes: string[];                                              // 'FILING_FULLTEXT_UNAVAILABLE', 'DOCUMENT_NOT_STORED_LINK_OUT', 'HISTORY_LIMITED_RECENT_FILE'
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `filings` (primary), `issuers` (as-of; `cik`, `sic`, `sic_description`, `filer_category`, `fiscal_year_end`, `entity_type`, `former_names`, `website`), `identifiers` (scheme `CIK`), `instruments` (as-of), `issues`, `xbrl_facts` (existence probe for the XBRL badge), `fund_terms` (ETF `cik` when the issuer has none), `provenance` |
| Data services (§1.4.2) | `data.reference.instrument`, `data.filings.list` |
| Read-through (`providers.ensure`) | `('sec.submissions', cik, { maxAgeMs: 21_600_000 })` on every run whose newest stored `filings.captured_at` for the CIK is older than 6 h |
| Engines (`core/analytics`) | None. |
| Subjects (live) | None. |
| Field ids (`fieldIds(assetClass)`) | `equity, etf: [FILING_FORM, FILING_DT, FILING_ACCESSION_NO, FILING_ITEMS, FILING_IS_XBRL, FA_FILED_AT]` — `fieldClass:'fundamental'`, `sourceId:'sec.submissions'` |

#### Resolver
`issuer` (default `resolve`, also `variants.equity` and `variants.etf`):
1. `knownAt = params.knownAt ? min(new Date(params.knownAt), ctx.asOf.knownAt) : ctx.asOf.knownAt` (STOR-06). `inst = await ctx.data.reference.instrument(ctx.instrument.instrumentId)`; `cik = inst.issuer.cik ?? inst.terms?.kind === 'fund' ? inst.terms.cik : null` (a fund's CIK lives on `fund_terms` when the trust is not itself an issuer row). `cik === null` → `ctx.unavailable.add({ field:'filings', reason:'NO_SOURCE', detail:'issuer has no SEC CIK (not an SEC filer)' })` and return with `filings: []`, `formCounts: []`, `total: 0`.
2. `forms = params.forms.length ? params.forms : FORM_GROUPS[params.group]` (`ALL` → `[]`, meaning no form filter). `from = params.from ?? ISO_DATE(validAt − 3 years)`, `to = params.to ?? ISO_DATE(validAt)`.
3. `await ctx.providers.ensure('sec.submissions', cik, { maxAgeMs: 21_600_000 })`. `{ fresh:false }` with stored rows → `ctx.prov.add({ …, st:'stale' })` → `meta.staleness:'stale'` and the stale badge (TERM-12); a thrown `ProviderUnavailableError` with nothing stored propagates as `503 PROVIDER_UNAVAILABLE` (§1.4.2).
4. `page = await ctx.data.filings.list(cik, { forms: forms.length ? forms : undefined, from, to, cursor: ctx.page?.cursor ?? undefined, limit: params.limit })`, then in-resolver filtering that the service does not express: `params.items.length` keeps rows whose `items` is a superset of `params.items`; `params.xbrlOnly` keeps rows with `is_xbrl || is_inline_xbrl`. Each row maps onto `CfFiling` with `formGroup` from the reverse of `FORM_GROUPS`, `itemLabels` from `EIGHT_K_ITEMS`, `isAmendment = form.endsWith('/A')`, and `provIdx = ctx.prov.add({ sourceId:'sec.submissions', provenanceId: row.provenanceId, capturedAt: row.capturedAt, sourceTs: row.acceptedAt, st:'closed', tier:'eod' })` — one provenance entry per submissions capture, shared by every row it produced.
5. `amends`: for a row with `isAmendment`, the newest non-amendment filing with the same `form.replace('/A','')` and the same `reportDate`; `null` when none is stored.
6. `formCounts` is a second, aggregate query over the *whole* window (not the page): `count(*)` and `max(filed_date)` grouped by `form`, sorted by count desc then form asc — this is what makes the screen honest about an ETF's form mix without a second variant.
7. `latest`: newest `10-K`/`20-F`/`40-F` → `annual`; newest `10-Q` → `quarterly`; newest `8-K` → `current8k`; newest `NPORT-P` → `fundHoldings`; each `null` when the window holds none. For an `etf` whose `annual`/`quarterly` are both null, `notes` gains `'PERIODIC_NOT_FILED_FUND'`.
8. `coverage`: `from`/`to` = min/max `filed_date` in store for the CIK, `countInStore` = total stored rows, `recentOnly = true` when `countInStore >= 1000` or the oldest stored `filed_date` is later than `params.from` — the SEC `submissions/CIK…json` file carries only the recent window inline and the older `filings.files[]` shards are not ingested in v1 (see *Unavailable and reason codes*).
9. `ctx.page.set({ index, count: page.total, cursor: filings.length ? base64url(JSON.stringify({ acceptedAt: last.acceptedAt, accessionNo: last.accessionNo })) : null })`. PAGE FWD = older filings.
10. `notes` always includes `'FILING_FULLTEXT_UNAVAILABLE'` and `'DOCUMENT_NOT_STORED_LINK_OUT'`; `'HISTORY_LIMITED_RECENT_FILE'` when `coverage.recentOnly`.
Budget: 3 DB round-trips (instrument, filings page, form counts); zero provider calls when warm; < 200 ms p95 warm, < 3 s cold (one `submissions` fetch of ≈ 1.2 MB).

#### Live
`null` — filings are stored reference data. New filings arrive through the scheduler's `sec.submissions` job and reach an open screen only on re-run; the screen's `A` key registers a filing alert instead (`alerts.kind='filing'`, `condition: { ciks:[cik], forms, items }`, NEWS-07).

#### Screen
```
┌ CF · AAPL US Equity · Apple Inc · Filings ─────────────────────────────────────┐
│ kv#issuer  CIK 0000320193 · SIC 3571 Electronic Computers · Large accelerated   │
│            filer · FYE 09-26 · former names: — · sec.gov/cgi-bin/browse-edgar   │
│ kv#latest  latest 10-K 2025-10-31 (FY 2025-09-27) · latest 10-Q 2026-07-31      │
│            · latest 8-K 2026-08-04 (Item 8.01)                                  │
│ badges#filter [ALL · 2023-09-15..2026-09-15 · 214 filings] [XBRL only when set]  │
│ badges#notes  [FULL-TEXT SEARCH UNAVAILABLE] [LINK-OUT ONLY] [HISTORY: RECENT]   │
│ split dir 'row' sizes [0.24, 0.76]                                              │
│   table#formCounts  form | group | count | newest (date)    (left, click filters)│
│   grid#filings  filed (date, frozen) | accepted (datetime) | form | items        │
│                 | description (primaryDocDesc, elastic) | period (date)          │
│                 | XBRL (badge) | size (int, bytes) | accession (text)            │
│                 frozenColumns 1; amendments tone 'muted' with an [A] badge       │
│ footer: sources ['SEC EDGAR submissions (public domain)'] asOf=validAt knownAt=<knownAt> │
└─────────────────────────────────────────────────────────────────────────────────┘
```
Title `CF · <display> · <name> · Filings`; subtitle `<group or forms.join(",")> · <from> … <to> · <total> filings`; `initialFocus:'filings'`. Skeleton while `payload === undefined`: two muted `kv` blocks of 3 rows and `grid#filings` with 15 muted rows. `meta.unavailable` entries render in `badges#notes` with the `detail` as the badge `title`; a no-CIK issuer replaces the grid with a `text#empty` node (`tone:'warn'`) carrying the detail verbatim. `meta.entitlement` denials on the `fundamental` field class blank the grid and show the `ReasonCode` badge (`tone:'blocked'`, ENTL-05). `meta.staleness:'stale'` adds a `stale`-toned badge naming the last `captured_at` (TERM-12). `page` renders in the grid's `page: { index, count }` footer; PAGE FWD/BACK are the reserved `PageDown`/`PageUp` (§2.6).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid `filings` | `open-filing` | `ctx.openUrl(row.url)` (the primary document on sec.gov; nothing is proxied or stored) |
| `Shift+Enter` | grid `filings` | `open-fa-next` | `ctx.navigateNext(display + ' FA IS Q KNOWN=' + row.filedDate)` — the statements as of that filing (STOR-06) |
| `Enter` | table `formCounts` | `filter-form` | `ctx.setParams({ forms: [row.form], group: 'ALL' })` |
| `1`…`6` | always | `tab-group` | `ALL, PERIODIC, CURRENT, OWNERSHIP, FUND, PROXY` → `setParams({ group, forms: [] })` (number keys are the group tabs, §7.2 rule 5) |
| `X` | always | `toggle-xbrl` | `setParams({ xbrlOnly: !xbrlOnly })` |
| `I` | always | `filter-items` | `ctx.prompt('text', { label:'8-K items (comma separated)' })` → `setParams({ items })` |
| `Home` / `End` | grid | `window-back` / `window-now` | `setParams({ from: from − 3 y })` / `setParams({ from: undefined, to: undefined })` |
| `A` | always | `save-alert` | `sdk.alerts.create({ kind:'filing', condition: { ciks:[cik], forms: filter.forms, items: filter.items } })` (NEWS-07) |
| `F` | always | `open-fa` | `ctx.navigate('FA')` |
| `E` | always | `open-ee` | `ctx.navigate('EE')` |
| `C` | always | `open-cacs` | `ctx.navigate('CACS')` |
| `Delete` | always | `open-cn` | `ctx.navigate('CN')` |

#### CSV
`filename = 'CF_' + display.replace(/ /g,'_') + '_' + asOf.replace(/[-:]/g,'') + '.csv'`. The filings grid dominates, so §1.6 rule 3's "one block wide plus the others appended" form applies. Static columns: `accessionNo,form,formGroup,filedDate,acceptedAt,reportDate,items,itemLabels,primaryDoc,primaryDocDesc,isXbrl,isInlineXbrl,isAmendment,amends,sizeBytes,url`; `items`/`itemLabels` are `|`-joined. One row per `filings[]` (the current page only — the header's `# note: page 1 of 5` line states it), then the `formCounts` block appended as rows whose `accessionNo` is `_FORM_COUNT`, `form` is the form, `sizeBytes` is the count and `filedDate` is `newest`. Example: `0000320193-26-000020,10-Q,PERIODIC,2026-07-31,2026-07-31T20:31:00Z,2026-06-27,,,aapl-20260627.htm,10-Q,true,true,false,,4821004,https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/aapl-20260627.htm`; appended: `_FORM_COUNT,8-K,CURRENT,2026-08-04,,,,,,,,,,,17,`.

#### Help
summary `SEC filings for this issuer with form, item and XBRL filters` (59 chars); description `CF lists the SEC filings of the issuer behind the security on the command line, newest first, with the form, the 8-K items, the period of report and whether the filing carries XBRL. The number keys switch between form groups: periodic (10-K, 10-Q), current (8-K), ownership (Forms 3/4/5, 13D/G), fund (N-PORT, N-CEN) and proxy. Press X for XBRL filings only, I to filter 8-K items, Enter to open the document on sec.gov and Shift+Enter to open FA as it was known on the filing date. Documents are linked, never stored or proxied. Searching inside filing text is not possible in this build: the SEC full-text search endpoint is not reachable, so filter by form, item and date instead.`; params: `group` ("ALL, PERIODIC, CURRENT, OWNERSHIP, FUND or PROXY", example `CF PERIODIC`), `forms` ("explicit form types", `F=8-K`), `items` ("8-K item codes", `I=2.02`), `from` ("window start", `FROM=2024-01-01`), `to` ("window end", `TO=2026-01-01`), `xbrlOnly` ("XBRL filings only", `X=1`), `limit` ("rows per page, 10–200", `N=100`), `knownAt` ("point-in-time date", `KNOWN=2025-06-30`); sources `['sec.submissions', 'sec.atom']`; related `['FA', 'EE', 'CN', 'CACS', 'DES', 'HDS']`.

#### Unavailable and reason codes
`{ field:'q', reason:'NO_SOURCE', detail:'FILING_FULLTEXT_UNAVAILABLE: the SEC full-text search endpoint (efts.sec.gov) is blocked from this network, so filings cannot be searched by document text; filter by form, 8-K item and date instead (BRIEF §2)' }` — emitted on every run, which is why `CfParams` has no `q` at all ·
`{ field:'document', reason:'NOT_LICENSED', detail:'DOCUMENT_NOT_STORED_LINK_OUT: filing documents are linked on sec.gov and never stored, proxied or served by the terminal' }` — emitted on every run ·
`{ field:'coverage', reason:'NO_SOURCE', detail:'HISTORY_LIMITED_RECENT_FILE: only the recent window of data.sec.gov/submissions/CIK<cik>.json is ingested; the older filings.files[] shards are not fetched in v1, so filings before ' + coverage.from + ' are absent' }` when `coverage.recentOnly` ·
`{ field:'filings', reason:'NO_SOURCE', detail:'issuer has no SEC CIK (not an SEC filer)' }` ·
`{ field:'items', reason:'NOT_APPLICABLE', detail:'ITEMS_ONLY_ON_8K: item codes exist only on 8-K and 6-K filings; the filter matched nothing in the other selected forms' }` when `params.items` is non-empty and `forms` contains no current-report form ·
footer notes `PERIODIC_NOT_FILED_FUND` (an ETF with no 10-K/10-Q in the window) and `ITEM_LABEL_UNKNOWN` (an 8-K item code absent from `EIGHT_K_ITEMS`). Entitlement: `NO_FIRM_ENTITLEMENT`/`NO_USER_ENTITLEMENT` on the `fundamental` field class blanks the grid with the reason; `PROVIDER_DOWN` (circuit open, stored rows) → `meta.staleness:'stale'`.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/CF.golden.test.ts` | AAPL (id 42) seeded from `sec-submissions-AAPL.json` at the frozen clock deep-equals `CF.issuer.json`, including `formCounts`, `latest` and `coverage.recentOnly`; SPY seeded from `sec-spy-submissions.json` asserted inline: `variant:'issuer'`, `latest.annual === null`, `latest.fundHoldings.form === 'NPORT-P'`, note `PERIODIC_NOT_FILED_FUND` |
| resolver unit | `packages/server/test/unit/functions/CF.filter.test.ts` | against the seeded fixture rows: `group:'CURRENT'` returns only 8-K/8-K/A/6-K; `items:['2.02']` keeps only filings whose `items` superset-matches; `xbrlOnly` drops Form 4s; `amends` links an `8-K/A` to the `8-K` with the same `reportDate`; `formGroup` mapping covers every form present in both submissions fixtures |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(CF.issuer.json))` equals `CF.issuer.csv`; the appended `_FORM_COUNT` rows equal `formCounts`; every `sizeBytes` cell equals the payload value |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at the frozen clock (API-05) |
| screen | `packages/web/test/screens/CF.test.tsx` | the golden renders; number keys `1`–`6` switch group via `setParams`; `X`/`I` call `setParams`; Enter calls `openUrl(row.url)`; Shift+Enter navigates to `FA IS Q KNOWN=<filedDate>`; clicking a `formCounts` row filters; the three standing `meta.unavailable` badges are present with their detail text; `payload undefined` renders the skeleton |
| paging | `packages/server/test/integration/functions/CF.page.test.ts` | `limit:10` over the 214 seeded AAPL filings: `meta.page.cursor` round-trips through `POST /functions/CF/page { direction:'fwd' }`, returns strictly older `acceptedAt`, no duplicate accession numbers, `count` stable across pages |
| point-in-time | `packages/server/test/integration/functions/CF.pit.test.ts` | `KNOWN=2025-06-30` omits every filing accepted after that instant (`accepted_at > knownAt`), so CF and FA agree about what was public on a date (STOR-06) |
| e2e | `packages/e2e/tests/export.spec.ts` (new step) | `AAPL US Equity CF PERIODIC <GO>`, `Ctrl+P` yields a CSV whose first data row's `accessionNo` and `filedDate` equal the first grid row; `PageDown` loads older filings and the page badge increments |

---

### ECO — Economic Calendar

| Attribute | Value |
| --- | --- |
| Code / aliases | `ECO` / `CAL`, `CALENDAR` (no `aliasParams`) |
| Tier / category | 2 / monitor |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/ECO.ts` · `packages/server/src/functions/ECO/resolve.ts` · `packages/web/src/screens/ECO/Screen.tsx` · `fixtures/golden/functions/ECO.default.{json,csv}` (calendar mode), `fixtures/golden/functions/ECO.default-release.{json,csv}` (release mode) |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (DATA-07) (DATA-08) (DATA-10) (STOR-06) (TERM-08) (TERM-12) (ENTL-05) (API-05) (NEWS-08) |

#### Params
```ts
export const EcoParams = z.object({
  range: z.enum(['D', 'W', 'M']).default('W'),          // day / week (Mon–Sun) / calendar month, anchored on `date`
  date: z.iso.date().optional(),                        // anchor day; undefined = ctx.asOf.validAt in America/New_York
  country: z.enum(['US', 'ALL']).default('US'),
  importance: z.number().int().min(1).max(3).default(1),// minimum econ_releases.importance shown (1 = show everything)
  releaseId: z.number().int().positive().optional(),    // set → release-detail mode (econ_releases.release_id)
  fomc: z.boolean().default(true),                      // include the FOMC block
});
```
#### Argument grammar
`positional [{ name:'range', type:'enum', values:['D','W','M'], optional:true }, { name:'date', type:'date', optional:true }]`, `keyed { CTY: { name:'country', type:'enum', values:['US','ALL'] }, IMP: { name:'importance', type:'int' }, REL: { name:'releaseId', type:'int' }, FOMC: { name:'fomc', type:'boolean' } }`, no `rest`.
Examples: `ECO` → `{ range:'W', country:'US', importance:1, fomc:true }` · `ECO M 2026-10-05 CTY=ALL IMP=2` → `{ range:'M', date:'2026-10-05', country:'ALL', importance:2 }` · `ECO REL=10` → `{ releaseId:10 }` (release-detail mode for FRED release 10, Consumer Price Index).

#### Payload
```ts
export type EcoImportance = 1 | 2 | 3;
export type EcoSourceId = 'fred.calendar' | 'bls.schedule' | 'fed.fomc';

/** One scheduled or released macro print. `consensus` is structurally null: the wedge has no estimates provider (BRIEF §2). */
export interface EcoEventRow {
  eventId: number; releaseId: number; releaseName: string; sourceId: EcoSourceId;
  country: string; url: string | null; importance: EcoImportance;
  scheduledAt: string; timeKnown: boolean;                       // timeKnown=false → FRED date at 08:30 ET, screen shows 'ET —'
  periodLabel: string;                                            // 'August 2026'
  seriesCode: string | null; seriesName: string | null; units: string | null; decimals: number | null;
  actual: ValueCell; prior: ValueCell; revisedPrior: ValueCell;   // ECO_VALUE / ECO_PRIOR / ECO_PRIOR (revised vintage)
  consensus: { v: null; r: 'NO_CONSENSUS_SOURCE' }; surprisePct: null;
  status: 'scheduled' | 'released' | 'revised' | 'delayed' | 'cancelled';
  subject: string | null;                                         // 'e:CUUR0000SA0' when seriesCode is known
  provIdx: number;
}
export type EcoPayload = {
  variant: 'default';
  mode: 'calendar' | 'release';
  window: { from: string; to: string; tz: 'America/New_York'; label: string };   // label 'Week of 2026-09-14'
  country: 'US' | 'ALL'; importance: EcoImportance;
  days: Array<{ date: string; isBusinessDay: boolean; events: EcoEventRow[] }>;  // every day of the window, empty days kept
  fomc: Array<{ meetingDate: string; statementAt: string | null; hasSep: boolean; decisionBp: number | null;
                isNext: boolean; inWindow: boolean; provIdx: number }>;
  release: {
    releaseId: number; name: string; sourceId: EcoSourceId; country: string; url: string | null; importance: EcoImportance;
    events: EcoEventRow[];                                                        // last 12 events of this release, newest first
    series: Array<{ seriesCode: string; name: string; units: string; frequency: 'D'|'W'|'M'|'Q'|'A'; seasonalAdj: string | null;
                    decimals: number | null; lastObsDate: string | null; lastUpdatedAt: string | null;
                    observations: Array<{ obsDate: string; value: number | null; status: 'final'|'preliminary'|'revised'|'missing';
                                          vintageAt: string; isLatest: boolean; footnote: string | null; provIdx: number }>;
                    revisions: Array<{ obsDate: string; vintages: Array<{ vintageAt: string; value: number | null; status: string }> }>;
                    chart: Array<{ t: number; v: number | null }> }>;             // oldest → newest, for the custom Sparkline node
    nextEvent: EcoEventRow | null;
  } | null;                                                                        // null in calendar mode
  consensus: { value: null; reason: 'NO_CONSENSUS_SOURCE' };
  knownAt: string;
  cursor: { prev: string; next: string };                                          // base64url(JSON) — see Resolver step 7
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `econ_release_events`, `econ_releases`, `econ_series`, `econ_observations` (vintages; read with `vintage_at ≤ knownAt`, STOR-06), `fomc_meetings`, `calendars` / `calendar_holidays` (`USGOVT` for business days), `instruments` (asset_class `econ`, for the `e:` subject and GP hand-off), `provenance` |
| Data services (§1.4.2) | `data.econ.calendar`, `data.econ.fomc`, `data.econ.series`, `data.econ.observations`, `data.reference.calendar`, `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | Calendar mode: **None** — `ReadThroughKind` (§1.4.2) has no `fred.calendar`/`bls.schedule`/`fed.fomc` member, so the calendar is only as fresh as the `econCalendar.ts` job (daily 05:00 ET, ARCHITECTURE §7.1); when `max(econ_release_events.provenance.captured_at) < ctx.clock.now() − 36 h` the resolver adds the footer note `CALENDAR_STALE` and `ctx.prov.add({ …, st:'stale' })` (TERM-12). Release mode: `('fred.series', seriesCode, { maxAgeMs: 3_600_000 })` for each series of the release whose `last_updated_at` is older than one hour |
| Engines (`core/analytics`) | None. (`revisedPrior` and the vintage diff are resolver arithmetic; `meta.engines` empty) |
| Subjects (live) | `e:<seriesCode>` for every event whose `scheduledAt` falls inside `[now − 2 h, now + 12 h]` and whose `seriesCode` is not null (calendar mode); `e:<seriesCode>` for every series of the release (release mode) |
| Field ids (`fieldIds(assetClass)`) | `default: [ECO_VALUE, ECO_PRIOR, ECO_RELEASE_DT, ECO_PERIOD, ECO_VINTAGE]` |

#### Resolver
Single `resolve` (`assetClasses: 'none'`, no variants):
1. `anchor = params.date ?? formatDate(ctx.asOf.validAt, 'America/New_York')`. `window` from `params.range`: `D` → `[anchor, anchor]`; `W` → Monday..Sunday of `anchor`'s ISO week; `M` → first..last day of `anchor`'s month. `knownAt = ctx.asOf.knownAt` (STOR-06 — an export re-supplies it, so a re-run reproduces the same vintages). When `ctx.page` is present, `anchor` comes from the decoded cursor instead (step 7).
2. Calendar mode (`params.releaseId === undefined`): `events = await ctx.data.econ.calendar({ from: window.from, to: window.to, country: params.country })`, filtered to `importance ≥ params.importance`. One `ctx.prov.add({ sourceId: e.sourceId, provenanceId: e.provenanceId, capturedAt, sourceTs: null, st: calendarStale ? 'stale' : 'closed', tier:'eod' })` per distinct `provenance_id`, cached in a Map so each event's `provIdx` reuses it.
3. Per event build `EcoEventRow`: `actual = { v: e.actual, st: e.status === 'scheduled' ? 'blank' : 'closed', ts: e.scheduledAt, provIdx }`; `prior = { v: e.prior, st:'closed', … }`; `revisedPrior = { v: e.revisedPrior, st: e.revisedPrior === null ? 'na' : 'closed', … }` (`'na'` because a print that was never revised has no revised prior — not a denial, so no `r`). `consensus = { v: null, r: 'NO_CONSENSUS_SOURCE' }` and `surprisePct: null` on **every** row; `econ_release_events.consensus` is `NULL` by schema and `consensus_unavailable_reason` carries the same code. `ctx.unavailable.add({ field:'consensus', reason:'NO_SOURCE', detail:'NO_CONSENSUS_SOURCE: no consensus-estimates provider is reachable in the wedge (BRIEF §2); the column is never populated' })` exactly once per run — never a fabricated or back-filled number (NEWS-08).
4. `subject = e.seriesCode ? 'e:' + e.seriesCode : null`; collect the subjects of events inside `[now − 2 h, now + 12 h]`, `plant.ensureHot(subjects)`, then `plant.snapshotMany(subjects)`; when a state exists, `actual` is rebuilt with `cellFromState(ctx, state, 'ECO_VALUE', subject)` (Tier 1 §0.4 rule 1) so a print that lands while the screen is open flashes in place. Monitor rule §0.4 rule 2 applies: the resolver never calls `providers.ensure` for these subjects.
5. `days` = every date in the window (inclusive), `isBusinessDay` from `data.reference.calendar('USGOVT')`, `events` sorted by `scheduledAt` then `releaseName`; empty days are kept so the screen renders the week grid.
6. FOMC block when `params.fomc`: `meetings = await ctx.data.econ.fomc()`; keep meetings in the window plus the next two after `ctx.asOf.validAt`; `isNext` on the first meeting with `meetingDate ≥ validAt`; `decisionBp` is `null` before the decision and is never estimated. One `prov.add` for the `fed.fomc` capture.
7. `ctx.page.set({ index: 0, count: 1, cursor: next })` with `next = base64url(JSON.stringify({ anchor: shift(anchor, params.range, +1), range: params.range }))` and `prev` the `−1` shift; PAGE FWD means the **later** window (next day/week/month), PAGE BACK the earlier one. Both are also returned in `payload.cursor` so the screen can label the arrows.
8. Release mode (`params.releaseId` set): `rel = econ_releases` row (404-equivalent → `ctx.unavailable.add({ field:'release', reason:'NO_SOURCE', detail:'unknown release id' })` and `release: null`). `events` = last 12 `econ_release_events` of the release ordered `scheduled_at DESC`, built as in step 3. For each `econ_series` with that `release_id`: `ensure('fred.series', seriesCode, 1 h)` when stale, then `data.econ.observations(seriesCode, { from: window.from − 5 y, to: window.to, knownAt })` → `observations` (latest vintage per `obs_date`) and `revisions` (every vintage of the last 8 `obs_date`s, so a revision is visible as data, not as prose). `chart` = `observations` oldest → newest as `{ t: Date.parse(obsDate), v }`. `days` is still populated for the window so `PAGE`/`Esc`-free navigation back to the calendar keeps context.
9. Return `{ variant:'default', mode, window, country, importance, days, fomc, release, consensus: { value:null, reason:'NO_CONSENSUS_SOURCE' }, knownAt: ISO(knownAt), cursor }`.
Budget: calendar mode 2 DB round-trips (events+releases join, fomc) + 1 plant snapshot, zero provider calls; < 120 ms p95. Release mode 4 DB round-trips; < 250 ms p95 warm, < 3 s cold (one FRED CSV per series).

#### Live
Calendar mode: `{ subjects: rows.filter(r => r.subject && withinWindow(r.scheduledAt)).map(r => r.subject!), fields: '*', conflationMs: 1000 }` — `e:` subjects are subscribed with `f: []` (API.md §6.1, Tier 1 §0.4 rule 5). Release mode: `{ subjects: release.series.map(s => 'e:' + s.seriesCode), fields: '*', conflationMs: 1000 }`. The events grid sets `live.subjectOf = row => row.subject`; the `actual` cell carries `Cell.live = { subject, field:'ECO_VALUE' }` so a release delta flashes the cell and flips `status` to `released` through the `status` frame.

#### Screen
```
calendar (mode = 'calendar')
┌ ECO · Economic Calendar · Week of 2026-09-14 (US) ───────────────────────────────┐
│ tabs#range   [1 Day] [2 Week] [3 Month]      badges#mode [US] [IMP ≥ 1] [FOMC ON] │
│ badges#reason [CONSENSUS UNAVAILABLE · NO_CONSENSUS_SOURCE] [CALENDAR_STALE?]     │
│ grid#events  groupBy 'date' — one group header per day (Mon 14 Sep · business)    │
│   time (ET, datetime; '—' when timeKnown=false) | release | period | series       │
│   | actual (live, fmt px, decimals from series) | prior (px) | revised (px)       │
│   | consensus (always '—', tooltip NO_CONSENSUS_SOURCE) | status badge            │
│ table#fomc   meeting date | statement (14:00 ET) | SEP | decision bp ('—' before) │
│ footer: sources ['FRED release calendar','BLS release schedule','FOMC calendar']  │
│         asOf=knownAt · notes ['PAGE FWD = next week']                            │
└──────────────────────────────────────────────────────────────────────────────────┘
release (mode = 'release')
┌ ECO · Consumer Price Index · release 10 (FRED) ──────────────────────────────────┐
│ kv#release   publisher · country · importance · next event (datetime + period)    │
│              last actual · prior · revised prior · consensus — NO_CONSENSUS_SOURCE │
│ custom#spark Sparkline { points: release.series[0].chart, fmt:'px' }              │
│ grid#events  scheduled | period | actual | prior | revised | status | url          │
│ grid#vintages obsDate | vintageAt | value | status   (the revision audit, STOR-06) │
│ footer: sources ['FRED (public domain)'] asOf=knownAt                             │
└──────────────────────────────────────────────────────────────────────────────────┘
```
Title `ECO · Economic Calendar · <window.label> (<country>)` / `ECO · <release.name> · release <id>`; subtitle `<range> · IMP ≥ <importance>`. `initialFocus:'events'`. Skeleton while `payload === undefined`: the tabs row plus `grid#events` with 12 muted rows and no group headers. `meta.unavailable` renders as the `badges#reason` row and as the `consensus` column tooltip; `meta.entitlement` denials on `ECO_VALUE` blank the `actual` column with `—` and the reason text (ENTL-05); `meta.staleness:'stale'` adds the stale glyph to `badges#mode` and the `CALENDAR_STALE` badge (TERM-12). `timeKnown === false` renders the time cell as `—` with the tooltip `FRED publishes the date only; 08:30 ET assumed for ordering`.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `1` / `2` / `3` | always | `tab-range` | `ctx.setParams({ range: 'D' \| 'W' \| 'M' })` (usage `fn.param`) |
| `C` | always | `cycle-country` | `US → ALL → US` via `setParams({ country })` |
| `I` | always | `cycle-importance` | `1 → 2 → 3 → 1` via `setParams({ importance })` |
| `F` | always | `toggle-fomc` | `setParams({ fomc: !fomc })` |
| `T` | always | `today` | `setParams({ date: undefined })` — back to the window containing `ctx.asOf.validAt` |
| `+` / `-` | grid | `page-fwd` / `page-back` | `ctx.page('fwd')` / `ctx.page('back')` — later / earlier window |
| `Enter` | grid (`events`) | `open-release` | `ctx.navigate('ECO REL=' + row.releaseId)` (release-detail mode) |
| `Shift+Enter` | grid (`events`) | `open-release-next` | `ctx.navigateNext('ECO REL=' + row.releaseId)` |
| `G` | grid (`events`) | `open-gp` | `ctx.navigate(row.seriesCode + ' Index GP 5Y')` when `seriesCode` is set, else no-op |
| `N` | grid (`events`) | `open-news` | `ctx.navigate('NI ECO')` (economics topic feed) |
| `U` | grid (`events`) | `open-url` | `ctx.openUrl(row.url)` (FRED/BLS release page) |
| `Enter` | grid (`vintages`) | `open-hp` | `ctx.navigate(seriesCode + ' Index HP')` |

#### CSV
`filename = 'ECO_' + (params.releaseId ? 'REL' + params.releaseId : params.range + '_' + window.from.replace(/-/g,'')) + '_' + asOf.replace(/[-:]/g,'') + '.csv'`; `csvColumns` is `null` (payload-dependent).
`mode='calendar'` — one wide table, one row per event across all `days[]` in chronological order, columns `date,scheduledAt,timeKnown,country,releaseId,release,periodLabel,seriesCode,units,actual,prior,revisedPrior,consensus,consensusReason,status,importance,url` with `consensus` always empty and `consensusReason` always `NO_CONSENSUS_SOURCE`; FOMC meetings are appended as `section`-free rows whose `release` is `FOMC Meeting`, `seriesCode` empty and `actual` = `decisionBp` (unit bp) per §1.6 rule 3. Example: `2026-09-16,2026-09-16T12:30:00Z,true,US,10,Consumer Price Index,August 2026,CUUR0000SA0,Index 1982-1984=100,324.112,323.048,,,NO_CONSENSUS_SOURCE,released,2,https://fred.stlouisfed.org/releases/calendar`.
`mode='release'` — long format `section,key,value,unit,asOf,source` with sections `release` (one row per attribute), `event` (key = `scheduledAt`, value = `actual`), `observation` (key = `obsDate`, value = observation value, `asOf` = `vintageAt`) and `vintage` (key = `obsDate|vintageAt`). Example: `observation,2026-08-01,324.112,Index 1982-1984=100,2026-09-16T12:31:04Z,fred.csv`.

#### Help
summary `Macro release calendar with actual, prior and revised values; consensus unavailable`; description `ECO shows scheduled and released economic data by day, week or month from the FRED release calendar, the BLS release schedule and the FOMC calendar, with the actual print, the prior value and the revised prior taken from the stored observation vintages. Press 1/2/3 for day, week or month, C to switch between US and all countries, I to raise the importance filter and + / - to page to the next or previous window. Enter on a row opens the release, where every observation is listed with the exact vintage that produced it, so a revision is visible as data rather than as a footnote. Consensus, forecast dispersion and surprise are unavailable: no consensus-estimates provider is reachable in this wedge, so those columns show NO_CONSENSUS_SOURCE and are never filled with a guess.`; params: `range` ("D, W or M", example `ECO M`), `date` ("anchor day", `ECO W 2026-10-05`), `country` ("US or ALL", `CTY=ALL`), `importance` ("minimum importance 1–3", `IMP=2`), `releaseId` ("open one release", `REL=10`), `fomc` ("include FOMC meetings", `FOMC=0`); sources `['fred.calendar', 'bls.schedule', 'fed.fomc', 'fred.csv', 'bls.timeseries']`; related `['NI', 'GP', 'HP', 'BTMM', 'FED', 'WIRP']`.

#### Unavailable and reason codes
`{ field:'consensus', reason:'NO_SOURCE', detail:'NO_CONSENSUS_SOURCE: no consensus-estimates provider is reachable in the wedge (BRIEF §2); the column is never populated' }` on every run (calendar and release mode) · `{ field:'surprisePct', reason:'NO_SOURCE', detail:'NO_CONSENSUS_SOURCE: surprise requires a consensus value' }` · `{ field:'release', reason:'NO_SOURCE', detail:'unknown release id' }` when `params.releaseId` matches no `econ_releases` row · `{ field:'ECO_VALUE', reason:'NOT_APPLICABLE', detail:'release has no headline series in econ_series; actual is published as text only' }` when `econ_release_events.series_id` is null. Footer badges: `CALENDAR_STALE` (newest calendar capture older than 36 h — the daily `econCalendar` job has not run, TERM-12), `TIME_UNKNOWN` (per row, `time_known = false`), `DELAYED`/`CANCELLED` (event status). Entitlement: `NO_FIRM_ENTITLEMENT`/`NO_USER_ENTITLEMENT` on `fred.csv` or `bls.timeseries` blanks `actual`/`prior`/`revisedPrior` with `r` set and the reason in `meta.entitlement` (ENTL-05); `PROVIDER_DOWN` on `fred.series` read-through in release mode returns stored observations with `st:'stale'` and `meta.staleness:'stale'`.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 rules (shared) |
| golden payload | `packages/server/test/integration/functions/ECO.golden.test.ts` | seeded `econ_release_events` (from `fred-cal`, `fred-releases.html`, `bls-schedule.html`, `fixtures/seed/fomc-2026.json`) at the frozen clock `2026-09-15T18:41:28Z`, `range:'W'` deep-equals `ECO.default.json`; `REL=10` deep-equals `ECO.default-release.json` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `ECO.default.csv` and `ECO.default-release.csv`; every numeric cell equals the payload value |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at a frozen clock (API-05) |
| screen | `packages/web/test/screens/ECO.test.tsx` | renders both goldens; `1`/`2`/`3` call `setParams({range})`, `C`/`I`/`F`/`T` call `setParams`, `+`/`-` call `ctx.page`; `consensus` column renders `—` with tooltip `NO_CONSENSUS_SOURCE`; `e:` live cells registered for today's events; `payload undefined` renders the skeleton |
| consensus never fabricated | `packages/server/test/integration/functions/ECO.consensus.test.ts` | every `days[].events[].consensus.v === null` and `surprisePct === null` for all 60 seeded events; `meta.unavailable` contains both entries exactly once |
| vintages and revisions | `packages/server/test/integration/functions/ECO.vintage.test.ts` | insert a second `econ_observations` vintage for `CUUR0000SA0` 2026-07-01; `knownAt` before it → `prior` = original and `revisedPrior` null; `knownAt` after → `revisedPrior` = new value, `status:'revised'`, `revisions[]` lists both vintages (STOR-06) |
| paging | `packages/server/test/unit/functions/ECO.page.test.ts` | cursor round-trip `base64url(JSON)`; `fwd` from week of 2026-09-14 → 2026-09-21, `back` → 2026-09-07; `range:'M'` shifts by calendar month with month-end clamping |
| calendar staleness | `packages/server/test/integration/functions/ECO.stale.test.ts` | newest capture aged to 48 h → `meta.staleness:'stale'` and footer note `CALENDAR_STALE`, no throw (TERM-12) |
| e2e | `packages/e2e/tests/eco-release.spec.ts` | `ECO <GO>` → week grid; `2` then `+` pages to the next week; `Enter` on the CPI row opens release detail; `PRINT` downloads a CSV whose `consensus` column is empty and `consensusReason` is `NO_CONSENSUS_SOURCE` |

---

### PORT — Portfolio Analytics

| Attribute | Value |
| --- | --- |
| Code / aliases | `PORT` / `PRT` (no `aliasParams`) |
| Tier / category | 2 / portfolio |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/PORT.ts` · `packages/server/src/functions/PORT/resolve.ts` · `packages/web/src/screens/PORT/Screen.tsx` · `fixtures/golden/functions/PORT.default.{json,csv}` (holdings view), `fixtures/golden/functions/PORT.default-attribution.{json,csv}`, `fixtures/golden/functions/PORT.default-risk.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (PORT-01) (PORT-02) (PORT-03) (PORT-04) (PORT-05) (PORT-06) (PORT-07) (ANAL-07) (ANAL-08) (DATA-10) (TERM-08) (TERM-12) (ENTL-05) (API-05) (SEC-05) |

#### Params
```ts
export const PortScenarioId = z.enum([
  'UST_PARALLEL_UP_100', 'UST_PARALLEL_DN_100', 'UST_STEEPEN_50', 'EQUITY_DOWN_10', 'EQUITY_DOWN_20',
  'USD_UP_5', 'USD_DN_5', 'EPISODE_2020_COVID', 'EPISODE_2022_RATES',
]);
export const PortParams = z.object({
  portfolioId: z.number().int().positive().optional(),            // undefined = the caller's most recently updated portfolio
  view: z.enum(['holdings', 'exposure', 'attribution', 'risk']).default('holdings'),
  asOfDate: z.iso.date().optional(),                              // positions as-of date; undefined = latest positions.as_of_date
  benchmark: SecurityRefInput.optional(),                         // overrides portfolios.benchmark_instrument_id for this run
  groupBy: z.enum(['sector', 'assetClass', 'currency', 'instrument']).default('sector'),
  lookbackDays: z.number().int().min(60).max(1260).default(252),  // risk/attribution window in sessions (ANAL-07 annualisation 252)
  varMethod: z.enum(['historical', 'parametric']).default('historical'),
  varConfidence: z.enum(['95', '99']).default('95'),
  scenarios: z.array(PortScenarioId).max(9).default(['UST_PARALLEL_UP_100', 'EQUITY_DOWN_10', 'USD_UP_5', 'EPISODE_2022_RATES']),
});
```
#### Argument grammar
`positional [{ name:'view', type:'enum', values:['holdings','exposure','attribution','risk'], optional:true }]`, `keyed { P: { name:'portfolioId', type:'int' }, DATE: { name:'asOfDate', type:'date' }, BM: { name:'benchmark', type:'security' }, GRP: { name:'groupBy', type:'enum', values:['sector','assetClass','currency','instrument'] }, N: { name:'lookbackDays', type:'int' }, VAR: { name:'varMethod', type:'enum', values:['historical','parametric'] }, CONF: { name:'varConfidence', type:'enum', values:['95','99'] }, SCEN: { name:'scenarios', type:'string' } }`, no `rest` (`SCEN` takes a comma-separated list of `PortScenarioId`).
Examples: `PORT` → `{ view:'holdings', groupBy:'sector', lookbackDays:252, varMethod:'historical', varConfidence:'95' }` · `PORT ATTRIBUTION P=1 N=504` → `{ view:'attribution', portfolioId:1, lookbackDays:504 }` · `PORT RISK BM=SPY US Equity CONF=99 SCEN=EQUITY_DOWN_20,USD_UP_5` → `{ view:'risk', benchmark:{ ref:'SPY US Equity' }, varConfidence:'99', scenarios:['EQUITY_DOWN_20','USD_UP_5'] }`.

#### Payload
```ts
export type PortView = 'holdings' | 'exposure' | 'attribution' | 'risk';
export type PortReconStatus = 'ok' | 'unresolved' | 'duplicate' | 'price_missing';

export interface PortHoldingRow {
  positionId: number; instrumentId: number | null; key: string | null;            // 'AAPL US Equity'; null for cash / unresolved
  name: string; rawIdentifier: string; assetClass: AssetClass | null; marketSector: MarketSector | null;
  gicsSector: string | null; currency: string; isCash: boolean; lotCount: number;
  quantity: number; costPrice: number | null; costCurrency: string | null; tradeDate: string | null; accrued: number;
  px: ValueCell; fxRate: ValueCell;                                                // PX_LAST and FX_USD, both live where a subject exists
  marketValue: ValueCell; weight: ValueCell; dayPnl: ValueCell; unrealisedPnl: ValueCell;
  benchWeight: number | null; activeWeight: number | null;                         // null when there is no benchmark
  reconStatus: PortReconStatus; subject: string | null; provIdx: number;
}
export type PortPayload = {
  variant: 'default';
  view: PortView;
  portfolio: { portfolioId: number; firmId: number; name: string; baseCurrency: string;
               benchmark: { instrumentId: number; key: string; name: string; source: 'portfolio' | 'param' } | null;
               asOfDate: string; positionCount: number; updatedAt: string };
  totals: { marketValue: ValueCell; costBasis: number | null; unrealisedPnl: ValueCell; dayPnl: ValueCell;
            cash: number; accrued: number; longMv: number; shortMv: number; grossMv: number; netMv: number;
            pricedWeight: number };                                                // fraction of gross MV that carries a price
  holdings: PortHoldingRow[];
  exposure: { groupBy: 'sector' | 'assetClass' | 'currency' | 'instrument';
              rows: Array<{ key: string; label: string; marketValue: number; weight: number;
                            benchWeight: number | null; activeWeight: number | null; count: number }>;
              currency: Array<{ ccy: string; marketValue: number; weight: number; fxRate: ValueCell; fxDate: string }>;
              engine: { name: 'portfolio/exposure'; version: string } } | null;
  attribution: { method: 'brinson_fachler'; groupBy: 'sector'; period: { from: string; to: string; sessions: number };
                 rows: Array<{ key: string; label: string; portWeight: number; benchWeight: number;
                               portReturn: number; benchReturn: number;
                               allocation: number; selection: number; interaction: number; total: number }>;
                 total: { portReturn: number; benchReturn: number; active: number;
                          allocation: number; selection: number; interaction: number };
                 unattributed: { weight: number; total: number; reason: 'FI_ATTRIBUTION_UNAVAILABLE' | 'PRICE_MISSING' } | null;
                 engine: { name: 'portfolio/attribution'; version: string; inputsHash: string } } | null;
  risk: { lookbackDays: number; sessions: number; conventions: { returns: 'simple'; priceBasis: 'close'; adjust: 'price';
                                                                 annualisation: 252; volWindow: 30 };
          volPct: number | null; benchVolPct: number | null; trackingErrorPct: number | null;
          beta: number | null; corr: number | null; r2: number | null;
          sharpe: number | null; informationRatio: number | null; maxDrawdownPct: number | null;
          var: { method: 'historical' | 'parametric'; confidence: 95 | 99; horizonDays: 1;
                 valuePct: number | null; valueCcy: number | null;
                 backtest: { windowSessions: number; exceptions: number; expected: number } | null };
          varMonteCarlo: null;                                                     // VAR_MC_NOT_IN_V1
          factorExposures: null;                                                    // NO_FACTOR_MODEL
          scenarios: Array<{ id: string; label: string; method: 'shock' | 'episode'; detail: string;
                             pnlCcy: number | null; pnlPct: number | null; unavailableReason: string | null }>;
          engine: { name: 'portfolio/risk'; version: string; inputsHash: string } } | null;
  recon: { importId: number | null; channel: 'upload' | 'file_drop' | 'api' | 'manual' | null; uploadedAt: string | null;
           status: 'accepted' | 'partial' | 'rejected' | null;
           rowsTotal: number; rowsOk: number; rowsError: number;
           errors: Array<{ row: number; identifier: string; column: string; reason: string }>;
           matched: number; added: number; removed: number;
           quantityDiffs: Array<{ instrumentId: number; before: number; after: number }> };
  confidentiality: { firmOnly: true; note: 'PORT-07: firm-isolated; never leaves the tenant' };
  notes: string[];                                                                  // 'NO_BENCHMARK', 'PRICE_MISSING', 'FI_ATTRIBUTION_UNAVAILABLE' …
};
```
Field ids introduced by this entry (must be added to `core/fields/dictionary.ts` and `providers/licences.ts` per FUNCTIONS.md §1.8 step 6, `fieldClass:'portfolio'`, `sources: { assetClass:'*', sourceId:'internal.user', endpoint:'positions', providerPath:'core/analytics/portfolio' }`, `updateFreq:'realtime'` for the first four and `'daily'` for the rest, `pit:false`, `since:'2026.09.1'`) — see "additions required". **`PORT_MV`, `PORT_WEIGHT`, `PORT_PNL_1D`, `PORT_ACTIVE_WEIGHT` and `PORT_CONTRIB_TE` are not new**: they are the five portfolio-class ids API.md §7 L1111 already declares, and PORT is their producer. Only `PORT_UNREAL_PNL`, `PORT_BETA` and `PORT_VAR` are additions. An earlier draft of this entry coined `PORT_MKT_VALUE`, `PORT_DAY_PNL` and `PORT_TRACK_ERR` for quantities that already had ids; those spellings are withdrawn, because two ids for one quantity breaks API.md §7 rule 2 (ids never change meaning) and would leave the dictionary's `PORT_MV`/`PORT_PNL_1D`/`PORT_CONTRIB_TE` without a producer:

| id | label | type / unit | decimals | derivation | assetClasses |
| --- | --- | --- | --- | --- | --- |
| `PORT_MV` | Market value | number / ccy | 2 | `quantity × PX_LAST × FX_USD → base currency` (cash: `quantity`) | * |
| `PORT_WEIGHT` | Portfolio weight | number / pct | 2 | `PORT_MV / totals.grossMv` | * |
| `PORT_PNL_1D` | Day P&L | number / ccy | 2 | `quantity × CHG_NET_1D × FX_USD` | * |
| `PORT_UNREAL_PNL` | Unrealised P&L | number / ccy | 2 | `quantity × (PX_LAST − costPrice) × FX_USD` | * |
| `PORT_ACTIVE_WEIGHT` | Active weight | number / pct | 2 | `PORT_WEIGHT − benchWeight` (`index_members.weight`) | * |
| `PORT_BETA` | Portfolio beta | number / ratio | 3 | OLS slope of portfolio returns on benchmark returns, `lookbackDays` sessions (`core/analytics/stats`) | * |
| `PORT_CONTRIB_TE` | Contribution to tracking error | number / pct | 2 | on a position row: that position's contribution to tracking error; on the totals row: stdev of (portfolio − benchmark) daily returns × √252 × 100, which the row contributions sum to | * |
| `PORT_VAR` | Value at Risk | number / pct | 2 | 1-day VaR at `varConfidence` by `varMethod` (`core/analytics/portfolio/risk.ts`) | * |

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `portfolios`, `positions`, `lots`, `portfolio_imports` (all RLS-scoped by `firm_id`, DATA_MODEL §15 / PORT-07), `instruments`, `issues`, `issuers`, `entity_classifications` + `classification_codes` (scheme `GICS`, as-of `ctx.asOf`), `bars_daily` (return series, adjust policy `price`), `quote_snapshots` (plant warm start), `fx_rates` (`frankfurter` then `yahoo.chart`), `indices` + `index_members` (benchmark weights and sector returns), `etf_holdings` (when the benchmark is an ETF), `curve_points` (`UST_PAR` for the curve-shift scenarios), `govt_terms` (bond scenario repricing inputs) |
| Data services (§1.4.2) | `data.portfolio.get`, `data.portfolio.positions`, `data.portfolio.recon`, `data.reference.instrument`, `data.reference.resolve`, `data.reference.members`, `data.historical.bars`, `data.snapshot.fields`, `data.curves.points`, `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | None for holdings — portfolio data is `internal.user` and is never sent to or fetched from a provider (PORT-07). `('yahoo.daily', instrumentKey, { maxAgeMs: 86_400_000 })` only for a held instrument with fewer than `lookbackDays` rows in `bars_daily` and only in the `attribution`/`risk` views; `('sec.nport', benchmarkCik, { maxAgeMs: 86_400_000 })` when the benchmark is an ETF with no `etf_holdings` row |
| Engines (`core/analytics`) | `portfolio/exposure@1.0.0` (`exposure` view), `portfolio/attribution@1.0.0` Brinson–Fachler (PORT-03), `portfolio/risk@1.0.0` ex-post tracking error, historical/parametric VaR, scenario shocks (PORT-04/05/06), `stats@1.0.0` (returns, vol, beta, drawdown, Sharpe/IR — ANAL-07 conventions of Tier 1 §0.6). Every engine is registered through `ctx.engines.add({ name, version, inputsHash })` (ANAL-08) |
| Subjects (live) | `q:<instrumentId>` for every priced, non-cash holding; `q:<benchmarkInstrumentId>`; FX lines are read from `fx_rates` (daily) and are not subscribed |
| Field ids (`fieldIds(assetClass)`) | `default: [PX_LAST, CHG_NET_1D, CHG_PCT_1D, PX_CLOSE_1D, FX_USD, PORT_MV, PORT_WEIGHT, PORT_PNL_1D, PORT_UNREAL_PNL, PORT_ACTIVE_WEIGHT, PORT_BETA, PORT_CONTRIB_TE, PORT_VAR]` |

#### Resolver
Single `resolve` (`assetClasses: 'none'`, no variants). Every query runs in the request transaction with `app.user_id`/`app.firm_id` set, so a portfolio of another firm is simply not visible (PORT-07, DATA_MODEL §15).
1. `pf = params.portfolioId ? await ctx.data.portfolio.get(params.portfolioId) : firstOf(await listPortfolios(ctx.user.firmId) ordered by updated_at DESC)`. No row (or another firm's row, which RLS hides) → `ctx.unavailable.add({ field:'portfolio', reason:'NO_SOURCE', detail:'NO_PORTFOLIO: no portfolio is visible to this user; create one or import positions (PORT-01)' })` and return `holdings: []`, `totals` all-null, `exposure/attribution/risk: null`.
2. `asOfDate = params.asOfDate ?? max(positions.as_of_date) for the portfolio`; `positions = await ctx.data.portfolio.positions(pf.portfolioId, asOfDate)`; `lots = grouped by (instrumentId, lotId)` for `lotCount` and the weighted `costPrice` (PORT-02 lot-level cost basis). `ctx.prov.add({ sourceId:'internal.user', provenanceId: pf.provenanceId ?? importProvenanceId, capturedAt: uploadedAt, sourceTs: null, st:'closed', tier:'eod' })` once; every holding cites that `provIdx` for `quantity`/`costPrice`.
3. Pricing: `subjects = positions.filter(p => p.instrumentId && !p.isCash).map(p => plant.subjectFor(p.instrumentId))`; `plant.ensureHot(subjects)`; `states = plant.snapshotMany(subjects)`. `px = cellFromState(ctx, states.get(subject), 'PX_LAST', subject)` and the day change from `CHG_NET_1D` (Tier 1 §0.4 rules 1 and 2 — the resolver never calls `providers.ensure` for a quote, so a cold name is `pending` and fills from the WS `snap`). A position whose `instrumentId` is null gets `reconStatus:'unresolved'` and `px = { v:null, st:'na', r:undefined, provIdx:-1 }`; a resolved instrument with no quote **and** no `bars_daily` close in the last 10 sessions gets `reconStatus:'price_missing'`.
4. FX (PORT-02 multi-currency): for each distinct `currency ≠ pf.baseCurrency`, `fxRate` from `fx_rates` for `(currency, baseCurrency, ≤ asOfDate, source 'frankfurter' preferred over 'yahoo.chart')` as a stored-value cell (`st:'closed'`, §0.4 rule 3); a missing pair → `fxRate = { v:null, st:'na' }`, the holding is excluded from `totals` and `notes` gains `FX_MISSING`. `marketValue = quantity × px.v × fxRate.v` (cash: `quantity × fxRate.v`), `dayPnl = quantity × CHG_NET_1D × fxRate.v`, `unrealisedPnl = quantity × (px.v − costPrice) × fxRate.v` (null when `costPrice` is null). All four are derived cells citing the `provIdx` of `px` (§0.4 rule 4).
5. `totals`: `grossMv = Σ|marketValue|`, `netMv = Σ marketValue`, `longMv`/`shortMv` by sign, `cash = Σ marketValue where isCash`, `accrued = Σ accrued`, `pricedWeight = Σ|marketValue| of rows with px.v ≠ null / grossMv`. `weight = marketValue / grossMv` per holding.
6. Benchmark: `bm = params.benchmark ? await ctx.data.reference.resolve(params.benchmark) : pf.benchmarkInstrumentId`. When set, `benchWeights = await ctx.data.reference.members(bm.instrumentId, asOfDate)` (SPX via `index_members`, an ETF benchmark via `etf_holdings`); `benchWeight`/`activeWeight` per holding; a held name that is **not** in the benchmark gets `benchWeight: 0` (never `null`), so `activeWeight` equals the full position weight. No benchmark at all → `benchWeight`/`activeWeight` null, `attribution: null`, `notes: ['NO_BENCHMARK']`, `ctx.unavailable.add({ field:'attribution', reason:'NOT_APPLICABLE', detail:'NO_BENCHMARK: the portfolio has no benchmark; set one on the portfolio or pass BM=' })`.
7. `view === 'exposure'`: `exposure = portfolioExposure({ holdings, groupBy: params.groupBy, gics })` from `core/analytics/portfolio/exposure.ts`; `gicsSector` from `entity_classifications` (scheme `GICS`, level 1) as-of `ctx.asOf`, unknown → group `UNCLASSIFIED`. `currency[]` groups by holding currency with the same `fxRate` cell. `ctx.engines.add({ name:'portfolio/exposure', version:'1.0.0', inputsHash: sha256(canonicalJson({ portfolioId, asOfDate, groupBy, keys, weights })) })`.
8. `view === 'attribution'`: `period = [session(asOfDate − lookbackDays), asOfDate]`. Portfolio and benchmark sector returns come from `data.historical.bars(id, { start, end, periodicity:'D', adjust:'price' })` for every held instrument and every benchmark member, buy-and-hold weighted at the period start. `attribution = brinsonFachler({ portWeights, benchWeights, portReturns, benchReturns })` from `core/analytics/portfolio/attribution.ts` — per sector `allocation = (wP − wB)(rB − rBtotal)`, `selection = wB(rP − rB)`, `interaction = (wP − wB)(rP − rB)`, `total = allocation + selection + interaction`. Positions in `govt`, `option` or `future` asset classes and any row with `reconStatus:'price_missing'` go to `unattributed` with reason `FI_ATTRIBUTION_UNAVAILABLE` / `PRICE_MISSING`: `ctx.unavailable.add({ field:'attribution.fixedIncome', reason:'NO_SOURCE', detail:'FI_ATTRIBUTION_UNAVAILABLE: curve/spread/carry attribution needs evaluated bond prices; DATA-04 is out of scope in this wedge (BRIEF §1), so fixed-income positions are reported as one unattributed bucket' })`. Currency attribution is reported inside `exposure.currency` only; `ctx.unavailable.add({ field:'attribution.currency', reason:'NOT_APPLICABLE', detail:'CCY_ATTRIBUTION_UNAVAILABLE: no forward points source; currency effect is shown as exposure, not as an attribution term' })`. Engine entry `{ name:'portfolio/attribution', version:'1.0.0', inputsHash }`.
9. `view === 'risk'`: build the daily portfolio return series over `lookbackDays` sessions from the same bars at fixed current weights; `volPct`, `beta`, `corr`, `r2`, `sharpe`, `informationRatio`, `maxDrawdownPct` from `core/analytics/stats` with the Tier 1 §0.6 conventions echoed into `risk.conventions`; `trackingErrorPct` = stdev of active returns × √252 × 100. `var` from `core/analytics/portfolio/risk.ts`: `historical` = the `(100 − confidence)`-th percentile of the return series; `parametric` = `z(confidence) × dailyVol`. `backtest` counts realised exceptions over the same window against the rolling VaR and reports `expected = sessions × (1 − confidence/100)` (PORT-06 documented assumptions and exception backtesting). `varMonteCarlo: null` with `ctx.unavailable.add({ field:'risk.varMonteCarlo', reason:'NOT_APPLICABLE', detail:'VAR_MC_NOT_IN_V1: core/analytics/portfolio/risk.ts implements historical and parametric VaR only' })`; `factorExposures: null` with `ctx.unavailable.add({ field:'risk.factorExposures', reason:'NO_SOURCE', detail:'NO_FACTOR_MODEL: no commercial multi-factor risk model is licensable in this wedge; tracking error, beta and contribution are computed ex-post from returns instead (PORT-04 partial)' })`.
10. Scenarios (PORT-05), each entry of `params.scenarios`: `UST_PARALLEL_UP_100` / `UST_PARALLEL_DN_100` / `UST_STEEPEN_50` reprice `govt` holdings through `core/analytics/bond/risk` DV01 against `curve_points('UST_PAR', asOfDate)` and apply `−beta × Δy × equityDuration = 0` to equities (equities are unaffected by construction, stated in `detail`); `EQUITY_DOWN_10` / `EQUITY_DOWN_20` apply `beta × shock` per equity/etf/index holding; `USD_UP_5` / `USD_DN_5` apply the move to every non-base-currency holding; `EPISODE_2020_COVID` (2020-02-19 → 2020-03-23) and `EPISODE_2022_RATES` (2022-01-03 → 2022-10-14) replay the realised return of each held instrument over that window. A holding whose `bars_daily` does not cover an episode window contributes `null` and the scenario row carries `unavailableReason: 'EPISODE_WINDOW_UNAVAILABLE'` naming the instruments (the seeded universe has five years of AAPL bars, so `EPISODE_2020_COVID` is available for AAPL and unavailable for instruments seeded from the quarterly `max` series). Engine entry `{ name:'portfolio/risk', version:'1.0.0', inputsHash: sha256(canonicalJson({ portfolioId, asOfDate, lookbackDays, varMethod, varConfidence, scenarios, weights })) }`.
11. `recon` from `ctx.data.portfolio.recon(pf.portfolioId)` — the latest `portfolio_imports` row's `rows_total/rows_ok/rows_error`, `errors[]` and `reconciliation{matched, added, removed, quantityDiffs}` (PORT-01). No import row (positions written through `PUT /portfolios/:portfolioId/positions`) → `importId: null`, `channel: null`, counts zero.
12. Return the payload with `confidentiality: { firmOnly: true, note: 'PORT-07: firm-isolated; never leaves the tenant' }`. `views` other than the requested one are `null` — the screen re-runs with `setParams({ view })` so an unrequested analytic is never computed or logged.
Budget: holdings view 3 DB round-trips (portfolio+positions+lots, classifications, fx) plus one plant snapshot, zero provider calls; < 300 ms p95. Exposure 4; attribution and risk 5 round-trips plus one bar read per distinct instrument (batched into a single `bars_daily` query over `instrument_id = ANY(...)`); < 1.2 s p95 for the seeded 12-lot portfolio against a 503-name benchmark.

#### Live
`{ subjects: [...holdings.filter(h => h.subject).map(h => h.subject!), 'q:' + portfolio.benchmark.instrumentId].filter(unique), fields: ['PX_LAST', 'CHG_NET_1D', 'CHG_PCT_1D'], conflationMs: 2000 }` (null when `holdings` is empty or every row is cash). `grid#holdings` sets `live.subjectOf = row => row.subject`; `px`, `dayPnl`, `marketValue`, `weight` and `unrealisedPnl` carry `Cell.live = { subject, field:'PX_LAST' }` so `web/grid/cellRegistry` recomputes the derived cells from the delta (`marketValue = quantity × v × fxRate.v`) and flashes them without a React render (TERM-08). `totals.marketValue`/`totals.dayPnl` are registered against the same subject set and recomputed client-side as the sum of the live row values.

#### Screen
```
holdings (view = 'holdings')
┌ PORT · Demo Long · 2026-09-15 · USD ─────────────────────────────────────────────┐
│ tabs#view  [1 Holdings] [2 Exposure] [3 Attribution] [4 Risk]                     │
│ badges#mode [bench SPX Index] [as-of 2026-09-15] [GRP sector] [PORT-07 FIRM ONLY] │
│ kv#totals  market value (ccy 2dp) · day P&L (ccy, dir up/down) · unrealised P&L    │
│            · gross / net / long / short · cash · accrued · priced 100.0%          │
│ grid#holdings  frozenColumns 2, groupBy 'gicsSector'                              │
│   key | name | qty (shares) | cost (px) | last (live px) | ccy | fx (px 4dp)       │
│   | mkt value (live ccy) | wt% (live pct) | bench wt% | active wt% | day P&L       │
│   | unreal P&L | recon badge                                                      │
│ text#recon  import 7 · 12 rows · 12 ok · 0 error · matched 12 / added 0 / removed 0│
│ footer: sources ['Client portfolio (internal.user, confidential)','Cboe delayed    │
│         quotes','Yahoo Finance daily bars','ECB reference rates (frankfurter)']    │
└──────────────────────────────────────────────────────────────────────────────────┘
exposure (view = 'exposure')
│ grid#exposure  group | mkt value | weight% | bench wt% | active wt% | n            │
│ table#currency ccy | mkt value | weight% | fx rate | fx date                       │
attribution (view = 'attribution')
│ badges#reason [FI_ATTRIBUTION_UNAVAILABLE] [CCY_ATTRIBUTION_UNAVAILABLE]           │
│ grid#attribution sector | wP% | wB% | rP% | rB% | alloc bp | sel bp | inter bp     │
│                  | total bp        (total row pinned, bold; unattributed row muted)│
risk (view = 'risk')
│ kv#risk  vol% · bench vol% · tracking error% · beta · corr · R² · Sharpe · IR      │
│          · max drawdown% · VaR 95 1d (% and ccy) · backtest 11 exceptions / 12.6   │
│ badges#reason [NO_FACTOR_MODEL] [VAR_MC_NOT_IN_V1]                                 │
│ grid#scenarios id | label | method | detail | P&L (ccy) | P&L% | reason            │
```
Title `PORT · <portfolio.name> · <asOfDate> · <baseCurrency>`; subtitle `<view> · bench <benchmark.key ?? '—'> · <lookbackDays> sessions`. `initialFocus:'holdings'` (`'exposure'`, `'attribution'`, `'scenarios'` per view). Skeleton while `payload === undefined`: the tabs row, a `kv#totals` with 6 muted rows and `grid#holdings` with 12 muted rows. `meta.unavailable` renders as the `badges#reason` row and, per column, as `—` with the reason as tooltip (`factorExposures`, `varMonteCarlo`, fixed-income rows); `meta.entitlement` denials on `PX_LAST` blank `last`, `mkt value`, `wt%` and both P&L columns with `—` and the reason, and `totals.pricedWeight` drops accordingly (ENTL-05); `meta.staleness:'stale'` (a delayed quote older than `3 × expectedIntervalMs`) shows the stale glyph on `badges#mode` and on each affected cell (TERM-12). The `PORT-07 FIRM ONLY` badge (tone `blocked`) is always present and is repeated in the CSV header.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `1`…`4` | always | `tab-view` | `ctx.setParams({ view })` in tab order: holdings, exposure, attribution, risk (usage `fn.param`) |
| `P` | always | `pick-portfolio` | `ctx.prompt('text', { label:'Portfolio' })` → `setParams({ portfolioId })` |
| `B` | always | `set-benchmark` | `ctx.prompt('security', { label:'Benchmark' })` → `setParams({ benchmark })` |
| `D` | always | `set-as-of-date` | `ctx.prompt('date', { label:'Positions as of' })` → `setParams({ asOfDate })` |
| `R` | grid (`exposure`) | `cycle-group-by` | `sector → assetClass → currency → instrument → sector` via `setParams({ groupBy })` |
| `V` | always | `cycle-var` | `historical/95 → historical/99 → parametric/95 → parametric/99` via `setParams({ varMethod, varConfidence })` |
| `+` / `-` | always | `longer-lookback` / `shorter-lookback` | `setParams({ lookbackDays: clamp(lookbackDays ± 126, 60, 1260) })` |
| `S` | grid (`scenarios`) | `edit-scenarios` | `ctx.prompt('text', { label:'Scenarios', initial: scenarios.join(',') })` → `setParams({ scenarios })` |
| `Enter` | grid (`holdings`) | `open-des` | `ctx.navigate(row.key + ' DES')` (no-op on a cash or unresolved row) |
| `Shift+Enter` | grid (`holdings`) | `open-des-next` | `ctx.navigateNext(row.key + ' DES')` |
| `G` | grid (`holdings`) | `open-gp` | `ctx.navigate(row.key + ' GP 1Y')` |
| `Enter` | grid (`attribution`) | `drill-sector` | `ctx.setParams({ view:'exposure', groupBy:'instrument' })` focused on the sector's rows |

#### CSV
`filename = 'PORT_' + portfolio.name.replace(/ /g,'_') + '_' + view.toUpperCase() + '_' + portfolio.asOfDate.replace(/-/g,'') + '.csv'`; `csvColumns` is `null` (payload-dependent). Every export carries the extra header line `# confidential: client portfolio data, firm <firmId> only (PORT-07)` before `# source:`.
`view='holdings'` — wide: `key,name,rawIdentifier,assetClass,gicsSector,currency,quantity,costPrice,costCurrency,tradeDate,px,fxRate,marketValue,weight,benchWeight,activeWeight,dayPnl,unrealisedPnl,accrued,lotCount,reconStatus`, one row per `holdings[]` at full precision (`ValueCell` contributes `v` only), followed by `section`-prefixed rows for `totals` and `recon` per §1.6 rule 3. Example: `AAPL US Equity,Apple Inc,AAPL US,equity,Information Technology,USD,1200,187.42,USD,2024-03-11,245.31,1,294372,0.1832,0.0712,0.112,1884,69468,0,2,ok`.
`view='exposure' | 'attribution' | 'risk'` — long format `section,key,value,unit,asOf,source` with sections `portfolio`, `totals`, `exposure`, `currency`, `attribution` (key = `sector|term`, e.g. `Information Technology|selection`), `attributionTotal`, `unattributed`, `risk`, `var`, `backtest`, `scenario`, `unavailable` (one row per `meta.unavailable` entry so the reason travels with the file). Example: `attribution,Information Technology|selection,0.0043,ratio,2026-09-15,internal.derived`.

#### Help
summary `Portfolio holdings, exposure, Brinson attribution and ex-post risk, firm-isolated`; description `PORT prices your imported positions live, shows exposure by sector, asset class or currency against the portfolio's benchmark, decomposes active return with a Brinson-Fachler attribution, and reports ex-post risk: volatility, tracking error, beta, drawdown and one-day VaR with an exception backtest, plus parallel and steepening curve shifts, equity and FX shocks and two historical-episode replays. Press 1 to 4 for the four views, B to change the benchmark, D to price a different as-of date, V to cycle the VaR method and confidence, and + / - to lengthen or shorten the risk window. Multi-factor risk exposures and Monte Carlo VaR are unavailable: there is no licensable factor model in this wedge, so risk is measured ex-post from returns. Fixed-income positions are grouped into one unattributed bucket because curve, spread and carry attribution needs evaluated bond prices that this build does not source. Portfolio data is tenant-isolated: it is never sent to a data provider and is visible only inside your firm.`; params: `portfolioId` ("which portfolio", example `P=1`), `view` ("holdings, exposure, attribution or risk", `PORT RISK`), `asOfDate` ("positions as of", `DATE=2026-09-15`), `benchmark` ("benchmark security", `BM=SPX Index`), `groupBy` ("sector, assetClass, currency or instrument", `GRP=currency`), `lookbackDays` ("60–1260 sessions", `N=504`), `varMethod` ("historical or parametric", `VAR=parametric`), `varConfidence` ("95 or 99", `CONF=99`), `scenarios` ("comma-separated scenario ids", `SCEN=EQUITY_DOWN_20,USD_UP_5`); sources `['internal.user', 'cboe.quotes', 'yahoo.chart', 'frankfurter', 'sec.archives', 'ssga.holdings', 'wiki.sp500', 'internal.derived']`; related `['W', 'QM', 'MEMB', 'HDS', 'GP', 'BTMM']`.

#### Unavailable and reason codes
`{ field:'portfolio', reason:'NO_SOURCE', detail:'NO_PORTFOLIO: no portfolio is visible to this user; create one or import positions (PORT-01)' }` · `{ field:'attribution', reason:'NOT_APPLICABLE', detail:'NO_BENCHMARK: the portfolio has no benchmark; set one on the portfolio or pass BM=' }` · `{ field:'attribution.fixedIncome', reason:'NO_SOURCE', detail:'FI_ATTRIBUTION_UNAVAILABLE: …' }` · `{ field:'attribution.currency', reason:'NOT_APPLICABLE', detail:'CCY_ATTRIBUTION_UNAVAILABLE: …' }` · `{ field:'risk.factorExposures', reason:'NO_SOURCE', detail:'NO_FACTOR_MODEL: …' }` (PORT-04 partial) · `{ field:'risk.varMonteCarlo', reason:'NOT_APPLICABLE', detail:'VAR_MC_NOT_IN_V1: …' }` (PORT-06 partial) · `{ field:'PX_LAST', reason:'NO_SOURCE', detail:'PRICE_MISSING: no quote and no daily close in the last 10 sessions for <key>' }` per affected holding · `{ field:'instrumentId', reason:'NO_SOURCE', detail:'UNRESOLVED_IDENTIFIER: "<rawIdentifier>" did not resolve to an instrument; see the import report' }` per unresolved row · `{ field:'FX_USD', reason:'NO_SOURCE', detail:'FX_MISSING: no fx_rates row for <ccy>/<base> on or before <asOfDate>' }` · per-scenario `unavailableReason: 'EPISODE_WINDOW_UNAVAILABLE'` when `bars_daily` does not cover the episode. Screen/footer notes: `NO_BENCHMARK`, `PRICE_MISSING`, `FX_MISSING`, `FI_ATTRIBUTION_UNAVAILABLE`, `EPISODE_WINDOW_UNAVAILABLE`, `PORT-07 FIRM ONLY`. Entitlement: `NO_FIRM_ENTITLEMENT`/`NO_USER_ENTITLEMENT`/`NOT_ENTITLED_TIER` on `cboe.quotes` blanks `px` and every cell derived from it with `r` set; an `eod`-only user (`eod@demo`) sees `PX_OFFICIAL_CLOSE`-based valuations with `SOURCE_TIER_CAP` in `meta.entitlement` and `st:'closed'` (ENTL-05). Export with any denied field is refused before `toCsv` runs (§1.4.4, 403 `ENTITLEMENT_DENIED`); `PROVIDER_DOWN` on `cboe.quotes` leaves the last values with `st:'stale'` and `meta.staleness:'stale'` (TERM-12).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 rules (shared) |
| golden payload | `packages/server/test/integration/functions/PORT.golden.test.ts` | seeded portfolio `Demo Long` (12 lots, `fixtures/seed/workspaces.json`) priced from `cboe-quote-AAPL.json`, `cboe-spx`, `yahoo-chart-events`, `frankfurter` at the frozen clock `2026-09-15T18:41:28Z` deep-equals `PORT.default.json`; `view:'attribution'` equals `PORT.default-attribution.json`; `view:'risk'` equals `PORT.default-risk.json` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals the three `.csv` goldens; every numeric cell equals the payload value; the `# confidential:` header line is present |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at a frozen clock (API-05) |
| screen | `packages/web/test/screens/PORT.test.tsx` | renders all three goldens; `1`…`4` call `setParams({view})`, `B`/`D`/`P` open prompts, `V` cycles VaR, `+`/`-` change `lookbackDays`; live cells registered for every `q:` holding subject; `factorExposures` renders `—` with tooltip `NO_FACTOR_MODEL`; `payload undefined` renders the skeleton |
| tenant isolation | `packages/server/test/integration/functions/PORT.isolation.test.ts` | `pm@demo` (firm `Demo Capital`) running `PORT P=<Other Desk portfolio>` sees `NO_PORTFOLIO` and zero rows; the RLS session variable removal makes the same query throw; no provider call is issued with any holding identifier (PORT-07, SEC-05) |
| attribution golden | `packages/server/test/integration/functions/PORT.attribution.test.ts` | Brinson–Fachler terms sum to `total.active` within 1e-9; a synthetic two-sector portfolio reproduces the hand-computed allocation/selection/interaction of `fixtures/golden/analytics/brinson.json` (ANAL-09); `govt` rows land in `unattributed` with `FI_ATTRIBUTION_UNAVAILABLE` |
| risk and VaR | `packages/server/test/integration/functions/PORT.risk.test.ts` | historical VaR equals the 5th percentile of the computed return series; parametric equals `1.645 × dailyVol` at 95 and `2.326 × dailyVol` at 99; `backtest.expected === sessions × 0.05`; `varMonteCarlo === null` with the reason; `factorExposures === null` with `NO_FACTOR_MODEL` |
| scenarios | `packages/server/test/unit/functions/PORT.scenarios.test.ts` | `EQUITY_DOWN_10` P&L equals `Σ beta × −0.10 × marketValue`; `UST_PARALLEL_UP_100` equals `−Σ DV01 × 100` for the seeded Treasuries; an episode window outside `bars_daily` yields `pnlCcy: null` with `EPISODE_WINDOW_UNAVAILABLE` |
| reconciliation | `packages/server/test/integration/functions/PORT.recon.test.ts` | a CSV import with one bad identifier and one duplicate lot yields `recon.status:'partial'`, `rowsError:1`, an `errors[]` entry naming the column, `reconStatus` `unresolved`/`duplicate` on the affected holdings and `PRICE_MISSING`/`UNRESOLVED_IDENTIFIER` in `meta.unavailable` (PORT-01) |
| reproducibility | `packages/server/test/integration/functions/PORT.reproducible.test.ts` | two runs with the same explicit `asOf` produce identical `engines[].inputsHash` and identical risk/attribution numbers (ANAL-08) |
| e2e | `packages/e2e/tests/port-import.spec.ts` | upload a 12-row CSV through `POST /portfolios/:portfolioId/import`, then `PORT <GO>`: holdings priced and flashing, `3` shows attribution with the `FI_ATTRIBUTION_UNAVAILABLE` badge, `4` shows VaR, `PRINT` downloads the holdings CSV with the confidentiality header |

---

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

---

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
