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
